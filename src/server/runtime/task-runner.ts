/**
 * Serial one-node TaskRunner (plan Phase C Task 4 Step 3, spec §3.3/§6.2).
 *
 * One `runNext` reads the NEXT confirmed unprocessed input node (by event
 * sequence), rebuilds that agent's public history and loaded Skills from
 * confirmed events alone, runs exactly one runtime Turn and commits the
 * buffered actions through the ActionCommitter. It never recursively invokes
 * a second agent — the scheduler owns the loop (spec §3.3: one node at a
 * time, the canvas order is the real execution order).
 *
 * Attempts stay inside the frozen event union (plan Task 4 decision: express
 * attempts through the existing members, never extend the union):
 * - the confirmed `agent_input` node anchors the attempt; the attempt number
 *   is `1 + the agent_attempt_failed events recorded for that node`;
 * - the Turn id derives from the node and attempt (`<inputId>-t<n>`), and the
 *   committer derives every committed id from the Turn id — so an input node
 *   is processed exactly when an `agent_result` id matches
 *   `<inputId>-t<number>-result` and the result's turn never left an
 *   interrupted commit owing completion (an interrupted commit replays under
 *   the same ids instead of duplicating);
 * - an interrupted commit (COMMIT_INTERRUPTED leaves the agent result plus a
 *   non-retryable `<turnId>-commit-failed` marker before the plan's terminal
 *   event) re-enters `validateAndCommit` under the SAME turn id on the next
 *   retry/resume — committed items replay, the missing plan items complete,
 *   and the task never rests in `running` on a node that only looks
 *   processed (review F4);
 * - failures append `agent_attempt_failed` (retryable per `RuntimeFailure`);
 *   aborts append nothing (spec §7.2 never guesses unconfirmed outcomes).
 *
 * Public history is rebuilt exclusively from committed public text (this
 * agent's inputs/results and human exchanges; routed messages arrive as input
 * nodes). Hidden thinking can never appear: events carry no provider
 * internals (global constraint).
 *
 * No business vocabulary lives here (iron rule 1).
 */
import type { TraceEntry, TurnTracePhase } from '../../shared/contracts';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ArtifactStore } from '../storage/artifact-store';
import type { EventStore } from '../storage/event-store';
import type { CommittedEvent } from '../storage/event-store';
import type { TaskStore } from '../storage/task-store';
import type { TaskEvent } from '../storage/task-events';
import type { TraceStore } from '../storage/trace-store';
import type { CorePaths } from '../storage/core-paths';
import { StructuredSlotBlobStore } from '../storage/structured-slot-blob-store';
import { StructuredSlotPrivateStore } from '../storage/structured-slot-private-store';
import type { MergeCommitCandidate, StructureCommitCandidate } from '../storage/structured-slot-private-store';
import { projectStructuredSlotState } from '../storage/structured-slot-state';
import type { BasicTurnContractV1, BasicTurnContractV2, FrozenAgentConfig, FrozenTemplate, StructuredTurnContractV3 } from '../template/template-schema';
import type { FrozenStructuredSlotContractV1 } from '../template/structured-slot-contract';
import { isAuthoritativeStructuredTurnContractV4, isStructuredTurnContractV3, TEMPLATE_ERROR_CODES, TemplateError } from '../template/template-schema';
import { structuredProtocolOf } from '../../shared/authoritative-review-v2';
import type { StructuredRuntimeEnvironmentV1 } from '../structured-slots/runtime-capability';
import type { AuthoritativeReviewRuntimeEnvironmentV1 } from '../structured-slots/authoritative-review-capability';
import { isStructuredRuntimeEnabled } from '../structured-slots/runtime-capability';
import { isAuthoritativeReviewRunnable as isAuthoritativeReviewRuntimeRunnable } from '../structured-slots/authoritative-review-capability';
import type {
  FillSessionGrantV1,
  SealSessionGrantV1,
  SlotSessionGrantV1,
  StructureSessionGrantV1,
} from '../../shared/structured-slots';
import { RuntimeAbortedError, RuntimeFailure } from './agent-runtime';
import type { AgentRuntime, AgentTurnInput, LivePatch } from './agent-runtime';
import {
  COMMIT_ERROR_CODES,
  CommitFailure,
  type ActionCommitter,
  type CommitContext,
  type CurrentInputArtifact,
} from './action-committer';
import type { ForgeAction } from './forge-actions';
import type { SkillService } from './skill-service';
import type { WorkspaceStore } from './workspace-store';
import { classifyRuntimeError } from './retry-policy';
import {
  startAttempt,
  terminalize,
  deriveDraftId,
  deriveTurnId,
  type StartAttemptResult,
} from './structured-slot/attempt-coordinator';
import { AttemptMeter } from './structured-slot/attempt-meter';
import { StructuredSlotDraftService } from './structured-slot/draft-service';
import { StructuredSlotGrantService, type ActiveScaffoldV1 } from './structured-slot/grant-service';
import {
  createTaskLocalCursorSigner,
  StructuredSlotProjectionService,
  type TaskLocalCursorSigner,
} from './structured-slot/projection-service';
import { StructuredSlotProposalService, type SubmitStructureContext } from './structured-slot/proposal-service';
import { StructuredSlotSealService } from './structured-slot/seal-service';
import {
  assertStructuredForgeAction,
  createStructuredSlotDataSource,
  StructuredSlotSessionService,
  type StructuredSessionState,
} from './structured-slot/session-service';
import {
  prepareStructuredCommit,
  StructuredCommitError,
  type PreparedStructuredCommit,
  type StructuredCommitContext,
} from './structured-slot/structured-committer';
import {
  assertSealDispatchAction,
  consumeSlotToolPrecharge,
  createStructuredSlotToolDefinitions,
  type SealDispatchStateV1,
  type SealToolOperations,
  type StructuredSlotToolContext,
} from './structured-slot/tool-factory';
import { ValidationEngine } from './structured-slot/validation-engine';
import type { StructuredSlotRuntimeContext } from './pi-agent-runtime';

/** Outcome the scheduler loop consumes to decide the next step. */
export interface RunNextResult {
  /** Event id of the processed input node; null when nothing was pending. */
  processedNodeId: string | null;
  /** True when a Turn result was committed this call. */
  committed: boolean;
  /** True when the commit accepted the system final output. */
  taskCompleted: boolean;
  /** True when the commit recorded a human input request. */
  waitingHuman: boolean;
  /** True when the attempt failed and was recorded as such. */
  attemptFailed: boolean;
  /**
   * Retry classification of a failed attempt (Task 5 consumes it). Reflects
   * the retryable flag actually recorded on the attempt event: a transient
   * failure is reported non-retryable once the caller signals the automatic
   * retry budget is exhausted.
   */
  retryable: boolean;
  /** The 1-based attempt number executed for the input node (0 when idle). */
  attemptCount: number;
  /** Agents with unprocessed confirmed inputs after this call, in order. */
  pendingAgentIds: string[];
}

export interface TaskRunnerOptions {
  tasks: TaskStore;
  events: EventStore;
  artifacts: ArtifactStore;
  skills: SkillService;
  committer: ActionCommitter;
  runtime: AgentRuntime;
  /** Per-agent temporary workspaces (plan Phase E Task 3 publish resolution). */
  workspaces: WorkspaceStore;
  /** Display-only per-turn trace persistence (best effort, never gates). */
  traces: TraceStore;
  /**
   * Live-preview sink (plan C realtime streaming): receives every runtime
   * live patch tagged with the task id. Memory-only by contract — patches
   * never reach storage. Optional: runners without it run turns unchanged.
   */
  liveSink?: (taskId: string, patch: LivePatch) => void;
  /** Injectable clock for deterministic tests; defaults to system time. */
  clock?: () => Date;
  /**
   * Core paths (Task 17 structured integration): the runner derives the
   * task-local structured blob/private stores from them for structured turns.
   */
  paths?: CorePaths;
  /**
   * The ONE structured runtime environment (spec §5 / design O05): the same
   * immutable reference frozen in CoreService construction. Rechecked on every
   * structured Turn before the coordinator starts an attempt; structured v3
   * turns fail closed with `TEMPLATE_RUNTIME_UNAVAILABLE` when it is disabled.
   */
  runtimeEnvironment?: StructuredRuntimeEnvironmentV1;
  /**
   * The ONE authoritative review runtime environment (spec §17, Task 5): the
   * same immutable reference frozen in CoreService construction. V2 dispatch
   * gates recheck it; never a second default.
   */
  authoritativeReviewEnvironment?: AuthoritativeReviewRuntimeEnvironmentV1;
  /**
   * Task 12 v2 runner entry seam (additive): the authoritative attempt
   * coordinator (the lease -> execute -> complete loop over the v2 scheduler's
   * leased dispatch). When wired, `runV2Next` delegates the whole authoritative
   * turn to it; an unwired v2 task fails closed with a typed runtime failure.
   * CoreService wires this together with the Task 12 scheduling tick.
   */
  v2Attempts?: Pick<import('./authoritative-review/attempt-coordinator').V2AttemptCoordinator, 'runNext'>;
}

/** Per-call retry context the scheduler supplies (plan Task 5 Step 3). */
export interface RunNextOptions {
  /**
   * True when the scheduler has exhausted its automatic retry budget, so a
   * transient failure must be recorded as terminal (retryable=false) and the
   * node parked for a manual retry instead of auto-retried.
   */
  autoRetryExhausted?: boolean;
}

/**
 * The per-turn structured slot bundle (Task 17) the structured runNext path
 * builds BEFORE the runtime Turn and the Pi seam (`createStructuredSlotContext`)
 * consumes DURING it. One bundle per `taskId:turnId`; the grant, the session
 * state, the persistent Attempt meter and the closed Slot Tool set are all
 * bound to the coordinator-allocated turn identity (spec §8.1/§9).
 */
