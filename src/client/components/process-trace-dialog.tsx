import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type {
  SkillContent,
  TurnPhaseState,
  TurnTrace,
  TurnTracePhase,
  WorkspaceNode,
} from '../../shared/contracts';
import { useForgeCoreGateway } from '../gateway/gateway-context';

export interface ProcessTraceDialogProps {
  taskId: string;
  node: WorkspaceNode;
  onClose: () => void;
}

/** Internal load lifecycle; raw errors never leave the placeholder copy. */
type TraceDialogState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'error' }
  | { status: 'trace'; trace: TurnTrace }
  | { status: 'skill'; skill: SkillContent };

/**
 * Display-only labels of the turn phase states (spec §3.2). The transient
 * `production`/`production_complete`/`dispatching` states are reserved for
 * the future realtime iteration; persisted traces of completed turns carry
 * `dispatched`, `waiting_human` or `failed`.
 */
const PHASE_LABELS: Record<TurnPhaseState, string> = {
  production: '制作中',
  production_complete: '制作已完成',
  dispatching: '正在发送',
  dispatched: '已发送',
  waiting_human: '等待人工',
  failed: '阶段未完成',
};

/**
 * The one phase-row line for a turn phase. Supplements follow spec §3.2:
 * dispatched/dispatching show the target agent or the submit intent,
 * waiting_human notes the question was submitted, and failed appends the
 * public message only — provider causes and secrets never reach the dialog.
 */
function phaseRowText(phase: TurnTracePhase): string {
  switch (phase.state) {
    case 'production':
      return PHASE_LABELS.production;
    case 'production_complete':
      return `${PHASE_LABELS.production_complete}，等待发送`;
    case 'dispatching':
    case 'dispatched': {
      if (phase.target !== null) {
        return `${PHASE_LABELS[phase.state]}给「${phase.target}」`;
      }
      if (phase.dispatchAction === 'submit_final_artifact') {
        return phase.state === 'dispatched' ? '已提交最终结果' : '正在提交最终结果';
      }
      return phase.message ?? PHASE_LABELS[phase.state];
    }
    case 'waiting_human':
      return `${PHASE_LABELS.waiting_human}，人工问题已提交`;
    case 'failed':
      return phase.message !== null && phase.message.length > 0
        ? `${PHASE_LABELS.failed}，${phase.message}`
        : PHASE_LABELS.failed;
  }
}

/**
 * Floating window with a node's full observable process (plan Phase E Task 5):
 * result nodes stream their Turn trace — thinking, tool calls, tool results
 * and the final text — while skill nodes show the frozen Skill snapshot with
 * its version prefix. Structure mirrors NodeDetailDialog: Escape dismisses,
 * focus moves in on open and returns to the invoking element on close.
 *
 * Traces carrying the display-only final phase (plan 2026-08-04 Task 6)
 * render exactly one phase row above the entry sections; historical traces
 * without a phase keep the previous behavior. A phase-only trace (failed
 * turn, zero entries) still shows its phase row.
 *
 * Iron rule 6: load failures render only placeholder copy; rejection details
 * never reach the dialog.
 */
export function ProcessTraceDialog({ taskId, node, onClose }: ProcessTraceDialogProps) {
  const gateway = useForgeCoreGateway();
  const panelRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TraceDialogState>({ status: 'loading' });

  const isSkill = node.kind === 'skill';
  const turnId = node.turnId ?? null;

  useEffect(() => {
    let cancelled = false;
    if (isSkill) {
      setState({ status: 'loading' });
      gateway.getSkillContent(taskId, node.title).then(
        (skill) => {
          if (!cancelled) setState({ status: 'skill', skill });
        },
        () => {
          if (!cancelled) setState({ status: 'error' });
        },
      );
    } else if (turnId !== null) {
      setState({ status: 'loading' });
      gateway.getTurnTrace(taskId, turnId).then(
        (trace) => {
          if (cancelled) return;
          // A failed turn may persist a phase-only trace (zero entries); the
          // phase row still renders. Only old traces without any phase AND
          // without entries fall back to the placeholder.
          if (trace.entries.length === 0 && trace.phase === undefined) {
            setState({ status: 'empty' });
          } else {
            setState({ status: 'trace', trace });
          }
        },
        () => {
          if (!cancelled) setState({ status: 'error' });
        },
      );
    } else {
      setState({ status: 'empty' });
    }
    return () => {
      cancelled = true;
    };
  }, [gateway, taskId, node.id, node.title, isSkill, turnId]);

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
      onClose();
    }
  };

  return (
    <div className="fc-node-detail__backdrop" onKeyDown={handleKeyDown}>
      <div
        className="fc-node-detail fc-trace"
        role="dialog"
        aria-modal="true"
        aria-label={node.title}
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="fc-node-detail__header">
          <h2 className="fc-node-detail__title">{node.title}</h2>
          <button
            type="button"
            className="fc-drawer__close"
            aria-label="关闭浮窗"
            onClick={onClose}
          >
            关闭
          </button>
        </div>

        {state.status === 'loading' ? (
          <p className="fc-loading-note" role="status">
            正在加载浮窗内容…
          </p>
        ) : null}

        {state.status === 'empty' || (state.status === 'error' && !isSkill) ? (
          <p className="fc-trace__placeholder">
            暂无执行过程记录：该任务运行于过程记录功能上线之前，或该回合未产生过程信息。
          </p>
        ) : null}

        {state.status === 'error' && isSkill ? (
          <p className="fc-trace__placeholder">无法加载技能内容。</p>
        ) : null}

        {state.status === 'trace' ? (
          <>
            {state.trace.phase !== undefined ? (
              <p className={`fc-trace__phase fc-trace__phase--${state.trace.phase.state}`}>
                阶段：{phaseRowText(state.trace.phase)}
              </p>
            ) : null}
            <div className="fc-trace__sections">
              {state.trace.entries.map((entry, index) => {
                if (entry.kind === 'tool_call') {
                  return (
                    <section key={`${entry.kind}-${index}`} className="fc-trace__section">
                      <h3 className="fc-trace__section-title">工具调用：{entry.toolName}</h3>
                      <pre>{JSON.stringify(entry.params, null, 2)}</pre>
                    </section>
                  );
                }
                if (entry.kind === 'tool_result') {
                  return (
                    <section key={`${entry.kind}-${index}`} className="fc-trace__section">
                      <h3 className="fc-trace__section-title">工具返回：{entry.toolName}</h3>
                      <pre>{entry.text}</pre>
                    </section>
                  );
                }
                return (
                  <section key={`${entry.kind}-${index}`} className="fc-trace__section">
                    <h3 className="fc-trace__section-title">正文</h3>
                    <p className="fc-trace__text">{entry.text}</p>
                  </section>
                );
              })}
            </div>
          </>
        ) : null}

        {state.status === 'skill' ? (
          <div className="fc-trace__skill">
            <dl className="fc-node-detail__meta">
              <div className="fc-node-detail__meta-row">
                <dt>版本</dt>
                <dd className="fc-node-detail__value">
                  {state.skill.versionHash.slice(0, 12)}
                </dd>
              </div>
            </dl>
            <pre className="fc-trace__skill-content">{state.skill.content}</pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}
