import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CORE_ERROR_CODES, CoreError } from '../gateway/core-errors';
import { templateFixture } from '../mock/__fixtures__/zhihu-single-chapter';
import { formatDateTime } from './display';
import { renderPage, recordingGateway, stubGateway } from '../test-support';
import { TemplateListPage } from './template-list-page';

describe('TemplateListPage', () => {
  it('exports the page component consumed by the router', () => {
    expect(TemplateListPage).toBeTypeOf('function');
  });

  it('renders template cards entirely from gateway data', async () => {
    const gateway = recordingGateway();
    renderPage('/templates', gateway);

    const link = await screen.findByRole('link', { name: templateFixture.template.name });
    expect(link).toHaveAttribute('href', `/templates/${templateFixture.template.id}`);

    const card = link.closest('article');
    expect(card).not.toBeNull();
    if (!card) return;
    expect(within(card).getByText(templateFixture.template.description)).toBeVisible();
    expect(within(card).getByText(`版本 ${templateFixture.template.version}`)).toBeVisible();
    expect(within(card).getByText(`${templateFixture.template.agentCount} 个 Agent`)).toBeVisible();
    expect(within(card).getByText('校验通过')).toBeVisible();
    expect(
      within(card).getByText(formatDateTime('2026-01-01T00:00:00.000Z')),
    ).toBeVisible();
  });

  it('warns visually when a template is served from cache', async () => {
    const gateway = stubGateway({
      listTemplates: async () => [
        {
          id: 'tpl-cached',
          name: '缓存模板',
          description: '上一次校验失败的模板，仍可使用缓存版本。',
          version: '0.9.0',
          agentCount: 1,
          status: 'invalid_using_cache',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    renderPage('/templates', gateway);
    expect(await screen.findByText('校验失败、使用缓存版本')).toBeVisible();
  });

  it('shows a public error answering where, why and what next', async () => {
    const gateway = stubGateway({
      listTemplates: async () => {
        throw new CoreError(
          CORE_ERROR_CODES.TEMPLATE_NOT_FOUND,
          '模板目录读取失败。',
          'MockGateway.listTemplates',
          '刷新页面后重试。',
        );
      },
    });
    renderPage('/templates', gateway);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('模板目录读取失败。')).toBeVisible();
    expect(within(alert).getByText(/MockGateway\.listTemplates/)).toBeVisible();
    expect(within(alert).getByText(/刷新页面后重试。/)).toBeVisible();
  });

  it('offers a creation guide when no templates exist', async () => {
    const gateway = stubGateway({ listTemplates: async () => [] });
    renderPage('/templates', gateway);
    expect(await screen.findByText('暂无可用模板')).toBeVisible();
    expect(screen.getByRole('link', { name: '重新加载页面' })).toHaveAttribute(
      'href',
      '/templates',
    );
  });
});
