/**
 * The closed v2 event protocol of the authoritative per-slot review lifecycle
 * (Task 7; design 2026-08-13 §17.2/§17.4/§17.5/§11, spec 2026-08-14 §9.1/
 * §9.2/§10.3.1/§13.3.1).
 *
 * Every member carries exactly `protocolVersion: 2`, `id` (stable,
 * filename-safe), `at` (parseable ISO timestamp) and its declared payload
 * fields — unknown extra keys are rejected at the event level and inside
 * nested refs/dispositions/contexts, so committed v2 history can never drift
 * away from what later projectors understand. Attempt/command/WorkItem
 * identity is event-ledger identity: exact IDs + lease epoch, NEVER invented
 * BlobRefs. Events carry `BlobRefV2` refs and bounded summaries; large
 * ledgers (assignments, adoptions, migration batches, 10,000-verdict sets,
 * full bodies) live in content-addressed blobs and are referenced, not
 * inlined.
 *
 * Validity rules frozen here:
 * - `protocolVersion` is exactly 2; `id` matches the filename-safe pattern.
 * - Every BlobRefV2 is validated against the closed kind registry (spec §7.1);
 *   a bare digest or an unregistered kind never satisfies a ref field.
 * - WorkItem created carries the closed required/null matrix of design §17.2
 *   (agent vs system discriminant; structured_session vs generic_turn).
 * - Attempt/command family events carry their own closed identity branch;
 *   cross-attempt branch fields are unknown-field errors (exact-key sets are
 *   disjoint per member).
 * - `structured_task_failed_v2` binds exactly one of attemptId | commandId,
 *   and carries `failureRecoveryPayloadRef` (ref when reopenable, null when
 *   ineligible — spec §10.3.1).
 * - `structured_task_reopened_v2` correlates recipeKey/track/overrideRef and
 *   always carries the recovery payload ref (spec §10.3.1 policy table).
 * - Map/content round-created events carry `consumedOverrideRef` provenance
 *   (spec §13.3.1); the transfer event carries the exact four identity refs +
 *   lineage.
 * - Formal GC roots from design §19.2 are the required ref fields: candidate/
 *   manifest/plan-spec/aggregate/receipt/coverage/settlement/bundle/Seal/
 *   artifact/delivery refs plus failureRecoveryPayloadRef, overrideRef,
 *   consumedOverrideRef and the transfer refs.
 *
 * No business vocabulary lives here: member names are stable platform
 * identifiers; folding belongs to the v2 projector (later tasks).
 */
import {
  AUTHORITATIVE_BLOB_KINDS_V2,
  type AuthoritativeBlobKindV2,
  type BlobRefV2,
  type RecoveryRecipeKeyV2,
  type WorkItemKindV2,
} from '../../shared/authoritative-review-v2';
import { STORAGE_ERROR_CODES, StorageError } from './atomic-file';

/** Event ids become part of committed filenames; safe segment, no traversal. */
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const BLOB_MEDIA_TYPES = ['application/json', 'text/markdown', 'text/plain'] as const;

const WORK_ITEM_KINDS = [
  'agent_assignment',
  'system_map_finalize',
  'system_generation_finalize',
  'system_repair_finalize',
  'system_migration_validation_batch',
  'system_review_settlement',
  'system_seal',
] as const;

const AGENT_EXECUTION_KINDS = ['structured_session', 'generic_turn'] as const;

const SESSION_KINDS = [
  'structure_chunk',
  'review_map_batch',
  'review_map_whole',
  'generation_batch',
  'review_content_batch',
  'review_content_whole',
  'map_repair',
  'content_repair',
] as const;

/** Closed structured-session kinds (design §17.2), same literals as Task 3. */
export type StructuredSessionKindV2 = (typeof SESSION_KINDS)[number];

const SYSTEM_COMMAND_KINDS = [
  'map_finalize',
  'generation_finalize',
  'repair_finalize',
  'migration_validation_batch',
  'review_settlement',
  'seal',
] as const;

/** Closed audit reasons for lease reclaim and attempt/command abandon (§17.2/§17.3). */
const RECLAIM_REASONS = [
  'lease_expired',
  'crash_recovery',
  'user_stop',
  'operator_interrupt',
] as const;

const SUPERSEDE_REASONS = ['new_authority_base', 'human_disposition'] as const;

const ROUND_SETTLEMENT_OUTCOMES = ['map_repair', 'activate'] as const;

const CONTENT_ROUND_SETTLEMENT_OUTCOMES = ['content_repair', 'seal'] as const;

const BATCH_ROUTE_OUTCOMES = [
  'clear',
  'content_repair',
  'map_repair',
  'infrastructure_failure',
] as const;

const RECIPE_KEYS = [
  'retry_system_command',
  'restart_map_review_cycle',
  'restart_content_review_cycle',
  'rebuild_missing_work',
] as const;

const REVIEW_ASSIGNMENT_SOURCES = ['batch', 'whole_map_observation'] as const;

const CONTENT_ASSIGNMENT_SOURCES = ['batch', 'whole_tree_observation'] as const;

const REPAIR_TRACKS = ['map', 'content'] as const;

const SUCCESSOR_REASONS = ['scope_expansion', 'validation_correction', 'recovery'] as const;

const MANIFEST_PHASES = ['baseline_unset', 'provisional', 'finalized'] as const;

const FINDING_DEFECT_CLASSES = ['content', 'map', 'mixed'] as const;

const FINDING_SEVERITIES = ['blocking', 'advisory'] as const;

const FINDING_SOURCES = ['reviewer', 'system_validator'] as const;

const FINDING_LOCATION_KINDS = ['slot', 'relation', 'map_node', 'map'] as const;

const REPAIR_STAGES = ['map', 'content'] as const;

const VERIFICATION_VERDICTS = ['resolved', 'still_present'] as const;

const GRANT_KINDS = [
  'initial_structure_chunk',
  'initial_generation_batch',
  'map_repair_batch',
  'content_repair_batch',
] as const;

const SEAL_STAGES = ['input', 'output'] as const;

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

/** Integer >= 0 (epoch-zero creation, counts and migration ordinals). */
function assertNonNegativeInteger(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidEvent(`${where} 必须是不小于 0 的整数。`);
  }
  return value;
}

/**
 * Closed one-of validation; returns the literal member type when `allowed` is
 * an `as const` array, otherwise `string`.
 */
function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalidEvent(`${where} 必须是 ${allowed.join('/')} 之一。`);
  }
  return value as T;
}

function assertSha256(value: unknown, where: string): string {
  const digest = assertNonEmptyString(value, where);
  if (!SHA256_PATTERN.test(digest)) {
    throw invalidEvent(`${where} 必须是 64 位十六进制 SHA-256。`);
  }
  return digest;
}

/** ISO timestamp (identical rule to the legacy union). */
function assertAt(value: unknown, where: string): string {
  const at = assertNonEmptyString(value, where);
  if (Number.isNaN(Date.parse(at))) {
    throw invalidEvent(`${where} 必须是可解析的时间戳。`);
  }
  return at;
}

function nullableString(value: unknown, where: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return assertNonEmptyString(value, where);
}

function assertUriSafeToken(value: unknown, where: string): string {
  const token = assertNonEmptyString(value, where);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw invalidEvent(`${where} 必须是 43 字符的 base64url 令牌。`);
  }
  return token;
}

function assertUuidV4(value: unknown, where: string): string {
  const uuid = assertNonEmptyString(value, where);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)) {
    throw invalidEvent(`${where} 必须是 UUID v4。`);
  }
  return uuid;
}

const BLOB_REF_KEYS = new Set(['kind', 'digest', 'byteLength', 'mediaType', 'schemaVersion']);

/**
 * Closed-registry BlobRefV2 validation (spec §7.1): known kind, lowercase
 * SHA-256 digest, non-negative byte length, closed media type, schema version
 * >= 1. A bare digest or an object with unknown keys can never satisfy a ref
 * field.
 */
function validateBlobRefV2(value: unknown, where: string): BlobRefV2 {
  if (!isPlainObject(value)) {
    throw invalidEvent(`${where} 必须是 BlobRefV2 对象。`);
  }
  assertExactKeys(value, BLOB_REF_KEYS, where);
  const kind = assertNonEmptyString(value.kind, `${where}.kind`);
  if (!(AUTHORITATIVE_BLOB_KINDS_V2 as readonly string[]).includes(kind)) {
    throw invalidEvent(`${where}.kind 不是已注册的 v2 blob 类型。`);
  }
  const byteLength = assertNonNegativeInteger(value.byteLength, `${where}.byteLength`);
  const schemaVersion = assertPositiveInteger(value.schemaVersion, `${where}.schemaVersion`);
  return {
    kind: kind as AuthoritativeBlobKindV2,
    digest: assertSha256(value.digest, `${where}.digest`),
    byteLength,
    mediaType: assertOneOf(value.mediaType, BLOB_MEDIA_TYPES, `${where}.mediaType`) as BlobRefV2['mediaType'],
    schemaVersion,
  };
}

function validateNullableBlobRef(value: unknown, where: string): BlobRefV2 | null {
  if (value === undefined || value === null) {
    return null;
  }
  return validateBlobRefV2(value, where);
}

/**
 * Mandatory-but-nullable validation custody field: must be explicitly present
 * (ref when the failure originates from a validator aggregate; null for
 * ordinary non-validator failures) — an omitted key is a schema violation
 * (design §17.2 "事件必填 validatorAggregateRef … 普通非-validator failure 则
 * 禁止该字段").
 */
function requireValidationCustody(value: unknown, where: string): BlobRefV2 | null {
  if (value === undefined) {
    throw invalidEvent(`${where} 必须显式提供（validator 失败为 ref，普通失败为 null）。`);
  }
  return validateNullableBlobRef(value, where);
}

function validateBlobRefArray(value: unknown, where: string): BlobRefV2[] {
  if (!Array.isArray(value)) {
    throw invalidEvent(`${where} 必须是数组。`);
  }
  return value.map((entry, index) => validateBlobRefV2(entry, `${where}[${index}]`));
}

function validateStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) {
    throw invalidEvent(`${where} 必须是数组。`);
  }
  return value.map((entry, index) => assertNonEmptyString(entry, `${where}[${index}]`));
}

function validateNonEmptyStringArray(value: unknown, where: string): string[] {
  const entries = validateStringArray(value, where);
  if (entries.length === 0) {
    throw invalidEvent(`${where} 必须是非空数组。`);
  }
  return entries;
}

/** `{kind, roundId}` review-context summary (design §11.8). */
const REVIEW_CONTEXT_KEYS = new Set(['kind', 'roundId']);

function validateReviewContext(value: unknown, where: string): { kind: 'map' | 'content'; roundId: string } {
  if (!isPlainObject(value)) {
    throw invalidEvent(`${where} 必须是对象。`);
  }
  assertExactKeys(value, REVIEW_CONTEXT_KEYS, where);
  return {
    kind: assertOneOf(value.kind, ['map', 'content'], `${where}.kind`) as 'map' | 'content',
    roundId: assertNonEmptyString(value.roundId, `${where}.roundId`),
  };
}

/** `{kind, id}` Finding primary location (design §11.8). */
const PRIMARY_LOCATION_KEYS = new Set(['kind', 'id']);

function validatePrimaryLocation(
  value: unknown,
  where: string,
): { kind: 'slot' | 'relation' | 'map_node' | 'map'; id: string } {
  if (!isPlainObject(value)) {
    throw invalidEvent(`${where} 必须是对象。`);
  }
  assertExactKeys(value, PRIMARY_LOCATION_KEYS, where);
  return {
    kind: assertOneOf(value.kind, FINDING_LOCATION_KINDS, `${where}.kind`),
    id: assertNonEmptyString(value.id, `${where}.id`),
  };
}

/** Closed openedBy branch (design §11.8): reviewer attempt XOR validator execution. */
const OPENED_BY_REVIEWER_KEYS = new Set(['kind', 'reviewerAttemptId']);
const OPENED_BY_VALIDATOR_KEYS = new Set(['kind', 'validatorExecutionId']);

function validateOpenedBy(
  value: unknown,
  where: string,
): { kind: 'reviewer'; reviewerAttemptId: string } | { kind: 'system_validator'; validatorExecutionId: string } {
  if (!isPlainObject(value)) {
    throw invalidEvent(`${where} 必须是对象。`);
  }
  if (value.kind === 'reviewer') {
    assertExactKeys(value, OPENED_BY_REVIEWER_KEYS, where);
    return {
      kind: 'reviewer',
      reviewerAttemptId: assertNonEmptyString(value.reviewerAttemptId, `${where}.reviewerAttemptId`),
    };
  }
  if (value.kind === 'system_validator') {
    assertExactKeys(value, OPENED_BY_VALIDATOR_KEYS, where);
    return {
      kind: 'system_validator',
      validatorExecutionId: assertNonEmptyString(
        value.validatorExecutionId,
        `${where}.validatorExecutionId`,
      ),
    };
  }
  throw invalidEvent(`${where}.kind 必须是 reviewer/system_validator 之一。`);
}

/** Closed park disposition branches (design §17.2); both-branch payloads reject. */
const PARK_BUDGET_KEYS = new Set(['kind', 'retryOrdinal', 'budgetPolicyDigest']);
const PARK_QUESTION_KEYS = new Set(['kind', 'questionId', 'questionVersion']);

function validateParkDisposition(
  value: unknown,
  where: string,
): { kind: 'retry_budget_exhausted'; retryOrdinal: number; budgetPolicyDigest: string } | {
  kind: 'human_question';
  questionId: string;
  questionVersion: string;
} {
  if (!isPlainObject(value)) {
    throw invalidEvent(`${where} 必须是对象。`);
  }
  if (value.kind === 'retry_budget_exhausted') {
    assertExactKeys(value, PARK_BUDGET_KEYS, where);
    return {
      kind: 'retry_budget_exhausted',
      retryOrdinal: assertPositiveInteger(value.retryOrdinal, `${where}.retryOrdinal`),
      budgetPolicyDigest: assertSha256(value.budgetPolicyDigest, `${where}.budgetPolicyDigest`),
    };
  }
  if (value.kind === 'human_question') {
    assertExactKeys(value, PARK_QUESTION_KEYS, where);
    return {
      kind: 'human_question',
      questionId: assertNonEmptyString(value.questionId, `${where}.questionId`),
      questionVersion: assertUriSafeToken(value.questionVersion, `${where}.questionVersion`),
    };
  }
  throw invalidEvent(`${where}.kind 必须是 retry_budget_exhausted/human_question 之一。`);
}

/** `{name, hash}` publication file summary (spec §13.5.1). */
const FILE_KEYS = new Set(['name', 'hash']);

function validateFile(value: unknown, where: string): { name: string; hash: string } {
  if (!isPlainObject(value)) {
    throw invalidEvent(`${where} 必须是对象。`);
  }
  assertExactKeys(value, FILE_KEYS, where);
  return {
    name: assertNonEmptyString(value.name, `${where}.name`),
    hash: assertSha256(value.hash, `${where}.hash`),
  };
}

