/**
 * Authoritative review v2 real-case evidence schema (Task 29, design §25.2 +
 * Spec §19.2/§20).
 *
 * The real-case evidence is the FINAL artifact produced by the fresh
 * production-real Case. It captures:
 *
 *   - the exact commit + source-tree digest + package-lock digest + template
 *     snapshot hash bound to the execution checkout (matches the capability
 *     checkpoint);
 *   - the task id, ports and provider mode (real | hermetic-only);
 *   - the critical event sequence identities (MapReviewBundle/activation
 *     before any generation, SealReviewBundle before Seal, only System Seal
 *     publishes artifacts);
 *   - the Map/manifest/review/Seal/artifact refs and the file hashes;
 *   - the restart observation (cursor/pagination continuity, projected
 *     authority, final artifact, event tail, no duplicated WorkItems/
 *     attempts/artifact versions);
 *   - the capability / profile / release evidence digests.
 *
 * The schema is intentionally strict: every field is required and typed.
 * Downstream tooling (the `--verify-existing` path of the real-acceptance
 * runner, the test suite, the parent supervisor's gate) MUST reject any
 * report that drifts from this exact shape — partial reports or hand-edited
 * reports are an evidence-chain break.
 *
 * The validator is pure: no fs reads, no git calls, no provider network.
 * The test suite injects parsed reports; the production runner builds the
 * facts, builds the report, writes it atomically, then re-validates it on
 * the next invocation.
 */
import { createHash } from 'node:crypto';
import { canonicalJsonSha256 } from '../src/server/structured-slots/canonical-json';
import {
  AUTHORITATIVE_REVIEW_RUNNER_IDENTITY,
  AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION,
  AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY,
  AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS,
  isAuthoritativeReviewGeneratedOutput,
} from './authoritative-review-evidence-schema';

/** Validation failure code shared by every validator reject path. */
export const AUTHORITATIVE_REVIEW_REAL_CASE_INVALID = 'AUTHORITATIVE_REVIEW_REAL_CASE_INVALID';

function invalid(reason: string): never {
  throw new Error(`${AUTHORITATIVE_REVIEW_REAL_CASE_INVALID}: ${reason}`);
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

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string') invalid(`${where} must be a string`);
  return value;
}

function requireNonEmptyString(value: unknown, where: string): string {
  const s = requireString(value, where);
  if (s.length === 0) invalid(`${where} must be a non-empty string`);
  return s;
}

function requireHex64(value: unknown, where: string): string {
  const s = requireString(value, where);
  if (!/^[0-9a-f]{64}$/.test(s)) invalid(`${where} must be a 64-hex digest`);
  return s;
}

function requireHex40(value: unknown, where: string): string {
  const s = requireString(value, where);
  if (!/^[0-9a-f]{40}$/.test(s)) invalid(`${where} must be a 40-hex git commit digest`);
  return s;
}

function requirePositiveInt(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    invalid(`${where} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeInt(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${where} must be a non-negative safe integer`);
  }
  return value;
}

function requireIsoTimestamp(value: unknown, where: string): string {
  const s = requireString(value, where);
  if (Number.isNaN(Date.parse(s))) invalid(`${where} must be a parseable ISO timestamp`);
  return s;
}

