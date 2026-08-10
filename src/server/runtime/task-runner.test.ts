// @vitest-environment node
/**
 * TaskRunner tests (plan Phase C Task 4 Steps 1/3, spec §3.3/§6.2).
 *
 * One `runNext` reads the next confirmed unprocessed input node (by event
 * sequence), rebuilds that agent's public history and loaded skills from
 * confirmed events alone, runs exactly one runtime Turn and commits the
 * buffered actions through the ActionCommitter — never recursively invoking a
 * second agent. Attempts stay inside the frozen event union: the input node
 * anchors the attempt, `agent_attempt_failed` records failures (retryable per
 * RuntimeFailure) and the committed `agent_result` (id derived from the input
 * node and attempt number) marks the node processed. Hidden thinking never
 * enters the rebuilt history: events only ever carry public text.
 *
 * The plan Step 1 second verbatim case names the agents of the storage-level
 * `valid` fixture — business vocabulary is confined to fixture data and this
 * test file; the TaskRunner module itself carries none (iron rule 1).
 */
import { createHash } from 'node:crypto';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskWorkspace } from '../../shared/contracts';
import { CoreService } from '../core-service';
import type { CorePaths } from '../storage/core-paths';
import type { EventStore } from '../storage/event-store';
import type { TaskEvent } from '../storage/task-events';
import { TraceStore } from '../storage/trace-store';
import {
  catalogWithOneTemplate,
  disposeAllTestRoots,
  makeEventNode,
  makeTaskEvent,
  makeTempCorePaths,
  validTaskRequest,
} from '../test-support';
import { RuntimeAbortedError, RuntimeFailure } from './agent-runtime';
import { ActionCommitter } from './action-committer';
import { FakeAgentRuntime, type FakeScriptStep } from './fake-agent-runtime';
import { SkillService } from './skill-service';
import { buildTurnChecklist, TaskRunner, turnPlanCompleted, type RunNextResult } from './task-runner';
import { WorkspaceStore } from './workspace-store';
import { RecordingRuntime } from './test-support';
import type { FrozenAgentConfig } from '../template/template-schema';

afterEach(() => {
  disposeAllTestRoots();
});

interface RunnerHarness {
  paths: CorePaths;
  service: CoreService;
  events: EventStore;
  runner: TaskRunner;
  runtime: RecordingRuntime;
  fake: FakeAgentRuntime;
  workspaces: WorkspaceStore;
  traces: TraceStore;
  taskId: string;
  controller: AbortController;
  workspace(id: string): Promise<TaskWorkspace>;
}

async function runnerHarness(
  scripts: Record<string, readonly FakeScriptStep[]>,
  options: { traces?: TraceStore } = {},
): Promise<RunnerHarness> {
  const fake = new FakeAgentRuntime({ scripts });
  const runtime = new RecordingRuntime(fake);
  const fixture = await catalogWithOneTemplate();
  const service = new CoreService(fixture.paths, { runtime });
  await service.initialize();
  const skills = new SkillService({ paths: fixture.paths, tasks: service.tasks, events: service.events });
  const committer = new ActionCommitter({
    events: service.events,
    artifacts: service.artifacts,
    skills,
  });
  const workspaces = new WorkspaceStore(fixture.paths);
  const traces = options.traces ?? new TraceStore(fixture.paths);
  const runner = new TaskRunner({
    tasks: service.tasks,
    events: service.events,
    artifacts: service.artifacts,
    skills,
    committer,
    runtime,
    workspaces,
    traces,
  });
  const created = await service.tasks.create(validTaskRequest());
  return {
    paths: fixture.paths,
    service,
    events: service.events,
    runner,
    runtime,
    fake,
    workspaces,
    traces,
    taskId: created.id,
    controller: new AbortController(),
    workspace: (id: string) => service.getWorkspace(id),
  };
}

async function seedInput(
  harness: RunnerHarness,
  parts: { id: string; agentId: string; sequence: number; body: string },
): Promise<void> {
  await harness.events.append(
    harness.taskId,
    makeTaskEvent({
      id: parts.id,
      type: 'agent_input',
      node: makeEventNode({
        sequence: parts.sequence,
        agentId: parts.agentId,
        kind: 'input',
        title: '输入',
        body: parts.body,
      }),
    }),
  );
}

/**
 * One legal writer turn under the turn contract: seal an inline package,
 * then the single publish dispatch referencing it.
 */
const writerPublishTurn = (title: string, content = '初稿正文'): FakeScriptStep => ({
  kind: 'result',
  publicText: '初稿已完成',
  actions: [
    {
      type: 'finish_production',
      source: 'inline',
      files: [{ name: 'content.md', content }],
      format: 'markdown',
      artifactType: '终稿',
      title,
    },
    { type: 'publish_artifact' },
  ],
});

/** One legal reviewer turn: send a short message back to the writer. */
const reviewerMessageTurn: FakeScriptStep = {
  kind: 'result',
  publicText: '审读完成',
  actions: [{ type: 'send_message', targetAgentId: 'writer', summary: '请修改第二段。' }],
};

