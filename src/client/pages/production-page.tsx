import { useCallback, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ArtifactVersion, TaskStatus, TaskWorkspace } from '../../shared/contracts';
import type { PublicCoreError } from '../../shared/errors';
import { ArtifactDrawer } from '../components/artifact-drawer';
import { AuthoritativeProcessPanel } from '../components/authoritative-process-panel';
import { ConfigDrawer } from '../components/config-drawer';
import { NodeDetailDialog } from '../components/node-detail-dialog';
import { ProcessTraceDialog } from '../components/process-trace-dialog';
import { StatusChip } from '../components/status-chip';
import { StructuredSlotDrawer } from '../components/structured-slot-drawer';
import { StructuredReviewDrawer } from '../components/structured-review/structured-review-drawer';
import { TaskControls } from '../components/task-controls';
import { WorkspaceCanvas } from '../components/workspace-canvas';
import { CORE_ERROR_CODES } from '../gateway/core-errors';
import { useForgeCoreGateway } from '../gateway/gateway-context';
import { useTaskWatch } from '../hooks/use-task-watch';
import { toPublicCoreError } from '../hooks/use-gateway-query';
import { taskStatusLabel, taskStatusTone } from './display';
import { PublicErrorNotice } from './public-error-notice';

/**
 * Terminal statuses that may be rerun with the same frozen input (plan Phase
 * E). `incompatible` joins them (plan 2026-08-04 Task 3): a legacy snapshot
 * without a supported turn contract is read-only, and cloning onto the
 * current template is its ONLY rebuilding path (spec §7.3).
 */
const CLONE_STATUSES: readonly TaskStatus[] = ['completed', 'stopped', 'incompatible'];

function NotFoundPanel({ error }: { error: PublicCoreError }) {
  return (
    <section className="fc-task-state-panel">
      <h1 className="fc-page-title">任务不存在</h1>
      <p className="fc-task-state-panel__line">{error.message}</p>
      {error.action !== null ? <p className="fc-task-state-panel__line">{error.action}</p> : null}
      <Link className="fc-inline-link" to="/tasks">
        返回任务列表
      </Link>
    </section>
  );
}

function CorruptPanel({ diagnostic }: { diagnostic: string }) {
  return (
    <section className="fc-task-state-panel">
      <h1 className="fc-page-title">任务数据已隔离</h1>
      <p className="fc-task-state-panel__line fc-task-row__diagnostic">{diagnostic}</p>
      <Link className="fc-inline-link" to="/tasks">
        返回任务列表
      </Link>
    </section>
  );
}

/**
 * Workspace view with all cross-component state lifted here, so drawer
 * toggles never reset canvas scroll, node selection or selected version.
 *
 * Layout (plan G): the canvas owns the full page width; config and artifacts
 * are on-demand overlay drawers (fixed panels above a translucent backdrop)
 * that never push or resize the canvas. Both start closed.
 */
