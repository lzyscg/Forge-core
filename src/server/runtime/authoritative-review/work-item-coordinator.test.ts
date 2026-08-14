// @vitest-environment node
/**
 * Task 10 WorkItem coordinator tests (design §17.2/§17.3, spec §9.2/§10.2/
 * §10.3): every operation-keyed atomic method commits ONE batch through the
 * real append facade over temporary roots, reprojects via the Task 9
 * checkpoint store, and is exercised for legal transitions, epoch
 * conventions, the two-lease CAS race, expired reclaim + late-result
 * rejection, deterministic ordering, suspension overlay semantics, budget
 * parks/manual retry, and response-loss idempotency. All tests use a frozen
 * mutable clock, deterministic operation ids and injected worker ids.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { CommittedEvent } from '../../storage/event-store';
import { STORAGE_ERROR_CODES, StorageError } from '../../storage/atomic-file';
import { validateAuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { WriteGrantSpecV2 } from '../../authoritative-review/authority-types';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import {
  WorkItemCoordinatorV2,
  CoordinatorError,
  shouldSignGrantInstance,
  type LeasedWorkV2,
} from './work-item-coordinator';
import { buildAuthorityBaseSet, type BuildAuthorityBaseSetInputV2 } from './authority-base';
import type { AuthoritativeAppendFacadeV2 } from '../../storage/authoritative-append-facade';
import type { AuthoritativeReviewCheckpointStore } from '../../storage/authoritative-review-checkpoint-store';
import type { AuthoritativeReviewProjectionV2, BlobObjectResolver } from '../../storage/authoritative-review-state';
import { dispositionDigest } from './work-item-coordinator';
import {
  createWorkItemCoordinatorEnvironment,
  disposeRuntimeTestRoots,
  type WorkItemCoordinatorEnvironment,
} from '../test-support';

let seq = 0;

/** Deterministic operation ids (UUID-shaped, unique per call). */
function opId(label: string): string {
  seq += 1;
  const root = createHash('sha256').update(`op:${label}:${seq}`).digest('hex');
  return `${root.slice(0, 8)}-${root.slice(8, 12)}-4${root.slice(13, 16)}-8${root.slice(17, 20)}-${root.slice(20, 32)}`;
}

function wiId(label: string): string {
  return `wi-${label}-${createHash('sha256').update(label).digest('hex').slice(0, 8)}`;
}

function tid(label: string): string {
  return `task-${label}-${createHash('sha256').update(label).digest('hex').slice(0, 8)}`;
}

let envs: WorkItemCoordinatorEnvironment[] = [];

async function makeEnv(options: { leaseDurationMs?: number; raw?: boolean } = {}): Promise<WorkItemCoordinatorEnvironment> {
  const env = await createWorkItemCoordinatorEnvironment({
    leaseDurationMs: options.leaseDurationMs ?? 30 * 60 * 1000,
  });
  envs.push(env);
  return env;
}

afterEach(async () => {
  disposeRuntimeTestRoots();
  envs = [];
});

/** The base-set ref builder used by every test (per-kind synthetic refs). */
function synthRef(kind: string, salt: number): BlobRefV2 {
  return {
    kind: kind as BlobRefV2['kind'],
    digest: canonicalJsonSha256({ kind, salt }),
    byteLength: 12,
    mediaType: 'application/json',
    schemaVersion: 1,
  };
}

function baseInput(
  env: WorkItemCoordinatorEnvironment,
  taskId: string,
  overrides: Partial<BuildAuthorityBaseSetInputV2> = {},
  refs: Record<string, BlobRefV2> = {},
): BuildAuthorityBaseSetInputV2 {
  return {
    taskId,
    templateSnapshotRef: env.templateSnapshotRef,
    profileSnapshotRef: env.profileSnapshotRef,
    kind: 'agent_assignment',
    agentExecutionKind: 'structured_session',
    sessionKind: 'structure_chunk',
    refs,
    ...overrides,
  };
}

/** Per-session legal base refs (mirrors the authority-base matrix tables). */
const SESSION_DEFAULT_REFS: Record<string, Record<string, BlobRefV2>> = {
  structure_chunk: { planSpecRef: synthRef('map_build_spec', 10) },
  review_map_batch: { mapCandidateRef: synthRef('map_candidate', 11), reviewCoverageCoreRef: synthRef('map_review_coverage_core', 12), reviewRoundRef: synthRef('map_review_bundle', 13) },
  review_map_whole: { mapCandidateRef: synthRef('map_candidate', 11), reviewCoverageCoreRef: synthRef('map_review_coverage_core', 12), reviewRoundRef: synthRef('map_review_bundle', 13) },
  generation_batch: { mapRef: synthRef('map_snapshot', 14), contentRevisionManifestRef: synthRef('content_revision_manifest', 15), planSpecRef: synthRef('generation_plan_spec', 16) },
  review_content_batch: { mapRef: synthRef('map_snapshot', 14), contentRevisionManifestRef: synthRef('content_revision_manifest', 15), reviewCoverageCoreRef: synthRef('content_review_coverage_core', 17), reviewRoundRef: synthRef('review_bundle', 18) },
  review_content_whole: { mapRef: synthRef('map_snapshot', 14), contentRevisionManifestRef: synthRef('content_revision_manifest', 15), reviewCoverageCoreRef: synthRef('content_review_coverage_core', 17), reviewRoundRef: synthRef('review_bundle', 18) },
  map_repair: { mapRef: synthRef('map_snapshot', 14), planSpecRef: synthRef('repair_plan_spec', 19), stagingManifestRef: synthRef('repair_staging_root', 20) },
  content_repair: { mapRef: synthRef('map_snapshot', 14), contentRevisionManifestRef: synthRef('content_revision_manifest', 15), planSpecRef: synthRef('repair_plan_spec', 19), stagingManifestRef: synthRef('repair_staging_root', 20) },
};

function baseForStructure(env: WorkItemCoordinatorEnvironment, taskId: string, planSpecRef: BlobRefV2) {
  return buildAuthorityBaseSet(baseInput(env, taskId, {}, { planSpecRef }));
}

interface CreateOptionsV2 {
  sessionKind?: string | null;
  roleBinding?: string | null;
  logicalAssignmentId?: string;
  reviewAssignmentId?: string | null;
  maxAutomaticRetries?: number;
  payloadText?: string;
  baseRefs?: Record<string, BlobRefV2>;
}

/**
 * Creates one legal agent workitem through the coordinator. The FROZEN event
 * validator requires every agent_assignment to carry a write grant spec, so
 * the helper always grants one (a real published spec bound to the base).
 */
async function createAgentWorkItem(
  env: WorkItemCoordinatorEnvironment,
  taskId: string,
  options: CreateOptionsV2 = {},
): Promise<{ workItemId: string; authorityBaseRef: BlobRefV2 }> {
  const workItemId = wiId(
    `${String(options.sessionKind ?? 'structure')}-${options.logicalAssignmentId ?? 'la-default'}`,
  );
  const session = options.sessionKind ?? 'structure_chunk';
  const effectiveRefs =
    options.baseRefs ??
    (session === null ? { sealRecordRef: synthRef('seal_record', 30), artifactRef: synthRef('artifact', 31), artifactDeliveryRef: synthRef('system_artifact_delivery', 32) } : SESSION_DEFAULT_REFS[session]) ??
    {};
  const planSpecRef = effectiveRefs.planSpecRef ?? SESSION_DEFAULT_REFS[String(session)]?.planSpecRef ?? synthRef('map_build_spec', 10);
  const base = buildAuthorityBaseSet(
    baseInput(env, taskId, {
      kind: 'agent_assignment',
      agentExecutionKind: session === null ? 'generic_turn' : 'structured_session',
      sessionKind: session as never,
      refs: effectiveRefs,
    }, {}),
  );
  const result = await env.coordinator.createWorkItem({
    taskId,
    operationId: opId(`create-${workItemId}`),
    workItemId,
    kind: 'agent_assignment',
    roleBinding: options.roleBinding ?? 'orchestrator',
    agentExecutionKind: options.sessionKind === null ? 'generic_turn' : 'structured_session',
    sessionKind: (options.sessionKind ?? 'structure_chunk') as never,
    logicalAssignmentId: options.logicalAssignmentId ?? `la-${workItemId}`,
    reviewAssignmentId: options.reviewAssignmentId ?? null,
    inputArtifactDeliveryId: options.sessionKind === null ? 'del-1' : null,
    payload: { kind: 'content_value', value: payloadObject(options.payloadText ?? 'payload') },
    authorityBase: base,
    grantSpec: { build: (baseRef: BlobRefV2) => sessionGrantSpec(env, session, baseRef, base) },
    maxAutomaticRetries: options.maxAutomaticRetries ?? 2,
  });
  return { workItemId, authorityBaseRef: result.authorityBaseRef };
}

/**
 * A legal write-grant spec for the session kind (the FROZEN created-event
 * validator demands a grant ref on EVERY agent workitem; reviewers/submitters
 * carry a stand-in structure spec that is never signed into a GrantInstance -
 * session grants are only materialized for the four write sessions).
 */
