/**
 * Task 11 deterministic non-graceful startup recovery (spec §10.4, design
 * §17.3 crash bullet): process crashes have no reliable write opportunity, so
 * every startup scan converges with the stable recovery id
 * `H(taskId, observedTailCommitId, 'auto_continue_v1')`.
 *
 * The scan is a pure function of the event projection + the durable wakeup
 * index: repeating it with the same observed tail replays the SAME
 * compensation (response-loss idempotent); a changed observed tail reprojects
 * before any new action (the recovery identity changes with the tail). No
 * in-memory queue or timer is ever required — process-local state is only an
 * accelerator, and the durable wakeup index is the authority.
 *
 * Matrix (the frozen auto-continue policy version):
 * - running + leased        -> atomically abandon + reclaim (crash_recovery),
 *                              then a runnable wakeup;
 * - running + ready + no lease -> repair the durable runnable wakeup;
 * - running + retryable before due -> repair the retry_due timer (no early
 *                              requeue);
 * - running + retryable at/after due -> requeue with the recovery id, then
 *                              a runnable wakeup;
 * - running + no non-terminal WorkItem -> atomically fail with
 *                              RUNNING_WITHOUT_WORK (never falsely running);
 * - stopped/interrupted overlay -> keep underlying timers DORMANT (no claim,
 *                              no requeue — resume reactivates them);
 * - waiting_human -> pending question derives from opened/delivered events;
 *                              never claim, never synthesize an answer;
 * - completed/failed/corrupt/incompatible -> no claim; remove disposable
 *                              wakeups.
 *
 * The scan NEVER guesses a crash to be an operator interruption: only the
 * frozen policy version may change that semantic (a future
 * interruption-on-crash version writes the operator overlay in the SAME
 * compensation envelope).
 */
import { createHash } from 'node:crypto';
import { canonicalJson, canonicalJsonSha256 as canonicalSha256Hex } from '../../structured-slots/canonical-json';
import type { AuthoritativeAppendFacadeV2 } from '../../storage/authoritative-append-facade';
import type { AuthoritativeReviewCheckpointStore } from '../../storage/authoritative-review-checkpoint-store';
import type { AuthoritativeReviewProjectionV2 } from '../../storage/authoritative-review-state';
import { ProjectionCorruptionError } from '../../storage/authoritative-review-state';
import type { AuthoritativeTaskIndexV1 } from '../../storage/authoritative-task-index';
import type { AuthoritativeTaskDeletionV2 } from '../../storage/authoritative-task-deletion';
import type { AuthoritativeReviewExecutionEligibilityV1 } from '../../../shared/authoritative-review-v2';
import type { BlobRefV2, WorkItemKindV2, FailedTaskRecoverySummaryV2 } from '../../../shared/authoritative-review-v2';
import type { AuthoritativeWakeupIndexV1, WakeupRowV2 } from './wakeup-index';
import { TaskLifecycleServiceV2, TaskLifecycleError } from './task-lifecycle';
import { WorkItemCoordinatorV2, type CoordinatorCommittedEventV2 } from './work-item-coordinator';
import { failedRecoverySummary } from './task-lifecycle';

/** The frozen recovery policy version (spec §10.4 first release). */
export const RECOVERY_POLICY_VERSION = 'auto_continue_v1' as const;

/** The STABLE recovery operation id of one observed tail (spec §10.4). */
export function recoveryOperationId(taskId: string, observedTailCommitId: string): string {
  return `rec-${createHash('sha256')
    .update(canonicalJson({ taskId, observedTailCommitId, recoveryPolicyVersion: RECOVERY_POLICY_VERSION }), 'utf8')
    .digest('hex')
    .slice(0, 32)}`;
}

