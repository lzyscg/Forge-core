/**
 * Forge Core final capability evidence gate (plan Phase D Task 5).
 *
 * Consumes the sanitized Phase A–D reports — the UI evidence file written by
 * verify-ui, the backend report (phase-b.json) written by verify-backend,
 * the runtime report (phase-c.json) written by verify-runtime, the real
 * acceptance report (phase-d-real.json) and the recovery acceptance report
 * (phase-d-recovery.json) — and derives the final real-acceptance column of
 * public/development-evidence.json without any manual status inflation.
 *
 * Rules (references/acceptance-matrix.md):
 *   - every consumed report must exist, parse, and carry a passing outcome;
 *   - every report commit must be an ancestor of the current HEAD (stale or
 *     foreign reports are rejected, never trusted);
 *   - the real loop report must contain V1 and V2, a final version >= V2 and
 *     zero secret findings; the recovery report must contain a confirmed
 *     restart, an observed interruption, zero file/HTTP/UI reconciliation
 *     mismatch and zero secret/hidden-thinking findings;
 *   - a capability becomes `verified` only when the UI evidence proves it,
 *     an HTTP report (Phase B six or Phase C ten) proves it and the real
 *     reports assigned to it by the acceptance matrix pass. Anything less
 *     stays `backend_connected` — this gate never demotes and never inflates.
 *
 * Any missing, stale or failed report throws `EVIDENCE_INCOMPLETE` and the
 * CLI exits 1 without touching the evidence file. On success the merged
 * evidence (UI + backend fields preserved, real acceptance fields appended)
 * is written atomically via temp file + rename.
 *
 * Executed by tsx (`npm run evidence:final` / `npm run core:evidence:final`)
 * and intentionally outside the tsconfig include set; it imports only the
 * capability registry and evidence helpers from src so capability ids and
 * the evidence merge semantics have a single source of truth.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, type CapabilityId } from '../src/client/mock/development-capabilities';
import {
  parseDevelopmentEvidence,
  type DevelopmentEvidenceFile,
} from '../src/client/mock/development-evidence';

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(WORKSPACE_ROOT, '..', '..');

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The five sanitized reports consumed by the aggregator. Fields are typed
 * unknown on purpose: the aggregator validates every schema itself and
 * rejects anything unusable instead of trusting file contents.
 */
export interface FinalEvidenceReports {
  /** public/development-evidence.json as written by verify-ui (merge semantics). */
  ui?: unknown;
  /** forge-core-overnight/evidence/sanitized-reports/phase-b.json. */
  backend?: unknown;
  /** forge-core-overnight/evidence/sanitized-reports/phase-c.json. */
  runtime?: unknown;
  /** forge-core-overnight/evidence/sanitized-reports/phase-d-real.json. */
  realLoop?: unknown;
  /** forge-core-overnight/evidence/sanitized-reports/phase-d-recovery.json. */
  recovery?: unknown;
}

export type FinalAcceptanceStage = 'verified' | 'backend_connected';

export interface FinalCapabilityAcceptance {
  id: string;
  label: string;
  realAcceptance: FinalAcceptanceStage;
}

export interface FinalEvidenceAggregate {
  capabilities: FinalCapabilityAcceptance[];
}

export interface EvidenceAncestryResolver {
  /** True when `commit` is on the ancestor chain of the current HEAD. */
  isAncestor(commit: string): boolean;
}

export interface AggregateEvidenceOptions {
  /** Defaults to the real Git history of this repository. */
  ancestry?: EvidenceAncestryResolver;
}

export class EvidenceIncompleteError extends Error {
  constructor(reason: string) {
    super(`EVIDENCE_INCOMPLETE: ${reason}`);
    this.name = 'EvidenceIncompleteError';
  }
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                          */
/* -------------------------------------------------------------------------- */

function fail(reason: string): never {
  throw new EvidenceIncompleteError(reason);
}

function requireRecord(raw: unknown, name: string): Record<string, unknown> {
  if (raw === undefined || raw === null) {
    fail(`missing report: ${name}`);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`report ${name} is not an object`);
  }
  return raw as Record<string, unknown>;
}

