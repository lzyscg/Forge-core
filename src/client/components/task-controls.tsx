import { useState, type FormEvent } from 'react';
import type { TaskStatus, TaskSummary } from '../../shared/contracts';
import type { PublicCoreError } from '../../shared/errors';
import type { RecoveryRecipeKeyV2 } from '../../shared/authoritative-review-v2';
import { useForgeCoreGateway } from '../gateway/gateway-context';
import { toPublicCoreError } from '../hooks/use-gateway-query';
import { PublicErrorNotice } from '../pages/public-error-notice';

export interface TaskControlsProps {
  task: TaskSummary;
  pendingHumanQuestion: string | null;
  /**
   * Source of the pending human request (spec §11.5): `progress_guard`
   * renders the structured three-choice (continue/accept/stop); `agent_request`
   * keeps the plain answer form. Null when no question is pending.
   */
  pendingHumanSource: 'progress_guard' | 'agent_request' | null;
}

type LifecycleAction = 'startTask' | 'stopTask' | 'resumeTask' | 'retryTask';

interface LifecycleControl {
  action: LifecycleAction;
  label: string;
}

/**
 * Controls mapped purely from the public task status (plan Step 6 table):
 * ready → start; running → stop; stopped → resume; interrupted and
 * retryable_failure → continue-or-retry plus stop; waiting_human → stop plus
 * the answer form; completed/corrupt → no mutating control. Buttons only
 * call formal gateway methods; they never choose a scenario or manufacture
 * an error.
 */
const CONTROLS_BY_STATUS: Partial<Record<TaskStatus, LifecycleControl[]>> = {
  ready: [{ action: 'startTask', label: '开始生产' }],
  running: [{ action: 'stopTask', label: '停止' }],
  waiting_human: [{ action: 'stopTask', label: '停止' }],
  stopped: [{ action: 'resumeTask', label: '继续' }],
  interrupted: [
    { action: 'resumeTask', label: '继续' },
    { action: 'stopTask', label: '停止' },
  ],
  retryable_failure: [
    { action: 'retryTask', label: '重试' },
    { action: 'stopTask', label: '停止' },
  ],
  /**
   * v2 permanent failure (spec §10.3/§10.3.1): terminal for every ordinary
   * lifecycle command. The recovery surface lives OUTSIDE the ordinary
   * controls — the component renders the bounded failed summary (source +
   * stable code + only the server-returned legal reopen recipes, or the clone
   * fallback) instead of this table.
   */
  failed: [],
};

/**
 * Bounded reasons shown for each legal v2 reopen recipe (spec §10.3.1). The
 * recipe/track PAIRING itself comes from the server's failedRecovery summary
 * — the client never invents a recipe.
 */
const RECIPE_LABELS: Record<RecoveryRecipeKeyV2, string> = {
  retry_system_command: '重试失败的系统命令',
  restart_map_review_cycle: '重启 Map 评审轮次',
  restart_content_review_cycle: '重启内容评审轮次',
  rebuild_missing_work: '重建缺失的执行工作项',
};

const REOPEN_REASON_MAX_CODE_POINTS = 1000;

/**
 * Lifecycle controls mapped purely from task.status: 开始生产 / 停止 / 继续 /
 * 重试 call the matching gateway method by name, and waiting_human adds the
 * answer form. Failures surface as public error notices; the controls stay
 * usable. The deterministic demonstration plays through the existing watch
 * path: each simulator event notifies watchers and the page reloads its
 * workspace.
 */
