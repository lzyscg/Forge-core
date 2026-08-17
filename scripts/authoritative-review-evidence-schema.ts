/**
 * Authoritative review v2 evidence schema (Task 27 Step 1, design §22.2/§25.4
 * + Spec §17).
 *
 * The one-way evidence chain for `authoritative_review_v1` is:
 *
 *   source + final profile  ->  platform benchmark evidence  ->  release
 *   evidence  ->  capability manifest.
 *
 * The final profile is THE ONLY revision marked `qualificationState: final`;
 * it never embeds a downstream evidence digest (a hand-edited capability
 * manifest cannot piggy-back on the profile). The release evidence carries
 * the platform/profile digests and an exact gate set; it never carries the
 * capability-manifest digest. The capability manifest is the LAST node and
 * is the only downstream artifact that may reference the release evidence.
 *
 * The validator is pure: it enforces the exact field shape, the frozen
 * identity constants, the generated-output allowlist, and the profile
 * cross-field relations (100% scale carries the first-release capacity
 * floor + 256/1,024 assignment floors). Downstream digest cross-checks
 * happen in `verify-authoritative-review.ts` once both files are read.
 */
import { canonicalJsonSha256 } from '../src/server/structured-slots/canonical-json';

export const AUTHORITATIVE_REVIEW_EVIDENCE_INVALID = 'AUTHORITATIVE_REVIEW_EVIDENCE_INVALID';

function invalid(reason: string): never {
  throw new Error(`${AUTHORITATIVE_REVIEW_EVIDENCE_INVALID}: ${reason}`);
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

function requireNonNegativeInt(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${where} must be a non-negative safe integer`);
  }
  return value;
}

function requirePositiveInt(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    invalid(`${where} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    invalid(`${where} must be a non-negative finite number`);
  }
  return value;
}

function requireHex64(value: unknown, where: string): string {
  const s = requireString(value, where);
  if (!/^[0-9a-f]{64}$/.test(s)) invalid(`${where} must be a 64-hex digest`);
  return s;
}

function requireIsoTimestamp(value: unknown, where: string): string {
  const s = requireString(value, where);
  if (Number.isNaN(Date.parse(s))) invalid(`${where} must be a parseable ISO timestamp`);
  return s;
}

function requireGitCommit(value: unknown, where: string): string {
  const s = requireString(value, where);
  if (!/^[0-9a-f]{40}$/.test(s) && !/^[0-9a-f]{64}$/.test(s)) {
    invalid(`${where} must be a 40-hex or 64-hex git commit id`);
  }
  return s;
}

/* -------------------------------------------------------------------------- */
/* Frozen identity constants (design §22.2/§25.4 + Spec §17)                    */
/* -------------------------------------------------------------------------- */

export const AUTHORITATIVE_REVIEW_RUNNER_IDENTITY = 'forge-authoritative-ref-runner/v1' as const;
/** The frozen pi-preflight characterization, mirrors the v1 constant. */
export const AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION = 'forge-authoritative-review-pi-preflight/v1' as const;

/** The frozen v2 ABI list (spec §5.2/§13.5). Order is significant. */
export const AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY = ['forge-validator/v2', 'forge-assembler/v2'] as const;

/**
 * The four files the one-way chain certifies by their own digests. The
 * `cleanSourceDigest` excludes them so the source-digest identity stays
 * stable across integrated-qualify -> qualify -> promote (mirror of v1).
 * The list is sorted alphabetically so the release-evidence validator can
 * accept any caller order and compare against this canonical sorted set.
 */
const AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS_RAW: readonly string[] = [
  'src/server/structured-slots/authoritative-review-profile-v1.json',
  'src/server/structured-slots/authoritative-review-capability-v1.json',
  'docs/evidence/authoritative-review-platform-profile-v1.json',
  'docs/evidence/authoritative-review-release-v1.json',
] as const;

export const AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS: readonly string[] = [...AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS_RAW].sort();

const GENERATED_SET: ReadonlySet<string> = new Set(AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS);

/** True when a repo-relative path is one of the one-way chain products. */
export function isAuthoritativeReviewGeneratedOutput(relativePath: string): boolean {
  return GENERATED_SET.has(relativePath);
}

