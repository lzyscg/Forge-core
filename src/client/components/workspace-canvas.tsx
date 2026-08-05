import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSummary, TaskWorkspace, WorkspaceNode } from '../../shared/contracts';
import { nodeKindLabel, nodeStatusLabel } from '../pages/display';
import { FlowOverlay } from './flow-overlay';
import { groupTurns, type TurnGroup } from './group-turns';
import { TurnCard } from './turn-card';

export interface WorkspaceCanvasProps {
  workspace: TaskWorkspace;
  selectedNodeId: string | null;
  highlightedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  /** Bumped when drawers toggle so the flow overlay re-fits the layout. */
  drawerRevision: number;
}

/** Auto-follow threshold: ≤80 px from the newest edge counts as "at latest". */
const FOLLOW_EDGE_PX = 80;

const STATUS_ICONS: Record<WorkspaceNode['status'], string> = {
  confirmed: '✓',
  active: '●',
  failed: '✕',
};

interface NodeButtonProps {
  node: WorkspaceNode;
  row: number;
  selected: boolean;
  highlighted: boolean;
  onSelect: (nodeId: string) => void;
}

/**
 * Standalone card for nodes that never merge into a turn: human requests and
 * answers (plan B keeps their existing interaction).
 */
function NodeButton({ node, row, selected, highlighted, onSelect }: NodeButtonProps) {
  const classes = [
    'fc-node',
    `fc-node--kind-${node.kind}`,
    `fc-node--${node.status}`,
    selected ? 'fc-node--selected' : '',
    highlighted ? 'fc-node--highlighted' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      id={`node-${node.id}`}
      data-testid="workspace-node"
      className={classes}
      style={{ gridRow: String(row) }}
      aria-haspopup="dialog"
      onClick={() => onSelect(node.id)}
    >
      <span className="fc-node__meta">
        <span className="fc-node__icon" aria-hidden="true">
          {STATUS_ICONS[node.status]}
        </span>
        <span className="fc-node__kind">{nodeKindLabel(node.kind)}</span>
        <span className="fc-node__status">{nodeStatusLabel(node.status)}</span>
      </span>
      <span className="fc-node__title">{node.title}</span>
      <span className="fc-node__footer">
        {node.attemptCount > 1 ? (
          <span className="fc-node__attempts">尝试 {node.attemptCount} 次</span>
        ) : null}
        {node.artifactVersion !== null ? (
          <span className="fc-node__version">产物 V{node.artifactVersion}</span>
        ) : null}
      </span>
    </button>
  );
}

type LaneEntry =
  | { kind: 'node'; row: number; node: WorkspaceNode }
  | { kind: 'group'; row: number; group: TurnGroup };

/**
 * Dynamic production canvas. Agent lanes come from the frozen template order
 * (never hardcoded); every node stays mounted — turn members as hidden
 * anchors inside one turn card per turn, human nodes as standalone buttons —
 * and every entry occupies one global grid row, so time flows top-to-bottom
 * across lanes while the viewport scrolls horizontally. New nodes auto-follow
 * only while the user already sits at the newest edge; otherwise the position
 * is preserved and a “有新进展” control offers to jump forward.
 */