export function TaskControls({ task, pendingHumanQuestion, pendingHumanSource }: TaskControlsProps) {
  const gateway = useForgeCoreGateway();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<PublicCoreError | null>(null);
  const [answer, setAnswer] = useState('');
  const [answerProblem, setAnswerProblem] = useState<string | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [reopenRecipe, setReopenRecipe] = useState<
    { recipeKey: RecoveryRecipeKeyV2; track: 'map' | 'content' | null } | null
  >(null);
  const [reopenProblem, setReopenProblem] = useState<string | null>(null);

  const controls = CONTROLS_BY_STATUS[task.status] ?? [];
  const showAnswerForm = task.status === 'waiting_human';
  const showStructuredDecision = showAnswerForm && pendingHumanSource === 'progress_guard';
  // Accept requires at least one published version (spec §11.5); the server
  // re-validates, this disables the option before the request.
  const acceptDisabled = (task.latestVersion ?? 0) < 1;

  const runAction = async (action: LifecycleAction): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await gateway[action](task.id);
    } catch (cause) {
      setError(toPublicCoreError(cause));
    } finally {
      setPending(false);
    }
  };

  // v2 failed-task recovery surface (spec §10.3.1): source + stable code +
  // only the policy-allowed actions. Ordinary retry/resume stay disabled —
  // the status table above renders NO ordinary controls for `failed`.
  const failedRecovery = task.failedRecovery ?? null;
  const showRecoverySurface = task.status === 'failed' && failedRecovery !== null;

  // B-M7 (documented): the v2 question events carry NO source discriminator in
  // the frozen union — every opened question is an AGENT request in the first
  // release, so the workspace summary pins source='agent_request'. A future
  // release that opens SYSTEM/progress-guard questions must add the source to
  // the opened event and wire it through the projection + this summary; until
  // then, hardcoding it is loud and explicit (see core-service enrichment).

  const submitReopen = async (): Promise<void> => {
    if (failedRecovery === null || reopenRecipe === null) return;
    const codePoints = [...reopenReason.trim()];
    if (codePoints.length === 0) {
      setReopenProblem('请填写恢复原因后再提交。');
      return;
    }
    if (codePoints.length > REOPEN_REASON_MAX_CODE_POINTS) {
      setReopenProblem(`恢复原因不能超过 ${REOPEN_REASON_MAX_CODE_POINTS} 个字符。`);
      return;
    }
    setReopenProblem(null);
    setPending(true);
    setError(null);
    try {
      await gateway.reopenFailed(task.id, {
        expectedLastSequence: failedRecovery.failedSequence,
        operationId: crypto.randomUUID(),
        reason: reopenReason.trim(),
        recipeKey: reopenRecipe.recipeKey,
        track: reopenRecipe.track,
      });
    } catch (cause) {
      setError(toPublicCoreError(cause));
    } finally {
      setPending(false);
    }
  };

  const submitAnswer = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (answer.trim().length === 0) {
      setAnswerProblem('回答不能为空，请填写后再提交。');
      return;
    }
    setAnswerProblem(null);
    setPending(true);
    setError(null);
    try {
      await gateway.answerHuman(task.id, answer);
      setAnswer('');
    } catch (cause) {
      setError(toPublicCoreError(cause));
    } finally {
      setPending(false);
    }
  };

  const submitDecision = async (decision: 'continue' | 'accept' | 'stop'): Promise<void> => {
    if (decision !== 'stop' && answer.trim().length === 0) {
      setAnswerProblem('请填写对本次人工干预的处理指引后再提交。');
      return;
    }
    setAnswerProblem(null);
    setPending(true);
    setError(null);
    try {
      await gateway.submitHumanDecision(
        task.id,
        decision === 'stop'
          ? { decision: 'stop' }
          : { decision, text: answer },
      );
      setAnswer('');
    } catch (cause) {
      setError(toPublicCoreError(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="fc-task-controls">
      {controls.map((control, index) => (
        <button
          key={control.action}
          type="button"
          className={index === 0 ? 'fc-button' : 'fc-button fc-button--secondary'}
          disabled={pending}
          onClick={() => void runAction(control.action)}
        >
          {control.label}
        </button>
      ))}
      {showAnswerForm ? (
        <div className="fc-answer-form">
          {pendingHumanQuestion !== null ? (
            <p className="fc-answer-form__question">{pendingHumanQuestion}</p>
          ) : null}
          {showStructuredDecision ? (
            <>
              <label className="fc-answer-form__label" htmlFor="fc-answer-input">
                人工干预处理指引（作为继续推进或人工接受的依据）
              </label>
              <textarea
                id="fc-answer-input"
                className="fc-answer-form__input"
                value={answer}
                disabled={pending}
                onChange={(event) => setAnswer(event.target.value)}
              />
              {answerProblem !== null ? (
                <p className="fc-answer-form__problem" role="alert">
                  {answerProblem}
                </p>
              ) : null}
              <div className="fc-answer-form__decisions">
                <button
                  type="button"
                  className="fc-button"
                  disabled={pending}
                  onClick={() => void submitDecision('continue')}
                >
                  继续推进
                </button>
                <button
                  type="button"
                  className="fc-button fc-button--secondary"
                  disabled={pending || acceptDisabled}
                  onClick={() => void submitDecision('accept')}
                  title={acceptDisabled ? '尚无已发布产物版本，无法人工接受。' : undefined}
                >
                  人工接受
                </button>
                <button
                  type="button"
                  className="fc-button fc-button--secondary"
                  disabled={pending}
                  onClick={() => void submitDecision('stop')}
                >
                  停止任务
                </button>
              </div>
            </>
          ) : (
            <form onSubmit={(event) => void submitAnswer(event)}>
              <label className="fc-answer-form__label" htmlFor="fc-answer-input">
                回答
              </label>
              <textarea
                id="fc-answer-input"
                className="fc-answer-form__input"
                value={answer}
                disabled={pending}
                onChange={(event) => setAnswer(event.target.value)}
              />
              {answerProblem !== null ? (
                <p className="fc-answer-form__problem" role="alert">
                  {answerProblem}
                </p>
              ) : null}
              <button type="submit" className="fc-button" disabled={pending}>
                提交回答
              </button>
            </form>
          )}
        </div>
      ) : null}
      {error !== null ? <PublicErrorNotice title="任务操作失败" error={error} /> : null}

      {showRecoverySurface ? (
        <div className="fc-recovery-panel">
          <h3 className="fc-recovery-panel__title">任务已失败</h3>
          <dl className="fc-recovery-panel__meta">
            <div className="fc-recovery-panel__meta-item">
              <dt>失败原因</dt>
              <dd>{task.diagnostic ?? '权威评审执行失败。'}</dd>
            </div>
            <div className="fc-recovery-panel__meta-item">
              <dt>失败码</dt>
              <dd>
                <code>{failedRecovery?.failureCode}</code>
              </dd>
            </div>
          </dl>
          {failedRecovery !== null && failedRecovery.reopenAllowed && failedRecovery.legalRecipes.length > 0 ? (
            <>
              <label className="fc-answer-form__label" htmlFor="fc-reopen-reason">
                恢复原因（用于审计，必填，{REOPEN_REASON_MAX_CODE_POINTS} 字符以内）
              </label>
              <textarea
                id="fc-reopen-reason"
                className="fc-answer-form__input"
                value={reopenReason}
                disabled={pending}
                onChange={(event) => setReopenReason(event.target.value)}
              />
              <div className="fc-recovery-panel__recipes">
                {failedRecovery.legalRecipes.map((recipe) => (
                  <label key={`${recipe.recipeKey}:${recipe.track ?? ''}`} className="fc-recovery-panel__recipe">
                    <input
                      type="radio"
                      name="fc-reopen-recipe"
                      checked={reopenRecipe?.recipeKey === recipe.recipeKey}
                      disabled={pending}
                      onChange={() => setReopenRecipe(recipe)}
                    />
                    {RECIPE_LABELS[recipe.recipeKey] ?? recipe.recipeKey}
                  </label>
                ))}
              </div>
              {reopenProblem !== null ? (
                <p className="fc-answer-form__problem" role="alert">
                  {reopenProblem}
                </p>
              ) : null}
              <button
                type="button"
                className="fc-button"
                disabled={pending || reopenRecipe === null}
                onClick={() => void submitReopen()}
              >
                按所选配方恢复
              </button>
            </>
          ) : (
            <div className="fc-recovery-panel__fallback">
              <p>该失败不可就地恢复，请克隆为新任务重跑。</p>
              <button
                type="button"
                className="fc-button fc-button--secondary"
                disabled={pending}
                onClick={() => {
                  setPending(true);
                  setError(null);
                  void gateway
                    .cloneTask(task.id)
                    .catch((cause: unknown) => setError(toPublicCoreError(cause)))
                    .finally(() => setPending(false));
                }}
              >
                克隆为新任务
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
