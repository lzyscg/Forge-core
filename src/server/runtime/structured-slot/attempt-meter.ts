/**
 * Persistent Attempt resource meter (Task 11) — spec §5, design §7.6 + N04.
 *
 * The meter pins the pre-validation semantics of the Slot Tool ingress:
 *
 * - The metering unit is `(toolCallId, canonicalArgsHash)`. Only an EXACT
 *   call whose cached result was recorded is free; everything else counts —
 *   a re-precharge without a recorded result, the same toolCallId with
 *   changed args, schema-invalid / unauthorized / truncated calls, and a
 *   different toolCallId. Reaching exactly the per-attempt max is legal; the
 *   next call that would exceed closes the Attempt.
 * - Validation runs and validator aggregates (invocations / CPU / wall /
 *   output) are accounted against `limits.attempt` via `reserveValidation`
 *   (non-mutating preflight) and `recordValidationUsage` (mutating commit).
 * - `signal` is one composite AbortController combining the attempt
 *   deadline/resource closure with the scheduler stop signal. A terminal
 *   state makes every subsequent charge return the SAME terminal failure
 *   (RESOURCE_LIMIT_EXCEEDED + stable cause); a scheduler stop aborts the
 *   composite without minting a resource terminal (the stop path is the
 *   coordinator's `abandoned/task_stop`).
 * - The deadline is a MONOTONIC timer started when the attempt's
 *   `structured_slot_attempt_started` batch becomes visible, covering
 *   provider / Slot Tool / validator / Assembler / dispatch. Compaction,
 *   provider session continuation, corrected prompts and replays NEVER reset
 *   the meter: every charge and the cumulative usage are persisted to the
 *   Task 7 Attempt store (`attempts/<turnId>/meter.json`), and a re-created
 *   meter over the same turn continues from that snapshot.
 *
 * When a deadline or limit triggers, the meter aborts the composite signal
 * and surfaces the terminal failure; committing the
 * `failed/runtime_failure` terminal batch is the coordinator/committer's
 * concern (Task 15/17). No business vocabulary lives here (iron rule 1).
 */
import { performance } from 'node:perf_hooks';
import type { JsonObject, JsonValue, StructuredSlotLimitsV1 } from '../../../shared/structured-slots';
import type { StructuredSlotPrivateStore } from '../../storage/structured-slot-private-store';

/** The agent failure code the meter mints on every resource closure. */
export const RESOURCE_LIMIT_EXCEEDED = 'RESOURCE_LIMIT_EXCEEDED' as const;

export type AttemptMeterCause =
  | 'deadline'
  | 'slot_tool_limit'
  | 'validation_limit'
  | 'validator_invocations'
  | 'validator_cpu'
  | 'validator_wall'
  | 'validator_output';

/** The stable terminal failure returned by a closed meter. */
export interface AttemptTerminalFailure {
  code: typeof RESOURCE_LIMIT_EXCEEDED;
  cause: AttemptMeterCause;
  message: string;
}

/** Stable meter error codes (fail closed on a malformed persisted snapshot). */
export const METER_ERROR_CODES = {
  METER_SNAPSHOT_INVALID: 'METER_SNAPSHOT_INVALID',
} as const;

export class MeterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'MeterError';
    this.code = code;
  }
}

/** One persisted tool signature/result record (spec §5 meter unit). */
export interface AttemptToolCallRecord {
  toolCallId: string;
  canonicalArgsHash: string;
  toolName: string;
  /** Recorded cached result; null until recordToolResult runs. */
  result: JsonValue | null;
}

/** Cumulative attempt usage persisted to the Task 7 Attempt store. */
export interface AttemptMeterUsage {
  slotToolCalls: number;
  validationRuns: number;
  validatorInvocations: number;
  validatorCpuMs: number;
  validatorWallClockMs: number;
  validatorOutputBytes: number;
}

/** Declared/actual validator aggregate for one validation run. */
export interface ValidationUsageInput {
  invocations: number;
  cpuMs: number;
  wallMs: number;
  outputBytes: number;
}

export type AttemptChargeResult =
  | { status: 'ok'; replayed: boolean }
  | { status: 'closed'; failure: AttemptTerminalFailure };

/**
 * The full precharge outcome the tool path understands (Task 14):
 * `prechargeRawTool` itself only returns ok/closed; the raw pre-validation
 * seam and the consume-only tool adapter additionally distinguish an external
 * scheduler-stop abort (no terminal minted) from a meter-bypass (no raw
 * precharge was ever persisted for the key).
 */
