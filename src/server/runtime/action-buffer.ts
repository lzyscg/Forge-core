/**
 * All-or-nothing per-Turn action buffer (plan 2026-08-07 Phase 2; v7 artifact
 * version directory schema, spec §4/§5.3).
 *
 * Only a completely successful model Turn may commit actions (global
 * constraint): states flow `open → successful | failed`, and `committed` is
 * terminal. `propose` is only accepted while open; `succeed(publicText,
 * usage)` seals the Turn; `fail` clears every buffered proposal (an abort is
 * equivalent to a failure); `commit()` returns a deep-frozen copy exactly once
 * and only from `successful`. A buffer never survives beyond one `run` call.
 *
 * v7 phase machine (production/operate/coordinate turns, spec §4):
 * - `production` phase: `load_skill`, `read_artifact_version`, `annotate_artifact`
 *   and `finish_production` are allowed. A production turn seals with
 *   `finish_production` (→ `sealed`); an operate/coordinate turn may dispatch
 *   directly from `production` (annotate → dispatch, or dispatch-only).
 * - `sealed` phase: only one dispatch action (or a human interrupt) may follow.
 * - `publish_artifact` is only valid after `finish_production` (production
 *   turns); `forward_input_version`/`send_message`/`submit_final_artifact` are
 *   valid from `production` (operate/coordinate) or `sealed` (production).
 * - `request_human_input` may interrupt as the sole first action OR after
 *   `finish_production`/`annotate_artifact` (F7 flipped, spec §4); it never
 *   follows a dispatch.
 * Completeness is NOT enforced here — a turn that never dispatches is still
 * handed to the committer, which parks it as a phase failure instead of
 * leaving the task `running` (spec §4.1).
 */
import type { AgentTurnResult } from './agent-runtime';
import type { ForgeAction } from './forge-actions';

export type ActionBufferState = 'open' | 'successful' | 'failed' | 'committed';

/** The turn-phase position inside an open (or sealed) buffer. */
export type ActionBufferPhase = 'production' | 'sealed' | 'dispatched' | 'human_interrupted';

