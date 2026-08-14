/**
 * Canonical task event union and fail-closed validation (plan Phase B Task 4;
 * v7 artifact version directory schema in plan 2026-08-07 Phase 0).
 *
 * This is the single authoritative payload contract shared by the event store
 * (validates before writing and treats anything outside the union as
 * corruption on read), the projector (folds the union into the frozen
 * workspace shape) and the committer (the only event producer). Every
 * member carries exactly `id` (a stable, filename-safe identifier), `at` (a
 * parseable ISO timestamp) and its declared payload fields — unknown extra
 * keys are rejected at the event level and inside nested node/route/artifact
 * payloads, so committed history can never drift away from what the projector
 * understands (spec §8.1, §8.3).
 *
 * v7 schema additions (spec §3.3/§8.1):
 * - `artifact_annotated {version,file,contentHash,turnId,nodeId}` — reviewer
 *   annotate on an existing version (no bump; atomic staging→event→rename).
 * - `artifact_published.artifact` carries `files:[{name,hash}]` +
 *   `artifactType` + `artifactId` instead of a single contentHash.
 * - `agent_result` carries optional `inputNodeId` + `dispatchKind`
 *   (publish/forward/send/submit/human) for reachability closure and
 *   turn-plan completion detection.
 * - input nodes carry `inputVersion` (was `artifactVersion`) and an optional
 *   `humanAuthorized` flag (only the scheduler accept path may set true).
 * - `pending_inputs_superseded {supersededNodeIds[]}` — the human-intervention
 *   supersede event marks stale pending inputs void.
 * - `task_incompatible.reason` adds `SCHEMA_V2_REQUIRED` for v1 snapshots.
 * - `human_requested` carries an optional `source`
 *   (progress_guard | agent_request) to tell structured decisions from agent
 *   questions.
 *
 * Legacy v1 events are normalized by `normalizeLegacyEvent` in the event
 * store before validation (spec §8.3: only the known migrations); new fields
 * stay optional/nullable so legacy reads never corrupt.
 *
 * No business vocabulary lives here (iron rule 1): member names are stable
 * platform identifiers and payloads carry opaque node/route/artifact data.
 */
import type { NodeKind, RouteKind } from '../../shared/contracts';
import {
  AUTHORITATIVE_REVIEW_EVENT_NAMES_V2,
  validateAuthoritativeReviewEventV2,
  type AuthoritativeReviewEventV2,
} from './authoritative-review-events';
import { STORAGE_ERROR_CODES, StorageError } from './atomic-file';

/** Event ids become part of committed filenames; safe segment, no traversal. */
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

const NODE_KINDS: readonly string[] = ['input', 'result', 'human_request', 'human_answer', 'skill'];

const NODE_STATUSES: readonly string[] = ['confirmed', 'active', 'failed'];

const ROUTE_KINDS: readonly string[] = ['message', 'artifact'];

const ARTIFACT_FORMATS: readonly string[] = ['markdown', 'text'];

/**
 * The dispatch kind a turn performed (spec §8.2). Drives turn-plan
 * completion detection and reachability closure. Legacy events lack it → null.
 */
export type DispatchKind = 'publish' | 'forward' | 'send' | 'submit' | 'human';

const DISPATCH_KINDS: readonly string[] = ['publish', 'forward', 'send', 'submit', 'human'];

/** Where a human request originated (spec §11.5). */
export type HumanRequestSource = 'progress_guard' | 'agent_request';

const HUMAN_REQUEST_SOURCES: readonly string[] = ['progress_guard', 'agent_request'];

/** Authorized `task_incompatible` reasons (spec §3.3, §9). */
const INCOMPATIBLE_REASONS: readonly string[] = [
  'TURN_CONTRACT_REQUIRED',
  'SCHEMA_V2_REQUIRED',
];

/**
 * Structured slot engine lifecycle (spec §7.4/§8.1). Closed value sets: event
 * validation checks each field against its enum; the legal status/reason
 * pairings (e.g. committed/completion_dispatch) are a projection concern.
 */
export type StructuredAttemptStatus = 'committed' | 'failed' | 'abandoned' | 'waiting_human';

export type StructuredAttemptReason =
  | 'completion_dispatch'
  | 'rework_dispatch'
  | 'runtime_failure'
  | 'task_stop'
  | 'crash_recovery'
  | 'human_request';

