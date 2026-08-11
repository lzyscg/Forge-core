/**
 * Thin constrained Pi AgentRuntime adapter (plan Phase C Task 2).
 *
 * Implements the frozen Task 1 `AgentRuntime` over the Pi 0.82 public SDK:
 *
 * - every `run` creates a FRESH in-memory Pi session keyed `<taskId>:<agentId>`
 *   (`SessionManager.inMemory`, never persisted — Forge events are the only
 *   recovery source);
 * - the frozen public history is replayed in chronological order before each
 *   Turn (public messages only — never hidden thinking), and available/loaded
 *   skills are injected as Forge-owned prompt messages;
 * - Pi built-in tools, extensions, skills, prompt templates, themes and
 *   context files are disabled; exactly the five Forge actions are exposed
 *   as custom tools bound to the Turn's ActionBuffer;
 * - Pi auto-retry stays disabled (Forge owns attempts); Pi auto-compaction is
 *   enabled for within-turn context compression (the system prompt lives
 *   outside session history via the resource loader, so it is preserved);
 *   every Turn still rebuilds a fresh session, so compaction never crosses
 *   Turn boundaries — Forge events remain the only recovery source;
 * - only final assistant text blocks are returned; usage collapses to input/
 *   output counts; raw causes, credentials, headers and hidden thinking never
 *   surface in results, errors or logs (iron rule 6).
 *
 * Tests inject `createSession`/`resolveModelBinding`; production defaults to
 * the real SDK `createAgentSession` and a ModelRuntime-backed resolver whose
 * provider authentication stays inside the ModelRuntime/environment.
 */
import { join } from 'node:path';
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { canonicalJsonSha256 } from '../structured-slots/canonical-json';
import type { TraceEntry } from '../../shared/contracts';
import type { TurnContract } from '../template/template-schema';
import type {
  AgentRuntime,
  AgentRunOptions,
  AgentTurnInput,
  AgentTurnResult,
  LivePatch,
} from './agent-runtime';
import { RuntimeAbortedError, RuntimeFailure } from './agent-runtime';
import { ActionBuffer } from './action-buffer';
import type { ForgeAction } from './forge-actions';
import type { GateRunner } from './gate-runner';
import { createForgeResourceLoader } from './pi-resource-loader';
import { RESOURCE_LOADER_ERROR_CODES } from './pi-resource-loader';
import {
  createForgeToolDefinitions,
  createSkillSectionToolDefinitions,
  createValidateArtifactToolDefinitions,
} from './pi-tool-factory';
import type { WorkspaceStore } from './workspace-store';
import { createWorkspaceToolDefinitions } from './workspace-tools';
import {
  SLOT_TOOL_NAME_SET,
  RESOURCE_LIMIT_EXCEEDED,
} from './structured-slot/tool-factory';
import {
  AttemptMeter,
  type AttemptTerminalFailure,
} from './structured-slot/attempt-meter';

/** Stable runtime error codes owned by the Pi adapter (presentable only). */
export const PI_RUNTIME_ERROR_CODES = {
  /** The frozen agent model spec is not a `<provider>/<model>` string. */
  MODEL_SPEC_INVALID: 'MODEL_SPEC_INVALID',
  /** The configured provider has no such model. */
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  /** The provider request itself did not complete (raw cause never leaked). */
  PROVIDER_REQUEST_FAILED: 'PROVIDER_REQUEST_FAILED',
  /** The provider stopped the turn with an error. */
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  /** The provider produced no public assistant response. */
  PROVIDER_NO_RESPONSE: 'PROVIDER_NO_RESPONSE',
  /** One agent may run at most one Turn at a time (global constraint). */
  AGENT_TURN_ALREADY_RUNNING: 'AGENT_TURN_ALREADY_RUNNING',
  /** The runtime was disposed; no further Turns are accepted. */
  RUNTIME_DISPOSED: 'RUNTIME_DISPOSED',
  /** See pi-resource-loader: a discovery channel leaked resources. */
  RESOURCE_DISCOVERY_LEAK: RESOURCE_LOADER_ERROR_CODES.RESOURCE_DISCOVERY_LEAK,
} as const;

/** The Pi model descriptor handed to createAgentSession (opaque to Forge). */
export type PiModelDescriptor = NonNullable<CreateAgentSessionOptions['model']>;

/** Resolved model + the runtime that owns provider auth for it. */
export interface PiModelBinding {
  model: PiModelDescriptor;
  modelRuntime?: CreateAgentSessionOptions['modelRuntime'];
}

export type PiModelBindingResolver = (modelSpec: string) => Promise<PiModelBinding>;

/** Minimal structural view of session events the adapter consumes. */
export interface PiSessionEventLike {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    usage?: unknown;
    stopReason?: unknown;
  };
  /** Present on tool_execution_start / tool_execution_end events. */
  toolName?: unknown;
  /** Present on tool_execution_start events. */
  args?: unknown;
  /** Present on tool_execution_end events. */
  result?: unknown;
}

