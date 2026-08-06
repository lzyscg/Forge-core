/**
 * Event-derived task projection (plan Phase B Task 4).
 *
 * Pure fold of immutable task identity (task record + frozen snapshot
 * template) and ordered committed events into the frozen `TaskWorkspace`
 * shape shared with the client (spec §9.4/§9.5). Never mutates its inputs;
 * never reads the filesystem; never infers completion from Agent text —
 * `completed` only follows `task_completed` or `final_submission_accepted`
 * (spec §6.4). Temporary residue never reaches here: the stores only hand
 * over committed, validated entries (spec §8.2).
 *
 * Fold semantics (mirroring the frozen Phase A mock projector so both
 * gateway implementations project identically):
 * - Nodes come from agent_input/agent_result/human_requested/human_answered
 *   payloads, keyed by the creating event id; `agent_attempt_failed` folds
 *   onto the node referenced by its `nodeId` (the input node the attempt
 *   belongs to), incrementing `attemptCount` and marking it `failed`.
 * - Status derivation lets the latest lifecycle event win; a retryable attempt
 *   failure keeps the task `running` (the runtime auto-retries), while a
 *   non-retryable one parks it in `retryable_failure`. `retry_scheduled` is an
 *   observability-only delay record and folds to nothing.
 * - Artifacts come from the store-validated version entries; the final flag
 *   is set exclusively by `final_submission_accepted` on a matching id.
 *
 * No business vocabulary lives here (iron rule 1).
 */
import type {
  AgentSummary,
  ArtifactVersion,
  TaskStatus,
  TaskSummary,
  TaskWorkspace,
  WorkspaceNode,
  WorkspaceRoute,
} from '../../shared/contracts';
import type { FrozenTemplate } from '../template/template-schema';
import type { TaskRecord } from './task-store';
import type { EventNode, TaskEvent } from './task-events';
import type { ArtifactEntry } from './artifact-store';

/** Identity inputs of one projection: immutable record + frozen snapshot. */
export interface TaskProjectionTask {
  record: TaskRecord;
  frozenTemplate: FrozenTemplate;
}

interface ProjectionState {
  status: TaskStatus;
  lastAgentId: string | null;
  /**
   * Turn id derived from the most recent `agent_result` event id (the
   * `-result` suffix stripped). Attribution anchor for skill nodes (plan
   * Phase E Task 3); null before any result.
   */
  lastResultTurnId: string | null;
  nodes: Map<string, WorkspaceNode>;
  nodeOrder: string[];
  routes: WorkspaceRoute[];
  pendingHumanQuestion: string | null;
  finalArtifactId: string | null;
  maxSequence: number;
  lastAt: string | null;
  /**
   * Public diagnostic of the latest `task_incompatible` event (plan
   * 2026-08-04 Task 3); surfaces on the terminal `incompatible` status.
   */
  incompatibleDiagnostic: string | null;
}

function createState(): ProjectionState {
  return {
    status: 'ready',
    lastAgentId: null,
    lastResultTurnId: null,
    nodes: new Map(),
    nodeOrder: [],
    routes: [],
    pendingHumanQuestion: null,
    finalArtifactId: null,
    maxSequence: 0,
    lastAt: null,
    incompatibleDiagnostic: null,
  };
}

/** The `-result` suffix committed result ids carry (runner id derivation). */
const RESULT_ID_SUFFIX = '-result';

/** Public diagnostic for one incompatibility reason (iron rules 1/6). */
function incompatibleDiagnosticFor(
  reason: 'TURN_CONTRACT_REQUIRED' | 'SCHEMA_V2_REQUIRED',
): string {
  switch (reason) {
    case 'TURN_CONTRACT_REQUIRED':
      return '任务冻结快照缺少当前回合契约，无法继续运行；可查看历史内容或使用当前模板克隆重建。';
    case 'SCHEMA_V2_REQUIRED':
      return '任务冻结快照使用旧版产物契约，无法继续运行；可查看历史内容或使用当前模板克隆重建。';
    default: {
      const unreachable: never = reason;
      return `任务冻结快照不兼容（${String(unreachable)}），无法继续运行。`;
    }
  }
}