/** Stable caller-side helper for the runner identity (so callers cannot typo). */
export function reviewerRunnerIdentity(): string {
  return AUTHORITATIVE_REVIEW_RUNNER_IDENTITY;
}

/* -------------------------------------------------------------------------- */
/* Qualification gates + bound case IDs (design §22.2 + §25.4)                  */
/* -------------------------------------------------------------------------- */

/** The exact Step 6 gate set; the release evidence must carry exactly these IDs. */
export const AUTHORITATIVE_REVIEW_QUALIFICATION_GATE_IDS: readonly string[] = [
  'typecheck',
  'unit-tests',
  'build',
  'e2e',
  'authoritative-acceptance',
  'authoritative-acceptance-injected',
  'authoritative-pi-preflight',
] as const;

/** The 10k-life cycle bound case IDs every integrated-qualify round must carry. */
export const AUTHORITATIVE_REVIEW_FINAL_BOUND_CASE_IDS: readonly string[] = [
  'author-map-chunk-1k',
  'optional-relation-fanout',
  'map-review-24',
  'content-generation-10k',
  'review-ledger-10k',
  'map-migration-10k',
  'restart-replay-10k',
  'locate-beyond-9k',
  'publication-pin-gc',
  'event-count-headroom',
] as const;

/* -------------------------------------------------------------------------- */
/* Exact field maps                                                            */
/* -------------------------------------------------------------------------- */

export const AUTHORITATIVE_REVIEW_REFERENCE_RUNNER_FIELDS = [
  'schemaVersion',
  'runnerId',
  'runnerVersion',
  'descriptor',
  'descriptorDigest',
] as const;

export const AUTHORITATIVE_REVIEW_PROFILE_EVIDENCE_FIELDS = [
  'schemaVersion',
  'mode',
  'runner',
  'gitCommit',
  'sourceTreeDigest',
  'packageLockSha256',
  'dependencyVersions',
  'peakRssBytes',
  'diskBytes',
  'cases',
  'candidatePercentage',
  'selectionReason',
  'finalProfileDigest',
  'finalProfileQualificationState',
  'finalProfileMaxSlots',
  'finalProfileAssignmentPrimaryTargets',
  'finalProfileAssignmentTotalObjects',
  'bounds',
  'perScaleResults',
] as const;

export const AUTHORITATIVE_REVIEW_PROFILE_EVIDENCE_FAILURE_FIELDS = [
  'schemaVersion',
  'mode',
  'outcome',
  'runner',
  'gitCommit',
  'sourceTreeDigest',
  'packageLockSha256',
  'dependencyVersions',
  'bounds',
  'perScaleResults',
  'selectionReason',
] as const;

export const AUTHORITATIVE_REVIEW_RELEASE_EVIDENCE_FIELDS = [
  'schemaVersion',
  'gate',
  'mode',
  'checkpointCommit',
  'sourceTreeDigest',
  'packageLockSha256',
  'finalProfilePath',
  'finalProfileDigest',
  'platformEvidencePath',
  'platformEvidenceDigest',
  'requiredAbis',
  'piPreflightCharacterization',
  'gates',
  'generatedOutputs',
  'observedAt',
] as const;

const RUNNER_FIELDS = ['runnerId', 'runnerVersion', 'descriptorDigest'] as const;
const DEPENDENCY_FIELDS = ['isolated-vm', 're2-wasm', '@earendil-works/pi-ai'] as const;
const BOUND_FIELDS = [
  'authorMapChunkP95Ms',
  'mapBuildCandidateP95Ms',
  'mapReviewAssignmentP95Ms',
  'contentGenerationP95Ms',
  'contentReviewSettlementP95Ms',
  'mapMigrationP95Ms',
  'checkpointReplayP95Ms',
  'locateBeyond9kP95Ms',
  'publicationPinGcP95Ms',
  'peakRssBytes',
  'pageLatencyP95Ms',
  'appendLatencyP95Ms',
  'recoveryTimeP95Ms',
  'eventCountHeadroom',
] as const;
const CASE_FIELDS = [
  'id',
  'rawSampleDigest',
  'samples',
  'warmup',
  'p50Ms',
  'p95Ms',
  'maxMs',
  'postCasePeakRssBytes',
] as const;
const PER_SCALE_RESULT_FIELDS = [
  'scale',
  'results',
  'peakRssBytes',
  'diskBytes',
  'violations',
  'passed',
] as const;
const RELEASE_GATE_FIELDS = ['id', 'label', 'command', 'exitCode'] as const;

