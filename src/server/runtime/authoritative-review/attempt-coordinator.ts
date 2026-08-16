/**
 * Task 12 attempt coordinator (design §17.2/§17.5, spec §9.2/§10.2): the
 * lease -> execute -> complete loop over the Task 10 WorkItem coordinator and
 * the Task 12 session runner / SystemCommand allowlist.
 *
 * The v2 scheduler (`AuthoritativeV2SchedulingEngine.runPass`) MUTATION-DRIVEN
 * pass leases ONE workitem per task (spec §10.2 `maxActiveLeasesPerTask = 1`)
 * and returns `result.leased`. This module owns the EXECUTION side: it
 * consumes the already-leased AssignmentDispatch (§9.2 — a leased workitem
 * always carries its dispatch/input and exactly one of a structured Agent, a
 * generic Agent or a SystemCommand start; illegal cross-kind fields fail at
 * the projection/validator), runs the session, and commits the terminal
 * atomically:
 *
 * - success: [attempt/command completed, work_item_completed] in ONE batch
 *   (the registered `work_item_completed` builder);
 * - retryable failure: attempt/command retryable_failed + work_item
 *   retryable_failed in ONE batch (the `work_item_retryable_failed` builder),
 *   with the durable `retry_due` wakeup persisted here (Task 11 handoff);
 * - permanent failure: the terminal-failure envelope via the injected
 *   terminal-fail seam (attempt/command terminal_failed + work_item
 *   terminal_failed + optional structured_task_failed_v2 in ONE batch);
 * - provider abort: record NOTHING (spec §7.2 never guesses unconfirmed
 *   outcomes) and leave the lease to the scheduler's expiry reclaim;
 * - attempt timeout: a retryable failure `ATTEMPT_TIMEOUT` (spec §12 timeout
 *   becomes a durable infrastructure failure).
 *
 * Response-loss idempotency: every continuation commit uses a deterministic
 * operation id derived from (task, workitem, attempt, step), so retransmission
 * replays the ORIGINAL commit. Old-epoch late calls are rejected by the
 * coordinator's `demandLeased` + base-match path with NO partial write.
 *
 * Namespace isolation (spec §10.2, design §9, §16.3): every Agent attempt
 * materializes a unique conversation namespace
 * `<executionKind>/<roleBinding>/<workItemId>/<attemptId>` and the runner
 * receives ONLY the current assignment + a bounded committed checkpoint as
 * prompt context — never raw prior conversation/human messages aggregated by
 * Agent ID, and reviewer sessions never see orchestrator/generator history.
 * Only PUBLIC trace (public text + public tool-call steps) is persisted; raw
 * private drafts/journals never enter attempt history.
 *
 * V1 byte-for-byte: `runStructuredNext`, pi-agent-runtime and action-committer
 * v1 behavior is unchanged; the v2 runner entry is additive and branch-selected
 * by the frozen protocol.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../structured-slots/canonical-json';
import type { FrozenAgentConfig, FrozenTemplate } from '../../template/template-schema';
import { structuredProtocolOf } from '../../../shared/authoritative-review-v2';
import type { TraceStore } from '../../storage/trace-store';
import type { AuthoritativeWakeupIndexV1 } from './wakeup-index';
import type { AttemptExecutionKindV2, LeasedWorkV2, RecordRetryableFailureInputV2, SystemCommandKindV2, WorkItemCoordinatorV2 } from './work-item-coordinator';
import { CoordinatorError } from './work-item-coordinator';
import type { AuthoritativeReviewProjectionV2 } from '../../storage/authoritative-review-state';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { V2SessionOutcome } from './assignment-runner';
import type { V2AssignmentRunner } from './assignment-runner';
import { SystemCommandRegistry, type SystemCommandOutcome } from './system-command-registry';
import { RuntimeAbortedError } from '../agent-runtime';

/** Stable coordinator error codes re-exported for the attempt surface. */
export type AttemptErrorCodeV2 =
  | 'TASK_CORRUPT'
  | 'OPERATION_CONFLICT'
  | 'WORK_ITEM_NOT_LEASED'
  | 'WORK_ITEM_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'STALE_TAIL'
  | 'STALE_AUTHORITY_BASE'
  | 'PROTOCOL_NOT_V2'
  | 'COMMAND_NOT_REGISTERED'
  | 'AGENT_NOT_DECLARED';