interface StructuredTurnBundle {
  sessionKind: 'structure' | 'fill' | 'seal';
  turnId: string;
  /** The composite Attempt signal (deadline/resource closure ∪ scheduler stop). */
  signal: AbortSignal;
  meter: AttemptMeter;
  grant: SlotSessionGrantV1;
  /** The session state (structure/fill) the tool guards read; null for seal. */
  state: StructuredSessionState | null;
  submitStructureContext: SubmitStructureContext;
  /** The seal domain operations (Task 16); its `dispatch` is the seal authority. */
  seal: SealToolOperations;
  /** The contract snapshot hash (bound into the completion signature). */
  snapshotHash: string;
  /** Task-local structured stores bound to the attempt. */
  blobStore: StructuredSlotBlobStore;
  privateStore: StructuredSlotPrivateStore;
  /** The committed start batch (the fill opened event lives here). */
  committedStart: readonly CommittedEvent[];
  /** The materialized fill draft id (fill only; null otherwise). */
  draftId: string | null;
  /** The closed per-kind Slot Tool definitions (consumed by the Pi seam). */
  toolDefinitions: ToolDefinition[];
  /** The dispatch guard for the forge actions (design §11.3 matrix). */
  beforePropose: (action: ForgeAction) => { ok: true } | { ok: false; code: string; reason: string };
  /** The corrective prompt naming the required Slot completion before dispatch. */
  correctivePrompt: string;
}

type PublicHistoryEntry = { role: 'user' | 'assistant' | 'tool'; text: string };

/** True when the committed result id belongs to the input node's attempts. */
function isResultForInput(resultEventId: string, inputEventId: string): boolean {
  if (!resultEventId.startsWith(`${inputEventId}-t`)) {
    return false;
  }
  return /^-t[1-9][0-9]*-result$/.test(resultEventId.slice(inputEventId.length));
}

/** The attempt number embedded in a result id for the input node, or null. */
function resultAttemptNumber(resultEventId: string, inputEventId: string): number | null {
  if (!isResultForInput(resultEventId, inputEventId)) {
    return null;
  }
  const match = /^-t([1-9][0-9]*)-result$/.exec(resultEventId.slice(inputEventId.length));
  return match === null ? null : Number(match[1]);
}

/**
 * The declared route that delivered an input node, or null when the input has
 * no delivering route (initial seeded input, scheduler-synthesized human
 * continue/accept nodes). Matched by route kind + label against the frozen
 * snapshot (semantic audit P0, plan 2026-08-07): prompt assembly is decided by
 * WHICH edge produced the input, not by whether inputVersion is set.
 */
function resolveIncomingDelivery(
  events: readonly TaskEvent[],
  frozen: FrozenTemplate,
  inputNodeId: string,
): FrozenTemplate['routes'][number] | null {
  const routeEvent = events.find(
    (e): e is Extract<TaskEvent, { type: 'route_executed' }> =>
      e.type === 'route_executed' && e.route.toNodeId === inputNodeId,
  );
  if (routeEvent === undefined) {
    return null;
  }
  return (
    frozen.routes.find(
      (route) => route.kind === routeEvent.route.kind && route.label === routeEvent.route.label,
    ) ?? null
  );
}

/**
 * True when one turn's commit plan ran to its terminal event (review F4).
 * Every dispatch shape ends in exactly one platform-owned id: the final
 * submission event, the human request node, the routed message's target
 * input, the LAST artifact route's target input (the count of declared
 * artifact routes of the publisher is fixed by the frozen snapshot), or the
 * forward input node (forward is single-edge, id `${turnId}-forward-input-0`).
 */