/** Minimal structural view of session events the adapter consumes. */
export interface PiSessionEventLike {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    usage?: unknown;
    stopReason?: unknown;
  };
  /** Present on tool_execution_start / tool_execution_end events. */
  toolName?: unknown;
  /** Present on tool_execution_start events. */
  args?: unknown;
  /** Present on tool_execution_end events. */
  result?: unknown;
  /** Present on tool_execution_end events (error result flag). */
  isError?: unknown;
}

/**
 * Minimal structural view of the raw Pi Agent events (the underlying
 * `session.agent` seam, forge-pi-slot-preflight/v1). The production factory
 * maps the raw seam to the public Pi 0.82 `Agent.subscribe`, whose listener
 * promises the Agent loop AWAITS in subscription order BEFORE tool lookup and
 * TypeBox argument validation (verified in the Pi 0.82 SDK characterization).
 */
export interface PiRawAgentEventLike {
  type?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  args?: unknown;
}

/** Minimal structural view of the Pi session the adapter drives. */
export interface PiSessionHandle {
  prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
  subscribe(listener: (event: PiSessionEventLike) => void): () => void;
  /**
   * REQUIRED raw-Agent subscription seam (Task 14): maps to the underlying
   * public Pi `session.agent.subscribe`, whose listener promises Pi AWAITS at
   * the pre-validation boundary. The session-level `subscribe` (public-output
   * listeners) is NOT the pre-validation authority boundary and must never be
   * used for precharging. Every PiSessionHandle implementation (production
   * factory, ScriptedPiSession, the probe wrapper) implements this seam.
   */
  agentSubscribe(listener: (event: PiRawAgentEventLike, signal: AbortSignal) => Promise<void> | void): () => void;
  abort(): Promise<void>;
  dispose(): void;
  setAutoCompactionEnabled(enabled: boolean): void;
}

export type PiSessionFactory = (options: CreateAgentSessionOptions) => Promise<PiSessionHandle>;

/** Production factory: the real SDK createAgentSession, wrapping the raw seam. */
export const defaultPiSessionFactory: PiSessionFactory = async (options) => {
  const session = (await createAgentSession(options)).session;
  return {
    prompt: (text, promptOptions) => session.prompt(text, promptOptions),
    subscribe: (listener) => session.subscribe(listener as Parameters<typeof session.subscribe>[0]),
    agentSubscribe: (listener) => session.agent.subscribe(listener as Parameters<typeof session.agent.subscribe>[0]),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
    setAutoCompactionEnabled: (enabled) => session.setAutoCompactionEnabled(enabled),
  };
};

export interface PiAgentRuntimeOptions {
  /** Core data root; sessions are in-memory and never write under it. */
  coreCwd: string;
  /** Per-agent workspace store backing the three workspace tools (required). */
  workspaces: WorkspaceStore;
  /** Injected in tests; defaults to the real SDK createAgentSession. */
  createSession?: PiSessionFactory;
  /** Injected in tests; defaults to a ModelRuntime-backed resolver. */
  resolveModelBinding?: PiModelBindingResolver;
  /** Sanitized lifecycle logger; never receives raw events or credentials. */
  log?: (line: string) => void;
  /**
   * Structured-slot runtime seam (Task 14): assembles the per-turn slot tool
   * set, the persistent Attempt meter, the dispatch guard and the corrective
   * prompt for a structured v3 turn. Returns null for a basic turn (or any
   * turn without a structured slot session). Task 17 wires the coordinator/
   * session services; tests inject fakes.
   */
  structuredSlot?: PiStructuredSlotRuntime;
}

/**
 * The per-turn structured slot runtime context the Pi adapter consumes (Task
 * 14). `signal` is the composite Attempt signal carried by
 * `AgentTurnInput.slotSession.signal` (deadline/resource closure ∪ scheduler
 * stop); context compaction and corrective prompts never recreate it or the
 * meter.
 */
export interface StructuredSlotRuntimeContext {
  sessionKind: 'structure' | 'fill' | 'seal';
  turnId: string;
  /** The persistent Attempt meter (raw preflight seam + consume). */
  meter: AttemptMeter;
  /** The closed per-kind Slot Tool definitions bound to the session services. */
  toolDefinitions: ToolDefinition[];
  /** Dispatch guard for the basic forge tools (design §11.3 matrix). */
  beforePropose: (action: ForgeAction) => { ok: true } | { ok: false; code: string; reason: string };
  /** Corrective prompt naming the required Slot completion before dispatch. */
  correctivePrompt: string;
}

/** Builds the per-turn structured slot runtime context; null for a basic turn. */
export interface PiStructuredSlotRuntime {
  createContext(input: AgentTurnInput): Promise<StructuredSlotRuntimeContext | null>;
}

