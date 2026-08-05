import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import type { CapabilityEvidence, CapabilityStage, MockScenarioId } from '../../shared/contracts';
import type { PublicCoreError } from '../../shared/errors';
import { useDevelopmentGateway } from '../gateway/gateway-context';
import { resolveForgeCoreMode } from '../gateway/gateway-mode';
import { toPublicCoreError, useGatewayQuery } from '../hooks/use-gateway-query';
import { MOCK_SCENARIOS } from '../mock/mock-scenarios';
import { MOCK_SCENARIO_IDS } from '../mock/mock-schema';
import { PublicErrorNotice } from './public-error-notice';

/**
 * Development progress page (/dev/progress): the ONLY UI that exposes
 * simulation console controls (script selection, mock data reset) and the
 * only consumer of DevelopmentGateway. Formal pages never render it and the
 * production shell never links to it; it stays addressable by URL.
 *
 * Progress is always reported as three independent dimensions — product
 * shape, backend connection, real acceptance — never one blended percentage.
 * The product-shape column is driven by the UI gate evidence; the backend
 * column is driven by the backend gate evidence (Phase B); real acceptance
 * stays not_started until a later phase owns it, and no evidence shape can
 * mark anything `verified` before then.
 */

const STAGE_ICONS: Record<CapabilityStage, string> = {
  not_started: '○',
  mock_ready: '◐',
  backend_connected: '▣',
  verified: '●',
  needs_repair: '△',
};

const PRODUCT_SHAPE_LABELS: Record<CapabilityStage, string> = {
  not_started: '未开始',
  mock_ready: '模拟可用',
  backend_connected: '已接真实后端',
  verified: '真实验收通过',
  needs_repair: '需要修复',
};

const BACKEND_LABELS: Record<CapabilityStage, string> = {
  not_started: '未接入真实后端',
  mock_ready: '模拟可用',
  backend_connected: '已接真实后端',
  verified: '真实验收通过',
  needs_repair: '需要修复',
};

const ACCEPTANCE_LABELS: Record<CapabilityStage, string> = {
  not_started: '未真实验收',
  mock_ready: '模拟可用',
  backend_connected: '已接真实后端',
  verified: '真实验收通过',
  needs_repair: '需要修复',
};

/** Per-cell evidence outcome shown in the expanded row detail. */
const OUTCOME_TEXT: Record<CapabilityStage, string> = {
  not_started: '未运行',
  mock_ready: '通过',
  backend_connected: '通过',
  verified: '通过',
  needs_repair: '失败',
};

function StageCell({ stage, label }: { stage: CapabilityStage; label: string }) {
  return (
    <span className={`fc-stage fc-stage--${stage}`}>
      <span className="fc-stage__icon" aria-hidden="true">
        {STAGE_ICONS[stage]}
      </span>
      <span className="fc-stage__label">{label}</span>
    </span>
  );
}

function percentage(rows: CapabilityEvidence[], matches: (row: CapabilityEvidence) => boolean) {
  if (rows.length === 0) return 0;
  return Math.round((rows.filter(matches).length / rows.length) * 100);
}

interface MeterProps {
  label: string;
  percent: number;
  detail: string;
}

function Meter({ label, percent, detail }: MeterProps) {
  return (
    <section className="fc-dev-meter" aria-label={label}>
      <h2 className="fc-dev-meter__label">{label}</h2>
      <p className="fc-dev-meter__value">{percent}%</p>
      <div className="fc-dev-meter__bar" role="presentation">
        <div className="fc-dev-meter__fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="fc-dev-meter__detail">{detail}</p>
    </section>
  );
}

interface ResetMockDataDialogProps {
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}

/**
 * Confirmation dialog for the mock reset: names the exact storage scope
 * before any destructive action. Focus moves in on open, returns to the
 * invoking element on close, Escape cancels.
 */
