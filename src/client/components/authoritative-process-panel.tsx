import type { AgentSummary } from '../../shared/contracts';
import type {
  AuthoritativeActivityStepStateV2,
  AuthoritativeReviewActivityV2,
} from '../../shared/authoritative-review-v2';

const STATE_LABELS: Record<AuthoritativeActivityStepStateV2, string> = {
  queued: '排队中',
  running: '进行中',
  retrying: '等待重试',
  completed: '已完成',
  failed: '失败',
  parked: '已暂停',
  superseded: '已替代',
};

const KIND_LABELS: Record<string, string> = {
  agent_assignment: 'Agent 任务',
  system_map_finalize: '系统整理 Map',
  system_generation_finalize: '系统整理内容',
  system_repair_finalize: '系统收尾修复',
  system_migration_validation_batch: '系统迁移校验',
  system_review_settlement: '系统结算审核',
  system_seal: '系统封存',
};

function agentLabel(roleBinding: string | null, agents: readonly AgentSummary[]): string {
  if (roleBinding === null) return '系统';
  return agents.find((agent) => agent.id === roleBinding)?.name ?? roleBinding;
}

function stateClass(state: AuthoritativeActivityStepStateV2): string {
  return `fc-authoritative-process__step--${state}`;
}

/** Read-only view of the v2 WorkItem/Attempt projection. */
export function AuthoritativeProcessPanel({
  activity,
  agents,
}: {
  activity: AuthoritativeReviewActivityV2;
  agents: readonly AgentSummary[];
}) {
  return (
    <section className="fc-authoritative-process" aria-label="权威生产过程">
      <header className="fc-authoritative-process__header">
        <div>
          <p className="fc-eyebrow">V2 WORKITEM / ATTEMPT PROJECTION</p>
          <h2 className="fc-authoritative-process__title">权威生产过程</h2>
        </div>
        <div className="fc-authoritative-process__summary" aria-label="过程完成度">
          <strong>已完成 {activity.completedWorkItems} / {activity.totalWorkItems}</strong>
          {activity.activeWorkItemId !== null ? (
            <span>当前：{activity.activeWorkItemId}</span>
          ) : (
            <span>当前：—</span>
          )}
        </div>
      </header>

      {activity.steps.length === 0 ? (
        <p className="fc-authoritative-process__empty" role="status">
          尚未创建 v2 WorkItem。
        </p>
      ) : (
        <ol className="fc-authoritative-process__list">
          {activity.steps.map((step, index) => (
            <li
              key={step.workItemId}
              className={`fc-authoritative-process__step ${stateClass(step.state)}`}
              data-testid={`authoritative-process-step-${step.workItemId}`}
            >
              <div className="fc-authoritative-process__rail" aria-hidden="true">
                <span>{index + 1}</span>
              </div>
              <div className="fc-authoritative-process__body">
                <div className="fc-authoritative-process__step-head">
                  <strong>{agentLabel(step.roleBinding, agents)}</strong>
                  <span className="fc-status-chip" data-state={step.state}>
                    {STATE_LABELS[step.state]}
                  </span>
                </div>
                <div className="fc-authoritative-process__step-meta">
                  <span>{KIND_LABELS[step.kind] ?? step.kind}</span>
                  {step.sessionKind !== null ? <span>{step.sessionKind}</span> : null}
                  <span>尝试 {step.attemptCount} 次</span>
                </div>
                <code className="fc-authoritative-process__id" title={step.workItemId}>
                  {step.workItemId}
                </code>
                {step.failureCode !== null ? (
                  <span className="fc-authoritative-process__failure">失败码：{step.failureCode}</span>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
