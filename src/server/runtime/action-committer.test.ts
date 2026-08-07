// @vitest-environment node
/**
 * ActionCommitter tests (plan Phase C Task 3 Steps 1/4/5/6; rebuilt for the
 * v7 production/operate turn contract by plan 2026-08-07 Phase 2, spec §4/§5.3).
 *
 * The committer validates the complete buffered action set before writing
 * anything — phase order/cardinality of the turn contract, contract
 * conformance, route/authorization/final checks — then commits in the
 * deterministic order agent result → skill loads → annotate files/events →
 * sealed-package publication → dispatch route → human request or final
 * submission. v7 splits production and operate turns: `finish_production` +
 * `publish_artifact` seals and publishes a new version; `send_message` /
 * `submit_final_artifact` operate on the input version without sealing.
 * Final output is accepted only after independent system validation; natural
 * language and ordinary publishes never complete a task (spec §6.4). A
 * mid-plan file failure appends a public node failure and never overwrites
 * prior committed items; recommitting the same Turn replays instead of
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
import type { FrozenTemplate, TurnContract } from '../template/template-schema';
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
    files: [{ name: 'content.md', content: '封存正文' }],
    format: 'markdown',
    artifactType: '终稿',
    title: '初稿 V1',
    ...overrides,
  };
}

const PUBLISH_CURRENT = { type: 'publish_artifact' } as const;
const SUBMIT_CURRENT = { type: 'submit_final_artifact' } as const;

/** The `CurrentInputArtifact` the reviewer received via a committed route. */
function receivedFrom(published: Awaited<ReturnType<ArtifactStore['read']>>): CurrentInputArtifact {
  return {
    artifactId: published.meta.id,
    version: published.meta.version,
    title: published.meta.title,
    format: published.meta.format,
    content: published.files[0].content,
    sourceNodeId: published.meta.sourceNodeId,
    humanAuthorized: false,
  };
}

