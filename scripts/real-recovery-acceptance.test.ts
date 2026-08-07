// @vitest-environment node
/**
 * Real recovery acceptance runner (plan Phase D Task 4 Step 1).
 *
 * Pins the recovery contract BEFORE any implementation exists:
 *
 * - the verbatim fake orchestration case (plan Step 1): a scripted child
 *   server stops itself at the first confirmed artifact boundary through the
 *   runner's acceptance hook, a second child boots on the SAME roots, the
 *   public resume completes the task with versions [1, 2] and NO duplicate
 *   version;
 * - the boundary hook pauses strictly BEFORE the next Agent is scheduled —
 *   at the boundary the receiving agent owns a confirmed input but has never
 *   run a Turn;
 * - the full CLI drives preflight -> interrupt -> restart -> resume ->
 *   reconciliation -> sanitized report exclusively through the public HTTP
 *   surface and the injected process-harness seams (no real tokens here);
 * - every preflight failure exits 2 before any server is constructed.
 *
 * The harnesses and fixtures live in this file (plan Step 1); the runner
 * module under test exposes `runRecoveryAcceptanceCli` with injectable seams
 * and the child-process lifecycle (`spawnRecoveryServer`) shared by the fake
 * orchestration harness and the real run — exactly like Phase D Task 2.
 */
import { createHash } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CorePaths } from '../src/server/storage/core-paths';
import {
  ACCEPTANCE_TEMPLATE_ID,
  type PreflightModelRuntime,
} from './real-acceptance';
import {
  RECOVERY_REPORT_KEYS,
  releaseBoundary,
  runRecoveryAcceptanceCli,
  spawnRecoveryServer,
  waitForBoundary,
  readRecoveryFileProjection,
  type RecoveryCliDeps,
  type RecoveryScreenshotSession,
  type ScreenshotEntry,
} from './real-recovery-acceptance';

/* -------------------------------------------------------------------------- */
/* Locations and shared fixtures                                               */
/* -------------------------------------------------------------------------- */

/** the project root (this file lives in the project root/scripts). */
function workspaceRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

/** The committed self-contained acceptance template (plan Phase D Task 1). */
function committedZhihuTemplateDir(): string {
  return resolve(workspaceRoot(), 'templates', ACCEPTANCE_TEMPLATE_ID);
}

const createdRoots: string[] = [];

function freshRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
  for (const harness of openHarnesses) {
    harness.dispose();
  }
  openHarnesses.clear();
});

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createNetServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        rejectPort(new Error('real-recovery.test: the port probe did not report an address'));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Neutral two-agent fixture template (platform-neutral, iron rule 1)          */
/* -------------------------------------------------------------------------- */

const FIXTURE_TEMPLATE_ID = 'recovery-fixture-template';
const FIXTURE_INPUT_FIELD_ID = 'opening-input';
const FIXTURE_FINAL_NAME = 'final-output';

const FIXTURE_TEMPLATE_YAML = `# 恢复验收 fixture（阶段 D Task 4，仅用于测试）
name: 恢复验收 Fixture 模板
description: 两个平台中性 Agent 的恢复边界验收 fixture。
inputFields:
  - id: ${FIXTURE_INPUT_FIELD_ID}
    label: 开场输入
    kind: textarea
    required: true
    description: 任务的初始输入内容
finalArtifact:
  name: ${FIXTURE_FINAL_NAME}
  format: markdown
`;

const FIXTURE_PIPELINE_YAML = `agents:
  - agent-alpha
  - agent-beta
routes:
  - from: agent-alpha
    to: agent-beta
    kind: artifact
    label: 交付产物
    inject:
      - { version: input, file: content.md, as: 上一版正文 }
  - from: agent-beta
    to: agent-alpha
    kind: message
    label: 返修意见
    inject:
      - { version: input, file: content.md, as: 上一版正文 }
      - { version: input, file: review.md, as: 返修意见 }
artifactSchema:
  files:
    - { name: content.md, required: true,  producer: agent-alpha, extract: content, phase: create }
    - { name: review.md,  required: false, producer: agent-beta,  extract: review,   phase: annotate }
finalOutput:
  submitters:
    - agent-alpha
    - agent-beta
`;