/**
 * The locked Pi 0.82 pre-validation charging seam (spec §5 / O06,
 * forge-pi-slot-preflight/v1): subscribe this listener to the raw
 * `session.agent.subscribe` seam. Pi emits `tool_execution_start` BEFORE tool
 * lookup and TypeBox argument validation and AWAITS every listener's promise
 * in subscription order, so a closed Slot Tool call is durably precharged —
 * schema-invalid, unexposed-but-closed-name and truncated calls all reach this
 * entry and count, while execute only consumes the existing precharge. Unknown
 * non-Slot tool names never count. On limit closure the meter aborts the
 * composite signal and `onLimitClose` surfaces the coordinator's terminal
 * failure.
 */
export function createForgePiSlotPreflight(options: {
  meter: AttemptMeter;
  onLimitClose?: (failure: AttemptTerminalFailure) => void;
}): (event: PiRawAgentEventLike, signal: AbortSignal) => Promise<void> {
  const { meter, onLimitClose } = options;
  return async (event: PiRawAgentEventLike): Promise<void> => {
    if (event?.type !== 'tool_execution_start') return;
    const toolName = typeof event.toolName === 'string' ? event.toolName : '';
    if (!SLOT_TOOL_NAME_SET.has(toolName)) return;
    const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : '';
    let canonicalArgsHash: string;
    try {
      canonicalArgsHash = canonicalJsonSha256(event.args);
    } catch {
      canonicalArgsHash = canonicalJsonSha256({ __non_json_args: true });
    }
    // Task 11 note: a scheduler stop aborts the composite without minting a
    // terminal; the tool path must never charge or mint a spurious
    // resource-limit terminal on an externally-aborted attempt.
    if (meter.signal.aborted) {
      if (meter.closed && meter.terminalFailure !== null) {
        onLimitClose?.(meter.terminalFailure);
      }
      return;
    }
    const charge = await meter.prechargeRawTool({ toolCallId, canonicalArgsHash, toolName });
    if (charge.status === 'closed') {
      onLimitClose?.(charge.failure);
    }
  };
}

/** Parses a frozen agent model spec `<provider>/<model>` (first slash splits). */
export function parsePiModelSpec(modelSpec: string): { providerId: string; modelId: string } {
  const slash = modelSpec.indexOf('/');
  if (slash <= 0 || slash === modelSpec.length - 1) {
    throw RuntimeFailure.permanent(
      PI_RUNTIME_ERROR_CODES.MODEL_SPEC_INVALID,
      'the agent model must be declared as <provider>/<model>',
    );
  }
  return { providerId: modelSpec.slice(0, slash), modelId: modelSpec.slice(slash + 1) };
}

/**
 * Production resolver: one lazily created ModelRuntime owns provider auth
 * (credentials stay inside the ModelRuntime/environment and are never
 * logged or returned by this adapter).
 */
export function createDefaultModelBindingResolver(): PiModelBindingResolver {
  let runtimePromise: Promise<ModelRuntime> | null = null;
  return async (modelSpec: string): Promise<PiModelBinding> => {
    const { providerId, modelId } = parsePiModelSpec(modelSpec);
    runtimePromise ??= ModelRuntime.create({ allowModelNetwork: false });
    const modelRuntime = await runtimePromise;
    const model = modelRuntime.getModel(providerId, modelId);
    if (!model) {
      throw RuntimeFailure.permanent(
        PI_RUNTIME_ERROR_CODES.MODEL_NOT_FOUND,
        `model '${modelSpec}' is not configured for the provider`,
      );
    }
    return { model, modelRuntime };
  };
}

/** Custom-message type used to replay tool-role history entries. */
const FORGE_TOOL_RESULT_CUSTOM_TYPE = 'forge/tool_result';

/**
 * Corrective re-prompts allowed when a Turn ends without completing its
 * production/dispatch phases (plan 2026-08-06; extracted from the hardcoded
 * loop bound). Models occasionally emit text-only output instead of tool
 * calls; each nudge is one short provider round-trip.
 */
export const MAX_CORRECTIVE_NUDGES = 2;

/** Sealed-phase reminder used when the frozen snapshot carries no contract. */
const GENERIC_SEALED_PHASE_REMINDER =
  '你已经调用了 finish_production，但还没有发送。请立即调用一个发送动作（send_message、publish_artifact、submit_final_artifact 或 request_human_input）。';

/**
 * The sealed-phase corrective reminder naming ONLY the dispatch actions the
 * agent's frozen turn contract allows (plan 2026-08-06). `request_human_input`
 * stays a legal post-seal dispatch for every agent (the committer's phase
 * gate accepts it after sealing), so it is always listed. A null contract
 * falls back to the generic reminder.
 */
export function sealedPhaseReminder(turnContract: TurnContract | null): string {
  if (turnContract === null) {
    return GENERIC_SEALED_PHASE_REMINDER;
  }
  const options = [...turnContract.dispatch.allowedActions, 'request_human_input'];
  return `你已经调用了 finish_production，但还没有发送。请立即调用一个发送动作（${options.join('、')}）。`;
}

/** Custom-message type used for Forge-owned skill context injection. */
const FORGE_SKILL_CONTEXT_CUSTOM_TYPE = 'forge/skill_context';

