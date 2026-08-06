// @vitest-environment node
/**
 * ActionCommitter tests (plan Phase C Task 3 Steps 1/4/5/6; rebuilt for the
 * production/dispatch turn contract by plan 2026-08-04 Task 4, spec §4/§5.3).
 *
 * The committer validates the complete buffered action set before writing
 * anything — phase order/cardinality of the turn contract, contract
 * conformance, route/authorization/final checks — then commits in the
 * deterministic order agent result → skill loads → sealed-package artifact
 * files/events → routes and target input nodes → human request or final
 * submission. Sealed packages are the ONLY delivery source: dispatch actions
 * carry `productionPackageRef: 'current'` and nothing else. Final output is
 * accepted only after independent system validation; natural language and
 * ordinary publishes never complete a task (spec §6.4). A mid-plan file
 * failure appends a public node failure and never overwrites prior
 * committed items; recommitting the same Turn replays instead of
 * duplicating.
 *
 * The cases name the agents of the storage-level `valid` template fixture —
 * business vocabulary is confined to fixture data and this test file; the
 * ActionCommitter module itself carries none.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreService } from '../core-service';
import type { CorePaths } from '../storage/core-paths';
import { ArtifactStore } from '../storage/artifact-store';
import { EventStore } from '../storage/event-store';
import { TaskStore } from '../storage/task-store';
import type { TaskWorkspace } from '../../shared/contracts';
import {
  catalogWithOneTemplate,
  disposeAllTestRoots,
  makeEventNode,
  makeTaskEvent,
  validTaskRequest,
} from '../test-support';
import {
  ActionCommitter,
  COMMIT_ERROR_CODES,
  type CommitContext,
  type CommitResult,
  type CurrentInputArtifact,
} from './action-committer';
import { SkillService } from './skill-service';
import {
  buildCommitContext,
  createContextFor,
  frozenSnapshotFixture,
  type CommitFixtureEnvironment,
} from './test-support';

let paths: CorePaths;
let events: EventStore;
let artifacts: ArtifactStore;
let committer: ActionCommitter;
let skillService: SkillService;
let taskId: string;
let env: CommitFixtureEnvironment;
let contextFor: (agentId: string) => ReturnType<typeof buildCommitContext>;
let projector: { workspace(id: string): Promise<TaskWorkspace> };

/** Neutral inline finish action sealing a declaration-aligned package. */
function finishInline(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'finish_production',
    source: 'inline',
    content: '封存正文',
    format: 'markdown',
    artifactType: '终稿',
    title: '初稿 V1',
    ...overrides,
  };
}

const PUBLISH_CURRENT = { type: 'publish_artifact', productionPackageRef: 'current' } as const;
const SUBMIT_CURRENT = { type: 'submit_final_artifact', productionPackageRef: 'current' } as const;

beforeEach(async () => {
  const fixture = await catalogWithOneTemplate();
  paths = fixture.paths;
  const tasks = new TaskStore(paths, fixture.catalog);
  events = new EventStore(paths);
  artifacts = new ArtifactStore(paths);
  const skills = new SkillService({ paths, tasks, events });
  skillService = skills;
  committer = new ActionCommitter({ events, artifacts, skills });
  const created = await tasks.create(validTaskRequest());
  taskId = created.id;

  // Committed input nodes for both frozen agents (runner's job in Task 4).
  await events.append(
    taskId,
    makeTaskEvent({
      id: 'ev-input-writer',
      type: 'agent_input',
      node: makeEventNode({ sequence: 1, agentId: 'writer', kind: 'input', title: '输入' }),
    }),
  );
  await events.append(
    taskId,
    makeTaskEvent({
      id: 'ev-input-reviewer',
      type: 'agent_input',
      node: makeEventNode({ sequence: 2, agentId: 'reviewer', kind: 'input', title: '输入' }),
    }),
  );

  const frozen = await tasks.readFrozenTemplate(taskId);
  env = {
    taskId,
    frozen,
    inputNodeIds: { writer: 'ev-input-writer', reviewer: 'ev-input-reviewer' },
  };
  contextFor = createContextFor(env);

  const service = new CoreService(paths);
  projector = { workspace: (id: string) => service.getWorkspace(id) };
});

afterEach(() => {
  disposeAllTestRoots();
});