/** Typed attempt-coordinator error (stable public surface). */
export class AttemptError extends Error {
  readonly code: AttemptErrorCodeV2;

  constructor(code: AttemptErrorCodeV2, message: string) {
    super(message);
    this.name = 'AttemptError';
    this.code = code;
  }
}

/** Deterministic continuation operation id of one attempt step (replay-safe). */
export function attemptContinuationOperationId(
  taskId: string,
  workItemId: string,
  attemptId: string,
  step: 'complete' | 'retryable' | 'terminal',
): string {
  const digest = createHash('sha256')
    .update(canonicalJson({ taskId, workItemId, attemptId, step }), 'utf8')
    .digest('hex');
  return `at-${digest.slice(0, 32)}`;
}

/** Deterministic lease operation id of a self-contained `runNext` claim. */
export function attemptLeaseOperationId(taskId: string, tailKey: string, workerId: string): string {
  const digest = createHash('sha256')
    .update(canonicalJson({ taskId, tailKey, workerId, label: 'v2_attempt_lease' }), 'utf8')
    .digest('hex');
  return `ls-${digest.slice(0, 32)}`;
}

/** Deterministic failure digest of a retryable attempt failure (replay-safe). */
export function attemptFailureDigest(
  workItemId: string,
  attemptId: string,
  failureCode: string,
  leaseEpoch: number,
): string {
  return createHash('sha256')
    .update(canonicalJson({ workItemId, attemptId, failureCode, leaseEpoch }), 'utf8')
    .digest('hex');
}

/**
 * Spec §10.2 / design §9: the unique conversation namespace of one Agent
 * attempt. Two WorkItems for the same Agent ID never share it, so the runner
 * can never inject the prior workitem's raw conversation/human messages.
 */
export function deriveV2ConversationNamespace(
  executionKind: AttemptExecutionKindV2,
  roleBinding: string | null,
  workItemId: string,
  attemptId: string,
): string {
  return `${executionKind}/${roleBinding ?? 'system'}/${workItemId}/${attemptId}`;
}

/** The bounded per-attempt context the runner and tools consume. */
export interface V2AttemptContext {
  taskId: string;
  workItemId: string;
  attemptId: string;
  leaseEpoch: number;
  /** `<executionKind>/<roleBinding>/<workItemId>/<attemptId>` (§10.2). */
  namespace: string;
  agentId: string;
  roleBinding: string | null;
  executionKind: AttemptExecutionKindV2;
  sessionKind: string | null;
  /**
   * The COMMITTED AssignmentDispatch blob ref of the active lease (from the
   * lease result). Task 13's tool-factory resolves/verifies the real blob —
   * this layer never fabricates a dispatch identity. Null when the lease
   * result is unavailable on the execute path (the scheduler pre-claimed);
   * Task 13 resolves it from the committed `structured_assignment_dispatched`
   * event by attempt identity.
   */
  dispatchRef: BlobRefV2 | null;
  authorityBaseRef: BlobRefV2;
  grantInstanceRef: BlobRefV2 | null;
  inputArtifactDeliveryId: string | null;
  /** Resolved frozen agent of the role binding (null for system commands). */
  agent: FrozenAgentConfig | null;
  /** Bounded public display of the current assignment (never private drafts). */
  currentAssignmentText: string;
  /** Bounded digest-bound committed checkpoint summary ('' when none yet). */
  committedCheckpointText: string;
}

/** One terminal outcome of a v2 attempt step. */
export type V2AttemptOutcome =
  | { kind: 'idle' }
  | {
      kind: 'completed';
      workItemId: string;
      leaseEpoch: number;
      attemptFamily: AttemptExecutionKindV2;
      attemptId: string | null;
      commandId: string | null;
      replayed: boolean;
    }
  | {
      kind: 'retryable_failed';
      workItemId: string;
      failureCode: string;
      retryOrdinal: number;
      retryNotBefore: string;
    }
  | {
      kind: 'terminal_failed';
      workItemId: string;
      failureCode: string;
    }
  | {
      kind: 'parked';
      workItemId: string;
      failureCode: string;
      retryOrdinal: number;
    }
  | { kind: 'aborted'; workItemId: string; message: string };

