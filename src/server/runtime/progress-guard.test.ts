/**
 * No-progress guard evaluation tests (plan 2026-08-06).
 *
 * The guard counts committed Turns (`agent_result` events) inside the window
 * that opens after the LAST `human_answered` event (the whole history when
 * none exists). A human answer resets the counter; failures, retries and
 * lifecycle events never count. An unanswered `human_requested` inside the
 * window is reported so the scheduler loop never runs a Turn while a
 * question is pending.
 */
import { describe, expect, it } from 'vitest';
import type { TaskEvent } from '../storage/task-events';
import { makeEventNode, makeTaskEvent } from '../test-support';
import { evaluateProgress, PROGRESS_POLICY } from './progress-guard';

function agentResult(agentId: string): TaskEvent {
  return makeTaskEvent({
    type: 'agent_result',
    node: makeEventNode({ agentId, kind: 'result', title: '结果节点', body: '公开结果' }),
  });
}

function humanRequested(agentId: string): TaskEvent {
  return makeTaskEvent({
    type: 'human_requested',
    node: makeEventNode({ agentId, kind: 'human_request', title: '人工请求', body: '问题' }),
    question: '问题',
  });
}

function humanAnswered(agentId: string): TaskEvent {
  return makeTaskEvent({
    type: 'human_answered',
    node: makeEventNode({ agentId, kind: 'human_answer', title: '人工回答', body: '回答' }),
    answer: '回答',
  });
}

const SMALL_POLICY = { maxTurnsSinceHumanAnswer: 2 } as const;

describe('evaluateProgress', () => {
  it('reports an empty history as far under the limit with no dispatcher', () => {
    const evaluation = evaluateProgress([]);
    expect(evaluation).toEqual({
      exceeded: false,
      turnCount: 0,
      limit: PROGRESS_POLICY.maxTurnsSinceHumanAnswer,
      lastDispatchAgentId: null,
      hasUnansweredHumanRequest: false,
    });
  });

  it('counts committed turns in the window and stays under the limit', () => {
    const events = [agentResult('agent-a'), agentResult('agent-b')];
    const evaluation = evaluateProgress(events);
    expect(evaluation.turnCount).toBe(2);
    expect(evaluation.exceeded).toBe(false);
  });

  it('boundary: exactly at the limit is not exceeded, one over is', () => {
    const atLimit = [agentResult('agent-a'), agentResult('agent-b')];
    expect(evaluateProgress(atLimit, SMALL_POLICY).exceeded).toBe(false);
    const overLimit = [...atLimit, agentResult('agent-a')];
    expect(evaluateProgress(overLimit, SMALL_POLICY).exceeded).toBe(true);
  });

  it('resets the window at the LAST human answer', () => {
    const events = [
      agentResult('agent-a'),
      agentResult('agent-a'),
      agentResult('agent-a'), // pre-window turns never count again
      humanAnswered('agent-a'),
      agentResult('agent-b'),
      humanAnswered('agent-b'), // only turns AFTER this answer count
      agentResult('agent-b'),
    ];
    const evaluation = evaluateProgress(events, SMALL_POLICY);
    expect(evaluation.turnCount).toBe(1);
    expect(evaluation.exceeded).toBe(false);
  });

  it('reports the last dispatch agent from the last committed result', () => {
    const events = [agentResult('agent-a'), agentResult('agent-b'), agentResult('agent-a')];
    expect(evaluateProgress(events).lastDispatchAgentId).toBe('agent-a');
  });

  it('reports the last dispatch agent inside the reset window only', () => {
    const events = [agentResult('agent-a'), humanAnswered('agent-a'), agentResult('agent-b')];
    expect(evaluateProgress(events).lastDispatchAgentId).toBe('agent-b');
  });

  it('detects an unanswered human request inside the window', () => {
    const events = [agentResult('agent-a'), humanRequested('agent-a')];
    expect(evaluateProgress(events).hasUnansweredHumanRequest).toBe(true);
  });

  it('treats an answered request as resolved', () => {
    const events = [humanRequested('agent-a'), humanAnswered('agent-a'), agentResult('agent-a')];
    expect(evaluateProgress(events).hasUnansweredHumanRequest).toBe(false);
  });

  it('ignores requests answered before the window', () => {
    const events = [humanRequested('agent-a'), humanAnswered('agent-a'), agentResult('agent-a')];
    const evaluation = evaluateProgress(events);
    expect(evaluation.hasUnansweredHumanRequest).toBe(false);
    expect(evaluation.turnCount).toBe(1);
  });

  it('ignores failures, retries and lifecycle events in the count', () => {
    const events: TaskEvent[] = [
      makeTaskEvent({ type: 'task_started' }),
      makeTaskEvent({
        type: 'agent_attempt_failed',
        nodeId: 'node-1',
        message: '失败',
        retryable: true,
      }),
      makeTaskEvent({ type: 'retry_scheduled', nodeId: 'node-1', delayMs: 1000, attempt: 2 }),
      makeTaskEvent({ type: 'route_executed', route: { sequence: 2, fromNodeId: 'a', toNodeId: 'b', kind: 'message', label: '路由' } }),
      makeTaskEvent({ type: 'artifact_published', artifact: { version: 1, title: '产物', sourceNodeId: 'a', format: 'markdown', files: [{ name: 'content.md', hash: '0'.repeat(64) }], artifactType: null, artifactId: null } }),
      makeTaskEvent({ type: 'skill_loaded', skillId: 'skill-1' }),
      agentResult('agent-a'),
      makeTaskEvent({ type: 'task_stopped' }),
    ];
    const evaluation = evaluateProgress(events);
    expect(evaluation.turnCount).toBe(1);
    expect(evaluation.exceeded).toBe(false);
  });
});
