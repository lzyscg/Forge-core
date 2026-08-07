import { describe, expect, it } from 'vitest';
import {
  MOCK_SKILLS,
  REVIEWER_AGENT_ID,
  SKILL_CHAPTER_WRITING_ID,
  WRITER_AGENT_ID,
  templateFixture,
} from './__fixtures__/zhihu-single-chapter';
import {
  MemoryStorage,
  createFixedClock,
  createSimulatorHarness,
  maximumConcurrentActiveAgents,
  validCreateRequest,
} from './mock-fixtures';
import { createMockGateway } from './mock-gateway';
import {
  MOCK_SCENARIOS,
  type MockScenarioDefinition,
  validateMockScenario,
} from './mock-scenarios';
import { turnIdFor } from './mock-simulator';
import type { MockTaskRecord } from './mock-schema';
import { MOCK_SCENARIO_IDS } from './mock-schema';
import { MockStore } from './mock-store';

describe('deterministic script registry', () => {
  it('exposes exactly the six frozen scenario ids with bounded delays', () => {
    expect(Object.keys(MOCK_SCENARIOS).sort()).toEqual([...MOCK_SCENARIO_IDS].sort());
    for (const id of MOCK_SCENARIO_IDS) {
      const scenario = MOCK_SCENARIOS[id];
      expect(scenario.id).toBe(id);
      expect(scenario.label.length).toBeGreaterThan(0);
      expect(scenario.description.length).toBeGreaterThan(0);
      expect(scenario.steps.length).toBeGreaterThan(0);
      for (const step of scenario.steps) {
        expect(step.delayMs).toBeGreaterThanOrEqual(450);
        expect(step.delayMs).toBeLessThanOrEqual(900);
      }
    }
  });

  it('validates every shipped script against the frozen fixture template', () => {
    for (const id of MOCK_SCENARIO_IDS) {
      expect(validateMockScenario(MOCK_SCENARIOS[id], templateFixture.template)).toEqual([]);
    }
  });
});

describe('plan Step 1 verbatim cases', () => {
  it('runs the review-return script serially and publishes V1 then V2', async () => {
    const harness = createSimulatorHarness('review_return_v2');
    const task = await harness.gateway.createTask(validCreateRequest);
    await harness.gateway.startTask(task.id);
    await harness.clock.runAll();
    const workspace = await harness.gateway.getWorkspace(task.id);
    expect(workspace.task.status).toBe('completed');
    expect(workspace.artifacts.map((item) => item.version)).toEqual([1, 2]);
    expect(maximumConcurrentActiveAgents(harness.events(task.id))).toBe(1);
  });

  it('exhausts automatic retries before enabling manual retry', async () => {
    const harness = createSimulatorHarness('manual_retry');
    const task = await harness.createAndRun();
    await harness.clock.runAll();
    expect((await harness.gateway.getWorkspace(task.id)).task.status).toBe('retryable_failure');
    await harness.gateway.retryTask(task.id);
    await harness.clock.runAll();
    expect((await harness.gateway.getWorkspace(task.id)).task.status).toBe('completed');
  });
});

