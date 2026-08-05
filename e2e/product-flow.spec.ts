import { expect, test } from '@playwright/test';
import {
  clearMockNamespace,
  createTaskThroughUi,
  selectScenario,
  TEST_IDS,
  MOCK_STORAGE,
  TEMPLATE_LINK_NAME,
  REVIEWER_LANE_NAME,
  uiEvidencePath,
  WRITER_LANE_NAME,
} from './test-ids';

test.beforeEach(async ({ page }) => {
  await clearMockNamespace(page);
});

const isDesktop = (projectName: string): boolean => projectName.startsWith('desktop');

test('clicks through template, task creation, return loop and V2 reading', async ({
  page,
}, testInfo) => {
  test.skip(!isDesktop(testInfo.project.name), 'desktop-viewport verbatim flow');
  await page.goto('/dev/progress');
  await page.getByLabel('下一次任务的演示脚本').selectOption('review_return_v2');
  await page.goto('/templates');
  await page.getByRole('link', { name: '知乎单章生产' }).click();
  await page.getByRole('link', { name: '使用此模板创建任务' }).click();
  await page.getByLabel('任务名称').fill('第一章产品形态验收');
  await page.getByLabel('章节要求').fill('以第一人称推进冲突并完成返修');
  await page.getByLabel('原始素材').fill('家族聚会中出现一封来源不明的旧信。');
  await page.getByRole('button', { name: '创建任务' }).click();
  await page.getByRole('button', { name: '开始生产' }).click();
  await expect(page.getByText('已完成')).toBeVisible();
  // The version chain lives in the on-demand artifacts drawer: open it.
  await page.getByRole('button', { name: '产物', exact: true }).click();
  // exact:true mirrors the frozen jsdom assertions: the drawer version button
  // is the only element whose full text is exactly "V2" (turn summaries read
  // "产物 V2", artifact titles "第一章 旧信疑云 V2").
  await expect(page.getByText('V2', { exact: true })).toBeVisible();
  // Nine canvas anchors: the eight interaction nodes of the return loop plus
  // the one skill step loaded before the writer's first result.
  await expect(page.getByTestId(TEST_IDS.workspaceNode)).toHaveCount(9);
  // Merged into one turn card per turn: four input/result turns.
  await expect(page.getByTestId(TEST_IDS.workspaceTurn)).toHaveCount(4);
});

test('completes the same flow at mobile width with overlay drawers', async ({
  page,
}, testInfo) => {
  test.skip(isDesktop(testInfo.project.name), 'mobile-viewport flow');
  await page.goto('/dev/progress');
  await page.getByLabel('下一次任务的演示脚本').selectOption('review_return_v2');
  await page.goto('/templates');
  await page.getByRole('link', { name: '知乎单章生产' }).click();
  await page.getByRole('link', { name: '使用此模板创建任务' }).click();
  await page.getByLabel('任务名称').fill('第一章产品形态验收（移动端）');
  await page.getByLabel('章节要求').fill('以第一人称推进冲突并完成返修');
  await page.getByLabel('原始素材').fill('家族聚会中出现一封来源不明的旧信。');
  await page.getByRole('button', { name: '创建任务' }).click();
  // Both drawers start closed at every width, so the start control is
  // immediately reachable — no backdrop dismissal needed.
  await expect(page.locator('.fc-drawer-backdrop')).toHaveCount(0);
  await page.getByRole('button', { name: '开始生产' }).click();
  await expect(page.getByText('已完成')).toBeVisible();
  await page.getByRole('button', { name: '产物', exact: true }).click();
  await expect(page.getByText('V2', { exact: true })).toBeVisible();
  // Unified overlay treatment: the drawer covers the full-width canvas
  // instead of pushing it, at mobile width exactly as on desktop.
  const drawer = page.getByRole('complementary', { name: '产物版本' });
  await expect(drawer).toHaveCSS('position', 'fixed');
  await expect(page.locator('.fc-drawer-backdrop')).toBeVisible();
  await expect(page.getByTestId(TEST_IDS.workspaceCanvas)).toBeVisible();
});

test('both drawers start closed and open as overlay panels', async ({ page }) => {
  await selectScenario(page, 'happy_path');
  await createTaskThroughUi(page, '抽屉默认态验收');
  await expect(page.getByRole('complementary', { name: '任务配置' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: '产物版本' })).toHaveCount(0);
  await expect(page.locator('.fc-drawer-backdrop')).toHaveCount(0);

  await page.getByRole('button', { name: '产物', exact: true }).click();
  const artifacts = page.getByRole('complementary', { name: '产物版本' });
  await expect(artifacts).toBeVisible();
  await expect(artifacts).toHaveCSS('position', 'fixed');
  await expect(page.locator('.fc-drawer-backdrop')).toBeVisible();

  // The open overlay intercepts pointer events by design: dismiss it through
  // its own close control before opening the other drawer.
  await page.getByRole('button', { name: '关闭产物抽屉' }).click();
  await expect(artifacts).toHaveCount(0);
  await page.getByRole('button', { name: '配置', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '任务配置' })).toBeVisible();
});

