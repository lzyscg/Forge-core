/**
 * Task 9 pure v2 projector (spec §9.3/§9.4, §10.3.1, §13.3.1; design
 * §17.2/§17.3/§17.4).
 *
 * `projectAuthoritativeReviewState(events, resolver)` replays a task's v2
 * event history from genesis and enforces the spec §9.3 invariant set:
 *
 * - at most one active task lease;
 * - at most one pending v2 human question and at most one
 *   `retry_budget_exhausted` park disposition;
 * - exact WorkItem transition and epoch ordering (reclaim/requeue/resume
 *   semantics per design §17.2);
 * - immutable plan/spec lineages with a single active successor per lineage;
 * - current Map/candidate/content-manifest/round/Finding/Seal ref closure;
 * - legal attempt type per WorkItem execution kind (structured agent vs
 *   generic agent vs system command), identities bound to the lease;
 * - no Agent-created aggregate/Grant/system result (grant-kind closure,
 *   system-producer chain, validator custody stays with system events);
 * - no stale AuthorityBase completion: every cycle event must carry the
 *   authority base its lease was minted under;
 * - exact system-producer delivery chain (seal -> publish -> delivery ->
 *   submitter);
 * - the Task 7 deferred rules: `failureCode` <-> `failureRecoveryPayload`
 *   branch legality (spec §10.3.1 matrix) with terminal IDs/epoch/terminal
 *   event resolved against history; and `consumedOverrideRef` ordinal
 *   legality (§13.3.1) covering reopen-created availability, same-lineage
 *   transfer, single consumption, wrong lineage/track, competing
 *   transfer/finalizer, second consumption and two-simultaneously-available
 *   refs.
 *
 * Any invariant violation throws a structured `ProjectionCorruptionError`
 * carrying the offending reason/sequence/eventId; replay NEVER yields a
 * partial projection. The module is pure: it performs no IO, reads no wall
 * clock and uses no random sources. The `BlobObjectResolver` parameter
 * resolves `BlobRefV2` -> parsed object for the closure checks that need
 * object content (recovery payloads and round-budget overrides today);
 * when a rule needs a blob and no resolver is supplied, the check degrades
 * to ref-shape/digest-only comparison (documented in the Task 9 report).
 * A resolver failure (missing/mismatched/malformed blob) fails closed as a
 * corruption diagnostic.
 *
 * Legacy (protocolVersion !== 2) members of the committed union are legal
 * companions of a v2 history (the v2 start/stop envelopes carry the v1
 * lifecycle events by design §17.3) and are skipped, never folded.
 */
import type { BlobRefV2, RecoveryRecipeKeyV2 } from '../../shared/authoritative-review-v2';
import type { AuthoritativeReviewEventV2 } from './authoritative-review-events';
import { canonicalJsonSha256 } from '../structured-slots/canonical-json';
import { parseBlob } from '../authoritative-review/object-registry';
import { SchemaError } from '../authoritative-review/authority-types';

/** Resolves a BlobRefV2 to its parsed canonical object (injectable). */
export type BlobObjectResolver = (ref: BlobRefV2) => Promise<unknown> | unknown;

/** Structured corruption diagnostic; a projection NEVER returns partial state. */
export class ProjectionCorruptionError extends Error {
  readonly code: 'PROJECTION_CORRUPT';

  /** Stable English invariant key, e.g. `second_active_lease`. */
  readonly reason: string;

  /** 1-based committed sequence of the offending event, or null. */
  readonly sequence: number | null;

  /** id of the offending event, or null. */
  readonly eventId: string | null;

  /** type of the offending event, or null. */
  readonly eventType: string | null;

  /** Structured detail (offending ids/refs) for diagnostics. */
  readonly detail: string;

  constructor(input: {
    reason: string;
    message: string;
    sequence?: number | null;
    eventId?: string | null;
    eventType?: string | null;
    detail?: string;
  }) {
    super(input.message);
    this.name = 'ProjectionCorruptionError';
    this.code = 'PROJECTION_CORRUPT';
    this.reason = input.reason;
    this.sequence = input.sequence ?? null;
    this.eventId = input.eventId ?? null;
    this.eventType = input.eventType ?? null;
    this.detail = input.detail ?? '';
  }
}

function corrupt(reason: string, event: AuthoritativeReviewEventV2, sequence: number, detail = ''): never {
  throw new ProjectionCorruptionError({
    reason,
    message: `v2 事件历史违反不变量 ${reason}（序列 ${sequence}，事件 ${event.id}）。`,
    sequence,
    eventId: event.id,
    eventType: event.type,
    detail,
  });
}

function sameRef(a: BlobRefV2 | null | undefined, b: BlobRefV2 | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return a.digest === b.digest && a.kind === b.kind;
}

/* ------------------------------------------------------------------ */
/* Projected shapes (plain, serializable)                              */
/* ------------------------------------------------------------------ */

export type WorkItemStateProjectedV2 =
  | 'ready'
  | 'leased'
  | 'parked'
  | 'completed'
  | 'retryable_failed'
  | 'terminal_failed'
  | 'superseded';

export interface WorkItemProjectionV2 {
  workItemId: string;
  kind: string;
  roleBinding: string | null;
  agentExecutionKind: 'structured_session' | 'generic_turn' | null;
  sessionKind: string | null;
  roundId: string | null;
  logicalAssignmentId: string | null;
  reviewAssignmentId: string | null;
  grantSpecRef: BlobRefV2 | null;
  inputArtifactDeliveryId: string | null;
  scopeDecisionReason: string | null;
  authorityBaseRef: BlobRefV2;
  payloadRef: BlobRefV2;
  leaseEpoch: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  retryOrdinal: number;
  retryNotBefore: string | null;
  maxAutomaticRetries: number;
  state: WorkItemStateProjectedV2;
  parkDisposition: {
    kind: 'retry_budget_exhausted';
    retryOrdinal: number;
    budgetPolicyDigest: string;
  } | { kind: 'human_question'; questionId: string; questionVersion: string } | null;
  /** authorityBaseRef of every lease cycle, keyed by epoch (staleness checks). */
  leaseBases: Record<string, BlobRefV2>;
  /** id of the terminal-failure event that terminated the last lease cycle. */
  terminalEventId: string | null;
}

export type AttemptFamilyProjectedV2 = 'structured' | 'generic' | 'command';

export interface AttemptProjectionV2 {
  attemptId: string;
  family: AttemptFamilyProjectedV2;
  workItemId: string;
  leaseEpoch: number;
  state: 'started' | 'completed' | 'retryable_failed' | 'terminal_failed' | 'abandoned';
  agentId: string | null;
  logicalAssignmentId: string | null;
  reviewAssignmentId: string | null;
  sessionKind: string | null;
  commandKind: string | null;
  inputArtifactDeliveryId: string | null;
  /** id of the attempt/command's OWN terminal event (§10.3.1 payload resolution). */
  terminalEventId: string | null;
  /** id of the workitem-level terminal event that closed the same cycle. */
  workItemTerminalEventId: string | null;
  failureCode: string | null;
}

export interface PendingQuestionProjectedV2 {
  questionId: string;
  questionVersion: string;
  questionDigest: string;
  originalWorkItemId: string;
  attemptId: string;
  leaseEpoch: number;
  logicalAssignmentId: string;
  authorityBaseRef: BlobRefV2;
  openedSequence: number;
  openedEventId: string;
}

export interface ProjectedPlanLineageV2 {
  lineageId: string;
  currentRevision: number;
  /** revision number -> head record (specs are immutable; supersede chains). */
  revisions: Record<
    string,
    {
      planId: string;
      specRef: BlobRefV2;
      supersedes: string | null;
      state: 'active' | 'superseded' | 'rejected' | 'finalized' | 'completed';
    }
  >;
}

/** Repair lineages keyed by planRevisionId (Plan revision identity). */
export interface ProjectedRepairLineageV2 {
  repairPlanId: string;
  track: 'map' | 'content';
  currentPlanRevisionId: string | null;
  revisions: Record<
    string,
    {
      planRevisionId: string;
      specRef: BlobRefV2;
      supersedesPlanRevisionId: string | null;
      successorReason: string | null;
      state: 'active' | 'superseded' | 'rejected' | 'completed';
    }
  >;
}

export interface ProjectedRoundV2 {
  roundId: string;
  ordinal: number;
  state: 'planned' | 'reviewing' | 'completed' | 'settled';
  consumedOverrideRef: BlobRefV2 | null;
  plannedAtSequence: number;
  /** planned assignment count (round closure gate). */
  assignmentCount: number;
}

export interface ProjectedFindingV2 {
  findingId: string;
  reviewContext: { kind: 'map' | 'content'; roundId: string };
  primaryLocation: { kind: string; id: string };
  defectClass: 'content' | 'map' | 'mixed';
  severity: 'blocking' | 'advisory';
  source: 'reviewer' | 'system_validator';
  state: 'open' | 'addressed' | 'verified_closed';
  addressStages: string[];
  verifiedStages: string[];
  openedBy: { kind: 'reviewer'; reviewerAttemptId: string } | { kind: 'system_validator'; validatorExecutionId: string };
}

export interface AuthoritativeReviewProjectionV2 {
  version: 2;
  workItems: Record<string, WorkItemProjectionV2>;
  attempts: Record<string, AttemptProjectionV2>;
  activeLease: { workItemId: string; leaseEpoch: number; attemptId: string | null; commandId: string | null; leaseOwner: string | null } | null;
  pendingQuestion: PendingQuestionProjectedV2 | null;
  retryBudgetExhaustedWorkItemId: string | null;
  suspension: {
    suspensionId: string;
    reason: 'user_stop' | 'operator_interrupt';
    operationId: string;
    appliedAtSequence: number;
  } | null;
  mapBuilds: Record<string, ProjectedPlanLineageV2>;
  generationPlans: Record<string, ProjectedPlanLineageV2>;
  repairPlans: Record<string, ProjectedRepairLineageV2>;
  migrationValidationPlan: { migrationValidationPlanId: string; planSpecRef: BlobRefV2; startedAtSequence: number } | null;
  migrationBatchOrdinals: number[];
  migrationSettled: boolean;
  currentCandidate: { candidateId: string; candidateRef: BlobRefV2; baseMapId: string | null; buildId: string } | null;
  /** mapBuildId of the current finalized head (candidate admission gate). */
  lastFinalizedBuildId: string | null;
  mapRounds: Record<string, ProjectedRoundV2>;
  contentRounds: Record<string, ProjectedRoundV2>;
  mapCycleOrdinal: number;
  contentCycleOrdinal: number;
  currentMap: {
    mapId: string;
    mapRevision: number;
    supersedesMapId: string | null;
    mapSnapshotRef: BlobRefV2;
    mapReviewBundleRef: BlobRefV2;
    mapSemanticDigest: string;
  } | null;
  /** contentRevisionManifestRef the latest activation declared (pending only until the manifest event commits). */
  activatedManifestBinding: BlobRefV2 | null;
  currentManifest: {
    contentRevisionManifestRef: BlobRefV2;
    taskContentRevision: number;
    manifestPhase: 'baseline_unset' | 'provisional' | 'finalized';
  } | null;
  findings: Record<string, ProjectedFindingV2>;
  currentSeal: {
    sealWorkItemId: string;
    sealRecordRef: BlobRefV2;
    sealValidationBundleRef: BlobRefV2;
    mapRef: BlobRefV2;
    contentRevisionManifestRef: BlobRefV2;
    reviewBundleRef: BlobRefV2;
    artifactRef: BlobRefV2;
    sealedAtSequence: number;
  } | null;
  publishedArtifact: {
    artifactId: string;
    artifactVersion: number;
    deliveryRef: BlobRefV2;
    files: { name: string; hash: string }[];
    mediaType: string;
    producerWorkItemId: string;
    sealRecordRef: BlobRefV2;
    artifactRef: BlobRefV2;
    custodyRef: BlobRefV2;
  } | null;
  delivery: {
    deliveryId: string;
    deliveryRef: BlobRefV2;
    artifactId: string;
    artifactRef: BlobRefV2;
    sealRecordRef: BlobRefV2;
    submitterWorkItemId: string;
  } | null;
  availableOverride: { ref: BlobRefV2; track: 'map' | 'content' } | null;
  consumedOverrideRefs: string[];
  failed: {
    workItemId: string;
    attemptId: string | null;
    commandId: string | null;
    leaseEpoch: number;
    failureCode: string;
    failureDigest: string;
    failureRecoveryPayloadRef: BlobRefV2 | null;
    authorityBaseRef: BlobRefV2;
    atSequence: number;
    eventId: string;
  } | null;
  taskStatus: 'ready' | 'running' | 'stopped' | 'interrupted' | 'waiting_human' | 'retryable_failure' | 'completed' | 'failed';
  lastSequence: number;
}

/** Canonical digest of the whole projected state (checkpoint identity). */
export function projectionDigestOf(state: AuthoritativeReviewProjectionV2): string {
  return canonicalJsonSha256(state);
}

export type ProjectAuthoritativeReviewStateResult =
  | { ok: true; state: AuthoritativeReviewProjectionV2; fold: ProjectionFoldDataV2 }
  | { ok: false; error: ProjectionCorruptionError };

/**
 * The full serializable fold continuation of one projection run: everything
 * the projector needs to resume from a checkpoint at `state.lastSequence`
 * without re-walking genesis. Stored verbatim inside projection checkpoints
 * (spec §9.4); the state module stays the single fold implementation.
 */
export interface ProjectionFoldDataV2 {
  eventIndex: Record<string, { type: string; sequence: number }>;
  consumedQuestionIds: string[];
  answerObligations: ReplacementObligationV2[];
  reopenObligation: ReopenObligationV2 | null;
  submitterObligations: ReplacementObligationV2[];
  contentAssignments: Record<string, AssignmentEntryV2>;
  mapAssignments: Record<string, MapAssignmentEntryV2>;
  observationsByRound: Record<string, Record<string, number>>;
  planToLineage: Record<string, string>;
  bookkeeping: Record<string, Record<string, unknown>>;
  projection: AuthoritativeReviewProjectionV2;
}

/** One content-round assignment record (started -> committed freeze -> completed). */
interface AssignmentEntryV2 {
  started: boolean;
  committed: boolean;
  completed: boolean;
  workItemId: string;
  attemptId: string;
  reviewRoundId: string;
  ledgerRef: BlobRefV2;
  source: string;
}

/**
 * One MAP-round assignment freeze (the committed event IS the ledger
 * freeze for map rounds — the union has no map assignment-started event, so
 * the freeze binds identity + round + ledgerRef and the round completion
 * gate closes by planned-count equality).
 */
interface MapAssignmentEntryV2 {
  workItemId: string;
  attemptId: string;
  reviewRoundId: string;
  reviewAssignmentId: string | null;
  source: string;
  ledgerRef: BlobRefV2;
}

/* ------------------------------------------------------------------ */
/* Internal fold                                                       */
/* ------------------------------------------------------------------ */

interface ReopenObligationV2 {
  recipeKey: RecoveryRecipeKeyV2;
  track: 'map' | 'content' | null;
  expectedKind: string;
  expectedSession: string | null;
  observedCreates: number;
}

/** One unresolved same-envelope successor binding. */
interface ReplacementObligationV2 {
  workItemId: string;
  boundAuthorityBaseRef: BlobRefV2;
  kind: 'answer_replacement' | 'answer_replacement_bound' | 'submitter_workitem' | 'submitter_workitem_bound' | 'delivery_submitter';
}

const NO_OP_FAMILIES = new Set(['structured_finding_verification_recorded'] as const);

const SYSTEM_COMMAND_KIND_BY_WORK_ITEM: Record<string, string> = {
  system_map_finalize: 'map_finalize',
  system_generation_finalize: 'generation_finalize',
  system_repair_finalize: 'repair_finalize',
  system_migration_validation_batch: 'migration_validation_batch',
  system_review_settlement: 'review_settlement',
  system_seal: 'seal',
};

const GRANT_KIND_BY_SESSION: Record<string, string> = {
  structure_chunk: 'initial_structure_chunk',
  generation_batch: 'initial_generation_batch',
  map_repair: 'map_repair_batch',
  content_repair: 'content_repair_batch',
};

const RECOVERY_KIND_BY_FAILURE_CODE: Record<string, string> = {
  REVIEW_REPAIR_LIMIT_EXCEEDED: 'restart_review_cycle',
  ARTIFACT_VALIDATION_FAILED: 'retry_system_command',
  RUNNING_WITHOUT_WORK: 'rebuild_missing_work',
};
/** Internal mutable fold. */
interface Fold {
  projection: AuthoritativeReviewProjectionV2;
  resolver: BlobObjectResolver | undefined;
  /** planId -> lineage key (successor plans share the revision-1 root key). */
  planToLineage: Record<string, string>;
  /** eventId -> { type, sequence } for recovery payload resolution. */
  eventIndex: Record<string, { type: string; sequence: number }>;
  consumedQuestionIds: Set<string>;
  answerObligations: ReplacementObligationV2[];
  reopenObligation: ReopenObligationV2 | null;
  submitterObligations: ReplacementObligationV2[];
  /** assignmentId registry per content round (started -> committed -> completed). */
  contentAssignments: Record<string, AssignmentEntryV2>;
  /** assignmentId registry per MAP round (committed = ledger freeze). */
  mapAssignments: Record<string, MapAssignmentEntryV2>;
  /** observation ids per round (parent/level closure). */
  observationsByRound: Record<string, Record<string, number>>;
}