describe('six deterministic scripts', () => {
  it('happy_path completes and marks only V1 final', async () => {
    const harness = createSimulatorHarness('happy_path');
    const task = await harness.createAndRun();
    await harness.clock.runAll();

    const workspace = await harness.gateway.getWorkspace(task.id);
    expect(workspace.task.status).toBe('completed');
    expect(workspace.artifacts.map((item) => item.version)).toEqual([1]);
    expect(workspace.artifacts[0].final).toBe(true);
    expect(workspace.artifacts[0].files[0]?.content).toBe(templateFixture.sampleArtifacts.v1.content);
    expect(maximumConcurrentActiveAgents(harness.events(task.id))).toBe(1);
  });

  it('review_return_v2 renders the full return loop with fixture bodies', async () => {
    const harness = createSimulatorHarness('review_return_v2');
    const task = await harness.createAndRun();
    await harness.clock.runAll();

    const workspace = await harness.gateway.getWorkspace(task.id);
    expect(workspace.nodes).toHaveLength(9);
    expect(workspace.executedRoutes).toHaveLength(3);
    const [v1, v2] = workspace.artifacts;
    expect(v1.files[0]?.content).toBe(templateFixture.sampleArtifacts.v1.content);
    expect(v2.files[0]?.content).toBe(templateFixture.sampleArtifacts.v2.content);
    expect(v1.final).toBe(false);
    expect(v2.final).toBe(true);
    // The return route is a message edge back to the writer lane.
    expect(workspace.executedRoutes[1].kind).toBe('message');
    expect(
      workspace.nodes.find((node) => node.id === workspace.executedRoutes[1].toNodeId)?.agentId,
    ).toBe(WRITER_AGENT_ID);
  });

  it('transient_retry groups the failed attempt into the original input node', async () => {
    const harness = createSimulatorHarness('transient_retry');
    const task = await harness.createAndRun();
    await harness.clock.runAll();

    const events = harness.events(task.id);
    const failures = events.filter((event) => event.type === 'agent_attempt_failed');
    expect(failures).toHaveLength(1);
    if (failures[0].type !== 'agent_attempt_failed') throw new Error('expected failure event');
    expect(failures[0].retryable).toBe(true);

    const workspace = await harness.gateway.getWorkspace(task.id);
    expect(workspace.task.status).toBe('completed');
    // Exactly one writer input node: the retry never creates a duplicate main node.
    const writerInputs = workspace.nodes.filter(
      (node) => node.kind === 'input' && node.agentId === WRITER_AGENT_ID,
    );
    expect(writerInputs).toHaveLength(1);
    expect(writerInputs[0].attemptCount).toBe(2);
    expect(failures[0].nodeId).toBe(writerInputs[0].id);
    const writerResult = workspace.nodes.find(
      (node) => node.kind === 'result' && node.agentId === WRITER_AGENT_ID,
    );
    expect(writerResult?.attemptCount).toBe(2);
  });

  it('manual_retry records two automatic failures then one non-retryable failure', async () => {
    const harness = createSimulatorHarness('manual_retry');
    const task = await harness.createAndRun();
    await harness.clock.runAll();

    const failures = harness
      .events(task.id)
      .filter((event) => event.type === 'agent_attempt_failed');
    expect(failures).toHaveLength(3);
    const retryable = failures.filter(
      (event) => event.type === 'agent_attempt_failed' && event.retryable,
    );
    expect(retryable).toHaveLength(2);
    // Paused with no pending timers until the manual retry.
    expect(harness.clock.pendingTimers).toBe(0);
    const workspace = await harness.gateway.getWorkspace(task.id);
    expect(workspace.task.status).toBe('retryable_failure');
    const writerInputs = workspace.nodes.filter(
      (node) => node.kind === 'input' && node.agentId === WRITER_AGENT_ID,
    );
    expect(writerInputs).toHaveLength(1);

    await harness.gateway.retryTask(task.id);
    await harness.clock.runAll();
    const after = await harness.gateway.getWorkspace(task.id);
    expect(after.task.status).toBe('completed');
    // The manual retry reuses the original input node; attempts stay grouped.
    const afterInputs = after.nodes.filter(
      (node) => node.kind === 'input' && node.agentId === WRITER_AGENT_ID,
    );
    expect(afterInputs).toHaveLength(1);
    expect(after.artifacts.map((item) => item.version)).toEqual([1]);
  });

  it('human_input waits for the answer and the same agent continues', async () => {
    const harness = createSimulatorHarness('human_input');
    const task = await harness.createAndRun();
    await harness.clock.runAll();

    const waiting = await harness.gateway.getWorkspace(task.id);
    expect(waiting.task.status).toBe('waiting_human');
    expect(waiting.pendingHumanQuestion).toBe(templateFixture.sampleHumanQuestion);
    expect(harness.clock.pendingTimers).toBe(0);

    await harness.gateway.answerHuman(task.id, templateFixture.sampleHumanAnswer);
    const answered = await harness.gateway.getWorkspace(task.id);
    expect(answered.task.status).toBe('running');
    const answerNode = answered.nodes.find((node) => node.kind === 'human_answer');
    expect(answerNode?.agentId).toBe(WRITER_AGENT_ID);
    expect(answerNode?.body).toBe(templateFixture.sampleHumanAnswer);

    await harness.clock.runAll();
    const done = await harness.gateway.getWorkspace(task.id);
    expect(done.task.status).toBe('completed');
    // The writer (the asking agent) produced the result after the answer.
    const writerResult = done.nodes.find(
      (node) => node.kind === 'result' && node.agentId === WRITER_AGENT_ID,
    );
    expect(writerResult).toBeDefined();
    expect(done.artifacts.map((item) => item.version)).toEqual([1]);
  });

  it('refresh_recovery completes the remaining steps after bootstrap', async () => {
    const harness = createSimulatorHarness('refresh_recovery');
    const task = await harness.createAndRun();
    // input(500) + skill(500) + result(600) + artifact(500): V1 lands at exactly 2100ms.
    harness.clock.advance(2100);

    const mid = await harness.gateway.getWorkspace(task.id);
    expect(mid.task.status).toBe('running');
    expect(mid.artifacts.map((item) => item.version)).toEqual([1]);

    // The refreshed browser: same storage, a fresh clock starting "now", and
    // the gateway factory runs bootstrap() exactly once.
    const clock2 = createFixedClock(harness.clock.now());
    const gateway2 = createMockGateway(harness.storage, clock2);
    expect(clock2.pendingTimers).toBe(1);

    await clock2.runAll();
    const done = await gateway2.getWorkspace(task.id);
    expect(done.task.status).toBe('completed');
    expect(done.artifacts.map((item) => item.version)).toEqual([1, 2]);
    expect(done.artifacts[1].final).toBe(true);
    // Initial brief input plus the rework instruction: never more.
    const writerInputs = done.nodes.filter(
      (node) => node.kind === 'input' && node.agentId === WRITER_AGENT_ID,
    );
    expect(writerInputs).toHaveLength(2);
  });
});

