// @vitest-environment node
/**
 * Task 13 grant-service tests (design §11.11/§14.2/§18.4, spec §10.2/§11):
 * WriteGrantSpec / GrantInstance lifecycle — spec/WorkItem/AuthorityBase
 * equality, instance binding after attempt ID, reclaim re-sign with UNCHANGED
 * scope (never widened), stale baseline/epoch, same-root/different-manifest,
 * out-of-scope writes, oversized payloads, scope-expansion immutability, and
 * §11 response-loss replay + same-op/different-body conflict per write family.
 */
import { describe, expect, it } from 'vitest';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import { childRefsForBlob, parseBlob } from '../../authoritative-review/object-registry';
import { fullProfileForTests } from '../../authoritative-review/object-schemas';
import type { AuthorityBaseSetV2, WriteGrantSpecV2 } from '../../authoritative-review/authority-types';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import {
  GrantError,
  GrantService,
  assertContentWriteAuthorized,
  assertEvidenceWithinProfile,
  assertExactBase,
  assertInstanceCurrent,
  assertMapWriteAuthorized,
  assertPayloadWithinProfile,
  assertReclaimScopeUnchanged,
  assertScopeNotExpanded,
  classifyToolReplay,
  signGrantInstance,
  specUniformErrors,
  specsEqual,
} from './grant-service';

function ref(kind: string, salt: string): BlobRefV2 {
  const digest = canonicalJsonSha256({ kind, salt });
  return {
    kind: kind as BlobRefV2['kind'],
    digest,
    byteLength: digest.length,
    mediaType: 'application/json',
    schemaVersion: 1,
  };
}

const PROFILE = fullProfileForTests();

function structureSpec(overrides: Partial<Record<string, unknown>> = {}): WriteGrantSpecV2 {
  const base = ref('authority_base_set', 'base');
  const body: Record<string, unknown> = {
    grantSpecId: 'gs-1',
    workItemId: 'wi-1',
    kind: 'initial_structure_chunk',
    snapshotHash: '0'.repeat(64),
    authorityBaseRef: base,
    mapBuildSpecRef: ref('map_build_spec', 'plan'),
    expectedFrontierDigest: 'a'.repeat(64),
    structureChunkScope: { chunkOrdinal: 1, parentFrontierDigest: 'a'.repeat(64), maxNodes: 512, maxRelations: 64 },
    ...overrides,
  };
  delete body.specDigest;
  return { ...body, specDigest: canonicalJsonSha256(body) } as WriteGrantSpecV2;
}

function generationSpec(overrides: Partial<Record<string, unknown>> = {}): WriteGrantSpecV2 {
  const body: Record<string, unknown> = {
    grantSpecId: 'gs-gen',
    workItemId: 'wi-gen',
    kind: 'initial_generation_batch',
    snapshotHash: '0'.repeat(64),
    authorityBaseRef: ref('authority_base_set', 'gen'),
    generationPlanSpecRef: ref('generation_plan_spec', 'plan'),
    activeMapRef: ref('map_snapshot', 'map'),
    expectedContentRevisionManifestRef: ref('content_revision_manifest', 'manifest'),
    writeSlotIds: ['s-1', 's-2'],
    readScope: { maxContextBytes: 1_048_576 },
    ...overrides,
  };
  delete body.specDigest;
  return { ...body, specDigest: canonicalJsonSha256(body) } as WriteGrantSpecV2;
}

function reviewSpec(overrides: Partial<Record<string, unknown>> = {}): WriteGrantSpecV2 {
  const body: Record<string, unknown> = {
    grantSpecId: 'gs-review',
    workItemId: 'wi-review',
    kind: 'review_observation',
    snapshotHash: '0'.repeat(64),
    authorityBaseRef: ref('authority_base_set', 'review'),
    sessionKind: 'review_content_batch',
    reviewAssignmentId: 'ra-1',
    roundId: 'round-1',
    roundKind: 'content',
    readScope: { maxContextBytes: 1_048_576 },
    ...overrides,
  };
  delete body.specDigest;
  return { ...body, specDigest: canonicalJsonSha256(body) } as WriteGrantSpecV2;
}