/** System producer provenance (spec §13.5/§13.5.1): only the system branch on v2. */
const SYSTEM_PROVENANCE_KEYS = new Set([
  'producerKind',
  'producerWorkItemId',
  'sealRecordRef',
  'artifactRef',
  'custodyRef',
]);

function validateSystemProvenance(
  value: unknown,
  where: string,
): {
  producerKind: 'system';
  producerWorkItemId: string;
  sealRecordRef: BlobRefV2;
  artifactRef: BlobRefV2;
  custodyRef: BlobRefV2;
} {
  if (!isPlainObject(value)) {
    throw invalidEvent(`${where} 必须是对象。`);
  }
  assertExactKeys(value, SYSTEM_PROVENANCE_KEYS, where);
  if (value.producerKind !== 'system') {
    throw invalidEvent(`${where}.producerKind 必须是 system。`);
  }
  return {
    producerKind: 'system',
    producerWorkItemId: assertNonEmptyString(value.producerWorkItemId, `${where}.producerWorkItemId`),
    sealRecordRef: validateBlobRefV2(value.sealRecordRef, `${where}.sealRecordRef`),
    artifactRef: validateBlobRefV2(value.artifactRef, `${where}.artifactRef`),
    custodyRef: validateBlobRefV2(value.custodyRef, `${where}.custodyRef`),
  };
}

export interface AuthoritativeReviewEventV2Base {
  protocolVersion: 2;
  id: string;
  at: string;
}

type V2 = AuthoritativeReviewEventV2Base; // alias for member literals below

/**
 * The exact closed v2 event union (design §17.4 + spec §13.3.1 transfer
 * event). Every member is a literal discriminated branch; `Extract<...,{type}>`
 * yields the exact payload type later tasks compile against. Member names are
 * frozen platform identifiers; existing v1 names stay v1-only and are never
 * widened here.
 */
