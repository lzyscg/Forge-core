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
import type { TaskStatus, TaskSummary } from '../../shared/contracts';
import {
  TASK_CONTRACT_INCOMPATIBLE_ACTION,
  TASK_CONTRACT_INCOMPATIBLE_MESSAGE,
  TASK_ERROR_CODES,
  type PublicCoreError,
} from '../../shared/errors';
import type { CoreService } from '../core-service';
import type { TaskEvent } from '../storage/task-events';
import { isTurnContractSupported } from '../template/template-schema';
import { RuntimeAbortedError } from './agent-runtime';
import type { AgentRuntime } from './agent-runtime';
import type { AcceptanceStopHook } from '../acceptance-boundary';
import { MAX_AUTO_RETRIES, autoRetryDelayMs } from './retry-policy';
import type { TaskRunner } from './task-runner';

/** Stable scheduler error codes owned by this module. */
export const SCHEDULER_ERROR_CODES = {
  /** A task already holds the single process-wide execution slot. */
  TASK_ALREADY_RUNNING: 'TASK_ALREADY_RUNNING',
  /** The projected task status does not allow the requested lifecycle move. */
  INVALID_TRANSITION: 'INVALID_TRANSITION',
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
  /** Retry timing hooks; production defaults unless tests inject their own. */
  retryPolicy?: RetryPolicyHooks;
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

export class TaskScheduler {
  /** The runtime this scheduler drives (tests observe concurrency on it). */
  readonly runtime: AgentRuntime;

  readonly #service: CoreService;

  readonly #runner: TaskRunner;

  readonly #maxAutoRetries: number;

  readonly #retryDelayMs: (retryNumber: number) => number;

  readonly #retrySleep: (ms: number, signal: AbortSignal) => Promise<void>;

  readonly #acceptanceStopAfterCommit: AcceptanceStopHook | undefined;

  #current: ActiveRun | null = null;

  #shutdown = false;

  constructor(options: TaskSchedulerOptions) {
    this.#service = options.service;
    this.#runner = options.runner;
    this.runtime = options.runtime;
    const policy = options.retryPolicy ?? {};
    this.#maxAutoRetries = policy.maxAutoRetries ?? MAX_AUTO_RETRIES;
    this.#retryDelayMs = policy.delayMs ?? ((retryNumber) => autoRetryDelayMs(retryNumber));
    this.#retrySleep = policy.sleep ?? defaultRetrySleep;
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
  async answer(taskId: string, answer: string): Promise<TaskSummary> {
    const { completion } = await this.answerDetached(taskId, answer);
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
  async answerDetached(taskId: string, answer: string): Promise<AcceptedLifecycle> {
    if (typeof answer !== 'string' || answer.trim().length === 0) {
      throw invalidTransition('人工回答不能为空。');
    }
    return this.acceptDetached(taskId, 'answer', answer);
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
    await this.appendLifecycle(taskId, 'task_stopped');
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
   * and terminal tasks are never modified. Returns the interrupted ids.
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
      // Corrupt tasks stay isolated: identity/snapshot reads that throw leave
      // them exactly where the projection already placed them.
      let snapshotSupported: boolean;
      try {
        const frozen = await this.#service.tasks.readFrozenTemplate(summary.id);
        snapshotSupported = isTurnContractSupported(frozen);
      } catch {
        continue;
      }
      if (!snapshotSupported) {
        await this.markIncompatibleOnce(summary.id);
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
  private async markIncompatibleOnce(taskId: string): Promise<void> {
    const committed = await this.#service.events.read(taskId);
    if (committed.some((entry) => entry.event.type === 'task_incompatible')) {
      return;
    }
    await this.#service.events.append(taskId, {
      id: randomUUID(),
      at: new Date().toISOString(),
      type: 'task_incompatible',
      reason: 'TURN_CONTRACT_REQUIRED',
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
        if (ACTIVE_STATUSES.has(workspace.task.status)) {
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
    answer?: string,
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
    answer?: string,
  ): Promise<void> {
    try {
      const workspace = await this.#service.getWorkspace(taskId);
      const frozen = await this.#service.tasks.readFrozenTemplate(taskId);
      if (!isTurnContractSupported(frozen)) {
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
        if (status !== 'waiting_human') {
          throw invalidTransition('只有等待人工回答的任务可以提交回答。');
        }
        await this.appendHumanAnswer(taskId, answer ?? '');
      }
    } catch (error) {
      this.release(run);
      throw error;
    }
  }

  /**
   * The run loop: one `runNext` at a time until a rest state (spec §3.3),
   * with bounded automatic retry of retryable failures (spec §7.1).
   */
  private async execute(run: ActiveRun): Promise<TaskSummary> {
    let autoRetries = 0;
    try {
      for (;;) {
        if (run.controller.signal.aborted) {
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
    return workspace.task;
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
        artifactVersion: null,
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

  /** Appends the human answer plus a fresh input for the requesting agent. */
  private async appendHumanAnswer(taskId: string, answer: string): Promise<void> {
    const committed = await this.#service.events.read(taskId);
    const events = committed.map((entry) => entry.event);
    let pendingRequest: Extract<TaskEvent, { type: 'human_requested' }> | null = null;
    for (const event of events) {
      if (event.type === 'human_requested') {
        pendingRequest = event;
      } else if (event.type === 'human_answered') {
        pendingRequest = null;
      }
    }
    if (pendingRequest === null) {
      throw invalidTransition('没有等待回答的人工输入请求。');
    }
    const agentId = pendingRequest.node.agentId;
    const frozen = await this.#service.tasks.readFrozenTemplate(taskId);
    const agentName = frozen.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
    let sequence = 0;
    for (const event of events) {
      if ('node' in event) {
        sequence = Math.max(sequence, event.node.sequence);
      }
      if ('route' in event) {
        sequence = Math.max(sequence, event.route.sequence);
      }
    }
    const at = new Date().toISOString();
    await this.#service.events.append(taskId, {
      id: randomUUID(),
      at,
      type: 'human_answered',
      node: {
        sequence: sequence + 1,
        agentId,
        kind: 'human_answer',
        title: agentName,
        body: answer,
        status: 'confirmed',
        attemptCount: 1,
        artifactVersion: null,
      },
      answer,
    });
    await this.#service.events.append(taskId, {
      id: randomUUID(),
      at,
      type: 'agent_input',
      node: {
        sequence: sequence + 2,
        agentId,
        kind: 'input',
        title: agentName,
        body: answer,
        status: 'confirmed',
        attemptCount: 1,
        artifactVersion: null,
      },
    });
  }
}
