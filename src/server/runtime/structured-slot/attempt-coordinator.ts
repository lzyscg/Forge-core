/**
 * Structured attempt coordinator (Task 11) — the concurrency/safety-critical
 * layer of the structured slot engine (spec §8.1, design §11.5 + §25.6 G02/G03).
 *
 * The coordinator owns:
 *
 * - Deterministic attempt-epoch allocation: `turnId` derives from
 *   `inputNodeId + attemptEpoch`; `attemptEpoch` is `maxEpoch(inputNodeId)+1`
 *   over committed `structured_slot_attempt_started` events. The start batch
 *   is committed through a CAS read/append loop (expectedLastSequence = the
 *   current tail; on a tail mismatch the loop re-reads and retries). While an
 *   attempt is still active (started without terminal) for an input,
 *   `startAttempt` replays the committed identities instead of allocating a
 *   second epoch — a new epoch is only ever allocated after the previous one
 *   is terminalized (stop, retry, crash recovery, human answer all close the
 *   old attempt first, spec §8.1).
 * - The terminal-batch authority: exactly six legal status/reason pairs;
 *   every started attempt gets exactly one terminal; completion/stop/failure
 *   racing concurrently yields one committed terminal and the losers return
 *   it (never a second write). A fill draft terminal companion is only
 *   accepted when the draft was actually opened (no terminal-without-opened).
 * - Startup dangling recovery: every started-without-terminal attempt is
 *   closed as `abandoned/crash_recovery` in ONE authority batch, plus a
 *   `structured_fill_draft_terminal(abandoned)` for every fill draft that was
 *   opened. Private-store reconciliation is the caller's best-effort step and
 *   must run only AFTER this authority batch; a crash before it is repaired
 *   from events on the next startup.
 *
 * The coordinator is a pure function of the committed event log plus the
 * caller-injected store primitives (`appendBatch` pre-bound to the task, and
 * `readEvents` for the CAS retry loop). It writes NO private state. All event
 * ids and commit ids are deterministic and safe segments. No business
 * vocabulary lives here (iron rule 1).
 */
import { STORAGE_ERROR_CODES, StorageError } from '../../storage/atomic-file';
import type { CommittedEvent } from '../../storage/event-store';
import type {
  StructuredAttemptReason,
  StructuredAttemptStatus,
  StructuredSessionKind,
  TaskEvent,
} from '../../storage/task-events';

/** Stable coordinator error codes (fail closed; never guessed). */
export const COORDINATOR_ERROR_CODES = {
  ILLEGAL_TERMINAL_PAIR: 'ILLEGAL_TERMINAL_PAIR',
  ATTEMPT_NOT_STARTED: 'ATTEMPT_NOT_STARTED',
  FILL_DRAFT_NOT_OPENED: 'FILL_DRAFT_NOT_OPENED',
  FILL_DRAFT_CONTEXT_REQUIRED: 'FILL_DRAFT_CONTEXT_REQUIRED',
  FILL_DRAFT_CONTEXT_INVALID: 'FILL_DRAFT_CONTEXT_INVALID',
} as const;

export type CoordinatorErrorCode = (typeof COORDINATOR_ERROR_CODES)[keyof typeof COORDINATOR_ERROR_CODES];

/** Stable typed error for coordinator validation failures. */
export class CoordinatorError extends Error {
  readonly code: CoordinatorErrorCode;

  constructor(code: CoordinatorErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CoordinatorError';
    this.code = code;
  }
}

/** One committed attempt identity (started, or started+active). */
export interface ActiveAttempt {
  inputNodeId: string;
  attemptEpoch: number;
  turnId: string;
  sessionKind: StructuredSessionKind;
}

/** Pre-bound `EventStore.appendBatch` with the task id pinned. */
export type AppendBatch = (
  commitId: string,
  events: readonly TaskEvent[],
  expectedLastSequence: number,
) => Promise<CommittedEvent[]>;

/** Re-reads the task's committed event log (the CAS retry loop). */
export type ReadEvents = () => Promise<readonly CommittedEvent[]>;

/** Fill-only binding carried into `structured_fill_draft_opened`. */
export interface StartAttemptDraftContext {
  scaffoldId: string;
  generationId: string;
  baseRevision: number;
}

