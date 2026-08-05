import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { PublicCoreError } from '../../shared/errors';
import { StatusChip } from '../components/status-chip';
import { useForgeCoreGateway } from '../gateway/gateway-context';
import { toPublicCoreError, useGatewayQuery } from '../hooks/use-gateway-query';
import {
  artifactFormatLabel,
  formatDateTime,
  routeKindLabel,
  templateStatusLabel,
  templateStatusTone,
} from './display';
import { PublicErrorNotice } from './public-error-notice';

/**
 * Read-only template explanation: declared inputs, dynamic Agent order with
 * models and Skill summaries, declared routes and the final output. Reload
 * goes exclusively through Gateway.reloadTemplate; on failure the previous
 * valid detail stays visible (spec §4.3, §9.1).
 */
export function TemplateDetailPage() {
  const gateway = useForgeCoreGateway();
  const { templateId } = useParams();
  const query = useGatewayQuery(
    () => gateway.getTemplate(templateId ?? ''),
    [gateway, templateId],
  );
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<PublicCoreError | null>(null);

  const handleReload = async (): Promise<void> => {
    if (!templateId || reloading) return;
    setReloading(true);
    setReloadError(null);
    try {
      await gateway.reloadTemplate(templateId);
      query.reload();
    } catch (error) {
      setReloadError(toPublicCoreError(error));
    } finally {
      setReloading(false);
    }
  };

  if (query.data === null) {
    return (
      <section className="fc-template-detail-page">
        <h1 className="fc-page-title">模板详情</h1>
        {query.status === 'error' && query.error !== null ? (
          <>
            <PublicErrorNotice title="加载模板详情失败。" error={query.error} />
            <p className="fc-page-recovery">
              <Link className="fc-inline-link" to="/templates">
                返回模板列表
              </Link>
            </p>
          </>
        ) : (
          <p className="fc-loading-note">模板详情加载中…</p>
        )}
      </section>
    );
  }

  const detail = query.data;
  const agentName = (agentId: string): string =>
    detail.agents.find((agent) => agent.id === agentId)?.name ?? agentId;

  return (
    <section className="fc-template-detail-page">
      <header className="fc-template-detail-page__header">
        <h1 className="fc-page-title">{detail.name}</h1>
        <StatusChip
          tone={templateStatusTone(detail.status)}
          label={templateStatusLabel(detail.status)}
        />
      </header>
      <p className="fc-template-detail-page__description">{detail.description}</p>
      <p className="fc-template-detail-page__meta">
        <span>版本 {detail.version}</span>
        <span aria-hidden="true">·</span>
        <span>{detail.agentCount} 个 Agent</span>
        <span aria-hidden="true">·</span>
        <span>更新于</span>
        <span>{formatDateTime(detail.updatedAt)}</span>
      </p>

      {reloadError !== null ? (
        <PublicErrorNotice title="重新加载模板失败。" error={reloadError} />
      ) : null}
      {query.status === 'error' && query.error !== null ? (
        <PublicErrorNotice title="刷新模板详情失败。" error={query.error} />
      ) : null}

      <section className="fc-detail-block" aria-labelledby="fc-detail-inputs">
        <h2 id="fc-detail-inputs">输入字段</h2>
        <ul className="fc-detail-block__list">
          {detail.inputFields.map((field) => (
            <li key={field.id} className="fc-detail-item">
              <h3 className="fc-detail-item__title">
                {field.label}
                {field.required ? (
                  <span className="fc-detail-item__badge">必填</span>
                ) : null}
              </h3>
              <p className="fc-detail-item__body">{field.description}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="fc-detail-block" aria-labelledby="fc-detail-agents">
        <h2 id="fc-detail-agents">Agent 顺序</h2>
        <ol className="fc-detail-block__list">
          {detail.agents.map((agent) => (
            <li key={agent.id} className="fc-detail-item">
              <h3 className="fc-detail-item__title">{agent.name}</h3>
              <p className="fc-detail-item__body">{agent.description}</p>
              <p className="fc-detail-item__model">
                模型：<span>{agent.model}</span>
              </p>
              {agent.skills.length > 0 ? (
                <ul className="fc-detail-item__skills">
                  {agent.skills.map((skill) => (
                    <li key={skill.id}>
                      <h4 className="fc-detail-item__skill-name">{skill.name}</h4>
                      <p className="fc-detail-item__body">{skill.description}</p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      <section className="fc-detail-block" aria-labelledby="fc-detail-routes">
        <h2 id="fc-detail-routes">声明路由</h2>
        <ul className="fc-detail-block__list">
          {detail.routes.map((route, index) => (
            // Routes are display-only; the index key is stable per template.
            // eslint-disable-next-line react/no-array-index-key
            <li key={`${route.from}-${route.to}-${index}`} className="fc-detail-item">
              {`${agentName(route.from)} → ${agentName(route.to)}：${route.label}（${routeKindLabel(route.kind)}）`}
            </li>
          ))}
        </ul>
      </section>

      <section className="fc-detail-block" aria-labelledby="fc-detail-final">
        <h2 id="fc-detail-final">最终出口</h2>
        <p className="fc-template-detail-page__final">
          <span>{detail.finalOutput.name}</span>
          <span aria-hidden="true">·</span>
          <span>{artifactFormatLabel(detail.finalOutput.format)}</span>
        </p>
        <p className="fc-template-detail-page__submitters">{`合法提交者：${detail.finalOutput.submitters
          .map(agentName)
          .join('、')}`}</p>
      </section>

      <div className="fc-template-detail-page__actions">
        <button
          type="button"
          className="fc-button fc-button--secondary"
          onClick={() => {
            void handleReload();
          }}
          disabled={reloading}
        >
          {reloading ? '重新加载中…' : '重新加载模板'}
        </button>
        <Link className="fc-button" to={`/tasks/new?template=${detail.id}`}>
          使用此模板创建任务
        </Link>
      </div>
    </section>
  );
}