describe('ActionCommitter two-phase validation (plan 2026-08-04 Task 4, spec §5.3)', () => {
  it('rejects an empty action set as AGENT_PHASE_INCOMPLETE with zero writes', async () => {
    const before = await events.read(taskId);
    await expect(committer.validateAndCommit(contextFor('writer'), []))
      .rejects.toMatchObject({ code: 'AGENT_PHASE_INCOMPLETE', retryable: false });
    expect(await events.read(taskId)).toEqual(before);
  });

  it('rejects a text-only turn (no finish_production) before any write', async () => {
    const before = await events.read(taskId);
    await expect(
      committer.validateAndCommit(buildCommitContext(env, 'writer', { publicText: '完成了' }), [
        { type: 'load_skill', skillId: 'style-guide' },
      ]),
    ).rejects.toMatchObject({ code: 'AGENT_PHASE_INCOMPLETE', retryable: false });
    expect(await events.read(taskId)).toEqual(before);
  });

  it('rejects a dispatch before finish_production as AGENT_PHASE_ORDER_INVALID', async () => {
    const before = await events.read(taskId);
    await expect(committer.validateAndCommit(contextFor('writer'), [PUBLISH_CURRENT]))
      .rejects.toMatchObject({ code: 'AGENT_PHASE_ORDER_INVALID', retryable: false });
    expect(await events.read(taskId)).toEqual(before);
    expect(await artifacts.list(taskId)).toEqual([]);
  });

  it('rejects a sealed package without any dispatch as AGENT_PHASE_INCOMPLETE', async () => {
    const before = await events.read(taskId);
    await expect(
      committer.validateAndCommit(contextFor('writer'), [finishInline()]),
    ).rejects.toMatchObject({ code: 'AGENT_PHASE_INCOMPLETE', retryable: false });
    expect(await events.read(taskId)).toEqual(before);
  });

  it('rejects two dispatch actions as AGENT_DISPATCH_CARDINALITY_INVALID', async () => {
    const before = await events.read(taskId);
    await expect(
      committer.validateAndCommit(contextFor('reviewer'), [
        finishInline({ format: 'text', artifactType: null, title: null }),
        { type: 'send_message', targetAgentId: 'writer', productionPackageRef: 'current' },
        SUBMIT_CURRENT,
      ]),
    ).rejects.toMatchObject({ code: 'AGENT_DISPATCH_CARDINALITY_INVALID', retryable: false });
    expect(await events.read(taskId)).toEqual(before);
  });

  it('rejects a second finish_production as AGENT_PHASE_ORDER_INVALID', async () => {
    await expect(
      committer.validateAndCommit(contextFor('writer'), [
        finishInline(),
        finishInline({ content: '第二次封存' }),
        PUBLISH_CURRENT,
      ]),
    ).rejects.toMatchObject({ code: 'AGENT_PHASE_ORDER_INVALID', retryable: false });
  });

  it('rejects load_skill after sealing as AGENT_PHASE_ORDER_INVALID', async () => {
    await expect(
      committer.validateAndCommit(contextFor('writer'), [
        finishInline(),
        { type: 'load_skill', skillId: 'style-guide' },
        PUBLISH_CURRENT,
      ]),
    ).rejects.toMatchObject({ code: 'AGENT_PHASE_ORDER_INVALID', retryable: false });
  });

  it('rejects anything after the one dispatch', async () => {
    await expect(
      committer.validateAndCommit(contextFor('writer'), [
        finishInline(),
        PUBLISH_CURRENT,
        { type: 'load_skill', skillId: 'style-guide' },
      ]),
    ).rejects.toMatchObject({ code: 'AGENT_DISPATCH_CARDINALITY_INVALID', retryable: false });
  });

  it('accepts request_human_input as the sole first action without a package', async () => {
    const result = await committer.validateAndCommit(contextFor('writer'), [
      { type: 'request_human_input', question: '是否继续？' },
    ]);
    expect(result.waitingHuman).toBe(true);
    expect(result.phase).toEqual({
      state: 'waiting_human',
      dispatchAction: 'request_human_input',
      target: null,
      message: null,
    });
    expect((await projector.workspace(taskId)).task.status).toBe('waiting_human');
  });

  it('rejects request_human_input followed by any other action', async () => {
    const before = await events.read(taskId);
    await expect(
      committer.validateAndCommit(contextFor('writer'), [
        { type: 'request_human_input', question: '是否继续？' },
        finishInline(),
      ]),
    ).rejects.toMatchObject({ code: 'AGENT_DISPATCH_CARDINALITY_INVALID', retryable: false });
    expect(await events.read(taskId)).toEqual(before);
  });

  it('rejects request_human_input mid-production (after load_skill, before sealing)', async () => {
    await expect(
      committer.validateAndCommit(contextFor('writer'), [
        { type: 'load_skill', skillId: 'style-guide' },
        { type: 'request_human_input', question: '现在问？' },
      ]),
    ).rejects.toMatchObject({ code: 'AGENT_PHASE_ORDER_INVALID', retryable: false });
  });
});

