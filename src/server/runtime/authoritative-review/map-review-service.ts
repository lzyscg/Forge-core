/**
 * Task 16 map-review-service (spec §13.1/§13.4/§11.3, design §11.3/§12.1/
 * §12.4/§12.6/§16.2/§17.5): the Map pre-review round planning, the reviewer
 * ledger publication (the Task 13 freeze seam), the acyclic Map settlement DAG
 * and the ATOMIC first Map activation.
 *
 * NORMATIVE CORE:
 * - the round blob (`map_review_round`) + the planned coverage core are built
 *   BEFORE the review WorkItems (the workitem authority matrix binds
 *   mapCandidateRef + reviewCoverageCoreRef + reviewRoundRef);
 * - `freezeReviewAssignment` (the Task 13 seam) freezes one completed
 *   assignment: every fact/verification/finding + the AssignmentLedgerBlob are
 *   prepared and `structured_map_review_assignment_committed` (batch) or the
 *   layered `structured_map_observation_recorded` events (whole observation)
 *   are published in ONE atomic batch;
 * - the settlement DAG is acyclic and content-addressed: `MapReviewCoverageCore
 *   -> map_review_settlement aggregate -> MapReviewSettlementCore ->
 *   ProposedMapCore -> map_activation aggregate -> MapReviewBundle/MapSnapshot`;
 *   the coverage core is frozen WITHOUT the settlement aggregate, the settlement
 *   core is frozen only after the settlement aggregate is clear, and the bundle/
 *   snapshot are frozen only after the activation aggregate is clear — no
 *   self-reference cycle is possible;
 * - `system_review_settlement(stage=initial)` is the ONLY activator: on clear it
 *   atomically publishes round-settled + Map-activated + baseline-unset manifest
 *   + the first generation-batch successor WorkItem + the command/WorkItem
 *   terminals in ONE batch (§17.5 "无现有内容可迁移的成功分支仍可直接把 Map stage
 *   verification、Map 激活、MapReviewBundle、初始 unset manifest 与下一阶段
 *   WorkItem 同批提交"); on blocking it activates NOTHING (old Map/content stay
 *   current);
 * - the baseline-unset ContentRevisionManifest covers every content-bearing slot
 *   with `unset(initial|created_empty)` versions, `mapSemanticDigest` equal to
 *   resolve(mapRef).mapSemanticDigest, null plan/prior, empty finalizer refs —
 *   and `mapRef` binds the EXACT MapSnapshotRef (equal semantic digest with a
 *   new snapshot ref is still a different authority revision, spec §7.2).
 *
 * PUBLICATION MODEL: the three Task 16 branches (`review_assignment_commit`,
 * `map_review_round_completed`, `map_review_settlement`) are registered
 * publication handlers on the module allowlist AND on injected registries via
 * `registerMapReviewPublicationHandlers` — a crashed pin replays the envelope
 * byte-identically.
 *
 * V1 byte-for-byte: this is a NEW module; v1 surfaces are untouched.
 */
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { AuthoritativeAppendFacadeV2 } from '../../storage/authoritative-append-facade';
import type { PublicationIntentRegistry, PublicationEventEnvelopeV2, PublicationIntentResolvedRef } from '../../storage/authoritative-publication-intent-registry';
import { NotRebuildableError, PUBLICATION_INTENT_REGISTRY_V2 } from '../../storage/authoritative-publication-intent-registry';
import { parsePublicationOperationPayload } from '../../authoritative-review/object-schema-parsers-3';
import type { SystemCommandHandler } from './system-command-registry';
import { ValidatorEngine } from './validator-engine';
import type { TriggerExecutionResult, ValidatorBlobStore } from './validator-engine';
import type {
  AuthoritativeReviewProfile,
  AssignmentLedgerBlobV2,
  ContentRevisionManifestV2,
  ContentRevisionManifestPhaseV2,
  ContentReviewRoundPlanCarrierV2,
  FindingStageRootV2,
  GenerationPlanSpecV2,
  MapCandidateSnapshotV2,
  MapCandidateValidationCoreV2,
  MapPositionNodeV2,
  MapRelationV2,
  MapReviewBundleV2,
  MapReviewCoverageCoreV2,
  MapReviewObservationCarrierV2,
  MapReviewPublishCarriersV2,
  MapReviewRoundV2,
  MapReviewSettlementCoreV2,
  MapSnapshotV2,
  ProposedMapCoreV2,
  PublicationOperationPayloadV2,
  RepairPlanSpecV2,
  ReviewPolicyParameters,
  SlotContentVersionV2,
  SuccessorWorkItemCarrierV2,
  SystemCommandTerminalCarrierV2,
  ValidationWarningCustodyRootV2,
} from '../../authoritative-review/authority-types';
import { refOfBlob } from '../../authoritative-review/object-registry';
import { resolveMapPositionGraphDigest, resolveMapRelationGraphDigest, resolveMapSemanticDigest } from '../../authoritative-review/map-domain';
import { computeContentRootDigest } from '../../authoritative-review/content-domain';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { AuthoritativeReviewProjectionV2 } from '../../storage/authoritative-review-state';
import type { AuthoritativeReviewProfileSnapshotV1Body } from '../../structured-slots/authoritative-review-profile';
import { attemptContinuationOperationId } from './attempt-coordinator';
import { buildAuthorityBaseSet } from './authority-base';
import { planMapReview, type MapReviewPlanV2 } from './observation-planner';
import {
  ReviewCoordinatorV2,
  reviewAssignmentIdOf,
  reviewBatchWorkItemId,
  reviewWholeAssignmentId,
  reviewWholeWorkItemId,
  type PreparedGenerationSuccessorV2,
} from './review-coordinator';
import { validateSuccessorCarrier } from './work-item-coordinator';
import { parseBlob } from '../../authoritative-review/object-registry';
import { REQUIRED_STAGES_BY_DEFECT } from './finding-service';

/* ------------------------------------------------------------------ */
/* Pure builders (design §11.3/§10.1/§11.5/§16.2)                      */
/* ------------------------------------------------------------------ */

export function buildMapReviewRound(input: {
  mapReviewRoundId: string;
  candidateId: string;
  candidateDigest: string;
  contentRevisionManifestRef: BlobRefV2 | null;
  contentRootDigest: string | null;
  reviewPolicyDigest: string;
  coverageNodeIds: readonly string[];
  coverageRelationIds: readonly string[];
  assignmentIds: readonly string[];
  verificationFindingStages: readonly string[];
}): MapReviewRoundV2 {
  return {
    mapReviewRoundId: input.mapReviewRoundId,
    candidateId: input.candidateId,
    candidateDigest: input.candidateDigest,
    contentRevisionManifestRef: input.contentRevisionManifestRef,
    contentRootDigest: input.contentRootDigest,
    reviewPolicyDigest: input.reviewPolicyDigest,
    coverageNodeIds: input.coverageNodeIds,
    coverageRelationIds: input.coverageRelationIds,
    assignmentIds: input.assignmentIds,
    inheritedRecordRefs: [],
    wholeMapObservationRefs: [],
    verificationFindingStages: input.verificationFindingStages,
    state: 'planned',
    settlementRef: null,
  };
}

export function buildMapReviewCoverageCore(input: {
  mapReviewRoundId: string;
  candidateRef: BlobRefV2;
  contentRevisionManifestRef: BlobRefV2 | null;
  contentRootDigest: string | null;
  reviewPolicyDigest: string;
  coverageLedgerRootRefs: readonly BlobRefV2[];
  wholeMapObservationRootRefs: readonly BlobRefV2[];
  findingStageRootRef: BlobRefV2;
}): MapReviewCoverageCoreV2 {
  const body = { ...input };
  return { ...body, coreDigest: canonicalJsonSha256(body) };
}

export function buildEmptyFindingStageRoot(roundId: string): FindingStageRootV2 {
  const body = { rootId: `fsr-${canonicalJsonSha256({ roundId }).slice(0, 24)}`, roundId, entries: [] };
  return { ...body, rootDigest: canonicalJsonSha256(body) };
}

export function buildMapReviewSettlementCore(input: {
  coverageCoreRef: BlobRefV2;
  mapReviewSettlementValidatorAggregateRef: BlobRefV2;
}): MapReviewSettlementCoreV2 {
  const body = { ...input };
  return { ...body, coreDigest: canonicalJsonSha256(body) };
}

export function buildProposedMapCore(input: {
  scaffoldId: string;
  proposedMapId: string;
  supersedesMapId: string | null;
  sourceCandidateRef: BlobRefV2;
  mapRevision: number;
  templateSnapshotHash: string;
  nodes: readonly MapPositionNodeV2[];
  relations: readonly MapRelationV2[];
}): ProposedMapCoreV2 {
  const source = { templateSnapshotHash: input.templateSnapshotHash, nodes: input.nodes, relations: input.relations };
  const body = {
    scaffoldId: input.scaffoldId,
    proposedMapId: input.proposedMapId,
    supersedesMapId: input.supersedesMapId,
    sourceCandidateRef: input.sourceCandidateRef,
    mapRevision: input.mapRevision,
    mapSemanticDigest: resolveMapSemanticDigest(source),
    positionGraphDigest: resolveMapPositionGraphDigest(source),
    relationGraphDigest: resolveMapRelationGraphDigest(source),
    templateSnapshotHash: input.templateSnapshotHash,
    nodes: input.nodes,
    relations: input.relations,
  };
  return { ...body, coreDigest: canonicalJsonSha256(body) };
}

export function buildMapReviewBundle(input: {
  settlementCoreRef: BlobRefV2;
  proposedMapCoreRef: BlobRefV2;
  mapActivationValidatorAggregateRef: BlobRefV2;
  mapWarningCustodyRootRef: BlobRefV2;
}): MapReviewBundleV2 {
  const body = { ...input };
  return { ...body, bundleDigest: canonicalJsonSha256(body) };
}

export function buildMapSnapshot(input: {
  scaffoldId: string;
  mapId: string;
  supersedesMapId: string | null;
  sourceCandidateId: string;
  proposedMapCoreRef: BlobRefV2;
  mapReviewBundleRef: BlobRefV2;
  mapRevision: number;
  mapSemanticDigest: string;
  positionGraphDigest: string;
  relationGraphDigest: string;
  templateSnapshotHash: string;
  nodes: readonly MapPositionNodeV2[];
  relations: readonly MapRelationV2[];
  activatedAt: string;
}): MapSnapshotV2 {
  return { ...input };
}

