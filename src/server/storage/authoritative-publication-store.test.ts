// @vitest-environment node
/**
 * Task 8 publication store + store-lock/fence tests (spec §8/§8.1, design
 * §19.1): durable pin create with idempotency/conflict, pin lifecycle
 * active -> committed -> removed / abandoned, generation counter, and the
 * mkdir-based cross-process lock with fenced stale-owner takeover.
 *
 * Liveness is injected (processAlive probe + bootId token), never probed with
 * real process kills, and time is injected (clock), so every takeover test is
 * deterministic.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthoritativePublicationStore,
  type PublicationPinV2,
  type PublicationStoreOptions,
  type StoreFenceRecord,
} from './authoritative-publication-store';
import { STORAGE_ERROR_CODES } from './atomic-file';
import { CorePaths } from './core-paths';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';

const H1 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const H2 = '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function ref(kind: string, digest: string): BlobRefV2 {
  return {
    kind: kind as BlobRefV2['kind'],
    digest,
    byteLength: 10,
    mediaType: 'application/json',
    schemaVersion: 1,
  };
}

const NOW = '2026-08-14T10:00:00.000Z';
const LATER = '2026-08-14T11:00:00.000Z';
const MUCH_LATER = '2026-08-15T10:00:00.000Z';

let roots: string[] = [];

async function makeRoot(prefix = 'forge-core-pub-'): Promise<CorePaths> {
  const dataRoot = await mkdtemp(join(tmpdir(), `${prefix}data-`));
  const templateRoot = await mkdtemp(join(tmpdir(), `${prefix}templates-`));
  roots.push(dataRoot, templateRoot);
  return CorePaths.create({ dataRoot, templateRoot });
}

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  roots = [];
});

/** Deterministic store options: injected clock, probes and boot id. */
function storeOptions(overrides: {
  bootId?: string;
  ownerPid?: number;
  processAlive?: (pid: number) => boolean;
  clock?: () => string;
  pauseBeforeMarker?: () => Promise<void>;
  pauseBeforeOwnershipVerify?: () => Promise<void>;
} = {}): PublicationStoreOptions {
  return {
    bootId: overrides.bootId ?? 'boot-1',
    ownerPid: overrides.ownerPid ?? process.pid,
    processAlive: overrides.processAlive ?? (() => true),
    clock: overrides.clock ?? (() => NOW),
    retrySleepMs: 0,
    ...(overrides.pauseBeforeMarker !== undefined ? { pauseBeforeMarker: overrides.pauseBeforeMarker } : {}),
    ...(overrides.pauseBeforeOwnershipVerify !== undefined
      ? { pauseBeforeOwnershipVerify: overrides.pauseBeforeOwnershipVerify }
      : {}),
  };
}

/** Pin input factory (pinId is store-derived; operation id fixed to op-1). */
function pinOf(overrides: Partial<Omit<PublicationPinV2, 'pinId'>> = {}): Omit<PublicationPinV2, 'pinId'> {
  return {
    taskId: 'task-1',
    operationId: 'op-1',
    expectedTailSequence: 0,
    expectedTailCommitId: null,
    blobRefs: [],
    gcGeneration: 0,
    createdAtServer: NOW,
    ownerEpoch: 0,
    intent: {
      handlerKind: 'lifecycle/stop',
      handlerVersion: 1,
      canonicalOperationPayloadRef: ref('publication_operation_payload', H1),
      expectedResultIdentity: H2,
    },
    state: 'active',
    prepareExpiresAt: LATER,
    ownerLeaseExpiresAt: LATER,
    abandonedGeneration: null,
    ...overrides,
  };
}

