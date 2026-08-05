/**
 * Legal action commit and system final output (plan Phase C Task 3 Steps
 * 4/5/6; rebuilt for the production/dispatch turn contract by plan
 * 2026-08-04 Task 4, spec §4/§5.3/§6.4).
 *
 * The committer is the only production event producer. It validates the
 * complete buffered action set BEFORE any write — phase order and
 * cardinality of the turn contract, action fields (reusing
 * `validateForgeAction`), contract conformance, agent authorization,
 * declared message/artifact routes, human-request exclusivity and the
 * final-output declaration — and rejects any invalid set with a typed,
 * non-retryable `CommitFailure` while writing nothing.
 *
 * Turn contract validation (spec §5.3, frozen decision 1):
 * - exactly one `finish_production` seals exactly one production package,
 *   followed by exactly one dispatch action referencing it with
 *   `productionPackageRef: 'current'`; `request_human_input` may instead
 *   interrupt directly as the SOLE first action without any package;
 * - missing finish or missing dispatch -> `AGENT_PHASE_INCOMPLETE`;
 * - dispatch before finish, production work after finish or a second
 *   finish -> `AGENT_PHASE_ORDER_INVALID`;
 * - more than one dispatch action -> `AGENT_DISPATCH_CARDINALITY_INVALID`.
 * These are non-retryable; the TaskRunner records them as attempt failures
 * so the task parks visibly and never stays silently `running`.
 *
 * Sealed-package semantics (frozen decision 5): `publish_artifact`
 * publishes the sealed package using the finish metadata; `send_message`
 * delivers the sealed text as the routed message body;
 * `submit_final_artifact` resolves through the package — a
 * `current_input_artifact` package submits the received artifact id and
 * version (keeping the reachability/declaration checks), any other package
 * is published first and the fresh version is submitted. Dispatch actions
 * carry no content or artifact metadata of their own.
 *
 * A valid set commits in one deterministic order: agent result → skill
 * loads → artifact files + `artifact_published` events → routes with their
 * target input nodes → human request or final submission. Every event id,
 * version and timestamp is system-generated (iron rule 2); ids derive from
 * the Turn id so an interrupted commit replays committed items instead of
 * duplicating them.
 *
 * Final output is decided by the system alone (spec §6.4): the artifact
 * must match the declared format (and type, when the package carries one),
 * be submitted by a declared submitter and be reachable through committed
 * execution. Natural-language claims and ordinary publishes never complete
 * a task.
 *
 * No business vocabulary lives here (iron rule 1).
 */
import { createHash } from 'node:crypto';
import type { TurnTracePhase } from '../../shared/contracts';
import type { ArtifactStore } from '../storage/artifact-store';
import type { CommittedEvent, EventStore } from '../storage/event-store';
import type { EventNode, TaskEvent } from '../storage/task-events';
import type { FrozenAgentConfig, TurnContract } from '../template/template-schema';
import { RuntimeFailure } from './agent-runtime';
import {
  FORGE_ACTION_LIMITS,
  ForgeActionValidationError,
  validateForgeAction,
  type DispatchActionName,
  type ForgeAction,
  type ProductionSource,
} from './forge-actions';
import type { SkillService } from './skill-service';