describe('ActionCommitter sealed-package dispatch semantics (frozen decision 5)', () => {
  it('publishes the sealed package for writer and routes the artifact hand-off', async () => {
    const result = await committer.validateAndCommit(contextFor('writer'), [
      finishInline(),
      PUBLISH_CURRENT,
    ]);
    expect(result.taskCompleted).toBe(false);
    expect(result.publishedVersions).toEqual([1]);
    expect(result.nextAgentIds).toEqual(['reviewer']);
    expect(result.phase).toEqual({
      state: 'dispatched',
      dispatchAction: 'publish_artifact',
      target: null,
      message: '已发布产物「初稿 V1」v1',
    });
    const workspace = await projector.workspace(taskId);
    expect(workspace.artifacts).toHaveLength(1);
    expect(workspace.artifacts[0].content).toBe('封存正文');
    expect(workspace.executedRoutes).toHaveLength(1);
    expect(workspace.executedRoutes[0].kind).toBe('artifact');
    const inputNode = workspace.nodes.find(
      (node) => node.id === workspace.executedRoutes[0].toNodeId,
    );
    expect(inputNode?.agentId).toBe('reviewer');
    expect(inputNode?.artifactVersion).toBe(1);
  });

  it('delivers the sealed text as the routed message body for reviewer', async () => {
    const result = await committer.validateAndCommit(contextFor('reviewer'), [
      finishInline({ content: '请修改第二段。', format: 'text', artifactType: null, title: null }),
      { type: 'send_message', targetAgentId: 'writer', productionPackageRef: 'current' },
    ]);
    expect(result.waitingHuman).toBe(false);
    expect(result.nextAgentIds).toEqual(['writer']);
    expect(result.phase).toEqual({
      state: 'dispatched',
      dispatchAction: 'send_message',
      target: 'writer',
      message: null,
    });
    expect(result.committedEvents.map((entry) => entry.type)).toEqual([
      'agent_result',
      'route_executed',
      'agent_input',
    ]);
    const workspace = await projector.workspace(taskId);
    expect(workspace.executedRoutes[0].kind).toBe('message');
    const inputNode = workspace.nodes.find(
      (node) => node.id === workspace.executedRoutes[0].toNodeId,
    );
    expect(inputNode?.agentId).toBe('writer');
    expect(inputNode?.body).toBe('请修改第二段。');
    expect(workspace.artifacts).toEqual([]);
  });

  it('submits a sealed inline package by publishing then accepting the final', async () => {
    const result = await committer.validateAndCommit(contextFor('reviewer'), [
      finishInline({ content: '终稿正文', title: '终稿 V1' }),
      SUBMIT_CURRENT,
    ]);
    expect(result.taskCompleted).toBe(true);
    expect(result.publishedVersions).toEqual([1]);
    expect((await projector.workspace(taskId)).artifacts.at(-1)?.final).toBe(true);
  });

  it('submits a current_input_artifact package through the received artifact', async () => {
    // Turn 1: writer publishes and the artifact auto-routes to reviewer.
    const first = await committer.validateAndCommit(contextFor('writer'), [
      finishInline({ content: '章节正文', title: '章节' }),
      PUBLISH_CURRENT,
    ]);
    expect(first.nextAgentIds).toEqual(['reviewer']);
    const published = await artifacts.read(taskId, first.publishedVersions[0]);

    // Turn 2: reviewer seals the RECEIVED artifact and submits it; the
    // platform resolves the reference, the model supplies no version.
    const received: CurrentInputArtifact = {
      artifactId: published.meta.id,
      version: published.meta.version,
      title: published.meta.title,
      format: published.meta.format,
      content: published.content,
      sourceNodeId: published.meta.sourceNodeId,
    };
    const context = buildCommitContext(env, 'reviewer', { currentInputArtifact: received });
    const second = await committer.validateAndCommit(context, [
      { type: 'finish_production', source: 'current_input_artifact' },
      SUBMIT_CURRENT,
    ]);
    expect(second.taskCompleted).toBe(true);
    expect(second.publishedVersions).toEqual([]); // nothing re-published
    const workspace = await projector.workspace(taskId);
    expect(workspace.task.status).toBe('completed');
    expect(workspace.artifacts).toHaveLength(1);
    expect(workspace.artifacts.at(-1)?.final).toBe(true);
    expect(workspace.artifacts.at(-1)?.version).toBe(first.publishedVersions[0]);
  });

  it('rejects current_input_artifact when the input carries no artifact', async () => {
    const before = await events.read(taskId);
    await expect(
      committer.validateAndCommit(contextFor('reviewer'), [
        { type: 'finish_production', source: 'current_input_artifact' },
        SUBMIT_CURRENT,
      ]),
    ).rejects.toMatchObject({ code: 'ACTION_SET_INVALID', retryable: false });
    expect(await events.read(taskId)).toEqual(before);
  });

  it('accepts a message-only package without publication metadata', async () => {
    const before = await events.read(taskId);
    await expect(
      committer.validateAndCommit(contextFor('reviewer'), [
        finishInline({ format: 'text', artifactType: null, title: null }),
        { type: 'send_message', targetAgentId: 'writer', productionPackageRef: 'current' },
      ]),
    ).resolves.toMatchObject({ taskCompleted: false });
    // Message-only packages never stage artifacts.
    expect(await artifacts.list(taskId)).toEqual([]);
    expect((await events.read(taskId)).length).toBe(before.length + 3);
  });

  it('rejects publishing or submitting a package missing publication metadata', async () => {
    const before = await events.read(taskId);
    await expect(
      committer.validateAndCommit(contextFor('writer'), [
        finishInline({ artifactType: null, title: null }),
        PUBLISH_CURRENT,
      ]),
    ).rejects.toMatchObject({ code: 'ACTION_SET_INVALID', retryable: false });
    expect(await events.read(taskId)).toEqual(before);
    expect(await artifacts.list(taskId)).toEqual([]);
  });

  it('rejects a final submission whose sealed format misses the declaration', async () => {
    const before = await events.read(taskId);
    await expect(
      committer.validateAndCommit(contextFor('reviewer'), [
        finishInline({ format: 'text' }),
        SUBMIT_CURRENT,
      ]),
    ).rejects.toMatchObject({ code: 'FINAL_DECLARATION_MISMATCH', retryable: false });
    expect(await events.read(taskId)).toEqual(before);
    expect(await artifacts.list(taskId)).toEqual([]);
  });

  it('rejects a final submission whose sealed type misses the declaration', async () => {
    await expect(
      committer.validateAndCommit(contextFor('reviewer'), [
        finishInline({ artifactType: '别的类型' }),
        SUBMIT_CURRENT,
      ]),
    ).rejects.toMatchObject({ code: 'FINAL_DECLARATION_MISMATCH', retryable: false });
  });

  it('rejects an unreachable received artifact at validation with zero writes (review F2)', async () => {
    // The received artifact claims a producer no declared artifact route
    // connects to the submitter — reachability must fail BEFORE any write,
    // never as a half commit that already recorded the agent result.
    await events.append(
      taskId,
      makeTaskEvent({
        id: 'ev-ghost-result',
        type: 'agent_result',
        node: makeEventNode({
          sequence: 3,
          agentId: 'ghost-producer',
          kind: 'result',
          title: '结果',
        }),
      }),
    );
    const before = await events.read(taskId);
    const received: CurrentInputArtifact = {
      artifactId: 'artifact-ghost',
      version: 1,
      title: '来路不明的产物',
      format: 'markdown',
      content: '正文',
      sourceNodeId: 'ev-ghost-result',
    };
    const context = buildCommitContext(env, 'reviewer', { currentInputArtifact: received });
    await expect(
      committer.validateAndCommit(context, [
        { type: 'finish_production', source: 'current_input_artifact' },
        SUBMIT_CURRENT,
      ]),
    ).rejects.toMatchObject({ code: 'FINAL_NOT_REACHABLE', retryable: false });
    // Nothing at all was written: no agent result, no failure marker.
    expect(await events.read(taskId)).toEqual(before);
    expect(await artifacts.list(taskId)).toEqual([]);
  });
});

