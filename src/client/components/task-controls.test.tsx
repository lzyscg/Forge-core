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
    structuredProtocol: 'none',
    ...overrides,
  };
}

function renderControls(
  task: TaskSummary,
  gateway: ForgeCoreGateway & DevelopmentGateway = stubGateway(),
  pendingHumanQuestion: string | null = null,
  pendingHumanSource: 'progress_guard' | 'agent_request' | null = null,
) {
  return render(
    <GatewayProvider core={gateway} development={gateway}>
      <TaskControls
        task={task}
        pendingHumanQuestion={pendingHumanQuestion}
        pendingHumanSource={pendingHumanSource}
      />
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

  it('renders the minimal neutral state for the v2 failed status (spec §10.3)', () => {
    // Task 2: failed is terminal for ordinary commands and renders no action
    // buttons; the recovery surface (reopen_failed / clone fallback) is Task 11.
    renderControls(makeTask('failed'));
    expect(screen.queryByRole('button', { name: '开始生产' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
    expect(screen.queryByRole('button', { name: '继续' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
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

  it('renders the structured three-choice only for a progress_guard question', async () => {
    const gateway = stubGateway();
    renderControls(makeTask('waiting_human'), gateway, '进度已超限，请指示下一步。', 'progress_guard');

    expect(screen.getByRole('button', { name: '继续推进' })).toBeVisible();
    expect(screen.getByRole('button', { name: '人工接受' })).toBeVisible();
    expect(screen.getByRole('button', { name: '停止任务' })).toBeVisible();
    // The plain answer form is replaced by the structured guidance textarea.
    expect(screen.queryByRole('button', { name: '提交回答' })).toBeNull();
  });

  it('keeps the plain answer form for an agent_request question', async () => {
    const gateway = stubGateway();
    renderControls(makeTask('waiting_human'), gateway, '问题？', 'agent_request');

    expect(screen.getByRole('button', { name: '提交回答' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '继续推进' })).toBeNull();
    expect(screen.queryByRole('button', { name: '人工接受' })).toBeNull();
  });

  it('submits continue with the guidance text via the structured gateway method', async () => {
    const submitHumanDecision = vi.fn(async () => {});
    const gateway = stubGateway({ submitHumanDecision });
    renderControls(makeTask('waiting_human'), gateway, '进度已超限，请指示下一步。', 'progress_guard');

    await userEvent.type(screen.getByLabelText('人工干预处理指引（作为继续推进或人工接受的依据）'), '请直接提交当前版本');
    await userEvent.click(screen.getByRole('button', { name: '继续推进' }));
    expect(submitHumanDecision).toHaveBeenCalledWith('task-controls-1', {
      decision: 'continue',
      text: '请直接提交当前版本',
    });
  });

  it('submits accept only when at least one version exists and disables it otherwise', async () => {
    const submitHumanDecision = vi.fn(async () => {});
    const gateway = stubGateway({ submitHumanDecision });

    // Zero versions: accept is disabled before it ever reaches the gateway.
    renderControls(
      makeTask('waiting_human', { latestVersion: null }),
      gateway,
      '进度已超限，请指示下一步。',
      'progress_guard',
    );
    expect(screen.getByRole('button', { name: '人工接受' })).toBeDisabled();
    // The stop decision still works without guidance text.
    await userEvent.click(screen.getByRole('button', { name: '停止任务' }));
    expect(submitHumanDecision).toHaveBeenCalledWith('task-controls-1', { decision: 'stop' });
  });

  it('submits accept with guidance text when versions exist', async () => {
    const submitHumanDecision = vi.fn(async () => {});
    const gateway = stubGateway({ submitHumanDecision });
    renderControls(
      makeTask('waiting_human', { latestVersion: 2 }),
      gateway,
      '进度已超限，请指示下一步。',
      'progress_guard',
    );

    await userEvent.type(screen.getByLabelText('人工干预处理指引（作为继续推进或人工接受的依据）'), '授权直接提交终稿');
    await userEvent.click(screen.getByRole('button', { name: '人工接受' }));
    expect(submitHumanDecision).toHaveBeenCalledWith('task-controls-1', {
      decision: 'accept',
      text: '授权直接提交终稿',
    });
  });

  it('blocks a guidance-less continue before it reaches the gateway', async () => {
    const submitHumanDecision = vi.fn(async () => {});
    const gateway = stubGateway({ submitHumanDecision });
    renderControls(makeTask('waiting_human'), gateway, '进度已超限，请指示下一步。', 'progress_guard');

    await userEvent.click(screen.getByRole('button', { name: '继续推进' }));
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(submitHumanDecision).not.toHaveBeenCalled();
  });
});
