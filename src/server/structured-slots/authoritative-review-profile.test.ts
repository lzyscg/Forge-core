// @vitest-environment node
/**
 * Authoritative review profile v1 tests (Task 5 Steps 2-3, red first).
 *
 * The profile snapshot (§4.3) is an immutable revision: canonical complete
 * bytes, `profileDigest = sha256(canonical bytes WITHOUT the field)`, and a
 * separate snapshot-ref digest over the COMPLETE object — the two identities
 * never equal. The profile owns v2 domain limits (maxSlots >= 10,000 while the
 * v1 profile stays at 2,500) and templates can only tighten against it.
 * Production readiness accepts only `qualificationState: 'final'`.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalJsonSha256 } from './canonical-json';
import { STRUCTURED_SLOT_PLATFORM_PROFILE_V1 } from './platform-profile';
import {
  AUTHORITATIVE_REVIEW_PROFILE_IDENTITY,
  profileCanonicalDigest,
  profileSnapshotRefOf,
  validateAuthoritativeReviewProfile,
  validateProductionAuthoritativeReviewProfile,
  assertTemplateLimitsWithinProfile,
  type AuthoritativeReviewProfileSnapshotV1Body,
} from './authoritative-review-profile';
import { refOfBlob } from '../authoritative-review/object-registry';
import {
  createAuthoritativeReviewTestEnvironment,
  AUTHORITATIVE_REVIEW_BUILTIN_HANDLER_IDENTITIES,
  buildAuthoritativeReviewPriorTestOnlyProfileBody,
} from './test-support/authoritative-review-test-registry';

/** The canonical test-only profile body produced by the checked-in test support. */
function testProfileBody(): AuthoritativeReviewProfileSnapshotV1Body {
  return createAuthoritativeReviewTestEnvironment().profile as AuthoritativeReviewProfileSnapshotV1Body;
}

function v2LimitsWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body = testProfileBody();
  return {
    schema: body.template.schema,
    structure: body.template.structure,
    payload: body.template.payload,
    draft: body.template.draft,
    attempt: body.template.attempt,
    validation: body.template.validation,
    output: body.template.output,
    relations: body.template.relations,
    authoritative: body.template.authoritative,
    ...overrides,
  };
}