function createFold(resolver: BlobObjectResolver | undefined): Fold {
  return {
    resolver,
    planToLineage: {},
    eventIndex: {},
    consumedQuestionIds: new Set(),
    answerObligations: [],
    reopenObligation: null,
    submitterObligations: [],
    contentAssignments: {},
    mapAssignments: {},
    observationsByRound: {},
    projection: {
      version: 2,
      workItems: {},
      attempts: {},
      activeLease: null,
      pendingQuestion: null,
      retryBudgetExhaustedWorkItemId: null,
      suspension: null,
      mapBuilds: {},
      generationPlans: {},
      repairPlans: {},
      migrationValidationPlan: null,
      migrationBatchOrdinals: [],
      migrationSettled: false,
      currentCandidate: null,
      lastFinalizedBuildId: null,
      mapRounds: {},
      contentRounds: {},
      mapCycleOrdinal: 0,
      contentCycleOrdinal: 0,
      currentMap: null,
      activatedManifestBinding: null,
      currentManifest: null,
      findings: {},
      currentSeal: null,
      publishedArtifact: null,
      delivery: null,
      availableOverride: null,
      consumedOverrideRefs: [],
      failed: null,
      taskStatus: 'ready',
      lastSequence: 0,
    },
  };
}

function demandWorkItem(fold: Fold, event: AuthoritativeReviewEventV2, sequence: number, workItemId: string): WorkItemProjectionV2 {
  const wi = fold.projection.workItems[workItemId];
  if (wi === undefined) {
    corrupt('unknown_work_item', event, sequence, `workItemId=${workItemId}`);
  }
  return wi;
}

function demandLeaseMatch(
  fold: Fold,
  event: AuthoritativeReviewEventV2,
  sequence: number,
  workItemId: string,
  leaseEpoch: number,
): void {
  const lease = fold.projection.activeLease;
  if (lease === null || lease.workItemId !== workItemId || lease.leaseEpoch !== leaseEpoch) {
    corrupt('no_active_lease', event, sequence, `workItemId=${workItemId} leaseEpoch=${leaseEpoch}`);
  }
}

function demandBaseMatch(
  fold: Fold,
  event: AuthoritativeReviewEventV2,
  sequence: number,
  wi: WorkItemProjectionV2,
  leaseEpoch: number,
  authorityBaseRef: BlobRefV2,
): void {
  const leasedBase = wi.leaseBases[String(leaseEpoch)];
  if (leasedBase !== undefined && !sameRef(leasedBase, authorityBaseRef)) {
    corrupt('stale_authority_base', event, sequence, `workItemId=${wi.workItemId} epoch=${leaseEpoch}`);
  }
}

function clearActiveLease(fold: Fold, event: AuthoritativeReviewEventV2, sequence: number, workItemId: string, leaseEpoch: number): void {
  const lease = fold.projection.activeLease;
  if (lease === null || lease.workItemId !== workItemId || lease.leaseEpoch !== leaseEpoch) {
    corrupt('lease_mismatch_on_clear', event, sequence, `workItemId=${workItemId} leaseEpoch=${leaseEpoch}`);
  }
  fold.projection.activeLease = null;
}

function resolveParsed(fold: Fold, event: AuthoritativeReviewEventV2, sequence: number, kind: string, ref: BlobRefV2): Record<string, unknown> {
  if (fold.resolver === undefined) {
    corrupt('resolver_required', event, sequence, `kind=${kind}`);
  }
  let raw: unknown;
  try {
    raw = fold.resolver!(ref);
  } catch (error) {
    if (error instanceof BlobDemandSignal) {
      // The async driver's lazy-resolution boundary: the signal must reach
      // the driver, never become a corruption diagnostic.
      throw error;
    }
    corrupt('blob_unresolvable', event, sequence, `ref=${ref.kind}:${ref.digest.slice(0, 12)} (${(error as Error).message})`);
  }
  if (raw !== null && typeof raw === 'object' && typeof (raw as { then?: unknown }).then === 'function') {
    corrupt('async_resolver_in_sync_fold', event, sequence, `ref=${ref.kind}:${ref.digest.slice(0, 12)}`);
  }
  try {
    // Shape parse by the closed registry WITHOUT re-checking the digest: byte
    // identity is the blob store's job (`readParsed` verifies the ref against
    // the canonical bytes); here only the schema and the kind matter.
    const parsed = parseBlob(kind as never, raw);
    const computed = parsed.ref;
    if (computed.kind !== ref.kind) {
      corrupt('blob_kind_mismatch', event, sequence, `ref=${ref.kind} blob=${computed.kind}`);
    }
    return parsed.object as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SchemaError) {
      corrupt('blob_malformed', event, sequence, `${kind}:${ref.digest.slice(0, 12)} (${error.message})`);
    }
    throw error;
  }
}

/** Reads a string field of a parsed blob (malformed content fails closed). */
function blobField(obj: Record<string, unknown>, key: string): unknown {
  const value = obj[key];
  if (value === undefined || value === null) {
    throw new SchemaError(`${key} missing`);
  }
  return value;
}

function blobString(obj: Record<string, unknown>, key: string): string {
  const value = blobField(obj, key);
  if (typeof value !== 'string') throw new SchemaError(`${key} must be a string`);
  return value;
}

function blobNumber(obj: Record<string, unknown>, key: string): number {
  const value = blobField(obj, key);
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new SchemaError(`${key} must be an integer`);
  return value;
}

function blobRef(obj: Record<string, unknown>, key: string): BlobRefV2 {
  const value = blobField(obj, key);
  if (typeof value !== 'object' || value === null || typeof (value as { digest?: unknown }).digest !== 'string') {
    throw new SchemaError(`${key} must be a ref`);
  }
  return value as BlobRefV2;
}

/* ------------------------------------------------------------------ */
/* Plan lineages                                                       */
/* ------------------------------------------------------------------ */

/** Finds the lineage a plan id belongs to (successors share the revision-1 key). */
function lineageKeyOf(fold: Fold, planId: string): string | undefined {
  return fold.planToLineage[planId];
}

/** Shared head/chain rules for numeric-revision plan families. */
function applyPlanStarted(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_map_build_started' | 'structured_generation_plan_started' }>,
  sequence: number,
  lineages: Record<string, ProjectedPlanLineageV2>,
  lineageId: string,
  revision: number,
  supersedes: string | null,
  specRef: BlobRefV2,
): void {
  let key = lineageId;
  if (supersedes !== null) {
    const known = lineageKeyOf(fold, supersedes);
    if (known === undefined) {
      corrupt('successor_unknown', event, sequence, `lineage=${lineageId} supersedes=${supersedes}`);
    }
    key = known;
  }
  const lineage = lineages[key];
  if (lineage === undefined) {
    if (revision !== 1) {
      corrupt('successor_unknown', event, sequence, `lineage=${lineageId} revision=${revision}`);
    }
    if (supersedes !== null) {
      corrupt('first_revision_with_successor', event, sequence, `lineage=${lineageId}`);
    }
    lineages[key] = {
      lineageId: key,
      currentRevision: revision,
      revisions: {
        [String(revision)]: { planId: lineageId, specRef, supersedes: null, state: 'active' },
      },
    };
    fold.planToLineage[lineageId] = key;
    return;
  }
  const existing = lineage.revisions[String(revision)];
  const head = lineage.revisions[String(lineage.currentRevision)];
  if (supersedes === null) {
    if (existing !== undefined) {
      corrupt('revision_clash', event, sequence, `lineage=${key} revision=${revision}`);
    }
    corrupt('successor_required', event, sequence, `lineage=${key} revision=${revision}`);
  }
  if (head === undefined || head.planId !== supersedes || lineage.currentRevision !== revision - 1) {
    corrupt('competing_successor', event, sequence, `lineage=${key} revision=${revision} supersedes=${supersedes}`);
  }
  if (existing !== undefined) {
    corrupt('revision_clash', event, sequence, `lineage=${key} revision=${revision}`);
  }
  head.state = 'superseded';
  lineage.currentRevision = revision;
  lineage.revisions[String(revision)] = { planId: lineageId, specRef, supersedes, state: 'active' };
  fold.planToLineage[lineageId] = key;
}

/* ------------------------------------------------------------------ */
/* Event application                                                    */
/* ------------------------------------------------------------------ */

function applyEvent(fold: Fold, event: AuthoritativeReviewEventV2, sequence: number): void {
  const p = fold.projection;
  fold.eventIndex[event.id] = { type: event.type, sequence };
  p.lastSequence = sequence;
  switch (event.type) {
    case 'structured_task_retry_resumed_v2':
      return applyAgentResume(fold, event, sequence);
    case 'structured_work_item_resumed':
      return applyAgentResume(fold, event, sequence);
    case 'structured_work_item_created': {
      if (p.workItems[event.workItemId] !== undefined) {
        corrupt('dup_work_item', event, sequence, `workItemId=${event.workItemId}`);
      }
      // Same-envelope deferred bindings (answer replacement / submitter
      // workitem) resolve here.
      for (const obligation of fold.answerObligations) {
        if (obligation.workItemId === event.workItemId) {
          if (!sameRef(obligation.boundAuthorityBaseRef, event.authorityBaseRef)) {
            corrupt('answer_base_mismatch', event, sequence, `workItemId=${event.workItemId}`);
          }
          obligation.kind = 'answer_replacement_bound';
        }
      }
      for (const obligation of fold.submitterObligations) {
        if (obligation.workItemId === event.workItemId) {
          if (
            event.kind !== 'agent_assignment' ||
            event.agentExecutionKind !== 'generic_turn' ||
            event.inputArtifactDeliveryId === null ||
            event.inputArtifactDeliveryId !== (p.delivery?.deliveryId ?? null)
          ) {
            corrupt('submitter_mismatch', event, sequence, `workItemId=${event.workItemId}`);
          }
          obligation.kind = 'submitter_workitem_bound';
        }
      }
      if (fold.reopenObligation !== null) {
        fold.reopenObligation.observedCreates += 1;
        if (fold.reopenObligation.observedCreates === 1) {
          const expected = fold.reopenObligation;
          const kindMatches = expected.expectedKind === 'unchecked' || event.kind === expected.expectedKind;
          const sessionMatches = expected.expectedSession === null || event.sessionKind === expected.expectedSession;
          if (!kindMatches || !sessionMatches) {
            corrupt('reopen_replacement_kind', event, sequence, `expected kind=${expected.expectedKind} session=${expected.expectedSession ?? '*'}`);
          }
          fold.reopenObligation = null; // bound by the first legal creation
        }
      }
      p.workItems[event.workItemId] = {
        workItemId: event.workItemId,
        kind: event.kind,
        roleBinding: event.roleBinding,
        agentExecutionKind: event.agentExecutionKind,
        sessionKind: event.sessionKind,
        roundId: event.roundId,
        logicalAssignmentId: event.logicalAssignmentId,
        reviewAssignmentId: event.reviewAssignmentId,
        grantSpecRef: event.grantSpecRef,
        inputArtifactDeliveryId: event.inputArtifactDeliveryId,
        scopeDecisionReason: event.scopeDecisionReason ?? null,
        authorityBaseRef: event.authorityBaseRef,
        payloadRef: event.payloadRef,
        leaseEpoch: event.initialLeaseEpoch,
        leaseOwner: null,
        leaseExpiresAt: null,
        attemptCount: 0,
        retryOrdinal: 0,
        retryNotBefore: null,
        maxAutomaticRetries: event.maxAutomaticRetries,
        state: 'ready',
        parkDisposition: null,
        leaseBases: {},
        terminalEventId: null,
      };
      // A declared roundId must reference a known round.
      if (event.roundId !== null) {
        const round = p.mapRounds[event.roundId] ?? p.contentRounds[event.roundId];
        if (round === undefined) {
          corrupt('round_unknown', event, sequence, `roundId=${event.roundId}`);
        }
      }
      return;
    }
    default:
      return applyEventDefault(fold, event, sequence);
  }
}

/** Epoch-advancing resume of a parked workitem (budget disposition only). */
/** The lease attempt/command must have ended before a park or leased-supersede. */
function demandCycleEndedForDisposition(
  fold: Fold,
  event: AuthoritativeReviewEventV2,
  sequence: number,
  wi: WorkItemProjectionV2,
  reason: 'park' | 'supersede',
): void {
  if (wi.state !== 'leased') {
    return; // non-leased supersedes carry no live attempt to terminate
  }
  const active = fold.projection.activeLease?.attemptId ?? fold.projection.activeLease?.commandId ?? null;
  const attempt = active === null ? undefined : fold.projection.attempts[active];
  if (attempt === undefined || (attempt.state !== 'terminal_failed' && attempt.state !== 'abandoned')) {
    corrupt(
      reason === 'park' ? 'park_without_terminal' : 'supersede_without_terminal',
      event,
      sequence,
      `workItemId=${wi.workItemId} attempt=${String(active)} state=${attempt?.state ?? 'none'}`,
    );
  }
}

function applyAgentResume(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_work_item_resumed' | 'structured_task_retry_resumed_v2' }>,
  sequence: number,
): void {
  const p = fold.projection;
  const wi = demandWorkItem(fold, event, sequence, event.workItemId);
  if (wi.state !== 'parked') {
    corrupt('transition_resume', event, sequence, `workItemId=${event.workItemId} state=${wi.state}`);
  }
  if (event.leaseEpoch !== wi.leaseEpoch + 1) {
    corrupt('resume_epoch', event, sequence, `workItemId=${event.workItemId} event=${event.leaseEpoch} current=${wi.leaseEpoch}`);
  }
  if (wi.parkDisposition === null || wi.parkDisposition.kind !== 'retry_budget_exhausted') {
    corrupt('resume_human_disposition', event, sequence, `workItemId=${event.workItemId}`);
  }
  if (p.retryBudgetExhaustedWorkItemId !== event.workItemId) {
    corrupt('resume_budget_owner', event, sequence, `workItemId=${event.workItemId}`);
  }
  wi.state = 'ready';
  wi.leaseEpoch = event.leaseEpoch;
  wi.parkDisposition = null;
  wi.retryOrdinal = 0;
  p.retryBudgetExhaustedWorkItemId = null;
}

/** The lease-time authority base of one epoch (staleness checks). */
function wrappedLeaseBase(wi: WorkItemProjectionV2, leaseEpoch: number): BlobRefV2 | undefined {
  return wi.leaseBases[String(leaseEpoch)];
}

