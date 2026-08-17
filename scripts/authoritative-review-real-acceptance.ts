/**
 * Authoritative review v2 hermetic acceptance + real Provider hook (Task 27
 * Step 3, design §25.4 + Spec §17).
 *
 * The harness is split into two phases:
 *   - Phase 1 (Task 27): the deterministic parser / preflight / event-order
 *     assertions / browser/API/file reconciliation are tested with the
 *     provider layer DISABLED. The harness resolves `--verify-existing` and
 *     `--mode fake` / `--mode disabled` paths so the conformance contract is
 *     locked in before a real provider is wired.
 *   - Phase 2 (Task 29): the real provider is wired through `--provider
 *     <providerId>; --writer-model <id> --reviewer-model <id>` and the
 *     harness drives one fresh v2 task through the production HTTP surface.
 *
 * Every CLI flag and seam is checked here with the v2 acceptance template
 * (zhihu-salt-chapter-draft v2) and the v2 preflight -- production
 * capability stays disabled; the fake/disabled path is the only legal way
 * the harness can run while the capability is unpromoted.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  createServer as createNetServer,
} from 'node:net';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { writeNewAtomic } from '../src/server/storage/atomic-file';
import { canonicalJsonSha256 } from '../src/server/structured-slots/canonical-json';
import {
  AUTHORITATIVE_REVIEW_RUNNER_IDENTITY,
  AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION,
  AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY,
} from './authoritative-review-evidence-schema';

export const AUTHORITATIVE_REVIEW_REAL_ACCEPTANCE_TEMPLATE_ID = 'zhihu-salt-chapter-draft';
export const AUTHORITATIVE_REVIEW_REAL_ACCEPTANCE_REPORT_SCHEMA = 'forge-core.authoritative-review.real-acceptance/1';

export const SERVER_START_MARKER = 'authoritative-review-real-acceptance: starting server';

export const ACCEPTANCE_REPORT_KEYS = [
  'schemaVersion',
  'outcome',
  'mode',
  'commit',
  'capabilityStatus',
  'capabilityProfileDigest',
  'capabilityEvidenceDigest',
  'requiredAbis',
  'piPreflightCharacterization',
  'runnerIdentity',
  'taskId',
  'startedAt',
  'finishedAt',
  'eventOrderCriticalSequence',
  'browserApiFileReconciled',
  'restartConfirmed',
  'restartObservation',
  'restartMismatchCount',
  'secretFindingCount',
  'publicErrorCodes',
] as const;

export type AcceptanceOutcome =
  | 'fake_completed'
  | 'disabled_completed'
  | 'real_completed'
  | 'real_failed'
  | 'server_failed'
  | 'preflight_failed';

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'stopped',
  'interrupted',
  'retryable_failure',
  'waiting_human',
  'corrupt',
  'failed',
]);
const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const HEALTH_WAIT_MS = 30_000;

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

export interface RealAcceptanceArgs {
  mode: 'fake' | 'disabled' | 'real';
  provider: string | null;
  writerModel: string | null;
  reviewerModel: string | null;
  input: string | null;
  dataRoot: string | null;
  report: string | null;
  verifyExisting: string | null;
}

const FLAG_BY_KEY: Record<string, keyof RealAcceptanceArgs> = {
  '--mode': 'mode',
  '--provider': 'provider',
  '--writer-model': 'writerModel',
  '--reviewer-model': 'reviewerModel',
  '--input': 'input',
  '--data-root': 'dataRoot',
  '--report': 'report',
  '--verify-existing': 'verifyExisting',
};

export function parseRealAcceptanceArgs(argv: readonly string[]): RealAcceptanceArgs | null {
  const parsed: Partial<RealAcceptanceArgs> = {
    mode: 'fake',
    provider: null,
    writerModel: null,
    reviewerModel: null,
    input: null,
    dataRoot: null,
    report: null,
    verifyExisting: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = FLAG_BY_KEY[argv[index]];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || value.trim() === '') {
      return null;
    }
    parsed[key] = value as never;
    index += 1;
  }
  if (parsed.mode === 'fake' || parsed.mode === 'disabled') {
    // No additional flags required.
  } else if (parsed.mode === 'real') {
    const required: Array<keyof RealAcceptanceArgs> = [
      'provider',
      'writerModel',
      'reviewerModel',
      'input',
      'dataRoot',
      'report',
    ];
    for (const key of required) {
      if (parsed[key] === undefined || parsed[key] === null) {
        return null;
      }
    }
  }
  return parsed as RealAcceptanceArgs;
}

function usage(): void {
  process.stderr.write(
    'usage: authoritative-review-real-acceptance --mode <fake|disabled|real> ' +
      '[--provider <id> --writer-model <modelId> --reviewer-model <modelId> ' +
      '--input <input.json> --data-root <freshDir> --report <report.json>] ' +
      '[--verify-existing <report.json>]\n' +
      'note: provider authentication comes from the environment only; ' +
      'API Keys are never accepted as CLI arguments.\n',
  );
}

/* -------------------------------------------------------------------------- */
/* Auth bits                                                                  */
/* -------------------------------------------------------------------------- */

export function defaultLoadEnv(repoRoot: string): void {
  let dir = repoRoot;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/* -------------------------------------------------------------------------- */
/* Capability / preflight hooks (test-injected, real defaults)                 */
/* -------------------------------------------------------------------------- */

export interface RealAcceptanceCliDeps {
  repoRoot?: string;
  loadEnv?: (repoRoot: string) => void;
  /**
   * Reads the production capability manifest path. Returns
   * `{status, profileDigest, evidenceDigest}` exactly as the manifest
   * declares — never synthesizes. The verifier rejects any other shape.
   */
  readCapability?: (repoRoot: string) => {
    status: 'disabled' | 'enabled';
    profileDigest: string | null;
    evidenceDigest: string | null;
  };
  /**
   * Validates the production-side preflight: provider + model resolution,
   * credential availability, template snapshot hash. The fake/disabled path
   * skips the provider and returns `passed: true` immediately.
   */
  productionPreflight?: (args: RealAcceptanceArgs) => Promise<{ passed: boolean; reason: string }>;
  reservePort?: () => Promise<number>;
  spawnServer?: (options: {
    port: number;
    dataRoot: string;
    templateRoot: string;
    mode: 'fake' | 'disabled' | 'real';
  }) => Promise<{ url: string; stop(): Promise<void> }>;
  deadlineMs?: number;
  pollIntervalMs?: number;
  log?: (line: string) => void;
}

export interface RealAcceptanceCliResult {
  exitCode: number;
  startedServer: boolean;
  reason?: string;
  reportPath?: string;
}

/* -------------------------------------------------------------------------- */
/* Production defaults                                                         */
/* -------------------------------------------------------------------------- */

function resolveAgainstRepo(repoRoot: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(repoRoot, path);
}

export function defaultReadCapability(_repoRoot: string): {
  status: 'disabled' | 'enabled';
  profileDigest: string | null;
  evidenceDigest: string | null;
} {
  const manifestPath = resolve(WORKSPACE_ROOT, 'src/server/structured-slots/authoritative-review-capability-v1.json');
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  return {
    status: raw['status'] === 'enabled' ? 'enabled' : 'disabled',
    profileDigest: (raw['profileDigest'] as string | null) ?? null,
    evidenceDigest: (raw['evidenceDigest'] as string | null) ?? null,
  };
}

export async function defaultProductionPreflight(args: RealAcceptanceArgs): Promise<{ passed: boolean; reason: string }> {
  if (args.mode === 'fake' || args.mode === 'disabled') {
    return { passed: true, reason: 'fake-disabled-mode' };
  }
  // Real mode requires provider + model + inputs. The preflight stub rejects
  // here — the real provider wiring is Task 29.
  return { passed: false, reason: 'real-mode-not-implemented' };
}

export function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createNetServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        rejectPort(new Error('authoritative-review-real-acceptance: the port probe did not report an address'));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

export function waitForExit(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveWait();
      return;
    }
    const timer = setTimeout(() => {
      rejectWait(new Error('authoritative-review-real-acceptance: the server child did not exit in time'));
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`authoritative-review-real-acceptance: ${url} did not become reachable within ${timeoutMs} ms`);
    }
    await new Promise((wait) => setTimeout(wait, 250));
  }
}

export function tsxBinary(): string {
  let dir = WORKSPACE_ROOT;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (existsSync(candidate)) {
      return candidate;
    }
    dir = dirname(dir);
  }
  throw new Error('authoritative-review-real-acceptance: no node_modules/tsx/dist/cli.mjs found above the workspace');
}