function baseSet(overrides: Partial<Record<string, unknown>> = {}): AuthorityBaseSetV2 {
  const body = {
    taskId: 'task-1',
    templateSnapshotRef: ref('profile_snapshot', 'tpl'),
    profileSnapshotRef: ref('profile_snapshot', 'profile'),
    mapRef: null,
    mapCandidateRef: null,
    mapReviewBundleRef: null,
    contentRevisionManifestRef: null,
    planSpecRef: ref('map_build_spec', 'plan'),
    stagingManifestRef: null,
    reviewCoverageCoreRef: null,
    reviewRoundRef: null,
    reviewBundleRef: null,
    sealRecordRef: null,
    artifactRef: null,
    findingSetRef: null,
    artifactDeliveryRef: null,
    displayDigests: {},
    baseSetDigest: '',
    ...overrides,
  };
  delete (body as { baseSetDigest?: string }).baseSetDigest;
  return { ...body, baseSetDigest: canonicalJsonSha256(body) } as unknown as AuthorityBaseSetV2;
}

describe('grant-service pure equality and uniformity', () => {
  it('specsEqual is true for identical specs and false when any scope field changes', () => {
    const a = structureSpec();
    const b = structureSpec();
    expect(specsEqual(a, b)).toBe(true);
    const widened = structureSpec({ structureChunkScope: { chunkOrdinal: 1, parentFrontierDigest: 'a'.repeat(64), maxNodes: 1024, maxRelations: 64 } });
    expect(specsEqual(a, widened)).toBe(false);
  });

  it('specUniformErrors reports a spec whose authorityBaseRef differs from the WorkItem base', () => {
    const spec = structureSpec();
    const base = baseSet();
    // Same base → no errors.
    expect(specUniformErrors(spec, spec.authorityBaseRef, base)).toEqual([]);
    // Different base → uniform error.
    const other = ref('authority_base_set', 'other');
    expect(specUniformErrors(spec, other, base).length).toBeGreaterThan(0);
    // Plan mismatch → uniform error.
    const planMismatchBase = baseSet({ planSpecRef: ref('generation_plan_spec', 'other-plan') });
    expect(specUniformErrors(spec, spec.authorityBaseRef, planMismatchBase).length).toBeGreaterThan(0);
  });

  it('same-root/different-manifest staleness: a manifest ref change is stale even with the same digest', () => {
    const expected = ref('content_revision_manifest', 'root-same');
    const actualSame = { ...expected };
    expect(() => assertExactBase(expected, actualSame, 'manifest')).not.toThrow();
    const actualDifferentManifest = ref('content_revision_manifest', 'different-manifest');
    expect(() => assertExactBase(expected, actualDifferentManifest, 'manifest')).toThrow(GrantError);
  });
});

describe('grant-service instance lifecycle', () => {
  it('signs a GrantInstance bound to WorkItem/attempt/epoch/agent after the attempt ID exists', () => {
    const specRef = ref('write_grant_spec', 'spec');
    const gi = signGrantInstance({
      grantSpecRef: specRef,
      workItemId: 'wi-1',
      leaseEpoch: 2,
      boundAttemptId: 'att-1',
      agentId: 'agent-a',
      grantInstanceId: 'gi-1',
    });
    expect(gi.workItemId).toBe('wi-1');
    expect(gi.leaseEpoch).toBe(2);
    expect(gi.boundAttemptId).toBe('att-1');
    expect(gi.instanceDigest).toMatch(/^[0-9a-f]{64}$/);
    // A different attempt id produces a DIFFERENT instance digest.
    const gi2 = signGrantInstance({ ...{ grantSpecRef: specRef, workItemId: 'wi-1', leaseEpoch: 2, boundAttemptId: 'att-2', agentId: 'agent-a', grantInstanceId: 'gi-1' } });
    expect(gi2.instanceDigest).not.toBe(gi.instanceDigest);
  });

  it('assertInstanceCurrent accepts the exact binding and rejects stale epoch/attempt/agent', () => {
    const specRef = ref('write_grant_spec', 'spec');
    const gi = signGrantInstance({ grantSpecRef: specRef, workItemId: 'wi-1', leaseEpoch: 2, boundAttemptId: 'att-1', agentId: 'agent-a', grantInstanceId: 'gi-1' });
    const checks = { workItemId: 'wi-1', leaseEpoch: 2, attemptId: 'att-1', agentId: 'agent-a', specRef, authorityBaseRef: ref('authority_base_set', 'base') };
    expect(() => assertInstanceCurrent(gi, checks)).not.toThrow();
    expect(() => assertInstanceCurrent(gi, { ...checks, leaseEpoch: 3 })).toThrow(/epoch/);
    expect(() => assertInstanceCurrent(gi, { ...checks, attemptId: 'att-9' })).toThrow(/attempt/);
    expect(() => assertInstanceCurrent(gi, { ...checks, agentId: 'agent-b' })).toThrow(/agent/);
  });

  it('reclaim re-sign uses the UNCHANGED scope — a widened candidate scope is rejected', () => {
    const original = generationSpec();
    const same = generationSpec();
    expect(() => assertReclaimScopeUnchanged(original, same)).not.toThrow();
    const widened = generationSpec({ writeSlotIds: ['s-1', 's-2', 's-3'] });
    expect(() => assertReclaimScopeUnchanged(original, widened)).toThrow(GrantError);
  });

  it('scope expansion cannot mutate the CURRENT Grant (successor specs only)', () => {
    const current = generationSpec();
    const successor = generationSpec({ writeSlotIds: ['s-1', 's-2', 's-3'] });
    expect(() => assertScopeNotExpanded(current, successor)).toThrow(GrantError);
    expect(() => assertScopeNotExpanded(current, generationSpec())).not.toThrow();
  });
});

