/**
 * Runtime test fixtures for plan Phase C Tasks 1–2 (Step 1 requirements).
 *
 * Helpers return only public contract types and never access storage. Agent
 * identities are deliberately neutral (`agent-alpha`, `agent-beta`,
 * `configured/test-model`) — platform fixtures carry zero business
 * vocabulary (iron rule 1). Unlike the server-level test-support, this
 * module is compiled by the server build (tsconfig.server.json only excludes
 * `src/server/test-support.ts`), so it must stay free of vitest imports.
 *
 * Task 2 adds `createPiHarness`: an injected `createSession` factory that
 * records the exact `CreateAgentSessionOptions`, exposes the in-memory
 * SettingsManager and scripts the assistant/tool event sequence — so the
 * PiAgentRuntime is exercised end-to-end without ever touching a Provider.
 *
 * Task 3 adds the commit fixtures: a neutral frozen-snapshot fixture (the
 * server-level equivalent of the template module's `valid` fixture, with
 * neutral agent ids), an `artifactProposal` builder and the
 * `buildCommitContext`/`createContextFor` helpers that assemble a
 * `CommitContext` for one frozen agent.
 *
 * Task 4 adds the scheduler fixtures: `DeferredAgentRuntime` (a fake whose
 * Turns gate on `resolveNext`, with an observed-maximum concurrency counter
 * proving Turns never overlap), `RecordingRuntime`, a temporary-root
 * `createSchedulerEnvironment` over the storage-level fixture template, and
 * `schedulerWithDeferredRuntime` (plan Task 4 Step 1 verbatim harness).
 *
 * Task 5 adds the lifecycle fixtures: `schedulerWithFailures(codes)` — a
 * FakeAgentRuntime scripted with transient/permanent `RuntimeFailure`s per
 * code (classified through the retry policy itself) followed by one
 * Turn that publishes and submits the frozen template's final output, plus
 * an injected deterministic retry clock; `attemptEvents`/
 * `retryScheduledEvents` readers; `seedRunningTaskWithoutTerminalEvent` and
 * `restart()` (a fresh scheduler over the same roots, simulating a process
 * restart). `DeferredAgentRuntime` gains `ignoreAbort` so stale-result
 * suppression can be tested with a Turn that resolves strictly after stop.
 */
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ResourceLoader,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { TaskWorkspace } from '../../shared/contracts';
import { CoreService } from '../core-service';
import { CorePaths } from '../storage/core-paths';
import type { ArtifactStore } from '../storage/artifact-store';
import type { EventStore } from '../storage/event-store';
import type { TaskStore } from '../storage/task-store';
import type { TaskEvent } from '../storage/task-events';
import type { FrozenTemplate, TurnContract } from '../template/template-schema';
import { RuntimeAbortedError, RuntimeFailure } from './agent-runtime';
import type { AgentRuntime, AgentTurnInput, AgentTurnResult } from './agent-runtime';
import { TaskScheduler, type RetryPolicyHooks } from './task-scheduler';
// Type-only for red-phase purity (Task 1/2 precedent): the commit fixtures
// below need no runtime import from the Task 3 committer module.
import type { CommitContext } from './action-committer';
import {
  FakeAgentRuntime,
  type Deferred,
  type FakeResultStep,
  type FakeScriptStep,
} from './fake-agent-runtime';
import type { ForgeAction } from './forge-actions';
import {
  PiAgentRuntime,
  type PiModelDescriptor,
  type PiSessionEventLike,
  type PiSessionHandle,
} from './pi-agent-runtime';
import { autoRetryDelayMs, classifyRuntimeError } from './retry-policy';
import { WorkspaceStore } from './workspace-store';

/** The narrowed `send_message` member of the ForgeAction union. */
export type SendMessageAction = Extract<ForgeAction, { type: 'send_message' }>;

/** Neutral `send_message` proposal; tests override the fields they assert on. */
export function sendMessageProposal(overrides: Partial<SendMessageAction> = {}): SendMessageAction {
  return {
    type: 'send_message',
    targetAgentId: 'agent-beta',
    summary: 'neutral coordination message',
    ...overrides,
  };
}

/** Neutral inline `finish_production` proposal sealing a text package. */
export function finishProductionProposal(
  overrides: Partial<Extract<ForgeAction, { type: 'finish_production'; source: 'inline' }>> = {},
): Extract<ForgeAction, { type: 'finish_production'; source: 'inline' }> {
  return {
    type: 'finish_production',
    source: 'inline',
    files: [{ name: 'content.md', content: 'neutral sealed production' }],
    format: 'text',
    artifactType: null,
    title: null,
    ...overrides,
  };
}

/** Neutral `publish_artifact` proposal referencing the sealed package. */
export function publishPackageProposal(): Extract<ForgeAction, { type: 'publish_artifact' }> {
  return { type: 'publish_artifact' };
}

/** Deterministic provider usage for sealed Turns. */
export function fakeUsage(inputTokens = 12, outputTokens = 34): {
  inputTokens: number;
  outputTokens: number;
} {
  return { inputTokens, outputTokens };
}

/** Neutral version-2 turn contract for the fixture's publishing agent. */
export function publisherContract(targetAgentId: string): TurnContract {
  return {
    version: 2,
    production: {
      files: ['content.md'],
      output: { formats: ['markdown'], sources: ['inline', 'workspace_file'] },
    },
    dispatch: {
      allowedActions: ['publish_artifact'],
      targets: { publish_artifact: [targetAgentId] },
    },
  };
}

/** Neutral version-2 turn contract for the fixture's reviewing submitter. */
export function reviewerContract(targetAgentId: string): TurnContract {
  return {
    version: 2,
    annotate: { files: ['review.md'] },
    dispatch: {
      allowedActions: ['send_message', 'submit_final_artifact'],
      targets: { send_message: [targetAgentId] },
    },
  };
}

