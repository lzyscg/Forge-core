// @vitest-environment node
/**
 * Object registry tests (Task 3 brief Step 1): every AuthoritativeBlobKindV2
 * member is registered with exact schema/media/version/maxBytes and
 * child-ref extraction; unknown kinds/schema versions/fields fail closed;
 * self refs and mismatched display digests are rejected; profile_snapshot
 * identity rules; publication payload, recovery payload, round override and
 * the bootstrap max-bytes exception.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJsonSha256 } from '../../server/structured-slots/canonical-json';
import {
  AUTHORITATIVE_BLOB_KINDS_V2,
  type AuthoritativeBlobKindV2,
  type BlobRefV2,
} from '../../shared/authoritative-review-v2';
import {
  PROFILE_SNAPSHOT_BOOTSTRAP_MAX_BYTES,
  assertNoSelfReference,
  fullProfileForTests,
  parseBlob,
  refOfBlob,
  registeredKinds,
} from './object-registry';
import { createAuthoritativeReviewTestEnvironment } from '../structured-slots/test-support/authoritative-review-test-registry';

describe('registry exhaustiveness (§7.1)', () => {
  it('registers every member of the closed 59-kind union', () => {
    expect(registeredKinds().length).toBe(AUTHORITATIVE_BLOB_KINDS_V2.length);
    for (const kind of AUTHORITATIVE_BLOB_KINDS_V2) {
      expect(registeredKinds()).toContain(kind);
    }
  });

  it('rejects unregistered kinds and unknown schema versions', () => {
    expect(() => refOfBlob('not_a_kind' as AuthoritativeBlobKindV2, {})).toThrow('SCHEMA_INVALID');
    expect(() => parseBlob('authority_base_set', { taskId: 't', templateSnapshotRef: {}, profileSnapshotRef: {}, displayDigests: {}, baseSetDigest: '' })).toThrow('SCHEMA_INVALID');
    expect(() =>
      refOfBlob('map_snapshot', { schemaVersion: 99, proposedMapCoreRef: { kind: 'proposed_map_core', digest: 'd', byteLength: 1, mediaType: 'application/json', schemaVersion: 1 }, mapReviewBundleRef: { kind: 'map_review_bundle', digest: 'd', byteLength: 1, mediaType: 'application/json', schemaVersion: 1 }, sourceCandidateId: 'c' }),
    ).toThrow('SCHEMA_INVALID');
  });

  it('ref digest, byteLength, mediaType and schemaVersion are derived from canonical bytes', () => {
    const value = { candidateId: 'c1', baseMapId: null };
    const ref = refOfBlob('map_candidate', value);
    expect(ref.kind).toBe('map_candidate');
    expect(ref.mediaType).toBe('application/json');
    expect(ref.schemaVersion).toBe(1);
    expect(ref.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.byteLength).toBeGreaterThan(0);
    // identical bytes -> identical ref
    expect(refOfBlob('map_candidate', { candidateId: 'c1', baseMapId: null })).toEqual(ref);
    // different bytes -> different digest
    expect(refOfBlob('map_candidate', { candidateId: 'c1', baseMapId: 'x' }).digest).not.toBe(ref.digest);
  });
});

describe('profile_snapshot (§4.3/§7.1)', () => {
  /**
   * The complete canonical profile body (Task 5 extension): the registered
   * parser accepts the envelope PLUS the exact runtime/template/installed
   * handlers/budget/assembler groups, keeping the digest rule intact (Task 3
   * comment: "Task 5 extends the limit body while keeping this envelope
   * contract").
   */
  function profileValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const { profile } = createAuthoritativeReviewTestEnvironment();
    return {
      ...(profile as unknown as Record<string, unknown>),
      ...overrides,
    };
  }

  it('profileDigest and profileSnapshotRef.digest are distinct identities; both verify', async () => {
    const { canonicalJsonSha256 } = await import('../../server/structured-slots/canonical-json');
    const { parseProfileSnapshotObject } = await import('./object-registry');
    const raw = profileValue();
    const withoutDigest = { ...raw };
    delete withoutDigest.profileDigest;
    const value = { ...raw, profileDigest: canonicalJsonSha256(withoutDigest) };
    const parsed = parseProfileSnapshotObject(value);
    expect(parsed.profileIdentity).toBe('forge-authoritative-review/v1');

    const ref = refOfBlob('profile_snapshot', value);
    // profileDigest covers bytes without the field; the ref covers everything
    expect(parsed.profileDigest).not.toBe(ref.digest);
    // re-parse with the computed digest fills the hole consistently
    const complete = { ...value, profileDigest: parsed.profileDigest };
    const completeRef = refOfBlob('profile_snapshot', complete);
    expect(completeRef.digest).not.toBe(parsed.profileDigest);
    // the digest of the digest-less body is stable
    expect(parseProfileSnapshotObject(complete).profileDigest).toBe(parsed.profileDigest);
  });

  it('rejects unknown fields, bad abi, bad qualification state and digest mismatch', async () => {
    const { parseProfileSnapshotObject } = await import('./object-registry');
    expect(() => parseProfileSnapshotObject(profileValue({ extra: 1 }))).toThrow('SCHEMA_INVALID');
    expect(() => parseProfileSnapshotObject(profileValue({ qualificationState: 'foo' }))).toThrow('SCHEMA_INVALID');
    expect(() =>
      parseProfileSnapshotObject(
        profileValue({ abi: { validatorAbi: 'forge-validator/v1', assemblerAbi: 'forge-assembler/v2', profileAbi: 'forge-authoritative-review/v1' } }),
      ),
    ).toThrow('SCHEMA_INVALID');
    expect(() => parseProfileSnapshotObject(profileValue({ profileDigest: 'not-a-digest' }))).toThrow('SCHEMA_INVALID');
  });

  it('profile_snapshot maxBytes uses the profile-independent bootstrap maximum, not a profile limit', async () => {
    const { maxBytesForBlob } = await import('./object-registry');
    const profile = fullProfileForTests();
    // even a profile whose own per-kind limit for profile_snapshot is tiny must not shrink the bootstrap cap
    expect(maxBytesForBlob('profile_snapshot', profile)).toBe(PROFILE_SNAPSHOT_BOOTSTRAP_MAX_BYTES);
  });
});

