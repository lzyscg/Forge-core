/**
 * Task 18 content-review-service (spec §13.2/§13.3/§13.3.1/§7.4/§11.3/§11.10,
 * design §11.6/§11.8/§11.9/§11.10/§12.1/§12.4/§12.6/§16.1/§17.5): the content
 * review round, the presence-aware coverage facts, the reviewer ledger
 * publication (the Task 13 freeze seam), the whole-tree observation closure,
 * the FINAL coverage core, the acyclic content settlement DAG, the System Seal
 * WorkItem, and the content-cycle budget boundary.
 *
 * NORMATIVE CORE:
 * - Task 17's finalizer-clear ALREADY emitted `structured_review_round_planned`
 *   (content cycle 1) and created the content review WorkItems. This service
 *   CONSUMES that round + those WorkItems — it does NOT re-plan/re-create them;
 *   it builds the FINAL `content_review_coverage_core` (real ledger/adoption/
 *   whole-tree-observation/finding-stage roots) from them. The workitem matrix
 *   bound `reviewRoundRef` = the PLANNED coverage core (empty ledger roots); the
 *   final coverage core replaces it at round completion (the round-completed
 *   event + the settlement WorkItem bind the FINAL core; the planned core stays
 *   the workitem-bound round carrier — the transition is documented);
 * - presence-aware coverage (design §11.6 / spec §13.2 step 5): set required
 *   AND optional slots require reviewer facts; optional-unset gets the system
 *   `absent_not_applicable` fact (never a reviewer turn); required-unset or any
 *   `rewrite_required` makes the round UNPLANABLE (route to generation/repair
 *   first — no settlement, no Seal);
 * - relation coverage: every actual blocking relation requires a relation-
 *   satisfaction fact; advisory relations only when `reviewAdvisoryRelations`;
 *   zero relations satisfy either quantifier naturally;
 * - the Task 13 freeze seam freezes one completed assignment: every fact/
 *   verification/finding + the AssignmentLedgerBlob are prepared and
 *   `structured_review_assignment_started` + `structured_content_review_
 *   assignment_committed` + `structured_review_assignment_completed` (batch) or
 *   the layered `structured_whole_tree_observation_recorded` events (whole
 *   observation) are published in ONE atomic batch;
 * - the settlement DAG is acyclic: `ContentReviewCoverageCore ->
 *   content_review_settlement aggregate -> ContentReviewSettlementCore ->
 *   ReviewBundle`; the coverage core is frozen WITHOUT the settlement aggregate;
 *   the settlement core is frozen only after the aggregate is clear; the bundle
 *   only after settlement — no self-reference cycle is possible;
 * - clear creates the `system_seal` WorkItem (the `system_seal_input` seam);
 *   any blocking fact/Finding routes to repair, NEVER Seal;
 * - the content-cycle budget (spec §13.3.1): contentCycleOrdinal increments ONLY
 *   at the atomic complete-round creation. `REVIEW_REPAIR_LIMIT_EXCEEDED`
 *   over-limit terminal-fails the task and publishes no round/RepairPlan/
 *   ReviewBundle/Seal; retries, whole-observation layers, infrastructure retry,
 *   stop/resume, and response-loss replay do NOT increment; the ONLY exception
 *   is an exact available Content `RoundBudgetOverrideV2` consumed exactly once.
 *
 * PUBLICATION MODEL: the four Task 18 branches (`content_review_assignment_
 * commit`, `content_review_round_completed`, `content_review_round_planned`,
 * `content_review_settlement`) are registered publication handlers on the module
 * allowlist AND on injected registries via `registerContentReviewPublicationHandlers`.
 *
 * V1 byte-for-byte: new module; v1 surfaces untouched.
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
  AuthorityBaseSetV2,
  ContentRevisionManifestV2,
  ContentReviewCoverageCoreV2,
  ContentReviewFindingOpeningCarrierV2,
  ContentReviewObservationCarrierV2,
  ContentReviewPublishCarriersV2,
  ContentReviewRoundPlanCarrierV2,
  ContentReviewSettlementCoreV2,
  FindingStageRootV2,
  MapRelationV2,
  PublicationOperationPayloadV2,
  ReviewPolicyParameters,
  ReviewRoundStateV2,
  ReviewRoundV2,
  ReviewBundleV2,
  SlotContentVersionV2,
  SlotPresenceV2,
  SuccessorWorkItemCarrierV2,
  SystemCommandTerminalCarrierV2,
  ValidationWarningCustodyRootV2,
} from '../../authoritative-review/authority-types';
import { refOfBlob } from '../../authoritative-review/object-registry';
import {
  computePresenceCoverage,
  assertAbsenceFactCurrent,
  type PresenceCoverageResultV2,
} from '../../authoritative-review/content-domain';
import { settleContentRoundCoverage, planLayeredObservations, type ObservationLevelV2 } from '../../authoritative-review/review-domain';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { AuthoritativeReviewProjectionV2 } from '../../storage/authoritative-review-state';
import type { AuthoritativeReviewProfileSnapshotV1Body } from '../../structured-slots/authoritative-review-profile';
import { attemptContinuationOperationId } from './attempt-coordinator';
import { buildAuthorityBaseSet } from './authority-base';
import { contentReviewRoundId, buildEmptyAdoptionRoot } from './content-plan-service';
import {
  ReviewCoordinatorV2,
  reviewAssignmentIdOf,
  reviewBatchWorkItemId,
  reviewWholeAssignmentId,
  reviewWholeWorkItemId,
  reviewWorkItemOperationId,
  buildReviewObservationGrantSpec,
} from './review-coordinator';
import { validateSuccessorCarrier } from './work-item-coordinator';
import { ReviewAdoptionService } from './review-adoption-service';
import { FindingService, buildFindingStageRoot, verificationStagesOf } from './finding-service';
import { selectContentRelationTargets } from './observation-planner';

/* ------------------------------------------------------------------ */
/* Pure builders (design §11.10/§11.6/§16.1)                           */
/* ------------------------------------------------------------------ */

export function buildContentReviewCoverageCore(input: {
  reviewRoundId: string;
  mapRef: BlobRefV2;
  contentRevisionManifestRef: BlobRefV2;
  reviewPolicyDigest: string;
  coverageLedgerRootRefs: readonly BlobRefV2[];
  adoptionRootRef: BlobRefV2;
  wholeTreeObservationRootRefs: readonly BlobRefV2[];
  findingStageRootRef: BlobRefV2;
}): ContentReviewCoverageCoreV2 {
  const body = { ...input };
  return { ...body, coreDigest: canonicalJsonSha256(body) };
}

export function buildContentReviewSettlementCore(input: {
  coverageCoreRef: BlobRefV2;
  reviewSettlementValidatorAggregateRef: BlobRefV2;
}): ContentReviewSettlementCoreV2 {
  const body = { ...input };
  return { ...body, coreDigest: canonicalJsonSha256(body) };
}

export function buildReviewBundle(input: {
  settlementCoreRef: BlobRefV2;
  mapRef: BlobRefV2;
  contentRevisionManifestRef: BlobRefV2;
  reviewWarningCustodyRootRef: BlobRefV2;
}): ReviewBundleV2 {
  const body = { ...input };
  return { ...body, bundleDigest: canonicalJsonSha256(body) };
}

/** Single-entry `content_review` warning custody root (the settlement execution,
 * design §9 — the initial content review has exactly one validator trigger). */
export function buildContentReviewWarningCustodyRoot(input: {
  taskId: string;
  settlementInputRef: BlobRefV2;
  settlementInputDigest: string;
  settlementAggregateRef: BlobRefV2;
  settlementWarningRootRef: BlobRefV2;
}): ValidationWarningCustodyRootV2 {
  const body = {
    scope: 'content_review' as const,
    taskId: input.taskId,
    baseRefs: [input.settlementInputRef],
    entries: [
      {
        trigger: 'review_settlement' as const,
        inputRef: input.settlementInputRef,
        inputDigest: input.settlementInputDigest,
        executionScope: {} as Record<string, never>,
        validatorAggregateRef: input.settlementAggregateRef,
        warningRootRef: input.settlementWarningRootRef,
      },
    ],
    supersessionPolicyVersion: '1',
  };
  return { ...body, rootDigest: canonicalJsonSha256(body) };
}

/** Reconstructs a `ReviewRoundV2` from the PLANNED coverage core (the workitem
 * matrix's reviewRoundRef) + the finalized manifest + the content plan. The
 * content tools resolve the round through this — no `content_review_round` blob
 * kind is registered (the workitems already bind the planned core; a new round
 * blob kind would be GC-unreachable without re-creating the frozen workitems). */
export function contentRoundShape(input: {
  reviewRoundId: string;
  mapRef: BlobRefV2;
  mapSemanticDigest: string;
  contentRevisionManifestRef: BlobRefV2;
  contentRootDigest: string;
  reviewPolicyDigest: string;
  coverageSlotIds: readonly string[];
  coverageRelationIds: readonly string[];
  assignmentSlotIds: readonly string[];
  assignmentRelationIds: readonly string[];
  assignmentIds: readonly string[];
  verificationFindingStages: readonly string[];
}): ReviewRoundV2 {
  return {
    reviewRoundId: input.reviewRoundId,
    mapRef: input.mapRef,
    mapSemanticDigest: input.mapSemanticDigest,
    contentRevisionManifestRef: input.contentRevisionManifestRef,
    contentRootDigest: input.contentRootDigest,
    reviewPolicyDigest: input.reviewPolicyDigest,
    coverageSlotIds: input.coverageSlotIds,
    coverageRelationIds: input.coverageRelationIds,
    assignmentSlotIds: input.assignmentSlotIds,
    assignmentRelationIds: input.assignmentRelationIds,
    verificationFindingIds: input.verificationFindingStages.map((s) => s.split(':')[0]).filter((id, i, a) => a.indexOf(id) === i),
    verificationFindingStages: input.verificationFindingStages,
    assignmentIds: input.assignmentIds,
    inheritedRecordRefs: [],
    wholeTreeObservationRefs: [],
    state: 'reviewing_batches' as ReviewRoundStateV2,
    settlementRef: null,
  };
}

/* ------------------------------------------------------------------ */
/* Deterministic content review plan (spec §13.2 steps 5-7)            */
/* ------------------------------------------------------------------ */

export interface ContentReviewBatchV2 {
  batchIndex: number;
  slotIds: string[];
  relationIds: string[];
}

export interface ContentReviewPlanV2 {
  /** Exactly `assignmentCount` batches (the round-planned closure gate). */
  batches: ContentReviewBatchV2[];
  /** Every set slot id (stable document-order). */
  slotTargets: string[];
  /** Every content coverage relation id (blocking + advisory-when-enabled). */
  relationTargets: string[];
  /** Layered whole-tree observation levels (one root closure). */
  observationLevels: ObservationLevelV2[];
}

