import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillContent, TaskWorkspace, TurnTrace, WorkspaceNode } from '../../shared/contracts';
import { CORE_ERROR_CODES, CoreError } from '../gateway/core-errors';
import {
  SKILL_CHAPTER_WRITING_ID,
  WRITER_AGENT_ID,
} from '../mock/__fixtures__/zhihu-single-chapter';
import { MemoryStorage, createFixedClock, seededStorage, validCreateRequest } from '../mock/mock-fixtures';
import {
  recordingGateway,
  renderPage,
  renderProductionPage,
  stubGateway,
  workspaceWithReturnLoop,
} from '../test-support';

describe('ProductionPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses frozen template names and keeps every confirmed node', async () => {
    renderProductionPage(workspaceWithReturnLoop());
    expect(await screen.findByRole('heading', { name: '章节写作' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '章节审核' })).toBeVisible();
    // One hidden anchor per node, merged into one turn card per turn.
    expect(screen.getAllByTestId('workspace-node')).toHaveLength(8);
    expect(screen.getAllByTestId('workspace-turn')).toHaveLength(4);
    expect(screen.queryByText('Agent 1')).toBeNull();
  });

  it('starts with both drawers closed and opens them as overlays on demand', async () => {
    renderProductionPage(workspaceWithReturnLoop());
    await screen.findByTestId('workspace-canvas');
    expect(screen.queryByRole('complementary', { name: '任务配置' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: '产物版本' })).toBeNull();
    expect(document.querySelector('.fc-drawer-backdrop')).toBeNull();

    // Opening a drawer overlays the canvas instead of pushing it.
    await userEvent.click(screen.getByRole('button', { name: '产物' }));
    expect(await screen.findByRole('complementary', { name: '产物版本' })).toBeVisible();
    expect(document.querySelector('.fc-drawer-backdrop')).not.toBeNull();
    expect(screen.getByText('V1')).toBeVisible();
    expect(screen.getByText('V2')).toBeVisible();
    // The canvas keeps every anchor mounted while the drawer covers it.
    expect(screen.getAllByTestId('workspace-node')).toHaveLength(8);
  });

  it('closes overlay drawers with Escape', async () => {
    renderProductionPage(workspaceWithReturnLoop());
    await screen.findByTestId('workspace-canvas');
    await userEvent.click(screen.getByRole('button', { name: '配置' }));
    expect(await screen.findByRole('complementary', { name: '任务配置' })).toBeVisible();
    // Focus is on the toggle inside the page container; Escape bubbles up.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: '任务配置' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: '产物版本' })).toBeNull();
  });

  it('shows the task header with status label and current action', async () => {
    const ws = workspaceWithReturnLoop();
    const running: TaskWorkspace = {
      ...ws,
      task: { ...ws.task, status: 'running', currentAgentName: '章节写作' },
    };
    renderProductionPage(running);

    const header = await screen.findByRole('heading', { level: 1 });
    expect(header).toHaveTextContent(ws.task.name);
    expect(screen.getByText('运行中')).toBeVisible();
    expect(screen.getByText('章节写作', { selector: '.fc-production__action-value' })).toBeVisible();
  });

  it('renders a not-found panel for TASK_NOT_FOUND', async () => {
    const gateway = stubGateway({
      getWorkspace: async () => {
        throw new CoreError(
          CORE_ERROR_CODES.TASK_NOT_FOUND,
          '未找到任务 task-missing。',
          'MockGateway.getWorkspace',
          '返回任务列表刷新后重试。',
        );
      },
    });
    renderPage('/tasks/task-missing', gateway);

    expect(await screen.findByText('任务不存在')).toBeVisible();
    expect(screen.getByText('未找到任务 task-missing。')).toBeVisible();
    expect(screen.getByRole('link', { name: '返回任务列表' })).toHaveAttribute('href', '/tasks');
    // The workspace canvas must not render.
    expect(screen.queryAllByTestId('workspace-node')).toHaveLength(0);
  });

  it('renders the corrupt diagnostic panel for TASK_CORRUPTED', async () => {
    const gateway = stubGateway({
      getWorkspace: async () => {
        throw new CoreError(
          CORE_ERROR_CODES.TASK_CORRUPTED,
          '任务 task-broken 的本地模拟数据未通过校验，已被隔离。',
          'MockGateway.getWorkspace',
          '在开发进度页重置模拟数据后重试。',
        );
      },
    });
    renderPage('/tasks/task-broken', gateway);

    expect(await screen.findByText('任务数据已隔离')).toBeVisible();
    expect(
      screen.getByText('任务 task-broken 的本地模拟数据未通过校验，已被隔离。'),
    ).toBeVisible();
    expect(screen.queryAllByTestId('workspace-node')).toHaveLength(0);
  });

  it('offers a retry for other load failures and recovers', async () => {
    const ws = workspaceWithReturnLoop();
    const getWorkspace = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(ws);
    const gateway = stubGateway({ getWorkspace });
    renderPage(`/tasks/${ws.task.id}`, gateway);

    expect(await screen.findByText('加载任务失败')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '重新加载任务' }));
    expect(await screen.findByRole('heading', { name: '章节写作' })).toBeVisible();
    expect(getWorkspace).toHaveBeenCalledTimes(2);
  });

  it('opens the config drawer without dropping nodes or node selection', async () => {
    renderProductionPage(workspaceWithReturnLoop());
    await screen.findByTestId('workspace-canvas');

    // Select a turn first so we can prove selection survives toggles:
    // [运行过程] opens the result's process trace dialog.
    const resultShell = document
      .getElementById('node-rl-writer-result-2')!
      .closest<HTMLElement>('[data-testid="workspace-turn"]')!;
    await userEvent.click(within(resultShell).getByRole('button', { name: '运行过程' }));
    expect(screen.getByRole('dialog')).toBeVisible();

    const toggle = screen.getByRole('button', { name: '配置' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(screen.getByRole('complementary', { name: '任务配置' })).toBeVisible();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // All anchors remain mounted and the dialog stayed open.
    expect(screen.getAllByTestId('workspace-node')).toHaveLength(8);
    expect(screen.getByRole('dialog')).toBeVisible();

    // Escape on the focused toggle closes the overlay drawer; the dialog
    // stays open because this Escape never reaches it.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: '任务配置' })).toBeNull();
    expect(screen.getByRole('dialog')).toBeVisible();

    // Escape inside the dialog closes only the dialog (its handler stops
    // propagation, so the page-level drawer handler never sees it).
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('selects the artifact version of a clicked result turn', async () => {
    renderProductionPage(workspaceWithReturnLoop());
    await screen.findByTestId('workspace-canvas');
    await userEvent.click(screen.getByRole('button', { name: '产物' }));
    await screen.findByRole('complementary', { name: '产物版本' });

    const resultShell = document
      .getElementById('node-rl-writer-result-1')!
      .closest<HTMLElement>('[data-testid="workspace-turn"]')!;
    await userEvent.click(within(resultShell).getByRole('button', { name: '运行过程' }));
    const v1Item = document.getElementById('artifact-rl-artifact-v1')!;
    expect(v1Item.getAttribute('aria-current')).toBe('true');
    // Result turns open the process trace dialog; the fixture nodes carry no
    // turn ids, so the placeholder copy shows instead of a trace.
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('暂无执行过程记录：');
  });

  it('scrolls to and highlights the source turn when a version is clicked', async () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    renderProductionPage(workspaceWithReturnLoop());
    await screen.findByTestId('workspace-canvas');
    await userEvent.click(screen.getByRole('button', { name: '产物' }));
    await screen.findByRole('complementary', { name: '产物版本' });

    await userEvent.click(within(document.getElementById('artifact-rl-artifact-v1')!).getByText('V1'));

    expect(spy).toHaveBeenCalled();
    expect(
      (spy.mock.instances as unknown as Array<{ id: string }>).some(
        (instance) => instance.id === 'node-rl-writer-result-1',
      ),
    ).toBe(true);
    const shell = document
      .getElementById('node-rl-writer-result-1')!
      .closest<HTMLElement>('[data-testid="workspace-turn"]')!;
    expect(shell.className).toContain('fc-node--highlighted');
  });

  it('submits human answers through the gateway and follows live updates', async () => {
    const gateway = recordingGateway(seededStorage());
    renderPage('/tasks/task-seeded-waiting', gateway);

    expect(await screen.findByText(/旧信的落款日期/)).toBeVisible();
    await userEvent.type(screen.getByLabelText('回答'), '设定在一九九八年冬天');
    await userEvent.click(screen.getByRole('button', { name: '提交回答' }));

    await waitFor(() => expect(gateway.calls.answerHuman).toHaveLength(1));
    expect(gateway.calls.answerHuman?.[0]).toEqual(['task-seeded-waiting', '设定在一九九八年冬天']);
    // watchTask notification reloads the workspace; the answer node appears.
    expect((await screen.findAllByText('人工回答')).length).toBeGreaterThan(0);
  });

  it('drives the deterministic demo from start to completion through watch updates', async () => {
    const storage = new MemoryStorage();
    const clock = createFixedClock();
    const gateway = recordingGateway(storage, clock);
    const task = await gateway.createTask(validCreateRequest);
    renderPage(`/tasks/${task.id}`, gateway);

    await userEvent.click(await screen.findByRole('button', { name: '开始生产' }));
    act(() => clock.runAll());

    await waitFor(() => expect(screen.getByText('已完成')).toBeVisible());
    // Version chain lives in the on-demand artifacts drawer.
    await userEvent.click(screen.getByRole('button', { name: '产物' }));
    expect(await screen.findByText('V1')).toBeVisible();
    expect(screen.getByText('V2')).toBeVisible();
    // completed: no mutating control remains.
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
    expect(screen.queryByRole('button', { name: '继续' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });

  it('freezes the run on stop and resumes from the persisted step', async () => {
    const storage = new MemoryStorage();
    const clock = createFixedClock();
    const gateway = recordingGateway(storage, clock);
    const task = await gateway.createTask(validCreateRequest);
    renderPage(`/tasks/${task.id}`, gateway);

    await userEvent.click(await screen.findByRole('button', { name: '开始生产' }));
    act(() => clock.advance(1100)); // writer input + result, before V1 publish
    await waitFor(() => expect(screen.getByRole('button', { name: '停止' })).toBeVisible());

    await userEvent.click(screen.getByRole('button', { name: '停止' }));
    act(() => clock.runAll());
    await waitFor(() => expect(screen.getByText('已停止')).toBeVisible());
    expect((await gateway.getWorkspace(task.id)).artifacts).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: '继续' }));
    act(() => clock.runAll());
    await waitFor(() => expect(screen.getByText('已完成')).toBeVisible());
    expect((await gateway.getWorkspace(task.id)).artifacts.map((item) => item.version)).toEqual([
      1, 2,
    ]);
  });

  it('offers continue and stop for interrupted tasks', async () => {
    const ws = workspaceWithReturnLoop();
    renderProductionPage({ ...ws, task: { ...ws.task, status: 'interrupted' } });
    expect(await screen.findByRole('button', { name: '继续' })).toBeVisible();
    expect(screen.getByRole('button', { name: '停止' })).toBeVisible();
  });

  it('offers retry and stop for retryable_failure tasks', async () => {
    const ws = workspaceWithReturnLoop();
    renderProductionPage({ ...ws, task: { ...ws.task, status: 'retryable_failure' } });
    expect(await screen.findByRole('button', { name: '重试' })).toBeVisible();
    expect(screen.getByRole('button', { name: '停止' })).toBeVisible();
  });

  it('renders executed routes as SVG but never declared-only edges', async () => {
    renderProductionPage(workspaceWithReturnLoop());
    await screen.findByTestId('workspace-canvas');

    const paths = document.querySelectorAll('path.fc-flow-path');
    // Exactly the three executed routes; the template declares only two edges,
    // so this also proves we do not dedupe to the declared set.
    expect(paths).toHaveLength(3);
    const svg = document.querySelector('svg.fc-flow-overlay');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  /* ------------- Phase E Task 5: trace dialog routing + clone ------------- */

  it('opens the process trace dialog for result nodes and the detail dialog otherwise', async () => {
    const ws = workspaceWithSkillAndTurnIds();
    const trace: TurnTrace = {
      turnId: 'turn-rl-writer-result-1',
      entries: [{ kind: 'text', text: '正文条目。' }],
    };
    const getTurnTrace = vi.fn().mockResolvedValue(trace);
    const gateway = stubGateway({ getWorkspace: async () => ws, getTurnTrace });
    renderProductionPage(ws, gateway);
    await screen.findByTestId('workspace-canvas');

    const resultShell = document
      .getElementById('node-rl-writer-result-1')!
      .closest<HTMLElement>('[data-testid="workspace-turn"]')!;
    await userEvent.click(within(resultShell).getByRole('button', { name: '运行过程' }));
    expect(await screen.findByText('正文', { selector: '.fc-trace__section-title' })).toBeVisible();
    expect(getTurnTrace).toHaveBeenCalledTimes(1);
    expect(getTurnTrace).toHaveBeenCalledWith(ws.task.id, 'turn-rl-writer-result-1');

    await userEvent.click(within(resultShell).getByRole('button', { name: '输入' }));
    expect(await screen.findByText('完整内容')).toBeVisible();
    expect(document.querySelector('.fc-trace__section')).toBeNull();
  });

  it('loads skill content for skill nodes without requesting a trace', async () => {
    const ws = workspaceWithSkillAndTurnIds();
    const skillContent: SkillContent = {
      skillId: SKILL_CHAPTER_WRITING_ID,
      content: '开篇三百字内落下一个具体的悬念物件。',
      versionHash: '8f3a2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70819283a4b5c6d7e8',
    };
    const getSkillContent = vi.fn().mockResolvedValue(skillContent);
    const getTurnTrace = vi.fn();
    const gateway = stubGateway({ getWorkspace: async () => ws, getSkillContent, getTurnTrace });
    renderProductionPage(ws, gateway);
    await screen.findByTestId('workspace-canvas');

    await userEvent.click(screen.getByRole('button', { name: '技能:章节写作 Skill' }));
    expect(
      await screen.findByText('开篇三百字内落下一个具体的悬念物件。'),
    ).toBeVisible();
    expect(getSkillContent).toHaveBeenCalledWith(ws.task.id, SKILL_CHAPTER_WRITING_ID);
    expect(getTurnTrace).not.toHaveBeenCalled();
  });

  it('offers rerun-with-current-template for completed tasks and navigates to the clone', async () => {
    const ws = workspaceWithReturnLoop();
    const cloneTask = vi.fn().mockResolvedValue({
      ...ws.task,
      id: 'task-clone-1',
      name: `${ws.task.name}（重跑）`,
      status: 'ready',
    });
    const gateway = stubGateway({ getWorkspace: async () => ws, cloneTask });
    const { router } = renderProductionPage(ws, gateway);

    await userEvent.click(await screen.findByRole('button', { name: '用当前模板重跑' }));
    expect(cloneTask).toHaveBeenCalledWith(ws.task.id);
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks/task-clone-1'));
  });

  it('offers the clone button for stopped tasks', async () => {
    const ws = workspaceWithReturnLoop();
    renderProductionPage({ ...ws, task: { ...ws.task, status: 'stopped' } });
    expect(await screen.findByRole('button', { name: '用当前模板重跑' })).toBeVisible();
  });

  it('renders incompatible tasks read-only with the rebuild label and clone path', async () => {
    const ws = workspaceWithReturnLoop();
    renderProductionPage({
      ...ws,
      task: {
        ...ws.task,
        status: 'incompatible',
        diagnostic: '任务冻结快照缺少当前回合契约，无法继续运行；可查看历史内容或使用当前模板克隆重建。',
      },
    });

    // Public status label of the incompatibility gate (spec §7.3).
    expect(await screen.findByText('契约不兼容，需使用当前模板重建')).toBeVisible();
    // Read-only treatment: no lifecycle mutation control is offered.
    expect(screen.queryByRole('button', { name: '开始生产' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
    expect(screen.queryByRole('button', { name: '继续' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    // The workspace itself stays visible and cloneable onto the current template.
    expect(screen.getAllByTestId('workspace-node').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '用当前模板重跑' })).toBeVisible();
  });

  it('hides the clone button outside terminal statuses', async () => {
    const ws = workspaceWithReturnLoop();
    renderProductionPage({
      ...ws,
      task: { ...ws.task, status: 'running', currentAgentName: '章节写作' },
    });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: '用当前模板重跑' })).toBeNull();
  });

  it('surfaces clone failures as a public notice and keeps the page usable', async () => {
    const ws = workspaceWithReturnLoop();
    const cloneTask = vi.fn().mockRejectedValue(
      new CoreError(
        CORE_ERROR_CODES.TASK_ALREADY_RUNNING,
        '已有任务 task-b 正在运行。',
        'MockGateway.cloneTask',
        '先停止正在运行的任务，再启动本任务。',
      ),
    );
    const gateway = stubGateway({ getWorkspace: async () => ws, cloneTask });
    renderProductionPage(ws, gateway);

    await userEvent.click(await screen.findByRole('button', { name: '用当前模板重跑' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('已有任务 task-b 正在运行。')).toBeVisible();
    expect(screen.getByRole('button', { name: '用当前模板重跑' })).toBeEnabled();
  });
});

/**
 * Return-loop workspace extended for Phase E: every result node carries its
 * turn id and the writer lane gained one skill node (title = skill id), so
 * dialog routing and the trace/skill fetches can be exercised.
 */
function workspaceWithSkillAndTurnIds(): TaskWorkspace {
  const ws = workspaceWithReturnLoop();
  const withTurnIds = ws.nodes.map((node) =>
    node.kind === 'result' ? { ...node, turnId: `turn-${node.id}` } : node,
  );
  const skillNode: WorkspaceNode = {
    id: 'rl-writer-skill-1',
    sequence: 9,
    agentId: WRITER_AGENT_ID,
    kind: 'skill',
    title: SKILL_CHAPTER_WRITING_ID,
    body: '8f3a2b1c4d5e',
    status: 'confirmed',
    attemptCount: 1,
    inputVersion: null,
    turnId: null,
  };
  return { ...ws, nodes: [...withTurnIds, skillNode] };
}
