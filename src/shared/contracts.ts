/**
 * Forge Core 前端与未来后端共享的产品契约。
 * 平台契约不含任何业务角色/产物/场景条件分支（铁律 1）；
 * 具体业务语义只允许出现在 Mock fixture 数据中。
 */
import type {
  JsonObject,
  JsonValue,
  StructuredIssueV1,
  StructuredSlotTreeCursorV1,
  StructuredSlotsSummaryV1,
} from './structured-slots';
import type { BlobRefV2 } from './authoritative-review-v2';

/** Re-exported so gateway consumers import the seal fact from one place. */
export type { SealRecord } from './structured-slots';

/**
 * Re-exports of the authoritative per-slot review v2 shared contracts (spec
 * 2026-08-14 §5.1): the closed blob kinds and BlobRefV2, the profile
 * bootstrap and execution eligibility, public Map/review/Finding/Seal DTOs,
 * the pending question, the versioned answer/delete/reopen mutations and the
 * v2 workspace summary. The module `authoritative-review-v2.ts` stays the
 * single source; consumers keep importing the concrete names from there when
 * they do not need the whole surface.
 */
export type {
  AnswerTaskBodyV2,
  ArtifactProvenanceV2,
  AuthoritativeBlobKindV2,
  AuthoritativeExecutionEligibilityReasonV1,
  AuthoritativeFindingSummaryV2,
  AuthoritativeMapSummaryV2,
  AuthoritativeRelationSummaryV2,
  AuthoritativeReviewExecutionEligibilityV1,
  AuthoritativeReviewProfileSnapshotV1,
  AuthoritativeReviewRoundSummaryV2,
  AuthoritativeReviewSummaryV2,
  AuthoritativeReviewWorkspaceV2,
  AuthoritativeSealReadinessSummaryV2,
  BlobRefV2,
  CollectionPageV2,
  DeleteTaskBodyV2,
  DeleteTaskResultV2,
  FailedTaskRecoverySummaryV2,
  FailureRecoveryPayloadV2,
  FindingDefectClassV2,
  FindingPrimaryLocationKindV2,
  FindingSeverityV2,
  FindingSourceV2,
  FindingStatusV2,
  PendingQuestionV2,
  PendingQuestionSourceV2,
  RecoveryRecipeKeyV2,
  RelationshipPolicyModeV2,
  ReopenFailedRequestV2,
  ReviewRoundKindV2,
  ReviewRoundStateV2,
  RoundBudgetOverrideV2,
  SealRecordV2,
  SnapshotCursorV2,
  StructuredProtocol,
  StructuredProtocolSource,
  SystemArtifactDeliveryV2,
  WorkItemKindV2,
} from './authoritative-review-v2';
export {
  AUTHORITATIVE_BLOB_KINDS_V2,
  QUESTION_VERSION_TOKEN_PATTERN,
  QUESTION_VERSION_TOKEN_REGEX,
  UUID_V4_PATTERN,
  UUID_V4_REGEX,
  isQuestionVersionToken,
  isUuidV4,
  structuredProtocolOf,
} from './authoritative-review-v2';

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
  | 'incompatible'
  /**
   * Formal v2 permanent failure (spec §10.3/§17.2): projected ONLY by the
   * `structured_task_failed_v2` event family, never by v1 events. Terminal
   * for ordinary start/resume/retry/answer; only the fenced, reasoned,
   * idempotent `reopen_failed` command may create replacement work (Task 11).
   */
  | 'failed';

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
  /**
   * Structured-slot protocol of the task's FROZEN template snapshot (spec
   * §4.1/§10.5): 'none' | 'v1' | 'v2'. Required on every summary so the
   * client never guesses from status, template ID or events. Production
   * projections derive it from the frozen snapshot via the shared helper;
   * historical/corrupt fallbacks fail closed to 'none' (never guess v2).
   */
  structuredProtocol: 'none' | 'v1' | 'v2';
  /**
   * Bounded failed-task recovery summary (spec §10.3.1): present ONLY on a
   * v2 task projected `failed`. Carries the stable failure code, failed
   * sequence, the policy-allowed legal recipe keys/tracks, `reopenAllowed`
   * and the clone fallback — never private refs or evidence. Absent (the
   * field stays unspecified on the wire) for every v1/basic/non-failed
   * summary, so v1 bytes remain unchanged.
   */
  failedRecovery?: import('./authoritative-review-v2').FailedTaskRecoverySummaryV2;
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