export interface StartAttemptInput {
  taskId: string;
  inputNodeId: string;
  agentId: string;
  sessionKind: StructuredSessionKind;
  /** Current committed events (fresh read by the caller). */
  events: readonly CommittedEvent[];
  /** Re-reads committed events for the CAS retry loop. */
  readEvents: ReadEvents;
  /** Pre-bound appendBatch (taskId pinned). */
  appendBatch: AppendBatch;
  /** Optional caller-supplied start companions merged into the start batch. */
  companions?: readonly TaskEvent[];
  /** Fill-only scaffold/generation/baseRevision bound into draft_opened. */
  draftContext?: StartAttemptDraftContext;
  /** Injectable clock for event timestamps; defaults to system time. */
  clock?: () => Date;
}

export interface StartAttemptResult {
  attemptEpoch: number;
  turnId: string;
  /** The committed start batch (for private materialization). */
  committed: CommittedEvent[];
}

export interface TerminalizeInput {
  taskId: string;
  inputNodeId: string;
  attemptEpoch: number;
  turnId: string;
  status: StructuredAttemptStatus;
  reason: StructuredAttemptReason;
  /** Caller-supplied authoritative facts committed atomically with the terminal. */
  companions?: readonly TaskEvent[];
  /** The current logical tail the caller observed. */
  expectedTail: number;
  /** Re-reads committed events for the CAS retry loop. */
  readEvents: ReadEvents;
  appendBatch: AppendBatch;
  /** Injectable clock for event timestamps; defaults to system time. */
  clock?: () => Date;
}

export interface TerminalizeResult {
  /** The committed terminal batch (or the committed terminal on a race replay). */
  committed: CommittedEvent[];
}

export interface RecoverDanglingInput {
  taskId: string;
  /** Current committed events (fresh startup read). */
  events: readonly CommittedEvent[];
  /** Pre-bound appendBatch (taskId pinned). */
  appendBatch: AppendBatch;
  /** Additional authoritative recovery facts (e.g. task_interrupted). */
  companions?: readonly TaskEvent[];
  /** Injectable clock for event timestamps; defaults to system time. */
  clock?: () => Date;
}

export interface RecoverDanglingResult {
  /** How many started-without-terminal attempts were closed. */
  closed: number;
  /** The committed recovery batch, or null when nothing was dangling. */
  committed: CommittedEvent[] | null;
}

/** The six legal status/reason pairings (spec §8.1); anything else fails. */
const LEGAL_TERMINAL_PAIRS: Readonly<Record<StructuredAttemptStatus, readonly StructuredAttemptReason[]>> =
  {
    committed: ['completion_dispatch', 'rework_dispatch'],
    failed: ['runtime_failure'],
    abandoned: ['task_stop', 'crash_recovery'],
    waiting_human: ['human_request'],
  };

/** Deterministic turnId for an input node + attempt epoch (design §11.5). */
export function deriveTurnId(inputNodeId: string, attemptEpoch: number): string {
  return `${inputNodeId}-t${attemptEpoch}`;
}

/** Deterministic draftId for a fill attempt (design §11.5/O01). */
export function deriveDraftId(turnId: string): string {
  return `${turnId}-draft`;
}

/** The latest started-without-terminal attempt for the input, or null. */
export function activeAttemptForInput(
  events: readonly TaskEvent[],
  inputNodeId: string,
): ActiveAttempt | null {
  const terminalTurns = new Set<string>();
  for (const event of events) {
    if (event.type === 'structured_slot_attempt_terminal' && event.inputNodeId === inputNodeId) {
      terminalTurns.add(event.turnId);
    }
  }
  let latest: Extract<TaskEvent, { type: 'structured_slot_attempt_started' }> | null = null;
  let latestEpoch = 0;
  for (const event of events) {
    if (
      event.type === 'structured_slot_attempt_started' &&
      event.inputNodeId === inputNodeId &&
      !terminalTurns.has(event.turnId) &&
      event.attemptEpoch > latestEpoch
    ) {
      latest = event;
      latestEpoch = event.attemptEpoch;
    }
  }
  if (latest === null) {
    return null;
  }
  return {
    inputNodeId: latest.inputNodeId,
    attemptEpoch: latest.attemptEpoch,
    turnId: latest.turnId,
    sessionKind: latest.sessionKind,
  };
}

