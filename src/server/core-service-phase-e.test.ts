// @vitest-environment node
/**
 * CoreService Phase E wiring tests (plan Phase E Task 3 Step 1).
 *
 * The service owns the trace/workspace stores and exposes the three Phase E
 * read/clone flows: `getTurnTrace` (task identity first, then the per-turn
 * trace file), `getSkillContent` (display read through the SkillService) and
 * `cloneTask` (a fresh frozen task from the source's frozen input on the
 * CURRENT template version, named `<source name>（重跑）` truncated to 120
 * code points). The private projection enriches skill node bodies with the
 * loaded content's display version hash; any failure keeps the skillId body.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillContent, TaskSummary, TurnTrace } from '../shared/contracts';
import { CoreService } from './core-service';
import type { AgentRuntime } from './runtime/agent-runtime';
import {
  catalogWithOneTemplate,
  disposeAllTestRoots,
  makeEventNode,
  makeTaskEvent,
  ONE_TEMPLATE_ID,
  validTaskRequest,
} from './test-support';

afterEach(() => {
  disposeAllTestRoots();
});

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function phaseEService(): Promise<CoreService> {
  const fixture = await catalogWithOneTemplate();
  const service = new CoreService(fixture.paths);
  await service.initialize();
  return service;
}

describe('CoreService cloneTask (plan Task E3 Step 1)', () => {
  it('clones with the rerun suffix, ready status and identical frozen input', async () => {
    const service = await phaseEService();
    const source = await service.createTask(validTaskRequest());

    const cloned = await service.cloneTask(source.id);
    expect(cloned.id).not.toBe(source.id);
    expect(cloned.name).toBe('冻结任务（重跑）');
    expect(cloned.status).toBe('ready');
    expect(cloned.templateId).toBe(source.templateId);
    expect(cloned).not.toHaveProperty('templateVersion');
    // The clone's protocol derives from its freshly frozen snapshot through
    // the shared helper (spec §4.1): basic template -> 'none'.
    expect(cloned.structuredProtocol).toBe('none');

    const sourceWorkspace = await service.getWorkspace(source.id);
    const clonedWorkspace = await service.getWorkspace(cloned.id);
    expect(clonedWorkspace.frozenInput).toEqual(sourceWorkspace.frozenInput);
    expect(clonedWorkspace.frozenInput).toEqual(validTaskRequest().input);
  });

  it('freezes the clone on the current template version while the source keeps its hash', async () => {
    const service = await phaseEService();
    const source = await service.createTask(validTaskRequest());
    const oldHash = (await service.getWorkspace(source.id)).templateVersion;
    expect(oldHash).toMatch(/^[0-9a-f]{64}$/);

    // Switch the template to a new current version, then clone. The version
    // hash covers the parsed canonical content, so a real field must change.
    const sourceFile = join(service.paths.templateSource(ONE_TEMPLATE_ID), 'template.yaml');
    const original = readFileSync(sourceFile, 'utf8');
    writeFileSync(
      sourceFile,
      original.replace('产出单一终稿。', '产出单一终稿（克隆换版验证）。'),
      'utf8',
    );
    const reloaded = await service.templates.reload(ONE_TEMPLATE_ID);
    const newHash = service.templates.getFrozen(ONE_TEMPLATE_ID)?.versionHash;
    expect(newHash).toBeDefined();
    expect(newHash).not.toBe(oldHash);
    expect(reloaded.version).toBe(newHash?.slice(0, 12));

    const cloned = await service.cloneTask(source.id);
    expect((await service.getWorkspace(cloned.id)).templateVersion).toBe(newHash);
    expect((await service.getWorkspace(source.id)).templateVersion).toBe(oldHash);
  });

  it('truncates the clone name to 120 code points', async () => {
    const service = await phaseEService();
    const longName = '甲'.repeat(130);
    const source = await service.createTask({ ...validTaskRequest(), name: longName });

    const cloned = await service.cloneTask(source.id);
    const codePoints = [...cloned.name];
    expect(codePoints.length).toBe(120);
    expect(cloned.name.startsWith('甲'.repeat(116))).toBe(true);
  });

  it('rejects an unknown source task with TASK_NOT_FOUND', async () => {
    const service = await phaseEService();
    await expect(service.cloneTask('task-missing')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });
});

describe('CoreService getTurnTrace (plan Task E3 Step 1)', () => {
  it('reads a committed turn trace through the trace store', async () => {
    const service = await phaseEService();
    const created = await service.createTask(validTaskRequest());
    const entries = [
      { kind: 'text', text: '正文。' },
    ] as const;
    await service.traces.appendTurnTrace(created.id, 'turn-1', [...entries]);

    const trace = await service.getTurnTrace(created.id, 'turn-1');
    const expected: TurnTrace = { turnId: 'turn-1', entries: [...entries] };
    expect(trace).toEqual(expected);
  });

  it('returns null for a task without the requested trace', async () => {
    const service = await phaseEService();
    const created = await service.createTask(validTaskRequest());
    await expect(service.getTurnTrace(created.id, 'turn-missing')).resolves.toBeNull();
  });

  it('passes TASK_NOT_FOUND through for an unknown task', async () => {
    const service = await phaseEService();
    await expect(service.getTurnTrace('task-missing', 'turn-1')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });
});

describe('CoreService getSkillContent (plan Task E3 Step 1)', () => {
  it('returns the snapshot skill content with its version hash', async () => {
    const service = await phaseEService();
    const created = await service.createTask(validTaskRequest());

    const content = await service.getSkillContent(created.id, 'style-guide');
    const onDisk = readFileSync(
      join(service.paths.taskSnapshotRoot(created.id), 'skills/style-guide/SKILL.md'),
      'utf8',
    );
    const expected: SkillContent = {
      skillId: 'style-guide',
      content: onDisk,
      versionHash: sha256(onDisk),
    };
    expect(content).toEqual(expected);
  });

  it('returns null for a skill no agent declares', async () => {
    const service = await phaseEService();
    const created = await service.createTask(validTaskRequest());
    await expect(service.getSkillContent(created.id, 'ghost-skill')).resolves.toBeNull();
  });

  it('passes TASK_NOT_FOUND through for an unknown task', async () => {
    const service = await phaseEService();
    await expect(service.getSkillContent('task-missing', 'style-guide')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });
});

describe('CoreService skill node body enrichment (plan Task E3 Step 1)', () => {
  it('replaces the skill node body with the loaded version hash display value', async () => {
    const service = await phaseEService();
    const created = await service.createTask(validTaskRequest());
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({
        id: 'in-1',
        type: 'agent_input',
        node: makeEventNode({ sequence: 1, agentId: 'writer', kind: 'input' }),
      }),
    );
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({
        id: 'in-1-t1-result',
        type: 'agent_result',
        node: makeEventNode({ sequence: 2, agentId: 'writer', kind: 'result' }),
      }),
    );
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({ id: 'skill-1', type: 'skill_loaded', skillId: 'style-guide' }),
    );

    const workspace = await service.getWorkspace(created.id);
    const skillNode = workspace.nodes.find((node) => node.id === 'skill-1');
    const onDisk = readFileSync(
      join(service.paths.taskSnapshotRoot(created.id), 'skills/style-guide/SKILL.md'),
      'utf8',
    );
    expect(skillNode?.title).toBe('style-guide');
    expect(skillNode?.body).toBe(sha256(onDisk).slice(0, 12));
    expect(skillNode?.body).toMatch(/^[0-9a-f]{12}$/);
    expect(skillNode?.turnId).toBe('in-1-t1');
  });

  it('keeps the skillId body when the skill is not loadable', async () => {
    const service = await phaseEService();
    const created = await service.createTask(validTaskRequest());
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({
        id: 'in-1',
        type: 'agent_input',
        node: makeEventNode({ sequence: 1, agentId: 'writer', kind: 'input' }),
      }),
    );
    await service.appendTestEvent(
      created.id,
      makeTaskEvent({ id: 'skill-unknown', type: 'skill_loaded', skillId: 'undeclared-skill' }),
    );

    const workspace = await service.getWorkspace(created.id);
    const skillNode = workspace.nodes.find((node) => node.id === 'skill-unknown');
    expect(skillNode?.body).toBe('undeclared-skill');
  });
});

describe('CoreService runtime stack wiring (plan Task E3 Step 1)', () => {
  it('exposes the workspace and trace stores used by the runner', async () => {
    const service = await phaseEService();
    const created = await service.createTask(validTaskRequest());
    expect(service.workspaces).toBeDefined();
    expect(service.traces).toBeDefined();
    await service.workspaces.writeFile(created.id, 'writer', 'note.txt', '便条');
    await expect(service.workspaces.readFile(created.id, 'writer', 'note.txt')).resolves.toBe(
      '便条',
    );
  });
});

describe('CoreService runtime skill content reader wiring', () => {
  it('wires the runtime skill content reader to SkillService display reads', async () => {
    const fixture = await catalogWithOneTemplate();
    type SkillReader = (
      taskId: string,
      agentId: string,
      skillId: string,
    ) => Promise<{ content: string; versionHash: string } | null>;
    let captured: SkillReader | null = null;
    const stubRuntime = {
      run: async () => ({
        turnId: 't',
        publicText: '',
        actions: [],
        usage: null,
        trace: [],
      }),
      disposeAgent: async () => undefined,
      disposeAll: async () => undefined,
      setSkillContentReader: (reader: SkillReader) => {
        captured = reader;
      },
    };
    const service = new CoreService(fixture.paths, {
      runtime: stubRuntime as unknown as AgentRuntime,
    });
    await service.initialize();
    expect(captured).not.toBeNull();

    const created = await service.createTask(validTaskRequest());
    const authorized = await captured!(created.id, 'writer', 'style-guide');
    expect(authorized).not.toBeNull();
    expect(authorized?.content).toBeTruthy();
    expect(authorized?.versionHash).toMatch(/^[0-9a-f]{64}$/);

    const unauthorized = await captured!(created.id, 'writer', 'ghost-skill');
    expect(unauthorized).toBeNull();
  });
});