/** Two-entry `map_review` warning custody root (settlement + activation executions, design §9). */
export function buildMapReviewWarningCustodyRoot(input: {
  taskId: string;
  settlementInputRef: BlobRefV2;
  settlementInputDigest: string;
  settlementAggregateRef: BlobRefV2;
  settlementWarningRootRef: BlobRefV2;
  activationInputRef: BlobRefV2;
  activationInputDigest: string;
  activationAggregateRef: BlobRefV2;
  activationWarningRootRef: BlobRefV2;
}): ValidationWarningCustodyRootV2 {
  const body = {
    scope: 'map_review' as const,
    taskId: input.taskId,
    baseRefs: [input.settlementInputRef, input.activationInputRef].sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0)),
    entries: [
      {
        trigger: 'map_review_settlement' as const,
        inputRef: input.settlementInputRef,
        inputDigest: input.settlementInputDigest,
        executionScope: {} as Record<string, never>,
        validatorAggregateRef: input.settlementAggregateRef,
        warningRootRef: input.settlementWarningRootRef,
      },
      {
        trigger: 'map_activation' as const,
        inputRef: input.activationInputRef,
        inputDigest: input.activationInputDigest,
        executionScope: {} as Record<string, never>,
        validatorAggregateRef: input.activationAggregateRef,
        warningRootRef: input.activationWarningRootRef,
      },
    ],
    supersessionPolicyVersion: '1',
  };
  return { ...body, rootDigest: canonicalJsonSha256(body) };
}

/** Deterministic content-schema digest stand-in (Task 17/21 replace with the
 * resolved template slot-type content schema; deterministic now so the
 * baseline-unset manifest bytes are stable). */
export function contentSchemaDigestOf(slotType: string): string {
  return canonicalJsonSha256({ slotType });
}

export function buildBaselineUnsetManifest(input: {
  taskId: string;
  mapRef: BlobRefV2;
  mapSemanticDigest: string;
  taskContentRevision: number;
  contentBearingSlots: readonly { slotId: string; documentOrder: number }[];
  contentSchemaOf: (slotId: string) => string;
}): { manifest: ContentRevisionManifestV2; versions: readonly SlotContentVersionV2[] } {
  const versions: SlotContentVersionV2[] = [];
  const entries: { slotId: string; versionRef: BlobRefV2 }[] = [];
  const sorted = [...input.contentBearingSlots].sort((a, b) => (a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0));
  for (const slot of sorted) {
    const version: SlotContentVersionV2 = {
      state: 'unset',
      slotId: slot.slotId,
      slotRevision: 1,
      taskContentRevision: input.taskContentRevision,
      mapRef: input.mapRef,
      mapSemanticDigest: input.mapSemanticDigest,
      contentSchemaDigest: input.contentSchemaOf(slot.slotId),
      unsetReason: 'initial',
      unsetProvenance: { kind: 'created_empty' },
    };
    versions.push(version);
    entries.push({ slotId: slot.slotId, versionRef: refOfBlob('content_version', version) });
  }
  const body = {
    taskId: input.taskId,
    mapRef: input.mapRef,
    mapSemanticDigest: input.mapSemanticDigest,
    taskContentRevision: input.taskContentRevision,
    manifestPhase: 'baseline_unset' as ContentRevisionManifestPhaseV2,
    entries,
    producerPlanSpecRef: null,
    priorManifestRef: null,
    finalizerValidatorAggregateRefs: [],
    finalizerWarningRootRefs: [],
    contentRootDigest: computeContentRootDigest(versions),
  };
  return { manifest: { ...body, manifestDigest: canonicalJsonSha256(body) }, versions };
}

export function buildGenerationPlanSpec(input: {
  generationPlanId: string;
  revision: number;
  supersedesGenerationPlanId: string | null;
  sourceValidationReceiptRef: BlobRefV2 | null;
  activeMapRef: BlobRefV2;
  baseContentRevisionManifestRef: BlobRefV2;
  importedContentManifestRef: BlobRefV2;
  correctionScopeDigest: string | null;
  orderedBatchSlotIds: readonly (readonly string[])[];
}): GenerationPlanSpecV2 {
  const body = { ...input };
  return { ...body, specDigest: canonicalJsonSha256(body) };
}

/* ------------------------------------------------------------------ */
/* Service dependencies                                                */
/* ------------------------------------------------------------------ */

export interface MapReviewServiceDependencies {
  facade: Pick<AuthoritativeAppendFacadeV2, 'prepareBlob' | 'publishWithPin'>;
  reviewCoordinator: ReviewCoordinatorV2;
  readProjection(taskId: string): Promise<AuthoritativeReviewProjectionV2>;
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown> | unknown;
  tail(taskId: string): Promise<{ lastSequence: number; lastCommitId: string | null }>;
  readEvents(taskId: string): Promise<readonly AuthoritativeReviewEventV2[]>;
  committedOperation(taskId: string, operationId: string): Promise<readonly AuthoritativeReviewEventV2[] | null>;
  clock(): string;
  profile: AuthoritativeReviewProfile;
  profileBody: AuthoritativeReviewProfileSnapshotV1Body;
  validatorRegistry: import('./validator-registry').ValidatorRegistry;
  sourceResolver?: (handlerKey: string) => string | null;
  registrationsFor(trigger: 'map_review_settlement' | 'map_activation'): readonly import('../../template/structured-slot-contract-v2').ValidatorRegistrationV2[];
  reviewPolicy: ReviewPolicyParameters;
  reviewPolicyDigest: string;
  templateSnapshotRef: BlobRefV2;
  profileSnapshotRef: BlobRefV2;
  /** The frozen template snapshot hash (binds every grant spec). */
  snapshotHash: string;
  reviewerRoleBinding: string;
  generatorRoleBinding: string;
  orchestratorRoleBinding: string;
  /** Task 19 repair seam: the blocking settlement creates the deterministic
   * MapRepairPlan; the repair-round clear creates the content re-review round. */
  repairService?: import('./repair-service').RepairService;
}

/** A prepared map-review publication payload (the domain_publish envelope input). */
export interface MapReviewPublishInputV2 {
  operationId: string;
  publishKind: 'review_assignment_commit' | 'map_review_round_completed' | 'map_review_settlement';
  blobRefs: readonly BlobRefV2[];
  carriers: MapReviewPublishCarriersV2;
  preparedRefs: readonly BlobRefV2[];
}

/** The in-memory validator blob store capturing every engine-produced object. */
export class MapReviewMemoryValidatorBlobStore implements ValidatorBlobStore {
  readonly produced: Array<{ kind: import('../../../shared/authoritative-review-v2').AuthoritativeBlobKindV2; value: unknown }> = [];

  private readonly data = new Map<string, unknown>();

  put(kind: import('../../../shared/authoritative-review-v2').AuthoritativeBlobKindV2, value: unknown): BlobRefV2 {
    const ref = refOfBlob(kind, value);
    if (!this.data.has(ref.digest)) {
      this.data.set(ref.digest, value);
      this.produced.push({ kind, value });
    }
    return ref;
  }

  resolve(ref: BlobRefV2): unknown | null {
    return this.data.get(ref.digest) ?? null;
  }
}

export function mapReviewCarrier(carriers: Partial<MapReviewPublishCarriersV2> = {}): MapReviewPublishCarriersV2 {
  return {
    assignmentId: null,
    mapReviewRoundId: null,
    workItemId: null,
    attemptId: null,
    reviewAssignmentId: null,
    source: null,
    ledgerRef: null,
    coverageTargetCount: null,
    findingCount: null,
    observations: null,
    verificationRecords: null,
    coverageCoreRef: null,
    settlementCoreRef: null,
    outcome: null,
    mapId: null,
    mapRevision: null,
    supersedesMapId: null,
    mapSnapshotRef: null,
    mapReviewBundleRef: null,
    mapSemanticDigest: null,
    contentRevisionManifestRef: null,
    activationValidatorAggregateRef: null,
    migrationSettlementCoreRef: null,
    migrationActivationDecisionRef: null,
    taskContentRevision: null,
    manifestPhase: null,
    producerPlanSpecRef: null,
    priorManifestRef: null,
    successor: null,
    terminal: null,
    contentRound: null,
    reviewWorkItems: null,
    mixedContentRepair: null,
    verifiedClosedFindingIds: null,
    ...carriers,
  };
}

function need<T>(value: T | null | undefined, name: string): asserts value is T {
  if (value === null || value === undefined) throw new NotRebuildableError('map-review', [name]);
}

function asDomain(payload: { family: string }): Extract<PublicationOperationPayloadV2, { family: 'domain_publish' }> {
  if (payload.family !== 'domain_publish') {
    throw new NotRebuildableError('map-review', [`payload family '${payload.family}' is not domain_publish`]);
  }
  return payload as Extract<PublicationOperationPayloadV2, { family: 'domain_publish' }>;
}

function parseDomainPublishPayload(value: unknown): PublicationOperationPayloadV2 {
  return parsePublicationOperationPayload(value);
}

function sha256Of(events: readonly PublicationEventEnvelopeV2[]): string {
  return canonicalJsonSha256(events);
}

/* ------------------------------------------------------------------ */
/* Publication handler registration (deterministic §9.2 rebuilds)      */
/* ------------------------------------------------------------------ */

/** Registers the three Task 16 map-review publication handlers. */
export function registerMapReviewPublicationHandlers(registry: PublicationIntentRegistry): void {
  registerReviewAssignmentCommit(registry);
  registerMapReviewRoundCompleted(registry);
  registerMapReviewSettlement(registry);
}

function registerReviewAssignmentCommit(registry: PublicationIntentRegistry): void {
  if (registry.resolve('review_assignment_commit', 1) !== null) return;
  registry.register({
    handlerKind: 'review_assignment_commit',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: ['structured_map_review_assignment_committed', 'structured_map_observation_recorded', 'structured_finding_verification_recorded'],
    rebuildable: true,
    missingInputs: [],
    parsePayload: parseDomainPublishPayload,
    childRefsOf: (p) => (p.family === 'domain_publish' ? [...p.blobRefs] : []),
    resolveRefs: (p) => {
      if (p.family !== 'domain_publish') return [];
      const out: PublicationIntentResolvedRef[] = [];
      if (p.mapReview !== null && p.mapReview.ledgerRef !== null) out.push({ key: 'ledger', ref: p.mapReview.ledgerRef });
      return out;
    },
    buildEvents: (payload, at, refs) => {
      const p = asDomain(payload);
      const mr = p.mapReview;
      need(mr, 'mapReview');
      const verificationEvents: PublicationEventEnvelopeV2[] = (mr.verificationRecords ?? []).map((record) => ({
        protocolVersion: 2,
        at,
        type: 'structured_finding_verification_recorded' as const,
        ...record,
      }));
      if (mr.observations !== null && mr.observations.length > 0) {
        // Whole-map observation: emit the layered observation events (level order).
        need(mr.mapReviewRoundId, 'mapReviewRoundId');
        return [...verificationEvents, ...mr.observations.map((o) => ({
          protocolVersion: 2,
          at,
          type: 'structured_map_observation_recorded' as const,
          observationId: o.observationId,
          mapReviewRoundId: mr.mapReviewRoundId,
          level: o.level,
          parentObservationId: o.parentObservationId,
          observationRef: o.observationRef,
          coveredTargetCount: o.coveredTargetCount,
          childObservationRefs: o.childObservationRefs,
        }))];
      }
      const ledgerRef = mr.ledgerRef ?? refs?.get('ledger');
      if (ledgerRef === null || ledgerRef === undefined) throw new NotRebuildableError('review_assignment_commit', ['ledgerRef']);
      need(mr.assignmentId, 'assignmentId');
      need(mr.mapReviewRoundId, 'mapReviewRoundId');
      need(mr.workItemId, 'workItemId');
      need(mr.attemptId, 'attemptId');
      need(mr.source, 'source');
      need(mr.coverageTargetCount, 'coverageTargetCount');
      need(mr.findingCount, 'findingCount');
      return [
        ...verificationEvents,
        {
          protocolVersion: 2,
          at,
          type: 'structured_map_review_assignment_committed',
          assignmentId: mr.assignmentId,
          mapReviewRoundId: mr.mapReviewRoundId,
          workItemId: mr.workItemId,
          attemptId: mr.attemptId,
          reviewAssignmentId: mr.reviewAssignmentId,
          source: mr.source,
          ledgerRef: ledgerRef as BlobRefV2,
          coverageTargetCount: mr.coverageTargetCount,
          findingCount: mr.findingCount,
        },
      ];
    },
    expectedResultIdentity: (_payload, events) => sha256Of(events),
  });
}

