/**
 * Task API routes (plan Phase B Task 5; lifecycle wired in Phase C Task 4,
 * asynchronous acceptance completed in Phase C Task 5).
 *
 * Creation, listing and workspace projection are real CoreService flows.
 * Lifecycle mutations delegate to the CoreService scheduler: `stop` waits for
 * the abort to settle and answers 200 with the stopped summary, while
 * `start`/`resume`/`retry`/`answer` are ACCEPTED asynchronously — validation
 * stays synchronous (existence/status errors still surface as the stable
 * public codes TASK_NOT_FOUND/TASK_CORRUPTED/TASK_ALREADY_RUNNING/
 * INVALID_TRANSITION through the shared error map), the accepted summary is
 * answered with 202 and the loop keeps running in the background (plan Task
 * 5 Step 7; fixes the Task 4 known limitation where long Turns blocked the
 * HTTP response). Request bodies are checked against the shared TypeBox
 * schemas, so unknown fields never reach the service layer.
 */
import { Value } from 'typebox/value';
import type { TaskSummary, TaskWorkspace } from '../../shared/contracts';
import {
  answerBodySchema,
  answerBodyV2Schema,
  createTaskBodySchema,
  deleteTaskBodyV2Schema,
  reopenFailedRequestV2Schema,
} from '../../shared/api-schemas';
import { structuredProtocolOf } from '../../shared/authoritative-review-v2';
import type { CoreService } from '../core-service';
import type { HumanAnswerRequest } from '../runtime/task-scheduler';
import {
  ApiError,
  readBody,
  readJsonObject,
  sendJson,
  type ApiRoute,
  type ApiRouteContext,
} from './router';

/**
 * Normalizes a validated answer body into the scheduler's `HumanAnswerRequest`
 * (spec §11.1/§11.5). A legacy `{ answer: string }` becomes a text answer; a
 * structured `{ decision, text? }` becomes the matching continue/accept/stop
 * request, with `text` defaulting to '' (the scheduler rejects empty guidance
 * for continue/accept as a public INVALID_TRANSITION).
 */
function toHumanAnswerRequest(body: {
  answer?: string;
  decision?: 'continue' | 'accept' | 'stop';
  text?: string;
}): string | HumanAnswerRequest {
  if (body.decision !== undefined) {
    if (body.decision === 'stop') {
      return { kind: 'stop' };
    }
    return { kind: body.decision, text: body.text ?? '' };
  }
  return body.answer ?? '';
}

/**
 * Public template versions display the first 12 hash characters everywhere
 * (template catalog policy); workspaces expose the same display value so the
 * two Gateway implementations surface identical strings.
 */
const TEMPLATE_VERSION_DISPLAY_LENGTH = 12;

/** CreateTaskRequest shape, structural so routes import no storage module. */
interface CreateTaskBody {
  templateId: string;
  name: string;
  input: Record<string, string>;
}

/** Drops the server-internal version hash from the creation result. */
function toTaskSummary(created: TaskSummary & { templateVersion: string }): TaskSummary {
  const { templateVersion: _templateVersion, ...summary } = created;
  return summary;
}

/** Maps the stored full version hash to the public display version. */
function toApiWorkspace(workspace: TaskWorkspace): TaskWorkspace {
  return {
    ...workspace,
    templateVersion: workspace.templateVersion.slice(0, TEMPLATE_VERSION_DISPLAY_LENGTH),
  };
}

async function handleCreateTask({ service, req, res }: ApiRouteContext): Promise<void> {
  const body = await readJsonObject(req);
  if (!Value.Check(createTaskBodySchema, body)) {
    throw new ApiError(
      'INVALID_INPUT',
      '任务创建请求只能包含 templateId、name 与 input 字段。',
      null,
      '移除未声明字段后重新提交。',
    );
  }
  const created = await service.createTask(body as CreateTaskBody);
  sendJson(res, 200, toTaskSummary(created));
}