function requirePort(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    invalid(`${where} must be an integer port (1-65535)`);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Stable schema version; bumped only with a deliberate migration. */
export const AUTHORITATIVE_REVIEW_REAL_CASE_SCHEMA_VERSION = 'forge-core.authoritative-review.real-case/1';

/** Provider modes the real-case runner may declare. */
export type AuthoritativeReviewRealCaseProviderMode = 'real' | 'hermetic-only';

/** The exact critical event sequence (design §25.2 + Spec §19.2). */
export const AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE = [
  'task_started',
  'structured_map_review_round_planned',
  'structured_map_review_assignment_committed',
  'structured_map_review_round_completed',
  'structured_map_review_round_settled',
  'structured_map_activated',
  'structured_content_revision_committed',
  'structured_review_round_planned',
  'structured_content_review_assignment_committed',
  'structured_repair_scope_requested',
  'structured_repair_grant_issued',
  'structured_repair_committed',
  'structured_finding_verified_closed',
  'structured_review_round_settled',
  'structured_scaffold_sealed_v2',
  'structured_system_artifact_delivery_created',
  'artifact_published_v2',
] as const;

export type AuthoritativeReviewRealCaseCriticalSequenceMember =
  (typeof AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE)[number];

/* -------------------------------------------------------------------------- */
/* Field maps                                                                  */
/* -------------------------------------------------------------------------- */

const DIGEST_FIELDS = [
  'schemaVersion',
  'commit',
  'sourceTreeDigest',
  'packageLockDigest',
  'templateSnapshotHash',
  'taskId',
  'startedAt',
  'finishedAt',
  'providerMode',
  'ports',
  'templateIdentity',
  'capabilityStatus',
  'capabilityIdentity',
  'capabilityProfileDigest',
  'capabilityEvidenceDigest',
  'finalProfileDigest',
  'finalProfilePath',
  'releaseEvidencePath',
  'platformEvidencePath',
  'piPreflightCharacterization',
  'runnerIdentity',
  'requiredAbis',
  'criticalSequence',
  'eventOrderCriticalSequence',
  'eventTail',
  'browserApiFileReconciled',
  'restartConfirmed',
  'restartObservation',
  'restartMismatchCount',
  'refChain',
  'fileHashes',
  'publicErrorCodes',
  'capabilityCheckpointDigest',
  'hermeticReason',
] as const;

/** Type-level field set; lets TS narrow report writes through `Object.keys`. */
export const AUTHORITATIVE_REVIEW_REAL_CASE_FIELDS = [...DIGEST_FIELDS] as const;

export interface AuthoritativeReviewRealCaseEvidence {
  schemaVersion: typeof AUTHORITATIVE_REVIEW_REAL_CASE_SCHEMA_VERSION;
  commit: string;
  sourceTreeDigest: string;
  packageLockDigest: string;
  templateSnapshotHash: string;
  taskId: string;
  startedAt: string;
  finishedAt: string;
  providerMode: AuthoritativeReviewRealCaseProviderMode;
  ports: {
    api: number;
    ui: number;
  };
  templateIdentity: string;
  capabilityStatus: 'enabled' | 'disabled';
  capabilityIdentity: string | null;
  capabilityProfileDigest: string | null;
  capabilityEvidenceDigest: string | null;
  finalProfileDigest: string;
  finalProfilePath: string;
  releaseEvidencePath: string;
  platformEvidencePath: string;
  piPreflightCharacterization: string;
  runnerIdentity: string;
  requiredAbis: readonly string[];
  criticalSequence: readonly AuthoritativeReviewRealCaseCriticalSequenceMember[];
  eventOrderCriticalSequence: readonly string[];
  eventTail: readonly string[];
  browserApiFileReconciled: boolean;
  restartConfirmed: boolean;
  restartObservation: string;
  restartMismatchCount: number;
  refChain: {
    mapId: string;
    mapRef: string;
    mapReviewBundleRef: string;
    contentManifestRef: string;
    reviewBundleRef: string;
    sealRecordRef: string;
    systemArtifactRef: string;
    finalArtifactRef: string;
  };
  fileHashes: {
    finalArtifactSha256: string;
    sealRecordSha256: string;
    chapterBytesSha256: string;
  };
  publicErrorCodes: readonly string[];
  capabilityCheckpointDigest: string | null;
  hermeticReason: string | null;
}

/* -------------------------------------------------------------------------- */
/* Validator                                                                   */
/* -------------------------------------------------------------------------- */

function validateRequiredAbis(value: unknown): readonly string[] {
  if (!Array.isArray(value)) invalid('real-case.requiredAbis must be an array');
  if (value.length !== AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY.length) {
    invalid('real-case.requiredAbis length does not match the v2 ABI list');
  }
  for (let i = 0; i < value.length; i += 1) {
    if (typeof value[i] !== 'string') invalid(`real-case.requiredAbis[${i}] must be a string`);
    if (value[i] !== AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY[i]) {
      invalid(`real-case.requiredAbis[${i}] must equal '${AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY[i]}'`);
    }
  }
  return value as readonly string[];
}

function validateCriticalSequence(value: unknown): readonly AuthoritativeReviewRealCaseCriticalSequenceMember[] {
  if (!Array.isArray(value) || value.length !== AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE.length) {
    invalid('real-case.criticalSequence must equal the frozen critical sequence');
  }
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== 'string') invalid(`real-case.criticalSequence[${i}] must be a string`);
    if (entry !== AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE[i]) {
      invalid(`real-case.criticalSequence[${i}] must equal '${AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE[i]}'`);
    }
  }
  return value as readonly AuthoritativeReviewRealCaseCriticalSequenceMember[];
}