function registerMapReviewRoundCompleted(registry: PublicationIntentRegistry): void {
  if (registry.resolve('map_review_round_completed', 1) !== null) return;
  registry.register({
    handlerKind: 'map_review_round_completed',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: ['structured_map_review_round_completed'],
    rebuildable: true,
    missingInputs: [],
    parsePayload: parseDomainPublishPayload,
    childRefsOf: (p) => (p.family === 'domain_publish' ? [...p.blobRefs] : []),
    resolveRefs: (p) => {
      if (p.family !== 'domain_publish') return [];
      const out: PublicationIntentResolvedRef[] = [];
      if (p.mapReview !== null && p.mapReview.coverageCoreRef !== null) out.push({ key: 'coverageCore', ref: p.mapReview.coverageCoreRef });
      return out;
    },
    buildEvents: (payload, at, refs) => {
      const p = asDomain(payload);
      const mr = p.mapReview;
      need(mr, 'mapReview');
      need(mr.mapReviewRoundId, 'mapReviewRoundId');
      const coverageCoreRef = mr.coverageCoreRef ?? refs?.get('coverageCore');
      if (coverageCoreRef === null || coverageCoreRef === undefined) throw new NotRebuildableError('map_review_round_completed', ['coverageCoreRef']);
      return [
        {
          protocolVersion: 2,
          at,
          type: 'structured_map_review_round_completed',
          mapReviewRoundId: mr.mapReviewRoundId,
          coverageCoreRef: coverageCoreRef as BlobRefV2,
        },
      ];
    },
    expectedResultIdentity: (_payload, events) => sha256Of(events),
  });
}

function registerMapReviewSettlement(registry: PublicationIntentRegistry): void {
  if (registry.resolve('map_review_settlement', 1) !== null) return;
  registry.register({
    handlerKind: 'map_review_settlement',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: [
      'structured_map_review_round_settled',
      'structured_map_activated',
      'structured_content_revision_committed',
      'structured_review_round_planned',
      'structured_content_repair_plan_started',
      'structured_repair_grant_issued',
      'structured_work_item_created',
      'structured_system_command_completed',
      'structured_work_item_completed',
      'structured_finding_verified_closed',
    ],
    rebuildable: true,
    missingInputs: [],
    parsePayload: parseDomainPublishPayload,
    childRefsOf: (p) => (p.family === 'domain_publish' ? [...p.blobRefs] : []),
    resolveRefs: (p) => {
      if (p.family !== 'domain_publish') return [];
      const out: PublicationIntentResolvedRef[] = [];
      const mr = p.mapReview;
      if (mr !== null) {
        if (mr.mapSnapshotRef !== null) out.push({ key: 'mapSnapshot', ref: mr.mapSnapshotRef });
        if (mr.contentRevisionManifestRef !== null) out.push({ key: 'manifest', ref: mr.contentRevisionManifestRef });
      }
      return out;
    },
    buildEvents: (payload, at, refs) => {
      const p = asDomain(payload);
      const mr = p.mapReview;
      need(mr, 'mapReview');
      need(mr.mapReviewRoundId, 'mapReviewRoundId');
      need(mr.settlementCoreRef, 'settlementCoreRef');
      need(mr.outcome, 'outcome');
      need(mr.terminal, 'terminal');
      const t = mr.terminal;
      const envelopes: PublicationEventEnvelopeV2[] = (mr.verifiedClosedFindingIds ?? []).map((findingId) => ({
        protocolVersion: 2,
        at,
        type: 'structured_finding_verified_closed' as const,
        findingId,
      }));
      envelopes.push(
        {
          protocolVersion: 2,
          at,
          type: 'structured_map_review_round_settled',
          mapReviewRoundId: mr.mapReviewRoundId,
          settlementCoreRef: mr.settlementCoreRef,
          outcome: mr.outcome,
        },
      );
      if (mr.outcome === 'activate') {
        need(mr.mapId, 'mapId');
        need(mr.mapRevision, 'mapRevision');
        need(mr.mapSnapshotRef, 'mapSnapshotRef');
        need(mr.mapReviewBundleRef, 'mapReviewBundleRef');
        need(mr.mapSemanticDigest, 'mapSemanticDigest');
        need(mr.contentRevisionManifestRef, 'contentRevisionManifestRef');
        need(mr.activationValidatorAggregateRef, 'activationValidatorAggregateRef');
        envelopes.push({
          protocolVersion: 2,
          at,
          type: 'structured_map_activated',
          mapId: mr.mapId,
          mapRevision: mr.mapRevision,
          supersedesMapId: mr.supersedesMapId,
          mapSnapshotRef: mr.mapSnapshotRef,
          mapReviewBundleRef: mr.mapReviewBundleRef,
          mapSemanticDigest: mr.mapSemanticDigest,
          contentRevisionManifestRef: mr.contentRevisionManifestRef,
          activationValidatorAggregateRef: mr.activationValidatorAggregateRef,
          migrationSettlementCoreRef: mr.migrationSettlementCoreRef,
          migrationActivationDecisionRef: mr.migrationActivationDecisionRef,
        });
        // Task 19 repair-round activation: the manifest is UNCHANGED by a
        // Map repair (manifestPhase stays null -> NO content_revision_committed).
        if (mr.manifestPhase !== null) {
          need(mr.taskContentRevision, 'taskContentRevision');
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_content_revision_committed',
            contentRevisionManifestRef: mr.contentRevisionManifestRef,
            taskContentRevision: mr.taskContentRevision,
            manifestPhase: mr.manifestPhase,
            producerPlanSpecRef: mr.producerPlanSpecRef,
            priorManifestRef: mr.priorManifestRef,
          });
        }
        const s = mr.successor;
        if (s !== null) {
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_work_item_created',
            workItemId: s.workItemId,
            kind: s.kind,
            roleBinding: s.roleBinding,
            agentExecutionKind: s.agentExecutionKind,
            sessionKind: s.sessionKind,
            roundId: s.roundId,
            logicalAssignmentId: s.logicalAssignmentId,
            reviewAssignmentId: s.reviewAssignmentId,
            grantSpecRef: s.grantSpecRef,
            inputArtifactDeliveryId: s.inputArtifactDeliveryId,
            authorityBaseRef: s.authorityBaseRef,
            payloadRef: s.payloadRef,
            initialLeaseEpoch: s.initialLeaseEpoch,
            maxAutomaticRetries: s.maxAutomaticRetries,
          });
        }
        // Task 19: the content re-review round after a repaired Map activates
        // (the §13.3.1 content-cycle boundary — the round-planned event +
        // review WorkItems ride the SAME activation envelope).
        const cr = mr.contentRound;
        if (cr !== null) {
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_review_round_planned',
            reviewRoundId: cr.reviewRoundId,
            contentCycleOrdinal: cr.contentCycleOrdinal,
            mapRef: cr.mapRef,
            mapSemanticDigest: cr.mapSemanticDigest,
            contentRevisionManifestRef: cr.contentRevisionManifestRef,
            reviewPolicyDigest: cr.reviewPolicyDigest,
            adoptionRootRef: cr.adoptionRootRef,
            coverageSlotCount: cr.coverageSlotCount,
            coverageRelationCount: cr.coverageRelationCount,
            assignmentCount: cr.assignmentCount,
            verificationFindingCount: cr.verificationFindingCount,
            consumedOverrideRef: cr.consumedOverrideRef,
          });
          for (const rw of mr.reviewWorkItems ?? []) {
            envelopes.push({
              protocolVersion: 2,
              at,
              type: 'structured_work_item_created',
              workItemId: rw.workItemId,
              kind: rw.kind,
              roleBinding: rw.roleBinding,
              agentExecutionKind: rw.agentExecutionKind,
              sessionKind: rw.sessionKind,
              roundId: rw.roundId,
              logicalAssignmentId: rw.logicalAssignmentId,
              reviewAssignmentId: rw.reviewAssignmentId,
              grantSpecRef: rw.grantSpecRef,
              inputArtifactDeliveryId: rw.inputArtifactDeliveryId,
              authorityBaseRef: rw.authorityBaseRef,
              payloadRef: rw.payloadRef,
              initialLeaseEpoch: rw.initialLeaseEpoch,
              maxAutomaticRetries: rw.maxAutomaticRetries,
            });
          }
        }
        const repair = mr.mixedContentRepair;
        if (repair !== null) {
          need(repair.repairPlanId, 'mixedContentRepair.repairPlanId');
          need(repair.planRevisionId, 'mixedContentRepair.planRevisionId');
          need(repair.repairPlanSpecRef, 'mixedContentRepair.repairPlanSpecRef');
          need(repair.successor, 'mixedContentRepair.successor');
          need(repair.grantSpecId, 'mixedContentRepair.grantSpecId');
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_content_repair_plan_started',
            repairPlanId: repair.repairPlanId,
            planRevisionId: repair.planRevisionId,
            repairPlanSpecRef: repair.repairPlanSpecRef,
            sourceValidationReceiptRef: repair.sourceValidationReceiptRef,
          });
          const rw = repair.successor;
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_work_item_created',
            workItemId: rw.workItemId,
            kind: rw.kind,
            roleBinding: rw.roleBinding,
            agentExecutionKind: rw.agentExecutionKind,
            sessionKind: rw.sessionKind,
            roundId: rw.roundId,
            logicalAssignmentId: rw.logicalAssignmentId,
            reviewAssignmentId: rw.reviewAssignmentId,
            grantSpecRef: rw.grantSpecRef,
            inputArtifactDeliveryId: rw.inputArtifactDeliveryId,
            authorityBaseRef: rw.authorityBaseRef,
            payloadRef: rw.payloadRef,
            initialLeaseEpoch: rw.initialLeaseEpoch,
            maxAutomaticRetries: rw.maxAutomaticRetries,
          });
          need(rw.grantSpecRef, 'mixedContentRepair.successor.grantSpecRef');
          need(repair.workItemId, 'mixedContentRepair.workItemId');
          need(repair.grantKind, 'mixedContentRepair.grantKind');
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_repair_grant_issued',
            grantSpecId: repair.grantSpecId,
            grantSpecRef: rw.grantSpecRef,
            workItemId: repair.workItemId,
            grantKind: repair.grantKind,
          });
        }
      }
      envelopes.push(
        {
          protocolVersion: 2,
          at,
          type: 'structured_system_command_completed',
          commandId: t.commandId,
          workItemId: t.workItemId,
          commandKind: t.commandKind,
          leaseEpoch: t.leaseEpoch,
          authorityBaseRef: t.authorityBaseRef,
        },
        {
          protocolVersion: 2,
          at,
          type: 'structured_work_item_completed',
          workItemId: t.workItemId,
          leaseEpoch: t.leaseEpoch,
          authorityBaseRef: t.authorityBaseRef,
        },
      );
      return envelopes;
    },
    expectedResultIdentity: (_payload, events) => sha256Of(events),
  });
}

