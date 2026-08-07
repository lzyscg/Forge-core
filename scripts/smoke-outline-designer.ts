/**
 * outline-designer 真实闭环集成验证（一次性脚本，非提交物）。
 *
 * 用真实 DeepSeek 跑 outline-designer：outline-designer Agent 单回合内
 * load_skill -> read_skill_section xN -> write_workspace xN -> 自检返修 ->
 * validate_artifact -> finish_production(workspace_file) -> publish_artifact；
 * submitter 收到 blueprint 后 submit_final_artifact 完成。
 *
 * 验收点：
 *   1. task.status = completed（final_submission_accepted）。
 *   2. blueprint 落进产物版本目录，结构合规（13 个 h2、每章 7 个 h3、P0 标签）。
 *   3. 提交门禁未被 GATE_REJECTED（publish 与 submit 两点都过）。
 *   4. 上下文不爆（无 context overflow / PROVIDER_ERROR）。
 *   5. 回合 trace 呈现 read_skill_section 多次调用（渐进式披露生效）。
 *
 * 不碰提交的模板：复制到临时 data-root，仅替换 configured/* 模型标量。
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
const TEMPLATE_ID = 'outline-designer';
const TASK_NAME = 'smoke-outline-designer';
const DEADLINE_MS = 15 * 60 * 1000;
const POLL_MS = 5000;

const MODEL_BY_AGENT: Record<string, string> = {
  'outline-designer': 'deepseek/deepseek-v4-pro',
  submitter: 'deepseek/deepseek-v4-flash',
};
const PLACEHOLDER_BY_AGENT: Record<string, string> = {
  'outline-designer': 'configured/outline-designer-model',
  submitter: 'configured/submitter-model',
};

/** 短对标故事（2 个编号章节 + 冷开场），覆盖边界/事实/变化/人物压力/声音。 */
const SOURCE_STORY = [
  '《夜半的敲门声》对标故事原文',
  '',
  '## 00｜冷开场',
  '午夜十二点，出租屋的门被敲了三下。程默从猫眼看出去，走廊空无一人，只有一张泛黄的名片贴在门缝上。上面印着：江城，九年前失踪的同事。',
  '',
  '## 01｜江城的线索',
  '第二天，程默按照名片上的地址找到一间早已废弃的棋牌室。老板说，这间屋子九年来一直锁着，昨天却有人用程默的旧钥匙开过门。地上有一串湿脚印，从门口一直延伸到墙角的老式电话机。电话机的听筒没挂好，里面传来一段录音：周五晚九点，老地方见。',
  '',
  '## 02｜设局与反转',
  '周五晚，程默赴约。老地方是江边一艘报废的渔船。船上空无一人，但舱底的储物柜里放着一本账本，记录着九年前那场事故的真相：当年不是意外，是合伙人李峥做的局。程默正要报警，身后传来脚步声。李峥站在舱口，手里拿着手电筒，说：你果然还是来了。程默握紧账本，笑了笑：等的就是你。',
  '',
].join('\n');

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