describe('TaskRunner legal next step (plan Task 4 Step 1 verbatim)', () => {
  it('queues only inputs produced by committed legal actions', async () => {
    const harness = await runnerHarness({
      writer: [writerPublishTurn('初稿 V1')],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始生产' });
    const { runner, taskId } = harness;
    const signal = harness.controller.signal;
    const projector = { workspace: harness.workspace };

    await runner.runNext(taskId, signal);
    expect((await projector.workspace(taskId)).nodes.filter((node) => node.status === 'active')).toHaveLength(0);
    expect(await runner.pendingAgents(taskId)).toEqual(['reviewer']);

    expect(harness.runtime.turnInputs.map((input) => input.agent.id)).toEqual(['writer']);
    const executed = await harness.events.read(taskId);
    expect(executed.map((entry) => entry.event.type)).toContain('route_executed');
    expect(executed.map((entry) => entry.event.type)).toContain('artifact_published');
  });
});

describe('TaskRunner artifact hand-off Turn input', () => {
  it('delivers the full artifact content to the receiving agent, not only the title', async () => {
    // Real Provider evidence (phase-d attempt 2): the route node body carries
    // only the artifact title, and the reviewer turn that received it answered
    // "没有收到稿件" because the Turn input never included the content. The
    // receiving agent must see the whole hand-off artifact.
    const harness = await runnerHarness({
      writer: [writerPublishTurn('初稿 V1', '这是必须完整送达审核方的产物正文。')],
      reviewer: [reviewerMessageTurn],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始生产' });

    await harness.runner.runNext(harness.taskId, harness.controller.signal); // writer publishes, routes to reviewer
    await harness.runner.runNext(harness.taskId, harness.controller.signal); // reviewer hand-off turn

    const reviewerInput = harness.runtime.turnInputs.find((input) => input.agent.id === 'reviewer');
    expect(reviewerInput).toBeDefined();
    expect(reviewerInput?.inputText).toContain('这是必须完整送达审核方的产物正文。');
    expect(reviewerInput?.inputText).toContain('初稿 V1');
  });
});

describe('TaskRunner one-node execution', () => {
  it('returns an idle result when no confirmed input is pending', async () => {
    const harness = await runnerHarness({});
    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result).toMatchObject({
      processedNodeId: null,
      committed: false,
      taskCompleted: false,
      waitingHuman: false,
      attemptFailed: false,
      pendingAgentIds: [],
    });
    expect(await harness.runner.pendingAgents(harness.taskId)).toEqual([]);
    expect(await harness.events.read(harness.taskId)).toEqual([]);
  });

  it('processes the earliest unprocessed input and never a second agent', async () => {
    const harness = await runnerHarness({
      writer: [writerPublishTurn('初稿 V1')],
      reviewer: [reviewerMessageTurn],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '给 writer' });

    const first = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(first.processedNodeId).toBe('ev-input-writer');
    expect(first.committed).toBe(true);
    expect(await harness.runner.pendingAgents(harness.taskId)).toEqual(['reviewer']);

    // The publish routed the artifact hand-off input to reviewer; it is the
    // next confirmed unprocessed input (still one agent per call).
    const second = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(second.processedNodeId).toBe('ev-input-writer-t1-artifact-input-0');
    expect(second.committed).toBe(true);
    // The reviewer's message routed a fresh writer input.
    expect(await harness.runner.pendingAgents(harness.taskId)).toEqual(['writer']);

    expect(harness.runtime.turnInputs.map((input) => input.agent.id)).toEqual(['writer', 'reviewer']);
  });

  it('marks the input processed through the committed result of this attempt', async () => {
    const harness = await runnerHarness({
      writer: [
        {
          kind: 'result',
          publicText: '完成',
          actions: [{ type: 'request_human_input', question: '是否继续？' }],
        },
      ],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });

    const first = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(first).toMatchObject({ processedNodeId: 'ev-input-writer', committed: true, attemptFailed: false });

    const committed = await harness.events.read(harness.taskId);
    const resultEvent = committed.find((entry) => entry.event.type === 'agent_result');
    expect(resultEvent?.event.id).toBe('ev-input-writer-t1-result');
    if (resultEvent?.event.type === 'agent_result') {
      expect(resultEvent.event.node.attemptCount).toBe(1);
      expect(resultEvent.event.node.body).toBe('完成');
    }

    const again = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(again.processedNodeId).toBeNull();
    expect(harness.fake.countInvocations('writer')).toBe(1);
  });

  it('rebuilds only the agent own public history from confirmed events', async () => {
    const harness = await runnerHarness({
      writer: [
        {
          kind: 'result',
          publicText: '第二轮结果',
          actions: [{ type: 'request_human_input', question: '是否继续？' }],
        },
      ],
      reviewer: [{ kind: 'result', publicText: '不应出现' }],
    });
    // Round one already confirmed: writer input + matching result id.
    await seedInput(harness, { id: 'ev-input-writer-1', agentId: 'writer', sequence: 1, body: '第一轮输入' });
    await harness.events.append(
      harness.taskId,
      makeTaskEvent({
        id: 'ev-input-writer-1-t1-result',
        type: 'agent_result',
        node: makeEventNode({
          sequence: 2,
          agentId: 'writer',
          kind: 'result',
          title: '结果',
          body: '第一轮结果',
        }),
      }),
    );
    await harness.events.append(
      harness.taskId,
      makeTaskEvent({
        id: 'ev-human-writer-1',
        type: 'human_requested',
        node: makeEventNode({
          sequence: 3,
          agentId: 'writer',
          kind: 'human_request',
          title: '人工提问',
          body: '需要确认',
        }),
        question: '需要确认',
      }),
    );
    await harness.events.append(
      harness.taskId,
      makeTaskEvent({
        id: 'ev-human-writer-2',
        type: 'human_answered',
        node: makeEventNode({
          sequence: 4,
          agentId: 'writer',
          kind: 'human_answer',
          title: '人工回答',
          body: '确认通过',
        }),
        answer: '确认通过',
      }),
    );
    // The pending second input for writer plus a reviewer node that must stay excluded.
    await seedInput(harness, { id: 'ev-input-writer-2', agentId: 'writer', sequence: 5, body: '第二轮输入' });
    await harness.events.append(
      harness.taskId,
      makeTaskEvent({
        id: 'ev-input-reviewer-1',
        type: 'agent_input',
        node: makeEventNode({
          sequence: 6,
          agentId: 'reviewer',
          kind: 'input',
          title: '输入',
          body: '其他 Agent 的输入',
        }),
      }),
    );

    await harness.runner.runNext(harness.taskId, harness.controller.signal);
    const turnInput = harness.runtime.turnInputs.at(-1);
    expect(turnInput).toBeDefined();
    expect(turnInput?.taskId).toBe(harness.taskId);
    expect(turnInput?.inputNodeId).toBe('ev-input-writer-2');
    // The turn input composes the derived turn-state prefix, the confirmed
    // body and the contract checklist (plan 2026-08-06) — history alone stays
    // the rebuilt public messages below.
    const frozen = await harness.service.tasks.readFrozenTemplate(harness.taskId);
    const writer = frozen.agents.find((agent) => agent.id === 'writer');
    expect(writer).toBeDefined();
    expect(turnInput?.inputText).toBe(
      `[回合状态] 第 2 次执行。\n\n第二轮输入\n\n${buildTurnChecklist(writer!, frozen)}`,
    );
    expect(turnInput?.turnId).toBe('ev-input-writer-2-t1');
    expect(turnInput?.agent.id).toBe('writer');
    expect(turnInput?.publicHistory).toEqual([
      { role: 'user', text: '第一轮输入' },
      { role: 'assistant', text: '第一轮结果' },
      { role: 'assistant', text: '需要确认' },
      { role: 'user', text: '确认通过' },
    ]);
    expect(turnInput?.availableSkills).toEqual([
      { id: 'style-guide', name: '文风指南', description: '语气与节奏参考。' },
    ]);
    expect(turnInput?.loadedSkills).toEqual([]);
  });

  it('rebuilds loaded skills from committed skill_loaded events', async () => {
    const harness = await runnerHarness({
      writer: [
        {
          kind: 'result',
          publicText: '带技能结果',
          actions: [{ type: 'request_human_input', question: '是否继续？' }],
        },
      ],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });
    await harness.events.append(
      harness.taskId,
      makeTaskEvent({ type: 'skill_loaded', skillId: 'style-guide' }),
    );

    await harness.runner.runNext(harness.taskId, harness.controller.signal);
    const turnInput = harness.runtime.turnInputs.at(-1);
    expect(turnInput?.loadedSkills).toHaveLength(1);
    const loaded = turnInput?.loadedSkills[0];
    expect(loaded?.id).toBe('style-guide');
    expect((loaded?.content ?? '').length).toBeGreaterThan(0);
    expect(loaded?.versionHash).toBe(createHash('sha256').update(loaded?.content ?? '', 'utf8').digest('hex'));
  });
});

describe('TaskRunner attempt outcomes', () => {
  it('records a permanent attempt failure and keeps the node unprocessed', async () => {
    const harness = await runnerHarness({
      writer: [
        { kind: 'failure', failure: RuntimeFailure.permanent('PROVIDER_ERROR', 'provider rejected the turn') },
      ],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });

    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result).toMatchObject({
      processedNodeId: 'ev-input-writer',
      committed: false,
      attemptFailed: true,
      retryable: false,
    });

    const committed = await harness.events.read(harness.taskId);
    const failure = committed.find((entry) => entry.event.type === 'agent_attempt_failed');
    expect(failure?.event).toMatchObject({
      type: 'agent_attempt_failed',
      nodeId: 'ev-input-writer',
      retryable: false,
    });
    expect(committed.some((entry) => entry.event.type === 'agent_result')).toBe(false);
    expect(await harness.runner.pendingAgents(harness.taskId)).toEqual(['writer']);
    expect((await harness.workspace(harness.taskId)).task.status).toBe('retryable_failure');
  });

  it('records a transient attempt failure as retryable', async () => {
    const harness = await runnerHarness({
      writer: [
        { kind: 'failure', failure: RuntimeFailure.transient('ETIMEDOUT', 'provider timed out') },
      ],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });

    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result).toMatchObject({ attemptFailed: true, retryable: true });

    const committed = await harness.events.read(harness.taskId);
    const failure = committed.find((entry) => entry.event.type === 'agent_attempt_failed');
    if (failure?.event.type === 'agent_attempt_failed') {
      expect(failure.event.retryable).toBe(true);
      expect(failure.event.message).toContain('ETIMEDOUT');
    } else {
      expect.unreachable('expected an agent_attempt_failed event');
    }
    // Retryable failures keep the task running (auto retry belongs to Task 5).
    expect((await harness.workspace(harness.taskId)).task.status).toBe('running');
  });

  it('increments the attempt count after a recorded failure', async () => {
    const harness = await runnerHarness({
      writer: [
        { kind: 'failure', failure: RuntimeFailure.transient('ETIMEDOUT', 'provider timed out') },
        {
          kind: 'result',
          publicText: '重试成功',
          actions: [{ type: 'request_human_input', question: '是否继续？' }],
        },
      ],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });

    await harness.runner.runNext(harness.taskId, harness.controller.signal);
    const second = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(second).toMatchObject({ processedNodeId: 'ev-input-writer', committed: true });

    const committed = await harness.events.read(harness.taskId);
    const resultEvent = committed.find((entry) => entry.event.id === 'ev-input-writer-t2-result');
    expect(resultEvent).toBeDefined();
    if (resultEvent?.event.type === 'agent_result') {
      expect(resultEvent.event.node.attemptCount).toBe(2);
    }
    const turnInput = harness.runtime.turnInputs.at(-1);
    expect(turnInput?.turnId).toBe('ev-input-writer-t2');
  });

  it('propagates abort without recording an attempt', async () => {
    const harness = await runnerHarness({
      writer: [{ kind: 'result', publicText: '不应执行' }],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });
    harness.controller.abort();

    await expect(harness.runner.runNext(harness.taskId, harness.controller.signal)).rejects.toBeInstanceOf(
      RuntimeAbortedError,
    );
    const committed = await harness.events.read(harness.taskId);
    expect(committed.map((entry) => entry.event.type)).toEqual(['agent_input']);
    expect(await harness.runner.pendingAgents(harness.taskId)).toEqual(['writer']);
  });

  it('records a commit validation failure as a failed attempt with zero writes', async () => {
    const harness = await runnerHarness({
      writer: [
        {
          kind: 'result',
          publicText: '非法路由',
          actions: [
            {
              type: 'finish_production',
              source: 'inline',
              files: [{ name: 'content.md', content: '封存正文' }],
              format: 'markdown',
              artifactType: null,
              title: null,
            },
            { type: 'send_message', targetAgentId: 'unknown', summary: '返修意见' },
          ],
        },
      ],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });

    const before = await harness.events.read(harness.taskId);
    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result).toMatchObject({ attemptFailed: true, retryable: false, committed: false });

    const committed = await harness.events.read(harness.taskId);
    const added = committed.filter((entry) => !before.some((prior) => prior.event.id === entry.event.id));
    expect(added).toHaveLength(1);
    expect(added[0]?.event.type).toBe('agent_attempt_failed');
    expect(committed.some((entry) => entry.event.type === 'route_executed')).toBe(false);
    expect(committed.some((entry) => entry.event.type === 'agent_result')).toBe(false);
  });

  it('records a text-only turn (no actions) as a failed attempt, never leaving running', async () => {
    // The no-progress regression (plan 2026-08-04 Task 3): a model that only
    // outputs natural language can never leave the task silently `running` —
    // the phase gate parks it as a visible non-retryable attempt failure.
    const harness = await runnerHarness({
      writer: [{ kind: 'result', publicText: '我说完成了。', actions: [] }],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });

    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result).toMatchObject({ attemptFailed: true, retryable: false, committed: false });
    expect((await harness.workspace(harness.taskId)).task.status).toBe('retryable_failure');

    const committed = await harness.events.read(harness.taskId);
    expect(committed.some((entry) => entry.event.type === 'agent_result')).toBe(false);
    const failure = committed.find((entry) => entry.event.type === 'agent_attempt_failed');
    expect(failure?.event).toMatchObject({ nodeId: 'ev-input-writer', retryable: false });
    expect((failure?.event.type === 'agent_attempt_failed' && failure.event.message) ?? '')
      .toContain('AGENT_PHASE_INCOMPLETE');
  });

  it('reports waiting human when the turn requests human input', async () => {
    const harness = await runnerHarness({
      writer: [
        {
          kind: 'result',
          publicText: '需要人工确认',
          actions: [{ type: 'request_human_input', question: '是否继续？' }],
        },
      ],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });

    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result).toMatchObject({ committed: true, waitingHuman: true, taskCompleted: false });
    const workspace = await harness.workspace(harness.taskId);
    expect(workspace.task.status).toBe('waiting_human');
    expect(workspace.pendingHumanQuestion).toBe('是否继续？');
    expect(await harness.runner.pendingAgents(harness.taskId)).toEqual([]);
  });

  it('reports task completion only through the system final gate', async () => {
    const harness = await runnerHarness({
      writer: [writerPublishTurn('终稿 V1', '终稿正文')],
      reviewer: [
        {
          kind: 'result',
          publicText: '终稿提交',
          actions: [{ type: 'submit_final_artifact' }],
        },
      ],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });

    await harness.runner.runNext(harness.taskId, harness.controller.signal); // writer publishes, routes to reviewer
    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result).toMatchObject({ committed: true, taskCompleted: true, waitingHuman: false });
    const workspace = await harness.workspace(harness.taskId);
    expect(workspace.task.status).toBe('completed');
    expect(workspace.artifacts.at(-1)?.final).toBe(true);
  });

  it('submits the received hand-off artifact as final without re-publishing', async () => {
    // writer publishes V1 (auto-routed), reviewer submits the RECEIVED input
    // version as final — the platform resolves the version from the input node,
    // no new artifact version is published (frozen decision 3/5).
    const harness = await runnerHarness({
      writer: [writerPublishTurn('章节 V1', '章节正文')],
      reviewer: [
        {
          kind: 'result',
          publicText: '审核通过，提交原稿。',
          actions: [{ type: 'submit_final_artifact' }],
        },
      ],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始生产' });

    await harness.runner.runNext(harness.taskId, harness.controller.signal); // writer publishes
    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result).toMatchObject({ committed: true, taskCompleted: true, attemptFailed: false });

    const workspace = await harness.workspace(harness.taskId);
    expect(workspace.task.status).toBe('completed');
    expect(workspace.artifacts).toHaveLength(1); // nothing re-published
    expect(workspace.artifacts.at(-1)?.final).toBe(true);
    expect(workspace.artifacts.at(-1)?.files[0].content).toBe('章节正文');
  });

  it('fails the attempt when submit_final_artifact runs without a received artifact', async () => {
    const harness = await runnerHarness({
      reviewer: [
        {
          kind: 'result',
          publicText: '提交不存在的产物',
          actions: [{ type: 'submit_final_artifact' }],
        },
      ],
    });
    // Plain seeded input: the node carries no inputVersion.
    await seedInput(harness, { id: 'ev-input-reviewer', agentId: 'reviewer', sequence: 1, body: '审核' });

    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result).toMatchObject({ attemptFailed: true, retryable: false, committed: false });
    expect((await harness.workspace(harness.taskId)).task.status).toBe('retryable_failure');
    expect((await harness.events.read(harness.taskId)).some((entry) => entry.event.type === 'agent_result')).toBe(false);
  });

  it('returns the RunNextResult shape frozen for the scheduler', async () => {
    const harness = await runnerHarness({
      writer: [
        {
          kind: 'result',
          publicText: '完成',
          actions: [{ type: 'request_human_input', question: '是否继续？' }],
        },
      ],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });
    const result: RunNextResult = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(Object.keys(result).sort()).toEqual([
      'attemptCount',
      'attemptFailed',
      'committed',
      'pendingAgentIds',
      'processedNodeId',
      'retryable',
      'taskCompleted',
      'waitingHuman',
    ]);
    expect(result.attemptCount).toBe(1);
  });
});

