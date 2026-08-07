/**
 * Fake-runtime HTTP harness for the Phase C browser gate (plan Task 6).
 *
 * Boots one development-mode core server over fresh temporary roots with a
 * SCRIPTED FakeAgentRuntime injected through the CoreService — every event
 * the loop produces is committed by the real ActionCommitter through the
 * real scheduler/runner (never hand-broadcast test events). The client
 * served at harness.url binds the HttpGateway through
 * VITE_FORGE_CORE_MODE=http, exactly like the Phase B harness.
 *
 * The harness installs its own platform-neutral two-agent fixture template
 * (`agent-alpha`/`agent-beta`): no business vocabulary enters the platform
 * modules (iron rule 1), fixture content lives only here.
 *
 * Scripted behaviors are declared as JSON-serializable step maps
 * (`JsonScriptMap`) so the SAME builders serve both the in-process harness
 * (materialized into FakeScriptStep) and the child-process recovery spec
 * (written to the file main.ts reads under FORGE_CORE_RUNTIME=fake).
 * `pause: true` marks a mid-Turn hold: the step awaits a deferred that is
 * never resolved, so the process can be killed while the Turn is in flight.
 *
 * `reconcileWithWorkspace` reads the committed event/artifact FILES directly
 * and re-derives the same counts/shapes the GET workspace projection serves:
 * node counts, route kinds, artifact versions and content hashes must agree
 * on both sides (spec §9.4 file/projection parity).
 */
import { createServer as createNetServer } from 'node:net';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskWorkspace } from '../src/shared/contracts';
import { CoreService } from '../src/server/core-service';
import { createForgeCoreServer, type ForgeCoreServer } from '../src/server/http-server';
import { CorePaths } from '../src/server/storage/core-paths';
import {
  FakeAgentRuntime,
  RuntimeFailure,
  type FakeScriptStep,
} from '../src/server/runtime/fake-agent-runtime';
import type { ForgeAction } from '../src/server/runtime/forge-actions';

const GATEWAY_MODE_ENV = 'VITE_FORGE_CORE_MODE';

export const RUNTIME_TEMPLATE_ID = 'runtime-loop-template';

export const RUNTIME_TEMPLATE_NAME = '运行时闭环验收模板';

export const RUNTIME_INPUT_FIELD_ID = 'opening-input';

/** Final-output declaration of the neutral fixture (markdown 终稿). */
export const FINAL_ARTIFACT_TYPE = '终稿';

/* -------------------------------------------------------------------------- */
/* Neutral fixture template installation                                       */
/* -------------------------------------------------------------------------- */

const FIXTURE_TEMPLATE_YAML = `# 运行时闭环验收 fixture（阶段 C Task 6，仅用于 e2e）
name: ${RUNTIME_TEMPLATE_NAME}
description: 两个平台中性 Agent 的运行时闭环验收模板。
inputFields:
  - id: ${RUNTIME_INPUT_FIELD_ID}
    label: 开场输入
    kind: textarea
    required: true
    description: 任务的初始输入内容
finalArtifact:
  name: ${FINAL_ARTIFACT_TYPE}
  format: markdown
`;

const FIXTURE_PIPELINE_YAML = `# 合法连线与最终出口（fixture 数据）
agents:
  - agent-alpha
  - agent-beta
routes:
  - from: agent-alpha
    to: agent-beta
    kind: artifact
    label: 交付产物
  - from: agent-alpha
    to: agent-beta
    kind: message
    label: 协作消息
  - from: agent-beta
    to: agent-alpha
    kind: message
    label: 返修意见
    inject:
      - version: input
        file: content.md
        as: 上一版正文
artifactSchema:
  files:
    - name: content.md
      required: true
      producer: agent-alpha
      extract: content
      phase: create
    - name: review.md
      required: false
      producer: agent-beta
      extract: review
      phase: annotate
finalOutput:
  submitters:
    - agent-beta
`;

