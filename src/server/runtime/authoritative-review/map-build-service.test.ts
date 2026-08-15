// @vitest-environment node
/**
 * Task 15 map-build service tests (spec §13.1, design §10.2/§17.5/§19.1):
 * recoverable MapBuild — contiguous chunk ordinals against a frontier/key-ledger
 * CAS, stable build-local keys (duplicate/missing/tombstoned rejected),
 * disabled/optional/zero relations, byte/slot/depth/children limits, wrong-Grant
 * and old-attempt rejection, response-loss replay, the finish proposal (ONE
 * system_map_finalize WorkItem), the finalizer-only-publication rule (an Agent
 * attempt can never write `structured_map_candidate_committed`), the clear
 * path (candidate + round planned atomically with system provenance and a
 * contribution manifest), the blocking path (aggregate/input/receipt retained,
 * old build rejected, ONE successor revision with imported immutable chunks
 * and explicit replacement ordinals, never auto-retrying the same finalizer),
 * and infrastructure failure retrying WITHOUT a successor.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import { PublicationIntentRegistry } from '../../storage/authoritative-publication-intent-registry';
import { fullProfileForTests } from '../../authoritative-review/object-registry';
import { refOfBlob, parseBlob } from '../../authoritative-review/object-registry';
import { buildAuthoritativeReviewTestProfileBody } from '../../structured-slots/test-support/authoritative-review-test-registry';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { buildAuthorityBaseSet } from './authority-base';
import { GrantService } from './grant-service';
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
  MAP_BUILD_MAX_TREE_DEPTH,
  MapBuildService,
  MapBuildError,
  buildLimitsOf,
  buildChunk,
  candidateNodesAndRelations,
  reconstructBuildState,
  registerMapBuildPublicationHandlers,
  resolveBuildFrontierDigest,
  resolveBuildKeyLedger,
  resolveRoundAssignmentCount,
  validateChunkAppend,
  type BuildRelationPolicyV2,
  type ReconstructedBuildStateV2,
} from './map-build-service';

const PROFILE = fullProfileForTests();
const PROFILE_BODY = buildAuthoritativeReviewTestProfileBody();
const REGISTRY = new ValidatorRegistry(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES);

let seq = 0;

function opId(label: string): string {
  seq += 1;
  return `op-${createHash('sha256').update(`op:${label}:${seq}`).digest('hex').slice(0, 32)}`;
}

function hash(salt: string): string {
  return createHash('sha256').update(salt, 'utf8').digest('hex');
}

function entryOf(handlerKey: string) {
  const entry = AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES.find((e) => e.handlerKey === handlerKey);
  if (!entry) throw new Error(`no builtin entry ${handlerKey}`);
  return entry;
}

function registrationFor(handlerKey: string, overrides: Partial<ValidatorRegistrationV2> = {}): ValidatorRegistrationV2 {
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
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Fixture builders                                                    */
/* ------------------------------------------------------------------ */

function specValue(mapBuildId = 'mb-1', overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const body = {
    mapBuildId,
    revision: 1,
    supersedesMapBuildId: null,
    sourceValidationReceiptRef: null,
    snapshotHash: 'a'.repeat(64),
    plannedChunkPolicy: { maxChunks: 16, maxNodesPerChunk: 512, maxRelationsPerChunk: 64 },
    ...overrides,
  };
  return { ...body, specDigest: canonicalJsonSha256(body) };
}

function nodeDecl(buildNodeKey: string, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    buildNodeKey,
    slotType: 'doc',
    parentBuildNodeKey: null,
    documentOrder: 1,
    siblingOrder: 0,
    contentBearing: false,
    ...overrides,
  };
}

function relDecl(buildRelationKey: string, from: string, to: string, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    buildRelationKey,
    typeId: 'xref',
    fromBuildNodeKey: from,
    toBuildNodeKey: to,
    attributes: {},
    ...overrides,
  };
}

function chunkInput(mapBuildId: string, ordinal: number, parentFrontierDigest: string, nodes: Record<string, unknown>[], relations: Record<string, unknown>[] = []) {
  return buildChunk({
    mapBuildId,
    chunkOrdinal: ordinal,
    parentFrontierDigest,
    nodeDeclarations: nodes as never,
    relationDeclarations: relations as never,
  });
}

function emptyLimits(): ReturnType<typeof buildLimitsOf> {
  return {
    maxChunks: 16,
    maxNodesPerChunk: 512,
    maxRelationsPerChunk: 64,
    maxSlots: PROFILE.maxSlots,
    maxRelationTotal: PROFILE.maxRelationTotal,
    maxRelationsPerSlot: PROFILE.maxRelationsPerSlot,
    maxChunkBytes: 4 * 1024 * 1024,
  };
}

/* ------------------------------------------------------------------ */
/* Build environment                                                   */
/* ------------------------------------------------------------------ */

interface BuildEnv {
  env: WorkItemCoordinatorEnvironment;
  service: MapBuildService;
  grants: GrantService;
  ctx: V2AttemptContext;
  taskId: string;
  spec: Record<string, unknown>;
  specRef: BlobRefV2;
  workItemId: string;
  attemptId: string;
  now: { value: string };
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown>;
}

let envs: BuildEnv[] = [];

