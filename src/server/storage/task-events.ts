/**
 * Canonical task event union and fail-closed validation (plan Phase B Task 4).
 *
 * This is the single authoritative payload contract shared by the event store
 * (validates before writing and treats anything outside the union as
 * corruption on read), the projector (folds the union into the frozen
 * workspace shape) and the Phase C committer (the only event producer). Every
 * member carries exactly `id` (a stable, filename-safe identifier), `at` (a
 * parseable ISO timestamp) and its declared payload fields — unknown extra
 * keys are rejected at the event level and inside nested node/route/artifact
 * payloads, so committed history can never drift away from what the projector
 * understands (spec §8.1, §8.3).
 *
 * No business vocabulary lives here (iron rule 1): member names are stable
 * platform identifiers and payloads carry opaque node/route/artifact data.
 */
import type { NodeKind, RouteKind } from '../../shared/contracts';
import { STORAGE_ERROR_CODES, StorageError } from './atomic-file';

/** Event ids become part of committed filenames; safe segment, no traversal. */
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

const NODE_KINDS: readonly string[] = ['input', 'result', 'human_request', 'human_answer', 'skill'];

const NODE_STATUSES: readonly string[] = ['confirmed', 'active', 'failed'];

const ROUTE_KINDS: readonly string[] = ['message', 'artifact'];

const ARTIFACT_FORMATS: readonly string[] = ['markdown', 'text'];

/** Authorized `task_incompatible` reasons (plan 2026-08-04 Task 3). */
const INCOMPATIBLE_REASONS: readonly string[] = ['TURN_CONTRACT_REQUIRED'];

export interface EventNode {
  sequence: number;
  agentId: string;
  kind: NodeKind;
  title: string;
  body: string;
  status: 'confirmed' | 'active' | 'failed';
  attemptCount: number;
  artifactVersion: number | null;
}

export interface EventRoute {
  sequence: number;
  fromNodeId: string;
  toNodeId: string;
  kind: RouteKind;
  label: string;
}

/** Artifact metadata recorded by `artifact_published` (body stays in the store). */
export interface EventArtifact {
  version: number;
  title: string;
  sourceNodeId: string;
  format: 'markdown' | 'text';
  contentHash: string;
}

interface EventBase {
  id: string;
  at: string;
}

export type TaskEvent =
  | (EventBase & { type: 'task_started' })
  | (EventBase & { type: 'task_stopped' })
  | (EventBase & { type: 'task_resumed' })
  | (EventBase & { type: 'task_interrupted' })
  | (EventBase & { type: 'task_completed' })
  | (EventBase & {
      type: 'task_incompatible';
      /**
       * Why the frozen task is non-runnable (plan 2026-08-04 Task 3, spec
       * §7.3). `TURN_CONTRACT_REQUIRED`: the snapshot predates the turn
       * contract and can only be viewed or cloned onto the current template.
       */
      reason: 'TURN_CONTRACT_REQUIRED';
    })
  | (EventBase & { type: 'agent_input'; node: EventNode })
  | (EventBase & { type: 'agent_result'; node: EventNode })
  | (EventBase & {
      type: 'agent_attempt_failed';
      nodeId: string;
      message: string;
      retryable: boolean;
    })
  | (EventBase & {
      type: 'retry_scheduled';
      nodeId: string;
      delayMs: number;
      attempt: number;
    })
  | (EventBase & { type: 'route_executed'; route: EventRoute })
  | (EventBase & { type: 'artifact_published'; artifact: EventArtifact })
  | (EventBase & { type: 'human_requested'; node: EventNode; question: string })
  | (EventBase & { type: 'human_answered'; node: EventNode; answer: string })
  | (EventBase & { type: 'final_submission_accepted'; artifactId: string; version: number })
  | (EventBase & { type: 'skill_loaded'; skillId: string });

function invalidEvent(message: string): StorageError {
  return new StorageError(STORAGE_ERROR_CODES.EVENT_INVALID, message, null, '修正事件内容后重试。');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Rejects any own key outside the declared field set (also catches undefined). */
function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalidEvent(`${where} 含有未声明的字段 ${key}。`);
    }
  }
}

function assertNonEmptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidEvent(`${where} 必须是非空字符串。`);
  }
  return value;
}

