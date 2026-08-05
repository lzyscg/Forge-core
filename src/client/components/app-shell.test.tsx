import { render, screen, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { GatewayProvider } from '../gateway/gateway-context';
import { MemoryStorage, createFixedClock } from '../mock/mock-fixtures';
import { createMockGateway } from '../mock/mock-gateway';
import { routes } from '../router';

function renderAppAt(path: string) {
  // Task 4 replaced placeholders with data-driven pages, so the shell test
  // must provide the same composition-root Gateway injection as the app.
  const gateway = createMockGateway(new MemoryStorage(), createFixedClock());
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <GatewayProvider core={gateway} development={gateway}>
      <RouterProvider router={router} />
    </GatewayProvider>,
  );
}

describe('AppShell production navigation', () => {
  it('shows only production navigation in the main header', () => {
    renderAppAt('/tasks');
    expect(screen.getByRole('link', { name: '生产任务' })).toBeVisible();
    expect(screen.getByRole('link', { name: '模板' })).toBeVisible();
    expect(screen.queryByRole('link', { name: '开发进度' })).toBeNull();
  });

  it('marks the active production section for assistive technology', () => {
    renderAppAt('/tasks');
    expect(screen.getByRole('link', { name: '生产任务' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('shows the Forge wordmark in the header', () => {
    renderAppAt('/tasks');
    expect(screen.getByText('Forge')).toBeVisible();
  });

  it('redirects the root path to the task list', async () => {
    renderAppAt('/');
    expect(await screen.findByRole('heading', { name: '生产任务' })).toBeVisible();
  });

  it('keeps development progress addressable without linking it', async () => {
    renderAppAt('/dev/progress');
    expect(await screen.findByRole('heading', { name: '开发进度' })).toBeVisible();
    expect(screen.queryByRole('link', { name: '开发进度' })).toBeNull();
  });

  it('renders a local 404 with links back to tasks and templates', async () => {
    renderAppAt('/not-a-real-route');
    const main = await screen.findByRole('main');
    expect(within(main).getByRole('heading', { name: '页面不存在' })).toBeVisible();
    expect(within(main).getByRole('link', { name: '生产任务' })).toHaveAttribute(
      'href',
      '/tasks',
    );
    expect(within(main).getByRole('link', { name: '模板' })).toHaveAttribute(
      'href',
      '/templates',
    );
  });
});
