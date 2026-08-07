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
import type { ArtifactStore } from '../storage/artifact-store';
import type { EventStore } from '../storage/event-store';
import type { TaskStore } from '../storage/task-store';
import type { TaskEvent } from '../storage/task-events';
import type { TraceStore } from '../storage/trace-store';
import type { FrozenAgentConfig, FrozenTemplate } from '../template/template-schema';
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
 * Resolves the inputVersion a route sender operated on, for route.inject
 * execution-time resolution (spec §5.2). Walks the sender's result event
 * (the route's fromNodeId) to its consumed input node (agent_result.inputNodeId)
 * and returns that input node's inputVersion. Returns null when the sender has
 * no result, no consumed input, or the consumed input carried no version.
 */
function resolveSenderInputVersion(
  events: readonly TaskEvent[],
  senderResultNodeId: string,
): number | null {
  for (const event of events) {
    if (event.type !== 'agent_result' || event.id !== senderResultNodeId) {
      continue;
    }
    const senderInputId = event.inputNodeId ?? null;
    if (senderInputId === null) {
      return null;
    }
    const senderInput = events.find(
      (candidate): candidate is Extract<TaskEvent, { type: 'agent_input' }> =>
        candidate.type === 'agent_input' && candidate.id === senderInputId,
    );
    return senderInput === undefined ? null : senderInput.node.inputVersion;
  }
  return null;
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
  const agentNameOf = (agentId: string): string =>
    frozen.agents.find((candidate) => candidate.id === agentId)?.name ?? agentId;
  const lines: string[] = ['【本回合任务清单】'];

  const isProduction = contract.production !== undefined;
  const isOperate = contract.annotate !== undefined;
  const targetsOf = (action: string): string[] => {
    const map = contract.dispatch.targets as Record<string, string[] | undefined>;
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
    const sourceLabels = (contract.production!.output.sources ?? []).map(
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

  const dispatchLines = contract.dispatch.allowedActions
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

    // Rebuild loaded Skills; failures are confined to the current node.
    try {
      const loadedSkills = await this.skills.loadedSkillsFor(taskId, agentId);
      let inputText = input.node.body;
      let handOffArtifact: CurrentInputArtifact | null = null;
      if (input.node.inputVersion !== null) {
        const handOff = await this.artifacts.read(taskId, input.node.inputVersion);
        const contentFile =
          handOff.files.find((file) => file.name === 'content.md' || file.name === 'content.txt')
            ?.content ?? '';
        inputText = artifactHandOffInputText(handOff.meta.title, contentFile);
        handOffArtifact = {
          artifactId: handOff.meta.id,
          version: handOff.meta.version,
          title: handOff.meta.title,
          format: handOff.meta.format,
          content: contentFile,
          sourceNodeId: handOff.meta.sourceNodeId,
          humanAuthorized: input.node.humanAuthorized ?? false,
        };
      } else {
        // Route inject (spec §5.2): the input node carries no inputVersion, so
        // the delivering route's declared inject files are read from the
        // SENDER's input version (resolved through the route's fromNodeId ->
        // agent_result.inputNodeId -> sender agent_input) and appended to the
        // input text under their declared `as` labels. Inject is execution-time
        // only: nothing is materialized into events (spec §5.2).
        const routeEvent = events.find(
          (e): e is Extract<TaskEvent, { type: 'route_executed' }> =>
            e.type === 'route_executed' && e.route.toNodeId === inputNodeId,
        );
        if (routeEvent !== undefined) {
          const declaredRoute = frozen.routes.find(
            (r) => r.kind === routeEvent.route.kind && r.label === routeEvent.route.label,
          );
          if (declaredRoute !== undefined && declaredRoute.inject !== undefined) {
            const injects = declaredRoute.inject;
            if (injects.length > 0) {
              const injectVersion = resolveSenderInputVersion(events, routeEvent.route.fromNodeId);
              if (injectVersion !== null) {
                try {
                  const injectEntry = await this.artifacts.read(taskId, injectVersion);
                  const injectParts: string[] = [];
                  for (const inj of injects) {
                    const file = injectEntry.files.find((f) => f.name === inj.file);
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
            }
          }
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
   * decisions 3/5).
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