export type StructuredSessionKind = 'structure' | 'fill' | 'seal';

export type StructuredDraftTerminalStatus = 'merged' | 'stale' | 'abandoned';

export type StructuredBlobKind = 'generation' | 'content_revision' | 'seal_record' | 'validation';

/** Task-local immutable content reference (spec §7.2). */
export interface StructuredBlobRefV1 {
  version: 1;
  kind: StructuredBlobKind;
  sha256: string;
  byteLength: number;
}

const STRUCTURED_ATTEMPT_STATUSES: readonly string[] = [
  'committed',
  'failed',
  'abandoned',
  'waiting_human',
];

const STRUCTURED_ATTEMPT_REASONS: readonly string[] = [
  'completion_dispatch',
  'rework_dispatch',
  'runtime_failure',
  'task_stop',
  'crash_recovery',
  'human_request',
];

const STRUCTURED_SESSION_KINDS: readonly string[] = ['structure', 'fill', 'seal'];

const STRUCTURED_DRAFT_TERMINAL_STATUSES: readonly string[] = ['merged', 'stale', 'abandoned'];

const STRUCTURED_BLOB_KINDS: readonly string[] = [
  'generation',
  'content_revision',
  'seal_record',
  'validation',
];

export interface EventNode {
  sequence: number;
  agentId: string;
  kind: NodeKind;
  title: string;
  body: string;
  status: 'confirmed' | 'active' | 'failed';
  attemptCount: number;
  /**
   * The version this input node carries (spec §8.1; was `artifactVersion`).
   * Propagated along routes at dispatch time; null for non-artifact inputs.
   */
  inputVersion: number | null;
  /**
   * True only when the platform's human-accept path synthesized this input
   * (spec §7.1). Optional; absent → false. The committer's node constructor
   * never sets it, so the only writer is the scheduler accept path.
   */
  humanAuthorized?: boolean;
}

export interface EventRoute {
  sequence: number;
  fromNodeId: string;
  toNodeId: string;
  kind: RouteKind;
  label: string;
}

/** One file recorded by `artifact_published` (spec §3.3). */
export interface EventArtifactFile {
  name: string;
  hash: string;
}

/**
 * Artifact metadata recorded by `artifact_published` (body stays in the
 * store). v7 carries `files[]` + `artifactType` + `artifactId` (spec §8.1);
 * legacy single `contentHash` is normalized to one file entry.
 */
export interface EventArtifact {
  version: number;
  title: string;
  sourceNodeId: string;
  format: 'markdown' | 'text';
  files: EventArtifactFile[];
  /** Artifact type name (from the sealed package); null for legacy. */
  artifactType: string | null;
  /** Artifact id (from the store); null for legacy events. */
  artifactId: string | null;
}

interface EventBase {
  id: string;
  at: string;
}

