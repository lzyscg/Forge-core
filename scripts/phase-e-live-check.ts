/**
 * Phase E Task 6 real light acceptance (throwaway driver).
 *
 * Boots the production-shaped development server on port 3210 over the live
 * data/template roots with the REAL Pi runtime (credentials resolved from
 * the repository .env by the deepseek provider at request time — never read
 * or printed here), then drives one real zhihu-single-chapter task through
 * the browser and checks the six Phase E items:
 *
 *   1. canvas shows the writer's skill node (chapter-drafting)
 *   2. the result trace dialog shows thinking (or records its absence, R1)
 *      + tool calls/results + final text
 *   3. traces/<turnId>.json exists on disk
 *   4. workspaces/writer/ holds the draft file(s)
 *   5. V1 artifact content SHA-256 equals the workspace draft hash
 *   6. 用当前模板重跑 creates a ready clone with the same frozen input
 *
 * Output is sanitized: task ids are truncated to 8 chars, only SHA-256
 * hashes/lengths/booleans are printed — never artifact bodies or thinking
 * text. Screenshots land in forge-core-overnight/evidence/screenshots/.
 *
 * Run from apps/forge-core:  npx tsx scripts/phase-e-live-check.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { chromium, type Page } from '@playwright/test';

const PORT = 3210;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const TASK_NAME = '阶段E真实轻验收任务';

/* ------------------------------ path anchors ----------------------------- */

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, '..'); // apps/forge-core
const repoRoot = resolve(workspaceRoot, '..', '..');
const dataRoot = join(repoRoot, 'data', 'forge-core-live');
const templateRoot = join(repoRoot, 'data', 'forge-core-live-templates');
const screenshotDir = join(repoRoot, 'forge-core-overnight', 'evidence', 'screenshots');

/* ------------------------------ sanitization ----------------------------- */

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/* ------------------------------ environment ------------------------------ */

function loadRepoEnvFile(): void {
  let dir = workspaceRoot;
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
  throw new Error('phase-e-live-check: no .env found above the workspace root');
}

function tsxBinary(): string {
  let dir = workspaceRoot;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('phase-e-live-check: no node_modules/tsx/dist/cli.mjs found above the workspace');
}