export interface StartupRecoveryDependenciesV2 {
  index: AuthoritativeTaskIndexV1;
  deletion: AuthoritativeTaskDeletionV2;
  wakeups: AuthoritativeWakeupIndexV1;
  /**
   * Tasks whose startup-only domain reconciliation already failed closed.
   * Their disposable wakeups must stay removed for this boot; retrying the
   * same corrupt task in the generic scan would reintroduce an executable
   * surface and could make one bad task block or churn the installation.
   */
  skipTaskIds?: ReadonlySet<string>;
  lifecycle: TaskLifecycleServiceV2;
  coordinator: WorkItemCoordinatorV2;
  facade: AuthoritativeAppendFacadeV2;
  checkpointStore: AuthoritativeReviewCheckpointStore;
  resolver: (taskId: string, ref: BlobRefV2) => Promise<unknown> | unknown;
  tail(taskId: string): Promise<{ lastSequence: number; lastCommitId: string | null }>;
  committedOperation(taskId: string, operationId: string): Promise<CoordinatorCommittedEventV2[] | null>;
  clock(): string;
  /** The CURRENT (non-authoritative) eligibility gate (spec §4.3). */
  eligibility(frozenProfileDigest: string): AuthoritativeReviewExecutionEligibilityV1;
  frozenProfileDigest(taskId: string): Promise<string>;
}

async function eligibilityBlockedFor(deps: StartupRecoveryDependenciesV2, taskId: string): Promise<boolean> {
  try {
    const digest = await deps.frozenProfileDigest(taskId);
    return deps.eligibility(digest).state !== 'eligible';
  } catch {
    return true;
  }
}

export interface StartupRecoveryResultV2 {
  reclaimed: string[];
  requeued: string[];
  failedWithoutWork: string[];
  wakeupsRepaired: string[];
  dormantKept: string[];
  /** Eligibility-blocked tasks whose wakeups were retained (no commits). */
  blocked: string[];
  skipped: string[];
}

/**
 * The deterministic startup scan (spec §10.4). Idempotent per observed tail:
 * every compensation reuses the SAME recovery operation id, so a second scan
 * (or a crash between compensation and response) replays the same commit.
 * ALL mutations flow through the lifecycle/coordinator (facade-only appends).
 */