describe('publication_operation_payload, recovery payload, round override (§8/§10.3.1)', () => {
  it('publication_operation_payload is a strict discriminated union over the closed families', async () => {
    const { parseBlob } = await import('./object-registry');
    const domainPublish = {
      family: 'domain_publish',
      operationId: 'op-1',
      taskId: 't1',
      publishKind: 'content_revision_commit',
      blobRefs: [refOfBlob('content_revision_manifest', { manifestDigest: 'm' })],
      expectedResultIdentity: 'result-1',
    };
    expect(() => parseBlob('publication_operation_payload', domainPublish)).not.toThrow();

    const lease = {
      family: 'lease_or_retry',
      operationId: 'op-2',
      taskId: 't1',
      workItemId: 'wi-1',
      leaseEpoch: 3,
      eventBuilder: 'work_item_leased',
      authorityBaseRef: refOfBlob('authority_base_set', { baseSetDigest: 'ab' }),
    };
    expect(() => parseBlob('publication_operation_payload', lease)).not.toThrow();

    const artifact = {
      family: 'artifact_publish',
      operationId: 'op-3',
      taskId: 't1',
      artifactRef: refOfBlob('artifact', { text: 't' }),
      sealRecordRef: refOfBlob('seal_record', { taskId: 't' }),
      deliveryRef: refOfBlob('system_artifact_delivery', { deliveryId: 'd' }),
      expectedArtifactVersion: 7,
    };
    expect(() => parseBlob('publication_operation_payload', artifact)).not.toThrow();

    // cross-family fields are rejected
    expect(() =>
      parseBlob('publication_operation_payload', { ...domainPublish, leaseEpoch: 1 }),
    ).toThrow('SCHEMA_INVALID');
    expect(() =>
      parseBlob('publication_operation_payload', { family: 'nope', operationId: 'x' }),
    ).toThrow('SCHEMA_INVALID');
  });

  it('childRefs of publication payloads cover exactly the branch refs', async () => {
    const { childRefsForBlob } = await import('./object-registry');
    const manifestRef = refOfBlob('content_revision_manifest', { manifestDigest: 'm' });
    const artifactRef = refOfBlob('artifact', { text: 't' });
    const sealRef = refOfBlob('seal_record', { taskId: 't' });
    const deliveryRef = refOfBlob('system_artifact_delivery', { deliveryId: 'd' });
    const refs = childRefsForBlob('publication_operation_payload', {
      family: 'artifact_publish',
      operationId: 'op',
      taskId: 't',
      artifactRef,
      sealRecordRef: sealRef,
      deliveryRef,
      expectedArtifactVersion: 1,
    });
    expect(refs.map((r) => r.kind).sort()).toEqual(['artifact', 'seal_record', 'system_artifact_delivery']);
    expect(refs.map((r) => r.digest)).toContain(artifactRef.digest);
    void manifestRef;
  });

  it('failure_recovery_payload stores event-ledger identities plus real object refs only', async () => {
    const { parseBlob } = await import('./object-registry');
    const retry = {
      kind: 'retry_system_command',
      failedWorkItemId: 'wi-x',
      failedCommandId: 'cmd-x',
      failedLeaseEpoch: 2,
      terminalEventId: 'ev-x',
      terminalCommitId: 'commit-x',
      authorityBaseRef: refOfBlob('authority_base_set', { baseSetDigest: 'ab' }),
      systemKind: 'system_map_finalize',
      systemPayloadRef: refOfBlob('map_build_spec', { specDigest: 'mb' }),
    };
    const { object } = parseBlob('failure_recovery_payload', retry);
    expect((object as typeof retry).failedWorkItemId).toBe('wi-x');

    const rebuild = {
      kind: 'rebuild_missing_work',
      predecessorResultRef: refOfBlob('validator_aggregate', { aggregateDigest: 'ag' }),
      expectedSuccessorKind: 'system_seal' as const,
      expectedSuccessorPayloadRef: refOfBlob('seal_validation_bundle', { bundleDigest: 'sv' }),
      authorityBaseRef: refOfBlob('authority_base_set', { baseSetDigest: 'ab' }),
      grantSpecInputRef: null,
    };
    expect(() => parseBlob('failure_recovery_payload', rebuild)).not.toThrow();
    // rebuild_missing_work forbids failed identity fields by construction
    expect(() =>
      parseBlob('failure_recovery_payload', { ...rebuild, failedWorkItemId: 'wi' }),
    ).toThrow('SCHEMA_INVALID');
  });

  it('round_budget_override is exact and state is exactly available', async () => {
    const { parseBlob, childRefsForBlob } = await import('./object-registry');
    const value = {
      overrideId: 'ov-1',
      failedEventId: 'ev-1',
      track: 'map' as const,
      repairLineageId: 'lineage-1',
      initialRepairPlanRef: refOfBlob('repair_plan_spec', { specDigest: 'rp' }),
      currentAuthorizedRepairPlanRef: refOfBlob('repair_plan_spec', { specDigest: 'rp2' }),
      predecessorOverrideRef: null,
      transferOrdinal: 0,
      operationId: 'op-1',
      operatorId: 'task_owner',
      reasonDigest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      state: 'available' as const,
    };
    expect(() => parseBlob('round_budget_override', value)).not.toThrow();
    expect(() =>
      parseBlob('round_budget_override', { ...value, state: 'consumed' }),
    ).toThrow('SCHEMA_INVALID');
    expect(() =>
      parseBlob('round_budget_override', { ...value, state: 'available', transferOrdinal: -1 }),
    ).toThrow('SCHEMA_INVALID');
    const refs = childRefsForBlob('round_budget_override', value);
    expect(refs.map((r) => r.digest)).toContain(value.initialRepairPlanRef.digest);
    expect(refs.map((r) => r.digest)).toContain(value.currentAuthorizedRepairPlanRef.digest);
  });
});