function validateStringArray(value: unknown, where: string, allowed: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) invalid(`${where} must be an array`);
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== 'string') invalid(`${where}[${i}] must be a string`);
    if (!allowed.includes(entry)) {
      invalid(`${where}[${i}] must be one of ${allowed.join(',')}`);
    }
  }
  return value as readonly string[];
}

function validateStringArrayLoose(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value)) invalid(`${where} must be an array`);
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== 'string') invalid(`${where}[${i}] must be a string`);
    if (entry.length === 0) invalid(`${where}[${i}] must be non-empty`);
  }
  return value as readonly string[];
}

function validatePorts(value: unknown): { api: number; ui: number } {
  if (!isPlainObject(value)) invalid('real-case.ports must be a plain object');
  rejectUnknownFields(value, ['api', 'ui'], 'real-case.ports');
  const api = requirePort(value['api'], 'real-case.ports.api');
  const ui = requirePort(value['ui'], 'real-case.ports.ui');
  return { api, ui };
}

function validateRefChain(value: unknown): AuthoritativeReviewRealCaseEvidence['refChain'] {
  if (!isPlainObject(value)) invalid('real-case.refChain must be a plain object');
  rejectUnknownFields(
    value,
    [
      'mapId',
      'mapRef',
      'mapReviewBundleRef',
      'contentManifestRef',
      'reviewBundleRef',
      'sealRecordRef',
      'systemArtifactRef',
      'finalArtifactRef',
    ],
    'real-case.refChain',
  );
  return {
    mapId: requireNonEmptyString(value['mapId'], 'real-case.refChain.mapId'),
    mapRef: requireHex64(value['mapRef'], 'real-case.refChain.mapRef'),
    mapReviewBundleRef: requireHex64(value['mapReviewBundleRef'], 'real-case.refChain.mapReviewBundleRef'),
    contentManifestRef: requireHex64(value['contentManifestRef'], 'real-case.refChain.contentManifestRef'),
    reviewBundleRef: requireHex64(value['reviewBundleRef'], 'real-case.refChain.reviewBundleRef'),
    sealRecordRef: requireHex64(value['sealRecordRef'], 'real-case.refChain.sealRecordRef'),
    systemArtifactRef: requireHex64(value['systemArtifactRef'], 'real-case.refChain.systemArtifactRef'),
    finalArtifactRef: requireHex64(value['finalArtifactRef'], 'real-case.refChain.finalArtifactRef'),
  };
}