describe('TaskRunner retry budget (plan Task 5 Step 3)', () => {
  it('records a transient failure as terminal once the auto-retry budget is exhausted', async () => {
    const harness = await runnerHarness({
      writer: [
        { kind: 'failure', failure: RuntimeFailure.transient('ETIMEDOUT', 'connection timed out') },
      ],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });

    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal, {
      autoRetryExhausted: true,
    });
    expect(result).toMatchObject({ attemptFailed: true, retryable: false, attemptCount: 1 });

    const committed = await harness.events.read(harness.taskId);
    const failure = committed.find((entry) => entry.event.type === 'agent_attempt_failed');
    expect(failure).toBeDefined();
    if (failure?.event.type === 'agent_attempt_failed') {
      expect(failure.event.retryable).toBe(false);
    }
    expect((await harness.workspace(harness.taskId)).task.status).toBe('retryable_failure');
  });

  it('keeps transient failures retryable while the budget remains', async () => {
    const harness = await runnerHarness({
      writer: [
        { kind: 'failure', failure: RuntimeFailure.transient('HTTP_503', 'provider overloaded') },
      ],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });

    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal, {
      autoRetryExhausted: false,
    });
    expect(result).toMatchObject({ attemptFailed: true, retryable: true });
  });

  it('never auto-retries commit-stage failures regardless of the budget', async () => {
    const harness = await runnerHarness({
      writer: [
        {
          kind: 'result',
          publicText: '非法动作',
          actions: [
            { type: 'send_message', targetAgentId: 'unknown', summary: '返修意见' },
          ],
        },
      ],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });

    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal, {
      autoRetryExhausted: false,
    });
    expect(result).toMatchObject({ attemptFailed: true, retryable: false, committed: false });
  });
});