function applyEventDefault(fold: Fold, event: AuthoritativeReviewEventV2, sequence: number): void {
  const p = fold.projection;
  switch (event.type) {
    case 'structured_work_item_leased': {
      const wi = demandWorkItem(fold, event, sequence, event.workItemId);
      if (wi.state !== 'ready') {
        corrupt('transition_lease', event, sequence, `workItemId=${event.workItemId} state=${wi.state}`);
      }
      if (p.activeLease !== null) {
        corrupt('second_active_lease', event, sequence, `active=${p.activeLease.workItemId}`);
      }
      if (event.leaseEpoch !== wi.leaseEpoch + 1) {
        corrupt('lease_epoch', event, sequence, `workItemId=${event.workItemId} event=${event.leaseEpoch} current=${wi.leaseEpoch}`);
      }
      wi.state = 'leased';
      wi.leaseEpoch = event.leaseEpoch;
      wi.leaseOwner = event.leaseOwner;
      wi.leaseExpiresAt = event.leaseExpiresAt;
      wi.leaseBases[String(event.leaseEpoch)] = event.authorityBaseRef;
      p.activeLease = { workItemId: event.workItemId, leaseEpoch: event.leaseEpoch, attemptId: null, commandId: null, leaseOwner: event.leaseOwner };
      return;
    }
    case 'structured_assignment_dispatched': {
      const wi = demandWorkItem(fold, event, sequence, event.workItemId);
      const lease = p.activeLease;
      if (lease === null || lease.workItemId !== event.workItemId) {
        corrupt('dispatch_without_lease', event, sequence, `workItemId=${event.workItemId}`);
      }
      const leaseBase = wrappedLeaseBase(wi, lease.leaseEpoch);
      if (leaseBase === undefined || !sameRef(leaseBase, event.authorityBaseRef)) {
        corrupt('stale_authority_base', event, sequence, `workItemId=${event.workItemId}`);
      }
      if (wi.agentExecutionKind !== event.agentExecutionKind) {
        corrupt('attempt_kind', event, sequence, `workItemId=${event.workItemId}`);
      }
      if (event.logicalAssignmentId !== wi.logicalAssignmentId || event.reviewAssignmentId !== wi.reviewAssignmentId) {
        corrupt('identity_mismatch', event, sequence, `workItemId=${event.workItemId}`);
      }
      if (event.agentExecutionKind === 'structured_session' && event.sessionKind !== wi.sessionKind) {
        corrupt('attempt_kind', event, sequence, `workItemId=${event.workItemId}`);
      }
      if (event.agentExecutionKind === 'generic_turn' && event.inputArtifactDeliveryId !== wi.inputArtifactDeliveryId) {
        corrupt('identity_mismatch', event, sequence, `workItemId=${event.workItemId}`);
      }
      if (lease.attemptId !== null) {
        corrupt('dispatch_duplicate', event, sequence, `workItemId=${event.workItemId}`);
      }
      lease.attemptId = event.attemptId;
      return;
    }
    case 'structured_agent_attempt_started_v2':
    case 'structured_agent_attempt_completed_v2':
    case 'structured_agent_attempt_retryable_failed_v2':
    case 'structured_agent_attempt_terminal_failed_v2':
    case 'structured_agent_attempt_abandoned_v2':
      return applyAgentAttempt(fold, event, sequence, 'structured');
    case 'structured_generic_agent_attempt_started':
    case 'structured_generic_agent_attempt_completed':
    case 'structured_generic_agent_attempt_retryable_failed':
    case 'structured_generic_agent_attempt_terminal_failed':
    case 'structured_generic_agent_attempt_abandoned':
      return applyAgentAttempt(fold, event, sequence, 'generic');
    case 'structured_system_command_started':
    case 'structured_system_command_completed':
    case 'structured_system_command_retryable_failed':
    case 'structured_system_command_terminal_failed':
    case 'structured_system_command_abandoned':
      return applySystemCommand(fold, event, sequence);
    case 'structured_work_item_completed': {
      const wi = demandWorkItem(fold, event, sequence, event.workItemId);
      if (wi.state !== 'leased' || wi.leaseEpoch !== event.leaseEpoch) {
        corrupt('transition_complete', event, sequence, `workItemId=${event.workItemId} state=${wi.state}`);
      }
      demandBaseMatch(fold, event, sequence, wi, event.leaseEpoch, event.authorityBaseRef);
      const active = p.activeLease?.attemptId ?? p.activeLease?.commandId ?? null;
      const attempt = active === null ? undefined : p.attempts[active];
      if (attempt === undefined || attempt.state !== 'completed') {
        corrupt('workitem_complete_without_attempt', event, sequence, `attempt=${String(active)}`);
      }
      wi.state = 'completed';
      clearActiveLease(fold, event, sequence, event.workItemId, event.leaseEpoch);
      return;
    }
    case 'structured_work_item_retryable_failed': {
      const wi = demandWorkItem(fold, event, sequence, event.workItemId);
      if (wi.state !== 'leased' || wi.leaseEpoch !== event.leaseEpoch) {
        corrupt('transition_retryable', event, sequence, `workItemId=${event.workItemId} state=${wi.state}`);
      }
      demandBaseMatch(fold, event, sequence, wi, event.leaseEpoch, event.authorityBaseRef);
      if (event.retryOrdinal !== wi.retryOrdinal + 1) {
        corrupt('retry_ordinal', event, sequence, `workItemId=${event.workItemId} event=${event.retryOrdinal} current=${wi.retryOrdinal}`);
      }
      if (event.retryOrdinal > wi.maxAutomaticRetries) {
        corrupt('failed_budget', event, sequence, `retryOrdinal=${event.retryOrdinal} max=${wi.maxAutomaticRetries}`);
      }
      const active = p.activeLease?.attemptId ?? p.activeLease?.commandId ?? null;
      const attempt = active === null ? undefined : p.attempts[active];
      if (attempt === undefined || attempt.state !== 'retryable_failed') {
        corrupt('workitem_failure_without_attempt', event, sequence, `attempt=${String(active)}`);
      }
      wi.state = 'retryable_failed';
      wi.retryOrdinal = event.retryOrdinal;
      wi.retryNotBefore = event.retryNotBefore;
      clearActiveLease(fold, event, sequence, event.workItemId, event.leaseEpoch);
      return;
    }
    case 'structured_work_item_requeued': {
      const wi = demandWorkItem(fold, event, sequence, event.workItemId);
      if (wi.state !== 'retryable_failed' || wi.leaseEpoch !== event.leaseEpoch) {
        corrupt('transition_requeue', event, sequence, `workItemId=${event.workItemId} state=${wi.state}`);
      }
      demandBaseMatch(fold, event, sequence, wi, event.leaseEpoch, event.authorityBaseRef);
      wi.state = 'ready';
      return;
    }
    case 'structured_work_item_lease_reclaimed': {
      const wi = demandWorkItem(fold, event, sequence, event.workItemId);
      if (wi.state !== 'leased' || wi.leaseEpoch !== event.leaseEpoch) {
        corrupt('transition_reclaim', event, sequence, `workItemId=${event.workItemId} state=${wi.state}`);
      }
      demandBaseMatch(fold, event, sequence, wi, event.leaseEpoch, event.authorityBaseRef);
      const active = p.activeLease?.attemptId ?? p.activeLease?.commandId ?? null;
      const attempt = active === null ? undefined : p.attempts[active];
      if (attempt === undefined || attempt.state !== 'abandoned') {
        corrupt('attempt_not_abandoned', event, sequence, `workItemId=${event.workItemId} attempt=${String(active)}`);
      }
      wi.state = 'ready';
      wi.leaseEpoch = event.leaseEpoch + 1;
      wi.leaseOwner = null;
      wi.leaseExpiresAt = null;
      clearActiveLease(fold, event, sequence, event.workItemId, event.leaseEpoch);
      return;
    }
    case 'structured_work_item_terminal_failed': {
      const wi = demandWorkItem(fold, event, sequence, event.workItemId);
      if (wi.state !== 'leased' || wi.leaseEpoch !== event.leaseEpoch) {
        corrupt('transition_terminal', event, sequence, `workItemId=${event.workItemId} state=${wi.state}`);
      }
      demandBaseMatch(fold, event, sequence, wi, event.leaseEpoch, event.authorityBaseRef);
      const terminalId = event.terminalAttemptId ?? event.terminalCommandId;
      const attempt = terminalId === null ? undefined : p.attempts[terminalId];
      if (attempt === undefined || attempt.state !== 'terminal_failed') {
        corrupt('terminal_attempt_mismatch', event, sequence, `workItemId=${event.workItemId}`);
      }
      // Both terminal ids are kept: the attempt's own terminal event AND the
      // workitem-level terminal event of the same envelope.
      attempt.workItemTerminalEventId = event.id;
      wi.state = 'terminal_failed';
      wi.terminalEventId = event.id;
      clearActiveLease(fold, event, sequence, event.workItemId, event.leaseEpoch);
      return;
    }
    case 'structured_work_item_parked': {
      const wi = demandWorkItem(fold, event, sequence, event.workItemId);
      if (wi.state !== 'leased' || wi.leaseEpoch !== event.leaseEpoch) {
        corrupt('transition_park', event, sequence, `workItemId=${event.workItemId} state=${wi.state}`);
      }
      demandBaseMatch(fold, event, sequence, wi, event.leaseEpoch, event.authorityBaseRef);
      // §9.2/§17.3: no half-visible state — the attempt/command terminal or
      // abandon is atomic with the park (same envelope, processed before it).
      demandCycleEndedForDisposition(fold, event, sequence, wi, 'park');
      if (event.parkDisposition.kind === 'retry_budget_exhausted') {
        if (p.retryBudgetExhaustedWorkItemId !== null && p.retryBudgetExhaustedWorkItemId !== event.workItemId) {
          corrupt('second_budget_disposition', event, sequence, `existing=${p.retryBudgetExhaustedWorkItemId}`);
        }
        if (event.parkDisposition.retryOrdinal !== wi.retryOrdinal + 1) {
          corrupt('park_retry_ordinal', event, sequence, `workItemId=${event.workItemId}`);
        }
        if (event.parkDisposition.retryOrdinal <= wi.maxAutomaticRetries) {
          corrupt('park_budget_not_exhausted', event, sequence, `retryOrdinal=${event.parkDisposition.retryOrdinal} max=${wi.maxAutomaticRetries}`);
        }
        p.retryBudgetExhaustedWorkItemId = event.workItemId;
      } else {
        const question = p.pendingQuestion;
        if (
          question === null ||
          question.questionId !== event.parkDisposition.questionId ||
          question.questionVersion !== event.parkDisposition.questionVersion
        ) {
          corrupt('question_park_mismatch', event, sequence, `workItemId=${event.workItemId}`);
        }
      }
      wi.state = 'parked';
      wi.parkDisposition = { ...event.parkDisposition };
      clearActiveLease(fold, event, sequence, event.workItemId, event.leaseEpoch);
      return;
    }
    case 'structured_work_item_superseded': {
      const wi = demandWorkItem(fold, event, sequence, event.workItemId);
      if (!['ready', 'leased', 'retryable_failed', 'parked'].includes(wi.state)) {
        corrupt('transition_superseded', event, sequence, `workItemId=${event.workItemId} state=${wi.state}`);
      }
      if (wi.leaseEpoch !== event.leaseEpoch) {
        corrupt('supersede_epoch', event, sequence, `workItemId=${event.workItemId}`);
      }
      demandBaseMatch(fold, event, sequence, wi, event.leaseEpoch, event.authorityBaseRef);
      demandCycleEndedForDisposition(fold, event, sequence, wi, 'supersede');
      if (event.reason === 'human_disposition') {
        if (wi.parkDisposition === null || wi.parkDisposition.kind !== 'human_question') {
          corrupt('supersede_question_expected', event, sequence, `workItemId=${event.workItemId}`);
        }
        if (!fold.consumedQuestionIds.has(wi.parkDisposition.questionId)) {
          corrupt('supersede_unanswered_question', event, sequence, `workItemId=${event.workItemId}`);
        }
      }
      if (wi.parkDisposition?.kind === 'retry_budget_exhausted' && p.retryBudgetExhaustedWorkItemId === event.workItemId) {
        p.retryBudgetExhaustedWorkItemId = null;
      }
      if (wi.state === 'leased') {
        clearActiveLease(fold, event, sequence, event.workItemId, event.leaseEpoch);
      }
      wi.state = 'superseded';
      return;
    }
    default:
      return applyEventTail(fold, event, sequence);
  }
}
const ATTEMPT_TERMINALS: Record<string, 'completed' | 'retryable_failed' | 'terminal_failed' | 'abandoned'> = {
  structured_agent_attempt_completed_v2: 'completed',
  structured_agent_attempt_retryable_failed_v2: 'retryable_failed',
  structured_agent_attempt_terminal_failed_v2: 'terminal_failed',
  structured_agent_attempt_abandoned_v2: 'abandoned',
  structured_generic_agent_attempt_completed: 'completed',
  structured_generic_agent_attempt_retryable_failed: 'retryable_failed',
  structured_generic_agent_attempt_terminal_failed: 'terminal_failed',
  structured_generic_agent_attempt_abandoned: 'abandoned',
};

/** Agent attempt events: family legality + lease/identity binding + transitions. */
function applyAgentAttempt(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: string; workItemId: string; logicalAssignmentId: string; leaseEpoch: number; authorityBaseRef: BlobRefV2 }>,
  sequence: number,
  family: 'structured' | 'generic',
): void {
  const p = fold.projection;
  const wi = demandWorkItem(fold, event, sequence, event.workItemId);
  const lease = p.activeLease;
  if (lease === null || lease.workItemId !== event.workItemId || lease.leaseEpoch !== event.leaseEpoch) {
    corrupt('attempt_without_active_lease', event, sequence, `workItemId=${event.workItemId} epoch=${event.leaseEpoch}`);
  }
  demandBaseMatch(fold, event, sequence, wi, event.leaseEpoch, event.authorityBaseRef);
  if (family === 'structured') {
    if (wi.agentExecutionKind !== 'structured_session') {
      corrupt('attempt_kind', event, sequence, `workItemId=${event.workItemId}`);
    }
    const structuredEvent = event as Extract<AuthoritativeReviewEventV2, { type: `structured_agent_attempt_${'started' | 'completed'}_v2` }>;
    if (structuredEvent.sessionKind !== wi.sessionKind) {
      corrupt('attempt_kind', event, sequence, `workItemId=${event.workItemId} session=${structuredEvent.sessionKind}`);
    }
    if (structuredEvent.logicalAssignmentId !== wi.logicalAssignmentId || structuredEvent.reviewAssignmentId !== wi.reviewAssignmentId) {
      corrupt('identity_mismatch', event, sequence, `workItemId=${event.workItemId}`);
    }
    if (lease.attemptId !== structuredEvent.attemptId) {
      corrupt('attempt_identity_mismatch', event, sequence, `attemptId=${structuredEvent.attemptId} bound=${lease.attemptId ?? 'none'}`);
    }
  } else {
    const genericEvent = event as Extract<AuthoritativeReviewEventV2, { type: `structured_generic_agent_attempt_${'started' | 'completed'}` }>;
    if (wi.agentExecutionKind !== 'generic_turn') {
      corrupt('attempt_kind', event, sequence, `workItemId=${event.workItemId}`);
    }
    if (genericEvent.logicalAssignmentId !== wi.logicalAssignmentId) {
      corrupt('identity_mismatch', event, sequence, `workItemId=${event.workItemId}`);
    }
    if (genericEvent.inputArtifactDeliveryId !== wi.inputArtifactDeliveryId) {
      corrupt('identity_mismatch', event, sequence, `workItemId=${event.workItemId}`);
    }
    if (genericEvent.agentId !== lease.leaseOwner) {
      corrupt('attempt_agent_mismatch', event, sequence, `agentId=${genericEvent.agentId} owner=${lease.leaseOwner}`);
    }
    if (lease.attemptId !== genericEvent.attemptId) {
      corrupt('attempt_identity_mismatch', event, sequence, `attemptId=${genericEvent.attemptId} bound=${lease.attemptId ?? 'none'}`);
    }
    // The Submitter only submits the exact current delivery.
    if (p.delivery === null || p.delivery.deliveryId !== genericEvent.inputArtifactDeliveryId) {
      corrupt('delivery_unknown', event, sequence, `deliveryId=${genericEvent.inputArtifactDeliveryId}`);
    }
  }
  const terminal = ATTEMPT_TERMINALS[event.type];
  const existing = p.attempts[(event as { attemptId: string }).attemptId];
  if (terminal === undefined) {
    // started
    if (existing !== undefined) {
      corrupt('attempt_duplicate', event, sequence, `attemptId=${(event as { attemptId: string }).attemptId}`);
    }
    p.attempts[String((event as { attemptId: string }).attemptId)] = {
      attemptId: String((event as { attemptId: string }).attemptId),
      family,
      workItemId: event.workItemId,
      leaseEpoch: event.leaseEpoch,
      state: 'started',
      agentId: family === 'generic' ? (event as { agentId: string }).agentId : null,
      logicalAssignmentId: event.logicalAssignmentId,
      reviewAssignmentId: family === 'structured' ? (event as { reviewAssignmentId: string | null }).reviewAssignmentId : null,
      sessionKind: family === 'structured' ? (event as { sessionKind: string }).sessionKind : null,
      commandKind: null,
      inputArtifactDeliveryId: family === 'generic' ? (event as { inputArtifactDeliveryId: string }).inputArtifactDeliveryId : null,
      terminalEventId: null,
      workItemTerminalEventId: null,
      failureCode: null,
    };
    wi.attemptCount += 1;
    return;
  }
  if (existing === undefined) {
    corrupt('attempt_unknown', event, sequence, `attemptId=${(event as { attemptId: string }).attemptId}`);
  }
  const attempt = existing;
  if (attempt.workItemId !== event.workItemId || attempt.leaseEpoch !== event.leaseEpoch || attempt.family !== family) {
    corrupt('attempt_identity_mismatch', event, sequence, `attemptId=${attempt.attemptId}`);
  }
  if (terminal === 'completed' && attempt.state !== 'started') {
    corrupt('attempt_transition', event, sequence, `attemptId=${attempt.attemptId}`);
  }
  if ((terminal === 'retryable_failed' || terminal === 'terminal_failed') && attempt.state !== 'started') {
    corrupt('attempt_transition', event, sequence, `attemptId=${attempt.attemptId}`);
  }
  if (terminal === 'abandoned' && attempt.state !== 'started') {
    corrupt('attempt_transition', event, sequence, `attemptId=${attempt.attemptId}`);
  }
  attempt.state = terminal;
  if (terminal === 'terminal_failed') {
    attempt.terminalEventId = event.id;
    attempt.failureCode = (event as { failureCode: string }).failureCode;
  }
  if (terminal === 'retryable_failed') {
    const failureEvent = event as { retryOrdinal: number; retryNotBefore: string; failureCode: string };
    if (failureEvent.retryOrdinal !== wi.retryOrdinal + 1) {
      corrupt('retry_ordinal', event, sequence, `attemptId=${attempt.attemptId} event=${failureEvent.retryOrdinal} current=${wi.retryOrdinal}`);
    }
    if (failureEvent.retryOrdinal > wi.maxAutomaticRetries) {
      corrupt('failed_budget', event, sequence, `retryOrdinal=${failureEvent.retryOrdinal} max=${wi.maxAutomaticRetries}`);
    }
    attempt.failureCode = failureEvent.failureCode;
  }
}