describe('self refs and display digests', () => {
  it('assertNoSelfReference guards content-addressed DAG objects (no self aggregate)', () => {
    // JSON cannot express a byte-identical self ref directly; the guard is a
    // defense-in-depth check that content-addressed DAG objects pass, and it
    // rejects any ref that WOULD alias the object's own aggregate.
    const value = {
      candidateId: 'c1',
      baseMapId: null,
      candidateDigest: '',
      validationCoreRef: refOfBlob('map_candidate_validation_core', { coreDigest: 'vc' }),
      candidateValidationAggregateRef: refOfBlob('validator_aggregate', { aggregateDigest: 'ag' }),
      candidateWarningCustodyRootRef: refOfBlob('validation_warning_custody_root', { rootDigest: 'w' }),
      createdAt: '2026-08-14T09:00:00.000Z',
    };
    const own = assertNoSelfReference('map_candidate', value);
    expect(own).toEqual(refOfBlob('map_candidate', value));
  });

  it('validator aggregate inputDigest must equal inputRef.digest (display alias)', async () => {
    const { canonicalJsonSha256 } = await import('../../server/structured-slots/canonical-json');
    const { parseBlob } = await import('./object-registry');
    const inputRef = refOfBlob('validator_input_envelope', { trigger: 'map_candidate_commit' });
    const goodBase = {
      trigger: 'map_candidate_commit',
      executionPhase: null,
      inputRef,
      inputDigest: inputRef.digest,
      registrationSetDigest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      validExecutionDigests: [],
      blockingInvalidReceiptRefs: [],
      advisoryReceiptRefs: [],
      infrastructureFailureRefs: [],
      warningRootRef: refOfBlob('validation_warning_root', { rootDigest: 'w' }),
      outcome: 'clear',
    };
    const good = { ...goodBase, aggregateDigest: canonicalJsonSha256(goodBase) };
    expect(() => parseBlob('validator_aggregate', good)).not.toThrow();
    expect(() =>
      parseBlob('validator_aggregate', { ...good, inputDigest: 'other-digest' }),
    ).toThrow('SCHEMA_INVALID');
  });

  it('registered kinds never accept unknown object fields', async () => {
    const { parseBlob } = await import('./object-registry');
    const factValue = {
      factId: 'f1',
      targetKind: 'content_slot',
      targetStableId: 's1',
      verdict: 'pass',
      factOrigin: { kind: 'batch', adoptionEligible: true },
      adoptionEligible: true,
      localSubjectDigest: 'sub',
      localContextDigest: 'ctx',
      reviewPolicyDigest: 'pol',
      findingIds: [],
      evidence: [],
      reviewerAttemptId: 'a1',
      recordedAt: '2026-08-14T10:00:00.000Z',
      surpriseField: true,
    };
    expect(() => parseBlob('review_fact', factValue)).toThrow('SCHEMA_INVALID');
  });

  it('maxBytes consult the profile per kind', async () => {
    const { maxBytesForBlob } = await import('./object-registry');
    const profile = fullProfileForTests();
    expect(maxBytesForBlob('review_fact', profile)).toBe(profile.maxBytesByKind.review_fact);
    expect(maxBytesForBlob('map_snapshot', profile)).toBe(profile.maxBytesByKind.map_snapshot);
  });
});