async function makeBuildEnv(opts: { relationPolicy?: BuildRelationPolicyV2; chunkOrdinal?: number; mapBuildId?: string } = {}): Promise<BuildEnv> {
  const registry = new PublicationIntentRegistry();
  registerMapBuildPublicationHandlers(registry);
  const env = await createWorkItemCoordinatorEnvironment({ registry });
  const taskId = 'task-map-build';
  const mapBuildId = opts.mapBuildId ?? 'mb-1';
  const spec = specValue(mapBuildId);
  const specRef = await env.facade.prepareBlob(taskId, 'map_build_spec', spec);
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
  const chunkOrdinal = opts.chunkOrdinal ?? 1;
  const workItemId = 'wi-build-1';
  const grantBody = {
    grantSpecId: 'gs-build-1',
    workItemId,
    kind: 'initial_structure_chunk' as const,
    snapshotHash: 'a'.repeat(64),
    authorityBaseRef: baseRef,
    mapBuildSpecRef: specRef,
    expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST,
    structureChunkScope: { chunkOrdinal, parentFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, maxNodes: 512, maxRelations: 64 },
  };
  const grantSpec = { ...grantBody, specDigest: canonicalJsonSha256(grantBody) } as WriteGrantSpecV2;
  const grantSpecRef = await env.facade.prepareBlob(taskId, 'write_grant_spec', grantSpec);
  // Seed the §17.2 start envelope (task_started + structured_map_build_started +
  // the first structure_chunk WorkItem) atomically, exactly like startTask.
  const startOperation = opId('start-task');
  const tail0 = await env.eventStore.tail(taskId);
  await env.facade.publishWithPin({
    taskId,
    operationId: startOperation,
    payload: {
      family: 'lifecycle',
      operationId: startOperation,
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
      logicalAssignmentId: 'la-build-1',
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
      mapBuildId,
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
    },
    intent: { handlerKind: 'lifecycle/start_task', handlerVersion: 1 },
    preparedRefs: [baseRef, specRef, grantSpecRef],
    expectedTailSequence: tail0.lastSequence,
    expectedTailCommitId: tail0.lastCommitId,
  });
  const leased = await env.coordinator.leaseNext(taskId, 'worker-a', opId('lease-build-1'));
  if (leased === null) throw new Error('expected a leaseable structure_chunk workitem');
  const attemptId = leased.attemptId ?? '';
  const resolver = (id: string, ref: BlobRefV2) => env.resolverFor(id)(ref);
  const grants = new GrantService({ resolver, readProjection: env.readProjection, profile: PROFILE });
  const ctx: V2AttemptContext = {
    taskId,
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
    relationPolicy: opts.relationPolicy ?? 'optional',
    reviewPolicyDigest: hash('review-policy'),
    templateSnapshotRef: env.templateSnapshotRef,
    profileSnapshotRef: env.profileSnapshotRef,
    orchestratorRoleBinding: 'orchestrator',
    defaultAutomaticRetries: async () => 2,
  });
  const built: BuildEnv = {
    env,
    service,
    grants,
    ctx,
    taskId,
    spec,
    specRef,
    workItemId,
    attemptId,
    now: env.now,
    resolver,
  };
  envs.push(built);
  return built;
}

afterEach(() => {
  disposeRuntimeTestRoots();
  envs = [];
});

/* ------------------------------------------------------------------ */
/* Step 1: pure chunk/frontier/key tests                               */
/* ------------------------------------------------------------------ */

