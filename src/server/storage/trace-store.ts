/**
 * Per-turn execution trace store (plan Phase E Task 1).
 *
 * One trace = one immutable file `tasks/<id>/traces/<turnId>.json`, written
 * with `writeNewAtomic` (plan Global Constraint 5). Traces are display-only
 * observability: they never enter the canonical `TaskEvent` union, never
 * feed delivery gates, and damage isolates to the single trace view —
 * `readTurnTrace` maps every failure to `null` instead of poisoning the
 * task. Appends are serialized per task through the same mutex-queue pattern
 * as the event store, a duplicate turnId is idempotent (the first write
 * wins, FILE_EXISTS stays silent), and oversized traces are truncated to the
 * declared limits instead of throwing.
 *
 * No business vocabulary lives here (iron rule 1).
 */
import { readFile } from 'node:fs/promises';
import type { TraceEntry, TurnTrace, TurnTracePhase } from '../../shared/contracts';
import { STORAGE_ERROR_CODES, StorageError, writeNewAtomic } from './atomic-file';
import type { CorePaths } from './core-paths';

/** Display-side bounds for one trace; enforced on append, never throwing. */
export const TRACE_LIMITS = { maxEntries: 1024, maxEntryChars: 262_144 } as const;

const TRUNCATION_MARKER = '…[truncated]';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function truncateText(text: string): string {
  if (text.length <= TRACE_LIMITS.maxEntryChars) {
    return text;
  }
  return (
    text.slice(0, TRACE_LIMITS.maxEntryChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
  );
}

/** Bounds one entry in place: text fields truncated, oversized params dropped. */
function limitEntry(entry: TraceEntry): TraceEntry {
  switch (entry.kind) {
    case 'text':
      return { kind: 'text', text: truncateText(entry.text) };
    case 'tool_result':
      return { kind: 'tool_result', toolName: entry.toolName, text: truncateText(entry.text) };
    case 'tool_call': {
      const params = isPlainObject(entry.params) ? entry.params : {};
      if (JSON.stringify(params).length > TRACE_LIMITS.maxEntryChars) {
        return { kind: 'tool_call', toolName: entry.toolName, params: {} };
      }
      return { kind: 'tool_call', toolName: entry.toolName, params };
    }
  }
}

function applyTraceLimits(entries: readonly TraceEntry[]): TraceEntry[] {
  return entries.slice(0, TRACE_LIMITS.maxEntries).map(limitEntry);
}

/** Minimal read-side validation: anything unexpected isolates to null. */
function parseTraceEntry(raw: unknown): TraceEntry | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  switch (raw.kind) {
    case 'text':
      return typeof raw.text === 'string' ? { kind: 'text', text: raw.text } : null;
    case 'tool_call':
      return typeof raw.toolName === 'string' && isPlainObject(raw.params)
        ? { kind: 'tool_call', toolName: raw.toolName, params: raw.params }
        : null;
    case 'tool_result':
      return typeof raw.toolName === 'string' && typeof raw.text === 'string'
        ? { kind: 'tool_result', toolName: raw.toolName, text: raw.text }
        : null;
    default:
      // Including a legacy `thinking` kind: isolated to null (semantic audit
      // P0 — raw provider thinking is never durable).
      return null;
  }
}

const PHASE_STATES: readonly string[] = [
  'production',
  'production_complete',
  'dispatching',
  'dispatched',
  'waiting_human',
  'failed',
];

const PHASE_DISPATCH_ACTIONS: readonly string[] = [
  'send_message',
  'publish_artifact',
  'forward_input_version',
  'submit_final_artifact',
  'request_human_input',
];

/**
 * Strict structural parse of one display-only phase summary (spec §7.4).
 * Anything outside the declared shape isolates to null — a damaged phase
 * never poisons the rest of the trace, it simply disappears from the view.
 */
