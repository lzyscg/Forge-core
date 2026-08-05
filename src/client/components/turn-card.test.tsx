import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSummary, LiveTurn, WorkspaceNode } from '../../shared/contracts';
import type { TurnGroup } from './group-turns';
import { TurnCard } from './turn-card';

const AGENT: AgentSummary = {
  id: 'agent-a',
  name: '写作 Agent',
  description: '测试用 Agent。',
  model: 'test/model',
  skills: [
    { id: 'skill-rhyme', name: '押韵技巧', description: '押韵技能。' },
  ],
};

function member(partial: Partial<WorkspaceNode> & Pick<WorkspaceNode, 'id' | 'kind'>): WorkspaceNode {
  return {
    sequence: 1,
    agentId: 'agent-a',
    title: partial.kind,
    body: `${partial.id}-body`,
    status: 'confirmed',
    attemptCount: 1,
    artifactVersion: null,
    turnId: null,
    ...partial,
  };
}

function fullGroup(): TurnGroup {
  return {
    key: 'turn-r1',
    agentId: 'agent-a',
    row: 2,
    input: member({ id: 'i1', kind: 'input', sequence: 1 }),
    result: member({
      id: 'r1',
      kind: 'result',
      sequence: 2,
      turnId: 't1',
      attemptCount: 2,
      artifactVersion: 1,
    }),
    skills: [member({ id: 's1', kind: 'skill', sequence: 2, turnId: 't1', title: 'skill-rhyme' })],
    status: 'confirmed',
  };
}

function renderCard(props: Partial<ComponentProps<typeof TurnCard>> = {}) {
  const defaultProps: ComponentProps<typeof TurnCard> = {
    group: fullGroup(),
    agent: AGENT,
    row: 2,
    selectedNodeId: null,
    highlightedNodeId: null,
    expanded: false,
    onSelectNode: () => {},
    onToggleExpand: () => {},
  };
  return render(<TurnCard {...defaultProps} {...props} />);
}

function shellOf(nodeId: string): HTMLElement {
  const anchor = document.getElementById(`node-${nodeId}`);
  if (!anchor) throw new Error(`anchor node-${nodeId} missing`);
  const shell = anchor.closest('[data-testid="workspace-turn"]');
  if (!shell) throw new Error(`anchor node-${nodeId} has no turn shell`);
  return shell as HTMLElement;
}

describe('TurnCard DOM contract', () => {
  it('renders the shell with status class and grid row, but no node identity', () => {
    renderCard();
    const shell = screen.getByTestId('workspace-turn');
    expect(shell.className).toContain('fc-turn');
    expect(shell.className).toContain('fc-turn--confirmed');
    expect(shell.style.gridRow).toBe('2');
    // The shell itself must never carry node identity: anchors own it.
    expect(shell.id).toBe('');
    expect(shell.getAttribute('data-testid')).toBe('workspace-turn');
  });

  it('renders one hidden measurable anchor per member node inside the shell', () => {
    renderCard();
    const anchors = screen.getAllByTestId('workspace-node');
    expect(anchors).toHaveLength(3);
    for (const id of ['i1', 'r1', 's1']) {
      const anchor = document.getElementById(`node-${id}`);
      expect(anchor).not.toBeNull();
      expect(anchor!.tagName).toBe('SPAN');
      expect(anchor!.className).toBe('fc-turn__anchor');
      expect(anchor!.getAttribute('aria-hidden')).toBe('true');
      expect(shellOf(id)).toBe(screen.getByTestId('workspace-turn'));
    }
  });

  it('reflects the group status in the shell class', () => {
    renderCard({ group: { ...fullGroup(), status: 'active' } });
    expect(screen.getByTestId('workspace-turn').className).toContain('fc-turn--active');
  });
});

