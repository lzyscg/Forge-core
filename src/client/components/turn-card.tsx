import type { MouseEvent } from 'react';
import type { AgentSummary, LiveTurn, WorkspaceNode } from '../../shared/contracts';
import { nodeStatusLabel, nodeStatusTone } from '../pages/display';
import { StatusChip } from './status-chip';
import type { TurnGroup } from './group-turns';

export interface TurnCardProps {
  group: TurnGroup;
  /** Frozen template agent for names; null keeps ids as fallback labels. */
  agent: AgentSummary | null;
  /** Grid row assigned by the canvas (shared global sequence rows). */
  row: number;
  selectedNodeId: string | null;
  highlightedNodeId: string | null;
  expanded: boolean;
  /**
   * The task's live streaming buffer (plan C realtime streaming), when one
   * exists; the card shows the preview only while its group is the active
   * turn of the matching agent.
   */
  activeTurn?: LiveTurn | null;
  onSelectNode: (nodeId: string) => void;
  onToggleExpand: (groupKey: string) => void;
}

/**
 * One collapsible turn card merging the input, result and Skill steps of a
 * single agent Turn (plan B). DOM contract: the shell carries the turn
 * identity only — every member node keeps a hidden but measurable anchor
 * `<span id="node-<id>" data-testid="workspace-node">` inside the shell, so
 * anchor counts stay equal to node counts and FlowOverlay/locate/follow keep
 * working unchanged (anchors cover the full card via `inset: 0` and are
 * never display:none, collapsed or not).
 *
 * Interactions: [输入] opens the input detail dialog, [运行过程] the result's
 * process trace, a skill chip the skill snapshot; clicking anywhere else on
 * the card opens the default dialog (result first, input fallback). The
 * expand toggle only switches the in-card detail section — dialogs stay the
 * full-content surface.
 */
export function TurnCard({
  group,
  agent,
  row,
  selectedNodeId,
  highlightedNodeId,
  expanded,
  activeTurn,
  onSelectNode,
  onToggleExpand,
}: TurnCardProps) {
  const agentName = agent?.name ?? group.agentId;
  const members: WorkspaceNode[] = [
    ...(group.input !== undefined ? [group.input] : []),
    ...(group.result !== undefined ? [group.result] : []),
    ...group.skills,
  ];
  const memberIds = new Set(members.map((member) => member.id));
  const selected = selectedNodeId !== null && memberIds.has(selectedNodeId);
  const highlighted = highlightedNodeId !== null && memberIds.has(highlightedNodeId);

  const attempts = members.reduce((max, member) => Math.max(max, member.attemptCount), 1);
  const artifactVersion = group.result?.artifactVersion ?? null;
  const primary = group.result ?? group.input ?? null;
  const hasDetail = group.input !== undefined || group.result !== undefined;

  /**
   * Live streaming preview (plan C): only the ACTIVE turn card of the agent
   * that owns the live buffer renders it. The preview is independent of the
   * expand toggle — a running card always shows the stream.
   */
  const live =
    group.status === 'active' && activeTurn != null && activeTurn.agentId === group.agentId
      ? activeTurn
      : null;
  const liveIsEmpty =
    live !== null && live.text === '' && live.thinking === '' && live.tools.length === 0;

  const skillName = (skill: WorkspaceNode): string =>
    agent?.skills.find((item) => item.id === skill.title)?.name ?? skill.title;

  const handleShellClick = (event: MouseEvent<HTMLDivElement>): void => {
    // Buttons inside the card own their actions; the card body opens the
    // default dialog.
    if ((event.target as HTMLElement).closest('button') !== null) return;
    if (primary !== null) onSelectNode(primary.id);
  };

  const shellClasses = [
    'fc-turn',
    `fc-turn--${group.status}`,
    selected ? 'fc-node--selected' : '',
    highlighted ? 'fc-node--highlighted' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={shellClasses}
      data-testid="workspace-turn"
      style={{ gridRow: String(row) }}
      onClick={handleShellClick}
    >
      {members.map((member) => (
        <span
          key={member.id}
          className="fc-turn__anchor"
          id={`node-${member.id}`}
          data-testid="workspace-node"
          aria-hidden="true"
        />
      ))}

      <div className="fc-turn__summary">
        <span className="fc-turn__agent">{agentName}</span>
        <StatusChip tone={nodeStatusTone(group.status)} label={nodeStatusLabel(group.status)} />
        {attempts > 1 ? <span className="fc-turn__attempts">尝试 {attempts} 次</span> : null}
        {artifactVersion !== null ? (
          <span className="fc-turn__version">产物 V{artifactVersion}</span>
        ) : null}
        {group.skills.length > 0 ? (
          <span className="fc-turn__skills">
            {group.skills.map((skill) => (
              <button
                key={skill.id}
                type="button"
                className="fc-turn__skill-chip"
                aria-haspopup="dialog"
                onClick={() => onSelectNode(skill.id)}
              >
                技能:{skillName(skill)}
              </button>
            ))}
          </span>
        ) : null}
      </div>

      <div className="fc-turn__actions">
        {group.input !== undefined ? (
          <button
            type="button"
            className="fc-turn__button"
            aria-haspopup="dialog"
            onClick={() => onSelectNode(group.input!.id)}
          >
            输入
          </button>
        ) : null}
        {group.result !== undefined ? (
          <button
            type="button"
            className="fc-turn__button"
            aria-haspopup="dialog"
            onClick={() => onSelectNode(group.result!.id)}
          >
            运行过程
          </button>
        ) : null}
        {hasDetail ? (
          <button
            type="button"
            className="fc-turn__button"
            aria-expanded={expanded}
            onClick={() => onToggleExpand(group.key)}
          >
            {expanded ? '收起' : '展开'}
          </button>
        ) : null}
      </div>

      {live !== null ? (
        <div className="fc-turn__stream" aria-live="polite">
          {liveIsEmpty ? (
            <p className="fc-turn__stream-empty">运行中…</p>
          ) : (
            <>
              {live.thinking !== '' ? (
                <details className="fc-turn__stream-thinking">
                  <summary>思考过程</summary>
                  <p className="fc-turn__stream-thinking-text">{live.thinking}</p>
                </details>
              ) : null}
              {live.text !== '' ? (
                <p className="fc-turn__stream-text">{live.text}</p>
              ) : null}
              {live.tools.length > 0 ? (
                <ul className="fc-turn__stream-tools">
                  {live.tools.map((tool, index) => (
                    <li
                      key={`${tool.name}-${index}`}
                      className={`fc-turn__stream-tool fc-turn__stream-tool--${tool.state}`}
                    >
                      <span className="fc-turn__stream-tool-state">
                        {tool.state === 'running' ? '调用中' : '已完成'}
                      </span>
                      <span className="fc-turn__stream-tool-name">{tool.name}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {hasDetail && expanded ? (
        <div className="fc-turn__detail">
          {group.input !== undefined ? (
            <section className="fc-turn__detail-section">
              <h3 className="fc-turn__detail-title">输入</h3>
              <p className="fc-turn__detail-text">{group.input.body}</p>
            </section>
          ) : null}
          {group.result !== undefined ? (
            <section className="fc-turn__detail-section">
              <h3 className="fc-turn__detail-title">结果</h3>
              <p className="fc-turn__detail-text">{group.result.body}</p>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