/**
 * Allocates the next attempt epoch and commits its start batch atomically
 * (spec §8.1 / design §11.5). Structure/seal start batches contain ONLY
 * `structured_slot_attempt_started`; a fill start batch contains
 * `attempt_started + structured_fill_draft_opened` in one atomic write, with
 * the draftId deterministically derived from the turnId. Retries only the CAS
 * read/append loop; an already-started attempt replays its committed
 * identities rather than allocating a second epoch.
 */
export async function startAttempt(input: StartAttemptInput): Promise<StartAttemptResult> {
  if (input.sessionKind === 'fill') {
    if (input.draftContext === undefined) {
      throw new CoordinatorError(
        COORDINATOR_ERROR_CODES.FILL_DRAFT_CONTEXT_REQUIRED,
        'fill 起始批次必须提供 scaffold/generation/baseRevision。',
      );
    }
    assertDraftContext(input.draftContext);
  }
  let events = input.events;
  for (;;) {
    const active = activeAttemptForInput(taskEventsOf(events), input.inputNodeId);
    if (active !== null) {
      // Already started and still active: replay the committed identities.
      return {
        attemptEpoch: active.attemptEpoch,
        turnId: active.turnId,
        committed: startBatchCommitted(events, active.turnId, active.sessionKind),
      };
    }
    const attemptEpoch = maxEpochForInput(taskEventsOf(events), input.inputNodeId) + 1;
    const turnId = deriveTurnId(input.inputNodeId, attemptEpoch);
    const batch = buildStartBatch(input, turnId, attemptEpoch);
    const commitId = `${turnId}-start`;
    const expectedLastSequence = tailSequence(events);
    try {
      const committed = await input.appendBatch(commitId, batch, expectedLastSequence);
      return { attemptEpoch, turnId, committed };
    } catch (error) {
      if (isStorageError(error, STORAGE_ERROR_CODES.EXPECTED_SEQUENCE_MISMATCH)) {
        events = await input.readEvents();
        continue; // CAS retry loop only
      }
      if (isStorageError(error, STORAGE_ERROR_CODES.IDEMPOTENCY_CONFLICT)) {
        // The start commitId already exists with a different payload: re-read
        // and return the committed identities instead of guessing.
        events = await input.readEvents();
        const committedActive = activeAttemptForInput(taskEventsOf(events), input.inputNodeId);
        if (committedActive !== null) {
          return {
            attemptEpoch: committedActive.attemptEpoch,
            turnId: committedActive.turnId,
            committed: startBatchCommitted(
              events,
              committedActive.turnId,
              committedActive.sessionKind,
            ),
          };
        }
        throw error;
      }
      throw error;
    }
  }
}

/**
 * Commits the attempt terminal with its caller-supplied authoritative
 * companions in ONE batch (spec §8.1 / design §11.5). Validates the six legal
 * status/reason pairs, that the attempt was actually started, and that any
 * fill draft terminal companion has an opened event. Completion/stop/failure
 * racing concurrently produce exactly one terminal; losers return the
 * committed terminal instead of writing a second one.
 */
export async function terminalize(input: TerminalizeInput): Promise<TerminalizeResult> {
  assertLegalTerminalPair(input.status, input.reason);
  let events = await input.readEvents();
  assertAttemptStarted(taskEventsOf(events), input);
  assertFillDraftTerminalsOpened(taskEventsOf(events), input);
  let expectedTail = input.expectedTail;
  const at = input.clock?.().toISOString() ?? new Date().toISOString();
  const terminal: TaskEvent = {
    id: `${input.turnId}-attempt-terminal`,
    at,
    type: 'structured_slot_attempt_terminal',
    inputNodeId: input.inputNodeId,
    attemptEpoch: input.attemptEpoch,
    turnId: input.turnId,
    status: input.status,
    reason: input.reason,
  };
  const batch = [terminal, ...(input.companions ?? [])];
  const commitId = `${input.turnId}-terminal`;
  for (;;) {
    try {
      const committed = await input.appendBatch(commitId, batch, expectedTail);
      return { committed };
    } catch (error) {
      if (isStorageError(error, STORAGE_ERROR_CODES.EXPECTED_SEQUENCE_MISMATCH)) {
        events = await input.readEvents();
        expectedTail = tailSequence(events);
        continue; // CAS retry loop only
      }
      if (isStorageError(error, STORAGE_ERROR_CODES.IDEMPOTENCY_CONFLICT)) {
        // A racing completion/stop/failure already committed this terminal:
        // return the committed one — never a second terminal or override.
        events = await input.readEvents();
        const committedTerminal = events.find(
          (entry) => entry.event.id === `${input.turnId}-attempt-terminal`,
        );
        if (committedTerminal !== undefined) {
          return { committed: [committedTerminal] };
        }
        throw error;
      }
      throw error;
    }
  }
}