export type AuthoritativeReviewEventV2 =
  | (V2 & { type: 'structured_work_item_created'; workItemId: string; kind: WorkItemKindV2; roleBinding: string | null; agentExecutionKind: 'structured_session' | 'generic_turn' | null; sessionKind: StructuredSessionKindV2 | null; roundId: string | null; logicalAssignmentId: string | null; reviewAssignmentId: string | null; grantSpecRef: BlobRefV2 | null; inputArtifactDeliveryId: string | null; scopeDecisionReason?: string | null; authorityBaseRef: BlobRefV2; payloadRef: BlobRefV2; initialLeaseEpoch: number; maxAutomaticRetries: number })
  | (V2 & { type: 'structured_work_item_leased'; workItemId: string; leaseEpoch: number; leaseOwner: string; leaseExpiresAt: string; expectedLastSequence: number; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_work_item_completed'; workItemId: string; leaseEpoch: number; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_work_item_retryable_failed'; workItemId: string; leaseEpoch: number; failureCode: string; failureDigest: string; retryOrdinal: number; retryNotBefore: string; maxAutomaticRetries: number; validatorAggregateRef: BlobRefV2 | null; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_work_item_requeued'; workItemId: string; leaseEpoch: number; expectedLastSequence: number; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_work_item_lease_reclaimed'; workItemId: string; leaseEpoch: number; reason: 'lease_expired' | 'crash_recovery' | 'user_stop' | 'operator_interrupt'; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_work_item_terminal_failed'; workItemId: string; leaseEpoch: number; failureCode: string; failureDigest: string; terminalAttemptId: string | null; terminalCommandId: string | null; validatorAggregateRef: BlobRefV2 | null; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_work_item_superseded'; workItemId: string; leaseEpoch: number; reason: 'new_authority_base' | 'human_disposition'; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_work_item_parked'; workItemId: string; leaseEpoch: number; parkDisposition: { kind: 'retry_budget_exhausted'; retryOrdinal: number; budgetPolicyDigest: string } | { kind: 'human_question'; questionId: string; questionVersion: string }; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_work_item_resumed'; workItemId: string; leaseEpoch: number; expectedLastSequence: number; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_assignment_dispatched'; dispatchRef: BlobRefV2; workItemId: string; attemptId: string; logicalAssignmentId: string; reviewAssignmentId: string | null; agentExecutionKind: 'structured_session' | 'generic_turn'; sessionKind: StructuredSessionKindV2 | null; inputArtifactDeliveryId: string | null; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_generic_agent_attempt_started'; attemptId: string; workItemId: string; agentId: string; logicalAssignmentId: string; leaseEpoch: number; inputArtifactDeliveryId: string; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_generic_agent_attempt_completed'; attemptId: string; workItemId: string; agentId: string; logicalAssignmentId: string; leaseEpoch: number; inputArtifactDeliveryId: string; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_generic_agent_attempt_retryable_failed'; attemptId: string; workItemId: string; agentId: string; logicalAssignmentId: string; leaseEpoch: number; inputArtifactDeliveryId: string; failureCode: string; failureDigest: string; retryOrdinal: number; retryNotBefore: string; validatorAggregateRef: BlobRefV2 | null; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_generic_agent_attempt_terminal_failed'; attemptId: string; workItemId: string; agentId: string; logicalAssignmentId: string; leaseEpoch: number; inputArtifactDeliveryId: string; failureCode: string; failureDigest: string; validatorAggregateRef: BlobRefV2 | null; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_generic_agent_attempt_abandoned'; attemptId: string; workItemId: string; agentId: string; logicalAssignmentId: string; leaseEpoch: number; inputArtifactDeliveryId: string; reason: 'lease_expired' | 'crash_recovery' | 'user_stop' | 'operator_interrupt'; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_agent_attempt_started_v2'; workItemId: string; logicalAssignmentId: string; reviewAssignmentId: string | null; attemptId: string; sessionKind: StructuredSessionKindV2; leaseEpoch: number; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_agent_attempt_completed_v2'; workItemId: string; logicalAssignmentId: string; reviewAssignmentId: string | null; attemptId: string; sessionKind: StructuredSessionKindV2; leaseEpoch: number; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_agent_attempt_retryable_failed_v2'; workItemId: string; logicalAssignmentId: string; reviewAssignmentId: string | null; attemptId: string; sessionKind: StructuredSessionKindV2; leaseEpoch: number; failureCode: string; failureDigest: string; retryOrdinal: number; retryNotBefore: string; validatorAggregateRef: BlobRefV2 | null; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_agent_attempt_terminal_failed_v2'; workItemId: string; logicalAssignmentId: string; reviewAssignmentId: string | null; attemptId: string; sessionKind: StructuredSessionKindV2; leaseEpoch: number; failureCode: string; failureDigest: string; validatorAggregateRef: BlobRefV2 | null; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_agent_attempt_abandoned_v2'; workItemId: string; logicalAssignmentId: string; reviewAssignmentId: string | null; attemptId: string; sessionKind: StructuredSessionKindV2; leaseEpoch: number; reason: 'lease_expired' | 'crash_recovery' | 'user_stop' | 'operator_interrupt'; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_system_command_started'; commandId: string; workItemId: string; commandKind: 'map_finalize' | 'generation_finalize' | 'repair_finalize' | 'migration_validation_batch' | 'review_settlement' | 'seal'; leaseEpoch: number; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_system_command_completed'; commandId: string; workItemId: string; commandKind: 'map_finalize' | 'generation_finalize' | 'repair_finalize' | 'migration_validation_batch' | 'review_settlement' | 'seal'; leaseEpoch: number; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_system_command_retryable_failed'; commandId: string; workItemId: string; commandKind: 'map_finalize' | 'generation_finalize' | 'repair_finalize' | 'migration_validation_batch' | 'review_settlement' | 'seal'; leaseEpoch: number; failureCode: string; failureDigest: string; retryOrdinal: number; retryNotBefore: string; validatorAggregateRef: BlobRefV2 | null; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_system_command_terminal_failed'; commandId: string; workItemId: string; commandKind: 'map_finalize' | 'generation_finalize' | 'repair_finalize' | 'migration_validation_batch' | 'review_settlement' | 'seal'; leaseEpoch: number; failureCode: string; failureDigest: string; validatorAggregateRef: BlobRefV2 | null; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_system_command_abandoned'; commandId: string; workItemId: string; commandKind: 'map_finalize' | 'generation_finalize' | 'repair_finalize' | 'migration_validation_batch' | 'review_settlement' | 'seal'; leaseEpoch: number; reason: 'lease_expired' | 'crash_recovery' | 'user_stop' | 'operator_interrupt'; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_seal_validation_rejected_v2'; sealWorkItemId: string; stage: 'input' | 'output'; validatorAggregateRef: BlobRefV2; validationReceiptRef: BlobRefV2 })
  | (V2 & { type: 'structured_map_build_started'; mapBuildId: string; revision: number; mapBuildSpecRef: BlobRefV2; supersedesMapBuildId: string | null; sourceValidationReceiptRef: BlobRefV2 | null })
  | (V2 & { type: 'structured_map_chunk_committed'; mapBuildId: string; chunkId: string; chunkOrdinal: number; chunkRef: BlobRefV2; parentFrontierDigest: string })
  | (V2 & { type: 'structured_map_build_finish_proposed'; mapBuildId: string; expectedChunkCount: number; expectedFrontierDigest: string; expectedRootCount: number })
  | (V2 & { type: 'structured_map_build_rejected'; mapBuildId: string; validatorAggregateRef: BlobRefV2; validationReceiptRef: BlobRefV2 })
  | (V2 & { type: 'structured_map_build_finalized'; mapBuildId: string; manifestRef: BlobRefV2; contributionManifestRef: BlobRefV2 })
  | (V2 & { type: 'structured_map_candidate_committed'; candidateId: string; candidateRef: BlobRefV2; candidateDigest: string; baseMapId: string | null })
  | (V2 & { type: 'structured_generation_plan_started'; generationPlanId: string; revision: number; supersedesGenerationPlanId: string | null; generationPlanSpecRef: BlobRefV2; sourceValidationReceiptRef: BlobRefV2 | null })
  | (V2 & { type: 'structured_generation_batch_committed'; generationPlanId: string; batchOrdinal: number; contentRevisionCommitCoreRef: BlobRefV2; validatorAggregateRef: BlobRefV2; contentRevisionManifestRef: BlobRefV2 })
  | (V2 & { type: 'structured_generation_plan_rejected'; generationPlanId: string; validatorAggregateRef: BlobRefV2; validationReceiptRef: BlobRefV2 })
  | (V2 & { type: 'structured_generation_plan_completed'; generationPlanId: string; contentRevisionManifestRef: BlobRefV2; validatorAggregateRef: BlobRefV2; warningRootRef: BlobRefV2 | null })
  | (V2 & { type: 'structured_migration_validation_plan_started'; migrationValidationPlanId: string; intentCoreRef: BlobRefV2; planSpecRef: BlobRefV2 })
  | (V2 & { type: 'structured_migration_validation_batch_completed'; planSpecRef: BlobRefV2; batchOrdinal: number; batchResultRootRef: BlobRefV2; batchOutcome: 'clear' | 'content_repair' | 'map_repair' | 'infrastructure_failure' })
  | (V2 & { type: 'structured_migration_validation_settlement_completed'; settlementCoreRef: BlobRefV2; provisionalManifestRef: BlobRefV2; finalizerAggregateRef: BlobRefV2; activationDecisionRef: BlobRefV2 })
  | (V2 & { type: 'structured_map_repair_plan_started'; repairPlanId: string; planRevisionId: string; repairPlanSpecRef: BlobRefV2; sourceValidationReceiptRef: BlobRefV2 | null })
  | (V2 & { type: 'structured_map_repair_batch_committed'; repairPlanId: string; planRevisionId: string; batchOrdinal: number; stagingRootRef: BlobRefV2 })
  | (V2 & { type: 'structured_map_repair_plan_rejected'; repairPlanId: string; planRevisionId: string; validatorAggregateRef: BlobRefV2; validationReceiptRef: BlobRefV2 })
  | (V2 & { type: 'structured_content_repair_plan_started'; repairPlanId: string; planRevisionId: string; repairPlanSpecRef: BlobRefV2; sourceValidationReceiptRef: BlobRefV2 | null })
  | (V2 & { type: 'structured_content_repair_batch_committed'; repairPlanId: string; planRevisionId: string; batchOrdinal: number; stagingRootRef: BlobRefV2 })
  | (V2 & { type: 'structured_content_repair_plan_rejected'; repairPlanId: string; planRevisionId: string; validatorAggregateRef: BlobRefV2; validationReceiptRef: BlobRefV2 })
  | (V2 & { type: 'structured_repair_plan_revision_started'; repairPlanId: string; planRevisionId: string; repairPlanSpecRef: BlobRefV2; supersedesPlanRevisionId: string | null; successorReason: 'scope_expansion' | 'validation_correction' | 'recovery' | null })
  | (V2 & { type: 'structured_task_failed_v2'; workItemId: string; attemptId: string | null; commandId: string | null; leaseEpoch: number; failureCode: string; failureDigest: string; failureRecoveryPayloadRef: BlobRefV2 | null; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_task_reopened_v2'; expectedLastSequence: number; operationId: string; operatorId: string; reason: string; recipeKey: RecoveryRecipeKeyV2; track: 'map' | 'content' | null; failureRecoveryPayloadRef: BlobRefV2; overrideRef: BlobRefV2 | null })
  | (V2 & { type: 'structured_task_retry_resumed_v2'; workItemId: string; leaseEpoch: number; expectedLastSequence: number; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_task_suspension_applied_v2'; suspensionId: string; reason: 'user_stop' | 'operator_interrupt'; operationId: string })
  | (V2 & { type: 'structured_task_suspension_cleared_v2'; suspensionId: string; operationId: string })
  | (V2 & { type: 'structured_human_answer_delivered_v2'; deliveryId: string; questionId: string; questionVersion: string; originalWorkItemId: string; replacementWorkItemId: string; logicalAssignmentId: string; answerDigest: string; operationId: string; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'structured_human_question_opened_v2'; questionId: string; questionVersion: string; questionDigest: string; originalWorkItemId: string; attemptId: string; leaseEpoch: number; logicalAssignmentId: string; authorityBaseRef: BlobRefV2 })
  | (V2 & { type: 'artifact_published_v2'; artifactId: string; artifactVersion: number; deliveryRef: BlobRefV2; files: { name: string; hash: string }[]; mediaType: 'application/json' | 'text/markdown' | 'text/plain'; provenance: { producerKind: 'system'; producerWorkItemId: string; sealRecordRef: BlobRefV2; artifactRef: BlobRefV2; custodyRef: BlobRefV2 } })
  | (V2 & { type: 'structured_system_artifact_delivery_created'; deliveryId: string; deliveryRef: BlobRefV2; artifactId: string; artifactRef: BlobRefV2; sealRecordRef: BlobRefV2; submitterWorkItemId: string })
  | (V2 & { type: 'structured_map_review_round_planned'; mapReviewRoundId: string; mapCycleOrdinal: number; candidateId: string; candidateRef: BlobRefV2; contentRevisionManifestRef: BlobRefV2 | null; reviewPolicyDigest: string; coverageNodeCount: number; coverageRelationCount: number; assignmentCount: number; consumedOverrideRef: BlobRefV2 | null })
  | (V2 & { type: 'structured_map_review_assignment_committed'; assignmentId: string; mapReviewRoundId: string; workItemId: string; attemptId: string; reviewAssignmentId: string | null; source: 'batch' | 'whole_map_observation'; ledgerRef: BlobRefV2; coverageTargetCount: number; findingCount: number })
  | (V2 & { type: 'structured_map_observation_recorded'; observationId: string; mapReviewRoundId: string; level: number; parentObservationId: string | null; observationRef: BlobRefV2; coveredTargetCount: number; childObservationRefs: BlobRefV2[] })
  | (V2 & { type: 'structured_map_review_round_completed'; mapReviewRoundId: string; coverageCoreRef: BlobRefV2 })
  | (V2 & { type: 'structured_map_review_round_settled'; mapReviewRoundId: string; settlementCoreRef: BlobRefV2; outcome: 'map_repair' | 'activate' })
  | (V2 & { type: 'structured_map_activated'; mapId: string; mapRevision: number; supersedesMapId: string | null; mapSnapshotRef: BlobRefV2; mapReviewBundleRef: BlobRefV2; mapSemanticDigest: string; contentRevisionManifestRef: BlobRefV2; activationValidatorAggregateRef: BlobRefV2; migrationSettlementCoreRef: BlobRefV2 | null; migrationActivationDecisionRef: BlobRefV2 | null })
  | (V2 & { type: 'structured_content_revision_committed'; contentRevisionManifestRef: BlobRefV2; taskContentRevision: number; manifestPhase: 'baseline_unset' | 'provisional' | 'finalized'; producerPlanSpecRef: BlobRefV2 | null; priorManifestRef: BlobRefV2 | null })
  | (V2 & { type: 'structured_review_round_planned'; reviewRoundId: string; contentCycleOrdinal: number; mapRef: BlobRefV2; mapSemanticDigest: string; contentRevisionManifestRef: BlobRefV2; reviewPolicyDigest: string; adoptionRootRef: BlobRefV2; coverageSlotCount: number; coverageRelationCount: number; assignmentCount: number; verificationFindingCount: number; consumedOverrideRef: BlobRefV2 | null })
  | (V2 & { type: 'structured_review_assignment_started'; assignmentId: string; reviewRoundId: string; workItemId: string; attemptId: string; reviewAssignmentId: string | null; source: 'batch' | 'whole_tree_observation' })
  | (V2 & { type: 'structured_content_review_assignment_committed'; assignmentId: string; reviewRoundId: string; workItemId: string; attemptId: string; reviewAssignmentId: string | null; source: 'batch' | 'whole_tree_observation'; ledgerRef: BlobRefV2; coverageTargetCount: number; findingCount: number })
  | (V2 & { type: 'structured_finding_opened'; findingId: string; findingRef: BlobRefV2; reviewContext: { kind: 'map' | 'content'; roundId: string }; primaryLocation: { kind: 'slot' | 'relation' | 'map_node' | 'map'; id: string }; defectClass: 'content' | 'map' | 'mixed'; severity: 'blocking' | 'advisory'; source: 'reviewer' | 'system_validator'; openedBy: { kind: 'reviewer'; reviewerAttemptId: string } | { kind: 'system_validator'; validatorExecutionId: string } })
  | (V2 & { type: 'structured_finding_verification_recorded'; recordId: string; recordRef: BlobRefV2; findingId: string; reviewContext: { kind: 'map' | 'content'; roundId: string }; assignmentId: string; repairStage: 'map' | 'content'; verdict: 'resolved' | 'still_present' })
  | (V2 & { type: 'structured_validator_finding_verification_recorded'; recordId: string; recordRef: BlobRefV2; findingId: string; reviewContext: { kind: 'map' | 'content'; roundId: string }; repairStage: 'map' | 'content'; verdict: 'resolved' | 'still_present'; validatorExecutionId: string; validatorAggregateRef: BlobRefV2; validationReceiptRef: BlobRefV2 | null })
  | (V2 & { type: 'structured_review_assignment_completed'; assignmentId: string; reviewRoundId: string; workItemId: string; attemptId: string; ledgerRef: BlobRefV2; source: 'batch' | 'whole_tree_observation' })
  | (V2 & { type: 'structured_whole_tree_observation_recorded'; observationId: string; reviewRoundId: string; level: number; parentObservationId: string | null; observationRef: BlobRefV2; coveredTargetCount: number; childObservationRefs: BlobRefV2[] })
  | (V2 & { type: 'structured_review_round_completed'; reviewRoundId: string; coverageCoreRef: BlobRefV2 })
  | (V2 & { type: 'structured_review_round_settled'; reviewRoundId: string; settlementCoreRef: BlobRefV2; outcome: 'content_repair' | 'seal' })
  | (V2 & { type: 'structured_repair_scope_requested'; requestId: string; repairPlanId: string; planRevisionId: string; track: 'map' | 'content'; findingIds: string[]; requestedNodeIds: string[]; requestedRelationIds: string[]; requestedSlotIds: string[]; reason: string })
  | (V2 & { type: 'structured_repair_scope_expansion_approved_v2'; requestId: string; repairPlanId: string; supersededPlanRevisionId: string; successorPlanRevisionId: string; successorPlanSpecRef: BlobRefV2 })
  | (V2 & { type: 'structured_repair_scope_expansion_rejected_v2'; requestId: string; repairPlanId: string; planRevisionId: string; reason: string })
  | (V2 & { type: 'structured_repair_grant_issued'; grantSpecRef: BlobRefV2; grantSpecId: string; workItemId: string; grantKind: 'initial_structure_chunk' | 'initial_generation_batch' | 'map_repair_batch' | 'content_repair_batch' })
  | (V2 & { type: 'structured_repair_committed'; repairPlanId: string; planRevisionId: string; batchOrdinal: number; workItemId: string; attemptId: string; stagingRootRef: BlobRefV2 })
  | (V2 & { type: 'structured_finding_addressed'; findingId: string; repairStage: 'map' | 'content'; repairPlanId: string })
  | (V2 & { type: 'structured_finding_verified_closed'; findingId: string })
  | (V2 & { type: 'structured_scaffold_sealed_v2'; sealWorkItemId: string; sealRecordRef: BlobRefV2; sealValidationBundleRef: BlobRefV2; mapRef: BlobRefV2; contentRevisionManifestRef: BlobRefV2; reviewBundleRef: BlobRefV2; artifactRef: BlobRefV2 })
  | (V2 & { type: 'structured_round_budget_override_transferred_v2'; overrideRef: BlobRefV2; fromRepairPlanRef: BlobRefV2; toRepairPlanRef: BlobRefV2; transferOperationId: string });

/** Frozen ordered list of every v2 event name (used by dispatch and GC). */
export const AUTHORITATIVE_REVIEW_EVENT_NAMES_V2: readonly string[] = [
  'structured_map_candidate_committed',
  'structured_work_item_created',
  'structured_work_item_leased',
  'structured_work_item_completed',
  'structured_work_item_retryable_failed',
  'structured_work_item_requeued',
  'structured_work_item_lease_reclaimed',
  'structured_work_item_terminal_failed',
  'structured_work_item_superseded',
  'structured_work_item_parked',
  'structured_work_item_resumed',
  'structured_assignment_dispatched',
  'structured_generic_agent_attempt_started',
  'structured_generic_agent_attempt_completed',
  'structured_generic_agent_attempt_retryable_failed',
  'structured_generic_agent_attempt_terminal_failed',
  'structured_generic_agent_attempt_abandoned',
  'structured_agent_attempt_started_v2',
  'structured_agent_attempt_completed_v2',
  'structured_agent_attempt_retryable_failed_v2',
  'structured_agent_attempt_terminal_failed_v2',
  'structured_agent_attempt_abandoned_v2',
  'structured_system_command_started',
  'structured_system_command_completed',
  'structured_system_command_retryable_failed',
  'structured_system_command_terminal_failed',
  'structured_system_command_abandoned',
  'structured_seal_validation_rejected_v2',
  'structured_map_build_started',
  'structured_map_chunk_committed',
  'structured_map_build_finish_proposed',
  'structured_map_build_rejected',
  'structured_map_build_finalized',
  'structured_generation_plan_started',
  'structured_generation_batch_committed',
  'structured_generation_plan_rejected',
  'structured_generation_plan_completed',
  'structured_migration_validation_plan_started',
  'structured_migration_validation_batch_completed',
  'structured_migration_validation_settlement_completed',
  'structured_map_repair_plan_started',
  'structured_map_repair_batch_committed',
  'structured_map_repair_plan_rejected',
  'structured_content_repair_plan_started',
  'structured_content_repair_batch_committed',
  'structured_content_repair_plan_rejected',
  'structured_repair_plan_revision_started',
  'structured_task_failed_v2',
  'structured_task_reopened_v2',
  'structured_task_retry_resumed_v2',
  'structured_task_suspension_applied_v2',
  'structured_task_suspension_cleared_v2',
  'structured_human_answer_delivered_v2',
  'structured_human_question_opened_v2',
  'artifact_published_v2',
  'structured_system_artifact_delivery_created',
  'structured_map_review_round_planned',
  'structured_map_review_assignment_committed',
  'structured_map_observation_recorded',
  'structured_map_review_round_completed',
  'structured_map_review_round_settled',
  'structured_map_activated',
  'structured_content_revision_committed',
  'structured_review_round_planned',
  'structured_review_assignment_started',
  'structured_content_review_assignment_committed',
  'structured_finding_opened',
  'structured_finding_verification_recorded',
  'structured_validator_finding_verification_recorded',
  'structured_review_assignment_completed',
  'structured_whole_tree_observation_recorded',
  'structured_review_round_completed',
  'structured_review_round_settled',
  'structured_repair_scope_requested',
  'structured_repair_scope_expansion_approved_v2',
  'structured_repair_scope_expansion_rejected_v2',
  'structured_repair_grant_issued',
  'structured_repair_committed',
  'structured_finding_addressed',
  'structured_finding_verified_closed',
  'structured_scaffold_sealed_v2',
  'structured_round_budget_override_transferred_v2',
];

const V2_BASE_KEYS = ['id', 'at', 'protocolVersion', 'type'] as const;

function baseAnd(...fields: string[]): ReadonlySet<string> {
  return new Set([...V2_BASE_KEYS, ...fields]);
}

/** Closed per-member key sets: cross-branch fields are unknown-field errors. */
const MEMBER_KEYS_V2: Record<string, ReadonlySet<string>> = {
  structured_work_item_created: baseAnd(
    'workItemId',
    'kind',
    'roleBinding',
    'agentExecutionKind',
    'sessionKind',
    'roundId',
    'logicalAssignmentId',
    'reviewAssignmentId',
    'grantSpecRef',
    'inputArtifactDeliveryId',
    'scopeDecisionReason',
    'authorityBaseRef',
    'payloadRef',
    'initialLeaseEpoch',
    'maxAutomaticRetries',
  ),
  structured_work_item_leased: baseAnd(
    'workItemId',
    'leaseEpoch',
    'leaseOwner',
    'leaseExpiresAt',
    'expectedLastSequence',
    'authorityBaseRef',
  ),
  structured_work_item_completed: baseAnd('workItemId', 'leaseEpoch', 'authorityBaseRef'),
  structured_work_item_retryable_failed: baseAnd(
    'workItemId',
    'leaseEpoch',
    'failureCode',
    'failureDigest',
    'retryOrdinal',
    'retryNotBefore',
    'maxAutomaticRetries',
    'validatorAggregateRef',
    'authorityBaseRef',
  ),
  structured_work_item_requeued: baseAnd(
    'workItemId',
    'leaseEpoch',
    'expectedLastSequence',
    'authorityBaseRef',
  ),
  structured_work_item_lease_reclaimed: baseAnd(
    'workItemId',
    'leaseEpoch',
    'reason',
    'authorityBaseRef',
  ),
  structured_work_item_terminal_failed: baseAnd(
    'workItemId',
    'leaseEpoch',
    'failureCode',
    'failureDigest',
    'terminalAttemptId',
    'terminalCommandId',
    'validatorAggregateRef',
    'authorityBaseRef',
  ),
  structured_work_item_superseded: baseAnd('workItemId', 'leaseEpoch', 'reason', 'authorityBaseRef'),
  structured_work_item_parked: baseAnd(
    'workItemId',
    'leaseEpoch',
    'parkDisposition',
    'authorityBaseRef',
  ),
  structured_work_item_resumed: baseAnd(
    'workItemId',
    'leaseEpoch',
    'expectedLastSequence',
    'authorityBaseRef',
  ),
  structured_assignment_dispatched: baseAnd(
    'dispatchRef',
    'workItemId',
    'attemptId',
    'logicalAssignmentId',
    'reviewAssignmentId',
    'agentExecutionKind',
    'sessionKind',
    'inputArtifactDeliveryId',
    'authorityBaseRef',
  ),
  structured_generic_agent_attempt_started: baseAnd(
    'attemptId',
    'workItemId',
    'agentId',
    'logicalAssignmentId',
    'leaseEpoch',
    'inputArtifactDeliveryId',
    'authorityBaseRef',
  ),
  structured_generic_agent_attempt_completed: baseAnd(
    'attemptId',
    'workItemId',
    'agentId',
    'logicalAssignmentId',
    'leaseEpoch',
    'inputArtifactDeliveryId',
    'authorityBaseRef',
  ),
  structured_generic_agent_attempt_retryable_failed: baseAnd(
    'attemptId',
    'workItemId',
    'agentId',
    'logicalAssignmentId',
    'leaseEpoch',
    'inputArtifactDeliveryId',
    'failureCode',
    'failureDigest',
    'retryOrdinal',
    'retryNotBefore',
    'validatorAggregateRef',
    'authorityBaseRef',
  ),
  structured_generic_agent_attempt_terminal_failed: baseAnd(
    'attemptId',
    'workItemId',
    'agentId',
    'logicalAssignmentId',
    'leaseEpoch',
    'inputArtifactDeliveryId',
    'failureCode',
    'failureDigest',
    'validatorAggregateRef',
    'authorityBaseRef',
  ),
  structured_generic_agent_attempt_abandoned: baseAnd(
    'attemptId',
    'workItemId',
    'agentId',
    'logicalAssignmentId',
    'leaseEpoch',
    'inputArtifactDeliveryId',
    'reason',
    'authorityBaseRef',
  ),
  structured_agent_attempt_started_v2: baseAnd(
    'workItemId',
    'logicalAssignmentId',
    'reviewAssignmentId',
    'attemptId',
    'sessionKind',
    'leaseEpoch',
    'authorityBaseRef',
  ),
  structured_agent_attempt_completed_v2: baseAnd(
    'workItemId',
    'logicalAssignmentId',
    'reviewAssignmentId',
    'attemptId',
    'sessionKind',
    'leaseEpoch',
    'authorityBaseRef',
  ),
  structured_agent_attempt_retryable_failed_v2: baseAnd(
    'workItemId',
    'logicalAssignmentId',
    'reviewAssignmentId',
    'attemptId',
    'sessionKind',
    'leaseEpoch',
    'failureCode',
    'failureDigest',
    'retryOrdinal',
    'retryNotBefore',
    'validatorAggregateRef',
    'authorityBaseRef',
  ),
  structured_agent_attempt_terminal_failed_v2: baseAnd(
    'workItemId',
    'logicalAssignmentId',
    'reviewAssignmentId',
    'attemptId',
    'sessionKind',
    'leaseEpoch',
    'failureCode',
    'failureDigest',
    'validatorAggregateRef',
    'authorityBaseRef',
  ),
  structured_agent_attempt_abandoned_v2: baseAnd(
    'workItemId',
    'logicalAssignmentId',
    'reviewAssignmentId',
    'attemptId',
    'sessionKind',
    'leaseEpoch',
    'reason',
    'authorityBaseRef',
  ),
  structured_system_command_started: baseAnd(
    'commandId',
    'workItemId',
    'commandKind',
    'leaseEpoch',
    'authorityBaseRef',
  ),
  structured_system_command_completed: baseAnd(
    'commandId',
    'workItemId',
    'commandKind',
    'leaseEpoch',
    'authorityBaseRef',
  ),
  structured_system_command_retryable_failed: baseAnd(
    'commandId',
    'workItemId',
    'commandKind',
    'leaseEpoch',
    'failureCode',
    'failureDigest',
    'retryOrdinal',
    'retryNotBefore',
    'validatorAggregateRef',
    'authorityBaseRef',
  ),
  structured_system_command_terminal_failed: baseAnd(
    'commandId',
    'workItemId',
    'commandKind',
    'leaseEpoch',
    'failureCode',
    'failureDigest',
    'validatorAggregateRef',
    'authorityBaseRef',
  ),
  structured_system_command_abandoned: baseAnd(
    'commandId',
    'workItemId',
    'commandKind',
    'leaseEpoch',
    'reason',
    'authorityBaseRef',
  ),
  structured_seal_validation_rejected_v2: baseAnd(
    'sealWorkItemId',
    'stage',
    'validatorAggregateRef',
    'validationReceiptRef',
  ),
  structured_map_build_started: baseAnd(
    'mapBuildId',
    'revision',
    'mapBuildSpecRef',
    'supersedesMapBuildId',
    'sourceValidationReceiptRef',
  ),
  structured_map_chunk_committed: baseAnd(
    'mapBuildId',
    'chunkId',
    'chunkOrdinal',
    'chunkRef',
    'parentFrontierDigest',
  ),
  structured_map_build_finish_proposed: baseAnd(
    'mapBuildId',
    'expectedChunkCount',
    'expectedFrontierDigest',
    'expectedRootCount',
  ),
  structured_map_build_rejected: baseAnd('mapBuildId', 'validatorAggregateRef', 'validationReceiptRef'),
  structured_map_build_finalized: baseAnd(
    'mapBuildId',
    'manifestRef',
    'contributionManifestRef',
  ),
  structured_map_candidate_committed: baseAnd(
    'candidateId',
    'candidateRef',
    'candidateDigest',
    'baseMapId',
  ),
  structured_generation_plan_started: baseAnd(
    'generationPlanId',
    'revision',
    'supersedesGenerationPlanId',
    'generationPlanSpecRef',
    'sourceValidationReceiptRef',
  ),
  structured_generation_batch_committed: baseAnd(
    'generationPlanId',
    'batchOrdinal',
    'contentRevisionCommitCoreRef',
    'validatorAggregateRef',
    'contentRevisionManifestRef',
  ),
  structured_generation_plan_rejected: baseAnd(
    'generationPlanId',
    'validatorAggregateRef',
    'validationReceiptRef',
  ),
  structured_generation_plan_completed: baseAnd(
    'generationPlanId',
    'contentRevisionManifestRef',
    'validatorAggregateRef',
    'warningRootRef',
  ),
  structured_migration_validation_plan_started: baseAnd(
    'migrationValidationPlanId',
    'intentCoreRef',
    'planSpecRef',
  ),
  structured_migration_validation_batch_completed: baseAnd(
    'planSpecRef',
    'batchOrdinal',
    'batchResultRootRef',
    'batchOutcome',
  ),
  structured_migration_validation_settlement_completed: baseAnd(
    'settlementCoreRef',
    'provisionalManifestRef',
    'finalizerAggregateRef',
    'activationDecisionRef',
  ),
  structured_map_repair_plan_started: baseAnd(
    'repairPlanId',
    'planRevisionId',
    'repairPlanSpecRef',
    'sourceValidationReceiptRef',
  ),
  structured_map_repair_batch_committed: baseAnd(
    'repairPlanId',
    'planRevisionId',
    'batchOrdinal',
    'stagingRootRef',
  ),
  structured_map_repair_plan_rejected: baseAnd(
    'repairPlanId',
    'planRevisionId',
    'validatorAggregateRef',
    'validationReceiptRef',
  ),
  structured_content_repair_plan_started: baseAnd(
    'repairPlanId',
    'planRevisionId',
    'repairPlanSpecRef',
    'sourceValidationReceiptRef',
  ),
  structured_content_repair_batch_committed: baseAnd(
    'repairPlanId',
    'planRevisionId',
    'batchOrdinal',
    'stagingRootRef',
  ),
  structured_content_repair_plan_rejected: baseAnd(
    'repairPlanId',
    'planRevisionId',
    'validatorAggregateRef',
    'validationReceiptRef',
  ),
  structured_repair_plan_revision_started: baseAnd(
    'repairPlanId',
    'planRevisionId',
    'repairPlanSpecRef',
    'supersedesPlanRevisionId',
    'successorReason',
  ),
  structured_task_failed_v2: baseAnd(
    'workItemId',
    'attemptId',
    'commandId',
    'leaseEpoch',
    'failureCode',
    'failureDigest',
    'failureRecoveryPayloadRef',
    'authorityBaseRef',
  ),
  structured_task_reopened_v2: baseAnd(
    'expectedLastSequence',
    'operationId',
    'operatorId',
    'reason',
    'recipeKey',
    'track',
    'failureRecoveryPayloadRef',
    'overrideRef',
  ),
  structured_task_retry_resumed_v2: baseAnd(
    'workItemId',
    'leaseEpoch',
    'expectedLastSequence',
    'authorityBaseRef',
  ),
  structured_task_suspension_applied_v2: baseAnd('suspensionId', 'reason', 'operationId'),
  structured_task_suspension_cleared_v2: baseAnd('suspensionId', 'operationId'),
  structured_human_answer_delivered_v2: baseAnd(
    'deliveryId',
    'questionId',
    'questionVersion',
    'originalWorkItemId',
    'replacementWorkItemId',
    'logicalAssignmentId',
    'answerDigest',
    'operationId',
    'authorityBaseRef',
  ),
  structured_human_question_opened_v2: baseAnd(
    'questionId',
    'questionVersion',
    'questionDigest',
    'originalWorkItemId',
    'attemptId',
    'leaseEpoch',
    'logicalAssignmentId',
    'authorityBaseRef',
  ),
  artifact_published_v2: baseAnd(
    'artifactId',
    'artifactVersion',
    'deliveryRef',
    'files',
    'mediaType',
    'provenance',
  ),
  structured_system_artifact_delivery_created: baseAnd(
    'deliveryId',
    'deliveryRef',
    'artifactId',
    'artifactRef',
    'sealRecordRef',
    'submitterWorkItemId',
  ),
  structured_map_review_round_planned: baseAnd(
    'mapReviewRoundId',
    'mapCycleOrdinal',
    'candidateId',
    'candidateRef',
    'contentRevisionManifestRef',
    'reviewPolicyDigest',
    'coverageNodeCount',
    'coverageRelationCount',
    'assignmentCount',
    'consumedOverrideRef',
  ),
  structured_map_review_assignment_committed: baseAnd(
    'assignmentId',
    'mapReviewRoundId',
    'workItemId',
    'attemptId',
    'reviewAssignmentId',
    'source',
    'ledgerRef',
    'coverageTargetCount',
    'findingCount',
  ),
  structured_map_observation_recorded: baseAnd(
    'observationId',
    'mapReviewRoundId',
    'level',
    'parentObservationId',
    'observationRef',
    'coveredTargetCount',
    'childObservationRefs',
  ),
  structured_map_review_round_completed: baseAnd('mapReviewRoundId', 'coverageCoreRef'),
  structured_map_review_round_settled: baseAnd('mapReviewRoundId', 'settlementCoreRef', 'outcome'),
  structured_map_activated: baseAnd(
    'mapId',
    'mapRevision',
    'supersedesMapId',
    'mapSnapshotRef',
    'mapReviewBundleRef',
    'mapSemanticDigest',
    'contentRevisionManifestRef',
    'activationValidatorAggregateRef',
    'migrationSettlementCoreRef',
    'migrationActivationDecisionRef',
  ),
  structured_content_revision_committed: baseAnd(
    'contentRevisionManifestRef',
    'taskContentRevision',
    'manifestPhase',
    'producerPlanSpecRef',
    'priorManifestRef',
  ),
  structured_review_round_planned: baseAnd(
    'reviewRoundId',
    'contentCycleOrdinal',
    'mapRef',
    'mapSemanticDigest',
    'contentRevisionManifestRef',
    'reviewPolicyDigest',
    'adoptionRootRef',
    'coverageSlotCount',
    'coverageRelationCount',
    'assignmentCount',
    'verificationFindingCount',
    'consumedOverrideRef',
  ),
  structured_review_assignment_started: baseAnd(
    'assignmentId',
    'reviewRoundId',
    'workItemId',
    'attemptId',
    'reviewAssignmentId',
    'source',
  ),
  structured_content_review_assignment_committed: baseAnd(
    'assignmentId',
    'reviewRoundId',
    'workItemId',
    'attemptId',
    'reviewAssignmentId',
    'source',
    'ledgerRef',
    'coverageTargetCount',
    'findingCount',
  ),
  structured_finding_opened: baseAnd(
    'findingId',
    'findingRef',
    'reviewContext',
    'primaryLocation',
    'defectClass',
    'severity',
    'source',
    'openedBy',
  ),
  structured_finding_verification_recorded: baseAnd(
    'recordId',
    'recordRef',
    'findingId',
    'reviewContext',
    'assignmentId',
    'repairStage',
    'verdict',
  ),
  structured_validator_finding_verification_recorded: baseAnd(
    'recordId',
    'recordRef',
    'findingId',
    'reviewContext',
    'repairStage',
    'verdict',
    'validatorExecutionId',
    'validatorAggregateRef',
    'validationReceiptRef',
  ),
  structured_review_assignment_completed: baseAnd(
    'assignmentId',
    'reviewRoundId',
    'workItemId',
    'attemptId',
    'ledgerRef',
    'source',
  ),
  structured_whole_tree_observation_recorded: baseAnd(
    'observationId',
    'reviewRoundId',
    'level',
    'parentObservationId',
    'observationRef',
    'coveredTargetCount',
    'childObservationRefs',
  ),
  structured_review_round_completed: baseAnd('reviewRoundId', 'coverageCoreRef'),
  structured_review_round_settled: baseAnd('reviewRoundId', 'settlementCoreRef', 'outcome'),
  structured_repair_scope_requested: baseAnd(
    'requestId',
    'repairPlanId',
    'planRevisionId',
    'track',
    'findingIds',
    'requestedNodeIds',
    'requestedRelationIds',
    'requestedSlotIds',
    'reason',
  ),
  structured_repair_scope_expansion_approved_v2: baseAnd(
    'requestId',
    'repairPlanId',
    'supersededPlanRevisionId',
    'successorPlanRevisionId',
    'successorPlanSpecRef',
  ),
  structured_repair_scope_expansion_rejected_v2: baseAnd(
    'requestId',
    'repairPlanId',
    'planRevisionId',
    'reason',
  ),
  structured_repair_grant_issued: baseAnd('grantSpecRef', 'grantSpecId', 'workItemId', 'grantKind'),
  structured_repair_committed: baseAnd(
    'repairPlanId',
    'planRevisionId',
    'batchOrdinal',
    'workItemId',
    'attemptId',
    'stagingRootRef',
  ),
  structured_finding_addressed: baseAnd('findingId', 'repairStage', 'repairPlanId'),
  structured_finding_verified_closed: baseAnd('findingId'),
  structured_scaffold_sealed_v2: baseAnd(
    'sealWorkItemId',
    'sealRecordRef',
    'sealValidationBundleRef',
    'mapRef',
    'contentRevisionManifestRef',
    'reviewBundleRef',
    'artifactRef',
  ),
  structured_round_budget_override_transferred_v2: baseAnd(
    'overrideRef',
    'fromRepairPlanRef',
    'toRepairPlanRef',
    'transferOperationId',
  ),
};

/** Shared agent-attempt identity validation (design §17.2). */
function attemptIdentity(
  candidate: Record<string, unknown>,
): {
  workItemId: string;
  logicalAssignmentId: string;
  reviewAssignmentId: string | null;
  attemptId: string;
  sessionKind: StructuredSessionKindV2;
  leaseEpoch: number;
  authorityBaseRef: BlobRefV2;
} {
  return {
    workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
    logicalAssignmentId: assertNonEmptyString(candidate.logicalAssignmentId, '事件 logicalAssignmentId'),
    reviewAssignmentId: nullableString(candidate.reviewAssignmentId, '事件 reviewAssignmentId'),
    attemptId: assertNonEmptyString(candidate.attemptId, '事件 attemptId'),
    sessionKind: assertOneOf(candidate.sessionKind, SESSION_KINDS, '事件 sessionKind') as StructuredSessionKindV2,
    leaseEpoch: assertPositiveInteger(candidate.leaseEpoch, '事件 leaseEpoch'),
    authorityBaseRef: validateBlobRefV2(candidate.authorityBaseRef, '事件 authorityBaseRef'),
  };
}

function failureFields(candidate: Record<string, unknown>): {
  failureCode: string;
  failureDigest: string;
  validatorAggregateRef: BlobRefV2 | null;
} {
  return {
    failureCode: assertNonEmptyString(candidate.failureCode, '事件 failureCode'),
    failureDigest: assertSha256(candidate.failureDigest, '事件 failureDigest'),
    validatorAggregateRef: requireValidationCustody(
      candidate.validatorAggregateRef,
      '事件 validatorAggregateRef',
    ),
  };
}

/**
 * Validates one unknown payload against the closed v2 union and returns it
 * narrowed to `AuthoritativeReviewEventV2`. Fails loud with the public
 * EVENT_INVALID error before anything touches the filesystem; every member
 * field is rebuilt from validated values, so a returned event only ever
 * carries declared keys.
 */
export function validateAuthoritativeReviewEventV2(
  candidate: unknown,
): AuthoritativeReviewEventV2 {
  if (!isPlainObject(candidate)) {
    throw invalidEvent('事件必须是对象。');
  }
  const id = assertNonEmptyString(candidate.id, '事件 id');
  if (!EVENT_ID_PATTERN.test(id)) {
    throw invalidEvent('事件 id 必须是稳定的文件安全标识。');
  }
  const at = assertAt(candidate.at, '事件 at');
  if (candidate.protocolVersion !== 2) {
    throw invalidEvent('事件 protocolVersion 必须是 2。');
  }
  if (typeof candidate.type !== 'string') {
    throw invalidEvent('事件 type 必须是字符串。');
  }
  const allowed = MEMBER_KEYS_V2[candidate.type];
  if (allowed === undefined) {
    throw invalidEvent(`未知事件类型 ${candidate.type}。`);
  }
  assertExactKeys(candidate, allowed, '事件');
  const type = candidate.type;
  switch (type) {
    case 'structured_work_item_created': {
      const kind = assertOneOf(candidate.kind, WORK_ITEM_KINDS, '事件 kind') as WorkItemKindV2;
      const agentExecutionKind = nullableString(candidate.agentExecutionKind, '事件 agentExecutionKind');
      const logicalAssignmentId = nullableString(candidate.logicalAssignmentId, '事件 logicalAssignmentId');
      const reviewAssignmentId = nullableString(candidate.reviewAssignmentId, '事件 reviewAssignmentId');
      const sessionKind =
        candidate.sessionKind === null || candidate.sessionKind === undefined
          ? null
          : (assertOneOf(candidate.sessionKind, SESSION_KINDS, '事件 sessionKind') as StructuredSessionKindV2);
      const grantSpecRef = validateNullableBlobRef(candidate.grantSpecRef, '事件 grantSpecRef');
      const inputArtifactDeliveryId = nullableString(
        candidate.inputArtifactDeliveryId,
        '事件 inputArtifactDeliveryId',
      );
      const isAgent = kind === 'agent_assignment';
      if (!isAgent) {
        if (roleBindingOf(candidate) !== null) {
          throw invalidEvent('System WorkItem 不得携带 roleBinding。');
        }
        if (agentExecutionKind !== null) {
          throw invalidEvent('System WorkItem 不得携带 agentExecutionKind。');
        }
        if (sessionKind !== null) {
          throw invalidEvent('System WorkItem 不得携带 sessionKind。');
        }
        if (logicalAssignmentId !== null) {
          throw invalidEvent('System WorkItem 不得携带 logicalAssignmentId。');
        }
        if (reviewAssignmentId !== null) {
          throw invalidEvent('System WorkItem 不得携带 reviewAssignmentId。');
        }
        if (grantSpecRef !== null) {
          throw invalidEvent('System WorkItem 不得携带 grantSpecRef。');
        }
        if (inputArtifactDeliveryId !== null) {
          throw invalidEvent('System WorkItem 不得携带 inputArtifactDeliveryId。');
        }
      } else {
        if (roleBindingOf(candidate) === null) {
          throw invalidEvent('agent_assignment WorkItem 必须携带 roleBinding。');
        }
        if (agentExecutionKind === null) {
          throw invalidEvent('agent_assignment WorkItem 必须携带 agentExecutionKind。');
        }
        if (logicalAssignmentId === null) {
          throw invalidEvent('agent_assignment WorkItem 必须携带 logicalAssignmentId。');
        }
        if (grantSpecRef === null) {
          throw invalidEvent('agent_assignment WorkItem 必须携带 grantSpecRef。');
        }
        if (agentExecutionKind === 'structured_session' && sessionKind === null) {
          throw invalidEvent('structured_session WorkItem 必须携带 sessionKind。');
        }
        if (agentExecutionKind === 'generic_turn') {
          if (sessionKind !== null) {
            throw invalidEvent('generic_turn WorkItem 不得携带 sessionKind。');
          }
          if (inputArtifactDeliveryId === null) {
            throw invalidEvent('generic_turn WorkItem 必须携带 inputArtifactDeliveryId。');
          }
        } else if (inputArtifactDeliveryId !== null) {
          throw invalidEvent('structured_session WorkItem 不得携带 inputArtifactDeliveryId。');
        }
      }
      const scopeDecisionReason = nullableString(candidate.scopeDecisionReason, '事件 scopeDecisionReason');
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
        kind,
        roleBinding: roleBindingOf(candidate),
        agentExecutionKind: agentExecutionKind as 'structured_session' | 'generic_turn' | null,
        sessionKind,
        roundId: nullableString(candidate.roundId, '事件 roundId'),
        logicalAssignmentId,
        reviewAssignmentId,
        grantSpecRef,
        inputArtifactDeliveryId,
        ...(candidate.scopeDecisionReason === undefined ? {} : { scopeDecisionReason }),
        authorityBaseRef: validateBlobRefV2(candidate.authorityBaseRef, '事件 authorityBaseRef'),
        payloadRef: validateBlobRefV2(candidate.payloadRef, '事件 payloadRef'),
        initialLeaseEpoch: assertNonNegativeInteger(candidate.initialLeaseEpoch, '事件 initialLeaseEpoch'),
        maxAutomaticRetries: assertNonNegativeInteger(candidate.maxAutomaticRetries, '事件 maxAutomaticRetries'),
      };
    }
    case 'structured_work_item_leased':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
        leaseEpoch: assertPositiveInteger(candidate.leaseEpoch, '事件 leaseEpoch'),
        leaseOwner: assertNonEmptyString(candidate.leaseOwner, '事件 leaseOwner'),
        leaseExpiresAt: assertAt(candidate.leaseExpiresAt, '事件 leaseExpiresAt'),
        expectedLastSequence: assertNonNegativeInteger(candidate.expectedLastSequence, '事件 expectedLastSequence'),
        authorityBaseRef: validateBlobRefV2(candidate.authorityBaseRef, '事件 authorityBaseRef'),
      };
    case 'structured_work_item_completed':
      return workItemTerminalTransition(
        candidate,
        id,
        at,
        'structured_work_item_completed',
      );
    case 'structured_work_item_requeued':
      return workItemTerminalTransition(candidate, id, at, 'structured_work_item_requeued');
    case 'structured_work_item_resumed':
      return workItemTerminalTransition(candidate, id, at, 'structured_work_item_resumed');
    case 'structured_task_retry_resumed_v2':
      return workItemTerminalTransition(candidate, id, at, 'structured_task_retry_resumed_v2');
    case 'structured_work_item_retryable_failed':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
        leaseEpoch: assertPositiveInteger(candidate.leaseEpoch, '事件 leaseEpoch'),
        failureCode: assertNonEmptyString(candidate.failureCode, '事件 failureCode'),
        failureDigest: assertSha256(candidate.failureDigest, '事件 failureDigest'),
        retryOrdinal: assertPositiveInteger(candidate.retryOrdinal, '事件 retryOrdinal'),
        retryNotBefore: assertAt(candidate.retryNotBefore, '事件 retryNotBefore'),
        maxAutomaticRetries: assertNonNegativeInteger(candidate.maxAutomaticRetries, '事件 maxAutomaticRetries'),
        validatorAggregateRef: requireValidationCustody(candidate.validatorAggregateRef, '事件 validatorAggregateRef'),
        authorityBaseRef: validateBlobRefV2(candidate.authorityBaseRef, '事件 authorityBaseRef'),
      };
    case 'structured_work_item_lease_reclaimed':
      return workItemStateEvent(candidate, id, at, 'structured_work_item_lease_reclaimed');
    case 'structured_work_item_superseded':
      return workItemStateEvent(candidate, id, at, 'structured_work_item_superseded');
    case 'structured_work_item_terminal_failed': {
      const failure = failureFields(candidate);
      const terminalAttemptId = nullableString(candidate.terminalAttemptId, '事件 terminalAttemptId');
      const terminalCommandId = nullableString(candidate.terminalCommandId, '事件 terminalCommandId');
      if ((terminalAttemptId === null) === (terminalCommandId === null)) {
        throw invalidEvent('事件必须恰好绑定一个 attempt 或 command。');
      }
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
        leaseEpoch: assertPositiveInteger(candidate.leaseEpoch, '事件 leaseEpoch'),
        ...failure,
        terminalAttemptId,
        terminalCommandId,
        authorityBaseRef: validateBlobRefV2(candidate.authorityBaseRef, '事件 authorityBaseRef'),
      };
    }
    case 'structured_work_item_parked':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
        leaseEpoch: assertPositiveInteger(candidate.leaseEpoch, '事件 leaseEpoch'),
        parkDisposition: validateParkDisposition(candidate.parkDisposition, '事件 parkDisposition'),
        authorityBaseRef: validateBlobRefV2(candidate.authorityBaseRef, '事件 authorityBaseRef'),
      };
    case 'structured_assignment_dispatched': {
      const agentExecutionKind = assertOneOf(
        candidate.agentExecutionKind,
        AGENT_EXECUTION_KINDS,
        '事件 agentExecutionKind',
      ) as 'structured_session' | 'generic_turn';
      const sessionKind =
        candidate.sessionKind === null || candidate.sessionKind === undefined
          ? null
          : (assertOneOf(candidate.sessionKind, SESSION_KINDS, '事件 sessionKind') as StructuredSessionKindV2);
      const inputArtifactDeliveryId = nullableString(
        candidate.inputArtifactDeliveryId,
        '事件 inputArtifactDeliveryId',
      );
      if (agentExecutionKind === 'structured_session' && sessionKind === null) {
        throw invalidEvent('structured_session dispatch 必须携带 sessionKind。');
      }
      if (agentExecutionKind === 'generic_turn' && sessionKind !== null) {
        throw invalidEvent('generic_turn dispatch 不得携带 sessionKind。');
      }
      if (agentExecutionKind === 'generic_turn' && inputArtifactDeliveryId === null) {
        throw invalidEvent('generic_turn dispatch 必须携带 inputArtifactDeliveryId。');
      }
      if (agentExecutionKind === 'structured_session' && inputArtifactDeliveryId !== null) {
        throw invalidEvent('structured_session dispatch 不得携带 inputArtifactDeliveryId。');
      }
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        dispatchRef: validateBlobRefV2(candidate.dispatchRef, '事件 dispatchRef'),
        workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
        attemptId: assertNonEmptyString(candidate.attemptId, '事件 attemptId'),
        logicalAssignmentId: assertNonEmptyString(candidate.logicalAssignmentId, '事件 logicalAssignmentId'),
        reviewAssignmentId: nullableString(candidate.reviewAssignmentId, '事件 reviewAssignmentId'),
        agentExecutionKind,
        sessionKind,
        inputArtifactDeliveryId,
        authorityBaseRef: validateBlobRefV2(candidate.authorityBaseRef, '事件 authorityBaseRef'),
      };
    }
    case 'structured_generic_agent_attempt_started':
      return genericAttemptNext(candidate, id, at, 'structured_generic_agent_attempt_started');
    case 'structured_generic_agent_attempt_completed':
      return genericAttemptNext(candidate, id, at, 'structured_generic_agent_attempt_completed');
    case 'structured_generic_agent_attempt_abandoned':
      return genericAttemptNext(candidate, id, at, 'structured_generic_agent_attempt_abandoned');
    case 'structured_generic_agent_attempt_retryable_failed': {
      const identity = genericIdentity(candidate);
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        ...identity,
        failureCode: assertNonEmptyString(candidate.failureCode, '事件 failureCode'),
        failureDigest: assertSha256(candidate.failureDigest, '事件 failureDigest'),
        retryOrdinal: assertPositiveInteger(candidate.retryOrdinal, '事件 retryOrdinal'),
        retryNotBefore: assertAt(candidate.retryNotBefore, '事件 retryNotBefore'),
        validatorAggregateRef: requireValidationCustody(candidate.validatorAggregateRef, '事件 validatorAggregateRef'),
      };
    }
    case 'structured_generic_agent_attempt_terminal_failed': {
      const identity = genericIdentity(candidate);
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        ...identity,
        ...failureFields(candidate),
      };
    }
    case 'structured_agent_attempt_started_v2':
      return { protocolVersion: 2, id, at, type, ...attemptIdentity(candidate) };
    case 'structured_agent_attempt_completed_v2':
      return { protocolVersion: 2, id, at, type, ...attemptIdentity(candidate) };
    case 'structured_agent_attempt_retryable_failed_v2': {
      const identity = attemptIdentity(candidate);
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        ...identity,
        failureCode: assertNonEmptyString(candidate.failureCode, '事件 failureCode'),
        failureDigest: assertSha256(candidate.failureDigest, '事件 failureDigest'),
        retryOrdinal: assertPositiveInteger(candidate.retryOrdinal, '事件 retryOrdinal'),
        retryNotBefore: assertAt(candidate.retryNotBefore, '事件 retryNotBefore'),
        validatorAggregateRef: requireValidationCustody(candidate.validatorAggregateRef, '事件 validatorAggregateRef'),
      };
    }
    case 'structured_agent_attempt_terminal_failed_v2': {
      const identity = attemptIdentity(candidate);
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        ...identity,
        ...failureFields(candidate),
      };
    }
    case 'structured_agent_attempt_abandoned_v2': {
      const identity = attemptIdentity(candidate);
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        ...identity,
        reason: assertOneOf(candidate.reason, RECLAIM_REASONS, '事件 reason'),
      };
    }
    case 'structured_system_command_started':
      return systemCommandNext(candidate, id, at, 'structured_system_command_started');
    case 'structured_system_command_completed':
      return systemCommandNext(candidate, id, at, 'structured_system_command_completed');
    case 'structured_system_command_abandoned':
      return systemCommandNext(candidate, id, at, 'structured_system_command_abandoned');
    case 'structured_system_command_retryable_failed': {
      const base = systemCommandBase(candidate);
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        ...base,
        failureCode: assertNonEmptyString(candidate.failureCode, '事件 failureCode'),
        failureDigest: assertSha256(candidate.failureDigest, '事件 failureDigest'),
        retryOrdinal: assertPositiveInteger(candidate.retryOrdinal, '事件 retryOrdinal'),
        retryNotBefore: assertAt(candidate.retryNotBefore, '事件 retryNotBefore'),
        validatorAggregateRef: requireValidationCustody(candidate.validatorAggregateRef, '事件 validatorAggregateRef'),
      };
    }
    case 'structured_system_command_terminal_failed': {
      const base = systemCommandBase(candidate);
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        ...base,
        ...failureFields(candidate),
      };
    }
    case 'structured_seal_validation_rejected_v2':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        sealWorkItemId: assertNonEmptyString(candidate.sealWorkItemId, '事件 sealWorkItemId'),
        stage: assertOneOf(candidate.stage, SEAL_STAGES, '事件 stage'),
        validatorAggregateRef: validateBlobRefV2(candidate.validatorAggregateRef, '事件 validatorAggregateRef'),
        validationReceiptRef: validateBlobRefV2(candidate.validationReceiptRef, '事件 validationReceiptRef'),
      };
    case 'structured_map_build_started':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        mapBuildId: assertNonEmptyString(candidate.mapBuildId, '事件 mapBuildId'),
        revision: assertPositiveInteger(candidate.revision, '事件 revision'),
        mapBuildSpecRef: validateBlobRefV2(candidate.mapBuildSpecRef, '事件 mapBuildSpecRef'),
        supersedesMapBuildId: nullableString(candidate.supersedesMapBuildId, '事件 supersedesMapBuildId'),
        sourceValidationReceiptRef: validateNullableBlobRef(
          candidate.sourceValidationReceiptRef,
          '事件 sourceValidationReceiptRef',
        ),
      };
    case 'structured_map_chunk_committed':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        mapBuildId: assertNonEmptyString(candidate.mapBuildId, '事件 mapBuildId'),
        chunkId: assertNonEmptyString(candidate.chunkId, '事件 chunkId'),
        chunkOrdinal: assertPositiveInteger(candidate.chunkOrdinal, '事件 chunkOrdinal'),
        chunkRef: validateBlobRefV2(candidate.chunkRef, '事件 chunkRef'),
        parentFrontierDigest: assertSha256(candidate.parentFrontierDigest, '事件 parentFrontierDigest'),
      };
    case 'structured_map_build_finish_proposed':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        mapBuildId: assertNonEmptyString(candidate.mapBuildId, '事件 mapBuildId'),
        expectedChunkCount: assertPositiveInteger(candidate.expectedChunkCount, '事件 expectedChunkCount'),
        expectedFrontierDigest: assertSha256(candidate.expectedFrontierDigest, '事件 expectedFrontierDigest'),
        expectedRootCount: assertPositiveInteger(candidate.expectedRootCount, '事件 expectedRootCount'),
      };
    case 'structured_map_build_rejected':
      return planRejected(candidate, id, at, 'structured_map_build_rejected');
    case 'structured_generation_plan_rejected':
      return planRejected(candidate, id, at, 'structured_generation_plan_rejected');
    case 'structured_map_repair_plan_rejected':
      return planRejected(candidate, id, at, 'structured_map_repair_plan_rejected');
    case 'structured_content_repair_plan_rejected':
      return planRejected(candidate, id, at, 'structured_content_repair_plan_rejected');
    case 'structured_map_build_finalized':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        mapBuildId: assertNonEmptyString(candidate.mapBuildId, '事件 mapBuildId'),
        manifestRef: validateBlobRefV2(candidate.manifestRef, '事件 manifestRef'),
        contributionManifestRef: validateBlobRefV2(
          candidate.contributionManifestRef,
          '事件 contributionManifestRef',
        ),
      };
    case 'structured_map_candidate_committed': {
      const candidateRef = validateBlobRefV2(candidate.candidateRef, '事件 candidateRef');
      const candidateDigest = assertSha256(candidate.candidateDigest, '事件 candidateDigest');
      if (candidateDigest !== candidateRef.digest) {
        throw invalidEvent('事件 candidateDigest 必须等于 candidateRef.digest。');
      }
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        candidateId: assertNonEmptyString(candidate.candidateId, '事件 candidateId'),
        candidateRef,
        candidateDigest,
        baseMapId: nullableString(candidate.baseMapId, '事件 baseMapId'),
      };
    }
    case 'structured_generation_plan_started':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        generationPlanId: assertNonEmptyString(candidate.generationPlanId, '事件 generationPlanId'),
        revision: assertPositiveInteger(candidate.revision, '事件 revision'),
        supersedesGenerationPlanId: nullableString(
          candidate.supersedesGenerationPlanId,
          '事件 supersedesGenerationPlanId',
        ),
        generationPlanSpecRef: validateBlobRefV2(candidate.generationPlanSpecRef, '事件 generationPlanSpecRef'),
        sourceValidationReceiptRef: validateNullableBlobRef(
          candidate.sourceValidationReceiptRef,
          '事件 sourceValidationReceiptRef',
        ),
      };
    case 'structured_generation_batch_committed':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        generationPlanId: assertNonEmptyString(candidate.generationPlanId, '事件 generationPlanId'),
        batchOrdinal: assertPositiveInteger(candidate.batchOrdinal, '事件 batchOrdinal'),
        contentRevisionCommitCoreRef: validateBlobRefV2(
          candidate.contentRevisionCommitCoreRef,
          '事件 contentRevisionCommitCoreRef',
        ),
        validatorAggregateRef: validateBlobRefV2(candidate.validatorAggregateRef, '事件 validatorAggregateRef'),
        contentRevisionManifestRef: validateBlobRefV2(
          candidate.contentRevisionManifestRef,
          '事件 contentRevisionManifestRef',
        ),
      };
    case 'structured_generation_plan_completed':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        generationPlanId: assertNonEmptyString(candidate.generationPlanId, '事件 generationPlanId'),
        contentRevisionManifestRef: validateBlobRefV2(
          candidate.contentRevisionManifestRef,
          '事件 contentRevisionManifestRef',
        ),
        validatorAggregateRef: validateBlobRefV2(candidate.validatorAggregateRef, '事件 validatorAggregateRef'),
        warningRootRef: validateNullableBlobRef(candidate.warningRootRef, '事件 warningRootRef'),
      };
    case 'structured_migration_validation_plan_started':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        migrationValidationPlanId: assertNonEmptyString(
          candidate.migrationValidationPlanId,
          '事件 migrationValidationPlanId',
        ),
        intentCoreRef: validateBlobRefV2(candidate.intentCoreRef, '事件 intentCoreRef'),
        planSpecRef: validateBlobRefV2(candidate.planSpecRef, '事件 planSpecRef'),
      };
    case 'structured_migration_validation_batch_completed':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        planSpecRef: validateBlobRefV2(candidate.planSpecRef, '事件 planSpecRef'),
        batchOrdinal: assertNonNegativeInteger(candidate.batchOrdinal, '事件 batchOrdinal'),
        batchResultRootRef: validateBlobRefV2(candidate.batchResultRootRef, '事件 batchResultRootRef'),
        batchOutcome: assertOneOf(candidate.batchOutcome, BATCH_ROUTE_OUTCOMES, '事件 batchOutcome'),
      };
    case 'structured_migration_validation_settlement_completed':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        settlementCoreRef: validateBlobRefV2(candidate.settlementCoreRef, '事件 settlementCoreRef'),
        provisionalManifestRef: validateBlobRefV2(candidate.provisionalManifestRef, '事件 provisionalManifestRef'),
        finalizerAggregateRef: validateBlobRefV2(candidate.finalizerAggregateRef, '事件 finalizerAggregateRef'),
        activationDecisionRef: validateBlobRefV2(candidate.activationDecisionRef, '事件 activationDecisionRef'),
      };
    case 'structured_map_repair_plan_started':
    case 'structured_content_repair_plan_started':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        repairPlanId: assertNonEmptyString(candidate.repairPlanId, '事件 repairPlanId'),
        planRevisionId: assertNonEmptyString(candidate.planRevisionId, '事件 planRevisionId'),
        repairPlanSpecRef: validateBlobRefV2(candidate.repairPlanSpecRef, '事件 repairPlanSpecRef'),
        sourceValidationReceiptRef: validateNullableBlobRef(
          candidate.sourceValidationReceiptRef,
          '事件 sourceValidationReceiptRef',
        ),
      };
    case 'structured_map_repair_batch_committed':
    case 'structured_content_repair_batch_committed':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        repairPlanId: assertNonEmptyString(candidate.repairPlanId, '事件 repairPlanId'),
        planRevisionId: assertNonEmptyString(candidate.planRevisionId, '事件 planRevisionId'),
        batchOrdinal: assertPositiveInteger(candidate.batchOrdinal, '事件 batchOrdinal'),
        stagingRootRef: validateBlobRefV2(candidate.stagingRootRef, '事件 stagingRootRef'),
      };
    case 'structured_repair_plan_revision_started': {
      const supersedesPlanRevisionId = nullableString(
        candidate.supersedesPlanRevisionId,
        '事件 supersedesPlanRevisionId',
      );
      const successorReason =
        candidate.successorReason === null || candidate.successorReason === undefined
          ? null
          : assertOneOf(candidate.successorReason, SUCCESSOR_REASONS, '事件 successorReason');
      if ((supersedesPlanRevisionId === null) !== (successorReason === null)) {
        throw invalidEvent('supersedesPlanRevisionId 与 successorReason 必须同时出现或同时为空。');
      }
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        repairPlanId: assertNonEmptyString(candidate.repairPlanId, '事件 repairPlanId'),
        planRevisionId: assertNonEmptyString(candidate.planRevisionId, '事件 planRevisionId'),
        repairPlanSpecRef: validateBlobRefV2(candidate.repairPlanSpecRef, '事件 repairPlanSpecRef'),
        supersedesPlanRevisionId,
        successorReason,
      };
    }
    case 'structured_task_failed_v2': {
      const attemptId = nullableString(candidate.attemptId, '事件 attemptId');
      const commandId = nullableString(candidate.commandId, '事件 commandId');
      if ((attemptId === null) === (commandId === null)) {
        throw invalidEvent('事件必须恰好绑定一个 attempt 或 command。');
      }
      if (candidate.failureRecoveryPayloadRef === undefined) {
        throw invalidEvent('事件 failureRecoveryPayloadRef 必须显式提供（可重开为 ref，不可重开为 null）。');
      }
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
        attemptId,
        commandId,
        leaseEpoch: assertPositiveInteger(candidate.leaseEpoch, '事件 leaseEpoch'),
        failureCode: assertNonEmptyString(candidate.failureCode, '事件 failureCode'),
        failureDigest: assertSha256(candidate.failureDigest, '事件 failureDigest'),
        failureRecoveryPayloadRef: validateNullableBlobRef(
          candidate.failureRecoveryPayloadRef,
          '事件 failureRecoveryPayloadRef',
        ),
        authorityBaseRef: validateBlobRefV2(candidate.authorityBaseRef, '事件 authorityBaseRef'),
      };
    }
    case 'structured_task_reopened_v2': {
      const recipeKey = assertOneOf(candidate.recipeKey, RECIPE_KEYS, '事件 recipeKey');
      const track =
        candidate.track === null || candidate.track === undefined
          ? null
          : (assertOneOf(candidate.track, REPAIR_TRACKS, '事件 track') as 'map' | 'content' | null);
      const overrideRef = validateNullableBlobRef(candidate.overrideRef, '事件 overrideRef');
      // Closed recipe/track/override matrix (spec §10.3.1 policy table).
      if (recipeKey === 'restart_map_review_cycle' || recipeKey === 'restart_content_review_cycle') {
        const expectedTrack = recipeKey === 'restart_map_review_cycle' ? 'map' : 'content';
        if (track !== expectedTrack) {
          throw invalidEvent(`配方 ${recipeKey} 的 track 必须是 ${expectedTrack}。`);
        }
        if (overrideRef === null) {
          throw invalidEvent(`配方 ${recipeKey} 必须携带 overrideRef。`);
        }
      } else if (recipeKey === 'retry_system_command') {
        if (track === 'map' || track === 'content') {
          throw invalidEvent(`配方 ${recipeKey} 的 track 必须为 null。`);
        }
        if (overrideRef !== null) {
          throw invalidEvent(`配方 ${recipeKey} 不得携带 overrideRef。`);
        }
      } else {
        // rebuild_missing_work: track = exact stored track or null, and never
        // an override ref (spec §10.3.1 policy table row).
        if (overrideRef !== null) {
          throw invalidEvent(`配方 ${recipeKey} 不得携带 overrideRef。`);
        }
      }
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        expectedLastSequence: assertNonNegativeInteger(candidate.expectedLastSequence, '事件 expectedLastSequence'),
        operationId: assertUuidV4(candidate.operationId, '事件 operationId'),
        operatorId: assertNonEmptyString(candidate.operatorId, '事件 operatorId'),
        reason: assertNonEmptyString(candidate.reason, '事件 reason'),
        recipeKey: recipeKey as RecoveryRecipeKeyV2,
        track,
        failureRecoveryPayloadRef: validateBlobRefV2(
          candidate.failureRecoveryPayloadRef,
          '事件 failureRecoveryPayloadRef',
        ),
        overrideRef,
      };
    }
    case 'structured_task_suspension_applied_v2':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        suspensionId: assertNonEmptyString(candidate.suspensionId, '事件 suspensionId'),
        reason: assertOneOf(candidate.reason, ['user_stop', 'operator_interrupt'], '事件 reason'),
        operationId: assertNonEmptyString(candidate.operationId, '事件 operationId'),
      };
    case 'structured_task_suspension_cleared_v2':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        suspensionId: assertNonEmptyString(candidate.suspensionId, '事件 suspensionId'),
        operationId: assertNonEmptyString(candidate.operationId, '事件 operationId'),
      };
    case 'structured_human_question_opened_v2':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        questionId: assertNonEmptyString(candidate.questionId, '事件 questionId'),
        questionVersion: assertUriSafeToken(candidate.questionVersion, '事件 questionVersion'),
        questionDigest: assertSha256(candidate.questionDigest, '事件 questionDigest'),
        originalWorkItemId: assertNonEmptyString(candidate.originalWorkItemId, '事件 originalWorkItemId'),
        attemptId: assertNonEmptyString(candidate.attemptId, '事件 attemptId'),
        leaseEpoch: assertPositiveInteger(candidate.leaseEpoch, '事件 leaseEpoch'),
        logicalAssignmentId: assertNonEmptyString(candidate.logicalAssignmentId, '事件 logicalAssignmentId'),
        authorityBaseRef: validateBlobRefV2(candidate.authorityBaseRef, '事件 authorityBaseRef'),
      };
    case 'structured_human_answer_delivered_v2':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        deliveryId: assertNonEmptyString(candidate.deliveryId, '事件 deliveryId'),
        questionId: assertNonEmptyString(candidate.questionId, '事件 questionId'),
        questionVersion: assertUriSafeToken(candidate.questionVersion, '事件 questionVersion'),
        originalWorkItemId: assertNonEmptyString(candidate.originalWorkItemId, '事件 originalWorkItemId'),
        replacementWorkItemId: assertNonEmptyString(candidate.replacementWorkItemId, '事件 replacementWorkItemId'),
        logicalAssignmentId: assertNonEmptyString(candidate.logicalAssignmentId, '事件 logicalAssignmentId'),
        answerDigest: assertSha256(candidate.answerDigest, '事件 answerDigest'),
        operationId: assertNonEmptyString(candidate.operationId, '事件 operationId'),
        authorityBaseRef: validateBlobRefV2(candidate.authorityBaseRef, '事件 authorityBaseRef'),
      };
    case 'artifact_published_v2':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        artifactId: assertNonEmptyString(candidate.artifactId, '事件 artifactId'),
        artifactVersion: assertPositiveInteger(candidate.artifactVersion, '事件 artifactVersion'),
        deliveryRef: validateBlobRefV2(candidate.deliveryRef, '事件 deliveryRef'),
        files: validateFileArray(candidate.files, '事件 files'),
        mediaType: assertOneOf(candidate.mediaType, BLOB_MEDIA_TYPES, '事件 mediaType'),
        provenance: validateSystemProvenance(candidate.provenance, '事件 provenance'),
      };
    case 'structured_system_artifact_delivery_created':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        deliveryId: assertNonEmptyString(candidate.deliveryId, '事件 deliveryId'),
        deliveryRef: validateBlobRefV2(candidate.deliveryRef, '事件 deliveryRef'),
        artifactId: assertNonEmptyString(candidate.artifactId, '事件 artifactId'),
        artifactRef: validateBlobRefV2(candidate.artifactRef, '事件 artifactRef'),
        sealRecordRef: validateBlobRefV2(candidate.sealRecordRef, '事件 sealRecordRef'),
        submitterWorkItemId: assertNonEmptyString(candidate.submitterWorkItemId, '事件 submitterWorkItemId'),
      };
    case 'structured_map_review_round_planned':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        mapReviewRoundId: assertNonEmptyString(candidate.mapReviewRoundId, '事件 mapReviewRoundId'),
        mapCycleOrdinal: assertPositiveInteger(candidate.mapCycleOrdinal, '事件 mapCycleOrdinal'),
        candidateId: assertNonEmptyString(candidate.candidateId, '事件 candidateId'),
        candidateRef: validateBlobRefV2(candidate.candidateRef, '事件 candidateRef'),
        contentRevisionManifestRef: validateNullableBlobRef(
          candidate.contentRevisionManifestRef,
          '事件 contentRevisionManifestRef',
        ),
        reviewPolicyDigest: assertSha256(candidate.reviewPolicyDigest, '事件 reviewPolicyDigest'),
        coverageNodeCount: assertNonNegativeInteger(candidate.coverageNodeCount, '事件 coverageNodeCount'),
        coverageRelationCount: assertNonNegativeInteger(
          candidate.coverageRelationCount,
          '事件 coverageRelationCount',
        ),
        assignmentCount: assertPositiveInteger(candidate.assignmentCount, '事件 assignmentCount'),
        consumedOverrideRef: validateNullableBlobRef(candidate.consumedOverrideRef, '事件 consumedOverrideRef'),
      };
    case 'structured_map_review_assignment_committed':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        assignmentId: assertNonEmptyString(candidate.assignmentId, '事件 assignmentId'),
        mapReviewRoundId: assertNonEmptyString(candidate.mapReviewRoundId, '事件 mapReviewRoundId'),
        workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
        attemptId: assertNonEmptyString(candidate.attemptId, '事件 attemptId'),
        reviewAssignmentId: nullableString(candidate.reviewAssignmentId, '事件 reviewAssignmentId'),
        source: assertOneOf(candidate.source, REVIEW_ASSIGNMENT_SOURCES, '事件 source'),
        ledgerRef: validateBlobRefV2(candidate.ledgerRef, '事件 ledgerRef'),
        coverageTargetCount: assertNonNegativeInteger(candidate.coverageTargetCount, '事件 coverageTargetCount'),
        findingCount: assertNonNegativeInteger(candidate.findingCount, '事件 findingCount'),
      };
    case 'structured_map_observation_recorded':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        observationId: assertNonEmptyString(candidate.observationId, '事件 observationId'),
        mapReviewRoundId: assertNonEmptyString(candidate.mapReviewRoundId, '事件 mapReviewRoundId'),
        ...observationLevel(candidate),
        observationRef: validateBlobRefV2(candidate.observationRef, '事件 observationRef'),
        coveredTargetCount: assertPositiveInteger(candidate.coveredTargetCount, '事件 coveredTargetCount'),
        childObservationRefs: validateBlobRefArray(candidate.childObservationRefs, '事件 childObservationRefs'),
      };
    case 'structured_map_review_round_completed':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        mapReviewRoundId: assertNonEmptyString(candidate.mapReviewRoundId, '事件 mapReviewRoundId'),
        coverageCoreRef: validateBlobRefV2(candidate.coverageCoreRef, '事件 coverageCoreRef'),
      };
    case 'structured_map_review_round_settled':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        mapReviewRoundId: assertNonEmptyString(candidate.mapReviewRoundId, '事件 mapReviewRoundId'),
        settlementCoreRef: validateBlobRefV2(candidate.settlementCoreRef, '事件 settlementCoreRef'),
        outcome: assertOneOf(candidate.outcome, ROUND_SETTLEMENT_OUTCOMES, '事件 outcome'),
      };
    case 'structured_map_activated': {
      const migrationSettlementCoreRef = validateNullableBlobRef(
        candidate.migrationSettlementCoreRef,
        '事件 migrationSettlementCoreRef',
      );
      const migrationActivationDecisionRef = validateNullableBlobRef(
        candidate.migrationActivationDecisionRef,
        '事件 migrationActivationDecisionRef',
      );
      if ((migrationSettlementCoreRef === null) !== (migrationActivationDecisionRef === null)) {
        throw invalidEvent('migration 引用必须成对出现或同时为空。');
      }
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        mapId: assertNonEmptyString(candidate.mapId, '事件 mapId'),
        mapRevision: assertPositiveInteger(candidate.mapRevision, '事件 mapRevision'),
        supersedesMapId: nullableString(candidate.supersedesMapId, '事件 supersedesMapId'),
        mapSnapshotRef: validateBlobRefV2(candidate.mapSnapshotRef, '事件 mapSnapshotRef'),
        mapReviewBundleRef: validateBlobRefV2(candidate.mapReviewBundleRef, '事件 mapReviewBundleRef'),
        mapSemanticDigest: assertSha256(candidate.mapSemanticDigest, '事件 mapSemanticDigest'),
        contentRevisionManifestRef: validateBlobRefV2(
          candidate.contentRevisionManifestRef,
          '事件 contentRevisionManifestRef',
        ),
        activationValidatorAggregateRef: validateBlobRefV2(
          candidate.activationValidatorAggregateRef,
          '事件 activationValidatorAggregateRef',
        ),
        migrationSettlementCoreRef,
        migrationActivationDecisionRef,
      };
    }
    case 'structured_content_revision_committed':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        contentRevisionManifestRef: validateBlobRefV2(
          candidate.contentRevisionManifestRef,
          '事件 contentRevisionManifestRef',
        ),
        taskContentRevision: assertPositiveInteger(candidate.taskContentRevision, '事件 taskContentRevision'),
        manifestPhase: assertOneOf(candidate.manifestPhase, MANIFEST_PHASES, '事件 manifestPhase'),
        producerPlanSpecRef: validateNullableBlobRef(candidate.producerPlanSpecRef, '事件 producerPlanSpecRef'),
        priorManifestRef: validateNullableBlobRef(candidate.priorManifestRef, '事件 priorManifestRef'),
      };
    case 'structured_review_round_planned':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        reviewRoundId: assertNonEmptyString(candidate.reviewRoundId, '事件 reviewRoundId'),
        contentCycleOrdinal: assertPositiveInteger(candidate.contentCycleOrdinal, '事件 contentCycleOrdinal'),
        mapRef: validateBlobRefV2(candidate.mapRef, '事件 mapRef'),
        mapSemanticDigest: assertSha256(candidate.mapSemanticDigest, '事件 mapSemanticDigest'),
        contentRevisionManifestRef: validateBlobRefV2(
          candidate.contentRevisionManifestRef,
          '事件 contentRevisionManifestRef',
        ),
        reviewPolicyDigest: assertSha256(candidate.reviewPolicyDigest, '事件 reviewPolicyDigest'),
        adoptionRootRef: validateBlobRefV2(candidate.adoptionRootRef, '事件 adoptionRootRef'),
        coverageSlotCount: assertNonNegativeInteger(candidate.coverageSlotCount, '事件 coverageSlotCount'),
        coverageRelationCount: assertNonNegativeInteger(
          candidate.coverageRelationCount,
          '事件 coverageRelationCount',
        ),
        assignmentCount: assertPositiveInteger(candidate.assignmentCount, '事件 assignmentCount'),
        verificationFindingCount: assertNonNegativeInteger(
          candidate.verificationFindingCount,
          '事件 verificationFindingCount',
        ),
        consumedOverrideRef: validateNullableBlobRef(candidate.consumedOverrideRef, '事件 consumedOverrideRef'),
      };
    case 'structured_review_assignment_started':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        assignmentId: assertNonEmptyString(candidate.assignmentId, '事件 assignmentId'),
        reviewRoundId: assertNonEmptyString(candidate.reviewRoundId, '事件 reviewRoundId'),
        workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
        attemptId: assertNonEmptyString(candidate.attemptId, '事件 attemptId'),
        reviewAssignmentId: nullableString(candidate.reviewAssignmentId, '事件 reviewAssignmentId'),
        source: assertOneOf(candidate.source, CONTENT_ASSIGNMENT_SOURCES, '事件 source'),
      };
    case 'structured_content_review_assignment_committed':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        assignmentId: assertNonEmptyString(candidate.assignmentId, '事件 assignmentId'),
        reviewRoundId: assertNonEmptyString(candidate.reviewRoundId, '事件 reviewRoundId'),
        workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
        attemptId: assertNonEmptyString(candidate.attemptId, '事件 attemptId'),
        reviewAssignmentId: nullableString(candidate.reviewAssignmentId, '事件 reviewAssignmentId'),
        source: assertOneOf(candidate.source, CONTENT_ASSIGNMENT_SOURCES, '事件 source'),
        ledgerRef: validateBlobRefV2(candidate.ledgerRef, '事件 ledgerRef'),
        coverageTargetCount: assertNonNegativeInteger(candidate.coverageTargetCount, '事件 coverageTargetCount'),
        findingCount: assertNonNegativeInteger(candidate.findingCount, '事件 findingCount'),
      };
    case 'structured_finding_opened': {
      const source = assertOneOf(candidate.source, FINDING_SOURCES, '事件 source');
      const openedBy = validateOpenedBy(candidate.openedBy, '事件 openedBy');
      // source ↔ openedBy correlation (design §17.4): reviewer findings bind a
      // reviewer attempt identity, system_validator findings a validator
      // execution identity; neither may impersonate the other.
      if (source === 'reviewer' && openedBy.kind !== 'reviewer') {
        throw invalidEvent('reviewer 来源的 Finding 必须绑定 reviewer attempt。');
      }
      if (source === 'system_validator' && openedBy.kind !== 'system_validator') {
        throw invalidEvent('system_validator 来源的 Finding 必须绑定 validator execution。');
      }
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        findingId: assertNonEmptyString(candidate.findingId, '事件 findingId'),
        findingRef: validateBlobRefV2(candidate.findingRef, '事件 findingRef'),
        reviewContext: validateReviewContext(candidate.reviewContext, '事件 reviewContext'),
        primaryLocation: validatePrimaryLocation(candidate.primaryLocation, '事件 primaryLocation'),
        defectClass: assertOneOf(candidate.defectClass, FINDING_DEFECT_CLASSES, '事件 defectClass'),
        severity: assertOneOf(candidate.severity, FINDING_SEVERITIES, '事件 severity'),
        source,
        openedBy,
      };
    }
    case 'structured_finding_verification_recorded':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        recordId: assertNonEmptyString(candidate.recordId, '事件 recordId'),
        recordRef: validateBlobRefV2(candidate.recordRef, '事件 recordRef'),
        findingId: assertNonEmptyString(candidate.findingId, '事件 findingId'),
        reviewContext: validateReviewContext(candidate.reviewContext, '事件 reviewContext'),
        assignmentId: assertNonEmptyString(candidate.assignmentId, '事件 assignmentId'),
        repairStage: assertOneOf(candidate.repairStage, REPAIR_STAGES, '事件 repairStage'),
        verdict: assertOneOf(candidate.verdict, VERIFICATION_VERDICTS, '事件 verdict'),
      };
    case 'structured_validator_finding_verification_recorded':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        recordId: assertNonEmptyString(candidate.recordId, '事件 recordId'),
        recordRef: validateBlobRefV2(candidate.recordRef, '事件 recordRef'),
        findingId: assertNonEmptyString(candidate.findingId, '事件 findingId'),
        reviewContext: validateReviewContext(candidate.reviewContext, '事件 reviewContext'),
        repairStage: assertOneOf(candidate.repairStage, REPAIR_STAGES, '事件 repairStage'),
        verdict: assertOneOf(candidate.verdict, VERIFICATION_VERDICTS, '事件 verdict'),
        validatorExecutionId: assertNonEmptyString(candidate.validatorExecutionId, '事件 validatorExecutionId'),
        validatorAggregateRef: validateBlobRefV2(candidate.validatorAggregateRef, '事件 validatorAggregateRef'),
        validationReceiptRef: validateNullableBlobRef(candidate.validationReceiptRef, '事件 validationReceiptRef'),
      };
    case 'structured_review_assignment_completed':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        assignmentId: assertNonEmptyString(candidate.assignmentId, '事件 assignmentId'),
        reviewRoundId: assertNonEmptyString(candidate.reviewRoundId, '事件 reviewRoundId'),
        workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
        attemptId: assertNonEmptyString(candidate.attemptId, '事件 attemptId'),
        ledgerRef: validateBlobRefV2(candidate.ledgerRef, '事件 ledgerRef'),
        source: assertOneOf(candidate.source, CONTENT_ASSIGNMENT_SOURCES, '事件 source'),
      };
    case 'structured_whole_tree_observation_recorded':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        observationId: assertNonEmptyString(candidate.observationId, '事件 observationId'),
        reviewRoundId: assertNonEmptyString(candidate.reviewRoundId, '事件 reviewRoundId'),
        ...observationLevel(candidate),
        observationRef: validateBlobRefV2(candidate.observationRef, '事件 observationRef'),
        coveredTargetCount: assertPositiveInteger(candidate.coveredTargetCount, '事件 coveredTargetCount'),
        childObservationRefs: validateBlobRefArray(candidate.childObservationRefs, '事件 childObservationRefs'),
      };
    case 'structured_review_round_completed':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        reviewRoundId: assertNonEmptyString(candidate.reviewRoundId, '事件 reviewRoundId'),
        coverageCoreRef: validateBlobRefV2(candidate.coverageCoreRef, '事件 coverageCoreRef'),
      };
    case 'structured_review_round_settled':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        reviewRoundId: assertNonEmptyString(candidate.reviewRoundId, '事件 reviewRoundId'),
        settlementCoreRef: validateBlobRefV2(candidate.settlementCoreRef, '事件 settlementCoreRef'),
        outcome: assertOneOf(candidate.outcome, CONTENT_ROUND_SETTLEMENT_OUTCOMES, '事件 outcome'),
      };
    case 'structured_repair_scope_requested': {
      const track = assertOneOf(candidate.track, REPAIR_TRACKS, '事件 track') as 'map' | 'content';
      const requestedNodeIds = validateStringArray(candidate.requestedNodeIds, '事件 requestedNodeIds');
      const requestedRelationIds = validateStringArray(
        candidate.requestedRelationIds,
        '事件 requestedRelationIds',
      );
      const requestedSlotIds = validateStringArray(candidate.requestedSlotIds, '事件 requestedSlotIds');
      const findingIds = validateNonEmptyStringArray(candidate.findingIds, '事件 findingIds');
      if (track === 'map') {
        if (
          requestedSlotIds.length !== 0 ||
          (requestedNodeIds.length === 0 && requestedRelationIds.length === 0)
        ) {
          throw invalidEvent('map 扩展请求必须且只能声明节点/关系范围。');
        }
      } else if (requestedNodeIds.length !== 0 || requestedRelationIds.length !== 0 || requestedSlotIds.length === 0) {
        throw invalidEvent('content 扩展请求必须且只能声明槽位范围。');
      }
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        requestId: assertNonEmptyString(candidate.requestId, '事件 requestId'),
        repairPlanId: assertNonEmptyString(candidate.repairPlanId, '事件 repairPlanId'),
        planRevisionId: assertNonEmptyString(candidate.planRevisionId, '事件 planRevisionId'),
        track,
        findingIds,
        requestedNodeIds,
        requestedRelationIds,
        requestedSlotIds,
        reason: assertNonEmptyString(candidate.reason, '事件 reason'),
      };
    }
    case 'structured_repair_scope_expansion_approved_v2':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        requestId: assertNonEmptyString(candidate.requestId, '事件 requestId'),
        repairPlanId: assertNonEmptyString(candidate.repairPlanId, '事件 repairPlanId'),
        supersededPlanRevisionId: assertNonEmptyString(
          candidate.supersededPlanRevisionId,
          '事件 supersededPlanRevisionId',
        ),
        successorPlanRevisionId: assertNonEmptyString(
          candidate.successorPlanRevisionId,
          '事件 successorPlanRevisionId',
        ),
        successorPlanSpecRef: validateBlobRefV2(candidate.successorPlanSpecRef, '事件 successorPlanSpecRef'),
      };
    case 'structured_repair_scope_expansion_rejected_v2':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        requestId: assertNonEmptyString(candidate.requestId, '事件 requestId'),
        repairPlanId: assertNonEmptyString(candidate.repairPlanId, '事件 repairPlanId'),
        planRevisionId: assertNonEmptyString(candidate.planRevisionId, '事件 planRevisionId'),
        reason: assertNonEmptyString(candidate.reason, '事件 reason'),
      };
    case 'structured_repair_grant_issued':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        grantSpecRef: validateBlobRefV2(candidate.grantSpecRef, '事件 grantSpecRef'),
        grantSpecId: assertNonEmptyString(candidate.grantSpecId, '事件 grantSpecId'),
        workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
        grantKind: assertOneOf(candidate.grantKind, GRANT_KINDS, '事件 grantKind'),
      };
    case 'structured_repair_committed':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        repairPlanId: assertNonEmptyString(candidate.repairPlanId, '事件 repairPlanId'),
        planRevisionId: assertNonEmptyString(candidate.planRevisionId, '事件 planRevisionId'),
        batchOrdinal: assertPositiveInteger(candidate.batchOrdinal, '事件 batchOrdinal'),
        workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
        attemptId: assertNonEmptyString(candidate.attemptId, '事件 attemptId'),
        stagingRootRef: validateBlobRefV2(candidate.stagingRootRef, '事件 stagingRootRef'),
      };
    case 'structured_finding_addressed':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        findingId: assertNonEmptyString(candidate.findingId, '事件 findingId'),
        repairStage: assertOneOf(candidate.repairStage, REPAIR_STAGES, '事件 repairStage'),
        repairPlanId: assertNonEmptyString(candidate.repairPlanId, '事件 repairPlanId'),
      };
    case 'structured_finding_verified_closed':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        findingId: assertNonEmptyString(candidate.findingId, '事件 findingId'),
      };
    case 'structured_scaffold_sealed_v2':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        sealWorkItemId: assertNonEmptyString(candidate.sealWorkItemId, '事件 sealWorkItemId'),
        sealRecordRef: validateBlobRefV2(candidate.sealRecordRef, '事件 sealRecordRef'),
        sealValidationBundleRef: validateBlobRefV2(
          candidate.sealValidationBundleRef,
          '事件 sealValidationBundleRef',
        ),
        mapRef: validateBlobRefV2(candidate.mapRef, '事件 mapRef'),
        contentRevisionManifestRef: validateBlobRefV2(
          candidate.contentRevisionManifestRef,
          '事件 contentRevisionManifestRef',
        ),
        reviewBundleRef: validateBlobRefV2(candidate.reviewBundleRef, '事件 reviewBundleRef'),
        artifactRef: validateBlobRefV2(candidate.artifactRef, '事件 artifactRef'),
      };
    case 'structured_round_budget_override_transferred_v2':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        overrideRef: validateBlobRefV2(candidate.overrideRef, '事件 overrideRef'),
        fromRepairPlanRef: validateBlobRefV2(candidate.fromRepairPlanRef, '事件 fromRepairPlanRef'),
        toRepairPlanRef: validateBlobRefV2(candidate.toRepairPlanRef, '事件 toRepairPlanRef'),
        transferOperationId: assertNonEmptyString(candidate.transferOperationId, '事件 transferOperationId'),
      };
    default:
      throw invalidEvent(`未知事件类型 ${type}。`);
  }
}

