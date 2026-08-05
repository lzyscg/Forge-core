/**
 * Phase C browser gate, part 1 (plan Task 6 Steps 1/3): the Fake full loop,
 * retry/human lifecycle and error isolation — all driven through the real
 * HTTP routes and the scripted FakeAgentRuntime, with every event committed
 * by the real ActionCommitter (never hand-broadcast).
 *
 * The harness boots one development-mode server with the neutral two-agent
 * fixture; the page binds the HttpGateway via VITE_FORGE_CORE_MODE=http on
 * the harness origin. After each flow the committed files on disk must
 * reconcile exactly with the served workspace projection.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  fullLoopScripts,
  humanInputScripts,
  malformedActionScripts,
  manualRetryScripts,
  singleCompletionScripts,
  startRuntimeCoreServer,
  transientRetryScripts,
  type RuntimeCoreHarness,
} from './runtime-harness';
import { TEST_IDS } from './test-ids';

/** Mobile widths open the artifacts drawer over the start control. */
async function dismissDrawerBackdrop(page: Page): Promise<void> {
  const backdrop = page.locator('.fc-drawer-backdrop');
  if (await backdrop.isVisible()) {
    await backdrop.click({ position: { x: 8, y: 400 } });
  }
}

async function openArtifactsDrawerIfNeeded(
  page: Page,
): Promise<void> {
  const drawer = page.getByRole('complementary', { name: '产物版本' });
  if (!(await drawer.isVisible())) {
    await page.getByRole('button', { name: '产物', exact: true }).click();
  }
}

async function gotoProductionPage(
  page: Page,
  harness: RuntimeCoreHarness,
  taskId: string,
): Promise<void> {
  // The formal path: task list -> 查看任务. Entering through the list also
  // registers the task with the page's HttpGateway (listTasks), which the
  // watchTask subscription on the production page requires for live polling.
  await page.goto(`${harness.url}/tasks`);
  await page.locator(`a[href="/tasks/${taskId}"]`).click();
  await page.waitForURL(`${harness.url}/tasks/${taskId}`);
  await expect(page.getByTestId(TEST_IDS.workspaceCanvas)).toBeVisible();
}

test('runtime loop: alpha/beta full loop completes with V1/V2 and file parity', async ({
  page,
}) => {
  const harness = await startRuntimeCoreServer({ scripts: fullLoopScripts() });
  try {
    const taskId = await harness.createTaskViaApi('运行时闭环验收任务');
    await gotoProductionPage(page, harness, taskId);
    await expect(page.getByText('待运行')).toBeVisible();

    await dismissDrawerBackdrop(page);
    await page.getByRole('button', { name: '开始生产' }).click();
    await expect(page.getByText('已完成')).toBeVisible();

    // Canvas: both lanes, every committed node and every executed route edge.
    await expect(page.getByRole('heading', { name: '执行 Agent Alpha' })).toBeAttached();
    await expect(page.getByRole('heading', { name: '执行 Agent Beta' })).toBeAttached();
    await expect(page.getByTestId(TEST_IDS.workspaceNode)).toHaveCount(9);
    await expect(page.locator('.fc-flow-overlay > path')).toHaveCount(3);

    // Artifacts drawer shows the full version chain.
    await openArtifactsDrawerIfNeeded(page);
    await expect(page.getByText('V1', { exact: true })).toBeVisible();
    await expect(page.getByText('V2', { exact: true })).toBeVisible();

    // System finality + file/API parity.
    const workspace = await harness.getWorkspaceViaApi(taskId);
    expect(workspace.task.status).toBe('completed');
    expect(workspace.artifacts.map((artifact) => artifact.version)).toEqual([1, 2]);
    expect(workspace.artifacts.find((artifact) => artifact.version === 2)?.final).toBe(true);
    expect(workspace.executedRoutes.map((route) => route.kind).sort()).toEqual([
      'artifact',
      'artifact',
      'message',
    ]);

    const reconciliation = await harness.reconcileWithWorkspace(taskId);
    expect(reconciliation.nodeCount).toBe(9);
    expect(reconciliation.artifactVersions).toEqual([1, 2]);
    expect(reconciliation.routeKinds.sort()).toEqual(['artifact', 'artifact', 'message']);

    // The scripted load_skill committed exactly one skill_loaded event.
    const projection = harness.readFileProjection(taskId);
    const skillLoads = projection.events.filter((entry) => entry.event.type === 'skill_loaded');
    expect(skillLoads).toHaveLength(1);
    expect((skillLoads[0].event as unknown as { skillId: string }).skillId).toBe('alpha-skill');
  } finally {
    await harness.close();
  }
});

