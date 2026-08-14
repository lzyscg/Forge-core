/**
 * 面向页面的统一错误契约：只暴露可展示、可定位、可操作的字段。
 * 原始 cause / 堆栈 / 凭据相关信息不得经由此契约进入页面状态（铁律 6）。
 */
export interface PublicCoreError {
  code: string;
  message: string;
  location: string | null;
  action: string | null;
}

/**
 * Stable public error codes shared across lifecycle surfaces (plan
 * 2026-08-04). `TASK_CONTRACT_INCOMPATIBLE` rejects start/resume/retry of a
 * historical frozen task whose snapshot lacks a supported turn contract —
 * the task stays readable and cloneable only (spec §7.3).
 */
export const TASK_ERROR_CODES = {
  TASK_CONTRACT_INCOMPATIBLE: 'TASK_CONTRACT_INCOMPATIBLE',
} as const;

/** Presentable Chinese message for the incompatibility gate (iron rule 6). */
export const TASK_CONTRACT_INCOMPATIBLE_MESSAGE =
  '该任务冻结于旧版模板契约，无法继续运行，请使用当前模板克隆重建。';

/** Actionable hint paired with the incompatibility gate message. */
export const TASK_CONTRACT_INCOMPATIBLE_ACTION = '查看任务后使用“用当前模板重跑”重建任务。';

/**
 * Stable public v2 error codes of the authoritative per-slot review lifecycle
 * (spec 2026-08-14 §14.3). The base-stale family, TASK_WRITE_LEASE_CONFLICT
 * and idempotency conflicts are the "exact invalid-transition/idempotency
 * conflicts" the spec names; OPERATION-level conflicts keep the existing
 * EVENT_ID_CONFLICT / INVALID_TRANSITION codes, and task corruption keeps
 * TASK_CORRUPTED. Public errors never contain absolute paths, validator
 * internals, provider output, private evidence or raw storage exceptions —
 * unknown internal causes map to the bounded INTERNAL_ERROR envelope instead.
 */
export const AUTHORITATIVE_REVIEW_V2_ERROR_CODES = {
  /** Capability/profile gate rejects creating/starting/leasing a v2 task. */
  AUTHORITATIVE_REVIEW_UNAVAILABLE: 'AUTHORITATIVE_REVIEW_UNAVAILABLE',
  /** `start` is one-shot for v2; stopped/interrupted tasks resume instead. */
  USE_RESUME: 'USE_RESUME',
  /** Expected event tail / authority base no longer matches (tail CAS). */
  AUTHORITY_BASE_STALE: 'AUTHORITY_BASE_STALE',
  MAP_CANDIDATE_BASE_STALE: 'MAP_CANDIDATE_BASE_STALE',
  REVIEW_BASE_STALE: 'REVIEW_BASE_STALE',
  MAP_BASE_STALE: 'MAP_BASE_STALE',
  CONTENT_BASE_STALE: 'CONTENT_BASE_STALE',
  /** A non-current task writer (lease epoch/base mismatch) attempted a write. */
  TASK_WRITE_LEASE_CONFLICT: 'TASK_WRITE_LEASE_CONFLICT',
  /** Answered question version is consumed/replaced; the token is stale. */
  HUMAN_QUESTION_STALE: 'HUMAN_QUESTION_STALE',
  /** Snapshot cursor retired, re-based or torn — resurface and start over. */
  CURSOR_STALE: 'CURSOR_STALE',
  /** Seal-output validation failed terminally; only reopen_failed may retry. */
  ARTIFACT_VALIDATION_FAILED: 'ARTIFACT_VALIDATION_FAILED',
  /** Hard per-track review/repair round budget exceeded (spec §13.3.1). */
  REVIEW_REPAIR_LIMIT_EXCEEDED: 'REVIEW_REPAIR_LIMIT_EXCEEDED',
  /** Running task with no non-terminal WorkItem (startup recovery). */
  RUNNING_WITHOUT_WORK: 'RUNNING_WITHOUT_WORK',
  /** Fenced delete tombstone rejects every v2 append/claim/read for the id. */
  TASK_DELETED: 'TASK_DELETED',
} as const;

export type AuthoritativeReviewV2ErrorCode =
  (typeof AUTHORITATIVE_REVIEW_V2_ERROR_CODES)[keyof typeof AUTHORITATIVE_REVIEW_V2_ERROR_CODES];

/**
 * Exact HTTP mapping of every public v2 error code (spec §14.3). Stale/conflict
 * codes are 409 (the request targets an outdated but legal resource),
 * terminal domain failures and corruption are 422, capability gates are 503,
 * and a fenced deleted task is 410 Gone. The router's STATUS_BY_CODE table
 * gains these entries when the v2 endpoints that can throw them land.
 */
export const AUTHORITATIVE_REVIEW_V2_ERROR_STATUS: Readonly<
  Record<AuthoritativeReviewV2ErrorCode, number>
> = {
  AUTHORITATIVE_REVIEW_UNAVAILABLE: 503,
  USE_RESUME: 409,
  AUTHORITY_BASE_STALE: 409,
  MAP_CANDIDATE_BASE_STALE: 409,
  REVIEW_BASE_STALE: 409,
  MAP_BASE_STALE: 409,
  CONTENT_BASE_STALE: 409,
  TASK_WRITE_LEASE_CONFLICT: 409,
  HUMAN_QUESTION_STALE: 409,
  CURSOR_STALE: 409,
  ARTIFACT_VALIDATION_FAILED: 422,
  REVIEW_REPAIR_LIMIT_EXCEEDED: 422,
  RUNNING_WITHOUT_WORK: 422,
  TASK_DELETED: 410,
};
