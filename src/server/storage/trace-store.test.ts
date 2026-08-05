// @vitest-environment node
/**
 * Per-turn execution trace store tests (plan Phase E Task 1 Step 1).
 *
 * Traces live in `tasks/<id>/traces/<turnId>.json` — one append-only file per
 * Turn, written with writeNewAtomic and never part of the canonical event
 * union (plan Global Constraint 5): a duplicate turnId is idempotent (the
 * first write wins, FILE_EXISTS stays silent), oversized traces are truncated
 * instead of throwing, and any read damage isolates to a `null` view instead
 * of poisoning the task.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceEntry } from '../../shared/contracts';
import { disposeAllTestRoots, makeTempCorePaths } from '../test-support';
import type { CorePaths } from './core-paths';
import { TRACE_LIMITS, TraceStore } from './trace-store';

let paths: CorePaths;
let store: TraceStore;

const SAMPLE_ENTRIES: TraceEntry[] = [
  { kind: 'thinking', text: '先确认输入。' },
  { kind: 'tool_call', toolName: 'read_workspace', params: { path: 'notes/a.md' } },
  { kind: 'tool_result', toolName: 'read_workspace', text: '笔记正文' },
  { kind: 'text', text: '已完成。' },
];

beforeEach(() => {
  ({ paths } = makeTempCorePaths('forge-core-trace-'));
  store = new TraceStore(paths);
});

afterEach(() => {
  disposeAllTestRoots();
});

describe('TraceStore', () => {
  it('round-trips one trace per turn with every entry kind', async () => {
    await store.appendTurnTrace('task-1', 'turn-1', SAMPLE_ENTRIES);
    const trace = await store.readTurnTrace('task-1', 'turn-1');
    expect(trace).toEqual({ turnId: 'turn-1', entries: SAMPLE_ENTRIES });
  });

  it('keeps separate traces per task and per turn', async () => {
    await store.appendTurnTrace('task-1', 'turn-1', SAMPLE_ENTRIES);
    await store.appendTurnTrace('task-1', 'turn-2', [{ kind: 'text', text: '第二轮。' }]);
    await store.appendTurnTrace('task-2', 'turn-1', [{ kind: 'text', text: '另一任务。' }]);
    expect((await store.readTurnTrace('task-1', 'turn-2'))?.entries).toEqual([
      { kind: 'text', text: '第二轮。' },
    ]);
    expect((await store.readTurnTrace('task-2', 'turn-1'))?.entries).toEqual([
      { kind: 'text', text: '另一任务。' },
    ]);
  });

  it('makes a duplicate turnId idempotent: the first write wins silently', async () => {
    await store.appendTurnTrace('task-1', 'turn-1', SAMPLE_ENTRIES);
    await expect(
      store.appendTurnTrace('task-1', 'turn-1', [{ kind: 'text', text: '不同的内容。' }]),
    ).resolves.toBeUndefined();
    expect(await store.readTurnTrace('task-1', 'turn-1')).toEqual({
      turnId: 'turn-1',
      entries: SAMPLE_ENTRIES,
    });
  });

  it('truncates oversized traces instead of throwing', async () => {
    const manyEntries: TraceEntry[] = Array.from(
      { length: TRACE_LIMITS.maxEntries + 3 },
      (_, index) => ({ kind: 'text', text: `entry-${index}` }),
    );
    await store.appendTurnTrace('task-1', 'turn-many', manyEntries);
    const truncated = await store.readTurnTrace('task-1', 'turn-many');
    expect(truncated?.entries).toHaveLength(TRACE_LIMITS.maxEntries);
    expect(truncated?.entries[0]).toEqual({ kind: 'text', text: 'entry-0' });
    expect(truncated?.entries[TRACE_LIMITS.maxEntries - 1]).toEqual({
      kind: 'text',
      text: `entry-${TRACE_LIMITS.maxEntries - 1}`,
    });
  });

  it('truncates an oversized text field and marks the truncation', async () => {
    const oversized = '思'.repeat(TRACE_LIMITS.maxEntryChars + 100);
    await store.appendTurnTrace('task-1', 'turn-big', [
      { kind: 'thinking', text: oversized },
    ]);
    const trace = await store.readTurnTrace('task-1', 'turn-big');
    const text = trace?.entries[0]?.kind === 'thinking' ? trace.entries[0].text : '';
    expect(text).toHaveLength(TRACE_LIMITS.maxEntryChars);
    expect(text.endsWith('…[truncated]')).toBe(true);
    expect(oversized.startsWith(text.slice(0, 64))).toBe(true);
  });

  it('drops oversized tool_call params to an empty object', async () => {
    const huge = 'x'.repeat(TRACE_LIMITS.maxEntryChars + 1);
    await store.appendTurnTrace('task-1', 'turn-params', [
      { kind: 'tool_call', toolName: 'write_workspace', params: { blob: huge } },
    ]);
    const trace = await store.readTurnTrace('task-1', 'turn-params');
    expect(trace?.entries[0]).toEqual({
      kind: 'tool_call',
      toolName: 'write_workspace',
      params: {},
    });
  });

  it('reads a missing trace as null', async () => {
    expect(await store.readTurnTrace('task-1', 'turn-absent')).toBeNull();
  });

  it('reads damaged trace files as null and isolates them from other traces', async () => {
    await store.appendTurnTrace('task-1', 'turn-ok', SAMPLE_ENTRIES);
    const tracesRoot = paths.taskTracesRoot('task-1');
    await writeFile(join(tracesRoot, 'turn-torn.json'), '{torn', 'utf8');
    await writeFile(join(tracesRoot, 'turn-notjson.json'), '"just a string"', 'utf8');
    await writeFile(
      join(tracesRoot, 'turn-wrongid.json'),
      JSON.stringify({ turnId: 'turn-other', entries: [] }),
      'utf8',
    );
    await writeFile(
      join(tracesRoot, 'turn-badentry.json'),
      JSON.stringify({ turnId: 'turn-badentry', entries: [{ kind: 'unknown' }] }),
      'utf8',
    );
    expect(await store.readTurnTrace('task-1', 'turn-torn')).toBeNull();
    expect(await store.readTurnTrace('task-1', 'turn-notjson')).toBeNull();
    expect(await store.readTurnTrace('task-1', 'turn-wrongid')).toBeNull();
    expect(await store.readTurnTrace('task-1', 'turn-badentry')).toBeNull();
    expect(await store.readTurnTrace('task-1', 'turn-ok')).toEqual({
      turnId: 'turn-ok',
      entries: SAMPLE_ENTRIES,
    });
  });

  it('rejects unsafe turn identifiers on append and reads them as null', async () => {
    await expect(store.appendTurnTrace('task-1', '../evil', SAMPLE_ENTRIES)).rejects.toThrow(
      /CORE_PATH_INVALID/,
    );
    expect(await store.readTurnTrace('task-1', '../evil')).toBeNull();
    expect(await store.readTurnTrace('task-1', 'turn/1')).toBeNull();
  });

  it('never throws on a non-array entries argument', async () => {
    await expect(
      store.appendTurnTrace('task-1', 'turn-nil', undefined as unknown as TraceEntry[]),
    ).resolves.toBeUndefined();
    expect(await store.readTurnTrace('task-1', 'turn-nil')).toEqual({
      turnId: 'turn-nil',
      entries: [],
    });
  });
});

describe('TraceStore final phase (plan 2026-08-04 Task 5, spec §7.4)', () => {
  const DISPATCHED = {
    state: 'dispatched' as const,
    dispatchAction: 'publish_artifact' as const,
    target: null,
    message: null,
  };

  it('round-trips one final trace carrying the display-only phase', async () => {
    await store.appendTurnTrace('task-1', 'turn-1', SAMPLE_ENTRIES, DISPATCHED);
    expect(await store.readTurnTrace('task-1', 'turn-1')).toEqual({
      turnId: 'turn-1',
      phase: DISPATCHED,
      entries: SAMPLE_ENTRIES,
    });
  });

  it('allows a phase-only write with zero entries for failure paths', async () => {
    const failed = {
      state: 'failed' as const,
      dispatchAction: null,
      target: null,
      message: '阶段未完成。',
    };
    await store.appendTurnTrace('task-1', 'turn-failed', [], failed);
    expect(await store.readTurnTrace('task-1', 'turn-failed')).toEqual({
      turnId: 'turn-failed',
      phase: failed,
      entries: [],
    });
  });

  it('keeps historical trace files without a phase readable', async () => {
    const tracesRoot = paths.taskTracesRoot('task-1');
    await mkdir(tracesRoot, { recursive: true });
    await writeFile(
      join(tracesRoot, 'turn-legacy.json'),
      JSON.stringify({ turnId: 'turn-legacy', entries: [{ kind: 'text', text: '旧记录。' }] }),
      'utf8',
    );
    expect(await store.readTurnTrace('task-1', 'turn-legacy')).toEqual({
      turnId: 'turn-legacy',
      entries: [{ kind: 'text', text: '旧记录。' }],
    });
  });

  it('isolates a malformed phase to a null trace (fail closed)', async () => {
    const tracesRoot = paths.taskTracesRoot('task-1');
    await mkdir(tracesRoot, { recursive: true });
    await writeFile(
      join(tracesRoot, 'turn-badphase.json'),
      JSON.stringify({
        turnId: 'turn-badphase',
        phase: { state: 'not-a-state', dispatchAction: null, target: null, message: null },
        entries: [],
      }),
      'utf8',
    );
    expect(await store.readTurnTrace('task-1', 'turn-badphase')).toBeNull();
  });

  it('keeps first-write-wins when a later append tries to amend the phase', async () => {
    await store.appendTurnTrace('task-1', 'turn-1', SAMPLE_ENTRIES);
    // A same-turn follow-up (e.g. a late phase amendment) stays silent: the
    // one final record per turn was already committed (frozen decision 6).
    await store.appendTurnTrace('task-1', 'turn-1', [], DISPATCHED);
    expect(await store.readTurnTrace('task-1', 'turn-1')).toEqual({
      turnId: 'turn-1',
      entries: SAMPLE_ENTRIES,
    });
  });
});