/** Subdirectory of coreCwd passed as the Pi agentDir (nothing is read from it). */
const PI_AGENT_DIR_NAME = '.forge-pi-agent';

/**
 * Pi session ids accept only alphanumerics, '-', '_', '.' — map the Forge
 * `<taskId>:<agentId>:<turnId>` session key onto that alphabet.
 */
function toPiSessionId(sessionKey: string, turnId: string): string {
  return `${sessionKey}:${turnId}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

interface LiveSession {
  /** Null while the session is still being constructed (slot already reserved). */
  session: PiSessionHandle | null;
  /** True once the platform (signal/disposal) asked the session to stop. */
  platformAborted: boolean;
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Replays the frozen public history (public messages only) chronologically. */
function replayPublicHistory(
  sessionManager: SessionManager,
  input: AgentTurnInput,
  model: PiModelDescriptor,
): void {
  let timestamp = Date.now() - input.publicHistory.length * 1000;
  for (const item of input.publicHistory) {
    if (item.role === 'user') {
      sessionManager.appendMessage({ role: 'user', content: item.text, timestamp });
    } else if (item.role === 'assistant') {
      // Public text only — hidden thinking is never stored or replayed.
      sessionManager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: item.text }],
        api: typeof model.api === 'string' ? model.api : 'forge',
        provider: typeof model.provider === 'string' ? model.provider : 'forge',
        model: model.id,
        usage: zeroUsage(),
        stopReason: 'stop',
        timestamp,
      });
    } else {
      // Tool-role public history has no surviving tool-call pairing; replay it
      // as a Forge-owned context message rather than fabricating one.
      sessionManager.appendCustomMessageEntry(FORGE_TOOL_RESULT_CUSTOM_TYPE, item.text, false);
    }
    timestamp += 1;
  }
}

/** Renders authorized-skill summaries and loaded-skill contents as one message. */
function renderSkillContext(input: AgentTurnInput): string | null {
  const lines: string[] = [];
  if (input.availableSkills.length > 0) {
    lines.push('Authorized skills (request full content with load_skill):');
    for (const skill of input.availableSkills) {
      lines.push(`- ${skill.id} | ${skill.name} | ${skill.description}`);
    }
  }
  if (input.loadedSkills.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Loaded skill content:');
    for (const skill of input.loadedSkills) {
      lines.push(`:: skill ${skill.id} version ${skill.versionHash} ::`);
      lines.push(skill.content);
    }
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

/** Extracts only public text blocks from a final assistant message. */
function extractPublicText(message: NonNullable<PiSessionEventLike['message']>): string {
  const content = message.content;
  if (!Array.isArray(content)) {
    return '';
  }
  const texts: string[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      texts.push((block as { text: string }).text);
    }
  }
  return texts.join('\n');
}

/** Collapses provider usage to plain input/output counts, or null. */
function extractUsage(
  message: NonNullable<PiSessionEventLike['message']>,
): AgentTurnResult['usage'] {
  const usage = message.usage;
  if (
    usage !== null &&
    typeof usage === 'object' &&
    typeof (usage as { input?: unknown }).input === 'number' &&
    typeof (usage as { output?: unknown }).output === 'number'
  ) {
    return {
      inputTokens: (usage as { input: number }).input,
      outputTokens: (usage as { output: number }).output,
    };
  }
  return null;
}

function failureCodeOf(error: unknown): string {
  if (error instanceof RuntimeFailure) {
    return error.code;
  }
  if (error instanceof RuntimeAbortedError) {
    return error.code;
  }
  return 'UNKNOWN';
}

/** Plain-object guard used to sanitize tool-call params in the trace. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extracts the public text steps from a final assistant message (plan Phase E
 * Task 2; raw provider thinking is NEVER durable — semantic audit P0, plan
 * 2026-08-07). Text blocks contribute `block.text`; empty blocks are skipped
 * and provider metadata (e.g. thinkingSignature) never leaves the adapter.
 * Defensive: never throws.
 */
function collectAssistantTrace(message: NonNullable<PiSessionEventLike['message']>): {
  text: TraceEntry[];
} {
  const text: TraceEntry[] = [];
  const content = message.content;
  if (!Array.isArray(content)) {
    return { text };
  }
  for (const block of content) {
    if (block === null || typeof block !== 'object') {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    if (type === 'text') {
      const raw = (block as { text?: unknown }).text;
      if (typeof raw === 'string' && raw.length > 0) {
        text.push({ kind: 'text', text: raw });
      }
    }
  }
  return { text };
}

/**
 * Cumulative public text of an assistant message snapshot, for the live-preview
 * patches (plan C). `message_update` events carry the message accumulated so
 * far, so each patch can replace the previous value. Provider thinking is never
 * streamed (semantic audit P0). Defensive: never throws.
 */
function extractLiveContent(message: NonNullable<PiSessionEventLike['message']>): string {
  const texts: string[] = [];
  const content = message.content;
  if (!Array.isArray(content)) {
    return '';
  }
  for (const block of content) {
    if (block === null || typeof block !== 'object') {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    if (type === 'text') {
      const raw = (block as { text?: unknown }).text;
      if (typeof raw === 'string') {
        texts.push(raw);
      }
    }
  }
  return texts.join('\n');
}

/** Builds a tool_call trace entry from a tool_execution_start event. */
function toolCallEntry(event: PiSessionEventLike): TraceEntry {
  const toolName = typeof event.toolName === 'string' ? event.toolName : '';
  const params = isPlainObject(event.args) ? event.args : {};
  return { kind: 'tool_call', toolName, params };
}

/** Concatenates the text blocks of a tool result, defensively. */
function toolResultText(result: unknown): string {
  if (isPlainObject(result)) {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const block of content) {
        if (
          block !== null &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
        ) {
          texts.push((block as { text: string }).text);
        }
      }
      if (texts.length > 0) {
        return texts.join('\n');
      }
    }
  }
  if (typeof result === 'string') {
    return result;
  }
  if (result === null || result === undefined) {
    return '';
  }
  try {
    return String(result);
  } catch {
    return '';
  }
}

/** Builds a tool_result trace entry from a tool_execution_end event. */
function toolResultEntry(event: PiSessionEventLike): TraceEntry {
  const toolName = typeof event.toolName === 'string' ? event.toolName : '';
  return { kind: 'tool_result', toolName, text: toolResultText(event.result) };
}

export class PiAgentRuntime implements AgentRuntime {
  readonly #coreCwd: string;

  readonly #workspaces: WorkspaceStore;

  readonly #createSession: PiSessionFactory;

  readonly #resolveModelBinding: PiModelBindingResolver;

  readonly #log: (line: string) => void;

  readonly #structuredSlot: PiStructuredSlotRuntime | undefined;

  readonly #live = new Map<string, LiveSession>();

  #disposed = false;

  /**
   * Optional skill content reader wired by the CoreService after construction
   * (structural setter, mirroring the fake runtime's workspace sink). When
   * set, load_skill returns the full skill text in its tool result so the
   * model can act on it in the same Turn; the per-Turn closure below captures
   * the current task/agent so the factory stays free of any CoreService handle.
   */
  #skillReader: ((
    taskId: string,
    agentId: string,
    skillId: string,
  ) => Promise<{ content: string; versionHash: string } | null>) | null = null;

  /**
   * Wires the skill content reader (structural setter, invoked by CoreService
   * after the SkillService is constructed). Reader returns null for an
   * unauthorized skill so load_skill rejects without proposing.
   */
  setSkillContentReader(
    reader: (
      taskId: string,
      agentId: string,
      skillId: string,
    ) => Promise<{ content: string; versionHash: string } | null>,
  ): void {
    this.#skillReader = reader;
  }

  /**
   * Optional skill section reader wired by the CoreService after construction
   * (structural setter, structurally identical to the content reader above).
   * When set, read_skill_section returns the authorized section file content
   * in its tool result; the per-Turn closure captures task/agent so the
   * factory stays free of any CoreService handle.
   */
  #skillSectionReader: ((
    taskId: string,
    agentId: string,
    skillId: string,
    sectionPath: string,
  ) => Promise<{ content: string; versionHash: string }>) | null = null;

  /**
   * Wires the skill section reader (structural setter, invoked by CoreService
   * after the SkillService is constructed). An unwired reader rejects every
   * section read with SKILL_SECTION_NOT_AUTHORIZED inside the tool callback.
   */
  setSkillSectionReader(
    reader: (
      taskId: string,
      agentId: string,
      skillId: string,
      sectionPath: string,
    ) => Promise<{ content: string; versionHash: string }>,
  ): void {
    this.#skillSectionReader = reader;
  }

  /**
   * Optional artifact-gate runner wired by the CoreService after construction
   * (structural setter, same discipline as the readers above). When set AND the
   * agent declares a self_check gate, the read-only validate_artifact tool is
   * registered; an unwired runner never exposes the tool (the factory returns
   * the empty set), so tool-count assertions stay stable.
   */
  #gateRunner: GateRunner | null = null;

  /**
   * Wires the artifact-gate runner (structural setter, invoked by CoreService
   * after the GateRunner is constructed).
   */
  setGateRunner(runner: GateRunner): void {
    this.#gateRunner = runner;
  }

  constructor(options: PiAgentRuntimeOptions) {
    this.#coreCwd = options.coreCwd;
    this.#workspaces = options.workspaces;
    this.#createSession = options.createSession ?? defaultPiSessionFactory;
    this.#resolveModelBinding = options.resolveModelBinding ?? createDefaultModelBindingResolver();
    this.#log = options.log ?? (() => undefined);
    this.#structuredSlot = options.structuredSlot;
  }

  async run(
    input: AgentTurnInput,
    signal: AbortSignal,
    options?: AgentRunOptions,
  ): Promise<AgentTurnResult> {
    if (this.#disposed) {
      throw RuntimeFailure.permanent(
        PI_RUNTIME_ERROR_CODES.RUNTIME_DISPOSED,
        'the Pi runtime is disposed and accepts no further turns',
      );
    }
    if (signal.aborted) {
      throw new RuntimeAbortedError(`turn ${input.turnId} aborted before it started`);
    }
    const sessionKey = `${input.taskId}:${input.agent.id}`;
    if (this.#live.has(sessionKey)) {
      throw RuntimeFailure.permanent(
        PI_RUNTIME_ERROR_CODES.AGENT_TURN_ALREADY_RUNNING,
        `agent '${input.agent.id}' already has a turn in flight`,
      );
    }

    // Reserve the one-slot-per-agent registration synchronously, before any
    // await, so a concurrent run observes AGENT_TURN_ALREADY_RUNNING.
    const live: LiveSession = { session: null, platformAborted: false };
    this.#live.set(sessionKey, live);

    // Task 14: a structured v3 turn runs under the composite Attempt signal
    // carried by AgentTurnInput.slotSession (deadline/resource closure ∪
    // scheduler stop); basic turns keep the scheduler signal (byte-for-byte).
    const runAbortSignal = input.slotSession !== null ? input.slotSession.signal : signal;

    // Registered before any await as well: an abort firing during session
    // setup is caught up below via the signal.aborted check.
    const onAbort = () => {
      live.platformAborted = true;
      void live.session?.abort().catch(() => undefined);
    };
    runAbortSignal.addEventListener('abort', onAbort, { once: true });

    const buffer = new ActionBuffer(input.turnId);
    // Display-only live-preview sink (plan C): patches are memory-bound and
    // never reach storage; a throwing sink can never break the Turn.
    const onLive = options?.onLive;
    const emitLive = (partial: Partial<Omit<LivePatch, 'agentId' | 'turnId'>>): void => {
      if (onLive === undefined) return;
      try {
        onLive({ agentId: input.agent.id, turnId: input.turnId, ...partial });
      } catch {
        // Live preview is best-effort; drop sink failures silently.
      }
    };
    let unsubscribe: (() => void) | null = null;
    let structuredUnsubscribe: (() => void) | null = null;
    // Task 14: the structured slot runtime context (tool set, meter, dispatch
    // guard, corrective prompt) is resolved once per turn and is NOT recreated
    // by Pi auto-compaction or corrective prompts. Resolved inside the try so a
    // provider failure still runs the failure/finally cleanup below.
    let structuredCtx: StructuredSlotRuntimeContext | null = null;
    try {
      if (input.slotSession !== null && this.#structuredSlot !== undefined) {
        structuredCtx = await this.#structuredSlot.createContext(input);
      }
      const binding = await this.#resolveModelBinding(input.agent.model);

      // Fresh in-memory session per Turn: Forge events are the only recovery
      // source, so the session is rebuilt from public history every time.
      const sessionManager = SessionManager.inMemory(this.#coreCwd, {
        id: toPiSessionId(sessionKey, input.turnId),
      });
      replayPublicHistory(sessionManager, input, binding.model);
      const skillContext = renderSkillContext(input);
      if (skillContext !== null) {
        sessionManager.appendCustomMessageEntry(FORGE_SKILL_CONTEXT_CUSTOM_TYPE, skillContext, false);
      }

      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: false },
      });
      const resourceLoader = await createForgeResourceLoader({
        cwd: this.#coreCwd,
        agentDir: join(this.#coreCwd, PI_AGENT_DIR_NAME),
        systemPrompt: input.agent.systemPrompt,
      });

      const session = await this.#createSession({
        cwd: this.#coreCwd,
        model: binding.model,
        modelRuntime: binding.modelRuntime,
        sessionManager,
        settingsManager,
        resourceLoader,
        noTools: 'builtin',
        customTools: [
          ...createForgeToolDefinitions(buffer, {
            readSkillContent: (skillId) =>
              this.#skillReader === null
                ? Promise.resolve(null)
                : this.#skillReader(input.taskId, input.agent.id, skillId),
            // Task 14: the structured dispatch guard (design §11.3 matrix)
            // runs before any forge action is buffered.
            beforePropose: structuredCtx?.beforePropose,
          }),
          ...createWorkspaceToolDefinitions({
            workspaces: this.#workspaces,
            taskId: input.taskId,
            agentId: input.agent.id,
            // Review F1: the SAME Turn buffer gates workspace writes — once
            // the package is sealed or dispatched the sealed content (e.g. a
            // sealed workspace_file) must stay immutable.
            isProductionPhase: () => buffer.phase === 'production',
          }),
          ...createSkillSectionToolDefinitions({
            readSection: (skillId, sectionPath) =>
              this.#skillSectionReader === null
                ? Promise.reject(
                    new RuntimeFailure(
                      'SKILL_SECTION_NOT_AUTHORIZED',
                      '该技能无子文件授权。',
                      false,
                    ),
                  )
                : this.#skillSectionReader(input.taskId, input.agent.id, skillId, sectionPath),
          }),
          // Template-declared artifact gate self-check (plan 2026-08-07 Phase
          // 2): registers validate_artifact only when a runner is wired AND the
          // agent's gate mode includes self_check; otherwise the factory
          // returns the empty set, so the closed tool count stays stable.
          ...createValidateArtifactToolDefinitions({
            gateRunner: this.#gateRunner,
            workspaces: this.#workspaces,
            agent: input.agent,
            taskId: input.taskId,
            agentId: input.agent.id,
          }),
          // Task 14: the closed per-kind Slot Tool set (structure/fill/seal)
          // for a structured v3 turn; an empty spread for basic turns.
          ...(structuredCtx?.toolDefinitions ?? []),
        ],
      });
      live.session = session;
      session.setAutoCompactionEnabled(true);
      this.#log(`pi-agent-runtime: turn started (agent=${input.agent.id})`);

      // Task 14: the raw pre-validation charging seam (forge-pi-slot-preflight
      // /v1). Pi emits tool_execution_start BEFORE tool lookup/TypeBox
      // validation and AWAITS this listener, so every closed Slot Tool call is
      // durably precharged before the SDK validates or executes; unknown
      // non-Slot names never count. On limit closure the meter aborts the
      // composite signal (wired above) and the terminal surfaces below.
      if (structuredCtx !== null) {
        structuredUnsubscribe = session.agentSubscribe(
          createForgePiSlotPreflight({ meter: structuredCtx.meter }),
        );
      }

      // Holder object: closure assignment would otherwise be invisible to
      // control-flow narrowing of a local `let`.
      const collected: {
        message: NonNullable<PiSessionEventLike['message']> | null;
        ordered: TraceEntry[];
      } = {
        message: null,
        ordered: [],
      };
      unsubscribe = session.subscribe((event) => {
        // Trace collection is defensive: it must never fail the Turn.
        // Entries are appended in event order so the dialog shows the public
        // steps where they happened; provider thinking never enters the trace
        // (semantic audit P0, plan 2026-08-07).
        try {
          if (event?.type === 'message_end' && event.message?.role === 'assistant') {
            collected.message = event.message;
            collected.ordered.push(...collectAssistantTrace(event.message).text);
          } else if (event?.type === 'message_update' && event.message?.role === 'assistant') {
            // Live streaming preview (plan C): cumulative snapshot of the
            // in-flight assistant message; public text only, never persisted.
            emitLive({ text: extractLiveContent(event.message) });
          } else if (event?.type === 'tool_execution_start') {
            collected.ordered.push(toolCallEntry(event));
            emitLive({
              toolStarted: typeof event.toolName === 'string' ? event.toolName : '',
            });
          } else if (event?.type === 'tool_execution_end') {
            collected.ordered.push(toolResultEntry(event));
            emitLive({
              toolFinished: typeof event.toolName === 'string' ? event.toolName : '',
            });
          }
        } catch {
          // A malformed event can never break the Turn; drop it silently.
        }
      });

      let promptError: unknown = null;
      try {
        if (!runAbortSignal.aborted && !live.platformAborted) {
          await session.prompt(input.inputText, { expandPromptTemplates: false });
        }
      } catch (error) {
        promptError = error;
      }

      if (runAbortSignal.aborted || live.platformAborted) {
        // Task 14: a resource/deadline closure minted a terminal — surface the
        // coordinator's terminal failure, never a bare abort.
        if (structuredCtx !== null && structuredCtx.meter.closed && structuredCtx.meter.terminalFailure !== null) {
          throw RuntimeFailure.permanent(RESOURCE_LIMIT_EXCEEDED, structuredCtx.meter.terminalFailure.message);
        }
        throw new RuntimeAbortedError(`turn ${input.turnId} was aborted`);
      }
      if (promptError !== null) {
        // Presentable message only — the raw cause is never propagated.
        throw RuntimeFailure.transient(
          PI_RUNTIME_ERROR_CODES.PROVIDER_REQUEST_FAILED,
          'the provider request did not complete',
        );
      }
      // Provider-level failures and empty responses terminate the Turn
      // immediately (plan 2026-08-06): a corrective nudge only makes sense
      // when the provider actually answered but skipped the production/
      // dispatch phases, never when it errored, aborted or stayed silent.
      if (collected.message === null) {
        throw RuntimeFailure.transient(
          PI_RUNTIME_ERROR_CODES.PROVIDER_NO_RESPONSE,
          'the provider returned no assistant response',
        );
      }
      if (collected.message.stopReason === 'aborted') {
        throw new RuntimeAbortedError(`turn ${input.turnId} was aborted by the provider`);
      }
      if (collected.message.stopReason === 'error') {
        throw RuntimeFailure.transient(
          PI_RUNTIME_ERROR_CODES.PROVIDER_ERROR,
          'the provider reported an error while completing the turn',
        );
      }
      // Phase-completion corrective loop: the model occasionally produces
      // text-only output without calling finish_production or a dispatch
      // action. Give it a corrective nudge and re-prompt (bounded by
      // MAX_CORRECTIVE_NUDGES); the sealed-phase reminder names only the
      // dispatch actions the agent's turn contract allows.
      for (let nudge = 0; nudge < MAX_CORRECTIVE_NUDGES; nudge += 1) {
        if (buffer.phase === 'dispatched' || buffer.phase === 'human_interrupted') {
          break;
        }
        // Task 14: a structured turn names the required Slot completion before
        // dispatch; basic turns keep the production/dispatch reminders.
        const reminder = structuredCtx !== null
          ? structuredCtx.correctivePrompt
          : buffer.phase === 'production'
            ? '你还没有调用 finish_production。请立即调用 finish_production 封存你的生产结果，然后调用一个发送动作。文字输出不是动作，不能代替工具调用。'
            : sealedPhaseReminder(input.agent.turnContract);
        this.#log('pi-agent-runtime: phase incomplete (' + buffer.phase + '), corrective prompt ' + (nudge + 1));
        await session.prompt(reminder, { expandPromptTemplates: false });
        if (runAbortSignal.aborted || live.platformAborted) {
          if (structuredCtx !== null && structuredCtx.meter.closed && structuredCtx.meter.terminalFailure !== null) {
            throw RuntimeFailure.permanent(RESOURCE_LIMIT_EXCEEDED, structuredCtx.meter.terminalFailure.message);
          }
          throw new RuntimeAbortedError('turn ' + input.turnId + ' was aborted during corrective prompt');
        }
        // A nudge the provider answers with an error or an abort ends the
        // correction attempts; the final-state checks below surface the
        // typed failure.
        const latest = collected.message;
        if (
          latest !== null &&
          (latest.stopReason === 'error' || latest.stopReason === 'aborted')
        ) {
          break;
        }
      }
      const lastAssistant = collected.message;
      if (lastAssistant === null) {
        throw RuntimeFailure.transient(
          PI_RUNTIME_ERROR_CODES.PROVIDER_NO_RESPONSE,
          'the provider returned no assistant response',
        );
      }
      if (lastAssistant.stopReason === 'aborted') {
        throw new RuntimeAbortedError(`turn ${input.turnId} was aborted by the provider`);
      }
      if (lastAssistant.stopReason === 'error') {
        throw RuntimeFailure.transient(
          PI_RUNTIME_ERROR_CODES.PROVIDER_ERROR,
          'the provider reported an error while completing the turn',
        );
      }
      const publicText = extractPublicText(lastAssistant);
      if (publicText.length === 0) {
        throw RuntimeFailure.transient(
          PI_RUNTIME_ERROR_CODES.PROVIDER_NO_RESPONSE,
          'the provider returned no public assistant text',
        );
      }
      const usage = extractUsage(lastAssistant);
      buffer.succeed(publicText, usage);
      const committed = buffer.commit();
      const actions: ForgeAction[] = committed.map((action) => ({ ...action }));
      // Display-only trace in chronological event order; never consumed by
      // delivery gates.
      const trace: TraceEntry[] = [...collected.ordered];
      this.#log(
        `pi-agent-runtime: turn succeeded (agent=${input.agent.id} actions=${actions.length}` +
          ` usage=${usage === null ? 'none' : `${usage.inputTokens}/${usage.outputTokens}`})`,
      );
      return { turnId: input.turnId, publicText, actions, usage, trace };
    } catch (error) {
      buffer.fail(error instanceof Error ? error : new Error(String(error)));
      this.#log(
        `pi-agent-runtime: turn failed (agent=${input.agent.id} code=${failureCodeOf(error)})`,
      );
      // Best-effort stop of any in-flight provider work on every failure path
      // (idempotent when the platform already aborted the session).
      await live.session?.abort().catch(() => undefined);
      throw error;
    } finally {
      // Every exit path (success, failure, abort) drops the live buffer and
      // unsubscribes both the session trace and the raw preflight seam.
      emitLive({ finished: true });
      if (unsubscribe !== null) {
        unsubscribe();
      }
      if (structuredUnsubscribe !== null) {
        structuredUnsubscribe();
      }
      runAbortSignal.removeEventListener('abort', onAbort);
      try {
        live.session?.dispose();
      } catch {
        // Disposal is best-effort; the session is in-memory only.
      }
      this.#live.delete(sessionKey);
    }
  }

  async disposeAgent(taskId: string, agentId: string): Promise<void> {
    const sessionKey = `${taskId}:${agentId}`;
    const live = this.#live.get(sessionKey);
    if (!live) {
      return;
    }
    live.platformAborted = true;
    await live.session?.abort().catch(() => undefined);
    try {
      live.session?.dispose();
    } catch {
      // Best-effort: the in-flight run's finally also disposes.
    }
    this.#live.delete(sessionKey);
  }

  async disposeAll(): Promise<void> {
    this.#disposed = true;
    const entries = [...this.#live.values()];
    this.#live.clear();
    for (const live of entries) {
      live.platformAborted = true;
      await live.session?.abort().catch(() => undefined);
      try {
        live.session?.dispose();
      } catch {
        // Best-effort disposal during shutdown.
      }
    }
  }
}
