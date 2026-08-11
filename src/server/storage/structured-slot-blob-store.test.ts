// @vitest-environment node
/**
 * Structured slot blob store tests (Task 7 Steps 1-2, design §18.2).
 *
 * The blob store is the task-local immutable object layer: content-addressed
 * canonical blobs under `structured-slots/blobs/<first2>/<sha256>.json`, an
 * indexed generation layout (`manifest.json` + `slots.ndjson` + `index.json`)
 * that serves single slots through one byte-range read, and content-revision
 * roots whose values resolve through their own content blobs.
 *
 * Step 1 asserts content-address invariants: equal canonical bytes reuse one
 * digest, changed bytes get a new digest, and a file whose bytes do not match
 * its path hash surfaces TASK_CORRUPTED.
 *
 * Step 2 builds a 10,000-record generation, reads one tail slot through an
 * instrumented record reader, and proves the reader performs ONE byte-range
 * read (never a full NDJSON parse), plus verifies the parent/order/type and
 * document-order indexes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CorePaths } from './core-paths';
import { disposeAllTestRoots, makeTempCorePaths } from '../test-support';
import type { SlotInstance, StructuredBlobRefV1 } from '../../shared/structured-slots';
import {
  StructuredSlotBlobStore,
  type GenerationIndexV1,
  type SlotReadTrace,
} from './structured-slot-blob-store';

afterEach(() => {
  disposeAllTestRoots();
});

/** Creates a task root and a blob store bound to it. */
function makeStore(): { paths: CorePaths; taskId: string; store: StructuredSlotBlobStore } {
  const { paths } = makeTempCorePaths('forge-core-blob-');
  const taskId = 'task-blob';
  mkdirSync(paths.taskRoot(taskId), { recursive: true });
  return { paths, taskId, store: new StructuredSlotBlobStore(paths, taskId) };
}

/** Slot chain fixture: `count` slots in document order, mixed types. */
function makeSlotChain(count: number): SlotInstance[] {
  const slots: SlotInstance[] = [];
  for (let i = 0; i < count; i++) {
    const isHeading = i % 3 === 0;
    slots.push({
      slotId: `slot-${i}`,
      scaffoldId: 'scaffold-1',
      parentSlotId: i === 0 ? null : `slot-${i - 1}`,
      order: i,
      typeId: isHeading ? 'heading' : 'text',
      spec: { level: i % 3 },
      // The tail slot (9999, odd) is `set` so the single-range read asserts a
      // populated content value.
      contentPresence: i % 2 === 1 ? 'set' : 'unset',
      ...(i % 2 === 1 ? { content: `content-${i}` } : {}),
    });
  }
  return slots;
}