function sessionGrantSpec(
  env: WorkItemCoordinatorEnvironment,
  sessionKind: string | null,
  baseRef: BlobRefV2,
  base: { planSpecRef: BlobRefV2 | null; mapRef: BlobRefV2 | null; mapCandidateRef: BlobRefV2 | null; contentRevisionManifestRef: BlobRefV2 | null; stagingManifestRef: BlobRefV2 | null },
): WriteGrantSpecV2 {
  const planRef = (base.planSpecRef as BlobRefV2 | null) ?? synthRef('map_build_spec', 10);
  let body: Record<string, unknown>;
  if (sessionKind === 'generation_batch') {
    body = {
      grantSpecId: 'grant-spec-gen',
      workItemId: 'wi-grant',
      kind: 'initial_generation_batch',
      snapshotHash: '0'.repeat(64),
      authorityBaseRef: baseRef,
      generationPlanSpecRef: planRef,
      activeMapRef: (base.mapRef as BlobRefV2 | null) ?? synthRef('map_snapshot', 14),
      expectedContentRevisionManifestRef: (base.contentRevisionManifestRef as BlobRefV2 | null) ?? synthRef('content_revision_manifest', 15),
      writeSlotIds: [],
      readScope: { maxContextBytes: 1_048_576 },
    };
  } else if (sessionKind === 'map_repair') {
    body = {
      grantSpecId: 'grant-spec-map-repair',
      workItemId: 'wi-grant',
      kind: 'map_repair_batch',
      snapshotHash: '0'.repeat(64),
      authorityBaseRef: baseRef,
      repairPlanSpecRef: planRef,
      repairBase: {
        kind: (base.mapRef as BlobRefV2 | null) !== null ? 'map_active' : 'map_candidate',
        ...((base.mapRef as BlobRefV2 | null) !== null
          ? { mapRef: base.mapRef }
          : { candidateRef: base.mapCandidateRef ?? synthRef('map_candidate', 11) }),
      },
      expectedStagingRootRef: (base.stagingManifestRef as BlobRefV2 | null) ?? synthRef('repair_staging_root', 20),
      planKeyLedgerRef: null,
      batchOrdinal: 1,
      findingIds: [],
      readScope: { maxContextBytes: 1_048_576 },
      writeScope: {
        mapWriteScope: {
          nodeIds: [],
          relationIds: [],
          allowedPlanKeys: [],
          parentContainers: [],
          relationTypeIds: [],
          operations: [],
        },
      },
    };
  } else if (sessionKind === 'content_repair') {
    body = {
      grantSpecId: 'grant-spec-content-repair',
      workItemId: 'wi-grant',
      kind: 'content_repair_batch',
      snapshotHash: '0'.repeat(64),
      authorityBaseRef: baseRef,
      repairPlanSpecRef: planRef,
      repairBase: {
        kind: 'content',
        mapRef: (base.mapRef as BlobRefV2 | null) ?? synthRef('map_snapshot', 14),
        contentRevisionManifestRef: (base.contentRevisionManifestRef as BlobRefV2 | null) ?? synthRef('content_revision_manifest', 15),
      },
      expectedStagingRootRef: (base.stagingManifestRef as BlobRefV2 | null) ?? synthRef('repair_staging_root', 20),
      planKeyLedgerRef: null,
      batchOrdinal: 1,
      findingIds: [],
      readScope: { maxContextBytes: 1_048_576 },
      writeScope: { writeSlotIds: [] },
    };
  } else {
    body = {
      grantSpecId: 'grant-spec-structure',
      workItemId: 'wi-grant',
      kind: 'initial_structure_chunk',
      snapshotHash: '0'.repeat(64),
      authorityBaseRef: baseRef,
      mapBuildSpecRef: planRef,
      expectedFrontierDigest: '0'.repeat(64),
      structureChunkScope: {
        chunkOrdinal: 1,
        parentFrontierDigest: '0'.repeat(64),
        maxNodes: 512,
        maxRelations: 64,
      },
    };
  }
  const digestBody = { ...body };
  delete (digestBody as { specDigest?: string }).specDigest;
  return { ...body, specDigest: canonicalJsonSha256(digestBody) } as WriteGrantSpecV2;
}

/** The exact content_value object the coordinator canonicalizes (must equal its ref). */
function payloadObject(text: string): Record<string, unknown> {
  const without = {
    slotId: 's-1',
    contentSchemaDigest: '0'.repeat(64),
    taskContentRevision: 1,
    mediaType: 'text/plain',
    text,
  };
  return { ...without, selfDigest: canonicalJsonSha256(without) };
}

/**
 * Appends a RAW validated v2 batch with a LIVE fence proof — the legal
 * "foreign committer" seam for seeding histories the coordinator cannot
 * express (a human-question park). Tests only; the boundary scan ignores
 * test files, and every appended event still passes the strict validator and
 * projects through the Task 9 projector.
 */
async function rawAppend(
  env: WorkItemCoordinatorEnvironment,
  taskId: string,
  operationId: string,
  events: Array<Record<string, unknown>>,
): Promise<CommittedEvent[]> {
  const envelopes = events.map((event) =>
    validateAuthoritativeReviewEventV2({
      protocolVersion: 2,
      id: `evt-raw-${createHash('sha256').update(operationId + String(events.indexOf(event))).digest('hex').slice(0, 32)}`,
      at: env.now.value,
      ...event,
    }),
  );
  const tail = await env.eventStore.tail(taskId);
  const hold = await env.publicationStore.lock().acquire();
  try {
    const proof = await hold.proof();
    return env.eventStore.appendBatch(taskId, operationId, envelopes, {
      expectedLastSequence: tail.lastSequence,
      fenceProof: proof,
    });
  } finally {
    await hold.release();
  }
}