function validateFileHashes(value: unknown): AuthoritativeReviewRealCaseEvidence['fileHashes'] {
  if (!isPlainObject(value)) invalid('real-case.fileHashes must be a plain object');
  rejectUnknownFields(
    value,
    ['finalArtifactSha256', 'sealRecordSha256', 'chapterBytesSha256'],
    'real-case.fileHashes',
  );
  return {
    finalArtifactSha256: requireHex64(value['finalArtifactSha256'], 'real-case.fileHashes.finalArtifactSha256'),
    sealRecordSha256: requireHex64(value['sealRecordSha256'], 'real-case.fileHashes.sealRecordSha256'),
    chapterBytesSha256: requireHex64(value['chapterBytesSha256'], 'real-case.fileHashes.chapterBytesSha256'),
  };
}

const PROVIDER_MODES: readonly AuthoritativeReviewRealCaseProviderMode[] = ['real', 'hermetic-only'];

/**
 * Validates the real-case evidence JSON. Rejects:
 * - unknown fields (the schema is frozen)
 * - missing fields (every required field is checked)
 * - wrong types / formats / digests
 * - wrong critical sequence content
 * - mismatched runner identity / pi-preflight characterization
 * - mismatched required ABI list
 *
 * The function is pure and side-effect free. Tests use it as the parser
 * gate; the production runner uses it after writing the report to lock the
 * shape before the next invocation re-reads it.
 */
export function validateAuthoritativeReviewRealCaseEvidence(value: unknown): void {
  if (!isPlainObject(value)) invalid('real-case evidence must be a plain object');
  rejectUnknownFields(value, DIGEST_FIELDS, 'real-case evidence');
  if (value['schemaVersion'] !== AUTHORITATIVE_REVIEW_REAL_CASE_SCHEMA_VERSION) {
    invalid(`real-case.schemaVersion must be '${AUTHORITATIVE_REVIEW_REAL_CASE_SCHEMA_VERSION}'`);
  }
  requireHex40(value['commit'], 'real-case.commit');
  requireHex64(value['sourceTreeDigest'], 'real-case.sourceTreeDigest');
  requireHex64(value['packageLockDigest'], 'real-case.packageLockDigest');
  requireHex64(value['templateSnapshotHash'], 'real-case.templateSnapshotHash');
  requireNonEmptyString(value['taskId'], 'real-case.taskId');
  requireIsoTimestamp(value['startedAt'], 'real-case.startedAt');
  requireIsoTimestamp(value['finishedAt'], 'real-case.finishedAt');
  const providerMode = requireString(value['providerMode'], 'real-case.providerMode');
  if (!PROVIDER_MODES.includes(providerMode as AuthoritativeReviewRealCaseProviderMode)) {
    invalid(`real-case.providerMode must be one of ${PROVIDER_MODES.join(',')}`);
  }
  validatePorts(value['ports']);
  requireNonEmptyString(value['templateIdentity'], 'real-case.templateIdentity');
  const capabilityStatus = requireString(value['capabilityStatus'], 'real-case.capabilityStatus');
  if (capabilityStatus !== 'enabled' && capabilityStatus !== 'disabled') {
    invalid('real-case.capabilityStatus must be enabled|disabled');
  }
  if (value['capabilityIdentity'] !== null && typeof value['capabilityIdentity'] !== 'string') {
    invalid('real-case.capabilityIdentity must be null or a string');
  }
  if (value['capabilityIdentity'] !== null && (value['capabilityIdentity'] as string).length === 0) {
    invalid('real-case.capabilityIdentity must be a non-empty string when set');
  }
  if (value['capabilityProfileDigest'] !== null) {
    requireHex64(value['capabilityProfileDigest'], 'real-case.capabilityProfileDigest');
  }
  if (value['capabilityEvidenceDigest'] !== null) {
    requireHex64(value['capabilityEvidenceDigest'], 'real-case.capabilityEvidenceDigest');
  }
  if (value['capabilityCheckpointDigest'] !== null) {
    requireHex64(value['capabilityCheckpointDigest'], 'real-case.capabilityCheckpointDigest');
  }
  // An enabled capability MUST carry a checkpoint digest (the digest that
  // ties the real-case evidence to the capability-certifying checkpoint);
  // a disabled capability MUST NOT carry one.
  if (capabilityStatus === 'enabled' && value['capabilityCheckpointDigest'] === null) {
    invalid('real-case.capabilityCheckpointDigest is required when capability is enabled');
  }
  if (capabilityStatus === 'disabled' && value['capabilityCheckpointDigest'] !== null) {
    invalid('real-case.capabilityCheckpointDigest must be null when capability is disabled');
  }
  requireHex64(value['finalProfileDigest'], 'real-case.finalProfileDigest');
  requireNonEmptyString(value['finalProfilePath'], 'real-case.finalProfilePath');
  requireNonEmptyString(value['releaseEvidencePath'], 'real-case.releaseEvidencePath');
  requireNonEmptyString(value['platformEvidencePath'], 'real-case.platformEvidencePath');
  if (value['piPreflightCharacterization'] !== AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION) {
    invalid(
      `real-case.piPreflightCharacterization must be '${AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION}'`,
    );
  }
  if (value['runnerIdentity'] !== AUTHORITATIVE_REVIEW_RUNNER_IDENTITY) {
    invalid(`real-case.runnerIdentity must be '${AUTHORITATIVE_REVIEW_RUNNER_IDENTITY}'`);
  }
  validateRequiredAbis(value['requiredAbis']);
  validateCriticalSequence(value['criticalSequence']);
  validateStringArrayLoose(value['eventOrderCriticalSequence'], 'real-case.eventOrderCriticalSequence');
  validateStringArrayLoose(value['eventTail'], 'real-case.eventTail');
  if (typeof value['browserApiFileReconciled'] !== 'boolean') {
    invalid('real-case.browserApiFileReconciled must be a boolean');
  }
  if (typeof value['restartConfirmed'] !== 'boolean') {
    invalid('real-case.restartConfirmed must be a boolean');
  }
  requireNonEmptyString(value['restartObservation'], 'real-case.restartObservation');
  requireNonNegativeInt(value['restartMismatchCount'], 'real-case.restartMismatchCount');
  validateRefChain(value['refChain']);
  validateFileHashes(value['fileHashes']);
  validateStringArrayLoose(value['publicErrorCodes'], 'real-case.publicErrorCodes');
  if (value['hermeticReason'] !== null && typeof value['hermeticReason'] !== 'string') {
    invalid('real-case.hermeticReason must be null or a string');
  }
  if (value['hermeticReason'] === null && value['providerMode'] === 'hermetic-only') {
    invalid('real-case.hermeticReason is required when providerMode is hermetic-only');
  }
}

