/**
 * Structured runtime capability gate (Task 5, spec §5 / design O04/O05).
 *
 * The structured runtime is NOT granted by TurnContract/schema version
 * compatibility. Production Loader/TemplateCatalog, cache reopen, task
 * snapshot creation and (Task 17) the Scheduler all check the same immutable
 * `StructuredRuntimeEnvironmentV1 = { capability, profile }`. The checked-in
 * production manifest starts `disabled` with no final profile; only the final
 * acceptance task (Task 19) may flip it to enabled with the integrated
 * benchmark evidence.
 *
 * Dependency injection flows ONLY through constructor/options — never an
 * environment-variable fallback. Tests inject a matching enabled capability +
 * provisional test profile through `createRuntimeEnvironment`.
 *
 * This module carries the profile hard-ceiling candidates of design §25.13 as
 * a provisional constant: the first deployment profile can only be frozen by
 * the reference-runner benchmark evidence (design §25.13 / O08), never by
 * casually measured numbers.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StructuredSlotLimitsV1 } from '../../shared/structured-slots';

/** Versioned runtime capability manifest (spec §5). */
export interface StructuredRuntimeCapabilityV1 {
  version: 1;
  status: 'disabled' | 'enabled';
  profileIdentity: 'forge-structured-runtime/v1' | null;
  profileDigest: string | null;
  evidenceDigest: string | null;
  requiredAbis: readonly string[];
}

/** Exact checked-in platform profile file (spec §5). */
export interface StructuredPlatformProfileV1 {
  version: 1;
  status: 'provisional' | 'final';
  identity: 'forge-structured-runtime/v1';
  limits: StructuredSlotLimitsV1;
  evidenceDigest: string | null;
}

/** The one immutable environment threaded through Catalog/cache/TaskStore. */
export interface StructuredRuntimeEnvironmentV1 {
  capability: StructuredRuntimeCapabilityV1;
  profile: StructuredPlatformProfileV1 | null;
}

