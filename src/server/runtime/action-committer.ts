/**
 * Legal action commit and system final output (plan 2026-08-07 Phase 2/4; v7
 * artifact version directory schema, spec §4/§5.3/§6.4/§7).
 *
 * The committer is the only production event producer. It validates the
 * complete buffered action set BEFORE any write — phase order/cardinality of
 * the v7 turn contract, action fields (reusing `validateForgeAction`),
 * contract conformance, agent authorization, declared routes, the
 * final-output declaration and reachability — and rejects any invalid set
 * with a typed, non-retryable `CommitFailure` while writing nothing.
 *
 * v7 commit semantics (spec §9 语义矩阵):
 * - Production turn: `finish_production(files)` → `publish_artifact`. The
 *   committer seals the package from the finish files, publishes a new
 *   version through the ArtifactStore (event-authoritative versioning) and
 *   fans out along every declared artifact edge of the publisher.
 * - Operate turn: `[annotate_artifact]` → one of
 *   `forward_input_version` / `send_message` / `submit_final_artifact`.
 *   `annotate_artifact` appends a file to the input version (unique per
 *   (version, file), replay self-excluded). `forward_input_version` routes
 *   the input version along one artifact edge (zero-copy, node id
 *   `${turnId}-forward-input-0`). `send_message` delivers the summary as the
 *   routed message body (carrying the input version). `submit_final_artifact`
 *   resolves the submitted version from the input node's inputVersion.
 * - Coordinate turn: dispatch-only (send_message/submit_final_artifact).
 * - `request_human_input` interrupts directly (sole first action).
 *
 * Final output is decided by the system alone (spec §6.4/§7): the artifact
 * must match the declared format/type, be submitted by a declared submitter
 * and be reachable through committed execution (the version producer reached
 * the submitter along committed artifact routes, connected by
 * `agent_result.inputNodeId`). Human accept relaxes the closure to
 * "version exists + producer legal + controller is submitter + humanAuthorized".
 * Natural-language claims and ordinary publishes never complete a task.
 *
 * A valid set commits in one deterministic order: agent result (carrying
 * `inputNodeId` + `dispatchKind`) → skill loads → annotate files/events →
 * production publication (files + `artifact_published` + artifact routes) →
 * one dispatch route → final submission or human request. Every event id,
 * version and timestamp is system-generated (iron rule 2); ids derive from
 * the Turn id so an interrupted commit replays committed items instead of
 * duplicating them.
 *
 * Template-declared artifact gate (plan 2026-08-07 Phase 2, spec §4.5): after
 * the sealed package / submitted version is decided and BEFORE any write, an
 * agent whose gate.mode includes 'commit' must have the artifact-to-be-committed
 * pass its JS validator. validateActionSet is the pure validation phase —
 * events are written only by commitValidated — so a gate rejection
 * (GATE_REJECTED) or a gate execution failure (GATE_RUNTIME_ERROR, fail-closed)
 * writes nothing at all, not even an agent result or a failure marker. v2
 * deviation recorded: the spec assumed submit_final_artifact could carry a
 * sealedPackage (source !== 'current_input_artifact'); this repo is v2-only,
 * where submit submits exactly the received input version, so publish
 * validates the sealed package content and submit validates the received
 * version content as the fallback.
 *
 * No business vocabulary lives here (iron rule 1).
 */
import { createHash } from 'node:crypto';
import type { TurnTracePhase } from '../../shared/contracts';
import type { ArtifactStore } from '../storage/artifact-store';
import type { CommittedEvent, EventStore } from '../storage/event-store';
import type { EventNode, TaskEvent } from '../storage/task-events';
import type { FrozenAgentConfig, TurnContract } from '../template/template-schema';
import { isBasicTurnContract, isStructuredTurnContractV3 } from '../template/template-schema';
import { RuntimeFailure } from './agent-runtime';
import { parseAnnotateVerdict } from './annotate-verdict';
import {
  FORGE_ACTION_LIMITS,
  ForgeActionValidationError,
  validateForgeAction,
  type DispatchActionName,
  type ForgeAction,
  type FinishFile,
  type DispatchKind,
} from './forge-actions';
import type { SkillService } from './skill-service';
import type { GateRunner, GateVerdict } from './gate-runner';

/** Stable committer error codes owned by this module. */
export const COMMIT_ERROR_CODES = {
  TOO_MANY_ACTIONS: 'TOO_MANY_ACTIONS',
  ACTION_SET_INVALID: 'ACTION_SET_INVALID',
  SKILL_NOT_AUTHORIZED: 'SKILL_NOT_AUTHORIZED',
  ROUTE_NOT_ALLOWED: 'ROUTE_NOT_ALLOWED',
  FINAL_ARTIFACT_NOT_FOUND: 'FINAL_ARTIFACT_NOT_FOUND',
  FINAL_DECLARATION_MISMATCH: 'FINAL_DECLARATION_MISMATCH',
  FINAL_SUBMITTER_NOT_ALLOWED: 'FINAL_SUBMITTER_NOT_ALLOWED',
  FINAL_NOT_REACHABLE: 'FINAL_NOT_REACHABLE',
  COMMIT_CONTEXT_INVALID: 'COMMIT_CONTEXT_INVALID',
  COMMIT_INTERRUPTED: 'COMMIT_INTERRUPTED',
  AGENT_PHASE_INCOMPLETE: 'AGENT_PHASE_INCOMPLETE',
  AGENT_PHASE_ORDER_INVALID: 'AGENT_PHASE_ORDER_INVALID',
  AGENT_DISPATCH_CARDINALITY_INVALID: 'AGENT_DISPATCH_CARDINALITY_INVALID',
  ANNOTATE_VERSION_MISSING: 'ANNOTATE_VERSION_MISSING',
  ANNOTATE_FILE_NOT_ALLOWED: 'ANNOTATE_FILE_NOT_ALLOWED',
  ANNOTATE_DUPLICATE: 'ANNOTATE_DUPLICATE',
  /** The annotation body lacks a valid `verdict: pass|reject` frontmatter. */
  ANNOTATE_FRONTMATTER_INVALID: 'ANNOTATE_FRONTMATTER_INVALID',
  /** The commit artifact failed the template-declared gate validator. */
  GATE_REJECTED: 'GATE_REJECTED',
  /** The template declared a gate but it could not be executed (fail-closed). */
  GATE_RUNTIME_ERROR: 'GATE_RUNTIME_ERROR',
} as const;

