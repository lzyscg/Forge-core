// @vitest-environment node
/**
 * Runtime capability gate tests (Task 5 Step 7, red first; Task 19 converts
 * the checked-in-phase pins into pure fixtures).
 *
 * The structured runtime capability is carried by an exact checked-in manifest
 * (`runtime-capability-v1.json`). Task 9 starts it `disabled` with no final
 * profile; only the Task 19 release command may flip it to `enabled`. The unit
 * tests here NEVER assert the current checked-in phase (spec §15: only the
 * release command may) — they run against EXPLICIT disabled/enabled fixtures
 * (`createDisabledRuntimeEnvironment` / `createTestRuntimeEnvironment`) so the
 * identical test source passes before AND after the production promotion.
 */
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_PROFILE_LIMITS_V1,
  createDisabledRuntimeEnvironment,
  createRuntimeEnvironment,
  createTestRuntimeEnvironment,
  isStructuredRuntimeEnabled,
  validateProductionProfile,
  validateRuntimeCapability,
  validatePlatformProfile,
} from './runtime-capability';
import { profileCanonicalDigest } from './platform-profile';

function provisionalProfile() {
  return {
    version: 1 as const,
    status: 'provisional' as const,
    identity: 'forge-structured-runtime/v1' as const,
    limits: CANDIDATE_PROFILE_LIMITS_V1,
    evidenceDigest: null,
  };
}

/** An enabled capability matching a provisional test profile. */
function enabledCapability() {
  const profile = validatePlatformProfile(provisionalProfile());
  return {
    version: 1 as const,
    status: 'enabled' as const,
    profileIdentity: 'forge-structured-runtime/v1',
    profileDigest: profileCanonicalDigest(profile),
    evidenceDigest: '0'.repeat(64),
    requiredAbis: ['forge-validator/v1', 'forge-assembler/v1'],
  } as const;
}

/** An explicit disabled capability (never reads the checked-in manifest). */
function disabledCapability() {
  return {
    version: 1 as const,
    status: 'disabled' as const,
    profileIdentity: null,
    profileDigest: null,
    evidenceDigest: null,
    requiredAbis: ['forge-validator/v1', 'forge-assembler/v1'],
  } as const;
}

