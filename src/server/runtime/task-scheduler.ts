/**
 * One-slot TaskScheduler (plan Phase C Task 4 Step 4; full lifecycle policy
 * completed in Task 5, spec §3.3/§6.3/§7).
 *
 * Process-wide exactly one task runs, and inside it the runner executes one
 * agent Turn at a time (the runner never recurses). `start` claims the single
 * slot SYNCHRONOUSLY — an immediate second start observes the conflict
 * deterministically — then validates the projected status, appends
 * `task_started` and loops `runner.runNext` until the task waits for a human,
 * completes, parks on a failure, is stopped or runs out of confirmed inputs;
 * the slot is released in `finally`. A busy slot rejects with the public
 * TASK_ALREADY_RUNNING conflict — never queues (plan Task 4 Step 4).
 *
 * Task 5 lifecycle policy:
 * - Automatic retry (spec §7.1): a retryable attempt failure is re-attempted
 *   on the SAME input node at most `MAX_AUTO_RETRIES` times with exponential
 *   delays (1 s → 2 s plus bounded jitter; tests inject a deterministic
 *   delay/sleep pair). Every scheduled delay is committed as a public
 *   `retry_scheduled` event. Once the budget is exhausted the runner records
 *   the failure as terminal and the loop parks the task in
 *   `retryable_failure`; permanent failures park immediately.
 * - Manual `retry` is valid only from `retryable_failure` and rebuilds the
 *   same input node/session history under a fresh retry budget.
 * - `answer` is valid only from `waiting_human`: it commits the human answer
 *   plus a fresh confirmed input for the requesting agent, then continues the
 *   loop (the agent's rebuilt public history carries the Q&A — the same
 *   continuing-session semantics, spec §6.3).
 * - No-progress guard (plan 2026-08-06): at the head of every loop iteration
 *   the scheduler evaluates committed progress since the last human answer;
 *   exceeding `PROGRESS_POLICY` commits one synthetic human request under the
 *   last dispatcher and parks the task in `waiting_human`, and the loop never
 *   runs a Turn while a human question is unanswered.
 * - `stop` bumps the run generation and aborts SYNCHRONOUSLY before any
 *   await, waits bounded disposal and appends `task_stopped`; a Turn whose
 *   result lands strictly after the abort commits nothing (spec §7.2).
 * - `recoverInterruptedTasks` (process restart, spec §7.2): every projected-
 *   active task that was actually started (`task_started`/`task_resumed`
 *   present) but carries no terminal event becomes `interrupted`; tasks that
 *   only hold confirmed inputs were never in flight and stay untouched.
 *   Corrupt and terminal tasks are never modified.
 * - Detached acceptance (`*Detached`): validates, claims, commits the
 *   lifecycle event and returns the accepted summary while the loop keeps
 *   running in the background — the API answers 202 without blocking on the
 *   model (plan Task 5 Step 7). The blocking variants await `completion`.
 * - Initial input seeding (plan Task 6): `start`/`resume` commit exactly one
 *   initial `agent_input` for the first declared agent when the task carries
 *   no confirmed input yet — the frozen user input rendered through its
 *   declared field labels, so the loop always has a legal first node.
 *
 * Errors leave as PublicCoreError shapes with stable codes (iron rule 6); no
 * business vocabulary lives here (iron rule 1).
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { TaskStatus, TaskSummary } from '../../shared/contracts';
import {
  TASK_CONTRACT_INCOMPATIBLE_ACTION,
  TASK_CONTRACT_INCOMPATIBLE_MESSAGE,
  TASK_ERROR_CODES,
  type PublicCoreError,
} from '../../shared/errors';
import type { CoreService } from '../core-service';
import type { CommittedEvent } from '../storage/event-store';
import type { TaskEvent } from '../storage/task-events';
import { isTurnContractSupported, TEMPLATE_ERROR_CODES, type FrozenTemplate } from '../template/template-schema';
import type { StructuredRuntimeEnvironmentV1 } from '../structured-slots/runtime-capability';
import { isStructuredRuntimeEnabled } from '../structured-slots/runtime-capability';
import { STORAGE_ERROR_CODES, StorageError } from '../storage/atomic-file';
import { StructuredSlotPrivateStore } from '../storage/structured-slot-private-store';
import {
  recoverDanglingAttempts,
  terminalize,
  deriveDraftId,
  type ActiveAttempt,
} from './structured-slot/attempt-coordinator';
import { RuntimeAbortedError } from './agent-runtime';
import type { AgentRuntime } from './agent-runtime';
import type { AcceptanceStopHook } from '../acceptance-boundary';
import {
  evaluateProgress,
  PROGRESS_GUARD_QUESTION,
  PROGRESS_POLICY,
  type ProgressPolicy,
} from './progress-guard';
import { MAX_AUTO_RETRIES, autoRetryDelayMs } from './retry-policy';
import type { TaskRunner } from './task-runner';

/** Stable scheduler error codes owned by this module. */
export const SCHEDULER_ERROR_CODES = {
  /** A task already holds the single process-wide execution slot. */
  TASK_ALREADY_RUNNING: 'TASK_ALREADY_RUNNING',
  /** The projected task status does not allow the requested lifecycle move. */
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  /** The structured human answer already committed a different canonical answer. */
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
} as const;

/** Public lifecycle conflict; serialized through the API error map. */
export class SchedulerError extends Error implements PublicCoreError {
  readonly code: string;

  readonly location: string | null;

  readonly action: string | null;

  constructor(code: string, message: string, action: string | null = null) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
    this.location = null;
    this.action = action;
  }
}

function alreadyRunning(): SchedulerError {
  return new SchedulerError(
    SCHEDULER_ERROR_CODES.TASK_ALREADY_RUNNING,
    '已有任务正在运行，全局同时只允许一个任务执行。',
    '等待当前任务结束或停止当前任务后重试。',
  );
}

function invalidTransition(message = '当前任务状态不允许该操作。'): SchedulerError {
  return new SchedulerError(
    SCHEDULER_ERROR_CODES.INVALID_TRANSITION,
    message,
    '刷新任务状态后按可用操作重试。',
  );
}

/**
 * Public rejection for lifecycle mutations of a historical frozen task whose
 * snapshot lacks a supported turn contract (plan 2026-08-04 Task 3, spec
 * §7.3). The task stays readable, exportable and cloneable — never runnable.
 */
function contractIncompatible(): SchedulerError {
  return new SchedulerError(
    TASK_ERROR_CODES.TASK_CONTRACT_INCOMPATIBLE,
    TASK_CONTRACT_INCOMPATIBLE_MESSAGE,
    TASK_CONTRACT_INCOMPATIBLE_ACTION,
  );
}

/**
 * Public rejection for a structured task whose host runtime is not ready (spec
 * §5 / design O04/O05): the SAME `TEMPLATE_RUNTIME_UNAVAILABLE` code the
 * Loader/Catalog/TaskStore surface, never a "template missing" or a generic
 * transition rejection. Start/resume/retry/answer all fail closed on it.
 */
function runtimeUnavailable(): SchedulerError {
  return new SchedulerError(
    TEMPLATE_ERROR_CODES.TEMPLATE_RUNTIME_UNAVAILABLE,
    '结构化运行时能力未就绪，无法运行该任务。',
    '等待结构化运行时就绪后重试。',
  );
}

/**
 * True when the frozen snapshot may be run: a structured template requires the
 * SAME enabled runtime environment the Catalog holds (design O05); a basic
 * template keeps the existing all-v2 gate.
 */
function isTaskRunnable(
  frozen: FrozenTemplate,
  environment: StructuredRuntimeEnvironmentV1 | undefined,
): boolean {
  if (frozen.productionMode === 'structured_slots') {
    return isStructuredRuntimeEnabled(environment);
  }
  return isTurnContractSupported(frozen);
}

/**
 * The `task_incompatible` reason for an unsupported frozen snapshot (spec
 * §3.3/§9): a snapshot carrying version-1 contracts requires the v2 schema
 * (`SCHEMA_V2_REQUIRED`); a snapshot without any turn contract is structurally
 * legacy (`TURN_CONTRACT_REQUIRED`).
 */
function incompatibleReasonFor(frozen: FrozenTemplate): 'TURN_CONTRACT_REQUIRED' | 'SCHEMA_V2_REQUIRED' {
  const hasAnyContract = frozen.agents.some((agent) => agent.turnContract !== null);
  return hasAnyContract ? 'SCHEMA_V2_REQUIRED' : 'TURN_CONTRACT_REQUIRED';
}