/** Stable committer error codes owned by this module. */
export const COMMIT_ERROR_CODES = {
  /** The buffered action set exceeds the per-Turn limit. */
  TOO_MANY_ACTIONS: 'TOO_MANY_ACTIONS',
  /** The action set is internally inconsistent (package/context mismatch). */
  ACTION_SET_INVALID: 'ACTION_SET_INVALID',
  /** A load_skill targets a Skill not authorized to the current agent. */
  SKILL_NOT_AUTHORIZED: 'SKILL_NOT_AUTHORIZED',
  /** A message/artifact route is not declared in the frozen snapshot. */
  ROUTE_NOT_ALLOWED: 'ROUTE_NOT_ALLOWED',
  /** The final reference resolves to no artifact. */
  FINAL_ARTIFACT_NOT_FOUND: 'FINAL_ARTIFACT_NOT_FOUND',
  /** The final artifact misses the declared type/format. */
  FINAL_DECLARATION_MISMATCH: 'FINAL_DECLARATION_MISMATCH',
  /** The submitting agent is not a declared final submitter. */
  FINAL_SUBMITTER_NOT_ALLOWED: 'FINAL_SUBMITTER_NOT_ALLOWED',
  /** The final artifact is not reachable through committed execution. */
  FINAL_NOT_REACHABLE: 'FINAL_NOT_REACHABLE',
  /** The commit context carries an unsafe or malformed identifier. */
  COMMIT_CONTEXT_INVALID: 'COMMIT_CONTEXT_INVALID',
  /** A write failed mid-plan; committed items were preserved. */
  COMMIT_INTERRUPTED: 'COMMIT_INTERRUPTED',
  /** The turn never sealed its production package, or never dispatched it. */
  AGENT_PHASE_INCOMPLETE: 'AGENT_PHASE_INCOMPLETE',
  /** A dispatch ran before sealing, or production work continued after it. */
  AGENT_PHASE_ORDER_INVALID: 'AGENT_PHASE_ORDER_INVALID',
  /** The turn attempted more than one dispatch action. */
  AGENT_DISPATCH_CARDINALITY_INVALID: 'AGENT_DISPATCH_CARDINALITY_INVALID',
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

/** The one artifact a sealed package can publish (built at commit time). */
export interface ProvisionalArtifact {
  artifactType: string;
  title: string;
  format: 'markdown' | 'text';
  content: string;
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
 * Identity of the artifact received with the current input node (frozen
 * decision 3): the platform resolves `current_input_artifact` exclusively
 * through this value — models never supply versions or `latest`.
 */
export interface CurrentInputArtifact {
  artifactId: string;
  version: number;
  title: string;
  format: 'markdown' | 'text';
  content: string;
  /** The result node that originally produced the artifact. */
  sourceNodeId: string;
}

/**
 * Everything one Turn's commit needs, assembled by the runner from the
 * frozen snapshot and the buffered proposals (plan 2026-08-04 Task 4). The
 * provisional artifact table is derived from the sealed package during
 * validation; it is never supplied by the model.
 */
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
  /** True when the item was already committed by an earlier attempt. */
  replayed: boolean;
}

/** Outcome the Task 4 runner consumes to decide the next step. */
export interface CommitResult {
  committedEvents: CommittedEventMeta[];
  publishedVersions: number[];
  taskCompleted: boolean;
  waitingHuman: boolean;
  nextAgentIds: string[];
  /**
   * Display-only final phase summary of the committed turn (spec §7.4,
   * frozen decision 6): derived from the validated action set, never from
   * model text, and never authoritative for delivery or completion.
   */
  phase: TurnTracePhase;
}

export interface ActionCommitterOptions {
  events: EventStore;
  artifacts: ArtifactStore;
  skills: SkillService;
  /** Injectable clock for deterministic tests; defaults to system time. */
  clock?: () => Date;
}

/**
 * The sealed production package one dispatch action consumes (frozen
 * decision 5). Built exclusively from the validated `finish_production`
 * action plus platform-resolved content; dispatch actions never contribute
 * content or metadata.
 */
interface SealedPackage {
  source: ProductionSource;
  content: string;
  format: 'markdown' | 'text';
  /** Publication metadata; null for packages only routed as messages. */
  artifactType: string | null;
  title: string | null;
}

/** A finish_production action whose workspace content was resolved by the runner. */
export type ResolvedFinishProduction = Extract<ForgeAction, { source: 'workspace_file' }> & {
  /** Platform-resolved file content; models can never propose this field. */
  content: string;
};

/** Actions the committer accepts: strict model shapes plus resolved finishes. */
export type CommittableAction = ForgeAction | ResolvedFinishProduction;

type FinishAction = Extract<ForgeAction, { type: 'finish_production' }> | ResolvedFinishProduction;

type DispatchActionType =
  | Extract<CommittableAction, { type: 'send_message' }>
  | Extract<CommittableAction, { type: 'publish_artifact' }>
  | Extract<CommittableAction, { type: 'submit_final_artifact' }>
  | Extract<CommittableAction, { type: 'request_human_input' }>;

interface ValidatedActionSet {
  loadSkills: string[];
  /** The one sealed finish action; null only for a direct human interrupt. */
  finish: FinishAction | null;
  /** The one dispatch action (the interrupt counts as one). */
  dispatch: DispatchActionType;
  /** The sealed package; null only for a direct human interrupt. */
  package: SealedPackage | null;
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

const DISPATCH_ACTION_TYPES: ReadonlySet<CommittableAction['type']> = new Set([
  'send_message',
  'publish_artifact',
  'submit_final_artifact',
  'request_human_input',
]);

/** Type guard the phase gate uses (set membership alone never narrows). */
function isDispatchAction(action: CommittableAction): action is DispatchActionType {
  return DISPATCH_ACTION_TYPES.has(action.type);
}

/**
 * Parses one raw action at the commit boundary: strict model shapes go
 * through `validateForgeAction`; the one platform-resolved shape — a
 * `finish_production` whose workspace file the runner already resolved —
 * additionally carries the bounded resolved content.
 */
function parseCommittableAction(raw: unknown): CommittableAction {
  if (typeof raw === 'object' && raw !== null) {
    const candidate = raw as Record<string, unknown>;
    if (candidate.type === 'finish_production' && candidate.source === 'workspace_file') {
      const { content, ...strictShape } = candidate;
      let strict: ForgeAction;
      try {
        strict = validateForgeAction(strictShape);
      } catch (error) {
        if (error instanceof ForgeActionValidationError) {
          throw new CommitFailure(error.code, error.message);
        }
        throw error;
      }
      if (
        typeof content !== 'string' ||
        content.length === 0 ||
        content.length > FORGE_ACTION_LIMITS.content
      ) {
        throw invalid('finish_production 的工作区内容未解析或超出大小限制。');
      }
      return { ...strict, content } as ResolvedFinishProduction;
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

  private readonly clock: () => Date;

  constructor(options: ActionCommitterOptions) {
    this.events = options.events;
    this.artifacts = options.artifacts;
    this.skills = options.skills;
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

    // Contract conformance + sealed package (null only for the direct interrupt).
    const sealedPackage = this.sealPackage(context, finish, dispatch);

    // Publication metadata belongs to the sealed package (frozen decision 5):
    // any dispatch that publishes must find artifactType and title on it.
    const needsPublication =
      sealedPackage !== null &&
      (dispatch.type === 'publish_artifact' ||
        (dispatch.type === 'submit_final_artifact' &&
          sealedPackage.source !== 'current_input_artifact'));
    if (needsPublication && sealedPackage !== null) {
      if (sealedPackage.artifactType === null || sealedPackage.title === null) {
        throw invalid('发布或提交产物需要封存包携带 artifactType 与 title 元数据。');
      }
    }

    // Route and contract-target validation of the dispatch action.
    if (dispatch.type === 'send_message') {
      this.assertMessageRouteAllowed(context, dispatch.targetAgentId);
    }
    if (dispatch.type === 'publish_artifact') {
      this.assertPublishRouteAllowed(context);
    }

    // Final declaration checks resolve before any write; the reachability of
    // a received artifact is part of the validation stage too (review F2),
    // so an illegitimate producer rejects the set with zero writes instead
    // of a half commit that already recorded the agent result.
    if (dispatch.type === 'submit_final_artifact' && sealedPackage !== null) {
      if (sealedPackage.source === 'current_input_artifact') {
        const received = context.currentInputArtifact;
        if (received === null) {
          // Unreachable: sealPackage rejects packages without a received artifact.
          throw new CommitFailure(
            COMMIT_ERROR_CODES.FINAL_ARTIFACT_NOT_FOUND,
            '当前输入节点没有携带可提交的产物。',
          );
        }
        this.assertDeclaration(context, received.format, null);
        await this.assertReachable(context, received.sourceNodeId);
      } else {
        this.assertDeclaration(context, sealedPackage.format, sealedPackage.artifactType);
      }
    }

    return { loadSkills, finish, dispatch, package: sealedPackage };
  }

  /**
   * The non-bypassable phase gate (spec §5.3, frozen decisions 1/4):
   * production -> sealed -> exactly one dispatch, with `request_human_input`
   * as the only direct interrupt (sole first action, nothing after it).
   */
  private validatePhaseSequence(parsed: readonly CommittableAction[]): {
    finish: FinishAction | null;
    dispatch: DispatchActionType;
  } {
    if (parsed.length === 0) {
      throw phaseIncomplete('本回合只有文字输出，没有封存生产结果，也没有完成发送。');
    }

    // Direct human interrupt: exactly one action, no sealed package needed.
    if (parsed[0].type === 'request_human_input') {
      if (parsed.length > 1) {
        throw dispatchCardinalityInvalid('直接人工中断之后不得再有其他动作。');
      }
      return { finish: null, dispatch: parsed[0] };
    }

    let finish: FinishAction | null = null;
    let dispatch: DispatchActionType | null = null;
    for (const [index, action] of parsed.entries()) {
      if (dispatch !== null) {
        throw dispatchCardinalityInvalid('一个回合只能执行一个发送动作。');
      }
      if (action.type === 'load_skill') {
        if (finish !== null) {
          throw phaseOrderInvalid('封存生产包之后不能再加载技能或执行制作动作。');
        }
        continue;
      }
      if (action.type === 'finish_production') {
        if (finish !== null) {
          throw phaseOrderInvalid('一个回合只能封存一次生产包。');
        }
        finish = action;
        continue;
      }
      if (isDispatchAction(action)) {
        if (action.type === 'request_human_input' && finish === null) {
          // A human interrupt after production work began but before sealing
          // is only legal as the very first action (frozen decision 4).
          throw phaseOrderInvalid('人工中断只能作为回合第一个动作，或先封存生产包再提交。');
        }
        if (finish === null) {
          throw phaseOrderInvalid('发送动作必须先调用 finish_production 封存生产包。');
        }
        dispatch = action;
        continue;
      }
      // Exhaustiveness guard: the registry and this gate must stay aligned.
      const unreachable: never = action;
      throw invalid(`无法识别的生产动作 ${String((unreachable as { type?: unknown }).type)}。`);
    }

    if (finish === null) {
      throw phaseIncomplete('本回合没有调用 finish_production 封存生产结果。');
    }
    if (dispatch === null) {
      throw phaseIncomplete('生产包已封存，但本回合没有执行任何发送动作。');
    }
    return { finish, dispatch };
  }

  /**
   * Contract conformance of the finish/dispatch pair plus the sealed package
   * build (spec §6, frozen decisions 2/3/5). Returns null only for the
   * direct human interrupt.
   */
  private sealPackage(
    context: CommitContext,
    finish: FinishAction | null,
    dispatch: DispatchActionType,
  ): SealedPackage | null {
    if (dispatch.type === 'request_human_input' && finish === null) {
      return null; // Direct interrupt: no package required.
    }
    const contract = context.turnContract;
    if (contract === null) {
      throw invalid('任务冻结快照缺少当前回合契约，无法提交生产动作。');
    }
    if (finish === null) {
      // Unreachable: validatePhaseSequence requires a finish before dispatch.
      throw phaseIncomplete('本回合没有调用 finish_production 封存生产结果。');
    }

    if (!contract.production.output.sources.includes(finish.source)) {
      throw invalid(`模板契约不允许使用 ${finish.source} 来源封存生产结果。`);
    }
    if (finish.source !== 'current_input_artifact') {
      if (!contract.production.output.formats.includes(finish.format)) {
        throw invalid(`模板契约不允许使用 ${finish.format} 格式封存生产结果。`);
      }
    }
    if (dispatch.type !== 'request_human_input') {
      if (!contract.dispatch.allowedActions.includes(dispatch.type)) {
        throw invalid(`模板契约不允许使用 ${dispatch.type} 发送意图。`);
      }
    }

    if (finish.source === 'current_input_artifact') {
      const received = context.currentInputArtifact;
      if (received === null) {
        throw invalid('当前输入节点没有携带产物，无法引用 current_input_artifact。');
      }
      // Format/metadata inherit from the received artifact; the model never
      // supplies versions (frozen decision 3).
      return {
        source: 'current_input_artifact',
        content: received.content,
        format: received.format,
        artifactType: null,
        title: received.title,
      };
    }

    if (finish.source === 'inline') {
      return {
        source: 'inline',
        content: finish.content,
        format: finish.format,
        artifactType: finish.artifactType,
        title: finish.title,
      };
    }
    // workspace_file: the runner resolves the file strictly before commit.
    if (!('content' in finish) || typeof finish.content !== 'string' || finish.content.length === 0) {
      // Permanent unreachable defense line (frozen decision 5): resolution
      // happens platform-side, or the attempt already failed.
      throw invalid('finish_production 的工作区内容未解析。');
    }
    return {
      source: 'workspace_file',
      content: finish.content,
      format: finish.format,
      artifactType: finish.artifactType,
      title: finish.title,
    };
  }

  /** Declared message route plus the contract target must both agree. */
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
    const contractTarget = context.turnContract?.dispatch.targets.send_message;
    if (contractTarget !== undefined && contractTarget !== targetAgentId) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.ROUTE_NOT_ALLOWED,
        '消息目标不符合模板回合契约声明的发送对象。',
      );
    }
  }

  /**
   * Publish routing stays automatic along every declared artifact route of
   * the publisher; the contract target (when declared) must be one of them.
   */
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
    const contractTarget = context.turnContract?.dispatch.targets.publish_artifact;
    if (
      contractTarget !== undefined &&
      !artifactRoutes.some((route) => route.to === contractTarget)
    ) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.ROUTE_NOT_ALLOWED,
        '发布目标不符合模板回合契约声明的发送对象。',
      );
    }
  }

  /** Type is only declared for package metadata (published events carry format only). */
  private assertDeclaration(
    context: CommitContext,
    format: 'markdown' | 'text',
    artifactType: string | null,
  ): void {
    if (format !== context.finalOutput.format) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.FINAL_DECLARATION_MISMATCH,
        '最终产物的格式不符合模板声明。',
      );
    }
    if (artifactType !== null && artifactType !== context.finalOutput.name) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.FINAL_DECLARATION_MISMATCH,
        '最终产物的类型不符合模板声明。',
      );
    }
  }

  /**
   * The producer of a previously published artifact must be the submitter
   * itself or must have handed the artifact over through a declared,
   * committed artifact route ending at the submitter.
   */
  private async assertReachable(context: CommitContext, sourceNodeId: string): Promise<void> {
    const committed = await this.events.read(context.taskId);
    const producerEvent = committed.find(
      (entry) =>
        entry.event.type === 'agent_result' &&
        entry.event.id === sourceNodeId,
    );
    if (producerEvent === undefined || producerEvent.event.type !== 'agent_result') {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.FINAL_NOT_REACHABLE,
        '无法确认最终产物的合法来源。',
      );
    }
    const producer = producerEvent.event.node.agentId;
    if (producer === context.currentAgent.id) {
      return;
    }
    const declaredHandOff = context.declaredRoutes.some(
      (route) =>
        route.from === producer &&
        route.to === context.currentAgent.id &&
        route.kind === 'artifact',
    );
    if (!declaredHandOff) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.FINAL_NOT_REACHABLE,
        '最终产物的来源与提交者之间没有模板声明的产物连线。',
      );
    }
    const committedHandOff = committed.some((entry) => {
      const event = entry.event;
      if (event.type !== 'route_executed' || event.route.kind !== 'artifact') {
        return false;
      }
      if (event.route.fromNodeId !== sourceNodeId) {
        return false;
      }
      const route = event.route;
      const target = committed.find(
        (candidate) =>
          candidate.event.type === 'agent_input' &&
          candidate.event.id === route.toNodeId,
      );
      return (
        target !== undefined &&
        target.event.type === 'agent_input' &&
        target.event.node.agentId === context.currentAgent.id
      );
    });
    if (!committedHandOff) {
      throw new CommitFailure(
        COMMIT_ERROR_CODES.FINAL_NOT_REACHABLE,
        '最终产物未经过已确认的产物交接抵达提交者。',
      );
    }
  }

  // ------------------------------------------------------------------
  // Commit phase: deterministic order, replay-safe, never overwriting.
  // ------------------------------------------------------------------

  private async commitValidated(
    context: CommitContext,
    validated: ValidatedActionSet,
  ): Promise<CommitResult> {
    const { taskId, turnId } = context;
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
          return existing; // Replayed from an earlier attempt; never rewritten.
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

      // 1. Agent result (public text node).
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
      }));

      // 2. Skill loads (the service appends `skill_loaded` on first load).
      for (const skillId of validated.loadSkills) {
        await this.skills.loadAuthorized(taskId, context.currentAgent.id, skillId);
      }

      // 3. Sealed-package publication: publish_artifact always publishes;
      // submit_final_artifact publishes unless the package is the received
      // input artifact itself (that version already exists).
      const sealedPackage = validated.package;
      const dispatch = validated.dispatch;
      let publishedThisTurn: PublishedArtifact | null = null;
      const needsPublication =
        sealedPackage !== null &&
        (dispatch.type === 'publish_artifact' ||
          (dispatch.type === 'submit_final_artifact' &&
            sealedPackage.source !== 'current_input_artifact'));
      if (needsPublication && sealedPackage !== null) {
        if (sealedPackage.artifactType === null || sealedPackage.title === null) {
          throw invalid('发布或提交产物需要封存包携带 artifactType 与 title 元数据。');
        }
        publishedThisTurn = await this.publishSealedPackage({
          context,
          resultEventId,
          sealedPackage: {
            artifactType: sealedPackage.artifactType,
            title: sealedPackage.title,
            format: sealedPackage.format,
            content: sealedPackage.content,
          },
          committedById,
          nextSequence,
          at,
          appendPlanned,
        });
        publishedVersions.push(publishedThisTurn.version);

        // Artifact hand-offs along declared artifact routes of the publisher.
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
              sequence: 0, // Assigned at build time below.
              body: sealedPackage.title,
              attemptCount: 1,
              artifactVersion: publishedThisTurn.version,
            }),
            nextSequence,
            at,
            appendPlanned,
          });
          pushNext(route.to);
        }
      }

      // 4. Message route: the sealed text becomes the routed message body.
      if (dispatch.type === 'send_message' && sealedPackage !== null) {
        const route = context.declaredRoutes.find(
          (candidate) =>
            candidate.from === context.currentAgent.id &&
            candidate.kind === 'message' &&
            candidate.to === dispatch.targetAgentId,
        );
        if (route === undefined) {
          // Unreachable: validation already proved the route is declared.
          throw invalid('消息路由与已声明连线不一致。');
        }
        await this.commitRoute({
          routeEventId: `${turnId}-message-route-0`,
          inputEventId: `${turnId}-message-input-0`,
          route,
          fromNodeId: resultEventId,
          node: this.node(route.to, 'input', this.agentName(context, route.to), {
            sequence: 0,
            body: sealedPackage.content,
            attemptCount: 1,
          }),
          nextSequence,
          at,
          appendPlanned,
        });
        pushNext(dispatch.targetAgentId);
      }

      // 5. Human request or final submission (mutually exclusive, at most one).
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
        }));
        waitingHuman = true;
      }
      if (dispatch.type === 'submit_final_artifact' && sealedPackage !== null) {
        let artifactId: string;
        let version: number;
        if (sealedPackage.source === 'current_input_artifact') {
          const received = context.currentInputArtifact;
          if (received === null) {
            // Unreachable: sealPackage rejects packages without a received artifact.
            throw new CommitFailure(
              COMMIT_ERROR_CODES.FINAL_ARTIFACT_NOT_FOUND,
              '当前输入节点没有携带可提交的产物。',
            );
          }
          // Reachability was already proven in the validation stage (review
          // F2); the commit phase only consumes the validated result.
          artifactId = received.artifactId;
          version = received.version;
        } else {
          if (publishedThisTurn === null) {
            // Unreachable: publication happens strictly before submission.
            throw new CommitFailure(
              COMMIT_ERROR_CODES.FINAL_ARTIFACT_NOT_FOUND,
              '最终提交未找到本回合发布的产物。',
            );
          }
          artifactId = publishedThisTurn.artifactId;
          version = publishedThisTurn.version;
        }
        await appendPlanned(`${turnId}-final`, () => ({
          id: `${turnId}-final`,
          at: at(),
          type: 'final_submission_accepted',
          artifactId,
          version,
        }));
        taskCompleted = true;
      }

      // Metadata: everything this commit added or replayed, in event order.
      // Plan-owned ids all start with the Turn id prefix; anything else new
      // is a `skill_loaded` event appended by the SkillService mid-commit.
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

  /** Publishes the sealed package: artifact file first, then the event. */
  private async publishSealedPackage(parts: {
    context: CommitContext;
    resultEventId: string;
    sealedPackage: ProvisionalArtifact;
    committedById: Map<string, CommittedEvent>;
    nextSequence(): number;
    at(): string;
    appendPlanned(id: string, build: () => TaskEvent): Promise<CommittedEvent>;
  }): Promise<PublishedArtifact> {
    const { context, resultEventId, sealedPackage } = parts;
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
      title: sealedPackage.title,
      content: sealedPackage.content,
      sourceNodeId: resultEventId,
      format: sealedPackage.format,
    });
    const artifact: PublishedArtifact = {
      artifactId: result.id,
      version: result.version,
      title: sealedPackage.title,
    };
    await parts.appendPlanned(eventId, () => ({
      id: eventId,
      at: parts.at(),
      type: 'artifact_published',
      artifact: {
        version: artifact.version,
        title: sealedPackage.title,
        sourceNodeId: resultEventId,
        format: sealedPackage.format,
        contentHash: sha256(sealedPackage.content),
      },
    }));
    return artifact;
  }

  /**
   * Display-only phase summary of a successful commit (spec §7.4). The
   * publish branch names the published artifact (sealed-package title plus
   * the system-assigned version, review F5) so the dialog never renders a
   * bare "dispatched" — enrichment only, never authoritative.
   */
  private phaseOutcome(
    dispatch: DispatchActionType,
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
      target: dispatch.type === 'send_message' ? dispatch.targetAgentId : null,
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
   * occurrence owns `<turnId>-commit-failed`; an interrupted commit that is
   * re-entered under the same turn id (review F4) and fails again appends a
   * numbered marker (`<turnId>-commit-failed-2`, `-3`, …) so the fresh
   * failure still parks the projection after a lifecycle event — append-only
   * history is never rewritten, and earlier markers are never duplicated.
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

  /** Builds a schema-shaped confirmed node owned by the committer. */
  private node(
    agentId: string,
    kind: EventNode['kind'],
    title: string,
    parts: {
      sequence: number;
      body: string;
      attemptCount: number;
      artifactVersion?: number | null;
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
      artifactVersion: parts.artifactVersion ?? null,
    };
  }

  private agentName(context: CommitContext, agentId: string): string {
    return context.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  }
}
