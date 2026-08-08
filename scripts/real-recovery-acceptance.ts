/**
 * Sanitized real recovery acceptance runner (plan Phase D Task 4).
 *
 * Drives ONE authentic interrupted-then-resumed production loop through the
 * public HTTP surface of a real Forge Core server running the constrained Pi
 * runtime, and writes ONE atomic sanitized JSON report:
 *
 *   preflight (identical order to Phase D Task 2) ->
 *   server A: reload -> create -> start -> the runner's acceptance hook pauses
 *             the loop at the FIRST confirmed artifact boundary (strictly
 *             before the next Agent is scheduled) -> screenshots ->
 *             graceful termination (SIGTERM, exit 0)          [restartCount 1]
 *   server B: same roots -> startup recovery marks the task `interrupted` ->
 *             public resume -> boundary at the reviewer return -> screenshots
 *             -> release-all -> completed -> screenshots -> reconciliation ->
 *             secret scan -> atomic report.
 *
 * Three-view reconciliation compares the committed event/artifact FILES, the
 * HTTP `TaskWorkspace` projection and (through the screenshot session) the
 * rendered DOM counts for every node, route and artifact; artifact content
 * SHA-256, version and source node must agree everywhere. ANY mismatch fails
 * the acceptance.
 *
 * The acceptance hook lives in the process harness only (environment switch
 * `FORGE_CORE_ACCEPTANCE_SIGNAL_DIR`, wired in `main.ts`); it never becomes
 * part of the production API/UI. Provider authentication comes from the
 * environment — never from CLI arguments, files or the report.
 *
 * Exit codes: 0 = completed, restartCount 1, interrupted observed, zero
 * reconciliation mismatches and zero secret findings; 1 = a failure after the
 * server phase started; 2 = preflight failure (no server constructed).
 *
 * Usage:
 *   npm run acceptance:recovery -- --provider <providerId> \
 *     --writer-model <modelId> --reviewer-model <modelId> \
 *     --input <input.json> --data-root <freshDir> --report <report.json>
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNewAtomic } from '../src/server/storage/atomic-file';
import { CorePaths } from '../src/server/storage/core-paths';
import { BOUNDARY_SHUTDOWN_FILE_NAME } from '../src/server/acceptance-boundary';
import type { RouteKind, TaskWorkspace } from '../src/shared/contracts';
import {
  ACCEPTANCE_TEMPLATE_ID,
  AcceptanceHttpError,
  collectVersions,
  defaultCreateModelRuntime,
  defaultLoadEnv,
  defaultRunBoundaryProbe,
  gitCommit,
  httpJson,
  isDirectory,
  isStringRecord,
  killProcessTree,
  parseAcceptanceArgs,
  reserveLoopbackPort,
  resolveAgainstRepo,
  sleep,
  tsxBinary,
  waitForExit,
  waitForHttp,
  type BoundaryProbeRequest,
  type PreflightModelRuntime,
} from './real-acceptance';
import { sanitizeAcceptanceReport, scanForAcceptanceSecrets } from './scan-acceptance-secrets';

/** Emitted exactly when the server phase begins; tests assert ordering. */
export const RECOVERY_SERVER_START_MARKER = 'recovery-acceptance: starting server';

export const RECOVERY_REPORT_SCHEMA_VERSION = 'forge-core.real-recovery-acceptance/1';

/** The exact sanitized recovery report field set (plan Task 4). */
export const RECOVERY_REPORT_KEYS = [
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
  'interruptedObserved',
  'boundaryStops',
  'reconciliation',
  'screenshots',
  'publicErrorCodes',
  'secretFindingCount',
  'hiddenThinkingFindingCount',
] as const;

export type RecoveryOutcome = 'completed' | 'task_failed' | 'deadline_exceeded' | 'server_failed';

const RECOVERY_TASK_NAME = '真实提供方恢复验收任务';
const TASK_ID_PREFIX_LENGTH = 8;
const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const HEALTH_WAIT_MS = 30_000;
const BOUNDARY_POLL_MS = 250;
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
/* Child-process lifecycle (shared by the fake harness and the real run)       */
/* -------------------------------------------------------------------------- */

export interface RecoverySpawnOptions {
  port: number;
  dataRoot: string;
  templateRoot: string;
  /** Acceptance boundary signal directory (hook reads/writes here). */
  signalDir: string;
  /** Runtime selection for the spawned server (real runs use `pi`). */
  runtime: 'pi' | 'fake';
  /** Scripted behaviors for `runtime: 'fake'` (child-process lifecycle). */
  fakeScriptsFile?: string;
  /** Server mode; defaults to development (UI serving for screenshots). */
  mode?: 'development' | 'test';
  /** Bind the HttpGateway client (VITE_FORGE_CORE_MODE=http); default on in development. */
  uiGateway?: boolean;
}

export interface RecoveryServerHandle {
  url: string;
  child: ChildProcess;
  /** Signals the whole process group and waits for exit (escalates once). */
  stop(signal?: NodeJS.Signals): Promise<void>;
  waitForExit(timeoutMs?: number): Promise<void>;
  exitInfo(): { code: number | null; signal: NodeJS.Signals | null };
  tailOutput(lines?: number): string;
}

