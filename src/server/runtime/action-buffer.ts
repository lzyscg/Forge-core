/**
 * All-or-nothing per-Turn action buffer (plan Phase C Task 1 Step 5;
 * phase-aware proposal gate added by plan 2026-08-04 Task 1, spec §4/§5.3).
 *
 * Only a completely successful model Turn may commit actions (global
 * constraint): states flow `open → successful | failed`, and `committed` is
 * terminal. `propose` is only accepted while open; `succeed(publicText,
 * usage)` seals the Turn; `fail` clears every buffered proposal (an abort is
 * equivalent to a failure and is failed by the caller); `commit()` returns a
 * deep-frozen copy exactly once and only from `successful`. A buffer never
 * survives beyond one `run` call — adapters create a fresh buffer per Turn.
 *
 * On top of the lifecycle, an open buffer tracks the turn's production/
 * dispatch phase and rejects illegal proposals IMMEDIATELY with a stable
 * code (spec §5.3): the pi tool layer surfaces that code to the model so it
 * can self-correct in the same Turn, and the ActionCommitter revalidates the
 * final action set as the non-bypassable boundary. Phase machine:
 * `production` → (finish_production, exactly once) → `sealed` → (exactly one
 * dispatch action) → `dispatched`. `request_human_input` is the only direct
 * interrupt: as the FIRST proposal it terminates the turn without a sealed
 * package; after sealing it counts as the dispatch action. That the
 * interrupt must be the SOLE first action is a frozen decision kept on
 * purpose (review F7); see the gate comment in `assertPhaseTransition`.
 * Completeness is
 * NOT enforced here — a turn that seals without finishing its phases is
 * still committed to the committer, which parks it as a phase failure
 * instead of leaving the task `running` (spec §4.1).
 */
import type { AgentTurnResult } from './agent-runtime';
import type { ForgeAction } from './forge-actions';

export type ActionBufferState = 'open' | 'successful' | 'failed' | 'committed';

/**
 * The turn-phase position inside an open (or sealed) buffer. Terminal phases
 * (`dispatched`, `human_interrupted`) reject every further proposal.
 */
export type ActionBufferPhase = 'production' | 'sealed' | 'dispatched' | 'human_interrupted';

export const ACTION_BUFFER_ERROR_CODES = {
  /** commit() while the Turn never reached a successful seal (open/failed). */
  TURN_NOT_SUCCESSFUL: 'TURN_NOT_SUCCESSFUL',
  /** Any second commit() or mutation after the buffer already committed. */
  COMMITTED_ALREADY: 'COMMITTED_ALREADY',
  /** propose/succeed while the buffer is not open. */
  BUFFER_NOT_OPEN: 'BUFFER_NOT_OPEN',
  /** A dispatch action before sealing, or a production/load_skill action after it. */
  PHASE_ORDER_INVALID: 'PHASE_ORDER_INVALID',
  /** A second finish_production in the same Turn. */
  PHASE_FINISH_DUPLICATE: 'PHASE_FINISH_DUPLICATE',
  /** Any action after the Turn already performed its one dispatch/interrupt. */
  PHASE_DISPATCH_DUPLICATE: 'PHASE_DISPATCH_DUPLICATE',
  /** request_human_input after production work began but before sealing. */
  PHASE_HUMAN_INTERRUPT_INVALID: 'PHASE_HUMAN_INTERRUPT_INVALID',
} as const;

export type ActionBufferErrorCode =
  (typeof ACTION_BUFFER_ERROR_CODES)[keyof typeof ACTION_BUFFER_ERROR_CODES];

/** Typed state-machine violation with a stable code. */
export class ActionBufferError extends Error {
  readonly code: ActionBufferErrorCode;

  constructor(code: ActionBufferErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ActionBufferError';
    this.code = code;
  }
}

/** Dispatch actions that deliver the sealed production package. */
const DELIVERY_ACTION_TYPES: ReadonlySet<ForgeAction['type']> = new Set([
  'send_message',
  'publish_artifact',
  'submit_final_artifact',
]);

export class ActionBuffer {
  readonly turnId: string;

  #state: ActionBufferState = 'open';

  #phase: ActionBufferPhase = 'production';

  #proposals: ForgeAction[] = [];

  #failureCause: Error | null = null;

  constructor(turnId: string) {
    this.turnId = turnId;
  }

  get state(): ActionBufferState {
    return this.#state;
  }

  /** The turn-phase position; meaningful while open, preserved afterwards. */
  get phase(): ActionBufferPhase {
    return this.#phase;
  }

  /** The error recorded by `fail`, or null while the buffer never failed. */
  get failureCause(): Error | null {
    return this.#failureCause;
  }

  /**
   * Accepts one action proposal; only valid while open. Enforces the
   * production → sealed → one-dispatch phase machine (spec §5.3) and fails
   * loud with a stable code so the tool layer can hand the model a
   * correctable rejection.
   */
  propose(action: ForgeAction): void {
    if (this.#state === 'committed') {
      throw new ActionBufferError(
        ACTION_BUFFER_ERROR_CODES.COMMITTED_ALREADY,
        `turn ${this.turnId} already committed its actions`,
      );
    }
    if (this.#state !== 'open') {
      throw new ActionBufferError(
        ACTION_BUFFER_ERROR_CODES.BUFFER_NOT_OPEN,
        `proposals are only accepted while the buffer is open (state=${this.#state})`,
      );
    }
    this.assertPhaseTransition(action);
    this.#proposals.push(action);
  }