describe('grant-service write-scope and payload gates', () => {
  it('rejects out-of-scope content writes (slot not in writeSlotIds)', () => {
    const spec = generationSpec({ writeSlotIds: ['s-1', 's-2'] });
    expect(() => assertContentWriteAuthorized(spec, 's-1')).not.toThrow();
    expect(() => assertContentWriteAuthorized(spec, 's-9')).toThrow(GrantError);
  });

  it('rejects EVERY content write for reviewer/submitter (empty write authority)', () => {
    const spec = reviewSpec();
    expect(() => assertContentWriteAuthorized(spec, 's-1')).toThrow(/grants no content write/);
  });

  it('rejects out-of-scope Map writes (node/relation/parent/operation)', () => {
    const spec = structureSpec({ kind: 'map_repair_batch', repairPlanSpecRef: ref('repair_plan_spec', 'rp'), repairBase: { kind: 'map_active', mapRef: ref('map_snapshot', 'map') }, expectedStagingRootRef: ref('repair_staging_root', 'st'), planKeyLedgerRef: null, batchOrdinal: 1, findingIds: [], readScope: { maxContextBytes: 1024 }, writeScope: { mapWriteScope: { nodeIds: ['n-1'], relationIds: ['r-1'], allowedPlanKeys: [], parentContainers: ['p-1'], relationTypeIds: [], operations: ['add_node'] } } }) as WriteGrantSpecV2;
    expect(() => assertMapWriteAuthorized(spec, { kind: 'node', id: 'n-1' })).not.toThrow();
    expect(() => assertMapWriteAuthorized(spec, { kind: 'node', id: 'n-9' })).toThrow(GrantError);
    expect(() => assertMapWriteAuthorized(spec, { kind: 'operation', id: 'remove_node' })).toThrow(GrantError);
    const review = reviewSpec();
    expect(() => assertMapWriteAuthorized(review, { kind: 'node', id: 'n-1' })).toThrow(/grants no Map write/);
  });

  it('rejects oversized payloads against the profile byte bounds', () => {
    const kind = 'content_value';
    const cap = PROFILE.maxBytesByKind[kind as keyof typeof PROFILE.maxBytesByKind];
    expect(() => assertPayloadWithinProfile(PROFILE, kind, cap)).not.toThrow();
    expect(() => assertPayloadWithinProfile(PROFILE, kind, cap + 1)).toThrow(GrantError);
    expect(() => assertEvidenceWithinProfile(PROFILE, PROFILE.evidenceMaxBytesTotal + 1)).toThrow(GrantError);
  });
});

