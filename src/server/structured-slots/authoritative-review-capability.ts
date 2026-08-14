/**
 * Authoritative review capability gate (Task 5, spec §17/§4.3, design §23.2).
 *
 * `authoritative_review_v1` is an ADDITIONAL production capability that
 * starts DISABLED. A v2 task is runnable only when BOTH the existing base
 * structured runtime capability AND this capability are enabled with a final
 * profile whose digest is supported by matching evidence. The checked-in
 * production manifest starts `disabled` with a null profile; only the final
 * promotion (Task 25) may flip it to enabled with generated evidence —
 * production loading rejects test_only/provisional/missing/mismatched
 * evidence on every enabled path and never reads an environment variable.
 *
 * Dependency injection flows ONLY through constructor/options (design O05):
 * `createProductionAuthoritativeReviewEnvironment` is called once in main.ts
 * and the immutable `AuthoritativeReviewRuntimeEnvironmentV1` is threaded
 * through CoreService, TemplateCatalog/cache, TaskStore snapshot reopen,
 * scheduler, runner and every v2 service — never a second default and never a
 * module-local re-read. Tests inject the test-only environment through
 * `createAuthoritativeReviewTestEnvironment` (test-support only).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJsonSha256 } from './canonical-json';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';
import type { AuthoritativeReviewExecutionEligibilityV1 } from '../../shared/authoritative-review-v2';
import type {
  InstalledAssemblerHandlerIdentityV1,
  InstalledValidatorHandlerIdentityV1,
  AuthoritativeReviewProfileSnapshotV1Body,
} from './authoritative-review-profile';
import {
  AUTHORITATIVE_REVIEW_PROFILE_IDENTITY,
  profileCanonicalDigest,
  profileSnapshotRefOf,
  validateAuthoritativeReviewProfile,
  validateProductionAuthoritativeReviewProfile,
  loadAuthoritativeReviewProfileFile,
} from './authoritative-review-profile';
import { AuthoritativeReviewProfileArchive } from './authoritative-review-profile-archive';

/** Validation failure code shared by every capability/environment reject path. */
export const RUNTIME_CAPABILITY_INVALID = 'RUNTIME_CAPABILITY_INVALID';

/** The two v2 implementation ABIs (spec §5.2/§13.5). */
export const AUTHORITATIVE_REVIEW_REQUIRED_ABIS = ['forge-validator/v2', 'forge-assembler/v2'] as const;

/** The checked-in disabled production manifest file name. */
export const AUTHORITATIVE_REVIEW_CAPABILITY_FILE_NAME = 'authoritative-review-capability-v1.json' as const;

/** The checked-in profile file name (generated final profile after qualification). */
export const AUTHORITATIVE_REVIEW_PROFILE_FILE_NAME = 'authoritative-review-profile-v1.json' as const;

function invalid(reason: string): never {
  throw new Error(`${RUNTIME_CAPABILITY_INVALID}: ${reason}`);
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

/** A null or a 64-hex digest; rejects anything else. */
function optionalDigest(value: unknown, where: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    invalid(`${where} must be null or a 64-hex digest`);
  }
  return value;
}

/** Versioned authoritative-review capability manifest (spec §17). */
export interface AuthoritativeReviewCapabilityV1 {
  version: 1;
  status: 'disabled' | 'enabled';
  profileIdentity: typeof AUTHORITATIVE_REVIEW_PROFILE_IDENTITY | null;
  profileDigest: string | null;
  evidenceDigest: string | null;
  requiredAbis: readonly string[];
}

const CAPABILITY_FIELDS = ['version', 'status', 'profileIdentity', 'profileDigest', 'evidenceDigest', 'requiredAbis'] as const;

