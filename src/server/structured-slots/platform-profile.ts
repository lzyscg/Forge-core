/**
 * Structured platform profile v1 (Task 9, spec §5 / design §7.6 + §25.13).
 *
 * The platform hard ceiling is a deploy security boundary that templates can
 * never widen (design §7.6 three-layer model: local schema constraints <=
 * template envelope <= platform hard ceiling). It is carried by an exact,
 * checked-in profile file `platform-profile-v1.json` under the independent
 * version identity `forge-structured-runtime/v1`.
 *
 * Task 9 binds the PROVISIONAL profile for disabled builds and tests only:
 * `status: provisional` MUST carry a null `evidenceDigest`; only Task 19 may
 * run the integrated reference benchmark, write the evidence and rewrite the
 * profile to `status: final` referencing that evidence (one-way digest chain
 * of spec §5). The production capability validator (runtime-capability.ts)
 * rejects a provisional profile — a provisional ceiling can never satisfy
 * production readiness.
 *
 * The loader exact-validates every checked-in JSON: version, status,
 * identity, all 28 positive safe integers with the same cross-field relations
 * as the Task 4 contract compiler, and unknown/missing fields fail closed.
 * `assertTemplateLimitsWithinProfile` is the template-vs-platform check:
 * every template limit must be <= the profile, else `SLOTS_CONTRACT_INVALID`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StructuredSlotLimitsV1 } from '../../shared/structured-slots';
import { canonicalJsonSha256 } from './canonical-json';

/** Stable code for profile file shape / relation violations. */
export const PLATFORM_PROFILE_INVALID = 'PLATFORM_PROFILE_INVALID';

/** Stable code for a template envelope that exceeds the platform ceiling. */
export const SLOTS_CONTRACT_INVALID = 'SLOTS_CONTRACT_INVALID';

/** The exact profile file version (spec §5). */
export const STRUCTURED_SLOT_PROFILE_VERSION = 1 as const;

/** The independent runtime identity carrying the profile (spec §5). */
export const PROFILE_IDENTITY = 'forge-structured-runtime/v1' as const;

/** The exact profile file shape (spec §5). */
export interface StructuredPlatformProfileFileV1 {
  version: 1;
  status: 'provisional' | 'final';
  identity: 'forge-structured-runtime/v1';
  limits: StructuredSlotLimitsV1;
  evidenceDigest: string | null;
}

/** The exact ordered field map of the frozen v1 limit groups (design §7.6). */
const LIMIT_GROUPS: Readonly<Record<string, readonly string[]>> = {
  schema: ['maxSchemaDepth', 'maxSchemaNodes', 'maxEnumItems', 'maxPatternLength'],
  structure: ['maxSlots', 'maxTreeDepth', 'maxChildrenPerSlot'],
  payload: ['maxSpecBytesPerSlot', 'maxContentBytesPerSlot', 'maxScaffoldPayloadBytes'],
  draft: ['maxChangedSlots', 'maxDraftBytes'],
  attempt: [
    'maxSlotToolCallsPerAttempt',
    'maxValidationRunsPerAttempt',
    'maxValidatorInvocationsPerAttempt',
    'maxAggregateValidatorCpuMsPerAttempt',
    'maxAggregateValidatorWallClockMsPerAttempt',
    'maxValidatorOutputBytesPerAttempt',
    'maxAttemptWallClockMs',
  ],
  validation: [
    'maxValidators',
    'maxValidatorInvocationsPerGate',
    'maxAggregateValidatorCpuMsPerGate',
    'maxAggregateValidatorWallClockMsPerGate',
    'maxValidatorOutputBytesPerGate',
    'maxIssuesPerRun',
  ],
  output: ['maxArtifactFiles', 'maxArtifactBytesPerFile', 'maxTotalArtifactBytes'],
};

const TOP_LEVEL_FIELDS = ['version', 'status', 'identity', 'limits', 'evidenceDigest'] as const;

/** Design §25.13 candidate hard ceiling — provisional, disabled-build only. */
export const STRUCTURED_SLOT_PROFILE_CANDIDATE: StructuredSlotLimitsV1 = {
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
};