/** Terminal-failure seam input (mirrors TaskLifecycleServiceV2.terminalFailWorkItem). */
export interface TerminalFailInputV2 {
  operationId: string;
  workItemId: string;
  failureCode: string;
  failureDigest: string;
  failureRecoveryPayloadRef: BlobRefV2 | null;
  taskFailure: boolean;
  /** Task 12 I-1: the attempt/command identity the caller holds. */
  attemptId?: string | null;
  commandId?: string | null;
}

export interface V2AttemptCoordinatorDependencies {
  coordinator: WorkItemCoordinatorV2;
  /** The v2 session runner (structured + generic Agent turns). */
  runner: V2AssignmentRunner;
  /** The closed SystemCommand allowlist (default NOT_IMPLEMENTED doubles). */
  systemCommands?: SystemCommandRegistry;
  /** Resolves the frozen agent of a role binding (null when system). */
  agentForRole(taskId: string, roleBinding: string | null): Promise<FrozenAgentConfig | null>;
  /** Resolves the frozen template (the runner entry verifies the v2 protocol). */
  frozenFor(taskId: string): Promise<FrozenTemplate>;
  /** Durable wakeup index: persists the retry_due wakeup created here. */
  wakeups: AuthoritativeWakeupIndexV1;
  /** Best-effort PUBLIC trace persistence (never private drafts). */
  traces?: TraceStore;
  clock(): string;
  /** Attempt timeout (default 10 min); a fired timeout records ATTEMPT_TIMEOUT. */
  attemptTimeoutMs?: number;
  /** Terminal-failure envelope seam (defaults to the lifecycle's terminalFailWorkItem). */
  terminalFail?(taskId: string, input: TerminalFailInputV2): Promise<void>;
  log?(line: string): void;
}

/** The v2 scheduler pass result's leased entries (structural view). */
export interface V2LeasedEntryV2 {
  taskId: string;
  workItemId: string;
}

/** Result of the periodic driver tick (scheduling pass + executed leases). */
export interface V2SchedulingTickResult {
  pass: unknown;
  outcomes: V2AttemptOutcome[];
}

/**
 * The periodic driver the mutation-driven v2 scheduler needs (Task 11 handoff,
 * A-M7): one call runs the deterministic scheduling pass (reclaim/requeue/lease
 * ONE workitem per task) and then EXECUTES every freshly leased workitem. The
 * v1 scheduler loop is never touched — this is an additive exported seam.
 */
export async function runV2SchedulingTick(deps: {
  scheduling: { runPass(now?: string): Promise<{ leased: V2LeasedEntryV2[] }> };
  attempts: Pick<V2AttemptCoordinator, 'executeLeased'>;
  clock?: () => string;
}): Promise<V2SchedulingTickResult> {
  const now = deps.clock?.() ?? new Date().toISOString();
  const pass = await deps.scheduling.runPass(now);
  const outcomes: V2AttemptOutcome[] = [];
  for (const leased of pass.leased) {
    outcomes.push(await deps.attempts.executeLeased(leased.taskId));
  }
  return { pass, outcomes };
}

/** Maps a coordinator failure onto the stable attempt surface. */
function mapAttemptError(error: unknown): never {
  if (error instanceof AttemptError) throw error;
  if (error instanceof CoordinatorError) {
    const code = error.code;
    const mapped: AttemptErrorCodeV2 =
      code === 'TASK_CORRUPT'
        ? 'TASK_CORRUPT'
        : code === 'WORK_ITEM_NOT_LEASED'
          ? 'WORK_ITEM_NOT_LEASED'
          : code === 'WORK_ITEM_NOT_FOUND'
            ? 'WORK_ITEM_NOT_FOUND'
            : code === 'OPERATION_CONFLICT'
              ? 'OPERATION_CONFLICT'
              : code === 'STALE_TAIL'
                ? 'STALE_TAIL'
                : code === 'STALE_AUTHORITY_BASE'
                  ? 'STALE_AUTHORITY_BASE'
                  : 'INVALID_INPUT';
    throw new AttemptError(mapped, error.message);
  }
  throw error;
}