/** Statuses from which `stop` is meaningful even without the live slot. */
const STOPPABLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'running',
  'waiting_human',
  'retryable_failure',
  'interrupted',
]);

/** Projected statuses that count as active (recovery marks them interrupted). */
const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'running',
  'waiting_human',
  'retryable_failure',
]);

/**
 * Statuses `shutdown` marks interrupted: active states whose in-flight work
 * the process actually loses. A task waiting for a human holds no in-flight
 * Turn and must stay answerable (plan 2026-08-06 D5).
 */
const INTERRUPTIBLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'running',
  'retryable_failure',
]);

/**
 * Every projected status process-restart recovery may touch (review F3):
 * the active trio plus never-started `ready` and already-`interrupted`
 * tasks, because the legacy incompatibility gate must reach all of them —
 * a pre-upgrade task that never ran or was interrupted before the gate
 * existed would otherwise keep promising a start/resume the platform must
 * refuse. Terminal, corrupt, draft and already-incompatible tasks are never
 * scanned.
 */
const RECOVERABLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  ...ACTIVE_STATUSES,
  'ready',
  'interrupted',
]);

/** Bounded waits keep stop/shutdown from hanging on a wedged runtime. */
const STOP_WAIT_MS = 5000;

const SHUTDOWN_WAIT_MS = 5000;

/**
 * Injectable retry hooks (plan Task 5 Step 3): production waits on real
 * exponential delays with bounded jitter; tests pin both deterministically.
 */
export interface RetryPolicyHooks {
  /** Automatic retries allowed per run (default MAX_AUTO_RETRIES). */
  maxAutoRetries?: number;
  /** Delay before automatic retry number `retryNumber` (1-indexed). */
  delayMs?: (retryNumber: number) => number;
  /** Waits one delay; resolves early when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** What a detached lifecycle acceptance hands back to the API layer. */
export interface AcceptedLifecycle {
  /** Projected summary right after acceptance (lifecycle event committed). */
  accepted: TaskSummary;
  /** Settles when the background loop reaches its next rest state. */
  completion: Promise<TaskSummary>;
}

/**
 * A human answer payload (spec §11.1/§11.5). An ordinary `answer` continues
 * the requesting agent (the only option for `agent_request` source). A
 * structured `decision` is offered only for `progress_guard` source:
 * `continue` supersedes pending inputs and synthesizes a guidance input for
 * the stalest voided recipient; `accept` synthesizes a human-authorized input
 * for the final submitter (requires at least one published version); `stop`
 * reuses the stop lifecycle. `continue`/`accept` carry the guidance text that
 * becomes the synthesized input body.
 */
export type HumanAnswerRequest =
  | { kind: 'answer'; text: string }
  | { kind: 'continue'; text: string }
  | { kind: 'accept'; text: string }
  | { kind: 'stop' };

/** Normalizes a raw answer payload (string or typed) into a HumanAnswerRequest. */
function normalizeAnswerRequest(payload: string | HumanAnswerRequest): HumanAnswerRequest {
  if (typeof payload === 'string') {
    return { kind: 'answer', text: payload };
  }
  return payload;
}

interface ActiveRun {
  taskId: string;
  /** Bumped on stop/shutdown; stale late results are dropped. */
  generation: number;
  controller: AbortController;
  promise: Promise<TaskSummary>;
}

export interface TaskSchedulerOptions {
  service: CoreService;
  runner: TaskRunner;
  runtime: AgentRuntime;
  /**
   * The ONE structured runtime environment (spec §5 / design O05): the same
   * immutable reference frozen in CoreService construction. Rechecked on every
   * start/resume/retry/answer; a structured task fails closed with
   * `TEMPLATE_RUNTIME_UNAVAILABLE` while it is disabled. Never a second default
   * and never an environment-variable fallback.
   */
  runtimeEnvironment?: StructuredRuntimeEnvironmentV1;
  /** Retry timing hooks; production defaults unless tests inject their own. */
  retryPolicy?: RetryPolicyHooks;
  /**
   * No-progress limits (plan 2026-08-06); production defaults unless tests
   * inject their own.
   */
  progressPolicy?: ProgressPolicy;
  /**
   * Acceptance-only boundary seam (plan Phase D Task 4; process harness,
   * never the production API/UI). Consulted after each successfully
   * committed Turn, strictly BEFORE the next Agent is scheduled and only
   * once the Turn is neither terminal nor a failure. Returning true stops
   * the run loop at a confirmed rest point — committed events and artifacts
   * stay, the task remains resumable. Production never installs this.
   */
  acceptanceStopAfterCommit?: AcceptanceStopHook;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`forge-core scheduler: ${label} timed out`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Production wait: a real timer that resolves early on abort. */
function defaultRetrySleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The next sequence number after the highest committed node/route sequence. */
function nextSequence(events: readonly TaskEvent[]): number {
  let sequence = 0;
  for (const event of events) {
    if ('node' in event) {
      sequence = Math.max(sequence, event.node.sequence);
    }
    if ('route' in event) {
      sequence = Math.max(sequence, event.route.sequence);
    }
  }
  return sequence + 1;
}

/** True when a committed result exists for the input node id (runner id rule). */
function hasResultForInput(events: readonly TaskEvent[], inputId: string): boolean {
  return events.some(
    (event) => event.type === 'agent_result' && event.id.startsWith(`${inputId}-t`) && event.id.endsWith('-result'),
  );
}

/** The set of agent_input node ids voided by `pending_inputs_superseded`. */
function voidedInputIds(events: readonly TaskEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type === 'pending_inputs_superseded') {
      for (const nodeId of event.supersededNodeIds) {
        ids.add(nodeId);
      }
    }
  }
  return ids;
}

/**
 * The stalest unprocessed agent_input (oldest by sequence, not superseded, no
 * committed result) - the guard's parking target (spec §11.4) and continue's
 * synthesis target (spec §11.3). Null when no pending input exists.
 */
function stalestPendingInput(
  events: readonly TaskEvent[],
): Extract<TaskEvent, { type: 'agent_input' }> | null {
  const voided = voidedInputIds(events);
  for (const event of events) {
    if (event.type !== 'agent_input' || voided.has(event.id)) {
      continue;
    }
    if (!hasResultForInput(events, event.id)) {
      return event;
    }
  }
  return null;
}

/**
 * All unprocessed agent_input ids at the current frontier (not superseded, no
 * committed result) - the set the supersede event voids on continue/accept.
 */
function currentPendingInputIds(events: readonly TaskEvent[]): string[] {
  const voided = voidedInputIds(events);
  const ids: string[] = [];
  for (const event of events) {
    if (event.type !== 'agent_input' || voided.has(event.id)) {
      continue;
    }
    if (!hasResultForInput(events, event.id)) {
      ids.push(event.id);
    }
  }
  return ids;
}

/** The latest published artifact version, or null when none was published. */
function latestPublishedVersion(events: readonly TaskEvent[]): number | null {
  let latest: number | null = null;
  for (const event of events) {
    if (event.type === 'artifact_published') {
      latest = Math.max(latest ?? 0, event.artifact.version);
    }
  }
  return latest;
}

/**
 * The most recent `human_requested` with no later `human_answered` - the
 * pending question the answer flow must resolve. Null when none is pending.
 */
function findPendingHumanRequest(
  events: readonly TaskEvent[],
): Extract<TaskEvent, { type: 'human_requested' }> | null {
  let pending: Extract<TaskEvent, { type: 'human_requested' }> | null = null;
  for (const event of events) {
    if (event.type === 'human_requested') {
      pending = event;
    } else if (event.type === 'human_answered') {
      pending = null;
    }
  }
  return pending;
}

export class TaskScheduler {
  /** The runtime this scheduler drives (tests observe concurrency on it). */
  readonly runtime: AgentRuntime;

  readonly #service: CoreService;

  readonly #runner: TaskRunner;

  readonly #runtimeEnvironment: StructuredRuntimeEnvironmentV1 | undefined;

  readonly #maxAutoRetries: number;

  readonly #retryDelayMs: (retryNumber: number) => number;

  readonly #retrySleep: (ms: number, signal: AbortSignal) => Promise<void>;

  readonly #progressPolicy: ProgressPolicy;

  readonly #acceptanceStopAfterCommit: AcceptanceStopHook | undefined;

  #current: ActiveRun | null = null;

  #shutdown = false;