export type AttemptPrechargeResult =
  | { status: 'ok'; replayed: boolean }
  | { status: 'closed'; failure: AttemptTerminalFailure }
  | { status: 'aborted' }
  | { status: 'not_precharged' };

/** One Slot Tool invocation identity (the metering unit; spec §5). */
export interface SlotToolCallContext {
  toolCallId: string;
  canonicalArgsHash: string;
  toolName: string;
}

/** The minimal Task 7 Attempt-store surface the meter persists through. */
export type AttemptMeterStore = Pick<
  StructuredSlotPrivateStore,
  'readAttemptMeter' | 'writeAttemptMeter'
>;

export interface AttemptMeterOptions {
  turnId: string;
  privateStore: AttemptMeterStore;
  limits: StructuredSlotLimitsV1;
  /** Monotonic clock in ms; defaults to performance.now() (never wall time). */
  monotonicNow?: () => number;
  /** Timer handles; injectable for deterministic deadline tests. */
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Scheduler stop signal combined into the composite. */
  schedulerSignal?: AbortSignal;
}

interface AttemptMeterSnapshotV1 {
  version: 1;
  turnId: string;
  startedAtMs: number;
  toolCalls: AttemptToolCallRecord[];
  usage: AttemptMeterUsage;
  terminal: AttemptTerminalFailure | null;
}

const emptyUsage = (): AttemptMeterUsage => ({
  slotToolCalls: 0,
  validationRuns: 0,
  validatorInvocations: 0,
  validatorCpuMs: 0,
  validatorWallClockMs: 0,
  validatorOutputBytes: 0,
});

