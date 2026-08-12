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
import type { StructuredSlotLimitsV1 } from '../../shared/structured-slots';
import { STRUCTURED_SLOT_PROFILE_CANDIDATE } from './platform-profile';
import { canonicalJsonSha256 } from './canonical-json';

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
const EVIDENCE_CASE_FIELDS = [
  'id',
  'rawSampleDigest',
  'samples',
  'warmup',
  'p50Ms',
  'p95Ms',
  'maxMs',
  'postCasePeakRssBytes',
] as const;
const PER_SCALE_CASE_FIELDS = [
  'id',
  'description',
  'warmup',
  'samples',
  'p50Ms',
  'p95Ms',
  'maxMs',
  'sampleDigest',
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

/**
 * Every required integrated case the SUCCESS profile evidence's `cases` array
 * must contain (the six frozen bound cases + the two owner-outline diagnostics).
 * The bound cases are enforced by the benchmark's per-scale verdict; the outline
 * diagnostics carry NO bound but ARE required to be emitted, so a success
 * evidence that dropped them is incomplete and must fail. Per-scale RESULTS are
 * NOT required to be complete here — an honest failing scale's report may be
 * truncated and is still recorded.
 */
export const REQUIRED_EVIDENCE_CASE_IDS: readonly string[] = [
  'schema-compile',
  'grammar-compile',
  'tree-match-10k',
  'content-root-64mib',
  'draft-journal-2k',
  'validator-fanout-10k',
  'owner-outline-cold',
  'owner-outline-hot',
  'authorized-projection-500-issues',
  'seal-assembler-custody',
  'batch-recovery',
  'indexed-slot-read',
] as const;

const CASE_SAMPLE_PROTOCOL: Readonly<Record<string, { warmup: number; samples: number }>> = {
  'schema-compile': { warmup: 1, samples: 8 },
  'grammar-compile': { warmup: 1, samples: 8 },
  'tree-match-10k': { warmup: 1, samples: 5 },
  'content-root-64mib': { warmup: 1, samples: 3 },
  'draft-journal-2k': { warmup: 1, samples: 5 },
  'validator-fanout-10k': { warmup: 0, samples: 1 },
  'owner-outline-cold': { warmup: 0, samples: 1 },
  'owner-outline-hot': { warmup: 1, samples: 5 },
  'authorized-projection-500-issues': { warmup: 3, samples: 10 },
  'seal-assembler-custody': { warmup: 0, samples: 1 },
  'batch-recovery': { warmup: 0, samples: 1 },
  'indexed-slot-read': { warmup: 3, samples: 10 },
};

export const STRUCTURED_QUALIFICATION_SCALES = [100, 75, 50, 25] as const;
export const STRUCTURED_QUALIFICATION_BOUNDS = Object.freeze({
  indexedSlotP95Ms: 25,
  treeMatch10kMaxMs: 2000,
  contentRootMaxMs: 2000,
  draftMaxMs: 2000,
  issueProjectionMaxMs: 250,
  sealMaxMs: 30000,
  peakRssBytes: 512 * 1024 * 1024,
});

export function scaledQualificationLimits(percentage: number): StructuredSlotLimitsV1 {
  const scale = percentage / 100;
  const scaleGroup = <T extends Record<string, number>>(group: T): T =>
    Object.fromEntries(Object.entries(group).map(([key, value]) => [key, Math.max(1, Math.floor(value * scale))])) as T;
  return {
    schema: scaleGroup(STRUCTURED_SLOT_PROFILE_CANDIDATE.schema),
    structure: scaleGroup(STRUCTURED_SLOT_PROFILE_CANDIDATE.structure),
    payload: scaleGroup(STRUCTURED_SLOT_PROFILE_CANDIDATE.payload),
    draft: scaleGroup(STRUCTURED_SLOT_PROFILE_CANDIDATE.draft),
    attempt: scaleGroup(STRUCTURED_SLOT_PROFILE_CANDIDATE.attempt),
    validation: scaleGroup(STRUCTURED_SLOT_PROFILE_CANDIDATE.validation),
    output: scaleGroup(STRUCTURED_SLOT_PROFILE_CANDIDATE.output),
  };
}

function recomputeViolations(entry: Record<string, unknown>): string[] {
  const results = entry['results'] as Array<Record<string, unknown>>;
  const byId = new Map(results.map((result) => [result['id'] as string, result]));
  const violations: string[] = [];
  const boundIds = ['indexed-slot-read', 'tree-match-10k', 'content-root-64mib', 'draft-journal-2k', 'seal-assembler-custody', 'authorized-projection-500-issues'];
  for (const id of boundIds) {
    if (!byId.has(id)) violations.push(`missing case ${id}`);
  }
  for (const id of REQUIRED_EVIDENCE_CASE_IDS.filter((id) => !boundIds.includes(id))) {
    if (!byId.has(id)) violations.push(`missing diagnostic case ${id}`);
  }
  const p95 = (id: string): number => (byId.get(id)?.['p95Ms'] as number | undefined) ?? 0;
  const max = (id: string): number => (byId.get(id)?.['maxMs'] as number | undefined) ?? 0;
  if (byId.has('indexed-slot-read') && p95('indexed-slot-read') > STRUCTURED_QUALIFICATION_BOUNDS.indexedSlotP95Ms) violations.push('indexed-slot-read p95');
  if (byId.has('tree-match-10k') && max('tree-match-10k') > STRUCTURED_QUALIFICATION_BOUNDS.treeMatch10kMaxMs) violations.push('tree-match-10k');
  if (byId.has('content-root-64mib') && max('content-root-64mib') > STRUCTURED_QUALIFICATION_BOUNDS.contentRootMaxMs) violations.push('content-root-64mib');
  if (byId.has('draft-journal-2k') && max('draft-journal-2k') > STRUCTURED_QUALIFICATION_BOUNDS.draftMaxMs) violations.push('draft-journal-2k');
  if (byId.has('seal-assembler-custody') && max('seal-assembler-custody') > STRUCTURED_QUALIFICATION_BOUNDS.sealMaxMs) violations.push('seal-assembler-custody');
  if (byId.has('authorized-projection-500-issues') && p95('authorized-projection-500-issues') > STRUCTURED_QUALIFICATION_BOUNDS.issueProjectionMaxMs) violations.push('authorized-projection-500-issues');
  const peak = entry['peakRssBytes'] as number;
  if (peak > STRUCTURED_QUALIFICATION_BOUNDS.peakRssBytes) violations.push(`peak RSS ${peak} > ${STRUCTURED_QUALIFICATION_BOUNDS.peakRssBytes}`);
  return violations;
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
  const id = requireString(value['id'], `${where}.id`);
  requireString(value['description'], `${where}.description`);
  requireNonNegativeInt(value['warmup'], `${where}.warmup`);
  requireNonNegativeInt(value['samples'], `${where}.samples`);
  requireNonNegativeNumber(value['p50Ms'], `${where}.p50Ms`);
  requireNonNegativeNumber(value['p95Ms'], `${where}.p95Ms`);
  requireNonNegativeNumber(value['maxMs'], `${where}.maxMs`);
  requireHex64(value['sampleDigest'], `${where}.sampleDigest`);
  requireNonNegativeInt(value['postCasePeakRssBytes'], `${where}.postCasePeakRssBytes`);
  const protocol = CASE_SAMPLE_PROTOCOL[id];
  if (protocol === undefined) invalid(`${where}.id is not a frozen qualification case`);
  if ((value['warmup'] as number) !== protocol.warmup || (value['samples'] as number) !== protocol.samples) {
    invalid(`${where} must use exact warmup=${protocol.warmup} and samples=${protocol.samples} for '${id}'`);
  }
}

function validatePerScaleResult(value: unknown): void {
  if (!isPlainObject(value)) invalid('perScaleResults entry must be a plain object');
  rejectUnknownFields(value, PER_SCALE_RESULT_FIELDS, 'perScaleResults entry');
  requirePositiveInt(value['scale'], 'perScaleResults entry.scale');
  const results = value['results'];
  if (!Array.isArray(results)) invalid('perScaleResults entry.results must be an array');
  const seen = new Set<string>();
  for (let i = 0; i < results.length; i += 1) {
    validatePerScaleCase(results[i], `perScaleResults entry.results[${i}]`);
    const id = (results[i] as Record<string, unknown>)['id'] as string;
    if (seen.has(id)) invalid(`perScaleResults entry.results has duplicate case '${id}'`);
    seen.add(id);
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
  const id = requireString(value['id'], `${where}.id`);
  requireHex64(value['rawSampleDigest'], `${where}.rawSampleDigest`);
  requireNonNegativeInt(value['samples'], `${where}.samples`);
  requireNonNegativeInt(value['warmup'], `${where}.warmup`);
  requireNonNegativeNumber(value['p50Ms'], `${where}.p50Ms`);
  requireNonNegativeNumber(value['p95Ms'], `${where}.p95Ms`);
  requireNonNegativeNumber(value['maxMs'], `${where}.maxMs`);
  requireNonNegativeInt(value['postCasePeakRssBytes'], `${where}.postCasePeakRssBytes`);
  const protocol = CASE_SAMPLE_PROTOCOL[id];
  if (protocol === undefined) invalid(`${where}.id is not a frozen qualification case`);
  if ((value['warmup'] as number) !== protocol.warmup || (value['samples'] as number) !== protocol.samples) {
    invalid(`${where} must use exact warmup=${protocol.warmup} and samples=${protocol.samples} for '${id}'`);
  }
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
  const seenCaseIds = new Set<string>();
  for (let i = 0; i < cases.length; i += 1) {
    validateEvidenceCase(cases[i], `evidence.cases[${i}]`);
    const id = (cases[i] as Record<string, unknown>)['id'] as string;
    if (seenCaseIds.has(id)) invalid(`evidence.cases has duplicate case '${id}'`);
    seenCaseIds.add(id);
  }
  const presentCaseIds = new Set(cases.map((entry) => (entry as Record<string, unknown>)['id']));
  for (const id of REQUIRED_EVIDENCE_CASE_IDS) {
    if (!presentCaseIds.has(id)) invalid(`evidence.cases missing required case '${id}'`);
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

  if (canonicalJsonSha256(value['bounds']) !== canonicalJsonSha256(STRUCTURED_QUALIFICATION_BOUNDS)) {
    invalid('evidence.bounds must equal the frozen Task 19 bounds');
  }
  const perScale = value['perScaleResults'] as Array<Record<string, unknown>>;
  if (perScale.length !== STRUCTURED_QUALIFICATION_SCALES.length) {
    invalid('evidence.perScaleResults must contain exactly the 100/75/50/25 scales');
  }
  for (let i = 0; i < STRUCTURED_QUALIFICATION_SCALES.length; i += 1) {
    const entry = perScale[i]!;
    if (entry['scale'] !== STRUCTURED_QUALIFICATION_SCALES[i]) invalid('evidence.perScaleResults scales must be ordered 100/75/50/25');
    const recomputed = recomputeViolations(entry);
    if (canonicalJsonSha256(entry['violations']) !== canonicalJsonSha256(recomputed)) invalid(`scale ${String(entry['scale'])} violations do not match frozen-bound recomputation`);
    if (entry['passed'] !== (recomputed.length === 0)) invalid(`scale ${String(entry['scale'])} passed does not match frozen-bound recomputation`);
  }
  const passing = perScale.filter((entry) => entry['passed'] === true).map((entry) => entry['scale'] as number);
  if (passing.length === 0) invalid('success evidence must contain a passing scale');
  const greatest = Math.max(...passing);
  if (candidatePercentage !== greatest) invalid('evidence.candidatePercentage must be the greatest passing scale');
  if (value['selectionReason'] !== `greatest passing scale ${greatest}%`) invalid('evidence.selectionReason does not match candidatePercentage');
  if (canonicalJsonSha256(value['frozenLimits']) !== canonicalJsonSha256(scaledQualificationLimits(greatest))) {
    invalid('evidence.frozenLimits must equal the candidate limits scaled to candidatePercentage');
  }
  const selected = perScale.find((entry) => entry['scale'] === greatest)!;
  if (value['peakRssBytes'] !== selected['peakRssBytes'] || value['diskBytes'] !== selected['diskBytes']) {
    invalid('top-level peakRssBytes/diskBytes must match the selected scale');
  }
  const selectedCases = selected['results'] as Array<Record<string, unknown>>;
  const topCases = cases as Array<Record<string, unknown>>;
  if (topCases.length !== selectedCases.length) invalid('evidence.cases must exactly mirror the selected scale results');
  for (const selectedCase of selectedCases) {
    const top = topCases.find((entry) => entry['id'] === selectedCase['id']);
    if (top === undefined) invalid(`evidence.cases missing selected-scale case '${String(selectedCase['id'])}'`);
    const expected = {
      id: selectedCase['id'], rawSampleDigest: selectedCase['sampleDigest'], samples: selectedCase['samples'],
      warmup: selectedCase['warmup'], p50Ms: selectedCase['p50Ms'], p95Ms: selectedCase['p95Ms'],
      maxMs: selectedCase['maxMs'], postCasePeakRssBytes: selectedCase['postCasePeakRssBytes'],
    };
    if (canonicalJsonSha256(top) !== canonicalJsonSha256(expected)) invalid(`evidence.cases case '${String(selectedCase['id'])}' does not match selected scale`);
  }
  const expectedWarmups = selectedCases.reduce((sum, entry) => sum + (entry['warmup'] as number), 0);
  const expectedSamples = selectedCases.reduce((sum, entry) => sum + (entry['samples'] as number), 0);
  if (value['warmupCount'] !== expectedWarmups || value['sampleCount'] !== expectedSamples) invalid('warmupCount/sampleCount must equal selected-scale totals');
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

/* -------------------------------------------------------------------------- */
/* Release evidence shape (verify-structured-slots --qualify / --promote)      */
/* -------------------------------------------------------------------------- */

/**
 * The exact relative paths and characterization strings a release evidence must
 * carry (the one-way chain source/runner -> profile evidence -> final profile
 * -> release evidence -> capability manifest). Owned here so qualify and
 * promote share one source of truth for the contract.
 */
export const RELEASE_PROFILE_EVIDENCE_PATH = 'docs/evidence/structured-slot-platform-profile-v1.json';
export const RELEASE_FINAL_PROFILE_PATH = 'src/server/structured-slots/platform-profile-v1.json';
export const RELEASE_PI_PREFLIGHT_CHARACTERIZATION = 'forge-pi-slot-preflight/v1';

const RELEASE_EVIDENCE_FIELDS = [
  'schemaVersion',
  'gate',
  'mode',
  'checkpointCommit',
  'sourceTreeDigest',
  'packageLockSha256',
  'profileEvidencePath',
  'profileEvidenceDigest',
  'finalProfilePath',
  'finalProfileDigest',
  'requiredAbis',
  'piPreflightCharacterization',
  'gates',
  'observedAt',
] as const;

const RELEASE_GATE_FIELDS = ['id', 'label', 'command', 'exitCode'] as const;

function requireNonEmptyStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalid(`${where} must be a non-empty string array`);
  }
  for (let i = 0; i < value.length; i += 1) {
    const s = requireString(value[i], `${where}[${i}]`);
    if (s.length === 0) invalid(`${where}[${i}] must be a non-empty string`);
  }
  return value as string[];
}

function requireIsoTimestamp(value: unknown, where: string): string {
  const s = requireString(value, where);
  if (Number.isNaN(Date.parse(s))) invalid(`${where} must be a parseable ISO timestamp`);
  return s;
}

function validateReleaseGate(value: unknown, where: string): void {
  if (!isPlainObject(value)) invalid(`${where} must be a plain object`);
  rejectUnknownFields(value, RELEASE_GATE_FIELDS, where);
  requireString(value['id'], `${where}.id`);
  requireString(value['label'], `${where}.label`);
  requireString(value['command'], `${where}.command`);
  const exitCode = value['exitCode'];
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode !== 0) {
    invalid(`${where}.exitCode must be 0`);
  }
}

/**
 * Exact-validates a Step 7/8 release evidence. Throws
 * `STRUCTURED_EVIDENCE_INVALID: ...` on any unknown field, missing field, shape
 * violation, wrong gate/mode, non-zero gate, missing/duplicate/extra gate or
 * malformed digest. Every gate must have `exitCode === 0` (a non-zero gate
 * means the qualification failed and its record is a FAILURE record, never
 * release evidence). The gate id set must be EXACTLY `expectedGateIds` — no
 * missing, no duplicates, no extras. Returns nothing on success.
 */
export function validateReleaseEvidence(value: unknown, expectedGateIds: readonly string[]): void {
  if (!isPlainObject(value)) invalid('release evidence must be a plain object');
  rejectUnknownFields(value, RELEASE_EVIDENCE_FIELDS, 'release evidence');
  if (value['schemaVersion'] !== 1) invalid('release evidence.schemaVersion must be 1');
  if (value['gate'] !== 'verify:structured-slots') invalid('release evidence.gate must be "verify:structured-slots"');
  if (value['mode'] !== 'qualify') invalid('release evidence.mode must be "qualify"');
  // checkpointCommit is a git object id: SHA-1 (40-hex) or SHA-256 (64-hex),
  // matching the fact validation used for profile evidence gitCommit.
  requireGitCommit(value['checkpointCommit'], 'release evidence.checkpointCommit');
  requireHex64(value['sourceTreeDigest'], 'release evidence.sourceTreeDigest');
  requireHex64(value['packageLockSha256'], 'release evidence.packageLockSha256');
  if (value['profileEvidencePath'] !== RELEASE_PROFILE_EVIDENCE_PATH) {
    invalid(`release evidence.profileEvidencePath must be "${RELEASE_PROFILE_EVIDENCE_PATH}"`);
  }
  requireHex64(value['profileEvidenceDigest'], 'release evidence.profileEvidenceDigest');
  if (value['finalProfilePath'] !== RELEASE_FINAL_PROFILE_PATH) {
    invalid(`release evidence.finalProfilePath must be "${RELEASE_FINAL_PROFILE_PATH}"`);
  }
  requireHex64(value['finalProfileDigest'], 'release evidence.finalProfileDigest');
  requireNonEmptyStringArray(value['requiredAbis'], 'release evidence.requiredAbis');
  if (value['piPreflightCharacterization'] !== RELEASE_PI_PREFLIGHT_CHARACTERIZATION) {
    invalid(`release evidence.piPreflightCharacterization must be "${RELEASE_PI_PREFLIGHT_CHARACTERIZATION}"`);
  }
  requireIsoTimestamp(value['observedAt'], 'release evidence.observedAt');

  const gates = value['gates'];
  if (!Array.isArray(gates) || gates.length === 0) {
    invalid('release evidence.gates must be a non-empty array');
  }
  const seen = new Set<string>();
  for (let i = 0; i < gates.length; i += 1) {
    validateReleaseGate(gates[i], `release evidence.gates[${i}]`);
    const id = requireString((gates[i] as Record<string, unknown>)['id'], `release evidence.gates[${i}].id`);
    if (seen.has(id)) invalid(`release evidence.gates has duplicate id '${id}'`);
    seen.add(id);
  }
  const expected = new Set(expectedGateIds);
  if (expected.size !== expectedGateIds.length) {
    invalid('expectedGateIds must be a unique set');
  }
  for (const id of expected) {
    if (!seen.has(id)) invalid(`release evidence.gates missing required id '${id}'`);
  }
  for (const id of seen) {
    if (!expected.has(id)) invalid(`release evidence.gates has unexpected id '${id}'`);
  }
}

/** Re-exported type so callers can type the validated evidence payload. */
export type { StructuredSlotLimitsV1 };
