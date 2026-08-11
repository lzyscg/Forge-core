// @vitest-environment node
/**
 * Projection N+1 I/O remediation tests (Task 19 remediation Task C).
 *
 * The integrated benchmark's `authorized-projection-500-issues` case mixed
 * cold-start, repeated generation-index re-reads and FULL content-blob
 * hydration into the projection. These tests lock the separation introduced by
 * Task C against regression, using the blob store's instrumentation seam:
 *
 * 1. `listSlots` (outline) reads NO content blobs — metadata + presence only.
 * 2. A content-level `readSlot` hydrates EXACTLY ONE content blob.
 * 3. The data source caches the projected event state — `projectStructuredSlotState`
 *    is not re-invoked per slot (bounded events fetches).
 * 4. Bulk content hydration is concurrency-bounded (`mapLimit`), never an
 *    unbounded `Promise.all`.
 *
 * The generation fixture is a real committed generation (root + SLOT_COUNT
 * children with content blobs), so the reads go through the actual blob store.
 */
import { mkdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { FillSessionGrantV1, JsonObject, StructuredBlobRefV1 } from '../../../shared/structured-slots';
import type { FrozenStructuredSlotContractV1 } from '../../template/structured-slot-contract';
import { EventStore } from '../../storage/event-store';
import {
  mapLimit,
  StructuredSlotBlobStore,
  type SlotInstance,
  type StructuredSlotBlobStoreInstrumentation,
} from '../../storage/structured-slot-blob-store';
import { projectStructuredSlotState } from '../../storage/structured-slot-state';
import type { TaskEvent } from '../../storage/task-events';
import { disposeAllTestRoots, makeTaskEvent, makeTempCorePaths } from '../../test-support';
import {
  createTaskLocalCursorSigner,
  StructuredSlotProjectionService,
} from './projection-service';
import { createStructuredSlotDataSource } from './session-service';

const SLOT_COUNT = 100;
const OWNER_LIMIT = 64;

function minimalContract(): FrozenStructuredSlotContractV1 {
  return {
    version: 1,
    slotTypes: [],
    layoutGrammar: {} as never,
    accessProfiles: [],
    validators: [],
    assembler: {
      id: 'asm',
      implementation: { abi: 'forge-assembler/v1', path: 'slots/assembler/a.cjs' },
      budget: { cpuMs: 100, timeoutMs: 500, memoryMiB: 64 },
      routes: [],
    },
    limits: {} as never,
    resourceManifest: [],
    abiProfileIdentity: {
      validatorAbi: 'forge-validator/v1',
      assemblerAbi: 'forge-assembler/v1',
      profileIdentity: 'forge-structured-runtime/v1',
    },
    semanticDigest: 'test',
  };
}

interface Counters {
  blobReads: number;
  indexReads: number;
  slotsOpens: number;
  contentRootReads: number;
}

function makeCounters(): { counters: Counters; instrumentation: StructuredSlotBlobStoreInstrumentation } {
  const counters: Counters = { blobReads: 0, indexReads: 0, slotsOpens: 0, contentRootReads: 0 };
  const instrumentation: StructuredSlotBlobStoreInstrumentation = {
    onBlobRead: () => {
      counters.blobReads += 1;
    },
    onIndexRead: () => {
      counters.indexReads += 1;
    },
    onSlotsFileOpen: () => {
      counters.slotsOpens += 1;
    },
    onContentRootRead: () => {
      counters.contentRootReads += 1;
    },
  };
  return { counters, instrumentation };
}

interface Harness {
  taskId: string;
  blobStore: StructuredSlotBlobStore;
  projection: StructuredSlotProjectionService;
  generationId: string;
  contentRevision: number;
  committed: TaskEvent[];
  contentRef: StructuredBlobRefV1;
}

/** Builds a real generation (root + SLOT_COUNT filled children, content in blobs). */
async function makeHarness(
  instrumentation?: StructuredSlotBlobStoreInstrumentation,
): Promise<Harness> {
  const { paths } = makeTempCorePaths('forge-core-n1-');
  const taskId = 'task-n1';
  mkdirSync(paths.taskRoot(taskId), { recursive: true });
  const blobStore = new StructuredSlotBlobStore(paths, taskId, instrumentation);
  const eventStore = new EventStore(paths);

  const seeds: Array<{
    slotId: string;
    parentSlotId: string | null;
    order: number;
    typeId: string;
    set: boolean;
  }> = [{ slotId: 'root', parentSlotId: null, order: 0, typeId: 'document', set: false }];
  for (let i = 0; i < SLOT_COUNT; i += 1) {
    seeds.push({ slotId: `n${i}`, parentSlotId: 'root', order: i + 1, typeId: 'node', set: true });
  }
  const manifest = await blobStore.putGeneration({
    generationId: 'gen-1',
    scaffoldId: 'scaffold-1',
    slots: seeds.map((seed) => ({
      slotId: seed.slotId,
      scaffoldId: 'scaffold-1',
      parentSlotId: seed.parentSlotId,
      order: seed.order,
      typeId: seed.typeId,
      spec: {} as JsonObject,
      contentPresence: 'unset' as const,
    })),
  });
  const mappings: Record<string, 'unset' | string> = {};
  for (const seed of seeds) {
    mappings[seed.slotId] = seed.set ? (await blobStore.putContentValue(`content-${seed.slotId}`)).sha256 : 'unset';
  }
  const contentRef = await blobStore.putContentRevision(mappings);
  await eventStore.append(taskId, {
    id: 'gen-committed',
    at: new Date().toISOString(),
    type: 'structured_scaffold_generation_committed',
    scaffoldId: 'scaffold-1',
    generationId: 'gen-1',
    supersedesGenerationId: null,
    rootSlotId: 'root',
    slotCount: seeds.length,
    maxDepth: 1,
    structure: manifest.structure,
    content: contentRef,
    contentRevision: 0,
    proposalId: 'p-1',
  });

  const committed: TaskEvent[] = (await eventStore.read(taskId)).map((entry) => entry.event);
  const source = createStructuredSlotDataSource({
    blobStore,
    events: async () => committed.map((entry) => entry),
  });
  const projection = new StructuredSlotProjectionService({
    contract: minimalContract(),
    source,
    signer: createTaskLocalCursorSigner(taskId),
  });
  return { taskId, blobStore, projection, generationId: 'gen-1', contentRevision: 0, committed, contentRef };
}

afterEach(() => {
  disposeAllTestRoots();
});

describe('projection N+1 — outline reads metadata + presence only (Task C)', () => {
  it('task_owner listSlots(limit=64) reads ZERO content blobs and one content root', async () => {
    const { counters, instrumentation } = makeCounters();
    const h = await makeHarness(instrumentation);
    const result = await h.projection.listSlots({ kind: 'task_owner' }, null, OWNER_LIMIT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(OWNER_LIMIT);
    // The outline page is metadata + presence only: no content blob was read,
    // the presence root was read exactly once, and the generation index was
    // parsed from disk exactly once (cached for every slot).
    expect(counters.blobReads).toBe(0);
    expect(counters.contentRootReads).toBe(1);
    expect(counters.indexReads).toBe(1);
  });

  it('a content-level readSlot hydrates EXACTLY ONE content blob', async () => {
    const { counters, instrumentation } = makeCounters();
    const h = await makeHarness(instrumentation);
    const result = await h.projection.readSlot({ kind: 'task_owner' }, 'n5');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slot.level).toBe('content');
    expect(result.slot.content).toBe('content-n5');
    // Exactly ONE content blob is hydrated for the target; the content root is
    // read a bounded number of times (target entry + ancestor-shell presence) —
    // both are root-only reads that hydrate nothing.
    expect(counters.blobReads).toBe(1);
    expect(counters.contentRootReads).toBeLessThanOrEqual(2);
    expect(counters.indexReads).toBe(1);
  });

  it('the data source caches the projected event state (bounded events fetches, not per slot)', async () => {
    const base = await makeHarness();
    let eventsCalls = 0;
    const source = createStructuredSlotDataSource({
      blobStore: base.blobStore,
      events: async () => {
        eventsCalls += 1;
        return base.committed.map((entry) => entry);
      },
    });
    const projection = new StructuredSlotProjectionService({
      contract: minimalContract(),
      source,
      signer: createTaskLocalCursorSigner(base.taskId),
    });
    // A full outline read over 100 slots, then several direct slot reads.
    const listed = await projection.listSlots({ kind: 'task_owner' }, null, OWNER_LIMIT);
    expect(listed.ok).toBe(true);
    for (const id of ['n0', 'n10', 'n99']) {
      const slot = await source.getSlot(base.generationId, id);
      expect(slot).not.toBeNull();
    }
    const presence = await source.getContentPresence(base.generationId, base.contentRevision);
    expect(Object.keys(presence).length).toBe(SLOT_COUNT + 1);
    // The whole operation re-projects the event list at most twice (cold +
    // possible refresh) — never once per slot.
    expect(eventsCalls).toBeLessThanOrEqual(2);
  });

  it('a long-lived source surfaces a post-merge revision; getSlot never serves wrong-revision content; a stale grant fails GRANT_STALE', async () => {
    const { paths } = makeTempCorePaths('forge-core-n1-merge-');
    const taskId = 'task-n1-merge';
    mkdirSync(paths.taskRoot(taskId), { recursive: true });
    const blobStore = new StructuredSlotBlobStore(paths, taskId);
    const eventStore = new EventStore(paths);
    const generationId = 'gen-1';
    const scaffoldId = 'scaffold-1';
    const slots: SlotInstance[] = [
      { slotId: 'r', scaffoldId, parentSlotId: null, order: 0, typeId: 'document', spec: {}, contentPresence: 'unset' },
      { slotId: 't1', scaffoldId, parentSlotId: 'r', order: 1, typeId: 'title', spec: {}, contentPresence: 'unset' },
      { slotId: 'b1', scaffoldId, parentSlotId: 'r', order: 2, typeId: 'body', spec: {}, contentPresence: 'unset' },
    ];
    const manifest = await blobStore.putGeneration({ generationId, scaffoldId, slots });
    const titleV0 = await blobStore.putContentValue('title');
    const rootV0 = await blobStore.putContentRevision({ r: 'unset', t1: titleV0.sha256, b1: 'unset' });
    await eventStore.append(taskId, {
      id: 'gen-committed',
      at: new Date().toISOString(),
      type: 'structured_scaffold_generation_committed',
      scaffoldId,
      generationId,
      supersedesGenerationId: null,
      rootSlotId: 'r',
      slotCount: 3,
      maxDepth: 1,
      structure: manifest.structure,
      content: rootV0,
      contentRevision: 0,
      proposalId: 'p-1',
    });

    const source = createStructuredSlotDataSource({
      blobStore,
      events: async () => (await eventStore.read(taskId)).map((entry) => entry.event),
    });
    const projection = new StructuredSlotProjectionService({
      contract: minimalContract(),
      source,
      signer: createTaskLocalCursorSigner(taskId),
    });

    // Revision 0 view: active generation at rev 0; a content-level t1 read
    // returns the base value.
    expect(await source.getActiveGeneration()).toEqual({ scaffoldId, generationId, contentRevision: 0 });
    const before = await source.getSlot(generationId, 't1', { withContent: true });
    expect(before?.content).toBe('title');

    // Commit a merge on the SAME task: contentRevision advances to 1 with a
    // new content root (t1 changed, b1 filled). The source is long-lived.
    const titleV1 = await blobStore.putContentValue('new title');
    const bodyV1 = await blobStore.putContentValue('body');
    const rootV1 = await blobStore.putContentRevision({ r: 'unset', t1: titleV1.sha256, b1: bodyV1.sha256 });
    await eventStore.append(taskId, {
      id: 'merge-1',
      at: new Date().toISOString(),
      type: 'structured_fill_draft_terminal',
      draftId: 'draft-1',
      turnId: 'turn-1',
      status: 'merged',
      baseRevision: 0,
      resultRevision: 1,
      changeCount: 2,
      content: rootV1,
    });

    // A FRESH getActiveGeneration sees the new revision (no stale cache).
    expect(await source.getActiveGeneration()).toEqual({ scaffoldId, generationId, contentRevision: 1 });
    // getContentPresence returns the NEW presence, and returns a defensive
    // copy (mutating it cannot corrupt the cached map).
    const presence = await source.getContentPresence(generationId, 1);
    expect(presence).toEqual({ r: 'unset', t1: 'set', b1: 'set' });
    // A runtime caller mutating the copy must not corrupt the cached map.
    (presence as Record<string, 'unset' | 'set'>).t1 = 'unset';
    expect(await source.getContentPresence(generationId, 1)).toEqual({ r: 'unset', t1: 'set', b1: 'set' });

    // getSlot resolves through the CURRENT (post-merge) presence — never
    // wrong-revision content.
    const afterT1 = await source.getSlot(generationId, 't1', { withContent: true });
    expect(afterT1?.content).toBe('new title');
    const afterB1 = await source.getSlot(generationId, 'b1', { withContent: true });
    expect(afterB1?.content).toBe('body');

    // A fresh projection operation with a grant pinned to the OLD baseRevision
    // fails GRANT_STALE — the projection-level fail-closed still holds.
    const staleGrant: FillSessionGrantV1 = {
      grantId: 'grant-stale',
      kind: 'fill',
      caseId: taskId,
      turnId: 'turn-2',
      agentId: 'agent-1',
      snapshotHash: 'snapshot-1',
      capabilities: ['read_slot_spec', 'read_slot_content'],
      accessProfileId: 'fill',
      scaffoldId,
      baseRevision: 0,
      readableSlotIds: ['t1', 'b1'],
      writableSlotIds: ['t1', 'b1'],
      draftId: 'draft-2',
    };
    const listResult = await projection.listSlots({ kind: 'agent', grant: staleGrant }, null, 10);
    expect(listResult.ok).toBe(false);
    if (!listResult.ok) {
      expect(listResult.code).toBe('GRANT_STALE');
    }
  });
});

describe('projection N+1 — bounded bulk hydration (Task C)', () => {
  it('a set JSON-null content value projects as null, never undefined', async () => {
    const { paths } = makeTempCorePaths('forge-core-n1-null-');
    const taskId = 'task-n1-null';
    mkdirSync(paths.taskRoot(taskId), { recursive: true });
    const blobStore = new StructuredSlotBlobStore(paths, taskId);
    const eventStore = new EventStore(paths);
    const slots: SlotInstance[] = [
      { slotId: 'root', scaffoldId: 'scaffold-1', parentSlotId: null, order: 0, typeId: 'document', spec: {}, contentPresence: 'unset' },
      { slotId: 'n1', scaffoldId: 'scaffold-1', parentSlotId: 'root', order: 1, typeId: 'node', spec: {}, contentPresence: 'unset' },
    ];
    const manifest = await blobStore.putGeneration({ generationId: 'gen-1', scaffoldId: 'scaffold-1', slots });
    const nullRef = await blobStore.putContentValue(null);
    const contentRef = await blobStore.putContentRevision({ root: 'unset', n1: nullRef.sha256 });
    await eventStore.append(taskId, {
      id: 'gen-committed',
      at: new Date().toISOString(),
      type: 'structured_scaffold_generation_committed',
      scaffoldId: 'scaffold-1',
      generationId: 'gen-1',
      supersedesGenerationId: null,
      rootSlotId: 'root',
      slotCount: 2,
      maxDepth: 1,
      structure: manifest.structure,
      content: contentRef,
      contentRevision: 0,
      proposalId: 'p-1',
    });
    const committed = (await eventStore.read(taskId)).map((entry) => entry.event);
    const source = createStructuredSlotDataSource({ blobStore, events: async () => committed });
    const projection = new StructuredSlotProjectionService({
      contract: minimalContract(),
      source,
      signer: createTaskLocalCursorSigner(taskId),
    });
    const read = await projection.readSlot({ kind: 'task_owner' }, 'n1');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.slot.contentPresence).toBe('set');
    // A set null value is content — it must project as null, not undefined.
    expect(Object.prototype.hasOwnProperty.call(read.slot, 'content')).toBe(true);
    expect(read.slot.content).toBeNull();
  });

  it('mapLimit never exceeds the concurrency limit and preserves order', async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    let active = 0;
    let maxActive = 0;
    const out = await mapLimit(items, 4, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return item * 2;
    });
    expect(out).toEqual(items.map((i) => i * 2));
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxActive).toBeGreaterThanOrEqual(2); // concurrent, not sequential
  });

  it('readEffectiveContent hydrates content blobs with bounded concurrency', async () => {
    const h = await makeHarness();
    // Track in-flight readBlob calls to prove the hydration is bounded.
    const originalReadBlob = h.blobStore.readBlob.bind(h.blobStore);
    let active = 0;
    let maxActive = 0;
    (h.blobStore as unknown as { readBlob: (digest: string) => Promise<Buffer> }).readBlob = async (digest) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      try {
        return await originalReadBlob(digest);
      } finally {
        active -= 1;
      }
    };
    const state = projectStructuredSlotState(h.committed);
    expect(state.content).not.toBeNull();
    const effective = await h.blobStore.readEffectiveContent(h.contentRef);
    expect(Object.keys(effective)).toHaveLength(SLOT_COUNT + 1);
    // Bounded (≤ 16) and concurrent (> 1); never an unbounded Promise.all over
    // 100 blobs, never strictly sequential.
    expect(maxActive).toBeLessThanOrEqual(16);
    expect(maxActive).toBeGreaterThanOrEqual(2);
  });
});
