/**
 * long-form-hub 真实闭环烟雾测试（一次性验证脚本，非提交物）。
 *
 * 用真实 DeepSeek 跑一条 long-form-hub：controller 分配 -> writer 出稿 ->
 * reviewer 审 -> （打回则返修 -> 复审）-> forward -> controller 提交。
 * 验收点：task.status=completed；产物链呈现 v1（review:reject）/ v2（review:pass,final）。
 *
 * 不碰提交的模板：复制到临时 data-root，仅替换 3 个 configured/* 模型标量。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TEMPLATE_ID = 'long-form-hub';
const TASK_NAME = 'smoke-long-form-hub';
const DEADLINE_MS = 8 * 60 * 1000;
const POLL_MS = 3000;

const MODEL_BY_AGENT: Record<string, string> = {
  controller: 'deepseek/deepseek-v4-pro',
  writer: 'deepseek/deepseek-v4-flash',
  reviewer: 'deepseek/deepseek-v4-pro',
};
const PLACEHOLDER_BY_AGENT: Record<string, string> = {
  controller: 'configured/controller-model',
  writer: 'configured/writer-model',
  reviewer: 'configured/reviewer-model',
};

function tsxBinary(): string {
  let dir = REPO_ROOT;
  for (let i = 0; i < 6; i += 1) {
    const c = join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (existsSync(c)) return c;
    dir = dirname(dir);
  }
  throw new Error('no tsx found');
}

function reservePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      if (a === null || typeof a === 'string') { s.close(); rej(new Error('no port')); return; }
      const { port } = a;
      s.close(() => res(port));
    });
  });
}

async function waitForHttp(url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* keep */ }
    if (Date.now() > deadline) throw new Error(`${url} not up in ${ms}ms`);
    await new Promise((w) => setTimeout(w, 250));
  }
}

