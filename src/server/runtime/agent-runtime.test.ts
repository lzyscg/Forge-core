// @vitest-environment node
/**
 * Agent runtime contract tests (plan Phase C Task 1 Step 1; updated by plan
 * 2026-08-04 Task 1 for the production/dispatch turn contract).
 *
 * Contains the verbatim plan assertions — the closed registry of exactly six
 * Forge production actions (spec §5, now including `finish_production`) and
 * the all-or-nothing buffer discard on Turn failure — plus the display-only
 * `TurnTrace.phase` contract: an optional phase summary that never changes
 * the existing trace entry union (spec §7.4). Action shape validation moved
 * to `forge-actions.test.ts`. Platform module, zero business vocabulary
 * (iron rule 1).
 */
import { describe, expect, it } from 'vitest';
import type { TraceEntry, TurnTrace, TurnPhaseState, TurnPhaseDispatchAction } from '../../shared/contracts';
import { ActionBuffer } from './action-buffer';
import type { AgentTurnInput, AgentTurnResult } from './agent-runtime';
import {
  FORGE_ACTION_NAME_SET,
  FORGE_ACTION_NAMES,
  type ForgeAction,
} from './forge-actions';
import { fakeUsage, sampleTurnInput, sendMessageProposal } from './test-support';

function finishInline(): ForgeAction {
  return {
    type: 'finish_production',
    source: 'inline',
    content: 'sealed production body',
    format: 'text',
    artifactType: null,
    title: null,
  };
}

describe('Forge runtime contract (plan Phase C Task 1 Step 1)', () => {
  it('exposes exactly six Forge action names including finish_production', () => {
    expect([...FORGE_ACTION_NAMES].sort()).toEqual([
      'finish_production', 'load_skill', 'publish_artifact', 'request_human_input',
      'send_message', 'submit_final_artifact',
    ]);
  });

  it('discards buffered proposals when a Turn fails', () => {
    const buffer = new ActionBuffer('turn-1');
    buffer.propose(finishInline());
    buffer.propose(sendMessageProposal());
    buffer.fail(new Error('provider disconnected'));
    expect(() => buffer.commit()).toThrowError('TURN_NOT_SUCCESSFUL');
    expect(buffer.snapshot()).toEqual([]);
  });

  it('locks membership in a read-only six-name set', () => {
    expect(FORGE_ACTION_NAME_SET.size).toBe(6);
    for (const name of FORGE_ACTION_NAMES) {
      expect(FORGE_ACTION_NAME_SET.has(name)).toBe(true);
    }
    expect(FORGE_ACTION_NAME_SET.has('execute_command' as never)).toBe(false);
  });

  it('sampleTurnInput satisfies the frozen AgentTurnInput shape', () => {
    const input: AgentTurnInput = sampleTurnInput();
    expect(input.agent.id).toBe('agent-alpha');
    expect(input.agent.model).toBe('configured/test-model');
    expect(input.agent.skills.map((skill) => skill.id)).toEqual(['skill-alpha']);
    expect(input.availableSkills.map((skill) => skill.id)).toEqual(['skill-alpha']);
    expect(input.publicHistory.map((entry) => entry.role)).toEqual(['user', 'assistant']);
  });

  it('allows usage to be null in a turn result', () => {
    const result: AgentTurnResult = {
      turnId: 'turn-1',
      publicText: 'neutral result',
      actions: [],
      usage: null,
      trace: [],
    };
    expect(result.usage).toBeNull();
    expect(fakeUsage()).toEqual({ inputTokens: 12, outputTokens: 34 });
  });
});

describe('TurnTrace phase contract (spec §7.4, plan 2026-08-04 Task 1)', () => {
  it('accepts a trace carrying the optional phase summary', () => {
    const entries: TraceEntry[] = [
      { kind: 'thinking', text: 'neutral thinking' },
      { kind: 'tool_call', toolName: 'finish_production', params: { source: 'inline' } },
      { kind: 'tool_result', toolName: 'finish_production', text: 'accepted' },
      { kind: 'text', text: 'neutral narration' },
    ];
    const trace: TurnTrace = {
      turnId: 'turn-1',
      phase: {
        state: 'dispatched',
        dispatchAction: 'send_message',
        target: 'agent-beta',
        message: null,
      },
      entries,
    };
    expect(trace.phase?.state).toBe('dispatched');
    expect(trace.entries).toHaveLength(4);
  });

  it('keeps traces without phase legal (backward compatibility)', () => {
    const trace: TurnTrace = { turnId: 'turn-legacy', entries: [] };
    expect(trace.phase).toBeUndefined();
  });

  it('covers every phase state and dispatch action in the contract unions', () => {
    const states: TurnPhaseState[] = [
      'production', 'production_complete', 'dispatching', 'dispatched', 'waiting_human', 'failed',
    ];
    const actions: Array<TurnPhaseDispatchAction | null> = [
      'send_message', 'publish_artifact', 'submit_final_artifact', 'request_human_input', null,
    ];
    expect(states).toHaveLength(6);
    expect(actions).toHaveLength(5);
  });
});
