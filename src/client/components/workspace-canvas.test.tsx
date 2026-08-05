import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskWorkspace, WorkspaceNode } from '../../shared/contracts';
import {
  REVIEWER_AGENT_ID,
  SKILL_CHAPTER_WRITING_ID,
  WRITER_AGENT_ID,
} from '../mock/__fixtures__/zhihu-single-chapter';
import { workspaceWithReturnLoop } from '../test-support';
import { WorkspaceCanvas } from './workspace-canvas';

function renderCanvas(
  workspace: TaskWorkspace,
  props: Partial<ComponentProps<typeof WorkspaceCanvas>> = {},
) {
  return render(
    <WorkspaceCanvas
      workspace={workspace}
      selectedNodeId={null}
      highlightedNodeId={null}
      onSelectNode={() => {}}
      drawerRevision={0}
      {...props}
    />,
  );
}

function extraNode(id: string, sequence: number, status: WorkspaceNode['status'] = 'active'): WorkspaceNode {
  return {
    id,
    sequence,
    agentId: REVIEWER_AGENT_ID,
    kind: 'input',
    title: '追加输入',
    body: 'body',
    status,
    attemptCount: 1,
    artifactVersion: null,
  };
}

function shellOf(nodeId: string): HTMLElement {
  const anchor = document.getElementById(`node-${nodeId}`);
  if (!anchor) throw new Error(`anchor node-${nodeId} missing`);
  const shell = anchor.closest('[data-testid="workspace-turn"]');
  if (!shell) throw new Error(`anchor node-${nodeId} has no turn shell`);
  return shell as HTMLElement;
}