const FIXTURE_AGENT_ALPHA_YAML = `id: agent-alpha
name: 执行 Agent Alpha
description: 恢复验收的第一位平台中性 Agent。
model: configured/test-model
systemPrompt: |
  你是恢复验收的执行 Agent Alpha（fixture 数据，仅用于测试）。
skills:
  - id: alpha-skill
    name: Alpha 技能
    description: 中性技能。
    contentPath: skills/alpha-skill/SKILL.md
turnContract:
  version: 2
  production:
    files: [content.md]
    sources: [inline, workspace_file]
    formats: [markdown]
  dispatch:
    allowedActions: [publish_artifact]
    targets:
      publish_artifact: agent-beta
`;

const FIXTURE_AGENT_BETA_YAML = `id: agent-beta
name: 执行 Agent Beta
description: 恢复验收的第二位平台中性 Agent。
model: configured/test-model
systemPrompt: |
  你是恢复验收的执行 Agent Beta（fixture 数据，仅用于测试）。
skills:
  - id: beta-skill
    name: Beta 技能
    description: 中性技能。
    contentPath: skills/beta-skill/SKILL.md
turnContract:
  version: 2
  annotate:
    files: [review.md]
  dispatch:
    allowedActions: [send_message, submit_final_artifact]
    targets:
      send_message: agent-alpha
`;

function installFixtureTemplate(templateRoot: string): void {
  const root = join(templateRoot, FIXTURE_TEMPLATE_ID);
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, 'skills', 'alpha-skill'), { recursive: true });
  mkdirSync(join(root, 'skills', 'beta-skill'), { recursive: true });
  writeFileSync(join(root, 'template.yaml'), FIXTURE_TEMPLATE_YAML, 'utf8');
  writeFileSync(join(root, 'pipeline.yaml'), FIXTURE_PIPELINE_YAML, 'utf8');
  writeFileSync(join(root, 'agents', 'agent-alpha.yaml'), FIXTURE_AGENT_ALPHA_YAML, 'utf8');
  writeFileSync(join(root, 'agents', 'agent-beta.yaml'), FIXTURE_AGENT_BETA_YAML, 'utf8');
  writeFileSync(join(root, 'skills', 'alpha-skill', 'SKILL.md'), '# Alpha 技能\n\n中性内容。\n', 'utf8');
  writeFileSync(join(root, 'skills', 'beta-skill', 'SKILL.md'), '# Beta 技能\n\n中性内容。\n', 'utf8');
}

/** Seals an inline package and publishes it (turn contract sequence). */
function publishFixtureArtifactTurn(title: string, content: string): Array<Record<string, unknown>> {
  return [
    {
      type: 'finish_production',
      source: 'inline',
      files: [{ name: 'content.md', content }],
      format: 'markdown',
      artifactType: FIXTURE_FINAL_NAME,
      title,
    },
    { type: 'publish_artifact' },
  ];
}

/** Phase A scripts: alpha publishes V1 (auto artifact hand-off to beta). */
function phaseAScripts(): Record<string, unknown> {
  return {
    'agent-alpha': [
      {
        kind: 'result',
        publicText: '第一版已发布。',
        actions: publishFixtureArtifactTurn('第一版', '# 第一版\n\n初始正文。'),
      },
    ],
  };
}

/** Phase B scripts: beta returns, alpha publishes V2, beta submits the received V2. */
function phaseBScripts(): Record<string, unknown> {
  return {
    'agent-beta': [
      {
        kind: 'result',
        publicText: '请返修。',
        actions: [
          {
            type: 'annotate_artifact',
            file: 'review.md',
            content: '---\nverdict: reject\n---\n请修订第一版。',
          },
          {
            type: 'send_message',
            targetAgentId: 'agent-alpha',
            summary: '请返修。',
          },
        ],
      },
      {
        kind: 'result',
        publicText: '提交最终产物。',
        actions: [
          {
            type: 'annotate_artifact',
            file: 'review.md',
            content: '---\nverdict: pass\n---\n通过。',
          },
          { type: 'submit_final_artifact' },
        ],
      },
    ],
    'agent-alpha': [
      {
        kind: 'result',
        publicText: '第二版已发布。',
        actions: publishFixtureArtifactTurn('第二版', '# 第二版\n\n修订后的正文。'),
      },
    ],
  };
}

