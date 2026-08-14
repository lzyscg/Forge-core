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
 *
 * The v2 `failed` status (spec §10.3) is intentionally NOT listed: Task 2
 * renders its row with the danger chip and zero action buttons (minimal
 * neutral rendering). The recovery surface — server-returned legal recipes,
 * reopen_failed, and the clone fallback — lands with the v2 recovery flow
 * (Task 11), which may extend this list then.
 */
const CLONE_STATUSES: readonly TaskStatus[] = ['completed', 'stopped', 'incompatible', 'failed'];

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
 * The v2 delete confirmation state (spec §10.5): ONE UUID operation id is
 * created when the v2 dialog OPENS; a retryable/response-loss error KEEPS the
 * dialog AND the same canonical body (the server replays the same operation),
 * while success or cancel clears the state and a deliberately EDITED reason
 * creates a NEW operation (the same op with a different body must conflict
 * server-side, never silently overwrite). The reason is required and bounded
 * to 1..500 Unicode code points (the wire schema's range).
 */
interface V2DeleteState {
  operationId: string;
  reason: string;
}

const DELETE_REASON_MAX_CODE_POINTS = 500;

function V2DeleteDialog(props: {
  taskName: string;
  operationId: string;
  reason: string;
  busy: boolean;
  operationLabel: string;
  onReasonChange(reason: string): void;
  onCancel(): void;
  onConfirm(): void;
}) {
  const { taskName, operationId, reason, busy, operationLabel, onReasonChange, onCancel, onConfirm } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

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

  const handleConfirm = (): void => {
    const codePoints = [...reason.trim()];
    if (codePoints.length === 0) {
      setProblem('请输入删除原因（必填）。');
      return;
    }
    if (codePoints.length > DELETE_REASON_MAX_CODE_POINTS) {
      setProblem(`删除原因不能超过 ${DELETE_REASON_MAX_CODE_POINTS} 个字符。`);
      return;
    }
    setProblem(null);
    onConfirm();
  };

  return (
    <div className="fc-dialog__backdrop" onKeyDown={handleKeyDown}>
      <div
        className="fc-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="删除 v2 任务"
        tabIndex={-1}
        ref={panelRef}
      >
        <h2 className="fc-dialog__title">删除 v2 任务</h2>
        <p className="fc-dialog__body">
          即将删除任务「{taskName}
          」。v2 删除是带审计的操作：任务目录将被隔离并在确认后清除，此操作不可撤销。
        </p>
        <label className="fc-answer-form__label" htmlFor="fc-delete-reason">
          删除原因（必填，{DELETE_REASON_MAX_CODE_POINTS} 字符以内）
        </label>
        <textarea
          id="fc-delete-reason"
          className="fc-answer-form__input"
          value={reason}
          disabled={busy}
          onChange={(event) => onReasonChange(event.target.value)}
        />
        <p
          className="fc-task-page__delete-op"
          title="同一次删除保序重试使用同一操作 ID"
          data-testid="v2-delete-operation"
        >
          操作 ID（{operationLabel}）：<code>{operationId}</code>
        </p>
        {problem !== null ? (
          <p className="fc-answer-form__problem" role="alert">
            {problem}
          </p>
        ) : null}
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
            onClick={() => handleConfirm()}
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
  // v2 delete dialog state: one UUID per dialog OPEN; kept (with the SAME
  // canonical body) across retryable/response-loss errors, cleared on
  // success/cancel, renewed when the reason is edited.
  const [v2Delete, setV2Delete] = useState<V2DeleteState | null>(null);
  // The submitted canonical body lives in a REF: the edit handler reads it
  // synchronously (a state closure would race the last failed submit).
  const v2DeleteSubmittedRef = useRef<V2DeleteState | null>(null);
  const [v2DeleteError, setV2DeleteError] = useState<PublicCoreError | null>(null);

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
    setV2DeleteError(null);
    const isV2 = target.structuredProtocol === 'v2';
    const body = isV2 && v2Delete !== null ? { ...v2Delete } : undefined;
    if (body !== undefined) {
      // The submitted body is fixed for the retry window (response-loss
      // replay must reuse the SAME operation id + canonical reason).
      v2DeleteSubmittedRef.current = body;
    }
    const deleteCall =
      body === undefined ? gateway.deleteTask(target.id) : gateway.deleteTask(target.id, body);
    void deleteCall
      .then(() => {
        setDeleteTarget(null);
        setV2Delete(null);
        v2DeleteSubmittedRef.current = null;
        query.reload();
      })
      .catch((error: unknown) => {
        // Retryable/response-loss error: for v2 the dialog STAYS OPEN with
        // the same canonical body — submitting again replays the same
        // operation server-side. Only a manual reason edit creates a new
        // operation.
        if (body !== undefined) {
          setV2DeleteError(toPublicCoreError(error));
        } else {
          setDeleteTarget(null);
          setActionError(toPublicCoreError(error));
        }
      })
      .finally(() => {
        setDeleting(false);
      });
  };

  const openDeleteDialog = (task: TaskSummary): void => {
    setActionError(null);
    setV2DeleteError(null);
    v2DeleteSubmittedRef.current = null;
    setDeleteTarget(task);
    // ONE UUID per v2 dialog open (spec §10.5).
    setV2Delete(task.structuredProtocol === 'v2' ? { operationId: crypto.randomUUID(), reason: '' } : null);
  };

  const editV2DeleteReason = (raw: string): void => {
    setV2DeleteError(null);
    const submitted = v2DeleteSubmittedRef.current;
    setV2Delete((previous) => {
      if (previous === null) return null;
      // Typing in a FRESH dialog keeps the open-time UUID (spec §10.5: one
      // UUID per dialog open). ONLY an intentional reason edit AFTER a failed
      // submit — diverging from the submitted canonical body — intentionally
      // creates a NEW operation (a same-op different-reason replay must not
      // silently overwrite the tombstones).
      if (submitted !== null && raw !== submitted.reason) {
        return { operationId: crypto.randomUUID(), reason: raw };
      }
      return { operationId: previous.operationId, reason: raw };
    });
    if (submitted !== null && raw !== submitted.reason) {
      v2DeleteSubmittedRef.current = null;
    }
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
                  onClick={() => openDeleteDialog(task)}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {v2DeleteError !== null ? (
        <PublicErrorNotice title="删除失败（v2 幂等重试已就绪）。" error={v2DeleteError} />
      ) : null}

      {deleteTarget !== null && v2Delete !== null ? (
        <V2DeleteDialog
          taskName={deleteTarget.name}
          operationId={v2Delete.operationId}
          reason={v2Delete.reason}
          busy={deleting}
          operationLabel={v2DeleteSubmittedRef.current?.operationId === v2Delete.operationId ? '保序重试中' : '本次删除'}
          onReasonChange={editV2DeleteReason}
          onCancel={() => {
            setDeleteTarget(null);
            setV2Delete(null);
            v2DeleteSubmittedRef.current = null;
            setV2DeleteError(null);
          }}
          onConfirm={handleConfirmDelete}
        />
      ) : null}

      {deleteTarget !== null && v2Delete === null ? (
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
