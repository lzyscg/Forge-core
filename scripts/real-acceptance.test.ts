// @vitest-environment node
/**
 * Real Provider acceptance runner (plan Phase D Task 2 Step 1).
 *
 * Pins the runner contract BEFORE any implementation exists:
 *
 * - missing/unknown CLI arguments exit with code 2 before ANY server is
 *   constructed (plan Step 1 verbatim case), and a real child-process
 *   recorder proves the same ordering in the spawned script itself;
 * - every strict-preflight failure branch (input JSON, committed template
 *   source, fresh empty data root, report path, Provider/model resolution
 *   through ModelRuntime, credential availability, Phase C boundary probe)
 *   exits 2 with a public reason slug and `startedServer: false`;
 * - the acceptance-only template copy replaces ONLY the two committed model
 *   scalars and never touches the committed template files;
 * - the sanitized report carries exactly the declared field set and never
 *   prompts, raw messages, complete prose, headers or environment values;
 * - a full loop driven exclusively through the public HTTP surface
 *   (reload -> create -> start -> poll workspace) completes and writes an
 *   atomic sanitized report.
 *
 * The recorder and the `reportWithSentinels`-style fixtures live in this
 * file (plan Step 1); the runner module under test exposes `runAcceptanceCli`
 * with injectable seams (ModelRuntime factory, probe runner, server
 * spawner), exactly like the Phase C runtime adapters.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreService } from '../src/server/core-service';
import { createForgeCoreServer, type ForgeCoreServer } from '../src/server/http-server';
import { FakeAgentRuntime } from '../src/server/runtime/fake-agent-runtime';
import type { ForgeAction } from '../src/server/runtime/forge-actions';
import { CorePaths } from '../src/server/storage/core-paths';
import { loadTemplateDirectory } from '../src/server/template/template-loader';
import type { TaskWorkspace } from '../src/shared/contracts';
import {
  ACCEPTANCE_REPORT_KEYS,
  ACCEPTANCE_TEMPLATE_ID,
  buildAcceptanceTemplateCopy,
  buildSanitizedReport,
  parseAcceptanceArgs,
  runAcceptanceCli,
  SERVER_START_MARKER,
  type AcceptanceCliDeps,
  type AcceptanceReportFacts,
  type PreflightModelRuntime,
} from './real-acceptance';

/* -------------------------------------------------------------------------- */
/* Locations and fixtures                                                      */
/* -------------------------------------------------------------------------- */

/** apps/forge-core (this file lives in apps/forge-core/scripts). */
function workspaceRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

/** The committed self-contained acceptance template (plan Phase D Task 1). */
function committedZhihuTemplateDir(): string {
  return resolve(workspaceRoot(), '..', '..', 'forge-core', 'templates', ACCEPTANCE_TEMPLATE_ID);
}

/** Locates the hoisted tsx CLI script by walking up from the workspace root. */
function tsxBinary(): string {
  let dir = workspaceRoot();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (existsSync(candidate)) {
      return candidate;
    }
    dir = dirname(dir);
  }
  throw new Error('real-acceptance.test: no node_modules/tsx/dist/cli.mjs found above the workspace');
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
});

/**
 * A self-contained preflight environment: a fixture repo root carrying a copy
 * of the committed template, a valid input file, a fresh (non-existent) data
 * root and a fresh report path. Everything before the ModelRuntime check can
 * succeed here, so individual injected failures isolate one branch each.
 */
function makePreflightEnv(): {
  repoRoot: string;
  inputPath: string;
  dataRoot: string;
  reportPath: string;
  argv: string[];
} {
  const envRoot = freshRoot('forge-acceptance-env-');
  const repoRoot = join(envRoot, 'repo');
  mkdirSync(join(repoRoot, 'forge-core', 'templates'), { recursive: true });
  cpSync(
    committedZhihuTemplateDir(),
    join(repoRoot, 'forge-core', 'templates', ACCEPTANCE_TEMPLATE_ID),
    { recursive: true },
  );
  const inputPath = join(envRoot, 'input.json');
  cpSync(join(committedZhihuTemplateDir(), 'input.example.json'), inputPath);
  const dataRoot = join(envRoot, 'acceptance-data');
  const reportPath = join(envRoot, 'report.json');
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
  return { repoRoot, inputPath, dataRoot, reportPath, argv };
}

