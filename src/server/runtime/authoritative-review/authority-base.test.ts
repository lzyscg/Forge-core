// @vitest-environment node
/**
 * Task 10 authority-base runtime tests (design §17.2, spec §10.1): exact
 * AuthorityBaseSetV2 construction and field matrices for every WorkItem kind,
 * mandatory exact profileSnapshotRef on base/WorkItem/plan/dispatch/grant
 * carriers, staleness by EXACT ref equality (same-identity/different-profile
 * and same-root/different-manifest are both stale), park-disposition
 * invariants and WorkItem kind discriminants.
 *
 * The pure domain (`work-item-domain.ts`) owns the matrix tables; this runtime
 * module packages construction, digest binding, chain uniformity and staleness
 * so the coordinator and Task 11+ never hand-build a base set.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { BlobRefV2, AuthoritativeBlobKindV2 } from '../../../shared/authoritative-review-v2';
import {
  StaleAuthorityBaseError,
  assertAuthorityCarriersUniform,
  assertBaseStaysCurrent,
  assertExactRef,
  buildAuthorityBaseSet,
  sameRef,
  validateAuthorityBaseSet,
  validateParkDisposition,
  validateWorkItemCarry,
  type BuildAuthorityBaseSetInputV2,
} from './authority-base';
import type { StructuredSessionKindV2 } from '../../authoritative-review/authority-types';

/** Deterministic shape-valid ref (tests never resolve these). */
function refOf(kind: string, salt: number): BlobRefV2 {
  const digest = canonicalJsonSha256({ kind, salt });
  return {
    kind: kind as AuthoritativeBlobKindV2,
    digest,
    byteLength: 12,
    mediaType: 'application/json',
    schemaVersion: 1,
  };
}

const PROFILE_A = refOf('profile_snapshot', 1);
const PROFILE_B = refOf('profile_snapshot', 2);
const TEMPLATE = refOf('profile_snapshot', 3);

const SESSIONS: readonly StructuredSessionKindV2[] = [
  'structure_chunk',
  'review_map_batch',
  'review_map_whole',
  'generation_batch',
  'review_content_batch',
  'review_content_whole',
  'map_repair',
  'content_repair',
];

function buildBase(
  overrides: Partial<BuildAuthorityBaseSetInputV2> = {},
  refs: Partial<Record<string, BlobRefV2>> = {},
): BuildAuthorityBaseSetInputV2 {
  return {
    taskId: 'task-1',
    templateSnapshotRef: TEMPLATE,
    profileSnapshotRef: PROFILE_A,
    kind: 'agent_assignment',
    agentExecutionKind: 'structured_session',
    sessionKind: 'structure_chunk',
    refs,
    ...overrides,
  };
}