async function httpJson(method: string, url: string, body: unknown): Promise<any> {
  const r = await fetch(url, {
    method,
    headers: body === null ? undefined : { 'content-type': 'application/json' },
    body: body === null ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
}

async function main(): Promise<void> {
  // 1. env
  loadDotenv({ path: join(REPO_ROOT, '.env') });
  const key = process.env.DEEPSEEK_API_KEY || '';
  if (!key) throw new Error('DEEPSEEK_API_KEY not set');
  console.log(`[smoke] deepseek key configured (len=${key.length})`);

  // 2. fresh data root + template copy with model scalars replaced
  const dataRoot = join(REPO_ROOT, '.smoke-data-root');
  rmSync(dataRoot, { recursive: true, force: true });
  mkdirSync(dataRoot, { recursive: true });
  const templateRoot = join(dataRoot, 'templates');
  const templateDir = join(templateRoot, TEMPLATE_ID);
  cpSync(join(REPO_ROOT, 'templates', TEMPLATE_ID), templateDir, { recursive: true });
  for (const agent of Object.keys(MODEL_BY_AGENT)) {
    const file = join(templateDir, 'agents', `${agent}.yaml`);
    let text = readFileSync(file, 'utf8');
    text = text.replace(PLACEHOLDER_BY_AGENT[agent], MODEL_BY_AGENT[agent]);
    if (!text.includes(MODEL_BY_AGENT[agent])) throw new Error(`model scalar not replaced in ${agent}.yaml`);
    writeFileSync(file, text, 'utf8');
    console.log(`[smoke] ${agent}.yaml model -> ${MODEL_BY_AGENT[agent]}`);
  }

  // 3. spawn server
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [tsxBinary(), 'src/server/main.ts'], {
    cwd: REPO_ROOT,
    detached: true,
    env: {
      ...process.env,
      FORGE_CORE_DATA_ROOT: dataRoot,
      FORGE_CORE_TEMPLATE_ROOT: templateRoot,
      FORGE_CORE_PORT: String(port),
      FORGE_CORE_MODE: 'production',
      FORGE_CORE_RUNTIME: 'pi',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout?.on('data', (d: Buffer) => { const s = d.toString(); serverLog += s; process.stdout.write(`[server] ${s}`); });
  child.stderr?.on('data', (d: Buffer) => { const s = d.toString(); serverLog += s; process.stderr.write(`[server!] ${s}`); });

  let workspace: any = null;
  let taskId = '';
  try {
    console.log(`[smoke] server starting on ${baseUrl} (port ${port})`);
    await waitForHttp(`${baseUrl}/api/health`, 30_000);
    console.log('[smoke] server healthy');

    await httpJson('POST', `${baseUrl}/api/templates/${TEMPLATE_ID}/reload`, null);
    console.log('[smoke] template reloaded');

    const input = JSON.parse(readFileSync(join(templateDir, 'input.example.json'), 'utf8'));
    const created = await httpJson('POST', `${baseUrl}/api/tasks`, { templateId: TEMPLATE_ID, name: TASK_NAME, input });
    taskId = created.id;
    console.log(`[smoke] task created: ${taskId}`);

    await httpJson('POST', `${baseUrl}/api/tasks/${taskId}/start`, null);
    console.log('[smoke] task started; polling...');

    const deadline = Date.now() + DEADLINE_MS;
    let lastStatus = '';
    for (;;) {
      workspace = await httpJson('GET', `${baseUrl}/api/tasks/${taskId}/workspace`, null);
      const status = workspace?.task?.status;
      if (status !== lastStatus) {
        const cur = workspace?.nodes?.filter((n: any) => n.kind === 'result').at(-1);
        console.log(`[smoke] status=${status} results=${workspace?.nodes?.filter((n:any)=>n.kind==='result').length ?? 0}` + (cur ? ` last=${cur.agent ?? cur.id}` : ''));
        lastStatus = status;
      }
      if (['completed', 'failed', 'stopped', 'incompatible'].includes(status)) break;
      if (Date.now() > deadline) { console.log('[smoke] DEADLINE EXCEEDED'); break; }
      await new Promise((w) => setTimeout(w, POLL_MS));
    }
  } finally {
    killTree(child);
    await new Promise((w) => setTimeout(w, 1500));
  }

  // 4. report
  console.log('\n========== RESULT ==========');
  console.log('task.status:', workspace?.task?.status);
  const nodes = workspace?.nodes ?? [];
  console.log('\n-- node sequence --');
  for (const n of nodes) {
    const extra = n.kind === 'result'
      ? `agent=${n.agent} attempts=${n.attemptCount} ${n.status}`
      : `status=${n.status}${n.inputVersion != null ? ` inputVersion=${n.inputVersion}` : ''}${n.humanAuthorized ? ' humanAuthorized' : ''}${n.superseded ? ' SUPERSEDED' : ''}`;
    console.log(`  [${n.kind}] ${n.id}  ${extra}`);
  }
  console.log('\n-- executed routes --');
  for (const r of workspace?.executedRoutes ?? []) {
    console.log(`  ${r.from} -> ${r.to}  (${r.kind})${r.label ? ' ' + r.label : ''}`);
  }
  console.log('\n-- artifact versions (projection) --');
  const arts = [...(workspace?.artifacts ?? [])].sort((a: any, b: any) => a.version - b.version);
  for (const a of arts) {
    const files = (a.files ?? []).map((f: any) => f.name).join(', ');
    console.log(`  v${String(a.version).padStart(3, '0')}  final=${a.final}  files=[${files}]`);
  }

  // 5. read artifact files from disk
  console.log('\n-- on-disk artifact files --');
  const taskDir = join(dataRoot, 'tasks', taskId);
  const artDir = join(taskDir, 'artifacts');
  if (existsSync(artDir)) {
    for (const v of readdirSync(artDir).sort()) {
      console.log(`\n  ### ${v}`);
      const vdir = join(artDir, v);
      for (const f of readdirSync(vdir).sort()) {
        const content = readFileSync(join(vdir, f), 'utf8');
        const preview = content.slice(0, 400);
        console.log(`  --- ${f} (${content.length} bytes) ---`);
        console.log(preview.replace(/\n/g, '\n  '));
      }
    }
  } else {
    console.log('  (no artifacts dir on disk)');
  }

  // 6. verdict
  const status = workspace?.task?.status;
  const ok = status === 'completed';
  console.log('\n========== VERDICT ==========');
  console.log(ok ? 'PASS: task completed' : `FAIL: task.status=${status}`);
  // cleanup data root (keep for inspection if failed)
  if (ok) rmSync(dataRoot, { recursive: true, force: true });
  else console.log('(kept .smoke-data-root for inspection)');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('[smoke] fatal:', e); process.exit(2); });
