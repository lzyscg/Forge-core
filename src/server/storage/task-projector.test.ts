// @vitest-environment node
/**
 * Event-derived projection tests (plan Phase B Task 4).
 *
 * `projectTask` folds immutable task identity plus ordered committed events
 * into the frozen `TaskWorkspace` shape (spec §9.4/§9.5): nodes, executed
 * routes, attempt counts, artifacts with the final flag, the pending human
 * question and a status derived exclusively from lifecycle/acceptance events
 * — never from Agent text (spec §6.4). Corruption isolation (spec §8.3) is
 * exercised through CoreService.listTasks: one damaged task projects to a
 * `corrupt` summary with a diagnostic while healthy tasks stay visible.
 * Temporary residue is never projected (spec §8.2).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  catalogWithOneTemplate,
  disposeAllTestRoots,
  makeEventNode,
  makeEventRoute,
  makeTaskEvent,
  validTaskRequest,
} from '../test-support';
import { CoreService } from '../core-service';
import type { CorePaths } from './core-paths';
import { formatEventFileName } from './core-paths';
import { deriveOwnerIssues, projectStructuredSlotsSummary, projectTask } from './task-projector';

let paths: CorePaths;
let service: CoreService;

beforeEach(async () => {
  const fixture = await catalogWithOneTemplate();
  paths = fixture.paths;
  service = new CoreService(paths);
  await service.initialize();
});

afterEach(() => {
  disposeAllTestRoots();
});

describe('task-projector', () => {
  it('projects a fresh task from its frozen snapshot as ready', async () => {
    const created = await service.createTask(validTaskRequest());
    const record = await service.tasks.readTaskRecord(created.id);
    const frozenTemplate = await service.tasks.readFrozenTemplate(created.id);

    const workspace = projectTask({ record, frozenTemplate }, [], []);

    expect(workspace.task.status).toBe('ready');
    expect(workspace.task.id).toBe(created.id);
    expect(workspace.task.latestVersion).toBeNull();
    expect(workspace.task.currentAgentName).toBeNull();
    expect(workspace.frozenInput).toEqual(record.frozenInput);
    expect(workspace.templateVersion).toBe(record.templateVersion);
    expect(workspace.agents.map((agent) => agent.id)).toEqual(['writer', 'reviewer']);
    // The public shape drops skill content paths (frozen contracts parity).
    for (const agent of workspace.agents) {
      for (const skill of agent.skills) {
        expect(skill).not.toHaveProperty('contentPath');
      }
    }
    expect(workspace.declaredRoutes).toEqual([
      { from: 'writer', to: 'reviewer', kind: 'artifact', label: '提交初稿' },
      { from: 'reviewer', to: 'writer', kind: 'message', label: '退回意见' },
    ]);
    expect(workspace.nodes).toEqual([]);
    expect(workspace.executedRoutes).toEqual([]);
    expect(workspace.artifacts).toEqual([]);
    expect(workspace.pendingHumanQuestion).toBeNull();
  });

  it('derives artifact file extract from the frozen artifactSchema, legacy fallback intact', async () => {
    const created = await service.createTask(validTaskRequest());
    await service.publishTestArtifact(created.id, {
      title: '评估 V1',
      sourceNodeId: 'ev-result-writer',
      files: [
        { name: 'content.md', content: '正文' },
        { name: 'evaluation.md', content: '评估' },
      ],
      format: 'markdown',
    });
    const record = await service.tasks.readTaskRecord(created.id);
    const frozen = await service.tasks.readFrozenTemplate(created.id);
    // A template-declared non-standard extract slot must survive projection
    // (semantic audit P1, plan 2026-08-07): the frozen artifactSchema is the
    // source of truth, not the file name.
    const customized = {
      ...frozen,
      artifactSchema: {
        files: [
          { name: 'content.md', required: true, producer: 'writer', extract: 'content', phase: 'create' as const },
          { name: 'evaluation.md', required: false, producer: 'reviewer', extract: 'evaluation', phase: 'annotate' as const },
        ],
      },
    };
    const artifacts = await service.artifacts.list(created.id);
    const workspace = projectTask({ record, frozenTemplate: customized }, [], artifacts);
    const v1 = workspace.artifacts.find((a) => a.version === 1);
    expect(v1?.files.find((f) => f.name === 'evaluation.md')?.extract).toBe('evaluation');
    expect(v1?.files.find((f) => f.name === 'content.md')?.extract).toBe('content');

    // A file absent from the schema (legacy) still degrades via the filename
    // heuristic rather than inventing a template slot.
    const legacy = projectTask({ record, frozenTemplate: frozen }, [], artifacts);
    const legacyV1 = legacy.artifacts.find((a) => a.version === 1);
    expect(legacyV1?.files.find((f) => f.name === 'content.md')?.extract).toBe('content');
  });

  it('folds nodes, executed routes and attempt counts from committed events', async () => {
    const created = await service.createTask(validTaskRequest());
    await service.appendTestEvent(created.id, makeTaskEvent({ type: 'task_started' }));
    const inputEvent = makeTaskEvent({
      type: 'agent_input',
      node: makeEventNode({ sequence: 1, agentId: 'writer', kind: 'input' }),
    });
    const resultEvent = makeTaskEvent({
      type: 'agent_result',
      node: makeEventNode({ sequence: 2, agentId: 'writer', kind: 'result' }),
    });
    await service.appendTestEvent(created.id, inputEvent);
    await service.appendTestEvent(created.id, resultEvent);
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({
        type: 'agent_attempt_failed',
        nodeId: inputEvent.id,
        message: '调用超时。',
        retryable: true,
      }),
    );
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({
        type: 'route_executed',
        route: makeEventRoute({
          sequence: 1,
          fromNodeId: resultEvent.id,
          toNodeId: inputEvent.id,
          kind: 'artifact',
          label: '提交初稿',
        }),
      }),
    );

    const workspace = await service.getWorkspace(created.id);

    expect(workspace.nodes.map((node) => node.id)).toEqual([inputEvent.id, resultEvent.id]);
    const inputNode = workspace.nodes.find((node) => node.id === inputEvent.id);
    expect(inputNode).toMatchObject({
      agentId: 'writer',
      kind: 'input',
      sequence: 1,
      status: 'failed',
      // Own attemptCount (1) plus one failed attempt folded onto the node.
      attemptCount: 2,
    });
    expect(workspace.executedRoutes).toHaveLength(1);
    expect(workspace.executedRoutes[0]).toMatchObject({
      sequence: 1,
      fromNodeId: resultEvent.id,
      toNodeId: inputEvent.id,
      kind: 'artifact',
      label: '提交初稿',
    });
    expect(workspace.task.status).toBe('running');
    expect(workspace.task.currentAgentName).toBe('初稿 Agent');
  });

  it('tracks the pending human question and waiting_human status', async () => {
    const created = await service.createTask(validTaskRequest());
    await service.appendTestEvent(created.id, makeTaskEvent({ type: 'task_started' }));
    const requested = makeTaskEvent({
      type: 'human_requested',
      node: makeEventNode({ sequence: 1, agentId: 'writer', kind: 'human_request' }),
      question: '需要确认开头基调。',
    });
    await service.appendTestEvent(created.id, requested);

    const waiting = await service.getWorkspace(created.id);
    expect(waiting.task.status).toBe('waiting_human');
    expect(waiting.pendingHumanQuestion).toBe('需要确认开头基调。');
    expect(waiting.nodes.map((node) => node.kind)).toEqual(['human_request']);

    await service.appendTestEvent(
      created.id,
      makeTaskEvent({
        type: 'human_answered',
        node: makeEventNode({ sequence: 2, agentId: 'writer', kind: 'human_answer' }),
        answer: '保持简洁。',
      }),
    );
    const answered = await service.getWorkspace(created.id);
    expect(answered.task.status).toBe('running');
    expect(answered.pendingHumanQuestion).toBeNull();
    expect(answered.nodes.map((node) => node.kind)).toEqual(['human_request', 'human_answer']);
  });

  it('renders superseded inputs as voided display nodes (spec §11.2)', async () => {
    const created = await service.createTask(validTaskRequest());
    await service.appendTestEvent(created.id, makeTaskEvent({ type: 'task_started' }));
    const pendingInput = makeTaskEvent({
      id: 'pending-input-1',
      type: 'agent_input',
      node: makeEventNode({ sequence: 1, agentId: 'writer', kind: 'input', title: '输入', body: '待执行' }),
    });
    await service.appendTestEvent(created.id, pendingInput);
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({ type: 'pending_inputs_superseded', supersededNodeIds: ['pending-input-1'] }),
    );

    const workspace = await service.getWorkspace(created.id);
    expect(workspace.nodes.find((node) => node.id === 'pending-input-1')?.superseded).toBe(true);

    // The synthesized replacement input is a fresh node: not voided.
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({
        id: 'synthesize-continue-0',
        type: 'agent_input',
        node: makeEventNode({
          sequence: 2,
          agentId: 'writer',
          kind: 'input',
          title: '合成输入',
          body: '引导',
          inputVersion: 1,
        }),
      }),
    );
    const after = await service.getWorkspace(created.id);
    expect(after.nodes.find((node) => node.id === 'pending-input-1')?.superseded).toBe(true);
    expect(after.nodes.find((node) => node.id === 'synthesize-continue-0')?.superseded).toBeUndefined();
  });

  it('folds a resume over an unanswered question back to waiting_human', async () => {
    // Plan 2026-08-06: the run loop never executes a Turn while a question
    // is pending, and `answer` is only reachable from waiting_human — so a
    // stop/resume cycle over an unanswered request must return to waiting,
    // never to `running` (which would park the question interrupted).
    const created = await service.createTask(validTaskRequest());
    await service.appendTestEvent(created.id, makeTaskEvent({ type: 'task_started' }));
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({
        type: 'human_requested',
        node: makeEventNode({ sequence: 1, agentId: 'writer', kind: 'human_request' }),
        question: '需要确认开头基调。',
      }),
    );
    await service.appendTestEvent(created.id, makeTaskEvent({ type: 'task_stopped' }));
    await service.appendTestEvent(created.id, makeTaskEvent({ type: 'task_resumed' }));

    const resumed = await service.getWorkspace(created.id);
    expect(resumed.task.status).toBe('waiting_human');
    expect(resumed.pendingHumanQuestion).toBe('需要确认开头基调。');

    // An answered question keeps the ordinary resume semantics.
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({
        type: 'human_answered',
        node: makeEventNode({ sequence: 2, agentId: 'writer', kind: 'human_answer' }),
        answer: '保持简洁。',
      }),
    );
    await service.appendTestEvent(created.id, makeTaskEvent({ type: 'task_stopped' }));
    await service.appendTestEvent(created.id, makeTaskEvent({ type: 'task_resumed' }));
    expect((await service.getWorkspace(created.id)).task.status).toBe('running');
  });

  it('derives retryable_failure from a non-retryable attempt failure', async () => {
    const created = await service.createTask(validTaskRequest());
    await service.appendTestEvent(created.id, makeTaskEvent({ type: 'task_started' }));
    const inputEvent = makeTaskEvent({
      type: 'agent_input',
      node: makeEventNode({ sequence: 1, agentId: 'writer', kind: 'input' }),
    });
    await service.appendTestEvent(created.id, inputEvent);
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({
        type: 'agent_attempt_failed',
        nodeId: inputEvent.id,
        message: '模型不可用。',
        retryable: false,
      }),
    );

    const workspace = await service.getWorkspace(created.id);
    expect(workspace.task.status).toBe('retryable_failure');

    // A retryable failure keeps the task running (auto-retry continues).
    const retryable = await service.createTask(validTaskRequest());
    await service.appendTestEvent(retryable.id, makeTaskEvent({ type: 'task_started' }));
    const retryInput = makeTaskEvent({
      type: 'agent_input',
      node: makeEventNode({ sequence: 1, agentId: 'writer', kind: 'input' }),
    });
    await service.appendTestEvent(retryable.id, retryInput);
    await service.appendTestEvent(
      retryable.id,
      makeTaskEvent({
        type: 'agent_attempt_failed',
        nodeId: retryInput.id,
        message: '调用超时。',
        retryable: true,
      }),
    );
    expect((await service.getWorkspace(retryable.id)).task.status).toBe('running');
  });

  it('never infers completion from agent text', async () => {
    const created = await service.createTask(validTaskRequest());
    await service.appendTestEvent(created.id, makeTaskEvent({ type: 'task_started' }));
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({
        type: 'agent_result',
        node: makeEventNode({
          sequence: 1,
          agentId: 'reviewer',
          kind: 'result',
          body: '任务已完成，终稿已交付，可以通过。',
        }),
      }),
    );

    const workspace = await service.getWorkspace(created.id);
    expect(workspace.task.status).toBe('running');
    expect(workspace.task.status).not.toBe('completed');
  });

  it('marks the final artifact and completes only on final_submission_accepted', async () => {
    const created = await service.createTask(validTaskRequest());
    await service.appendTestEvent(created.id, makeTaskEvent({ type: 'task_started' }));
    const first = await service.publishTestArtifact(created.id, {
      title: '初稿',
      files: [{ name: 'content.md', content: '初稿正文' }],
      sourceNodeId: randomUUID(),
      format: 'markdown',
    });
    const second = await service.publishTestArtifact(created.id, {
      title: '终稿',
      files: [{ name: 'content.md', content: '终稿正文' }],
      sourceNodeId: randomUUID(),
      format: 'markdown',
    });

    const beforeAccept = await service.getWorkspace(created.id);
    expect(beforeAccept.artifacts.map((artifact) => artifact.version)).toEqual([1, 2]);
    expect(beforeAccept.artifacts.every((artifact) => artifact.final === false)).toBe(true);
    expect(beforeAccept.task.latestVersion).toBe(2);
    expect(beforeAccept.task.status).toBe('running');

    await service.appendTestEvent(
      created.id,
      makeTaskEvent({
        type: 'final_submission_accepted',
        artifactId: second.id,
        version: second.version,
      }),
    );

    const accepted = await service.getWorkspace(created.id);
    expect(accepted.task.status).toBe('completed');
    expect(accepted.artifacts.find((artifact) => artifact.id === second.id)?.final).toBe(true);
    expect(accepted.artifacts.find((artifact) => artifact.id === first.id)?.final).toBe(false);
    expect(accepted.artifacts.find((artifact) => artifact.id === second.id)?.files[0].content).toBe(
      '终稿正文',
    );
  });

  it('projects one corrupt task while keeping healthy tasks visible', async () => {
    const healthyTask = await service.createTask(validTaskRequest());
    const corruptTask = await service.createTask(validTaskRequest());
    await service.appendTestEvent(healthyTask.id, makeTaskEvent({ type: 'task_started' }));
    await service.appendTestEvent(corruptTask.id, makeTaskEvent({ type: 'task_started' }));
    // Break a committed event of the second task: torn JSON in the history.
    await writeFile(
      join(paths.taskEventsRoot(corruptTask.id), formatEventFileName(2, randomUUID())),
      '{corrupt',
      'utf8',
    );

    const tasks = await service.listTasks();
    expect(tasks.find((item) => item.id === corruptTask.id)?.status).toBe('corrupt');
    expect(tasks.find((item) => item.id === corruptTask.id)?.diagnostic).not.toBeNull();
    expect(tasks.find((item) => item.id === healthyTask.id)?.status).not.toBe('corrupt');
    expect(tasks.find((item) => item.id === healthyTask.id)?.status).toBe('running');
  });

  it('ignores temporary residue in events and artifacts', async () => {
    const created = await service.createTask(validTaskRequest());
    await service.appendTestEvent(created.id, makeTaskEvent({ type: 'task_started' }));
    const inputEvent = makeTaskEvent({
      type: 'agent_input',
      node: makeEventNode({ sequence: 1, agentId: 'writer', kind: 'input' }),
    });
    await service.appendTestEvent(created.id, inputEvent);
    await service.publishTestArtifact(created.id, {
      title: '初稿',
      files: [{ name: 'content.md', content: '初稿正文' }],
      sourceNodeId: inputEvent.id,
      format: 'markdown',
    });

    // Torn staging residue that must never be projected (spec §8.2).
    const stagingDir = join(paths.taskArtifactsRoot(created.id), `.tmp-v002-${randomUUID()}`);
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, 'meta.json'), '{staging', 'utf8');
    writeFileSync(join(paths.taskArtifactsRoot(created.id), 'notes.txt'), 'irrelevant', 'utf8');
    await writeFile(
      join(paths.taskEventsRoot(created.id), `.tmp-000004-${randomUUID()}.json`),
      '{garbage',
      'utf8',
    );

    const workspace = await service.getWorkspace(created.id);
    expect(workspace.nodes.map((node) => node.id)).toEqual([inputEvent.id]);
    expect(workspace.artifacts.map((artifact) => artifact.version)).toEqual([1]);
    expect(workspace.task.status).toBe('running');
  });
});

/* Phase E Task 3: turn attribution and skill nodes. The committed result id
 * `<inputId>-t<n>-result` derives the result node's turnId (suffix stripped),
 * and `skill_loaded` folds into a display-only skill node attributed to the
 * most recent node-carrying agent — never changing the task status. */
