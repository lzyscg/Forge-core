import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TaskStatus, TaskSummary } from '../../shared/contracts';
import { CORE_ERROR_CODES, CoreError } from '../gateway/core-errors';
import type { DevelopmentGateway } from '../gateway/development-gateway';
import type { ForgeCoreGateway } from '../gateway/forge-core-gateway';
import { GatewayProvider } from '../gateway/gateway-context';
import { stubGateway } from '../test-support';
import { TaskControls } from './task-controls';

function makeTask(status: TaskStatus, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 'task-controls-1',
    name: '控制测试任务',
    templateId: 'tpl',
    templateName: '模板',
    status,
    currentAgentName: null,
    latestVersion: null,
    updatedAt: '2026-01-02T00:00:00.000Z',
    diagnostic: null,
    ...overrides,
  };
}

function renderControls(
  task: TaskSummary,
  gateway: ForgeCoreGateway & DevelopmentGateway = stubGateway(),
  pendingHumanQuestion: string | null = null,
) {
  return render(
    <GatewayProvider core={gateway} development={gateway}>
      <TaskControls task={task} pendingHumanQuestion={pendingHumanQuestion} />
    </GatewayProvider>,
  );
}

describe('TaskControls', () => {
  it.each([
    ['ready', '开始生产'],
    ['running', '停止'],
    ['stopped', '继续'],
    ['interrupted', '继续'],
    ['retryable_failure', '重试'],
  ] as Array<[TaskStatus, string]>)(
    'renders the %s control labeled %s and calls the matching gateway method',
    async (status, label) => {
      const methodMap: Record<string, keyof ForgeCoreGateway> = {
        开始生产: 'startTask',
        停止: 'stopTask',
        继续: 'resumeTask',
        重试: 'retryTask',
      };
      const method = methodMap[label] as 'startTask';
      const spy = vi.fn(async () => {});
      const gateway = stubGateway({ [method]: spy } as Partial<ForgeCoreGateway>);
      renderControls(makeTask(status), gateway);

      await userEvent.click(screen.getByRole('button', { name: label }));
      expect(spy).toHaveBeenCalledWith('task-controls-1');
    },
  );

  it('renders no lifecycle controls for completed tasks', () => {
    renderControls(makeTask('completed'));
    expect(screen.queryByRole('button', { name: '开始生产' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
    expect(screen.queryByRole('button', { name: '继续' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });

  it('shows the pending question and submits answers while waiting_human', async () => {
    const answerHuman = vi.fn(async () => {});
    const gateway = stubGateway({ answerHuman });
    renderControls(makeTask('waiting_human'), gateway, '旧信的落款日期设定在哪一年？');

    expect(screen.getByText('旧信的落款日期设定在哪一年？')).toBeVisible();
    expect(screen.getByRole('button', { name: '停止' })).toBeVisible();

    await userEvent.type(screen.getByLabelText('回答'), '设定在一九九八年冬天');
    await userEvent.click(screen.getByRole('button', { name: '提交回答' }));
    expect(answerHuman).toHaveBeenCalledWith('task-controls-1', '设定在一九九八年冬天');
  });

  it('blocks empty answers before they reach the gateway', async () => {
    const answerHuman = vi.fn(async () => {});
    const gateway = stubGateway({ answerHuman });
    renderControls(makeTask('waiting_human'), gateway, '问题？');

    await userEvent.click(screen.getByRole('button', { name: '提交回答' }));
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(answerHuman).not.toHaveBeenCalled();
  });

  it('shows a public error notice when a lifecycle action fails', async () => {
    const startTask = vi.fn(async () => {
      throw new CoreError(
        CORE_ERROR_CODES.TASK_ALREADY_RUNNING,
        '已有任务 task-other 正在运行。',
        'MockGateway.startTask',
        '先停止正在运行的任务，再启动本任务。',
      );
    });
    const gateway = stubGateway({ startTask });
    renderControls(makeTask('ready'), gateway);

    await userEvent.click(screen.getByRole('button', { name: '开始生产' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('已有任务 task-other 正在运行。');
    // The control stays available for another attempt.
    expect(screen.getByRole('button', { name: '开始生产' })).toBeVisible();
  });
});
