// @vitest-environment node
/**
 * Structured slot state projection tests (Task 7 Step 6, design §18.3).
 *
 * `projectStructuredSlotState` folds active scaffold/generation/content
 * revision, Draft lifecycle, Attempt status and Seal status ONLY from validated
 * TaskEvents. It takes no checkpoint input at all — a checkpoint can never
 * override the event history because the projection is a pure function of the
 * committed event list.
 */
import { describe, expect, it } from 'vitest';
import { makeTaskEvent } from '../test-support';
import type { StructuredBlobRefV1 } from '../../shared/structured-slots';
import type { TaskEvent } from './task-events';
import {
  projectStructuredSlotState,
} from './structured-slot-state';

type GenerationEvent = Extract<TaskEvent, { type: 'structured_scaffold_generation_committed' }>;

function genRef(kind: StructuredBlobRefV1['kind'] = 'generation', seed = 'a'): StructuredBlobRefV1 {
  return { version: 1, kind, sha256: seed.repeat(64), byteLength: 4 };
}

function generationEvent(overrides: Record<string, unknown> = {}): GenerationEvent {
  return makeTaskEvent({
    type: 'structured_scaffold_generation_committed',
    scaffoldId: 'scaffold-1',
    generationId: 'gen-1',
    supersedesGenerationId: null,
    rootSlotId: 'root',
    slotCount: 2,
    maxDepth: 1,
    structure: genRef('generation'),
    content: genRef('content_revision'),
    contentRevision: 0,
    proposalId: 'prop-1',
    ...overrides,
  }) as GenerationEvent;
}

function openedEvent(draftId = 'draft-1', turnId = 'turn-1') {
  return makeTaskEvent({
    type: 'structured_fill_draft_opened',
    draftId,
    turnId,
    scaffoldId: 'scaffold-1',
    generationId: 'gen-1',
    baseRevision: 0,
  });
}

function terminalEvent(draftId = 'draft-1', turnId = 'turn-1', status: 'merged' | 'stale' | 'abandoned' = 'merged') {
  return makeTaskEvent({
    type: 'structured_fill_draft_terminal',
    draftId,
    turnId,
    status,
    baseRevision: 0,
    resultRevision: 2,
    changeCount: 3,
    content: status === 'merged' ? genRef('content_revision', 'c') : null,
  });
}

describe('projectStructuredSlotState', () => {
  it('starts from an empty structured state with no scaffold or seal', () => {
    const state = projectStructuredSlotState([]);
    expect(state).toEqual({
      version: 1,
      mode: 'structured_slots',
      scaffoldId: null,
      generationId: null,
      contentRevision: null,
      structureStatus: 'none',
      sealStatus: 'unsealed',
      structure: null,
      content: null,
      drafts: {},
      attempts: {},
    });
  });

  it('folds a committed generation into the active scaffold', () => {
    const gen = generationEvent();
    const state = projectStructuredSlotState([gen]);
    expect(state.scaffoldId).toBe('scaffold-1');
    expect(state.generationId).toBe('gen-1');
    expect(state.contentRevision).toBe(0);
    expect(state.structureStatus).toBe('active');
    expect(state.sealStatus).toBe('unsealed');
    expect(state.structure).toEqual(gen.structure);
    expect(state.content).toEqual(gen.content);
  });

  it('lets a superseding generation become active', () => {
    const gen1 = generationEvent();
    const gen2 = generationEvent({ generationId: 'gen-2', supersedesGenerationId: 'gen-1', proposalId: 'prop-2' });
    const state = projectStructuredSlotState([gen1, gen2]);
    expect(state.generationId).toBe('gen-2');
    expect(state.scaffoldId).toBe('scaffold-1');
  });

  it('folds Draft lifecycle from opened and terminal events', () => {
    const opened = openedEvent();
    const merged = terminalEvent();
    const state = projectStructuredSlotState([generationEvent(), opened, merged]);
    expect(state.drafts['draft-1']).toEqual({
      status: 'merged',
      turnId: 'turn-1',
      scaffoldId: 'scaffold-1',
      generationId: 'gen-1',
      baseRevision: 0,
      resultRevision: 2,
      changeCount: 3,
    });
    // Merging advances the active content revision to the terminal result.
    expect(state.contentRevision).toBe(2);

    // A draft that stays open is recorded as open.
    const openState = projectStructuredSlotState([generationEvent(), opened]);
    expect(openState.drafts['draft-1'].status).toBe('open');
    expect(openState.drafts['draft-1'].resultRevision).toBeNull();

    // An abandoned draft never advances the content revision.
    const abandonedState = projectStructuredSlotState([generationEvent(), opened, terminalEvent(undefined, undefined, 'abandoned')]);
    expect(abandonedState.drafts['draft-1'].status).toBe('abandoned');
    expect(abandonedState.contentRevision).toBe(0);
  });

  it('folds Seal status once a scaffold is sealed', () => {
    const sealed = makeTaskEvent({
      type: 'structured_scaffold_sealed',
      sealId: 'seal-1',
      scaffoldId: 'scaffold-1',
      generationId: 'gen-1',
      scaffoldRevision: 0,
      sealRecord: genRef('seal_record', 'e'),
      artifactId: 'artifact-1',
      artifactVersion: 1,
    });
    const state = projectStructuredSlotState([generationEvent(), sealed]);
    expect(state.sealStatus).toBe('sealed');
  });

  it('folds per-attempt status from started and terminal events', () => {
    const started = makeTaskEvent({
      type: 'structured_slot_attempt_started',
      inputNodeId: 'in-1',
      agentId: 'agent-a',
      attemptEpoch: 1,
      turnId: 'turn-9',
      sessionKind: 'fill',
    });
    const running = projectStructuredSlotState([started]);
    expect(running.attempts['turn-9']).toEqual({
      status: 'running',
      sessionKind: 'fill',
      inputNodeId: 'in-1',
      attemptEpoch: 1,
      agentId: 'agent-a',
      reason: null,
    });

    const terminal = makeTaskEvent({
      type: 'structured_slot_attempt_terminal',
      inputNodeId: 'in-1',
      attemptEpoch: 1,
      turnId: 'turn-9',
      status: 'committed',
      reason: 'completion_dispatch',
    });
    const done = projectStructuredSlotState([started, terminal]);
    expect(done.attempts['turn-9'].status).toBe('committed');
    expect(done.attempts['turn-9'].reason).toBe('completion_dispatch');
    expect(done.attempts['turn-9'].sessionKind).toBe('fill');
  });

  it('is a deterministic pure fold that ignores non-structured events', () => {
    const events = [
      makeTaskEvent({ type: 'task_started' }),
      makeTaskEvent({ type: 'route_executed', route: { sequence: 1, fromNodeId: 'a', toNodeId: 'b', kind: 'message', label: 'r' } }),
      generationEvent(),
      openedEvent(),
    ];
    const first = projectStructuredSlotState(events);
    const second = projectStructuredSlotState(events);
    expect(first).toEqual(second);
    expect(first.generationId).toBe('gen-1');
    // A checkpoint never overrides event history: there is no checkpoint
    // input to this function, so the projection is identical every replay.
  });
});