/* ------------------------------- server spawn ---------------------------- */

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function spawnLiveServer(): ChildProcess {
  const child = spawn(process.execPath, [tsxBinary(), 'src/server/main.ts'], {
    cwd: workspaceRoot,
    detached: true,
    env: {
      ...process.env,
      FORGE_CORE_DATA_ROOT: dataRoot,
      FORGE_CORE_TEMPLATE_ROOT: templateRoot,
      FORGE_CORE_PORT: String(PORT),
      FORGE_CORE_MODE: 'development',
      FORGE_CORE_RUNTIME: 'pi',
      // Development mode serves the client through the Vite middleware, which
      // resolves VITE_FORGE_CORE_MODE from the server environment at
      // transform time; the page must bind the HttpGateway, not the mock.
      VITE_FORGE_CORE_MODE: 'http',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    if (text.includes('DEEPSEEK') || text.toLowerCase().includes('key')) return; // never relay anything credential-shaped
    process.stdout.write(`[server] ${text}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[server:err] ${chunk.toString('utf8')}`);
  });
  return child;
}

async function waitForHttp(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`phase-e-live-check: ${url} not reachable within ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/* --------------------------------- API ----------------------------------- */

interface ApiNode {
  id: string;
  agentId: string;
  kind: string;
  title: string;
  status: string;
  turnId?: string | null;
}

interface ApiWorkspace {
  task: { id: string; name: string; status: string };
  frozenInput: Record<string, string>;
  templateVersion: string;
  nodes: ApiNode[];
  artifacts: Array<{ version: number; content: string; final: boolean }>;
}

async function getWorkspace(taskId: string): Promise<ApiWorkspace> {
  const response = await fetch(`${BASE_URL}/api/tasks/${encodeURIComponent(taskId)}/workspace`);
  if (!response.ok) throw new Error(`workspace ${response.status}`);
  return (await response.json()) as ApiWorkspace;
}

async function waitForCompletion(taskId: string): Promise<ApiWorkspace> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const workspace = await getWorkspace(taskId);
    const status = workspace.task.status;
    if (status === 'completed') return workspace;
    if (status === 'retryable_failure' || status === 'stopped' || status === 'corrupt') {
      throw new Error(`task ended in status '${status}' before completion`);
    }
    if (Date.now() > deadline) {
      throw new Error(`task stayed '${status}' past the ${POLL_TIMEOUT_MS / 60000} min budget`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function listFilesRecursive(root: string): Array<{ path: string; bytes: Buffer }> {
  const found: Array<{ path: string; bytes: Buffer }> = [];
  if (!existsSync(root)) return found;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else found.push({ path: full.slice(root.length + 1), bytes: readFileSync(full) });
    }
  };
  walk(root);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/* --------------------------------- main ---------------------------------- */

interface Checklist {
  taskIdPrefix: string;
  skillNodeVisible: boolean;
  dialogNodeAgent: string | null;
  resultDialogToolCall: boolean;
  resultDialogToolResult: boolean;
  resultDialogBody: boolean;
  thinkingPresent: boolean | null; // null = dialog never opened
  traceFiles: string[];
  workspaceDraftFiles: Array<{ path: string; sha256: string }>;
  v1Sha256: string | null;
  v1MatchesDraftPath: string | null;
  artifactDraftMatches: Array<{ version: number; sha256: string; matchedPath: string | null }>;
  cloneIdPrefix: string | null;
  cloneReady: boolean;
  cloneFrozenInputEqual: boolean;
  cloneNameSuffix: boolean;
  cloneTemplateVersionEqual: boolean;
  durationMs: number;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  loadRepoEnvFile();
  mkdirSync(screenshotDir, { recursive: true });

  const server = spawnLiveServer();
  const browser = await chromium.launch();
  const checklist: Checklist = {
    taskIdPrefix: '',
    skillNodeVisible: false,
    dialogNodeAgent: null,
    resultDialogToolCall: false,
    resultDialogToolResult: false,
    resultDialogBody: false,
    thinkingPresent: null,
    traceFiles: [],
    workspaceDraftFiles: [],
    v1Sha256: null,
    v1MatchesDraftPath: null,
    artifactDraftMatches: [],
    cloneIdPrefix: null,
    cloneReady: false,
    cloneFrozenInputEqual: false,
    cloneNameSuffix: false,
    cloneTemplateVersionEqual: false,
    durationMs: 0,
  };

  try {
    await waitForHttp(`${BASE_URL}/api/templates`);

    // Create the task with the template's example input (read from the live
    // template root; content is sent to the API, never printed here).
    const input = JSON.parse(
      readFileSync(join(templateRoot, 'zhihu-single-chapter', 'input.example.json'), 'utf8'),
    ) as Record<string, string>;
    const created = await fetch(`${BASE_URL}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'zhihu-single-chapter', name: TASK_NAME, input }),
    });
    if (!created.ok) throw new Error(`create task failed with ${created.status}`);
    const taskId = ((await created.json()) as { id: string }).id;
    checklist.taskIdPrefix = shortId(taskId);
    console.log(`[check] task created: prefix=${checklist.taskIdPrefix}`);

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();

    // Formal entry through the task list, then start production.
    await page.goto(`${BASE_URL}/tasks`);
    await page.waitForSelector(`a[href="/tasks/${taskId}"]`, { timeout: 20_000 });
    await page.locator(`a[href="/tasks/${taskId}"]`).click();
    await page.waitForURL(`${BASE_URL}/tasks/${taskId}`);
    const backdrop = page.locator('.fc-drawer-backdrop');
    if (await backdrop.isVisible()) {
      await backdrop.click({ position: { x: 8, y: 400 } });
    }
    await page.getByRole('button', { name: '开始生产' }).click();
    console.log('[check] production started; polling for completion (budget 30 min)…');

    const workspace = await waitForCompletion(taskId);
    console.log(`[check] task completed; artifacts=${workspace.artifacts.length}`);
    await page.reload();
    await page.waitForSelector('[data-testid="workspace-canvas"]');
    if (await backdrop.isVisible()) {
      await backdrop.click({ position: { x: 8, y: 400 } });
    }

    // (1) Skill node on the canvas (writer loads chapter-drafting).
    const skillNode = workspace.nodes.find(
      (node) => node.kind === 'skill' && node.title === 'chapter-drafting',
    );
    if (skillNode !== undefined) {
      const canvasSkill = page.locator(`#node-${skillNode.id}`);
      checklist.skillNodeVisible = await canvasSkill.isVisible();
    }
    await page.screenshot({ path: join(screenshotDir, 'phase-e-canvas-skill-node.png') });
    console.log(`[check] (1) canvas skill node visible=${checklist.skillNodeVisible}`);

    // Skill content dialog screenshot (full text inside the dialog).
    if (skillNode !== undefined) {
      await page.locator(`#node-${skillNode.id}`).click();
      await page.waitForSelector('[role="dialog"] .fc-trace__skill-content', { timeout: 15_000 });
      await page.screenshot({ path: join(screenshotDir, 'phase-e-skill-content-dialog.png') });
      await page.keyboard.press('Escape');
      await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 10_000 });
    }

    // (2) Result trace dialog: prefer the result whose trace carries a
    // write_workspace call (the drafting turn); fall back to the first result
    // with any tool call, then to the last result node with a turnId.
    const resultNodes = workspace.nodes.filter(
      (node) => node.kind === 'result' && (node.turnId ?? null) !== null,
    );
    let dialogNode: ApiNode | null = null;
    let fallbackNode: ApiNode | null = null;
    for (const candidate of resultNodes) {
      const traceResponse = await fetch(
        `${BASE_URL}/api/tasks/${encodeURIComponent(taskId)}/trace/${encodeURIComponent(candidate.turnId as string)}`,
      );
      if (!traceResponse.ok) continue;
      const trace = (await traceResponse.json()) as {
        entries: Array<{ kind: string; toolName?: string }>;
      };
      if (trace.entries.some((entry) => entry.kind === 'tool_call' && entry.toolName === 'write_workspace')) {
        dialogNode = candidate;
        break;
      }
      if (fallbackNode === null && trace.entries.some((entry) => entry.kind === 'tool_call')) {
        fallbackNode = candidate;
      }
    }
    if (dialogNode === null) dialogNode = fallbackNode;
    if (dialogNode === null && resultNodes.length > 0) {
      dialogNode = resultNodes[resultNodes.length - 1];
    }
    checklist.dialogNodeAgent = dialogNode !== null ? dialogNode.agentId : null;

    if (dialogNode !== null) {
      await page.locator(`#node-${dialogNode.id}`).click();
      await page.waitForSelector('[role="dialog"]', { timeout: 15_000 });
      // The trace loads asynchronously; wait for content OR the placeholder
      // before asserting anything (one-shot isVisible would race the fetch).
      await page.waitForSelector('[role="dialog"] .fc-trace__sections, [role="dialog"] .fc-trace__placeholder', {
        timeout: 20_000,
      });
      const dialog = page.locator('[role="dialog"]');
      checklist.resultDialogToolCall = await dialog
        .locator('.fc-trace__section-title', { hasText: '工具调用：' })
        .first()
        .isVisible()
        .catch(() => false);
      checklist.resultDialogToolResult = await dialog
        .locator('.fc-trace__section-title', { hasText: '工具返回：' })
        .first()
        .isVisible()
        .catch(() => false);
      checklist.resultDialogBody = await dialog
        .locator('.fc-trace__section-title', { hasText: '正文' })
        .first()
        .isVisible()
        .catch(() => false);
      checklist.thinkingPresent = await dialog
        .locator('.fc-trace__section--thinking')
        .first()
        .isVisible()
        .catch(() => false);
      await page.screenshot({ path: join(screenshotDir, 'phase-e-result-trace-dialog.png') });
      await page.keyboard.press('Escape');
      await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 10_000 });
    }
    console.log(
      `[check] (2) result dialog (agent=${checklist.dialogNodeAgent ?? 'none'}): toolCall=${checklist.resultDialogToolCall} toolResult=${checklist.resultDialogToolResult} body=${checklist.resultDialogBody} thinking=${String(checklist.thinkingPresent)}`,
    );

    // (3) Trace files on disk (sanitized: names only).
    const tracesRoot = join(dataRoot, 'tasks', taskId, 'traces');
    checklist.traceFiles = existsSync(tracesRoot)
      ? readdirSync(tracesRoot).filter((name) => name.endsWith('.json'))
      : [];
    console.log(`[check] (3) trace files on disk: ${checklist.traceFiles.length}`);

    // (4) Workspace draft files under workspaces/writer (names + hashes only).
    const writerWorkspace = join(dataRoot, 'tasks', taskId, 'workspaces', 'writer');
    checklist.workspaceDraftFiles = listFilesRecursive(writerWorkspace).map((file) => ({
      path: file.path,
      sha256: sha256Hex(file.bytes),
    }));
    console.log(
      `[check] (4) writer workspace files: ${checklist.workspaceDraftFiles
        .map((file) => `${file.path}@${file.sha256.slice(0, 12)}`)
        .join(', ') || '(none)'}`,
    );

    // (5) Artifact content hashes vs the CURRENT workspace draft files. The
    // revision turn legitimately overwrites the draft, so every version is
    // matched independently; with one version the V1 hash equals the draft.
    for (const artifact of workspace.artifacts) {
      const hash = sha256Hex(artifact.content);
      const match = checklist.workspaceDraftFiles.find((file) => file.sha256 === hash);
      checklist.artifactDraftMatches.push({
        version: artifact.version,
        sha256: hash,
        matchedPath: match !== undefined ? match.path : null,
      });
      if (artifact.version === 1) checklist.v1Sha256 = hash;
    }
    const v1Match = checklist.artifactDraftMatches.find((entry) => entry.version === 1);
    checklist.v1MatchesDraftPath = v1Match?.matchedPath ?? null;
    console.log(
      `[check] (5) artifact/workspace hash matches: ${checklist.artifactDraftMatches
        .map((entry) => `V${entry.version}=${entry.sha256.slice(0, 16)}…->${entry.matchedPath ?? 'NOT-PASSED'}`)
        .join(' | ')}`,
    );

    // (6) Same-input clone from the production page.
    await page.getByRole('button', { name: '用当前模板重跑' }).click();
    await page.waitForURL((url) => url.pathname !== `/tasks/${taskId}`, { timeout: 30_000 });
    const cloneId = new URL(page.url()).pathname.split('/').pop() ?? '';
    checklist.cloneIdPrefix = shortId(cloneId);
    await page.waitForSelector('text=待运行', { timeout: 15_000 });
    const cloneWorkspace = await getWorkspace(cloneId);
    checklist.cloneReady = cloneWorkspace.task.status === 'ready';
    checklist.cloneFrozenInputEqual =
      JSON.stringify(cloneWorkspace.frozenInput) === JSON.stringify(workspace.frozenInput);
    checklist.cloneNameSuffix = cloneWorkspace.task.name === `${TASK_NAME}（重跑）`;
    checklist.cloneTemplateVersionEqual =
      cloneWorkspace.templateVersion === workspace.templateVersion;
    await page.goto(`${BASE_URL}/tasks`);
    await page.waitForSelector('text=重跑', { timeout: 15_000 });
    await page.screenshot({ path: join(screenshotDir, 'phase-e-task-list-clone.png') });
    console.log(
      `[check] (6) clone: prefix=${checklist.cloneIdPrefix} ready=${checklist.cloneReady} frozenInputEqual=${checklist.cloneFrozenInputEqual} nameSuffix=${checklist.cloneNameSuffix} templateVersionEqual=${checklist.cloneTemplateVersionEqual}`,
    );

    await context.close();
  } finally {
    checklist.durationMs = Date.now() - startedAt;
    await browser.close().catch(() => undefined);
    killProcessTree(server, 'SIGTERM');
    await new Promise<void>((r) => {
      const timer = setTimeout(() => {
        killProcessTree(server, 'SIGKILL');
        r();
      }, 10_000);
      server.once('exit', () => {
        clearTimeout(timer);
        r();
      });
      if (server.exitCode !== null || server.signalCode !== null) {
        clearTimeout(timer);
        r();
      }
    });
  }

  console.log('[checklist] ' + JSON.stringify(checklist, null, 2));
}

main().then(
  () => {
    console.log('[done] live check finished');
    process.exit(0);
  },
  (error: unknown) => {
    console.error(`[fatal] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  },
);