  constructor(options: TaskSchedulerOptions) {
    this.#service = options.service;
    this.#runner = options.runner;
    this.runtime = options.runtime;
    this.#runtimeEnvironment = options.runtimeEnvironment;
    const policy = options.retryPolicy ?? {};
    this.#maxAutoRetries = policy.maxAutoRetries ?? MAX_AUTO_RETRIES;
    this.#retryDelayMs = policy.delayMs ?? ((retryNumber) => autoRetryDelayMs(retryNumber));
    this.#retrySleep = policy.sleep ?? defaultRetrySleep;
    this.#progressPolicy = options.progressPolicy ?? PROGRESS_POLICY;
    this.#acceptanceStopAfterCommit = options.acceptanceStopAfterCommit;
  }

  /**
   * Starts one task and awaits the loop to its next rest state (blocking
   * variant used by tests; the API uses `startDetached`).
   */
  async start(taskId: string): Promise<TaskSummary> {
    const { completion } = await this.startDetached(taskId);
    return completion;
  }

  /** Resumes a stopped/interrupted task from its last confirmed event. */
  async resume(taskId: string): Promise<TaskSummary> {
    const { completion } = await this.resumeDetached(taskId);
    return completion;
  }

  /** Manual retry: valid only for `retryable_failure` (spec §7.1). */
  async retry(taskId: string): Promise<TaskSummary> {
    const { completion } = await this.retryDetached(taskId);
    return completion;
  }

  /** Answers the pending human request and continues the requesting agent. */
  async answer(taskId: string, payload: string | HumanAnswerRequest): Promise<TaskSummary> {
    const { completion } = await this.answerDetached(taskId, payload);
    return completion;
  }

  /**
   * Detached start: validates, claims the slot and commits `task_started`,
   * then returns the accepted summary while the loop runs in the background
   * (plan Task 5 Step 7 — the API answers 202 without blocking).
   */
  startDetached(taskId: string): Promise<AcceptedLifecycle> {
    return this.acceptDetached(taskId, 'start');
  }

  /** Detached resume (stopped/interrupted tasks only). */
  resumeDetached(taskId: string): Promise<AcceptedLifecycle> {
    return this.acceptDetached(taskId, 'resume');
  }

  /** Detached manual retry (`retryable_failure` only). */
  retryDetached(taskId: string): Promise<AcceptedLifecycle> {
    return this.acceptDetached(taskId, 'retry');
  }

  /** Detached human answer (`waiting_human` only). */
  async answerDetached(
    taskId: string,
    payload: string | HumanAnswerRequest,
  ): Promise<AcceptedLifecycle> {
    const request = normalizeAnswerRequest(payload);
    const needsText = request.kind === 'answer' || request.kind === 'continue' || request.kind === 'accept';
    if (needsText && request.text.trim().length === 0) {
      throw invalidTransition('人工回答不能为空。');
    }
    return this.acceptDetached(taskId, 'answer', request);
  }

  /**
   * Stops the task: bumps the generation and aborts SYNCHRONOUSLY before any
   * await (a Turn result landing afterwards is stale and commits nothing),
   * waits bounded disposal and appends `task_stopped`. Confirmed
   * events/artifacts stay (spec §7.2).
   */
  async stop(taskId: string): Promise<TaskSummary> {
    const run = this.#current !== null && this.#current.taskId === taskId ? this.#current : null;
    if (run !== null) {
      run.generation += 1;
      run.controller.abort();
      await withTimeout(run.promise, STOP_WAIT_MS, 'stop').catch(() => undefined);
    } else {
      const workspace = await this.#service.getWorkspace(taskId);
      if (!STOPPABLE_STATUSES.has(workspace.task.status)) {
        throw invalidTransition('当前任务未在运行，无法停止。');
      }
    }
    // Structured stop (design §11.5/§25.6 G03): close the active attempt with
    // its Draft/Attempt abandonment facts AND task_stopped in ONE batch, then
    // best-effort reconcile the private caches. Basic tasks keep the single
    // task_stopped append.
    const closed = await this.closeActiveStructuredAttempt(taskId, 'task_stop');
    if (!closed) {
      await this.appendLifecycle(taskId, 'task_stopped');
    }
    return (await this.#service.getWorkspace(taskId)).task;
  }

  /**
   * Deletion support: when the given task holds the single execution slot,
   * abort the run and wait bounded disposal exactly like `stop` — but append
   * NO lifecycle event, since the caller removes the task afterwards. No-op
   * when the task does not hold the slot (every other status deletes as is).
   * After this resolves the slot is free and no run references the task.
   */
  async releaseIfRunning(taskId: string): Promise<void> {
    const run = this.#current !== null && this.#current.taskId === taskId ? this.#current : null;
    if (run === null) {
      return;
    }
    run.generation += 1;
    run.controller.abort();
    await withTimeout(run.promise, STOP_WAIT_MS, 'stop').catch(() => undefined);
  }

  /**
   * Process-restart recovery (spec §7.2): every projected-active task that
   * was actually started (a `task_started`/`task_resumed` event exists) but
   * carries no terminal event receives `task_interrupted`. Tasks that only
   * hold confirmed inputs were never in flight and stay untouched; corrupt
   * and terminal tasks are never modified. Tasks parked in `waiting_human`
   * hold no in-flight Turn and are skipped so their pending question stays
   * answerable across restarts (plan 2026-08-06 D5). Returns the interrupted
   * ids.
   *
   * Incompatibility gate (plan 2026-08-04 Task 3, spec §7.3; widened by
   * review F3): ANY recoverable task whose frozen snapshot lacks a supported
   * turn contract receives ONE idempotent `task_incompatible` event — not
   * only the active trio, but also never-started `ready` and
   * already-`interrupted` legacy tasks, since start/resume would refuse them
   * anyway. Contract-supported `ready`/`interrupted` tasks stay exactly as
   * they are (startable/resumable). Completed/stopped legacy tasks stay
   * untouched and readable.
   */
  async recoverInterruptedTasks(): Promise<string[]> {
    const summaries = await this.#service.listTasks();
    const interrupted: string[] = [];
    for (const summary of summaries) {
      if (!RECOVERABLE_STATUSES.has(summary.status)) {
        continue;
      }
      // A task waiting for a human holds no in-flight Turn: a restart must
      // keep it exactly where it is so `answer` stays reachable (plan
      // 2026-08-06 D5; parking it interrupted deadlocked the question).
      if (summary.status === 'waiting_human') {
        continue;
      }
      // Corrupt tasks stay isolated: identity/snapshot reads that throw leave
      // them exactly where the projection already placed them.
      let snapshotSupported: boolean;
      let frozenSnapshot: FrozenTemplate | null = null;
      try {
        frozenSnapshot = await this.#service.tasks.readFrozenTemplate(summary.id);
        snapshotSupported = isTaskRunnable(frozenSnapshot, this.#runtimeEnvironment);
      } catch {
        continue;
      }
      if (!snapshotSupported) {
        await this.markIncompatibleOnce(
          summary.id,
          incompatibleReasonFor(frozenSnapshot as FrozenTemplate),
        );
        continue;
      }
      if (!ACTIVE_STATUSES.has(summary.status)) {
        // Supported never-started ('ready') or already-'interrupted' tasks
        // keep their startable/resumable state untouched (review F3).
        continue;
      }
      const committed = await this.#service.events.read(summary.id);
      const everStarted = committed.some(
        (entry) => entry.event.type === 'task_started' || entry.event.type === 'task_resumed',
      );
      if (!everStarted) {
        continue; // Confirmed inputs alone never prove an interrupted run.
      }
      // Structured recovery (design §11.5): scan dangling starts and commit the
      // Draft terminal when opened + abandoned/crash_recovery + task_interrupted
      // in ONE authority batch BEFORE the task becomes resumable, then
      // best-effort reconcile private caches. Basic tasks keep the single
      // task_interrupted append.
      if (frozenSnapshot.productionMode === 'structured_slots') {
        const closed = await this.recoverStructuredTask(summary.id, committed);
        if (!closed) {
          await this.appendLifecycle(summary.id, 'task_interrupted');
        }
        interrupted.push(summary.id);
        continue;
      }
      await this.appendLifecycle(summary.id, 'task_interrupted');
      interrupted.push(summary.id);
    }
    return interrupted;
  }

  /**
   * Appends the single authoritative `task_incompatible` event for one
   * unfinished legacy task; idempotent across repeated recoveries (the first
   * committed event wins, append-only history is never rewritten).
   */
  private async markIncompatibleOnce(
    taskId: string,
    reason: 'TURN_CONTRACT_REQUIRED' | 'SCHEMA_V2_REQUIRED',
  ): Promise<void> {
    const committed = await this.#service.events.read(taskId);
    if (committed.some((entry) => entry.event.type === 'task_incompatible')) {
      return;
    }
    await this.#service.events.append(taskId, {
      id: randomUUID(),
      at: new Date().toISOString(),
      type: 'task_incompatible',
      reason,
    });
  }

