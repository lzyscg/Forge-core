/**
 * Task 19 repair-service (spec §13.3/§13.3.1/§10.3.1, design §11.8/§12.4/§13,
 * §17.5): deterministic Map/Content RepairPlan specs/revisions, serial staging
 * batches with repair_staging_root CAS + repair_key_ledger lineage, scope
 * expansion (request -> approval/rejection), finalizer-only publication, and
 * the map/content cycle-budget boundaries (spec §13.3.1).
 *
 * NORMATIVE CORE:
 * - the INITIAL RepairPlan is created by the blocking settlement envelope
 *   (Task 18 handoff): the settlement command COMPLETES with
 *   [*_repair_plan_started, work_item_created(batch 1), repair_grant_issued,
 *   command/WorkItem terminals] in ONE batch. The initial origin has NO fake
 *   predecessor — it binds the settlement's deterministic key (settlement
 *   workItemId + coverage-core digest + the settlement continuation op id).
 *   The plan-started event lands HERE (not in the first batch) so a scope
 *   request before any batch stays projector-legal (demandRepairHead);
 * - ONE serial repair batch at a time: a batch commit is legal only when its
 *   ordinal is the NEXT uncommitted ordinal of the CURRENT active plan
 *   revision, its grant binds the exact plan spec ref + the exact current
 *   staging root (expectedStagingRootRef CAS) + the exact key ledger
 *   (planKeyLedgerRef), and every operation is inside the plan batch scope
 *   (operation/node/relation/plan-key scope for map; slot scope for content).
 *   A batch can NEVER publish a candidate/finalized manifest — only the
 *   System `repair_finalize` publishes. Official IDs are allocated only by
 *   the finalizer (new plan keys carry officialId null in the ledger);
 * - the LAST batch creates the `system_repair_finalize` WorkItem. The
 *   finalizer reconstructs the complete staged state from the durable
 *   repair-staging journals (private/repair/<planRevisionId>/<batchOrdinal>/,
 *   Task 13 machinery) + the committed batch events, runs the
 *   `repair_finalize` validator, and:
 *   - map clear: publishes the repair build chain (map_build_started +
 *     map_build_finish_proposed + map_build_finalized +
 *     map_candidate_committed — the Task 15 candidate rules demand this
 *     chain) + the COMPLETE MapReviewRound (map_review_round_planned with
 *     mapCycleOrdinal+1 + review WorkItems) + finding_addressed + terminals;
 *   - content clear: publishes the repaired FINALIZED manifest +
 *     `structured_review_round_planned` (contentCycleOrdinal+1, the Task 18
 *     planContentReviewRound seam called in the SAME envelope) + review
 *     WorkItems + finding_addressed + terminals;
 *   - blocking: `*_repair_plan_rejected` + ONE `structured_repair_plan_
 *     revision_started` (validation_correction) successor + correction-batch
 *     WorkItem/Grant + terminals (the Task 15/17 blocking precedent);
 *   - infrastructure: retryable_failure, NO successor;
 *   - over-limit (§13.3.1): when the round ordinal would exceed maxRounds and
 *     no EXACT available override is consumed, the envelope instead terminal-
 *     fails the task with EXACTLY ONE `structured_task_failed_v2(
 *     REVIEW_REPAIR_LIMIT_EXCEEDED)` + the restart_review_cycle
 *     failure_recovery_payload (the projector demands it) and publishes NO
 *     round/RepairPlan/candidate/manifest/terminal-success. With an exact
 *     available override, the round-created event carries consumedOverrideRef
 *     and the projector consumes it exactly once;
 * - scope expansion: `request_scope_expansion` publishes
 *   `structured_repair_scope_requested`; approval publishes
 *   `structured_repair_scope_expansion_approved_v2` (the projector registers
 *   the successor revision itself — a separate revision-started event would
 *   clash) + `structured_work_item_superseded` for the superseded revision's
 *   claimable WorkItem (I-4) + the successor WorkItem/Grant + the optional
 *   override transfer;
 *   rejection publishes `structured_repair_scope_expansion_rejected_v2` and
 *   widens nothing. Competing successors resolve by tail-CAS (the facade's
 *   expectedTailCommitId): the loser re-projects and re-evaluates on the
 *   winner.
 *
 * PUBLICATION MODEL: the six Task 19 branches (`repair_plan_creation`,
 * `repair_batch_commit`, `repair_finalize`, `repair_scope_request`,
 * `repair_scope_approval`, `repair_scope_rejection`) are registered
 * publication handlers on the module allowlist AND on injected registries via
 * `registerRepairPublicationHandlers` — a crashed pin replays the envelope
 * byte-identically.
 *
 * V1 byte-for-byte: new module; v1 surfaces untouched.
 */
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { BlobRefV2, RoundBudgetOverrideV2 } from '../../../shared/authoritative-review-v2';
import type { AuthoritativeAppendFacadeV2 } from '../../storage/authoritative-append-facade';
import type {
  PublicationIntentRegistry,
  PublicationEventEnvelopeV2,
  PublicationIntentResolvedRef,
} from '../../storage/authoritative-publication-intent-registry';
import { deterministicEventId, NotRebuildableError, PUBLICATION_INTENT_REGISTRY_V2 } from '../../storage/authoritative-publication-intent-registry';
import { parsePublicationOperationPayload } from '../../authoritative-review/object-schema-parsers-3';
import type { SystemCommandHandler } from './system-command-registry';
import { ValidatorEngine } from './validator-engine';
import type { TriggerExecutionResult, ValidatorBlobStore } from './validator-engine';
import type {
  AuthoritativeReviewProfile,
  ContributionManifestV2,
  ContentRevisionManifestV2,
  ContentRevisionCommitCoreV2,
  ContentValidationCoreV2,
  ContentValueV2,
  ContentReviewRoundPlanCarrierV2,
  MapCandidateSnapshotV2,
  MapCandidateValidationCoreV2,
  MapPositionNodeV2,
  MapRelationV2,
  MapReviewRoundPlanCarrierV2,
  MapWriteScopeV2,
  PublicationOperationPayloadV2,
  RepairBatchGrantSpecV2,
  RepairBatchScopeV2,
  RepairKeyLedgerV2,
  RepairPlanOriginV2,
  RepairPlanSpecV2,
  RepairPublishCarriersV2,
  RepairStagingRootV2,
  ReviewPolicyParameters,
  SlotContentVersionV2,
  StructuredSessionKindV2,
  SuccessorWorkItemCarrierV2,
  SystemCommandTerminalCarrierV2,
  ValidationWarningCustodyRootV2,
  WriteGrantSpecV2,
} from '../../authoritative-review/authority-types';
import { refOfBlob } from '../../authoritative-review/object-registry';
import { resolveMapPositionGraphDigest, resolveMapRelationGraphDigest, resolveMapSemanticDigest } from '../../authoritative-review/map-domain';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { AuthoritativeReviewProjectionV2 } from '../../storage/authoritative-review-state';
import type { AuthoritativeReviewProfileSnapshotV1Body } from '../../structured-slots/authoritative-review-profile';
import { attemptContinuationOperationId } from './attempt-coordinator';
import { buildAuthorityBaseSet, sameRef } from './authority-base';
import {
  buildContentRevisionCommitCore,
  buildContentBatchWarningCustodyRoot,
  buildContentSetVersion,
  buildContentValue,
  buildEmptyAdoptionRoot,
  buildFinalizedManifest,
  buildProvisionalManifest,
  contentReviewRoundId,
  ContentPlanMemoryBlobStore,
  contentPlanEnrichment,
} from './content-plan-service';
import { buildReviewObservationGrantSpec, reviewAssignmentIdOf, reviewBatchWorkItemId, reviewWholeAssignmentId, reviewWholeWorkItemId } from './review-coordinator';
import {
  contentRoundBudgetCheck,
  buildContentReviewCoverageCore,
} from './content-review-service';
import { buildMapReviewCoverageCore, buildMapReviewRound, buildEmptyFindingStageRoot } from './map-review-service';
import { resolveRoundAssignmentCount } from './map-build-service';
import { validateRepairSuccessorCarrier } from './work-item-coordinator';
import type { GrantService } from './grant-service';
import {
  assertContentWriteAuthorized,
  assertExactBase,
  assertMapWriteAuthorized,
  buildRepairBatchGrantSpec,
  classifyToolReplay,
  grantSpecFindingIds,
  grantSpecPlanKeyLedgerRef,
} from './grant-service';
import type { ProjectedFindingLifecycleV2 } from './finding-service';
import { buildFindingStageRoot, repairRouteOf, REQUIRED_STAGES_BY_DEFECT } from './finding-service';
import type { V2AttemptContext } from './attempt-coordinator';
import type { AuthoritativeReviewPrivateStore } from '../../storage/authoritative-review-private-store';

/* ------------------------------------------------------------------ */
/* Deterministic ids (§11.11 / Task 16/17 conventions)                 */
/* ------------------------------------------------------------------ */

/** Deterministic repair-plan id of a track's lineage (settlement-created). */
export function repairPlanIdOf(taskId: string, settlementOperationKey: string, track: 'map' | 'content'): string {
  return `rp-${canonicalJsonSha256({ taskId, settlementOperationKey, track, label: 'repair' }).slice(0, 24)}`;
}

/** The frozen parser rule: planRevisionId = hash(repairPlanId, revision, specDigest). */
export function repairPlanRevisionIdOf(repairPlanId: string, revision: number, specDigest: string): string {
  return canonicalJsonSha256({ repairPlanId, revision, specDigest });
}

/** Deterministic plan key of one repair target (official-id bound at finalize). */
export function repairPlanKeyOf(repairPlanId: string, targetId: string): string {
  return `pk-${canonicalJsonSha256({ repairPlanId, targetId }).slice(0, 24)}`;
}

/** The key ledger's SELF-CONSISTENT planRevisionId: the ledger is prepared
 * BEFORE the plan spec exists (the spec's keyLineageRef binds it — the
 * Task 11 reopen precedent), so its revision id is derived WITHOUT the spec
 * digest. The staging roots + journals carry the PLAN's planRevisionId. */
export function repairLedgerRevisionIdOf(repairPlanId: string, revision: number): string {
  return canonicalJsonSha256({ repairPlanId, revision, label: 'repair-ledger' });
}

/** Official node id of a plan key — allocated ONLY by the finalizer. */
export function repairOfficialNodeIdOf(repairPlanId: string, planKey: string): string {
  return `n-${canonicalJsonSha256({ repairPlanId, planKey, kind: 'node' }).slice(0, 24)}`;
}

/** Official relation id of a plan key — allocated ONLY by the finalizer. */
export function repairOfficialRelationIdOf(repairPlanId: string, planKey: string): string {
  return `r-${canonicalJsonSha256({ repairPlanId, planKey, kind: 'relation' }).slice(0, 24)}`;
}

/** Deterministic repair batch WorkItem id (per plan REVISION + ordinal — a
 * successor revision gets a NEW workitem id even for batch ordinal 1). */
export function repairBatchWorkItemId(taskId: string, repairPlanId: string, batchOrdinal: number, planRevisionId?: string): string {
  return `wi-repb-${canonicalJsonSha256({ taskId, repairPlanId, planRevisionId: planRevisionId ?? '', batchOrdinal }).slice(0, 24)}`;
}

/** Deterministic `system_repair_finalize` WorkItem id (per plan revision). */
export function repairFinalizeWorkItemId(taskId: string, repairPlanId: string, planRevisionId?: string): string {
  return `wi-repfin-${canonicalJsonSha256({ taskId, repairPlanId, planRevisionId: planRevisionId ?? '' }).slice(0, 24)}`;
}

/** Deterministic batch-commit publication operation id (replay-safe). */
export function repairBatchCommitOperationId(taskId: string, workItemId: string, batchOrdinal: number): string {
  return `rb-${canonicalJsonSha256({ taskId, workItemId, batchOrdinal }).slice(0, 32)}`;
}

/** Finalizer publication operation id (= the coordinator's continuation op so
 * the §9.2 completion envelope REPLAYS, not double-commits). */
export function repairFinalizeOperationId(taskId: string, workItemId: string, commandId: string): string {
  return attemptContinuationOperationId(taskId, workItemId, commandId, 'complete');
}

/** The §13.3.1 over-limit terminal-fail operation id (= the coordinator's
 * terminal op so the terminal envelope REPLAYS). */
export function repairTerminalOperationId(taskId: string, workItemId: string, commandId: string): string {
  return attemptContinuationOperationId(taskId, workItemId, commandId, 'terminal');
}

/** Deterministic scope-request id (agent tool, per attempt + client op). */
export function repairScopeRequestId(taskId: string, workItemId: string, clientOperationId: string): string {
  return `rq-${canonicalJsonSha256({ taskId, workItemId, clientOperationId }).slice(0, 24)}`;
}

/** Canonical immutable requested-scope digest. */
export function repairRequestedScopeDigest(input: {
  findingIds: readonly string[];
  requestedNodeIds: readonly string[];
  requestedRelationIds: readonly string[];
  requestedSlotIds: readonly string[];
}): string {
  return canonicalJsonSha256(input);
}

/** Deterministic scope-approval publication operation id. The approved scope
 * digest is part of the key, so a request id can never authorize different
 * bytes under the same successor identity. */
export function repairScopeApprovalOperationId(taskId: string, requestId: string, requestedScopeDigest = ''): string {
  return `ra-${canonicalJsonSha256({ taskId, requestId, requestedScopeDigest }).slice(0, 32)}`;
}

/** Deterministic scope-rejection publication operation id. */
export function repairScopeRejectionOperationId(taskId: string, requestId: string, operatorId = '', reason = ''): string {
  return `rj-${canonicalJsonSha256({ taskId, requestId, operatorId, reason }).slice(0, 32)}`;
}

export function repairScopeRejectionReplacementWorkItemId(taskId: string, requestId: string): string {
  return `wi-reprj-${canonicalJsonSha256({ taskId, requestId }).slice(0, 24)}`;
}

/** Deterministic override-transfer operation id (scope-expansion successors). */
export function repairTransferOperationId(taskId: string, requestId: string, track: 'map' | 'content'): string {
  return `rt-${canonicalJsonSha256({ taskId, requestId, track }).slice(0, 32)}`;
}

/** The repair build id the finalizer's candidate chain runs under (a fresh
 * map-build lineage: revision 1, supersedes null — the Task 15 candidate
 * rules demand the build chain for every candidate). */
export function repairBuildIdOf(repairPlanId: string, planRevisionId: string): string {
  return `mb-rep-${canonicalJsonSha256({ repairPlanId, planRevisionId }).slice(0, 24)}`;
}

/** Deterministic repaired-candidate id. */
export function repairCandidateIdOf(repairPlanId: string, planRevisionId: string): string {
  return `cand-rep-${canonicalJsonSha256({ repairPlanId, planRevisionId }).slice(0, 24)}`;
}

/** Deterministic map review round id of the repaired candidate's round. */
export function mapRepairRoundId(taskId: string, mapCycleOrdinal: number, candidateRef: BlobRefV2): string {
  return `mr-${canonicalJsonSha256({ taskId, mapCycleOrdinal, candidateRef: candidateRef.digest }).slice(0, 24)}`;
}

/* ------------------------------------------------------------------ */
/* Pure builders (design §13 / spec §13.3)                             */
/* ------------------------------------------------------------------ */

/** The frozen parser contract: specDigest covers the canonical bytes minus
 * (specDigest, planRevisionId); planRevisionId = hash(repairPlanId, revision,
 * specDigest). Builds a spec that ALWAYS parses. */
export function buildRepairPlanSpec(input: {
  repairPlanId: string;
  revision: number;
  origin: RepairPlanOriginV2;
  sourceReceiptRef: BlobRefV2 | null;
  repairBase: RepairPlanSpecV2['repairBase'];
  orderedBatchScopes: readonly RepairBatchScopeV2[];
  keyLineageRef: BlobRefV2;
  importedStagingManifestRef: BlobRefV2;
}): RepairPlanSpecV2 {
  const body: Omit<RepairPlanSpecV2, 'specDigest' | 'planRevisionId'> = {
    repairPlanId: input.repairPlanId,
    revision: input.revision,
    origin: input.origin,
    sourceReceiptRef: input.sourceReceiptRef,
    repairBase: input.repairBase,
    orderedBatchScopes: [...input.orderedBatchScopes],
    keyLineageRef: input.keyLineageRef,
    importedStagingManifestRef: input.importedStagingManifestRef,
  };
  const specDigest = canonicalJsonSha256(body);
  const planRevisionId = repairPlanRevisionIdOf(input.repairPlanId, input.revision, specDigest);
  return { ...body, planRevisionId, specDigest };
}

/** Canonical repair key ledger (entries sorted by planKey — parser rule). */
export function buildRepairKeyLedger(
  repairPlanId: string,
  planRevisionId: string,
  entries: readonly { planKey: string; kind: 'node' | 'relation'; officialId: string | null; status: 'active' | 'tombstone'; predecessorPlanKey: string | null }[],
): RepairKeyLedgerV2 {
  const sorted = [...entries].sort((a, b) => (a.planKey < b.planKey ? -1 : a.planKey > b.planKey ? 1 : 0));
  const body = { repairPlanId, planRevisionId, entries: sorted };
  return { ...body, ledgerDigest: canonicalJsonSha256(body) };
}

/** Canonical repair staging root (batchOrdinal 0 = the plan's base state). */
export function buildRepairStagingRoot(input: {
  repairPlanId: string;
  planRevisionId: string;
  batchOrdinal: number;
  mapRootDigest: string | null;
  contentRootDigest: string | null;
  contentManifestRef?: BlobRefV2 | null;
  priorStagingRootRef: BlobRefV2 | null;
  keyLedgerRef: BlobRefV2;
}): RepairStagingRootV2 {
  const body = { ...input, contentManifestRef: input.contentManifestRef ?? null };
  return { ...body, stagingDigest: canonicalJsonSha256(body) };
}

/** The deterministic batch scopes of a repair plan. Map batches chunk the
 * node+relation targets by assignmentMaxPrimaryTargets; content batches chunk
 * the slot targets by contentBatchTargetSlots. Every batch's allowedPlanKeys
 * include the union of its own + prior batches' target keys, so a later batch
 * may reference an earlier batch's keys (spec §13.3 "may refer to prior plan
 * keys") while never referencing a FUTURE batch's keys. */
export function buildRepairBatchScopes(input: {
  track: 'map' | 'content';
  repairPlanId: string;
  nodeIds: readonly string[];
  relationIds: readonly string[];
  slotIds: readonly string[];
  findingIds: readonly string[];
  reviewPolicy: ReviewPolicyParameters;
  profile: AuthoritativeReviewProfile;
}): RepairBatchScopeV2[] {
  const { track, repairPlanId } = input;
  const findingSet = new Set(input.findingIds);
  if (track === 'map') {
    const batchSize = Math.max(1, input.profile.assignmentMaxPrimaryTargets);
    const nodeBatches: string[][] = [];
    for (let i = 0; i < input.nodeIds.length; i += batchSize) {
      nodeBatches.push(input.nodeIds.slice(i, i + batchSize));
    }
    const relationBatches: string[][] = [];
    for (let i = 0; i < input.relationIds.length; i += batchSize) {
      relationBatches.push(input.relationIds.slice(i, i + batchSize));
    }
    const batchCount = Math.max(1, nodeBatches.length, relationBatches.length);
    const scopes: RepairBatchScopeV2[] = [];
    let seenNodes = new Set<string>();
    let seenRelations = new Set<string>();
    for (let index = 0; index < batchCount; index++) {
      const batchNodes = nodeBatches[index] ?? [];
      const batchRelations = relationBatches[index] ?? [];
      seenNodes = new Set([...seenNodes, ...batchNodes]);
      seenRelations = new Set([...seenRelations, ...batchRelations]);
      const scope: MapWriteScopeV2 = {
        nodeIds: [...batchNodes],
        relationIds: [...batchRelations],
        // Deterministic plan keys of every target up to and including this
        // batch (prior batches' keys stay referencable).
        allowedPlanKeys: [...seenNodes, ...seenRelations]
          .sort()
          .map((id) => repairPlanKeyOf(repairPlanId, id)),
        parentContainers: [],
        relationTypeIds: [],
        operations: ['update_attributes', 'remove_node', 'remove_relation', 'add_relation'],
      };
      scopes.push({ kind: 'map', batchOrdinal: index + 1, findingIds: [...findingSet].sort(), scope });
    }
    return scopes;
  }
  const batchSize = Math.max(1, input.reviewPolicy.contentBatchTargetSlots);
  const scopes: RepairBatchScopeV2[] = [];
  for (let index = 0; index < input.slotIds.length; index += batchSize) {
    scopes.push({
      kind: 'content',
      batchOrdinal: scopes.length + 1,
      findingIds: [...findingSet].sort(),
      slotIds: input.slotIds.slice(index, index + batchSize),
    });
  }
  if (scopes.length === 0) {
    scopes.push({ kind: 'content', batchOrdinal: 1, findingIds: [...findingSet].sort(), slotIds: [] });
  }
  return scopes;
}

/** Deterministic repair targets of the route's blocking findings. Content
 * targets = slot primaries + suggestedRepairSlotIds; Map targets = node
 * primaries + relation primaries. Unknown target ids fail closed (a finding
 * naming a target the current baseline does not know is a system invariant
 * violation, never silently dropped — the Task 15 F5 precedent). */
export function deriveRepairTargets(input: {
  track: 'map' | 'content';
  findings: readonly { findingId: string; severity: 'blocking' | 'advisory'; primaryLocation: { kind: string; id: string } }[];
}): { nodeIds: string[]; relationIds: string[]; slotIds: string[]; findingIds: string[] } {
  const nodeIds = new Set<string>();
  const relationIds = new Set<string>();
  const slotIds = new Set<string>();
  const findingIds = new Set<string>();
  for (const f of input.findings) {
    if (f.severity !== 'blocking') continue;
    findingIds.add(f.findingId);
    if (input.track === 'map') {
      if (f.primaryLocation.kind === 'map_node') nodeIds.add(f.primaryLocation.id);
      if (f.primaryLocation.kind === 'relation') relationIds.add(f.primaryLocation.id);
      continue;
    }
    if (f.primaryLocation.kind === 'slot') slotIds.add(f.primaryLocation.id);
  }
  return {
    nodeIds: [...nodeIds].sort(),
    relationIds: [...relationIds].sort(),
    slotIds: [...slotIds].sort(),
    findingIds: [...findingIds].sort(),
  };
}

/** The §13.3.1 budget predicate for the MAP track (the content twin lives in
 * content-review-service). A new complete map round is legal when
 * `nextOrdinal <= maxRounds` OR an EXACT available Map RoundBudgetOverrideV2
 * is being consumed. Wrong track/preconsumed/absent override rejects. */
export function mapRoundBudgetCheck(input: {
  nextOrdinal: number;
  maxRounds: number;
  availableOverride: { ref: BlobRefV2; track: 'map' | 'content' } | null;
  overrideRef: BlobRefV2 | null;
}): void {
  if (input.nextOrdinal <= input.maxRounds) {
    return;
  }
  if (input.overrideRef === null) {
    throw new RepairLimitExceededError('(budget)', input.nextOrdinal, input.maxRounds);
  }
  const available = input.availableOverride;
  if (available === null || available.track !== 'map' || available.ref.digest !== input.overrideRef.digest) {
    throw new RepairError('OVERRIDE_UNAVAILABLE', 'no exact available map RoundBudgetOverrideV2 for this round');
  }
}

/** One-entry repair `validation_warning_custody_root` (the finalizer's custody,
 * design §9 — the repair finalizer runs exactly one validator trigger). */
export function buildRepairWarningCustodyRoot(input: {
  taskId: string;
  inputRef: BlobRefV2;
  inputDigest: string;
  aggregateRef: BlobRefV2;
  warningRootRef: BlobRefV2;
  repairPlanId: string;
  planRevisionId: string;
  phase: 'map' | 'content';
}): ValidationWarningCustodyRootV2 {
  const body = {
    scope: (input.phase === 'map' ? 'map_review' : 'content_review') as 'map_review' | 'content_review',
    taskId: input.taskId,
    baseRefs: [input.inputRef],
    entries: [
      {
        trigger: 'repair_finalize' as const,
        inputRef: input.inputRef,
        inputDigest: input.inputDigest,
        executionScope: {} as Record<string, never>,
        validatorAggregateRef: input.aggregateRef,
        warningRootRef: input.warningRootRef,
      },
    ],
    supersessionPolicyVersion: '1',
  };
  return { ...body, rootDigest: canonicalJsonSha256(body) };
}

/** The repair contribution manifest (producerKind 'repair'; the map finalizer
 * binds it as `structured_map_build_finalized.manifestRef` — the repair build
 * has no chunk manifest, the contribution manifest IS the complete staged-map
 * manifest; documented decision). */
export function buildRepairContributionManifest(input: {
  repairPlanId: string;
  planRevision: number;
  stagingRootRef: BlobRefV2 | null;
  keyLedgerRefs: readonly BlobRefV2[];
  agentAttemptIdentities: readonly { workItemId: string; attemptId: string }[];
}): ContributionManifestV2 {
  const body = {
    contributionManifestId: `cm-rep-${canonicalJsonSha256({ repairPlanId: input.repairPlanId, planRevision: input.planRevision }).slice(0, 24)}`,
    producerKind: 'repair' as const,
    planId: input.repairPlanId,
    planRevision: input.planRevision,
    orderedChunkOrBatchRefs: [],
    stagingRootRef: input.stagingRootRef,
    keyLedgerRefs: input.keyLedgerRefs,
    agentAttemptIdentities: input.agentAttemptIdentities,
  };
  return { ...body, manifestDigest: canonicalJsonSha256(body) };
}

/** The repaired candidate's validation core (provenance producerKind
 * system_repair_finalize — the frozen branch). */
export function buildRepairCandidateCore(input: {
  candidateId: string;
  baseMapId: string | null;
  repairPlanId: string;
  repairPlanRevision: number;
  snapshotHash: string;
  producerWorkItemId: string;
  commandId: string;
  contributionManifestRef: BlobRefV2;
  nodes: readonly MapPositionNodeV2[];
  relations: readonly MapRelationV2[];
}): MapCandidateValidationCoreV2 {
  const source = { templateSnapshotHash: input.snapshotHash, nodes: input.nodes, relations: input.relations };
  const candidateProvenanceWithoutValidation: MapCandidateValidationCoreV2['candidateProvenanceWithoutValidation'] = {
    producerKind: 'system_repair_finalize',
    producerWorkItemId: input.producerWorkItemId,
    commandId: input.commandId,
    repairPlanId: input.repairPlanId,
    repairPlanRevision: input.repairPlanRevision,
    contributionManifestRef: input.contributionManifestRef,
  };
  const body = {
    candidateId: input.candidateId,
    baseMapId: input.baseMapId,
    positionGraphDigest: resolveMapPositionGraphDigest(source),
    relationGraphDigest: resolveMapRelationGraphDigest(source),
    templateSnapshotHash: input.snapshotHash,
    nodes: input.nodes,
    relations: input.relations,
    candidateProvenanceWithoutValidation,
  };
  return { ...body, coreDigest: canonicalJsonSha256(body) };
}

/** The repaired candidate snapshot (candidateDigest = canonical bytes minus
 * itself — the Task 15 shape; the event's candidateDigest must equal
 * candidateRef.digest per the event validator). */
export function buildRepairCandidateSnapshot(input: {
  candidateId: string;
  baseMapId: string | null;
  validationCoreRef: BlobRefV2;
  candidateValidationAggregateRef: BlobRefV2;
  candidateWarningCustodyRootRef: BlobRefV2;
  createdAt: string;
}): MapCandidateSnapshotV2 {
  const body = { ...input };
  return { ...body, candidateDigest: canonicalJsonSha256(body) };
}

/** The §10.3.1 restart_review_cycle failure-recovery payload (the projector
 * demands the exact fields; terminalEventId = the terminal batch's
 * system_command_terminal_failed event id — deterministicEventId(terminalOp,
 * 'work_item_terminal_failed', 0)). */
export function buildFailureRecoveryPayload(input: {
  track: 'map' | 'content';
  failedWorkItemId: string;
  failedAttemptOrCommandId: string;
  failedLeaseEpoch: number;
  terminalEventId: string;
  terminalCommitId: string;
  authorityBaseRef: BlobRefV2;
  rejectedSubjectRef: BlobRefV2;
  findingSetRef: BlobRefV2;
  failedCycleOrdinal: number;
}): Record<string, unknown> {
  return {
    kind: 'restart_review_cycle',
    track: input.track,
    failedWorkItemId: input.failedWorkItemId,
    failedAttemptOrCommandId: input.failedAttemptOrCommandId,
    failedLeaseEpoch: input.failedLeaseEpoch,
    terminalEventId: input.terminalEventId,
    terminalCommitId: input.terminalCommitId,
    authorityBaseRef: input.authorityBaseRef,
    rejectedSubjectRef: input.rejectedSubjectRef,
    findingSetRef: input.findingSetRef,
    failedCycleOrdinal: input.failedCycleOrdinal,
  };
}

/* ------------------------------------------------------------------ */
/* Staged-map fold (the deterministic map repair state machine)        */
/* ------------------------------------------------------------------ */

/** One map-repair patch operation (the submit_map_patch contract). */
export interface RepairMapPatchOperationV2 {
  kind: 'add_node' | 'remove_node' | 'add_relation' | 'remove_relation' | 'update_attributes';
  targetId?: string;
  node?: { buildNodeKey: string; slotType: string; parentBuildNodeKey: string | null; documentOrder: number; siblingOrder: number; contentBearing: boolean };
  relation?: { buildRelationKey: string; typeId: string; fromBuildNodeKey: string; toBuildNodeKey: string; attributes: Record<string, unknown> };
}

/** Validates one patch against the plan's map batch scope + the current
 * ledger. Returns the error list ([] when legal) — never throws. */