/**
 * A frozen-agent-shaped Turn input with zero business vocabulary: neutral
 * agent `agent-alpha` on the configured test model with one authorized skill.
 */
export function sampleTurnInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    taskId: 'task-1',
    turnId: 'turn-1',
    agent: {
      id: 'agent-alpha',
      name: 'Agent Alpha',
      description: 'Neutral first agent for runtime tests.',
      systemPrompt: 'You are agent-alpha, a neutral platform test agent.',
      model: 'configured/test-model',
      skills: [
        {
          id: 'skill-alpha',
          name: 'Skill Alpha',
          description: 'Neutral skill summary.',
          contentPath: 'skills/skill-alpha/SKILL.md',
          sectionsPath: null,
          sections: [],
        },
      ],
      turnContract: publisherContract('agent-beta'),
      gate: null,
      slotCapabilities: [],
    },
    inputNodeId: 'node-input-1',
    inputText: 'neutral input text',
    publicHistory: [
      { role: 'user', text: 'neutral opening instruction' },
      { role: 'assistant', text: 'neutral acknowledgement' },
    ],
    availableSkills: [
      { id: 'skill-alpha', name: 'Skill Alpha', description: 'Neutral skill summary.' },
    ],
    loadedSkills: [],
    // Basic turns pass an explicit null slot session (Task 11 contract).
    slotSession: null,
    ...overrides,
  };
}

/** Creates an externally settled promise used to stall scripted Turns. */
export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A scripted successful Turn gated by an externally resolvable deferred, so
 * tests can hold a Turn in flight (to abort or settle it deterministically).
 */
export function deferredScript(
  overrides: Omit<FakeResultStep, 'kind' | 'deferred'> = {},
): { step: FakeResultStep; deferred: Deferred<void> } {
  const deferred = createDeferred<void>();
  return { deferred, step: { kind: 'result', ...overrides, deferred } };
}

// ---------------------------------------------------------------------------
// Phase C Task 2: Pi harness (injected createSession factory, scripted turns)
// ---------------------------------------------------------------------------

/** One scripted Pi Turn consumed per `session.prompt()` call. */
export interface PiScriptedTurn {
  /** Tool calls executed against the recorded customTools before the reply. */
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  /** Final public assistant text block (omitted with `noAssistant`). */
  text?: string;
  /**
   * Streaming simulation (plan C): `message_update` events with growing
   * content, emitted before the tool calls. Thinking chunks stream first,
   * then text chunks; every update carries the CUMULATIVE message content,
   * exactly like the real Pi session.
   */
  streaming?: {
    thinkingChunks?: readonly string[];
    textChunks?: readonly string[];
  };
  /** Extra content blocks (e.g. hidden thinking sentinels) on the message. */
  extraContent?: Array<Record<string, unknown>>;
  /**
   * Emit one extra assistant `message_end` per entry (thinking block only)
   * before the tool calls, simulating inter-tool-call reasoning turns.
   */
  intermediateThinking?: readonly string[];
  /** Provider usage reported on the final message. */
  usage?: { input: number; output: number };
  /** Emit the final message without any usage object. */
  omitUsage?: boolean;
  /** Override the final stop reason (default 'stop'). */
  stopReason?: 'stop' | 'error' | 'aborted' | 'toolUse';
  /** Provider error message carried by an error stop. */
  errorMessage?: string;
  /** prompt() rejects with this error. */
  promptError?: Error;
  /** Emit no assistant message at all. */
  noAssistant?: boolean;
  /** prompt() waits on this deferred (abort-aware) before continuing. */
  deferred?: Deferred<unknown>;
}

/** Neutral public text emitted when a script slot is empty. */
export const PI_HARNESS_DEFAULT_TEXT = 'neutral scripted reply';

/** Structural view of the recorded custom tools (names + execute only). */
export interface PiToolDefinitionLike {
  name: string;
  execute(
    toolCallId: string,
    args: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
}

/** Recorded `createAgentSession` options with required fields non-optional. */
export interface PiRecordedSessionOptions {
  cwd: string;
  model: PiModelDescriptor;
  modelRuntime?: unknown;
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  resourceLoader: ResourceLoader;
  noTools: 'all' | 'builtin';
  customTools: PiToolDefinitionLike[];
}

/** One recorded custom-tool execution performed by the scripted session. */
export interface PiHarnessToolExecution {
  name: string;
  args: Record<string, unknown>;
  resultText: string;
  accepted: boolean;
}

/**
 * The scripted in-memory Pi session returned by the harness factory. It
 * executes the recorded custom tools itself (exactly like the real agent
 * loop) and emits one synthetic `message_end` per scripted Turn.
 */
export class ScriptedPiSession implements PiSessionHandle {
  promptCalls: Array<{ text: string; options?: { expandPromptTemplates?: boolean } }> = [];

  abortCount = 0;

  disposeCount = 0;

  autoCompactionCalls: boolean[] = [];

  emittedMessages: Array<Record<string, unknown>> = [];

  toolExecutions: PiHarnessToolExecution[] = [];

  readonly #script: readonly PiScriptedTurn[];

  readonly #customTools: PiToolDefinitionLike[];

  readonly #model: PiModelDescriptor;

  readonly #listeners = new Set<(event: PiSessionEventLike) => void>();

  readonly #abortWaiters = new Set<() => void>();

  #promptIndex = 0;

  #aborted = false;

  constructor(
    script: readonly PiScriptedTurn[],
    customTools: PiToolDefinitionLike[],
    model: PiModelDescriptor,
  ) {
    this.#script = script;
    this.#customTools = customTools;
    this.#model = model;
  }

