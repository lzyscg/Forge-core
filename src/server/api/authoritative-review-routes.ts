/**
 * Task 23: authoritative per-slot review v2 read-only routes (spec §14.1).
 *
 * Eleven GET endpoints expose the owner read-only projection: map, candidate,
 * tree (parent pages), tree/locate (ancestor path + seek cursors), map-rounds,
 * review/summary, review/rounds, review/slots/:id, review/relations/:id,
 * review/findings and review/seal-readiness. Every cursor-paginated endpoint
 * uses the authenticated snapshot cursor and the frozen stable sort.
 *
 * Authorization / semantics:
 * - Basic / v1 tasks reject with the stable AUTHORITATIVE_REVIEW_UNAVAILABLE.
 * - Reads work on ANY v2 task regardless of capability state: historical
 *   reads use the task-frozen profile (spec §4.3), so the read API is
 *   available even while the authoritative capability is disabled.
 * - Cursor-invalid (tamper/retired/query-identity change/corruption) maps to
 *   a stable public 409. Missing slots map to the identical SLOT_NOT_VISIBLE.
 * - The actor is always the built-in `task_owner` principal: no profile/ACL/
 *   grant/subject may be supplied through query parameters.
 */
import type { IncomingMessage } from 'node:http';
import { Value } from 'typebox/value';
import { structuredProtocolOf } from '../../shared/authoritative-review-v2';
import { snapshotCursorV2Schema, structuredSlotTreeCursorSchema } from '../../shared/api-schemas';
import type { StructuredSlotTreeCursorV1 } from '../../shared/structured-slots';
import type { SnapshotCursorV2 } from '../../shared/authoritative-review-v2';
import { ApiError, sendJson, type ApiRoute, type ApiRouteContext } from './router';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function queryParams(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://forge-core.local').searchParams;
}

/** Rejects every query parameter on the detail endpoints. */
function rejectAllQueryParams(req: IncomingMessage, where: string): void {
  const params = queryParams(req);
  for (const key of params.keys()) {
    throw new ApiError('INVALID_INPUT', `权威评审只读接口不接受查询参数 ${key}。`, where, '移除查询参数后重试。');
  }
}

/** Allows ONLY the pagination/selection query params on the paged endpoints. */
function rejectForeignQueryParams(req: IncomingMessage, where: string): void {
  const params = queryParams(req);
  for (const key of params.keys()) {
    if (key === 'limit' || key === 'after' || key === 'parentId' || key === 'snapshotCursor') continue;
    throw new ApiError('INVALID_INPUT', `权威评审只读接口不接受查询参数 ${key}。`, where, '移除查询参数后重试。');
  }
}

function parseLimit(req: IncomingMessage, where: string): number {
  const raw = queryParams(req).get('limit');
  if (raw === null) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new ApiError('INVALID_INPUT', `limit 必须是 1 到 ${MAX_LIMIT} 之间的整数。`, where, '调整 limit 后重试。');
  }
  return parsed;
}

/** Parses and exact-validates the authenticated snapshot cursor; malformed → CURSOR_STALE. */
function parseSnapshotCursor(req: IncomingMessage, where: string): SnapshotCursorV2 | null {
  const raw = queryParams(req).get('snapshotCursor') ?? queryParams(req).get('after');
  if (raw === null || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError('CURSOR_STALE', '分页快照游标不是有效 JSON。', where, '返回第一页重试。');
  }
  if (!Value.Check(snapshotCursorV2Schema, parsed)) {
    throw new ApiError('CURSOR_STALE', '分页快照游标不符合契约。', where, '返回第一页重试。');
  }
  return parsed as SnapshotCursorV2;
}

function parseParentId(req: IncomingMessage, where: string): string | null {
  const raw = queryParams(req).get('parentId');
  if (raw === null || raw.length === 0) return null;
  return raw;
}

function mapRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'structured-slots', 'map'],
    async handle({ service, req, params, res }: ApiRouteContext) {
      rejectAllQueryParams(req, 'authoritativeReview.map');
      sendJson(res, 200, await service.authoritativeMap(params.taskId));
    },
  };
}

function candidateRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'structured-slots', 'map', 'candidate'],
    async handle({ service, req, params, res }: ApiRouteContext) {
      rejectAllQueryParams(req, 'authoritativeReview.candidate');
      sendJson(res, 200, await service.authoritativeCandidate(params.taskId));
    },
  };
}

function treeRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'structured-slots', 'tree'],
    async handle({ service, req, params, res }: ApiRouteContext) {
      // `/structured-slots/tree` is shared between v1 and v2 (spec §14.1). The
      // v2 route owns the path: it dispatches on the FROZEN task protocol —
      // v2 tasks use parent pages with snapshot cursors; v1/basic tasks fall
      // through to the v1 owner outline (delegating to CoreService, identical
      // behavior to the v1 route).
      const frozen = await service.tasks.readFrozenTemplate(params.taskId);
      if (structuredProtocolOf(frozen) !== 'v2') {
        // v1 tree: accept cursor/limit only.
        for (const key of queryParams(req).keys()) {
          if (key === 'cursor' || key === 'limit') continue;
          throw new ApiError('INVALID_INPUT', `结构化只读接口不接受查询参数 ${key}。`, 'structuredSlots.tree', '移除查询参数后重试。');
        }
        const rawCursor = queryParams(req).get('cursor');
        let cursor: StructuredSlotTreeCursorV1 | null = null;
        if (rawCursor !== null && rawCursor.length > 0) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawCursor);
          } catch {
            throw new ApiError('CURSOR_INVALID', '分页游标不是有效 JSON。', 'structuredSlots.tree', '返回第一页重试。');
          }
          if (!Value.Check(structuredSlotTreeCursorSchema, parsed)) {
            throw new ApiError('CURSOR_INVALID', '分页游标不符合契约。', 'structuredSlots.tree', '返回第一页重试。');
          }
          cursor = parsed as StructuredSlotTreeCursorV1;
        }
        const limit = parseLimit(req, 'structuredSlots.tree');
        sendJson(res, 200, await service.listStructuredSlots(params.taskId, cursor, limit));
        return;
      }
      rejectForeignQueryParams(req, 'authoritativeReview.tree');
      const parentId = parseParentId(req, 'authoritativeReview.tree');
      const limit = parseLimit(req, 'authoritativeReview.tree');
      const after = parseSnapshotCursor(req, 'authoritativeReview.tree');
      sendJson(res, 200, await service.authoritativeTree(params.taskId, parentId, limit, after));
    },
  };
}

function locateRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'structured-slots', 'tree', 'locate', ':slotId'],
    async handle({ service, req, params, res }: ApiRouteContext) {
      rejectForeignQueryParams(req, 'authoritativeReview.locate');
      const snapshotCursor = parseSnapshotCursor(req, 'authoritativeReview.locate');
      sendJson(res, 200, await service.authoritativeLocate(params.taskId, params.slotId, snapshotCursor));
    },
  };
}

function mapRoundsRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'structured-slots', 'review', 'map-rounds'],
    async handle({ service, req, params, res }: ApiRouteContext) {
      rejectForeignQueryParams(req, 'authoritativeReview.mapRounds');
      const limit = parseLimit(req, 'authoritativeReview.mapRounds');
      const after = parseSnapshotCursor(req, 'authoritativeReview.mapRounds');
      sendJson(res, 200, await service.authoritativeMapRounds(params.taskId, limit, after));
    },
  };
}

function summaryRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'structured-slots', 'review', 'summary'],
    async handle({ service, req, params, res }: ApiRouteContext) {
      rejectAllQueryParams(req, 'authoritativeReview.summary');
      sendJson(res, 200, await service.authoritativeReviewSummary(params.taskId));
    },
  };
}

function roundsRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'structured-slots', 'review', 'rounds'],
    async handle({ service, req, params, res }: ApiRouteContext) {
      rejectForeignQueryParams(req, 'authoritativeReview.rounds');
      const limit = parseLimit(req, 'authoritativeReview.rounds');
      const after = parseSnapshotCursor(req, 'authoritativeReview.rounds');
      sendJson(res, 200, await service.authoritativeRounds(params.taskId, limit, after));
    },
  };
}

function slotsRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'structured-slots', 'review', 'slots', ':slotId'],
    async handle({ service, req, params, res }: ApiRouteContext) {
      rejectForeignQueryParams(req, 'authoritativeReview.slot');
      const snapshotCursor = parseSnapshotCursor(req, 'authoritativeReview.slot');
      sendJson(res, 200, await service.authoritativeSlotReview(params.taskId, params.slotId, snapshotCursor));
    },
  };
}

function relationsRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'structured-slots', 'review', 'relations', ':relationId'],
    async handle({ service, req, params, res }: ApiRouteContext) {
      rejectForeignQueryParams(req, 'authoritativeReview.relation');
      const snapshotCursor = parseSnapshotCursor(req, 'authoritativeReview.relation');
      sendJson(res, 200, await service.authoritativeRelationReview(params.taskId, params.relationId, snapshotCursor));
    },
  };
}

function findingsRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'structured-slots', 'review', 'findings'],
    async handle({ service, req, params, res }: ApiRouteContext) {
      rejectForeignQueryParams(req, 'authoritativeReview.findings');
      const limit = parseLimit(req, 'authoritativeReview.findings');
      const after = parseSnapshotCursor(req, 'authoritativeReview.findings');
      sendJson(res, 200, await service.authoritativeFindings(params.taskId, limit, after));
    },
  };
}

function sealReadinessRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'structured-slots', 'review', 'seal-readiness'],
    async handle({ service, req, params, res }: ApiRouteContext) {
      rejectAllQueryParams(req, 'authoritativeReview.sealReadiness');
      sendJson(res, 200, await service.authoritativeSealReadiness(params.taskId));
    },
  };
}

function issuesRoute(): ApiRoute {
  return {
    method: 'GET',
    segments: ['api', 'tasks', ':taskId', 'structured-slots', 'issues'],
    async handle({ service, req, params, res }: ApiRouteContext) {
      // `/structured-slots/issues` is shared (spec §14.1 "existing issues route
      // projects current v2 Findings ... for compatibility"). Protocol-dispatch:
      // v2 tasks get the v2 issues projection; v1/basic fall through to the v1
      // owner issues (identical behavior to the v1 route).
      const frozen = await service.tasks.readFrozenTemplate(params.taskId);
      if (structuredProtocolOf(frozen) !== 'v2') {
        for (const key of queryParams(req).keys()) {
          if (key === 'cursor' || key === 'limit') continue;
          throw new ApiError('INVALID_INPUT', `结构化只读接口不接受查询参数 ${key}。`, 'structuredSlots.issues', '移除查询参数后重试。');
        }
        const rawCursor = queryParams(req).get('cursor');
        let cursor: StructuredSlotTreeCursorV1 | null = null;
        if (rawCursor !== null && rawCursor.length > 0) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawCursor);
          } catch {
            throw new ApiError('CURSOR_INVALID', '分页游标不是有效 JSON。', 'structuredSlots.issues', '返回第一页重试。');
          }
          if (!Value.Check(structuredSlotTreeCursorSchema, parsed)) {
            throw new ApiError('CURSOR_INVALID', '分页游标不符合契约。', 'structuredSlots.issues', '返回第一页重试。');
          }
          cursor = parsed as StructuredSlotTreeCursorV1;
        }
        const limit = parseLimit(req, 'structuredSlots.issues');
        sendJson(res, 200, await service.listStructuredIssues(params.taskId, cursor, limit));
        return;
      }
      rejectForeignQueryParams(req, 'authoritativeReview.issues');
      sendJson(res, 200, { issues: await service.authoritativeIssues(params.taskId) });
    },
  };
}

/**
 * Registers the twelve v2 read/projection routes (spec §14.1): the eleven
 * documented GET endpoints plus the legacy-compatible `/issues` projection.
 * Mutations (answer/delete/reopen_failed) live in `task-routes.ts` where the
 * frozen protocol dispatches them; they are not duplicated here.
 */
export function authoritativeReviewRoutes(): ApiRoute[] {
  return [
    mapRoute(),
    candidateRoute(),
    treeRoute(),
    locateRoute(),
    mapRoundsRoute(),
    summaryRoute(),
    roundsRoute(),
    slotsRoute(),
    relationsRoute(),
    findingsRoute(),
    sealReadinessRoute(),
    issuesRoute(),
  ];
}