describe('buildAuthorityBaseSet — construction and field matrices (§17.2/§10.1)', () => {
  it('builds a legal base set for EVERY agent session kind, generic and system kind', () => {
    const perSession: Record<StructuredSessionKindV2, Record<string, BlobRefV2>> = {
      structure_chunk: { planSpecRef: refOf('map_build_spec', 10) },
      review_map_batch: { mapCandidateRef: refOf('map_candidate', 11), reviewCoverageCoreRef: refOf('map_review_coverage_core', 12), reviewRoundRef: refOf('map_review_round', 13) },
      review_map_whole: { mapCandidateRef: refOf('map_candidate', 11), reviewCoverageCoreRef: refOf('map_review_coverage_core', 12), reviewRoundRef: refOf('map_review_round', 13) },
      generation_batch: { mapRef: refOf('map_snapshot', 14), contentRevisionManifestRef: refOf('content_revision_manifest', 15), planSpecRef: refOf('generation_plan_spec', 16) },
      review_content_batch: { mapRef: refOf('map_snapshot', 14), contentRevisionManifestRef: refOf('content_revision_manifest', 15), reviewCoverageCoreRef: refOf('content_review_coverage_core', 17), reviewRoundRef: refOf('review_round', 18) },
      review_content_whole: { mapRef: refOf('map_snapshot', 14), contentRevisionManifestRef: refOf('content_revision_manifest', 15), reviewCoverageCoreRef: refOf('content_review_coverage_core', 17), reviewRoundRef: refOf('review_round', 18) },
      map_repair: { mapRef: refOf('map_snapshot', 14), planSpecRef: refOf('repair_plan_spec', 19), stagingManifestRef: refOf('repair_staging_root', 20) },
      content_repair: { mapRef: refOf('map_snapshot', 14), contentRevisionManifestRef: refOf('content_revision_manifest', 15), planSpecRef: refOf('repair_plan_spec', 19), stagingManifestRef: refOf('repair_staging_root', 20) },
    };
    for (const session of SESSIONS) {
      const base = buildAuthorityBaseSet(buildBase({ sessionKind: session }, perSession[session]));
      expect(validateAuthorityBaseSet(base, 'agent_assignment', 'structured_session', session)).toEqual([]);
      expect(base.profileSnapshotRef).toEqual(PROFILE_A);
      expect(base.templateSnapshotRef).toEqual(TEMPLATE);
      expect(base.baseSetDigest).toMatch(/^[0-9a-f]{64}$/);
      const { baseSetDigest: _digest, ...without } = base;
      expect(canonicalJsonSha256(without)).toBe(base.baseSetDigest);
      // display digests are exact aliases of every carried ref
      for (const [field, ref] of Object.entries(perSession[session])) {
        expect(base.displayDigests[field]).toBe(ref.digest);
      }
    }
    // generic submitter: seal/artifact/delivery + no agent fields
    const submitter = buildAuthorityBaseSet(
      buildBase(
        { kind: 'agent_assignment', agentExecutionKind: 'generic_turn', sessionKind: null },
        {
          sealRecordRef: refOf('seal_record', 30),
          artifactRef: refOf('artifact', 31),
          artifactDeliveryRef: refOf('system_artifact_delivery', 32),
        },
      ),
    );
    expect(validateAuthorityBaseSet(submitter, 'agent_assignment', 'generic_turn', null)).toEqual([]);
    // six system kinds
    const systemRefs: Record<string, Record<string, BlobRefV2>> = {
      system_map_finalize: { planSpecRef: refOf('map_build_spec', 10) },
      system_generation_finalize: { mapRef: refOf('map_snapshot', 14), contentRevisionManifestRef: refOf('content_revision_manifest', 15), planSpecRef: refOf('generation_plan_spec', 16) },
      system_repair_finalize: { mapCandidateRef: refOf('map_candidate', 11), planSpecRef: refOf('repair_plan_spec', 19), stagingManifestRef: refOf('repair_staging_root', 20) },
      system_migration_validation_batch: { mapCandidateRef: refOf('map_candidate', 11), planSpecRef: refOf('migration_validation_plan_spec', 21) },
      system_review_settlement: { mapRef: refOf('map_snapshot', 14), contentRevisionManifestRef: refOf('content_revision_manifest', 15), reviewCoverageCoreRef: refOf('content_review_coverage_core', 17), reviewRoundRef: refOf('review_round', 18) },
      system_seal: { mapRef: refOf('map_snapshot', 14), mapReviewBundleRef: refOf('map_review_bundle', 22), contentRevisionManifestRef: refOf('content_revision_manifest', 15), reviewBundleRef: refOf('review_bundle', 23) },
    };
    for (const [kind, refs] of Object.entries(systemRefs)) {
      const base = buildAuthorityBaseSet(buildBase({ kind: kind as BuildAuthorityBaseSetInputV2['kind'], agentExecutionKind: null, sessionKind: null }, refs));
      expect(validateAuthorityBaseSet(base, kind as never, null, null)).toEqual([]);
    }
  });

  it('rejects base sets without the mandatory exact profile/template refs', () => {
    const input = buildBase();
    delete (input as { profileSnapshotRef?: BlobRefV2 }).profileSnapshotRef;
    expect(() => buildAuthorityBaseSet(input)).toThrow('profileSnapshotRef');
    const input2 = buildBase();
    delete (input2 as { templateSnapshotRef?: BlobRefV2 }).templateSnapshotRef;
    expect(() => buildAuthorityBaseSet(input2)).toThrow('templateSnapshotRef');
  });

  it('rejects kind-forbidden fields, missing required fields and oneOf violations', () => {
    // structure_chunk must not carry mapRef
    expect(() => buildAuthorityBaseSet(buildBase({}, { planSpecRef: refOf('map_build_spec', 10), mapRef: refOf('map_snapshot', 14) }))).toThrow('mapRef is not allowed');
    // system_generation_finalize requires the manifest
    expect(() =>
      buildAuthorityBaseSet(buildBase({ kind: 'system_generation_finalize', agentExecutionKind: null, sessionKind: null }, {
        mapRef: refOf('map_snapshot', 14),
        planSpecRef: refOf('generation_plan_spec', 16),
      })),
    ).toThrow('contentRevisionManifestRef is required');
    // map_repair needs exactly one of mapRef | mapCandidateRef
    expect(() => buildAuthorityBaseSet(buildBase({ sessionKind: 'map_repair' }, {
      planSpecRef: refOf('repair_plan_spec', 19),
      stagingManifestRef: refOf('repair_staging_root', 20),
    }))).toThrow('exactly one of');
    expect(() => buildAuthorityBaseSet(buildBase({ sessionKind: 'map_repair' }, {
      mapRef: refOf('map_snapshot', 14),
      mapCandidateRef: refOf('map_candidate', 11),
      planSpecRef: refOf('repair_plan_spec', 19),
      stagingManifestRef: refOf('repair_staging_root', 20),
    }))).toThrow('exactly one of');
  });
});