  /** Seals a completely successful Turn; invalid once failed or committed. */
  succeed(publicText: string, usage: AgentTurnResult['usage']): void {
    if (this.#state === 'committed') {
      throw new ActionBufferError(
        ACTION_BUFFER_ERROR_CODES.COMMITTED_ALREADY,
        `turn ${this.turnId} already committed its actions`,
      );
    }
    if (this.#state !== 'open') {
      throw new ActionBufferError(
        ACTION_BUFFER_ERROR_CODES.BUFFER_NOT_OPEN,
        `only an open buffer can be sealed (state=${this.#state})`,
      );
    }
    // publicText/usage are owned by the AgentTurnResult on the caller side;
    // the buffer only records the seal so commit stays strictly action-only.
    void publicText;
    void usage;
    this.#state = 'successful';
  }

  /**
   * Discards every buffered proposal. Valid from `open` and from a sealed
   * (but uncommitted) buffer so a late abort can still drop actions;
   * idempotent once failed; rejected after commit.
   */
  fail(cause: Error): void {
    if (this.#state === 'committed') {
      throw new ActionBufferError(
        ACTION_BUFFER_ERROR_CODES.COMMITTED_ALREADY,
        `turn ${this.turnId} already committed its actions`,
      );
    }
    if (this.#state === 'failed') {
      return; // first cause wins
    }
    this.#proposals = [];
    this.#phase = 'production';
    this.#failureCause = cause;
    this.#state = 'failed';
  }

  /**
   * Returns a deep-frozen copy of the sealed proposals, exactly once and
   * only from `successful`. An unsealed buffer fails the Turn loudly.
   */
  commit(): readonly ForgeAction[] {
    if (this.#state === 'committed') {
      throw new ActionBufferError(
        ACTION_BUFFER_ERROR_CODES.COMMITTED_ALREADY,
        `turn ${this.turnId} already committed its actions`,
      );
    }
    if (this.#state !== 'successful') {
      throw new ActionBufferError(
        ACTION_BUFFER_ERROR_CODES.TURN_NOT_SUCCESSFUL,
        `cannot commit actions for turn ${this.turnId} while the buffer is ${this.#state}`,
      );
    }
    const copy = this.#proposals.map((action) => Object.freeze({ ...action }));
    this.#state = 'committed';
    return Object.freeze(copy);
  }

  /** Defensive shallow copy of the currently buffered proposals. */
  snapshot(): ForgeAction[] {
    return this.#proposals.map((action) => ({ ...action }));
  }

  /**
   * The production/dispatch phase gate (spec §4.1/§5.3). Throws a coded
   * ActionBufferError for every illegal transition without buffering the
   * proposal; legal transitions advance `#phase`.
   */
  private assertPhaseTransition(action: ForgeAction): void {
    const type = action.type;
    if (this.#phase === 'dispatched' || this.#phase === 'human_interrupted') {
      throw new ActionBufferError(
        ACTION_BUFFER_ERROR_CODES.PHASE_DISPATCH_DUPLICATE,
        `turn ${this.turnId} already completed its one dispatch; no further actions are accepted`,
      );
    }
    if (this.#phase === 'production') {
      if (type === 'request_human_input') {
        if (this.#proposals.length > 0) {
          // FROZEN DECISION (review F7, kept on purpose): the direct human
          // interrupt is strictly the SOLE FIRST action of the turn. Any
          // production work before it — even one load_skill — rejects it,
          // and once it interrupts, the turn is terminal. Do not relax this
          // without a spec change.
          throw new ActionBufferError(
            ACTION_BUFFER_ERROR_CODES.PHASE_HUMAN_INTERRUPT_INVALID,
            'request_human_input may only interrupt as the first action of the turn',
          );
        }
        this.#phase = 'human_interrupted';
        return;
      }
      if (DELIVERY_ACTION_TYPES.has(type)) {
        throw new ActionBufferError(
          ACTION_BUFFER_ERROR_CODES.PHASE_ORDER_INVALID,
          'dispatch actions require finish_production to seal the production package first',
        );
      }
      if (type === 'finish_production') {
        this.#phase = 'sealed';
      }
      return; // load_skill stays in the production phase
    }
    // phase === 'sealed'
    if (type === 'finish_production') {
      throw new ActionBufferError(
        ACTION_BUFFER_ERROR_CODES.PHASE_FINISH_DUPLICATE,
        `turn ${this.turnId} already sealed its production package`,
      );
    }
    if (type === 'request_human_input') {
      this.#phase = 'human_interrupted';
      return;
    }
    if (DELIVERY_ACTION_TYPES.has(type)) {
      this.#phase = 'dispatched';
      return;
    }
    throw new ActionBufferError(
      ACTION_BUFFER_ERROR_CODES.PHASE_ORDER_INVALID,
      'production tools and load_skill are not allowed after the package is sealed',
    );
  }
}