test('renders the writer skill chip on its turn card and opens the skill dialog', async ({
  page,
}, testInfo) => {
  test.skip(!isDesktop(testInfo.project.name), 'desktop-viewport skill node flow');
  await selectScenario(page, 'happy_path');
  await createTaskThroughUi(page, '技能节点验收');
  await page.getByRole('button', { name: '开始生产' }).click();
  await expect(page.getByText('已完成')).toBeVisible();
  // Five canvas anchors: the four interaction nodes of the happy path plus
  // the one skill step, merged into two turn cards.
  await expect(page.getByTestId(TEST_IDS.workspaceNode)).toHaveCount(5);
  await expect(page.getByTestId(TEST_IDS.workspaceTurn)).toHaveCount(2);
  const skillChip = page.getByRole('button', { name: /^技能:/ });
  await expect(skillChip).toBeVisible();
  await skillChip.click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('both dynamic Agent headings are reachable through horizontal scrolling', async ({
  page,
}, testInfo) => {
  await selectScenario(page, 'happy_path');
  await createTaskThroughUi(page, '画布横向滚动验收');
  const canvas = page.getByTestId(TEST_IDS.workspaceCanvas);
  const writerHeading = page.getByRole('heading', { name: WRITER_LANE_NAME });
  const reviewerHeading = page.getByRole('heading', { name: REVIEWER_LANE_NAME });
  await expect(writerHeading).toBeAttached();
  await expect(reviewerHeading).toBeAttached();
  await canvas.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await expect(writerHeading).toBeInViewport();
  // Lane headings are compact: both stay visible at the origin even where the
  // lane bodies overflow; at narrow widths the canvas itself must scroll.
  await expect(reviewerHeading).toBeInViewport();
  if (!isDesktop(testInfo.project.name)) {
    const scrollable = await canvas.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    );
    expect(scrollable).toBe(true);
  }
  await canvas.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(reviewerHeading).toBeInViewport();
});

test('opening either overlay drawer at mobile width keeps the selected turn', async ({
  page,
}, testInfo) => {
  test.skip(isDesktop(testInfo.project.name), 'mobile overlay drawer check');
  await selectScenario(page, 'happy_path');
  await createTaskThroughUi(page, '抽屉选中保持验收');
  await page.getByRole('button', { name: '开始生产' }).click();
  const firstTurn = page.getByTestId(TEST_IDS.workspaceTurn).first();
  await expect(firstTurn).toBeVisible();
  await firstTurn.getByRole('button', { name: '输入' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // The dialog backdrop intercepts pointer events, so drive the drawer
  // toggles through keyboard focus — the same controls a keyboard user hits.
  await page.getByRole('button', { name: '配置', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: '任务配置' })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(firstTurn).toHaveClass(/fc-node--selected/);
  // Drawers start closed; pin every step of an open → close → open cycle.
  const artifactsToggle = page.getByRole('button', { name: '产物', exact: true });
  await artifactsToggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: '产物版本' })).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: '产物版本' })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: '产物版本' })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(firstTurn).toHaveClass(/fc-node--selected/);
});

test('every form control exposes an accessible name', async ({ page }) => {
  await page.goto('/tasks/new?template=zhihu-single-chapter');
  await expect(page.getByLabel('任务名称')).toBeVisible();
  for (const control of await page.locator('input, textarea, select, button').all()) {
    await expect(control).toHaveAccessibleName(/.+/);
  }
  await page.goto('/dev/progress');
  await expect(page.getByLabel('下一次任务的演示脚本')).toBeVisible();
  for (const control of await page.locator('input, textarea, select, button').all()) {
    await expect(control).toHaveAccessibleName(/.+/);
  }
});

test('keyboard focus returns to the turn action after closing its dialog', async ({ page }) => {
  await selectScenario(page, 'happy_path');
  await createTaskThroughUi(page, '焦点归还验收');
  await page.getByRole('button', { name: '开始生产' }).click();
  const firstTurn = page.getByTestId(TEST_IDS.workspaceTurn).first();
  await expect(firstTurn).toBeVisible();
  const openInput = firstTurn.getByRole('button', { name: '输入' });
  await openInput.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(openInput).toBeFocused();
});

test('reduced-motion preference removes the active turn animation', async ({
  page,
}, testInfo) => {
  test.skip(!isDesktop(testInfo.project.name), 'desktop animation check');
  await selectScenario(page, 'review_return_v2');
  await createTaskThroughUi(page, '动效降级验收');
  await page.getByRole('button', { name: '开始生产' }).click();
  const active = page.locator('.fc-turn--active').first();
  await expect(active).toBeVisible();
  const defaultAnimation = await active.evaluate((element) => getComputedStyle(element).animationName);
  expect(defaultAnimation).toBe('fc-node-pulse');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedActive = page.locator('.fc-turn--active').first();
  await expect(reducedActive).toBeVisible();
  const reducedAnimation = await reducedActive.evaluate(
    (element) => getComputedStyle(element).animationName,
  );
  expect(reducedAnimation).toBe('none');
});