/** Design §25.13 candidate hard ceiling — provisional, disabled-build only. */
export const CANDIDATE_PROFILE_LIMITS_V1: StructuredSlotLimitsV1 = {
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

const PROFILE_IDENTITY = 'forge-structured-runtime/v1';

const REQUIRED_ABIS = ['forge-validator/v1', 'forge-assembler/v1'] as const;

function invalid(reason: string): never {
  throw new Error(`RUNTIME_CAPABILITY_INVALID: ${reason}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function nonNullStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalid(`${where} must be a non-empty string array`);
  }
  if (!value.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    invalid(`${where} must contain only non-empty strings`);
  }
  return [...value];
}

/** A null or a 64-hex digest; rejects anything else. */
function optionalDigest(value: unknown, where: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    invalid(`${where} must be null or a 64-hex digest`);
  }
  return value;
}

function assertPositiveLimitsShape(value: unknown): void {
  if (!isPlainObject(value)) invalid('profile.limits must be a plain object');
  const flat = (value as unknown) as Record<string, Record<string, unknown>>;
  const groupNames = Object.keys(flat);
  if (groupNames.length === 0) invalid('profile.limits must declare limit groups');
  for (const group of groupNames) {
    if (!isPlainObject(flat[group])) invalid(`profile.limits.${group} must be a plain object`);
    for (const [field, numberValue] of Object.entries(flat[group])) {
      if (
        typeof numberValue !== 'number' ||
        !Number.isSafeInteger(numberValue) ||
        numberValue <= 0
      ) {
        invalid(`profile.limits.${group}.${field} must be a positive safe integer`);
      }
    }
  }
}

/** Exact shape validation of the capability manifest (spec §5). */
export function validateRuntimeCapability(value: unknown): StructuredRuntimeCapabilityV1 {
  if (!isPlainObject(value)) invalid('capability must be a plain object');
  if (value['version'] !== 1) invalid('capability.version must be 1');
  const status = value['status'];
  if (status !== 'disabled' && status !== 'enabled') invalid('capability.status must be disabled|enabled');
  const profileIdentity = value['profileIdentity'];
  if (profileIdentity !== null && profileIdentity !== PROFILE_IDENTITY) {
    invalid(`capability.profileIdentity must be null or '${PROFILE_IDENTITY}'`);
  }
  const profileDigest = optionalDigest(value['profileDigest'], 'capability.profileDigest');
  const evidenceDigest = optionalDigest(value['evidenceDigest'], 'capability.evidenceDigest');
  const requiredAbis = nonNullStringArray(value['requiredAbis'], 'capability.requiredAbis');
  return Object.freeze({
    version: 1,
    status,
    profileIdentity,
    profileDigest,
    evidenceDigest,
    requiredAbis,
  });
}

/** Exact shape validation of one platform profile (spec §5). */
export function validatePlatformProfile(value: unknown): StructuredPlatformProfileV1 {
  if (!isPlainObject(value)) invalid('profile must be a plain object');
  if (value['version'] !== 1) invalid('profile.version must be 1');
  const status = value['status'];
  if (status !== 'provisional' && status !== 'final') invalid('profile.status must be provisional|final');
  if (value['identity'] !== PROFILE_IDENTITY) invalid(`profile.identity must be '${PROFILE_IDENTITY}'`);
  assertPositiveLimitsShape(value['limits']);
  const evidenceDigest = value['evidenceDigest'];
  if (evidenceDigest !== null && (typeof evidenceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(evidenceDigest))) {
    invalid('profile.evidenceDigest must be null or a 64-hex digest');
  }
  // provisional must carry a null evidence digest (spec §5).
  if (status === 'provisional' && evidenceDigest !== null) {
    invalid('provisional profile must use a null evidenceDigest');
  }
  if (status === 'final' && evidenceDigest === null) {
    invalid('final profile must reference integrated benchmark evidence');
  }
  return Object.freeze({
    version: 1,
    status,
    identity: PROFILE_IDENTITY,
    limits: Object.freeze(value['limits'] as StructuredSlotLimitsV1),
    evidenceDigest,
  });
}

/**
 * Builds one immutable environment from validated parts. An enabled capability
 * requires a matching profile; the profile identity must agree with the
 * capability's declared profileIdentity when one is set. Both parts are
 * re-validated and deep-frozen so no unvalidated object can enter an
 * environment.
 */
export function createRuntimeEnvironment(
  capability: StructuredRuntimeCapabilityV1,
  profile: StructuredPlatformProfileV1 | null,
): StructuredRuntimeEnvironmentV1 {
  const validatedCapability = validateRuntimeCapability(capability);
  const validatedProfile = profile === null ? null : validatePlatformProfile(profile);
  if (validatedCapability.status === 'enabled' && validatedProfile === null) {
    invalid('an enabled capability requires a matching profile');
  }
  if (
    validatedProfile !== null &&
    validatedCapability.profileIdentity !== null &&
    validatedCapability.profileIdentity !== validatedProfile.identity
  ) {
    invalid('capability.profileIdentity does not match the profile identity');
  }
  return Object.freeze({ capability: validatedCapability, profile: validatedProfile });
}

/**
 * The checked-in production manifest path. Node-environment module URLs resolve
 * it directly; browser-like (jsdom) module URLs fall back to the
 * workspace-relative location (tests always run from the workspace root).
 */
function productionManifestPath(): string {
  try {
    return fileURLToPath(new URL('runtime-capability-v1.json', import.meta.url));
  } catch {
    return resolve(process.cwd(), 'src', 'server', 'structured-slots', 'runtime-capability-v1.json');
  }
}

/**
 * The production default environment: reads and validates the exact checked-in
 * manifest, which must start `disabled` with no final profile. Reads a file —
 * never an environment variable — so there is no fallback to bypass.
 */
export function createProductionRuntimeEnvironment(): StructuredRuntimeEnvironmentV1 {
  const raw = JSON.parse(readFileSync(productionManifestPath(), 'utf8')) as unknown;
  const capability = validateRuntimeCapability(raw);
  if (capability.status !== 'disabled') {
    invalid('the checked-in production manifest must start disabled');
  }
  if (capability.profileIdentity !== null || capability.profileDigest !== null || capability.evidenceDigest !== null) {
    invalid('the checked-in production manifest must carry no final profile');
  }
  return Object.freeze({ capability, profile: null });
}

/**
 * Test/dev-only convenience (design §5 / O08): builds a matching enabled
 * environment with the provisional candidate profile. Production callers never
 * use this — explicit injection only, never an implicit fallback.
 */
export function createTestRuntimeEnvironment(): StructuredRuntimeEnvironmentV1 {
  const capability = validateRuntimeCapability({
    version: 1,
    status: 'enabled',
    profileIdentity: PROFILE_IDENTITY,
    profileDigest: null,
    evidenceDigest: null,
    requiredAbis: [...REQUIRED_ABIS],
  });
  const profile = validatePlatformProfile({
    version: 1,
    status: 'provisional',
    identity: PROFILE_IDENTITY,
    limits: CANDIDATE_PROFILE_LIMITS_V1,
    evidenceDigest: null,
  });
  return createRuntimeEnvironment(capability, profile);
}