function writeScripts(file: string, scripts: Record<string, unknown>): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(scripts, null, 2)}\n`, 'utf8');
}

/* -------------------------------------------------------------------------- */
/* Fake recovery orchestration harness (plan Step 1): the SAME child-process   */
/* lifecycle the real runner uses — spawn tsx main.ts, let the acceptance      */
/* hook stop the child at the confirmed artifact boundary, restart on the      */
/* same roots, resume through the public API.                                  */
/* -------------------------------------------------------------------------- */

interface FakeRecoveryHarness {
  runUntilArtifact(version: number): Promise<void>;
  restartServer(): Promise<void>;
  resume(): Promise<void>;
  artifactVersions(): number[];
  finalStatus(): string;
  /** Events/artifacts observed on disk after the last settled state. */
  fileProjection(): ReturnType<typeof readRecoveryFileProjection>;
  dispose(): void;
}

const openHarnesses = new Set<{ dispose(): void }>();

function fakeRecoveryAcceptanceHarness(): FakeRecoveryHarness {
  const dataRoot = freshRoot('forge-recovery-fake-data-');
  const templateRoot = freshRoot('forge-recovery-fake-templates-');
  const scriptDir = freshRoot('forge-recovery-fake-scripts-');
  installFixtureTemplate(templateRoot);
  const scriptFileA = join(scriptDir, 'phase-a.json');
  const scriptFileB = join(scriptDir, 'phase-b.json');
  writeScripts(scriptFileA, phaseAScripts());
  writeScripts(scriptFileB, phaseBScripts());

  let port = 0;
  let taskId = '';
  let child: Awaited<ReturnType<typeof spawnRecoveryServer>> | null = null;
  let lastStatus = '';

  async function http(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`fake-recovery harness: ${path} answered ${response.status}: ${text}`);
    }
    return text.length > 0 ? JSON.parse(text) : null;
  }

  async function waitForStatus(status: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const workspace = (await http(
        'GET',
        `/api/tasks/${encodeURIComponent(taskId)}/workspace`,
      )) as { task: { status: string } };
      lastStatus = workspace.task.status;
      if (lastStatus === status) return;
      if (Date.now() > deadline) {
        throw new Error(`fake-recovery harness: stayed '${lastStatus}', expected '${status}'`);
      }
      await new Promise((wait) => setTimeout(wait, 100));
    }
  }

  const harness: FakeRecoveryHarness = {
    async runUntilArtifact(version: number): Promise<void> {
      port = await reserveLoopbackPort();
      const signalDir = freshRoot('forge-recovery-fake-signal-a-');
      child = await spawnRecoveryServer({
        port,
        dataRoot,
        templateRoot,
        signalDir,
        runtime: 'fake',
        fakeScriptsFile: scriptFileA,
        mode: 'test',
      });
      const created = (await http('POST', '/api/tasks', {
        templateId: FIXTURE_TEMPLATE_ID,
        name: '恢复验收 fixture 任务',
        input: { [FIXTURE_INPUT_FIELD_ID]: '恢复边界验收的开场输入。' },
      })) as { id: string };
      taskId = created.id;
      await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/start`);

      // The acceptance hook stops the child itself at the confirmed boundary.
      await waitForBoundary(
        signalDir,
        (boundary) => boundary.artifacts >= version,
        30_000,
      );
      await child.stop('SIGTERM');
      await child.waitForExit();
      const projection = readRecoveryFileProjection(dataRoot, templateRoot, taskId);
      expect(projection.artifacts.map((artifact) => artifact.version)).toEqual([version]);
      child = null;
    },

    async restartServer(): Promise<void> {
      const signalDir = freshRoot('forge-recovery-fake-signal-b-');
      // Phase B runs free: the runner releases every boundary up front.
      releaseBoundary(signalDir, 'all');
      child = await spawnRecoveryServer({
        port,
        dataRoot,
        templateRoot,
        signalDir,
        runtime: 'fake',
        fakeScriptsFile: scriptFileB,
        mode: 'test',
      });
    },

    async resume(): Promise<void> {
      if (child === null) throw new Error('fake-recovery harness: restart first');
      const resumed = await fetch(
        `http://127.0.0.1:${port}/api/tasks/${encodeURIComponent(taskId)}/resume`,
        { method: 'POST' },
      );
      expect(resumed.status).toBe(202);
      await waitForStatus('completed');
    },

    artifactVersions(): number[] {
      return readRecoveryFileProjection(dataRoot, templateRoot, taskId).artifacts.map(
        (artifact) => artifact.version,
      );
    },

    finalStatus(): string {
      return lastStatus;
    },

    fileProjection() {
      return readRecoveryFileProjection(dataRoot, templateRoot, taskId);
    },

    dispose(): void {
      if (child !== null) {
        void child.stop('SIGKILL').catch(() => undefined);
        child = null;
      }
    },
  };
  openHarnesses.add(harness);
  return harness;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe('fake recovery orchestration (plan Phase D Task 4 Step 1 verbatim)', () => {
  it('restarts after a confirmed artifact without duplicating the version', async () => {
    const harness = fakeRecoveryAcceptanceHarness();
    await harness.runUntilArtifact(1);
    await harness.restartServer();
    await harness.resume();
    expect(harness.artifactVersions()).toEqual([1, 2]);
    expect(harness.finalStatus()).toBe('completed');

    // No duplicate version, no duplicate or gapped events across the restart.
    const projection = harness.fileProjection();
    const ids = projection.events.map((entry) => entry.event.id);
    expect(new Set(ids).size).toBe(ids.length);
    projection.events.forEach((entry, index) => {
      expect(entry.sequence, `event sequence at ${entry.fileName}`).toBe(index + 1);
    });
    expect(
      projection.events.filter((entry) => entry.event.type === 'artifact_published'),
    ).toHaveLength(2);
    expect(
      projection.events.filter((entry) => entry.event.type === 'final_submission_accepted'),
    ).toHaveLength(1);
    expect(
      projection.events.some((entry) => entry.event.type === 'task_interrupted'),
    ).toBe(true);
    expect(
      projection.events.some((entry) => entry.event.type === 'task_resumed'),
    ).toBe(true);
  }, 180_000);

  it('pauses at the confirmed artifact boundary before the next Agent is scheduled', async () => {
    const dataRoot = freshRoot('forge-recovery-boundary-data-');
    const templateRoot = freshRoot('forge-recovery-boundary-templates-');
    const scriptDir = freshRoot('forge-recovery-boundary-scripts-');
    installFixtureTemplate(templateRoot);
    const scriptFile = join(scriptDir, 'scripts.json');
    // Beta would complete the task instantly IF it were ever scheduled.
    writeScripts(scriptFile, {
      ...phaseAScripts(),
      'agent-beta': [
        {
          kind: 'result',
          publicText: '直接提交。',
          actions: [
            { type: 'annotate_artifact', file: 'review.md', content: '---\nverdict: pass\n---\n通过。' },
            { type: 'submit_final_artifact' },
          ],
        },
      ],
    });
    const port = await reserveLoopbackPort();
    const signalDir = freshRoot('forge-recovery-boundary-signal-');
    const child = await spawnRecoveryServer({
      port,
      dataRoot,
      templateRoot,
      signalDir,
      runtime: 'fake',
      fakeScriptsFile: scriptFile,
      mode: 'test',
    });
    try {
      const created = (await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: FIXTURE_TEMPLATE_ID,
          name: '边界验收任务',
          input: { [FIXTURE_INPUT_FIELD_ID]: '边界验收输入。' },
        }),
      }).then((response) => response.json())) as { id: string };
      await fetch(`http://127.0.0.1:${port}/api/tasks/${encodeURIComponent(created.id)}/start`, {
        method: 'POST',
      });

      const boundary = await waitForBoundary(signalDir, (record) => record.artifacts >= 1, 30_000);
      expect(boundary.artifacts).toBe(1);

      // Still serving at the boundary — observe the frozen state over HTTP.
      const workspace = (await fetch(
        `http://127.0.0.1:${port}/api/tasks/${encodeURIComponent(created.id)}/workspace`,
      ).then((response) => response.json())) as {
        task: { status: string };
        artifacts: Array<{ version: number }>;
        nodes: Array<{ agentId: string; kind: string }>;
      };
      expect(workspace.task.status).toBe('running');
      expect(workspace.artifacts.map((artifact) => artifact.version)).toEqual([1]);
      // Beta owns a confirmed hand-off input but NEVER ran a Turn: the hook
      // paused the loop strictly before the next Agent was scheduled.
      expect(
        workspace.nodes.some((node) => node.agentId === 'agent-beta' && node.kind === 'input'),
      ).toBe(true);
      expect(
        workspace.nodes.some((node) => node.agentId === 'agent-beta' && node.kind === 'result'),
      ).toBe(false);

      // Graceful termination exits clean (server-side shutdown path).
      await child.stop('SIGTERM');
      await child.waitForExit();
      expect(child.exitInfo().code).toBe(0);
    } finally {
      await child.stop('SIGKILL').catch(() => undefined);
    }
  }, 120_000);
});