describe('task-projector phase E: turn ids and skill nodes', () => {
  it('derives the result turnId and folds skill_loaded into a skill node', async () => {
    const created = await service.createTask(validTaskRequest());
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({
        id: 'in-a',
        type: 'agent_input',
        node: makeEventNode({ sequence: 1, agentId: 'writer', kind: 'input' }),
      }),
    );
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({
        id: 'in-t1-result',
        type: 'agent_result',
        node: makeEventNode({ sequence: 2, agentId: 'writer', kind: 'result' }),
      }),
    );
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({ id: 'skill-ev-1', type: 'skill_loaded', skillId: 's1' }),
    );

    const workspace = await service.getWorkspace(created.id);
    expect(workspace.nodes.map((node) => node.id)).toEqual(['in-a', 'in-t1-result', 'skill-ev-1']);

    const inputNode = workspace.nodes.find((node) => node.id === 'in-a');
    expect(inputNode?.turnId).toBeNull();
    const resultNode = workspace.nodes.find((node) => node.id === 'in-t1-result');
    expect(resultNode?.turnId).toBe('in-t1');

    const skillNode = workspace.nodes.find((node) => node.id === 'skill-ev-1');
    expect(skillNode).toEqual({
      id: 'skill-ev-1',
      sequence: 3,
      agentId: 'writer',
      kind: 'skill',
      title: 's1',
      body: 's1',
      status: 'confirmed',
      attemptCount: 1,
      inputVersion: null,
      turnId: 'in-t1',
    });
    // A skill load never changes the projected task status.
    expect(workspace.task.status).toBe('running');
  });

  it('defends a skill_loaded before any node with an empty agentId and null turnId', async () => {
    const created = await service.createTask(validTaskRequest());
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({ id: 'skill-ev-x', type: 'skill_loaded', skillId: 's2' }),
    );

    const workspace = await service.getWorkspace(created.id);
    const skillNode = workspace.nodes.find((node) => node.id === 'skill-ev-x');
    expect(skillNode).toMatchObject({
      id: 'skill-ev-x',
      sequence: 1,
      agentId: '',
      kind: 'skill',
      title: 's2',
      status: 'confirmed',
      attemptCount: 1,
      inputVersion: null,
      turnId: null,
    });
  });
});