export interface ArtifactVersionV1 {
  /** Absent on legacy wire payloads; when present it is the authority tag. */
  protocolVersion?: 1;
  id: string;
  version: number;
  title: string;
  files: ArtifactFile[];
  sourceNodeId: string;
  createdAt: string;
  final: boolean;
}

/** System-Seal-published artifact.  There is deliberately no sourceNodeId. */
export interface ArtifactVersionV2 {
  protocolVersion: 2;
  id: string;
  version: number;
  title: string;
  files: ArtifactFile[];
  createdAt: string;
  final: boolean;
  producerWorkItemId: string;
  sealRecordRef: BlobRefV2;
  artifactRef: BlobRefV2;
  custodyRef: BlobRefV2;
  templateSnapshotHash: string;
  deliveryRef: BlobRefV2;
  sourceNodeId?: never;
}

/** Exact public authority union; v1 and v2 provenance cannot be fabricated. */
export type ArtifactVersion = ArtifactVersionV1 | ArtifactVersionV2;

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
   * Drafts. Populated by the structured-slot engine. v2 tasks carry the
   * versioned `authoritativeReview` summary instead (spec §14/§19.2).
   */
  structuredSlots?: StructuredSlotsSummaryV1;
  /**
   * Versioned authoritative per-slot review summary (spec §14/§19.2): v2
   * tasks carry this instead of the v1 `structuredSlots` summary. Optional
   * on the wire so v1 and basic workspaces decode unchanged.
   */
  authoritativeReview?: import('./authoritative-review-v2').AuthoritativeReviewWorkspaceV2;
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

/* ------------------- read-only structured slots API (spec §14) ------------------- */

/**
 * Public projection of the frozen structured-slot contract (spec §14 / I02).
 * The owner audit view exposes the slot types, layout grammar, limits and the
 * ABI/profile identity — but NEVER implementation paths, validator/Assembler
 * source registrations, accessProfiles (ACL) or the resource manifest (host
 * paths). `specSchema` / grammar `children` are plain serialized JSON (the
 * compiled schemas drop their internal hash/matcher fields).
 */
export interface StructuredSlotPublicContractV1 {
  version: 1;
  slotTypes: Array<{
    id: string;
    name: string;
    description: string;
    specSchema: JsonObject;
    content:
      | { presence: 'forbidden' }
      | { presence: 'optional' | 'required'; schema: JsonObject };
  }>;
  layoutGrammar: {
    rootType: string;
    productions: Record<
      string,
      {
        children: JsonObject;
        nullable: boolean;
        minConsumption: number;
        maxConsumption: number;
        first: string[];
        generatable: boolean;
      }
    >;
  };
  limits: import('./structured-slots').StructuredSlotLimitsV1;
  abiProfileIdentity: {
    validatorAbi: 'forge-validator/v1';
    assemblerAbi: 'forge-assembler/v1';
    profileIdentity: 'forge-structured-runtime/v1';
  };
  semanticDigest: string;
}

/** One row of the owner outline (mirrors the projection entry, spec §14). */
export interface StructuredSlotOutlineEntryV1 {
  slotId: string;
  typeId: string;
  contentPresence: 'unset' | 'set';
  parentSlotId: string | null;
  /** True for an ancestor outline shell (no spec, D04). */
  shell: boolean;
  level: 'outline' | 'spec' | 'content';
  spec?: JsonObject;
}

/** Paged owner outline; the cursor is the signed, bound tree cursor. */
export interface StructuredSlotOutlinePageV1 {
  entries: StructuredSlotOutlineEntryV1[];
  nextCursor: StructuredSlotTreeCursorV1 | null;
}

/** Ancestor outline shell of a visible deep node (root first). */
export interface StructuredSlotAncestorV1 {
  slotId: string;
  typeId: string;
  contentPresence: 'unset' | 'set';
}

/** The authorized projection of one slot (spec §14 / design §10.6). */
export interface StructuredSlotReadV1 {
  slotId: string;
  typeId: string;
  contentPresence: 'unset' | 'set';
  level: 'outline' | 'spec' | 'content';
  spec?: JsonObject;
  content?: JsonValue;
  ancestors: StructuredSlotAncestorV1[];
}

/** GET /slots/:slotId response body. */
export interface StructuredSlotReadResponseV1 {
  slot: StructuredSlotReadV1;
}

/** Paged owner-visible issues; the cursor is the signed, bound tree cursor. */
export interface StructuredIssuePageV1 {
  issues: StructuredIssueV1[];
  nextCursor: StructuredSlotTreeCursorV1 | null;
}
