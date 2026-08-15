// @vitest-environment node
/**
 * Task 15 property test (spec §13.1/§16.2, design §12.3): the 10,000-node
 * interrupted-build property. Builds a 10,000-node Map across ≥40 chunks,
 * crashes/restarts at seeded chunk boundaries, resumes from the FIRST
 * INCOMPLETE ordinal, finalizes, and compares the candidate digest with an
 * UNINTERRUPTED construction. Candidate construction is deterministic: the
 * chunk blobs are content-addressed and the finalizer derives the candidate
 * ONLY from the event-bound chunks, so crash/resume never changes the digest.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import { PublicationIntentRegistry } from '../../storage/authoritative-publication-intent-registry';
import { fullProfileForTests } from '../../authoritative-review/object-registry';
import { buildAuthoritativeReviewTestProfileBody } from '../../structured-slots/test-support/authoritative-review-test-registry';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { buildAuthorityBaseSet } from './authority-base';
import { GrantService } from './grant-service';
import { ValidatorEngine } from './validator-engine';
import { ValidatorRegistry } from './validator-registry';
import { AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES } from './builtin-validators';
import type { ValidatorRegistrationV2 } from '../../template/structured-slot-contract-v2';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { V2AttemptContext } from './attempt-coordinator';
import type { WriteGrantSpecV2 } from '../../authoritative-review/authority-types';
import {
  createWorkItemCoordinatorEnvironment,
  disposeRuntimeTestRoots,
  type WorkItemCoordinatorEnvironment,
} from '../test-support';
import {
  EMPTY_BUILD_FRONTIER_DIGEST,
  MapBuildService,
  registerMapBuildPublicationHandlers,
  resolveBuildFrontierDigest,
} from './map-build-service';

const PROFILE = fullProfileForTests();
const PROFILE_BODY = buildAuthoritativeReviewTestProfileBody();
const REGISTRY = new ValidatorRegistry(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES);

const MAP_BUILD_ID = 'mb-prop';
const SNAPSHOT_HASH = 'b'.repeat(64);
const CHUNK_SIZE = 250; // 10,000 nodes / 40 chunks — the §16.2 10k floor
const NODE_COUNT = 10_000;

let seq = 0;

/** Deterministic operation id (label-only; the same label yields the same id
 * across the uninterrupted and interrupted constructions — this is what makes
 * the attempt identities, and therefore the contribution manifest, identical). */
function opId(label: string): string {
  seq += 1;
  void seq;
  return `op-${createHash('sha256').update(`prop:${label}`).digest('hex').slice(0, 32)}`;
}

function entryOf(handlerKey: string) {
  const entry = AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES.find((e) => e.handlerKey === handlerKey);
  if (!entry) throw new Error(`no builtin entry ${handlerKey}`);
  return entry;
}

function registrationFor(handlerKey: string): ValidatorRegistrationV2 {
  const entry = entryOf(handlerKey);
  return {
    validatorId: `v-${handlerKey.split('.').pop()}`,
    handlerKey: entry.handlerKey,
    implementationDigest: entry.implementationDigest,
    implementationRef: { kind: 'builtin', moduleId: entry.moduleId, exportName: entry.exportName },
    trigger: entry.trigger,
    executionPhase: entry.executionPhase,
    selector: { kind: 'all' },
    enforcement: 'blocking',
    deterministic: true,
    inputContractVersion: entry.inputContractVersion,
    outputContractVersion: entry.outputContractVersion,
    budgetProfileId: entry.budgetProfileId,
  };
}

/**
 * The deterministic 10,000-node tree: root + 99 middle nodes + 9,900 leaves
 * (99 middle × 100 leaves). Depth 3 (≤ 128), ≤ 100 children per parent
 * (≤ 4096). documentOrder is globally unique (the completeness builtin checks
 * global uniqueness); siblingOrder is per-parent. Node keys are stable
 * (`node-<index>`), so the same tree is rebuilt on every run.
 */
