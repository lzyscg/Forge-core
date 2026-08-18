// @vitest-environment node
/**
 * CoreService v2 scheduling driver regression coverage.
 *
 * A retryable real-runtime failure writes a durable retry_due wakeup. The
 * service must consume that wakeup after the lifecycle request has returned;
 * otherwise a task remains projected as running forever until a restart.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CoreService } from './core-service';
import { RuntimeFailure } from './runtime/agent-runtime';
import { FakeAgentRuntime } from './runtime/fake-agent-runtime';
import { disposeAllTestRoots, makeTempCorePaths } from './test-support';
import { createTestRuntimeEnvironment } from './structured-slots/runtime-capability';
import { createAuthoritativeReviewTestEnvironment } from './structured-slots/test-support/authoritative-review-test-registry';
import { STORAGE_ERROR_CODES, StorageError } from './storage/atomic-file';

afterEach(() => disposeAllTestRoots());

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true before timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('CoreService v2 scheduling driver', () => {
  it('keeps one failed startup successor reconciliation isolated from healthy tasks', async () => {
    const roots = makeTempCorePaths('forge-core-v2-startup-isolation-');
    cpSync(
      fileURLToPath(new URL('./template/__fixtures__/authoritative-valid', import.meta.url)),
      join(roots.templateRoot, 'authoritative-valid'),
      { recursive: true },
    );
    const environment = createAuthoritativeReviewTestEnvironment();
    const seed = new CoreService(roots.paths, {
      runtime: new FakeAgentRuntime(),
      runtimeEnvironment: createTestRuntimeEnvironment(),
      authoritativeReviewEnvironment: environment,
    });
    await seed.initialize();
    const badTask = await seed.createTask({
      templateId: 'authoritative-valid',
      name: 'corrupt startup task',
      input: { 'source-text': 'neutral source' },
    });
    const healthyTask = await seed.createTask({
      templateId: 'authoritative-valid',
      name: 'healthy startup task',
      input: { 'source-text': 'neutral source' },
    });
    await seed.v2Lifecycle.startV2(badTask.id, {
      operationId: randomUUID(),
      userInputText: '',
    });
    const leased = await seed.v2Scheduling.runPass(new Date().toISOString());
    expect(leased.leased).toHaveLength(1);
    await seed.shutdown();

    const service = new CoreService(roots.paths, {
      runtime: new FakeAgentRuntime(),
      runtimeEnvironment: createTestRuntimeEnvironment(),
      authoritativeReviewEnvironment: environment,
      enableV2SchedulingDriver: true,
    });
    const internals = service as unknown as {
      v2Composition: { prepareSuccessors(taskId: string): Promise<void> };
      v2Wakeups: { read(taskId: string): Promise<unknown[]> };
    };
    const originalPrepare = internals.v2Composition.prepareSuccessors.bind(internals.v2Composition);
    internals.v2Composition.prepareSuccessors = async (taskId) => {
      if (taskId === badTask.id) {
        throw new StorageError(
          STORAGE_ERROR_CODES.TASK_CORRUPTED,
          'simulated corrupt successor state',
        );
      }
      await originalPrepare(taskId);
    };

    await expect(service.initialize()).resolves.toBeUndefined();
    expect((await service.getWorkspace(healthyTask.id)).task.id).toBe(healthyTask.id);
    expect(await internals.v2Wakeups.read(badTask.id)).toEqual([]);
    await service.shutdown();
  });

  it('continues a retryable v2 work item from its durable retry_due wakeup', async () => {
    const roots = makeTempCorePaths('forge-core-v2-driver-');
    cpSync(
      fileURLToPath(new URL('./template/__fixtures__/authoritative-valid', import.meta.url)),
      join(roots.templateRoot, 'authoritative-valid'),
      { recursive: true },
    );
    const runtime = new FakeAgentRuntime({
      scripts: {
        structure: [
          { kind: 'failure', failure: RuntimeFailure.transient('PROVIDER_ERROR', 'first attempt') },
          { kind: 'failure', failure: RuntimeFailure.transient('PROVIDER_ERROR', 'second attempt') },
        ],
      },
    });
    const service = new CoreService(roots.paths, {
      runtime,
      runtimeEnvironment: createTestRuntimeEnvironment(),
      authoritativeReviewEnvironment: createAuthoritativeReviewTestEnvironment(),
      enableV2SchedulingDriver: true,
    });
    await service.initialize();

    try {
      const task = await service.createTask({
        templateId: 'authoritative-valid',
        name: 'v2 scheduling driver',
        input: { 'source-text': 'neutral source' },
      });
      await service.startTaskV2(task.id);

      await waitFor(() => runtime.countInvocations('structure') >= 2);
      expect(runtime.countInvocations('structure')).toBeGreaterThanOrEqual(2);
    } finally {
      await service.shutdown();
    }
  });
});
