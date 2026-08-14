// @vitest-environment node
/**
 * Task 9: persistent v2 projection checkpoints (spec §9.4, design §19.1).
 *
 * Checkpoints are DISPOSABLE accelerators: a checkpoint binds
 * throughSequence + priorCheckpointDigest + projectionSchemaVersion and
 * embeds the full serialized projection + fold continuation. Reads verify the
 * envelope digest, the task/sequence/schema binding and every referenced ref;
 * ANY checkpoint failure (missing, corrupt, refs unresolvable) falls back to
 * a full genesis scan — the task itself is never implicated. A corrupt
 * AUTHORITATIVE event in the tail, however, propagates as corruption (the
 * task is corrupt); checkpoints never mask event corruption.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempCorePaths, disposeAllTestRoots } from '../test-support';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';
import type { CorePaths } from './core-paths';
import type { AuthoritativeReviewEventV2 } from './authoritative-review-events';
import { projectAuthoritativeReviewState, projectionDigestOf, type BlobObjectResolver } from './authoritative-review-state';
import { buildFullLifecycle } from './authoritative-review-state.test';
import {
  AuthoritativeReviewCheckpointStore,
  type ValidatedEventSource,
  type CommittedValidatedEvent,
} from './authoritative-review-checkpoint-store';

afterEach(() => {
  disposeAllTestRoots();
});

/** In-memory validated event source: sequence + event pairs. */
function sourceOf(events: readonly AuthoritativeReviewEventV2[]): ValidatedEventSource {
  const committed: CommittedValidatedEvent[] = events.map((event, index) => ({
    sequence: index + 1,
    fileName: `${String(index + 1).padStart(6, '0')}-${event.id}.json`,
    size: 1,
    event,
  }));
  return {
    async read(): Promise<CommittedValidatedEvent[]> {
      return [...committed];
    },
    async readAfter(_taskId: string, throughSequence: number): Promise<CommittedValidatedEvent[]> {
      return committed.filter((entry) => entry.sequence > throughSequence);
    },
  };
}

/** A resolver that fails on any missing key (checkpoint baseRef presence probe). */
function probeResolver(present: ReadonlySet<string>): BlobObjectResolver {
  return async (ref) => {
    const key = `${ref.kind}:${ref.digest}`;
    if (!present.has(key)) {
      throw new Error(`missing blob ${key}`);
    }
    return {};
  };
}

function collectRefKeys(events: readonly AuthoritativeReviewEventV2[]): Set<string> {
  const keys = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>;
      if (
        typeof record.kind === 'string' &&
        typeof record.digest === 'string' &&
        typeof record.byteLength === 'number' &&
        typeof record.mediaType === 'string' &&
        typeof record.schemaVersion === 'number'
      ) {
        keys.add(`${record.kind}:${record.digest}`);
      }
      for (const item of Object.values(record)) collect(item);
    }
  };
  collect(events);
  return keys;
}