/** Integer >= 1, rejecting NaN/Infinity/floats implicitly. */
function assertPositiveInteger(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalidEvent(`${where} 必须是不小于 1 的整数。`);
  }
  return value;
}

function assertOneOf(value: unknown, allowed: readonly string[], where: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw invalidEvent(`${where} 必须是 ${allowed.join('/')} 之一。`);
  }
  return value;
}

const NODE_KEYS = new Set([
  'sequence',
  'agentId',
  'kind',
  'title',
  'body',
  'status',
  'attemptCount',
  'artifactVersion',
]);

function validateEventNode(value: unknown, where: string): EventNode {
  if (!isPlainObject(value)) {
    throw invalidEvent(`${where} 必须是对象。`);
  }
  assertExactKeys(value, NODE_KEYS, where);
  let artifactVersion: number | null;
  if (value.artifactVersion === null) {
    artifactVersion = null;
  } else {
    artifactVersion = assertPositiveInteger(value.artifactVersion, `${where}.artifactVersion`);
  }
  if (typeof value.body !== 'string') {
    throw invalidEvent(`${where}.body 必须是字符串。`);
  }
  return {
    sequence: assertPositiveInteger(value.sequence, `${where}.sequence`),
    agentId: assertNonEmptyString(value.agentId, `${where}.agentId`),
    kind: assertOneOf(value.kind, NODE_KINDS, `${where}.kind`) as NodeKind,
    title: assertNonEmptyString(value.title, `${where}.title`),
    body: value.body,
    status: assertOneOf(value.status, NODE_STATUSES, `${where}.status`) as EventNode['status'],
    attemptCount: assertPositiveInteger(value.attemptCount, `${where}.attemptCount`),
    artifactVersion,
  };
}

const ROUTE_KEYS = new Set(['sequence', 'fromNodeId', 'toNodeId', 'kind', 'label']);

function validateEventRoute(value: unknown, where: string): EventRoute {
  if (!isPlainObject(value)) {
    throw invalidEvent(`${where} 必须是对象。`);
  }
  assertExactKeys(value, ROUTE_KEYS, where);
  return {
    sequence: assertPositiveInteger(value.sequence, `${where}.sequence`),
    fromNodeId: assertNonEmptyString(value.fromNodeId, `${where}.fromNodeId`),
    toNodeId: assertNonEmptyString(value.toNodeId, `${where}.toNodeId`),
    kind: assertOneOf(value.kind, ROUTE_KINDS, `${where}.kind`) as RouteKind,
    label: assertNonEmptyString(value.label, `${where}.label`),
  };
}

const ARTIFACT_KEYS = new Set(['version', 'title', 'sourceNodeId', 'format', 'contentHash']);

function validateEventArtifact(value: unknown, where: string): EventArtifact {
  if (!isPlainObject(value)) {
    throw invalidEvent(`${where} 必须是对象。`);
  }
  assertExactKeys(value, ARTIFACT_KEYS, where);
  const contentHash = assertNonEmptyString(value.contentHash, `${where}.contentHash`);
  if (!CONTENT_HASH_PATTERN.test(contentHash)) {
    throw invalidEvent(`${where}.contentHash 必须是 64 位十六进制 SHA-256。`);
  }
  return {
    version: assertPositiveInteger(value.version, `${where}.version`),
    title: assertNonEmptyString(value.title, `${where}.title`),
    sourceNodeId: assertNonEmptyString(value.sourceNodeId, `${where}.sourceNodeId`),
    format: assertOneOf(value.format, ARTIFACT_FORMATS, `${where}.format`) as EventArtifact['format'],
    contentHash,
  };
}

const BASE_KEYS = ['id', 'at', 'type'] as const;

function baseAnd(...fields: string[]): ReadonlySet<string> {
  return new Set([...BASE_KEYS, ...fields]);
}

