/**
 * Deterministic script-driven AgentRuntime (plan Phase C Task 1 Step 6).
 *
 * Scripts are keyed by agent id and advance by invocation count; each
 * scripted Turn returns public text/actions or throws a typed
 * transient/permanent `RuntimeFailure` (the classification surface Task 5's
 * retry policy consumes). AbortSignal is respected before a Turn starts and
 * while waiting on an injected deferred response — aborts surface as
 * `RuntimeAbortedError` and the caller fails its ActionBuffer. The fake
 * accepts scripts only: it has no storage handle and never writes files.
 *
 * Unscripted agents stay NEUTRAL (plan Task 6): when no script was ever
 * registered for an agent, `run` returns one empty successful Turn instead
 * of failing — lifecycle fixtures start tasks whose agents carry no script
 * and must observe a deterministic quiescent loop, never a guessed failure.
 * A REGISTERED script that runs out still fails loud.
 */
import type { TraceEntry } from '../../shared/contracts';
import type {
  AgentRuntime,
  AgentRunOptions,
  AgentTurnInput,
  AgentTurnResult,
} from './agent-runtime';
import { RuntimeAbortedError, RuntimeFailure } from './agent-runtime';
import type { ForgeAction } from './forge-actions';

/** Externally settled promise used to hold scripted Turns in flight. */
export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

/** One scripted workspace write applied through the workspace sink. */
export interface FakeWorkspaceWrite {
  path: string;
  content: string;
}

/**
 * Applies a Turn's scripted workspace writes. Wired by the runner in Task E3;
 * when absent the fake simply skips the writes (never throws).
 */
export type WorkspaceWriteSink = (
  taskId: string,
  agentId: string,
  writes: readonly FakeWorkspaceWrite[],
) => Promise<void>;

export interface FakeResultStep {
  kind: 'result';
  publicText?: string;
  actions?: ForgeAction[];
  usage?: { inputTokens: number; outputTokens: number } | null;
  /** Optional thinking step surfaced in the Turn trace (display only). */
  thinking?: string;
  /** Optional workspace writes applied through the sink and traced. */
  workspaceWrites?: FakeWorkspaceWrite[];
  /** Awaited (abort-aware) before the step produces its outcome. */
  deferred?: Deferred<unknown>;
}

export interface FakeFailureStep {
  kind: 'failure';
  failure: RuntimeFailure;
  /** Awaited (abort-aware) before the failure is thrown. */
  deferred?: Deferred<unknown>;
}

export type FakeScriptStep = FakeResultStep | FakeFailureStep;

export interface FakeAgentRuntimeOptions {
  /** Scripted Turns per agent id, consumed in invocation order. */
  scripts?: Record<string, readonly FakeScriptStep[]>;
}

function disposeKey(taskId: string, agentId: string): string {
  return `${taskId}:${agentId}`;
}

export class FakeAgentRuntime implements AgentRuntime {
  readonly #scripts = new Map<string, readonly FakeScriptStep[]>();

  readonly #invocations = new Map<string, number>();

  readonly #disposedAgents = new Set<string>();

  #disposedAll = false;

  #workspaceSink: WorkspaceWriteSink | null = null;

  constructor(options: FakeAgentRuntimeOptions = {}) {
    for (const [agentId, steps] of Object.entries(options.scripts ?? {})) {
      this.#scripts.set(agentId, steps);
    }
  }

  /**
   * Wires the workspace sink that applies scripted workspace writes (Task E3).
   * Without a sink the fake skips the writes and never throws.
   */
  setWorkspaceSink(sink: WorkspaceWriteSink): void {
    this.#workspaceSink = sink;
  }