function parseTurnTracePhase(raw: unknown): TurnTracePhase | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (typeof raw.state !== 'string' || !PHASE_STATES.includes(raw.state)) {
    return null;
  }
  const dispatchAction =
    raw.dispatchAction === null
      ? null
      : typeof raw.dispatchAction === 'string' && PHASE_DISPATCH_ACTIONS.includes(raw.dispatchAction)
        ? raw.dispatchAction
        : null;
  if (raw.dispatchAction !== null && raw.dispatchAction !== undefined && dispatchAction === null) {
    return null;
  }
  const target =
    raw.target === null || raw.target === undefined
      ? null
      : typeof raw.target === 'string'
        ? raw.target
        : null;
  if (raw.target !== null && raw.target !== undefined && target === null) {
    return null;
  }
  const message =
    raw.message === null || raw.message === undefined
      ? null
      : typeof raw.message === 'string'
        ? raw.message
        : null;
  if (raw.message !== null && raw.message !== undefined && message === null) {
    return null;
  }
  return {
    state: raw.state as TurnTracePhase['state'],
    dispatchAction: dispatchAction as TurnTracePhase['dispatchAction'],
    target,
    message,
  };
}

function parseTurnTrace(value: unknown, expectedTurnId: string): TurnTrace | null {
  if (!isPlainObject(value)) {
    return null;
  }
  if (value.turnId !== expectedTurnId) {
    return null;
  }
  if (!Array.isArray(value.entries)) {
    return null;
  }
  const entries: TraceEntry[] = [];
  for (const raw of value.entries) {
    const entry = parseTraceEntry(raw);
    if (entry === null) {
      return null;
    }
    entries.push(entry);
  }
  // Historical traces without a phase stay legal (spec §7.5); a present but
  // malformed phase isolates the whole record to null (fail closed).
  const trace: TurnTrace = { turnId: value.turnId, entries };
  if ('phase' in value && value.phase !== undefined) {
    const phase = parseTurnTracePhase(value.phase);
    if (phase === null) {
      return null;
    }
    trace.phase = phase;
  }
  return trace;
}

export class TraceStore {
  private readonly paths: CorePaths;

  /** Per-task append/read serialization within this single process. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(paths: CorePaths) {
    this.paths = paths;
  }

  /**
   * Appends one turn trace — the turn's ONE final record (plan 2026-08-04
   * Task 5, frozen decision 6): callers write exactly once after the commit
   * outcome is known, optionally with the display-only phase summary. A
   * phase-only record (zero entries) is legal for failure paths. Duplicate
   * turnIds are idempotent: the first committed file wins and later appends
   * resolve silently (no provisional-then-amended writes). Oversized input
   * is truncated to TRACE_LIMITS, never rejected.
   */
  appendTurnTrace(
    taskId: string,
    turnId: string,
    entries: readonly TraceEntry[],
    phase?: TurnTracePhase,
  ): Promise<void> {
    return this.enqueue(taskId, () => this.appendExclusive(taskId, turnId, entries, phase));
  }

  /** Reads one turn trace; any missing or damaged trace isolates to null. */
  readTurnTrace(taskId: string, turnId: string): Promise<TurnTrace | null> {
    return this.enqueue(taskId, () => this.readExclusive(taskId, turnId));
  }

  /** Runs work behind the per-task mutex; failures never jam the queue. */
  private enqueue<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    const run = previous.then(work, work);
    this.queues.set(
      taskId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async appendExclusive(
    taskId: string,
    turnId: string,
    entries: readonly TraceEntry[],
    phase?: TurnTracePhase,
  ): Promise<void> {
    const bounded = applyTraceLimits(Array.isArray(entries) ? entries : []);
    const trace: TurnTrace =
      phase !== undefined ? { turnId, phase, entries: bounded } : { turnId, entries: bounded };
    const bytes = Buffer.from(JSON.stringify(trace), 'utf8');
    try {
      await writeNewAtomic(this.paths.taskTraceFile(taskId, turnId), bytes);
    } catch (error) {
      if (error instanceof StorageError && error.code === STORAGE_ERROR_CODES.FILE_EXISTS) {
        return; // Duplicate turnId: the first write wins, silently.
      }
      throw error;
    }
  }

  private async readExclusive(taskId: string, turnId: string): Promise<TurnTrace | null> {
    try {
      const bytes = await readFile(this.paths.taskTraceFile(taskId, turnId));
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      return parseTurnTrace(value, turnId);
    } catch {
      return null;
    }
  }
}
