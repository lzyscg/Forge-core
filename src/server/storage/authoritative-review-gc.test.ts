// @vitest-environment node
/**
 * Task 8 recursive GC tests (spec §8, design §19.1): event-root enumeration,
 * active/abandoned pin roots, installed roots seam, generation barrier,
 * checkpoint non-roots, and fail-closed corruption abort.
 *
 * Root-chains are built through the facade with a test-only registered
 * handler (`test/gc_chunk`) that publishes `structured_map_chunk_committed`
 * with chunkRef = the prepared review_fact blob, whose evidence refs reach a
 * content_value child — a shallow schema-realistic chain.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CorePaths } from './core-paths';
import { EventStore } from './event-store';
import { AuthoritativeReviewBlobStore } from './authoritative-review-blob-store';
import { AuthoritativePublicationStore, type PublicationStoreOptions } from './authoritative-publication-store';
import { AuthoritativeAppendFacadeV2 } from './authoritative-append-facade';
import { AuthoritativeReviewGc, type GcOptions } from './authoritative-review-gc';
import {
  PublicationIntentRegistry,
  type PublicationIntentRegistrationV2,
} from './authoritative-publication-intent-registry';
import { canonicalJsonSha256 } from '../structured-slots/canonical-json';
import { fullProfileForTests } from '../authoritative-review/object-registry';
import type { AuthoritativeReviewProfile } from '../authoritative-review/authority-types';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';

const H1 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const H2 = '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const H3 = '2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const H4 = '3123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
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
  gc: AuthoritativeReviewGc;
  /** Test dials: mutate these to simulate time/process death deterministically. */
  now: { value: string };
  alive: { value: boolean };
  hooks: GcHooks;
}

interface GcHooks {
  beforeDeleteRecheck?: () => Promise<void>;
  beforeEachDelete?: (taskId: string, ref: BlobRefV2) => Promise<void>;
}

async function makeEnv(options: {
  gcOptions?: Omit<GcOptions, 'clock'>;
  profile?: AuthoritativeReviewProfile;
} = {}): Promise<Env> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'forge-core-gc-data-'));
  const templateRoot = await mkdtemp(join(tmpdir(), 'forge-core-gc-templates-'));
  roots.push(dataRoot, templateRoot);
  const paths = CorePaths.create({ dataRoot, templateRoot });
  const eventStore = new EventStore(paths);
  const blobStore = new AuthoritativeReviewBlobStore(paths, options.profile ?? fullProfileForTests());
  const now = { value: NOW };
  const alive = { value: true };
  const hooks: GcHooks = {};
  const publicationStore = new AuthoritativePublicationStore(paths, {
    bootId: 'boot-1',
    ownerPid: process.pid,
    processAlive: () => alive.value,
    clock: () => now.value,
    retrySleepMs: 0,
  });
  const registry = new PublicationIntentRegistry();
  registerChunkHandler(registry);
  const facade = new AuthoritativeAppendFacadeV2({
    eventStore,
    blobStore,
    publicationStore,
    profile: fullProfileForTests(),
    paths,
    registry,
    clock: () => now.value,
  });
  const gc = new AuthoritativeReviewGc(paths, blobStore, eventStore, publicationStore, {
    ...options.gcOptions,
    beforeDeleteRecheck: async () => {
      await options.gcOptions?.beforeDeleteRecheck?.();
      await hooks.beforeDeleteRecheck?.();
    },
    beforeEachDelete: async (taskId, ref) => {
      await options.gcOptions?.beforeEachDelete?.(taskId, ref);
      await hooks.beforeEachDelete?.(taskId, ref);
    },
  });
  return { paths, eventStore, blobStore, publicationStore, facade, gc, now, alive, hooks };
}

/** Test-only allowlisted handler: publishes structured_map_chunk_committed whose chunkRef is payload.blobRefs[0]. */
function registerChunkHandler(registry: PublicationIntentRegistry): void {
  const registration: PublicationIntentRegistrationV2 = {
    handlerKind: 'test/gc_chunk',
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
    buildEvents: (payload, at) => {
      const publish = payload as { blobRefs: readonly BlobRefV2[] };
      const chunkRef = publish.blobRefs[0];
      if (chunkRef === undefined) {
        throw new Error('test/gc_chunk requires exactly one prepared blobRef');
      }
      return [
        {
          protocolVersion: 2,
          at,
          type: 'structured_map_chunk_committed',
          mapBuildId: 'mb-1',
          chunkId: 'c-1',
          chunkOrdinal: 1,
          chunkRef,
          parentFrontierDigest: H1,
        },
      ];
    },
    expectedResultIdentity: (_payload, events) => canonicalJsonSha256(events),
  };
  registry.register(registration);
}

