import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import type { TaskStatus, TaskSummary } from '../../shared/contracts';
import type { PublicCoreError } from '../../shared/errors';
import { EmptyState } from '../components/empty-state';
import { StatusChip } from '../components/status-chip';
import { useForgeCoreGateway } from '../gateway/gateway-context';
import { toPublicCoreError, useGatewayQuery } from '../hooks/use-gateway-query';
import { formatDateTime, taskStatusLabel, taskStatusTone } from './display';
import { PublicErrorNotice } from './public-error-notice';

/**
 * Terminal statuses whose frozen input can be rerun as a clone (plan Phase
 * E). `incompatible` legacy tasks are read-only and rebuild through cloning
 * alone (plan 2026-08-04 Task 3, spec §7.3).
 */
const CLONE_STATUSES: readonly TaskStatus[] = ['completed', 'stopped', 'incompatible'];

function byUpdatedDesc(a: TaskSummary, b: TaskSummary): number {
  // Stable sort keeps gateway order for identical timestamps.
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

interface DeleteTaskDialogProps {
  taskName: string;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}

/**
 * Confirmation dialog for the irreversible task deletion: names the exact
 * task before the destructive action and offers cancel/confirm controls.
 * Focus moves in on open and returns to the invoking element on close;
 * Escape cancels (ignored while the deletion is in flight).
 */
function DeleteTaskDialog({ taskName, busy, onCancel, onConfirm }: DeleteTaskDialogProps) {
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
      if (!busy) onCancel();
    }
  };

  return (
    <div className="fc-dialog__backdrop" onKeyDown={handleKeyDown}>
      <div
        className="fc-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="删除任务"
        tabIndex={-1}
        ref={panelRef}
      >
        <h2 className="fc-dialog__title">删除任务</h2>
        <p className="fc-dialog__body">
          即将删除任务「{taskName}
          」。任务的全部运行记录与产物将一并移除，此操作不可撤销。
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
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Production task list. Rows are driven entirely by Gateway summaries; corrupt
 * rows stay openable for diagnosis, and mutating controls exist only where the
 * public status allows them (spec §9.3, §11). Deletion is the one control
 * every row carries — in ANY status — and it always goes through an explicit
 * danger confirmation dialog first, because it is irreversible.
 */
export function TaskListPage() {
  const gateway = useForgeCoreGateway();
  const query = useGatewayQuery(() => gateway.listTasks(), [gateway]);
  const [actionError, setActionError] = useState<PublicCoreError | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const tasks = useMemo(
    () => [...(query.data ?? [])].sort(byUpdatedDesc),
    [query.data],
  );

  const runAction = async (taskId: string, action: () => Promise<void>): Promise<void> => {
    setActionError(null);
    setPendingTaskId(taskId);
    try {
      await action();
      query.reload();
    } catch (error) {
      setActionError(toPublicCoreError(error));
    } finally {
      setPendingTaskId(null);
    }
  };

  const handleConfirmDelete = (): void => {
    if (deleteTarget === null || deleting) return;
    const target = deleteTarget;
    setDeleting(true);
    setActionError(null);
    void gateway
      .deleteTask(target.id)
      .then(() => {
        setDeleteTarget(null);
        query.reload();
      })
      .catch((error: unknown) => {
        setDeleteTarget(null);
        setActionError(toPublicCoreError(error));
      })
      .finally(() => {
        setDeleting(false);
      });
  };

  return (
    <section className="fc-task-list-page">
      <h1 className="fc-page-title">生产任务</h1>

      {actionError !== null ? (
        <PublicErrorNotice title="任务操作失败。" error={actionError} />
      ) : null}

      {query.status === 'loading' && query.data === null ? (
        <p className="fc-loading-note">任务列表加载中…</p>
      ) : null}

      {query.status === 'error' && query.error !== null && query.data === null ? (
        <PublicErrorNotice title="加载任务列表失败。" error={query.error} />
      ) : null}

      {query.data !== null && tasks.length === 0 ? (
        <EmptyState
          title="还没有生产任务"
          description="选择一个模板并填写它声明的输入，即可创建第一个生产任务。"
          action={
            <Link className="fc-button" to="/templates">
              浏览模板
            </Link>
          }
        />
      ) : null}

      {tasks.length > 0 ? (
        <ul className="fc-task-list">
          {tasks.map((task) => (
            <li key={task.id} className="fc-task-row">
              <div className="fc-task-row__header">
                <h2 className="fc-task-row__name">{task.name}</h2>
                <StatusChip
                  tone={taskStatusTone(task.status)}
                  label={taskStatusLabel(task.status)}
                />
              </div>

              <dl className="fc-task-row__meta">
                <div className="fc-task-row__meta-item">
                  <dt>模板</dt>
                  <dd>{task.templateName.length > 0 ? task.templateName : '—'}</dd>
                </div>
                <div className="fc-task-row__meta-item">
                  <dt>当前 Agent</dt>
                  <dd>{task.currentAgentName ?? '—'}</dd>
                </div>
                <div className="fc-task-row__meta-item">
                  <dt>最新版本</dt>
                  <dd>{task.latestVersion === null ? '—' : `V${task.latestVersion}`}</dd>
                </div>
                <div className="fc-task-row__meta-item">
                  <dt>最后更新</dt>
                  <dd>{formatDateTime(task.updatedAt)}</dd>
                </div>
              </dl>

              {task.diagnostic !== null ? (
                <p className="fc-task-row__diagnostic">{task.diagnostic}</p>
              ) : null}

              <div className="fc-task-row__actions">
                <Link
                  className="fc-button fc-button--secondary"
                  to={`/tasks/${task.id}`}
                >
                  查看任务
                </Link>
                {task.status === 'interrupted' ? (
                  <button
                    type="button"
                    className="fc-button"
                    disabled={pendingTaskId === task.id}
                    onClick={() =>
                      void runAction(task.id, () => gateway.resumeTask(task.id))
                    }
                  >
                    继续
                  </button>
                ) : null}
                {task.status === 'retryable_failure' ? (
                  <button
                    type="button"
                    className="fc-button"
                    disabled={pendingTaskId === task.id}
                    onClick={() =>
                      void runAction(task.id, () => gateway.retryTask(task.id))
                    }
                  >
                    重试
                  </button>
                ) : null}
                {CLONE_STATUSES.includes(task.status) ? (
                  <button
                    type="button"
                    className="fc-button fc-button--secondary"
                    disabled={pendingTaskId === task.id}
                    onClick={() =>
                      void runAction(task.id, async () => {
                        await gateway.cloneTask(task.id);
                      })
                    }
                  >
                    重跑
                  </button>
                ) : null}
                <button
                  type="button"
                  className="fc-button fc-button--danger"
                  disabled={deleting && deleteTarget?.id === task.id}
                  onClick={() => setDeleteTarget(task)}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {deleteTarget !== null ? (
        <DeleteTaskDialog
          taskName={deleteTarget.name}
          busy={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleConfirmDelete}
        />
      ) : null}
    </section>
  );
}