const COMMAND_TERMINALS: Record<string, 'completed' | 'retryable_failed' | 'terminal_failed' | 'abandoned'> = {
  structured_system_command_completed: 'completed',
  structured_system_command_retryable_failed: 'retryable_failed',
  structured_system_command_terminal_failed: 'terminal_failed',
  structured_system_command_abandoned: 'abandoned',
};

/** SystemCommand events: workitem-kind/commandKind mapping + lease bound identity. */
function applySystemCommand(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: string; workItemId: string; commandKind: string; commandId: string; leaseEpoch: number; authorityBaseRef: BlobRefV2 }>,
  sequence: number,
): void {
  const p = fold.projection;
  const wi = demandWorkItem(fold, event, sequence, event.workItemId);
  const expectedKind = SYSTEM_COMMAND_KIND_BY_WORK_ITEM[wi.kind];
  if (expectedKind === undefined || event.commandKind !== expectedKind) {
    corrupt('command_kind', event, sequence, `workItemId=${event.workItemId} commandKind=${event.commandKind} expected=${expectedKind ?? wi.kind}`);
  }
  const lease = p.activeLease;
  if (lease === null || lease.workItemId !== event.workItemId || lease.leaseEpoch !== event.leaseEpoch) {
    corrupt('command_without_active_lease', event, sequence, `workItemId=${event.workItemId} epoch=${event.leaseEpoch}`);
  }
  demandBaseMatch(fold, event, sequence, wi, event.leaseEpoch, event.authorityBaseRef);
  const terminal = COMMAND_TERMINALS[event.type];
  const existing = p.attempts[event.commandId];
  if (terminal === undefined) {
    if (existing !== undefined) {
      corrupt('command_duplicate', event, sequence, `commandId=${event.commandId}`);
    }
    if (lease.commandId !== null) {
      corrupt('command_without_lease_slot', event, sequence, `workItemId=${event.workItemId}`);
    }
    p.attempts[event.commandId] = {
      attemptId: event.commandId,
      family: 'command',
      workItemId: event.workItemId,
      leaseEpoch: event.leaseEpoch,
      state: 'started',
      agentId: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      sessionKind: null,
      commandKind: event.commandKind,
      inputArtifactDeliveryId: null,
      terminalEventId: null,
      workItemTerminalEventId: null,
      failureCode: null,
    };
    lease.commandId = event.commandId;
    return;
  }
  if (existing === undefined) {
    corrupt('command_unknown', event, sequence, `commandId=${event.commandId}`);
  }
  const command = existing;
  if (command.workItemId !== event.workItemId || command.leaseEpoch !== event.leaseEpoch || command.commandKind !== event.commandKind) {
    corrupt('command_identity_mismatch', event, sequence, `commandId=${event.commandId}`);
  }
  // EVERY command terminal requires the started state — no exemption. A
  // permanently failed command can never be re-issued as retryable (the
  // terminal identity, e.g. ARTIFACT_VALIDATION_FAILED, would be erased);
  // the agent path enforces the identical rule.
  if (command.state !== 'started') {
    corrupt('command_transition', event, sequence, `commandId=${event.commandId} state=${command.state}`);
  }
  command.state = terminal;
  if (terminal === 'terminal_failed') {
    command.terminalEventId = event.id;
    command.failureCode = (event as { failureCode: string }).failureCode;
  }
  if (terminal === 'retryable_failed') {
    const failureEvent = event as { retryOrdinal: number; retryNotBefore: string; failureCode: string };
    if (failureEvent.retryOrdinal !== wi.retryOrdinal + 1) {
      corrupt('retry_ordinal', event, sequence, `commandId=${event.commandId}`);
    }
    if (failureEvent.retryOrdinal > wi.maxAutomaticRetries) {
      corrupt('failed_budget', event, sequence, `commandId=${event.commandId}`);
    }
    // The ordinal bump belongs to the workitem-level `..._retryable_failed`
    // event (one incremented ordinal is shared by the command and workitem
    // failure events of the same envelope, exactly like the agent path).
    command.failureCode = failureEvent.failureCode;
  }
}
/* ------------------------------------------------------------------ */
/* Tail events: plans, rounds, findings, seal chain, failure, reopen   */
/* ------------------------------------------------------------------ */

function applyEventTail(fold: Fold, event: AuthoritativeReviewEventV2, sequence: number): void {
  const p = fold.projection;
  switch (event.type) {
    case 'structured_task_suspension_applied_v2': {
      if (p.suspension !== null) {
        corrupt('second_overlay', event, sequence, `existing=${p.suspension.suspensionId}`);
      }
      p.suspension = { suspensionId: event.suspensionId, reason: event.reason, operationId: event.operationId, appliedAtSequence: sequence };
      return;
    }
    case 'structured_task_suspension_cleared_v2': {
      if (p.suspension === null || p.suspension.suspensionId !== event.suspensionId) {
        corrupt('no_active_overlay', event, sequence, `suspensionId=${event.suspensionId}`);
      }
      p.suspension = null;
      return;
    }
    case 'structured_human_question_opened_v2':
      return applyQuestionOpened(fold, event, sequence);
    case 'structured_human_answer_delivered_v2':
      return applyAnswerDelivered(fold, event, sequence);
    case 'structured_map_build_started':
      applyPlanStarted(fold, event, sequence, p.mapBuilds, event.mapBuildId, event.revision, event.supersedesMapBuildId, event.mapBuildSpecRef);
      return;
    case 'structured_map_chunk_committed': {
      const key = lineageKeyOf(fold, event.mapBuildId);
      const lineage = key === undefined ? undefined : p.mapBuilds[key];
      if (lineage === undefined) {
        corrupt('chunk_unknown_build', event, sequence, `mapBuildId=${event.mapBuildId}`);
      }
      const head = lineage.revisions[String(lineage.currentRevision)];
      if (head === undefined || head.planId !== event.mapBuildId || head.state !== 'active') {
        corrupt('chunk_on_finalized_build', event, sequence, `mapBuildId=${event.mapBuildId}`);
      }
      const lastOrdinal = lastChunkOrdinalFor(fold, event.mapBuildId);
      if (event.chunkOrdinal !== lastOrdinal + 1) {
        corrupt('chunk_ordinal', event, sequence, `mapBuildId=${event.mapBuildId} ordinal=${event.chunkOrdinal} expected=${lastOrdinal + 1}`);
      }
      recordChunkOrdinal(fold, event.mapBuildId, event.chunkOrdinal);
      return;
    }
    case 'structured_map_build_finish_proposed': {
      const key = lineageKeyOf(fold, event.mapBuildId);
      const lineage = key === undefined ? undefined : p.mapBuilds[key];
      if (lineage === undefined || lineage.revisions[String(lineage.currentRevision)]?.planId !== event.mapBuildId) {
        corrupt('finish_unknown_build', event, sequence, `mapBuildId=${event.mapBuildId}`);
      }
      if (lineage.revisions[String(lineage.currentRevision)]?.state !== 'active') {
        corrupt('finish_stale_build', event, sequence, `mapBuildId=${event.mapBuildId}`);
      }
      if (hasProposalFor(fold, event.mapBuildId)) {
        corrupt('finish_duplicate', event, sequence, `mapBuildId=${event.mapBuildId}`);
      }
      recordProposal(fold, event.mapBuildId);
      return;
    }
    case 'structured_map_build_rejected': {
      const key = lineageKeyOf(fold, event.mapBuildId);
      const lineage = key === undefined ? undefined : p.mapBuilds[key];
      if (lineage === undefined || lineage.revisions[String(lineage.currentRevision)]?.planId !== event.mapBuildId) {
        corrupt('reject_unknown_build', event, sequence, `mapBuildId=${event.mapBuildId}`);
      }
      const head = lineage.revisions[String(lineage.currentRevision)];
      if (head === undefined || head.state !== 'active') {
        corrupt('reject_stale_build', event, sequence, `mapBuildId=${event.mapBuildId}`);
      }
      head.state = 'rejected';
      return;
    }
    case 'structured_map_build_finalized': {
      const key = lineageKeyOf(fold, event.mapBuildId);
      const lineage = key === undefined ? undefined : p.mapBuilds[key];
      if (lineage === undefined || lineage.revisions[String(lineage.currentRevision)]?.planId !== event.mapBuildId) {
        corrupt('finalize_unknown_build', event, sequence, `mapBuildId=${event.mapBuildId}`);
      }
      const head = lineage.revisions[String(lineage.currentRevision)];
      if (head === undefined || head.state !== 'active') {
        corrupt('finalize_stale_build', event, sequence, `mapBuildId=${event.mapBuildId}`);
      }
      if (!hasProposalFor(fold, event.mapBuildId)) {
        corrupt('finalize_without_proposal', event, sequence, `mapBuildId=${event.mapBuildId}`);
      }
      head.state = 'finalized';
      p.lastFinalizedBuildId = event.mapBuildId;
      return;
    }
    case 'structured_map_candidate_committed': {
      // The candidate event does not name its MapBuild; the unique active
      // candidate must follow the CURRENT head finalize (design §17.5).
      const finalized = p.lastFinalizedBuildId;
      if (finalized === null) {
        corrupt('candidate_without_finalized', event, sequence, `candidateId=${event.candidateId}`);
      }
      if (p.currentCandidate !== null && p.currentCandidate.buildId === finalized) {
        corrupt('candidate_duplicate', event, sequence, `candidateId=${event.candidateId}`);
      }
      p.currentCandidate = { candidateId: event.candidateId, candidateRef: event.candidateRef, baseMapId: event.baseMapId, buildId: finalized ?? '' };
      return;
    }
    case 'structured_generation_plan_started':
      applyPlanStarted(fold, event, sequence, p.generationPlans, event.generationPlanId, event.revision, event.supersedesGenerationPlanId, event.generationPlanSpecRef);
      return;
    case 'structured_generation_batch_committed': {
      const key = lineageKeyOf(fold, event.generationPlanId);
      const lineage = key === undefined ? undefined : p.generationPlans[key];
      if (lineage === undefined || lineage.revisions[String(lineage.currentRevision)]?.planId !== event.generationPlanId) {
        corrupt('batch_unknown_plan', event, sequence, `generationPlanId=${event.generationPlanId}`);
      }
      const head = lineage.revisions[String(lineage.currentRevision)];
      if (head === undefined || head.state !== 'active') {
        corrupt('batch_stale_plan', event, sequence, `generationPlanId=${event.generationPlanId}`);
      }
      const lastOrdinal = lastGenerationBatchOrdinalFor(fold, event.generationPlanId);
      if (event.batchOrdinal !== lastOrdinal + 1) {
        corrupt('batch_ordinal', event, sequence, `generationPlanId=${event.generationPlanId} ordinal=${event.batchOrdinal}`);
      }
      recordGenerationBatchOrdinal(fold, event.generationPlanId, event.batchOrdinal);
      return;
    }
    case 'structured_generation_plan_rejected': {
      const key = lineageKeyOf(fold, event.generationPlanId);
      const lineage = key === undefined ? undefined : p.generationPlans[key];
      if (lineage === undefined || lineage.revisions[String(lineage.currentRevision)]?.planId !== event.generationPlanId) {
        corrupt('reject_unknown_plan', event, sequence, `generationPlanId=${event.generationPlanId}`);
      }
      const head = lineage.revisions[String(lineage.currentRevision)];
      if (head === undefined || head.state !== 'active') {
        corrupt('reject_stale_plan', event, sequence, `generationPlanId=${event.generationPlanId}`);
      }
      head.state = 'rejected';
      return;
    }
    case 'structured_generation_plan_completed': {
      const key = lineageKeyOf(fold, event.generationPlanId);
      const lineage = key === undefined ? undefined : p.generationPlans[key];
      if (lineage === undefined || lineage.revisions[String(lineage.currentRevision)]?.planId !== event.generationPlanId) {
        corrupt('complete_unknown_plan', event, sequence, `generationPlanId=${event.generationPlanId}`);
      }
      const head = lineage.revisions[String(lineage.currentRevision)];
      if (head === undefined || head.state !== 'active') {
        corrupt('complete_stale_plan', event, sequence, `generationPlanId=${event.generationPlanId}`);
      }
      if ((lastGenerationBatchOrdinalFor(fold, event.generationPlanId) ?? 0) < 1) {
        corrupt('complete_without_batch', event, sequence, `generationPlanId=${event.generationPlanId}`);
      }
      if (p.currentManifest === null || !sameRef(p.currentManifest.contentRevisionManifestRef, event.contentRevisionManifestRef)) {
        corrupt('plan_manifest_mismatch', event, sequence, `generationPlanId=${event.generationPlanId}`);
      }
      head.state = 'completed';
      return;
    }
    case 'structured_migration_validation_plan_started': {
      if (p.migrationValidationPlan !== null) {
        corrupt('migration_duplicate', event, sequence, `migrationValidationPlanId=${event.migrationValidationPlanId}`);
      }
      p.migrationValidationPlan = {
        migrationValidationPlanId: event.migrationValidationPlanId,
        planSpecRef: event.planSpecRef,
        startedAtSequence: sequence,
      };
      p.migrationBatchOrdinals = [];
      p.migrationSettled = false;
      return;
    }
    case 'structured_migration_validation_batch_completed': {
      if (p.migrationValidationPlan === null) {
        corrupt('migration_batch_without_plan', event, sequence);
      }
      if (!sameRef(p.migrationValidationPlan.planSpecRef, event.planSpecRef)) {
        corrupt('migration_batch_plan_mismatch', event, sequence);
      }
      const last = p.migrationBatchOrdinals[p.migrationBatchOrdinals.length - 1] ?? -1;
      if (event.batchOrdinal !== last + 1) {
        corrupt('migration_batch_ordinal', event, sequence, `ordinal=${event.batchOrdinal} expected=${last + 1}`);
      }
      p.migrationBatchOrdinals.push(event.batchOrdinal);
      return;
    }
    case 'structured_migration_validation_settlement_completed': {
      if (p.migrationValidationPlan === null) {
        corrupt('migration_settlement_without_plan', event, sequence);
      }
      if (p.migrationSettled) {
        corrupt('migration_settlement_duplicate', event, sequence);
      }
      // Settlement closes the active lineage. A later approved replacement Map
      // starts a fresh plan at ordinal zero; concurrent/duplicate starts remain
      // rejected while this field is non-null.
      p.migrationValidationPlan = null;
      p.migrationBatchOrdinals = [];
      p.migrationSettled = false;
      return;
    }
    case 'structured_map_repair_plan_started':
    case 'structured_content_repair_plan_started':
      return applyRepairPlanStarted(fold, event, sequence);
    case 'structured_repair_plan_revision_started':
      return applyRepairRevisionStarted(fold, event, sequence);
    case 'structured_map_repair_batch_committed':
    case 'structured_content_repair_batch_committed':
      return applyRepairBatchCommitted(fold, event, sequence);
    case 'structured_map_repair_plan_rejected':
    case 'structured_content_repair_plan_rejected':
      return applyRepairPlanRejected(fold, event, sequence);
    case 'structured_repair_scope_requested':
      return applyRepairScopeRequested(fold, event, sequence);
    case 'structured_repair_scope_expansion_approved_v2':
      return applyRepairScopeExpansionApproved(fold, event, sequence);
    case 'structured_repair_scope_expansion_rejected_v2': {
      demandRepairHead(fold, event, sequence, event.repairPlanId, event.planRevisionId);
      return;
    }
    case 'structured_repair_grant_issued': {
      const wi = demandWorkItem(fold, event, sequence, event.workItemId);
      if (wi.kind !== 'agent_assignment' || wi.sessionKind === null || GRANT_KIND_BY_SESSION[wi.sessionKind] !== event.grantKind) {
        corrupt('grant_kind', event, sequence, `workItemId=${event.workItemId} grantKind=${event.grantKind}`);
      }
      return;
    }
    case 'structured_repair_committed': {
      demandRepairHead(fold, event, sequence, event.repairPlanId, event.planRevisionId);
      const attempt = p.attempts[event.attemptId];
      if (attempt === undefined || attempt.workItemId !== event.workItemId) {
        corrupt('repair_attempt_mismatch', event, sequence, `attemptId=${event.attemptId}`);
      }
      return;
    }
    case 'structured_finding_opened':
      return applyFindingOpened(fold, event, sequence);
    case 'structured_finding_addressed':
      return applyFindingAddressed(fold, event, sequence);
    case 'structured_finding_verification_recorded':
      return applyFindingVerification(fold, event, sequence, false);
    case 'structured_validator_finding_verification_recorded':
      return applyFindingVerification(fold, event, sequence, true);
    case 'structured_finding_verified_closed':
      return applyFindingClosed(fold, event, sequence);
    case 'structured_map_review_round_planned':
      return applyMapRoundPlanned(fold, event, sequence);
    case 'structured_review_round_planned':
      return applyContentRoundPlanned(fold, event, sequence);
    case 'structured_map_review_assignment_committed':
      return applyMapAssignmentCommitted(fold, event, sequence);
    case 'structured_review_assignment_started':
    case 'structured_content_review_assignment_committed':
      return applyContentAssignment(fold, event, sequence);
    case 'structured_review_assignment_completed':
      return applyAssignmentCompleted(fold, event, sequence);
    case 'structured_map_observation_recorded':
      return applyObservation(fold, event, sequence, event.mapReviewRoundId, event.observationId, event.level, event.parentObservationId, 'map');
    case 'structured_whole_tree_observation_recorded':
      return applyObservation(fold, event, sequence, event.reviewRoundId, event.observationId, event.level, event.parentObservationId, 'content');
    case 'structured_map_review_round_completed':
      return applyRoundCompleted(fold, event, sequence, event.mapReviewRoundId, 'map');
    case 'structured_review_round_completed':
      return applyRoundCompleted(fold, event, sequence, event.reviewRoundId, 'content');
    case 'structured_map_review_round_settled': {
      const round = p.mapRounds[event.mapReviewRoundId];
      if (round === undefined || round.state !== 'completed') {
        corrupt('round_not_completed', event, sequence, `mapReviewRoundId=${event.mapReviewRoundId}`);
      }
      round.state = 'settled';
      return;
    }
    case 'structured_review_round_settled': {
      const round = p.contentRounds[event.reviewRoundId];
      if (round === undefined || round.state !== 'completed') {
        corrupt('round_not_completed', event, sequence, `reviewRoundId=${event.reviewRoundId}`);
      }
      round.state = 'settled';
      return;
    }
    case 'structured_map_activated':
      return applyMapActivated(fold, event, sequence);
    case 'structured_content_revision_committed':
      return applyManifestCommitted(fold, event, sequence);
    case 'structured_scaffold_sealed_v2':
      return applySealed(fold, event, sequence);
    case 'structured_seal_validation_rejected_v2': {
      const wi = demandWorkItem(fold, event, sequence, event.sealWorkItemId);
      if (wi.kind !== 'system_seal') {
        corrupt('seal_workitem_kind', event, sequence, `sealWorkItemId=${event.sealWorkItemId}`);
      }
      return;
    }
    case 'artifact_published_v2':
      return applyArtifactPublished(fold, event, sequence);
    case 'structured_system_artifact_delivery_created':
      return applyDeliveryCreated(fold, event, sequence);
    case 'structured_round_budget_override_transferred_v2':
      return applyOverrideTransfer(fold, event, sequence);
    case 'structured_task_failed_v2':
      return applyTaskFailed(fold, event, sequence);
    case 'structured_task_reopened_v2':
      return applyTaskReopened(fold, event, sequence);
    default:
      // Remaining members are informational/observability events that carry
      // no foldable state of their own, or events validated upstream whose
      // semantics surface in later tasks (e.g. verification records beyond
      // the closed check). They never fold silently when a rule exists.
      return;
  }
}