  subscribe(listener: (event: PiSessionEventLike) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  setAutoCompactionEnabled(enabled: boolean): void {
    this.autoCompactionCalls.push(enabled);
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
    this.#aborted = true;
    for (const waiter of [...this.#abortWaiters]) {
      this.#abortWaiters.delete(waiter);
      waiter();
    }
  }

  dispose(): void {
    this.disposeCount += 1;
  }

  async prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void> {
    this.promptCalls.push({ text, options });
    const step: PiScriptedTurn = this.#script[this.#promptIndex++] ?? {};
    if (step.deferred) {
      await this.#waitForDeferredOrAbort(step.deferred);
    }
    if (this.#aborted) {
      return;
    }
    if (step.promptError) {
      throw step.promptError;
    }
    if (step.streaming !== undefined) {
      let thinkingSoFar = '';
      let textSoFar = '';
      for (const chunk of step.streaming.thinkingChunks ?? []) {
        thinkingSoFar += chunk;
        this.#emit({
          type: 'message_update',
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: thinkingSoFar }],
          },
        });
      }
      for (const chunk of step.streaming.textChunks ?? []) {
        textSoFar += chunk;
        const content: Array<Record<string, unknown>> = [];
        if (thinkingSoFar.length > 0) {
          content.push({ type: 'thinking', thinking: thinkingSoFar });
        }
        content.push({ type: 'text', text: textSoFar });
        this.#emit({
          type: 'message_update',
          message: { role: 'assistant', content },
        });
      }
    }
    for (const thinking of step.intermediateThinking ?? []) {
      const intermediate: Record<string, unknown> = {
        role: 'assistant',
        content: [{ type: 'thinking', thinking }],
      };
      this.emittedMessages.push(intermediate);
      for (const listener of [...this.#listeners]) {
        listener({ type: 'message_end', message: intermediate });
      }
    }
    for (const [index, call] of (step.toolCalls ?? []).entries()) {
      const tool = this.#customTools.find((candidate) => candidate.name === call.name);
      if (!tool) {
        throw new Error(`ScriptedPiSession: no custom tool named '${call.name}'`);
      }
      const toolCallId = `tc-${this.promptCalls.length}-${index}`;
      this.#emit({ type: 'tool_execution_start', toolName: call.name, args: call.args });
      const result = await tool.execute(
        toolCallId,
        call.args,
        undefined,
        undefined,
        {},
      );
      this.#emit({ type: 'tool_execution_end', toolName: call.name, result });
      const firstBlock = result.content[0];
      const details = result.details as { accepted?: unknown } | undefined;
      this.toolExecutions.push({
        name: call.name,
        args: call.args,
        resultText: firstBlock?.type === 'text' ? (firstBlock.text ?? '') : '',
        accepted: details?.accepted === true,
      });
    }
    if (step.noAssistant) {
      return;
    }
    const content: Array<Record<string, unknown>> = [];
    if (step.text !== undefined) {
      content.push({ type: 'text', text: step.text });
    } else {
      content.push({ type: 'text', text: PI_HARNESS_DEFAULT_TEXT });
    }
    content.push(...(step.extraContent ?? []));
    const usage = step.omitUsage
      ? undefined
      : {
          input: step.usage?.input ?? 5,
          output: step.usage?.output ?? 6,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: (step.usage?.input ?? 5) + (step.usage?.output ?? 6),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
    const message: Record<string, unknown> = {
      role: 'assistant',
      content,
      api: this.#model.api,
      provider: this.#model.provider,
      model: this.#model.id,
      usage,
      stopReason: step.stopReason ?? 'stop',
      errorMessage: step.errorMessage,
      timestamp: Date.now(),
    };
    this.emittedMessages.push(message);
    this.#emit({ type: 'message_end', message });
  }

  /** Emits one synthetic session event to every subscribed listener. */
  #emit(event: PiSessionEventLike): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }

  #waitForDeferredOrAbort(deferred: Deferred<unknown>): Promise<void> {
    if (this.#aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          this.#abortWaiters.delete(done);
          resolve();
        }
      };
      this.#abortWaiters.add(done);
      deferred.promise.then(done, done);
    });
  }
}

/** A full-shaped, neutral Pi model descriptor for harness sessions. */
export function createPiStubModel(overrides: Record<string, unknown> = {}): PiModelDescriptor {
  return {
    id: 'test-model',
    name: 'Forge Pi Harness Model',
    api: 'forge-harness',
    provider: 'configured',
    baseUrl: 'https://forge-harness.invalid',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
    ...overrides,
  } as PiModelDescriptor;
}

export interface PiHarnessOptions {
  /** Working directory for sessions/loaders; created fresh when omitted. */
  coreCwd?: string;
  /** Scripted Turns consumed one per prompt() call. */
  script?: readonly PiScriptedTurn[];
}

/** Everything tests need to observe about the injected Pi session factory. */
export interface PiHarness {
  runtime: PiAgentRuntime;
  coreCwd: string;
  /** The temp-root workspace store injected into the runtime. */
  workspaces: WorkspaceStore;
  resolvedModelSpecs: string[];
  logs: string[];
  sessionOptionsList: PiRecordedSessionOptions[];
  readonly sessionCount: number;
  readonly sessionOptions: PiRecordedSessionOptions;
  readonly settings: SettingsManager;
  readonly session: ScriptedPiSession;
  readonly toolExecutions: PiHarnessToolExecution[];
}

/**
 * Builds a PiAgentRuntime wired to a scripted in-memory Pi factory: records
 * the exact CreateAgentSessionOptions, exposes the in-memory SettingsManager
 * and plays back scripted public assistant/tool sequences. No Provider is
 * ever contacted. A temp-root WorkspaceStore (derived from the harness cwd)
 * is injected so the three workspace tools are live.
 */