describe('task-projector incompatibility gate (plan 2026-08-04 Task 3, spec §7.3)', () => {
  it('projects task_incompatible as the terminal incompatible status with diagnostic', async () => {
    const created = await service.createTask(validTaskRequest());
    await service.appendTestEvent(created.id, makeTaskEvent({ type: 'task_started' }));
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({ type: 'task_incompatible', reason: 'TURN_CONTRACT_REQUIRED' }),
    );

    const workspace = await service.getWorkspace(created.id);
    expect(workspace.task.status).toBe('incompatible');
    expect(workspace.task.diagnostic).toContain('回合契约');
    expect(workspace.task.currentAgentName).toBeNull();
  });

  it('folds task_incompatible onto the existing history without dropping nodes', async () => {
    const created = await service.createTask(validTaskRequest());
    const inputEvent = makeTaskEvent({
      type: 'agent_input',
      node: makeEventNode({ sequence: 1, agentId: 'writer', kind: 'input' }),
    });
    await service.appendTestEvent(created.id, inputEvent);
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({ type: 'task_incompatible', reason: 'TURN_CONTRACT_REQUIRED' }),
    );

    const workspace = await service.getWorkspace(created.id);
    expect(workspace.task.status).toBe('incompatible');
    expect(workspace.nodes.map((node) => node.id)).toEqual([inputEvent.id]);
  });

  it('rejects a task_incompatible event without the declared reason', async () => {
    const created = await service.createTask(validTaskRequest());
    await expect(
      service.appendTestEvent(created.id, {
        id: randomUUID(),
        at: new Date().toISOString(),
        // Cast: the exact-keys/enum validation must fail loud before storage.
        type: 'task_incompatible',
        reason: 'SOMETHING_ELSE',
      } as never),
    ).rejects.toMatchObject({ code: 'EVENT_INVALID' });
  });
});