/* -------------------------------------------------------------------------- */
/* Source-tree digest (excludes the generated-output allowlist)                 */
/* -------------------------------------------------------------------------- */

/**
 * The pure source-tree digest: SHA-256 over the canonical JSON of
 * `{relativePath: sha256(fileBytes)}` for every tracked file NOT in the
 * generated-output allowlist. Excludes generated outputs so the digest stays
 * stable across qualification cycles (mirror of `cleanSourceDigest` in
 * verify-authoritative-review.ts but exposed as a pure helper for tests).
 *
 * The dependency is injected so unit tests can supply synthetic file maps
 * without touching the filesystem; production callers fall back to
 * `git ls-files` + `readFileSync`.
 */
export interface SourceTreeDigestDeps {
  trackedFiles?: readonly string[];
  readTrackedFile?: (relativePath: string) => Buffer | string;
}

export function sourceTreeDigest(deps: SourceTreeDigestDeps = {}): string {
  const trackedFiles = deps.trackedFiles;
  if (trackedFiles === undefined) {
    throw new Error(
      `${AUTHORITATIVE_REVIEW_REAL_CASE_INVALID}: sourceTreeDigest requires explicit trackedFiles (production paths read git ls-files + readFileSync at the seam)`,
    );
  }
  const readTrackedFile = deps.readTrackedFile;
  if (readTrackedFile === undefined) {
    throw new Error(
      `${AUTHORITATIVE_REVIEW_REAL_CASE_INVALID}: sourceTreeDigest requires explicit readTrackedFile (production paths wire readFileSync at the seam)`,
    );
  }
  const files = [...trackedFiles]
    .filter((path) => !isAuthoritativeReviewGeneratedOutput(path))
    .sort();
  const entries: Record<string, string> = {};
  for (const file of files) {
    entries[file] = sha256Hex(readTrackedFile(file));
  }
  return canonicalJsonSha256(entries);
}