export function createPiHarness(options: PiHarnessOptions = {}): PiHarness {
  const coreCwd = options.coreCwd ?? mkdtempSync(join(tmpdir(), 'forge-pi-harness-'));
  const script = options.script ?? [];
  const resolvedModelSpecs: string[] = [];
  const logs: string[] = [];
  const sessionOptionsList: PiRecordedSessionOptions[] = [];
  const sessions: ScriptedPiSession[] = [];
  const stubModel = createPiStubModel();
  // Workspace files land under the harness cwd so caller cleanup removes them.
  const workspaces = new WorkspaceStore(
    CorePaths.create({ dataRoot: coreCwd, templateRoot: coreCwd }),
  );

  const runtime = new PiAgentRuntime({
    coreCwd,
    workspaces,
    resolveModelBinding: async (modelSpec: string) => {
      resolvedModelSpecs.push(modelSpec);
      return { model: stubModel };
    },
    createSession: async (sessionOptions) => {
      const customTools = (sessionOptions.customTools ?? []) as unknown as PiToolDefinitionLike[];
      const session = new ScriptedPiSession(script, customTools, stubModel);
      sessionOptionsList.push({
        cwd: sessionOptions.cwd ?? coreCwd,
        model: sessionOptions.model ?? stubModel,
        modelRuntime: sessionOptions.modelRuntime,
        sessionManager: sessionOptions.sessionManager as SessionManager,
        settingsManager: sessionOptions.settingsManager as SettingsManager,
        resourceLoader: sessionOptions.resourceLoader as ResourceLoader,
        noTools: sessionOptions.noTools ?? 'all',
        customTools,
      });
      sessions.push(session);
      return session;
    },
    log: (line: string) => {
      logs.push(line);
    },
  });

  const harness: PiHarness = {
    runtime,
    coreCwd,
    workspaces,
    resolvedModelSpecs,
    logs,
    sessionOptionsList,
    get sessionCount(): number {
      return sessionOptionsList.length;
    },
    get sessionOptions(): PiRecordedSessionOptions {
      const last = sessionOptionsList[sessionOptionsList.length - 1];
      if (!last) {
        throw new Error('PiHarness: no Pi session has been created yet');
      }
      return last;
    },
    get settings(): SettingsManager {
      return harness.sessionOptions.settingsManager;
    },
    get session(): ScriptedPiSession {
      const last = sessions[sessions.length - 1];
      if (!last) {
        throw new Error('PiHarness: no Pi session has been created yet');
      }
      return last;
    },
    get toolExecutions(): PiHarnessToolExecution[] {
      return sessions.flatMap((session) => session.toolExecutions);
    },
  };
  return harness;
}

// ---------------------------------------------------------------------------
// Phase C Task 3: commit fixtures (frozen snapshot, provisional artifacts,
// CommitContext builder) — plan Task 3 Step 1 requirements.
// ---------------------------------------------------------------------------

/** Deterministic version hash for the neutral frozen snapshot fixture. */
export const NEUTRAL_FIXTURE_VERSION_HASH = createHash('sha256')
  .update('forge-core-neutral-frozen-fixture', 'utf8')
  .digest('hex');

/**
 * The server-level equivalent of the template module's `valid` fixture, with
 * neutral identities: two agents, one artifact route alpha→beta, one message
 * route beta→alpha, a single declared final submitter (agent-beta) and one
 * authorized skill per agent. Platform fixtures carry zero business
 * vocabulary (iron rule 1).
 */
export function frozenSnapshotFixture(): FrozenTemplate {
  return {
    id: 'neutral-fixture',
    name: 'Neutral Fixture',
    description: 'Neutral two-agent frozen snapshot for runtime tests.',
    versionHash: NEUTRAL_FIXTURE_VERSION_HASH,
    budget: null,
    productionMode: 'basic',
    structuredSlots: null,
    structuredPhases: null,
    inputFields: [],
    agents: [
      {
        id: 'agent-alpha',
        name: 'Agent Alpha',
        description: 'Neutral first agent.',
        systemPrompt: 'You are agent-alpha, a neutral platform test agent.',
        model: 'configured/test-model',
        skills: [
          {
            id: 'skill-alpha',
            name: 'Skill Alpha',
            description: 'Neutral skill summary.',
            contentPath: 'skills/skill-alpha/SKILL.md',
            sectionsPath: null,
            sections: [],
          },
        ],
        turnContract: publisherContract('agent-beta'),
        gate: null,
        slotCapabilities: [],
      },
      {
        id: 'agent-beta',
        name: 'Agent Beta',
        description: 'Neutral second agent.',
        systemPrompt: 'You are agent-beta, a neutral platform test agent.',
        model: 'configured/test-model',
        skills: [
          {
            id: 'skill-beta',
            name: 'Skill Beta',
            description: 'Neutral skill summary.',
            contentPath: 'skills/skill-beta/SKILL.md',
            sectionsPath: null,
            sections: [],
          },
        ],
        turnContract: reviewerContract('agent-alpha'),
        gate: null,
        slotCapabilities: [],
      },
    ],
    routes: [
      { from: 'agent-alpha', to: 'agent-beta', kind: 'artifact', label: 'artifact hand-off' },
      { from: 'agent-beta', to: 'agent-alpha', kind: 'message', label: 'message reply' },
    ],
    finalOutput: { name: 'final-output', format: 'markdown', submitters: ['agent-beta'] },
    artifactSchema: {
      files: [
        { name: 'content.md', required: true, producer: 'agent-alpha', extract: 'content', phase: 'create' },
      ],
    },
    sourcePath: 'fixture:neutral',
  };
}

/**
 * The environment `buildCommitContext` binds to: one frozen task identity,
 * its frozen snapshot and the committed input node id per agent. `turnSeq`
 * is advanced by the builder so successive contexts never reuse a turn id.
 */
export interface CommitFixtureEnvironment {
  taskId: string;
  frozen: FrozenTemplate;
  inputNodeIds: Record<string, string>;
  publicText?: string;
  attemptCount?: number;
  /** Advanced by `buildCommitContext`; tests never set it directly. */
  turnSeq?: number;
}