function roleBindingOf(candidate: Record<string, unknown>): string | null {
  return nullableString(candidate.roleBinding, '事件 roleBinding');
}

function genericIdentity(candidate: Record<string, unknown>): {
  attemptId: string;
  workItemId: string;
  agentId: string;
  logicalAssignmentId: string;
  leaseEpoch: number;
  inputArtifactDeliveryId: string;
  authorityBaseRef: BlobRefV2;
} {
  return {
    attemptId: assertNonEmptyString(candidate.attemptId, '事件 attemptId'),
    workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
    agentId: assertNonEmptyString(candidate.agentId, '事件 agentId'),
    logicalAssignmentId: assertNonEmptyString(candidate.logicalAssignmentId, '事件 logicalAssignmentId'),
    leaseEpoch: assertPositiveInteger(candidate.leaseEpoch, '事件 leaseEpoch'),
    inputArtifactDeliveryId: assertNonEmptyString(
      candidate.inputArtifactDeliveryId,
      '事件 inputArtifactDeliveryId',
    ),
    authorityBaseRef: validateBlobRefV2(candidate.authorityBaseRef, '事件 authorityBaseRef'),
  };
}

function systemCommandBase(candidate: Record<string, unknown>): {
  commandId: string;
  workItemId: string;
  commandKind: 'map_finalize' | 'generation_finalize' | 'repair_finalize' | 'migration_validation_batch' | 'review_settlement' | 'seal';
  leaseEpoch: number;
  authorityBaseRef: BlobRefV2;
} {
  return {
    commandId: assertNonEmptyString(candidate.commandId, '事件 commandId'),
    workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
    commandKind: assertOneOf(candidate.commandKind, SYSTEM_COMMAND_KINDS, '事件 commandKind'),
    leaseEpoch: assertPositiveInteger(candidate.leaseEpoch, '事件 leaseEpoch'),
    authorityBaseRef: validateBlobRefV2(candidate.authorityBaseRef, '事件 authorityBaseRef'),
  };
}

