/**
 * Task 12 SystemCommand registry (design §17.2, spec §9.2/§10.2): the six
 * closed system command kinds with typed handler interfaces and explicit
 * `NOT_IMPLEMENTED` retryable test doubles. The attempt-coordinator resolves a
 * leased SystemCommand workitem's commandKind against this allowlist and runs
 * exactly one handler per command — never guessed from the role name or work
 * item kind.
 *
 * System handlers CANNOT access an Agent prompt, Agent tools or open a human
 * question (design §17.2: "SystemCommandAttempt 不允许打开 StructuredHumanQuestion",
 * spec §10.6: "SystemCommands cannot ask humans"). The context therefore
 * carries ONLY the command identity + authority base + the system payload ref;
 * there is no prompt/tool surface and no question capability.
 *
 * Fail-closed rules:
 * - an unknown commandKind resolves null and the attempt-coordinator rejects
 *   the command (INVALID_INPUT) — a registry can never silently run the wrong
 *   handler;
 * - the six built-in doubles return `retryable_failure(NOT_IMPLEMENTED)`, so a
 *   leased command without a real domain handler parks in the retryable-failure
 *   state (durable `retry_due` wakeup) instead of corrupting or completing with
 *   fabricated results. Tasks 15/16/17/19/20/21 replace each double with the
 *   real domain handler (map_finalize -> map-build-service, …).
 */
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { SystemCommandKindV2 } from './work-item-coordinator';

/** The frozen six closed system command kinds (design §17.2, spec §10.2). */
export const SYSTEM_COMMAND_KINDS: readonly SystemCommandKindV2[] = [
  'map_finalize',
  'generation_finalize',
  'repair_finalize',
  'migration_validation_batch',
  'review_settlement',
  'seal',
] as const;

/** Stable failure code of the built-in NOT_IMPLEMENTED doubles. */
export const SYSTEM_COMMAND_NOT_IMPLEMENTED_CODE = 'NOT_IMPLEMENTED';

/** The bounded context one SystemCommand handler receives (no Agent surface). */
export interface SystemCommandContext {
  taskId: string;
  commandId: string;
  workItemId: string;
  commandKind: SystemCommandKindV2;
  leaseEpoch: number;
  authorityBaseRef: BlobRefV2;
  /** The workitem payload (system payload blob) the handler may resolve. */
  payloadRef: BlobRefV2;
}

/** The closed outcome of one SystemCommand execution. */
export type SystemCommandOutcome =
  | { kind: 'completed'; resultRefs: readonly BlobRefV2[] }
  | {
      kind: 'retryable_failure';
      failureCode: string;
      failureDigest: string;
      /** Validator infrastructure custody. The retry event roots the aggregate
       * and its transitive receipts/failures so GC cannot orphan evidence. */
      validatorAggregateRef?: BlobRefV2 | null;
      /** Server-computed retryNotBefore override (default clock()). */
      retryNotBefore?: string;
    }
  | {
      kind: 'terminal_failure';
      failureCode: string;
      failureDigest: string;
      validatorAggregateRef?: BlobRefV2 | null;
      /** True emits `structured_task_failed_v2` with the same batch (§10.3). */
      taskFailure: boolean;
    };

/** One typed handler bound to exactly one commandKind. */
export interface SystemCommandHandler {
  readonly commandKind: SystemCommandKindV2;
  execute(ctx: SystemCommandContext): Promise<SystemCommandOutcome>;
}

/** Deterministic NOT_IMPLEMENTED failure digest (replay byte-identity). */
export function notImplementedFailureDigest(ctx: SystemCommandContext): string {
  return canonicalJsonSha256({
    commandKind: ctx.commandKind,
    workItemId: ctx.workItemId,
    code: SYSTEM_COMMAND_NOT_IMPLEMENTED_CODE,
  });
}

/** The explicit retryable NOT_IMPLEMENTED double for one command kind. */
export function notImplementedSystemCommandHandler(commandKind: SystemCommandKindV2): SystemCommandHandler {
  return {
    commandKind,
    async execute(ctx) {
      return {
        kind: 'retryable_failure',
        failureCode: SYSTEM_COMMAND_NOT_IMPLEMENTED_CODE,
        failureDigest: notImplementedFailureDigest(ctx),
      };
    },
  };
}

/** The default allowlist: six typed handlers, all NOT_IMPLEMENTED doubles. */
export function createDefaultSystemCommandHandlers(): SystemCommandHandler[] {
  return SYSTEM_COMMAND_KINDS.map(notImplementedSystemCommandHandler);
}

/**
 * The closed registry. `resolve` returns null for an unknown commandKind so
 * the coordinator rejects it (fail-closed); registering a duplicate kind is a
 * program error.
 */
export class SystemCommandRegistry {
  private readonly handlers = new Map<string, SystemCommandHandler>();

  constructor(handlers: readonly SystemCommandHandler[] = createDefaultSystemCommandHandlers()) {
    for (const handler of handlers) {
      this.register(handler);
    }
  }

  register(handler: SystemCommandHandler): void {
    if (this.handlers.has(handler.commandKind)) {
      throw new Error(`SystemCommand handler '${handler.commandKind}' is already registered`);
    }
    this.handlers.set(handler.commandKind, handler);
  }

  /**
   * Task 12 seam: REPLACES an existing registration with a real domain handler
   * (Tasks 15/16/17/19/20/21 swap out the NOT_IMPLEMENTED doubles). Unknown
   * kinds must use `register`; replacing an unknown kind is a program error so
   * the closed six-kind allowlist never silently grows.
   */
  replace(handler: SystemCommandHandler): void {
    if (!this.handlers.has(handler.commandKind)) {
      throw new Error(`SystemCommand handler '${handler.commandKind}' is not registered; use register for a new kind`);
    }
    this.handlers.set(handler.commandKind, handler);
  }

  resolve(commandKind: string): SystemCommandHandler | null {
    return this.handlers.get(commandKind) ?? null;
  }
}