/** Legacy v1 event members (kept byte-for-byte; v2 members live in the union below). */
export type LegacyTaskEvent =
  | (EventBase & { type: 'task_started' })
  | (EventBase & { type: 'task_stopped' })
  | (EventBase & { type: 'task_resumed' })
  | (EventBase & { type: 'task_interrupted' })
  | (EventBase & { type: 'task_completed' })
  | (EventBase & {
      type: 'task_incompatible';
      /**
       * Why the frozen task is non-runnable (spec §9). `TURN_CONTRACT_REQUIRED`:
       * the snapshot predates the turn contract. `SCHEMA_V2_REQUIRED`: the
       * snapshot predates the v7 artifact version directory schema.
       */
      reason: 'TURN_CONTRACT_REQUIRED' | 'SCHEMA_V2_REQUIRED';
    })
  | (EventBase & { type: 'agent_input'; node: EventNode })
  | (EventBase & {
      type: 'agent_result';
      node: EventNode;
      /**
       * The input node this result consumed (spec §7 reachability closure).
       * Optional on the wire; absent → null. The committer always writes it.
       */
      inputNodeId?: string | null;
      /** The dispatch the turn performed; optional, absent → null. */
      dispatchKind?: DispatchKind | null;
    })
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
  | (EventBase & {
      type: 'artifact_annotated';
      version: number;
      file: string;
      contentHash: string;
      turnId: string;
      nodeId: string;
    })
  | (EventBase & {
      type: 'pending_inputs_superseded';
      supersededNodeIds: string[];
    })
  | (EventBase & {
      type: 'human_requested';
      node: EventNode;
      question: string;
      /** Origin of the request (spec §11.5); optional, legacy → agent_request. */
      source?: HumanRequestSource;
    })
  | (EventBase & {
      type: 'human_answered';
      node: EventNode;
      answer: string;
      /**
       * The structured progress-guard decision this answer carried (spec
       * §11.1): persisted so a crash between supersede and synthesize is
       * deterministically recoverable (spec §11.6). Absent on ordinary
       * agent_request answers.
       */
      decision?: 'continue' | 'accept';
    })
  | (EventBase & { type: 'final_submission_accepted'; artifactId: string; version: number })
  | (EventBase & { type: 'skill_loaded'; skillId: string })
  | (EventBase & {
      type: 'structured_slot_attempt_started';
      inputNodeId: string;
      agentId: string;
      attemptEpoch: number;
      turnId: string;
      sessionKind: StructuredSessionKind;
    })
  | (EventBase & {
      type: 'structured_slot_attempt_terminal';
      inputNodeId: string;
      attemptEpoch: number;
      turnId: string;
      status: StructuredAttemptStatus;
      reason: StructuredAttemptReason;
    })
  | (EventBase & {
      type: 'structured_scaffold_generation_committed';
      scaffoldId: string;
      generationId: string;
      supersedesGenerationId: string | null;
      rootSlotId: string;
      slotCount: number;
      maxDepth: number;
      structure: StructuredBlobRefV1;
      content: StructuredBlobRefV1;
      /** Generation content revisions are frozen at 0 at commit time. */
      contentRevision: 0;
      proposalId: string;
    })
  | (EventBase & {
      type: 'structured_fill_draft_opened';
      draftId: string;
      turnId: string;
      scaffoldId: string;
      generationId: string;
      baseRevision: number;
    })
  | (EventBase & {
      type: 'structured_fill_draft_terminal';
      draftId: string;
      turnId: string;
      status: StructuredDraftTerminalStatus;
      baseRevision: number;
      resultRevision: number;
      changeCount: number;
      content: StructuredBlobRefV1 | null;
    })
  | (EventBase & {
      type: 'structured_scaffold_sealed';
      sealId: string;
      scaffoldId: string;
      generationId: string;
      scaffoldRevision: number;
      sealRecord: StructuredBlobRefV1;
      artifactId: string;
      artifactVersion: number;
    });

/**
 * The canonical task event union: legacy v1 members (unchanged, normalized by
 * `normalizeLegacyEvent`) plus the closed v2 protocol
 * `AuthoritativeReviewEventV2` (spec §9.1). Every v2 member carries
 * `protocolVersion: 2` and its own closed identity/ref fields; the v2
 * validator runs before append and during replay exactly like legacy
 * validation, and the legacy normalizer never rewrites a v2 event.
 */
export type TaskEvent = LegacyTaskEvent | AuthoritativeReviewEventV2;

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

/** Integer >= 0 (revision/count fields that can legitimately be zero). */
function assertNonNegativeInteger(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidEvent(`${where} 必须是不小于 0 的整数。`);
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
  'inputVersion',
  'humanAuthorized',
]);

