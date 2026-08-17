// @vitest-environment node
/**
 * Authoritative review capability gate tests (Task 5 Steps 2-3, red first).
 *
 * `authoritative_review_v1` starts DISABLED (spec §17) and is an ADDITIONAL
 * capability: creating/starting/leasing any v2 task requires BOTH the base
 * structured runtime capability AND this capability with a final profile.
 * Production manifest loading rejects provisional/test_only/missing/mismatched
 * evidence and never bypasses through an environment variable. Execution
 * eligibility is a separate reversible derivation (§4.3): a blocked task keeps
 * its frozen snapshot and bytes while only execution mutations are barred.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJsonSha256 } from './canonical-json';
import {
  AUTHORITATIVE_REVIEW_REQUIRED_ABIS,
  AUTHORITATIVE_REVIEW_PROFILE_FILE_NAME,
  AUTHORITATIVE_REVIEW_CAPABILITY_FILE_NAME,
  validateAuthoritativeReviewCapability,
  createAuthoritativeReviewRuntimeEnvironment,
  createProductionAuthoritativeReviewEnvironment,
  isAuthoritativeReviewRunnable,
  deriveAuthoritativeReviewExecutionEligibility,
  authoritativeReviewCapabilityManifestPath,
  authoritativeReviewProfileFilePath,
  type AuthoritativeReviewCapabilityV1,
  type ProductionAuthoritativeReviewFiles,
} from './authoritative-review-capability';
import {
  profileCanonicalDigest,
  validateAuthoritativeReviewProfile,
  type AuthoritativeReviewProfileSnapshotV1Body,
} from './authoritative-review-profile';
import { createAuthoritativeReviewTestEnvironment } from './test-support/authoritative-review-test-registry';

const DISABLED_MANIFEST: AuthoritativeReviewCapabilityV1 = {
  version: 1,
  status: 'disabled',
  profileIdentity: null,
  profileDigest: null,
  evidenceDigest: null,
  requiredAbis: [...AUTHORITATIVE_REVIEW_REQUIRED_ABIS],
};

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function testEnabledManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const env = createAuthoritativeReviewTestEnvironment();
  const profile = env.profile as NonNullable<typeof env.profile>;
  return {
    version: 1,
    status: 'enabled',
    profileIdentity: profile.profileIdentity,
    profileDigest: profile.profileDigest,
    evidenceDigest: '0'.repeat(64),
    requiredAbis: [...AUTHORITATIVE_REVIEW_REQUIRED_ABIS],
    ...overrides,
  };
}

describe('authoritative capability manifest', () => {
  it('accepts the exact disabled manifest with null identity/digests', () => {
    const capability = validateAuthoritativeReviewCapability(DISABLED_MANIFEST);
    expect(capability.status).toBe('disabled');
    expect(validateAuthoritativeReviewCapability(DISABLED_MANIFEST)).toEqual(capability);
  });

  it('rejects unknown fields, bad versions, and any non-empty identity while disabled', () => {
    expect(() => validateAuthoritativeReviewCapability({ ...DISABLED_MANIFEST, extra: 1 })).toThrow('RUNTIME_CAPABILITY_INVALID');
    expect(() => validateAuthoritativeReviewCapability({ ...DISABLED_MANIFEST, version: 2 })).toThrow('RUNTIME_CAPABILITY_INVALID');
    expect(() => validateAuthoritativeReviewCapability({ ...DISABLED_MANIFEST, status: 'enabled' })).toThrow('RUNTIME_CAPABILITY_INVALID');
    expect(() =>
      validateAuthoritativeReviewCapability({
        ...DISABLED_MANIFEST,
        profileIdentity: 'forge-authoritative-review/v1',
      }),
    ).toThrow('RUNTIME_CAPABILITY_INVALID');
    expect(() =>
      validateAuthoritativeReviewCapability({ ...DISABLED_MANIFEST, requiredAbis: ['forge-validator/v1', 'forge-assembler/v2'] }),
    ).toThrow('RUNTIME_CAPABILITY_INVALID');
  });

  it('an enabled capability requires the exact identity, digest and evidence', () => {
    const env = createAuthoritativeReviewTestEnvironment();
    const capability = env.capability;
    expect(capability.status).toBe('enabled');
    expect(capability.profileIdentity).toBe('forge-authoritative-review/v1');
    expect(capability.profileDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(() => validateAuthoritativeReviewCapability({ ...capability, profileDigest: null })).toThrow('RUNTIME_CAPABILITY_INVALID');
    expect(() => validateAuthoritativeReviewCapability({ ...capability, evidenceDigest: null })).toThrow('RUNTIME_CAPABILITY_INVALID');
    expect(() => validateAuthoritativeReviewCapability({ ...capability, profileIdentity: 'other' })).toThrow('RUNTIME_CAPABILITY_INVALID');
    expect(() => validateAuthoritativeReviewCapability({ ...capability, profileDigest: 'not-a-digest' })).toThrow('RUNTIME_CAPABILITY_INVALID');
  });
});

describe('runtime environment construction (fail closed)', () => {
  it('a disabled environment carries no profile and is not runnable', () => {
    const env = createAuthoritativeReviewRuntimeEnvironment(
      validateAuthoritativeReviewCapability(DISABLED_MANIFEST),
      null,
      { validators: [], assembler: { handlerKey: 'x', implementationDigest: '0'.repeat(64), moduleId: 'm', exportName: 'e' } },
    );
    expect(env.profile).toBeNull();
    expect(env.profileSnapshotRef).toBeNull();
    expect(isAuthoritativeReviewRunnable(env)).toBe(false);
  });

  it('an enabled capability requires a matching profile with exact registry identities', () => {
    const env = createAuthoritativeReviewTestEnvironment();
    const profile = env.profile as NonNullable<typeof env.profile>;
    expect(() =>
      createAuthoritativeReviewRuntimeEnvironment(env.capability, profile, {
        validators: [],
        assembler: profile.installedHandlers.assembler,
      }),
    ).toThrow('registry');
    expect(() =>
      createAuthoritativeReviewRuntimeEnvironment(
        { ...env.capability, profileDigest: '0'.repeat(64) } as AuthoritativeReviewCapabilityV1,
        profile,
        env.handlerRegistry,
      ),
    ).toThrow('RUNTIME_CAPABILITY_INVALID');
  });

  it('installs the current profile into the archive at environment construction', () => {
    const env = createAuthoritativeReviewTestEnvironment();
    expect(env.archive.has(env.profileSnapshotRef as NonNullable<typeof env.profileSnapshotRef>)).toBe(true);
  });
});

describe('production manifest loading (spec §17)', () => {
  it('loads a DISABLED manifest (written into a temp file) into a null-profile environment', () => {
    const dir = tempDir('forge-core-auth-manifest-disabled-');
    const disabledCapabilityPath = join(dir, 'disabled-capability-v1.json');
    writeJson(disabledCapabilityPath, {
      version: 1,
      status: 'disabled',
      profileIdentity: null,
      profileDigest: null,
      evidenceDigest: null,
      requiredAbis: ['forge-validator/v2', 'forge-assembler/v2'],
    });
    const env = createProductionAuthoritativeReviewEnvironment(disabledCapabilityPath);
    expect(env.capability.status).toBe('disabled');
    expect(env.profile).toBeNull();
    expect(isAuthoritativeReviewRunnable(env)).toBe(false);
  });

  it('the checked-in capability file name matches the production manifest file name', () => {
    expect(AUTHORITATIVE_REVIEW_CAPABILITY_FILE_NAME).toBe('authoritative-review-capability-v1.json');
  });

  it('loads the ENABLED checked-in manifest after Task 28 promotion', () => {
    const env = createProductionAuthoritativeReviewEnvironment();
    expect(env.capability.status).toBe('enabled');
    expect(env.profile?.qualificationState).toBe('final');
    expect(isAuthoritativeReviewRunnable(env)).toBe(true);
  });

  it('rejects an enabled manifest whose profile is only test_only (missing final evidence)', () => {
    const dir = tempDir('forge-core-auth-manifest-');
    const profile = createAuthoritativeReviewTestEnvironment()
      .profile as AuthoritativeReviewProfileSnapshotV1Body;
    const testOnlyProfileFile = join(dir, 'profile.json');
    writeJson(testOnlyProfileFile, profile);
    const files: ProductionAuthoritativeReviewFiles = {
      manifestFile: join(dir, 'manifest.json'),
      profileFile: testOnlyProfileFile,
    };
    writeJson(files.manifestFile as string, testEnabledManifest());
    expect(() => createProductionAuthoritativeReviewEnvironment(files)).toThrow('final');
  });

  it('rejects an enabled manifest whose profile is provisional', () => {
    const dir = tempDir('forge-core-auth-manifest-');
    const files: ProductionAuthoritativeReviewFiles = {
      manifestFile: join(dir, 'manifest.json'),
      profileFile: join(dir, 'profile.json'),
      evidenceFile: join(dir, 'evidence.json'),
    };
    const profile = createAuthoritativeReviewTestEnvironment()
      .profile as AuthoritativeReviewProfileSnapshotV1Body;
    const provisional = validateAuthoritativeReviewProfile({
      ...profile,
      qualificationState: 'provisional',
      profileDigest: profileCanonicalDigest({ ...profile, qualificationState: 'provisional' }),
    });
    writeJson(files.profileFile as string, provisional);
    writeJson(files.evidenceFile as string, { kind: 'provisional-evidence' });
    const manifest = testEnabledManifest({
      profileDigest: profileCanonicalDigest(provisional),
      evidenceDigest: canonicalJsonSha256({ kind: 'provisional-evidence' }),
    });
    writeJson(files.manifestFile as string, manifest);
    expect(() => createProductionAuthoritativeReviewEnvironment(files)).toThrow('final');
  });

  /** A final profile variant of the test body (production-parseable shape). */
  function finalProfile(): AuthoritativeReviewProfileSnapshotV1Body {
    const profile = createAuthoritativeReviewTestEnvironment()
      .profile as AuthoritativeReviewProfileSnapshotV1Body;
    const revised = { ...profile, qualificationState: 'final' as const };
    return validateAuthoritativeReviewProfile({
      ...revised,
      profileDigest: profileCanonicalDigest(revised),
    });
  }

  function evidenceDigestOf(evidence: unknown): string {
    return canonicalJsonSha256(evidence);
  }

  it('rejects an enabled manifest with a missing profile file, mismatched digest or missing evidence', () => {
    const dir = tempDir('forge-core-auth-manifest-');
    const profile = finalProfile();
    // An enabled manifest whose profile file is missing fails closed.
    const enabledManifest = testEnabledManifest({ profileDigest: profileCanonicalDigest(profile) });
    writeJson(join(dir, 'enabled.json'), enabledManifest);
    expect(() =>
      createProductionAuthoritativeReviewEnvironment({
        manifestFile: join(dir, 'enabled.json'),
        profileFile: join(dir, 'missing.json'),
      }),
    ).toThrow();
    // A manifest whose profileDigest does not match the checked-in file fails.
    const profileFile = join(dir, 'profile.json');
    writeJson(profileFile, profile);
    const corruptManifest = testEnabledManifest({ profileDigest: '0'.repeat(64) });
    writeJson(join(dir, 'corrupt.json'), corruptManifest);
    expect(() =>
      createProductionAuthoritativeReviewEnvironment({
        manifestFile: join(dir, 'corrupt.json'),
        profileFile,
      }),
    ).toThrow('RUNTIME_CAPABILITY_INVALID');
    // A manifest whose evidenceDigest does not match the evidence fails.
    const evidenceFile = join(dir, 'evidence.json');
    writeJson(evidenceFile, { kind: 'final-evidence', gitCommit: '0'.repeat(40) });
    const mismatchManifest = testEnabledManifest({
      profileDigest: profileCanonicalDigest(profile),
      evidenceDigest: '1'.repeat(64),
    });
    writeJson(join(dir, 'mismatch.json'), mismatchManifest);
    expect(() =>
      createProductionAuthoritativeReviewEnvironment({
        manifestFile: join(dir, 'mismatch.json'),
        profileFile,
        evidenceFile,
      }),
    ).toThrow('evidence');
    // A completely consistent final profile + evidence chain still loads only
    // through explicit files; the default (checked-in test_only) never does.
    const goodManifest = testEnabledManifest({
      profileDigest: profileCanonicalDigest(profile),
      evidenceDigest: evidenceDigestOf(JSON.parse(readFileSync(evidenceFile, 'utf8'))),
    });
    writeJson(join(dir, 'good.json'), goodManifest);
    const loaded = createProductionAuthoritativeReviewEnvironment({
      manifestFile: join(dir, 'good.json'),
      profileFile,
      evidenceFile,
    });
    expect(loaded.profile?.qualificationState).toBe('final');
    expect(isAuthoritativeReviewRunnable(loaded)).toBe(true);
  });

  it('never reads an environment variable to bypass production loading', () => {
    process.env.FORGE_CORE_AUTHORITATIVE_REVIEW_MANIFEST = '/definitely/not/read.json';
    try {
      const dir = tempDir('forge-core-auth-manifest-disabled-');
      const disabledCapabilityPath = join(dir, 'disabled-capability-v1.json');
      writeJson(disabledCapabilityPath, {
        version: 1,
        status: 'disabled',
        profileIdentity: null,
        profileDigest: null,
        evidenceDigest: null,
        requiredAbis: ['forge-validator/v2', 'forge-assembler/v2'],
      });
      const env = createProductionAuthoritativeReviewEnvironment(disabledCapabilityPath);
      expect(env.capability.status).toBe('disabled');
      delete process.env.FORGE_CORE_AUTHORITATIVE_REVIEW_MANIFEST;
      expect(createProductionAuthoritativeReviewEnvironment(disabledCapabilityPath).capability.status).toBe('disabled');
    } finally {
      delete process.env.FORGE_CORE_AUTHORITATIVE_REVIEW_MANIFEST;
    }
  });
});

