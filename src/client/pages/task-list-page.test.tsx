import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { TaskSummary, WorkspaceNode } from '../../shared/contracts';
import { CORE_ERROR_CODES, CoreError } from '../gateway/core-errors';
import { TEMPLATE_ID, templateFixture } from '../mock/__fixtures__/zhihu-single-chapter';
import {
  type MemoryStorage,
  corruptOneTask,
  createFixedClock,
  seededStorage,
} from '../mock/mock-fixtures';
import { MockStore } from '../mock/mock-store';
import { renderPage, recordingGateway, stubGateway } from '../test-support';
import { TaskListPage } from './task-list-page';

const SEED_BASE = Date.UTC(2026, 0, 2);

function at(offsetSeconds: number): string {
  return new Date(SEED_BASE + offsetSeconds * 1000).toISOString();
}

function seedNode(id: string, agentId: string): WorkspaceNode {
  return {
    id,
    sequence: 1,
    agentId,
    kind: 'input',
    title: 'sample input',
    body: 'sample body',
    status: 'active',
    attemptCount: 1,
    inputVersion: null,
  };
}

function buildRecord(
  id: string,
  name: string,
  events: Parameters<MockStore['appendTaskEvent']>[1][],
) {
  return {
    id,
    name,
    templateId: TEMPLATE_ID,
    templateName: templateFixture.template.name,
    frozenInput: { ...templateFixture.sampleInput },
    frozenTemplate: structuredClone(templateFixture.template),
    events,
    createdAt: at(0),
    updatedAt: events[events.length - 1].at,
  };
}

/**
 * Seeded storage (ready / completed / waiting / corrupt) extended with one
 * interrupted and one retryable task so every public status label and action
 * button can be exercised against the real MockGateway.
 */
function storageWithAllStatuses(): MemoryStorage {
  const storage = seededStorage();
  corruptOneTask(storage, 'task-corrupt');
  const store = new MockStore(storage, createFixedClock(SEED_BASE), {
    templates: [templateFixture.template],
  });
  store.createTaskRecord(
    buildRecord('task-seeded-interrupted', '示例任务 被中断', [
      { type: 'task_started', at: at(9) },
      { type: 'task_interrupted', at: at(10) },
    ]),
  );
  store.createTaskRecord(
    buildRecord('task-seeded-retryable', '示例任务 可重试', [
      { type: 'task_started', at: at(11) },
      { type: 'agent_input', at: at(12), node: seedNode('node-retry-input', 'writer') },
      {
        type: 'agent_attempt_failed',
        at: at(13),
        nodeId: 'node-retry-input',
        message: 'sample failure',
        retryable: false,
      },
    ]),
  );
  return storage;
}

/**
 * A failed task row helper (v2 permanent failure, spec §10.3): the mock
 * event model cannot project `failed` (no v2 events exist yet), so the row
 * is built from the literal summary the server will send for a
 * `structured_task_failed_v2` task. Task 2 renders the minimal neutral
 * state — the danger chip and NO action buttons; the recovery surface
 * (server-returned legal recipes, reopen_failed, clone fallback) lands with
 * the v2 recovery flow (Task 11).
 */
function failedSummaryRow(): TaskSummary {
  return {
    id: 'task-failed',
    name: '示例任务 已失败',
    templateId: TEMPLATE_ID,
    templateName: templateFixture.template.name,
    status: 'failed',
    currentAgentName: null,
    latestVersion: null,
    updatedAt: at(16),
    diagnostic: null,
    structuredProtocol: 'v2',
  };
}

/**
 * Clone-button matrix: the terminal completed row comes from seededStorage;
 * here one stopped, one running and the seeded ready row prove the rerun
 * control exists exactly on terminal rows.
 */
function storageWithCloneStatuses(): MemoryStorage {
  const storage = seededStorage();
  const store = new MockStore(storage, createFixedClock(SEED_BASE), {
    templates: [templateFixture.template],
  });
  store.createTaskRecord(
    buildRecord('task-seeded-stopped', '示例任务 已停止', [
      { type: 'task_started', at: at(14) },
      { type: 'task_stopped', at: at(15) },
    ]),
  );
  store.createTaskRecord(
    buildRecord('task-seeded-running', '示例任务 运行中', [
      { type: 'task_started', at: at(16) },
    ]),
  );
  return storage;
}

