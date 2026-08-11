// @vitest-environment node
/**
 * Platform profile v1 tests (Task 9 Step 2 + Step 7, red first).
 *
 * The platform hard ceiling is an exact, checked-in profile file
 * (`platform-profile-v1.json`). This task binds the PROVISIONAL profile for
 * disabled builds and tests only; `status: final` and the integrated
 * evidence digest belong to Task 19. The loader exact-validates the JSON
 * (version, status, identity, all 28 positive safe integers, the same
 * cross-field relations as the Task 4 contract compiler, and the
 * provisional-null / final-non-null evidenceDigest rule of spec §5).
 * `assertTemplateLimitsWithinProfile` is the template-vs-platform ceiling
 * check (design §7.6 three-layer model): a template limit above the profile
 * is `SLOTS_CONTRACT_INVALID`.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StructuredSlotLimitsV1 } from '../../shared/structured-slots';
import { canonicalJsonSha256 } from './canonical-json';
import {
  PLATFORM_PROFILE_INVALID,
  SLOTS_CONTRACT_INVALID,
  STRUCTURED_SLOT_PROFILE_CANDIDATE,
  assertTemplateLimitsWithinProfile,
  loadStructuredPlatformProfile,
  profileCanonicalDigest,
  validateStructuredPlatformProfileFile,
} from './platform-profile';

/** Deep copy of the candidate so a test can mutate one axis. */
function candidate(): StructuredSlotLimitsV1 {
  return JSON.parse(JSON.stringify(STRUCTURED_SLOT_PROFILE_CANDIDATE)) as StructuredSlotLimitsV1;
}

function provisionalFile(
  limits: StructuredSlotLimitsV1 = candidate(),
  evidenceDigest: string | null = null,
): Record<string, unknown> {
  return {
    version: 1,
    status: 'provisional',
    identity: 'forge-structured-runtime/v1',
    limits,
    evidenceDigest,
  };
}

function finalFile(
  limits: StructuredSlotLimitsV1 = candidate(),
  evidenceDigest: string | null = 'a'.repeat(64),
): Record<string, unknown> {
  return {
    version: 1,
    status: 'final',
    identity: 'forge-structured-runtime/v1',
    limits,
    evidenceDigest,
  };
}