function ProductionWorkspace({ workspace }: { workspace: TaskWorkspace }) {
  const gateway = useForgeCoreGateway();
  const navigate = useNavigate();
  const [configOpen, setConfigOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [structuredOpen, setStructuredOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [drawerRevision, setDrawerRevision] = useState(0);
  const [cloneError, setCloneError] = useState<PublicCoreError | null>(null);
  const [clonePending, setClonePending] = useState(false);

  const toggleConfig = useCallback(() => {
    setConfigOpen((open) => !open);
    setDrawerRevision((revision) => revision + 1);
  }, []);

  const toggleArtifacts = useCallback(() => {
    setArtifactsOpen((open) => !open);
    setDrawerRevision((revision) => revision + 1);
  }, []);

  const toggleStructured = useCallback(() => {
    setStructuredOpen((open) => !open);
    setDrawerRevision((revision) => revision + 1);
  }, []);

  const closeDrawers = useCallback(() => {
    setConfigOpen(false);
    setArtifactsOpen(false);
    setStructuredOpen(false);
    setDrawerRevision((revision) => revision + 1);
  }, []);

  const handleSelectNode = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId);
      const node = workspace.nodes.find((item) => item.id === nodeId);
      if (node && node.inputVersion !== null) {
        setSelectedVersion(node.inputVersion);
      }
    },
    [workspace.nodes],
  );

  const handleLocateArtifact = useCallback((artifact: ArtifactVersion) => {
    setSelectedVersion(artifact.version);
    if (artifact.protocolVersion === 2) return;
    setHighlightedNodeId(artifact.sourceNodeId);
    const element = document.getElementById(`node-${artifact.sourceNodeId}`);
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'center', inline: 'center' });
    }
  }, []);

  /**
   * Same-input rerun on the current template version (plan Phase E): the
   * gateway creates the clone and the page navigates to it; failures stay on
   * this page as a public notice.
   */
  const handleClone = useCallback(async () => {
    setCloneError(null);
    setClonePending(true);
    try {
      const created = await gateway.cloneTask(workspace.task.id);
      navigate(`/tasks/${created.id}`);
    } catch (error) {
      setCloneError(toPublicCoreError(error));
      setClonePending(false);
    }
  }, [gateway, navigate, workspace.task.id]);

  const selectedNode =
    selectedNodeId !== null
      ? (workspace.nodes.find((item) => item.id === selectedNodeId) ?? null)
      : null;
  const selectedAgentName =
    selectedNode !== null
      ? (workspace.agents.find((agent) => agent.id === selectedNode.agentId)?.name ??
        selectedNode.agentId)
      : '';

  /**
   * Escape closes the overlay drawers. Dialogs handle their own Escape and
   * stop propagation, so an open dialog always wins.
   */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Escape') closeDrawers();
    },
    [closeDrawers],
  );

  return (
    <div className="fc-production" onKeyDown={handleKeyDown}>
      <header className="fc-production__header">
        <h1 className="fc-page-title fc-production__name">{workspace.task.name}</h1>
        <StatusChip
          tone={taskStatusTone(workspace.task.status)}
          label={taskStatusLabel(workspace.task.status)}
        />
        <p className="fc-production__action">
          当前动作：
          <span className="fc-production__action-value">
            {workspace.task.currentAgentName ?? '—'}
          </span>
        </p>
        <div className="fc-production__toggles">
          {CLONE_STATUSES.includes(workspace.task.status) ? (
            <button
              type="button"
              className="fc-button"
              disabled={clonePending}
              onClick={() => void handleClone()}
            >
              用当前模板重跑
            </button>
          ) : null}
          <button
            type="button"
            className="fc-button fc-button--secondary"
            aria-expanded={configOpen}
            onClick={toggleConfig}
          >
            配置
          </button>
          <button
            type="button"
            className="fc-button fc-button--secondary"
            aria-expanded={artifactsOpen}
            onClick={toggleArtifacts}
          >
            产物
          </button>
          {workspace.structuredSlots !== undefined ||
          workspace.task.structuredProtocol === 'v2' ? (
            <button
              type="button"
              className="fc-button fc-button--secondary"
              aria-expanded={structuredOpen}
              onClick={toggleStructured}
            >
              结构
            </button>
          ) : null}
        </div>
      </header>

      {cloneError !== null ? (
        <PublicErrorNotice title="克隆任务失败。" error={cloneError} />
      ) : null}

      {configOpen || artifactsOpen || structuredOpen ? (
        <div className="fc-drawer-backdrop" aria-hidden="true" onClick={closeDrawers} />
      ) : null}

      {configOpen ? (
        <ConfigDrawer workspace={workspace} onClose={toggleConfig} />
      ) : null}

      <div className="fc-production__center">
        {workspace.task.structuredProtocol === 'v2' && workspace.authoritativeReview?.activity !== undefined ? (
          <AuthoritativeProcessPanel
            activity={workspace.authoritativeReview.activity}
            agents={workspace.agents}
          />
        ) : (
          <WorkspaceCanvas
            workspace={workspace}
            selectedNodeId={selectedNodeId}
            highlightedNodeId={highlightedNodeId}
            onSelectNode={handleSelectNode}
            drawerRevision={drawerRevision}
          />
        )}
        <TaskControls
          task={workspace.task}
          pendingHumanQuestion={workspace.pendingHumanQuestion}
          pendingHumanSource={workspace.pendingHumanSource}
        />
      </div>

      {artifactsOpen ? (
        <ArtifactDrawer
          workspace={workspace}
          selectedVersion={selectedVersion}
          onLocateArtifact={handleLocateArtifact}
          onClose={toggleArtifacts}
        />
      ) : null}

      {structuredOpen ? (
        workspace.task.structuredProtocol === 'v2' ? (
          <StructuredReviewDrawer workspace={workspace} onClose={toggleStructured} />
        ) : (
          <StructuredSlotDrawer workspace={workspace} onClose={toggleStructured} />
        )
      ) : null}

      {selectedNode !== null ? (
        selectedNode.kind === 'result' || selectedNode.kind === 'skill' ? (
          <ProcessTraceDialog
            taskId={workspace.task.id}
            node={selectedNode}
            onClose={() => setSelectedNodeId(null)}
          />
        ) : (
          <NodeDetailDialog
            node={selectedNode}
            agentName={selectedAgentName}
            onClose={() => setSelectedNodeId(null)}
          />
        )
      ) : null}
    </div>
  );
}

/**
 * `/tasks/:taskId`. Four distinct states: loading, not-found
 * (TASK_NOT_FOUND), corrupt-diagnostic, and the usable workspace. Render
 * failures below this component are caught by the shell ErrorBoundary, so the
 * application shell always stays usable.
 */
export function ProductionPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const watch = useTaskWatch(taskId ?? '');

  if (!taskId) {
    return <NotFoundPanel error={{ code: 'TASK_NOT_FOUND', message: '缺少任务标识。', location: null, action: '返回任务列表重新进入。' }} />;
  }

  if (watch.status === 'loading' && watch.workspace === null) {
    return (
      <p className="fc-loading-note" role="status">
        正在加载任务…
      </p>
    );
  }

  if (watch.status === 'error' && watch.workspace === null && watch.error !== null) {
    if (watch.error.code === CORE_ERROR_CODES.TASK_NOT_FOUND) {
      return <NotFoundPanel error={watch.error} />;
    }
    if (watch.error.code === CORE_ERROR_CODES.TASK_CORRUPTED) {
      return <CorruptPanel diagnostic={watch.error.message} />;
    }
    return (
      <div className="fc-production-load-error">
        <PublicErrorNotice title="加载任务失败" error={watch.error} />
        <div className="fc-page-recovery">
          <button type="button" className="fc-button" onClick={watch.reload}>
            重新加载任务
          </button>
        </div>
      </div>
    );
  }

  const workspace = watch.workspace;
  if (!workspace) {
    return (
      <p className="fc-loading-note" role="status">
        正在加载任务…
      </p>
    );
  }

  if (workspace.task.status === 'corrupt') {
    return <CorruptPanel diagnostic={workspace.task.diagnostic ?? '任务文件损坏、只能查看诊断。'} />;
  }

  return <ProductionWorkspace workspace={workspace} />;
}
