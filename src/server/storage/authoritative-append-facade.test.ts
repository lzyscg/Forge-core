// @vitest-environment node
/**
 * Task 8 authoritative append facade tests (spec §8/§8.1, design §19.1):
 * put-before-append pin protection, the crash matrix (before put / after put
 * before append / after append before pin cleanup / response loss), recovery
 * (legal byte-identical replay vs fail-closed abandonment), the two-instance
 * race (idempotent replay or non-overlapping ordered batches), live-lock
 * non-steal vs dead-owner epoch takeover, stale cached manifests, ref
 * removal between prepare and lock, artifact version allocation, and the
 * dependency boundary (no EventStore behind the facade; every v2 append
 * carries a live fence proof).
 *
 * "Process death" is simulated by injected liveness probes and boot ids —
 * never real process kills (deterministic, no flaky timing).
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CorePaths } from './core-paths';
import { EventStore } from './event-store';
import { AuthoritativeReviewBlobStore } from './authoritative-review-blob-store';
import {
  AuthoritativePublicationStore,
  type PublicationStoreOptions,
} from './authoritative-publication-store';
import {
  AuthoritativeAppendFacadeV2,
  type PublishWithPinInput,
} from './authoritative-append-facade';
import { PublicationIntentRegistry } from './authoritative-publication-intent-registry';
import type { TaskEvent } from './task-events';
import { STORAGE_ERROR_CODES } from './atomic-file';
import { canonicalJsonSha256 } from '../structured-slots/canonical-json';
import { fullProfileForTests } from '../authoritative-review/object-registry';
import type { AuthoritativeBlobKindV2, BlobRefV2 } from '../../shared/authoritative-review-v2';

const H1 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const H2 = '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const H3 = '2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const H4 = '3123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const H5 = '4123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const NOW = '2026-08-14T10:00:00.000Z';

let roots: string[] = [];

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  roots = [];
});

interface Env {
  paths: CorePaths;
  eventStore: EventStore;
  blobStore: AuthoritativeReviewBlobStore;
  publicationStore: AuthoritativePublicationStore;
  facade: AuthoritativeAppendFacadeV2;
  now: { value: string };
  alive: { value: boolean };
}

async function makePaths(prefix = 'forge-core-facade-'): Promise<CorePaths> {
  const dataRoot = await mkdtemp(join(tmpdir(), `${prefix}data-`));
  const templateRoot = await mkdtemp(join(tmpdir(), `${prefix}templates-`));
  roots.push(dataRoot, templateRoot);
  return CorePaths.create({ dataRoot, templateRoot });
}

function storeOptions(overrides: {
  bootId?: string;
  ownerPid?: number;
  processAlive?: () => boolean;
  clock?: () => string;
} = {}): PublicationStoreOptions {
  return {
    bootId: overrides.bootId ?? 'boot-1',
    ownerPid: overrides.ownerPid ?? process.pid,
    processAlive: overrides.processAlive ?? (() => true),
    clock: overrides.clock ?? (() => NOW),
    retrySleepMs: 0,
  };
}

async function makeEnv(paths: CorePaths, overrides: {
  storeOptions?: PublicationStoreOptions;
  registry?: PublicationIntentRegistry;
} = {}): Promise<Env> {
  const eventStore = new EventStore(paths);
  const blobStore = new AuthoritativeReviewBlobStore(paths, fullProfileForTests());
  const now = { value: NOW };
  const alive = { value: true };
  const publicationStore = new AuthoritativePublicationStore(
    paths,
    overrides.storeOptions ??
      storeOptions({
        processAlive: () => alive.value,
        clock: () => now.value,
      }),
  );
  const registry = overrides.registry ?? new PublicationIntentRegistry();
  const facade = new AuthoritativeAppendFacadeV2({
    eventStore,
    blobStore,
    publicationStore,
    profile: fullProfileForTests(),
    paths,
    registry,
    clock: () => now.value,
  });
  return { paths, eventStore, blobStore, publicationStore, facade, now, alive };
}

/** content_value body with a REAL self digest (the schema verifies it). */
function contentValue(text: string): Record<string, unknown> {
  const without = {
    slotId: 's-1',
    contentSchemaDigest: H1,
    taskContentRevision: 1,
    mediaType: 'text/plain',
    text,
  };
  return { ...without, selfDigest: canonicalJsonSha256(without) };
}

/** Schema-valid v2 suspension event (the state-only facade family). */
function suspensionEvent(id: string, operationId: string, suspensionId: string): TaskEvent {
  return {
    protocolVersion: 2,
    id,
    at: NOW,
    type: 'structured_task_suspension_applied_v2',
    suspensionId,
    reason: 'user_stop',
    operationId,
  };
}

function intent(handlerKind: string, expectedResultIdentity?: string) {
  return { handlerKind, handlerVersion: 1, expectedResultIdentity };
}

/** Task 10 lifecycle payload: the union gained explicit reason/lease fields. */
function stopPayload(taskId: string, operationId: string, suspensionId: string | null, reason: string | null = null): Record<string, unknown> {
  return {
    family: 'lifecycle',
    operationId,
    taskId,
    kind: 'stop',
    suspensionId,
    workItemId: null,
    reason,
    leaseEpoch: null,
    expectedLastSequence: null,
    authorityBaseRef: null,
    attemptFamily: null,
    attemptId: null,
    commandId: null,
    agentId: null,
    commandKind: null,
    logicalAssignmentId: null,
    reviewAssignmentId: null,
    sessionKind: null,
    inputArtifactDeliveryId: null,
    workItemKind: null,
    roleBinding: null,
    agentExecutionKind: null,
    roundId: null,
    grantSpecRef: null,
    payloadRef: null,
    initialLeaseEpoch: null,
    maxAutomaticRetries: null,
    mapBuildId: null,
    supersedesMapBuildId: null,
    sourceValidationReceiptRef: null,
  };
}

async function blobExists(paths: CorePaths, taskId: string, ref: BlobRefV2): Promise<boolean> {
  try {
    await stat(paths.taskStructuredV2BlobFile(taskId, ref.kind, ref.digest));
    return true;
  } catch {
    return false;
  }
}

async function batchFileNames(paths: CorePaths, taskId: string): Promise<string[]> {
  try {
    return (await readdir(paths.taskEventsRoot(taskId)))
      .filter((name) => name.endsWith('.batch.json'))
      .sort();
  } catch {
    return [];
  }
}

