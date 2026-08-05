import { expect, test } from '@playwright/test';
import { clearMockNamespace, createRunningRefreshScenario, injectCorruptTask } from './test-ids';

test.beforeEach(async ({ page }) => {
  await clearMockNamespace(page);
});

test('restores a running task after refresh and isolates corrupt mock data', async ({
  page,
}) => {
  // The shared helper dismisses mobile overlay drawers before starting.
  await createRunningRefreshScenario(page);
  await expect(page.getByText('V1', { exact: true })).toBeVisible();
  await page.reload();
  // The artifacts drawer starts closed after the refresh; reopen it to watch
  // the resumed run finish.
  await page.getByRole('button', { name: '产物', exact: true }).click();
  // A refreshed browser rebuilds the gateway and resumes the persisted run
  // schedule from its last confirmed step — no events are replayed.
  await expect(page.getByText('V2', { exact: true })).toBeVisible();
  await expect(page.getByText('已完成')).toBeVisible();
  await injectCorruptTask(page, 'task-corrupt');
  await page.goto('/tasks');
  // exact:true isolates the status chip text from the sibling diagnostic
  // sentence (which carries a trailing 。).
  await expect(page.getByText('任务文件损坏、只能查看诊断', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '模板' })).toBeVisible();
});
