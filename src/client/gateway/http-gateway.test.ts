/**
 * HttpGateway tests (plan Phase B Task 5).
 *
 * The shared Gateway contract suite runs verbatim against a real test-mode
 * server plus HttpGateway (fresh temporary roots per case, server closed on
 * dispose). Additional cases pin the HTTP-specific behaviors: relative
 * same-origin requests, shared-schema decoding, public error mapping, and
 * visibility-aware watchTask polling with abortable in-flight requests.
 */
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { TaskStatus, TaskSummary, TaskWorkspace, TemplateDetail } from '../../shared/contracts';
import {
  disposeAllTestRoots,
  makeTaskEvent,
  startHttpGatewayFixture,
} from '../../server/test-support';
import { productionEvidencePath } from '../../server/structured-slots/runtime-capability';
import { runForgeCoreGatewayContract } from './forge-core-gateway.contract';
import { resolveForgeCoreMode } from './gateway-mode';
import { createHttpGateway } from './http-gateway';

afterEach(() => {
  disposeAllTestRoots();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function requiredInput(detail: TemplateDetail): Record<string, string> {
  const input: Record<string, string> = {};
  for (const field of detail.inputFields) {
    if (field.required) input[field.id] = 'HTTP 契约套件输入';
  }
  return input;
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Shared contract suite, plan Step 1: every case owns a fresh fixture with
// new temporary roots, a real server and an HttpGateway; dispose closes it.
runForgeCoreGatewayContract(async () => {
  const fixture = await startHttpGatewayFixture();
  return {
    gateway: createHttpGateway({ apiBase: fixture.baseUrl }),
    dispose: fixture.close,
  };
});

/* ----------------------- HTTP-specific behaviors ----------------------- */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubSummary(id: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id,
    name: '任务',
    templateId: 'template-a',
    templateName: '模板',
    status: 'ready',
    currentAgentName: null,
    latestVersion: null,
    updatedAt: '2026-08-03T00:00:00.000Z',
    diagnostic: null,
    structuredProtocol: 'none',
    ...overrides,
  };
}

function stubWorkspace(id: string, status: TaskStatus, updatedAt: string): TaskWorkspace {
  return {
    task: stubSummary(id, { status, updatedAt }),
    frozenInput: {},
    templateVersion: 'abc123def456',
    agents: [],
    declaredRoutes: [],
    nodes: [],
    executedRoutes: [],
    artifacts: [],
    pendingHumanQuestion: null,
    pendingHumanSource: null,
  };
}

function workspaceUrlFor(baseUrl: string, taskId: string): string {
  return `${baseUrl}/api/tasks/${taskId}/workspace`;
}

describe('createHttpGateway', () => {
  it('resolves enabled production evidence inside the repository from a Vitest HTTP worker', () => {
    expect(productionEvidencePath('structured-slot-platform-profile-v1.json')).toBe(
      resolve(process.cwd(), 'docs/evidence/structured-slot-platform-profile-v1.json'),
    );
  });

  it('uses relative /api URLs and same-origin credentials by default', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(200, []);
      }),
    );
    const gateway = createHttpGateway();
    expect(await gateway.listTemplates()).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/templates');
    expect(calls[0].init.credentials).toBe('same-origin');
  });

  it('decodes success payloads through the shared schemas', async () => {
    const fixture = await startHttpGatewayFixture();
    try {
      const gateway = createHttpGateway({ apiBase: fixture.baseUrl });
      const summaries = await gateway.listTemplates();
      expect(summaries).toHaveLength(1);
      const detail = await gateway.getTemplate(summaries[0].id);
      expect(detail.agents.map((agent) => agent.name)).toEqual(['初稿 Agent', '审核 Agent']);
    } finally {
      await fixture.close();
    }
  });

  it('rejects with INTERNAL_ERROR when a success payload fails the shared schema', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { wrong: true })));
    const gateway = createHttpGateway();
    await expect(gateway.listTemplates()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('maps error envelopes to public errors without raw payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(404, {
          error: {
            code: 'TASK_NOT_FOUND',
            message: '未找到任务。',
            location: null,
            action: null,
          },
        }),
      ),
    );
    const gateway = createHttpGateway();
    await expect(gateway.getWorkspace('task-x')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
      message: '未找到任务。',
      location: null,
      action: null,
    });
  });

  it('surfaces network failures as public errors without raw causes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1');
      }),
    );
    const gateway = createHttpGateway();
    await expect(gateway.listTemplates()).rejects.toSatisfy((error: unknown) => {
      const candidate = error as { code?: string; message?: string };
      return (
        typeof candidate.code === 'string' &&
        typeof candidate.message === 'string' &&
        !candidate.message.includes('ECONNREFUSED')
      );
    });
  });

  it('notifies watchers when the server-side workspace changes', async () => {
    const fixture = await startHttpGatewayFixture();
    try {
      // Count workspace polls through a passthrough fetch wrapper so the
      // change event is seeded only after the baseline poll happened.
      let workspacePolls = 0;
      const nativeFetch = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          const response = await nativeFetch(url, init);
          if (url.includes('/workspace')) workspacePolls += 1;
          return response;
        }),
      );

      const gateway = createHttpGateway({ apiBase: fixture.baseUrl });
      const summaries = await gateway.listTemplates();
      const detail = await gateway.getTemplate(summaries[0].id);
      const task = await gateway.createTask({
        templateId: detail.id,
        name: '轮询任务',
        input: requiredInput(detail),
      });

      let notifications = 0;
      const unsubscribe = gateway.watchTask(task.id, () => {
        notifications += 1;
      });
      await waitFor(() => workspacePolls >= 1, 4000); // baseline seeded
      await fixture.service.appendTestEvent(task.id, makeTaskEvent({ type: 'task_started' }));
      await waitFor(() => notifications > 0, 4000);
      const seen = notifications;

      unsubscribe();
      await fixture.service.appendTestEvent(task.id, makeTaskEvent({ type: 'task_stopped' }));
      await new Promise((resolve) => setTimeout(resolve, 1800));
      expect(notifications).toBe(seen);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it('polls every 750ms while the document is visible', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/tasks')) return jsonResponse(200, [stubSummary('task-1')]);
      return jsonResponse(200, stubWorkspace('task-1', 'ready', '2026-08-03T00:00:00.000Z'));
    });
    vi.stubGlobal('fetch', fetchMock);
    const gateway = createHttpGateway({ apiBase: 'http://forge.test' });
    await gateway.listTasks();

    const listener = vi.fn();
    const unsubscribe = gateway.watchTask('task-1', listener);
    const workspaceCalls = (): number =>
      fetchMock.mock.calls.filter(([url]) => url === workspaceUrlFor('http://forge.test', 'task-1'))
        .length;

    expect(workspaceCalls()).toBe(0);
    await vi.advanceTimersByTimeAsync(749);
    expect(workspaceCalls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(workspaceCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(750);
    expect(workspaceCalls()).toBe(2);
    // The baseline poll reconciles exactly once; an unchanged digest never
    // fires again (pins the stale-initial-load fix from plan Task 6).
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(5000);
    expect(workspaceCalls()).toBe(2);
  });

  it('fires the listener once per observed change', async () => {
    vi.useFakeTimers();
    let workspace = stubWorkspace('task-1', 'ready', '2026-08-03T00:00:00.000Z');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/tasks')) return jsonResponse(200, [stubSummary('task-1')]);
      return jsonResponse(200, workspace);
    });
    vi.stubGlobal('fetch', fetchMock);
    const gateway = createHttpGateway({ apiBase: 'http://forge.test' });
    await gateway.listTasks();

    const listener = vi.fn();
    const unsubscribe = gateway.watchTask('task-1', listener);
    await vi.advanceTimersByTimeAsync(750); // baseline poll = one reconcile
    expect(listener).toHaveBeenCalledTimes(1);

    workspace = stubWorkspace('task-1', 'running', '2026-08-03T00:00:01.000Z');
    await vi.advanceTimersByTimeAsync(750);
    expect(listener).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(750); // same digest again
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('polls every 3000ms while the document is hidden', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/tasks')) return jsonResponse(200, [stubSummary('task-1')]);
      return jsonResponse(200, stubWorkspace('task-1', 'ready', '2026-08-03T00:00:00.000Z'));
    });
    vi.stubGlobal('fetch', fetchMock);
    const gateway = createHttpGateway({ apiBase: 'http://forge.test' });
    await gateway.listTasks();

    const unsubscribe = gateway.watchTask('task-1', () => {});
    const workspaceCalls = (): number =>
      fetchMock.mock.calls.filter(([url]) => url === workspaceUrlFor('http://forge.test', 'task-1'))
        .length;

    await vi.advanceTimersByTimeAsync(2999);
    expect(workspaceCalls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(workspaceCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(workspaceCalls()).toBe(2);
    unsubscribe();
  });

  it('aborts the in-flight watch poll on unsubscribe', async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    let settleFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((url: string, init: RequestInit) => {
      if (url.endsWith('/api/tasks')) {
        return Promise.resolve(jsonResponse(200, [stubSummary('task-1')]));
      }
      capturedSignal = init.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        settleFetch = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const gateway = createHttpGateway({ apiBase: 'http://forge.test' });
    await gateway.listTasks();

    const unsubscribe = gateway.watchTask('task-1', () => {});
    await vi.advanceTimersByTimeAsync(750);
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    unsubscribe();
    expect(capturedSignal?.aborted).toBe(true);
    // Resolving the aborted request late must neither throw nor reschedule.
    settleFetch?.(jsonResponse(200, stubWorkspace('task-1', 'running', 'x')));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(
      fetchMock.mock.calls.filter(([url]) => url === workspaceUrlFor('http://forge.test', 'task-1'))
        .length,
    ).toBe(1);
  });

  it('requests turn traces and skill content through encoded, decoded GET paths', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (url.includes('/trace/')) {
          // The second turn carries the display-only final phase (plan
          // 2026-08-04 Task 6); the first stays a historical phase-less trace.
          if (url.includes('turn%2F2')) {
            return jsonResponse(200, {
              turnId: 'turn/2',
              phase: {
                state: 'dispatched',
                dispatchAction: 'publish_artifact',
                target: '章节审核',
                message: null,
              },
              entries: [{ kind: 'text', text: '带阶段的正文条目。' }],
            });
          }
          return jsonResponse(200, {
            turnId: 'turn/1',
            entries: [{ kind: 'text', text: '正文条目。' }],
          });
        }
        return jsonResponse(200, {
          skillId: 'skill#a',
          content: '技能全文。',
          versionHash: 'abcdef0123456789',
        });
      }),
    );
    const gateway = createHttpGateway({ apiBase: 'http://forge.test' });

    const trace = await gateway.getTurnTrace('task 1', 'turn/1');
    expect(trace).toEqual({ turnId: 'turn/1', entries: [{ kind: 'text', text: '正文条目。' }] });
    // Optional phase decodes through the shared schema untouched.
    const phasedTrace = await gateway.getTurnTrace('task 1', 'turn/2');
    expect(phasedTrace).toEqual({
      turnId: 'turn/2',
      phase: {
        state: 'dispatched',
        dispatchAction: 'publish_artifact',
        target: '章节审核',
        message: null,
      },
      entries: [{ kind: 'text', text: '带阶段的正文条目。' }],
    });
    const skillContent = await gateway.getSkillContent('task 1', 'skill#a');
    expect(skillContent.content).toBe('技能全文。');

    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe('http://forge.test/api/tasks/task%201/trace/turn%2F1');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[1].url).toBe('http://forge.test/api/tasks/task%201/trace/turn%2F2');
    expect(calls[1].init.method).toBe('GET');
    expect(calls[2].url).toBe('http://forge.test/api/tasks/task%201/skills/skill%23a');
    expect(calls[2].init.method).toBe('GET');
  });

  it('rejects turn trace payloads whose phase fails the shared schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, {
          turnId: 'turn/3',
          phase: { state: 'not_a_state', dispatchAction: null, target: null, message: null },
          entries: [],
        }),
      ),
    );
    const gateway = createHttpGateway();
    await expect(gateway.getTurnTrace('task-x', 'turn/3')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('maps trace and skill misses to their public 404 codes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        jsonResponse(404, {
          error: {
            code: url.includes('/trace/') ? 'TRACE_NOT_FOUND' : 'SKILL_NOT_FOUND',
            message: '未找到记录。',
            location: null,
            action: null,
          },
        }),
      ),
    );
    const gateway = createHttpGateway();
    await expect(gateway.getTurnTrace('task-x', 'turn-x')).rejects.toMatchObject({
      code: 'TRACE_NOT_FOUND',
      message: '未找到记录。',
    });
    await expect(gateway.getSkillContent('task-x', 'skill-x')).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
      message: '未找到记录。',
    });
  });

  it('posts clone requests and registers the created task for watching', async () => {
    const created = stubSummary('task-clone-1', { name: '任务（重跑）', status: 'ready' });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(200, created);
      }),
    );
    const gateway = createHttpGateway({ apiBase: 'http://forge.test' });

    const cloned = await gateway.cloneTask('task-source');
    expect(cloned.id).toBe('task-clone-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://forge.test/api/tasks/task-source/clone');
    expect(calls[0].init.method).toBe('POST');

    // The clone result joins knownTaskIds, so watchTask accepts it without a
    // prior listTasks/getWorkspace round trip.
    const unsubscribe = gateway.watchTask('task-clone-1', () => {});
    unsubscribe();
    expect(() => gateway.watchTask('task-unknown', () => {})).toThrowError(
      expect.objectContaining({ code: 'TASK_NOT_FOUND' }),
    );
  });

  it('rejects clone responses that fail the shared schema with INTERNAL_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { wrong: true })));
    const gateway = createHttpGateway();
    await expect(gateway.cloneTask('task-source')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('deletes through an encoded DELETE request and forgets the task', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(200, { ok: true });
      }),
    );
    const gateway = createHttpGateway({ apiBase: 'http://forge.test' });

    await gateway.deleteTask('task 1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://forge.test/api/tasks/task%201');
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].init.body).toBeUndefined();

    // A deleted task leaves knownTaskIds: watchTask refuses it like any
    // never-seen id.
    expect(() => gateway.watchTask('task 1', () => {})).toThrowError(
      expect.objectContaining({ code: 'TASK_NOT_FOUND' }),
    );
  });

  it('sends the fenced v2 delete request as exact JSON when provided (spec §10.5)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(200, { ok: true });
      }),
    );
    const gateway = createHttpGateway({ apiBase: 'http://forge.test' });

    await gateway.deleteTask('task-1', {
      operationId: '3b2c8f4e-9a1d-4f6e-b2c4-1a2b3c4d5e6f',
      reason: '任务已归档。',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://forge.test/api/tasks/task-1');
    expect(calls[0].init.method).toBe('DELETE');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      operationId: '3b2c8f4e-9a1d-4f6e-b2c4-1a2b3c4d5e6f',
      reason: '任务已归档。',
    });
  });

  it('maps delete misses to the public TASK_NOT_FOUND envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(404, {
          error: {
            code: 'TASK_NOT_FOUND',
            message: '未找到任务。',
            location: null,
            action: null,
          },
        }),
      ),
    );
    const gateway = createHttpGateway();
    await expect(gateway.deleteTask('task-missing')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
      message: '未找到任务。',
    });
  });

  it('resolves the page gateway mode from the vite env', () => {
    expect(resolveForgeCoreMode(undefined)).toBe('mock');
    expect(resolveForgeCoreMode('mock')).toBe('mock');
    expect(resolveForgeCoreMode('http')).toBe('http');
    expect(resolveForgeCoreMode('anything-else')).toBe('mock');
  });

  it('decodes structured read responses through the shared schemas', async () => {
    const calls: Array<{ url: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push({ url });
        if (url.includes('/structured-slots/tree')) {
          return jsonResponse(200, {
            entries: [
              {
                slotId: 'root',
                typeId: 'document',
                contentPresence: 'unset',
                parentSlotId: null,
                shell: false,
                level: 'content',
                spec: { type: 'object' },
              },
            ],
            nextCursor: null,
          });
        }
        if (url.includes('/structured-slots/slots/')) {
          return jsonResponse(200, {
            slot: {
              slotId: 'title',
              typeId: 'title',
              contentPresence: 'set',
              level: 'content',
              spec: { type: 'object' },
              content: 'The Title',
              ancestors: [{ slotId: 'root', typeId: 'document', contentPresence: 'unset' }],
            },
          });
        }
        return jsonResponse(404, {
          error: {
            code: 'STRUCTURED_NOT_ACTIVE',
            message: '任务未启用结构槽。',
            location: null,
            action: null,
          },
        });
      }),
    );
    const gateway = createHttpGateway();

    const page = await gateway.listStructuredSlots('task-x', null, 5);
    expect(page.entries.map((entry) => entry.slotId)).toEqual(['root']);
    expect(page.nextCursor).toBeNull();
    const url = new URL(calls[0].url, 'http://forge-core.local');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('cursor')).toBeNull();

    const read = await gateway.getStructuredSlot('task-x', 'title');
    expect(read.slot.content).toBe('The Title');
    expect(read.slot.ancestors.map((ancestor) => ancestor.slotId)).toEqual(['root']);

    await expect(gateway.getStructuredContract('task-x')).rejects.toMatchObject({
      code: 'STRUCTURED_NOT_ACTIVE',
    });
    await expect(gateway.getStructuredSeal('task-x')).rejects.toMatchObject({
      code: 'STRUCTURED_NOT_ACTIVE',
    });
  });

  it('rejects a structured success payload that fails the shared schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { entries: [{ slotId: 42 }], nextCursor: null })),
    );
    const gateway = createHttpGateway();
    await expect(gateway.listStructuredSlots('task-x', null, 5)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('serializes a bound cursor into the tree/issues query string', async () => {
    const cursor = {
      version: 1 as const,
      generationId: 'gen-1',
      revision: 0,
      projectionHash: 'a'.repeat(64),
      lastDocumentKey: 'title',
      orderingVersion: 1,
      signature: 'b'.repeat(64),
    };
    const calls: Array<{ url: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push({ url });
        return jsonResponse(200, { issues: [], nextCursor: null });
      }),
    );
    const gateway = createHttpGateway();
    await gateway.listStructuredIssues('task-x', cursor, 20);
    const url = new URL(calls[0].url, 'http://forge-core.local');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(JSON.parse(url.searchParams.get('cursor') ?? '')).toEqual(cursor);
    expect(url.pathname).toBe('/api/tasks/task-x/structured-slots/issues');
  });
});

// Keeps the stub fetch type honest for RequestInit assertions above.
export type FetchMock = Mock;