describe('authority staleness — exact ref equality only (§17.2/§15)', () => {
  it('treats a different profileSnapshotRef as stale (same identity, different profile)', () => {
    const baseA = buildAuthorityBaseSet(buildBase({}, { planSpecRef: refOf('map_build_spec', 10) }));
    const baseB = buildAuthorityBaseSet(buildBase({ profileSnapshotRef: PROFILE_B }, { planSpecRef: refOf('map_build_spec', 10) }));
    expect(sameRef(baseA.profileSnapshotRef, baseB.profileSnapshotRef)).toBe(false);
    expect(() =>
      assertExactRef(baseA.profileSnapshotRef, baseB.profileSnapshotRef, 'profileSnapshotRef'),
    ).toThrowError(StaleAuthorityBaseError);
    try {
      assertExactRef(baseA.profileSnapshotRef, baseB.profileSnapshotRef, 'profileSnapshotRef');
      expect.unreachable('must throw');
    } catch (error) {
      const stale = error as StaleAuthorityBaseError;
      expect(stale.reason).toBe('ref_mismatch');
      expect(stale.what).toBe('profileSnapshotRef');
    }
  });

  it('treats a different manifest ref as stale even when the content ROOT digest is identical (same-root/different-manifest)', () => {
    const manifestA: BlobRefV2 = { ...refOf('content_revision_manifest', 15), digest: canonicalJsonSha256({ manifestId: 'm-a', contentRootDigest: canonicalJsonSha256({ root: 'same-root' }) }) };
    const manifestB: BlobRefV2 = { ...manifestA, digest: canonicalJsonSha256({ manifestId: 'm-b', contentRootDigest: canonicalJsonSha256({ root: 'same-root' }) }) };
    // BOTH manifests bind the SAME contentRootDigest — ref inequality is still staleness
    // (design §17.2: "contentRootDigest 相同但 ContentRevisionManifestRef 不同，仍是不同基线").
    expect(manifestA.digest).not.toBe(manifestB.digest);
    expect(sameRef(manifestA, manifestB)).toBe(false);
    expect(() => assertExactRef(manifestA, manifestB, 'contentRevisionManifestRef')).toThrowError(StaleAuthorityBaseError);
  });

  it('uses EXACT five-key ref equality — every key mutation is stale (digest alone is never sufficient)', () => {
    const a: BlobRefV2 = { kind: 'map_snapshot', digest: 'a'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 };
    const mutations: ReadonlyArray<[string, BlobRefV2]> = [
      ['kind', { ...a, kind: 'content_revision_manifest' }],
      ['digest', { ...a, digest: 'b'.repeat(64) }],
      ['byteLength', { ...a, byteLength: 11 }],
      ['mediaType', { ...a, mediaType: 'text/markdown' }],
      ['schemaVersion', { ...a, schemaVersion: 2 }],
    ];
    for (const [field, mutated] of mutations) {
      expect(sameRef(a, mutated)).toBe(false);
      expect(() => assertExactRef(a, mutated, 'mapRef')).toThrowError(StaleAuthorityBaseError);
      expect(() => assertExactRef(mutated, a, 'mapRef')).toThrowError(StaleAuthorityBaseError);
      expect(() => assertBaseStaysCurrent(a, mutated, 'mapRef')).toThrowError(StaleAuthorityBaseError);
      void field;
    }
  });

  it('keeps an IDENTICAL ref current', () => {
    const a = refOf('authority_base_set', 1);
    expect(() => assertExactRef(a, a, 'workitem')).not.toThrow();
    expect(assertBaseStaysCurrent(a, { ...a }, 'workitem')).toBe(undefined);
  });
});

