import type { PublicCoreError } from '../../shared/errors';

/**
 * Public error codes shared by every Gateway implementation and consumed by
 * pages. Codes are stable identifiers; messages stay presentable and free of
 * stack traces, causes or credential-adjacent details (iron rule 6).
 */
export const CORE_ERROR_CODES = {
  TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_CORRUPTED: 'TASK_CORRUPTED',
  TASK_ALREADY_RUNNING: 'TASK_ALREADY_RUNNING',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_SCENARIO: 'INVALID_SCENARIO',
  GATEWAY_NOT_CONFIGURED: 'GATEWAY_NOT_CONFIGURED',
  TRACE_NOT_FOUND: 'TRACE_NOT_FOUND',
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
} as const;

export type CoreErrorCode = (typeof CORE_ERROR_CODES)[keyof typeof CORE_ERROR_CODES];

/** Error type satisfying the public page-facing error contract. */
export class CoreError extends Error implements PublicCoreError {
  readonly code: string;
  readonly location: string | null;
  readonly action: string | null;

  constructor(
    code: CoreErrorCode,
    message: string,
    location: string | null = null,
    action: string | null = null,
  ) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.location = location;
    this.action = action;
  }
}
