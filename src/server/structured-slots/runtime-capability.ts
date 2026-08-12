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
import { canonicalJsonSha256 } from './canonical-json';
import {
  RELEASE_FINAL_PROFILE_PATH,
  RELEASE_PI_PREFLIGHT_CHARACTERIZATION,
  RELEASE_PROFILE_EVIDENCE_PATH,
  validateProfileEvidence,
  validateReleaseEvidence,
} from './structured-evidence-schema';

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
const REQUIRED_RELEASE_GATES = ['typecheck','unit-tests','build','e2e','structured-acceptance','forge-pi-slot-preflight'] as const;
const CAPABILITY_FIELDS = ['version', 'status', 'profileIdentity', 'profileDigest', 'evidenceDigest', 'requiredAbis'] as const;

function invalid(reason: string): never {
  throw new Error(`RUNTIME_CAPABILITY_INVALID: ${reason}`);
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
  rejectUnknownFields(value, CAPABILITY_FIELDS, 'capability');
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
  if (requiredAbis.length !== REQUIRED_ABIS.length || requiredAbis.some((abi, index) => abi !== REQUIRED_ABIS[index])) {
    invalid(`capability.requiredAbis must exactly equal ${REQUIRED_ABIS.join(',')}`);
  }
  if (status === 'disabled' && (profileIdentity !== null || profileDigest !== null || evidenceDigest !== null)) {
    invalid('a disabled capability must carry null profileIdentity/profileDigest/evidenceDigest');
  }
  if (status === 'enabled' && (profileIdentity !== PROFILE_IDENTITY || profileDigest === null || evidenceDigest === null)) {
    invalid('an enabled capability requires non-null profileIdentity/profileDigest/evidenceDigest');
  }
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
    validatedCapability.status === 'enabled' &&
    validatedProfile !== null &&
    validatedCapability.profileDigest !== profileCanonicalDigest(validatedProfile)
  ) {
    invalid('capability.profileDigest does not match the profile');
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
 * The checked-in production profile path (the exact final profile file an
 * enabled manifest references). Resolved the same way as the manifest path.
 */
function productionProfilePath(): string {
  try {
    return fileURLToPath(new URL('platform-profile-v1.json', import.meta.url));
  } catch {
    return resolve(process.cwd(), 'src', 'server', 'structured-slots', 'platform-profile-v1.json');
  }
}

export function productionEvidencePath(file: string): string {
  try {
    return fileURLToPath(new URL(`../../../docs/evidence/${file}`, import.meta.url));
  } catch {
    return resolve(process.cwd(), 'docs', 'evidence', file);
  }
}

export interface ProductionRuntimeFiles {
  manifestFile?: string | URL;
  profileFile?: string | URL;
  profileEvidenceFile?: string | URL;
  releaseEvidenceFile?: string | URL;
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
 * profileDigest against the canonical digest of that file. When no explicit
 * `profileFile` is supplied, the production default reads the checked-in
 * `platform-profile-v1.json` (the same file the promotion froze); a caller may
 * inject a different path only for tests.
 */
export function createProductionRuntimeEnvironment(
  profileFileOrFiles?: string | URL | ProductionRuntimeFiles,
): StructuredRuntimeEnvironmentV1 {
  const files: ProductionRuntimeFiles =
    typeof profileFileOrFiles === 'object' && !(profileFileOrFiles instanceof URL)
      ? profileFileOrFiles
      : { profileFile: profileFileOrFiles };
  const raw = JSON.parse(readFileSync(files.manifestFile ?? productionManifestPath(), 'utf8')) as unknown;
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
  const profileFileResolved = files.profileFile ?? productionProfilePath();
  const profile = validateProductionProfile(loadStructuredPlatformProfile(profileFileResolved));
  if (capability.profileDigest !== profileCanonicalDigest(profile)) {
    invalid('capability.profileDigest does not match the checked-in profile file');
  }
  const evidence = JSON.parse(readFileSync(files.profileEvidenceFile ?? productionEvidencePath('structured-slot-platform-profile-v1.json'), 'utf8')) as Record<string, unknown>;
  try { validateProfileEvidence(evidence); } catch (error) { invalid(`profile evidence invalid: ${error instanceof Error ? error.message : String(error)}`); }
  if (profile.evidenceDigest !== canonicalJsonSha256(evidence)) invalid('final profile evidenceDigest does not match profile evidence');
  const release = JSON.parse(readFileSync(files.releaseEvidenceFile ?? productionEvidencePath('structured-slot-release-v1.json'), 'utf8')) as unknown;
  if (!isPlainObject(release)) invalid('release evidence must be a plain object');
  try { validateReleaseEvidence(release, REQUIRED_RELEASE_GATES); } catch (error) { invalid(`release evidence invalid: ${error instanceof Error ? error.message : String(error)}`); }
  if (release['checkpointCommit'] !== evidence['gitCommit'] || release['sourceTreeDigest'] !== evidence['sourceTreeDigest'] || release['packageLockSha256'] !== evidence['packageLockSha256']) invalid('release evidence source facts do not match profile evidence');
  if (release['profileEvidencePath'] !== RELEASE_PROFILE_EVIDENCE_PATH || release['finalProfilePath'] !== RELEASE_FINAL_PROFILE_PATH || release['piPreflightCharacterization'] !== RELEASE_PI_PREFLIGHT_CHARACTERIZATION) invalid('release evidence frozen references are invalid');
  if (release['profileEvidenceDigest'] !== profile.evidenceDigest) invalid('release evidence profileEvidenceDigest does not match final profile');
  if (release['finalProfileDigest'] !== profileCanonicalDigest(profile)) invalid('release evidence finalProfileDigest does not match final profile');
  if (canonicalJsonSha256(release) !== capability.evidenceDigest) invalid('capability.evidenceDigest does not match release evidence');
  if (canonicalJsonSha256(release['requiredAbis']) !== canonicalJsonSha256([...REQUIRED_ABIS])) invalid('release evidence requiredAbis is invalid');
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
  const profile = validatePlatformProfile({
    version: 1,
    status: 'provisional',
    identity: PROFILE_IDENTITY,
    limits: STRUCTURED_SLOT_PROFILE_CANDIDATE,
    evidenceDigest: null,
  });
  const capability = validateRuntimeCapability({
    version: 1,
    status: 'enabled',
    profileIdentity: PROFILE_IDENTITY,
    profileDigest: profileCanonicalDigest(profile),
    evidenceDigest: '0'.repeat(64),
    requiredAbis: [...REQUIRED_ABIS],
  });
  return createRuntimeEnvironment(capability, profile);
}

/**
 * Test/dev-only convenience (Task 19): builds an EXPLICIT disabled environment
 * with a null profile. This is a PURE fixture — it never reads the checked-in
 * production manifest, so the identical test source passes before AND after the
 * Task 19 production promotion (spec §15 two-phase protocol). Only the release
 * command may assert the current checked-in phase.
 */
export function createDisabledRuntimeEnvironment(): StructuredRuntimeEnvironmentV1 {
  const capability = validateRuntimeCapability({
    version: 1,
    status: 'disabled',
    profileIdentity: null,
    profileDigest: null,
    evidenceDigest: null,
    requiredAbis: [...REQUIRED_ABIS],
  });
  return createRuntimeEnvironment(capability, null);
}