/* ------------------------------------------------------------------ */
/* The service                                                         */
/* ------------------------------------------------------------------ */

export class MapReviewError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MapReviewError';
    this.code = code;
  }
}

export class MapReviewService {
  private readonly deps: MapReviewServiceDependencies;

  constructor(deps: MapReviewServiceDependencies) {
    this.deps = deps;
  }

  /* ------------------------- round planning ---------------------- */

  /** Builds + prepares the round blob and the PLANNED coverage core (empty
   * ledger roots — the workitem matrix binds them before any ledger exists). */
  async planRound(input: {
    taskId: string;
    round: MapReviewRoundV2;
    candidateRef: BlobRefV2;
    reviewPolicyDigest: string;
  }): Promise<{ roundRef: BlobRefV2; coverageCoreRef: BlobRefV2 }> {
    const roundRef = await this.deps.facade.prepareBlob(input.taskId, 'map_review_round', input.round);
    // The planned core's finding_stage_root ref must have bytes on disk from
    // creation (GC walks the planned core's child refs and fails closed on a
    // missing blob — Task 18 F1). The REAL empty root is prepared here, so the
    // planned ref is byte-identical to the round-completion root.
    const plannedFindingStageRootRef = await this.deps.facade.prepareBlob(
      input.taskId,
      'finding_stage_root',
      buildEmptyFindingStageRoot(input.round.mapReviewRoundId),
    );
    const plannedCore = buildMapReviewCoverageCore({
      mapReviewRoundId: input.round.mapReviewRoundId,
      candidateRef: input.candidateRef,
      contentRevisionManifestRef: input.round.contentRevisionManifestRef,
      contentRootDigest: input.round.contentRootDigest,
      reviewPolicyDigest: input.reviewPolicyDigest,
      coverageLedgerRootRefs: [],
      wholeMapObservationRootRefs: [],
      findingStageRootRef: plannedFindingStageRootRef,
    });
    const coverageCoreRef = await this.deps.facade.prepareBlob(input.taskId, 'map_review_coverage_core', plannedCore);
    return { roundRef, coverageCoreRef };
  }

  /* ------------------------- Task 13 freeze seam ------------------ */

  /** The Task 13 `resolveAssignmentTargets` seam (design §11.10 precedence):
   * returns the ASSIGNMENT-scoped ordinary target set of the current review
   * workitem — recomputed deterministically from the candidate + round-planned
   * assignmentCount, matched by the reviewAssignmentId. Whole-map observations
   * carry no ordinary verdicts ([]). */
  async resolveAssignmentTargets(ctx: import('./attempt-coordinator').V2AttemptContext): Promise<readonly string[] | null> {
    const state = await this.deps.readProjection(ctx.taskId);
    const wi = state.workItems[ctx.workItemId];
    if (wi === undefined || wi.roundId === null || wi.reviewAssignmentId === null) return null;
    if (wi.sessionKind === 'review_map_whole') return [];
    const roundId = wi.roundId;
    const assignmentId = wi.reviewAssignmentId;
    const events = await this.deps.readEvents(ctx.taskId);
    const planned = events.find(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_round_planned' }> =>
        e.type === 'structured_map_review_round_planned' && e.mapReviewRoundId === roundId,
    );
    if (planned === undefined) return null;
    const candidate = (await this.deps.resolver(ctx.taskId, planned.candidateRef)) as MapCandidateSnapshotV2 | null;
    if (candidate === null || typeof candidate !== 'object') return null;
    const core = (await this.deps.resolver(ctx.taskId, candidate.validationCoreRef)) as MapCandidateValidationCoreV2 | null;
    if (core === null || typeof core !== 'object') return null;
    const plan = planMapReview({
      nodes: core.nodes,
      relations: core.relations,
      profile: this.deps.profile,
      reviewPolicy: this.deps.reviewPolicy,
      assignmentCount: planned.assignmentCount,
    });
    for (let index = 0; index < plan.batches.length; index++) {
      if (reviewAssignmentIdOf(roundId, index) === assignmentId) {
        const batch = plan.batches[index];
        return [...batch.nodeIds, ...batch.relationIds];
      }
    }
    return null;
  }

  /** The Task 13 `freezeReviewAssignment` seam: publishes the assignment ledger
   * + the `structured_map_review_assignment_committed` (batch) or the layered
   * `structured_map_observation_recorded` events (whole observation) atomically. */
  async freezeReviewAssignment(taskId: string, freeze: import('./tool-factory').FrozenReviewAssignmentV2): Promise<{ ledgerRef: BlobRefV2; eventId: string }> {
    const state = await this.deps.readProjection(taskId);
    const wi = state.workItems[freeze.ledger.workItemId];
    const sessionKind = wi?.sessionKind ?? null;
    const isWhole = sessionKind === 'review_map_whole' || sessionKind === 'review_content_whole';

    const refs: BlobRefV2[] = [];
    for (const ref of [...freeze.factRefs, ...freeze.verificationRecordRefs, ...freeze.findingDraftRefs]) {
      // The freeze carries precomputed pure refs; prepare the actual blobs.
      const value = this.findPreparedBlob(freeze, ref);
      if (value !== undefined) await this.deps.facade.prepareBlob(taskId, ref.kind, value);
    }
    const ledgerRef = await this.deps.facade.prepareBlob(taskId, 'review_assignment_ledger', freeze.ledger);
    const blobRefs = [...freeze.factRefs, ...freeze.verificationRecordRefs, ...freeze.findingDraftRefs, ledgerRef];
    const verificationRecords = freeze.verifications.map((record) => ({
      recordId: record.recordId,
      recordRef: refOfBlob('finding_verification_record', record),
      findingId: record.findingId,
      reviewContext: record.reviewContext,
      assignmentId: record.assignmentId,
      repairStage: record.repairStage,
      verdict: record.verdict,
    }));

    if (isWhole) {
      const observations = await this.buildObservationEvents(taskId, freeze.ledger, ledgerRef);
      await this.publish(taskId, {
        operationId: deterministicFreezeOperationId(taskId, freeze.ledger.workItemId),
        publishKind: 'review_assignment_commit',
        blobRefs,
        carriers: mapReviewCarrier({
          mapReviewRoundId: freeze.ledger.roundId,
          workItemId: freeze.ledger.workItemId,
          observations,
          verificationRecords,
        }),
        preparedRefs: blobRefs,
      });
      return { ledgerRef, eventId: deterministicEventIdOf(taskId, freeze.ledger.workItemId) };
    }

    await this.publish(taskId, {
      operationId: deterministicFreezeOperationId(taskId, freeze.ledger.workItemId),
      publishKind: 'review_assignment_commit',
      blobRefs,
      carriers: mapReviewCarrier({
        assignmentId: freeze.ledger.assignmentId,
        mapReviewRoundId: freeze.ledger.roundId,
        workItemId: freeze.ledger.workItemId,
        attemptId: this.attemptIdOf(state, freeze.ledger.workItemId),
        reviewAssignmentId: freeze.ledger.reviewAssignmentId,
        source: 'batch',
        ledgerRef,
        coverageTargetCount: freeze.ledger.coverageTargetIds.length,
        findingCount: freeze.findingDraftRefs.length,
        verificationRecords,
      }),
      preparedRefs: blobRefs,
    });
    return { ledgerRef, eventId: deterministicEventIdOf(taskId, freeze.ledger.workItemId) };
  }

  private findPreparedBlob(freeze: import('./tool-factory').FrozenReviewAssignmentV2, ref: BlobRefV2): unknown {
    for (const f of freeze.facts) if (refOfBlob('review_fact', f).digest === ref.digest) return f;
    for (const v of freeze.verifications) if (refOfBlob('finding_verification_record', v).digest === ref.digest) return v;
    for (const f of freeze.findings) if (refOfBlob('finding', f).digest === ref.digest) return f;
    return undefined;
  }

  private attemptIdOf(state: AuthoritativeReviewProjectionV2, workItemId: string): string {
    for (const attempt of Object.values(state.attempts)) {
      if (attempt.workItemId === workItemId && attempt.state === 'started') return attempt.attemptId;
    }
    return '';
  }