describe('ActionCommitter contract conformance (spec §6)', () => {
  it('rejects a production source the contract does not allow', async () => {
    // The writer contract allows inline/workspace_file only.
    await expect(
      committer.validateAndCommit(contextFor('writer'), [
        { type: 'finish_production', source: 'current_input_artifact' },
        PUBLISH_CURRENT,
      ]),
    ).rejects.toMatchObject({ code: 'ACTION_SET_INVALID', retryable: false });
  });

  it('rejects a sealed format the contract does not allow', async () => {
    await expect(
      committer.validateAndCommit(contextFor('writer'), [
        finishInline({ format: 'text' }),
        PUBLISH_CURRENT,
      ]),
    ).rejects.toMatchObject({ code: 'ACTION_SET_INVALID', retryable: false });
  });

  it('rejects a dispatch intent the contract does not allow', async () => {
    // The writer contract allows publish_artifact only.
    await expect(
      committer.validateAndCommit(contextFor('writer'), [
        finishInline({ format: 'markdown' }),
        { type: 'send_message', targetAgentId: 'reviewer', productionPackageRef: 'current' },
      ]),
    ).rejects.toMatchObject({ code: 'ACTION_SET_INVALID', retryable: false });
  });

  it('rejects a message target that misses the contract target', async () => {
    // reviewer's contract sends to writer; any other target is refused even
    // though the route check would fail first for unknown agents.
    await expect(
      committer.validateAndCommit(contextFor('reviewer'), [
        finishInline({ format: 'text', artifactType: null, title: null }),
        { type: 'send_message', targetAgentId: 'unknown', productionPackageRef: 'current' },
      ]),
    ).rejects.toMatchObject({ code: 'ROUTE_NOT_ALLOWED', retryable: false });
  });

  it('rejects a commit context without a turn contract', async () => {
    const legacyAgent = { ...env.frozen.agents[0], turnContract: null };
    const context: CommitContext = {
      ...buildCommitContext(env, 'writer'),
      currentAgent: legacyAgent,
      turnContract: null,
    };
    await expect(
      committer.validateAndCommit(context, [finishInline(), PUBLISH_CURRENT]),
    ).rejects.toMatchObject({ code: 'ACTION_SET_INVALID', retryable: false });
  });
});