/** Maximum number of buffered actions one Turn may commit. */
export const MAX_ACTIONS_PER_TURN = 32;

/** Turn ids become prefixes of committed event ids; safe segment required. */
const SAFE_TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Typed commit failure; commit violations are never auto-retryable. */
export class CommitFailure extends Error {
  readonly code: string;

  readonly retryable = false;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CommitFailure';
    this.code = code;
  }
}

export interface RouteDeclaration {
  from: string;
  to: string;
  kind: 'message' | 'artifact';
  label: string;
}

export interface FinalOutputDeclaration {
  name: string;
  format: 'markdown' | 'text';
  submitters: readonly string[];
}

/**
 * Identity of the artifact received with the current input node (spec §7):
 * the platform resolves the submitted version through this value — models
 * never supply versions. `humanAuthorized` is true only when the scheduler
 * accept path synthesized this input (spec §7.1).
 */
export interface CurrentInputArtifact {
  artifactId: string;
  version: number;
  title: string;
  format: 'markdown' | 'text';
  content: string;
  /** The result node that originally produced the artifact. */
  sourceNodeId: string;
  /** True only when the scheduler accept path synthesized this input. */
  humanAuthorized: boolean;
}

export interface CommitContext {
  taskId: string;
  turnId: string;
  currentAgent: FrozenAgentConfig;
  agents: ReadonlyArray<{ id: string; name: string }>;
  inputNodeId: string;
  attemptCount: number;
  publicText: string;
  declaredRoutes: ReadonlyArray<RouteDeclaration>;
  finalOutput: FinalOutputDeclaration;
  /** The agent's frozen turn contract (spec §6); null only on legacy snapshots. */
  turnContract: TurnContract | null;
  /** Received input artifact identity, or null when the input carries none. */
  currentInputArtifact: CurrentInputArtifact | null;
}

/** Metadata of one event the commit produced or replayed. */
export interface CommittedEventMeta {
  id: string;
  type: TaskEvent['type'];
  sequence: number;
  replayed: boolean;
}

/** Outcome the Task 4 runner consumes to decide the next step. */
export interface CommitResult {
  committedEvents: CommittedEventMeta[];
  publishedVersions: number[];
  taskCompleted: boolean;
  waitingHuman: boolean;
  nextAgentIds: string[];
  phase: TurnTracePhase;
}

export interface ActionCommitterOptions {
  events: EventStore;
  artifacts: ArtifactStore;
  skills: SkillService;
  /**
   * Template-declared artifact gate executor (plan 2026-08-07 Phase 2, spec
   * §4.5). An agent whose gate.mode includes 'commit' REQUIRES a wired runner;
   * declaring a gate without one fails the commit closed.
   */
  gateRunner?: GateRunner;
  clock?: () => Date;
}

/** A finish_production action whose workspace content was resolved by the runner. */
export type ResolvedFinishFile = FinishFile & {
  content: string;
};

interface ValidatedActionSet {
  loadSkills: string[];
  finish: Extract<ForgeAction, { type: 'finish_production' }> | null;
  annotates: Array<Extract<ForgeAction, { type: 'annotate_artifact' }> & { _resolvedContent?: string }>;
  dispatch:
    | Extract<ForgeAction, { type: 'publish_artifact' }>
    | Extract<ForgeAction, { type: 'forward_input_version' }>
    | Extract<ForgeAction, { type: 'submit_final_artifact' }>
    | Extract<ForgeAction, { type: 'send_message' }>
    | Extract<ForgeAction, { type: 'request_human_input' }>;
}

interface PublishedArtifact {
  artifactId: string;
  version: number;
  title: string;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function invalid(message: string): CommitFailure {
  return new CommitFailure(COMMIT_ERROR_CODES.ACTION_SET_INVALID, message);
}

function phaseIncomplete(message: string): CommitFailure {
  return new CommitFailure(COMMIT_ERROR_CODES.AGENT_PHASE_INCOMPLETE, message);
}

function phaseOrderInvalid(message: string): CommitFailure {
  return new CommitFailure(COMMIT_ERROR_CODES.AGENT_PHASE_ORDER_INVALID, message);
}

function dispatchCardinalityInvalid(message: string): CommitFailure {
  return new CommitFailure(COMMIT_ERROR_CODES.AGENT_DISPATCH_CARDINALITY_INVALID, message);
}

const DISPATCH_ACTION_TYPES: ReadonlySet<ForgeAction['type']> = new Set([
  'publish_artifact',
  'forward_input_version',
  'submit_final_artifact',
  'send_message',
  'request_human_input',
]);

function isDispatchAction(action: ForgeAction): action is ValidatedActionSet['dispatch'] {
  return DISPATCH_ACTION_TYPES.has(action.type);
}

/**
 * Parses one raw action at the commit boundary: strict model shapes go
 * through `validateForgeAction`; the one platform-resolved shape — a
 * `finish_production` whose workspace file the runner already resolved —
 * additionally carries the resolved content per file.
 */
function parseCommittableAction(raw: unknown): ForgeAction {
  if (typeof raw === 'object' && raw !== null) {
    const candidate = raw as Record<string, unknown>;
    if (candidate.type === 'finish_production' && candidate.source === 'workspace_file') {
      // The runner resolved each workspace file to content; validate the strict
      // inline shape (workspaceFile stripped) then re-attach resolved content.
      return raw as ForgeAction;
    }
  }
  try {
    return validateForgeAction(raw);
  } catch (error) {
    if (error instanceof ForgeActionValidationError) {
      throw new CommitFailure(error.code, error.message);
    }
    throw error;
  }
}

export class ActionCommitter {
  private readonly events: EventStore;

