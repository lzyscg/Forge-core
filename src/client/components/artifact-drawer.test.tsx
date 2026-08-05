import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { workspaceWithReturnLoop } from '../test-support';
import { ArtifactDrawer } from './artifact-drawer';

function renderDrawer(props: Partial<ComponentProps<typeof ArtifactDrawer>> = {}) {
  return render(
    <ArtifactDrawer
      workspace={workspaceWithReturnLoop()}
      selectedVersion={2}
      onLocateArtifact={() => {}}
      onClose={() => {}}
      {...props}
    />,
  );
}

describe('ArtifactDrawer', () => {
  it('lists the append-only version chain with ids and a final marker', () => {
    renderDrawer();
    const drawer = screen.getByRole('complementary', { name: '产物版本' });
    expect(drawer).toBeVisible();

    expect(screen.getByText('V1')).toBeVisible();
    expect(screen.getByText('V2')).toBeVisible();
    expect(document.getElementById('artifact-rl-artifact-v1')).not.toBeNull();
    expect(document.getElementById('artifact-rl-artifact-v2')).not.toBeNull();
    // Exactly one final badge, on the latest accepted version.
    expect(screen.getAllByText('终稿')).toHaveLength(1);
  });

  it('marks the selected version and previews its full body as paragraphs', () => {
    renderDrawer({ selectedVersion: 1 });
    const selected = document.getElementById('artifact-rl-artifact-v1')!;
    expect(selected.getAttribute('aria-current')).toBe('true');

    const preview = screen.getByTestId('artifact-preview');
    expect(preview.textContent).toContain('第一章 旧信疑云（V1）');
    expect(preview.textContent).toContain('年夜饭的圆桌刚摆好');
    // Content is split into multiple paragraphs, not one blob.
    expect(preview.querySelectorAll('p').length).toBeGreaterThan(1);
    // The other version's body is not rendered.
    expect(preview.textContent).not.toContain('第一章 旧信疑云（V2）');
  });

  it('falls back to the latest version when nothing is selected', () => {
    renderDrawer({ selectedVersion: null });
    const preview = screen.getByTestId('artifact-preview');
    expect(preview.textContent).toContain('第一章 旧信疑云（V2）');
    const latest = document.getElementById('artifact-rl-artifact-v2')!;
    expect(latest.getAttribute('aria-current')).toBe('true');
  });

  it('locates the source node when a version is clicked', async () => {
    const onLocateArtifact = vi.fn();
    renderDrawer({ onLocateArtifact });
    await userEvent.click(screen.getByText('V1'));
    expect(onLocateArtifact).toHaveBeenCalledTimes(1);
    expect(onLocateArtifact.mock.calls[0]?.[0]).toMatchObject({
      id: 'rl-artifact-v1',
      version: 1,
      sourceNodeId: 'rl-writer-result-1',
    });
  });

  it('renders an empty note instead of a chain when no artifact exists yet', () => {
    const ws = workspaceWithReturnLoop();
    renderDrawer({ workspace: { ...ws, artifacts: [] }, selectedVersion: null });
    expect(screen.queryByText('V1')).toBeNull();
    expect(screen.getByText('尚无已发布的产物版本。')).toBeVisible();
  });

  it('closes through its own close button like the config drawer', async () => {
    const onClose = vi.fn();
    renderDrawer({ onClose });
    await userEvent.click(screen.getByRole('button', { name: '关闭产物抽屉' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