/** The pending legal state of a numeric plan family at the time of a terminal event. */
function demandActiveHead(
  fold: Fold,
  event: AuthoritativeReviewEventV2,
  sequence: number,
  lineage: ProjectedPlanLineageV2,
  planId: string,
): void {
  const head = lineage.revisions[String(lineage.currentRevision)];
  if (head === undefined || head.planId !== planId || head.state !== 'active') {
    corrupt('plan_not_current', event, sequence, `lineage=${lineage.lineageId} refers ${planId}`);
  }
}
/* ------------------------------------------------------------------ */
/* Per-family handlers                                                  */
/* ------------------------------------------------------------------ */

function applyRepairPlanStarted(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_map_repair_plan_started' | 'structured_content_repair_plan_started' }>,
  sequence: number,
): void {
  const p = fold.projection;
  const track = event.type === 'structured_map_repair_plan_started' ? 'map' : 'content';
  const existing = p.repairPlans[event.repairPlanId];
  if (existing !== undefined) {
    if (existing.revisions[event.planRevisionId] !== undefined) {
      corrupt('revision_clash', event, sequence, `repairPlanId=${event.repairPlanId} planRevisionId=${event.planRevisionId}`);
    }
    if (existing.currentPlanRevisionId !== null) {
      corrupt('repair_plan_reopen', event, sequence, `repairPlanId=${event.repairPlanId} already exists`);
    }
    existing.currentPlanRevisionId = event.planRevisionId;
    existing.revisions[event.planRevisionId] = {
      planRevisionId: event.planRevisionId,
      specRef: event.repairPlanSpecRef,
      supersedesPlanRevisionId: null,
      successorReason: null,
      state: 'active',
    };
    return;
  }
  p.repairPlans[event.repairPlanId] = {
    repairPlanId: event.repairPlanId,
    track,
    currentPlanRevisionId: event.planRevisionId,
    revisions: {
      [event.planRevisionId]: {
        planRevisionId: event.planRevisionId,
        specRef: event.repairPlanSpecRef,
        supersedesPlanRevisionId: null,
        successorReason: null,
        state: 'active',
      },
    },
  };
}

function applyRepairRevisionStarted(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_repair_plan_revision_started' }>,
  sequence: number,
): void {
  const p = fold.projection;
  const lineage = p.repairPlans[event.repairPlanId];
  if (lineage === undefined) {
    corrupt('repair_lineage_unknown', event, sequence, `repairPlanId=${event.repairPlanId}`);
  }
  if (lineage.revisions[event.planRevisionId] !== undefined) {
    corrupt('revision_clash', event, sequence, `planRevisionId=${event.planRevisionId}`);
  }
  if (event.supersedesPlanRevisionId !== null) {
    const head = lineage.currentPlanRevisionId === null ? undefined : lineage.revisions[lineage.currentPlanRevisionId];
    if (head === undefined || head.planRevisionId !== event.supersedesPlanRevisionId) {
      corrupt('competing_successor', event, sequence, `repairPlanId=${event.repairPlanId} supersedes=${event.supersedesPlanRevisionId}`);
    }
    head.state = 'superseded';
  } else if (lineage.currentPlanRevisionId !== null) {
    corrupt('successor_required', event, sequence, `repairPlanId=${event.repairPlanId}`);
  }
  lineage.currentPlanRevisionId = event.planRevisionId;
  lineage.revisions[event.planRevisionId] = {
    planRevisionId: event.planRevisionId,
    specRef: event.repairPlanSpecRef,
    supersedesPlanRevisionId: event.supersedesPlanRevisionId,
    successorReason: event.successorReason,
    state: 'active',
  };
}

function demandRepairHead(
  fold: Fold,
  event: AuthoritativeReviewEventV2,
  sequence: number,
  repairPlanId: string,
  planRevisionId: string,
): void {
  const lineage = fold.projection.repairPlans[repairPlanId];
  if (lineage === undefined) {
    corrupt('repair_lineage_unknown', event, sequence, `repairPlanId=${repairPlanId}`);
  }
  const head = lineage.currentPlanRevisionId === null ? undefined : lineage.revisions[lineage.currentPlanRevisionId];
  if (head === undefined || head.planRevisionId !== planRevisionId) {
    corrupt('repair_plan_not_current', event, sequence, `repairPlanId=${repairPlanId} planRevisionId=${planRevisionId}`);
  }
  if (head.state !== 'active') {
    corrupt('repair_plan_stale', event, sequence, `repairPlanId=${repairPlanId} planRevisionId=${planRevisionId}`);
  }
}

function applyRepairBatchCommitted(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_map_repair_batch_committed' | 'structured_content_repair_batch_committed' }>,
  sequence: number,
): void {
  demandRepairHead(fold, event, sequence, event.repairPlanId, event.planRevisionId);
  const last = lastRepairBatchOrdinalFor(fold, event.repairPlanId, event.planRevisionId);
  if (event.batchOrdinal !== last + 1) {
    corrupt('repair_batch_ordinal', event, sequence, `repairPlanId=${event.repairPlanId} ordinal=${event.batchOrdinal} expected=${last + 1}`);
  }
  recordRepairBatchOrdinal(fold, event.repairPlanId, event.planRevisionId, event.batchOrdinal);
}

function applyRepairPlanRejected(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_map_repair_plan_rejected' | 'structured_content_repair_plan_rejected' }>,
  sequence: number,
): void {
  demandRepairHead(fold, event, sequence, event.repairPlanId, event.planRevisionId);
  const lineage = fold.projection.repairPlans[event.repairPlanId];
  const head = lineage.currentPlanRevisionId === null ? undefined : lineage.revisions[lineage.currentPlanRevisionId];
  if (head !== undefined) {
    head.state = 'rejected';
  }
}

function applyRepairScopeRequested(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_repair_scope_requested' }>,
  sequence: number,
): void {
  demandRepairHead(fold, event, sequence, event.repairPlanId, event.planRevisionId);
}

function applyRepairScopeExpansionApproved(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_repair_scope_expansion_approved_v2' }>,
  sequence: number,
): void {
  demandRepairHead(fold, event, sequence, event.repairPlanId, event.supersededPlanRevisionId);
  const lineage = fold.projection.repairPlans[event.repairPlanId];
  if (lineage.revisions[event.successorPlanRevisionId] !== undefined) {
    corrupt('revision_clash', event, sequence, `successorPlanRevisionId=${event.successorPlanRevisionId}`);
  }
  const head = lineage.currentPlanRevisionId === null ? undefined : lineage.revisions[lineage.currentPlanRevisionId];
  if (head !== undefined) {
    head.state = 'superseded';
  }
  lineage.currentPlanRevisionId = event.successorPlanRevisionId;
  lineage.revisions[event.successorPlanRevisionId] = {
    planRevisionId: event.successorPlanRevisionId,
    specRef: event.successorPlanSpecRef,
    supersedesPlanRevisionId: event.supersededPlanRevisionId,
    successorReason: 'scope_expansion',
    state: 'active',
  };
}

function applyQuestionOpened(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_human_question_opened_v2' }>,
  sequence: number,
): void {
  const p = fold.projection;
  const wi = demandWorkItem(fold, event, sequence, event.originalWorkItemId);
  if (wi.state !== 'leased' || wi.leaseEpoch !== event.leaseEpoch) {
    corrupt('question_epoch', event, sequence, `workItemId=${event.originalWorkItemId}`);
  }
  demandLeaseMatch(fold, event, sequence, event.originalWorkItemId, event.leaseEpoch);
  demandBaseMatch(fold, event, sequence, wi, event.leaseEpoch, event.authorityBaseRef);
  const leaseAttemptId = p.activeLease?.attemptId;
  if (leaseAttemptId === null || leaseAttemptId !== event.attemptId) {
    corrupt('question_without_attempt', event, sequence, `attemptId=${event.attemptId}`);
  }
  const attempt = p.attempts[event.attemptId];
  if (attempt === undefined || attempt.family !== 'structured') {
    corrupt('question_attempt_mismatch', event, sequence, `attemptId=${event.attemptId}`);
  }
  if (event.logicalAssignmentId !== wi.logicalAssignmentId) {
    corrupt('identity_mismatch', event, sequence, `question=${event.questionId}`);
  }
  if (p.pendingQuestion !== null) {
    corrupt('second_question', event, sequence, `existing=${p.pendingQuestion.questionId}`);
  }
  p.pendingQuestion = {
    questionId: event.questionId,
    questionVersion: event.questionVersion,
    questionDigest: event.questionDigest,
    originalWorkItemId: event.originalWorkItemId,
    attemptId: event.attemptId,
    leaseEpoch: event.leaseEpoch,
    logicalAssignmentId: event.logicalAssignmentId,
    authorityBaseRef: event.authorityBaseRef,
    openedSequence: sequence,
    openedEventId: event.id,
  };
}

function applyAnswerDelivered(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_human_answer_delivered_v2' }>,
  sequence: number,
): void {
  const p = fold.projection;
  const question = p.pendingQuestion;
  if (
    question === null ||
    question.questionId !== event.questionId ||
    question.questionVersion !== event.questionVersion ||
    question.originalWorkItemId !== event.originalWorkItemId ||
    question.logicalAssignmentId !== event.logicalAssignmentId
  ) {
    corrupt('question_not_pending', event, sequence, `questionId=${event.questionId}`);
  }
  if (fold.consumedQuestionIds.has(event.questionId)) {
    corrupt('question_second_delivery', event, sequence, `questionId=${event.questionId}`);
  }
  if (question !== null && !sameRef(question.authorityBaseRef, event.authorityBaseRef)) {
    // §17.3 CAS: the original WorkItem/authority base must still match at
    // answer time — a stale base means the answer targets an old cycle.
    corrupt('answer_base_stale', event, sequence, `questionId=${event.questionId}`);
  }
  p.pendingQuestion = null;
  fold.consumedQuestionIds.add(event.questionId);
  fold.answerObligations.push({
    workItemId: event.replacementWorkItemId,
    boundAuthorityBaseRef: event.authorityBaseRef,
    kind: 'answer_replacement',
  });
}

function applyFindingOpened(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_finding_opened' }>,
  sequence: number,
): void {
  const p = fold.projection;
  if (p.findings[event.findingId] !== undefined) {
    corrupt('finding_duplicate', event, sequence, `findingId=${event.findingId}`);
  }
  const round = event.reviewContext.kind === 'map' ? p.mapRounds[event.reviewContext.roundId] : p.contentRounds[event.reviewContext.roundId];
  if (round === undefined) {
    corrupt('finding_context_round', event, sequence, `roundId=${event.reviewContext.roundId}`);
  }
  if (event.source === 'reviewer' && event.openedBy.kind === 'reviewer') {
    const attempt = p.attempts[event.openedBy.reviewerAttemptId];
    if (attempt === undefined || attempt.family !== 'structured') {
      corrupt('finding_reviewer_attempt', event, sequence, `reviewerAttemptId=${event.openedBy.reviewerAttemptId}`);
    }
  }
  p.findings[event.findingId] = {
    findingId: event.findingId,
    reviewContext: { ...event.reviewContext },
    primaryLocation: { ...event.primaryLocation },
    defectClass: event.defectClass,
    severity: event.severity,
    source: event.source,
    state: 'open',
    addressStages: [],
    verifiedStages: [],
    openedBy: { ...event.openedBy },
  };
}

const REQUIRED_STAGES_BY_DEFECT: Record<string, string[]> = {
  content: ['content'],
  map: ['map'],
  mixed: ['map', 'content'],
};

function applyFindingAddressed(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_finding_addressed' }>,
  sequence: number,
): void {
  const finding = fold.projection.findings[event.findingId];
  if (finding === undefined) {
    corrupt('finding_unknown', event, sequence, `findingId=${event.findingId}`);
  }
  if (finding.state === 'verified_closed') {
    corrupt('finding_closed_readdress', event, sequence, `findingId=${event.findingId}`);
  }
  const legalStages = REQUIRED_STAGES_BY_DEFECT[finding.defectClass];
  if (!legalStages.includes(event.repairStage)) {
    corrupt('finding_stage', event, sequence, `findingId=${event.findingId} stage=${event.repairStage} defect=${finding.defectClass}`);
  }
  const lineage = fold.projection.repairPlans[event.repairPlanId];
  if (lineage === undefined || lineage.track !== event.repairStage) {
    corrupt('repair_plan_unknown', event, sequence, `repairPlanId=${event.repairPlanId}`);
  }
  if (!finding.addressStages.includes(event.repairStage)) {
    finding.addressStages.push(event.repairStage);
  }
  finding.state = 'addressed';
}

function applyFindingVerification(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_finding_verification_recorded' | 'structured_validator_finding_verification_recorded' }>,
  sequence: number,
  _validator: boolean,
): void {
  const finding = fold.projection.findings[event.findingId];
  if (finding === undefined) {
    corrupt('finding_unknown', event, sequence, `findingId=${event.findingId}`);
  }
  // Verification is intentionally cross-round: the Finding remains bound to
  // the round that opened it, while the record is bound to the later round
  // that reviewed the repaired artifact. The later round must exist and its
  // track must equal the stage being verified; accepting only the opening
  // context made every real repair verification impossible.
  const verificationRound = event.reviewContext.kind === 'map'
    ? fold.projection.mapRounds[event.reviewContext.roundId]
    : fold.projection.contentRounds[event.reviewContext.roundId];
  if (verificationRound === undefined || event.reviewContext.kind !== event.repairStage) {
    corrupt('finding_context_round', event, sequence, `findingId=${event.findingId} roundId=${event.reviewContext.roundId}`);
  }
  if (event.type === 'structured_finding_verification_recorded' && finding.source !== 'reviewer') {
    corrupt('finding_verifier_source', event, sequence, `findingId=${event.findingId}`);
  }
  if (event.type === 'structured_validator_finding_verification_recorded' && finding.source !== 'system_validator') {
    corrupt('finding_verifier_source', event, sequence, `findingId=${event.findingId}`);
  }
  if (finding.verifiedStages.includes(event.repairStage)) {
    corrupt('verification_stage_repeat', event, sequence, `findingId=${event.findingId} stage=${event.repairStage}`);
  }
  if (!finding.addressStages.includes(event.repairStage)) {
    corrupt('verification_without_address', event, sequence, `findingId=${event.findingId} stage=${event.repairStage}`);
  }
  if (event.verdict === 'resolved') {
    finding.verifiedStages.push(event.repairStage);
  } else {
    // `still_present` is a completed verification whose result is a new
    // repair obligation. Reset only the rejected stage to pending so the same
    // settlement creates the deterministic successor RepairPlan.
    finding.addressStages = finding.addressStages.filter((stage) => stage !== event.repairStage);
    finding.state = 'open';
  }
}