function snapshotInvalid(message: string): MeterError {
  return new MeterError(METER_ERROR_CODES.METER_SNAPSHOT_INVALID, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function assertNonNegativeUsage(value: ValidationUsageInput): void {
  for (const [key, entry] of Object.entries(value)) {
    if (!Number.isFinite(entry) || entry < 0) {
      throw new MeterError('METER_INVALID_INPUT', `validation usage ${key} 必须是非负有限数值。`);
    }
  }
}

/**
 * Parses a persisted snapshot strictly (fail closed on any malformed field):
 * a corrupt meter file can never silently reset or relax the attempt budget.
 */
function parseSnapshot(raw: JsonObject, turnId: string): AttemptMeterSnapshotV1 {
  if (raw.version !== 1) {
    throw snapshotInvalid('attempt meter 快照版本不受支持。');
  }
  if (typeof raw.turnId !== 'string' || raw.turnId !== turnId) {
    throw snapshotInvalid('attempt meter 快照 turnId 与路径不一致。');
  }
  if (typeof raw.startedAtMs !== 'number' || !Number.isFinite(raw.startedAtMs)) {
    throw snapshotInvalid('attempt meter 快照 startedAtMs 无效。');
  }
  if (!Array.isArray(raw.toolCalls)) {
    throw snapshotInvalid('attempt meter 快照 toolCalls 无效。');
  }
  const toolCalls: AttemptToolCallRecord[] = raw.toolCalls.map((record, index) => {
    if (!isPlainObject(record)) {
      throw snapshotInvalid(`attempt meter 快照 toolCalls[${index}] 必须是对象。`);
    }
    if (
      typeof record.toolCallId !== 'string' ||
      typeof record.canonicalArgsHash !== 'string' ||
      typeof record.toolName !== 'string'
    ) {
      throw snapshotInvalid(`attempt meter 快照 toolCalls[${index}] 字段无效。`);
    }
    if (!isJsonValue(record.result)) {
      throw snapshotInvalid(`attempt meter 快照 toolCalls[${index}].result 无效。`);
    }
    return {
      toolCallId: record.toolCallId,
      canonicalArgsHash: record.canonicalArgsHash,
      toolName: record.toolName,
      result: (record.result as JsonValue) ?? null,
    };
  });
  const usageRaw = raw.usage;
  if (!isPlainObject(usageRaw)) {
    throw snapshotInvalid('attempt meter 快照 usage 无效。');
  }
  const usage = {
    slotToolCalls: nonNegativeInt(usageRaw.slotToolCalls, 'usage.slotToolCalls'),
    validationRuns: nonNegativeInt(usageRaw.validationRuns, 'usage.validationRuns'),
    validatorInvocations: nonNegativeInt(usageRaw.validatorInvocations, 'usage.validatorInvocations'),
    validatorCpuMs: nonNegativeInt(usageRaw.validatorCpuMs, 'usage.validatorCpuMs'),
    validatorWallClockMs: nonNegativeInt(usageRaw.validatorWallClockMs, 'usage.validatorWallClockMs'),
    validatorOutputBytes: nonNegativeInt(usageRaw.validatorOutputBytes, 'usage.validatorOutputBytes'),
  };
  let terminal: AttemptTerminalFailure | null = null;
  if (raw.terminal !== null && raw.terminal !== undefined) {
    if (!isPlainObject(raw.terminal)) {
      throw snapshotInvalid('attempt meter 快照 terminal 无效。');
    }
    if (raw.terminal.code !== RESOURCE_LIMIT_EXCEEDED) {
      throw snapshotInvalid('attempt meter 快照 terminal.code 无效。');
    }
    terminal = {
      code: RESOURCE_LIMIT_EXCEEDED,
      cause: typeof raw.terminal.cause === 'string' ? (raw.terminal.cause as AttemptMeterCause) : 'deadline',
      message: typeof raw.terminal.message === 'string' ? raw.terminal.message : '',
    };
  }
  return { version: 1, turnId, startedAtMs: raw.startedAtMs, toolCalls, usage, terminal };
}

function nonNegativeInt(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw snapshotInvalid(`attempt meter 快照 ${where} 无效。`);
  }
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isPlainObject(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

export class AttemptMeter {
  /**
   * Loads the persisted snapshot for the turn (if any) and constructs a meter
   * that CONTINUES from it — compaction / session continuation / replay never
   * resets cumulative usage, tool records or the deadline start.
   */
  static async create(options: AttemptMeterOptions): Promise<AttemptMeter> {
    const monotonicNow = options.monotonicNow ?? (() => performance.now());
    const raw = await options.privateStore.readAttemptMeter(options.turnId);
    const snapshot: AttemptMeterSnapshotV1 =
      raw === null
        ? {
            version: 1,
            turnId: options.turnId,
            startedAtMs: monotonicNow(),
            toolCalls: [],
            usage: emptyUsage(),
            terminal: null,
          }
        : parseSnapshot(raw, options.turnId);
    const meter = new AttemptMeter(options, snapshot);
    if (meter.closed) {
      meter.controller.abort(); // a re-created meter over a closed attempt stays closed
    } else {
      meter.scheduleDeadline();
    }
    await meter.persist();
    return meter;
  }

  readonly turnId: string;

  /** Monotonic start of the attempt (never reset by continuation). */
  readonly startedAtMs: number;

  private readonly privateStore: AttemptMeterStore;

  private readonly limits: StructuredSlotLimitsV1;

  private readonly monotonicNow: () => number;

  private readonly setTimeoutFn: (callback: () => void, ms: number) => unknown;

  private readonly clearTimeoutFn: (handle: unknown) => void;

  private readonly schedulerSignal: AbortSignal | null;

  private readonly onSchedulerAbort: () => void;

  private readonly controller = new AbortController();

  private readonly toolCallsInternal: AttemptToolCallRecord[];

  private readonly usageInternal: AttemptMeterUsage;

  private terminalInternal: AttemptTerminalFailure | null;

  private deadlineHandle: unknown = null;

  private constructor(options: AttemptMeterOptions, snapshot: AttemptMeterSnapshotV1) {
    this.turnId = snapshot.turnId;
    this.startedAtMs = snapshot.startedAtMs;
    this.privateStore = options.privateStore;
    this.limits = options.limits;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimeoutFn =
      options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.toolCallsInternal = snapshot.toolCalls.map((record) => ({ ...record }));
    this.usageInternal = { ...snapshot.usage };
    this.terminalInternal = snapshot.terminal;
    this.schedulerSignal = options.schedulerSignal ?? null;
    this.onSchedulerAbort = () => {
      this.controller.abort();
    };
    if (this.schedulerSignal !== null) {
      if (this.schedulerSignal.aborted) {
        this.controller.abort();
      } else {
        this.schedulerSignal.addEventListener('abort', this.onSchedulerAbort, { once: true });
      }
    }
  }

  /** The composite signal: deadline/resource closure ∪ scheduler stop. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** True once a resource limit or the deadline closed the Attempt. */
  get closed(): boolean {
    return this.terminalInternal !== null;
  }

  /** The terminal failure minted on closure, or null while open. */
  get terminalFailure(): AttemptTerminalFailure | null {
    return this.terminalInternal;
  }

  /** Cumulative attempt usage (the persisted truth, never reset). */
  get usage(): Readonly<AttemptMeterUsage> {
    return this.usageInternal;
  }

  /** Persisted tool signature/result records. */
  get toolCalls(): readonly AttemptToolCallRecord[] {
    return this.toolCallsInternal;
  }

  /** Removes the scheduler listener and pending deadline timer. */
  dispose(): void {
    this.clearTimeoutFn(this.deadlineHandle);
    this.schedulerSignal?.removeEventListener('abort', this.onSchedulerAbort);
  }

  /**
   * The pre-validation Slot Tool ingress (Task 14 owns the real Pi
   * subscription; this pins the persistent semantics). Only an exact
   * `(toolCallId, canonicalArgsHash)` with a recorded cached result is free;
   * every other call counts against the per-attempt slot-tool budget, and the
   * call beyond the exact max closes the Attempt.
   */
  async prechargeRawTool(input: {
    toolCallId: string;
    canonicalArgsHash: string;
    toolName: string;
  }): Promise<AttemptChargeResult> {
    if (this.checkDeadlineIfElapsed()) {
      return { status: 'closed', failure: this.terminalInternal! };
    }
    if (this.closed) {
      return { status: 'closed', failure: this.terminalInternal! };
    }
    const record = this.toolCallsInternal.find(
      (candidate) =>
        candidate.toolCallId === input.toolCallId &&
        candidate.canonicalArgsHash === input.canonicalArgsHash,
    );
    if (record !== undefined && record.result !== null) {
      // Exact replay of a recorded cached result is free — nothing else
      // bypasses metering.
      return { status: 'ok', replayed: true };
    }
    this.usageInternal.slotToolCalls += 1;
    if (record !== undefined) {
      record.toolName = input.toolName;
    } else {
      this.toolCallsInternal.push({
        toolCallId: input.toolCallId,
        canonicalArgsHash: input.canonicalArgsHash,
        toolName: input.toolName,
        result: null,
      });
    }
    this.scheduleDeadline();
    if (this.usageInternal.slotToolCalls > this.limits.attempt.maxSlotToolCallsPerAttempt) {
      const failure = this.closeSync(this.resourceFailure('slot_tool_limit'));
      await this.persist();
      return { status: 'closed', failure };
    }
    await this.persist();
    return { status: 'ok', replayed: false };
  }

  /**
   * Persists the cached result for an eligible exact replay. Only a recorded
   * cached result makes an exact replay free; the precharge decision is never
   * re-derived here.
   */
  async recordToolResult(input: {
    toolCallId: string;
    canonicalArgsHash: string;
    result: JsonValue;
  }): Promise<void> {
    const record = this.toolCallsInternal.find(
      (candidate) =>
        candidate.toolCallId === input.toolCallId &&
        candidate.canonicalArgsHash === input.canonicalArgsHash,
    );
    if (record !== undefined) {
      record.result = input.result;
    } else {
      this.toolCallsInternal.push({
        toolCallId: input.toolCallId,
        canonicalArgsHash: input.canonicalArgsHash,
        toolName: '',
        result: input.result,
      });
    }
    await this.persist();
  }

  /**
   * Non-mutating preflight of ONE validation run's declared aggregates against
   * `limits.attempt`. Reaching exactly a limit is legal; a reservation that
   * would exceed closes the Attempt before any validator sandbox starts.
   */
  async reserveValidation(declared: ValidationUsageInput): Promise<AttemptChargeResult> {
    if (this.checkDeadlineIfElapsed()) {
      return { status: 'closed', failure: this.terminalInternal! };
    }
    if (this.closed) {
      return { status: 'closed', failure: this.terminalInternal! };
    }
    assertNonNegativeUsage(declared);
    const projected: AttemptMeterUsage = {
      ...this.usageInternal,
      validationRuns: this.usageInternal.validationRuns + 1,
      validatorInvocations: this.usageInternal.validatorInvocations + declared.invocations,
      validatorCpuMs: this.usageInternal.validatorCpuMs + declared.cpuMs,
      validatorWallClockMs: this.usageInternal.validatorWallClockMs + declared.wallMs,
      validatorOutputBytes: this.usageInternal.validatorOutputBytes + declared.outputBytes,
    };
    const violation = this.findValidationViolation(projected);
    if (violation !== null) {
      const failure = this.closeSync(violation);
      await this.persist();
      return { status: 'closed', failure };
    }
    return { status: 'ok', replayed: false };
  }

  /**
   * Commits the ACTUAL validator aggregates of a completed run and checks the
   * cumulative totals against `limits.attempt`; an overage closes the Attempt.
   */
  async recordValidationUsage(actual: ValidationUsageInput): Promise<AttemptChargeResult> {
    if (this.checkDeadlineIfElapsed()) {
      return { status: 'closed', failure: this.terminalInternal! };
    }
    if (this.closed) {
      return { status: 'closed', failure: this.terminalInternal! };
    }
    assertNonNegativeUsage(actual);
    this.usageInternal.validationRuns += 1;
    this.usageInternal.validatorInvocations += actual.invocations;
    this.usageInternal.validatorCpuMs += actual.cpuMs;
    this.usageInternal.validatorWallClockMs += actual.wallMs;
    this.usageInternal.validatorOutputBytes += actual.outputBytes;
    this.scheduleDeadline();
    const violation = this.findValidationViolation(this.usageInternal);
    if (violation !== null) {
      const failure = this.closeSync(violation);
      await this.persist();
      return { status: 'closed', failure };
    }
    await this.persist();
    return { status: 'ok', replayed: false };
  }

  // ------------------------------------------------------------------ private

  private async persist(): Promise<void> {
    const snapshot: AttemptMeterSnapshotV1 = {
      version: 1,
      turnId: this.turnId,
      startedAtMs: this.startedAtMs,
      toolCalls: this.toolCallsInternal.map((record) => ({ ...record })),
      usage: { ...this.usageInternal },
      terminal: this.terminalInternal === null ? null : { ...this.terminalInternal },
    };
    // The snapshot is structurally pure JSON; the store canonicalizes and
    // runtime-checks the plain-object shape. The cast only bridges the TS
    // index-signature limitation between the versioned interface and JsonObject.
    await this.privateStore.writeAttemptMeter(
      this.turnId,
      snapshot as unknown as JsonObject,
    );
  }

  private scheduleDeadline(): void {
    if (this.closed) {
      return;
    }
    this.clearTimeoutFn(this.deadlineHandle);
    const elapsed = this.monotonicNow() - this.startedAtMs;
    const remaining = Math.max(0, this.limits.attempt.maxAttemptWallClockMs - elapsed);
    this.deadlineHandle = this.setTimeoutFn(() => {
      this.onDeadlineTimer();
    }, remaining);
  }

  private onDeadlineTimer(): void {
    if (this.closed) {
      return;
    }
    if (this.monotonicNow() - this.startedAtMs >= this.limits.attempt.maxAttemptWallClockMs) {
      this.closeSync(this.resourceFailure('deadline'));
      // The snapshot is a derived cache; a best-effort write failure on the
      // timer path must never crash the process (the terminal is authoritative
      // in the committed events).
      void this.persist().catch(() => undefined);
    } else {
      this.scheduleDeadline(); // spurious fire; re-arm against the monotonic clock
    }
  }

  /** Returns true when the monotonic deadline already elapsed (and closed). */
  private checkDeadlineIfElapsed(): boolean {
    if (this.closed) {
      return true;
    }
    if (this.monotonicNow() - this.startedAtMs >= this.limits.attempt.maxAttemptWallClockMs) {
      this.closeSync(this.resourceFailure('deadline'));
      void this.persist().catch(() => undefined);
      return true;
    }
    return false;
  }

  private closeSync(failure: AttemptTerminalFailure): AttemptTerminalFailure {
    if (this.terminalInternal !== null) {
      return this.terminalInternal; // idempotent: the SAME terminal failure
    }
    this.terminalInternal = failure;
    this.clearTimeoutFn(this.deadlineHandle);
    this.controller.abort();
    return failure;
  }

  private resourceFailure(cause: AttemptMeterCause): AttemptTerminalFailure {
    return {
      code: RESOURCE_LIMIT_EXCEEDED,
      cause,
      message: `RESOURCE_LIMIT_EXCEEDED: attempt 资源上限触发（${cause}）。`,
    };
  }

  private findValidationViolation(usage: AttemptMeterUsage): AttemptTerminalFailure | null {
    if (usage.validationRuns > this.limits.attempt.maxValidationRunsPerAttempt) {
      return this.resourceFailure('validation_limit');
    }
    if (usage.validatorInvocations > this.limits.attempt.maxValidatorInvocationsPerAttempt) {
      return this.resourceFailure('validator_invocations');
    }
    if (usage.validatorCpuMs > this.limits.attempt.maxAggregateValidatorCpuMsPerAttempt) {
      return this.resourceFailure('validator_cpu');
    }
    if (usage.validatorWallClockMs > this.limits.attempt.maxAggregateValidatorWallClockMsPerAttempt) {
      return this.resourceFailure('validator_wall');
    }
    if (usage.validatorOutputBytes > this.limits.attempt.maxValidatorOutputBytesPerAttempt) {
      return this.resourceFailure('validator_output');
    }
    return null;
  }
}