/* -------------------------------------------------------------------------- */
/* Reference runner validator                                                   */
/* -------------------------------------------------------------------------- */

function validateRunner(value: unknown, where: string): {
  runnerId: string;
  runnerVersion: string;
  descriptorDigest: string;
} {
  if (!isPlainObject(value)) invalid(`${where} must be a plain object`);
  rejectUnknownFields(value, RUNNER_FIELDS, where);
  requireNonEmptyString(value['runnerId'], `${where}.runnerId`);
  requireNonEmptyString(value['runnerVersion'], `${where}.runnerVersion`);
  requireHex64(value['descriptorDigest'], `${where}.descriptorDigest`);
  return value as unknown as { runnerId: string; runnerVersion: string; descriptorDigest: string };
}

function validateDescriptor(value: unknown, where: string): void {
  if (!isPlainObject(value)) invalid(`${where} must be a plain object`);
  const expected = ['node', 'v8', 'platform', 'arch', 'cpuModel', 'logicalCores', 'totalMemoryMiB'] as const;
  rejectUnknownFields(value, expected, where);
  for (const key of expected) {
    if (key === 'logicalCores' || key === 'totalMemoryMiB') {
      requirePositiveInt(value[key], `${where}.${key}`);
    } else {
      requireNonEmptyString(value[key], `${where}.${key}`);
    }
  }
}

/**
 * Validates the reference runner. The reference runner is the only legal
 * writer of the final profile / platform / release evidence for v2. The
 * declared `descriptorDigest` MUST match the canonical SHA-256 of the
 * descriptor (otherwise a hand-edited runner could claim a different host).
 */
export function validateAuthoritativeReviewReferenceRunner(value: unknown): void {
  if (!isPlainObject(value)) invalid('reference runner must be a plain object');
  rejectUnknownFields(value, AUTHORITATIVE_REVIEW_REFERENCE_RUNNER_FIELDS, 'reference runner');
  if (value['schemaVersion'] !== 1) invalid('reference runner.schemaVersion must be 1');
  if (value['runnerId'] !== AUTHORITATIVE_REVIEW_RUNNER_IDENTITY) {
    invalid(`reference runner.runnerId must be '${AUTHORITATIVE_REVIEW_RUNNER_IDENTITY}'`);
  }
  requireNonEmptyString(value['runnerVersion'], 'reference runner.runnerVersion');
  validateDescriptor(value['descriptor'], 'reference runner.descriptor');
  const digest = requireHex64(value['descriptorDigest'], 'reference runner.descriptorDigest');
  // Recompute the canonical digest over the descriptor (same algorithm as the
  // runner script).
  if (canonicalJsonSha256(value['descriptor']) !== digest) {
    invalid('reference runner.descriptorDigest does not match the canonical descriptor');
  }
}

/* -------------------------------------------------------------------------- */
/* Profile evidence validator (success shape)                                  */
/* -------------------------------------------------------------------------- */

function validateBounds(value: unknown): void {
  if (!isPlainObject(value)) invalid('bounds must be a plain object');
  rejectUnknownFields(value, BOUND_FIELDS, 'bounds');
  for (const field of BOUND_FIELDS) {
    requireNonNegativeNumber(value[field], `bounds.${field}`);
  }
}

function validateDependencies(value: unknown): void {
  if (!isPlainObject(value)) invalid('dependencyVersions must be a plain object');
  rejectUnknownFields(value, DEPENDENCY_FIELDS, 'dependencyVersions');
  for (const dep of DEPENDENCY_FIELDS) {
    requireNonEmptyString(value[dep], `dependencyVersions.${dep}`);
  }
}

