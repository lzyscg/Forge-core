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
import type { StructuredIssueV1, StructuredSlotsSummaryV1 } from '../../shared/structured-slots';
import { structuredProtocolOf } from '../../shared/authoritative-review-v2';
import { makeStructuredIssue } from '../structured-slots/issues';
import type { FrozenTemplate } from '../template/template-schema';
import type { TaskRecord } from './task-store';
import type { EventNode, TaskEvent } from './task-events';
import type { ArtifactEntry } from './artifact-store';
import { projectStructuredSlotState } from './structured-slot-state';

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
  /**
   * Input node ids voided by `pending_inputs_superseded` events (spec §11.2).
   * Voided nodes render as superseded and are never pending.
   */
  supersededNodeIds: Set<string>;
  routes: WorkspaceRoute[];
  pendingHumanQuestion: string | null;
  pendingHumanSource: 'progress_guard' | 'agent_request' | null;
  finalArtifactId: string | null;
  maxSequence: number;
  lastAt: string | null;
  /**
   * Public diagnostic of the latest `task_incompatible` event (plan
   * 2026-08-04 Task 3); surfaces on the terminal `incompatible` status.
   */
  incompatibleDiagnostic: string | null;
}

/**
 * Derives the display extract slot for one committed artifact file (semantic
 * audit P1, plan 2026-08-07). The frozen template's `artifactSchema` is the
 * source of truth for the extract name — never a filename heuristic. A file
 * without a schema entry (legacy artifact, or a legacy snapshot whose pipeline
 * declared no artifactSchema) falls back to the Phase-1 filename mapping.
 */
function extractForFile(frozen: FrozenTemplate, name: string): string {
  const declared = frozen.artifactSchema?.files?.find((file) => file.name === name);
  if (declared !== undefined) {
    return declared.extract;
  }
  if (name === 'review.md') return 'review';
  if (name === 'revision.md') return 'revision';
  return 'content';
}

function createState(): ProjectionState {
  return {
    status: 'ready',
    lastAgentId: null,
    lastResultTurnId: null,
    nodes: new Map(),
    nodeOrder: [],
    supersededNodeIds: new Set(),
    routes: [],
    pendingHumanQuestion: null,
    pendingHumanSource: null,
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
  if (state.supersededNodeIds.has(eventId)) {
    // Display-only voided mark (spec §11.2): superseded inputs render as
    // superseded on the canvas and are never pending.
    incoming.superseded = true;
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
      state.pendingHumanSource = event.source ?? 'agent_request';
      break;
    case 'human_answered':
      upsertNode(state, event.id, event.node);
      state.lastAgentId = event.node.agentId;
      state.status = 'running';
      state.pendingHumanQuestion = null;
      state.pendingHumanSource = null;
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
    // Protocol identity of the frozen snapshot (spec §4.1): the projector
    // owns the task's frozen template, so this is the authoritative production
    // derivation — never status/template-id/event heuristics.
    structuredProtocol: structuredProtocolOf(task.frozenTemplate),
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
 * One content-revision root mapping (spec §7.1): slotId -> 'unset' | digest.
 * This is the ONLY blob-derived input the summary accepts — a verifiable
 * projection of the authoritative events (design §18.3), never content-inline.
 */
export type StructuredContentRootV1 = Readonly<Record<string, 'unset' | string>>;

/**
 * Projects one task into the frozen workspace shape. Pure: identical inputs
 * always produce identical output; callers own any further caching.
 *
 * `structuredContentRoot` is the ACTIVE generation's content root mapping
 * (read by the caller from the content-addressed blob referenced by the
 * authoritative events) and drives the summary's exact `filledSlotCount`.
 */
export function projectTask(
  task: TaskProjectionTask,
  events: readonly TaskEvent[],
  artifacts: readonly ArtifactEntry[],
  structuredContentRoot?: StructuredContentRootV1 | null,
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
      // Map every committed file to a display slot: the extract name derives
      // from the frozen template's artifactSchema (semantic audit P1), with a
      // legacy filename fallback for schemas that do not declare the file.
      files: entry.files.map((file) => ({
        name: file.name,
        extract: extractForFile(task.frozenTemplate, file.name),
        content: file.content,
      })),
      sourceNodeId: entry.meta.sourceNodeId,
      createdAt: entry.meta.createdAt,
      // Finality is decided exclusively by final_submission_accepted, never
      // by the publish payload (spec §6.4).
      final: state.finalArtifactId !== null && entry.meta.id === state.finalArtifactId,
    }));

  const workspace: TaskWorkspace = {
    task: buildSummary(task, state, artifacts),
    frozenInput: { ...task.record.frozenInput },
    templateVersion: task.record.templateVersion,
    agents: toAgentSummary(task.frozenTemplate),
    declaredRoutes: task.frozenTemplate.routes.map((route) => ({ ...route })),
    nodes,
    executedRoutes,
    artifacts: inputVersions,
    pendingHumanQuestion: state.pendingHumanQuestion,
    pendingHumanSource: state.pendingHumanSource,
  };
  // Structured templates always carry the summary; basic workspaces omit the
  // field entirely (spec §14 / I01). The summary is a pure fold of
  // authoritative structured events plus the active content root and never
  // embeds content, the full tree, Grants or private Drafts.
  const structuredSlots = projectStructuredSlotsSummary(events, task.frozenTemplate, structuredContentRoot);
  if (structuredSlots !== null) {
    workspace.structuredSlots = structuredSlots;
  }
  return workspace;
}

