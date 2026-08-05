import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForgeCoreGateway } from '../gateway/forge-core-gateway';
import type { DevelopmentGateway } from '../gateway/development-gateway';
import { TEMPLATE_ID } from '../mock/__fixtures__/zhihu-single-chapter';
import { BACKEND_CONNECTED_PHASE_B, CAPABILITIES } from '../mock/development-capabilities';
import type { DevelopmentEvidenceFile } from '../mock/development-evidence';
import {
  MemoryStorage,
  createFixedClock,
  seededStorage,
} from '../mock/mock-fixtures';
import { createMockGateway } from '../mock/mock-gateway';
import { MOCK_SCENARIOS } from '../mock/mock-scenarios';
import { MOCK_SCENARIO_IDS } from '../mock/mock-schema';
import { renderPage } from '../test-support';
import { DevelopmentProgressPage } from './development-progress-page';

type AnyGateway = ForgeCoreGateway & DevelopmentGateway;

function evidenceWith(
  overrides: Partial<DevelopmentEvidenceFile> = {},
): DevelopmentEvidenceFile {
  return {
    schemaVersion: 1,
    outcome: 'passed',
    observedAt: '2026-02-01T00:00:00.000Z',
    commit: 'abc1234',
    command: 'npm run verify:ui',
    passedCapabilities: CAPABILITIES.map(([id]) => id),
    ...overrides,
  };
}

function developmentGatewayWithPassingMockEvidence(): AnyGateway {
  return createMockGateway(new MemoryStorage(), createFixedClock(), {
    evidenceLoader: { load: async () => structuredClone(evidenceWith()) },
  });
}

function renderDevelopmentPage(gateway: AnyGateway = developmentGatewayWithPassingMockEvidence()) {
  return renderPage('/dev/progress', gateway);
}