/**
 * Production recovery server spawn: `tsx src/server/main.ts` as a detached
 * process group over the acceptance roots with the boundary hook enabled
 * through `FORGE_CORE_ACCEPTANCE_SIGNAL_DIR`. Provider auth is inherited
 * from the environment — never passed as an argument.
 */
export async function spawnRecoveryServer(
  options: RecoverySpawnOptions,
): Promise<RecoveryServerHandle> {
  const mode = options.mode ?? 'development';
  const withGateway = options.uiGateway ?? mode === 'development';
  mkdirSync(options.signalDir, { recursive: true });
  const child = spawn(process.execPath, [tsxBinary(), 'src/server/main.ts'], {
    cwd: WORKSPACE_ROOT,
    detached: true,
    env: {
      ...process.env,
      FORGE_CORE_DATA_ROOT: options.dataRoot,
      FORGE_CORE_TEMPLATE_ROOT: options.templateRoot,
      FORGE_CORE_PORT: String(options.port),
      FORGE_CORE_MODE: mode,
      FORGE_CORE_RUNTIME: options.runtime,
      FORGE_CORE_ACCEPTANCE_SIGNAL_DIR: options.signalDir,
      ...(options.fakeScriptsFile !== undefined
        ? { FORGE_CORE_FAKE_SCRIPTS: options.fakeScriptsFile }
        : {}),
      ...(withGateway ? { VITE_FORGE_CORE_MODE: 'http' } : {}),
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
    const tail = output.split('\n').slice(-6).join('\n');
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; last server output:\n${tail}`,
    );
  }

  return {
    url,
    child,
    async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
      if (signal === 'SIGTERM') {
        // Graceful shutdown through the signal directory (cross-platform):
        // POSIX signals never reach detached child handlers on Windows, so
        // the server polls for this file in acceptance mode (main.ts).
        try {
          writeFileSync(
            join(options.signalDir, BOUNDARY_SHUTDOWN_FILE_NAME),
            'shutdown\n',
            'utf8',
          );
        } catch {
          // Fall through to the signal path below.
        }
        const exitedCleanly = await waitForExit(child, 30_000).then(
          () => true,
          () => false,
        );
        if (exitedCleanly) {
          return;
        }
      }
      killProcessTree(child, signal);
      await waitForExit(child, 30_000).catch(() => {
        killProcessTree(child, 'SIGKILL');
        return waitForExit(child, 15_000);
      });
    },
    waitForExit(timeoutMs = 30_000): Promise<void> {
      return waitForExit(child, timeoutMs);
    },
    exitInfo(): { code: number | null; signal: NodeJS.Signals | null } {
      return { code: child.exitCode, signal: child.signalCode };
    },
    tailOutput(lines = 6): string {
      return output.split('\n').slice(-lines).join('\n');
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Boundary signal-directory protocol                                          */
/* -------------------------------------------------------------------------- */

/** One boundary record published by the server-side acceptance hook. */
export interface BoundaryRecord {
  taskId: string;
  index: number;
  artifacts: number;
  messageRoutes: number;
  at: string;
}

const BOUNDARY_FILE_NAME = 'boundary.json';
const RELEASE_FILE_NAME = 'release';

/** Reads the current boundary record, or null when none is published. */
export function readBoundary(signalDir: string): BoundaryRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(signalDir, BOUNDARY_FILE_NAME), 'utf8')) as Record<
      string,
      unknown
    >;
    if (typeof parsed.taskId !== 'string' || typeof parsed.index !== 'number') {
      return null;
    }
    return {
      taskId: parsed.taskId,
      index: parsed.index,
      artifacts: typeof parsed.artifacts === 'number' ? parsed.artifacts : 0,
      messageRoutes: typeof parsed.messageRoutes === 'number' ? parsed.messageRoutes : 0,
      at: typeof parsed.at === 'string' ? parsed.at : '',
    };
  } catch {
    return null;
  }
}

/** Waits until a boundary record satisfying `predicate` is published. */
export async function waitForBoundary(
  signalDir: string,
  predicate: (record: BoundaryRecord) => boolean,
  timeoutMs: number,
  pollMs: number = BOUNDARY_POLL_MS,
): Promise<BoundaryRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = readBoundary(signalDir);
    if (record !== null && predicate(record)) {
      return record;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `recovery-acceptance: no qualifying boundary appeared within ${timeoutMs} ms`,
      );
    }
    await sleep(pollMs);
  }
}

/** Releases the hook: `once` resumes one boundary, `all` every future one. */
export function releaseBoundary(signalDir: string, mode: 'once' | 'all'): void {
  mkdirSync(signalDir, { recursive: true });
  writeFileSync(join(signalDir, RELEASE_FILE_NAME), mode, 'utf8');
}

/* -------------------------------------------------------------------------- */
/* File-side projection + three-view reconciliation                            */
/* -------------------------------------------------------------------------- */

export interface RecoveryFileEventEntry {
  sequence: number;
  fileName: string;
  event: Record<string, unknown> & { id: string; type: string; at: string };
}

export interface RecoveryFileArtifactEntry {
  version: number;
  id: string;
  title: string;
  format: 'markdown' | 'text';
  sourceNodeId: string;
  contentHash: string;
  content: string;
}

export interface RecoveryFileProjection {
  events: RecoveryFileEventEntry[];
  artifacts: RecoveryFileArtifactEntry[];
}

const EVENT_FILE_NAME = /^(\d{6})-([A-Za-z0-9][A-Za-z0-9._-]*)\.json$/;

const NODE_EVENT_TYPES = new Set([
  'agent_input',
  'agent_result',
  'human_requested',
  'human_answered',
]);

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Reads one task's committed event/artifact files directly from the roots. */
export function readRecoveryFileProjection(
  dataRoot: string,
  templateRoot: string,
  taskId: string,
): RecoveryFileProjection {
  const paths = CorePaths.create({ dataRoot, templateRoot });
  const eventsRoot = paths.taskEventsRoot(taskId);
  const events: RecoveryFileEventEntry[] = readdirSync(eventsRoot)
    .map((fileName) => {
      const match = EVENT_FILE_NAME.exec(fileName);
      if (match === null) return null;
      const raw = readFileSync(join(eventsRoot, fileName), 'utf8');
      const event = JSON.parse(raw) as RecoveryFileEventEntry['event'];
      return { sequence: Number(match[1]), fileName, event };
    })
    .filter((entry): entry is RecoveryFileEventEntry => entry !== null)
    .sort((a, b) => a.sequence - b.sequence);

  const artifactsRoot = paths.taskArtifactsRoot(taskId);
  const artifacts: RecoveryFileArtifactEntry[] = readdirSync(artifactsRoot)
    .filter((name) => /^v\d{3}$/.test(name))
    .map((name) => {
      // v7 meta.json carries no file hashes (they live on the events); the
      // entry's contentHash is filled from the matching artifact_published
      // event during reconciliation.
      const meta = JSON.parse(readFileSync(join(artifactsRoot, name, 'meta.json'), 'utf8')) as {
        id: string;
        version: number;
        title: string;
        format: 'markdown' | 'text';
        sourceNodeId: string;
      };
      const contentFile = meta.format === 'markdown' ? 'content.md' : 'content.txt';
      const content = readFileSync(join(artifactsRoot, name, contentFile), 'utf8');
      return { ...meta, contentHash: '', content };
    })
    .sort((a, b) => a.version - b.version);

  return { events, artifacts };
}

/** DOM counts the screenshot session observes on the completed production page. */
export interface RecoveryDomCounts {
  nodes: number;
  artifactArrows: number;
  messageArrows: number;
  versionItems: number;
}

export interface RecoveryReconciliation {
  mismatchCount: number;
  eventCount: number;
  nodeCount: number;
  routeCount: number;
  artifactCount: number;
  domNodeCount: number | null;
  domArtifactArrows: number | null;
  domMessageArrows: number | null;
  domVersionItems: number | null;
}

/**
 * Reconciles the committed FILES, the HTTP workspace projection and (when
 * supplied) the rendered DOM counts: node identities, route identities,
 * artifact SHA-256/version/source-node and event-stream integrity must agree
 * across every view. Returns the mismatch count plus public counts; the
 * runner logs each mismatch detail and the report keeps counts only.
 */
export async function reconcileRecoveryViews(
  dataRoot: string,
  templateRoot: string,
  baseUrl: string,
  taskId: string,
  dom: RecoveryDomCounts | null,
  log: (line: string) => void = () => undefined,
): Promise<RecoveryReconciliation> {
  const projection = readRecoveryFileProjection(dataRoot, templateRoot, taskId);
  const response = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/workspace`);
  if (!response.ok) {
    throw new Error(`recovery-acceptance: workspace request failed with ${response.status}`);
  }
  const workspace = (await response.json()) as TaskWorkspace;
  const mismatch: string[] = [];

  // Event stream integrity: contiguous 1..N sequences, unique ids.
  const ids = new Set<string>();
  projection.events.forEach((entry, index) => {
    if (entry.sequence !== index + 1) {
      mismatch.push(`event sequence gap at position ${index + 1} (saw ${entry.sequence})`);
    }
    if (ids.has(entry.event.id)) {
      mismatch.push(`duplicate event id ${entry.event.id}`);
    }
    ids.add(entry.event.id);
  });

  // Nodes: identical identities and public fields on both sides.
  const fileNodeIds = projection.events
    .filter((entry) => NODE_EVENT_TYPES.has(entry.event.type))
    .map((entry) => entry.event.id)
    .sort();
  const workspaceNodeIds = workspace.nodes.map((node) => node.id).sort();
  if (JSON.stringify(fileNodeIds) !== JSON.stringify(workspaceNodeIds)) {
    mismatch.push(
      `node ids disagree (files=${fileNodeIds.length}, workspace=${workspaceNodeIds.length})`,
    );
  }
  for (const entry of projection.events) {
    if (!NODE_EVENT_TYPES.has(entry.event.type)) continue;
    const fileNode = (entry.event as unknown as { node: Record<string, unknown> }).node;
    const workspaceNode = workspace.nodes.find((node) => node.id === entry.event.id);
    if (workspaceNode === undefined) continue; // Counted above.
    if (
      workspaceNode.agentId !== fileNode.agentId ||
      workspaceNode.kind !== fileNode.kind ||
      workspaceNode.status !== fileNode.status ||
      workspaceNode.attemptCount !== fileNode.attemptCount ||
      workspaceNode.inputVersion !== (fileNode.inputVersion ?? null)
    ) {
      mismatch.push(`node fields disagree for ${entry.event.id}`);
    }
  }

  // Routes: same ids, kinds, endpoints and order on both sides.
  const fileRoutes = projection.events
    .filter((entry) => entry.event.type === 'route_executed')
    .map((entry) => {
      const route = (entry.event as unknown as { route: Record<string, unknown> }).route;
      return {
        id: entry.event.id,
        kind: String(route.kind),
        fromNodeId: String(route.fromNodeId),
        toNodeId: String(route.toNodeId),
        sequence: Number(route.sequence),
      };
    });
  const workspaceRoutes = workspace.executedRoutes.map((route) => ({
    id: route.id,
    kind: route.kind,
    fromNodeId: route.fromNodeId,
    toNodeId: route.toNodeId,
    sequence: route.sequence,
  }));
  if (JSON.stringify(fileRoutes) !== JSON.stringify(workspaceRoutes)) {
    mismatch.push(
      `routes disagree (files=${fileRoutes.length}, workspace=${workspaceRoutes.length})`,
    );
  }

  // Artifacts: version/title/sourceNode and content SHA-256 agree across the
  // file content, the published event and the projection. v7 carries hashes
  // on the event (the disk meta has none), so the event is the authority.
  const publishedByEvent = new Map<number, string>();
  for (const entry of projection.events) {
    if (entry.event.type !== 'artifact_published') continue;
    const artifact = (entry.event as unknown as { artifact: Record<string, unknown> }).artifact;
    const files = Array.isArray(artifact.files) ? (artifact.files as Array<{ hash?: unknown }>) : [];
    const hash = files.length > 0 ? String(files[0]?.hash ?? '') : String(artifact.contentHash ?? '');
    publishedByEvent.set(Number(artifact.version), hash);
  }
  if (projection.artifacts.length !== workspace.artifacts.length) {
    mismatch.push(
      `artifact counts disagree (files=${projection.artifacts.length}, workspace=${workspace.artifacts.length})`,
    );
  }
  for (const [index, fileArtifact] of projection.artifacts.entries()) {
    const workspaceArtifact = workspace.artifacts[index];
    if (workspaceArtifact === undefined) break;
    if (workspaceArtifact.version !== fileArtifact.version) {
      mismatch.push(`artifact version disagrees at index ${index}`);
    }
    if (workspaceArtifact.title !== fileArtifact.title) {
      mismatch.push(`artifact title disagrees at version ${fileArtifact.version}`);
    }
    if (workspaceArtifact.sourceNodeId !== fileArtifact.sourceNodeId) {
      mismatch.push(`artifact sourceNode disagrees at version ${fileArtifact.version}`);
    }
    const diskHash = sha256Hex(fileArtifact.content);
    const eventHash = publishedByEvent.get(fileArtifact.version);
    if (eventHash === undefined) {
      mismatch.push(`artifact_published event missing for version ${fileArtifact.version}`);
    } else if (diskHash !== eventHash) {
      mismatch.push(`artifact file content hash mismatch at version ${fileArtifact.version}`);
    }
    if (sha256Hex(workspaceArtifact.files[0]?.content ?? '') !== eventHash) {
      mismatch.push(
        `artifact workspace content hash disagrees at version ${fileArtifact.version}`,
      );
    }
  }

  // Finality: exactly one accepted final submission matching the served flag.
  const finals = projection.events.filter(
    (entry) => entry.event.type === 'final_submission_accepted',
  );
  if (finals.length > 1) {
    mismatch.push(`multiple final_submission_accepted events (${finals.length})`);
  }
  const workspaceFinalVersions = workspace.artifacts
    .filter((artifact) => artifact.final)
    .map((artifact) => artifact.version);
  if (finals.length === 1) {
    const finalVersion = Number((finals[0].event as unknown as { version: unknown }).version);
    if (JSON.stringify(workspaceFinalVersions) !== JSON.stringify([finalVersion])) {
      mismatch.push(`final flag disagrees (event version=${finalVersion})`);
    }
  } else if (workspaceFinalVersions.length > 0) {
    mismatch.push('workspace marks a final artifact without a final event');
  }

  // DOM view (when captured): counts match the projection/workspace exactly.
  if (dom !== null) {
    if (dom.nodes !== workspace.nodes.length) {
      mismatch.push(`dom node count disagrees (dom=${dom.nodes}, workspace=${workspace.nodes.length})`);
    }
    const artifactRouteCount = workspace.executedRoutes.filter(
      (route) => route.kind === 'artifact',
    ).length;
    const messageRouteCount = workspace.executedRoutes.filter(
      (route) => route.kind === 'message',
    ).length;
    if (dom.artifactArrows !== artifactRouteCount) {
      mismatch.push(
        `dom artifact arrows disagree (dom=${dom.artifactArrows}, workspace=${artifactRouteCount})`,
      );
    }
    if (dom.messageArrows !== messageRouteCount) {
      mismatch.push(
        `dom message arrows disagree (dom=${dom.messageArrows}, workspace=${messageRouteCount})`,
      );
    }
    if (dom.versionItems !== workspace.artifacts.length) {
      mismatch.push(
        `dom version items disagree (dom=${dom.versionItems}, workspace=${workspace.artifacts.length})`,
      );
    }
  }

  for (const detail of mismatch) {
    log(`recovery-acceptance: reconciliation mismatch — ${detail}`);
  }

  return {
    mismatchCount: mismatch.length,
    eventCount: projection.events.length,
    nodeCount: workspace.nodes.length,
    routeCount: workspace.executedRoutes.length,
    artifactCount: workspace.artifacts.length,
    domNodeCount: dom === null ? null : dom.nodes,
    domArtifactArrows: dom === null ? null : dom.artifactArrows,
    domMessageArrows: dom === null ? null : dom.messageArrows,
    domVersionItems: dom === null ? null : dom.versionItems,
  };
}

/* -------------------------------------------------------------------------- */
/* Screenshot session (Plan Step 4)                                            */
/* -------------------------------------------------------------------------- */

export interface ScreenshotEntry {
  name: string;
  width: number;
  height: number;
}

/**
 * The runner captures required evidence screenshots at the exact states only
 * the recovery flow produces (paused after V1, after the reviewer return,
 * completed). Screenshots render the served UI only — never devtools,
 * environment values or logs.
 */
export interface RecoveryScreenshotSession {
  templateDetail(baseUrl: string): Promise<void>;
  taskList(baseUrl: string): Promise<void>;
  productionAfterV1(baseUrl: string, taskId: string): Promise<void>;
  productionAfterReturn(baseUrl: string, taskId: string): Promise<void>;
  /** Returns DOM counts for the reconciliation (null when unavailable). */
  productionCompleted(baseUrl: string, taskId: string): Promise<RecoveryDomCounts | null>;
  developmentProgress(baseUrl: string): Promise<void>;
  productionCompletedMobile(baseUrl: string, taskId: string): Promise<void>;
  taken(): ScreenshotEntry[];
  close(): Promise<void>;
}

const SCREENSHOT_DESKTOP = { width: 1440, height: 1000 };
const SCREENSHOT_MOBILE = { width: 390, height: 844 };

/** Clears only the documented mock storage namespace (http mode leaves it empty anyway). */
const CLEAR_MOCK_STORAGE = (prefix: string): void => {
  for (const key of Object.keys(window.localStorage)) {
    if (key.startsWith(prefix)) window.localStorage.removeItem(key);
  }
};

/**
 * Default Playwright-backed session over the locally cached chromium. The
 * browser connects to the loopback acceptance server only; nothing outside
 * the served UI is ever captured.
 */
export async function defaultScreenshotSession(
  outputDir: string,
): Promise<RecoveryScreenshotSession> {
  const { chromium } = await import('@playwright/test');
  mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const desktop = await browser.newContext({ viewport: SCREENSHOT_DESKTOP });
  const page = await desktop.newPage();
  const taken: ScreenshotEntry[] = [];
  let cleared = false;

  async function clearMocks(baseUrl: string): Promise<void> {
    if (cleared) return;
    await page.goto(baseUrl);
    await page.evaluate(CLEAR_MOCK_STORAGE, 'forge-core:mock:v1:');
    cleared = true;
  }

  async function capture(name: string, width: number, height: number): Promise<void> {
    await page.screenshot({ path: join(outputDir, name) });
    taken.push({ name, width, height });
  }

  async function gotoTask(baseUrl: string, taskId: string): Promise<void> {
    await clearMocks(baseUrl);
    await page.goto(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`);
    await page.waitForSelector('[data-testid="workspace-canvas"]');
  }

  return {
    async templateDetail(baseUrl: string): Promise<void> {
      await clearMocks(baseUrl);
      await page.goto(`${baseUrl}/templates/${ACCEPTANCE_TEMPLATE_ID}`);
      await page.getByRole('link', { name: '使用此模板创建任务' }).waitFor();
      await capture('template-detail.png', SCREENSHOT_DESKTOP.width, SCREENSHOT_DESKTOP.height);
    },

    async taskList(baseUrl: string): Promise<void> {
      await clearMocks(baseUrl);
      await page.goto(`${baseUrl}/tasks`);
      await page.getByText(RECOVERY_TASK_NAME).first().waitFor();
      await capture('task-list.png', SCREENSHOT_DESKTOP.width, SCREENSHOT_DESKTOP.height);
    },

    async productionAfterV1(baseUrl: string, taskId: string): Promise<void> {
      await gotoTask(baseUrl, taskId);
      await page.locator('.fc-version-item').first().waitFor();
      await page.locator('[data-testid="workspace-node"]').first().waitFor();
      await capture('production-after-v1.png', SCREENSHOT_DESKTOP.width, SCREENSHOT_DESKTOP.height);
    },

    async productionAfterReturn(baseUrl: string, taskId: string): Promise<void> {
      await gotoTask(baseUrl, taskId);
      await page.locator('.fc-flow-path--message').first().waitFor();
      await capture(
        'production-after-review-return.png',
        SCREENSHOT_DESKTOP.width,
        SCREENSHOT_DESKTOP.height,
      );
    },

    async productionCompleted(baseUrl: string, taskId: string): Promise<RecoveryDomCounts | null> {
      await gotoTask(baseUrl, taskId);
      await page.getByText('已完成').first().waitFor();
      // Expand the final version preview in the artifact drawer.
      const finalItem = page.locator('.fc-version-item', { hasText: '终稿' }).last();
      await finalItem.locator('button').click();
      await page.locator('[data-testid="artifact-preview"]').waitFor();
      await capture(
        'production-completed-final-preview.png',
        SCREENSHOT_DESKTOP.width,
        SCREENSHOT_DESKTOP.height,
      );
      const counts = await page.evaluate(() => ({
        nodes: document.querySelectorAll('[data-testid="workspace-node"]').length,
        artifactArrows: document.querySelectorAll('.fc-flow-path--artifact').length,
        messageArrows: document.querySelectorAll('.fc-flow-path--message').length,
        versionItems: document.querySelectorAll('.fc-version-item').length,
      }));
      return counts;
    },

    async developmentProgress(baseUrl: string): Promise<void> {
      await clearMocks(baseUrl);
      await page.goto(`${baseUrl}/dev/progress`);
      await page.waitForLoadState('networkidle');
      await capture('development-progress.png', SCREENSHOT_DESKTOP.width, SCREENSHOT_DESKTOP.height);
    },

    async productionCompletedMobile(baseUrl: string, taskId: string): Promise<void> {
      const mobile = await browser.newContext({ viewport: SCREENSHOT_MOBILE });
      try {
        const mobilePage = await mobile.newPage();
        await mobilePage.goto(baseUrl);
        await mobilePage.evaluate(CLEAR_MOCK_STORAGE, 'forge-core:mock:v1:');
        await mobilePage.goto(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`);
        await mobilePage.waitForSelector('[data-testid="workspace-canvas"]');
        await mobilePage.getByText('已完成').first().waitFor();
        // At narrow widths the artifacts drawer can start collapsed; open it
        // through the formal control a user would use.
        const drawer = mobilePage.getByRole('complementary', { name: '产物版本' });
        if (!(await drawer.isVisible())) {
          await mobilePage.getByRole('button', { name: '产物', exact: true }).click();
          await drawer.waitFor();
        }
        const shotPath = join(outputDir, 'production-completed-mobile.png');
        await mobilePage.screenshot({ path: shotPath });
        taken.push({
          name: 'production-completed-mobile.png',
          width: SCREENSHOT_MOBILE.width,
          height: SCREENSHOT_MOBILE.height,
        });
      } finally {
        await mobile.close();
      }
    },

    taken: () => [...taken],

    async close(): Promise<void> {
      await desktop.close();
      await browser.close();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Sanitized report construction                                               */
/* -------------------------------------------------------------------------- */

export interface RecoveryReportFacts {
  outcome: RecoveryOutcome;
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
  interruptedObserved: boolean;
  boundaryStops: number;
  reconciliation: RecoveryReconciliation | null;
  screenshots: readonly ScreenshotEntry[];
  publicErrorCodes: readonly string[];
  secretFindingCount: number;
  hiddenThinkingFindingCount: number;
}

/** Builds the exact sanitized recovery report field set from public facts. */
export function buildRecoveryReport(facts: RecoveryReportFacts): Record<string, unknown> {
  const workspace = facts.workspace;
  const nodes = workspace?.nodes ?? [];
  const resultNodes = nodes.filter((node) => node.kind === 'result');
  const resultIds = resultNodes.map((node) => node.id);
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
    contentHash: sha256Hex(artifact.files[0].content),
    final: artifact.final,
  }));
  const finalArtifact = artifacts.find((artifact) => artifact.final) ?? null;

  const reconciliation = facts.reconciliation;
  return {
    schemaVersion: RECOVERY_REPORT_SCHEMA_VERSION,
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
    interruptedObserved: facts.interruptedObserved,
    boundaryStops: facts.boundaryStops,
    reconciliation:
      reconciliation === null
        ? null
        : {
            mismatchCount: reconciliation.mismatchCount,
            eventCount: reconciliation.eventCount,
            nodeCount: reconciliation.nodeCount,
            routeCount: reconciliation.routeCount,
            artifactCount: reconciliation.artifactCount,
            domNodeCount: reconciliation.domNodeCount,
            domArtifactArrows: reconciliation.domArtifactArrows,
            domMessageArrows: reconciliation.domMessageArrows,
            domVersionItems: reconciliation.domVersionItems,
          },
    screenshots: facts.screenshots.map((entry) => ({ ...entry })),
    publicErrorCodes: [...new Set(facts.publicErrorCodes)].sort(),
    secretFindingCount: facts.secretFindingCount,
    hiddenThinkingFindingCount: facts.hiddenThinkingFindingCount,
  };
}