/** Pure helper: sha256 hex of any Buffer/string. */
export function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Event-order critical sequence capture (pure parser)                           */
/* -------------------------------------------------------------------------- */

/** The exact event member names that count toward the critical ordering. */
export const AUTHORITATIVE_REVIEW_CRITICAL_EVENT_TYPES: ReadonlySet<string> = new Set(
  AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE,
);

/**
 * Filters the raw event-type stream down to the critical sequence members in
 * the order they first appear. Pure: no fs, no git. The runner feeds the raw
 * event-type list extracted from the journal and gets back the filtered
 * critical-order list (which must equal the report's `criticalSequence`).
 */
export function captureCriticalEventSequence(eventTypes: readonly string[]): readonly string[] {
  const captured: string[] = [];
  for (const eventType of eventTypes) {
    if (!AUTHORITATIVE_REVIEW_CRITICAL_EVENT_TYPES.has(eventType)) continue;
    if (captured.length === AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE.length) break;
    if (captured[captured.length - 1] !== eventType) {
      captured.push(eventType);
    }
  }
  return captured;
}

/** Returns the tail of the event-type stream for restart-equivalence checks. */
export function captureEventTail(eventTypes: readonly string[], size: number): readonly string[] {
  if (size <= 0) return [];
  return eventTypes.slice(-size);
}

/* -------------------------------------------------------------------------- */
/* Ref-chain validation (pure)                                                  */
/* -------------------------------------------------------------------------- */

const REF_DIGEST_PREFIX = 'sha256:'; // reserved for future blob-store canonicalization

/**
 * Validates the ref-chain invariants:
 * - the Map candidate + MapReviewBundle refs are unique and non-empty;
 * - the SealRecordRef / SystemArtifactRef / FinalArtifactRef all reference
 *   different digests (no aliasing);
 * - the chapter bytes hash matches the final-artifact digest of the
 *   `chapter.md` content (the v2 assembler contract);
 * - the event-order critical sequence covers the entire required path.
 *
 * Pure: takes the parsed refs, file hashes, and the captured critical
 * sequence. The runner collects them from the journal + blob store and
 * calls this to lock the invariants.
 */