describe('profile snapshot canonical identity (§4.3/§7.1)', () => {
  it('profileDigest covers canonical bytes without the field; the snapshot ref covers the complete object', () => {
    const body = testProfileBody();
    const digest = profileCanonicalDigest(body);
    const ref = profileSnapshotRefOf(body);
    expect(digest).toBe(body.profileDigest);
    // distinct identities: never equate them
    expect(digest).not.toBe(ref.digest);
    // digest over bytes minus the field
    const withoutDigest = { ...body } as Record<string, unknown>;
    delete withoutDigest.profileDigest;
    expect(digest).toBe(canonicalJsonSha256(withoutDigest));
    // ref digest over the complete canonical object, registry-consistent
    expect(ref.digest).toBe(canonicalJsonSha256(body));
    expect(refOfBlob('profile_snapshot', body)).toEqual(ref);
    expect(ref.kind).toBe('profile_snapshot');
    expect(ref.mediaType).toBe('application/json');
    expect(ref.schemaVersion).toBe(1);
    expect(ref.byteLength).toBeGreaterThan(0);
  });

  it('carries the frozen qualification state and exact registry identities', () => {
    const body = testProfileBody();
    expect(body.schemaVersion).toBe(1);
    expect(body.profileIdentity).toBe(AUTHORITATIVE_REVIEW_PROFILE_IDENTITY);
    expect(body.qualificationState).toBe('provisional');
    expect(body.abi).toEqual({
      validatorAbi: 'forge-validator/v2',
      assemblerAbi: 'forge-assembler/v2',
      profileAbi: 'forge-authoritative-review/v1',
    });
    expect(body.installedHandlers.validators.length).toBeGreaterThan(0);
    expect(body.installedHandlers.assembler.handlerKey.length).toBeGreaterThan(0);
  });

  it('same identity with different bytes is a distinct profile revision', () => {
    const bodyA = testProfileBody();
    const revised = { ...bodyA, profileVersion: bodyA.profileVersion + 1 };
    const bodyB = validateAuthoritativeReviewProfile({
      ...revised,
      profileDigest: profileCanonicalDigest(revised),
    });
    expect(bodyB.profileIdentity).toBe(bodyA.profileIdentity);
    expect(bodyB.profileDigest).not.toBe(bodyA.profileDigest);
    expect(profileSnapshotRefOf(bodyB).digest).not.toBe(profileSnapshotRefOf(bodyA).digest);
    expect(bodyB.profileVersion).toBe(bodyA.profileVersion + 1);
  });

  it('the binding triple supports the FrozenTemplate binding (identity + digest + snapshot ref)', () => {
    const env = createAuthoritativeReviewTestEnvironment();
    expect(env.profileSnapshotRef).toEqual(profileSnapshotRefOf(env.profile as AuthoritativeReviewProfileSnapshotV1Body));
    const binding = {
      profileIdentity: env.profile?.profileIdentity,
      profileDigest: env.profile?.profileDigest,
      profileSnapshotRef: env.profileSnapshotRef,
    };
    expect(binding.profileIdentity).toBe(AUTHORITATIVE_REVIEW_PROFILE_IDENTITY);
    // profileDigest and snapshot-ref digest are distinct identities
    expect(binding.profileDigest).not.toBe(binding.profileSnapshotRef?.digest);
  });

  it('rejects unknown fields, bad qualification state and digest mismatch', () => {
    const body = testProfileBody();
    expect(() => validateAuthoritativeReviewProfile({ ...body, extra: 1 })).toThrow('SCHEMA_INVALID');
    expect(() => validateAuthoritativeReviewProfile({ ...body, qualificationState: 'bogus' })).toThrow('SCHEMA_INVALID');
    expect(() => validateAuthoritativeReviewProfile({ ...body, profileDigest: '0'.repeat(64) })).toThrow('SCHEMA_INVALID');
  });
});

describe('production readiness (spec §4.3/§17)', () => {
  it('production accepts only a final profile', () => {
    const body = testProfileBody();
    expect(body.qualificationState).toBe('provisional');
    expect(() => validateProductionAuthoritativeReviewProfile(body)).toThrow('final');
    const provisional = validateAuthoritativeReviewProfile({
      ...body,
      qualificationState: 'provisional',
      profileDigest: profileCanonicalDigest({ ...body, qualificationState: 'provisional' }),
    });
    expect(() => validateProductionAuthoritativeReviewProfile(provisional)).toThrow('final');
    const finalProfile = validateAuthoritativeReviewProfile({
      ...body,
      qualificationState: 'final',
      profileDigest: profileCanonicalDigest({ ...body, qualificationState: 'final' }),
    });
    expect(validateProductionAuthoritativeReviewProfile(finalProfile)).toEqual(finalProfile);
  });

  it('freezes the exact installed registry identities into the profile body', () => {
    const body = testProfileBody();
    // The canonical profile carries the exact installed validator/assembler
    // registry identities — production manifest loading rejects the test-only
    // registry (and its provisional qualification state) on every path.
    expect(body.installedHandlers.validators).toEqual(AUTHORITATIVE_REVIEW_BUILTIN_HANDLER_IDENTITIES.validators);
    expect(body.installedHandlers.assembler).toEqual(AUTHORITATIVE_REVIEW_BUILTIN_HANDLER_IDENTITIES.assembler);
  });
});