  private async buildObservationEvents(
    taskId: string,
    ledger: AssignmentLedgerBlobV2,
    ledgerRef: BlobRefV2,
  ): Promise<MapReviewObservationCarrierV2[] | null> {
    const state = await this.deps.readProjection(taskId);
    const roundId = ledger.roundId;
    const planned = state.mapRounds[roundId];
    if (planned === undefined) return null;
    const events = await this.deps.readEvents(taskId);
    const plannedEvent = events.find(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_round_planned' }> =>
        e.type === 'structured_map_review_round_planned' && e.mapReviewRoundId === roundId,
    );
    if (plannedEvent === undefined) return null;
    const candidateRef = plannedEvent.candidateRef;
    const candidate = (await this.deps.resolver(taskId, candidateRef)) as MapCandidateSnapshotV2 | null;
    if (candidate === null || typeof candidate !== 'object') return null;
    const core = (await this.deps.resolver(taskId, candidate.validationCoreRef)) as MapCandidateValidationCoreV2 | null;
    if (core === null || typeof core !== 'object') return null;
    const plan = planMapReview({
      nodes: core.nodes,
      relations: core.relations,
      profile: this.deps.profile,
      reviewPolicy: this.deps.reviewPolicy,
      assignmentCount: plannedEvent.assignmentCount,
    });
    // The event-level convention is ROOT-FIRST: level 1 is the root observation
    // (no parentObservationId), children are level 2, … (the event validator
    // rejects a level-1 parent and a level>1 without one). planLayeredObservations
    // numbers LEAF-first, so the event level = totalLevels - planLevel + 1.
    const totalLevels = plan.observationLevels.length;
    const parentOf = new Map<string, string>();
    for (const level of plan.observationLevels) {
      for (const o of level.observations) {
        for (const child of o.childObservationScopeIds) parentOf.set(child, o.observationScopeId);
      }
    }
    const carriers: MapReviewObservationCarrierV2[] = [];
    // Publish plan root-first so the event level order is 1, 2, …
    for (let i = plan.observationLevels.length - 1; i >= 0; i--) {
      const level = plan.observationLevels[i];
      const eventLevel = totalLevels - level.level + 1;
      for (const o of level.observations) {
        carriers.push({
          observationId: o.observationScopeId,
          level: eventLevel,
          parentObservationId: parentOf.get(o.observationScopeId) ?? null,
          observationRef: ledgerRef,
          coveredTargetCount: o.coverageSlotIds.length,
          childObservationRefs: o.childObservationScopeIds.map((id) => ledgerRef),
        });
      }
    }
    return carriers;
  }

  /* ------------------------- round completion --------------------- */

  /**
   * Minor 3 (adversarial review): deterministic recovery for a crash between
   * `structured_map_review_round_planned` and the review-WorkItem creation. The
   * WorkItem ids are deterministic from the round, so startup/scan re-issues
   * the review WorkItems for a planned round whose review WorkItems are missing
   * (the coordinator's createWorkItem replays committed ones). The round blob +
   * planned coverage core are recomputed content-addressed, so re-creation is
   * byte-identical. Returns true when it (re)created any WorkItem.
   */
  async ensureRoundReviewWorkItems(taskId: string, roundId: string): Promise<boolean> {
    const state = await this.deps.readProjection(taskId);
    const events = await this.deps.readEvents(taskId);
    const plannedEvent = events.find(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_round_planned' }> =>
        e.type === 'structured_map_review_round_planned' && e.mapReviewRoundId === roundId,
    );
    if (plannedEvent === undefined) return false;
    const expectedBatchIds = Array.from({ length: plannedEvent.assignmentCount }, (_, i) => reviewBatchWorkItemId(roundId, i));
    const expectedWholeId = reviewWholeWorkItemId(roundId);
    const expected = [...expectedBatchIds, expectedWholeId];
    const missing = expected.filter((id) => state.workItems[id] === undefined);
    if (missing.length === 0) return false;
    const round = await this.readRoundBlob(taskId, roundId, events);
    const roundRef = refOfBlob('map_review_round', round);
    const plannedFindingStageRootRef = await this.deps.facade.prepareBlob(
      taskId,
      'finding_stage_root',
      buildEmptyFindingStageRoot(roundId),
    );
    const plannedCore = buildMapReviewCoverageCore({
      mapReviewRoundId: roundId,
      candidateRef: plannedEvent.candidateRef,
      contentRevisionManifestRef: plannedEvent.contentRevisionManifestRef,
      contentRootDigest: null,
      reviewPolicyDigest: plannedEvent.reviewPolicyDigest,
      coverageLedgerRootRefs: [],
      wholeMapObservationRootRefs: [],
      findingStageRootRef: plannedFindingStageRootRef,
    });
    const coverageCoreRef = await this.deps.facade.prepareBlob(taskId, 'map_review_coverage_core', plannedCore);
    const candidate = (await this.deps.resolver(taskId, plannedEvent.candidateRef)) as MapCandidateSnapshotV2 | null;
    if (candidate === null || typeof candidate !== 'object') return false;
    const candidateCore = (await this.deps.resolver(taskId, candidate.validationCoreRef)) as MapCandidateValidationCoreV2 | null;
    if (candidateCore === null || typeof candidateCore !== 'object') return false;
    const plan = planMapReview({
      nodes: candidateCore.nodes,
      relations: candidateCore.relations,
      profile: this.deps.profile,
      reviewPolicy: this.deps.reviewPolicy,
      assignmentCount: plannedEvent.assignmentCount,
    });
    await this.deps.reviewCoordinator.createRoundReviewWorkItems({
      taskId,
      round,
      roundRef,
      coverageCoreRef,
      mapCandidateRef: plannedEvent.candidateRef,
      plan,
    });
    return true;
  }