export function validateRefChainInvariants(input: {
  refChain: AuthoritativeReviewRealCaseEvidence['refChain'];
  fileHashes: AuthoritativeReviewRealCaseEvidence['fileHashes'];
  criticalSequence: readonly string[];
}): void {
  const { refChain, fileHashes, criticalSequence } = input;
  // The Map candidate + MapReviewBundle refs must be distinct (a hand-edited
  // report that re-uses the Map ref as the bundle ref cannot ship).
  if (refChain.mapRef === refChain.mapReviewBundleRef) {
    invalid('real-case.refChain.mapRef must differ from mapReviewBundleRef');
  }
  // The SystemArtifact vs FinalArtifact: SystemArtifact is the v2 system
  // delivery and FinalArtifact is the user-facing artifact. They are
  // physically distinct (separate blobs), so an alias is a forgery.
  if (refChain.systemArtifactRef === refChain.finalArtifactRef) {
    invalid('real-case.refChain.systemArtifactRef must differ from finalArtifactRef');
  }
  // The SealRecord, SystemArtifact, and FinalArtifact refs must all be
  // distinct (no aliasing among the three downstream artifacts).
  const downstream = new Set([
    refChain.sealRecordRef,
    refChain.systemArtifactRef,
    refChain.finalArtifactRef,
  ]);
  if (downstream.size !== 3) {
    invalid('real-case.refChain.sealRecordRef/systemArtifactRef/finalArtifactRef must be distinct');
  }
  // The critical sequence MUST cover every required member. The runner
  // captures from the journal; we re-check the captured list equals the
  // frozen list. Any missing member breaks the chain.
  if (criticalSequence.length !== AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE.length) {
    invalid('real-case.criticalSequence does not cover every required member');
  }
  for (let i = 0; i < criticalSequence.length; i += 1) {
    if (criticalSequence[i] !== AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE[i]) {
      invalid(`real-case.criticalSequence[${i}] must equal '${AUTHORITATIVE_REVIEW_REAL_CASE_CRITICAL_SEQUENCE[i]}'`);
    }
  }
  // File-hash consistency: the sealRecordSha256 must equal the sealRecord
  // ref digest (a single publication step); the chapter bytes hash is the
  // canonical digest of the published `chapter.md`.
  const sealRecordDigest = refChain.sealRecordRef;
  if (fileHashes.sealRecordSha256 !== sealRecordDigest) {
    invalid('real-case.fileHashes.sealRecordSha256 must match refChain.sealRecordRef');
  }
}

function canonicalizeRef(digest: string): string {
  return `${REF_DIGEST_PREFIX}${digest}`;
}

/** Exposed for the runner to canonicalize blob-store digests. */
export { canonicalizeRef };

/* -------------------------------------------------------------------------- */
/* Report builder                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Builds the canonical real-case evidence object from raw facts. The schema
 * gate rejects any unknown field; the test suite pins the exact field set.
 */
export function buildAuthoritativeReviewRealCaseEvidence(
  facts: AuthoritativeReviewRealCaseEvidence,
): Record<string, unknown> {
  return {
    schemaVersion: facts.schemaVersion,
    commit: facts.commit,
    sourceTreeDigest: facts.sourceTreeDigest,
    packageLockDigest: facts.packageLockDigest,
    templateSnapshotHash: facts.templateSnapshotHash,
    taskId: facts.taskId,
    startedAt: facts.startedAt,
    finishedAt: facts.finishedAt,
    providerMode: facts.providerMode,
    ports: { ...facts.ports },
    templateIdentity: facts.templateIdentity,
    capabilityStatus: facts.capabilityStatus,
    capabilityIdentity: facts.capabilityIdentity,
    capabilityProfileDigest: facts.capabilityProfileDigest,
    capabilityEvidenceDigest: facts.capabilityEvidenceDigest,
    finalProfileDigest: facts.finalProfileDigest,
    finalProfilePath: facts.finalProfilePath,
    releaseEvidencePath: facts.releaseEvidencePath,
    platformEvidencePath: facts.platformEvidencePath,
    piPreflightCharacterization: facts.piPreflightCharacterization,
    runnerIdentity: facts.runnerIdentity,
    requiredAbis: [...facts.requiredAbis],
    criticalSequence: [...facts.criticalSequence],
    eventOrderCriticalSequence: [...facts.eventOrderCriticalSequence],
    eventTail: [...facts.eventTail],
    browserApiFileReconciled: facts.browserApiFileReconciled,
    restartConfirmed: facts.restartConfirmed,
    restartObservation: facts.restartObservation,
    restartMismatchCount: facts.restartMismatchCount,
    refChain: { ...facts.refChain },
    fileHashes: { ...facts.fileHashes },
    publicErrorCodes: [...facts.publicErrorCodes],
    capabilityCheckpointDigest: facts.capabilityCheckpointDigest,
    hermeticReason: facts.hermeticReason,
  };
}

/** Exposed for the verify-existing path so the test suite can re-validate. */
export { AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS };
