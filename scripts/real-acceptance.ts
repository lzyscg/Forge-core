/**
 * Sanitized real Provider acceptance runner (plan Phase D Task 2).
 *
 * Drives ONE authentic production loop (template reload -> task creation ->
 * start -> poll workspace to a terminal state) exclusively through the public
 * HTTP surface of a real Forge Core server running the constrained Pi
 * runtime, and writes ONE atomic sanitized JSON report.
 *
 * Strict preflight order — every failure exits 2 BEFORE any server is
 * constructed:
 *
 *   1. argument parsing (six required flags; an API Key is NEVER accepted as
 *      a CLI argument — auth comes only from the environment/ModelRuntime);
 *   2. resolve repo root, validate the `--input` JSON and the committed
 *      template source;
 *   3. the data root must be a brand-new empty directory (created on demand,
 *      existing task/cache content refused) and the report path must be fresh;
 *   4. provider + writer/reviewer models must resolve through ModelRuntime
 *      and the provider credential must be configured (boolean only — the
 *      credential value is never read into any report object);
 *   5. the Phase C Pi boundary probe must pass (subprocess `probe:pi`,
 *      report at `forge-core-overnight/evidence/sanitized-reports/
 *      pi-boundary.json`);
 *   6. the committed `templates/` directory is validated once through the
 *      generic template loader and used directly (read-only) as the server
 *      template root — the committed templates already carry runnable
 *      `deepseek/<model>` model specs (placeholder protocol retired).
 *
 * Exit codes: 0 = completed with zero secret findings; 1 = a failure after
 * the server phase started; 2 = preflight failure (no server constructed).
 *
 * Usage:
 *   npm run acceptance:real -- --provider <providerId> --writer-model <modelId> \
 *     --reviewer-model <modelId> --input <input.json> --data-root <freshDir> \
 *     --report <report.json>
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { writeNewAtomic } from '../src/server/storage/atomic-file';
import { loadTemplateDirectory } from '../src/server/template/template-loader';
import type { RouteKind, TaskWorkspace } from '../src/shared/contracts';
import { sanitizeAcceptanceReport, scanForAcceptanceSecrets } from './scan-acceptance-secrets';

/** Acceptance template identity (business content stays in the template dir). */
export const ACCEPTANCE_TEMPLATE_ID = 'zhihu-single-chapter';

/** Emitted exactly when the server phase begins; the tests assert ordering. */
export const SERVER_START_MARKER = 'acceptance: starting server';

export const ACCEPTANCE_REPORT_SCHEMA_VERSION = 'forge-core.real-acceptance/1';

/** The exact sanitized report field set (plan Task 2 Step 6). */
export const ACCEPTANCE_REPORT_KEYS = [
  'schemaVersion',
  'outcome',
  'commit',
  'versions',
  'providerId',
  'writerModelId',
  'reviewerModelId',
  'taskId',
  'startedAt',
  'finishedAt',
  'taskStatus',
  'agentCallCount',
  'attemptCount',
  'executedRouteKinds',
  'artifactVersions',
  'finalArtifactVersion',
  'finalArtifactHash',
  'restartCount',
  'publicErrorCodes',
  'secretFindingCount',
] as const;

export type AcceptanceOutcome = 'completed' | 'task_failed' | 'deadline_exceeded' | 'server_failed';

const ACCEPTANCE_TASK_NAME = '真实提供方验收任务';
const TASK_ID_PREFIX_LENGTH = 8;
const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const HEALTH_WAIT_MS = 30_000;
const REPORT_FILE_NAME = 'pi-boundary.json';

/**
 * Statuses the runner treats as settled: it never answers human questions,
 * retries manually or resumes interrupted tasks, so anything not actively
 * running ends the poll loop and is reported as-is.
 */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'stopped',
  'interrupted',
  'retryable_failure',
  'waiting_human',
  'corrupt',
]);

/** the project root — derived from this script's location (scripts -> one up). */
const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Repo root — three levels up from the project root/scripts. */
const RUNNER_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* -------------------------------------------------------------------------- */
/* CLI arguments                                                                */
/* -------------------------------------------------------------------------- */

export interface AcceptanceArgs {
  provider: string;
  writerModel: string;
  reviewerModel: string;
  input: string;
  dataRoot: string;
  report: string;
}

const FLAG_BY_KEY: Record<string, keyof AcceptanceArgs> = {
  '--provider': 'provider',
  '--writer-model': 'writerModel',
  '--reviewer-model': 'reviewerModel',
  '--input': 'input',
  '--data-root': 'dataRoot',
  '--report': 'report',
};

/**
 * Pure argument parser: exactly the six required flags, each with a non-empty
 * value. Any unknown flag (including credential-shaped ones) yields null —
 * authentication may only ever come from the environment/ModelRuntime.
 */
export function parseAcceptanceArgs(argv: readonly string[]): AcceptanceArgs | null {
  const parsed: Partial<AcceptanceArgs> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = FLAG_BY_KEY[argv[index]];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || value.trim() === '') {
      return null;
    }
    parsed[key] = value;
    index += 1;
  }
  const required: Array<keyof AcceptanceArgs> = [
    'provider',
    'writerModel',
    'reviewerModel',
    'input',
    'dataRoot',
    'report',
  ];
  for (const key of required) {
    if (parsed[key] === undefined) {
      return null;
    }
  }
  return parsed as AcceptanceArgs;
}

function usage(): void {
  process.stderr.write(
    'usage: real-acceptance --provider <providerId> --writer-model <modelId> ' +
      '--reviewer-model <modelId> --input <input.json> --data-root <freshDir> ' +
      '--report <report.json>\n' +
      'note: provider authentication comes from the environment only; ' +
      'API Keys are never accepted as CLI arguments.\n',
  );
}

/* -------------------------------------------------------------------------- */
/* Injected seams (tests pin each preflight branch; production uses defaults)  */
/* -------------------------------------------------------------------------- */

/** Structural view of the SDK ModelRuntime the preflight needs. */
export interface PreflightModelRuntime {
  getProvider(providerId: string): unknown;
  getModel(providerId: string, modelId: string): unknown;
  hasConfiguredAuth(providerId: string): boolean;
}

export interface BoundaryProbeRequest {
  providerId: string;
  modelId: string;
  reportPath: string;
  cwd: string;
}

export interface SpawnServerOptions {
  port: number;
  dataRoot: string;
  templateRoot: string;
}

export interface AcceptanceServerHandle {
  url: string;
  stop(): Promise<void>;
}

export interface AcceptanceCliDeps {
  repoRoot?: string;
  loadEnv?: (repoRoot: string) => void;
  createModelRuntime?: () => Promise<PreflightModelRuntime>;
  runBoundaryProbe?: (request: BoundaryProbeRequest) => Promise<number>;
  reservePort?: () => Promise<number>;
  spawnServer?: (options: SpawnServerOptions) => Promise<AcceptanceServerHandle>;
  deadlineMs?: number;
  pollIntervalMs?: number;
  log?: (line: string) => void;
}

export interface AcceptanceCliResult {
  exitCode: number;
  startedServer: boolean;
  reason?: string;
  reportPath?: string;
}

/* -------------------------------------------------------------------------- */
/* Defaults (production paths)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Loads the nearest `.env` walking up from the repo root into process.env.
 * dotenv owns the parse; credential values are never read, echoed or returned
 * by this runner — they stay inside the environment where the ModelRuntime
 * and the spawned server resolve them.
 */
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

export async function defaultCreateModelRuntime(): Promise<PreflightModelRuntime> {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  return ModelRuntime.create({ allowModelNetwork: false });
}

/** Spawns the Phase C boundary probe through the root npm script. */
export function defaultRunBoundaryProbe(request: BoundaryProbeRequest): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(
      'npm',
      [
        'run',
        'probe:pi',
        '--',
        '--provider',
        request.providerId,
        '--model',
        request.modelId,
        '--report',
        request.reportPath,
      ],
      { cwd: request.cwd, stdio: ['ignore', 'inherit', 'inherit'] },
    );
    child.on('error', () => resolveExit(1));
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
}

/** Reserves one free loopback port for the acceptance server. */
export function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createNetServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        rejectPort(new Error('acceptance: the port probe did not report an address'));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

/** Locates the hoisted tsx binary by walking up from the workspace root. */
/**
 * Locates the hoisted tsx CLI script by walking up from the workspace root.
 * Returns the JS entry point (not the `.bin` shim): spawned through
 * `process.execPath`, which works cross-platform — Windows cannot spawn the
 * extensionless POSIX shims in `node_modules/.bin`.
 */
export function tsxBinary(): string {
  let dir = WORKSPACE_ROOT;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (existsSync(candidate)) {
      return candidate;
    }
    dir = dirname(dir);
  }
  throw new Error('acceptance: no node_modules/tsx/dist/cli.mjs found above the workspace');
}

export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not up yet; keep polling until the deadline.
    }
    if (Date.now() > deadline) {
      throw new Error(`acceptance: ${url} did not become reachable within ${timeoutMs} ms`);
    }
    await new Promise((wait) => setTimeout(wait, 250));
  }
}

/** Signals the child's whole process group (detached spawn, Phase C lesson). */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone; the exit wait settles the caller.
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
      rejectWait(new Error('acceptance: the server child did not exit in time'));
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

/**
 * Production server spawn: `tsx src/server/main.ts` as a detached process
 * group over the acceptance roots, production mode, real Pi runtime. Provider
 * auth is inherited from the environment — never passed as an argument.
 */
async function defaultSpawnServer(options: SpawnServerOptions): Promise<AcceptanceServerHandle> {
  const child = spawn(process.execPath, [tsxBinary(), 'src/server/main.ts'], {
    cwd: WORKSPACE_ROOT,
    detached: true,
    env: {
      ...process.env,
      FORGE_CORE_DATA_ROOT: options.dataRoot,
      FORGE_CORE_TEMPLATE_ROOT: options.templateRoot,
      FORGE_CORE_PORT: String(options.port),
      FORGE_CORE_MODE: 'production',
      FORGE_CORE_RUNTIME: 'pi',
    },
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
/* Versions, commit and HTTP plumbing                                           */
/* -------------------------------------------------------------------------- */

function execText(command: string, args: readonly string[], cwd: string): string | null {
  try {
    const out = execFileSync(command, [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function readPiPackageVersion(): string {
  let dir = WORKSPACE_ROOT;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
        return typeof parsed.version === 'string' ? parsed.version : 'unknown';
      } catch {
        return 'unknown';
      }
    }
    dir = dirname(dir);
  }
  return 'unknown';
}

export function collectVersions(repoRoot: string): { node: string; npm: string; pi: string } {
  return {
    node: process.version,
    npm: execText('npm', ['--version'], repoRoot) ?? 'unknown',
    pi: readPiPackageVersion(),
  };
}

export function gitCommit(repoRoot: string): string {
  return execText('git', ['rev-parse', 'HEAD'], repoRoot) ?? 'unknown';
}

/** Public HTTP error envelope code, extracted without touching other fields. */
export class AcceptanceHttpError extends Error {
  readonly code: string;

  readonly status: number;

  constructor(code: string, status: number) {
    super(`acceptance: the API answered ${status} (${code})`);
    this.name = 'AcceptanceHttpError';
    this.code = code;
    this.status = status;
  }
}

function extractPublicErrorCode(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== 'object') return null;
  const error = (parsed as Record<string, unknown>).error;
  if (error === null || typeof error !== 'object') return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

export async function httpJson(
  method: 'GET' | 'POST',
  url: string,
  body: unknown,
  publicErrorCodes: Set<string>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === null ? undefined : { 'Content-Type': 'application/json' },
      body: body === null ? undefined : JSON.stringify(body),
    });
  } catch {
    publicErrorCodes.add('NETWORK_ERROR');
    throw new AcceptanceHttpError('NETWORK_ERROR', 0);
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const code = extractPublicErrorCode(parsed) ?? `HTTP_${response.status}`;
    publicErrorCodes.add(code);
    throw new AcceptanceHttpError(code, response.status);
  }
  return parsed;
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length > 0 && entries.every(([, entry]) => typeof entry === 'string');
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Sanitized report construction                                                */
/* -------------------------------------------------------------------------- */

export interface AcceptanceReportFacts {
  outcome: AcceptanceOutcome;
  commit: string;
  versions: { node: string; npm: string; pi: string };
  providerId: string;
  writerModelId: string;
  reviewerModelId: string;
  taskId: string;
  startedAt: string;
  finishedAt: string;
  workspace: TaskWorkspace | null;
  restartCount: number;
  publicErrorCodes: readonly string[];
  secretFindingCount: number;
}

/**
 * Builds the exact sanitized report field set from public workspace facts.
 * Artifact contents collapse to SHA-256 hashes; prompts, raw messages, node
 * bodies, headers and environment values never enter the shape.
 */
export function buildSanitizedReport(facts: AcceptanceReportFacts): Record<string, unknown> {
  const workspace = facts.workspace;
  const nodes = workspace?.nodes ?? [];
  const resultNodes = nodes.filter((node) => node.kind === 'result');
  const resultIds = resultNodes.map((node) => node.id);
  // A failed input with no matching result still consumed runtime invocations.
  const orphanedFailedInputs = nodes.filter(
    (node) =>
      node.kind === 'input' &&
      node.status === 'failed' &&
      resultIds.every((id) => !id.startsWith(`${node.id}-t`)),
  );
  const agentCallCount = resultNodes.length;
  const attemptCount =
    resultNodes.reduce((sum, node) => sum + node.attemptCount, 0) +
    orphanedFailedInputs.reduce((sum, node) => sum + node.attemptCount, 0);

  const executedRouteKinds: Record<RouteKind, number> = { artifact: 0, message: 0 };
  for (const route of workspace?.executedRoutes ?? []) {
    executedRouteKinds[route.kind] += 1;
  }

  const artifacts = [...(workspace?.artifacts ?? [])].sort((a, b) => a.version - b.version);
  const artifactVersions = artifacts.map((artifact) => ({
    version: artifact.version,
    contentHash: sha256Hex(artifact.files[0]?.content ?? ''),
    final: artifact.final,
  }));
  const finalArtifact = artifacts.find((artifact) => artifact.final) ?? null;

  return {
    schemaVersion: ACCEPTANCE_REPORT_SCHEMA_VERSION,
    outcome: facts.outcome,
    commit: facts.commit,
    versions: { ...facts.versions },
    providerId: facts.providerId,
    writerModelId: facts.writerModelId,
    reviewerModelId: facts.reviewerModelId,
    taskId: facts.taskId.slice(0, TASK_ID_PREFIX_LENGTH),
    startedAt: facts.startedAt,
    finishedAt: facts.finishedAt,
    taskStatus: workspace?.task.status ?? 'unknown',
    agentCallCount,
    attemptCount,
    executedRouteKinds,
    artifactVersions,
    finalArtifactVersion: finalArtifact === null ? null : finalArtifact.version,
    finalArtifactHash: finalArtifact === null ? null : sha256Hex(finalArtifact.files[0]?.content ?? ''),
    restartCount: facts.restartCount,
    publicErrorCodes: [...new Set(facts.publicErrorCodes)].sort(),
    secretFindingCount: facts.secretFindingCount,
  };
}

/* -------------------------------------------------------------------------- */
/* CLI entry                                                                    */
/* -------------------------------------------------------------------------- */

export function resolveAgainstRepo(repoRoot: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(repoRoot, path);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((wait) => setTimeout(wait, ms));
}

/**
 * Runs the full acceptance flow and resolves with the exit code instead of
 * calling `process.exit` (tests drive this in-process; the CLI guard below
 * maps the result onto the real exit code).
 */
export async function runAcceptanceCli(
  argv: readonly string[],
  deps: AcceptanceCliDeps = {},
): Promise<AcceptanceCliResult> {
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const preflightFailure = (reason: string): AcceptanceCliResult => {
    log(`acceptance: preflight failed (${reason})`);
    return { exitCode: 2, startedServer: false, reason };
  };

  /* 1. Arguments — the only gate that runs before anything else. */
  const args = parseAcceptanceArgs(argv);
  if (args === null) {
    usage();
    return preflightFailure('ARGS_INVALID');
  }

  /* 2. Repo root, input JSON and committed template source. */
  const repoRoot = deps.repoRoot ?? RUNNER_REPO_ROOT;
  const inputPath = resolveAgainstRepo(repoRoot, args.input);
  const reportPath = resolveAgainstRepo(repoRoot, args.report);
  const dataRoot = resolveAgainstRepo(repoRoot, args.dataRoot);
  const committedTemplateDir = join(repoRoot, 'templates', ACCEPTANCE_TEMPLATE_ID);

  let taskInput: Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(inputPath, 'utf8'));
    if (!isStringRecord(parsed)) {
      throw new Error('input must be a non-empty JSON object of string values');
    }
    taskInput = parsed;
  } catch {
    return preflightFailure('INPUT_INVALID');
  }
  if (!isDirectory(committedTemplateDir)) {
    return preflightFailure('TEMPLATE_SOURCE_MISSING');
  }

  /* 3. Fresh empty data root and fresh report path. */
  if (existsSync(dataRoot)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dataRoot);
    } catch {
      return preflightFailure('DATA_ROOT_NOT_FRESH');
    }
    if (entries.length > 0) {
      return preflightFailure('DATA_ROOT_NOT_FRESH');
    }
  } else {
    try {
      mkdirSync(dataRoot, { recursive: true });
    } catch {
      return preflightFailure('DATA_ROOT_NOT_FRESH');
    }
  }
  if (existsSync(reportPath)) {
    return preflightFailure('REPORT_EXISTS');
  }

  /* 4. Environment credentials (boolean only) + model resolution. */
  (deps.loadEnv ?? defaultLoadEnv)(repoRoot);
  let modelRuntime: PreflightModelRuntime;
  try {
    modelRuntime = await (deps.createModelRuntime ?? defaultCreateModelRuntime)();
  } catch {
    return preflightFailure('PROVIDER_UNRESOLVABLE');
  }
  if (modelRuntime.getProvider(args.provider) === undefined) {
    return preflightFailure('PROVIDER_UNRESOLVABLE');
  }
  if (
    modelRuntime.getModel(args.provider, args.writerModel) === undefined ||
    modelRuntime.getModel(args.provider, args.reviewerModel) === undefined
  ) {
    return preflightFailure('MODEL_UNRESOLVABLE');
  }
  if (modelRuntime.hasConfiguredAuth(args.provider) !== true) {
    return preflightFailure('CREDENTIAL_NOT_CONFIGURED');
  }

  /* 5. Phase C Pi boundary probe. */
  const probeReportPath = join(
    repoRoot,
    'forge-core-overnight',
    'evidence',
    'sanitized-reports',
    REPORT_FILE_NAME,
  );
  const probeExit = await (deps.runBoundaryProbe ?? defaultRunBoundaryProbe)({
    providerId: args.provider,
    modelId: args.writerModel,
    reportPath: probeReportPath,
    cwd: repoRoot,
  });
  if (probeExit !== 0) {
    return preflightFailure('BOUNDARY_PROBE_FAILED');
  }

  /* 6. The committed templates are the runnable source (placeholder protocol
   * retired): validate the acceptance template once through the generic loader
   * (no Provider call), then serve the committed `templates/` directory as the
   * read-only server template root. */
  try {
    await loadTemplateDirectory(committedTemplateDir);
  } catch {
    return preflightFailure('TEMPLATE_SOURCE_INVALID');
  }
  const templateRoot = join(repoRoot, 'templates');

  /* ==== Server phase: from here on startedServer is true. ==== */
  log(SERVER_START_MARKER);
  const startedAt = new Date().toISOString();
  let server: AcceptanceServerHandle | null = null;
  let workspace: TaskWorkspace | null = null;
  let outcome: AcceptanceOutcome = 'server_failed';
  const publicErrorCodes = new Set<string>();
  let taskId = '';
  try {
    const port = await (deps.reservePort ?? reserveLoopbackPort)();
    server = await (deps.spawnServer ?? defaultSpawnServer)({
      port,
      dataRoot,
      templateRoot,
    });
    await waitForHttp(`${server.url}/api/health`, HEALTH_WAIT_MS);
    await httpJson('POST', `${server.url}/api/templates/${ACCEPTANCE_TEMPLATE_ID}/reload`, null, publicErrorCodes);
    const created = (await httpJson(
      'POST',
      `${server.url}/api/tasks`,
      { templateId: ACCEPTANCE_TEMPLATE_ID, name: ACCEPTANCE_TASK_NAME, input: taskInput },
      publicErrorCodes,
    )) as { id?: unknown };
    if (typeof created.id !== 'string' || created.id.length === 0) {
      publicErrorCodes.add('TASK_CREATE_RESPONSE_INVALID');
      throw new AcceptanceHttpError('TASK_CREATE_RESPONSE_INVALID', 200);
    }
    taskId = created.id;
    await httpJson(
      'POST',
      `${server.url}/api/tasks/${encodeURIComponent(taskId)}/start`,
      null,
      publicErrorCodes,
    );

    const deadline = Date.now() + (deps.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    for (;;) {
      workspace = (await httpJson(
        'GET',
        `${server.url}/api/tasks/${encodeURIComponent(taskId)}/workspace`,
        null,
        publicErrorCodes,
      )) as TaskWorkspace;
      if (TERMINAL_TASK_STATUSES.has(workspace.task.status)) {
        break;
      }
      if (Date.now() >= deadline) {
        outcome = 'deadline_exceeded';
        break;
      }
      await sleep(pollIntervalMs);
    }
    if (outcome !== 'deadline_exceeded') {
      outcome = workspace.task.status === 'completed' ? 'completed' : 'task_failed';
    }
  } catch (error) {
    if (error instanceof AcceptanceHttpError) {
      publicErrorCodes.add(error.code);
    }
    if (outcome !== 'deadline_exceeded') {
      outcome = 'server_failed';
    }
  } finally {
    if (server !== null) {
      await server.stop().catch(() => undefined);
    }
    log('acceptance: server stopped');
  }
  const finishedAt = new Date().toISOString();

  /* Secret scan over the acceptance data root, then the atomic report. */
  const dataFindings = await scanForAcceptanceSecrets([dataRoot]);
  const facts: AcceptanceReportFacts = {
    outcome,
    commit: gitCommit(repoRoot),
    versions: collectVersions(repoRoot),
    providerId: args.provider,
    writerModelId: args.writerModel,
    reviewerModelId: args.reviewerModel,
    taskId: taskId === '' ? 'no-task' : taskId,
    startedAt,
    finishedAt,
    workspace,
    restartCount: 0,
    publicErrorCodes: [...publicErrorCodes],
    secretFindingCount: dataFindings.length,
  };
  const report = sanitizeAcceptanceReport(buildSanitizedReport(facts));
  await writeNewAtomic(reportPath, Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8'));
  log(`acceptance: sanitized report written (findings=${dataFindings.length})`);

  // Belt and braces: the written report itself must stay clean.
  const reportFindings = await scanForAcceptanceSecrets([reportPath]);
  const clean = outcome === 'completed' && dataFindings.length === 0 && reportFindings.length === 0;
  return {
    exitCode: clean ? 0 : 1,
    startedServer: true,
    reportPath,
    reason: clean ? undefined : outcome.toUpperCase(),
  };
}

/* -------------------------------------------------------------------------- */
/* CLI guard                                                                    */
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
  runAcceptanceCli(process.argv.slice(2))
    .then((result) => {
      process.exit(result.exitCode);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `acceptance: crashed (${error instanceof Error ? error.name : 'unknown error'})\n`,
      );
      process.exit(1);
    });
}
