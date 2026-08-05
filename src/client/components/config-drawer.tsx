import type { TaskWorkspace } from '../../shared/contracts';
import { routeKindLabel } from '../pages/display';

export interface ConfigDrawerProps {
  workspace: TaskWorkspace;
  onClose: () => void;
}

/**
 * Read-only task configuration: frozen user input, template version, dynamic
 * Agents (name/model/skills) and declared routes. Strictly text — the drawer
 * contains no editable controls, per the “frozen after creation” contract.
 */
export function ConfigDrawer({ workspace, onClose }: ConfigDrawerProps) {
  const agentNames = new Map(workspace.agents.map((agent) => [agent.id, agent.name]));
  return (
    <aside className="fc-drawer fc-drawer--config" role="complementary" aria-label="任务配置">
      <div className="fc-drawer__header">
        <h2 className="fc-drawer__title">任务配置</h2>
        <button
          type="button"
          className="fc-drawer__close"
          aria-label="关闭配置抽屉"
          onClick={onClose}
        >
          关闭
        </button>
      </div>

      <section className="fc-config-block">
        <h3 className="fc-config-block__title">冻结用户输入</h3>
        <dl className="fc-config-dl">
          {Object.entries(workspace.frozenInput).map(([key, value]) => (
            <div key={key} className="fc-config-dl__row">
              <dt className="fc-config-dl__key">{key}</dt>
              <dd className="fc-config-dl__value">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="fc-config-block">
        <h3 className="fc-config-block__title">模板版本</h3>
        <p className="fc-config-text">{workspace.templateVersion}</p>
      </section>

      <section className="fc-config-block">
        <h3 className="fc-config-block__title">Agent</h3>
        <ul className="fc-config-agent-list">
          {workspace.agents.map((agent) => (
            <li key={agent.id} className="fc-config-agent">
              <p className="fc-config-agent__name">{agent.name}</p>
              <p className="fc-config-text">
                模型：<span>{agent.model}</span>
              </p>
              <ul className="fc-config-skill-list">
                {agent.skills.map((skill) => (
                  <li key={skill.id} className="fc-config-skill">
                    <span className="fc-config-skill__name">{skill.name}</span>
                    <span className="fc-config-skill__description">{skill.description}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>

      <section className="fc-config-block">
        <h3 className="fc-config-block__title">合法管道</h3>
        <ul className="fc-config-route-list">
          {workspace.declaredRoutes.map((route, index) => (
            <li
              key={`${route.from}-${route.to}-${route.kind}-${index}`}
              className="fc-config-route"
            >
              <span>{agentNames.get(route.from) ?? route.from}</span>
              <span aria-hidden="true"> → </span>
              <span>{agentNames.get(route.to) ?? route.to}</span>
              <span>：</span>
              <span>{route.label}</span>
              <span>（</span>
              <span>{routeKindLabel(route.kind)}</span>
              <span>）</span>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