/* Plan 2026-08-04 Task 5: best-effort FINAL turn-trace persistence and
 * finish_production workspace resolution. Traces are display-only
 * observability (never authoritative): the runner records exactly one trace
 * per turn after the commit outcome is known (success phase, or a failed
 * phase that may carry zero entries), and a failing TraceStore must never
 * block the commit. finish_production workspace_file references are
 * resolved to controlled content strictly before the commit context is
 * built; an unreadable file fails the attempt (retryable=false) without
 * throwing — the scheduler only ever swallows RuntimeAbortedError. */

describe('TaskRunner final turn-trace recording (plan 2026-08-04 Task 5)', () => {
  it('writes ONE final trace after the commit outcome, entries plus phase', async () => {
    const harness = await runnerHarness({
      writer: [
        {
          kind: 'result',
          publicText: '完成',
          thinking: '先思考，再产出。',
          actions: [
            {
              type: 'finish_production',
              source: 'inline',
              files: [{ name: 'content.md', content: '封存正文' }],
              format: 'markdown',
              artifactType: '终稿',
              title: '初稿 V1',
            },
            { type: 'publish_artifact' },
          ],
        },
      ],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });

    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result.committed).toBe(true);

    const trace = await harness.traces.readTurnTrace(harness.taskId, 'ev-input-writer-t1');
    expect(trace).toEqual({
      turnId: 'ev-input-writer-t1',
      phase: {
        state: 'dispatched',
        dispatchAction: 'publish_artifact',
        target: null,
        message: '已发布产物「初稿 V1」v1',
      },
      entries: [
        { kind: 'text', text: '完成' },
      ],
    });
    const committed = await harness.events.read(harness.taskId);
    expect(committed.some((entry) => entry.event.type === 'agent_result')).toBe(true);
  });

  it('writes a failed phase trace for a text-only turn and still parks it', async () => {
    const harness = await runnerHarness({
      writer: [{ kind: 'result', publicText: '只有文字。', thinking: '想了想。', actions: [] }],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });

    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result.attemptFailed).toBe(true);

    const trace = await harness.traces.readTurnTrace(harness.taskId, 'ev-input-writer-t1');
    expect(trace?.phase?.state).toBe('failed');
    expect(trace?.phase?.dispatchAction).toBeNull();
    expect(trace?.entries).toEqual([
      { kind: 'text', text: '只有文字。' },
    ]);
  });

  it('still commits the Turn when the TraceStore rejects the append', async () => {
    const throwingTraces = {
      appendTurnTrace: async (): Promise<void> => {
        throw new Error('trace store unavailable');
      },
      readTurnTrace: async (): Promise<null> => null,
    } as unknown as TraceStore;
    const harness = await runnerHarness(
      {
        writer: [
          {
            kind: 'result',
            publicText: '完成',
            thinking: '思考。',
            actions: [{ type: 'request_human_input', question: '是否继续？' }],
          },
        ],
      },
      { traces: throwingTraces },
    );
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });

    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result).toMatchObject({ committed: true, attemptFailed: false, waitingHuman: true });
    const committed = await harness.events.read(harness.taskId);
    expect(committed.some((entry) => entry.event.type === 'agent_result')).toBe(true);
  });
});