function buildNodes(): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = [];
  let docOrder = 1;
  // root
  nodes.push({ buildNodeKey: 'node-0', slotType: 'doc', parentBuildNodeKey: null, documentOrder: docOrder++, siblingOrder: 0, contentBearing: false });
  // 99 middle nodes under the root
  for (let m = 1; m <= 99; m += 1) {
    nodes.push({ buildNodeKey: `node-${m}`, slotType: 'doc', parentBuildNodeKey: 'node-0', documentOrder: docOrder++, siblingOrder: m, contentBearing: false });
  }
  // 9,900 leaves, 100 per middle node
  let leaf = 100;
  for (let m = 1; m <= 99; m += 1) {
    for (let c = 1; c <= 100; c += 1) {
      nodes.push({ buildNodeKey: `node-${leaf}`, slotType: 'body', parentBuildNodeKey: `node-${m}`, documentOrder: docOrder++, siblingOrder: c, contentBearing: true });
      leaf += 1;
    }
  }
  if (nodes.length !== NODE_COUNT) throw new Error(`expected ${NODE_COUNT} nodes, built ${nodes.length}`);
  return nodes;
}

/** Slices the ordered nodes into contiguous chunks (chunk 1 has the root + middles). */
function chunkSlices(): Array<Array<Record<string, unknown>>> {
  const nodes = buildNodes();
  const first = nodes.slice(0, 100); // root + 99 middles
  const rest = nodes.slice(100);
  const out: Array<Array<Record<string, unknown>>> = [first];
  for (let offset = 0; offset < rest.length; offset += CHUNK_SIZE) {
    out.push(rest.slice(offset, offset + CHUNK_SIZE));
  }
  return out;
}

interface PropEnv {
  env: WorkItemCoordinatorEnvironment;
  service: MapBuildService;
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown>;
  taskId: string;
  specRef: BlobRefV2;
  spec: Record<string, unknown>;
  readEvents(taskId: string): Promise<readonly AuthoritativeReviewEventV2[]>;
  now: { value: string };
}