beforeEach(async () => {
  const fixture = await catalogWithOneTemplate();
  paths = fixture.paths;
  const tasks = new TaskStore(paths, fixture.catalog);
  events = new EventStore(paths);
  artifacts = new ArtifactStore(paths, events);
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

describe('ActionCommitter two-phase validation (plan 2026-08-07 Phase 2, spec §5.3)', () => {
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

  it('rejects publish_artifact before finish_production as AGENT_PHASE_ORDER_INVALID', async () => {
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
        { type: 'send_message', targetAgentId: 'writer', summary: '返修意见' },
        SUBMIT_CURRENT,
      ]),
    ).rejects.toMatchObject({ code: 'AGENT_DISPATCH_CARDINALITY_INVALID', retryable: false });
    expect(await events.read(taskId)).toEqual(before);
  });

  it('rejects a second finish_production as AGENT_PHASE_ORDER_INVALID', async () => {
    await expect(
      committer.validateAndCommit(contextFor('writer'), [
        finishInline(),
        finishInline({ files: [{ name: 'content.md', content: '第二次封存' }] }),
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

  it('accepts a mid-production human request (F7 flipped)', async () => {
    const result = await committer.validateAndCommit(contextFor('writer'), [
      { type: 'load_skill', skillId: 'style-guide' },
      { type: 'request_human_input', question: '现在问？' },
    ]);
    expect(result.waitingHuman).toBe(true);
    expect(result.phase.state).toBe('waiting_human');
    expect((await projector.workspace(taskId)).task.status).toBe('waiting_human');
  });
});

describe('ActionCommitter v7 production/operate dispatch semantics (frozen decision 5)', () => {
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
    expect(workspace.artifacts[0].files[0].content).toBe('封存正文');
    expect(workspace.executedRoutes).toHaveLength(1);
    expect(workspace.executedRoutes[0].kind).toBe('artifact');
    const inputNode = workspace.nodes.find(
      (node) => node.id === workspace.executedRoutes[0].toNodeId,
    );
    expect(inputNode?.agentId).toBe('reviewer');
    expect(inputNode?.inputVersion).toBe(1);
  });

  it('delivers the message summary as the routed body for reviewer', async () => {
    const result = await committer.validateAndCommit(contextFor('reviewer'), [
      { type: 'send_message', targetAgentId: 'writer', summary: '请修改第二段。' },
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

  it('submits the received input version as the final artifact', async () => {
    // Turn 1: writer publishes the production package (routes to reviewer).
    const first = await committer.validateAndCommit(contextFor('writer'), [
      finishInline({ files: [{ name: 'content.md', content: '终稿正文' }], title: '终稿 V1' }),
      PUBLISH_CURRENT,
    ]);
    expect(first.publishedVersions).toEqual([1]);
    const published = await artifacts.read(taskId, first.publishedVersions[0]);

    // Turn 2: reviewer submits the received input version unchanged (zero-copy).
    const context = buildCommitContext(env, 'reviewer', {
      inputNodeId: 'turn-1-artifact-input-0',
      currentInputArtifact: receivedFrom(published),
    });
    const result = await committer.validateAndCommit(context, [SUBMIT_CURRENT]);
    expect(result.taskCompleted).toBe(true);
    expect(result.publishedVersions).toEqual([]); // nothing re-published
    const workspace = await projector.workspace(taskId);
    expect(workspace.task.status).toBe('completed');
    expect(workspace.artifacts).toHaveLength(1);
    expect(workspace.artifacts.at(-1)?.final).toBe(true);
    expect(workspace.artifacts.at(-1)?.version).toBe(first.publishedVersions[0]);
  });

  it('submits a received input version without re-publishing it', async () => {
    // The submit accepts the version reached through committed execution; the
    // committer resolves it from the input node, never by sealing a package.
    const first = await committer.validateAndCommit(contextFor('writer'), [
      finishInline({ files: [{ name: 'content.md', content: '章节正文' }], title: '章节' }),
      PUBLISH_CURRENT,
    ]);
    expect(first.nextAgentIds).toEqual(['reviewer']);
    const published = await artifacts.read(taskId, first.publishedVersions[0]);
    const second = await committer.validateAndCommit(
      buildCommitContext(env, 'reviewer', {
        inputNodeId: 'turn-1-artifact-input-0',
        currentInputArtifact: receivedFrom(published),
      }),
      [SUBMIT_CURRENT],
    );
    expect(second.taskCompleted).toBe(true);
    expect(second.publishedVersions).toEqual([]);
    const workspace = await projector.workspace(taskId);
    expect(workspace.artifacts).toHaveLength(1);
    expect(workspace.artifacts.at(-1)?.final).toBe(true);
    expect(workspace.artifacts.at(-1)?.version).toBe(first.publishedVersions[0]);
  });

  it('rejects submit_final_artifact when the input carries no artifact', async () => {
    const before = await events.read(taskId);
    await expect(
      committer.validateAndCommit(contextFor('reviewer'), [SUBMIT_CURRENT]),
    ).rejects.toMatchObject({ code: 'FINAL_ARTIFACT_NOT_FOUND', retryable: false });
    expect(await events.read(taskId)).toEqual(before);
  });

  it('accepts a message-only turn without publication metadata', async () => {
    const before = await events.read(taskId);
    await expect(
      committer.validateAndCommit(contextFor('reviewer'), [
        { type: 'send_message', targetAgentId: 'writer', summary: '返修意见' },
      ]),
    ).resolves.toMatchObject({ taskCompleted: false });
    // Message-only turns never stage artifacts.
    expect(await artifacts.list(taskId)).toEqual([]);
    expect((await events.read(taskId)).length).toBe(before.length + 3);
  });

  it('rejects annotate_artifact when the input carries no artifact version', async () => {
    const before = await events.read(taskId);
    await expect(
      committer.validateAndCommit(contextFor('reviewer'), [
        { type: 'annotate_artifact', file: 'review.md', content: '---\nverdict: pass\n---\n意见' },
        { type: 'send_message', targetAgentId: 'writer', summary: '返修意见' },
      ]),
    ).rejects.toMatchObject({ code: 'ANNOTATE_VERSION_MISSING', retryable: false });
    expect(await events.read(taskId)).toEqual(before);
  });

  it('rejects a final submission whose input version format misses the declaration', async () => {
    const before = await events.read(taskId);
    const received: CurrentInputArtifact = {
      artifactId: 'artifact-a',
      version: 1,
      title: '文本终稿',
      format: 'text',
      content: '正文',
      sourceNodeId: 'ev-input-writer',
      humanAuthorized: false,
    };
    const context = buildCommitContext(env, 'reviewer', { currentInputArtifact: received });
    await expect(
      committer.validateAndCommit(context, [SUBMIT_CURRENT]),
    ).rejects.toMatchObject({ code: 'FINAL_DECLARATION_MISMATCH', retryable: false });
    expect(await events.read(taskId)).toEqual(before);
  });

  it('accepts a human-authorized input version without a committed route chain', async () => {
    // The scheduler accept path synthesizes the input with humanAuthorized true;
    // the final closure then needs no committed artifact route (spec §7.1).
    const received: CurrentInputArtifact = {
      artifactId: 'artifact-human',
      version: 1,
      title: '人工接受的终稿',
      format: 'markdown',
      content: '正文',
      sourceNodeId: 'ev-ghost-producer',
      humanAuthorized: true,
    };
    const context = buildCommitContext(env, 'reviewer', { currentInputArtifact: received });
    const result = await committer.validateAndCommit(context, [SUBMIT_CURRENT]);
    expect(result.taskCompleted).toBe(true);
    expect((await projector.workspace(taskId)).task.status).toBe('completed');
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
      sourceNodeId: 'artifact-ghost',
      humanAuthorized: false,
    };
    const context = buildCommitContext(env, 'reviewer', { currentInputArtifact: received });
    await expect(
      committer.validateAndCommit(context, [SUBMIT_CURRENT]),
    ).rejects.toMatchObject({ code: 'FINAL_NOT_REACHABLE', retryable: false });
    // Nothing at all was written: no agent result, no failure marker.
    expect(await events.read(taskId)).toEqual(before);
    expect(await artifacts.list(taskId)).toEqual([]);
  });
});

describe('ActionCommitter contract conformance (spec §6)', () => {
  it('rejects a production source the contract does not allow', async () => {
    // The reviewer contract allows inline only (current_input_artifact is gone).
    await expect(
      committer.validateAndCommit(contextFor('reviewer'), [
        {
          type: 'finish_production',
          source: 'workspace_file',
          files: [{ name: 'a.md', workspaceFile: 'draft/a.md' }],
          format: 'markdown',
          artifactType: null,
          title: null,
        },
        { type: 'send_message', targetAgentId: 'writer', summary: '返修意见' },
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
        { type: 'send_message', targetAgentId: 'reviewer', summary: '返修意见' },
      ]),
    ).rejects.toMatchObject({ code: 'ACTION_SET_INVALID', retryable: false });
  });

  it('rejects a message target that misses the contract target', async () => {
    // reviewer's contract sends to writer; any other target is refused even
    // though the route check would fail first for unknown agents.
    await expect(
      committer.validateAndCommit(contextFor('reviewer'), [
        { type: 'send_message', targetAgentId: 'unknown', summary: '返修意见' },
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
      [{ type: 'send_message', targetAgentId: 'writer', summary: '返修意见' }],
    );
    expect(result.committedEvents.some((event) => event.type === 'route_executed')).toBe(true);
  });

  it('rejects send_message to an agent outside the candidate set even on a declared route', async () => {
    // writer IS the declared route target, but the candidate set excludes it.
    await expect(
      committer.validateAndCommit(
        contextWithTargets('reviewer', { send_message: ['producer'] }),
        [{ type: 'send_message', targetAgentId: 'writer', summary: '返修意见' }],
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
        { type: 'send_message', targetAgentId: 'unknown', summary: '返修意见' },
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
      committer.validateAndCommit(neutralContextFor('agent-alpha'), [SUBMIT_CURRENT]),
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
      { type: 'send_message', targetAgentId: 'writer', summary: '返修意见' },
    ]);
    expect(result.taskCompleted).toBe(false);
    expect((await projector.workspace(taskId)).task.status).not.toBe('completed');
  });
});

describe('ActionCommitter mid-plan failure and replay', () => {
  it('appends a public node failure and never overwrites prior items', async () => {
    const context = buildCommitContext(env, 'writer');
    const actions = [finishInline({ files: [{ name: 'content.md', content: '终稿正文' }], title: '终稿 V1' }), PUBLISH_CURRENT];

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
    expect(attemptFailed?.event).toMatchObject({ nodeId: 'ev-input-writer', retryable: false });
    expect(await artifacts.list(taskId)).toEqual([]);

    // Recommitting the same Turn replays committed items instead of
    // duplicating them, then finishes the interrupted plan.
    const replayed: CommitResult = await failingCommitter.validateAndCommit(context, actions);
    expect(replayed.publishedVersions).toEqual([1]);
    const after = await events.read(taskId);
    expect(after.filter((committed) => committed.event.type === 'agent_result')).toHaveLength(1);
    expect(after.filter((committed) => committed.event.type === 'artifact_published')).toHaveLength(1);
    expect(await artifacts.list(taskId)).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// Phase 4: forward / annotate / reachability / inputVersion (spec §5.2/§7/§8/§9)
// ---------------------------------------------------------------------------

/**
 * A three-agent forward-chain frozen snapshot mirroring the long-form-hub v7
 * topology: writer publishes -> reviewer annotates + forwards -> controller
 * submits. The committer trusts the CommitContext fields, so the snapshot is
 * used only to build contexts against the `valid`-fixture task storage.
 * Business vocabulary is confined to this test file (iron rule 1).
 */
function forwardChainFrozen(): FrozenTemplate {
  const writerContract: TurnContract = {
    version: 2,
    production: {
      files: ['content.md', 'revision.md'],
      output: { formats: ['markdown'], sources: ['inline', 'workspace_file'] },
    },
    dispatch: {
      allowedActions: ['publish_artifact'],
      targets: { publish_artifact: ['reviewer'] },
    },
  };
  const reviewerContract: TurnContract = {
    version: 2,
    annotate: { files: ['review.md'] },
    dispatch: {
      allowedActions: ['forward_input_version', 'send_message', 'request_human_input'],
      targets: { forward_input_version: ['controller'], send_message: ['writer'] },
    },
  };
  const controllerContract: TurnContract = {
    version: 2,
    dispatch: {
      allowedActions: ['send_message', 'submit_final_artifact'],
      targets: { send_message: ['writer', 'reviewer'] },
    },
  };
  return {
    id: 'forward-chain',
    name: 'Forward Chain',
    description: 'Three-agent forward-chain fixture for Phase 4 committer tests.',
    versionHash: 'a'.repeat(64),
    inputFields: [],
    agents: [
      { id: 'writer', name: '写作 Agent', description: '', systemPrompt: '', model: 'configured/writer-model', skills: [], turnContract: writerContract },
      { id: 'reviewer', name: '审核 Agent', description: '', systemPrompt: '', model: 'configured/reviewer-model', skills: [], turnContract: reviewerContract },
      { id: 'controller', name: '总控 Agent', description: '', systemPrompt: '', model: 'configured/controller-model', skills: [], turnContract: controllerContract },
    ],
    routes: [
      { from: 'controller', to: 'writer', kind: 'message', label: '分配写作任务' },
      { from: 'controller', to: 'reviewer', kind: 'message', label: '派发审读任务' },
      { from: 'writer', to: 'reviewer', kind: 'artifact', label: '提交章节稿件', inject: [{ version: 'input', file: 'content.md', as: '上一版正文' }] },
      { from: 'reviewer', to: 'writer', kind: 'message', label: '退回修改意见', inject: [{ version: 'input', file: 'content.md', as: '上一版正文' }, { version: 'input', file: 'review.md', as: '返修意见' }] },
      { from: 'reviewer', to: 'controller', kind: 'artifact', label: '审读结论（通过转交）', inject: [{ version: 'input', file: 'content.md', as: '通过的章节正文' }] },
    ],
    finalOutput: { name: 'story_markdown', format: 'markdown', submitters: ['controller'] },
    artifactSchema: {
      files: [
        { name: 'content.md', required: true, producer: 'writer', extract: 'content', phase: 'create' },
        { name: 'revision.md', required: false, producer: 'writer', extract: 'revision', phase: 'create' },
        { name: 'review.md', required: false, producer: 'reviewer', extract: 'review', phase: 'annotate' },
      ],
    },
    budget: null,
    sourcePath: 'fixture:forward-chain',
  };
}

/** Builds a Phase-4 CommitContext for one forward-chain agent against the task. */
function forwardContext(
  taskId: string,
  agentId: string,
  overrides: Partial<CommitContext> & { turnId?: string } = {},
): CommitContext {
  const frozen = forwardChainFrozen();
  const agent = frozen.agents.find((a) => a.id === agentId);
  if (agent === undefined) {
    throw new Error(`forward-chain fixture has no agent '${agentId}'`);
  }
  const { turnId, ...rest } = overrides;
  return {
    taskId,
    turnId: turnId ?? `fwd-turn-${agentId}`,
    currentAgent: agent,
    agents: frozen.agents.map(({ id, name }) => ({ id, name })),
    inputNodeId: `fwd-input-${agentId}`,
    attemptCount: 1,
    publicText: 'forward chain turn',
    declaredRoutes: frozen.routes,
    finalOutput: frozen.finalOutput,
    turnContract: agent.turnContract,
    currentInputArtifact: null,
    ...rest,
  };
}

describe('ActionCommitter v7 forward, annotate and reachability (spec §7/§8/§9)', () => {
  it('forwards the received input version along one declared artifact edge', async () => {
    // Writer publishes v1 (auto-routes the artifact hand-off to reviewer).
    const writerCtx = forwardContext(taskId, 'writer', {
      turnId: 'fwd-w-1',
      inputNodeId: 'fwd-input-writer',
    });
    const published_turn = await committer.validateAndCommit(writerCtx, [
      finishInline({ files: [{ name: 'content.md', content: '章节正文' }], title: '章节 V1', artifactType: null }),
      PUBLISH_CURRENT,
    ]);
    expect(published_turn.publishedVersions).toEqual([1]);
    const reviewerInputId = 'fwd-w-1-artifact-input-0';
    const version1 = await artifacts.read(taskId, 1);

    // Reviewer forwards the received input version to controller (zero-copy).
    const result = await committer.validateAndCommit(
      forwardContext(taskId, 'reviewer', {
        turnId: 'fwd-r-1',
        inputNodeId: reviewerInputId,
        currentInputArtifact: receivedFrom(version1),
      }),
      [{ type: 'forward_input_version', targetAgentId: 'controller' }],
    );
    expect(result.nextAgentIds).toEqual(['controller']);
    expect(result.publishedVersions).toEqual([]); // forward never bumps
    expect(result.phase).toEqual({
      state: 'dispatched',
      dispatchAction: 'forward_input_version',
      target: 'controller',
      message: null,
    });
    const workspace = await projector.workspace(taskId);
    const forwardRoute = workspace.executedRoutes.find((r) => r.toNodeId === 'fwd-r-1-forward-input-0');
    expect(forwardRoute?.kind).toBe('artifact');
    const controllerInput = workspace.nodes.find((n) => n.id === 'fwd-r-1-forward-input-0');
    expect(controllerInput?.agentId).toBe('controller');
    expect(controllerInput?.inputVersion).toBe(1); // forwarded version
    // The forward result carries dispatchKind=forward (spec §8.2).
    const reviewerResult = (await events.read(taskId)).find((e) => e.event.id === 'fwd-r-1-result');
    expect(reviewerResult?.event.type === 'agent_result' && reviewerResult.event.dispatchKind).toBe('forward');
  });

  it('rejects annotate_artifact with malformed frontmatter and writes nothing', async () => {
    // Writer publishes v1 so the reviewer has a received artifact to annotate.
    const writerCtx = forwardContext(taskId, 'writer', {
      turnId: 'ann-w-1',
      inputNodeId: 'ann-input-writer',
    });
    await committer.validateAndCommit(writerCtx, [
      finishInline({ files: [{ name: 'content.md', content: '章节正文' }], title: '章节 V1', artifactType: null }),
      PUBLISH_CURRENT,
    ]);
    const reviewerInputId = 'ann-w-1-artifact-input-0';
    const version1 = await artifacts.read(taskId, 1);
    const before = await events.read(taskId);

    // Missing frontmatter and an unknown verdict both fail closed at the
    // committer boundary (semantic audit P1) — a FakeRuntime or direct-commit
    // path must never bypass the tool-layer check. The turn is a legal operate
    // shape (annotate + forward) so the annotate gate is what rejects it.
    for (const content of ['今天感觉还行。', '---\nverdict: maybe\n---\n意见']) {
      await expect(
        committer.validateAndCommit(
          forwardContext(taskId, 'reviewer', {
            turnId: 'ann-r-1',
            inputNodeId: reviewerInputId,
            currentInputArtifact: receivedFrom(version1),
          }),
          [
            { type: 'annotate_artifact', file: 'review.md', content },
            { type: 'forward_input_version', targetAgentId: 'controller' },
          ],
        ),
      ).rejects.toMatchObject({ code: 'ANNOTATE_FRONTMATTER_INVALID' });
    }

    // Zero writes: no artifact_annotated event, no review file in the version.
    const after = await events.read(taskId);
    expect(after.map((entry) => entry.event.type)).not.toContain('artifact_annotated');
    expect(after).toEqual(before);
    const versionAfter = await artifacts.read(taskId, 1);
    expect(versionAfter.files.some((file) => file.name === 'review.md')).toBe(false);
  });

  it('accepts a submit reachability closure through a forward edge (spec §7.3)', async () => {
    // Chain: writer publish -> reviewer forward -> controller submit.
    const writerCtx = forwardContext(taskId, 'writer', {
      turnId: 'rc-w-1',
      inputNodeId: 'rc-input-writer',
    });
    await committer.validateAndCommit(writerCtx, [
      finishInline({ files: [{ name: 'content.md', content: '终稿正文' }], title: '终稿 V1', artifactType: null }),
      PUBLISH_CURRENT,
    ]);
    const reviewerInputId = 'rc-w-1-artifact-input-0';
    const version1 = await artifacts.read(taskId, 1);

    await committer.validateAndCommit(
      forwardContext(taskId, 'reviewer', {
        turnId: 'rc-r-1',
        inputNodeId: reviewerInputId,
        currentInputArtifact: receivedFrom(version1),
      }),
      [{ type: 'forward_input_version', targetAgentId: 'controller' }],
    );
    const controllerInputId = 'rc-r-1-forward-input-0';

    // Controller submits the forwarded version; reachability walks the
    // committed artifact routes (publish + forward) connected by inputNodeId.
    const result = await committer.validateAndCommit(
      forwardContext(taskId, 'controller', {
        turnId: 'rc-c-1',
        inputNodeId: controllerInputId,
        currentInputArtifact: receivedFrom(version1),
      }),
      [SUBMIT_CURRENT],
    );
    expect(result.taskCompleted).toBe(true);
    expect((await projector.workspace(taskId)).task.status).toBe('completed');
  });

  it('annotates one file of the received input version atomically (spec §8)', async () => {
    const writerCtx = forwardContext(taskId, 'writer', {
      turnId: 'an-w-1',
      inputNodeId: 'an-input-writer',
    });
    await committer.validateAndCommit(writerCtx, [
      finishInline({ files: [{ name: 'content.md', content: '章节正文' }], title: '章节 V1', artifactType: null }),
      PUBLISH_CURRENT,
    ]);
    const version1 = await artifacts.read(taskId, 1);

    const result = await committer.validateAndCommit(
      forwardContext(taskId, 'reviewer', {
        turnId: 'an-r-1',
        inputNodeId: 'an-w-1-artifact-input-0',
        currentInputArtifact: receivedFrom(version1),
      }),
      [
        { type: 'annotate_artifact', file: 'review.md', content: '---\nverdict: pass\n---\n## 意见\n通过' },
        { type: 'forward_input_version', targetAgentId: 'controller' },
      ],
    );
    expect(result.committedEvents.map((e) => e.type)).toContain('artifact_annotated');
    const annotated = await artifacts.readFile(taskId, 1, 'review.md');
    expect(annotated).toContain('verdict: pass');
    // The annotate event records the content hash, version and owning turn.
    const annotateEvent = (await events.read(taskId)).find((e) => e.event.id === 'an-r-1-annotate-review.md');
    expect(annotateEvent?.event.type === 'artifact_annotated' && annotateEvent.event.version).toBe(1);
  });

  it('rejects a second annotation of the same (version, file) from a different turn before any write', async () => {
    const writerCtx = forwardContext(taskId, 'writer', {
      turnId: 'ad-w-1',
      inputNodeId: 'ad-input-writer',
    });
    await committer.validateAndCommit(writerCtx, [
      finishInline({ files: [{ name: 'content.md', content: '章节正文' }], title: '章节', artifactType: null }),
      PUBLISH_CURRENT,
    ]);
    const version1 = await artifacts.read(taskId, 1);

    // Turn 1 annotates (v1, review.md).
    await committer.validateAndCommit(
      forwardContext(taskId, 'reviewer', {
        turnId: 'ad-r-1',
        inputNodeId: 'ad-w-1-artifact-input-0',
        currentInputArtifact: receivedFrom(version1),
      }),
      [
        { type: 'annotate_artifact', file: 'review.md', content: '---\nverdict: pass\n---\n意见一' },
        { type: 'send_message', targetAgentId: 'writer', summary: '通过' },
      ],
    );

    // A different turn tries the same (v1, review.md): rejected at validation.
    const before = await events.read(taskId);
    await expect(
      committer.validateAndCommit(
        forwardContext(taskId, 'reviewer', {
          turnId: 'ad-r-2',
          inputNodeId: 'ad-w-1-artifact-input-0',
          currentInputArtifact: receivedFrom(version1),
        }),
        [
          { type: 'annotate_artifact', file: 'review.md', content: '---\nverdict: reject\n---\n意见二' },
          { type: 'send_message', targetAgentId: 'writer', summary: '再批' },
        ],
      ),
    ).rejects.toMatchObject({ code: 'ANNOTATE_DUPLICATE', retryable: false });
    expect(await events.read(taskId)).toEqual(before); // zero writes
  });

  it('replays this turn own annotation idempotently (self-exclusion, spec §8)', async () => {
    const writerCtx = forwardContext(taskId, 'writer', {
      turnId: 'ai-w-1',
      inputNodeId: 'ai-input-writer',
    });
    await committer.validateAndCommit(writerCtx, [
      finishInline({ files: [{ name: 'content.md', content: '章节正文' }], title: '章节', artifactType: null }),
      PUBLISH_CURRENT,
    ]);
    const version1 = await artifacts.read(taskId, 1);
    const reviewerCtx = forwardContext(taskId, 'reviewer', {
      turnId: 'ai-r-1',
      inputNodeId: 'ai-w-1-artifact-input-0',
      currentInputArtifact: receivedFrom(version1),
    });
    const actions = [
      { type: 'annotate_artifact', file: 'review.md', content: '---\nverdict: pass\n---\n意见' },
      { type: 'send_message', targetAgentId: 'writer', summary: '通过' },
    ] as const;

    await committer.validateAndCommit(reviewerCtx, [...actions]);
    // Re-committing the SAME turn replays the annotation instead of rejecting.
    const replay = await committer.validateAndCommit(reviewerCtx, [...actions]);
    expect(replay.committedEvents.some((e) => e.type === 'artifact_annotated')).toBe(true);
    const after = await events.read(taskId);
    expect(after.filter((e) => e.event.type === 'artifact_annotated')).toHaveLength(1);
  });

  it('rejects an annotate file the contract does not allow (spec §5.3)', async () => {
    const writerCtx = forwardContext(taskId, 'writer', {
      turnId: 'ab-w-1',
      inputNodeId: 'ab-input-writer',
    });
    await committer.validateAndCommit(writerCtx, [
      finishInline({ files: [{ name: 'content.md', content: '章节正文' }], title: '章节', artifactType: null }),
      PUBLISH_CURRENT,
    ]);
    const version1 = await artifacts.read(taskId, 1);
    const before = await events.read(taskId);
    await expect(
      committer.validateAndCommit(
        forwardContext(taskId, 'reviewer', {
          turnId: 'ab-r-1',
          inputNodeId: 'ab-w-1-artifact-input-0',
          currentInputArtifact: receivedFrom(version1),
        }),
        [
          { type: 'annotate_artifact', file: 'notes.md', content: '---\nverdict: pass\n---\n意见' },
          { type: 'send_message', targetAgentId: 'writer', summary: '意见' },
        ],
      ),
    ).rejects.toMatchObject({ code: 'ANNOTATE_FILE_NOT_ALLOWED', retryable: false });
    expect(await events.read(taskId)).toEqual(before);
  });

  it('propagates the sender input version to the message recipient (spec §2)', async () => {
    // Writer publishes v1 -> reviewer receives v1; reviewer messages writer.
    const writerCtx = forwardContext(taskId, 'writer', {
      turnId: 'iv-w-1',
      inputNodeId: 'iv-input-writer',
    });
    await committer.validateAndCommit(writerCtx, [
      finishInline({ files: [{ name: 'content.md', content: '章节正文' }], title: '章节', artifactType: null }),
      PUBLISH_CURRENT,
    ]);
    const version1 = await artifacts.read(taskId, 1);

    const result = await committer.validateAndCommit(
      forwardContext(taskId, 'reviewer', {
        turnId: 'iv-r-1',
        inputNodeId: 'iv-w-1-artifact-input-0',
        currentInputArtifact: receivedFrom(version1),
      }),
      [{ type: 'send_message', targetAgentId: 'writer', summary: '返修意见' }],
    );
    expect(result.nextAgentIds).toEqual(['writer']);
    const workspace = await projector.workspace(taskId);
    const writerInput = workspace.nodes.find((n) => n.id === 'iv-r-1-message-input-0');
    expect(writerInput?.agentId).toBe('writer');
    expect(writerInput?.inputVersion).toBe(1); // inherited from reviewer's input version
  });

  it('propagates a null input version when the sender carries no artifact', async () => {
    // Controller (no input version) messages writer -> writer inherits null.
    const result = await committer.validateAndCommit(
      forwardContext(taskId, 'controller', {
        turnId: 'nv-c-1',
        inputNodeId: 'nv-input-controller',
        currentInputArtifact: null,
      }),
      [{ type: 'send_message', targetAgentId: 'writer', summary: '开始写作' }],
    );
    expect(result.nextAgentIds).toEqual(['writer']);
    const workspace = await projector.workspace(taskId);
    const writerInput = workspace.nodes.find((n) => n.id === 'nv-c-1-message-input-0');
    expect(writerInput?.inputVersion).toBeNull();
  });

  it('records the dispatchKind on agent_result for each dispatch shape (spec §8.2)', async () => {
    // publish
    await committer.validateAndCommit(
      forwardContext(taskId, 'writer', { turnId: 'dk-w-1', inputNodeId: 'dk-input-writer' }),
      [finishInline({ files: [{ name: 'content.md', content: 'c' }], title: 't', artifactType: null }), PUBLISH_CURRENT],
    );
    const wResult = (await events.read(taskId)).find((e) => e.event.id === 'dk-w-1-result');
    expect(wResult?.event.type === 'agent_result' && wResult.event.dispatchKind).toBe('publish');

    // forward (reviewer forwards the published v1 to controller)
    const v1 = await artifacts.read(taskId, 1);
    await committer.validateAndCommit(
      forwardContext(taskId, 'reviewer', {
        turnId: 'dk-r-1',
        inputNodeId: 'dk-w-1-artifact-input-0',
        currentInputArtifact: receivedFrom(v1),
      }),
      [{ type: 'forward_input_version', targetAgentId: 'controller' }],
    );
    const rResult = (await events.read(taskId)).find((e) => e.event.id === 'dk-r-1-result');
    expect(rResult?.event.type === 'agent_result' && rResult.event.dispatchKind).toBe('forward');

    // send (controller messages writer)
    await committer.validateAndCommit(
      forwardContext(taskId, 'controller', { turnId: 'dk-c-1', inputNodeId: 'dk-input-controller' }),
      [{ type: 'send_message', targetAgentId: 'writer', summary: '协调' }],
    );
    const cResult = (await events.read(taskId)).find((e) => e.event.id === 'dk-c-1-result');
    expect(cResult?.event.type === 'agent_result' && cResult.event.dispatchKind).toBe('send');

    // submit (controller submits the forwarded v1)
    await committer.validateAndCommit(
      forwardContext(taskId, 'controller', {
        turnId: 'dk-c-2',
        inputNodeId: 'dk-r-1-forward-input-0',
        currentInputArtifact: receivedFrom(v1),
      }),
      [SUBMIT_CURRENT],
    );
    const sResult = (await events.read(taskId)).find((e) => e.event.id === 'dk-c-2-result');
    expect(sResult?.event.type === 'agent_result' && sResult.event.dispatchKind).toBe('submit');

    // human (writer requests human input)
    await committer.validateAndCommit(
      forwardContext(taskId, 'writer', { turnId: 'dk-w-2', inputNodeId: 'dk-input-writer-2' }),
      [{ type: 'request_human_input', question: '是否继续？' }],
    );
    const hResult = (await events.read(taskId)).find((e) => e.event.id === 'dk-w-2-result');
    expect(hResult?.event.type === 'agent_result' && hResult.event.dispatchKind).toBe('human');
  });

  it('replays a committed publish without re-publishing the version (spec §6)', async () => {
    const ctx = forwardContext(taskId, 'writer', {
      turnId: 'rp-w-1',
      inputNodeId: 'rp-input-writer',
    });
    const actions = [
      finishInline({ files: [{ name: 'content.md', content: '正文' }], title: '初稿', artifactType: null }),
      PUBLISH_CURRENT,
    ];
    const first = await committer.validateAndCommit(ctx, actions);
    expect(first.publishedVersions).toEqual([1]);

    // Re-committing the same Turn replays committed items instead of duplicating.
    const replay = await committer.validateAndCommit(ctx, actions);
    expect(replay.publishedVersions).toEqual([1]);
    const after = await events.read(taskId);
    expect(after.filter((e) => e.event.type === 'artifact_published')).toHaveLength(1);
    expect(after.filter((e) => e.event.type === 'agent_result')).toHaveLength(1);
    expect(await artifacts.list(taskId)).toHaveLength(1);
  });

  it('never writes humanAuthorized on a committed input node (spec §7.1 closedness)', async () => {
    // Writer publishes v1 -> auto-routes an artifact input to reviewer.
    await committer.validateAndCommit(
      forwardContext(taskId, 'writer', { turnId: 'ha-w-1', inputNodeId: 'ha-input-writer' }),
      [
        finishInline({ files: [{ name: 'content.md', content: '正文' }], title: 'V1', artifactType: null }),
        PUBLISH_CURRENT,
      ],
    );
    const version1 = await artifacts.read(taskId, 1);
    // The received input is humanAuthorized (as if synthesized by the accept
    // path); a model forward must NOT propagate the field - the committer's
    // node constructor never sets humanAuthorized.
    await committer.validateAndCommit(
      forwardContext(taskId, 'reviewer', {
        turnId: 'ha-r-1',
        inputNodeId: 'ha-w-1-artifact-input-0',
        currentInputArtifact: { ...receivedFrom(version1), humanAuthorized: true },
      }),
      [{ type: 'forward_input_version', targetAgentId: 'controller' }],
    );
    const allInputs = (await events.read(taskId)).filter((e) => e.event.type === 'agent_input');
    expect(allInputs.length).toBeGreaterThan(0);
    for (const entry of allInputs) {
      if (entry.event.type !== 'agent_input') {
        continue;
      }
      // Every committed input node - publish fan-out and forward alike - lacks
      // humanAuthorized: only the scheduler accept path writes it.
      expect(entry.event.node.humanAuthorized).toBeUndefined();
    }
  });

  it('reachability bridges a superseded input to its synthesized replacement (spec §11.1 A continue)', async () => {
    // Writer publishes v1 -> routes the artifact hand-off to reviewer input OLD.
    await committer.validateAndCommit(
      forwardContext(taskId, 'writer', { turnId: 'rb-w-1', inputNodeId: 'rb-input-writer' }),
      [
        finishInline({ files: [{ name: 'content.md', content: '终稿正文' }], title: '终稿 V1', artifactType: null }),
        PUBLISH_CURRENT,
      ],
    );
    const oldReviewerInputId = 'rb-w-1-artifact-input-0';
    const version1 = await artifacts.read(taskId, 1);

    // Human continue voids OLD and synthesizes a replacement input for the
    // same recipient (reviewer) carrying the same version (deterministic id).
    await events.append(
      taskId,
      makeTaskEvent({ type: 'pending_inputs_superseded', supersededNodeIds: [oldReviewerInputId] }),
    );
    await events.append(
      taskId,
      makeTaskEvent({
        id: 'synthesize-continue-0',
        type: 'agent_input',
        node: makeEventNode({
          sequence: 50,
          agentId: 'reviewer',
          kind: 'input',
          title: '合成输入',
          body: '请转交',
          inputVersion: 1,
        }),
      }),
    );

    // Reviewer forwards from the synthesized input (not OLD) -> controller.
    await committer.validateAndCommit(
      forwardContext(taskId, 'reviewer', {
        turnId: 'rb-r-1',
        inputNodeId: 'synthesize-continue-0',
        currentInputArtifact: receivedFrom(version1),
      }),
      [{ type: 'forward_input_version', targetAgentId: 'controller' }],
    );

    // Controller submits the forwarded version; reachability walks writer ->
    // route to OLD (voided) -> resolved to the synthesized reviewer input ->
    // reviewer's forward result -> controller input. Without the bridge the
    // route dead-ends at the voided OLD (no consumer result).
    const result = await committer.validateAndCommit(
      forwardContext(taskId, 'controller', {
        turnId: 'rb-c-1',
        inputNodeId: 'rb-r-1-forward-input-0',
        currentInputArtifact: receivedFrom(version1),
      }),
      [SUBMIT_CURRENT],
    );
    expect(result.taskCompleted).toBe(true);
    expect((await projector.workspace(taskId)).task.status).toBe('completed');
  });
});
