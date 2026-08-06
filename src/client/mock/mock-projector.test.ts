import { describe, expect, it } from 'vitest';
import type { WorkspaceNode } from '../../shared/contracts';
import { REVIEWER_AGENT_ID, WRITER_AGENT_ID, templateFixture } from './__fixtures__/zhihu-single-chapter';
import type { MockTaskEvent, MockTaskRecord } from './mock-schema';
import { projectMockWorkspace, projectTaskStatus, projectTaskSummary } from './mock-projector';

const CREATED_AT = '2026-01-01T00:00:00.000Z';

function makeRecord(events: MockTaskEvent[]): MockTaskRecord {
  return {
    id: 'task-projected',
    name: 'sample task',
    templateId: templateFixture.template.id,
    templateName: templateFixture.template.name,
    frozenInput: { ...templateFixture.sampleInput },
    frozenTemplate: templateFixture.template,
    events,
    createdAt: CREATED_AT,
    updatedAt: events.length > 0 ? events[events.length - 1].at : CREATED_AT,
  };
}

function makeNode(
  id: string,
  sequence: number,
  agentId: string,
  overrides: Partial<WorkspaceNode> = {},
): WorkspaceNode {
  return {
    id,
    sequence,
    agentId,
    kind: 'input',
    title: 'sample node',
    body: 'sample body',
    status: 'active',
    attemptCount: 1,
    inputVersion: null,
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

describe('projectMockWorkspace', () => {
  it('projects an event-free record as ready with empty canvas data', () => {
    const workspace = projectMockWorkspace(makeRecord([]));
    expect(workspace.task.status).toBe('ready');
    expect(workspace.task.currentAgentName).toBeNull();
    expect(workspace.task.latestVersion).toBeNull();
    expect(workspace.task.diagnostic).toBeNull();
    expect(workspace.nodes).toEqual([]);
    expect(workspace.executedRoutes).toEqual([]);
    expect(workspace.artifacts).toEqual([]);
    expect(workspace.pendingHumanQuestion).toBeNull();
    expect(workspace.agents).toEqual(templateFixture.template.agents);
    expect(workspace.declaredRoutes).toEqual(templateFixture.template.routes);
    expect(workspace.templateVersion).toBe(templateFixture.template.version);
    expect(workspace.frozenInput).toEqual(templateFixture.sampleInput);
  });

  it('derives running status and the current agent name from agent_input', () => {
    const record = makeRecord([
      { type: 'task_started', at: '2026-01-01T00:00:01.000Z' },
      {
        type: 'agent_input',
        at: '2026-01-01T00:00:02.000Z',
        node: makeNode('n1', 1, WRITER_AGENT_ID),
      },
    ]);
    const summary = projectTaskSummary(record);
    expect(summary.status).toBe('running');
    const writer = templateFixture.template.agents.find((agent) => agent.id === WRITER_AGENT_ID);
    expect(summary.currentAgentName).toBe(writer?.name);
  });

  it('keeps every node and orders nodes and routes by sequence', () => {
    const record = makeRecord([
      { type: 'task_started', at: '2026-01-01T00:00:01.000Z' },
      {
        type: 'agent_input',
        at: '2026-01-01T00:00:02.000Z',
        node: makeNode('n3', 3, REVIEWER_AGENT_ID),
      },
      {
        type: 'agent_input',
        at: '2026-01-01T00:00:03.000Z',
        node: makeNode('n1', 1, WRITER_AGENT_ID),
      },
      {
        type: 'route_executed',
        at: '2026-01-01T00:00:04.000Z',
        route: {
          id: 'r2',
          sequence: 2,
          fromNodeId: 'n1',
          toNodeId: 'n3',
          kind: 'message',
          label: 'sample route late',
        },
      },
      {
        type: 'route_executed',
        at: '2026-01-01T00:00:05.000Z',
        route: {
          id: 'r1',
          sequence: 1,
          fromNodeId: 'n1',
          toNodeId: 'n3',
          kind: 'artifact',
          label: 'sample route early',
        },
      },
    ]);
    const workspace = projectMockWorkspace(record);
    expect(workspace.nodes.map((node) => node.id)).toEqual(['n1', 'n3']);
    expect(workspace.executedRoutes.map((route) => route.id)).toEqual(['r1', 'r2']);
  });

  it('increments attempt counts on retryable failures and stays running', () => {
    const record = makeRecord([
      { type: 'task_started', at: '2026-01-01T00:00:01.000Z' },
      {
        type: 'agent_input',
        at: '2026-01-01T00:00:02.000Z',
        node: makeNode('n1', 1, WRITER_AGENT_ID),
      },
      {
        type: 'agent_attempt_failed',
        at: '2026-01-01T00:00:03.000Z',
        nodeId: 'n1',
        message: 'temporary failure',
        retryable: true,
      },
    ]);
    const workspace = projectMockWorkspace(record);
    expect(workspace.task.status).toBe('running');
    const node = workspace.nodes.find((item) => item.id === 'n1');
    expect(node?.attemptCount).toBe(2);
    expect(node?.status).toBe('failed');
  });

  it('moves to retryable_failure on a non-retryable attempt failure', () => {
    const record = makeRecord([
      { type: 'task_started', at: '2026-01-01T00:00:01.000Z' },
      {
        type: 'agent_input',
        at: '2026-01-01T00:00:02.000Z',
        node: makeNode('n1', 1, WRITER_AGENT_ID),
      },
      {
        type: 'agent_attempt_failed',
        at: '2026-01-01T00:00:03.000Z',
        nodeId: 'n1',
        message: 'exhausted retries',
        retryable: false,
      },
    ]);
    expect(projectTaskStatus(record)).toBe('retryable_failure');
  });

  it('keeps attempt counts monotonic when the same node receives input again', () => {
    const record = makeRecord([
      { type: 'task_started', at: '2026-01-01T00:00:01.000Z' },
      {
        type: 'agent_input',
        at: '2026-01-01T00:00:02.000Z',
        node: makeNode('n1', 1, WRITER_AGENT_ID, { attemptCount: 1 }),
      },
      {
        type: 'agent_attempt_failed',
        at: '2026-01-01T00:00:03.000Z',
        nodeId: 'n1',
        message: 'temporary failure',
        retryable: true,
      },
      {
        type: 'agent_input',
        at: '2026-01-01T00:00:04.000Z',
        node: makeNode('n1', 1, WRITER_AGENT_ID, { attemptCount: 1, status: 'active' }),
      },
    ]);
    const workspace = projectMockWorkspace(record);
    const nodes = workspace.nodes.filter((node) => node.id === 'n1');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].attemptCount).toBe(2);
    expect(nodes[0].status).toBe('active');
  });

  it('projects artifacts only through artifact_published and finality through final_accepted', () => {
    const v1 = {
      id: 'art-1',
      version: 1,
      title: 'V1',
      files: [{ name: 'content.md', extract: 'content', content: 'first version' }],
      sourceNodeId: 'n1',
      createdAt: '2026-01-01T00:00:05.000Z',
      final: true,
    };
    const v2 = {
      id: 'art-2',
      version: 2,
      title: 'V2',
      files: [{ name: 'content.md', extract: 'content', content: 'second version' }],
      sourceNodeId: 'n3',
      createdAt: '2026-01-01T00:00:08.000Z',
      final: true,
    };
    const record = makeRecord([
      { type: 'task_started', at: '2026-01-01T00:00:01.000Z' },
      { type: 'artifact_published', at: v1.createdAt, artifact: v1 },
      { type: 'artifact_published', at: v2.createdAt, artifact: v2 },
    ]);

    let workspace = projectMockWorkspace(record);
    expect(workspace.artifacts.map((artifact) => artifact.version)).toEqual([1, 2]);
    expect(workspace.task.latestVersion).toBe(2);
    // Finality is decided by final_accepted, not by the publish payload.
    expect(workspace.artifacts.every((artifact) => artifact.final === false)).toBe(true);

    record.events.push({ type: 'final_accepted', at: '2026-01-01T00:00:09.000Z', artifactId: 'art-2' });
    workspace = projectMockWorkspace(record);
    expect(workspace.task.status).toBe('completed');
    expect(workspace.artifacts.find((artifact) => artifact.id === 'art-1')?.final).toBe(false);
    expect(workspace.artifacts.find((artifact) => artifact.id === 'art-2')?.final).toBe(true);
  });

  it('tracks the pending human question across request and answer', () => {
    const requested: MockTaskEvent = {
      type: 'human_requested',
      at: '2026-01-01T00:00:02.000Z',
      node: makeNode('n-h', 2, WRITER_AGENT_ID, { kind: 'human_request' }),
      question: '需要补充信息',
    };
    const record = makeRecord([
      { type: 'task_started', at: '2026-01-01T00:00:01.000Z' },
      requested,
    ]);

    let workspace = projectMockWorkspace(record);
    expect(workspace.task.status).toBe('waiting_human');
    expect(workspace.pendingHumanQuestion).toBe('需要补充信息');

    record.events.push({
      type: 'human_answered',
      at: '2026-01-01T00:00:03.000Z',
      node: makeNode('n-ha', 3, WRITER_AGENT_ID, {
        kind: 'human_answer',
        status: 'confirmed',
        body: '答案',
      }),
      answer: '答案',
    });
    workspace = projectMockWorkspace(record);
    expect(workspace.task.status).toBe('running');
    expect(workspace.pendingHumanQuestion).toBeNull();
    expect(workspace.nodes.map((node) => node.id)).toContain('n-ha');
  });

  it('derives stopped, interrupted and resumed states from lifecycle events', () => {
    const base: MockTaskEvent[] = [{ type: 'task_started', at: '2026-01-01T00:00:01.000Z' }];
    expect(projectTaskStatus(makeRecord([...base]))).toBe('running');
    expect(
      projectTaskStatus(makeRecord([...base, { type: 'task_stopped', at: '2026-01-01T00:00:02.000Z' }])),
    ).toBe('stopped');
    expect(
      projectTaskStatus(
        makeRecord([...base, { type: 'task_interrupted', at: '2026-01-01T00:00:02.000Z' }]),
      ),
    ).toBe('interrupted');
    expect(
      projectTaskStatus(
        makeRecord([
          ...base,
          { type: 'task_stopped', at: '2026-01-01T00:00:02.000Z' },
          { type: 'task_resumed', at: '2026-01-01T00:00:03.000Z' },
        ]),
      ),
    ).toBe('running');
  });

  it('exposes the current agent name only while running or awaiting human input', () => {
    const started: MockTaskEvent[] = [
      { type: 'task_started', at: '2026-01-01T00:00:01.000Z' },
      {
        type: 'agent_input',
        at: '2026-01-01T00:00:02.000Z',
        node: makeNode('n1', 1, WRITER_AGENT_ID),
      },
    ];
    expect(projectTaskSummary(makeRecord(started)).currentAgentName).not.toBeNull();

    const completed: MockTaskEvent[] = [
      ...started,
      {
        type: 'artifact_published',
        at: '2026-01-01T00:00:03.000Z',
        artifact: {
          id: 'art-1',
          version: 1,
          title: 'V1',
          files: [{ name: 'content.md', extract: 'content', content: 'done' }],
          sourceNodeId: 'n1',
          createdAt: '2026-01-01T00:00:03.000Z',
          final: false,
        },
      },
      { type: 'final_accepted', at: '2026-01-01T00:00:04.000Z', artifactId: 'art-1' },
    ];
    const summary = projectTaskSummary(makeRecord(completed));
    expect(summary.status).toBe('completed');
    expect(summary.currentAgentName).toBeNull();
  });

  it('does not mutate its input record', () => {
    const record = deepFreeze(
      makeRecord([
        { type: 'task_started', at: '2026-01-01T00:00:01.000Z' },
        {
          type: 'agent_input',
          at: '2026-01-01T00:00:02.000Z',
          node: makeNode('n1', 1, WRITER_AGENT_ID),
        },
        {
          type: 'agent_attempt_failed',
          at: '2026-01-01T00:00:03.000Z',
          nodeId: 'n1',
          message: 'temporary failure',
          retryable: true,
        },
      ]),
    );
    const snapshot = JSON.stringify(record);
    projectMockWorkspace(record);
    projectTaskSummary(record);
    expect(JSON.stringify(record)).toBe(snapshot);
  });
});