function applyFindingClosed(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_finding_verified_closed' }>,
  sequence: number,
): void {
  const finding = fold.projection.findings[event.findingId];
  if (finding === undefined) {
    corrupt('finding_unknown', event, sequence, `findingId=${event.findingId}`);
  }
  if (finding.state === 'verified_closed') {
    corrupt('finding_second_close', event, sequence, `findingId=${event.findingId}`);
  }
  const required = REQUIRED_STAGES_BY_DEFECT[finding.defectClass];
  const allAddressed = required.every((stage) => finding.addressStages.includes(stage));
  const allVerified = required.every((stage) => finding.verifiedStages.includes(stage));
  if (!allAddressed || !allVerified) {
    corrupt('close_unverified', event, sequence, `findingId=${event.findingId}`);
  }
  finding.state = 'verified_closed';
}

function applyMapRoundPlanned(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_round_planned' }>,
  sequence: number,
): void {
  const p = fold.projection;
  if (p.mapRounds[event.mapReviewRoundId] !== undefined) {
    corrupt('round_duplicate', event, sequence, `mapReviewRoundId=${event.mapReviewRoundId}`);
  }
  if (event.mapCycleOrdinal !== p.mapCycleOrdinal + 1) {
    corrupt('round_ordinal', event, sequence, `ordinal=${event.mapCycleOrdinal} expected=${p.mapCycleOrdinal + 1}`);
  }
  if (event.consumedOverrideRef !== null) {
    applyOverrideConsumption(fold, event, sequence, event.consumedOverrideRef, 'map');
  }
  if (
    p.currentCandidate === null ||
    p.currentCandidate.candidateId !== event.candidateId ||
    !sameRef(p.currentCandidate.candidateRef, event.candidateRef)
  ) {
    corrupt('candidate_mismatch', event, sequence, `candidateId=${event.candidateId}`);
  }
  p.mapRounds[event.mapReviewRoundId] = {
    roundId: event.mapReviewRoundId,
    ordinal: event.mapCycleOrdinal,
    state: 'planned',
    consumedOverrideRef: event.consumedOverrideRef,
    plannedAtSequence: sequence,
    assignmentCount: event.assignmentCount,
  };
  p.mapCycleOrdinal = event.mapCycleOrdinal;
}

function applyContentRoundPlanned(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_review_round_planned' }>,
  sequence: number,
): void {
  const p = fold.projection;
  if (p.contentRounds[event.reviewRoundId] !== undefined) {
    corrupt('round_duplicate', event, sequence, `reviewRoundId=${event.reviewRoundId}`);
  }
  if (event.contentCycleOrdinal !== p.contentCycleOrdinal + 1) {
    corrupt('round_ordinal', event, sequence, `ordinal=${event.contentCycleOrdinal} expected=${p.contentCycleOrdinal + 1}`);
  }
  if (event.consumedOverrideRef !== null) {
    applyOverrideConsumption(fold, event, sequence, event.consumedOverrideRef, 'content');
  }
  if (p.currentManifest === null || !sameRef(p.currentManifest.contentRevisionManifestRef, event.contentRevisionManifestRef)) {
    corrupt('manifest_mismatch', event, sequence, `reviewRoundId=${event.reviewRoundId}`);
  }
  if (p.currentMap === null || !sameRef(p.currentMap.mapSnapshotRef, event.mapRef)) {
    corrupt('map_mismatch', event, sequence, `reviewRoundId=${event.reviewRoundId}`);
  }
  p.contentRounds[event.reviewRoundId] = {
    roundId: event.reviewRoundId,
    ordinal: event.contentCycleOrdinal,
    state: 'planned',
    consumedOverrideRef: event.consumedOverrideRef,
    plannedAtSequence: sequence,
    assignmentCount: event.assignmentCount,
  };
  p.contentCycleOrdinal = event.contentCycleOrdinal;
}

function demandAssignmentIdentities(
  fold: Fold,
  event: AuthoritativeReviewEventV2,
  sequence: number,
  workItemId: string,
  attemptId: string,
  reviewAssignmentId: string | null,
): void {
  const wi = fold.projection.workItems[workItemId];
  if (wi === undefined) {
    corrupt('unknown_work_item', event, sequence, `workItemId=${workItemId}`);
  }
  if (wi.reviewAssignmentId !== reviewAssignmentId || wi.logicalAssignmentId === null) {
    corrupt('identity_mismatch', event, sequence, `workItemId=${workItemId}`);
  }
  const attempt = fold.projection.attempts[attemptId];
  if (attempt === undefined || attempt.workItemId !== workItemId || attempt.family !== 'structured') {
    corrupt('assignment_attempt', event, sequence, `attemptId=${attemptId}`);
  }
}

function applyMapAssignmentCommitted(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_assignment_committed' }>,
  sequence: number,
): void {
  const round = fold.projection.mapRounds[event.mapReviewRoundId];
  if (round === undefined || ['completed', 'settled'].includes(round.state)) {
    corrupt('round_unknown', event, sequence, `mapReviewRoundId=${event.mapReviewRoundId}`);
  }
  if (fold.mapAssignments[event.assignmentId] !== undefined) {
    corrupt('assignment_duplicate', event, sequence, `assignmentId=${event.assignmentId}`);
  }
  demandAssignmentIdentities(fold, event, sequence, event.workItemId, event.attemptId, event.reviewAssignmentId);
  // The committed event IS the ledger freeze for map rounds: bind identity,
  // round, source and the frozen ledgerRef.
  fold.mapAssignments[event.assignmentId] = {
    workItemId: event.workItemId,
    attemptId: event.attemptId,
    reviewRoundId: event.mapReviewRoundId,
    reviewAssignmentId: event.reviewAssignmentId,
    source: event.source,
    ledgerRef: event.ledgerRef,
  };
  round.state = 'reviewing';
}

function applyContentAssignment(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_review_assignment_started' | 'structured_content_review_assignment_committed' }>,
  sequence: number,
): void {
  const round = fold.projection.contentRounds[event.reviewRoundId];
  if (round === undefined || ['completed', 'settled'].includes(round.state)) {
    corrupt('round_unknown', event, sequence, `reviewRoundId=${event.reviewRoundId}`);
  }
  demandAssignmentIdentities(fold, event, sequence, event.workItemId, event.attemptId, event.reviewAssignmentId);
  if (event.type === 'structured_review_assignment_started') {
    const entry = fold.contentAssignments[event.assignmentId];
    if (entry !== undefined && entry.started) {
      corrupt('assignment_duplicate', event, sequence, `assignmentId=${event.assignmentId}`);
    }
    fold.contentAssignments[event.assignmentId] = {
      started: true,
      committed: false,
      completed: false,
      workItemId: event.workItemId,
      attemptId: event.attemptId,
      reviewRoundId: event.reviewRoundId,
      ledgerRef: { kind: 'review_assignment_ledger', digest: '', byteLength: 0, mediaType: 'application/json', schemaVersion: 1 },
      source: event.source,
    };
  } else {
    const entry = fold.contentAssignments[event.assignmentId];
    if (entry === undefined || !entry.started) {
      corrupt('assignment_without_start', event, sequence, `assignmentId=${event.assignmentId}`);
    }
    if (entry.committed) {
      corrupt('assignment_duplicate', event, sequence, `assignmentId=${event.assignmentId}`);
    }
    if (
      entry.workItemId !== event.workItemId ||
      entry.attemptId !== event.attemptId ||
      entry.reviewRoundId !== event.reviewRoundId
    ) {
      corrupt('assignment_identity_mismatch', event, sequence, `assignmentId=${event.assignmentId}`);
    }
    entry.committed = true;
    entry.ledgerRef = event.ledgerRef;
    entry.source = event.source;
  }
  round.state = 'reviewing';
}

/**
 * F1: `structured_review_assignment_completed` is the authoritative freeze of
 * the AssignmentLedgerBlob (design §12.4) — never informational. The
 * completed event must reference the STARTED+COMMITTED assignment, carry the
 * exact workitem/attempt/round/ledger identity of the committed record, and
 * the round may only complete after every one of its assignments has.
 */
function applyAssignmentCompleted(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_review_assignment_completed' }>,
  sequence: number,
): void {
  const round = fold.projection.contentRounds[event.reviewRoundId];
  if (round === undefined || ['completed', 'settled'].includes(round.state)) {
    corrupt('round_unknown', event, sequence, `reviewRoundId=${event.reviewRoundId}`);
  }
  const entry = fold.contentAssignments[event.assignmentId];
  if (entry === undefined || !entry.started || !entry.committed) {
    corrupt('assignment_without_commit', event, sequence, `assignmentId=${event.assignmentId}`);
  }
  if (entry.completed) {
    corrupt('assignment_duplicate', event, sequence, `assignmentId=${event.assignmentId}`);
  }
  if (
    entry.workItemId !== event.workItemId ||
    entry.attemptId !== event.attemptId ||
    entry.reviewRoundId !== event.reviewRoundId
  ) {
    corrupt('assignment_identity_mismatch', event, sequence, `assignmentId=${event.assignmentId}`);
  }
  if (!sameRef(entry.ledgerRef, event.ledgerRef)) {
    corrupt('assignment_ledger_mismatch', event, sequence, `assignmentId=${event.assignmentId}`);
  }
  if (event.source !== entry.source) {
    corrupt('assignment_ledger_mismatch', event, sequence, `assignmentId=${event.assignmentId}`);
  }
  entry.completed = true;
}

function applyObservation(
  fold: Fold,
  event: AuthoritativeReviewEventV2,
  sequence: number,
  roundId: string,
  observationId: string,
  level: number,
  parentObservationId: string | null,
  kind: 'map' | 'content',
): void {
  const rounds = kind === 'map' ? fold.projection.mapRounds : fold.projection.contentRounds;
  const round = rounds[roundId];
  if (round === undefined || ['completed', 'settled'].includes(round.state)) {
    corrupt('round_unknown', event, sequence, `roundId=${roundId}`);
  }
  const perRound = fold.observationsByRound[roundId] ?? (fold.observationsByRound[roundId] = {});
  if (perRound[observationId] !== undefined) {
    corrupt('observation_duplicate', event, sequence, `observationId=${observationId}`);
  }
  if (level > 1) {
    const parentLevel = parentObservationId === null ? undefined : perRound[parentObservationId];
    if (parentLevel === undefined || parentLevel !== level - 1) {
      corrupt('observation_parent', event, sequence, `observationId=${observationId} parent=${String(parentObservationId)}`);
    }
  }
  perRound[observationId] = level;
}

function applyRoundCompleted(
  fold: Fold,
  event: AuthoritativeReviewEventV2,
  sequence: number,
  roundId: string,
  kind: 'map' | 'content',
): void {
  const rounds = kind === 'map' ? fold.projection.mapRounds : fold.projection.contentRounds;
  const round = rounds[roundId];
  if (round === undefined) {
    corrupt('round_unknown', event, sequence, `roundId=${roundId}`);
  }
  if (round.state === 'completed' || round.state === 'settled') {
    corrupt('round_duplicate', event, sequence, `roundId=${roundId}`);
  }
  if (kind === 'content') {
    // Every started assignment of the round must be committed AND completed,
    // and the count must match the planned assignmentCount: content round
    // completion is only legal once the ledger freeze closes.
    const entries = Object.values(fold.contentAssignments).filter((entry) => entry.reviewRoundId === roundId);
    for (const entry of entries) {
      if (entry.started && !(entry.committed && entry.completed)) {
        corrupt('round_completed_with_pending_assignments', event, sequence, `roundId=${roundId}`);
      }
    }
    if (entries.filter((entry) => entry.completed).length !== round.assignmentCount) {
      corrupt(
        'round_completed_with_pending_assignments',
        event,
        sequence,
        `roundId=${roundId} frozen=${entries.filter((entry) => entry.completed).length} planned=${round.assignmentCount}`,
      );
    }
  } else {
    // Map rounds: their committed events ARE the ledger freezes; the round
    // closes only when every planned assignment is frozen.
    const frozen = Object.values(fold.mapAssignments).filter((entry) => entry.reviewRoundId === roundId).length;
    if (frozen !== round.assignmentCount) {
      corrupt(
        'round_completed_with_pending_assignments',
        event,
        sequence,
        `roundId=${roundId} frozen=${frozen} planned=${round.assignmentCount}`,
      );
    }
  }
  round.state = 'completed';
}
function applyMapActivated(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_map_activated' }>,
  sequence: number,
): void {
  const p = fold.projection;
  if (p.currentCandidate === null) {
    corrupt('activation_without_candidate', event, sequence, `mapId=${event.mapId}`);
  }
  if (event.supersedesMapId === null) {
    if (p.currentMap !== null || event.mapRevision !== 1) {
      corrupt('activation_revision', event, sequence, `mapId=${event.mapId}`);
    }
  } else if (p.currentMap === null || p.currentMap.mapId !== event.supersedesMapId || event.mapRevision !== p.currentMap.mapRevision + 1) {
    corrupt('activation_revision', event, sequence, `mapId=${event.mapId} supersedes=${event.supersedesMapId}`);
  }
  if (p.currentManifest !== null && !sameRef(p.currentManifest.contentRevisionManifestRef, event.contentRevisionManifestRef)) {
    corrupt('activation_manifest_mismatch', event, sequence, `mapId=${event.mapId}`);
  }
  if (p.currentManifest === null) {
    p.activatedManifestBinding = event.contentRevisionManifestRef;
  }
  p.currentMap = {
    mapId: event.mapId,
    mapRevision: event.mapRevision,
    supersedesMapId: event.supersedesMapId,
    mapSnapshotRef: event.mapSnapshotRef,
    mapReviewBundleRef: event.mapReviewBundleRef,
    mapSemanticDigest: event.mapSemanticDigest,
  };
  p.currentCandidate = null;
}

function applyManifestCommitted(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_content_revision_committed' }>,
  sequence: number,
): void {
  const p = fold.projection;
  if (p.currentManifest === null) {
    if (event.manifestPhase !== 'baseline_unset') {
      corrupt('manifest_phase', event, sequence, `phase=${event.manifestPhase}`);
    }
    if (event.priorManifestRef !== null) {
      corrupt('manifest_prior', event, sequence, `taskContentRevision=${event.taskContentRevision}`);
    }
    if (event.taskContentRevision !== 1) {
      corrupt('manifest_revision', event, sequence, `taskContentRevision=${event.taskContentRevision}`);
    }
    if (p.activatedManifestBinding !== null && !sameRef(p.activatedManifestBinding, event.contentRevisionManifestRef)) {
      corrupt('manifest_activation_mismatch', event, sequence, `ref=${event.contentRevisionManifestRef.digest.slice(0, 12)}`);
    }
    p.activatedManifestBinding = null;
  } else {
    if (!sameRef(p.currentManifest.contentRevisionManifestRef, event.priorManifestRef)) {
      corrupt('manifest_prior', event, sequence, `taskContentRevision=${event.taskContentRevision}`);
    }
    if (event.taskContentRevision !== p.currentManifest.taskContentRevision + 1) {
      corrupt('manifest_revision', event, sequence, `taskContentRevision=${event.taskContentRevision}`);
    }
    if (event.manifestPhase === 'baseline_unset') {
      corrupt('manifest_phase', event, sequence, `phase=${event.manifestPhase}`);
    }
    if (p.currentManifest.manifestPhase === 'finalized' && event.manifestPhase === 'provisional') {
      corrupt('manifest_phase', event, sequence, `phase=${event.manifestPhase}`);
    }
  }
  p.currentManifest = {
    contentRevisionManifestRef: event.contentRevisionManifestRef,
    taskContentRevision: event.taskContentRevision,
    manifestPhase: event.manifestPhase,
  };
}

function applySealed(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_scaffold_sealed_v2' }>,
  sequence: number,
): void {
  const p = fold.projection;
  const wi = demandWorkItem(fold, event, sequence, event.sealWorkItemId);
  if (wi.kind !== 'system_seal') {
    corrupt('seal_workitem_kind', event, sequence, `sealWorkItemId=${event.sealWorkItemId}`);
  }
  if (wi.state !== 'leased' && wi.state !== 'completed') {
    corrupt('seal_workitem_state', event, sequence, `sealWorkItemId=${event.sealWorkItemId} state=${wi.state}`);
  }
  if (p.currentSeal !== null) {
    corrupt('seal_duplicate', event, sequence);
  }
  if (p.currentMap === null || !sameRef(p.currentMap.mapSnapshotRef, event.mapRef)) {
    corrupt('sealed_map_mismatch', event, sequence, `sealWorkItemId=${event.sealWorkItemId}`);
  }
  if (p.currentManifest === null || !sameRef(p.currentManifest.contentRevisionManifestRef, event.contentRevisionManifestRef)) {
    corrupt('sealed_manifest_mismatch', event, sequence, `sealWorkItemId=${event.sealWorkItemId}`);
  }
  p.currentSeal = {
    sealWorkItemId: event.sealWorkItemId,
    sealRecordRef: event.sealRecordRef,
    sealValidationBundleRef: event.sealValidationBundleRef,
    mapRef: event.mapRef,
    contentRevisionManifestRef: event.contentRevisionManifestRef,
    reviewBundleRef: event.reviewBundleRef,
    artifactRef: event.artifactRef,
    sealedAtSequence: sequence,
  };
}