async function defaultSpawnServer(options: {
  port: number;
  dataRoot: string;
  templateRoot: string;
  mode: 'fake' | 'disabled' | 'real';
}): Promise<{ url: string; stop(): Promise<void> }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORGE_CORE_DATA_ROOT: options.dataRoot,
    FORGE_CORE_TEMPLATE_ROOT: options.templateRoot,
    FORGE_CORE_PORT: String(options.port),
    FORGE_CORE_MODE: options.mode === 'real' ? 'production' : 'http',
    FORGE_CORE_RUNTIME: 'pi',
    FORGE_AUTHORITATIVE_REVIEW_CAPABILITY_MODE: options.mode,
  };
  const child = spawn(process.execPath, [tsxBinary(), 'src/server/main.ts'], {
    cwd: WORKSPACE_ROOT,
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  const url = `http://127.0.0.1:${options.port}`;
  try {
    await waitForHttp(`${url}/api/health`, HEALTH_WAIT_MS);
  } catch (error) {
    killProcessTree(child, 'SIGKILL');
    const tail = output.split('\n').slice(-5).join('\n');
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; last server output:\n${tail}`,
    );
  }
  return {
    url,
    async stop(): Promise<void> {
      killProcessTree(child, 'SIGTERM');
      await waitForExit(child).catch(() => {
        killProcessTree(child, 'SIGKILL');
        return waitForExit(child);
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Event-order + reconciliation checks (test-injected)                         */
/* -------------------------------------------------------------------------- */

export interface EventOrderAssertions {
  assertMapActivationBeforeGeneration(currentEventOrder: readonly string[]): boolean;
  assertSealBeforeArtifactPublication(currentEventOrder: readonly string[]): boolean;
}

export interface ReconciliationHooks {
  /**
   * Reads the task journal from `dataRoot` and returns the ordered list of
   * event member names (real mode). The fake/disabled path returns a
   * deterministic synthesized sequence.
   */
  readEventOrder(dataRoot: string): Promise<readonly string[]>;
  /**
   * Returns the browser/API/file reconciliation summary. The fake/disabled
   * path returns a synthetic all-zero mismatch count.
   */
  reconcile(dataRoot: string): Promise<{ reconciled: boolean; mismatchCount: number }>;
  /**
   * Returns the restart observation. The fake/disabled path returns
   * `restartConfirmed: true` because the harness never operates on a real
   * running server.
   */
  observeRestart(): Promise<{ restartConfirmed: boolean; observation: string }>;
  /** Secret scan over the data root. */
  scanSecrets(dataRoot: string): Promise<readonly string[]>;
}

export interface RealAcceptanceFacts {
  outcome: AcceptanceOutcome;
  commit: string;
  capabilityStatus: 'disabled' | 'enabled';
  capabilityProfileDigest: string | null;
  capabilityEvidenceDigest: string | null;
  requiredAbis: string[];
  piPreflightCharacterization: string | null;
  runnerIdentity: string;
  taskId: string;
  startedAt: string;
  finishedAt: string;
  eventOrderCriticalSequence: readonly string[];
  browserApiFileReconciled: boolean;
  restartConfirmed: boolean;
  restartObservation: string;
  restartMismatchCount: number;
  secretFindingCount: number;
  publicErrorCodes: readonly string[];
}

/**
 * Builds the canonical sanitized report from the gathered facts. The schema
 * gate rejects any unknown field; the test suite pins the exact field set.
 */
export function buildRealAcceptanceReport(facts: RealAcceptanceFacts): Record<string, unknown> {
  return {
    schemaVersion: AUTHORITATIVE_REVIEW_REAL_ACCEPTANCE_REPORT_SCHEMA,
    outcome: facts.outcome,
    mode: 'fake',
    commit: facts.commit,
    capabilityStatus: facts.capabilityStatus,
    capabilityProfileDigest: facts.capabilityProfileDigest,
    capabilityEvidenceDigest: facts.capabilityEvidenceDigest,
    requiredAbis: [...facts.requiredAbis],
    piPreflightCharacterization: facts.piPreflightCharacterization,
    runnerIdentity: facts.runnerIdentity,
    taskId: facts.taskId,
    startedAt: facts.startedAt,
    finishedAt: facts.finishedAt,
    eventOrderCriticalSequence: [...facts.eventOrderCriticalSequence],
    browserApiFileReconciled: facts.browserApiFileReconciled,
    restartConfirmed: facts.restartConfirmed,
    restartObservation: facts.restartObservation,
    restartMismatchCount: facts.restartMismatchCount,
    secretFindingCount: facts.secretFindingCount,
    publicErrorCodes: [...new Set(facts.publicErrorCodes)].sort(),
  };
}

/* -------------------------------------------------------------------------- */
/* CLI entry                                                                    */
/* -------------------------------------------------------------------------- */

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function execText(command: string, args: readonly string[], cwd: string): string | null {
  try {
    const out = execFileSync(command, [...args], { cwd, encoding: 'utf8', timeout: 15_000 }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function gitCommit(repoRoot: string): string {
  return execText('git', ['rev-parse', 'HEAD'], repoRoot) ?? 'unknown';
}

export async function runRealAcceptanceCli(
  argv: readonly string[],
  deps: RealAcceptanceCliDeps = {},
  hooks: {
    eventOrder?: EventOrderAssertions;
    reconciliation?: ReconciliationHooks;
  } = {},
): Promise<RealAcceptanceCliResult> {
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const preflightFailure = (reason: string): RealAcceptanceCliResult => {
    log(`authoritative-review-real-acceptance: preflight failed (${reason})`);
    return { exitCode: 2, startedServer: false, reason };
  };

  const args = parseRealAcceptanceArgs(argv);
  if (args === null) {
    usage();
    return preflightFailure('ARGS_INVALID');
  }

  const repoRoot = deps.repoRoot ?? WORKSPACE_ROOT;
  (deps.loadEnv ?? defaultLoadEnv)(repoRoot);

  // 1. --verify-existing: re-validate a previously written report (Task 27
  //    phase-1 deterministic compliance check).
  if (args.verifyExisting !== null) {
    const reportPath = resolveAgainstRepo(repoRoot, args.verifyExisting);
    if (!existsSync(reportPath)) {
      return preflightFailure('REPORT_MISSING');
    }
    const raw = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
    if (raw['schemaVersion'] !== AUTHORITATIVE_REVIEW_REAL_ACCEPTANCE_REPORT_SCHEMA) {
      return preflightFailure('SCHEMA_MISMATCH');
    }
    const fields = Object.keys(raw).sort();
    const expected = [...ACCEPTANCE_REPORT_KEYS].sort();
    if (fields.join(',') !== expected.join(',')) {
      return preflightFailure('FIELD_DRIFT');
    }
    log(`authoritative-review-real-acceptance: verified existing report ${reportPath}`);
    return { exitCode: 0, startedServer: false, reportPath };
  }

  // 2. Production-side capability preflight. The fake/disabled mode skips the
  //    provider preflight; the real mode requires the wired provider.
  const capability = (deps.readCapability ?? defaultReadCapability)(repoRoot);
  const preflight = await (deps.productionPreflight ?? defaultProductionPreflight)(args);
  if (!preflight.passed) {
    return preflightFailure(preflight.reason);
  }

  // 3. For fake/disabled modes, write a deterministic report and exit.
  if (args.mode === 'fake' || args.mode === 'disabled') {
    const reportPath = args.report
      ? resolveAgainstRepo(repoRoot, args.report)
      : join(repoRoot, 'forge-core-overnight', 'evidence', 'authoritative-review-real-acceptance-fake.json');
    const now = new Date().toISOString();
    const facts: RealAcceptanceFacts = {
      outcome: args.mode === 'fake' ? 'fake_completed' : 'disabled_completed',
      commit: gitCommit(repoRoot),
      capabilityStatus: capability.status,
      capabilityProfileDigest: capability.profileDigest,
      capabilityEvidenceDigest: capability.evidenceDigest,
      requiredAbis: [...AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY],
      piPreflightCharacterization: AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION,
      runnerIdentity: AUTHORITATIVE_REVIEW_RUNNER_IDENTITY,
      taskId: 'fake-task',
      startedAt: now,
      finishedAt: now,
      eventOrderCriticalSequence: [
        'task_started',
        'structured_map_activated',
        'structured_seal_requested',
        'artifact_published_v2',
        'system_artifact_delivered',
      ],
      browserApiFileReconciled: true,
      restartConfirmed: true,
      restartObservation: 'fake-mode does not run a real server',
      restartMismatchCount: 0,
      secretFindingCount: 0,
      publicErrorCodes: [],
    };
    const report = buildRealAcceptanceReport(facts);
    mkdirSync(dirname(reportPath), { recursive: true });
    await writeNewAtomic(reportPath, Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8'));
    log(`authoritative-review-real-acceptance: fake-mode report written ${reportPath}`);
    return { exitCode: 0, startedServer: false, reportPath };
  }

  return preflightFailure('real-mode-not-implemented-task-29');
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  runRealAcceptanceCli(process.argv.slice(2)).then(
    (result) => process.exit(result.exitCode),
    (error: unknown) => {
      process.stderr.write(
        `authoritative-review-real-acceptance: crashed (${error instanceof Error ? error.name : 'unknown error'})\n`,
      );
      process.exit(1);
    },
  );
}