async function makePropEnv(): Promise<PropEnv> {
  const registry = new PublicationIntentRegistry();
  registerMapBuildPublicationHandlers(registry);
  const env = await createWorkItemCoordinatorEnvironment({ registry });
  const taskId = 'task-map-build-prop';
  const spec = {
    mapBuildId: MAP_BUILD_ID,
    revision: 1,
    supersedesMapBuildId: null,
    sourceValidationReceiptRef: null,
    snapshotHash: SNAPSHOT_HASH,
    plannedChunkPolicy: { maxChunks: 64, maxNodesPerChunk: CHUNK_SIZE + 100, maxRelationsPerChunk: 64 },
  };
  const specValue = { ...spec, specDigest: canonicalJsonSha256(spec) };
  const specRef = await env.facade.prepareBlob(taskId, 'map_build_spec', specValue);
  const base = buildAuthorityBaseSet({
    taskId,
    templateSnapshotRef: env.templateSnapshotRef,
    profileSnapshotRef: env.profileSnapshotRef,
    refs: { planSpecRef: specRef },
    kind: 'agent_assignment',
    agentExecutionKind: 'structured_session',
    sessionKind: 'structure_chunk',
  });
  const baseRef = await env.facade.prepareBlob(taskId, 'authority_base_set', base);
  const workItemId = 'wi-prop-1';
  const grantBody = {
    grantSpecId: 'gs-prop-1',
    workItemId,
    kind: 'initial_structure_chunk' as const,
    snapshotHash: SNAPSHOT_HASH,
    authorityBaseRef: baseRef,
    mapBuildSpecRef: specRef,
    expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST,
    structureChunkScope: { chunkOrdinal: 1, parentFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, maxNodes: CHUNK_SIZE + 100, maxRelations: 64 },
  };
  const grantSpecRef = await env.facade.prepareBlob(taskId, 'write_grant_spec', { ...grantBody, specDigest: canonicalJsonSha256(grantBody) } as WriteGrantSpecV2);
  const startOp = opId('start');
  const tail0 = await env.eventStore.tail(taskId);
  await env.facade.publishWithPin({
    taskId,
    operationId: startOp,
    payload: {
      family: 'lifecycle',
      operationId: startOp,
      taskId,
      kind: 'start',
      suspensionId: null,
      workItemId,
      reason: null,
      leaseEpoch: null,
      expectedLastSequence: null,
      authorityBaseRef: baseRef,
      attemptFamily: null,
      attemptId: null,
      commandId: null,
      agentId: null,
      commandKind: null,
      logicalAssignmentId: 'la-prop-1',
      reviewAssignmentId: null,
      sessionKind: 'structure_chunk',
      inputArtifactDeliveryId: null,
      workItemKind: 'agent_assignment',
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session',
      roundId: null,
      grantSpecRef,
      payloadRef: specRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries: 2,
      mapBuildId: MAP_BUILD_ID,
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
    },
    intent: { handlerKind: 'lifecycle/start_task', handlerVersion: 1 },
    preparedRefs: [baseRef, specRef, grantSpecRef],
    expectedTailSequence: tail0.lastSequence,
    expectedTailCommitId: tail0.lastCommitId,
  });
  const resolver = (id: string, ref: BlobRefV2) => env.resolverFor(id)(ref);
  const grants = new GrantService({ resolver, readProjection: env.readProjection, profile: PROFILE });
  const service = new MapBuildService({
    facade: env.facade,
    grants,
    readProjection: env.readProjection,
    resolver,
    tail: (id) => env.eventStore.tail(id),
    readEvents: async (id) => (await env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
    committedOperation: async (id, operationId) =>
      (await env.eventStore.readBatchByCommitId(id, operationId))?.map((e) => e.event as AuthoritativeReviewEventV2) ?? null,
    clock: () => env.now.value,
    profile: PROFILE,
    profileBody: PROFILE_BODY,
    validatorRegistry: REGISTRY,
    registrationsFor: () => [registrationFor('authoritative.review.completeness')],
    relationPolicy: 'optional',
    reviewPolicyDigest: 'd'.repeat(64),
    templateSnapshotRef: env.templateSnapshotRef,
    profileSnapshotRef: env.profileSnapshotRef,
    orchestratorRoleBinding: 'orchestrator',
    defaultAutomaticRetries: async () => 2,
  });
  return { env, service, resolver, taskId, specRef, spec: specValue, readEvents: async (id) => (await env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2), now: env.now };
}

let envs: PropEnv[] = [];

afterEach(() => {
  disposeRuntimeTestRoots();
  envs = [];
});

async function committedChunkRefs(taskId: string): Promise<BlobRefV2[]> {
  const env = envs[envs.length - 1];
  const read = await env.env.eventStore.read(taskId);
  return read
    .map((e) => e.event as AuthoritativeReviewEventV2)
    .filter((e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_chunk_committed' }> => e.type === 'structured_map_chunk_committed')
    .sort((a, b) => a.chunkOrdinal - b.chunkOrdinal)
    .map((e) => e.chunkRef);
}

/** Creates + leases a structure_chunk workitem for the given ordinal + parent frontier. */
async function leaseChunkCtx(prop: PropEnv, ordinal: number, parentFrontier: string): Promise<V2AttemptContext> {
  const workItemId = `wi-prop-${ordinal}`;
  const base = buildAuthorityBaseSet({
    taskId: prop.taskId,
    templateSnapshotRef: prop.env.templateSnapshotRef,
    profileSnapshotRef: prop.env.profileSnapshotRef,
    refs: { planSpecRef: prop.specRef },
    kind: 'agent_assignment',
    agentExecutionKind: 'structured_session',
    sessionKind: 'structure_chunk',
  });
  const baseRef = await prop.env.facade.prepareBlob(prop.taskId, 'authority_base_set', base);
  const grantBody = {
    grantSpecId: `gs-prop-${ordinal}`,
    workItemId,
    kind: 'initial_structure_chunk' as const,
    snapshotHash: SNAPSHOT_HASH,
    authorityBaseRef: baseRef,
    mapBuildSpecRef: prop.specRef,
    expectedFrontierDigest: parentFrontier,
    structureChunkScope: { chunkOrdinal: ordinal, parentFrontierDigest: parentFrontier, maxNodes: CHUNK_SIZE + 100, maxRelations: 64 },
  };
  const grantSpecRef = await prop.env.facade.prepareBlob(prop.taskId, 'write_grant_spec', { ...grantBody, specDigest: canonicalJsonSha256(grantBody) });
  await prop.env.coordinator.createWorkItem({
    taskId: prop.taskId,
    operationId: opId(`create-${workItemId}`),
    workItemId,
    kind: 'agent_assignment',
    roleBinding: 'orchestrator',
    agentExecutionKind: 'structured_session',
    sessionKind: 'structure_chunk',
    roundId: null,
    logicalAssignmentId: `la-${workItemId}`,
    reviewAssignmentId: null,
    inputArtifactDeliveryId: null,
    payload: { kind: 'map_build_spec', value: prop.spec },
    authorityBase: base,
    grantSpecRef,
    maxAutomaticRetries: 2,
  });
  const leased = await prop.env.coordinator.leaseNext(prop.taskId, 'worker-a', opId(`lease-${workItemId}`));
  if (leased === null) throw new Error(`no lease for ${workItemId}`);
  const attemptId = leased.attemptId ?? '';
  return {
    taskId: prop.taskId,
    workItemId,
    attemptId,
    leaseEpoch: leased.leaseEpoch,
    namespace: `structured/structure_chunk/${workItemId}/${attemptId}`,
    agentId: leased.leaseOwner ?? 'worker-a',
    roleBinding: 'orchestrator',
    executionKind: 'structured',
    sessionKind: 'structure_chunk',
    dispatchRef: leased.dispatchRef,
    authorityBaseRef: leased.authorityBaseRef,
    grantInstanceRef: leased.grantInstanceRef,
    inputArtifactDeliveryId: null,
    agent: null,
    currentAssignmentText: '',
    committedCheckpointText: '',
  };
}

/** Leases the FIRST workitem (created by the start envelope) and returns its ctx. */
async function leaseFirstCtx(prop: PropEnv): Promise<V2AttemptContext> {
  const leased = await prop.env.coordinator.leaseNext(prop.taskId, 'worker-a', opId('lease-first'));
  if (leased === null) throw new Error('no lease for the first chunk workitem');
  const attemptId = leased.attemptId ?? '';
  return {
    taskId: prop.taskId,
    workItemId: leased.workItemId,
    attemptId,
    leaseEpoch: leased.leaseEpoch,
    namespace: `structured/structure_chunk/${leased.workItemId}/${attemptId}`,
    agentId: leased.leaseOwner ?? 'worker-a',
    roleBinding: 'orchestrator',
    executionKind: 'structured',
    sessionKind: 'structure_chunk',
    dispatchRef: leased.dispatchRef,
    authorityBaseRef: leased.authorityBaseRef,
    grantInstanceRef: leased.grantInstanceRef,
    inputArtifactDeliveryId: null,
    agent: null,
    currentAssignmentText: '',
    committedCheckpointText: '',
  };
}

/** Builds all chunks; on a fresh env, returns the last chunk workitem ctx. */
async function buildAllChunks(prop: PropEnv, firstCtx: V2AttemptContext, crashBoundaries?: ReadonlySet<number>): Promise<V2AttemptContext> {
  const slices = chunkSlices();
  let ctx = firstCtx;
  let current = prop;
  for (let i = 1; i <= slices.length; i += 1) {
    const nodes = slices[i - 1];
    const frontier = i === 1 ? EMPTY_BUILD_FRONTIER_DIGEST : resolveBuildFrontierDigest(MAP_BUILD_ID, await committedChunkRefs(current.taskId));
    ctx = i === 1 ? firstCtx : await leaseChunkCtx(current, i, frontier);
    const result = await current.service.appendChunk(ctx, { ordinal: i, expectedFrontierDigest: frontier, nodes, relations: [], clientOperationId: `op-c${i}` });
    // Complete the workitem so the next chunk can be leased — EXCEPT the last,
    // which stays leased for the finish proposal.
    if (i < slices.length) {
      await current.env.coordinator.completeWorkItem({ taskId: current.taskId, operationId: opId(`complete-${i}`), workItemId: ctx.workItemId, attemptId: ctx.attemptId, resultRefs: [result.chunkRef] });
    }
    // "Crash": after a seeded boundary, the process dies — a FRESH service
    // resumes from the first incomplete ordinal (the committed events are the
    // only state).
    if (crashBoundaries?.has(i) && i < slices.length) {
      current = await freshService(current);
    }
  }
  return ctx;
}

/** A fresh MapBuildService over the same storage (simulates a process restart). */
async function freshService(prop: PropEnv): Promise<PropEnv> {
  const resolver = (id: string, ref: BlobRefV2) => prop.env.resolverFor(id)(ref);
  const grants = new GrantService({ resolver, readProjection: prop.env.readProjection, profile: PROFILE });
  const service = new MapBuildService({
    facade: prop.env.facade,
    grants,
    readProjection: prop.env.readProjection,
    resolver,
    tail: (id) => prop.env.eventStore.tail(id),
    readEvents: async (id) => (await prop.env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
    committedOperation: async (id, operationId) =>
      (await prop.env.eventStore.readBatchByCommitId(id, operationId))?.map((e) => e.event as AuthoritativeReviewEventV2) ?? null,
    clock: () => prop.env.now.value,
    profile: PROFILE,
    profileBody: PROFILE_BODY,
    validatorRegistry: REGISTRY,
    registrationsFor: () => [registrationFor('authoritative.review.completeness')],
    relationPolicy: 'optional',
    reviewPolicyDigest: 'd'.repeat(64),
    templateSnapshotRef: prop.env.templateSnapshotRef,
    profileSnapshotRef: prop.env.profileSnapshotRef,
    orchestratorRoleBinding: 'orchestrator',
    defaultAutomaticRetries: async () => 2,
  });
  const next: PropEnv = { ...prop, service, resolver };
  envs[envs.length - 1] = next;
  return next;
}

async function finalizeCandidate(prop: PropEnv, lastCtx: V2AttemptContext): Promise<BlobRefV2> {
  const chunkCount = (await committedChunkRefs(prop.taskId)).length;
  const frontier = resolveBuildFrontierDigest(MAP_BUILD_ID, await committedChunkRefs(prop.taskId));
  await prop.service.finishMapBuild(lastCtx, { expectedChunkCount: chunkCount, expectedFrontierDigest: frontier, expectedRootCount: 1, clientOperationId: 'op-finish' });
  await prop.env.coordinator.completeWorkItem({ taskId: prop.taskId, operationId: opId('complete-last'), workItemId: lastCtx.workItemId, attemptId: lastCtx.attemptId, resultRefs: await committedChunkRefs(prop.taskId) });
  const leased = await prop.env.coordinator.leaseNext(prop.taskId, 'worker-a', opId('lease-finalize'));
  if (leased === null || leased.commandId === null) throw new Error('expected a leased system_map_finalize command');
  const outcome = await prop.service.executeMapFinalize({ taskId: prop.taskId, commandId: leased.commandId, workItemId: leased.workItemId, commandKind: 'map_finalize', leaseEpoch: leased.leaseEpoch, authorityBaseRef: leased.authorityBaseRef, payloadRef: prop.specRef });
  if (outcome.kind !== 'completed') throw new Error(`finalize failed: ${outcome.failureCode}`);
  const events = await prop.readEvents(prop.taskId);
  const candidateEvent = events.find((e) => e.type === 'structured_map_candidate_committed');
  if (candidateEvent === undefined || candidateEvent.type !== 'structured_map_candidate_committed') throw new Error('no candidate committed');
  return candidateEvent.candidateRef;
}

describe('map-build property: 10,000-node interrupted build (spec §16.2)', () => {
  it('produces the SAME candidate digest after seeded crash/restart as an uninterrupted build', async () => {
    const slices = chunkSlices();
    expect(slices.length).toBeGreaterThanOrEqual(40); // ≥40 chunks
    expect(slices.reduce((n, s) => n + s.length, 0)).toBe(NODE_COUNT);
    // --- uninterrupted construction ---
    const uninterrupted = await makePropEnv();
    envs.push(uninterrupted);
    const firstCtx1 = await leaseFirstCtx(uninterrupted);
    const lastCtx1 = await buildAllChunks(uninterrupted, firstCtx1);
    const uninterruptedRef = await finalizeCandidate(uninterrupted, lastCtx1);

    // --- interrupted construction with seeded crash boundaries ---
    const interrupted = await makePropEnv();
    envs.push(interrupted);
    const firstCtx2 = await leaseFirstCtx(interrupted);
    const boundaries = new Set<number>([1, 5, 12, 23, 34, 40]);
    const lastCtx2 = await buildAllChunks(interrupted, firstCtx2, boundaries);
    const interruptedRef = await finalizeCandidate(interrupted, lastCtx2);

    // Candidate construction is deterministic: the same event-bound chunks
    // produce the same candidate digest regardless of restart boundaries.
    expect(interruptedRef.digest).toBe(uninterruptedRef.digest);
    expect(interruptedRef.kind).toBe('map_candidate');
  }, 180_000);
});