/**
 * Deterministic content review plan: set slots partitioned by
 * `contentBatchTargetSlots` (documentOrder then slotId) into EXACTLY the
 * round-planned `assignmentCount` batches; every actual blocking relation
 * assigned to the earliest-endpoint batch; advisory relations only when
 * `reviewAdvisoryRelations=true`; zero relations pass naturally.
 */
export function planContentReview(input: {
  slots: readonly { slotId: string; documentOrder: number; parentSlotId: string | null }[];
  relations: readonly MapRelationV2[];
  reviewPolicy: ReviewPolicyParameters;
  assignmentCount: number;
  /** blocking predicate from the relation TYPE (template); default treats every
   * relation as blocking (fail-safe — extra coverage never breaks a Gate). */
  isBlocking?: (r: MapRelationV2) => boolean;
}): ContentReviewPlanV2 {
  const count = Math.max(1, input.assignmentCount);
  const batchSize = Math.max(1, input.reviewPolicy.contentBatchTargetSlots);
  const slotTargets = [...input.slots]
    .sort((a, b) => a.documentOrder - b.documentOrder || (a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0))
    .map((s) => s.slotId);
  const batches: ContentReviewBatchV2[] = [];
  for (let i = 0; i < slotTargets.length; i += batchSize) {
    batches.push({ batchIndex: batches.length, slotIds: slotTargets.slice(i, i + batchSize), relationIds: [] });
  }
  // Exactly `count` batches: the round-planned count is ceil(setSlots/batchSize),
  // so an empty slot set yields one empty batch; otherwise the partition above
  // already matches count. Guard the degenerate empty-set case.
  while (batches.length < count) {
    batches.push({ batchIndex: batches.length, slotIds: [], relationIds: [] });
  }
  // Relations: earliest-covered-endpoint batch (by slot index).
  const batchOfSlot = new Map<string, number>();
  batches.forEach((batch, index) => {
    for (const slotId of batch.slotIds) batchOfSlot.set(slotId, index);
  });
  const relationTargets = selectContentRelationTargets(input.relations, input.reviewPolicy.reviewAdvisoryRelations === true, input.isBlocking);
  const relationOf = new Map<string, MapRelationV2>();
  for (const r of input.relations) relationOf.set(r.relationId, r);
  for (const relationId of relationTargets) {
    const rel = relationOf.get(relationId) as MapRelationV2;
    const endpointIndexes = [rel.fromSlotId, rel.toSlotId]
      .map((endpoint) => batchOfSlot.get(endpoint))
      .filter((index): index is number => index !== undefined)
      .sort((a, b) => a - b);
    const assigned = endpointIndexes[0] ?? 0;
    batches[assigned].relationIds.push(relationId);
  }
  for (const batch of batches) batch.relationIds.sort();
  const observationLevels = planLayeredObservations(
    input.slots.map((s) => ({ slotId: s.slotId, parentId: s.parentSlotId, documentOrder: s.documentOrder })),
    { leafBatchSize: batchSize },
  ).levels;
  return { batches, slotTargets, relationTargets, observationLevels };
}

/* ------------------------------------------------------------------ */
/* Content round resolution (the tool-factory's reviewRoundRef seam)   */
/* ------------------------------------------------------------------ */

/**
 * Reconstructs the round the tools resolve from `grant.baseSet.reviewRoundRef`.
 * The content review WorkItems bind reviewRoundRef = the PLANNED coverage core
 * (Task 17); the tool layer needs a `ReviewRoundV2` shape (verification stages,
 * coverage/assignment target kinds for cross-scope drafts). No
 * `content_review_round` blob kind is registered — this deterministic
 * reconstruction IS the content round carrier.
 */
export async function resolveContentRoundFromCore(
  taskId: string,
  core: ContentReviewCoverageCoreV2,
  deps: {
    resolver(taskId: string, ref: BlobRefV2): Promise<unknown> | unknown;
    readProjection(taskId: string): Promise<AuthoritativeReviewProjectionV2>;
    reviewPolicy: ReviewPolicyParameters;
  },
): Promise<ReviewRoundV2> {
  const state = await deps.readProjection(taskId);
  const projected = state.contentRounds[core.reviewRoundId];
  const assignmentCount = projected?.assignmentCount ?? 1;
  const manifest = (await deps.resolver(taskId, core.contentRevisionManifestRef)) as ContentRevisionManifestV2 | null;
  const setSlotIds: string[] = [];
  const versions = new Map<string, SlotContentVersionV2>();
  if (manifest !== null && typeof manifest === 'object' && Array.isArray(manifest.entries)) {
    for (const entry of manifest.entries) {
      const version = (await deps.resolver(taskId, entry.versionRef)) as SlotContentVersionV2 | null;
      if (version !== null && typeof version === 'object' && version.state === 'set') {
        setSlotIds.push(entry.slotId);
        versions.set(entry.slotId, version);
      }
    }
  }
  setSlotIds.sort();
  const snapshot = state.currentMap === null
    ? null
    : (await deps.resolver(taskId, state.currentMap.mapSnapshotRef)) as { nodes?: readonly { slotId: string; documentOrder: number; parentSlotId: string | null }[]; relations?: readonly MapRelationV2[] } | null;
  const nodeOf = new Map<string, { slotId: string; documentOrder: number; parentSlotId: string | null }>();
  if (snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.nodes)) {
    for (const n of snapshot.nodes) nodeOf.set(n.slotId, n);
  }
  const slots = setSlotIds.map((slotId) => nodeOf.get(slotId) ?? { slotId, documentOrder: 0, parentSlotId: null });
  const relations = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.relations)
    ? (snapshot.relations as MapRelationV2[])
    : [];
  const plan = planContentReview({ slots, relations, reviewPolicy: deps.reviewPolicy, assignmentCount });
  // Verification stages: the round's finding-stage root (resolved when the real
  // root was prepared; unresolvable → [] — a fresh round has no targets yet).
  let verificationFindingStages: string[] = [];
  if (state.findings !== undefined) {
    for (const finding of Object.values(state.findings)) {
      if (finding.reviewContext.kind !== 'content' || finding.reviewContext.roundId !== core.reviewRoundId) continue;
      if (finding.source === 'system_validator') continue;
      for (const stage of finding.addressStages) {
        if (!finding.verifiedStages.includes(stage)) verificationFindingStages.push(`${finding.findingId}:${stage}`);
      }
    }
    verificationFindingStages.sort();
  }
  const assignmentSlotIds = plan.batches.flatMap((b) => b.slotIds);
  const assignmentRelationIds = plan.batches.flatMap((b) => b.relationIds);
  const mapSemanticDigest = state.currentMap?.mapSemanticDigest ?? '';
  return contentRoundShape({
    reviewRoundId: core.reviewRoundId,
    mapRef: core.mapRef,
    mapSemanticDigest,
    contentRevisionManifestRef: core.contentRevisionManifestRef,
    contentRootDigest: manifest?.contentRootDigest ?? '',
    reviewPolicyDigest: core.reviewPolicyDigest,
    coverageSlotIds: setSlotIds,
    coverageRelationIds: plan.relationTargets,
    assignmentSlotIds,
    assignmentRelationIds,
    assignmentIds: Array.from({ length: assignmentCount }, (_, i) => reviewAssignmentIdOf(core.reviewRoundId, i)).concat([reviewWholeAssignmentId(core.reviewRoundId)]),
    verificationFindingStages,
  });
}

/* ------------------------------------------------------------------ */
/* Content cycle budget (spec §13.3.1)                                 */
/* ------------------------------------------------------------------ */

/** The §13.3.1 budget predicate (pure): a new complete round is legal when
 * `nextOrdinal <= maxRounds` OR an EXACT available Content RoundBudgetOverrideV2
 * is being consumed. Wrong track/preconsumed/absent override rejects. */
export function contentRoundBudgetCheck(input: {
  nextOrdinal: number;
  maxRounds: number;
  availableOverride: { ref: BlobRefV2; track: 'map' | 'content' } | null;
  overrideRef: BlobRefV2 | null;
}): void {
  if (input.nextOrdinal <= input.maxRounds) {
    return;
  }
  if (input.overrideRef === null) {
    throw new ReviewRepairLimitExceededError('(budget)', input.nextOrdinal, input.maxRounds);
  }
  const available = input.availableOverride;
  if (available === null || available.track !== 'content' || available.ref.digest !== input.overrideRef.digest) {
    throw new ContentReviewError('OVERRIDE_UNAVAILABLE', 'no exact available content RoundBudgetOverrideV2 for this round');
  }
}

/* ------------------------------------------------------------------ */
/* Service dependencies                                                */
/* ------------------------------------------------------------------ */

export interface ContentReviewServiceDependencies {
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
  registrationsFor(trigger: 'content_review_settlement'): readonly import('../../template/structured-slot-contract-v2').ValidatorRegistrationV2[];
  reviewPolicy: ReviewPolicyParameters;
  reviewPolicyDigest: string;
  templateSnapshotRef: BlobRefV2;
  profileSnapshotRef: BlobRefV2;
  snapshotHash: string;
  reviewerRoleBinding: string;
  generatorRoleBinding: string;
  orchestratorRoleBinding: string;
  /** optional seams (wired by the composition; tests may inject). */
  adoptionService?: ReviewAdoptionService;
  findingService?: FindingService;
  /** slot presence map (required|optional). Defaults to required for every slot. */
  slotPresenceOf?(slotId: string): SlotPresenceV2;
}

/** A prepared content-review publication payload (the domain_publish envelope). */
export interface ContentReviewPublishInputV2 {
  operationId: string;
  publishKind:
    | 'content_review_assignment_commit'
    | 'content_review_round_completed'
    | 'content_review_round_planned'
    | 'content_review_settlement';
  blobRefs: readonly BlobRefV2[];
  carriers: ContentReviewPublishCarriersV2;
  preparedRefs: readonly BlobRefV2[];
}