/** Exact shape validation of the capability manifest (disabled start, spec §17). */
export function validateAuthoritativeReviewCapability(value: unknown): AuthoritativeReviewCapabilityV1 {
  if (!isPlainObject(value)) invalid('capability must be a plain object');
  rejectUnknownFields(value, CAPABILITY_FIELDS, 'capability');
  if (value['version'] !== 1) invalid('capability.version must be 1');
  const status = value['status'];
  if (status !== 'disabled' && status !== 'enabled') invalid('capability.status must be disabled|enabled');
  const profileIdentity = value['profileIdentity'];
  if (profileIdentity !== null && profileIdentity !== AUTHORITATIVE_REVIEW_PROFILE_IDENTITY) {
    invalid(`capability.profileIdentity must be null or '${AUTHORITATIVE_REVIEW_PROFILE_IDENTITY}'`);
  }
  const profileDigest = optionalDigest(value['profileDigest'], 'capability.profileDigest');
  const evidenceDigest = optionalDigest(value['evidenceDigest'], 'capability.evidenceDigest');
  const requiredAbis = value['requiredAbis'];
  if (
    !Array.isArray(requiredAbis) ||
    requiredAbis.length !== AUTHORITATIVE_REVIEW_REQUIRED_ABIS.length ||
    requiredAbis.some((abi, index) => abi !== AUTHORITATIVE_REVIEW_REQUIRED_ABIS[index])
  ) {
    invalid(`capability.requiredAbis must exactly equal ${AUTHORITATIVE_REVIEW_REQUIRED_ABIS.join(',')}`);
  }
  if (status === 'disabled' && (profileIdentity !== null || profileDigest !== null || evidenceDigest !== null)) {
    invalid('a disabled capability must carry null profileIdentity/profileDigest/evidenceDigest');
  }
  if (
    status === 'enabled' &&
    (profileIdentity !== AUTHORITATIVE_REVIEW_PROFILE_IDENTITY || profileDigest === null || evidenceDigest === null)
  ) {
    invalid('an enabled capability requires non-null profileIdentity/profileDigest/evidenceDigest');
  }
  return Object.freeze({
    version: 1,
    status,
    profileIdentity,
    profileDigest,
    evidenceDigest,
    requiredAbis: [...requiredAbis],
  });
}

/** The installed allowlisted handler registry (spec §6.5/§13.5, design §9). */
export interface AuthoritativeReviewHandlerRegistryV1 {
  validators: readonly InstalledValidatorHandlerIdentityV1[];
  assembler: InstalledAssemblerHandlerIdentityV1;
}

function registryIdentityDigest(registry: AuthoritativeReviewHandlerRegistryV1): string {
  return canonicalJsonSha256({
    validators: [...registry.validators].map((entry) => ({
      handlerKey: entry.handlerKey,
      implementationDigest: entry.implementationDigest,
      moduleId: entry.moduleId,
      exportName: entry.exportName,
      trigger: entry.trigger,
      executionPhase: entry.executionPhase,
    })),
    assembler: {
      handlerKey: registry.assembler.handlerKey,
      implementationDigest: registry.assembler.implementationDigest,
      moduleId: registry.assembler.moduleId,
      exportName: registry.assembler.exportName,
    },
  });
}

