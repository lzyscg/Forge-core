// @vitest-environment node
/**
 * TaskScheduler tests (plan Phase C Task 4 Steps 1/4, spec §3.3/§7).
 *
 * The scheduler owns the process-wide single slot: one running task at a
 * time, and inside it one agent Turn at a time (the runner never recurses).
 * `start` claims the slot synchronously, validates status, appends
 * `task_started` and loops `runNext` until the task waits for a human,
 * completes, fails an attempt, is stopped or runs out of confirmed inputs;
 * a second start receives the public TASK_ALREADY_RUNNING conflict without
 * queueing. `stop` aborts the in-flight Turn, waits disposal and appends
 * `task_stopped`; stale late results commit nothing. `resume`/`retry`/
 * `answer` validate status first and reuse the same loop. Task 5 completes
 * the lifecycle policy: bounded automatic retry of transient failures (two
 * automatic retries with recorded delays, then `retryable_failure` awaiting
 * manual retry), stop-time stale-result suppression, human-answer
 * continuation to the final gate and restart recovery
 * (`recoverInterruptedTasks` + explicit `resume` over a fresh scheduler
 * instance). `shutdown` interrupts the active task, disposes the runtime and
 * releases the slot.
 *
 * Neutral identities only (iron rule 1); fixture agent ids appear exclusively
 * in test data.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeFailure } from './agent-runtime';
import { FakeAgentRuntime, type FakeScriptStep } from './fake-agent-runtime';
import {
  createDeferred,
  createSchedulerEnvironment,
  disposeRuntimeTestRoots,
  DeferredAgentRuntime,
  publishFixtureArtifact,
  RecordingRuntime,
  schedulerWithDeferredRuntime,
  schedulerWithFailures,
  seedAgentInputVersion,
  type SchedulerEnvironment,
} from './test-support';
import { downgradeTaskSnapshotToLegacy, makeEventNode, makeTaskEvent } from '../test-support';
import { PROGRESS_GUARD_QUESTION } from './progress-guard';
import type { ArtifactStore } from '../storage/artifact-store';
import { TraceStore } from '../storage/trace-store';
import { ActionCommitter } from './action-committer';
import { SkillService } from './skill-service';
import { TaskRunner } from './task-runner';
import { TaskScheduler } from './task-scheduler';
import { WorkspaceStore } from './workspace-store';

afterEach(() => {
  disposeRuntimeTestRoots();
});

interface SchedulerHarness {
  environment: SchedulerEnvironment;
  scheduler: TaskScheduler;
  fake: FakeAgentRuntime;
  recording: RecordingRuntime;
  taskId: string;
}

async function schedulerHarness(
  scripts: Record<string, readonly FakeScriptStep[]>,
  options: { seedWriterInput?: boolean } = {},
): Promise<SchedulerHarness> {
  const fake = new FakeAgentRuntime({ scripts });
  const recording = new RecordingRuntime(fake);
  const environment = await createSchedulerEnvironment({ runtime: recording });
  const taskId = await environment.createTask();
  if (options.seedWriterInput !== false) {
    await environment.seedAgentInput(taskId, 'writer', '开始生产');
  }
  return { environment, scheduler: environment.service.scheduler, fake, recording, taskId };
}

/** One legal writer turn: seal an inline package, then the publish dispatch. */
const publishTurnActions = (title: string) => [
  {
    type: 'finish_production' as const,
    source: 'inline' as const,
    files: [{ name: 'content.md', content: `${title} 正文` }],
    format: 'markdown' as const,
    artifactType: '终稿',
    title,
  },
  { type: 'publish_artifact' as const },
];

/** One legal reviewer turn: send a short message back to the writer. */
const reviewMessageTurnActions = (review: string) => [
  {
    type: 'send_message' as const,
    targetAgentId: 'writer',
    summary: review,
  },
];

/** Legal final reviewer turn over a received artifact: submit the input version. */
const submitReceivedArtifactTurnActions = [{ type: 'submit_final_artifact' as const }];

/** A direct human interrupt: the one action that needs no sealed package. */
const humanInterruptTurnActions = [{ type: 'request_human_input' as const, question: '是否继续？' }];

describe('TaskScheduler one-slot concurrency (plan Task 4 Step 1 verbatim)', () => {
  it('never overlaps Agent Turns even when two tasks are started together', async () => {
    const scheduler = await schedulerWithDeferredRuntime();
    const first = scheduler.start(scheduler.taskA);
    await expect(scheduler.start(scheduler.taskB)).rejects.toMatchObject({ code: 'TASK_ALREADY_RUNNING' });
    await scheduler.runtime.waitForPendingTurn();
    expect(scheduler.runtime.maximumConcurrency).toBe(1);
    scheduler.runtime.resolveNext();
    await first;
  });
});