/** Shared plan identity for the four rejected-plan events. */
function planIdentity(
  candidate: Record<string, unknown>,
  type: string,
): Record<string, string> {
  switch (type) {
    case 'structured_map_build_rejected':
      return { mapBuildId: assertNonEmptyString(candidate.mapBuildId, '事件 mapBuildId') };
    case 'structured_generation_plan_rejected':
      return { generationPlanId: assertNonEmptyString(candidate.generationPlanId, '事件 generationPlanId') };
    case 'structured_map_repair_plan_rejected':
    case 'structured_content_repair_plan_rejected':
      return {
        repairPlanId: assertNonEmptyString(candidate.repairPlanId, '事件 repairPlanId'),
        planRevisionId: assertNonEmptyString(candidate.planRevisionId, '事件 planRevisionId'),
      };
    default:
      throw invalidEvent(`未知事件类型 ${type}。`);
  }
}

function workItemTerminalTransition(
  candidate: Record<string, unknown>,
  id: string,
  at: string,
  type:
    | 'structured_work_item_completed'
    | 'structured_work_item_requeued'
    | 'structured_work_item_resumed'
    | 'structured_task_retry_resumed_v2',
): AuthoritativeReviewEventV2 {
  const base = {
    protocolVersion: 2 as const,
    id,
    at,
    workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
    leaseEpoch: assertPositiveInteger(candidate.leaseEpoch, '事件 leaseEpoch'),
    authorityBaseRef: validateBlobRefV2(candidate.authorityBaseRef, '事件 authorityBaseRef'),
  };
  switch (type) {
    case 'structured_work_item_completed':
      return { ...base, type };
    case 'structured_work_item_requeued':
    case 'structured_work_item_resumed':
    case 'structured_task_retry_resumed_v2':
      return {
        ...base,
        type,
        expectedLastSequence: assertNonNegativeInteger(
          candidate.expectedLastSequence,
          '事件 expectedLastSequence',
        ),
      };
  }
}