describe('authority carrier uniformity — one base, one profile (§17.2)', () => {
  it('accepts dispatch/grant carriers bound to the SAME base ref and profile', () => {
    const baseSet = buildAuthorityBaseSet(buildBase({}, { planSpecRef: refOf('map_build_spec', 10) }));
    const baseRef = refOf('authority_base_set', 1);
    expect(() =>
      assertAuthorityCarriersUniform(baseRef, {
        baseSet,
        dispatchBaseRef: baseRef,
        grantSpecBaseRef: baseRef,
        grantSpecPlanRefs: [refOf('map_build_spec', 10)],
      }),
    ).not.toThrow();
  });

  it('rejects a dispatch or grant bound to a DIFFERENT base (naked digest copies / foreign profile)', () => {
    const baseSet = buildAuthorityBaseSet(buildBase({}, { planSpecRef: refOf('map_build_spec', 10) }));
    const baseRef = refOf('authority_base_set', 1);
    // Dispatch referencing another base (e.g. built under profile B) is stale.
    expect(() =>
      assertAuthorityCarriersUniform(baseRef, {
        baseSet,
        dispatchBaseRef: refOf('authority_base_set', 99),
        grantSpecBaseRef: null,
        grantSpecPlanRefs: [],
      }),
    ).toThrowError(StaleAuthorityBaseError);
    expect(() =>
      assertAuthorityCarriersUniform(baseRef, {
        baseSet,
        dispatchBaseRef: null,
        grantSpecBaseRef: refOf('authority_base_set', 99),
        grantSpecPlanRefs: [],
      }),
    ).toThrowError(StaleAuthorityBaseError);
  });

  it('rejects a grant spec whose plan ref is not the base set\'s exact plan ref', () => {
    const baseSet = buildAuthorityBaseSet(buildBase({}, { planSpecRef: refOf('map_build_spec', 10) }));
    const baseRef = refOf('authority_base_set', 1);
    expect(() =>
      assertAuthorityCarriersUniform(baseRef, {
        baseSet,
        dispatchBaseRef: null,
        grantSpecBaseRef: baseRef,
        grantSpecPlanRefs: [refOf('map_build_spec', 77)],
      }),
    ).toThrowError(StaleAuthorityBaseError);
  });

  it('skips plan cross-binding for PLAN-LESS bases (review/observation sessions)', () => {
    // A review base binds no plan in its matrix, yet the frozen created-event
    // validator still demands a grant ref; the base-ref equality alone is the
    // uniformity guarantee there (documented in assertAuthorityCarriersUniform).
    const baseSet = buildAuthorityBaseSet(
      buildBase(
        { kind: 'agent_assignment', agentExecutionKind: 'structured_session', sessionKind: 'review_map_batch' },
        {
          mapCandidateRef: refOf('map_candidate', 11),
          reviewCoverageCoreRef: refOf('map_review_coverage_core', 12),
          reviewRoundRef: refOf('review_assignment_ledger', 13),
        },
      ),
    );
    expect(baseSet.planSpecRef).toBeNull();
    const baseRef = refOf('authority_base_set', 1);
    expect(() =>
      assertAuthorityCarriersUniform(baseRef, {
        baseSet,
        dispatchBaseRef: null,
        grantSpecBaseRef: baseRef,
        grantSpecPlanRefs: [refOf('map_build_spec', 10)],
      }),
    ).not.toThrow();
    // ...but a grant bound to a DIFFERENT base is still stale even there.
    expect(() =>
      assertAuthorityCarriersUniform(baseRef, {
        baseSet,
        dispatchBaseRef: null,
        grantSpecBaseRef: refOf('authority_base_set', 99),
        grantSpecPlanRefs: [],
      }),
    ).toThrowError(StaleAuthorityBaseError);
  });
});

