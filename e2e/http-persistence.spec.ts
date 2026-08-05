/**
 * Phase B browser gate (plan Task 6): the local file backend seen through the
 * real browser. The harness boots one persistent development-mode core server
 * over a single explicit temporary data root and the page binds to it via
 * VITE_FORGE_CORE_MODE=http — the config-level 4173 webServer stays unused by
 * this spec (every navigation targets harness.url).
 *
 * Case 1 (plan Step 1): create a task through the formal UI, seed a confirmed
 * V1/V2 history through the CoreService test APIs (never by touching files),
 * restart the server over the same data root and verify the projection is
 * rebuilt from disk.
 *
 * Case 2 (plan Step 2): spec §8.3 isolation through the browser — a broken
 * template source keeps the last valid cache usable (explicit reload fails
 * loud; after restart the catalog serves invalid_using_cache with a warning),
 * and one task corrupted while the server is stopped becomes the only
 * diagnostic row while healthy tasks and templates keep rendering.
 */
import { expect, test } from '@playwright/test';
import { ONE_TEMPLATE_ID } from '../src/server/test-support';
import { startPersistentCoreServer, createHttpTaskThroughUi } from './http-harness';

test('HTTP persistence: keeps templates, task snapshot and artifacts after server restart', async ({
  page,
}) => {
  const harness = await startPersistentCoreServer();
  try {
    const taskId = await createHttpTaskThroughUi(page, harness.url, 'HTTP 持久化验收任务');
    await harness.seedConfirmedWorkspaceWithTwoArtifacts(taskId);
    // The version chain lives in the on-demand artifacts drawer.
    await page.getByRole('button', { name: '产物', exact: true }).click();
    await expect(page.getByText('V2', { exact: true })).toBeVisible();
    await harness.restart();
    await page.reload();
    await page.getByRole('button', { name: '产物', exact: true }).click();
    await expect(page.getByText('V1', { exact: true })).toBeVisible();
    await expect(page.getByText('V2', { exact: true })).toBeVisible();
  } finally {
    await harness.close();
  }
});

test('HTTP persistence: isolates a broken template and one corrupt task after restart', async ({
  page,
}) => {
  const harness = await startPersistentCoreServer();
  try {
    // One healthy task through the formal UI, one destined for corruption
    // through the API; both carry confirmed V1/V2 histories.
    const healthyId = await createHttpTaskThroughUi(page, harness.url, '健康任务');
    await harness.seedConfirmedWorkspaceWithTwoArtifacts(healthyId);
    const corruptId = await harness.createTaskThroughApi('待损坏任务');
    await harness.seedConfirmedWorkspaceWithTwoArtifacts(corruptId);

    // Break the template source while the server runs: explicit reload must
    // fail loud and the last valid version must stay usable.
    harness.breakTemplateSource();
    const reloadResponse = await fetch(
      `${harness.url}/api/templates/${encodeURIComponent(ONE_TEMPLATE_ID)}/reload`,
      { method: 'POST' },
    );
    expect(reloadResponse.status).toBe(422);
    const reloadBody = (await reloadResponse.json()) as { error: { code: string } };
    expect(reloadBody.error.code).toBe('TEMPLATE_INVALID');

    await page.goto(`${harness.url}/templates/${ONE_TEMPLATE_ID}`);
    await page.getByRole('button', { name: '重新加载模板' }).click();
    await expect(page.getByText('重新加载模板失败。')).toBeVisible();
    await expect(page.getByText('校验通过')).toBeVisible();

    // Corrupt one committed event file while the server is stopped, then
    // rebuild over the same roots: only that task becomes a diagnostic row.
    await harness.restart(() => {
      harness.corruptFirstCommittedEvent(corruptId);
    });

    await page.goto(`${harness.url}/tasks`);
    await expect(
      page.getByText('任务文件损坏、只能查看诊断', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('任务数据损坏，需要人工检查任务目录。')).toBeVisible();
    await expect(page.getByRole('heading', { name: '健康任务' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '待损坏任务' })).toBeVisible();

    await page.goto(`${harness.url}/tasks/${healthyId}`);
    await page.getByRole('button', { name: '产物', exact: true }).click();
    await expect(page.getByText('V1', { exact: true })).toBeVisible();
    await expect(page.getByText('V2', { exact: true })).toBeVisible();

    // The broken source survives the restart through the last-valid cache.
    await page.goto(`${harness.url}/templates`);
    await expect(page.getByRole('link', { name: '双 Agent 协作模板' })).toBeVisible();
    await expect(page.getByText('校验失败、使用缓存版本')).toBeVisible();
  } finally {
    await harness.close();
  }
});