async function handleAnswer({ service, req, params, res }: ApiRouteContext): Promise<void> {
  const body = await readJsonObject(req);
  // The answer wire schema is versioned by the FROZEN task protocol (spec
  // §10.6): v2 tasks require questionId/questionVersion/operationId on every
  // branch; v1 (and basic) tasks keep the legacy body. The dispatch reads the
  // task's frozen snapshot — never the request body or current catalog.
  const frozen = await service.tasks.readFrozenTemplate(params.taskId);
  const isV2 = structuredProtocolOf(frozen) === 'v2';
  if (!Value.Check(isV2 ? answerBodyV2Schema : answerBodySchema, body)) {
    throw new ApiError(
      'INVALID_INPUT',
      isV2
        ? 'v2 回答请求必须携带 questionId、questionVersion、operationId 与 answer 或 decision。'
        : '人工回答请求必须是 { answer: string } 或 { decision: continue|accept|stop, text?: string }。',
      null,
      isV2
        ? '按 { questionId, questionVersion, operationId, answer|decision } 形状重新提交。'
        : '按 { answer: string } 或 { decision, text? } 形状重新提交。',
    );
  }
  if (isV2) {
    // V2 answers synchronously: the server atomically verifies the question
    // token and commits the delivery; stale tabs receive HUMAN_QUESTION_STALE
    // (spec §10.6).
    const summary = await service.answerTaskV2(params.taskId, body as Parameters<CoreService['answerTaskV2']>[1]);
    sendJson(res, 200, summary);
    return;
  }
  // Accepted asynchronously: validation errors still reject publicly, the
  // loop continues in the background after the 202 is answered.
  const { accepted, completion } = await service.scheduler.answerDetached(
    params.taskId,
    toHumanAnswerRequest(body as Parameters<typeof toHumanAnswerRequest>[0]),
  );
  completion.catch(() => undefined);
  sendJson(res, 202, accepted);
}

/** The frozen-snapshot protocol of one task (loads the task snapshot once). */
async function protocolOf(service: CoreService, taskId: string): Promise<'none' | 'v1' | 'v2'> {
  const frozen = await service.tasks.readFrozenTemplate(taskId);
  return structuredProtocolOf(frozen);
}

/**
 * start/resume/retry accept asynchronously for v1 (202) and answer
 * synchronously for v2 (200 — the v2 mutation IS the commit; the durable
 * wakeup pass drives the next step). The frozen snapshot decides the branch
 * (spec §4.1/§14.3), never the request body.
 */
function lifecycleRoute(action: 'start' | 'resume' | 'retry'): ApiRoute {
  return {
    method: 'POST',
    segments: ['api', 'tasks', ':taskId', action],
    async handle({ service, params, res }) {
      if ((await protocolOf(service, params.taskId)) === 'v2') {
        const accepted = {
          start: () => service.startTaskV2(params.taskId),
          resume: () => service.resumeTaskV2(params.taskId),
          retry: () => service.retryTaskV2(params.taskId),
        }[action]();
        sendJson(res, 200, await accepted);
        return;
      }
      const accept = {
        start: () => service.scheduler.startDetached(params.taskId),
        resume: () => service.scheduler.resumeDetached(params.taskId),
        retry: () => service.scheduler.retryDetached(params.taskId),
      }[action];
      const { accepted, completion } = await accept();
      // Background loop failures surface through the projection, never as an
      // unhandled rejection.
      completion.catch(() => undefined);
      sendJson(res, 202, accepted);
    },
  };
}

/** `stop` stays synchronous: it waits for the abort and answers the result. */
function stopRoute(): ApiRoute {
  return {
    method: 'POST',
    segments: ['api', 'tasks', ':taskId', 'stop'],
    async handle({ service, params, res }) {
      if ((await protocolOf(service, params.taskId)) === 'v2') {
        sendJson(res, 200, await service.stopTaskV2(params.taskId));
        return;
      }
      sendJson(res, 200, await service.stopTask(params.taskId));
    },
  };
}

/* Phase E Task 3 routes: display-only turn trace, snapshot skill content and
 * same-input clone. A null service result becomes the public envelope with a
 * stable 404 code; task identity failures pass through the shared error map. */

function traceRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'trace', ':turnId'],
    async handle({ service, params, res }) {
      const trace = await service.getTurnTrace(params.taskId, params.turnId);
      if (trace === null) {
        throw new ApiError(
          'TRACE_NOT_FOUND',
          '未找到该回合的执行过程记录。',
          null,
          '返回任务画布查看最新状态。',
        );
      }
      sendJson(res, 200, trace);
    },
  };
}

function skillRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'skills', ':skillId'],
    async handle({ service, params, res }) {
      const skill = await service.getSkillContent(params.taskId, params.skillId);
      if (skill === null) {
        throw new ApiError(
          'SKILL_NOT_FOUND',
          '未找到该技能的内容。',
          null,
          '返回任务画布查看最新状态。',
        );
      }
      sendJson(res, 200, skill);
    },
  };
}

function cloneRoute(): ApiRoute {
  return {
    method: 'POST',
    segments: ['api', 'tasks', ':taskId', 'clone'],
    async handle({ service, params, res }) {
      sendJson(res, 200, await service.cloneTask(params.taskId));
    },
  };
}

