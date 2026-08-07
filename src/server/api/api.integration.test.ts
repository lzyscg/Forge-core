// @vitest-environment node
/**
 * JSON API integration tests (plan Phase B Task 5; lifecycle upgraded in
 * Phase C Task 4).
 *
 * Boots the real test-mode server over fresh temporary roots with one valid
 * fixture template installed and drives the HTTP surface end to end. Routes
 * only ever talk to the CoreService; these tests pin the exact route table,
 * the stable error-code → status mapping, the 1 MiB body limit, the
 * unknown-field rejection, the real scheduler-backed lifecycle semantics
 * (the Phase B RUNTIME_NOT_CONNECTED placeholder is gone: the test server
 * injects the deterministic FakeAgentRuntime) and the secret-free error
 * envelope (iron rule 6).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ArtifactVersion,
  TaskSummary,
  TaskWorkspace,
  TemplateDetail,
  TemplateSummary,
} from '../../shared/contracts';
import { CoreService } from '../core-service';
import { createForgeCoreServer } from '../http-server';
import { CorePaths } from '../storage/core-paths';
import { FakeAgentRuntime } from '../runtime/fake-agent-runtime';
import { createDeferred } from '../runtime/test-support';
import {
  disposeAllTestRoots,
  downgradeTaskSnapshotToLegacy,
  installValidFixtureTemplate,
  makeEventNode,
  makeTaskEvent,
  ONE_TEMPLATE_ID,
  startApiTestClient,
  validTaskRequest,
  type ApiTestResponse,
} from '../test-support';

afterEach(() => {
  disposeAllTestRoots();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Collects every nested string of a JSON body for secret scanning. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out);
  }
  return out;
}

function expectPublicErrorEnvelope(response: ApiTestResponse, code: string): void {
  const body = response.body as {
    error?: { code?: unknown; message?: unknown; location?: unknown; action?: unknown };
  };
  expect(body.error, 'response must carry the public error envelope').toBeDefined();
  expect(body.error?.code).toBe(code);
  expect(typeof body.error?.message).toBe('string');
  expect(body.error?.location === null || typeof body.error?.location === 'string').toBe(true);
  expect(body.error?.action === null || typeof body.error?.action === 'string').toBe(true);
}

async function createValidTask(
  client: Awaited<ReturnType<typeof startApiTestClient>>,
): Promise<TaskSummary> {
  const created = await client.post('/api/tasks', validTaskRequest());
  expect(created.status).toBe(200);
  return created.body as TaskSummary;
}

describe('typed JSON API', () => {
  it('creates a task and returns a template-defined workspace', async () => {
    const client = await startApiTestClient();
    const created = await client.post('/api/tasks', validTaskRequest());
    expect(created.status).toBe(200);
    const task = created.body as TaskSummary;
    expect(task.id.length).toBeGreaterThan(0);
    expect(task.templateId).toBe(ONE_TEMPLATE_ID);
    expect(task.status).toBe('ready');

    const response = await client.get(`/api/tasks/${task.id}/workspace`);
    expect(response.status).toBe(200);
    const workspace = response.body as TaskWorkspace;
    expect(workspace.agents.map((agent) => agent.name)).toEqual(['初稿 Agent', '审核 Agent']);
    expect(workspace.frozenInput).toEqual(validTaskRequest().input);
    expect(workspace.nodes).toEqual([]);
    expect(workspace.artifacts).toEqual([]);

    // The workspace reports the same display version as the template detail.
    const detail = (await client.get(`/api/templates/${ONE_TEMPLATE_ID}`)).body as TemplateDetail;
    expect(workspace.templateVersion).toBe(detail.version);
    expect(workspace.templateVersion).toMatch(/^[0-9a-f]{12}$/);
    await client.close();
  });

  it('lists templates and serves detail plus explicit reload', async () => {
    const client = await startApiTestClient();
    const list = await client.get('/api/templates');
    expect(list.status).toBe(200);
    const summaries = list.body as TemplateSummary[];
    expect(summaries.map((summary) => summary.id)).toEqual([ONE_TEMPLATE_ID]);

    const detail = await client.get(`/api/templates/${ONE_TEMPLATE_ID}`);
    expect(detail.status).toBe(200);
    expect((detail.body as TemplateDetail).agents).toHaveLength(2);

    const reloaded = await client.request('POST', `/api/templates/${ONE_TEMPLATE_ID}/reload`);
    expect(reloaded.status).toBe(200);
    expect((reloaded.body as TemplateDetail).status).toBe('valid');
    expect((reloaded.body as TemplateDetail).version).toBe((detail.body as TemplateDetail).version);
    await client.close();
  });

  it('rejects unknown template ids with TEMPLATE_NOT_FOUND', async () => {
    const client = await startApiTestClient();
    const missing = await client.get('/api/templates/template-missing');
    expect(missing.status).toBe(404);
    expectPublicErrorEnvelope(missing, 'TEMPLATE_NOT_FOUND');

    const reload = await client.request('POST', '/api/templates/template-missing/reload');
    expect(reload.status).toBe(404);
    expectPublicErrorEnvelope(reload, 'TEMPLATE_NOT_FOUND');

    const create = await client.post('/api/tasks', validTaskRequest('template-missing'));
    expect(create.status).toBe(404);
    expectPublicErrorEnvelope(create, 'TEMPLATE_NOT_FOUND');
    await client.close();
  });

  it('rejects unknown fields and malformed create bodies with INVALID_INPUT', async () => {
    const client = await startApiTestClient();

    const unknownTopLevel = await client.post('/api/tasks', {
      ...validTaskRequest(),
      extra: true,
    });
    expect(unknownTopLevel.status).toBe(400);
    expectPublicErrorEnvelope(unknownTopLevel, 'INVALID_INPUT');

    const nonStringInput = await client.post('/api/tasks', {
      ...validTaskRequest(),
      input: { 'source-material': 42 },
    });
    expect(nonStringInput.status).toBe(400);
    expectPublicErrorEnvelope(nonStringInput, 'INVALID_INPUT');

    const missingRequired = await client.post('/api/tasks', {
      templateId: ONE_TEMPLATE_ID,
      name: '缺字段任务',
      input: {},
    });
    expect(missingRequired.status).toBe(400);
    expectPublicErrorEnvelope(missingRequired, 'INVALID_INPUT');

    const malformed = await client.request('POST', '/api/tasks', { raw: '{not-json' });
    expect(malformed.status).toBe(400);
    expectPublicErrorEnvelope(malformed, 'INVALID_INPUT');

    const empty = await client.request('POST', '/api/tasks', { raw: '' });
    expect(empty.status).toBe(400);
    expectPublicErrorEnvelope(empty, 'INVALID_INPUT');
    await client.close();
  });

  it('enforces the 1 MiB JSON body limit', async () => {
    const client = await startApiTestClient();
    // Exactly 1 MiB of JSON is still accepted (it fails validation, not size).
    const exactPadding = 'x'.repeat(1_048_576 - '{"pad":""}'.length);
    const exact = await client.request('POST', '/api/tasks', {
      raw: JSON.stringify({ pad: exactPadding }),
    });
    expect(exact.status).toBe(400);
    expectPublicErrorEnvelope(exact, 'INVALID_INPUT');

    const oversized = await client.request('POST', '/api/tasks', {
      raw: JSON.stringify({ pad: `${exactPadding}!` }),
    });
    expect(oversized.status).toBe(413);
    expectPublicErrorEnvelope(oversized, 'PAYLOAD_TOO_LARGE');
    await client.close();
  });

  it('answers unlisted methods with 405 and an Allow header', async () => {
    const client = await startApiTestClient();
    const task = await createValidTask(client);

    const deleteLifecycle = await client.request('DELETE', `/api/tasks/${task.id}/start`);
    expect(deleteLifecycle.status).toBe(405);
    expect(deleteLifecycle.headers.get('allow')).toBe('POST');
    expectPublicErrorEnvelope(deleteLifecycle, 'METHOD_NOT_ALLOWED');

    const postTemplates = await client.request('POST', '/api/templates');
    expect(postTemplates.status).toBe(405);
    expect(postTemplates.headers.get('allow')).toBe('GET');

    const getLifecycle = await client.get(`/api/tasks/${task.id}/start`);
    expect(getLifecycle.status).toBe(405);
    expect(getLifecycle.headers.get('allow')).toBe('POST');

    const putHealth = await client.request('PUT', '/api/health');
    expect(putHealth.status).toBe(405);
    expect(putHealth.headers.get('allow')).toBe('GET');
    await client.close();
  });

  it('answers unknown api paths with a public NOT_FOUND envelope', async () => {
    const client = await startApiTestClient();
    const response = await client.get('/api/does-not-exist');
    expect(response.status).toBe(404);
    expectPublicErrorEnvelope(response, 'NOT_FOUND');
    await client.close();
  });

  it('drives real lifecycle transitions through the scheduler', async () => {
    // Scripted deterministic rest states: the first Turn gates on a deferred
    // (the slot stays busy for the conflict probe), then interrupts for a
    // human answer; after stop+resume nothing is pending, so the loop
    // quiesces with the task projected `running`.
    const deferred = createDeferred<void>();
    const runtime = new FakeAgentRuntime({
      scripts: {
        writer: [
          {
            kind: 'result',
            publicText: '需要确认',
            deferred,
            actions: [{ type: 'request_human_input', question: '是否继续？' }],
          },
        ],
      },
    });
    const client = await startApiTestClient({ runtime });
    const task = await createValidTask(client);

    // Task 5: start/resume/retry/answer are accepted asynchronously (202) —
    // validation stays synchronous, the loop continues in the background.
    const started = await client.request('POST', `/api/tasks/${task.id}/start`);
    expect(started.status).toBe(202);
    expect((started.body as TaskSummary).status).toBe('running');

    const again = await client.request('POST', `/api/tasks/${task.id}/start`);
    expect(again.status).toBe(409);
    expectPublicErrorEnvelope(again, 'TASK_ALREADY_RUNNING');

    deferred.resolve(); // let the gated Turn commit (waiting_human)

    // Wait for the resolved Turn to land before stopping, so the stop sees a
    // settled waiting task instead of racing the in-flight commit.
    const waitDeadline = Date.now() + 5000;
    let preStop = (await client.get(`/api/tasks/${task.id}/workspace`)).body as TaskWorkspace;
    while (preStop.task.status !== 'waiting_human') {
      if (Date.now() > waitDeadline) {
        throw new Error('the gated Turn did not reach waiting_human within 5 s');
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      preStop = (await client.get(`/api/tasks/${task.id}/workspace`)).body as TaskWorkspace;
    }

    const stopped = await client.request('POST', `/api/tasks/${task.id}/stop`);
    expect(stopped.status).toBe(200);
    expect((stopped.body as TaskSummary).status).toBe('stopped');

    const resumed = await client.request('POST', `/api/tasks/${task.id}/resume`);
    expect(resumed.status).toBe(202);
    // Resuming over the unanswered human question returns the task to
    // waiting_human (plan 2026-08-06): the loop never runs a Turn while a
    // question is pending, and `answer` must stay reachable.
    expect((resumed.body as TaskSummary).status).toBe('waiting_human');

    // The 202 acceptance keeps the one-slot loop running in the background;
    // retry probes the slot until it frees and then pins the projected-status
    // conflict instead of the busy-slot conflict.
    const retryDeadline = Date.now() + 5000;
    let retried = await client.request('POST', `/api/tasks/${task.id}/retry`);
    while (
      retried.status === 409 &&
      (retried.body as { error?: { code?: string } })?.error?.code === 'TASK_ALREADY_RUNNING'
    ) {
      if (Date.now() > retryDeadline) {
        throw new Error('the execution slot stayed busy beyond the bound');
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      retried = await client.request('POST', `/api/tasks/${task.id}/retry`);
    }
    expect(retried.status).toBe(409);
    expectPublicErrorEnvelope(retried, 'INVALID_TRANSITION');

    for (const action of ['start', 'stop', 'resume', 'retry']) {
      const response = await client.request('POST', `/api/tasks/task-missing/${action}`);
      expect(response.status, action).toBe(404);
      expectPublicErrorEnvelope(response, 'TASK_NOT_FOUND');
    }
    await client.close();
  });

  it('accepts exactly { answer } on the answer route', async () => {
    const client = await startApiTestClient();
    const task = await createValidTask(client);

    const extraField = await client.request('POST', `/api/tasks/${task.id}/answer`, {
      json: { answer: '回答', extra: 1 },
    });
    expect(extraField.status).toBe(400);
    expectPublicErrorEnvelope(extraField, 'INVALID_INPUT');

    const emptyAnswer = await client.request('POST', `/api/tasks/${task.id}/answer`, {
      json: { answer: '' },
    });
    expect(emptyAnswer.status).toBe(400);
    expectPublicErrorEnvelope(emptyAnswer, 'INVALID_INPUT');

    const unknownTask = await client.request('POST', '/api/tasks/task-missing/answer', {
      json: { answer: '回答' },
    });
    expect(unknownTask.status).toBe(404);
    expectPublicErrorEnvelope(unknownTask, 'TASK_NOT_FOUND');

    const accepted = await client.request('POST', `/api/tasks/${task.id}/answer`, {
      json: { answer: '回答' },
    });
    // Real scheduler semantics: a ready task has no pending human request.
    expect(accepted.status).toBe(409);
    expectPublicErrorEnvelope(accepted, 'INVALID_TRANSITION');
    await client.close();
  });

  it('accepts the structured decision body on the answer route (spec §11.5)', async () => {
    const client = await startApiTestClient();
    const task = await createValidTask(client);

    // Unknown decision value rejected at the schema gate.
    const badDecision = await client.request('POST', `/api/tasks/${task.id}/answer`, {
      json: { decision: 'nope' },
    });
    expect(badDecision.status).toBe(400);
    expectPublicErrorEnvelope(badDecision, 'INVALID_INPUT');

    // Unknown field on a structured body rejected (additionalProperties: false).
    const extraField = await client.request('POST', `/api/tasks/${task.id}/answer`, {
      json: { decision: 'continue', text: '引导', extra: 1 },
    });
    expect(extraField.status).toBe(400);
    expectPublicErrorEnvelope(extraField, 'INVALID_INPUT');

    // All three structured decisions pass schema validation; a ready task has
    // no pending human request, so the scheduler rejects with INVALID_TRANSITION
    // (proving the body reached the scheduler, not the schema gate).
    for (const body of [
      { decision: 'continue', text: '请继续' },
      { decision: 'accept', text: '授权提交' },
      { decision: 'stop' },
    ]) {
      const res = await client.request('POST', `/api/tasks/${task.id}/answer`, { json: body });
      expect(res.status).toBe(409);
      expectPublicErrorEnvelope(res, 'INVALID_TRANSITION');
    }

    // The workspace exposes the pending human source (null when none pending).
    const workspace = await client.request('GET', `/api/tasks/${task.id}/workspace`);
    expect(workspace.status).toBe(200);
    expect((workspace.body as { pendingHumanSource: string | null }).pendingHumanSource).toBeNull();
    await client.close();
  });

  it('surfaces damaged tasks as TASK_CORRUPTED without breaking listings', async () => {
    const client = await startApiTestClient();
    const task = await createValidTask(client);
    writeFileSync(join(client.dataRoot, 'tasks', task.id, 'task.json'), '{corrupted');

    const workspace = await client.get(`/api/tasks/${task.id}/workspace`);
    expect(workspace.status).toBe(422);
    expectPublicErrorEnvelope(workspace, 'TASK_CORRUPTED');

    const lifecycle = await client.request('POST', `/api/tasks/${task.id}/start`);
    expect(lifecycle.status).toBe(422);
    expectPublicErrorEnvelope(lifecycle, 'TASK_CORRUPTED');

    const list = await client.get('/api/tasks');
    expect(list.status).toBe(200);
    const summaries = list.body as TaskSummary[];
    expect(summaries.find((summary) => summary.id === task.id)?.status).toBe('corrupt');
    await client.close();
  });

  it('serves one committed artifact version through the reserved route', async () => {
    const client = await startApiTestClient();
    const task = await createValidTask(client);
    await client.service.publishTestArtifact(task.id, {
      title: '版本一',
      files: [{ name: 'content.md', content: 'first' }],
      sourceNodeId: 'node-a',
      format: 'markdown',
    });

    const response = await client.get(`/api/tasks/${task.id}/artifacts/1`);
    expect(response.status).toBe(200);
    const artifact = response.body as ArtifactVersion;
    expect(artifact.version).toBe(1);
    expect(artifact.files[0].content).toBe('first');
    expect(artifact.final).toBe(false);

    const missing = await client.get(`/api/tasks/${task.id}/artifacts/2`);
    expect(missing.status).toBe(404);
    expectPublicErrorEnvelope(missing, 'ARTIFACT_VERSION_NOT_FOUND');

    const invalid = await client.get(`/api/tasks/${task.id}/artifacts/0`);
    expect(invalid.status).toBe(400);
    expectPublicErrorEnvelope(invalid, 'INVALID_INPUT');
    await client.close();
  });

  it('maps unknown causes to INTERNAL_ERROR and logs only code plus correlation id', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secretMessage = 'raw cause with /absolute/path and credential-shaped text';
    const client = await startApiTestClient({
      decorateService: (service) =>
        new Proxy(service, {
          get(target, prop, receiver) {
            if (prop === 'getWorkspace') {
              return () => {
                throw new Error(secretMessage);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as CoreService,
    });
    const task = await createValidTask(client);

    const response = await client.get(`/api/tasks/${task.id}/workspace`);
    expect(response.status).toBe(500);
    expectPublicErrorEnvelope(response, 'INTERNAL_ERROR');
    expect(collectStrings(response.body).join('\n')).not.toContain(secretMessage);

    const logs = spy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logs).toContain('INTERNAL_ERROR');
    expect(logs).toMatch(/correlation=[0-9a-f-]{36}/);
    expect(logs).not.toContain(secretMessage);
    await client.close();
  });

  it('never echoes request headers, environment values or raw secrets in responses', async () => {
    const sentinel = 'sentinel-secret-value-0987654321';
    process.env.FORGE_CORE_SENTINEL_SECRET = sentinel;
    try {
      const client = await startApiTestClient();
      const headers = { authorization: `Bearer ${sentinel}` };
      const responses: ApiTestResponse[] = [];

      responses.push(await client.get('/api/does-not-exist', { headers })); // 404
      responses.push(await client.request('DELETE', '/api/tasks', { headers })); // 405
      responses.push(await client.request('POST', '/api/tasks', { raw: '{broken', headers })); // 400
      responses.push(
        await client.post(
          '/api/tasks',
          { ...validTaskRequest(), extra: true },
          { headers },
        ),
      ); // 400 unknown field
      responses.push(await client.get('/api/tasks/task-missing/workspace', { headers })); // 404
      responses.push(await client.post('/api/tasks/task-missing/start', undefined, { headers })); // 404
      responses.push(await client.get('/api/templates/template-missing', { headers })); // 404

      const task = await createValidTask(client);
      responses.push(await client.post(`/api/tasks/${task.id}/start`, undefined, { headers })); // 202
      responses.push(
        await client.request('POST', `/api/tasks/${task.id}/answer`, {
          json: { answer: '回答', extra: 1 },
          headers,
        }),
      ); // 400
      responses.push(
        await client.request('POST', '/api/tasks', {
          raw: JSON.stringify({ pad: 'x'.repeat(1_048_576 + 64) }),
          headers,
        }),
      ); // 413
      writeFileSync(join(client.dataRoot, 'tasks', task.id, 'task.json'), '{corrupted');
      responses.push(await client.get(`/api/tasks/${task.id}/workspace`, { headers })); // 422

      for (const response of responses) {
        const scanned = collectStrings(response.body).join('\n');
        expect(scanned, `status ${response.status}`).not.toContain(sentinel);
        expect(scanned, `status ${response.status}`).not.toContain('Bearer');
        expect(scanned, `status ${response.status}`).not.toContain('FORGE_CORE_SENTINEL_SECRET');
        expect(scanned, `status ${response.status}`).not.toContain('authorization');
      }
      await client.close();
    } finally {
      delete process.env.FORGE_CORE_SENTINEL_SECRET;
    }
  });
});

describe('Phase E Task 3: trace, skill content and clone routes (plan Task E3 Step 1)', () => {
  it('serves one committed turn trace and maps misses to TRACE_NOT_FOUND', async () => {
    const client = await startApiTestClient();
    const task = await createValidTask(client);
    await client.service.traces.appendTurnTrace(task.id, 'turn-1', [
      { kind: 'text', text: '正文。' },
    ]);

    const found = await client.get(`/api/tasks/${task.id}/trace/turn-1`);
    expect(found.status).toBe(200);
    expect(found.body).toEqual({
      turnId: 'turn-1',
      entries: [{ kind: 'text', text: '正文。' }],
    });

    const missing = await client.get(`/api/tasks/${task.id}/trace/turn-missing`);
    expect(missing.status).toBe(404);
    expectPublicErrorEnvelope(missing, 'TRACE_NOT_FOUND');

    const unknownTask = await client.get('/api/tasks/task-missing/trace/turn-1');
    expect(unknownTask.status).toBe(404);
    expectPublicErrorEnvelope(unknownTask, 'TASK_NOT_FOUND');

    const method = await client.request('POST', `/api/tasks/${task.id}/trace/turn-1`);
    expect(method.status).toBe(405);
    expect(method.headers.get('allow')).toBe('GET');
    await client.close();
  });

  it('passes the display-only phase through the trace route (plan 2026-08-04 Task 5)', async () => {
    const client = await startApiTestClient();
    const task = await createValidTask(client);
    await client.service.traces.appendTurnTrace(
      task.id,
      'turn-phased',
      [{ kind: 'text', text: '正文。' }],
      { state: 'dispatched', dispatchAction: 'publish_artifact', target: null, message: null },
    );
    await client.service.traces.appendTurnTrace(task.id, 'turn-failed', [], {
      state: 'failed',
      dispatchAction: null,
      target: null,
      message: '阶段未完成。',
    });

    const phased = await client.get(`/api/tasks/${task.id}/trace/turn-phased`);
    expect(phased.status).toBe(200);
    expect(phased.body).toEqual({
      turnId: 'turn-phased',
      phase: { state: 'dispatched', dispatchAction: 'publish_artifact', target: null, message: null },
      entries: [{ kind: 'text', text: '正文。' }],
    });

    // Failure paths may carry a phase with zero entries.
    const failed = await client.get(`/api/tasks/${task.id}/trace/turn-failed`);
    expect(failed.status).toBe(200);
    expect(failed.body).toEqual({
      turnId: 'turn-failed',
      phase: { state: 'failed', dispatchAction: null, target: null, message: '阶段未完成。' },
      entries: [],
    });
    await client.close();
  });

  it('serves one snapshot skill and maps misses to SKILL_NOT_FOUND', async () => {
    const client = await startApiTestClient();
    const task = await createValidTask(client);

    const found = await client.get(`/api/tasks/${task.id}/skills/style-guide`);
    expect(found.status).toBe(200);
    const skill = found.body as { skillId?: unknown; content?: unknown; versionHash?: unknown };
    expect(skill.skillId).toBe('style-guide');
    expect(typeof skill.content).toBe('string');
    expect((skill.content as string).length).toBeGreaterThan(0);
    expect(skill.versionHash).toMatch(/^[0-9a-f]{64}$/);

    const missing = await client.get(`/api/tasks/${task.id}/skills/ghost-skill`);
    expect(missing.status).toBe(404);
    expectPublicErrorEnvelope(missing, 'SKILL_NOT_FOUND');

    const unknownTask = await client.get('/api/tasks/task-missing/skills/style-guide');
    expect(unknownTask.status).toBe(404);
    expectPublicErrorEnvelope(unknownTask, 'TASK_NOT_FOUND');
    await client.close();
  });

  it('clones a task with the rerun suffix over HTTP', async () => {
    const client = await startApiTestClient();
    const task = await createValidTask(client);

    const cloned = await client.request('POST', `/api/tasks/${task.id}/clone`);
    expect(cloned.status).toBe(200);
    const summary = cloned.body as TaskSummary & { templateVersion?: unknown };
    expect(summary.id).not.toBe(task.id);
    expect(summary.name).toBe('冻结任务（重跑）');
    expect(summary.status).toBe('ready');
    expect(summary.templateId).toBe(task.templateId);
    expect(summary).not.toHaveProperty('templateVersion');

    const missing = await client.request('POST', '/api/tasks/task-missing/clone');
    expect(missing.status).toBe(404);
    expectPublicErrorEnvelope(missing, 'TASK_NOT_FOUND');
    await client.close();
  });

  it('maps a corrupt source task to TASK_CORRUPTED on clone', async () => {
    const client = await startApiTestClient();
    const task = await createValidTask(client);
    writeFileSync(join(client.dataRoot, 'tasks', task.id, 'task.json'), '{corrupted');

    const corrupted = await client.request('POST', `/api/tasks/${task.id}/clone`);
    expect(corrupted.status).toBe(422);
    expectPublicErrorEnvelope(corrupted, 'TASK_CORRUPTED');
    await client.close();
  });
});

/* Phase C Task 5: asynchronous lifecycle acceptance + startup recovery.
 * These tests boot real servers over hand-built temporary roots (not the
 * shared startApiTestClient fixture) so a scripted deferred runtime and a
 * simulated process restart can exercise the exact production boot path. */