export const ACTION_BUFFER_ERROR_CODES = {
  /** commit() while the Turn never reached a successful seal (open/failed). */
  TURN_NOT_SUCCESSFUL: 'TURN_NOT_SUCCESSFUL',
  /** Any second commit() or mutation after the buffer already committed. */
  COMMITTED_ALREADY: 'COMMITTED_ALREADY',
  /** propose/succeed while the buffer is not open. */
  BUFFER_NOT_OPEN: 'BUFFER_NOT_OPEN',
  /** A dispatch action before sealing where sealing was required. */
  PHASE_ORDER_INVALID: 'PHASE_ORDER_INVALID',
  /** A second finish_production in the same Turn. */
  PHASE_FINISH_DUPLICATE: 'PHASE_FINISH_DUPLICATE',
  /** Any action after the Turn already performed its one dispatch/interrupt. */
  PHASE_DISPATCH_DUPLICATE: 'PHASE_DISPATCH_DUPLICATE',
  /** request_human_input after a dispatch, or production work after it. */
  PHASE_HUMAN_INTERRUPT_INVALID: 'PHASE_HUMAN_INTERRUPT_INVALID',
  /** annotate_artifact after the package is sealed (operate-only action). */
  PHASE_ANNOTATE_AFTER_SEAL_INVALID: 'PHASE_ANNOTATE_AFTER_SEAL_INVALID',
  /** publish_artifact without a preceding finish_production. */
  PHASE_PUBLISH_WITHOUT_FINISH_INVALID: 'PHASE_PUBLISH_WITHOUT_FINISH_INVALID',
  /** The structured-slot dispatch guard rejected the action (Task 14). */
  STRUCTURE_ACTION_NOT_ALLOWED: 'STRUCTURE_ACTION_NOT_ALLOWED',
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

/** Dispatch actions that deliver the turn's one outcome. */
const DISPATCH_ACTION_TYPES: ReadonlySet<ForgeAction['type']> = new Set([
  'publish_artifact',
  'forward_input_version',
  'submit_final_artifact',
  'send_message',
]);

/** Actions valid only in the production phase (before sealing). */
const PRODUCTION_PHASE_TYPES: ReadonlySet<ForgeAction['type']> = new Set([
  'load_skill',
  'read_artifact_version',
  'annotate_artifact',
  'finish_production',
]);

/**
 * Optional structured-slot dispatch guard (Task 14): when wired, `propose`
 * runs it against the session completion BEFORE the action is buffered. A
 * rejected guard throws a coded ActionBufferError (nothing buffered); the tool
 * layer surfaces the code so the model can self-correct. With no guard wired
 * the buffer behaves byte-for-byte.
 */
export type ActionBufferBeforePropose = (action: ForgeAction) => ActionBufferError | null;

export class ActionBuffer {
  readonly turnId: string;

  #state: ActionBufferState = 'open';

  #phase: ActionBufferPhase = 'production';

  #proposals: ForgeAction[] = [];

  #failureCause: Error | null = null;

  readonly #beforePropose: ActionBufferBeforePropose | null;

  /**
   * Structured Seal turns already have a sealed candidate after `request_seal`.
   * Their declared `publish_artifact` dispatch therefore starts directly from
   * the operate phase; it must not be forced through the basic v2
   * `finish_production` transition.  The structured dispatch guard remains the
   * authority for candidate/route validity before this buffer sees the action.
   */
  readonly #allowPublishWithoutFinish: boolean;

  constructor(
    turnId: string,
    options?: {
      beforePropose?: ActionBufferBeforePropose;
      allowPublishWithoutFinish?: boolean;
    },
  ) {
    this.turnId = turnId;
    this.#beforePropose = options?.beforePropose ?? null;
    this.#allowPublishWithoutFinish = options?.allowPublishWithoutFinish ?? false;
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
   * Accepts one action proposal; only valid while open. Enforces the v7 phase
   * machine (spec §5.3) and fails loud with a stable code so the tool layer
   * can hand the model a correctable rejection.
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
    const guarded = this.#beforePropose?.(action);
    if (guarded !== null && guarded !== undefined) {
      throw guarded;
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
    void publicText;
    void usage;
    this.#state = 'successful';
  }

  /**
   * Discards every buffered proposal. Valid from `open` and from a sealed
   * (but uncommitted) buffer so a late abort can still drop actions; idempotent
   * once failed; rejected after commit.
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
   * Returns a deep-frozen copy of the sealed proposals, exactly once and only
   * from `successful`. An unsealed buffer fails the Turn loudly.
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
   * The v7 production/operate/coordinate phase gate (spec §4.1/§5.3). Throws a
   * coded ActionBufferError for every illegal transition without buffering the
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
    if (type === 'request_human_input') {
      // F7 flipped (spec §4): the direct human interrupt may be the sole first
      // action OR follow finish_production/annotate_artifact; it never follows
      // a dispatch. `production` and `sealed` both allow it.
      this.#phase = 'human_interrupted';
      return;
    }
    if (this.#phase === 'production') {
      if (DISPATCH_ACTION_TYPES.has(type)) {
        if (type === 'publish_artifact' && !this.#allowPublishWithoutFinish) {
          // publish requires a sealed package (production turn).
          throw new ActionBufferError(
            ACTION_BUFFER_ERROR_CODES.PHASE_PUBLISH_WITHOUT_FINISH_INVALID,
            'publish_artifact requires finish_production to seal the package first',
          );
        }
        // forward/send/submit dispatch directly from production (operate turn).
        this.#phase = 'dispatched';
        return;
      }
      if (type === 'finish_production') {
        this.#phase = 'sealed';
        return;
      }
      if (PRODUCTION_PHASE_TYPES.has(type)) {
        return; // load_skill / read_artifact_version / annotate_artifact stay
      }
      throw new ActionBufferError(
        ACTION_BUFFER_ERROR_CODES.PHASE_ORDER_INVALID,
        `action ${type} is not accepted in the production phase`,
      );
    }
    // phase === 'sealed'
    if (DISPATCH_ACTION_TYPES.has(type)) {
      this.#phase = 'dispatched';
      return;
    }
    if (type === 'finish_production') {
      throw new ActionBufferError(
        ACTION_BUFFER_ERROR_CODES.PHASE_FINISH_DUPLICATE,
        `turn ${this.turnId} already sealed its production package`,
      );
    }
    if (type === 'annotate_artifact') {
      throw new ActionBufferError(
        ACTION_BUFFER_ERROR_CODES.PHASE_ANNOTATE_AFTER_SEAL_INVALID,
        'annotate_artifact is an operate-turn action and cannot follow finish_production',
      );
    }
    throw new ActionBufferError(
      ACTION_BUFFER_ERROR_CODES.PHASE_ORDER_INVALID,
      'production tools are not allowed after the package is sealed',
    );
  }
}
