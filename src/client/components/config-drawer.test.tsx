import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { workspaceWithReturnLoop } from '../test-support';
import { ConfigDrawer } from './config-drawer';

describe('ConfigDrawer', () => {
  it('shows frozen input, template version, agents, models, skills and declared routes', () => {
    render(<ConfigDrawer workspace={workspaceWithReturnLoop()} onClose={() => {}} />);

    const drawer = screen.getByRole('complementary', { name: '任务配置' });
    expect(drawer).toBeVisible();

    // Frozen user input keys and values.
    expect(screen.getByText('chapter-brief')).toBeVisible();
    expect(
      screen.getByText('以第一人称推进家族聚会中的冲突，结尾留下旧信来源的悬念，约 800 字。'),
    ).toBeVisible();
    // Template version.
    expect(screen.getByText('1.0.0')).toBeVisible();
    // Dynamic agents with models and skills.
    expect(screen.getAllByText('章节写作').length).toBeGreaterThan(0);
    expect(screen.getAllByText('章节审核').length).toBeGreaterThan(0);
    expect(screen.getByText('forge-longform-v2')).toBeVisible();
    expect(screen.getByText('forge-precise-v1')).toBeVisible();
    expect(screen.getByText('章节写作 Skill')).toBeVisible();
    expect(screen.getByText('章节审核 Skill')).toBeVisible();
    // Declared routes with kind labels and agent display names.
    expect(screen.getAllByText('提交章节稿').length).toBeGreaterThan(0);
    expect(screen.getByText('退回修改意见')).toBeVisible();
    expect(screen.getAllByText('产物').length).toBeGreaterThan(0);
    expect(screen.getAllByText('消息').length).toBeGreaterThan(0);
  });

  it('is strictly read-only: no editable controls anywhere', () => {
    const { container } = render(
      <ConfigDrawer workspace={workspaceWithReturnLoop()} onClose={() => {}} />,
    );
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
    expect(container.querySelectorAll('input, textarea, select')).toHaveLength(0);
    expect(container.querySelectorAll('[contenteditable]')).toHaveLength(0);
    // The only interactive control is the close button.
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('reports onClose when the close button is clicked', async () => {
    const onClose = vi.fn();
    render(<ConfigDrawer workspace={workspaceWithReturnLoop()} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: '关闭配置抽屉' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