describe('execution eligibility derivation (spec §4.3)', () => {
  const frozenDigest = 'a'.repeat(64);
  const currentDigest = 'b'.repeat(64);

  function derive(
    overrides: Partial<Parameters<typeof deriveAuthoritativeReviewExecutionEligibility>[0]> = {},
  ) {
    return deriveAuthoritativeReviewExecutionEligibility({
      frozenProfileDigest: frozenDigest,
      baseStructuredCapabilityEnabled: true,
      currentCapability: validateAuthoritativeReviewCapability(DISABLED_MANIFEST),
      currentProfileDigest: null,
      requiredAbisAvailable: true,
      ...overrides,
    });
  }

  it('is eligible only when the base capability, authoritative capability, exact digest and ABIs all pass', () => {
    expect(
      derive({
        currentCapability: validateAuthoritativeReviewCapability(testEnabledManifest() as unknown as AuthoritativeReviewCapabilityV1),
        currentProfileDigest: frozenDigest,
      }),
    ).toEqual({ state: 'eligible', frozenProfileDigest: frozenDigest, currentProfileDigest: frozenDigest });
  });

  it('both capabilities are required: base disabled blocks even when the authoritative gate passes', () => {
    const result = derive({
      baseStructuredCapabilityEnabled: false,
      currentCapability: validateAuthoritativeReviewCapability(testEnabledManifest() as unknown as AuthoritativeReviewCapabilityV1),
      currentProfileDigest: frozenDigest,
    });
    if (result.state !== 'blocked') throw new Error('expected the base-disabled block');
    expect(result.reason).toBe('base_capability_disabled');
  });

  it('authoritative_capability_disabled blocks when the capability is disabled or has no current profile', () => {
    const disabled = derive({ currentCapability: validateAuthoritativeReviewCapability(DISABLED_MANIFEST) });
    expect(disabled.state).toBe('blocked');
    if (disabled.state === 'blocked') expect(disabled.reason).toBe('authoritative_capability_disabled');
    const noProfile = derive({
      currentCapability: validateAuthoritativeReviewCapability(testEnabledManifest() as unknown as AuthoritativeReviewCapabilityV1),
      currentProfileDigest: null,
    });
    expect(noProfile.state).toBe('blocked');
    if (noProfile.state === 'blocked') expect(noProfile.reason).toBe('authoritative_capability_disabled');
  });

  it('profile_digest_mismatch blocks when the current capability no longer authorizes the frozen digest', () => {
    const result = derive({
      currentCapability: validateAuthoritativeReviewCapability(testEnabledManifest() as unknown as AuthoritativeReviewCapabilityV1),
      currentProfileDigest: currentDigest,
    });
    expect(result.state).toBe('blocked');
    if (result.state === 'blocked') {
      expect(result.reason).toBe('profile_digest_mismatch');
      expect(result.frozenProfileDigest).toBe(frozenDigest);
      expect(result.currentProfileDigest).toBe(currentDigest);
    }
  });

  it('required_abi_unavailable blocks when the frozen ABI identities are not installed', () => {
    const result = derive({
      currentCapability: validateAuthoritativeReviewCapability(testEnabledManifest() as unknown as AuthoritativeReviewCapabilityV1),
      currentProfileDigest: frozenDigest,
      requiredAbisAvailable: false,
    });
    expect(result.state).toBe('blocked');
    if (result.state === 'blocked') expect(result.reason).toBe('required_abi_unavailable');
  });

  it('a changed current profile digest keeps the frozen digest visible in every blocked state', () => {
    const result = derive({
      currentCapability: validateAuthoritativeReviewCapability(testEnabledManifest() as unknown as AuthoritativeReviewCapabilityV1),
      currentProfileDigest: currentDigest,
    });
    expect(result.frozenProfileDigest).toBe(frozenDigest);
  });
});

describe('profile file naming', () => {
  it('names the checked-in profile file and exposes its path', () => {
    expect(AUTHORITATIVE_REVIEW_PROFILE_FILE_NAME).toBe('authoritative-review-profile-v1.json');
    expect(authoritativeReviewProfileFilePath()).toContain('authoritative-review-profile-v1.json');
  });
});