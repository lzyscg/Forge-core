import { describe, expect, it } from 'vitest';
import type { InputField, TemplateDetail } from '../../shared/contracts';
import type { PublicCoreError } from '../../shared/errors';
import type { ForgeCoreGateway } from './forge-core-gateway';

/**
 * Shared behavior contract for every ForgeCoreGateway implementation.
 * Phase A runs it against the persistent MockGateway; Phase B runs the same
 * suite against HttpGateway over the real JSON API. Only public Gateway
 * behavior is asserted: no storage keys, no envelope internals, no
 * mock-only entry points.
 *
 * Factories may return a bare gateway (Phase A mock) or a fixture object
 * whose `dispose` releases per-case resources (Phase B spins up a fresh
 * server + temporary roots per case). Lifecycle assertions branch on the
 * first mutation outcome: implementations with a connected runtime keep the
 * full strict lifecycle assertions; while the runtime is not connected
 * (Phase B HTTP) every lifecycle mutation must at least reject with a
 * stable PublicCoreError after validating task existence. Mock behavior is
 * the strict oracle and stays unchanged.
 */

export interface GatewayContractFixture {
  gateway: ForgeCoreGateway;
  /** Releases fixture resources (server, temporary roots) after each case. */
  dispose?(): void | Promise<void>;
}

export type GatewayContractFactoryResult =
  | ForgeCoreGateway
  | GatewayContractFixture
  | Promise<ForgeCoreGateway | GatewayContractFixture>;

function isGateway(value: unknown): value is ForgeCoreGateway {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ForgeCoreGateway).listTemplates === 'function'
  );
}