describe('TaskRunner workspace production resolution (plan 2026-08-04 Task 4)', () => {
  it('resolves a finish_production workspaceFile into the committed artifact content', async () => {
    const harness = await runnerHarness({
      writer: [
        {
          kind: 'result',
          publicText: '从工作区发布',
          actions: [
            {
              type: 'finish_production',
              source: 'workspace_file',
              files: [{ name: 'content.md', workspaceFile: 'draft/v1.md' }],
              format: 'markdown',
              artifactType: '终稿',
              title: '工作区 V1',
            },
            { type: 'publish_artifact' },
          ],
        },
      ],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });
    await harness.workspaces.writeFile(harness.taskId, 'writer', 'draft/v1.md', '工作区草稿正文');

    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result).toMatchObject({ committed: true, attemptFailed: false });

    const artifact = await harness.service.artifacts.read(harness.taskId, 1);
    expect(artifact.files[0].content).toBe('工作区草稿正文');
    expect(
      createHash('sha256').update(artifact.files[0].content, 'utf8').digest('hex'),
    ).toHaveLength(64);
  });

  it('fails the attempt without throwing when the workspace file is unreadable', async () => {
    const harness = await runnerHarness({
      writer: [
        {
          kind: 'result',
          publicText: '从工作区发布',
          actions: [
            {
              type: 'finish_production',
              source: 'workspace_file',
              files: [{ name: 'content.md', workspaceFile: 'missing/draft.md' }],
              format: 'markdown',
              artifactType: '终稿',
              title: '工作区 V1',
            },
            { type: 'publish_artifact' },
          ],
        },
      ],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });

    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result).toMatchObject({
      processedNodeId: 'ev-input-writer',
      committed: false,
      attemptFailed: true,
      retryable: false,
    });

    const committed = await harness.events.read(harness.taskId);
    const failure = committed.find((entry) => entry.event.type === 'agent_attempt_failed');
    expect(failure?.event).toMatchObject({
      type: 'agent_attempt_failed',
      nodeId: 'ev-input-writer',
      retryable: false,
    });
    expect(committed.some((entry) => entry.event.type === 'agent_result')).toBe(false);
    expect((await harness.workspace(harness.taskId)).task.status).toBe('retryable_failure');
  });
});