function applyArtifactPublished(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'artifact_published_v2' }>,
  sequence: number,
): void {
  const p = fold.projection;
  const seal = p.currentSeal;
  const priorVersion = p.publishedArtifact?.artifactVersion ?? 0;
  if (seal === null) {
    corrupt('publish_without_seal', event, sequence, `artifactId=${event.artifactId}`);
  }
  if (priorVersion > 0) {
    // §17.2 防止双重发布: a second publication is corrupt at the publish
    // event itself — the delivery-created event must never be the first
    // signal of a double publish.
    corrupt('publish_duplicate', event, sequence, `artifactId=${event.artifactId}`);
  }
  if (event.artifactVersion !== priorVersion + 1) {
    corrupt('publish_version', event, sequence, `version=${event.artifactVersion}`);
  }
  if (seal !== null && event.provenance.producerWorkItemId !== seal.sealWorkItemId) {
    corrupt('producer_work_item', event, sequence, `producer=${event.provenance.producerWorkItemId} seal=${seal.sealWorkItemId}`);
  }
  if (seal !== null && !sameRef(event.provenance.sealRecordRef, seal.sealRecordRef)) {
    corrupt('producer_seal_mismatch', event, sequence, `artifactId=${event.artifactId}`);
  }
  if (seal !== null && !sameRef(event.provenance.artifactRef, seal.artifactRef)) {
    corrupt('producer_artifact_mismatch', event, sequence, `artifactId=${event.artifactId}`);
  }
  p.publishedArtifact = {
    artifactId: event.artifactId,
    artifactVersion: event.artifactVersion,
    deliveryRef: event.deliveryRef,
    files: event.files.map((f) => ({ ...f })),
    mediaType: event.mediaType,
    producerWorkItemId: event.provenance.producerWorkItemId,
    sealRecordRef: event.provenance.sealRecordRef,
    artifactRef: event.provenance.artifactRef,
    custodyRef: event.provenance.custodyRef,
  };
}

function applyDeliveryCreated(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_system_artifact_delivery_created' }>,
  sequence: number,
): void {
  const p = fold.projection;
  const artifact = p.publishedArtifact;
  if (artifact === null || artifact.artifactId !== event.artifactId || !sameRef(artifact.artifactRef, event.artifactRef)) {
    corrupt('delivery_artifact_mismatch', event, sequence, `deliveryId=${event.deliveryId}`);
  }
  if (p.currentSeal === null || !sameRef(p.currentSeal.sealRecordRef, event.sealRecordRef)) {
    corrupt('delivery_seal_mismatch', event, sequence, `deliveryId=${event.deliveryId}`);
  }
  if (artifact !== null && !sameRef(artifact.deliveryRef, event.deliveryRef)) {
    corrupt('delivery_ref_mismatch', event, sequence, `deliveryId=${event.deliveryId}`);
  }
  if (p.delivery !== null) {
    corrupt('delivery_duplicate', event, sequence, `deliveryId=${event.deliveryId}`);
  }
  p.delivery = {
    deliveryId: event.deliveryId,
    deliveryRef: event.deliveryRef,
    artifactId: event.artifactId,
    artifactRef: event.artifactRef,
    sealRecordRef: event.sealRecordRef,
    submitterWorkItemId: event.submitterWorkItemId,
  };
  fold.submitterObligations.push({
    workItemId: event.submitterWorkItemId,
    boundAuthorityBaseRef: event.deliveryRef,
    kind: 'delivery_submitter',
  });
}

/** §13.3.1: one available override per track, single consumption, exact ref. */
function applyOverrideConsumption(
  fold: Fold,
  event: AuthoritativeReviewEventV2,
  sequence: number,
  consumedRef: BlobRefV2,
  track: 'map' | 'content',
): void {
  const p = fold.projection;
  if (p.consumedOverrideRefs.includes(consumedRef.digest)) {
    corrupt('override_second_consumption', event, sequence, `ref=${consumedRef.digest.slice(0, 12)}`);
  }
  const available = p.availableOverride;
  if (available === null || !sameRef(available.ref, consumedRef)) {
    corrupt('override_unknown', event, sequence, `ref=${consumedRef.digest.slice(0, 12)}`);
  }
  if (available.track !== track) {
    corrupt('override_track', event, sequence, `available=${available.track} round=${track}`);
  }
  if (fold.resolver !== undefined) {
    const blob = resolveParsed(fold, event, sequence, 'round_budget_override', consumedRef);
    let blobTrack = '';
    let failedEventId = '';
    try {
      blobTrack = blobString(blob, 'track');
      failedEventId = blobString(blob, 'failedEventId');
    } catch (error) {
      if (error instanceof SchemaError) {
        corrupt('override_blob_malformed', event, sequence, (error as SchemaError).message);
      }
      throw error;
    }
    if (blobTrack !== track) {
      corrupt('override_track', event, sequence, `blob=${blobTrack} round=${track}`);
    }
    // The override must trace to the task's own failed cycle when the failure
    // is still projected (the failed terminal event identity).
    if (p.failed !== null && failedEventId !== '' && failedEventId !== p.failed.eventId) {
      corrupt('override_failed_event_mismatch', event, sequence, `blob=${failedEventId} failed=${p.failed.eventId}`);
    }
  }
  p.availableOverride = null;
  p.consumedOverrideRefs.push(consumedRef.digest);
}

/**
 * §13.3.1: the transfer supersedes the single available ref with lineage checks.
 *
 * TASK 19 FIX (adversarial review I-2, 2026-08-15): the frozen first check
 * compared `p.availableOverride.ref` (a round_budget_override blob ref) against
 * `event.fromRepairPlanRef` (a repair_plan_spec ref) via kind+digest sameRef —
 * it could NEVER hold, so every emitted transfer corrupted `override_unknown`.
 * Amended: the transfer must name an EXISTING available override (the atomic
 * supersede precondition); the ref-level binding of the available ref is
 * enforced below by the frozen blob checks — the event's override blob
 * (event.overrideRef) must descend from the available ref
 * (newBlob.predecessorOverrideRef === available.ref), the available blob's
 * currentAuthorizedRepairPlanRef must equal event.fromRepairPlanRef (the
 * superseded plan), and the new blob's currentAuthorizedRepairPlanRef must
 * equal event.toRepairPlanRef (the successor plan). The event carries the NEW
 * override blob ref (transferOrdinal = old + 1) per the frozen blob checks.
 */
function applyOverrideTransfer(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_round_budget_override_transferred_v2' }>,
  sequence: number,
): void {
  const p = fold.projection;
  const available = p.availableOverride;
  if (available === null) {
    corrupt('override_unknown', event, sequence, `no available override for the transfer`);
  }
  if (p.consumedOverrideRefs.includes(event.overrideRef.digest)) {
    corrupt('override_transfer_after_consumption', event, sequence, `ref=${event.overrideRef.digest.slice(0, 12)}`);
  }
  if (fold.resolver !== undefined) {
    const oldBlob = resolveParsed(fold, event, sequence, 'round_budget_override', available.ref);
    const newBlob = resolveParsed(fold, event, sequence, 'round_budget_override', event.overrideRef);
    try {
      const same =
        blobString(newBlob, 'overrideId') === blobString(oldBlob, 'overrideId') &&
        blobString(newBlob, 'failedEventId') === blobString(oldBlob, 'failedEventId') &&
        blobString(newBlob, 'track') === blobString(oldBlob, 'track') &&
        blobString(newBlob, 'repairLineageId') === blobString(oldBlob, 'repairLineageId') &&
        blobString(newBlob, 'operationId') === blobString(oldBlob, 'operationId') &&
        blobNumber(newBlob, 'transferOrdinal') === blobNumber(oldBlob, 'transferOrdinal') + 1 &&
        sameRef(blobRef(newBlob, 'predecessorOverrideRef'), available.ref) &&
        sameRef(blobRef(oldBlob, 'currentAuthorizedRepairPlanRef'), event.fromRepairPlanRef) &&
        sameRef(blobRef(newBlob, 'currentAuthorizedRepairPlanRef'), event.toRepairPlanRef);
      if (!same) {
        corrupt('override_transfer', event, sequence, `ref=${event.overrideRef.digest.slice(0, 12)}`);
      }
    } catch (error) {
      if (error instanceof SchemaError) {
        corrupt('override_blob_malformed', event, sequence, (error as SchemaError).message);
      }
      throw error;
    }
  }
  p.availableOverride = { ref: event.overrideRef, track: available.track };
}

/** §10.3.1 failureCode <-> recovery-payload branch matrix + terminal identity resolution. */
function applyTaskFailed(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_task_failed_v2' }>,
  sequence: number,
): void {
  const p = fold.projection;
  const wi = demandWorkItem(fold, event, sequence, event.workItemId);
  if (p.failed !== null) {
    corrupt('second_failure', event, sequence, `existing=${p.failed.eventId}`);
  }
  if (wi.state !== 'terminal_failed' || wi.leaseEpoch !== event.leaseEpoch) {
    corrupt('failed_not_terminal', event, sequence, `workItemId=${event.workItemId} state=${wi.state}`);
  }
  demandBaseMatch(fold, event, sequence, wi, event.leaseEpoch, event.authorityBaseRef);
  const terminalId = event.attemptId ?? event.commandId;
  if (terminalId === null || p.attempts[terminalId] === undefined || p.attempts[terminalId].state !== 'terminal_failed') {
    corrupt('failed_identity', event, sequence, `workItemId=${event.workItemId}`);
  }
  const expectedRecoveryKind = RECOVERY_KIND_BY_FAILURE_CODE[event.failureCode];
  if (expectedRecoveryKind === undefined && event.failureRecoveryPayloadRef !== null) {
    corrupt('recovery_unexpected', event, sequence, `failureCode=${event.failureCode}`);
  }
  if (expectedRecoveryKind !== undefined && event.failureRecoveryPayloadRef === null) {
    corrupt('recovery_missing', event, sequence, `failureCode=${event.failureCode}`);
  }
  if (event.failureRecoveryPayloadRef !== null && fold.resolver !== undefined && expectedRecoveryKind !== undefined) {
    const payload = resolveParsed(fold, event, sequence, 'failure_recovery_payload', event.failureRecoveryPayloadRef);
    try {
      const kind = blobString(payload, 'kind');
      if (kind !== expectedRecoveryKind) {
        corrupt('recovery_branch', event, sequence, `failureCode=${event.failureCode} payload.kind=${kind} expected=${expectedRecoveryKind}`);
      }
      const authorityBaseRef = blobRef(payload, 'authorityBaseRef');
      if (!sameRef(authorityBaseRef, event.authorityBaseRef)) {
        corrupt('recovery_base', event, sequence, `workItemId=${event.workItemId}`);
      }
      if (kind === 'retry_system_command') {
        if (
          blobString(payload, 'failedWorkItemId') !== event.workItemId ||
          blobString(payload, 'failedCommandId') !== terminalId ||
          blobNumber(payload, 'failedLeaseEpoch') !== event.leaseEpoch
        ) {
          corrupt('recovery_identity', event, sequence, `workItemId=${event.workItemId}`);
        }
        if (blobString(payload, 'systemKind') !== wi.kind) {
          corrupt('recovery_system_kind', event, sequence, `payload=${blobString(payload, 'systemKind')} workItem=${wi.kind}`);
        }
        verifyTerminalEventId(fold, event, sequence, blobString(payload, 'terminalEventId'), terminalId);
      } else if (kind === 'restart_review_cycle') {
        if (
          blobString(payload, 'failedWorkItemId') !== event.workItemId ||
          blobString(payload, 'failedAttemptOrCommandId') !== terminalId ||
          blobNumber(payload, 'failedLeaseEpoch') !== event.leaseEpoch
        ) {
          corrupt('recovery_identity', event, sequence, `workItemId=${event.workItemId}`);
        }
        const track = blobString(payload, 'track');
        if (track !== 'map' && track !== 'content') {
          corrupt('recovery_track', event, sequence, `track=${track}`);
        }
        if (blobNumber(payload, 'failedCycleOrdinal') < 1) {
          corrupt('recovery_cycle_ordinal', event, sequence);
        }
        const rejectedSubjectRef = blobRef(payload, 'rejectedSubjectRef');
        const legalKinds = track === 'map' ? ['map_candidate', 'map_snapshot'] : ['content_revision_manifest'];
        if (!legalKinds.includes(rejectedSubjectRef.kind)) {
          corrupt('recovery_ref_kind', event, sequence, `rejectedSubjectRef=${rejectedSubjectRef.kind}`);
        }
        verifyTerminalEventId(fold, event, sequence, blobString(payload, 'terminalEventId'), terminalId);
      } else {
        // rebuild_missing_work: forbids failed identity fields by construction.
        const expectedSuccessorKind = blobString(payload, 'expectedSuccessorKind');
        const grantSpecInputRef = payload.grantSpecInputRef as unknown;
        if (grantSpecInputRef !== null && typeof grantSpecInputRef === 'object' && (grantSpecInputRef as { kind?: unknown }).kind !== 'write_grant_spec') {
          corrupt('recovery_ref_kind', event, sequence, `grantSpecInputRef`);
        }
        void expectedSuccessorKind;
      }
    } catch (error) {
      if (error instanceof SchemaError) {
        corrupt('recovery_blob_malformed', event, sequence, (error as SchemaError).message);
      }
      throw error;
    }
  }
  p.failed = {
    workItemId: event.workItemId,
    attemptId: event.attemptId,
    commandId: event.commandId,
    leaseEpoch: event.leaseEpoch,
    failureCode: event.failureCode,
    failureDigest: event.failureDigest,
    failureRecoveryPayloadRef: event.failureRecoveryPayloadRef,
    authorityBaseRef: event.authorityBaseRef,
    atSequence: sequence,
    eventId: event.id,
  };
}

/** The payload's terminalEventId must be the terminal event of the failed attempt/command. */
function verifyTerminalEventId(
  fold: Fold,
  event: AuthoritativeReviewEventV2,
  sequence: number,
  terminalEventId: string,
  terminalAttemptOrCommandId: string,
): void {
  const attempt = fold.projection.attempts[terminalAttemptOrCommandId];
  const wi = attempt === undefined ? undefined : fold.projection.workItems[attempt.workItemId];
  // §10.3.1 resolution: the payload may name EITHER the attempt/command's own
  // terminal event OR the workitem-level terminal event of the same cycle.
  const matches =
    terminalEventId === attempt?.terminalEventId ||
    terminalEventId === attempt?.workItemTerminalEventId ||
    terminalEventId === wi?.terminalEventId;
  if (!matches) {
    corrupt(
      'terminal_event',
      event,
      sequence,
      `payload=${terminalEventId} history=${attempt?.terminalEventId ?? 'none'}/${attempt?.workItemTerminalEventId ?? 'none'}`,
    );
  }
}