function toWorkspaceNode(eventId: string, node: EventNode, turnId: string | null = null): WorkspaceNode {
  return {
    id: eventId,
    sequence: node.sequence,
    agentId: node.agentId,
    kind: node.kind,
    title: node.title,
    body: node.body,
    status: node.status,
    attemptCount: node.attemptCount,
    inputVersion: node.inputVersion,
    // Result nodes carry the Turn id derived from their event id; skill
    // nodes receive the most recent result's turn id; every other node
    // stays null so the canvas never requests a trace it cannot have.
    turnId,
  };
}

function upsertNode(
  state: ProjectionState,
  eventId: string,
  node: EventNode,
  turnId: string | null = null,
): void {
  const incoming = toWorkspaceNode(eventId, node, turnId);
  const existing = state.nodes.get(eventId);
  if (existing) {
    // Attempts only ever move forward; a replayed node must not regress.
    incoming.attemptCount = Math.max(existing.attemptCount, incoming.attemptCount);
  } else {
    state.nodeOrder.push(eventId);
  }
  state.nodes.set(eventId, incoming);
  state.maxSequence = Math.max(state.maxSequence, incoming.sequence);
}

/** Folds one failed attempt onto the node it references. */
function markFailedAttempt(state: ProjectionState, nodeId: string): void {
  const node = state.nodes.get(nodeId);
  if (node) {
    node.attemptCount += 1;
    node.status = 'failed';
    return;
  }
  // Defensive path: a failure referencing an unknown node still surfaces.
  const sequence = state.maxSequence + 1;
  state.maxSequence = sequence;
  state.nodeOrder.push(nodeId);
  state.nodes.set(nodeId, {
    id: nodeId,
    sequence,
    agentId: '',
    kind: 'result',
    title: '',
    body: '',
    status: 'failed',
    attemptCount: 1,
    inputVersion: null,
    turnId: null,
  });
}

function applyEvent(state: ProjectionState, event: TaskEvent): void {
  state.lastAt = event.at;
  switch (event.type) {
    case 'task_started':
      state.status = 'running';
      break;
    case 'task_stopped':
      state.status = 'stopped';
      break;
    case 'task_resumed':
      // A resume over an unanswered human question returns the task to the
      // waiting state instead of `running` (plan 2026-08-06): the run loop
      // never executes a Turn while a question is pending, and `answer` is
      // only reachable from waiting_human — projecting `running` here would
      // leave the question stranded.
      state.status = state.pendingHumanQuestion !== null ? 'waiting_human' : 'running';
      break;
    case 'task_interrupted':
      state.status = 'interrupted';
      break;
    case 'task_completed':
      state.status = 'completed';
      break;
    case 'task_incompatible':
      // Authoritative terminal lifecycle event (plan 2026-08-04 Task 3, spec
      // §7.3): the historical snapshot can only be viewed or cloned.
      state.status = 'incompatible';
      state.incompatibleDiagnostic = incompatibleDiagnosticFor(event.reason);
      break;
    case 'agent_input':
    case 'agent_result': {
      const turnId =
        event.type === 'agent_result' && event.id.endsWith(RESULT_ID_SUFFIX)
          ? event.id.slice(0, -RESULT_ID_SUFFIX.length)
          : null;
      upsertNode(state, event.id, event.node, turnId);
      if (event.type === 'agent_result') {
        state.lastResultTurnId = turnId;
      }
      state.lastAgentId = event.node.agentId;
      state.status = 'running';
      break;
    }
    case 'human_requested':
      upsertNode(state, event.id, event.node);
      state.lastAgentId = event.node.agentId;
      state.status = 'waiting_human';
      state.pendingHumanQuestion = event.question;
      break;
    case 'human_answered':
      upsertNode(state, event.id, event.node);
      state.lastAgentId = event.node.agentId;
      state.status = 'running';
      state.pendingHumanQuestion = null;
      break;
    case 'agent_attempt_failed':
      markFailedAttempt(state, event.nodeId);
      state.status = event.retryable ? 'running' : 'retryable_failure';
      break;
    case 'retry_scheduled':
      // Observability-only delay record (plan Task 5): the canvas folds every
      // attempt into its input node via agent_attempt_failed; the scheduled
      // delay neither changes status nor creates a node (spec §7.1).
      break;
    case 'route_executed':
      state.routes.push({
        id: event.id,
        sequence: event.route.sequence,
        fromNodeId: event.route.fromNodeId,
        toNodeId: event.route.toNodeId,
        kind: event.route.kind,
        label: event.route.label,
      });
      break;
    case 'artifact_published':
      // Version listing comes from the store-validated entries argument;
      // this event only documents the publication in the history.
      break;
    case 'final_submission_accepted':
      state.status = 'completed';
      state.finalArtifactId = event.artifactId;
      break;
    case 'skill_loaded': {
      // Phase E Task 3: fold the load into a display-only skill node keyed
      // by the event id, attributed to the most recent node-carrying agent
      // and anchored on that result's derived turn id. Task status is never
      // changed by a skill load.
      const existing = state.nodes.get(event.id);
      const sequence = existing !== undefined ? existing.sequence : state.maxSequence + 1;
      if (existing === undefined) {
        state.nodeOrder.push(event.id);
      }
      state.maxSequence = Math.max(state.maxSequence, sequence);
      state.nodes.set(event.id, {
        id: event.id,
        sequence,
        agentId: state.lastAgentId ?? '',
        kind: 'skill',
        title: event.skillId,
        body: event.skillId,
        status: 'confirmed',
        attemptCount: 1,
        inputVersion: null,
        turnId: state.lastResultTurnId,
      });
      break;
    }
  }
}