  /**
   * Server shutdown: abort the active run, wait bounded disposal, append
   * `task_interrupted` when no terminal event exists, then dispose the
   * runtime. Idempotent; after it, lifecycle calls reject publicly.
   */
  async shutdown(): Promise<void> {
    if (this.#shutdown) {
      return;
    }
    this.#shutdown = true;
    const run = this.#current;
    if (run !== null) {
      run.generation += 1;
      run.controller.abort();
      await withTimeout(run.promise, SHUTDOWN_WAIT_MS, 'shutdown').catch(() => undefined);
      try {
        const workspace = await this.#service.getWorkspace(run.taskId);
        if (INTERRUPTIBLE_STATUSES.has(workspace.task.status)) {
          await this.appendLifecycle(run.taskId, 'task_interrupted');
        }
      } catch {
        // Best-effort: interruption marking never blocks shutdown.
      }
      this.release(run);
    }
    await this.runtime.disposeAll();
  }

  /**
   * Detached acceptance: claims the slot synchronously, validates and commits
   * the lifecycle event, then returns the accepted summary while `completion`
   * keeps running the loop in the background. Validation failures reject the
   * returned promise (and `completion`) — the slot is released.
   */
  private async acceptDetached(
    taskId: string,
    kind: 'start' | 'resume' | 'retry' | 'answer',
    answer?: HumanAnswerRequest,
  ): Promise<AcceptedLifecycle> {
    const run = this.claim(taskId);
    let resolveAccepted!: (summary: TaskSummary) => void;
    let rejectAccepted!: (error: unknown) => void;
    const acceptedPromise = new Promise<TaskSummary>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const completion = (async (): Promise<TaskSummary> => {
      try {
        await this.prepare(run, taskId, kind, answer);
        resolveAccepted((await this.#service.getWorkspace(taskId)).task);
      } catch (error) {
        rejectAccepted(error);
        throw error;
      }
      return this.execute(run);
    })();
    // Assigned in the same synchronous burst as the claim, so stop/shutdown
    // never observe the placeholder; the background loop's rejection is
    // handled here for callers that only await `accepted`.
    run.promise = completion;
    completion.catch(() => undefined);
    const accepted = await acceptedPromise;
    return { accepted, completion };
  }

  /**
   * Validates the projected status for the requested lifecycle move and
   * commits its event. Releases the slot and rethrows on any failure.
   *
   * The incompatibility gate runs before any status check (plan 2026-08-04
   * Task 3, spec §7.3): a frozen snapshot without a supported turn contract
   * rejects start/resume/retry/answer with TASK_CONTRACT_INCOMPATIBLE no
   * matter what the projection says — legacy tasks are read-only forever.
   */
  private async prepare(
    run: ActiveRun,
    taskId: string,
    kind: 'start' | 'resume' | 'retry' | 'answer',
    answer?: HumanAnswerRequest,
  ): Promise<void> {
    try {
      const workspace = await this.workspaceForPrepare(taskId);
      const frozen = await this.frozenForPrepare(taskId);
      // The readiness gate runs before any status check (spec §5 / design
      // O04/O05): a basic task without a supported turn contract rejects with
      // TASK_CONTRACT_INCOMPATIBLE; a structured task whose runtime environment
      // is disabled rejects with TEMPLATE_RUNTIME_UNAVAILABLE — no matter what
      // the projection says.
      if (!isTaskRunnable(frozen, this.#runtimeEnvironment)) {
        if (frozen.productionMode === 'structured_slots') {
          throw runtimeUnavailable();
        }
        throw contractIncompatible();
      }
      const status = workspace.task.status;
      if (kind === 'start') {
        if (status === 'running') {
          // Projected 'running' also covers never-started tasks that only
          // carry confirmed input nodes; a lifecycle start/resume event is
          // what proves the task already ran — only then is a second start
          // a public conflict (spec §3.3, plan Task 4 Step 4).
          const committed = await this.#service.events.read(taskId);
          const everStarted = committed.some(
            (entry) =>
              entry.event.type === 'task_started' || entry.event.type === 'task_resumed',
          );
          if (everStarted) {
            throw alreadyRunning();
          }
        } else if (status !== 'ready' && status !== 'stopped') {
          throw invalidTransition('只有就绪或已停止的任务可以启动。');
        }
        await this.appendLifecycle(taskId, 'task_started');
        await this.seedInitialInputIfMissing(taskId);
      } else if (kind === 'resume') {
        if (status !== 'stopped' && status !== 'interrupted') {
          throw invalidTransition('只有已停止或被中断的任务可以继续。');
        }
        await this.appendLifecycle(taskId, 'task_resumed');
        await this.seedInitialInputIfMissing(taskId);
      } else if (kind === 'retry') {
        if (status !== 'retryable_failure') {
          throw invalidTransition('只有运行失败可重试的任务可以手动重试。');
        }
      } else {
        // kind === 'answer'
        const request = answer ?? { kind: 'answer', text: '' };
        // Structured v3 atomic-answer replay-first (spec §11.5): a committed
        // answer commit is checked BEFORE the status rejection so an idempotent
        // retry of the same canonical answer returns the original success and
        // a different answer conflicts — it can never be overwritten.
        if (frozen.productionMode === 'structured_slots' && request.kind === 'answer') {
          const events = (await this.#service.events.read(taskId)).map((entry) => entry.event);
          const outcome = await this.replayStructuredAnswer(taskId, events, request.text);
          if (outcome === 'replayed') {
            return;
          }
          if (outcome === 'conflict') {
            throw new SchedulerError(
              SCHEDULER_ERROR_CODES.IDEMPOTENCY_CONFLICT,
              '该人工提问已收到不同的回答，不能覆盖第一次回答。',
            );
          }
        }
        if (status !== 'waiting_human') {
          throw invalidTransition('只有等待人工回答的任务可以提交回答。');
        }
        await this.applyHumanAnswer(taskId, run, request);
      }
    } catch (error) {
      this.release(run);
      throw error;
    }
  }

  /**
   * Projects one task for a lifecycle move. A disabled structured task's
   * snapshot fails to load (TASK_CORRUPTED from `readFrozenTemplate`); the
   * scheduler probes the snapshot's pipeline to surface the SAME
   * `TEMPLATE_RUNTIME_UNAVAILABLE` code instead of masquerading as corruption
   * (design O05).
   */
  private async workspaceForPrepare(taskId: string): Promise<Awaited<ReturnType<CoreService['getWorkspace']>>> {
    try {
      return await this.#service.getWorkspace(taskId);
    } catch (error) {
      if (
        error instanceof StorageError &&
        error.code === STORAGE_ERROR_CODES.TASK_CORRUPTED &&
        (await this.isStructuredSnapshot(taskId))
      ) {
        throw runtimeUnavailable();
      }
      throw error;
    }
  }

  /**
   * Reads the frozen snapshot for a lifecycle move with the same
   * disabled-structured mapping as `workspaceForPrepare`.
   */
  private async frozenForPrepare(taskId: string): Promise<FrozenTemplate> {
    try {
      return await this.#service.tasks.readFrozenTemplate(taskId);
    } catch (error) {
      if (
        error instanceof StorageError &&
        error.code === STORAGE_ERROR_CODES.TASK_CORRUPTED &&
        (await this.isStructuredSnapshot(taskId))
      ) {
        throw runtimeUnavailable();
      }
      throw error;
    }
  }

  /**
   * Probes the task snapshot's `pipeline.yaml` for `productionMode:
   * structured_slots` — the loader's own mode split — so a snapshot that
   * cannot load under a disabled runtime environment is still recognized as
   * structured (design O05). Basic/corrupt snapshots return false.
   */
  private async isStructuredSnapshot(taskId: string): Promise<boolean> {
    try {
      const pipelinePath = join(this.#service.paths.taskSnapshotRoot(taskId), 'pipeline.yaml');
      const raw = await readFile(pipelinePath, 'utf8');
      const parsed = parseYaml(raw) as { productionMode?: unknown } | null;
      return parsed !== null && parsed.productionMode === 'structured_slots';
    } catch {
      return false;
    }
  }

  /**
   * The run loop: one `runNext` at a time until a rest state (spec §3.3),
   * with bounded automatic retry of retryable failures (spec §7.1). The
   * no-progress guard is evaluated at the HEAD of every iteration (plan
   * 2026-08-06): one check site covers post-commit continuation and every
   * restart/stop-resume re-entry, and the loop never runs a Turn while a
   * human question is unanswered.
   */
  private async execute(run: ActiveRun): Promise<TaskSummary> {
    let autoRetries = 0;
    try {
      // Crash half-state repair (spec §11.6, semantic audit P2): a process
      // death between supersede and synthesize leaves no executable pending
      // input; heal it deterministically before the loop runs.
      await this.repairInterventionHalfState(run.taskId);
      for (;;) {
        if (run.controller.signal.aborted) {
          break;
        }
        if (await this.guardNoProgress(run.taskId)) {
          break;
        }
        const result = await this.#runner.runNext(run.taskId, run.controller.signal, {
          autoRetryExhausted: autoRetries >= this.#maxAutoRetries,
        });
        if (run.controller.signal.aborted) {
          break;
        }
        if (result.taskCompleted || result.waitingHuman) {
          break;
        }
        if (result.attemptFailed) {
          if (!result.retryable) {
            break; // Permanent failure, or budget exhausted (recorded terminal).
          }
          autoRetries += 1;
          const delayMs = this.#retryDelayMs(autoRetries);
          // Every scheduled delay is committed (spec §7.1: record attempts and
          // delays); the canvas folds them onto the same input node.
          await this.appendRetryScheduled(
            run.taskId,
            result.processedNodeId ?? '',
            delayMs,
            result.attemptCount + 1,
          );
          if (run.controller.signal.aborted) {
            break;
          }
          await this.#retrySleep(delayMs, run.controller.signal);
          continue; // Same input node, new attempt number.
        }
        if (result.processedNodeId === null) {
          break; // No confirmed pending input left.
        }
        // Acceptance-only boundary seam (plan Phase D Task 4): consulted at a
        // confirmed rest point AFTER this Turn committed and strictly BEFORE
        // the next Agent is scheduled. Terminal Turns (taskCompleted/waiting
        // Human) and failures never reach it — see the checks above. The
        // production loop leaves this undefined and pays nothing.
        if (this.#acceptanceStopAfterCommit !== undefined && result.committed) {
          const stopAtBoundary = await this.#acceptanceStopAfterCommit(
            run.taskId,
            run.controller.signal,
          );
          if (stopAtBoundary || run.controller.signal.aborted) {
            break;
          }
        }
      }
    } catch (error) {
      if (!(error instanceof RuntimeAbortedError) && !run.controller.signal.aborted) {
        this.release(run);
        throw error;
      }
      // Aborted by stop/shutdown: the caller appends the terminal event.
    }
    this.release(run);
    const workspace = await this.#service.getWorkspace(run.taskId);
    if (!run.controller.signal.aborted && workspace.task.status === 'running') {
      // The loop exited without reaching a terminal state (no pending input
      // found but the task is neither completed nor waiting). Park visibly
      // instead of leaving it silently running (spec: no-silent-running).
      await this.appendLifecycle(run.taskId, 'task_interrupted');
    }
    const finalWorkspace = await this.#service.getWorkspace(run.taskId);
    return finalWorkspace.task;
  }

  /**
   * No-progress guard (plan 2026-08-06), evaluated at the head of every loop
   * iteration over committed events alone (deterministic across restarts).
   * An unanswered human request ALWAYS halts the loop — a Turn must never run
   * while a question is pending. An exceeded progress limit commits exactly
   * one synthetic human request under the last dispatcher and halts too, so
   * a structurally legal but spinning task parks visibly in waiting_human
   * instead of turning forever. Returns true when the loop must break.
   */
  private async guardNoProgress(taskId: string): Promise<boolean> {
    const committed = await this.#service.events.read(taskId);
    const events = committed.map((entry) => entry.event);
    const evaluation = evaluateProgress(events, await this.effectiveProgressPolicy(taskId));
    if (evaluation.hasUnansweredHumanRequest) {
      return true;
    }
    if (!evaluation.exceeded) {
      return false;
    }
    // Exceeding the limit requires at least one committed result, so a
    // dispatcher exists; stay inert defensively rather than guess one.
    if (evaluation.lastDispatchAgentId !== null) {
      await this.appendProgressGuardRequest(taskId, events, evaluation.lastDispatchAgentId);
    }
    return true;
  }

  /**
   * The progress policy for one task (plan 2026-08-06): the frozen snapshot's
   * template-declared budget when present, else the scheduler-injected
   * policy. Reads ride the TaskStore snapshot cache; a damaged snapshot
   * falls back to the injected policy so the guard never blocks on it.
   */
  private async effectiveProgressPolicy(taskId: string): Promise<ProgressPolicy> {
    try {
      const frozen = await this.#service.tasks.readFrozenTemplate(taskId);
      return frozen.budget ?? this.#progressPolicy;
    } catch {
      return this.#progressPolicy;
    }
  }

  /**
   * Commits the guard's one synthetic human request (mirrors the
   * `appendHumanAnswer` synthesis pattern): the node names the last
   * dispatcher, carries the frozen platform question and the next sequence.
   * The projector folds it into `waiting_human` + `pendingHumanQuestion`, so
   * the existing answer flow resumes the task with a fresh progress window —
   * no new event type or status (contracts stay frozen).
   */
  /**
   * Commits the guard's one synthetic human request (spec §11.4): the node is
   * attributed to the recipient of the STALEST pending input at parking time
   * (not the last dispatcher), so the continue synthesis target aligns with
   * the parking target. Falls back to the last dispatcher when no pending
   * input exists (theoretical - the guard only fires after a successful turn).
   * The request carries `source: 'progress_guard'` so the answer flow offers
   * the structured three-choice (spec §11.5).
   */
  private async appendProgressGuardRequest(
    taskId: string,
    events: readonly TaskEvent[],
    fallbackAgentId: string,
  ): Promise<void> {
    const stalest = stalestPendingInput(events);
    const agentId = stalest?.node.agentId ?? fallbackAgentId;
    const frozen = await this.#service.tasks.readFrozenTemplate(taskId);
    const agentName = frozen.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
    const sequence = nextSequence(events);
    await this.#service.events.append(taskId, {
      id: randomUUID(),
      at: new Date().toISOString(),
      type: 'human_requested',
      node: {
        sequence: sequence + 1,
        agentId,
        kind: 'human_request',
        title: agentName,
        body: PROGRESS_GUARD_QUESTION,
        status: 'confirmed',
        attemptCount: 1,
        inputVersion: null,
      },
      question: PROGRESS_GUARD_QUESTION,
      source: 'progress_guard',
    });
  }