const FIXTURE_AGENT_ALPHA_YAML = `id: agent-alpha
name: 执行 Agent Alpha
description: 运行时闭环验收的第一位平台中性 Agent。
model: deepseek/deepseek-chat
systemPrompt: |
  你是运行时闭环验收的执行 Agent Alpha（fixture 数据，仅用于测试）。
skills:
  - id: alpha-skill
    name: Alpha 技能
    description: 用于验证 load_skill 的中性技能。
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
description: 运行时闭环验收的第二位平台中性 Agent。
model: deepseek/deepseek-chat
systemPrompt: |
  你是运行时闭环验收的执行 Agent Beta（fixture 数据，仅用于测试）。
skills:
  - id: beta-skill
    name: Beta 技能
    description: Agent Beta 的中性技能。
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

export const FIXTURE_SKILL_ALPHA = `# Alpha 技能

用于验证 load_skill 的中性技能内容。
`;

const FIXTURE_SKILL_BETA = `# Beta 技能

Agent Beta 的中性技能内容。
`;

/** Writes the neutral two-agent fixture into a template root. */
export function installRuntimeFixtureTemplate(templateRoot: string): void {
  const root = join(templateRoot, RUNTIME_TEMPLATE_ID);
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, 'skills', 'alpha-skill'), { recursive: true });
  mkdirSync(join(root, 'skills', 'beta-skill'), { recursive: true });
  writeFileSync(join(root, 'template.yaml'), FIXTURE_TEMPLATE_YAML, 'utf8');
  writeFileSync(join(root, 'pipeline.yaml'), FIXTURE_PIPELINE_YAML, 'utf8');
  writeFileSync(join(root, 'agents', 'agent-alpha.yaml'), FIXTURE_AGENT_ALPHA_YAML, 'utf8');
  writeFileSync(join(root, 'agents', 'agent-beta.yaml'), FIXTURE_AGENT_BETA_YAML, 'utf8');
  writeFileSync(join(root, 'skills', 'alpha-skill', 'SKILL.md'), FIXTURE_SKILL_ALPHA, 'utf8');
  writeFileSync(join(root, 'skills', 'beta-skill', 'SKILL.md'), FIXTURE_SKILL_BETA, 'utf8');
}

/* -------------------------------------------------------------------------- */
/* JSON-serializable scripted behaviors                                        */
/* -------------------------------------------------------------------------- */

export interface JsonResultStep {
  kind: 'result';
  publicText?: string;
  actions?: ForgeAction[];
  usage?: { inputTokens: number; outputTokens: number } | null;
  /** Holds the Turn in flight on a never-resolving deferred (mid-Turn kill). */
  pause?: boolean;
  /** Optional thinking step surfaced in the Turn trace (display only). */
  thinking?: string;
  /** Optional workspace writes applied through the fake runtime's sink. */
  workspaceWrites?: Array<{ path: string; content: string }>;
}

export interface JsonFailureStep {
  kind: 'failure';
  code: string;
  message?: string;
  retryable: boolean;
  pause?: boolean;
}

export type JsonScriptStep = JsonResultStep | JsonFailureStep;

export type JsonScriptMap = Record<string, JsonScriptStep[]>;

/** Seals an inline package carrying the fixture final-output declaration. */
function finishInlineAction(title: string, content: string): ForgeAction {
  return {
    type: 'finish_production',
    source: 'inline',
    files: [{ name: 'content.md', content }],
    format: 'markdown',
    artifactType: FINAL_ARTIFACT_TYPE,
    title,
  };
}

/** One legal review.md annotation (frontmatter verdict + opinion body). */
function annotateReviewAction(verdict: 'pass' | 'reject', opinion: string): ForgeAction {
  return {
    type: 'annotate_artifact',
    file: 'review.md',
    content: `---\nverdict: ${verdict}\n---\n## 意见\n${opinion}`,
  };
}

const annotateRejectAction = (opinion: string): ForgeAction => annotateReviewAction('reject', opinion);
const annotatePassAction = (opinion: string): ForgeAction => annotateReviewAction('pass', opinion);

const PUBLISH_CURRENT: ForgeAction = {
  type: 'publish_artifact',
};

const SUBMIT_CURRENT: ForgeAction = {
  type: 'submit_final_artifact',
};

/**
 * The full Fake loop on the turn contract (plan 2026-08-04): alpha seals a
 * package and publishes V1 (artifact edge auto-routes to beta); beta seals
 * an inline review and messages it back to alpha (message edge); alpha
 * publishes V2; beta seals the RECEIVED V2 artifact and submits it as the
 * system final output. Exactly one dispatch action per turn.
 */
