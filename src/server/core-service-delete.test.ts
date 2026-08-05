// @vitest-environment node
/**
 * CoreService.deleteTask tests (task list delete feature): deletion covers
 * EVERY task status — the whole task directory (record, snapshot, events,
 * artifacts, traces, workspaces) is removed. A task that holds the single
 * execution slot is aborted first so no running slot survives the deletion;
 * the in-memory live buffer is cleared as well. Unknown ids reject with the
 * public TASK_NOT_FOUND code.
 */
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeScriptStep } from './runtime/fake-agent-runtime';
import {
  disposeRuntimeTestRoots,
  schedulerWithDeferredRuntime,
} from './runtime/test-support';

afterEach(() => {
  disposeRuntimeTestRoots();
});

/** One legal writer turn: seal an inline package, then the publish dispatch. */
const publishTurnActions = (title: string) => [
  {
    type: 'finish_production' as const,
    source: 'inline' as const,
    content: `${title} body`,
    format: 'markdown' as const,
    artifactType: '终稿',
    title,
  },
  { type: 'publish_artifact' as const, productionPackageRef: 'current' as const },
];

/** Legal final reviewer turn over a received artifact: seal it and submit it. */
const submitReceivedArtifactTurnActions = [
  { type: 'finish_production' as const, source: 'current_input_artifact' as const },
  { type: 'submit_final_artifact' as const, productionPackageRef: 'current' as const },
];

/** One legal reviewer turn: seal an inline review and send it to the writer. */
const reviewMessageTurnActions = (review: string) => [
  {
    type: 'finish_production' as const,
    source: 'inline' as const,
    content: review,
    format: 'text' as const,
    artifactType: null,
    title: null,
  },
  {
    type: 'send_message' as const,
    targetAgentId: 'writer',
    productionPackageRef: 'current' as const,
  },
];

/** Scripts that drive a task all the way to `completed` (serial loop). */
const completionScripts: Record<string, readonly FakeScriptStep[]> = {
  writer: [
    { kind: 'result', publicText: 'draft v1', actions: publishTurnActions('draft v1') },
    { kind: 'result', publicText: 'draft v2', actions: publishTurnActions('draft v2') },
  ],
  reviewer: [
    { kind: 'result', publicText: 'return notes', actions: reviewMessageTurnActions('revise') },
    { kind: 'result', publicText: 'final submit', actions: submitReceivedArtifactTurnActions },
  ],
};

describe('CoreService.deleteTask', () => {
  it('removes a ready task from storage, listing and projection', async () => {
    const scheduler = await schedulerWithDeferredRuntime();
    const { service } = scheduler.environment;
    const taskId = await scheduler.environment.createTask();

    await service.deleteTask(taskId);

    expect(existsSync(scheduler.environment.paths.taskRoot(taskId))).toBe(false);
    expect((await service.listTasks()).map((task) => task.id)).not.toContain(taskId);
    await expect(service.getWorkspace(taskId)).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });

  // Deleting a running task aborts the in-flight turn and removes the whole
  // task directory. The Deferred fixture's aborted run never settles, so we do
  // not await it nor reuse the aborted scheduler for a second start; the
  // essential guarantee is that a running task is deletable and disappears.
  it('aborts the running turn and removes the running task', { timeout: 10000 }, async () => {
    const scheduler = await schedulerWithDeferredRuntime({ scripts: completionScripts });
    const { service } = scheduler.environment;
    void scheduler.start(scheduler.taskA);
    await scheduler.runtime.waitForPendingTurn();

    await service.deleteTask(scheduler.taskA);

    expect(existsSync(scheduler.environment.paths.taskRoot(scheduler.taskA))).toBe(false);
    expect((await service.listTasks()).map((task) => task.id)).not.toContain(
      scheduler.taskA,
    );
    expect(service.live.get(scheduler.taskA)).toBeNull();
  });

  it('clears the in-memory live buffer of the deleted task', async () => {
    const scheduler = await schedulerWithDeferredRuntime();
    const { service } = scheduler.environment;
    service.live.merge(scheduler.taskA, {
      agentId: 'writer',
      turnId: 'turn-x',
      text: 'streamed fragment',
    });
    expect(service.live.get(scheduler.taskA)).not.toBeNull();

    await service.deleteTask(scheduler.taskA);

    expect(service.live.get(scheduler.taskA)).toBeNull();
  });

  it('rejects unknown task ids with TASK_NOT_FOUND', async () => {
    const scheduler = await schedulerWithDeferredRuntime();
    await expect(scheduler.environment.service.deleteTask('no-such-task')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });
});