function validateProfileEvidenceCase(value: unknown, where: string): void {
  if (!isPlainObject(value)) invalid(`${where} must be a plain object`);
  rejectUnknownFields(value, CASE_FIELDS, where);
  requireNonEmptyString(value['id'], `${where}.id`);
  requireHex64(value['rawSampleDigest'], `${where}.rawSampleDigest`);
  requireNonNegativeInt(value['samples'], `${where}.samples`);
  requireNonNegativeInt(value['warmup'], `${where}.warmup`);
  requireNonNegativeNumber(value['p50Ms'], `${where}.p50Ms`);
  requireNonNegativeNumber(value['p95Ms'], `${where}.p95Ms`);
  requireNonNegativeNumber(value['maxMs'], `${where}.maxMs`);
  requireNonNegativeInt(value['postCasePeakRssBytes'], `${where}.postCasePeakRssBytes`);
  if (!AUTHORITATIVE_REVIEW_FINAL_BOUND_CASE_IDS.includes(value['id'] as string)) {
    invalid(`${where}.id is not a frozen qualification case`);
  }
}

function validatePerScaleResult(value: unknown): void {
  if (!isPlainObject(value)) invalid('perScaleResults entry must be a plain object');
  rejectUnknownFields(value, PER_SCALE_RESULT_FIELDS, 'perScaleResults entry');
  requirePositiveInt(value['scale'], 'perScaleResults entry.scale');
  const results = value['results'];
  if (!Array.isArray(results)) invalid('perScaleResults entry.results must be an array');
  for (const result of results) {
    validateProfileEvidenceCase(result, 'perScaleResults entry.results[]');
  }
  requirePositiveInt(value['peakRssBytes'], 'perScaleResults entry.peakRssBytes');
  requireNonNegativeInt(value['diskBytes'], 'perScaleResults entry.diskBytes');
  const violations = value['violations'];
  if (!Array.isArray(violations)) invalid('perScaleResults entry.violations must be an array');
  for (const violation of violations) {
    requireNonEmptyString(violation, 'perScaleResults entry.violations[]');
  }
  if (typeof value['passed'] !== 'boolean') invalid('perScaleResults entry.passed must be a boolean');
}

function validatePerScaleResults(value: unknown): void {
  if (!Array.isArray(value)) invalid('perScaleResults must be an array');
  for (const entry of value) validatePerScaleResult(entry);
}

/**
 * Validates the SUCCESS platform-profile evidence (integrated-qualify, the
 * only shape that may be referenced by a release evidence). No downstream
 * capability-manifest digest allowed. The final profile must be `final` with
 * the first-release capacity floor (maxSlots >= 10,000; 256 primary targets;
 * 1,024 total objects per assignment).
 */
export function validateAuthoritativeReviewProfileEvidence(value: unknown): void {
  if (!isPlainObject(value)) invalid('profile evidence must be a plain object');
  rejectUnknownFields(value, AUTHORITATIVE_REVIEW_PROFILE_EVIDENCE_FIELDS, 'profile evidence');
  if (value['schemaVersion'] !== 1) invalid('profile evidence.schemaVersion must be 1');
  if (value['mode'] !== 'integrated-qualify') invalid('profile evidence.mode must be "integrated-qualify"');
  validateRunner(value['runner'], 'profile evidence.runner');
  requireGitCommit(value['gitCommit'], 'profile evidence.gitCommit');
  requireHex64(value['sourceTreeDigest'], 'profile evidence.sourceTreeDigest');
  requireHex64(value['packageLockSha256'], 'profile evidence.packageLockSha256');
  validateDependencies(value['dependencyVersions']);
  requirePositiveInt(value['peakRssBytes'], 'profile evidence.peakRssBytes');
  requireNonNegativeInt(value['diskBytes'], 'profile evidence.diskBytes');
  const cases = value['cases'];
  if (!Array.isArray(cases)) invalid('profile evidence.cases must be an array');
  const seenCaseIds = new Set<string>();
  for (let i = 0; i < cases.length; i += 1) {
    validateProfileEvidenceCase(cases[i], `profile evidence.cases[${i}]`);
    const id = (cases[i] as Record<string, unknown>)['id'] as string;
    if (seenCaseIds.has(id)) invalid(`profile evidence.cases has duplicate case '${id}'`);
    seenCaseIds.add(id);
  }
  const candidatePercentage = value['candidatePercentage'];
  if (
    typeof candidatePercentage !== 'number' ||
    ![100, 75, 50, 25].includes(candidatePercentage)
  ) {
    invalid('profile evidence.candidatePercentage must be one of 100, 75, 50, 25');
  }
  requireNonEmptyString(value['selectionReason'], 'profile evidence.selectionReason');
  requireHex64(value['finalProfileDigest'], 'profile evidence.finalProfileDigest');
  if (value['finalProfileQualificationState'] !== 'final') {
    invalid('profile evidence.finalProfileQualificationState must be "final"');
  }
  requirePositiveInt(value['finalProfileMaxSlots'], 'profile evidence.finalProfileMaxSlots');
  if ((value['finalProfileMaxSlots'] as number) < 10_000) {
    invalid('profile evidence.finalProfileMaxSlots must be >= 10_000 (first-release capacity floor)');
  }
  requirePositiveInt(value['finalProfileAssignmentPrimaryTargets'], 'profile evidence.finalProfileAssignmentPrimaryTargets');
  if ((value['finalProfileAssignmentPrimaryTargets'] as number) < 256) {
    invalid('profile evidence.finalProfileAssignmentPrimaryTargets must be >= 256');
  }
  requirePositiveInt(value['finalProfileAssignmentTotalObjects'], 'profile evidence.finalProfileAssignmentTotalObjects');
  if ((value['finalProfileAssignmentTotalObjects'] as number) < 1_024) {
    invalid('profile evidence.finalProfileAssignmentTotalObjects must be >= 1024');
  }
  if (
    (value['finalProfileAssignmentTotalObjects'] as number) <
    (value['finalProfileAssignmentPrimaryTargets'] as number)
  ) {
    invalid('profile evidence.finalProfileAssignmentTotalObjects must cover finalProfileAssignmentPrimaryTargets');
  }
  validateBounds(value['bounds']);
  validatePerScaleResults(value['perScaleResults']);
}

