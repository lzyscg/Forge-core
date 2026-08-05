import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('renders title and optional description', () => {
    render(<EmptyState title="暂无内容" description="稍后再来查看。" />);
    expect(screen.getByText('暂无内容')).toBeVisible();
    expect(screen.getByText('稍后再来查看。')).toBeVisible();
  });

  it('renders an optional action slot', () => {
    render(
      <EmptyState title="暂无内容" action={<a href="/templates">去别处看看</a>} />,
    );
    expect(screen.getByRole('link', { name: '去别处看看' })).toBeVisible();
  });

  it('omits description and action when not provided', () => {
    render(<EmptyState title="仅有标题" />);
    expect(screen.getByText('仅有标题')).toBeVisible();
  });
});