test('runtime loop: one transient failure auto-retries and completes', async ({ page }) => {
  const harness = await startRuntimeCoreServer({ scripts: transientRetryScripts() });
  try {
    const taskId = await harness.createTaskViaApi('瞬时重试验收任务');
    await gotoProductionPage(page, harness, taskId);
    await dismissDrawerBackdrop(page);
    await page.getByRole('button', { name: '开始生产' }).click();
    await expect(page.getByText('已完成')).toBeVisible();
    // The input node folds both attempts into one canvas node (the result
    // node carries the same attemptCount — assert at least one rendering).
    await expect(page.getByText('尝试 2 次').first()).toBeVisible();

    const workspace = await harness.getWorkspaceViaApi(taskId);
    expect(workspace.task.status).toBe('completed');

    const projection = harness.readFileProjection(taskId);
    const failures = projection.events.filter(
      (entry) => entry.event.type === 'agent_attempt_failed',
    );
    expect(failures).toHaveLength(1);
    expect((failures[0].event as unknown as { retryable: boolean }).retryable).toBe(true);
    const scheduled = projection.events.filter(
      (entry) => entry.event.type === 'retry_scheduled',
    );
    expect(scheduled).toHaveLength(1);
    expect((scheduled[0].event as unknown as { attempt: number }).attempt).toBe(2);

    await harness.reconcileWithWorkspace(taskId);
  } finally {
    await harness.close();
  }
});

test('runtime loop: exhausted automatic retries wait for one manual retry', async ({
  page,
}) => {
  const harness = await startRuntimeCoreServer({ scripts: manualRetryScripts() });
  try {
    const taskId = await harness.createTaskViaApi('手动重试验收任务');
    await gotoProductionPage(page, harness, taskId);
    await dismissDrawerBackdrop(page);
    await page.getByRole('button', { name: '开始生产' }).click();
    // Three transient failures: two automatic retries, then parked.
    await expect(page.getByText('运行失败、可以重试')).toBeVisible();
    await expect(page.getByRole('button', { name: '重试' })).toBeVisible();

    await page.getByRole('button', { name: '重试' }).click();
    await expect(page.getByText('已完成')).toBeVisible();
    await expect(page.getByText('尝试 4 次').first()).toBeVisible();

    const projection = harness.readFileProjection(taskId);
    const failures = projection.events.filter(
      (entry) => entry.event.type === 'agent_attempt_failed',
    );
    expect(failures).toHaveLength(3);
    expect(
      failures.map((entry) => (entry.event as unknown as { retryable: boolean }).retryable),
    ).toEqual([true, true, false]);

    await harness.reconcileWithWorkspace(taskId);
  } finally {
    await harness.close();
  }
});

test('runtime loop: human input pauses the task and the answer continues it', async ({
  page,
}) => {
  const harness = await startRuntimeCoreServer({ scripts: humanInputScripts() });
  try {
    const taskId = await harness.createTaskViaApi('人工输入验收任务');
    await gotoProductionPage(page, harness, taskId);
    await dismissDrawerBackdrop(page);
    await page.getByRole('button', { name: '开始生产' }).click();

    await expect(page.getByText('等待用户回答')).toBeVisible();
    await expect(page.getByText('请确认是否继续生产？')).toBeVisible();

    await page.getByLabel('回答').fill('确认继续。');
    await page.getByRole('button', { name: '提交回答' }).click();
    await expect(page.getByText('已完成')).toBeVisible();

    const workspace = await harness.getWorkspaceViaApi(taskId);
    expect(workspace.pendingHumanQuestion).toBeNull();

    const projection = harness.readFileProjection(taskId);
    const requests = projection.events.filter(
      (entry) => entry.event.type === 'human_requested',
    );
    const answers = projection.events.filter(
      (entry) => entry.event.type === 'human_answered',
    );
    expect(requests).toHaveLength(1);
    expect(answers).toHaveLength(1);
    expect((answers[0].event as unknown as { answer: string }).answer).toBe('确认继续。');

    await harness.reconcileWithWorkspace(taskId);
  } finally {
    await harness.close();
  }
});

test('runtime loop: a malformed action fails only its node and the next task still runs', async ({
  page,
}) => {
  const harness = await startRuntimeCoreServer({ scripts: malformedActionScripts() });
  try {
    // Task 1: the scripted route target is undeclared — the commit rejects the
    // whole action set, the node fails and the task parks for a manual retry.
    const brokenId = await harness.createTaskViaApi('非法动作隔离任务');
    await harness.startTask(brokenId);
    const broken = await harness.waitForStatus(brokenId, 'retryable_failure');
    expect(broken.artifacts).toEqual([]);
    expect(broken.nodes.filter((node) => node.status === 'failed')).toHaveLength(1);
    expect(broken.nodes.some((node) => node.kind === 'result')).toBe(false);

    // Task 2: with a clean script, the single global slot serves a full run.
    harness.setScripts(singleCompletionScripts());
    const healthyId = await harness.createTaskViaApi('隔离后正常任务');
    await gotoProductionPage(page, harness, healthyId);
    await dismissDrawerBackdrop(page);
    await page.getByRole('button', { name: '开始生产' }).click();
    await expect(page.getByText('已完成')).toBeVisible();

    const healthy = await harness.getWorkspaceViaApi(healthyId);
    expect(healthy.task.status).toBe('completed');
    expect(healthy.artifacts.at(-1)?.final).toBe(true);

    // The broken task stayed exactly where it parked.
    const stillBroken = await harness.getWorkspaceViaApi(brokenId);
    expect(stillBroken.task.status).toBe('retryable_failure');
    expect(stillBroken.artifacts).toEqual([]);

    await harness.reconcileWithWorkspace(healthyId);
    await harness.reconcileWithWorkspace(brokenId);
  } finally {
    await harness.close();
  }
});