export function fullLoopScripts(): JsonScriptMap {
  return {
    'agent-alpha': [
      {
        kind: 'result',
        publicText: '第一版已完成，交付给 Agent Beta。',
        actions: [
          { type: 'load_skill', skillId: 'alpha-skill' },
          finishInlineAction('第一版', '# 第一版\n\n初始正文。'),
          PUBLISH_CURRENT,
        ],
      },
      {
        kind: 'result',
        publicText: '第二版已完成。',
        actions: [finishInlineAction('第二版', '# 第二版\n\n修订后的正文。'), PUBLISH_CURRENT],
      },
    ],
    'agent-beta': [
      {
        kind: 'result',
        publicText: '需要返修。',
        actions: [
          annotateRejectAction('请处理第一版。'),
          {
            type: 'send_message',
            targetAgentId: 'agent-alpha',
            summary: '请处理第一版。',
          },
        ],
      },
      {
        kind: 'result',
        publicText: '提交最终产物。',
        actions: [annotatePassAction('审核通过。'), SUBMIT_CURRENT],
      },
    ],
  };
}

/** One transient failure, then completion through the same agent. */
export function transientRetryScripts(): JsonScriptMap {
  return {
    'agent-alpha': [
      { kind: 'failure', code: 'HTTP_503', retryable: true, message: 'provider unavailable' },
      {
        kind: 'result',
        publicText: '重试后完成。',
        actions: [finishInlineAction('重试后版本', '# 重试后版本\n\n正文。'), PUBLISH_CURRENT],
      },
    ],
    'agent-beta': [
      {
        kind: 'result',
        publicText: '提交最终产物。',
        actions: [annotatePassAction('审核通过。'), SUBMIT_CURRENT],
      },
    ],
  };
}

/** Exhausts the two automatic retries, then succeeds on the manual retry. */
export function manualRetryScripts(): JsonScriptMap {
  return {
    'agent-alpha': [
      { kind: 'failure', code: 'ETIMEDOUT', retryable: true, message: 'upstream timed out' },
      { kind: 'failure', code: 'HTTP_503', retryable: true, message: 'provider unavailable' },
      { kind: 'failure', code: 'ETIMEDOUT', retryable: true, message: 'upstream timed out' },
      {
        kind: 'result',
        publicText: '手动重试后完成。',
        actions: [finishInlineAction('手动重试版本', '# 手动重试版本\n\n正文。'), PUBLISH_CURRENT],
      },
    ],
    'agent-beta': [
      {
        kind: 'result',
        publicText: '提交最终产物。',
        actions: [annotatePassAction('审核通过。'), SUBMIT_CURRENT],
      },
    ],
  };
}

/** Requests one human input, then completes after the answer arrives. */
export function humanInputScripts(): JsonScriptMap {
  return {
    'agent-alpha': [
      {
        kind: 'result',
        publicText: '需要人工确认。',
        actions: [{ type: 'request_human_input', question: '请确认是否继续生产？' }],
      },
      {
        kind: 'result',
        publicText: '人工确认后完成。',
        actions: [finishInlineAction('确认后版本', '# 确认后版本\n\n正文。'), PUBLISH_CURRENT],
      },
    ],
    'agent-beta': [
      {
        kind: 'result',
        publicText: '提交最终产物。',
        actions: [annotatePassAction('审核通过。'), SUBMIT_CURRENT],
      },
    ],
  };
}

/** A malformed action set: the dispatch target is not a declared agent. */
export function malformedActionScripts(): JsonScriptMap {
  return {
    'agent-alpha': [
      {
        kind: 'result',
        publicText: '尝试一条非法路由。',
        actions: [
          finishInlineAction('非法版本', '# 非法版本\n\n正文。'),
          {
            type: 'send_message',
            targetAgentId: 'agent-gamma',
            summary: '非法路由消息。',
          },
        ],
      },
    ],
  };
}