  /**
   * Runs one scripted Turn. When `options.onLive` is supplied the fake
   * mirrors the streaming adapter's live-preview protocol (plan C): one
   * announce patch before the script runs, one content patch for a result
   * step, and a `finished` patch on EVERY exit path. The fake itself stays
   * storage-free; the sink is memory-only by contract.
   */
  async run(
    input: AgentTurnInput,
    signal: AbortSignal,
    options?: AgentRunOptions,
  ): Promise<AgentTurnResult> {
    if (signal.aborted) {
      throw new RuntimeAbortedError(`turn ${input.turnId} aborted before it started`);
    }
    const agentId = input.agent.id;
    const onLive = options?.onLive;
    const emitLive = (partial: Partial<{ text: string; thinking: string; finished: boolean }>): void => {
      if (onLive === undefined) return;
      try {
        onLive({ agentId, turnId: input.turnId, ...partial });
      } catch {
        // Live preview is best-effort; drop sink failures silently.
      }
    };
    emitLive({});
    try {
      const index = this.#invocations.get(agentId) ?? 0;
      const registered = this.#scripts.get(agentId);
      if (registered === undefined) {
        // Neutral unscripted agent: one empty successful Turn, never a guessed
        // failure (see module docs). The invocation is still counted.
        this.#invocations.set(agentId, index + 1);
        return { turnId: input.turnId, publicText: '', actions: [], usage: null, trace: [] };
      }
      const step = registered[index];
      if (!step) {
        throw new Error(
          `FakeAgentRuntime: agent "${agentId}" has no scripted turn ${index + 1}`,
        );
      }
      this.#invocations.set(agentId, index + 1);
      if (step.deferred) {
        await this.#waitWithAbort(step.deferred, signal);
      }
      if (signal.aborted) {
        throw new RuntimeAbortedError(`turn ${input.turnId} aborted before return`);
      }
      if (step.kind === 'failure') {
        throw step.failure;
      }
      const publicText = step.publicText ?? '';
      emitLive({ text: publicText, thinking: step.thinking ?? '' });
      const trace = await this.#buildTrace(input.taskId, agentId, step, publicText);
      return {
        turnId: input.turnId,
        publicText,
        actions: (step.actions ?? []).map((action) => ({ ...action })),
        usage: step.usage ?? null,
        trace,
      };
    } finally {
      emitLive({ finished: true });
    }
  }

  /**
   * Applies scripted workspace writes through the sink (exactly once), then
   * builds the display-only trace: one call/result pair per applied write,
   * then the public text. Without a sink the writes are skipped. Provider
   * thinking is never durable (semantic audit P0, plan 2026-08-07).
   */
  async #buildTrace(
    taskId: string,
    agentId: string,
    step: FakeResultStep,
    publicText: string,
  ): Promise<TraceEntry[]> {
    const trace: TraceEntry[] = [];
    const writes = step.workspaceWrites ?? [];
    if (writes.length > 0 && this.#workspaceSink !== null) {
      await this.#workspaceSink(taskId, agentId, writes);
      for (const write of writes) {
        trace.push({
          kind: 'tool_call',
          toolName: 'write_workspace',
          params: { path: write.path, content: write.content },
        });
        trace.push({
          kind: 'tool_result',
          toolName: 'write_workspace',
          text: `${write.path} (${Buffer.byteLength(write.content, 'utf8')} bytes)`,
        });
      }
    }
    if (publicText.length > 0) {
      trace.push({ kind: 'text', text: publicText });
    }
    return trace;
  }

  async disposeAgent(taskId: string, agentId: string): Promise<void> {
    this.#disposedAgents.add(disposeKey(taskId, agentId));
  }

  async disposeAll(): Promise<void> {
    this.#disposedAll = true;
  }

  /** Number of scripted Turns already consumed for the agent. */
  countInvocations(agentId: string): number {
    return this.#invocations.get(agentId) ?? 0;
  }

  /**
   * Replaces (or adds) the script for one agent. Task 5's scheduler harness
   * builds scripts from the frozen template, which only exists after the
   * environment — and therefore this runtime — has been constructed.
   */
  setScript(agentId: string, steps: readonly FakeScriptStep[]): void {
    this.#scripts.set(agentId, steps);
    this.#invocations.delete(agentId);
  }

  /** Disposal bookkeeping visible to tests (the fake holds no real session). */
  isDisposed(taskId: string, agentId: string): boolean {
    return this.#disposedAll || this.#disposedAgents.has(disposeKey(taskId, agentId));
  }

  async #waitWithAbort(deferred: Deferred<unknown>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new RuntimeAbortedError('turn aborted while waiting on a deferred script');
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        reject(new RuntimeAbortedError('turn aborted while waiting on a deferred script'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const settle = () => signal.removeEventListener('abort', onAbort);
      deferred.promise.then(
        () => {
          settle();
          resolve();
        },
        (error: unknown) => {
          settle();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}

export { RuntimeAbortedError, RuntimeFailure };
