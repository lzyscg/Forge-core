import { describe, expect, it } from 'vitest';
import type { MockScenarioId } from '../../shared/contracts';
import { runForgeCoreGatewayContract } from '../gateway/forge-core-gateway.contract';
import {
  INPUT_CHAPTER_BRIEF_ID,
  MOCK_SKILLS,
  SKILL_CHAPTER_REVIEW_ID,
  SKILL_CHAPTER_WRITING_ID,
  TEMPLATE_ID,
  templateFixture,
} from './__fixtures__/zhihu-single-chapter';
import {
  MemoryStorage,
  corruptOneTask,
  createFixedClock,
  createSimulatorHarness,
  fixedClock,
  seededStorage,
  validCreateRequest,
} from './mock-fixtures';
import { createMockGateway } from './mock-gateway';

describe('createMockGateway', () => {
  it('persists tasks under versioned mock keys', async () => {
    const storage = new MemoryStorage();
    const gateway = createMockGateway(storage, fixedClock);
    const task = await gateway.createTask(validCreateRequest);
    expect(storage.keys()).toContain('forge-core:mock:v1:tasks');
    expect((await gateway.listTasks()).map((item) => item.id)).toContain(task.id);
  });

  it('isolates one corrupt task and keeps the catalog usable', async () => {
    const storage = seededStorage();
    corruptOneTask(storage, 'task-corrupt');
    const gateway = createMockGateway(storage, fixedClock);
    expect((await gateway.listTemplates()).length).toBeGreaterThan(0);
    expect((await gateway.listTasks()).find((task) => task.id === 'task-corrupt')?.status).toBe(
      'corrupt',
    );
  });

  it('isolates corrupt tasks without affecting healthy siblings', async () => {
    const storage = seededStorage();
    corruptOneTask(storage, 'task-corrupt');
    const gateway = createMockGateway(storage, fixedClock);

    const tasks = await gateway.listTasks();
    const corrupt = tasks.find((task) => task.id === 'task-corrupt');
    expect(corrupt?.status).toBe('corrupt');
    expect(typeof corrupt?.diagnostic).toBe('string');
    expect((corrupt?.diagnostic ?? '').length).toBeGreaterThan(0);

    const healthy = tasks.filter((task) => task.id !== 'task-corrupt');
    expect(healthy.length).toBeGreaterThanOrEqual(2);
    expect(healthy.every((task) => task.status !== 'corrupt')).toBe(true);

    await expect(gateway.getWorkspace('task-corrupt')).rejects.toMatchObject({
      code: 'TASK_CORRUPTED',
    });
    await expect(gateway.startTask('task-corrupt')).rejects.toMatchObject({
      code: 'TASK_CORRUPTED',
    });
  });

  it('moves a task through start, stop and resume', async () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock());
    const task = await gateway.createTask(validCreateRequest);
    expect(task.status).toBe('ready');

    await gateway.startTask(task.id);
    expect((await gateway.getWorkspace(task.id)).task.status).toBe('running');

    await gateway.stopTask(task.id);
    expect((await gateway.getWorkspace(task.id)).task.status).toBe('stopped');

    await gateway.resumeTask(task.id);
    expect((await gateway.getWorkspace(task.id)).task.status).toBe('running');
  });

  it('allows at most one running task across the whole workspace', async () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock());
    const first = await gateway.createTask({ ...validCreateRequest, name: 'first' });
    const second = await gateway.createTask({ ...validCreateRequest, name: 'second' });

    await gateway.startTask(first.id);
    await expect(gateway.startTask(second.id)).rejects.toMatchObject({
      code: 'TASK_ALREADY_RUNNING',
    });

    await gateway.stopTask(first.id);
    await gateway.startTask(second.id);
    expect((await gateway.getWorkspace(second.id)).task.status).toBe('running');
  });

  it('guards retry and human answer behind their required states', async () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock());
    const task = await gateway.createTask(validCreateRequest);

    await expect(gateway.retryTask(task.id)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(gateway.answerHuman(task.id, 'some answer')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await expect(gateway.stopTask(task.id)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('rejects lifecycle operations on unknown tasks with TASK_NOT_FOUND', async () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock());
    await expect(gateway.getWorkspace('task-missing')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    await expect(gateway.stopTask('task-missing')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    await expect(gateway.resumeTask('task-missing')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    await expect(gateway.retryTask('task-missing')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    await expect(gateway.answerHuman('task-missing', 'x')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });

  it('validates declared input fields on createTask', async () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock());

    const missing = { ...templateFixture.sampleInput };
    delete missing[INPUT_CHAPTER_BRIEF_ID];
    await expect(
      gateway.createTask({ ...validCreateRequest, input: missing }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await expect(
      gateway.createTask({
        ...validCreateRequest,
        input: { ...templateFixture.sampleInput, 'undeclared-field': 'x' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await expect(
      gateway.createTask({ ...validCreateRequest, input: {}, templateId: 'template-missing' }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });

    await expect(gateway.createTask({ ...validCreateRequest, name: '  ' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('notifies watchers only while subscribed', async () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock());
    const task = await gateway.createTask(validCreateRequest);
    let count = 0;
    const unsubscribe = gateway.watchTask(task.id, () => {
      count += 1;
    });

    await gateway.startTask(task.id);
    expect(count).toBeGreaterThan(0);
    const seen = count;

    unsubscribe();
    await gateway.stopTask(task.id);
    expect(count).toBe(seen);

    expect(() => gateway.watchTask('task-missing', () => {})).toThrowError();
  });

  it('lists thirteen placeholder capabilities, all unclaimed', async () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock());
    const capabilities = await gateway.getCapabilities();
    expect(capabilities).toHaveLength(13);
    for (const capability of capabilities) {
      expect(capability.productShape).toBe('not_started');
      expect(capability.backendConnection).toBe('not_started');
      expect(capability.realAcceptance).toBe('not_started');
      expect(capability.observedAt).toBeNull();
    }
    expect(capabilities.map((capability) => capability.id)).toContain('final_output');
  });

  it('persists the next scenario across gateway instances', async () => {
    const storage = new MemoryStorage();
    const clock = createFixedClock();
    const gateway = createMockGateway(storage, clock);
    expect(await gateway.getNextScenario()).toBe('happy_path');

    await gateway.setNextScenario('manual_retry');
    const reopened = createMockGateway(storage, clock);
    expect(await reopened.getNextScenario()).toBe('manual_retry');

    await expect(
      gateway.setNextScenario('not_a_scenario' as unknown as MockScenarioId),
    ).rejects.toMatchObject({ code: 'INVALID_SCENARIO' });
  });

  it('resetMockData clears only the mock namespace and reseeds templates', async () => {
    const storage = new MemoryStorage();
    storage.setItem('unrelated:key', 'keep me');
    const gateway = createMockGateway(storage, createFixedClock());
    await gateway.createTask(validCreateRequest);
    await gateway.setNextScenario('human_input');
    expect(storage.keys()).toContain('forge-core:mock:v1:tasks');

    await gateway.resetMockData();

    expect(storage.keys().some((key) => key.startsWith('forge-core:mock:v1:'))).toBe(false);
    expect(storage.getItem('unrelated:key')).toBe('keep me');
    expect(await gateway.listTasks()).toEqual([]);
    expect((await gateway.listTemplates()).length).toBeGreaterThan(0);
    expect(await gateway.getNextScenario()).toBe('happy_path');
  });

  it('answers a pending human question from a seeded waiting task', async () => {
    const storage = seededStorage();
    const gateway = createMockGateway(storage, createFixedClock());
    const tasks = await gateway.listTasks();
    const waiting = tasks.find((task) => task.status === 'waiting_human');
    if (!waiting) throw new Error('seeded storage should contain a waiting_human task');

    const before = await gateway.getWorkspace(waiting.id);
    expect(before.pendingHumanQuestion).not.toBeNull();

    await gateway.answerHuman(waiting.id, '补充后的信息');
    const after = await gateway.getWorkspace(waiting.id);
    expect(after.task.status).toBe('running');
    expect(after.pendingHumanQuestion).toBeNull();
    expect(after.nodes.some((node) => node.kind === 'human_answer')).toBe(true);
  });
});

// Shared contract suite: the same cases Phase B HttpGateway must pass.
runForgeCoreGatewayContract(() => createMockGateway(new MemoryStorage(), fixedClock));

describe('createMockGateway phase E reads (plan Task E4 Step 1)', () => {
  it('serves the recorded turn trace with public text and final phase, never thinking', async () => {
    const harness = createSimulatorHarness('happy_path');
    const task = await harness.createAndRun();
    await harness.clock.runAll();

    const trace = await harness.gateway.getTurnTrace(task.id, `turn-${task.id}-2`);
    expect(trace).toEqual({
      turnId: `turn-${task.id}-2`,
      // The shipped scripts declare the turn's display-only final phase
      // (plan 2026-08-04 Task 6): mock mode can demonstrate the phase row.
      phase: {
        state: 'dispatched',
        dispatchAction: 'publish_artifact',
        target: '章节审核',
        message: null,
      },
      // Provider thinking is never durable (semantic audit P0): only the
      // public text survives, even though the script declared thinking.
      entries: [
        { kind: 'text', text: templateFixture.sampleArtifacts.v1.content },
      ],
    });
  });

  it('checks task identity first, then reports missing traces as TRACE_NOT_FOUND', async () => {
    const harness = createSimulatorHarness('happy_path');
    const task = await harness.gateway.createTask(validCreateRequest);
    await expect(
      harness.gateway.getTurnTrace(task.id, `turn-${task.id}-99`),
    ).rejects.toMatchObject({ code: 'TRACE_NOT_FOUND' });
    await expect(harness.gateway.getTurnTrace('task-missing', 'turn-x')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });

  it('serves declared skill content from the fixture and rejects unknown skills', async () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock());
    const task = await gateway.createTask(validCreateRequest);
    for (const skillId of [SKILL_CHAPTER_WRITING_ID, SKILL_CHAPTER_REVIEW_ID]) {
      const content = await gateway.getSkillContent(task.id, skillId);
      expect(content).toEqual({ skillId, ...MOCK_SKILLS[skillId] });
      expect(content.versionHash).toMatch(/^[0-9a-f]{64}$/);
      expect(content.content.length).toBeGreaterThan(0);
    }
    await expect(gateway.getSkillContent(task.id, 'skill-ghost')).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
    });
    await expect(
      gateway.getSkillContent('task-missing', SKILL_CHAPTER_WRITING_ID),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  });

  it('clones a task ready, suffixed and with the identical frozen input', async () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock());
    const source = await gateway.createTask(validCreateRequest);

    const cloned = await gateway.cloneTask(source.id);
    expect(cloned.id).not.toBe(source.id);
    expect(cloned.status).toBe('ready');
    expect(cloned.name).toBe(`${validCreateRequest.name}（重跑）`);
    expect(cloned.templateId).toBe(TEMPLATE_ID);

    const workspace = await gateway.getWorkspace(cloned.id);
    expect(workspace.frozenInput).toEqual(templateFixture.sampleInput);
    expect(workspace.templateVersion).toBe(templateFixture.template.version);
    expect(workspace.nodes).toEqual([]);

    await expect(gateway.cloneTask('task-missing')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });

  it('truncates clone names at 120 code points exactly like the server', async () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock());

    const exact = await gateway.createTask({ ...validCreateRequest, name: '名'.repeat(116) });
    const exactClone = await gateway.cloneTask(exact.id);
    expect([...exactClone.name].length).toBe(120);
    expect(exactClone.name.endsWith('（重跑）')).toBe(true);

    const over = await gateway.createTask({ ...validCreateRequest, name: '名'.repeat(117) });
    const overClone = await gateway.cloneTask(over.id);
    expect([...overClone.name].length).toBe(120);
    expect(overClone.name).toBe(`${'名'.repeat(117)}（重跑`);
  });
});

describe('createMockGateway deleteTask (task list delete)', () => {
  it('deletes tasks in every seeded status, corrupt included', async () => {
    const storage = seededStorage();
    corruptOneTask(storage, 'task-corrupt');
    const gateway = createMockGateway(storage, createFixedClock());
    const before = await gateway.listTasks();
    expect(before.length).toBeGreaterThanOrEqual(4);

    for (const task of before) {
      await gateway.deleteTask(task.id);
      await expect(gateway.getWorkspace(task.id)).rejects.toMatchObject({
        code: 'TASK_NOT_FOUND',
      });
    }
    expect(await gateway.listTasks()).toEqual([]);
  });

  it('stops a running task before deleting it so no scheduled step survives', async () => {
    const harness = createSimulatorHarness('happy_path');
    const task = await harness.createAndRun();
    expect((await harness.gateway.getWorkspace(task.id)).task.status).toBe('running');

    await harness.gateway.deleteTask(task.id);

    expect((await harness.gateway.listTasks()).map((item) => item.id)).not.toContain(task.id);
    // Every simulator timer was cleared with the record: draining the clock
    // fires nothing and never touches the deleted task again.
    await harness.clock.runAll();
    expect(await harness.gateway.listTasks()).toEqual([]);
  });

  it('rejects deletion of unknown tasks with TASK_NOT_FOUND', async () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock());
    await expect(gateway.deleteTask('task-missing')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });

  it('rejects every structured read on a basic task with STRUCTURED_NOT_ACTIVE', async () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock());
    const task = await gateway.createTask(validCreateRequest);
    const calls: Array<() => Promise<unknown>> = [
      () => gateway.getStructuredContract(task.id),
      () => gateway.listStructuredSlots(task.id, null, 5),
      () => gateway.getStructuredSlot(task.id, 'root'),
      () => gateway.listStructuredIssues(task.id, null, 5),
      () => gateway.getStructuredSeal(task.id),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: 'STRUCTURED_NOT_ACTIVE' });
    }
    // Unknown tasks keep their own stable code before the absence check.
    await expect(gateway.getStructuredContract('task-missing')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });
});