function pushViewportFarFromEdge(viewport: HTMLElement): void {
  Object.defineProperty(viewport, 'scrollHeight', { value: 2400, configurable: true });
  Object.defineProperty(viewport, 'clientHeight', { value: 600, configurable: true });
  Object.defineProperty(viewport, 'scrollWidth', { value: 1600, configurable: true });
  Object.defineProperty(viewport, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(viewport, 'scrollTop', { value: 0, configurable: true });
  Object.defineProperty(viewport, 'scrollLeft', { value: 0, configurable: true });
  fireEvent.scroll(viewport);
}

describe('WorkspaceCanvas', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders one lane per frozen agent in template order with dynamic headings', () => {
    renderCanvas(workspaceWithReturnLoop());
    const writerLane = document.getElementById('lane-writer');
    const reviewerLane = document.getElementById('lane-reviewer');
    expect(writerLane).not.toBeNull();
    expect(reviewerLane).not.toBeNull();

    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual(['章节写作', '章节审核']);
    // Template order: writer lane precedes reviewer lane in the DOM.
    expect(
      writerLane!.compareDocumentPosition(reviewerLane!),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('keeps every node mounted as an anchor; anchors count equals node count', () => {
    renderCanvas(workspaceWithReturnLoop());
    const nodes = screen.getAllByTestId('workspace-node');
    expect(nodes).toHaveLength(8);

    expect(document.getElementById('node-rl-writer-input-1')).not.toBeNull();
    expect(document.getElementById('node-rl-reviewer-result-2')).not.toBeNull();

    // Anchors are hidden spans inside the shell; the shell carries no node id.
    const anchor = document.getElementById('node-rl-writer-input-1')!;
    expect(anchor.tagName).toBe('SPAN');
    expect(anchor.getAttribute('aria-hidden')).toBe('true');
    const shell = shellOf('rl-writer-input-1');
    expect(shell.id).toBe('');
  });

  it('merges input/result pairs into turn cards placed on the result row', () => {
    renderCanvas(workspaceWithReturnLoop());
    const turns = screen.getAllByTestId('workspace-turn');
    expect(turns).toHaveLength(4);

    // Group rows follow the result sequence mapped onto the shared grid rows.
    expect(shellOf('rl-writer-input-1').style.gridRow).toBe('2');
    expect(shellOf('rl-reviewer-result-1').style.gridRow).toBe('4');
    expect(shellOf('rl-writer-result-2').style.gridRow).toBe('6');
    expect(shellOf('rl-reviewer-result-2').style.gridRow).toBe('8');
    // Input and result of one turn share the same shell.
    expect(shellOf('rl-writer-input-1')).toBe(shellOf('rl-writer-result-1'));
  });

  it('labels turn status with text and chip marker, never color alone', () => {
    const ws = workspaceWithReturnLoop();
    const withStates: TaskWorkspace = {
      ...ws,
      nodes: [
        ...ws.nodes.map((node) =>
          node.id === 'rl-writer-result-1' ? { ...node, status: 'failed' as const } : node,
        ),
        extraNode('rl-active-node', 9, 'active'),
      ],
    };
    renderCanvas(withStates);

    const failed = shellOf('rl-writer-result-1');
    expect(within(failed).getByText('失败')).toBeVisible();
    expect(failed.className).toContain('fc-turn--failed');
    const active = shellOf('rl-active-node');
    expect(within(active).getByText('进行中')).toBeVisible();
    expect(active.className).toContain('fc-turn--active');
    const confirmed = shellOf('rl-reviewer-result-1');
    expect(within(confirmed).getByText('已确认')).toBeVisible();
    // Decorative chip dot stays out of the accessibility tree.
    expect(failed.querySelector('.fc-status-chip__dot[aria-hidden="true"]')).not.toBeNull();
  });

  it('keeps human nodes as standalone node buttons, outside any turn card', () => {
    const ws = workspaceWithReturnLoop();
    const humanWs: TaskWorkspace = {
      ...ws,
      nodes: [
        ...ws.nodes,
        {
          id: 'rl-human-request',
          sequence: 9,
          agentId: WRITER_AGENT_ID,
          kind: 'human_request',
          title: '人工询问',
          body: '问题',
          status: 'active',
          attemptCount: 1,
          artifactVersion: null,
        },
      ],
    };
    renderCanvas(humanWs);
    // 8 anchors + 1 human node button.
    expect(screen.getAllByTestId('workspace-node')).toHaveLength(9);
    expect(screen.getAllByTestId('workspace-turn')).toHaveLength(4);
    const humanButton = document.getElementById('node-rl-human-request')!;
    expect(humanButton.tagName).toBe('BUTTON');
    expect(humanButton.className).toContain('fc-node');
    expect(humanButton.closest('[data-testid="workspace-turn"]')).toBeNull();
  });

  it('routes [运行过程] to the result and [输入] to the input of a turn', async () => {
    const onSelectNode = vi.fn();
    renderCanvas(workspaceWithReturnLoop(), { onSelectNode });
    const shell = shellOf('rl-writer-result-1');
    await userEvent.click(within(shell).getByRole('button', { name: '运行过程' }));
    expect(onSelectNode).toHaveBeenLastCalledWith('rl-writer-result-1');
    await userEvent.click(within(shell).getByRole('button', { name: '输入' }));
    expect(onSelectNode).toHaveBeenLastCalledWith('rl-writer-input-1');
  });

  it('selects the result node when the card body itself is clicked', async () => {
    const onSelectNode = vi.fn();
    renderCanvas(workspaceWithReturnLoop(), { onSelectNode });
    const shell = shellOf('rl-writer-result-1');
    await userEvent.click(within(shell).getByText('章节写作'));
    expect(onSelectNode).toHaveBeenCalledTimes(1);
    expect(onSelectNode).toHaveBeenCalledWith('rl-writer-result-1');
  });

  it('opens the skill dialog from the turn skill chip', async () => {
    const ws = workspaceWithReturnLoop();
    const skillNode: WorkspaceNode = {
      id: 'rl-writer-skill-1',
      sequence: 9,
      agentId: WRITER_AGENT_ID,
      kind: 'skill',
      title: SKILL_CHAPTER_WRITING_ID,
      body: 'hash',
      status: 'confirmed',
      attemptCount: 1,
      artifactVersion: null,
      turnId: null,
    };
    const onSelectNode = vi.fn();
    renderCanvas({ ...ws, nodes: [...ws.nodes, skillNode] }, { onSelectNode });
    // The unattributed skill attaches to the nearest writer turn card.
    expect(shellOf('rl-writer-skill-1')).toBe(shellOf('rl-writer-result-2'));
    const chip = within(shellOf('rl-writer-skill-1')).getByRole('button', {
      name: '技能:章节写作 Skill',
    });
    await userEvent.click(chip);
    expect(onSelectNode).toHaveBeenCalledWith('rl-writer-skill-1');
  });

  it('marks the shell of selected and highlighted members with explicit classes', () => {
    const { rerender } = renderCanvas(workspaceWithReturnLoop(), {
      selectedNodeId: 'rl-writer-result-1',
      highlightedNodeId: 'rl-reviewer-result-1',
    });
    expect(shellOf('rl-writer-result-1').className).toContain('fc-node--selected');
    expect(shellOf('rl-reviewer-result-1').className).toContain('fc-node--highlighted');

    rerender(
      <WorkspaceCanvas
        workspace={workspaceWithReturnLoop()}
        selectedNodeId={null}
        highlightedNodeId={null}
        onSelectNode={() => {}}
        drawerRevision={0}
      />,
    );
    expect(shellOf('rl-writer-result-1').className).not.toContain('fc-node--selected');
  });

  it('expands and collapses a turn card without unmounting anchors', async () => {
    const ws = workspaceWithReturnLoop();
    const resultBody = ws.nodes.find((node) => node.id === 'rl-writer-result-1')!.body;
    // Multi-line bodies: disable the default whitespace-collapsing normalizer.
    const byBody = { normalizer: (text: string) => text };
    renderCanvas(ws);
    const shell = shellOf('rl-writer-result-1');
    // Default state: collapsed, member bodies are not rendered.
    expect(within(shell).queryByText(resultBody, byBody)).toBeNull();

    await userEvent.click(within(shell).getByRole('button', { name: '展开' }));
    // The fixture result body becomes visible inside the expanded card.
    expect(within(shellOf('rl-writer-result-1')).getByText(resultBody, byBody)).toBeVisible();
    // Anchors stay mounted through the toggle.
    expect(screen.getAllByTestId('workspace-node')).toHaveLength(8);

    await userEvent.click(within(shellOf('rl-writer-result-1')).getByRole('button', { name: '收起' }));
    expect(within(shellOf('rl-writer-result-1')).queryByText(resultBody, byBody)).toBeNull();
  });

  it('shows 有新进展 when new nodes arrive while viewing history', async () => {
    const ws = workspaceWithReturnLoop();
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const utils = renderCanvas(ws);
    expect(screen.queryByRole('button', { name: '有新进展' })).toBeNull();

    pushViewportFarFromEdge(screen.getByTestId('workspace-canvas'));

    const extended: TaskWorkspace = { ...ws, nodes: [...ws.nodes, extraNode('rl-extra-node', 9)] };
    utils.rerender(
      <WorkspaceCanvas
        workspace={extended}
        selectedNodeId={null}
        highlightedNodeId={null}
        onSelectNode={() => {}}
        drawerRevision={0}
      />,
    );

    const control = await screen.findByRole('button', { name: '有新进展' });
    expect(control).toBeVisible();
    // The new input arrived as its own active turn card.
    expect(shellOf('rl-extra-node').className).toContain('fc-turn--active');

    await userEvent.click(control);
    expect(screen.queryByRole('button', { name: '有新进展' })).toBeNull();
    expect(
      (spy.mock.instances as unknown as Array<{ id: string }>).some(
        (instance) => instance.id === 'node-rl-extra-node',
      ),
    ).toBe(true);
  });

  it('auto-follows new nodes while already at the newest edge', async () => {
    const ws = workspaceWithReturnLoop();
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const utils = renderCanvas(ws);

    // jsdom default metrics keep the viewport "at the edge"; new node follows.
    const extended: TaskWorkspace = { ...ws, nodes: [...ws.nodes, extraNode('rl-follow-node', 9)] };
    utils.rerender(
      <WorkspaceCanvas
        workspace={extended}
        selectedNodeId={null}
        highlightedNodeId={null}
        onSelectNode={() => {}}
        drawerRevision={0}
      />,
    );

    expect(screen.queryByRole('button', { name: '有新进展' })).toBeNull();
    expect(
      (spy.mock.instances as unknown as Array<{ id: string }>).some(
        (instance) => instance.id === 'node-rl-follow-node',
      ),
    ).toBe(true);
  });

  it('hides 有新进展 once the user scrolls back to the newest edge', () => {
    const ws = workspaceWithReturnLoop();
    const utils = renderCanvas(ws);
    const viewport = screen.getByTestId('workspace-canvas');

    pushViewportFarFromEdge(viewport);
    utils.rerender(
      <WorkspaceCanvas
        workspace={{ ...ws, nodes: [...ws.nodes, extraNode('rl-extra-node', 9)] }}
        selectedNodeId={null}
        highlightedNodeId={null}
        onSelectNode={() => {}}
        drawerRevision={0}
      />,
    );
    expect(screen.getByRole('button', { name: '有新进展' })).toBeVisible();

    // Simulate the user scrolling to the newest corner.
    Object.defineProperty(viewport, 'scrollTop', { value: 1795, configurable: true });
    Object.defineProperty(viewport, 'scrollLeft', { value: 795, configurable: true });
    fireEvent.scroll(viewport);
    expect(screen.queryByRole('button', { name: '有新进展' })).toBeNull();
  });
});

describe('WorkspaceCanvas live stream pass-through (plan C realtime streaming)', () => {
  function runningWorkspace(): TaskWorkspace {
    const ws = workspaceWithReturnLoop();
    return {
      ...ws,
      task: { ...ws.task, status: 'running', currentAgentName: '章节审核' },
      nodes: [...ws.nodes, extraNode('rl-active-node', 9, 'active')],
    };
  }

  it('passes the live turn to the matching agent\'s active turn card only', () => {
    const ws = runningWorkspace();
    renderCanvas({
      ...ws,
      activeTurn: {
        agentId: REVIEWER_AGENT_ID,
        turnId: 'turn-live',
        status: 'running',
        text: '流式正文',
        thinking: '',
        tools: [],
        updatedAt: '2026-08-05T00:00:00.000Z',
      },
    });
    const streams = document.querySelectorAll('.fc-turn__stream');
    expect(streams).toHaveLength(1);
    expect(shellOf('rl-active-node').querySelector('.fc-turn__stream')).not.toBeNull();
    expect(streams[0].textContent).toContain('流式正文');
  });

  it('shows no stream when the live turn belongs to another agent', () => {
    const ws = runningWorkspace();
    renderCanvas({
      ...ws,
      activeTurn: {
        agentId: 'unknown-agent',
        turnId: 'turn-live',
        status: 'running',
        text: '流式正文',
        thinking: '',
        tools: [],
        updatedAt: '2026-08-05T00:00:00.000Z',
      },
    });
    expect(document.querySelectorAll('.fc-turn__stream')).toHaveLength(0);
  });

  it('shows no stream without an activeTurn', () => {
    renderCanvas(runningWorkspace());
    expect(document.querySelectorAll('.fc-turn__stream')).toHaveLength(0);
  });
});