describe('ActionCommitter multi-target dispatch candidate sets (plan 2026-08-06)', () => {
  /** Builds a context whose contract dispatches to a custom candidate set. */
  function contextWithTargets(
    agentId: 'writer' | 'reviewer',
    targets: NonNullable<CommitContext['turnContract']>['dispatch']['targets'],
  ): CommitContext {
    const base = buildCommitContext(env, agentId);
    const contract = base.turnContract;
    if (contract === null) {
      throw new Error('the fixture contract is null');
    }
    return {
      ...base,
      turnContract: { ...contract, dispatch: { ...contract.dispatch, targets } },
    };
  }

  it('accepts send_message to any agent inside the declared candidate set', async () => {
    // writer is both the declared message route target and one of the two
    // candidates; the commit must pass the route AND the candidate check.
    const result = await committer.validateAndCommit(
      contextWithTargets('reviewer', { send_message: ['writer', 'producer'] }),
      [
        finishInline({ format: 'text', artifactType: null, title: null }),
        { type: 'send_message', targetAgentId: 'writer', productionPackageRef: 'current' },
      ],
    );
    expect(result.committedEvents.some((event) => event.type === 'route_executed')).toBe(true);
  });

  it('rejects send_message to an agent outside the candidate set even on a declared route', async () => {
    // writer IS the declared route target, but the candidate set excludes it.
    await expect(
      committer.validateAndCommit(
        contextWithTargets('reviewer', { send_message: ['producer'] }),
        [
          finishInline({ format: 'text', artifactType: null, title: null }),
          { type: 'send_message', targetAgentId: 'writer', productionPackageRef: 'current' },
        ],
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_NOT_ALLOWED', retryable: false });
  });

  it('accepts publish_artifact when at least one candidate matches a declared artifact route', async () => {
    // writer's only artifact route ends at reviewer; reviewer is in the set.
    await expect(
      committer.validateAndCommit(
        contextWithTargets('writer', { publish_artifact: ['reviewer', 'editor'] }),
        [finishInline(), PUBLISH_CURRENT],
      ),
    ).resolves.toMatchObject({ publishedVersions: [1] });
  });

  it('rejects publish_artifact when no candidate matches any artifact route', async () => {
    await expect(
      committer.validateAndCommit(
        contextWithTargets('writer', { publish_artifact: ['editor'] }),
        [finishInline(), PUBLISH_CURRENT],
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_NOT_ALLOWED', retryable: false });
  });
});

describe('ActionCommitter authorization, routes and final (kept rules)', () => {
  it('rejects an undeclared route without committing any action', async () => {
    // reviewer may send messages, but only to writer — never an unknown agent.
    const before = await events.read(taskId);
    await expect(
      committer.validateAndCommit(contextFor('reviewer'), [
        finishInline({ format: 'text', artifactType: null, title: null }),
        { type: 'send_message', targetAgentId: 'unknown', productionPackageRef: 'current' },
      ]),
    ).rejects.toMatchObject({ code: 'ROUTE_NOT_ALLOWED' });
    expect(await events.read(taskId)).toEqual(before);
  });

  it('rejects a final submission from an agent outside the declared submitters', async () => {
    const neutralEnv: CommitFixtureEnvironment = {
      taskId: 'task-neutral',
      frozen: frozenSnapshotFixture(),
      inputNodeIds: {},
    };
    const neutralContextFor = createContextFor(neutralEnv);
    await expect(
      committer.validateAndCommit(neutralContextFor('agent-alpha'), [
        finishInline(),
        SUBMIT_CURRENT,
      ]),
    ).rejects.toMatchObject({ code: 'FINAL_SUBMITTER_NOT_ALLOWED', retryable: false });
    expect(await events.read('task-neutral')).toEqual([]);
  });

  it('rejects a Skill load not authorized to the current agent with zero writes', async () => {
    const before = await events.read(taskId);
    await expect(
      committer.validateAndCommit(contextFor('writer'), [
        { type: 'load_skill', skillId: 'review-checklist' },
        finishInline(),
        PUBLISH_CURRENT,
      ]),
    ).rejects.toMatchObject({ code: 'SKILL_NOT_AUTHORIZED', retryable: false });
    expect(await events.read(taskId)).toEqual(before);
  });

  it('rejects a Turn exceeding the action count limit with zero writes', async () => {
    const neutralEnv: CommitFixtureEnvironment = {
      taskId: 'task-neutral',
      frozen: frozenSnapshotFixture(),
      inputNodeIds: {},
    };
    const actions = Array.from({ length: 33 }, () => ({
      type: 'load_skill',
      skillId: 'skill-alpha',
    }));
    await expect(
      committer.validateAndCommit(createContextFor(neutralEnv)('agent-alpha'), actions),
    ).rejects.toMatchObject({ code: 'TOO_MANY_ACTIONS', retryable: false });
    expect(await events.read('task-neutral')).toEqual([]);
  });

  it('rejects an unsafe turn id before deriving any event id', async () => {
    const neutralEnv: CommitFixtureEnvironment = {
      taskId: 'task-neutral',
      frozen: frozenSnapshotFixture(),
      inputNodeIds: {},
    };
    const context = buildCommitContext(neutralEnv, 'agent-alpha', { turnId: '../evil' });
    await expect(committer.validateAndCommit(context, []))
      .rejects.toMatchObject({ code: 'COMMIT_CONTEXT_INVALID', retryable: false });
    expect(await events.read('task-neutral')).toEqual([]);
  });

  it('commits a skill_loaded event after the agent result', async () => {
    const result = await committer.validateAndCommit(contextFor('writer'), [
      { type: 'load_skill', skillId: 'style-guide' },
      finishInline(),
      PUBLISH_CURRENT,
    ]);
    const types = result.committedEvents.map((entry) => entry.type);
    expect(types[0]).toBe('agent_result');
    expect(types).toContain('skill_loaded');
    const loadedIds = (await skillService.loadedSkillsFor(taskId, 'writer')).map((skill) => skill.id);
    expect(loadedIds).toEqual(['style-guide']);
  });
});

describe('ActionCommitter system final exit independence', () => {
  it('never completes a task from natural language or ordinary publishing', async () => {
    const talking = buildCommitContext(env, 'reviewer', {
      publicText: 'final output finished, the task is complete',
    });
    const result = await committer.validateAndCommit(talking, [
      finishInline({ format: 'text', artifactType: null, title: null }),
      { type: 'send_message', targetAgentId: 'writer', productionPackageRef: 'current' },
    ]);
    expect(result.taskCompleted).toBe(false);
    expect((await projector.workspace(taskId)).task.status).not.toBe('completed');
  });
});

describe('ActionCommitter mid-plan failure and replay', () => {
  it('appends a public node failure and never overwrites prior items', async () => {
    const context = buildCommitContext(env, 'reviewer');
    const actions = [finishInline({ content: '终稿正文', title: '终稿 V1' }), SUBMIT_CURRENT];

    // Injected publish failure: deterministic on every platform (POSIX chmod
    // bits do not restrict writes under Windows), and it lands strictly
    // AFTER the agent result event commits — the exact mid-plan window.
    let remainingFailures = 1;
    const failingArtifacts = new Proxy(artifacts, {
      get(target, prop, receiver) {
        if (prop === 'publish') {
          return async (...args: Parameters<ArtifactStore['publish']>) => {
            if (remainingFailures > 0) {
              remainingFailures -= 1;
              throw new Error('scripted artifact store failure');
            }
            return target.publish(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const failingCommitter = new ActionCommitter({
      events,
      artifacts: failingArtifacts,
      skills: skillService,
    });

    await expect(failingCommitter.validateAndCommit(context, actions))
      .rejects.toMatchObject({ code: 'COMMIT_INTERRUPTED', retryable: false });

    const failed = await events.read(taskId);
    const types = failed.map((committed) => committed.event.type);
    expect(types).toContain('agent_result');
    expect(types).toContain('agent_attempt_failed');
    expect(types).not.toContain('artifact_published');
    expect(types).not.toContain('final_submission_accepted');
    const attemptFailed = failed.find((committed) => committed.event.type === 'agent_attempt_failed');
    expect(attemptFailed?.event).toMatchObject({ nodeId: 'ev-input-reviewer', retryable: false });
    expect(await artifacts.list(taskId)).toEqual([]);

    // Recommitting the same Turn replays committed items instead of
    // duplicating them, then finishes the interrupted plan.
    const replayed: CommitResult = await failingCommitter.validateAndCommit(context, actions);
    expect(replayed.taskCompleted).toBe(true);
    expect(replayed.publishedVersions).toEqual([1]);
    const after = await events.read(taskId);
    expect(after.filter((committed) => committed.event.type === 'agent_result')).toHaveLength(1);
    expect(after.filter((committed) => committed.event.type === 'artifact_published')).toHaveLength(1);
    expect(await artifacts.list(taskId)).toHaveLength(1);
    expect((await projector.workspace(taskId)).artifacts.at(-1)?.final).toBe(true);
  });

  it('keeps the stable phase error codes non-retryable', async () => {
    for (const code of [
      COMMIT_ERROR_CODES.AGENT_PHASE_INCOMPLETE,
      COMMIT_ERROR_CODES.AGENT_PHASE_ORDER_INVALID,
      COMMIT_ERROR_CODES.AGENT_DISPATCH_CARDINALITY_INVALID,
    ]) {
      expect(typeof code).toBe('string');
    }
    await expect(committer.validateAndCommit(contextFor('writer'), [PUBLISH_CURRENT])).rejects.toMatchObject({
      code: COMMIT_ERROR_CODES.AGENT_PHASE_ORDER_INVALID,
      retryable: false,
    });
  });

  it('carries the published artifact identity in the publish phase (review F5)', async () => {
    // Display-only enrichment: the publish phase names the sealed package
    // title and the system-assigned version instead of a bare "dispatched".
    const result = await committer.validateAndCommit(contextFor('writer'), [
      finishInline({ title: '第二章' }),
      PUBLISH_CURRENT,
    ]);
    expect(result.phase.dispatchAction).toBe('publish_artifact');
    expect(result.phase.state).toBe('dispatched');
    expect(result.phase.message).toBe('已发布产物「第二章」v1');
  });
});
