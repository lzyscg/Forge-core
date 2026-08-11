// @vitest-environment node
/**
 * Runtime capability gate tests (Task 5 Step 7, red first).
 *
 * The checked-in `runtime-capability-v1.json` production manifest must start
 * `disabled` with no final profile; the module exposes one immutable
 * `StructuredRuntimeEnvironmentV1 { capability, profile }`. Dependency
 * injection flows through constructor/options only — never an environment
 * variable fallback. Tests inject a matching enabled capability + provisional
 * test profile; no test may flip the checked-in manifest to enabled.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_PROFILE_LIMITS_V1,
  createProductionRuntimeEnvironment,
  createRuntimeEnvironment,
  createTestRuntimeEnvironment,
  isStructuredRuntimeEnabled,
  validateProductionProfile,
  validateRuntimeCapability,
  validatePlatformProfile,
} from './runtime-capability';

const MANIFEST_PATH = fileURLToPath(new URL('runtime-capability-v1.json', import.meta.url));

/** An enabled capability matching a provisional test profile. */
function enabledCapability() {
  return {
    version: 1 as const,
    status: 'enabled' as const,
    profileIdentity: 'forge-structured-runtime/v1',
    profileDigest: null,
    evidenceDigest: null,
    requiredAbis: ['forge-validator/v1', 'forge-assembler/v1'],
  } as const;
}

describe('runtime-capability — checked-in production manifest', () => {
  it('starts disabled with no final profile', () => {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, unknown>;
    expect(raw.version).toBe(1);
    expect(raw.status).toBe('disabled');
    expect(raw.profileIdentity).toBeNull();
    expect(raw.profileDigest).toBeNull();
    expect(raw.evidenceDigest).toBeNull();
    expect(Array.isArray(raw.requiredAbis)).toBe(true);
  });

  it('validates the exact manifest shape', () => {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const capability = validateRuntimeCapability(raw);
    expect(capability.status).toBe('disabled');
    expect(capability.requiredAbis).toEqual(['forge-validator/v1', 'forge-assembler/v1']);
  });

  it('builds the production environment disabled with a null profile', () => {
    const env = createProductionRuntimeEnvironment();
    expect(env.capability.status).toBe('disabled');
    expect(env.capability.profileIdentity).toBeNull();
    expect(env.capability.profileDigest).toBeNull();
    expect(env.profile).toBeNull();
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
    const profile = {
      version: 1 as const,
      status: 'provisional' as const,
      identity: 'forge-structured-runtime/v1' as const,
      limits: CANDIDATE_PROFILE_LIMITS_V1,
      evidenceDigest: null,
    };
    const env = createRuntimeEnvironment(capability, profile);
    expect(env.capability.status).toBe('enabled');
    expect(env.profile?.limits.structure.maxSlots).toBe(10_000);
    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.isFrozen(env.capability)).toBe(true);
    expect(Object.isFrozen(env.profile)).toBe(true);
  });

  it('keeps a disabled capability with a null profile as a valid environment', () => {
    const env = createProductionRuntimeEnvironment();
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
  it('treats the disabled production default as not runnable', () => {
    const env = createProductionRuntimeEnvironment();
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