function ResetMockDataDialog({ busy, onCancel, onConfirm }: ResetMockDataDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      if (previous !== null && document.contains(previous)) previous.focus();
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className="fc-dialog__backdrop" onKeyDown={handleKeyDown}>
      <div
        className="fc-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="重置模拟数据"
        tabIndex={-1}
        ref={panelRef}
      >
        <h2 className="fc-dialog__title">重置模拟数据</h2>
        <p className="fc-dialog__body">
          即将删除 <code>forge-core:mock:v1:*</code>
          命名空间下的全部本地模拟数据（模板目录缓存、任务记录、模拟控制台设置），并恢复种子模板目录；不会触碰任何其他浏览器存储。此操作不可撤销。
        </p>
        <div className="fc-dialog__actions">
          <button
            type="button"
            className="fc-button fc-button--secondary"
            onClick={onCancel}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="button"
            className="fc-button fc-button--danger"
            onClick={onConfirm}
            disabled={busy}
          >
            确认重置
          </button>
        </div>
      </div>
    </div>
  );
}

export function DevelopmentProgressPage() {
  const development = useDevelopmentGateway();
  const capabilitiesQuery = useGatewayQuery(() => development.getCapabilities(), []);
  const scenarioQuery = useGatewayQuery(() => development.getNextScenario(), []);

  const [scenarioOverride, setScenarioOverride] = useState<MockScenarioId | null>(null);
  const [scenarioError, setScenarioError] = useState<PublicCoreError | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<PublicCoreError | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const rows = capabilitiesQuery.data ?? [];
  const productPercent = percentage(rows, (row) => row.productShape === 'mock_ready');
  const backendPercent = percentage(rows, (row) => row.backendConnection === 'backend_connected');
  const acceptancePercent = percentage(rows, (row) => row.realAcceptance === 'verified');

  const selectedScenario = scenarioOverride ?? scenarioQuery.data ?? 'happy_path';

  const handleScenarioChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const value = event.target.value as MockScenarioId;
    setScenarioOverride(value);
    setScenarioError(null);
    void development.setNextScenario(value).catch((error: unknown) => {
      setScenarioOverride(null);
      setScenarioError(toPublicCoreError(error));
    });
  };

  const toggleRow = (id: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleResetConfirm = (): void => {
    setResetting(true);
    setResetError(null);
    void development
      .resetMockData()
      .then(() => {
        setScenarioOverride(null);
        scenarioQuery.reload();
        setResetOpen(false);
      })
      .catch((error: unknown) => {
        setResetOpen(false);
        setResetError(toPublicCoreError(error));
      })
      .finally(() => setResetting(false));
  };

  return (
    <div className="fc-dev-progress">
      <header className="fc-dev-progress__header">
        <h1 className="fc-page-title">开发进度</h1>
        <p className="fc-dev-progress__disclaimer">
          产品形态列以最近一次 npm run verify:ui 的证据为准，真实后端连接列以最近一次 npm
          run verify:backend 的证据为准，真实验收尚未进行。本页面仅用于开发进度演示，不代表真实生产能力。
        </p>
        <p className="fc-dev-progress__mode" data-testid="dev-gateway-mode">
          当前数据源：
          {resolveForgeCoreMode(import.meta.env.VITE_FORGE_CORE_MODE) === 'http'
            ? '本地 HTTP 后端（HttpGateway）'
            : '模拟（MockGateway）'}
        </p>
      </header>

      {capabilitiesQuery.status === 'loading' ? (
        <p className="fc-loading-note">正在加载能力证据…</p>
      ) : null}
      {capabilitiesQuery.status === 'error' && capabilitiesQuery.error ? (
        <PublicErrorNotice title="加载能力证据失败" error={capabilitiesQuery.error} />
      ) : null}
      {capabilitiesQuery.status === 'success' && capabilitiesQuery.data ? (
        <>
          <section className="fc-dev-progress__meters" aria-label="三维度进度汇总">
            <Meter
              label="产品形态完成度"
              percent={productPercent}
              detail={`${rows.filter((row) => row.productShape === 'mock_ready').length} / ${rows.length} 项模拟可用`}
            />
            <Meter
              label="真实能力接入度"
              percent={backendPercent}
              detail={`${rows.filter((row) => row.backendConnection === 'backend_connected').length} / ${rows.length} 项已接真实后端`}
            />
            <Meter
              label="真实验收通过度"
              percent={acceptancePercent}
              detail={`${rows.filter((row) => row.realAcceptance === 'verified').length} / ${rows.length} 项通过真实验收`}
            />
          </section>

          <section className="fc-dev-matrix-section" aria-label="能力矩阵">
            <h2 className="fc-section-title">能力矩阵</h2>
            <p className="fc-dev-matrix-section__hint">
              每项能力分三列独立展示；真实后端连接列由 verify:backend
              证据驱动，真实验收列在真实验收完成前恒为未验收状态。
            </p>
            <ul className="fc-dev-matrix">
              <li className="fc-dev-matrix__head" aria-hidden="true">
                <span>能力</span>
                <span>产品形态</span>
                <span>真实后端连接</span>
                <span>真实验收</span>
              </li>
              {rows.map((row) => {
                const isOpen = expanded.has(row.id);
                return (
                  <li key={row.id} className="fc-dev-matrix__row">
                    <div className="fc-dev-matrix__cells">
                      <button
                        type="button"
                        className="fc-dev-matrix__toggle"
                        aria-expanded={isOpen}
                        onClick={() => toggleRow(row.id)}
                      >
                        {row.label}
                      </button>
                      <StageCell stage={row.productShape} label={PRODUCT_SHAPE_LABELS[row.productShape]} />
                      <StageCell
                        stage={row.backendConnection}
                        label={BACKEND_LABELS[row.backendConnection]}
                      />
                      <StageCell
                        stage={row.realAcceptance}
                        label={ACCEPTANCE_LABELS[row.realAcceptance]}
                      />
                    </div>
                    {isOpen ? (
                      <dl className="fc-dev-matrix__detail">
                        <div className="fc-dev-matrix__detail-row">
                          <dt>验证命令</dt>
                          <dd>{row.command ?? '未知'}</dd>
                        </div>
                        <div className="fc-dev-matrix__detail-row">
                          <dt>观察时间</dt>
                          <dd>{row.observedAt ?? '尚未运行'}</dd>
                        </div>
                        <div className="fc-dev-matrix__detail-row">
                          <dt>证据结果</dt>
                          <dd>{OUTCOME_TEXT[row.productShape]}</dd>
                        </div>
                      </dl>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      ) : null}

      <section className="fc-dev-console" aria-label="模拟控制台">
        <h2 className="fc-section-title">模拟控制台</h2>
        <p className="fc-dev-console__intro">
          以下控制只影响模拟数据与演示脚本，不影响任何真实生产流程。
        </p>

        <div className="fc-dev-console__field">
          <label className="fc-field__label" htmlFor="fc-next-scenario">
            下一次任务的演示脚本
          </label>
          <select
            id="fc-next-scenario"
            className="fc-select"
            value={selectedScenario}
            onChange={handleScenarioChange}
            disabled={scenarioQuery.status === 'loading'}
          >
            {MOCK_SCENARIO_IDS.map((id) => (
              <option key={id} value={id}>
                {MOCK_SCENARIOS[id].label}
              </option>
            ))}
          </select>
          <p className="fc-dev-console__hint">
            此选择仅对下一次创建的任务生效，不影响已创建的任务。
          </p>
          {scenarioError ? (
            <PublicErrorNotice title="保存演示脚本失败" error={scenarioError} focusOnMount />
          ) : null}
        </div>

        <ul className="fc-dev-console__scripts">
          {MOCK_SCENARIO_IDS.map((id) => (
            <li key={id} className="fc-dev-console__script">
              <p className="fc-dev-console__script-label">{MOCK_SCENARIOS[id].label}</p>
              <p className="fc-dev-console__script-description">{MOCK_SCENARIOS[id].description}</p>
            </li>
          ))}
        </ul>

        <div className="fc-dev-console__reset">
          <button
            type="button"
            className="fc-button fc-button--danger"
            onClick={() => setResetOpen(true)}
            disabled={resetting}
          >
            重置模拟数据
          </button>
          <p className="fc-dev-console__hint">
            重置仅清除 forge-core:mock:v1:* 命名空间下的本地模拟数据（模板目录缓存、任务记录、控制台设置），不会触碰任何其他浏览器存储。
          </p>
          {resetError ? (
            <PublicErrorNotice title="重置模拟数据失败" error={resetError} focusOnMount />
          ) : null}
        </div>
      </section>

      {resetOpen ? (
        <ResetMockDataDialog
          busy={resetting}
          onCancel={() => setResetOpen(false)}
          onConfirm={handleResetConfirm}
        />
      ) : null}
    </div>
  );
}