/**
 * Startup recovery (design §11.5/§25.6 G03): closes EVERY started-without-
 * terminal attempt as `abandoned/crash_recovery` in ONE authority batch,
 * writing a `structured_fill_draft_terminal(abandoned)` for each fill draft
 * that was opened. Callers must run private-store reconciliation only AFTER
 * this batch commits; a crash before it is repaired from events on the next
 * startup. The `companions` seam lets Task 17 carry `task_interrupted` in the
 * same authority batch.
 */
export async function recoverDanglingAttempts(
  input: RecoverDanglingInput,
): Promise<RecoverDanglingResult> {
  const dangling = danglingAttempts(input.events);
  if (dangling.length === 0) {
    return { closed: 0, committed: null };
  }
  const at = input.clock?.().toISOString() ?? new Date().toISOString();
  const openedByTurn = new Map<string, Extract<TaskEvent, { type: 'structured_fill_draft_opened' }>>();
  for (const entry of input.events) {
    if (entry.event.type === 'structured_fill_draft_opened') {
      openedByTurn.set(entry.event.turnId, entry.event);
    }
  }
  const batch: TaskEvent[] = [];
  for (const attempt of dangling) {
    batch.push({
      id: `${attempt.turnId}-attempt-terminal`,
      at,
      type: 'structured_slot_attempt_terminal',
      inputNodeId: attempt.inputNodeId,
      attemptEpoch: attempt.attemptEpoch,
      turnId: attempt.turnId,
      status: 'abandoned',
      reason: 'crash_recovery',
    });
    if (attempt.sessionKind === 'fill') {
      const opened = openedByTurn.get(attempt.turnId);
      if (opened !== undefined) {
        batch.push({
          id: `${opened.draftId}-terminal`,
          at,
          type: 'structured_fill_draft_terminal',
          draftId: opened.draftId,
          turnId: attempt.turnId,
          status: 'abandoned',
          baseRevision: opened.baseRevision,
          resultRevision: 0,
          changeCount: 0,
          content: null,
        });
      }
    }
  }
  batch.push(...(input.companions ?? []));
  const committed = await input.appendBatch(
    'recover-dangling',
    batch,
    tailSequence(input.events),
  );
  return { closed: dangling.length, committed };
}

// ----------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------

function taskEventsOf(events: readonly CommittedEvent[]): TaskEvent[] {
  return events.map((entry) => entry.event);
}

function tailSequence(events: readonly CommittedEvent[]): number {
  return events[events.length - 1]?.sequence ?? 0;
}

function maxEpochForInput(events: readonly TaskEvent[], inputNodeId: string): number {
  let max = 0;
  for (const event of events) {
    if (event.type === 'structured_slot_attempt_started' && event.inputNodeId === inputNodeId) {
      max = Math.max(max, event.attemptEpoch);
    }
  }
  return max;
}

function buildStartBatch(
  input: StartAttemptInput,
  turnId: string,
  attemptEpoch: number,
): TaskEvent[] {
  const at = input.clock?.().toISOString() ?? new Date().toISOString();
  const started: TaskEvent = {
    id: `${turnId}-attempt-started`,
    at,
    type: 'structured_slot_attempt_started',
    inputNodeId: input.inputNodeId,
    agentId: input.agentId,
    attemptEpoch,
    turnId,
    sessionKind: input.sessionKind,
  };
  if (input.sessionKind !== 'fill') {
    return [started, ...(input.companions ?? [])];
  }
  const draftContext = input.draftContext as StartAttemptDraftContext;
  const draftId = deriveDraftId(turnId);
  const opened: TaskEvent = {
    id: `${draftId}-opened`,
    at,
    type: 'structured_fill_draft_opened',
    draftId,
    turnId,
    scaffoldId: draftContext.scaffoldId,
    generationId: draftContext.generationId,
    baseRevision: draftContext.baseRevision,
  };
  return [started, opened, ...(input.companions ?? [])];
}