const MEMBER_KEYS: Record<string, ReadonlySet<string>> = {
  task_started: baseAnd(),
  task_stopped: baseAnd(),
  task_resumed: baseAnd(),
  task_interrupted: baseAnd(),
  task_completed: baseAnd(),
  task_incompatible: baseAnd('reason'),
  agent_input: baseAnd('node'),
  agent_result: baseAnd('node'),
  agent_attempt_failed: baseAnd('nodeId', 'message', 'retryable'),
  retry_scheduled: baseAnd('nodeId', 'delayMs', 'attempt'),
  route_executed: baseAnd('route'),
  artifact_published: baseAnd('artifact'),
  human_requested: baseAnd('node', 'question'),
  human_answered: baseAnd('node', 'answer'),
  final_submission_accepted: baseAnd('artifactId', 'version'),
  skill_loaded: baseAnd('skillId'),
};

/**
 * Validates one unknown payload against the canonical union and returns it
 * narrowed to `TaskEvent`. Fails loud with a public EVENT_INVALID error
 * before anything touches the filesystem; every member field is rebuilt from
 * the validated values, so a returned event only ever carries declared keys.
 */
export function validateTaskEvent(candidate: unknown): TaskEvent {
  if (!isPlainObject(candidate)) {
    throw invalidEvent('事件必须是对象。');
  }
  const id = assertNonEmptyString(candidate.id, '事件 id');
  if (!EVENT_ID_PATTERN.test(id)) {
    throw invalidEvent('事件 id 必须是稳定的文件安全标识。');
  }
  const at = assertNonEmptyString(candidate.at, '事件 at');
  if (Number.isNaN(Date.parse(at))) {
    throw invalidEvent('事件 at 必须是可解析的时间戳。');
  }
  if (typeof candidate.type !== 'string') {
    throw invalidEvent('事件 type 必须是字符串。');
  }
  const allowed = MEMBER_KEYS[candidate.type];
  if (allowed === undefined) {
    throw invalidEvent(`未知事件类型 ${candidate.type}。`);
  }
  assertExactKeys(candidate, allowed, '事件');
  const type = candidate.type;
  switch (type) {
    case 'task_started':
    case 'task_stopped':
    case 'task_resumed':
    case 'task_interrupted':
    case 'task_completed':
      return { id, at, type };
    case 'task_incompatible':
      return {
        id,
        at,
        type,
        reason: assertOneOf(
          candidate.reason,
          INCOMPATIBLE_REASONS,
          '事件 reason',
        ) as 'TURN_CONTRACT_REQUIRED',
      };
    case 'agent_input':
    case 'agent_result':
      return { id, at, type, node: validateEventNode(candidate.node, '事件 node') };
    case 'agent_attempt_failed': {
      if (typeof candidate.retryable !== 'boolean') {
        throw invalidEvent('事件 retryable 必须是布尔值。');
      }
      return {
        id,
        at,
        type,
        nodeId: assertNonEmptyString(candidate.nodeId, '事件 nodeId'),
        message: assertNonEmptyString(candidate.message, '事件 message'),
        retryable: candidate.retryable,
      };
    }
    case 'retry_scheduled':
      return {
        id,
        at,
        type,
        nodeId: assertNonEmptyString(candidate.nodeId, '事件 nodeId'),
        delayMs: assertPositiveInteger(candidate.delayMs, '事件 delayMs'),
        attempt: assertPositiveInteger(candidate.attempt, '事件 attempt'),
      };
    case 'route_executed':
      return { id, at, type, route: validateEventRoute(candidate.route, '事件 route') };
    case 'artifact_published':
      return { id, at, type, artifact: validateEventArtifact(candidate.artifact, '事件 artifact') };
    case 'human_requested':
      return {
        id,
        at,
        type,
        node: validateEventNode(candidate.node, '事件 node'),
        question: assertNonEmptyString(candidate.question, '事件 question'),
      };
    case 'human_answered':
      return {
        id,
        at,
        type,
        node: validateEventNode(candidate.node, '事件 node'),
        answer: assertNonEmptyString(candidate.answer, '事件 answer'),
      };
    case 'final_submission_accepted':
      return {
        id,
        at,
        type,
        artifactId: assertNonEmptyString(candidate.artifactId, '事件 artifactId'),
        version: assertPositiveInteger(candidate.version, '事件 version'),
      };
    case 'skill_loaded':
      return { id, at, type, skillId: assertNonEmptyString(candidate.skillId, '事件 skillId') };
    default:
      throw invalidEvent(`未知事件类型 ${type}。`);
  }
}