export interface CommitContextOverrides extends Partial<Omit<CommitContext, 'taskId' | 'currentAgent'>> {
  /** Pins the turn id instead of letting the environment allocate one. */
  turnId?: string;
  /** Replaces the frozen current agent (e.g. to attach a gate to a commit). */
  currentAgent?: CommitContext['currentAgent'];
}

/**
 * Assembles one `CommitContext` for a frozen agent of the environment. The
 * context carries the agent's frozen turn contract and (by default) no
 * received input artifact; tests override `currentInputArtifact` to exercise
 * the platform-resolved package reference (plan 2026-08-04 Task 4).
 */
export function buildCommitContext(
  env: CommitFixtureEnvironment,
  agentId: string,
  overrides: CommitContextOverrides = {},
): CommitContext {
  const agent = env.frozen.agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new Error(`test-support: the frozen fixture has no agent '${agentId}'`);
  }
  env.turnSeq = (env.turnSeq ?? 0) + 1;
  const { turnId, ...rest } = overrides;
  return {
    taskId: env.taskId,
    turnId: turnId ?? `turn-${env.turnSeq}`,
    currentAgent: agent,
    agents: env.frozen.agents.map(({ id, name }) => ({ id, name })),
    inputNodeId: env.inputNodeIds[agentId] ?? `ev-input-${agentId}`,
    attemptCount: env.attemptCount ?? 1,
    publicText: env.publicText ?? 'neutral result text',
    declaredRoutes: env.frozen.routes,
    finalOutput: env.frozen.finalOutput,
    turnContract: agent.turnContract,
    currentInputArtifact: null,
    ...rest,
  };
}

/** Binds `buildCommitContext` to one environment: `contextFor(agentId)`. */
export function createContextFor(env: CommitFixtureEnvironment): (agentId: string) => CommitContext {
  return (agentId: string) => buildCommitContext(env, agentId);
}

// ---------------------------------------------------------------------------
// Phase C Task 4: serial runner / one-slot scheduler fixtures (plan Task 4
// Step 1 requirements).
//
// The scheduler environment owns its own temporary-root registry and fixture
// installer: this module is compiled by the server build, so it must not
// import the build-excluded server-level test-support.
// ---------------------------------------------------------------------------

const runtimeTestRoots: string[] = [];

function registerRuntimeTestRoot(root: string): void {
  runtimeTestRoots.push(root);
}

/** Removes every temporary root created by the Task 4 helpers in this process. */
export function disposeRuntimeTestRoots(): void {
  while (runtimeTestRoots.length > 0) {
    const root = runtimeTestRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

/** Template id used when the storage-level `valid` fixture is installed. */
export const RUNTIME_FIXTURE_TEMPLATE_ID = 'test-template';

/** Version-2 turn contract blocks injected into the runtime fixture. */
const RUNTIME_WRITER_CONTRACT_YAML = [
  'turnContract:',
  '  version: 2',
  '  production:',
  '    files: [content.md]',
  '    sources: [inline, workspace_file]',
  '    formats: [markdown]',
  '  dispatch:',
  '    allowedActions: [publish_artifact]',
  '    targets:',
  '      publish_artifact: reviewer',
  '',
].join('\n');

const RUNTIME_REVIEWER_CONTRACT_YAML = [
  'turnContract:',
  '  version: 2',
  '  annotate:',
  '    files: [review.md]',
  '  dispatch:',
  '    allowedActions: [send_message, submit_final_artifact]',
  '    targets:',
  '      send_message: writer',
  '',
].join('\n');

/**
 * Upgrades the copied legacy fixture to the current turn contract in place.
 * The committed fixtures stay legacy so the incompatibility gate (plan Task 3)
 * has historical snapshots; runtime tests run on current-contract copies.
 */
function upgradeFixtureContracts(templateDir: string): void {
  for (const [agentId, contract] of [
    ['writer', RUNTIME_WRITER_CONTRACT_YAML],
    ['reviewer', RUNTIME_REVIEWER_CONTRACT_YAML],
  ] as const) {
    const file = join(templateDir, 'agents', `${agentId}.yaml`);
    writeFileSync(
      file,
      `${readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').trimEnd()}\n${contract}`,
      'utf8',
    );
  }
}

/**
 * Locates the storage-level `valid` template fixture relative to this module
 * (one level up from `runtime/`); non-file module URL schemes fall back to the
 * workspace-relative location (tests always run from the workspace root).
 */
function runtimeFixtureDir(): string {
  try {
    return fileURLToPath(new URL('../template/__fixtures__/valid', import.meta.url));
  } catch {
    return resolvePath(process.cwd(), 'src', 'server', 'template', '__fixtures__', 'valid');
  }
}

/**
 * A task creation request built generically from the template's declared
 * input fields: required fields receive neutral text, so this module carries
 * zero business vocabulary (iron rule 1).
 */
function genericTaskRequest(frozen: FrozenTemplate): {
  templateId: string;
  name: string;
  input: Record<string, string>;
} {
  const input: Record<string, string> = {};
  for (const field of frozen.inputFields) {
    if (field.required) {
      input[field.id] = 'neutral fixture input';
    }
  }
  return { templateId: frozen.id, name: 'Neutral Fixture Task', input };
}

export interface SchedulerEnvironment {
  paths: CorePaths;
  service: CoreService;
  events: EventStore;
  tasks: TaskStore;
  artifacts: ArtifactStore;
  templateId: string;
  frozen: FrozenTemplate;
  /** Creates one fresh frozen task from the fixture template. */
  createTask(): Promise<string>;
  /** Appends one confirmed input node for the agent; returns the event id. */
  seedAgentInput(taskId: string, agentId: string, body: string, eventId?: string): Promise<string>;
}

/**
 * Builds a temporary-root CoreService wired to an injected runtime, with the
 * storage-level `valid` fixture installed as the only template. Everything a
 * Task 4 runner/scheduler test needs to freeze tasks, seed confirmed input
 * nodes and observe projections.
 */
export async function createSchedulerEnvironment(options: {
  runtime: AgentRuntime;
  /**
   * Optional template source patch (plan 2026-08-06 budget tests): applied
   * right after the fixture contracts upgrade and before the catalog/
   * service initialize, so a frozen task snapshot carries the patched
   * template (snapshots are immutable once frozen).
   */
  patchTemplate?: (templateDir: string) => void;
}): Promise<SchedulerEnvironment> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'forge-core-runner-data-'));
  const templateRoot = mkdtempSync(join(tmpdir(), 'forge-core-runner-templates-'));
  registerRuntimeTestRoot(dataRoot);
  registerRuntimeTestRoot(templateRoot);
  const templateDir = join(templateRoot, RUNTIME_FIXTURE_TEMPLATE_ID);
  cpSync(runtimeFixtureDir(), templateDir, { recursive: true });
  upgradeFixtureContracts(templateDir);
  options.patchTemplate?.(templateDir);

  const paths = CorePaths.create({ dataRoot, templateRoot });
  const service = new CoreService(paths, { runtime: options.runtime });
  await service.initialize();
  const catalog = service.templates;
  const detail = catalog.get(RUNTIME_FIXTURE_TEMPLATE_ID);
  if (!detail || detail.status !== 'valid') {
    throw new Error('test-support: the runtime fixture template did not initialize as valid');
  }

  const environment: SchedulerEnvironment = {
    paths,
    service,
    events: service.events,
    tasks: service.tasks,
    artifacts: service.artifacts,
    templateId: RUNTIME_FIXTURE_TEMPLATE_ID,
    frozen: catalog.getFrozen(RUNTIME_FIXTURE_TEMPLATE_ID) as FrozenTemplate,
    async createTask(): Promise<string> {
      const frozenTemplate = environment.frozen;
      const created = await service.tasks.create(genericTaskRequest(frozenTemplate));
      return created.id;
    },
    async seedAgentInput(
      taskId: string,
      agentId: string,
      body: string,
      eventId?: string,
    ): Promise<string> {
      const committed = await service.events.read(taskId);
      let sequence = 0;
      for (const entry of committed) {
        const event = entry.event;
        if ('node' in event) {
          sequence = Math.max(sequence, event.node.sequence);
        }
      }
      const id = eventId ?? `ev-input-${randomUUID()}`;
      const agentName =
        environment.frozen.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
      const event: TaskEvent = {
        id,
        at: new Date().toISOString(),
        type: 'agent_input',
        node: {
          sequence: sequence + 1,
          agentId,
          kind: 'input',
          title: agentName,
          body,
          status: 'confirmed',
          attemptCount: 1,
          inputVersion: null,
        },
      };
      await service.events.append(taskId, event);
      return id;
    },
  };
  return environment;
}