function requireField<T>(
  record: Record<string, unknown>,
  key: string,
  name: string,
  check: (value: unknown) => value is T,
  expectation: string,
): T {
  const value = record[key];
  if (!check(value)) {
    fail(`report ${name} field "${key}" must be ${expectation}`);
  }
  return value;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function requireOutcome(record: Record<string, unknown>, name: string, expected: string): void {
  const outcome = record['outcome'];
  if (outcome !== expected) {
    fail(`report ${name} has outcome ${JSON.stringify(outcome ?? null)} (expected "${expected}")`);
  }
}

function requireCommit(record: Record<string, unknown>, name: string): string {
  return requireField(record, 'commit', name, isString, 'a non-empty string');
}

function requireArtifactHistory(
  record: Record<string, unknown>,
  name: string,
): { versions: Set<number>; finalVersion: number } {
  const rawVersions = requireField(record, 'artifactVersions', name, Array.isArray, 'an array');
  const versions = new Set<number>();
  for (const entry of rawVersions) {
    if (typeof entry !== 'object' || entry === null) {
      fail(`report ${name} artifactVersions contains a non-object entry`);
    }
    const version = (entry as Record<string, unknown>)['version'];
    if (isNumber(version)) versions.add(version);
  }
  if (!versions.has(1) || !versions.has(2)) {
    fail(`report ${name} artifactVersions must contain both V1 and V2`);
  }
  const finalVersion = requireField(record, 'finalArtifactVersion', name, isNumber, 'a number');
  if (finalVersion < 2) {
    fail(`report ${name} finalArtifactVersion must be at least 2`);
  }
  const finalEntry = (rawVersions as Array<Record<string, unknown>>).find(
    (entry) => entry['version'] === finalVersion,
  );
  if (!finalEntry || finalEntry['final'] !== true) {
    fail(`report ${name} final artifact version ${finalVersion} must be marked final`);
  }
  return { versions, finalVersion };
}

/* -------------------------------------------------------------------------- */
/* Per-report schema validation                                                */
/* -------------------------------------------------------------------------- */

interface UiReport {
  commit: string;
  passedCapabilities: string[];
}

function parseUiReport(raw: unknown): UiReport {
  const record = requireRecord(raw, 'ui');
  if (record['schemaVersion'] !== 1) fail('report ui field "schemaVersion" must be 1');
  requireOutcome(record, 'ui', 'passed');
  const commit = requireCommit(record, 'ui');
  const passedCapabilities = requireField(
    record,
    'passedCapabilities',
    'ui',
    isStringArray,
    'a string array',
  );
  return { commit, passedCapabilities };
}

interface BackendReport {
  commit: string;
  backendConnectedCapabilities: string[];
}

function parseBackendReport(raw: unknown): BackendReport {
  const record = requireRecord(raw, 'backend');
  if (record['schemaVersion'] !== 1) fail('report backend field "schemaVersion" must be 1');
  if (record['gate'] !== 'core:verify-backend') {
    fail('report backend field "gate" must be "core:verify-backend"');
  }
  requireOutcome(record, 'backend', 'passed');
  const commit = requireCommit(record, 'backend');
  const backendConnectedCapabilities = requireField(
    record,
    'backendConnectedCapabilities',
    'backend',
    isStringArray,
    'a string array',
  );
  return { commit, backendConnectedCapabilities };
}

interface RuntimeReport {
  commit: string;
  backendConnectedCapabilities: string[];
}

function parseRuntimeReport(raw: unknown): RuntimeReport {
  const record = requireRecord(raw, 'runtime');
  if (record['schemaVersion'] !== 1) fail('report runtime field "schemaVersion" must be 1');
  if (record['gate'] !== 'core:verify-runtime') {
    fail('report runtime field "gate" must be "core:verify-runtime"');
  }
  requireOutcome(record, 'runtime', 'passed');
  const commit = requireCommit(record, 'runtime');
  const backendConnectedCapabilities = requireField(
    record,
    'backendConnectedCapabilities',
    'runtime',
    isStringArray,
    'a string array',
  );
  const boundary = requireRecord(record['piBoundary'], 'runtime piBoundary');
  if (boundary['passed'] !== true) fail('report runtime piBoundary.passed must be true');
  if (boundary['secretFindings'] !== 0) fail('report runtime piBoundary.secretFindings must be 0');
  if (boundary['thinkingFindings'] !== 0) {
    fail('report runtime piBoundary.thinkingFindings must be 0');
  }
  if (boundary['boundaryViolations'] !== 0) {
    fail('report runtime piBoundary.boundaryViolations must be 0');
  }
  return { commit, backendConnectedCapabilities };
}

interface RealLoopReport {
  commit: string;
}

function parseRealLoopReport(raw: unknown): RealLoopReport {
  const record = requireRecord(raw, 'realLoop');
  if (record['schemaVersion'] !== 'forge-core.real-acceptance/1') {
    fail('report realLoop field "schemaVersion" must be "forge-core.real-acceptance/1"');
  }
  requireOutcome(record, 'realLoop', 'completed');
  if (record['taskStatus'] !== 'completed') {
    fail('report realLoop field "taskStatus" must be "completed"');
  }
  const commit = requireCommit(record, 'realLoop');
  requireArtifactHistory(record, 'realLoop');
  if (record['secretFindingCount'] !== 0) {
    fail('report realLoop field "secretFindingCount" must be 0');
  }
  return { commit };
}

interface RecoveryReport {
  commit: string;
}

function parseRecoveryReport(raw: unknown): RecoveryReport {
  const record = requireRecord(raw, 'recovery');
  if (record['schemaVersion'] !== 'forge-core.real-recovery-acceptance/1') {
    fail('report recovery field "schemaVersion" must be "forge-core.real-recovery-acceptance/1"');
  }
  requireOutcome(record, 'recovery', 'completed');
  const commit = requireCommit(record, 'recovery');
  const restartCount = requireField(record, 'restartCount', 'recovery', isNumber, 'a number');
  if (restartCount < 1) fail('report recovery field "restartCount" must be at least 1');
  const interrupted = requireField(
    record,
    'interruptedObserved',
    'recovery',
    isBoolean,
    'a boolean',
  );
  if (interrupted !== true) fail('report recovery field "interruptedObserved" must be true');
  const reconciliation = requireRecord(record['reconciliation'], 'recovery reconciliation');
  if (reconciliation['mismatchCount'] !== 0) {
    fail('report recovery reconciliation.mismatchCount must be 0');
  }
  requireArtifactHistory(record, 'recovery');
  if (record['secretFindingCount'] !== 0) {
    fail('report recovery field "secretFindingCount" must be 0');
  }
  if (record['hiddenThinkingFindingCount'] !== 0) {
    fail('report recovery field "hiddenThinkingFindingCount" must be 0');
  }
  return { commit };
}

/* -------------------------------------------------------------------------- */
/* Capability coverage (references/acceptance-matrix.md Phase D column)        */
/* -------------------------------------------------------------------------- */

/**
 * Capabilities whose Phase D real acceptance requirement is proven by the
 * real loop report: the self-contained real template is copied, reloaded and
 * frozen into a real task; every turn runs through the constrained runtime
 * with per-attempt retry accounting and authorized Skill loads; artifacts
 * V1/V2(/V3) are published through the legal action commit and the final
 * artifact is accepted only by the system final check. The loop's event
 * stream also feeds the file/UI reconciliation together with the recovery
 * run (workspace).
 */
const REAL_LOOP_COVERED: ReadonlySet<CapabilityId> = new Set([
  'templates',
  'template_reload',
  'task_creation',
  'workspace',
  'retry',
  'skills',
  'artifacts',
  'final_output',
]);

/**
 * Capabilities whose Phase D real acceptance requirement is proven by the
 * recovery report: a confirmed restart after a boundary interruption with
 * the task resumed (task_recovery, lifecycle) and the file/HTTP/UI views
 * reconciled with zero mismatch (workspace).
 */
const RECOVERY_COVERED: ReadonlySet<CapabilityId> = new Set([
  'task_recovery',
  'workspace',
  'lifecycle',
]);

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                 */
/* -------------------------------------------------------------------------- */

function defaultAncestryResolver(): EvidenceAncestryResolver {
  return {
    isAncestor(commit: string): boolean {
      const result = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
      });
      return result.status === 0;
    },
  };
}