async function settle<T>(
  promise: Promise<T>,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    await promise;
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function expectPublicCoreErrorShape(error: unknown): void {
  const candidate = (error ?? {}) as Partial<PublicCoreError>;
  expect(typeof candidate.code).toBe('string');
  expect((candidate.code ?? '').length).toBeGreaterThan(0);
  expect(typeof candidate.message).toBe('string');
  expect(candidate.location === null || typeof candidate.location === 'string').toBe(true);
  expect(candidate.action === null || typeof candidate.action === 'string').toBe(true);
}

async function expectPublicRejection(promise: Promise<void>): Promise<void> {
  const outcome = await settle(promise);
  if (outcome.ok) {
    expect.unreachable('expected the lifecycle mutation to reject');
  }
  expectPublicCoreErrorShape(outcome.error);
}

/**
 * Connected-runtime acceptance (Task 6): `start`/`resume` answer their 202
 * acceptance synchronously but keep the one-slot loop running in the
 * background, and seeding gives every started task a real first node to
 * process. A follow-up lifecycle probe issued while that loop still holds the
 * slot reads TASK_ALREADY_RUNNING instead of the projected-status conflict.
 * Poll a probe that is guaranteed to stay invalid for a `running` task
 * (`resume`) until the slot frees — bounded, so a wedged loop fails loud
 * instead of hanging. Implementations without a live loop (the mock) reject
 * with the invalid-transition code on the first probe and return at once.
 */
async function waitForSlotRelease(gateway: ForgeCoreGateway, taskId: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const probe = await settle(gateway.resumeTask(taskId));
    const code = probe.ok ? null : (probe.error as { code?: string } | undefined)?.code;
    if (code !== 'TASK_ALREADY_RUNNING') {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('waitForSlotRelease: the execution slot stayed busy beyond the bound');
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

/**
 * Waits (non-mutating, bounded) until a started/resumed task leaves the
 * transient `running` projection, then reports the rest status it settled
 * into. Live-loop implementations park seam-rested tasks `interrupted`
 * (visible parking — no silent running); loop-less implementations stay
 * `running` until the deadline and report that rest shape at once.
 */
async function waitForRest(gateway: ForgeCoreGateway, taskId: string): Promise<string> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const status = (await gateway.getWorkspace(taskId)).task.status;
    if (status !== 'running' || Date.now() > deadline) {
      return status;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

export function runForgeCoreGatewayContract(
  createGateway: () => GatewayContractFactoryResult,
): void {
  async function withGateway<T>(run: (gateway: ForgeCoreGateway) => Promise<T>): Promise<T> {
    const resolved = await createGateway();
    const fixture: GatewayContractFixture = isGateway(resolved)
      ? { gateway: resolved }
      : resolved;
    try {
      return await run(fixture.gateway);
    } finally {
      await fixture.dispose?.();
    }
  }

  async function loadFirstTemplate(gateway: ForgeCoreGateway): Promise<TemplateDetail> {
    const summaries = await gateway.listTemplates();
    expect(summaries.length).toBeGreaterThan(0);
    return gateway.getTemplate(summaries[0].id);
  }

  function inputWithRequiredFields(fields: InputField[]): Record<string, string> {
    const input: Record<string, string> = {};
    for (const field of fields) {
      if (field.required) input[field.id] = '契约套件示例输入';
    }
    return input;
  }

  describe('ForgeCoreGateway shared contract', () => {
    it('lists templates with structurally consistent summaries', async () => {
      await withGateway(async (gateway) => {
        const summaries = await gateway.listTemplates();
        expect(summaries.length).toBeGreaterThan(0);
        for (const summary of summaries) {
          expect(typeof summary.id).toBe('string');
          expect(summary.id.length).toBeGreaterThan(0);
          expect(typeof summary.name).toBe('string');
          expect(typeof summary.version).toBe('string');
          expect(typeof summary.agentCount).toBe('number');
          expect(['valid', 'invalid_using_cache']).toContain(summary.status);
          expect(typeof summary.updatedAt).toBe('string');
        }
      });
    });

    it('returns template detail and reloads it through the public interface', async () => {
      await withGateway(async (gateway) => {
        const summaries = await gateway.listTemplates();
        const summary = summaries[0];
        const detail = await gateway.getTemplate(summary.id);
        expect(detail.id).toBe(summary.id);
        expect(detail.name).toBe(summary.name);
        expect(detail.version).toBe(summary.version);
        expect(detail.agents.length).toBe(summary.agentCount);
        expect(Array.isArray(detail.inputFields)).toBe(true);
        expect(Array.isArray(detail.routes)).toBe(true);
        expect(typeof detail.finalOutput.format).toBe('string');

        const reloaded = await gateway.reloadTemplate(summary.id);
        expect(reloaded.id).toBe(detail.id);
        expect(reloaded.version).toBe(detail.version);
        expect(reloaded.status).toBe('valid');
      });
    });

    it('rejects unknown template ids with TEMPLATE_NOT_FOUND', async () => {
      await withGateway(async (gateway) => {
        await expect(gateway.getTemplate('template-missing')).rejects.toMatchObject({
          code: 'TEMPLATE_NOT_FOUND',
        });
        await expect(gateway.reloadTemplate('template-missing')).rejects.toMatchObject({
          code: 'TEMPLATE_NOT_FOUND',
        });
      });
    });

    it('creates a task from declared inputs and lists it', async () => {
      await withGateway(async (gateway) => {
        const detail = await loadFirstTemplate(gateway);
        const created = await gateway.createTask({
          templateId: detail.id,
          name: '契约套件任务',
          input: inputWithRequiredFields(detail.inputFields),
        });
        expect(created.id.length).toBeGreaterThan(0);
        expect(created.templateId).toBe(detail.id);
        expect(created.templateName).toBe(detail.name);
        expect(created.status).toBe('ready');
        expect(created.latestVersion).toBeNull();
        expect(created.currentAgentName).toBeNull();
        expect(created.diagnostic).toBeNull();
        expect(typeof created.updatedAt).toBe('string');

        const listed = await gateway.listTasks();
        expect(listed.map((task) => task.id)).toContain(created.id);
      });
    });

    it('rejects missing required and undeclared input fields with INVALID_INPUT', async () => {
      await withGateway(async (gateway) => {
        const detail = await loadFirstTemplate(gateway);
        const requiredFields = detail.inputFields.filter((field) => field.required);
        if (requiredFields.length > 0) {
          const incomplete = inputWithRequiredFields(detail.inputFields);
          delete incomplete[requiredFields[0].id];
          await expect(
            gateway.createTask({ templateId: detail.id, name: '契约套件任务', input: incomplete }),
          ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        }
        const withExtra = {
          ...inputWithRequiredFields(detail.inputFields),
          'undeclared-field': 'x',
        };
        await expect(
          gateway.createTask({ templateId: detail.id, name: '契约套件任务', input: withExtra }),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      });
    });

    it('rejects task creation against an unknown template with TEMPLATE_NOT_FOUND', async () => {
      await withGateway(async (gateway) => {
        await expect(
          gateway.createTask({ templateId: 'template-missing', name: '契约套件任务', input: {} }),
        ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
      });
    });

    it('exposes frozen input, agents and declared routes on a fresh workspace', async () => {
      await withGateway(async (gateway) => {
        const detail = await loadFirstTemplate(gateway);
        const input = inputWithRequiredFields(detail.inputFields);
        const created = await gateway.createTask({
          templateId: detail.id,
          name: '契约套件任务',
          input,
        });
        const workspace = await gateway.getWorkspace(created.id);
        expect(workspace.task.id).toBe(created.id);
        expect(workspace.task.status).toBe('ready');
        expect(workspace.frozenInput).toEqual(input);
        expect(workspace.templateVersion).toBe(detail.version);
        expect(workspace.agents).toEqual(detail.agents);
        expect(workspace.declaredRoutes).toEqual(detail.routes);
        expect(workspace.nodes).toEqual([]);
        expect(workspace.executedRoutes).toEqual([]);
        expect(workspace.artifacts).toEqual([]);
        expect(workspace.pendingHumanQuestion).toBeNull();
      });
    });

    it('rejects workspace lookup for unknown tasks with TASK_NOT_FOUND', async () => {
      await withGateway(async (gateway) => {
        await expect(gateway.getWorkspace('task-missing')).rejects.toMatchObject({
          code: 'TASK_NOT_FOUND',
        });
      });
    });

    it('guards lifecycle transitions with public error codes', async () => {
      await withGateway(async (gateway) => {
        const detail = await loadFirstTemplate(gateway);
        const created = await gateway.createTask({
          templateId: detail.id,
          name: '契约套件任务',
          input: inputWithRequiredFields(detail.inputFields),
        });

        await expect(gateway.startTask('task-missing')).rejects.toMatchObject({
          code: 'TASK_NOT_FOUND',
        });

        const started = await settle(gateway.startTask(created.id));
        if (!started.ok) {
          // Runtime not connected (Phase B HTTP): every lifecycle mutation
          // rejects with a stable public error after validating existence.
          expectPublicCoreErrorShape(started.error);
          await expectPublicRejection(gateway.stopTask(created.id));
          await expectPublicRejection(gateway.resumeTask(created.id));
          await expectPublicRejection(gateway.retryTask(created.id));
          await expectPublicRejection(gateway.answerHuman(created.id, '契约套件回答'));
          return;
        }

        // Live-loop implementations park the seam-rested task `interrupted`
        // (visible parking, no silent running); loop-less ones rest at
        // `running`. Both rest shapes keep every guard below honest.
        const restAfterStart = await waitForRest(gateway, created.id);
        expect(['running', 'interrupted']).toContain(restAfterStart);

        if (restAfterStart === 'running') {
          await expect(gateway.startTask(created.id)).rejects.toMatchObject({
            code: 'TASK_ALREADY_RUNNING',
          });
        } else {
          await expect(gateway.startTask(created.id)).rejects.toMatchObject({
            code: 'INVALID_TRANSITION',
          });
        }

        await gateway.stopTask(created.id);
        expect((await gateway.getWorkspace(created.id)).task.status).toBe('stopped');

        await gateway.resumeTask(created.id);
        const restAfterResume = await waitForRest(gateway, created.id);
        expect(['running', 'interrupted']).toContain(restAfterResume);

        if (restAfterResume === 'running') {
          // The acceptance loop may still hold the single slot while it settles
          // the seeded first node; wait for the release before pinning the
          // projected-status conflict (no-op for implementations without a loop).
          await waitForSlotRelease(gateway, created.id);

          await expect(gateway.resumeTask(created.id)).rejects.toMatchObject({
            code: 'INVALID_TRANSITION',
          });
        } else {
          // Parked at the committed boundary: retry/answer stay guarded while
          // resume remains the one legal lifecycle move.
          await expect(gateway.retryTask(created.id)).rejects.toMatchObject({
            code: 'INVALID_TRANSITION',
          });
          await expect(gateway.answerHuman(created.id, '契约套件回答')).rejects.toMatchObject({
            code: 'INVALID_TRANSITION',
          });
        }

        await gateway.stopTask(created.id);
        await expect(gateway.retryTask(created.id)).rejects.toMatchObject({
          code: 'INVALID_TRANSITION',
        });
        await expect(gateway.answerHuman(created.id, '契约套件回答')).rejects.toMatchObject({
          code: 'INVALID_TRANSITION',
        });
      });
    });

    it('guards structured human decisions like the plain answer path', async () => {
      await withGateway(async (gateway) => {
        const detail = await loadFirstTemplate(gateway);
        const created = await gateway.createTask({
          templateId: detail.id,
          name: '契约套件任务',
          input: inputWithRequiredFields(detail.inputFields),
        });
        // A ready task has no pending human request: every decision shape
        // rejects with a stable public error, never silently succeeding.
        await expectPublicRejection(
          gateway.submitHumanDecision(created.id, { decision: 'continue', text: '继续推进' }),
        );
        await expectPublicRejection(
          gateway.submitHumanDecision(created.id, { decision: 'accept', text: '授权提交' }),
        );
        await expectPublicRejection(gateway.submitHumanDecision(created.id, { decision: 'stop' }));
        await expect(gateway.submitHumanDecision('task-missing', { decision: 'stop' })).rejects.toMatchObject({
          code: 'TASK_NOT_FOUND',
        });
      });
    });

    it('starts with an empty artifact chain and no pending question', async () => {
      await withGateway(async (gateway) => {
        const detail = await loadFirstTemplate(gateway);
        const created = await gateway.createTask({
          templateId: detail.id,
          name: '契约套件任务',
          input: inputWithRequiredFields(detail.inputFields),
        });
        const workspace = await gateway.getWorkspace(created.id);
        expect(workspace.artifacts).toEqual([]);
        expect(workspace.task.latestVersion).toBeNull();
        expect(workspace.pendingHumanQuestion).toBeNull();
      });
    });

    it('notifies watchers on lifecycle changes and cleans unsubscribe', async () => {
      await withGateway(async (gateway) => {
        const detail = await loadFirstTemplate(gateway);
        const created = await gateway.createTask({
          templateId: detail.id,
          name: '契约套件任务',
          input: inputWithRequiredFields(detail.inputFields),
        });
        let notifications = 0;
        const unsubscribe = gateway.watchTask(created.id, () => {
          notifications += 1;
        });

        const started = await settle(gateway.startTask(created.id));
        if (!started.ok) {
          // No runtime means no state change can happen: no watcher fires,
          // and unsubscribe stays idempotent and silent.
          expectPublicCoreErrorShape(started.error);
          unsubscribe();
          unsubscribe();
          expect(notifications).toBe(0);
          return;
        }

        // Connected runtimes may notify asynchronously (the HTTP gateway
        // polls the workspace): wait bounded for the first observed change.
        const deadline = Date.now() + 4000;
        while (notifications === 0 && Date.now() < deadline) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        }
        expect(notifications).toBeGreaterThan(0);
        const afterStart = notifications;

        unsubscribe();
        unsubscribe();
        await gateway.stopTask(created.id);
        expect(notifications).toBe(afterStart);
      });
    });

    it('refuses to watch unknown tasks', async () => {
      await withGateway(async (gateway) => {
        try {
          gateway.watchTask('task-missing', () => {});
        } catch (error) {
          expect((error as { code?: unknown }).code).toBe('TASK_NOT_FOUND');
          return;
        }
        expect.unreachable('watchTask should throw for unknown task ids');
      });
    });

    it('clones a finished task as a fresh ready task on the same template', async () => {
      await withGateway(async (gateway) => {
        const detail = await loadFirstTemplate(gateway);
        const created = await gateway.createTask({
          templateId: detail.id,
          name: '契约套件任务',
          input: inputWithRequiredFields(detail.inputFields),
        });

        const clone = await gateway.cloneTask(created.id);
        expect(clone.id).not.toBe(created.id);
        expect(clone.status).toBe('ready');
        expect(clone.templateId).toBe(created.templateId);
        expect(clone.name.endsWith('（重跑）')).toBe(true);
        expect(clone.latestVersion).toBeNull();

        const listed = await gateway.listTasks();
        expect(listed.map((task) => task.id)).toContain(clone.id);
      });
    });

    it('rejects clone and display reads for unknown tasks or missing records', async () => {
      await withGateway(async (gateway) => {
        const detail = await loadFirstTemplate(gateway);
        const created = await gateway.createTask({
          templateId: detail.id,
          name: '契约套件任务',
          input: inputWithRequiredFields(detail.inputFields),
        });

        const missedClone = await settle(gateway.cloneTask('task-missing'));
        if (missedClone.ok) expect.unreachable('cloneTask should reject unknown task ids');
        expectPublicCoreErrorShape(missedClone.error);
        expect((missedClone.error as { code?: string }).code).toBe('TASK_NOT_FOUND');

        const missedTrace = await settle(gateway.getTurnTrace(created.id, 'turn-missing'));
        if (missedTrace.ok) expect.unreachable('getTurnTrace should reject unknown turn ids');
        expectPublicCoreErrorShape(missedTrace.error);
        expect((missedTrace.error as { code?: string }).code).toBe('TRACE_NOT_FOUND');

        const missedSkill = await settle(gateway.getSkillContent(created.id, 'skill-missing'));
        if (missedSkill.ok) expect.unreachable('getSkillContent should reject unknown skill ids');
        expectPublicCoreErrorShape(missedSkill.error);
        expect((missedSkill.error as { code?: string }).code).toBe('SKILL_NOT_FOUND');
      });
    });

    it('deletes a task permanently and rejects unknown task ids', async () => {
      await withGateway(async (gateway) => {
        const detail = await loadFirstTemplate(gateway);
        const created = await gateway.createTask({
          templateId: detail.id,
          name: '契约套件任务',
          input: inputWithRequiredFields(detail.inputFields),
        });

        await gateway.deleteTask(created.id);
        expect((await gateway.listTasks()).map((task) => task.id)).not.toContain(created.id);
        await expect(gateway.getWorkspace(created.id)).rejects.toMatchObject({
          code: 'TASK_NOT_FOUND',
        });
        // Deletion is irreversible and not idempotent: a second delete misses.
        await expect(gateway.deleteTask(created.id)).rejects.toMatchObject({
          code: 'TASK_NOT_FOUND',
        });
        await expect(gateway.deleteTask('task-missing')).rejects.toMatchObject({
          code: 'TASK_NOT_FOUND',
        });
      });
    });
  });
}
