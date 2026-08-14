// @vitest-environment node
/**
 * Work-item domain tests (Task 3 brief Step 1): AuthorityBaseSet field
 * matrices per WorkItem kind (§10.1/§17.2), legal transitions, park
 * disposition invariants, display-digest aliasing, retry budget and progress
 * checkpoint monotonicity (§16.2).
 */
import { describe, expect, it } from 'vitest';
import { refOfBlob } from './object-registry';
import {
  assertDisplayDigestsAreAliases,
  assertParkDispositionInvariants,
  assertProgressCheckpointMonotonic,
  assertRetryBudgetWithinPolicy,
  assertWorkItemTransition,
  validateAuthorityBaseForWorkItem,
  validateWorkItemForKind,
} from './work-item-domain';
import type { AuthorityBaseSetV2, WorkItemV2 } from './authority-types';

function baseSet(overrides: Partial<AuthorityBaseSetV2> = {}): AuthorityBaseSetV2 {
  return {
    taskId: 'task-1',
    templateSnapshotRef: refOfBlob('profile_snapshot', {
      schemaVersion: 1,
      profileIdentity: 'profile',
      profileVersion: 1,
      qualificationState: 'provisional',
      profileDigest: '',
      abi: { validatorAbi: 'forge-validator/v2', assemblerAbi: 'forge-assembler/v2', profileAbi: 'forge-authoritative-review/v1' },
    }),
    profileSnapshotRef: refOfBlob('profile_snapshot', { profileDigest: 'p' }),
    mapRef: null,
    mapCandidateRef: null,
    mapReviewBundleRef: null,
    contentRevisionManifestRef: null,
    planSpecRef: null,
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
}

function profileRef(): AuthorityBaseSetV2['templateSnapshotRef'] {
  return refOfBlob('profile_snapshot', {
    schemaVersion: 1,
    profileIdentity: 'p',
    profileVersion: 1,
    qualificationState: 'provisional',
    profileDigest: '',
    abi: { validatorAbi: 'forge-validator/v2', assemblerAbi: 'forge-assembler/v2', profileAbi: 'forge-authoritative-review/v1' },
  });
}

describe('AuthorityBaseSetV2 field matrix (§10.1/§17.2)', () => {
  it('generation batch must bind mapRef + contentRevisionManifestRef + planSpecRef', () => {
    const mapRef = refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'm' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r' }), sourceCandidateId: 'c' });
    const manifestRef = refOfBlob('content_revision_manifest', { manifestDigest: 'mr' });
    const planRef = refOfBlob('generation_plan_spec', { specDigest: 'gp' });
    const ok = baseSet({ mapRef, contentRevisionManifestRef: manifestRef, planSpecRef: planRef });
    expect(validateAuthorityBaseForWorkItem(ok, 'agent_assignment', 'structured_session', 'generation_batch')).toEqual([]);

    const missing = baseSet({ mapRef, contentRevisionManifestRef: null, planSpecRef: planRef });
    const errors = validateAuthorityBaseForWorkItem(missing, 'agent_assignment', 'structured_session', 'generation_batch');
    expect(errors.join(' ')).toContain('contentRevisionManifestRef');
  });

  it('system seal must bind mapRef, mapReviewBundleRef, finalized manifest and reviewBundleRef', () => {
    const seal = baseSet({
      mapRef: refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'm' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r' }), sourceCandidateId: 'c' }),
      mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r' }),
      contentRevisionManifestRef: refOfBlob('content_revision_manifest', { manifestDigest: 'm' }),
      reviewBundleRef: refOfBlob('review_bundle', { bundleDigest: 'rb' }),
    });
    expect(validateAuthorityBaseForWorkItem(seal, 'system_seal')).toEqual([]);
    expect(
      validateAuthorityBaseForWorkItem(baseSet({ ...seal, reviewBundleRef: null }), 'system_seal').join(' '),
    ).toContain('reviewBundleRef');
  });

  it('map repair binds plan + staging and exactly one of mapRef | mapCandidateRef', () => {
    const planRef = refOfBlob('repair_plan_spec', { specDigest: 'rp' });
    const stagingRef = refOfBlob('repair_staging_root', { stagingDigest: 'st' });
    const good = baseSet({ planSpecRef: planRef, stagingManifestRef: stagingRef, mapRef: refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'm' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r' }), sourceCandidateId: 'c' }) });
    expect(validateAuthorityBaseForWorkItem(good, 'agent_assignment', 'structured_session', 'map_repair')).toEqual([]);

    const noBase = baseSet({ planSpecRef: planRef, stagingManifestRef: stagingRef });
    expect(validateAuthorityBaseForWorkItem(noBase, 'agent_assignment', 'structured_session', 'map_repair').join(' ')).toContain(
      'exactly one of',
    );
    const both = baseSet({
      planSpecRef: planRef,
      stagingManifestRef: stagingRef,
      mapRef: refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'm' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r' }), sourceCandidateId: 'c' }),
      mapCandidateRef: refOfBlob('map_candidate', { candidateId: 'c' }),
    });
    expect(validateAuthorityBaseForWorkItem(both, 'agent_assignment', 'structured_session', 'map_repair').join(' ')).toContain('exactly one');
  });

  it('submitter binds sealRecordRef + artifactRef + artifactDeliveryRef', () => {
    const base = baseSet({
      sealRecordRef: refOfBlob('seal_record', { taskId: 't' }),
      artifactRef: refOfBlob('artifact', { text: 'a' }),
      artifactDeliveryRef: refOfBlob('system_artifact_delivery', { deliveryId: 'd' }),
    });
    expect(validateAuthorityBaseForWorkItem(base, 'agent_assignment', 'generic_turn', null)).toEqual([]);
    expect(
      validateAuthorityBaseForWorkItem(baseSet({ ...base, artifactDeliveryRef: null }), 'agent_assignment', 'generic_turn', null).join(' '),
    ).toContain('artifactDeliveryRef');
  });

  it('profile + template refs are mandatory for every kind', () => {
    const missingProfile = baseSet({ profileSnapshotRef: null as never });
    expect(
      validateAuthorityBaseForWorkItem(missingProfile, 'system_map_finalize').join(' '),
    ).toContain('profileSnapshotRef');
  });
});

describe('WorkItem field validation (§17.2/§10.1)', () => {
  function workItem(overrides: Partial<WorkItemV2> = {}): WorkItemV2 {
    return {
      workItemId: 'wi-1',
      kind: 'system_map_finalize',
      roleBinding: null,
      agentExecutionKind: null,
      sessionKind: null,
      roundId: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      grantSpecRef: null,
      inputArtifactDeliveryId: null,
      authorityBaseRef: refOfBlob('authority_base_set', { baseSetDigest: 'ab' }),
      payloadRef: refOfBlob('map_build_spec', { specDigest: 'mb' }),
      state: 'ready',
      parkDisposition: null,
      leaseEpoch: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      retryOrdinal: 0,
      retryNotBefore: null,
      maxAutomaticRetries: 3,
      ...overrides,
    };
  }

  it('agent assignments require logicalAssignmentId; only review assignments carry reviewAssignmentId', () => {
    const ok = workItem({ kind: 'agent_assignment', agentExecutionKind: 'structured_session', sessionKind: 'generation_batch', logicalAssignmentId: 'la-1', roleBinding: 'fill' });
    expect(validateWorkItemForKind(ok)).toEqual([]);
    expect(
      validateWorkItemForKind(workItem({ kind: 'agent_assignment', agentExecutionKind: 'structured_session', sessionKind: 'generation_batch', logicalAssignmentId: null as never })),
    ).not.toEqual([]);

    const review = workItem({ kind: 'agent_assignment', agentExecutionKind: 'structured_session', sessionKind: 'review_content_batch', logicalAssignmentId: 'la-2', reviewAssignmentId: 'ra-1', roleBinding: 'review' });
    expect(validateWorkItemForKind(review)).toEqual([]);
    expect(
      validateWorkItemForKind(workItem({ kind: 'agent_assignment', agentExecutionKind: 'structured_session', sessionKind: 'generation_batch', logicalAssignmentId: 'la-3', reviewAssignmentId: 'ra-2' as never, roleBinding: 'fill' })),
    ).not.toEqual([]);
  });

  it('system WorkItems carry no Agent identity fields', () => {
    const bad = workItem({ logicalAssignmentId: 'x', sessionKind: 'generation_batch', agentExecutionKind: 'structured_session', kind: 'system_seal' });
    expect(validateWorkItemForKind(bad)).not.toEqual([]);
  });

  it('generic_turn requires sessionKind null and an input artifact delivery id', () => {
    const sub = workItem({ kind: 'agent_assignment', agentExecutionKind: 'generic_turn', sessionKind: null, logicalAssignmentId: 'la-4', inputArtifactDeliveryId: 'del-1', roleBinding: 'submitter' });
    expect(validateWorkItemForKind(sub)).toEqual([]);
    expect(
      validateWorkItemForKind(workItem({ kind: 'agent_assignment', agentExecutionKind: 'generic_turn', sessionKind: 'generation_batch' as never, logicalAssignmentId: 'la-5', roleBinding: 'submitter' })),
    ).not.toEqual([]);
  });
});

describe('WorkItem transitions and park invariants (§17.2)', () => {
  it('legal transition matrix', () => {
    expect(() => assertWorkItemTransition('ready', 'leased')).not.toThrow();
    expect(() => assertWorkItemTransition('leased', 'completed')).not.toThrow();
    expect(() => assertWorkItemTransition('leased', 'retryable_failed')).not.toThrow();
    expect(() => assertWorkItemTransition('leased', 'terminal_failed')).not.toThrow();
    expect(() => assertWorkItemTransition('retryable_failed', 'ready')).not.toThrow(); // requeue
    expect(() => assertWorkItemTransition('retryable_failed', 'parked')).not.toThrow(); // budget exhausted
    expect(() => assertWorkItemTransition('ready', 'parked')).toThrow('SCHEMA_INVALID');
    expect(() => assertWorkItemTransition('parked', 'ready')).not.toThrow(); // manual retry / replacement
    expect(() => assertWorkItemTransition('parked', 'superseded')).not.toThrow();
    expect(() => assertWorkItemTransition('completed', 'ready')).toThrow('SCHEMA_INVALID');
  });

  it('parkDisposition is non-null exactly when state is parked, and branches are exclusive', () => {
    expect(() => assertParkDispositionInvariants(null)).not.toThrow();
    expect(() =>
      assertParkDispositionInvariants({ kind: 'retry_budget_exhausted', retryOrdinal: 1, budgetPolicyDigest: 'b' }),
    ).not.toThrow();
    expect(() =>
      assertParkDispositionInvariants({ kind: 'retry_budget_exhausted', retryOrdinal: 1, budgetPolicyDigest: 'b', questionId: 'q' } as never),
    ).toThrow('SCHEMA_INVALID');
  });

  it('retry budget never exceeds the policy ceiling', () => {
    expect(() => assertRetryBudgetWithinPolicy({ retryOrdinal: 2, maxAutomaticRetries: 3 })).not.toThrow();
    expect(() => assertRetryBudgetWithinPolicy({ retryOrdinal: 4, maxAutomaticRetries: 3 })).toThrow('REVIEW_REPAIR_LIMIT_EXCEEDED');
  });
});

describe('display digests and progress checkpoints (§17.2/§16.2)', () => {
  it('every displayDigests entry must equal the corresponding set ref digest', () => {
    const mapRef = refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'm' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r' }), sourceCandidateId: 'c' });
    const good = baseSet({ mapRef, displayDigests: { mapRef: mapRef.digest } });
    expect(assertDisplayDigestsAreAliases(good)).toEqual([]);
    const bad = baseSet({ mapRef, displayDigests: { mapRef: 'deadbeef' } });
    expect(assertDisplayDigestsAreAliases(bad)).not.toEqual([]);
  });

  it('progress checkpoints are monotonic and digest-bound', () => {
    expect(() =>
      assertProgressCheckpointMonotonic(
        { coverageCount: 10, observationLevel: 1, findingStageCount: 0, planOrdinal: 1, digest: 'A' },
        { coverageCount: 12, observationLevel: 2, findingStageCount: 1, planOrdinal: 1, digest: 'B' },
      ),
    ).not.toThrow();
    expect(() =>
      assertProgressCheckpointMonotonic(
        { coverageCount: 10, observationLevel: 1, findingStageCount: 0, planOrdinal: 1, digest: 'A' },
        { coverageCount: 5, observationLevel: 1, findingStageCount: 0, planOrdinal: 1, digest: 'A' },
      ),
    ).toThrow('SCHEMA_INVALID');
  });
});