describe('skill_loaded folding (plan Task E4 Step 1)', () => {
  it('upserts a confirmed skill node and syncs the last agent', () => {
    const record = makeRecord([
      { type: 'task_started', at: '2026-01-01T00:00:01.000Z' },
      {
        type: 'agent_input',
        at: '2026-01-01T00:00:02.000Z',
        node: makeNode('n1', 1, WRITER_AGENT_ID),
      },
      {
        type: 'agent_result',
        at: '2026-01-01T00:00:03.000Z',
        node: makeNode('n2', 2, WRITER_AGENT_ID, {
          kind: 'result',
          status: 'confirmed',
          turnId: 'turn-task-1',
        }),
      },
      {
        type: 'skill_loaded',
        at: '2026-01-01T00:00:04.000Z',
        node: makeNode('n3', 3, REVIEWER_AGENT_ID, {
          kind: 'skill',
          status: 'confirmed',
          title: 'skill-sample',
          body: 'abcdef123456',
          turnId: 'turn-task-1',
        }),
      },
    ]);
    const workspace = projectMockWorkspace(record);
    expect(workspace.task.status).toBe('running');
    const skill = workspace.nodes.find((node) => node.id === 'n3');
    expect(skill).toEqual({
      id: 'n3',
      sequence: 3,
      agentId: REVIEWER_AGENT_ID,
      kind: 'skill',
      title: 'skill-sample',
      body: 'abcdef123456',
      status: 'confirmed',
      attemptCount: 1,
      inputVersion: null,
      turnId: 'turn-task-1',
    });
    expect(workspace.nodes.map((node) => node.id)).toEqual(['n1', 'n2', 'n3']);
    // The skill's agent becomes the current agent while the task runs.
    const reviewer = templateFixture.template.agents.find(
      (agent) => agent.id === REVIEWER_AGENT_ID,
    );
    expect(workspace.task.currentAgentName).toBe(reviewer?.name);
  });

  it('never changes lifecycle status or finality on its own', () => {
    const skillEvent: MockTaskEvent = {
      type: 'skill_loaded',
      at: '2026-01-01T00:00:02.000Z',
      node: makeNode('n-skill', 1, WRITER_AGENT_ID, {
        kind: 'skill',
        status: 'confirmed',
        turnId: null,
      }),
    };
    // No lifecycle event at all: the fold stays ready.
    expect(projectTaskStatus(makeRecord([skillEvent]))).toBe('ready');
    // stopped stays stopped even when a skill event lands afterwards.
    expect(
      projectTaskStatus(
        makeRecord([
          { type: 'task_started', at: '2026-01-01T00:00:01.000Z' },
          { type: 'task_stopped', at: '2026-01-01T00:00:02.000Z' },
          skillEvent,
        ]),
      ),
    ).toBe('stopped');
    // Completion and finality are still decided exclusively by final_accepted.
    const artifact = {
      id: 'art-1',
      version: 1,
      title: 'V1',
      files: [{ name: 'content.md', extract: 'content', content: 'done' }],
      sourceNodeId: 'n1',
      createdAt: '2026-01-01T00:00:03.000Z',
      final: false,
    };
    const workspace = projectMockWorkspace(
      makeRecord([
        { type: 'task_started', at: '2026-01-01T00:00:01.000Z' },
        {
          type: 'agent_input',
          at: '2026-01-01T00:00:02.000Z',
          node: makeNode('n1', 1, WRITER_AGENT_ID),
        },
        { type: 'artifact_published', at: artifact.createdAt, artifact },
        skillEvent,
        { type: 'final_accepted', at: '2026-01-01T00:00:04.000Z', artifactId: 'art-1' },
      ]),
    );
    expect(workspace.task.status).toBe('completed');
    expect(workspace.artifacts[0].final).toBe(true);
    expect(workspace.nodes.some((node) => node.kind === 'skill')).toBe(true);
  });
});
