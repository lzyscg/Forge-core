// @vitest-environment node
/**
 * CoreService live-streaming wiring (plan C realtime streaming): the
 * runtime's onLive patches flow through the TaskRunner into the in-memory
 * LiveStore, and getWorkspace attaches the result as `activeTurn` — only
 * while a Turn is in flight; success and failure both clear it. Nothing is
 * persisted: only the projected workspace ever carries the buffer.
 *
 * Task 17 adds the structured runtime-readiness lifecycle (spec §5 / design
 * O04/O05): with the checked-in disabled environment a known structured
 * source is unavailable and create returns TEMPLATE_RUNTIME_UNAVAILABLE, an
 * injected historical structured snapshot rejects start/resume/retry/answer
 * with the same code, and basic remains runnable; with ONE injected matching
 * enabled environment the load/cache/create/snapshot/start paths proceed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LiveTurn } from '../shared/contracts';
import { CoreService } from './core-service';
import { makeTempCorePaths, disposeAllTestRoots } from './test-support';
import { createDisabledRuntimeEnvironment, createTestRuntimeEnvironment } from './structured-slots/runtime-capability';
import { FakeAgentRuntime } from './runtime/fake-agent-runtime';
import {
  createDeferred,
  createSchedulerEnvironment,
  disposeRuntimeTestRoots,
  publishFixtureArtifact,
  seedAgentInputVersion,
  type SchedulerEnvironment,
} from './runtime/test-support';

afterEach(() => {
  disposeRuntimeTestRoots();
  disposeAllTestRoots();
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

/** Final-submitter script: submit the received input version as final output. */
function finalSubmissionScript(deferred?: ReturnType<typeof createDeferred<void>>) {
  return {
    kind: 'result' as const,
    ...(deferred !== undefined ? { deferred } : {}),
    publicText: 'neutral streamed result',
    thinking: 'neutral thoughts',
    actions: [{ type: 'submit_final_artifact' as const }],
  };
}