describe('runtime-capability — explicit disabled fixture (Task 19)', () => {
  it('builds an explicit disabled environment with a null profile', () => {
    const env = createDisabledRuntimeEnvironment();
    expect(env.capability.status).toBe('disabled');
    expect(env.capability.profileIdentity).toBeNull();
    expect(env.capability.profileDigest).toBeNull();
    expect(env.capability.evidenceDigest).toBeNull();
    expect(env.profile).toBeNull();
    expect(env.capability.requiredAbis).toEqual(['forge-validator/v1', 'forge-assembler/v1']);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('validates an explicit disabled manifest shape', () => {
    const capability = validateRuntimeCapability(disabledCapability());
    expect(capability.status).toBe('disabled');
    expect(capability.requiredAbis).toEqual(['forge-validator/v1', 'forge-assembler/v1']);
  });

  it('keeps a disabled capability with a null profile as a valid environment', () => {
    const env = createDisabledRuntimeEnvironment();
    expect(() => createRuntimeEnvironment(env.capability, null)).not.toThrow();
  });
});

describe('runtime-capability — validation and injection', () => {
  it('rejects an unknown capability version or status', () => {
    expect(() => validateRuntimeCapability({ version: 2, status: 'disabled' })).toThrow();
    expect(() =>
      validateRuntimeCapability({
        version: 1,
        status: 'partially',
        profileIdentity: null,
        profileDigest: null,
        evidenceDigest: null,
        requiredAbis: [],
      }),
    ).toThrow();
  });

  it('rejects unknown capability fields and enabled manifests with missing digests', () => {
    expect(() => validateRuntimeCapability({ ...disabledCapability(), extra: true })).toThrow(/unknown field 'extra'/);
    expect(() => validateRuntimeCapability({ ...enabledCapability(), profileDigest: null })).toThrow(/enabled capability requires/);
    expect(() => validateRuntimeCapability({ ...enabledCapability(), evidenceDigest: null })).toThrow(/enabled capability requires/);
  });

  it('requires the exact ordered structured ABI list', () => {
    expect(() => validateRuntimeCapability({ ...disabledCapability(), requiredAbis: ['x'] })).toThrow(/requiredAbis must exactly equal/);
    expect(() => validateRuntimeCapability({ ...disabledCapability(), requiredAbis: ['forge-validator/v1'] })).toThrow(/requiredAbis must exactly equal/);
    expect(() => validateRuntimeCapability({ ...disabledCapability(), requiredAbis: ['forge-assembler/v1', 'forge-validator/v1'] })).toThrow(/requiredAbis must exactly equal/);
    expect(() => validateRuntimeCapability({ ...disabledCapability(), requiredAbis: ['forge-validator/v1', 'forge-assembler/v1', 'forge-assembler/v1'] })).toThrow(/requiredAbis must exactly equal/);
  });

  it('rejects a profile with a final status but no evidence digest', () => {
    expect(() =>
      validatePlatformProfile({
        version: 1,
        status: 'final',
        identity: 'forge-structured-runtime/v1' as const,
        limits: CANDIDATE_PROFILE_LIMITS_V1,
        evidenceDigest: null,
      }),
    ).toThrow();
  });

  it('requires a profile for an enabled capability', () => {
    expect(() => createRuntimeEnvironment(enabledCapability(), null)).toThrow();
  });

  it('rejects a mismatched capability/profile identity pair', () => {
    const capability = {
      ...enabledCapability(),
      requiredAbis: ['forge-validator/v1'],
    };
    const profile = {
      version: 1 as const,
      status: 'provisional' as const,
      identity: 'other-identity' as 'forge-structured-runtime/v1',
      limits: CANDIDATE_PROFILE_LIMITS_V1,
      evidenceDigest: null,
    };
    expect(() => createRuntimeEnvironment(capability, profile)).toThrow();
  });

  it('builds a matching enabled environment for tests', () => {
    const capability = enabledCapability();
    const profile = provisionalProfile();
    const env = createRuntimeEnvironment(capability, profile);
    expect(env.capability.status).toBe('enabled');
    expect(env.profile?.limits.structure.maxSlots).toBe(10_000);
    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.isFrozen(env.capability)).toBe(true);
    expect(Object.isFrozen(env.profile)).toBe(true);
  });

  it('rejects an enabled capability whose profile digest does not match', () => {
    expect(() => createRuntimeEnvironment({ ...enabledCapability(), profileDigest: 'f'.repeat(64) }, provisionalProfile())).toThrow(
      /profileDigest does not match/,
    );
  });

  it('keeps a disabled capability with a null profile as a valid environment', () => {
    const env = createDisabledRuntimeEnvironment();
    expect(() => createRuntimeEnvironment(env.capability, null)).not.toThrow();
  });
});

describe('runtime-capability — production capability validator rejects provisional (Task 9)', () => {  /** Smaller final-shaped profile the unit tests may inject (spec §5 allows any legal limits). */
  const finalProfile = () => ({
    version: 1 as const,
    status: 'final' as const,
    identity: 'forge-structured-runtime/v1' as const,
    limits: {
      ...CANDIDATE_PROFILE_LIMITS_V1,
      structure: { ...CANDIDATE_PROFILE_LIMITS_V1.structure, maxSlots: 500 },
      draft: { ...CANDIDATE_PROFILE_LIMITS_V1.draft, maxChangedSlots: 100 },
    },
    evidenceDigest: 'd'.repeat(64),
  });

  const provisionalProfile = () => ({
    version: 1 as const,
    status: 'provisional' as const,
    identity: 'forge-structured-runtime/v1' as const,
    limits: CANDIDATE_PROFILE_LIMITS_V1,
    evidenceDigest: null,
  });

  it('rejects a provisional profile as production readiness', () => {
    expect(() => validateProductionProfile(provisionalProfile())).toThrow();
  });

  it('accepts a final-shaped profile with a 64-hex evidence digest', () => {
    const profile = validateProductionProfile(finalProfile());
    expect(profile.status).toBe('final');
    expect(profile.evidenceDigest).toBe('d'.repeat(64));
  });

  it('still rejects an invalid final profile (missing evidence)', () => {
    expect(() =>
      validateProductionProfile({ ...finalProfile(), evidenceDigest: null }),
    ).toThrow();
  });
});

describe('runtime-capability — readiness predicate and enabled injection (Task 17)', () => {
  it('treats an explicit disabled environment as not runnable', () => {
    const env = createDisabledRuntimeEnvironment();
    expect(isStructuredRuntimeEnabled(env)).toBe(false);
    expect(isStructuredRuntimeEnabled(undefined)).toBe(false);
  });

  it('treats an injected enabled environment with a matching profile as runnable', () => {
    const env = createTestRuntimeEnvironment();
    expect(isStructuredRuntimeEnabled(env)).toBe(true);
    // The profile and capability are the SAME immutable references — never a
    // second default and never an environment-variable fallback.
    expect(env.capability.status).toBe('enabled');
    expect(env.profile).not.toBeNull();
  });

  it('fails closed when an enabled capability has no matching profile', () => {
    // The constructor REJECTS the mismatched pair; no component can ever read
    // a divergent default (spec §5).
    const capability = createTestRuntimeEnvironment().capability;
    expect(() => createRuntimeEnvironment(capability, null)).toThrow();
  });
});