/* -------------------------------------------------------------------------- */
/* Full CLI flow through injected process-harness seams (no real tokens)       */
/* -------------------------------------------------------------------------- */

function fakeModelRuntime(overrides: { auth?: boolean } = {}): PreflightModelRuntime {
  return {
    getProvider: () => ({ id: 'deepseek' }),
    getModel: (_providerId: string, modelId: string) => {
      if (modelId === 'writer-model-id' || modelId === 'reviewer-model-id') {
        return { id: modelId };
      }
      return undefined;
    },
    hasConfiguredAuth: () => overrides.auth ?? true,
  };
}

/** A screenshot session recorder standing in for the Playwright default. */
function recordingScreenshotSession(): {
  session: RecoveryScreenshotSession;
  calls: string[];
} {
  const calls: string[] = [];
  const taken: ScreenshotEntry[] = [];
  const record = (name: string, width: number, height: number): void => {
    calls.push(name);
    taken.push({ name, width, height });
  };
  const session: RecoveryScreenshotSession = {
    async templateDetail() {
      record('template-detail.png', 1440, 1000);
    },
    async taskList() {
      record('task-list.png', 1440, 1000);
    },
    async productionAfterV1() {
      record('production-after-v1.png', 1440, 1000);
    },
    async productionAfterReturn() {
      record('production-after-review-return.png', 1440, 1000);
    },
    async productionCompleted() {
      record('production-completed-final-preview.png', 1440, 1000);
      return null;
    },
    async developmentProgress() {
      record('development-progress.png', 1440, 1000);
    },
    async productionCompletedMobile() {
      record('production-completed-mobile.png', 390, 844);
    },
    taken: () => taken,
    async close() {
      calls.push('closed');
    },
  };
  return { session, calls };
}