/** One clean completion for a second task (isolation case). */
export function singleCompletionScripts(): JsonScriptMap {
  return {
    'agent-alpha': [
      {
        kind: 'result',
        publicText: '隔离验证任务完成。',
        actions: [finishInlineAction('隔离验证版本', '# 隔离验证版本\n\n正文。'), PUBLISH_CURRENT],
      },
    ],
    'agent-beta': [
      {
        kind: 'result',
        publicText: '提交最终产物。',
        actions: [annotatePassAction('审核通过。'), SUBMIT_CURRENT],
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Phase E Task 6: workspace draft -> workspaceFile publish -> final          */
/* -------------------------------------------------------------------------- */

/** Workspace-relative path alpha drafts into before publishing. */
export const WORKSPACE_DRAFT_PATH = 'draft/v1.md';

/** The scripted draft content (workspace file and published V1 must match). */
export const WORKSPACE_DRAFT_CONTENT = '# 工作区初稿\n\n这是先写入工作区、再发布的初稿正文。\n';

/** Scripted thinking sentence surfaced in the Turn trace (display only). */
export const WORKSPACE_TRACE_THINKING = '先起草，再从工作区发布。';

/**
 * One alpha Turn exercising the whole Phase E surface (plan Task E6): load
 * the declared Skill, draft into the agent workspace, seal the draft through
 * `finish_production(source: workspace_file)` (the runner resolves the file
 * to controlled content pre-commit) and publish the version; beta then
 * annotates and submits the received version as the system final output.
 */
export function workspaceTraceScripts(): JsonScriptMap {
  return {
    'agent-alpha': [
      {
        kind: 'result',
        publicText: '初稿已写入工作区并发布。',
        thinking: WORKSPACE_TRACE_THINKING,
        workspaceWrites: [{ path: WORKSPACE_DRAFT_PATH, content: WORKSPACE_DRAFT_CONTENT }],
        actions: [
          { type: 'load_skill', skillId: 'alpha-skill' },
          {
            type: 'finish_production',
            source: 'workspace_file',
            files: [{ name: 'content.md', workspaceFile: WORKSPACE_DRAFT_PATH }],
            format: 'markdown',
            artifactType: FINAL_ARTIFACT_TYPE,
            title: '工作区初稿',
          },
          PUBLISH_CURRENT,
        ],
      },
    ],
    'agent-beta': [
      {
        kind: 'result',
        publicText: '提交最终产物。',
        actions: [annotatePassAction('审核通过。'), SUBMIT_CURRENT],
      },
    ],
  };
}

/** Recovery phase 1: alpha publishes V1 (auto artifact hand-off); beta hangs mid-Turn. */
export function recoveryPhaseAScripts(): JsonScriptMap {
  return {
    'agent-alpha': [
      {
        kind: 'result',
        publicText: '第一版已完成。',
        actions: [finishInlineAction('第一版', '# 第一版\n\n初始正文。'), PUBLISH_CURRENT],
      },
    ],
    'agent-beta': [{ kind: 'result', publicText: '', pause: true }],
  };
}

/** Recovery phase 2 (after restart): beta annotates the received V1 and submits it. */
export function recoveryPhaseBScripts(): JsonScriptMap {
  return {
    'agent-beta': [
      {
        kind: 'result',
        publicText: '恢复后提交最终产物。',
        actions: [annotatePassAction('审核通过。'), SUBMIT_CURRENT],
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* In-process materialization                                                  */
/* -------------------------------------------------------------------------- */

function neverResolvingDeferred(): {
  promise: Promise<void>;
  resolve(value: void): void;
  reject(error: Error): void;
} {
  let resolve!: (value: void) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function materializeScripts(scripts: JsonScriptMap): Record<string, FakeScriptStep[]> {
  const materialized: Record<string, FakeScriptStep[]> = {};
  for (const [agentId, steps] of Object.entries(scripts)) {
    materialized[agentId] = steps.map((step): FakeScriptStep => {
      const deferred = step.pause === true ? neverResolvingDeferred() : undefined;
      if (step.kind === 'failure') {
        return {
          kind: 'failure',
          failure: new RuntimeFailure(step.code, step.message ?? step.code, step.retryable),
          ...(deferred !== undefined ? { deferred } : {}),
        };
      }
      return {
        kind: 'result',
        publicText: step.publicText ?? '',
        actions: step.actions ?? [],
        usage: step.usage ?? null,
        ...(step.thinking !== undefined ? { thinking: step.thinking } : {}),
        ...(step.workspaceWrites !== undefined ? { workspaceWrites: step.workspaceWrites } : {}),
        ...(deferred !== undefined ? { deferred } : {}),
      };
    });
  }
  return materialized;
}

/** Serializes scripted behaviors for the FORGE_CORE_FAKE_SCRIPTS file. */
export function writeFakeScriptFile(file: string, scripts: JsonScriptMap): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(scripts, null, 2)}\n`, 'utf8');
}

/* -------------------------------------------------------------------------- */
/* File-side projection reading + reconciliation                               */
/* -------------------------------------------------------------------------- */

export interface FileEventEntry {
  sequence: number;
  fileName: string;
  event: Record<string, unknown> & { id: string; type: string; at: string };
}

export interface FileArtifactEntry {
  version: number;
  id: string;
  title: string;
  format: 'markdown' | 'text';
  contentHash: string;
  content: string;
}
export interface TaskFileProjection {
  events: FileEventEntry[];
  artifacts: FileArtifactEntry[];
}

const EVENT_FILE_NAME = /^(\d{6})-([A-Za-z0-9][A-Za-z0-9._-]*)\.json$/;

const NODE_EVENT_TYPES = new Set([
  'agent_input',
  'agent_result',
  'human_requested',
  'human_answered',
  // Phase E Task 3: skill loads fold into skill nodes, so reconciliation
  // counts the event id on both sides exactly like the other node events.
  'skill_loaded',
]);

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Reads one task's committed event/artifact files directly from the roots. */
export function readTaskFileProjection(paths: CorePaths, taskId: string): TaskFileProjection {
  const events: FileEventEntry[] = readdirSync(paths.taskEventsRoot(taskId))
    .map((fileName) => {
      const match = EVENT_FILE_NAME.exec(fileName);
      if (match === null) return null;
      const raw = readFileSync(join(paths.taskEventsRoot(taskId), fileName), 'utf8');
      const event = JSON.parse(raw) as FileEventEntry['event'];
      return { sequence: Number(match[1]), fileName, event };
    })
    .filter((entry): entry is FileEventEntry => entry !== null)
    .sort((a, b) => a.sequence - b.sequence);

  const artifactsRoot = paths.taskArtifactsRoot(taskId);
  const artifacts: FileArtifactEntry[] = readdirSync(artifactsRoot)
    .filter((name) => /^v\d{3}$/.test(name))
    .map((name) => {
      const meta = JSON.parse(readFileSync(join(artifactsRoot, name, 'meta.json'), 'utf8')) as {
        id: string;
        version: number;
        title: string;
        format: 'markdown' | 'text';
      };
      const contentFile = meta.format === 'markdown' ? 'content.md' : 'content.txt';
      const content = readFileSync(join(artifactsRoot, name, contentFile), 'utf8');
      return { ...meta, contentHash: sha256Hex(content), content };
    })
    .sort((a, b) => a.version - b.version);

  return { events, artifacts };
}

export interface Reconciliation {
  nodeCount: number;
  routeKinds: string[];
  artifactVersions: number[];
  eventCount: number;
}

/**
 * Asserts the committed files and the served workspace projection agree:
 * node counts, route kinds/endpoints, artifact versions/titles/hashes and
 * event-stream integrity (contiguous sequences, unique ids). Throws with a
 * diagnostic on any mismatch.
 */
export async function reconcileFileProjectionWithWorkspace(
  paths: CorePaths,
  baseUrl: string,
  taskId: string,
): Promise<Reconciliation> {
  const projection = readTaskFileProjection(paths, taskId);
  const response = await fetch(
    `${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/workspace`,
  );
  if (!response.ok) {
    throw new Error(`runtime-harness: workspace request failed with ${response.status}`);
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

  // Nodes: every node-carrying event maps to exactly one workspace node.
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

  // Routes: same ids, kinds and endpoints on both sides.
  const fileRoutes = projection.events
    .filter((entry) => entry.event.type === 'route_executed')
    .map((entry) => {
      const route = (entry.event as unknown as { route: Record<string, unknown> }).route;
      return {
        id: entry.event.id,
        kind: String(route.kind),
        fromNodeId: String(route.fromNodeId),
        toNodeId: String(route.toNodeId),
      };
    });
  const workspaceRoutes = workspace.executedRoutes.map((route) => ({
    id: route.id,
    kind: route.kind,
    fromNodeId: route.fromNodeId,
    toNodeId: route.toNodeId,
  }));
  if (JSON.stringify(fileRoutes) !== JSON.stringify(workspaceRoutes)) {
    mismatch.push(
      `routes disagree (files=${fileRoutes.length}, workspace=${workspaceRoutes.length})`,
    );
  }

  // Artifacts: versions, titles and content hashes agree; the published
  // event hash matches the file content hash and the recomputed content hash.
  const publishedByEvent = new Map<number, string>();
  for (const entry of projection.events) {
    if (entry.event.type !== 'artifact_published') continue;
    const artifact = (entry.event as unknown as { artifact: Record<string, unknown> }).artifact;
    const files = (artifact.files as Array<{ name: string; hash: string }> | undefined) ?? [];
    const contentFile = files.find((file) => file.name === 'content.md' || file.name === 'content.txt');
    publishedByEvent.set(Number(artifact.version), String(contentFile?.hash ?? ''));
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
      mismatch.push(`artifact version disagree at index ${index}`);
    }
    if (workspaceArtifact.title !== fileArtifact.title) {
      mismatch.push(`artifact title disagree at version ${fileArtifact.version}`);
    }
    const recomputed = sha256Hex(fileArtifact.content);
    if (fileArtifact.contentHash !== recomputed) {
      mismatch.push(`artifact content hash mismatch at version ${fileArtifact.version}`);
    }
    const publishedHash = publishedByEvent.get(fileArtifact.version);
    if (publishedHash !== fileArtifact.contentHash) {
      mismatch.push(
        `artifact_published hash disagrees with file meta at version ${fileArtifact.version}`,
      );
    }
  }

  // Finality: final_submission_accepted marks exactly the served final flag.
  const finals = projection.events.filter((entry) => entry.event.type === 'final_submission_accepted');
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

  if (mismatch.length > 0) {
    throw new Error(`runtime-harness: file/workspace reconciliation failed: ${mismatch.join('; ')}`);
  }

  return {
    nodeCount: workspace.nodes.length,
    routeKinds: workspace.executedRoutes.map((route) => route.kind),
    artifactVersions: workspace.artifacts.map((artifact) => artifact.version),
    eventCount: projection.events.length,
  };
}

/* -------------------------------------------------------------------------- */
/* In-process harness                                                          */
/* -------------------------------------------------------------------------- */

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createNetServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        rejectPort(new Error('runtime-harness: the port probe did not report an address'));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

export interface RuntimeCoreHarness {
  readonly url: string;
  readonly paths: CorePaths;
  readonly coreService: CoreService;
  readonly runtime: FakeAgentRuntime;
  createTaskViaApi(name: string, input?: Record<string, string>): Promise<string>;
  postLifecycle(taskId: string, action: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  startTask(taskId: string): Promise<void>;
  getWorkspaceViaApi(taskId: string): Promise<TaskWorkspace>;
  waitForStatus(taskId: string, status: string, timeoutMs?: number): Promise<TaskWorkspace>;
  /** Replaces the scripted behaviors (resets per-agent invocation counts). */
  setScripts(scripts: JsonScriptMap): void;
  readFileProjection(taskId: string): TaskFileProjection;
  reconcileWithWorkspace(taskId: string): Promise<Reconciliation>;
  close(): Promise<void>;
}

export interface RuntimeCoreHarnessOptions {
  /** Scripted agent behaviors; defaults to the full loop. */
  scripts?: JsonScriptMap;
}

/** Boots the in-process Fake-runtime harness on one fixed loopback port. */
export async function startRuntimeCoreServer(
  options: RuntimeCoreHarnessOptions = {},
): Promise<RuntimeCoreHarness> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'forge-core-runtime-data-'));
  const templateRoot = mkdtempSync(join(tmpdir(), 'forge-core-runtime-templates-'));
  installRuntimeFixtureTemplate(templateRoot);
  const paths = CorePaths.create({ dataRoot, templateRoot });
  const port = await reserveLoopbackPort();

  const previousMode = process.env[GATEWAY_MODE_ENV];
  process.env[GATEWAY_MODE_ENV] = 'http';

  const runtime = new FakeAgentRuntime({
    scripts: materializeScripts(options.scripts ?? fullLoopScripts()),
  });
  const service = new CoreService(paths, { runtime });
  await service.initialize();
  let server: ForgeCoreServer | null = await createForgeCoreServer({
    mode: 'development',
    dataRoot,
    templateRoot,
    coreService: service,
  });
  await server.listen(port);

  let closed = false;
  const baseUrl = (): string => `http://127.0.0.1:${port}`;

  async function postLifecycle(
    taskId: string,
    action: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${baseUrl()}/api/tasks/${encodeURIComponent(taskId)}/${action}`, {
      method: 'POST',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  }

  async function getWorkspaceViaApi(taskId: string): Promise<TaskWorkspace> {
    const response = await fetch(`${baseUrl()}/api/tasks/${encodeURIComponent(taskId)}/workspace`);
    if (!response.ok) {
      throw new Error(`runtime-harness: workspace request failed with ${response.status}`);
    }
    return (await response.json()) as TaskWorkspace;
  }

  return {
    get url() {
      return baseUrl();
    },
    paths,
    coreService: service,
    runtime,

    async createTaskViaApi(name: string, input?: Record<string, string>): Promise<string> {
      const response = await fetch(`${baseUrl()}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: RUNTIME_TEMPLATE_ID,
          name,
          input: input ?? { [RUNTIME_INPUT_FIELD_ID]: '运行时闭环验收的开场输入。' },
        }),
      });
      if (!response.ok) {
        throw new Error(`runtime-harness: create task failed with ${response.status}`);
      }
      const created = (await response.json()) as { id: string };
      return created.id;
    },

    postLifecycle,

    async startTask(taskId: string): Promise<void> {
      const { status } = await postLifecycle(taskId, 'start');
      if (status !== 202) {
        throw new Error(`runtime-harness: start expected 202, saw ${status}`);
      }
    },

    getWorkspaceViaApi,

    async waitForStatus(
      taskId: string,
      status: string,
      timeoutMs = 25_000,
    ): Promise<TaskWorkspace> {
      const deadline = Date.now() + timeoutMs;
      let workspace = await getWorkspaceViaApi(taskId);
      while (workspace.task.status !== status) {
        if (Date.now() > deadline) {
          throw new Error(
            `runtime-harness: task ${taskId} stayed '${workspace.task.status}', expected '${status}'`,
          );
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        workspace = await getWorkspaceViaApi(taskId);
      }
      return workspace;
    },

    setScripts(scripts: JsonScriptMap): void {
      for (const [agentId, steps] of Object.entries(materializeScripts(scripts))) {
        runtime.setScript(agentId, steps);
      }
    },

    readFileProjection(taskId: string): TaskFileProjection {
      return readTaskFileProjection(paths, taskId);
    },

    reconcileWithWorkspace(taskId: string): Promise<Reconciliation> {
      return reconcileFileProjectionWithWorkspace(paths, baseUrl(), taskId);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (server !== null) {
        await server.close();
        server = null;
      }
      if (previousMode === undefined) delete process.env[GATEWAY_MODE_ENV];
      else process.env[GATEWAY_MODE_ENV] = previousMode;
      rmSync(dataRoot, { recursive: true, force: true });
      rmSync(templateRoot, { recursive: true, force: true });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Child-process server (process recovery)                                     */
/* -------------------------------------------------------------------------- */

export interface ScriptedChildServer {
  readonly url: string;
  readonly port: number;
  readonly dataRoot: string;
  readonly templateRoot: string;
  readonly scriptFile: string;
  readonly child: ChildProcess;
  /** SIGKILLs the child and waits for it to exit. */
  killHard(): Promise<void>;
  /** Graceful shutdown (SIGTERM) and exit wait. */
  stop(): Promise<void>;
}

export interface ScriptedChildServerOptions {
  dataRoot: string;
  templateRoot: string;
  scriptFile: string;
  port: number;
}

function workspaceRoot(): string {
  // e2e/runtime-harness.ts -> apps/forge-core
  return fileURLToPath(new URL('..', import.meta.url));
}

/**
 * Locates the hoisted tsx CLI script by walking up from the workspace root.
 * Returns the JS entry point (not the `.bin` shim): spawned through
 * `process.execPath`, which works cross-platform — Windows cannot spawn the
 * extensionless POSIX shims in `node_modules/.bin`.
 */
function tsxBinary(): string {
  let dir = workspaceRoot();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (existsSync(candidate)) {
      return candidate;
    }
    dir = dirname(dir);
  }
  throw new Error('runtime-harness: no node_modules/tsx/dist/cli.mjs found above the workspace');
}

async function waitForHttp(url: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server not up yet; keep polling until the deadline.
    }
    if (Date.now() > deadline) {
      throw new Error(`runtime-harness: ${url} did not become reachable within ${timeoutMs} ms`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveWait();
      return;
    }
    const timer = setTimeout(() => {
      rejectWait(new Error('runtime-harness: child process did not exit in time'));
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

/**
 * Spawns `tsx src/server/main.ts` as a real child process over explicit
 * temporary roots with FORGE_CORE_RUNTIME=fake and one scripted-behavior
 * file — the exact surface the process-recovery gate kills and restarts.
 */
export async function spawnScriptedCoreChild(
  options: ScriptedChildServerOptions,
): Promise<ScriptedChildServer> {
  const tsxBin = tsxBinary();
  // detached:true puts the real `node tsx/dist/cli.mjs src/server/main.ts`
  // worker into one new process group, so killHard()/stop() can signal the
  // whole tree — killing only the direct child orphans the server process
  // (it keeps holding the port and serving the pre-kill state).
  const child = spawn(process.execPath, [tsxBin, 'src/server/main.ts'], {
    cwd: workspaceRoot(),
    detached: true,
    env: {
      ...process.env,
      FORGE_CORE_DATA_ROOT: options.dataRoot,
      FORGE_CORE_TEMPLATE_ROOT: options.templateRoot,
      FORGE_CORE_PORT: String(options.port),
      FORGE_CORE_MODE: 'test',
      FORGE_CORE_RUNTIME: 'fake',
      FORGE_CORE_FAKE_SCRIPTS: options.scriptFile,
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
    await waitForHttp(`${url}/api/templates`);
  } catch (error) {
    killProcessTree(child, 'SIGKILL');
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; child output:\n${output}`,
    );
  }

  return {
    url,
    port: options.port,
    dataRoot: options.dataRoot,
    templateRoot: options.templateRoot,
    scriptFile: options.scriptFile,
    child,
    async killHard(): Promise<void> {
      killProcessTree(child, 'SIGKILL');
      await waitForExit(child);
    },
    async stop(): Promise<void> {
      killProcessTree(child, 'SIGTERM');
      await waitForExit(child).catch(() => {
        killProcessTree(child, 'SIGKILL');
        return waitForExit(child);
      });
    },
  };
}

/**
 * Signals the child's whole process group (detached spawn): the tsx launcher
 * reparents the real `node src/server/main.ts` worker below itself, so
 * `child.kill` alone would orphan the worker and leave the port held.
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
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
      // Already gone; waitForExit settles the caller.
    }
  }
}

/** Creates fresh temporary roots + script file for one child-process run. */
export function prepareChildRoots(): {
  dataRoot: string;
  templateRoot: string;
  scriptFile: string;
  cleanup(): void;
} {
  const dataRoot = mkdtempSync(join(tmpdir(), 'forge-core-child-data-'));
  const templateRoot = mkdtempSync(join(tmpdir(), 'forge-core-child-templates-'));
  const scriptDir = mkdtempSync(join(tmpdir(), 'forge-core-child-scripts-'));
  installRuntimeFixtureTemplate(templateRoot);
  const scriptFile = join(scriptDir, 'fake-scripts.json');
  return {
    dataRoot,
    templateRoot,
    scriptFile,
    cleanup(): void {
      rmSync(dataRoot, { recursive: true, force: true });
      rmSync(templateRoot, { recursive: true, force: true });
      rmSync(scriptDir, { recursive: true, force: true });
    },
  };
}

/** True when the given path still hosts a live process. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Convenience: reads the file projection of a child-server task. */
export function readChildFileProjection(
  roots: { dataRoot: string; templateRoot: string },
  taskId: string,
): TaskFileProjection {
  return readTaskFileProjection(
    CorePaths.create({ dataRoot: roots.dataRoot, templateRoot: roots.templateRoot }),
    taskId,
  );
}
