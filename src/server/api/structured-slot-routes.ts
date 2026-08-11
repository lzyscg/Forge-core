/**
 * Read-only structured slot routes (Task 18, spec §14).
 *
 * Five GET endpoints expose the structured slots to humans through the SAME
 * authorized projection service Agent grants use, always executed as the
 * built-in `task_owner` subject — never as an arbitrary contract AccessProfile
 * and never via direct file reads. Every response is an exact TypeBox schema.
 *
 * Authorization/pagination invariants:
 * - Basic tasks reject with the stable public `STRUCTURED_NOT_ACTIVE`.
 * - Cursor-invalid (stale/forged/tampered) maps to a stable public 409.
 * - A missing/hidden slot returns the IDENTICAL `SLOT_NOT_VISIBLE` envelope.
 * - Runtime-unavailable snapshots surface the stable `TEMPLATE_RUNTIME_UNAVAILABLE`.
 * - Any attempt to supply a profile/principal/accessProfile/grant/subject
 *   through query parameters is rejected in v1 (the owner is the only subject).
 */
import type { IncomingMessage } from 'node:http';
import { Value } from 'typebox/value';
import { structuredSlotTreeCursorSchema } from '../../shared/api-schemas';
import type { StructuredSlotTreeCursorV1 } from '../../shared/structured-slots';
import type { CoreService } from '../core-service';
import { ApiError, sendJson, type ApiRoute, type ApiRouteContext } from './router';

/** Default page size and its hard cap for the paged endpoints. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function queryParams(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://forge-core.local').searchParams;
}

/** Rejects every query parameter on the detail endpoints (owner is the only subject). */
function rejectAllQueryParams(req: IncomingMessage, where: string): void {
  const params = queryParams(req);
  for (const key of params.keys()) {
    throw new ApiError(
      'INVALID_INPUT',
      `结构化只读接口不接受查询参数 ${key}。`,
      where,
      '移除查询参数后重试。',
    );
  }
}

/**
 * Allows ONLY `cursor` and `limit` on the paged endpoints. Any other key is a
 * rejected profile/principal injection attempt (v1 has exactly one subject:
 * the built-in task_owner).
 */
function rejectForeignQueryParams(req: IncomingMessage, where: string): void {
  const params = queryParams(req);
  for (const key of params.keys()) {
    if (key === 'cursor' || key === 'limit') continue;
    throw new ApiError(
      'INVALID_INPUT',
      `结构化只读接口不接受查询参数 ${key}。`,
      where,
      '移除查询参数后重试。',
    );
  }
}

function parseLimit(req: IncomingMessage, where: string): number {
  const raw = queryParams(req).get('limit');
  if (raw === null) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new ApiError('INVALID_INPUT', 'limit 必须是 1 到 200 之间的整数。', where, '调整 limit 后重试。');
  }
  return parsed;
}

/** Parses and exact-validates the signed JSON cursor; malformed → CURSOR_INVALID. */
function parseCursor(req: IncomingMessage, where: string): StructuredSlotTreeCursorV1 | null {
  const raw = queryParams(req).get('cursor');
  if (raw === null || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError('CURSOR_INVALID', '分页游标不是有效 JSON。', where, '返回第一页重试。');
  }
  if (!Value.Check(structuredSlotTreeCursorSchema, parsed)) {
    throw new ApiError('CURSOR_INVALID', '分页游标不符合契约。', where, '返回第一页重试。');
  }
  return parsed as StructuredSlotTreeCursorV1;
}

function contractRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'structured-slots', 'contract'],
    async handle({ service, req, params, res }: ApiRouteContext) {
      rejectAllQueryParams(req, 'structuredSlots.contract');
      sendJson(res, 200, await service.getStructuredContract(params.taskId));
    },
  };
}

function treeRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'structured-slots', 'tree'],
    async handle({ service, req, params, res }: ApiRouteContext) {
      rejectForeignQueryParams(req, 'structuredSlots.tree');
      const cursor = parseCursor(req, 'structuredSlots.tree');
      const limit = parseLimit(req, 'structuredSlots.tree');
      sendJson(res, 200, await service.listStructuredSlots(params.taskId, cursor, limit));
    },
  };
}

function slotRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'structured-slots', 'slots', ':slotId'],
    async handle({ service, req, params, res }: ApiRouteContext) {
      rejectAllQueryParams(req, 'structuredSlots.slot');
      sendJson(res, 200, await service.getStructuredSlot(params.taskId, params.slotId));
    },
  };
}

function issuesRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'structured-slots', 'issues'],
    async handle({ service, req, params, res }: ApiRouteContext) {
      rejectForeignQueryParams(req, 'structuredSlots.issues');
      const cursor = parseCursor(req, 'structuredSlots.issues');
      const limit = parseLimit(req, 'structuredSlots.issues');
      sendJson(res, 200, await service.listStructuredIssues(params.taskId, cursor, limit));
    },
  };
}

function sealRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'structured-slots', 'seal'],
    async handle({ service, req, params, res }: ApiRouteContext) {
      rejectAllQueryParams(req, 'structuredSlots.seal');
      sendJson(res, 200, await service.getStructuredSeal(params.taskId));
    },
  };
}

/**
 * Registers the five read-only structured slot routes. Every response is an
 * exact TypeBox schema owned by `src/shared/api-schemas.ts` and decoded by the
 * HttpGateway before it reaches React.
 */
export function structuredSlotRoutes(): ApiRoute[] {
  return [contractRoute(), treeRoute(), slotRoute(), issuesRoute(), sealRoute()];
}