function makeRecoveryCliEnv(): {
  repoRoot: string;
  inputPath: string;
  dataRoot: string;
  reportPath: string;
  screenshotDir: string;
  argv: string[];
} {
  const envRoot = freshRoot('forge-recovery-env-');
  const repoRoot = join(envRoot, 'repo');
  mkdirSync(join(repoRoot, 'templates'), { recursive: true });
  cpSync(
    committedZhihuTemplateDir(),
    join(repoRoot, 'templates', ACCEPTANCE_TEMPLATE_ID),
    { recursive: true },
  );
  const inputPath = join(envRoot, 'input.json');
  cpSync(join(committedZhihuTemplateDir(), 'input.example.json'), inputPath);
  const dataRoot = join(envRoot, 'recovery-data');
  const reportPath = join(envRoot, 'recovery-report.json');
  const screenshotDir = join(envRoot, 'screenshots');
  const argv = [
    '--provider',
    'deepseek',
    '--writer-model',
    'writer-model-id',
    '--reviewer-model',
    'reviewer-model-id',
    '--input',
    inputPath,
    '--data-root',
    dataRoot,
    '--report',
    reportPath,
  ];
  return { repoRoot, inputPath, dataRoot, reportPath, screenshotDir, argv };
}

/**
 * Injected spawner: the same child-process lifecycle with the fake runtime.
 * The first spawn carries phase A scripts; the second (restart) carries the
 * phase B continuation — exactly the runner's interrupt/restart shape.
 */
