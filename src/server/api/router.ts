/**
 * Typed JSON API router (plan Phase B Task 5).
 *
 * The single dispatch point for every `/api` request. Routes are declared in
 * `template-routes.ts` / `task-routes.ts` / `artifact-routes.ts` and consume
 * only the CoreService — never storage internals or the filesystem (spec
 * §15.4 module boundary). Errors leave exclusively as the public envelope
 * `{ error: PublicCoreError }` with a stable status code per known code;
 * unknown causes collapse to INTERNAL_ERROR with a correlation id that is the
 * only thing logged alongside the code (never headers, env values or raw
 * causes — iron rule 6).
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PublicCoreError } from '../../shared/errors';
import type { CoreService } from '../core-service';
import { CorePathError } from '../storage/core-paths';
import { artifactRoutes } from './artifact-routes';
import { authoritativeReviewRoutes } from './authoritative-review-routes';
import { structuredSlotRoutes } from './structured-slot-routes';
import { taskRoutes } from './task-routes';
import { templateRoutes } from './template-routes';

/** API-local public error codes (storage/template codes are mapped too). */
export const API_ERROR_CODES = {
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  BAD_REQUEST: 'BAD_REQUEST',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  RUNTIME_NOT_CONNECTED: 'RUNTIME_NOT_CONNECTED',
  ARTIFACT_VERSION_NOT_FOUND: 'ARTIFACT_VERSION_NOT_FOUND',
} as const;

/** Public error thrown by route handlers; serialized through the same map. */
export class ApiError extends Error implements PublicCoreError {
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
    this.name = 'ApiError';
    this.code = code;
    this.location = location;
    this.action = action;
  }
}

/** Request bodies above this size are rejected before parsing. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Stable error-code → HTTP-status mapping. TASK_CORRUPTED is pinned to 422
 * (the request is well-formed but the resource is semantically unusable);
 * every code the platform can surface appears here.
 */
export const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  TEMPLATE_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  NOT_FOUND: 404,
  ARTIFACT_VERSION_NOT_FOUND: 404,
  TRACE_NOT_FOUND: 404,
  SKILL_NOT_FOUND: 404,
  SLOT_NOT_VISIBLE: 404,
  SEAL_NOT_FOUND: 404,
  STRUCTURED_NOT_ACTIVE: 404,
  CURSOR_INVALID: 409,
  INVALID_INPUT: 400,
  EVENT_INVALID: 400,
  BAD_REQUEST: 400,
  CORE_PATH_INVALID: 400,
  RUNTIME_NOT_CONNECTED: 503,
  TEMPLATE_RUNTIME_UNAVAILABLE: 503,
  TASK_ALREADY_RUNNING: 409,
  INVALID_TRANSITION: 409,
  FILE_EXISTS: 409,
  EVENT_ID_CONFLICT: 409,
  TASK_CORRUPTED: 422,
  TASK_CONTRACT_INCOMPATIBLE: 422,
  TEMPLATE_INVALID: 422,
  TEMPLATE_DUPLICATE_KEY: 422,
  TEMPLATE_ROUTE_SOURCE_UNKNOWN: 422,
  TEMPLATE_ROUTE_TARGET_UNKNOWN: 422,
  TEMPLATE_FINAL_SUBMITTER_UNKNOWN: 422,
  TEMPLATE_SKILL_MISSING: 422,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL_ERROR: 500,
  /* Task 11 v2 lifecycle codes (spec §10.3.1/§10.5/§10.6/§14.3). */
  AUTHORITATIVE_REVIEW_UNAVAILABLE: 503,
  /* Task 23 v2 read codes (spec §14.2): cursor issues map to a stable 409. */
  CURSOR_STALE: 409,
  USE_RESUME: 409,
  AUTHORITY_BASE_STALE: 409,
  HUMAN_QUESTION_STALE: 409,
  OPERATION_CONFLICT: 409,
  DELETE_CONFLICT: 409,
  TASK_DELETED: 409,
  TASK_TERMINAL: 409,
  MIGRATION_INCOMPLETE: 503,
  ID_UNAVAILABLE: 409,
  LOCK_BUSY: 409,
  PIN_CONFLICT: 409,
  TASK_CORRUPT: 422,
  DELETE_NOT_FOUND: 400,
  ENTRY_NOT_FOUND: 409,
  ENTRY_STATE_CONFLICT: 422,
};

export interface ApiRouteContext {
  service: CoreService;
  req: IncomingMessage;
  res: ServerResponse;
  /** Decoded `:param` captures of the request path. */
  params: Record<string, string>;
}

export interface ApiRoute {
  method: 'GET' | 'POST' | 'DELETE';
  /** Literal segments; `:name` captures one segment into params. */
  segments: readonly string[];
  handle(context: ApiRouteContext): Promise<void> | void;
}

export interface ApiRouter {
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): void;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function writeEnvelope(
  res: ServerResponse,
  status: number,
  error: PublicCoreError,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify({ error });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function isPublicErrorShape(error: unknown): error is PublicCoreError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Record<string, unknown>;
  return (
    typeof candidate.code === 'string' &&
    candidate.code.length > 0 &&
    typeof candidate.message === 'string' &&
    (candidate.location === null || typeof candidate.location === 'string') &&
    (candidate.action === null || typeof candidate.action === 'string')
  );
}