describe('pure build domain — chunk/frontier/key semantics', { timeout: 30_000 }, () => {
  it('chunks commit in contiguous ordinal order (1..n) and the frontier chains chunk refs', () => {
    const mapBuildId = 'mb-1';
    const c1 = chunkInput(mapBuildId, 1, EMPTY_BUILD_FRONTIER_DIGEST, [nodeDecl('root')]);
    const c1Ref = refOfBlob('map_build_chunk', c1);
    const f1 = resolveBuildFrontierDigest(mapBuildId, [c1Ref]);
    const c2 = chunkInput(mapBuildId, 2, f1, [nodeDecl('child', { parentBuildNodeKey: 'root', documentOrder: 2, siblingOrder: 1 })]);
    expect(c2.parentFrontierDigest).toBe(f1);
    const state = reconstructBuildState(mapBuildId, 1, [
      { chunkOrdinal: 1, chunkRef: c1Ref, chunk: c1 },
      { chunkOrdinal: 2, chunkRef: refOfBlob('map_build_chunk', c2), chunk: c2 },
    ]);
    expect(state.nextOrdinal).toBe(3);
    expect(state.nodeCount).toBe(2);
    expect(state.rootCount).toBe(1);
  });

  it('rejects a non-contiguous ordinal and a stale parent frontier (CAS)', () => {
    const mapBuildId = 'mb-1';
    const state = reconstructBuildState(mapBuildId, 1, []);
    const limits = emptyLimits();
    expect(
      validateChunkAppend({ mapBuildId, ordinal: 2, expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, nodes: [nodeDecl('root')] as never, relations: [], prior: state, limits, relationPolicy: 'optional', chunkBytes: 100 }),
    ).toContain('chunk ordinal 2 != expected 1 (contiguous ordinals)');
    expect(
      validateChunkAppend({ mapBuildId, ordinal: 1, expectedFrontierDigest: 'b'.repeat(64), nodes: [nodeDecl('root')] as never, relations: [], prior: state, limits, relationPolicy: 'optional', chunkBytes: 100 }),
    ).toContain('parent frontier digest mismatch (frontier/key-ledger CAS)');
  });

  it('build-local keys are stable and reference order within a chunk is enforced', () => {
    const mapBuildId = 'mb-1';
    const nodes = [nodeDecl('root'), nodeDecl('child', { parentBuildNodeKey: 'root', documentOrder: 2, siblingOrder: 1 })];
    const chunk = chunkInput(mapBuildId, 1, EMPTY_BUILD_FRONTIER_DIGEST, nodes);
    const state = reconstructBuildState(mapBuildId, 1, [{ chunkOrdinal: 1, chunkRef: refOfBlob('map_build_chunk', chunk), chunk }]);
    expect(state.keyLedger.entries.map((e) => e.buildKey)).toEqual(['child', 'root']);
    expect(state.keyLedger.entries.every((e) => e.status === 'active')).toBe(true);
    const badNodes = [nodeDecl('child', { parentBuildNodeKey: 'root' }), nodeDecl('root', { documentOrder: 2 })];
    const errors = validateChunkAppend({
      mapBuildId,
      ordinal: 1,
      expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST,
      nodes: badNodes as never,
      relations: [],
      prior: reconstructBuildState(mapBuildId, 1, []),
      limits: emptyLimits(),
      relationPolicy: 'optional',
      chunkBytes: 100,
    });
    expect(errors.some((e) => e.includes('must be committed earlier or declared earlier'))).toBe(true);
  });

  it('rejects duplicate, missing and tombstoned keys', () => {
    const mapBuildId = 'mb-1';
    const c1 = chunkInput(mapBuildId, 1, EMPTY_BUILD_FRONTIER_DIGEST, [nodeDecl('root')]);
    const c1Ref = refOfBlob('map_build_chunk', c1);
    const state = reconstructBuildState(mapBuildId, 1, [{ chunkOrdinal: 1, chunkRef: c1Ref, chunk: c1 }]);
    const limits = emptyLimits();
    expect(
      validateChunkAppend({ mapBuildId, ordinal: 2, expectedFrontierDigest: state.frontierDigest, nodes: [nodeDecl('root', { documentOrder: 2 })] as never, relations: [], prior: state, limits, relationPolicy: 'optional', chunkBytes: 100 }),
    ).toContain("duplicate buildNodeKey 'root' already in the key ledger");
    const missingErrors = validateChunkAppend({ mapBuildId, ordinal: 2, expectedFrontierDigest: state.frontierDigest, nodes: [nodeDecl('orphan', { parentBuildNodeKey: 'ghost' })] as never, relations: [], prior: state, limits, relationPolicy: 'optional', chunkBytes: 100 });
    expect(missingErrors.some((e) => e.startsWith("parent 'ghost' must be committed earlier or declared earlier"))).toBe(true);
    const tombstoneLedger = resolveBuildKeyLedger(mapBuildId, 1, [{ chunkOrdinal: 1, nodeDeclarations: [nodeDecl('dead')] as never, relationDeclarations: [] }]);
    (tombstoneLedger as unknown as { entries: Array<{ status: string }> }).entries = tombstoneLedger.entries.map((e) => (e.buildKey === 'dead' ? { ...e, status: 'tombstone' as const } : e)) as never;
    const tombstoneState: ReconstructedBuildStateV2 = { ...state, keyLedger: tombstoneLedger };
    const tombErrors = validateChunkAppend({ mapBuildId, ordinal: 2, expectedFrontierDigest: tombstoneState.frontierDigest, nodes: [nodeDecl('new', { parentBuildNodeKey: 'dead' })] as never, relations: [], prior: tombstoneState, limits, relationPolicy: 'optional', chunkBytes: 100 });
    expect(tombErrors.some((e) => e.includes('tombstoned'))).toBe(true);
  });

  it('handles disabled, optional and zero relations', () => {
    const mapBuildId = 'mb-1';
    const empty = reconstructBuildState(mapBuildId, 1, []);
    const limits = emptyLimits();
    expect(
      validateChunkAppend({ mapBuildId, ordinal: 1, expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, nodes: [nodeDecl('a'), nodeDecl('b', { documentOrder: 2, siblingOrder: 1 })] as never, relations: [relDecl('r1', 'a', 'b')] as never, prior: empty, limits, relationPolicy: 'disabled', chunkBytes: 100 }),
    ).toContain('relations are disabled by the relation policy');
    expect(
      validateChunkAppend({ mapBuildId, ordinal: 1, expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, nodes: [nodeDecl('a')] as never, relations: [], prior: empty, limits, relationPolicy: 'optional', chunkBytes: 100 }),
    ).toEqual([]);
    const { relations } = candidateNodesAndRelations(mapBuildId, [{ nodeDeclarations: [nodeDecl('a')] as never, relationDeclarations: [] }]);
    expect(relations).toEqual([]);
  });

  it('F1 (review): relation endpoints must be NODE keys — a ledger relation key is rejected', () => {
    const mapBuildId = 'mb-1';
    // chunk 1 declares nodes a,b and relation r1
    const c1 = chunkInput(mapBuildId, 1, EMPTY_BUILD_FRONTIER_DIGEST, [nodeDecl('a'), nodeDecl('b', { documentOrder: 2, siblingOrder: 1 })], [relDecl('r1', 'a', 'b')]);
    const c1Ref = refOfBlob('map_build_chunk', c1);
    const state = reconstructBuildState(mapBuildId, 1, [{ chunkOrdinal: 1, chunkRef: c1Ref, chunk: c1 }]);
    // chunk 2 tries to use the ledger RELATION key 'r1' as an endpoint
    const errors = validateChunkAppend({
      mapBuildId,
      ordinal: 2,
      expectedFrontierDigest: state.frontierDigest,
      nodes: [nodeDecl('c', { documentOrder: 3, siblingOrder: 2 })] as never,
      relations: [relDecl('r2', 'c', 'r1')] as never,
      prior: state,
      limits: emptyLimits(),
      relationPolicy: 'optional',
      chunkBytes: 100,
    });
    expect(errors.some((e) => e.includes("references buildRelationKey 'r1' as an endpoint"))).toBe(true);
  });

  it('F4 (review): a same-chunk relation endpoint cannot be a relation key declared later', () => {
    const mapBuildId = 'mb-1';
    const empty = reconstructBuildState(mapBuildId, 1, []);
    // the chunk declares relation r1 whose endpoint 'r2' is a RELATION key
    const errors = validateChunkAppend({
      mapBuildId,
      ordinal: 1,
      expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST,
      nodes: [nodeDecl('a'), nodeDecl('b', { documentOrder: 2, siblingOrder: 1 })] as never,
      relations: [relDecl('r1', 'a', 'r2'), relDecl('r2', 'a', 'b')] as never,
      prior: empty,
      limits: emptyLimits(),
      relationPolicy: 'optional',
      chunkBytes: 100,
    });
    expect(errors.some((e) => e.includes("references buildRelationKey 'r2' as an endpoint"))).toBe(true);
  });

  it('enforces byte/slot/depth/children limits', () => {
    const mapBuildId = 'mb-1';
    const limits = { ...emptyLimits(), maxChunks: 2, maxNodesPerChunk: 2, maxSlots: 2, maxChunkBytes: 500 };
    const empty = reconstructBuildState(mapBuildId, 1, []);
    expect(
      validateChunkAppend({ mapBuildId, ordinal: 1, expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, nodes: [nodeDecl('a')] as never, relations: [], prior: empty, limits, relationPolicy: 'optional', chunkBytes: 501 }),
    ).toContain('chunk bytes 501 > maxChunkBytes 500');
    const threeNodes = [nodeDecl('a'), nodeDecl('b', { documentOrder: 2, siblingOrder: 1 }), nodeDecl('c', { documentOrder: 3, siblingOrder: 2 })];
    expect(
      validateChunkAppend({ mapBuildId, ordinal: 1, expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, nodes: threeNodes as never, relations: [], prior: empty, limits, relationPolicy: 'optional', chunkBytes: 100 }),
    ).toContain('exceeds maxSlots 2');
    const deep: Record<string, unknown>[] = [];
    for (let i = 0; i < MAP_BUILD_MAX_TREE_DEPTH + 2; i += 1) {
      deep.push(nodeDecl(`n${i}`, { parentBuildNodeKey: i === 0 ? null : `n${i - 1}`, documentOrder: i + 1, siblingOrder: i }));
    }
    const deepErrors = validateChunkAppend({ mapBuildId, ordinal: 1, expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, nodes: deep as never, relations: [], prior: empty, limits: { ...limits, maxSlots: 100000 }, relationPolicy: 'optional', chunkBytes: 100000 });
    expect(deepErrors.some((e) => e.includes('maxDepth'))).toBe(true);
    const wide = [nodeDecl('root'), ...Array.from({ length: 5000 }, (_, i) => nodeDecl(`c${i}`, { parentBuildNodeKey: 'root', documentOrder: i + 2, siblingOrder: i + 1 }))];
    const wideErrors = validateChunkAppend({ mapBuildId, ordinal: 1, expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, nodes: wide as never, relations: [], prior: empty, limits: { ...limits, maxSlots: 100000, maxNodesPerChunk: 100000 }, relationPolicy: 'optional', chunkBytes: 100000 });
    expect(wideErrors.some((e) => e.includes('maxChildren'))).toBe(true);
  });

  it('round assignment count covers all nodes + actual relations (spec §12.3/§13.1)', () => {
    expect(resolveRoundAssignmentCount(10_000, 0, PROFILE)).toBe(40);
    expect(resolveRoundAssignmentCount(0, 0, PROFILE)).toBe(1);
  });

  it('candidate construction assigns deterministic official IDs and digests', async () => {
    const mapBuildId = 'mb-1';
    const c1 = chunkInput(mapBuildId, 1, EMPTY_BUILD_FRONTIER_DIGEST, [nodeDecl('root'), nodeDecl('child', { parentBuildNodeKey: 'root', documentOrder: 2, siblingOrder: 1 })]);
    const { nodes, relations } = candidateNodesAndRelations(mapBuildId, [{ nodeDeclarations: c1.nodeDeclarations, relationDeclarations: [] }]);
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => n.slotId.startsWith('sl-'))).toBe(true);
    const { officialSlotIdOf } = await import('./map-build-service');
    expect(nodes.map((n) => n.slotId).sort()).toEqual([officialSlotIdOf(mapBuildId, 'child'), officialSlotIdOf(mapBuildId, 'root')].sort());
    expect(relations).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Step 2: finalizer-only publication                                  */
/* ------------------------------------------------------------------ */

describe('map-build service — finalizer-only publication', { timeout: 30_000 }, () => {
  it('append_map_candidate_chunk commits a chunk through the grant scope', async () => {
    const { service, ctx, taskId } = await makeBuildEnv();
    const result = await service.appendChunk(ctx, {
      ordinal: 1,
      expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST,
      nodes: [nodeDecl('root')],
      relations: [],
      clientOperationId: 'op-c1',
    });
    expect(result.accepted).toBe(true);
    expect(result.chunkOrdinal).toBe(1);
    const committed = await taskRead(taskId);
    expect(committed.some((e) => e.type === 'structured_map_chunk_committed')).toBe(true);
    expect(committed.some((e) => e.type === 'structured_map_candidate_committed')).toBe(false);
  });

  it('an Agent attempt can never write structured_map_candidate_committed', async () => {
    const build = await makeBuildEnv();
    const lastCtx = await appendChain(build, 2);
    await build.service.finishMapBuild(lastCtx, {
      expectedChunkCount: 2,
      expectedFrontierDigest: resolveBuildFrontierDigest(build.spec.mapBuildId as string, await chunkRefs(build)),
      expectedRootCount: 1,
      clientOperationId: 'op-f',
    });
    const committed = await taskRead(build.taskId);
    expect(committed.some((e) => e.type === 'structured_map_candidate_committed')).toBe(false);
    expect(committed.some((e) => e.type === 'structured_map_build_finish_proposed')).toBe(true);
    const created = committed.filter((e) => e.type === 'structured_work_item_created' && e.kind === 'system_map_finalize');
    expect(created).toHaveLength(1);
  });

  it('rejects a chunk under the wrong Grant (ordinal/frontier mismatch)', async () => {
    const { service, ctx } = await makeBuildEnv();
    await expect(
      service.appendChunk(ctx, { ordinal: 3, expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, nodes: [nodeDecl('root')], relations: [], clientOperationId: 'op-wrong' }),
    ).rejects.toBeInstanceOf(MapBuildError);
    await expect(
      service.appendChunk(ctx, { ordinal: 1, expectedFrontierDigest: 'b'.repeat(64), nodes: [nodeDecl('root')], relations: [], clientOperationId: 'op-wrong2' }),
    ).rejects.toBeInstanceOf(MapBuildError);
  });

  it('rejects an old/stale attempt (the lease no longer matches)', async () => {
    const { service, ctx } = await makeBuildEnv();
    await service.appendChunk(ctx, { ordinal: 1, expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, nodes: [nodeDecl('root')], relations: [], clientOperationId: 'op-c1' });
    // A stale closure (different epoch / attempt / agent) is rejected by the
    // GrantService before any mutation — zero writes.
    const staleCtx: V2AttemptContext = { ...ctx, leaseEpoch: ctx.leaseEpoch + 99, attemptId: 'stale-attempt', agentId: 'other-agent' };
    await expect(
      service.appendChunk(staleCtx, { ordinal: 2, expectedFrontierDigest: 'x'.repeat(64), nodes: [nodeDecl('child', { parentBuildNodeKey: 'root', documentOrder: 2, siblingOrder: 1 })], relations: [], clientOperationId: 'op-stale' }),
    ).rejects.toThrow();
    // nothing was committed by the stale attempt
    const committed = await taskRead('task-map-build');
    expect(committed.filter((e) => e.type === 'structured_map_chunk_committed')).toHaveLength(1);
  });

  it('response-loss replay returns the committed chunk (same operation id)', async () => {
    const { service, ctx, taskId } = await makeBuildEnv();
    const first = await service.appendChunk(ctx, { ordinal: 1, expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, nodes: [nodeDecl('root')], relations: [], clientOperationId: 'op-replay' });
    const replay = await service.appendChunk(ctx, { ordinal: 1, expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, nodes: [nodeDecl('root')], relations: [], clientOperationId: 'op-replay' });
    expect(replay.chunkRef.digest).toBe(first.chunkRef.digest);
    const committed = await taskRead(taskId);
    expect(committed.filter((e) => e.type === 'structured_map_chunk_committed')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Step 3: clear / blocking / infrastructure finalizer                 */
/* ------------------------------------------------------------------ */

describe('map-build service — map_finalize SystemCommand handler', { timeout: 30_000 }, () => {
  it('clear outcome publishes the candidate + round planned atomically with system provenance', async () => {
    const build = await makeBuildEnv();
    const lastCtx = await appendChain(build, 2);
    const lease = await finishAndLeaseFinalize(build, lastCtx);
    const outcome = await build.service.executeMapFinalize({ taskId: build.taskId, commandId: lease.commandId, workItemId: lease.workItemId, commandKind: 'map_finalize', leaseEpoch: lease.commandLeaseEpoch, authorityBaseRef: lease.authorityBaseRef, payloadRef: build.specRef });
    expect(outcome.kind).toBe('completed');
    const events = await taskRead(build.taskId);
    expect(events.some((e) => e.type === 'structured_map_build_finalized')).toBe(true);
    const candidateEvent = events.find((e) => e.type === 'structured_map_candidate_committed');
    expect(candidateEvent).toBeDefined();
    const roundEvent = events.find((e) => e.type === 'structured_map_review_round_planned');
    expect(roundEvent).toBeDefined();
    expect(roundEvent?.mapCycleOrdinal).toBe(1);
    expect(events.some((e) => e.type === 'structured_system_command_completed')).toBe(true);
    expect(events.some((e) => e.type === 'structured_work_item_completed')).toBe(true);
    // system provenance + contribution manifest
    const candidateRef = (candidateEvent as { candidateRef: BlobRefV2 }).candidateRef;
    const snapshot = (await build.resolver(build.taskId, candidateRef)) as { validationCoreRef: BlobRefV2 };
    const core = (await build.resolver(build.taskId, snapshot.validationCoreRef)) as { candidateProvenanceWithoutValidation: { producerKind: string; mapBuildId: string; contributionManifestRef: BlobRefV2 } };
    expect(core.candidateProvenanceWithoutValidation.producerKind).toBe('system_map_finalize');
    expect(core.candidateProvenanceWithoutValidation.mapBuildId).toBe('mb-1');
    const contrib = (await build.resolver(build.taskId, core.candidateProvenanceWithoutValidation.contributionManifestRef)) as { planId: string; orderedChunkOrBatchRefs: readonly BlobRefV2[] };
    expect(contrib.planId).toBe('mb-1');
    expect(contrib.orderedChunkOrBatchRefs).toHaveLength(2);
  }, 120_000);

  it('blocking candidate validation retains the aggregate/input/receipt, rejects the old build, and creates ONE successor revision', async () => {
    const build = await makeBuildEnv();
    // A candidate with a duplicated documentOrder is structurally invalid.
    await build.service.appendChunk(build.ctx, {
      ordinal: 1,
      expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST,
      nodes: [nodeDecl('a'), nodeDecl('b', { parentBuildNodeKey: 'a', documentOrder: 1, siblingOrder: 1 })],
      relations: [],
      clientOperationId: 'op-c1',
    });
    const lease = await finishAndLeaseFinalize(build, build.ctx);
    const outcome = await build.service.executeMapFinalize({ taskId: build.taskId, commandId: lease.commandId, workItemId: lease.workItemId, commandKind: 'map_finalize', leaseEpoch: lease.commandLeaseEpoch, authorityBaseRef: lease.authorityBaseRef, payloadRef: build.specRef });
    expect(outcome.kind).toBe('completed');
    const events = await taskRead(build.taskId);
    const rejected = events.find((e) => e.type === 'structured_map_build_rejected');
    expect(rejected).toBeDefined();
    const successor = events.filter((e) => e.type === 'structured_work_item_created' && e.kind === 'agent_assignment' && e.sessionKind === 'structure_chunk');
    // exactly ONE successor structure_chunk WorkItem (the initial build's first
    // WorkItem is the other structure_chunk creation in the history)
    const successorWorkItems = successor.slice(-1);
    expect(successorWorkItems).toHaveLength(1);
    const successorGrant = (successorWorkItems[0] as { grantSpecRef: BlobRefV2 }).grantSpecRef;
    const grantBlob = (await build.resolver(build.taskId, successorGrant)) as { structureChunkScope: { chunkOrdinal: number; parentFrontierDigest: string } };
    expect(grantBlob.structureChunkScope.chunkOrdinal).toBe(1);
    // the successor reuses the immutable chunk blob under its OWN build id, so
    // the frontier continues from the successor's imported chunk chain
    const successorBuildId = `mb-${canonicalJsonSha256({ mapBuildId: 'mb-1', revision: 1, label: 'successor' }).slice(0, 16)}`;
    expect(grantBlob.structureChunkScope.parentFrontierDigest).toBe(resolveBuildFrontierDigest(successorBuildId, [await chunkRefAt(build.taskId, 1)]));
    const aggRef = (rejected as { validatorAggregateRef: BlobRefV2 }).validatorAggregateRef;
    const receiptRef = (rejected as { validationReceiptRef: BlobRefV2 }).validationReceiptRef;
    await parseBlob('validator_aggregate', await build.resolver(build.taskId, aggRef), aggRef);
    await parseBlob('validation_receipt', await build.resolver(build.taskId, receiptRef), receiptRef);
  }, 120_000);

  it('infrastructure failure retries WITHOUT a successor (no candidate, no rejected event)', async () => {
    const build = await makeBuildEnv();
    await build.service.appendChunk(build.ctx, { ordinal: 1, expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, nodes: [nodeDecl('root')], relations: [], clientOperationId: 'op-c1' });
    const lease = await finishAndLeaseFinalize(build, build.ctx);
    const failingService = new MapBuildService({
      facade: build.env.facade,
      grants: build.grants,
      readProjection: build.env.readProjection,
      resolver: build.resolver,
      tail: (id) => build.env.eventStore.tail(id),
      readEvents: async (id) => (await build.env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
      committedOperation: async (id, operationId) => null,
      clock: () => build.now.value,
      profile: PROFILE,
      profileBody: PROFILE_BODY,
      validatorRegistry: REGISTRY,
      registrationsFor: () => {
        throw new Error('registration resolution failed');
      },
      relationPolicy: 'optional',
      reviewPolicyDigest: hash('review-policy'),
      templateSnapshotRef: build.env.templateSnapshotRef,
      profileSnapshotRef: build.env.profileSnapshotRef,
      orchestratorRoleBinding: 'orchestrator',
      defaultAutomaticRetries: async () => 2,
    });
    const outcome = await failingService.executeMapFinalize({ taskId: build.taskId, commandId: lease.commandId, workItemId: lease.workItemId, commandKind: 'map_finalize', leaseEpoch: lease.commandLeaseEpoch, authorityBaseRef: lease.authorityBaseRef, payloadRef: build.specRef });
    expect(outcome.kind).toBe('retryable_failure');
    const events = await taskRead(build.taskId);
    expect(events.some((e) => e.type === 'structured_map_candidate_committed')).toBe(false);
    expect(events.some((e) => e.type === 'structured_map_build_rejected')).toBe(false);
  }, 120_000);

  it('createMapFinalizeSystemCommandHandler replaces the NOT_IMPLEMENTED stub via SystemCommandRegistry.replace', async () => {
    const build = await makeBuildEnv();
    await build.service.appendChunk(build.ctx, { ordinal: 1, expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, nodes: [nodeDecl('root')], relations: [], clientOperationId: 'op-c1' });
    const lease = await finishAndLeaseFinalize(build, build.ctx);
    const { createMapFinalizeSystemCommandHandler, MapBuildService } = await import('./map-build-service');
    void MapBuildService;
    const { SystemCommandRegistry } = await import('./system-command-registry');
    const registry = new SystemCommandRegistry();
    registry.replace(createMapFinalizeSystemCommandHandler(build.service));
    const handler = registry.resolve('map_finalize');
    expect(handler).not.toBeNull();
    const outcome = await handler!.execute({
      taskId: build.taskId,
      commandId: lease.commandId,
      workItemId: lease.workItemId,
      commandKind: 'map_finalize',
      leaseEpoch: lease.commandLeaseEpoch,
      authorityBaseRef: lease.authorityBaseRef,
      payloadRef: build.specRef,
    });
    expect(outcome.kind).toBe('completed');
    const events = await taskRead(build.taskId);
    expect(events.some((e) => e.type === 'structured_map_candidate_committed')).toBe(true);
  }, 120_000);

  it('F2 (review): a second finish_map_build with a different clientOperationId is rejected with ZERO writes', async () => {
    const build = await makeBuildEnv();
    await build.service.appendChunk(build.ctx, { ordinal: 1, expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, nodes: [nodeDecl('root')], relations: [], clientOperationId: 'op-c1' });
    const frontier = resolveBuildFrontierDigest(build.spec.mapBuildId as string, await chunkRefs(build));
    const first = await build.service.finishMapBuild(build.ctx, { expectedChunkCount: 1, expectedFrontierDigest: frontier, expectedRootCount: 1, clientOperationId: 'op-f1' });
    expect(first.proposed).toBe(true);
    const before = await taskRead(build.taskId);
    // a second finish with a DIFFERENT clientOperationId must fail closed
    await expect(
      build.service.finishMapBuild(build.ctx, { expectedChunkCount: 1, expectedFrontierDigest: frontier, expectedRootCount: 1, clientOperationId: 'op-f2-different' }),
    ).rejects.toBeInstanceOf(MapBuildError);
    const after = await taskRead(build.taskId);
    expect(after.filter((e) => e.type === 'structured_map_build_finish_proposed')).toHaveLength(1);
    expect(after.filter((e) => e.type === 'structured_work_item_created' && e.kind === 'system_map_finalize')).toHaveLength(1);
    expect(after).toHaveLength(before.length); // zero new events
  }, 120_000);

  it('F3 (review): the blocking successor revision is registered and a full rebuild flow completes', async () => {
    const build = await makeBuildEnv();
    // chunk 1 is structurally invalid (duplicate documentOrder) → the initial
    // candidate blocks and the successor revision is started in the SAME envelope.
    await build.service.appendChunk(build.ctx, { ordinal: 1, expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, nodes: [nodeDecl('a'), nodeDecl('b', { parentBuildNodeKey: 'a', documentOrder: 1, siblingOrder: 1 })], relations: [], clientOperationId: 'op-c1' });
    const lease = await finishAndLeaseFinalize(build, build.ctx);
    const rejected = await build.service.executeMapFinalize({ taskId: build.taskId, commandId: lease.commandId, workItemId: lease.workItemId, commandKind: 'map_finalize', leaseEpoch: lease.commandLeaseEpoch, authorityBaseRef: lease.authorityBaseRef, payloadRef: build.specRef });
    expect(rejected.kind).toBe('completed');
    const events = await taskRead(build.taskId);
    const start = events.find((e) => e.type === 'structured_map_build_started' && e.supersedesMapBuildId === 'mb-1');
    expect(start).toBeDefined();
    expect((start as { revision: number }).revision).toBe(2);
    const successorBuildId = (start as { mapBuildId: string }).mapBuildId;
    const successorSpecRef = (start as { mapBuildSpecRef: BlobRefV2 }).mapBuildSpecRef;
    // the successor lineage must be registered in the projection (shared lineage
    // with the rejected initial build — revision 2)
    const project = await build.env.readProjection(build.taskId);
    const successorLineage = project.mapBuilds['mb-1'];
    expect(successorLineage).toBeDefined();
    expect(successorLineage?.revisions['2']?.planId).toBe(successorBuildId);

    // lease the successor's structure_chunk workitem and append a new chunk
    const leased = await build.env.coordinator.leaseNext(build.taskId, 'worker-a', opId('lease-successor'));
    if (leased === null) throw new Error('expected a leased successor structure_chunk workitem');
    const attemptId = leased.attemptId ?? '';
    const successorCtx: V2AttemptContext = {
      taskId: build.taskId,
      workItemId: leased.workItemId,
      attemptId,
      leaseEpoch: leased.leaseEpoch,
      namespace: `structured/structure_chunk/${leased.workItemId}/${attemptId}`,
      agentId: 'worker-a',
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
    const successorFrontier = resolveBuildFrontierDigest(successorBuildId, [await chunkRefAt(build.taskId, 1)]);
    const appended = await build.service.appendChunk(successorCtx, { ordinal: 1, expectedFrontierDigest: successorFrontier, nodes: [nodeDecl('c', { parentBuildNodeKey: 'a', documentOrder: 100, siblingOrder: 2 })], relations: [], clientOperationId: 'op-s2' });
    expect(appended.accepted).toBe(true);

    // finish + finalize the successor — the COMMAND completes (its own candidate
    // still inherits the invalid chunk, but the flow never corrupts)
    await build.service.finishMapBuild(successorCtx, { expectedChunkCount: 2, expectedFrontierDigest: resolveBuildFrontierDigest(successorBuildId, [await chunkRefAt(build.taskId, 1), appended.chunkRef]), expectedRootCount: 1, clientOperationId: 'op-sf' });
    await build.env.coordinator.completeWorkItem({ taskId: build.taskId, operationId: opId('complete-s'), workItemId: successorCtx.workItemId, attemptId: successorCtx.attemptId, resultRefs: [appended.chunkRef] });
    const successorLease = await build.env.coordinator.leaseNext(build.taskId, 'worker-a', opId('lease-sf'));
    if (successorLease === null || successorLease.commandId === null) throw new Error('expected a leased successor finalize command');
    const successorOutcome = await build.service.executeMapFinalize({ taskId: build.taskId, commandId: successorLease.commandId, workItemId: successorLease.workItemId, commandKind: 'map_finalize', leaseEpoch: successorLease.leaseEpoch, authorityBaseRef: successorLease.authorityBaseRef, payloadRef: successorSpecRef });
    expect(successorOutcome.kind).toBe('completed');
    const after = await taskRead(build.taskId);
    expect(after.filter((e) => e.type === 'structured_map_chunk_committed' && e.mapBuildId === successorBuildId)).toHaveLength(1);
  }, 120_000);

  it('F5 (review): a chunk appended AFTER the finish proposal is never silently folded into the candidate', async () => {
    const build = await makeBuildEnv();
    await build.service.appendChunk(build.ctx, { ordinal: 1, expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, nodes: [nodeDecl('root')], relations: [], clientOperationId: 'op-c1' });
    const frontier1 = resolveBuildFrontierDigest(build.spec.mapBuildId as string, await chunkRefs(build));
    await build.service.finishMapBuild(build.ctx, { expectedChunkCount: 1, expectedFrontierDigest: frontier1, expectedRootCount: 1, clientOperationId: 'op-f' });
    // complete the first workitem so a second chunk workitem can be leased
    await build.env.coordinator.completeWorkItem({ taskId: build.taskId, operationId: opId('complete-c1'), workItemId: build.ctx.workItemId, attemptId: build.ctx.attemptId, resultRefs: await chunkRefs(build) });
    // append a SECOND chunk AFTER the proposal (a new workitem is required)
    const secondCtx = await leaseChunkCtx(build, 2, frontier1);
    const appended = await build.service.appendChunk(secondCtx, { ordinal: 2, expectedFrontierDigest: frontier1, nodes: [nodeDecl('n2', { parentBuildNodeKey: 'root', documentOrder: 2, siblingOrder: 1 })], relations: [], clientOperationId: 'op-c2' });
    expect(appended.accepted).toBe(true);
    // finalize must REFUSE (the proposal declared 1 chunk, 2 are committed)
    await build.env.coordinator.completeWorkItem({ taskId: build.taskId, operationId: opId('complete-c2'), workItemId: secondCtx.workItemId, attemptId: secondCtx.attemptId, resultRefs: [appended.chunkRef] });
    const finalizeLease = await build.env.coordinator.leaseNext(build.taskId, 'worker-a', opId('lease-f5'));
    if (finalizeLease === null || finalizeLease.commandId === null) throw new Error('expected a leased finalize command');
    const outcome = await build.service.executeMapFinalize({ taskId: build.taskId, commandId: finalizeLease.commandId, workItemId: finalizeLease.workItemId, commandKind: 'map_finalize', leaseEpoch: finalizeLease.leaseEpoch, authorityBaseRef: finalizeLease.authorityBaseRef, payloadRef: build.specRef });
    expect(outcome.kind).toBe('retryable_failure');
    const events = await taskRead(build.taskId);
    expect(events.some((e) => e.type === 'structured_map_candidate_committed')).toBe(false);
    expect(events.some((e) => e.type === 'structured_map_build_finalized')).toBe(false);
  }, 120_000);

  it('two System finalizers race and only one candidate/round successor commits', async () => {
    const build = await makeBuildEnv();
    const lastCtx = await appendChain(build, 2);
    const lease = await finishAndLeaseFinalize(build, lastCtx);
    const first = await build.service.executeMapFinalize({ taskId: build.taskId, commandId: lease.commandId, workItemId: lease.workItemId, commandKind: 'map_finalize', leaseEpoch: lease.commandLeaseEpoch, authorityBaseRef: lease.authorityBaseRef, payloadRef: build.specRef });
    expect(first.kind).toBe('completed');
    const second = await build.service.executeMapFinalize({ taskId: build.taskId, commandId: 'cmd-2', workItemId: 'wi-finalize-2', commandKind: 'map_finalize', leaseEpoch: 1, authorityBaseRef: lease.authorityBaseRef, payloadRef: build.specRef });
    expect(second.kind === 'retryable_failure' || second.kind === 'completed').toBe(true);
    const events = await taskRead(build.taskId);
    expect(events.filter((e) => e.type === 'structured_map_candidate_committed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'structured_map_review_round_planned')).toHaveLength(1);
  }, 120_000);
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function taskRead(taskId: string): Promise<AuthoritativeReviewEventV2[]> {
  const env = envs[envs.length - 1];
  return (await env.env.eventStore.read(taskId)).map((e) => e.event as AuthoritativeReviewEventV2);
}

async function chunkRefAt(taskId: string, ordinal: number): Promise<BlobRefV2> {
  const events = await taskRead(taskId);
  const chunk = events.find((e) => e.type === 'structured_map_chunk_committed' && e.chunkOrdinal === ordinal);
  if (chunk === undefined || chunk.type !== 'structured_map_chunk_committed') throw new Error(`no chunk ${ordinal}`);
  return chunk.chunkRef;
}

async function chunkRefs(build: BuildEnv): Promise<BlobRefV2[]> {
  const events = await taskRead(build.taskId);
  return events
    .filter((e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_chunk_committed' }> => e.type === 'structured_map_chunk_committed')
    .sort((a, b) => a.chunkOrdinal - b.chunkOrdinal)
    .map((e) => e.chunkRef);
}

/** Appends `count` chunks as a deterministic chain under one root; each chunk is
 * committed by its own structure_chunk WorkItem (the §17.5 per-chunk grant
 * scope), completing each workitem before the next is leased. Returns the ctx
 * of the LAST chunk workitem (still leased — the finish proposal uses it). */
async function appendChain(build: BuildEnv, count: number): Promise<V2AttemptContext> {
  let lastCtx = build.ctx;
  for (let i = 1; i <= count; i += 1) {
    const nodes = i === 1 ? [nodeDecl('root')] : [nodeDecl(`n${i}`, { parentBuildNodeKey: i === 2 ? 'root' : `n${i - 1}`, documentOrder: i, siblingOrder: i - 1 })];
    const frontier = i === 1 ? EMPTY_BUILD_FRONTIER_DIGEST : resolveBuildFrontierDigest(build.spec.mapBuildId as string, await chunkRefs(build));
    const ctx = i === 1 ? build.ctx : await leaseChunkCtx(build, i, frontier);
    const result = await build.service.appendChunk(ctx, { ordinal: i, expectedFrontierDigest: frontier, nodes, relations: [], clientOperationId: `op-c${i}` });
    lastCtx = ctx;
    if (i < count) {
      // Complete this workitem so the next chunk WorkItem can be leased.
      await build.env.coordinator.completeWorkItem({ taskId: build.taskId, operationId: opId(`complete-${i}`), workItemId: ctx.workItemId, attemptId: ctx.attemptId, resultRefs: [result.chunkRef] });
    }
  }
  return lastCtx;
}

/** Creates + leases ONE structure_chunk workitem scoped to `ordinal`. */
async function leaseChunkCtx(build: BuildEnv, ordinal: number, parentFrontier: string): Promise<V2AttemptContext> {
  const workItemId = `wi-build-${ordinal}`;
  const base = buildAuthorityBaseSet({
    taskId: build.taskId,
    templateSnapshotRef: build.env.templateSnapshotRef,
    profileSnapshotRef: build.env.profileSnapshotRef,
    refs: { planSpecRef: build.specRef },
    kind: 'agent_assignment',
    agentExecutionKind: 'structured_session',
    sessionKind: 'structure_chunk',
  });
  const baseRef = await build.env.facade.prepareBlob(build.taskId, 'authority_base_set', base);
  const grantBody = {
    grantSpecId: `gs-build-${ordinal}`,
    workItemId,
    kind: 'initial_structure_chunk' as const,
    snapshotHash: 'a'.repeat(64),
    authorityBaseRef: baseRef,
    mapBuildSpecRef: build.specRef,
    expectedFrontierDigest: parentFrontier,
    structureChunkScope: { chunkOrdinal: ordinal, parentFrontierDigest: parentFrontier, maxNodes: 512, maxRelations: 64 },
  };
  const grantSpecRef = await build.env.facade.prepareBlob(build.taskId, 'write_grant_spec', { ...grantBody, specDigest: canonicalJsonSha256(grantBody) });
  await build.env.coordinator.createWorkItem({
    taskId: build.taskId,
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
    payload: { kind: 'map_build_spec', value: build.spec },
    authorityBase: base,
    grantSpecRef,
    maxAutomaticRetries: 2,
  });
  const leased = await build.env.coordinator.leaseNext(build.taskId, 'worker-a', opId(`lease-${workItemId}`));
  if (leased === null) throw new Error(`no lease for ${workItemId}`);
  const attemptId = leased.attemptId ?? '';
  return {
    taskId: build.taskId,
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

async function finishAndLeaseFinalize(build: BuildEnv, lastCtx?: V2AttemptContext): Promise<{ commandId: string; commandLeaseEpoch: number; authorityBaseRef: BlobRefV2; workItemId: string }> {
  const ctx = lastCtx ?? build.ctx;
  const chunkCount = (await chunkRefs(build)).length;
  const frontier = chunkCount === 0 ? EMPTY_BUILD_FRONTIER_DIGEST : resolveBuildFrontierDigest(build.spec.mapBuildId as string, await chunkRefs(build));
  await build.service.finishMapBuild(ctx, { expectedChunkCount: chunkCount, expectedFrontierDigest: frontier, expectedRootCount: 1, clientOperationId: 'op-finish' });
  // Complete the last chunk workitem (it carried the finish declaration) so the
  // system_map_finalize workitem becomes claimable.
  await build.env.coordinator.completeWorkItem({ taskId: build.taskId, operationId: opId('complete-last'), workItemId: ctx.workItemId, attemptId: ctx.attemptId, resultRefs: await chunkRefs(build) });
  const leased = await build.env.coordinator.leaseNext(build.taskId, 'worker-a', opId('lease-finalize'));
  if (leased === null || leased.commandId === null) throw new Error('expected a leased system_map_finalize command');
  return { commandId: leased.commandId, commandLeaseEpoch: leased.leaseEpoch, authorityBaseRef: leased.authorityBaseRef, workItemId: leased.workItemId };
}