function fakePhaseSpawner(scriptDir: string, spawnCalls: Array<Record<string, unknown>>) {
  let spawnCount = 0;
  return async (options: {
    port: number;
    dataRoot: string;
    templateRoot: string;
    signalDir: string;
  }) => {
    spawnCount += 1;
    const fakeScriptsFile = join(scriptDir, `phase-${spawnCount}.json`);
    writeScripts(
      fakeScriptsFile,
      spawnCount === 1 ? recoveryCliPhaseAScripts() : recoveryCliPhaseBScripts(),
    );
    const handle = await spawnRecoveryServer({
      ...options,
      runtime: 'fake',
      fakeScriptsFile,
      mode: 'test',
    });
    spawnCalls.push({ spawnCount, signalDir: options.signalDir });
    return handle;
  };
}

/** Writer/reviewer-keyed scripts matching the committed acceptance template. */
function recoveryCliPhaseAScripts(): Record<string, unknown> {
  return {
    writer: [
      {
        kind: 'result',
        publicText: '初稿已完成并交付审核。',
        workspaceWrites: [{ path: 'draft/chapter.md', content: '# 初稿\n\n第一版正文。' }],
        actions: [
          {
            type: 'finish_production',
            source: 'workspace_file',
            files: [{ name: 'content.md', workspaceFile: 'draft/chapter.md' }],
            format: 'markdown',
            artifactType: 'chapter_markdown',
            title: '初稿',
          },
          { type: 'publish_artifact' },
        ],
      },
    ],
  };
}

function recoveryCliPhaseBScripts(): Record<string, unknown> {
  return {
    reviewer: [
      {
        kind: 'result',
        publicText: '初稿需要返修。',
        actions: [
          {
            type: 'annotate_artifact',
            file: 'review.md',
            content: '---\nverdict: reject\n---\n请修复问题后重新发布完整稿件。',
          },
          {
            type: 'send_message',
            targetAgentId: 'writer',
            summary: '初稿需要返修。',
          },
        ],
      },
      {
        kind: 'result',
        publicText: '复审通过，申请系统最终交付。',
        actions: [
          { type: 'annotate_artifact', file: 'review.md', content: '---\nverdict: pass\n---\n复审通过。' },
          { type: 'submit_final_artifact' },
        ],
      },
    ],
    writer: [
      {
        kind: 'result',
        publicText: '已按返修意见重写完整稿件。',
        workspaceWrites: [
          { path: 'draft/chapter.md', content: '# 修订稿\n\n修订后的完整正文。' },
        ],
        actions: [
          {
            type: 'finish_production',
            source: 'workspace_file',
            files: [{ name: 'content.md', workspaceFile: 'draft/chapter.md' }],
            format: 'markdown',
            artifactType: 'chapter_markdown',
            title: '修订稿',
          },
          { type: 'publish_artifact' },
        ],
      },
    ],
  };
}

function passingRecoveryDeps(
  env: ReturnType<typeof makeRecoveryCliEnv>,
  recorder: ReturnType<typeof recordingScreenshotSession>,
  extra: Partial<RecoveryCliDeps> = {},
): RecoveryCliDeps {
  const scriptDir = freshRoot('forge-recovery-cli-scripts-');
  const spawnCalls: Array<Record<string, unknown>> = [];
  return {
    repoRoot: env.repoRoot,
    loadEnv: () => undefined,
    createModelRuntime: async () => fakeModelRuntime(),
    runBoundaryProbe: async () => 0,
    reservePort: reserveLoopbackPort,
    spawnServer: fakePhaseSpawner(scriptDir, spawnCalls),
    deadlineMs: 90_000,
    pollIntervalMs: 100,
    createScreenshotSession: async () => recorder.session,
    ...extra,
  };
}