export function mapPatchScopeErrors(
  ops: readonly RepairMapPatchOperationV2[],
  scope: MapWriteScopeV2,
  ledgerByKey: ReadonlyMap<string, RepairKeyLedgerV2['entries'][number]>,
): string[] {
  const errors: string[] = [];
  const allowedKeys = new Set(scope.allowedPlanKeys);
  for (const op of ops) {
    if (op.kind === 'add_node') {
      const node = op.node;
      if (node === undefined) {
        errors.push('add_node requires a node declaration');
        continue;
      }
      if (!allowedKeys.has(node.buildNodeKey)) {
        errors.push(`plan key '${node.buildNodeKey}' is not inside the batch's allowedPlanKeys`);
      }
      if (!scope.operations.includes('add_node')) {
        errors.push(`operation 'add_node' is not inside the batch's operations scope`);
      }
      if (node.parentBuildNodeKey !== null && !scope.parentContainers.includes(node.parentBuildNodeKey)) {
        errors.push(`parent container '${node.parentBuildNodeKey}' is not an authorized new-node parent`);
      }
      if (ledgerByKey.has(node.buildNodeKey)) {
        errors.push(`plan key '${node.buildNodeKey}' already exists in the ledger`);
      }
      if (!scope.nodeIds.includes(node.buildNodeKey) && !scope.allowedPlanKeys.includes(node.buildNodeKey)) {
        errors.push(`new node '${node.buildNodeKey}' is not a declared repair target`);
      }
    } else if (op.kind === 'add_relation') {
      const rel = op.relation;
      if (rel === undefined) {
        errors.push('add_relation requires a relation declaration');
        continue;
      }
      if (!allowedKeys.has(rel.buildRelationKey)) {
        errors.push(`plan key '${rel.buildRelationKey}' is not inside the batch's allowedPlanKeys`);
      }
      if (!scope.operations.includes('add_relation')) {
        errors.push(`operation 'add_relation' is not inside the batch's operations scope`);
      }
      if (scope.relationTypeIds.length > 0 && !scope.relationTypeIds.includes(rel.typeId)) {
        errors.push(`relation type '${rel.typeId}' is not inside the batch's relationTypeIds`);
      }
      if (ledgerByKey.has(rel.buildRelationKey)) {
        errors.push(`plan key '${rel.buildRelationKey}' already exists in the ledger`);
      }
      if (!ledgerByKey.has(rel.fromBuildNodeKey) || !ledgerByKey.has(rel.toBuildNodeKey)) {
        errors.push(`relation endpoints must be ledger-active plan keys`);
      }
    } else if (op.kind === 'remove_node' || op.kind === 'remove_relation') {
      const key = op.targetId ?? '';
      if (!scope.operations.includes(op.kind === 'remove_node' ? 'remove_node' : 'remove_relation')) {
        errors.push(`operation '${op.kind}' is not inside the batch's operations scope`);
      }
      const entry = ledgerByKey.get(key);
      if (entry === undefined || entry.status !== 'active') {
        errors.push(`plan key '${key}' is not a ledger-active key`);
      }
      if (op.kind === 'remove_node' && entry !== undefined && !scope.nodeIds.includes(entry.officialId ?? '')) {
        errors.push(`node '${key}' is not inside the batch's nodeIds scope`);
      }
      if (op.kind === 'remove_relation' && entry !== undefined && !scope.relationIds.includes(entry.officialId ?? '')) {
        errors.push(`relation '${key}' is not inside the batch's relationIds scope`);
      }
    } else {
      const key = op.targetId ?? '';
      if (!scope.operations.includes('update_attributes')) {
        errors.push(`operation 'update_attributes' is not inside the batch's operations scope`);
      }
      const entry = ledgerByKey.get(key);
      if (entry === undefined || entry.status !== 'active') {
        errors.push(`plan key '${key}' is not a ledger-active key`);
      }
      if (entry !== undefined && entry.officialId !== null) {
        if (entry.kind === 'node' && !scope.nodeIds.includes(entry.officialId)) {
          errors.push(`node '${key}' is not inside the batch's nodeIds scope`);
        }
        if (entry.kind === 'relation' && !scope.relationIds.includes(entry.officialId)) {
          errors.push(`relation '${key}' is not inside the batch's relationIds scope`);
        }
      }
    }
  }
  return errors;
}

/** Folds the committed repair batches' patches over the repair base map.
 * New plan keys keep officialId null (the FINALIZER allocates official ids —
 * "Official IDs are allocated only by finalizer"); existing keys resolve via
 * the key ledger. Deterministic: the fold is a pure function of (base, ops,
 * ledger). */
export function foldRepairMapState(input: {
  baseNodes: readonly MapPositionNodeV2[];
  baseRelations: readonly MapRelationV2[];
  patches: readonly { batchOrdinal: number; ops: readonly RepairMapPatchOperationV2[] }[];
  ledgerByKey: ReadonlyMap<string, { planKey: string; kind: 'node' | 'relation'; officialId: string | null; status: 'active' | 'tombstone'; predecessorPlanKey: string | null }>;
}): { nodes: readonly MapPositionNodeV2[]; relations: readonly MapRelationV2[] } {
  const nodeByOfficial = new Map<string, MapPositionNodeV2>();
  for (const n of input.baseNodes) nodeByOfficial.set(n.slotId, { ...n });
  const relationByOfficial = new Map<string, MapRelationV2>();
  for (const r of input.baseRelations) relationByOfficial.set(r.relationId, { ...r });
  // The repair base nodes/relations are the current committed state; the plan
  // keys bound to them are ledger entries with officialId set.
  for (const batch of [...input.patches].sort((a, b) => a.batchOrdinal - b.batchOrdinal)) {
    for (const op of batch.ops) {
      if (op.kind === 'remove_node') {
        const entry = input.ledgerByKey.get(op.targetId ?? '');
        if (entry !== undefined && entry.officialId !== null) nodeByOfficial.delete(entry.officialId);
      } else if (op.kind === 'remove_relation') {
        const entry = input.ledgerByKey.get(op.targetId ?? '');
        if (entry !== undefined && entry.officialId !== null) relationByOfficial.delete(entry.officialId);
      } else if (op.kind === 'add_node') {
        const node = op.node;
        if (node === undefined) continue;
        const officialId = input.ledgerByKey.get(node.buildNodeKey)?.officialId ?? null;
        const parentOfficial = node.parentBuildNodeKey === null ? null : (input.ledgerByKey.get(node.parentBuildNodeKey)?.officialId ?? null);
        nodeByOfficial.set(
          officialId ?? node.buildNodeKey,
          {
            slotId: officialId ?? node.buildNodeKey,
            slotType: node.slotType,
            contentBearing: node.contentBearing,
            parentSlotId: parentOfficial,
            documentOrder: node.documentOrder,
            siblingOrder: node.siblingOrder,
            nodeSpecDigest: canonicalJsonSha256({ slotType: node.slotType, contentBearing: node.contentBearing }),
          },
        );
      } else if (op.kind === 'add_relation') {
        const rel = op.relation;
        if (rel === undefined) continue;
        const officialId = input.ledgerByKey.get(rel.buildRelationKey)?.officialId ?? null;
        const from = input.ledgerByKey.get(rel.fromBuildNodeKey)?.officialId ?? rel.fromBuildNodeKey;
        const to = input.ledgerByKey.get(rel.toBuildNodeKey)?.officialId ?? rel.toBuildNodeKey;
        relationByOfficial.set(
          officialId ?? rel.buildRelationKey,
          {
            relationId: officialId ?? rel.buildRelationKey,
            typeId: rel.typeId,
            fromSlotId: from,
            toSlotId: to,
            attributes: rel.attributes,
            relationDigest: canonicalJsonSha256({ typeId: rel.typeId, fromSlotId: from, toSlotId: to, attributes: rel.attributes }),
          },
        );
      } else if (op.kind === 'update_attributes') {
        const key = op.targetId ?? '';
        const entry = input.ledgerByKey.get(key);
        if (entry === undefined || entry.officialId === null) continue;
        if (entry.kind === 'relation') {
          const existing = relationByOfficial.get(entry.officialId);
          if (existing !== undefined) {
            const attributes = op.relation !== undefined ? { ...existing.attributes, ...op.relation.attributes } : existing.attributes;
            relationByOfficial.set(entry.officialId, { ...existing, attributes, relationDigest: canonicalJsonSha256({ typeId: existing.typeId, fromSlotId: existing.fromSlotId, toSlotId: existing.toSlotId, attributes }) });
          }
        } else {
          const existing = nodeByOfficial.get(entry.officialId);
          if (existing !== undefined && op.node !== undefined) {
            nodeByOfficial.set(entry.officialId, {
              ...existing,
              documentOrder: op.node.documentOrder,
              siblingOrder: op.node.siblingOrder,
            });
          }
        }
      }
    }
  }
  return {
    nodes: [...nodeByOfficial.values()].sort((a, b) => (a.slotId < b.slotId ? -1 : 1)),
    relations: [...relationByOfficial.values()].sort((a, b) => (a.relationId < b.relationId ? -1 : 1)),
  };
}

/** The mapRootDigest of the staged map (the semantic digest — the same
 * identity the map layer uses). */
export function stagedMapDigestOf(nodes: readonly MapPositionNodeV2[], relations: readonly MapRelationV2[], snapshotHash: string): string {
  return resolveMapSemanticDigest({ templateSnapshotHash: snapshotHash, nodes, relations });
}

/* ------------------------------------------------------------------ */
/* Service dependencies                                                */
/* ------------------------------------------------------------------ */

export interface RepairServiceDependencies {
  facade: Pick<AuthoritativeAppendFacadeV2, 'prepareBlob' | 'publishWithPin'>;
  grants: GrantService;
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
  registrationsFor(
    trigger: 'repair_finalize' | 'content_commit',
    phase: 'map' | 'content' | 'batch_commit',
  ): readonly import('../../template/structured-slot-contract-v2').ValidatorRegistrationV2[];
  reviewPolicy: ReviewPolicyParameters;
  reviewPolicyDigest: string;
  templateSnapshotRef: BlobRefV2;
  profileSnapshotRef: BlobRefV2;
  /** The frozen template snapshot hash (binds every grant spec). */
  snapshotHash: string;
  orchestratorRoleBinding: string;
  generatorRoleBinding: string;
  reviewerRoleBinding: string;
  /** The durable repair-staging journals (map patches + content drafts). */
  privateStore: AuthoritativeReviewPrivateStore;
  /** slotId -> template slot type id (content schema resolution seam). */
  slotTypeOf(slotId: string): string;
  /** slotId -> resolved template content schema digest. */
  contentSchemaDigestOf(slotId: string): string;
  /** The template slot types (the engine enriches content targets with these). */
  slotTypes: readonly import('./validator-engine').ValidatorSlotType[];
  /** slot presence (required|optional) — defaults to required. */
  slotPresenceOf?(slotId: string): 'required' | 'optional';
  defaultAutomaticRetries(): Promise<number>;
}

/** The committed result of one repair batch. */
export type RepairBatchOutcome =
  | { kind: 'committed'; stagingRootRef: BlobRefV2; stagingRoot: RepairStagingRootV2; nextWorkItemId: string }
  | { kind: 'blocked'; failureCode: string }
  | { kind: 'infrastructure_failure'; failureCode: string };

/** The finalizer outcome. */
export type RepairFinalizeOutcome =
  | { kind: 'completed'; resultRefs: readonly BlobRefV2[] }
  | { kind: 'blocked'; failureCode: string; resultRefs: readonly BlobRefV2[] }
  | { kind: 'infrastructure_failure'; failureCode: string };

/** I-1 (adversarial review): the map context a repaired-Map activation passes
 * to the content re-review round — the round must bind the NEW snapshot being
 * activated, never the pre-activation map. */
export interface ContentReReviewMapContextV2 {
  mapRef: BlobRefV2;
  mapSemanticDigest: string;
}

/* ------------------------------------------------------------------ */
/* The service                                                         */
/* ------------------------------------------------------------------ */

export class RepairError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RepairError';
    this.code = code;
  }
}

/** Over-limit round creation (spec §13.3.1): the caller terminal-fails the
 * task with REVIEW_REPAIR_LIMIT_EXCEEDED. */
export class RepairLimitExceededError extends RepairError {
  constructor(roundId: string, nextOrdinal: number, maxRounds: number) {
    super('REVIEW_REPAIR_LIMIT_EXCEEDED', `${roundId === '(budget)' ? 'repair' : 'repair'} cycle budget exhausted: nextOrdinal=${nextOrdinal} > maxRounds=${maxRounds}`);
  }
}

export class RepairService {
  private readonly deps: RepairServiceDependencies;

  constructor(deps: RepairServiceDependencies) {
    this.deps = deps;
  }

  /* ------------------------- initial plan creation ---------------- */

  /**
   * The Task 18 handoff: the blocking settlement envelope. Builds the INITIAL
   * RepairPlan (origin binds the settlement's deterministic key — the
   * settlement WorkItem id + coverage-core digest + the settlement's
   * continuation operation key) and atomically publishes
   * [*_repair_plan_started, work_item_created(batch 1), repair_grant_issued,
   * command/WorkItem terminals]. The settlement command COMPLETES with this
   * envelope (the Task 15/17 blocking precedent) — never a bare
   * retryable_failure.
   */
  async createInitialRepairPlan(input: {
    taskId: string;
    settlementWorkItemId: string;
    settlementCommandId: string;
    leaseEpoch: number;
    authorityBaseRef: BlobRefV2;
    /** the settlement's continuation operation key (origin.creationOperationKey). */
    settlementOperationKey: string;
    /** the settlement coverage-core digest (origin.settlementDigest, hex). */
    settlementDigest: string;
    track: 'map' | 'content';
    findings: readonly ProjectedFindingLifecycleV2[];
    sourceReceiptRef: BlobRefV2 | null;
    repairBase: RepairPlanSpecV2['repairBase'];
    importedStagingManifestRef: BlobRefV2;
  }): Promise<{ kind: 'completed'; resultRefs: readonly BlobRefV2[] }> {
    const { taskId, track } = input;
    const repairPlanId = repairPlanIdOf(taskId, input.settlementOperationKey, track);
    const targets = await this.resolveRepairTargets(taskId, track, input.findings);
    const scopes = buildRepairBatchScopes({
      track,
      repairPlanId,
      nodeIds: targets.nodeIds,
      relationIds: targets.relationIds,
      slotIds: targets.slotIds,
      findingIds: targets.findingIds,
      reviewPolicy: this.deps.reviewPolicy,
      profile: this.deps.profile,
    });
    const keyLedger = this.initialKeyLedgerOf(repairPlanId, targets, track, 1);
    const keyLedgerRef = await this.deps.facade.prepareBlob(taskId, 'repair_key_ledger', keyLedger);
    const plan = buildRepairPlanSpec({
      repairPlanId,
      revision: 1,
      origin: {
        kind: 'initial',
        settlementId: input.settlementWorkItemId,
        settlementDigest: input.settlementDigest,
        creationOperationKey: input.settlementOperationKey,
      },
      sourceReceiptRef: input.sourceReceiptRef,
      repairBase: input.repairBase,
      orderedBatchScopes: scopes,
      keyLineageRef: keyLedgerRef,
      importedStagingManifestRef: input.importedStagingManifestRef,
    });
    const planRef = await this.deps.facade.prepareBlob(taskId, 'repair_plan_spec', plan);
    const baseStagingRoot = this.baseStagingRootOf(plan, keyLedgerRef, taskId, track, targets);
    const baseStagingRootRef = await this.deps.facade.prepareBlob(taskId, 'repair_staging_root', baseStagingRoot);
    const firstWorkItemId = repairBatchWorkItemId(taskId, repairPlanId, 1, plan.planRevisionId);
    const successor = await this.prepareRepairBatchSuccessor({
      taskId,
      plan,
      planRef,
      batchOrdinal: 0,
      nextWorkItemId: firstWorkItemId,
      isLast: false,
      currentStagingRootRef: baseStagingRootRef,
      keyLedgerRef,
    });
    const carryErrors = validateRepairSuccessorCarrier(successor.carrier, planRef);
    if (carryErrors.length > 0) {
      throw new RepairError('INVALID_INPUT', `repair successor carry invalid: ${carryErrors.join('; ')}`);
    }
    const terminal: SystemCommandTerminalCarrierV2 = {
      workItemId: input.settlementWorkItemId,
      commandId: input.settlementCommandId,
      commandKind: 'review_settlement',
      leaseEpoch: input.leaseEpoch,
      authorityBaseRef: input.authorityBaseRef,
    };
    const blobRefs = [
      keyLedgerRef,
      planRef,
      baseStagingRootRef,
      successor.authorityBaseRef,
      ...(successor.grantSpecRef === null ? [] : [successor.grantSpecRef]),
    ];
    await this.publish(taskId, {
      operationId: input.settlementOperationKey,
      publishKind: 'repair_plan_creation',
      blobRefs,
      carriers: repairCarrier({
        track,
        repairPlanId,
        planRevisionId: plan.planRevisionId,
        repairPlanSpecRef: planRef,
        sourceValidationReceiptRef: input.sourceReceiptRef,
        workItemId: firstWorkItemId,
        batchOrdinal: 1,
        grantSpecId: `gs-${firstWorkItemId}`,
        grantKind: track === 'map' ? 'map_repair_batch' : 'content_repair_batch',
        successor: successor.carrier,
        terminal,
      }),
      preparedRefs: blobRefs,
    });
    return { kind: 'completed', resultRefs: blobRefs };
  }

  /**
   * The settlement-blocking seam (Task 18 handoff): the content/map
   * settlements call this on a blocking Finding set. Routes by
   * `repairRouteOf` (any map/mixed blocking routes Map repair FIRST — the
   * mixed finding stays on the Map track until Map activation; the later
   * required content re-review is counted by the content track). Creates the
   * INITIAL plan (no lineage for the track — the settlement's deterministic
   * key) or the validation_correction SUCCESSOR (the lineage exists — a
   * previously repaired round blocked again). The envelope carries the
   * settlement command/WorkItem terminals so the coordinator REPLAYS.
   */
  async createRepairPlanFromSettlement(input: {
    taskId: string;
    settlementWorkItemId: string;
    settlementCommandId: string;
    leaseEpoch: number;
    authorityBaseRef: BlobRefV2;
    roundId: string;
    coverageCoreRef: BlobRefV2;
    findings: readonly ProjectedFindingLifecycleV2[];
  }): Promise<{ kind: 'completed'; resultRefs: readonly BlobRefV2[] }> {
    const { taskId } = input;
    const state = await this.deps.readProjection(taskId);
    const route = repairRouteOf(input.findings, 'clear');
    if (route !== 'map_repair' && route !== 'content_repair') {
      throw new RepairError('NO_REPAIR_ROUTE', `blocking findings route '${route}', not a repair route`);
    }
    const track = route === 'map_repair' ? 'map' : 'content';
    const lineage = Object.values(state.repairPlans).find((l) => l.track === track);
    const repairBase = await this.settlementRepairBase(taskId, track);
    const importedStagingManifestRef = await this.settlementImportedManifest(taskId, track);
    const operationKey = attemptContinuationOperationId(taskId, input.settlementWorkItemId, input.settlementCommandId, 'complete');
    if (lineage === undefined) {
      return this.createInitialRepairPlan({
        taskId,
        settlementWorkItemId: input.settlementWorkItemId,
        settlementCommandId: input.settlementCommandId,
        leaseEpoch: input.leaseEpoch,
        authorityBaseRef: input.authorityBaseRef,
        settlementOperationKey: operationKey,
        settlementDigest: input.coverageCoreRef.digest,
        track,
        findings: input.findings,
        sourceReceiptRef: null,
        repairBase,
        importedStagingManifestRef,
      });
    }
    const head = lineage.currentPlanRevisionId === null ? undefined : lineage.revisions[lineage.currentPlanRevisionId];
    if (head === undefined) throw new RepairError('PLAN_UNKNOWN', 'repair lineage has no current head');
    const outcome = await this.createSuccessorRepairPlan({
      taskId,
      track,
      repairPlanId: lineage.repairPlanId,
      supersededPlanSpecRef: head.specRef,
      supersededPlanRevisionId: head.planRevisionId,
      successorReason: 'validation_correction',
      successorOperationKey: operationKey,
      findings: input.findings,
      sourceReceiptRef: null,
      repairBase,
      importedStagingManifestRef,
      terminal: {
        workItemId: input.settlementWorkItemId,
        commandId: input.settlementCommandId,
        commandKind: 'review_settlement',
        leaseEpoch: input.leaseEpoch,
        authorityBaseRef: input.authorityBaseRef,
      },
    });
    return { kind: 'completed', resultRefs: outcome.resultRefs };
  }

  /** The settlement's repair base for a track (the current candidate for the
   * map track pre-activation; the activated map + current manifest otherwise). */
  private async settlementRepairBase(taskId: string, track: 'map' | 'content'): Promise<RepairPlanSpecV2['repairBase']> {
    const state = await this.deps.readProjection(taskId);
    if (track === 'map') {
      if (state.currentCandidate !== null) return { kind: 'map_candidate', candidateRef: state.currentCandidate.candidateRef };
      if (state.currentMap !== null) return { kind: 'map_active', mapRef: state.currentMap.mapSnapshotRef };
      throw new RepairError('MAP_UNRESOLVED', 'no current candidate or activated Map for the map repair route');
    }
    if (state.currentMap === null) throw new RepairError('MAP_UNRESOLVED', 'no active Map for the content repair route');
    if (state.currentManifest === null) throw new RepairError('MANIFEST_UNRESOLVED', 'no current manifest for the content repair route');
    return { kind: 'content', mapRef: state.currentMap.mapSnapshotRef, contentRevisionManifestRef: state.currentManifest.contentRevisionManifestRef };
  }

  private async settlementImportedManifest(taskId: string, track: 'map' | 'content'): Promise<BlobRefV2> {
    const state = await this.deps.readProjection(taskId);
    if (track === 'map') {
      return state.currentCandidate?.candidateRef ?? state.currentMap?.mapSnapshotRef ?? (() => {
        throw new RepairError('MAP_UNRESOLVED', 'no map base for the repair plan');
      })();
    }
    if (state.currentManifest === null) throw new RepairError('MANIFEST_UNRESOLVED', 'no current manifest for the content repair route');
    return state.currentManifest.contentRevisionManifestRef;
  }

  /* ------------------------- successor plan creation ------------- */

  /**
   * The blocking-successor envelope (spec §13.3 "competing successors"): ONE
   * `structured_repair_plan_revision_started` (successorReason
   * validation_correction — a blocked finalizer or a blocked repair round
   * creates exactly one correction successor) + the correction-batch
   * WorkItem/Grant + the §9.2 terminal pair, in ONE batch. The successor
   * revision = superseded revision + 1; per-revision batch ordinals restart
   * at 1 (the projector's per-(plan, revision) batch bookkeeping).
   */
  async createSuccessorRepairPlan(input: {
    taskId: string;
    track: 'map' | 'content';
    repairPlanId: string;
    supersededPlanSpecRef: BlobRefV2;
    supersededPlanRevisionId: string;
    successorReason: 'validation_correction' | 'recovery';
    successorOperationKey: string;
    findings: readonly ProjectedFindingLifecycleV2[];
    sourceReceiptRef: BlobRefV2 | null;
    repairBase: RepairPlanSpecV2['repairBase'];
    importedStagingManifestRef: BlobRefV2;
    terminal: SystemCommandTerminalCarrierV2;
    /** the blocking finalizer's aggregate (the rejected event's carrier). */
    validatorAggregateRef?: BlobRefV2 | null;
    validationReceiptRef?: BlobRefV2 | null;
  }): Promise<{ kind: 'completed'; resultRefs: readonly BlobRefV2[]; successorPlanSpecRef: BlobRefV2; successorPlan: RepairPlanSpecV2 }> {
    const { taskId, track } = input;
    const superseded = (await this.deps.resolver(taskId, input.supersededPlanSpecRef)) as RepairPlanSpecV2 | null;
    if (superseded === null || typeof superseded !== 'object') {
      throw new RepairError('PLAN_UNRESOLVED', 'superseded repair plan spec unresolvable');
    }
    const revision = superseded.revision + 1;
    const targets = await this.resolveRepairTargets(taskId, track, input.findings);
    const scopes = buildRepairBatchScopes({
      track,
      repairPlanId: input.repairPlanId,
      nodeIds: targets.nodeIds,
      relationIds: targets.relationIds,
      slotIds: targets.slotIds,
      findingIds: targets.findingIds,
      reviewPolicy: this.deps.reviewPolicy,
      profile: this.deps.profile,
    });
    // The successor binds its OWN key ledger (per-revision lineage); the
    // prior revision's ledger stays immutable.
    const keyLedger = this.initialKeyLedgerOf(input.repairPlanId, targets, track, revision);
    const keyLedgerRef = await this.deps.facade.prepareBlob(taskId, 'repair_key_ledger', keyLedger);
    const successorPlan = buildRepairPlanSpec({
      repairPlanId: input.repairPlanId,
      revision,
      origin: { kind: 'successor', supersedesPlanSpecRef: input.supersededPlanSpecRef, successorReason: input.successorReason, successorOperationKey: input.successorOperationKey },
      sourceReceiptRef: input.sourceReceiptRef,
      repairBase: input.repairBase,
      orderedBatchScopes: scopes,
      keyLineageRef: keyLedgerRef,
      importedStagingManifestRef: input.importedStagingManifestRef,
    });
    const successorPlanRef = await this.deps.facade.prepareBlob(taskId, 'repair_plan_spec', successorPlan);
    const baseStagingRoot = this.baseStagingRootOf(successorPlan, keyLedgerRef, taskId, track, targets);
    const baseStagingRootRef = await this.deps.facade.prepareBlob(taskId, 'repair_staging_root', baseStagingRoot);
    const firstWorkItemId = repairBatchWorkItemId(taskId, input.repairPlanId, 1, successorPlan.planRevisionId);
    const successor = await this.prepareRepairBatchSuccessor({
      taskId,
      plan: successorPlan,
      planRef: successorPlanRef,
      batchOrdinal: 0,
      nextWorkItemId: firstWorkItemId,
      isLast: false,
      currentStagingRootRef: baseStagingRootRef,
      keyLedgerRef,
    });
    const carryErrors = validateRepairSuccessorCarrier(successor.carrier, successorPlanRef);
    if (carryErrors.length > 0) {
      throw new RepairError('INVALID_INPUT', `repair successor carry invalid: ${carryErrors.join('; ')}`);
    }
    // §13.3.1: when an available override is bound to the superseded plan,
    // the successor-creation envelope moves it within the same lineage.
    const overrideTransfer = await this.prepareOverrideTransfer(taskId, input.supersededPlanSpecRef, successorPlanRef, input.successorOperationKey, input.track);
    const blobRefs = [
      keyLedgerRef,
      successorPlanRef,
      baseStagingRootRef,
      successor.authorityBaseRef,
      ...(successor.grantSpecRef === null ? [] : [successor.grantSpecRef]),
      ...(overrideTransfer === null ? [] : [overrideTransfer.overrideRef]),
    ];
    await this.publish(taskId, {
      operationId: input.successorOperationKey,
      publishKind: 'repair_plan_creation',
      blobRefs,
      carriers: repairCarrier({
        track,
        repairPlanId: input.repairPlanId,
        planRevisionId: successorPlan.planRevisionId,
        repairPlanSpecRef: successorPlanRef,
        sourceValidationReceiptRef: input.sourceReceiptRef,
        supersedesPlanRevisionId: input.supersededPlanRevisionId,
        successorReason: input.successorReason,
        validatorAggregateRef: input.validatorAggregateRef ?? null,
        validationReceiptRef: input.validationReceiptRef ?? input.sourceReceiptRef,
        workItemId: firstWorkItemId,
        batchOrdinal: 1,
        grantSpecId: `gs-${firstWorkItemId}`,
        grantKind: track === 'map' ? 'map_repair_batch' : 'content_repair_batch',
        overrideTransfer,
        successor: successor.carrier,
        terminal: input.terminal,
      }),
      preparedRefs: blobRefs,
    });
    void input.supersededPlanRevisionId;
    return { kind: 'completed', resultRefs: blobRefs, successorPlanSpecRef: successorPlanRef, successorPlan };
  }

  /* ------------------------- serial batch commit ----------------- */

