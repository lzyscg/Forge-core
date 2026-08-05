import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './app-shell';
import { ErrorBoundary } from './error-boundary';

function ThrowingPage(): ReactElement {
  throw new Error('boom: simulated render failure');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders children while nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>页面内容正常</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('页面内容正常')).toBeVisible();
  });

  it('renders the fallback message when a page throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <ThrowingPage />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByText('这个页面暂时无法显示')).toBeVisible();
  });

  it('isolates a page render error without removing navigation', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <AppShell outlet={<ThrowingPage />} />
      </MemoryRouter>,
    );
    expect(screen.getByText('这个页面暂时无法显示')).toBeVisible();
    expect(screen.getByRole('link', { name: '生产任务' })).toBeVisible();
    expect(screen.getByRole('link', { name: '模板' })).toBeVisible();
  });

  it('offers actionable recovery links in the fallback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <ThrowingPage />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('link', { name: '返回生产任务列表' })).toHaveAttribute(
      'href',
      '/tasks',
    );
    expect(screen.getByRole('link', { name: '返回模板列表' })).toHaveAttribute(
      'href',
      '/templates',
    );
  });
});