function profileIdentityDigest(profile: AuthoritativeReviewProfileSnapshotV1Body): string {
  return canonicalJsonSha256({
    validators: [...profile.installedHandlers.validators].map((entry) => ({
      handlerKey: entry.handlerKey,
      implementationDigest: entry.implementationDigest,
      moduleId: entry.moduleId,
      exportName: entry.exportName,
      trigger: entry.trigger,
      executionPhase: entry.executionPhase,
    })),
    assembler: {
      handlerKey: profile.installedHandlers.assembler.handlerKey,
      implementationDigest: profile.installedHandlers.assembler.implementationDigest,
      moduleId: profile.installedHandlers.assembler.moduleId,
      exportName: profile.installedHandlers.assembler.exportName,
    },
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * The ONE immutable authoritative review runtime environment threaded through
 * Catalog/cache/TaskStore/scheduler/runner and every v2 service. `profile` is
 * the current installed profile (null while disabled); `profileSnapshotRef`
 * is its byte-exact snapshot ref; `handlerRegistry` is the installed allowlist;
 * `archive` holds the installed profile bytes by digest (historical reads
 * resolve archived task-bound profiles even after capability/profile changes).
 */
export interface AuthoritativeReviewRuntimeEnvironmentV1 {
  capability: AuthoritativeReviewCapabilityV1;
  profile: AuthoritativeReviewProfileSnapshotV1Body | null;
  profileSnapshotRef: BlobRefV2 | null;
  handlerRegistry: AuthoritativeReviewHandlerRegistryV1;
  archive: AuthoritativeReviewProfileArchive;
}

/**
 * Builds one immutable environment from validated parts. An enabled capability
 * requires a matching profile WITH the exact installed registry identities;
 * the profile is installed into the archive at construction. Both parts are
 * re-validated and deep-frozen so no unvalidated object can enter an
 * environment.
 */
export function createAuthoritativeReviewRuntimeEnvironment(
  capability: AuthoritativeReviewCapabilityV1,
  profile: AuthoritativeReviewProfileSnapshotV1Body | null,
  handlerRegistry: AuthoritativeReviewHandlerRegistryV1,
  archive: AuthoritativeReviewProfileArchive = new AuthoritativeReviewProfileArchive(),
): AuthoritativeReviewRuntimeEnvironmentV1 {
  const validatedCapability = validateAuthoritativeReviewCapability(capability);
  const validatedProfile = profile === null ? null : validateAuthoritativeReviewProfile(profile);
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
    validatedCapability.profileIdentity !== validatedProfile.profileIdentity
  ) {
    invalid('capability.profileIdentity does not match the profile identity');
  }
  if (validatedCapability.status === 'enabled' && validatedProfile !== null) {
    if (registryIdentityDigest(handlerRegistry) !== profileIdentityDigest(validatedProfile)) {
      invalid('the handler registry identities must exactly equal the installed profile registry identities');
    }
  }
  let profileSnapshotRef: BlobRefV2 | null = null;
  if (validatedProfile !== null) {
    profileSnapshotRef = archive.put(validatedProfile);
  }
  return deepFreeze({
    capability: validatedCapability,
    profile: validatedProfile,
    profileSnapshotRef,
    handlerRegistry: deepFreeze({
      validators: [...handlerRegistry.validators],
      assembler: { ...handlerRegistry.assembler },
    }),
    archive,
  });
}

/**
 * True when the authoritative runtime may execute v2 work: an enabled
 * capability WITH its matching non-null profile. A disabled capability (or an
 * enabled one whose profile is missing) means every v2 entry point fails
 * closed with `TEMPLATE_RUNTIME_UNAVAILABLE` (spec §17).
 */
export function isAuthoritativeReviewRunnable(
  environment: AuthoritativeReviewRuntimeEnvironmentV1 | undefined,
): boolean {
  return (
    environment !== undefined &&
    environment.capability.status === 'enabled' &&
    environment.profile !== null &&
    environment.profileSnapshotRef !== null
  );
}

/** The current profile digest of one environment, or null when disabled. */
export function currentAuthoritativeReviewProfileDigest(
  environment: AuthoritativeReviewRuntimeEnvironmentV1 | undefined,
): string | null {
  if (environment === undefined || environment.profile === null) {
    return null;
  }
  return environment.profile.profileDigest;
}

/** Frozen ABI identities of one environment, for availability checks. */
export function requiredAuthoritativeReviewAbiAvailable(
  environment: AuthoritativeReviewRuntimeEnvironmentV1 | undefined,
  availableAbis: ReadonlySet<string>,
): boolean {
  if (environment === undefined) {
    return false;
  }
  return environment.capability.requiredAbis.every((abi) => availableAbis.has(abi));
}

/**
 * Separately derived execution eligibility (spec §4.3): a reversible,
 * non-event derivation of the frozen vs current profile/ABI — never
 * TaskStatus, never rewritten into event history. Read/genesis/diagnosis/
 * delete do not require eligibility; any mutation that would create execution
 * events does. A blocked task retains its underlying event status, WorkItem
 * disposition, timers and durable wakeup identity.
 */
export function deriveAuthoritativeReviewExecutionEligibility(input: {
  frozenProfileDigest: string;
  baseStructuredCapabilityEnabled: boolean;
  currentCapability: AuthoritativeReviewCapabilityV1;
  currentProfileDigest: string | null;
  requiredAbisAvailable: boolean;
}): AuthoritativeReviewExecutionEligibilityV1 {
  const frozenProfileDigest = input.frozenProfileDigest;
  if (!input.baseStructuredCapabilityEnabled) {
    return {
      state: 'blocked',
      reason: 'base_capability_disabled',
      frozenProfileDigest,
      currentProfileDigest: input.currentProfileDigest,
    };
  }
  if (input.currentCapability.status !== 'enabled' || input.currentProfileDigest === null) {
    return {
      state: 'blocked',
      reason: 'authoritative_capability_disabled',
      frozenProfileDigest,
      currentProfileDigest: input.currentProfileDigest,
    };
  }
  if (input.currentProfileDigest !== frozenProfileDigest) {
    return {
      state: 'blocked',
      reason: 'profile_digest_mismatch',
      frozenProfileDigest,
      currentProfileDigest: input.currentProfileDigest,
    };
  }
  if (!input.requiredAbisAvailable) {
    return {
      state: 'blocked',
      reason: 'required_abi_unavailable',
      frozenProfileDigest,
      currentProfileDigest: input.currentProfileDigest,
    };
  }
  return {
    state: 'eligible',
    frozenProfileDigest,
    currentProfileDigest: input.currentProfileDigest as string,
  };
}

/* -------------------- production manifest loading -------------------- */

function urlPathOf(relative: string): string {
  try {
    return fileURLToPath(new URL(relative, import.meta.url));
  } catch {
    return resolve(process.cwd(), 'src', 'server', 'structured-slots', relative);
  }
}

/** The checked-in production manifest path (disabled until final promotion). */
export function authoritativeReviewCapabilityManifestPath(): string {
  return urlPathOf(AUTHORITATIVE_REVIEW_CAPABILITY_FILE_NAME);
}

/** The checked-in profile file path (final profile generated at qualification). */
export function authoritativeReviewProfileFilePath(): string {
  return urlPathOf(AUTHORITATIVE_REVIEW_PROFILE_FILE_NAME);
}

/** The production evidence file path (generated at qualification, Task 25). */
export function authoritativeReviewEvidencePath(file: string): string {
  const workspaceCandidate = resolve(process.cwd(), 'docs', 'evidence', file);
  try {
    const moduleCandidate = fileURLToPath(new URL(`../../../docs/evidence/${file}`, import.meta.url));
    return existsSync(moduleCandidate) ? moduleCandidate : workspaceCandidate;
  } catch {
    return workspaceCandidate;
  }
}

export interface ProductionAuthoritativeReviewFiles {
  manifestFile?: string | URL;
  profileFile?: string | URL;
  evidenceFile?: string | URL;
}

/**
 * The production default environment: reads and validates the exact checked-in
 * manifest, which MUST start `disabled` with no profile. Reads files — never
 * an environment variable — so there is no fallback to bypass.
 *
 * An enabled manifest (future promotion) is fail-closed: it requires the
 * exact final profile file with matching canonical digest/identity, and
 * matching evidence; test_only/provisional profiles, missing files, mismatched
 * digests and missing evidence all reject the load.
 */
export function createProductionAuthoritativeReviewEnvironment(
  filesOrManifest?: string | URL | ProductionAuthoritativeReviewFiles,
): AuthoritativeReviewRuntimeEnvironmentV1 {
  const files: ProductionAuthoritativeReviewFiles =
    typeof filesOrManifest === 'object' && !(filesOrManifest instanceof URL)
      ? filesOrManifest
      : { manifestFile: filesOrManifest };
  const raw = JSON.parse(readFileSync(files.manifestFile ?? authoritativeReviewCapabilityManifestPath(), 'utf8')) as unknown;
  const capability = validateAuthoritativeReviewCapability(raw);
  if (capability.status === 'disabled') {
    if (capability.profileIdentity !== null || capability.profileDigest !== null || capability.evidenceDigest !== null) {
      invalid('the checked-in production manifest must carry no profile while disabled');
    }
    // Task 5: no production allowlist exists yet; a disabled environment keeps
    // an empty registry and is only available for historical read projection.
    return createAuthoritativeReviewRuntimeEnvironment(capability, null, {
      validators: [],
      assembler: {
        handlerKey: '',
        implementationDigest: '0'.repeat(64),
        moduleId: '',
        exportName: '',
      },
    });
  }
  if (capability.profileIdentity !== AUTHORITATIVE_REVIEW_PROFILE_IDENTITY) {
    invalid('an enabled production manifest must reference the authoritative review profile');
  }
  const profileFile = files.profileFile ?? authoritativeReviewProfileFilePath();
  const profile = validateProductionAuthoritativeReviewProfile(loadAuthoritativeReviewProfileFile(profileFile));
  if (capability.profileDigest !== profileCanonicalDigest(profile)) {
    invalid('capability.profileDigest does not match the checked-in profile file');
  }
  const evidenceFile = files.evidenceFile ?? authoritativeReviewEvidencePath('authoritative-review-v1.json');
  let evidence: unknown;
  try {
    evidence = JSON.parse(readFileSync(evidenceFile, 'utf8')) as unknown;
  } catch {
    invalid('the authoritative review evidence file is missing or unreadable');
  }
  if (canonicalJsonSha256(evidence) !== capability.evidenceDigest) {
    invalid('capability.evidenceDigest does not match the authoritative review evidence');
  }
  const registry: AuthoritativeReviewHandlerRegistryV1 = {
    validators: [...profile.installedHandlers.validators],
    assembler: { ...profile.installedHandlers.assembler },
  };
  return createAuthoritativeReviewRuntimeEnvironment(capability, profile, registry);
}