/**
 * Owner-visible issues derived from authoritative structured events (spec §14
 * / design F06). v1 folds the ONLY persistent issue-like records the events
 * carry — stale fill drafts — into a registered `DRAFT_STALE` error. Failed
 * attempts are transient runtime states, not validation issues, and private
 * Proposal/Draft journals are never read by the owner projection.
 */
export function deriveOwnerIssues(events: readonly TaskEvent[]): StructuredIssueV1[] {
  const issues: StructuredIssueV1[] = [];
  for (const event of events) {
    if (event.type === 'structured_fill_draft_terminal' && event.status === 'stale') {
      // The draft was superseded by a newer revision before it merged — a
      // lifecycle error the audit view must surface. No draft identity is
      // echoed (the issue stays operation-located and detail-free).
      issues.push(makeStructuredIssue('DRAFT_STALE', 'merge', { kind: 'operation' }, {}));
    }
  }
  return issues;
}

/** The last committed generation event (authoritative active identity). */
function latestGenerationEvent(events: readonly TaskEvent[]): Extract<
  TaskEvent,
  { type: 'structured_scaffold_generation_committed' }
> | null {
  let latest: Extract<TaskEvent, { type: 'structured_scaffold_generation_committed' }> | null = null;
  for (const event of events) {
    if (event.type === 'structured_scaffold_generation_committed') {
      latest = event;
    }
  }
  return latest;
}

/**
 * The structured summary fold (spec §14 / I01). Basic templates return null
 * (the workspace omits the field). For structured templates the summary is a
 * pure function of authoritative committed events PLUS the active content root
 * (design §18.3 "权威事件加可验证 blob 投影"): identity/status from the
 * structured state projection, `visibleSlotCount` from the active generation's
 * committed slot count (the owner sees every formal slot), `filledSlotCount`
 * as the EXACT set-count of the active generation's content root (0 when no
 * content root is committed or the caller cannot resolve one — never a
 * cumulative change-count across generations, which would double-count slots
 * and leak superseded-generation merges), and `issueSummary` from the same
 * owner-visible issue fold the read-only API serves.
 */
export function projectStructuredSlotsSummary(
  events: readonly TaskEvent[],
  frozen: FrozenTemplate,
  contentRoot?: StructuredContentRootV1 | null,
): StructuredSlotsSummaryV1 | null {
  if (frozen.productionMode !== 'structured_slots') {
    return null;
  }
  const state = projectStructuredSlotState(events);
  const generation = latestGenerationEvent(events);
  const visibleSlotCount = generation?.slotCount ?? 0;
  let filledSlotCount = 0;
  if (contentRoot !== undefined && contentRoot !== null) {
    for (const value of Object.values(contentRoot)) {
      if (value !== 'unset') filledSlotCount += 1;
    }
    // Defensive bound: the root is scoped to the active generation, but a
    // stale root must never report more than the visible slot count.
    if (filledSlotCount > visibleSlotCount) {
      filledSlotCount = visibleSlotCount;
    }
  }
  const issues = deriveOwnerIssues(events);
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  return {
    version: 1,
    mode: 'structured_slots',
    scaffoldId: state.scaffoldId,
    generationId: state.generationId,
    contentRevision: state.contentRevision,
    structureStatus: state.structureStatus,
    sealStatus: state.sealStatus,
    visibleSlotCount,
    filledSlotCount,
    issueSummary: { errors, warnings: issues.length - errors },
  };
}