describe('bootstrap, one-slot and generation guards', () => {
  function runningRecord(
    id: string,
    clock: { now(): number },
    run: { nextStepIndex: number; runGeneration: number },
  ): MockTaskRecord {
    const at = new Date(clock.now()).toISOString();
    const template = templateFixture.template;
    const nodeId = (index: number): string => `node-${id}-${index}`;
    const events: MockTaskRecord['events'] = [
      { type: 'task_started', at },
      {
        type: 'agent_input',
        at,
        node: {
          id: nodeId(0),
          sequence: 1,
          agentId: WRITER_AGENT_ID,
          kind: 'input',
          title: template.inputFields[0].label,
          body: templateFixture.sampleInput[template.inputFields[0].id],
          status: 'active',
          attemptCount: 1,
          inputVersion: null,
        },
      },
      {
        type: 'agent_result',
        at,
        node: {
          id: nodeId(1),
          sequence: 2,
          agentId: WRITER_AGENT_ID,
          kind: 'result',
          title: templateFixture.sampleArtifacts.v1.title,
          body: templateFixture.sampleArtifacts.v1.content,
          status: 'confirmed',
          attemptCount: 1,
          inputVersion: null,
        },
      },
    ];
    return {
      id,
      name: id,
      templateId: template.id,
      templateName: template.name,
      frozenInput: { ...templateFixture.sampleInput },
      frozenTemplate: structuredClone(template),
      events,
      run: {
        scenarioId: 'happy_path',
        nextStepIndex: run.nextStepIndex,
        nextDueAt: clock.now() + 500,
        runGeneration: run.runGeneration,
      },
      createdAt: at,
      updatedAt: at,
    };
  }

  it('is a no-op for empty storage', () => {
    const storage = new MemoryStorage();
    const clock = createFixedClock();
    const gateway = createMockGateway(storage, clock);
    expect(clock.pendingTimers).toBe(0);
    return expect(gateway.listTasks()).resolves.toEqual([]);
  });

  it('resumes one persisted running task from its last confirmed step', async () => {
    const storage = new MemoryStorage();
    const clock = createFixedClock();
    const store = new MockStore(storage, clock, { templates: [templateFixture.template] });
    store.ensureCatalog();
    store.createTaskRecord(runningRecord('task-resume-a', clock, { nextStepIndex: 2, runGeneration: 7 }));

    const eventsBefore = store.getTaskEntry('task-resume-a');
    const gateway = createMockGateway(storage, clock);
    // Bootstrap appends no lifecycle event: it only reschedules the next step.
    const eventsAfter = store.getTaskEntry('task-resume-a');
    if (!eventsBefore || eventsBefore.corrupt || !eventsAfter || eventsAfter.corrupt) {
      throw new Error('seeded record missing');
    }
    expect(eventsAfter.record.events).toEqual(eventsBefore.record.events);
    expect(clock.pendingTimers).toBe(1);

    await clock.runAll();
    const done = await gateway.getWorkspace('task-resume-a');
    expect(done.task.status).toBe('completed');
    expect(done.artifacts.map((item) => item.version)).toEqual([1]);
  });

  it('interrupts extra running tasks and keeps exactly one alive', async () => {
    const storage = new MemoryStorage();
    const clock = createFixedClock();
    const store = new MockStore(storage, clock, { templates: [templateFixture.template] });
    store.ensureCatalog();
    store.createTaskRecord(runningRecord('task-live', clock, { nextStepIndex: 2, runGeneration: 1 }));
    store.createTaskRecord(runningRecord('task-extra', clock, { nextStepIndex: 2, runGeneration: 1 }));

    const gateway = createMockGateway(storage, clock);
    expect(clock.pendingTimers).toBe(1);

    await clock.runAll();
    expect((await gateway.getWorkspace('task-live')).task.status).toBe('completed');
    const extra = await gateway.getWorkspace('task-extra');
    expect(extra.task.status).toBe('interrupted');
    const extraEvents = harnessEvents(store, 'task-extra');
    expect(extraEvents[extraEvents.length - 1]).toMatchObject({ type: 'task_interrupted' });
  });

  it('refuses to start a second running task with TASK_ALREADY_RUNNING', async () => {
    const harness = createSimulatorHarness('review_return_v2');
    const first = await harness.gateway.createTask({ ...validCreateRequest, name: 'first' });
    const second = await harness.gateway.createTask({ ...validCreateRequest, name: 'second' });

    await harness.gateway.startTask(first.id);
    await expect(harness.gateway.startTask(second.id)).rejects.toMatchObject({
      code: 'TASK_ALREADY_RUNNING',
    });

    await harness.gateway.stopTask(first.id);
    await harness.gateway.startTask(second.id);
    expect((await harness.gateway.getWorkspace(second.id)).task.status).toBe('running');
  });

  it('turns scheduled callbacks into no-ops after stop, then resumes on demand', async () => {
    const harness = createSimulatorHarness('review_return_v2');
    const task = await harness.createAndRun();
    harness.clock.advance(1100); // writer input + skill load, before the writer result
    expect(harness.clock.pendingTimers).toBe(1);

    await harness.gateway.stopTask(task.id);
    expect(harness.clock.pendingTimers).toBe(0);
    await harness.clock.runAll();

    const stopped = await harness.gateway.getWorkspace(task.id);
    expect(stopped.task.status).toBe('stopped');
    expect(stopped.artifacts).toHaveLength(0);
    // Nothing executed after the stop: no reviewer lane nodes at all.
    expect(
      stopped.nodes.some((node) => node.agentId === REVIEWER_AGENT_ID),
    ).toBe(false);

    await harness.gateway.resumeTask(task.id);
    await harness.clock.runAll();
    const done = await harness.gateway.getWorkspace(task.id);
    expect(done.task.status).toBe('completed');
    expect(done.artifacts.map((item) => item.version)).toEqual([1, 2]);
  });
});

