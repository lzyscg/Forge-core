// @vitest-environment node
/**
 * ActionBuffer state machine + turn-phase gate tests (plan 2026-08-04
 * Task 1 Step 1, spec §4/§5.3).
 *
 * Lifecycle states stay `open → successful | failed`, then
 * `successful → committed`. On top of the lifecycle, an open buffer tracks
 * the turn's production/dispatch phase and rejects illegal proposals
 * IMMEDIATELY with a stable code — the pi tool layer surfaces that code to
 * the model so it can self-correct in the same Turn; the ActionCommitter
 * revalidates the final set as the non-bypassable boundary (spec §5.3).
 *
 * Phase machine: `production` → (finish_production, exactly once) →
 * `sealed` → (exactly one dispatch action) → `dispatched`.
 * `request_human_input` is the only direct interrupt: as the FIRST proposal
 * it terminates the turn without a sealed package; after sealing it is the
 * dispatch action. `load_skill` stays a production-phase action.
 */
import { describe, expect, it } from 'vitest';
import {
  ACTION_BUFFER_ERROR_CODES,
  ActionBuffer,
  ActionBufferError,
} from './action-buffer';
import { RuntimeAbortedError, RuntimeFailure } from './agent-runtime';
import type { ForgeAction } from './forge-actions';
import { fakeUsage, sendMessageProposal } from './test-support';

function finishInline(content = 'sealed review'): ForgeAction {
  return {
    type: 'finish_production',
    source: 'inline',
    files: [{ name: 'content.md', content }],
    format: 'text',
    artifactType: null,
    title: null,
  };
}

function publishPackage(): ForgeAction {
  return { type: 'publish_artifact' };
}

function humanRequest(question = 'Which variant should continue?'): ForgeAction {
  return { type: 'request_human_input', question };
}

function loadSkill(skillId = 'skill-alpha'): ForgeAction {
  return { type: 'load_skill', skillId };
}

describe('ActionBuffer happy path', () => {
  it('exposes the turn id, starts open in the production phase', () => {
    const buffer = new ActionBuffer('turn-1');
    expect(buffer.turnId).toBe('turn-1');
    expect(buffer.state).toBe('open');
    expect(buffer.phase).toBe('production');
    expect(buffer.snapshot()).toEqual([]);
    expect(buffer.failureCause).toBeNull();
  });

  it('accepts the full production → sealed → dispatch sequence and commits in order', () => {
    const buffer = new ActionBuffer('turn-1');
    const first = loadSkill();
    const second = finishInline();
    const third = sendMessageProposal();
    buffer.propose(first);
    expect(buffer.phase).toBe('production');
    buffer.propose(second);
    expect(buffer.phase).toBe('sealed');
    buffer.propose(third);
    expect(buffer.phase).toBe('dispatched');
    buffer.succeed('sealed public text', fakeUsage());
    expect(buffer.state).toBe('successful');

    const committed = buffer.commit();
    expect(buffer.state).toBe('committed');
    expect(committed).toEqual([first, second, third]);

    expect(() => buffer.commit()).toThrowError('COMMITTED_ALREADY');
    expect(() => buffer.commit()).toThrow(ActionBufferError);
  });

  it('allows finish_production as the very first action', () => {
    const buffer = new ActionBuffer('turn-1');
    buffer.propose(finishInline());
    buffer.propose(publishPackage());
    buffer.succeed('text', null);
    expect(buffer.commit()).toHaveLength(2);
  });

  it('accepts request_human_input as the direct first-action interrupt', () => {
    const buffer = new ActionBuffer('turn-1');
    buffer.propose(humanRequest());
    expect(buffer.phase).toBe('human_interrupted');
    buffer.succeed('text', null);
    expect(buffer.commit()).toEqual([humanRequest()]);
  });

  it('accepts request_human_input after sealing as the dispatch action', () => {
    const buffer = new ActionBuffer('turn-1');
    buffer.propose(finishInline());
    buffer.propose(humanRequest());
    expect(buffer.phase).toBe('human_interrupted');
    buffer.succeed('text', null);
    expect(buffer.commit()).toHaveLength(2);
  });

  it('returns an immutable copy that does not leak buffer state', () => {
    const buffer = new ActionBuffer('turn-1');
    buffer.propose(finishInline());
    buffer.propose(sendMessageProposal());
    buffer.succeed('text', null);
    const committed = buffer.commit();

    expect(Object.isFrozen(committed)).toBe(true);
    expect(Object.isFrozen(committed[0])).toBe(true);
    expect(() => {
      (committed as ForgeAction[]).push(publishPackage());
    }).toThrow();
    expect(() => {
      (committed[0] as { content: string }).content = 'tampered';
    }).toThrow();

    // snapshot stays a defensive copy even after commit.
    const view = buffer.snapshot();
    view.push(publishPackage());
    expect(buffer.snapshot()).toHaveLength(2);
  });

  it('keeps proposals visible through snapshot while open', () => {
    const buffer = new ActionBuffer('turn-1');
    buffer.propose(finishInline());
    const view = buffer.snapshot();
    view.pop();
    expect(buffer.snapshot()).toHaveLength(1);
  });
});