/** The in-memory validator blob store (engine-produced objects). */
export class ContentReviewMemoryValidatorBlobStore implements ValidatorBlobStore {
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

export function contentReviewCarrier(carriers: Partial<ContentReviewPublishCarriersV2> = {}): ContentReviewPublishCarriersV2 {
  return {
    assignmentId: null,
    reviewRoundId: null,
    workItemId: null,
    attemptId: null,
    reviewAssignmentId: null,
    source: null,
    ledgerRef: null,
    coverageTargetCount: null,
    findingCount: null,
    observations: null,
    findingOpenings: null,
    coverageCoreRef: null,
    roundPlanned: null,
    reviewWorkItems: null,
    settlementCoreRef: null,
    outcome: null,
    reviewBundleRef: null,
    reviewWarningCustodyRootRef: null,
    mapRef: null,
    contentRevisionManifestRef: null,
    reviewSettlementValidatorAggregateRef: null,
    sealWorkItemId: null,
    sealAuthorityBaseRef: null,
    successor: null,
    terminal: null,
    ...carriers,
  };
}

function need<T>(value: T | null | undefined, name: string): asserts value is T {
  if (value === null || value === undefined) throw new NotRebuildableError('content-review', [name]);
}

function asDomain(payload: { family: string }): Extract<PublicationOperationPayloadV2, { family: 'domain_publish' }> {
  if (payload.family !== 'domain_publish') {
    throw new NotRebuildableError('content-review', [`payload family '${payload.family}' is not domain_publish`]);
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

/** Registers the four Task 18 content-review publication handlers. */
export function registerContentReviewPublicationHandlers(registry: PublicationIntentRegistry): void {
  registerContentReviewAssignmentCommit(registry);
  registerContentReviewRoundCompleted(registry);
  registerContentReviewRoundPlanned(registry);
  registerContentReviewSettlement(registry);
}

function registerContentReviewAssignmentCommit(registry: PublicationIntentRegistry): void {
  if (registry.resolve('content_review_assignment_commit', 1) !== null) return;
  registry.register({
    handlerKind: 'content_review_assignment_commit',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: [
      'structured_review_assignment_started',
      'structured_content_review_assignment_committed',
      'structured_review_assignment_completed',
      'structured_whole_tree_observation_recorded',
      'structured_finding_opened',
    ],
    rebuildable: true,
    missingInputs: [],
    parsePayload: parseDomainPublishPayload,
    childRefsOf: (p) => (p.family === 'domain_publish' ? [...p.blobRefs] : []),
    resolveRefs: (p) => {
      if (p.family !== 'domain_publish') return [];
      const out: PublicationIntentResolvedRef[] = [];
      if (p.contentReview !== null && p.contentReview.ledgerRef !== null) out.push({ key: 'ledger', ref: p.contentReview.ledgerRef });
      return out;
    },
    buildEvents: (payload, at, refs) => {
      const p = asDomain(payload);
      const cr = p.contentReview;
      need(cr, 'contentReview');
      const findingOpenings: PublicationEventEnvelopeV2[] = (cr.findingOpenings ?? []).map((fo) => ({
        protocolVersion: 2,
        at,
        type: 'structured_finding_opened' as const,
        findingId: fo.findingId,
        findingRef: fo.findingRef,
        reviewContext: fo.reviewContext,
        primaryLocation: fo.primaryLocation,
        defectClass: fo.defectClass,
        severity: fo.severity,
        source: fo.source,
        openedBy: fo.openedBy,
      }));
      if (cr.observations !== null && cr.observations.length > 0) {
        // Whole-tree observation: layered observation events (root-first).
        need(cr.reviewRoundId, 'reviewRoundId');
        const observationEvents: PublicationEventEnvelopeV2[] = cr.observations.map((o) => ({
          protocolVersion: 2,
          at,
          type: 'structured_whole_tree_observation_recorded' as const,
          observationId: o.observationId,
          reviewRoundId: cr.reviewRoundId,
          level: o.level,
          parentObservationId: o.parentObservationId,
          observationRef: o.observationRef,
          coveredTargetCount: o.coveredTargetCount,
          childObservationRefs: o.childObservationRefs,
        }));
        return [...findingOpenings, ...observationEvents];
      }
      const ledgerRef = cr.ledgerRef ?? refs?.get('ledger');
      if (ledgerRef === null || ledgerRef === undefined) throw new NotRebuildableError('content_review_assignment_commit', ['ledgerRef']);
      need(cr.assignmentId, 'assignmentId');
      need(cr.reviewRoundId, 'reviewRoundId');
      need(cr.workItemId, 'workItemId');
      need(cr.attemptId, 'attemptId');
      need(cr.source, 'source');
      need(cr.coverageTargetCount, 'coverageTargetCount');
      need(cr.findingCount, 'findingCount');
      return [
        ...findingOpenings,
        {
          protocolVersion: 2,
          at,
          type: 'structured_review_assignment_started',
          assignmentId: cr.assignmentId,
          reviewRoundId: cr.reviewRoundId,
          workItemId: cr.workItemId,
          attemptId: cr.attemptId,
          reviewAssignmentId: cr.reviewAssignmentId,
          source: cr.source,
        },
        {
          protocolVersion: 2,
          at,
          type: 'structured_content_review_assignment_committed',
          assignmentId: cr.assignmentId,
          reviewRoundId: cr.reviewRoundId,
          workItemId: cr.workItemId,
          attemptId: cr.attemptId,
          reviewAssignmentId: cr.reviewAssignmentId,
          source: cr.source,
          ledgerRef: ledgerRef as BlobRefV2,
          coverageTargetCount: cr.coverageTargetCount,
          findingCount: cr.findingCount,
        },
        {
          protocolVersion: 2,
          at,
          type: 'structured_review_assignment_completed',
          assignmentId: cr.assignmentId,
          reviewRoundId: cr.reviewRoundId,
          workItemId: cr.workItemId,
          attemptId: cr.attemptId,
          ledgerRef: ledgerRef as BlobRefV2,
          source: cr.source,
        },
      ];
    },
    expectedResultIdentity: (_payload, events) => sha256Of(events),
  });
}

function registerContentReviewRoundCompleted(registry: PublicationIntentRegistry): void {
  if (registry.resolve('content_review_round_completed', 1) !== null) return;
  registry.register({
    handlerKind: 'content_review_round_completed',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: ['structured_review_round_completed'],
    rebuildable: true,
    missingInputs: [],
    parsePayload: parseDomainPublishPayload,
    childRefsOf: (p) => (p.family === 'domain_publish' ? [...p.blobRefs] : []),
    resolveRefs: (p) => {
      if (p.family !== 'domain_publish') return [];
      const out: PublicationIntentResolvedRef[] = [];
      if (p.contentReview !== null && p.contentReview.coverageCoreRef !== null) out.push({ key: 'coverageCore', ref: p.contentReview.coverageCoreRef });
      return out;
    },
    buildEvents: (payload, at, refs) => {
      const p = asDomain(payload);
      const cr = p.contentReview;
      need(cr, 'contentReview');
      need(cr.reviewRoundId, 'reviewRoundId');
      const coverageCoreRef = cr.coverageCoreRef ?? refs?.get('coverageCore');
      if (coverageCoreRef === null || coverageCoreRef === undefined) throw new NotRebuildableError('content_review_round_completed', ['coverageCoreRef']);
      return [
        {
          protocolVersion: 2,
          at,
          type: 'structured_review_round_completed',
          reviewRoundId: cr.reviewRoundId,
          coverageCoreRef: coverageCoreRef as BlobRefV2,
        },
      ];
    },
    expectedResultIdentity: (_payload, events) => sha256Of(events),
  });
}

function registerContentReviewRoundPlanned(registry: PublicationIntentRegistry): void {
  if (registry.resolve('content_review_round_planned', 1) !== null) return;
  registry.register({
    handlerKind: 'content_review_round_planned',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: ['structured_review_round_planned', 'structured_work_item_created'],
    rebuildable: true,
    missingInputs: [],
    parsePayload: parseDomainPublishPayload,
    childRefsOf: (p) => (p.family === 'domain_publish' ? [...p.blobRefs] : []),
    resolveRefs: (p) => {
      if (p.family !== 'domain_publish') return [];
      const out: PublicationIntentResolvedRef[] = [];
      const cr = p.contentReview;
      if (cr !== null && cr.roundPlanned !== null) out.push({ key: 'adoptionRoot', ref: cr.roundPlanned.adoptionRootRef });
      return out;
    },
    buildEvents: (payload, at, refs) => {
      const p = asDomain(payload);
      const cr = p.contentReview;
      need(cr, 'contentReview');
      const rr = cr.roundPlanned;
      if (rr === null) throw new NotRebuildableError('content_review_round_planned', ['roundPlanned']);
      const envelopes: PublicationEventEnvelopeV2[] = [
        {
          protocolVersion: 2,
          at,
          type: 'structured_review_round_planned',
          reviewRoundId: rr.reviewRoundId,
          contentCycleOrdinal: rr.contentCycleOrdinal,
          mapRef: rr.mapRef,
          mapSemanticDigest: rr.mapSemanticDigest,
          contentRevisionManifestRef: rr.contentRevisionManifestRef,
          reviewPolicyDigest: rr.reviewPolicyDigest,
          adoptionRootRef: rr.adoptionRootRef,
          coverageSlotCount: rr.coverageSlotCount,
          coverageRelationCount: rr.coverageRelationCount,
          assignmentCount: rr.assignmentCount,
          verificationFindingCount: rr.verificationFindingCount,
          consumedOverrideRef: rr.consumedOverrideRef,
        },
      ];
      if (cr.reviewWorkItems !== null) {
        for (const s of cr.reviewWorkItems) {
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
      }
      return envelopes;
    },
    expectedResultIdentity: (_payload, events) => sha256Of(events),
  });
}

function registerContentReviewSettlement(registry: PublicationIntentRegistry): void {
  if (registry.resolve('content_review_settlement', 1) !== null) return;
  registry.register({
    handlerKind: 'content_review_settlement',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: [
      'structured_review_round_settled',
      'structured_work_item_created',
      'structured_system_command_completed',
      'structured_work_item_completed',
    ],
    rebuildable: true,
    missingInputs: [],
    parsePayload: parseDomainPublishPayload,
    childRefsOf: (p) => (p.family === 'domain_publish' ? [...p.blobRefs] : []),
    resolveRefs: (p) => {
      if (p.family !== 'domain_publish') return [];
      const out: PublicationIntentResolvedRef[] = [];
      const cr = p.contentReview;
      if (cr !== null) {
        if (cr.reviewBundleRef !== null) out.push({ key: 'reviewBundle', ref: cr.reviewBundleRef });
        if (cr.contentRevisionManifestRef !== null) out.push({ key: 'manifest', ref: cr.contentRevisionManifestRef });
      }
      return out;
    },
    buildEvents: (payload, at, refs) => {
      const p = asDomain(payload);
      const cr = p.contentReview;
      need(cr, 'contentReview');
      need(cr.reviewRoundId, 'reviewRoundId');
      need(cr.settlementCoreRef, 'settlementCoreRef');
      need(cr.outcome, 'outcome');
      need(cr.terminal, 'terminal');
      const t = cr.terminal;
      const envelopes: PublicationEventEnvelopeV2[] = [
        {
          protocolVersion: 2,
          at,
          type: 'structured_review_round_settled',
          reviewRoundId: cr.reviewRoundId,
          settlementCoreRef: cr.settlementCoreRef,
          outcome: cr.outcome,
        },
      ];
      if (cr.outcome === 'seal') {
        need(cr.reviewBundleRef, 'reviewBundleRef');
        need(cr.mapRef, 'mapRef');
        need(cr.contentRevisionManifestRef, 'contentRevisionManifestRef');
        need(cr.sealAuthorityBaseRef, 'sealAuthorityBaseRef');
        // System Seal WorkItem (the `system_seal_input` seam — Task 21 handler).
        envelopes.push({
          protocolVersion: 2,
          at,
          type: 'structured_work_item_created',
          workItemId: cr.sealWorkItemId ?? `wi-seal-${canonicalJsonSha256({ reviewRoundId: cr.reviewRoundId }).slice(0, 24)}`,
          kind: 'system_seal',
          roleBinding: null,
          agentExecutionKind: null,
          sessionKind: null,
          roundId: null,
          logicalAssignmentId: null,
          reviewAssignmentId: null,
          grantSpecRef: null,
          inputArtifactDeliveryId: null,
          authorityBaseRef: cr.sealAuthorityBaseRef,
          payloadRef: cr.reviewBundleRef,
          initialLeaseEpoch: 0,
          maxAutomaticRetries: 0,
        });
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

export class ContentReviewError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContentReviewError';
    this.code = code;
  }
}

/** Over-limit round creation (spec §13.3.1): caller terminal-fails the task. */
export class ReviewRepairLimitExceededError extends ContentReviewError {
  constructor(roundId: string, nextOrdinal: number, maxRounds: number) {
    super('REVIEW_REPAIR_LIMIT_EXCEEDED', `content cycle budget exhausted: nextOrdinal=${nextOrdinal} > maxRounds=${maxRounds} for round '${roundId}'`);
  }
}

export class ContentReviewService {
  private readonly deps: ContentReviewServiceDependencies;

  constructor(deps: ContentReviewServiceDependencies) {
    this.deps = deps;
  }

  /* ------------------------- presence-aware coverage --------------- */

  /**
   * The presence-aware coverage facts of the current finalized manifest
   * (design §11.6 / spec §13.2 step 5): set required/optional slots need a
   * reviewer fact; optional-unset gets the system `absent_not_applicable` fact;
   * required-unset/rewrite_required makes the round UNPLANABLE.
   */
  async computePresenceFacts(taskId: string, manifest: ContentRevisionManifestV2): Promise<PresenceCoverageResultV2> {
    const slotPresence: Record<string, SlotPresenceV2> = {};
    for (const entry of manifest.entries) {
      slotPresence[entry.slotId] = this.deps.slotPresenceOf ? this.deps.slotPresenceOf(entry.slotId) : 'required';
    }
    return computePresenceCoverage(manifest, slotPresence, (slotId, versionRef) => {
      // Sync-resolve only for the synchronous pure domain; the async manifest
      // resolution happens in the caller. This seam keeps the pure function
      // reuse honest for the test-facing pure builder path.
      return this.resolveVersionSync(slotId, versionRef);
    });
  }

  private resolveVersionSync(slotId: string, versionRef: BlobRefV2): SlotContentVersionV2 | null {
    // The pure `computePresenceCoverage` needs a resolver; the async service
    // provides `resolvedVersionsOf` which the callers pre-populate. The sync
    // seam never resolves (returns null) so callers MUST pre-resolve and pass
    // the version map — fail-closed (design §11.6: cannot prove state -> no plan).
    void slotId;
    void versionRef;
    return null;
  }

  /** Resolves every manifest entry's version state (set/unset/rewrite_required). */
  async resolvedVersionsOf(taskId: string, manifest: ContentRevisionManifestV2): Promise<Map<string, SlotContentVersionV2>> {
    const out = new Map<string, SlotContentVersionV2>();
    for (const entry of manifest.entries) {
      const version = (await this.deps.resolver(taskId, entry.versionRef)) as SlotContentVersionV2 | null;
      if (version !== null && typeof version === 'object' && typeof version.state === 'string') {
        out.set(entry.slotId, version);
      }
    }
    return out;
  }

  /** The presence-aware coverage facts + set-slot list (round planning helper). */
  async computeRoundCoverage(taskId: string, manifestRef: BlobRefV2): Promise<{
    planable: boolean;
    unplanableReasons: string[];
    facts: import('../../authoritative-review/authority-types').ContentSlotCoverageFactV2[];
    setSlotIds: string[];
    versions: Map<string, SlotContentVersionV2>;
  }> {
    const manifest = (await this.deps.resolver(taskId, manifestRef)) as ContentRevisionManifestV2 | null;
    if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.entries)) {
      throw new ContentReviewError('MANIFEST_UNRESOLVED', `finalized content manifest '${manifestRef.digest.slice(0, 12)}…' is unresolvable`);
    }
    const versions = await this.resolvedVersionsOf(taskId, manifest);
    const withVersion: ContentRevisionManifestV2 = {
      ...manifest,
      entries: manifest.entries,
    };
    void withVersion;
    // computePresenceCoverage with an async-safe resolver: pre-resolve every
    // version so the pure function sees each state.
    const slotPresence: Record<string, SlotPresenceV2> = {};
    for (const entry of manifest.entries) {
      slotPresence[entry.slotId] = this.deps.slotPresenceOf ? this.deps.slotPresenceOf(entry.slotId) : 'required';
    }
    const presence = computePresenceCoverage(manifest, slotPresence, (slotId, versionRef) => {
      const v = versions.get(slotId);
      if (v !== undefined && refOfBlob('content_version', v).digest === versionRef.digest) return v;
      return null;
    });
    const setSlotIds = [...versions.entries()]
      .filter(([, v]) => v.state === 'set')
      .map(([slotId]) => slotId)
      .sort();
    // Absence facts must bind the CURRENT version/presence policy (design §11.6).
    for (const fact of presence.facts) {
      if (fact.disposition === 'absent_not_applicable') {
        const version = versions.get(fact.slotId);
        if (version !== undefined) {
          assertAbsenceFactCurrent(fact, {
            slotId: fact.slotId,
            contentVersionRef: fact.contentVersionRef,
            presencePolicyDigest: fact.presencePolicyDigest,
          });
        }
      }
    }
    return { planable: presence.planable, unplanableReasons: presence.unplanableReasons, facts: presence.facts, setSlotIds, versions };
  }

  /** The content relation coverage targets (blocking always; advisory only when
   * `reviewAdvisoryRelations=true`) from the ACTIVE Map snapshot. */
  async contentRelationTargetsOf(taskId: string): Promise<string[]> {
    const state = await this.deps.readProjection(taskId);
    if (state.currentMap === null) return [];
    const snapshot = (await this.deps.resolver(taskId, state.currentMap.mapSnapshotRef)) as { relations?: readonly MapRelationV2[] } | null;
    if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.relations)) return [];
    return selectContentRelationTargets(snapshot.relations, this.deps.reviewPolicy.reviewAdvisoryRelations === true);
  }

  /* ------------------------- Task 13 freeze seam ------------------ */

  /** The Task 13 `resolveAssignmentTargets` seam: the ASSIGNMENT-scoped
   * ordinary target set of a content review workitem — recomputed
   * deterministically from the finalized manifest + the round-planned
   * assignmentCount, matched by the reviewAssignmentId. Whole-tree
   * observations carry no ordinary verdicts ([]). */
  async resolveAssignmentTargets(ctx: import('./attempt-coordinator').V2AttemptContext): Promise<readonly string[] | null> {
    const state = await this.deps.readProjection(ctx.taskId);
    const wi = state.workItems[ctx.workItemId];
    if (wi === undefined || wi.roundId === null || wi.reviewAssignmentId === null) return null;
    if (wi.sessionKind === 'review_content_whole') return [];
    const roundId = wi.roundId;
    const events = await this.deps.readEvents(ctx.taskId);
    const planned = events.find(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_review_round_planned' }> =>
        e.type === 'structured_review_round_planned' && e.reviewRoundId === roundId,
    );
    if (planned === undefined) return null;
    const coverage = await this.computeRoundCoverage(ctx.taskId, planned.contentRevisionManifestRef);
    if (!coverage.planable) return null;
    const mapState = await this.deps.readProjection(ctx.taskId);
    const relations = await this.resolveActiveRelations(ctx.taskId, mapState);
    const plan = planContentReview({
      slots: await this.setSlotsWithOrder(ctx.taskId, coverage.setSlotIds),
      relations,
      reviewPolicy: this.deps.reviewPolicy,
      assignmentCount: planned.assignmentCount,
    });
    for (let index = 0; index < plan.batches.length; index++) {
      if (reviewAssignmentIdOf(roundId, index) === wi.reviewAssignmentId) {
        const batch = plan.batches[index];
        return [...batch.slotIds, ...batch.relationIds];
      }
    }
    return null;
  }

  private async setSlotsWithOrder(taskId: string, setSlotIds: readonly string[]): Promise<{ slotId: string; documentOrder: number; parentSlotId: string | null }[]> {
    const state = await this.deps.readProjection(taskId);
    if (state.currentMap === null) return setSlotIds.map((slotId) => ({ slotId, documentOrder: 0, parentSlotId: null }));
    const snapshot = (await this.deps.resolver(taskId, state.currentMap.mapSnapshotRef)) as { nodes?: readonly { slotId: string; documentOrder: number; parentSlotId: string | null }[] } | null;
    const byId = new Map<string, { slotId: string; documentOrder: number; parentSlotId: string | null }>();
    if (snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.nodes)) {
      for (const n of snapshot.nodes) byId.set(n.slotId, n);
    }
    const out: { slotId: string; documentOrder: number; parentSlotId: string | null }[] = [];
    for (const slotId of setSlotIds) {
      const n = byId.get(slotId);
      out.push(n ?? { slotId, documentOrder: 0, parentSlotId: null });
    }
    return out;
  }

  private async resolveActiveRelations(taskId: string, state: AuthoritativeReviewProjectionV2): Promise<MapRelationV2[]> {
    if (state.currentMap === null) return [];
    const snapshot = (await this.deps.resolver(taskId, state.currentMap.mapSnapshotRef)) as { relations?: readonly MapRelationV2[] } | null;
    if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.relations)) return [];
    return snapshot.relations as MapRelationV2[];
  }