describe('TaskScheduler serial loop', () => {
  it('runs every committed Turn serially to completion under one start', async () => {
    const harness = await schedulerHarness({
      writer: [
        { kind: 'result', publicText: '初稿 V1', actions: publishTurnActions('初稿 V1') },
        { kind: 'result', publicText: '初稿 V2', actions: publishTurnActions('初稿 V2') },
      ],
      reviewer: [
        { kind: 'result', publicText: '退回意见', actions: reviewMessageTurnActions('请修改') },
        { kind: 'result', publicText: '终稿提交', actions: submitReceivedArtifactTurnActions },
      ],
    });

    const summary = await harness.scheduler.start(harness.taskId);
    expect(summary.status).toBe('completed');

    const workspace = await harness.environment.service.getWorkspace(harness.taskId);
    expect(workspace.task.status).toBe('completed');
    // V1 and V2 are published; the final submission resolves through the
    // RECEIVED V2 package, so no third version is ever published.
    expect(workspace.artifacts.map((artifact) => artifact.version)).toEqual([1, 2]);
    expect(workspace.artifacts.at(-1)?.final).toBe(true);
    // Four Turns across two agents, never overlapping.
    expect(harness.recording.maximumConcurrency).toBe(1);
    expect(harness.recording.turnInputs.map((input) => input.agent.id)).toEqual([
      'writer',
      'reviewer',
      'writer',
      'reviewer',
    ]);
    // The execution order projected on the canvas matches the real order.
    const sequences = workspace.nodes.map((node) => node.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  }, 20_000);

  it('appends task_started before running and resolves with the final summary', async () => {
    const harness = await schedulerHarness({
      writer: [{ kind: 'result', publicText: '完成', actions: humanInterruptTurnActions }],
    });
    const summary = await harness.scheduler.start(harness.taskId);
    expect(summary.status).toBe('waiting_human');
    const committed = await harness.environment.events.read(harness.taskId);
    const types = committed.map((entry) => entry.event.type);
    // task_started precedes every produced result (seeded input comes first).
    expect(types).toContain('task_started');
    expect(types.indexOf('agent_result')).toBeGreaterThan(types.indexOf('task_started'));
  });

  it('stops the loop when an attempt fails and reports the retry flag', async () => {
    const harness = await schedulerHarness({
      writer: [
        { kind: 'failure', failure: RuntimeFailure.permanent('PROVIDER_ERROR', 'provider rejected') },
      ],
    });
    const summary = await harness.scheduler.start(harness.taskId);
    expect(summary.status).toBe('retryable_failure');
    // No auto retry in Task 4: exactly one recorded attempt.
    expect(harness.fake.countInvocations('writer')).toBe(1);
  });

  it('stops the loop while waiting for a human answer', async () => {
    const harness = await schedulerHarness({
      writer: [
        {
          kind: 'result',
          publicText: '需要确认',
          actions: [{ type: 'request_human_input', question: '是否继续？' }],
        },
      ],
    });
    const summary = await harness.scheduler.start(harness.taskId);
    expect(summary.status).toBe('waiting_human');
    expect(harness.fake.countInvocations('writer')).toBe(1);
  });
});

describe('TaskScheduler status validation', () => {
  it('rejects unknown tasks with TASK_NOT_FOUND', async () => {
    const harness = await schedulerHarness({});
    await expect(harness.scheduler.start('task-missing')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });

  it('rejects corrupt tasks with the public TASK_CORRUPTED code', async () => {
    const harness = await schedulerHarness({});
    writeFileSync(
      join(harness.environment.paths.taskRoot(harness.taskId), 'task.json'),
      '{corrupted',
    );
    await expect(harness.scheduler.start(harness.taskId)).rejects.toMatchObject({
      code: 'TASK_CORRUPTED',
    });
  });

  it('rejects starting a completed task with INVALID_TRANSITION', async () => {
    const harness = await schedulerHarness({
      writer: [{ kind: 'result', publicText: '初稿 V1', actions: publishTurnActions('终稿 V1') }],
      reviewer: [
        { kind: 'result', publicText: '终稿提交', actions: submitReceivedArtifactTurnActions },
      ],
    });
    await harness.scheduler.start(harness.taskId);
    await expect(harness.scheduler.start(harness.taskId)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });

  it('rejects starting a running task with TASK_ALREADY_RUNNING', async () => {
    // The scripted Turn gates on a deferred, so the single slot stays busy
    // while the second start probes it — the deterministic conflict path.
    const deferred = createDeferred<void>();
    const harness = await schedulerHarness({
      writer: [
        { kind: 'result', publicText: '完成', actions: humanInterruptTurnActions, deferred },
      ],
    });
    const first = harness.scheduler.start(harness.taskId); // claims the slot
    await expect(harness.scheduler.start(harness.taskId)).rejects.toMatchObject({
      code: 'TASK_ALREADY_RUNNING',
    });
    deferred.resolve();
    await first;
  });

  it('rejects invalid lifecycle transitions per status', async () => {
    // No seeded input: the task projects `ready` until it is started.
    const harness = await schedulerHarness(
      { writer: [{ kind: 'result', publicText: '完成', actions: humanInterruptTurnActions }] },
      { seedWriterInput: false },
    );
    // Ready task: nothing to stop/resume/retry/answer yet.
    await expect(harness.scheduler.stop(harness.taskId)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await expect(harness.scheduler.resume(harness.taskId)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await expect(harness.scheduler.retry(harness.taskId)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await expect(harness.scheduler.answer(harness.taskId, '回答')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });

    await harness.scheduler.start(harness.taskId); // -> waiting_human
    await expect(harness.scheduler.resume(harness.taskId)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await expect(harness.scheduler.retry(harness.taskId)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });

    await harness.scheduler.stop(harness.taskId); // -> stopped
    await expect(harness.scheduler.retry(harness.taskId)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await expect(harness.scheduler.answer(harness.taskId, '回答')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });
});

describe('TaskScheduler stop and stale suppression', () => {
  it('aborts the in-flight Turn, waits disposal and appends task_stopped', async () => {
    const scheduler = await schedulerWithDeferredRuntime();
    const first = scheduler.start(scheduler.taskA);
    await scheduler.runtime.waitForPendingTurn();

    const summary = await scheduler.stop(scheduler.taskA);
    expect(summary.status).toBe('stopped');
    await first; // the aborted loop unwinds without rejecting

    const committed = await scheduler.environment.events.read(scheduler.taskA);
    expect(committed.map((entry) => entry.event.type)).toContain('task_stopped');
    expect(committed.some((entry) => entry.event.type === 'agent_result')).toBe(false);
    expect(scheduler.runtime.isDisposed(scheduler.taskA, 'writer')).toBe(true);
    expect((await scheduler.environment.service.getWorkspace(scheduler.taskA)).task.status).toBe(
      'stopped',
    );
  });

  it('ignores stale late resolutions after a stop', async () => {
    const scheduler = await schedulerWithDeferredRuntime();
    const first = scheduler.start(scheduler.taskA);
    await scheduler.runtime.waitForPendingTurn();
    await scheduler.stop(scheduler.taskA);
    await first;

    // The aborted Turn left no waiter; releasing nothing commits nothing.
    expect(scheduler.runtime.resolveNext()).toBe(false);
    const committed = await scheduler.environment.events.read(scheduler.taskA);
    expect(committed.some((entry) => entry.event.type === 'agent_result')).toBe(false);
    const types = committed.map((entry) => entry.event.type);
    expect(types[types.length - 1]).toBe('task_stopped');
  });
});

describe('TaskScheduler resume, retry and answer', () => {
  it('resume continues a stopped task and refuses a running one', async () => {
    const harness = await schedulerHarness({
      writer: [{ kind: 'result', publicText: '完成', actions: humanInterruptTurnActions }],
    });
    await harness.scheduler.start(harness.taskId); // waiting_human
    await harness.scheduler.stop(harness.taskId);

    const resumed = await harness.scheduler.resume(harness.taskId);
    // The turn committed a human request before the stop; resuming over an
    // unanswered question returns the task to waiting_human (never running —
    // the loop never executes a Turn while a question is pending), so the
    // request stays answerable (plan 2026-08-06).
    expect(resumed.status).toBe('waiting_human');
    const committed = await harness.environment.events.read(harness.taskId);
    expect(committed.map((entry) => entry.event.type)).toContain('task_resumed');
    await expect(harness.scheduler.resume(harness.taskId)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });

  it('retry re-runs the failed node only from retryable_failure', async () => {
    const harness = await schedulerHarness({
      writer: [
        { kind: 'failure', failure: RuntimeFailure.permanent('PROVIDER_ERROR', 'provider rejected') },
        { kind: 'result', publicText: '重试成功', actions: humanInterruptTurnActions },
      ],
    });
    const failed = await harness.scheduler.start(harness.taskId);
    expect(failed.status).toBe('retryable_failure');

    const retried = await harness.scheduler.retry(harness.taskId);
    expect(retried.status).toBe('waiting_human');
    expect(harness.fake.countInvocations('writer')).toBe(2);

    const committed = await harness.environment.events.read(harness.taskId);
    const result = committed.find((entry) => entry.event.type === 'agent_result');
    expect(result).toBeDefined();
  });

  it('answer appends the human answer and continues the requesting agent', async () => {
    const harness = await schedulerHarness({
      writer: [
        { kind: 'result', publicText: '需要确认', actions: humanInterruptTurnActions },
        { kind: 'result', publicText: '继续完成', actions: humanInterruptTurnActions },
      ],
    });
    const waiting = await harness.scheduler.start(harness.taskId);
    expect(waiting.status).toBe('waiting_human');

    const answered = await harness.scheduler.answer(harness.taskId, '同意继续');
    expect(answered.status).toBe('waiting_human');
    expect(harness.fake.countInvocations('writer')).toBe(2);

    const workspace = await harness.environment.service.getWorkspace(harness.taskId);
    expect(workspace.pendingHumanQuestion).toBe('是否继续？');
    const types = (await harness.environment.events.read(harness.taskId)).map(
      (entry) => entry.event.type,
    );
    expect(types).toContain('human_answered');
    // The answer formed a new confirmed input for the requesting agent.
    const inputs = (await harness.environment.events.read(harness.taskId)).filter(
      (entry) => entry.event.type === 'agent_input',
    );
    expect(inputs).toHaveLength(2);
    const lastInput = inputs[inputs.length - 1]?.event;
    if (lastInput?.type === 'agent_input') {
      expect(lastInput.node.agentId).toBe('writer');
      expect(lastInput.node.body).toBe('同意继续');
    }
  });
});

describe('TaskScheduler recovery and shutdown', () => {
  it('marks nonterminal tasks without terminal events interrupted', async () => {
    const harness = await schedulerHarness({}, { seedWriterInput: false });
    const active = await harness.environment.createTask();
    await harness.environment.events.append(
      active,
      makeTaskEvent({ type: 'task_started' }),
    );
    await harness.environment.seedAgentInput(active, 'writer', '中断前输入');

    const terminal = await harness.environment.createTask();
    await harness.environment.events.append(terminal, makeTaskEvent({ type: 'task_started' }));
    await harness.environment.events.append(terminal, makeTaskEvent({ type: 'task_stopped' }));

    const ready = await harness.environment.createTask();

    const interrupted = await harness.scheduler.recoverInterruptedTasks();
    expect(interrupted).toEqual([active]);

    expect((await harness.environment.service.getWorkspace(active)).task.status).toBe('interrupted');
    expect((await harness.environment.service.getWorkspace(terminal)).task.status).toBe('stopped');
    expect((await harness.environment.service.getWorkspace(ready)).task.status).toBe('ready');
    expect(harness.taskId).not.toEqual(active);
  });

  it('skips corrupt tasks during recovery', async () => {
    const harness = await schedulerHarness({}, { seedWriterInput: false });
    const corrupt = await harness.environment.createTask();
    await harness.environment.events.append(corrupt, makeTaskEvent({ type: 'task_started' }));
    writeFileSync(join(harness.environment.paths.taskRoot(corrupt), 'task.json'), '{corrupted');

    const interrupted = await harness.scheduler.recoverInterruptedTasks();
    expect(interrupted).toEqual([]);
    const summaries = await harness.environment.service.listTasks();
    expect(summaries.find((summary) => summary.id === corrupt)?.status).toBe('corrupt');
  });

  it('shutdown interrupts the active task, disposes the runtime and frees the slot', async () => {
    const scheduler = await schedulerWithDeferredRuntime();
    const first = scheduler.start(scheduler.taskA);
    await scheduler.runtime.waitForPendingTurn();

    await scheduler.shutdown();
    await first;

    const committed = await scheduler.environment.events.read(scheduler.taskA);
    expect(committed.map((entry) => entry.event.type)).toContain('task_interrupted');
    expect((await scheduler.environment.service.getWorkspace(scheduler.taskA)).task.status).toBe(
      'interrupted',
    );
    expect(scheduler.runtime.disposedAll).toBe(true);
  });

  it('shutdown on an idle scheduler only disposes the runtime', async () => {
    const scheduler = await schedulerWithDeferredRuntime();
    await scheduler.shutdown();
    expect(scheduler.runtime.disposedAll).toBe(true);
  });
});

describe('TaskScheduler automatic retry policy (plan Task 5 Step 1 verbatim)', () => {
  it('automatically retries transient errors twice then waits for manual retry', async () => {
    const { scheduler, taskId, projector, attemptEvents } = await schedulerWithFailures([
      'ETIMEDOUT',
      'HTTP_503',
      'ETIMEDOUT',
      'success',
    ]);
    await scheduler.start(taskId);
    expect((await projector.workspace(taskId)).task.status).toBe('retryable_failure');
    expect(await attemptEvents(taskId)).toHaveLength(3);
    await scheduler.retry(taskId);
    expect((await projector.workspace(taskId)).task.status).toBe('completed');
    // Manual retry reaches the system final gate, not just a result node.
    expect((await projector.workspace(taskId)).artifacts.at(-1)?.final).toBe(true);
  });

  it('records every automatic retry delay as a retry_scheduled event', async () => {
    const harness = await schedulerWithFailures(['ETIMEDOUT', 'HTTP_503', 'ETIMEDOUT', 'success']);
    await harness.scheduler.start(harness.taskId);

    const scheduled = await harness.retryScheduledEvents(harness.taskId);
    // Deterministic injected clock: jitter pinned to zero, 1 s then 2 s.
    expect(scheduled.map((event) => event.delayMs)).toEqual([1000, 2000]);
    expect(harness.recordedDelays).toEqual([1000, 2000]);
    expect(scheduled.map((event) => event.attempt)).toEqual([2, 3]);

    // Canvas folding: every attempt belongs to the same input node.
    const attempts = await harness.attemptEvents(harness.taskId);
    expect(new Set(attempts.map((event) => event.nodeId)).size).toBe(1);
    expect(scheduled.every((event) => event.nodeId === attempts[0]?.nodeId)).toBe(true);
  });

  it('never auto-retries permanent failures', async () => {
    const harness = await schedulerWithFailures(['MODEL_NOT_FOUND', 'success']);
    const summary = await harness.scheduler.start(harness.taskId);
    expect(summary.status).toBe('retryable_failure');
    expect(await harness.attemptEvents(harness.taskId)).toHaveLength(1);
    expect(harness.recordedDelays).toEqual([]);
    expect(await harness.retryScheduledEvents(harness.taskId)).toEqual([]);

    await harness.scheduler.retry(harness.taskId);
    expect((await harness.projector.workspace(harness.taskId)).task.status).toBe('completed');
  });

  it('refuses manual retry outside retryable_failure', async () => {
    const harness = await schedulerWithFailures(['success']);
    await harness.scheduler.start(harness.taskId);
    await expect(harness.scheduler.retry(harness.taskId)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });
});

describe('TaskScheduler stop stale-result suppression (plan Task 5 Step 5)', () => {
  it('commits nothing when a Turn resolves only after stop', async () => {
    // The runtime ignores aborts: the scripted result arrives strictly after
    // the stop bumped the generation, so the commit path must stay sealed.
    const runtime = new DeferredAgentRuntime({ ignoreAbort: true });
    const environment = await createSchedulerEnvironment({ runtime });
    const taskId = await environment.createTask();
    await environment.seedAgentInput(taskId, 'writer', 'neutral opening input');
    const scheduler = environment.service.scheduler;

    const first = scheduler.start(taskId);
    await runtime.waitForPendingTurn();
    const stopPromise = scheduler.stop(taskId); // aborts synchronously on entry
    runtime.resolveNext(); // the Turn result lands AFTER the abort
    await stopPromise;
    await first;

    const committed = await environment.events.read(taskId);
    expect(committed.some((entry) => entry.event.type === 'agent_result')).toBe(false);
    const types = committed.map((entry) => entry.event.type);
    expect(types).toContain('task_stopped');
    expect(types[types.length - 1]).toBe('task_stopped');

    // Let any stale continuation settle: zero new events afterwards.
    await new Promise((wait) => setTimeout(wait, 20));
    expect((await environment.events.read(taskId)).length).toBe(committed.length);
  });
});

describe('TaskScheduler human answer continuation (plan Task 5 Step 4)', () => {
  it('answer re-acquires the slot and runs the requesting agent to completion', async () => {
    const fake = new FakeAgentRuntime({
      scripts: {
        writer: [
          {
            kind: 'result',
            publicText: '需要确认',
            actions: [{ type: 'request_human_input', question: '是否提交终稿？' }],
          },
          { kind: 'result', publicText: '初稿完成', actions: publishTurnActions('终稿 V1') },
        ],
        reviewer: [
          { kind: 'result', publicText: '终稿提交', actions: submitReceivedArtifactTurnActions },
        ],
      },
    });
    const environment = await createSchedulerEnvironment({ runtime: fake });
    const taskId = await environment.createTask();
    await environment.seedAgentInput(taskId, 'writer', 'neutral opening input');
    const scheduler = environment.service.scheduler;

    const waiting = await scheduler.start(taskId);
    expect(waiting.status).toBe('waiting_human');

    const answered = await scheduler.answer(taskId, '同意提交');
    expect(answered.status).toBe('completed');
    const workspace = await environment.service.getWorkspace(taskId);
    expect(workspace.artifacts.at(-1)?.final).toBe(true);
    expect(fake.countInvocations('writer')).toBe(2);
    expect(fake.countInvocations('reviewer')).toBe(1);
  });
});

describe('TaskScheduler process recovery (plan Task 5 Step 1 verbatim)', () => {
  it('marks a running task interrupted after restart and resumes explicitly', async () => {
    const harness = await schedulerWithFailures(['success']);
    const taskId = harness.taskId;
    await harness.seedRunningTaskWithoutTerminalEvent(taskId);
    // A fresh scheduler instance over the same roots simulates the restart.
    const restartedScheduler = await harness.restart();

    await restartedScheduler.recoverInterruptedTasks();
    expect((await harness.projector.workspace(taskId)).task.status).toBe('interrupted');

    await restartedScheduler.resume(taskId);
    expect((await harness.projector.workspace(taskId)).task.status).toBe('completed');
  });

  it('leaves never-started tasks untouched across restarts', async () => {
    const harness = await schedulerWithFailures(['success']);
    // The harness task carries a confirmed input node but no lifecycle event:
    // nothing was in flight, so recovery must not mark it interrupted.
    const restartedScheduler = await harness.restart();
    const interrupted = await restartedScheduler.recoverInterruptedTasks();
    expect(interrupted).toEqual([]);
    expect((await harness.projector.workspace(harness.taskId)).task.status).toBe('running');

    const started = await restartedScheduler.start(harness.taskId);
    expect(started.status).toBe('completed');
  });

  it('resume rebuilds only confirmed history after an interrupted mid-Turn crash', async () => {
    const harness = await schedulerWithFailures(['success']);
    const taskId = harness.taskId;
    await harness.seedRunningTaskWithoutTerminalEvent(taskId);
    const restartedScheduler = await harness.restart();
    await restartedScheduler.recoverInterruptedTasks();

    await restartedScheduler.resume(taskId);
    const committed = await harness.environment.events.read(taskId);
    // Exactly one result for the recovery input: nothing guessed, duplicated
    // or replayed from the unconfirmed pre-crash attempt.
    const results = committed.filter((entry) => entry.event.type === 'agent_result');
    expect(results).toHaveLength(1);
    expect(committed.map((entry) => entry.event.type)).toContain('task_resumed');
  });
});

describe('TaskScheduler initial input seeding (plan Phase C Task 6)', () => {
  // A fresh task carries no confirmed input node; without seeding, `start`
  // would quiesce immediately and no Agent could ever run (the child-process
  // recovery gate starts tasks exclusively through the public HTTP routes).
  // Seeding commits exactly one initial input for the first declared agent,
  // rendered from the frozen task input — config-driven, zero business
  // branching (iron rule 1).

  async function environmentWithNeutralRuntime(): Promise<{
    environment: SchedulerEnvironment;
    scheduler: TaskScheduler;
  }> {
    // The seeded Turn performs a direct human interrupt: one legal contract
    // action that commits a result without routing anywhere, so the seeding
    // assertions stay focused on the initial input itself.
    const runtime = new FakeAgentRuntime({
      scripts: {
        writer: [{ kind: 'result', publicText: '需要确认', actions: humanInterruptTurnActions }],
      },
    });
    const environment = await createSchedulerEnvironment({ runtime });
    return { environment, scheduler: environment.service.scheduler };
  }

  function inputsOf(
    committed: Awaited<ReturnType<SchedulerEnvironment['events']['read']>>,
  ): Extract<(typeof committed)[number]['event'], { type: 'agent_input' }>[] {
    return committed
      .map((entry) => entry.event)
      .filter((event): event is Extract<typeof event, { type: 'agent_input' }> =>
        event.type === 'agent_input',
      );
  }

  it('seeds exactly one initial input for the first declared agent on start', async () => {
    const { environment, scheduler } = await environmentWithNeutralRuntime();
    const taskId = await environment.createTask();

    const summary = await scheduler.start(taskId);
    expect(summary.status).toBe('waiting_human');

    const committed = await environment.events.read(taskId);
    const inputs = inputsOf(committed);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].node.agentId).toBe(environment.frozen.agents[0].id);
    expect(inputs[0].node.kind).toBe('input');
    // Rendered from the frozen input field labels (the fixture declares one
    // required field; optional empty fields never appear).
    expect(inputs[0].node.body).toContain('neutral fixture input');
    expect(inputs[0].node.sequence).toBe(1);
    // The scripted runtime consumed exactly one seeded Turn.
    expect(
      committed.filter((entry) => entry.event.type === 'agent_result'),
    ).toHaveLength(1);
  });

  it('never re-seeds when the task already carries a confirmed input', async () => {
    const { environment, scheduler } = await environmentWithNeutralRuntime();
    const taskId = await environment.createTask();
    const seededId = await environment.seedAgentInput(
      taskId,
      environment.frozen.agents[0].id,
      'pre-existing confirmed input',
    );

    await scheduler.start(taskId);
    const inputs = inputsOf(await environment.events.read(taskId));
    expect(inputs).toHaveLength(1);
    expect(inputs[0].id).toBe(seededId);
  });

  it('seeds the missing initial input on resume after an input-less crash', async () => {
    const { environment, scheduler } = await environmentWithNeutralRuntime();
    const taskId = await environment.createTask();
    // Crash scene: the lifecycle event committed, but the initial input never
    // landed before the process died.
    await environment.events.append(taskId, makeTaskEvent({ type: 'task_started' }));

    await scheduler.recoverInterruptedTasks();
    expect((await environment.service.getWorkspace(taskId)).task.status).toBe('interrupted');

    const resumed = await scheduler.resume(taskId);
    expect(resumed.status).toBe('waiting_human');
    const inputs = inputsOf(await environment.events.read(taskId));
    expect(inputs).toHaveLength(1);
    expect(inputs[0].node.agentId).toBe(environment.frozen.agents[0].id);
  });
});

describe('TaskScheduler acceptance boundary seam (plan Phase D Task 4)', () => {
  it('stops at a committed boundary before the next Agent and stays resumable', async () => {
    const fake = new FakeAgentRuntime({
      scripts: {
        writer: [
          { kind: 'result', publicText: '初稿 V1', actions: publishTurnActions('初稿 V1') },
          { kind: 'result', publicText: '修订 V2', actions: publishTurnActions('修订 V2') },
        ],
        reviewer: [
          { kind: 'result', publicText: '退回意见', actions: reviewMessageTurnActions('请修改') },
          { kind: 'result', publicText: '终稿提交', actions: submitReceivedArtifactTurnActions },
        ],
      },
    });
    const environment = await createSchedulerEnvironment({ runtime: fake });
    const taskId = await environment.createTask();
    await environment.seedAgentInput(taskId, 'writer', '开始生产');

    const hookTaskIds: string[] = [];
    const scheduler = new TaskScheduler({
      service: environment.service,
      runner: environment.service.runner,
      runtime: fake,
      acceptanceStopAfterCommit: (hookTaskId) => {
        hookTaskIds.push(hookTaskId);
        return true; // Stop at the first committed boundary.
      },
    });

    const summary = await scheduler.start(taskId);
    // The loop halted exactly at the confirmed boundary and the hook was
    // consulted exactly once; the visible-parking policy then parks the
    // no-longer-executing task interrupted (resumable — no silent running).
    expect(summary.status).toBe('interrupted');
    expect(hookTaskIds).toEqual([taskId]);
    const workspace = await environment.service.getWorkspace(taskId);
    expect(workspace.artifacts.map((artifact) => artifact.version)).toEqual([1]);
    // The receiving agent owns the hand-off input but NEVER ran a Turn —
    // the seam paused the loop strictly before the next Agent was scheduled.
    expect(
      workspace.nodes.some((node) => node.agentId === 'reviewer' && node.kind === 'input'),
    ).toBe(true);
    expect(
      workspace.nodes.some((node) => node.agentId === 'reviewer' && node.kind === 'result'),
    ).toBe(false);

    // Restart recovery over a fresh (hook-free) scheduler marks the task
    // interrupted; the explicit resume continues from the last confirmed
    // event and completes without duplicating the confirmed version.
    const restarted = new TaskScheduler({
      service: environment.service,
      runner: environment.service.runner,
      runtime: fake,
    });
    await restarted.recoverInterruptedTasks();
    expect((await environment.service.getWorkspace(taskId)).task.status).toBe('interrupted');

    const resumed = await restarted.resume(taskId);
    expect(resumed.status).toBe('completed');
    const finalWorkspace = await environment.service.getWorkspace(taskId);
    expect(finalWorkspace.artifacts.map((artifact) => artifact.version)).toEqual([1, 2]);
    expect(finalWorkspace.artifacts.find((artifact) => artifact.version === 2)?.final).toBe(true);
  });

  it('never consults the seam for uncommitted or terminal Turns', async () => {
    // The fixture declares `reviewer` as the only final submitter, so the
    // completing Turn belongs to reviewer (submit the received input version).
    const fake = new FakeAgentRuntime({
      scripts: {
        reviewer: [
          {
            kind: 'result',
            publicText: '一次性完成',
            actions: submitReceivedArtifactTurnActions,
          },
        ],
      },
    });
    const environment = await createSchedulerEnvironment({ runtime: fake });
    const taskId = await environment.createTask();
    const version = await publishFixtureArtifact(environment, taskId, {
      title: '直接终稿',
      content: '直接终稿 正文',
      sourceNodeId: 'fixture-producer-result',
    });
    await seedAgentInputVersion(environment, taskId, 'reviewer', '开始生产', version);

    const hookTaskIds: string[] = [];
    const scheduler = new TaskScheduler({
      service: environment.service,
      runner: environment.service.runner,
      runtime: fake,
      acceptanceStopAfterCommit: (hookTaskId) => {
        hookTaskIds.push(hookTaskId);
        return true;
      },
    });

    // The completing Turn ends the loop BEFORE any seam consultation: a
    // boundary may never swallow a task that just reached its final output.
    const summary = await scheduler.start(taskId);
    expect(summary.status).toBe('completed');
    expect(hookTaskIds).toEqual([]);
  });
});

describe('TaskScheduler progress guard (plan 2026-08-06)', () => {
  /** Builds a scheduler over the harness service with an injected policy. */
  function guardedScheduler(harness: SchedulerHarness, maxTurnsSinceHumanAnswer: number): TaskScheduler {
    return new TaskScheduler({
      service: harness.environment.service,
      runner: harness.environment.service.runner,
      runtime: harness.recording,
      progressPolicy: { maxTurnsSinceHumanAnswer },
    });
  }

  const humanRequestedEvents = async (harness: SchedulerHarness) =>
    (await harness.environment.events.read(harness.taskId)).filter(
      (entry) => entry.event.type === 'human_requested',
    );

  it('parks a spinning rejection loop as waiting_human with one synthesized request', async () => {
    const harness = await schedulerHarness({
      writer: [
        { kind: 'result', publicText: '初稿 V1', actions: publishTurnActions('初稿 V1') },
        { kind: 'result', publicText: '初稿 V2', actions: publishTurnActions('初稿 V2') },
      ],
      reviewer: [
        { kind: 'result', publicText: '退回意见一', actions: reviewMessageTurnActions('请修改一') },
        { kind: 'result', publicText: '退回意见二', actions: reviewMessageTurnActions('请修改二') },
      ],
    });
    const scheduler = guardedScheduler(harness, 3);

    const summary = await scheduler.start(harness.taskId);
    expect(summary.status).toBe('waiting_human');

    // Four committed Turns tripped the limit; the guard stopped the loop
    // BEFORE a fifth ever ran.
    expect(harness.fake.countInvocations('writer')).toBe(2);
    expect(harness.fake.countInvocations('reviewer')).toBe(2);

    const requests = await humanRequestedEvents(harness);
    expect(requests).toHaveLength(1);
    const request = requests[0]?.event;
    if (request?.type !== 'human_requested') {
      throw new Error('expected a human_requested event');
    }
    // The question is asked under the LAST dispatcher (the spinning reviewer).
    expect(request.node.agentId).toBe('reviewer');
    expect(request.question).toBe(PROGRESS_GUARD_QUESTION);

    const workspace = await harness.environment.service.getWorkspace(harness.taskId);
    expect(workspace.pendingHumanQuestion).toBe(PROGRESS_GUARD_QUESTION);
  });

  it('never double-appends when an unanswered request already exists', async () => {
    const harness = await schedulerHarness({
      writer: [
        { kind: 'result', publicText: '初稿 V1', actions: publishTurnActions('初稿 V1') },
        { kind: 'result', publicText: '初稿 V2', actions: publishTurnActions('初稿 V2') },
      ],
      reviewer: [
        { kind: 'result', publicText: '退回意见一', actions: reviewMessageTurnActions('请修改一') },
        { kind: 'result', publicText: '退回意见二', actions: reviewMessageTurnActions('请修改二') },
      ],
    });
    const scheduler = guardedScheduler(harness, 2);
    const parked = await scheduler.start(harness.taskId);
    expect(parked.status).toBe('waiting_human');

    // stop + resume re-enters the loop with the unanswered request still
    // committed: the guard breaks immediately, appending nothing and running
    // no Turn.
    await scheduler.stop(harness.taskId);
    await scheduler.resume(harness.taskId);

    expect(await humanRequestedEvents(harness)).toHaveLength(1);
    // The guard tripped right after the writer's second publish (the third
    // committed Turn), before the reviewer's scripted second Turn could run.
    expect(harness.fake.countInvocations('writer')).toBe(2);
    expect(harness.fake.countInvocations('reviewer')).toBe(1);
  });

  it('answer resets the window and runs the task to completion', async () => {
    const harness = await schedulerHarness({
      writer: [
        { kind: 'result', publicText: '初稿 V1', actions: publishTurnActions('初稿 V1') },
        { kind: 'result', publicText: '初稿 V2', actions: publishTurnActions('初稿 V2') },
      ],
      reviewer: [
        { kind: 'result', publicText: '退回意见一', actions: reviewMessageTurnActions('请修改一') },
        { kind: 'result', publicText: '终稿提交', actions: submitReceivedArtifactTurnActions },
      ],
    });
    const scheduler = guardedScheduler(harness, 2);
    const parked = await scheduler.start(harness.taskId);
    expect(parked.status).toBe('waiting_human');

    // The human answer resets the progress window; the reviewer's pending
    // artifact hand-off (committed before the guard fired) runs first and
    // reaches the system final gate under the fresh budget.
    const answered = await scheduler.answer(harness.taskId, '复审并提交');
    expect(answered.status).toBe('completed');
    const workspace = await harness.environment.service.getWorkspace(harness.taskId);
    expect(workspace.artifacts.at(-1)?.final).toBe(true);
    expect(await humanRequestedEvents(harness)).toHaveLength(1);
  });

  it('healthy completion under the limit commits no guard request', async () => {
    const harness = await schedulerHarness({
      writer: [
        { kind: 'result', publicText: '初稿 V1', actions: publishTurnActions('初稿 V1') },
        { kind: 'result', publicText: '初稿 V2', actions: publishTurnActions('初稿 V2') },
      ],
      reviewer: [
        { kind: 'result', publicText: '退回意见', actions: reviewMessageTurnActions('请修改') },
        { kind: 'result', publicText: '终稿提交', actions: submitReceivedArtifactTurnActions },
      ],
    });
    // The production scheduler carries the default policy (limit 8); four
    // committed Turns never trip it.
    const summary = await harness.scheduler.start(harness.taskId);
    expect(summary.status).toBe('completed');
    expect(await humanRequestedEvents(harness)).toHaveLength(0);
  });

  it('restart keeps the parked task waiting_human and answerable', async () => {
    const harness = await schedulerHarness({
      writer: [
        { kind: 'result', publicText: '初稿 V1', actions: publishTurnActions('初稿 V1') },
        { kind: 'result', publicText: '初稿 V2', actions: publishTurnActions('初稿 V2') },
      ],
      reviewer: [
        { kind: 'result', publicText: '退回意见一', actions: reviewMessageTurnActions('请修改一') },
        { kind: 'result', publicText: '终稿提交', actions: submitReceivedArtifactTurnActions },
      ],
    });
    const scheduler = guardedScheduler(harness, 2);
    const parked = await scheduler.start(harness.taskId);
    expect(parked.status).toBe('waiting_human');

    // A fresh scheduler over the same roots simulates the restart: recovery
    // must leave the waiting task untouched so `answer` stays reachable.
    const restarted = new TaskScheduler({
      service: harness.environment.service,
      runner: harness.environment.service.runner,
      runtime: harness.recording,
      progressPolicy: { maxTurnsSinceHumanAnswer: 2 },
    });
    const interrupted = await restarted.recoverInterruptedTasks();
    expect(interrupted).not.toContain(harness.taskId);
    expect((await harness.environment.service.getWorkspace(harness.taskId)).task.status).toBe(
      'waiting_human',
    );

    const answered = await restarted.answer(harness.taskId, '复审并提交');
    expect(answered.status).toBe('completed');
  });

  it('recovery leaves a model-requested waiting task untouched and answerable', async () => {
    const harness = await schedulerHarness({}, { seedWriterInput: false });
    const waiting = await harness.environment.createTask();
    await harness.environment.events.append(waiting, makeTaskEvent({ type: 'task_started' }));
    await harness.environment.seedAgentInput(waiting, 'writer', '开始生产');
    await harness.environment.events.append(
      waiting,
      makeTaskEvent({
        type: 'agent_result',
        node: makeEventNode({
          sequence: 2,
          agentId: 'writer',
          kind: 'result',
          title: '结果',
          body: '需要确认',
        }),
      }),
    );
    await harness.environment.events.append(
      waiting,
      makeTaskEvent({
        type: 'human_requested',
        node: makeEventNode({
          sequence: 3,
          agentId: 'writer',
          kind: 'human_request',
          title: '人工请求',
          body: '是否继续？',
        }),
        question: '是否继续？',
      }),
    );

    const interrupted = await harness.scheduler.recoverInterruptedTasks();
    expect(interrupted).not.toContain(waiting);
    const workspace = await harness.environment.service.getWorkspace(waiting);
    expect(workspace.task.status).toBe('waiting_human');
    expect(workspace.pendingHumanQuestion).toBe('是否继续？');
  });

  it('a template-declared budget overrides the scheduler-injected policy', async () => {
    const fake = new FakeAgentRuntime({
      scripts: {
        writer: [
          { kind: 'result', publicText: '初稿 V1', actions: publishTurnActions('初稿 V1') },
          { kind: 'result', publicText: '初稿 V2', actions: publishTurnActions('初稿 V2') },
        ],
        reviewer: [
          { kind: 'result', publicText: '退回意见一', actions: reviewMessageTurnActions('请修改一') },
          { kind: 'result', publicText: '退回意见二', actions: reviewMessageTurnActions('请修改二') },
        ],
      },
    });
    const recording = new RecordingRuntime(fake);
    const environment = await createSchedulerEnvironment({
      runtime: recording,
      patchTemplate: (templateDir) => {
        writeFileSync(
          join(templateDir, 'pipeline.yaml'),
          `${readFileSync(join(templateDir, 'pipeline.yaml'), 'utf8').trimEnd()}\nbudget:\n  maxTurnsSinceHumanAnswer: 1`,
          'utf8',
        );
      },
    });
    const taskId = await environment.createTask();
    await environment.seedAgentInput(taskId, 'writer', '开始生产');
    // Injected policy says 8; the frozen template budget 1 must win.
    const scheduler = new TaskScheduler({
      service: environment.service,
      runner: environment.service.runner,
      runtime: recording,
      progressPolicy: { maxTurnsSinceHumanAnswer: 8 },
    });

    const summary = await scheduler.start(taskId);
    expect(summary.status).toBe('waiting_human');
    expect(fake.countInvocations('writer')).toBe(1);
    expect(fake.countInvocations('reviewer')).toBe(1);
    const requests = (await environment.events.read(taskId)).filter(
      (entry) => entry.event.type === 'human_requested',
    );
    expect(requests).toHaveLength(1);
    if (requests[0]?.event.type === 'human_requested') {
      expect(requests[0].event.question).toBe(PROGRESS_GUARD_QUESTION);
    }
  });
});

describe('TaskScheduler no-progress protection (plan 2026-08-04 Task 3)', () => {
  it('parks a text-only turn as a visible failure instead of leaving running', async () => {
    // The historical gap: a Turn that committed zero actions used to write a
    // result node and rest, leaving the task projected `running` forever.
    // The phase gate now rejects the empty action set, the runner records a
    // non-retryable attempt failure and the loop parks the task visibly.
    const harness = await schedulerHarness({
      writer: [{ kind: 'result', publicText: '我说完成了。', actions: [] }],
    });

    const summary = await harness.scheduler.start(harness.taskId);
    expect(summary.status).toBe('retryable_failure');
    expect(summary.status).not.toBe('running');

    const committed = await harness.environment.events.read(harness.taskId);
    const failure = committed.find((entry) => entry.event.type === 'agent_attempt_failed');
    expect(failure?.event).toMatchObject({ retryable: false });
    expect(committed.some((entry) => entry.event.type === 'agent_result')).toBe(false);
  });
});

describe('TaskScheduler incompatibility gate (plan 2026-08-04 Task 3, spec §7.3)', () => {
  async function legacyHarness(): Promise<SchedulerHarness> {
    return schedulerHarness({}, { seedWriterInput: false });
  }

  it('recovery marks unfinished legacy snapshots incompatible exactly once', async () => {
    const harness = await legacyHarness();
    const legacyActive = await harness.environment.createTask();
    await downgradeTaskSnapshotToLegacy(harness.environment.paths, legacyActive);
    await harness.environment.events.append(legacyActive, makeTaskEvent({ type: 'task_started' }));
    await harness.environment.seedAgentInput(legacyActive, 'writer', '中断前输入');

    const interrupted = await harness.scheduler.recoverInterruptedTasks();
    expect(interrupted).toEqual([]); // legacy tasks never become interrupted

    const workspace = await harness.environment.service.getWorkspace(legacyActive);
    expect(workspace.task.status).toBe('incompatible');
    expect(workspace.task.diagnostic).toContain('回合契约');
    // The workspace content itself stays readable (history preserved).
    expect(workspace.nodes.some((node) => node.kind === 'input')).toBe(true);

    // Idempotent: a second recovery adds no duplicate task_incompatible event.
    await harness.scheduler.recoverInterruptedTasks();
    const eventsAfter = await harness.environment.events.read(legacyActive);
    expect(
      eventsAfter.filter((entry) => entry.event.type === 'task_incompatible'),
    ).toHaveLength(1);
  });

  it('leaves completed and stopped legacy tasks untouched and readable', async () => {
    const harness = await legacyHarness();
    const legacyStopped = await harness.environment.createTask();
    await downgradeTaskSnapshotToLegacy(harness.environment.paths, legacyStopped);
    await harness.environment.events.append(legacyStopped, makeTaskEvent({ type: 'task_started' }));
    await harness.environment.events.append(legacyStopped, makeTaskEvent({ type: 'task_stopped' }));

    const interrupted = await harness.scheduler.recoverInterruptedTasks();
    expect(interrupted).toEqual([]);

    const workspace = await harness.environment.service.getWorkspace(legacyStopped);
    expect(workspace.task.status).toBe('stopped');
    expect(workspace.task.diagnostic).toBeNull();
    const eventsAfter = await harness.environment.events.read(legacyStopped);
    expect(
      eventsAfter.some((entry) => entry.event.type === 'task_incompatible'),
    ).toBe(false);
  });

  it('rejects start/resume/retry/answer with TASK_CONTRACT_INCOMPATIBLE', async () => {
    const harness = await legacyHarness();
    const legacy = await harness.environment.createTask();
    await downgradeTaskSnapshotToLegacy(harness.environment.paths, legacy);

    for (const attempt of [
      () => harness.scheduler.start(legacy),
      () => harness.scheduler.resume(legacy),
      () => harness.scheduler.retry(legacy),
      () => harness.scheduler.answer(legacy, '回答'),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'TASK_CONTRACT_INCOMPATIBLE' });
    }
    // Nothing lifecycle-shaped was committed by the rejections.
    const committed = await harness.environment.events.read(legacy);
    expect(committed).toEqual([]);
  });

  it('still allows cloning a legacy task onto the current template', async () => {
    const harness = await legacyHarness();
    const legacy = await harness.environment.createTask();
    await downgradeTaskSnapshotToLegacy(harness.environment.paths, legacy);

    const clone = await harness.environment.service.cloneTask(legacy);
    expect(clone.id).not.toBe(legacy);
    expect(clone.status).toBe('ready');
    // The clone freezes the CURRENT template snapshot (contract included).
    const frozen = await harness.environment.tasks.readFrozenTemplate(clone.id);
    expect(frozen.agents.every((agent) => agent.turnContract !== null)).toBe(true);
  });

  it('recovery still marks current-contract tasks interrupted', async () => {
    const harness = await legacyHarness();
    const current = await harness.environment.createTask();
    await harness.environment.events.append(current, makeTaskEvent({ type: 'task_started' }));
    await harness.environment.seedAgentInput(current, 'writer', '中断前输入');

    const interrupted = await harness.scheduler.recoverInterruptedTasks();
    expect(interrupted).toEqual([current]);
    expect((await harness.environment.service.getWorkspace(current)).task.status).toBe(
      'interrupted',
    );
  });

  it('recovery marks never-started legacy ready tasks incompatible (review F3)', async () => {
    // A legacy task frozen before the turn contract existed and never
    // started: the projection says 'ready', but start must stay refused — so
    // recovery marks it incompatible instead of leaving a false 'ready'.
    const harness = await legacyHarness();
    const legacyReady = await harness.environment.createTask();
    await downgradeTaskSnapshotToLegacy(harness.environment.paths, legacyReady);
    expect(
      (await harness.environment.service.getWorkspace(legacyReady)).task.status,
    ).toBe('ready');

    const interrupted = await harness.scheduler.recoverInterruptedTasks();
    expect(interrupted).toEqual([]); // legacy tasks never become interrupted

    const workspace = await harness.environment.service.getWorkspace(legacyReady);
    expect(workspace.task.status).toBe('incompatible');
    await expect(harness.scheduler.start(legacyReady)).rejects.toMatchObject({
      code: 'TASK_CONTRACT_INCOMPATIBLE',
    });
    // Cloning onto the current template stays available.
    const clone = await harness.environment.service.cloneTask(legacyReady);
    expect(clone.id).not.toBe(legacyReady);
    expect(clone.status).toBe('ready');
  });

  it('recovery marks legacy interrupted tasks incompatible (review F3)', async () => {
    // Interrupted before the upgrade: resume would be refused by the gate
    // anyway, so recovery must move the task to the honest terminal state.
    const harness = await legacyHarness();
    const legacyInterrupted = await harness.environment.createTask();
    await downgradeTaskSnapshotToLegacy(harness.environment.paths, legacyInterrupted);
    await harness.environment.events.append(
      legacyInterrupted,
      makeTaskEvent({ type: 'task_started' }),
    );
    await harness.environment.events.append(
      legacyInterrupted,
      makeTaskEvent({ type: 'task_interrupted' }),
    );
    expect(
      (await harness.environment.service.getWorkspace(legacyInterrupted)).task.status,
    ).toBe('interrupted');

    const interrupted = await harness.scheduler.recoverInterruptedTasks();
    expect(interrupted).toEqual([]);

    const workspace = await harness.environment.service.getWorkspace(legacyInterrupted);
    expect(workspace.task.status).toBe('incompatible');
    await expect(harness.scheduler.resume(legacyInterrupted)).rejects.toMatchObject({
      code: 'TASK_CONTRACT_INCOMPATIBLE',
    });
  });

  it('leaves never-started and interrupted current-contract tasks as they are (review F3)', async () => {
    // The widened recovery scan must not touch contract-supported tasks that
    // sit in 'ready' or 'interrupted': they stay startable/resumable.
    const harness = await legacyHarness();
    const ready = await harness.environment.createTask();
    const interrupted = await harness.environment.createTask();
    await harness.environment.events.append(interrupted, makeTaskEvent({ type: 'task_started' }));
    await harness.environment.events.append(
      interrupted,
      makeTaskEvent({ type: 'task_interrupted' }),
    );

    await harness.scheduler.recoverInterruptedTasks();

    expect((await harness.environment.service.getWorkspace(ready)).task.status).toBe('ready');
    expect((await harness.environment.service.getWorkspace(interrupted)).task.status).toBe(
      'interrupted',
    );
  });
});

describe('TaskScheduler interrupted-commit re-entry (review F4)', () => {
  /**
   * A scheduler environment whose runner commits through an ArtifactStore
   * proxy that fails its first `publishFailures` publish calls — producing a
   * deterministic COMMIT_INTERRUPTED mid-plan (agent result committed, no
   * publication yet).
   */
  async function interruptedCommitHarness(options: { publishFailures: number }) {
    const writerStep = (title: string): FakeScriptStep => ({
      kind: 'result',
      publicText: '初稿完成',
      actions: publishTurnActions(title),
    });
    const fake = new FakeAgentRuntime({
      scripts: {
        // Attempt 1 plus two identical re-entry attempts (retry and resume).
        writer: [writerStep('第一章'), writerStep('第一章'), writerStep('第一章')],
        reviewer: [
          {
            kind: 'result',
            publicText: '终稿确认',
            actions: submitReceivedArtifactTurnActions,
          },
        ],
      },
    });
    const environment = await createSchedulerEnvironment({ runtime: fake });

    let remainingFailures = options.publishFailures;
    const failingArtifacts = new Proxy(environment.artifacts, {
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

    const skills = new SkillService({
      paths: environment.paths,
      tasks: environment.tasks,
      events: environment.events,
    });
    const committer = new ActionCommitter({
      events: environment.events,
      artifacts: failingArtifacts,
      skills,
    });
    const runner = new TaskRunner({
      tasks: environment.tasks,
      events: environment.events,
      artifacts: failingArtifacts,
      skills,
      committer,
      runtime: fake,
      workspaces: new WorkspaceStore(environment.paths),
      traces: new TraceStore(environment.paths),
    });
    const scheduler = new TaskScheduler({ service: environment.service, runner, runtime: fake });
    const taskId = await environment.createTask();
    await environment.seedAgentInput(taskId, 'writer', '开始生产');
    return { environment, scheduler, runner, fake, taskId };
  }

  it('manual retry completes an interrupted commit under the same turn id', async () => {
    const harness = await interruptedCommitHarness({ publishFailures: 1 });

    const first = await harness.scheduler.start(harness.taskId);
    expect(first.status).toBe('retryable_failure');

    // The partial commit: the agent result landed, the publication did not.
    let committed = await harness.environment.events.read(harness.taskId);
    const types = committed.map((entry) => entry.event.type);
    expect(types).toContain('agent_result');
    expect(types).toContain('agent_attempt_failed');
    expect(types).not.toContain('artifact_published');
    expect(types).not.toContain('final_submission_accepted');
    expect(await harness.environment.artifacts.list(harness.taskId)).toEqual([]);

    // Manual retry re-enters the SAME turn id: committed items replay, the
    // interrupted publication completes, the chain runs to the final gate.
    const retried = await harness.scheduler.retry(harness.taskId);
    expect(retried.status).toBe('completed');

    committed = await harness.environment.events.read(harness.taskId);
    // No duplicated turns or events: one result per agent, one publication.
    const results = committed.filter((entry) => entry.event.type === 'agent_result');
    expect(results).toHaveLength(2);
    expect(
      results.filter((entry) => 'node' in entry.event && entry.event.node.agentId === 'writer'),
    ).toHaveLength(1);
    expect(
      committed.filter((entry) => entry.event.type === 'artifact_published'),
    ).toHaveLength(1);
    expect(
      committed.filter((entry) => entry.event.type === 'final_submission_accepted'),
    ).toHaveLength(1);
    expect(
      (await harness.environment.artifacts.list(harness.taskId)).map(
        (entry) => entry.meta.version,
      ),
    ).toEqual([1]);
  });

  it('parks a repeatedly interrupted commit visibly after restart and resume, never running', async () => {
    const harness = await interruptedCommitHarness({
      publishFailures: Number.POSITIVE_INFINITY,
    });

    const first = await harness.scheduler.start(harness.taskId);
    expect(first.status).toBe('retryable_failure');

    // Process restart: recovery marks the parked task interrupted; the resume
    // re-enters the interrupted commit instead of spinning idle, and the
    // failing publication parks the task in a visible failure — never the
    // historical 'running' dead end.
    const restarted = new TaskScheduler({
      service: harness.environment.service,
      runner: harness.runner,
      runtime: harness.fake,
    });
    await restarted.recoverInterruptedTasks();
    expect(
      (await harness.environment.service.getWorkspace(harness.taskId)).task.status,
    ).toBe('interrupted');

    const resumed = await restarted.resume(harness.taskId);
    expect(resumed.status).toBe('retryable_failure');
    expect(resumed.status).not.toBe('running');

    // Still exactly one result node and one artifact-less history: the
    // re-entry replayed the interrupted turn instead of duplicating it.
    const committed = await harness.environment.events.read(harness.taskId);
    expect(
      committed.filter((entry) => entry.event.type === 'agent_result'),
    ).toHaveLength(1);
    expect(committed.filter((entry) => entry.event.type === 'artifact_published')).toEqual([]);
    expect(await harness.environment.artifacts.list(harness.taskId)).toEqual([]);
  });
});