/**
 * Publishes one neutral artifact version through the environment's store AND
 * backs it with the committed `artifact_published` event (spec §8), so the
 * store's disk↔event cross-check accepts it. Returns the published version.
 */
export async function publishFixtureArtifact(
  environment: SchedulerEnvironment,
  taskId: string,
  parts: { title: string; content: string; sourceNodeId: string },
): Promise<number> {
  const published = await environment.artifacts.publish(taskId, {
    title: parts.title,
    files: [{ name: 'content.md', content: parts.content }],
    sourceNodeId: parts.sourceNodeId,
    format: environment.frozen.finalOutput.format,
  });
  await environment.events.append(taskId, {
    id: `ev-artifact-${published.version}`,
    at: new Date().toISOString(),
    type: 'artifact_published',
    artifact: {
      version: published.version,
      title: published.title,
      sourceNodeId: published.sourceNodeId,
      format: published.format,
      files: published.files,
      artifactType: environment.frozen.finalOutput.name,
      artifactId: published.id,
    },
  });
  return published.version;
}

/**
 * Appends one confirmed input node carrying an artifact version the agent must
 * submit. `humanAuthorized` is true (the scheduler accept path synthesized this
 * input, spec §7.1) so the final closure needs no committed route chain.
 */
export async function seedAgentInputVersion(
  environment: SchedulerEnvironment,
  taskId: string,
  agentId: string,
  body: string,
  inputVersion: number,
): Promise<string> {
  const committed = await environment.events.read(taskId);
  let sequence = 0;
  for (const entry of committed) {
    if ('node' in entry.event) {
      sequence = Math.max(sequence, entry.event.node.sequence);
    }
  }
  const id = `ev-input-${randomUUID()}`;
  const agentName = environment.frozen.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  await environment.events.append(taskId, {
    id,
    at: new Date().toISOString(),
    type: 'agent_input',
    node: {
      sequence: sequence + 1,
      agentId,
      kind: 'input',
      title: agentName,
      body,
      status: 'confirmed',
      attemptCount: 1,
      inputVersion,
      humanAuthorized: true,
    },
  });
  return id;
}

/**
 * A deferred `AgentRuntime` for one-slot scheduler tests: every `run` blocks
 * (abort-aware) until the test calls `resolveNext`, then applies the agent's
 * scripted step — or a default successful neutral Turn when unscripted. A
 * concurrency counter enters/leaves with each run and exposes the observed
 * maximum, so tests can prove Turns never overlap.
 */
export class DeferredAgentRuntime implements AgentRuntime {
  readonly turnInputs: AgentTurnInput[] = [];

  readonly #scripts: Map<string, readonly FakeScriptStep[]>;

  readonly #invocations = new Map<string, number>();

  readonly #waiters: Array<() => void> = [];

  /**
   * Task 5 stale-result fixture: when true the gate ignores aborts and the
   * scripted result is returned even after an abort, so tests can prove the
   * runner/scheduler commit nothing for a Turn that lands strictly after a
   * stop (spec §7.2).
   */
  readonly #ignoreAbort: boolean;

