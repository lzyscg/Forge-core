/**
 * HttpGateway (plan Phase B Task 5): the ForgeCoreGateway implementation
 * backed by the local JSON API.
 *
 * Production calls construct it without options, so every request uses a
 * relative `/api` URL with `credentials: 'same-origin'`; API tests point
 * `apiBase` at their own server. Success payloads are decoded through the
 * shared TypeBox schemas and error envelopes become public errors — raw
 * response text, causes and headers never reach page state (iron rule 6).
 *
 * `watchTask` polls the workspace endpoint: every 750 ms while the document
 * is visible, every 3000 ms while hidden. The first poll seeds the digest
 * baseline AND notifies once (reconcile): the subscriber's initial load may
 * have resolved before or between server-side writes, and without the
 * reconcile an unchanged digest after the baseline would leave the page
 * stuck on a stale first read. Later listeners fire only when the digest
 * (status + updatedAt + version + collection sizes + pending question)
 * changes. Unsubscribe aborts any in-flight request and clears the pending
 * timer.
 */
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import type {
  HumanDecision,
  SealRecord,
  SkillContent,
  StructuredIssuePageV1,
  StructuredSlotOutlinePageV1,
  StructuredSlotPublicContractV1,
  StructuredSlotReadResponseV1,
  TaskSummary,
  TaskWorkspace,
  TemplateDetail,
  TemplateSummary,
  TurnTrace,
} from '../../shared/contracts';
import type { StructuredSlotTreeCursorV1 } from '../../shared/structured-slots';
import type { PublicCoreError } from '../../shared/errors';
import {
  errorBodySchema,
  skillContentSchema,
  structuredIssuePageSchema,
  structuredSealRecordSchema,
  structuredSlotOutlinePageSchema,
  structuredSlotPublicContractSchema,
  structuredSlotReadResponseSchema,
  taskSummaryListSchema,
  taskSummarySchema,
  taskWorkspaceSchema,
  templateDetailSchema,
  templateSummaryListSchema,
  turnTraceSchema,
} from '../../shared/api-schemas';
import type { ForgeCoreGateway } from './forge-core-gateway';

/** Poll cadence for watchTask, keyed by document visibility. */
const VISIBLE_POLL_MS = 750;
const HIDDEN_POLL_MS = 3000;

export interface HttpGatewayOptions {
  /**
   * Origin prefix placed before `/api`. Defaults to '' which yields the
   * required relative same-origin URLs; tests point it at their own server.
   */
  apiBase?: string;
}

/** Public error type every HttpGateway failure surfaces. */
export class HttpCoreError extends Error implements PublicCoreError {
  readonly code: string;

  readonly location: string | null;

  readonly action: string | null;

  constructor(
    code: string,
    message: string,
    location: string | null = null,
    action: string | null = null,
  ) {
    super(message);
    this.name = 'HttpCoreError';
    this.code = code;
    this.location = location;
    this.action = action;
  }
}

function currentPollInterval(): number {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    return HIDDEN_POLL_MS;
  }
  return VISIBLE_POLL_MS;
}

/** Change detector: cheap fields only, never full body comparisons. */
function workspaceDigest(workspace: TaskWorkspace): string {
  return [
    workspace.task.status,
    workspace.task.updatedAt,
    workspace.task.latestVersion ?? '',
    workspace.nodes.length,
    workspace.executedRoutes.length,
    workspace.artifacts.length,
    workspace.pendingHumanQuestion ?? '',
  ].join('|');
}