function validateEventNode(value: unknown, where: string): EventNode {
  if (!isPlainObject(value)) {
    throw invalidEvent(`${where} 必须是对象。`);
  }
  assertExactKeys(value, NODE_KEYS, where);
  let inputVersion: number | null;
  if (value.inputVersion === null || value.inputVersion === undefined) {
    inputVersion = null;
  } else {
    inputVersion = assertPositiveInteger(value.inputVersion, `${where}.inputVersion`);
  }
  if (typeof value.body !== 'string') {
    throw invalidEvent(`${where}.body 必须是字符串。`);
  }
  let humanAuthorized: boolean | undefined;
  if (value.humanAuthorized !== undefined) {
    if (typeof value.humanAuthorized !== 'boolean') {
      throw invalidEvent(`${where}.humanAuthorized 必须是布尔值。`);
    }
    humanAuthorized = value.humanAuthorized;
  }
  return {
    sequence: assertPositiveInteger(value.sequence, `${where}.sequence`),
    agentId: assertNonEmptyString(value.agentId, `${where}.agentId`),
    kind: assertOneOf(value.kind, NODE_KINDS, `${where}.kind`) as NodeKind,
    title: assertNonEmptyString(value.title, `${where}.title`),
    body: value.body,
    status: assertOneOf(value.status, NODE_STATUSES, `${where}.status`) as EventNode['status'],
    attemptCount: assertPositiveInteger(value.attemptCount, `${where}.attemptCount`),
    inputVersion,
    ...(humanAuthorized === undefined ? {} : { humanAuthorized }),
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

function validateEventFile(value: unknown, where: string): EventArtifactFile {
  if (!isPlainObject(value)) {
    throw invalidEvent(`${where} 必须是对象。`);
  }
  assertExactKeys(value, new Set(['name', 'hash']), where);
  const name = assertNonEmptyString(value.name, `${where}.name`);
  const hash = assertNonEmptyString(value.hash, `${where}.hash`);
  if (!CONTENT_HASH_PATTERN.test(hash)) {
    throw invalidEvent(`${where}.hash 必须是 64 位十六进制 SHA-256。`);
  }
  return { name, hash };
}

function validateEventFiles(value: unknown, where: string): EventArtifactFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidEvent(`${where} 必须是非空数组。`);
  }
  return value.map((entry, index) => validateEventFile(entry, `${where}[${index}]`));
}

const ARTIFACT_KEYS = new Set([
  'version',
  'title',
  'sourceNodeId',
  'format',
  'files',
  'artifactType',
  'artifactId',
]);

function validateEventArtifact(value: unknown, where: string): EventArtifact {
  if (!isPlainObject(value)) {
    throw invalidEvent(`${where} 必须是对象。`);
  }
  assertExactKeys(value, ARTIFACT_KEYS, where);
  const artifactType =
    value.artifactType === undefined || value.artifactType === null
      ? null
      : assertNonEmptyString(value.artifactType, `${where}.artifactType`);
  const artifactId =
    value.artifactId === undefined || value.artifactId === null
      ? null
      : assertNonEmptyString(value.artifactId, `${where}.artifactId`);
  return {
    version: assertPositiveInteger(value.version, `${where}.version`),
    title: assertNonEmptyString(value.title, `${where}.title`),
    sourceNodeId: assertNonEmptyString(value.sourceNodeId, `${where}.sourceNodeId`),
    format: assertOneOf(value.format, ARTIFACT_FORMATS, `${where}.format`) as EventArtifact['format'],
    files: validateEventFiles(value.files, `${where}.files`),
    artifactType,
    artifactId,
  };
}

const BASE_KEYS = ['id', 'at', 'type'] as const;

/** Closed v2 member names (from the authoritative review event protocol). */
const V2_EVENT_TYPES: ReadonlySet<string> = new Set(AUTHORITATIVE_REVIEW_EVENT_NAMES_V2);

function baseAnd(...fields: string[]): ReadonlySet<string> {
  return new Set([...BASE_KEYS, ...fields]);
}

const BLOB_REF_KEYS = new Set(['version', 'kind', 'sha256', 'byteLength']);

function validateStructuredBlobRef(value: unknown, where: string): StructuredBlobRefV1 {
  if (!isPlainObject(value)) {
    throw invalidEvent(`${where} 必须是对象。`);
  }
  assertExactKeys(value, BLOB_REF_KEYS, where);
  if (value.version !== 1) {
    throw invalidEvent(`${where}.version 必须是 1。`);
  }
  const sha256 = assertNonEmptyString(value.sha256, `${where}.sha256`);
  if (!CONTENT_HASH_PATTERN.test(sha256)) {
    throw invalidEvent(`${where}.sha256 必须是 64 位十六进制 SHA-256。`);
  }
  return {
    version: 1,
    kind: assertOneOf(value.kind, STRUCTURED_BLOB_KINDS, `${where}.kind`) as StructuredBlobKind,
    sha256,
    byteLength: assertPositiveInteger(value.byteLength, `${where}.byteLength`),
  };
}