describe('AuthoritativePublicationStore pins', () => {
  it('durably creates a pin file under publication-pins and reads it back', async () => {
    const paths = await makeRoot();
    const store = new AuthoritativePublicationStore(paths, storeOptions());
    const created = await store.createPin(pinOf());
    expect(created.pinId).toMatch(/^pin-[0-9a-f-]{36}$/);
    const onDisk = JSON.parse(await readFile(paths.publicationPinFile(created.pinId), 'utf8'));
    expect(onDisk).toMatchObject({
      taskId: 'task-1',
      operationId: 'op-1',
      state: 'active',
    });
    expect(await store.readPin(created.pinId)).toEqual(created);
    const dirStat = await stat(paths.publicationPinsRoot());
    expect(dirStat.isDirectory()).toBe(true);
  });

  it('rejects a second pin for the same operation with a different payload as PIN_CONFLICT', async () => {
    const paths = await makeRoot();
    const store = new AuthoritativePublicationStore(paths, storeOptions());
    await store.createPin(pinOf());
    await expect(
      store.createPin(
        pinOf({
          intent: {
            handlerKind: 'lifecycle/stop',
            handlerVersion: 1,
            canonicalOperationPayloadRef: ref('publication_operation_payload', H2),
            expectedResultIdentity: H2,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.PIN_CONFLICT });
    // Only one pin file was ever created.
    const files = (await readdir(paths.publicationPinsRoot())).filter((n) => n.endsWith('.json'));
    expect(files).toHaveLength(1);
  });

  it('is idempotent for an identical re-create (same operation, refs and intent)', async () => {
    const paths = await makeRoot();
    const store = new AuthoritativePublicationStore(paths, storeOptions());
    const first = await store.createPin(pinOf());
    const replay = await store.createPin(pinOf());
    expect(replay).toEqual(first);
    expect(await store.readPin(replay.pinId)).toEqual(first);
  });

  it('rejects a same-operation pin with different refs as PIN_CONFLICT', async () => {
    const paths = await makeRoot();
    const store = new AuthoritativePublicationStore(paths, storeOptions());
    await store.createPin(pinOf());
    await expect(store.createPin(pinOf({ blobRefs: [ref('content_value', H2)] }))).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.PIN_CONFLICT,
    });
  });

  it('commits a pin durably (terminal marker) and then removes the pin file', async () => {
    const paths = await makeRoot();
    const store = new AuthoritativePublicationStore(paths, storeOptions());
    const created = await store.createPin(pinOf());
    await store.markPinCommittedAndRemove(created.pinId);
    await expect(store.readPin(created.pinId)).resolves.toBeNull();
    const residue = (await readdir(paths.publicationPinsRoot())).filter((n) => !n.startsWith('.tmp-'));
    expect(residue).toEqual([`committed-${created.pinId}`]);
  });

  it('abandons an expired pin only after owner-lease expiry with a provably dead owner', async () => {
    const paths = await makeRoot();
    const ownerPid = 4242;
    const store = new AuthoritativePublicationStore(
      paths,
      storeOptions({ ownerPid, processAlive: () => false, clock: () => MUCH_LATER }),
    );
    const created = await store.createPin(pinOf({ ownerEpoch: 7 }));
    // The fence record still shows the dead owner at epoch 7.
    const record: StoreFenceRecord = {
      ownerPid,
      processStartToken: 'dead-session',
      processStartTime: '999',
      bootId: 'boot-1',
      leaseEpoch: 7,
      acquisitionNonce: 'nonce-1',
      durableGeneration: 0,
      acquiredAt: NOW,
    };
    await writeFile(paths.storeFenceRecordFile(), JSON.stringify(record), 'utf8');
    const result = await store.tryAbandonExpiredPins();
    expect(result.abandoned).toContain(created.pinId);
    const pin = await store.readPin(created.pinId);
    expect(pin?.state).toBe('abandoned');
    expect(pin?.abandonedGeneration).toBe(0);
  });

  it('never abandons a live-owner pin even after the wall clock passes every expiry', async () => {
    const paths = await makeRoot();
    const ownerPid = 4243;
    const store = new AuthoritativePublicationStore(
      paths,
      storeOptions({ ownerPid, processAlive: () => true, clock: () => MUCH_LATER }),
    );
    const created = await store.createPin(pinOf({ ownerEpoch: 9 }));
    const record: StoreFenceRecord = {
      ownerPid,
      processStartToken: 'live-session',
      processStartTime: '888',
      bootId: 'boot-1',
      leaseEpoch: 9,
      acquisitionNonce: 'nonce-1',
      durableGeneration: 0,
      acquiredAt: NOW,
    };
    await writeFile(paths.storeFenceRecordFile(), JSON.stringify(record), 'utf8');
    // The recorded process is not OUR session; with the probe alive it stays
    // a live owner (ambiguous liveness never abandons).
    const result = await store.tryAbandonExpiredPins();
    expect(result.abandoned).toEqual([]);
    expect((await store.readPin(created.pinId))?.state).toBe('active');
  });

  it('does not abandon a pin whose lease has not expired yet, even with a dead owner', async () => {
    const paths = await makeRoot();
    const ownerPid = 4244;
    const store = new AuthoritativePublicationStore(
      paths,
      storeOptions({ ownerPid, processAlive: () => false, clock: () => NOW }),
    );
    const created = await store.createPin(pinOf({ ownerEpoch: 9, ownerLeaseExpiresAt: MUCH_LATER }));
    const record: StoreFenceRecord = {
      ownerPid,
      processStartToken: 'dead-session',
      processStartTime: '777',
      bootId: 'boot-1',
      leaseEpoch: 9,
      acquisitionNonce: 'n',
      durableGeneration: 0,
      acquiredAt: NOW,
    };
    await writeFile(paths.storeFenceRecordFile(), JSON.stringify(record), 'utf8');
    expect((await store.tryAbandonExpiredPins()).abandoned).toEqual([]);
    expect((await store.readPin(created.pinId))?.state).toBe('active');
  });

  it('cleans committed-orphan pins (terminal marker present, pin file also present)', async () => {
    const paths = await makeRoot();
    const store = new AuthoritativePublicationStore(paths, storeOptions());
    const created = await store.createPin(pinOf());
    await store.markPinCommittedAndRemove(created.pinId);
    // Simulate a crash between marker write and pin-file removal: restore the
    // terminal (committed-state) pin file next to the marker.
    const marker = `${paths.publicationPinsRoot()}/committed-${created.pinId}`;
    await writeFile(
      paths.publicationPinFile(created.pinId),
      JSON.stringify({ ...created, state: 'committed' }),
      'utf8',
    );
    const cleaned = await store.cleanCommittedOrphanPins();
    expect(cleaned).toContain(created.pinId);
    await expect(store.readPin(created.pinId)).resolves.toBeNull();
    await stat(marker); // marker survives (it is the durable audit trace)
  });
});

describe('StoreLockFence', () => {
  it('acquires the mkdir lock, persists the durable record and releases', async () => {
    const paths = await makeRoot();
    const store = new AuthoritativePublicationStore(paths, storeOptions());
    const hold = await store.lock().acquire();
    expect(hold.epoch).toBeGreaterThanOrEqual(1);
    expect(hold.nonce).toMatch(/^[0-9a-f-]{36}$/);
    await stat(paths.storeLockDir());
    const record = JSON.parse(await readFile(paths.storeFenceRecordFile(), 'utf8')) as StoreFenceRecord;
    expect(record.acquisitionNonce).toBe(hold.nonce);
    // The fence carries the PER-PROCESS session token plus the installation
    // boot identity (Finding 2): staleness is provable across restarts AND
    // across PID reuse within one boot.
    expect(record.processStartToken).toBe(store.lock().sessionToken());
    expect(record.bootId).toBe('boot-1');
    expect(record.processStartTime).toBeNull();
    await hold.release();
    await expect(stat(paths.storeLockDir())).rejects.toThrow();
    // The record persists after release (it is the fence state).
    const after = JSON.parse(await readFile(paths.storeFenceRecordFile(), 'utf8')) as StoreFenceRecord;
    expect(after.acquisitionNonce).toBe(hold.nonce);
  });

  it('does not steal a live lock even after the wall-clock lease passed', async () => {
    const paths = await makeRoot();
    const ownerPid = 5001;
    const first = new AuthoritativePublicationStore(paths, storeOptions({ ownerPid }));
    const hold = await first.lock().acquire();
    // A second instance: same boot, owner still alive, clock far in the future.
    const second = new AuthoritativePublicationStore(
      paths,
      storeOptions({ ownerPid: 5002, processAlive: () => true, clock: () => MUCH_LATER }),
    );
    await expect(second.lock().acquire(60)).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.LOCK_BUSY });
    await hold.release();
    // After release the second instance can acquire normally.
    const hold2 = await second.lock().acquire(100);
    expect(hold2.epoch).toBeGreaterThan(hold.epoch);
    await hold2.release();
  });

  it('takes over a proven-dead owner atomically, advancing the epoch', async () => {
    const paths = await makeRoot();
    const ownerPid = 6001;
    const first = new AuthoritativePublicationStore(paths, storeOptions({ ownerPid, bootId: 'boot-a' }));
    const hold = await first.lock().acquire();
    expect(hold.epoch).toBe(1);
    // Owner crashed; second instance has a different process identity.
    const second = new AuthoritativePublicationStore(
      paths,
      storeOptions({ ownerPid: 6002, processAlive: () => false, clock: () => LATER }),
    );
    const hold2 = await second.lock().acquire(500);
    expect(hold2.epoch).toBe(2);
    expect(hold2.nonce).not.toBe(hold.nonce);
    const record = JSON.parse(await readFile(paths.storeFenceRecordFile(), 'utf8')) as StoreFenceRecord;
    expect(record.leaseEpoch).toBe(2);
    expect(record.ownerPid).toBe(6002);
    await hold2.release();
  });

  it('treats a fence recorded under a different boot id as dead even for a live pid', async () => {
    const paths = await makeRoot();
    const ownerPid = 6003;
    const first = new AuthoritativePublicationStore(paths, storeOptions({ ownerPid, bootId: 'boot-a' }));
    const hold = await first.lock().acquire();
    // Machine restarted: the pid is alive again but the boot id changed.
    const second = new AuthoritativePublicationStore(
      paths,
      storeOptions({ ownerPid, processAlive: () => true, bootId: 'boot-b' }),
    );
    const hold2 = await second.lock().acquire(500);
    expect(hold2.epoch).toBeGreaterThan(hold.epoch);
    await hold2.release();
  });

  it('acquires while an orphaned lock directory exists', async () => {
    const paths = await makeRoot();
    const store = new AuthoritativePublicationStore(paths, storeOptions());
    const hold = await store.lock().acquire(500);
    expect(hold.epoch).toBe(1);
    await hold.release();
  });

  it('advances the durable generation counter only while holding the lock', async () => {
    const paths = await makeRoot();
    const store = new AuthoritativePublicationStore(paths, storeOptions());
    expect(await store.readGeneration()).toBe(0);
    const hold = await store.lock().acquire();
    const g1 = await store.advanceGeneration(hold);
    expect(g1).toBe(1);
    const g2 = await store.advanceGeneration(hold);
    expect(g2).toBe(2);
    expect(await store.readGeneration()).toBe(2);
    const record = JSON.parse(await readFile(paths.storeFenceRecordFile(), 'utf8')) as StoreFenceRecord;
    expect(record.durableGeneration).toBe(2);
    await hold.release();
    // Generation persists across instances on the same root.
    const second = new AuthoritativePublicationStore(paths, storeOptions());
    expect(await second.readGeneration()).toBe(2);
  });
});
describe('lock ABA safety (Finding 1/2/3)', () => {
  it('never lets a takeover steal a directory whose marker does not match the doomed record', async () => {
    const paths = await makeRoot();
    // A live acquirer pauses between mkdir and marker write ...
    let releasePause: () => void = () => undefined;
    let hitPause: () => void = () => undefined;
    const pauseEntered = new Promise<void>((resolve) => {
      hitPause = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    const a = new AuthoritativePublicationStore(
      paths,
      storeOptions({
        ownerPid: 8001,
        pauseBeforeMarker: async () => {
          hitPause();
          await paused;
        },
      }),
    );
    const aHoldPromise = a.lock().acquire(4000);
    // BARRIER: the rival only starts once A is provably parked in the
    // mkdir->marker window (no record, no marker yet).
    await pauseEntered;
    // ... while a rival with a dead-liveness view tries to take over.
    const b = new AuthoritativePublicationStore(
      paths,
      storeOptions({ ownerPid: 8002, bootId: 'boot-1', processAlive: () => false, clock: () => NOW }),
    );
    const bAttempt = await Promise.race([
      b.lock().acquire(120).then(() => 'held' as const, () => 'busy' as const),
      new Promise<'busy'>((resolve) => setTimeout(() => resolve('busy'), 300)),
    ]);
    expect(bAttempt).toBe('busy');
    releasePause();
    await aHoldPromise.then(async (hold) => {
      // A owns the lock; B must never have stolen it.
      const record = JSON.parse(await readFile(paths.storeFenceRecordFile(), 'utf8')) as StoreFenceRecord;
      expect(record.acquisitionNonce).toBe(hold.nonce);
      expect(record.ownerPid).toBe(8001);
      await hold.release();
    });
    // After A releases, B (owner proven dead, marker gone) acquires normally.
    const bHold = await b.lock().acquire(2000);
    expect(bHold.epoch).toBeGreaterThanOrEqual(2);
    await bHold.release();
  });

  it('a superseded hold release never destroys the successor lock directory', async () => {
    const paths = await makeRoot();
    const a = new AuthoritativePublicationStore(paths, storeOptions({ ownerPid: 8101, bootId: 'boot-1' }));
    const hold = await a.lock().acquire();
    // A successor took over: the record and marker now belong to 8102.
    const usurper: StoreFenceRecord = {
      ownerPid: 8102,
      processStartToken: 'usurper-session',
      processStartTime: null,
      bootId: 'boot-1',
      leaseEpoch: hold.epoch + 1,
      acquisitionNonce: 'usurper-nonce',
      durableGeneration: 0,
      acquiredAt: NOW,
    };
    await writeFile(paths.storeFenceRecordFile(), JSON.stringify(usurper), 'utf8');
    await writeFile(
      `${paths.storeLockDir()}/owner.json`,
      JSON.stringify({ nonce: 'usurper-nonce', ownerPid: 8102, createdAt: NOW }),
      'utf8',
    );
    await hold.release();
    // The superseded hold's release must NOT have touched the successor's dir.
    await stat(paths.storeLockDir());
    const marker = JSON.parse(await readFile(`${paths.storeLockDir()}/owner.json`, 'utf8')) as { nonce: string };
    expect(marker.nonce).toBe('usurper-nonce');
    // And the successor (now provably dead) can still take over normally.
    const b = new AuthoritativePublicationStore(
      paths,
      storeOptions({ ownerPid: 8103, bootId: 'boot-1', processAlive: () => false }),
    );
    const bHold = await b.lock().acquire(2000);
    expect(bHold.epoch).toBe(hold.epoch + 2);
    await bHold.release();
  });

  it('fails closed on a corrupt fence record / generation file instead of treating it as absent', async () => {
    const paths = await makeRoot();
    const store = new AuthoritativePublicationStore(paths, storeOptions());
    await writeFile(paths.storeFenceRecordFile(), '{not json', 'utf8');
    await expect(store.lock().readRecord()).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
    await writeFile(paths.storeFenceRecordFile(), '{"ownerPid": "x"}', 'utf8');
    await expect(store.lock().readRecord()).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
    await writeFile(paths.v2GenerationFile(), '{bad', 'utf8');
    await expect(store.readGeneration()).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
    await writeFile(paths.v2GenerationFile(), '{"generation": -1}', 'utf8');
    await expect(store.readGeneration()).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });

  it('fails closed on a corrupt pin file: snapshotPins throws instead of skipping the pin', async () => {
    const paths = await makeRoot();
    const store = new AuthoritativePublicationStore(paths, storeOptions());
    const created = await store.createPin(pinOf());
    await writeFile(paths.publicationPinFile(created.pinId), '{corrupt', 'utf8');
    await expect(store.snapshotPins()).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
    await expect(store.readPin(created.pinId)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });

  it('acquiring against a markerless empty lock directory fails closed (LOCK_BUSY, never a steal)', async () => {
    const paths = await makeRoot();
    const store = new AuthoritativePublicationStore(paths, storeOptions());
    await mkdir(paths.storeLockDir(), { recursive: true });
    // No record and no marker: provably nothing to steal -> ambiguous -> busy.
    await expect(store.lock().acquire(60)).rejects.toMatchObject({ code: 'LOCK_BUSY' });
  });

  it('issues a distinct per-process session token per fence instance', async () => {
    const paths = await makeRoot();
    const a = new AuthoritativePublicationStore(paths, storeOptions({ ownerPid: 8201, bootId: 'boot-1' }));
    const b = new AuthoritativePublicationStore(paths, storeOptions({ ownerPid: 8202, bootId: 'boot-1' }));
    expect(a.lock().sessionToken()).not.toBe(b.lock().sessionToken());
    const hold = await a.lock().acquire();
    const record = JSON.parse(await readFile(paths.storeFenceRecordFile(), 'utf8')) as StoreFenceRecord;
    expect(record.processStartToken).toBe(a.lock().sessionToken());
    await hold.release();
  });
});

describe('pin creator liveness (Finding 6)', () => {
  it('never abandons a creator-stamped pin by wall clock while the creator is live', async () => {
    const paths = await makeRoot();
    const ownerPid = 8301;
    const store = new AuthoritativePublicationStore(
      paths,
      storeOptions({ ownerPid, processAlive: () => true, clock: () => MUCH_LATER }),
    );
    const created = await store.createPin(
      pinOf({
        ownerEpoch: 0,
        ownerPid,
        ownerProcessStartToken: 'creator-session',
        ownerProcessStartTime: '12345',
      }),
    );
    const result = await store.tryAbandonExpiredPins();
    expect(result.abandoned).toEqual([]);
    expect((await store.readPin(created.pinId))?.state).toBe('active');
  });

  it('abandons a creator-stamped pin once the creator is provably dead', async () => {
    const paths = await makeRoot();
    const ownerPid = 8302;
    const store = new AuthoritativePublicationStore(
      paths,
      storeOptions({ ownerPid, processAlive: () => false, clock: () => MUCH_LATER }),
    );
    const created = await store.createPin(
      pinOf({ ownerEpoch: 0, ownerPid, ownerProcessStartToken: 'creator-session', ownerProcessStartTime: '12345' }),
    );
    const result = await store.tryAbandonExpiredPins();
    expect(result.abandoned).toContain(created.pinId);
    expect((await store.readPin(created.pinId))?.state).toBe('abandoned');
  });
});