describe('STRUCTURED_SLOT_PROFILE_CANDIDATE — design §25.13 verbatim', () => {
  it('carries exactly the design candidate values', () => {
    expect(STRUCTURED_SLOT_PROFILE_CANDIDATE).toEqual({
      schema: { maxSchemaDepth: 16, maxSchemaNodes: 4096, maxEnumItems: 256, maxPatternLength: 512 },
      structure: { maxSlots: 10_000, maxTreeDepth: 32, maxChildrenPerSlot: 1_000 },
      payload: { maxSpecBytesPerSlot: 65_536, maxContentBytesPerSlot: 1_048_576, maxScaffoldPayloadBytes: 67_108_864 },
      draft: { maxChangedSlots: 2_000, maxDraftBytes: 16_777_216 },
      attempt: {
        maxSlotToolCallsPerAttempt: 512,
        maxValidationRunsPerAttempt: 16,
        maxValidatorInvocationsPerAttempt: 40_000,
        maxAggregateValidatorCpuMsPerAttempt: 240_000,
        maxAggregateValidatorWallClockMsPerAttempt: 480_000,
        maxValidatorOutputBytesPerAttempt: 16_777_216,
        maxAttemptWallClockMs: 600_000,
      },
      validation: {
        maxValidators: 64,
        maxValidatorInvocationsPerGate: 10_000,
        maxAggregateValidatorCpuMsPerGate: 60_000,
        maxAggregateValidatorWallClockMsPerGate: 120_000,
        maxValidatorOutputBytesPerGate: 4_194_304,
        maxIssuesPerRun: 500,
      },
      output: { maxArtifactFiles: 64, maxArtifactBytesPerFile: 16_777_216, maxTotalArtifactBytes: 67_108_864 },
    });
  });

  it('satisfies every cross-field relation', () => {
    const l = STRUCTURED_SLOT_PROFILE_CANDIDATE;
    expect(l.attempt.maxValidatorInvocationsPerAttempt).toBeGreaterThanOrEqual(l.validation.maxValidatorInvocationsPerGate);
    expect(l.attempt.maxAggregateValidatorCpuMsPerAttempt).toBeGreaterThanOrEqual(l.validation.maxAggregateValidatorCpuMsPerGate);
    expect(l.attempt.maxAggregateValidatorWallClockMsPerAttempt).toBeGreaterThanOrEqual(l.validation.maxAggregateValidatorWallClockMsPerGate);
    expect(l.attempt.maxValidatorOutputBytesPerAttempt).toBeGreaterThanOrEqual(l.validation.maxValidatorOutputBytesPerGate);
    expect(l.attempt.maxValidationRunsPerAttempt).toBeLessThanOrEqual(l.attempt.maxSlotToolCallsPerAttempt);
    expect(l.attempt.maxAttemptWallClockMs).toBeGreaterThanOrEqual(l.attempt.maxAggregateValidatorWallClockMsPerAttempt);
    expect(l.draft.maxChangedSlots).toBeLessThanOrEqual(l.structure.maxSlots);
    expect(l.output.maxArtifactBytesPerFile).toBeLessThanOrEqual(l.output.maxTotalArtifactBytes);
  });

  it('exposes all 28 values as positive safe integers', () => {
    const flat = STRUCTURED_SLOT_PROFILE_CANDIDATE as unknown as Record<string, Record<string, number>>;
    const values: number[] = [];
    for (const group of Object.values(flat)) {
      for (const value of Object.values(group)) values.push(value);
    }
    expect(values).toHaveLength(28);
    for (const value of values) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});

describe('validateStructuredPlatformProfileFile — exact shape', () => {
  it('accepts the provisional file shape', () => {
    const profile = validateStructuredPlatformProfileFile(provisionalFile());
    expect(profile.status).toBe('provisional');
    expect(profile.evidenceDigest).toBeNull();
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.limits)).toBe(true);
  });

  it('accepts an injected smaller final-shaped profile with a 64-hex evidence digest', () => {
    const smaller = candidate();
    smaller.structure.maxSlots = 500;
    smaller.draft.maxChangedSlots = 100;
    const profile = validateStructuredPlatformProfileFile(finalFile(smaller, 'b'.repeat(64)));
    expect(profile.status).toBe('final');
    expect(profile.evidenceDigest).toBe('b'.repeat(64));
  });

  it('rejects unknown top-level fields', () => {
    expect(() => validateStructuredPlatformProfileFile({ ...provisionalFile(), extra: true })).toThrow(
      PLATFORM_PROFILE_INVALID,
    );
  });

  it('rejects a missing top-level field', () => {
    const file = provisionalFile() as Record<string, unknown>;
    delete file['evidenceDigest'];
    expect(() => validateStructuredPlatformProfileFile(file)).toThrow(PLATFORM_PROFILE_INVALID);
    const noLimits = provisionalFile() as Record<string, unknown>;
    delete noLimits['limits'];
    expect(() => validateStructuredPlatformProfileFile(noLimits)).toThrow(PLATFORM_PROFILE_INVALID);
  });

  it('rejects a wrong version', () => {
    expect(() => validateStructuredPlatformProfileFile({ ...provisionalFile(), version: 2 })).toThrow(
      PLATFORM_PROFILE_INVALID,
    );
  });

  it('rejects a wrong identity', () => {
    expect(() =>
      validateStructuredPlatformProfileFile({ ...provisionalFile(), identity: 'other-runtime/v1' }),
    ).toThrow(PLATFORM_PROFILE_INVALID);
  });

  it('rejects non-positive, non-integer and unknown limit fields', () => {
    const zero = candidate();
    zero.schema.maxSchemaDepth = 0;
    expect(() => validateStructuredPlatformProfileFile(provisionalFile(zero))).toThrow(PLATFORM_PROFILE_INVALID);
    const negative = candidate();
    negative.structure.maxSlots = -1;
    expect(() => validateStructuredPlatformProfileFile(provisionalFile(negative))).toThrow(PLATFORM_PROFILE_INVALID);
    const fractional = candidate();
    fractional.payload.maxSpecBytesPerSlot = 1.5;
    expect(() => validateStructuredPlatformProfileFile(provisionalFile(fractional))).toThrow(PLATFORM_PROFILE_INVALID);
    const unknownField = candidate() as unknown as Record<string, unknown> & { structure: Record<string, unknown> };
    unknownField.structure['maxSlotsExtra'] = 5;
    expect(() => validateStructuredPlatformProfileFile(provisionalFile(unknownField as unknown as StructuredSlotLimitsV1))).toThrow(
      PLATFORM_PROFILE_INVALID,
    );
    const missingField = candidate() as unknown as Record<string, unknown> & { schema: Record<string, unknown> };
    delete missingField.schema['maxSchemaNodes'];
    expect(() => validateStructuredPlatformProfileFile(provisionalFile(missingField as unknown as StructuredSlotLimitsV1))).toThrow(
      PLATFORM_PROFILE_INVALID,
    );
    const unknownGroup = candidate() as unknown as Record<string, unknown>;
    unknownGroup['extraGroup'] = { maxSlots: 1 };
    expect(() => validateStructuredPlatformProfileFile(provisionalFile(unknownGroup as unknown as StructuredSlotLimitsV1))).toThrow(
      PLATFORM_PROFILE_INVALID,
    );
  });

  it('rejects a provisional profile carrying a non-null evidence digest', () => {
    expect(() => validateStructuredPlatformProfileFile(provisionalFile(candidate(), 'c'.repeat(64)))).toThrow(
      PLATFORM_PROFILE_INVALID,
    );
  });

  it('rejects a final profile with a null or malformed evidence digest', () => {
    expect(() => validateStructuredPlatformProfileFile(finalFile(candidate(), null))).toThrow(PLATFORM_PROFILE_INVALID);
    expect(() => validateStructuredPlatformProfileFile(finalFile(candidate(), 'not-a-digest'))).toThrow(
      PLATFORM_PROFILE_INVALID,
    );
  });
});