describe('script validation', () => {
  const template = templateFixture.template;

  function scenarioWith(steps: MockScenarioDefinition['steps']): MockScenarioDefinition {
    return { id: 'happy_path', label: 'x', description: 'y', steps };
  }

  it('accepts a minimal valid script', () => {
    expect(
      validateMockScenario(
        scenarioWith([
          { kind: 'input', delayMs: 500, agentId: WRITER_AGENT_ID, title: 't', body: 'b' },
          { kind: 'result', delayMs: 500, agentId: WRITER_AGENT_ID, title: 't', body: 'b' },
          { kind: 'artifact', delayMs: 500, sourceNodeRef: `${WRITER_AGENT_ID}:result`, title: 't', contentFixture: 'v1' },
          { kind: 'final', delayMs: 500, inputVersion: 1 },
        ]),
        template,
      ),
    ).toEqual([]);
  });

  it('rejects unknown agent ids', () => {
    const errors = validateMockScenario(
      scenarioWith([
        { kind: 'input', delayMs: 500, agentId: 'ghost-agent', title: 't', body: 'b' },
      ]),
      template,
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('ghost-agent');
  });

  it('rejects node references that were never named by an earlier step', () => {
    const errors = validateMockScenario(
      scenarioWith([
        {
          kind: 'route',
          delayMs: 500,
          fromNodeRef: `${WRITER_AGENT_ID}:result`,
          toAgentId: REVIEWER_AGENT_ID,
          routeKind: 'artifact',
          label: 'l',
        },
      ]),
      template,
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects attempt numbers that do not follow the current count', () => {
    const errors = validateMockScenario(
      scenarioWith([
        { kind: 'input', delayMs: 500, agentId: WRITER_AGENT_ID, title: 't', body: 'b' },
        { kind: 'transient_failure', delayMs: 500, nodeRef: `${WRITER_AGENT_ID}:input`, attempt: 3 },
      ]),
      template,
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects final steps that accept an unpublished version', () => {
    const errors = validateMockScenario(
      scenarioWith([
        { kind: 'input', delayMs: 500, agentId: WRITER_AGENT_ID, title: 't', body: 'b' },
        { kind: 'result', delayMs: 500, agentId: WRITER_AGENT_ID, title: 't', body: 'b' },
        { kind: 'artifact', delayMs: 500, sourceNodeRef: `${WRITER_AGENT_ID}:result`, title: 't', contentFixture: 'v1' },
        { kind: 'final', delayMs: 500, inputVersion: 2 },
      ]),
      template,
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects routes whose target agent never receives an input step', () => {
    const errors = validateMockScenario(
      scenarioWith([
        { kind: 'input', delayMs: 500, agentId: WRITER_AGENT_ID, title: 't', body: 'b' },
        { kind: 'result', delayMs: 500, agentId: WRITER_AGENT_ID, title: 't', body: 'b' },
        {
          kind: 'route',
          delayMs: 500,
          fromNodeRef: `${WRITER_AGENT_ID}:result`,
          toAgentId: REVIEWER_AGENT_ID,
          routeKind: 'artifact',
          label: 'l',
        },
      ]),
      template,
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('refuses to start an invalid script without appending any event', async () => {
    const bogus = scenarioWith([
      { kind: 'input', delayMs: 500, agentId: 'ghost-agent', title: 't', body: 'b' },
    ]);
    const harness = createSimulatorHarness('happy_path', { scenarios: [bogus] });
    const task = await harness.gateway.createTask(validCreateRequest);
    await expect(harness.gateway.startTask(task.id)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(harness.events(task.id)).toEqual([]);
    expect((await harness.gateway.getWorkspace(task.id)).task.status).toBe('ready');
  });
});

function harnessEvents(store: MockStore, taskId: string): MockTaskRecord['events'] {
  const entry = store.getTaskEntry(taskId);
  if (!entry || entry.corrupt) throw new Error(`missing task ${taskId}`);
  return entry.record.events;
}

describe('skill steps and turn traces (plan Task E4 Step 1)', () => {
  it('plays the writer skill step before the first result with a hash-prefixed body', async () => {
    const harness = createSimulatorHarness('happy_path');
    const task = await harness.createAndRun();
    await harness.clock.runAll();

    const workspace = await harness.gateway.getWorkspace(task.id);
    const skill = workspace.nodes.find((node) => node.kind === 'skill');
    expect(skill).toEqual({
      id: `node-${task.id}-1`,
      sequence: 2,
      agentId: WRITER_AGENT_ID,
      kind: 'skill',
      title: SKILL_CHAPTER_WRITING_ID,
      body: MOCK_SKILLS[SKILL_CHAPTER_WRITING_ID].versionHash.slice(0, 12),
      status: 'confirmed',
      attemptCount: 1,
      inputVersion: null,
      turnId: null, // loaded before the writer's first result
    });
    const writerResult = workspace.nodes.find(
      (node) => node.kind === 'result' && node.agentId === WRITER_AGENT_ID,
    );
    expect(writerResult?.turnId).toBe(`turn-${task.id}-2`);
    expect(harness.events(task.id).some((event) => event.type === 'skill_loaded')).toBe(true);
  });

  it('records the public text for the result turn and never the thinking block', async () => {
    const harness = createSimulatorHarness('happy_path');
    const task = await harness.createAndRun();
    await harness.clock.runAll();

    const trace = await harness.gateway.getTurnTrace(task.id, `turn-${task.id}-2`);
    expect(trace).toEqual({
      turnId: `turn-${task.id}-2`,
      // Shipped scripts declare the display-only final phase; the engine passes
      // it through untouched (plan 2026-08-04 Task 6). The scripted thinking
      // block is never durable (semantic audit P0, plan 2026-08-07).
      phase: {
        state: 'dispatched',
        dispatchAction: 'publish_artifact',
        target: '章节审核',
        message: null,
      },
      entries: [
        { kind: 'text', text: templateFixture.sampleArtifacts.v1.content },
      ],
    });

    // The reviewer result declares no thinking entries: its trace is text only.
    const workspace = await harness.gateway.getWorkspace(task.id);
    const reviewerResult = workspace.nodes.find(
      (node) => node.kind === 'result' && node.agentId === REVIEWER_AGENT_ID,
    );
    expect(reviewerResult?.turnId).toBe(`turn-${task.id}-6`);
    const reviewerTrace = await harness.gateway.getTurnTrace(
      task.id,
      reviewerResult?.turnId ?? '',
    );
    expect(reviewerTrace.entries).toEqual([
      { kind: 'text', text: templateFixture.sampleApprovalNote },
    ]);
    // The final approval submits the final artifact without a target agent.
    expect(reviewerTrace.phase).toEqual({
      state: 'dispatched',
      dispatchAction: 'submit_final_artifact',
      target: null,
      message: null,
    });
  });

  it('keeps traces phase-less when the scenario declares no phase', async () => {
    const phaseless: MockScenarioDefinition = {
      id: 'happy_path',
      label: 'x',
      description: 'y',
      steps: [
        { kind: 'input', delayMs: 500, agentId: WRITER_AGENT_ID, title: 't', body: 'b' },
        { kind: 'result', delayMs: 500, agentId: WRITER_AGENT_ID, title: 't', body: 'b' },
      ],
    };
    const harness = createSimulatorHarness('happy_path', { scenarios: [phaseless] });
    const task = await harness.createAndRun();
    await harness.clock.runAll();

    const trace = await harness.gateway.getTurnTrace(task.id, `turn-${task.id}-1`);
    expect(trace).toEqual({
      turnId: `turn-${task.id}-1`,
      entries: [{ kind: 'text', text: 'b' }],
    });
    expect(trace.phase).toBeUndefined();
  });

  it('attributes a skill loaded after a result to that result turn', async () => {
    const lateSkill: MockScenarioDefinition = {
      id: 'happy_path',
      label: 'x',
      description: 'y',
      steps: [
        { kind: 'input', delayMs: 500, agentId: WRITER_AGENT_ID, title: 't', body: 'b' },
        { kind: 'result', delayMs: 500, agentId: WRITER_AGENT_ID, title: 't', body: 'b' },
        {
          kind: 'skill',
          delayMs: 500,
          agentId: WRITER_AGENT_ID,
          skillId: SKILL_CHAPTER_WRITING_ID,
          versionHash: MOCK_SKILLS[SKILL_CHAPTER_WRITING_ID].versionHash,
        },
      ],
    };
    const harness = createSimulatorHarness('happy_path', { scenarios: [lateSkill] });
    const task = await harness.createAndRun();
    await harness.clock.runAll();

    const workspace = await harness.gateway.getWorkspace(task.id);
    const skill = workspace.nodes.find((node) => node.kind === 'skill');
    expect(skill?.turnId).toBe(`turn-${task.id}-1`);
    expect(skill?.sequence).toBe(3);
  });

  it('revalidates all six shipped scripts with their skill steps', () => {
    for (const id of MOCK_SCENARIO_IDS) {
      expect(validateMockScenario(MOCK_SCENARIOS[id], templateFixture.template)).toEqual([]);
    }
    expect(MOCK_SCENARIOS.happy_path.steps.some((step) => step.kind === 'skill')).toBe(true);
    expect(MOCK_SCENARIOS.review_return_v2.steps.some((step) => step.kind === 'skill')).toBe(true);
    expect(MOCK_SCENARIOS.refresh_recovery.steps.some((step) => step.kind === 'skill')).toBe(true);
  });

  it('rejects skill steps naming unknown agents with the id in the message', () => {
    const errors = validateMockScenario(
      {
        id: 'happy_path',
        label: 'x',
        description: 'y',
        steps: [
          { kind: 'input', delayMs: 500, agentId: WRITER_AGENT_ID, title: 't', body: 'b' },
          {
            kind: 'skill',
            delayMs: 500,
            agentId: 'ghost-agent',
            skillId: 'skill-ghost',
            versionHash: 'f'.repeat(64),
          },
        ],
      },
      templateFixture.template,
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('ghost-agent');
  });
});

describe('live streaming preview while running (plan C realtime streaming)', () => {
  it('exposes activeTurn only inside a result window, growing with the clock', async () => {
    const harness = createSimulatorHarness('happy_path');
    const task = await harness.createAndRun();

    // Before any result step is pending there is no live turn.
    expect((await harness.gateway.getWorkspace(task.id)).activeTurn ?? null).toBeNull();

    // Fire the input step (500ms) and the skill step (500ms): the pending
    // step becomes the writer's result turn (600ms window).
    harness.clock.advance(500);
    harness.clock.advance(500);
    const first = await harness.gateway.getWorkspace(task.id);
    expect(first.activeTurn).not.toBeNull();
    expect(first.activeTurn?.agentId).toBe(WRITER_AGENT_ID);
    expect(first.activeTurn?.turnId).toBe(turnIdFor(task.id, 2));
    expect(first.activeTurn?.status).toBe('running');
    expect(first.activeTurn?.text).toBe('');

    // Halfway through the window, roughly half the body has streamed in.
    harness.clock.advance(300);
    const midway = await harness.gateway.getWorkspace(task.id);
    const resultStep = MOCK_SCENARIOS.happy_path.steps[2];
    if (resultStep.kind !== 'result') throw new Error('expected the result step');
    expect(midway.activeTurn?.text.length).toBe(Math.ceil(resultStep.body.length * 0.5));
    expect(resultStep.body.startsWith(midway.activeTurn?.text ?? '')).toBe(true);

    // The window closes when the result fires; the preview disappears.
    harness.clock.advance(300);
    expect((await harness.gateway.getWorkspace(task.id)).activeTurn ?? null).toBeNull();
  });

  it('never shows activeTurn once the run completes', async () => {
    const harness = createSimulatorHarness('happy_path');
    const task = await harness.createAndRun();
    harness.clock.runAll();
    const workspace = await harness.gateway.getWorkspace(task.id);
    expect(workspace.task.status).toBe('completed');
    expect(workspace.activeTurn ?? null).toBeNull();
  });

  it('never shows activeTurn before the task starts', async () => {
    const harness = createSimulatorHarness('happy_path');
    const task = await harness.gateway.createTask(validCreateRequest);
    expect((await harness.gateway.getWorkspace(task.id)).activeTurn ?? null).toBeNull();
  });
});
