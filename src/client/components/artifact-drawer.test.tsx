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

  it('renders extract slots for content/review and the verdict badge', () => {
    const ws = workspaceWithReturnLoop();
    const reviewMd = '---\nverdict: reject\n---\n## 意见\n1. 【位置】第二节 【问题】节奏过快\n';
    renderDrawer({
      selectedVersion: 2,
      workspace: {
        ...ws,
        artifacts: [
          {
            ...ws.artifacts[0]!,
            files: [
              { name: 'content.md', extract: 'content', content: '第一节正文' },
              { name: 'revision.md', extract: 'revision', content: '修订说明：重写了第二节。' },
            ],
          },
          {
            ...ws.artifacts[1]!,
            files: [
              { name: 'content.md', extract: 'content', content: '第二节正文' },
              { name: 'review.md', extract: 'review', content: reviewMd },
            ],
          },
        ],
      },
    });

    // The selected V2 renders content + review slots; the review verdict badge
    // is parsed from the review.md frontmatter (display layer only).
    expect(screen.getByText('正文')).toBeVisible();
    expect(screen.getByText('审核意见')).toBeVisible();
    expect(screen.getByText('第二节正文')).toBeVisible();
    expect(screen.getByText('审核结论：打回')).toBeVisible();
  });

  it('renders a template-declared non-standard extract by its own name, not 正文', () => {
    const ws = workspaceWithReturnLoop();
    renderDrawer({
      selectedVersion: 1,
      workspace: {
        ...ws,
        artifacts: [
          {
            ...ws.artifacts[0]!,
            files: [{ name: 'evaluation.md', extract: 'evaluation', content: '评估结论' }],
          },
        ],
      },
    });
    // Semantic audit P1 (plan 2026-08-07): an unknown template extract is
    // never mislabeled as 正文 — it renders its own extract name.
    expect(screen.getByText('evaluation')).toBeVisible();
    expect(screen.queryByText('正文')).toBeNull();
    expect(screen.getByText('评估结论')).toBeVisible();
  });

  it('renders the revision slot without a verdict badge for a creator version', () => {
    const ws = workspaceWithReturnLoop();
    renderDrawer({
      selectedVersion: 1,
      workspace: {
        ...ws,
        artifacts: [
          {
            ...ws.artifacts[0]!,
            files: [
              { name: 'content.md', extract: 'content', content: '第一节正文' },
              { name: 'revision.md', extract: 'revision', content: '修订说明：重写了第二节。' },
            ],
          },
        ],
      },
    });
    expect(screen.getByText('正文')).toBeVisible();
    expect(screen.getByText('修订说明')).toBeVisible();
    expect(screen.queryByText('审核意见')).toBeNull();
    expect(screen.queryByText(/审核结论/)).toBeNull();
  });

  it('degrades a legacy single content file to one content slot', () => {
    const ws = workspaceWithReturnLoop();
    renderDrawer({
      selectedVersion: 1,
      workspace: {
        ...ws,
        artifacts: [
          {
            ...ws.artifacts[0]!,
            files: [{ name: 'content.md', extract: 'content', content: '旧版单文件正文' }],
          },
        ],
      },
    });
    expect(screen.getByText('正文')).toBeVisible();
    expect(screen.getByText('旧版单文件正文')).toBeVisible();
    expect(screen.getAllByTestId('artifact-preview')).toHaveLength(1);
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
