import type { WorkspaceNode } from '../../shared/contracts';

/**
 * One merged turn of a single agent: the input the agent worked on, the
 * result it produced, and every Skill loaded inside that same Turn. Grouping
 * is display-only — routing, traces and delivery stay event-driven; the
 * canvas simply renders one collapsible card per turn instead of three
 * separate node cards.
 */
export interface TurnGroup {
  key: string;
  agentId: string;
  /** The sequence that owns the group's canvas grid row. */
  row: number;
  input?: WorkspaceNode;
  result?: WorkspaceNode;
  skills: WorkspaceNode[];
  status: WorkspaceNode['status'];
}

export interface GroupedNodes {
  groups: TurnGroup[];
  /** Nodes deliberately kept standalone: human requests and answers. */
  looseNodes: WorkspaceNode[];
}

function isHumanNode(node: WorkspaceNode): boolean {
  return node.kind === 'human_request' || node.kind === 'human_answer';
}

/**
 * Pure grouping over the workspace nodes. Rules:
 * - human_request / human_answer never merge; they stay standalone cards;
 * - each result R (turnId T) forms a group with the nearest preceding, not
 *   yet claimed input of the same agent and every skill whose turnId is T;
 * - a trailing input without a result (running or failed turn) forms its own
 *   group on the input row;
 * - skills whose turn id matches no result attach to the nearest same-agent
 *   group (ties prefer the earlier group); agents without any group give
 *   their skill a standalone chip group.
 */
export function groupTurns(nodes: readonly WorkspaceNode[]): GroupedNodes {
  const sorted = [...nodes].sort((a, b) => a.sequence - b.sequence);
  const looseNodes = sorted.filter(isHumanNode);
  const groups: TurnGroup[] = [];
  const skills: WorkspaceNode[] = [];
  const byAgent = new Map<string, WorkspaceNode[]>();

  for (const node of sorted) {
    if (isHumanNode(node)) continue;
    if (node.kind === 'skill') {
      skills.push(node);
      continue;
    }
    const list = byAgent.get(node.agentId);
    if (list) list.push(node);
    else byAgent.set(node.agentId, [node]);
  }

  for (const [agentId, agentNodes] of byAgent) {
    let pendingInput: WorkspaceNode | null = null;
    for (const node of agentNodes) {
      if (node.kind === 'input') {
        pendingInput = node;
        continue;
      }
      const group: TurnGroup = {
        key: `turn-${node.id}`,
        agentId,
        row: node.sequence,
        result: node,
        skills: [],
        status: node.status,
      };
      if (pendingInput !== null) {
        group.input = pendingInput;
        pendingInput = null;
      }
      groups.push(group);
    }
    if (pendingInput !== null) {
      groups.push({
        key: `turn-${pendingInput.id}`,
        agentId,
        row: pendingInput.sequence,
        input: pendingInput,
        skills: [],
        status: pendingInput.status,
      });
    }
  }

  for (const skill of skills) {
    const sameAgent = groups.filter((group) => group.agentId === skill.agentId);
    let target =
      skill.turnId != null
        ? sameAgent.find((group) => group.result?.turnId === skill.turnId)
        : undefined;
    if (target === undefined && sameAgent.length > 0) {
      target = sameAgent.reduce((nearest, group) => {
        const distance = Math.abs(group.row - skill.sequence);
        const nearestDistance = Math.abs(nearest.row - skill.sequence);
        if (distance < nearestDistance) return group;
        if (distance === nearestDistance && group.row < nearest.row) return group;
        return nearest;
      });
    }
    if (target !== undefined) {
      target.skills.push(skill);
    } else {
      groups.push({
        key: `turn-${skill.id}`,
        agentId: skill.agentId,
        row: skill.sequence,
        skills: [skill],
        status: skill.status,
      });
    }
  }

  groups.sort((a, b) => a.row - b.row);
  return { groups, looseNodes };
}