/** §10.3.1: reopen only from a projected failure; override availability derives from the event. */
function applyTaskReopened(
  fold: Fold,
  event: Extract<AuthoritativeReviewEventV2, { type: 'structured_task_reopened_v2' }>,
  sequence: number,
): void {
  const p = fold.projection;
  if (p.failed === null) {
    corrupt('reopen_without_failure', event, sequence, `operationId=${event.operationId}`);
  }
  // §10.3.1 row matrix: the recipe must belong to the failed cycle's legal
  // recovery row. Round-limit failures only accept the round-restart recipes;
  // non-round failures never accept them.
  const expectedBranch = RECOVERY_KIND_BY_FAILURE_CODE[p.failed.failureCode];
  const recipeBranch =
    event.recipeKey === 'restart_map_review_cycle' || event.recipeKey === 'restart_content_review_cycle'
      ? 'restart_review_cycle'
      : event.recipeKey;
  if (expectedBranch === undefined || recipeBranch !== expectedBranch) {
    corrupt('reopen_recipe_mismatch', event, sequence, `failureCode=${p.failed.failureCode} recipe=${event.recipeKey}`);
  }
  // Override-ref shape per recipe (defense in depth; the event validator
  // already enforces the exact matrix).
  const roundRecipe = recipeBranch === 'restart_review_cycle';
  if (roundRecipe !== (event.overrideRef !== null)) {
    corrupt('reopen_override_mismatch', event, sequence, `recipe=${event.recipeKey} override=${event.overrideRef !== null}`);
  }
  // Track/reopen-operation binding for the available override.
  if (event.overrideRef !== null) {
    if (p.availableOverride !== null) {
      corrupt('reopen_second_override', event, sequence, `existingTrack=${p.availableOverride.track}`);
    }
    p.availableOverride = { ref: event.overrideRef, track: event.track ?? 'map' };
    // The override must trace to this reopen's failed cycle.
    if (fold.resolver !== undefined) {
      const blob = resolveParsed(fold, event, sequence, 'round_budget_override', event.overrideRef);
      try {
        if (blobString(blob, 'failedEventId') !== p.failed.eventId) {
          corrupt('override_failed_event_mismatch', event, sequence, `blob=${blobString(blob, 'failedEventId')} failed=${p.failed.eventId}`);
        }
        if (blobString(blob, 'operationId') !== event.operationId) {
          corrupt('override_operation_mismatch', event, sequence, `blob=${blobString(blob, 'operationId')}`);
        }
        const track = blobString(blob, 'track');
        if (track !== event.track) {
          corrupt('override_track', event, sequence, `blob=${track} reopened=${event.track ?? 'null'}`);
        }
      } catch (error) {
        if (error instanceof SchemaError) {
          corrupt('override_blob_malformed', event, sequence, (error as SchemaError).message);
        }
        throw error;
      }
    }
  }
  // Replacement expectations per the closed policy table.
  if (event.recipeKey === 'restart_map_review_cycle') {
    fold.reopenObligation = { recipeKey: event.recipeKey, track: 'map', expectedKind: 'agent_assignment', expectedSession: 'map_repair', observedCreates: 0 };
  } else if (event.recipeKey === 'restart_content_review_cycle') {
    fold.reopenObligation = { recipeKey: event.recipeKey, track: 'content', expectedKind: 'agent_assignment', expectedSession: 'content_repair', observedCreates: 0 };
  } else if (event.recipeKey === 'retry_system_command' && fold.resolver !== undefined && p.failed.failureRecoveryPayloadRef !== null) {
    const payload = resolveParsed(fold, event, sequence, 'failure_recovery_payload', p.failed.failureRecoveryPayloadRef);
    try {
      const kind = blobString(payload, 'kind');
      const systemKind = kind === 'retry_system_command' ? blobString(payload, 'systemKind') : '';
      if (kind !== 'retry_system_command') {
        corrupt('reopened_payload_branch', event, sequence, `payload.kind=${kind}`);
      }
      fold.reopenObligation = { recipeKey: event.recipeKey, track: null, expectedKind: systemKind, expectedSession: null, observedCreates: 0 };
    } catch (error) {
      if (error instanceof SchemaError) {
        corrupt('recovery_blob_malformed', event, sequence, (error as SchemaError).message);
      }
      throw error;
    }
  } else {
    fold.reopenObligation = { recipeKey: event.recipeKey, track: event.track, expectedKind: 'unchecked', expectedSession: null, observedCreates: 0 };
  }
  p.failed = null;
}
/* ------------------------------------------------------------------ */
/* Build/generation bookkeeping (per-lineage, deterministic)           */
/* ------------------------------------------------------------------ */

interface BuildBookkeeping extends Record<string, unknown> {
  lastChunkOrdinal: number;
  proposals: number;
}

interface GenerationBookkeeping extends Record<string, unknown> {
  lastBatchOrdinal: number;
}

interface RepairBookkeeping extends Record<string, unknown> {
  lastBatchOrdinal: number;
}

function lineBookkeeping(fold: Fold, key: string, seed: () => Record<string, unknown>): Record<string, unknown> {
  const bucket = (fold as unknown as { bookkeeping: Record<string, Record<string, unknown>> }).bookkeeping;
  if (bucket[key] === undefined) {
    bucket[key] = seed();
  }
  return bucket[key];
}

function lastChunkOrdinalFor(fold: Fold, mapBuildId: string): number {
  const entry = lineBookkeeping(fold, `chunk:${mapBuildId}`, () => ({ lastChunkOrdinal: 0 })) as unknown as BuildBookkeeping;
  return entry.lastChunkOrdinal;
}

function recordChunkOrdinal(fold: Fold, mapBuildId: string, ordinal: number): void {
  const entry = lineBookkeeping(fold, `chunk:${mapBuildId}`, () => ({ lastChunkOrdinal: 0 })) as unknown as BuildBookkeeping;
  entry.lastChunkOrdinal = ordinal;
}

function hasProposalFor(fold: Fold, mapBuildId: string): boolean {
  const entry = lineBookkeeping(fold, `proposal:${mapBuildId}`, () => ({ proposals: 0 })) as unknown as BuildBookkeeping;
  return entry.proposals > 0;
}

function recordProposal(fold: Fold, mapBuildId: string): void {
  const entry = lineBookkeeping(fold, `proposal:${mapBuildId}`, () => ({ proposals: 0 })) as unknown as BuildBookkeeping;
  entry.proposals += 1;
}

function lastGenerationBatchOrdinalFor(fold: Fold, generationPlanId: string): number {
  const entry = lineBookkeeping(fold, `genbatch:${generationPlanId}`, () => ({ lastBatchOrdinal: 0 })) as unknown as GenerationBookkeeping;
  return entry.lastBatchOrdinal;
}

function recordGenerationBatchOrdinal(fold: Fold, generationPlanId: string, ordinal: number): void {
  const entry = lineBookkeeping(fold, `genbatch:${generationPlanId}`, () => ({ lastBatchOrdinal: 0 })) as unknown as GenerationBookkeeping;
  entry.lastBatchOrdinal = ordinal;
}

function lastRepairBatchOrdinalFor(fold: Fold, repairPlanId: string, planRevisionId: string): number {
  const entry = lineBookkeeping(fold, `repairbatch:${repairPlanId}:${planRevisionId}`, () => ({ lastBatchOrdinal: 0 })) as unknown as RepairBookkeeping;
  return entry.lastBatchOrdinal;
}

function recordRepairBatchOrdinal(fold: Fold, repairPlanId: string, planRevisionId: string, ordinal: number): void {
  const entry = lineBookkeeping(fold, `repairbatch:${repairPlanId}:${planRevisionId}`, () => ({ lastBatchOrdinal: 0 })) as unknown as RepairBookkeeping;
  entry.lastBatchOrdinal = ordinal;
}

/* ------------------------------------------------------------------ */
/* End-of-projection obligations + task status                         */
/* ------------------------------------------------------------------ */

const END_OF_PROJECTION_EVENT = { protocolVersion: 2, id: 'end-of-projection', at: '', type: 'projection_end' } as unknown as AuthoritativeReviewEventV2;

function checkEndObligations(fold: Fold, sequence: number): void {
  for (const obligation of fold.answerObligations) {
    if (obligation.kind === 'answer_replacement') {
      corrupt('replacement_missing', END_OF_PROJECTION_EVENT, sequence, `replacementWorkItemId=${obligation.workItemId}`);
    }
  }
  for (const obligation of fold.submitterObligations) {
    if (obligation.kind === 'delivery_submitter' || obligation.kind === 'submitter_workitem') {
      corrupt('submitter_workitem_missing', END_OF_PROJECTION_EVENT, sequence, `submitterWorkItemId=${obligation.workItemId}`);
    }
  }
  if (fold.reopenObligation !== null) {
    corrupt('reopen_replacement_missing', END_OF_PROJECTION_EVENT, sequence, `recipe=${fold.reopenObligation.recipeKey}`);
  }
}

function deriveTaskStatusV2(p: AuthoritativeReviewProjectionV2): AuthoritativeReviewProjectionV2['taskStatus'] {
  if (p.failed !== null) return 'failed';
  if (p.suspension !== null) return p.suspension.reason === 'user_stop' ? 'stopped' : 'interrupted';
  if (p.pendingQuestion !== null) return 'waiting_human';
  if (p.retryBudgetExhaustedWorkItemId !== null) return 'retryable_failure';
  const all = Object.values(p.workItems);
  if (all.length === 0) return 'ready';
  // The final step of the lifecycle is the Submitter completing: the delivery
  // bind a generic submitter workitem and the task completes with it.
  if (p.delivery !== null) {
    const submitter = p.workItems[p.delivery.submitterWorkItemId];
    if (submitter !== undefined && submitter.state === 'completed') {
      return 'completed';
    }
  }
  return 'running';
}

/**
 * Pure genesis replay of a task's v2 event union (spec §9.3). Resolves
 * `BlobRefV2` objects through the injected resolver for the closure rules
 * that need object content (recovery payloads, round-budget overrides);
 * without a resolver those rules degrade to ref-shape/digest comparison and
 * a rule that strictly needs object content fails closed.
 */
/**
 * Pure genesis replay of a task's v2 event union (spec §9.3). Resolves
 * `BlobRefV2` objects through the injected resolver for the closure rules
 * that need object content (recovery payloads, round-budget overrides);
 * without a resolver those rules degrade to ref-shape comparison and a rule
 * that strictly needs object content fails closed.
 *
 * `prior` carries the checkpointed continuation: when provided, the fold
 * resumes from `prior.projection` at `prior.projection.lastSequence` and
 * applies ONLY the passed tail events (spec §9.4 incremental replay). The
 * end-of-projection obligation checks always run on the completed fold.
 *
 * Corruption semantics: ANY invariant violation throws a structured
 * `ProjectionCorruptionError` — the fold never yields a partial projection,
 * and callers (summary derivation, Task 10 coordinator) must translate the
 * error into the task's `corrupt` status rather than inventing a plausible
 * one.
 */
/**
 * Pure genesis replay of a task's v2 event union (spec §9.3). The fold is
 * fully synchronous; the async entry satisfies the injected resolver
 * LAZILY: when the fold first demands a blob, the run is interrupted, the
 * blob is awaited through the resolver, cached, and the deterministic fold
 * restarts from the top (demand sets are tiny — recovery payloads and
 * round-budget overrides — so replays are bounded and cheap). This keeps the
 * fold's OWN check ordering intact: a rule that rejects an event BEFORE it
 * needs a blob (e.g. `override_unknown`) fires with its own diagnostic, never
 * masked by an eager resolution failure.
 *
 * `prior` carries the checkpointed continuation: when provided, the fold
 * resumes from `prior.projection` at `prior.projection.lastSequence` and
 * applies ONLY the passed tail events (spec §9.4 incremental replay). The
 * end-of-projection obligation checks always run on the completed fold.
 *
 * Corruption semantics: ANY invariant violation throws a structured
 * `ProjectionCorruptionError` — the fold never yields a partial projection,
 * and callers (summary derivation, Task 10 coordinator) must translate the
 * error into the task's `corrupt` status rather than inventing a plausible
 * one. Without a resolver the blob-dependent rules degrade to ref-shape
 * comparison; a rule that strictly needs object content fails closed.
 */
export async function projectAuthoritativeReviewState(
  events: readonly AuthoritativeReviewEventV2[],
  resolver?: BlobObjectResolver,
  prior?: ProjectionFoldDataV2,
): Promise<ProjectAuthoritativeReviewStateResult> {
  if (resolver === undefined) {
    return runProjectionFold(events, undefined, prior);
  }
  const cache = new Map<string, unknown>();
  for (;;) {
    try {
      return runProjectionFold(events, (ref: BlobRefV2): unknown => {
        const key = `${ref.kind}:${ref.digest}`;
        if (cache.has(key)) {
          return cache.get(key) as unknown;
        }
        throw new BlobDemandSignal(ref);
      }, prior);
    } catch (error) {
      if (!(error instanceof BlobDemandSignal)) {
        throw error;
      }
      const key = `${error.ref.kind}:${error.ref.digest}`;
      try {
        const value = await resolver(error.ref);
        if (value === undefined || value === null) {
          // Presence semantics: a resolver that resolves a demanded blob to
          // undefined/null is a FAILED resolution — caching it would make the
          // next fold run re-demand the same ref forever (a hang). Fail
          // closed with a corruption diagnostic instead.
          throw new ProjectionCorruptionError({
            reason: 'blob_unresolvable',
            message: `v2 blob ${error.ref.kind}:${error.ref.digest.slice(0, 12)} 不可解析。`,
            sequence: null,
            eventId: null,
            eventType: null,
            detail: `${key} (resolver returned ${String(value)})`,
          });
        }
        cache.set(key, value);
      } catch (resolutionError) {
        if (resolutionError instanceof ProjectionCorruptionError) {
          throw resolutionError;
        }
        throw new ProjectionCorruptionError({
          reason: 'blob_unresolvable',
          message: `v2 blob ${error.ref.kind}:${error.ref.digest.slice(0, 12)} 不可解析。`,
          sequence: null,
          eventId: null,
          eventType: null,
          detail: `${key} (${(resolutionError as Error).message})`,
        });
      }
    }
  }
}

/**
 * SYNCHRONOUS variant of `projectAuthoritativeReviewState` used by the task
 * summary path (which has no async fold surface): identical fold semantics,
 * no resolver. The digest-equality test pins the equivalence between the two
 * entries.
 */
export function projectAuthoritativeReviewStateSync(
  events: readonly AuthoritativeReviewEventV2[],
): ProjectAuthoritativeReviewStateResult {
  return runProjectionFold(events, undefined, undefined);
}

/** The single synchronous fold driver shared by both entries. */
function runProjectionFold(
  events: readonly AuthoritativeReviewEventV2[],
  resolver: BlobObjectResolver | undefined,
  prior: ProjectionFoldDataV2 | undefined,
): ProjectAuthoritativeReviewStateResult {
  const fold = prior === undefined ? createFold(resolver) : resumeFold(prior, resolver);
  (fold as unknown as { bookkeeping: Record<string, Record<string, unknown>> }).bookkeeping = prior?.bookkeeping ?? {};
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if ((event as { protocolVersion?: unknown }).protocolVersion !== 2) {
      continue; // legacy members are legal companions, never folded
    }
    // The fold is synchronous: corruption throws here, never as a rejection.
    applyEvent(fold, event, prior === undefined ? index + 1 : prior.projection.lastSequence + index + 1);
  }
  checkEndObligations(fold, events.length);
  fold.projection.taskStatus = deriveTaskStatusV2(fold.projection);
  return { ok: true, state: fold.projection, fold: foldDataOf(fold) };
}

/** Internal signal: the fold demands a blob the async driver must resolve. */
class BlobDemandSignal extends Error {
  readonly ref: BlobRefV2;

  constructor(ref: BlobRefV2) {
    super(`blob demand ${ref.kind}:${ref.digest}`);
    this.name = 'BlobDemandSignal';
    this.ref = ref;
  }
}

/** Serializes the ephemeral fold bookkeeping for checkpoint continuation. */
function foldDataOf(fold: Fold): ProjectionFoldDataV2 {
  const bookkeeping = (fold as unknown as { bookkeeping: Record<string, Record<string, unknown>> }).bookkeeping ?? {};
  return {
    eventIndex: { ...fold.eventIndex },
    consumedQuestionIds: [...fold.consumedQuestionIds],
    answerObligations: fold.answerObligations.map((o) => ({ ...o })),
    reopenObligation: fold.reopenObligation === null ? null : { ...fold.reopenObligation },
    submitterObligations: fold.submitterObligations.map((o) => ({ ...o })),
    contentAssignments: Object.fromEntries(Object.entries(fold.contentAssignments).map(([k, v]) => [k, { ...v }])),
    mapAssignments: Object.fromEntries(Object.entries(fold.mapAssignments).map(([k, v]) => [k, { ...v }])),
    observationsByRound: Object.fromEntries(
      Object.entries(fold.observationsByRound).map(([k, v]) => [k, { ...v }]),
    ),
    planToLineage: { ...fold.planToLineage },
    bookkeeping: Object.fromEntries(Object.entries(bookkeeping).map(([k, v]) => [k, { ...v }])),
    projection: fold.projection,
  };
}

/** Rebuilds a fold from a checkpointed continuation (deep plain copy). */
function resumeFold(prior: ProjectionFoldDataV2, resolver: BlobObjectResolver | undefined): Fold {
  const fold = createFold(resolver);
  fold.eventIndex = { ...prior.eventIndex };
  fold.consumedQuestionIds = new Set(prior.consumedQuestionIds);
  fold.answerObligations = prior.answerObligations.map((o) => ({ ...o }));
  fold.reopenObligation = prior.reopenObligation === null ? null : { ...prior.reopenObligation };
  fold.submitterObligations = prior.submitterObligations.map((o) => ({ ...o }));
  fold.contentAssignments = Object.fromEntries(Object.entries(prior.contentAssignments).map(([k, v]) => [k, { ...v }]));
  fold.mapAssignments = Object.fromEntries(Object.entries(prior.mapAssignments).map(([k, v]) => [k, { ...v }]));
  fold.observationsByRound = Object.fromEntries(
    Object.entries(prior.observationsByRound).map(([k, v]) => [k, { ...v }]),
  );
  fold.planToLineage = { ...prior.planToLineage };
  fold.projection = structuredClone(prior.projection);
  (fold as unknown as { bookkeeping: Record<string, Record<string, unknown>> }).bookkeeping = Object.fromEntries(
    Object.entries(prior.bookkeeping).map(([k, v]) => [k, { ...v }]),
  );
  return fold;
}