function fold(events: readonly TaskEvent[]): ProjectionState {
  const state = createState();
  for (const event of events) {
    applyEvent(state, event);
  }
  return state;
}

const ACTIVE_AGENT_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'running',
  'waiting_human',
  'retryable_failure',
]);

function buildSummary(
  task: TaskProjectionTask,
  state: ProjectionState,
  artifacts: readonly ArtifactEntry[],
): TaskSummary {
  const agent =
    ACTIVE_AGENT_STATUSES.has(state.status) && state.lastAgentId !== null
      ? task.frozenTemplate.agents.find((item) => item.id === state.lastAgentId)
      : undefined;
  const latestVersion = artifacts.reduce((max, entry) => Math.max(max, entry.meta.version), 0);
  return {
    id: task.record.id,
    name: task.record.name,
    templateId: task.record.templateId,
    templateName: task.record.templateName,
    status: state.status,
    currentAgentName: agent ? agent.name : null,
    latestVersion: latestVersion > 0 ? latestVersion : null,
    updatedAt: state.lastAt ?? task.record.createdAt,
    diagnostic: state.status === 'incompatible' ? state.incompatibleDiagnostic : null,
  };
}

function toAgentSummary(template: FrozenTemplate): AgentSummary[] {
  return template.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    model: agent.model,
    // The public shape drops skill content paths (frozen contracts parity).
    skills: agent.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
    })),
  }));
}

/**
 * Projects one task into the frozen workspace shape. Pure: identical inputs
 * always produce identical output; callers own any further caching.
 */
export function projectTask(
  task: TaskProjectionTask,
  events: readonly TaskEvent[],
  artifacts: readonly ArtifactEntry[],
): TaskWorkspace {
  const state = fold(events);
  const orderIndex = new Map(state.nodeOrder.map((id, index) => [id, index]));
  const nodes = [...state.nodes.values()].sort(
    (a, b) =>
      a.sequence - b.sequence || (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0),
  );
  const executedRoutes = [...state.routes].sort((a, b) => a.sequence - b.sequence);
  const inputVersions: ArtifactVersion[] = [...artifacts]
    .sort((a, b) => a.meta.version - b.meta.version)
    .map((entry) => ({
      id: entry.meta.id,
      version: entry.meta.version,
      title: entry.meta.title,
      // Phase 0 transitional: one `content`-extract slot per version. Phase 6
      // renders multi-file extract slots (content/review/revision).
      files: [
        {
          name: entry.meta.format === 'markdown' ? 'content.md' : 'content.txt',
          extract: 'content',
          content: entry.content,
        },
      ],
      sourceNodeId: entry.meta.sourceNodeId,
      createdAt: entry.meta.createdAt,
      // Finality is decided exclusively by final_submission_accepted, never
      // by the publish payload (spec §6.4).
      final: state.finalArtifactId !== null && entry.meta.id === state.finalArtifactId,
    }));

  return {
    task: buildSummary(task, state, artifacts),
    frozenInput: { ...task.record.frozenInput },
    templateVersion: task.record.templateVersion,
    agents: toAgentSummary(task.frozenTemplate),
    declaredRoutes: task.frozenTemplate.routes.map((route) => ({ ...route })),
    nodes,
    executedRoutes,
    artifacts: inputVersions,
    pendingHumanQuestion: state.pendingHumanQuestion,
  };
}