function workItemStateEvent(
  candidate: Record<string, unknown>,
  id: string,
  at: string,
  type: 'structured_work_item_lease_reclaimed' | 'structured_work_item_superseded',
): AuthoritativeReviewEventV2 {
  const base = {
    protocolVersion: 2 as const,
    id,
    at,
    workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
    leaseEpoch: assertPositiveInteger(candidate.leaseEpoch, '事件 leaseEpoch'),
    authorityBaseRef: validateBlobRefV2(candidate.authorityBaseRef, '事件 authorityBaseRef'),
  };
  switch (type) {
    case 'structured_work_item_lease_reclaimed':
      return {
        ...base,
        type,
        reason: assertOneOf(candidate.reason, RECLAIM_REASONS, '事件 reason'),
      };
    case 'structured_work_item_superseded':
      return {
        ...base,
        type,
        reason: assertOneOf(candidate.reason, SUPERSEDE_REASONS, '事件 reason'),
      };
  }
}

function genericAttemptNext(
  candidate: Record<string, unknown>,
  id: string,
  at: string,
  type:
    | 'structured_generic_agent_attempt_started'
    | 'structured_generic_agent_attempt_completed'
    | 'structured_generic_agent_attempt_abandoned',
): AuthoritativeReviewEventV2 {
  const base = {
    protocolVersion: 2 as const,
    id,
    at,
    attemptId: assertNonEmptyString(candidate.attemptId, '事件 attemptId'),
    workItemId: assertNonEmptyString(candidate.workItemId, '事件 workItemId'),
    agentId: assertNonEmptyString(candidate.agentId, '事件 agentId'),
    logicalAssignmentId: assertNonEmptyString(candidate.logicalAssignmentId, '事件 logicalAssignmentId'),
    leaseEpoch: assertPositiveInteger(candidate.leaseEpoch, '事件 leaseEpoch'),
    inputArtifactDeliveryId: assertNonEmptyString(
      candidate.inputArtifactDeliveryId,
      '事件 inputArtifactDeliveryId',
    ),
    authorityBaseRef: validateBlobRefV2(candidate.authorityBaseRef, '事件 authorityBaseRef'),
  };
  switch (type) {
    case 'structured_generic_agent_attempt_started':
    case 'structured_generic_agent_attempt_completed':
      return { ...base, type };
    case 'structured_generic_agent_attempt_abandoned':
      return { ...base, type, reason: assertOneOf(candidate.reason, RECLAIM_REASONS, '事件 reason') };
  }
}

