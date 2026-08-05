import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CORE_ERROR_CODES, CoreError } from '../gateway/core-errors';
import {
  INPUT_CHAPTER_BRIEF_ID,
  INPUT_SOURCE_MATERIAL_ID,
  TEMPLATE_ID,
  templateFixture,
} from '../mock/__fixtures__/zhihu-single-chapter';
import { renderPage, recordingGateway, stubGateway } from '../test-support';
import { NewTaskPage } from './new-task-page';

describe('NewTaskPage', () => {
  it('exports the page component consumed by the router', () => {
    expect(NewTaskPage).toBeTypeOf('function');
  });

  it('renders and submits only template-declared inputs', async () => {
    const gateway = recordingGateway();
    renderPage(`/tasks/new?template=${TEMPLATE_ID}`, gateway);
    expect(await screen.findByLabelText('章节要求')).toBeVisible();
    expect(screen.getByLabelText('原始素材')).toBeVisible();
    expect(screen.queryByLabelText('模型')).toBeNull();
    expect(screen.queryByLabelText('Agent')).toBeNull();
  });

  it('creates a task from filled values and navigates to the task page', async () => {
    const gateway = recordingGateway();
    const { router } = renderPage(`/tasks/new?template=${TEMPLATE_ID}`, gateway);

    await userEvent.type(
      await screen.findByLabelText('任务名称'),
      '第一章产品形态验收',
    );
    await userEvent.type(screen.getByLabelText('章节要求'), '以第一人称推进冲突');
    await userEvent.type(screen.getByLabelText('原始素材'), '家族聚会中出现一封旧信');
    await userEvent.click(screen.getByRole('button', { name: '创建任务' }));

    await waitFor(() => expect(gateway.calls.createTask).toHaveLength(1));
    expect(gateway.calls.createTask?.[0]?.[0]).toEqual({
      templateId: TEMPLATE_ID,
      name: '第一章产品形态验收',
      input: {
        [INPUT_CHAPTER_BRIEF_ID]: '以第一人称推进冲突',
        [INPUT_SOURCE_MATERIAL_ID]: '家族聚会中出现一封旧信',
      },
    });

    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/tasks\/task-/),
    );
    // Task 5 replaced the placeholder with the production page: the task
    // detail heading now carries the created task's own name.
    expect(
      await screen.findByRole('heading', { name: '第一章产品形态验收' }),
    ).toBeVisible();
  });

  it('blocks submission while required fields are empty and lists them', async () => {
    const gateway = recordingGateway();
    renderPage(`/tasks/new?template=${TEMPLATE_ID}`, gateway);
    await userEvent.click(await screen.findByRole('button', { name: '创建任务' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/任务名称/)).toBeVisible();
    expect(within(alert).getByText(/章节要求/)).toBeVisible();
    expect(within(alert).getByText(/原始素材/)).toBeVisible();
    expect(gateway.calls.createTask).toBeUndefined();
  });

  it('keeps entered values and focuses the error summary when creation fails', async () => {
    const gateway = stubGateway({
      getTemplate: async () => structuredClone(templateFixture.template),
      createTask: async () => {
        throw new CoreError(
          CORE_ERROR_CODES.INVALID_INPUT,
          '输入字段 chapter-brief 未在模板中声明。',
          'MockGateway.createTask',
          '移除未声明的输入字段后重新提交。',
        );
      },
    });
    renderPage(`/tasks/new?template=${TEMPLATE_ID}`, gateway);

    await userEvent.type(await screen.findByLabelText('任务名称'), '第一章产品形态验收');
    await userEvent.type(screen.getByLabelText('章节要求'), '以第一人称推进冲突');
    await userEvent.type(screen.getByLabelText('原始素材'), '家族聚会中出现一封旧信');
    await userEvent.click(screen.getByRole('button', { name: '创建任务' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('输入字段 chapter-brief 未在模板中声明。')).toBeVisible();
    expect(within(alert).getByText(/MockGateway\.createTask/)).toBeVisible();
    expect(within(alert).getByText(/移除未声明的输入字段后重新提交。/)).toBeVisible();

    // Entered values are retained for correction.
    expect(screen.getByLabelText('章节要求')).toHaveValue('以第一人称推进冲突');
    expect(screen.getByLabelText('原始素材')).toHaveValue('家族聚会中出现一封旧信');

    // The error summary receives focus so keyboard users land on the problem.
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('shows a public error when the template parameter is missing', async () => {
    renderPage('/tasks/new', recordingGateway());
    expect(await screen.findByText('缺少模板参数，无法新建任务。')).toBeVisible();
    expect(screen.getByRole('link', { name: '浏览模板' })).toHaveAttribute(
      'href',
      '/templates',
    );
  });

  it('shows a public error for unknown templates', async () => {
    renderPage('/tasks/new?template=not-a-template', recordingGateway());
    expect(await screen.findByText('未找到模板 not-a-template。')).toBeVisible();
    expect(screen.getByRole('link', { name: '浏览模板' })).toHaveAttribute(
      'href',
      '/templates',
    );
  });
});