  #concurrency = 0;

  #maximumConcurrency = 0;

  #disposedAll = false;

  readonly #disposedAgents = new Set<string>();

  constructor(
    options: { scripts?: Record<string, readonly FakeScriptStep[]>; ignoreAbort?: boolean } = {},
  ) {
    this.#scripts = new Map(Object.entries(options.scripts ?? {}));
    this.#ignoreAbort = options.ignoreAbort ?? false;
  }

  /** Highest number of Turns observed simultaneously in flight (expect <= 1). */
  get maximumConcurrency(): number {
    return this.#maximumConcurrency;
  }

  /** Turns currently gated on `resolveNext`. */
  get pendingCount(): number {
    return this.#waiters.length;
  }

  get disposedAll(): boolean {
    return this.#disposedAll;
  }

  isDisposed(taskId: string, agentId: string): boolean {
    return this.#disposedAll || this.#disposedAgents.has(`${taskId}:${agentId}`);
  }

  /** Releases exactly one gated Turn (oldest first); false when none wait. */
  resolveNext(): boolean {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      return false;
    }
    waiter();
    return true;
  }

  /** Resolves once at least one Turn is gated (2 s fail-loud deadline). */
  async waitForPendingTurn(): Promise<void> {
    const deadline = Date.now() + 2000;
    while (this.#waiters.length === 0) {
      if (Date.now() > deadline) {
        throw new Error('DeferredAgentRuntime: no Turn became pending within 2 s');
      }
      await new Promise((wait) => setTimeout(wait, 1));
    }
  }

  async run(input: AgentTurnInput, signal: AbortSignal): Promise<AgentTurnResult> {
    if (signal.aborted) {
      throw new RuntimeAbortedError(`turn ${input.turnId} aborted before it started`);
    }
    this.turnInputs.push(input);
    this.#concurrency += 1;
    this.#maximumConcurrency = Math.max(this.#maximumConcurrency, this.#concurrency);
    try {
      await this.#gate(signal);
      if (!this.#ignoreAbort && signal.aborted) {
        throw new RuntimeAbortedError(`turn ${input.turnId} aborted before return`);
      }
      const agentId = input.agent.id;
      const steps = this.#scripts.get(agentId) ?? [];
      const index = this.#invocations.get(agentId) ?? 0;
      this.#invocations.set(agentId, index + 1);
      const step = steps[index] ?? { kind: 'result' as const };
      if (step.kind === 'failure') {
        throw step.failure;
      }
      return {
        turnId: input.turnId,
        publicText: step.publicText ?? 'neutral deferred turn',
        actions: (step.actions ?? []).map((action) => ({ ...action })),
        usage: step.usage ?? null,
        trace: [],
      };
    } finally {
      this.#concurrency -= 1;
    }
  }

  async disposeAgent(taskId: string, agentId: string): Promise<void> {
    this.#disposedAgents.add(`${taskId}:${agentId}`);
  }

  async disposeAll(): Promise<void> {
    this.#disposedAll = true;
  }

  #gate(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolveGate, rejectGate) => {
      const release = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolveGate();
      };
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(release);
        if (index >= 0) {
          this.#waiters.splice(index, 1);
        }
        rejectGate(new RuntimeAbortedError('turn aborted while waiting on the deferred gate'));
      };
      if (!this.#ignoreAbort) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#waiters.push(release);
    });
  }
}

/** Wraps any runtime and records every Turn input it receives. */
export class RecordingRuntime implements AgentRuntime {
  readonly turnInputs: AgentTurnInput[] = [];

  #concurrency = 0;

  #maximumConcurrency = 0;

  readonly #inner: AgentRuntime;

  constructor(inner: AgentRuntime) {
    this.#inner = inner;
  }

  /** Highest number of Turns observed simultaneously in flight (expect <= 1). */
  get maximumConcurrency(): number {
    return this.#maximumConcurrency;
  }

  async run(input: AgentTurnInput, signal: AbortSignal): Promise<AgentTurnResult> {
    this.turnInputs.push(input);
    this.#concurrency += 1;
    this.#maximumConcurrency = Math.max(this.#maximumConcurrency, this.#concurrency);
    try {
      return await this.#inner.run(input, signal);
    } finally {
      this.#concurrency -= 1;
    }
  }

  disposeAgent(taskId: string, agentId: string): Promise<void> {
    return this.#inner.disposeAgent(taskId, agentId);
  }

  disposeAll(): Promise<void> {
    return this.#inner.disposeAll();
  }
}

/**
 * The one-slot scheduler fixture with two frozen tasks (plan Task 4 Step 1):
 * `taskA` carries one confirmed input node for the template's first agent and
 * the deferred runtime scripts that agent one successful Turn; `taskB` stays
 * input-free. `resolveNext` releases the gated Turn deterministically.
 */
export interface DeferredSchedulerHarness extends TaskScheduler {
  runtime: DeferredAgentRuntime;
  taskA: string;
  taskB: string;
  environment: SchedulerEnvironment;
}

export async function schedulerWithDeferredRuntime(options: {
  scripts?: Record<string, readonly FakeScriptStep[]>;
} = {}): Promise<DeferredSchedulerHarness> {
  const runtime = new DeferredAgentRuntime({ scripts: options.scripts });
  const environment = await createSchedulerEnvironment({ runtime });
  const firstAgentId = environment.frozen.agents[0]?.id;
  if (firstAgentId === undefined) {
    throw new Error('test-support: the runtime fixture declares no agents');
  }
  const taskA = await environment.createTask();
  await environment.seedAgentInput(taskA, firstAgentId, 'neutral opening input');
  const taskB = await environment.createTask();
  // The CoreService scheduler already holds the injected deferred runtime.
  return Object.assign(environment.service.scheduler, {
    taskA,
    taskB,
    environment,
  }) as DeferredSchedulerHarness;
}