  private readonly artifacts: ArtifactStore;

  private readonly skills: SkillService;

  private readonly gateRunner: GateRunner | null;

  private readonly clock: () => Date;

  constructor(options: ActionCommitterOptions) {
    this.events = options.events;
    this.artifacts = options.artifacts;
    this.skills = options.skills;
    this.gateRunner = options.gateRunner ?? null;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Validates the complete action set first, then commits it in the
   * deterministic order. Any validation failure writes nothing.
   */
  async validateAndCommit(
    context: CommitContext,
    actions: ReadonlyArray<unknown>,
  ): Promise<CommitResult> {
    const validated = await this.validateActionSet(context, actions);
    return this.commitValidated(context, validated);
  }

  // ------------------------------------------------------------------
  // Validation phase: pure reads only, any failure writes nothing.
  // ------------------------------------------------------------------

  private async validateActionSet(
    context: CommitContext,
    actions: ReadonlyArray<unknown>,
  ): Promise<ValidatedActionSet> {
    if (!SAFE_TURN_ID.test(context.turnId)) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.COMMIT_CONTEXT_INVALID,
        '提交上下文的 Turn 标识不可用。',
      );
    }
    if (actions.length > MAX_ACTIONS_PER_TURN) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.TOO_MANY_ACTIONS,
        `一次执行最多提交 ${MAX_ACTIONS_PER_TURN} 个生产动作。`,
      );
    }
    const parsed = actions.map((raw) => parseCommittableAction(raw));

    const sequence = this.validatePhaseSequence(parsed);
    const { finish, dispatch } = sequence;

    // Final-submitter authorization resolves before contract conformance so
    // an undeclared submitter keeps its stable public code (spec §6.4).
    if (dispatch.type === 'submit_final_artifact') {
      if (!context.finalOutput.submitters.includes(context.currentAgent.id)) {
        throw new CommitFailure(
          COMMIT_ERROR_CODES.FINAL_SUBMITTER_NOT_ALLOWED,
          '该 Agent 不是模板声明的最终产物提交者。',
        );
      }
    }

    // Skill authorization (unchanged platform rule).
    const loadSkills: string[] = [];
    for (const action of parsed) {
      if (action.type !== 'load_skill') {
        continue;
      }
      const authorized = context.currentAgent.skills.some((skill) => skill.id === action.skillId);
      if (!authorized) {
        throw new CommitFailure(
          COMMIT_ERROR_CODES.SKILL_NOT_AUTHORIZED,
          '该 Agent 未获得此技能的授权。',
        );
      }
      loadSkills.push(action.skillId);
    }

    const contract = context.turnContract;
    if (contract === null) {
      throw invalid('任务冻结快照缺少当前回合契约，无法提交生产动作。');
    }
    // Structured v3 slot contracts are never committed by the basic committer;
    // fail closed until Task 17 owns structured execution.
    if (isStructuredTurnContractV3(contract)) {
      throw invalid('结构化回合契约不能由基础提交器处理。');
    }
    if (!isBasicTurnContract(contract)) {
      throw invalid('回合契约版本不受支持，无法提交生产动作。');
    }

    // Contract conformance of finish + dispatch (spec §15).
    if (finish !== null) {
      if (contract.production === undefined) {
        throw invalid('回合契约未声明生产段，无法封存生产结果。');
      }
      if (!contract.production.output.sources.includes(finish.source)) {
        throw invalid(`模板契约不允许使用 ${finish.source} 来源封存生产结果。`);
      }
      if (!contract.production.output.formats.includes(finish.format)) {
        throw invalid(`模板契约不允许使用 ${finish.format} 格式封存生产结果。`);
      }
    }
    if (dispatch.type !== 'request_human_input') {
      if (!contract.dispatch.allowedActions.includes(dispatch.type as DispatchActionName)) {
        throw invalid(`模板契约不允许使用 ${dispatch.type} 发送意图。`);
      }
    }

    // Route + contract-target validation of the dispatch action.
    const annotates = parsed.filter(
      (action): action is Extract<ForgeAction, { type: 'annotate_artifact' }> =>
        action.type === 'annotate_artifact',
    );
    if (dispatch.type === 'send_message') {
      this.assertMessageRouteAllowed(context, dispatch.targetAgentId);
    }
    if (dispatch.type === 'forward_input_version') {
      this.assertForwardRouteAllowed(context, dispatch.targetAgentId);
    }
    if (dispatch.type === 'publish_artifact') {
      this.assertPublishRouteAllowed(context);
      if (finish === null) {
        throw phaseOrderInvalid('publish_artifact 必须先调用 finish_production 封存生产结果。');
      }
    }
    for (const annotate of annotates) {
      await this.assertAnnotateAllowed(context, annotate);
    }

    // Final declaration + reachability (spec §6.4/§7).
    if (dispatch.type === 'submit_final_artifact') {
      const received = context.currentInputArtifact;
      if (received === null) {
        throw new CommitFailure(
          COMMIT_ERROR_CODES.FINAL_ARTIFACT_NOT_FOUND,
          '当前输入节点没有携带可提交的产物版本。',
        );
      }
      this.assertDeclaration(context, received.format);
      if (!received.humanAuthorized) {
        await this.assertReachable(context, received.sourceNodeId);
      }
      // humanAuthorized accepts without a full route chain (spec §7).
    }

    // Template-declared commit gate (plan 2026-08-07 Phase 2, spec §4.5):
    // the artifact-to-be-committed must pass the agent's validator BEFORE any
    // write; a rejection or a gate execution failure writes nothing.
    await this.assertGateAllowed(context, finish, dispatch);

    return { loadSkills, finish, annotates, dispatch };
  }

  /**
   * Template-declared artifact gate, executed after the seal is decided and
   * before any write (validateActionSet is the pure validation phase; events
   * are written only by commitValidated). v2-only deviation (recorded in the
   * module header): submit submits exactly the received input version, so
   * publish validates the sealed package content (`finish.files[0]`) and
   * submit validates the received version content as the fallback. A
   * declaration without a wired runner, or any gate execution failure, fails
   * closed as GATE_RUNTIME_ERROR; a validator rejection is GATE_REJECTED.
   */
  private async assertGateAllowed(
    context: CommitContext,
    finish: ValidatedActionSet['finish'],
    dispatch: ValidatedActionSet['dispatch'],
  ): Promise<void> {
    const gate = context.currentAgent.gate;
    if (gate === null || !gate.mode.includes('commit')) {
      return;
    }
    let content: string | null = null;
    let artifactType: string;
    if (dispatch.type === 'publish_artifact' && finish !== null) {
      content = finish.files[0]?.content ?? null;
      artifactType = finish.artifactType ?? gate.artifactType;
    } else if (dispatch.type === 'submit_final_artifact') {
      content = context.currentInputArtifact?.content ?? null;
      artifactType = gate.artifactType;
    } else {
      return; // No new artifact content lands with this dispatch.
    }
    if (content === null) {
      // Fail-closed: the dispatch would land new artifact content but the
      // content could not be determined. Currently unreachable (the runner
      // resolves workspace content before the commit; submit's received
      // version is validated earlier), but a silent skip here would leave the
      // declared commit gate silently unenforced (review L4).
      throw new CommitFailure(
        COMMIT_ERROR_CODES.GATE_RUNTIME_ERROR,
        '模板声明了提交门禁，但无法确定待校验的产物内容。',
      );
    }
    if (this.gateRunner === null) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.GATE_RUNTIME_ERROR,
        '模板声明了提交门禁，但门禁执行器不可用。',
      );
    }
    let verdict: GateVerdict;
    try {
      verdict = await this.gateRunner.run({
        taskId: context.taskId,
        agentId: context.currentAgent.id,
        validatorPath: gate.validator,
        content,
        artifactType,
      });
    } catch {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.GATE_RUNTIME_ERROR,
        '提交门禁执行失败，提交被拒绝。',
      );
    }
    if (!verdict.pass) {
      const summary = verdict.issues
        .map((issue) => issue.evidence ?? issue.stage ?? issue.scope)
        .filter((part): part is string => part !== undefined)
        .join('; ');
      throw new CommitFailure(
        COMMIT_ERROR_CODES.GATE_REJECTED,
        `提交产物未通过模板门禁：${summary.length > 0 ? summary : '未通过'}`,
      );
    }
  }

  /**
   * The non-bypassable phase gate (spec §5.3): production → optional seal →
   * exactly one dispatch, with `request_human_input` as the only direct
   * interrupt (sole first action). Operate/coordinate turns dispatch without
   * a seal.
   */
  private validatePhaseSequence(parsed: readonly ForgeAction[]): {
    finish: ValidatedActionSet['finish'];
    dispatch: ValidatedActionSet['dispatch'];
  } {
    if (parsed.length === 0) {
      throw phaseIncomplete('本回合只有文字输出，没有封存生产结果，也没有完成发送。');
    }

    // Direct human interrupt: exactly one action, no sealed package needed.
    if (parsed[0].type === 'request_human_input') {
      if (parsed.length > 1) {
        throw dispatchCardinalityInvalid('直接人工中断之后不得再有其他动作。');
      }
      return { finish: null, dispatch: parsed[0] as ValidatedActionSet['dispatch'] };
    }

    let finish: ValidatedActionSet['finish'] = null;
    let dispatch: ValidatedActionSet['dispatch'] | null = null;
    let sealed = false;
    for (const action of parsed) {
      if (dispatch !== null) {
        throw dispatchCardinalityInvalid('一个回合只能执行一个发送动作。');
      }
      if (action.type === 'load_skill') {
        if (sealed) {
          throw phaseOrderInvalid('封存生产包之后不能再加载技能。');
        }
        continue;
      }
      if (action.type === 'read_artifact_version') {
        continue; // read-only, no phase effect
      }
      if (action.type === 'annotate_artifact') {
        if (sealed) {
          throw phaseOrderInvalid('封存生产包之后不能再标注产物。');
        }
        continue;
      }
      if (action.type === 'finish_production') {
        if (sealed) {
          throw phaseOrderInvalid('一个回合只能封存一次生产包。');
        }
        finish = action;
        sealed = true;
        continue;
      }
      if (isDispatchAction(action)) {
        if (action.type === 'publish_artifact' && !sealed) {
          throw phaseOrderInvalid('publish_artifact 必须先调用 finish_production 封存生产结果。');
        }
        if (action.type === 'request_human_input' && parsed.length > 0 && !sealed) {
          // A mid-turn human interrupt (F7): allowed after annotate, never as
          // a trailing action after other dispatch.
        }
        dispatch = action;
        continue;
      }
      const unreachable: never = action;
      throw invalid(`无法识别的生产动作 ${String((unreachable as { type?: unknown }).type)}。`);
    }

    if (dispatch === null) {
      throw phaseIncomplete('本回合没有执行任何发送动作。');
    }
    return { finish, dispatch };
  }

  /**
   * Declared message route plus the contract candidate set must both agree.
   */
  private assertMessageRouteAllowed(context: CommitContext, targetAgentId: string): void {
    const declared = context.declaredRoutes.some(
      (route) =>
        route.from === context.currentAgent.id &&
        route.kind === 'message' &&
        route.to === targetAgentId,
    );
    if (!declared) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.ROUTE_NOT_ALLOWED,
        '消息目标不在模板声明的合法连线之内。',
      );
    }
    const contractTargets = context.turnContract?.dispatch.targets.send_message;
    if (contractTargets !== undefined && !contractTargets.includes(targetAgentId)) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.ROUTE_NOT_ALLOWED,
        '消息目标不符合模板回合契约声明的发送对象。',
      );
    }
  }

  /** forward routes the input version along one declared artifact edge. */
  private assertForwardRouteAllowed(context: CommitContext, targetAgentId: string): void {
    const declared = context.declaredRoutes.some(
      (route) =>
        route.from === context.currentAgent.id &&
        route.kind === 'artifact' &&
        route.to === targetAgentId,
    );
    if (!declared) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.ROUTE_NOT_ALLOWED,
        '转发目标不在模板声明的合法产物连线之内。',
      );
    }
    const contractTargets =
      context.turnContract !== null && isBasicTurnContract(context.turnContract)
        ? context.turnContract.dispatch.targets.forward_input_version
        : undefined;
    if (contractTargets !== undefined && !contractTargets.includes(targetAgentId)) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.ROUTE_NOT_ALLOWED,
        '转发目标不符合模板回合契约声明的发送对象。',
      );
    }
  }

  /** Publish routing stays automatic along declared artifact routes. */
  private assertPublishRouteAllowed(context: CommitContext): void {
    const artifactRoutes = context.declaredRoutes.filter(
      (route) => route.from === context.currentAgent.id && route.kind === 'artifact',
    );
    if (artifactRoutes.length === 0) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.ROUTE_NOT_ALLOWED,
        '模板没有为该 Agent 声明任何产物连线，无法发布产物。',
      );
    }
    const contractTargets = context.turnContract?.dispatch.targets.publish_artifact;
    if (
      contractTargets !== undefined &&
      !artifactRoutes.some((route) => contractTargets.includes(route.to))
    ) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.ROUTE_NOT_ALLOWED,
        '发布目标不符合模板回合契约声明的发送对象。',
      );
    }
  }

  /**
   * annotate targets a file declared phase:annotate with producer==this agent
   * (spec §5.3), requires the input to carry an inputVersion, and is unique per
   * (version, file) across turns. File-belonging is enforced here as the
   * non-bypassable gate (the contract's `annotate.files` is the agent's allowed
   * set); uniqueness is scanned against committed `artifact_annotated` events,
   * self-excluding this turn's own planned annotation so a replay re-enters
   * cleanly instead of being rejected (spec §8).
   */
  private async assertAnnotateAllowed(
    context: CommitContext,
    annotate: Extract<ForgeAction, { type: 'annotate_artifact' }>,
  ): Promise<void> {
    const received = context.currentInputArtifact;
    if (received === null) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.ANNOTATE_VERSION_MISSING,
        '标注产物需要当前输入携带产物版本。',
      );
    }
    const contract = context.turnContract;
    const allowedFiles =
      contract !== null && isBasicTurnContract(contract) ? contract.annotate?.files : undefined;
    if (allowedFiles === undefined || !allowedFiles.includes(annotate.file)) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.ANNOTATE_FILE_NOT_ALLOWED,
        '标注文件不在本回合契约声明的可标注文件之内。',
      );
    }
    // Format contract (semantic audit P1, plan 2026-08-07): the annotation
    // body must carry a leading frontmatter block with `verdict: pass|reject`.
    // Structural only — the verdict never becomes a routing/delivery gate here.
    if (parseAnnotateVerdict(annotate.content) === null) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.ANNOTATE_FRONTMATTER_INVALID,
        '标注内容必须携带 frontmatter verdict: pass|reject。',
      );
    }
    // Uniqueness with self-exclusion (spec §8): a prior annotation of the same
    // (version, file) by a DIFFERENT turn is rejected before any write; this
    // turn's own prior annotation (replay) is self-excluded by turnId.
    const committed = await this.events.read(context.taskId);
    const foreignDuplicate = committed.some(
      (entry): boolean =>
        entry.event.type === 'artifact_annotated' &&
        entry.event.version === received.version &&
        entry.event.file === annotate.file &&
        entry.event.turnId !== context.turnId,
    );
    if (foreignDuplicate) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.ANNOTATE_DUPLICATE,
        '该产物版本的此文件已被标注，不可重复标注。',
      );
    }
  }

  /** Type/format declaration check (spec §6.4). */
  private assertDeclaration(
    context: CommitContext,
    format: 'markdown' | 'text',
  ): void {
    if (format !== context.finalOutput.format) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.FINAL_DECLARATION_MISMATCH,
        '最终产物的格式不符合模板声明。',
      );
    }
  }

  /**
   * The producer of a previously published artifact must be reachable to the
   * submitter through committed artifact routes (publish or forward), with
   * `agent_result.inputNodeId` connecting each input to the result that
   * consumed it (spec §7). A continue-synthesized input (spec §11.1 A) replaces
   * the superseded input for the same recipient, but the producer's committed
   * route still points at the voided node; the walk resolves such a route to
   * its synthesized replacement before comparing or hopping.
   */
  private async assertReachable(context: CommitContext, sourceNodeId: string): Promise<void> {
    const committed = await this.events.read(context.taskId);
    const producerEvent = committed.find(
      (entry) => entry.event.type === 'agent_result' && entry.event.id === sourceNodeId,
    );
    if (producerEvent === undefined || producerEvent.event.type !== 'agent_result') {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.FINAL_NOT_REACHABLE,
        '无法确认最终产物的合法来源。',
      );
    }
    const producer = producerEvent.event.node.agentId;
    if (producer === context.currentAgent.id) {
      return; // The submitter produced the version itself.
    }
    const supersedeResolution = this.buildSupersedeResolution(committed);
    const resolve = (nodeId: string): string => supersedeResolution.get(nodeId) ?? nodeId;
    // Walk committed artifact routes from the producer's result, hopping
    // through intermediate results (connected by inputNodeId), until the
    // submitter's current input is reached.
    const target = context.inputNodeId;
    let frontier = new Set<string>([sourceNodeId]);
    const visited = new Set<string>();
    for (let depth = 0; depth < 64 && frontier.size > 0; depth += 1) {
      const nextFrontier = new Set<string>();
      for (const fromNodeId of frontier) {
        if (fromNodeId === target) {
          return; // Reached the submitter's input node.
        }
        if (visited.has(fromNodeId)) {
          continue;
        }
        visited.add(fromNodeId);
        // Artifact routes originating at this result node.
        for (const entry of committed) {
          if (entry.event.type !== 'route_executed' || entry.event.route.kind !== 'artifact') {
            continue;
          }
          if (entry.event.route.fromNodeId !== fromNodeId) {
            continue;
          }
          const toNodeId = resolve(entry.event.route.toNodeId);
          if (toNodeId === target) {
            return;
          }
          // Hop: the input node's consumer result (inputNodeId === toNodeId).
          const consumerResult = committed.find(
            (candidate) =>
              candidate.event.type === 'agent_result' &&
              candidate.event.inputNodeId === toNodeId,
          );
          if (consumerResult !== undefined) {
            nextFrontier.add(consumerResult.event.id);
          }
        }
      }
      frontier = nextFrontier;
    }
    throw new CommitFailure(
      COMMIT_ERROR_CODES.FINAL_NOT_REACHABLE,
      '最终产物未经过已确认的产物交接抵达提交者。',
    );
  }

  /**
   * Maps a superseded `agent_input` id to the synthesized `agent_input` id
   * that replaced it for the same recipient (spec §11.1 A continue / §11.1 B
   * accept). The synthesized node is committed immediately after
   * `pending_inputs_superseded` (spec §11.6 commit order) and targets the same
   * agentId as the voided input. Accept-synthesized inputs skip reachability
   * (spec §7), so the map is only consulted by the continue path, but it is
   * built uniformly from the committed supersede/synthesize pairs.
   */
  private buildSupersedeResolution(committed: readonly CommittedEvent[]): Map<string, string> {
    const inputAgent = new Map<string, string>();
    for (const entry of committed) {
      if (entry.event.type === 'agent_input') {
        inputAgent.set(entry.event.id, entry.event.node.agentId);
      }
    }
    const supersededByAgent = new Map<string, string[]>();
    const map = new Map<string, string>();
    for (const entry of committed) {
      const event = entry.event;
      if (event.type === 'pending_inputs_superseded') {
        for (const id of event.supersededNodeIds) {
          const agent = inputAgent.get(id);
          if (agent === undefined) {
            continue;
          }
          const list = supersededByAgent.get(agent);
          if (list === undefined) {
            supersededByAgent.set(agent, [id]);
          } else if (!list.includes(id)) {
            list.push(id);
          }
        }
      } else if (event.type === 'agent_input' && event.id.startsWith('synthesize-')) {
        const agent = event.node.agentId;
        const list = supersededByAgent.get(agent);
        if (list !== undefined) {
          for (const id of list) {
            if (!map.has(id)) {
              map.set(id, event.id);
            }
          }
        }
      }
    }
    return map;
  }

  // ------------------------------------------------------------------
  // Commit phase: deterministic order, replay-safe, never overwriting.
  // ------------------------------------------------------------------

  private async commitValidated(
    context: CommitContext,
    validated: ValidatedActionSet,
  ): Promise<CommitResult> {
    const { taskId, turnId } = context;
    const dispatchKind: DispatchKind = this.dispatchKindFor(validated.dispatch);
    try {
      const beforeCommitted = await this.events.read(taskId);
      const committedById = new Map<string, CommittedEvent>(
        beforeCommitted.map((entry) => [entry.event.id, entry]),
      );
      let sequenceCounter = 0;
      for (const entry of beforeCommitted) {
        const event = entry.event;
        if ('node' in event) {
          sequenceCounter = Math.max(sequenceCounter, event.node.sequence);
        }
        if ('route' in event) {
          sequenceCounter = Math.max(sequenceCounter, event.route.sequence);
        }
      }
      const nextSequence = (): number => {
        sequenceCounter += 1;
        return sequenceCounter;
      };
      const at = (): string => this.clock().toISOString();
      const appendPlanned = async (id: string, build: () => TaskEvent): Promise<CommittedEvent> => {
        const existing = committedById.get(id);
        if (existing !== undefined) {
          return existing;
        }
        const committed = await this.events.append(taskId, build());
        committedById.set(id, committed);
        return committed;
      };

      const publishedVersions: number[] = [];
      const nextAgentIds: string[] = [];
      const pushNext = (agentId: string): void => {
        if (!nextAgentIds.includes(agentId)) {
          nextAgentIds.push(agentId);
        }
      };

      // 1. Agent result (carries inputNodeId + dispatchKind).
      const resultEventId = `${turnId}-result`;
      await appendPlanned(resultEventId, () => ({
        id: resultEventId,
        at: at(),
        type: 'agent_result',
        node: this.node(context.currentAgent.id, 'result', context.currentAgent.name, {
          sequence: nextSequence(),
          body: context.publicText,
          attemptCount: context.attemptCount,
        }),
        inputNodeId: context.inputNodeId,
        dispatchKind,
      }));

      // 2. Skill loads.
      for (const skillId of validated.loadSkills) {
        await this.skills.loadAuthorized(taskId, context.currentAgent.id, skillId);
      }

      // 3. Annotate files (operate turns): staging → event → committed.
      for (const annotate of validated.annotates) {
        const received = context.currentInputArtifact;
        if (received === null) {
          // Unreachable: validation already rejected annotate without a version.
          throw invalid('标注产物需要当前输入携带产物版本。');
        }
        const annotateEventId = `${turnId}-annotate-${annotate.file}`;
        const existing = committedById.get(annotateEventId);
        if (existing === undefined) {
          const annotated = await this.artifacts.annotate(taskId, {
            version: received.version,
            file: annotate.file,
            content: annotate.content,
            turnId,
            nodeId: resultEventId,
          });
          await appendPlanned(annotateEventId, () => ({
            id: annotateEventId,
            at: at(),
            type: 'artifact_annotated',
            version: annotated.version,
            file: annotated.file,
            contentHash: annotated.contentHash,
            turnId,
            nodeId: resultEventId,
          }));
        }
      }

      // 4. Production publication (production turns): publish the sealed
      // package and fan out along every declared artifact edge of the publisher.
      let publishedThisTurn: PublishedArtifact | null = null;
      const finish = validated.finish;
      const dispatch = validated.dispatch;
      if (dispatch.type === 'publish_artifact' && finish !== null) {
        publishedThisTurn = await this.publishSealedPackage({
          context,
          resultEventId,
          finish,
          committedById,
          nextSequence,
          at,
          appendPlanned,
        });
        publishedVersions.push(publishedThisTurn.version);
        const artifactRoutes = context.declaredRoutes.filter(
          (route) => route.from === context.currentAgent.id && route.kind === 'artifact',
        );
        for (const [index, route] of artifactRoutes.entries()) {
          await this.commitRoute({
            routeEventId: `${turnId}-artifact-route-${index}`,
            inputEventId: `${turnId}-artifact-input-${index}`,
            route,
            fromNodeId: resultEventId,
            node: this.node(route.to, 'input', this.agentName(context, route.to), {
              sequence: 0,
              body: finish.title ?? publishedThisTurn.title,
              attemptCount: 1,
              inputVersion: publishedThisTurn.version,
            }),
            nextSequence,
            at,
            appendPlanned,
          });
          pushNext(route.to);
        }
      }

      // 5. forward_input_version: route the input version along one artifact
      //    edge (zero-copy, deterministic node id).
      if (dispatch.type === 'forward_input_version') {
        const received = context.currentInputArtifact;
        if (received === null) {
          throw invalid('转发产物需要当前输入携带产物版本。');
        }
        const route = context.declaredRoutes.find(
          (candidate) =>
            candidate.from === context.currentAgent.id &&
            candidate.kind === 'artifact' &&
            candidate.to === dispatch.targetAgentId,
        );
        if (route === undefined) {
          throw invalid('转发路由与已声明连线不一致。');
        }
        await this.commitRoute({
          routeEventId: `${turnId}-forward-route-0`,
          inputEventId: `${turnId}-forward-input-0`,
          route,
          fromNodeId: resultEventId,
          // The forwarded input carries the version (zero-copy hand-off) but
          // NOT humanAuthorized: the accept exception is bound to the
          // synthesized submit input itself, never propagated by a model
          // forward action (spec §7.1 closedness).
          node: this.node(route.to, 'input', this.agentName(context, route.to), {
            sequence: 0,
            body: received.title,
            attemptCount: 1,
            inputVersion: received.version,
          }),
          nextSequence,
          at,
          appendPlanned,
        });
        pushNext(dispatch.targetAgentId);
      }

      // 6. send_message: the summary becomes the routed message body; the
      //    input version (if any) propagates to the target.
      if (dispatch.type === 'send_message') {
        const received = context.currentInputArtifact;
        const route = context.declaredRoutes.find(
          (candidate) =>
            candidate.from === context.currentAgent.id &&
            candidate.kind === 'message' &&
            candidate.to === dispatch.targetAgentId,
        );
        if (route === undefined) {
          throw invalid('消息路由与已声明连线不一致。');
        }
        await this.commitRoute({
          routeEventId: `${turnId}-message-route-0`,
          inputEventId: `${turnId}-message-input-0`,
          route,
          fromNodeId: resultEventId,
          node: this.node(route.to, 'input', this.agentName(context, route.to), {
            sequence: 0,
            body: dispatch.summary,
            attemptCount: 1,
            inputVersion: received?.version ?? null,
          }),
          nextSequence,
          at,
          appendPlanned,
        });
        pushNext(dispatch.targetAgentId);
      }

      // 7. Human request or final submission (mutually exclusive, at most one).
      let waitingHuman = false;
      let taskCompleted = false;
      if (dispatch.type === 'request_human_input') {
        const question = dispatch.question;
        await appendPlanned(`${turnId}-human-requested`, () => ({
          id: `${turnId}-human-requested`,
          at: at(),
          type: 'human_requested',
          node: this.node(context.currentAgent.id, 'human_request', context.currentAgent.name, {
            sequence: nextSequence(),
            body: question,
            attemptCount: context.attemptCount,
          }),
          question,
          source: 'agent_request',
        }));
        waitingHuman = true;
      }
      if (dispatch.type === 'submit_final_artifact') {
        const received = context.currentInputArtifact;
        if (received === null) {
          throw new CommitFailure(
            COMMIT_ERROR_CODES.FINAL_ARTIFACT_NOT_FOUND,
            '当前输入节点没有携带可提交的产物。',
          );
        }
        await appendPlanned(`${turnId}-final`, () => ({
          id: `${turnId}-final`,
          at: at(),
          type: 'final_submission_accepted',
          artifactId: received.artifactId,
          version: received.version,
        }));
        taskCompleted = true;
      }

      const afterCommitted = await this.events.read(taskId);
      const beforeIds = new Set(beforeCommitted.map((entry) => entry.event.id));
      const turnPrefix = `${turnId}-`;
      const committedEvents: CommittedEventMeta[] = afterCommitted
        .filter(
          (entry) => !beforeIds.has(entry.event.id) || entry.event.id.startsWith(turnPrefix),
        )
        .map((entry) => ({
          id: entry.event.id,
          type: entry.event.type,
          sequence: entry.sequence,
          replayed: beforeIds.has(entry.event.id),
        }));

      return {
        committedEvents,
        publishedVersions,
        taskCompleted,
        waitingHuman,
        nextAgentIds,
        phase: this.phaseOutcome(dispatch, waitingHuman, publishedThisTurn),
      };
    } catch (error) {
      await this.recordCommitFailure(context, error);
      if (error instanceof RuntimeFailure || error instanceof CommitFailure) {
        throw error;
      }
      throw new CommitFailure(
        COMMIT_ERROR_CODES.COMMIT_INTERRUPTED,
        '生产动作提交中断，已确认的记录均已保留。',
      );
    }
  }

  /** Maps a dispatch action to its `dispatchKind` (spec §8.2). */
  private dispatchKindFor(dispatch: ValidatedActionSet['dispatch']): DispatchKind {
    switch (dispatch.type) {
      case 'publish_artifact':
        return 'publish';
      case 'forward_input_version':
        return 'forward';
      case 'send_message':
        return 'send';
      case 'submit_final_artifact':
        return 'submit';
      case 'request_human_input':
        return 'human';
    }
  }

  /** Publishes the sealed package: artifact files first, then the event. */
  private async publishSealedPackage(parts: {
    context: CommitContext;
    resultEventId: string;
    finish: NonNullable<ValidatedActionSet['finish']>;
    committedById: Map<string, CommittedEvent>;
    nextSequence(): number;
    at(): string;
    appendPlanned(id: string, build: () => TaskEvent): Promise<CommittedEvent>;
  }): Promise<PublishedArtifact> {
    const { context, resultEventId, finish } = parts;
    const eventId = `${context.turnId}-artifact-1`;
    const existing = parts.committedById.get(eventId);
    if (existing !== undefined && existing.event.type === 'artifact_published') {
      const readBack = await this.artifacts.read(context.taskId, existing.event.artifact.version);
      return {
        artifactId: readBack.meta.id,
        version: readBack.meta.version,
        title: readBack.meta.title,
      };
    }
    const result = await this.artifacts.publish(context.taskId, {
      title: finish.title ?? '未命名产物',
      files: finish.files.map((file) => ({ name: file.name, content: file.content ?? '' })),
      sourceNodeId: resultEventId,
      format: finish.format,
    });
    const artifact: PublishedArtifact = {
      artifactId: result.id,
      version: result.version,
      title: finish.title ?? result.title,
    };
    await parts.appendPlanned(eventId, () => ({
      id: eventId,
      at: parts.at(),
      type: 'artifact_published',
      artifact: {
        version: artifact.version,
        title: artifact.title,
        sourceNodeId: resultEventId,
        format: finish.format,
        files: result.files,
        artifactType: finish.artifactType,
        artifactId: artifact.artifactId,
      },
    }));
    return artifact;
  }

  /** Display-only phase summary of a successful commit (spec §7.4). */
  private phaseOutcome(
    dispatch: ValidatedActionSet['dispatch'],
    waitingHuman: boolean,
    published: PublishedArtifact | null,
  ): TurnTracePhase {
    const dispatchAction: DispatchActionName = dispatch.type;
    let message: string | null = null;
    if (dispatch.type === 'publish_artifact' && published !== null) {
      message = `已发布产物「${published.title}」v${published.version}`;
    }
    return {
      state: waitingHuman ? 'waiting_human' : 'dispatched',
      dispatchAction,
      target:
        dispatch.type === 'send_message' || dispatch.type === 'forward_input_version'
          ? dispatch.targetAgentId
          : null,
      message,
    };
  }

  /** Route event first, then the target agent's fresh input node. */
  private async commitRoute(
    parts: {
      routeEventId: string;
      inputEventId: string;
      route: RouteDeclaration;
      fromNodeId: string;
      node: EventNode;
      nextSequence(): number;
      at(): string;
      appendPlanned(id: string, build: () => TaskEvent): Promise<CommittedEvent>;
    },
  ): Promise<void> {
    const routeSequence = parts.nextSequence();
    const inputSequence = parts.nextSequence();
    await parts.appendPlanned(parts.routeEventId, () => ({
      id: parts.routeEventId,
      at: parts.at(),
      type: 'route_executed',
      route: {
        sequence: routeSequence,
        fromNodeId: parts.fromNodeId,
        toNodeId: parts.inputEventId,
        kind: parts.route.kind,
        label: parts.route.label,
      },
    }));
    await parts.appendPlanned(parts.inputEventId, () => ({
      id: parts.inputEventId,
      at: parts.at(),
      type: 'agent_input',
      node: { ...parts.node, sequence: inputSequence },
    }));
  }

  /**
   * Appends the public node failure marking an interrupted commit. The first
   * occurrence owns `<turnId>-commit-failed`; a re-entered interrupted commit
   * that fails again appends a numbered marker so the fresh failure still
   * parks the projection (append-only history is never rewritten).
   */
  private async recordCommitFailure(context: CommitContext, error: unknown): Promise<void> {
    const failureId = `${context.turnId}-commit-failed`;
    try {
      const committed = await this.events.read(context.taskId);
      const priorMarkers = committed.filter(
        (entry) => entry.event.id === failureId || entry.event.id.startsWith(`${failureId}-`),
      ).length;
      const markerId = priorMarkers === 0 ? failureId : `${failureId}-${priorMarkers + 1}`;
      const message =
        error instanceof RuntimeFailure || error instanceof CommitFailure
          ? error.message
          : '生产动作提交中断，当前节点标记为失败。';
      await this.events.append(context.taskId, {
        id: markerId,
        at: this.clock().toISOString(),
        type: 'agent_attempt_failed',
        nodeId: context.inputNodeId,
        message,
        retryable: false,
      });
    } catch {
      // The failure event is best-effort; the original error still throws.
    }
  }

  /**
   * Builds a schema-shaped confirmed node owned by the committer. The
   * committer NEVER sets `humanAuthorized` (spec §7.1 closedness): the field is
   * written only by the scheduler's accept synthesis path (directly via the
   * event store, not through this constructor), and read here from the input
   * node via `currentInputArtifact`.
   */
  private node(
    agentId: string,
    kind: EventNode['kind'],
    title: string,
    parts: {
      sequence: number;
      body: string;
      attemptCount: number;
      inputVersion?: number | null;
    },
  ): EventNode {
    return {
      sequence: parts.sequence,
      agentId,
      kind,
      title,
      body: parts.body,
      status: 'confirmed',
      attemptCount: parts.attemptCount,
      inputVersion: parts.inputVersion ?? null,
    };
  }

  private agentName(context: CommitContext, agentId: string): string {
    return context.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  }
}

// Re-export limits so existing imports keep compiling.
export { FORGE_ACTION_LIMITS };