async function capabilityRow(label: string): Promise<HTMLElement> {
  const toggle = await screen.findByRole('button', { name: label });
  const row = toggle.closest('li');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

function meterSection(heading: string): HTMLElement {
  const section = screen.getByText(heading).closest('section');
  expect(section).not.toBeNull();
  return section as HTMLElement;
}

describe('DevelopmentProgressPage', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exports the page component consumed by the router', () => {
    expect(DevelopmentProgressPage).toBeTypeOf('function');
  });

  it('shows the mock data source by default, only on this page', async () => {
    renderDevelopmentPage();
    expect(await screen.findByTestId('dev-gateway-mode')).toHaveTextContent(
      '当前数据源：模拟（MockGateway）',
    );
  });

  it('shows the HTTP data source when VITE_FORGE_CORE_MODE=http', async () => {
    vi.stubEnv('VITE_FORGE_CORE_MODE', 'http');
    renderDevelopmentPage();
    expect(await screen.findByTestId('dev-gateway-mode')).toHaveTextContent(
      '当前数据源：本地 HTTP 后端（HttpGateway）',
    );
  });

  it('keeps all backend and real-acceptance columns unclaimed in phase A', async () => {
    renderDevelopmentPage(developmentGatewayWithPassingMockEvidence());
    expect(await screen.findByText('产品形态完成度')).toBeVisible();
    expect(screen.getAllByText('模拟可用').length).toBeGreaterThan(0);
    expect(screen.getAllByText('未接入真实后端').length).toBeGreaterThan(0);
    expect(screen.queryByText('真实验收通过')).toBeNull();
  });

  it('shows exactly six backend-connected rows and zero verified cells', async () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock(), {
      evidenceLoader: {
        load: async () =>
          structuredClone(
            evidenceWith({
              backendOutcome: 'passed',
              backendConnectedCapabilities: [...BACKEND_CONNECTED_PHASE_B],
            }),
          ),
      },
    });
    renderDevelopmentPage(gateway);
    await screen.findByRole('heading', { level: 1, name: '开发进度' });

    expect(screen.getAllByText('已接真实后端')).toHaveLength(6);
    expect(screen.getAllByText('未接入真实后端')).toHaveLength(7);
    expect(screen.getAllByText('模拟可用')).toHaveLength(13);
    // Gate B ceiling: nothing is ever labelled 真实验收通过 / verified.
    expect(screen.queryByText('真实验收通过')).toBeNull();
    expect(screen.getAllByText('未真实验收')).toHaveLength(13);
    expect(within(meterSection('真实能力接入度')).getByText('46%')).toBeVisible();
    expect(within(meterSection('真实验收通过度')).getByText('0%')).toBeVisible();
  });

  it('marks proven backend rows 需要修复 after a failed backend gate', async () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock(), {
      evidenceLoader: {
        load: async () =>
          structuredClone(
            evidenceWith({
              outcome: 'passed',
              backendOutcome: 'failed',
              backendConnectedCapabilities: [...BACKEND_CONNECTED_PHASE_B],
            }),
          ),
      },
    });
    renderDevelopmentPage(gateway);

    const provenRow = await capabilityRow('模板列表与详情');
    expect(within(provenRow).getByText('模拟可用')).toBeVisible();
    expect(within(provenRow).getByText('需要修复')).toBeVisible();
    const unprovenRow = await capabilityRow('Skill 按需加载展示');
    expect(within(unprovenRow).getByText('未接入真实后端')).toBeVisible();
    expect(within(unprovenRow).queryByText('需要修复')).toBeNull();
  });

  it('selects the next script without adding controls to product pages', async () => {
    const gateway = developmentGatewayWithPassingMockEvidence();
    renderDevelopmentPage(gateway);
    await userEvent.selectOptions(
      await screen.findByLabelText('下一次任务的演示脚本'),
      'manual_retry',
    );
    expect(await gateway.getNextScenario()).toBe('manual_retry');
  });

  it('shows three independent summary meters with passing mock evidence', async () => {
    renderDevelopmentPage(developmentGatewayWithPassingMockEvidence());
    await screen.findByRole('heading', { level: 1, name: '开发进度' });

    expect(within(meterSection('产品形态完成度')).getByText('100%')).toBeVisible();
    expect(within(meterSection('真实能力接入度')).getByText('0%')).toBeVisible();
    expect(within(meterSection('真实验收通过度')).getByText('0%')).toBeVisible();
  });

  it('reports every meter at zero before any verification has run', async () => {
    renderDevelopmentPage(createMockGateway(new MemoryStorage(), createFixedClock()));
    await screen.findByRole('heading', { level: 1, name: '开发进度' });

    expect(within(meterSection('产品形态完成度')).getByText('0%')).toBeVisible();
    expect(within(meterSection('真实能力接入度')).getByText('0%')).toBeVisible();
    expect(within(meterSection('真实验收通过度')).getByText('0%')).toBeVisible();
  });

  it('lists all thirteen capabilities with a three-column stage matrix', async () => {
    renderDevelopmentPage(developmentGatewayWithPassingMockEvidence());
    for (const [, label] of CAPABILITIES) {
      expect(await screen.findByRole('button', { name: label })).toBeVisible();
    }
    expect(screen.getByText('产品形态')).toBeVisible();
    expect(screen.getByText('真实后端连接')).toBeVisible();
    expect(screen.getByText('真实验收')).toBeVisible();
  });

  it('expands a capability row to command, observed time and outcome', async () => {
    renderDevelopmentPage(developmentGatewayWithPassingMockEvidence());
    const row = await capabilityRow('模板列表与详情');
    expect(within(row).queryByText('验证命令')).toBeNull();

    await userEvent.click(within(row).getByRole('button', { name: '模板列表与详情' }));

    expect(within(row).getByText('npm run verify:ui')).toBeVisible();
    expect(within(row).getByText('2026-02-01T00:00:00.000Z')).toBeVisible();
    expect(within(row).getByText('通过')).toBeVisible();
  });

  it('marks affected capabilities as needs_repair after a failed run', async () => {
    const gateway = createMockGateway(new MemoryStorage(), createFixedClock(), {
      evidenceLoader: {
        load: async () =>
          structuredClone(
            evidenceWith({ outcome: 'failed', passedCapabilities: ['templates', 'workspace'] }),
          ),
      },
    });
    renderDevelopmentPage(gateway);

    const passedRow = await capabilityRow('模板列表与详情');
    expect(within(passedRow).getByText('模拟可用')).toBeVisible();
    const failedRow = await capabilityRow('自动与手动重试');
    expect(within(failedRow).getByText('需要修复')).toBeVisible();
    // The real columns stay unclaimed even on a failed run.
    expect(within(failedRow).getByText('未接入真实后端')).toBeVisible();
    expect(within(failedRow).getByText('未真实验收')).toBeVisible();
  });

  it('shows the unverified observation text before any run', async () => {
    renderDevelopmentPage(createMockGateway(new MemoryStorage(), createFixedClock()));
    const row = await capabilityRow('动态 Agent 画布');
    await userEvent.click(within(row).getByRole('button', { name: '动态 Agent 画布' }));
    expect(within(row).getByText('尚未运行')).toBeVisible();
    expect(within(row).getByText('未运行')).toBeVisible();
  });
});

