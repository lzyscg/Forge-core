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
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskWorkspace } from '../../shared/contracts';
import { CoreService } from '../core-service';
import type { CorePaths } from '../storage/core-paths';
import type { EventStore } from '../storage/event-store';
import { TraceStore } from '../storage/trace-store';
import {
  catalogWithOneTemplate,
  disposeAllTestRoots,
  makeEventNode,
  makeTaskEvent,
  validTaskRequest,
} from '../test-support';
import { RuntimeAbortedError, RuntimeFailure } from './agent-runtime';
import { ActionCommitter } from './action-committer';
import { FakeAgentRuntime, type FakeScriptStep } from './fake-agent-runtime';
import { SkillService } from './skill-service';
import { TaskRunner, type RunNextResult } from './task-runner';
import { WorkspaceStore } from './workspace-store';
import { RecordingRuntime } from './test-support';

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
      content,
      format: 'markdown',
      artifactType: '终稿',
      title,
    },
    { type: 'publish_artifact', productionPackageRef: 'current' },
  ],
});

/** One legal reviewer turn: seal an inline review and message it to writer. */
const reviewerMessageTurn: FakeScriptStep = {
  kind: 'result',
  publicText: '审读完成',
  actions: [
    {
      type: 'finish_production',
      source: 'inline',
      content: '请修改第二段。',
      format: 'text',
      artifactType: null,
      title: null,
    },
    { type: 'send_message', targetAgentId: 'writer', productionPackageRef: 'current' },
  ],
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
    expect(turnInput?.inputText).toBe('第二轮输入');
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
              content: '封存正文',
              format: 'text',
              artifactType: null,
              title: null,
            },
            { type: 'send_message', targetAgentId: 'unknown', productionPackageRef: 'current' },
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
      reviewer: [
        {
          kind: 'result',
          publicText: '终稿提交',
          actions: [
            {
              type: 'finish_production',
              source: 'inline',
              content: '终稿正文',
              format: 'markdown',
              artifactType: '终稿',
              title: '终稿 V1',
            },
            { type: 'submit_final_artifact', productionPackageRef: 'current' },
          ],
        },
      ],
    });
    await seedInput(harness, { id: 'ev-input-reviewer', agentId: 'reviewer', sequence: 1, body: '审核' });

    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result).toMatchObject({ committed: true, taskCompleted: true, waitingHuman: false });
    const workspace = await harness.workspace(harness.taskId);
    expect(workspace.task.status).toBe('completed');
    expect(workspace.artifacts.at(-1)?.final).toBe(true);
  });

  it('submits a current_input_artifact package through the received hand-off', async () => {
    // writer publishes V1 (auto-routed), reviewer seals the RECEIVED artifact
    // and submits it as final — the platform resolves the reference, no new
    // artifact version is published (plan 2026-08-04 frozen decision 3/5).
    const harness = await runnerHarness({
      writer: [writerPublishTurn('章节 V1', '章节正文')],
      reviewer: [
        {
          kind: 'result',
          publicText: '审核通过，提交原稿。',
          actions: [
            { type: 'finish_production', source: 'current_input_artifact' },
            { type: 'submit_final_artifact', productionPackageRef: 'current' },
          ],
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
    expect(workspace.artifacts.at(-1)?.content).toBe('章节正文');
  });

  it('fails the attempt when current_input_artifact is sealed without a received artifact', async () => {
    const harness = await runnerHarness({
      reviewer: [
        {
          kind: 'result',
          publicText: '引用不存在的产物',
          actions: [
            { type: 'finish_production', source: 'current_input_artifact' },
            { type: 'submit_final_artifact', productionPackageRef: 'current' },
          ],
        },
      ],
    });
    // Plain seeded input: the node carries no artifactVersion.
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
            { type: 'send_message', targetAgentId: 'unknown', productionPackageRef: 'current' },
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
              content: '封存正文',
              format: 'markdown',
              artifactType: '终稿',
              title: '初稿 V1',
            },
            { type: 'publish_artifact', productionPackageRef: 'current' },
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
        { kind: 'thinking', text: '先思考，再产出。' },
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
      { kind: 'thinking', text: '想了想。' },
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
              workspaceFile: 'draft/v1.md',
              format: 'markdown',
              artifactType: '终稿',
              title: '工作区 V1',
            },
            { type: 'publish_artifact', productionPackageRef: 'current' },
          ],
        },
      ],
    });
    await seedInput(harness, { id: 'ev-input-writer', agentId: 'writer', sequence: 1, body: '开始' });
    await harness.workspaces.writeFile(harness.taskId, 'writer', 'draft/v1.md', '工作区草稿正文');

    const result = await harness.runner.runNext(harness.taskId, harness.controller.signal);
    expect(result).toMatchObject({ committed: true, attemptFailed: false });

    const artifact = await harness.service.artifacts.read(harness.taskId, 1);
    expect(artifact.content).toBe('工作区草稿正文');
    expect(artifact.meta.contentHash).toBe(
      createHash('sha256').update('工作区草稿正文', 'utf8').digest('hex'),
    );
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
              workspaceFile: 'missing/draft.md',
              format: 'markdown',
              artifactType: '终稿',
              title: '工作区 V1',
            },
            { type: 'publish_artifact', productionPackageRef: 'current' },
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