describe('cross-field relations (brief Step 2)', () => {
  const rejects = (label: string, mutate: (l: StructuredSlotLimitsV1) => void): void => {
    it(`rejects ${label}`, () => {
      const limits = candidate();
      mutate(limits);
      expect(() => validateStructuredPlatformProfileFile(provisionalFile(limits))).toThrow(PLATFORM_PROFILE_INVALID);
    });
  };

  rejects('attempt validator invocations below the per-Gate counterpart', (l) => {
    l.attempt.maxValidatorInvocationsPerAttempt = l.validation.maxValidatorInvocationsPerGate - 1;
  });
  rejects('attempt validator CPU below the per-Gate counterpart', (l) => {
    l.attempt.maxAggregateValidatorCpuMsPerAttempt = l.validation.maxAggregateValidatorCpuMsPerGate - 1;
  });
  rejects('attempt validator wall below the per-Gate counterpart', (l) => {
    l.attempt.maxAggregateValidatorWallClockMsPerAttempt = l.validation.maxAggregateValidatorWallClockMsPerGate - 1;
  });
  rejects('attempt validator output bytes below the per-Gate counterpart', (l) => {
    l.attempt.maxValidatorOutputBytesPerAttempt = l.validation.maxValidatorOutputBytesPerGate - 1;
  });
  rejects('validation runs exceeding slot tool calls', (l) => {
    l.attempt.maxValidationRunsPerAttempt = l.attempt.maxSlotToolCallsPerAttempt + 1;
  });
  rejects('attempt wall below attempt validator wall', (l) => {
    l.attempt.maxAttemptWallClockMs = l.attempt.maxAggregateValidatorWallClockMsPerAttempt - 1;
  });
  rejects('changed slots exceeding max slots', (l) => {
    l.draft.maxChangedSlots = l.structure.maxSlots + 1;
  });
  rejects('per-file output exceeding total output', (l) => {
    l.output.maxArtifactBytesPerFile = l.output.maxTotalArtifactBytes + 1;
  });

  it('allows exact-boundary relations (a value strictly equal to its counterpart is legal)', () => {
    const limits = candidate();
    limits.attempt.maxValidatorInvocationsPerAttempt = limits.validation.maxValidatorInvocationsPerGate;
    limits.draft.maxChangedSlots = limits.structure.maxSlots;
    limits.output.maxArtifactBytesPerFile = limits.output.maxTotalArtifactBytes;
    expect(() => validateStructuredPlatformProfileFile(provisionalFile(limits))).not.toThrow();
  });
});