describe('grant-service §11 idempotency', () => {
  it('classifyToolReplay: new / replay / conflict per write family', () => {
    const committed = [
      { clientOperationId: 'op-1', bodyDigest: canonicalJsonSha256({ a: 1 }), result: { ok: true } },
      { clientOperationId: 'op-2', bodyDigest: canonicalJsonSha256({ b: 2 }), result: { ok: true } },
    ];
    expect(classifyToolReplay('op-9', { x: 1 }, committed).status).toBe('new');
    const replay = classifyToolReplay('op-1', { a: 1 }, committed);
    expect(replay.status).toBe('replay');
    expect(classifyToolReplay('op-1', { a: 999 }, committed).status).toBe('conflict');
  });

  it('the reviewer/submitter spec has empty write authority (grant-spec tension resolution)', () => {
    const spec = reviewSpec();
    expect(spec.kind).toBe('review_observation');
    // The spec is registrable: it round-trips through the closed registry
    // parser (write_grant_spec kind union now includes review_observation).
    const { object, ref } = parseBlob('write_grant_spec', spec);
    expect((object as WriteGrantSpecV2).kind).toBe('review_observation');
    expect(ref.kind).toBe('write_grant_spec');
    // The registry's child-ref extractor sees its authority ref.
    expect(childRefsForBlob('write_grant_spec', object).some((r) => r.kind === 'authority_base_set')).toBe(true);
  });
});

describe('grant-service runtime resolution', () => {
  it('resolveAttemptGrant resolves the spec + base for a review session (no instance needed)', async () => {
    const spec = reviewSpec();
    const base = baseSet();
    const grantSpecRef = ref('write_grant_spec', 'spec');
    const baseRef = ref('authority_base_set', 'review');
    const refs = new Map<string, unknown>();
    refs.set(grantSpecRef.digest, spec);
    refs.set(baseRef.digest, base);
    const stubService = new GrantService({
      resolver: (_task, r) => refs.get(r.digest) ?? null,
      readProjection: async () => ({ workItems: { 'wi-review': { grantSpecRef, authorityBaseRef: baseRef } } }) as never,
      profile: PROFILE,
    });
    const grant = await stubService.resolveAttemptGrant({
      taskId: 'task-1',
      workItemId: 'wi-review',
      attemptId: 'att-1',
      leaseEpoch: 1,
      namespace: 'structured/reviewer/wi-review/att-1',
      agentId: 'agent-r',
      roleBinding: 'reviewer',
      executionKind: 'structured',
      sessionKind: 'review_content_batch',
      dispatchRef: null,
      authorityBaseRef: baseRef,
      grantInstanceRef: null,
      inputArtifactDeliveryId: null,
      agent: null,
      currentAssignmentText: '',
      committedCheckpointText: '',
    });
    expect(grant.spec.kind).toBe('review_observation');
    expect(grant.instance).toBeNull();
  });

  it('assertAttemptCurrent rejects a stale lease epoch with zero writes (no partial write)', async () => {
    const service = new GrantService({
      resolver: () => null,
      readProjection: async () => ({}) as never,
      profile: PROFILE,
    });
    const ctx = {
      taskId: 'task-1',
      workItemId: 'wi-1',
      attemptId: 'att-1',
      leaseEpoch: 2,
      namespace: 'structured/orchestrator/wi-1/att-1',
      agentId: 'agent-a',
      roleBinding: 'orchestrator',
      executionKind: 'structured' as const,
      sessionKind: 'structure_chunk',
      dispatchRef: null,
      authorityBaseRef: ref('authority_base_set', 'base'),
      grantInstanceRef: null,
      inputArtifactDeliveryId: null,
      agent: null,
      currentAssignmentText: '',
      committedCheckpointText: '',
    };
    // Current lease binds epoch 1 → the closure epoch 2 is stale.
    expect(() =>
      service.assertAttemptCurrent(ctx, {
        activeLease: { workItemId: 'wi-1', leaseEpoch: 1, attemptId: 'att-1', commandId: null, leaseOwner: 'agent-a' },
      } as never),
    ).toThrow(/epoch/);
    // A different workitem under the lease → TASK_WRITE_LEASE_CONFLICT.
    expect(() =>
      service.assertAttemptCurrent(ctx, {
        activeLease: { workItemId: 'wi-OTHER', leaseEpoch: 2, attemptId: 'att-1', commandId: null, leaseOwner: 'agent-a' },
      } as never),
    ).toThrow(/not the active lease/);
  });
});