describe('TaskRunner per-turn checklist (plan 2026-08-06)', () => {
  const CHECKLIST_MARKER = '【本回合任务清单】';

  it('derives the publisher checklist from the frozen contract', async () => {
    const harness = await runnerHarness({});
    const frozen = await harness.service.tasks.readFrozenTemplate(harness.taskId);
    const writer = frozen.agents.find((agent) => agent.id === 'writer');
    expect(writer).toBeDefined();

    const checklist = buildTurnChecklist(writer!, frozen);
    expect(checklist).toContain(CHECKLIST_MARKER);
    expect(checklist).toContain('finish_production');
    // The contract's allowed sources are named, not invented.
    expect(checklist).toContain('内联（直接提供全文）');
    expect(checklist).toContain('工作区文件');
    expect(checklist).toContain('publish_artifact');
    // Production turns publish without naming the target in the checklist.
    expect(checklist).not.toContain('send_message');
    expect(checklist).toContain('文字输出不是动作');
  });

  it('derives every allowed dispatch option for v2 operate contracts', async () => {
    const harness = await runnerHarness({});
    const frozen = await harness.service.tasks.readFrozenTemplate(harness.taskId);
    const reviewer = frozen.agents.find((agent) => agent.id === 'reviewer');
    expect(reviewer).toBeDefined();

    // A v2 operate contract (no production; annotate present) renders the
    // annotate steps and every allowed operate dispatch.
    const operateReviewer: FrozenAgentConfig = {
      ...reviewer!,
      turnContract: {
        version: 2,
        annotate: { files: ['review.md'] },
        dispatch: {
          cardinality: 'single',
          allowedActions: ['send_message', 'submit_final_artifact'],
          targets: { send_message: ['writer'] },
        },
      },
    };
    const checklist = buildTurnChecklist(operateReviewer, frozen);
    expect(checklist).toContain('annotate_artifact');
    expect(checklist).toContain('调用 send_message 向 writer（初稿 Agent） 发送消息');
    expect(checklist).toContain('调用 submit_final_artifact 提交终稿');
  });

  it('joins multiple candidate targets with 或 in the dispatch checklist lines', async () => {
    const harness = await runnerHarness({});
    const frozen = await harness.service.tasks.readFrozenTemplate(harness.taskId);
    const reviewer = frozen.agents.find((agent) => agent.id === 'reviewer');
    expect(reviewer).toBeDefined();
    const multiTarget: FrozenAgentConfig = {
      ...reviewer!,
      turnContract: {
        version: 2,
        annotate: { files: ['review.md'] },
        dispatch: {
          cardinality: 'single',
          allowedActions: ['send_message', 'submit_final_artifact'],
          targets: { send_message: ['writer', 'reviewer'] },
        },
      },
    };
    const checklist = buildTurnChecklist(multiTarget, frozen);
    // Every candidate names its agent ID (the dispatch parameter) plus the
    // display name; multiple candidates join with 或.
    expect(checklist).toContain('调用 send_message 向 writer（初稿 Agent） 或 reviewer（审核 Agent） 发送消息');
  });

  it('returns an empty checklist when the snapshot carries no turn contract', async () => {
    const harness = await runnerHarness({});
    const frozen = await harness.service.tasks.readFrozenTemplate(harness.taskId);
    const writer = frozen.agents.find((agent) => agent.id === 'writer');
    expect(writer).toBeDefined();

    expect(buildTurnChecklist({ ...writer!, turnContract: null }, frozen)).toBe('');
  });

  it('fails closed (empty checklist) for a v3 structured contract (Task 5)', async () => {
    const harness = await runnerHarness({});
    const frozen = await harness.service.tasks.readFrozenTemplate(harness.taskId);
    const writer = frozen.agents.find((agent) => agent.id === 'writer');
    expect(writer).toBeDefined();
    const v3: import('../template/template-schema').StructuredTurnContractV3 = {
      version: 3,
      slotSession: {
        kind: 'structure',
        accessProfile: null,
        capabilities: [
          'read_structure_contract',
          'write_structure_proposal',
          'submit_structure_proposal',
        ],
        completion: 'structure_commit_candidate_created',
      },
      dispatch: {
        allowedActions: ['send_message'],
        targets: { send_message: ['fill'] },
      },
    };
    expect(buildTurnChecklist({ ...writer!, turnContract: v3 }, frozen)).toBe('');
  });

  it('injects the checklist after the input body, never into events or replayed history', async () => {
    const harness = await runnerHarness({
      writer: [writerPublishTurn('初稿 V1'), writerPublishTurn('初稿 V2')],
      reviewer: [reviewerMessageTurn],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });

    await harness.runner.runNext(harness.taskId, harness.controller.signal);
    await harness.runner.runNext(harness.taskId, harness.controller.signal);
    await harness.runner.runNext(harness.taskId, harness.controller.signal);

    // Order: turn-state prefix and body first, checklist last (recency).
    const firstInput = harness.runtime.turnInputs[0].inputText;
    const bodyIndex = firstInput.indexOf('开始');
    const checklistIndex = firstInput.indexOf(CHECKLIST_MARKER);
    expect(bodyIndex).toBeGreaterThan(-1);
    expect(checklistIndex).toBeGreaterThan(bodyIndex);
    expect(firstInput.endsWith('文字输出不是动作，不能代替工具调用。')).toBe(true);

    // The checklist never lands in committed events...
    const committed = await harness.events.read(harness.taskId);
    for (const entry of committed) {
      const event = entry.event;
      if ('node' in event) {
        expect(event.node.body).not.toContain(CHECKLIST_MARKER);
        expect(event.node.title).not.toContain(CHECKLIST_MARKER);
      }
    }
    // ...and never re-enters the rebuilt public history of later Turns.
    for (const turnInput of harness.runtime.turnInputs) {
      for (const item of turnInput.publicHistory) {
        expect(item.text).not.toContain(CHECKLIST_MARKER);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 4: forward dispatch + turnPlanCompleted forward terminal id (spec §8.2)
// ---------------------------------------------------------------------------

/** The committed long-form-hub template root, resolved from this test file. */
function hubTemplateRoot(): string {
  return fileURLToPath(new URL('../../../templates/long-form-hub', import.meta.url));
}

/**
 * A runner harness over the real long-form-hub v7 template (controller/writer/
 * reviewer with the reviewer->controller artifact edge). Installs the template
 * into a fresh temp root so the runner exercises the v7 forward path end-to-end.
 */
async function hubRunnerHarness(
  scripts: Record<string, readonly FakeScriptStep[]>,
): Promise<RunnerHarness> {
  const fake = new FakeAgentRuntime({ scripts });
  const runtime = new RecordingRuntime(fake);
  const { paths } = makeTempCorePaths('forge-hub-runner-');
  cpSync(hubTemplateRoot(), join(paths.templateRoot, 'long-form-hub'), { recursive: true });
  const service = new CoreService(paths, { runtime });
  await service.initialize();
  const skills = new SkillService({ paths, tasks: service.tasks, events: service.events });
  const committer = new ActionCommitter({
    events: service.events,
    artifacts: service.artifacts,
    skills,
  });
  const workspaces = new WorkspaceStore(paths);
  const traces = new TraceStore(paths);
  const runner = new TaskRunner({
    tasks: service.tasks,
    events: service.events,
    artifacts: service.artifacts,
    skills,
    committer,
    runtime,
    workspaces,
    traces,
  });
  const created = await service.tasks.create({
    templateId: 'long-form-hub',
    name: 'Hub 任务',
    input: { theme: '一段主题', outline: '一份大纲' },
  });
  return {
    paths,
    service,
    events: service.events,
    runner,
    runtime,
    fake,
    workspaces,
    traces,
    taskId: created.id,
    controller: new AbortController(),
    workspace: (id: string) => service.getWorkspace(id),
  };
}

describe('TaskRunner v7 forward path (spec §7.3, long-form-hub template)', () => {
  it('runs writer publish -> reviewer forward -> controller submit to completion', async () => {
    const harness = await hubRunnerHarness({
      controller: [
        {
          kind: 'result',
          publicText: '分配写作任务',
          actions: [{ type: 'send_message', targetAgentId: 'writer', summary: '请写第一章。' }],
        },
        {
          kind: 'result',
          publicText: '审核通过，提交终稿。',
          actions: [{ type: 'submit_final_artifact' }],
        },
      ],
      writer: [
        {
          kind: 'result',
          publicText: '初稿完成',
          actions: [
            {
              type: 'finish_production',
              source: 'inline',
              files: [{ name: 'content.md', content: '章节正文' }],
              format: 'markdown',
              artifactType: '章节',
              title: '第一章 V1',
            },
            { type: 'publish_artifact' },
          ],
        },
      ],
      reviewer: [
        {
          kind: 'result',
          publicText: '审核通过并转交',
          actions: [
            {
              type: 'annotate_artifact',
              file: 'review.md',
              content: '---\nverdict: pass\n---\n## 意见\n通过',
            },
            { type: 'forward_input_version', targetAgentId: 'controller' },
          ],
        },
      ],
    });
    await seedInput(harness, {
      id: 'ev-input-controller',
      agentId: 'controller',
      sequence: 1,
      body: '开始生产',
    });

    await harness.runner.runNext(harness.taskId, harness.controller.signal); // controller -> writer
    await harness.runner.runNext(harness.taskId, harness.controller.signal); // writer publish -> reviewer
    await harness.runner.runNext(harness.taskId, harness.controller.signal); // reviewer forward -> controller
    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal); // controller submit

    expect(result.committed).toBe(true);
    expect(result.taskCompleted).toBe(true);
    const workspace = await harness.workspace(harness.taskId);
    expect(workspace.task.status).toBe('completed');
    expect(workspace.artifacts.at(-1)?.final).toBe(true);
    // The forward route is an artifact edge ending at the controller.
    const forwardRoute = workspace.executedRoutes.find(
      (r) => r.kind === 'artifact' && r.toNodeId.endsWith('-forward-input-0'),
    );
    expect(forwardRoute).toBeDefined();
  });

  it('advances past a completed forward turn (forward terminal id, spec §8.2)', async () => {
    // A completed forward turn whose plan reached `-forward-input-0` must be
    // detected as complete even if a stale commit-failed marker lingers, so
    // the runner advances to the forwarded target instead of re-entering.
    const harness = await hubRunnerHarness({
      controller: [
        {
          kind: 'result',
          publicText: '分配',
          actions: [{ type: 'send_message', targetAgentId: 'writer', summary: '写第一章。' }],
        },
        {
          kind: 'result',
          publicText: '提交终稿',
          actions: [{ type: 'submit_final_artifact' }],
        },
      ],
      writer: [
        {
          kind: 'result',
          publicText: '初稿',
          actions: [
            {
              type: 'finish_production',
              source: 'inline',
              files: [{ name: 'content.md', content: '章节正文' }],
              format: 'markdown',
              artifactType: '章节',
              title: '第一章 V1',
            },
            { type: 'publish_artifact' },
          ],
        },
      ],
      reviewer: [
        {
          kind: 'result',
          publicText: '转交',
          actions: [{ type: 'forward_input_version', targetAgentId: 'controller' }],
        },
      ],
    });
    await seedInput(harness, {
      id: 'ev-input-controller',
      agentId: 'controller',
      sequence: 1,
      body: '开始生产',
    });

    await harness.runner.runNext(harness.taskId, harness.controller.signal); // controller -> writer
    await harness.runner.runNext(harness.taskId, harness.controller.signal); // writer publish -> reviewer
    await harness.runner.runNext(harness.taskId, harness.controller.signal); // reviewer forward -> controller

    // Inject a stale non-retryable commit-failed marker for the reviewer turn.
    // The forward plan already reached its terminal `-forward-input-0`, so the
    // runner must treat the reviewer input as resolved and run the controller.
    const reviewerInputId = harness.runtime.turnInputs
      .filter((input) => input.agent.id === 'reviewer')
      .at(-1)!.inputNodeId;
    const reviewerTurnId = `${reviewerInputId}-t1`;
    await harness.events.append(harness.taskId, {
      id: `${reviewerTurnId}-commit-failed`,
      at: new Date().toISOString(),
      type: 'agent_attempt_failed',
      nodeId: reviewerInputId,
      message: 'stale marker after completed forward',
      retryable: false,
    });

    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result.committed).toBe(true);
    expect(result.taskCompleted).toBe(true);
    // The last run was the controller submit, not a reviewer re-entry.
    expect(harness.runtime.turnInputs.at(-1)?.agent.id).toBe('controller');
    expect(harness.fake.countInvocations('reviewer')).toBe(1);
  });
});

describe('TaskRunner v7 input assembly (semantic audit P0, plan 2026-08-07)', () => {
  /** content.md body of a writer production turn. */
  const V1_BODY = '第一章 V1 正文';
  const V2_BODY = '第一章 V2 正文';

  const writerPublishStep = (title: string, content: string) => ({
    kind: 'result' as const,
    publicText: `${title} 完成`,
    actions: [
      {
        type: 'finish_production' as const,
        source: 'inline' as const,
        files: [{ name: 'content.md', content }],
        format: 'markdown' as const,
        artifactType: '章节',
        title,
      },
      { type: 'publish_artifact' as const },
    ],
  });

  it('reject -> writer receives summary AND content.md AND review.md in one input', async () => {
    const harness = await hubRunnerHarness({
      controller: [
        {
          kind: 'result',
          publicText: '分配写作任务',
          actions: [{ type: 'send_message', targetAgentId: 'writer', summary: '请写第一章。' }],
        },
        {
          kind: 'result',
          publicText: '审核通过，提交终稿。',
          actions: [{ type: 'submit_final_artifact' }],
        },
      ],
      writer: [
        writerPublishStep('第一章 V1', V1_BODY),
        writerPublishStep('第一章 V2', V2_BODY),
      ],
      reviewer: [
        {
          kind: 'result',
          publicText: '需要修改',
          actions: [
            {
              type: 'annotate_artifact',
              file: 'review.md',
              content: '---\nverdict: reject\n---\n## 意见\n第二段节奏太慢，请修改。\n',
            },
            { type: 'send_message', targetAgentId: 'writer', summary: '请修改第二段。' },
          ],
        },
        {
          kind: 'result',
          publicText: '审核通过并转交',
          actions: [
            {
              type: 'annotate_artifact',
              file: 'review.md',
              content: '---\nverdict: pass\n---\n## 意见\n通过',
            },
            { type: 'forward_input_version', targetAgentId: 'controller' },
          ],
        },
      ],
    });
    await seedInput(harness, {
      id: 'ev-input-controller',
      agentId: 'controller',
      sequence: 1,
      body: '开始生产',
    });

    await harness.runner.runNext(harness.taskId, harness.controller.signal); // controller -> writer
    await harness.runner.runNext(harness.taskId, harness.controller.signal); // writer publish V1 -> reviewer
    await harness.runner.runNext(harness.taskId, harness.controller.signal); // reviewer reject -> writer message input

    // The reject message routed to writer (V1 reference) must NOT have created
    // a new version, and the writer's rework input is now pending.
    const afterReject = await harness.workspace(harness.taskId);
    expect(afterReject.artifacts.map((a) => a.version)).toEqual([1]);

    // The writer's rework turn now runs: its AgentTurnInput must carry the
    // message summary AND the declared inject files together (cross-layer).
    await harness.runner.runNext(harness.taskId, harness.controller.signal); // writer rework
    const writerTurns = harness.runtime.turnInputs.filter((t) => t.agent.id === 'writer');
    expect(writerTurns).toHaveLength(2);
    const inputText = writerTurns[1].inputText;
    expect(inputText).toContain('请修改第二段。'); // send_message.summary (node.body)
    expect(inputText).toContain('上一版正文'); // inject `as` label
    expect(inputText).toContain(V1_BODY); // content.md injected
    expect(inputText).toContain('返修意见'); // inject `as` label
    expect(inputText).toContain('第二段节奏太慢'); // review.md injected

    // The loop then continues to V2 -> pass -> submit.
    await harness.runner.runNext(harness.taskId, harness.controller.signal); // writer publish V2 -> reviewer
    await harness.runner.runNext(harness.taskId, harness.controller.signal); // reviewer pass -> forward controller
    const submit = await harness.runner.runNext(harness.taskId, harness.controller.signal); // controller submit
    expect(submit.taskCompleted).toBe(true);
    const finalWorkspace = await harness.workspace(harness.taskId);
    expect(finalWorkspace.artifacts.map((a) => a.version)).toEqual([1, 2]);
    expect(finalWorkspace.artifacts.at(-1)?.final).toBe(true);
  });

  it('forward -> controller input is injected via the route declaration and stays zero-copy', async () => {
    const harness = await hubRunnerHarness({
      controller: [
        {
          kind: 'result',
          publicText: '分配写作任务',
          actions: [{ type: 'send_message', targetAgentId: 'writer', summary: '请写第一章。' }],
        },
        {
          kind: 'result',
          publicText: '审核通过，提交终稿。',
          actions: [{ type: 'submit_final_artifact' }],
        },
      ],
      writer: [writerPublishStep('第一章 V1', V1_BODY)],
      reviewer: [
        {
          kind: 'result',
          publicText: '审核通过并转交',
          actions: [
            {
              type: 'annotate_artifact',
              file: 'review.md',
              content: '---\nverdict: pass\n---\n## 意见\n通过',
            },
            { type: 'forward_input_version', targetAgentId: 'controller' },
          ],
        },
      ],
    });
    await seedInput(harness, {
      id: 'ev-input-controller',
      agentId: 'controller',
      sequence: 1,
      body: '开始生产',
    });

    await harness.runner.runNext(harness.taskId, harness.controller.signal); // controller -> writer
    await harness.runner.runNext(harness.taskId, harness.controller.signal); // writer publish V1 -> reviewer
    await harness.runner.runNext(harness.taskId, harness.controller.signal); // reviewer forward -> controller input

    // Zero-copy so far: still exactly one version (the reviewer/controller
    // never re-published anything).
    const workspace = await harness.workspace(harness.taskId);
    expect(workspace.artifacts.map((a) => a.version)).toEqual([1]);

    // The controller's forwarded turn: input injected per the reviewer->
    // controller artifact route declaration (通过的章节正文), not a blind
    // content hand-off.
    await harness.runner.runNext(harness.taskId, harness.controller.signal); // controller reads forwarded input
    const controllerTurns = harness.runtime.turnInputs.filter((t) => t.agent.id === 'controller');
    expect(controllerTurns).toHaveLength(2);
    const inputText = controllerTurns[1].inputText;
    expect(inputText).toContain('通过的章节正文');
    expect(inputText).toContain(V1_BODY);

    const submit = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(submit.taskCompleted).toBe(true);
    const finalWorkspace = await harness.workspace(harness.taskId);
    expect(finalWorkspace.artifacts.map((a) => a.version)).toEqual([1]);
    expect(finalWorkspace.artifacts.at(-1)?.final).toBe(true);
  });

  it('human synthesized guidance is preserved even when the input carries an inputVersion', async () => {
    const harness = await hubRunnerHarness({
      controller: [
        {
          kind: 'result',
          publicText: '分配写作任务',
          actions: [{ type: 'send_message', targetAgentId: 'writer', summary: '请写第一章。' }],
        },
        {
          kind: 'result',
          publicText: '提交终稿',
          actions: [{ type: 'submit_final_artifact' }],
        },
      ],
      writer: [writerPublishStep('第一章 V1', V1_BODY)],
      // reviewer intentionally unscripted: its superseded input never runs.
    });
    await seedInput(harness, {
      id: 'ev-input-controller',
      agentId: 'controller',
      sequence: 1,
      body: '开始生产',
    });
    await harness.runner.runNext(harness.taskId, harness.controller.signal); // controller -> writer
    await harness.runner.runNext(harness.taskId, harness.controller.signal); // writer publish V1 -> reviewer input

    // Scheduler supersede+synthesize (spec §7.2): supersede every pending
    // input, then synthesize a controller input carrying human guidance AND
    // the latest inputVersion. The synthetic node has no delivering route.
    const committed = await harness.events.read(harness.taskId);
    const reviewerInput = committed
      .map((entry) => entry.event)
      .find(
        (e): e is Extract<TaskEvent, { type: 'agent_input' }> =>
          e.type === 'agent_input' && e.node.agentId === 'reviewer',
      );
    expect(reviewerInput).toBeDefined();
    await harness.events.append(
      harness.taskId,
      makeTaskEvent({ type: 'pending_inputs_superseded', supersededNodeIds: [reviewerInput!.id] }),
    );
    await harness.events.append(
      harness.taskId,
      makeTaskEvent({
        id: 'ev-synth-controller',
        type: 'agent_input',
        node: makeEventNode({
          sequence: 20,
          agentId: 'controller',
          kind: 'input',
          title: '人工引导',
          body: '人工已批准，请按人工指示直接提交该版本。',
          attemptCount: 1,
          inputVersion: 1,
          humanAuthorized: true,
        }),
      }),
    );

    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result.committed).toBe(true);
    const synthTurn = harness.runtime.turnInputs.at(-1);
    expect(synthTurn?.agent.id).toBe('controller');
    // The guidance must survive: inputVersion must not trigger a content
    // hand-off that would replace the human instruction.
    expect(synthTurn?.inputText).toContain('人工已批准，请按人工指示直接提交该版本。');
  });
});

describe('turnPlanCompleted forward terminal id (spec §8.2)', () => {
  /** A minimal event carrying only the id (turnPlanCompleted checks id alone). */
  function eventWithId(id: string): TaskEvent {
    return makeTaskEvent({
      id,
      type: 'agent_input',
      node: makeEventNode({ sequence: 1, agentId: 'a', kind: 'input', title: 't', body: 'b' }),
    });
  }

  it('recognizes the forward terminal id `${turnId}-forward-input-0`', () => {
    expect(turnPlanCompleted([eventWithId('t1-forward-input-0')], 't1', 0)).toBe(true);
    expect(turnPlanCompleted([], 't1', 0)).toBe(false);
    // A non-forward id does not satisfy the forward terminal.
    expect(turnPlanCompleted([eventWithId('t1-message-input-0')], 't1', 0)).toBe(true); // send terminal
    expect(turnPlanCompleted([eventWithId('t1-artifact-input-1')], 't1', 0)).toBe(false); // wrong route count
  });

  it('recognizes the publish/send/submit/human terminal ids (regression)', () => {
    expect(turnPlanCompleted([eventWithId('t1-artifact-input-0')], 't1', 1)).toBe(true); // publish, 1 route
    expect(turnPlanCompleted([eventWithId('t1-artifact-input-1')], 't1', 2)).toBe(true); // publish, 2 routes
    expect(turnPlanCompleted([eventWithId('t1-message-input-0')], 't1', 0)).toBe(true); // send
    expect(turnPlanCompleted([eventWithId('t1-final')], 't1', 0)).toBe(true); // submit
    expect(turnPlanCompleted([eventWithId('t1-human-requested')], 't1', 0)).toBe(true); // human
  });
});