  /**
   * ONE serial repair batch (spec §13.3): the batch ordinal must be the NEXT
   * uncommitted ordinal of the CURRENT active plan revision; the grant must
   * bind the exact plan spec ref + the exact current staging root
   * (expectedStagingRootRef CAS) + the exact current key ledger; every
   * operation must be inside the plan batch scope. On clear publishes
   * [*_repair_batch_committed, structured_repair_committed,
   * work_item_created(next batch OR system_repair_finalize),
   * repair_grant_issued] — NO candidate/finalized-manifest event can ever
   * ride this envelope.
   */
  async commitRepairBatch(input: {
    taskId: string;
    workItemId: string;
    attemptId: string;
    batchOrdinal: number;
    ctx: V2AttemptContext;
    /** map track: the patch to fold (submit_map_patch). */
    mapPatch?: { expectedStagingDigest: string; operations: readonly RepairMapPatchOperationV2[] };
    /** content track: the journaled slot contents (submit_content_draft). */
    slotContents?: Readonly<Record<string, { text: string; mediaType: 'text/markdown' | 'text/plain' }>>;
  }): Promise<RepairBatchOutcome> {
    const state = await this.deps.readProjection(input.taskId);
    const wi = state.workItems[input.workItemId];
    if (wi === undefined) throw new RepairError('WORK_ITEM_NOT_FOUND', `no workitem '${input.workItemId}'`);
    const grant = await this.deps.grants.resolveAttemptGrant(input.ctx);
    if (grant.spec.kind !== 'map_repair_batch' && grant.spec.kind !== 'content_repair_batch') {
      throw new RepairError('GRANT_STALE', `workitem '${input.workItemId}' carries a non-repair grant '${grant.spec.kind}'`);
    }
    const repairSpec = grant.spec as RepairBatchGrantSpecV2;
    const plan = (await this.deps.resolver(input.taskId, repairSpec.repairPlanSpecRef)) as RepairPlanSpecV2 | null;
    if (plan === null || typeof plan !== 'object') throw new RepairError('PLAN_UNRESOLVED', 'repair plan spec unresolvable');
    const track = plan.orderedBatchScopes[0]?.kind === 'map' ? 'map' : 'content';
    const current = await this.currentStagingState(input.taskId, plan, track);
    // The plan must be the CURRENT active head (a superseded revision's grant
    // can never commit — the scope-expansion supersede rule).
    if (!(await this.planIsCurrentHead(input.taskId, plan))) {
      throw new RepairError('PLAN_STALE', 'the repair plan is not the current active revision');
    }
    const totalBatches = plan.orderedBatchScopes.length;
    if (input.batchOrdinal < 1 || input.batchOrdinal > totalBatches) {
      throw new RepairError('BATCH_OUT_OF_RANGE', `batchOrdinal ${input.batchOrdinal} outside 1..${totalBatches}`);
    }
    if (input.batchOrdinal !== current.lastBatchOrdinal + 1) {
      throw new RepairError('BATCH_OUT_OF_ORDER', `batchOrdinal ${input.batchOrdinal} is not the next ordinal ${current.lastBatchOrdinal + 1}`);
    }
    if (!sameRef(repairSpec.expectedStagingRootRef, current.stagingRootRef)) {
      throw new RepairError('AUTHORITY_BASE_STALE', 'grant expectedStagingRootRef does not CAS the current staging root');
    }
    if (!sameRef(grantSpecPlanKeyLedgerRef(repairSpec) as BlobRefV2, current.keyLedgerRef)) {
      throw new RepairError('AUTHORITY_BASE_STALE', 'grant planKeyLedgerRef does not match the current key ledger');
    }
    // Same-root/different-manifest staleness: the content base manifest ref
    // must be EXACTLY the current manifest (a digest-equal but different ref
    // is stale — assertExactBase).
    if (track === 'content') {
      const contentBase = plan.repairBase;
      if (contentBase.kind !== 'content') throw new RepairError('REPAIR_BASE_STALE', 'content plan repair base is not content');
      if (state.currentManifest === null || !sameRef(state.currentManifest.contentRevisionManifestRef, contentBase.contentRevisionManifestRef)) {
        throw new RepairError('AUTHORITY_BASE_STALE', 'content repair base manifest is not the current manifest');
      }
      const manifest = (await this.deps.resolver(input.taskId, contentBase.contentRevisionManifestRef)) as ContentRevisionManifestV2 | null;
      if (manifest === null || typeof manifest !== 'object') throw new RepairError('MANIFEST_UNRESOLVED', 'repair base manifest unresolvable');
      if (repairSpec.kind === 'content_repair_batch') {
        const grantBase = repairSpec.repairBase;
        if (grantBase.kind === 'content') {
          assertExactBase(grantBase.contentRevisionManifestRef, contentBase.contentRevisionManifestRef, 'repair base manifest');
        }
      }
    }
    if (track === 'map') {
      if (repairSpec.kind !== 'map_repair_batch') throw new RepairError('GRANT_STALE', 'map plan bound to a non-map grant');
      if (input.mapPatch === undefined) throw new RepairError('PATCH_MISSING', 'map repair batch requires a patch');
    } else {
      if (repairSpec.kind !== 'content_repair_batch') throw new RepairError('GRANT_STALE', 'content plan bound to a non-content grant');
      if (input.slotContents === undefined) throw new RepairError('CONTENT_MISSING', 'content repair batch requires slot contents');
    }

    if (track === 'map') {
      const outcome = await this.commitMapRepairBatch(input, plan, repairSpec as Extract<WriteGrantSpecV2, { kind: 'map_repair_batch' }>, current);
      return outcome;
    }
    const outcome = await this.commitContentRepairBatch(input, plan, repairSpec as Extract<WriteGrantSpecV2, { kind: 'content_repair_batch' }>, current);
    return outcome;
  }

  private async commitMapRepairBatch(
    input: { taskId: string; workItemId: string; attemptId: string; batchOrdinal: number; ctx: V2AttemptContext; mapPatch?: { expectedStagingDigest: string; operations: readonly RepairMapPatchOperationV2[] } },
    plan: RepairPlanSpecV2,
    grant: RepairBatchGrantSpecV2 & { kind: 'map_repair_batch' },
    current: { stagingRootRef: BlobRefV2; keyLedgerRef: BlobRefV2; lastBatchOrdinal: number },
  ): Promise<RepairBatchOutcome> {
    const { taskId } = input;
    const planRef = grant.repairPlanSpecRef;
    const patch = input.mapPatch as { expectedStagingDigest: string; operations: readonly RepairMapPatchOperationV2[] };
    const scope = plan.orderedBatchScopes[input.batchOrdinal - 1];
    if (scope === undefined || scope.kind !== 'map') throw new RepairError('BATCH_OUT_OF_RANGE', 'no map batch scope for this ordinal');
    const ledger = (await this.deps.resolver(taskId, current.keyLedgerRef)) as RepairKeyLedgerV2 | null;
    if (ledger === null || typeof ledger !== 'object') throw new RepairError('LEDGER_UNRESOLVED', 'current key ledger unresolvable');
    const ledgerByKey = new Map(ledger.entries.map((e) => [e.planKey, e]));
    const scopeErrors = mapPatchScopeErrors(patch.operations, scope.scope, ledgerByKey);
    if (scopeErrors.length > 0) {
      throw new RepairError('WRITE_OUT_OF_SCOPE', scopeErrors.join('; '));
    }
    const currentRoot = (await this.deps.resolver(taskId, current.stagingRootRef)) as RepairStagingRootV2 | null;
    if (currentRoot === null || typeof currentRoot !== 'object') throw new RepairError('STAGING_UNRESOLVED', 'current staging root unresolvable');
    if (patch.expectedStagingDigest !== currentRoot.stagingDigest) {
      throw new RepairError('AUTHORITY_BASE_STALE', 'expectedStagingDigest does not CAS the current staging root');
    }
    const baseState = await this.repairBaseMapState(taskId, plan);
    const staged = foldRepairMapState({
      baseNodes: baseState.nodes,
      baseRelations: baseState.relations,
      patches: [...(await this.readCommittedPatches(taskId, plan, input.batchOrdinal)), { batchOrdinal: input.batchOrdinal, ops: patch.operations }],
      ledgerByKey,
    });
    const mapRootDigest = stagedMapDigestOf(staged.nodes, staged.relations, this.deps.snapshotHash);
    // New key ledger: prior entries + new keys declared by this batch.
    const newEntries: {
      planKey: string;
      kind: 'node' | 'relation';
      officialId: string | null;
      status: 'active' | 'tombstone';
      predecessorPlanKey: string | null;
    }[] = [...ledger.entries];
    for (const op of patch.operations) {
      if (op.kind === 'add_node' && op.node !== undefined && !ledgerByKey.has(op.node.buildNodeKey)) {
        newEntries.push({ planKey: op.node.buildNodeKey, kind: 'node', officialId: null, status: 'active', predecessorPlanKey: null });
      }
      if (op.kind === 'add_relation' && op.relation !== undefined && !ledgerByKey.has(op.relation.buildRelationKey)) {
        newEntries.push({ planKey: op.relation.buildRelationKey, kind: 'relation', officialId: null, status: 'active', predecessorPlanKey: null });
      }
      if ((op.kind === 'remove_node' || op.kind === 'remove_relation') && op.targetId !== undefined) {
        const existing = ledgerByKey.get(op.targetId);
        if (existing !== undefined && existing.status === 'active') {
          newEntries.push({ ...existing, status: 'tombstone' });
        }
      }
    }
    const newLedger = buildRepairKeyLedger(plan.repairPlanId, plan.planRevisionId, newEntries);
    const newLedgerRef = await this.deps.facade.prepareBlob(taskId, 'repair_key_ledger', newLedger);
    const stagingRoot = buildRepairStagingRoot({
      repairPlanId: plan.repairPlanId,
      planRevisionId: plan.planRevisionId,
      batchOrdinal: input.batchOrdinal,
      mapRootDigest,
      contentRootDigest: null,
      priorStagingRootRef: current.stagingRootRef,
      keyLedgerRef: newLedgerRef,
    });
    const stagingRootRef = await this.deps.facade.prepareBlob(taskId, 'repair_staging_root', stagingRoot);
    return this.publishBatchCommit(taskId, plan, planRef, input, stagingRootRef, newLedgerRef);
  }

  private async commitContentRepairBatch(
    input: { taskId: string; workItemId: string; attemptId: string; batchOrdinal: number; ctx: V2AttemptContext; slotContents?: Readonly<Record<string, { text: string; mediaType: 'text/markdown' | 'text/plain' }>> },
    plan: RepairPlanSpecV2,
    grant: RepairBatchGrantSpecV2 & { kind: 'content_repair_batch' },
    current: { stagingRootRef: BlobRefV2; keyLedgerRef: BlobRefV2; lastBatchOrdinal: number },
  ): Promise<RepairBatchOutcome> {
    const { taskId } = input;
    const planRef = grant.repairPlanSpecRef;
    const scope = plan.orderedBatchScopes[input.batchOrdinal - 1];
    if (scope === undefined || scope.kind !== 'content') throw new RepairError('BATCH_OUT_OF_RANGE', 'no content batch scope for this ordinal');
    const slotContents = input.slotContents as Readonly<Record<string, { text: string; mediaType: 'text/markdown' | 'text/plain' }>>;
    // Grant writes only the targeted slots — every written slot must be in
    // the batch scope AND in the grant's writeSlotIds (defense in depth).
    for (const slotId of Object.keys(slotContents)) {
      if (!scope.slotIds.includes(slotId)) {
        throw new RepairError('WRITE_OUT_OF_SCOPE', `slot '${slotId}' is not in batch ${input.batchOrdinal}`);
      }
      assertContentWriteAuthorized(grant, slotId);
    }

    const currentRoot = (await this.deps.resolver(taskId, current.stagingRootRef)) as RepairStagingRootV2 | null;
    if (currentRoot === null || typeof currentRoot !== 'object') throw new RepairError('STAGING_UNRESOLVED', 'current staging root unresolvable');
    const priorManifestRef = currentRoot.contentManifestRef ?? (plan.repairBase.kind === 'content' ? plan.repairBase.contentRevisionManifestRef : null);
    if (priorManifestRef === null) throw new RepairError('MANIFEST_UNRESOLVED', 'content staging root has no cumulative manifest');
    const priorManifest = (await this.deps.resolver(taskId, priorManifestRef)) as ContentRevisionManifestV2 | null;
    if (priorManifest === null || typeof priorManifest !== 'object') throw new RepairError('MANIFEST_UNRESOLVED', 'prior cumulative content manifest unresolvable');
    const staged = await this.stagedContentVersions(taskId, plan, planRef, priorManifestRef, priorManifest, input.batchOrdinal, slotContents, input.workItemId, input.attemptId);
    const newLedgerRef = current.keyLedgerRef;
    const stagingRoot = buildRepairStagingRoot({
      repairPlanId: plan.repairPlanId,
      planRevisionId: plan.planRevisionId,
      batchOrdinal: input.batchOrdinal,
      mapRootDigest: null,
      contentRootDigest: staged.manifest.contentRootDigest,
      contentManifestRef: staged.manifestRef,
      priorStagingRootRef: current.stagingRootRef,
      keyLedgerRef: newLedgerRef,
    });
    const stagingRootRef = await this.deps.facade.prepareBlob(taskId, 'repair_staging_root', stagingRoot);
    return this.publishBatchCommit(taskId, plan, planRef, input, stagingRootRef, newLedgerRef);
  }

  /** The batch-commit envelope (both tracks): batch_committed +
   * repair_committed + successor WorkItem (next batch OR the finalizer) +
   * repair_grant_issued. NEVER a candidate/finalized-manifest event. */
  private async publishBatchCommit(
    taskId: string,
    plan: RepairPlanSpecV2,
    planRef: BlobRefV2,
    input: { taskId: string; workItemId: string; attemptId: string; batchOrdinal: number; ctx: V2AttemptContext },
    stagingRootRef: BlobRefV2,
    keyLedgerRef: BlobRefV2,
  ): Promise<RepairBatchOutcome> {
    const track = plan.orderedBatchScopes[0]?.kind === 'map' ? 'map' : 'content';
    const isLast = input.batchOrdinal === plan.orderedBatchScopes.length;
    const nextWorkItemId = isLast
      ? repairFinalizeWorkItemId(taskId, plan.repairPlanId, plan.planRevisionId)
      : repairBatchWorkItemId(taskId, plan.repairPlanId, input.batchOrdinal + 1, plan.planRevisionId);
    const successor = await this.prepareRepairBatchSuccessor({
      taskId,
      plan,
      planRef,
      batchOrdinal: input.batchOrdinal,
      nextWorkItemId,
      isLast,
      currentStagingRootRef: stagingRootRef,
      keyLedgerRef,
    });
    const carryErrors = validateRepairSuccessorCarrier(successor.carrier, successor.planSpecRef);
    if (carryErrors.length > 0) {
      throw new RepairError('INVALID_INPUT', `repair successor carry invalid: ${carryErrors.join('; ')}`);
    }
    const operationId = repairBatchCommitOperationId(taskId, input.workItemId, input.batchOrdinal);
    const blobRefs = [
      stagingRootRef,
      keyLedgerRef,
      successor.authorityBaseRef,
      ...(successor.grantSpecRef === null ? [] : [successor.grantSpecRef]),
    ];
    await this.publish(taskId, {
      operationId,
      publishKind: 'repair_batch_commit',
      blobRefs,
      carriers: repairCarrier({
        track,
        repairPlanId: plan.repairPlanId,
        planRevisionId: plan.planRevisionId,
        batchOrdinal: input.batchOrdinal,
        stagingRootRef,
        workItemId: input.workItemId,
        attemptId: input.attemptId,
        grantSpecId: `gs-${nextWorkItemId}`,
        grantKind: track === 'map' ? 'map_repair_batch' : 'content_repair_batch',
        successor: successor.carrier,
      }),
      preparedRefs: blobRefs,
    });
    return { kind: 'committed', stagingRootRef, stagingRoot: (await this.deps.resolver(taskId, stagingRootRef)) as RepairStagingRootV2, nextWorkItemId };
  }

  /* ------------------------- finalizer ---------------------------- */

  /**
   * The `system_repair_finalize` handler. Reconstructs the COMPLETE staged
   * state from the durable repair-staging journals + committed batch events,
   * runs the `repair_finalize` validator, and:
   * - map clear: publishes the repair build chain + the complete MapReviewRound
   *   (the map-cycle boundary: mapCycleOrdinal+1, budget-checked) + finding
   *   addressed + terminals;
   * - content clear: publishes the repaired FINALIZED manifest + the complete
   *   ContentReviewRound (contentCycleOrdinal+1 via the Task 18 seam, in the
   *   SAME envelope) + finding addressed + terminals;
   * - blocking: ONE validation_correction successor (per-revision batch
   *   ordinals restart at 1);
   * - infrastructure: retryable_failure, NO successor;
   * - over-limit: the envelope terminal-fails the task with exactly one
   *   structured_task_failed_v2(REVIEW_REPAIR_LIMIT_EXCEEDED).
   */
  async executeRepairFinalize(input: {
    taskId: string;
    commandId: string;
    workItemId: string;
    commandKind: 'repair_finalize';
    leaseEpoch: number;
    authorityBaseRef: BlobRefV2;
    payloadRef: BlobRefV2;
  }): Promise<RepairFinalizeOutcome> {
    let plan: RepairPlanSpecV2 | null = null;
    let planRef: BlobRefV2 | null = null;
    try {
      const { taskId } = input;
      const state = await this.deps.readProjection(taskId);
      const wi = state.workItems[input.workItemId];
      if (wi === undefined) throw new RepairError('WORK_ITEM_NOT_FOUND', `no workitem '${input.workItemId}'`);
      const base = (await this.deps.resolver(taskId, input.authorityBaseRef)) as {
        planSpecRef: BlobRefV2 | null;
        stagingManifestRef: BlobRefV2 | null;
        mapRef: BlobRefV2 | null;
        mapCandidateRef: BlobRefV2 | null;
      } | null;
      if (base === null || typeof base !== 'object' || base.planSpecRef === null || base.stagingManifestRef === null) {
        throw new RepairError('GRANT_STALE', 'repair finalize authority base is unresolvable or missing plan/staging refs');
      }
      plan = (await this.deps.resolver(taskId, base.planSpecRef)) as RepairPlanSpecV2 | null;
      if (plan === null || typeof plan !== 'object') throw new RepairError('PLAN_UNRESOLVED', 'repair plan spec unresolvable');
      planRef = base.planSpecRef;
      if (input.payloadRef.kind !== 'repair_plan_spec' || input.payloadRef.digest !== base.planSpecRef.digest) {
        throw new RepairError('GRANT_STALE', 'repair finalize payload does not match the authority base plan');
      }
      if (!(await this.planIsCurrentHead(taskId, plan))) {
        throw new RepairError('PLAN_STALE', 'the repair plan is not the current active revision');
      }
      const track = plan.orderedBatchScopes[0]?.kind === 'map' ? 'map' : 'content';
      const current = await this.currentStagingState(taskId, plan, track);
      if (!sameRef(base.stagingManifestRef, current.stagingRootRef)) {
        throw new RepairError('GRANT_STALE', 'finalize staging base does not match the current staging root');
      }
      const findingSetRef = await this.prepareFindingSet(taskId, plan);

      // Reconstruct the complete staged state + run the validator.
      const staged = await this.reconstructStagedState(taskId, plan, base.planSpecRef, track);
      const run = await this.runFinalizeValidator(input, plan, track, staged);
      await this.persistEngineOutputs(taskId, run.run, run.store);
      if (run.run.aggregate.outcome === 'blocking_invalid') {
        const receipt = run.run.receipts[0];
        if (receipt === undefined) throw new RepairError('RECEIPT_MISSING', 'blocking repair finalizer produced no receipt');
        const resultRefs = await this.publishBlockingFinalize(input, plan, base.planSpecRef, track, run.run);
        return { kind: 'blocked', failureCode: 'REPAIR_PLAN_BLOCKED', resultRefs };
      }
      if (run.run.aggregate.outcome !== 'clear') {
        return { kind: 'infrastructure_failure', failureCode: 'VALIDATOR_INFRASTRUCTURE_FAILURE' };
      }

      if (track === 'map') {
        return await this.publishMapFinalizeClear(input, plan, staged, run, findingSetRef);
      }
      return await this.publishContentFinalizeClear(input, plan, base.planSpecRef, staged, run, findingSetRef);
    } catch (error) {
      if (error instanceof RepairLimitExceededError) {
        // §13.3.1 over-limit: the envelope terminal-fails the task with
        // EXACTLY ONE structured_task_failed_v2(REVIEW_REPAIR_LIMIT_EXCEEDED)
        // and publishes NO round/RepairPlan/candidate/manifest.
        try {
          if (plan === null || planRef === null) throw new RepairError('PLAN_UNRESOLVED', 'repair plan unresolvable on the over-limit path');
          const state = await this.deps.readProjection(input.taskId);
          const track = plan.orderedBatchScopes[0]?.kind === 'map' ? 'map' : 'content';
          // M1 (adversarial review): the rejectedSubjectRef must be a legal
          // recovery ref kind (map_candidate|map_snapshot for map,
          // content_revision_manifest for content — the projector's
          // applyTaskFailed `recovery_ref_kind`). The old `?? planRef` fallback
          // (a repair_plan_spec ref) was a latent corruption trap; it is
          // UNREACHABLE today (a map-track finalize always has the repair
          // base's candidate or an activated map; a content-track finalize
          // requires the current manifest) — fail closed instead of trapping.
          const rejectedSubjectRef =
            track === 'map'
              ? (state.currentCandidate?.candidateRef ?? state.currentMap?.mapSnapshotRef ?? (() => {
                  throw new RepairError('MAP_UNRESOLVED', 'over-limit recovery needs a current candidate or activated map');
                })())
              : (state.currentManifest?.contentRevisionManifestRef ?? (() => {
                  throw new RepairError('MANIFEST_UNRESOLVED', 'over-limit recovery needs a current manifest');
                })());
          const findingSetRef = await this.prepareFindingSet(input.taskId, plan);
          await this.publishOverLimitFailure({
            taskId: input.taskId,
            commandId: input.commandId,
            workItemId: input.workItemId,
            commandKind: input.commandKind,
            leaseEpoch: input.leaseEpoch,
            authorityBaseRef: input.authorityBaseRef,
            track,
            failedCycleOrdinal: (track === 'map' ? state.mapCycleOrdinal : state.contentCycleOrdinal) + 1,
            rejectedSubjectRef,
            findingSetRef,
          });
          return { kind: 'completed', resultRefs: [findingSetRef] };
        } catch (limitError) {
          return { kind: 'infrastructure_failure', failureCode: limitError instanceof RepairError ? limitError.code : 'REPAIR_LIMIT_FAILURE' };
        }
      }
      if (error instanceof RepairError) {
        return { kind: 'infrastructure_failure', failureCode: error.code };
      }
      return { kind: 'infrastructure_failure', failureCode: 'REPAIR_FINALIZE_FAILED' };
    }
  }

  /** Clear map finalize: the repair build chain + candidate + the complete
   * MapReviewRound (the map-cycle boundary) + finding addressed + terminals. */
  private async publishMapFinalizeClear(
    input: { taskId: string; commandId: string; workItemId: string; commandKind: 'repair_finalize'; leaseEpoch: number; authorityBaseRef: BlobRefV2; payloadRef: BlobRefV2 },
    plan: RepairPlanSpecV2,
    staged: { nodes: readonly MapPositionNodeV2[]; relations: readonly MapRelationV2[]; lastStagingRootRef: BlobRefV2; lastLedgerRef: BlobRefV2; attempts: { workItemId: string; attemptId: string }[] },
    run: { run: TriggerExecutionResult },
    findingSetRef: BlobRefV2,
  ): Promise<RepairFinalizeOutcome> {
    const { taskId } = input;
    const state = await this.deps.readProjection(taskId);
    // §13.3.1 map-cycle boundary: nextOrdinal > maxRounds requires the exact
    // available map override (consumed in the round-created event).
    const nextMapOrdinal = state.mapCycleOrdinal + 1;
    const overrideRef = await this.resolveAvailableOverrideRef(taskId, 'map', plan);
    mapRoundBudgetCheck({
      nextOrdinal: nextMapOrdinal,
      maxRounds: this.deps.reviewPolicy.maxRounds,
      availableOverride: state.availableOverride,
      overrideRef,
    });

    // Official id allocation — ONLY here (spec §13.3 "Official IDs are
    // allocated only by finalizer"). New plan keys get deterministic ids.
    const officialNodes = staged.nodes.map((n) =>
      n.slotId.startsWith('pk-') ? { ...n, slotId: repairOfficialNodeIdOf(plan.repairPlanId, n.slotId) } : n,
    );
    const officialRelations = staged.relations.map((r) =>
      r.relationId.startsWith('pk-') ? { ...r, relationId: repairOfficialRelationIdOf(plan.repairPlanId, r.relationId) } : r,
    );
    const nodeIdByPlanKey = new Map<string, string>();
    const relationIdByPlanKey = new Map<string, string>();
    const ledger = (await this.deps.resolver(taskId, staged.lastLedgerRef)) as RepairKeyLedgerV2 | null;
    const ledgerEntries: {
      planKey: string;
      kind: 'node' | 'relation';
      officialId: string | null;
      status: 'active' | 'tombstone';
      predecessorPlanKey: string | null;
    }[] =
      ledger !== null && typeof ledger === 'object'
        ? ledger.entries.map((e) => {
            if (e.officialId !== null) return e;
            const officialId =
              e.kind === 'node'
                ? repairOfficialNodeIdOf(plan.repairPlanId, e.planKey)
                : repairOfficialRelationIdOf(plan.repairPlanId, e.planKey);
            if (e.kind === 'node') nodeIdByPlanKey.set(e.planKey, officialId);
            else relationIdByPlanKey.set(e.planKey, officialId);
            return { ...e, officialId };
          })
        : [];
    // Re-map relation endpoints that were plan keys.
    const remappedRelations = officialRelations.map((r) => ({
      ...r,
      fromSlotId: r.fromSlotId.startsWith('pk-') ? (nodeIdByPlanKey.get(r.fromSlotId) ?? r.fromSlotId) : r.fromSlotId,
      toSlotId: r.toSlotId.startsWith('pk-') ? (nodeIdByPlanKey.get(r.toSlotId) ?? r.toSlotId) : r.toSlotId,
      relationDigest: canonicalJsonSha256({
        typeId: r.typeId,
        fromSlotId: r.fromSlotId.startsWith('pk-') ? (nodeIdByPlanKey.get(r.fromSlotId) ?? r.fromSlotId) : r.fromSlotId,
        toSlotId: r.toSlotId.startsWith('pk-') ? (nodeIdByPlanKey.get(r.toSlotId) ?? r.toSlotId) : r.toSlotId,
        attributes: r.attributes,
      }),
    }));
    // The staged nodes that were added via plan keys must also be re-parented.
    const remappedNodes = officialNodes.map((n) => ({
      ...n,
      parentSlotId: n.parentSlotId !== null && n.parentSlotId.startsWith('pk-') ? (nodeIdByPlanKey.get(n.parentSlotId) ?? n.parentSlotId) : n.parentSlotId,
    }));
    const remappedLedger = buildRepairKeyLedger(plan.repairPlanId, plan.planRevisionId, ledgerEntries);
    const remappedLedgerRef = await this.deps.facade.prepareBlob(taskId, 'repair_key_ledger', remappedLedger);
    const remappedStaged = { nodes: remappedNodes, relations: remappedRelations };

    const buildId = repairBuildIdOf(plan.repairPlanId, plan.planRevisionId);
    const buildSpec: { mapBuildId: string; revision: number; supersedesMapBuildId: string | null; sourceValidationReceiptRef: BlobRefV2 | null; snapshotHash: string; plannedChunkPolicy: { maxChunks: number; maxNodesPerChunk: number; maxRelationsPerChunk: number } } = {
      mapBuildId: buildId,
      revision: 1,
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
      snapshotHash: this.deps.snapshotHash,
      plannedChunkPolicy: { maxChunks: 1, maxNodesPerChunk: this.deps.profile.maxSlots, maxRelationsPerChunk: this.deps.profile.maxRelationTotal },
    };
    const buildSpecBody = { ...buildSpec } as Record<string, unknown>;
    const buildSpecRef = await this.deps.facade.prepareBlob(taskId, 'map_build_spec', { ...buildSpecBody, specDigest: canonicalJsonSha256(buildSpecBody) });
    const contribution = buildRepairContributionManifest({
      repairPlanId: plan.repairPlanId,
      planRevision: plan.revision,
      stagingRootRef: staged.lastStagingRootRef,
      keyLedgerRefs: [remappedLedgerRef],
      agentAttemptIdentities: staged.attempts,
    });
    const contributionRef = await this.deps.facade.prepareBlob(taskId, 'contribution_manifest', contribution);
    const candidateId = repairCandidateIdOf(plan.repairPlanId, plan.planRevisionId);
    const candidateCore = buildRepairCandidateCore({
      candidateId,
      baseMapId: state.currentMap?.mapId ?? state.currentCandidate?.candidateId ?? null,
      repairPlanId: plan.repairPlanId,
      repairPlanRevision: plan.revision,
      snapshotHash: this.deps.snapshotHash,
      producerWorkItemId: input.workItemId,
      commandId: input.commandId,
      contributionManifestRef: contributionRef,
      nodes: remappedStaged.nodes,
      relations: remappedStaged.relations,
    });
    const candidateCoreRef = await this.deps.facade.prepareBlob(taskId, 'map_candidate_validation_core', candidateCore);
    const custody = buildRepairWarningCustodyRoot({
      taskId,
      inputRef: run.run.envelopeRef,
      inputDigest: run.run.envelopeRef.digest,
      aggregateRef: run.run.aggregateRef,
      warningRootRef: refOfBlob('validation_warning_root', run.run.warningRoot),
      repairPlanId: plan.repairPlanId,
      planRevisionId: plan.planRevisionId,
      phase: 'map',
    });
    const custodyRef = await this.deps.facade.prepareBlob(taskId, 'validation_warning_custody_root', custody);
    const candidate = buildRepairCandidateSnapshot({
      candidateId,
      baseMapId: state.currentMap?.mapId ?? state.currentCandidate?.candidateId ?? null,
      validationCoreRef: candidateCoreRef,
      candidateValidationAggregateRef: run.run.aggregateRef,
      candidateWarningCustodyRootRef: custodyRef,
      createdAt: this.deps.clock(),
    });
    const candidateRef = await this.deps.facade.prepareBlob(taskId, 'map_candidate', candidate);
    // The complete MapReviewRound (map-cycle boundary). The assignmentIds MUST
    // match the settlement's deterministic round rebuild (readRoundBlob:
    // reviewAssignmentIdOf(roundId, i) x assignmentCount + the whole-assignment
    // id) — a divergent round blob binds an unprepared ref and the projection
    // corrupts (fix-round defect, exposed by the repair-round settlement).
    const roundId = mapRepairRoundId(taskId, nextMapOrdinal, candidateRef);
    const currentManifestRef: BlobRefV2 | null = state.currentManifest?.contentRevisionManifestRef ?? null;
    const repairAssignmentCount = resolveRoundAssignmentCount(remappedStaged.nodes.length, remappedStaged.relations.length, this.deps.profile);
    const repairAssignmentIds = Array.from({ length: repairAssignmentCount }, (_, i) => reviewAssignmentIdOf(roundId, i)).concat([reviewWholeAssignmentId(roundId)]);
    const round = buildMapReviewRound({
      mapReviewRoundId: roundId,
      candidateId,
      candidateDigest: candidateRef.digest,
      contentRevisionManifestRef: currentManifestRef,
      contentRootDigest: null,
      reviewPolicyDigest: this.deps.reviewPolicyDigest,
      coverageNodeIds: remappedStaged.nodes.map((n) => n.slotId),
      coverageRelationIds: remappedStaged.relations.map((r) => r.relationId),
      assignmentIds: repairAssignmentIds,
      verificationFindingStages: await this.verificationStagesOfPlan(taskId, plan, 'map'),
    });
    const roundRef = await this.deps.facade.prepareBlob(taskId, 'map_review_round', round);
    const plannedFindingStageRootRef = await this.deps.facade.prepareBlob(taskId, 'finding_stage_root', buildEmptyFindingStageRoot(roundId));
    const coverageCore = buildMapReviewCoverageCore({
      mapReviewRoundId: roundId,
      candidateRef,
      contentRevisionManifestRef: state.currentManifest?.contentRevisionManifestRef ?? null,
      contentRootDigest: null,
      reviewPolicyDigest: this.deps.reviewPolicyDigest,
      coverageLedgerRootRefs: [],
      wholeMapObservationRootRefs: [],
      findingStageRootRef: plannedFindingStageRootRef,
    });
    const coverageCoreRef = await this.deps.facade.prepareBlob(taskId, 'map_review_coverage_core', coverageCore);
    const reviewWorkItems = await this.prepareMapReviewWorkItems(taskId, round, roundRef, coverageCoreRef, candidateRef);
    const roundCarrier: MapReviewRoundPlanCarrierV2 = {
      mapReviewRoundId: roundId,
      mapCycleOrdinal: nextMapOrdinal,
      candidateId,
      candidateRef,
      contentRevisionManifestRef: state.currentManifest?.contentRevisionManifestRef ?? null,
      reviewPolicyDigest: this.deps.reviewPolicyDigest,
      coverageNodeCount: remappedStaged.nodes.length,
      coverageRelationCount: remappedStaged.relations.length,
      assignmentCount: repairAssignmentCount,
      consumedOverrideRef: overrideRef,
    };
    const terminal: SystemCommandTerminalCarrierV2 = {
      workItemId: input.workItemId,
      commandId: input.commandId,
      commandKind: input.commandKind,
      leaseEpoch: input.leaseEpoch,
      authorityBaseRef: input.authorityBaseRef,
    };
    const operationId = repairFinalizeOperationId(taskId, input.workItemId, input.commandId);
    const blobRefs = [
      findingSetRef,
      run.run.aggregateRef,
      buildSpecRef,
      contributionRef,
      candidateCoreRef,
      custodyRef,
      candidateRef,
      roundRef,
      plannedFindingStageRootRef,
      coverageCoreRef,
      remappedLedgerRef,
      ...reviewWorkItems.preparedRefs,
    ];
    await this.publish(taskId, {
      operationId,
      publishKind: 'repair_finalize',
      blobRefs,
      carriers: repairCarrier({
        track: 'map',
        repairPlanId: plan.repairPlanId,
        planRevisionId: plan.planRevisionId,
        addressedFindingIds: await this.planFindingIds(taskId, plan),
        repairBuildStart: {
          mapBuildId: buildId,
          revision: 1,
          mapBuildSpecRef: buildSpecRef,
          supersedesMapBuildId: null,
          sourceValidationReceiptRef: null,
        },
        repairBuildFinish: { mapBuildId: buildId, expectedChunkCount: 1, expectedFrontierDigest: staged.lastStagingRootRef.digest, expectedRootCount: 1 },
        mapBuildManifestRef: contributionRef,
        contributionManifestRef: contributionRef,
        candidateId,
        candidateDigest: candidateRef.digest,
        candidateRef,
        baseMapId: state.currentMap?.mapId ?? state.currentCandidate?.candidateId ?? null,
        mapRound: roundCarrier,
        reviewWorkItems: reviewWorkItems.carriers,
        terminal,
      }),
      preparedRefs: blobRefs,
    });
    return { kind: 'completed', resultRefs: blobRefs };
  }

