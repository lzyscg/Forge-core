import type {
  ArtifactVersion,
  TaskStatus,
  TaskSummary,
  TaskWorkspace,
  TemplateDetail,
  WorkspaceNode,
  WorkspaceRoute,
} from '../../shared/contracts';
import { structuredProtocolOf } from '../../shared/authoritative-review-v2';
import type { MockTaskEvent, MockTaskRecord } from './mock-schema';

/**
 * Pure fold of a task record (frozen configuration + ordered append-only
 * events) into read-only views. Never mutates its input; all status, node,
 * route, artifact and human-question state is derived from the event history.
 */

interface ProjectionState {
  status: TaskStatus;
  lastAgentId: string | null;
  nodes: Map<string, WorkspaceNode>;
  nodeOrder: string[];
  /**
   * Input node ids voided by `pending_inputs_superseded` events (spec §11.2).
   * Voided nodes render as superseded and are never pending.
   */
  supersededNodeIds: Set<string>;
  routes: WorkspaceRoute[];
  artifacts: ArtifactVersion[];
  pendingHumanQuestion: string | null;
  pendingHumanSource: 'progress_guard' | 'agent_request' | null;
  finalArtifactId: string | null;
  maxSequence: number;
}

function createState(): ProjectionState {
  return {
    status: 'ready',
    lastAgentId: null,
    nodes: new Map(),
    nodeOrder: [],
    supersededNodeIds: new Set(),
    routes: [],
    artifacts: [],
    pendingHumanQuestion: null,
    pendingHumanSource: null,
    finalArtifactId: null,
    maxSequence: 0,
  };
}

function upsertNode(state: ProjectionState, node: WorkspaceNode): void {
  // Phase E turn attribution rides on the event node when present; every
  // other node stays null so the canvas never requests a trace it cannot have.
  const incoming: WorkspaceNode = { ...node, turnId: node.turnId ?? null };
  const existing = state.nodes.get(node.id);
  if (existing) {
    // Attempts only ever move forward; re-input after a failed attempt must
    // not regress the count or duplicate the node.
    incoming.attemptCount = Math.max(existing.attemptCount, incoming.attemptCount);
  } else {
    state.nodeOrder.push(node.id);
  }
  if (state.supersededNodeIds.has(node.id)) {
    // Display-only voided mark (spec §11.2): superseded inputs render as
    // superseded on the canvas and are never pending.
    incoming.superseded = true;
  }
  state.nodes.set(node.id, incoming);
  state.maxSequence = Math.max(state.maxSequence, incoming.sequence);
}

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

function applyEvent(state: ProjectionState, event: MockTaskEvent): void {
  switch (event.type) {
    case 'task_started':
      state.status = 'running';
      break;
    case 'task_stopped':
      state.status = 'stopped';
      break;
    case 'task_resumed':
      // Mirrors the server projector (plan 2026-08-06): resuming over an
      // unanswered question returns to waiting_human, never `running`.
      state.status = state.pendingHumanQuestion !== null ? 'waiting_human' : 'running';
      break;
    case 'task_interrupted':
      state.status = 'interrupted';
      break;
    case 'agent_input':
      upsertNode(state, event.node);
      state.lastAgentId = event.node.agentId;
      state.status = 'running';
      break;
    case 'agent_result':
      upsertNode(state, event.node);
      state.lastAgentId = event.node.agentId;
      state.status = 'running';
      break;
    case 'skill_loaded':
      // Skill loads only add the node and move agent attribution; they never
      // advance lifecycle state or finality (mirrors the server projector).
      upsertNode(state, event.node);
      state.lastAgentId = event.node.agentId;
      break;
    case 'agent_attempt_failed':
      markFailedAttempt(state, event.nodeId);
      state.status = event.retryable ? 'running' : 'retryable_failure';
      break;
    case 'route_executed':
      state.routes.push({ ...event.route });
      break;
    case 'artifact_published':
      state.artifacts.push({ ...event.artifact });
      break;
    case 'human_requested':
      upsertNode(state, event.node);
      state.lastAgentId = event.node.agentId;
      state.status = 'waiting_human';
      state.pendingHumanQuestion = event.question;
      // The mock simulates ordinary model-asked questions only (no
      // progress_guard), so the source is always agent_request (spec §11.5).
      state.pendingHumanSource = 'agent_request';
      break;
    case 'human_answered':
      upsertNode(state, event.node);
      state.lastAgentId = event.node.agentId;
      state.status = 'running';
      state.pendingHumanQuestion = null;
      state.pendingHumanSource = null;
      break;
    case 'pending_inputs_superseded':
      // Display-only voiding (spec §11.2): the referenced input nodes render
      // as superseded; already-projected nodes are marked in place, and any
      // input committed later under a voided id keeps the mark.
      for (const nodeId of event.supersededNodeIds) {
        state.supersededNodeIds.add(nodeId);
        const node = state.nodes.get(nodeId);
        if (node !== undefined) {
          node.superseded = true;
        }
      }
      break;
    case 'final_accepted':
      state.status = 'completed';
      state.finalArtifactId = event.artifactId;
      break;
  }
}