/** A ModelRuntime stub whose individual answers each test can pin. */
function fakeModelRuntime(overrides: {
  provider?: unknown;
  writerModel?: unknown;
  reviewerModel?: unknown;
  auth?: boolean;
} = {}): PreflightModelRuntime {
  return {
    getProvider: () => ('provider' in overrides ? overrides.provider : { id: 'deepseek' }),
    getModel: (_providerId: string, modelId: string) => {
      if (modelId === 'writer-model-id') {
        return 'writerModel' in overrides ? overrides.writerModel : { id: modelId };
      }
      if (modelId === 'reviewer-model-id') {
        return 'reviewerModel' in overrides ? overrides.reviewerModel : { id: modelId };
      }
      return undefined;
    },
    hasConfiguredAuth: () => overrides.auth ?? true,
  };
}

/** Dependencies that carry the CLI past every preflight gate into the server phase. */
function passingDeps(repoRoot: string, extra: Partial<AcceptanceCliDeps> = {}): AcceptanceCliDeps {
  return {
    repoRoot,
    loadEnv: () => undefined,
    createModelRuntime: async () => fakeModelRuntime(),
    runBoundaryProbe: async () => 0,
    ...extra,
  };
}

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function hashDirRecursive(dir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        // Forward-slash keys keep the comparison platform-neutral.
        hashes[relative(dir, full).split(sep).join('/')] = sha256Hex(readFileSync(full));
      }
    }
  };
  walk(dir);
  return hashes;
}

/* -------------------------------------------------------------------------- */
/* Process-spawn recorder (plan Step 1): proves the REAL script exits in the   */
/* preflight phase before any server construction marker can be emitted.       */
/* -------------------------------------------------------------------------- */

interface CliRecording {
  exitCode: number | null;
  output: string;
}