  /** Clear content finalize: the repaired FINALIZED manifest + the complete
   * ContentReviewRound (contentCycleOrdinal+1 — the Task 18 seam is called
   * HERE, in the SAME atomic envelope) + finding addressed + terminals. */
  private async publishContentFinalizeClear(
    input: { taskId: string; commandId: string; workItemId: string; commandKind: 'repair_finalize'; leaseEpoch: number; authorityBaseRef: BlobRefV2; payloadRef: BlobRefV2 },
    plan: RepairPlanSpecV2,
    planRef: BlobRefV2,
    staged: { entries: { slotId: string; versionRef: BlobRefV2 }[]; versions: Map<string, SlotContentVersionV2>; lastStagingRootRef: BlobRefV2 },
    run: { run: TriggerExecutionResult },
    findingSetRef: BlobRefV2,
  ): Promise<RepairFinalizeOutcome> {
    const { taskId } = input;
    const state = await this.deps.readProjection(taskId);
    const nextContentOrdinal = state.contentCycleOrdinal + 1;
    const overrideRef = await this.resolveAvailableOverrideRef(taskId, 'content', plan);
    contentRoundBudgetCheck({
      nextOrdinal: nextContentOrdinal,
      maxRounds: this.deps.reviewPolicy.maxRounds,
      availableOverride: state.availableOverride,
      overrideRef,
    });
    const contentBase = plan.repairBase;
    if (contentBase.kind !== 'content') throw new RepairError('REPAIR_BASE_STALE', 'content plan repair base is not content');
    const baseManifest = (await this.deps.resolver(taskId, contentBase.contentRevisionManifestRef)) as ContentRevisionManifestV2 | null;
    if (baseManifest === null || typeof baseManifest !== 'object') throw new RepairError('MANIFEST_UNRESOLVED', 'repair base manifest unresolvable');
    if (state.currentMap === null) throw new RepairError('MAP_UNRESOLVED', 'content repair requires an active Map');
    // Unchanged out-of-scope version refs are BYTE-IDENTICAL (the base
    // manifest's entries ride through untouched); repaired slots get their
    // staged versions.
    const stagedBySlot = new Map(staged.entries.map((e) => [e.slotId, e]));
    const finalEntries: { slotId: string; versionRef: BlobRefV2 }[] = baseManifest.entries.map((e) => stagedBySlot.get(e.slotId) ?? e);
    const resolvedVersions = new Map<string, SlotContentVersionV2>();
    for (const entry of finalEntries) {
      const version = staged.versions.get(entry.slotId) ?? ((await this.deps.resolver(taskId, entry.versionRef)) as SlotContentVersionV2 | null);
      if (version !== null && typeof version === 'object') resolvedVersions.set(entry.slotId, version);
    }
    const custody = buildRepairWarningCustodyRoot({
      taskId,
      inputRef: run.run.envelopeRef,
      inputDigest: run.run.envelopeRef.digest,
      aggregateRef: run.run.aggregateRef,
      warningRootRef: run.run.warningRootRef,
      repairPlanId: plan.repairPlanId,
      planRevisionId: plan.planRevisionId,
      phase: 'content',
    });
    const custodyRef = await this.deps.facade.prepareBlob(taskId, 'validation_warning_custody_root', custody);
    const finalized = buildFinalizedManifest({
      taskId,
      mapRef: state.currentMap.mapSnapshotRef,
      mapSemanticDigest: state.currentMap.mapSemanticDigest,
      taskContentRevision: baseManifest.taskContentRevision + 1,
      priorManifestRef: contentBase.contentRevisionManifestRef,
      producerPlanSpecRef: planRef,
      entries: finalEntries,
      resolvedVersions,
      finalizerValidatorAggregateRefs: [run.run.aggregateRef],
      finalizerWarningRootRefs: [custodyRef],
    });
    const finalizedRef = await this.deps.facade.prepareBlob(taskId, 'content_revision_manifest', finalized);
    // The COMPLETE content re-review round (Task 18 seam: contentCycleOrdinal
    // increments exactly once, budget-checked, in THIS envelope). I-3: the
    // round carries the plan's addressed-but-unverified CONTENT stages (the
    // settlement gate demands their verification records).
    const setSlotIds = [...resolvedVersions.entries()].filter(([, v]) => v.state === 'set').map(([slotId]) => slotId).sort();
    const verificationStages = (await this.verificationStagesOfPlan(taskId, plan, 'content')).filter((s) => s.endsWith(':content'));
    const round = await this.prepareContentRound(taskId, finalizedRef, setSlotIds, nextContentOrdinal, overrideRef, undefined, verificationStages);
    const terminal: SystemCommandTerminalCarrierV2 = {
      workItemId: input.workItemId,
      commandId: input.commandId,
      commandKind: input.commandKind,
      leaseEpoch: input.leaseEpoch,
      authorityBaseRef: input.authorityBaseRef,
    };
    const operationId = repairFinalizeOperationId(taskId, input.workItemId, input.commandId);
    const blobRefs = [
      findingSetRef,
      run.run.aggregateRef,
      run.run.warningRootRef,
      custodyRef,
      finalizedRef,
      ...round.preparedRefs,
    ];
    await this.publish(taskId, {
      operationId,
      publishKind: 'repair_finalize',
      blobRefs,
      carriers: repairCarrier({
        track: 'content',
        repairPlanId: plan.repairPlanId,
        planRevisionId: plan.planRevisionId,
        addressedFindingIds: await this.planFindingIds(taskId, plan),
        contentRevisionManifestRef: finalizedRef,
        taskContentRevision: finalized.taskContentRevision,
        manifestPhase: 'finalized',
        priorManifestRef: contentBase.contentRevisionManifestRef,
        contentRound: round.round,
        reviewWorkItems: round.reviewWorkItems,
        terminal,
      }),
      preparedRefs: blobRefs,
    });
    return { kind: 'completed', resultRefs: blobRefs };
  }

  /** Blocking finalize: ONE validation_correction successor + correction-batch
   * WorkItem/Grant + the §9.2 terminal pair, in ONE batch (the Task 15/17
   * blocking precedent). */
  private async publishBlockingFinalize(
    input: { taskId: string; commandId: string; workItemId: string; commandKind: 'repair_finalize'; leaseEpoch: number; authorityBaseRef: BlobRefV2; payloadRef: BlobRefV2 },
    plan: RepairPlanSpecV2,
    planRef: BlobRefV2,
    track: 'map' | 'content',
    run: TriggerExecutionResult,
  ): Promise<readonly BlobRefV2[]> {
    const { taskId } = input;
    const receipt = run.receipts[0];
    const receiptRef = await this.deps.facade.prepareBlob(taskId, 'validation_receipt', receipt);
    const findings = await this.projectPlanFindings(taskId, plan);
    const targets = await this.resolveRepairTargets(taskId, track, findings);
    const scopes = buildRepairBatchScopes({
      track,
      repairPlanId: plan.repairPlanId,
      nodeIds: targets.nodeIds,
      relationIds: targets.relationIds,
      slotIds: targets.slotIds,
      findingIds: targets.findingIds,
      reviewPolicy: this.deps.reviewPolicy,
      profile: this.deps.profile,
    });
    const revision = plan.revision + 1;
    const keyLedger = this.initialKeyLedgerOf(plan.repairPlanId, targets, track, revision);
    const keyLedgerRef = await this.deps.facade.prepareBlob(taskId, 'repair_key_ledger', keyLedger);
    const successorPlan = buildRepairPlanSpec({
      repairPlanId: plan.repairPlanId,
      revision,
      origin: { kind: 'successor', supersedesPlanSpecRef: planRef, successorReason: 'validation_correction', successorOperationKey: repairFinalizeOperationId(taskId, input.workItemId, input.commandId) },
      sourceReceiptRef: receiptRef,
      repairBase: plan.repairBase,
      orderedBatchScopes: scopes,
      keyLineageRef: keyLedgerRef,
      importedStagingManifestRef: plan.importedStagingManifestRef,
    });
    const successorPlanRef = await this.deps.facade.prepareBlob(taskId, 'repair_plan_spec', successorPlan);
    const baseStagingRoot = this.baseStagingRootOf(successorPlan, keyLedgerRef, taskId, track, targets);
    const baseStagingRootRef = await this.deps.facade.prepareBlob(taskId, 'repair_staging_root', baseStagingRoot);
    const firstWorkItemId = repairBatchWorkItemId(taskId, plan.repairPlanId, 1, successorPlan.planRevisionId);
    const successor = await this.prepareRepairBatchSuccessor({
      taskId,
      plan: successorPlan,
      planRef: successorPlanRef,
      batchOrdinal: 0,
      nextWorkItemId: firstWorkItemId,
      isLast: false,
      currentStagingRootRef: baseStagingRootRef,
      keyLedgerRef,
    });
    const carryErrors = validateRepairSuccessorCarrier(successor.carrier, successorPlanRef);
    if (carryErrors.length > 0) {
      throw new RepairError('INVALID_INPUT', `repair successor carry invalid: ${carryErrors.join('; ')}`);
    }
    const overrideTransfer = await this.prepareOverrideTransfer(taskId, planRef, successorPlanRef, repairFinalizeOperationId(taskId, input.workItemId, input.commandId), track);
    const blobRefs = [
      receiptRef,
      run.aggregateRef,
      keyLedgerRef,
      successorPlanRef,
      baseStagingRootRef,
      successor.authorityBaseRef,
      ...(successor.grantSpecRef === null ? [] : [successor.grantSpecRef]),
      ...(overrideTransfer === null ? [] : [overrideTransfer.overrideRef]),
    ];
    // The blocking envelope rides the REPAIR_FINALIZE kind: plan_rejected +
    // ONE correction revision + the correction-batch WorkItem/Grant + the
    // §9.2 terminal pair (the Task 15/17 blocking precedent).
    await this.publish(taskId, {
      operationId: repairFinalizeOperationId(taskId, input.workItemId, input.commandId),
      publishKind: 'repair_finalize',
      blobRefs,
      carriers: repairCarrier({
        track,
        repairPlanId: plan.repairPlanId,
        planRevisionId: successorPlan.planRevisionId,
        repairPlanSpecRef: successorPlanRef,
        supersedesPlanRevisionId: plan.planRevisionId,
        successorReason: 'validation_correction',
        successorPlanSpecRef: successorPlanRef,
        validatorAggregateRef: run.aggregateRef,
        validationReceiptRef: receiptRef,
        workItemId: firstWorkItemId,
        batchOrdinal: 1,
        grantSpecId: `gs-${firstWorkItemId}`,
        grantKind: track === 'map' ? 'map_repair_batch' : 'content_repair_batch',
        overrideTransfer,
        successor: successor.carrier,
        terminal: {
          workItemId: input.workItemId,
          commandId: input.commandId,
          commandKind: input.commandKind,
          leaseEpoch: input.leaseEpoch,
          authorityBaseRef: input.authorityBaseRef,
        },
      }),
      preparedRefs: blobRefs,
    });
    return blobRefs;
  }