function invalid(reason: string): never {
  throw new Error(`${PLATFORM_PROFILE_INVALID}: ${reason}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectUnknownFields(value: Record<string, unknown>, known: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) invalid(`unknown field '${key}' at ${where}`);
  }
}

function positiveSafeInt(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    invalid(`${where} must be a positive safe integer`);
  }
  return value;
}

/** All 28 limits must be present, positive safe integers, exact field names. */
function assertPositiveLimitsShape(value: unknown): StructuredSlotLimitsV1 {
  if (!isPlainObject(value)) invalid('profile.limits must be a plain object');
  rejectUnknownFields(value, Object.keys(LIMIT_GROUPS), 'profile.limits');
  for (const [group, fields] of Object.entries(LIMIT_GROUPS)) {
    const groupValue = value[group];
    if (!isPlainObject(groupValue)) invalid(`profile.limits.${group} must be a plain object`);
    rejectUnknownFields(groupValue, fields, `profile.limits.${group}`);
    for (const field of fields) {
      positiveSafeInt(groupValue[field], `profile.limits.${group}.${field}`);
    }
  }
  return value as unknown as StructuredSlotLimitsV1;
}

/** Cross-field relations (spec §5 / design §7.6 / Task 4 compiler). */
function assertCrossFieldRelations(l: StructuredSlotLimitsV1): void {
  const gte = (label: string, a: number, b: number): void => {
    if (a < b) invalid(`${label} (${a}) must be >= ${b}`);
  };
  gte('attempt.maxValidatorInvocationsPerAttempt', l.attempt.maxValidatorInvocationsPerAttempt, l.validation.maxValidatorInvocationsPerGate);
  gte('attempt.maxAggregateValidatorCpuMsPerAttempt', l.attempt.maxAggregateValidatorCpuMsPerAttempt, l.validation.maxAggregateValidatorCpuMsPerGate);
  gte('attempt.maxAggregateValidatorWallClockMsPerAttempt', l.attempt.maxAggregateValidatorWallClockMsPerAttempt, l.validation.maxAggregateValidatorWallClockMsPerGate);
  gte('attempt.maxValidatorOutputBytesPerAttempt', l.attempt.maxValidatorOutputBytesPerAttempt, l.validation.maxValidatorOutputBytesPerGate);
  if (l.attempt.maxValidationRunsPerAttempt > l.attempt.maxSlotToolCallsPerAttempt) {
    invalid('attempt.maxValidationRunsPerAttempt must not exceed attempt.maxSlotToolCallsPerAttempt');
  }
  if (l.attempt.maxAttemptWallClockMs < l.attempt.maxAggregateValidatorWallClockMsPerAttempt) {
    invalid('attempt.maxAttemptWallClockMs must be >= attempt.maxAggregateValidatorWallClockMsPerAttempt');
  }
  if (l.draft.maxChangedSlots > l.structure.maxSlots) {
    invalid('draft.maxChangedSlots must not exceed structure.maxSlots');
  }
  if (l.output.maxArtifactBytesPerFile > l.output.maxTotalArtifactBytes) {
    invalid('output.maxArtifactBytesPerFile must not exceed output.maxTotalArtifactBytes');
  }
}

function deepFreezeLimits(limits: StructuredSlotLimitsV1): StructuredSlotLimitsV1 {
  const frozen = limits as unknown as Record<string, Record<string, number>>;
  for (const group of Object.values(frozen)) {
    Object.freeze(group);
  }
  return Object.freeze(limits);
}

/**
 * Exact shape validation of one profile file (spec §5). Accepts both
 * `provisional` (null evidenceDigest, disabled-build only) and `final`
 * (must reference a 64-hex integrated benchmark evidence digest) statuses;
 * production readiness is decided separately in runtime-capability.ts.
 */
export function validateStructuredPlatformProfileFile(value: unknown): StructuredPlatformProfileFileV1 {
  if (!isPlainObject(value)) invalid('profile must be a plain object');
  rejectUnknownFields(value, TOP_LEVEL_FIELDS, 'profile');
  if (value['version'] !== STRUCTURED_SLOT_PROFILE_VERSION) invalid('profile.version must be 1');
  const status = value['status'];
  if (status !== 'provisional' && status !== 'final') invalid('profile.status must be provisional|final');
  if (value['identity'] !== PROFILE_IDENTITY) invalid(`profile.identity must be '${PROFILE_IDENTITY}'`);
  const limits = assertPositiveLimitsShape(value['limits']);
  assertCrossFieldRelations(limits);
  const evidenceDigest = value['evidenceDigest'];
  if (evidenceDigest !== null && (typeof evidenceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(evidenceDigest))) {
    invalid('profile.evidenceDigest must be null or a 64-hex digest');
  }
  // spec §5: provisional must use a null evidence digest; final must
  // reference the integrated reference benchmark evidence.
  if (status === 'provisional' && evidenceDigest !== null) {
    invalid('provisional profile must use a null evidenceDigest');
  }
  if (status === 'final' && evidenceDigest === null) {
    invalid('final profile must reference integrated benchmark evidence');
  }
  return Object.freeze({
    version: STRUCTURED_SLOT_PROFILE_VERSION,
    status,
    identity: PROFILE_IDENTITY,
    limits: deepFreezeLimits(limits),
    evidenceDigest,
  });
}

/**
 * Loads and exact-validates one profile file. Reads a file — never an
 * environment variable — so there is no implicit fallback to bypass.
 */
export function loadStructuredPlatformProfile(path: string | URL): StructuredPlatformProfileFileV1 {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return validateStructuredPlatformProfileFile(raw);
}

/** Canonical SHA-256 of the whole exact profile file (capability.profileDigest). */
export function profileCanonicalDigest(profile: StructuredPlatformProfileFileV1): string {
  return canonicalJsonSha256(profile);
}

/**
 * The checked-in profile path. Node-environment module URLs resolve it
 * directly; browser-like (jsdom) module URLs fall back to the
 * workspace-relative location (tests always run from the workspace root).
 */
function checkedInProfilePath(): string | URL {
  try {
    return fileURLToPath(new URL('platform-profile-v1.json', import.meta.url));
  } catch {
    return resolve(process.cwd(), 'src', 'server', 'structured-slots', 'platform-profile-v1.json');
  }
}

/** The checked-in provisional profile, exact-validated at module load. */
export const STRUCTURED_SLOT_PLATFORM_PROFILE_V1: StructuredPlatformProfileFileV1 =
  loadStructuredPlatformProfile(checkedInProfilePath());

/** A template limits shape problem is a template contract failure (Task 4 code). */
function assertTemplateLimitsShape(value: unknown): StructuredSlotLimitsV1 {
  if (!isPlainObject(value)) throw new Error(`${SLOTS_CONTRACT_INVALID}: template limits must be a plain object`);
  rejectUnknownFields(value, Object.keys(LIMIT_GROUPS), 'template limits');
  for (const [group, fields] of Object.entries(LIMIT_GROUPS)) {
    const groupValue = value[group];
    if (!isPlainObject(groupValue)) {
      throw new Error(`${SLOTS_CONTRACT_INVALID}: template limits.${group} must be a plain object`);
    }
    rejectUnknownFields(groupValue, fields, `template limits.${group}`);
    for (const field of fields) {
      const v = groupValue[field];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
        throw new Error(`${SLOTS_CONTRACT_INVALID}: template limits.${group}.${field} must be a positive safe integer`);
      }
    }
  }
  return value as unknown as StructuredSlotLimitsV1;
}

/**
 * Template envelope vs platform hard ceiling (design §7.6). Every template
 * limit must be <= the profile field by field; a violation (including a
 * malformed template envelope) is `SLOTS_CONTRACT_INVALID` (never a silent
 * clamp). The profile arg is expected to be an already-validated profile
 * limits object; it is defensively exact-validated too.
 */
export function assertTemplateLimitsWithinProfile(
  templateLimits: StructuredSlotLimitsV1,
  profileLimits: StructuredSlotLimitsV1,
): void {
  const template = assertTemplateLimitsShape(templateLimits);
  const profile = assertPositiveLimitsShape(profileLimits);
  const templateFlat = template as unknown as Record<string, Record<string, number>>;
  const profileFlat = profile as unknown as Record<string, Record<string, number>>;
  for (const [group, fields] of Object.entries(LIMIT_GROUPS)) {
    for (const field of fields) {
      const t = templateFlat[group][field];
      const p = profileFlat[group][field];
      if (t > p) {
        throw new Error(`${SLOTS_CONTRACT_INVALID}: template limits.${group}.${field} (${t}) exceeds platform ceiling ${p}`);
      }
    }
  }
}
