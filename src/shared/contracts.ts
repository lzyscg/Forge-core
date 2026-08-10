/**
 * Forge Core 前端与未来后端共享的产品契约。
 * 平台契约不含任何业务角色/产物/场景条件分支（铁律 1）；
 * 具体业务语义只允许出现在 Mock fixture 数据中。
 */
import type { StructuredSlotsSummaryV1 } from './structured-slots';

export type TaskStatus =
  | 'draft'
  | 'ready'
  | 'running'
  | 'waiting_human'
  | 'retryable_failure'
  | 'interrupted'
  | 'completed'
  | 'stopped'
  | 'corrupt'
  /**
   * Terminal read-only state of a historical frozen task whose snapshot lacks
   * a supported turn contract (plan 2026-08-04 Task 3, spec §7.3): the task
   * can only be viewed, exported or cloned onto the current template — never
   * started, resumed or retried.
   */
  | 'incompatible';

export type NodeKind = 'input' | 'result' | 'human_request' | 'human_answer' | 'skill';
export type RouteKind = 'message' | 'artifact';

/**
 * A human answer submitted through the answer flow (spec §11.1/§11.5).
 * `answer` is an ordinary text reply (the only shape an `agent_request`
 * question accepts); `continue`/`accept` are the structured decisions a
 * `progress_guard` question offers, carrying the guidance text; `stop` stops
 * the task. The platform vocabulary stays neutral: no business semantics.
 */
export type HumanDecision =
  | { decision: 'answer'; text: string }
  | { decision: 'continue'; text: string }
  | { decision: 'accept'; text: string }
  | { decision: 'stop' };
export type MockScenarioId =
  | 'happy_path'
  | 'review_return_v2'
  | 'transient_retry'
  | 'manual_retry'
  | 'human_input'
  | 'refresh_recovery';

export interface InputField {
  id: string;
  label: string;
  kind: 'text' | 'textarea';
  required: boolean;
  description: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  model: string;
  skills: SkillSummary[];
}

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  agentCount: number;
  status: 'valid' | 'invalid_using_cache';
  updatedAt: string;
}

export interface TemplateDetail extends TemplateSummary {
  inputFields: InputField[];
  agents: AgentSummary[];
  routes: Array<{ from: string; to: string; kind: RouteKind; label: string }>;
  finalOutput: { name: string; format: 'markdown' | 'text'; submitters: string[] };
}

export interface TaskSummary {
  id: string;
  name: string;
  templateId: string;
  templateName: string;
  status: TaskStatus;
  currentAgentName: string | null;
  latestVersion: number | null;
  updatedAt: string;
  diagnostic: string | null;
}

export interface WorkspaceNode {
  id: string;
  sequence: number;
  agentId: string;
  kind: NodeKind;
  title: string;
  body: string;
  status: 'confirmed' | 'active' | 'failed';
  attemptCount: number;
  /**
   * The artifact version this input node carries (spec §8.1; was
   * `artifactVersion`). Propagated along routes at dispatch time; null for
   * non-artifact inputs. Legacy events read back through the normalize
   * transform carry the migrated value here.
   */
  inputVersion: number | null;
  /**
   * True only when the platform's human-accept path synthesized this input
   * (spec §7.1). Absent → false. The committer never sets it; only the
   * scheduler accept path may.
   */
  humanAuthorized?: boolean;
  /**
   * Display-only (spec §11.2): true when `pending_inputs_superseded` voided
   * this input node. Superseded inputs are never pending, are skipped by the
   * runner, and render as voided on the canvas; absent → false.
   */
  superseded?: boolean;
  /**
   * The Turn that produced this node's observable content (result/skill
   * nodes carry a value; everything else stays null). Lets the canvas fetch
   * the node's execution trace without ever touching the authoritative
   * event union (plan Phase E).
   */
  turnId?: string | null;
}

/**
 * One observable public step of a model Turn. Traces are display-only, stored
 * outside the canonical event union, and never feed delivery gates
 * (plan Phase E, Global Constraint 5). Provider raw thinking is NEVER durable:
 * only public text and tool steps survive (semantic audit P0, plan 2026-08-07).
 */
export type TraceEntry =
  | { kind: 'tool_call'; toolName: string; params: Record<string, unknown> }
  | { kind: 'tool_result'; toolName: string; text: string }
  | { kind: 'text'; text: string };