/** The committed start-batch entries for a turn (started + fill opened). */
function startBatchCommitted(
  events: readonly CommittedEvent[],
  turnId: string,
  sessionKind: StructuredSessionKind,
): CommittedEvent[] {
  const ids = new Set<string>([`${turnId}-attempt-started`]);
  if (sessionKind === 'fill') {
    ids.add(`${deriveDraftId(turnId)}-opened`);
  }
  return events.filter((entry) => ids.has(entry.event.id));
}

function danglingAttempts(events: readonly CommittedEvent[]): ActiveAttempt[] {
  const terminalTurns = new Set<string>();
  for (const entry of events) {
    if (entry.event.type === 'structured_slot_attempt_terminal') {
      terminalTurns.add(entry.event.turnId);
    }
  }
  const result: ActiveAttempt[] = [];
  for (const entry of events) {
    const event = entry.event;
    if (event.type !== 'structured_slot_attempt_started') {
      continue;
    }
    if (terminalTurns.has(event.turnId)) {
      continue;
    }
    result.push({
      inputNodeId: event.inputNodeId,
      attemptEpoch: event.attemptEpoch,
      turnId: event.turnId,
      sessionKind: event.sessionKind,
    });
  }
  return result;
}

function assertLegalTerminalPair(
  status: StructuredAttemptStatus,
  reason: StructuredAttemptReason,
): void {
  const allowed = LEGAL_TERMINAL_PAIRS[status];
  if (allowed === undefined || !allowed.includes(reason)) {
    throw new CoordinatorError(
      COORDINATOR_ERROR_CODES.ILLEGAL_TERMINAL_PAIR,
      `非法 terminal 状态/原因组合：${status}/${reason}。`,
    );
  }
}

function assertAttemptStarted(
  events: readonly TaskEvent[],
  input: TerminalizeInput,
): void {
  const started = events.some(
    (event) =>
      event.type === 'structured_slot_attempt_started' &&
      event.inputNodeId === input.inputNodeId &&
      event.attemptEpoch === input.attemptEpoch &&
      event.turnId === input.turnId,
  );
  if (!started) {
    throw new CoordinatorError(
      COORDINATOR_ERROR_CODES.ATTEMPT_NOT_STARTED,
      `terminal 前置条件不满足：attempt ${input.turnId} 尚未 started。`,
    );
  }
}

function assertFillDraftTerminalsOpened(
  events: readonly TaskEvent[],
  input: TerminalizeInput,
): void {
  for (const companion of input.companions ?? []) {
    if (companion.type !== 'structured_fill_draft_terminal') {
      continue;
    }
    const opened = events.some(
      (event) =>
        event.type === 'structured_fill_draft_opened' && event.draftId === companion.draftId,
    );
    if (!opened) {
      throw new CoordinatorError(
        COORDINATOR_ERROR_CODES.FILL_DRAFT_NOT_OPENED,
        `fill draft terminal 前置条件不满足：draft ${companion.draftId} 未 opened。`,
      );
    }
  }
}

function assertDraftContext(context: StartAttemptDraftContext): void {
  if (typeof context.scaffoldId !== 'string' || context.scaffoldId.length === 0) {
    throw new CoordinatorError(
      COORDINATOR_ERROR_CODES.FILL_DRAFT_CONTEXT_INVALID,
      'fill draft context 缺少 scaffoldId。',
    );
  }
  if (typeof context.generationId !== 'string' || context.generationId.length === 0) {
    throw new CoordinatorError(
      COORDINATOR_ERROR_CODES.FILL_DRAFT_CONTEXT_INVALID,
      'fill draft context 缺少 generationId。',
    );
  }
  if (!Number.isInteger(context.baseRevision) || context.baseRevision < 0) {
    throw new CoordinatorError(
      COORDINATOR_ERROR_CODES.FILL_DRAFT_CONTEXT_INVALID,
      'fill draft context 的 baseRevision 必须是不小于 0 的整数。',
    );
  }
}

function isStorageError(error: unknown, code: string): boolean {
  return error instanceof StorageError && error.code === code;
}