test.describe('ui evidence screenshots (desktop 1440×1000)', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(!isDesktop(testInfo.project.name), 'desktop-only evidence screenshots');
  });

  test('captures template detail, task list, running and completed production', async ({
    page,
  }) => {
    await page.goto('/templates/zhihu-single-chapter');
    await expect(page.getByRole('heading', { name: TEMPLATE_LINK_NAME })).toBeVisible();
    await page.screenshot({ path: uiEvidencePath('template-detail.png'), fullPage: true });

    await selectScenario(page, 'review_return_v2');
    const taskId = await createTaskThroughUi(page, '第一章截图验收');
    await page.goto('/tasks');
    await expect(page.getByRole('heading', { name: '第一章截图验收' })).toBeVisible();
    await page.screenshot({ path: uiEvidencePath('task-list.png'), fullPage: true });

    await page.goto(`/tasks/${taskId}`);
    await page.getByRole('button', { name: '开始生产' }).click();
    // The version chain lives in the on-demand artifacts drawer.
    await page.getByRole('button', { name: '产物', exact: true }).click();
    await expect(page.getByText('V1', { exact: true })).toBeVisible();
    await expect(page.getByText('运行中')).toBeVisible();
    await page.screenshot({ path: uiEvidencePath('production-running.png') });

    await expect(page.getByText('V2', { exact: true })).toBeVisible();
    await expect(page.getByText('已完成')).toBeVisible();
    await page.getByText('V2', { exact: true }).click();
    await expect(page.getByTestId(TEST_IDS.artifactPreview)).toContainText('V2');
    await page.screenshot({ path: uiEvidencePath('production-completed-v2.png') });
  });

  test('captures the development progress console', async ({ page }) => {
    await page.goto('/dev/progress');
    await expect(page.getByRole('heading', { name: '开发进度' })).toBeVisible();
    await expect(page.getByLabel('下一次任务的演示脚本')).toBeVisible();
    await page.screenshot({ path: uiEvidencePath('development-progress.png'), fullPage: true });
  });
});

test('captures the completed production page at mobile width', async ({ page }, testInfo) => {
  test.skip(isDesktop(testInfo.project.name), 'mobile-only evidence screenshot');
  await selectScenario(page, 'review_return_v2');
  await createTaskThroughUi(page, '第一章移动端截图验收');
  await page.getByRole('button', { name: '开始生产' }).click();
  await page.getByRole('button', { name: '产物', exact: true }).click();
  await expect(page.getByText('V2', { exact: true })).toBeVisible();
  await expect(page.getByText('已完成')).toBeVisible();
  await page.screenshot({ path: uiEvidencePath('production-completed-mobile.png') });
});

test('streams live text into the active turn card while running (plan C)', async ({
  page,
}) => {
  await selectScenario(page, 'happy_path');
  await createTaskThroughUi(page, '流式预览验收');

  // The stream preview is transient (it only exists inside the mock's
  // generation windows), so observe it from inside the page at 50ms — a
  // sampling cadence the outer test loop cannot reliably match.
  await page.evaluate(() => {
    const obs = { seen: 0, samples: [] as string[] };
    (window as unknown as { __streamObs: typeof obs }).__streamObs = obs;
    window.setInterval(() => {
      const stream = document.querySelector('.fc-turn__stream');
      if (stream !== null) {
        obs.seen += 1;
        const text = document.querySelector('.fc-turn__stream-text')?.textContent ?? '';
        if (text.length > 0 && obs.samples[obs.samples.length - 1] !== text) {
          obs.samples.push(text);
        }
      }
    }, 50);
  });

  await page.getByRole('button', { name: '开始生产' }).click();
  await expect(page.getByText('已完成')).toBeVisible();

  const obs = await page.evaluate(
    () => (window as unknown as { __streamObs: { seen: number; samples: string[] } }).__streamObs,
  );
  // The running card rendered the preview...
  expect(obs.seen).toBeGreaterThan(0);
  expect(obs.samples.length).toBeGreaterThan(0);
  // ...and it really streamed: some observed snapshot is a proper prefix of
  // the finally committed result body (partial text, not the full block).
  const bodies = await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    const out: string[] = [];
    if (raw !== null) {
      const env = JSON.parse(raw) as {
        data: Record<string, { events: Array<{ type: string; node?: { body?: string } }> }>;
      };
      for (const record of Object.values(env.data)) {
        for (const event of record.events ?? []) {
          if (event.type === 'agent_result' && typeof event.node?.body === 'string') {
            out.push(event.node.body);
          }
        }
      }
    }
    return out;
  }, MOCK_STORAGE.tasks);
  const streamedPartial = obs.samples.some((sample) =>
    bodies.some((body) => sample.length < body.length && body.startsWith(sample)),
  );
  expect(streamedPartial).toBe(true);
  // Completed turns collapse back: no stream preview remains.
  await expect(page.locator('.fc-turn__stream')).toHaveCount(0);
});