describe('StructuredSlotBlobStore content addressing', () => {
  it('reuses one digest for equal canonical bytes and a new digest for changed bytes', async () => {
    const { paths, taskId, store } = makeStore();
    const first = await store.putJsonBlob({ title: '相同的规范载荷', nested: { a: [1, 2, 3] } }, 'validation');
    const second = await store.putJsonBlob({ title: '相同的规范载荷', nested: { a: [1, 2, 3] } }, 'validation');
    expect(second).toEqual(first);
    // Changed bytes address a different digest; nothing is overwritten.
    const changed = await store.putJsonBlob({ title: '不同' }, 'validation');
    expect(changed.sha256).not.toBe(first.sha256);
    expect(changed.byteLength).not.toBe(first.byteLength);
    expect(existsSync(paths.taskStructuredBlobFile(taskId, first.sha256))).toBe(true);
    expect(existsSync(paths.taskStructuredBlobFile(taskId, changed.sha256))).toBe(true);
    // Same content with a different kind still shares the digest (kind is
    // reference metadata, not part of the canonical bytes).
    const asGeneration = await store.putJsonBlob({ title: '相同的规范载荷', nested: { a: [1, 2, 3] } }, 'generation');
    expect(asGeneration.sha256).toBe(first.sha256);
  });

  it('returns a stable StructuredBlobRefV1 with the canonical byte length', async () => {
    const { store } = makeStore();
    const value = { hello: 'world' };
    const ref = await store.putJsonBlob(value, 'validation');
    expect(ref.version).toBe(1);
    expect(ref.kind).toBe('validation');
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.byteLength).toBe(Buffer.byteLength(JSON.stringify(value), 'utf8'));
  });

  it('surfaces TASK_CORRUPTED when a blob file does not match its path hash', async () => {
    const { paths, taskId, store } = makeStore();
    const ref = await store.putJsonBlob({ secret: 'payload' }, 'validation');
    const blobPath = paths.taskStructuredBlobFile(taskId, ref.sha256);
    writeFileSync(blobPath, Buffer.from('tampered bytes that are not canonical', 'utf8'));
    await expect(store.readBlob(ref.sha256)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
    await expect(
      store.readBlob('f'.repeat(64)),
    ).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });

  it('pins the putJsonBlob / putContentValue / putContentRevision digests (no one-pass drift)', async () => {
    const { store } = makeStore();

    // Golden digests computed from the pre-Task-B canonical serializer: the
    // one-pass encode+hash must produce byte-identical canonical bytes, so the
    // content-addressed digests/byteLengths never drift.
    const blobRef = await store.putJsonBlob({ title: '相同的规范载荷', nested: { a: [1, 2, 3] } }, 'validation');
    expect(blobRef.sha256).toBe('48435ecee11593599d9670afa09ca4851d70838b8af5f0525c84921a7e5bc8c9');
    expect(blobRef.byteLength).toBe(56);

    const changed = await store.putJsonBlob({ title: '不同' }, 'validation');
    expect(changed.sha256).toBe('130f91a214b941f95be0e93a9f47998bb1846deb7dde36b22abba25fb935284e');
    expect(changed.byteLength).toBe(18);

    const content = await store.putContentValue({ title: '正文内容', tags: ['a', 'b'] });
    expect(content.sha256).toBe('b2583db8bcca81ec68068c03ce43ffbf6c5051e74512c9840488cda6cd8ea1bd');
    expect(content.byteLength).toBe(41);

    const revision = await store.putContentRevision({
      'slot-a': 'a'.repeat(64),
      'slot-b': 'unset',
    });
    expect(revision.sha256).toBe('98fa1b7a39403c7c9b179b177f74c45b35d5b40b674d24f4a00bd399d88b4d0e');
    expect(revision.byteLength).toBe(119);
  });
});

