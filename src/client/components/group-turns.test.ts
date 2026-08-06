import { describe, expect, it } from 'vitest';
import type { NodeKind, WorkspaceNode } from '../../shared/contracts';
import { workspaceWithReturnLoop } from '../test-support';
import { groupTurns } from './group-turns';

function node(
  partial: Partial<WorkspaceNode> & {
    id: string;
    sequence: number;
    agentId: string;
    kind: NodeKind;
  },
): WorkspaceNode {
  return {
    title: partial.kind,
    body: `${partial.id}-body`,
    status: 'confirmed',
    attemptCount: 1,
    inputVersion: null,
    turnId: null,
    ...partial,
  };
}

describe('groupTurns', () => {
  it('merges each input/result pair of the return loop into one group per turn', () => {
    const { groups, looseNodes } = groupTurns(workspaceWithReturnLoop().nodes);
    expect(looseNodes).toHaveLength(0);
    expect(groups).toHaveLength(4);
    expect(groups.map((group) => group.row)).toEqual([2, 4, 6, 8]);
    expect(groups.map((group) => group.input?.id)).toEqual([
      'rl-writer-input-1',
      'rl-reviewer-input-1',
      'rl-writer-input-2',
      'rl-reviewer-input-2',
    ]);
    expect(groups.map((group) => group.result?.id)).toEqual([
      'rl-writer-result-1',
      'rl-reviewer-result-1',
      'rl-writer-result-2',
      'rl-reviewer-result-2',
    ]);
    expect(groups.every((group) => group.status === 'confirmed')).toBe(true);
    expect(groups.every((group) => group.skills.length === 0)).toBe(true);
  });

  it('keeps human_request/human_answer nodes loose instead of merging them', () => {
    const nodes: WorkspaceNode[] = [
      node({ id: 'n-input', sequence: 1, agentId: 'a', kind: 'input' }),
      node({ id: 'n-request', sequence: 2, agentId: 'a', kind: 'human_request' }),
      node({ id: 'n-answer', sequence: 3, agentId: 'a', kind: 'human_answer' }),
      node({ id: 'n-result', sequence: 4, agentId: 'a', kind: 'result', turnId: 't-1' }),
    ];
    const { groups, looseNodes } = groupTurns(nodes);
    expect(looseNodes.map((item) => item.id)).toEqual(['n-request', 'n-answer']);
    expect(groups).toHaveLength(1);
    expect(groups[0].input?.id).toBe('n-input');
    expect(groups[0].result?.id).toBe('n-result');
  });

  it('turns a trailing input without a result into its own active group on the input row', () => {
    const nodes: WorkspaceNode[] = [
      node({ id: 'n-input', sequence: 1, agentId: 'a', kind: 'input' }),
      node({ id: 'n-result', sequence: 2, agentId: 'a', kind: 'result', turnId: 't-1' }),
      node({ id: 'n-next', sequence: 3, agentId: 'a', kind: 'input', status: 'active' }),
    ];
    const { groups } = groupTurns(nodes);
    expect(groups).toHaveLength(2);
    const pending = groups[1];
    expect(pending.input?.id).toBe('n-next');
    expect(pending.result).toBeUndefined();
    expect(pending.row).toBe(3);
    expect(pending.status).toBe('active');
  });

  it('keeps the failed status of a stranded input group', () => {
    const nodes: WorkspaceNode[] = [
      node({ id: 'n-input', sequence: 1, agentId: 'a', kind: 'input', status: 'failed' }),
    ];
    const { groups } = groupTurns(nodes);
    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe('failed');
    expect(groups[0].row).toBe(1);
  });

  it('attributes a skill to the result group carrying the same turn id', () => {
    const nodes: WorkspaceNode[] = [
      node({ id: 'n-input', sequence: 1, agentId: 'a', kind: 'input' }),
      node({ id: 'n-skill', sequence: 2, agentId: 'a', kind: 'skill', turnId: 't-1' }),
      node({ id: 'n-result', sequence: 3, agentId: 'a', kind: 'result', turnId: 't-1' }),
    ];
    const { groups } = groupTurns(nodes);
    expect(groups).toHaveLength(1);
    expect(groups[0].skills.map((skill) => skill.id)).toEqual(['n-skill']);
  });

  it('attaches an unattributed skill to the nearest same-agent group', () => {
    const nodes: WorkspaceNode[] = [
      node({ id: 'n-input-1', sequence: 1, agentId: 'a', kind: 'input' }),
      // turnId null (mock demos load the skill before the first result).
      node({ id: 'n-skill', sequence: 2, agentId: 'a', kind: 'skill' }),
      node({ id: 'n-result-1', sequence: 3, agentId: 'a', kind: 'result', turnId: 't-1' }),
      node({ id: 'n-input-2', sequence: 7, agentId: 'a', kind: 'input' }),
      node({ id: 'n-result-2', sequence: 8, agentId: 'a', kind: 'result', turnId: 't-2' }),
      // Dangling turn id that matches no result: nearest group wins too.
      node({ id: 'n-skill-late', sequence: 9, agentId: 'a', kind: 'skill', turnId: 't-missing' }),
    ];
    const { groups } = groupTurns(nodes);
    expect(groups).toHaveLength(2);
    expect(groups[0].skills.map((skill) => skill.id)).toEqual(['n-skill']);
    expect(groups[1].skills.map((skill) => skill.id)).toEqual(['n-skill-late']);
  });

  it('gives a skill its own chip group when its agent has no turn group', () => {
    const nodes: WorkspaceNode[] = [
      node({ id: 'n-skill', sequence: 1, agentId: 'a', kind: 'skill' }),
    ];
    const { groups } = groupTurns(nodes);
    expect(groups).toHaveLength(1);
    expect(groups[0].agentId).toBe('a');
    expect(groups[0].row).toBe(1);
    expect(groups[0].input).toBeUndefined();
    expect(groups[0].result).toBeUndefined();
    expect(groups[0].skills.map((skill) => skill.id)).toEqual(['n-skill']);
    expect(groups[0].status).toBe('confirmed');
  });

  it('never lets a later result steal the input claimed by an earlier result', () => {
    const nodes: WorkspaceNode[] = [
      node({ id: 'n-input', sequence: 1, agentId: 'a', kind: 'input' }),
      node({ id: 'n-result-1', sequence: 2, agentId: 'a', kind: 'result', turnId: 't-1' }),
      node({ id: 'n-result-2', sequence: 3, agentId: 'a', kind: 'result', turnId: 't-2' }),
    ];
    const { groups } = groupTurns(nodes);
    expect(groups).toHaveLength(2);
    expect(groups[0].input?.id).toBe('n-input');
    expect(groups[1].input).toBeUndefined();
  });

  it('sorts by sequence even when the input order is scrambled', () => {
    const nodes: WorkspaceNode[] = [
      node({ id: 'n-result', sequence: 2, agentId: 'a', kind: 'result', turnId: 't-1' }),
      node({ id: 'n-input', sequence: 1, agentId: 'a', kind: 'input' }),
    ];
    const { groups } = groupTurns(nodes);
    expect(groups).toHaveLength(1);
    expect(groups[0].input?.id).toBe('n-input');
    expect(groups[0].result?.id).toBe('n-result');
  });

  it('does not mutate its input array', () => {
    const original = workspaceWithReturnLoop().nodes;
    const snapshot = original.map((item) => ({ ...item }));
    groupTurns(original);
    expect(original).toEqual(snapshot);
  });
});