function systemCommandNext(
  candidate: Record<string, unknown>,
  id: string,
  at: string,
  type:
    | 'structured_system_command_started'
    | 'structured_system_command_completed'
    | 'structured_system_command_abandoned',
): AuthoritativeReviewEventV2 {
  const base = {
    protocolVersion: 2 as const,
    id,
    at,
    ...systemCommandBase(candidate),
  };
  switch (type) {
    case 'structured_system_command_started':
    case 'structured_system_command_completed':
      return { ...base, type };
    case 'structured_system_command_abandoned':
      return { ...base, type, reason: assertOneOf(candidate.reason, RECLAIM_REASONS, '事件 reason') };
  }
}

function planRejected(
  candidate: Record<string, unknown>,
  id: string,
  at: string,
  type:
    | 'structured_map_build_rejected'
    | 'structured_generation_plan_rejected'
    | 'structured_map_repair_plan_rejected'
    | 'structured_content_repair_plan_rejected',
): AuthoritativeReviewEventV2 {
  const refs = {
    validatorAggregateRef: validateBlobRefV2(candidate.validatorAggregateRef, '事件 validatorAggregateRef'),
    validationReceiptRef: validateBlobRefV2(candidate.validationReceiptRef, '事件 validationReceiptRef'),
  };
  switch (type) {
    case 'structured_map_build_rejected':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        mapBuildId: assertNonEmptyString(candidate.mapBuildId, '事件 mapBuildId'),
        ...refs,
      };
    case 'structured_generation_plan_rejected':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        generationPlanId: assertNonEmptyString(candidate.generationPlanId, '事件 generationPlanId'),
        ...refs,
      };
    case 'structured_map_repair_plan_rejected':
    case 'structured_content_repair_plan_rejected':
      return {
        protocolVersion: 2,
        id,
        at,
        type,
        repairPlanId: assertNonEmptyString(candidate.repairPlanId, '事件 repairPlanId'),
        planRevisionId: assertNonEmptyString(candidate.planRevisionId, '事件 planRevisionId'),
        ...refs,
      };
  }
}

/** Shared layered-observation level rule (design §17.4): root = level 1, no parent. */
function observationLevel(
  candidate: Record<string, unknown>,
): { level: number; parentObservationId: string | null } {
  const level = assertPositiveInteger(candidate.level, '事件 level');
  const parentObservationId = nullableString(candidate.parentObservationId, '事件 parentObservationId');
  if (level === 1 && parentObservationId !== null) {
    throw invalidEvent('根级观察不得携带 parentObservationId。');
  }
  if (level > 1 && parentObservationId === null) {
    throw invalidEvent('非根级观察必须携带 parentObservationId。');
  }
  return { level, parentObservationId };
}

function validateFileArray(value: unknown, where: string): { name: string; hash: string }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidEvent(`${where} 必须是非空数组。`);
  }
  return value.map((entry, index) => validateFile(entry, `${where}[${index}]`));
}