const manualRoots: string[] = [];

function manualTempRoots(): { dataRoot: string; templateRoot: string } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'forge-core-api-task5-data-'));
  const templateRoot = mkdtempSync(join(tmpdir(), 'forge-core-api-task5-templates-'));
  manualRoots.push(dataRoot, templateRoot);
  installValidFixtureTemplate(templateRoot);
  return { dataRoot, templateRoot };
}

afterEach(() => {
  while (manualRoots.length > 0) {
    const root = manualRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

async function bootTestServer(
  roots: { dataRoot: string; templateRoot: string },
  runtime: FakeAgentRuntime,
): Promise<{ baseUrl: string; service: CoreService; close(): Promise<void> }> {
  const service = new CoreService(CorePaths.create(roots), { runtime });
  await service.initialize();
  const server = await createForgeCoreServer({
    mode: 'test',
    dataRoot: roots.dataRoot,
    templateRoot: roots.templateRoot,
    coreService: service,
  });
  const baseUrl = await server.listen(0);
  return { baseUrl, service, close: () => server.close() };
}

async function createTaskOverHttp(baseUrl: string): Promise<TaskSummary> {
  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validTaskRequest()),
  });
  return (await response.json()) as TaskSummary;
}

describe('Phase C Task 5: asynchronous lifecycle acceptance (plan Task 5 Step 6)', () => {
  it('accepts start with 202 while the background loop is still in flight', async () => {
    const roots = manualTempRoots();
    const deferred = createDeferred<void>();
    const runtime = new FakeAgentRuntime({
      scripts: {
        writer: [
          {
            kind: 'result',
            publicText: '后台完成',
            deferred,
            actions: [
              {
                type: 'finish_production',
                source: 'inline',
                files: [{ name: 'content.md', content: '初稿正文' }],
                format: 'markdown',
                artifactType: '终稿',
                title: '初稿 V1',
              },
              { type: 'publish_artifact' },
            ],
          },
        ],
        // The reviewer Turn gates forever: after the writer result lands the
        // loop reaches this Turn and rests, keeping the task `running`.
        reviewer: [{ kind: 'result', publicText: '审核中', deferred: createDeferred<void>() }],
      },
    });
    const { baseUrl, service, close } = await bootTestServer(roots, runtime);
    try {
      const task = await createTaskOverHttp(baseUrl);
      await service.appendTestEvent(
        task.id,
        makeTaskEvent({
          type: 'agent_input',
          node: makeEventNode({ agentId: 'writer', kind: 'input', title: '输入', body: '开始' }),
        }),
      );

      const accepted = await fetch(`${baseUrl}/api/tasks/${task.id}/start`, { method: 'POST' });
      expect(accepted.status).toBe(202);
      const acceptedSummary = (await accepted.json()) as TaskSummary;
      expect(acceptedSummary.status).toBe('running');
      // The 202 returned while the scripted Turn is still gated on `deferred`
      // (never resolved at this point): had the route blocked on the loop it
      // could not have answered at all. That is the async-acceptance proof.

      // Wait for the background loop to reach the gated Turn.
      const turnDeadline = Date.now() + 2000;
      while (runtime.countInvocations('writer') === 0) {
        if (Date.now() > turnDeadline) {
          throw new Error('the background loop did not start the Turn within 2 s');
        }
        await new Promise((wait) => setTimeout(wait, 10));
      }
      expect(runtime.countInvocations('writer')).toBe(1);
      const inflight = (await (
        await fetch(`${baseUrl}/api/tasks/${task.id}/workspace`)
      ).json()) as TaskWorkspace;
      expect(inflight.nodes.some((node) => node.kind === 'result')).toBe(false);

      deferred.resolve();
      let workspace = inflight;
      const deadline = Date.now() + 2000;
      while (!workspace.nodes.some((node) => node.kind === 'result')) {
        if (Date.now() > deadline) {
          throw new Error('the background loop did not commit the result within 2 s');
        }
        await new Promise((wait) => setTimeout(wait, 20));
        workspace = (await (
          await fetch(`${baseUrl}/api/tasks/${task.id}/workspace`)
        ).json()) as TaskWorkspace;
      }
      // The publish routed a reviewer input; the gated reviewer Turn keeps
      // the task active while the result node is already visible.
      expect(workspace.task.status).toBe('running');
    } finally {
      await close();
    }
  });

  it('keeps lifecycle validation synchronous on the acceptance path', async () => {
    const client = await startApiTestClient();
    const task = await createValidTask(client);
    // retry on a ready task: synchronous 409, never a 202 acceptance.
    const retried = await client.request('POST', `/api/tasks/${task.id}/retry`);
    expect(retried.status).toBe(409);
    expectPublicErrorEnvelope(retried, 'INVALID_TRANSITION');
    // answer on a task without a pending human request: synchronous 409.
    const answered = await client.request('POST', `/api/tasks/${task.id}/answer`, {
      json: { answer: '回答' },
    });
    expect(answered.status).toBe(409);
    expectPublicErrorEnvelope(answered, 'INVALID_TRANSITION');
    await client.close();
  });
});