describe('ActionBuffer phase gate (spec §4.1/§5.3)', () => {
  it('rejects publish_artifact before finish_production (PHASE_PUBLISH_WITHOUT_FINISH_INVALID)', () => {
    const buffer = new ActionBuffer('turn-1');
    expect(() => buffer.propose(publishPackage()))
      .toThrowError(ACTION_BUFFER_ERROR_CODES.PHASE_PUBLISH_WITHOUT_FINISH_INVALID);
    // The rejected proposal never entered the buffer.
    expect(buffer.snapshot()).toEqual([]);
    expect(buffer.phase).toBe('production');
  });

  it('allows a structured Seal publish dispatch without finish_production', () => {
    const buffer = new ActionBuffer('turn-structured-seal', { allowPublishWithoutFinish: true });
    expect(() => buffer.propose(publishPackage())).not.toThrow();
    expect(buffer.phase).toBe('dispatched');
  });

  it('dispatches operate actions directly from production without sealing', () => {
    const sendBuffer = new ActionBuffer('turn-1');
    sendBuffer.propose(sendMessageProposal());
    expect(sendBuffer.phase).toBe('dispatched');

    const submitBuffer = new ActionBuffer('turn-2');
    submitBuffer.propose({ type: 'submit_final_artifact' });
    expect(submitBuffer.phase).toBe('dispatched');

    const forwardBuffer = new ActionBuffer('turn-3');
    forwardBuffer.propose({ type: 'forward_input_version', targetAgentId: 'controller' });
    expect(forwardBuffer.phase).toBe('dispatched');
  });

  it('rejects a second finish_production (PHASE_FINISH_DUPLICATE)', () => {
    const buffer = new ActionBuffer('turn-1');
    buffer.propose(finishInline());
    expect(() => buffer.propose(finishInline('second seal')))
      .toThrowError(ACTION_BUFFER_ERROR_CODES.PHASE_FINISH_DUPLICATE);
    expect(buffer.snapshot()).toHaveLength(1);
  });

  it('rejects production tools and load_skill after sealing (PHASE_ORDER_INVALID)', () => {
    const buffer = new ActionBuffer('turn-1');
    buffer.propose(finishInline());
    expect(() => buffer.propose(loadSkill())).toThrowError(
      ACTION_BUFFER_ERROR_CODES.PHASE_ORDER_INVALID,
    );
    expect(buffer.phase).toBe('sealed');
  });

  it('rejects a second dispatch action (PHASE_DISPATCH_DUPLICATE)', () => {
    const buffer = new ActionBuffer('turn-1');
    buffer.propose(finishInline());
    buffer.propose(sendMessageProposal());
    expect(() => buffer.propose(publishPackage()))
      .toThrowError(ACTION_BUFFER_ERROR_CODES.PHASE_DISPATCH_DUPLICATE);
    expect(() => buffer.propose(humanRequest()))
      .toThrowError(ACTION_BUFFER_ERROR_CODES.PHASE_DISPATCH_DUPLICATE);
    expect(buffer.snapshot()).toHaveLength(2);
  });

  it('accepts request_human_input after production-phase work (F7 flipped)', () => {
    const buffer = new ActionBuffer('turn-1');
    buffer.propose(loadSkill());
    buffer.propose(humanRequest());
    expect(buffer.phase).toBe('human_interrupted');
    buffer.succeed('interrupted turn', null);
    expect(buffer.commit()).toEqual([loadSkill(), humanRequest()]);
  });

  it('pins the frozen decision: request_human_input follows seal but never a dispatch (F7)', () => {
    // The direct human interrupt may follow finish_production/annotate_artifact
    // (F7 flipped), but never a dispatch — once the turn dispatches, no further
    // action (including the interrupt) is accepted.
    const accepted = new ActionBuffer('turn-accepted-1');
    accepted.propose(finishInline());
    accepted.propose(humanRequest());
    expect(accepted.phase).toBe('human_interrupted');

    const afterDispatch = new ActionBuffer('turn-with-dispatch');
    afterDispatch.propose(sendMessageProposal());
    expect(() => afterDispatch.propose(humanRequest())).toThrowError(
      ACTION_BUFFER_ERROR_CODES.PHASE_DISPATCH_DUPLICATE,
    );

    // After the interrupt the turn is terminal: every further proposal is
    // rejected, production actions included.
    for (const proposal of [loadSkill(), finishInline(), sendMessageProposal(), humanRequest()]) {
      expect(() => accepted.propose(proposal)).toThrowError(
        ACTION_BUFFER_ERROR_CODES.PHASE_DISPATCH_DUPLICATE,
      );
    }
    accepted.succeed('interrupted turn', null);
    expect(accepted.commit()).toEqual([finishInline(), humanRequest()]);
  });

  it('rejects every action after the direct human interrupt (PHASE_DISPATCH_DUPLICATE)', () => {
    const buffer = new ActionBuffer('turn-1');
    buffer.propose(humanRequest());
    expect(() => buffer.propose(loadSkill()))
      .toThrowError(ACTION_BUFFER_ERROR_CODES.PHASE_DISPATCH_DUPLICATE);
    expect(() => buffer.propose(finishInline()))
      .toThrowError(ACTION_BUFFER_ERROR_CODES.PHASE_DISPATCH_DUPLICATE);
    expect(buffer.snapshot()).toHaveLength(1);
  });

  it('raises typed ActionBufferError instances the tool layer can surface', () => {
    const buffer = new ActionBuffer('turn-1');
    try {
      buffer.propose(publishPackage());
      expect.unreachable('dispatch before finish must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ActionBufferError);
      expect((error as ActionBufferError).code)
        .toBe(ACTION_BUFFER_ERROR_CODES.PHASE_PUBLISH_WITHOUT_FINISH_INVALID);
    }
  });

  it('still allows sealing with an incomplete phase (the committer owns completeness)', () => {
    const buffer = new ActionBuffer('turn-1');
    buffer.propose(loadSkill());
    buffer.succeed('narration only', null);
    expect(buffer.state).toBe('successful');
    expect(buffer.commit()).toHaveLength(1);
  });
});

describe('ActionBuffer failure path', () => {
  it('fail clears proposals and records the cause', () => {
    const buffer = new ActionBuffer('turn-1');
    buffer.propose(finishInline());
    const cause = new Error('provider disconnected');
    buffer.fail(cause);
    expect(buffer.state).toBe('failed');
    expect(buffer.snapshot()).toEqual([]);
    expect(buffer.failureCause).toBe(cause);
    expect(() => buffer.commit()).toThrowError('TURN_NOT_SUCCESSFUL');
  });

  it('treats an abort exactly like a failure', () => {
    const buffer = new ActionBuffer('turn-1');
    buffer.propose(finishInline());
    buffer.fail(new RuntimeAbortedError());
    expect(buffer.state).toBe('failed');
    expect(() => buffer.commit()).toThrowError('TURN_NOT_SUCCESSFUL');
  });

  it('re-failing keeps the first cause (idempotent)', () => {
    const buffer = new ActionBuffer('turn-1');
    const first = RuntimeFailure.transient('ETIMEDOUT', 'upstream timed out');
    buffer.fail(first);
    buffer.fail(RuntimeFailure.permanent('MODEL_NOT_FOUND', 'unknown model'));
    expect(buffer.failureCause).toBe(first);
  });

  it('allows failure after seal but before commit (late abort)', () => {
    const buffer = new ActionBuffer('turn-1');
    buffer.propose(finishInline());
    buffer.propose(sendMessageProposal());
    buffer.succeed('text', null);
    buffer.fail(new RuntimeAbortedError());
    expect(buffer.state).toBe('failed');
    expect(buffer.snapshot()).toEqual([]);
    expect(() => buffer.commit()).toThrowError('TURN_NOT_SUCCESSFUL');
  });
});

describe('ActionBuffer structured dispatch guard (Task 14, design §11.3)', () => {
  it('beforePropose rejects a send before the slot candidate; nothing is buffered', () => {
    const guard = (action: ForgeAction): ActionBufferError | null =>
      action.type === 'send_message'
        ? new ActionBufferError(
            ACTION_BUFFER_ERROR_CODES.STRUCTURE_ACTION_NOT_ALLOWED,
            'a structured session may only end in send_message after a candidate is formed',
          )
        : null;
    const buffer = new ActionBuffer('turn-structured-1', { beforePropose: guard });
    expect(() => buffer.propose(sendMessageProposal())).toThrowError(
      ACTION_BUFFER_ERROR_CODES.STRUCTURE_ACTION_NOT_ALLOWED,
    );
    expect(buffer.snapshot()).toEqual([]);
  });

  it('beforePropose permits send once the candidate guard accepts it', () => {
    let candidateFormed = false;
    const guard = (action: ForgeAction): ActionBufferError | null => {
      if (action.type === 'send_message' && !candidateFormed) {
        return new ActionBufferError(
          ACTION_BUFFER_ERROR_CODES.STRUCTURE_ACTION_NOT_ALLOWED,
          'no candidate yet',
        );
      }
      return null;
    };
    const buffer = new ActionBuffer('turn-structured-2', { beforePropose: guard });
    expect(() => buffer.propose(sendMessageProposal())).toThrowError(
      ACTION_BUFFER_ERROR_CODES.STRUCTURE_ACTION_NOT_ALLOWED,
    );
    candidateFormed = true;
    buffer.propose(sendMessageProposal());
    expect(buffer.snapshot()).toEqual([sendMessageProposal()]);
  });

  it('the human interrupt stays available even when the guard rejects dispatch', () => {
    const guard = (action: ForgeAction): ActionBufferError | null =>
      action.type === 'send_message'
        ? new ActionBufferError(ACTION_BUFFER_ERROR_CODES.STRUCTURE_ACTION_NOT_ALLOWED, 'no candidate')
        : null;
    const buffer = new ActionBuffer('turn-structured-3', { beforePropose: guard });
    buffer.propose(humanRequest());
    expect(buffer.phase).toBe('human_interrupted');
    buffer.succeed('interrupted', null);
    expect(buffer.commit()).toEqual([humanRequest()]);
  });

  it('a buffer without the guard behaves byte-for-byte (send dispatches directly)', () => {
    const buffer = new ActionBuffer('turn-structured-4');
    buffer.propose(sendMessageProposal());
    expect(buffer.phase).toBe('dispatched');
  });
});

describe('ActionBuffer illegal transitions', () => {
  it('commit on an open buffer is TURN_NOT_SUCCESSFUL', () => {
    const buffer = new ActionBuffer('turn-1');
    buffer.propose(finishInline());
    expect(() => buffer.commit()).toThrowError('TURN_NOT_SUCCESSFUL');
    expect(buffer.state).toBe('open');
  });

  it('rejects proposals once sealed, failed or committed (BUFFER_NOT_OPEN / COMMITTED_ALREADY)', () => {
    const sealed = new ActionBuffer('turn-1');
    sealed.succeed('text', null);
    expect(() => sealed.propose(finishInline()))
      .toThrowError(ACTION_BUFFER_ERROR_CODES.BUFFER_NOT_OPEN);

    const failed = new ActionBuffer('turn-2');
    failed.fail(new Error('boom'));
    expect(() => failed.propose(finishInline())).toThrowError('BUFFER_NOT_OPEN');

    const committed = new ActionBuffer('turn-3');
    committed.succeed('text', null);
    committed.commit();
    expect(() => committed.propose(finishInline())).toThrowError('COMMITTED_ALREADY');
  });

  it('rejects succeed after failure or double commit states', () => {
    const failed = new ActionBuffer('turn-1');
    failed.fail(new Error('boom'));
    expect(() => failed.succeed('text', null)).toThrowError('BUFFER_NOT_OPEN');

    const sealedTwice = new ActionBuffer('turn-2');
    sealedTwice.succeed('text', null);
    expect(() => sealedTwice.succeed('other', null)).toThrowError('BUFFER_NOT_OPEN');

    const committed = new ActionBuffer('turn-3');
    committed.succeed('text', null);
    committed.commit();
    expect(() => committed.succeed('text', null)).toThrowError('COMMITTED_ALREADY');
    expect(() => committed.fail(new Error('late'))).toThrowError('COMMITTED_ALREADY');
  });
});
