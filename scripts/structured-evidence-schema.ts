/**
 * Exact schema validator for the Task 19 structured-slot platform profile
 * evidence (docs/evidence/structured-slot-platform-profile-v1.json).
 *
 * Two exact shapes are validated, each rejecting unknown fields at every level
 * (spec §5 / brief Step 3 discipline):
 *
 * - `validateProfileEvidence`       — the SUCCESS shape written when at least
 *                                     one 100/75/50/25% scale passes every
 *                                     acceptance bound.
 * - `validateProfileEvidenceFailure`— the HONEST-FAILURE shape written when no
 *                                     scale passes (outcome 'no_scale_passed');
 *                                     the failure evidence is still written to
 *                                     the plan's evidence path so it is never
 *                                     lost.
 *
 * Every case entry must carry the REAL measured warmup/samples/sampleDigest and
 * p50/p95/max; top-level peakRssBytes/diskBytes must be the qualifying child
 * process's own values (never a global peak folded across scales).
 */
import type { StructuredSlotLimitsV1 } from '../src/shared/structured-slots';

export const STRUCTURED_EVIDENCE_INVALID = 'STRUCTURED_EVIDENCE_INVALID';

function invalid(reason: string): never {
  throw new Error(`${STRUCTURED_EVIDENCE_INVALID}: ${reason}`);
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

/** gitCommit is a git object id: SHA-1 (40-hex) or SHA-256 (64-hex). */
function requireGitCommit(value: unknown, where: string): string {
  const s = requireString(value, where);
  if (!/^[0-9a-f]{40}$/.test(s) && !/^[0-9a-f]{64}$/.test(s)) {
    invalid(`${where} must be a 40-hex or 64-hex git commit id`);
  }
  return s;
}

/* -------------------------------------------------------------------------- */
/* Exact field maps (unknown fields rejected at every level)                   */
/* -------------------------------------------------------------------------- */

const RUNNER_FIELDS = ['runnerId', 'runnerVersion', 'descriptorDigest'] as const;
const DEPENDENCY_FIELDS = ['isolated-vm', 're2-wasm', '@earendil-works/pi-ai'] as const;
const BOUNDS_FIELDS = [
  'indexedSlotP95Ms',
  'treeMatch10kMaxMs',
  'contentRootMaxMs',
  'draftMaxMs',
  'issueProjectionMaxMs',
  'sealMaxMs',
  'peakRssBytes',
] as const;
const EVIDENCE_CASE_FIELDS = ['id', 'rawSampleDigest', 'samples', 'warmup', 'p50Ms', 'p95Ms', 'maxMs'] as const;
const PER_SCALE_CASE_FIELDS = [
  'id',
  'description',
  'warmup',
  'samples',
  'p50Ms',
  'p95Ms',
  'maxMs',
  'sampleDigest',
] as const;
const PER_SCALE_RESULT_FIELDS = [
  'scale',
  'results',
  'peakRssBytes',
  'diskBytes',
  'violations',
  'passed',
] as const;

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

/* -------------------------------------------------------------------------- */
/* Shared exact validators                                                     */
/* -------------------------------------------------------------------------- */

function validateRunner(value: unknown): void {
  if (!isPlainObject(value)) invalid('runner must be a plain object');
  rejectUnknownFields(value, RUNNER_FIELDS, 'runner');
  requireString(value['runnerId'], 'runner.runnerId');
  requireString(value['runnerVersion'], 'runner.runnerVersion');
  requireHex64(value['descriptorDigest'], 'runner.descriptorDigest');
}

/**
 * Validates the four reproducible-evidence fact fields on an evidence object.
 * The caller has already rejected unknown TOP-LEVEL fields against the full
 * field list, so this only validates the four fact values (it must not reject
 * the other top-level fields that coexist on the same object).
 */
function validateEvidenceFacts(value: Record<string, unknown>): void {
  requireGitCommit(value['gitCommit'], 'gitCommit');
  requireHex64(value['sourceTreeDigest'], 'sourceTreeDigest');
  requireHex64(value['packageLockSha256'], 'packageLockSha256');
  const deps = value['dependencyVersions'];
  if (!isPlainObject(deps)) invalid('dependencyVersions must be a plain object');
  rejectUnknownFields(deps, DEPENDENCY_FIELDS, 'dependencyVersions');
  for (const dep of DEPENDENCY_FIELDS) {
    requireString(deps[dep], `dependencyVersions.${dep}`);
  }
}

function validateBounds(value: unknown): void {
  if (!isPlainObject(value)) invalid('bounds must be a plain object');
  rejectUnknownFields(value, BOUNDS_FIELDS, 'bounds');
  for (const field of BOUNDS_FIELDS) {
    requireNonNegativeNumber(value[field], `bounds.${field}`);
  }
}

function validateLimits(value: unknown, where: string): void {
  if (!isPlainObject(value)) invalid(`${where} must be a plain object`);
  rejectUnknownFields(value, Object.keys(LIMIT_GROUPS), where);
  for (const [group, fields] of Object.entries(LIMIT_GROUPS)) {
    const groupValue = value[group];
    if (!isPlainObject(groupValue)) invalid(`${where}.${group} must be a plain object`);
    rejectUnknownFields(groupValue, fields, `${where}.${group}`);
    for (const field of fields) {
      requirePositiveInt(groupValue[field], `${where}.${group}.${field}`);
    }
  }
}

function validatePerScaleCase(value: unknown, where: string): void {
  if (!isPlainObject(value)) invalid(`${where} must be a plain object`);
  rejectUnknownFields(value, PER_SCALE_CASE_FIELDS, where);
  requireString(value['id'], `${where}.id`);
  requireString(value['description'], `${where}.description`);
  requireNonNegativeInt(value['warmup'], `${where}.warmup`);
  requireNonNegativeInt(value['samples'], `${where}.samples`);
  requireNonNegativeNumber(value['p50Ms'], `${where}.p50Ms`);
  requireNonNegativeNumber(value['p95Ms'], `${where}.p95Ms`);
  requireNonNegativeNumber(value['maxMs'], `${where}.maxMs`);
  requireHex64(value['sampleDigest'], `${where}.sampleDigest`);
}

function validatePerScaleResult(value: unknown): void {
  if (!isPlainObject(value)) invalid('perScaleResults entry must be a plain object');
  rejectUnknownFields(value, PER_SCALE_RESULT_FIELDS, 'perScaleResults entry');
  requirePositiveInt(value['scale'], 'perScaleResults entry.scale');
  const results = value['results'];
  if (!Array.isArray(results)) invalid('perScaleResults entry.results must be an array');
  for (let i = 0; i < results.length; i += 1) {
    validatePerScaleCase(results[i], `perScaleResults entry.results[${i}]`);
  }
  requirePositiveInt(value['peakRssBytes'], 'perScaleResults entry.peakRssBytes');
  requireNonNegativeInt(value['diskBytes'], 'perScaleResults entry.diskBytes');
  const violations = value['violations'];
  if (!Array.isArray(violations)) invalid('perScaleResults entry.violations must be an array');
  for (const violation of violations) {
    requireString(violation, 'perScaleResults entry.violations[]');
  }
  if (typeof value['passed'] !== 'boolean') invalid('perScaleResults entry.passed must be a boolean');
}

function validatePerScaleResults(value: unknown): void {
  if (!Array.isArray(value)) invalid('perScaleResults must be an array');
  for (const entry of value) validatePerScaleResult(entry);
}

/* -------------------------------------------------------------------------- */
/* Success evidence shape                                                      */
/* -------------------------------------------------------------------------- */

const SUCCESS_EVIDENCE_FIELDS = [
  'schemaVersion',
  'mode',
  'runner',
  'gitCommit',
  'sourceTreeDigest',
  'packageLockSha256',
  'dependencyVersions',
  'warmupCount',
  'sampleCount',
  'peakRssBytes',
  'diskBytes',
  'cases',
  'candidatePercentage',
  'selectionReason',
  'frozenLimits',
  'bounds',
  'perScaleResults',
] as const;

function validateEvidenceCase(value: unknown, where: string): void {
  if (!isPlainObject(value)) invalid(`${where} must be a plain object`);
  rejectUnknownFields(value, EVIDENCE_CASE_FIELDS, where);
  requireString(value['id'], `${where}.id`);
  requireHex64(value['rawSampleDigest'], `${where}.rawSampleDigest`);
  requireNonNegativeInt(value['samples'], `${where}.samples`);
  requireNonNegativeInt(value['warmup'], `${where}.warmup`);
  requireNonNegativeNumber(value['p50Ms'], `${where}.p50Ms`);
  requireNonNegativeNumber(value['p95Ms'], `${where}.p95Ms`);
  requireNonNegativeNumber(value['maxMs'], `${where}.maxMs`);
}

/**
 * Exact-validates the SUCCESS platform-profile evidence. Throws
 * `STRUCTURED_EVIDENCE_INVALID: ...` on any unknown field, missing field or
 * shape violation. Returns nothing on success.
 */
export function validateProfileEvidence(value: unknown): void {
  if (!isPlainObject(value)) invalid('evidence must be a plain object');
  rejectUnknownFields(value, SUCCESS_EVIDENCE_FIELDS, 'evidence');
  if (value['schemaVersion'] !== 1) invalid('evidence.schemaVersion must be 1');
  if (value['mode'] !== 'integrated-qualify') invalid('evidence.mode must be "integrated-qualify"');
  validateRunner(value['runner']);
  validateEvidenceFacts(value);
  requireNonNegativeInt(value['warmupCount'], 'evidence.warmupCount');
  requireNonNegativeInt(value['sampleCount'], 'evidence.sampleCount');
  requirePositiveInt(value['peakRssBytes'], 'evidence.peakRssBytes');
  requireNonNegativeInt(value['diskBytes'], 'evidence.diskBytes');
  const cases = value['cases'];
  if (!Array.isArray(cases)) invalid('evidence.cases must be an array');
  for (let i = 0; i < cases.length; i += 1) {
    validateEvidenceCase(cases[i], `evidence.cases[${i}]`);
  }
  const candidatePercentage = value['candidatePercentage'];
  if (
    candidatePercentage !== null &&
    (typeof candidatePercentage !== 'number' || ![100, 75, 50, 25].includes(candidatePercentage))
  ) {
    invalid('evidence.candidatePercentage must be null or one of 100, 75, 50, 25');
  }
  requireString(value['selectionReason'], 'evidence.selectionReason');
  validateLimits(value['frozenLimits'], 'evidence.frozenLimits');
  validateBounds(value['bounds']);
  validatePerScaleResults(value['perScaleResults']);
}

/* -------------------------------------------------------------------------- */
/* Honest-failure evidence shape                                               */
/* -------------------------------------------------------------------------- */

const FAILURE_EVIDENCE_FIELDS = [
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

/**
 * Exact-validates the FAILURE evidence shapes: the honest
 * `no_scale_passed` outcome AND the `child_failed` outcome (written when a
 * per-scale child process fails mid-run, so the evidence file always reflects
 * the latest attempt and is never lost). Throws
 * `STRUCTURED_EVIDENCE_INVALID: ...` on any violation. The failure evidence is
 * still written to the plan's evidence path.
 */
export function validateProfileEvidenceFailure(value: unknown): void {
  if (!isPlainObject(value)) invalid('failure evidence must be a plain object');
  rejectUnknownFields(value, FAILURE_EVIDENCE_FIELDS, 'failure evidence');
  if (value['schemaVersion'] !== 1) invalid('failure evidence.schemaVersion must be 1');
  if (value['mode'] !== 'integrated-qualify') invalid('failure evidence.mode must be "integrated-qualify"');
  if (value['outcome'] !== 'no_scale_passed' && value['outcome'] !== 'child_failed') {
    invalid('failure evidence.outcome must be "no_scale_passed" or "child_failed"');
  }
  validateRunner(value['runner']);
  validateEvidenceFacts(value);
  validateBounds(value['bounds']);
  validatePerScaleResults(value['perScaleResults']);
  requireString(value['selectionReason'], 'failure evidence.selectionReason');
}

/** Re-exported type so callers can type the validated evidence payload. */
export type { StructuredSlotLimitsV1 };