describe('Phase C Task 5: startup interruption recovery (plan Task 5 Step 6)', () => {
  it('restores active tasks as interrupted before serving any request', async () => {
    const roots = manualTempRoots();

    // First process: freeze a task, start it and seed one confirmed input,
    // then die without any terminal event (no shutdown, no stop).
    const firstService = new CoreService(CorePaths.create(roots), {
      runtime: new FakeAgentRuntime(),
    });
    await firstService.initialize();
    const created = await firstService.createTask(validTaskRequest());
    await firstService.appendTestEvent(created.id, makeTaskEvent({ type: 'task_started' }));
    await firstService.appendTestEvent(
      created.id,
      makeTaskEvent({
        type: 'agent_input',
        node: makeEventNode({ agentId: 'writer', kind: 'input', title: '输入', body: '开始' }),
      }),
    );

    // Second process over the same roots: recovery runs during server boot,
    // before the first request is accepted.
    const { baseUrl, close } = await bootTestServer(roots, new FakeAgentRuntime());
    try {
      const summaries = (await (await fetch(`${baseUrl}/api/tasks`)).json()) as TaskSummary[];
      expect(summaries.find((summary) => summary.id === created.id)?.status).toBe('interrupted');

      // Explicit resume continues from the last confirmed event.
      const resumed = await fetch(`${baseUrl}/api/tasks/${created.id}/resume`, { method: 'POST' });
      expect(resumed.status).toBe(202);
      const workspace = (await (
        await fetch(`${baseUrl}/api/tasks/${created.id}/workspace`)
      ).json()) as TaskWorkspace;
      expect(['running', 'interrupted']).toContain(workspace.task.status);
    } finally {
      await close();
    }
  });

  it('never interrupts never-started tasks during startup recovery', async () => {
    const roots = manualTempRoots();
    const firstService = new CoreService(CorePaths.create(roots), {
      runtime: new FakeAgentRuntime(),
    });
    await firstService.initialize();
    const created = await firstService.createTask(validTaskRequest());
    await firstService.appendTestEvent(
      created.id,
      makeTaskEvent({
        type: 'agent_input',
        node: makeEventNode({ agentId: 'writer', kind: 'input', title: '输入', body: '开始' }),
      }),
    );

    const { baseUrl, close } = await bootTestServer(roots, new FakeAgentRuntime());
    try {
      const summaries = (await (await fetch(`${baseUrl}/api/tasks`)).json()) as TaskSummary[];
      // Confirmed input alone never proves an interrupted run.
      expect(summaries.find((summary) => summary.id === created.id)?.status).toBe('running');
    } finally {
      await close();
    }
  });
});