/* ------------------- structured slots summary (spec §14 / I01) ------------------- */

import type { StructuredBlobRefV1 } from '../../shared/structured-slots';
import type { FrozenTemplate } from '../template/template-schema';

/** Minimal structured frozen template: only the projection reads productionMode. */
const STRUCTURED_FROZEN = {
  productionMode: 'structured_slots',
} as FrozenTemplate;

const BASIC_FROZEN = {
  productionMode: 'basic',
} as FrozenTemplate;

function blobRef(kind: StructuredBlobRefV1['kind'], seed = 'a'): StructuredBlobRefV1 {
  return { version: 1, kind, sha256: seed.repeat(64), byteLength: 4 };
}

function generationEvent(overrides: Record<string, unknown> = {}) {
  return makeTaskEvent({
    type: 'structured_scaffold_generation_committed',
    scaffoldId: 'scaffold-1',
    generationId: 'gen-1',
    supersedesGenerationId: null,
    rootSlotId: 'root',
    slotCount: 4,
    maxDepth: 2,
    structure: blobRef('generation'),
    content: blobRef('content_revision', 'c'),
    contentRevision: 0,
    proposalId: 'prop-1',
    ...overrides,
  });
}

function mergedDraftEvent(changeCount: number, resultRevision = 1) {
  return makeTaskEvent({
    type: 'structured_fill_draft_terminal',
    draftId: 'draft-1',
    turnId: 'turn-1',
    status: 'merged',
    baseRevision: 0,
    resultRevision,
    changeCount,
    content: blobRef('content_revision', 'd'),
  });
}