/* -------------------------------------------------------------------------- */
/* Profile evidence failure validator (honest failure shapes)                   */
/* -------------------------------------------------------------------------- */

const FAILURE_OUTCOMES = new Set(['no_scale_passed', 'child_failed'] as const);

/**
 * Validates an honest failure shape (no_scale_passed / child_failed). A
 * failure evidence is still written to the plan's evidence path so the latest
 * attempt is never lost, but its `outcome` field is non-success and the
 * promotion path rejects it.
 */
export function validateAuthoritativeReviewProfileEvidenceFailure(value: unknown): void {
  if (!isPlainObject(value)) invalid('failure evidence must be a plain object');
  if (value['schemaVersion'] !== 1) invalid('failure evidence.schemaVersion must be 1');
  if (value['mode'] !== 'integrated-qualify') invalid('failure evidence.mode must be "integrated-qualify"');
  if (!FAILURE_OUTCOMES.has(value['outcome'] as 'no_scale_passed' | 'child_failed')) {
    invalid('failure evidence.outcome must be "no_scale_passed" or "child_failed"');
  }
  rejectUnknownFields(value, AUTHORITATIVE_REVIEW_PROFILE_EVIDENCE_FAILURE_FIELDS, 'failure evidence');
  validateRunner(value['runner'], 'failure evidence.runner');
  requireGitCommit(value['gitCommit'], 'failure evidence.gitCommit');
  requireHex64(value['sourceTreeDigest'], 'failure evidence.sourceTreeDigest');
  requireHex64(value['packageLockSha256'], 'failure evidence.packageLockSha256');
  validateDependencies(value['dependencyVersions']);
  validateBounds(value['bounds']);
  validatePerScaleResults(value['perScaleResults']);
  requireNonEmptyString(value['selectionReason'], 'failure evidence.selectionReason');
}

/* -------------------------------------------------------------------------- */
/* Release evidence validator (qualify/promote gate)                            */
/* -------------------------------------------------------------------------- */

export const AUTHORITATIVE_REVIEW_FINAL_PROFILE_PATH = 'src/server/structured-slots/authoritative-review-profile-v1.json';
export const AUTHORITATIVE_REVIEW_PLATFORM_EVIDENCE_PATH = 'docs/evidence/authoritative-review-platform-profile-v1.json';

function validateGeneratedOutputs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length !== AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS.length) {
    invalid('release evidence.generatedOutputs must be the canonical allowlist');
  }
  const sorted = [...(value as unknown[])].map((entry) => requireNonEmptyString(entry, 'generatedOutputs[]'));
  sorted.sort();
  for (let i = 0; i < AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS.length; i += 1) {
    if (sorted[i] !== AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS[i]) {
      invalid('release evidence.generatedOutputs must exactly equal the canonical v2 allowlist');
    }
  }
  return value as readonly string[];
}

