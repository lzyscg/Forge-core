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
import {
  PROFILE_IDENTITY,
  STRUCTURED_SLOT_PROFILE_CANDIDATE,
  loadStructuredPlatformProfile,
  profileCanonicalDigest,
  validateStructuredPlatformProfileFile,
} from './platform-profile';
import type { StructuredPlatformProfileFileV1 } from './platform-profile';

/** Versioned runtime capability manifest (spec §5). */
export interface StructuredRuntimeCapabilityV1 {
  version: 1;
  status: 'disabled' | 'enabled';
  profileIdentity: 'forge-structured-runtime/v1' | null;
  profileDigest: string | null;
  evidenceDigest: string | null;
  requiredAbis: readonly string[];
}

/** Exact checked-in platform profile file (spec §5), canonical home in platform-profile.ts. */
export type { StructuredPlatformProfileFileV1 as StructuredPlatformProfileV1 } from './platform-profile';

/** The one immutable environment threaded through Catalog/cache/TaskStore. */
export interface StructuredRuntimeEnvironmentV1 {
  capability: StructuredRuntimeCapabilityV1;
  profile: StructuredPlatformProfileFileV1 | null;
}

/** Design §25.13 candidate hard ceiling — provisional, disabled-build only. */
export { STRUCTURED_SLOT_PROFILE_CANDIDATE as CANDIDATE_PROFILE_LIMITS_V1 } from './platform-profile';

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

/**
 * Exact shape validation of one platform profile (spec §5). Delegates to the
 * canonical validator in platform-profile.ts so the profile file shape and
 * its cross-field relations are owned by exactly one module.
 */
export function validatePlatformProfile(value: unknown): StructuredPlatformProfileFileV1 {
  return validateStructuredPlatformProfileFile(value);
}

/**
 * PRODUCTION capability validator (spec §5, Task 9 Step 6): a provisional
 * profile can never satisfy production readiness. Only an exact `final`
 * profile produced by the integrated reference benchmark (Task 19) qualifies.
 * Non-production paths (tests) may still build environments from provisional
 * profiles via `createRuntimeEnvironment`.
 */
export function validateProductionProfile(value: unknown): StructuredPlatformProfileFileV1 {
  const profile = validateStructuredPlatformProfileFile(value);
  if (profile.status !== 'final') {
    invalid('production readiness requires a final profile; a provisional profile cannot satisfy it');
  }
  return profile;
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
  profile: StructuredPlatformProfileFileV1 | null,
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
 *
 * Task 9 keeps the checked-in manifest disabled and returns a null profile. If
 * a future manifest is enabled (Task 19), the production capability validator
 * REQUIRES an exact final profile file — a provisional profile can never
 * satisfy production readiness — and cross-checks the capability's declared
 * profileDigest against the canonical digest of that file.
 */
export function createProductionRuntimeEnvironment(
  profileFile?: string | URL,
): StructuredRuntimeEnvironmentV1 {
  const raw = JSON.parse(readFileSync(productionManifestPath(), 'utf8')) as unknown;
  const capability = validateRuntimeCapability(raw);
  if (capability.status === 'disabled') {
    if (capability.profileIdentity !== null || capability.profileDigest !== null || capability.evidenceDigest !== null) {
      invalid('the checked-in production manifest must carry no final profile while disabled');
    }
    return Object.freeze({ capability, profile: null });
  }
  if (capability.profileIdentity !== PROFILE_IDENTITY) {
    invalid('an enabled production manifest must reference the structured runtime profile');
  }
  if (profileFile === undefined) {
    invalid('an enabled production manifest requires its exact final profile file');
  }
  const profile = validateProductionProfile(loadStructuredPlatformProfile(profileFile));
  if (capability.profileDigest !== null && capability.profileDigest !== profileCanonicalDigest(profile)) {
    invalid('capability.profileDigest does not match the checked-in profile file');
  }
  return Object.freeze({ capability, profile });
}

/**
 * True when a structured runtime environment is actually runnable: an enabled
 * capability WITH its matching non-null profile. A disabled capability (or an
 * enabled one whose profile is missing) means every structured entry point must
 * fail closed with `TEMPLATE_RUNTIME_UNAVAILABLE` (spec §5 / design O04/O05).
 * The scheduler and runner recheck this SAME immutable reference on every
 * start/resume/retry/answer and per structured Turn — never a second default
 * and never an environment-variable fallback.
 */
export function isStructuredRuntimeEnabled(
  environment: StructuredRuntimeEnvironmentV1 | undefined,
): boolean {
  return (
    environment !== undefined &&
    environment.capability.status === 'enabled' &&
    environment.profile !== null
  );
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
    limits: STRUCTURED_SLOT_PROFILE_CANDIDATE,
    evidenceDigest: null,
  });
  return createRuntimeEnvironment(capability, profile);
}