/**
 * Irreversible task deletion (task list delete): covers EVERY task status.
 * The dispatch READS the JSON body only when the client sends one; the
 * CoreService selects the protocol from the installation task index (spec
 * §10.5) — a v2 task requires the exact `{ operationId, reason }` body, a v1
 * task rejects a v2-protocol body BEFORE any deletion begins, and legacy v1
 * deletion stays body-less byte-for-byte.
 */
function deleteRoute(): ApiRoute {
  return {
    method: 'DELETE',
    segments: ['api', 'tasks', ':taskId'],
    async handle({ service, req, params, res }) {
      // B-M1: the router's guarded body reader (1 MiB cap + malformed-JSON
      // rejection) is reused; a body present but EMPTY counts as absent so
      // legacy v1 DELETE stays body-less byte-for-byte.
      const raw = await readBody(req);
      let body: unknown = undefined;
      if (raw.length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new ApiError(
            'INVALID_INPUT',
            '删除请求体不是有效 JSON。',
            null,
            '提交合法的 JSON 请求体。',
          );
        }
        if (!Value.Check(deleteTaskBodyV2Schema, parsed)) {
          throw new ApiError(
            'INVALID_INPUT',
            'v2 删除请求必须携带 operationId（UUID v4）与 1..500 字符的 reason。',
            null,
            '按 { operationId, reason } 形状重新提交。',
          );
        }
        // B-F2/B-M5: whitespace-only reasons are 400 INVALID_INPUT (never a
        // latent DELETE_NOT_FOUND) and the bound is CODE POINTS server-side.
        const deleteReason = (parsed as { reason?: unknown }).reason;
        if (typeof deleteReason !== 'string' || deleteReason.trim().length === 0) {
          throw new ApiError('INVALID_INPUT', '删除原因不能为空。', null, '填写删除原因后重试。');
        }
        if ([...deleteReason].length > 500) {
          throw new ApiError('INVALID_INPUT', '删除原因不能超过 500 个字符。', null, '缩短删除原因后重试。');
        }
        body = parsed;
      }
      sendJson(res, 200, await service.deleteTask(params.taskId, body as { operationId: string; reason: string } | undefined));
    },
  };
}

/**
 * The fenced reopen route (spec §10.3.1): ONLY the frozen policy table can
 * recover a failed v2 task; the body is schema-validated BEFORE the service
 * derives the replacement base/scope/Grant server-side. V1 has no reopen.
 */
function reopenFailedRoute(): ApiRoute {
  return {
    method: 'POST',
    segments: ['api', 'tasks', ':taskId', 'reopen_failed'],
    async handle({ service, req, params, res }) {
      const body = await readJsonObject(req);
      if (!Value.Check(reopenFailedRequestV2Schema, body)) {
        throw new ApiError(
          'INVALID_INPUT',
          'reopen_failed 请求必须携带 expectedLastSequence、operationId（UUID v4）、reason（1..1000 字符）、recipeKey 与匹配的 track。',
          null,
          '按冻结恢复策略表提交合法 recipe/track。',
        );
      }
      // B-M5: reason bounds are CODE POINTS server-side; whitespace-only is a
      // stable 400 INVALID_INPUT.
      const reopenReason = (body as { reason?: unknown }).reason;
      if (typeof reopenReason !== 'string' || reopenReason.trim().length === 0) {
        throw new ApiError('INVALID_INPUT', '恢复原因不能为空。', null, '填写恢复原因后重试。');
      }
      if ([...reopenReason].length > 1000) {
        throw new ApiError('INVALID_INPUT', '恢复原因不能超过 1000 个字符。', null, '缩短恢复原因后重试。');
      }
      sendJson(res, 200, await service.reopenFailedTask(params.taskId, body as Parameters<CoreService['reopenFailedTask']>[1]));
    },
  };
}

export function taskRoutes(): ApiRoute[] {
  return [
    {
      method: 'GET',
      segments: ['api', 'tasks'],
      async handle({ service, res }) {
        sendJson(res, 200, await service.listTasks());
      },
    },
    {
      method: 'POST',
      segments: ['api', 'tasks'],
      handle: handleCreateTask,
    },
    {
      method: 'GET',
      segments: ['api', 'tasks', ':taskId', 'workspace'],
      async handle({ service, params, res }) {
        const workspace = await service.getWorkspace(params.taskId);
        sendJson(res, 200, toApiWorkspace(workspace));
      },
    },
    lifecycleRoute('start'),
    stopRoute(),
    lifecycleRoute('resume'),
    lifecycleRoute('retry'),
    {
      method: 'POST',
      segments: ['api', 'tasks', ':taskId', 'answer'],
      handle: handleAnswer,
    },
    traceRoute(),
    skillRoute(),
    cloneRoute(),
    deleteRoute(),
    reopenFailedRoute(),
  ];
}