  /** The §16.1 six-condition settlement gate over the round's committed facts,
   * verification records, observations, and findings (F2: enforced BEFORE the
   * validator runs so a stub review_settlement validator can never mask a
   * blocking reject/violated fact). */
  private async evaluateSettlementGate(
    taskId: string,
    roundId: string,
    plannedEvent: Extract<AuthoritativeReviewEventV2, { type: 'structured_review_round_planned' }>,
    coverage: { setSlotIds: string[]; facts: readonly import('../../authoritative-review/authority-types').ContentSlotCoverageFactV2[] },
    plan: ContentReviewPlanV2,
    findings: readonly import('./finding-service').ProjectedFindingLifecycleV2[],
  ): Promise<{ complete: boolean; unmet: string[] }> {
    const events = await this.deps.readEvents(taskId);
    // Committed slot/relation verdicts + verification records from the round's
    // assignment ledgers (design §11.6/§11.7/§11.9).
    const slotVerdicts = new Map<string, 'pass' | 'reject'>();
    const relationVerdicts = new Map<string, 'satisfied' | 'violated'>();
    const verificationRecords = new Map<string, unknown>();
    const ledgerEvents = events.filter(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_content_review_assignment_committed' }> =>
        e.type === 'structured_content_review_assignment_committed' && e.reviewRoundId === roundId,
    );
    for (const event of ledgerEvents) {
      const ledger = (await this.deps.resolver(taskId, event.ledgerRef)) as {
        factRefs?: readonly BlobRefV2[];
        verificationRecordRefs?: readonly BlobRefV2[];
      } | null;
      if (ledger === null || typeof ledger !== 'object') continue;
      for (const factRef of ledger.factRefs ?? []) {
        const fact = (await this.deps.resolver(taskId, factRef)) as {
          targetKind?: string;
          targetStableId?: string;
          verdict?: string;
        } | null;
        if (fact === null || typeof fact !== 'object') continue;
        if (fact.targetKind === 'content_slot' && typeof fact.targetStableId === 'string') {
          slotVerdicts.set(fact.targetStableId, fact.verdict === 'reject' ? 'reject' : 'pass');
        } else if (fact.targetKind === 'content_relation' && typeof fact.targetStableId === 'string') {
          relationVerdicts.set(fact.targetStableId, fact.verdict === 'violated' ? 'violated' : 'satisfied');
        }
      }
      for (const recordRef of ledger.verificationRecordRefs ?? []) {
        const record = (await this.deps.resolver(taskId, recordRef)) as { findingId?: string; repairStage?: string } | null;
        if (record === null || typeof record !== 'object' || typeof record.findingId !== 'string' || typeof record.repairStage !== 'string') continue;
        verificationRecords.set(`${record.findingId}:${record.repairStage}`, record);
      }
    }
    // The presence-aware coverage facts mapped to the committed verdicts.
    const resolvedCoreSlotFacts: (import('../../authoritative-review/authority-types').ContentSlotCoverageFactV2 | { disposition: 'reviewed'; slotId: string; verdict: 'pass' | 'reject' })[] = coverage.facts.map((f) => {
      if (f.disposition === 'absent_not_applicable') return f;
      return { disposition: 'reviewed', slotId: f.slotId, verdict: slotVerdicts.get(f.slotId) ?? 'reject' };
    });
    const verificationTargets = verificationStagesOf(findings);
    // Assignment + observation completeness (the round-completed gate already
    // demanded these; recompute for the settlement boundary).
    const completedAssignments = events.filter(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_review_assignment_completed' }> =>
        e.type === 'structured_review_assignment_completed' && e.reviewRoundId === roundId,
    );
    const assignmentComplete = completedAssignments.length >= plannedEvent.assignmentCount;
    const observations = events.filter(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_whole_tree_observation_recorded' }> =>
        e.type === 'structured_whole_tree_observation_recorded' && e.reviewRoundId === roundId,
    );
    const wholeTreeObservationBoundToBaseline = observations.some((o) => o.parentObservationId === null && o.level === 1);
    const coverageSlotIds = [...coverage.setSlotIds, ...coverage.facts.filter((f) => f.disposition === 'absent_not_applicable').map((f) => f.slotId)];
    return settleContentRoundCoverage({
      reviewRoundId: roundId,
      coverageSlotIds,
      coverageRelationIds: plan.relationTargets,
      resolvedCoreSlotFacts,
      blockingRelationVerdicts: relationVerdicts,
      verificationTargets,
      currentVerificationRecords: verificationRecords,
      assignmentComplete,
      wholeTreeObservationBoundToBaseline,
      findings: findings.map((f) => ({ severity: f.severity, status: f.status })),
      reviewPolicyDigestBound: true,
    });
  }