describe('v2 profile capacity floor (spec §16.1)', () => {
  it('v2 maxSlots is at least 10,000 while the v1 final profile stays at 2,500', () => {
    const body = testProfileBody();
    expect(body.runtime.maxSlots).toBeGreaterThanOrEqual(10_000);
    expect(body.template.structure.maxSlots).toBeGreaterThanOrEqual(10_000);
    // v1 domain limit unchanged
    expect(STRUCTURED_SLOT_PLATFORM_PROFILE_V1.limits.structure.maxSlots).toBe(2_500);
    expect(STRUCTURED_SLOT_PLATFORM_PROFILE_V1.limits.structure.maxSlots).toBeLessThan(
      body.template.structure.maxSlots,
    );
  });

  it('v2 template limits may use exactly 10,000 slots (never the v1 2,500 assertion)', () => {
    const limits = v2LimitsWith({ structure: { maxSlots: 10_000, maxTreeDepth: 8, maxChildrenPerSlot: 250 } });
    const profile = testProfileBody();
    expect(() => assertTemplateLimitsWithinProfile(limits, profile)).not.toThrow();
    // a template that would violate the v1 2,500 ceiling is legal in v2
    expect((limits.structure as Record<string, number>).maxSlots).toBe(
      STRUCTURED_SLOT_PLATFORM_PROFILE_V1.limits.structure.maxSlots * 4,
    );
  });

  it('assignments support at least 256 primary targets and 1,024 total objects', () => {
    const body = testProfileBody();
    expect(body.runtime.assignmentMaxPrimaryTargets).toBeGreaterThanOrEqual(256);
    expect(body.runtime.assignmentMaxTotalObjects).toBeGreaterThanOrEqual(1_024);
    expect(body.runtime.assignmentMaxTotalObjects).toBeGreaterThanOrEqual(
      body.runtime.assignmentMaxPrimaryTargets,
    );
  });
});

describe('templates can only tighten (design §22.2)', () => {
  it('accepts template limits at or below every profile ceiling', () => {
    const body = testProfileBody();
    expect(() => assertTemplateLimitsWithinProfile(v2LimitsWith(), body)).not.toThrow();
  });

  it('rejects a template limit above a profile ceiling', () => {
    const body = testProfileBody();
    const limits = v2LimitsWith({
      structure: { maxSlots: body.template.structure.maxSlots + 1, maxTreeDepth: 8, maxChildrenPerSlot: 250 },
    });
    expect(() => assertTemplateLimitsWithinProfile(limits, body)).toThrow('maxSlots');
  });

  it('rejects expanding every closed group: schema, payload, draft, attempt, validation, output, relations, authoritative', () => {
    const body = testProfileBody();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['schema', { schema: { ...body.template.schema, maxSchemaDepth: body.template.schema.maxSchemaDepth + 1 } }],
      ['payload', { payload: { ...body.template.payload, maxContentBytesPerSlot: body.template.payload.maxContentBytesPerSlot + 1 } }],
      ['draft', { draft: { ...body.template.draft, maxDraftBytes: body.template.draft.maxDraftBytes + 1 } }],
      ['attempt', { attempt: { ...body.template.attempt, maxAttemptWallClockMs: body.template.attempt.maxAttemptWallClockMs + 1 } }],
      ['validation', { validation: { ...body.template.validation, maxIssuesPerRun: body.template.validation.maxIssuesPerRun + 1 } }],
      ['output', { output: { ...body.template.output, maxArtifactFiles: body.template.output.maxArtifactFiles + 1 } }],
      ['relations', { relations: { ...body.template.relations, maxRelationsPerMap: body.template.relations.maxRelationsPerMap + 1 } }],
      ['authoritative', { authoritative: { ...body.template.authoritative, maxFindingsPerRound: body.template.authoritative.maxFindingsPerRound + 1 } }],
    ];
    for (const [group, overrides] of cases) {
      const limits = v2LimitsWith(overrides);
      expect(() => assertTemplateLimitsWithinProfile(limits, body)).toThrow(group);
    }
  });

  it('rejects template limits with unknown fields or non-positive values', () => {
    const body = testProfileBody();
    expect(() => assertTemplateLimitsWithinProfile(v2LimitsWith({ bogus: 1 }), body)).toThrow('bogus');
    expect(() =>
      assertTemplateLimitsWithinProfile(
        v2LimitsWith({ structure: { maxSlots: 0, maxTreeDepth: 8, maxChildrenPerSlot: 250 } }),
        body,
      ),
    ).toThrow('maxSlots');
  });

  it('enforces the review policy ceilings (assignment soft limit and rounds), not just limit groups', () => {
    const body = testProfileBody();
    const limits = v2LimitsWith();
    expect(() =>
      assertTemplateLimitsWithinProfile(limits, body, {
        assignmentSoftLimit: body.runtime.assignmentMaxTotalObjects + 6,
        mapBatchTargetSlots: 24,
        contentBatchTargetSlots: 24,
        maxRounds: body.runtime.maxRoundsPerTrack + 1,
      }),
    ).toThrow('assignmentSoftLimit');
    expect(() =>
      assertTemplateLimitsWithinProfile(limits, body, {
        assignmentSoftLimit: 64,
        mapBatchTargetSlots: 24,
        contentBatchTargetSlots: 24,
        maxRounds: body.runtime.maxRoundsPerTrack + 1,
      }),
    ).toThrow('maxRounds');
  });
});