/**
 * One turn-phase state of the production/dispatch turn contract
 * (plan 2026-08-04, spec §4.1). `production`/`production_complete`/
 * `dispatching` are transient states reserved for the realtime iteration;
 * persisted traces of completed turns carry `dispatched`, `waiting_human`
 * or `failed`.
 */
export type TurnPhaseState =
  | 'production'
  | 'production_complete'
  | 'dispatching'
  | 'dispatched'
  | 'waiting_human'
  | 'failed';

/** The one dispatch action a turn performed (null before dispatch). */
export type TurnPhaseDispatchAction =
  | 'send_message'
  | 'publish_artifact'
  | 'forward_input_version'
  | 'submit_final_artifact'
  | 'request_human_input';

/**
 * Display-only final phase summary of one Turn, derived by the platform
 * from the validated action set — never filled in by the model and never
 * authoritative: task completion, routing and delivery stay event-driven
 * (spec §7.4). `target` carries the dispatch target agent id when one
 * exists; `message` carries a public, presentable supplement.
 */
export interface TurnTracePhase {
  state: TurnPhaseState;
  dispatchAction: TurnPhaseDispatchAction | null;
  target: string | null;
  message: string | null;
}

export interface TurnTrace {
  turnId: string;
  /** Optional phase summary; historical traces without it stay legal. */
  phase?: TurnTracePhase;
  entries: TraceEntry[];
}

/** Full Skill text with its snapshot version, for display only. */
export interface SkillContent {
  skillId: string;
  content: string;
  versionHash: string;
}

export interface WorkspaceRoute {
  id: string;
  sequence: number;
  fromNodeId: string;
  toNodeId: string;
  kind: RouteKind;
  label: string;
}

/**
 * One file slot of an artifact version (spec §3.4). `extract` names the
 * template-declared extract slot (content/review/revision); `content` carries
 * the file body for display. Legacy single-file versions degrade to one
 * `content`-extract slot.
 */
export interface ArtifactFile {
  name: string;
  extract: string;
  content: string;
}

export interface ArtifactVersion {
  id: string;
  version: number;
  title: string;
  files: ArtifactFile[];
  sourceNodeId: string;
  createdAt: string;
  final: boolean;
}

/**
 * One in-flight tool call of the running Turn, shown in the live preview
 * (plan C realtime streaming; display only, never persisted).
 */
export interface LiveToolCall {
  name: string;
  state: 'running' | 'done';
}

/**
 * Memory-only live preview of the one running Turn of a task (plan C
 * realtime streaming). Served from the server's in-memory buffer (real
 * runtime) or derived from the scenario clock (mock) — never written to
 * files or events. Provider raw thinking is never streamed here either
 * (semantic audit P0, plan 2026-08-07): only public text and tool calls.
 */
export interface LiveTurn {
  agentId: string;
  turnId: string;
  status: 'running';
  /** Cumulative public assistant text streamed so far. */
  text: string;
  tools: LiveToolCall[];
  updatedAt: string;
}

export interface TaskWorkspace {
  task: TaskSummary;
  frozenInput: Record<string, string>;
  templateVersion: string;
  agents: AgentSummary[];
  declaredRoutes: TemplateDetail['routes'];
  nodes: WorkspaceNode[];
  executedRoutes: WorkspaceRoute[];
  artifacts: ArtifactVersion[];
  pendingHumanQuestion: string | null;
  /**
   * The source of the pending human request (spec §11.5): `progress_guard`
   * offers the structured three-choice (continue/accept/stop); `agent_request`
   * is an ordinary model-asked question that accepts only a text answer. Null
   * when no human request is pending.
   */
  pendingHumanSource: 'progress_guard' | 'agent_request' | null;
  /**
   * The live streaming preview of the task's running Turn, when one is in
   * flight; null/absent otherwise (plan C realtime streaming).
   */
  activeTurn?: LiveTurn | null;
  /**
   * Optional structured-slots summary (spec §14 / design I01). Absent for
   * basic tasks; never embeds content, the full tree, Grants or private
   * Drafts. Populated by the structured-slot engine.
   */
  structuredSlots?: StructuredSlotsSummaryV1;
}

export type CapabilityStage =
  | 'not_started'
  | 'mock_ready'
  | 'backend_connected'
  | 'verified'
  | 'needs_repair';

export interface CapabilityEvidence {
  id: string;
  label: string;
  productShape: CapabilityStage;
  backendConnection: CapabilityStage;
  realAcceptance: CapabilityStage;
  command: string | null;
  observedAt: string | null;
}
