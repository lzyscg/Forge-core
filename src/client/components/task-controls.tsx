import { useState, type FormEvent } from 'react';
import type { TaskStatus, TaskSummary } from '../../shared/contracts';
import type { PublicCoreError } from '../../shared/errors';
import { useForgeCoreGateway } from '../gateway/gateway-context';
import { toPublicCoreError } from '../hooks/use-gateway-query';
import { PublicErrorNotice } from '../pages/public-error-notice';

export interface TaskControlsProps {
  task: TaskSummary;
  pendingHumanQuestion: string | null;
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
};

/**
 * Lifecycle controls mapped purely from task.status: 开始生产 / 停止 / 继续 /
 * 重试 call the matching gateway method by name, and waiting_human adds the
 * answer form. Failures surface as public error notices; the controls stay
 * usable. The deterministic demonstration plays through the existing watch
 * path: each simulator event notifies watchers and the page reloads its
 * workspace.
 */
export function TaskControls({ task, pendingHumanQuestion }: TaskControlsProps) {
  const gateway = useForgeCoreGateway();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<PublicCoreError | null>(null);
  const [answer, setAnswer] = useState('');
  const [answerProblem, setAnswerProblem] = useState<string | null>(null);

  const controls = CONTROLS_BY_STATUS[task.status] ?? [];
  const showAnswerForm = task.status === 'waiting_human';

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
        <form className="fc-answer-form" onSubmit={(event) => void submitAnswer(event)}>
          {pendingHumanQuestion !== null ? (
            <p className="fc-answer-form__question">{pendingHumanQuestion}</p>
          ) : null}
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
      ) : null}
      {error !== null ? <PublicErrorNotice title="任务操作失败" error={error} /> : null}
    </div>
  );
}