export function createHttpGateway(options: HttpGatewayOptions = {}): ForgeCoreGateway {
  const apiBase = options.apiBase ?? '';
  /** Tasks this gateway instance has observed; guards watchTask existence. */
  const knownTaskIds = new Set<string>();

  async function request(path: string, method: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${apiBase}${path}`, {
        method,
        credentials: 'same-origin',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new HttpCoreError(
        'NETWORK_ERROR',
        '无法连接本地后端。',
        null,
        '确认本地服务正在运行后重试。',
      );
    }
    const text = await response.text();
    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      throw toPublicHttpError(payload);
    }
    return payload;
  }

  function toPublicHttpError(payload: unknown): HttpCoreError {
    if (Value.Check(errorBodySchema, payload)) {
      const envelope = payload as { error: PublicCoreError };
      return new HttpCoreError(
        envelope.error.code,
        envelope.error.message,
        envelope.error.location,
        envelope.error.action,
      );
    }
    return new HttpCoreError(
      'INTERNAL_ERROR',
      '本地后端返回了无法识别的错误。',
      null,
      '稍后重试。',
    );
  }

  function decode<T>(schema: TSchema, payload: unknown): T {
    if (Value.Check(schema, payload)) {
      return payload as T;
    }
    throw new HttpCoreError(
      'INTERNAL_ERROR',
      '本地后端返回的数据不符合契约。',
      null,
      '稍后重试。',
    );
  }

  async function getDecoded<T>(schema: TSchema, path: string): Promise<T> {
    return decode<T>(schema, await request(path, 'GET'));
  }

  async function postDecoded<T>(schema: TSchema, path: string, body?: unknown): Promise<T> {
    return decode<T>(schema, await request(path, 'POST', body));
  }

  async function postVoid(path: string, body?: unknown): Promise<void> {
    await request(path, 'POST', body);
  }

  return {
    async listTemplates(): Promise<TemplateSummary[]> {
      return getDecoded<TemplateSummary[]>(templateSummaryListSchema, '/api/templates');
    },

    async getTemplate(templateId: string): Promise<TemplateDetail> {
      return getDecoded<TemplateDetail>(
        templateDetailSchema,
        `/api/templates/${encodeURIComponent(templateId)}`,
      );
    },

    async reloadTemplate(templateId: string): Promise<TemplateDetail> {
      return postDecoded<TemplateDetail>(
        templateDetailSchema,
        `/api/templates/${encodeURIComponent(templateId)}/reload`,
      );
    },

    async createTask(requestBody): Promise<TaskSummary> {
      const created = await postDecoded<TaskSummary>(taskSummarySchema, '/api/tasks', requestBody);
      knownTaskIds.add(created.id);
      return created;
    },

    async listTasks(): Promise<TaskSummary[]> {
      const summaries = await getDecoded<TaskSummary[]>(taskSummaryListSchema, '/api/tasks');
      for (const summary of summaries) knownTaskIds.add(summary.id);
      return summaries;
    },

    async getWorkspace(taskId: string): Promise<TaskWorkspace> {
      const workspace = await getDecoded<TaskWorkspace>(
        taskWorkspaceSchema,
        `/api/tasks/${encodeURIComponent(taskId)}/workspace`,
      );
      knownTaskIds.add(taskId);
      return workspace;
    },

    async startTask(taskId: string): Promise<void> {
      await postVoid(`/api/tasks/${encodeURIComponent(taskId)}/start`);
      knownTaskIds.add(taskId);
    },

    async stopTask(taskId: string): Promise<void> {
      await postVoid(`/api/tasks/${encodeURIComponent(taskId)}/stop`);
      knownTaskIds.add(taskId);
    },

    async resumeTask(taskId: string): Promise<void> {
      await postVoid(`/api/tasks/${encodeURIComponent(taskId)}/resume`);
      knownTaskIds.add(taskId);
    },

    async retryTask(taskId: string): Promise<void> {
      await postVoid(`/api/tasks/${encodeURIComponent(taskId)}/retry`);
      knownTaskIds.add(taskId);
    },

    async answerHuman(taskId: string, answer: string): Promise<void> {
      await postVoid(`/api/tasks/${encodeURIComponent(taskId)}/answer`, { answer });
      knownTaskIds.add(taskId);
    },

    async submitHumanDecision(taskId: string, decision: HumanDecision): Promise<void> {
      const body =
        decision.decision === 'stop'
          ? { decision: 'stop' }
          : { decision: decision.decision, text: decision.text };
      await postVoid(`/api/tasks/${encodeURIComponent(taskId)}/answer`, body);
      knownTaskIds.add(taskId);
    },

    watchTask(taskId: string, listener: () => void): () => void {
      if (!knownTaskIds.has(taskId)) {
        throw new HttpCoreError(
          'TASK_NOT_FOUND',
          `未找到任务 ${taskId}。`,
          'HttpGateway.watchTask',
          '返回任务列表刷新后重试。',
        );
      }

      let active = true;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let controller: AbortController | null = null;
      let lastDigest: string | null = null;

      const schedule = (): void => {
        if (!active) return;
        timer = setTimeout(() => {
          void poll();
        }, currentPollInterval());
      };

      const poll = async (): Promise<void> => {
        if (!active) return;
        const current = new AbortController();
        controller = current;
        try {
          const response = await fetch(
            `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/workspace`,
            {
              method: 'GET',
              credentials: 'same-origin',
              signal: current.signal,
            },
          );
          if (!active) return;
          if (response.ok) {
            const text = await response.text();
            let payload: unknown = null;
            try {
              payload = JSON.parse(text);
            } catch {
              payload = null;
            }
            if (Value.Check(taskWorkspaceSchema, payload)) {
              const workspace = payload as unknown as TaskWorkspace;
              knownTaskIds.add(taskId);
              const digest = workspaceDigest(workspace);
              if (lastDigest === null) {
                // Baseline poll: seed the digest and reconcile once. The
                // subscriber's first read may predate server-side writes;
                // without this notification a digest that stays equal to the
                // baseline would pin a stale initial workspace forever.
                lastDigest = digest;
                listener();
              } else if (digest !== lastDigest) {
                lastDigest = digest;
                listener();
              }
            }
          }
          // Non-OK responses stay silent: the page owns its error path.
        } catch (error) {
          const aborted = error instanceof Error && error.name === 'AbortError';
          if (!active || aborted) return;
          // Network hiccups keep polling; the next cycle retries.
        } finally {
          if (controller === current) controller = null;
        }
        schedule();
      };

      schedule();

      return () => {
        if (!active) return;
        active = false;
        if (timer !== null) clearTimeout(timer);
        if (controller !== null) controller.abort();
      };
    },

    async getTurnTrace(taskId: string, turnId: string): Promise<TurnTrace> {
      return getDecoded<TurnTrace>(
        turnTraceSchema,
        `/api/tasks/${encodeURIComponent(taskId)}/trace/${encodeURIComponent(turnId)}`,
      );
    },

    async getSkillContent(taskId: string, skillId: string): Promise<SkillContent> {
      return getDecoded<SkillContent>(
        skillContentSchema,
        `/api/tasks/${encodeURIComponent(taskId)}/skills/${encodeURIComponent(skillId)}`,
      );
    },

    async cloneTask(taskId: string): Promise<TaskSummary> {
      const created = await postDecoded<TaskSummary>(
        taskSummarySchema,
        `/api/tasks/${encodeURIComponent(taskId)}/clone`,
      );
      // The fresh task becomes watchable immediately, without a prior
      // listTasks/getWorkspace round trip (same contract as createTask).
      knownTaskIds.add(created.id);
      return created;
    },

    async deleteTask(taskId: string): Promise<void> {
      await request(`/api/tasks/${encodeURIComponent(taskId)}`, 'DELETE');
      // The task is gone server-side: drop it from the watchable set so a
      // stale watchTask call fails exactly like a never-seen id.
      knownTaskIds.delete(taskId);
    },

    async getStructuredContract(taskId: string): Promise<StructuredSlotPublicContractV1> {
      return getDecoded<StructuredSlotPublicContractV1>(
        structuredSlotPublicContractSchema,
        `/api/tasks/${encodeURIComponent(taskId)}/structured-slots/contract`,
      );
    },

    async listStructuredSlots(
      taskId: string,
      cursor: StructuredSlotTreeCursorV1 | null,
      limit: number,
    ): Promise<StructuredSlotOutlinePageV1> {
      return getDecoded<StructuredSlotOutlinePageV1>(
        structuredSlotOutlinePageSchema,
        structuredPageUrl(taskId, 'tree', cursor, limit),
      );
    },

    async getStructuredSlot(taskId: string, slotId: string): Promise<StructuredSlotReadResponseV1> {
      return getDecoded<StructuredSlotReadResponseV1>(
        structuredSlotReadResponseSchema,
        `/api/tasks/${encodeURIComponent(taskId)}/structured-slots/slots/${encodeURIComponent(slotId)}`,
      );
    },

    async listStructuredIssues(
      taskId: string,
      cursor: StructuredSlotTreeCursorV1 | null,
      limit: number,
    ): Promise<StructuredIssuePageV1> {
      return getDecoded<StructuredIssuePageV1>(
        structuredIssuePageSchema,
        structuredPageUrl(taskId, 'issues', cursor, limit),
      );
    },

    async getStructuredSeal(taskId: string): Promise<SealRecord> {
      return getDecoded<SealRecord>(
        structuredSealRecordSchema,
        `/api/tasks/${encodeURIComponent(taskId)}/structured-slots/seal`,
      );
    },
  };
}

/** Builds the paged structured URL: `/.../tree|issues?cursor=&limit=`. */
function structuredPageUrl(
  taskId: string,
  resource: 'tree' | 'issues',
  cursor: StructuredSlotTreeCursorV1 | null,
  limit: number,
): string {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (cursor !== null) {
    params.set('cursor', JSON.stringify(cursor));
  }
  return `/api/tasks/${encodeURIComponent(taskId)}/structured-slots/${resource}?${params.toString()}`;
}
