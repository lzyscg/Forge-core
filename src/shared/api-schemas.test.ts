// @vitest-environment node
/**
 * Shared API schema tests for the production/dispatch turn contract (plan
 * 2026-08-04 Task 1 Step 1, spec §7.4/§7.5).
 *
 * `turnTraceSchema` gains the optional display-only `phase` summary; traces
 * without it stay legal so historical trace files decode unchanged.
 */
import { describe, expect, it } from 'vitest';
import { Value } from 'typebox/value';
import { taskWorkspaceSchema, turnTraceSchema } from './api-schemas';

describe('turnTraceSchema phase compatibility (spec §7.5)', () => {
  it('accepts a trace without phase (backward compatible)', () => {
    expect(Value.Check(turnTraceSchema, { turnId: 'turn-1', entries: [] })).toBe(true);
  });

  it('accepts a trace carrying the complete phase summary', () => {
    expect(Value.Check(turnTraceSchema, {
      turnId: 'turn-1',
      phase: {
        state: 'dispatched',
        dispatchAction: 'publish_artifact',
        target: 'agent-beta',
        message: null,
      },
      entries: [{ kind: 'text', text: 'neutral' }],
    })).toBe(true);
  });

  it('accepts every declared phase state and nullable fields', () => {
    const states = ['production', 'production_complete', 'dispatching', 'dispatched', 'waiting_human', 'failed'];
    for (const state of states) {
      expect(Value.Check(turnTraceSchema, {
        turnId: 'turn-1',
        phase: { state, dispatchAction: null, target: null, message: null },
        entries: [],
      })).toBe(true);
    }
  });

  it('rejects unknown phase states and dispatch actions', () => {
    expect(Value.Check(turnTraceSchema, {
      turnId: 'turn-1',
      phase: { state: 'exploded', dispatchAction: null, target: null, message: null },
      entries: [],
    })).toBe(false);
    expect(Value.Check(turnTraceSchema, {
      turnId: 'turn-1',
      phase: { state: 'dispatched', dispatchAction: 'load_skill', target: null, message: null },
      entries: [],
    })).toBe(false);
  });
});

/* ------------------- live streaming activeTurn (plan C) ------------------- */

const BASE_TASK = {
  id: 'task-1',
  name: '任务',
  templateId: 'tpl',
  templateName: '模板',
  status: 'running' as const,
  currentAgentName: null,
  latestVersion: null,
  updatedAt: '2026-08-05T00:00:00.000Z',
  diagnostic: null,
};

function baseWorkspace(activeTurn?: unknown): Record<string, unknown> {
  return {
    task: BASE_TASK,
    frozenInput: {},
    templateVersion: 'v1',
    agents: [],
    declaredRoutes: [],
    nodes: [],
    executedRoutes: [],
    artifacts: [],
    pendingHumanQuestion: null,
    ...(activeTurn !== undefined ? { activeTurn } : {}),
  };
}

describe('taskWorkspaceSchema activeTurn (plan C realtime streaming)', () => {
  it('accepts a workspace without activeTurn (backward compatible)', () => {
    expect(Value.Check(taskWorkspaceSchema, baseWorkspace())).toBe(true);
  });

  it('accepts an explicit null activeTurn', () => {
    expect(Value.Check(taskWorkspaceSchema, baseWorkspace(null))).toBe(true);
  });

  it('accepts a full running live turn', () => {
    const workspace = baseWorkspace({
      agentId: 'agent-alpha',
      turnId: 'turn-1',
      status: 'running',
      text: 'streaming text',
      thinking: 'streaming thinking',
      tools: [
        { name: 'load_skill', state: 'done' },
        { name: 'finish_production', state: 'running' },
      ],
      updatedAt: '2026-08-05T00:00:01.000Z',
    });
    expect(Value.Check(taskWorkspaceSchema, workspace)).toBe(true);
  });

  it('rejects a live turn with an invalid status or tool state', () => {
    const badStatus = baseWorkspace({
      agentId: 'a',
      turnId: 't',
      status: 'paused',
      text: '',
      thinking: '',
      tools: [],
      updatedAt: '2026-08-05T00:00:01.000Z',
    });
    expect(Value.Check(taskWorkspaceSchema, badStatus)).toBe(false);
    const badTool = baseWorkspace({
      agentId: 'a',
      turnId: 't',
      status: 'running',
      text: '',
      thinking: '',
      tools: [{ name: 'x', state: 'pending' }],
      updatedAt: '2026-08-05T00:00:01.000Z',
    });
    expect(Value.Check(taskWorkspaceSchema, badTool)).toBe(false);
  });
});
