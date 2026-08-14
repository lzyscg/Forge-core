/**
 * Task 10 WorkItem coordinator (design §17.2/§17.3, spec §9.2/§10.2/§10.3):
 * the operation-keyed atomic mutations of the v2 WorkItem ledger. EVERY
 * method reprojects current state through the Task 9 projection, validates the
 * expected tail/authority, prepares refs under a publication pin, and commits
 * EXACTLY ONE batch through `AuthoritativeAppendFacadeV2` — never a raw
 * EventStore append (the Task 8 dependency boundary rejects that from this
 * tree).
 *
 * Lease epochs follow the projector exactly (Task 9 handoff): first lease of a
 * fresh workitem is `initialLeaseEpoch + 1`; every lease = current + 1;
 * reclaim events carry the OLD epoch (the workitem moves to +1); requeue
 * carries the current epoch WITHOUT advancing; resume/retry-resume carry the
 * NEW epoch; every other transition carries the current epoch; every cycle
 * event carries the lease-time authorityBaseRef of its epoch
 * (`leaseBases[epoch]` demand-matched by the projector).
 *
 * Response-loss idempotency: a committed operationId replays the ORIGINAL
 * result derived from the committed events (same identity fields -> original
 * result; changed fields -> `OPERATION_CONFLICT`); no method ever creates a
 * second logical successor. The facade itself additionally re-verifies same-
 * payload pins byte-identically at commit time.
 *
 * Task 11 handoff (see task-10-report.md): wakeups the coordinator CREATES
 * must be persisted by the task scheduler's durable wakeup index —
 * `LeasedWorkV2.wakeup` (lease expiry), `RetryRecordedResultV2.wakeup`
 * (retry due), plus runnable wakeups after requeue/manualRetry/clearSuspension.
 */