export class V2AttemptCoordinator {
  private readonly deps: V2AttemptCoordinatorDependencies;

  private readonly systemCommands: SystemCommandRegistry;

  private readonly attemptTimeoutMs: number;

  constructor(deps: V2AttemptCoordinatorDependencies) {
    this.deps = deps;
    this.systemCommands = deps.systemCommands ?? new SystemCommandRegistry();
    this.attemptTimeoutMs = deps.attemptTimeoutMs ?? 10 * 60 * 1000;
  }

  /* ---------------- runner entry ---------------- */

  /**
   * The v2 runner entry (spec §4.4): verifies the frozen protocol is v2, then
   * leases ONE workitem and executes it. `workerId` is the claiming worker
   * (for generic/submitter workitems it MUST be the bound Agent ID — the
   * projector requires genericEvent.agentId === leaseOwner). Returns idle when
   * nothing is claimable.
   */
  async runNext(taskId: string, workerId: string, schedulerSignal?: AbortSignal): Promise<V2AttemptOutcome> {
    const frozen = await this.deps.frozenFor(taskId);
    if (structuredProtocolOf(frozen) !== 'v2') {
      throw new AttemptError('PROTOCOL_NOT_V2', `task '${taskId}' does not use the v2 structured protocol`);
    }
    const state = await this.readProjection(taskId);
    if (state.activeLease !== null || state.suspension !== null || state.taskStatus !== 'running') {
      return { kind: 'idle' };
    }
    const leased = await this.leaseNext(taskId, workerId, state);
    if (leased === null) return { kind: 'idle' };
    // The self-contained claim persists its OWN lease_expiry wakeup (the
    // scheduler persists the ones IT creates). M-7: a live wakeup-write
    // failure FAILS LOUD and propagates — the lease is already committed, so
    // the caller's retry replays the lease (response-loss) and re-attempts the
    // upsert. A hard crash between the lease commit and this upsert is covered
    // by startup recovery (the scan repairs lost lease_expiry rows); the M-8
    // lease-expiry composite term aborts a session running past the lease.
    await this.deps.wakeups.upsert(taskId, {
      kind: 'lease_expiry',
      at: leased.wakeup.at,
      dormant: false,
      workItemId: leased.workItemId,
      operationId: attemptLeaseOperationId(taskId, String(state.lastSequence), workerId),
      eligibilityBlocked: false,
    });
    return this.executeLeased(taskId, schedulerSignal, { dispatchRef: leased.dispatchRef });
  }

  /** The lease step: claim the deterministic next ready workitem (spec §10.2). */
  private async leaseNext(taskId: string, workerId: string, state: AuthoritativeReviewProjectionV2): Promise<LeasedWorkV2 | null> {
    try {
      return await this.deps.coordinator.leaseNext(
        taskId,
        workerId,
        attemptLeaseOperationId(taskId, String(state.lastSequence), workerId),
      );
    } catch (error) {
      mapAttemptError(error);
    }
  }

  /* ---------------- execute ---------------- */