describe('AuthoritativeAppendFacadeV2 publish/commit', () => {
  it('publishes a state-only mutation through pin -> put -> locked commit -> pin cleanup', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    const result = await env.facade.publishWithPin({
      taskId,
      operationId: 'op-pub-1',
      payload: stopPayload(taskId, 'op-pub-1', 'sus-1'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.event.type).toBe('structured_task_suspension_applied_v2');
    expect(result.generation).toBe(1);
    // The batch envelope records the publicationPinId for audit.
    const names = await batchFileNames(paths, taskId);
    expect(names).toHaveLength(1);
    const envelope = JSON.parse(await readFile(`${paths.taskEventsRoot(taskId)}/${names[0]}`, 'utf8'));
    expect(envelope.publicationPinId).toBe(result.pinId);
    // The pin is cleaned after the durable commit.
    expect(await env.publicationStore.readPin(result.pinId)).toBeNull();
    expect(await env.publicationStore.snapshotPins()).toHaveLength(0);
    const committed = await env.eventStore.readBatchByCommitId(taskId, 'op-pub-1');
    expect(committed).not.toBeNull();
  });

  it('replays the committed result for the same operation/commit id (response loss)', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    const first = await env.facade.publishWithPin({
      taskId,
      operationId: 'op-replay-1',
      payload: stopPayload(taskId, 'op-replay-1', 'sus-2'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    const again = await env.facade.publishWithPin({
      taskId,
      operationId: 'op-replay-1',
      payload: stopPayload(taskId, 'op-replay-1', 'sus-2'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    expect(again.events.map((e) => e.event)).toEqual(first.events.map((e) => e.event));
    expect(await batchFileNames(paths, taskId)).toHaveLength(1);
    const tail = await env.eventStore.tail(taskId);
    expect(tail.lastCommitId).toBe('op-replay-1');
    expect(tail.lastSequence).toBe(1);
  });

  it('conflicts on the same operation id with a different payload', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    await env.facade.publishWithPin({
      taskId,
      operationId: 'op-conflict-1',
      payload: stopPayload(taskId, 'op-conflict-1', 'sus-a'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    await expect(
      env.facade.publishWithPin({
        taskId,
        operationId: 'op-conflict-1',
        payload: stopPayload(taskId, 'op-conflict-1', 'sus-b'),
        intent: intent('lifecycle/stop'),
        expectedTailSequence: 1,
        expectedTailCommitId: 'op-conflict-1',
      }),
    ).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.PIN_CONFLICT });
    // A different operation id commits normally on the new tail.
    const later = await env.facade.publishWithPin({
      taskId,
      operationId: 'op-after',
      payload: stopPayload(taskId, 'op-after', 'sus-c'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 1,
      expectedTailCommitId: 'op-conflict-1',
    });
    expect(later.events[0]?.sequence).toBe(2);
  });

  it('rejects a stale expected tail (manifest must be reloaded from disk, never cached)', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    await env.facade.publishWithPin({
      taskId,
      operationId: 'op-t1',
      payload: stopPayload(taskId, 'op-t1', 'sus-1'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    // A second instance commits on the new tail...
    const second = await makeEnv(paths);
    await second.facade.publishWithPin({
      taskId,
      operationId: 'op-t2',
      payload: stopPayload(taskId, 'op-t2', 'sus-2'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 1,
      expectedTailCommitId: 'op-t1',
    });
    // ...and the first instance discovers the mismatch instead of overlapping.
    await expect(
      env.facade.publishWithPin({
        taskId,
        operationId: 'op-t3-stale',
        payload: stopPayload(taskId, 'op-t3-stale', 'sus-3'),
        intent: intent('lifecycle/stop'),
        expectedTailSequence: 1,
        expectedTailCommitId: 'op-t1',
      }),
    ).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.EXPECTED_SEQUENCE_MISMATCH });
    const tail = await env.eventStore.tail(taskId);
    expect(tail.lastSequence).toBe(2);
  });

  it('commitStateOnly uses the same typed intent path with an empty prepared-ref set', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    const result = await env.facade.commitStateOnly({
      taskId,
      operationId: 'op-state-1',
      payload: stopPayload(taskId, 'op-state-1', 'sus-4'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    expect(result.events[0]?.event.type).toBe('structured_task_suspension_applied_v2');
    const committed = await env.eventStore.read(taskId);
    expect(committed).toHaveLength(1);
  });

  it('prepares blobs durably with a creation-generation sidecar', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    const ref = await env.facade.prepareBlob(taskId, 'content_value', contentValue('durable'));
    expect(await blobExists(paths, taskId, ref)).toBe(true);
    const sidecar = `${paths.taskStructuredV2BlobFile(taskId, ref.kind, ref.digest)}.gen.json`;
    const gen = JSON.parse(await readFile(sidecar, 'utf8'));
    expect(typeof gen.generation).toBe('number');
  });
});

describe('crash matrix and recovery', () => {
  it('resumes a crashed put-before-append operation byte-identically from its pin', async () => {
    const paths = await makePaths();
    const first = await makeEnv(paths);
    const taskId = randomUUID();
    const operationId = 'op-crash-1';
    // Prepare (pin + durable payload put) but the process dies before the append.
    const prepared = await first.facade.preparePublication({
      taskId,
      operationId,
      payload: stopPayload(taskId, operationId, 'sus-crash'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    expect(await first.publicationStore.readPin(prepared.pin.pinId)).not.toBeNull();
    // A whole new process instance (new boot, dead former owner) starts up.
    const second = await makeEnv(paths, {
      storeOptions: storeOptions({ bootId: 'boot-2', processAlive: () => false }),
    });
    const summary = await second.facade.startupRecovery();
    expect(summary.resumed).toHaveLength(1);
    expect(summary.resumed[0]).toBe(prepared.pin.pinId);
    // The recovered commit is the exact same envelope the crashed process would have written.
    const recovered = await second.facade.publishWithPin({
      taskId,
      operationId,
      payload: stopPayload(taskId, operationId, 'sus-crash'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    expect(recovered.events[0]?.event).toMatchObject({
      protocolVersion: 2,
      type: 'structured_task_suspension_applied_v2',
      suspensionId: 'sus-crash',
      operationId,
    });
    // Byte-identical proof: canonical JSON of committed events equals the recovery-time read.
    const fromDisk = await second.eventStore.readBatchByCommitId(taskId, operationId);
    expect(fromDisk?.map((e) => canonicalJsonSha256(e.event))).toEqual(
      recovered.events.map((e) => canonicalJsonSha256(e.event)),
    );
  });

  it('cleans the pin of a committed operation after ref verification', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    const operationId = 'op-committed-1';
    const prepared = await env.facade.preparePublication({
      taskId,
      operationId,
      payload: stopPayload(taskId, operationId, 'sus-x'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    // The process "crashed" AFTER the append but BEFORE pin cleanup:
    // commitPrepared commits and deliberately leaves the pin behind.
    await env.facade.commitPrepared(prepared.pin.pinId);
    expect(await env.eventStore.readBatchByCommitId(taskId, operationId)).not.toBeNull();
    expect(await env.publicationStore.readPin(prepared.pin.pinId)).not.toBeNull();
    // Startup recovery verifies the refs, then cleans the pin.
    const third = await makeEnv(paths, { storeOptions: storeOptions({ bootId: 'boot-3' }) });
    const summary = await third.facade.startupRecovery();
    expect(summary.cleaned).toContain(prepared.pin.pinId);
    expect(await third.publicationStore.readPin(prepared.pin.pinId)).toBeNull();
  });

  it('abandons a pin with an unknown handler/version without guessing', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    // A stale pin from a process whose handler registration no longer exists
    // (crash-before-put style: pin durable, payload never put).
    const created = await env.publicationStore.createPin({
      taskId,
      operationId: 'op-unknown-1',
      expectedTailSequence: 0,
      expectedTailCommitId: null,
      blobRefs: [],
      gcGeneration: 0,
      createdAtServer: NOW,
      ownerEpoch: 0,
      intent: {
        handlerKind: 'somewhere/unknown',
        handlerVersion: 1,
        canonicalOperationPayloadRef: dummyRef('publication_operation_payload', H1),
        expectedResultIdentity: '',
      },
      state: 'active',
      prepareExpiresAt: '2026-08-15T10:00:00.000Z',
      ownerLeaseExpiresAt: '2026-08-14T11:00:00.000Z',
      abandonedGeneration: null,
    });
    env.alive.value = false;
    env.now.value = '2026-08-16T10:00:00.000Z';
    const summary = await env.facade.startupRecovery();
    expect(summary.resumed).toEqual([]);
    expect(summary.abandoned).toContain(created.pinId);
    expect((await env.publicationStore.readPin(created.pinId))?.state).toBe('abandoned');
    // No event was ever guessed into the ledger.
    expect(await env.eventStore.read(taskId)).toEqual([]);
  });

  it('abandons a pin whose stored payload no longer reconstructs (changed bytes)', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    const operationId = 'op-tampered-1';
    const prepared = await env.facade.preparePublication({
      taskId,
      operationId,
      payload: stopPayload(taskId, operationId, 'sus-t'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    // Tamper with the payload blob at its content address.
    const payloadRef = prepared.pin.intent.canonicalOperationPayloadRef;
    const address = paths.taskStructuredV2BlobFile(taskId, payloadRef.kind, payloadRef.digest);
    await rm(address);
    await writeFile(address, JSON.stringify({ family: 'lifecycle', kind: 'stop', tampered: true }));
    env.alive.value = false;
    env.now.value = '2026-08-16T10:00:00.000Z';
    const summary = await env.facade.startupRecovery();
    expect(summary.resumed).toEqual([]);
    expect(summary.abandoned).toContain(prepared.pin.pinId);
  });

  it('abandons a pin whose expected tail no longer matches (stale authority)', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    const abandonedOp = 'op-stale-1';
    await env.facade.preparePublication({
      taskId,
      operationId: abandonedOp,
      payload: stopPayload(taskId, abandonedOp, 'sus-s'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    // The tail advances under a different operation before recovery runs.
    await env.facade.publishWithPin({
      taskId,
      operationId: 'op-advancer',
      payload: stopPayload(taskId, 'op-advancer', 'sus-a'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    env.alive.value = false;
    env.now.value = '2026-08-16T10:00:00.000Z';
    const summary = await env.facade.startupRecovery();
    expect(summary.resumed).toEqual([]);
    const pins = await env.publicationStore.snapshotPins();
    expect(pins.some((pin) => pin.operationId === abandonedOp && pin.state === 'abandoned')).toBe(true);
  });

  it('abandons a pin whose payload blob is missing (crash before put completes)', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    const store = env.publicationStore;
    // Pin exists but the payload blob was never put (crash before put).
    const created = await store.createPin({
      taskId,
      operationId: 'op-noput-1',
      expectedTailSequence: 0,
      expectedTailCommitId: null,
      blobRefs: [],
      gcGeneration: 0,
      createdAtServer: NOW,
      ownerEpoch: 0,
      intent: {
        handlerKind: 'lifecycle/stop',
        handlerVersion: 1,
        canonicalOperationPayloadRef: {
          kind: 'publication_operation_payload',
          digest: H1,
          byteLength: 10,
          mediaType: 'application/json',
          schemaVersion: 1,
        },
        expectedResultIdentity: '',
      },
      state: 'active',
      prepareExpiresAt: '2026-08-15T10:00:00.000Z',
      ownerLeaseExpiresAt: '2026-08-14T11:00:00.000Z',
      abandonedGeneration: null,
    });
    env.alive.value = false;
    env.now.value = '2026-08-16T10:00:00.000Z';
    const summary = await env.facade.startupRecovery();
    expect(summary.abandoned).toContain(created.pinId);
    expect(await env.eventStore.read(taskId)).toEqual([]);
  });
});

describe('two-instance races over one data root', () => {
  it('two instances racing the same operation converge to one committed batch', async () => {
    const paths = await makePaths();
    const a = await makeEnv(paths, { storeOptions: storeOptions({ ownerPid: 7001, bootId: 'boot-a', processAlive: () => true }) });
    const b = await makeEnv(paths, { storeOptions: storeOptions({ ownerPid: 7002, bootId: 'boot-a', processAlive: () => true }) });
    const taskId = randomUUID();
    const operationId = 'op-race-same';
    const payload = stopPayload(taskId, operationId, 'sus-r');
    const both = await Promise.allSettled([
      a.facade.publishWithPin({ taskId, operationId, payload, intent: intent('lifecycle/stop'), expectedTailSequence: 0, expectedTailCommitId: null }),
      b.facade.publishWithPin({ taskId, operationId, payload, intent: intent('lifecycle/stop'), expectedTailSequence: 0, expectedTailCommitId: null }),
    ]);
    const winners = both.filter((r) => r.status === 'fulfilled');
    expect(both.some((r) => r.status === 'rejected')).toBe(false);
    expect(winners).toHaveLength(2);
    // Exactly one non-overlapping ordered batch; both callers returned the same committed events.
    const names = await batchFileNames(paths, taskId);
    expect(names).toHaveLength(1);
    const tail = await a.eventStore.tail(taskId);
    expect(tail.lastSequence).toBe(1);
    const committed = await a.eventStore.read(taskId);
    expect(committed).toHaveLength(1);
    const w0 = both[0] as PromiseFulfilledResult<{ events: { sequence: number }[] }>;
    const w1 = both[1] as PromiseFulfilledResult<{ events: { sequence: number }[] }>;
    expect(w0.value.events.map((e) => e.sequence)).toEqual(w1.value.events.map((e) => e.sequence));
  });

  it('two instances racing different operations produce ordered non-overlapping batches', async () => {
    const paths = await makePaths();
    const a = await makeEnv(paths, { storeOptions: storeOptions({ ownerPid: 7101, bootId: 'boot-a', processAlive: () => true }) });
    const b = await makeEnv(paths, { storeOptions: storeOptions({ ownerPid: 7102, bootId: 'boot-a', processAlive: () => true }) });
    const taskId = randomUUID();
    const results = await Promise.allSettled([
      a.facade.publishWithPin({
        taskId,
        operationId: 'op-race-a',
        payload: stopPayload(taskId, 'op-race-a', 'sus-a'),
        intent: intent('lifecycle/stop'),
        expectedTailSequence: 0,
        expectedTailCommitId: null,
      }),
      b.facade.publishWithPin({
        taskId,
        operationId: 'op-race-b',
        payload: stopPayload(taskId, 'op-race-b', 'sus-b'),
        intent: intent('lifecycle/stop'),
        expectedTailSequence: 0,
        expectedTailCommitId: null,
      }),
    ]);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    // Exactly one commit exists (the CAS rejected the loser); the two calls never
    // produced overlapping sequence files or two batches at the same tail.
    const batches = await batchFileNames(paths, taskId);
    expect(batches).toHaveLength(1);
    const events = await a.eventStore.read(taskId);
    expect(events).toHaveLength(1);
    const tail = await a.eventStore.tail(taskId);
    expect(tail.lastCommitId === 'op-race-a' || tail.lastCommitId === 'op-race-b').toBe(true);
    // The survivor (whichever instance won) saw only the winner's commit.
    if (failed.length === 1) {
      expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
        code: STORAGE_ERROR_CODES.EXPECTED_SEQUENCE_MISMATCH,
      });
    }
  });

  it('never reuses an in-flight pin for a different operation (pins stay independent)', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    const first = await env.facade.preparePublication({
      taskId,
      operationId: 'op-pin-1',
      payload: stopPayload(taskId, 'op-pin-1', 'sus-1'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    const second = await env.facade.preparePublication({
      taskId,
      operationId: 'op-pin-2',
      payload: stopPayload(taskId, 'op-pin-2', 'sus-2'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    expect(second.pin.pinId).not.toBe(first.pin.pinId);
    const pins = await env.publicationStore.snapshotPins();
    expect(pins).toHaveLength(2);
  });
});

describe('artifact version allocation (artifact_publish family)', () => {
  /** Builds a valid artifact + sealRecord + delivery blob set (schema-frozen, refs closed). */
  async function prepareArtifactSet(env: Env, taskId: string) {
    const artifact = await env.facade.prepareBlob(taskId, 'artifact', {
      artifactId: 'art-42',
      mediaType: 'text/markdown',
      text: '# result',
    });
    const mapRef = dummyRef('map_snapshot', H1);
    const mapReviewBundleRef = dummyRef('map_review_bundle', H2);
    const manifestRef = dummyRef('content_revision_manifest', H3);
    const reviewBundleRef = dummyRef('review_bundle', H4);
    const sealValidationBundleRef = dummyRef('seal_validation_bundle', H5);
    const sealRecord = await env.facade.prepareBlob(taskId, 'seal_record', {
      taskId,
      mapRef,
      mapSemanticDigest: H1,
      mapReviewBundleRef,
      contentRevisionManifestRef: manifestRef,
      contentRootDigest: H2,
      reviewBundleRef,
      sealValidationBundleRef,
      templateSnapshotHash: H3,
      assemblerDigest: H4,
      artifactRef: artifact,
      artifactDigest: artifact.digest,
    });
    const delivery = await env.facade.prepareBlob(taskId, 'system_artifact_delivery', {
      deliveryId: 'del-42',
      producer: 'system:structured_seal',
      sealRecordRef: sealRecord,
      sealRecordDigest: sealRecord.digest,
      artifactId: 'art-42',
      artifactRef: artifact,
      artifactDigest: artifact.digest,
      custodyRef: sealRecord,
      custodyDigest: sealRecord.digest,
      submitterWorkItemId: 'wi-42',
      submitterAgentId: 'agent-1',
      templateSnapshotHash: H5,
    });
    return { artifact, sealRecord, delivery };
  }

  it('allocates the expected artifact version from fresh history and conflicts on reuse', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    const set = await prepareArtifactSet(env, taskId);
    let tail = await env.eventStore.tail(taskId);
    const input = (operationId: string, expectedArtifactVersion: number, t?: { lastSequence: number; lastCommitId: string | null }): PublishWithPinInput => ({
      taskId,
      operationId,
      payload: {
        family: 'artifact_publish',
        operationId,
        taskId,
        artifactRef: set.artifact,
        sealRecordRef: set.sealRecord,
        deliveryRef: set.delivery,
        expectedArtifactVersion,
      },
      intent: intent('artifact_publish'),
      preparedRefs: [set.delivery, set.sealRecord, set.artifact],
      expectedTailSequence: t?.lastSequence ?? 0,
      expectedTailCommitId: t?.lastCommitId ?? null,
    });
    const first = await env.facade.publishWithPin(input('op-art-1', 1, tail));
    expect((first.events[0]?.event as { artifactVersion?: number }).artifactVersion).toBe(1);
    // Same version again conflicts — a version is allocated once.
    tail = await env.eventStore.tail(taskId);
    await expect(env.facade.publishWithPin(input('op-art-2', 1, tail))).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.ARTIFACT_VERSION_CONFLICT,
    });
    // The next free version commits.
    tail = await env.eventStore.tail(taskId);
    const second = await env.facade.publishWithPin(input('op-art-3', 2, tail));
    expect((second.events[0]?.event as { artifactVersion?: number }).artifactVersion).toBe(2);
  });

  it('also counts v1 artifact_published events toward allocated versions', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    // A legacy v1 artifact_published event owns version 1.
    await env.eventStore.append(taskId, {
      id: 'legacy-art-1',
      at: NOW,
      type: 'artifact_published',
      artifact: {
        version: 1,
        title: 'legacy',
        sourceNodeId: 'n-1',
        format: 'markdown',
        files: [{ name: 'a.md', hash: H1 }],
        artifactType: null,
        artifactId: 'legacy-id',
      },
    });
    const set = await prepareArtifactSet(env, taskId);
    const tail = await env.eventStore.tail(taskId);
    await expect(
      env.facade.publishWithPin({
        taskId,
        operationId: 'op-art-v1-clash',
        payload: {
          family: 'artifact_publish',
          operationId: 'op-art-v1-clash',
          taskId,
          artifactRef: set.artifact,
          sealRecordRef: set.sealRecord,
          deliveryRef: set.delivery,
          expectedArtifactVersion: 1,
        },
        intent: intent('artifact_publish'),
        preparedRefs: [set.delivery, set.sealRecord, set.artifact],
        expectedTailSequence: tail.lastSequence,
        expectedTailCommitId: tail.lastCommitId,
      }),
    ).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.ARTIFACT_VERSION_CONFLICT });
  });

  it('pins delivery before lock, allocates only the seal event version, and response-loss/race replay has no gap', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    await env.eventStore.append(taskId, {
      id: 'legacy-art-1', at: NOW, type: 'artifact_published',
      artifact: { version: 1, title: 'legacy', sourceNodeId: 'n-1', format: 'markdown', files: [{ name: 'a.md', hash: H1 }], artifactType: null, artifactId: 'legacy-id' },
    });
    const closure = await prepareSealPublishClosure(env, taskId);
    const payload = {
      family: 'seal_publish' as const,
      operationId: 'op-system-seal', taskId,
      artifactRef: closure.artifact, artifactFile: 'chapter.md', artifactFileHash: H1,
      sealRecordRef: closure.sealRecord,
      sealValidationBundleRef: closure.sealValidationBundle,
      deliveryRef: closure.delivery, custodyRef: closure.custody,
      mapRef: closure.map,
      contentRevisionManifestRef: closure.contentRevisionManifest,
      reviewBundleRef: closure.reviewBundle,
      sealWorkItemId: 'seal-work', sealCommandId: 'seal-command', sealLeaseEpoch: 1,
      sealAuthorityBaseRef: closure.authorityBase,
      submitterWorkItemId: 'wi-42', submitterAuthorityBaseRef: closure.authorityBase,
      submitterGrantSpecRef: closure.submitterGrantSpec,
      submitterLogicalAssignmentId: 'submit-logical', submitterMaxAutomaticRetries: 2,
    };
    const tail = await env.eventStore.tail(taskId);
    const prepared = await env.facade.preparePublication({
      taskId, operationId: payload.operationId, payload,
      intent: intent('system_seal_publish'),
      preparedRefs: [
        closure.artifact, closure.sealRecord, closure.sealValidationBundle,
        closure.delivery, closure.custody, closure.map,
        closure.contentRevisionManifest, closure.reviewBundle,
        closure.authorityBase, closure.submitterGrantSpec,
      ],
      expectedTailSequence: tail.lastSequence, expectedTailCommitId: tail.lastCommitId,
    });
    const delivery = await env.blobStore.readJson(taskId, closure.delivery, 'system_artifact_delivery');
    expect(delivery).not.toHaveProperty('artifactVersion');
    expect(await env.publicationStore.readPin(prepared.pin.pinId)).not.toBeNull();

    // Two live processes share one boot identity. A different bootId would
    // deliberately authorize mutual dead-owner takeover and test reboot
    // fencing rather than an ordinary cross-process commit race.
    const env2 = await makeEnv(paths, {
      storeOptions: storeOptions({ bootId: 'boot-1', ownerPid: process.pid + 1, processAlive: () => true }),
    });
    const [first, replay] = await Promise.all([
      env.facade.commitPrepared(prepared.pin.pinId),
      env2.facade.commitPrepared(prepared.pin.pinId),
    ]);
    const versions = [...first.events, ...replay.events].flatMap((entry) =>
      entry.event.type === 'artifact_published_v2' ? [entry.event.artifactVersion] : [],
    );
    expect(versions).toEqual([2, 2]);
    expect(first.events.map((entry) => entry.event.type)).toEqual([
      'structured_scaffold_sealed_v2',
      'artifact_published_v2',
      'structured_system_artifact_delivery_created',
      'structured_work_item_created',
      'structured_system_command_completed',
      'structured_work_item_completed',
    ]);
    const published = first.events.find((entry) => entry.event.type === 'artifact_published_v2')?.event;
    expect(published?.type === 'artifact_published_v2' ? published.files : []).toEqual([
      { name: 'chapter.md', hash: H1 },
    ]);
    const history = await env.eventStore.read(taskId);
    expect(history.filter((entry) => entry.event.type === 'artifact_published_v2')).toHaveLength(1);
    expect(history.flatMap((entry) => {
      if (entry.event.type === 'artifact_published') return [entry.event.artifact.version];
      if (entry.event.type === 'artifact_published_v2') return [entry.event.artifactVersion];
      return [];
    })).toEqual([1, 2]);
  });

  it('fails closed at commit when the delivery blob disagrees with the pinned sealRecordRef (P1#3)', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    const closure = await prepareSealPublishClosure(env, taskId);
    // A schema-legal but mutually INCONSISTENT delivery: its sealRecordRef
    // points at a different seal record than the pin's payload pins.
    const rogueSealRecord = await env.facade.prepareBlob(taskId, 'seal_record', {
      taskId,
      mapRef: closure.map,
      mapSemanticDigest: H1,
      mapReviewBundleRef: dummyRef('map_review_bundle', H5),
      contentRevisionManifestRef: closure.contentRevisionManifest,
      contentRootDigest: H2,
      reviewBundleRef: closure.reviewBundle,
      sealValidationBundleRef: closure.sealValidationBundle,
      templateSnapshotHash: H4, // differs from the consistent closure
      assemblerDigest: H4,
      artifactRef: closure.artifact,
      artifactDigest: closure.artifact.digest,
    });
    const rogueDelivery = await env.facade.prepareBlob(taskId, 'system_artifact_delivery', {
      deliveryId: 'del-rogue',
      producer: 'system:structured_seal',
      sealRecordRef: rogueSealRecord,
      sealRecordDigest: rogueSealRecord.digest,
      artifactId: 'art-42',
      artifactRef: closure.artifact,
      artifactDigest: closure.artifact.digest,
      custodyRef: closure.custody,
      custodyDigest: closure.custody.digest,
      submitterWorkItemId: 'wi-42',
      submitterAgentId: 'agent-1',
      templateSnapshotHash: H3,
    });
    const payload = {
      family: 'seal_publish' as const,
      operationId: 'op-system-seal-rogue', taskId,
      artifactRef: closure.artifact, artifactFile: 'chapter.md', artifactFileHash: H1,
      sealRecordRef: closure.sealRecord,
      sealValidationBundleRef: closure.sealValidationBundle,
      deliveryRef: rogueDelivery, custodyRef: closure.custody,
      mapRef: closure.map,
      contentRevisionManifestRef: closure.contentRevisionManifest,
      reviewBundleRef: closure.reviewBundle,
      sealWorkItemId: 'seal-work', sealCommandId: 'seal-command', sealLeaseEpoch: 1,
      sealAuthorityBaseRef: closure.authorityBase,
      submitterWorkItemId: 'wi-42', submitterAuthorityBaseRef: closure.authorityBase,
      submitterGrantSpecRef: closure.submitterGrantSpec,
      submitterLogicalAssignmentId: 'submit-logical', submitterMaxAutomaticRetries: 2,
    };
    const tail = await env.eventStore.tail(taskId);
    const prepared = await env.facade.preparePublication({
      taskId, operationId: payload.operationId, payload,
      intent: intent('system_seal_publish'),
      preparedRefs: [
        closure.artifact, closure.sealRecord, closure.sealValidationBundle,
        rogueDelivery, closure.custody, closure.map,
        closure.contentRevisionManifest, closure.reviewBundle,
        closure.authorityBase, closure.submitterGrantSpec,
      ],
      expectedTailSequence: tail.lastSequence, expectedTailCommitId: tail.lastCommitId,
    });
    await expect(env.facade.commitPrepared(prepared.pin.pinId)).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.EVENT_INVALID,
    });
    // No envelope is ever rebuilt/committed from the inconsistent closure.
    const history = await env.eventStore.read(taskId);
    expect(history.filter((entry) => entry.event.type === 'artifact_published_v2')).toHaveLength(0);
    expect(history.filter((entry) => entry.event.type === 'structured_scaffold_sealed_v2')).toHaveLength(0);
  });
});

describe('Finding 5/6: non-rebuildable replay and creator-liveness', () => {
  it('returns the committed result for a committed operation whose pin handler is non-rebuildable', async () => {
    const paths = await makePaths();
    const registry = new PublicationIntentRegistry();
    registry.register({
      handlerKind: 'test/non_rebuildable',
      handlerVersion: 1,
      payloadFamily: 'lifecycle',
      expectedEventTypes: [],
      rebuildable: false,
      missingInputs: ['synthetic non-rebuildable handler'],
      parsePayload: (value) => {
        const o = (value ?? {}) as Record<string, unknown>;
        if (o.family !== 'lifecycle') throw new Error('not lifecycle');
        return o as never;
      },
      childRefsOf: () => [],
      resolveRefs: () => [],
      buildEvents: () => {
        throw new Error('test/non_rebuildable buildEvents must not run');
      },
      expectedResultIdentity: () => 'never',
    });
    const env = await makeEnv(paths, { registry });
    const taskId = randomUUID();
    const operationId = 'op-committed-nr';
    // Commit the operation normally via the rebuildable stop handler.
    await env.facade.publishWithPin({
      taskId,
      operationId,
      payload: stopPayload(taskId, operationId, 'sus-nr'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    // A stale pin for the SAME operation now declares the non-rebuildable
    // handler; recovery must clean it and return the committed result, never
    // invent an envelope and never raise PIN_CONFLICT (Finding 5).
    const payloadRef = await env.facade.prepareBlob(
      taskId,
      'publication_operation_payload',
      stopPayload(taskId, operationId, 'sus-nr'),
    );
    const stale = await env.publicationStore.createPin({
      taskId,
      operationId,
      expectedTailSequence: 0,
      expectedTailCommitId: null,
      blobRefs: [],
      gcGeneration: 0,
      createdAtServer: NOW,
      ownerEpoch: 0,
      intent: { handlerKind: 'test/non_rebuildable', handlerVersion: 1, canonicalOperationPayloadRef: payloadRef, expectedResultIdentity: '' },
      state: 'active',
      prepareExpiresAt: '2026-08-15T10:00:00.000Z',
      ownerLeaseExpiresAt: '2026-08-14T11:00:00.000Z',
      abandonedGeneration: null,
    });
    const summary = await env.facade.startupRecovery();
    expect(summary.cleaned).toContain(stale.pinId);
    expect(await env.publicationStore.readPin(stale.pinId)).toBeNull();
    expect(await env.eventStore.read(taskId)).toHaveLength(1);
  });

  it('treats a MISSING payload blob under a committed non-rebuildable pin as TASK_CORRUPTED, not a conflict', async () => {
    const paths = await makePaths();
    const registry = new PublicationIntentRegistry();
    registry.register({
      handlerKind: 'test/non_rebuildable',
      handlerVersion: 1,
      payloadFamily: 'lifecycle',
      expectedEventTypes: [],
      rebuildable: false,
      missingInputs: ['synthetic'],
      parsePayload: (value) => value as never,
      childRefsOf: () => [],
      resolveRefs: () => [],
      buildEvents: () => {
        throw new Error('must not run');
      },
      expectedResultIdentity: () => 'never',
    });
    const env = await makeEnv(paths, { registry });
    const taskId = randomUUID();
    const operationId = 'op-committed-nr-missing';
    await env.facade.publishWithPin({
      taskId,
      operationId,
      payload: stopPayload(taskId, operationId, 'sus-x'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    const ghostRef = await env.facade.prepareBlob(taskId, 'publication_operation_payload', stopPayload(taskId, operationId, 'OTHER'));
    await rm(paths.taskStructuredV2BlobFile(taskId, ghostRef.kind, ghostRef.digest));
    const stale = await env.publicationStore.createPin({
      taskId,
      operationId,
      expectedTailSequence: 0,
      expectedTailCommitId: null,
      blobRefs: [],
      gcGeneration: 0,
      createdAtServer: NOW,
      ownerEpoch: 0,
      intent: { handlerKind: 'test/non_rebuildable', handlerVersion: 1, canonicalOperationPayloadRef: ghostRef, expectedResultIdentity: '' },
      state: 'active',
      prepareExpiresAt: '2026-08-15T10:00:00.000Z',
      ownerLeaseExpiresAt: '2026-08-14T11:00:00.000Z',
      abandonedGeneration: null,
    });
    await expect(env.facade.startupRecovery()).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.TASK_CORRUPTED,
    });
    void stale;
  });

  it('recovers a crash inside the locked commit section (after append, before generation advance)', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    const operationId = 'op-crash-inside-lock';
    const prepared = await env.facade.preparePublication({
      taskId,
      operationId,
      payload: stopPayload(taskId, operationId, 'sus-c'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    // Simulate the crash window: the append committed durably with a live
    // fence proof, but the process died BEFORE the generation advance and
    // pin cleanup (spec §8.1 steps 4-5 never ran).
    const hold = await env.publicationStore.lock().acquire();
    const proof = await hold.proof();
    const event: TaskEvent = {
      protocolVersion: 2,
      id: 'evt-crash-inside-1',
      at: NOW,
      type: 'structured_task_suspension_applied_v2',
      suspensionId: 'sus-c',
      reason: 'user_stop',
      operationId,
    };
    await env.eventStore.appendBatch(taskId, operationId, [event], {
      expectedLastSequence: 0,
      fenceProof: proof,
      publicationPinId: prepared.pin.pinId,
    });
    await hold.release();
    expect(await env.publicationStore.readGeneration()).toBe(0);
    // Startup recovery cleans the pin after ref verification; the next
    // publish advances the generation from the stale counter deterministically.
    const summary = await env.facade.startupRecovery();
    expect(summary.cleaned).toContain(prepared.pin.pinId);
    const next = await env.facade.commitStateOnly({
      taskId,
      operationId: 'op-after-crash',
      payload: stopPayload(taskId, 'op-after-crash', 'sus-n'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 1,
      expectedTailCommitId: operationId,
    });
    expect(next.generation).toBe(1);
    expect((await env.eventStore.tail(taskId)).lastSequence).toBe(2);
  });

  it('never abandons a facade-prepared live-creator pin by wall clock; abandons it once the creator provably dies', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    const operationId = 'op-owner-live';
    await env.facade.preparePublication({
      taskId,
      operationId,
      payload: stopPayload(taskId, operationId, 'sus-o'),
      intent: intent('lifecycle/stop'),
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    const pin = (await env.publicationStore.snapshotPins())[0] as { pinId: string };
    expect(pin.pinId).toBeDefined();
    // Clock far beyond every expiry; the creator is still alive.
    env.now.value = '2026-09-01T00:00:00.000Z';
    expect((await env.publicationStore.tryAbandonExpiredPins()).abandoned).toEqual([]);
    // The creator provably dies -> the pin becomes abandoned (never guessed
    // into an envelope, quarantined for at least one GC generation).
    env.alive.value = false;
    const result = await env.publicationStore.tryAbandonExpiredPins();
    expect(result.abandoned).toContain(pin.pinId);
    expect((await env.publicationStore.readPin(pin.pinId))?.state).toBe('abandoned');
    expect(await env.eventStore.read(taskId)).toEqual([]);
  });
});

describe('store lock and fence behavior through the facade', () => {
  it('cannot steal a live lock even after lease expiry; dead owners trigger epoch takeover', async () => {
    const paths = await makePaths();
    const holder = await makeEnv(paths, { storeOptions: storeOptions({ ownerPid: 8001, bootId: 'boot-live' }) });
    const hold = await holder.publicationStore.lock().acquire();
    // Another instance: alive owner, time far beyond any lease -> no steal.
    const rival = await makeEnv(paths, {
      storeOptions: storeOptions({ ownerPid: 8002, bootId: 'boot-live', processAlive: () => true, clock: () => '2026-09-01T00:00:00.000Z' }),
    });
    await expect(rival.publicationStore.lock().acquire(60)).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.LOCK_BUSY,
    });
    // The holder dies; a boot-changed instance proves death and advances the epoch.
    await hold.release();
    const dead = await makeEnv(paths, {
      storeOptions: storeOptions({ ownerPid: 8001, bootId: 'boot-old', processAlive: () => false }),
    });
    await dead.publicationStore.lock().acquire();
    const record = JSON.parse(await readFile(paths.storeFenceRecordFile(), 'utf8')) as { leaseEpoch: number; ownerPid: number };
    expect(record.ownerPid).toBe(8001);
    expect(record.leaseEpoch).toBeGreaterThanOrEqual(1);
  });

  it('fails a publish whose prepared ref vanished between prepare and lock', async () => {
    const paths = await makePaths();
    const registry = new PublicationIntentRegistry();
    registerVanishHandler(registry);
    const env = await makeEnv(paths, { registry });
    const taskId = randomUUID();
    const preparedRef = await env.facade.prepareBlob(taskId, 'content_value', contentValue('will-vanish'));
    const payload = {
      family: 'domain_publish',
      operationId: 'op-vanish-1',
      taskId,
      publishKind: 'content_revision_commit',
      blobRefs: [preparedRef],
      expectedResultIdentity: 'never-used',
      mapBuild: null,
      mapReview: null,
      contentPlan: null,
      contentReview: null,
      repair: null,
    } as const;
    // The handler removed the prepared object after publishing its pin.
    const prepared = await env.facade.preparePublication({
      taskId,
      operationId: 'op-vanish-1',
      payload,
      intent: intent('test/vanish_handler'),
      preparedRefs: [preparedRef],
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    void prepared;
    await rm(paths.taskStructuredV2BlobFile(taskId, preparedRef.kind, preparedRef.digest));
    await expect(
      env.facade.publishWithPin({
        taskId,
        operationId: 'op-vanish-1',
        payload,
        intent: intent('test/vanish_handler'),
        preparedRefs: [preparedRef],
        expectedTailSequence: 0,
        expectedTailCommitId: null,
      }),
    ).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.TASK_CORRUPTED });
    // Nothing was committed.
    expect(await env.eventStore.read(taskId)).toEqual([]);
  });
});

describe('dependency boundary', () => {
  it('rejects every AuthoritativeReviewEventV2 appended without a live fence proof', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    const v2Event: TaskEvent = suspensionEvent('evt-direct-1', 'op-direct-1', 'sus-d');
    // Direct appendBatch without a proof is rejected before anything is written.
    await expect(
      env.eventStore.appendBatch(taskId, 'op-direct-1', [v2Event], { expectedLastSequence: 0 }),
    ).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.EVENT_INVALID });
    expect(await env.eventStore.read(taskId)).toEqual([]);
    // Direct single append of a v2 event is rejected too (the facade is the only path).
    await expect(env.eventStore.append(taskId, v2Event)).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.EVENT_INVALID,
    });
    // A forged proof (wrong nonce etc.) is rejected as well.
    const forged = {
      ownerPid: process.pid,
      processStartToken: 'boot-1',
      leaseEpoch: 1,
      acquisitionNonce: 'forged-nonce',
      durableGeneration: 0,
    };
    await expect(
      env.eventStore.appendBatch(taskId, 'op-direct-2', [v2Event], {
        expectedLastSequence: 0,
        fenceProof: forged,
      }),
    ).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.EVENT_INVALID });
  });

  it('enforces the v1 event store behavior unchanged for legacy events', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    const legacy: TaskEvent = { id: 'legacy-1', at: NOW, type: 'task_started' };
    const committed = await env.eventStore.append(taskId, legacy);
    expect(committed.sequence).toBe(1);
    // Legacy batches are byte-compatible: no publicationPinId key appears.
    const stopped: TaskEvent = { id: 'legacy-2', at: NOW, type: 'task_stopped' };
    const second = await env.eventStore.appendBatch(taskId, 'legacy-commit', [stopped], {
      expectedLastSequence: 1,
    });
    expect(second).toHaveLength(1);
    const names = (await readdir(paths.taskEventsRoot(taskId))).filter((n) => n.endsWith('.batch.json'));
    const envelope = JSON.parse(await readFile(`${paths.taskEventsRoot(taskId)}/${names[0]}`, 'utf8'));
    expect('publicationPinId' in envelope).toBe(false);
  });

  it('statically rejects EventStore imports/construction from every v2 runtime/domain source tree', async () => {
    const candidates = [
      join(process.cwd(), 'src', 'server', 'runtime', 'authoritative-review'),
      join(process.cwd(), 'src', 'server', 'authoritative-review'),
      join(process.cwd(), 'src', 'server', 'structured-slots'),
    ];
    // Import/construction forms only — docstring prose that merely names the
    // store (e.g. "no fs/EventStore/provider/HTTP/React") must not trip.
    const forbidden =
      /import\s*(?:type\s*)?[^'"]*from\s*['"][^'"]*(?:storage\/)?event-store['"]|new\s+EventStore\s*\(/;
    const scan = (dir: string): void => {
      if (!existsSync(dir)) return; // planned runtime dir may not exist yet
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          scan(full);
        } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.includes('.n1.') && !name.includes('.bench.')) {
          expect(forbidden.test(readFileSync(full, 'utf8'))).toBe(false);
        }
      }
    };
    for (const dir of candidates) scan(dir);
    // Tripwire is meaningful TODAY: at least the pure-domain tree exists.
    expect(existsSync(candidates[1] as string)).toBe(true);
  });

  it('never lets a v2 event bypass the fence through appendBatch envelope hacking', async () => {
    const paths = await makePaths();
    const env = await makeEnv(paths);
    const taskId = randomUUID();
    // A valid proof exists only after a real lock acquisition. A caller without
    // the lock cannot mint one.
    const v2Event: TaskEvent = suspensionEvent('evt-rogue-1', 'op-rogue-1', 'sus-r');
    await expect(
      env.eventStore.appendBatch(taskId, 'op-rogue-1', [v2Event], {
        expectedLastSequence: 0,
        fenceProof: {
          ownerPid: process.pid,
          processStartToken: 'boot-1',
          leaseEpoch: 99,
          acquisitionNonce: randomUUID(),
          durableGeneration: 99,
        },
        publicationPinId: 'pin-rogue',
      }),
    ).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.EVENT_INVALID });
  });
});

function dummyRef(kind: AuthoritativeBlobKindV2, digest: string): BlobRefV2 {
  return { kind, digest, byteLength: 10, mediaType: 'application/json', schemaVersion: 1 };
}

/**
 * Builds the FULL schema-valid seal closure (design §16.3): artifact, map,
 * content manifest, review bundle, seal validation bundle, seal record,
 * custody, delivery, the (shared) authority base and the submitter grant spec.
 * Every cross-object ref points at the SAME blob, so the system_seal_publish
 * closure validation in the registry passes end-to-end through the facade
 * (Task 21 P1#3). Self-digest fields follow the schema-common `hs` rule
 * (canonical bytes minus that field).
 */
async function prepareSealPublishClosure(env: Env, taskId: string) {
  const artifact = await env.facade.prepareBlob(taskId, 'artifact', {
    artifactId: 'art-42',
    mediaType: 'text/markdown',
    text: '# result',
  });
  const sealWorkItemId = 'seal-work';
  const submitterWorkItemId = 'wi-42';
  const submitterAgentId = 'agent-1';
  const templateSnapshotHash = H3;
  const mapSemanticDigest = H1;
  const contentRootDigest = H2;
  const assemblerDigest = H4;
  const mapReviewBundleRef = dummyRef('map_review_bundle', H5);

  const map = await env.facade.prepareBlob(taskId, 'map_snapshot', {
    scaffoldId: 'sc-1',
    mapId: 'map-1',
    supersedesMapId: null,
    sourceCandidateId: 'c-1',
    proposedMapCoreRef: dummyRef('proposed_map_core', H1),
    mapReviewBundleRef,
    mapRevision: 1,
    mapSemanticDigest,
    positionGraphDigest: H2,
    relationGraphDigest: H3,
    templateSnapshotHash,
    nodes: [{
      slotId: 'root', slotType: 'document', contentBearing: false,
      parentSlotId: null, documentOrder: 0, siblingOrder: 0, nodeSpecDigest: 'root-spec',
    }],
    relations: [],
    activatedAt: NOW,
  });

  const manifestCore = {
    taskId, mapRef: map, mapSemanticDigest, taskContentRevision: 1,
    manifestPhase: 'finalized' as const, entries: [],
    producerPlanSpecRef: null, priorManifestRef: null,
    finalizerValidatorAggregateRefs: [dummyRef('validator_aggregate', H4)],
    finalizerWarningRootRefs: [], contentRootDigest,
  };
  const contentRevisionManifest = await env.facade.prepareBlob(taskId, 'content_revision_manifest', {
    ...manifestCore, manifestDigest: canonicalJsonSha256(manifestCore),
  });

  const reviewBundleCore = {
    settlementCoreRef: dummyRef('content_review_settlement_core', H2),
    mapRef: map,
    contentRevisionManifestRef: contentRevisionManifest,
    reviewWarningCustodyRootRef: dummyRef('validation_warning_custody_root', H3),
  };
  const reviewBundle = await env.facade.prepareBlob(taskId, 'review_bundle', {
    ...reviewBundleCore, bundleDigest: canonicalJsonSha256(reviewBundleCore),
  });

  const sealValidationBundleCore = {
    sealWorkItemId,
    reviewBundleRef: reviewBundle,
    contentRevisionManifestRef: contentRevisionManifest,
    sealInputAggregateRef: dummyRef('validator_aggregate', H1),
    sealOutputAggregateRef: dummyRef('validator_aggregate', H2),
    sealWarningCustodyRootRef: dummyRef('validation_warning_custody_root', H3),
    assemblerDigest,
    artifactRef: artifact,
    artifactDigest: artifact.digest,
  };
  const sealValidationBundle = await env.facade.prepareBlob(taskId, 'seal_validation_bundle', {
    ...sealValidationBundleCore, bundleDigest: canonicalJsonSha256(sealValidationBundleCore),
  });

  const sealRecord = await env.facade.prepareBlob(taskId, 'seal_record', {
    taskId,
    mapRef: map,
    mapSemanticDigest,
    mapReviewBundleRef,
    contentRevisionManifestRef: contentRevisionManifest,
    contentRootDigest,
    reviewBundleRef: reviewBundle,
    sealValidationBundleRef: sealValidationBundle,
    templateSnapshotHash,
    assemblerDigest,
    artifactRef: artifact,
    artifactDigest: artifact.digest,
  });

  const custodyCore = {
    taskId,
    sealWorkItemId,
    artifactRef: artifact,
    sealRecordRef: sealRecord,
    templateSnapshotHash,
    files: [{ name: 'chapter.md', hash: H1, byteLength: 7 }],
  };
  const custody = await env.facade.prepareBlob(taskId, 'artifact_custody', {
    ...custodyCore, custodyDigest: canonicalJsonSha256(custodyCore),
  });

  const delivery = await env.facade.prepareBlob(taskId, 'system_artifact_delivery', {
    deliveryId: 'del-42',
    producer: 'system:structured_seal',
    sealRecordRef: sealRecord,
    sealRecordDigest: sealRecord.digest,
    artifactId: 'art-42',
    artifactRef: artifact,
    artifactDigest: artifact.digest,
    custodyRef: custody,
    custodyDigest: custody.digest,
    submitterWorkItemId,
    submitterAgentId,
    templateSnapshotHash,
  });

  const authorityBaseCore = {
    taskId,
    templateSnapshotRef: dummyRef('profile_snapshot', H1),
    profileSnapshotRef: dummyRef('profile_snapshot', H2),
    mapRef: map,
    mapCandidateRef: null,
    mapReviewBundleRef,
    contentRevisionManifestRef: contentRevisionManifest,
    planSpecRef: null,
    stagingManifestRef: null,
    reviewCoverageCoreRef: null,
    reviewRoundRef: null,
    reviewBundleRef: reviewBundle,
    sealRecordRef: sealRecord,
    artifactRef: artifact,
    findingSetRef: null,
    artifactDeliveryRef: delivery,
    displayDigests: {},
  };
  const authorityBase = await env.facade.prepareBlob(taskId, 'authority_base_set', {
    ...authorityBaseCore, baseSetDigest: canonicalJsonSha256(authorityBaseCore),
  });

  const grantCore = {
    grantSpecId: 'grant-wi-42',
    workItemId: submitterWorkItemId,
    kind: 'review_observation' as const,
    snapshotHash: templateSnapshotHash,
    authorityBaseRef: authorityBase,
    sessionKind: null,
    reviewAssignmentId: null,
    roundId: null,
    roundKind: null,
    readScope: { maxContextBytes: 67_108_864 },
  };
  const submitterGrantSpec = await env.facade.prepareBlob(taskId, 'write_grant_spec', {
    ...grantCore, specDigest: canonicalJsonSha256(grantCore),
  });

  return {
    artifact, map, contentRevisionManifest, reviewBundle, sealValidationBundle,
    sealRecord, custody, delivery, authorityBase, submitterGrantSpec,
  };
}

/**
 * Test-only allowlisted handler mirroring a real domain handler: domain_publish
 * with one prepared blobRef. Its build is deliberately not reachable in the
 * vanish test (ref verification runs first and fails closed).
 */
function registerVanishHandler(registry: PublicationIntentRegistry): void {
  registry.register({
    handlerKind: 'test/vanish_handler',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: ['structured_map_chunk_committed'],
    rebuildable: true,
    missingInputs: [],
    parsePayload: (value) => {
      const o = (value ?? {}) as Record<string, unknown>;
      if (o.family !== 'domain_publish' || !Array.isArray(o.blobRefs)) {
        throw new Error('not a domain_publish payload');
      }
      return o as never;
    },
    childRefsOf: (payload) => [...((payload as { blobRefs?: readonly BlobRefV2[] }).blobRefs ?? [])],
    resolveRefs: () => [],
    buildEvents: () => {
      throw new Error('test/vanish_handler buildEvents must not be reached');
    },
    expectedResultIdentity: () => 'never-used',
  });
}