describe('Incompatibility gate (plan 2026-08-04 Task 3, spec §7.3)', () => {
  /** Creates one frozen task whose snapshot is downgraded to the legacy shape. */
  async function seedLegacyTask(service: CoreService): Promise<string> {
    const created = await service.createTask(validTaskRequest());
    await downgradeTaskSnapshotToLegacy(service.paths, created.id);
    return created.id;
  }

  it('startup recovery marks unfinished legacy tasks incompatible once', async () => {
    const roots = manualTempRoots();
    const firstService = new CoreService(CorePaths.create(roots), {
      runtime: new FakeAgentRuntime(),
    });
    await firstService.initialize();
    const legacyId = await seedLegacyTask(firstService);
    await firstService.appendTestEvent(legacyId, makeTaskEvent({ type: 'task_started' }));
    await firstService.appendTestEvent(
      legacyId,
      makeTaskEvent({
        type: 'agent_input',
        node: makeEventNode({ agentId: 'writer', kind: 'input', title: '输入', body: '开始' }),
      }),
    );

    // Booting over the same roots runs recovery before any request.
    const { baseUrl, service, close } = await bootTestServer(roots, new FakeAgentRuntime());
    try {
      const summaries = (await (await fetch(`${baseUrl}/api/tasks`)).json()) as TaskSummary[];
      const summary = summaries.find((item) => item.id === legacyId);
      expect(summary?.status).toBe('incompatible');
      expect(summary?.diagnostic ?? '').toContain('契约');

      // Exactly one authoritative task_incompatible event was committed.
      const events = await service.events.read(legacyId);
      expect(
        events.filter((entry) => entry.event.type === 'task_incompatible'),
      ).toHaveLength(1);

      // Recovery is idempotent: restarting again appends nothing.
      await service.scheduler.recoverInterruptedTasks();
      expect(
        (await service.events.read(legacyId)).filter(
          (entry) => entry.event.type === 'task_incompatible',
        ),
      ).toHaveLength(1);

      // The workspace stays readable with its history intact.
      const workspaceResponse = await fetch(`${baseUrl}/api/tasks/${legacyId}/workspace`);
      expect(workspaceResponse.status).toBe(200);
      const workspace = (await workspaceResponse.json()) as TaskWorkspace;
      expect(workspace.task.status).toBe('incompatible');
      expect(workspace.nodes.some((node) => node.kind === 'input')).toBe(true);
    } finally {
      await close();
    }
  });

  it('rejects start/resume/retry of legacy tasks with TASK_CONTRACT_INCOMPATIBLE', async () => {
    const client = await startApiTestClient();
    const legacyId = await seedLegacyTask(client.service);

    for (const action of ['start', 'resume', 'retry']) {
      const response = await client.request('POST', `/api/tasks/${legacyId}/${action}`);
      expect(response.status, action).toBe(422);
      expectPublicErrorEnvelope(response, 'TASK_CONTRACT_INCOMPATIBLE');
    }
    // Nothing lifecycle-shaped slipped through the gate.
    expect(await client.service.events.read(legacyId)).toEqual([]);
    await client.close();
  });

  it('keeps clone available for legacy tasks over the current template', async () => {
    const client = await startApiTestClient();
    const legacyId = await seedLegacyTask(client.service);

    const cloned = await client.request('POST', `/api/tasks/${legacyId}/clone`);
    expect(cloned.status).toBe(200);
    const summary = cloned.body as TaskSummary;
    expect(summary.id).not.toBe(legacyId);
    expect(summary.status).toBe('ready');
    // The clone's snapshot carries the current contract.
    const frozen = await client.service.tasks.readFrozenTemplate(summary.id);
    expect(frozen.agents.every((agent) => agent.turnContract !== null)).toBe(true);
    await client.close();
  });

  it('leaves completed/stopped legacy tasks on their historical status', async () => {
    const roots = manualTempRoots();
    const firstService = new CoreService(CorePaths.create(roots), {
      runtime: new FakeAgentRuntime(),
    });
    await firstService.initialize();
    const legacyId = await seedLegacyTask(firstService);
    await firstService.appendTestEvent(legacyId, makeTaskEvent({ type: 'task_started' }));
    await firstService.appendTestEvent(legacyId, makeTaskEvent({ type: 'task_stopped' }));

    const { baseUrl, service, close } = await bootTestServer(roots, new FakeAgentRuntime());
    try {
      const summaries = (await (await fetch(`${baseUrl}/api/tasks`)).json()) as TaskSummary[];
      expect(summaries.find((item) => item.id === legacyId)?.status).toBe('stopped');
      const events = await service.events.read(legacyId);
      expect(events.some((entry) => entry.event.type === 'task_incompatible')).toBe(false);
    } finally {
      await close();
    }
  });
});