const MEMBER_KEYS: Record<string, ReadonlySet<string>> = {
  task_started: baseAnd(),
  task_stopped: baseAnd(),
  task_resumed: baseAnd(),
  task_interrupted: baseAnd(),
  task_completed: baseAnd(),
  task_incompatible: baseAnd('reason'),
  agent_input: baseAnd('node'),
  agent_result: baseAnd('node', 'inputNodeId', 'dispatchKind'),
  agent_attempt_failed: baseAnd('nodeId', 'message', 'retryable'),
  retry_scheduled: baseAnd('nodeId', 'delayMs', 'attempt'),
  route_executed: baseAnd('route'),
  artifact_published: baseAnd('artifact'),
  artifact_annotated: baseAnd('version', 'file', 'contentHash', 'turnId', 'nodeId'),
  pending_inputs_superseded: baseAnd('supersededNodeIds'),
  human_requested: baseAnd('node', 'question', 'source'),
  human_answered: baseAnd('node', 'answer', 'decision'),
  final_submission_accepted: baseAnd('artifactId', 'version'),
  skill_loaded: baseAnd('skillId'),
  structured_slot_attempt_started: baseAnd(
    'inputNodeId',
    'agentId',
    'attemptEpoch',
    'turnId',
    'sessionKind',
  ),
  structured_slot_attempt_terminal: baseAnd('inputNodeId', 'attemptEpoch', 'turnId', 'status', 'reason'),
  structured_scaffold_generation_committed: baseAnd(
    'scaffoldId',
    'generationId',
    'supersedesGenerationId',
    'rootSlotId',
    'slotCount',
    'maxDepth',
    'structure',
    'content',
    'contentRevision',
    'proposalId',
  ),
  structured_fill_draft_opened: baseAnd('draftId', 'turnId', 'scaffoldId', 'generationId', 'baseRevision'),
  structured_fill_draft_terminal: baseAnd(
    'draftId',
    'turnId',
    'status',
    'baseRevision',
    'resultRevision',
    'changeCount',
    'content',
  ),
  structured_scaffold_sealed: baseAnd(
    'sealId',
    'scaffoldId',
    'generationId',
    'scaffoldRevision',
    'sealRecord',
    'artifactId',
    'artifactVersion',
  ),
};

function validateStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidEvent(`${where} 必须是非空字符串数组。`);
  }
  const result: string[] = [];
  for (const entry of value) {
    result.push(assertNonEmptyString(entry, `${where} 元素`));
  }
  return result;
}

