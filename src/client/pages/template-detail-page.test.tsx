import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CORE_ERROR_CODES, CoreError } from '../gateway/core-errors';
import { TEMPLATE_ID, templateFixture } from '../mock/__fixtures__/zhihu-single-chapter';
import { renderPage, recordingGateway, stubGateway } from '../test-support';
import { TemplateDetailPage } from './template-detail-page';

describe('TemplateDetailPage', () => {
  it('exports the page component consumed by the router', () => {
    expect(TemplateDetailPage).toBeTypeOf('function');
  });

  it('shows dynamic template content and reloads only through the gateway', async () => {
    const gateway = recordingGateway();
    renderPage(`/templates/${TEMPLATE_ID}`, gateway);
    expect(await screen.findByText('章节写作')).toBeVisible();
    expect(screen.getByText('章节审核')).toBeVisible();
    expect(screen.getByText('章节写作 Skill')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '重新加载模板' }));
    expect(gateway.calls.reloadTemplate).toEqual([[TEMPLATE_ID]]);
  });

  it('renders declared inputs, agent order, routes and final output', async () => {
    const gateway = recordingGateway();
    renderPage(`/templates/${TEMPLATE_ID}`, gateway);
    await screen.findByRole('heading', { name: templateFixture.template.name });

    // Declared input fields.
    expect(screen.getByText('章节要求')).toBeVisible();
    expect(screen.getByText('原始素材')).toBeVisible();

    // Dynamic agent order with model and skill summaries.
    expect(screen.getByText('forge-longform-v2')).toBeVisible();
    expect(screen.getByText('forge-precise-v1')).toBeVisible();
    expect(
      screen.getByText(
        '提供叙事节奏、人称一致性与伏笔管理的写作辅助规则，按需加载。',
      ),
    ).toBeVisible();

    // Declared routes rendered with display names, in a single text node each.
    expect(
      screen.getByText('章节写作 → 章节审核：提交章节稿（产物）'),
    ).toBeVisible();
    expect(
      screen.getByText('章节审核 → 章节写作：退回修改意见（消息）'),
    ).toBeVisible();

    // Final output.
    expect(screen.getByText('终稿章节')).toBeVisible();
    expect(screen.getByText('Markdown')).toBeVisible();
    expect(screen.getByText('合法提交者：章节审核')).toBeVisible();
  });

  it('links to task creation carrying the template id', async () => {
    renderPage(`/templates/${TEMPLATE_ID}`, recordingGateway());
    const link = await screen.findByRole('link', { name: '使用此模板创建任务' });
    expect(link).toHaveAttribute('href', `/tasks/new?template=${TEMPLATE_ID}`);
  });

  it('shows an inline pending state while reloading', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = stubGateway({
      getTemplate: async () => structuredClone(templateFixture.template),
      reloadTemplate: async () => {
        await gate;
        return structuredClone(templateFixture.template);
      },
    });
    renderPage(`/templates/${TEMPLATE_ID}`, gateway);
    const button = await screen.findByRole('button', { name: '重新加载模板' });
    await userEvent.click(button);
    expect(await screen.findByText('重新加载中…')).toBeVisible();
    expect(screen.getByRole('button', { name: '重新加载中…' })).toBeDisabled();
    release();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '重新加载模板' })).toBeEnabled(),
    );
  });

  it('keeps the previous detail visible when reload fails', async () => {
    const gateway = stubGateway({
      getTemplate: async () => structuredClone(templateFixture.template),
      reloadTemplate: async () => {
        throw new CoreError(
          CORE_ERROR_CODES.TEMPLATE_NOT_FOUND,
          '模板源目录不可用。',
          'MockGateway.reloadTemplate',
          '恢复模板源目录后重试。',
        );
      },
    });
    renderPage(`/templates/${TEMPLATE_ID}`, gateway);
    await screen.findByText('章节写作');
    await userEvent.click(screen.getByRole('button', { name: '重新加载模板' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('模板源目录不可用。')).toBeVisible();
    expect(within(alert).getByText(/恢复模板源目录后重试。/)).toBeVisible();
    // The previous valid detail remains fully visible.
    expect(screen.getByText('章节写作')).toBeVisible();
    expect(screen.getByText('章节审核')).toBeVisible();
    expect(screen.getByRole('button', { name: '重新加载模板' })).toBeEnabled();
  });

  it('shows a public error for unknown templates', async () => {
    renderPage('/templates/not-a-template', recordingGateway());
    expect(await screen.findByText('未找到模板 not-a-template。')).toBeVisible();
    expect(screen.getByRole('link', { name: '返回模板列表' })).toHaveAttribute(
      'href',
      '/templates',
    );
  });
});
