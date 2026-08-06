/**
 * No-progress guard (plan 2026-08-06): mechanical protection against loops
 * that are structurally legal but semantically spinning — every Turn
 * satisfies the phase machine while the task as a whole never converges.
 *
 * The guard is a PURE evaluation over committed events (the scheduler owns
 * the reaction): it counts committed Turns (`agent_result` events — exactly
 * one per successful Turn, never duplicated by idempotent replay) inside the
 * window that opens after the LAST `human_answered` event (the whole history
 * when none exists). A human answer therefore resets the counter: once a
 * human has intervened the task earns a fresh execution budget.
 *
 * `agent_result` is the metric, not `route_executed`: a publish dispatch
 * fans out one route event per declared artifact route of the publisher,
 * while every committed Turn produces exactly one result event. The last
 * result's agent is the last dispatcher (within a Turn the result commits
 * before its routes).
 *
 * No business vocabulary lives here (iron rule 1); the guard inspects only
 * platform event types and agent ids.
 */
import type { TaskEvent } from '../storage/task-events';

/** The progress limits the scheduler evaluates (injectable for tests). */
export interface ProgressPolicy {
  /**
   * Maximum committed Turns between human interventions. The (limit+1)-th
   * committed Turn trips the guard; healthy runs complete far below it.
   */
  readonly maxTurnsSinceHumanAnswer: number;
}

/**
 * Hard ceiling for template-declared progress budgets (plan 2026-08-06):
 * templates may override the scheduler policy within [1, CEILING], never
 * above — the platform default stays the scheduler's injected policy.
 */
export const PROGRESS_POLICY_CEILING = 32;

/** Default progress limits; the scheduler accepts an injected policy. */
export const PROGRESS_POLICY: ProgressPolicy = Object.freeze({
  maxTurnsSinceHumanAnswer: 8,
});

/** What one evaluation of the committed history reports to the scheduler. */
export interface ProgressEvaluation {
  /** True when the window carries more committed Turns than the limit. */
  exceeded: boolean;
  /** Committed Turns (`agent_result` events) inside the window. */
  turnCount: number;
  /** The limit actually applied. */
  limit: number;
  /** Agent of the LAST committed result in the window; null when none. */
  lastDispatchAgentId: string | null;
  /**
   * True when the window holds a `human_requested` with no later
   * `human_answered` — the run loop must never execute a Turn while a
   * question is pending.
   */
  hasUnansweredHumanRequest: boolean;
}

/**
 * Evaluates one task's committed history against the progress policy.
 * Events are consumed in committed (sequence) order; the window opens right
 * after the LAST `human_answered` event, so requests answered before the
 * window never surface as pending.
 */
export function evaluateProgress(
  events: readonly TaskEvent[],
  policy: ProgressPolicy = PROGRESS_POLICY,
): ProgressEvaluation {
  let windowStart = 0;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].type === 'human_answered') {
      windowStart = index + 1;
    }
  }
  let turnCount = 0;
  let lastDispatchAgentId: string | null = null;
  let hasUnansweredHumanRequest = false;
  for (let index = windowStart; index < events.length; index += 1) {
    const event = events[index];
    if (event.type === 'agent_result') {
      turnCount += 1;
      lastDispatchAgentId = event.node.agentId;
    } else if (event.type === 'human_requested') {
      // No human_answered exists inside the window by construction, so any
      // request found here is unanswered.
      hasUnansweredHumanRequest = true;
    }
  }
  return {
    exceeded: turnCount > policy.maxTurnsSinceHumanAnswer,
    turnCount,
    limit: policy.maxTurnsSinceHumanAnswer,
    lastDispatchAgentId,
    hasUnansweredHumanRequest,
  };
}

/**
 * The frozen public question the guard commits when it parks a task
 * (platform-generic, zero business vocabulary — iron rules 1/6).
 */
export const PROGRESS_GUARD_QUESTION =
  '系统检测到本任务已连续自动执行多个回合仍未结束，已达到平台设定的进度上限，现暂停自动调度。请直接回复，指示下一步如何处理（例如继续推进、调整要求，或停止任务）。';