describe('CoreService live streaming (plan C)', () => {
  it('shows no activeTurn before the run starts', async () => {
    const runtime = new FakeAgentRuntime();
    const environment = await createSchedulerEnvironment({ runtime });
    const taskId = await environment.createTask();
    expect(await workspaceActiveTurn(environment, taskId)).toBeNull();
    // The projected summary carries the frozen-snapshot protocol derived
    // through the shared helper (spec §4.1): the basic fixture is 'none'.
    const workspace = await environment.service.getWorkspace(taskId);
    expect(workspace.task.structuredProtocol).toBe('none');
  });

  it('exposes the in-flight turn as activeTurn and clears it on completion', async () => {
    const runtime = new FakeAgentRuntime();
    const environment = await createSchedulerEnvironment({ runtime });
    const submitterId = environment.frozen.finalOutput.submitters[0];
    if (submitterId === undefined) throw new Error('fixture declares no final submitter');
    const deferred = createDeferred<void>();
    runtime.setScript(submitterId, [finalSubmissionScript(deferred)]);
    const taskId = await environment.createTask();
    const version = await publishFixtureArtifact(environment, taskId, {
      title: 'Neutral Fixture Final',
      content: 'neutral final content',
      sourceNodeId: 'fixture-producer-result',
    });
    const inputEventId = await seedAgentInputVersion(
      environment,
      taskId,
      submitterId,
      'neutral opening input',
      version,
    );

    const runPromise = environment.service.scheduler.start(taskId);
    const live = await waitForActiveTurn(environment, taskId);
    expect(live.agentId).toBe(submitterId);
    expect(live.turnId).toBe(`${inputEventId}-t1`);
    expect(live.status).toBe('running');
    // The announce patch lands before any content has streamed.
    expect(live.text).toBe('');

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

// ---------------------------------------------------------------------------
// Task 17: structured runtime-readiness lifecycle (spec §5 / design O04/O05).
// ---------------------------------------------------------------------------

const STRUCTURED_TEMPLATE_ID = 'structured-valid';

/** Locates the structured-valid template fixture (node + jsdom fallback). */
function structuredValidFixtureDir(): string {
  try {
    return fileURLToPath(
      new URL('template/__fixtures__/structured-valid', import.meta.url),
    );
  } catch {
    return join(
      process.cwd(),
      'src',
      'server',
      'template',
      '__fixtures__',
      'structured-valid',
    );
  }
}

/** Builds a CoreService over the structured fixture with an optional enabled env. */
async function createStructuredService(options: {
  enabled: boolean;
  runtime?: FakeAgentRuntime;
  /** Reuse an existing roots pair (e.g. a historical snapshot reopened under the disabled default). */
  paths?: ReturnType<typeof makeTempCorePaths>['paths'];
}): Promise<{ service: CoreService; paths: ReturnType<typeof makeTempCorePaths>['paths'] }> {
  const paths = options.paths ?? makeTempCorePaths('forge-core-structured-live-').paths;
  const templateDir = join(paths.templateRoot, STRUCTURED_TEMPLATE_ID);
  cpSync(structuredValidFixtureDir(), templateDir, { recursive: true });
  // Explicit environment fixtures only — never the checked-in production
  // manifest (spec §15: only the release command may assert the checked-in
  // phase), so this identical source passes before AND after promotion.
  const runtimeEnvironment = options.enabled
    ? createTestRuntimeEnvironment()
    : createDisabledRuntimeEnvironment();
  const service = new CoreService(paths, {
    runtime: options.runtime ?? new FakeAgentRuntime(),
    runtimeEnvironment,
  });
  await service.initialize();
  return { service, paths };
}

/** Creates one structured task from the fixture's single required input field. */
async function createStructuredTask(service: CoreService): Promise<string> {
  const created = await service.createTask({
    templateId: STRUCTURED_TEMPLATE_ID,
    name: 'Structured Readiness Task',
    input: { 'source-text': 'neutral structured source' },
  });
  return created.id;
}

describe('CoreService structured runtime-readiness (Task 17, spec §5)', () => {
  it('with the disabled default: structured source is unavailable and create rejects', async () => {
    const { service } = await createStructuredService({ enabled: false });
    // The known structured source is NOT valid in the catalog (never a valid
    // fallback); create surfaces TEMPLATE_RUNTIME_UNAVAILABLE, never
    // TEMPLATE_NOT_FOUND.
    expect(service.templates.get(STRUCTURED_TEMPLATE_ID)?.status).not.toBe('valid');
    await expect(
      service.createTask({
        templateId: STRUCTURED_TEMPLATE_ID,
        name: 'Structured Readiness Task',
        input: { 'source-text': 'neutral' },
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_RUNTIME_UNAVAILABLE' });
    await service.shutdown();
  });

  it('with the disabled default: basic tasks remain runnable', async () => {
    const environment = await createSchedulerEnvironment({ runtime: new FakeAgentRuntime() });
    const submitterId = environment.frozen.finalOutput.submitters[0];
    if (submitterId === undefined) throw new Error('fixture declares no final submitter');
    const taskId = await environment.createTask();
    await environment.seedAgentInput(taskId, submitterId, 'neutral opening input');
    const summary = await environment.service.scheduler.start(taskId);
    // The basic path is unaffected by the structured gate: the run reaches a
    // rest state (a failed/no-dispatch turn parks), never a readiness rejection.
    expect(['retryable_failure', 'interrupted', 'running', 'completed']).toContain(summary.status);
  });

  it('with the disabled default: an injected historical structured snapshot rejects all run entries', async () => {
    // Freeze a structured task under an enabled env, then reopen the SAME
    // roots with the checked-in disabled default — the snapshot is historical.
    const enabled = await createStructuredService({ enabled: true });
    const taskId = await createStructuredTask(enabled.service);
    await enabled.service.shutdown();

    const disabled = await createStructuredService({
      enabled: false,
      paths: enabled.paths,
    });
    const scheduler = disabled.service.scheduler;
    for (const operation of [
      () => scheduler.start(taskId),
      () => scheduler.resume(taskId),
      () => scheduler.retry(taskId),
      () => scheduler.answer(taskId, 'neutral answer'),
    ] as const) {
      await expect(operation()).rejects.toMatchObject({
        code: 'TEMPLATE_RUNTIME_UNAVAILABLE',
      });
    }
    await disabled.service.shutdown();
  });

  it('with ONE injected matching enabled environment: load/cache/create/start proceed', async () => {
    const { service } = await createStructuredService({ enabled: true });
    // The catalog loads + caches the structured template as valid.
    const detail = service.templates.get(STRUCTURED_TEMPLATE_ID);
    expect(detail?.status).toBe('valid');
    const frozen = service.templates.getFrozen(STRUCTURED_TEMPLATE_ID);
    expect(frozen?.productionMode).toBe('structured_slots');
    expect(frozen?.structuredSlots).not.toBeNull();
    // Create freezes a runnable snapshot.
    const taskId = await createStructuredTask(service);
    const workspace = await service.getWorkspace(taskId);
    expect(workspace.task.status).toBe('ready');
    // start passes the readiness gate (the run then fails for a run-level
    // reason — no candidate — NEVER for TEMPLATE_RUNTIME_UNAVAILABLE).
    try {
      const summary = await service.scheduler.start(taskId);
      expect(['retryable_failure', 'interrupted', 'running', 'completed']).toContain(summary.status);
    } catch (error) {
      expect((error as { code?: string }).code).not.toBe('TEMPLATE_RUNTIME_UNAVAILABLE');
    }
    await service.shutdown();
  });
});