// ---------------------------------------------------------------------------
// Phase C Task 5: retry / human / stop / recovery fixtures (plan Task 5
// Step 1 requirements).
//
// `schedulerWithFailures(codes)` scripts the frozen template's final
// submitter with one RuntimeFailure per non-`success` code — transient or
// permanent exactly as the retry policy classifies a matching probe error —
// followed by one Turn that publishes and submits the declared final output.
// The scheduler under test receives a deterministic retry clock: delays are
// the exact exponential bases (jitter pinned to zero) and the injected sleep
// records them instead of waiting. `restart()` builds a fresh scheduler over
// the same roots, simulating a process restart.
// ---------------------------------------------------------------------------

/** Everything a Task 5 retry/recovery test observes about one task. */
export interface RetrySchedulerHarness {
  scheduler: TaskScheduler;
  runtime: FakeAgentRuntime;
  environment: SchedulerEnvironment;
  taskId: string;
  /** Every automatic-retry delay the scheduler actually waited, in order. */
  recordedDelays: number[];
  /** Projection facade over the file-backed environment service. */
  projector: { workspace(taskId: string): Promise<TaskWorkspace> };
  attemptEvents(taskId: string): Promise<Array<Extract<TaskEvent, { type: 'agent_attempt_failed' }>>>;
  retryScheduledEvents(taskId: string): Promise<Array<Extract<TaskEvent, { type: 'retry_scheduled' }>>>;
  /** Appends `task_started` + one confirmed input (a crash mid-run, no terminal event). */
  seedRunningTaskWithoutTerminalEvent(taskId: string): Promise<void>;
  /** A fresh scheduler over the same roots — simulates a process restart. */
  restart(): Promise<TaskScheduler>;
}

/** One scripted failure whose retry class matches the retry policy itself. */
function scriptedFailureFor(code: string): FakeScriptStep {
  const probe =
    code.startsWith('HTTP_')
      ? Object.assign(new Error('scripted provider failure'), {
          status: Number(code.slice('HTTP_'.length)),
        })
      : Object.assign(new Error('scripted runtime failure'), { code });
  const classification = classifyRuntimeError(probe);
  const failure = classification.retryable
    ? RuntimeFailure.transient(code, `scripted transient failure (${code})`)
    : RuntimeFailure.permanent(code, `scripted permanent failure (${code})`);
  return { kind: 'failure', failure };
}

export async function schedulerWithFailures(
  codes: readonly string[],
): Promise<RetrySchedulerHarness> {
  const recordedDelays: number[] = [];
  // Deterministic retry clock: exact exponential bases, zero wait, recorded.
  const retryPolicy: RetryPolicyHooks = {
    delayMs: (retryNumber) => autoRetryDelayMs(retryNumber, () => 0),
    sleep: async (delayMs) => {
      recordedDelays.push(delayMs);
    },
  };

  const runtime = new FakeAgentRuntime();
  const environment = await createSchedulerEnvironment({ runtime });
  const frozen = environment.frozen;
  const submitterId = frozen.finalOutput.submitters[0];
  if (submitterId === undefined) {
    throw new Error('test-support: the runtime fixture declares no final submitter');
  }

  // New turn contract sequence (plan 2026-08-07 Phase 2): the final submitter
  // resolves the submitted version from the input node's inputVersion — so the
  // fixture publishes one neutral version and seeds the submitter's input with
  // that version (humanAuthorized accept path, spec §7.1). The submitter's
  // Turn is the single submit dispatch; failures land on that same node.
  const buildScript = (): FakeScriptStep[] => [
    ...codes.filter((code) => code !== 'success').map(scriptedFailureFor),
    {
      kind: 'result',
      publicText: 'neutral completion turn',
      actions: [{ type: 'submit_final_artifact' }],
    },
  ];
  runtime.setScript(submitterId, buildScript());

  const taskId = await environment.createTask();
  const version = await publishFixtureArtifact(environment, taskId, {
    title: 'Neutral Fixture Final',
    content: 'neutral final content',
    sourceNodeId: 'fixture-producer-result',
  });
  await seedAgentInputVersion(environment, taskId, submitterId, 'neutral opening input', version);

  const scheduler = new TaskScheduler({
    service: environment.service,
    runner: environment.service.runner,
    runtime,
    retryPolicy,
  });

  return {
    scheduler,
    runtime,
    environment,
    taskId,
    recordedDelays,
    projector: { workspace: (id: string) => environment.service.getWorkspace(id) },
    async attemptEvents(id: string) {
      const committed = await environment.events.read(id);
      return committed
        .map((entry) => entry.event)
        .filter(
          (event): event is Extract<TaskEvent, { type: 'agent_attempt_failed' }> =>
            event.type === 'agent_attempt_failed',
        );
    },
    async retryScheduledEvents(id: string) {
      const committed = await environment.events.read(id);
      return committed
        .map((entry) => entry.event)
        .filter(
          (event): event is Extract<TaskEvent, { type: 'retry_scheduled' }> =>
            event.type === 'retry_scheduled',
        );
    },
    async seedRunningTaskWithoutTerminalEvent(id: string) {
      await environment.events.append(id, {
        id: randomUUID(),
        at: new Date().toISOString(),
        type: 'task_started',
      });
      await seedAgentInputVersion(environment, id, submitterId, 'neutral recovery input', version);
    },
    async restart() {
      const restartedRuntime = new FakeAgentRuntime();
      restartedRuntime.setScript(submitterId, buildScript());
      const service = new CoreService(environment.paths, { runtime: restartedRuntime });
      await service.initialize();
      return new TaskScheduler({
        service,
        runner: service.runner,
        runtime: restartedRuntime,
        retryPolicy,
      });
    },
  };
}
