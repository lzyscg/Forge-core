import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceNode } from '../../shared/contracts';
import { workspaceWithReturnLoop } from '../test-support';
import { NodeDetailDialog } from './node-detail-dialog';

const node: WorkspaceNode = {
  ...workspaceWithReturnLoop().nodes[5], // rl-writer-result-2, attemptCount 2
  body: '第一段正文。\n\n第二段正文。',
};

function renderDialog(props: Partial<ComponentProps<typeof NodeDetailDialog>> = {}) {
  return render(
    <NodeDetailDialog
      node={node}
      agentName="章节写作"
      onClose={() => {}}
      {...props}
    />,
  );
}

describe('NodeDetailDialog', () => {
  it('shows full body, attempt count, associated version and public status', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeVisible();

    expect(dialog.textContent).toContain('第一段正文。');
    expect(dialog.textContent).toContain('第二段正文。');
    expect(screen.getByText('2', { selector: '.fc-node-detail__value' })).toBeVisible();
    expect(screen.getByText('V2')).toBeVisible();
    expect(screen.getByText('已确认')).toBeVisible();
    expect(screen.getByText('结果')).toBeVisible();
    expect(screen.getByText('章节写作')).toBeVisible();
  });

  it('shows 无 when the node has no associated artifact version', () => {
    renderDialog({ node: { ...node, inputVersion: null }, agentName: '章节审核' });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('无');
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from the close button and returns focus to the invoking node', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" id="node-trigger" onClick={() => setOpen(true)}>
            触发节点
          </button>
          {open ? (
            <NodeDetailDialog node={node} agentName="章节写作" onClose={() => setOpen(false)} />
          ) : null}
        </div>
      );
    }

    render(<Harness />);
    const trigger = document.getElementById('node-trigger') as HTMLButtonElement;
    trigger.focus();
    await userEvent.click(trigger);

    expect(screen.getByRole('dialog')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '关闭节点详情' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