function staleDraftEvent() {
  return makeTaskEvent({
    type: 'structured_fill_draft_terminal',
    draftId: 'draft-2',
    turnId: 'turn-2',
    status: 'stale',
    baseRevision: 0,
    resultRevision: 0,
    changeCount: 0,
    content: null,
  });
}

function sealedEvent() {
  return makeTaskEvent({
    type: 'structured_scaffold_sealed',
    sealId: 'seal-1',
    scaffoldId: 'scaffold-1',
    generationId: 'gen-1',
    scaffoldRevision: 1,
    sealRecord: blobRef('seal_record', 's'),
    artifactId: 'artifact-1',
    artifactVersion: 1,
  });
}

describe('projectStructuredSlotsSummary (spec §14 / I01)', () => {
  it('returns null for basic templates', () => {
    expect(projectStructuredSlotsSummary([], BASIC_FROZEN)).toBeNull();
  });

  it('returns a pre-scaffold summary for a structured template before any events', () => {
    const summary = projectStructuredSlotsSummary([], STRUCTURED_FROZEN);
    expect(summary).toEqual({
      version: 1,
      mode: 'structured_slots',
      scaffoldId: null,
      generationId: null,
      contentRevision: null,
      structureStatus: 'none',
      sealStatus: 'unsealed',
      visibleSlotCount: 0,
      filledSlotCount: 0,
      issueSummary: { errors: 0, warnings: 0 },
    });
  });

  it('reports the exact set-count from the active content root', () => {
    const events = [generationEvent(), mergedDraftEvent(2), staleDraftEvent(), sealedEvent()];
    // The active content root is the authoritative filled-set (design §18.3):
    // two set slots even though one merge touched a different slot twice.
    const contentRoot = {
      title: 'a'.repeat(64),
      body: 'b'.repeat(64),
      note: 'unset',
    };
    const summary = projectStructuredSlotsSummary(events, STRUCTURED_FROZEN, contentRoot);
    expect(summary).toEqual({
      version: 1,
      mode: 'structured_slots',
      scaffoldId: 'scaffold-1',
      generationId: 'gen-1',
      contentRevision: 1,
      structureStatus: 'active',
      sealStatus: 'sealed',
      visibleSlotCount: 4,
      filledSlotCount: 2,
      issueSummary: { errors: 1, warnings: 0 },
    });
    // The summary never embeds content, the tree, Drafts or Grants.
    expect(Object.keys(summary ?? {}).sort()).toEqual([
      'contentRevision',
      'filledSlotCount',
      'generationId',
      'issueSummary',
      'mode',
      'scaffoldId',
      'sealStatus',
      'structureStatus',
      'version',
      'visibleSlotCount',
    ]);
  });

  it('reports 0 filled when no active content root is committed', () => {
    // Merged drafts alone must NOT synthesize a filled count: the summary is
    // scoped to the active generation's content root.
    const events = [generationEvent(), mergedDraftEvent(9)];
    expect(projectStructuredSlotsSummary(events, STRUCTURED_FROZEN)?.filledSlotCount).toBe(0);
    expect(projectStructuredSlotsSummary(events, STRUCTURED_FROZEN, null)?.filledSlotCount).toBe(0);
  });

  it('never counts a superseded generation or double-counts a slot', () => {
    // gen-1 commits and fills two slots; gen-2 supersedes it with a fresh root
    // that only fills one — the summary follows the ACTIVE root.
    const events = [
      generationEvent({ scaffoldId: 'scaffold-1', generationId: 'gen-1', slotCount: 2 }),
      generationEvent({ scaffoldId: 'scaffold-2', generationId: 'gen-2', slotCount: 7 }),
    ];
    const contentRoot = { title: 'a'.repeat(64), note: 'unset' };
    const summary = projectStructuredSlotsSummary(events, STRUCTURED_FROZEN, contentRoot);
    expect(summary?.scaffoldId).toBe('scaffold-2');
    expect(summary?.generationId).toBe('gen-2');
    expect(summary?.contentRevision).toBe(0);
    expect(summary?.visibleSlotCount).toBe(7);
    expect(summary?.filledSlotCount).toBe(1);
  });

  it('caps the count at the visible slot count defensively', () => {
    const events = [generationEvent({ slotCount: 2 })];
    const contentRoot = { a: '1'.repeat(64), b: '2'.repeat(64), c: '3'.repeat(64) };
    expect(projectStructuredSlotsSummary(events, STRUCTURED_FROZEN, contentRoot)?.filledSlotCount).toBe(2);
  });

  it('a later generation supersedes the earlier one for the active identity', () => {
    const events = [
      generationEvent({ scaffoldId: 'scaffold-1', generationId: 'gen-1', slotCount: 2 }),
      generationEvent({ scaffoldId: 'scaffold-2', generationId: 'gen-2', slotCount: 7 }),
    ];
    const summary = projectStructuredSlotsSummary(events, STRUCTURED_FROZEN, {});
    expect(summary?.scaffoldId).toBe('scaffold-2');
    expect(summary?.generationId).toBe('gen-2');
    expect(summary?.visibleSlotCount).toBe(7);
  });
});

describe('deriveOwnerIssues (spec §14 owner-visible issues)', () => {
  it('derives a DRAFT_STALE error for a stale draft terminal and nothing else', () => {
    const issues = deriveOwnerIssues([generationEvent(), mergedDraftEvent(1), staleDraftEvent()]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      version: 1,
      code: 'DRAFT_STALE',
      severity: 'error',
      phase: 'merge',
      source: 'lifecycle',
      primaryLocation: { kind: 'operation' },
    });
    expect(JSON.stringify(issues[0])).not.toContain('draft-2');
  });

  it('derives no issues from a clean structured history', () => {
    expect(deriveOwnerIssues([generationEvent(), mergedDraftEvent(1), sealedEvent()])).toEqual([]);
  });
});