export async function runStartupRecoveryV2(deps: StartupRecoveryDependenciesV2): Promise<StartupRecoveryResultV2> {
  const result: StartupRecoveryResultV2 = {
    reclaimed: [],
    requeued: [],
    failedWithoutWork: [],
    wakeupsRepaired: [],
    dormantKept: [],
    blocked: [],
    skipped: [],
  };
  for (const row of await deps.index.v2Rows()) {
    if (row.state !== 'active') continue;
    const taskId = row.taskId;
    if (deps.skipTaskIds?.has(taskId)) {
      await deps.wakeups.removeTask(taskId);
      result.skipped.push(taskId);
      continue;
    }
    if (await deps.deletion.isDeleted(taskId)) {
      result.skipped.push(taskId);
      continue;
    }
    // The observed tail changes the recovery identity: a NEW tail means a NEW
    // legal recovery id — reproject before acting.
    const tail = await deps.tail(taskId);
    let projection: AuthoritativeReviewProjectionV2;
    try {
      projection = (await deps.checkpointStore.readState(taskId, (ref) => deps.resolver(taskId, ref))).projection;
    } catch (error) {
      if (error instanceof ProjectionCorruptionError) {
        // A corrupt v2 history is never auto-compensated: disposable wakeups
        // are dropped and the task stays corrupt for manual diagnosis.
        await deps.wakeups.removeTask(taskId);
        result.skipped.push(taskId);
        continue;
      }
      throw error;
    }
    const operationId = recoveryOperationId(taskId, tail.lastCommitId ?? '');
    const status = projection.taskStatus;
    const workItems = Object.values(projection.workItems);
    const live = workItems.filter(
      (wi) => wi.state !== 'completed' && wi.state !== 'superseded' && wi.state !== 'terminal_failed',
    );

    // Terminal states: no claim, remove disposable wakeups.
    if (status === 'failed' || status === 'completed') {
      await deps.wakeups.removeTask(taskId);
      result.skipped.push(taskId);
      continue;
    }
    // Suspension overlay: keep underlying timers DORMANT — never claim,
    // never requeue; resume reactivates them without loss.
    if (projection.suspension !== null) {
      const rows = await deps.wakeups.read(taskId);
      if (rows.some((r) => !r.dormant)) {
        await deps.wakeups.write(taskId, rows.map((r) => ({ ...r, dormant: true })));
      }
      result.dormantKept.push(taskId);
      continue;
    }
    // waiting_human: the pending question derives from opened/delivered
    // events; neither claim nor answer synthesis happens here.
    if (status === 'waiting_human') {
      await deps.wakeups.remove(taskId, 'lease_expiry', null);
      result.skipped.push(taskId);
      continue;
    }
    if (status !== 'running') {
      result.skipped.push(taskId);
      continue;
    }
    // Eligibility is computed BEFORE any running-branch mutation (review
    // A-F2): a blocked deployment (A→B/disabled) must not commit requeues,
    // reclaims or failure compensations — the durable wakeups stay (marked
    // eligibilityBlocked) and the deterministic scan re-runs the SAME
    // compensations once the exact profile becomes eligible. Boot must never
    // throw AUTHORITATIVE_REVIEW_UNAVAILABLE.
    const blocked = await eligibilityBlockedFor(deps, taskId);
    if (blocked) {
      // Groom ONLY the disposable wakeup rows (pure index writes): every
      // due/ready surface is retained with the blocked flag set.
      for (const wi of workItems.filter((work) => work.state === 'retryable_failed')) {
        await deps.wakeups.upsert(taskId, {
          kind: 'retry_due',
          at: wi.retryNotBefore ?? deps.clock(),
          dormant: false,
          workItemId: wi.workItemId,
          operationId,
          eligibilityBlocked: true,
        });
      }
      const ready = workItems.filter((wi) => wi.state === 'ready');
      if (ready.length > 0) {
        await deps.wakeups.upsert(taskId, {
          kind: 'runnable',
          at: null,
          dormant: false,
          workItemId: ready[0]?.workItemId ?? null,
          operationId,
          eligibilityBlocked: true,
        });
      }
      result.blocked.push(taskId);
      continue;
    }
    // Running + leased: atomically abandon + reclaim (crash_recovery) with
    // the stable recovery id, then a runnable wakeup.
    if (projection.activeLease !== null) {
      const leasedWi = projection.workItems[projection.activeLease.workItemId];
      if (leasedWi !== undefined && leasedWi.state === 'leased') {
        await deps.lifecycle.reclaimLeaseV2(taskId, {
          operationId,
          workItemId: leasedWi.workItemId,
          reason: 'crash_recovery',
        });
        result.reclaimed.push(taskId);
      }
    }
    // Running + no non-terminal workitem: atomically fail with
    // RUNNING_WITHOUT_WORK (never remain falsely running).
    if (live.length === 0 && workItems.length > 0) {
      await failRunningWithoutWork(deps, taskId, operationId, projection);
      result.failedWithoutWork.push(taskId);
      continue;
    }
    // Retryable failures: before due -> repair the durable timer; at/after
    // due -> requeue with the recovery id.
    const retryable = workItems.filter((wi) => wi.state === 'retryable_failed');
    for (const wi of retryable) {
      if (wi.retryNotBefore !== null && deps.clock() < wi.retryNotBefore) {
        // Not due: the durable timer is repaired; no runnable row exists yet,
        // so a stale claim-able row from a previous state is dropped.
        await deps.wakeups.upsert(taskId, {
          kind: 'retry_due',
          at: wi.retryNotBefore,
          dormant: false,
          workItemId: wi.workItemId,
          operationId,
          eligibilityBlocked: false,
        });
        await deps.wakeups.remove(taskId, 'runnable', wi.workItemId);
        result.wakeupsRepaired.push(taskId);
      } else {
        await deps.lifecycle.requeueDueV2(taskId, { operationId, workItemId: wi.workItemId });
        await deps.wakeups.remove(taskId, 'retry_due', wi.workItemId);
        result.requeued.push(taskId);
      }
    }
    // Ready workitems (including after a requeue): repair the runnable wakeup.
    const ready = workItems.filter((wi) => wi.state === 'ready');
    if (ready.length > 0) {
      await deps.wakeups.upsert(taskId, {
        kind: 'runnable',
        at: null,
        dormant: false,
        workItemId: ready[0]?.workItemId ?? null,
        operationId: operationId,
        eligibilityBlocked: false,
      });
      result.wakeupsRepaired.push(taskId);
    }
  }
  return result;
}