  /** Over-limit: publish the terminal-fail envelope DIRECTLY (the coordinator
   * replays the committed batch via its terminal op id). Exactly one
   * structured_task_failed_v2(REVIEW_REPAIR_LIMIT_EXCEEDED) + the
   * restart_review_cycle failure-recovery payload — no round/RepairPlan/
   * candidate/manifest. NOTE (M1, adversarial review): this returns
   * `{kind:'completed'}` while the TASK is FAILED — the kind reflects the
   * COMMAND's disposition (the terminal-fail envelope IS the command's
   * deterministic completion; decision 12), not the task status (which the
   * projector flips to failed via the structured_task_failed_v2 event). */
  async publishOverLimitFailure(input: {
    taskId: string;
    commandId: string;
    workItemId: string;
    commandKind: 'repair_finalize' | 'review_settlement';
    leaseEpoch: number;
    authorityBaseRef: BlobRefV2;
    track: 'map' | 'content';
    failedCycleOrdinal: number;
    rejectedSubjectRef: BlobRefV2;
    findingSetRef: BlobRefV2;
  }): Promise<{ kind: 'completed'; resultRefs: readonly BlobRefV2[] }> {
    const { taskId } = input;
    const terminalOpId = repairTerminalOperationId(taskId, input.workItemId, input.commandId);
    const terminalEventId = deterministicEventId(terminalOpId, 'work_item_terminal_failed', 0);
    const payload = buildFailureRecoveryPayload({
      track: input.track,
      failedWorkItemId: input.workItemId,
      failedAttemptOrCommandId: input.commandId,
      failedLeaseEpoch: input.leaseEpoch,
      terminalEventId,
      terminalCommitId: terminalOpId,
      authorityBaseRef: input.authorityBaseRef,
      rejectedSubjectRef: input.rejectedSubjectRef,
      findingSetRef: input.findingSetRef,
      failedCycleOrdinal: input.failedCycleOrdinal,
    });
    const payloadRef = await this.deps.facade.prepareBlob(taskId, 'failure_recovery_payload', payload);
    const tail = await this.deps.tail(taskId);
    await this.deps.facade.publishWithPin({
      taskId,
      operationId: terminalOpId,
      payload: {
        family: 'lease_or_retry',
        operationId: terminalOpId,
        taskId,
        workItemId: input.workItemId,
        leaseEpoch: input.leaseEpoch,
        eventBuilder: 'work_item_terminal_failed',
        authorityBaseRef: input.authorityBaseRef,
        kind: input.commandKind === 'repair_finalize' ? 'system_repair_finalize' : 'system_review_settlement',
        roleBinding: null,
        agentExecutionKind: null,
        sessionKind: null,
        roundId: null,
        logicalAssignmentId: null,
        reviewAssignmentId: null,
        grantSpecRef: null,
        inputArtifactDeliveryId: null,
        payloadRef: input.rejectedSubjectRef,
        initialLeaseEpoch: 0,
        maxAutomaticRetries: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        expectedLastSequence: null,
        attemptFamily: 'command',
        attemptId: null,
        commandId: input.commandId,
        agentId: null,
        commandKind: input.commandKind,
        dispatchRef: null,
        grantInstanceRef: null,
        reason: null,
        failureCode: 'REVIEW_REPAIR_LIMIT_EXCEEDED',
        failureDigest: canonicalJsonSha256({ commandId: input.commandId, code: 'REVIEW_REPAIR_LIMIT_EXCEEDED', track: input.track, failedCycleOrdinal: input.failedCycleOrdinal }),
        retryOrdinal: null,
        retryNotBefore: null,
        validatorAggregateRef: null,
        budgetPolicyDigest: null,
        failureRecoveryPayloadRef: payloadRef,
        taskFailure: true,
        resultRefs: [],
      },
      intent: { handlerKind: 'work_item_terminal_failed', handlerVersion: 1 },
      preparedRefs: [input.authorityBaseRef, payloadRef],
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    return { kind: 'completed', resultRefs: [payloadRef] };
  }

  /** Atomic content-cycle budget boundary used by repaired-Map activation.
   * The settlement command terminal-fails the task before map_activated or a
   * content round can be published. */
  async publishContentActivationOverLimitFailure(input: {
    taskId: string;
    commandId: string;
    workItemId: string;
    leaseEpoch: number;
    authorityBaseRef: BlobRefV2;
    repairPlanId: string;
    rejectedManifestRef: BlobRefV2;
    failedCycleOrdinal: number;
  }): Promise<{ kind: 'completed'; resultRefs: readonly BlobRefV2[] }> {
    const state = await this.deps.readProjection(input.taskId);
    const lineage = state.repairPlans[input.repairPlanId];
    const revision = lineage?.currentPlanRevisionId === null || lineage?.currentPlanRevisionId === undefined
      ? undefined
      : lineage.revisions[lineage.currentPlanRevisionId];
    if (revision === undefined) throw new RepairError('PLAN_UNRESOLVED', 'repaired-Map budget failure cannot resolve its repair plan');
    const plan = (await this.deps.resolver(input.taskId, revision.specRef)) as RepairPlanSpecV2 | null;
    if (plan === null) throw new RepairError('PLAN_UNRESOLVED', 'repaired-Map budget failure plan bytes are unresolvable');
    const findingSetRef = await this.prepareFindingSet(input.taskId, plan);
    return this.publishOverLimitFailure({
      taskId: input.taskId,
      commandId: input.commandId,
      workItemId: input.workItemId,
      commandKind: 'review_settlement',
      leaseEpoch: input.leaseEpoch,
      authorityBaseRef: input.authorityBaseRef,
      track: 'content',
      failedCycleOrdinal: input.failedCycleOrdinal,
      rejectedSubjectRef: input.rejectedManifestRef,
      findingSetRef,
    });
  }

  /* ------------------------- scope expansion ---------------------- */

  /** The Task 13 `request_scope_expansion` tool seam: publishes
   * `structured_repair_scope_requested` (the plan must be the current head —
   * demandRepairHead). */
  async requestScopeExpansion(
    ctx: V2AttemptContext,
    params: { findingIds: string[]; requestedNodeIds?: string[]; requestedRelationIds?: string[]; requestedSlotIds?: string[]; reason: string; clientOperationId: string },
  ): Promise<{ requestId: string }> {
    const { taskId } = ctx;
    const state = await this.deps.readProjection(taskId);
    const wi = state.workItems[ctx.workItemId];
    if (wi === undefined) throw new RepairError('WORK_ITEM_NOT_FOUND', `no workitem '${ctx.workItemId}'`);
    const grant = await this.deps.grants.resolveAttemptGrant(ctx);
    if (grant.spec.kind !== 'map_repair_batch' && grant.spec.kind !== 'content_repair_batch') {
      throw new RepairError('GRANT_STALE', `workitem '${ctx.workItemId}' carries a non-repair grant`);
    }
    const plan = (await this.deps.resolver(taskId, grant.spec.repairPlanSpecRef)) as RepairPlanSpecV2 | null;
    if (plan === null || typeof plan !== 'object') throw new RepairError('PLAN_UNRESOLVED', 'repair plan spec unresolvable');
    if (!(await this.planIsCurrentHead(taskId, plan))) {
      throw new RepairError('PLAN_STALE', 'the repair plan is not the current active revision');
    }
    const track = plan.orderedBatchScopes[0]?.kind === 'map' ? 'map' : 'content';
    await this.assertRequestedScopeKnown(taskId, {
      findingIds: params.findingIds,
      requestedNodeIds: params.requestedNodeIds ?? [],
      requestedRelationIds: params.requestedRelationIds ?? [],
      requestedSlotIds: params.requestedSlotIds ?? [],
    }, track, plan);
    const requestId = repairScopeRequestId(taskId, ctx.workItemId, params.clientOperationId);
    const operationId = `rs-${canonicalJsonSha256({ taskId, workItemId: ctx.workItemId, clientOperationId: params.clientOperationId }).slice(0, 32)}`;
    await this.publish(taskId, {
      operationId,
      publishKind: 'repair_scope_request',
      blobRefs: [],
      carriers: repairCarrier({
        track,
        repairPlanId: plan.repairPlanId,
        planRevisionId: plan.planRevisionId,
        requestId,
        reason: params.reason,
        findingIds: [...params.findingIds].sort(),
        requestedNodeIds: [...(params.requestedNodeIds ?? [])].sort(),
        requestedRelationIds: [...(params.requestedRelationIds ?? [])].sort(),
        requestedSlotIds: [...(params.requestedSlotIds ?? [])].sort(),
      }),
      preparedRefs: [],
    });
    return { requestId };
  }

  /**
   * The scope-expansion APPROVAL (the operator seam): atomically supersedes
   * the current plan revision (the approved event registers the successor
   * revision in the projection) and creates the successor plan/spec/WorkItem/
   * new Grant within hard limits. I-4/R2-2 (adversarial review): the OLD
   * WorkItem of the superseded revision is ALSO superseded atomically
   * (`structured_work_item_superseded`, reason new_authority_base — the
   * projector fully folds it) so it can never be claimed again; a MID-SESSION
   * lease (the normal operator flow — the request tool runs inside a leased
   * session) is ended FIRST in the same envelope (attempt-abandoned +
   * lease-reclaimed, then the supersede at the post-reclaim epoch). Its grant
   * binds the superseded revision and every write from it fails PLAN_STALE
   * (the plan head is the write authority). Competing approvals tail-CAS; the
   * loser re-projects and must rebase on the winner.
   */
  async approveScopeExpansion(input: {
    taskId: string;
    requestId: string;
    operatorId: string;
    expectedLastSequence: number;
    expectedTailCommitId: string | null;
    requestedNodeIds?: readonly string[];
    requestedRelationIds?: readonly string[];
    requestedSlotIds?: readonly string[];
    findingIds: readonly string[];
    reason: string;
  }): Promise<{ kind: 'completed'; resultRefs: readonly BlobRefV2[]; successorPlanSpecRef: BlobRefV2; successorPlanRevisionId: string }> {
    const { taskId } = input;
    const state = await this.deps.readProjection(taskId);
    const events = await this.deps.readEvents(taskId);
    const request = events.find(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_repair_scope_requested' }> =>
        e.type === 'structured_repair_scope_requested' && e.requestId === input.requestId,
    );
    if (request === undefined) throw new RepairError('REQUEST_UNKNOWN', `no scope-expansion request '${input.requestId}'`);
    if (events.some((e) => e.type === 'structured_repair_scope_expansion_approved_v2' && e.requestId === input.requestId)) {
      throw new RepairError('REQUEST_ALREADY_DECIDED', `request '${input.requestId}' is already approved`);
    }
    if (events.some((e) => e.type === 'structured_repair_scope_expansion_rejected_v2' && e.requestId === input.requestId)) {
      throw new RepairError('REQUEST_ALREADY_DECIDED', `request '${input.requestId}' is already rejected`);
    }
    const tail = await this.deps.tail(taskId);
    if (tail.lastSequence !== input.expectedLastSequence || tail.lastCommitId !== input.expectedTailCommitId) {
      throw new RepairError('AUTHORITY_BASE_STALE', 'stale tail: a competing successor committed; re-evaluate on the winner');
    }
    const lineage = state.repairPlans[request.repairPlanId];
    if (lineage === undefined) throw new RepairError('PLAN_UNKNOWN', `no repair lineage '${request.repairPlanId}'`);
    const headRevisionId = lineage.currentPlanRevisionId;
    if (headRevisionId === null || headRevisionId !== request.planRevisionId) {
      throw new RepairError('PLAN_STALE', 'the requested plan revision is no longer the current head');
    }
    const supersededSpec = (await this.deps.resolver(taskId, lineage.revisions[headRevisionId].specRef)) as RepairPlanSpecV2 | null;
    if (supersededSpec === null || typeof supersededSpec !== 'object') throw new RepairError('PLAN_UNRESOLVED', 'current repair plan spec unresolvable');
    const track = supersededSpec.orderedBatchScopes[0]?.kind === 'map' ? 'map' : 'content';
    const requestedScope = {
      findingIds: request.findingIds,
      requestedNodeIds: request.requestedNodeIds,
      requestedRelationIds: request.requestedRelationIds,
      requestedSlotIds: request.requestedSlotIds,
    };
    const repeatedScope = {
      findingIds: input.findingIds,
      requestedNodeIds: input.requestedNodeIds ?? [],
      requestedRelationIds: input.requestedRelationIds ?? [],
      requestedSlotIds: input.requestedSlotIds ?? [],
    };
    if (canonicalJsonSha256(repeatedScope) !== canonicalJsonSha256(requestedScope)) {
      throw new RepairError('REQUEST_SCOPE_MISMATCH', 'approval scope must be byte-equal to the immutable recorded request');
    }
    await this.assertRequestedScopeKnown(taskId, requestedScope, track, supersededSpec);
    const requestedScopeDigest = repairRequestedScopeDigest(requestedScope);
    const approvalOperationId = repairScopeApprovalOperationId(taskId, input.requestId, requestedScopeDigest);
    const expanded = this.expandedScopes(supersededSpec, requestedScope, track);
    // I-4 fix (adversarial review round 2): the successor binds its OWN key
    // ledger (like the blocking-finalize successor) — the superseded
    // revision's ledger would make the successor's batch-1 commit fail
    // AUTHORITY_BASE_STALE (the grant/staging root bind the new ledger). The
    // ledger uses the SELF-CONSISTENT revision id (repairLedgerRevisionIdOf —
    // the ledger is prepared BEFORE the plan spec exists; the spec's
    // keyLineageRef binds it, so its planRevisionId cannot depend on the
    // spec's planRevisionId — the Task 11 reopen precedent).
    const successorRevision = supersededSpec.revision + 1;
    const keyLedger = buildRepairKeyLedger(supersededSpec.repairPlanId, repairLedgerRevisionIdOf(supersededSpec.repairPlanId, successorRevision), expanded.ledgerEntries);
    const keyLedgerRef = await this.deps.facade.prepareBlob(taskId, 'repair_key_ledger', keyLedger);
    const successor = buildRepairPlanSpec({
      repairPlanId: request.repairPlanId,
      revision: successorRevision,
      origin: { kind: 'successor', supersedesPlanSpecRef: lineage.revisions[headRevisionId].specRef, successorReason: 'scope_expansion', successorOperationKey: approvalOperationId },
      sourceReceiptRef: supersededSpec.sourceReceiptRef,
      repairBase: supersededSpec.repairBase,
      orderedBatchScopes: expanded.scopes,
      keyLineageRef: keyLedgerRef,
      importedStagingManifestRef: supersededSpec.importedStagingManifestRef,
    });
    const successorRef = await this.deps.facade.prepareBlob(taskId, 'repair_plan_spec', successor);
    const baseStagingRoot = this.baseStagingRootOf(successor, keyLedgerRef, taskId, track, expanded.targets);
    const baseStagingRootRef = await this.deps.facade.prepareBlob(taskId, 'repair_staging_root', baseStagingRoot);
    const firstWorkItemId = repairBatchWorkItemId(taskId, request.repairPlanId, 1, successor.planRevisionId);
    const successorCarrier = await this.prepareRepairBatchSuccessor({
      taskId,
      plan: successor,
      planRef: successorRef,
      batchOrdinal: 0,
      nextWorkItemId: firstWorkItemId,
      isLast: false,
      currentStagingRootRef: baseStagingRootRef,
      keyLedgerRef,
    });
    const carryErrors = validateRepairSuccessorCarrier(successorCarrier.carrier, successorRef);
    if (carryErrors.length > 0) {
      throw new RepairError('INVALID_INPUT', `repair successor carry invalid: ${carryErrors.join('; ')}`);
    }
    const overrideTransfer = await this.prepareOverrideTransfer(taskId, lineage.revisions[headRevisionId].specRef, successorRef, approvalOperationId, track);
    const operationId = approvalOperationId;
    // I-4 (adversarial review): the superseded plan revision's claimable
    // WorkItem is superseded atomically (`structured_work_item_superseded`) —
    // without it the stale WorkItem stays claimable forever, its retries park
    // the task into retryable_failure, and the successor can never run.
    const supersededWorkItem = this.supersededWorkItemOf(state, supersededSpec, taskId);
    const blobRefs = [
      successorRef,
      keyLedgerRef,
      baseStagingRootRef,
      successorCarrier.authorityBaseRef,
      ...(successorCarrier.grantSpecRef === null ? [] : [successorCarrier.grantSpecRef]),
      ...(overrideTransfer === null ? [] : [overrideTransfer.overrideRef]),
    ];
    await this.publish(taskId, {
      operationId,
      publishKind: 'repair_scope_approval',
      blobRefs,
      carriers: repairCarrier({
        track,
        repairPlanId: request.repairPlanId,
        supersedesPlanRevisionId: headRevisionId,
        successorPlanRevisionId: successor.planRevisionId,
        successorPlanSpecRef: successorRef,
        requestId: input.requestId,
        reason: input.reason,
        workItemId: firstWorkItemId,
        batchOrdinal: 1,
        grantSpecId: `gs-${firstWorkItemId}`,
        grantKind: track === 'map' ? 'map_repair_batch' : 'content_repair_batch',
        overrideTransfer,
        supersededWorkItem,
        successor: successorCarrier.carrier,
      }),
      preparedRefs: blobRefs,
    });
    return { kind: 'completed', resultRefs: blobRefs, successorPlanSpecRef: successorRef, successorPlanRevisionId: successor.planRevisionId };
  }

  /** I-4 + R2-2: the superseded plan revision's claimable WorkItem (deterministic
   * ids: batch ordinals 1..N + the grantless finalizer). The projector's
   * supersede rule accepts ready|leased|retryable_failed|parked and demands
   * the attempt cycle ended for a LEASED workitem. A mid-session lease (a
   * STARTED structured attempt — the NORMAL operator flow: the request tool is
   * only callable from a leased session) is ended ATOMICALLY in the approval
   * envelope: attempt-abandoned + lease-reclaimed BEFORE the supersede (the
   * envelope order is projector-legal: abandon (active lease, epoch N) →
   * reclaim (attempt abandoned; workitem ready, epoch N+1) → supersede at the
   * post-reclaim epoch N+1). At most one workitem of a serial plan revision is
   * claimable at any time. Returns null when none is claimable (the envelope
   * still creates the successor). */
  private supersededWorkItemOf(
    state: AuthoritativeReviewProjectionV2,
    supersededPlan: RepairPlanSpecV2,
    taskId: string,
  ): NonNullable<RepairPublishCarriersV2['supersededWorkItem']> | null {
    const candidateIds: string[] = [];
    for (let ordinal = 1; ordinal <= supersededPlan.orderedBatchScopes.length; ordinal++) {
      candidateIds.push(repairBatchWorkItemId(taskId, supersededPlan.repairPlanId, ordinal, supersededPlan.planRevisionId));
    }
    candidateIds.push(repairFinalizeWorkItemId(taskId, supersededPlan.repairPlanId, supersededPlan.planRevisionId));
    for (const workItemId of candidateIds) {
      const wi = state.workItems[workItemId];
      if (wi === undefined) continue;
      if (wi.state === 'ready' || wi.state === 'retryable_failed' || wi.state === 'parked') {
        return { workItemId, leaseEpoch: wi.leaseEpoch, reason: 'new_authority_base', authorityBaseRef: wi.authorityBaseRef as BlobRefV2, attemptAbandonment: null };
      }
      if (wi.state === 'leased') {
        const active = state.activeLease?.attemptId ?? state.activeLease?.commandId ?? null;
        const attempt = active === null ? undefined : state.attempts[active];
        if (attempt !== undefined && (attempt.state === 'terminal_failed' || attempt.state === 'abandoned')) {
          return { workItemId, leaseEpoch: wi.leaseEpoch, reason: 'new_authority_base', authorityBaseRef: wi.authorityBaseRef as BlobRefV2, attemptAbandonment: null };
        }
        if (attempt !== undefined && attempt.state === 'started' && attempt.family === 'structured') {
          // R2-2: mid-session lease — the envelope abandons the attempt +
          // reclaims the lease atomically, then supersedes at the post-reclaim
          // epoch (wi.leaseEpoch + 1 — the projector's supersede epoch check).
          return {
            workItemId,
            leaseEpoch: wi.leaseEpoch + 1,
            reason: 'new_authority_base',
            authorityBaseRef: wi.authorityBaseRef as BlobRefV2,
            attemptAbandonment: {
              attemptId: attempt.attemptId,
              logicalAssignmentId: wi.logicalAssignmentId ?? `la-${workItemId}`,
              reviewAssignmentId: wi.reviewAssignmentId,
              sessionKind: wi.sessionKind as StructuredSessionKindV2,
              leaseEpoch: wi.leaseEpoch,
              authorityBaseRef: wi.authorityBaseRef as BlobRefV2,
            },
          };
        }
        // A command cycle or an unresolvable attempt — not supersede-able in
        // this envelope (the plan head remains the write authority).
        continue;
      }
    }
    return null;
  }

  /** The scope-expansion REJECTION: preserves the current plan and exact
   * write scope, but atomically ends the requesting lease/attempt, supersedes
   * its old Grant-bearing WorkItem, and creates a deterministic same-scope
   * replacement whose later dispatch carries the rejection reason. */
  async rejectScopeExpansion(input: {
    taskId: string;
    requestId: string;
    operatorId: string;
    reason: string;
    expectedLastSequence: number;
    expectedTailCommitId: string | null;
  }): Promise<{ kind: 'completed'; resultRefs: readonly BlobRefV2[]; replacementWorkItemId: string }> {
    const { taskId } = input;
    const events = await this.deps.readEvents(taskId);
    const request = events.find(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_repair_scope_requested' }> =>
        e.type === 'structured_repair_scope_requested' && e.requestId === input.requestId,
    );
    if (request === undefined) throw new RepairError('REQUEST_UNKNOWN', `no scope-expansion request '${input.requestId}'`);
    if (events.some((e) => e.type === 'structured_repair_scope_expansion_approved_v2' && e.requestId === input.requestId)) {
      throw new RepairError('REQUEST_ALREADY_DECIDED', `request '${input.requestId}' is already approved`);
    }
    const priorRejection = events.find((e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_repair_scope_expansion_rejected_v2' }> => e.type === 'structured_repair_scope_expansion_rejected_v2' && e.requestId === input.requestId);
    if (priorRejection !== undefined) {
      if (priorRejection.reason !== input.reason || priorRejection.operatorId !== input.operatorId) {
        throw new RepairError('OPERATION_CONFLICT', `request '${input.requestId}' was rejected with different decision bytes`);
      }
      const replacementWorkItemId = repairScopeRejectionReplacementWorkItemId(taskId, input.requestId);
      const state = await this.deps.readProjection(taskId);
      const replacement = state.workItems[replacementWorkItemId];
      if (replacement === undefined || replacement.grantSpecRef === null) {
        throw new RepairError('OPERATION_CONFLICT', `request '${input.requestId}' rejection result is not reconstructable`);
      }
      return { kind: 'completed', resultRefs: [replacement.authorityBaseRef, replacement.grantSpecRef], replacementWorkItemId };
    }
    const tail = await this.deps.tail(taskId);
    if (tail.lastSequence !== input.expectedLastSequence || tail.lastCommitId !== input.expectedTailCommitId) {
      throw new RepairError('AUTHORITY_BASE_STALE', 'stale tail: a competing successor committed; re-evaluate on the winner');
    }
    const track = request.track;
    const state = await this.deps.readProjection(taskId);
    const lineage = state.repairPlans[request.repairPlanId];
    const head = lineage?.revisions[request.planRevisionId];
    if (lineage === undefined || head === undefined || lineage.currentPlanRevisionId !== request.planRevisionId || head.state !== 'active') {
      throw new RepairError('PLAN_STALE', 'the requested plan revision is no longer the active head');
    }
    const plan = await this.deps.resolver(taskId, head.specRef) as RepairPlanSpecV2 | null;
    if (plan === null || typeof plan !== 'object') throw new RepairError('PLAN_UNRESOLVED', 'scope rejection plan is unresolvable');
    const supersededWorkItem = this.supersededWorkItemOf(state, plan, taskId);
    if (supersededWorkItem === null) throw new RepairError('WORK_ITEM_NOT_FOUND', 'scope rejection cannot identify the active repair cycle');
    const activeBatchOrdinal = this.repairBatchOrdinalOfWorkItem(taskId, plan, supersededWorkItem.workItemId);
    if (activeBatchOrdinal === null) throw new RepairError('INVALID_INPUT', 'scope rejection only applies to an active repair batch');
    const current = await this.currentStagingState(taskId, plan, track);
    const replacementWorkItemId = repairScopeRejectionReplacementWorkItemId(taskId, input.requestId);
    const replacement = await this.prepareRepairBatchSuccessor({
      taskId,
      plan,
      planRef: head.specRef,
      batchOrdinal: activeBatchOrdinal - 1,
      nextWorkItemId: replacementWorkItemId,
      isLast: false,
      currentStagingRootRef: current.stagingRootRef,
      keyLedgerRef: current.keyLedgerRef,
    });
    const carryErrors = validateRepairSuccessorCarrier(replacement.carrier, head.specRef);
    if (carryErrors.length > 0) throw new RepairError('INVALID_INPUT', `replacement carry invalid: ${carryErrors.join('; ')}`);
    const operationId = repairScopeRejectionOperationId(taskId, input.requestId, input.operatorId, input.reason);
    const blobRefs = [replacement.authorityBaseRef, ...(replacement.grantSpecRef === null ? [] : [replacement.grantSpecRef])];
    await this.publish(taskId, {
      operationId,
      publishKind: 'repair_scope_rejection',
      blobRefs,
      carriers: repairCarrier({
        track,
        repairPlanId: request.repairPlanId,
        planRevisionId: request.planRevisionId,
        requestId: input.requestId,
        operatorId: input.operatorId,
        reason: input.reason,
        workItemId: replacementWorkItemId,
        batchOrdinal: activeBatchOrdinal,
        grantSpecId: `gs-${replacementWorkItemId}`,
        grantKind: track === 'map' ? 'map_repair_batch' : 'content_repair_batch',
        supersededWorkItem,
        successor: replacement.carrier,
      }),
      preparedRefs: blobRefs,
    });
    return { kind: 'completed', resultRefs: blobRefs, replacementWorkItemId };
  }

  private repairBatchOrdinalOfWorkItem(taskId: string, plan: RepairPlanSpecV2, workItemId: string): number | null {
    for (let ordinal = 1; ordinal <= plan.orderedBatchScopes.length; ordinal++) {
      if (repairBatchWorkItemId(taskId, plan.repairPlanId, ordinal, plan.planRevisionId) === workItemId) return ordinal;
    }
    return null;
  }

  /* ------------------------- internals ---------------------------- */

  /** The repair targets of the plan's blocking findings. The service resolves
   * the finding blobs (primary locations + suggestedRepairSlotIds) and
   * fail-closes on unknown targets (a finding naming a target the current
   * baseline does not know is a system invariant violation — the Task 15 F5
   * precedent). */
  private async resolveRepairTargets(
    taskId: string,
    track: 'map' | 'content',
    findings: readonly ProjectedFindingLifecycleV2[],
  ): Promise<{ nodeIds: string[]; relationIds: string[]; slotIds: string[]; findingIds: string[] }> {
    const state = await this.deps.readProjection(taskId);
    const knownNodeIds = new Set<string>();
    const knownRelationIds = new Set<string>();
    const knownSlotIds = new Set<string>();
    if (state.currentMap !== null) {
      const snapshot = (await this.deps.resolver(taskId, state.currentMap.mapSnapshotRef)) as { nodes?: readonly { slotId: string }[]; relations?: readonly { relationId: string }[] } | null;
      if (snapshot !== null && typeof snapshot === 'object') {
        for (const n of snapshot.nodes ?? []) knownNodeIds.add(n.slotId);
        for (const r of snapshot.relations ?? []) knownRelationIds.add(r.relationId);
      }
    }
    if (state.currentCandidate !== null) {
      const candidate = (await this.deps.resolver(taskId, state.currentCandidate.candidateRef)) as { validationCoreRef: BlobRefV2 } | null;
      if (candidate !== null && typeof candidate === 'object') {
        const core = (await this.deps.resolver(taskId, candidate.validationCoreRef)) as { nodes?: readonly { slotId: string }[]; relations?: readonly { relationId: string }[] } | null;
        if (core !== null && typeof core === 'object') {
          for (const n of core.nodes ?? []) knownNodeIds.add(n.slotId);
          for (const r of core.relations ?? []) knownRelationIds.add(r.relationId);
        }
      }
    }
    if (state.currentManifest !== null) {
      const manifest = (await this.deps.resolver(taskId, state.currentManifest.contentRevisionManifestRef)) as { entries?: readonly { slotId: string }[] } | null;
      if (manifest !== null && typeof manifest === 'object') {
        for (const e of manifest.entries ?? []) knownSlotIds.add(e.slotId);
      }
    }
    const slotIds = new Set<string>();
    const nodeIds = new Set<string>();
    const relationIds = new Set<string>();
    const findingIds = new Set<string>();
    for (const f of findings) {
      if (f.severity !== 'blocking') continue;
      findingIds.add(f.findingId);
      const blob = await this.resolveFindingBlob(taskId, f.findingId);
      const primary = blob?.primaryLocation ?? { kind: 'slot' as const, id: '' };
      if (track === 'map') {
        if (primary.kind === 'map_node') nodeIds.add(primary.id);
        if (primary.kind === 'relation') relationIds.add(primary.id);
      } else {
        if (primary.kind === 'slot') slotIds.add(primary.id);
        if (blob !== null) {
          for (const slotId of blob.suggestedRepairSlotIds) slotIds.add(slotId);
        }
      }
    }
    if (track === 'map') {
      for (const id of [...nodeIds]) {
        if (!knownNodeIds.has(id)) {
          throw new RepairError('REPAIR_SCOPE_INVALID', `finding names unknown map node '${id}'`);
        }
      }
      for (const id of [...relationIds]) {
        if (!knownRelationIds.has(id)) {
          throw new RepairError('REPAIR_SCOPE_INVALID', `finding names unknown map relation '${id}'`);
        }
      }
    } else {
      for (const id of [...slotIds]) {
        if (!knownSlotIds.has(id)) {
          throw new RepairError('REPAIR_SCOPE_INVALID', `finding names unknown slot '${id}'`);
        }
      }
    }
    return { nodeIds: [...nodeIds].sort(), relationIds: [...relationIds].sort(), slotIds: [...slotIds].sort(), findingIds: [...findingIds].sort() };
  }

  private async resolveFindingBlob(taskId: string, findingId: string): Promise<{ suggestedRepairSlotIds: readonly string[]; primaryLocation: { kind: 'slot' | 'relation' | 'map_node' | 'map'; id: string } } | null> {
    const events = await this.deps.readEvents(taskId);
    const opened = events.find(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_finding_opened' }> =>
        e.type === 'structured_finding_opened' && e.findingId === findingId,
    );
    if (opened === undefined) return null;
    const blob = (await this.deps.resolver(taskId, opened.findingRef)) as { suggestedRepairSlotIds?: readonly string[]; primaryLocation?: { kind: 'slot' | 'relation' | 'map_node' | 'map'; id: string } } | null;
    if (blob === null || typeof blob !== 'object') return null;
    return {
      suggestedRepairSlotIds: blob.suggestedRepairSlotIds ?? [],
      primaryLocation: blob.primaryLocation ?? { kind: 'slot', id: '' },
    };
  }

  /** The initial key ledger: one active entry per repair target, bound to the
   * target's official id (existing nodes/relations). The ledger's revision id
   * is SELF-CONSISTENT (prepared before the plan spec exists — the Task 11
   * reopen precedent); the plan's keyLineageRef binds it. */
  private initialKeyLedgerOf(
    repairPlanId: string,
    targets: { nodeIds: string[]; relationIds: string[]; slotIds: string[] },
    track: 'map' | 'content',
    revision: number,
  ): RepairKeyLedgerV2 {
    const entries: {
      planKey: string;
      kind: 'node' | 'relation';
      officialId: string | null;
      status: 'active' | 'tombstone';
      predecessorPlanKey: string | null;
    }[] = [];
    if (track === 'map') {
      for (const nodeId of targets.nodeIds) {
        entries.push({ planKey: repairPlanKeyOf(repairPlanId, nodeId), kind: 'node', officialId: nodeId, status: 'active', predecessorPlanKey: null });
      }
      for (const relationId of targets.relationIds) {
        entries.push({ planKey: repairPlanKeyOf(repairPlanId, relationId), kind: 'relation', officialId: relationId, status: 'active', predecessorPlanKey: null });
      }
    }
    return buildRepairKeyLedger(repairPlanId, repairLedgerRevisionIdOf(repairPlanId, revision), entries);
  }

  /** The base staging root (batchOrdinal 0) of a plan revision: the imported
   * state the first batch CASes against. */
  private baseStagingRootOf(
    plan: RepairPlanSpecV2,
    keyLedgerRef: BlobRefV2,
    taskId: string,
    track: 'map' | 'content',
    targets: { nodeIds: string[]; relationIds: string[]; slotIds: string[] },
  ): RepairStagingRootV2 {
    void taskId;
    void targets;
    return buildRepairStagingRoot({
      repairPlanId: plan.repairPlanId,
      planRevisionId: plan.planRevisionId,
      batchOrdinal: 0,
      mapRootDigest: track === 'map' ? this.baseMapDigestOf(plan) : null,
      contentRootDigest: track === 'content' ? this.baseContentRootDigestOf(plan) : null,
      contentManifestRef: track === 'content' && plan.repairBase.kind === 'content' ? plan.repairBase.contentRevisionManifestRef : null,
      priorStagingRootRef: null,
      keyLedgerRef,
    });
  }

  private baseMapDigestOf(plan: RepairPlanSpecV2): string {
    // The base map digest is read from the repair base at creation time — the
    // service computes it lazily in the caller where the base is resolvable;
    // here we return the plan's imported ref digest as the deterministic
    // stand-in ONLY for the pure path (the service recomputes the real digest
    // via repairBaseMapState before the first batch CAS).
    return plan.importedStagingManifestRef.digest;
  }

  private baseContentRootDigestOf(plan: RepairPlanSpecV2): string {
    return plan.importedStagingManifestRef.digest;
  }

  /** The current staging state of a plan revision: the LAST committed batch's
   * staging root (or the base staging root for batch 1) + its key ledger. */
  private async currentStagingState(
    taskId: string,
    plan: RepairPlanSpecV2,
    track: 'map' | 'content',
  ): Promise<{ stagingRootRef: BlobRefV2; keyLedgerRef: BlobRefV2; lastBatchOrdinal: number }> {
    const events = await this.deps.readEvents(taskId);
    const batches = events.filter(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_repair_batch_committed' | 'structured_content_repair_batch_committed' }> =>
        (e.type === 'structured_map_repair_batch_committed' || e.type === 'structured_content_repair_batch_committed') &&
        e.repairPlanId === plan.repairPlanId &&
        e.planRevisionId === plan.planRevisionId,
    );
    const last = batches[batches.length - 1];
    if (last === undefined) {
      const keyLedgerRef = plan.keyLineageRef;
      const baseRoot = buildRepairStagingRoot({
        repairPlanId: plan.repairPlanId,
        planRevisionId: plan.planRevisionId,
        batchOrdinal: 0,
        mapRootDigest: track === 'map' ? this.baseMapDigestOf(plan) : null,
        contentRootDigest: track === 'content' ? this.baseContentRootDigestOf(plan) : null,
        contentManifestRef: track === 'content' && plan.repairBase.kind === 'content' ? plan.repairBase.contentRevisionManifestRef : null,
        priorStagingRootRef: null,
        keyLedgerRef,
      });
      return { stagingRootRef: refOfBlob('repair_staging_root', baseRoot), keyLedgerRef, lastBatchOrdinal: 0 };
    }
    const root = (await this.deps.resolver(taskId, last.stagingRootRef)) as RepairStagingRootV2 | null;
    if (root === null || typeof root !== 'object') throw new RepairError('STAGING_UNRESOLVED', 'last committed staging root unresolvable');
    return { stagingRootRef: last.stagingRootRef, keyLedgerRef: root.keyLedgerRef, lastBatchOrdinal: last.batchOrdinal };
  }

  private async planIsCurrentHead(taskId: string, plan: RepairPlanSpecV2): Promise<boolean> {
    const state = await this.deps.readProjection(taskId);
    const lineage = state.repairPlans[plan.repairPlanId];
    if (lineage === undefined) return false;
    if (lineage.currentPlanRevisionId !== plan.planRevisionId) return false;
    const head = lineage.revisions[plan.planRevisionId];
    return head !== undefined && head.state === 'active';
  }

  /** The repair base map state (nodes/relations of the candidate or the
   * active map the plan repairs). */
  private async repairBaseMapState(taskId: string, plan: RepairPlanSpecV2): Promise<{ nodes: readonly MapPositionNodeV2[]; relations: readonly MapRelationV2[] }> {
    const base = plan.repairBase;
    if (base.kind === 'map_candidate') {
      const candidate = (await this.deps.resolver(taskId, base.candidateRef)) as MapCandidateSnapshotV2 | null;
      if (candidate === null || typeof candidate !== 'object') throw new RepairError('CANDIDATE_UNRESOLVED', 'repair base candidate unresolvable');
      const core = (await this.deps.resolver(taskId, candidate.validationCoreRef)) as MapCandidateValidationCoreV2 | null;
      if (core === null || typeof core !== 'object') throw new RepairError('CANDIDATE_CORE_UNRESOLVED', 'repair base candidate core unresolvable');
      return { nodes: core.nodes, relations: core.relations };
    }
    if (base.kind === 'map_active') {
      const snapshot = (await this.deps.resolver(taskId, base.mapRef)) as { nodes?: readonly MapPositionNodeV2[]; relations?: readonly MapRelationV2[] } | null;
      if (snapshot === null || typeof snapshot !== 'object') throw new RepairError('MAP_UNRESOLVED', 'repair base map snapshot unresolvable');
      return { nodes: snapshot.nodes ?? [], relations: snapshot.relations ?? [] };
    }
    throw new RepairError('REPAIR_BASE_STALE', 'map plan requires a map candidate or active map base');
  }

  /** The committed patches of batches 1..through (from the durable journals;
   * the finalizer uses this to reconstruct the complete staged state). */
  private async readCommittedPatches(taskId: string, plan: RepairPlanSpecV2, through: number): Promise<{ batchOrdinal: number; ops: readonly RepairMapPatchOperationV2[] }[]> {
    const events = await this.deps.readEvents(taskId);
    const committed = events.filter(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_repair_committed' }> =>
        e.type === 'structured_repair_committed' && e.repairPlanId === plan.repairPlanId && e.planRevisionId === plan.planRevisionId && e.batchOrdinal < through,
    );
    const out: { batchOrdinal: number; ops: readonly RepairMapPatchOperationV2[] }[] = [];
    for (const event of committed) {
      const ops = await this.readBatchJournal(taskId, plan, event.batchOrdinal, event.workItemId, event.attemptId);
      out.push({ batchOrdinal: event.batchOrdinal, ops });
    }
    return out;
  }

  /** Reads one batch's durable patch journal. The binding is reconstructed
   * from the committed repair_committed event + the projection
   * (workItemId/attemptId/leaseEpoch/base/grant all projected), so the
   * finalizer never depends on process state. The journal is the attempt-bound
   * REVIEW journal the tool factory appends every mutating tool result to. */
  private async readBatchJournal(taskId: string, plan: RepairPlanSpecV2, batchOrdinal: number, workItemId: string, attemptId: string): Promise<readonly RepairMapPatchOperationV2[]> {
    const state = await this.deps.readProjection(taskId);
    const wi = state.workItems[workItemId];
    const attempt = state.attempts[attemptId];
    if (wi === undefined || attempt === undefined) throw new RepairError('JOURNAL_UNRESOLVED', `batch ${batchOrdinal} workitem/attempt unresolvable`);
    const binding = {
      workItemId,
      leaseEpoch: attempt.leaseEpoch,
      attemptId,
      authorityBaseRef: wi.authorityBaseRef,
      grantSpecRef: wi.grantSpecRef as BlobRefV2,
    };
    const view = await this.deps.privateStore.readAllReviewDraft(binding);
    const ops: RepairMapPatchOperationV2[] = [];
    for (const entry of view.committed) {
      if (entry.op !== 'submit_map_patch') continue;
      const body = entry.body as { operations?: unknown };
      if (Array.isArray(body.operations)) {
        ops.push(...(body.operations as RepairMapPatchOperationV2[]));
      }
    }
    return ops;
  }

  /** Applies one batch over the immediately-prior cumulative staged manifest.
   * The returned complete provisional manifest is linked from the committed
   * staging root, so recovery resolves it without journal replay or validator
   * re-execution. */
  private async stagedContentVersions(
    taskId: string,
    plan: RepairPlanSpecV2,
    planRef: BlobRefV2,
    priorManifestRef: BlobRefV2,
    priorManifest: ContentRevisionManifestV2,
    batchOrdinal: number,
    slotContents: Readonly<Record<string, { text: string; mediaType: 'text/markdown' | 'text/plain' }>>,
    workItemId: string,
    attemptId: string,
  ): Promise<{ entries: { slotId: string; versionRef: BlobRefV2 }[]; versions: Map<string, SlotContentVersionV2>; manifest: ContentRevisionManifestV2; manifestRef: BlobRefV2 }> {
    const contentBase = plan.repairBase;
    if (contentBase.kind !== 'content') throw new RepairError('REPAIR_BASE_STALE', 'content plan repair base is not content');
    const baseManifest = (await this.deps.resolver(taskId, contentBase.contentRevisionManifestRef)) as ContentRevisionManifestV2 | null;
    if (baseManifest === null || typeof baseManifest !== 'object') throw new RepairError('MANIFEST_UNRESOLVED', 'repair base manifest unresolvable');
    const state = await this.deps.readProjection(taskId);
    if (state.currentMap === null) throw new RepairError('MAP_UNRESOLVED', 'content repair requires an active Map');
    const versions = new Map<string, SlotContentVersionV2>();
    for (const entry of priorManifest.entries) {
      const version = (await this.deps.resolver(taskId, entry.versionRef)) as SlotContentVersionV2 | null;
      if (version !== null && typeof version === 'object') versions.set(entry.slotId, version);
    }
    const entries = new Map(priorManifest.entries.map((e) => [e.slotId, e]));
    const scope = plan.orderedBatchScopes[batchOrdinal - 1];
    const batchSlots = scope !== undefined && scope.kind === 'content' ? scope.slotIds : Object.keys(slotContents);
    const values = new Map<string, ContentValueV2>();
    const expectedCurrentVersionRefs = new Map(priorManifest.entries.map((entry) => [entry.slotId, entry.versionRef]));
    for (const slotId of batchSlots) {
      const raw = slotContents[slotId];
      if (raw === undefined) throw new RepairError('SLOT_CONTENT_MISSING', `batch ${batchOrdinal} has no content for slot '${slotId}'`);
      const value = buildContentValue({
        slotId,
        contentSchemaDigest: this.deps.contentSchemaDigestOf(slotId),
        taskContentRevision: baseManifest.taskContentRevision + 1,
        mediaType: raw.mediaType,
        text: raw.text,
      });
      values.set(slotId, value);
    }
    const commitCore = buildContentRevisionCommitCore({
      priorManifestRef,
      producerPlanSpecRef: planRef,
      batchOrdinal,
      authorizedReplacementEntriesWithoutValidation: [...batchSlots]
        .sort()
        .map((slotId) => ({ slotId, expectedCurrentVersionRef: expectedCurrentVersionRefs.get(slotId) ?? null })),
      expectedMapRef: state.currentMap.mapSnapshotRef,
    });
    const commitCoreRef = await this.deps.facade.prepareBlob(taskId, 'content_revision_commit_core', commitCore);
    const validationCore: Extract<ContentValidationCoreV2, { phase: 'batch_commit' }> = { phase: 'batch_commit', contentRevisionCommitCoreRef: commitCoreRef };
    const validationCoreRef = await this.deps.facade.prepareBlob(taskId, 'content_revision_commit_core', validationCore);
    const validation = await this.runContentBatchValidator(
      taskId,
      workItemId,
      attemptId,
      validationCoreRef,
      validationCore,
      commitCore,
      batchSlots,
      values,
    );
    await this.persistEngineOutputs(taskId, validation.run, validation.store);
    if (validation.run.aggregate.outcome !== 'clear') {
      throw new RepairError(
        validation.run.aggregate.outcome === 'blocking_invalid' ? 'CONTENT_REPAIR_BATCH_BLOCKED' : 'VALIDATOR_INFRASTRUCTURE_FAILURE',
        `content repair batch ${batchOrdinal} validation did not clear`,
      );
    }
    const warningRootRef = refOfBlob('validation_warning_root', validation.run.warningRoot);
    const custody = buildContentBatchWarningCustodyRoot({
      taskId,
      inputRef: validation.run.envelopeRef,
      inputDigest: validation.run.envelopeRef.digest,
      aggregateRef: validation.run.aggregateRef,
      warningRootRef,
      batchOrdinal,
      planRevisionId: plan.planRevisionId,
    });
    const warningCustodyRef = await this.deps.facade.prepareBlob(taskId, 'validation_warning_custody_root', custody);
    for (const slotId of batchSlots) {
      const value = values.get(slotId) as ContentValueV2;
      const valueRef = await this.deps.facade.prepareBlob(taskId, 'content_value', value);
      const existing = versions.get(slotId);
      const version = buildContentSetVersion({
        slotId,
        slotRevision: (existing?.slotRevision ?? 0) + 1,
        taskContentRevision: baseManifest.taskContentRevision + 1,
        mapRef: state.currentMap.mapSnapshotRef,
        mapSemanticDigest: state.currentMap.mapSemanticDigest,
        contentSchemaDigest: this.deps.contentSchemaDigestOf(slotId),
        blobRef: valueRef,
        producer: { kind: 'content_repair_batch', planRevisionId: plan.planRevisionId, batchOrdinal, attemptId },
        contentRevisionCommitCoreRef: commitCoreRef,
        contentCommitValidatorAggregateRef: validation.run.aggregateRef,
        contentCommitWarningRootRef: warningCustodyRef,
        committedByAttemptId: attemptId,
      });
      const versionRef = await this.deps.facade.prepareBlob(taskId, 'content_version', version);
      versions.set(slotId, version);
      entries.set(slotId, { slotId, versionRef });
    }
    const sortedEntries = [...entries.values()].sort((a, b) => (a.slotId < b.slotId ? -1 : 1));
    const manifest = buildProvisionalManifest({
      taskId,
      mapRef: state.currentMap.mapSnapshotRef,
      mapSemanticDigest: state.currentMap.mapSemanticDigest,
      taskContentRevision: baseManifest.taskContentRevision + 1,
      priorManifestRef: contentBase.contentRevisionManifestRef,
      producerPlanSpecRef: planRef,
      entries: sortedEntries,
      resolvedVersions: versions,
    });
    const manifestRef = await this.deps.facade.prepareBlob(taskId, 'content_revision_manifest', manifest);
    return { entries: sortedEntries, versions, manifest, manifestRef };
  }

  /** Reconstructs the COMPLETE staged state from committed closures (content)
   * or journals plus committed events (Map), with no process-local state. */
  private async reconstructStagedState(
    taskId: string,
    plan: RepairPlanSpecV2,
    planRef: BlobRefV2,
    track: 'map' | 'content',
  ): Promise<{ nodes: readonly MapPositionNodeV2[]; relations: readonly MapRelationV2[]; entries: { slotId: string; versionRef: BlobRefV2 }[]; versions: Map<string, SlotContentVersionV2>; lastStagingRootRef: BlobRefV2; lastLedgerRef: BlobRefV2; attempts: { workItemId: string; attemptId: string }[] }> {
    const events = await this.deps.readEvents(taskId);
    const committed = events.filter(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_repair_committed' }> =>
        e.type === 'structured_repair_committed' && e.repairPlanId === plan.repairPlanId && e.planRevisionId === plan.planRevisionId,
    );
    const attempts = committed.map((e) => ({ workItemId: e.workItemId, attemptId: e.attemptId }));
    if (track === 'map') {
      const base = await this.repairBaseMapState(taskId, plan);
      const patches: { batchOrdinal: number; ops: readonly RepairMapPatchOperationV2[] }[] = [];
      for (const event of committed) {
        const ops = await this.readBatchJournal(taskId, plan, event.batchOrdinal, event.workItemId, event.attemptId);
        patches.push({ batchOrdinal: event.batchOrdinal, ops });
      }
      // The final ledger: the LAST batch's ledger (the plan's base ledger when
      // no batch committed).
      const lastBatch = committed[committed.length - 1];
      const current = await this.currentStagingState(taskId, plan, 'map');
      const ledger = (await this.deps.resolver(taskId, current.keyLedgerRef)) as RepairKeyLedgerV2 | null;
      if (ledger === null || typeof ledger !== 'object') throw new RepairError('LEDGER_UNRESOLVED', 'final key ledger unresolvable');
      const ledgerByKey = new Map(ledger.entries.map((e) => [e.planKey, e]));
      const folded = foldRepairMapState({ baseNodes: base.nodes, baseRelations: base.relations, patches, ledgerByKey });
      return { ...folded, entries: [], versions: new Map(), lastStagingRootRef: current.stagingRootRef, lastLedgerRef: current.keyLedgerRef, attempts };
    }
    const current = await this.currentStagingState(taskId, plan, 'content');
    const root = (await this.deps.resolver(taskId, current.stagingRootRef)) as RepairStagingRootV2 | null;
    if (root === null || root.contentManifestRef === null) throw new RepairError('STAGING_UNRESOLVED', 'committed content staging root has no cumulative manifest');
    const manifest = (await this.deps.resolver(taskId, root.contentManifestRef)) as ContentRevisionManifestV2 | null;
    if (manifest === null || typeof manifest !== 'object' || manifest.contentRootDigest !== root.contentRootDigest) {
      throw new RepairError('STAGING_DIVERGED', 'committed content staging manifest does not match its root');
    }
    const versions = new Map<string, SlotContentVersionV2>();
    for (const entry of manifest.entries) {
      const version = (await this.deps.resolver(taskId, entry.versionRef)) as SlotContentVersionV2 | null;
      if (version === null || typeof version !== 'object') throw new RepairError('CONTENT_VERSION_UNRESOLVED', `content version '${entry.slotId}' is unresolvable`);
      versions.set(entry.slotId, version);
    }
    void planRef;
    return { nodes: [], relations: [], entries: [...manifest.entries], versions, lastStagingRootRef: current.stagingRootRef, lastLedgerRef: current.keyLedgerRef, attempts };
  }

  /** The plan's finding set blob (kind finding_set — the recovery payload +
   * the finalizer's findingSetRef). */
  private async prepareFindingSet(taskId: string, plan: RepairPlanSpecV2): Promise<BlobRefV2> {
    const findingIds = await this.planFindingIds(taskId, plan);
    const events = await this.deps.readEvents(taskId);
    const refs: BlobRefV2[] = [];
    for (const findingId of findingIds) {
      const opened = events.find(
        (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_finding_opened' }> =>
          e.type === 'structured_finding_opened' && e.findingId === findingId,
      );
      if (opened !== undefined) refs.push(opened.findingRef);
    }
    refs.sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
    const body = { findingSetId: `fs-${canonicalJsonSha256({ repairPlanId: plan.repairPlanId, planRevisionId: plan.planRevisionId }).slice(0, 24)}`, findingRefs: refs };
    return this.deps.facade.prepareBlob(taskId, 'finding_set', { ...body, setDigest: canonicalJsonSha256(body) });
  }

  private async planFindingIds(taskId: string, plan: RepairPlanSpecV2): Promise<string[]> {
    const scope = plan.orderedBatchScopes[0];
    if (scope === undefined) return [];
    void taskId;
    return [...scope.findingIds].sort();
  }

  private async projectPlanFindings(taskId: string, plan: RepairPlanSpecV2): Promise<ProjectedFindingLifecycleV2[]> {
    const findingIds = await this.planFindingIds(taskId, plan);
    const state = await this.deps.readProjection(taskId);
    const out: ProjectedFindingLifecycleV2[] = [];
    for (const findingId of findingIds) {
      const f = state.findings[findingId];
      if (f === undefined) continue;
      out.push({
        findingId: f.findingId,
        defectClass: f.defectClass,
        severity: f.severity,
        source: f.source,
        status: f.state,
        addressStages: f.addressStages,
        verifiedStages: f.verifiedStages,
        closed: f.verifiedStages.length > 0,
        blockingUnclosed: f.severity === 'blocking' && f.state !== 'verified_closed',
      });
    }
    return out;
  }

  /** The verification stages of the plan's findings (the round's
   * verificationFindingStages — addressed-but-unverified stages). PUBLIC: the
   * map settlement's round rebuild (readRoundBlob) derives the identical set
   * for a repaired candidate (I-3 fix round — the round blob must carry the
   * stages the finalize prepared).
   * `addressingTrack`: the stage THIS envelope addresses (the finalize emits
   * finding_addressed for the plan's findings in the SAME envelope, so the
   * pre-projection read must fold the track stage in — otherwise the round
   * carrier would always be empty for a first-time repair).
   * `subtractVerified`: R2-1 (re-review round 2) — a REBUILD of the round blob
   * must reproduce the finalize's bytes even after the round verified the
   * repair finding (the finalize prepared the blob BEFORE any verification, so
   * its derivation never subtracted verified stages). The settlement rebuild
   * passes false; round-CREATION passes the default (the semantic obligation
   * set). */
  async verificationStagesOfPlan(taskId: string, plan: RepairPlanSpecV2, addressingTrack: 'map' | 'content' | null, subtractVerified = true): Promise<string[]> {
    const findings = await this.projectPlanFindings(taskId, plan);
    const out: string[] = [];
    for (const f of findings) {
      if (f.source === 'system_validator') continue;
      const stages = new Set(addressingTrack === null ? f.addressStages : [addressingTrack]);
      for (const stage of stages) {
        if (subtractVerified && f.verifiedStages.includes(stage)) continue;
        out.push(`${f.findingId}:${stage}`);
      }
    }
    return out.sort();
  }

  /** I-3 (adversarial review): the CONTENT-track verification targets of a
   * content re-review round — addressed-but-unverified CONTENT stages across
   * rounds (a repair finding was OPENED in the PRIOR round, so the round-scoped
   * derivation never sees it). Used by the repaired-Map activation path (the
   * map plan's own stages are map-track and never ride a content round). */
  private async contentVerificationStagesOf(taskId: string): Promise<string[]> {
    const state = await this.deps.readProjection(taskId);
    const out: string[] = [];
    for (const finding of Object.values(state.findings)) {
      if (finding.source === 'system_validator') continue;
      if (finding.defectClass !== 'content' && finding.defectClass !== 'mixed') continue;
      for (const stage of finding.addressStages.filter((value) => value === 'content')) {
        if (finding.verifiedStages.includes(stage)) continue;
        out.push(`${finding.findingId}:${stage}`);
      }
    }
    return out.sort();
  }

  /** The finding-stage-root entries of a verification-stage list (each carried
   * stage is a committed repair stage awaiting verification). */
  private findingStageEntriesOfStages(stages: readonly string[]): readonly import('./finding-service').FindingStageEntryV2[] {
    return [...stages].sort().map((s) => {
      const [findingId, repairStage] = s.split(':');
      return { findingId: findingId ?? '', repairStage: repairStage === 'map' ? 'map' as const : 'content' as const, state: 'committed' as const };
    });
  }

  /** §13.3.1: the exact available override bound to THIS plan (the available
   * override's currentAuthorizedRepairPlanRef must equal the plan spec ref),
   * or null. */
  private async resolveAvailableOverrideRef(taskId: string, track: 'map' | 'content', plan: RepairPlanSpecV2 | null): Promise<BlobRefV2 | null> {
    const state = await this.deps.readProjection(taskId);
    const available = state.availableOverride;
    if (available === null || available.track !== track) return null;
    const blob = (await this.deps.resolver(taskId, available.ref)) as { currentAuthorizedRepairPlanRef?: BlobRefV2 } | null;
    if (blob === null || typeof blob !== 'object') return null;
    if (plan === null) return null;
    const planRef = await this.planSpecRefOf(taskId, plan);
    if (!sameRef(blob.currentAuthorizedRepairPlanRef as BlobRefV2, planRef)) return null;
    return available.ref;
  }

  private async planSpecRefOf(taskId: string, plan: RepairPlanSpecV2): Promise<BlobRefV2> {
    const state = await this.deps.readProjection(taskId);
    const lineage = state.repairPlans[plan.repairPlanId];
    if (lineage === undefined) return refOfBlob('repair_plan_spec', plan);
    const head = lineage.revisions[plan.planRevisionId];
    if (head === undefined) return refOfBlob('repair_plan_spec', plan);
    return head.specRef;
  }

  /** §13.3.1 override transfer: when an available override is bound to the
   * superseded plan, the successor-creation envelope moves it within the same
   * lineage (transferOrdinal+1, same overrideId/failedEventId/track/lineage/
   * operation). Returns the carrier or null. */
  private async prepareOverrideTransfer(
    taskId: string,
    fromRepairPlanRef: BlobRefV2,
    toRepairPlanRef: BlobRefV2,
    transferOperationId: string,
    track: 'map' | 'content',
  ): Promise<NonNullable<RepairPublishCarriersV2['overrideTransfer']> | null> {
    const state = await this.deps.readProjection(taskId);
    const available = state.availableOverride;
    if (available === null || available.track !== track) return null;
    const blob = (await this.deps.resolver(taskId, available.ref)) as Partial<RoundBudgetOverrideV2> | null;
    if (blob === null || typeof blob !== 'object') return null;
    if (!sameRef(blob.currentAuthorizedRepairPlanRef as BlobRefV2, fromRepairPlanRef)) return null;
    const successorOverride: RoundBudgetOverrideV2 = {
      overrideId: blob.overrideId as string,
      failedEventId: blob.failedEventId as string,
      track,
      repairLineageId: blob.repairLineageId as string,
      initialRepairPlanRef: blob.initialRepairPlanRef as BlobRefV2,
      currentAuthorizedRepairPlanRef: toRepairPlanRef,
      predecessorOverrideRef: available.ref,
      transferOrdinal: (blob.transferOrdinal ?? 0) + 1,
      operationId: blob.operationId as string,
      operatorId: blob.operatorId as string,
      reasonDigest: blob.reasonDigest as string,
      state: 'available',
    };
    const overrideRef = await this.deps.facade.prepareBlob(taskId, 'round_budget_override', successorOverride);
    return { overrideRef, fromRepairPlanRef, toRepairPlanRef, transferOperationId };
  }

  /** The successor WorkItem + grant of one repair batch (or the
   * `system_repair_finalize` WorkItem on the last batch). */
  private async prepareRepairBatchSuccessor(input: {
    taskId: string;
    plan: RepairPlanSpecV2;
    planRef: BlobRefV2;
    batchOrdinal: number;
    nextWorkItemId: string;
    isLast: boolean;
    currentStagingRootRef: BlobRefV2;
    keyLedgerRef: BlobRefV2;
  }): Promise<{
    authorityBaseRef: BlobRefV2;
    grantSpecRef: BlobRefV2 | null;
    carrier: SuccessorWorkItemCarrierV2;
    planSpecRef: BlobRefV2;
  }> {
    const { taskId, plan, nextWorkItemId, isLast, currentStagingRootRef, keyLedgerRef } = input;
    const track = plan.orderedBatchScopes[0]?.kind === 'map' ? 'map' : 'content';
    const maxAutomaticRetries = await this.deps.defaultAutomaticRetries();
    if (isLast) {
      // The frozen work-item-domain rule for `system_repair_finalize` allows
      // ONLY planSpecRef + stagingManifestRef (+ optional findingSetRef) and
      // one of mapRef|mapCandidateRef — the content-track finalizer's base
      // must NOT carry contentRevisionManifestRef (fix-round defect exposed by
      // the first content-finalize test; the finalize execution reads only
      // planSpecRef + stagingManifestRef).
      const authorityBase = buildAuthorityBaseSet({
        taskId,
        templateSnapshotRef: this.deps.templateSnapshotRef,
        profileSnapshotRef: this.deps.profileSnapshotRef,
        refs: {
          planSpecRef: input.planRef,
          stagingManifestRef: currentStagingRootRef,
          ...(track === 'map'
            ? plan.repairBase.kind === 'map_candidate'
              ? { mapCandidateRef: plan.repairBase.candidateRef }
              : { mapRef: (plan.repairBase as { mapRef: BlobRefV2 }).mapRef }
            : { mapRef: (plan.repairBase as { mapRef: BlobRefV2 }).mapRef }),
        },
        kind: 'system_repair_finalize',
      });
      const authorityBaseRef = await this.deps.facade.prepareBlob(taskId, 'authority_base_set', authorityBase);
      const carrier: SuccessorWorkItemCarrierV2 = {
        workItemId: nextWorkItemId,
        kind: 'system_repair_finalize',
        roleBinding: null,
        agentExecutionKind: null,
        sessionKind: null,
        roundId: null,
        logicalAssignmentId: null,
        reviewAssignmentId: null,
        grantSpecRef: null,
        inputArtifactDeliveryId: null,
        authorityBaseRef,
        payloadRef: input.planRef,
        initialLeaseEpoch: 0,
        maxAutomaticRetries,
      };
      return { authorityBaseRef, grantSpecRef: null, carrier, planSpecRef: input.planRef };
    }
    const scope = plan.orderedBatchScopes[input.batchOrdinal];
    const nextBatchOrdinal = input.batchOrdinal + 1;
    const batchSlotIds = scope !== undefined && scope.kind === 'content' ? scope.slotIds : [];
    const mapScope = scope !== undefined && scope.kind === 'map' ? scope.scope : null;
    const authorityBase = buildAuthorityBaseSet({
      taskId,
      templateSnapshotRef: this.deps.templateSnapshotRef,
      profileSnapshotRef: this.deps.profileSnapshotRef,
      refs: {
        planSpecRef: input.planRef,
        stagingManifestRef: currentStagingRootRef,
        ...(track === 'map'
          ? plan.repairBase.kind === 'map_candidate'
            ? { mapCandidateRef: plan.repairBase.candidateRef }
            : { mapRef: (plan.repairBase as { mapRef: BlobRefV2 }).mapRef }
          : { mapRef: (plan.repairBase as { mapRef: BlobRefV2 }).mapRef, contentRevisionManifestRef: (plan.repairBase as { contentRevisionManifestRef: BlobRefV2 }).contentRevisionManifestRef }),
      },
      kind: 'agent_assignment',
      agentExecutionKind: 'structured_session',
      sessionKind: track === 'map' ? 'map_repair' : 'content_repair',
    });
    const authorityBaseRef = await this.deps.facade.prepareBlob(taskId, 'authority_base_set', authorityBase);
    const grant = buildRepairBatchGrantSpec({
      grantSpecId: `gs-${nextWorkItemId}`,
      workItemId: nextWorkItemId,
      kind: track === 'map' ? 'map_repair_batch' : 'content_repair_batch',
      snapshotHash: this.deps.snapshotHash,
      authorityBaseRef,
      repairPlanSpecRef: input.planRef,
      repairBase: plan.repairBase,
      expectedStagingRootRef: currentStagingRootRef,
      planKeyLedgerRef: keyLedgerRef,
      batchOrdinal: nextBatchOrdinal,
      findingIds: plan.orderedBatchScopes[nextBatchOrdinal - 1]?.findingIds ?? [],
      maxContextBytes: this.deps.profile.assignmentMaxTotalObjects,
      writeScope: track === 'map' ? { mapWriteScope: mapScope as MapWriteScopeV2 } : { writeSlotIds: batchSlotIds },
    });
    const grantSpecRef = await this.deps.facade.prepareBlob(taskId, 'write_grant_spec', grant);
    const carrier: SuccessorWorkItemCarrierV2 = {
      workItemId: nextWorkItemId,
      kind: 'agent_assignment',
      roleBinding: track === 'map' ? this.deps.orchestratorRoleBinding : this.deps.generatorRoleBinding,
      agentExecutionKind: 'structured_session',
      sessionKind: track === 'map' ? 'map_repair' : 'content_repair',
      roundId: null,
      logicalAssignmentId: `la-${nextWorkItemId}`,
      reviewAssignmentId: null,
      grantSpecRef,
      inputArtifactDeliveryId: null,
      authorityBaseRef,
      payloadRef: input.planRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries,
    };
    return { authorityBaseRef, grantSpecRef, carrier, planSpecRef: input.planRef };
  }

  /** The expanded successor scopes of a scope-expansion approval (within hard
   * limits: profile maxSlots/maxRelationTotal; the requested targets merge
   * with the superseded plan's targets). */
  private expandedScopes(
    superseded: RepairPlanSpecV2,
    input: { requestedNodeIds?: readonly string[]; requestedRelationIds?: readonly string[]; requestedSlotIds?: readonly string[]; findingIds: readonly string[] },
    track: 'map' | 'content',
  ): { scopes: RepairBatchScopeV2[]; targets: { nodeIds: string[]; relationIds: string[]; slotIds: string[] }; ledgerEntries: RepairKeyLedgerV2['entries'] } {
    const existing = superseded.orderedBatchScopes;
    const nodeIds = new Set<string>();
    const relationIds = new Set<string>();
    const slotIds = new Set<string>();
    for (const scope of existing) {
      if (scope.kind === 'map') {
        for (const id of scope.scope.nodeIds) nodeIds.add(id);
        for (const id of scope.scope.relationIds) relationIds.add(id);
      } else {
        for (const id of scope.slotIds) slotIds.add(id);
      }
    }
    for (const id of input.requestedNodeIds ?? []) nodeIds.add(id);
    for (const id of input.requestedRelationIds ?? []) relationIds.add(id);
    for (const id of input.requestedSlotIds ?? []) slotIds.add(id);
    if (nodeIds.size > this.deps.profile.maxSlots) {
      throw new RepairError('SCOPE_LIMIT_EXCEEDED', `expanded node scope ${nodeIds.size} exceeds maxSlots ${this.deps.profile.maxSlots}`);
    }
    if (relationIds.size > this.deps.profile.maxRelationTotal) {
      throw new RepairError('SCOPE_LIMIT_EXCEEDED', `expanded relation scope ${relationIds.size} exceeds maxRelationTotal ${this.deps.profile.maxRelationTotal}`);
    }
    const findingIds = [...input.findingIds].sort();
    const scopes = buildRepairBatchScopes({
      track,
      repairPlanId: superseded.repairPlanId,
      nodeIds: [...nodeIds].sort(),
      relationIds: [...relationIds].sort(),
      slotIds: [...slotIds].sort(),
      findingIds,
      reviewPolicy: this.deps.reviewPolicy,
      profile: this.deps.profile,
    });
    const ledgerEntries: {
      planKey: string;
      kind: 'node' | 'relation';
      officialId: string | null;
      status: 'active' | 'tombstone';
      predecessorPlanKey: string | null;
    }[] = [];
    for (const nodeId of [...nodeIds].sort()) {
      ledgerEntries.push({ planKey: repairPlanKeyOf(superseded.repairPlanId, nodeId), kind: 'node', officialId: nodeId, status: 'active', predecessorPlanKey: null });
    }
    for (const relationId of [...relationIds].sort()) {
      ledgerEntries.push({ planKey: repairPlanKeyOf(superseded.repairPlanId, relationId), kind: 'relation', officialId: relationId, status: 'active', predecessorPlanKey: null });
    }
    return { scopes, targets: { nodeIds: [...nodeIds].sort(), relationIds: [...relationIds].sort(), slotIds: [...slotIds].sort() }, ledgerEntries };
  }

  /** Approval recomputes the server-side baseline closure; unknown repeated
   * targets never become authority merely because an operator echoed them. */
  private async assertRequestedScopeKnown(
    taskId: string,
    requested: { findingIds: readonly string[]; requestedNodeIds: readonly string[]; requestedRelationIds: readonly string[]; requestedSlotIds: readonly string[] },
    track: 'map' | 'content',
    plan: RepairPlanSpecV2,
  ): Promise<void> {
    const state = await this.deps.readProjection(taskId);
    const planFindingIds = new Set(plan.orderedBatchScopes.flatMap((scope) => scope.findingIds));
    for (const findingId of requested.findingIds) {
      const finding = state.findings[findingId];
      if (finding === undefined) throw new RepairError('REPAIR_SCOPE_INVALID', `requested unknown Finding '${findingId}'`);
      if (!planFindingIds.has(findingId)) throw new RepairError('REPAIR_SCOPE_INVALID', `Finding '${findingId}' is outside the repair lineage impact closure`);
      if (finding.severity !== 'blocking' || finding.state === 'verified_closed') {
        throw new RepairError('REPAIR_SCOPE_INVALID', `Finding '${findingId}' is not a current blocking obligation`);
      }
      if (!REQUIRED_STAGES_BY_DEFECT[finding.defectClass].includes(track)) {
        throw new RepairError('REPAIR_SCOPE_INVALID', `Finding '${findingId}' does not belong to the ${track} repair stage`);
      }
    }
    if (track === 'map') {
      const mapRef = state.currentCandidate?.candidateRef ?? state.currentMap?.mapSnapshotRef ?? null;
      if (mapRef === null) throw new RepairError('MAP_UNRESOLVED', 'scope approval requires a map baseline');
      const mapObject = await this.deps.resolver(taskId, mapRef) as { validationCoreRef?: BlobRefV2; nodes?: readonly { slotId: string }[]; relations?: readonly { relationId: string }[] } | null;
      const resolved = mapObject !== null && mapObject.validationCoreRef !== undefined
        ? await this.deps.resolver(taskId, mapObject.validationCoreRef) as { nodes?: readonly { slotId: string }[]; relations?: readonly { relationId: string }[] } | null
        : mapObject;
      const nodes = new Set((resolved?.nodes ?? []).map((node) => node.slotId));
      const relations = new Set((resolved?.relations ?? []).map((relation) => relation.relationId));
      for (const id of requested.requestedNodeIds) if (!nodes.has(id)) throw new RepairError('REPAIR_SCOPE_INVALID', `requested unknown map node '${id}'`);
      for (const id of requested.requestedRelationIds) if (!relations.has(id)) throw new RepairError('REPAIR_SCOPE_INVALID', `requested unknown relation '${id}'`);
      if (requested.requestedSlotIds.length > 0) throw new RepairError('REQUEST_SCOPE_MISMATCH', 'map scope request cannot authorize content slots');
      return;
    }
    if (state.currentManifest === null) throw new RepairError('MANIFEST_UNRESOLVED', 'scope approval requires a content baseline');
    const manifest = await this.deps.resolver(taskId, state.currentManifest.contentRevisionManifestRef) as { entries?: readonly { slotId: string }[] } | null;
    const slots = new Set((manifest?.entries ?? []).map((entry) => entry.slotId));
    for (const id of requested.requestedSlotIds) if (!slots.has(id)) throw new RepairError('REPAIR_SCOPE_INVALID', `requested unknown content slot '${id}'`);
    if (requested.requestedNodeIds.length > 0 || requested.requestedRelationIds.length > 0) {
      throw new RepairError('REQUEST_SCOPE_MISMATCH', 'content scope request cannot authorize map targets');
    }
  }

  /**
   * Task 19 public seam: the complete content re-review round for a repaired
   * finalized manifest — the §13.3.1 content-cycle boundary. Budget-checked
   * (contentRoundBudgetCheck; an over-limit WITHOUT an exact available override
   * throws RepairLimitExceededError — the caller terminal-fails the task), and
   * the round carriers are returned so the CALLER folds the round-planned
   * event + review WorkItems into ITS atomic envelope (the content repair
   * finalizer and the repaired-Map activation both call this — the round is
   * NEVER created in a separate batch).
   *
   * I-1 fix (adversarial review): a repaired-Map activation passes its NEW
   * snapshot via `mapContext` — the round (carrier + review WorkItems'
   * authority bases + the planned coverage core) must bind the map being
   * activated, NOT the pre-activation map (the projector's applyContentRound-
   * Planned demands `mapRef` == the CURRENT map, and the activation envelope
   * emits `structured_map_activated` BEFORE the round-planned event).
   *
   * I-3 fix (adversarial review): the round carries the plan's
   * addressed-but-unverified CONTENT stages (verificationFindingCount + the
   * planned finding-stage root entries) — the content settlement gate demands
   * their verification records (missing -> incomplete, no Seal).
   */
  async prepareContentReReviewRound(
    taskId: string,
    finalizedManifestRef: BlobRefV2,
    mapContext?: ContentReReviewMapContextV2,
  ): Promise<{
    round: ContentReviewRoundPlanCarrierV2;
    reviewWorkItems: readonly SuccessorWorkItemCarrierV2[];
    preparedRefs: readonly BlobRefV2[];
  }> {
    const state = await this.deps.readProjection(taskId);
    const nextOrdinal = state.contentCycleOrdinal + 1;
    const overrideRef = await this.resolveAvailableOverrideRef(taskId, 'content', await this.currentRepairPlanOf(taskId, 'content'));
    contentRoundBudgetCheck({
      nextOrdinal,
      maxRounds: this.deps.reviewPolicy.maxRounds,
      availableOverride: state.availableOverride,
      overrideRef,
    });
    return this.prepareContentRound(
      taskId,
      finalizedManifestRef,
      await this.setSlotIdsOf(taskId, finalizedManifestRef),
      nextOrdinal,
      overrideRef,
      mapContext,
      await this.contentVerificationStagesOf(taskId),
    );
  }

  /** Prepares the mandatory ContentRepairPlan that follows a repaired-Map
   * activation when a mixed blocking Finding has completed only its Map
   * stage. The caller publishes these carriers in the SAME activation
   * envelope, so no crash window can expose an activated Map without its
   * content repair successor. */
  async prepareMixedContentRepairAfterMapActivation(input: {
    taskId: string;
    settlementOperationKey: string;
    settlementWorkItemId: string;
    newMapRef: BlobRefV2;
    manifestRef: BlobRefV2;
  }): Promise<{ carriers: RepairPublishCarriersV2; preparedRefs: readonly BlobRefV2[] } | null> {
    const state = await this.deps.readProjection(input.taskId);
    const { projectFindingLifecycle } = await import('./finding-service');
    const findings = Object.values(state.findings)
      .filter((finding) => finding.severity === 'blocking' && finding.defectClass === 'mixed')
      .filter((finding) => finding.verifiedStages.includes('map') && !finding.addressStages.includes('content'))
      .map((finding) => projectFindingLifecycle({ finding }));
    if (findings.length === 0) return null;

    const repairPlanId = repairPlanIdOf(input.taskId, `${input.settlementOperationKey}:mixed-content`, 'content');
    const targets = await this.resolveRepairTargets(input.taskId, 'content', findings);
    if (targets.slotIds.length === 0) {
      throw new RepairError('REPAIR_SCOPE_INVALID', 'mixed Finding content stage has no suggested repair slots');
    }
    const scopes = buildRepairBatchScopes({
      track: 'content',
      repairPlanId,
      nodeIds: [],
      relationIds: [],
      slotIds: targets.slotIds,
      findingIds: targets.findingIds,
      reviewPolicy: this.deps.reviewPolicy,
      profile: this.deps.profile,
    });
    const keyLedger = this.initialKeyLedgerOf(repairPlanId, targets, 'content', 1);
    const keyLedgerRef = await this.deps.facade.prepareBlob(input.taskId, 'repair_key_ledger', keyLedger);
    const plan = buildRepairPlanSpec({
      repairPlanId,
      revision: 1,
      origin: {
        kind: 'initial',
        settlementId: input.settlementWorkItemId,
        settlementDigest: input.newMapRef.digest,
        creationOperationKey: `${input.settlementOperationKey}:mixed-content`,
      },
      sourceReceiptRef: null,
      repairBase: { kind: 'content', mapRef: input.newMapRef, contentRevisionManifestRef: input.manifestRef },
      orderedBatchScopes: scopes,
      keyLineageRef: keyLedgerRef,
      importedStagingManifestRef: input.manifestRef,
    });
    const planRef = await this.deps.facade.prepareBlob(input.taskId, 'repair_plan_spec', plan);
    const stagingRoot = this.baseStagingRootOf(plan, keyLedgerRef, input.taskId, 'content', targets);
    const stagingRootRef = await this.deps.facade.prepareBlob(input.taskId, 'repair_staging_root', stagingRoot);
    const workItemId = repairBatchWorkItemId(input.taskId, repairPlanId, 1, plan.planRevisionId);
    const successor = await this.prepareRepairBatchSuccessor({
      taskId: input.taskId,
      plan,
      planRef,
      batchOrdinal: 0,
      nextWorkItemId: workItemId,
      isLast: false,
      currentStagingRootRef: stagingRootRef,
      keyLedgerRef,
    });
    const errors = validateRepairSuccessorCarrier(successor.carrier, planRef);
    if (errors.length > 0) throw new RepairError('INVALID_INPUT', `mixed content repair successor invalid: ${errors.join('; ')}`);
    const preparedRefs = [keyLedgerRef, planRef, stagingRootRef, successor.authorityBaseRef, ...(successor.grantSpecRef === null ? [] : [successor.grantSpecRef])];
    return {
      carriers: repairCarrier({
        track: 'content',
        repairPlanId,
        planRevisionId: plan.planRevisionId,
        repairPlanSpecRef: planRef,
        sourceValidationReceiptRef: null,
        workItemId,
        batchOrdinal: 1,
        grantSpecId: `gs-${workItemId}`,
        grantKind: 'content_repair_batch',
        successor: successor.carrier,
      }),
      preparedRefs,
    };
  }

  /** The current active repair plan of the TRACK (the override binding —
   * §13.3.1: an override authorizes only the plan bound to its lineage). */
  private async currentRepairPlanOf(taskId: string, track: 'map' | 'content'): Promise<RepairPlanSpecV2 | null> {
    const state = await this.deps.readProjection(taskId);
    for (const lineage of Object.values(state.repairPlans)) {
      if (lineage.track !== track) continue;
      const head = lineage.currentPlanRevisionId === null ? undefined : lineage.revisions[lineage.currentPlanRevisionId];
      if (head === undefined || head.state !== 'active') continue;
      const plan = (await this.deps.resolver(taskId, head.specRef)) as RepairPlanSpecV2 | null;
      if (plan !== null && typeof plan === 'object') return plan;
    }
    return null;
  }

  private async setSlotIdsOf(taskId: string, manifestRef: BlobRefV2): Promise<string[]> {
    const manifest = (await this.deps.resolver(taskId, manifestRef)) as ContentRevisionManifestV2 | null;
    if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.entries)) return [];
    const out: string[] = [];
    for (const entry of manifest.entries) {
      const version = (await this.deps.resolver(taskId, entry.versionRef)) as SlotContentVersionV2 | null;
      if (version !== null && typeof version === 'object' && version.state === 'set') out.push(entry.slotId);
    }
    return out.sort();
  }

  /** The complete content re-review round (the Task 18 seam's planning, folded
   * into the repair finalize envelope — contentCycleOrdinal increments exactly
   * once HERE). I-1: `mapContext` overrides the map the round binds (the
   * repaired-Map activation's NEW snapshot). I-3: `verificationStages` are the
   * plan's addressed-but-unverified CONTENT stages the round must verify. */
  private async prepareContentRound(
    taskId: string,
    finalizedManifestRef: BlobRefV2,
    setSlotIds: readonly string[],
    contentCycleOrdinal: number,
    consumedOverrideRef: BlobRefV2 | null,
    mapContext?: ContentReReviewMapContextV2,
    verificationStages: readonly string[] = [],
  ): Promise<{
    round: ContentReviewRoundPlanCarrierV2;
    reviewWorkItems: readonly SuccessorWorkItemCarrierV2[];
    preparedRefs: readonly BlobRefV2[];
  }> {
    const roundId = contentReviewRoundId(taskId, contentCycleOrdinal, finalizedManifestRef);
    const batchSize = Math.max(1, this.deps.reviewPolicy.contentBatchTargetSlots);
    const assignmentCount = Math.max(1, Math.ceil(setSlotIds.length / batchSize));
    const adoptionRoot = buildEmptyAdoptionRoot(roundId);
    const adoptionRootRef = await this.deps.facade.prepareBlob(taskId, 'review_adoption_root', adoptionRoot);
    const state = await this.deps.readProjection(taskId);
    const mapRef = mapContext?.mapRef ?? state.currentMap?.mapSnapshotRef;
    if (mapRef === undefined) throw new RepairError('NO_ACTIVE_MAP', 'a content review round requires an active Map');
    const mapSemanticDigest = mapContext?.mapSemanticDigest ?? state.currentMap?.mapSemanticDigest ?? '';
    const round: ContentReviewRoundPlanCarrierV2 = {
      reviewRoundId: roundId,
      contentCycleOrdinal,
      mapRef,
      mapSemanticDigest,
      contentRevisionManifestRef: finalizedManifestRef,
      reviewPolicyDigest: this.deps.reviewPolicyDigest,
      adoptionRootRef,
      coverageSlotCount: setSlotIds.length,
      coverageRelationCount: 0,
      assignmentCount,
      verificationFindingCount: verificationStages.length,
      consumedOverrideRef,
    };
    // I-3: the planned finding-stage root carries the plan's addressed-but-
    // unverified stages (state 'committed') — the durable carrier of the
    // round's verification obligation (mirroring the map round blob's
    // verificationFindingStages).
    const plannedFindingStageRootRef = await this.deps.facade.prepareBlob(
      taskId,
      'finding_stage_root',
      buildFindingStageRoot(roundId, this.findingStageEntriesOfStages(verificationStages)),
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
    return { round, reviewWorkItems, preparedRefs };
  }

  /** The map re-review round's WorkItems (review_observation grants, the Task
   * 16 matrix: mapCandidateRef + reviewCoverageCoreRef + reviewRoundRef). */
  private async prepareMapReviewWorkItems(
    taskId: string,
    round: ReturnType<typeof buildMapReviewRound>,
    roundRef: BlobRefV2,
    coverageCoreRef: BlobRefV2,
    mapCandidateRef: BlobRefV2,
  ): Promise<{ carriers: readonly SuccessorWorkItemCarrierV2[]; preparedRefs: readonly BlobRefV2[] }> {
    const count = resolveRoundAssignmentCount(round.coverageNodeIds.length, round.coverageRelationIds.length, this.deps.profile);
    const maxAutomaticRetries = this.deps.profile.maxConsecutiveAttemptsWithoutProgress;
    const carriers: SuccessorWorkItemCarrierV2[] = [];
    const preparedRefs: BlobRefV2[] = [];
    for (let index = 0; index < count; index++) {
      const workItemId = reviewBatchWorkItemId(round.mapReviewRoundId, index);
      const reviewAssignmentId = reviewAssignmentIdOf(round.mapReviewRoundId, index);
      const authorityBase = buildAuthorityBaseSet({
        taskId,
        templateSnapshotRef: this.deps.templateSnapshotRef,
        profileSnapshotRef: this.deps.profileSnapshotRef,
        refs: { mapCandidateRef, reviewCoverageCoreRef: coverageCoreRef, reviewRoundRef: roundRef },
        kind: 'agent_assignment',
        agentExecutionKind: 'structured_session',
        sessionKind: 'review_map_batch',
      });
      const authorityBaseRef = await this.deps.facade.prepareBlob(taskId, 'authority_base_set', authorityBase);
      const grant = buildReviewObservationGrantSpec({
        grantSpecId: `gs-${workItemId}`,
        workItemId,
        authorityBaseRef,
        sessionKind: 'review_map_batch',
        reviewAssignmentId,
        roundId: round.mapReviewRoundId,
        roundKind: 'map',
        snapshotHash: this.deps.snapshotHash,
        maxContextBytes: this.deps.profile.assignmentMaxTotalObjects,
      });
      const grantSpecRef = await this.deps.facade.prepareBlob(taskId, 'write_grant_spec', grant);
      const carrier: SuccessorWorkItemCarrierV2 = {
        workItemId,
        kind: 'agent_assignment',
        roleBinding: this.deps.reviewerRoleBinding,
        agentExecutionKind: 'structured_session',
        sessionKind: 'review_map_batch',
        roundId: round.mapReviewRoundId,
        logicalAssignmentId: `la-${workItemId}`,
        reviewAssignmentId,
        grantSpecRef,
        inputArtifactDeliveryId: null,
        authorityBaseRef,
        payloadRef: roundRef,
        initialLeaseEpoch: 0,
        maxAutomaticRetries,
      };
      carriers.push(carrier);
      preparedRefs.push(authorityBaseRef, grantSpecRef);
    }
    const wholeWorkItemId = reviewWholeWorkItemId(round.mapReviewRoundId);
    const wholeBase = buildAuthorityBaseSet({
      taskId,
      templateSnapshotRef: this.deps.templateSnapshotRef,
      profileSnapshotRef: this.deps.profileSnapshotRef,
      refs: { mapCandidateRef, reviewCoverageCoreRef: coverageCoreRef, reviewRoundRef: roundRef },
      kind: 'agent_assignment',
      agentExecutionKind: 'structured_session',
      sessionKind: 'review_map_whole',
    });
    const wholeBaseRef = await this.deps.facade.prepareBlob(taskId, 'authority_base_set', wholeBase);
    const wholeGrant = buildReviewObservationGrantSpec({
      grantSpecId: `gs-${wholeWorkItemId}`,
      workItemId: wholeWorkItemId,
      authorityBaseRef: wholeBaseRef,
      sessionKind: 'review_map_whole',
      reviewAssignmentId: reviewWholeAssignmentId(round.mapReviewRoundId),
      roundId: round.mapReviewRoundId,
      roundKind: 'map',
      snapshotHash: this.deps.snapshotHash,
      maxContextBytes: this.deps.profile.assignmentMaxTotalObjects,
    });
    const wholeGrantRef = await this.deps.facade.prepareBlob(taskId, 'write_grant_spec', wholeGrant);
    const wholeCarrier: SuccessorWorkItemCarrierV2 = {
      workItemId: wholeWorkItemId,
      kind: 'agent_assignment',
      roleBinding: this.deps.reviewerRoleBinding,
      agentExecutionKind: 'structured_session',
      sessionKind: 'review_map_whole',
      roundId: round.mapReviewRoundId,
      logicalAssignmentId: `la-${wholeWorkItemId}`,
      reviewAssignmentId: reviewWholeAssignmentId(round.mapReviewRoundId),
      grantSpecRef: wholeGrantRef,
      inputArtifactDeliveryId: null,
      authorityBaseRef: wholeBaseRef,
      payloadRef: roundRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries,
    };
    carriers.push(wholeCarrier);
    preparedRefs.push(wholeBaseRef, wholeGrantRef);
    return { carriers, preparedRefs };
  }

  /** The repair_finalize validator run (trigger repair_finalize, phase =
   * track). The engine's target universe = the staged state. */
  private async runFinalizeValidator(
    input: { taskId: string; commandId: string; workItemId: string },
    plan: RepairPlanSpecV2,
    track: 'map' | 'content',
    staged: { nodes: readonly MapPositionNodeV2[]; relations: readonly MapRelationV2[]; entries: { slotId: string; versionRef: BlobRefV2 }[]; versions: Map<string, SlotContentVersionV2>; lastStagingRootRef: BlobRefV2; lastLedgerRef: BlobRefV2; attempts: { workItemId: string; attemptId: string }[] },
  ): Promise<{ run: TriggerExecutionResult; store: RepairMemoryBlobStore }> {
    const store = new RepairMemoryBlobStore();
    const planRef = store.put('repair_plan_spec', plan);
    const stagingRoot = await this.deps.resolver(input.taskId, staged.lastStagingRootRef);
    const keyLedger = await this.deps.resolver(input.taskId, staged.lastLedgerRef);
    if (stagingRoot === null || keyLedger === null) throw new RepairError('STAGING_UNRESOLVED', 'repair finalizer staging closure is unresolvable');
    const stagingRootRef = store.put('repair_staging_root', stagingRoot);
    const keyLedgerRef = store.put('repair_key_ledger', keyLedger);
    if (!sameRef(stagingRootRef, staged.lastStagingRootRef) || !sameRef(keyLedgerRef, staged.lastLedgerRef)) {
      throw new RepairError('STAGING_DIVERGED', 'repair finalizer staging closure bytes do not match the authoritative refs');
    }
    let stagedArtifactRef: BlobRefV2;
    let selectedTargetRefs: readonly BlobRefV2[];
    if (track === 'map') {
      const contribution = buildRepairContributionManifest({
        repairPlanId: plan.repairPlanId,
        planRevision: plan.revision,
        stagingRootRef,
        keyLedgerRefs: [keyLedgerRef],
        agentAttemptIdentities: staged.attempts,
      });
      const contributionRef = store.put('contribution_manifest', contribution);
      const state = await this.deps.readProjection(input.taskId);
      const artifact = buildRepairCandidateCore({
        candidateId: repairCandidateIdOf(plan.repairPlanId, plan.planRevisionId),
        baseMapId: state.currentMap?.mapId ?? state.currentCandidate?.candidateId ?? null,
        repairPlanId: plan.repairPlanId,
        repairPlanRevision: plan.revision,
        snapshotHash: this.deps.snapshotHash,
        producerWorkItemId: input.workItemId,
        commandId: input.commandId,
        contributionManifestRef: contributionRef,
        nodes: staged.nodes,
        relations: staged.relations,
      });
      stagedArtifactRef = store.put('map_candidate_validation_core', artifact);
      selectedTargetRefs = [stagedArtifactRef];
    } else {
      const base = plan.repairBase;
      if (base.kind !== 'content') throw new RepairError('REPAIR_BASE_STALE', 'content finalizer has a non-content base');
      const baseManifest = (await this.deps.resolver(input.taskId, base.contentRevisionManifestRef)) as ContentRevisionManifestV2 | null;
      const state = await this.deps.readProjection(input.taskId);
      if (baseManifest === null || state.currentMap === null) throw new RepairError('MANIFEST_UNRESOLVED', 'content finalizer closure needs base manifest and active Map');
      const stagedBySlot = new Map(staged.entries.map((entry) => [entry.slotId, entry]));
      const entries = baseManifest.entries.map((entry) => stagedBySlot.get(entry.slotId) ?? entry);
      const versions = new Map<string, SlotContentVersionV2>();
      for (const entry of entries) {
        const value = staged.versions.get(entry.slotId) ?? ((await this.deps.resolver(input.taskId, entry.versionRef)) as SlotContentVersionV2 | null);
        if (value === null) throw new RepairError('CONTENT_VERSION_UNRESOLVED', `content version ${entry.slotId} is unresolvable`);
        const ref = store.put('content_version', value);
        if (!sameRef(ref, entry.versionRef)) throw new RepairError('STAGING_DIVERGED', `content version ${entry.slotId} bytes diverged`);
        versions.set(entry.slotId, value);
      }
      const artifact = buildProvisionalManifest({
        taskId: input.taskId,
        mapRef: state.currentMap.mapSnapshotRef,
        mapSemanticDigest: state.currentMap.mapSemanticDigest,
        taskContentRevision: baseManifest.taskContentRevision + 1,
        priorManifestRef: base.contentRevisionManifestRef,
        producerPlanSpecRef: planRef,
        entries,
        resolvedVersions: versions,
      });
      stagedArtifactRef = store.put('content_revision_manifest', artifact);
      selectedTargetRefs = entries.map((entry) => entry.versionRef);
    }
    const engine = new ValidatorEngine({
      registry: this.deps.validatorRegistry,
      blobs: store,
      sourceResolver: this.deps.sourceResolver,
    });
    const run = await engine.execute({
      trigger: 'repair_finalize',
      identity: { taskId: input.taskId, templateSnapshotHash: this.deps.snapshotHash, workItemId: input.workItemId, attemptId: null, commandId: input.commandId },
      coreRef: planRef,
      auxiliaryRefs: { stagingRootRef, keyLedgerRef, stagedArtifactRef },
      selectedTargetRefs,
      registrations: this.deps.registrationsFor('repair_finalize', track),
      universe: {
        slotIds: track === 'map' ? staged.nodes.map((n) => n.slotId) : staged.entries.map((e) => e.slotId),
        relationIds: track === 'map' ? staged.relations.map((r) => r.relationId) : [],
        mapNodeIds: track === 'map' ? staged.nodes.map((n) => n.slotId) : [],
        artifactDigest: null,
      },
      profile: this.deps.profileBody,
    });
    return { run, store };
  }

  /** Content-repair batches carry the same real content_commit provenance as
   * generation batches. A fabricated clear aggregate would make the repaired
   * content version's live graph unresolvable and would bypass the registered
   * batch validators. */
  private async runContentBatchValidator(
    taskId: string,
    workItemId: string,
    attemptId: string,
    validationCoreRef: BlobRefV2,
    validationCore: Extract<ContentValidationCoreV2, { phase: 'batch_commit' }>,
    commitCore: ContentRevisionCommitCoreV2,
    batchSlotIds: readonly string[],
    contentValues: ReadonlyMap<string, ContentValueV2>,
  ): Promise<{ run: TriggerExecutionResult; store: ContentPlanMemoryBlobStore }> {
    const store = new ContentPlanMemoryBlobStore(
      contentPlanEnrichment({
        slotTypeOf: (slotId) => this.deps.slotTypeOf(slotId),
        versionStateOf: () => 'set',
      }),
    );
    store.put('content_revision_commit_core', commitCore);
    store.put('content_revision_commit_core', validationCore);
    const targetRefs = batchSlotIds.map((slotId) => store.put('content_value', contentValues.get(slotId) as ContentValueV2));
    const engine = new ValidatorEngine({
      registry: this.deps.validatorRegistry,
      blobs: store,
      sourceResolver: this.deps.sourceResolver,
    });
    const run = await engine.execute({
      trigger: 'content_commit',
      executionPhase: 'batch_commit',
      identity: { taskId, templateSnapshotHash: this.deps.snapshotHash, workItemId, attemptId, commandId: null },
      coreRef: validationCoreRef,
      selectedTargetRefs: targetRefs,
      registrations: this.deps.registrationsFor('content_commit', 'batch_commit'),
      universe: { slotIds: [...batchSlotIds], relationIds: [], mapNodeIds: [], artifactDigest: null },
      slotTypes: this.deps.slotTypes,
      context: { requiredSlotIds: [...batchSlotIds] },
      profile: this.deps.profileBody,
    });
    return { run, store };
  }

  private async persistEngineOutputs(
    taskId: string,
    run: TriggerExecutionResult,
    store: RepairMemoryBlobStore | ContentPlanMemoryBlobStore,
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

  /** One repair publication through the facade. */
  private async publish(taskId: string, input: {
    operationId: string;
    publishKind: 'repair_plan_creation' | 'repair_batch_commit' | 'repair_finalize' | 'repair_scope_request' | 'repair_scope_approval' | 'repair_scope_rejection';
    blobRefs: readonly BlobRefV2[];
    carriers: RepairPublishCarriersV2;
    preparedRefs: readonly BlobRefV2[];
  }): Promise<void> {
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
        contentReview: null,
        repair: input.carriers,
      },
      intent: { handlerKind: input.publishKind, handlerVersion: 1 },
      preparedRefs: input.preparedRefs,
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
  }
}

/** The in-memory validator store of the repair finalizer run. */
export class RepairMemoryBlobStore implements ValidatorBlobStore {
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

/* ------------------------------------------------------------------ */
/* Carrier factory + helpers                                           */
/* ------------------------------------------------------------------ */

export function repairCarrier(carriers: Partial<RepairPublishCarriersV2> = {}): RepairPublishCarriersV2 {
  return {
    track: null,
    repairPlanId: null,
    planRevisionId: null,
    repairPlanSpecRef: null,
    sourceValidationReceiptRef: null,
    supersedesPlanRevisionId: null,
    successorPlanSpecRef: null,
    successorPlanRevisionId: null,
    successorReason: null,
    batchOrdinal: null,
    stagingRootRef: null,
    workItemId: null,
    attemptId: null,
    validatorAggregateRef: null,
    validationReceiptRef: null,
    requestId: null,
    operatorId: null,
    reason: null,
    findingIds: null,
    requestedNodeIds: null,
    requestedRelationIds: null,
    requestedSlotIds: null,
    grantSpecId: null,
    grantKind: null,
    addressedFindingIds: null,
    contentRevisionManifestRef: null,
    taskContentRevision: null,
    manifestPhase: null,
    priorManifestRef: null,
    repairBuildStart: null,
    repairBuildFinish: null,
    mapBuildManifestRef: null,
    contributionManifestRef: null,
    candidateId: null,
    candidateDigest: null,
    candidateRef: null,
    baseMapId: null,
    mapRound: null,
    contentRound: null,
    reviewWorkItems: null,
    overrideTransfer: null,
    supersededWorkItem: null,
    successor: null,
    terminal: null,
    ...carriers,
  };
}

/* ------------------------------------------------------------------ */
/* Publication handler registration (deterministic §9.2 rebuilds)      */
/* ------------------------------------------------------------------ */

function need<T>(value: T | null | undefined, name: string): asserts value is T {
  if (value === null || value === undefined) throw new NotRebuildableError('repair', [name]);
}

function asDomain(payload: { family: string }): Extract<PublicationOperationPayloadV2, { family: 'domain_publish' }> {
  if (payload.family !== 'domain_publish') {
    throw new NotRebuildableError('repair', [`payload family '${payload.family}' is not domain_publish`]);
  }
  return payload as Extract<PublicationOperationPayloadV2, { family: 'domain_publish' }>;
}

function parseDomainPublishPayload(value: unknown): PublicationOperationPayloadV2 {
  return parsePublicationOperationPayload(value);
}

function sha256Of(events: readonly PublicationEventEnvelopeV2[]): string {
  return canonicalJsonSha256(events);
}

/** Registers the six Task 19 repair publication handlers. */
export function registerRepairPublicationHandlers(registry: PublicationIntentRegistry): void {
  registerRepairPlanCreation(registry);
  registerRepairBatchCommit(registry);
  registerRepairFinalize(registry);
  registerRepairScopeRequest(registry);
  registerRepairScopeApproval(registry);
  registerRepairScopeRejection(registry);
}

function repairStartedEvent(rp: RepairPublishCarriersV2, at: string): PublicationEventEnvelopeV2 {
  need(rp.track, 'track');
  need(rp.repairPlanId, 'repairPlanId');
  need(rp.planRevisionId, 'planRevisionId');
  need(rp.repairPlanSpecRef, 'repairPlanSpecRef');
  return {
    protocolVersion: 2,
    at,
    type: rp.track === 'map' ? 'structured_map_repair_plan_started' : 'structured_content_repair_plan_started',
    repairPlanId: rp.repairPlanId,
    planRevisionId: rp.planRevisionId,
    repairPlanSpecRef: rp.repairPlanSpecRef,
    sourceValidationReceiptRef: rp.sourceValidationReceiptRef,
  };
}

function revisionStartedEvent(rp: RepairPublishCarriersV2, at: string): PublicationEventEnvelopeV2 {
  need(rp.track, 'track');
  need(rp.repairPlanId, 'repairPlanId');
  need(rp.planRevisionId, 'planRevisionId');
  need(rp.repairPlanSpecRef, 'repairPlanSpecRef');
  need(rp.supersedesPlanRevisionId, 'supersedesPlanRevisionId');
  need(rp.successorReason, 'successorReason');
  return {
    protocolVersion: 2,
    at,
    type: 'structured_repair_plan_revision_started',
    repairPlanId: rp.repairPlanId,
    planRevisionId: rp.planRevisionId,
    repairPlanSpecRef: rp.repairPlanSpecRef,
    supersedesPlanRevisionId: rp.supersedesPlanRevisionId,
    successorReason: rp.successorReason,
  };
}

function workItemCreatedEvent(
  s: SuccessorWorkItemCarrierV2,
  at: string,
): Omit<Extract<AuthoritativeReviewEventV2, { type: 'structured_work_item_created' }>, 'id'> {
  return {
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
  };
}

function grantIssuedEvent(rp: RepairPublishCarriersV2, at: string): PublicationEventEnvelopeV2 {
  need(rp.successor, 'successor');
  need(rp.successor.grantSpecRef, 'successor.grantSpecRef');
  need(rp.grantSpecId, 'grantSpecId');
  need(rp.workItemId, 'workItemId');
  need(rp.grantKind, 'grantKind');
  return {
    protocolVersion: 2,
    at,
    type: 'structured_repair_grant_issued',
    grantSpecRef: rp.successor.grantSpecRef,
    grantSpecId: rp.grantSpecId,
    workItemId: rp.workItemId,
    grantKind: rp.grantKind,
  };
}

function findingAddressedEvents(rp: RepairPublishCarriersV2, at: string): PublicationEventEnvelopeV2[] {
  need(rp.repairPlanId, 'repairPlanId');
  need(rp.track, 'track');
  return (rp.addressedFindingIds ?? []).map((findingId) => ({
    protocolVersion: 2,
    at,
    type: 'structured_finding_addressed',
    findingId,
    repairStage: rp.track === 'map' ? 'map' : 'content',
    repairPlanId: rp.repairPlanId,
  }));
}

function reviewWorkItemEvents(rp: RepairPublishCarriersV2, at: string): PublicationEventEnvelopeV2[] {
  return (rp.reviewWorkItems ?? []).map((s) => workItemCreatedEvent(s, at));
}

function terminalEvents(t: NonNullable<RepairPublishCarriersV2['terminal']>, at: string): PublicationEventEnvelopeV2[] {
  return [
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
  ];
}

function registerRepairPlanCreation(registry: PublicationIntentRegistry): void {
  if (registry.resolve('repair_plan_creation', 1) !== null) return;
  registry.register({
    handlerKind: 'repair_plan_creation',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: [
      'structured_map_repair_plan_started',
      'structured_content_repair_plan_started',
      'structured_repair_plan_revision_started',
      'structured_work_item_created',
      'structured_repair_grant_issued',
      'structured_round_budget_override_transferred_v2',
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
      const rp = p.repair;
      if (rp !== null && rp.repairPlanSpecRef !== null) out.push({ key: 'repairPlanSpec', ref: rp.repairPlanSpecRef });
      return out;
    },
    buildEvents: (payload, at) => {
      const p = asDomain(payload);
      const rp = p.repair;
      need(rp, 'repair');
      need(rp.repairPlanId, 'repairPlanId');
      need(rp.repairPlanSpecRef, 'repairPlanSpecRef');
      const envelopes: PublicationEventEnvelopeV2[] = [];
      if (rp.supersedesPlanRevisionId === null) {
        envelopes.push(repairStartedEvent(rp, at));
      } else {
        envelopes.push(revisionStartedEvent(rp, at));
      }
      const s = rp.successor;
      need(s, 'successor');
      envelopes.push(workItemCreatedEvent(s, at));
      if (s.grantSpecRef !== null) {
        envelopes.push(grantIssuedEvent(rp, at));
      }
      if (rp.overrideTransfer !== null) {
        envelopes.push({
          protocolVersion: 2,
          at,
          type: 'structured_round_budget_override_transferred_v2',
          overrideRef: rp.overrideTransfer.overrideRef,
          fromRepairPlanRef: rp.overrideTransfer.fromRepairPlanRef,
          toRepairPlanRef: rp.overrideTransfer.toRepairPlanRef,
          transferOperationId: rp.overrideTransfer.transferOperationId,
        });
      }
      const t = rp.terminal;
      need(t, 'terminal');
      envelopes.push(...terminalEvents(t, at));
      return envelopes;
    },
    expectedResultIdentity: (_payload, events) => sha256Of(events),
  });
}

function registerRepairBatchCommit(registry: PublicationIntentRegistry): void {
  if (registry.resolve('repair_batch_commit', 1) !== null) return;
  registry.register({
    handlerKind: 'repair_batch_commit',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: [
      'structured_map_repair_batch_committed',
      'structured_content_repair_batch_committed',
      'structured_repair_committed',
      'structured_work_item_created',
      'structured_repair_grant_issued',
    ],
    rebuildable: true,
    missingInputs: [],
    parsePayload: parseDomainPublishPayload,
    childRefsOf: (p) => (p.family === 'domain_publish' ? [...p.blobRefs] : []),
    resolveRefs: (p) => {
      if (p.family !== 'domain_publish') return [];
      const out: PublicationIntentResolvedRef[] = [];
      const rp = p.repair;
      if (rp !== null && rp.stagingRootRef !== null) out.push({ key: 'stagingRoot', ref: rp.stagingRootRef });
      return out;
    },
    buildEvents: (payload, at, refs) => {
      const p = asDomain(payload);
      const rp = p.repair;
      need(rp, 'repair');
      need(rp.track, 'track');
      need(rp.repairPlanId, 'repairPlanId');
      need(rp.planRevisionId, 'planRevisionId');
      need(rp.batchOrdinal, 'batchOrdinal');
      need(rp.workItemId, 'workItemId');
      need(rp.attemptId, 'attemptId');
      const stagingRootRef = rp.stagingRootRef ?? refs?.get('stagingRoot');
      if (stagingRootRef === null || stagingRootRef === undefined) throw new NotRebuildableError('repair_batch_commit', ['stagingRootRef']);
      const envelopes: PublicationEventEnvelopeV2[] = [
        {
          protocolVersion: 2,
          at,
          type: rp.track === 'map' ? 'structured_map_repair_batch_committed' : 'structured_content_repair_batch_committed',
          repairPlanId: rp.repairPlanId,
          planRevisionId: rp.planRevisionId,
          batchOrdinal: rp.batchOrdinal,
          stagingRootRef: stagingRootRef as BlobRefV2,
        },
        {
          protocolVersion: 2,
          at,
          type: 'structured_repair_committed',
          repairPlanId: rp.repairPlanId,
          planRevisionId: rp.planRevisionId,
          batchOrdinal: rp.batchOrdinal,
          workItemId: rp.workItemId,
          attemptId: rp.attemptId,
          stagingRootRef: stagingRootRef as BlobRefV2,
        },
      ];
      const s = rp.successor;
      need(s, 'successor');
      envelopes.push(workItemCreatedEvent(s, at));
      if (s.grantSpecRef !== null) {
        envelopes.push(grantIssuedEvent(rp, at));
      }
      return envelopes;
    },
    expectedResultIdentity: (_payload, events) => sha256Of(events),
  });
}

function registerRepairFinalize(registry: PublicationIntentRegistry): void {
  if (registry.resolve('repair_finalize', 1) !== null) return;
  registry.register({
    handlerKind: 'repair_finalize',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: [
      'structured_map_repair_plan_rejected',
      'structured_content_repair_plan_rejected',
      'structured_repair_plan_revision_started',
      'structured_work_item_created',
      'structured_repair_grant_issued',
      'structured_finding_addressed',
      'structured_map_build_started',
      'structured_map_build_finish_proposed',
      'structured_map_build_finalized',
      'structured_map_candidate_committed',
      'structured_map_review_round_planned',
      'structured_content_revision_committed',
      'structured_review_round_planned',
      'structured_round_budget_override_transferred_v2',
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
      const rp = p.repair;
      if (rp !== null) {
        if (rp.candidateRef !== null) out.push({ key: 'candidate', ref: rp.candidateRef });
        if (rp.contentRevisionManifestRef !== null) out.push({ key: 'manifest', ref: rp.contentRevisionManifestRef });
      }
      return out;
    },
    buildEvents: (payload, at, refs) => {
      const p = asDomain(payload);
      const rp = p.repair;
      need(rp, 'repair');
      need(rp.track, 'track');
      need(rp.repairPlanId, 'repairPlanId');
      need(rp.planRevisionId, 'planRevisionId');
      need(rp.terminal, 'terminal');
      const envelopes: PublicationEventEnvelopeV2[] = [...findingAddressedEvents(rp, at)];
      if (rp.validatorAggregateRef !== null) {
        // Blocking finalize: rejected + ONE correction successor revision +
        // the correction-batch WorkItem/Grant + terminals.
        need(rp.validationReceiptRef, 'validationReceiptRef');
        need(rp.successorPlanSpecRef, 'successorPlanSpecRef');
        envelopes.push({
          protocolVersion: 2,
          at,
          type: rp.track === 'map' ? 'structured_map_repair_plan_rejected' : 'structured_content_repair_plan_rejected',
          repairPlanId: rp.repairPlanId,
          // The REJECTED event names the CURRENT (superseded) revision — the
          // revision-started event below registers the successor.
          planRevisionId: rp.supersedesPlanRevisionId ?? rp.planRevisionId,
          validatorAggregateRef: rp.validatorAggregateRef,
          validationReceiptRef: rp.validationReceiptRef,
        });
        envelopes.push(revisionStartedEvent(rp, at));
        const s = rp.successor;
        need(s, 'successor');
        envelopes.push(workItemCreatedEvent(s, at));
        envelopes.push(grantIssuedEvent(rp, at));
        if (rp.overrideTransfer !== null) {
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_round_budget_override_transferred_v2',
            overrideRef: rp.overrideTransfer.overrideRef,
            fromRepairPlanRef: rp.overrideTransfer.fromRepairPlanRef,
            toRepairPlanRef: rp.overrideTransfer.toRepairPlanRef,
            transferOperationId: rp.overrideTransfer.transferOperationId,
          });
        }
        envelopes.push(...terminalEvents(rp.terminal, at));
        return envelopes;
      }
      // Clear finalize.
      if (rp.track === 'map') {
        need(rp.repairBuildStart, 'repairBuildStart');
        need(rp.repairBuildFinish, 'repairBuildFinish');
        need(rp.mapBuildManifestRef, 'mapBuildManifestRef');
        need(rp.contributionManifestRef, 'contributionManifestRef');
        need(rp.candidateId, 'candidateId');
        need(rp.candidateRef, 'candidateRef');
        need(rp.mapRound, 'mapRound');
        const candidateRef = rp.candidateRef ?? refs?.get('candidate');
        if (candidateRef === null || candidateRef === undefined) throw new NotRebuildableError('repair_finalize', ['candidateRef']);
        const bs = rp.repairBuildStart;
        envelopes.push(
          {
            protocolVersion: 2,
            at,
            type: 'structured_map_build_started',
            mapBuildId: bs.mapBuildId,
            revision: bs.revision,
            mapBuildSpecRef: bs.mapBuildSpecRef,
            supersedesMapBuildId: bs.supersedesMapBuildId,
            sourceValidationReceiptRef: bs.sourceValidationReceiptRef,
          },
          {
            protocolVersion: 2,
            at,
            type: 'structured_map_build_finish_proposed',
            mapBuildId: rp.repairBuildFinish.mapBuildId,
            expectedChunkCount: rp.repairBuildFinish.expectedChunkCount,
            expectedFrontierDigest: rp.repairBuildFinish.expectedFrontierDigest,
            expectedRootCount: rp.repairBuildFinish.expectedRootCount,
          },
          {
            protocolVersion: 2,
            at,
            type: 'structured_map_build_finalized',
            mapBuildId: bs.mapBuildId,
            manifestRef: rp.mapBuildManifestRef,
            contributionManifestRef: rp.contributionManifestRef,
          },
          {
            protocolVersion: 2,
            at,
            type: 'structured_map_candidate_committed',
            candidateId: rp.candidateId,
            candidateRef: candidateRef as BlobRefV2,
            candidateDigest: rp.candidateDigest ?? (candidateRef as BlobRefV2).digest,
            baseMapId: rp.baseMapId,
          },
          {
            protocolVersion: 2,
            at,
            type: 'structured_map_review_round_planned',
            mapReviewRoundId: rp.mapRound.mapReviewRoundId,
            mapCycleOrdinal: rp.mapRound.mapCycleOrdinal,
            candidateId: rp.mapRound.candidateId,
            candidateRef: rp.mapRound.candidateRef,
            contentRevisionManifestRef: rp.mapRound.contentRevisionManifestRef,
            reviewPolicyDigest: rp.mapRound.reviewPolicyDigest,
            coverageNodeCount: rp.mapRound.coverageNodeCount,
            coverageRelationCount: rp.mapRound.coverageRelationCount,
            assignmentCount: rp.mapRound.assignmentCount,
            consumedOverrideRef: rp.mapRound.consumedOverrideRef,
          },
        );
        envelopes.push(...reviewWorkItemEvents(rp, at));
        envelopes.push(...terminalEvents(rp.terminal, at));
        return envelopes;
      }
      need(rp.contentRevisionManifestRef, 'contentRevisionManifestRef');
      need(rp.taskContentRevision, 'taskContentRevision');
      need(rp.manifestPhase, 'manifestPhase');
      need(rp.priorManifestRef, 'priorManifestRef');
      need(rp.contentRound, 'contentRound');
      const manifestRef = rp.contentRevisionManifestRef ?? refs?.get('manifest');
      if (manifestRef === null || manifestRef === undefined) throw new NotRebuildableError('repair_finalize', ['contentRevisionManifestRef']);
      envelopes.push(
        {
          protocolVersion: 2,
          at,
          type: 'structured_content_revision_committed',
          contentRevisionManifestRef: manifestRef as BlobRefV2,
          taskContentRevision: rp.taskContentRevision,
          manifestPhase: rp.manifestPhase,
          producerPlanSpecRef: null,
          priorManifestRef: rp.priorManifestRef,
        },
        {
          protocolVersion: 2,
          at,
          type: 'structured_review_round_planned',
          reviewRoundId: rp.contentRound.reviewRoundId,
          contentCycleOrdinal: rp.contentRound.contentCycleOrdinal,
          mapRef: rp.contentRound.mapRef,
          mapSemanticDigest: rp.contentRound.mapSemanticDigest,
          contentRevisionManifestRef: rp.contentRound.contentRevisionManifestRef,
          reviewPolicyDigest: rp.contentRound.reviewPolicyDigest,
          adoptionRootRef: rp.contentRound.adoptionRootRef,
          coverageSlotCount: rp.contentRound.coverageSlotCount,
          coverageRelationCount: rp.contentRound.coverageRelationCount,
          assignmentCount: rp.contentRound.assignmentCount,
          verificationFindingCount: rp.contentRound.verificationFindingCount,
          consumedOverrideRef: rp.contentRound.consumedOverrideRef,
        },
      );
      envelopes.push(...reviewWorkItemEvents(rp, at));
      envelopes.push(...terminalEvents(rp.terminal, at));
      return envelopes;
    },
    expectedResultIdentity: (_payload, events) => sha256Of(events),
  });
}

function registerRepairScopeRequest(registry: PublicationIntentRegistry): void {
  if (registry.resolve('repair_scope_request', 1) !== null) return;
  registry.register({
    handlerKind: 'repair_scope_request',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: ['structured_repair_scope_requested'],
    rebuildable: true,
    missingInputs: [],
    parsePayload: parseDomainPublishPayload,
    childRefsOf: (p) => (p.family === 'domain_publish' ? [...p.blobRefs] : []),
    resolveRefs: () => [],
    buildEvents: (payload, at) => {
      const p = asDomain(payload);
      const rp = p.repair;
      need(rp, 'repair');
      need(rp.track, 'track');
      need(rp.repairPlanId, 'repairPlanId');
      need(rp.planRevisionId, 'planRevisionId');
      need(rp.requestId, 'requestId');
      need(rp.reason, 'reason');
      return [
        {
          protocolVersion: 2,
          at,
          type: 'structured_repair_scope_requested',
          requestId: rp.requestId,
          repairPlanId: rp.repairPlanId,
          planRevisionId: rp.planRevisionId,
          track: rp.track,
          findingIds: rp.findingIds ?? [],
          requestedNodeIds: rp.requestedNodeIds ?? [],
          requestedRelationIds: rp.requestedRelationIds ?? [],
          requestedSlotIds: rp.requestedSlotIds ?? [],
          reason: rp.reason,
        },
      ];
    },
    expectedResultIdentity: (_payload, events) => sha256Of(events),
  });
}

function registerRepairScopeApproval(registry: PublicationIntentRegistry): void {
  if (registry.resolve('repair_scope_approval', 1) !== null) return;
  registry.register({
    handlerKind: 'repair_scope_approval',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: [
      'structured_repair_scope_expansion_approved_v2',
      'structured_agent_attempt_abandoned_v2',
      'structured_work_item_lease_reclaimed',
      'structured_work_item_superseded',
      'structured_work_item_created',
      'structured_repair_grant_issued',
      'structured_round_budget_override_transferred_v2',
    ],
    rebuildable: true,
    missingInputs: [],
    parsePayload: parseDomainPublishPayload,
    childRefsOf: (p) => (p.family === 'domain_publish' ? [...p.blobRefs] : []),
    resolveRefs: (p) => {
      if (p.family !== 'domain_publish') return [];
      const out: PublicationIntentResolvedRef[] = [];
      const rp = p.repair;
      if (rp !== null && rp.successorPlanSpecRef !== null) out.push({ key: 'successorPlanSpec', ref: rp.successorPlanSpecRef });
      return out;
    },
    buildEvents: (payload, at, refs) => {
      const p = asDomain(payload);
      const rp = p.repair;
      need(rp, 'repair');
      need(rp.repairPlanId, 'repairPlanId');
      need(rp.supersedesPlanRevisionId, 'supersedesPlanRevisionId');
      need(rp.successorPlanRevisionId, 'successorPlanRevisionId');
      const successorPlanSpecRef = rp.successorPlanSpecRef ?? refs?.get('successorPlanSpec');
      if (successorPlanSpecRef === null || successorPlanSpecRef === undefined) throw new NotRebuildableError('repair_scope_approval', ['successorPlanSpecRef']);
      const envelopes: PublicationEventEnvelopeV2[] = [
        {
          protocolVersion: 2,
          at,
          type: 'structured_repair_scope_expansion_approved_v2',
          requestId: rp.requestId as string,
          repairPlanId: rp.repairPlanId,
          supersededPlanRevisionId: rp.supersedesPlanRevisionId,
          successorPlanRevisionId: rp.successorPlanRevisionId,
          successorPlanSpecRef: successorPlanSpecRef as BlobRefV2,
        },
      ];
      // I-4 (adversarial review): the old WorkItem of the superseded revision
      // is superseded atomically — it can never be claimed again (the projector
      // fully folds structured_work_item_superseded; the approval simply never
      // emitted it, leaving the stale WorkItem claimable forever). R2-2
      // (re-review round 2): a MID-SESSION lease (the normal operator flow) is
      // ended FIRST in the same envelope — structured_agent_attempt_abandoned_v2
      // (the active lease, current epoch) → structured_work_item_lease_reclaimed
      // (attempt abandoned → workitem ready, epoch+1) → THEN the supersede at
      // the post-reclaim epoch (the projector's supersede epoch check) — the
      // order is projector-legal (attempt-without-lease / attempt_not_abandoned
      // / transition_superseded all satisfied).
      if (rp.supersededWorkItem !== null) {
        const sw = rp.supersededWorkItem;
        if (sw.attemptAbandonment !== null) {
          const ab = sw.attemptAbandonment;
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_agent_attempt_abandoned_v2',
            workItemId: sw.workItemId,
            logicalAssignmentId: ab.logicalAssignmentId,
            reviewAssignmentId: ab.reviewAssignmentId,
            attemptId: ab.attemptId,
            sessionKind: ab.sessionKind,
            leaseEpoch: ab.leaseEpoch,
            reason: 'operator_interrupt',
            authorityBaseRef: ab.authorityBaseRef,
          });
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_work_item_lease_reclaimed',
            workItemId: sw.workItemId,
            leaseEpoch: ab.leaseEpoch,
            reason: 'operator_interrupt',
            authorityBaseRef: ab.authorityBaseRef,
          });
        }
        envelopes.push({
          protocolVersion: 2,
          at,
          type: 'structured_work_item_superseded',
          workItemId: sw.workItemId,
          leaseEpoch: sw.leaseEpoch,
          reason: sw.reason,
          authorityBaseRef: sw.authorityBaseRef,
        });
      }
      const s = rp.successor;
      need(s, 'successor');
      envelopes.push(workItemCreatedEvent(s, at));
      if (s.grantSpecRef !== null) {
        envelopes.push(grantIssuedEvent(rp, at));
      }
      if (rp.overrideTransfer !== null) {
        envelopes.push({
          protocolVersion: 2,
          at,
          type: 'structured_round_budget_override_transferred_v2',
          overrideRef: rp.overrideTransfer.overrideRef,
          fromRepairPlanRef: rp.overrideTransfer.fromRepairPlanRef,
          toRepairPlanRef: rp.overrideTransfer.toRepairPlanRef,
          transferOperationId: rp.overrideTransfer.transferOperationId,
        });
      }
      return envelopes;
    },
    expectedResultIdentity: (_payload, events) => sha256Of(events),
  });
}