function validateReleaseGate(value: unknown, where: string): void {
  if (!isPlainObject(value)) invalid(`${where} must be a plain object`);
  rejectUnknownFields(value, RELEASE_GATE_FIELDS, where);
  requireNonEmptyString(value['id'], `${where}.id`);
  requireNonEmptyString(value['label'], `${where}.label`);
  requireNonEmptyString(value['command'], `${where}.command`);
  const exitCode = value['exitCode'];
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode !== 0) {
    invalid(`${where}.exitCode must be 0`);
  }
}

/**
 * Validates the release evidence shape. No capability-manifest digest may
 * appear (the release evidence is the node BEFORE the manifest in the one-way
 * chain). The gate set must be EXACTLY `AUTHORITATIVE_REVIEW_QUALIFICATION_GATE_IDS`.
 */
export function validateAuthoritativeReviewReleaseEvidence(value: unknown): void {
  if (!isPlainObject(value)) invalid('release evidence must be a plain object');
  rejectUnknownFields(value, AUTHORITATIVE_REVIEW_RELEASE_EVIDENCE_FIELDS, 'release evidence');
  if (value['schemaVersion'] !== 1) invalid('release evidence.schemaVersion must be 1');
  if (value['gate'] !== 'verify:authoritative-review') {
    invalid('release evidence.gate must be "verify:authoritative-review"');
  }
  if (value['mode'] !== 'qualify') invalid('release evidence.mode must be "qualify"');
  requireGitCommit(value['checkpointCommit'], 'release evidence.checkpointCommit');
  requireHex64(value['sourceTreeDigest'], 'release evidence.sourceTreeDigest');
  requireHex64(value['packageLockSha256'], 'release evidence.packageLockSha256');
  if (value['finalProfilePath'] !== AUTHORITATIVE_REVIEW_FINAL_PROFILE_PATH) {
    invalid(`release evidence.finalProfilePath must be "${AUTHORITATIVE_REVIEW_FINAL_PROFILE_PATH}"`);
  }
  requireHex64(value['finalProfileDigest'], 'release evidence.finalProfileDigest');
  if (value['platformEvidencePath'] !== AUTHORITATIVE_REVIEW_PLATFORM_EVIDENCE_PATH) {
    invalid(`release evidence.platformEvidencePath must be "${AUTHORITATIVE_REVIEW_PLATFORM_EVIDENCE_PATH}"`);
  }
  requireHex64(value['platformEvidenceDigest'], 'release evidence.platformEvidenceDigest');
  const abis = value['requiredAbis'];
  if (
    !Array.isArray(abis) ||
    abis.length !== AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY.length ||
    abis.some((abi, i) => abi !== AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY[i])
  ) {
    invalid(`release evidence.requiredAbis must exactly equal the v2 ABI list`);
  }
  if (value['piPreflightCharacterization'] !== AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION) {
    invalid(`release evidence.piPreflightCharacterization must be "${AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION}"`);
  }
  validateGeneratedOutputs(value['generatedOutputs']);
  requireIsoTimestamp(value['observedAt'], 'release evidence.observedAt');

  const gates = value['gates'];
  if (!Array.isArray(gates) || gates.length === 0) {
    invalid('release evidence.gates must be a non-empty array');
  }
  const seen = new Set<string>();
  for (let i = 0; i < gates.length; i += 1) {
    validateReleaseGate(gates[i], `release evidence.gates[${i}]`);
    const id = (gates[i] as Record<string, unknown>)['id'] as string;
    if (seen.has(id)) invalid(`release evidence.gates has duplicate id '${id}'`);
    seen.add(id);
  }
  const expected = new Set(AUTHORITATIVE_REVIEW_QUALIFICATION_GATE_IDS);
  for (const id of expected) {
    if (!seen.has(id)) invalid(`release evidence.gates missing required id '${id}'`);
  }
  for (const id of seen) {
    if (!expected.has(id)) invalid(`release evidence.gates has unexpected id '${id}'`);
  }
}
