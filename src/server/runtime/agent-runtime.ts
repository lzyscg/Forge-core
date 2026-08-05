/**
 * Isolated Agent runtime contract (plan Phase C Task 1 Step 3, verbatim).
 *
 * Forge Core never implements its own model loop (spec §3.5): a runtime
 * adapter (Task 2 thin Pi adapter, Task 1 deterministic fake) executes one
 * model Turn and returns only public text plus buffered Forge actions. The
 * platform serializes execution, validates actions and owns every confirmed
 * event — the runtime itself never writes storage.
 *
 * Typed failures (`RuntimeFailure` with `retryable` + stable code, and
 * `RuntimeAbortedError`) give Task 5's retry policy a classification surface:
 * transient provider/network failures retry, permanent ones surface, aborts
 * are neither. Messages stay presentable — no credentials, hidden thinking
 * or raw causes (iron rule 6).
 */
import type { SkillSummary, TraceEntry } from '../../shared/contracts';
import type { FrozenAgentConfig } from '../template/template-schema';
import type { ForgeAction } from './forge-actions';

export interface AgentTurnInput {
  taskId: string;
  turnId: string;
  agent: FrozenAgentConfig;
  inputNodeId: string;
  inputText: string;
  publicHistory: Array<{ role: 'user' | 'assistant' | 'tool'; text: string }>;
  availableSkills: SkillSummary[];
  loadedSkills: Array<{ id: string; content: string; versionHash: string }>;
}

export interface AgentTurnResult {
  turnId: string;
  publicText: string;
  actions: ForgeAction[];
  usage: { inputTokens: number; outputTokens: number } | null;
  /**
   * Display-only observable steps of the Turn (plan Phase E, Global
   * Constraint 5). Runtimes without trace collection return an empty array;
   * traces never feed delivery gates.
   */
  trace: readonly TraceEntry[];
}

/**
 * One live-preview update of an in-flight Turn (plan C realtime streaming).
 * Patches are display-only and memory-bound: they never reach storage, so
 * streamed thinking fragments are never persisted. `text`/`thinking` carry
 * the CUMULATIVE content streamed so far (a patch may omit a field to leave
 * it unchanged); `finished` drops the buffer on every run exit path.
 */
export interface LivePatch {
  agentId: string;
  turnId: string;
  text?: string;
  thinking?: string;
  /** A tool call started executing (by tool name). */
  toolStarted?: string;
  /** A tool call finished executing (by tool name). */
  toolFinished?: string;
  /** True once the Turn ends (success, failure or abort). */
  finished?: boolean;
}

/** Per-run options; all optional so existing call sites stay unchanged. */
export interface AgentRunOptions {
  /**
   * Display-only live-preview sink (plan C realtime streaming). Runtimes
   * that support streaming call it as content arrives and once more with
   * `finished` when the run exits; runtimes without streaming ignore it.
   */
  onLive?: (patch: LivePatch) => void;
}

export interface AgentRuntime {
  run(input: AgentTurnInput, signal: AbortSignal, options?: AgentRunOptions): Promise<AgentTurnResult>;
  disposeAgent(taskId: string, agentId: string): Promise<void>;
  disposeAll(): Promise<void>;
}

/** Stable runtime error codes owned by this contract. */
export const RUNTIME_ERROR_CODES = {
  /** The Turn was aborted by the caller (stop/dispose); never retryable. */
  RUNTIME_ABORTED: 'RUNTIME_ABORTED',
} as const;

/**
 * Typed runtime failure carrying a stable code and the retry classification.
 * Task 5's retry policy consumes `retryable`; scripted failures produced by
 * `RuntimeFailure.transient/permanent` keep tests deterministic.
 */
export class RuntimeFailure extends Error {
  readonly code: string;

  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(`${code}: ${message}`);
    this.name = 'RuntimeFailure';
    this.code = code;
    this.retryable = retryable;
  }

  /** Transient provider/network failure — eligible for bounded auto retry. */
  static transient(code: string, message: string): RuntimeFailure {
    return new RuntimeFailure(code, message, true);
  }

  /** Permanent configuration/permission/format failure — never auto retried. */
  static permanent(code: string, message: string): RuntimeFailure {
    return new RuntimeFailure(code, message, false);
  }
}

/** Raised when a Turn is aborted through its AbortSignal. */
export class RuntimeAbortedError extends Error {
  readonly code: typeof RUNTIME_ERROR_CODES.RUNTIME_ABORTED =
    RUNTIME_ERROR_CODES.RUNTIME_ABORTED;

  constructor(message = 'the agent turn was aborted') {
    super(`${RUNTIME_ERROR_CODES.RUNTIME_ABORTED}: ${message}`);
    this.name = 'RuntimeAbortedError';
  }
}