/**
 * Validates all five sanitized reports (presence, exact schema, passing
 * outcome, commit ancestry) and derives the final real-acceptance verdict
 * per capability. Throws EvidenceIncompleteError on any missing, stale or
 * failed report; never inflates a capability that lacks any required
 * dimension — such a capability stays `backend_connected`.
 */
export function aggregateEvidence(
  reports: FinalEvidenceReports,
  options: AggregateEvidenceOptions = {},
): FinalEvidenceAggregate {
  const ui = parseUiReport(reports.ui);
  const backend = parseBackendReport(reports.backend);
  const runtime = parseRuntimeReport(reports.runtime);
  const realLoop = parseRealLoopReport(reports.realLoop);
  const recovery = parseRecoveryReport(reports.recovery);

  const ancestry = options.ancestry ?? defaultAncestryResolver();
  for (const [name, commit] of [
    ['ui', ui.commit],
    ['backend', backend.commit],
    ['runtime', runtime.commit],
    ['realLoop', realLoop.commit],
    ['recovery', recovery.commit],
  ] as const) {
    if (!ancestry.isAncestor(commit)) {
      fail(`report ${name} commit ${commit} is not an ancestor of HEAD (stale or foreign report)`);
    }
  }

  const uiPassed = new Set(ui.passedCapabilities);
  const httpConnected = new Set([
    ...backend.backendConnectedCapabilities,
    ...runtime.backendConnectedCapabilities,
  ]);

  const capabilities: FinalCapabilityAcceptance[] = CAPABILITIES.map(([id, label]) => {
    const provenByUi = uiPassed.has(id);
    const provenByHttp = httpConnected.has(id);
    // Both real reports have already been validated as passing above; a
    // capability is covered when at least one of them owns its matrix row.
    const coveredByRealReports = REAL_LOOP_COVERED.has(id) || RECOVERY_COVERED.has(id);
    const realAcceptance: FinalAcceptanceStage =
      provenByUi && provenByHttp && coveredByRealReports ? 'verified' : 'backend_connected';
    return { id, label, realAcceptance };
  });

  return { capabilities };
}