  /**
   * Executes the CURRENTLY leased workitem (the scheduler already claimed it)
   * and commits the terminal atomically. No claim happens here — the lease was
   * made by the scheduling pass (`runPass`), so `maxActiveLeasesPerTask = 1`
   * holds. Idle when no lease is active. `leaseInfo` carries the committed
   * dispatchRef of the claim (available on the self-contained `runNext` path;
   * null on the scheduler path — Task 13 resolves it from the committed
   * dispatch event by attempt identity).
   */
  async executeLeased(
    taskId: string,
    schedulerSignal?: AbortSignal,
    leaseInfo?: { dispatchRef: BlobRefV2 | null },
  ): Promise<V2AttemptOutcome> {
    const state = await this.readProjection(taskId);
    const lease = state.activeLease;
    if (lease === null) return { kind: 'idle' };
    const wi = state.workItems[lease.workItemId];
    if (wi === undefined) {
      throw new AttemptError('WORK_ITEM_NOT_FOUND', `no workitem '${lease.workItemId}'`);
    }
    const attempt =
      lease.attemptId !== null ? (state.attempts[lease.attemptId] ?? null) : null;
    const command =
      lease.commandId !== null ? (state.attempts[lease.commandId] ?? null) : null;
    const family: AttemptExecutionKindV2 =
      command !== null ? 'command' : attempt?.family ?? (lease.attemptId !== null ? 'structured' : 'command');
    const attemptId = lease.attemptId ?? lease.commandId;
    if (attemptId === null) {
      throw new AttemptError('INVALID_INPUT', `lease of '${lease.workItemId}' has no bound attempt/command`);
    }
    const baseRef = wi.leaseBases[String(wi.leaseEpoch)] ?? wi.authorityBaseRef;

    // Build the bounded attempt context (§10.2 namespace + current assignment).
    const ctx = await this.buildContext(taskId, wi, lease, family, attemptId, baseRef, leaseInfo?.dispatchRef ?? null);
    const signal = this.compositeSignal(schedulerSignal, wi.leaseExpiresAt);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      signal.controller.abort();
    }, this.attemptTimeoutMs);

    try {
      if (family === 'command') {
        return await this.executeCommand(taskId, wi.workItemId, attemptId, signal.controller.signal, baseRef);
      }
      const outcome = await this.deps.runner.runSession(ctx, signal.controller.signal);
      return await this.commitSessionOutcome(taskId, wi.workItemId, attemptId, outcome, ctx);
    } catch (error) {
      if (error instanceof RuntimeAbortedError) {
        // Provider/attempt abort: record NOTHING (spec §7.2) and leave the
        // lease ACTIVE — the scheduler reclaims it on lease expiry via the
        // durable lease_expiry wakeup (kept in place). If OUR timeout fired,
        // record a durable retryable failure instead (spec §12 timeout).
        if (timedOut) {
          return this.recordRetryable(
            taskId,
            wi.workItemId,
            family === 'command' ? { commandId: attemptId } : { attemptId },
            'ATTEMPT_TIMEOUT',
            ctx,
          );
        }
        return { kind: 'aborted', workItemId: wi.workItemId, message: error.message };
      }
      mapAttemptError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Composite attempt signal: the scheduler stop ∪ our timeout controller ∪
   * LEASE EXPIRY (M-8). The lease-expiry term aborts a session that runs past
   * its lease (even when the timeout is longer or the provider ignores the
   * abort), so the scheduler's reclaim never races a live session; the I-1
   * commit-time identity check is the correctness backstop regardless.
   */
  private compositeSignal(
    schedulerSignal?: AbortSignal,
    leaseExpiresAt?: string | null,
  ): { controller: AbortController; signal: AbortSignal } {
    const controller = new AbortController();
    if (schedulerSignal !== undefined && schedulerSignal.aborted) {
      controller.abort();
    } else if (schedulerSignal !== undefined) {
      schedulerSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    if (leaseExpiresAt !== undefined && leaseExpiresAt !== null) {
      const remaining = Date.parse(leaseExpiresAt) - Date.parse(this.deps.clock());
      if (Number.isFinite(remaining) && remaining <= 0) {
        controller.abort();
      } else if (Number.isFinite(remaining)) {
        const leaseTimer = setTimeout(() => controller.abort(), remaining);
        controller.signal.addEventListener('abort', () => clearTimeout(leaseTimer), { once: true });
      }
    }
    return { controller, signal: controller.signal };
  }

  /* ---------------- command dispatch ---------------- */

  private async executeCommand(
    taskId: string,
    workItemId: string,
    commandId: string,
    signal: AbortSignal,
    baseRef: BlobRefV2,
  ): Promise<V2AttemptOutcome> {
    if (signal.aborted) {
      throw new RuntimeAbortedError(`command ${commandId} aborted before it started`);
    }
    const state = await this.readProjection(taskId);
    const command = state.attempts[commandId];
    if (command === undefined || command.state !== 'started') {
      throw new AttemptError('INVALID_INPUT', `command '${commandId}' is not started`);
    }
    const kind = command.commandKind as SystemCommandKindV2 | null;
    if (kind === null) {
      throw new AttemptError('INVALID_INPUT', `command '${commandId}' carries no commandKind`);
    }
    const handler = this.systemCommands.resolve(kind);
    if (handler === null) {
      // Fail-closed: an unknown commandKind must never silently run the wrong
      // handler (spec §10.2 six closed kinds).
      throw new AttemptError('COMMAND_NOT_REGISTERED', `no SystemCommand handler for '${kind}'`);
    }
    const wi = state.workItems[workItemId];
    const outcome = await handler.execute({
      taskId,
      commandId,
      workItemId,
      commandKind: kind,
      leaseEpoch: command.leaseEpoch,
      authorityBaseRef: baseRef,
      payloadRef: wi?.payloadRef,
    });
    return this.commitCommandOutcome(taskId, workItemId, commandId, outcome);
  }

  private async commitCommandOutcome(
    taskId: string,
    workItemId: string,
    commandId: string,
    outcome: SystemCommandOutcome,
  ): Promise<V2AttemptOutcome> {
    switch (outcome.kind) {
      case 'completed':
        return this.completeWorkItem(taskId, workItemId, { commandId }, outcome.resultRefs);
      case 'retryable_failure':
        return this.recordRetryable(
          taskId,
          workItemId,
          { commandId },
          outcome.failureCode,
          null,
          outcome.failureDigest,
          outcome.retryNotBefore,
          outcome.validatorAggregateRef ?? null,
        );
      case 'terminal_failure':
        return this.terminalFail(taskId, workItemId, { commandId }, outcome.failureCode, outcome.failureDigest, outcome.taskFailure);
    }
  }

  /* ---------------- session outcome commit ---------------- */

  private async commitSessionOutcome(
    taskId: string,
    workItemId: string,
    attemptId: string,
    outcome: V2SessionOutcome,
    ctx: V2AttemptContext,
  ): Promise<V2AttemptOutcome> {
    let committed: V2AttemptOutcome;
    switch (outcome.kind) {
      case 'committed':
        committed = await this.completeWorkItem(taskId, workItemId, { attemptId }, outcome.resultRefs);
        break;
      case 'retryable_failure':
        committed = await this.recordRetryable(taskId, workItemId, { attemptId }, outcome.failureCode, ctx);
        break;
      case 'terminal_failure':
        committed = await this.terminalFail(
          taskId,
          workItemId,
          { attemptId },
          outcome.failureCode,
          attemptFailureDigest(workItemId, attemptId, outcome.failureCode, ctx.leaseEpoch),
          false,
        );
        break;
    }
    // M-1: persist the PUBLIC trace ONLY after the terminal commit SUCCEEDED.
    // A zero-writes rejection (stale-epoch/attempt mismatch, missing domain
    // result, concurrent reclaim) propagates as a throw before this line, so
    // the trace channel honors the same all-or-nothing rule as the events.
    if (committed.kind !== 'aborted') {
      await this.recordPublicTrace(taskId, workItemId, attemptId, outcome);
    }
    return committed;
  }

  /* ---------------- terminal commits ---------------- */

  /**
   * ONE batch [attempt/command completed, work_item_completed] (§9.2) with the
   * I-1 caller identity and the I-2 §9.2 domain result carrier. Gated kinds
   * (structured agent sessions + system commands) MUST fold non-empty
   * `resultRefs`; the coordinator rejects a bare completion with ZERO writes.
   */
  private async completeWorkItem(
    taskId: string,
    workItemId: string,
    identity: { attemptId: string } | { commandId: string },
    resultRefs: readonly BlobRefV2[],
  ): Promise<V2AttemptOutcome> {
    const attemptId = 'attemptId' in identity ? identity.attemptId : identity.commandId;
    const operationId = attemptContinuationOperationId(taskId, workItemId, attemptId, 'complete');
    try {
      const completed = await this.deps.coordinator.completeWorkItem({
        taskId,
        operationId,
        workItemId,
        attemptId: 'attemptId' in identity ? identity.attemptId : null,
        commandId: 'commandId' in identity ? identity.commandId : null,
        resultRefs,
      });
      await this.removeLeaseWakeup(taskId, workItemId);
      return {
        kind: 'completed',
        workItemId: completed.workItemId,
        leaseEpoch: completed.leaseEpoch,
        attemptFamily: completed.attemptFamily,
        attemptId: completed.attemptId,
        commandId: completed.commandId,
        replayed: completed.replayed,
      };
    } catch (error) {
      mapAttemptError(error);
    }
  }

  /** ONE batch retryable failure + durable retry_due wakeup persistence. */
  private async recordRetryable(
    taskId: string,
    workItemId: string,
    identity: { attemptId: string } | { commandId: string },
    failureCode: string,
    ctx: V2AttemptContext | null,
    failureDigestOverride?: string,
    retryNotBeforeOverride?: string,
    validatorAggregateRef: BlobRefV2 | null = null,
  ): Promise<V2AttemptOutcome> {
    const attemptId = 'attemptId' in identity ? identity.attemptId : identity.commandId;
    const operationId = attemptContinuationOperationId(taskId, workItemId, attemptId, 'retryable');
    let failureDigest = failureDigestOverride;
    if (failureDigest === undefined) {
      failureDigest = attemptFailureDigest(workItemId, attemptId, failureCode, ctx?.leaseEpoch ?? 0);
    }
    try {
      const input: RecordRetryableFailureInputV2 = {
        taskId,
        operationId,
        workItemId,
        failureCode,
        failureDigest,
        attemptId: 'attemptId' in identity ? identity.attemptId : null,
        commandId: 'commandId' in identity ? identity.commandId : null,
        validatorAggregateRef,
      };
      if (retryNotBeforeOverride !== undefined) {
        input.retryNotBefore = retryNotBeforeOverride;
      }
      const recorded = await this.deps.coordinator.recordRetryableFailure(input);
      await this.removeLeaseWakeup(taskId, workItemId);
      if (recorded.mode === 'retryable') {
        // Task 11 handoff: the coordinator CREATES the retry_due wakeup result;
        // the attempt-coordinator PERSISTS it (the engine only consumes).
        await this.deps.wakeups.upsert(taskId, {
          kind: 'retry_due',
          at: recorded.wakeup.at,
          dormant: false,
          workItemId,
          operationId,
          eligibilityBlocked: false,
        });
        return {
          kind: 'retryable_failed',
          workItemId,
          failureCode,
          retryOrdinal: recorded.retryOrdinal,
          retryNotBefore: recorded.retryNotBefore,
        };
      }
      // Budget exhausted: parked with retry_budget_exhausted (no timer).
      return {
        kind: 'parked',
        workItemId,
        failureCode,
        retryOrdinal: recorded.retryOrdinal,
      };
    } catch (error) {
      mapAttemptError(error);
    }
  }

  /** Permanent failure: the terminal envelope via the injected seam. */
  private async terminalFail(
    taskId: string,
    workItemId: string,
    identity: { attemptId: string } | { commandId: string },
    failureCode: string,
    failureDigest: string,
    taskFailure: boolean,
  ): Promise<V2AttemptOutcome> {
    const attemptId = 'attemptId' in identity ? identity.attemptId : identity.commandId;
    const operationId = attemptContinuationOperationId(taskId, workItemId, attemptId, 'terminal');
    try {
      if (this.deps.terminalFail === undefined) {
        throw new AttemptError('INVALID_INPUT', 'no terminal-fail seam is wired');
      }
      await this.deps.terminalFail(taskId, {
        operationId,
        workItemId,
        failureCode,
        failureDigest,
        failureRecoveryPayloadRef: null,
        taskFailure,
        attemptId: 'attemptId' in identity ? identity.attemptId : null,
        commandId: 'commandId' in identity ? identity.commandId : null,
      });
      return { kind: 'terminal_failed', workItemId, failureCode };
    } catch (error) {
      mapAttemptError(error);
    }
  }

  /* ---------------- helpers ---------------- */

  private async readProjection(taskId: string): Promise<AuthoritativeReviewProjectionV2> {
    try {
      return await this.deps.coordinator.readProjectionState(taskId);
    } catch (error) {
      mapAttemptError(error);
    }
  }

  private async buildContext(
    taskId: string,
    wi: { workItemId: string; roleBinding: string | null; agentExecutionKind: 'structured_session' | 'generic_turn' | null; sessionKind: string | null; logicalAssignmentId: string | null; reviewAssignmentId: string | null; grantSpecRef: BlobRefV2 | null; inputArtifactDeliveryId: string | null; authorityBaseRef: BlobRefV2; payloadRef: BlobRefV2 },
    lease: { leaseEpoch: number; leaseOwner: string | null },
    family: AttemptExecutionKindV2,
    attemptId: string,
    baseRef: BlobRefV2,
    dispatchRef: BlobRefV2 | null,
  ): Promise<V2AttemptContext> {
    const isAgent = wi.agentExecutionKind !== null;
    const agent = isAgent ? await this.deps.agentForRole(taskId, wi.roleBinding) : null;
    if (isAgent && agent === null) {
      throw new AttemptError('AGENT_NOT_DECLARED', `no frozen agent for role '${String(wi.roleBinding)}'`);
    }
    return {
      taskId,
      workItemId: wi.workItemId,
      attemptId,
      leaseEpoch: lease.leaseEpoch,
      namespace: deriveV2ConversationNamespace(family, wi.roleBinding, wi.workItemId, attemptId),
      agentId: lease.leaseOwner ?? '',
      roleBinding: wi.roleBinding,
      executionKind: family,
      sessionKind: wi.sessionKind,
      // M-4: the COMMITTED dispatch blob ref (never a fabricated identity);
      // Task 13's tool-factory resolves/verifies it.
      dispatchRef,
      authorityBaseRef: baseRef,
      grantInstanceRef: null,
      inputArtifactDeliveryId: wi.inputArtifactDeliveryId,
      agent,
      currentAssignmentText: this.currentAssignmentText(wi),
      committedCheckpointText: '', // Task 13+ binds the digest-bound checkpoint
    };
  }

  /** Bounded PUBLIC display of the current assignment (never private drafts). */
  private currentAssignmentText(wi: {
    workItemId: string;
    logicalAssignmentId: string | null;
    reviewAssignmentId: string | null;
    sessionKind: string | null;
    agentExecutionKind: 'structured_session' | 'generic_turn' | null;
  }): string {
    return canonicalJson({
      workItemId: wi.workItemId,
      logicalAssignmentId: wi.logicalAssignmentId,
      reviewAssignmentId: wi.reviewAssignmentId,
      sessionKind: wi.sessionKind,
      executionKind: wi.agentExecutionKind,
    });
  }

  /** Best-effort PUBLIC trace persistence (display-only; never gates). */
  private async recordPublicTrace(
    taskId: string,
    workItemId: string,
    attemptId: string,
    outcome: V2SessionOutcome,
  ): Promise<void> {
    if (this.deps.traces === undefined) return;
    try {
      const turnId = `v2-${workItemId}-${attemptId}`;
      if (outcome.kind === 'committed') {
        await this.deps.traces.appendTurnTrace(taskId, turnId, outcome.trace);
      } else {
        // Phase-only failure record (zero entries) — public message only.
        await this.deps.traces.appendTurnTrace(taskId, turnId, [], {
          state: 'failed',
          dispatchAction: null,
          target: null,
          message: outcome.message,
        });
      }
    } catch {
      // Trace persistence is best-effort; isolation belongs to the store.
    }
  }

  private async removeLeaseWakeup(taskId: string, workItemId: string): Promise<void> {
    try {
      await this.deps.wakeups.remove(taskId, 'lease_expiry', workItemId);
      await this.deps.wakeups.remove(taskId, 'runnable', workItemId);
    } catch {
      // Wakeup cleanup is best-effort; the startup scan repairs stale rows.
    }
  }
}
