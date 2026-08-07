/**
 * Phase E browser gate (plan Task E6): the observable process surface —
 * skill nodes with full Skill text, result-node Turn traces (thinking,
 * workspace tool calls, results and final text), the workspace/trace files
 * on disk, and the same-input clone — all driven through the real HTTP
 * routes and the scripted FakeAgentRuntime.
 *
 * The scripted loop is one alpha Turn: draft into the agent workspace,
 * publish the draft through `workspaceFile` (content stays null), load the
 * declared Skill and submit the published version. Beta stays neutral (no
 * script): the artifact hand-off input node exists, but the final
 * submission completes the task before beta could run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  FIXTURE_SKILL_ALPHA,
  RUNTIME_INPUT_FIELD_ID,
  startRuntimeCoreServer,
  workspaceTraceScripts,
  WORKSPACE_DRAFT_CONTENT,
  WORKSPACE_DRAFT_PATH,
  WORKSPACE_TRACE_THINKING,
  type RuntimeCoreHarness,
} from './runtime-harness';
import { TEST_IDS } from './test-ids';

const TASK_NAME = '工作区与过程记录验收任务';

/** Mobile widths open the artifacts drawer over the start control. */
async function dismissDrawerBackdrop(page: Page): Promise<void> {
  const backdrop = page.locator('.fc-drawer-backdrop');
  if (await backdrop.isVisible()) {
    await backdrop.click({ position: { x: 8, y: 400 } });
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

/** Runs the scripted workspace Turn through start and completion. */
async function runWorkspaceTraceTask(
  page: Page,
  harness: RuntimeCoreHarness,
): Promise<string> {
  const taskId = await harness.createTaskViaApi(TASK_NAME);
  await gotoProductionPage(page, harness, taskId);
  await expect(page.getByText('待运行')).toBeVisible();
  await dismissDrawerBackdrop(page);
  await page.getByRole('button', { name: '开始生产' }).click();
  await expect(page.getByText('已完成')).toBeVisible();
  return taskId;
}

test('process trace: the skill chip opens a dialog with the full Skill text', async ({
  page,
}) => {
  const harness = await startRuntimeCoreServer({ scripts: workspaceTraceScripts() });
  try {
    const taskId = await runWorkspaceTraceTask(page, harness);

    // Canvas: the skill load renders as a chip on its turn card (label
    // 技能:<name>, resolved through the frozen template agent skills).
    const skillChip = page.getByRole('button', { name: '技能:Alpha 技能' });
    await expect(skillChip).toBeVisible();
    await skillChip.click();

    // Dialog: the snapshot Skill full text and the 12-hex version prefix.
    const dialog = page.getByRole('dialog', { name: 'alpha-skill' });
    await expect(dialog).toBeVisible();
    const keySentence = FIXTURE_SKILL_ALPHA.split('\n')
      .map((line) => line.trim())
      .find((line) => line.includes('load_skill'));
    expect(keySentence).toBeTruthy();
    await expect(dialog.getByText(keySentence as string)).toBeVisible();
    await expect(dialog.locator('.fc-node-detail__value')).toHaveText(/^[0-9a-f]{12}$/);
  } finally {
    await harness.close();
  }
});

test('process trace: the turn card [运行过程] opens the trace with tool and text steps', async ({
  page,
}) => {
  const harness = await startRuntimeCoreServer({ scripts: workspaceTraceScripts() });
  try {
    const taskId = await runWorkspaceTraceTask(page, harness);

    const alphaTurn = page
      .getByTestId(TEST_IDS.workspaceTurn)
      .filter({ hasText: '执行 Agent Alpha' });
    await alphaTurn.getByRole('button', { name: '运行过程' }).click();

    const dialog = page.getByRole('dialog', { name: '执行 Agent Alpha' });
    await expect(dialog).toBeVisible();

    // Provider thinking is never durable or displayed (semantic audit P0,
    // plan 2026-08-07): the scripted thinking sentence must not surface.
    await expect(dialog.locator('.fc-trace__section--thinking')).toHaveCount(0);
    await expect(dialog.getByText('思维', { exact: true })).toHaveCount(0);
    await expect(dialog.getByText(WORKSPACE_TRACE_THINKING)).toHaveCount(0);

    // Tool call: write_workspace with the draft path in its parameters.
    await expect(
      dialog.getByRole('heading', { name: '工具调用：write_workspace' }),
    ).toBeVisible();
    const callParams = dialog
      .locator('.fc-trace__section pre')
      .filter({ hasText: '"path": "draft/v1.md"' });
    await expect(callParams).toBeVisible();

    // Tool result short receipt.
    await expect(
      dialog.getByRole('heading', { name: '工具返回：write_workspace' }),
    ).toBeVisible();
    await expect(dialog.locator('pre', { hasText: /draft\/v1\.md \(\d+ bytes\)/ })).toBeVisible();

    // Final public text closes the trace.
    await expect(dialog.getByText('正文', { exact: true })).toBeVisible();
    const workspace = await harness.getWorkspaceViaApi(taskId);
    expect(workspace.task.status).toBe('completed');
  } finally {
    await harness.close();
  }
});

test('process trace: workspace draft, trace file and V1 content agree on disk', async ({
  page,
}) => {
  const harness = await startRuntimeCoreServer({ scripts: workspaceTraceScripts() });
  try {
    const taskId = await runWorkspaceTraceTask(page, harness);
    const workspace = await harness.getWorkspaceViaApi(taskId);

    // The workspace draft file exists under the alpha workspace with the
    // exact scripted content.
    const draftFile = join(
      harness.paths.taskWorkspaceRoot(taskId, 'agent-alpha'),
      WORKSPACE_DRAFT_PATH,
    );
    expect(existsSync(draftFile)).toBe(true);
    expect(readFileSync(draftFile, 'utf8')).toBe(WORKSPACE_DRAFT_CONTENT);

    // The served result node carries the Turn id; the trace file exists and
    // holds the tool/text entries in order (never the scripted thinking).
    const resultNode = workspace.nodes.find((node) => node.kind === 'result');
    expect(resultNode).toBeDefined();
    const turnId = resultNode?.turnId ?? null;
    expect(turnId).not.toBeNull();
    const traceFile = harness.paths.taskTraceFile(taskId, turnId as string);
    expect(existsSync(traceFile)).toBe(true);
    const trace = JSON.parse(readFileSync(traceFile, 'utf8')) as {
      turnId: string;
      entries: Array<{ kind: string; text?: string }>;
    };
    expect(trace.turnId).toBe(turnId);
    expect(trace.entries.map((entry) => entry.kind)).toEqual([
      'tool_call',
      'tool_result',
      'text',
    ]);

    // V1 was resolved from the workspace draft: identical content.
    expect(workspace.artifacts).toHaveLength(1);
    expect(workspace.artifacts[0].version).toBe(1);
    expect(workspace.artifacts[0].files[0].content).toBe(WORKSPACE_DRAFT_CONTENT);
    expect(workspace.artifacts[0].final).toBe(true);

    // File/projection parity still holds for the workspace-publish shape.
    await harness.reconcileWithWorkspace(taskId);
  } finally {
    await harness.close();
  }
});

test('process trace: clone reruns the same frozen input from the production page', async ({
  page,
}) => {
  const harness = await startRuntimeCoreServer({ scripts: workspaceTraceScripts() });
  try {
    const taskId = await runWorkspaceTraceTask(page, harness);
    const sourceWorkspace = await harness.getWorkspaceViaApi(taskId);

    await page.getByRole('button', { name: '用当前模板重跑' }).click();
    await page.waitForURL((url) => url.pathname !== `/tasks/${taskId}`);
    const cloneId = new URL(page.url()).pathname.split('/').pop();
    expect(cloneId).toBeTruthy();
    expect(cloneId).not.toBe(taskId);

    // The clone is a fresh pending-run task on the same frozen input.
    await expect(page.getByText('待运行')).toBeVisible();
    const cloneWorkspace = await harness.getWorkspaceViaApi(cloneId as string);
    expect(cloneWorkspace.task.status).toBe('ready');
    expect(cloneWorkspace.task.name).toBe(`${TASK_NAME}（重跑）`);
    expect(cloneWorkspace.frozenInput).toEqual(sourceWorkspace.frozenInput);
    expect(cloneWorkspace.frozenInput).toEqual({
      [RUNTIME_INPUT_FIELD_ID]: '运行时闭环验收的开场输入。',
    });
    expect(cloneWorkspace.templateVersion).toBe(sourceWorkspace.templateVersion);

    // Back on the list, the completed source offers 重跑; the fresh clone
    // (pending run) does not.
    await page.goto(`${harness.url}/tasks`);
    await expect(
      page.getByRole('button', { name: '重跑', exact: true }),
    ).toHaveCount(1);
  } finally {
    await harness.close();
  }
});