describe('StructuredSlotBlobStore indexed generations', () => {
  it('writes the generation layout and reads one tail slot via a single byte range', async () => {
    const { paths, taskId, store } = makeStore();
    const slots = makeSlotChain(10_000);
    const generationId = 'gen-1';
    const manifest = await store.putGeneration({ generationId, scaffoldId: 'scaffold-1', slots });

    // The indexed layout exists and the generation is content-addressed.
    expect(existsSync(paths.taskStructuredGenerationManifestFile(taskId, generationId))).toBe(true);
    expect(existsSync(paths.taskStructuredGenerationSlotsFile(taskId, generationId))).toBe(true);
    expect(existsSync(paths.taskStructuredGenerationIndexFile(taskId, generationId))).toBe(true);
    expect(manifest.slotCount).toBe(10_000);
    expect(manifest.structure.kind).toBe('generation');
    expect(existsSync(paths.taskStructuredBlobFile(taskId, manifest.structure.sha256))).toBe(true);

    // The content-addressed blob carries the full canonical scaffold.
    const whole = JSON.parse((await store.readBlob(manifest.structure.sha256)).toString('utf8')) as SlotInstance[];
    expect(whole).toHaveLength(10_000);
    expect(whole[9_999].slotId).toBe('slot-9999');

    // Instrument the record reader: one tail slot must cost exactly one
    // byte-range read of slots.ndjson and one parsed line.
    const ranges: Array<{ offset: number; length: number }> = [];
    let linesParsed = 0;
    const trace: SlotReadTrace = {
      onRangeRead: (range) => ranges.push(range),
      onLineParsed: (slotId) => {
        linesParsed += 1;
        expect(slotId).toBe('slot-9999');
      },
    };
    const tail = await store.readSlot(generationId, 'slot-9999', trace);
    expect(tail).not.toBeNull();
    expect(tail?.slotId).toBe('slot-9999');
    expect(tail?.contentPresence).toBe('set');
    expect(tail?.content).toBe('content-9999');
    expect(linesParsed).toBe(1);
    expect(ranges).toHaveLength(1);

    // The read is a genuine sub-range, not a whole-file parse: the range is
    // far smaller than the 10k-line NDJSON and decodes to the expected record.
    const ndjson = readFileSync(paths.taskStructuredGenerationSlotsFile(taskId, generationId), 'utf8');
    expect(ranges[0].length).toBeLessThan(ndjson.length / 1000);
    const lineBytes = Buffer.from(ndjson).subarray(ranges[0].offset, ranges[0].offset + ranges[0].length);
    expect(JSON.parse(lineBytes.toString('utf8'))).toEqual(slots[9_999]);
  });

  it('builds parent, order, type and document-order indexes', async () => {
    const { paths, taskId, store } = makeStore();
    const slots: SlotInstance[] = [
      { slotId: 'root', scaffoldId: 's', parentSlotId: null, order: 0, typeId: 'doc', spec: {}, contentPresence: 'unset' },
      { slotId: 'h1', scaffoldId: 's', parentSlotId: 'root', order: 0, typeId: 'heading', spec: {}, contentPresence: 'unset' },
      { slotId: 't1', scaffoldId: 's', parentSlotId: 'root', order: 1, typeId: 'text', spec: {}, contentPresence: 'set', content: '正文一' },
      { slotId: 't2', scaffoldId: 's', parentSlotId: 'h1', order: 0, typeId: 'text', spec: {}, contentPresence: 'unset' },
    ];
    await store.putGeneration({ generationId: 'gen-index', scaffoldId: 's', slots });

    const index = JSON.parse(
      readFileSync(paths.taskStructuredGenerationIndexFile(taskId, 'gen-index'), 'utf8'),
    ) as GenerationIndexV1;
    expect(index.slotCount).toBe(4);
    expect(index.documentOrder).toEqual(['root', 'h1', 't1', 't2']);
    // '' groups root-level slots (parent null); each slotId groups its children.
    expect(index.byParent).toEqual({
      '': ['root'],
      root: ['h1', 't1'],
      h1: ['t2'],
    });
    expect(index.byType).toEqual({
      doc: ['root'],
      heading: ['h1'],
      text: ['t1', 't2'],
    });
    expect(index.slots.root).toEqual({ offset: expect.any(Number), length: expect.any(Number), order: 0 });
    expect(index.slots.t2.order).toBe(0);
    expect(index.slots.h1.length).toBeGreaterThan(0);

    // A slot read resolves through the index without parsing unrelated lines.
    const h1 = await store.readSlot('gen-index', 'h1');
    expect(h1?.slotId).toBe('h1');
    expect(h1?.parentSlotId).toBe('root');
    const missing = await store.readSlot('gen-index', 'no-such-slot');
    expect(missing).toBeNull();
  });

  it('reports a corrupt line or out-of-range index entry as TASK_CORRUPTED', async () => {
    const { paths, taskId, store } = makeStore();
    const slots = makeSlotChain(3);
    await store.putGeneration({ generationId: 'gen-1', scaffoldId: 'scaffold-1', slots });
    // Truncate the NDJSON so the tail slot's recorded range is out of bounds.
    const ndjsonPath = paths.taskStructuredGenerationSlotsFile(taskId, 'gen-1');
    writeFileSync(ndjsonPath, Buffer.from('{', 'utf8'));
    await expect(store.readSlot('gen-1', 'slot-1')).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });

  it('fails closed on a self-cycle parent instead of overflowing the stack', async () => {
    const { store } = makeStore();
    const selfCycle: SlotInstance[] = [
      { slotId: 'a', scaffoldId: 's', parentSlotId: 'a', order: 0, typeId: 'text', spec: {}, contentPresence: 'unset' },
    ];
    await expect(
      store.putGeneration({ generationId: 'gen-cycle', scaffoldId: 's', slots: selfCycle }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('fails closed on a dangling parent instead of overflowing the stack', async () => {
    const { store } = makeStore();
    const dangling: SlotInstance[] = [
      { slotId: 'a', scaffoldId: 's', parentSlotId: 'ghost', order: 0, typeId: 'text', spec: {}, contentPresence: 'unset' },
      { slotId: 'b', scaffoldId: 's', parentSlotId: 'a', order: 1, typeId: 'text', spec: {}, contentPresence: 'unset' },
    ];
    await expect(
      store.putGeneration({ generationId: 'gen-dangling', scaffoldId: 's', slots: dangling }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('fails closed when the same generationId is put with different bytes', async () => {
    const { store } = makeStore();
    const generationId = 'gen-dup';
    const first = await store.putGeneration({ generationId, scaffoldId: 'scaffold-1', slots: makeSlotChain(3) });
    // A second put of the same generationId with DIFFERENT canonical bytes
    // addresses a different structure digest: idempotency must fail closed as
    // TASK_CORRUPTED, never silently fall through to the old manifest.
    const different = makeSlotChain(3).map((slot) => ({ ...slot, spec: { level: 99 } }));
    await expect(
      store.putGeneration({ generationId, scaffoldId: 'scaffold-1', slots: different }),
    ).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
    // The committed manifest is unchanged — the first generation still reads.
    expect((await store.getGenerationIndex(generationId)).slotCount).toBe(3);
    expect(first.structure.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computes maxDepth for a valid deep tree without overflowing', async () => {
    const { store } = makeStore();
    const deep = makeSlotChain(5000);
    const manifest = await store.putGeneration({
      generationId: 'gen-deep',
      scaffoldId: 'scaffold-1',
      slots: deep,
    });
    expect(manifest.slotCount).toBe(5000);
    expect(manifest.maxDepth).toBe(4999);
    expect(manifest.rootSlotId).toBe('slot-0');
    // The depth computation is memoized/iterative, so a repeated deep read is
    // cheap and the tail slot still resolves through one byte-range read.
    expect((await store.readSlot('gen-deep', 'slot-4999'))?.content).toBe('content-4999');
  });
});

describe('StructuredSlotBlobStore content revisions', () => {
  it('stores a canonical slotId -> presence/digest root and resolves effective content', async () => {
    const { paths, taskId, store } = makeStore();
    const contentRef = await store.putContentValue({ title: '正文内容', tags: ['a', 'b'] });
    const revisionRef = await store.putContentRevision({
      'slot-a': contentRef.sha256,
      'slot-b': 'unset',
    });
    expect(revisionRef.kind).toBe('content_revision');
    expect(revisionRef.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The revision root is itself a content-addressed file under content-revisions/.
    expect(existsSync(paths.taskStructuredContentRevisionFile(taskId, revisionRef.sha256))).toBe(true);

    const effective = await store.readEffectiveContent(revisionRef);
    expect(effective['slot-a']).toEqual({ presence: 'set', content: { title: '正文内容', tags: ['a', 'b'] } });
    expect(effective['slot-b']).toEqual({ presence: 'unset', content: null });
  });

  it('reuses one digest for an identical revision and rejects a corrupt content blob', async () => {
    const { paths, taskId, store } = makeStore();
    const contentRef = await store.putContentValue({ body: 'x' });
    const mappings = { 'slot-0': contentRef.sha256 };
    const first = await store.putContentRevision(mappings);
    const second = await store.putContentRevision(mappings);
    expect(second).toEqual(first);

    // Corrupting the underlying content blob makes effective resolution fail.
    writeFileSync(paths.taskStructuredBlobFile(taskId, contentRef.sha256), 'not canonical', 'utf8');
    await expect(store.readEffectiveContent(first)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });
});
