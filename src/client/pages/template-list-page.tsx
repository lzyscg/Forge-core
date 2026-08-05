import { Link } from 'react-router-dom';
import { EmptyState } from '../components/empty-state';
import { StatusChip } from '../components/status-chip';
import { useForgeCoreGateway } from '../gateway/gateway-context';
import { useGatewayQuery } from '../hooks/use-gateway-query';
import { formatDateTime, templateStatusLabel, templateStatusTone } from './display';
import { PublicErrorNotice } from './public-error-notice';

/**
 * Template catalog. Every piece of content comes from Gateway summaries; the
 * page contains no business-specific conditionals (iron rule 1).
 */
export function TemplateListPage() {
  const gateway = useForgeCoreGateway();
  const query = useGatewayQuery(() => gateway.listTemplates(), [gateway]);
  const templates = query.data ?? [];

  return (
    <section className="fc-template-list-page">
      <h1 className="fc-page-title">模板</h1>

      {query.status === 'loading' && query.data === null ? (
        <p className="fc-loading-note">模板列表加载中…</p>
      ) : null}

      {query.status === 'error' && query.error !== null && query.data === null ? (
        <PublicErrorNotice title="加载模板列表失败。" error={query.error} />
      ) : null}

      {query.data !== null && templates.length === 0 ? (
        <EmptyState
          title="暂无可用模板"
          description="模板来自本地模板目录。新增模板并重新加载后，即可从这里选择模板创建任务。"
          action={
            <a className="fc-button fc-button--secondary" href="/templates">
              重新加载页面
            </a>
          }
        />
      ) : null}

      {templates.length > 0 ? (
        <ul className="fc-card-grid">
          {templates.map((template) => (
            <li key={template.id}>
              <article className="fc-template-card">
                <div className="fc-template-card__header">
                  <h2 className="fc-template-card__name">
                    <Link className="fc-inline-link" to={`/templates/${template.id}`}>
                      {template.name}
                    </Link>
                  </h2>
                  <StatusChip
                    tone={templateStatusTone(template.status)}
                    label={templateStatusLabel(template.status)}
                  />
                </div>
                <p className="fc-template-card__description">{template.description}</p>
                <p className="fc-template-card__meta">
                  <span>版本 {template.version}</span>
                  <span aria-hidden="true">·</span>
                  <span>{template.agentCount} 个 Agent</span>
                  <span aria-hidden="true">·</span>
                  <span>更新于</span>
                  <span>{formatDateTime(template.updatedAt)}</span>
                </p>
              </article>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