/** review_fact body: evidence chain into one content_value child. */
function reviewFact(evidenceRef: BlobRefV2): Record<string, unknown> {
  return {
    factId: 'f-1',
    targetKind: 'content_slot',
    targetStableId: 's-1',
    verdict: 'pass',
    factOrigin: { kind: 'batch', adoptionEligible: true },
    adoptionEligible: true,
    localSubjectDigest: H1,
    localContextDigest: H2,
    reviewPolicyDigest: H3,
    findingIds: [],
    evidence: [{ evidenceDigest: H4, text: 'evidence text', refs: [evidenceRef] }],
    reviewerAttemptId: 'a-1',
    recordedAt: NOW,
  };
}

function contentValue(text = 'hello'): Record<string, unknown> {
  const without = {
    slotId: 's-1',
    contentSchemaDigest: H1,
    taskContentRevision: 1,
    mediaType: 'text/plain',
    text,
  };
  // The registered schema verifies selfDigest against the canonical bytes
  // minus that field — compute the real digest.
  return { ...without, selfDigest: canonicalJsonSha256(without) };
}

/** The content_ref blob does not carry a selfDigest; compute+verify are the registry's job. */

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function blobPath(paths: CorePaths, taskId: string, ref: BlobRefV2): string {
  return paths.taskStructuredV2BlobFile(taskId, ref.kind, ref.digest);
}

function intent(handlerKind: string, expectedResultIdentity?: string): { handlerKind: string; handlerVersion: number; expectedResultIdentity?: string } {
  return { handlerKind, handlerVersion: 1, expectedResultIdentity };
}

async function publishChunk(env: Env, taskId: string, operationId: string, preparedRef: BlobRefV2): Promise<void> {
  await env.facade.publishWithPin({
    taskId,
    operationId,
    payload: {
      family: 'domain_publish',
      operationId,
      taskId,
      publishKind: 'map_build_commit',
      blobRefs: [preparedRef],
      expectedResultIdentity: 'never-used',
      mapBuild: null,
      mapReview: null,
    },
    intent: intent('test/gc_chunk'),
    preparedRefs: [preparedRef],
    expectedTailSequence: (await env.eventStore.tail(taskId)).lastSequence,
    expectedTailCommitId: (await env.eventStore.tail(taskId)).lastCommitId,
  });
}