describe('createWorkItem', () => {
  it('creates a ready WorkItem atomically with base + payload blobs pinned and verified', async () => {
    const env = await makeEnv();
    const taskId = tid('create');
    const base = baseForStructure(env, taskId, synthRef('map_build_spec', 10));
    const operationId = opId('create-first');
    const result = await env.coordinator.createWorkItem({
      taskId,
      operationId,
      workItemId: 'wi-first',
      kind: 'agent_assignment',
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
      logicalAssignmentId: 'la-first',
      reviewAssignmentId: null,
      inputArtifactDeliveryId: null,
      payload: { kind: 'content_value', value: payloadObject('first payload') },
      authorityBase: base,
      grantSpec: { build: (baseRef) => env.structureChunkGrantSpec(baseRef, base.planSpecRef as BlobRefV2) },
      maxAutomaticRetries: 2,
    });
    expect(result.workItemId).toBe('wi-first');
    expect(result.replayed).toBe(false);
    expect(result.grantSpecRef?.kind).toBe('write_grant_spec');
    await expect(env.resolverFor(taskId)(result.authorityBaseRef)).resolves.toMatchObject({ taskId });
    await expect(env.resolverFor(taskId)(result.payloadRef)).resolves.toMatchObject({ text: 'first payload' });
    const projection = await env.readProjection(taskId);
    const wi = projection.workItems['wi-first'];
    expect(wi).toMatchObject({
      kind: 'agent_assignment',
      roleBinding: 'orchestrator',
      sessionKind: 'structure_chunk',
      state: 'ready',
      leaseEpoch: 0,
      leaseOwner: null,
      retryOrdinal: 0,
      attemptCount: 0,
      maxAutomaticRetries: 2,
    });
    expect(projection.taskStatus).toBe('running');
    // baseSetDigest of the prepared blob equals the object's canonical minus field.
    const baseObject = (await env.resolverFor(taskId)(result.authorityBaseRef)) as Record<string, unknown>;
    const { baseSetDigest, ...withoutDigest } = baseObject;
    expect(canonicalJsonSha256(withoutDigest)).toBe(baseSetDigest);
  });

  it('replays the SAME committed result for the same operation+payload (response loss)', async () => {
    const env = await makeEnv();
    const taskId = tid('replay');
    const operationId = opId('create-replay');
    const input = {
      taskId,
      operationId,
      workItemId: 'wi-replay',
      kind: 'agent_assignment' as const,
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session' as const,
      sessionKind: 'structure_chunk' as const,
      logicalAssignmentId: 'la-replay',
      reviewAssignmentId: null,
      inputArtifactDeliveryId: null,
      payload: { kind: 'content_value' as const, value: payloadObject('replay payload') },
      authorityBase: baseForStructure(env, taskId, synthRef('map_build_spec', 10)),
      grantSpec: { build: (baseRef: BlobRefV2) => env.structureChunkGrantSpec(baseRef, synthRef('map_build_spec', 10)) },
      maxAutomaticRetries: 2,
    };
    const first = await env.coordinator.createWorkItem(input);
    const second = await env.coordinator.createWorkItem(input);
    expect(second.replayed).toBe(true);
    expect(second.events.map((entry) => entry.event.id)).toEqual(first.events.map((entry) => entry.event.id));
    const projection = await env.readProjection(taskId);
    expect(Object.keys(projection.workItems)).toEqual(['wi-replay']);
  });

  it('conflicts when the same operationId carries a DIFFERENT payload, and never creates a second logical successor', async () => {
    const env = await makeEnv();
    const taskId = tid('conflict');
    const operationId = opId('create-conflict');
    const input = {
      taskId,
      operationId,
      workItemId: 'wi-conflict',
      kind: 'agent_assignment' as const,
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session' as const,
      sessionKind: 'structure_chunk' as const,
      logicalAssignmentId: 'la-conflict',
      reviewAssignmentId: null,
      inputArtifactDeliveryId: null,
      payload: { kind: 'content_value' as const, value: payloadObject('conflict payload') },
      authorityBase: baseForStructure(env, taskId, synthRef('map_build_spec', 10)),
      grantSpec: { build: (baseRef: BlobRefV2) => env.structureChunkGrantSpec(baseRef, synthRef('map_build_spec', 10)) },
      maxAutomaticRetries: 2,
    };
    await env.coordinator.createWorkItem(input);
    await expect(
      env.coordinator.createWorkItem({
        ...input,
        operationId,
        workItemId: 'wi-conflict-2',
        payload: { kind: 'content_value', value: payloadObject('changed payload') },
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    // The SAME workItemId under the same operation with a CHANGED payload is
    // also a conflict (brief Step 5): the replay path compares the input's
    // canonical refs against the committed event's and refuses to fake the
    // original result.
    await expect(
      env.coordinator.createWorkItem({
        ...input,
        payload: { kind: 'content_value', value: payloadObject('changed payload') },
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    // A NEW operationId for the SAME workItemId is rejected before any pin.
    await expect(
      env.coordinator.createWorkItem({ ...input, operationId: opId('create-conflict-new'), workItemId: 'wi-conflict' }),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_EXISTS' });
    const projection = await env.readProjection(taskId);
    expect(Object.keys(projection.workItems)).toEqual(['wi-conflict']);
  });

  it('enforces the WorkItem kind field matrices and mandatory profile ref', async () => {
    const env = await makeEnv();
    const taskId = tid('matrix');
    const base = baseForStructure(env, taskId, synthRef('map_build_spec', 10));
    const common = {
      taskId,
      operationId: opId('matrix-op'),
      roleBinding: null as string | null,
      agentExecutionKind: null as 'structured_session' | 'generic_turn' | null,
      sessionKind: null,
      logicalAssignmentId: null as string | null,
      reviewAssignmentId: null,
      inputArtifactDeliveryId: null as string | null,
      payload: { kind: 'content_value' as const, value: payloadObject('p') },
      authorityBase: base,
      maxAutomaticRetries: 2,
    };
    // system workitem with a grant spec ref
    await expect(
      env.coordinator.createWorkItem({
        ...common,
        operationId: opId('matrix-op-grant'),
        workItemId: 'wi-system-grant',
        kind: 'system_seal',
        grantSpecRef: synthRef('write_grant_spec', 1),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // generic turn without a delivery id
    await expect(
      env.coordinator.createWorkItem({
        ...common,
        operationId: opId('matrix-op-generic'),
        workItemId: 'wi-generic-nodel',
        kind: 'agent_assignment',
        roleBinding: 'submitter',
        agentExecutionKind: 'generic_turn',
        logicalAssignmentId: 'la-g',
        inputArtifactDeliveryId: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // structured session without a sessionKind
    await expect(
      env.coordinator.createWorkItem({
        ...common,
        operationId: opId('matrix-op-struct'),
        workItemId: 'wi-struct-nos',
        kind: 'agent_assignment',
        roleBinding: 'orchestrator',
        agentExecutionKind: 'structured_session',
        sessionKind: null,
        logicalAssignmentId: 'la-s',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // review session without reviewAssignmentId
    await expect(
      env.coordinator.createWorkItem({
        ...common,
        operationId: opId('matrix-op-review'),
        workItemId: 'wi-review-nora',
        kind: 'agent_assignment',
        roleBinding: 'reviewer',
        agentExecutionKind: 'structured_session',
        sessionKind: 'review_map_batch',
        logicalAssignmentId: 'la-r',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // base without the mandatory profileSnapshotRef
    expect(() =>
      buildAuthorityBaseSet({
        ...baseInput(env, taskId),
        profileSnapshotRef: undefined as unknown as BlobRefV2,
      }),
    ).toThrow();
    // nothing was committed by any rejected call
    const projection = await env.readProjection(taskId);
    expect(Object.keys(projection.workItems)).toEqual([]);
    expect(projection.taskStatus).toBe('ready');
  });

  it('accepts a structure-chunk grant spec whose plan/base refs are uniform', async () => {
    const env = await makeEnv();
    const taskId = tid('grant');
    const mapBuildSpecRef = await env.publishMapBuildSpec(taskId);
    const base = baseForStructure(env, taskId, mapBuildSpecRef);
    const result = await env.coordinator.createWorkItem({
      taskId,
      operationId: opId('create-grant'),
      workItemId: 'wi-granted',
      kind: 'agent_assignment',
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
      logicalAssignmentId: 'la-granted',
      reviewAssignmentId: null,
      inputArtifactDeliveryId: null,
      payload: { kind: 'content_value', value: payloadObject('grant payload') },
      authorityBase: base,
      grantSpec: { build: (baseRef) => env.structureChunkGrantSpec(baseRef, mapBuildSpecRef) },
      maxAutomaticRetries: 2,
    });
    expect(result.grantSpecRef?.kind).toBe('write_grant_spec');
    const spec = (await env.resolverFor(taskId)(result.grantSpecRef as BlobRefV2)) as {
      authorityBaseRef: BlobRefV2;
    };
    expect(spec.authorityBaseRef).toEqual(result.authorityBaseRef);
  });
});

// Flake-hardening (Task 11 continuation): every test here chains many
// sequential fsync-heavy facade publishes; under full-suite 12-worker load a
// single test can exceed vitest's 5 s default even though it runs in ~1.4 s
// in isolation. The 30 s bound is a pure hang guard — the tests never depend
// on wall time (all clocks injected).
// Flake-hardening (Task 11 continuation): every test here chains many
// sequential fsync-heavy facade publishes; under full-suite 12-worker load a
// single test can exceed vitest's 5 s default even though it runs in ~1.4 s
// in isolation. The 30 s bound is a pure hang guard — the tests never depend
// on wall time (all clocks injected).
describe('leaseNext — claims, ordering, batch shape', () => {
  it('leases the only ready agent workitem with a full lease→dispatch→attempt envelope', async () => {
    const env = await makeEnv();
    const taskId = tid('lease');
    const { workItemId } = await createAgentWorkItem(env, taskId);
    const worker = env.worker.next();
    const leased = await env.coordinator.leaseNext(taskId, worker, opId('lease-1'));
    expect(leased).not.toBeNull();
    expect(leased?.workItemId).toBe(workItemId);
    expect(leased?.leaseEpoch).toBe(1);
    expect(leased?.leaseOwner).toBe(worker);
    expect(leased?.leaseExpiresAt).toBe(env.iso(30 * 60 * 1000));
    expect(leased?.attemptId).toMatch(/^att-/);
    expect(leased?.dispatchRef?.kind).toBe('assignment_dispatch');
    expect(leased?.grantInstanceRef?.kind).toBe('grant_instance');
    expect(leased?.wakeup).toEqual({ kind: 'lease_expiry', at: env.iso(30 * 60 * 1000) });
    const projection = await env.readProjection(taskId);
    const wi = projection.workItems[workItemId];
    expect(wi.state).toBe('leased');
    expect(wi.leaseEpoch).toBe(1);
    expect(wi.leaseOwner).toBe(worker);
    expect(projection.activeLease).toEqual({
      workItemId,
      leaseEpoch: 1,
      attemptId: leased?.attemptId ?? null,
      commandId: null,
      leaseOwner: worker,
    });
    // dispatch blob resolves and binds the SAME base + attempt identity
    const dispatch = (await env.resolverFor(taskId)(leased?.dispatchRef as BlobRefV2)) as {
      workItemId: string;
      attemptId: string;
      authorityBaseRef: BlobRefV2;
      grantInstanceRef: BlobRefV2 | null;
      agentExecutionKind: string;
      sessionKind: string;
    };
    expect(dispatch.workItemId).toBe(workItemId);
    expect(dispatch.attemptId).toBe(leased?.attemptId);
    expect(dispatch.authorityBaseRef).toEqual(projection.workItems[workItemId].authorityBaseRef);
    expect(dispatch.grantInstanceRef).toEqual(leased?.grantInstanceRef);
    expect(dispatch.agentExecutionKind).toBe('structured_session');
    expect(dispatch.sessionKind).toBe('structure_chunk');
  });

  it('returns null when no workitem is claimable (active lease, suspension, budget park, nothing ready)', async () => {
    const env = await makeEnv();
    const taskId = tid('null-claim');
    const { workItemId } = await createAgentWorkItem(env, taskId, { maxAutomaticRetries: 1 });
    // active lease
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-a'));
    expect(await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-b'))).toBeNull();
    // reclaim (crash recovery is legal before expiry) -> ready; suspension then blocks claims
    await env.coordinator.reclaimExpired(taskId, workItemId, opId('reclaim-1'), 'crash_recovery');
    await env.coordinator.applySuspension(taskId, opId('suspend-1'), 'user_stop');
    expect(await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-c'))).toBeNull();
    await env.coordinator.clearSuspension(taskId, opId('resume-1'));
    // budget park -> status retryable_failure blocks claims
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-c2'));
    const attemptIdFor1 = (await env.readProjection(taskId)).activeLease?.attemptId ?? undefined;
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: opId('fail-1'),
      workItemId,
      attemptId: attemptIdFor1,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'f'.repeat(64),
      retryNotBefore: env.iso(-1000),
    });
    await env.coordinator.requeueDue(taskId, workItemId, opId('requeue-1'));
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-c3'));
    const attemptIdFor2 = (await env.readProjection(taskId)).activeLease?.attemptId ?? undefined;
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: opId('fail-2'),
      workItemId,
      attemptId: attemptIdFor2,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'f'.repeat(64),
      retryNotBefore: env.iso(-1000),
    });
    expect(await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-d'))).toBeNull();
    const projection = await env.readProjection(taskId);
    expect(projection.taskStatus).toBe('retryable_failure');
    expect(projection.retryBudgetExhaustedWorkItemId).toBe(workItemId);
    // empty task
    const emptyTask = tid('empty');
    expect(await env.coordinator.leaseNext(emptyTask, env.worker.next(), opId('lease-e'))).toBeNull();
  });

  it('claims the deterministic FIRST ready workitem: phase order, then WorkItem id', async () => {
    // maxActiveLeasesPerTask = 1 and Task 10 has no completion method, so the
    // observable claim surface of a ready set is its FIRST claim per task.
    const env = await makeEnv();
    const taskId = tid('order');
    await createAgentWorkItem(env, taskId, { sessionKind: 'content_repair', logicalAssignmentId: 'la-1' });
    await createAgentWorkItem(env, taskId, { sessionKind: 'review_content_batch', logicalAssignmentId: 'la-3', reviewAssignmentId: 'ra-3' });
    await createAgentWorkItem(env, taskId, { sessionKind: 'structure_chunk', logicalAssignmentId: 'la-2' });
    const first = await env.coordinator.leaseNext(taskId, env.worker.next(), opId('order-first'));
    expect(first?.workItemId).toContain('structure_chunk');
    // From scratch, the identical claim is repeatable (deterministic order).
    const secondTask = tid('order2');
    await createAgentWorkItem(env, secondTask, { sessionKind: 'content_repair', logicalAssignmentId: 'la-1' });
    await createAgentWorkItem(env, secondTask, { sessionKind: 'review_content_batch', logicalAssignmentId: 'la-3', reviewAssignmentId: 'ra-3' });
    await createAgentWorkItem(env, secondTask, { sessionKind: 'structure_chunk', logicalAssignmentId: 'la-2' });
    const again = await env.coordinator.leaseNext(secondTask, env.worker.next(), opId('order-again'));
    expect(again?.workItemId).toBe(first?.workItemId);
    // Within one phase, the lexicographically smallest WorkItem id wins —
    // and after a reclaim the deterministic re-claim returns the SAME id.
    const thirdTask = tid('order3');
    const phaseIdA = (await createAgentWorkItem(env, thirdTask, { sessionKind: 'review_map_batch', logicalAssignmentId: 'la-1', reviewAssignmentId: 'ra-1' })).workItemId;
    const phaseIdB = (await createAgentWorkItem(env, thirdTask, { sessionKind: 'review_map_batch', logicalAssignmentId: 'la-2', reviewAssignmentId: 'ra-2' })).workItemId;
    const expectedFirst = [phaseIdA, phaseIdB].sort()[0];
    const firstOfPhase = await env.coordinator.leaseNext(thirdTask, env.worker.next(), opId('order-phase'));
    expect(firstOfPhase?.workItemId).toBe(expectedFirst);
    // single lease: the second claim is unavailable while the first is active
    expect(await env.coordinator.leaseNext(thirdTask, env.worker.next(), opId('order-phase-2'))).toBeNull();
    await env.coordinator.reclaimExpired(thirdTask, String(firstOfPhase?.workItemId), opId('order-reclaim'), 'crash_recovery');
    const nextOfPhase = await env.coordinator.leaseNext(thirdTask, env.worker.next(), opId('order-phase-3'));
    expect(nextOfPhase?.workItemId).toBe(expectedFirst);
  });

  it('leases a system workitem with lease + system_command_started (no dispatch, no grant)', async () => {
    const env = await makeEnv();
    const taskId = tid('system');
    const result = await env.coordinator.createWorkItem({
      taskId,
      operationId: opId('create-system'),
      workItemId: 'wi-seal',
      kind: 'system_seal',
      roleBinding: null,
      agentExecutionKind: null,
      sessionKind: null,
      roundId: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      inputArtifactDeliveryId: null,
      payload: { kind: 'content_value', value: payloadObject('seal payload') },
      authorityBase: buildAuthorityBaseSet(baseInput(env, taskId, {
        kind: 'system_seal',
        agentExecutionKind: null,
        sessionKind: null,
      }, {
        mapRef: synthRef('map_snapshot', 14),
        mapReviewBundleRef: synthRef('map_review_bundle', 22),
        contentRevisionManifestRef: synthRef('content_revision_manifest', 15),
        reviewBundleRef: synthRef('review_bundle', 23),
      })),
      maxAutomaticRetries: 1,
    });
    void result;
    const leased = await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-seal'));
    expect(leased).not.toBeNull();
    expect(leased?.attemptId).toBeNull();
    expect(leased?.commandId).toMatch(/^cmd-/);
    expect(leased?.dispatchRef).toBeNull();
    expect(leased?.grantInstanceRef).toBeNull();
    const projection = await env.readProjection(taskId);
    expect(projection.activeLease?.commandId).toBe(leased?.commandId);
    const command = projection.attempts[String(leased?.commandId)];
    expect(command?.family).toBe('command');
    expect(command?.commandKind).toBe('seal');
  });

  it('creates a generic (submitter) workitem and REJECTS its lease until a delivery exists (seal chain is Task 13)', async () => {
    const env = await makeEnv();
    const taskId = tid('generic');
    const result = await env.coordinator.createWorkItem({
      taskId,
      operationId: opId('create-generic'),
      workItemId: 'wi-submitter',
      kind: 'agent_assignment',
      roleBinding: 'submitter',
      agentExecutionKind: 'generic_turn',
      sessionKind: null,
      roundId: null,
      logicalAssignmentId: 'la-submitter',
      reviewAssignmentId: null,
      inputArtifactDeliveryId: 'del-1',
      payload: { kind: 'content_value', value: payloadObject('submission') },
      authorityBase: buildAuthorityBaseSet(baseInput(env, taskId, {
        kind: 'agent_assignment',
        agentExecutionKind: 'generic_turn',
        sessionKind: null,
      }, {
        sealRecordRef: synthRef('seal_record', 30),
        artifactRef: synthRef('artifact', 31),
        artifactDeliveryRef: synthRef('system_artifact_delivery', 32),
      })),
      grantSpec: { build: (baseRef: BlobRefV2) => env.structureChunkGrantSpec(baseRef, synthRef('map_build_spec', 10)) },
      maxAutomaticRetries: 2,
    });
    void result;
    // The projector binds generic attempts to the CURRENT SystemArtifactDelivery
    // (delivery_unknown); no delivery exists until the Task 13 seal chain, so
    // the coordinator fails closed instead of committing a corrupting start —
    // and it fails BEFORE any lease preparation (no grant instance, no
    // dispatch, no pins).
    await expect(
      env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-generic')),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const projection = await env.readProjection(taskId);
    expect(projection.workItems['wi-submitter'].state).toBe('ready');
    expect(projection.activeLease).toBeNull();
  });

  it('signs a GrantInstance for a transactional write lease with a grant spec', async () => {
    const env = await makeEnv();
    const taskId = tid('grant-instance');
    const mapBuildSpecRef = await env.publishMapBuildSpec(taskId);
    const base = baseForStructure(env, taskId, mapBuildSpecRef);
    const created = await env.coordinator.createWorkItem({
      taskId,
      operationId: opId('create-write'),
      workItemId: 'wi-writer',
      kind: 'agent_assignment',
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
      logicalAssignmentId: 'la-writer',
      reviewAssignmentId: null,
      inputArtifactDeliveryId: null,
      payload: { kind: 'content_value', value: payloadObject('write payload') },
      authorityBase: base,
      grantSpec: { build: (baseRef) => env.structureChunkGrantSpec(baseRef, mapBuildSpecRef) },
      maxAutomaticRetries: 2,
    });
    const worker = env.worker.next();
    const leased = await env.coordinator.leaseNext(taskId, worker, opId('lease-write'));
    expect(leased?.grantInstanceRef?.kind).toBe('grant_instance');
    const instance = (await env.resolverFor(taskId)(leased?.grantInstanceRef as BlobRefV2)) as {
      grantSpecRef: BlobRefV2;
      workItemId: string;
      leaseEpoch: number;
      boundAttemptId: string;
      agentId: string;
    };
    expect(instance.grantSpecRef).toEqual(created.grantSpecRef);
    expect(instance.workItemId).toBe('wi-writer');
    expect(instance.leaseEpoch).toBe(1);
    expect(instance.boundAttemptId).toBe(leased?.attemptId);
    expect(instance.agentId).toBe(worker);
    const dispatch = (await env.resolverFor(taskId)(leased?.dispatchRef as BlobRefV2)) as {
      grantInstanceRef: BlobRefV2 | null;
    };
    expect(dispatch.grantInstanceRef).toEqual(leased?.grantInstanceRef);
  });

  it('resolves the two-lease CAS race: exactly one lease, the loser fails closed', async () => {
    const env = await makeEnv();
    const taskId = tid('race');
    await createAgentWorkItem(env, taskId, { logicalAssignmentId: 'la-race' });
    await createAgentWorkItem(env, taskId, { sessionKind: 'review_content_batch', logicalAssignmentId: 'la-race-2', reviewAssignmentId: 'ra-2' });
    // Two INDEPENDENT coordinator instances over the same data root.
    const second = await createWorkItemCoordinatorEnvironment({
      leaseDurationMs: 30 * 60 * 1000,
      paths: env.paths,
    });
    envs.push(second);
    const secondCoordinator = second.coordinator;
    const outcomes = await Promise.allSettled([
      env.coordinator.leaseNext(taskId, env.worker.next(), opId('race-a')),
      secondCoordinator.leaseNext(taskId, second.worker.next(), opId('race-b')),
    ]);
    const leased = outcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value !== null);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(leased.length).toBe(1);
    for (const outcome of rejected) {
      const error = outcome.reason as CoordinatorError;
      expect(error.code).toBe('STALE_TAIL');
    }
    // The task never carries two active leases — the full history projects clean.
    let projection = await env.readProjection(taskId);
    expect(projection.activeLease).not.toBeNull();
    expect(Object.values(projection.workItems).filter((wi) => wi.state === 'leased').length).toBe(1);
    // The loser can still claim the next workitem after the winner's lease is
    // released (single-lease rule) and a fresh projection.
    const winnerOutcome = outcomes.find(
      (o): o is PromiseFulfilledResult<LeasedWorkV2 | null> => o.status === 'fulfilled' && o.value !== null,
    );
    const winner = winnerOutcome?.value;
    expect(winner).toBeDefined();
    await env.coordinator.reclaimExpired(taskId, String(winner?.workItemId), opId('race-reclaim'), 'crash_recovery');
    projection = await env.readProjection(taskId);
    expect(Object.values(projection.workItems).filter((wi) => wi.state === 'leased').length).toBe(0);
    const next = await secondCoordinator.leaseNext(taskId, second.worker.next(), opId('race-c'));
    expect(next).not.toBeNull();
  });

  it('maps a facade tail conflict to the stable STALE_TAIL error', async () => {
    const stub: Pick<AuthoritativeAppendFacadeV2, 'prepareBlob' | 'publishWithPin' | 'commitStateOnly'> = {
      prepareBlob: async () => synthRef('authority_base_set', 9),
      publishWithPin: async () => {
        throw new StorageError(STORAGE_ERROR_CODES.EXPECTED_SEQUENCE_MISMATCH, 'stale', null, 'retry');
      },
      commitStateOnly: async () => {
        throw new StorageError(STORAGE_ERROR_CODES.EXPECTED_SEQUENCE_MISMATCH, 'stale', null, 'retry');
      },
    };
    const projection: AuthoritativeReviewProjectionV2 = {
      version: 2,
      workItems: {
        'wi-x': {
          workItemId: 'wi-x',
          kind: 'system_seal',
          roleBinding: null,
          agentExecutionKind: null,
          sessionKind: null,
          roundId: null,
          logicalAssignmentId: null,
          reviewAssignmentId: null,
          grantSpecRef: null,
          inputArtifactDeliveryId: null,
          authorityBaseRef: synthRef('authority_base_set', 1),
          payloadRef: synthRef('content_value', 2),
          leaseEpoch: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          attemptCount: 0,
          retryOrdinal: 0,
          retryNotBefore: null,
          maxAutomaticRetries: 1,
          state: 'ready',
          parkDisposition: null,
          leaseBases: {},
          terminalEventId: null,
        },
      },
      attempts: {},
      activeLease: null,
      pendingQuestion: null,
      retryBudgetExhaustedWorkItemId: null,
      suspension: null,
      mapBuilds: {},
      generationPlans: {},
      repairPlans: {},
      migrationValidationPlan: null,
      migrationBatchOrdinals: [],
      migrationSettled: false,
      currentCandidate: null,
      lastFinalizedBuildId: null,
      mapRounds: {},
      contentRounds: {},
      mapCycleOrdinal: 0,
      contentCycleOrdinal: 0,
      currentMap: null,
      activatedManifestBinding: null,
      currentManifest: null,
      findings: {},
      currentSeal: null,
      publishedArtifact: null,
      delivery: null,
      availableOverride: null,
      consumedOverrideRefs: [],
      failed: null,
      taskStatus: 'running',
      lastSequence: 0,
    };
    const checkpointStore = {
      readState: async () => ({ throughSequence: 0, projection, fold: {} as never, fromCheckpoint: false }),
    } as unknown as AuthoritativeReviewCheckpointStore;
    const resolver: BlobObjectResolver = () => undefined;
    const coordinator = new WorkItemCoordinatorV2({
      facade: stub as AuthoritativeAppendFacadeV2,
      checkpointStore,
      resolver: () => undefined,
      tail: async () => ({ lastSequence: 0, lastCommitId: null }),
      committedOperation: async () => null,
      clock: () => '2026-08-14T10:00:00.000Z',
      leaseDurationMs: 1000,
    });
    await expect(
      coordinator.leaseNext('task-x', 'worker-a', 'op-x'),
    ).rejects.toMatchObject({ code: 'STALE_TAIL' });
  });
}, 30_000);

describe('reclaimExpired — expiry, epochs, late results', () => {
  it('reclaims an EXPIRED lease with abandon + reclaim and advances the epoch', async () => {
    const env = await makeEnv();
    const taskId = tid('reclaim');
    const { workItemId } = await createAgentWorkItem(env, taskId);
    const leased = await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-1'));
    // Before expiry the coordinator refuses a lease_expired reclaim.
    await expect(
      env.coordinator.reclaimExpired(taskId, workItemId, opId('reclaim-early'), 'lease_expired'),
    ).rejects.toMatchObject({ code: 'LEASE_NOT_EXPIRED' });
    env.now.value = env.iso(31 * 60 * 1000);
    const reclaimed = await env.coordinator.reclaimExpired(taskId, workItemId, opId('reclaim-expired'), 'lease_expired');
    expect(reclaimed.previousEpoch).toBe(1);
    expect(reclaimed.reclaimedEpoch).toBe(2);
    const projection = await env.readProjection(taskId);
    const wi = projection.workItems[workItemId];
    expect(wi.state).toBe('ready');
    expect(wi.leaseEpoch).toBe(2);
    expect(wi.leaseOwner).toBeNull();
    expect(projection.activeLease).toBeNull();
    expect(projection.attempts[String(leased?.attemptId)]?.state).toBe('abandoned');
    // The next lease strictly advances again (epoch conventions).
    const nextLease = await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-2'));
    expect(nextLease?.leaseEpoch).toBe(3);
  });

  it('rejects LATE results after the reclaim without any partial write', async () => {
    const env = await makeEnv();
    const taskId = tid('late');
    const { workItemId } = await createAgentWorkItem(env, taskId);
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-1'));
    env.now.value = env.iso(31 * 60 * 1000);
    await env.coordinator.reclaimExpired(taskId, workItemId, opId('reclaim-1'), 'lease_expired');
    // The old-epoch failure arrives late: the coordinator rejects it.
    const attemptIdFor3 = (await env.readProjection(taskId)).activeLease?.attemptId ?? undefined;
    await expect(
      env.coordinator.recordRetryableFailure({
        taskId,
        operationId: opId('late-fail'),
        workItemId,
        attemptId: attemptIdFor3,
        failureCode: 'HANDLER_FAILED',
        failureDigest: 'f'.repeat(64),
        retryNotBefore: env.iso(-1000),
      }),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_LEASED' });
    const projection = await env.readProjection(taskId);
    expect(projection.workItems[workItemId].state).toBe('ready');
    expect(projection.workItems[workItemId].retryOrdinal).toBe(0);
  });

  it('allows crash_recovery reclaims anytime (startup recovery path) with the abandon reason carried', async () => {
    const env = await makeEnv();
    const taskId = tid('crash');
    const { workItemId } = await createAgentWorkItem(env, taskId);
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-1'));
    const reclaimed = await env.coordinator.reclaimExpired(taskId, workItemId, opId('reclaim-crash'), 'crash_recovery');
    expect(reclaimed.reclaimedEpoch).toBe(2);
    const projection = await env.readProjection(taskId);
    const attempt = Object.values(projection.attempts)[0];
    expect(attempt).toBeDefined();
    // _reason is not stored on the attempt projection; the events carry it.
    const events = await env.eventStore.read(taskId);
    const abandoned = events.find((entry) => entry.event.type === 'structured_agent_attempt_abandoned_v2') as
      | { event: AuthoritativeReviewEventV2 & { type: 'structured_agent_attempt_abandoned_v2' } }
      | undefined;
    expect(abandoned?.event.reason).toBe('crash_recovery');
    const reclaimedEvent = events.find((entry) => entry.event.type === 'structured_work_item_lease_reclaimed') as
      | { event: AuthoritativeReviewEventV2 & { type: 'structured_work_item_lease_reclaimed' } }
      | undefined;
    expect(reclaimedEvent?.event.reason).toBe('crash_recovery');
    expect(reclaimedEvent?.event.leaseEpoch).toBe(1);
  });

  it('rejects reclaims of unknown or non-leased workitems', async () => {
    const env = await makeEnv();
    const taskId = tid('reclaim-bad');
    const { workItemId } = await createAgentWorkItem(env, taskId);
    await expect(
      env.coordinator.reclaimExpired(taskId, 'wi-nonexistent', opId('reclaim-ghost'), 'crash_recovery'),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_FOUND' });
    await expect(
      env.coordinator.reclaimExpired(taskId, workItemId, opId('reclaim-notleased'), 'crash_recovery'),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_LEASED' });
  });
});

describe('recordRetryableFailure / requeueDue / manualRetry — ordinals, budgets, wakeups', () => {
  it('records a retryable failure with the ordinal bump and server-side retryNotBefore', async () => {
    const env = await makeEnv();
    const taskId = tid('retryable');
    const { workItemId } = await createAgentWorkItem(env, taskId, { maxAutomaticRetries: 2 });
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-1'));
    const attemptIdFor4 = (await env.readProjection(taskId)).activeLease?.attemptId ?? undefined;
    const result = await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: opId('fail-1'),
      workItemId,
      attemptId: attemptIdFor4,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'f'.repeat(64),
      retryNotBefore: env.iso(5000),
    });
    expect(result).toMatchObject({
      mode: 'retryable',
      retryOrdinal: 1,
      retryNotBefore: env.iso(5000),
      wakeup: { kind: 'retry_due', at: env.iso(5000) },
    });
    const projection = await env.readProjection(taskId);
    const wi = projection.workItems[workItemId];
    expect(wi.state).toBe('retryable_failed');
    expect(wi.retryOrdinal).toBe(1);
    expect(wi.retryNotBefore).toBe(env.iso(5000));
    expect(projection.activeLease).toBeNull();
    // the attempt carried the same ordinal + base
    const attempt = Object.values(projection.attempts)[0];
    expect(attempt?.state).toBe('retryable_failed');
  });

  it('carries a prepared validator aggregate ref when the failure comes from a validator', async () => {
    const env = await makeEnv();
    const taskId = tid('validator');
    const { workItemId } = await createAgentWorkItem(env, taskId);
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-1'));
    const aggregateInputRef = synthRef('validator_input_envelope', 40);
    const aggregateWithoutDigest = {
      trigger: 'map_candidate_commit',
      executionPhase: null,
      inputRef: aggregateInputRef,
      inputDigest: aggregateInputRef.digest,
      registrationSetDigest: 'b'.repeat(64),
      validExecutionDigests: [],
      blockingInvalidReceiptRefs: [],
      advisoryReceiptRefs: [],
      infrastructureFailureRefs: [],
      warningRootRef: synthRef('validation_warning_root', 41),
      outcome: 'clear',
    };
    const aggregateObject = {
      ...aggregateWithoutDigest,
      aggregateDigest: canonicalJsonSha256(aggregateWithoutDigest),
    };
    const aggregate = await env.facade.prepareBlob(taskId, 'validator_aggregate', aggregateObject);
    const attemptIdFor5 = (await env.readProjection(taskId)).activeLease?.attemptId ?? undefined;
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: opId('fail-validator'),
      workItemId,
      attemptId: attemptIdFor5,
      failureCode: 'VALIDATOR_INFRASTRUCTURE',
      failureDigest: 'a'.repeat(64),
      validatorAggregateRef: aggregate,
      retryNotBefore: env.iso(5000),
    });
    const events = await env.eventStore.read(taskId);
    const attemptFailed = events.find((entry) => entry.event.type === 'structured_agent_attempt_retryable_failed_v2') as
      | { event: AuthoritativeReviewEventV2 & { type: 'structured_agent_attempt_retryable_failed_v2' } }
      | undefined;
    expect(attemptFailed?.event.validatorAggregateRef).toEqual(aggregate);
    const wiFailed = events.find((entry) => entry.event.type === 'structured_work_item_retryable_failed') as
      | { event: AuthoritativeReviewEventV2 & { type: 'structured_work_item_retryable_failed' } }
      | undefined;
    expect(wiFailed?.event.validatorAggregateRef).toEqual(aggregate);
  });

  it('refuses to requeue before the retryNotBefore timer, then requeues with the CURRENT epoch', async () => {
    const env = await makeEnv();
    const taskId = tid('requeue');
    const { workItemId } = await createAgentWorkItem(env, taskId);
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-1'));
    const attemptIdFor6 = (await env.readProjection(taskId)).activeLease?.attemptId ?? undefined;
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: opId('fail-1'),
      workItemId,
      attemptId: attemptIdFor6,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'f'.repeat(64),
      retryNotBefore: env.iso(5000),
    });
    await expect(
      env.coordinator.requeueDue(taskId, workItemId, opId('requeue-early')),
    ).rejects.toMatchObject({ code: 'RETRY_NOT_DUE' });
    env.now.value = env.iso(5001);
    const requeued = await env.coordinator.requeueDue(taskId, workItemId, opId('requeue-due'));
    expect(requeued.leaseEpoch).toBe(1); // requeue does NOT advance the epoch
    const projection = await env.readProjection(taskId);
    expect(projection.workItems[workItemId].state).toBe('ready');
    expect(projection.workItems[workItemId].leaseEpoch).toBe(1);
    // a lease after requeue strictly advances
    const nextLease = await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-2'));
    expect(nextLease?.leaseEpoch).toBe(2);
    // requeue of a ready workitem is rejected
    await expect(
      env.coordinator.requeueDue(taskId, workItemId, opId('requeue-again')),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_RETRYABLE' });
  });

  it('parks on budget exhaustion (attempt terminal + park), then manual retry resumes with epoch + 1', async () => {
    const env = await makeEnv();
    const taskId = tid('budget');
    const { workItemId } = await createAgentWorkItem(env, taskId, { maxAutomaticRetries: 1 });
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-1'));
    const attemptIdFor7 = (await env.readProjection(taskId)).activeLease?.attemptId ?? undefined;
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: opId('fail-1'),
      workItemId,
      attemptId: attemptIdFor7,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'f'.repeat(64),
      retryNotBefore: env.iso(-1000),
    });
    await env.coordinator.requeueDue(taskId, workItemId, opId('requeue-1'));
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-2'));
    const attemptIdFor8 = (await env.readProjection(taskId)).activeLease?.attemptId ?? undefined;
    const second = await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: opId('fail-2'),
      workItemId,
      attemptId: attemptIdFor8,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'f'.repeat(64),
      retryNotBefore: env.iso(-1000),
    });
    expect(second.mode).toBe('parked');
    if (second.mode === 'parked') {
      expect(second.retryOrdinal).toBe(2);
      expect(second.parkDisposition).toEqual({
        kind: 'retry_budget_exhausted',
        retryOrdinal: 2,
        budgetPolicyDigest: dispositionDigest(workItemId, 2, 'HANDLER_FAILED'),
      });
    }
    let projection = await env.readProjection(taskId);
    expect(projection.taskStatus).toBe('retryable_failure');
    expect(projection.retryBudgetExhaustedWorkItemId).toBe(workItemId);
    expect(projection.workItems[workItemId].state).toBe('parked');
    expect(projection.workItems[workItemId].parkDisposition?.kind).toBe('retry_budget_exhausted');
    // the terminal attempt precedes the park in one envelope
    const events = await env.eventStore.read(taskId);
    const batch = events.filter((entry) => entry.event.type === 'structured_work_item_parked');
    expect(batch).toHaveLength(1);
    // manual retry: resume event carries the NEW epoch
    const resumed = await env.coordinator.manualRetry(taskId, workItemId, opId('manual-retry'));
    expect(resumed.nextEpoch).toBe(3);
    projection = await env.readProjection(taskId);
    expect(projection.workItems[workItemId].state).toBe('ready');
    expect(projection.workItems[workItemId].leaseEpoch).toBe(3);
    expect(projection.workItems[workItemId].retryOrdinal).toBe(0);
    expect(projection.retryBudgetExhaustedWorkItemId).toBeNull();
    const lease = await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-3'));
    expect(lease?.leaseEpoch).toBe(4);
  });

  it('rejects manual retry of non-budget-parked and human-parked workitems', async () => {
    const env = await makeEnv();
    const taskId = tid('manual-bad');
    const { workItemId, authorityBaseRef } = await createAgentWorkItem(env, taskId);
    await expect(
      env.coordinator.manualRetry(taskId, workItemId, opId('manual-ready')),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_BUDGET_PARKED' });
    // seed a human-question park through the legal foreign-committer seam
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-1'));
    const leasedBefore = await env.readProjection(taskId);
    const boundAttemptId = leasedBefore.activeLease?.attemptId ?? 'att-raw-1';
    await rawAppend(env, taskId, opId('raw-question'), [
      {
        type: 'structured_human_question_opened_v2',
        questionId: 'q-1',
        questionVersion: 'A'.repeat(43),
        questionDigest: 'd'.repeat(64),
        originalWorkItemId: workItemId,
        attemptId: boundAttemptId,
        leaseEpoch: 1,
        logicalAssignmentId: `la-${workItemId}`,
        authorityBaseRef,
      },
      {
        type: 'structured_agent_attempt_terminal_failed_v2',
        workItemId,
        logicalAssignmentId: `la-${workItemId}`,
        reviewAssignmentId: null,
        attemptId: boundAttemptId,
        sessionKind: 'structure_chunk',
        leaseEpoch: 1,
        failureCode: 'HUMAN_INTERVENTION',
        failureDigest: 'f'.repeat(64),
        validatorAggregateRef: null,
        authorityBaseRef,
      },
      {
        type: 'structured_work_item_parked',
        workItemId,
        leaseEpoch: 1,
        parkDisposition: { kind: 'human_question', questionId: 'q-1', questionVersion: 'A'.repeat(43) },
        authorityBaseRef,
      },
    ]);
    const projection = await env.readProjection(taskId);
    expect(projection.taskStatus).toBe('waiting_human');
    await expect(
      env.coordinator.manualRetry(taskId, workItemId, opId('manual-human')),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_BUDGET_PARKED' });
    // double failure discipline: recordRetryableFailure on a non-leased workitem
    const attemptIdFor9 = (await env.readProjection(taskId)).activeLease?.attemptId ?? undefined;
    await expect(
      env.coordinator.recordRetryableFailure({
        taskId,
        operationId: opId('fail-human'),
        workItemId,
        attemptId: attemptIdFor9,
        failureCode: 'X',
        failureDigest: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_LEASED' });
  });

  it('records failures with the system-command attempt family', async () => {
    const env = await makeEnv();
    const taskId = tid('cmd-retry');
    await env.coordinator.createWorkItem({
      taskId,
      operationId: opId('create-cmd'),
      workItemId: 'wi-cmd',
      kind: 'system_generation_finalize',
      roleBinding: null,
      agentExecutionKind: null,
      sessionKind: null,
      roundId: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      inputArtifactDeliveryId: null,
      payload: { kind: 'content_value', value: payloadObject('cmd') },
      authorityBase: buildAuthorityBaseSet(baseInput(env, taskId, {
        kind: 'system_generation_finalize',
        agentExecutionKind: null,
        sessionKind: null,
      }, {
        mapRef: synthRef('map_snapshot', 14),
        contentRevisionManifestRef: synthRef('content_revision_manifest', 15),
        planSpecRef: synthRef('generation_plan_spec', 16),
      })),
      maxAutomaticRetries: 1,
    });
    const leased = await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-cmd'));
    expect(leased?.commandId).toMatch(/^cmd-/);
    const result = await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: opId('fail-cmd'),
      workItemId: 'wi-cmd',
      commandId: leased?.commandId ?? undefined,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'a'.repeat(64),
      retryNotBefore: env.iso(1000),
    });
    expect(result.mode).toBe('retryable');
    const events = await env.eventStore.read(taskId);
    const commandFailed = events.find((entry) => entry.event.type === 'structured_system_command_retryable_failed') as
      | { event: AuthoritativeReviewEventV2 & { type: 'structured_system_command_retryable_failed' } }
      | undefined;
    expect(commandFailed?.event.commandKind).toBe('generation_finalize');
    expect(commandFailed?.event.commandId).toBe(leased?.commandId);
  });
}, 30_000);

describe('completeWorkItem — Task 12 success terminal (M-6 direct unit tests)', () => {
  async function resultRef(env: WorkItemCoordinatorEnvironment, taskId: string): Promise<BlobRefV2> {
    return env.facade.prepareBlob(taskId, 'content_value', payloadObject('domain result'));
  }

  it('completes a leased structured attempt with [attempt_completed_v2, work_item_completed] in ONE ordered batch', async () => {
    const env = await makeEnv();
    const taskId = tid('complete');
    const { workItemId } = await createAgentWorkItem(env, taskId);
    const leased = await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-1'));
    const ref = await resultRef(env, taskId);
    const completed = await env.coordinator.completeWorkItem({
      taskId,
      operationId: opId('complete-1'),
      workItemId,
      attemptId: leased?.attemptId ?? undefined,
      resultRefs: [ref],
    });
    expect(completed.replayed).toBe(false);
    expect(completed.attemptFamily).toBe('structured');
    // Envelope order: the attempt terminal precedes the workitem completion.
    const types = completed.events.map((entry) => entry.event.type);
    const iAttempt = types.indexOf('structured_agent_attempt_completed_v2');
    const iWorkItem = types.indexOf('structured_work_item_completed');
    expect(iAttempt).toBeGreaterThanOrEqual(0);
    expect(iWorkItem).toBe(iAttempt + 1);
    const projection = await env.readProjection(taskId);
    expect(projection.workItems[workItemId].state).toBe('completed');
    expect(projection.activeLease).toBeNull();
    expect(projection.attempts[String(leased?.attemptId)].state).toBe('completed');
  });

  it('completes a leased SYSTEM COMMAND workitem with [command_completed, work_item_completed]', async () => {
    const env = await makeEnv();
    const taskId = tid('cmd-complete');
    await env.coordinator.createWorkItem({
      taskId,
      operationId: opId('create-cmd'),
      workItemId: 'wi-cmd',
      kind: 'system_map_finalize',
      roleBinding: null,
      agentExecutionKind: null,
      sessionKind: null,
      roundId: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      inputArtifactDeliveryId: null,
      payload: { kind: 'content_value', value: payloadObject('cmd') },
      authorityBase: buildAuthorityBaseSet(baseInput(env, taskId, {
        kind: 'system_map_finalize',
        agentExecutionKind: null,
        sessionKind: null,
      }, { planSpecRef: synthRef('map_build_spec', 10) })),
      maxAutomaticRetries: 2,
    });
    const leased = await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-cmd'));
    expect(leased?.commandId).toMatch(/^cmd-/);
    const ref = await resultRef(env, taskId);
    const completed = await env.coordinator.completeWorkItem({
      taskId,
      operationId: opId('complete-cmd'),
      workItemId: 'wi-cmd',
      commandId: leased?.commandId ?? undefined,
      resultRefs: [ref],
    });
    expect(completed.attemptFamily).toBe('command');
    const types = completed.events.map((entry) => entry.event.type);
    expect(types).toContain('structured_system_command_completed');
    expect(types).toContain('structured_work_item_completed');
    const projection = await env.readProjection(taskId);
    expect(projection.workItems['wi-cmd'].state).toBe('completed');
  });

  it('replays the ORIGINAL completion on response loss (same operation id, same result)', async () => {
    const env = await makeEnv();
    const taskId = tid('complete-replay');
    const { workItemId } = await createAgentWorkItem(env, taskId);
    const leased = await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-1'));
    const ref = await resultRef(env, taskId);
    const operationId = opId('complete-replay-op');
    const input = {
      taskId,
      operationId,
      workItemId,
      attemptId: leased?.attemptId ?? undefined,
      resultRefs: [ref],
    };
    const first = await env.coordinator.completeWorkItem(input);
    const second = await env.coordinator.completeWorkItem(input);
    expect(second.replayed).toBe(true);
    expect(second.events.map((entry) => entry.event.id)).toEqual(first.events.map((entry) => entry.event.id));
    expect((await env.eventStore.read(taskId)).filter((e) => e.event.type === 'structured_work_item_completed')).toHaveLength(1);
  });

  it('rejects a bare completion of a gated kind with ZERO writes (§9.2 I-2)', async () => {
    const env = await makeEnv();
    const taskId = tid('bare');
    const { workItemId } = await createAgentWorkItem(env, taskId);
    const leased = await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-1'));
    const before = (await env.eventStore.read(taskId)).length;
    await expect(
      env.coordinator.completeWorkItem({
        taskId,
        operationId: opId('bare-complete'),
        workItemId,
        attemptId: leased?.attemptId ?? undefined,
        resultRefs: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await env.eventStore.read(taskId)).length).toBe(before);
    const projection = await env.readProjection(taskId);
    expect(projection.workItems[workItemId].state).toBe('leased');
  });

  it('I-1: rejects a stale completion naming a PREVIOUS attempt after reclaim+re-lease (ZERO writes)', async () => {
    const env = await makeEnv();
    const taskId = tid('stale');
    const { workItemId } = await createAgentWorkItem(env, taskId);
    const leaseA = await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-a'));
    env.now.value = env.iso(31 * 60 * 1000);
    await env.coordinator.reclaimExpired(taskId, workItemId, opId('reclaim-1'), 'lease_expired');
    const leaseB = await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-b'));
    expect(leaseB?.attemptId).not.toBe(leaseA?.attemptId);
    const before = (await env.eventStore.read(taskId)).length;
    const ref = await resultRef(env, taskId);
    await expect(
      env.coordinator.completeWorkItem({
        taskId,
        operationId: opId('stale-complete'),
        workItemId,
        attemptId: leaseA?.attemptId ?? undefined,
        resultRefs: [ref],
      }),
    ).rejects.toMatchObject({ code: 'ATTEMPT_MISMATCH' });
    expect((await env.eventStore.read(taskId)).length).toBe(before);
    const projection = await env.readProjection(taskId);
    expect(projection.activeLease?.attemptId).toBe(leaseB?.attemptId);
  });
});

describe('suspension overlay — applySuspension / clearSuspension', () => {
  it('applies and clears an overlay without touching the underlying WorkItem state', async () => {
    const env = await makeEnv();
    const taskId = tid('suspend');
    const { workItemId } = await createAgentWorkItem(env, taskId);
    const suspended = await env.coordinator.applySuspension(taskId, opId('stop-1'), 'user_stop');
    expect(suspended.suspensionId).toMatch(/^susp-/);
    let projection = await env.readProjection(taskId);
    expect(projection.taskStatus).toBe('stopped');
    expect(projection.suspension?.reason).toBe('user_stop');
    expect(projection.workItems[workItemId]?.state).toBe('ready');
    // second stop while suspended
    await expect(
      env.coordinator.applySuspension(taskId, opId('stop-2'), 'user_stop'),
    ).rejects.toMatchObject({ code: 'TASK_SUSPENDED' });
    // clear with the exact overlay
    const cleared = await env.coordinator.clearSuspension(taskId, opId('resume-1'));
    expect(cleared.suspensionId).toBe(suspended.suspensionId);
    projection = await env.readProjection(taskId);
    expect(projection.taskStatus).toBe('running');
    expect(projection.suspension).toBeNull();
    await expect(
      env.coordinator.clearSuspension(taskId, opId('resume-2')),
    ).rejects.toMatchObject({ code: 'TASK_NOT_SUSPENDED' });
    // wrong suspension id
    await env.coordinator.applySuspension(taskId, opId('stop-3'), 'operator_interrupt');
    await expect(
      env.coordinator.clearSuspension(taskId, opId('resume-3'), 'susp-wrong'),
    ).rejects.toMatchObject({ code: 'SUSPENSION_CONFLICT' });
    projection = await env.readProjection(taskId);
    expect(projection.taskStatus).toBe('interrupted');
    expect(projection.suspension?.reason).toBe('operator_interrupt');
  });

  it('stop over a budget-exhausted park: resume NEVER clears the budget disposition', async () => {
    const env = await makeEnv();
    const taskId = tid('suspend-budget');
    const { workItemId } = await createAgentWorkItem(env, taskId, { maxAutomaticRetries: 1 });
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-1'));
    const attemptIdFor11 = (await env.readProjection(taskId)).activeLease?.attemptId ?? undefined;
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: opId('fail-1'),
      workItemId,
      attemptId: attemptIdFor11,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'f'.repeat(64),
      retryNotBefore: env.iso(-1000),
    });
    await env.coordinator.requeueDue(taskId, workItemId, opId('requeue-1'));
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-2'));
    const attemptIdFor12 = (await env.readProjection(taskId)).activeLease?.attemptId ?? undefined;
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: opId('fail-2'),
      workItemId,
      attemptId: attemptIdFor12,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'f'.repeat(64),
      retryNotBefore: env.iso(-1000),
    });
    await env.coordinator.applySuspension(taskId, opId('stop-over-park'), 'user_stop');
    let projection = await env.readProjection(taskId);
    expect(projection.taskStatus).toBe('stopped');
    expect(projection.retryBudgetExhaustedWorkItemId).toBe(workItemId);
    await env.coordinator.clearSuspension(taskId, opId('resume-over-park'));
    projection = await env.readProjection(taskId);
    expect(projection.taskStatus).toBe('retryable_failure');
    expect(projection.workItems[workItemId].state).toBe('parked');
    expect(projection.workItems[workItemId].parkDisposition?.kind).toBe('retry_budget_exhausted');
    // only the v2 manual-retry command releases the budget park
    await env.coordinator.manualRetry(taskId, workItemId, opId('manual-after-resume'));
    projection = await env.readProjection(taskId);
    expect(projection.workItems[workItemId].state).toBe('ready');
  });

  it('stop over a retryable failure: overlay hides it, resume restores it', async () => {
    const env = await makeEnv();
    const taskId = tid('suspend-retryable');
    const { workItemId } = await createAgentWorkItem(env, taskId);
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-1'));
    const attemptIdFor13 = (await env.readProjection(taskId)).activeLease?.attemptId ?? undefined;
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: opId('fail-1'),
      workItemId,
      attemptId: attemptIdFor13,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'f'.repeat(64),
      retryNotBefore: env.iso(5000),
    });
    await env.coordinator.applySuspension(taskId, opId('stop-1'), 'user_stop');
    let projection = await env.readProjection(taskId);
    expect(projection.taskStatus).toBe('stopped');
    await env.coordinator.clearSuspension(taskId, opId('resume-1'));
    projection = await env.readProjection(taskId);
    expect(projection.taskStatus).toBe('running');
    expect(projection.workItems[workItemId].state).toBe('retryable_failed');
    expect(projection.workItems[workItemId].retryNotBefore).toBe(env.iso(5000));
  });

  it('stop over a human-question park: resume returns to waiting_human and never releases the disposition', async () => {
    const env = await makeEnv();
    const taskId = tid('suspend-human');
    const { workItemId, authorityBaseRef } = await createAgentWorkItem(env, taskId);
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-1'));
    const leasedBefore = await env.readProjection(taskId);
    const boundAttemptId = leasedBefore.activeLease?.attemptId ?? 'att-raw-1';
    await rawAppend(env, taskId, opId('raw-question'), [
      {
        type: 'structured_human_question_opened_v2',
        questionId: 'q-1',
        questionVersion: 'A'.repeat(43),
        questionDigest: 'd'.repeat(64),
        originalWorkItemId: workItemId,
        attemptId: boundAttemptId,
        leaseEpoch: 1,
        logicalAssignmentId: `la-${workItemId}`,
        authorityBaseRef,
      },
      {
        type: 'structured_agent_attempt_terminal_failed_v2',
        workItemId,
        logicalAssignmentId: `la-${workItemId}`,
        reviewAssignmentId: null,
        attemptId: boundAttemptId,
        sessionKind: 'structure_chunk',
        leaseEpoch: 1,
        failureCode: 'HUMAN_INTERVENTION',
        failureDigest: 'f'.repeat(64),
        validatorAggregateRef: null,
        authorityBaseRef,
      },
      {
        type: 'structured_work_item_parked',
        workItemId,
        leaseEpoch: 1,
        parkDisposition: { kind: 'human_question', questionId: 'q-1', questionVersion: 'A'.repeat(43) },
        authorityBaseRef,
      },
    ]);
    await env.coordinator.applySuspension(taskId, opId('stop-human'), 'user_stop');
    let projection = await env.readProjection(taskId);
    expect(projection.taskStatus).toBe('stopped');
    expect(projection.pendingQuestion).not.toBeNull();
    await env.coordinator.clearSuspension(taskId, opId('resume-human'));
    projection = await env.readProjection(taskId);
    expect(projection.taskStatus).toBe('waiting_human');
    expect(projection.pendingQuestion?.questionId).toBe('q-1');
    expect(projection.workItems[workItemId].state).toBe('parked');
    expect(projection.workItems[workItemId].parkDisposition?.kind).toBe('human_question');
  });

  it('allows stop while a lease is active (the overlay-only primitive; lease cleanup is Task 11 composition)', async () => {
    const env = await makeEnv();
    const taskId = tid('suspend-lease');
    await createAgentWorkItem(env, taskId);
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-1'));
    await env.coordinator.applySuspension(taskId, opId('stop-1'), 'user_stop');
    const projection = await env.readProjection(taskId);
    expect(projection.taskStatus).toBe('stopped');
    expect(projection.activeLease).not.toBeNull();
  });
});

describe('response-loss idempotency across methods', () => {
  it('replays the identical lease for the same operation+payload, never a second lease', async () => {
    const env = await makeEnv();
    const taskId = tid('idem-lease');
    const { workItemId } = await createAgentWorkItem(env, taskId);
    const operationId = opId('lease-idem');
    const first = await env.coordinator.leaseNext(taskId, 'worker-a', operationId);
    const second = await env.coordinator.leaseNext(taskId, 'worker-a', operationId);
    expect(first).toEqual(second);
    // A DIFFERENT worker under the same operation is a different payload -> conflict.
    await expect(env.coordinator.leaseNext(taskId, 'worker-b', operationId)).rejects.toMatchObject({
      code: 'OPERATION_CONFLICT',
    });
    const projection = await env.readProjection(taskId);
    expect(projection.activeLease?.leaseOwner).toBe('worker-a');
    expect(Object.values(projection.attempts).filter((attempt) => attempt.state === 'started')).toHaveLength(1);
  });

  it('replays the identical retryable failure and suspension under the same operationId', async () => {
    const env = await makeEnv();
    const taskId = tid('idem-mixed');
    const { workItemId } = await createAgentWorkItem(env, taskId);
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-1'));
    const failOp = opId('fail-idem');
    const attemptIdFor14 = (await env.readProjection(taskId)).activeLease?.attemptId ?? undefined;
    const first = await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: failOp,
      workItemId,
      attemptId: attemptIdFor14,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'f'.repeat(64),
    });
    const attemptIdFor15 = (await env.readProjection(taskId)).activeLease?.attemptId ?? undefined;
    const second = await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: failOp,
      workItemId,
      attemptId: attemptIdFor15,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'f'.repeat(64),
    });
    if (first.mode !== 'retryable' || second.mode !== 'retryable') {
      expect.unreachable('both operations must be retryable-mode failures');
    }
    expect(second.retryOrdinal).toBe(first.retryOrdinal);
    expect(second.retryNotBefore).toBe(first.retryNotBefore);
    const projection = await env.readProjection(taskId);
    expect(projection.workItems[workItemId].retryOrdinal).toBe(1);
    expect(Object.values(projection.attempts).filter((attempt) => attempt.state === 'retryable_failed')).toHaveLength(1);
    const stopOp = opId('stop-idem');
    const s1 = await env.coordinator.applySuspension(taskId, stopOp, 'user_stop');
    const s2 = await env.coordinator.applySuspension(taskId, stopOp, 'user_stop');
    expect(s2.suspensionId).toBe(s1.suspensionId);
  });

  it('conflicts when the same reclaim/retry operationId carries a different payload', async () => {
    const env = await makeEnv();
    const taskId = tid('idem-conflict');
    const { workItemId } = await createAgentWorkItem(env, taskId);
    await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-1'));
    env.now.value = env.iso(31 * 60 * 1000);
    const reclaimOp = opId('reclaim-idem');
    await env.coordinator.reclaimExpired(taskId, workItemId, reclaimOp, 'lease_expired');
    // same op, different reason -> conflict
    await expect(
      env.coordinator.reclaimExpired(taskId, workItemId, reclaimOp, 'crash_recovery'),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    const projection = await env.readProjection(taskId);
    expect(projection.workItems[workItemId].state).toBe('ready');
    expect(projection.workItems[workItemId].leaseEpoch).toBe(2);
  });

  it('never creates a second logical successor after response loss', async () => {
    const env = await makeEnv();
    const taskId = tid('idem-successor');
    const { workItemId } = await createAgentWorkItem(env, taskId);
    const leaseOp = opId('lease-successor');
    const worker = env.worker.next();
    const leased = await env.coordinator.leaseNext(taskId, worker, leaseOp);
    // response loss: replay the same op with the SAME worker after a start
    const replay = await env.coordinator.leaseNext(taskId, worker, leaseOp);
    expect(replay).toEqual(leased);
    let projection = await env.readProjection(taskId);
    const leasedCount = () =>
      Object.values(projection.workItems).filter((wi) => wi.state === 'leased').length;
    expect(leasedCount()).toBe(1);
    expect(Object.keys(projection.workItems)).toHaveLength(1);
    // claim the next ready workitem with a DIFFERENT op -> a second lease is
    // correctly blocked while the first lease is active, and a fresh attempt
    // never appears for the same cycle.
    expect(await env.coordinator.leaseNext(taskId, env.worker.next(), opId('lease-other'))).toBeNull();
    projection = await env.readProjection(taskId);
    expect(leasedCount()).toBe(1);
  });
});

describe('constraint A evidence — half-state lease pins are rejected at admission', () => {
  it('rejects a work_item_leased pin whose attemptFamily is null (projector-legal half state, §9.2)', async () => {
    const env = await makeEnv();
    const taskId = tid('half-state');
    const baseRef = await env.facade.prepareBlob(
      taskId,
      'authority_base_set',
      buildAuthorityBaseSet(baseInput(env, taskId, {}, { planSpecRef: synthRef('map_build_spec', 10) })),
    );
    const payload: Record<string, unknown> = {
      family: 'lease_or_retry',
      operationId: 'op-half-state',
      taskId,
      workItemId: 'wi-half',
      leaseEpoch: 1,
      eventBuilder: 'work_item_leased',
      authorityBaseRef: baseRef,
      kind: 'agent_assignment',
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
      roundId: null,
      logicalAssignmentId: 'la-half',
      reviewAssignmentId: null,
      grantSpecRef: null,
      inputArtifactDeliveryId: null,
      payloadRef: baseRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries: 2,
      leaseOwner: 'worker-a',
      leaseExpiresAt: env.iso(1800000),
      expectedLastSequence: 0,
      attemptFamily: null,
      attemptId: null,
      commandId: null,
      agentId: null,
      commandKind: null,
      dispatchRef: null,
      grantInstanceRef: null,
      reason: null,
      failureCode: null,
      failureDigest: null,
      retryOrdinal: null,
      retryNotBefore: null,
      validatorAggregateRef: null,
      budgetPolicyDigest: null,
      failureRecoveryPayloadRef: null,
      taskFailure: null,
      resultRefs: [],
    };
    await expect(
      env.facade.publishWithPin({
        taskId,
        operationId: 'op-half-state',
        payload,
        intent: { handlerKind: 'work_item_leased', handlerVersion: 1 },
        preparedRefs: [baseRef],
        expectedTailSequence: 0,
        expectedTailCommitId: null,
      }),
    ).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.EVENT_INVALID });
    // Nothing was committed: the half state never enters the ledger.
    expect(await env.eventStore.read(taskId)).toEqual([]);
  });
});

describe('constraint A evidence — rebuildable intents through startup recovery', () => {
  it('resumes a crashed-but-legal suspension pin BYTE-IDENTICALLY through startupRecovery', async () => {
    const env = await makeEnv();
    const taskId = tid('startup');
    await createAgentWorkItem(env, taskId);
    const tail = await env.eventStore.tail(taskId);
    // Crash seam: a legal uncommitted pin for a Task 10 committed family
    // (`lifecycle/stop` — rebuildable after the payload union extension).
    const pendingOperationId = opId('s-pending-stop');
    await env.facade.preparePublication({
      taskId,
      operationId: pendingOperationId,
      payload: {
        family: 'lifecycle',
        operationId: pendingOperationId,
        taskId,
        kind: 'stop',
        suspensionId: 'susp-pending',
        workItemId: null,
        reason: 'user_stop',
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
      intent: { handlerKind: 'lifecycle/stop', handlerVersion: 1 },
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    const summary = await env.facade.startupRecovery();
    expect(summary.abandoned).toEqual([]);
    expect(summary.resumed).toHaveLength(1);
    // The resumed commit is byte-identical: suspension projection matches the
    // pending pin's deterministic identity.
    const projection = await env.readProjection(taskId);
    expect(projection.taskStatus).toBe('stopped');
    expect(projection.suspension?.suspensionId).toBe('susp-pending');
    expect(projection.suspension?.reason).toBe('user_stop');
    const batch = await env.eventStore.readBatchByCommitId(taskId, pendingOperationId);
    expect(batch).not.toBeNull();
    expect(batch?.[0]?.event.id).toMatch(/^evt-[0-9a-f]{32}$/);
  });
});

describe('GrantInstance admission — generic submitters never sign write grants (§17.2)', () => {
  it('signs ONLY structured write sessions with a grant spec', () => {
    expect(shouldSignGrantInstance('structure_chunk', true)).toBe(true);
    expect(shouldSignGrantInstance('generation_batch', true)).toBe(true);
    expect(shouldSignGrantInstance('map_repair', true)).toBe(true);
    expect(shouldSignGrantInstance('content_repair', true)).toBe(true);
    // Submitters (generic_turn, sessionKind null) carry a grant ref on the
    // created event only because the frozen validator demands one — their
    // lease never signs a structured-slot write grant.
    expect(shouldSignGrantInstance(null, true)).toBe(false);
    // Review/observation sessions have no write grant either.
    expect(shouldSignGrantInstance('review_map_batch', true)).toBe(false);
    expect(shouldSignGrantInstance('review_content_whole', true)).toBe(false);
    // No grant spec -> never sign.
    expect(shouldSignGrantInstance('structure_chunk', false)).toBe(false);
  });
});

describe('deterministic identities and full-history replay equivalence', () => {
  it('reproduces identical deterministic identity sets across a full composite history', async () => {
    const env = await makeEnv();
    const taskId = tid('determinism');
    const { workItemId } = await createAgentWorkItem(env, taskId, { maxAutomaticRetries: 1 });
    const operationIds = {
      lease1: opId('d-lease-1'),
      fail1: opId('d-fail-1'),
      requeue: opId('d-requeue'),
      lease2: opId('d-lease-2'),
      fail2: opId('d-fail-2'),
      retry: opId('d-retry'),
      lease3: opId('d-lease-3'),
    };
    await env.coordinator.leaseNext(taskId, env.worker.next(), operationIds.lease1);
    const attemptIdFor16 = (await env.readProjection(taskId)).activeLease?.attemptId ?? undefined;
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: operationIds.fail1,
      workItemId,
      attemptId: attemptIdFor16,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'f'.repeat(64),
      retryNotBefore: env.iso(-1000),
    });
    await env.coordinator.requeueDue(taskId, workItemId, operationIds.requeue);
    await env.coordinator.leaseNext(taskId, env.worker.next(), operationIds.lease2);
    const attemptIdFor17 = (await env.readProjection(taskId)).activeLease?.attemptId ?? undefined;
    await env.coordinator.recordRetryableFailure({
      taskId,
      operationId: operationIds.fail2,
      workItemId,
      attemptId: attemptIdFor17,
      failureCode: 'HANDLER_FAILED',
      failureDigest: 'f'.repeat(64),
      retryNotBefore: env.iso(-1000),
    });
    await env.coordinator.manualRetry(taskId, workItemId, operationIds.retry);
    await env.coordinator.leaseNext(taskId, env.worker.next(), operationIds.lease3);
    const projection = await env.readProjection(taskId);
    const wi = projection.workItems[workItemId];
    expect(wi.state).toBe('leased');
    expect(wi.leaseEpoch).toBe(4);
    expect(projection.activeLease).not.toBeNull();
    // The checkpoint store's projection equals an independent genesis replay.
    const events = (await env.eventStore.read(taskId))
      .map((entry) => entry.event)
      .filter((event) => (event as { protocolVersion?: unknown }).protocolVersion === 2) as AuthoritativeReviewEventV2[];
    const { projectAuthoritativeReviewState } = await import('../../storage/authoritative-review-state');
    const result = await projectAuthoritativeReviewState(events, (ref) => env.blobStore.readJson(taskId, ref, ref.kind));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.lastSequence).toBe(projection.lastSequence);
      expect(Object.keys(result.state.attempts)).toEqual(Object.keys(projection.attempts));
      expect(result.state.workItems[workItemId]).toEqual(projection.workItems[workItemId]);
    }
    // attempt ids are deterministic payload functions: claim ids are stable
    const attemptId = Object.keys(projection.attempts).find((id) => id.includes('att-'));

    // A fresh identical history derives identical ids.
    const env2 = await makeEnv();
    const taskId2 = tid('determinism2');
    const { workItemId: wi2 } = await createAgentWorkItem(env2, taskId2, { maxAutomaticRetries: 1 });
    await env2.coordinator.leaseNext(taskId2, env2.worker.next(), operationIds.lease1);
    const p2 = await env2.readProjection(taskId2);
    expect(Object.keys(p2.attempts)[0]).toBe(attemptId);
    const wi2Projection = p2.workItems[wi2];
    expect(wi2Projection.state).toBe('leased');
    expect(wi2Projection.leaseEpoch).toBe(1);
  });

  it('exposes the deterministic budget disposition digest used for parking', () => {
    const a = dispositionDigest('wi-a', 2, 'HANDLER_FAILED');
    const b = dispositionDigest('wi-a', 2, 'HANDLER_FAILED');
    const c = dispositionDigest('wi-a', 3, 'HANDLER_FAILED');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
}, 30_000);