describe('AuthoritativeReviewCheckpointStore', () => {
  it('reproduces the genesis projection digest from a checkpoint + tail replay', async () => {
    const { paths } = makeTempCorePaths();
    const events = buildFullLifecycle('cp-eq');
    const source = sourceOf(events);
    const store = new AuthoritativeReviewCheckpointStore(paths, source);

    // Cut points: after the first workitem completes, midway, and at the tail.
    const cutA = events.findIndex((e) => e.type === 'structured_work_item_completed') + 1;
    const cutB = Math.floor(events.length / 2);
    const genesis = await store.rebuild('task-1', probeResolver(collectRefKeys(events)));
    expect(genesis.throughSequence).toBe(events.length);

    const atA = await store.rebuild('task-1', probeResolver(collectRefKeys(events.slice(0, cutA))), cutA);
    await store.record('task-1', {
      throughSequence: cutA,
      projection: atA.projection,
      fold: atA.fold,
      baseRefs: [],
    });
    const mid = await store.rebuild('task-1', probeResolver(collectRefKeys(events.slice(0, cutB))), cutB);
    await store.record('task-1', {
      throughSequence: cutB,
      projection: mid.projection,
      fold: mid.fold,
      baseRefs: [],
    });

    // Read path: latest checkpoint (cutB) + tail replay must equal genesis.
    const resumed = await store.readState('task-1');
    expect(resumed.fromCheckpoint).toBe(true);
    expect(resumed.throughSequence).toBe(events.length);
    expect(resumed.projection.lastSequence).toBe(events.length);
    expect(projectionDigestOf(resumed.projection)).toBe(projectionDigestOf(genesis.projection));
    // The checkpointed state at cutA is still readable through its digest.
    const prior = await store.readCheckpoint('task-1');
    expect(prior).not.toBeNull();
    expect(prior?.throughSequence).toBe(cutB);
    expect(prior?.priorCheckpointDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falls back to a full genesis scan when the latest pointer or envelope is missing', async () => {
    const { paths } = makeTempCorePaths();
    const events = buildFullLifecycle('cp-missing');
    const store = new AuthoritativeReviewCheckpointStore(paths, sourceOf(events));

    const state = await store.readState('task-2');
    expect(state.fromCheckpoint).toBe(false);
    expect(state.projection.lastSequence).toBe(events.length);

    // Sweep: the checkpoint store must tolerate losing ALL of its own files
    // (checkpoints are never GC roots — design §19.1).
    await store.record('task-2', {
      throughSequence: 3,
      projection: state.projection,
      fold: state.fold,
      baseRefs: [],
    });
    await rm(paths.taskStructuredV2ProjectionsRoot('task-2'), { recursive: true, force: true });
    const again = await store.readState('task-2');
    expect(again.fromCheckpoint).toBe(false);
    expect(again.projection.lastSequence).toBe(events.length);
  });

  it('falls back to genesis on a corrupt latest.json or corrupt envelope', async () => {
    const { paths } = makeTempCorePaths();
    const events = buildFullLifecycle('cp-corrupt');
    const store = new AuthoritativeReviewCheckpointStore(paths, sourceOf(events));
    const state = await store.rebuild('task-3');
    await store.record('task-3', { throughSequence: events.length, projection: state.projection, fold: state.fold, baseRefs: [] });

    // Corrupt the latest pointer.
    const latestValue = JSON.parse(await readFile(paths.taskStructuredV2CheckpointLatestFile('task-3'), 'utf8')) as { checkpointDigest: string };
    await writeFile(paths.taskStructuredV2CheckpointLatestFile('task-3'), '{ not json', 'utf8');
    const viaCorruptPointer = await store.readState('task-3');
    expect(viaCorruptPointer.fromCheckpoint).toBe(false);
    expect(viaCorruptPointer.projection.lastSequence).toBe(events.length);

    // Corrupt the envelope bytes (tamper) and restore a valid pointer.
    const envelopePath = paths.taskStructuredV2CheckpointFile('task-3', latestValue.checkpointDigest);
    const bytes = Buffer.from(await readFile(envelopePath, 'utf8'));
    bytes[bytes.length - 2] = bytes[bytes.length - 2] === 0x31 ? 0x32 : 0x31;
    await writeFile(paths.taskStructuredV2CheckpointLatestFile('task-3'), JSON.stringify(latestValue), 'utf8');
    await writeFile(envelopePath, bytes, 'utf8');
    const viaCorruptEnvelope = await store.readState('task-3');
    expect(viaCorruptEnvelope.fromCheckpoint).toBe(false);
    expect(viaCorruptEnvelope.projection.lastSequence).toBe(events.length);
  });

  it('falls back to genesis when referenced checkpoint refs no longer resolve (GC sweep)', async () => {
    const { paths } = makeTempCorePaths();
    const events = buildFullLifecycle('cp-sweep');
    const store = new AuthoritativeReviewCheckpointStore(paths, sourceOf(events));
    const fullKeys = collectRefKeys(events);
    const state = await store.rebuild('task-4', probeResolver(fullKeys));
    await store.record('task-4', {
      throughSequence: events.length,
      projection: state.projection,
      fold: state.fold,
      baseRefs: [...fullKeys].map((key) => {
        const [kind, digest] = key.split(':') as [string, string];
        return { kind: kind as BlobRefV2['kind'], digest, byteLength: 1, mediaType: 'application/json', schemaVersion: 1 };
      }),
    });
    // The GC swept one referenced blob: baseRef verification must fail closed
    // into a genesis rebuild (which succeeds without needing the blob).
    const missing = new Set([...fullKeys].slice(1, 2));
    const swept = await store.readState('task-4', probeResolver(missing));
    expect(swept.fromCheckpoint).toBe(false);
    expect(swept.projection.lastSequence).toBe(events.length);
  });

  it('never falls back on a corrupt AUTHORITATIVE event in the tail (task corruption wins)', async () => {
    const { paths } = makeTempCorePaths();
    const events = buildFullLifecycle('cp-tail');
    const store = new AuthoritativeReviewCheckpointStore(paths, sourceOf(events));
    // Checkpoint at an EARLY cut so the (corrupt) tail is actually replayed.
    const early = await store.rebuild('task-5', undefined, 5);
    await store.record('task-5', { throughSequence: 5, projection: early.projection, fold: early.fold, baseRefs: [] });

    // A NEW committed event after the checkpoint that is semantically
    // corrupt (a second lease while one is active).
    const secondLease = {
      ...(events[1] as unknown as Record<string, unknown>),
      id: 'evt-corrupt-tail-1',
    };
    // The tail keeps the ORIGINAL sequence numbers: 6..8 from the history plus
    // a freshly committed sequence 9 that re-leases the same completed
    // workitem — a semantic corruption the projector must reject, never mask.
    const allEntries: CommittedValidatedEvent[] = [
      ...events.slice(0, 5).map((event, index) => ({ sequence: index + 1, fileName: `${index + 1}-x.json`, size: 1, event })),
      ...events.slice(5, 8).map((event, index) => ({ sequence: index + 6, fileName: `${index + 6}-x.json`, size: 1, event })),
      { sequence: 9, fileName: '9-x.json', size: 1, event: secondLease as unknown as AuthoritativeReviewEventV2 },
    ];
    const badSource: ValidatedEventSource = {
      async read(): Promise<CommittedValidatedEvent[]> {
        return [...allEntries];
      },
      async readAfter(_taskId: string, throughSequence: number): Promise<CommittedValidatedEvent[]> {
        return allEntries.filter((entry) => entry.sequence > throughSequence);
      },
    };
    const badStore = new AuthoritativeReviewCheckpointStore(paths, badSource);
    // The checkpoint file for task-5 is bound to throughSequence == length;
    // the corrupt tail never matches a checkpoint -> genesis replay
    // (still from events) -> the semantic corruption throws.
    let caught: unknown = null;
    try {
      await badStore.readState('task-5');
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
  });

  it('records a chained prior-checkpoint digest and identical inputs give identical digests', async () => {
    const { paths } = makeTempCorePaths();
    const events = buildFullLifecycle('cp-chain');
    const store = new AuthoritativeReviewCheckpointStore(paths, sourceOf(events));
    const cutA = 8;
    const cutB = 16;

    const a = await store.rebuild('task-6', undefined, cutA);
    const aDigest = await store.record('task-6', { throughSequence: cutA, projection: a.projection, fold: a.fold, baseRefs: [] });
    // Determinism: the identical input under the identical (prior-less)
    // environment reproduces the identical digest.
    await rm(paths.taskStructuredV2CheckpointLatestFile('task-6'), { force: true });
    const again = await store.record('task-6', { throughSequence: cutA, projection: a.projection, fold: a.fold, baseRefs: [] });
    expect(again).toBe(aDigest);

    const b = await store.rebuild('task-6', undefined, cutB);
    const bDigest = await store.record('task-6', { throughSequence: cutB, projection: b.projection, fold: b.fold, baseRefs: [] });
    const envelopeB = await store.readCheckpoint('task-6');
    expect(envelopeB?.priorCheckpointDigest).toBe(aDigest);
    expect(bDigest).not.toBe(aDigest);
    void bDigest;
  });
});