  /** The Task 13 `freezeReviewAssignment` seam: publishes the assignment ledger
   * + the started/committed/completed events (batch) OR the layered
   * `structured_whole_tree_observation_recorded` events (whole observation)
   * atomically. */
  async freezeReviewAssignment(taskId: string, freeze: import('./tool-factory').FrozenReviewAssignmentV2): Promise<{ ledgerRef: BlobRefV2; eventId: string }> {
    const state = await this.deps.readProjection(taskId);
    const wi = state.workItems[freeze.ledger.workItemId];
    const sessionKind = wi?.sessionKind ?? null;
    const isWhole = sessionKind === 'review_content_whole';

    const refs: BlobRefV2[] = [];
    for (const ref of [...freeze.factRefs, ...freeze.verificationRecordRefs, ...freeze.findingDraftRefs]) {
      const value = this.findPreparedBlob(freeze, ref);
      if (value !== undefined) await this.deps.facade.prepareBlob(taskId, ref.kind, value);
    }
    const ledgerRef = await this.deps.facade.prepareBlob(taskId, 'review_assignment_ledger', freeze.ledger);
    const blobRefs = [...freeze.factRefs, ...freeze.verificationRecordRefs, ...freeze.findingDraftRefs, ledgerRef];
    const findingOpenings = this.findingOpeningCarriersOf(freeze);

    if (isWhole) {
      const observations = await this.buildWholeTreeObservationEvents(taskId, freeze.ledger, ledgerRef);
      await this.publish(taskId, {
        operationId: deterministicContentFreezeOperationId(taskId, freeze.ledger.workItemId),
        publishKind: 'content_review_assignment_commit',
        blobRefs,
        carriers: contentReviewCarrier({
          reviewRoundId: freeze.ledger.roundId,
          workItemId: freeze.ledger.workItemId,
          observations,
          findingOpenings,
        }),
        preparedRefs: blobRefs,
      });
      return { ledgerRef, eventId: deterministicContentEventIdOf(taskId, freeze.ledger.workItemId) };
    }

    await this.publish(taskId, {
      operationId: deterministicContentFreezeOperationId(taskId, freeze.ledger.workItemId),
      publishKind: 'content_review_assignment_commit',
      blobRefs,
      carriers: contentReviewCarrier({
        assignmentId: freeze.ledger.assignmentId,
        reviewRoundId: freeze.ledger.roundId,
        workItemId: freeze.ledger.workItemId,
        attemptId: this.attemptIdOf(state, freeze.ledger.workItemId),
        reviewAssignmentId: freeze.ledger.reviewAssignmentId,
        source: 'batch',
        ledgerRef,
        coverageTargetCount: freeze.ledger.coverageTargetIds.length,
        findingCount: freeze.findingDraftRefs.length,
        findingOpenings,
      }),
      preparedRefs: blobRefs,
    });
    return { ledgerRef, eventId: deterministicContentEventIdOf(taskId, freeze.ledger.workItemId) };
  }