export function turnPlanCompleted(
  events: readonly TaskEvent[],
  turnId: string,
  artifactRouteCount: number,
): boolean {
  for (const event of events) {
    const id = event.id;
    if (
      id === `${turnId}-final` ||
      id === `${turnId}-human-requested` ||
      id === `${turnId}-message-input-0` ||
      id === `${turnId}-forward-input-0` ||
      (artifactRouteCount > 0 && id === `${turnId}-artifact-input-${artifactRouteCount - 1}`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The attempt number of an interrupted commit that still owes completion
 * (review F4): the input's LATEST committed result turn whose committer
 * failure marker (`<turnId>-commit-failed`, non-retryable) exists while the
 * turn's plan never reached its terminal event. Null when the node never
 * committed or its latest commit completed. A non-null result re-enters
 * `validateAndCommit` under the SAME turn id, so committed items replay
 * instead of duplicating.
 */
function partialCommitAttempt(
  events: readonly TaskEvent[],
  inputEventId: string,
  artifactRouteCount: number,
): number | null {
  let latest = 0;
  for (const event of events) {
    if (event.type !== 'agent_result') {
      continue;
    }
    const attempt = resultAttemptNumber(event.id, inputEventId);
    if (attempt !== null) {
      latest = Math.max(latest, attempt);
    }
  }
  if (latest === 0) {
    return null;
  }
  const turnId = `${inputEventId}-t${latest}`;
  const markerPrefix = `${turnId}-commit-failed`;
  const marked = events.some(
    (event) =>
      event.type === 'agent_attempt_failed' &&
      event.nodeId === inputEventId &&
      event.retryable === false &&
      (event.id === markerPrefix || event.id.startsWith(`${markerPrefix}-`)),
  );
  if (!marked) {
    return null;
  }
  if (turnPlanCompleted(events, turnId, artifactRouteCount)) {
    return null;
  }
  return latest;
}

/** True when the input node owes no further commit work. */
function isInputResolved(
  events: readonly TaskEvent[],
  input: Extract<TaskEvent, { type: 'agent_input' }>,
  artifactRouteCountFor: (agentId: string) => number,
): boolean {
  const hasResult = events.some(
    (event) => event.type === 'agent_result' && isResultForInput(event.id, input.id),
  );
  if (!hasResult) {
    return false;
  }
  return partialCommitAttempt(events, input.id, artifactRouteCountFor(input.node.agentId)) === null;
}

/**
 * The set of agent_input node ids voided by `pending_inputs_superseded`
 * events (spec §11.2). Superseded inputs are never pending: the runner skips
 * them, the projection renders them void, and version counts are unaffected.
 */
function supersededNodeIds(events: readonly TaskEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type === 'pending_inputs_superseded') {
      for (const nodeId of event.supersededNodeIds) {
        ids.add(nodeId);
      }
    }
  }
  return ids;
}

/**
 * Agents with unprocessed confirmed input nodes, ordered by the earliest
 * unprocessed input (event sequence). An input node is processed once a
 * matching committed `agent_result` exists AND the result's turn never left
 * an interrupted commit owing completion (see module docs). Superseded inputs
 * (spec §11.2) are skipped - they are never pending.
 */
function collectPendingAgents(
  events: readonly TaskEvent[],
  artifactRouteCountFor: (agentId: string) => number,
): string[] {
  const voided = supersededNodeIds(events);
  const pending: string[] = [];
  for (const input of events) {
    if (input.type !== 'agent_input') {
      continue;
    }
    if (voided.has(input.id)) {
      continue;
    }
    if (isInputResolved(events, input, artifactRouteCountFor)) {
      continue;
    }
    if (!pending.includes(input.node.agentId)) {
      pending.push(input.node.agentId);
    }
  }
  return pending;
}

/**
 * The first confirmed input node (by sequence) that still owes execution:
 * one without a committed result, or one whose latest committed result left
 * an interrupted commit incomplete (review F4 re-entry). Superseded inputs
 * (spec §11.2) are skipped.
 */
function findNextUnprocessedInput(
  events: readonly TaskEvent[],
  artifactRouteCountFor: (agentId: string) => number,
): { input: Extract<TaskEvent, { type: 'agent_input' }>; partialAttempt: number | null } | null {
  const voided = supersededNodeIds(events);
  for (const event of events) {
    if (event.type !== 'agent_input') {
      continue;
    }
    if (voided.has(event.id)) {
      continue;
    }
    const hasResult = events.some(
      (candidate) => candidate.type === 'agent_result' && isResultForInput(candidate.id, event.id),
    );
    if (!hasResult) {
      return { input: event, partialAttempt: null };
    }
    const partialAttempt = partialCommitAttempt(
      events,
      event.id,
      artifactRouteCountFor(event.node.agentId),
    );
    if (partialAttempt !== null) {
      return { input: event, partialAttempt };
    }
  }
  return null;
}

/** Lifecycle flags derived from committed events (idle-result reporting). */
function inspectLifecycle(events: readonly TaskEvent[]): {
  completed: boolean;
  waitingHuman: boolean;
} {
  let completed = false;
  let waitingHuman = false;
  for (const event of events) {
    switch (event.type) {
      case 'task_completed':
      case 'final_submission_accepted':
        completed = true;
        break;
      case 'human_requested':
        waitingHuman = true;
        break;
      case 'human_answered':
        waitingHuman = false;
        break;
      default:
        break;
    }
  }
  return { completed, waitingHuman };
}

/**
 * Rebuilds one agent's public history from confirmed events preceding the
 * current input node: its own inputs/results and human exchanges. Routed
 * messages already arrive as input nodes; other agents' nodes, routes,
 * artifacts and skill metadata stay excluded (spec §3.5, §6.2).
 */
function buildPublicHistory(
  events: readonly TaskEvent[],
  agentId: string,
  beforeSequence: number,
): PublicHistoryEntry[] {
  const history: PublicHistoryEntry[] = [];
  for (const event of events) {
    if (!('node' in event) || event.node.agentId !== agentId) {
      continue;
    }
    if (event.node.sequence >= beforeSequence) {
      continue; // The current input travels as inputText; later events excluded.
    }
    switch (event.type) {
      case 'agent_input':
        history.push({ role: 'user', text: event.node.body });
        break;
      case 'agent_result':
        history.push({ role: 'assistant', text: event.node.body });
        break;
      case 'human_requested':
        history.push({ role: 'assistant', text: event.question });
        break;
      case 'human_answered':
        history.push({ role: 'user', text: event.answer });
        break;
      default:
        break;
    }
  }
  return history;
}

/**
 * Composes the Turn input for an artifact hand-off node. The route node body
 * alone carries only the artifact title; the receiving agent must see the
 * whole hand-off artifact, so the full content is read from the ArtifactStore
 * and travels as the current input (public history still excludes artifacts,
 * spec §3.5/§6.2 — this is the current input itself, not history).
 */
function artifactHandOffInputText(title: string, content: string): string {
  return `以下是随本次交接送达的产物全文（标题：${title}）：\n\n${content}`;
}

/**
 * Derives a display-only turn-state prefix from the committed event
 * history and frozen template routes. Injected before inputText so the
 * model knows which turn it is, what route delivered the input, and what
 * it dispatched last time - without having to infer state from history.
 * Platform-generic: agent names and route labels come from the frozen
 * template config, never hardcoded (iron rule 1).
 */
function buildTurnStatePrefix(
  events: readonly TaskEvent[],
  agentId: string,
  frozen: FrozenTemplate,
  inputNodeId: string,
): string {
  // Count previous turns for this agent (agent_input events before the current one).
  let turnCount = 0;
  for (const event of events) {
    if (event.type === 'agent_input' && event.node.agentId === agentId && event.id !== inputNodeId) {
      turnCount += 1;
    }
  }

  // Find the route that delivered the current input.
  let incomingLabel: string | null = null;
  let incomingKind: string | null = null;
  let incomingFromAgent: string | null = null;
  for (const event of events) {
    if (event.type === 'route_executed' && event.route.toNodeId === inputNodeId) {
      incomingLabel = event.route.label;
      incomingKind = event.route.kind;
      // Find the source agent by matching fromNodeId to an agent_result.
      const fromNode = events.find(
        (e) => e.type === 'agent_result' && e.id === event.route.fromNodeId,
      );
      if (fromNode && fromNode.type === 'agent_result') {
        const sourceAgent = frozen.agents.find((a) => a.id === fromNode.node.agentId);
        incomingFromAgent = sourceAgent?.id ?? fromNode.node.agentId;
      }
      break;
    }
  }

  // Find the agent's previous outgoing route.
  let prevLabel: string | null = null;
  let prevKind: string | null = null;
  let prevToAgent: string | null = null;
  for (const event of events) {
    if (event.type !== 'route_executed') continue;
    const fromNode = events.find(
      (e) => e.type === 'agent_result' && e.id === event.route.fromNodeId,
    );
    if (fromNode && fromNode.type === 'agent_result' && fromNode.node.agentId === agentId) {
      prevLabel = event.route.label;
      prevKind = event.route.kind;
      // Find target agent name from frozen routes.
      const route = frozen.routes.find(
        (r) => r.from === agentId && r.kind === event.route.kind,
      );
      if (route) {
        const targetAgent = frozen.agents.find((a) => a.id === route.to);
        prevToAgent = targetAgent?.id ?? route.to;
      }
    }
  }

  // Assemble the state string.
  const parts: string[] = [`[回合状态] 第 ${turnCount + 1} 次执行。`];

  if (prevLabel !== null && prevToAgent !== null) {
    const noun = prevKind === 'message' ? '消息' : '产物';
    parts.push(`上一次通过「${prevLabel}」路线向「${prevToAgent}」发送了${noun}。`);
  }

  if (incomingLabel !== null && incomingFromAgent !== null) {
    const noun = incomingKind === 'message' ? '消息' : '产物';
    parts.push(`本次通过「${incomingLabel}」路线收到来自「${incomingFromAgent}」的${noun}。`);
  } else if (turnCount === 0) {
    parts.push('本次输入为初始输入。');
  }

  return parts.join(' ');
}

/** Platform-neutral display labels for sealed-package sources. */
const PRODUCTION_SOURCE_LABELS: Readonly<Record<string, string>> = {
  inline: '内联（直接提供全文）',
  workspace_file: '工作区文件',
  current_input_artifact: '当前输入携带的产物',
};

/**
 * Derives the display-only per-turn task checklist from the agent's frozen
 * turn contract (plan 2026-08-06): the contract already fixes the turn's
 * mandatory shape, so the checklist is a deterministic rendering of it —
 * produce content, seal with `finish_production`, then exactly one allowed
 * dispatch. Injected at the END of the turn input to keep the steps salient
 * for the model; it never becomes an event and never re-enters replayed
 * history (iron rules 1/2: platform-generic wording, no engineering data).
 * Legacy snapshots without a contract never execute, so null returns ''.
 */
export function buildTurnChecklist(agent: FrozenAgentConfig, frozen: FrozenTemplate): string {
  const contract = agent.turnContract;
  if (contract === null) {
    return '';
  }
  // v3 slot-session contracts run on the structured runNext path (Task 17),
  // which carries its own corrective completion prompt; the basic checklist
  // never applies to them. v4 authoritative contracts likewise never run the
  // basic checklist — v2 turns are system-coordinated (Task 10+).
  if (isStructuredTurnContractV3(contract) || isAuthoritativeStructuredTurnContractV4(contract)) {
    return '';
  }
  const agentNameOf = (agentId: string): string =>
    frozen.agents.find((candidate) => candidate.id === agentId)?.name ?? agentId;
  const lines: string[] = ['【本回合任务清单】'];

  const basic = contract as BasicTurnContractV1 | BasicTurnContractV2;
  const isProduction = basic.production !== undefined;
  const isOperate = basic.annotate !== undefined;
  const targetsOf = (action: string): string[] => {
    const map = basic.dispatch.targets as Record<string, string[] | undefined>;
    return map[action] ?? [];
  };
  const renderTargets = (action: string): string | null => {
    const ids = targetsOf(action);
    if (ids.length === 0) {
      return null;
    }
    return ids.map((id) => `${id}（${agentNameOf(id)}）`).join(' 或 ');
  };

  if (isProduction) {
    const sourceLabels = (basic.production!.output.sources ?? []).map(
      (source) => PRODUCTION_SOURCE_LABELS[source] ?? source,
    );
    lines.push('1. 产出本回合的内容。');
    lines.push(
      `2. 调用 finish_production 封存生产包（source 可选：${sourceLabels.join(' 或 ')}）。`,
    );
    lines.push('3. 调用 publish_artifact 发布产物（恰好一次分发）。');
  } else if (isOperate) {
    lines.push('1. 如需审读，调用 read_artifact_version 读取输入版本文件。');
    lines.push('2. 调用 annotate_artifact 标注输入版本文件（如审核意见）。');
    lines.push('3. 执行恰好一次分发（见下方行动）。');
  } else {
    lines.push('1. 执行恰好一次分发（见下方行动）。');
  }

  const dispatchLines = basic.dispatch.allowedActions
    .filter((action) => action !== 'request_human_input')
    .map((action) => {
      const targetNames = renderTargets(action);
      if (action === 'send_message') {
        return targetNames === null
          ? '调用 send_message 发送消息'
          : `调用 send_message 向 ${targetNames} 发送消息`;
      }
      if (action === 'publish_artifact') {
        return targetNames === null
          ? '调用 publish_artifact 发布产物'
          : `调用 publish_artifact 发布产物（送达 ${targetNames}）`;
      }
      if (action === 'forward_input_version') {
        return targetNames === null
          ? '调用 forward_input_version 转发输入版本'
          : `调用 forward_input_version 向 ${targetNames} 转发输入版本`;
      }
      return '调用 submit_final_artifact 提交终稿';
    });
  if (!isProduction && dispatchLines.length > 0) {
    if (dispatchLines.length === 1) {
      lines.push(`   - ${dispatchLines[0]}`);
    } else {
      for (const line of dispatchLines) {
        lines.push(`   - ${line}`);
      }
    }
  }
  lines.push('完成以上全部步骤本回合才算结束；文字输出不是动作，不能代替工具调用。');
  return lines.join('\n');
}

/**
 * The display-only failed phase written with failure-path traces (plan
 * 2026-08-04 Task 5). The message is the public attempt-failure text — never
 * a raw provider cause (iron rule 6).
 */
function failedPhase(message: string): TurnTracePhase {
  return { state: 'failed', dispatchAction: null, target: null, message };
}

export class TaskRunner {
  private readonly tasks: TaskStore;

  private readonly events: EventStore;

  private readonly artifacts: ArtifactStore;

  private readonly skills: SkillService;

  private readonly committer: ActionCommitter;

  private readonly runtime: AgentRuntime;

  private readonly workspaces: WorkspaceStore;

  private readonly traces: TraceStore;

  private readonly liveSink: ((taskId: string, patch: LivePatch) => void) | null;

  private readonly clock: () => Date;

  private readonly paths: CorePaths | undefined;

  private readonly runtimeEnvironment: StructuredRuntimeEnvironmentV1 | undefined;

  private readonly authoritativeReviewEnvironment: AuthoritativeReviewRuntimeEnvironmentV1 | undefined;

  private readonly v2Attempts: Pick<import('./authoritative-review/attempt-coordinator').V2AttemptCoordinator, 'runNext'> | undefined;

  /**
   * Per-task pagination cursor signers (wiring note 9): ONE signer per task so
   * a model-held cursor keeps verifying across requests and turns within the
   * same process. A process restart loses them (fail closed → fresh cursors).
   */
  private readonly cursorSigners = new Map<string, TaskLocalCursorSigner>();

  /**
   * Per-task per-turn structured slot bundles (Task 17). Built by the
   * structured runNext path before the Turn runs; consumed by the Pi runtime
   * seam (`createStructuredSlotContext`) inside the same Turn to assemble the
   * closed Slot Tool set, the persistent Attempt meter and the dispatch guard.
   * Keyed `taskId:turnId` and cleaned after the Turn exits.
   */
  private readonly structuredBundles = new Map<string, StructuredTurnBundle>();

  /** Frozen snapshots never change for a live task; read once per process. */
  private readonly frozenCache = new Map<string, FrozenTemplate>();

  constructor(options: TaskRunnerOptions) {
    this.tasks = options.tasks;
    this.events = options.events;
    this.artifacts = options.artifacts;
    this.skills = options.skills;
    this.committer = options.committer;
    this.runtime = options.runtime;
    this.workspaces = options.workspaces;
    this.traces = options.traces;
    this.liveSink = options.liveSink ?? null;
    this.clock = options.clock ?? (() => new Date());
    this.paths = options.paths;
    this.runtimeEnvironment = options.runtimeEnvironment;
    this.authoritativeReviewEnvironment = options.authoritativeReviewEnvironment;
    this.v2Attempts = options.v2Attempts;
  }

  /**
   * Runs the next confirmed unprocessed input node — exactly one agent Turn —
   * and returns the outcome for the scheduler loop. Never recurses into a
   * second agent (spec §3.3). `options.autoRetryExhausted` (plan Task 5)
   * marks a transient failure terminal once the scheduler's automatic retry
   * budget is spent.
   */
  async runNext(
    taskId: string,
    signal: AbortSignal,
    options: RunNextOptions = {},
  ): Promise<RunNextResult> {
    const autoRetryExhausted = options.autoRetryExhausted ?? false;
    const events = (await this.events.read(taskId)).map((entry) => entry.event);
    const frozen = await this.frozenFor(taskId);
    // The publisher's declared artifact routes fix the terminal id of a
    // publish plan (review F4 completion detection); the frozen snapshot
    // never changes for a live task.
    const artifactRouteCountFor = (agentId: string): number =>
      frozen.routes.filter((route) => route.from === agentId && route.kind === 'artifact')
        .length;
    const next = findNextUnprocessedInput(events, artifactRouteCountFor);
    if (next === null) {
      const lifecycle = inspectLifecycle(events);
      return {
        processedNodeId: null,
        committed: false,
        taskCompleted: lifecycle.completed,
        waitingHuman: lifecycle.waitingHuman,
        attemptFailed: false,
        retryable: false,
        attemptCount: 0,
        pendingAgentIds: [],
      };
    }

    const input = next.input;
    const inputNodeId = input.id;
    const agentId = input.node.agentId;
    const agent = frozen.agents.find((candidate) => candidate.id === agentId);
    if (agent === undefined) {
      // Events and snapshot disagree — fail loud, never guess (spec §8.3).
      throw RuntimeFailure.permanent(
        'AGENT_NOT_DECLARED',
        '输入节点指向的 Agent 不在任务冻结模板之内。',
      );
    }
    // Review F4: an interrupted commit re-enters under the SAME turn id (the
    // attempt number of the partial result) so committed items replay; any
    // other node derives its attempt from the recorded failures as before.
    const attemptCount =
      next.partialAttempt ??
      1 +
        events.filter(
          (event) => event.type === 'agent_attempt_failed' && event.nodeId === inputNodeId,
        ).length;
    const turnId = `${inputNodeId}-t${attemptCount}`;

    // Incompatibility guard (plan 2026-08-04 Tasks 3/4): the scheduler gates
    // legacy snapshots before any run, so a contract-less agent here is a
    // platform invariant violation — fail loud, never guess (spec §8.3).
    if (agent.turnContract === null) {
      throw RuntimeFailure.permanent(
        'TURN_CONTRACT_REQUIRED',
        '任务冻结快照缺少当前回合契约，无法执行。',
      );
    }
    // Structured v3 slot contracts run the structured runNext path (Task 17):
    // the coordinator allocates the attempt epoch/turnId, the session handle
    // is built before the model Turn and the terminal authority belongs to the
    // structured committer. The basic branch below stays byte-for-byte.
    if (isStructuredTurnContractV3(agent.turnContract)) {
      return this.runStructuredNext(
        taskId,
        signal,
        events,
        frozen,
        agent,
        input,
        autoRetryExhausted,
      );
    }

    // Rebuild loaded Skills; failures are confined to the current node.
    try {
      const loadedSkills = await this.skills.loadedSkillsFor(taskId, agentId);
      const inputVersion = input.node.inputVersion;
      // Hand-off identity for the commit context (publish/forward/submit/
      // send-with-version all consume the received artifact): derived from the
      // input node's OWN version reference — independent of prompt assembly
      // (semantic audit P0, plan 2026-08-07).
      let handOffArtifact: CurrentInputArtifact | null = null;
      if (inputVersion !== null) {
        const handOff = await this.artifacts.read(taskId, inputVersion);
        const contentFile =
          handOff.files.find((file) => file.name === 'content.md' || file.name === 'content.txt')
            ?.content ?? '';
        handOffArtifact = {
          artifactId: handOff.meta.id,
          version: handOff.meta.version,
          title: handOff.meta.title,
          format: handOff.meta.format,
          content: contentFile,
          sourceNodeId: handOff.meta.sourceNodeId,
          humanAuthorized: input.node.humanAuthorized ?? false,
        };
      }
      // Prompt assembly is decided by the INCOMING DELIVERY (which edge produced
      // this input), NOT by whether inputVersion is set: inputVersion is a
      // reference, not an input type. Message edges keep their summary body;
      // artifact edges and message edges both apply the declared route.inject
      // (anchored on the receiver's OWN inputVersion, spec §5.2).
      const delivery = resolveIncomingDelivery(events, frozen, inputNodeId);
      let inputText = input.node.body; // initial / synthesized guidance / message summary
      if (delivery !== null && inputVersion !== null) {
        try {
          const entry = await this.artifacts.read(taskId, inputVersion);
          const injectParts: string[] = [];
          for (const inj of delivery.inject ?? []) {
            const file = entry.files.find((f) => f.name === inj.file);
            if (file !== undefined) {
              injectParts.push(`${inj.as}：\n${file.content}`);
            }
          }
          if (injectParts.length > 0) {
            inputText = `${inputText}\n\n${injectParts.join('\n\n')}`;
          } else if (delivery.kind === 'artifact') {
            // No declared inject (or none matched this version): legacy fallback
            // reads the primary content file so artifact hand-off inputs stay
            // informative. Explicitly a fallback, never an override of inject.
            const contentFile =
              entry.files.find(
                (file) => file.name === 'content.md' || file.name === 'content.txt',
              )?.content ?? '';
            inputText = artifactHandOffInputText(entry.meta.title, contentFile);
          }
        } catch {
          // Inject read failure is non-fatal; the agent still has the base input.
        }
      }
      const statePrefix = buildTurnStatePrefix(events, agentId, frozen, inputNodeId);
      if (statePrefix.length > 0) {
        inputText = `${statePrefix}

${inputText}`;
      }
      // The contract-derived checklist rides at the END of the turn input
      // (plan 2026-08-06): closest to generation, display-only — it is never
      // committed and never re-enters the rebuilt public history.
      const checklist = buildTurnChecklist(agent, frozen);
      if (checklist.length > 0) {
        inputText = `${inputText}

${checklist}`;
      }
      const turnInput: AgentTurnInput = {
        taskId,
        turnId,
        agent,
        inputNodeId,
        inputText,
        publicHistory: buildPublicHistory(events, agentId, input.node.sequence),
        availableSkills: agent.skills.map(({ id, name, description }) => ({
          id,
          name,
          description,
        })),
        loadedSkills,
        // Basic turns never carry a structured slot session (Task 11
        // contract); the structured runNext path (Task 17) supplies the
        // coordinator-built SessionHandle.
        slotSession: null,
      };

      let turnResult: Awaited<ReturnType<AgentRuntime['run']>>;
      try {
        // Live-preview wiring (plan C): the sink is optional — runtimes run
        // unchanged when none is configured, and patches stay memory-only.
        const runOptions =
          this.liveSink === null
            ? undefined
            : {
                onLive: (patch: LivePatch): void => {
                  this.liveSink?.(taskId, patch);
                },
              };
        turnResult = await this.runtime.run(turnInput, signal, runOptions);
      } catch (error) {
        if (error instanceof RuntimeAbortedError) {
          // Stop/disposal path: dispose the interrupted session, record nothing.
          await this.runtime.disposeAgent(taskId, agentId).catch(() => undefined);
          throw error;
        }
        // Retry policy classification (plan Task 5): a transient failure stays
        // retryable only while the scheduler's automatic budget remains.
        const classified = classifyRuntimeError(error);
        const retryable = classified.retryable && !autoRetryExhausted;
        const message =
          error instanceof RuntimeFailure
            ? error.message
            : '模型执行失败，当前尝试已记录为失败。';
        await this.appendAttemptFailure(taskId, turnId, inputNodeId, message, retryable);
        // Failure-path trace (plan 2026-08-04 Task 5): phase-only, zero
        // entries — the turn produced no committed observable steps.
        await this.recordTurnTrace(taskId, turnId, [], failedPhase(message));
        return this.failureResult(inputNodeId, events, frozen, retryable, attemptCount);
      }

      // Stale-result suppression (spec §7.2): an abort landing after the Turn
      // succeeded still discards the buffered actions — nothing is committed.
      if (signal.aborted) {
        await this.runtime.disposeAgent(taskId, agentId).catch(() => undefined);
        throw new RuntimeAbortedError(`turn ${turnId} aborted before commit`);
      }

      // The sealed production package may reference a private workspace file;
      // it is resolved to controlled content strictly before the commit
      // context is built (an unreadable file fails the attempt — never
      // throws; the scheduler only swallows RuntimeAbortedError).
      const resolvedActions = await this.resolveWorkspaceProduction(
        taskId,
        agentId,
        turnId,
        inputNodeId,
        turnResult.actions,
      );
      if (resolvedActions === null) {
        await this.recordTurnTrace(taskId, turnId, turnResult.trace, failedPhase('工作区文件不可读，生产包未能封存。'));
        return this.failureResult(inputNodeId, events, frozen, false, attemptCount);
      }

      const context = this.buildCommitContext(
        taskId,
        turnId,
        frozen,
        agent,
        inputNodeId,
        attemptCount,
        turnResult.publicText,
        handOffArtifact,
      );
      try {
        const commitResult = await this.committer.validateAndCommit(context, resolvedActions);
        // ONE final trace write after the commit outcome is known (plan
        // 2026-08-04 Task 5, frozen decision 6): success carries the turn
        // entries plus the platform-derived phase.
        await this.recordTurnTrace(taskId, turnId, turnResult.trace, commitResult.phase);
        return {
          processedNodeId: inputNodeId,
          committed: true,
          taskCompleted: commitResult.taskCompleted,
          waitingHuman: commitResult.waitingHuman,
          attemptFailed: false,
          retryable: false,
          attemptCount,
          pendingAgentIds: await this.pendingAgents(taskId),
        };
      } catch (error) {
        if (error instanceof CommitFailure) {
          // COMMIT_INTERRUPTED already recorded the public node failure.
          if (error.code !== COMMIT_ERROR_CODES.COMMIT_INTERRUPTED) {
            await this.appendAttemptFailure(taskId, turnId, inputNodeId, error.message, false);
          }
          await this.recordTurnTrace(taskId, turnId, turnResult.trace, failedPhase(error.message));
          // Commit-stage failures never auto-retry (the Turn was produced; the
          // action set or the commit itself is invalid), regardless of budget.
          return this.failureResult(inputNodeId, events, frozen, false, attemptCount);
        }
        if (error instanceof RuntimeFailure) {
          // Mid-commit runtime failures were recorded by the committer; they
          // are local commit interruptions, never provider-transient.
          await this.recordTurnTrace(taskId, turnId, turnResult.trace, failedPhase(error.message));
          return this.failureResult(inputNodeId, events, frozen, false, attemptCount);
        }
        throw error;
      }
    } catch (error) {
      if (
        error instanceof RuntimeAbortedError ||
        error instanceof CommitFailure ||
        error instanceof RuntimeFailure
      ) {
        throw error;
      }
      // Turn-input reconstruction failures (e.g. skill reads) fail the node.
      const retryable = false;
      const message = '执行上下文构建失败，当前节点无法继续。';
      await this.appendAttemptFailure(taskId, turnId, inputNodeId, message, retryable);
      return this.failureResult(inputNodeId, events, frozen, retryable, attemptCount);
    }
  }

  /** Agents with unprocessed confirmed inputs, in earliest-input order. */
  async pendingAgents(taskId: string): Promise<string[]> {
    const events = (await this.events.read(taskId)).map((entry) => entry.event);
    const frozen = await this.frozenFor(taskId);
    return collectPendingAgents(events, (agentId) =>
      frozen.routes.filter((route) => route.from === agentId && route.kind === 'artifact').length,
    );
  }

  /**
   * Task 12 v2 runner entry (spec §4.4): the authoritative review branch of
   * the scheduler's execution loop. Bound to the FROZEN protocol — a v1/none
   * task is rejected before any dispatch; consumes the leased AssignmentDispatch
   * through the v2 attempt coordinator, which injects the v2 tool provider,
   * persists only public trace and submits the completion to the v2 committer
   * (the facade-backed terminal batch). `runStructuredNext` and the basic path
   * stay byte-for-byte; this entry is additive and fails closed when the
   * coordinator is not wired.
   */
  async runV2Next(taskId: string, signal?: AbortSignal): Promise<RunNextResult> {
    const frozen = await this.frozenFor(taskId);
    if (structuredProtocolOf(frozen) !== 'v2') {
      throw RuntimeFailure.permanent(
        'STRUCTURED_TURN_NOT_RUNNABLE',
        'runV2Next 需要 v2 结构化协议。',
      );
    }
    if (this.v2Attempts === undefined) {
      throw RuntimeFailure.permanent(
        'AUTHORITATIVE_RUNTIME_NOT_WIRED',
        '权威评审执行器尚未接入。',
      );
    }
    const outcome = await this.v2Attempts.runNext(taskId, 'task_owner', signal);
    switch (outcome.kind) {
      case 'idle':
        return {
          processedNodeId: null,
          committed: false,
          taskCompleted: false,
          waitingHuman: false,
          attemptFailed: false,
          retryable: false,
          attemptCount: 0,
          pendingAgentIds: [],
        };
      case 'completed':
        return {
          processedNodeId: outcome.workItemId,
          committed: true,
          taskCompleted: false,
          waitingHuman: false,
          attemptFailed: false,
          retryable: false,
          attemptCount: outcome.leaseEpoch,
          pendingAgentIds: [],
        };
      case 'retryable_failed':
        return {
          processedNodeId: outcome.workItemId,
          committed: false,
          taskCompleted: false,
          waitingHuman: false,
          attemptFailed: true,
          retryable: true,
          attemptCount: outcome.retryOrdinal,
          pendingAgentIds: [],
        };
      case 'terminal_failed':
        return {
          processedNodeId: outcome.workItemId,
          committed: false,
          taskCompleted: false,
          waitingHuman: false,
          attemptFailed: true,
          retryable: false,
          attemptCount: 0,
          pendingAgentIds: [],
        };
      case 'parked':
        return {
          processedNodeId: outcome.workItemId,
          committed: false,
          taskCompleted: false,
          waitingHuman: false,
          attemptFailed: true,
          retryable: false,
          attemptCount: outcome.retryOrdinal,
          pendingAgentIds: [],
        };
      case 'aborted':
        return {
          processedNodeId: outcome.workItemId,
          committed: false,
          taskCompleted: false,
          waitingHuman: false,
          attemptFailed: false,
          retryable: false,
          attemptCount: 0,
          pendingAgentIds: [],
        };
    }
  }

  /**
   * The Pi runtime seam (Task 17): resolves the per-turn structured slot
   * context from the coordinator-built bundle the structured runNext path
   * stored before the Turn. Returns null for basic turns and for turns whose
   * bundle is absent (fail-safe). The meter / tool set / dispatch guard are
   * all the SAME instances the runner built — never recreated by Pi
   * auto-compaction or corrective prompts.
   */
  async createStructuredSlotContext(input: AgentTurnInput): Promise<StructuredSlotRuntimeContext | null> {
    const bundle = this.structuredBundles.get(`${input.taskId}:${input.turnId}`);
    if (bundle === undefined) {
      return null;
    }
    return {
      sessionKind: bundle.sessionKind,
      turnId: bundle.turnId,
      meter: bundle.meter,
      toolDefinitions: bundle.toolDefinitions,
      beforePropose: bundle.beforePropose,
      correctivePrompt: bundle.correctivePrompt,
    };
  }

  // --------------------------------------------------------------------------
  // Structured v3 runNext (Task 17; spec §8.1/§11.5/§13, design §11.5/O01).
  // --------------------------------------------------------------------------

  /** Deterministic proposalId for a structure attempt (design §11.5). */
  private deriveProposalId(turnId: string): string {
    return `${turnId}-proposal`;
  }

  /** ONE pagination cursor signer per task (wiring note 9). */
  private cursorSignerFor(taskId: string): TaskLocalCursorSigner {
    const cached = this.cursorSigners.get(taskId);
    if (cached !== undefined) {
      return cached;
    }
    const signer = createTaskLocalCursorSigner(taskId);
    this.cursorSigners.set(taskId, signer);
    return signer;
  }

  /** Deterministic scaffold identity for the future generation (design §9.3). */
  private deriveScaffoldId(turnId: string): string {
    return `${turnId}-scaffold`;
  }

  /** Deterministic generation identity for a structure attempt (design §15). */
  private deriveGenerationId(turnId: string): string {
    return `${turnId}-generation`;
  }

  /** The active scaffold/generation/revision projected from committed events. */
  private resolveActiveScaffold(events: readonly TaskEvent[]): ActiveScaffoldV1 | null {
    const state = projectStructuredSlotState(events);
    if (state.generationId === null || state.scaffoldId === null) {
      return null;
    }
    return {
      scaffoldId: state.scaffoldId,
      generationId: state.generationId,
      contentRevision: state.contentRevision ?? 0,
    };
  }

  /**
   * The structured runNext path (Task 17): CAS-allocates the attempt BEFORE
   * any private object/Grant creation, idempotently materializes the private
   * Proposal/Draft and issues the Grant, builds the session handle with the
   * composite Attempt signal, runs the model Turn and delegates the terminal
   * authority to the structured committer. The basic branch stays byte-for-byte.
   */
  private async runStructuredNext(
    taskId: string,
    schedulerSignal: AbortSignal,
    events: readonly TaskEvent[],
    frozen: FrozenTemplate,
    agent: FrozenAgentConfig,
    input: Extract<TaskEvent, { type: 'agent_input' }>,
    autoRetryExhausted: boolean,
  ): Promise<RunNextResult> {
    const inputNodeId = input.id;
    // Recheck the SAME runtime environments frozen in CoreService construction
    // (design O05): the scheduler gates first; the runner rechecks so a
    // structured Turn never runs under a disabled/defaulted environment. A v2
    // protocol turn needs the authoritative gate too (spec §17) and is not
    // runnable through this v1 structured path at all.
    if (!isStructuredRuntimeEnabled(this.runtimeEnvironment)) {
      throw new TemplateError(
        TEMPLATE_ERROR_CODES.TEMPLATE_RUNTIME_UNAVAILABLE,
        '结构化运行时能力未就绪，无法运行该结构化回合。',
        null,
        '等待结构化运行时就绪后重试。',
      );
    }
    const contract = frozen.structuredSlots;
    if (contract === null) {
      throw RuntimeFailure.permanent(
        'STRUCTURED_CONTRACT_REQUIRED',
        '结构化模板缺少已冻结的结构槽契约。',
      );
    }
    if (contract.version === 2) {
      // Contract-v2 turns run under the authoritative runtime (Task 10+); the
      // v1 structured path must never interpret them (spec §4.4), and the
      // authoritative gate is rechecked from the SAME frozen environment
      // reference (spec §17) — never a second default.
      if (!isAuthoritativeReviewRuntimeRunnable(this.authoritativeReviewEnvironment)) {
        throw new TemplateError(
          TEMPLATE_ERROR_CODES.TEMPLATE_RUNTIME_UNAVAILABLE,
          'authoritative review 能力未就绪，无法运行该 v2 回合。',
          null,
          '等待 authoritative review 能力就绪后重试。',
        );
      }
      throw RuntimeFailure.permanent('STRUCTURED_TURN_NOT_RUNNABLE', 'v2 回合需要权威评审运行路径。');
    }
    const turnContract = agent.turnContract;
    if (!isStructuredTurnContractV3(turnContract)) {
      throw RuntimeFailure.permanent('STRUCTURED_TURN_NOT_RUNNABLE', '当前回合缺少 v3 结构化契约。');
    }
    const sessionKind = turnContract.slotSession.kind;
    if (this.paths === undefined) {
      throw RuntimeFailure.permanent('STRUCTURED_PATHS_REQUIRED', '运行器缺少结构化存储路径。');
    }

    const snapshotHash = frozen.versionHash;
    const blobStore = new StructuredSlotBlobStore(this.paths, taskId);
    const privateStore = new StructuredSlotPrivateStore(this.paths, taskId);
    const readEvents = async (): Promise<readonly CommittedEvent[]> => this.events.read(taskId);
    const appendBatch = (
      commitId: string,
      batch: readonly TaskEvent[],
      expectedLastSequence: number,
    ): Promise<CommittedEvent[]> =>
      this.events.appendBatch(taskId, commitId, batch, { expectedLastSequence });

    // Resolve the active scaffold BEFORE the fill/seal start batch so
    // draft_opened (fill) and the seal grant bind the real generation/revision
    // (design O01). Structure has no scaffold yet and must NOT require one.
    const activeScaffold =
      sessionKind === 'fill' || sessionKind === 'seal' ? this.resolveActiveScaffold(events) : null;
    if (activeScaffold === null && (sessionKind === 'fill' || sessionKind === 'seal')) {
      throw RuntimeFailure.permanent('SCAFFOLD_NOT_ACTIVE', '填充/封存回合需要 active scaffold。');
    }

    // 1) CAS-allocate the attempt BEFORE any private object/Grant creation
    //    (design §11.5): structure/seal start batches contain only started;
    //    a fill start batch atomically commits started + deterministic draft_opened.
    const start: StartAttemptResult = await startAttempt({
      taskId,
      inputNodeId,
      agentId: agent.id,
      sessionKind,
      events: await readEvents(),
      readEvents,
      appendBatch,
      ...(sessionKind === 'fill' && activeScaffold !== null
        ? {
            draftContext: {
              scaffoldId: activeScaffold.scaffoldId,
              generationId: activeScaffold.generationId,
              baseRevision: activeScaffold.contentRevision,
            },
          }
        : {}),
    });
    const turnId = start.turnId;
    const attemptEpoch = start.attemptEpoch;

    // Surface the committed sessionKind (wiring note 3): a replay while active
    // returns the active attempt's identities even if the requested kind
    // differs — detect and fail closed instead of running the wrong session.
    const committedStart = start.committed.find(
      (entry): entry is CommittedEvent & { event: Extract<TaskEvent, { type: 'structured_slot_attempt_started' }> } =>
        entry.event.type === 'structured_slot_attempt_started',
    );
    if (committedStart === undefined || committedStart.event.sessionKind !== sessionKind) {
      throw RuntimeFailure.permanent(
        'ATTEMPT_SESSION_MISMATCH',
        '已分配的 Attempt 与当前回合的 session kind 不一致。',
      );
    }

    // 2) Idempotently materialize the private object, issue the Grant and build
    //    the session bundle (structure/seal: proposal before grant; fill: the
    //    draft materializes only after the started+draft_opened batch).
    const bundle = await this.buildStructuredBundle({
      taskId,
      turnId,
      attemptEpoch,
      agentId: agent.id,
      sessionKind,
      snapshotHash,
      frozen,
      v3Contract: turnContract,
      contract,
      blobStore,
      privateStore,
      events,
      readEvents,
      schedulerSignal,
      activeScaffold,
      committedStart: start.committed,
    });

    try {
      this.structuredBundles.set(`${taskId}:${turnId}`, bundle);
      return await this.runStructuredTurn({
        taskId,
        schedulerSignal,
        events,
        frozen,
        agent,
        input,
        turnId,
        attemptEpoch,
        bundle,
        autoRetryExhausted,
      });
    } finally {
      this.structuredBundles.delete(`${taskId}:${turnId}`);
    }
  }

  private async runStructuredTurn(options: {
    taskId: string;
    schedulerSignal: AbortSignal;
    events: readonly TaskEvent[];
    frozen: FrozenTemplate;
    agent: FrozenAgentConfig;
    input: Extract<TaskEvent, { type: 'agent_input' }>;
    turnId: string;
    attemptEpoch: number;
    bundle: StructuredTurnBundle;
    autoRetryExhausted: boolean;
  }): Promise<RunNextResult> {
    const { taskId, schedulerSignal, events, frozen, agent, input, turnId, attemptEpoch, bundle, autoRetryExhausted } = options;
    const inputNodeId = input.id;
    const agentId = agent.id;

    let turnResult: Awaited<ReturnType<AgentRuntime['run']>>;
    try {
      const turnInput = await this.assembleStructuredTurnInput(
        taskId,
        events,
        frozen,
        agent,
        input,
        turnId,
        bundle,
      );
      const runOptions =
        this.liveSink === null
          ? undefined
          : {
              onLive: (patch: LivePatch): void => {
                this.liveSink?.(taskId, patch);
              },
            };
      turnResult = await this.runtime.run(turnInput, schedulerSignal, runOptions);
    } catch (error) {
      if (error instanceof RuntimeAbortedError) {
        // A scheduler stop aborts the composite WITHOUT minting a resource
        // terminal (the scheduler's stop path closes the attempt); a
        // meter/deadline closure mints one and must be committed here.
        if (bundle.meter.closed && bundle.meter.terminalFailure !== null) {
          const prepared = await this.structuredCommit(
            { taskId, turnId, attemptEpoch, frozen, agent, inputNodeId, bundle },
            null,
            { publicText: '', forced: 'runtime_failure', failureMessage: bundle.meter.terminalFailure.message },
          );
          return this.structuredFailureResult(taskId, inputNodeId, prepared, false, attemptEpoch);
        }
        await this.runtime.disposeAgent(taskId, agentId).catch(() => undefined);
        throw error;
      }
      // Retry policy classification: a transient failure stays retryable only
      // while the scheduler's automatic budget remains (spec §7.6).
      const classified = classifyRuntimeError(error);
      const retryable = classified.retryable && !autoRetryExhausted;
      const message =
        error instanceof RuntimeFailure ? error.message : '模型执行失败，当前尝试已记录为失败。';
      const prepared = await this.structuredCommit(
        { taskId, turnId, attemptEpoch, frozen, agent, inputNodeId, bundle },
        null,
        { publicText: '', forced: 'runtime_failure', failureMessage: message },
      );
      await this.recordTurnTrace(taskId, turnId, [], failedPhase(message));
      return this.structuredFailureResult(taskId, inputNodeId, prepared, retryable, attemptEpoch);
    }

    // Stale-result suppression (spec §7.2): an abort landing after the Turn
    // succeeded still discards the buffered actions — nothing is committed.
    if (schedulerSignal.aborted) {
      await this.runtime.disposeAgent(taskId, agentId).catch(() => undefined);
      throw new RuntimeAbortedError(`turn ${turnId} aborted before commit`);
    }

    // The model Turn produced buffered actions. A structured v3 turn commits
    // EXACTLY the dispatch the session matrix allows (design §11.3); the
    // committer validates candidate/receipt + dispatch + revision and writes
    // the whole terminal batch atomically (spec §11). More than one action is
    // a permanent failure (forced runtime_failure terminal, one batch).
    const action: ForgeAction | null = turnResult.actions[0] ?? null;
    if (turnResult.actions.length > 1) {
      const prepared = await this.structuredCommit(
        { taskId, turnId, attemptEpoch, frozen, agent, inputNodeId, bundle },
        null,
        {
          publicText: turnResult.publicText,
          forced: 'runtime_failure',
          failureMessage: '结构化回合只允许一个 dispatch 动作。',
        },
      );
      return this.structuredFailureResult(taskId, inputNodeId, prepared, false, attemptEpoch);
    }

    let prepared: PreparedStructuredCommit;
    try {
      prepared = await this.structuredCommit(
        { taskId, turnId, attemptEpoch, frozen, agent, inputNodeId, bundle },
        action,
        { publicText: turnResult.publicText },
      );
    } catch (error) {
      // The structured committer's typed failures (no candidate, stale
      // revision, illegal dispatch, already-terminalized attempt) are NEVER
      // auto-retryable: the Turn was produced but the session/revision cannot
      // commit it. Close the still-active attempt with a forced
      // failed/runtime_failure terminal (every started attempt gets exactly
      // one terminal, spec §8.1); if the forced close also fails (a competitor
      // already terminalized it), record the failure event only (wiring note 7).
      if (error instanceof CommitFailure || error instanceof RuntimeFailure || error instanceof StructuredCommitError) {
        const message = error.message;
        try {
          await this.structuredCommit(
            { taskId, turnId, attemptEpoch, frozen, agent, inputNodeId, bundle },
            null,
            { publicText: turnResult.publicText, forced: 'runtime_failure', failureMessage: message },
          );
        } catch {
          await this.appendAttemptFailure(taskId, turnId, inputNodeId, message, false);
        }
        await this.recordTurnTrace(taskId, turnId, turnResult.trace, failedPhase(message));
        return this.structuredFailureResult(taskId, inputNodeId, null, false, attemptEpoch);
      }
      throw error;
    }
    await this.recordTurnTrace(taskId, turnId, turnResult.trace, prepared.phase);
    return {
      processedNodeId: inputNodeId,
      committed: true,
      taskCompleted: prepared.taskCompleted,
      waitingHuman: prepared.waitingHuman,
      attemptFailed: false,
      retryable: false,
      attemptCount: attemptEpoch,
      pendingAgentIds: await this.pendingAgents(taskId),
    };
  }

  /**
   * Delegates the structured terminal authority to the structured committer
   * (spec §11 / design O03): re-reads the CURRENT session state so the
   * candidate/receipt the model actually formed (or the forced terminal) is
   * bound into the completion signature, then commits or replays the batch.
   */
  private async structuredCommit(
    identity: {
      taskId: string;
      turnId: string;
      attemptEpoch: number;
      frozen: FrozenTemplate;
      agent: FrozenAgentConfig;
      inputNodeId: string;
      bundle: StructuredTurnBundle;
    },
    action: ForgeAction | null,
    extra: {
      publicText: string;
      forced?: 'runtime_failure' | 'task_stop' | 'crash_recovery';
      failureMessage?: string;
    },
  ): Promise<PreparedStructuredCommit> {
    const { taskId, turnId, attemptEpoch, frozen, agent, inputNodeId, bundle } = identity;
    const sessionKind = bundle.sessionKind;
    // Re-open the CURRENT session state so the candidate formed by the model's
    // slot tools (or the locked state) is authoritative for the commit.
    const session = new StructuredSlotSessionService({
      taskId,
      snapshotHash: bundle.snapshotHash,
      store: bundle.privateStore,
      events: async () => (await this.events.read(taskId)).map((entry) => entry.event),
    });
    let structureCandidate: StructureCommitCandidate | null = null;
    let mergeCandidate: MergeCommitCandidate | null = null;
    if (sessionKind === 'structure') {
      const opened = await session.openSession(bundle.grant as StructureSessionGrantV1);
      if (opened.ok) {
        structureCandidate = opened.state.candidate;
      }
    } else if (sessionKind === 'fill') {
      const opened = await session.openFillSession(bundle.grant as FillSessionGrantV1);
      if (opened.ok) {
        mergeCandidate = opened.state.candidate;
      }
    }
    const context: StructuredCommitContext = {
      taskId,
      turnId,
      inputNodeId,
      attemptEpoch,
      sessionKind,
      snapshotHash: bundle.snapshotHash,
      contract: frozen.structuredSlots as FrozenStructuredSlotContractV1,
      events: this.events,
      blobStore: bundle.blobStore,
      privateStore: bundle.privateStore,
      artifactStore: this.artifacts,
      finalSubmitters: frozen.finalOutput.submitters,
      submitStructureContext: bundle.submitStructureContext,
      structureCandidate,
      mergeCandidate,
      sealDispatch: bundle.seal.dispatch,
      forced: extra.forced,
      failureMessage: extra.failureMessage,
      publicText: extra.publicText,
      currentAgent: agent,
      agents: frozen.agents.map(({ id, name }) => ({ id, name })),
      declaredRoutes: frozen.routes,
    };
    return prepareStructuredCommit(context, action);
  }

  private async structuredFailureResult(
    taskId: string,
    inputNodeId: string,
    prepared: PreparedStructuredCommit | null,
    retryable: boolean,
    attemptCount: number,
  ): Promise<RunNextResult> {
    void prepared;
    return {
      processedNodeId: inputNodeId,
      committed: false,
      taskCompleted: false,
      waitingHuman: false,
      attemptFailed: true,
      retryable,
      attemptCount,
      pendingAgentIds: await this.pendingAgents(taskId),
    };
  }

  /**
   * Builds the structured Turn input for a v3 slot-session node: the same
   * public-history / skill / inject / state-prefix assembly as the basic path,
   * plus the opaque per-turn session handle carrying the composite Attempt
   * signal (the basic branch stays byte-for-byte).
   */
  private async assembleStructuredTurnInput(
    taskId: string,
    events: readonly TaskEvent[],
    frozen: FrozenTemplate,
    agent: FrozenAgentConfig,
    input: Extract<TaskEvent, { type: 'agent_input' }>,
    turnId: string,
    bundle: StructuredTurnBundle,
  ): Promise<AgentTurnInput> {
    const inputNodeId = input.id;
    const inputVersion = input.node.inputVersion;
    let handOffArtifact: CurrentInputArtifact | null = null;
    if (inputVersion !== null) {
      const handOff = await this.artifacts.read(taskId, inputVersion);
      const contentFile =
        handOff.files.find((file) => file.name === 'content.md' || file.name === 'content.txt')
          ?.content ?? '';
      handOffArtifact = {
        artifactId: handOff.meta.id,
        version: handOff.meta.version,
        title: handOff.meta.title,
        format: handOff.meta.format,
        content: contentFile,
        sourceNodeId: handOff.meta.sourceNodeId,
        humanAuthorized: input.node.humanAuthorized ?? false,
      };
    }
    let inputText = input.node.body;
    const delivery = resolveIncomingDelivery(events, frozen, inputNodeId);
    if (delivery !== null && inputVersion !== null) {
      try {
        const entry = await this.artifacts.read(taskId, inputVersion);
        const injectParts: string[] = [];
        for (const inj of delivery.inject ?? []) {
          const file = entry.files.find((f) => f.name === inj.file);
          if (file !== undefined) {
            injectParts.push(`${inj.as}：\n${file.content}`);
          }
        }
        if (injectParts.length > 0) {
          inputText = `${inputText}\n\n${injectParts.join('\n\n')}`;
        }
      } catch {
        // Inject read failure is non-fatal; the agent still has the base input.
      }
    }
    const statePrefix = buildTurnStatePrefix(events, agent.id, frozen, inputNodeId);
    if (statePrefix.length > 0) {
      inputText = `${statePrefix}\n\n${inputText}`;
    }
    const checklist = buildTurnChecklist(agent, frozen); // '' for v3 slot sessions
    if (checklist.length > 0) {
      inputText = `${inputText}\n\n${checklist}`;
    }
    return {
      taskId,
      turnId,
      agent,
      inputNodeId,
      inputText,
      publicHistory: buildPublicHistory(events, agent.id, input.node.sequence),
      availableSkills: agent.skills.map(({ id, name, description }) => ({ id, name, description })),
      loadedSkills: await this.skills.loadedSkillsFor(taskId, agent.id),
      slotSession: { sessionKind: bundle.sessionKind, turnId, signal: bundle.signal },
    };
  }

  /**
   * Materializes the private Proposal/Draft, issues the session Grant, creates
   * the persistent Attempt meter and assembles the closed Slot Tool set + the
   * dispatch guard for the current structured attempt (design §9/§10/§11.3).
   * The coordinator committed the attempt first; every step here is idempotent.
   */
  private async buildStructuredBundle(options: {
    taskId: string;
    turnId: string;
    attemptEpoch: number;
    agentId: string;
    sessionKind: 'structure' | 'fill' | 'seal';
    snapshotHash: string;
    frozen: FrozenTemplate;
    v3Contract: StructuredTurnContractV3;
    contract: FrozenStructuredSlotContractV1;
    blobStore: StructuredSlotBlobStore;
    privateStore: StructuredSlotPrivateStore;
    events: readonly TaskEvent[];
    readEvents: () => Promise<readonly CommittedEvent[]>;
    schedulerSignal: AbortSignal;
    activeScaffold: ActiveScaffoldV1 | null;
    committedStart: readonly CommittedEvent[];
  }): Promise<StructuredTurnBundle> {
    const {
      taskId,
      turnId,
      attemptEpoch,
      agentId,
      sessionKind,
      snapshotHash,
      frozen,
      v3Contract,
      contract,
      blobStore,
      privateStore,
      schedulerSignal,
      activeScaffold,
      committedStart,
    } = options;
    const eventsFn = async (): Promise<readonly TaskEvent[]> =>
      (await this.events.read(taskId)).map((entry) => entry.event);
    const grantService = new StructuredSlotGrantService({ taskId, snapshotHash, contract });
    const sessionService = new StructuredSlotSessionService({
      taskId,
      snapshotHash,
      store: privateStore,
      events: eventsFn,
    });
    const capabilities = v3Contract.slotSession.capabilities;
    const accessProfileId =
      v3Contract.slotSession.kind === 'structure' ? null : v3Contract.slotSession.accessProfile;

    const submitStructureContext: SubmitStructureContext = {
      scaffoldId: this.deriveScaffoldId(turnId),
      generationId: this.deriveGenerationId(turnId),
    };

    const meter = await AttemptMeter.create({
      turnId,
      privateStore,
      limits: contract.limits,
      schedulerSignal,
    });

    if (sessionKind === 'structure') {
      const proposalId = this.deriveProposalId(turnId);
      await privateStore.materializeProposal(turnId, proposalId);
      const resolved = grantService.resolveStructureGrant({
        taskId,
        turnId,
        agentId,
        sessionKind: 'structure',
        snapshotHash,
        capabilities,
        proposalId,
      });
      if (!resolved.ok) {
        throw RuntimeFailure.permanent('GRANT_RESOLUTION_FAILED', resolved.reason);
      }
      const opened = await sessionService.openSession(resolved.grant);
      if (!opened.ok) {
        throw RuntimeFailure.permanent('SESSION_OPEN_FAILED', opened.reason);
      }
      const proposalService = new StructuredSlotProposalService({
        taskId,
        snapshotHash,
        contract,
        store: privateStore,
        events: eventsFn,
      });
      const toolCtx: StructuredSlotToolContext = {
        turnId,
        sessionKind: 'structure',
        grant: resolved.grant,
        state: opened.state,
        meter,
        proposalService,
        store: privateStore,
        events: eventsFn,
        submitStructureContext,
      };
      return this.finishBundle({
        taskId,
        turnId,
        sessionKind,
        snapshotHash,
        blobStore,
        privateStore,
        grant: resolved.grant,
        state: opened.state,
        submitStructureContext,
        meter,
        toolCtx,
        committedStart,
        draftId: null,
      });
    }

    if (activeScaffold === null) {
      throw RuntimeFailure.permanent('SCAFFOLD_NOT_ACTIVE', '结构化回合需要 active scaffold。');
    }
    const index = await blobStore.getGenerationIndex(activeScaffold.generationId);
    const source = createStructuredSlotDataSource({ blobStore, events: eventsFn });
    const contentPresence = await source.getContentPresence(
      activeScaffold.generationId,
      activeScaffold.contentRevision,
    );

    if (sessionKind === 'fill') {
      const draftId = deriveDraftId(turnId);
      const validation = new ValidationEngine({ paths: this.paths as CorePaths });
      const projection = new StructuredSlotProjectionService({
        contract,
        source,
        signer: this.cursorSignerFor(taskId),
      });
      const resolved = grantService.resolveFillGrant({
        taskId,
        turnId,
        agentId,
        sessionKind: 'fill',
        snapshotHash,
        capabilities,
        accessProfileId: accessProfileId as string,
        activeScaffold,
        generationIndex: index,
        contentPresence,
        baseRevision: activeScaffold.contentRevision,
        draftId,
      });
      if (!resolved.ok) {
        throw RuntimeFailure.permanent('GRANT_RESOLUTION_FAILED', resolved.reason);
      }
      // The draft materializes ONLY after the atomic started+draft_opened batch
      // (design O01): getOrCreateDraft verifies the committed opened event.
      const draftService = new StructuredSlotDraftService({
        taskId,
        snapshotHash,
        contract,
        store: privateStore,
        blobStore,
        projection,
        validation,
        meter,
        events: eventsFn,
        precharge: (ctx) => consumeSlotToolPrecharge(meter, ctx),
      });
      const draftResult = await draftService.getOrCreateDraft(turnId, draftId);
      if (!draftResult.ok) {
        throw RuntimeFailure.permanent('DRAFT_OPEN_FAILED', draftResult.reason);
      }
      const opened = await sessionService.openFillSession(resolved.grant);
      if (!opened.ok) {
        throw RuntimeFailure.permanent('SESSION_OPEN_FAILED', opened.reason);
      }
      const toolCtx: StructuredSlotToolContext = {
        turnId,
        sessionKind: 'fill',
        grant: resolved.grant,
        state: opened.state,
        meter,
        draftService,
      };
      return this.finishBundle({
        taskId,
        turnId,
        sessionKind,
        snapshotHash,
        blobStore,
        privateStore,
        grant: resolved.grant,
        state: opened.state,
        submitStructureContext,
        meter,
        toolCtx,
        committedStart,
        draftId,
      });
    }

    // seal
    const validation = new ValidationEngine({ paths: this.paths as CorePaths });
    const resolved = grantService.resolveSealGrant({
      taskId,
      turnId,
      agentId,
      sessionKind: 'seal',
      snapshotHash,
      capabilities,
      accessProfileId: accessProfileId as string,
      activeScaffold,
      generationIndex: index,
      baseRevision: activeScaffold.contentRevision,
    });
    if (!resolved.ok) {
      throw RuntimeFailure.permanent('GRANT_RESOLUTION_FAILED', resolved.reason);
    }
    const seal = new StructuredSlotSealService({
      taskId,
      snapshotHash,
      contract,
      paths: this.paths as CorePaths,
      blobStore,
      artifactStore: this.artifacts,
      validationEngine: validation,
      events: eventsFn,
      artifactSchema: frozen.artifactSchema,
      finalOutputFormat: frozen.finalOutput.format,
      finalOutputName: frozen.finalOutput.name,
      templateId: frozen.id,
      templateVersion: frozen.versionHash,
      reworkTarget: this.sealReworkTarget(v3Contract),
      declaredDispatches: this.sealDeclaredDispatches(v3Contract),
      signal: meter.signal,
    });
    const projection = new StructuredSlotProjectionService({
      contract,
      source,
      signer: this.cursorSignerFor(taskId),
    });
    const toolCtx: StructuredSlotToolContext = {
      turnId,
      sessionKind: 'seal',
      grant: resolved.grant,
      state: null,
      meter,
      seal,
      projectionService: projection,
    };
    return this.finishBundle({
      taskId,
      turnId,
      sessionKind,
      snapshotHash,
      blobStore,
      privateStore,
      grant: resolved.grant,
      state: null,
      submitStructureContext,
      meter,
      toolCtx,
      committedStart,
      draftId: null,
      seal,
    });
  }

  /** Finishes a bundle with the closed tool set + dispatch guard + corrective prompt. */
  private finishBundle(options: {
    taskId: string;
    turnId: string;
    sessionKind: 'structure' | 'fill' | 'seal';
    snapshotHash: string;
    blobStore: StructuredSlotBlobStore;
    privateStore: StructuredSlotPrivateStore;
    grant: SlotSessionGrantV1;
    state: StructuredSessionState | null;
    submitStructureContext: SubmitStructureContext;
    meter: AttemptMeter;
    toolCtx: StructuredSlotToolContext;
    committedStart: readonly CommittedEvent[];
    draftId: string | null;
    seal?: SealToolOperations;
  }): StructuredTurnBundle {
    const {
      turnId,
      sessionKind,
      snapshotHash,
      blobStore,
      privateStore,
      grant,
      state,
      submitStructureContext,
      meter,
      toolCtx,
      committedStart,
      draftId,
      seal,
    } = options;
    let currentState = state;
    toolCtx.onCandidateCreated = () => {
      if (currentState === null) return;
      if (sessionKind === 'structure' && currentState.sessionKind === 'structure') {
        currentState = {
          ...currentState,
          candidate: {} as never,
          completion: 'structure_commit_candidate_created',
          locked: true,
        };
      } else if (sessionKind === 'fill' && currentState.sessionKind === 'fill') {
        currentState = {
          ...currentState,
          candidate: {} as never,
          completion: 'merge_candidate_created',
          locked: true,
        };
      }
    };
    const toolDefinitions = createStructuredSlotToolDefinitions(toolCtx);
    const beforePropose =
      sessionKind === 'seal' && seal !== undefined
        ? (action: ForgeAction) => assertSealDispatchAction(seal.dispatch, action)
        : (action: ForgeAction) => {
            if (currentState === null) {
              return {
                ok: false as const,
                code: 'STRUCTURE_ACTION_NOT_ALLOWED',
                reason: 'no structured session state',
              };
            }
            return assertStructuredForgeAction(currentState, action);
          };
    const correctivePrompt =
      sessionKind === 'seal'
        ? '本回合必须先调用 request_seal 形成 sealed candidate，再以 publish_artifact 或 submit_final_artifact 结束。'
        : '本回合必须先通过对应的 submit 工具冻结候选，再以 send_message 结束；也可以随时以 request_human_input 请求人工。';
    return {
      sessionKind,
      turnId,
      signal: meter.signal,
      meter,
      grant,
      state,
      submitStructureContext,
      seal: seal ?? this.emptySealOperations(),
      snapshotHash,
      blobStore,
      privateStore,
      committedStart,
      draftId,
      toolDefinitions,
      beforePropose,
      correctivePrompt,
    };
  }

  /** Empty seal operations (fail-safe; the seal service is wired for seal turns). */
  private emptySealOperations(): SealToolOperations {
    return {
      dispatch: { status: 'none' },
      requestSeal: async () => ({
        ok: false,
        code: 'GRANT_INVALID',
        reason: 'the seal service is not wired',
      }),
    };
  }

  /** The seal rework target: the frozen v3 send_message target (design L01). */
  private sealReworkTarget(v3Contract: StructuredTurnContractV3): string {
    const targets = v3Contract.dispatch.targets.send_message ?? [];
    return targets[0] ?? '';
  }

  /** The seal success dispatches the turn contract declares (design L01). */
  private sealDeclaredDispatches(
    v3Contract: StructuredTurnContractV3,
  ): Array<'publish_artifact' | 'submit_final_artifact'> {
    return (v3Contract.dispatch.allowedActions as Array<'publish_artifact' | 'submit_final_artifact'>).filter(
      (action) => action === 'publish_artifact' || action === 'submit_final_artifact',
    );
  }

  private async frozenFor(taskId: string): Promise<FrozenTemplate> {
    const cached = this.frozenCache.get(taskId);
    if (cached !== undefined) {
      return cached;
    }
    const frozen = await this.tasks.readFrozenTemplate(taskId);
    this.frozenCache.set(taskId, frozen);
    return frozen;
  }

  /**
   * The provisional publication table is derived from the sealed package at
   * commit time; the runner only assembles identity: the frozen contract of
   * the executing agent and the received input artifact identity (frozen
   * decisions 3/5). A structured v3 turn (Task 15/17) additionally carries the
   * atomic structured commit wiring; basic v2 turns never pass one, so the
   * basic runNext path is byte-for-byte unchanged.
   */
  private buildCommitContext(
    taskId: string,
    turnId: string,
    frozen: FrozenTemplate,
    agent: FrozenAgentConfig,
    inputNodeId: string,
    attemptCount: number,
    publicText: string,
    currentInputArtifact: CurrentInputArtifact | null,
    structured?: StructuredCommitContext,
  ): CommitContext {
    return {
      taskId,
      turnId,
      currentAgent: agent,
      agents: frozen.agents.map(({ id, name }) => ({ id, name })),
      inputNodeId,
      attemptCount,
      publicText,
      declaredRoutes: frozen.routes,
      finalOutput: frozen.finalOutput,
      turnContract: agent.turnContract,
      currentInputArtifact,
      structured,
    };
  }

  private async appendAttemptFailure(
    taskId: string,
    turnId: string,
    inputNodeId: string,
    message: string,
    retryable: boolean,
  ): Promise<void> {
    await this.events.append(taskId, {
      id: `${turnId}-failed`,
      at: this.clock().toISOString(),
      type: 'agent_attempt_failed',
      nodeId: inputNodeId,
      message,
      retryable,
    });
  }

  /**
   * Best-effort final turn-trace persistence (plan 2026-08-04 Task 5, frozen
   * decision 6): ONE write per turn after the commit outcome is known. The
   * phase is display-only and platform-derived; failure paths may write a
   * phase-only record with zero entries. Traces never gate delivery, and any
   * store failure is swallowed so the authoritative commit path is never
   * blocked by a damaged trace view.
   */
  private async recordTurnTrace(
    taskId: string,
    turnId: string,
    trace: readonly TraceEntry[],
    phase?: TurnTracePhase,
  ): Promise<void> {
    if (trace.length === 0 && phase === undefined) {
      return;
    }
    try {
      await this.traces.appendTurnTrace(taskId, turnId, trace, phase);
    } catch {
      // Trace persistence is best effort; isolation belongs to the store.
    }
  }

  /**
   * Resolves a `finish_production` referencing an agent workspace file into
   * controlled content before the commit context is built (plan 2026-08-04
   * Task 4; downstream of resolution the sealed package carries only
   * content). Success returns the action list with the resolved `content`
   * attached; an unreadable file records a non-retryable attempt failure
   * and returns null — this method never throws, because the scheduler loop
   * only swallows RuntimeAbortedError.
   */
  private async resolveWorkspaceProduction(
    taskId: string,
    agentId: string,
    turnId: string,
    inputNodeId: string,
    actions: readonly ForgeAction[],
  ): Promise<ForgeAction[] | null> {
    const resolved: ForgeAction[] = [];
    for (const action of actions) {
      if (action.type !== 'finish_production' || action.source !== 'workspace_file') {
        resolved.push(action);
        continue;
      }
      const resolvedFiles = [];
      for (const file of action.files) {
        const workspaceFile = file.workspaceFile;
        if (workspaceFile === undefined) {
          await this.appendAttemptFailure(
            taskId,
            turnId,
            inputNodeId,
            'finish_production 工作区文件引用缺失。',
            false,
          );
          return null;
        }
        try {
          const content = await this.workspaces.readFile(taskId, agentId, workspaceFile);
          resolvedFiles.push({ name: file.name, content });
        } catch (error) {
          const message =
            error instanceof RuntimeFailure ? error.message : '工作区文件不可读。';
          await this.appendAttemptFailure(taskId, turnId, inputNodeId, message, false);
          return null;
        }
      }
      // Platform-resolved shape consumed by the committer: keep the declared
      // source (so the contract's sources list still validates), and attach the
      // resolved file content the committer publishes.
      resolved.push({
        ...action,
        files: resolvedFiles,
      } as ForgeAction);
    }
    return resolved;
  }

  private failureResult(
    inputNodeId: string,
    events: readonly TaskEvent[],
    frozen: FrozenTemplate,
    retryable: boolean,
    attemptCount: number,
  ): RunNextResult {
    return {
      processedNodeId: inputNodeId,
      committed: false,
      taskCompleted: false,
      waitingHuman: false,
      attemptFailed: true,
      retryable,
      attemptCount,
      pendingAgentIds: collectPendingAgents(events, (agentId) =>
        frozen.routes.filter((route) => route.from === agentId && route.kind === 'artifact')
          .length,
      ),
    };
  }
}