describe('TurnCard summary', () => {
  it('shows agent name, status chip text, attempt count and artifact version', () => {
    renderCard();
    const shell = screen.getByTestId('workspace-turn');
    expect(within(shell).getByText('写作 Agent')).toBeVisible();
    expect(within(shell).getByText('已确认')).toBeVisible();
    expect(within(shell).getByText('尝试 2 次')).toBeVisible();
    expect(within(shell).getByText('产物 V1')).toBeVisible();
    // Status never relies on color alone: the chip dot is decorative.
    expect(shell.querySelector('.fc-status-chip__dot[aria-hidden="true"]')).not.toBeNull();
  });

  it('hides attempt count and version when they carry no information', () => {
    const group = fullGroup();
    group.result = member({ id: 'r1', kind: 'result', sequence: 2, turnId: 't1' });
    renderCard({ group });
    const shell = screen.getByTestId('workspace-turn');
    expect(within(shell).queryByText(/尝试/)).toBeNull();
    expect(within(shell).queryByText(/产物 V/)).toBeNull();
  });

  it('renders skill chips labelled 技能:<name> using the agent skill name', () => {
    renderCard();
    expect(screen.getByRole('button', { name: '技能:押韵技巧' })).toBeVisible();
  });

  it('falls back to the skill id when the agent declares no matching skill', () => {
    const group = fullGroup();
    group.skills = [member({ id: 's1', kind: 'skill', title: 'unknown-skill', turnId: 't1' })];
    renderCard({ group, agent: { ...AGENT, skills: [] } });
    expect(screen.getByRole('button', { name: '技能:unknown-skill' })).toBeVisible();
  });
});

describe('TurnCard interactions', () => {
  it('routes [输入] to the input node and [运行过程] to the result node', async () => {
    const onSelectNode = vi.fn();
    renderCard({ onSelectNode });
    await userEvent.click(screen.getByRole('button', { name: '输入' }));
    expect(onSelectNode).toHaveBeenLastCalledWith('i1');
    await userEvent.click(screen.getByRole('button', { name: '运行过程' }));
    expect(onSelectNode).toHaveBeenLastCalledWith('r1');
  });

  it('routes the skill chip to the skill node', async () => {
    const onSelectNode = vi.fn();
    renderCard({ onSelectNode });
    await userEvent.click(screen.getByRole('button', { name: '技能:押韵技巧' }));
    expect(onSelectNode).toHaveBeenCalledWith('s1');
  });

  it('opens the default dialog when the card body is clicked (result first)', async () => {
    const onSelectNode = vi.fn();
    renderCard({ onSelectNode });
    await userEvent.click(within(screen.getByTestId('workspace-turn')).getByText('写作 Agent'));
    expect(onSelectNode).toHaveBeenCalledTimes(1);
    expect(onSelectNode).toHaveBeenCalledWith('r1');
  });

  it('falls back to the input node for result-less cards clicked on the body', async () => {
    const onSelectNode = vi.fn();
    const group = fullGroup();
    renderCard({
      group: { ...group, key: 'turn-i1', result: undefined, status: 'active', row: 1 },
      onSelectNode,
    });
    expect(screen.queryByRole('button', { name: '运行过程' })).toBeNull();
    await userEvent.click(screen.getByText('写作 Agent'));
    expect(onSelectNode).toHaveBeenCalledWith('i1');
  });

  it('does not fire the whole-card default when a button inside was clicked', async () => {
    const onSelectNode = vi.fn();
    renderCard({ onSelectNode });
    await userEvent.click(screen.getByRole('button', { name: '输入' }));
    expect(onSelectNode).toHaveBeenCalledTimes(1);
    expect(onSelectNode).toHaveBeenCalledWith('i1');
  });
});