  /** `structured_finding_opened` carriers for every materialized finding draft
   * (design §11.8: the opening payload is an append-only fact). */
  private findingOpeningCarriersOf(freeze: import('./tool-factory').FrozenReviewAssignmentV2): readonly ContentReviewFindingOpeningCarrierV2[] | null {
    if (freeze.findings.length === 0) return null;
    return freeze.findings
      .map((f) => ({
        findingId: f.findingId,
        findingRef: refOfBlob('finding', f),
        reviewContext: f.reviewContext,
        primaryLocation: f.primaryLocation,
        defectClass: f.defectClass,
        severity: f.severity,
        source: f.source,
        openedBy: f.openedBy,
      }))
      .sort((a, b) => (a.findingId < b.findingId ? -1 : 1));
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

  private async buildWholeTreeObservationEvents(
    taskId: string,
    ledger: AssignmentLedgerBlobV2,
    ledgerRef: BlobRefV2,
  ): Promise<ContentReviewObservationCarrierV2[] | null> {
    const state = await this.deps.readProjection(taskId);
    const roundId = ledger.roundId;
    const planned = state.contentRounds[roundId];
    if (planned === undefined) return null;
    const events = await this.deps.readEvents(taskId);
    const plannedEvent = events.find(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_review_round_planned' }> =>
        e.type === 'structured_review_round_planned' && e.reviewRoundId === roundId,
    );
    if (plannedEvent === undefined) return null;
    const coverage = await this.computeRoundCoverage(taskId, plannedEvent.contentRevisionManifestRef);
    if (!coverage.planable) return null;
    const relations = await this.resolveActiveRelations(taskId, state);
    const plan = planContentReview({
      slots: await this.setSlotsWithOrder(taskId, coverage.setSlotIds),
      relations,
      reviewPolicy: this.deps.reviewPolicy,
      assignmentCount: plannedEvent.assignmentCount,
    });
    // Event-level convention is ROOT-FIRST: level 1 = root (no parent).
    const totalLevels = plan.observationLevels.length;
    const parentOf = new Map<string, string>();
    for (const level of plan.observationLevels) {
      for (const o of level.observations) {
        for (const child of o.childObservationScopeIds) parentOf.set(child, o.observationScopeId);
      }
    }
    const carriers: ContentReviewObservationCarrierV2[] = [];
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

  /** When every batch assignment is completed AND the whole-tree observation
   * closure is recorded, builds the FINAL coverage core (real ledger/adoption/
   * observation/finding-stage roots), publishes `structured_review_round_completed`,
   * and creates the content settlement WorkItem. */
  async maybeCompleteRound(taskId: string, roundId: string): Promise<boolean> {
    const state = await this.deps.readProjection(taskId);
    const planned = state.contentRounds[roundId];
    if (planned === undefined || planned.state === 'completed' || planned.state === 'settled') return false;
    const events = await this.deps.readEvents(taskId);
    const completed = new Set(
      events
        .filter(
          (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_review_assignment_completed' }> =>
            e.type === 'structured_review_assignment_completed' && e.reviewRoundId === roundId,
        )
        .map((e) => e.assignmentId),
    );
    if (completed.size !== planned.assignmentCount) return false;
    // Whole-tree observation closure (root level 1; every non-root has its
    // parent at the exact level below).
    const recorded = events.filter(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_whole_tree_observation_recorded' }> =>
        e.type === 'structured_whole_tree_observation_recorded' && e.reviewRoundId === roundId,
    );
    const roots = recorded.filter((e) => e.parentObservationId === null);
    if (roots.length !== 1 || roots[0].level !== 1) return false;
    const levelOf = new Map<string, number>();
    for (const e of recorded) levelOf.set(e.observationId, e.level);
    for (const e of recorded) {
      if (e.level > 1) {
        const parentLevel = e.parentObservationId === null ? undefined : levelOf.get(e.parentObservationId);
        if (parentLevel === undefined || parentLevel !== e.level - 1) return false;
      }
    }
    const plannedEvent = events.find(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_review_round_planned' }> =>
        e.type === 'structured_review_round_planned' && e.reviewRoundId === roundId,
    );
    if (plannedEvent === undefined) return false;
    const coverage = await this.computeRoundCoverage(taskId, plannedEvent.contentRevisionManifestRef);
    if (!coverage.planable) return false;
    const relations = await this.resolveActiveRelations(taskId, state);
    const plan = planContentReview({
      slots: await this.setSlotsWithOrder(taskId, coverage.setSlotIds),
      relations,
      reviewPolicy: this.deps.reviewPolicy,
      assignmentCount: plannedEvent.assignmentCount,
    });
    // Leaf-observation union must cover every set slot (design §12.6).
    const totalLevels = plan.observationLevels.length;
    const leafObservations = plan.observationLevels.filter((level) => level.level === 1);
    const leafCovered = new Set(leafObservations.flatMap((level) => level.observations.flatMap((o) => o.coverageSlotIds)));
    if (coverage.setSlotIds.length > 0) {
      for (const slotId of coverage.setSlotIds) {
        if (!leafCovered.has(slotId)) return false;
      }
    }
    const recordedIds = new Set(recorded.map((e) => e.observationId));
    if (leafObservations.length > 0 && leafObservations.some((level) => level.observations.some((o) => !recordedIds.has(o.observationScopeId)))) {
      return false;
    }
    void totalLevels;

    // FINAL coverage core: real ledger/observation/adoption/finding-stage roots.
    const assignmentEvents = events.filter(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_content_review_assignment_committed' }> =>
        e.type === 'structured_content_review_assignment_committed' && e.reviewRoundId === roundId,
    );
    const coverageLedgerRootRefs = assignmentEvents.map((e) => e.ledgerRef);
    const wholeTreeObservationRootRefs = recorded.map((e) => e.observationRef);
    const findingStageRoot = this.deps.findingService
      ? await this.deps.findingService.prepareFindingStageRoot(taskId, roundId)
      : { rootRef: await this.deps.facade.prepareBlob(taskId, 'finding_stage_root', buildFindingStageRoot(roundId, [])) };
    let adoptionRootRef = plannedEvent.adoptionRootRef;
    if (this.deps.adoptionService !== undefined) {
      const adopted = await this.deps.adoptionService.computeAdoptionRoot({
        taskId,
        roundId,
        coverageTargetIds: [...coverage.setSlotIds, ...coverage.facts.filter((f) => f.disposition === 'absent_not_applicable').map((f) => f.slotId), ...plan.relationTargets],
        assignmentTargetIds: plan.batches.flatMap((b) => [...b.slotIds, ...b.relationIds]),
        currentContextStableId: state.currentMap?.mapId ?? '',
        baseline: {
          reviewPolicyDigest: this.deps.reviewPolicyDigest,
          subjectDigestOf: () => canonicalJsonSha256({ baseline: 'current', mapRef: plannedEvent.mapRef.digest }),
          contextDigestOf: () => canonicalJsonSha256({ baseline: 'current' }),
        },
      });
      adoptionRootRef = adopted.rootRef;
    }
    const finalCore = buildContentReviewCoverageCore({
      reviewRoundId: roundId,
      mapRef: plannedEvent.mapRef,
      contentRevisionManifestRef: plannedEvent.contentRevisionManifestRef,
      reviewPolicyDigest: plannedEvent.reviewPolicyDigest,
      coverageLedgerRootRefs,
      adoptionRootRef,
      wholeTreeObservationRootRefs,
      findingStageRootRef: findingStageRoot.rootRef,
    });
    const coverageCoreRef = await this.deps.facade.prepareBlob(taskId, 'content_review_coverage_core', finalCore);
    await this.publish(taskId, {
      operationId: deterministicContentRoundCompletedOperationId(taskId, roundId),
      publishKind: 'content_review_round_completed',
      blobRefs: [coverageCoreRef, findingStageRoot.rootRef],
      carriers: contentReviewCarrier({ reviewRoundId: roundId, coverageCoreRef }),
      preparedRefs: [coverageCoreRef, findingStageRoot.rootRef],
    });

    // Create the content settlement WorkItem (the ONLY content activator).
    const settlementWorkItemId = deterministicContentSettlementWorkItemId(taskId, roundId);
    const plannedCore = await this.plannedCoverageCoreOf(taskId, roundId, plannedEvent);
    const plannedCoreRef = await this.deps.facade.prepareBlob(taskId, 'content_review_coverage_core', plannedCore);
    const base2 = buildAuthorityBaseSet({
      taskId,
      templateSnapshotRef: this.deps.templateSnapshotRef,
      profileSnapshotRef: this.deps.profileSnapshotRef,
      refs: {
        mapRef: plannedEvent.mapRef,
        contentRevisionManifestRef: plannedEvent.contentRevisionManifestRef,
        reviewCoverageCoreRef: coverageCoreRef,
        reviewRoundRef: plannedCoreRef,
      },
      kind: 'system_review_settlement',
    });
    const maxAutomaticRetries = this.deps.profile.maxConsecutiveAttemptsWithoutProgress;
    await this.deps.reviewCoordinator.createContentSettlementWorkItem({
      taskId,
      workItemId: settlementWorkItemId,
      authorityBase: base2,
      coverageCore: finalCore,
      maxAutomaticRetries,
    });
    return true;
  }

  /** The deterministic PLANNED coverage core of a round (the workitem matrix's
   * reviewRoundRef; empty ledger roots — Task 17's carrier shape). The empty
   * finding_stage_root is PREPARED here so the planned core's ref always has
   * bytes on disk (GC walks the child ref; Task 18 F1) — byte-identical to the
   * round-completion root when no findings exist. */
  private async plannedCoverageCoreOf(
    taskId: string,
    roundId: string,
    plannedEvent: Extract<AuthoritativeReviewEventV2, { type: 'structured_review_round_planned' }>,
  ): Promise<ContentReviewCoverageCoreV2> {
    const plannedFindingStageRootRef = await this.deps.facade.prepareBlob(
      taskId,
      'finding_stage_root',
      buildFindingStageRoot(roundId, []),
    );
    const body = {
      reviewRoundId: roundId,
      mapRef: plannedEvent.mapRef,
      contentRevisionManifestRef: plannedEvent.contentRevisionManifestRef,
      reviewPolicyDigest: plannedEvent.reviewPolicyDigest,
      coverageLedgerRootRefs: [] as readonly BlobRefV2[],
      adoptionRootRef: plannedEvent.adoptionRootRef,
      wholeTreeObservationRootRefs: [] as readonly BlobRefV2[],
      findingStageRootRef: plannedFindingStageRootRef,
    };
    return { ...body, coreDigest: canonicalJsonSha256(body) };
  }

  /* ------------------------- cycle-budget round creation ---------- */

  /**
   * The §13.3.1 content-cycle boundary: atomically creates a NEW complete
   * ContentReviewRound (round-planned event + coverage core + review WorkItems)
   * and increments contentCycleOrdinal exactly once. `nextOrdinal > maxRounds`
   * requires an EXACT available Content `RoundBudgetOverrideV2` (consumed
   * exactly once, carried as consumedOverrideRef); without it, throws
   * `ReviewRepairLimitExceededError` and publishes NOTHING (the caller
   * terminal-fails the task with `REVIEW_REPAIR_LIMIT_EXCEEDED`).
   */
  async planContentReviewRound(input: {
    taskId: string;
    finalizedManifestRef: BlobRefV2;
    setSlotIds: readonly string[];
    /** exact available content override to consume (null for normal rounds). */
    overrideRef: BlobRefV2 | null;
  }): Promise<{
    created: boolean;
    round: ContentReviewRoundPlanCarrierV2 | null;
    reviewWorkItems: readonly SuccessorWorkItemCarrierV2[] | null;
    preparedRefs: readonly BlobRefV2[];
  }> {
    const { taskId, finalizedManifestRef, setSlotIds, overrideRef } = input;
    const state = await this.deps.readProjection(taskId);
    const nextOrdinal = state.contentCycleOrdinal + 1;
    // §13.3.1: the sole place contentCycleOrdinal increments; the budget check
    // is pure (extracted for direct tests).
    contentRoundBudgetCheck({
      nextOrdinal,
      maxRounds: this.deps.reviewPolicy.maxRounds,
      availableOverride: state.availableOverride,
      overrideRef,
    });
    // F5: a required-unset/rewrite_required manifest can never complete a round
    // — reject BEFORE preparing any blob (zero writes, no cycle ordinal burned).
    const presence = await this.computeRoundCoverage(taskId, finalizedManifestRef);
    if (!presence.planable) {
      throw new ContentReviewError('CONTENT_ROUND_UNPLANABLE', `content round cannot be planned: ${presence.unplanableReasons.join('; ')}`);
    }
    const prepared = await this.prepareContentReviewRoundPlanning(taskId, finalizedManifestRef, setSlotIds, nextOrdinal, overrideRef);
    await this.publish(taskId, {
      operationId: deterministicContentRoundPlannedOperationId(taskId, prepared.round.reviewRoundId),
      publishKind: 'content_review_round_planned',
      blobRefs: prepared.preparedRefs,
      carriers: contentReviewCarrier({
        reviewRoundId: prepared.round.reviewRoundId,
        roundPlanned: prepared.round,
        reviewWorkItems: prepared.reviewWorkItems,
      }),
      preparedRefs: prepared.preparedRefs,
    });
    return { created: true, round: prepared.round, reviewWorkItems: prepared.reviewWorkItems, preparedRefs: prepared.preparedRefs };
  }

  private async prepareContentReviewRoundPlanning(
    taskId: string,
    finalizedManifestRef: BlobRefV2,
    setSlotIds: readonly string[],
    contentCycleOrdinal: number,
    consumedOverrideRef: BlobRefV2 | null,
  ): Promise<{
    round: ContentReviewRoundPlanCarrierV2;
    adoptionRootRef: BlobRefV2;
    coverageCoreRef: BlobRefV2;
    reviewWorkItems: readonly SuccessorWorkItemCarrierV2[];
    preparedRefs: readonly BlobRefV2[];
  }> {
    const roundId = contentReviewRoundId(taskId, contentCycleOrdinal, finalizedManifestRef);
    const coverageSlotCount = setSlotIds.length;
    const batchSize = Math.max(1, this.deps.reviewPolicy.contentBatchTargetSlots);
    const assignmentCount = Math.max(1, Math.ceil(coverageSlotCount / batchSize));
    const adoptionRoot = buildEmptyAdoptionRoot(roundId);
    const adoptionRootRef = await this.deps.facade.prepareBlob(taskId, 'review_adoption_root', adoptionRoot);
    const mapRef = await this.readCurrentMapRef(taskId);
    if (mapRef === null) throw new ContentReviewError('NO_ACTIVE_MAP', 'a content review round requires an active Map');
    const state = await this.deps.readProjection(taskId);
    const mapSemanticDigest = state.currentMap === null ? '' : state.currentMap.mapSemanticDigest;
    const round: ContentReviewRoundPlanCarrierV2 = {
      reviewRoundId: roundId,
      contentCycleOrdinal,
      mapRef,
      mapSemanticDigest,
      contentRevisionManifestRef: finalizedManifestRef,
      reviewPolicyDigest: this.deps.reviewPolicyDigest,
      adoptionRootRef,
      coverageSlotCount,
      coverageRelationCount: 0,
      assignmentCount,
      verificationFindingCount: 0,
      consumedOverrideRef,
    };
    const plannedFindingStageRootRef = await this.deps.facade.prepareBlob(
      taskId,
      'finding_stage_root',
      buildFindingStageRoot(roundId, []),
    );
    const plannedCore = buildContentReviewCoverageCore({
      reviewRoundId: roundId,
      mapRef,
      contentRevisionManifestRef: finalizedManifestRef,
      reviewPolicyDigest: this.deps.reviewPolicyDigest,
      coverageLedgerRootRefs: [],
      adoptionRootRef,
      wholeTreeObservationRootRefs: [],
      findingStageRootRef: plannedFindingStageRootRef,
    });
    const coverageCoreRef = await this.deps.facade.prepareBlob(taskId, 'content_review_coverage_core', plannedCore);
    const preparedRefs: BlobRefV2[] = [adoptionRootRef, coverageCoreRef, plannedFindingStageRootRef];
    const reviewWorkItems: SuccessorWorkItemCarrierV2[] = [];
    const maxAutomaticRetries = this.deps.profile.maxConsecutiveAttemptsWithoutProgress;
    for (let index = 0; index < assignmentCount; index++) {
      const workItemId = reviewBatchWorkItemId(roundId, index);
      const reviewAssignmentId = reviewAssignmentIdOf(roundId, index);
      const authorityBase = buildAuthorityBaseSet({
        taskId,
        templateSnapshotRef: this.deps.templateSnapshotRef,
        profileSnapshotRef: this.deps.profileSnapshotRef,
        refs: { mapRef, contentRevisionManifestRef: finalizedManifestRef, reviewCoverageCoreRef: coverageCoreRef, reviewRoundRef: coverageCoreRef },
        kind: 'agent_assignment',
        agentExecutionKind: 'structured_session',
        sessionKind: 'review_content_batch',
      });
      const authorityBaseRef = await this.deps.facade.prepareBlob(taskId, 'authority_base_set', authorityBase);
      const grant = buildReviewObservationGrantSpec({
        grantSpecId: `gs-${workItemId}`,
        workItemId,
        authorityBaseRef,
        sessionKind: 'review_content_batch',
        reviewAssignmentId,
        roundId,
        roundKind: 'content',
        snapshotHash: this.deps.snapshotHash,
        maxContextBytes: this.deps.profile.assignmentMaxTotalObjects,
      });
      const grantSpecRef = await this.deps.facade.prepareBlob(taskId, 'write_grant_spec', grant);
      const carrier: SuccessorWorkItemCarrierV2 = {
        workItemId,
        kind: 'agent_assignment',
        roleBinding: this.deps.reviewerRoleBinding,
        agentExecutionKind: 'structured_session',
        sessionKind: 'review_content_batch',
        roundId,
        logicalAssignmentId: `la-${workItemId}`,
        reviewAssignmentId,
        grantSpecRef,
        inputArtifactDeliveryId: null,
        authorityBaseRef,
        payloadRef: coverageCoreRef,
        initialLeaseEpoch: 0,
        maxAutomaticRetries,
      };
      reviewWorkItems.push(carrier);
      preparedRefs.push(authorityBaseRef, grantSpecRef);
    }
    const wholeWorkItemId = reviewWholeWorkItemId(roundId);
    const wholeAssignmentId = reviewWholeAssignmentId(roundId);
    const wholeBase = buildAuthorityBaseSet({
      taskId,
      templateSnapshotRef: this.deps.templateSnapshotRef,
      profileSnapshotRef: this.deps.profileSnapshotRef,
      refs: { mapRef, contentRevisionManifestRef: finalizedManifestRef, reviewCoverageCoreRef: coverageCoreRef, reviewRoundRef: coverageCoreRef },
      kind: 'agent_assignment',
      agentExecutionKind: 'structured_session',
      sessionKind: 'review_content_whole',
    });
    const wholeBaseRef = await this.deps.facade.prepareBlob(taskId, 'authority_base_set', wholeBase);
    const wholeGrant = buildReviewObservationGrantSpec({
      grantSpecId: `gs-${wholeWorkItemId}`,
      workItemId: wholeWorkItemId,
      authorityBaseRef: wholeBaseRef,
      sessionKind: 'review_content_whole',
      reviewAssignmentId: wholeAssignmentId,
      roundId,
      roundKind: 'content',
      snapshotHash: this.deps.snapshotHash,
      maxContextBytes: this.deps.profile.assignmentMaxTotalObjects,
    });
    const wholeGrantRef = await this.deps.facade.prepareBlob(taskId, 'write_grant_spec', wholeGrant);
    const wholeCarrier: SuccessorWorkItemCarrierV2 = {
      workItemId: wholeWorkItemId,
      kind: 'agent_assignment',
      roleBinding: this.deps.reviewerRoleBinding,
      agentExecutionKind: 'structured_session',
      sessionKind: 'review_content_whole',
      roundId,
      logicalAssignmentId: `la-${wholeWorkItemId}`,
      reviewAssignmentId: wholeAssignmentId,
      grantSpecRef: wholeGrantRef,
      inputArtifactDeliveryId: null,
      authorityBaseRef: wholeBaseRef,
      payloadRef: coverageCoreRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries,
    };
    reviewWorkItems.push(wholeCarrier);
    preparedRefs.push(wholeBaseRef, wholeGrantRef);
    for (const carrier of reviewWorkItems) {
      const errors = validateSuccessorCarrier(carrier);
      if (errors.length > 0) throw new ContentReviewError('INVALID_INPUT', `content review successor carry invalid: ${errors.join('; ')}`);
    }
    return { round, adoptionRootRef, coverageCoreRef, reviewWorkItems, preparedRefs };
  }

  private async readCurrentMapRef(taskId: string): Promise<BlobRefV2 | null> {
    const state = await this.deps.readProjection(taskId);
    return state.currentMap?.mapSnapshotRef ?? null;
  }

  /* ------------------------- settlement --------------------------- */

  /**
   * The `system_review_settlement` content branch handler: runs the acyclic DAG
   * `ContentReviewCoverageCore -> content_review_settlement aggregate ->
   * ContentReviewSettlementCore -> ReviewBundle`, and on clear atomically
   * publishes `[round_settled(outcome=seal), work_item_created(system_seal),
   * command/WorkItem terminals]`; on blocking returns retryable_failure
   * (CONTENT_REVIEW_BLOCKED) — NEVER Seal (Task 19 owns the deterministic
   * content-repair plan creation).
   */
  async executeContentReviewSettlement(input: {
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
      if (wi === undefined) throw new ContentReviewError('WORK_ITEM_NOT_FOUND', `no workitem '${input.workItemId}'`);
      const base = (await this.deps.resolver(input.taskId, input.authorityBaseRef)) as {
        mapRef: BlobRefV2 | null;
        contentRevisionManifestRef: BlobRefV2 | null;
        reviewCoverageCoreRef: BlobRefV2 | null;
        reviewRoundRef: BlobRefV2 | null;
      } | null;
      if (base === null || typeof base !== 'object' || base.reviewCoverageCoreRef === null || base.reviewRoundRef === null || base.mapRef === null) {
        throw new ContentReviewError('GRANT_STALE', 'settlement authority base is unresolvable or missing map/coverage/round refs');
      }
      const coverageCore = (await this.deps.resolver(input.taskId, base.reviewCoverageCoreRef)) as ContentReviewCoverageCoreV2 | null;
      if (coverageCore === null || typeof coverageCore !== 'object') throw new ContentReviewError('COVERAGE_CORE_UNRESOLVED', 'coverage core unresolvable');
      if (input.payloadRef.kind !== 'content_review_coverage_core' || input.payloadRef.digest !== base.reviewCoverageCoreRef.digest) {
        throw new ContentReviewError('GRANT_STALE', 'settlement payload does not match the authority base coverage core');
      }
      const roundId = coverageCore.reviewRoundId;
      const events = await this.deps.readEvents(input.taskId);
      const plannedEvent = events.find(
        (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_review_round_planned' }> =>
          e.type === 'structured_review_round_planned' && e.reviewRoundId === roundId,
      );
      if (plannedEvent === undefined) throw new ContentReviewError('ROUND_UNKNOWN', `no round-planned event for '${roundId}'`);
      const manifest = (await this.deps.resolver(input.taskId, coverageCore.contentRevisionManifestRef)) as ContentRevisionManifestV2 | null;
      if (manifest === null || typeof manifest !== 'object') throw new ContentReviewError('MANIFEST_UNRESOLVED', 'finalized manifest unresolvable');
      const coverage = await this.computeRoundCoverage(input.taskId, coverageCore.contentRevisionManifestRef);
      if (!coverage.planable) {
        // required-unset/rewrite_required must never reach settlement.
        return { kind: 'retryable_failure', failureCode: 'CONTENT_ROUND_UNPLANABLE', failureDigest: canonicalJsonSha256({ commandId: input.commandId, reasons: coverage.unplanableReasons }) };
      }
      const relations = await this.resolveActiveRelations(input.taskId, project);
      const plan = planContentReview({
        slots: await this.setSlotsWithOrder(input.taskId, coverage.setSlotIds),
        relations,
        reviewPolicy: this.deps.reviewPolicy,
        assignmentCount: plannedEvent.assignmentCount,
      });
      const findings = this.deps.findingService
        ? await this.deps.findingService.projectRoundFindings(input.taskId, roundId)
        : [];
      // §16.1 six-condition gate (design §16.1 / spec §13.2 step 8): a
      // reject/violated fact WITHOUT a closed finding, a missing verification
      // record, an incomplete assignment/observation, or an unbound policy
      // blocks settlement — NEVER Seal (F2: the pure gate is enforced here
      // BEFORE the validator runs, so a stub validator cannot mask it).
      const gate = await this.evaluateSettlementGate(input.taskId, roundId, plannedEvent, coverage, plan, findings);
      if (!gate.complete) {
        return { kind: 'retryable_failure', failureCode: 'CONTENT_REVIEW_BLOCKED', failureDigest: canonicalJsonSha256({ commandId: input.commandId, roundId, unmet: gate.unmet }) };
      }
      const blockingUnclosed = findings.filter((f) => f.blockingUnclosed);
      if (blockingUnclosed.length > 0) {
        // Any blocking Finding creates repair, NEVER Seal.
        return { kind: 'retryable_failure', failureCode: 'CONTENT_REVIEW_BLOCKED', failureDigest: canonicalJsonSha256({ commandId: input.commandId, roundId, findingIds: blockingUnclosed.map((f) => f.findingId).sort() }) };
      }

      // Segment 1: content_review_settlement aggregate over the FINAL coverage core.
      const settlementRun = await this.runSettlementValidator(input, base.reviewCoverageCoreRef, coverageCore, manifest, plan, coverage);
      await this.persistEngineOutputs(input.taskId, settlementRun.run, settlementRun.store);
      if (settlementRun.run.aggregate.outcome === 'blocking_invalid') {
        return { kind: 'retryable_failure', failureCode: 'CONTENT_REVIEW_BLOCKED', failureDigest: canonicalJsonSha256({ commandId: input.commandId, aggregateRef: settlementRun.run.aggregateRef }) };
      }
      if (settlementRun.run.aggregate.outcome !== 'clear') {
        return { kind: 'retryable_failure', failureCode: 'VALIDATOR_INFRASTRUCTURE_FAILURE', failureDigest: canonicalJsonSha256({ commandId: input.commandId, aggregateRef: settlementRun.run.aggregateRef }) };
      }

      // Segment 2: ContentReviewSettlementCore.
      const settlementCore = buildContentReviewSettlementCore({
        coverageCoreRef: base.reviewCoverageCoreRef,
        reviewSettlementValidatorAggregateRef: settlementRun.run.aggregateRef,
      });
      const settlementCoreRef = await this.deps.facade.prepareBlob(input.taskId, 'content_review_settlement_core', settlementCore);

      // Segment 3: content warning custody root + ReviewBundle.
      const custody = buildContentReviewWarningCustodyRoot({
        taskId: input.taskId,
        settlementInputRef: settlementRun.run.envelopeRef,
        settlementInputDigest: settlementRun.run.envelopeRef.digest,
        settlementAggregateRef: settlementRun.run.aggregateRef,
        settlementWarningRootRef: settlementRun.run.warningRootRef,
      });
      const custodyRef = await this.deps.facade.prepareBlob(input.taskId, 'validation_warning_custody_root', custody);
      const bundle = buildReviewBundle({
        settlementCoreRef,
        mapRef: coverageCore.mapRef,
        contentRevisionManifestRef: coverageCore.contentRevisionManifestRef,
        reviewWarningCustodyRootRef: custodyRef,
      });
      const bundleRef = await this.deps.facade.prepareBlob(input.taskId, 'review_bundle', bundle);

      // Segment 4: the System Seal WorkItem (system_seal_input seam).
      const sealWorkItemId = deterministicSealWorkItemId(input.taskId, roundId);
      const mapSnapshot = (await this.deps.resolver(input.taskId, coverageCore.mapRef)) as { mapReviewBundleRef: BlobRefV2 } | null;
      if (mapSnapshot === null || typeof mapSnapshot !== 'object' || mapSnapshot.mapReviewBundleRef === null) {
        throw new ContentReviewError('MAP_SNAPSHOT_UNRESOLVED', 'active Map snapshot unresolvable');
      }
      const sealBase = buildAuthorityBaseSet({
        taskId: input.taskId,
        templateSnapshotRef: this.deps.templateSnapshotRef,
        profileSnapshotRef: this.deps.profileSnapshotRef,
        refs: {
          mapRef: coverageCore.mapRef,
          mapReviewBundleRef: mapSnapshot.mapReviewBundleRef,
          contentRevisionManifestRef: coverageCore.contentRevisionManifestRef,
          reviewBundleRef: bundleRef,
        },
        kind: 'system_seal',
      });
      const sealBaseRef = await this.deps.facade.prepareBlob(input.taskId, 'authority_base_set', sealBase);

      // Segment 5: the atomic §13.2/§17.5 settlement envelope.
      const terminal: SystemCommandTerminalCarrierV2 = {
        workItemId: input.workItemId,
        commandId: input.commandId,
        commandKind: input.commandKind,
        leaseEpoch: input.leaseEpoch,
        authorityBaseRef: input.authorityBaseRef,
      };
      const operationId = attemptContinuationOperationId(input.taskId, input.workItemId, input.commandId, 'complete');
      const tail = await this.deps.tail(input.taskId);
      const resultRefs = [
        settlementCoreRef,
        custodyRef,
        bundleRef,
        sealBaseRef,
        settlementRun.run.aggregateRef,
      ];
      await this.deps.facade.publishWithPin({
        taskId: input.taskId,
        operationId,
        payload: {
          family: 'domain_publish',
          operationId,
          taskId: input.taskId,
          publishKind: 'content_review_settlement',
          blobRefs: resultRefs,
          expectedResultIdentity: canonicalJsonSha256({ operationId, publishKind: 'content_review_settlement' }),
          mapBuild: null,
          mapReview: null,
          contentPlan: null,
          contentReview: contentReviewCarrier({
            reviewRoundId: roundId,
            settlementCoreRef,
            outcome: 'seal',
            reviewBundleRef: bundleRef,
            reviewWarningCustodyRootRef: custodyRef,
            mapRef: coverageCore.mapRef,
            contentRevisionManifestRef: coverageCore.contentRevisionManifestRef,
            reviewSettlementValidatorAggregateRef: settlementRun.run.aggregateRef,
            sealWorkItemId,
            sealAuthorityBaseRef: sealBaseRef,
            terminal,
          }),
        },
        intent: { handlerKind: 'content_review_settlement', handlerVersion: 1 },
        preparedRefs: resultRefs,
        expectedTailSequence: tail.lastSequence,
        expectedTailCommitId: tail.lastCommitId,
      });
      return { kind: 'completed', resultRefs };
    } catch (error) {
      if (error instanceof ContentReviewError) {
        return { kind: 'retryable_failure', failureCode: error.code, failureDigest: canonicalJsonSha256({ commandId: input.commandId, code: error.code }) };
      }
      return { kind: 'retryable_failure', failureCode: 'CONTENT_REVIEW_SETTLEMENT_FAILED', failureDigest: canonicalJsonSha256({ commandId: input.commandId, error: (error as Error).message }) };
    }
  }

  private async runSettlementValidator(
    input: { taskId: string; commandId: string; workItemId: string },
    coverageCoreRef: BlobRefV2,
    coverageCore: ContentReviewCoverageCoreV2,
    manifest: ContentRevisionManifestV2,
    plan: ContentReviewPlanV2,
    coverage: { setSlotIds: string[]; facts: readonly import('../../authoritative-review/authority-types').ContentSlotCoverageFactV2[] },
  ): Promise<{ run: TriggerExecutionResult; store: ContentReviewMemoryValidatorBlobStore }> {
    const store = new ContentReviewMemoryValidatorBlobStore();
    store.put('content_review_coverage_core', coverageCore);
    store.put('content_revision_manifest', manifest);
    const engine = new ValidatorEngine({
      registry: this.deps.validatorRegistry,
      blobs: store,
      sourceResolver: this.deps.sourceResolver,
    });
    void plan;
    void coverage;
    const run = await engine.execute({
      trigger: 'review_settlement',
      identity: { taskId: input.taskId, templateSnapshotHash: 'a'.repeat(64), workItemId: input.workItemId, attemptId: null, commandId: input.commandId },
      coreRef: coverageCoreRef,
      selectedTargetRefs: [],
      registrations: this.deps.registrationsFor('content_review_settlement'),
      universe: {
        slotIds: coverage.setSlotIds,
        relationIds: plan.relationTargets,
        mapNodeIds: coverage.setSlotIds,
        artifactDigest: null,
      },
      profile: this.deps.profileBody,
    });
    return { run, store };
  }

  private async persistEngineOutputs(
    taskId: string,
    run: TriggerExecutionResult,
    store: ContentReviewMemoryValidatorBlobStore,
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

  /** One content-review publication through the facade. */
  private async publish(taskId: string, input: ContentReviewPublishInputV2): Promise<void> {
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
        mapReview: null,
        contentPlan: null,
        contentReview: input.carriers,
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

export function deterministicContentFreezeOperationId(taskId: string, workItemId: string): string {
  return `crf-${canonicalJsonSha256({ taskId, workItemId }).slice(0, 32)}`;
}

export function deterministicContentEventIdOf(taskId: string, workItemId: string): string {
  return deterministicContentFreezeOperationId(taskId, workItemId);
}

export function deterministicContentRoundCompletedOperationId(taskId: string, roundId: string): string {
  return `crc-${canonicalJsonSha256({ taskId, roundId }).slice(0, 32)}`;
}

export function deterministicContentRoundPlannedOperationId(taskId: string, roundId: string): string {
  return `crp-${canonicalJsonSha256({ taskId, roundId }).slice(0, 32)}`;
}

export function deterministicContentSettlementWorkItemId(taskId: string, roundId: string): string {
  return `wi-csettle-${canonicalJsonSha256({ taskId, roundId }).slice(0, 24)}`;
}

export function deterministicSealWorkItemId(taskId: string, roundId: string): string {
  return `wi-seal-${canonicalJsonSha256({ taskId, roundId }).slice(0, 24)}`;
}

/* ------------------------------------------------------------------ */
/* Module-level runtime allowlist registration                         */
/* ------------------------------------------------------------------ */

/**
 * Task 18 SystemCommand handler for the content branch of `review_settlement`.
 * Replaces the Task 12 NOT_IMPLEMENTED double via `SystemCommandRegistry.replace`.
 * A real runtime composition dispatches map-vs-content settlement by the
 * authority base/payload kind (Task 21); this handler is the content branch.
 */
export function createContentReviewSettlementSystemCommandHandler(service: ContentReviewService): SystemCommandHandler {
  return {
    commandKind: 'review_settlement',
    async execute(ctx) {
      const outcome = await service.executeContentReviewSettlement({
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

// Register the four content-review publication handlers on the runtime allowlist
// so the default facade can replay their pins. Idempotent.
registerContentReviewPublicationHandlers(PUBLICATION_INTENT_REGISTRY_V2);