function nullableString(value: unknown, where: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return assertNonEmptyString(value, where);
}

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
  // v2 members dispatch to the closed v2 union validator before the legacy
  // key lookup, so v1 names never widen and v2 names never fall through.
  if (V2_EVENT_TYPES.has(candidate.type)) {
    return validateAuthoritativeReviewEventV2(candidate);
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
        ) as 'TURN_CONTRACT_REQUIRED' | 'SCHEMA_V2_REQUIRED',
      };
    case 'agent_input':
      return { id, at, type, node: validateEventNode(candidate.node, '事件 node') };
    case 'agent_result': {
      const node = validateEventNode(candidate.node, '事件 node');
      let inputNodeId: string | null | undefined = undefined;
      if (candidate.inputNodeId !== undefined && candidate.inputNodeId !== null) {
        inputNodeId = assertNonEmptyString(candidate.inputNodeId, '事件 inputNodeId');
      } else if (candidate.inputNodeId === null) {
        inputNodeId = null;
      }
      let dispatchKind: DispatchKind | null | undefined = undefined;
      if (candidate.dispatchKind !== undefined && candidate.dispatchKind !== null) {
        dispatchKind = assertOneOf(
          candidate.dispatchKind,
          DISPATCH_KINDS,
          '事件 dispatchKind',
        ) as DispatchKind;
      } else if (candidate.dispatchKind === null) {
        dispatchKind = null;
      }
      const result: TaskEvent = { id, at, type, node };
      if (inputNodeId !== undefined) {
        (result as { inputNodeId?: string | null }).inputNodeId = inputNodeId;
      }
      if (dispatchKind !== undefined) {
        (result as { dispatchKind?: DispatchKind | null }).dispatchKind = dispatchKind;
      }
      return result;
    }
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
    case 'artifact_annotated': {
      const contentHash = assertNonEmptyString(candidate.contentHash, '事件 contentHash');
      if (!CONTENT_HASH_PATTERN.test(contentHash)) {
        throw invalidEvent('事件 contentHash 必须是 64 位十六进制 SHA-256。');
      }
      return {
        id,
        at,
        type,
        version: assertPositiveInteger(candidate.version, '事件 version'),
        file: assertNonEmptyString(candidate.file, '事件 file'),
        contentHash,
        turnId: assertNonEmptyString(candidate.turnId, '事件 turnId'),
        nodeId: assertNonEmptyString(candidate.nodeId, '事件 nodeId'),
      };
    }
    case 'pending_inputs_superseded':
      return {
        id,
        at,
        type,
        supersededNodeIds: validateStringArray(candidate.supersededNodeIds, '事件 supersededNodeIds'),
      };
    case 'human_requested': {
      const node = validateEventNode(candidate.node, '事件 node');
      const question = assertNonEmptyString(candidate.question, '事件 question');
      let source: HumanRequestSource | undefined;
      if (candidate.source !== undefined && candidate.source !== null) {
        source = assertOneOf(
          candidate.source,
          HUMAN_REQUEST_SOURCES,
          '事件 source',
        ) as HumanRequestSource;
      }
      return { id, at, type, node, question, ...(source === undefined ? {} : { source }) };
    }
    case 'human_answered': {
      const decision = candidate.decision;
      return {
        id,
        at,
        type,
        node: validateEventNode(candidate.node, '事件 node'),
        answer: assertNonEmptyString(candidate.answer, '事件 answer'),
        ...(decision === undefined
          ? {}
          : {
              decision: assertOneOf(decision, ['continue', 'accept'], '事件 decision') as
                | 'continue'
                | 'accept',
            }),
      };
    }
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
    case 'structured_slot_attempt_started':
      return {
        id,
        at,
        type,
        inputNodeId: assertNonEmptyString(candidate.inputNodeId, '事件 inputNodeId'),
        agentId: assertNonEmptyString(candidate.agentId, '事件 agentId'),
        attemptEpoch: assertPositiveInteger(candidate.attemptEpoch, '事件 attemptEpoch'),
        turnId: assertNonEmptyString(candidate.turnId, '事件 turnId'),
        sessionKind: assertOneOf(
          candidate.sessionKind,
          STRUCTURED_SESSION_KINDS,
          '事件 sessionKind',
        ) as StructuredSessionKind,
      };
    case 'structured_slot_attempt_terminal':
      return {
        id,
        at,
        type,
        inputNodeId: assertNonEmptyString(candidate.inputNodeId, '事件 inputNodeId'),
        attemptEpoch: assertPositiveInteger(candidate.attemptEpoch, '事件 attemptEpoch'),
        turnId: assertNonEmptyString(candidate.turnId, '事件 turnId'),
        status: assertOneOf(
          candidate.status,
          STRUCTURED_ATTEMPT_STATUSES,
          '事件 status',
        ) as StructuredAttemptStatus,
        reason: assertOneOf(
          candidate.reason,
          STRUCTURED_ATTEMPT_REASONS,
          '事件 reason',
        ) as StructuredAttemptReason,
      };
    case 'structured_scaffold_generation_committed': {
      if (candidate.contentRevision !== 0) {
        throw invalidEvent('事件 contentRevision 必须是 0。');
      }
      return {
        id,
        at,
        type,
        scaffoldId: assertNonEmptyString(candidate.scaffoldId, '事件 scaffoldId'),
        generationId: assertNonEmptyString(candidate.generationId, '事件 generationId'),
        supersedesGenerationId: nullableString(
          candidate.supersedesGenerationId,
          '事件 supersedesGenerationId',
        ),
        rootSlotId: assertNonEmptyString(candidate.rootSlotId, '事件 rootSlotId'),
        slotCount: assertPositiveInteger(candidate.slotCount, '事件 slotCount'),
        maxDepth: assertNonNegativeInteger(candidate.maxDepth, '事件 maxDepth'),
        structure: validateStructuredBlobRef(candidate.structure, '事件 structure'),
        content: validateStructuredBlobRef(candidate.content, '事件 content'),
        contentRevision: 0,
        proposalId: assertNonEmptyString(candidate.proposalId, '事件 proposalId'),
      };
    }
    case 'structured_fill_draft_opened':
      return {
        id,
        at,
        type,
        draftId: assertNonEmptyString(candidate.draftId, '事件 draftId'),
        turnId: assertNonEmptyString(candidate.turnId, '事件 turnId'),
        scaffoldId: assertNonEmptyString(candidate.scaffoldId, '事件 scaffoldId'),
        generationId: assertNonEmptyString(candidate.generationId, '事件 generationId'),
        baseRevision: assertNonNegativeInteger(candidate.baseRevision, '事件 baseRevision'),
      };
    case 'structured_fill_draft_terminal': {
      const content =
        candidate.content === null || candidate.content === undefined
          ? null
          : validateStructuredBlobRef(candidate.content, '事件 content');
      return {
        id,
        at,
        type,
        draftId: assertNonEmptyString(candidate.draftId, '事件 draftId'),
        turnId: assertNonEmptyString(candidate.turnId, '事件 turnId'),
        status: assertOneOf(
          candidate.status,
          STRUCTURED_DRAFT_TERMINAL_STATUSES,
          '事件 status',
        ) as StructuredDraftTerminalStatus,
        baseRevision: assertNonNegativeInteger(candidate.baseRevision, '事件 baseRevision'),
        resultRevision: assertNonNegativeInteger(candidate.resultRevision, '事件 resultRevision'),
        changeCount: assertNonNegativeInteger(candidate.changeCount, '事件 changeCount'),
        content,
      };
    }
    case 'structured_scaffold_sealed':
      return {
        id,
        at,
        type,
        sealId: assertNonEmptyString(candidate.sealId, '事件 sealId'),
        scaffoldId: assertNonEmptyString(candidate.scaffoldId, '事件 scaffoldId'),
        generationId: assertNonEmptyString(candidate.generationId, '事件 generationId'),
        scaffoldRevision: assertNonNegativeInteger(
          candidate.scaffoldRevision,
          '事件 scaffoldRevision',
        ),
        sealRecord: validateStructuredBlobRef(candidate.sealRecord, '事件 sealRecord'),
        artifactId: assertNonEmptyString(candidate.artifactId, '事件 artifactId'),
        artifactVersion: assertPositiveInteger(candidate.artifactVersion, '事件 artifactVersion'),
      };
    default:
      throw invalidEvent(`未知事件类型 ${type}。`);
  }
}