/**
 * Serializes any handler failure into the public envelope. Known public
 * codes keep their stable status; everything else becomes INTERNAL_ERROR and
 * logs only the code plus a generated correlation id.
 */
export function sendMappedError(res: ServerResponse, error: unknown): void {
  if (error instanceof CorePathError) {
    writeEnvelope(res, 400, {
      code: error.code,
      message: '请求参数包含非法标识符。',
      location: null,
      action: '返回上一页后重试。',
    });
    return;
  }
  if (isPublicErrorShape(error)) {
    const status = STATUS_BY_CODE[error.code];
    if (status !== undefined) {
      writeEnvelope(res, status, {
        code: error.code,
        message: error.message,
        location: error.location,
        action: error.action,
      });
      return;
    }
  }
  const correlationId = randomUUID();
  // Log only code + correlation id: never messages, headers, env or causes.
  console.error(
    `forge-core: request failed code=${API_ERROR_CODES.INTERNAL_ERROR} correlation=${correlationId}`,
  );
  writeEnvelope(res, 500, {
    code: API_ERROR_CODES.INTERNAL_ERROR,
    message: '服务器内部错误。',
    location: null,
    action: '稍后重试。',
  });
}

/** Reads the whole request body; rejects once it exceeds the 1 MiB limit. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on('data', (chunk: Buffer) => {
      if (oversized) return; // keep draining so the response can still flush
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) {
        reject(
          new ApiError(
            API_ERROR_CODES.PAYLOAD_TOO_LARGE,
            '请求体超过 1 MiB 上限。',
            null,
            '减小请求体后重试。',
          ),
        );
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      reject(new ApiError(API_ERROR_CODES.BAD_REQUEST, '请求读取失败。', null, '重试。'));
    });
  });
}

/** Reads a JSON object body; malformed JSON or non-objects are INVALID_INPUT. */
export async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) {
    throw new ApiError(
      'INVALID_INPUT',
      '请求体必须是 JSON 对象。',
      null,
      '提交合法的 JSON 请求体。',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError(
      'INVALID_INPUT',
      '请求体不是有效 JSON。',
      null,
      '提交合法的 JSON 请求体。',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError('INVALID_INPUT', '请求体必须是 JSON 对象。', null, '提交合法的 JSON 请求体。');
  }
  return parsed as Record<string, unknown>;
}

function splitSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

function matchSegments(
  pattern: readonly string[],
  segments: readonly string[],
): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index];
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = segments[index];
    } else if (expected !== segments[index]) {
      return null;
    }
  }
  return params;
}

const HEALTH_ROUTE: ApiRoute = {
  method: 'GET',
  segments: ['api', 'health'],
  handle({ res }) {
    sendJson(res, 200, { ok: true, service: 'forge-core', mode: 'http' });
  },
};

export function createApiRouter(service: CoreService): ApiRouter {
  const routes: ApiRoute[] = [
    HEALTH_ROUTE,
    ...templateRoutes(),
    ...taskRoutes(),
    ...templateRoutes(),
    ...taskRoutes(),
    ...artifactRoutes(),
    // v2 authoritative review routes registered BEFORE the v1 structured-slot
    // routes: the `/structured-slots/tree` path is shared, and the v2 tree
    // handler dispatches by frozen task protocol (v2 -> v2 parent pages,
    // v1/basic -> delegates to the v1 outline). Registering first lets it own
    // that shared path; every other v2 path (map, review/*, locate) has no v1
    // meaning and rejects non-v2 tasks with AUTHORITATIVE_REVIEW_UNAVAILABLE.
    ...authoritativeReviewRoutes(),
    ...structuredSlotRoutes(),
  ];

  async function dispatch(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    let segments: string[];
    try {
      segments = splitSegments(pathname);
    } catch {
      writeEnvelope(res, 400, {
        code: API_ERROR_CODES.BAD_REQUEST,
        message: '请求 URL 无效。',
        location: null,
        action: '检查请求路径后重试。',
      });
      return;
    }
    const matching: Array<{ route: ApiRoute; params: Record<string, string> }> = [];
    for (const route of routes) {
      const params = matchSegments(route.segments, segments);
      if (params !== null) matching.push({ route, params });
    }
    if (matching.length === 0) {
      writeEnvelope(res, 404, {
        code: API_ERROR_CODES.NOT_FOUND,
        message: 'forge-core: this API route does not exist',
        location: null,
        action: null,
      });
      return;
    }
    const hit = matching.find((entry) => entry.route.method === req.method);
    if (hit === undefined) {
      const allowed = [...new Set(matching.map((entry) => entry.route.method))].join(', ');
      writeEnvelope(
        res,
        405,
        {
          code: API_ERROR_CODES.METHOD_NOT_ALLOWED,
          message: 'forge-core: this API route does not accept the requested method',
          location: null,
          action: null,
        },
        { Allow: allowed },
      );
      return;
    }
    try {
      await hit.route.handle({ service, req, res, params: hit.params });
    } catch (error) {
      sendMappedError(res, error);
    }
  }

  return {
    handle(req, res, pathname) {
      void dispatch(req, res, pathname);
    },
  };
}
