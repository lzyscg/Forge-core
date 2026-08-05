import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

/**
 * Stable selectors and documented storage keys shared by the Phase A browser
 * gates. Only semantic roles and the testids the product already exposes are
 * used here; nothing in the formal routes is query-parameter-driven or
 * test-only. Mock persistence is touched exclusively through the documented
 * `forge-core:mock:v1:*` storage namespace (src/client/mock/mock-schema.ts),
 * never through React internals.
 */

/** data-testid values the product canvas and drawers already render. */
export const TEST_IDS = {
  workspaceCanvas: 'workspace-canvas',
  workspaceNode: 'workspace-node',
  workspaceTurn: 'workspace-turn',
  artifactPreview: 'artifact-preview',
} as const;

/** The documented versioned mock storage namespace (mock-schema.ts). */
export const MOCK_STORAGE = {
  prefix: 'forge-core:mock:v1:',
  catalog: 'forge-core:mock:v1:catalog',
  tasks: 'forge-core:mock:v1:tasks',
  development: 'forge-core:mock:v1:development',
} as const;

/** Fixture template and lane names the frozen e2e flow walks through. */
export const TEMPLATE_LINK_NAME = '知乎单章生产';
export const WRITER_LANE_NAME = '章节写作';
export const REVIEWER_LANE_NAME = '章节审核';

/** Absolute path for a semantic evidence screenshot under test-results/. */
export function uiEvidencePath(fileName: string): string {
  const directory = fileURLToPath(new URL('../test-results/ui-evidence', import.meta.url));
  mkdirSync(directory, { recursive: true });
  return join(directory, fileName);
}

/**
 * Remove only keys inside the documented mock namespace. Playwright gives
 * every test a fresh browser context (isolated storage) already; this explicit
 * clearing keeps the isolation contract visible and resilient to reused
 * contexts. Must run after the page has an origin.
 */
export async function clearMockNamespace(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate((prefix) => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(prefix)) window.localStorage.removeItem(key);
    }
  }, MOCK_STORAGE.prefix);
}

/** Choose the deterministic demonstration script for the next created task. */
export async function selectScenario(page: Page, scenarioId: string): Promise<void> {
  await page.goto('/dev/progress');
  await page.getByLabel('下一次任务的演示脚本').selectOption(scenarioId);
}

/**
 * Walk the formal creation path: template list → detail → new-task form →
 * production page. Returns the created task id parsed from the URL.
 */
export async function createTaskThroughUi(page: Page, taskName: string): Promise<string> {
  await page.goto('/templates');
  await page.getByRole('link', { name: TEMPLATE_LINK_NAME }).click();
  await page.getByRole('link', { name: '使用此模板创建任务' }).click();
  await page.getByLabel('任务名称').fill(taskName);
  await page.getByLabel('章节要求').fill('以第一人称推进冲突并完成返修');
  await page.getByLabel('原始素材').fill('家族聚会中出现一封来源不明的旧信。');
  await page.getByRole('button', { name: '创建任务' }).click();
  await page.waitForURL(/\/tasks\/task-/);
  const taskId = new URL(page.url()).pathname.split('/').pop();
  if (!taskId) throw new Error(`无法从 ${page.url()} 解析任务 id`);
  return taskId;
}

/**
 * Select the refresh_recovery script, create a task through the formal UI and
 * start it; resolves once the production page shows the start is in flight.
 * The page stays on `/tasks/<taskId>` so callers can observe V1, reload and
 * watch the recovery continue to the final output.
 */
export async function createRunningRefreshScenario(page: Page): Promise<string> {
  await selectScenario(page, 'refresh_recovery');
  const taskId = await createTaskThroughUi(page, '刷新恢复验收任务');
  // At narrow widths the default-open artifacts drawer overlays the start
  // control; a real user dismisses it through the shared backdrop first.
  const backdrop = page.locator('.fc-drawer-backdrop');
  if (await backdrop.isVisible()) {
    await backdrop.click({ position: { x: 8, y: 400 } });
  }
  await page.getByRole('button', { name: '开始生产' }).click();
  // Reopen the artifacts drawer when the dismissal closed it, so callers can
  // observe the published version chain (V1..Vn) on every viewport.
  const artifactsDrawer = page.getByRole('complementary', { name: '产物版本' });
  if (!(await artifactsDrawer.isVisible())) {
    await page.getByRole('button', { name: '产物', exact: true }).click();
  }
  await expect(page.getByText('运行中')).toBeVisible();
  return taskId;
}

/**
 * Write one schema-invalid task record into the documented tasks envelope so
 * MockStore flags exactly that record corrupt while siblings stay readable.
 * Touches only the `forge-core:mock:v1:tasks` key through standard Storage
 * APIs; the envelope shape mirrors mock-schema.ts StorageEnvelope.
 */
export async function injectCorruptTask(page: Page, taskId: string): Promise<void> {
  await page.evaluate(
    ({ key, id }) => {
      interface TasksEnvelope {
        schemaVersion: 1;
        revision: number;
        updatedAt: string;
        data: Record<string, unknown>;
      }
      const raw = window.localStorage.getItem(key);
      const envelope: TasksEnvelope =
        raw !== null
          ? (JSON.parse(raw) as TasksEnvelope)
          : { schemaVersion: 1, revision: 0, updatedAt: new Date().toISOString(), data: {} };
      // Missing every taskRecordSchema field: isolated as corrupt on read.
      envelope.data[id] = { corrupted: 'e2e injected record without schema fields' };
      window.localStorage.setItem(
        key,
        JSON.stringify({
          schemaVersion: 1,
          revision: envelope.revision + 1,
          updatedAt: new Date().toISOString(),
          data: envelope.data,
        }),
      );
    },
    { key: MOCK_STORAGE.tasks, id: taskId },
  );
}