describe('profile file loading and placeholder identities', () => {
  it('exposes the profile identity and version constants', () => {
    expect(AUTHORITATIVE_REVIEW_PROFILE_IDENTITY).toBe('forge-authoritative-review/v1');
    expect(testProfileBody().abi.profileAbi).toBe('forge-authoritative-review/v1');
  });

  it('the checked-in profile file matches the canonical test profile body', async () => {
    // Production manifest loading rejects the checked-in provisional profile,
    // but the file must be a byte-identical canonical copy of the injected
    // test environment profile so tests and production share one shape.
    const { loadAuthoritativeReviewProfileFile } = await import('./authoritative-review-profile');
    const { authoritativeReviewProfileFilePath } = await import('./authoritative-review-capability');
    const fromFile = loadAuthoritativeReviewProfileFile(authoritativeReviewProfileFilePath());
    expect(fromFile.profileIdentity).toBe(AUTHORITATIVE_REVIEW_PROFILE_IDENTITY);
    expect(profileSnapshotRefOf(fromFile)).toEqual(profileSnapshotRefOf(testProfileBody()));
    expect(profileCanonicalDigest(fromFile)).toBe(profileCanonicalDigest(testProfileBody()));
  });

  it('the PRIOR test-only profile is a distinct archived revision, not the checked-in file', () => {
    const prior = buildAuthoritativeReviewPriorTestOnlyProfileBody();
    expect(prior.qualificationState).toBe('test_only');
    expect(prior.profileVersion).toBe(1);
    expect(prior.profileDigest).not.toBe(testProfileBody().profileDigest);
    expect(profileSnapshotRefOf(prior).digest).not.toBe(profileSnapshotRefOf(testProfileBody()).digest);
    // the prior profile never loads a Contract naming the new production builtins
    const newIdentity = testProfileBody().installedHandlers.validators[0]!;
    expect(
      prior.installedHandlers.validators.some(
        (entry) =>
          entry.handlerKey === newIdentity.handlerKey && entry.implementationDigest === newIdentity.implementationDigest,
      ),
    ).toBe(false);
  });
});

describe('the checked-in v2 profile file is not a production profile', () => {
  it('the checked-in file carries qualificationState provisional and is rejected by production validation', async () => {
    const { loadAuthoritativeReviewProfileFile } = await import('./authoritative-review-profile');
    const { authoritativeReviewProfileFilePath } = await import('./authoritative-review-capability');
    const fromFile = loadAuthoritativeReviewProfileFile(authoritativeReviewProfileFilePath());
    expect(fromFile.qualificationState).toBe('provisional');
    expect(() => validateProductionAuthoritativeReviewProfile(fromFile)).toThrow('final');
  });
});