/**
 * Task 11 v2 task lifecycle dispatch (spec §10.3/§10.3.1/§10.6, §17.2/§17.3):
 * start/resume/stop/retry/reopen/answer over the Task 10 coordinator
 * primitives plus the human-question token machinery. Every mutation is
 * operation-keyed and commits EXACTLY ONE batch through the facade; response
 * loss replays the committed result, a changed payload conflicts.
 *
 * Composition notes (Task 12 handoff): the attempt-coordinator materializes
 * the leased Agent/System attempt and the completion envelopes; this module
 * ONLY creates workitems, leases through the coordinator, and composes the
 * lifecycle envelopes (start/stop/question-open/question-answer/reopen).
 */
import { createHash } from 'node:crypto';
import { REOPEN_PLACEHOLDER_LITERALS } from '../../authoritative-review/object-schemas';
import { canonicalJson, canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { AuthoritativeAppendFacadeV2, PublishedV2Result } from '../../storage/authoritative-append-facade';
import type { AuthoritativeReviewCheckpointStore } from '../../storage/authoritative-review-checkpoint-store';
import type { AuthoritativeReviewProjectionV2, ProjectionFoldDataV2 } from '../../storage/authoritative-review-state';
import { ProjectionCorruptionError } from '../../storage/authoritative-review-state';
import { STORAGE_ERROR_CODES, StorageError } from '../../storage/atomic-file';
import { SchemaError } from '../../authoritative-review/authority-types';
import type {
  PublicationOperationPayloadV2,
  WriteGrantSpecV2,
} from '../../authoritative-review/authority-types';
import type { BlobRefV2, FailedTaskRecoverySummaryV2, RoundBudgetOverrideV2, WorkItemKindV2 } from '../../../shared/authoritative-review-v2';
import { isQuestionVersionToken } from '../../../shared/authoritative-review-v2';
import { parseBatchFileName } from '../../storage/core-paths';
import type { CorePaths } from '../../storage/core-paths';
import {
  CoordinatorError,
  WorkItemCoordinatorV2,
  deterministicExecutionId,
  deterministicSuspensionId,
  type CoordinatorCommittedEventV2,
  type LeasedWorkV2,
  type RetryRecordedResultV2,
} from './work-item-coordinator';
import { buildAuthorityBaseSet } from './authority-base';
import type { AuthoritativeWakeupIndexV1, WakeupRowV2 } from './wakeup-index';
import type { AuthoritativeTaskDeletionV2 } from '../../storage/authoritative-task-deletion';
import type { AuthoritativeReviewExecutionEligibilityV1, WorkItemKindV2 as _W } from '../../../shared/authoritative-review-v2';

/** Stable public lifecycle error codes (spec §14.3). */
export type TaskLifecycleErrorCodeV2 =
  | 'USE_RESUME' // v2 start on stopped/interrupted
  | 'AUTHORITATIVE_REVIEW_UNAVAILABLE' // execution eligibility blocked
  | 'HUMAN_QUESTION_STALE' // consumed/replaced/recomputed-mismatch token
  | 'AUTHORITY_BASE_STALE' // stale tail on reopen (spec §10.3.1)
  | 'OPERATION_CONFLICT'
  | 'INVALID_TRANSITION'
  | 'TASK_TERMINAL'
  | 'TASK_DELETED'
  | 'TASK_CORRUPT';

export class TaskLifecycleError extends Error {
  readonly code: TaskLifecycleErrorCodeV2;

  /** Public envelope members (iron rule 6: every error leaves as a PublicCoreError shape). */
  readonly location: string | null = null;

  readonly action: string | null = null;

  constructor(code: TaskLifecycleErrorCodeV2, message: string) {
    super(message);
    this.name = 'TaskLifecycleError';
    this.code = code;
  }
}

/** The §10.3.1 failure-code → recovery-branch table (mirrors the projector). */
export const RECOVERY_KIND_BY_FAILURE_CODE: Record<string, 'restart_review_cycle' | 'retry_system_command' | 'rebuild_missing_work'> = {
  REVIEW_REPAIR_LIMIT_EXCEEDED: 'restart_review_cycle',
  ARTIFACT_VALIDATION_FAILED: 'retry_system_command',
  RUNNING_WITHOUT_WORK: 'rebuild_missing_work',
};

export interface FrozenTaskProfileV2 {
  profileSnapshotRef: BlobRefV2;
  templateSnapshotRef: BlobRefV2;
  /** The frozen body-field profileDigest alias (spec §4.3). */
  profileDigest: string;
  /** The frozen template snapshot version hash. */
  snapshotHash: string;
}

export interface TaskLifecycleDependencies {
  facade: AuthoritativeAppendFacadeV2;
  checkpointStore: AuthoritativeReviewCheckpointStore;
  resolver: (taskId: string, ref: BlobRefV2) => Promise<unknown> | unknown;
  tail(taskId: string): Promise<{ lastSequence: number; lastCommitId: string | null }>;
  committedOperation(taskId: string, operationId: string): Promise<CoordinatorCommittedEventV2[] | null>;
  events(taskId: string): Promise<Array<{ sequence: number; fileName: string; event: { id: string; type: string } }>>;
  clock(): string;
  leaseDurationMs: number;
  coordinator: WorkItemCoordinatorV2;
  wakeups: AuthoritativeWakeupIndexV1;
  deletion: AuthoritativeTaskDeletionV2;
  /** Separately derived execution eligibility (spec §4.3), injected. */
  eligibility(frozenProfileDigest: string): AuthoritativeReviewExecutionEligibilityV1;
  /** The task-frozen profile binding (constraint B: archived task-frozen profile). */
  frozenProfile(taskId: string): Promise<FrozenTaskProfileV2>;
  /**
   * The frozen orchestrator role binding of the template (start). Receives
   * the task id so the wiring resolves the per-task FROZEN binding, never a
   * current-catalog default. A 0-arity closure is still accepted (tests).
   */
  orchestratorRoleBinding(taskId: string): string | Promise<string>;
  /** The frozen repair role binding for round-limit reopen workitems. */
  repairRoleBinding(taskId: string, session: 'map_repair' | 'content_repair'): string | Promise<string>;
  /** Frozen automatic retry budget of the template (first workitem). */
  defaultAutomaticRetries(taskId: string): number | Promise<number>;
}

export interface StartedTaskResultV2 {
  taskId: string;
  workItemId: string;
  authorityBaseRef: BlobRefV2;
  payloadRef: BlobRefV2;
  grantSpecRef: BlobRefV2;
  replayed: boolean;
}

export interface StopResultV2 {
  suspensionId: string;
  reason: 'user_stop' | 'operator_interrupt';
}

export interface ManualRetryResultV2 {
  workItemId: string;
}

export interface OpenedQuestionResultV2 {
  questionId: string;
  questionVersion: string;
}

export interface AnswerResultV2 {
  deliveryId: string;
  replacementWorkItemId: string;
  replayed: boolean;
}

export interface ReopenResultV2 {
  replacementWorkItemId: string;
  overrideRef: BlobRefV2 | null;
  replayed: boolean;
}

export interface ReopenRequestV2 {
  expectedLastSequence: number;
  operationId: string;
  reason: string;
  recipeKey: 'retry_system_command' | 'restart_map_review_cycle' | 'restart_content_review_cycle' | 'rebuild_missing_work';
  track: 'map' | 'content' | null;
}

/** Deterministic workitem id of one lifecycle successor. */
export function lifecycleWorkItemId(taskId: string, operationId: string, label: string): string {
  const digest = createHash('sha256')
    .update(canonicalJson({ taskId, operationId, label }), 'utf8')
    .digest('hex');
  return `wi-${digest.slice(0, 24)}`;
}

/**
 * The opaque case-sensitive questionVersion token (spec §10.6): unpadded
 * base64url of SHA-256 over the canonical bound fields — question identity,
 * original WorkItem/assignment, attempt/epoch, digest, authority base and the
 * OPENED COMMIT (the batch whose commitId is the opening operationId). It is
 * neither a counter nor an event sequence and cannot be derived from the
 * current tail.
 */
export function questionVersionToken(fields: {
  questionId: string;
  originalWorkItemId: string;
  logicalAssignmentId: string;
  attemptId: string;
  leaseEpoch: number;
  questionDigest: string;
  authorityBaseRef: BlobRefV2;
  openedCommitId: string;
}): string {
  const canonicalBytes = canonicalJson({
    protocolVersion: 2,
    questionId: fields.questionId,
    originalWorkItemId: fields.originalWorkItemId,
    logicalAssignmentId: fields.logicalAssignmentId,
    attemptId: fields.attemptId,
    leaseEpoch: fields.leaseEpoch,
    questionDigest: fields.questionDigest,
    authorityBaseRef: fields.authorityBaseRef,
    openedCommitId: fields.openedCommitId,
  });
  return createHash('sha256').update(canonicalBytes, 'utf8').digest('base64url');
}

function answerDigestOf(answerText: string, questionId: string): string {
  return canonicalJsonSha256({ kind: 'human_answer', questionId, text: answerText });
}

/**
 * Review B-F3: the track-exact recovery summary. `failedRecoverySummary` is a
 * pure function of the projection and — without the payload blob — cannot see
 * which track the round-limit failure was RECORDED on, so it advertises both
 * round-limit recipes (a degraded, documented path: any reopen attempt still
 * validates the track server-side). CoreService calls the resolved variant
 * below, which filters to the recorded track; the UI then never offers an
 * impossible recipe.
 */
export async function failedRecoverySummaryResolved(
  state: AuthoritativeReviewProjectionV2,
  resolve: (ref: BlobRefV2) => Promise<unknown> | unknown,
): Promise<FailedTaskRecoverySummaryV2 | null> {
  const summary = failedRecoverySummary(state);
  if (summary === null || !summary.reopenAllowed) return summary;
  const hasRoundRecipes = summary.legalRecipes.some(
    (recipe) => recipe.recipeKey.startsWith('restart_'),
  );
  if (!hasRoundRecipes) return summary;
  const failed = state.failed;
  if (failed === null || failed.failureRecoveryPayloadRef === null) return summary;
  let payload: unknown;
  try {
    payload = await resolve(failed.failureRecoveryPayloadRef);
  } catch {
    // Unresolvable payload: the reopen path fails closed anyway; keep the
    // listing alive with the unfiltered (server-validated) recipe list.
    return summary;
  }
  if (payload === null || typeof payload !== 'object') return summary;
  const track = (payload as Record<string, unknown>).track;
  if (track !== 'map' && track !== 'content') return summary;
  return {
    ...summary,
    legalRecipes: summary.legalRecipes.filter((recipe) => recipe.track === track),
  };
}

export function failedRecoverySummary(state: AuthoritativeReviewProjectionV2): FailedTaskRecoverySummaryV2 | null {
  const failed = state.failed;
  if (failed === null) return null;
  const branch = RECOVERY_KIND_BY_FAILURE_CODE[failed.failureCode];
  let legalRecipes: FailedTaskRecoverySummaryV2['legalRecipes'] = [];
  const reopenAllowed = failed.failureRecoveryPayloadRef !== null && branch !== undefined;
  if (reopenAllowed) {
    if (branch === 'retry_system_command') {
      legalRecipes = [{ recipeKey: 'retry_system_command', track: null }];
    } else if (branch === 'rebuild_missing_work') {
      legalRecipes = [{ recipeKey: 'rebuild_missing_work', track: null }];
    } else {
      legalRecipes = [
        { recipeKey: 'restart_map_review_cycle', track: 'map' },
        { recipeKey: 'restart_content_review_cycle', track: 'content' },
      ];
    }
  }
  return {
    failureCode: failed.failureCode,
    failedSequence: failed.atSequence,
    legalRecipes,
    reopenAllowed,
    cloneFallback: !reopenAllowed,
  };
}

class MappedLifecycleError extends Error {
  readonly code: TaskLifecycleErrorCodeV2;

  constructor(code: TaskLifecycleErrorCodeV2, message: string) {
    super(message);
    this.name = 'MappedLifecycleError';
    this.code = code;
  }
}

/**
 * The v2 lifecycle dispatcher. Every public method:
 *  1. deletion gate (TASK_DELETED);
 *  2. committed-operation replay (same op → original result; different
 *     payload → OPERATION_CONFLICT);
 *  3. reproject through the checkpoint store (TASK_CORRUPT never falls back);
 *  4. validate against the frozen policy/eligibility;
 *  5. prepare refs with a pin and commit EXACTLY ONE batch through the facade;
 *  6. upsert/absorb the durable wakeup rows.
 */
export class TaskLifecycleServiceV2 {
  private readonly facade: AuthoritativeAppendFacadeV2;

  private readonly checkpointStore: AuthoritativeReviewCheckpointStore;

  private readonly resolver: (taskId: string, ref: BlobRefV2) => Promise<unknown> | unknown;

  private readonly tail: TaskLifecycleDependencies['tail'];

  private readonly committedOperation: TaskLifecycleDependencies['committedOperation'];

  private readonly events: TaskLifecycleDependencies['events'];

  private readonly clock: () => string;

  private readonly leaseDurationMs: number;

  private readonly coordinator: WorkItemCoordinatorV2;

  private readonly wakeups: AuthoritativeWakeupIndexV1;

  private readonly deletion: AuthoritativeTaskDeletionV2;

  private readonly eligibility: (frozenProfileDigest: string) => AuthoritativeReviewExecutionEligibilityV1;

  private readonly frozenProfile: (taskId: string) => Promise<FrozenTaskProfileV2>;

  private readonly orchestratorRoleBinding: (taskId: string) => string | Promise<string>;

  private readonly repairRoleBinding: (taskId: string, session: 'map_repair' | 'content_repair') => string | Promise<string>;

  private readonly defaultAutomaticRetries: (taskId: string) => number | Promise<number>;

  constructor(deps: TaskLifecycleDependencies) {
    this.facade = deps.facade;
    this.checkpointStore = deps.checkpointStore;
    this.resolver = deps.resolver;
    this.tail = deps.tail;
    this.committedOperation = deps.committedOperation;
    this.events = deps.events;
    this.clock = deps.clock;
    this.leaseDurationMs = deps.leaseDurationMs;
    this.coordinator = deps.coordinator;
    this.wakeups = deps.wakeups;
    this.deletion = deps.deletion;
    this.eligibility = deps.eligibility;
    this.frozenProfile = deps.frozenProfile;
    this.orchestratorRoleBinding = deps.orchestratorRoleBinding;
    this.repairRoleBinding = deps.repairRoleBinding;
    this.defaultAutomaticRetries = deps.defaultAutomaticRetries;
  }

  /* ---------------- shared plumbing ---------------- */

  private async readProjection(taskId: string): Promise<AuthoritativeReviewProjectionV2> {
    try {
      return (await this.checkpointStore.readState(taskId, (ref) => this.resolver(taskId, ref))).projection;
    } catch (error) {
      if (error instanceof ProjectionCorruptionError) {
        throw new TaskLifecycleError('TASK_CORRUPT', `${error.reason}: ${error.message}`);
      }
      throw error;
    }
  }

  private mapError(error: unknown): never {
    if (error instanceof TaskLifecycleError) throw error;
    if (error instanceof MappedLifecycleError) {
      throw new TaskLifecycleError(error.code, error.message);
    }
    if (error instanceof Error && error.name === 'TaskDeleteError') {
      throw new TaskLifecycleError('TASK_DELETED', error.message);
    }
    if (error instanceof CoordinatorError) {
      switch (error.code) {
        case 'TASK_TERMINAL':
          throw new TaskLifecycleError('TASK_TERMINAL', error.message);
        case 'STALE_AUTHORITY_BASE':
          throw new TaskLifecycleError('AUTHORITY_BASE_STALE', error.message);
        case 'OPERATION_CONFLICT':
        case 'SUSPENSION_CONFLICT':
        case 'WORK_ITEM_EXISTS':
          throw new TaskLifecycleError('OPERATION_CONFLICT', error.message);
        case 'TASK_CORRUPT':
          throw new TaskLifecycleError('TASK_CORRUPT', error.message);
        default:
          throw new TaskLifecycleError('INVALID_TRANSITION', error.message);
      }
    }
    if (error instanceof StorageError || error instanceof SchemaError) {
      throw new TaskLifecycleError('INVALID_TRANSITION', (error as Error).message);
    }
    throw error;
  }

  private async requireEligible(taskId: string): Promise<void> {
    const profile = await this.frozenProfile(taskId);
    const eligibility = this.eligibility(profile.profileDigest);
    if (eligibility.state !== 'eligible') {
      throw new TaskLifecycleError(
        'AUTHORITATIVE_REVIEW_UNAVAILABLE',
        `执行资格不可用 (${eligibility.state === 'blocked' ? eligibility.reason : 'unknown'})，无法执行 v2 生命周期操作。`,
      );
    }
  }

  private async assertNotDeleted(taskId: string): Promise<void> {
    await this.deletion.assertNotDeleted(taskId);
  }

  private commitOne(input: Parameters<AuthoritativeAppendFacadeV2['publishWithPin']>[0]): Promise<PublishedV2Result> {
    return this.facade.publishWithPin(input).catch((error) => this.mapError(error));
  }

  private async mapped<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.mapError(error);
    }
  }

  /* ---------------- start ---------------- */

  /**
   * The one-shot v2 start (design §17.2): `task_started` + MapBuild +
   * first structure-chunk WorkItem + AuthorityBase + initial_structure_chunk
   * WriteGrantSpec in ONE atomic batch — NO seeded legacy agent_input. A
   * stopped/interrupted task returns the stable USE_RESUME conflict; a started
   * task rejects. Response loss replays the same batch.
   */
  async startV2(
    taskId: string,
    input: { operationId: string; userInputText: string },
  ): Promise<StartedTaskResultV2> {
    await this.assertNotDeleted(taskId);
    const committed = await this.committedOperation(taskId, input.operationId);
    if (committed !== null) {
      const derived = this.deriveStartResult(taskId, input, committed);
      if (derived !== null) return derived;
      throw new TaskLifecycleError('OPERATION_CONFLICT', `操作 ${input.operationId} 已提交不同的启动批次。`);
    }
    await this.requireEligible(taskId);
    const state = await this.readProjection(taskId);
    if (state.suspension !== null) {
      throw new TaskLifecycleError('USE_RESUME', '任务已停止/中断，请使用继续操作。');
    }
    if (state.failed !== null || state.taskStatus === 'failed') {
      throw new TaskLifecycleError('TASK_TERMINAL', '任务已失败，只有 reopen_failed 可以恢复。');
    }
    if (state.taskStatus === 'completed') {
      throw new TaskLifecycleError('INVALID_TRANSITION', '任务已完成，不能再次启动。');
    }
    if (Object.keys(state.workItems).length > 0) {
      // The only legal re-entry is a resume of a stopped/interrupted task.
      throw new TaskLifecycleError('USE_RESUME', '任务已经启动，请使用继续操作。');
    }
    const profile = await this.frozenProfile(taskId);
    const workItemId = lifecycleWorkItemId(taskId, input.operationId, 'initial_structure_chunk');
    const mapBuildId = `mb-${createHash('sha256').update(canonicalJson({ taskId, operationId: input.operationId }), 'utf8').digest('hex').slice(0, 16)}`;

    // Profile blob choreography (constraint B): the EXACT task-frozen profile.
    const mapBuildSpec = {
      mapBuildId,
      revision: 1,
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
      snapshotHash: profile.snapshotHash,
      plannedChunkPolicy: { maxChunks: 16, maxNodesPerChunk: 512, maxRelationsPerChunk: 64 },
    };
    const payloadRef = await this.facade.prepareBlob(taskId, 'map_build_spec', {
      ...mapBuildSpec,
      specDigest: canonicalJsonSha256(mapBuildSpec),
    });
    // The structure-chunk AuthorityBase binds the MapBuildSpec as its
    // planSpecRef (kind matrix: structure_chunk REQUIRES the plan spec).
    const authorityBase = buildAuthorityBaseSet({
      taskId,
      templateSnapshotRef: profile.templateSnapshotRef,
      profileSnapshotRef: profile.profileSnapshotRef,
      refs: { planSpecRef: payloadRef },
      kind: 'agent_assignment',
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
    });
    const authorityBaseRef = await this.facade.prepareBlob(taskId, 'authority_base_set', authorityBase);
    const grantSpec = this.initialStructureGrantSpec({
      taskId,
      authoringOperationId: input.operationId,
      workItemId,
      authorityBaseRef,
      mapBuildSpecRef: payloadRef,
      snapshotHash: profile.snapshotHash,
    });
    const grantSpecRef = await this.facade.prepareBlob(taskId, 'write_grant_spec', grantSpec);
    const maxAutomaticRetries = await this.defaultAutomaticRetries(taskId);
    const payload: Extract<PublicationOperationPayloadV2, { family: 'lifecycle' }> = {
      family: 'lifecycle',
      operationId: input.operationId,
      taskId,
      kind: 'start',
      suspensionId: null,
      workItemId,
      reason: null,
      leaseEpoch: null,
      expectedLastSequence: null,
      authorityBaseRef,
      attemptFamily: null,
      attemptId: null,
      commandId: null,
      agentId: null,
      commandKind: null,
      logicalAssignmentId: `la-${workItemId}`,
      reviewAssignmentId: null,
      sessionKind: 'structure_chunk',
      inputArtifactDeliveryId: null,
      workItemKind: 'agent_assignment',
      roleBinding: await this.orchestratorRoleBinding(taskId),
      agentExecutionKind: 'structured_session',
      roundId: null,
      grantSpecRef,
      payloadRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries,
      mapBuildId,
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
    };
    void input.userInputText; // the frozen user input rides in the map_build_spec (documented)
    const tail = await this.tail(taskId);
    await this.commitOne({
      taskId,
      operationId: input.operationId,
      payload,
      intent: { handlerKind: 'lifecycle/start_task', handlerVersion: 1 },
      preparedRefs: [authorityBaseRef, payloadRef, grantSpecRef],
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    // The first structure-chunk workitem is ready and claimable: the durable
    // runnable wakeup is upserted atomically after the commit.
    await this.wakeups.upsert(taskId, {
      kind: 'runnable',
      at: null,
      dormant: false,
      workItemId,
      operationId: null,
      eligibilityBlocked: false,
    });
    return { taskId, workItemId, authorityBaseRef, payloadRef, grantSpecRef, replayed: false };
  }

  private deriveStartResult(
    taskId: string,
    input: { operationId: string },
    committed: readonly CoordinatorCommittedEventV2[],
  ): StartedTaskResultV2 | null {
    const created = committed.find((entry) => entry.event.type === 'structured_work_item_created');
    if (created === undefined) return null;
    void input;
    void taskId;
    const event = created.event as Record<string, unknown>;
    return {
      taskId: taskId,
      workItemId: String(event.workItemId),
      authorityBaseRef: event.authorityBaseRef as BlobRefV2,
      payloadRef: event.payloadRef as BlobRefV2,
      grantSpecRef: (event.grantSpecRef as BlobRefV2) ?? ({} as BlobRefV2),
      replayed: true,
    };
  }

  /** The initial_structure_chunk WriteGrantSpec (design §11.11, exact self-digest). */
  private initialStructureGrantSpec(input: {
    taskId: string;
    authoringOperationId: string;
    workItemId: string;
    authorityBaseRef: BlobRefV2;
    mapBuildSpecRef: BlobRefV2;
    snapshotHash: string;
  }): WriteGrantSpecV2 {
    const body = {
      grantSpecId: deterministicExecutionId('grant', input.authoringOperationId, input.workItemId).replace(/^grant-/, 'gs-'),
      workItemId: input.workItemId,
      kind: 'initial_structure_chunk' as const,

      snapshotHash: input.snapshotHash,
      authorityBaseRef: input.authorityBaseRef,
      mapBuildSpecRef: input.mapBuildSpecRef,
      expectedFrontierDigest: '0'.repeat(64),
      structureChunkScope: {
        chunkOrdinal: 1,
        parentFrontierDigest: '0'.repeat(64),
        maxNodes: 512,
        maxRelations: 64,
      },
    };
    const spec = { ...body } as WriteGrantSpecV2;
    const { specDigest: _d, ...without } = spec;
    return { ...body, specDigest: canonicalJsonSha256(without) } as WriteGrantSpecV2;
  }

  /* ---------------- stop / resume / retry ---------------- */

  /**
   * The composed v2 stop (design §17.3): one batch closes the active
   * attempt/command (abandon), reclaims the lease, appends task_stopped (or
   * task_interrupted) and the suspension overlay. Wakeups become DORMANT —
   * never lost — so resume cannot lose the underlying timers.
   */
  async stopV2(taskId: string, input: { operationId: string; reason: 'user_stop' | 'operator_interrupt' }): Promise<StopResultV2> {
    await this.assertNotDeleted(taskId);
    const committed = await this.committedOperation(taskId, input.operationId);
    if (committed !== null) {
      const overlay = committed.find((entry) => entry.event.type === 'structured_task_suspension_applied_v2');
      if (overlay !== undefined && (overlay.event as Record<string, unknown>).reason === input.reason) {
        const suspensionId = String((overlay.event as Record<string, unknown>).suspensionId);
        await this.dormantWakeups(taskId);
        return { suspensionId, reason: input.reason };
      }
      throw new TaskLifecycleError('OPERATION_CONFLICT', `操作 ${input.operationId} 已提交不同的停止批次。`);
    }
    const state = await this.readProjection(taskId);
    if (state.suspension !== null) {
      throw new TaskLifecycleError('INVALID_TRANSITION', '任务已停止，不能重复停止。');
    }
    if (state.failed !== null || state.taskStatus === 'failed') {
      throw new TaskLifecycleError('TASK_TERMINAL', '任务已失败。');
    }
    const suspensionId = deterministicSuspensionId(taskId, input.operationId);
    const lease = state.activeLease;
    const leasedWi = lease === null ? undefined : state.workItems[lease.workItemId];
    const payload: Extract<PublicationOperationPayloadV2, { family: 'lifecycle' }> = {
      family: 'lifecycle',
      operationId: input.operationId,
      taskId,
      kind: 'stop',
      suspensionId,
      reason: input.reason,
      authorityBaseRef: leasedWi === undefined || lease === null ? null : leasedWi.leaseBases[String(leasedWi.leaseEpoch)] ?? leasedWi.authorityBaseRef,
      workItemId: leasedWi?.workItemId ?? null,
      leaseEpoch: leasedWi?.leaseEpoch ?? null,
      attemptFamily: leasedWi === undefined || lease === null ? null : lease.attemptId !== null ? (state.attempts[lease.attemptId]?.family ?? 'structured') : lease.commandId !== null ? 'command' : null,
      attemptId: lease?.attemptId ?? null,
      commandId: lease?.commandId ?? null,
      agentId: leasedWi?.leaseOwner ?? null,
      commandKind:
        lease !== null && lease.commandId !== null
          ? ((state.attempts[lease.commandId]?.commandKind as Extract<PublicationOperationPayloadV2, { family: 'lifecycle' }>['commandKind']) ?? null)
          : null,
      logicalAssignmentId: leasedWi?.logicalAssignmentId ?? null,
      reviewAssignmentId: leasedWi?.reviewAssignmentId ?? null,
      sessionKind:
        (leasedWi?.sessionKind as Extract<PublicationOperationPayloadV2, { family: 'lifecycle' }>['sessionKind']) ?? null,
      inputArtifactDeliveryId: leasedWi?.inputArtifactDeliveryId ?? null,
      expectedLastSequence: null,
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
    const tail = await this.tail(taskId);
    await this.commitOne({
      taskId,
      operationId: input.operationId,
      payload,
      intent: { handlerKind: 'lifecycle/stop', handlerVersion: 1 },
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    await this.dormantWakeups(taskId);
    return { suspensionId, reason: input.reason };
  }

  /** Converts every live wakeup of the task into its dormant counterpart. */
  private async dormantWakeups(taskId: string): Promise<void> {
    const rows = await this.wakeups.read(taskId);
    if (rows.length === 0) return;
    await this.wakeups.write(
      taskId,
      rows.map((row) => ({ ...row, dormant: true })),
    );
  }

  /**
   * The v2 resume (design §17.3 resume bullet): clears the exact suspension
   * overlay and reactivates the dormant wakeups; retry-before-due timers stay
   * timers (the scheduler loop requeues when due). Resume NEVER seeds a new
   * build and NEVER clears human/retry-budget dispositions.
   */
  async resumeV2(taskId: string, input: { operationId: string; suspensionId?: string | null }): Promise<StopResultV2> {
    await this.assertNotDeleted(taskId);
    await this.requireEligible(taskId);
    const state = await this.readProjection(taskId);
    if (state.suspension === null) {
      const committed = await this.committedOperation(taskId, input.operationId);
      if (committed !== null) {
        const cleared = committed.find((entry) => entry.event.type === 'structured_task_suspension_cleared_v2');
        if (cleared !== undefined) {
          await this.reactivateWakeups(taskId);
          return {
            suspensionId: String((cleared.event as Record<string, unknown>).suspensionId),
            reason: 'user_stop',
          };
        }
        throw new TaskLifecycleError('OPERATION_CONFLICT', `操作 ${input.operationId} 已提交不同的继续批次。`);
      }
      throw new TaskLifecycleError('INVALID_TRANSITION', '任务未处于停止/中断状态。');
    }
    const active = state.suspension;
    const result = await this.mapped(() => this.coordinator.clearSuspension(taskId, input.operationId, input.suspensionId ?? active.suspensionId));
    await this.reactivateWakeups(taskId);
    return { suspensionId: result.suspensionId, reason: result.reason ?? active.reason };
  }

  private async reactivateWakeups(taskId: string): Promise<void> {
    const rows = await this.wakeups.read(taskId);
    if (rows.length === 0) return;
    await this.wakeups.write(
      taskId,
      rows.map((row) => ({ ...row, dormant: false })),
    );
  }

  /** The v2 manual retry (only clears a retry_budget_exhausted park). */
  async manualRetryV2(taskId: string, input: { operationId: string; workItemId: string }): Promise<ManualRetryResultV2> {
    await this.assertNotDeleted(taskId);
    await this.requireEligible(taskId);
    const result = await this.mapped(() => this.coordinator.manualRetry(taskId, input.workItemId, input.operationId));
    await this.wakeups.upsert(taskId, {
      kind: 'runnable',
      at: null,
      dormant: false,
      workItemId: input.workItemId,
      operationId: input.operationId,
      eligibilityBlocked: false,
    });
    void result;
    return { workItemId: input.workItemId };
  }

  /** The v2 requeue-due transition (timer-expiry compensation). */
  async requeueDueV2(taskId: string, input: { operationId: string; workItemId: string }): Promise<void> {
    await this.assertNotDeleted(taskId);
    await this.requireEligible(taskId);
    await this.mapped(() => this.coordinator.requeueDue(taskId, input.workItemId, input.operationId));
    await this.wakeups.upsert(taskId, {
      kind: 'runnable',
      at: null,
      dormant: false,
      workItemId: input.workItemId,
      operationId: input.operationId,
      eligibilityBlocked: false,
    });
    await this.wakeups.remove(taskId, 'retry_due', input.workItemId);
  }

  /** Reclaims an in-flight lease (startup recovery / expiry). */
  async reclaimLeaseV2(taskId: string, input: { operationId: string; workItemId: string; reason: 'lease_expired' | 'crash_recovery' | 'user_stop' | 'operator_interrupt' }): Promise<void> {
    await this.assertNotDeleted(taskId);
    const result = await this.mapped(() => this.coordinator.reclaimExpired(taskId, input.workItemId, input.operationId, input.reason));
    await this.wakeups.upsert(taskId, {
      kind: 'runnable',
      at: null,
      dormant: false,
      workItemId: input.workItemId,
      operationId: input.operationId,
      eligibilityBlocked: false,
    });
    void result;
  }

  /**
   * Task 12 handoff seam: the TERMINAL-failure envelope — [attempt/command
   * terminal_failed, work_item_terminal_failed, structured_task_failed_v2]
   * in ONE batch (§10.3). Registered in the intent allowlist NOW so the
   * reopen/startup/UI failed-state tests have a legal failing path; the
   * attempt-coordinator will call this when a permanent failure lands.
   * `taskFailure:false` emits only the attempt+workitem terminal events
   * (completed-terminal envelope without a task failure).
   */
  async terminalFailWorkItem(
    taskId: string,
    input: {
      operationId: string;
      workItemId: string;
      failureCode: string;
      failureDigest: string;
      failureRecoveryPayloadRef: BlobRefV2 | null;
      taskFailure: boolean;
      /**
       * Task 12 I-1: the attempt/command identity the CALLER holds. When
       * provided, the method rejects with `INVALID_TRANSITION` (ZERO writes)
       * unless it equals the active lease's bound attempt/command — a
       * stale-epoch late terminal can never terminal-fail the CURRENT
       * re-leased attempt (§10.2).
       */
      attemptId?: string | null;
      commandId?: string | null;
    },
  ): Promise<void> {
    await this.assertNotDeleted(taskId);
    const committed = await this.committedOperation(taskId, input.operationId);
    if (committed !== null) {
      const terminal = committed.find((entry) => entry.event.type === 'structured_work_item_terminal_failed');
      if (terminal !== undefined) return;
      throw new TaskLifecycleError('OPERATION_CONFLICT', `操作 ${input.operationId} 已提交不同的终止批次。`);
    }
    const state = await this.readProjection(taskId);
    const wi = state.workItems[input.workItemId];
    if (wi === undefined) {
      throw new TaskLifecycleError('INVALID_TRANSITION', `WorkItem ${input.workItemId} 不存在。`);
    }
    if (wi.state !== 'leased') {
      throw new TaskLifecycleError('INVALID_TRANSITION', `WorkItem ${input.workItemId} 未处于租赁状态。`);
    }
    const lease = state.activeLease;
    // I-1: the caller's identity must match the active lease's bound carrier.
    const callerAttemptId = input.attemptId ?? null;
    const callerCommandId = input.commandId ?? null;
    if (callerAttemptId !== null && lease?.attemptId !== callerAttemptId) {
      throw new TaskLifecycleError(
        'INVALID_TRANSITION',
        `调用方 attempt '${callerAttemptId}' 与当前租赁 attempt '${String(lease?.attemptId ?? null)}' 不一致。`,
      );
    }
    if (callerCommandId !== null && lease?.commandId !== callerCommandId) {
      throw new TaskLifecycleError(
        'INVALID_TRANSITION',
        `调用方 command '${callerCommandId}' 与当前租赁 command '${String(lease?.commandId ?? null)}' 不一致。`,
      );
    }
    const attempt =
      lease === null || lease === undefined
        ? undefined
        : lease.attemptId !== null
          ? state.attempts[lease.attemptId]
          : lease.commandId !== null
            ? state.attempts[lease.commandId]
            : undefined;
    const base = wi.leaseBases[String(wi.leaseEpoch)] ?? wi.authorityBaseRef;
    const attemptFamily =
      lease === null
        ? null
        : lease.attemptId !== null
          ? (attempt?.family ?? 'structured')
          : lease.commandId !== null
            ? 'command'
            : null;
    if (attemptFamily === null || lease === null) {
      throw new TaskLifecycleError('INVALID_TRANSITION', '租赁没有绑定的 attempt/command，无法终止。');
    }
    const payload: Extract<PublicationOperationPayloadV2, { family: 'lease_or_retry' }> = {
      family: 'lease_or_retry',
      operationId: input.operationId,
      taskId,
      workItemId: input.workItemId,
      leaseEpoch: wi.leaseEpoch,
      eventBuilder: 'work_item_terminal_failed',
      authorityBaseRef: base,
      kind: wi.kind as WorkItemKindV2,
      roleBinding: wi.roleBinding,
      agentExecutionKind: wi.agentExecutionKind,
      sessionKind: wi.sessionKind as Extract<PublicationOperationPayloadV2, { family: 'lease_or_retry' }>['sessionKind'],
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
      attemptId: attemptFamily === 'command' ? null : (attempt?.attemptId ?? null),
      commandId: attemptFamily === 'command' ? (lease?.commandId ?? null) : null,
      agentId: attempt?.agentId ?? wi.leaseOwner,
      commandKind: (attempt?.commandKind as Extract<PublicationOperationPayloadV2, { family: 'lease_or_retry' }>['commandKind']) ?? null,
      dispatchRef: null,
      grantInstanceRef: null,
      reason: null,
      failureCode: input.failureCode,
      failureDigest: input.failureDigest,
      retryOrdinal: null,
      retryNotBefore: null,
      validatorAggregateRef: null,
      budgetPolicyDigest: null,
      failureRecoveryPayloadRef: input.failureRecoveryPayloadRef,
      taskFailure: input.taskFailure,
      resultRefs: [],
    };
    const tail = await this.tail(taskId);
    const preparedRefs: BlobRefV2[] = [base];
    if (input.failureRecoveryPayloadRef !== null) preparedRefs.push(input.failureRecoveryPayloadRef);
    await this.commitOne({
      taskId,
      operationId: input.operationId,
      payload,
      intent: { handlerKind: 'work_item_terminal_failed', handlerVersion: 1 },
      preparedRefs,
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    await this.wakeups.remove(taskId, 'lease_expiry', input.workItemId);
    await this.wakeups.remove(taskId, 'runnable', input.workItemId);
  }

  /* ---------------- human questions ---------------- */

  /**
   * The v2 question OPEN (design §17.3): one batch terminal-fails the active
   * structured attempt, opens the question, parks the original WorkItem with
   * the human_question disposition and writes the public display event. The
   * token binds the opened commit (= the opening operationId, which IS the
   * batch commitId — deterministic before the commit).
   */
  async openQuestionV2(
    taskId: string,
    input: { operationId: string; questionId: string; questionText: string },
  ): Promise<OpenedQuestionResultV2> {
    await this.assertNotDeleted(taskId);
    await this.requireEligible(taskId);
    const committed = await this.committedOperation(taskId, input.operationId);
    if (committed !== null) {
      const opened = committed.find((entry) => entry.event.type === 'structured_human_question_opened_v2');
      if (opened !== undefined) {
        return {
          questionId: String((opened.event as Record<string, unknown>).questionId),
          questionVersion: String((opened.event as Record<string, unknown>).questionVersion),
        };
      }
      throw new TaskLifecycleError('OPERATION_CONFLICT', `操作 ${input.operationId} 已提交不同的问题批次。`);
    }
    const state = await this.readProjection(taskId);
    const lease = state.activeLease;
    if (lease === null || lease.attemptId === null) {
      throw new TaskLifecycleError('INVALID_TRANSITION', '只有活动 Agent attempt 可以打开人工问题。');
    }
    const attempt = state.attempts[lease.attemptId];
    if (attempt === undefined || attempt.family !== 'structured' || attempt.state !== 'started') {
      throw new TaskLifecycleError('INVALID_TRANSITION', '当前没有进行中的结构化 Agent attempt 可以打开问题。');
    }
    const wi = state.workItems[lease.workItemId];
    const base = wi.leaseBases[String(wi.leaseEpoch)] ?? wi.authorityBaseRef;
    const questionDigest = canonicalJsonSha256({ questionId: input.questionId, text: input.questionText });
    const version = questionVersionToken({
      questionId: input.questionId,
      originalWorkItemId: wi.workItemId,
      logicalAssignmentId: attempt.logicalAssignmentId ?? wi.logicalAssignmentId ?? `la-${wi.workItemId}`,
      attemptId: attempt.attemptId,
      leaseEpoch: lease.leaseEpoch,
      questionDigest,
      authorityBaseRef: base,
      openedCommitId: input.operationId,
    });
    const payload: Extract<PublicationOperationPayloadV2, { family: 'question' }> = {
      family: 'question',
      operationId: input.operationId,
      taskId,
      questionId: input.questionId,
      questionVersion: version,
      mode: 'open',
      questionDigest,
      text: input.questionText,
      answerText: null,
      openedCommitId: input.operationId,
      expectedLastSequence: state.lastSequence,
      originalWorkItemId: wi.workItemId,
      replacementWorkItemId: null,
      deliveryId: null,
      attemptId: attempt.attemptId,
      leaseEpoch: lease.leaseEpoch,
      logicalAssignmentId: attempt.logicalAssignmentId ?? wi.logicalAssignmentId ?? `la-${wi.workItemId}`,
      reviewAssignmentId: attempt.reviewAssignmentId ?? wi.reviewAssignmentId,
      sessionKind: attempt.sessionKind as Extract<PublicationOperationPayloadV2, { family: 'question' }>['sessionKind'],
      agentId: attempt.agentId ?? wi.leaseOwner ?? '',
      answerDigest: null,
      authorityBaseRef: base,
      kind: null,
      roleBinding: null,
      agentExecutionKind: null,
      roundId: null,
      grantSpecRef: null,
      inputArtifactDeliveryId: null,
      payloadRef: null,
      initialLeaseEpoch: null,
      maxAutomaticRetries: null,
      failureCode: 'WAITING_HUMAN',
      failureDigest: canonicalJsonSha256({ questionId: input.questionId }),
    };
    const tail = await this.tail(taskId);
    await this.commitOne({
      taskId,
      operationId: input.operationId,
      payload,
      intent: { handlerKind: 'human_question_open', handlerVersion: 1 },
      preparedRefs: [base],
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    await this.wakeups.upsert(taskId, {
      kind: 'runnable',
      at: null,
      dormant: false,
      workItemId: null,
      operationId: null,
      eligibilityBlocked: false,
    });
    return { questionId: input.questionId, questionVersion: version };
  }

  /**
   * The v2 ANSWER (design §17.3): the server atomically verifies the current
   * unconsumed identity — token format, exact recomputation from the bound
   * fields, active pending question — then commits the delivery, supersedes
   * the original question-bound WorkItem, creates the replacement WorkItem
   * and the public display event in ONE batch. Same operation + same canonical
   * answer replays; a different payload conflicts; a consumed/replaced token
   * is permanently stale (HUMAN_QUESTION_STALE).
   */
  async answerV2(
    taskId: string,
    input: {
      operationId: string;
      questionId: string;
      questionVersion: string;
      answer: string;
    },
  ): Promise<AnswerResultV2> {
    await this.assertNotDeleted(taskId);
    if (!isQuestionVersionToken(input.questionVersion)) {
      throw new TaskLifecycleError('HUMAN_QUESTION_STALE', 'questionVersion 格式非法或已失效。');
    }
    const committed = await this.committedOperation(taskId, input.operationId);
    if (committed !== null) {
      const delivered = committed.find((entry) => entry.event.type === 'structured_human_answer_delivered_v2');
      if (delivered !== undefined) {
        const event = delivered.event as Record<string, unknown>;
        if (String(event.questionId) === input.questionId && event.answerDigest === answerDigestOf(input.answer, input.questionId)) {
          return {
            deliveryId: String(event.deliveryId),
            replacementWorkItemId: String(event.replacementWorkItemId),
            replayed: true,
          };
        }
        throw new TaskLifecycleError('OPERATION_CONFLICT', `操作 ${input.operationId} 已提交不同的回答。`);
      }
      throw new TaskLifecycleError('OPERATION_CONFLICT', `操作 ${input.operationId} 已提交不同的批次。`);
    }
    const state = await this.readProjection(taskId);
    const question = state.pendingQuestion;
    if (question === null || question.questionId !== input.questionId) {
      throw new TaskLifecycleError('HUMAN_QUESTION_STALE', '该问题已消费或不存在。');
    }
    // Recompute the token from the bound fields (never trust a client token).
    const openedCommitId = await this.openedCommitIdOf(taskId, question.openedEventId);
    const recomputed = questionVersionToken({
      questionId: question.questionId,
      originalWorkItemId: question.originalWorkItemId,
      logicalAssignmentId: question.logicalAssignmentId,
      attemptId: question.attemptId,
      leaseEpoch: question.leaseEpoch,
      questionDigest: question.questionDigest,
      authorityBaseRef: question.authorityBaseRef,
      openedCommitId,
    });
    if (recomputed !== input.questionVersion) {
      throw new TaskLifecycleError('HUMAN_QUESTION_STALE', 'questionVersion 与问题绑定不一致（已失效）。');
    }
    const original = state.workItems[question.originalWorkItemId];
    if (original === undefined) {
      throw new TaskLifecycleError('TASK_CORRUPT', '问题绑定的原 WorkItem 缺失。');
    }
    const replacementWorkItemId = lifecycleWorkItemId(taskId, input.operationId, 'answer_replacement');
    // Review A-M6 (design §17.3 "replacement WorkItem/WriteGrantSpec"): the
    // replacement workitem NEVER reuses the superseded workitem's grant spec —
    // that spec is bound to the ORIGINAL workItemId, and the Task 12
    // grant-instance binds grantSpec.workItemId. A NEW grant spec is derived
    // from the original's body with the replacement identity, published in the
    // SAME pin (its self-digest is recomputed over the canonical body).
    let replacementGrantSpecRef: BlobRefV2 | null = original.grantSpecRef;
    if (original.grantSpecRef !== null) {
      let grantBody: Record<string, unknown>;
      try {
        grantBody = (await this.resolver(taskId, original.grantSpecRef)) as Record<string, unknown>;
        if (grantBody === null || typeof grantBody !== 'object') {
          throw new TaskLifecycleError('TASK_CORRUPT', '原 WorkItem 的 GrantSpec 不可解析。');
        }
      } catch (error) {
        if (error instanceof TaskLifecycleError) throw error;
        throw new TaskLifecycleError('TASK_CORRUPT', '原 WorkItem 的 GrantSpec 不可解析。');
      }
      const { specDigest: _legacyDigest, ...grantWithoutDigest } = grantBody;
      const replacementGrant = { ...grantWithoutDigest, workItemId: replacementWorkItemId };
      replacementGrantSpecRef = await this.facade.prepareBlob(taskId, 'write_grant_spec', {
        ...replacementGrant,
        specDigest: canonicalJsonSha256(replacementGrant),
      });
    }
    const deliveryId = `del-${canonicalJsonSha256({ taskId, operationId: input.operationId, questionId: input.questionId }).slice(0, 24)}`;
    const attempt = state.attempts[question.attemptId];
    const payload: Extract<PublicationOperationPayloadV2, { family: 'question' }> = {
      family: 'question',
      operationId: input.operationId,
      taskId,
      questionId: question.questionId,
      questionVersion: question.questionVersion,
      mode: 'answer',
      questionDigest: null,
      text: null,
      answerText: input.answer,
      openedCommitId: null,
      expectedLastSequence: state.lastSequence,
      originalWorkItemId: question.originalWorkItemId,
      replacementWorkItemId,
      deliveryId,
      attemptId: null,
      leaseEpoch: original.leaseEpoch,
      logicalAssignmentId: question.logicalAssignmentId,
      reviewAssignmentId: original.reviewAssignmentId,
      sessionKind: original.sessionKind as Extract<PublicationOperationPayloadV2, { family: 'question' }>['sessionKind'],
      agentId: attempt?.agentId ?? original.leaseOwner ?? '',
      answerDigest: answerDigestOf(input.answer, question.questionId),
      authorityBaseRef: question.authorityBaseRef,
      kind: original.kind as WorkItemKindV2,
      roleBinding: original.roleBinding,
      agentExecutionKind: original.agentExecutionKind,
      roundId: original.roundId,
      grantSpecRef: replacementGrantSpecRef,
      inputArtifactDeliveryId: original.inputArtifactDeliveryId,
      payloadRef: original.payloadRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries: original.maxAutomaticRetries,
      failureCode: null,
      failureDigest: null,
    };
    const tail = await this.tail(taskId);
    const preparedRefs: BlobRefV2[] = [question.authorityBaseRef, original.payloadRef];
    if (replacementGrantSpecRef !== null) preparedRefs.push(replacementGrantSpecRef);
    // The ORIGINAL grant spec stays a root through the original workitem's
    // own events — the answer op only pins the replacement identity.
    await this.commitOne({
      taskId,
      operationId: input.operationId,
      payload,
      intent: { handlerKind: 'human_answer', handlerVersion: 1 },
      preparedRefs,
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    await this.wakeups.upsert(taskId, {
      kind: 'runnable',
      at: null,
      dormant: false,
      workItemId: replacementWorkItemId,
      operationId: input.operationId,
      eligibilityBlocked: false,
    });
    return { deliveryId, replacementWorkItemId, replayed: false };
  }

  /** Resolves the commitId of the batch that opened the question (token binding). */
  private async openedCommitIdOf(taskId: string, openedEventId: string): Promise<string> {
    const committed = await this.events(taskId);
    for (const entry of committed) {
      if (entry.event.id !== openedEventId) continue;
      const batch = parseBatchFileName(entry.fileName);
      if (batch !== null) return batch.commitId;
      return entry.event.id; // legacy single-event append: commitId === event id
    }
    throw new TaskLifecycleError('TASK_CORRUPT', '打开问题的批次提交身份不可解析。');
  }

  /* ---------------- reopen ---------------- */

  /**
   * The fenced reopen (design §17.2 / spec §10.3.1): ONLY the frozen policy
   * table can recover a failed task; the replacement base/scope/Grant are
   * derived SERVER-SIDE; the one ready replacement + applicable system-owned
   * WriteGrantSpec (and the one available RoundBudgetOverride for round-limit
   * recipes) land in the SAME batch as `structured_task_reopened_v2`; the
   * durable wakeup is upserted in the same flow. Nothing ever mutates the
   * failed WorkItem, resets counters, reuses staging, widens a Grant, or
   * creates two successors.
   */
  async reopenFailed(taskId: string, request: ReopenRequestV2): Promise<ReopenResultV2> {
    await this.assertNotDeleted(taskId);
    await this.requireEligible(taskId);
    const committed = await this.committedOperation(taskId, request.operationId);
    if (committed !== null) {
      const reopened = committed.find((entry) => entry.event.type === 'structured_task_reopened_v2');
      if (reopened === undefined) {
        throw new TaskLifecycleError('OPERATION_CONFLICT', `操作 ${request.operationId} 已提交不同的批次。`);
      }
      const event = reopened.event as Record<string, unknown>;
      if (
        event.recipeKey !== request.recipeKey ||
        (event.track ?? null) !== request.track ||
        event.reason !== request.reason
      ) {
        throw new TaskLifecycleError('OPERATION_CONFLICT', `操作 ${request.operationId} 已提交不同的 reopen 载荷。`);
      }
      const created = committed.find((entry) => entry.event.type === 'structured_work_item_created');
      return {
        replacementWorkItemId: String((created?.event as Record<string, unknown> | undefined)?.workItemId ?? ''),
        overrideRef: (event.overrideRef as BlobRefV2 | null) ?? null,
        replayed: true,
      };
    }
    const state = await this.readProjection(taskId);
    if (state.failed === null) {
      throw new TaskLifecycleError('INVALID_TRANSITION', '任务未处于失败状态，不能 reopen。');
    }
    const failed = state.failed;
    // Frozen policy branch (spec §10.3.1 row matrix).
    const branch = RECOVERY_KIND_BY_FAILURE_CODE[failed.failureCode];
    if (branch === undefined || failed.failureRecoveryPayloadRef === null) {
      throw new TaskLifecycleError('INVALID_TRANSITION', '该失败不可就地恢复，只能克隆为新任务。');
    }
    let recoveryPayload: Record<string, unknown>;
    try {
      const resolved = (await this.resolver(taskId, failed.failureRecoveryPayloadRef)) as Record<string, unknown>;
      if (resolved === null || typeof resolved !== 'object') {
        throw new TaskLifecycleError('TASK_CORRUPT', '失败恢复载荷不可解析。');
      }
      recoveryPayload = resolved;
    } catch (error) {
      if (error instanceof TaskLifecycleError) throw error;
      throw new TaskLifecycleError('TASK_CORRUPT', '失败恢复载荷不可解析。');
    }
    const recipeBranch: 'restart_review_cycle' | 'retry_system_command' | 'rebuild_missing_work' =
      request.recipeKey === 'restart_map_review_cycle' || request.recipeKey === 'restart_content_review_cycle'
        ? 'restart_review_cycle'
        : request.recipeKey;
    if (recipeBranch !== branch) {
      throw new TaskLifecycleError('INVALID_TRANSITION', `失败 ${failed.failureCode} 不允许 recipe ${request.recipeKey}。`);
    }
    if (request.expectedLastSequence !== state.lastSequence) {
      throw new TaskLifecycleError('AUTHORITY_BASE_STALE', '预期尾部不匹配，请刷新后重试。');
    }
    if (branch === 'restart_review_cycle') {
      const failedTrack = recoveryPayload.track;
      if (failedTrack !== 'map' && failedTrack !== 'content') {
        throw new TaskLifecycleError('TASK_CORRUPT', '失败恢复载荷缺少 track。');
      }
      if (request.track !== failedTrack) {
        throw new TaskLifecycleError('INVALID_TRANSITION', `该失败记录于 ${failedTrack} track，不能使用 ${String(request.track)} 恢复。`);
      }
    }
    // Tail CAS is the facade's authority; a stale tail here maps to the
    // stable AUTHORITY_BASE_STALE before ANY prepared write.
    const tail = await this.tail(taskId);
    if (tail.lastSequence !== request.expectedLastSequence) {
      throw new TaskLifecycleError('AUTHORITY_BASE_STALE', '任务尾部已变化，请刷新后重试。');
    }

    const derived = await this.deriveReplacement(taskId, state, request, recoveryPayload);
    const { replacement, preparedBlobs, overrideRef } = derived;

    const payload: Extract<PublicationOperationPayloadV2, { family: 'recovery' }> = {
      family: 'recovery',
      operationId: request.operationId,
      taskId,
      expectedLastSequence: request.expectedLastSequence,
      operatorId: 'task_owner',
      reason: request.reason,
      recipeKey: request.recipeKey,
      track: request.track,
      failureRecoveryPayloadRef: failed.failureRecoveryPayloadRef,
      overrideRef,
      replacementWorkItemId: replacement.workItemId,
      replacementKind: replacement.kind,
      replacementRoleBinding: replacement.roleBinding,
      replacementAgentExecutionKind: replacement.agentExecutionKind,
      replacementSessionKind: (replacement.sessionKind as Extract<PublicationOperationPayloadV2, { family: 'recovery' }>['replacementSessionKind']),
      replacementRoundId: null,
      replacementLogicalAssignmentId: replacement.logicalAssignmentId,
      replacementReviewAssignmentId: null,
      replacementGrantSpecRef: replacement.grantSpecRef,
      replacementInputArtifactDeliveryId: null,
      replacementPayloadRef: replacement.payloadRef,
      replacementAuthorityBaseRef: replacement.authorityBaseRef,
      replacementLeaseEpoch: replacement.initialLeaseEpoch,
      replacementMaxAutomaticRetries: replacement.maxAutomaticRetries,
    };
    const preparedRefs: BlobRefV2[] = [replacement.authorityBaseRef, replacement.payloadRef, failed.failureRecoveryPayloadRef];
    if (replacement.grantSpecRef !== null) preparedRefs.push(replacement.grantSpecRef);
    if (overrideRef !== null) preparedRefs.push(overrideRef);
    for (const blob of preparedBlobs) preparedRefs.push(blob);

    await this.commitOne({
      taskId,
      operationId: request.operationId,
      payload,
      intent: { handlerKind: request.recipeKey, handlerVersion: 1 },
      preparedRefs,
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    await this.wakeups.upsert(taskId, {
      kind: 'runnable',
      at: null,
      dormant: false,
      workItemId: replacement.workItemId,
      operationId: request.operationId,
      eligibilityBlocked: false,
    });
    return { replacementWorkItemId: replacement.workItemId, overrideRef, replayed: false };
  }

  private async deriveReplacement(
    taskId: string,
    state: AuthoritativeReviewProjectionV2,
    request: ReopenRequestV2,
    recoveryPayload: Record<string, unknown>,
  ): Promise<{
    replacement: {
      workItemId: string;
      kind: WorkItemKindV2;
      roleBinding: string | null;
      agentExecutionKind: 'structured_session' | 'generic_turn' | null;
      sessionKind: string | null;
      logicalAssignmentId: string | null;
      grantSpecRef: BlobRefV2 | null;
      payloadRef: BlobRefV2;
      authorityBaseRef: BlobRefV2;
      initialLeaseEpoch: number;
      maxAutomaticRetries: number;
    };
    preparedBlobs: BlobRefV2[];
    overrideRef: BlobRefV2 | null;
  }> {
    const failed = state.failed as NonNullable<typeof state.failed>;
    const failedWi = state.workItems[failed.workItemId];
    const maxAutomaticRetries = failedWi?.maxAutomaticRetries ?? (await this.defaultAutomaticRetries(taskId));
    const workItemId = lifecycleWorkItemId(taskId, request.operationId, 'reopen_replacement');
    const blob = (ref: unknown): BlobRefV2 => ref as BlobRefV2;
    if (request.recipeKey === 'retry_system_command') {
      // Clone the failed System WorkItem kind/payload into one new ready
      // WorkItem with epoch 1: no Agent Grant, exact failed-base authority.
      return {
        replacement: {
          workItemId,
          kind: String(recoveryPayload.systemKind) as Extract<WorkItemKindV2, `system_${string}`>,
          roleBinding: null,
          agentExecutionKind: null,
          sessionKind: null,
          logicalAssignmentId: null,
          grantSpecRef: null,
          payloadRef: blob(recoveryPayload.systemPayloadRef),
          authorityBaseRef: blob(recoveryPayload.authorityBaseRef),
          initialLeaseEpoch: 1,
          maxAutomaticRetries,
        },
        preparedBlobs: [],
        overrideRef: null,
      };
    }
    if (request.recipeKey === 'rebuild_missing_work') {
      // Recreate ONLY the expected successor kind/payload/base (+ applicable
      // GrantSpec input) from the persisted recovery payload.
      const kind = String(recoveryPayload.expectedSuccessorKind) as WorkItemKindV2;
      const grantSpecRef = (recoveryPayload.grantSpecInputRef as BlobRefV2 | null) ?? null;
      const isAgent = kind === 'agent_assignment';
      return {
        replacement: {
          workItemId,
          kind,
          roleBinding: isAgent ? await this.repairRoleBinding(taskId, 'map_repair') : null,
          agentExecutionKind: isAgent ? 'structured_session' : null,
          sessionKind: isAgent ? 'map_repair' : null,
          logicalAssignmentId: isAgent ? `la-${workItemId}` : null,
          grantSpecRef,
          payloadRef: blob(recoveryPayload.expectedSuccessorPayloadRef),
          authorityBaseRef: blob(recoveryPayload.authorityBaseRef),
          initialLeaseEpoch: 1,
          maxAutomaticRetries,
        },
        preparedBlobs: [],
        overrideRef: null,
      };
    }
    // Round-limit recipes: one available RoundBudgetOverride + a successor
    // repair-plan revision + one repair WorkItem + the exact repair WriteGrant.
    const track = request.track === 'map' || request.track === 'content' ? request.track : null;
    if (track === null) {
      throw new TaskLifecycleError('INVALID_TRANSITION', 'round-limit 恢复必须声明 track。');
    }
    const session = track === 'map' ? 'map_repair' : 'content_repair';
    const base = blob(recoveryPayload.authorityBaseRef);
    // Review A-M1 (Ruling 2): the successor repair base uses the PROJECTION's
    // real refs wherever they exist — current candidate (map track),
    // activated Map snapshot and the latest content manifest (content track).
    // A placeholder digest-only ref remains ONLY for fields the frozen
    // projection genuinely cannot provide (the attempt-private imported
    // staging manifest).
    //
    // TASK-13 HARD RULE: a placeholder plan-base ref must NEVER be GC-marked
    // or resolved by an attempt lease — the reopen pipeline resolves-or-fails
    // once the projection carries the field. GC's registry child walker for
    // these plan-blob fields is kind-checked-only today (tests below pin
    // that), and Task 13 flips the wiring to real projection refs in the
    // SAME release that makes the child walker strict.
    const placeholderRef = (literal: (typeof REOPEN_PLACEHOLDER_LITERALS)[number], kind: 'map_candidate' | 'map_snapshot' | 'content_revision_manifest'): BlobRefV2 => ({
      kind,
      digest: canonicalJsonSha256({ placeholder: literal }),
      byteLength: 10,
      mediaType: 'application/json',
      schemaVersion: 1,
    });
    const planBase =
      track === 'map'
        ? state.currentCandidate !== null
          ? { kind: 'map_candidate' as const, candidateRef: state.currentCandidate.candidateRef }
          : state.currentMap !== null
            ? { kind: 'map_active' as const, mapRef: state.currentMap.mapSnapshotRef }
            : { kind: 'map_candidate' as const, candidateRef: placeholderRef('repairBase:map', 'map_candidate') }
        : {
            kind: 'content' as const,
            mapRef: state.currentMap !== null ? state.currentMap.mapSnapshotRef : placeholderRef('repairBase:map', 'map_snapshot'),
            contentRevisionManifestRef:
              state.currentManifest !== null
                ? state.currentManifest.contentRevisionManifestRef
                : placeholderRef('repairBase:manifest', 'content_revision_manifest'),
          };
    const overrideId = `ovr-${canonicalJsonSha256({ taskId, operationId: request.operationId, track }).slice(0, 24)}`;
    const planId = `rp-${canonicalJsonSha256({ taskId, operationId: request.operationId, track, role: 'repair' }).slice(0, 20)}`;
    // Successor plan lineage: an initial (self-consistent) plan spec + the
    // successor revision the WorkItem/Grant bind (repairLineageId chain).
    // Ordering note: the KEY LEDGER is prepared FIRST — its ref is a plain
    // content-addressed root the initial and successor specs both bind, and
    // its own planRevisionId is self-consistent (no spec dependency), which
    // breaks the spec↔ledger reference circle.
    const ledgerPlanRevisionId = canonicalJsonSha256({ repairPlanId: planId, revision: 1, chain: 'reopen' });
    const keyLedger = { repairPlanId: planId, planRevisionId: ledgerPlanRevisionId, entries: [] };
    const keyLedgerRef = await this.facade.prepareBlob(taskId, 'repair_key_ledger', {
      ...keyLedger,
      ledgerDigest: canonicalJsonSha256(keyLedger),
    });
    // The imported staging manifest is attempt-private — the frozen
    // projection carries no such field. It is a PLACEHOLDER by design (see
    // the Task-13 hard rule above): never GC-marked, never lease-resolved.
    const importedStagingPlaceholder: BlobRefV2 = placeholderRef('staging:imported', 'content_revision_manifest');
    const initialSpec = {
      repairPlanId: planId,
      revision: 0,
      origin: { kind: 'initial' as const, settlementId: `settlement-${overrideId}`, settlementDigest: '0'.repeat(64), creationOperationKey: request.operationId },
      sourceReceiptRef: null,
      repairBase: planBase,
      orderedBatchScopes: [],
      keyLineageRef: keyLedgerRef,
      importedStagingManifestRef: importedStagingPlaceholder,
    };
    const initialSpecDigest = canonicalJsonSha256({ ...initialSpec } as Record<string, unknown>);
    const initialBlob = {
      ...initialSpec,
      specDigest: initialSpecDigest,
      planRevisionId: canonicalJsonSha256({ repairPlanId: planId, revision: 0, specDigest: initialSpecDigest }),
    } as unknown;
    const initialRef = await this.facade.prepareBlob(taskId, 'repair_plan_spec', initialBlob);
    const successorSpec = {
      repairPlanId: planId,
      revision: 1,
      origin: { kind: 'successor' as const, supersedesPlanSpecRef: initialRef, successorReason: 'recovery' as const, successorOperationKey: request.operationId },
      sourceReceiptRef: null,
      repairBase: planBase,
      orderedBatchScopes: [],
      keyLineageRef: keyLedgerRef,
      importedStagingManifestRef: importedStagingPlaceholder,
    };
    const successorDigest = canonicalJsonSha256({ ...successorSpec } as Record<string, unknown>);
    const successorPlanRevisionId = canonicalJsonSha256({ repairPlanId: planId, revision: 1, specDigest: successorDigest });
    const successorBlob = {
      ...successorSpec,
      specDigest: successorDigest,
      planRevisionId: successorPlanRevisionId,
    } as unknown;
    const successorRef = await this.facade.prepareBlob(taskId, 'repair_plan_spec', successorBlob);
    const stagingRoot = {
      repairPlanId: planId,
      planRevisionId: successorPlanRevisionId,
      batchOrdinal: 1,
      mapRootDigest: track === 'map' ? '0'.repeat(64) : null,
      contentRootDigest: track === 'content' ? '0'.repeat(64) : null,
      priorStagingRootRef: null,
      keyLedgerRef,
    };
    const stagingRootRef = await this.facade.prepareBlob(taskId, 'repair_staging_root', {
      ...stagingRoot,
      stagingDigest: canonicalJsonSha256(stagingRoot),
    });
    const grantBody = {
      grantSpecId: deterministicExecutionId('grant', request.operationId, workItemId).replace(/^grant-/, 'gs-'),
      workItemId,
      kind: track === 'map' ? 'map_repair_batch' as const : 'content_repair_batch' as const,
      snapshotHash: (await this.frozenProfile(taskId)).snapshotHash,
      authorityBaseRef: base,
      repairPlanSpecRef: successorRef,
      repairBase: initialSpec.repairBase,
      expectedStagingRootRef: stagingRootRef,
      planKeyLedgerRef: keyLedgerRef,
      batchOrdinal: 1,
      findingIds: [],
      readScope: { maxContextBytes: 4096 },
      writeScope:
        track === 'map'
          ? {
              mapWriteScope: {
                nodeIds: [],
                relationIds: [],
                allowedPlanKeys: [],
                parentContainers: [],
                relationTypeIds: [],
                operations: ['update_attributes'],
              },
            }
          : { writeSlotIds: [] },
    };
    const grantForDigest = { ...grantBody } as unknown as WriteGrantSpecV2;
    const { specDigest: _d, ...grantWithout } = grantForDigest;
    const grantSpecRef = await this.facade.prepareBlob(taskId, 'write_grant_spec', {
      ...grantBody,
      specDigest: canonicalJsonSha256(grantWithout),
    });
    const override: RoundBudgetOverrideV2 = {
      overrideId,
      failedEventId: failed.eventId,
      track,
      repairLineageId: planId,
      initialRepairPlanRef: initialRef,
      currentAuthorizedRepairPlanRef: successorRef,
      predecessorOverrideRef: null,
      transferOrdinal: 0,
      operationId: request.operationId,
      operatorId: 'task_owner',
      reasonDigest: canonicalJsonSha256({ reason: request.reason }),
      state: 'available',
    };
    const overrideRef = await this.facade.prepareBlob(taskId, 'round_budget_override', override);
    return {
      replacement: {
        workItemId,
        kind: 'agent_assignment',
        roleBinding: await this.repairRoleBinding(taskId, session),
        agentExecutionKind: 'structured_session',
        sessionKind: session as Extract<PublicationOperationPayloadV2, { family: 'recovery' }>['replacementSessionKind'],
        logicalAssignmentId: `la-${workItemId}`,
        grantSpecRef,
        payloadRef: successorRef,
        authorityBaseRef: base,
        initialLeaseEpoch: 1,
        maxAutomaticRetries,
      },
      preparedBlobs: [initialRef, keyLedgerRef, stagingRootRef],
      overrideRef,
    };
  }
}

/** Structural check helper (never imported from the deletion module's runtime). */