/* -------------------------------------------------------------------------- */
/* Evidence file merge and atomic write                                        */
/* -------------------------------------------------------------------------- */

/**
 * Merges the aggregate verdict into the persisted evidence file shape:
 * UI and backend fields come from the persisted file (seed semantics when
 * unusable), real acceptance fields come from this aggregation. The verdict
 * is all-or-nothing like the other gates — every capability verified means
 * outcome "passed" with the full list; anything less records "failed" with
 * an empty proven subset so no cell can stay claimed green (spec §15.3).
 */
export function mergeFinalAcceptance(
  persistedEvidence: unknown,
  aggregate: FinalEvidenceAggregate,
): DevelopmentEvidenceFile {
  const base = parseDevelopmentEvidence(persistedEvidence);
  const verifiedIds = aggregate.capabilities
    .filter((capability) => capability.realAcceptance === 'verified')
    .map((capability) => capability.id);
  const allVerified = verifiedIds.length === CAPABILITIES.length;
  return {
    ...base,
    realAcceptanceOutcome: allVerified ? 'passed' : 'failed',
    realAcceptanceVerifiedCapabilities: allVerified ? verifiedIds : [],
  };
}

/** Writes the evidence file atomically (temp file + rename, same volume). */
export function writeFinalEvidenceAtomic(targetPath: string, payload: unknown): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tempPath, targetPath);
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

export interface FinalEvidencePaths {
  repoRoot: string;
  evidencePath: string;
  backendReportPath: string;
  runtimeReportPath: string;
  realLoopReportPath: string;
  recoveryReportPath: string;
}

export function defaultFinalEvidencePaths(): FinalEvidencePaths {
  const reportDir = resolve(REPO_ROOT, 'forge-core-overnight', 'evidence', 'sanitized-reports');
  return {
    repoRoot: REPO_ROOT,
    evidencePath: resolve(WORKSPACE_ROOT, 'public', 'development-evidence.json'),
    backendReportPath: resolve(reportDir, 'phase-b.json'),
    runtimeReportPath: resolve(reportDir, 'phase-c.json'),
    realLoopReportPath: resolve(reportDir, 'phase-d-real.json'),
    recoveryReportPath: resolve(reportDir, 'phase-d-recovery.json'),
  };
}

function readReportFile(path: string, name: string): unknown {
  if (!existsSync(path)) {
    fail(`missing report: ${name} (${basename(path)} not found)`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    fail(`report ${name} is not valid JSON (${basename(path)})`);
  }
}

export function runFinalEvidenceCli(paths: FinalEvidencePaths = defaultFinalEvidencePaths()): number {
  try {
    const reports: FinalEvidenceReports = {
      ui: readReportFile(paths.evidencePath, 'ui'),
      backend: readReportFile(paths.backendReportPath, 'backend'),
      runtime: readReportFile(paths.runtimeReportPath, 'runtime'),
      realLoop: readReportFile(paths.realLoopReportPath, 'realLoop'),
      recovery: readReportFile(paths.recoveryReportPath, 'recovery'),
    };
    const ancestry: EvidenceAncestryResolver = {
      isAncestor(commit: string): boolean {
        const result = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
          cwd: paths.repoRoot,
          stdio: 'ignore',
        });
        return result.status === 0;
      },
    };
    const aggregate = aggregateEvidence(reports, { ancestry });
    const merged = mergeFinalAcceptance(reports.ui, aggregate);
    writeFinalEvidenceAtomic(paths.evidencePath, merged);
    const verifiedCount = aggregate.capabilities.filter(
      (capability) => capability.realAcceptance === 'verified',
    ).length;
    console.log(
      `[evidence:final] 证据已原子写入 public/development-evidence.json：` +
        `realAcceptanceOutcome=${merged.realAcceptanceOutcome}，verified=${verifiedCount}/${CAPABILITIES.length}`,
    );
    if (merged.realAcceptanceOutcome !== 'passed') {
      console.log('[evidence:final] 未全部 verified，realAcceptance 判为 failed（不留绿）。');
      return 1;
    }
    return 0;
  } catch (error: unknown) {
    if (error instanceof EvidenceIncompleteError) {
      console.error(`[evidence:final] ${error.message}`);
      return 1;
    }
    console.error(
      `[evidence:final] crashed (${error instanceof Error ? error.message : 'unknown error'})`,
    );
    return 1;
  }
}

/* -------------------------------------------------------------------------- */
/* CLI guard                                                                   */
/* -------------------------------------------------------------------------- */

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  process.exit(runFinalEvidenceCli());
}