  /**
   * Claims the single slot synchronously, so an immediately following second
   * start deterministically observes the conflict (never queues). The caller
   * assigns `run.promise` in the same synchronous burst.
   */
  private claim(taskId: string): ActiveRun {
    if (this.#shutdown) {
      throw invalidTransition('运行调度器已关闭，不再接受任务操作。');
    }
    if (this.#current !== null) {
      throw alreadyRunning();
    }
    const run: ActiveRun = {
      taskId,
      generation: 0,
      controller: new AbortController(),
      // Never-observed placeholder; acceptance replaces it synchronously.
      promise: new Promise<TaskSummary>(() => undefined),
    };
    this.#current = run;
    return run;
  }

  private release(run: ActiveRun): void {
    if (this.#current === run) {
      this.#current = null;
    }
  }

  private async appendLifecycle(
    taskId: string,
    type: 'task_started' | 'task_stopped' | 'task_resumed' | 'task_interrupted',
  ): Promise<void> {
    await this.#service.events.append(taskId, {
      id: randomUUID(),
      at: new Date().toISOString(),
      type,
    });
  }

  /**
   * Seeds the task's first confirmed input node when none exists yet (plan
   * Task 6): a freshly frozen task carries its user input only inside
   * `task.json`, and the runner only executes confirmed `agent_input` nodes.
   * The initial input goes to the FIRST declared agent, rendered generically
   * from the frozen input-field labels — config-driven, zero business
   * branching (iron rule 1). Tasks that already carry confirmed inputs are
   * never re-seeded (stop/resume continuation, recovery after a mid-loop
   * crash). The crash window between `task_started` and the seeded input is
   * covered as well: a resume over a start-only history seeds the input.
   */
  private async seedInitialInputIfMissing(taskId: string): Promise<void> {
    const committed = await this.#service.events.read(taskId);
    if (committed.some((entry) => entry.event.type === 'agent_input')) {
      return;
    }
    const frozen = await this.#service.tasks.readFrozenTemplate(taskId);
    const record = await this.#service.tasks.readTaskRecord(taskId);
    const agent = frozen.agents[0];
    if (agent === undefined) {
      throw invalidTransition('模板未声明任何 Agent，无法播种初始输入。');
    }
    const lines: string[] = [];
    for (const field of frozen.inputFields) {
      const value = record.frozenInput[field.id];
      if (typeof value === 'string' && value.length > 0) {
        lines.push(`${field.label}: ${value}`);
      }
    }
    let sequence = 0;
    for (const entry of committed) {
      const event = entry.event;
      if ('node' in event) {
        sequence = Math.max(sequence, event.node.sequence);
      }
      if ('route' in event) {
        sequence = Math.max(sequence, event.route.sequence);
      }
    }
    await this.#service.events.append(taskId, {
      id: randomUUID(),
      at: new Date().toISOString(),
      type: 'agent_input',
      node: {
        sequence: sequence + 1,
        agentId: agent.id,
        kind: 'input',
        title: agent.name,
        body: lines.join('\n'),
        status: 'confirmed',
        attemptCount: 1,
        inputVersion: null,
      },
    });
  }

  /** Commits one scheduled automatic-retry delay (observability, spec §7.1). */
  private async appendRetryScheduled(
    taskId: string,
    nodeId: string,
    delayMs: number,
    attempt: number,
  ): Promise<void> {
    await this.#service.events.append(taskId, {
      id: randomUUID(),
      at: new Date().toISOString(),
      type: 'retry_scheduled',
      nodeId,
      delayMs,
      attempt,
    });
  }

  /**
   * Dispatches a human answer to the pending request (spec §11.1/§11.5). A
   * `progress_guard` request offers the structured three-choice (an ordinary
   * text answer maps to `continue` with the text as guidance); an
   * `agent_request` request accepts only an ordinary text answer.
   */
  private async applyHumanAnswer(
    taskId: string,
    run: ActiveRun,
    request: HumanAnswerRequest,
  ): Promise<void> {
    const committed = await this.#service.events.read(taskId);
    const events = committed.map((entry) => entry.event);
    const pendingRequest = findPendingHumanRequest(events);
    if (pendingRequest === null) {
      throw invalidTransition('没有等待回答的人工输入请求。');
    }
    const source = pendingRequest.source ?? 'agent_request';
    if (source === 'progress_guard') {
      if (request.kind === 'accept') {
        await this.applyAccept(taskId, events, pendingRequest, request.text);
      } else if (request.kind === 'stop') {
        await this.applyStop(taskId, run, events, pendingRequest);
      } else {
        // `answer` or `continue` -> continue with the guidance text.
        await this.applyContinue(taskId, events, pendingRequest, request.text);
      }
      return;
    }
    // agent_request: only an ordinary text answer is accepted.
    if (request.kind !== 'answer') {
      throw invalidTransition('该人工提问只接受文字回答，不支持结构化决策。');
    }
    const frozen = await this.#service.tasks.readFrozenTemplate(taskId);
    if (frozen.productionMode === 'structured_slots') {
      // Structured v3 atomic answer (spec §11.5): human_answered + the fresh
      // confirmed agent_input land in ONE appendBatch derived from the pending
      // request ID — never the two single-event helpers.
      await this.appendStructuredHumanAnswer(taskId, events, pendingRequest, request.text);
      return;
    }
    await this.appendHumanAnswer(taskId, events, pendingRequest, request.text);
  }

  /**
   * Structured v3 atomic human answer (spec §11.5 / design §11.5 step 1-3):
   * the answer commitId and the deterministic event ids derive from the
   * pending request event ID, and `human_answered` + the fresh confirmed
   * `agent_input` are appended together with the observed tail in ONE
   * appendBatch. A crash before the batch keeps the question answerable; a
   * crash after it leaves both events committed. The fresh input carries
   * `attemptCount: 1` and starts its own epoch 1 (design §11.5).
   */
  private async appendStructuredHumanAnswer(
    taskId: string,
    events: readonly TaskEvent[],
    pendingRequest: Extract<TaskEvent, { type: 'human_requested' }>,
    answer: string,
  ): Promise<void> {
    const commitId = `answer-${pendingRequest.id}`;
    const humanAnsweredId = `${pendingRequest.id}-answered`;
    const agentInputId = `${pendingRequest.id}-input`;
    const agentId = pendingRequest.node.agentId;
    const frozen = await this.#service.tasks.readFrozenTemplate(taskId);
    const agentName = frozen.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
    const sequence = nextSequence(events);
    const at = new Date().toISOString();
    const committedTail = await this.#service.events.read(taskId);
    const expectedLastSequence = committedTail[committedTail.length - 1]?.sequence ?? 0;
    const batch: TaskEvent[] = [
      {
        id: humanAnsweredId,
        at,
        type: 'human_answered',
        node: {
          sequence,
          agentId,
          kind: 'human_answer',
          title: agentName,
          body: answer,
          status: 'confirmed',
          attemptCount: 1,
          inputVersion: null,
        },
        answer,
      },
      {
        id: agentInputId,
        at,
        type: 'agent_input',
        node: {
          sequence: sequence + 1,
          agentId,
          kind: 'input',
          title: agentName,
          body: answer,
          status: 'confirmed',
          attemptCount: 1,
          inputVersion: null,
        },
      },
    ];
    await this.#service.events.appendBatch(taskId, commitId, batch, {
      expectedLastSequence,
    });
  }

  /**
   * Structured v3 answer replay/conflict check (spec §11.5 step 4): scans the
   * structured agent_request human requests newest-first, derives each one's
   * answer commitId and reads the committed batch. A matching canonical answer
   * replays the original success; a different answer conflicts (never
   * overwrites the first answer); no committed batch means the answer is still
   * pending and the caller proceeds.
   */
  private async replayStructuredAnswer(
    taskId: string,
    events: readonly TaskEvent[],
    answer: string,
  ): Promise<'none' | 'replayed' | 'conflict'> {
    const requests: Array<Extract<TaskEvent, { type: 'human_requested' }>> = [];
    for (const event of events) {
      if (event.type === 'human_requested' && (event.source ?? 'agent_request') === 'agent_request') {
        requests.push(event);
      }
    }
    // Newest-first: the FIRST request that has NO committed answer batch is the
    // one this answer addresses — a new commit proceeds ('none'). Only a
    // request that ALREADY has a committed batch replays/conflicts. This
    // anchors the check to the pending request so a later question can never be
    // mistaken for a replay of an earlier one (deadlock-free, spec §11.5).
    for (let index = requests.length - 1; index >= 0; index -= 1) {
      const request = requests[index];
      const committed = await this.#service.events.readBatchByCommitId(taskId, `answer-${request.id}`);
      if (committed === null) {
        return 'none';
      }
      const answered = committed.find((entry) => entry.event.type === 'human_answered');
      if (
        answered !== undefined &&
        answered.event.type === 'human_answered' &&
        answered.event.answer === answer
      ) {
        return 'replayed';
      }
      return 'conflict';
    }
    return 'none';
  }

  // --------------------------------------------------------------------------
  // Structured stop / crash recovery (design §11.5 / §25.6 G03).
  // --------------------------------------------------------------------------

  /** Started-without-terminal structured attempts across all input nodes. */
  private danglingStructuredAttempts(events: readonly TaskEvent[]): ActiveAttempt[] {
    const terminalTurns = new Set<string>();
    for (const event of events) {
      if (event.type === 'structured_slot_attempt_terminal') {
        terminalTurns.add(event.turnId);
      }
    }
    const attempts: ActiveAttempt[] = [];
    for (const event of events) {
      if (event.type !== 'structured_slot_attempt_started') {
        continue;
      }
      if (terminalTurns.has(event.turnId)) {
        continue;
      }
      attempts.push({
        inputNodeId: event.inputNodeId,
        attemptEpoch: event.attemptEpoch,
        turnId: event.turnId,
        sessionKind: event.sessionKind,
      });
    }
    return attempts;
  }

  /** The committed logical tail (the appendBatch CAS anchor). */
  private tailSequence(committed: readonly CommittedEvent[]): number {
    return committed[committed.length - 1]?.sequence ?? 0;
  }

  /**
   * Closes every active structured attempt with the Draft/Attempt abandonment
   * facts AND the lifecycle event in ONE batch per attempt (the single-slot
   * scheduler holds at most one), then best-effort reconciles private caches
   * (design §11.5 / spec §8.1). Returns true when at least one attempt was
   * closed (the caller then skips the separate lifecycle append).
   */
  private async closeActiveStructuredAttempt(
    taskId: string,
    reason: 'task_stop' | 'crash_recovery',
  ): Promise<boolean> {
    const committed = await this.#service.events.read(taskId);
    const events = committed.map((entry) => entry.event);
    const attempts = this.danglingStructuredAttempts(events);
    if (attempts.length === 0) {
      return false;
    }
    const at = new Date().toISOString();
    const openedByTurn = new Map<string, Extract<TaskEvent, { type: 'structured_fill_draft_opened' }>>();
    for (const event of events) {
      if (event.type === 'structured_fill_draft_opened') {
        openedByTurn.set(event.turnId, event);
      }
    }
    const lifecycleEvent: TaskEvent = {
      id: reason === 'task_stop' ? `${taskId}-task-stopped` : `${taskId}-task-interrupted`,
      at,
      type: reason === 'task_stop' ? 'task_stopped' : 'task_interrupted',
    };
    let first = true;
    for (const attempt of attempts) {
      const companions: TaskEvent[] = [];
      if (attempt.sessionKind === 'fill') {
        const opened = openedByTurn.get(attempt.turnId);
        if (opened !== undefined) {
          companions.push({
            id: `${opened.draftId}-terminal`,
            at,
            type: 'structured_fill_draft_terminal',
            draftId: opened.draftId,
            turnId: attempt.turnId,
            status: 'abandoned',
            baseRevision: opened.baseRevision,
            resultRevision: 0,
            changeCount: 0,
            content: null,
          });
        }
      }
      if (first) {
        companions.push(lifecycleEvent);
        first = false;
      }
      try {
        await terminalize({
          taskId,
          inputNodeId: attempt.inputNodeId,
          attemptEpoch: attempt.attemptEpoch,
          turnId: attempt.turnId,
          status: 'abandoned',
          reason,
          companions,
          expectedTail: this.tailSequence(committed),
          readEvents: async () => this.#service.events.read(taskId),
          appendBatch: (commitId, batch, expectedLastSequence) =>
            this.#service.events.appendBatch(taskId, commitId, batch, { expectedLastSequence }),
        });
      } catch (error) {
        if (error instanceof StorageError && error.code === STORAGE_ERROR_CODES.EVENT_ID_CONFLICT) {
          // A competitor already closed this attempt (its terminal event id is
          // committed); the caller appends the lifecycle event separately.
          continue;
        }
        throw error;
      }
    }
    await this.reconcilePrivateCaches(taskId, attempts);
    // The caller skips the separate lifecycle append only when the abandonment
    // batch actually carried it (wiring note 2: read the full terminal batch —
    // a racing loser's terminalize returns only the single terminal entry).
    const firstAttempt = attempts[0];
    if (firstAttempt !== undefined) {
      const batch = await this.#service.events.readBatchByCommitId(
        taskId,
        `${firstAttempt.turnId}-terminal`,
      );
      return batch?.some((entry) => entry.event.type === lifecycleEvent.type) ?? false;
    }
    return false;
  }

  /**
   * Startup recovery for a structured task (design §11.5): scans dangling
   * starts and commits the Draft terminal when opened + abandoned/crash_recovery
   * + task_interrupted in ONE authority batch via the coordinator, then
   * best-effort reconciles private caches. Returns true when a dangling attempt
   * was closed (the caller then skips the separate lifecycle append).
   */
  private async recoverStructuredTask(
    taskId: string,
    committed: readonly CommittedEvent[],
  ): Promise<boolean> {
    const attempts = this.danglingStructuredAttempts(committed.map((entry) => entry.event));
    if (attempts.length === 0) {
      return false;
    }
    const result = await recoverDanglingAttempts({
      taskId,
      events: committed,
      appendBatch: (commitId, batch, expectedLastSequence) =>
        this.#service.events.appendBatch(taskId, commitId, batch, { expectedLastSequence }),
      companions: [{ id: randomUUID(), at: new Date().toISOString(), type: 'task_interrupted' }],
    });
    if (result.committed !== null) {
      await this.reconcilePrivateCaches(taskId, attempts);
    }
    return true;
  }

  /**
   * Best-effort private-cache reconciliation AFTER an authority batch (design
   * O02): clears the lifecycle-cache markers of the abandoned Proposal/Draft so
   * a later read rebuilds them from events. Never gates anything — a crash here
   * is repaired from events on the next startup.
   */
  private async reconcilePrivateCaches(taskId: string, attempts: readonly ActiveAttempt[]): Promise<void> {
    try {
      const store = new StructuredSlotPrivateStore(this.#service.paths, taskId);
      for (const attempt of attempts) {
        if (attempt.sessionKind === 'fill') {
          await store.clearDraftLifecycleCache(deriveDraftId(attempt.turnId));
        } else if (attempt.sessionKind === 'structure') {
          await store.clearProposalLifecycleCache(`${attempt.turnId}-proposal`);
        }
      }
    } catch {
      // Best-effort only: the authority batch is the source of truth (O02).
    }
  }

  /**
   * Continue (spec §11.1 A): human_answered clears the guard request;
   * pending_inputs_superseded voids every current pending input; a fresh
   * synthesized input goes to the stalest voided pending's recipient, carrying
   * the guidance text as body and the voided input's inputVersion (spec §11.3).
   * Falls back to the guard request's agent with inputVersion=null when no
   * pending input exists (spec §11.6).
   */
  private async applyContinue(
    taskId: string,
    events: readonly TaskEvent[],
    pendingRequest: Extract<TaskEvent, { type: 'human_requested' }>,
    text: string,
  ): Promise<void> {
    const pendingIds = currentPendingInputIds(events);
    const stalest = stalestPendingInput(events);
    const targetAgentId = stalest?.node.agentId ?? pendingRequest.node.agentId;
    const inputVersion = stalest?.node.inputVersion ?? null;
    await this.appendHumanAnswered(taskId, events, pendingRequest, text, 'continue');
    if (pendingIds.length > 0) {
      await this.appendSupersede(taskId, pendingIds);
    }
    await this.appendSynthesizedInput(taskId, events, {
      agentId: targetAgentId,
      body: text,
      inputVersion,
      humanAuthorized: false,
      suffix: 'continue',
    });
  }

  /**
   * Accept (spec §11.1 B): server re-validates at least one published version
   * (spec §11.5); human_answered clears the guard; pending_inputs_superseded
   * voids every current pending input; a synthesized input goes to the final
   * submitter (controller) with the latest published version and
   * `humanAuthorized: true`. The reject record stays; the human accept is the
   * explicit exception (spec §11.1 B 5).
   */
  private async applyAccept(
    taskId: string,
    events: readonly TaskEvent[],
    pendingRequest: Extract<TaskEvent, { type: 'human_requested' }>,
    text: string,
  ): Promise<void> {
    const latest = latestPublishedVersion(events);
    if (latest === null) {
      throw invalidTransition('当前任务尚无已发布产物版本，无法采用人工接受。');
    }
    const frozen = await this.#service.tasks.readFrozenTemplate(taskId);
    const submitter = frozen.finalOutput.submitters[0];
    if (submitter === undefined) {
      throw invalidTransition('模板未声明最终提交者，无法采用人工接受。');
    }
    const pendingIds = currentPendingInputIds(events);
    await this.appendHumanAnswered(taskId, events, pendingRequest, text, 'accept');
    if (pendingIds.length > 0) {
      await this.appendSupersede(taskId, pendingIds);
    }
    await this.appendSynthesizedInput(taskId, events, {
      agentId: submitter,
      body: text,
      inputVersion: latest,
      humanAuthorized: true,
      suffix: 'accept',
    });
  }

  /**
   * Stop (spec §11.1 C): human_answered clears the guard request, then the
   * task is stopped. Reuses the stop lifecycle event; the synthesized
   * continue/accept input is not created. The run controller is aborted so the
   * `execute` loop never runs a pending input that the stop just voided by
   * clearing the guard - matching the existing `stop` lifecycle (abort + task
   * _stopped).
   */
  private async applyStop(
    taskId: string,
    run: ActiveRun,
    events: readonly TaskEvent[],
    pendingRequest: Extract<TaskEvent, { type: 'human_requested' }>,
  ): Promise<void> {
    await this.appendHumanAnswered(taskId, events, pendingRequest, '已选择停止任务。');
    await this.appendLifecycle(taskId, 'task_stopped');
    run.controller.abort();
  }

  /** Appends `human_answered` clearing the pending request (no fresh input). */
  private async appendHumanAnswered(
    taskId: string,
    events: readonly TaskEvent[],
    pendingRequest: Extract<TaskEvent, { type: 'human_requested' }>,
    text: string,
    decision?: 'continue' | 'accept',
  ): Promise<void> {
    const agentId = pendingRequest.node.agentId;
    const frozen = await this.#service.tasks.readFrozenTemplate(taskId);
    const agentName = frozen.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
    const sequence = nextSequence(events);
    await this.#service.events.append(taskId, {
      id: randomUUID(),
      at: new Date().toISOString(),
      type: 'human_answered',
      node: {
        sequence,
        agentId,
        kind: 'human_answer',
        title: agentName,
        body: text,
        status: 'confirmed',
        attemptCount: 1,
        inputVersion: null,
      },
      answer: text,
      // The structured progress-guard decision is persisted so a crash between
      // supersede and synthesize is deterministically recoverable (spec §11.6).
      ...(decision === undefined ? {} : { decision }),
    });
  }

  /** Appends `pending_inputs_superseded` voiding the given input node ids. */
  private async appendSupersede(
    taskId: string,
    inputIds: readonly string[],
  ): Promise<void> {
    await this.#service.events.append(taskId, {
      id: randomUUID(),
      at: new Date().toISOString(),
      type: 'pending_inputs_superseded',
      supersededNodeIds: [...inputIds],
    });
  }

  /**
   * Appends the synthesized agent_input for continue/accept. The id is
   * deterministic - `synthesize-<suffix>-<round>` where `<round>` is the count
   * of `pending_inputs_superseded` events already committed - so a crash
   * between supersede and synthesize is recoverable (re-appending the same id
   * is idempotent, spec §11.6) and multiple intervention rounds never collide.
   * The sequence skips one slot ahead of the baseline: the `human_answered`
   * node (and, when pending inputs exist, the supersede event) already
   * committed consume the intervening sequences.
   */
  private async appendSynthesizedInput(
    taskId: string,
    events: readonly TaskEvent[],
    parts: {
      agentId: string;
      body: string;
      inputVersion: number | null;
      humanAuthorized: boolean;
      suffix: string;
    },
    roundOverride?: number,
  ): Promise<void> {
    const frozen = await this.#service.tasks.readFrozenTemplate(taskId);
    const agentName = frozen.agents.find((agent) => agent.id === parts.agentId)?.name ?? parts.agentId;
    // The intervention round: the supersede count the SYNTH time sees. Callers
    // that synthesize during applyContinue/applyAccept pass the pre-answer
    // events (the count before this intervention's own supersede); the crash
    // repair passes the same derived round so the re-appended id matches.
    const round = roundOverride ?? events.filter((event) => event.type === 'pending_inputs_superseded').length;
    const sequence = nextSequence(events) + 1;
    const node: TaskEvent = {
      id: `synthesize-${parts.suffix}-${round}`,
      at: new Date().toISOString(),
      type: 'agent_input',
      node: {
        sequence,
        agentId: parts.agentId,
        kind: 'input',
        title: agentName,
        body: parts.body,
        status: 'confirmed',
        attemptCount: 1,
        inputVersion: parts.inputVersion,
        ...(parts.humanAuthorized ? { humanAuthorized: true } : {}),
      },
    };
    await this.#service.events.append(taskId, node);
  }

  /**
   * Crash half-state repair (spec §11.6, semantic audit P2 plan 2026-08-07):
   * a process death between `human_answered + pending_inputs_superseded` and
   * the synthesized continue/accept input leaves a task with no executable
   * pending input. On re-entry this finds the most recent human_answered that
   * carries a persisted decision, and — when its deterministic
   * `synthesize-<decision>-<round>` input is missing — re-applies the missing
   * steps: supersede any still-pending inputs, then synthesize the decision
   * input. Deterministic and idempotent: never a duplicate supersede for an
   * already-voided round, never two synthesized inputs, and `humanAuthorized`
   * is only ever produced by the accept decision (never from a model action).
   */
  private async repairInterventionHalfState(taskId: string): Promise<void> {
    const committed = await this.#service.events.read(taskId);
    const events = committed.map((entry) => entry.event);
    let decision: 'continue' | 'accept' | null = null;
    let answeredText = '';
    let answeredIndex = -1;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (
        event.type === 'human_answered' &&
        (event.decision === 'continue' || event.decision === 'accept')
      ) {
        decision = event.decision;
        answeredText = event.answer;
        answeredIndex = index;
      }
    }
    if (decision === null || answeredIndex < 0) {
      return; // No structured intervention was ever answered.
    }
    // The intervention round mirrors applyContinue/applyAccept: the supersede
    // count the synth would have seen at its commit time (the count before the
    // answered event's own supersede, i.e. before answeredIndex).
    let round = 0;
    for (let index = 0; index < answeredIndex; index += 1) {
      if (events[index].type === 'pending_inputs_superseded') {
        round += 1;
      }
    }
    const expectedId = `synthesize-${decision}-${round}`;
    const synthesized = events.some(
      (event) => event.type === 'agent_input' && event.id === expectedId,
    );
    if (synthesized) {
      return; // The flow completed; nothing to repair.
    }
    // Re-apply the missing steps: supersede any inputs not yet voided, then
    // synthesize the decision's input under the SAME round (deterministic id).
    const pendingIds = currentPendingInputIds(events);
    if (pendingIds.length > 0) {
      await this.appendSupersede(taskId, pendingIds);
    }
    const fresh = await this.#service.events.read(taskId);
    const freshEvents = fresh.map((entry) => entry.event);
    if (decision === 'continue') {
      // The continue recipient is the stalest VOIDED pending input when the
      // supersede already committed (the crash point), else the stalest
      // still-pending input (crash before supersede).
      const supersededIds = events
        .filter((event) => event.type === 'pending_inputs_superseded')
        .flatMap((event) =>
          event.type === 'pending_inputs_superseded' ? event.supersededNodeIds : [],
        );
      const supersededInputs = supersededIds
        .map((id) =>
          events.find(
            (candidate): candidate is Extract<TaskEvent, { type: 'agent_input' }> =>
              candidate.type === 'agent_input' && candidate.id === id,
          ),
        )
        .filter((candidate): candidate is Extract<TaskEvent, { type: 'agent_input' }> =>
          candidate !== undefined,
        )
        .sort((a, b) => a.node.sequence - b.node.sequence);
      const stalest = supersededInputs[0] ?? stalestPendingInput(freshEvents);
      if (stalest === null || stalest === undefined) {
        return; // No recipient derivable; leave the task as-is.
      }
      await this.appendSynthesizedInput(
        taskId,
        freshEvents,
        {
          agentId: stalest.node.agentId,
          body: answeredText,
          inputVersion: stalest.node.inputVersion,
          humanAuthorized: false,
          suffix: 'continue',
        },
        round,
      );
    } else {
      const latest = latestPublishedVersion(freshEvents);
      if (latest === null) {
        return;
      }
      const frozen = await this.#service.tasks.readFrozenTemplate(taskId);
      const submitter = frozen.finalOutput.submitters[0];
      if (submitter === undefined) {
        return;
      }
      await this.appendSynthesizedInput(
        taskId,
        freshEvents,
        {
          agentId: submitter,
          body: answeredText,
          inputVersion: latest,
          humanAuthorized: true,
          suffix: 'accept',
        },
        round,
      );
    }
  }

  /** Appends the human answer plus a fresh input for the requesting agent. */
  private async appendHumanAnswer(
    taskId: string,
    events: readonly TaskEvent[],
    pendingRequest: Extract<TaskEvent, { type: 'human_requested' }>,
    answer: string,
  ): Promise<void> {
    const agentId = pendingRequest.node.agentId;
    const frozen = await this.#service.tasks.readFrozenTemplate(taskId);
    const agentName = frozen.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
    const sequence = nextSequence(events);
    const at = new Date().toISOString();
    await this.#service.events.append(taskId, {
      id: randomUUID(),
      at,
      type: 'human_answered',
      node: {
        sequence,
        agentId,
        kind: 'human_answer',
        title: agentName,
        body: answer,
        status: 'confirmed',
        attemptCount: 1,
        inputVersion: null,
      },
      answer,
    });
    await this.#service.events.append(taskId, {
      id: randomUUID(),
      at,
      type: 'agent_input',
      node: {
        sequence: sequence + 1,
        agentId,
        kind: 'input',
        title: agentName,
        body: answer,
        status: 'confirmed',
        attemptCount: 1,
        inputVersion: null,
      },
    });
  }
}