describe('recovery acceptance CLI (public operations only)', () => {
  it('drives interrupt -> restart -> resume to a sanitized completed report', async () => {
    const env = makeRecoveryCliEnv();
    const recorder = recordingScreenshotSession();
    const result = await runRecoveryAcceptanceCli(env.argv, passingRecoveryDeps(env, recorder));

    expect(result.exitCode).toBe(0);
    expect(result.startedServer).toBe(true);
    expect(result.reportPath).toBe(env.reportPath);

    const report = JSON.parse(readFileSync(env.reportPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(report).sort()).toEqual([...RECOVERY_REPORT_KEYS].sort());
    expect(report.schemaVersion).toBe('forge-core.real-recovery-acceptance/1');
    expect(report.outcome).toBe('completed');
    expect(report.taskStatus).toBe('completed');
    expect(report.restartCount).toBe(1);
    expect(report.interruptedObserved).toBe(true);
    expect(report.executedRouteKinds).toEqual({ artifact: 2, message: 1 });
    const versions = report.artifactVersions as Array<Record<string, unknown>>;
    expect(versions.map((entry) => entry.version)).toEqual([1, 2]);
    expect(report.finalArtifactVersion).toBe(2);
    const reconciliation = report.reconciliation as Record<string, unknown>;
    expect(reconciliation.mismatchCount).toBe(0);
    expect(report.publicErrorCodes).toEqual([]);
    expect(report.secretFindingCount).toBe(0);
    expect(report.hiddenThinkingFindingCount).toBe(0);
    const screenshots = report.screenshots as Array<Record<string, unknown>>;
    expect(screenshots.map((entry) => entry.name)).toEqual([
      'template-detail.png',
      'task-list.png',
      'production-after-v1.png',
      'production-after-review-return.png',
      'production-completed-final-preview.png',
      'development-progress.png',
      'production-completed-mobile.png',
    ]);
    // The recorder session captured every required stage.
    expect(recorder.calls).toContain('production-after-v1.png');
    expect(recorder.calls).toContain('production-after-review-return.png');
    expect(recorder.calls).toContain('closed');
  }, 240_000);

  it('rejects missing arguments before constructing any server', async () => {
    const result = await runRecoveryAcceptanceCli(['--provider', 'configured']);
    expect(result.exitCode).toBe(2);
    expect(result.startedServer).toBe(false);
  });

  it('refuses a non-fresh data root before the server phase', async () => {
    const env = makeRecoveryCliEnv();
    const recorder = recordingScreenshotSession();
    mkdirSync(env.dataRoot, { recursive: true });
    writeFileSync(join(env.dataRoot, 'leftover.json'), '{}', 'utf8');
    const result = await runRecoveryAcceptanceCli(env.argv, passingRecoveryDeps(env, recorder));
    expect(result.exitCode).toBe(2);
    expect(result.startedServer).toBe(false);
    expect(result.reason).toBe('DATA_ROOT_NOT_FRESH');
  });

  it('refuses an existing report path before the server phase', async () => {
    const env = makeRecoveryCliEnv();
    const recorder = recordingScreenshotSession();
    writeFileSync(env.reportPath, '{"previous":"run"}', 'utf8');
    const result = await runRecoveryAcceptanceCli(env.argv, passingRecoveryDeps(env, recorder));
    expect(result.exitCode).toBe(2);
    expect(result.startedServer).toBe(false);
    expect(result.reason).toBe('REPORT_EXISTS');
  });

  it('fails preflight when a model cannot be resolved', async () => {
    const env = makeRecoveryCliEnv();
    const recorder = recordingScreenshotSession();
    const result = await runRecoveryAcceptanceCli(
      env.argv.map((value) => (value === 'reviewer-model-id' ? 'unknown-model' : value)),
      passingRecoveryDeps(env, recorder),
    );
    expect(result.exitCode).toBe(2);
    expect(result.startedServer).toBe(false);
    expect(result.reason).toBe('MODEL_UNRESOLVABLE');
  });
});

/* -------------------------------------------------------------------------- */
/* Report shape                                                                */
/* -------------------------------------------------------------------------- */

describe('recovery report sanitization', () => {
  it('never carries artifact prose into the report', async () => {
    const env = makeRecoveryCliEnv();
    const recorder = recordingScreenshotSession();
    const result = await runRecoveryAcceptanceCli(env.argv, passingRecoveryDeps(env, recorder));
    expect(result.exitCode).toBe(0);
    const serialized = readFileSync(env.reportPath, 'utf8');
    expect(serialized).not.toContain('第一版正文');
    expect(serialized).not.toContain('修订后的完整正文');
    const report = JSON.parse(serialized) as Record<string, unknown>;
    for (const entry of report.artifactVersions as Array<{ contentHash: string }>) {
      expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect((report.taskId as string).length).toBeLessThanOrEqual(12);
  }, 240_000);
});

/* Keep linters honest about the imports the red phase needs. */
void createHash;
void existsSync;
void readdirSync;
void CorePaths;