describe('TurnCard expand/collapse', () => {
  it('starts collapsed: member bodies are not rendered', () => {
    renderCard();
    expect(screen.queryByText('i1-body')).toBeNull();
    expect(screen.queryByText('r1-body')).toBeNull();
  });

  it('shows member bodies when expanded', () => {
    renderCard({ expanded: true });
    expect(screen.getByText('i1-body')).toBeVisible();
    expect(screen.getByText('r1-body')).toBeVisible();
  });

  it('toggles through the expand button with aria-expanded state', async () => {
    const onToggleExpand = vi.fn();
    const { rerender } = renderCard({ onToggleExpand });
    const toggle = screen.getByRole('button', { name: '展开' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(onToggleExpand).toHaveBeenCalledWith('turn-r1');

    rerender(
      <TurnCard
        group={fullGroup()}
        agent={AGENT}
        row={2}
        selectedNodeId={null}
        highlightedNodeId={null}
        expanded
        onSelectNode={() => {}}
        onToggleExpand={onToggleExpand}
      />,
    );
    const collapse = screen.getByRole('button', { name: '收起' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps anchors mounted and measurable while collapsed', () => {
    renderCard();
    const anchor = document.getElementById('node-r1')!;
    // Not display:none: the anchor stays in the measurable layout.
    expect(anchor).not.toHaveStyle({ display: 'none' });
  });
});

describe('TurnCard selection / highlight', () => {
  it('marks the shell selected when any member node is selected', () => {
    renderCard({ selectedNodeId: 's1' });
    expect(screen.getByTestId('workspace-turn').className).toContain('fc-node--selected');
  });

  it('marks the shell highlighted when any member node is highlighted', () => {
    renderCard({ highlightedNodeId: 'r1' });
    expect(screen.getByTestId('workspace-turn').className).toContain('fc-node--highlighted');
  });

  it('stays neutral for unrelated node ids', () => {
    renderCard({ selectedNodeId: 'other', highlightedNodeId: 'another' });
    const shell = screen.getByTestId('workspace-turn');
    expect(shell.className).not.toContain('fc-node--selected');
    expect(shell.className).not.toContain('fc-node--highlighted');
  });
});

describe('TurnCard live stream preview (plan C realtime streaming)', () => {
  const LIVE_TURN: LiveTurn = {
    agentId: 'agent-a',
    turnId: 'turn-live',
    status: 'running',
    text: '正在逐字输出的正文',
    thinking: '正在思考的内容',
    tools: [
      { name: 'load_skill', state: 'done' },
      { name: 'finish_production', state: 'running' },
    ],
    updatedAt: '2026-08-05T00:00:00.000Z',
  };

  function activeGroup(): TurnGroup {
    return {
      key: 'turn-i1',
      agentId: 'agent-a',
      row: 1,
      input: member({ id: 'i1', kind: 'input', sequence: 1, status: 'active' }),
      skills: [],
      status: 'active',
    };
  }

  it('renders the streaming preview on an active card with a live turn', () => {
    renderCard({ group: activeGroup(), activeTurn: LIVE_TURN });
    const stream = document.querySelector('.fc-turn__stream');
    expect(stream).not.toBeNull();
    const scope = within(stream as HTMLElement);
    // Public text streams pre-wrap; thinking stays collapsible (collapsed by
    // default) small text.
    expect(scope.getByText('正在逐字输出的正文')).toBeVisible();
    const thinking = scope.getByText('正在思考的内容');
    expect(thinking).toBeInTheDocument();
    const details = stream!.querySelector('details.fc-turn__stream-thinking');
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);
    // Tool calls list running/done state by name.
    const runningTool = stream!.querySelector('.fc-turn__stream-tool--running');
    const doneTool = stream!.querySelector('.fc-turn__stream-tool--done');
    expect(runningTool?.textContent).toContain('finish_production');
    expect(doneTool?.textContent).toContain('load_skill');
  });

  it('shows a running placeholder while the buffer is still empty', () => {
    renderCard({
      group: activeGroup(),
      activeTurn: { ...LIVE_TURN, text: '', thinking: '', tools: [] },
    });
    const stream = document.querySelector('.fc-turn__stream');
    expect(stream).not.toBeNull();
    expect(stream!.textContent).toContain('运行中');
  });

  it('does not render the preview for confirmed cards', () => {
    renderCard({ activeTurn: LIVE_TURN });
    expect(document.querySelector('.fc-turn__stream')).toBeNull();
  });

  it('does not render the preview without a live turn', () => {
    renderCard({ group: activeGroup(), activeTurn: null });
    expect(document.querySelector('.fc-turn__stream')).toBeNull();
  });

  it('ignores a live turn belonging to another agent', () => {
    renderCard({
      group: activeGroup(),
      activeTurn: { ...LIVE_TURN, agentId: 'agent-other' },
    });
    expect(document.querySelector('.fc-turn__stream')).toBeNull();
  });
});