/** 计数 blueprint 的固定 h2 / 章节卡 / 每章 h3 / P0 标签。 */
function inspectBlueprint(content: string): {
  h2: string[];
  chapters: number;
  chaptersMissingH3: string[];
  p0Untagged: string[];
} {
  const lines = content.split('\n');
  const h2: string[] = [];
  const chapters: string[] = [];
  const chaptersMissingH3: string[] = [];
  const p0Untagged: string[] = [];
  let current: { num: string; lines: string[] } | null = null;
  const H3 = ['章节目的与退出状态', '事实与知识边界', '因果与篇幅', '情绪执行与读者压力', '声音、判断与对白', '场景连续性与生命周期', '章末钩子'];
  const flush = () => {
    if (current === null) return;
    chapters.push(current.num);
    const chH3 = current.lines.filter((l) => /^###\s/.test(l)).map((l) => l.replace(/^###\s+/, '').trim());
    for (const h of H3) if (!chH3.includes(h)) chaptersMissingH3.push(`${current.num} 缺 ${h}`);
    const p0s = current.lines.filter((l) => /^[-*#\s]*P0[-0-9]*\s*[:：]/.test(l));
    if (p0s.length > 0 && !p0s.some((l) => /\[(?:FACT|OBS) @/.test(l))) p0Untagged.push(current.num);
    current = null;
  };
  for (const line of lines) {
    if (/^##\s/.test(line) && !/^###\s/.test(line)) {
      flush();
      const title = line.replace(/^##\s+/, '').trim();
      const card = /^(\d{1,3})[｜|]/.exec(title);
      if (card) current = { num: card[1], lines: [] };
      else h2.push(title);
    } else if (current !== null) {
      current.lines.push(line);
    }
  }
  flush();
  return { h2, chapters, chaptersMissingH3, p0Untagged };
}

async function main(): Promise<void> {
  // 1. env
  loadDotenv({ path: join(REPO_ROOT, '.env') });
  const key = process.env.DEEPSEEK_API_KEY || '';
  if (!key) throw new Error('DEEPSEEK_API_KEY not set');
  console.log(`[od-smoke] deepseek key configured (len=${key.length})`);

  // 2. fresh data root + template copy with model scalars replaced
  const dataRoot = join(REPO_ROOT, '.od-smoke-data-root');
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
    console.log(`[od-smoke] ${agent}.yaml model -> ${MODEL_BY_AGENT[agent]}`);
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
    console.log(`[od-smoke] server starting on ${baseUrl} (port ${port})`);
    await waitForHttp(`${baseUrl}/api/health`, 30_000);
    console.log('[od-smoke] server healthy');

    await httpJson('POST', `${baseUrl}/api/templates/${TEMPLATE_ID}/reload`, null);
    console.log('[od-smoke] template reloaded');

    const created = await httpJson('POST', `${baseUrl}/api/tasks`, {
      templateId: TEMPLATE_ID,
      name: TASK_NAME,
      input: { source_story: SOURCE_STORY },
    });
    taskId = created.id;
    console.log(`[od-smoke] task created: ${taskId}`);

    await httpJson('POST', `${baseUrl}/api/tasks/${taskId}/start`, null);
    console.log('[od-smoke] task started; polling...');

    const deadline = Date.now() + DEADLINE_MS;
    let lastStatus = '';
    for (;;) {
      workspace = await httpJson('GET', `${baseUrl}/api/tasks/${taskId}/workspace`, null);
      const status = workspace?.task?.status;
      if (status !== lastStatus) {
        const resultNodes = (workspace?.nodes ?? []).filter((n: any) => n.kind === 'result');
        console.log(`[od-smoke] status=${status} results=${resultNodes.length} attempts=${(workspace?.nodes ?? []).filter((n: any) => n.status === 'failed').length}`);
        lastStatus = status;
      }
      if (['completed', 'failed', 'stopped', 'incompatible'].includes(status)) break;
      if (Date.now() > deadline) { console.log('[od-smoke] DEADLINE EXCEEDED'); break; }
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
    console.log(`  [${n.kind}] ${n.id}  agent=${n.agent ?? ''} status=${n.status}${n.inputVersion != null ? ` inputVersion=${n.inputVersion}` : ''}`);
  }
  console.log('\n-- executed routes --');
  for (const r of workspace?.executedRoutes ?? []) {
    console.log(`  ${r.from} -> ${r.to}  (${r.kind})${r.label ? ' ' + r.label : ''}`);
  }

  // 5. turn traces: tool-call sequence (the seven-round evidence)
  console.log('\n-- turn traces (tool calls per turn) --');
  const taskDir = join(dataRoot, 'tasks', taskId);
  const tracesDir = join(taskDir, 'traces');
  if (existsSync(tracesDir)) {
    for (const f of readdirSync(tracesDir).sort()) {
      const trace = JSON.parse(readFileSync(join(tracesDir, f), 'utf8'));
      const calls = (trace.entries ?? []).filter((e: any) => e.kind === 'tool_call');
      console.log(`  ${f}: ${calls.length} tool calls -> ${calls.map((c: any) => c.toolName).join(', ')}`);
    }
  } else {
    console.log('  (no traces dir)');
  }

  // 6. on-disk artifact + blueprint inspection
  console.log('\n-- on-disk artifacts --');
  let blueprintText = '';
  const artDir = join(taskDir, 'artifacts');
  if (existsSync(artDir)) {
    for (const v of readdirSync(artDir).sort()) {
      const vdir = join(artDir, v);
      for (const f of readdirSync(vdir).sort()) {
        const content = readFileSync(join(vdir, f), 'utf8');
        if (f.endsWith('.md') && !f.startsWith('review')) blueprintText = content;
        console.log(`  v${v}/${f} (${content.length} bytes)`);
      }
    }
  } else {
    console.log('  (no artifacts dir on disk)');
  }

  // 7. blueprint structure inspection
  console.log('\n-- blueprint structure --');
  if (blueprintText) {
    const insp = inspectBlueprint(blueprintText);
    console.log('  h2 count:', insp.h2.length);
    console.log('  h2 missing of 13:', 13 - insp.h2.filter((t) => ['提取基准与章节边界','一句话主线','叙述契约','主题与价值冲突','叙事指纹','原文事实冲突与处理决定','源文功能覆盖总表','全局信息揭示表','全局生命周期调度','分章执行卡','主要人物与关系状态','伏笔与回收','复现门禁报告'].includes(t)).length);
    console.log('  chapters:', insp.chapters.join(','));
    console.log('  chapters missing h3:', insp.chaptersMissingH3.length === 0 ? 'none' : insp.chaptersMissingH3.join('; '));
    console.log('  chapters with untagged P0:', insp.p0Untagged.length === 0 ? 'none' : insp.p0Untagged.join(','));
    const marker = /^## 分章执行卡$/m.test(blueprintText);
    console.log('  ## 分章执行卡 marker:', marker);
  } else {
    console.log('  (no blueprint found)');
  }

  // 8. server log: context overflow / gate rejection scan
  console.log('\n-- server-log checks --');
  const hasOverflow = /context (length|overflow|window)|maximum context|token limit/i.test(serverLog);
  const hasGateReject = /GATE_REJECTED|GATE_RUNTIME_ERROR|未通过模板门禁/.test(serverLog);
  console.log('  context overflow in logs:', hasOverflow ? 'YES (bad)' : 'no');
  console.log('  gate rejection in logs:', hasGateReject ? 'YES (bad)' : 'no');

  // 9. verdict
  const status = workspace?.task?.status;
  const ok = status === 'completed' && !hasOverflow && !hasGateReject;
  console.log('\n========== VERDICT ==========');
  console.log(ok ? 'PASS: task completed, no overflow, no gate rejection' : `FAIL: status=${status} overflow=${hasOverflow} gateReject=${hasGateReject}`);
  if (ok) rmSync(dataRoot, { recursive: true, force: true });
  else console.log('(kept .od-smoke-data-root for inspection)');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('[od-smoke] fatal:', e); process.exit(2); });