describe('AuthoritativeReviewGc', () => {
  it('keeps event-rooted blobs across multiple GC generations (recursive child refs)', async () => {
    const env = await makeEnv();
    const taskId = randomUUID();
    const child = await env.facade.prepareBlob(taskId, 'content_value', contentValue());
    const fact = await env.facade.prepareBlob(taskId, 'review_fact', reviewFact(child));
    await publishChunk(env, taskId, 'gc-op-1', fact);
    for (let round = 1; round <= 3; round += 1) {
      const result = await env.gc.run();
      expect(result.markStartGeneration).toBeGreaterThanOrEqual(0);
      // Every referenced blob survives, including the recursively reached child.
      expect(await exists(blobPath(env.paths, taskId, child))).toBe(true);
      expect(await exists(blobPath(env.paths, taskId, fact))).toBe(true);
      expect((await env.eventStore.read(taskId)).map((e) => e.event.type)).toEqual([
        'structured_map_chunk_committed',
      ]);
    }
  });

  it('sweeps unreferenced orphan blobs while keeping referenced ones', async () => {
    const env = await makeEnv();
    const taskId = randomUUID();
    const orphan = await env.facade.prepareBlob(taskId, 'content_value', contentValue('orphan'));
    const child = await env.facade.prepareBlob(taskId, 'content_value', contentValue('kept'));
    const fact = await env.facade.prepareBlob(taskId, 'review_fact', reviewFact(child));
    await publishChunk(env, taskId, 'gc-op-2', fact);
    const result = await env.gc.run();
    expect(result.deletedBlobs).toBeGreaterThanOrEqual(1);
    expect(await exists(blobPath(env.paths, taskId, orphan))).toBe(false);
    expect(await exists(blobPath(env.paths, taskId, child))).toBe(true);
    expect(await exists(blobPath(env.paths, taskId, fact))).toBe(true);
  });

  it('excludes objects newer than the mark-start generation, even if unreferenced', async () => {
    const env = await makeEnv();
    const taskId = randomUUID();
    const oldOrphan = await env.facade.prepareBlob(taskId, 'content_value', contentValue('old'));
    const holder: { current: BlobRefV2 | null } = { current: null };
    // A concurrent commit advances the generation counter beyond mark-start and a
    // concurrent publication stores a brand-new object (> mark-start gen).
    env.hooks.beforeDeleteRecheck = async () => {
      const hold = await env.publicationStore.lock().acquire();
      await env.publicationStore.advanceGeneration(hold);
      await hold.release();
      holder.current = await env.facade.prepareBlob(taskId, 'content_value', contentValue('new'));
    };
    const result = await env.gc.run();
    expect(result.markStartGeneration).toBe(0);
    expect(result.protectedNewBlobs).toBeGreaterThanOrEqual(1);
    expect(await exists(blobPath(env.paths, taskId, oldOrphan))).toBe(false);
    expect(await exists(blobPath(env.paths, taskId, holder.current as BlobRefV2))).toBe(true);
  });

  it('quarantines abandoned pins for at least one additional full GC generation before sweeping them and their objects', async () => {
    const env = await makeEnv();
    const taskId = randomUUID();
    const object = await env.facade.prepareBlob(taskId, 'content_value', contentValue('pinned'));
    await env.facade.preparePublication({
      taskId,
      operationId: 'gc-abandon-1',
      payload: {
        family: 'lifecycle',
        operationId: 'gc-abandon-1',
        taskId,
        kind: 'stop',
        suspensionId: 'sus-1',
        workItemId: null,
        reason: null,
        leaseEpoch: null,
        expectedLastSequence: null,
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
        authorityBaseRef: null,
      },
      intent: intent('lifecycle/stop'),
      preparedRefs: [object],
      expectedTailSequence: 0,
      expectedTailCommitId: null,
    });
    // Owner dies and the frozen TTL/lease lapse -> abandonment at generation 0.
    env.alive.value = false;
    env.now.value = '2026-08-16T10:00:00.000Z';
    await env.publicationStore.tryAbandonExpiredPins();
    const pin = (await env.publicationStore.snapshotPins())[0] as { pinId: string };
    const pinId = pin.pinId;
    const abandoned = await env.publicationStore.readPin(pinId);
    expect(abandoned?.state).toBe('abandoned');
    expect(abandoned?.abandonedGeneration).toBe(0);

    // First GC after abandonment: everything stays (quarantine).
    await env.gc.run();
    expect(await exists(env.paths.publicationPinFile(pinId))).toBe(true);
    expect(await exists(blobPath(env.paths, taskId, object))).toBe(true);

    // One full generation passes (a real commit advances the counter)...
    const hold = await env.publicationStore.lock().acquire();
    await env.publicationStore.advanceGeneration(hold);
    await hold.release();
    await env.gc.run();
    expect(await exists(env.paths.publicationPinFile(pinId))).toBe(true);
    expect(await exists(blobPath(env.paths, taskId, object))).toBe(true);

    // A second full generation passes -> the quarantine ends.
    const hold2 = await env.publicationStore.lock().acquire();
    await env.publicationStore.advanceGeneration(hold2);
    await hold2.release();
    const third = await env.gc.run();
    expect(third.deletedPins).toBeGreaterThanOrEqual(1);
    expect(await exists(env.paths.publicationPinFile(pinId))).toBe(false);
    expect(await exists(blobPath(env.paths, taskId, object))).toBe(false);
  });

  it('aborts fail-closed when a formally referenced blob is missing — never skips', async () => {
    const env = await makeEnv();
    const taskId = randomUUID();
    const child = await env.facade.prepareBlob(taskId, 'content_value', contentValue());
    const fact = await env.facade.prepareBlob(taskId, 'review_fact', reviewFact(child));
    await publishChunk(env, taskId, 'gc-op-3', fact);
    // Corrupt the store: the child of the event-referenced fact disappears.
    await rm(blobPath(env.paths, taskId, child));
    await expect(env.gc.run()).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
    // Nothing was deleted before the abort.
    expect(await exists(blobPath(env.paths, taskId, fact))).toBe(true);
  });

  it('keeps installation roots supplied by the injected roots provider', async () => {
    const taskId = randomUUID();
    const holder: { current: BlobRefV2 | null } = { current: null };
    const env = await makeEnv({
      gcOptions: { rootsProvider: async () => ({ [taskId]: [holder.current as BlobRefV2] }) },
    });
    holder.current = await env.facade.prepareBlob(taskId, 'content_value', contentValue('installed'));
    const orphan = await env.facade.prepareBlob(taskId, 'content_value', contentValue('orphan'));
    const result = await env.gc.run();
    expect(result.deletedBlobs).toBeGreaterThanOrEqual(1);
    expect(await exists(blobPath(env.paths, taskId, orphan))).toBe(false);
    expect(await exists(blobPath(env.paths, taskId, holder.current as BlobRefV2))).toBe(true);
  });

  it('never treats checkpoints as roots (their baseRefs do not keep objects alive)', async () => {
    const env = await makeEnv();
    const taskId = randomUUID();
    const base = await env.facade.prepareBlob(taskId, 'content_value', contentValue('checkpoint-base'));
    const checkpoint = await putCheckpoint(env, taskId, [base]);
    expect(await exists(blobPath(env.paths, taskId, checkpoint))).toBe(true);
    const result = await env.gc.run();
    expect(result.deletedBlobs).toBeGreaterThanOrEqual(2);
    expect(await exists(blobPath(env.paths, taskId, checkpoint))).toBe(false);
    expect(await exists(blobPath(env.paths, taskId, base))).toBe(false);
  });

  it('saves a blob when a pin lands MID-DELETE-LOOP (per-file pin re-snapshot, Finding 7)', async () => {
    const env = await makeEnv();
    const taskId = randomUUID();
    const victim = await env.facade.prepareBlob(taskId, 'content_value', contentValue('victim'));
    const survivor = await env.facade.prepareBlob(taskId, 'content_value', contentValue('survivor'));
    let landed = false;
    env.hooks.beforeEachDelete = async (hookTaskId) => {
      if (landed || hookTaskId !== taskId) return;
      landed = true;
      // A concurrent publisher's pin lands mid-loop: it protects `survivor`
      // from this very sweep even though no commit happened yet.
      await env.facade.preparePublication({
        taskId,
        operationId: 'gc-mid-loop-pin',
        payload: {
          family: 'lifecycle',
          operationId: 'gc-mid-loop-pin',
          taskId,
          kind: 'stop',
          suspensionId: 'sus-m',
          workItemId: null,
          reason: null,
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
        },
        intent: intent('lifecycle/stop'),
        preparedRefs: [survivor],
        expectedTailSequence: 0,
        expectedTailCommitId: null,
      });
    };
    const result = await env.gc.run();
    // The victim was deleted before the pin landed; the pin-protected blob
    // survived the per-file re-check (and its payload blob too).
    expect(await exists(blobPath(env.paths, taskId, victim))).toBe(false);
    expect(await exists(blobPath(env.paths, taskId, survivor))).toBe(true);
    expect(result.deletedBlobs).toBeGreaterThanOrEqual(1);
  });

  it('keeps concurrently committed roots (interleaved publication between mark and delete)', async () => {
    const env = await makeEnv();
    const taskId = randomUUID();
    const first = await env.facade.prepareBlob(taskId, 'content_value', contentValue('first'));
    const holder: { current: BlobRefV2 | null } = { current: null };
    env.hooks.beforeDeleteRecheck = async () => {
      const preparedRef = await env.facade.prepareBlob(taskId, 'review_fact', reviewFact(first));
      holder.current = preparedRef;
      await publishChunk(env, taskId, 'gc-op-4', preparedRef);
    };
    await env.gc.run();
    // The concurrently committed chain and its child survive the final recheck.
    expect(await exists(blobPath(env.paths, taskId, first))).toBe(true);
    expect(await exists(blobPath(env.paths, taskId, holder.current as BlobRefV2))).toBe(true);
  });
});

/** Builds a schema-valid projection_checkpoint blob whose checkpointDigest self-checks. */
async function putCheckpoint(env: Env, taskId: string, baseRefs: BlobRefV2[]): Promise<BlobRefV2> {
  const withoutDigest = {
    checkpointId: 'cp-1',
    taskId,
    throughSequence: 1,
    priorCheckpointDigest: H2,
    projectionSchemaVersion: 'v2-test',
    baseRefs,
  };
  const digest = canonicalJsonSha256(withoutDigest);
  const value = { ...withoutDigest, checkpointDigest: digest };
  return env.facade.prepareBlob(taskId, 'projection_checkpoint', value);
}