function registerRepairScopeRejection(registry: PublicationIntentRegistry): void {
  if (registry.resolve('repair_scope_rejection', 1) !== null) return;
  registry.register({
    handlerKind: 'repair_scope_rejection',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: [
      'structured_repair_scope_expansion_rejected_v2',
      'structured_agent_attempt_abandoned_v2',
      'structured_work_item_lease_reclaimed',
      'structured_work_item_superseded',
      'structured_work_item_created',
      'structured_repair_grant_issued',
    ],
    rebuildable: true,
    missingInputs: [],
    parsePayload: parseDomainPublishPayload,
    childRefsOf: (p) => (p.family === 'domain_publish' ? [...p.blobRefs] : []),
    resolveRefs: () => [],
    buildEvents: (payload, at) => {
      const p = asDomain(payload);
      const rp = p.repair;
      need(rp, 'repair');
      need(rp.repairPlanId, 'repairPlanId');
      need(rp.planRevisionId, 'planRevisionId');
      need(rp.requestId, 'requestId');
      need(rp.operatorId, 'operatorId');
      need(rp.reason, 'reason');
      const operatorId = rp.operatorId as string;
      const envelopes: PublicationEventEnvelopeV2[] = [
        {
          protocolVersion: 2,
          at,
          type: 'structured_repair_scope_expansion_rejected_v2',
          requestId: rp.requestId,
          repairPlanId: rp.repairPlanId,
          planRevisionId: rp.planRevisionId,
          operatorId,
          reason: rp.reason,
        },
      ];
      const sw = rp.supersededWorkItem;
      need(sw, 'supersededWorkItem');
      if (sw.attemptAbandonment !== null) {
        const ab = sw.attemptAbandonment;
        envelopes.push({
          protocolVersion: 2,
          at,
          type: 'structured_agent_attempt_abandoned_v2',
          workItemId: sw.workItemId,
          logicalAssignmentId: ab.logicalAssignmentId,
          reviewAssignmentId: ab.reviewAssignmentId,
          attemptId: ab.attemptId,
          sessionKind: ab.sessionKind,
          leaseEpoch: ab.leaseEpoch,
          reason: 'operator_interrupt',
          authorityBaseRef: ab.authorityBaseRef,
        });
        envelopes.push({
          protocolVersion: 2,
          at,
          type: 'structured_work_item_lease_reclaimed',
          workItemId: sw.workItemId,
          leaseEpoch: ab.leaseEpoch,
          reason: 'operator_interrupt',
          authorityBaseRef: ab.authorityBaseRef,
        });
      }
      envelopes.push({
        protocolVersion: 2,
        at,
        type: 'structured_work_item_superseded',
        workItemId: sw.workItemId,
        leaseEpoch: sw.leaseEpoch,
        reason: sw.reason,
        authorityBaseRef: sw.authorityBaseRef,
      });
      const successor = rp.successor;
      need(successor, 'successor');
      envelopes.push({
        ...workItemCreatedEvent(successor, at),
        scopeDecisionReason: rp.reason,
      });
      envelopes.push(grantIssuedEvent(rp, at));
      return envelopes;
    },
    expectedResultIdentity: (_payload, events) => sha256Of(events),
  });
}