describe('assertTemplateLimitsWithinProfile — template <= platform ceiling', () => {
  it('accepts a template at or below every profile field', () => {
    expect(() => assertTemplateLimitsWithinProfile(STRUCTURED_SLOT_PROFILE_CANDIDATE, STRUCTURED_SLOT_PROFILE_CANDIDATE)).not.toThrow();
    const smaller = candidate();
    smaller.schema.maxSchemaNodes = 100;
    smaller.output.maxTotalArtifactBytes = 1_000_000;
    expect(() => assertTemplateLimitsWithinProfile(smaller, STRUCTURED_SLOT_PROFILE_CANDIDATE)).not.toThrow();
  });

  it('rejects a template field above the profile with SLOTS_CONTRACT_INVALID', () => {
    const over = candidate();
    over.structure.maxSlots = STRUCTURED_SLOT_PROFILE_CANDIDATE.structure.maxSlots + 1;
    expect(() => assertTemplateLimitsWithinProfile(over, STRUCTURED_SLOT_PROFILE_CANDIDATE)).toThrow(
      SLOTS_CONTRACT_INVALID,
    );
  });

  it('rejects a malformed template limits shape', () => {
    const bad = candidate() as unknown as Record<string, unknown> & { schema: Record<string, unknown> };
    delete bad.schema['maxEnumItems'];
    expect(() =>
      assertTemplateLimitsWithinProfile(bad as unknown as StructuredSlotLimitsV1, STRUCTURED_SLOT_PROFILE_CANDIDATE),
    ).toThrow(SLOTS_CONTRACT_INVALID);
  });
});

describe('profile file round-trip and digest (Task 19 pure fixtures)', () => {
  it('validates an explicit provisional file and canonical-digests it', () => {
    const file = provisionalFile();
    const profile = validateStructuredPlatformProfileFile(file);
    expect(profile.status).toBe('provisional');
    expect(profile.evidenceDigest).toBeNull();
    expect(profileCanonicalDigest(profile)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a stable 64-hex canonical digest that hashes the whole exact file', () => {
    const raw = provisionalFile();
    const profile = validateStructuredPlatformProfileFile(raw);
    const digest = profileCanonicalDigest(profile);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJsonSha256(raw)).toBe(digest);
  });

  it('loads an explicit provisional file identically through loadStructuredPlatformProfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-core-profile-'));
    const path = join(dir, 'profile.json');
    writeFileSync(path, JSON.stringify(provisionalFile()), 'utf8');
    const loaded = loadStructuredPlatformProfile(path);
    expect(loaded).toEqual(validateStructuredPlatformProfileFile(provisionalFile()));
    expect(profileCanonicalDigest(loaded)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('round-trips an explicit final-shaped file with a 64-hex evidence digest', () => {
    const smaller = candidate();
    smaller.structure.maxSlots = 500;
    smaller.draft.maxChangedSlots = 100;
    const profile = validateStructuredPlatformProfileFile(finalFile(smaller, 'f'.repeat(64)));
    expect(profile.status).toBe('final');
    expect(profile.evidenceDigest).toBe('f'.repeat(64));
    expect(profileCanonicalDigest(profile)).toMatch(/^[0-9a-f]{64}$/);
  });
});