/* -------------------------------------------------------------------------- */
/* CLI entry                                                                   */
/* -------------------------------------------------------------------------- */

export interface RecoveryCliDeps {
  repoRoot?: string;
  loadEnv?: (repoRoot: string) => void;
  createModelRuntime?: () => Promise<PreflightModelRuntime>;
  runBoundaryProbe?: (request: BoundaryProbeRequest) => Promise<number>;
  reservePort?: () => Promise<number>;
  spawnServer?: (options: RecoverySpawnOptions) => Promise<RecoveryServerHandle>;
  deadlineMs?: number;
  pollIntervalMs?: number;
  createScreenshotSession?: (outputDir: string) => Promise<RecoveryScreenshotSession>;
  log?: (line: string) => void;
}

export interface RecoveryCliResult {
  exitCode: number;
  startedServer: boolean;
  reason?: string;
  reportPath?: string;
}

/**
 * Runs the full recovery acceptance flow and resolves with the exit code
 * instead of calling `process.exit` (tests drive this in-process; the CLI
 * guard below maps the result onto the real exit code).
 */
export async function runRecoveryAcceptanceCli(
  argv: readonly string[],
  deps: RecoveryCliDeps = {},
): Promise<RecoveryCliResult> {
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const preflightFailure = (reason: string): RecoveryCliResult => {
    log(`recovery-acceptance: preflight failed (${reason})`);
    return { exitCode: 2, startedServer: false, reason };
  };

  /* 1. Arguments — identical strict shape to Phase D Task 2. */
  const args = parseAcceptanceArgs(argv);
  if (args === null) {
    process.stderr.write(
      'usage: real-recovery-acceptance --provider <providerId> --writer-model <modelId> ' +
        '--reviewer-model <modelId> --input <input.json> --data-root <freshDir> ' +
        '--report <report.json>\n' +
        'note: provider authentication comes from the environment only; ' +
        'API Keys are never accepted as CLI arguments.\n',
    );
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

  /* 5. Phase C Pi boundary probe (fresh over the same provider/model pair). */
  const probeReportPath = join(
    repoRoot,
    'forge-core-overnight',
    'evidence',
    'sanitized-reports',
    'pi-boundary.json',
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
   * retired): serve the committed `templates/` directory read-only as the
   * server template root. */
  const templateRoot = join(repoRoot, 'templates');

  /* ==== Server phase: from here on startedServer is true. ==== */
  log(RECOVERY_SERVER_START_MARKER);
  const startedAt = new Date().toISOString();
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const reservePort = deps.reservePort ?? reserveLoopbackPort;
  const spawnServer = deps.spawnServer ?? ((options) => spawnRecoveryServer(options));
  const screenshotOutputDir = join(
    repoRoot,
    'forge-core-overnight',
    'evidence',
    'screenshots',
  );
  const screenshots: RecoveryScreenshotSession = await (
    deps.createScreenshotSession ?? defaultScreenshotSession
  )(screenshotOutputDir);

  let server: RecoveryServerHandle | null = null;
  let workspace: TaskWorkspace | null = null;
  let outcome: RecoveryOutcome = 'server_failed';
  const publicErrorCodes = new Set<string>();
  let taskId = '';
  let restartCount = 0;
  let interruptedObserved = false;
  let boundaryStops = 0;
  let reconciliation: RecoveryReconciliation | null = null;
  let domCounts: RecoveryDomCounts | null = null;
  try {
    const port = await reservePort();

    /* ---- Phase A: first confirmed artifact boundary, graceful stop. ---- */
    const signalDirA = mkdtempSync(join(tmpdir(), 'forge-core-recovery-signal-a-'));
    server = await spawnServer({
      port,
      dataRoot,
      templateRoot,
      signalDir: signalDirA,
      runtime: 'pi',
    });
    await httpJson(
      'POST',
      `${server.url}/api/templates/${ACCEPTANCE_TEMPLATE_ID}/reload`,
      null,
      publicErrorCodes,
    );
    const created = (await httpJson(
      'POST',
      `${server.url}/api/tasks`,
      { templateId: ACCEPTANCE_TEMPLATE_ID, name: RECOVERY_TASK_NAME, input: taskInput },
      publicErrorCodes,
    )) as { id?: unknown };
    if (typeof created.id !== 'string' || created.id.length === 0) {
      publicErrorCodes.add('TASK_CREATE_RESPONSE_INVALID');
      throw new AcceptanceHttpError('TASK_CREATE_RESPONSE_INVALID', 200);
    }
    taskId = created.id;
    await screenshots.templateDetail(server.url).catch((error: unknown) => {
      log(`recovery-acceptance: template screenshot skipped (${String(error)})`);
    });
    await screenshots.taskList(server.url).catch((error: unknown) => {
      log(`recovery-acceptance: task-list screenshot skipped (${String(error)})`);
    });
    await httpJson(
      'POST',
      `${server.url}/api/tasks/${encodeURIComponent(taskId)}/start`,
      null,
      publicErrorCodes,
    );

    // The acceptance hook pauses the loop at the first confirmed artifact,
    // strictly before the next Agent is scheduled.
    await waitForBoundary(signalDirA, (record) => record.artifacts >= 1, deadlineMs);
    boundaryStops += 1;
    await screenshots.productionAfterV1(server.url, taskId).catch((error: unknown) => {
      log(`recovery-acceptance: after-V1 screenshot skipped (${String(error)})`);
    });

    // Graceful termination through the runner's hook boundary: the server
    // shuts down cleanly (exit 0) with the confirmed boundary intact.
    await server.stop('SIGTERM');
    const exitA = server.exitInfo();
    if (exitA.code !== 0) {
      publicErrorCodes.add('PHASE_A_EXIT_NOT_CLEAN');
      throw new Error(
        `recovery-acceptance: the interrupted server exited with ${exitA.code}/${exitA.signal}\n${server.tailOutput()}`,
      );
    }
    restartCount += 1;
    server = null;

    /* ---- Phase B: restart on the same roots, resume, complete. ---- */
    const signalDirB = mkdtempSync(join(tmpdir(), 'forge-core-recovery-signal-b-'));
    server = await spawnServer({
      port,
      dataRoot,
      templateRoot,
      signalDir: signalDirB,
      runtime: 'pi',
    });
    const interruptedWorkspace = (await httpJson(
      'GET',
      `${server.url}/api/tasks/${encodeURIComponent(taskId)}/workspace`,
      null,
      publicErrorCodes,
    )) as TaskWorkspace;
    interruptedObserved = interruptedWorkspace.task.status === 'interrupted';
    if (!interruptedObserved) {
      publicErrorCodes.add('NOT_INTERRUPTED_AFTER_RESTART');
    }
    await httpJson(
      'POST',
      `${server.url}/api/tasks/${encodeURIComponent(taskId)}/resume`,
      null,
      publicErrorCodes,
    );

    // Wait for the reviewer return boundary (the first boundary after the
    // resume) while watching for an early terminal state; then screenshot the
    // returned state and release the loop for the rest of the run.
    const boundaryDeadline = Date.now() + deadlineMs;
    let sawReturnBoundary = false;
    for (;;) {
      const record = readBoundary(signalDirB);
      if (record !== null && record.messageRoutes >= 1) {
        sawReturnBoundary = true;
        boundaryStops += 1;
        break;
      }
      const current = (await httpJson(
        'GET',
        `${server.url}/api/tasks/${encodeURIComponent(taskId)}/workspace`,
        null,
        publicErrorCodes,
      )) as TaskWorkspace;
      if (TERMINAL_TASK_STATUSES.has(current.task.status)) {
        break; // Settled before any return boundary could be observed.
      }
      if (Date.now() > boundaryDeadline) {
        outcome = 'deadline_exceeded';
        break;
      }
      await sleep(Math.min(pollIntervalMs, 1000));
    }
    if (outcome !== 'deadline_exceeded') {
      if (sawReturnBoundary) {
        await screenshots.productionAfterReturn(server.url, taskId).catch((error: unknown) => {
          log(`recovery-acceptance: after-return screenshot skipped (${String(error)})`);
        });
      } else {
        log('recovery-acceptance: no reviewer-return boundary observed before settling');
      }
      releaseBoundary(signalDirB, 'all');

      // Poll to the terminal state.
      const terminalDeadline = Date.now() + deadlineMs;
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
        if (Date.now() > terminalDeadline) {
          outcome = 'deadline_exceeded';
          break;
        }
        await sleep(pollIntervalMs);
      }
      if (outcome !== 'deadline_exceeded') {
        outcome = workspace.task.status === 'completed' ? 'completed' : 'task_failed';
      }

      if (workspace !== null && workspace.task.status === 'completed') {
        domCounts = await screenshots.productionCompleted(server.url, taskId).catch(
          (error: unknown) => {
            log(`recovery-acceptance: completed screenshot skipped (${String(error)})`);
            return null;
          },
        );
        await screenshots.developmentProgress(server.url).catch((error: unknown) => {
          log(`recovery-acceptance: progress screenshot skipped (${String(error)})`);
        });
        await screenshots.productionCompletedMobile(server.url, taskId).catch(
          (error: unknown) => {
            log(`recovery-acceptance: mobile screenshot skipped (${String(error)})`);
          },
        );
        // Three-view reconciliation while the restarted server still serves.
        reconciliation = await reconcileRecoveryViews(
          dataRoot,
          templateRoot,
          server.url,
          taskId,
          domCounts,
          log,
        );
      }
    }
  } catch (error) {
    if (error instanceof AcceptanceHttpError) {
      publicErrorCodes.add(error.code);
    }
    log(
      `recovery-acceptance: server phase failed (${error instanceof Error ? error.message : String(error)})`,
    );
    if (outcome !== 'deadline_exceeded') {
      outcome = 'server_failed';
    }
  } finally {
    if (server !== null) {
      await server.stop().catch(() => undefined);
    }
    await screenshots.close().catch(() => undefined);
    log('recovery-acceptance: server stopped');
  }
  const finishedAt = new Date().toISOString();

  /* Secret scan over the acceptance data root, then the atomic report. */
  const dataFindings = await scanForAcceptanceSecrets([dataRoot]);
  const hiddenThinkingFindingCount = dataFindings.filter(
    (finding) => finding.category === 'hidden_thinking_key',
  ).length;
  const facts: RecoveryReportFacts = {
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
    restartCount,
    interruptedObserved,
    boundaryStops,
    reconciliation,
    screenshots: screenshots.taken(),
    publicErrorCodes: [...publicErrorCodes],
    secretFindingCount: dataFindings.length,
    hiddenThinkingFindingCount,
  };
  const report = sanitizeAcceptanceReport(buildRecoveryReport(facts));
  await writeNewAtomic(reportPath, Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8'));
  log(`recovery-acceptance: sanitized report written (findings=${dataFindings.length})`);

  const reportFindings = await scanForAcceptanceSecrets([reportPath]);
  const clean =
    outcome === 'completed' &&
    restartCount === 1 &&
    interruptedObserved &&
    reconciliation !== null &&
    reconciliation.mismatchCount === 0 &&
    dataFindings.length === 0 &&
    reportFindings.length === 0;
  const reason = clean
    ? undefined
    : outcome === 'completed'
      ? 'RECOVERY_GATE_FAILED'
      : outcome.toUpperCase();
  return { exitCode: clean ? 0 : 1, startedServer: true, reportPath, reason };
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
  runRecoveryAcceptanceCli(process.argv.slice(2))
    .then((result) => {
      process.exit(result.exitCode);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `recovery-acceptance: crashed (${error instanceof Error ? error.name : 'unknown error'})\n`,
      );
      process.exit(1);
    });
}
