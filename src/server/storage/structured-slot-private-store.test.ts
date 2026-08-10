// @vitest-environment node
/**
 * Structured slot private store tests (Task 7 Step 3, design §18.2/§18.3).
 *
 * The private store journals Proposal whole-tree replaces, Draft content
 * overlay writes, tool signatures/results and submission locks, plus
 * persistent Attempt meter snapshots. Its journal/checkpoint discipline is
 * recoverable (checkpoint + tail journal rebuild the same overlay), but the
 * Proposal/Draft lifecycle terminal is NEVER private authority: committed /
 * merged / stale / abandoned is derived from committed TaskEvents, and any
 * post-batch lifecycle cache marker is fully derivable/repairable and never
 * trusted over the event history.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { disposeAllTestRoots, makeTaskEvent, makeTempCorePaths } from '../test-support';
import { TemplateCatalog } from '../template/template-catalog';
import type { CorePaths } from './core-paths';
import { TaskStore } from './task-store';
import {
  StructuredSlotPrivateStore,
  type DraftContext,
  type ProposalNode,
} from './structured-slot-private-store';
import { StructuredSlotBlobStore } from './structured-slot-blob-store';

afterEach(() => {
  disposeAllTestRoots();
});

const DRAFT_CONTEXT: DraftContext = {
  scaffoldId: 'scaffold-1',
  generationId: 'gen-1',
  baseRevision: 0,
};

const BLOB_REF = {
  version: 1,
  kind: 'generation',
  sha256: 'a'.repeat(64),
  byteLength: 4,
} as const;

function makeStore(options: { checkpointOpThreshold?: number; checkpointByteThreshold?: number } = {}): {
  paths: CorePaths;
  taskId: string;
  store: StructuredSlotPrivateStore;
} {
  const { paths } = makeTempCorePaths('forge-core-private-');
  const taskId = 'task-private';
  mkdirSync(paths.taskRoot(taskId), { recursive: true });
  return {
    paths,
    taskId,
    store: new StructuredSlotPrivateStore(paths, taskId, options),
  };
}

describe('StructuredSlotPrivateStore materialization', () => {
  it('materializes a Proposal idempotently (get-or-create bound to the turn)', async () => {
    const { store } = makeStore();
    const tree: ProposalNode = { clientKey: 'root', typeId: 'doc', spec: { title: 'x' }, children: [] };
    const first = await store.materializeProposal('turn-1', 'prop-1');
    expect(first.proposalId).toBe('prop-1');
    expect(first.turnId).toBe('turn-1');
    expect(first.lifecycle).toBe('open');
    await store.replaceProposal('prop-1', tree);
    const again = await store.materializeProposal('turn-1', 'prop-1');
    expect(again.proposalId).toBe('prop-1');
    expect(again.turnId).toBe('turn-1');
    expect(again.tree).toEqual(tree);
    // A different turn cannot re-bind an existing proposal (fail loud).
    await expect(store.materializeProposal('turn-2', 'prop-1')).rejects.toMatchObject({
      code: 'TASK_CORRUPTED',
    });
  });

  it('materializes a Draft idempotently by turnId and preserves the overlay', async () => {
    const { store } = makeStore();
    const first = await store.materializeDraft('turn-1', 'draft-1', DRAFT_CONTEXT);
    expect(first.draftId).toBe('draft-1');
    expect(first.turnId).toBe('turn-1');
    expect(first.baseRevision).toBe(0);
    await store.replaceContent('draft-1', 'slot-a', { x: 1 });
    await store.unsetContent('draft-1', 'slot-b');
    const again = await store.materializeDraft('turn-1', 'draft-1', DRAFT_CONTEXT);
    expect(again.overlay.get('slot-a')).toEqual({ presence: 'set', content: { x: 1 } });
    expect(again.overlay.get('slot-b')).toEqual({ presence: 'unset', content: null });
    expect(again.scaffoldId).toBe('scaffold-1');
    await expect(store.materializeDraft('turn-2', 'draft-1', DRAFT_CONTEXT)).rejects.toMatchObject({
      code: 'TASK_CORRUPTED',
    });
  });

  it('rejects writes after the submission lock', async () => {
    const { store } = makeStore();
    await store.materializeProposal('turn-1', 'prop-1');
    await store.lockProposal('prop-1');
    await expect(store.replaceProposal('prop-1', { clientKey: 'r', typeId: 'doc', spec: {}, children: [] })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });

    await store.materializeDraft('turn-1', 'draft-1', DRAFT_CONTEXT);
    await store.lockDraft('draft-1');
    await expect(store.replaceContent('draft-1', 'slot-a', 1)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(store.unsetContent('draft-1', 'slot-a')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('journals tool signatures and results as private records', async () => {
    const { store } = makeStore();
    await store.materializeDraft('turn-1', 'draft-1', DRAFT_CONTEXT);
    await store.recordDraftTool('draft-1', 'tc-1', 'ab'.repeat(32), { code: 'OK', summary: { errors: 0 } });
    const view = await store.readDraft('draft-1', []);
    expect(view.toolRecords).toEqual([
      { toolCallId: 'tc-1', argsHash: 'ab'.repeat(32), result: { code: 'OK', summary: { errors: 0 } } },
    ]);
    await store.materializeProposal('turn-1', 'prop-1');
    await store.recordProposalTool('prop-1', 'tc-2', 'cd'.repeat(32), { code: 'OK' });
    expect((await store.readProposal('prop-1', [])).toolRecords).toEqual([
      { toolCallId: 'tc-2', argsHash: 'cd'.repeat(32), result: { code: 'OK' } },
    ]);
  });
});

describe('StructuredSlotPrivateStore checkpoint and recovery', () => {
  it('rebuilds the same overlay from checkpoint plus tail journal after a fresh instance', async () => {
    const { paths, taskId, store } = makeStore({ checkpointOpThreshold: 4, checkpointByteThreshold: 1024 });
    await store.materializeDraft('turn-1', 'draft-cp', DRAFT_CONTEXT);
    for (let i = 0; i < 10; i++) {
      await store.replaceContent('draft-cp', `slot-${i}`, { i });
    }
    await store.lockDraft('draft-cp');

    // The threshold forced an immutable checkpoint and a truncated tail journal.
    expect(existsSync(paths.taskStructuredDraftCheckpointFile(taskId, 'draft-cp'))).toBe(true);
    const tailLines = readFileSync(paths.taskStructuredDraftJournalFile(taskId, 'draft-cp'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(tailLines.length).toBeLessThan(10);

    // A fresh store instance rebuilds the exact same overlay from disk.
    const fresh = new StructuredSlotPrivateStore(paths, taskId, {
      checkpointOpThreshold: 4,
      checkpointByteThreshold: 1024,
    });
    const view = await fresh.readDraft('draft-cp', []);
    expect(view.locked).toBe(true);
    // materialize + 10 replaces + lock = 12 journaled ops, all rebuilt.
    expect(view.opCount).toBe(12);
    expect([...view.overlay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))).toEqual(
      Array.from({ length: 10 }, (_, i) => [`slot-${i}`, { presence: 'set', content: { i } }]),
    );
  });

  it('checkpoints once the journal byte threshold is crossed', async () => {
    const { paths, taskId, store } = makeStore({
      checkpointOpThreshold: 10_000,
      checkpointByteThreshold: 120,
    });
    await store.materializeDraft('turn-1', 'draft-bytes', DRAFT_CONTEXT);
    const big = { data: 'x'.repeat(200) };
    await store.replaceContent('draft-bytes', 'slot-big', big);
    // A second op observes the byte threshold and triggers the checkpoint.
    await store.replaceContent('draft-bytes', 'slot-small', 's');
    expect(existsSync(paths.taskStructuredDraftCheckpointFile(taskId, 'draft-bytes'))).toBe(true);
    const fresh = new StructuredSlotPrivateStore(paths, taskId, {
      checkpointOpThreshold: 10_000,
      checkpointByteThreshold: 120,
    });
    const view = await fresh.readDraft('draft-bytes', []);
    expect(view.overlay.get('slot-big')).toEqual({ presence: 'set', content: big });
    expect(view.overlay.get('slot-small')).toEqual({ presence: 'set', content: 's' });
  });

  it('recovers a proposal tree from a checkpoint plus tail journal', async () => {
    const { paths, taskId, store } = makeStore({ checkpointOpThreshold: 3, checkpointByteThreshold: 1024 });
    await store.materializeProposal('turn-1', 'prop-cp');
    await store.replaceProposal('prop-cp', { clientKey: 'a', typeId: 'doc', spec: {}, children: [] });
    await store.replaceProposal('prop-cp', {
      clientKey: 'b',
      typeId: 'doc',
      spec: { deep: [1, { k: 2 }] },
      children: [{ clientKey: 'c', typeId: 'text', spec: {}, children: [] }],
    });
    const fresh = new StructuredSlotPrivateStore(paths, taskId, { checkpointOpThreshold: 3, checkpointByteThreshold: 1024 });
    const view = await fresh.readProposal('prop-cp', []);
    expect(view.tree).toEqual({
      clientKey: 'b',
      typeId: 'doc',
      spec: { deep: [1, { k: 2 }] },
      children: [{ clientKey: 'c', typeId: 'text', spec: {}, children: [] }],
    });
  });
});

describe('StructuredSlotPrivateStore authority reconciliation', () => {
  it('never writes a private lifecycle terminal; no journal alone makes a Draft merged', async () => {
    const { paths, taskId, store } = makeStore();
    await store.materializeDraft('turn-1', 'draft-t', DRAFT_CONTEXT);
    await store.replaceContent('draft-t', 's', 1);
    await store.recordDraftTool('draft-t', 'tc-1', 'ab'.repeat(32), { code: 'OK' });
    await store.lockDraft('draft-t');

    // The journal carries only private ops — never a lifecycle terminal.
    const ops = readFileSync(paths.taskStructuredDraftJournalFile(taskId, 'draft-t'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { op: string });
    expect(ops.map((op) => op.op)).toEqual(['materialize', 'replace_content', 'tool', 'lock']);
    expect(readdirSync(paths.taskStructuredDraftRoot(taskId, 'draft-t'))).not.toContain('lifecycle.json');

    // Locked but still open: the private state cannot manufacture a terminal.
    const view = await store.readDraft('draft-t', []);
    expect(view.lifecycle).toBe('open');
    expect(view.locked).toBe(true);
  });

  it('reports the event-derived terminal when the private file still looks open', async () => {
    const { store } = makeStore();
    await store.materializeDraft('turn-1', 'draft-t', DRAFT_CONTEXT);
    await store.replaceContent('draft-t', 's', 1);
    const base = {
      type: 'structured_fill_draft_terminal',
      draftId: 'draft-t',
      turnId: 'turn-1',
      baseRevision: 0,
      resultRevision: 1,
      changeCount: 1,
      content: null,
    } as const;
    const merged = makeTaskEvent({ ...base, status: 'merged' });
    const stale = makeTaskEvent({ ...base, status: 'stale' });
    const abandoned = makeTaskEvent({ ...base, status: 'abandoned' });
    expect((await store.readDraft('draft-t', [merged])).lifecycle).toBe('merged');
    expect((await store.readDraft('draft-t', [stale])).lifecycle).toBe('stale');
    expect((await store.readDraft('draft-t', [abandoned])).lifecycle).toBe('abandoned');
  });

  it('reports a Proposal committed through its generation event and abandoned via its turn', async () => {
    const { store } = makeStore();
    await store.materializeProposal('turn-1', 'prop-1');
    await store.replaceProposal('prop-1', { clientKey: 'r', typeId: 'doc', spec: {}, children: [] });
    const committed = makeTaskEvent({
      type: 'structured_scaffold_generation_committed',
      scaffoldId: 'scaffold-1',
      generationId: 'gen-1',
      supersedesGenerationId: null,
      rootSlotId: 'root',
      slotCount: 1,
      maxDepth: 0,
      structure: BLOB_REF,
      content: BLOB_REF,
      contentRevision: 0,
      proposalId: 'prop-1',
    });
    expect((await store.readProposal('prop-1', [committed])).lifecycle).toBe('committed');

    const abandoned = makeTaskEvent({
      type: 'structured_slot_attempt_terminal',
      inputNodeId: 'in-1',
      attemptEpoch: 1,
      turnId: 'turn-1',
      status: 'abandoned',
      reason: 'task_stop',
    });
    expect((await store.readProposal('prop-1', [abandoned])).lifecycle).toBe('abandoned');
  });

  it('keeps a lifecycle cache marker fully derivable: reads trust events, not the marker', async () => {
    const { paths, taskId, store } = makeStore();
    await store.materializeDraft('turn-1', 'draft-cache', DRAFT_CONTEXT);
    await store.replaceContent('draft-cache', 's', 1);
    const merged = makeTaskEvent({
      type: 'structured_fill_draft_terminal',
      draftId: 'draft-cache',
      turnId: 'turn-1',
      status: 'merged',
      baseRevision: 0,
      resultRevision: 1,
      changeCount: 1,
      content: null,
    });
    expect((await store.readDraft('draft-cache', [merged])).lifecycle).toBe('merged');

    // A post-batch cache marker is written explicitly, and deleting it changes
    // nothing — the event history remains the only authority.
    await store.markDraftLifecycleCache('draft-cache', 'merged', merged.id);
    const markerPath = paths.taskStructuredDraftLifecycleFile(taskId, 'draft-cache');
    expect(existsSync(markerPath)).toBe(true);
    rmSync(markerPath);
    expect((await store.readDraft('draft-cache', [merged])).lifecycle).toBe('merged');

    // A stale marker claiming a terminal while the events say open is repaired
    // (deleted) and never reported as authority.
    await store.materializeDraft('turn-2', 'draft-stale', DRAFT_CONTEXT);
    await store.replaceContent('draft-stale', 's', 1);
    await store.markDraftLifecycleCache('draft-stale', 'merged', 'stale-event-id');
    const view = await store.readDraft('draft-stale', []);
    expect(view.lifecycle).toBe('open');
    expect(existsSync(paths.taskStructuredDraftLifecycleFile(taskId, 'draft-stale'))).toBe(false);

    // Proposal cache marker follows the same discipline.
    await store.materializeProposal('turn-3', 'prop-cache');
    await store.markProposalLifecycleCache('prop-cache', 'committed', 'stale-gen');
    const pv = await store.readProposal('prop-cache', []);
    expect(pv.lifecycle).toBe('open');
    expect(existsSync(paths.taskStructuredProposalLifecycleFile(taskId, 'prop-cache'))).toBe(false);

    // Clearing a marker explicitly is also safe: reads stay event-derived.
    await store.markDraftLifecycleCache('draft-cache', 'merged', merged.id);
    await store.clearDraftLifecycleCache('draft-cache');
    expect(existsSync(paths.taskStructuredDraftLifecycleFile(taskId, 'draft-cache'))).toBe(false);
    expect((await store.readDraft('draft-cache', [merged])).lifecycle).toBe('merged');
    await store.clearProposalLifecycleCache('prop-cache');
    expect(existsSync(paths.taskStructuredProposalLifecycleFile(taskId, 'prop-cache'))).toBe(false);
  });
});

describe('StructuredSlotPrivateStore attempt meter snapshots', () => {
  it('persists and reads an opaque attempt meter snapshot durably', async () => {
    const { store } = makeStore();
    const snapshot = { usage: { slotToolCalls: 3, validatorInvocations: 2 }, updatedAt: '2026-01-01T00:00:00Z' };
    await store.writeAttemptMeter('turn-1', snapshot);
    expect(await store.readAttemptMeter('turn-1')).toEqual(snapshot);
    expect(await store.readAttemptMeter('turn-unknown')).toBeNull();
    // A later snapshot replaces the earlier one (meter is a mutable snapshot).
    const later = { ...snapshot, usage: { ...snapshot.usage, slotToolCalls: 7 } };
    await store.writeAttemptMeter('turn-1', later);
    expect(await store.readAttemptMeter('turn-1')).toEqual(later);
  });
});

describe('StructuredSlotPrivateStore task deletion', () => {
  it('task delete removes all structured directories via the task root', async () => {
    const { paths } = makeTempCorePaths('forge-core-delete-');
    const taskId = 'task-delete';
    mkdirSync(paths.taskRoot(taskId), { recursive: true });
    const store = new StructuredSlotPrivateStore(paths, taskId);
    await store.writeAttemptMeter('turn-1', { usage: { calls: 1 } });
    await store.materializeDraft('turn-1', 'draft-x', DRAFT_CONTEXT);
    await store.replaceContent('draft-x', 's', 1);
    const blobStore = new StructuredSlotBlobStore(paths, taskId);
    await blobStore.putJsonBlob({ a: 1 }, 'validation');
    expect(existsSync(paths.taskStructuredSlotsRoot(taskId))).toBe(true);

    const taskStore = new TaskStore(paths, new TemplateCatalog(paths));
    await taskStore.deleteTask(taskId);

    await expect(stat(paths.taskRoot(taskId))).rejects.toBeTruthy();
    expect(existsSync(paths.taskStructuredSlotsRoot(taskId))).toBe(false);
  });
});