const LEGACY_CONTENT_FILE: Record<'markdown' | 'text', string> = {
  markdown: 'content.md',
  text: 'content.txt',
};

/**
 * Normalizes a legacy v1 event payload to the v7 schema before validation
 * (spec §8.3). Only the known migrations run: input-node `artifactVersion`
 * renamed to `inputVersion`; single `artifact_published.contentHash` converted
 * to `files[]` + null `artifactType`/`artifactId`. New optional fields stay
 * absent so the validator fills defaults (humanAuthorized→false, source→
 * agent_request, inputNodeId/dispatchKind→null). Returns the value untouched
 * when it is not a plain object or carries no legacy shape.
 */
export function normalizeLegacyEvent(candidate: unknown): unknown {
  if (!isPlainObject(candidate)) {
    return candidate;
  }
  // The legacy normalizer never rewrites a v2 event (spec §9.1): v2 members
  // are already canonical and go straight to the v2 validator.
  if (typeof candidate.type === 'string' && V2_EVENT_TYPES.has(candidate.type)) {
    return candidate;
  }
  if (candidate.type === 'agent_input' || candidate.type === 'agent_result') {
    const node = candidate.node;
    if (isPlainObject(node) && node.artifactVersion !== undefined && node.inputVersion === undefined) {
      const { artifactVersion, ...rest } = node;
      return { ...candidate, node: { ...rest, inputVersion: artifactVersion } };
    }
    return candidate;
  }
  if (candidate.type === 'artifact_published') {
    const artifact = candidate.artifact;
    if (isPlainObject(artifact) && artifact.contentHash !== undefined && artifact.files === undefined) {
      const format =
        artifact.format === 'markdown' || artifact.format === 'text'
          ? (artifact.format as 'markdown' | 'text')
          : 'markdown';
      const normalized = {
        ...artifact,
        files: [{ name: LEGACY_CONTENT_FILE[format], hash: artifact.contentHash }],
        artifactType: artifact.artifactType ?? null,
        artifactId: artifact.artifactId ?? null,
      };
      delete (normalized as Record<string, unknown>).contentHash;
      return { ...candidate, artifact: normalized };
    }
  }
  return candidate;
}