function fold(record: MockTaskRecord): ProjectionState {
  const state = createState();
  for (const event of record.events) applyEvent(state, event);
  return state;
}

const ACTIVE_AGENT_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'running',
  'waiting_human',
  'retryable_failure',
]);

/**
 * The mock simulates basic templates only (mock-gateway.ts): its frozen
 * `TemplateDetail` never declares a structured production mode. The protocol
 * still derives through the shared frozen-snapshot helper and fails closed to
 * 'none' exactly like the server — the mock never guesses a v2 protocol.
 */
function protocolOfMockTemplate(_template: TemplateDetail) {
  return structuredProtocolOf({ productionMode: 'basic', structuredSlots: null });
}

function buildSummary(record: MockTaskRecord, state: ProjectionState): TaskSummary {
  const agent =
    ACTIVE_AGENT_STATUSES.has(state.status) && state.lastAgentId !== null
      ? record.frozenTemplate.agents.find((item) => item.id === state.lastAgentId)
      : undefined;
  const latestVersion = state.artifacts.reduce(
    (max, artifact) => Math.max(max, artifact.version),
    0,
  );
  return {
    id: record.id,
    name: record.name,
    templateId: record.templateId,
    templateName: record.templateName,
    status: state.status,
    currentAgentName: agent ? agent.name : null,
    latestVersion: latestVersion > 0 ? latestVersion : null,
    updatedAt: record.updatedAt,
    diagnostic: null,
    structuredProtocol: protocolOfMockTemplate(record.frozenTemplate),
  };
}

export function projectTaskStatus(record: MockTaskRecord): TaskStatus {
  return fold(record).status;
}

export function projectTaskSummary(record: MockTaskRecord): TaskSummary {
  return buildSummary(record, fold(record));
}

export function projectMockWorkspace(record: MockTaskRecord): TaskWorkspace {
  const state = fold(record);
  const orderIndex = new Map(state.nodeOrder.map((id, index) => [id, index]));
  const nodes = [...state.nodes.values()].sort(
    (a, b) =>
      a.sequence - b.sequence || (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0),
  );
  const executedRoutes = [...state.routes].sort((a, b) => a.sequence - b.sequence);
  const artifacts = state.artifacts
    .map((artifact) => ({
      ...artifact,
      // Finality is decided exclusively by final_accepted, never by the
      // publish payload.
      final: state.finalArtifactId !== null && artifact.id === state.finalArtifactId,
    }))
    .sort((a, b) => a.version - b.version);

  return {
    task: buildSummary(record, state),
    frozenInput: { ...record.frozenInput },
    templateVersion: record.frozenTemplate.version,
    agents: record.frozenTemplate.agents.map((agent) => ({ ...agent, skills: [...agent.skills] })),
    declaredRoutes: record.frozenTemplate.routes.map((route) => ({ ...route })),
    nodes,
    executedRoutes,
    artifacts,
    pendingHumanQuestion: state.pendingHumanQuestion,
    pendingHumanSource: state.pendingHumanSource,
  };
}