function recordCliRun(argv: readonly string[]): Promise<CliRecording> {
  return new Promise((resolveRecord, rejectRecord) => {
    const child = spawn(process.execPath, [tsxBinary(), 'scripts/real-acceptance.ts', ...argv], {
      cwd: workspaceRoot(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRecord(new Error('real-acceptance recorder: child did not exit within 90s'));
    }, 90_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectRecord(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveRecord({ exitCode: code, output });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* In-process fake server for the full-loop drive (public HTTP surface only)   */
/* -------------------------------------------------------------------------- */

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createNetServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        rejectPort(new Error('real-acceptance.test: the port probe did not report an address'));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

const CHAPTER_DRAFT_PATH = 'draft/chapter.md';

/** Seals the drafted workspace file as the production package. */
function finishChapter(title: string): ForgeAction {
  return {
    type: 'finish_production',
    source: 'workspace_file',
    workspaceFile: CHAPTER_DRAFT_PATH,
    format: 'markdown',
    artifactType: 'chapter_markdown',
    title,
  };
}

/** The deterministic V1 -> reviewer return -> V2 -> system final loop. */
function fullLoopScripts(): Record<string, Array<{ kind: 'result'; publicText: string; actions: ForgeAction[]; workspaceWrites?: Array<{ path: string; content: string }> }>> {
  return {
    writer: [
      {
        kind: 'result',
        publicText: '初稿已完成并交付审核。',
        workspaceWrites: [{ path: CHAPTER_DRAFT_PATH, content: '# 初稿\n\n第一版正文。' }],
        actions: [
          { type: 'load_skill', skillId: 'chapter-drafting' },
          finishChapter('初稿'),
          { type: 'publish_artifact', productionPackageRef: 'current' },
        ],
      },
      {
        kind: 'result',
        publicText: '已按返修意见重写完整稿件。',
        workspaceWrites: [
          { path: CHAPTER_DRAFT_PATH, content: '# 修订稿\n\n根据返修意见修订后的完整正文。' },
        ],
        actions: [
          finishChapter('修订稿'),
          { type: 'publish_artifact', productionPackageRef: 'current' },
        ],
      },
    ],
    reviewer: [
      {
        kind: 'result',
        publicText: '初稿需要返修。',
        actions: [
          { type: 'load_skill', skillId: 'chapter-review' },
          {
            type: 'finish_production',
            source: 'inline',
            content: '请修复两个问题后重新发布完整稿件。',
            format: 'text',
            artifactType: null,
            title: null,
          },
          {
            type: 'send_message',
            targetAgentId: 'writer',
            productionPackageRef: 'current',
          },
        ],
      },
      {
        kind: 'result',
        publicText: '复审通过，申请系统最终交付。',
        actions: [
          { type: 'finish_production', source: 'current_input_artifact' },
          { type: 'submit_final_artifact', productionPackageRef: 'current' },
        ],
      },
    ],
  };
}

/** Boots an in-process API server over the runner-prepared roots. */
async function startFakeLoopServer(options: {
  port: number;
  dataRoot: string;
  templateRoot: string;
}): Promise<{ url: string; stop(): Promise<void> }> {
  const paths = CorePaths.create({ dataRoot: options.dataRoot, templateRoot: options.templateRoot });
  const service = new CoreService(paths, {
    runtime: new FakeAgentRuntime({ scripts: fullLoopScripts() }),
  });
  await service.initialize();
  const server: ForgeCoreServer = await createForgeCoreServer({
    mode: 'test',
    dataRoot: options.dataRoot,
    templateRoot: options.templateRoot,
    coreService: service,
  });
  const url = await server.listen(options.port);
  return { url, stop: () => server.close() };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe('real acceptance CLI arguments', () => {
  it('rejects missing explicit data root or model IDs before starting a server', async () => {
    const result = await runAcceptanceCli(['--provider', 'configured']);
    expect(result.exitCode).toBe(2);
    expect(result.startedServer).toBe(false);
  });

  it('parses exactly the six required flags and refuses unknown ones', () => {
    const parsed = parseAcceptanceArgs([
      '--provider',
      'deepseek',
      '--writer-model',
      'w',
      '--reviewer-model',
      'r',
      '--input',
      '/tmp/in.json',
      '--data-root',
      '/tmp/data',
      '--report',
      '/tmp/report.json',
    ]);
    expect(parsed).toEqual({
      provider: 'deepseek',
      writerModel: 'w',
      reviewerModel: 'r',
      input: '/tmp/in.json',
      dataRoot: '/tmp/data',
      report: '/tmp/report.json',
    });
    // Every single flag is mandatory.
    expect(
      parseAcceptanceArgs(['--provider', 'p', '--writer-model', 'w', '--reviewer-model', 'r']),
    ).toBeNull();
    // Unknown flags are rejected outright...
    expect(parseAcceptanceArgs(['--unknown', 'x'])).toBeNull();
    // ...including any attempt to hand credentials over as CLI arguments:
    // auth may only ever come from the environment/ModelRuntime.
    expect(
      parseAcceptanceArgs([
        '--provider',
        'p',
        '--writer-model',
        'w',
        '--reviewer-model',
        'r',
        '--input',
        'i',
        '--data-root',
        'd',
        '--report',
        'rp',
        '--api-key',
        'sk-never-accepted',
      ]),
    ).toBeNull();
  });

  it('exits 2 in a real child process before any server construction marker', async () => {
    const recording = await recordCliRun(['--provider', 'configured']);
    expect(recording.exitCode).toBe(2);
    expect(recording.output).toContain('usage:');
    expect(recording.output).not.toContain(SERVER_START_MARKER);
  }, 120_000);
});

describe('real acceptance strict preflight', () => {
  it('refuses an unreadable, unparseable or non-string input file before anything else', async () => {
    const env = makePreflightEnv();
    const missing = await runAcceptanceCli(
      env.argv.map((value) => (value === env.inputPath ? join(env.repoRoot, 'no-such-input.json') : value)),
      passingDeps(env.repoRoot),
    );
    expect(missing.exitCode).toBe(2);
    expect(missing.startedServer).toBe(false);
    expect(missing.reason).toBe('INPUT_INVALID');

    writeFileSync(env.inputPath, '{ this is not json', 'utf8');
    const malformed = await runAcceptanceCli(env.argv, passingDeps(env.repoRoot));
    expect(malformed.exitCode).toBe(2);
    expect(malformed.reason).toBe('INPUT_INVALID');

    writeFileSync(env.inputPath, JSON.stringify({ requirements: 42 }), 'utf8');
    const nonString = await runAcceptanceCli(env.argv, passingDeps(env.repoRoot));
    expect(nonString.exitCode).toBe(2);
    expect(nonString.reason).toBe('INPUT_INVALID');
  });

  it('checks the input before the data root (strict order)', async () => {
    const env = makePreflightEnv();
    // Both the input AND the data root are invalid; the input gate fires first.
    mkdirSync(env.dataRoot, { recursive: true });
    writeFileSync(join(env.dataRoot, 'leftover.json'), '{}', 'utf8');
    writeFileSync(env.inputPath, 'not json at all', 'utf8');
    const result = await runAcceptanceCli(env.argv, passingDeps(env.repoRoot));
    expect(result.exitCode).toBe(2);
    expect(result.reason).toBe('INPUT_INVALID');
  });

  it('refuses a missing committed template source', async () => {
    const env = makePreflightEnv();
    rmSync(join(env.repoRoot, 'forge-core', 'templates', ACCEPTANCE_TEMPLATE_ID), {
      recursive: true,
      force: true,
    });
    const result = await runAcceptanceCli(env.argv, passingDeps(env.repoRoot));
    expect(result.exitCode).toBe(2);
    expect(result.startedServer).toBe(false);
    expect(result.reason).toBe('TEMPLATE_SOURCE_MISSING');
  });

  it('requires a brand-new empty data root and a fresh report path', async () => {
    const env = makePreflightEnv();

    mkdirSync(env.dataRoot, { recursive: true });
    writeFileSync(join(env.dataRoot, 'leftover-task.json'), '{}', 'utf8');
    const dirty = await runAcceptanceCli(env.argv, passingDeps(env.repoRoot));
    expect(dirty.exitCode).toBe(2);
    expect(dirty.startedServer).toBe(false);
    expect(dirty.reason).toBe('DATA_ROOT_NOT_FRESH');
    rmSync(env.dataRoot, { recursive: true, force: true });

    writeFileSync(env.dataRoot, 'a file where the data root should be', 'utf8');
    const notDir = await runAcceptanceCli(env.argv, passingDeps(env.repoRoot));
    expect(notDir.exitCode).toBe(2);
    expect(notDir.reason).toBe('DATA_ROOT_NOT_FRESH');
    rmSync(env.dataRoot, { force: true });

    writeFileSync(env.reportPath, '{"previous":"run"}', 'utf8');
    const reportExists = await runAcceptanceCli(env.argv, passingDeps(env.repoRoot));
    expect(reportExists.exitCode).toBe(2);
    expect(reportExists.startedServer).toBe(false);
    expect(reportExists.reason).toBe('REPORT_EXISTS');
  });

  it('verifies provider, both models and credential availability through ModelRuntime', async () => {
    const env = makePreflightEnv();

    const noProvider = await runAcceptanceCli(
      env.argv,
      passingDeps(env.repoRoot, {
        createModelRuntime: async () => fakeModelRuntime({ provider: undefined }),
      }),
    );
    expect(noProvider.exitCode).toBe(2);
    expect(noProvider.startedServer).toBe(false);
    expect(noProvider.reason).toBe('PROVIDER_UNRESOLVABLE');

    const noWriter = await runAcceptanceCli(
      env.argv,
      passingDeps(env.repoRoot, {
        createModelRuntime: async () => fakeModelRuntime({ writerModel: undefined }),
      }),
    );
    expect(noWriter.exitCode).toBe(2);
    expect(noWriter.reason).toBe('MODEL_UNRESOLVABLE');

    const noReviewer = await runAcceptanceCli(
      env.argv,
      passingDeps(env.repoRoot, {
        createModelRuntime: async () => fakeModelRuntime({ reviewerModel: undefined }),
      }),
    );
    expect(noReviewer.exitCode).toBe(2);
    expect(noReviewer.reason).toBe('MODEL_UNRESOLVABLE');

    const noAuth = await runAcceptanceCli(
      env.argv,
      passingDeps(env.repoRoot, {
        createModelRuntime: async () => fakeModelRuntime({ auth: false }),
      }),
    );
    expect(noAuth.exitCode).toBe(2);
    expect(noAuth.startedServer).toBe(false);
    expect(noAuth.reason).toBe('CREDENTIAL_NOT_CONFIGURED');
  });

  it('fails preflight when the Phase C boundary probe exits non-zero', async () => {
    const env = makePreflightEnv();
    let probeReport = '';
    const result = await runAcceptanceCli(env.argv, {
      repoRoot: env.repoRoot,
      loadEnv: () => undefined,
      createModelRuntime: async () => fakeModelRuntime(),
      runBoundaryProbe: async (probe) => {
        probeReport = probe.reportPath;
        return 3;
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.startedServer).toBe(false);
    expect(result.reason).toBe('BOUNDARY_PROBE_FAILED');
    // The probe report lands in the sanitized evidence tree under the repo root.
    expect(probeReport).toBe(
      join(env.repoRoot, 'forge-core-overnight', 'evidence', 'sanitized-reports', 'pi-boundary.json'),
    );
  });
});

describe('acceptance-only template copy', () => {
  it('replaces only the two model scalars and never touches the committed template', async () => {
    const dataRoot = freshRoot('forge-acceptance-copy-');
    const committedBefore = hashDirRecursive(committedZhihuTemplateDir());

    const copy = await buildAcceptanceTemplateCopy({
      committedTemplateDir: committedZhihuTemplateDir(),
      dataRoot,
      providerId: 'deepseek',
      writerModelId: 'writer-model-id',
      reviewerModelId: 'reviewer-model-id',
    });

    expect(copy.templateRoot).toBe(join(dataRoot, 'acceptance-template-source'));
    expect(copy.templateDir).toBe(join(dataRoot, 'acceptance-template-source', ACCEPTANCE_TEMPLATE_ID));

    // The copy reopens through the generic loader with the resolved models.
    const reopened = await loadTemplateDirectory(copy.templateDir);
    expect(reopened.id).toBe(ACCEPTANCE_TEMPLATE_ID);
    const writer = reopened.agents.find((agent) => agent.id === 'writer');
    const reviewer = reopened.agents.find((agent) => agent.id === 'reviewer');
    expect(writer?.model).toBe('deepseek/writer-model-id');
    expect(reviewer?.model).toBe('deepseek/reviewer-model-id');

    // Exactly the two model lines differ from the committed source; every
    // other byte of every other file is identical.
    const committedFiles = hashDirRecursive(committedZhihuTemplateDir());
    const copiedFiles = hashDirRecursive(copy.templateDir);
    expect(Object.keys(copiedFiles).sort()).toEqual(Object.keys(committedFiles).sort());
    const differing = Object.entries(copiedFiles)
      .filter(([rel, hash]) => committedFiles[rel] !== hash)
      .map(([rel]) => rel);
    expect(differing.sort()).toEqual(['agents/reviewer.yaml', 'agents/writer.yaml']);

    const writerText = readFileSync(join(copy.templateDir, 'agents/writer.yaml'), 'utf8');
    const reviewerText = readFileSync(join(copy.templateDir, 'agents/reviewer.yaml'), 'utf8');
    expect(writerText).toContain('model: deepseek/writer-model-id');
    expect(writerText).not.toContain('configured/writer-model');
    expect(reviewerText).toContain('model: deepseek/reviewer-model-id');
    expect(reviewerText).not.toContain('configured/reviewer-model');
    const committedWriter = readFileSync(
      join(committedZhihuTemplateDir(), 'agents/writer.yaml'),
      'utf8',
    );
    expect(committedWriter).toContain('model: configured/writer-model');
    // The untouched scalar neighbours survive the replacement.
    expect(writerText).toContain('systemPromptFile: prompts/writer-system.md');

    // No temporary sibling survives the copy, and the committed tree is intact.
    const sourceEntries = readdirSync(copy.templateRoot);
    expect(sourceEntries).toEqual([ACCEPTANCE_TEMPLATE_ID]);
    expect(hashDirRecursive(committedZhihuTemplateDir())).toEqual(committedBefore);
  });
});

describe('sanitized report shape', () => {
  function completedFacts(): AcceptanceReportFacts {
    const workspace: TaskWorkspace = {
      task: {
        id: 'task-0123456789abcdef',
        name: '真实提供方验收任务',
        templateId: ACCEPTANCE_TEMPLATE_ID,
        templateName: '知乎单章生产',
        status: 'completed',
        currentAgentName: null,
        latestVersion: 2,
        updatedAt: '2026-08-03T12:00:00.000Z',
        diagnostic: null,
      },
      frozenInput: { requirements: '写一章', source_material: '素材' },
      templateVersion: 'abc123def456',
      agents: [],
      declaredRoutes: [],
      nodes: [
        {
          id: 'n1',
          sequence: 1,
          agentId: 'writer',
          kind: 'input',
          title: '输入',
          body: '输入正文（不得进入报告）',
          status: 'confirmed',
          attemptCount: 1,
          artifactVersion: null,
        },
        {
          id: 'n1-t1-result',
          sequence: 2,
          agentId: 'writer',
          kind: 'result',
          title: '结果',
          body: '结果正文（不得进入报告）',
          status: 'confirmed',
          attemptCount: 1,
          artifactVersion: 1,
        },
      ],
      executedRoutes: [
        {
          id: 'r1',
          sequence: 3,
          fromNodeId: 'n1-t1-result',
          toNodeId: 'n2',
          kind: 'artifact',
          label: '提交章节稿件',
        },
        {
          id: 'r2',
          sequence: 5,
          fromNodeId: 'n3',
          toNodeId: 'n4',
          kind: 'message',
          label: '返修意见',
        },
        {
          id: 'r3',
          sequence: 7,
          fromNodeId: 'n5',
          toNodeId: 'n6',
          kind: 'artifact',
          label: '提交章节稿件',
        },
      ],
      artifacts: [
        {
          id: 'a1',
          version: 1,
          title: '初稿',
          content: '# 初稿完整正文（不得进入报告）',
          sourceNodeId: 'n1-t1-result',
          createdAt: '2026-08-03T11:50:00.000Z',
          final: false,
        },
        {
          id: 'a2',
          version: 2,
          title: '修订稿',
          content: '# 修订稿完整正文（不得进入报告）',
          sourceNodeId: 'n5',
          createdAt: '2026-08-03T11:58:00.000Z',
          final: true,
        },
      ],
      pendingHumanQuestion: null,
    };
    return {
      outcome: 'completed',
      commit: 'abcdef0123456789',
      versions: { node: 'v22.22.3', npm: '10.9.0', pi: '0.82.0' },
      providerId: 'deepseek',
      writerModelId: 'writer-model-id',
      reviewerModelId: 'reviewer-model-id',
      taskId: 'task-0123456789abcdef',
      startedAt: '2026-08-03T11:45:00.000Z',
      finishedAt: '2026-08-03T12:00:00.000Z',
      workspace,
      restartCount: 0,
      publicErrorCodes: [],
      secretFindingCount: 0,
    };
  }

  it('emits exactly the declared sanitized field set', () => {
    const report = buildSanitizedReport(completedFacts());
    expect(Object.keys(report).sort()).toEqual([...ACCEPTANCE_REPORT_KEYS].sort());
    expect(report.schemaVersion).toBe('forge-core.real-acceptance/1');
    expect(report.outcome).toBe('completed');
    expect(report.taskStatus).toBe('completed');
    expect(report.providerId).toBe('deepseek');
    expect(report.writerModelId).toBe('writer-model-id');
    expect(report.reviewerModelId).toBe('reviewer-model-id');
    // The task id is sanitized to a short prefix.
    expect(report.taskId).toBe('task-012');
    expect(report.versions).toEqual({ node: 'v22.22.3', npm: '10.9.0', pi: '0.82.0' });
    expect(report.restartCount).toBe(0);
    expect(report.publicErrorCodes).toEqual([]);
    expect(report.secretFindingCount).toBe(0);
  });

  it('derives counts, route kinds and artifact hashes without leaking prose', () => {
    const report = buildSanitizedReport(completedFacts());
    expect(report.agentCallCount).toBe(1);
    expect(report.attemptCount).toBe(1);
    expect(report.executedRouteKinds).toEqual({ artifact: 2, message: 1 });
    expect(report.artifactVersions).toEqual([
      { version: 1, contentHash: sha256Hex('# 初稿完整正文（不得进入报告）'), final: false },
      { version: 2, contentHash: sha256Hex('# 修订稿完整正文（不得进入报告）'), final: true },
    ]);
    expect(report.finalArtifactVersion).toBe(2);
    expect(report.finalArtifactHash).toBe(sha256Hex('# 修订稿完整正文（不得进入报告）'));

    const serialized = JSON.stringify(report);
    // No prompts, raw messages, complete prose, headers or environment values.
    expect(serialized).not.toContain('初稿完整正文');
    expect(serialized).not.toContain('修订稿完整正文');
    expect(serialized).not.toContain('结果正文');
    expect(serialized).not.toContain('输入正文');
    expect(serialized).not.toContain('写一章');
  });
});

describe('full acceptance loop through public operations only', () => {
  it('drives reload -> create -> start -> poll to a sanitized completed report', async () => {
    const env = makePreflightEnv();
    const committedBefore = hashDirRecursive(committedZhihuTemplateDir());
    const spawnHolder: { options: { port: number; dataRoot: string; templateRoot: string } | null } = {
      options: null,
    };

    const result = await runAcceptanceCli(env.argv, {
      repoRoot: env.repoRoot,
      loadEnv: () => undefined,
      createModelRuntime: async () => fakeModelRuntime(),
      runBoundaryProbe: async () => 0,
      reservePort: reserveLoopbackPort,
      spawnServer: async (options) => {
        spawnHolder.options = options;
        return startFakeLoopServer(options);
      },
      deadlineMs: 60_000,
      pollIntervalMs: 50,
    });

    expect(spawnHolder.options).not.toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.startedServer).toBe(true);
    expect(result.reportPath).toBe(env.reportPath);

    // The template copy replaced exactly the model scalars for the server.
    expect(spawnHolder.options?.templateRoot).toBe(join(env.dataRoot, 'acceptance-template-source'));

    const report = JSON.parse(readFileSync(env.reportPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(report).sort()).toEqual([...ACCEPTANCE_REPORT_KEYS].sort());
    expect(report.outcome).toBe('completed');
    expect(report.taskStatus).toBe('completed');
    expect(report.providerId).toBe('deepseek');
    expect(report.writerModelId).toBe('writer-model-id');
    expect(report.reviewerModelId).toBe('reviewer-model-id');
    expect(report.agentCallCount).toBe(4);
    expect(report.attemptCount).toBe(4);
    expect(report.executedRouteKinds).toEqual({ artifact: 2, message: 1 });
    const versions = report.artifactVersions as Array<Record<string, unknown>>;
    expect(versions.map((entry) => entry.version)).toEqual([1, 2]);
    for (const entry of versions) {
      expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(report.finalArtifactVersion).toBe(2);
    expect(report.finalArtifactHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.restartCount).toBe(0);
    expect(report.publicErrorCodes).toEqual([]);
    expect(report.secretFindingCount).toBe(0);
    expect(typeof report.taskId).toBe('string');
    expect((report.taskId as string).length).toBeLessThanOrEqual(12);

    // The committed template stayed untouched for the whole run.
    expect(hashDirRecursive(committedZhihuTemplateDir())).toEqual(committedBefore);
    // The data root holds the acceptance template source and the task data.
    expect(existsSync(join(env.dataRoot, 'acceptance-template-source', ACCEPTANCE_TEMPLATE_ID))).toBe(true);
    expect(existsSync(join(env.dataRoot, 'tasks'))).toBe(true);
  }, 120_000);

  it('reports server-phase failures with exit 1 after the server was started', async () => {
    const env = makePreflightEnv();
    const result = await runAcceptanceCli(env.argv, {
      repoRoot: env.repoRoot,
      loadEnv: () => undefined,
      createModelRuntime: async () => fakeModelRuntime(),
      runBoundaryProbe: async () => 0,
      reservePort: reserveLoopbackPort,
      spawnServer: async () => {
        throw new Error('boom: the server could not start');
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.startedServer).toBe(true);
  }, 60_000);
});