/**
 * The RUNNING_WITHOUT_WORK compensation: ONE `structured_task_failed_v2` with
 * a reconstructible rebuild_missing_work recovery payload (spec §10.4 row).
 * The failing workitem is the terminal one the projector resolved (the
 * terminal attempt identity is read from the projection — never guessed).
 */
async function failRunningWithoutWork(
  deps: StartupRecoveryDependenciesV2,
  taskId: string,
  operationId: string,
  projection: AuthoritativeReviewProjectionV2,
): Promise<void> {
  // The single terminal-failed workitem (all-terminal state).
  const terminal = Object.values(projection.workItems).find((wi) => wi.state === 'terminal_failed');
  const wi = terminal ?? Object.values(projection.workItems)[0];
  if (wi === undefined) return;
  const attempt = Object.values(projection.attempts).find(
    (candidate) => candidate.workItemId === wi.workItemId,
  );
  const payloadRef = wi.payloadRef;
  const recoveryPayloadValue = {
    kind: 'rebuild_missing_work',
    predecessorResultRef: payloadRef,
    expectedSuccessorKind: wi.kind,
    expectedSuccessorPayloadRef: payloadRef,
    authorityBaseRef: wi.authorityBaseRef,
    grantSpecInputRef: wi.grantSpecRef,
  };
  const failureRecoveryPayloadRef = await deps.facade.prepareBlob(taskId, 'failure_recovery_payload', recoveryPayloadValue);
  const payload = {
    family: 'lease_or_retry' as const,
    operationId,
    taskId,
    workItemId: wi.workItemId,
    leaseEpoch: wi.leaseEpoch,
    eventBuilder: 'task_terminal_failed' as const,
    authorityBaseRef: wi.authorityBaseRef,
    kind: wi.kind as WorkItemKindV2,
    roleBinding: wi.roleBinding,
    agentExecutionKind: wi.agentExecutionKind,
    sessionKind: wi.sessionKind,
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
    expectedLastSequence: null,
    attemptFamily: attempt?.family ?? 'command',
    attemptId: attempt?.family === 'command' ? null : (attempt?.attemptId ?? null),
    commandId: attempt?.family === 'command' ? (attempt?.attemptId ?? null) : null,
    agentId: attempt?.agentId ?? null,
    commandKind: (attempt?.commandKind as Extract<PublicationOperationPayloadImport, { family: 'lease_or_retry' }>['commandKind']) ?? null,
    dispatchRef: null,
    grantInstanceRef: null,
    reason: null,
    failureCode: 'RUNNING_WITHOUT_WORK',
    failureDigest: canonicalSha256Hex({ kind: 'running_without_work', workItemId: wi.workItemId }),
    retryOrdinal: null,
    retryNotBefore: null,
    validatorAggregateRef: null,
    budgetPolicyDigest: null,
    failureRecoveryPayloadRef,
    taskFailure: true,
    resultRefs: [],
  } as Extract<PublicationOperationPayloadImport, { family: 'lease_or_retry' }>;
  const tail = await deps.tail(taskId);
  await deps.facade.publishWithPin({
    taskId,
    operationId,
    payload,
    intent: { handlerKind: 'task_terminal_failed', handlerVersion: 1 },
    preparedRefs: [wi.authorityBaseRef, failureRecoveryPayloadRef],
    expectedTailSequence: tail.lastSequence,
    expectedTailCommitId: tail.lastCommitId,
  });
  await deps.wakeups.removeTask(taskId);
}

/** The stable failure summary re-export (CoreService/list consumption). */
export function recoverySummaryOf(state: AuthoritativeReviewProjectionV2): FailedTaskRecoverySummaryV2 | null {
  return failedRecoverySummary(state);
}

type PublicationOperationPayloadImport = import('../../authoritative-review/authority-types').PublicationOperationPayloadV2;