/* ------------------------------------------------------------------ */
/* Module-level runtime allowlist registration                         */
/* ------------------------------------------------------------------ */

/** The `repair_finalize` SystemCommand handler (replaces the Task 12 stub). */
export function createRepairFinalizeSystemCommandHandler(service: RepairService): SystemCommandHandler {
  return {
    commandKind: 'repair_finalize',
    async execute(ctx) {
      const outcome = await service.executeRepairFinalize({
        taskId: ctx.taskId,
        commandId: ctx.commandId,
        workItemId: ctx.workItemId,
        commandKind: 'repair_finalize',
        leaseEpoch: ctx.leaseEpoch,
        authorityBaseRef: ctx.authorityBaseRef,
        payloadRef: ctx.payloadRef,
      });
      if (outcome.kind === 'completed' || outcome.kind === 'blocked') {
        return { kind: 'completed', resultRefs: outcome.resultRefs };
      }
      return { kind: 'retryable_failure', failureCode: outcome.failureCode, failureDigest: canonicalJsonSha256({ commandId: ctx.commandId, code: outcome.failureCode }) };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Repair tool handlers (wired into the V2ToolFactory domain seam)     */
/* ------------------------------------------------------------------ */

/**
 * Task 19 wiring: the `submit_map_patch` / `write_slot_content` /
 * `submit_content_draft` / `request_scope_expansion` domain handlers +
 * the repair-aware read seam. Repair writes are journaled into the
 * plan/revision/ordinal-scoped private repair staging journals BEFORE the
 * atomic batch commit (the Task 13 machinery); the batch commit folds the
 * journal + the submitted payload and publishes the batch envelope. Reads
 * see the COMMITTED tree (full committed manifest, adjacent slots, actual
 * relation context) — never the staging.
 */
export function createRepairToolHandlers(deps: {
  service: RepairService;
  grants: GrantService;
  privateStore: AuthoritativeReviewPrivateStore;
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown> | unknown;
  readProjection(taskId: string): Promise<AuthoritativeReviewProjectionV2>;
  facade: Pick<AuthoritativeAppendFacadeV2, 'prepareBlob'>;
  contentSchemaDigestOf(slotId: string): string;
}): import('./tool-factory').V2DomainHandlers {
  return {
    async submitMapPatch(ctx, params) {
      // The tool factory journals every mutating result + owns the §11
      // replay/conflict decision; the handler only commits the batch.
      const outcome = await deps.service.commitRepairBatch({
        taskId: ctx.taskId,
        workItemId: ctx.workItemId,
        attemptId: ctx.attemptId,
        batchOrdinal: Number(params.batchOrdinal ?? 0),
        ctx,
        mapPatch: {
          expectedStagingDigest: String(params.expectedStagingDigest ?? ''),
          operations: (params.operations ?? []) as readonly RepairMapPatchOperationV2[],
        },
      });
      if (outcome.kind === 'committed') {
        return { committed: true, stagingRootRef: outcome.stagingRootRef, nextWorkItemId: outcome.nextWorkItemId };
      }
      return { committed: false, failureCode: outcome.failureCode };
    },
    async writeSlotContent(ctx, params) {
      const slotId = String(params.slotId ?? '');
      const value = String(params.value ?? '');
      const mediaType = params.mediaType === 'text/plain' ? 'text/plain' : 'text/markdown';
      const state = await deps.readProjection(ctx.taskId);
      if (state.currentManifest === null) throw new RepairError('MANIFEST_UNRESOLVED', 'no current manifest');
      const valueBlob = {
        slotId,
        contentSchemaDigest: deps.contentSchemaDigestOf(slotId),
        taskContentRevision: state.currentManifest.taskContentRevision + 1,
        mediaType,
        text: value,
      };
      const blobWithout = { ...valueBlob } as Record<string, unknown>;
      const contentValueRef = await deps.facade.prepareBlob(ctx.taskId, 'content_value', { ...blobWithout, selfDigest: canonicalJsonSha256(blobWithout) });
      return { slotId, contentValueRef };
    },
    async submitContentDraft(ctx, params) {
      const journal = {
        workItemId: ctx.workItemId,
        leaseEpoch: ctx.leaseEpoch,
        attemptId: ctx.attemptId,
        authorityBaseRef: ctx.authorityBaseRef,
        grantSpecRef: await (async () => {
          const state = await deps.readProjection(ctx.taskId);
          const wi = state.workItems[ctx.workItemId];
          if (wi === undefined || wi.grantSpecRef === null) throw new RepairError('GRANT_NOT_FOUND', `no repair grant on workitem '${ctx.workItemId}'`);
          return wi.grantSpecRef;
        })(),
      };
      const view = await deps.privateStore.readAllReviewDraft(journal);
      const slotContents: Record<string, { text: string; mediaType: 'text/markdown' | 'text/plain' }> = {};
      for (const entry of view.committed) {
        if (entry.op !== 'write_slot_content') continue;
        const result = entry.result as { slotId?: string; contentValueRef?: BlobRefV2 } | null;
        if (result === null || typeof result !== 'object' || typeof result.slotId !== 'string') continue;
        const valueBlob = (await deps.resolver(ctx.taskId, result.contentValueRef as BlobRefV2)) as { text?: string; mediaType?: string } | null;
        slotContents[result.slotId] = {
          text: valueBlob !== null && typeof valueBlob === 'object' && typeof valueBlob.text === 'string' ? valueBlob.text : '',
          mediaType: valueBlob !== null && typeof valueBlob === 'object' && valueBlob.mediaType === 'text/plain' ? 'text/plain' : 'text/markdown',
        };
      }
      const grant = await deps.grants.resolveAttemptGrant(ctx);
      if (grant.spec.kind !== 'content_repair_batch') throw new RepairError('GRANT_STALE', 'content repair draft requires a content_repair_batch grant');
      const outcome = await deps.service.commitRepairBatch({
        taskId: ctx.taskId,
        workItemId: ctx.workItemId,
        attemptId: ctx.attemptId,
        batchOrdinal: grant.spec.batchOrdinal,
        ctx,
        slotContents,
      });
      if (outcome.kind === 'committed') {
        return { committed: true, stagingRootRef: outcome.stagingRootRef, nextWorkItemId: outcome.nextWorkItemId };
      }
      return { committed: false, failureCode: outcome.failureCode };
    },
    async requestScopeExpansion(ctx, params) {
      const outcome = await deps.service.requestScopeExpansion(ctx, {
        findingIds: (params.findingIds ?? []) as string[],
        requestedNodeIds: (params.requestedNodeIds ?? []) as string[] | undefined,
        requestedRelationIds: (params.requestedRelationIds ?? []) as string[] | undefined,
        requestedSlotIds: (params.requestedSlotIds ?? []) as string[] | undefined,
        reason: String(params.reason ?? ''),
        clientOperationId: String(params.clientOperationId ?? ''),
      });
      return outcome;
    },
    async read(ctx, toolName, params) {
      const state = await deps.readProjection(ctx.taskId);
      const limit = Math.max(1, Math.min(Number(params.limit ?? 100), 500));
      if (toolName === 'read_map_repair_staging') {
        // Plan-aware staging read: the committed staging roots of the plan.
        const wi = state.workItems[ctx.workItemId];
        if (wi === undefined || wi.grantSpecRef === null) return { entries: [], cursor: null };
        const grant = (await deps.resolver(ctx.taskId, wi.grantSpecRef)) as WriteGrantSpecV2 | null;
        if (grant === null || typeof grant !== 'object' || (grant.kind !== 'map_repair_batch' && grant.kind !== 'content_repair_batch')) {
          return { entries: [], cursor: null };
        }
        const plan = (await deps.resolver(ctx.taskId, grant.repairPlanSpecRef)) as RepairPlanSpecV2 | null;
        if (plan === null || typeof plan !== 'object') return { entries: [], cursor: null };
        return { entries: plan.orderedBatchScopes, cursor: null };
      }
      if (toolName === 'read_active_map') {
        if (state.currentMap === null) return { nodes: [], relations: [], cursor: null };
        const snapshot = (await deps.resolver(ctx.taskId, state.currentMap.mapSnapshotRef)) as { nodes?: unknown; relations?: unknown } | null;
        if (snapshot === null || typeof snapshot !== 'object') return { nodes: [], relations: [], cursor: null };
        return { nodes: snapshot.nodes ?? [], relations: snapshot.relations ?? [], cursor: null };
      }
      if (toolName === 'read_slot_content') {
        const slotIds = (params.slotIds ?? []) as string[];
        const out: Record<string, unknown> = {};
        if (state.currentManifest !== null) {
          const manifest = (await deps.resolver(ctx.taskId, state.currentManifest.contentRevisionManifestRef)) as { entries?: readonly { slotId: string; versionRef: BlobRefV2 }[] } | null;
          if (manifest !== null && typeof manifest === 'object') {
            for (const entry of (manifest.entries ?? []).slice(0, limit)) {
              if (slotIds.length > 0 && !slotIds.includes(entry.slotId)) continue;
              const version = (await deps.resolver(ctx.taskId, entry.versionRef)) as { state?: string; blobRef?: BlobRefV2 } | null;
              if (version !== null && typeof version === 'object' && version.state === 'set' && version.blobRef !== undefined) {
                const value = (await deps.resolver(ctx.taskId, version.blobRef)) as { text?: string; mediaType?: string } | null;
                out[entry.slotId] = { state: version.state, text: value !== null && typeof value === 'object' ? value.text ?? '' : '', mediaType: value !== null && typeof value === 'object' ? value.mediaType ?? 'text/markdown' : 'text/markdown' };
              } else if (version !== null && typeof version === 'object') {
                out[entry.slotId] = { state: version.state ?? 'unset' };
              }
            }
          }
        }
        return { slots: out, cursor: null };
      }
      if (toolName === 'read_related_context') {
        const slotId = String(params.slotId ?? '');
        const maxHops = Math.max(0, Math.min(Number(params.maxHops ?? 1), 8));
        const out: Record<string, unknown> = {};
        if (state.currentMap !== null) {
          const snapshot = (await deps.resolver(ctx.taskId, state.currentMap.mapSnapshotRef)) as { nodes?: readonly { slotId: string; parentSlotId: string | null }[]; relations?: readonly MapRelationV2[] } | null;
          if (snapshot !== null && typeof snapshot === 'object') {
            const nodeOf = new Map<string, { slotId: string; parentSlotId: string | null }>();
            for (const n of snapshot.nodes ?? []) nodeOf.set(n.slotId, n);
            const relations = snapshot.relations ?? [];
            const seen = new Set<string>([slotId]);
            for (let hop = 0; hop < maxHops; hop++) {
              const frontier = [...seen];
              for (const n of frontier) {
                const node = nodeOf.get(n);
                if (node?.parentSlotId !== null && node?.parentSlotId !== undefined) seen.add(node.parentSlotId);
              }
              for (const r of relations) {
                if (seen.has(r.fromSlotId)) seen.add(r.toSlotId);
                if (seen.has(r.toSlotId)) seen.add(r.fromSlotId);
              }
            }
            out.adjacentSlotIds = [...seen].sort();
            out.relations = relations.filter((r) => seen.has(r.fromSlotId) && seen.has(r.toSlotId));
          }
        }
        return out;
      }
      return { entries: [], cursor: null };
    },
  };
}

// Register the six repair publication handlers on the runtime allowlist so
// the default facade can replay their pins. Idempotent.
registerRepairPublicationHandlers(PUBLICATION_INTENT_REGISTRY_V2);