function rowOf(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 2, name });
  const row = heading.closest('li');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe('TaskListPage', () => {
  it('exports the page component consumed by the router', () => {
    expect(TaskListPage).toBeTypeOf('function');
  });

  it('lists tasks newest first with public status labels', async () => {
    const gateway = recordingGateway(storageWithAllStatuses(), createFixedClock());
    renderPage('/tasks', gateway);

    await screen.findByRole('heading', { level: 2, name: '示例任务 可重试' });
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      '示例任务 可重试',
      '示例任务 被中断',
      '示例任务 已完成',
      '示例任务 等待补充',
      '示例任务 待启动',
      'task-corrupt',
    ]);

    expect(screen.getByText('运行失败、可以重试')).toBeVisible();
    expect(screen.getByText('被中断、可以继续')).toBeVisible();
    expect(screen.getByText('已完成')).toBeVisible();
    expect(screen.getByText('等待用户回答')).toBeVisible();
    expect(screen.getByText('待运行')).toBeVisible();
    expect(screen.getByText('任务文件损坏、只能查看诊断')).toBeVisible();

    // Template column and version column flow from gateway summaries.
    expect(screen.getAllByText(templateFixture.template.name)).toHaveLength(5);
    expect(within(rowOf('示例任务 已完成')).getByText('V1')).toBeVisible();
    // Current agent names are template-defined, never Agent 1/2/3.
    expect(screen.getAllByText('章节写作').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Agent 1')).toBeNull();
  });

  it('renders a failed row with the danger chip and zero action buttons (spec §10.3)', async () => {
    // Task 2 minimal neutral rendering: the failed status label chips the
    // row, but start/stop/resume/retry/rerun never appear — reopen_failed
    // and the clone fallback surface land with the v2 recovery flow (Task 11).
    const gateway = stubGateway({ listTasks: async () => [failedSummaryRow()] });
    renderPage('/tasks', gateway);
    await screen.findByRole('heading', { level: 2, name: '示例任务 已失败' });

    expect(screen.getByText('已失败、无法继续运行')).toBeVisible();
    const row = rowOf('示例任务 已失败');
    expect(within(row).getAllByRole('button')).toHaveLength(1);
    expect(within(row).getByRole('button', { name: '删除' })).toBeVisible();
    expect(within(row).queryByRole('button', { name: '重跑' })).toBeNull();
    expect(within(row).queryByRole('button', { name: '重试' })).toBeNull();
    expect(within(row).queryByRole('button', { name: '继续' })).toBeNull();
  });

  it('keeps corrupt rows openable with their diagnostic', async () => {
    const gateway = recordingGateway(storageWithAllStatuses(), createFixedClock());
    renderPage('/tasks', gateway);
    await screen.findByRole('heading', { level: 2, name: 'task-corrupt' });

    const row = rowOf('task-corrupt');
    expect(within(row).getByText('任务文件损坏、只能查看诊断。')).toBeVisible();
    expect(within(row).getByRole('link', { name: '查看任务' })).toHaveAttribute(
      'href',
      '/tasks/task-corrupt',
    );
  });

  it('limits row actions to view, resume, retry and rerun where allowed', async () => {
    const gateway = recordingGateway(storageWithAllStatuses(), createFixedClock());
    renderPage('/tasks', gateway);
    await screen.findByRole('heading', { level: 2, name: '示例任务 可重试' });

    expect(screen.getAllByRole('link', { name: '查看任务' })).toHaveLength(6);
    expect(screen.getByRole('button', { name: '继续' })).toBeVisible();
    expect(screen.getByRole('button', { name: '重试' })).toBeVisible();
    // The dangerous delete control exists on EVERY row, in every status.
    expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(6);
    // The terminal row carries exactly the rerun control plus delete…
    expect(
      within(rowOf('示例任务 已完成')).getAllByRole('button').map((button) => button.textContent),
    ).toEqual(['重跑', '删除']);
    // …non-terminal rows carry delete alone.
    expect(
      within(rowOf('示例任务 待启动')).getAllByRole('button').map((button) => button.textContent),
    ).toEqual(['删除']);
  });

  it('resumes an interrupted task through the gateway', async () => {
    const gateway = recordingGateway(storageWithAllStatuses(), createFixedClock());
    renderPage('/tasks', gateway);
    const resume = await screen.findByRole('button', { name: '继续' });
    await userEvent.click(resume);

    await waitFor(() =>
      expect(gateway.calls.resumeTask).toEqual([['task-seeded-interrupted']]),
    );
    // The row reloads as running and the resume control disappears.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '继续' })).toBeNull(),
    );
    expect(screen.getAllByText('运行中').length).toBeGreaterThanOrEqual(1);
  });

  it('retries a retryable failure through the gateway', async () => {
    const gateway = recordingGateway(storageWithAllStatuses(), createFixedClock());
    renderPage('/tasks', gateway);
    const retry = await screen.findByRole('button', { name: '重试' });
    await userEvent.click(retry);

    await waitFor(() =>
      expect(gateway.calls.retryTask).toEqual([['task-seeded-retryable']]),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试' })).toBeNull());
  });

  it('surfaces public errors from lifecycle actions without losing the list', async () => {
    const interrupted: TaskSummary = {
      id: 'task-a',
      name: '任务 A',
      templateId: TEMPLATE_ID,
      templateName: templateFixture.template.name,
      status: 'interrupted',
      currentAgentName: null,
      latestVersion: null,
      updatedAt: at(5),
      diagnostic: null,
      structuredProtocol: 'none',
    };
    const gateway = stubGateway({
      listTasks: async () => [interrupted],
      resumeTask: async () => {
        throw new CoreError(
          CORE_ERROR_CODES.TASK_ALREADY_RUNNING,
          '已有任务 task-b 正在运行。',
          'MockGateway.resumeTask',
          '先停止正在运行的任务，再启动本任务。',
        );
      },
    });
    renderPage('/tasks', gateway);
    await userEvent.click(await screen.findByRole('button', { name: '继续' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('已有任务 task-b 正在运行。')).toBeVisible();
    expect(within(alert).getByText(/先停止正在运行的任务，再启动本任务。/)).toBeVisible();
    // The list and the failed control remain available.
    expect(screen.getByRole('heading', { level: 2, name: '任务 A' })).toBeVisible();
    expect(screen.getByRole('button', { name: '继续' })).toBeEnabled();
  });

  it('links to templates when no tasks exist', async () => {
    renderPage('/tasks', recordingGateway());
    expect(await screen.findByText('还没有生产任务')).toBeVisible();
    expect(screen.getByRole('link', { name: '浏览模板' })).toHaveAttribute(
      'href',
      '/templates',
    );
  });

  /* ------------------- Phase E Task 5: rerun (clone) rows ------------------ */

  it('offers rerun on terminal rows and hides it on active rows', async () => {
    const gateway = recordingGateway(storageWithCloneStatuses(), createFixedClock());
    renderPage('/tasks', gateway);
    await screen.findByRole('heading', { level: 2, name: '示例任务 运行中' });

    expect(within(rowOf('示例任务 已完成')).getByRole('button', { name: '重跑' })).toBeVisible();
    expect(within(rowOf('示例任务 已停止')).getByRole('button', { name: '重跑' })).toBeVisible();
    expect(within(rowOf('示例任务 运行中')).queryByRole('button', { name: '重跑' })).toBeNull();
    expect(within(rowOf('示例任务 待启动')).queryByRole('button', { name: '重跑' })).toBeNull();
    expect(
      within(rowOf('示例任务 等待补充')).queryByRole('button', { name: '重跑' }),
    ).toBeNull();
  });

  it('clones a terminal task through the gateway and reloads the list', async () => {
    const gateway = recordingGateway(storageWithCloneStatuses(), createFixedClock());
    renderPage('/tasks', gateway);
    await screen.findByRole('heading', { level: 2, name: '示例任务 已完成' });

    await userEvent.click(within(rowOf('示例任务 已完成')).getByRole('button', { name: '重跑' }));

    await waitFor(() => expect(gateway.calls.cloneTask).toEqual([['task-seeded-completed']]));
    // runAction reloads after the clone: the fresh row carries the suffix.
    expect(
      await screen.findByRole('heading', { level: 2, name: '示例任务 已完成（重跑）' }),
    ).toBeVisible();
  });

  /* --------------------- task list delete (danger flow) -------------------- */

  it('opens the delete confirmation with the task name and cancels silently', async () => {
    const gateway = recordingGateway(storageWithAllStatuses(), createFixedClock());
    renderPage('/tasks', gateway);
    await screen.findByRole('heading', { level: 2, name: '示例任务 已完成' });

    await userEvent.click(
      within(rowOf('示例任务 已完成')).getByRole('button', { name: '删除' }),
    );

    const dialog = await screen.findByRole('dialog', { name: '删除任务' });
    // The dialog names the exact task and the irreversibility before acting.
    expect(within(dialog).getByText(/示例任务 已完成/)).toBeVisible();
    expect(within(dialog).getByText(/不可撤销/)).toBeVisible();

    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(gateway.calls.deleteTask).toBeUndefined();
    expect(screen.getByRole('heading', { level: 2, name: '示例任务 已完成' })).toBeVisible();
  });

  it('dismisses the delete confirmation on Escape without deleting', async () => {
    const gateway = recordingGateway(storageWithAllStatuses(), createFixedClock());
    renderPage('/tasks', gateway);
    await screen.findByRole('heading', { level: 2, name: 'task-corrupt' });

    await userEvent.click(within(rowOf('task-corrupt')).getByRole('button', { name: '删除' }));
    await screen.findByRole('dialog', { name: '删除任务' });

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(gateway.calls.deleteTask).toBeUndefined();
  });

  it('deletes the confirmed task through the gateway and reloads the list', async () => {
    const gateway = recordingGateway(storageWithAllStatuses(), createFixedClock());
    renderPage('/tasks', gateway);
    await screen.findByRole('heading', { level: 2, name: '示例任务 待启动' });

    await userEvent.click(within(rowOf('示例任务 待启动')).getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('dialog', { name: '删除任务' });
    await userEvent.click(within(dialog).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(gateway.calls.deleteTask).toEqual([['task-seeded-ready']]));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 2, name: '示例任务 待启动' })).toBeNull(),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    // Sibling rows survive the deletion.
    expect(screen.getByRole('heading', { level: 2, name: '示例任务 已完成' })).toBeVisible();
  });

  it('deletes corrupt rows through the same confirmation flow', async () => {
    const gateway = recordingGateway(storageWithAllStatuses(), createFixedClock());
    renderPage('/tasks', gateway);
    await screen.findByRole('heading', { level: 2, name: 'task-corrupt' });

    await userEvent.click(within(rowOf('task-corrupt')).getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('dialog', { name: '删除任务' });
    await userEvent.click(within(dialog).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(gateway.calls.deleteTask).toEqual([['task-corrupt']]));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 2, name: 'task-corrupt' })).toBeNull(),
    );
  });

  it('surfaces public delete errors without losing the list', async () => {
    const completed: TaskSummary = {
      id: 'task-a',
      name: '任务 A',
      templateId: TEMPLATE_ID,
      templateName: templateFixture.template.name,
      status: 'completed',
      currentAgentName: null,
      latestVersion: 1,
      updatedAt: at(5),
      diagnostic: null,
      structuredProtocol: 'none',
    };
    const gateway = stubGateway({
      listTasks: async () => [completed],
      deleteTask: async () => {
        throw new CoreError(
          CORE_ERROR_CODES.TASK_NOT_FOUND,
          '未找到任务 task-a。',
          'MockGateway.deleteTask',
          '返回任务列表刷新后重试。',
        );
      },
    });
    renderPage('/tasks', gateway);
    await screen.findByRole('heading', { level: 2, name: '任务 A' });
    await userEvent.click(within(rowOf('任务 A')).getByRole('button', { name: '删除' }));

    const dialog = await screen.findByRole('dialog', { name: '删除任务' });
    await userEvent.click(within(dialog).getByRole('button', { name: '删除' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('未找到任务 task-a。')).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    // The list and the failed row remain available.
    expect(screen.getByRole('heading', { level: 2, name: '任务 A' })).toBeVisible();
    expect(screen.getByRole('button', { name: '删除' })).toBeEnabled();
  });
});