describe('park disposition and WorkItem kind discriminants (§17.2/§10.1)', () => {
  it('accepts only exact closed park dispositions', () => {
    expect(() => validateParkDisposition(null)).not.toThrow();
    expect(() => validateParkDisposition({ kind: 'retry_budget_exhausted', retryOrdinal: 2, budgetPolicyDigest: 'a'.repeat(64) })).not.toThrow();
    expect(() => validateParkDisposition({ kind: 'human_question', questionId: 'q-1', questionVersion: 'A'.repeat(43) })).not.toThrow();
    expect(() => validateParkDisposition({ kind: 'retry_budget_exhausted', retryOrdinal: 2 } as never)).toThrow();
    expect(() => validateParkDisposition({ kind: 'nope', retryOrdinal: 1, budgetPolicyDigest: 'x' } as never)).toThrow();
    expect(() => validateParkDisposition({ kind: 'human_question', questionId: 'q-1' } as never)).toThrow();
  });

  it('enforces the WorkItem agent/system/structured/generic discriminants', () => {
    // system workitem with a grant spec
    const systemWithGrant: Parameters<typeof validateWorkItemCarry>[0] = {
      kind: 'system_seal',
      roleBinding: null,
      agentExecutionKind: null,
      sessionKind: null,
      roundId: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      grantSpecRef: refOf('write_grant_spec', 1),
      inputArtifactDeliveryId: null,
    };
    expect(validateWorkItemCarry(systemWithGrant).join(' ')).toContain('grant');
    // generic turn without a delivery id
    const genericMissingDelivery: Parameters<typeof validateWorkItemCarry>[0] = {
      kind: 'agent_assignment',
      roleBinding: 'submitter',
      agentExecutionKind: 'generic_turn',
      sessionKind: null,
      roundId: null,
      logicalAssignmentId: 'la-1',
      reviewAssignmentId: null,
      grantSpecRef: null,
      inputArtifactDeliveryId: null,
    };
    expect(validateWorkItemCarry(genericMissingDelivery).join(' ')).toContain('inputArtifactDeliveryId');
    // structured session without sessionKind
    const structuredNoSession: Parameters<typeof validateWorkItemCarry>[0] = {
      kind: 'agent_assignment',
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session',
      sessionKind: null,
      roundId: null,
      logicalAssignmentId: 'la-1',
      reviewAssignmentId: null,
      grantSpecRef: null,
      inputArtifactDeliveryId: null,
    };
    expect(validateWorkItemCarry(structuredNoSession).join(' ')).toContain('sessionKind');
    // review session without reviewAssignmentId
    const reviewMissingAssignment: Parameters<typeof validateWorkItemCarry>[0] = {
      kind: 'agent_assignment',
      roleBinding: 'reviewer',
      agentExecutionKind: 'structured_session',
      sessionKind: 'review_map_batch',
      roundId: null,
      logicalAssignmentId: 'la-1',
      reviewAssignmentId: null,
      grantSpecRef: null,
      inputArtifactDeliveryId: null,
    };
    expect(validateWorkItemCarry(reviewMissingAssignment).join(' ')).toContain('reviewAssignmentId');
    // non-review session MUST NOT carry reviewAssignmentId
    const nonReviewWithAssignment: Parameters<typeof validateWorkItemCarry>[0] = {
      kind: 'agent_assignment',
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
      roundId: null,
      logicalAssignmentId: 'la-1',
      reviewAssignmentId: 'ra-1',
      grantSpecRef: null,
      inputArtifactDeliveryId: null,
    };
    expect(validateWorkItemCarry(nonReviewWithAssignment).join(' ')).toContain('reviewAssignmentId');
    // a fully legal structured write carry passes
    const legal: Parameters<typeof validateWorkItemCarry>[0] = {
      kind: 'agent_assignment',
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
      roundId: null,
      logicalAssignmentId: 'la-1',
      reviewAssignmentId: null,
      grantSpecRef: null,
      inputArtifactDeliveryId: null,
    };
    expect(validateWorkItemCarry(legal)).toEqual([]);
  });
});