describe('development page simulation console', () => {
  it('renders all six demonstration scripts with labels and descriptions', async () => {
    renderDevelopmentPage();
    const select = await screen.findByLabelText('下一次任务的演示脚本');
    expect(within(select).getAllByRole('option')).toHaveLength(MOCK_SCENARIO_IDS.length);
    for (const id of MOCK_SCENARIO_IDS) {
      expect(screen.getByText(MOCK_SCENARIOS[id].description)).toBeVisible();
    }
    expect(
      screen.getByText('此选择仅对下一次创建的任务生效，不影响已创建的任务。'),
    ).toBeVisible();
  });

  it('shows the persisted scenario as the current selection', async () => {
    renderDevelopmentPage();
    const select = (await screen.findByLabelText(
      '下一次任务的演示脚本',
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('happy_path'));
  });

  it('resets only the forge-core:mock:v1:* scope after explicit confirmation', async () => {
    const storage = seededStorage();
    storage.setItem('outside:key', 'must-survive');
    const gateway = createMockGateway(storage, createFixedClock());
    renderDevelopmentPage(gateway);
    expect(await gateway.listTasks()).toHaveLength(4);

    await userEvent.click(await screen.findByRole('button', { name: '重置模拟数据' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/forge-core:mock:v1:\*/)).toBeVisible();

    // Cancel keeps every task and closes the dialog.
    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await gateway.listTasks()).toHaveLength(4);

    // Confirm clears only the mock namespace and restores the seed catalog.
    await userEvent.click(screen.getByRole('button', { name: '重置模拟数据' }));
    // act() flushes the reset handler's async reload inside the test scope.
    await act(async () => {
      await userEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: '确认重置' }),
      );
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(storage.getItem('forge-core:mock:v1:tasks')).toBeNull(),
    );
    expect(storage.getItem('outside:key')).toBe('must-survive');
    expect(await gateway.listTasks()).toEqual([]);
    expect(await gateway.listTemplates()).toHaveLength(1);
  });
});

describe('formal pages carry no development controls', () => {
  const formalRoutes = [
    '/templates',
    `/templates/${TEMPLATE_ID}`,
    '/tasks/new',
    '/tasks',
    '/tasks/task-seeded-completed',
  ];

  it.each(formalRoutes)('keeps %s free of scenario and reset controls', async (route) => {
    const gateway = createMockGateway(seededStorage(), createFixedClock());
    renderPage(route, gateway);
    await screen.findByRole('heading', { level: 1 });

    expect(screen.queryByText('下一次任务的演示脚本')).toBeNull();
    expect(screen.queryByLabelText('下一次任务的演示脚本')).toBeNull();
    expect(screen.queryByText('制造失败')).toBeNull();
    expect(screen.queryByText('重置模拟数据')).toBeNull();
    expect(screen.queryByRole('link', { name: '开发进度' })).toBeNull();
  });
});
