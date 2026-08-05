// @vitest-environment node
/**
 * CoreService live-streaming wiring (plan C realtime streaming): the
 * runtime's onLive patches flow through the TaskRunner into the in-memory
 * LiveStore, and getWorkspace attaches the result as `activeTurn` — only
 * while a Turn is in flight; success and failure both clear it. Nothing is
 * persisted: only the projected workspace ever carries the buffer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LiveTurn } from '../shared/contracts';
import { FakeAgentRuntime } from './runtime/fake-agent-runtime';
import {
  createDeferred,
  createSchedulerEnvironment,
  disposeRuntimeTestRoots,
  type SchedulerEnvironment,
} from './runtime/test-support';

afterEach(() => {
  disposeRuntimeTestRoots();
});

async function workspaceActiveTurn(
  environment: SchedulerEnvironment,
  taskId: string,
): Promise<LiveTurn | null> {
  const workspace = await environment.service.getWorkspace(taskId);
  return workspace.activeTurn ?? null;
}

/** Polls until the task's live turn appears (2 s fail-loud deadline). */
async function waitForActiveTurn(
  environment: SchedulerEnvironment,
  taskId: string,
): Promise<LiveTurn> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const live = await workspaceActiveTurn(environment, taskId);
    if (live !== null) return live;
    if (Date.now() > deadline) {
      throw new Error('no activeTurn appeared within 2 s');
    }
    await new Promise((wait) => setTimeout(wait, 5));
  }
}

/** Polls until the task reaches the given status (2 s fail-loud deadline). */
async function waitForStatus(
  environment: SchedulerEnvironment,
  taskId: string,
  status: string,
): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const workspace = await environment.service.getWorkspace(taskId);
    if (workspace.task.status === status) return;
    if (Date.now() > deadline) {
      throw new Error(`task never reached '${status}' (last: ${workspace.task.status})`);
    }
    await new Promise((wait) => setTimeout(wait, 5));
  }
}

/** Final-submitter script: seal one package and submit the final output. */
function finalSubmissionScript(environment: SchedulerEnvironment, deferred?: ReturnType<typeof createDeferred<void>>) {
  const format = environment.frozen.finalOutput.format;
  const artifactType = environment.frozen.finalOutput.name;
  return {
    kind: 'result' as const,
    ...(deferred !== undefined ? { deferred } : {}),
    publicText: 'neutral streamed result',
    thinking: 'neutral thoughts',
    actions: [
      {
        type: 'finish_production' as const,
        source: 'inline' as const,
        content: 'neutral final content',
        format,
        artifactType,
        title: 'Neutral Fixture Final',
      },
      { type: 'submit_final_artifact' as const, productionPackageRef: 'current' as const },
    ],
  };
}

describe('CoreService live streaming (plan C)', () => {
  it('shows no activeTurn before the run starts', async () => {
    const runtime = new FakeAgentRuntime();
    const environment = await createSchedulerEnvironment({ runtime });
    const taskId = await environment.createTask();
    expect(await workspaceActiveTurn(environment, taskId)).toBeNull();
  });

  it('exposes the in-flight turn as activeTurn and clears it on completion', async () => {
    const runtime = new FakeAgentRuntime();
    const environment = await createSchedulerEnvironment({ runtime });
    const submitterId = environment.frozen.finalOutput.submitters[0];
    if (submitterId === undefined) throw new Error('fixture declares no final submitter');
    const deferred = createDeferred<void>();
    runtime.setScript(submitterId, [finalSubmissionScript(environment, deferred)]);
    const taskId = await environment.createTask();
    const inputEventId = await environment.seedAgentInput(taskId, submitterId, 'neutral opening input');

    const runPromise = environment.service.scheduler.start(taskId);
    const live = await waitForActiveTurn(environment, taskId);
    expect(live.agentId).toBe(submitterId);
    expect(live.turnId).toBe(`${inputEventId}-t1`);
    expect(live.status).toBe('running');
    // The announce patch lands before any content has streamed.
    expect(live.text).toBe('');
    expect(live.thinking).toBe('');

    deferred.resolve();
    await waitForStatus(environment, taskId, 'completed');
    expect(await workspaceActiveTurn(environment, taskId)).toBeNull();
    // Let the scheduler's own final projection settle before teardown.
    await runPromise;
  });

  it('clears the live buffer when the attempt fails', async () => {
    const runtime = new FakeAgentRuntime();
    const environment = await createSchedulerEnvironment({ runtime });
    const submitterId = environment.frozen.finalOutput.submitters[0];
    if (submitterId === undefined) throw new Error('fixture declares no final submitter');
    const deferred = createDeferred<void>();
    const { RuntimeFailure } = await import('./runtime/agent-runtime');
    runtime.setScript(submitterId, [
      {
        kind: 'failure',
        deferred,
        // Permanent: parks for a manual retry immediately (no auto-retry
        // sleep), so the buffer-clearing on failure is observable right away.
        failure: RuntimeFailure.permanent('PROVIDER_ERROR', 'scripted provider failure'),
      },
    ]);
    const taskId = await environment.createTask();
    await environment.seedAgentInput(taskId, submitterId, 'neutral opening input');

    const runPromise = environment.service.scheduler.start(taskId);
    await waitForActiveTurn(environment, taskId);

    deferred.resolve();
    await waitForStatus(environment, taskId, 'retryable_failure');
    expect(await workspaceActiveTurn(environment, taskId)).toBeNull();
    // Let the scheduler's own final projection settle before teardown.
    await runPromise;
  });
});