import { createHash } from 'node:crypto';
import { canonicalJson, canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { AuthoritativeAppendFacadeV2, PublishWithPinInput, PublishedV2Result } from '../../storage/authoritative-append-facade';
import type { AuthoritativeReviewCheckpointStore } from '../../storage/authoritative-review-checkpoint-store';
import type { AuthoritativeReviewProjectionV2, AttemptProjectionV2, BlobObjectResolver, ProjectionFoldDataV2, WorkItemProjectionV2 } from '../../storage/authoritative-review-state';
import { ProjectionCorruptionError } from '../../storage/authoritative-review-state';
import { STORAGE_ERROR_CODES, StorageError } from '../../storage/atomic-file';
import { SchemaError } from '../../authoritative-review/authority-types';
import { refOfBlob } from '../../authoritative-review/object-registry';
import type {
  AssignmentDispatchV2,
  AuthorityBaseSetV2,
  GrantInstanceV2,
  PublicationOperationPayloadV2,
  WorkItemParkDispositionV2,
  WriteGrantSpecV2,
} from '../../authoritative-review/authority-types';
import { completionKindRequiresResult } from '../../authoritative-review/authority-types';
import type { BlobRefV2, WorkItemKindV2 } from '../../../shared/authoritative-review-v2';
import {
  StaleAuthorityBaseError,
  assertAuthorityCarriersUniform,
  sameRef as sameExactRef,
  validateParkDisposition,
  validateWorkItemCarry,
} from './authority-base';

/** Exact-or-both-null ref comparison for replay identity checks. */
function sameRefOrNull(a: BlobRefV2 | null, b: BlobRefV2 | null): boolean {
  if (a === null || b === null) return a === b;
  return sameExactRef(a, b);
}

/** §17.2 reclaim reasons both coordinator reclaims and abandons carry. */
export type WorkItemReclaimReasonV2 = 'lease_expired' | 'crash_recovery' | 'user_stop' | 'operator_interrupt';

/** §17.3 suspension overlay reason (status derivation stopped vs interrupted). */
export type WorkItemSuspensionReasonV2 = 'user_stop' | 'operator_interrupt';

export type AttemptExecutionKindV2 = 'structured' | 'generic' | 'command';

export type SystemCommandKindV2 =
  | 'map_finalize'
  | 'generation_finalize'
  | 'repair_finalize'
  | 'migration_validation_batch'
  | 'review_settlement'
  | 'seal';

/** Stable macro error codes of the coordinator (Task 11 stable surface). */
export type CoordinatorErrorCodeV2 =
  | 'TASK_CORRUPT' // projection corruption — the task is corrupt, never fall back
  | 'OPERATION_CONFLICT' // same operationId, different payload/identity
  | 'WORK_ITEM_EXISTS' // a second logical successor name
  | 'WORK_ITEM_NOT_FOUND'
  | 'WORK_ITEM_NOT_READY'
  | 'WORK_ITEM_NOT_LEASED'
  | 'WORK_ITEM_NOT_RETRYABLE'
  | 'WORK_ITEM_NOT_BUDGET_PARKED'
  | 'LEASE_NOT_EXPIRED'
  | 'RETRY_NOT_DUE'
  | 'TASK_SUSPENDED'
  | 'TASK_NOT_SUSPENDED'
  | 'SUSPENSION_CONFLICT'
  | 'TASK_TERMINAL' // failed/completed tasks reject new execution commands
  | 'STALE_TAIL' // the expected tail moved — reproject and retry
  | 'STALE_AUTHORITY_BASE' // a carrier references a different base/profile
  | 'ATTEMPT_MISMATCH' // a late completion/failure names an attempt/command that is NOT the active lease's
  | 'INVALID_INPUT';

export class CoordinatorError extends Error {
  readonly code: CoordinatorErrorCodeV2;

  /** Underlying storage error code when this error is a mapping (audit). */
  readonly causeCode: string | null;

  constructor(code: CoordinatorErrorCodeV2, message: string, causeCode: string | null = null) {
    super(message);
    this.name = 'CoordinatorError';
    this.code = code;
    this.causeCode = causeCode;
  }
}

/** Minimal committed-event view (structural — never imports event-store). */
export interface CoordinatorCommittedEventV2 {
  sequence: number;
  event: { type: string; id: string };
}

export interface CoordinatorDependencies {
  /** The SOLE v2 append path (structural facade surface). */
  facade: Pick<AuthoritativeAppendFacadeV2, 'prepareBlob' | 'publishWithPin' | 'commitStateOnly'>;
  checkpointStore: AuthoritativeReviewCheckpointStore;
  /** Fail-closed blob resolver, TASK-aware (maps every BlobRefV2 to its parsed object). */
  resolver: (taskId: string, ref: BlobRefV2) => Promise<unknown> | unknown;
  /** Fresh on-disk tail (never an instance cache). */
  tail(taskId: string): Promise<{ lastSequence: number; lastCommitId: string | null }>;
  /** Committed events of one operation (response-loss replay), or null. */
  committedOperation(taskId: string, operationId: string): Promise<CoordinatorCommittedEventV2[] | null>;
  clock(): string;
  leaseDurationMs: number;
}

export interface ProjectionReadV2 {
  state: AuthoritativeReviewProjectionV2;
  fold: ProjectionFoldDataV2;
}

/** Deterministic budget-policy digest of a retry-budget park (§10.3). */
export function dispositionDigest(workItemId: string, retryOrdinal: number, failureCode: string): string {
  return canonicalJsonSha256({ workItemId, retryOrdinal, failureCode });
}

/** Deterministic suspension id of one stop operation (replay byte-identity). */
export function deterministicSuspensionId(taskId: string, operationId: string): string {
  return `susp-${createHash('sha256').update(canonicalJson({ taskId, operationId }), 'utf8').digest('hex').slice(0, 32)}`;
}

/** Deterministic execution identity (attempt/command/dispatch/grant) of one operation. */
export function deterministicExecutionId(
  label: 'attempt' | 'command' | 'dispatch' | 'grant',
  operationId: string,
  workItemId: string,
): string {
  const digest = createHash('sha256')
    .update(canonicalJson({ label, operationId, workItemId }), 'utf8')
    .digest('hex');
  return `${label === 'attempt' ? 'att' : label === 'command' ? 'cmd' : label === 'dispatch' ? 'dispatch' : 'grant'}-${digest.slice(0, 24)}`;
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

export interface CreateWorkItemInputV2 {
  taskId: string;
  operationId: string;
  workItemId: string;
  kind: WorkItemKindV2;
  roleBinding?: string | null;
  agentExecutionKind?: 'structured_session' | 'generic_turn' | null;
  sessionKind?: WorkItemProjectionV2['sessionKind'] | null;
  roundId?: string | null;
  logicalAssignmentId?: string | null;
  reviewAssignmentId?: string | null;
  inputArtifactDeliveryId?: string | null;
  /** The payload canonical object published in the SAME pin (payloadRef). */
  payload: { kind: Parameters<AuthoritativeAppendFacadeV2['prepareBlob']>[1]; value: unknown };
  /** The full canonical authority base (built via buildAuthorityBaseSet). */
  authorityBase: AuthorityBaseSetV2;
  /** Write-grant-spec builder (called with the exact prepared base ref). */
  grantSpec?: { build(authorityBaseRef: BlobRefV2): WriteGrantSpecV2 } | null;
  /** Alternative: a caller-published spec ref (must exist on disk by commit). */
  grantSpecRef?: BlobRefV2 | null;
  /** Non-negative frozen automatic retry budget (§10.3). */
  maxAutomaticRetries: number;
  /** Optional initial lease epoch (default 0 — the projector convention). */
  initialLeaseEpoch?: number;
}

export interface CreateWorkItemResultV2 {
  workItemId: string;
  authorityBaseRef: BlobRefV2;
  payloadRef: BlobRefV2;
  grantSpecRef: BlobRefV2 | null;
  events: CoordinatorCommittedEventV2[];
  replayed: boolean;
}

/* ------------------------------------------------------------------ */
/* Lease / reclaim                                                     */
/* ------------------------------------------------------------------ */

export interface LeasedWorkV2 {
  workItemId: string;
  leaseEpoch: number;
  leaseOwner: string;
  leaseExpiresAt: string;
  authorityBaseRef: BlobRefV2;
  attemptId: string | null;
  commandId: string | null;
  dispatchRef: BlobRefV2 | null;
  grantInstanceRef: BlobRefV2 | null;
  /** Durable wakeup Task 11 must persist: lease expiry reclaim. */
  wakeup: { kind: 'lease_expiry'; at: string };
}

export interface ReclaimedWorkV2 {
  workItemId: string;
  previousEpoch: number;
  reclaimedEpoch: number;
  reason: WorkItemReclaimReasonV2;
}

/* ------------------------------------------------------------------ */
/* Retry / budget                                                      */
/* ------------------------------------------------------------------ */

export interface RecordRetryableFailureInputV2 {
  taskId: string;
  operationId: string;
  workItemId: string;
  failureCode: string;
  failureDigest: string;
  /** Explicit null = ordinary non-validator failure; a ref = validator infrastructure. */
  validatorAggregateRef?: BlobRefV2 | null;
  /** Server-computed retryNotBefore override (default clock()). */
  retryNotBefore?: string;
  /**
   * The attempt identity the CALLER holds (Task 12 I-1). Exactly one of
   * `attemptId` | `commandId` must be non-null; the method rejects with
   * `ATTEMPT_MISMATCH` (ZERO writes) when it does not equal the active lease's
   * bound attempt/command — a stale-epoch late failure can never fail the
   * CURRENT re-leased attempt (§10.2).
   */
  attemptId?: string | null;
  commandId?: string | null;
}

export type RetryRecordedResultV2 =
  | {
      mode: 'retryable';
      retryOrdinal: number;
      retryNotBefore: string;
      wakeup: { kind: 'retry_due'; at: string };
    }
  | {
      mode: 'parked';
      retryOrdinal: number;
      parkDisposition: Extract<WorkItemParkDispositionV2, { kind: 'retry_budget_exhausted' }>;
    };

export interface RequeueResultV2 {
  workItemId: string;
  leaseEpoch: number;
}

export interface ManualRetryResultV2 {
  workItemId: string;
  nextEpoch: number;
}

/** Task 12 success-completion input (lease_or_retry `work_item_completed`). */
export interface CompleteWorkItemInputV2 {
  taskId: string;
  operationId: string;
  workItemId: string;
  /**
   * The attempt identity the CALLER holds (from the operation-id-encoded
   * attempt). Exactly one of `attemptId` | `commandId` must be non-null. The
   * method rejects with `ATTEMPT_MISMATCH` (ZERO writes) when it does not
   * equal the active lease's bound attempt/command — a stale-epoch late result
   * can never complete the CURRENT re-leased attempt (§10.2/§17.2).
   */
  attemptId?: string | null;
  commandId?: string | null;
  /**
   * The §9.2 domain result carrier pinned/verified in the SAME batch. For
   * gated kinds (every structured agent session + every system command,
   * `completionKindRequiresResult`) this MUST be non-empty; a bare completion
   * of a gated kind is rejected with `INVALID_INPUT` and ZERO writes. Later
   * domain-completion builders emit the events that reference these refs.
   */
  resultRefs?: readonly BlobRefV2[];
}

/** The committed completion result (attempt/command terminal + workitem done). */
export interface CompletedWorkV2 {
  workItemId: string;
  leaseEpoch: number;
  attemptFamily: AttemptExecutionKindV2;
  attemptId: string | null;
  commandId: string | null;
  events: readonly CoordinatorCommittedEventV2[];
  replayed: boolean;
}

export interface SuspensionResultV2 {
  suspensionId: string;
  /** null only on response-loss replays of clearSuspension (the cleared event carries no reason). */
  reason: WorkItemSuspensionReasonV2 | null;
}

/* ------------------------------------------------------------------ */
/* Coordinator                                                         */
/* ------------------------------------------------------------------ */

/** Claim ordering: plan/phase order (spec §10.2), then round ordinal, then id. */
export const CLAIM_PHASE_ORDER: readonly string[] = [
  'structure_chunk',
  'review_map_batch',
  'review_map_whole',
  'generation_batch',
  'review_content_batch',
  'review_content_whole',
  'map_repair',
  'content_repair',
  'generic_turn',
  'system_map_finalize',
  'system_generation_finalize',
  'system_repair_finalize',
  'system_migration_validation_batch',
  'system_review_settlement',
  'system_seal',
];

/** Structured write sessions (GrantInstance signers, spec §10.2). */
const WRITE_SESSION_KINDS: readonly string[] = ['structure_chunk', 'generation_batch', 'map_repair', 'content_repair'];

/**
 * GrantInstance admission (design §17.2): ONLY structured WRITE sessions with a
 * grant spec sign a lease-bound GrantInstance. Generic submitters (sessionKind
 * null) carry a grant ref on their created event only because the frozen event
 * validator demands one — they NEVER sign structured-slot write grants.
 */
export function shouldSignGrantInstance(sessionKind: string | null, hasGrantSpec: boolean): boolean {
  return hasGrantSpec && sessionKind !== null && WRITE_SESSION_KINDS.includes(sessionKind);
}

/** workitem kind -> system command kind (§17.2 six closed kinds). */
const SYSTEM_COMMAND_KIND_BY_WORK_ITEM: Readonly<Record<string, SystemCommandKindV2>> = {
  system_map_finalize: 'map_finalize',
  system_generation_finalize: 'generation_finalize',
  system_repair_finalize: 'repair_finalize',
  system_migration_validation_batch: 'migration_validation_batch',
  system_review_settlement: 'review_settlement',
  system_seal: 'seal',
};

export class WorkItemCoordinatorV2 {
  private readonly facade: CoordinatorDependencies['facade'];

  private readonly checkpointStore: AuthoritativeReviewCheckpointStore;

  private readonly resolver: (taskId: string, ref: BlobRefV2) => Promise<unknown> | unknown;

  private readonly tail: CoordinatorDependencies['tail'];

  private readonly committedOperation: CoordinatorDependencies['committedOperation'];

  private readonly clock: () => string;

  private readonly leaseDurationMs: number;

  constructor(deps: CoordinatorDependencies) {
    this.facade = deps.facade;
    this.checkpointStore = deps.checkpointStore;
    this.resolver = deps.resolver;
    this.tail = deps.tail;
    this.committedOperation = deps.committedOperation;
    this.clock = deps.clock;
    this.leaseDurationMs = deps.leaseDurationMs;
  }

  /* ---------------- shared plumbing ---------------- */

  /** Task 9 projection through the checkpoint store; corruption propagates. */
  private async readProjection(taskId: string): Promise<ProjectionReadV2> {
    try {
      const read = await this.checkpointStore.readState(taskId, (ref) => this.resolver(taskId, ref));
      return { state: read.projection, fold: read.fold };
    } catch (error) {
      if (error instanceof ProjectionCorruptionError) {
        throw new CoordinatorError('TASK_CORRUPT', `${error.reason}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Public projection reader (Task 12 attempt-coordinator): the SAME Task 9
   * projection, corruption propagated. Never a second implementation.
   */
  async readProjectionState(taskId: string): Promise<AuthoritativeReviewProjectionV2> {
    const { state } = await this.readProjection(taskId);
    return state;
  }

  /**
   * Fresh on-disk tail the pin CAS binds to. The AUTHORITATIVE divergence
   * check happens inside the facade's locked commit (fresh-tail reload +
   * expectedTailSequence equality) — a concurrent commit surfaces as
   * `STALE_TAIL` there. Note the projection's lastSequence counts v2 event
   * POSITIONS and is not compared here: histories may legally interleave
   * legacy events, which the fold skips.
   */
  private async expectedTail(taskId: string, _projection: AuthoritativeReviewProjectionV2): Promise<{ lastSequence: number; lastCommitId: string | null }> {
    return this.tail(taskId);
  }

  /** Map a facade/storage rejection onto the stable coordinator surface. */
  private mapCommitError(error: unknown): never {
    if (error instanceof CoordinatorError) throw error;
    if (error instanceof ProjectionCorruptionError) {
      throw new CoordinatorError('TASK_CORRUPT', `${error.reason}: ${error.message}`);
    }
    if (error instanceof StaleAuthorityBaseError) {
      throw new CoordinatorError('STALE_AUTHORITY_BASE', error.message);
    }
    if (error instanceof SchemaError) {
      throw new CoordinatorError('INVALID_INPUT', error.message);
    }
    if (error instanceof StorageError) {
      switch (error.code) {
        case STORAGE_ERROR_CODES.EXPECTED_SEQUENCE_MISMATCH:
          throw new CoordinatorError('STALE_TAIL', error.message, error.code);
        case STORAGE_ERROR_CODES.PIN_CONFLICT:
        case STORAGE_ERROR_CODES.ARTIFACT_VERSION_CONFLICT:
          throw new CoordinatorError('OPERATION_CONFLICT', error.message, error.code);
        case STORAGE_ERROR_CODES.TASK_CORRUPTED:
          throw new CoordinatorError('TASK_CORRUPT', error.message, error.code);
        case STORAGE_ERROR_CODES.INVALID_INPUT:
        case STORAGE_ERROR_CODES.EVENT_INVALID:
          throw new CoordinatorError('INVALID_INPUT', error.message, error.code);
        default:
          throw new CoordinatorError('STALE_TAIL', error.message, error.code);
      }
    }
    throw error;
  }

  /** One batch through the facade; the response-loss fast path is decided per method. */
  private async commitOne(input: PublishWithPinInput): Promise<PublishedV2Result> {
    try {
      if (input.preparedRefs === undefined || input.preparedRefs.length === 0) {
        return await this.facade.commitStateOnly({ ...input });
      }
      return await this.facade.publishWithPin(input);
    } catch (error) {
      this.mapCommitError(error);
    }
  }

  private requireRunning(state: AuthoritativeReviewProjectionV2): void {
    if (state.failed !== null || state.taskStatus === 'failed') {
      throw new CoordinatorError('TASK_TERMINAL', 'the task is failed; only reopen_failed may recover it');
    }
    if (state.taskStatus === 'completed') {
      throw new CoordinatorError('TASK_TERMINAL', 'the task is completed');
    }
  }

  private demandWorkItem(state: AuthoritativeReviewProjectionV2, workItemId: string): WorkItemProjectionV2 {
    const wi = state.workItems[workItemId];
    if (wi === undefined) {
      throw new CoordinatorError('WORK_ITEM_NOT_FOUND', `no workitem '${workItemId}'`);
    }
    return wi;
  }

  private demandLeased(state: AuthoritativeReviewProjectionV2, workItemId: string): { wi: WorkItemProjectionV2; base: BlobRefV2 } {
    const wi = this.demandWorkItem(state, workItemId);
    if (wi.state !== 'leased') {
      throw new CoordinatorError('WORK_ITEM_NOT_LEASED', `workitem '${workItemId}' is ${wi.state}, not leased`);
    }
    if (state.activeLease === null || state.activeLease.workItemId !== workItemId) {
      throw new CoordinatorError('WORK_ITEM_NOT_LEASED', `workitem '${workItemId}' holds no active lease`);
    }
    const base = wi.leaseBases[String(wi.leaseEpoch)];
    if (base === undefined) {
      throw new CoordinatorError('INVALID_INPUT', `workitem '${workItemId}' has no recorded lease base for epoch ${wi.leaseEpoch}`);
    }
    return { wi, base };
  }

  private demandClaimableReady(state: AuthoritativeReviewProjectionV2, workItemId: string): WorkItemProjectionV2 {
    const wi = this.demandWorkItem(state, workItemId);
    if (wi.state !== 'ready') {
      throw new CoordinatorError('WORK_ITEM_NOT_READY', `workitem '${workItemId}' is ${wi.state}, not ready`);
    }
    if (state.activeLease !== null) {
      throw new CoordinatorError('STALE_TAIL', `a lease is already active on '${state.activeLease.workItemId}'`);
    }
    if (state.suspension !== null) {
      throw new CoordinatorError('TASK_SUSPENDED', 'the task is suspended; clear the overlay before claiming');
    }
    this.requireRunning(state);
    return wi;
  }

  /**
   * Task 12 I-1: the caller's attempt identity MUST equal the active lease's
   * bound attempt/command. A stale-epoch late result (the caller holds attempt
   * A, the lease now binds attempt B) is rejected with `ATTEMPT_MISMATCH` and
   * ZERO writes — it can never complete/fail the CURRENT re-leased attempt
   * (§10.2 "Late completion from an older epoch ... rejected without partial
   * writes", design §17.2). Returns the resolved attempt (undefined for a
   * command carrier).
   */
  private demandActiveAttemptMatch(
    state: AuthoritativeReviewProjectionV2,
    workItemId: string,
    callerAttemptId: string | null | undefined,
    callerCommandId: string | null | undefined,
  ): AttemptProjectionV2 | undefined {
    const active = state.activeLease;
    if (active === null) {
      throw new CoordinatorError('WORK_ITEM_NOT_LEASED', `workitem '${workItemId}' holds no active lease`);
    }
    const boundAttemptId = active.attemptId ?? null;
    const boundCommandId = active.commandId ?? null;
    const attemptId = callerAttemptId ?? null;
    const commandId = callerCommandId ?? null;
    if ((attemptId === null) === (commandId === null)) {
      throw new CoordinatorError('INVALID_INPUT', 'exactly one of attemptId|commandId must name the executing attempt/command');
    }
    if (attemptId !== null) {
      if (attemptId !== boundAttemptId) {
        throw new CoordinatorError(
          'ATTEMPT_MISMATCH',
          `caller attempt '${attemptId}' does not match the active lease attempt '${String(boundAttemptId)}'`,
        );
      }
      const attempt = state.attempts[attemptId];
      if (attempt === undefined || attempt.state !== 'started') {
        throw new CoordinatorError('INVALID_INPUT', `attempt '${attemptId}' is not a started active attempt`);
      }
      return attempt;
    }
    if (commandId !== boundCommandId) {
      throw new CoordinatorError(
        'ATTEMPT_MISMATCH',
        `caller command '${commandId}' does not match the active lease command '${String(boundCommandId)}'`,
      );
    }
    const command = state.attempts[commandId as string];
    if (command === undefined || command.state !== 'started') {
      throw new CoordinatorError('INVALID_INPUT', `command '${commandId}' is not a started active command`);
    }
    return undefined; // command carrier — the attempt map entry is keyed by commandId
  }

  private leaseBaseOf(state: AuthoritativeReviewProjectionV2, wi: WorkItemProjectionV2): BlobRefV2 {
    const base = wi.leaseBases[String(wi.leaseEpoch)];
    if (base === undefined) {
      throw new CoordinatorError('INVALID_INPUT', `no lease-time base recorded for epoch ${wi.leaseEpoch}`);
    }
    return base;
  }

  /* ---------------- createWorkItem ---------------- */

  async createWorkItem(input: CreateWorkItemInputV2): Promise<CreateWorkItemResultV2> {
    const { state } = await this.readProjection(input.taskId);
    const committed = await this.committedOperation(input.taskId, input.operationId);
    if (committed !== null) {
      const result = this.deriveCreateResult(input, committed);
      if (input.workItemId !== result.workItemId) {
        throw new CoordinatorError('OPERATION_CONFLICT', `operation '${input.operationId}' committed a different workitem`);
      }
      // Brief Step 5: the SAME operationId with the same identity but a
      // DIFFERENT payload must conflict — compare the input's canonical refs
      // against the committed event's (pure digest computation, no pins).
      const inputRefs = this.deriveCreateInputRefs(input);
      if (
        !sameExactRef(inputRefs.authorityBaseRef, result.authorityBaseRef) ||
        !sameExactRef(inputRefs.payloadRef, result.payloadRef) ||
        !sameRefOrNull(inputRefs.grantSpecRef, result.grantSpecRef)
      ) {
        throw new CoordinatorError(
          'OPERATION_CONFLICT',
          `operation '${input.operationId}' committed a different payload`,
        );
      }
      return { ...result, replayed: true };
    }
    this.requireRunning(state);
    if (state.workItems[input.workItemId] !== undefined) {
      throw new CoordinatorError('WORK_ITEM_EXISTS', `workitem '${input.workItemId}' already exists`);
    }
    const maxAutomaticRetries = input.maxAutomaticRetries;
    if (!Number.isInteger(maxAutomaticRetries) || maxAutomaticRetries < 0) {
      throw new CoordinatorError('INVALID_INPUT', 'maxAutomaticRetries must be a non-negative integer');
    }
    // Prepare phase (put-before-append): base, payload, optional grant spec —
    // the SPEC is built from the exact prepared base ref.
    let authorityBaseRef: BlobRefV2;
    try {
      authorityBaseRef = await this.facade.prepareBlob(input.taskId, 'authority_base_set', input.authorityBase);
    } catch (error) {
      this.mapCommitError(error);
    }
    let payloadRef: BlobRefV2;
    try {
      payloadRef = await this.facade.prepareBlob(input.taskId, input.payload.kind, input.payload.value);
    } catch (error) {
      this.mapCommitError(error);
    }
    if (input.grantSpec !== null && input.grantSpec !== undefined && input.grantSpecRef !== undefined && input.grantSpecRef !== null) {
      throw new CoordinatorError('INVALID_INPUT', 'grantSpec and grantSpecRef are mutually exclusive');
    }
    let grantSpecRef: BlobRefV2 | null = input.grantSpecRef ?? null;
    if (input.grantSpec !== null && input.grantSpec !== undefined) {
      const spec = input.grantSpec.build(authorityBaseRef as BlobRefV2);
      try {
        grantSpecRef = await this.facade.prepareBlob(input.taskId, 'write_grant_spec', spec);
      } catch (error) {
        this.mapCommitError(error);
      }
    }
    // Kind matrix + carrier uniformity before ANY pin.
    const carryErrors = validateWorkItemCarry({
      kind: input.kind,
      roleBinding: input.roleBinding ?? null,
      agentExecutionKind: input.agentExecutionKind ?? null,
      sessionKind: (input.sessionKind as never) ?? null,
      roundId: input.roundId ?? null,
      logicalAssignmentId: input.logicalAssignmentId ?? null,
      reviewAssignmentId: input.reviewAssignmentId ?? null,
      grantSpecRef,
      inputArtifactDeliveryId: input.inputArtifactDeliveryId ?? null,
    });
    if (carryErrors.length > 0) {
      throw new CoordinatorError('INVALID_INPUT', carryErrors.join('; '));
    }
    // Frozen event contract (Task 7 validator): every agent_assignment created
    // event must carry a grant spec ref; system workitems must not.
    if (input.kind === 'agent_assignment' && grantSpecRef === null) {
      throw new CoordinatorError(
        'INVALID_INPUT',
        'agent_assignment workitems must carry a write grant spec (frozen event contract)',
      );
    }
    if (grantSpecRef !== null) {
      await this.assertGrantUniform(input.taskId, grantSpecRef, authorityBaseRef as BlobRefV2, input.authorityBase);
    }
    const payload: Extract<PublicationOperationPayloadV2, { family: 'lease_or_retry' }> = {
      family: 'lease_or_retry',
      operationId: input.operationId,
      taskId: input.taskId,
      workItemId: input.workItemId,
      leaseEpoch: 0,
      eventBuilder: 'work_item_created',
      authorityBaseRef: authorityBaseRef as BlobRefV2,
      kind: input.kind,
      roleBinding: input.roleBinding ?? null,
      agentExecutionKind: input.agentExecutionKind ?? null,
      sessionKind: (input.sessionKind as never) ?? null,
      roundId: input.roundId ?? null,
      logicalAssignmentId: input.logicalAssignmentId ?? null,
      reviewAssignmentId: input.reviewAssignmentId ?? null,
      grantSpecRef,
      inputArtifactDeliveryId: input.inputArtifactDeliveryId ?? null,
      payloadRef,
      initialLeaseEpoch: input.initialLeaseEpoch ?? 0,
      maxAutomaticRetries,
      leaseOwner: null,
      leaseExpiresAt: null,
      expectedLastSequence: null,
      attemptFamily: null,
      attemptId: null,
      commandId: null,
      agentId: null,
      commandKind: null,
      dispatchRef: null,
      grantInstanceRef: null,
      reason: null,
      failureCode: null,
      failureDigest: null,
      retryOrdinal: null,
      retryNotBefore: null,
      validatorAggregateRef: null,
      budgetPolicyDigest: null,
      failureRecoveryPayloadRef: null,
      taskFailure: null,
      resultRefs: [],
    };
    const tail = await this.expectedTail(input.taskId, state);
    const published = await this.commitOne({
      taskId: input.taskId,
      operationId: input.operationId,
      payload,
      intent: { handlerKind: 'work_item_created', handlerVersion: 1 },
      preparedRefs: [authorityBaseRef as BlobRefV2, payloadRef, ...(grantSpecRef === null ? [] : [grantSpecRef])],
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    return this.deriveCreateResult(input, published.events);
  }

  /**
   * Pure canonical refs of the CURRENT create input (never pins): the same
   * computation the facade's prepareBlob performs. Used by the replay path to
   * prove the retransmitted payload is byte-identical to the committed one.
   */
  private deriveCreateInputRefs(input: CreateWorkItemInputV2): {
    authorityBaseRef: BlobRefV2;
    payloadRef: BlobRefV2;
    grantSpecRef: BlobRefV2 | null;
  } {
    const authorityBaseRef = refOfBlob('authority_base_set', input.authorityBase);
    const payloadRef = refOfBlob(input.payload.kind, input.payload.value);
    let grantSpecRef: BlobRefV2 | null = input.grantSpecRef ?? null;
    if (input.grantSpec !== null && input.grantSpec !== undefined) {
      const spec = input.grantSpec.build(authorityBaseRef);
      grantSpecRef = refOfBlob('write_grant_spec', spec);
    }
    return { authorityBaseRef, payloadRef, grantSpecRef };
  }

  /** Grant-spec carrier uniformity: same base + same profile through the base. */
  private async assertGrantUniform(
    taskId: string,
    grantSpecRef: BlobRefV2,
    authorityBaseRef: BlobRefV2,
    baseSet: AuthorityBaseSetV2,
  ): Promise<void> {
    try {
      const spec = (await this.resolver(taskId, grantSpecRef)) as WriteGrantSpecV2 & { authorityBaseRef: BlobRefV2 };
      if (spec === undefined || spec === null || typeof spec !== 'object') {
        throw new StaleAuthorityBaseError('ref_mismatch', 'WriteGrantSpec', 'unresolvable');
      }
      const planRefs: BlobRefV2[] = [];
      const grant = spec as WriteGrantSpecV2;
      if (grant.kind === 'initial_structure_chunk') planRefs.push(grant.mapBuildSpecRef);
      else if (grant.kind === 'initial_generation_batch') planRefs.push(grant.generationPlanSpecRef);
      else if (grant.kind === 'map_repair_batch' || grant.kind === 'content_repair_batch') planRefs.push(grant.repairPlanSpecRef);
      assertAuthorityCarriersUniform(authorityBaseRef, {
        baseSet,
        dispatchBaseRef: null,
        grantSpecBaseRef: grant.authorityBaseRef,
        grantSpecPlanRefs: planRefs,
      });
    } catch (error) {
      this.mapCommitError(error);
    }
  }

  private deriveCreateResult(
    input: CreateWorkItemInputV2,
    committed: CoordinatorCommittedEventV2[],
  ): CreateWorkItemResultV2 {
    const created = committed.find((entry) => entry.event.type === 'structured_work_item_created');
    if (created === undefined) {
      throw new CoordinatorError('OPERATION_CONFLICT', `operation '${input.operationId}' committed no workitem creation`);
    }
    const event = created.event as Record<string, unknown>;
    return {
      workItemId: String(event.workItemId),
      authorityBaseRef: event.authorityBaseRef as BlobRefV2,
      payloadRef: event.payloadRef as BlobRefV2,
      grantSpecRef: (event.grantSpecRef as BlobRefV2 | null) ?? null,
      events: committed,
      replayed: false,
    };
  }

  /* ---------------- leaseNext ---------------- */

  async leaseNext(taskId: string, workerId: string, operationId: string): Promise<LeasedWorkV2 | null> {
    const { state } = await this.readProjection(taskId);
    const committed = await this.committedOperation(taskId, operationId);
    if (committed !== null) {
      const result = await this.deriveLeaseResult(taskId, committed);
      if (result !== null && result.leaseOwner !== workerId) {
        throw new CoordinatorError('OPERATION_CONFLICT', `operation '${operationId}' leased to '${result.leaseOwner}', not '${workerId}'`);
      }
      return result;
    }
    // Claim predicate (spec §10.2): running, unsuspended, no active lease.
    if (state.activeLease !== null || state.suspension !== null) return null;
    if (state.failed !== null || state.taskStatus === 'failed' || state.taskStatus === 'completed') return null;
    if (state.taskStatus !== 'running') return null;
    const ready = Object.values(state.workItems)
      .filter((wi) => wi.state === 'ready')
      .sort((a, b) => this.claimKey(state, a).localeCompare(this.claimKey(state, b)));
    const wi = ready[0];
    if (wi === undefined) return null;
    await this.expectedTail(taskId, state);
    // Submitter leases bind the CURRENT SystemArtifactDelivery (the projector
    // derives delivery_unknown otherwise); deliveries arrive with the Task 13
    // seal chain — fail closed instead of committing a corrupting start.
    if (wi.kind === 'agent_assignment' && wi.agentExecutionKind === 'generic_turn') {
      if (state.delivery === null || state.delivery.deliveryId !== wi.inputArtifactDeliveryId) {
        throw new CoordinatorError(
          'INVALID_INPUT',
          `submitter '${wi.workItemId}' has no current SystemArtifactDelivery '${String(wi.inputArtifactDeliveryId)}' to submit`,
        );
      }
    }
    const leaseEpoch = wi.leaseEpoch + 1;
    const leaseExpiresAt = new Date(new Date(this.clock()).getTime() + this.leaseDurationMs).toISOString();
    const attemptFamily: AttemptExecutionKindV2 =
      wi.kind === 'agent_assignment'
        ? ((wi.agentExecutionKind === 'generic_turn' ? 'generic' : 'structured') as AttemptExecutionKindV2)
        : 'command';
    const baseRef = wi.authorityBaseRef;

    const preparedRefs: BlobRefV2[] = [baseRef];
    let attemptId: string | null = null;
    let commandId: string | null = null;
    let agentId: string | null = null;
    let dispatchRef: BlobRefV2 | null = null;
    let grantInstanceRef: BlobRefV2 | null = null;
    if (attemptFamily !== 'command') {
      attemptId = deterministicExecutionId('attempt', operationId, wi.workItemId);
      // Write sessions sign a GrantInstance from the immutable GrantSpec.
      // Submitters (generic_turn, sessionKind null) never sign structured-slot
      // write grants (design §17.2: "不伪造 StructuredSessionKindV2 或结构槽写
      // Grant") even though the frozen validator forces a grant ref onto the
      // created event — their lease carries ONLY the dispatch.
      const wantsGrant = shouldSignGrantInstance(wi.sessionKind, wi.grantSpecRef !== null);
      if (wantsGrant) {
        if (wi.grantSpecRef === null) {
          throw new CoordinatorError('INVALID_INPUT', `workitem '${wi.workItemId}' has no grant spec to sign`);
        }
        const instance: GrantInstanceV2 = {
          grantInstanceId: deterministicExecutionId('grant', operationId, wi.workItemId),
          grantSpecRef: wi.grantSpecRef,
          workItemId: wi.workItemId,
          leaseEpoch,
          boundAttemptId: attemptId,
          agentId: workerId,
          instanceDigest: '',
        };
        const { instanceDigest: _d, ...instanceWithout } = instance;
        instance.instanceDigest = canonicalJsonSha256(instanceWithout);
        try {
          grantInstanceRef = await this.facade.prepareBlob(taskId, 'grant_instance', instance);
        } catch (error) {
          this.mapCommitError(error);
        }
        preparedRefs.push(grantInstanceRef);
      }
      // AssignmentDispatch materializes the execution input (spec §10.2).
      const dispatch: AssignmentDispatchV2 = {
        dispatchId: deterministicExecutionId('dispatch', operationId, wi.workItemId),
        workItemId: wi.workItemId,
        logicalAssignmentId: wi.logicalAssignmentId ?? `la-${wi.workItemId}`,
        reviewAssignmentId: wi.reviewAssignmentId,
        attemptId,
        authorityBaseRef: baseRef,
        agentExecutionKind: wi.agentExecutionKind === 'generic_turn' ? 'generic_turn' : 'structured_session',
        sessionKind: wi.sessionKind as AssignmentDispatchV2['sessionKind'],
        grantInstanceRef,
        inputArtifactDeliveryId: wi.inputArtifactDeliveryId,
        dispatchDigest: '',
      };
      const { dispatchDigest: _dd, ...dispatchWithout } = dispatch;
      dispatch.dispatchDigest = canonicalJsonSha256(dispatchWithout);
      try {
        dispatchRef = await this.facade.prepareBlob(taskId, 'assignment_dispatch', dispatch);
      } catch (error) {
        this.mapCommitError(error);
      }
      preparedRefs.push(dispatchRef);
      agentId = workerId;
    } else {
      commandId = deterministicExecutionId('command', operationId, wi.workItemId);
    }
    const payload: Extract<PublicationOperationPayloadV2, { family: 'lease_or_retry' }> = {
      family: 'lease_or_retry',
      operationId,
      taskId,
      workItemId: wi.workItemId,
      leaseEpoch,
      eventBuilder: 'work_item_leased',
      authorityBaseRef: baseRef,
      kind: wi.kind as WorkItemKindV2,
      roleBinding: wi.roleBinding,
      agentExecutionKind: wi.agentExecutionKind,
      sessionKind: wi.sessionKind as never,
      roundId: wi.roundId,
      logicalAssignmentId: wi.logicalAssignmentId,
      reviewAssignmentId: wi.reviewAssignmentId,
      grantSpecRef: wi.grantSpecRef,
      inputArtifactDeliveryId: wi.inputArtifactDeliveryId,
      payloadRef: wi.payloadRef,
      initialLeaseEpoch: 0, // unused by the lease builder; the projection owns the record
      maxAutomaticRetries: wi.maxAutomaticRetries,
      leaseOwner: workerId,
      leaseExpiresAt,
      expectedLastSequence: state.lastSequence,
      attemptFamily,
      attemptId,
      commandId,
      agentId,
      commandKind: attemptFamily === 'command' ? SYSTEM_COMMAND_KIND_BY_WORK_ITEM[wi.kind] ?? null : null,
      dispatchRef,
      grantInstanceRef,
      reason: null,
      failureCode: null,
      failureDigest: null,
      retryOrdinal: null,
      retryNotBefore: null,
      validatorAggregateRef: null,
      budgetPolicyDigest: null,
      failureRecoveryPayloadRef: null,
      taskFailure: null,
      resultRefs: [],
    };
    const tail = await this.expectedTail(taskId, state);
    const published = await this.commitOne({
      taskId,
      operationId,
      payload,
      intent: { handlerKind: 'work_item_leased', handlerVersion: 1 },
      preparedRefs,
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    const leased = await this.deriveLeaseResult(taskId, published.events);
    if (leased === null) {
      this.mapCommitError(new StorageError(STORAGE_ERROR_CODES.EVENT_INVALID, 'lease produced no lease event', null, 'retry'));
    }
    return leased;
  }

  private async deriveLeaseResult(taskId: string, committed: readonly CoordinatorCommittedEventV2[]): Promise<LeasedWorkV2 | null> {
    const leased = committed.find((entry) => entry.event.type === 'structured_work_item_leased');
    if (leased === undefined) return null;
    const event = leased.event as Record<string, unknown>;
    const dispatched = committed.find((entry) => entry.event.type === 'structured_assignment_dispatched');
    const started = committed.find(
      (entry) =>
        entry.event.type === 'structured_agent_attempt_started_v2' ||
        entry.event.type === 'structured_generic_agent_attempt_started' ||
        entry.event.type === 'structured_system_command_started',
    );
    const isCommand = started?.event.type === 'structured_system_command_started';
    const startedEvent = started === undefined ? undefined : (started.event as Record<string, unknown>);
    const dispatchedEvent = dispatched === undefined ? undefined : (dispatched.event as Record<string, unknown>);
    let grantInstanceRef: BlobRefV2 | null = null;
    const dispatchRef = (dispatchedEvent?.dispatchRef as BlobRefV2 | undefined) ?? null;
    if (dispatchRef !== null) {
      try {
        const dispatch = (await this.resolver(taskId, dispatchRef)) as { grantInstanceRef: BlobRefV2 | null } | undefined;
        grantInstanceRef = dispatch?.grantInstanceRef ?? null;
      } catch {
        grantInstanceRef = null; // the pin already verified the blob; best-effort enrichment
      }
    }
    return {
      workItemId: String(event.workItemId),
      leaseEpoch: event.leaseEpoch as number,
      leaseOwner: event.leaseOwner as string,
      leaseExpiresAt: event.leaseExpiresAt as string,
      authorityBaseRef: event.authorityBaseRef as BlobRefV2,
      attemptId: started !== undefined && !isCommand ? (startedEvent?.attemptId as string) : null,
      commandId: isCommand ? (startedEvent?.commandId as string) : null,
      dispatchRef,
      grantInstanceRef,
      wakeup: { kind: 'lease_expiry', at: event.leaseExpiresAt as string },
    };
  }

  private claimKey(state: AuthoritativeReviewProjectionV2, wi: WorkItemProjectionV2): string {
    const phase = wi.kind === 'agent_assignment'
      ? (wi.agentExecutionKind === 'generic_turn' ? 'generic_turn' : wi.sessionKind ?? '')
      : wi.kind;
    const rank = String(CLAIM_PHASE_ORDER.indexOf(phase)).padStart(2, '0');
    const roundOrdinal = wi.roundId === null
      ? 'zz'
      : String(state.mapRounds[wi.roundId]?.ordinal ?? state.contentRounds[wi.roundId]?.ordinal ?? Number.MAX_SAFE_INTEGER).padStart(10, '0');
    return `${rank}:${roundOrdinal}:${wi.workItemId}`;
  }

  /* ---------------- reclaimExpired ---------------- */

  async reclaimExpired(
    taskId: string,
    workItemId: string,
    operationId: string,
    reason: WorkItemReclaimReasonV2,
  ): Promise<ReclaimedWorkV2> {
    const { state } = await this.readProjection(taskId);
    const committed = await this.committedOperation(taskId, operationId);
    if (committed !== null) {
      const result = this.deriveReclaimResult(committed);
      if (result === null || result.workItemId !== workItemId || result.reason !== reason) {
        throw new CoordinatorError('OPERATION_CONFLICT', `operation '${operationId}' committed a different reclaim`);
      }
      return result;
    }
    const { wi } = this.demandLeased(state, workItemId);
    if (reason === 'lease_expired') {
      const now = this.clock();
      if (wi.leaseExpiresAt === null || now <= wi.leaseExpiresAt) {
        throw new CoordinatorError('LEASE_NOT_EXPIRED', `lease of '${workItemId}' expires at ${String(wi.leaseExpiresAt)}`);
      }
    }
    const base = this.leaseBaseOf(state, wi);
    const active = state.activeLease;
    const attemptId = active?.attemptId ?? null;
    const commandId = active?.commandId ?? null;
    const attempt = attemptId === null ? undefined : state.attempts[attemptId];
    const attemptFamily: AttemptExecutionKindV2 = attempt?.family ?? (commandId !== null ? 'command' : 'structured');
    if (attempt !== undefined && attempt.state !== 'started') {
      throw new CoordinatorError('INVALID_INPUT', `attempt '${attemptId}' is ${attempt.state}, not started`);
    }
    // A lease with NO bound attempt/command cannot be reclaimed: the projector
    // demands the abandon before the reclaim (attempt_not_abandoned) — the
    // history is unrecoverable, fail loud instead of building an illegal batch.
    if (attempt === undefined && commandId === null) {
      throw new CoordinatorError(
        'INVALID_INPUT',
        `the lease of '${workItemId}' has no bound attempt/command to abandon; the history is not reclaimable`,
      );
    }
    const payload: Extract<PublicationOperationPayloadV2, { family: 'lease_or_retry' }> = {
      family: 'lease_or_retry',
      operationId,
      taskId,
      workItemId,
      leaseEpoch: wi.leaseEpoch,
      eventBuilder: 'work_item_lease_reclaimed',
      authorityBaseRef: base,
      kind: wi.kind as WorkItemKindV2,
      roleBinding: wi.roleBinding,
      agentExecutionKind: wi.agentExecutionKind,
      sessionKind: wi.sessionKind as never,
      roundId: wi.roundId,
      logicalAssignmentId: attempt?.logicalAssignmentId ?? wi.logicalAssignmentId,
      reviewAssignmentId: attempt?.reviewAssignmentId ?? wi.reviewAssignmentId,
      grantSpecRef: wi.grantSpecRef,
      inputArtifactDeliveryId: attempt?.inputArtifactDeliveryId ?? wi.inputArtifactDeliveryId,
      payloadRef: wi.payloadRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries: wi.maxAutomaticRetries,
      leaseOwner: null,
      leaseExpiresAt: null,
      expectedLastSequence: null,
      attemptFamily,
      attemptId,
      commandId,
      agentId: attempt?.agentId ?? null,
      commandKind: (attempt?.commandKind as SystemCommandKindV2 | null) ?? (commandId === null ? null : SYSTEM_COMMAND_KIND_BY_WORK_ITEM[wi.kind] ?? null),
      dispatchRef: null,
      grantInstanceRef: null,
      reason,
      failureCode: null,
      failureDigest: null,
      retryOrdinal: null,
      retryNotBefore: null,
      validatorAggregateRef: null,
      budgetPolicyDigest: null,
      failureRecoveryPayloadRef: null,
      taskFailure: null,
      resultRefs: [],
    };
    const tail = await this.expectedTail(taskId, state);
    const published = await this.commitOne({
      taskId,
      operationId,
      payload,
      intent: { handlerKind: 'work_item_lease_reclaimed', handlerVersion: 1 },
      preparedRefs: [base],
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    const result = this.deriveReclaimResult(published.events);
    if (result === null) this.mapCommitError(new StorageError(STORAGE_ERROR_CODES.EVENT_INVALID, 'reclaim produced no reclaim event', null, 'retry'));
    return result as ReclaimedWorkV2;
  }

  private deriveReclaimResult(committed: readonly CoordinatorCommittedEventV2[]): ReclaimedWorkV2 | null {
    const reclaimed = committed.find((entry) => entry.event.type === 'structured_work_item_lease_reclaimed');
    if (reclaimed === undefined) return null;
    const event = reclaimed.event as Record<string, unknown>;
    const previousEpoch = event.leaseEpoch as number;
    return {
      workItemId: String(event.workItemId),
      previousEpoch,
      reclaimedEpoch: previousEpoch + 1,
      reason: event.reason as WorkItemReclaimReasonV2,
    };
  }

  /* ---------------- recordRetryableFailure ---------------- */

  async recordRetryableFailure(input: RecordRetryableFailureInputV2): Promise<RetryRecordedResultV2> {
    const callerAttemptId = input.attemptId ?? null;
    const callerCommandId = input.commandId ?? null;
    const { state } = await this.readProjection(input.taskId);
    const committed = await this.committedOperation(input.taskId, input.operationId);
    if (committed !== null) {
      const result = this.deriveRetryResult(committed);
      if (result === null) {
        throw new CoordinatorError('OPERATION_CONFLICT', `operation '${input.operationId}' committed no retryable-failure batch`);
      }
      if (result.workItemId !== input.workItemId || result.failureCode !== input.failureCode || result.failureDigest !== input.failureDigest) {
        throw new CoordinatorError('OPERATION_CONFLICT', `operation '${input.operationId}' committed a different failure`);
      }
      return result.result;
    }
    const { wi, base } = this.demandLeased(state, input.workItemId);
    // I-1: the caller's attempt identity must equal the active lease's bound
    // attempt/command — a stale-epoch late failure can never fail the CURRENT
    // re-leased attempt (zero writes on mismatch).
    const attempt = this.demandActiveAttemptMatch(state, input.workItemId, callerAttemptId, callerCommandId);
    const attemptFamily: AttemptExecutionKindV2 = callerCommandId !== null ? 'command' : (attempt?.family ?? 'structured');
    const retryOrdinal = wi.retryOrdinal + 1;
    const retryNotBefore = input.retryNotBefore ?? this.clock();
    const validatorAggregateRef = input.validatorAggregateRef ?? null;
    const preparedRefs: BlobRefV2[] = [base];
    if (validatorAggregateRef !== null) preparedRefs.push(validatorAggregateRef);
    const parked = retryOrdinal > wi.maxAutomaticRetries;
    const eventBuilder = parked ? 'work_item_parked' : 'work_item_retryable_failed';
    const payload = {
      family: 'lease_or_retry' as const,
      operationId: input.operationId,
      taskId: input.taskId,
      workItemId: input.workItemId,
      leaseEpoch: wi.leaseEpoch,
      eventBuilder,
      authorityBaseRef: base,
      kind: wi.kind as WorkItemKindV2,
      roleBinding: wi.roleBinding,
      agentExecutionKind: wi.agentExecutionKind,
      sessionKind: wi.sessionKind as never,
      roundId: wi.roundId,
      logicalAssignmentId: attempt?.logicalAssignmentId ?? wi.logicalAssignmentId,
      reviewAssignmentId: attempt?.reviewAssignmentId ?? wi.reviewAssignmentId,
      grantSpecRef: wi.grantSpecRef,
      inputArtifactDeliveryId: attempt?.inputArtifactDeliveryId ?? wi.inputArtifactDeliveryId,
      payloadRef: wi.payloadRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries: wi.maxAutomaticRetries,
      leaseOwner: null,
      leaseExpiresAt: null,
      expectedLastSequence: null,
      attemptFamily,
      attemptId: callerAttemptId,
      commandId: callerCommandId,
      agentId: attempt?.agentId ?? null,
      commandKind: callerCommandId !== null
        ? ((state.attempts[callerCommandId]?.commandKind as SystemCommandKindV2 | null) ?? null)
        : (attempt?.commandKind as SystemCommandKindV2 | null),
      dispatchRef: null,
      grantInstanceRef: null,
      reason: null,
      failureCode: input.failureCode,
      failureDigest: input.failureDigest,
      retryOrdinal,
      retryNotBefore: parked ? null : retryNotBefore,
      validatorAggregateRef,
      budgetPolicyDigest: parked ? dispositionDigest(input.workItemId, retryOrdinal, input.failureCode) : null,
      failureRecoveryPayloadRef: null,
      taskFailure: null,
      resultRefs: [],
    } as Extract<PublicationOperationPayloadV2, { family: 'lease_or_retry' }>;
    const tail = await this.expectedTail(input.taskId, state);
    const published = await this.commitOne({
      taskId: input.taskId,
      operationId: input.operationId,
      payload,
      intent: { handlerKind: parked ? 'work_item_parked' : 'work_item_retryable_failed', handlerVersion: 1 },
      preparedRefs,
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    const derived = this.deriveRetryResult(published.events);
    if (derived === null) {
      this.mapCommitError(new StorageError(STORAGE_ERROR_CODES.EVENT_INVALID, 'failure commit produced no retryable/park events', null, 'retry'));
    }
    return (derived as { result: RetryRecordedResultV2 }).result;
  }

  private deriveRetryResult(
    committed: readonly CoordinatorCommittedEventV2[],
  ): { workItemId: string; failureCode: string; failureDigest: string; result: RetryRecordedResultV2 } | null {
    const retryable = committed.find((entry) => entry.event.type === 'structured_work_item_retryable_failed');
    if (retryable !== undefined) {
      const event = retryable.event as Record<string, unknown>;
      return {
        workItemId: String(event.workItemId),
        failureCode: event.failureCode as string,
        failureDigest: event.failureDigest as string,
        result: {
          mode: 'retryable',
          retryOrdinal: event.retryOrdinal as number,
          retryNotBefore: event.retryNotBefore as string,
          wakeup: { kind: 'retry_due', at: event.retryNotBefore as string },
        },
      };
    }
    const parked = committed.find((entry) => entry.event.type === 'structured_work_item_parked');
    if (parked !== undefined) {
      const event = parked.event as Record<string, unknown>;
      const disposition = event.parkDisposition as Extract<WorkItemParkDispositionV2, { kind: 'retry_budget_exhausted' }>;
      const terminal = committed.find(
        (entry) =>
          entry.event.type === 'structured_agent_attempt_terminal_failed_v2' ||
          entry.event.type === 'structured_generic_agent_attempt_terminal_failed' ||
          entry.event.type === 'structured_system_command_terminal_failed',
      );
      const failureCode = String(
        (terminal?.event as Record<string, unknown> | undefined)?.failureCode ?? '',
      );
      const failureDigest = String(
        (terminal?.event as Record<string, unknown> | undefined)?.failureDigest ?? '',
      );
      return {
        workItemId: String(event.workItemId),
        failureCode,
        failureDigest,
        result: {
          mode: 'parked',
          retryOrdinal: disposition.retryOrdinal,
          parkDisposition: disposition,
        },
      };
    }
    return null;
  }

  /* ---------------- completeWorkItem (Task 12 success terminal) ---------------- */

  /**
   * Task 12: the SUCCESS completion envelope (spec §9.2, design §17.2) — the
   * attempt/command `completed` terminal + `structured_work_item_completed`
   * in ONE batch through the registered `work_item_completed` builder. The
   * projector demands the attempt be completed BEFORE the workitem completion
   * event, so the envelope order is fixed. Response-loss replay returns the
   * original commit; a late call from a stale epoch/base is rejected by the
   * demandLeased + base-match path with NO partial write. Domain facts ride
   * the same batch only through domain-completion handlers registered by later
   * tasks (the `human_answer` pattern); this method commits the base terminal
   * pair the Task 12 attempt-coordinator uses.
   */
  async completeWorkItem(input: CompleteWorkItemInputV2): Promise<CompletedWorkV2> {
    const callerAttemptId = input.attemptId ?? null;
    const callerCommandId = input.commandId ?? null;
    const resultRefs = input.resultRefs ?? [];
    const { state } = await this.readProjection(input.taskId);
    const committed = await this.committedOperation(input.taskId, input.operationId);
    if (committed !== null) {
      const result = this.deriveCompletedResult(input, committed, true);
      if (result.workItemId !== input.workItemId) {
        throw new CoordinatorError('OPERATION_CONFLICT', `operation '${input.operationId}' committed a different completion`);
      }
      // The operation id is attempt-bound; a caller that names a DIFFERENT
      // attempt under the same operation id is a conflict, never a replay.
      if (callerAttemptId !== null && result.attemptId !== callerAttemptId) {
        throw new CoordinatorError('ATTEMPT_MISMATCH', `operation '${input.operationId}' completed attempt '${String(result.attemptId)}', not '${callerAttemptId}'`);
      }
      if (callerCommandId !== null && result.commandId !== callerCommandId) {
        throw new CoordinatorError('ATTEMPT_MISMATCH', `operation '${input.operationId}' completed command '${String(result.commandId)}', not '${callerCommandId}'`);
      }
      return result;
    }
    const { wi, base } = this.demandLeased(state, input.workItemId);
    // I-1: the caller's attempt identity must equal the active lease's bound
    // attempt/command — a stale-epoch late result can never complete the
    // CURRENT re-leased attempt (zero writes on mismatch).
    const attempt = this.demandActiveAttemptMatch(state, input.workItemId, callerAttemptId, callerCommandId);
    const attemptFamily: AttemptExecutionKindV2 = callerCommandId !== null ? 'command' : (attempt?.family ?? 'structured');
    // I-2 (§9.2): gated kinds MUST fold a domain result carrier in the same
    // batch — a bare completion of a gated kind is rejected with ZERO writes.
    if (completionKindRequiresResult(wi.kind as WorkItemKindV2, wi.sessionKind as never) && resultRefs.length === 0) {
      throw new CoordinatorError(
        'INVALID_INPUT',
        `workitem '${input.workItemId}' kind '${wi.kind}' requires a domain result carrier in the same batch (§9.2)`,
      );
    }
    const payload: Extract<PublicationOperationPayloadV2, { family: 'lease_or_retry' }> = {
      family: 'lease_or_retry',
      operationId: input.operationId,
      taskId: input.taskId,
      workItemId: input.workItemId,
      leaseEpoch: wi.leaseEpoch,
      eventBuilder: 'work_item_completed',
      authorityBaseRef: base,
      kind: wi.kind as WorkItemKindV2,
      roleBinding: wi.roleBinding,
      agentExecutionKind: wi.agentExecutionKind,
      sessionKind: wi.sessionKind as never,
      roundId: wi.roundId,
      logicalAssignmentId: attempt?.logicalAssignmentId ?? wi.logicalAssignmentId,
      reviewAssignmentId: attempt?.reviewAssignmentId ?? wi.reviewAssignmentId,
      grantSpecRef: wi.grantSpecRef,
      inputArtifactDeliveryId: attempt?.inputArtifactDeliveryId ?? wi.inputArtifactDeliveryId,
      payloadRef: wi.payloadRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries: wi.maxAutomaticRetries,
      leaseOwner: null,
      leaseExpiresAt: null,
      expectedLastSequence: null,
      attemptFamily,
      attemptId: callerAttemptId,
      commandId: callerCommandId,
      agentId: attempt?.agentId ?? wi.leaseOwner,
      commandKind: callerCommandId !== null
        ? ((state.attempts[callerCommandId]?.commandKind as SystemCommandKindV2 | null) ?? null)
        : (attempt?.commandKind as SystemCommandKindV2 | null),
      dispatchRef: null,
      grantInstanceRef: null,
      reason: null,
      failureCode: null,
      failureDigest: null,
      retryOrdinal: null,
      retryNotBefore: null,
      validatorAggregateRef: null,
      budgetPolicyDigest: null,
      failureRecoveryPayloadRef: null,
      taskFailure: null,
      resultRefs: [...resultRefs],
    };
    const tail = await this.expectedTail(input.taskId, state);
    const published = await this.commitOne({
      taskId: input.taskId,
      operationId: input.operationId,
      payload,
      intent: { handlerKind: 'work_item_completed', handlerVersion: 1 },
      preparedRefs: [base, ...resultRefs],
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    const result = this.deriveCompletedResult(input, published.events, false);
    if (result.workItemId !== input.workItemId) {
      this.mapCommitError(new StorageError(STORAGE_ERROR_CODES.EVENT_INVALID, 'completion produced no completion event', null, 'retry'));
    }
    return result;
  }

  private deriveCompletedResult(
    input: CompleteWorkItemInputV2,
    committed: readonly CoordinatorCommittedEventV2[],
    replayed: boolean,
  ): CompletedWorkV2 {
    const completed = committed.find((entry) => entry.event.type === 'structured_work_item_completed');
    if (completed === undefined) {
      throw new CoordinatorError('OPERATION_CONFLICT', `operation '${input.operationId}' committed no workitem completion`);
    }
    const event = completed.event as Record<string, unknown>;
    const terminal = committed.find(
      (entry) =>
        entry.event.type === 'structured_agent_attempt_completed_v2' ||
        entry.event.type === 'structured_generic_agent_attempt_completed' ||
        entry.event.type === 'structured_system_command_completed',
    );
    const terminalEvent = terminal === undefined ? undefined : (terminal.event as Record<string, unknown>);
    const isCommand = terminal?.event.type === 'structured_system_command_completed';
    const isGeneric = terminalEvent !== undefined && terminalEvent.agentId !== undefined;
    return {
      workItemId: String(event.workItemId),
      leaseEpoch: event.leaseEpoch as number,
      attemptFamily: (isCommand ? 'command' : isGeneric ? 'generic' : 'structured') as AttemptExecutionKindV2,
      attemptId: terminal !== undefined && !isCommand ? (terminalEvent?.attemptId as string) : null,
      commandId: isCommand ? (terminalEvent?.commandId as string) : null,
      events: committed,
      replayed,
    };
  }

  /* ---------------- requeueDue ---------------- */

  async requeueDue(taskId: string, workItemId: string, operationId: string): Promise<RequeueResultV2> {
    const { state } = await this.readProjection(taskId);
    const committed = await this.committedOperation(taskId, operationId);
    if (committed !== null) {
      const result = this.deriveRequeueResult(committed);
      if (result === null || result.workItemId !== workItemId) {
        throw new CoordinatorError('OPERATION_CONFLICT', `operation '${operationId}' committed a different requeue`);
      }
      return result;
    }
    const wi = this.demandWorkItem(state, workItemId);
    if (wi.state !== 'retryable_failed') {
      throw new CoordinatorError('WORK_ITEM_NOT_RETRYABLE', `workitem '${workItemId}' is ${wi.state}, not retryable_failed`);
    }
    if (wi.retryNotBefore === null || this.clock() < wi.retryNotBefore) {
      throw new CoordinatorError('RETRY_NOT_DUE', `retry of '${workItemId}' is not due until ${String(wi.retryNotBefore)}`);
    }
    const base = this.leaseBaseOf(state, wi);
    const payload: Extract<PublicationOperationPayloadV2, { family: 'lease_or_retry' }> = {
      family: 'lease_or_retry',
      operationId,
      taskId,
      workItemId,
      leaseEpoch: wi.leaseEpoch,
      eventBuilder: 'work_item_requeued',
      authorityBaseRef: base,
      kind: wi.kind as WorkItemKindV2,
      roleBinding: wi.roleBinding,
      agentExecutionKind: wi.agentExecutionKind,
      sessionKind: wi.sessionKind as never,
      roundId: wi.roundId,
      logicalAssignmentId: wi.logicalAssignmentId,
      reviewAssignmentId: wi.reviewAssignmentId,
      grantSpecRef: wi.grantSpecRef,
      inputArtifactDeliveryId: wi.inputArtifactDeliveryId,
      payloadRef: wi.payloadRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries: wi.maxAutomaticRetries,
      leaseOwner: null,
      leaseExpiresAt: null,
      expectedLastSequence: state.lastSequence,
      attemptFamily: null,
      attemptId: null,
      commandId: null,
      agentId: null,
      commandKind: null,
      dispatchRef: null,
      grantInstanceRef: null,
      reason: null,
      failureCode: null,
      failureDigest: null,
      retryOrdinal: null,
      retryNotBefore: null,
      validatorAggregateRef: null,
      budgetPolicyDigest: null,
      failureRecoveryPayloadRef: null,
      taskFailure: null,
      resultRefs: [],
    };
    const tail = await this.expectedTail(taskId, state);
    const published = await this.commitOne({
      taskId,
      operationId,
      payload,
      intent: { handlerKind: 'work_item_requeued', handlerVersion: 1 },
      preparedRefs: [base],
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    const result = this.deriveRequeueResult(published.events);
    if (result === null) {
      this.mapCommitError(new StorageError(STORAGE_ERROR_CODES.EVENT_INVALID, 'requeue produced no requeue event', null, 'retry'));
    }
    return result as RequeueResultV2;
  }

  private deriveRequeueResult(committed: readonly CoordinatorCommittedEventV2[]): RequeueResultV2 | null {
    const requeued = committed.find((entry) => entry.event.type === 'structured_work_item_requeued');
    if (requeued === undefined) return null;
    const event = requeued.event as Record<string, unknown>;
    return { workItemId: String(event.workItemId), leaseEpoch: event.leaseEpoch as number };
  }

  /* ---------------- manualRetry ---------------- */

  async manualRetry(taskId: string, workItemId: string, operationId: string): Promise<ManualRetryResultV2> {
    const { state } = await this.readProjection(taskId);
    const committed = await this.committedOperation(taskId, operationId);
    if (committed !== null) {
      const result = this.deriveManualRetryResult(committed);
      if (result === null || result.workItemId !== workItemId) {
        throw new CoordinatorError('OPERATION_CONFLICT', `operation '${operationId}' committed a different manual retry`);
      }
      return result;
    }
    const wi = this.demandWorkItem(state, workItemId);
    if (wi.state !== 'parked' || wi.parkDisposition === null || wi.parkDisposition.kind !== 'retry_budget_exhausted') {
      throw new CoordinatorError(
        'WORK_ITEM_NOT_BUDGET_PARKED',
        `workitem '${workItemId}' is not parked with retry_budget_exhausted (state=${wi.state})`,
      );
    }
    if (state.retryBudgetExhaustedWorkItemId !== workItemId) {
      throw new CoordinatorError('WORK_ITEM_NOT_BUDGET_PARKED', `'${workItemId}' is not the budget-exhausted workitem`);
    }
    const base = wi.leaseBases[String(wi.leaseEpoch)];
    if (base === undefined) {
      throw new CoordinatorError('INVALID_INPUT', `no lease-time base recorded for parked epoch ${wi.leaseEpoch}`);
    }
    const payload: Extract<PublicationOperationPayloadV2, { family: 'lifecycle' }> = {
      family: 'lifecycle',
      operationId,
      taskId,
      kind: 'manual_retry',
      suspensionId: null,
      workItemId,
      reason: null,
      leaseEpoch: wi.leaseEpoch + 1,
      expectedLastSequence: state.lastSequence,
      authorityBaseRef: base,
      attemptFamily: null,
      attemptId: null,
      commandId: null,
      agentId: null,
      commandKind: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      sessionKind: null,
      inputArtifactDeliveryId: null,
      workItemKind: null,
      roleBinding: null,
      agentExecutionKind: null,
      roundId: null,
      grantSpecRef: null,
      payloadRef: null,
      initialLeaseEpoch: null,
      maxAutomaticRetries: null,
      mapBuildId: null,
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
    };
    const tail = await this.expectedTail(taskId, state);
    await this.commitOne({
      taskId,
      operationId,
      payload,
      intent: { handlerKind: 'lifecycle/manual_retry', handlerVersion: 1 },
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    return { workItemId, nextEpoch: wi.leaseEpoch + 1 };
  }

  private deriveManualRetryResult(committed: readonly CoordinatorCommittedEventV2[]): ManualRetryResultV2 | null {
    const resumed = committed.find((entry) => entry.event.type === 'structured_task_retry_resumed_v2');
    if (resumed === undefined) return null;
    const event = resumed.event as Record<string, unknown>;
    return { workItemId: String(event.workItemId), nextEpoch: event.leaseEpoch as number };
  }

  /* ---------------- suspension overlay ---------------- */

  async applySuspension(
    taskId: string,
    operationId: string,
    reason: WorkItemSuspensionReasonV2,
  ): Promise<SuspensionResultV2> {
    const { state } = await this.readProjection(taskId);
    const committed = await this.committedOperation(taskId, operationId);
    if (committed !== null) {
      const result = this.deriveSuspensionResult(committed);
      if (result === null || result.reason !== reason) {
        throw new CoordinatorError('OPERATION_CONFLICT', `operation '${operationId}' committed a different suspension`);
      }
      return result;
    }
    this.requireRunning(state);
    if (state.suspension !== null) {
      throw new CoordinatorError('TASK_SUSPENDED', `overlay '${state.suspension.suspensionId}' is already active`);
    }
    const suspensionId = deterministicSuspensionId(taskId, operationId);
    const payload: Extract<PublicationOperationPayloadV2, { family: 'lifecycle' }> = {
      family: 'lifecycle',
      operationId,
      taskId,
      kind: 'stop',
      suspensionId,
      workItemId: null,
      reason,
      leaseEpoch: null,
      expectedLastSequence: null,
      authorityBaseRef: null,
      attemptFamily: null,
      attemptId: null,
      commandId: null,
      agentId: null,
      commandKind: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      sessionKind: null,
      inputArtifactDeliveryId: null,
      workItemKind: null,
      roleBinding: null,
      agentExecutionKind: null,
      roundId: null,
      grantSpecRef: null,
      payloadRef: null,
      initialLeaseEpoch: null,
      maxAutomaticRetries: null,
      mapBuildId: null,
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
    };
    const tail = await this.expectedTail(taskId, state);
    await this.commitOne({
      taskId,
      operationId,
      payload,
      intent: { handlerKind: 'lifecycle/stop', handlerVersion: 1 },
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    return { suspensionId, reason };
  }

  async clearSuspension(
    taskId: string,
    operationId: string,
    suspensionId?: string | null,
  ): Promise<SuspensionResultV2> {
    const { state } = await this.readProjection(taskId);
    const committed = await this.committedOperation(taskId, operationId);
    if (committed !== null) {
      const result = this.deriveSuspensionResult(committed);
      if (result === null) {
        throw new CoordinatorError('OPERATION_CONFLICT', `operation '${operationId}' committed a different suspension`);
      }
      if (suspensionId !== undefined && suspensionId !== null && result.suspensionId !== suspensionId) {
        throw new CoordinatorError('OPERATION_CONFLICT', `operation '${operationId}' cleared a different overlay`);
      }
      return result;
    }
    if (state.suspension === null) {
      throw new CoordinatorError('TASK_NOT_SUSPENDED', 'no active suspension overlay');
    }
    const target = suspensionId ?? state.suspension.suspensionId;
    if (target !== state.suspension.suspensionId) {
      throw new CoordinatorError('SUSPENSION_CONFLICT', `active overlay is '${state.suspension.suspensionId}', not '${target}'`);
    }
    const payload: Extract<PublicationOperationPayloadV2, { family: 'lifecycle' }> = {
      family: 'lifecycle',
      operationId,
      taskId,
      kind: 'resume',
      suspensionId: target,
      workItemId: null,
      reason: null,
      leaseEpoch: null,
      expectedLastSequence: null,
      authorityBaseRef: null,
      attemptFamily: null,
      attemptId: null,
      commandId: null,
      agentId: null,
      commandKind: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      sessionKind: null,
      inputArtifactDeliveryId: null,
      workItemKind: null,
      roleBinding: null,
      agentExecutionKind: null,
      roundId: null,
      grantSpecRef: null,
      payloadRef: null,
      initialLeaseEpoch: null,
      maxAutomaticRetries: null,
      mapBuildId: null,
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
    };
    const tail = await this.expectedTail(taskId, state);
    await this.commitOne({
      taskId,
      operationId,
      payload,
      intent: { handlerKind: 'lifecycle/resume', handlerVersion: 1 },
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    return { suspensionId: target, reason: state.suspension.reason };
  }

  private deriveSuspensionResult(committed: readonly CoordinatorCommittedEventV2[]): SuspensionResultV2 | null {
    const applied = committed.find((entry) => entry.event.type === 'structured_task_suspension_applied_v2');
    if (applied !== undefined) {
      const event = applied.event as Record<string, unknown>;
      return { suspensionId: event.suspensionId as string, reason: event.reason as WorkItemSuspensionReasonV2 };
    }
    const cleared = committed.find((entry) => entry.event.type === 'structured_task_suspension_cleared_v2');
    if (cleared !== undefined) {
      const event = cleared.event as Record<string, unknown>;
      return { suspensionId: event.suspensionId as string, reason: null };
    }
    return null;
  }
}