describe('grant_instance grantSpecRef kind constraint (Minor #3)', () => {
  it('a grant_instance with a wrong-kind grantSpecRef is rejected', async () => {
    const { parseBlob } = await import('./object-registry');
    const base = {
      grantInstanceId: 'gi-1',
      grantSpecRef: {}, // wrong kind, filled below
      workItemId: 'wi-1',
      leaseEpoch: 1,
      boundAttemptId: 'a1',
      agentId: 'agent-1',
    };
    const wrongKind = { ...base, grantSpecRef: refOfBlob('generation_plan_spec', { specDigest: 'gp' }) };
    const wrongBody = { ...wrongKind, instanceDigest: canonicalJsonSha256(wrongKind) };
    expect(() => parseBlob('grant_instance', wrongBody)).toThrow('must be a write_grant_spec ref');

    const rightKind = { ...base, grantSpecRef: refOfBlob('write_grant_spec', { specDigest: 'gs' }) };
    const rightBody = { ...rightKind, instanceDigest: canonicalJsonSha256(rightKind) };
    expect(() => parseBlob('grant_instance', rightBody)).not.toThrow();
  });
});

describe('repair_plan_spec identity (Finding 1)', () => {
  const H = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  function validRepairSpec(): Record<string, unknown> {
    const mapRef = refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'm' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r' }), sourceCandidateId: 'c' });
    const base = {
      repairPlanId: 'rp-1',
      revision: 1,
      planRevisionId: '',
      origin: { kind: 'initial' as const, settlementId: 's-1', settlementDigest: H, creationOperationKey: 'key-1' },
      sourceReceiptRef: null,
      repairBase: { kind: 'map_active' as const, mapRef },
      orderedBatchScopes: [],
      keyLineageRef: refOfBlob('repair_key_ledger', { ledgerDigest: H }),
      importedStagingManifestRef: refOfBlob('repair_staging_root', { stagingDigest: H }),
      specDigest: '',
    };
    const { planRevisionId: _p, specDigest: _s, ...rest } = base;
    void _p;
    void _s;
    const specDigest = canonicalJsonSha256(rest);
    const planRevisionId = canonicalJsonSha256({ repairPlanId: 'rp-1', revision: 1, specDigest });
    return { ...rest, specDigest, planRevisionId };
  }

  it('a correct specDigest passes and its planRevisionId is verified', async () => {
    const { parseBlob } = await import('./object-registry');
    const value = validRepairSpec();
    expect(() => parseBlob('repair_plan_spec', value)).not.toThrow();
  });

  it('a mismatched specDigest is rejected (self-digest covers the canonical body)', async () => {
    const { parseBlob } = await import('./object-registry');
    const value = validRepairSpec();
    const other = { ...value, specDigest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdfe' };
    // planRevisionId no longer matches hash(repairPlanId, revision, specDigest)
    expect(() => parseBlob('repair_plan_spec', other)).toThrow('SCHEMA_INVALID');
    // a specDigest that does not cover the canonical body is rejected even
    // when the planRevisionId is recomputed for it
    const consistent = {
      ...other,
      planRevisionId: canonicalJsonSha256({ repairPlanId: 'rp-1', revision: 1, specDigest: other.specDigest }),
    };
    expect(() => parseBlob('repair_plan_spec', consistent)).toThrow('does not match canonical bytes');
  });
});

describe('child ref helpers', () => {
  it('parseBlob validates refs embedded in objects', async () => {
    const { canonicalJsonSha256 } = await import('../../server/structured-slots/canonical-json');
    const { parseBlob } = await import('./object-registry');
    const manifestRef = refOfBlob('content_revision_manifest', { manifestDigest: 'm' });
    const settlementRef = refOfBlob('content_review_settlement_core', { coreDigest: 'cs' });
    const base = {
      settlementCoreRef: settlementRef,
      mapRef: refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'm' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r' }), sourceCandidateId: 'c' }),
      contentRevisionManifestRef: manifestRef,
      reviewWarningCustodyRootRef: refOfBlob('validation_warning_custody_root', { rootDigest: 'w' }),
    };
    const value = { ...base, bundleDigest: canonicalJsonSha256(base) };
    const { object: parsed } = parseBlob('review_bundle', value);
    const typed = parsed as { settlementCoreRef: BlobRefV2; bundleDigest: string };
    expect(typed.settlementCoreRef.digest).toBe(settlementRef.digest);
    expect(typed.bundleDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refOfBlob rejects values whose embedded refs are malformed', () => {
    expect(() =>
      refOfBlob('review_bundle', {
        settlementCoreRef: { kind: 'review_bundle', digest: 'short', byteLength: 1, mediaType: 'application/json', schemaVersion: 1 },
        mapRef: null,
        contentRevisionManifestRef: null,
        reviewWarningCustodyRootRef: null,
        bundleDigest: '',
      } as never),
    ).toThrow('SCHEMA_INVALID');
  });
});