  /** The review-coordinator's round-advance: when every batch assignment is
   * frozen AND the whole-map observation closure is recorded, builds the FINAL
   * coverage core, publishes `structured_map_review_round_completed`, and
   * creates the `system_review_settlement` WorkItem. */
  async maybeCompleteRound(taskId: string, roundId: string): Promise<boolean> {
    const state = await this.deps.readProjection(taskId);
    const planned = state.mapRounds[roundId];
    if (planned === undefined || planned.state === 'completed' || planned.state === 'settled') return false;
    const events = await this.deps.readEvents(taskId);
    const frozen = new Set(
      events
        .filter(
          (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_assignment_committed' }> =>
            e.type === 'structured_map_review_assignment_committed' && e.mapReviewRoundId === roundId,
        )
        .map((e) => e.assignmentId),
    );
    if (frozen.size !== planned.assignmentCount) return false;
    // The whole-map observation must have recorded its root closure (event
    // level 1 — the ROOT-FIRST event convention) AND every non-root observation
    // must have its parent at the exact level below (a bounded closure).
    const recorded = events.filter(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_observation_recorded' }> =>
        e.type === 'structured_map_observation_recorded' && e.mapReviewRoundId === roundId,
    );
    const root = recorded.find((e) => e.parentObservationId === null);
    if (root === undefined || root.level !== 1) return false;
    const rootCount = recorded.filter((e) => e.parentObservationId === null).length;
    if (rootCount !== 1) return false;
    const levelOf = new Map<string, number>();
    for (const e of recorded) levelOf.set(e.observationId, e.level);
    for (const e of recorded) {
      if (e.level > 1) {
        const parentLevel = e.parentObservationId === null ? undefined : levelOf.get(e.parentObservationId);
        if (parentLevel === undefined || parentLevel !== e.level - 1) return false;
      }
    }
    // Minor 1 (adversarial review): the leaf-observation union must cover every
    // candidate node — a degenerate single root event must not pass (design
    // §12.6 "每个叶级批次产生受 digest 绑定的公开观察摘要").
    const plannedEvent = events.find(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_round_planned' }> =>
        e.type === 'structured_map_review_round_planned' && e.mapReviewRoundId === roundId,
    );
    if (plannedEvent === undefined) return false;
    const candidate = (await this.deps.resolver(taskId, plannedEvent.candidateRef)) as MapCandidateSnapshotV2 | null;
    const candidateCore = candidate === null || typeof candidate !== 'object'
      ? null
      : (await this.deps.resolver(taskId, candidate.validationCoreRef)) as MapCandidateValidationCoreV2 | null;
    if (candidateCore === null || typeof candidateCore !== 'object') return false;
    const plan = planMapReview({
      nodes: candidateCore.nodes,
      relations: candidateCore.relations,
      profile: this.deps.profile,
      reviewPolicy: this.deps.reviewPolicy,
      assignmentCount: plannedEvent.assignmentCount,
    });
    const totalLevels = plan.observationLevels.length;
    const leafObservationIds = new Set(
      plan.observationLevels
        .filter((level) => level.level === 1)
        .flatMap((level) => level.observations.map((o) => o.observationScopeId)),
    );
    const recordedIds = new Set(recorded.map((e) => e.observationId));
    if (leafObservationIds.size === 0 || [...leafObservationIds].some((id) => !recordedIds.has(id))) return false;
    const leafCovered = new Set(
      plan.observationLevels
        .filter((level) => level.level === 1)
        .flatMap((level) => level.observations.flatMap((o) => o.coverageSlotIds)),
    );
    if (leafCovered.size !== candidateCore.nodes.length) return false;
    for (const n of candidateCore.nodes) {
      if (!leafCovered.has(n.slotId)) return false;
    }

    // Build the FINAL coverage core.
    const assignmentEvents = events.filter(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_assignment_committed' }> =>
        e.type === 'structured_map_review_assignment_committed' && e.mapReviewRoundId === roundId,
    );
    const coverageLedgerRootRefs = assignmentEvents.map((e) => e.ledgerRef);
    const wholeMapObservationRootRefs = recorded.map((e) => e.observationRef);
    const findingStageRootRef = await this.deps.facade.prepareBlob(
      taskId,
      'finding_stage_root',
      buildEmptyFindingStageRoot(roundId),
    );
    const finalCore = buildMapReviewCoverageCore({
      mapReviewRoundId: roundId,
      candidateRef: plannedEvent.candidateRef,
      contentRevisionManifestRef: plannedEvent.contentRevisionManifestRef,
      contentRootDigest: null,
      reviewPolicyDigest: plannedEvent.reviewPolicyDigest,
      coverageLedgerRootRefs,
      wholeMapObservationRootRefs,
      findingStageRootRef,
    });
    const coverageCoreRef = await this.deps.facade.prepareBlob(taskId, 'map_review_coverage_core', finalCore);
    await this.publish(taskId, {
      operationId: deterministicRoundCompletedOperationId(taskId, roundId),
      publishKind: 'map_review_round_completed',
      blobRefs: [coverageCoreRef],
      carriers: mapReviewCarrier({ mapReviewRoundId: roundId, coverageCoreRef }),
      preparedRefs: [coverageCoreRef],
    });

    // Create the settlement WorkItem (the ONLY activator).
    const settlementWorkItemId = deterministicSettlementWorkItemId(taskId, roundId);
    const roundBlob = await this.readRoundBlob(taskId, roundId, events);
    const roundRef = refOfBlob('map_review_round', roundBlob);
    const authorityBase = buildAuthorityBaseSet({
      taskId,
      templateSnapshotRef: this.deps.templateSnapshotRef,
      profileSnapshotRef: this.deps.profileSnapshotRef,
      refs: { mapCandidateRef: plannedEvent.candidateRef, reviewCoverageCoreRef: coverageCoreRef, reviewRoundRef: roundRef },
      kind: 'system_review_settlement',
    });
    const maxAutomaticRetries = this.deps.profile.maxConsecutiveAttemptsWithoutProgress;
    await this.deps.reviewCoordinator.createSettlementWorkItem({
      taskId,
      workItemId: settlementWorkItemId,
      authorityBase,
      coverageCore: finalCore,
      maxAutomaticRetries,
    });
    return true;
  }

  private async readRoundBlob(taskId: string, roundId: string, events: readonly AuthoritativeReviewEventV2[]): Promise<MapReviewRoundV2> {    const planned = events.find(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_round_planned' }> =>
        e.type === 'structured_map_review_round_planned' && e.mapReviewRoundId === roundId,
    );
    if (planned === undefined) throw new MapReviewError('ROUND_UNKNOWN', `no round-planned event for '${roundId}'`);
    // R2-1 (re-review round 2): the round blob the settlement binds must be
    // BYTE-IDENTICAL to the blob the finalize/planner PREPARED — a
    // deterministic REBUILD diverges whenever the projection changed since the
    // round was planned (e.g. the reviewer verified the repair finding, which
    // would drop the carried verification stages) and would bind bytes that
    // were never written (GC TASK_CORRUPTED). Resolve the prepared blob via
    // the round's review WorkItems — their authority base binds reviewRoundRef
    // = the prepared round blob.
    const state = await this.deps.readProjection(taskId);
    const roundWorkItem = Object.values(state.workItems).find(
      (wi) => wi.roundId === roundId && (wi.sessionKind === 'review_map_batch' || wi.sessionKind === 'review_map_whole'),
    );
    if (roundWorkItem !== undefined) {
      const baseSet = (await this.deps.resolver(taskId, roundWorkItem.authorityBaseRef)) as { reviewRoundRef?: BlobRefV2 } | null;
      if (baseSet !== null && typeof baseSet === 'object' && baseSet.reviewRoundRef !== undefined) {
        const prepared = (await this.deps.resolver(taskId, baseSet.reviewRoundRef)) as MapReviewRoundV2 | null;
        if (prepared !== null && typeof prepared === 'object') {
          return prepared;
        }
      }
    }
    // Fallback: the deterministic rebuild. For a repaired candidate the stages
    // are derived from the plan EXACTLY as the finalize prepared them — with
    // `subtractVerified: false` (the finalize ran BEFORE any verification, so
    // its derivation never subtracted the verified state — subtracting it here
    // would diverge from the prepared bytes).
    const core = (await this.deps.resolver(taskId, planned.candidateRef)) as MapCandidateSnapshotV2 | null;
    if (core === null || typeof core !== 'object') throw new MapReviewError('CANDIDATE_UNRESOLVED', 'candidate unresolvable');
    const candidateCore = (await this.deps.resolver(taskId, core.validationCoreRef)) as MapCandidateValidationCoreV2 | null;
    if (candidateCore === null || typeof candidateCore !== 'object') throw new MapReviewError('CANDIDATE_CORE_UNRESOLVED', 'candidate core unresolvable');
    const assignmentIds = Array.from({ length: planned.assignmentCount }, (_, i) => reviewAssignmentIdOf(roundId, i));
    assignmentIds.push(reviewWholeAssignmentId(roundId));
    let verificationFindingStages: string[] = [];
    const provenance = candidateCore.candidateProvenanceWithoutValidation as { producerKind?: string; repairPlanId?: string; repairPlanRevision?: number } | null;
    if (provenance !== null && provenance.producerKind === 'system_repair_finalize' && typeof provenance.repairPlanId === 'string' && this.deps.repairService !== undefined) {
      const lineage = state.repairPlans[provenance.repairPlanId];
      if (lineage !== undefined) {
        for (const revision of Object.values(lineage.revisions)) {
          const plan = (await this.deps.resolver(taskId, revision.specRef)) as RepairPlanSpecV2 | null;
          if (plan !== null && typeof plan === 'object' && plan.revision === provenance.repairPlanRevision) {
            verificationFindingStages = await this.deps.repairService.verificationStagesOfPlan(taskId, plan, 'map', false);
            break;
          }
        }
      }
    }
    return buildMapReviewRound({
      mapReviewRoundId: roundId,
      candidateId: planned.candidateId,
      candidateDigest: planned.candidateRef.digest,
      contentRevisionManifestRef: planned.contentRevisionManifestRef,
      contentRootDigest: null,
      reviewPolicyDigest: planned.reviewPolicyDigest,
      coverageNodeIds: candidateCore.nodes.map((n) => n.slotId),
      coverageRelationIds: candidateCore.relations.map((r) => r.relationId),
      assignmentIds,
      verificationFindingStages,
    });
  }

  /* ------------------------- settlement --------------------------- */

  /** The round's blocking reviewer-source findings (the repair-route input). */
  private async settlementBlockingFindings(taskId: string, round: MapReviewRoundV2): Promise<readonly import('./finding-service').ProjectedFindingLifecycleV2[]> {
    const state = await this.deps.readProjection(taskId);
    const carriedFindingIds = new Set(round.verificationFindingStages.map((entry) => entry.split(':')[0] ?? ''));
    const out: import('./finding-service').ProjectedFindingLifecycleV2[] = [];
    for (const finding of Object.values(state.findings)) {
      const openedHere = finding.reviewContext.kind === 'map' && finding.reviewContext.roundId === round.mapReviewRoundId;
      if (!openedHere && !carriedFindingIds.has(finding.findingId)) continue;
      const { projectFindingLifecycle } = await import('./finding-service');
      const lifecycle = projectFindingLifecycle({ finding });
      if (lifecycle.blockingUnclosed) out.push(lifecycle);
    }
    return out;
  }

  /**
   * The `system_review_settlement(stage=initial)` handler — the ONLY activator.
   * Runs the acyclic DAG, and on clear publishes the atomic activation envelope.
   */
  async executeMapReviewSettlement(input: {
    taskId: string;
    commandId: string;
    workItemId: string;
    commandKind: 'review_settlement';
    leaseEpoch: number;
    authorityBaseRef: BlobRefV2;
    payloadRef: BlobRefV2;
  }): Promise<{ kind: 'completed'; resultRefs: readonly BlobRefV2[] } | { kind: 'retryable_failure'; failureCode: string; failureDigest: string }> {
    try {
      const project = await this.deps.readProjection(input.taskId);
      const wi = project.workItems[input.workItemId];
      if (wi === undefined) throw new MapReviewError('WORK_ITEM_NOT_FOUND', `no workitem '${input.workItemId}'`);
      const base = (await this.deps.resolver(input.taskId, input.authorityBaseRef)) as { mapCandidateRef: BlobRefV2 | null; reviewCoverageCoreRef: BlobRefV2 | null; reviewRoundRef: BlobRefV2 | null; contentRevisionManifestRef: BlobRefV2 | null; mapRef: BlobRefV2 | null } | null;
      if (base === null || typeof base !== 'object' || base.mapCandidateRef === null || base.reviewCoverageCoreRef === null || base.reviewRoundRef === null) {
        throw new MapReviewError('GRANT_STALE', `settlement authority base is unresolvable or missing candidate/coverage/round refs`);
      }
      const coverageCore = (await this.deps.resolver(input.taskId, base.reviewCoverageCoreRef)) as MapReviewCoverageCoreV2 | null;
      if (coverageCore === null || typeof coverageCore !== 'object') throw new MapReviewError('COVERAGE_CORE_UNRESOLVED', 'coverage core unresolvable');
      // Minor 4 (adversarial review): WIRE the system payload — the settlement
      // WorkItem's payloadRef is the coverage core it was created against. It
      // must be the EXACT core the authority base binds (fail closed on a
      // mismatch); a stale payload can never activate against a different core.
      if (input.payloadRef.kind !== 'map_review_coverage_core' || input.payloadRef.digest !== base.reviewCoverageCoreRef.digest) {
        throw new MapReviewError('GRANT_STALE', 'settlement payload does not match the authority base coverage core');
      }
      const round = (await this.deps.resolver(input.taskId, base.reviewRoundRef)) as MapReviewRoundV2 | null;
      if (round === null || typeof round !== 'object') throw new MapReviewError('ROUND_UNRESOLVED', 'round blob unresolvable');
      const candidate = (await this.deps.resolver(input.taskId, base.mapCandidateRef)) as MapCandidateSnapshotV2 | null;
      if (candidate === null || typeof candidate !== 'object') throw new MapReviewError('CANDIDATE_UNRESOLVED', 'candidate unresolvable');
      const candidateCore = (await this.deps.resolver(input.taskId, candidate.validationCoreRef)) as MapCandidateValidationCoreV2 | null;
      if (candidateCore === null || typeof candidateCore !== 'object') throw new MapReviewError('CANDIDATE_CORE_UNRESOLVED', 'candidate validation core unresolvable');

      // Findings are authoritative gates independent of validator outcome.
      // An open Map obligation creates repair; an addressed-but-unverified
      // obligation fail-closes until a real verification record is committed.
      const authoritativeBlocking = await this.settlementBlockingFindings(input.taskId, round);
      const needsMapRepair = authoritativeBlocking.filter((finding) =>
        REQUIRED_STAGES_BY_DEFECT[finding.defectClass].includes('map') && !finding.addressStages.includes('map'),
      );
      if (needsMapRepair.length > 0) {
        if (this.deps.repairService === undefined) {
          return { kind: 'retryable_failure', failureCode: 'MAP_REVIEW_BLOCKED', failureDigest: canonicalJsonSha256({ commandId: input.commandId, reason: 'repair seam missing' }) };
        }
        return await this.deps.repairService.createRepairPlanFromSettlement({
          taskId: input.taskId,
          settlementWorkItemId: input.workItemId,
          settlementCommandId: input.commandId,
          leaseEpoch: input.leaseEpoch,
          authorityBaseRef: input.authorityBaseRef,
          roundId: round.mapReviewRoundId,
          coverageCoreRef: base.reviewCoverageCoreRef,
          findings: needsMapRepair,
        });
      }
      const awaitingMapVerification = authoritativeBlocking.some((finding) =>
        REQUIRED_STAGES_BY_DEFECT[finding.defectClass].includes('map') && !finding.verifiedStages.includes('map'),
      );
      if (awaitingMapVerification) {
        return { kind: 'retryable_failure', failureCode: 'MAP_REVIEW_BLOCKED', failureDigest: canonicalJsonSha256({ commandId: input.commandId, reason: 'authoritative finding verification missing' }) };
      }

      // Segment 1: map_review_settlement aggregate over the frozen coverage core.
      const settlementRun = await this.runSettlementValidator(input, base.reviewCoverageCoreRef, coverageCore, candidateCore);
      await this.persistEngineOutputs(input.taskId, settlementRun.run, settlementRun.store);
      if (settlementRun.run.aggregate.outcome === 'blocking_invalid') {
        const findings = await this.settlementBlockingFindings(input.taskId, round);
        if (this.deps.repairService !== undefined && findings.length > 0) {
          // Task 19: the deterministic MapRepairPlan creation (the settlement
          // command COMPLETES with the plan envelope — never a bare retry).
          return await this.deps.repairService.createRepairPlanFromSettlement({
            taskId: input.taskId,
            settlementWorkItemId: input.workItemId,
            settlementCommandId: input.commandId,
            leaseEpoch: input.leaseEpoch,
            authorityBaseRef: input.authorityBaseRef,
            roundId: round.mapReviewRoundId,
            coverageCoreRef: base.reviewCoverageCoreRef,
            findings,
          });
        }
        return { kind: 'retryable_failure', failureCode: 'MAP_REVIEW_BLOCKED', failureDigest: canonicalJsonSha256({ commandId: input.commandId, aggregateRef: settlementRun.run.aggregateRef }) };
      }
      if (settlementRun.run.aggregate.outcome !== 'clear') {
        return { kind: 'retryable_failure', failureCode: 'VALIDATOR_INFRASTRUCTURE_FAILURE', failureDigest: canonicalJsonSha256({ commandId: input.commandId, aggregateRef: settlementRun.run.aggregateRef }) };
      }

      // Segment 2: MapReviewSettlementCore.
      const settlementCore = buildMapReviewSettlementCore({
        coverageCoreRef: base.reviewCoverageCoreRef,
        mapReviewSettlementValidatorAggregateRef: settlementRun.run.aggregateRef,
      });
      const settlementCoreRef = await this.deps.facade.prepareBlob(input.taskId, 'map_review_settlement_core', settlementCore);

      // Segment 3: ProposedMapCore.
      const scaffoldId = `scaffold-${candidate.candidateId}`;
      const proposedMapId = `map-${canonicalJsonSha256({ candidateId: candidate.candidateId, label: 'proposed' }).slice(0, 24)}`;
      const proposedCore = buildProposedMapCore({
        scaffoldId,
        proposedMapId,
        supersedesMapId: null,
        sourceCandidateRef: base.mapCandidateRef,
        mapRevision: 1,
        templateSnapshotHash: candidateCore.templateSnapshotHash,
        nodes: candidateCore.nodes,
        relations: candidateCore.relations,
      });
      const proposedMapCoreRef = await this.deps.facade.prepareBlob(input.taskId, 'proposed_map_core', proposedCore);

      // Segment 4: map_activation aggregate over (settlement core + proposed map core).
      const activationRun = await this.runActivationValidator(input, settlementCoreRef, proposedMapCoreRef, proposedCore);
      await this.persistEngineOutputs(input.taskId, activationRun.run, activationRun.store);
      if (activationRun.run.aggregate.outcome === 'blocking_invalid') {
        return { kind: 'retryable_failure', failureCode: 'MAP_ACTIVATION_BLOCKED', failureDigest: canonicalJsonSha256({ commandId: input.commandId, aggregateRef: activationRun.run.aggregateRef }) };
      }
      if (activationRun.run.aggregate.outcome !== 'clear') {
        return { kind: 'retryable_failure', failureCode: 'VALIDATOR_INFRASTRUCTURE_FAILURE', failureDigest: canonicalJsonSha256({ commandId: input.commandId, aggregateRef: activationRun.run.aggregateRef }) };
      }

      // Segment 5: MapReviewBundle (with the two-entry map_review warning custody root).
      const custody = buildMapReviewWarningCustodyRoot({
        taskId: input.taskId,
        settlementInputRef: settlementRun.run.envelopeRef,
        settlementInputDigest: settlementRun.run.envelopeRef.digest,
        settlementAggregateRef: settlementRun.run.aggregateRef,
        settlementWarningRootRef: settlementRun.run.warningRootRef,
        activationInputRef: activationRun.run.envelopeRef,
        activationInputDigest: activationRun.run.envelopeRef.digest,
        activationAggregateRef: activationRun.run.aggregateRef,
        activationWarningRootRef: activationRun.run.warningRootRef,
      });
      const custodyRef = await this.deps.facade.prepareBlob(input.taskId, 'validation_warning_custody_root', custody);
      const bundle = buildMapReviewBundle({
        settlementCoreRef,
        proposedMapCoreRef,
        mapActivationValidatorAggregateRef: activationRun.run.aggregateRef,
        mapWarningCustodyRootRef: custodyRef,
      });
      const bundleRef = await this.deps.facade.prepareBlob(input.taskId, 'map_review_bundle', bundle);

      // Segment 6: MapSnapshot.
      const snapshot = buildMapSnapshot({
        scaffoldId,
        mapId: proposedMapId,
        supersedesMapId: null,
        sourceCandidateId: candidate.candidateId,
        proposedMapCoreRef,
        mapReviewBundleRef: bundleRef,
        mapRevision: 1,
        mapSemanticDigest: proposedCore.mapSemanticDigest,
        positionGraphDigest: proposedCore.positionGraphDigest,
        relationGraphDigest: proposedCore.relationGraphDigest,
        templateSnapshotHash: candidateCore.templateSnapshotHash,
        nodes: candidateCore.nodes,
        relations: candidateCore.relations,
        activatedAt: this.deps.clock(),
      });
      const snapshotRef = await this.deps.facade.prepareBlob(input.taskId, 'map_snapshot', snapshot);

      // Task 19 repair-round detection: a round after the initial one reviews
      // a REPAIRED candidate — its activation must NOT regenerate content.
      const plannedEvents = await this.deps.readEvents(input.taskId);
      const plannedRound = plannedEvents.find(
        (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_round_planned' }> =>
          e.type === 'structured_map_review_round_planned' && e.mapReviewRoundId === round.mapReviewRoundId,
      );
      const isRepairRound = plannedRound !== undefined && plannedRound.mapCycleOrdinal > 1;
      const supersedesMapId = isRepairRound ? (project.currentMap?.mapId ?? null) : null;
      const mapRevision = isRepairRound ? (project.currentMap?.mapRevision ?? 0) + 1 : 1;

      // Segment 7: the manifest. Initial activation -> baseline-unset content;
      // repaired activation -> the CURRENT manifest is unchanged (no
      // content_revision_committed event rides the envelope).
      let manifestRef: BlobRefV2;
      let versionRefs: BlobRefV2[] = [];
      let manifestPhase: 'baseline_unset' | 'provisional' | 'finalized' | null = null;
      let taskContentRevision: number | null = null;
      let producerPlanSpecRef: BlobRefV2 | null = null;
      let priorManifestRef: BlobRefV2 | null = null;
      if (isRepairRound) {
        if (project.currentManifest === null) {
          throw new MapReviewError('MANIFEST_UNRESOLVED', 'a repaired Map activation requires the current content manifest');
        }
        manifestRef = project.currentManifest.contentRevisionManifestRef;
      } else {
        const contentBearingSlots = candidateCore.nodes
          .filter((n) => n.contentBearing)
          .map((n) => ({ slotId: n.slotId, documentOrder: n.documentOrder }));
        const { manifest, versions } = buildBaselineUnsetManifest({
          taskId: input.taskId,
          mapRef: snapshotRef,
          mapSemanticDigest: proposedCore.mapSemanticDigest,
          taskContentRevision: 1,
          contentBearingSlots,
          contentSchemaOf: (slotId) => contentSchemaDigestOf(candidateCore.nodes.find((n) => n.slotId === slotId)?.slotType ?? 'unknown'),
        });
        manifestRef = await this.deps.facade.prepareBlob(input.taskId, 'content_revision_manifest', manifest);
        for (const version of versions) {
          versionRefs.push(await this.deps.facade.prepareBlob(input.taskId, 'content_version', version));
        }
        manifestPhase = 'baseline_unset';
        taskContentRevision = 1;
      }

      // Segment 8: the successor. Initial activation -> the first
      // generation-batch WorkItem + GenerationPlan; repaired activation -> the
      // complete content re-review round (the §13.3.1 content-cycle boundary)
      // folded into the SAME envelope.
      let successor: import('./review-coordinator').PreparedGenerationSuccessorV2 | null = null;
      let contentRound: ContentReviewRoundPlanCarrierV2 | null = null;
      let reviewWorkItems: readonly SuccessorWorkItemCarrierV2[] | null = null;
      let contentRoundPreparedRefs: readonly BlobRefV2[] = [];
      let mixedContentRepair: import('../../authoritative-review/authority-types').RepairPublishCarriersV2 | null = null;
      if (isRepairRound) {
        if (this.deps.repairService === undefined) {
          throw new MapReviewError('REPAIR_SEAM_MISSING', 'a repaired Map activation requires the Task 19 repair seam');
        }
        // I-1 (adversarial review): the content re-review round binds the NEW
        // snapshot being activated (this envelope emits structured_map_activated
        // BEFORE the round-planned event; the projector demands the round's
        // mapRef == the CURRENT map). The OLD `state.currentMap` read inside
        // prepareContentRound would corrupt `map_mismatch` on every repaired-
        // Map activation.
        const settlementOperationKey = attemptContinuationOperationId(input.taskId, input.workItemId, input.commandId, 'complete');
        const mixed = await this.deps.repairService.prepareMixedContentRepairAfterMapActivation({
          taskId: input.taskId,
          settlementOperationKey,
          settlementWorkItemId: input.workItemId,
          newMapRef: snapshotRef,
          manifestRef,
        });
        if (mixed !== null) {
          mixedContentRepair = mixed.carriers;
          contentRoundPreparedRefs = mixed.preparedRefs;
        } else {
          try {
            const planned = await this.deps.repairService.prepareContentReReviewRound(input.taskId, manifestRef, {
              mapRef: snapshotRef,
              mapSemanticDigest: proposedCore.mapSemanticDigest,
            });
            contentRound = planned.round;
            reviewWorkItems = planned.reviewWorkItems;
            contentRoundPreparedRefs = planned.preparedRefs;
          } catch (error) {
            if (!(error instanceof Error) || (error as { code?: string }).code !== 'REVIEW_REPAIR_LIMIT_EXCEEDED') throw error;
            const repairProvenance = candidateCore.candidateProvenanceWithoutValidation;
            if (repairProvenance.producerKind !== 'system_repair_finalize') {
              throw new MapReviewError('PLAN_UNRESOLVED', 'repaired-Map content budget boundary lacks repair provenance');
            }
            return await this.deps.repairService.publishContentActivationOverLimitFailure({
              taskId: input.taskId,
              commandId: input.commandId,
              workItemId: input.workItemId,
              leaseEpoch: input.leaseEpoch,
              authorityBaseRef: input.authorityBaseRef,
              repairPlanId: repairProvenance.repairPlanId,
              rejectedManifestRef: manifestRef,
              failedCycleOrdinal: project.contentCycleOrdinal + 1,
            });
          }
        }
      } else {
        const contentBearingSlots = candidateCore.nodes
          .filter((n) => n.contentBearing)
          .map((n) => ({ slotId: n.slotId, documentOrder: n.documentOrder }));
        const prepared = await this.deps.reviewCoordinator.prepareGenerationSuccessor({
          taskId: input.taskId,
          mapId: proposedMapId,
          mapSnapshotRef: snapshotRef,
          mapSemanticDigest: proposedCore.mapSemanticDigest,
          manifestRef,
          contentBearingSlots,
          profileSnapshotRef: this.deps.profileSnapshotRef,
          templateSnapshotRef: this.deps.templateSnapshotRef,
        });
        successor = prepared;
        const carryErrors = validateSuccessorCarrier(prepared.carrier);
        if (carryErrors.length > 0) {
          throw new MapReviewError('INVALID_INPUT', `generation successor carry invalid: ${carryErrors.join('; ')}`);
        }
      }

      // Segment 9: the atomic §13.1/§17.5 activation envelope.
      const terminal: SystemCommandTerminalCarrierV2 = {
        workItemId: input.workItemId,
        commandId: input.commandId,
        commandKind: input.commandKind,
        leaseEpoch: input.leaseEpoch,
        authorityBaseRef: input.authorityBaseRef,
      };
      const operationId = attemptContinuationOperationId(input.taskId, input.workItemId, input.commandId, 'complete');
      const tail = await this.deps.tail(input.taskId);
      const projectedBeforeSettlement = await this.deps.readProjection(input.taskId);
      const verifiedClosedFindingIds = Object.values(projectedBeforeSettlement.findings)
        .filter((finding) => finding.severity === 'blocking' && finding.state !== 'verified_closed')
        .filter((finding) => REQUIRED_STAGES_BY_DEFECT[finding.defectClass].every((stage) => finding.verifiedStages.includes(stage)))
        .map((finding) => finding.findingId)
        .sort();
      const resultRefs = [
        settlementCoreRef,
        proposedMapCoreRef,
        activationRun.run.aggregateRef,
        custodyRef,
        bundleRef,
        snapshotRef,
        manifestRef,
        ...versionRefs,
        ...(successor === null ? [] : [successor.planSpecRef, successor.authorityBaseRef, successor.grantSpecRef]),
        ...contentRoundPreparedRefs,
      ];
      await this.deps.facade.publishWithPin({
        taskId: input.taskId,
        operationId,
        payload: {
          family: 'domain_publish',
          operationId,
          taskId: input.taskId,
          publishKind: 'map_review_settlement',
          blobRefs: resultRefs,
          expectedResultIdentity: canonicalJsonSha256({ operationId, publishKind: 'map_review_settlement' }),
          mapBuild: null,
          contentPlan: null,
          contentReview: null,
          repair: null,
          mapReview: mapReviewCarrier({
            mapReviewRoundId: round.mapReviewRoundId,
            settlementCoreRef,
            outcome: 'activate',
            mapId: proposedMapId,
            mapRevision,
            supersedesMapId,
            mapSnapshotRef: snapshotRef,
            mapReviewBundleRef: bundleRef,
            mapSemanticDigest: proposedCore.mapSemanticDigest,
            contentRevisionManifestRef: manifestRef,
            activationValidatorAggregateRef: activationRun.run.aggregateRef,
            migrationSettlementCoreRef: null,
            migrationActivationDecisionRef: null,
            taskContentRevision,
            manifestPhase,
            producerPlanSpecRef,
            priorManifestRef,
            successor: successor === null ? null : successor.carrier,
            contentRound,
            reviewWorkItems,
            mixedContentRepair,
            verifiedClosedFindingIds,
            terminal,
          }),
        },
        intent: { handlerKind: 'map_review_settlement', handlerVersion: 1 },
        preparedRefs: resultRefs,
        expectedTailSequence: tail.lastSequence,
        expectedTailCommitId: tail.lastCommitId,
      });
      return { kind: 'completed', resultRefs };
    } catch (error) {
      if (error instanceof MapReviewError) {
        return { kind: 'retryable_failure', failureCode: error.code, failureDigest: canonicalJsonSha256({ commandId: input.commandId, code: error.code }) };
      }
      return { kind: 'retryable_failure', failureCode: 'MAP_REVIEW_SETTLEMENT_FAILED', failureDigest: canonicalJsonSha256({ commandId: input.commandId, error: (error as Error).message }) };
    }
  }

  private async runSettlementValidator(
    input: { taskId: string; commandId: string; workItemId: string },
    coverageCoreRef: BlobRefV2,
    coverageCore: MapReviewCoverageCoreV2,
    candidateCore: MapCandidateValidationCoreV2,
  ): Promise<{ run: TriggerExecutionResult; store: MapReviewMemoryValidatorBlobStore }> {
    const store = new MapReviewMemoryValidatorBlobStore();
    store.put('map_review_coverage_core', coverageCore);
    const engine = new ValidatorEngine({
      registry: this.deps.validatorRegistry,
      blobs: store,
      sourceResolver: this.deps.sourceResolver,
    });
    const run = await engine.execute({
      trigger: 'map_review_settlement',
      identity: { taskId: input.taskId, templateSnapshotHash: candidateCore.templateSnapshotHash, workItemId: input.workItemId, attemptId: null, commandId: input.commandId },
      coreRef: coverageCoreRef,
      selectedTargetRefs: [],
      registrations: this.deps.registrationsFor('map_review_settlement'),
      universe: {
        slotIds: candidateCore.nodes.map((n) => n.slotId),
        relationIds: candidateCore.relations.map((r) => r.relationId),
        mapNodeIds: candidateCore.nodes.map((n) => n.slotId),
        artifactDigest: null,
      },
      profile: this.deps.profileBody,
    });
    return { run, store };
  }

  private async runActivationValidator(
    input: { taskId: string; commandId: string; workItemId: string },
    settlementCoreRef: BlobRefV2,
    proposedMapCoreRef: BlobRefV2,
    proposedCore: ProposedMapCoreV2,
  ): Promise<{ run: TriggerExecutionResult; store: MapReviewMemoryValidatorBlobStore }> {
    const store = new MapReviewMemoryValidatorBlobStore();
    const settlementCore = (await this.deps.resolver(input.taskId, settlementCoreRef)) as MapReviewSettlementCoreV2 | null;
    if (settlementCore === null || typeof settlementCore !== 'object') throw new MapReviewError('SETTLEMENT_CORE_UNRESOLVED', 'settlement core unresolvable');
    store.put('map_review_settlement_core', settlementCore);
    store.put('proposed_map_core', proposedCore);
    const engine = new ValidatorEngine({
      registry: this.deps.validatorRegistry,
      blobs: store,
      sourceResolver: this.deps.sourceResolver,
    });
    const run = await engine.execute({
      trigger: 'map_activation',
      identity: { taskId: input.taskId, templateSnapshotHash: proposedCore.templateSnapshotHash, workItemId: input.workItemId, attemptId: null, commandId: input.commandId },
      coreRef: settlementCoreRef,
      auxiliaryRefs: { proposedMapCoreRef },
      selectedTargetRefs: [],
      registrations: this.deps.registrationsFor('map_activation'),
      universe: {
        slotIds: proposedCore.nodes.map((n) => n.slotId),
        relationIds: proposedCore.relations.map((r) => r.relationId),
        mapNodeIds: proposedCore.nodes.map((n) => n.slotId),
        artifactDigest: null,
      },
      profile: this.deps.profileBody,
    });
    return { run, store };
  }

  private async persistEngineOutputs(
    taskId: string,
    run: TriggerExecutionResult,
    store: MapReviewMemoryValidatorBlobStore,
  ): Promise<void> {
    for (const produced of store.produced) {
      await this.deps.facade.prepareBlob(taskId, produced.kind, produced.value);
    }
    await this.deps.facade.prepareBlob(taskId, 'validator_input_envelope', run.envelope);
    await this.deps.facade.prepareBlob(taskId, 'validator_aggregate', run.aggregate);
    await this.deps.facade.prepareBlob(taskId, 'validation_warning_root', run.warningRoot);
    for (const receipt of run.receipts) {
      await this.deps.facade.prepareBlob(taskId, 'validation_receipt', receipt);
    }
    for (const failure of run.failures) {
      await this.deps.facade.prepareBlob(taskId, 'validator_failure', failure);
    }
  }

  /** One map-review publication through the facade. */
  private async publish(taskId: string, input: MapReviewPublishInputV2): Promise<void> {
    const tail = await this.deps.tail(taskId);
    await this.deps.facade.publishWithPin({
      taskId,
      operationId: input.operationId,
      payload: {
        family: 'domain_publish',
        operationId: input.operationId,
        taskId,
        publishKind: input.publishKind,
        blobRefs: input.blobRefs,
        expectedResultIdentity: canonicalJsonSha256({ operationId: input.operationId, publishKind: input.publishKind }),
        mapBuild: null,
        contentPlan: null,
        contentReview: null,
        repair: null,
        mapReview: input.carriers,
      },
      intent: { handlerKind: input.publishKind, handlerVersion: 1 },
      preparedRefs: input.preparedRefs,
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Deterministic operation / work-item ids                             */
/* ------------------------------------------------------------------ */

export function deterministicFreezeOperationId(taskId: string, workItemId: string): string {
  return `rf-${canonicalJsonSha256({ taskId, workItemId }).slice(0, 32)}`;
}

export function deterministicEventIdOf(taskId: string, workItemId: string): string {
  return deterministicFreezeOperationId(taskId, workItemId);
}

export function deterministicRoundCompletedOperationId(taskId: string, roundId: string): string {
  return `rc-${canonicalJsonSha256({ taskId, roundId }).slice(0, 32)}`;
}

export function deterministicSettlementWorkItemId(taskId: string, roundId: string): string {
  return `wi-settle-${canonicalJsonSha256({ taskId, roundId }).slice(0, 24)}`;
}

/* ------------------------------------------------------------------ */
/* Module-level runtime allowlist registration                         */
/* ------------------------------------------------------------------ */

/**
 * Task 16 SystemCommand handler: replaces the Task 12 `review_settlement`
 * NOT_IMPLEMENTED double via `SystemCommandRegistry.replace`. It is the ONLY
 * Map activator (stage=initial; Task 20 extends post_migration).
 */
export function createMapReviewSettlementSystemCommandHandler(service: MapReviewService): SystemCommandHandler {
  return {
    commandKind: 'review_settlement',
    async execute(ctx) {
      const outcome = await service.executeMapReviewSettlement({
        taskId: ctx.taskId,
        commandId: ctx.commandId,
        workItemId: ctx.workItemId,
        commandKind: 'review_settlement',
        leaseEpoch: ctx.leaseEpoch,
        authorityBaseRef: ctx.authorityBaseRef,
        payloadRef: ctx.payloadRef,
      });
      if (outcome.kind === 'completed') {
        return { kind: 'completed', resultRefs: outcome.resultRefs };
      }
      return { kind: 'retryable_failure', failureCode: outcome.failureCode, failureDigest: outcome.failureDigest };
    },
  };
}

// Register the three map-review publication handlers on the runtime allowlist so
// the default facade can replay their pins. Idempotent — the registration
// functions check `resolve` first. Tests with fresh registries call the same
// functions explicitly.
registerMapReviewPublicationHandlers(PUBLICATION_INTENT_REGISTRY_V2);
