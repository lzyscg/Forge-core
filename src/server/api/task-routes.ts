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
} from '../../shared/api-schemas';
import { structuredProtocolOf } from '../../shared/authoritative-review-v2';
import type { CoreService } from '../core-service';
import type { HumanAnswerRequest } from '../runtime/task-scheduler';
import {
  ApiError,
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
  // Accepted asynchronously: validation errors still reject publicly, the
  // loop continues in the background after the 202 is answered.
  const { accepted, completion } = await service.scheduler.answerDetached(
    params.taskId,
    toHumanAnswerRequest(body as Parameters<typeof toHumanAnswerRequest>[0]),
  );
  completion.catch(() => undefined);
  sendJson(res, 202, accepted);
}

/**
 * start/resume/retry accept asynchronously (202): the scheduler validates and
 * commits the lifecycle event before the acceptance is answered, then runs
 * the loop in the background. Validation failures reject through the public
 * error map exactly like before.
 */
function lifecycleRoute(
  action: 'start' | 'resume' | 'retry',
): ApiRoute {
  return {
    method: 'POST',
    segments: ['api', 'tasks', ':taskId', action],
    async handle({ service, params, res }) {
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
 * Irreversible task deletion (task list delete): covers EVERY task status —
 * running tasks are aborted first by the service, corrupt ones delete like
 * healthy ones. Misses surface as the stable TASK_NOT_FOUND envelope through
 * the shared error map; the 200 body only confirms the deletion.
 */
function deleteRoute(): ApiRoute {
  return {
    method: 'DELETE',
    segments: ['api', 'tasks', ':taskId'],
    async handle({ service, params, res }) {
      await service.deleteTask(params.taskId);
      sendJson(res, 200, { ok: true });
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
  ];
}
