/**
 * Memory-only live-preview buffer (plan C realtime streaming).
 *
 * Merges the runtime's `LivePatch` stream into one `LiveTurn` per task —
 * the value `CoreService.getWorkspace` attaches as `activeTurn` while a
 * Turn is in flight. The buffer is strictly in-memory: nothing here is
 * written to files or events, so streamed thinking fragments can never
 * persist (credentials and hidden chains stay ephemeral, iron rule 6).
 * One task runs at most one Turn at a time, so one entry per task suffices.
 */
import type { LiveToolCall, LiveTurn } from '../../shared/contracts';
import type { LivePatch } from './agent-runtime';

export interface LiveStoreOptions {
  /** Injectable clock for deterministic tests; defaults to system time. */
  clock?: () => Date;
}

export class LiveStore {
  readonly #turns = new Map<string, LiveTurn>();

  readonly #clock: () => Date;

  constructor(options: LiveStoreOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
  }

  /**
   * Merges one patch into the task's buffer. `finished` drops the buffer on
   * every run exit path; cumulative `text`/`thinking` replace the previous
   * values; tool events move named calls running→done in event order (a
   * completion without a matching start is recorded done, never dropped).
   */
  merge(taskId: string, patch: LivePatch): void {
    if (patch.finished === true) {
      this.#turns.delete(taskId);
      return;
    }
    const existing = this.#turns.get(taskId);
    const tools: LiveToolCall[] = existing === undefined ? [] : existing.tools.map(cloneTool);
    if (patch.toolStarted !== undefined) {
      tools.push({ name: patch.toolStarted, state: 'running' });
    }
    if (patch.toolFinished !== undefined) {
      const index = findLastRunning(tools, patch.toolFinished);
      if (index >= 0) {
        tools[index] = { name: patch.toolFinished, state: 'done' };
      } else {
        tools.push({ name: patch.toolFinished, state: 'done' });
      }
    }
    this.#turns.set(taskId, {
      agentId: patch.agentId,
      turnId: patch.turnId,
      status: 'running',
      text: patch.text ?? existing?.text ?? '',
      thinking: patch.thinking ?? existing?.thinking ?? '',
      tools,
      updatedAt: this.#clock().toISOString(),
    });
  }

  /** The task's live turn, or null; callers receive a defensive copy. */
  get(taskId: string): LiveTurn | null {
    const live = this.#turns.get(taskId);
    if (live === undefined) {
      return null;
    }
    return { ...live, tools: live.tools.map(cloneTool) };
  }

  /** Drops the buffer explicitly (e.g. task-level cleanup). */
  clear(taskId: string): void {
    this.#turns.delete(taskId);
  }
}

function cloneTool(tool: LiveToolCall): LiveToolCall {
  return { name: tool.name, state: tool.state };
}

function findLastRunning(tools: readonly LiveToolCall[], name: string): number {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (tools[index].name === name && tools[index].state === 'running') {
      return index;
    }
  }
  return -1;
}