describe('DELETE /api/tasks/:taskId (task list delete)', () => {
  it('deletes an existing task and answers 200', async () => {
    const client = await startApiTestClient();
    const task = await createValidTask(client);

    const deleted = await client.request('DELETE', `/api/tasks/${task.id}`);
    expect(deleted.status).toBe(200);

    const listed = (await client.get('/api/tasks')).body as TaskSummary[];
    expect(listed.map((summary) => summary.id)).not.toContain(task.id);
    const missedWorkspace = await client.get(`/api/tasks/${task.id}/workspace`);
    expect(missedWorkspace.status).toBe(404);
    expectPublicErrorEnvelope(missedWorkspace, 'TASK_NOT_FOUND');
    await client.close();
  });

  it('maps unknown task ids to the public TASK_NOT_FOUND envelope', async () => {
    const client = await startApiTestClient();
    const missed = await client.request('DELETE', '/api/tasks/task-missing');
    expect(missed.status).toBe(404);
    expectPublicErrorEnvelope(missed, 'TASK_NOT_FOUND');
    await client.close();
  });

  it('maps unsafe task ids to the 400 CORE_PATH_INVALID envelope', async () => {
    const client = await startApiTestClient();
    const unsafe = await client.request('DELETE', '/api/tasks/..%2Fescape');
    expect(unsafe.status).toBe(400);
    expectPublicErrorEnvelope(unsafe, 'CORE_PATH_INVALID');
    await client.close();
  });

  it('deletes a corrupt task directory exactly like a healthy one', async () => {
    const client = await startApiTestClient();
    const task = await createValidTask(client);
    // Damage the frozen record so the task projects as `corrupt` first.
    writeFileSync(join(client.dataRoot, 'tasks', task.id, 'task.json'), '{not-json', 'utf8');
    const before = (await client.get('/api/tasks')).body as TaskSummary[];
    expect(before.find((summary) => summary.id === task.id)?.status).toBe('corrupt');

    const deleted = await client.request('DELETE', `/api/tasks/${task.id}`);
    expect(deleted.status).toBe(200);
    const after = (await client.get('/api/tasks')).body as TaskSummary[];
    expect(after.map((summary) => summary.id)).not.toContain(task.id);
    await client.close();
  });

  it('rejects DELETE on non-task routes with the 405 envelope', async () => {
    const client = await startApiTestClient();
    const missed = await client.request('DELETE', '/api/templates');
    expect(missed.status).toBe(405);
    expectPublicErrorEnvelope(missed, 'METHOD_NOT_ALLOWED');
    await client.close();
  });
});