export function WorkspaceCanvas({
  workspace,
  selectedNodeId,
  highlightedNodeId,
  onSelectNode,
  drawerRevision,
}: WorkspaceCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atEdgeRef = useRef(true);
  const latestKeyRef = useRef<string | null>(null);
  const [showNewProgress, setShowNewProgress] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [expandRevision, setExpandRevision] = useState(0);

  const nodes = useMemo(
    () => [...workspace.nodes].sort((a, b) => a.sequence - b.sequence),
    [workspace.nodes],
  );

  const { groups, looseNodes } = useMemo(() => groupTurns(nodes), [nodes]);

  // One shared grid row per sequence across every lane.
  const sequenceRows = useMemo(() => {
    const values = [...new Set(workspace.nodes.map((node) => node.sequence))].sort(
      (a, b) => a - b,
    );
    return new Map(values.map((sequence, index) => [sequence, index + 1]));
  }, [workspace.nodes]);

  const latestNode = nodes.length > 0 ? nodes[nodes.length - 1] : null;

  const measureKey = useMemo(
    () => workspace.nodes.map((node) => `${node.id}:${node.sequence}:${node.status}`).join('|'),
    [workspace.nodes],
  );

  const agentsById = useMemo(() => {
    const map = new Map<string, AgentSummary>();
    for (const agent of workspace.agents) map.set(agent.id, agent);
    return map;
  }, [workspace.agents]);

  const entriesByLane = useMemo(() => {
    const map = new Map<string, LaneEntry[]>();
    const push = (agentId: string, entry: LaneEntry): void => {
      const list = map.get(agentId);
      if (list) list.push(entry);
      else map.set(agentId, [entry]);
    };
    for (const group of groups) {
      push(group.agentId, { kind: 'group', row: group.row, group });
    }
    for (const node of looseNodes) {
      push(node.agentId, { kind: 'node', row: node.sequence, node });
    }
    for (const list of map.values()) list.sort((a, b) => a.row - b.row);
    return map;
  }, [groups, looseNodes]);

  // Lanes follow the frozen template order; a node for an undeclared agent
  // (defensive path) still receives its own lane instead of disappearing.
  const lanes = useMemo(() => {
    const result = workspace.agents.map((agent) => ({ id: agent.id, name: agent.name }));
    const known = new Set(result.map((lane) => lane.id));
    for (const node of nodes) {
      if (!known.has(node.agentId)) {
        known.add(node.agentId);
        result.push({ id: node.agentId, name: node.agentId });
      }
    }
    return result;
  }, [workspace.agents, nodes]);

  const scrollToNode = useCallback((nodeId: string) => {
    const element = document.getElementById(`node-${nodeId}`);
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'center', inline: 'center' });
    }
  }, []);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const verticalGap = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const horizontalGap = viewport.scrollWidth - viewport.scrollLeft - viewport.clientWidth;
    const atEdge = verticalGap <= FOLLOW_EDGE_PX && horizontalGap <= FOLLOW_EDGE_PX;
    atEdgeRef.current = atEdge;
    if (atEdge) setShowNewProgress(false);
  }, []);

  useEffect(() => {
    const key = latestNode ? latestNode.id : null;
    if (key === null) return;
    if (latestKeyRef.current === key) return;
    const isFirst = latestKeyRef.current === null;
    latestKeyRef.current = key;
    // Initial mount keeps the origin; following applies to new nodes only.
    if (isFirst) return;
    if (atEdgeRef.current) {
      scrollToNode(key);
    } else {
      setShowNewProgress(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestNode?.id, scrollToNode]);

  const jumpToLatest = useCallback(() => {
    if (!latestNode) return;
    scrollToNode(latestNode.id);
    atEdgeRef.current = true;
    setShowNewProgress(false);
  }, [latestNode, scrollToNode]);

  const toggleGroup = useCallback((groupKey: string) => {
    setExpandedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
    // Collapsing/expanding changes card heights: re-fit the flow overlay.
    setExpandRevision((revision) => revision + 1);
  }, []);

  const rowCount = Math.max(sequenceRows.size, 1);

  return (
    <div className="fc-canvas-area">
      <div
        className="fc-canvas"
        data-testid="workspace-canvas"
        ref={viewportRef}
        onScroll={handleScroll}
      >
        <div className="fc-canvas__content" ref={contentRef}>
          <FlowOverlay
            routes={workspace.executedRoutes}
            contentRef={contentRef}
            viewportRef={viewportRef}
            measureKey={measureKey}
            revision={drawerRevision + expandRevision}
          />
          <div className="fc-canvas__lanes">
            {lanes.map((lane) => (
              <section
                key={lane.id}
                className="fc-lane"
                id={`lane-${lane.id}`}
                aria-labelledby={`lane-heading-${lane.id}`}
              >
                <h2 className="fc-lane__heading" id={`lane-heading-${lane.id}`}>
                  {lane.name}
                </h2>
                <div
                  className="fc-lane__body"
                  style={{ gridTemplateRows: `repeat(${rowCount}, minmax(3.5rem, auto))` }}
                >
                  {(entriesByLane.get(lane.id) ?? []).map((entry) =>
                    entry.kind === 'node' ? (
                      <NodeButton
                        key={entry.node.id}
                        node={entry.node}
                        row={sequenceRows.get(entry.row) ?? 1}
                        selected={entry.node.id === selectedNodeId}
                        highlighted={entry.node.id === highlightedNodeId}
                        onSelect={onSelectNode}
                      />
                    ) : (
                      <TurnCard
                        key={entry.group.key}
                        group={entry.group}
                        agent={agentsById.get(entry.group.agentId) ?? null}
                        row={sequenceRows.get(entry.row) ?? 1}
                        selectedNodeId={selectedNodeId}
                        highlightedNodeId={highlightedNodeId}
                        expanded={expandedKeys.has(entry.group.key)}
                        activeTurn={workspace.activeTurn ?? null}
                        onSelectNode={onSelectNode}
                        onToggleExpand={toggleGroup}
                      />
                    ),
                  )}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
      {showNewProgress && latestNode ? (
        <button type="button" className="fc-button fc-new-progress" onClick={jumpToLatest}>
          有新进展
        </button>
      ) : null}
    </div>
  );
}
