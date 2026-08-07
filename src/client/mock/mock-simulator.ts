import type {
  ArtifactVersion,
  LiveTurn,
  MockScenarioId,
  TraceEntry,
  TurnTracePhase,
  WorkspaceNode,
  WorkspaceRoute,
} from '../../shared/contracts';
import { CORE_ERROR_CODES, CoreError } from '../gateway/core-errors';
import { projectMockWorkspace, projectTaskStatus } from './mock-projector';
import {
  DEFAULT_START_SCENARIO,
  type MockScenarioDefinition,
  type ScenarioStep,
  inputRef,
  validateMockScenario,
} from './mock-scenarios';
import type {
  MockClock,
  MockRunSchedule,
  MockTaskEvent,
  MockTaskRecord,
} from './mock-schema';
import type { MockStore } from './mock-store';

/**
 * Deterministic demonstration engine. Executes MockScenarioDefinition steps
 * on an injected clock, appending append-only events through the gateway's
 * shared channel. The engine is platform-neutral: it branches only on step
 * kind, never on scenario id or business meaning; node ids, route ids and
 * artifact ids are deterministic functions of (taskId, step index) so a
 * recovered run rebuilds the same references without rescanning history.
 *
 * Scheduling bookkeeping ({ scenarioId, nextStepIndex, nextDueAt,
 * runGeneration }) is persisted on the task record before each timer is
 * armed. Callbacks capture their generation; stopped or superseded callbacks
 * compare and become no-ops. At most one timer is armed per task and
 * bootstrap() arms at most one running task per storage.
 */

export interface MockSimulator {
  bootstrap(): void;
  start(taskId: string): void;
  stop(taskId: string): void;
  resume(taskId: string): void;
  retry(taskId: string): void;
  answer(taskId: string, answer: string): void;
  /**
   * The live streaming preview of the task's in-flight result turn (plan C
   * realtime streaming), derived purely from the persisted run schedule and
   * the injected clock — never persisted itself. Null whenever the task is
   * not mid-generation.
   */
  activeTurn(taskId: string): LiveTurn | null;
}

export interface MockSimulatorDeps {
  store: MockStore;
  clock: MockClock;
  timestamp(): string;
  newId(prefix: string): string;
  /** Append one event and notify watchers (the gateway's shared channel). */
  append(taskId: string, event: MockTaskEvent): void;
  /**
   * Record one turn's process trace (display only, never authoritative).
   * The turnId embeds the task id, so the gateway can key traces by turn
   * alone without ever crossing task boundaries. The optional phase is the
   * turn's display-only final phase declared by the scenario step.
   */
  recordTrace(
    turnId: string,
    entries: readonly TraceEntry[],
    phase?: TurnTracePhase,
  ): void;
  /** Fixture content resolver keyed by the artifact step's contentFixture. */
  resolveContent(contentFixture: 'v1' | 'v2'): string;
}

export type MockScenarioRegistry = Readonly<Partial<Record<MockScenarioId, MockScenarioDefinition>>>;

const TRANSIENT_FAILURE_MESSAGE = '临时错误，系统将自动重试。';
const MANUAL_FAILURE_MESSAGE = '自动重试已耗尽，等待手动重试。';
const HUMAN_ANSWER_TITLE = '人工回答';

function nodeIdFor(taskId: string, stepIndex: number): string {
  return `node-${taskId}-${stepIndex}`;
}

/** Deterministic turn id of a step; result nodes and their traces ride on it. */
export function turnIdFor(taskId: string, stepIndex: number): string {
  return `turn-${taskId}-${stepIndex}`;
}

function routeIdFor(taskId: string, stepIndex: number): string {
  return `route-${taskId}-${stepIndex}`;
}

function artifactIdFor(taskId: string, version: number): string {
  return `artifact-${taskId}-${version}`;
}

function routeTargetIndex(scenario: MockScenarioDefinition, routeIndex: number): number {
  const step = scenario.steps[routeIndex];
  if (step.kind !== 'route') return -1;
  return scenario.steps.findIndex(
    (candidate, index) =>
      index > routeIndex && candidate.kind === 'input' && candidate.agentId === step.toAgentId,
  );
}

/** Refs, attempt counts and published artifact count before a given step. */
interface ScriptContext {
  refs: Map<string, string>;
  attemptCounts: Map<string, number>;
  artifactCount: number;
  /** Turn id of the latest result step; skill nodes attribute to it. */
  lastResultTurnId: string | null;
}

function deriveContext(
  scenario: MockScenarioDefinition,
  taskId: string,
  uptoIndex: number,
): ScriptContext {
  const refs = new Map<string, string>();
  const attemptCounts = new Map<string, number>();
  let artifactCount = 0;
  let lastResultTurnId: string | null = null;
  const limit = Math.min(uptoIndex, scenario.steps.length);
  for (let index = 0; index < limit; index += 1) {
    const step: ScenarioStep = scenario.steps[index];
    switch (step.kind) {
      case 'input':
        refs.set(inputRef(step.agentId), nodeIdFor(taskId, index));
        attemptCounts.set(inputRef(step.agentId), 1);
        break;
      case 'result':
        refs.set(`${step.agentId}:result`, nodeIdFor(taskId, index));
        lastResultTurnId = turnIdFor(taskId, index);
        break;
      case 'skill':
        break;
      case 'route': {
        const targetIndex = routeTargetIndex(scenario, index);
        if (targetIndex >= 0) refs.set(inputRef(step.toAgentId), nodeIdFor(taskId, targetIndex));
        break;
      }
      case 'artifact':
        artifactCount += 1;
        break;
      case 'transient_failure':
        attemptCounts.set(step.nodeRef, step.attempt + 1);
        break;
      case 'manual_failure': {
        const current = attemptCounts.get(step.nodeRef);
        if (current !== undefined) attemptCounts.set(step.nodeRef, current + 1);
        break;
      }
      case 'human_request':
        refs.set(`${step.agentId}:human`, nodeIdFor(taskId, index));
        break;
      case 'final':
        break;
    }
  }
  return { refs, attemptCounts, artifactCount, lastResultTurnId };
}

export function createMockSimulator(
  deps: MockSimulatorDeps,
  scenarios: MockScenarioRegistry,
): MockSimulator {
  /** One armed timer per task; every arming clears the previous handle. */
  const timers = new Map<string, number>();

  const clearTimer = (taskId: string): void => {
    const handle = timers.get(taskId);
    if (handle !== undefined) {
      deps.clock.clearTimeout(handle);
      timers.delete(taskId);
    }
  };

  const readRecord = (taskId: string): MockTaskRecord | null => {
    const entry = deps.store.getTaskEntry(taskId);
    return entry !== null && !entry.corrupt ? entry.record : null;
  };

  const persistRun = (taskId: string, run: MockRunSchedule | null): void => {
    deps.store.setTaskRun(taskId, run);
  };

  const scenarioFor = (id: MockScenarioId): MockScenarioDefinition | undefined => scenarios[id];

  const selectScenario = (record: MockTaskRecord): MockScenarioId =>
    record.run?.scenarioId ??
    deps.store.peekDevelopment()?.nextScenario ??
    DEFAULT_START_SCENARIO;

  const schedule = (
    taskId: string,
    scenarioId: MockScenarioId,
    stepIndex: number,
    delayMs: number,
    generation: number,
  ): void => {
    const dueAt = deps.clock.now() + delayMs;
    persistRun(taskId, { scenarioId, nextStepIndex: stepIndex, nextDueAt: dueAt, runGeneration: generation });
    clearTimer(taskId);
    const handle = deps.clock.setTimeout(() => fire(taskId, stepIndex, generation), delayMs);
    timers.set(taskId, handle);
  };

  /** Pause without arming a timer; an external command must continue the run. */
  const park = (taskId: string, run: MockRunSchedule, nextStepIndex: number): void => {
    persistRun(taskId, { ...run, nextStepIndex, nextDueAt: null });
  };

  const executeStep = (
    taskId: string,
    scenario: MockScenarioDefinition,
    stepIndex: number,
    record: MockTaskRecord,
  ): void => {
    const step = scenario.steps[stepIndex];
    const at = deps.timestamp();
    const context = deriveContext(scenario, taskId, stepIndex);
    const workspace = projectMockWorkspace(record);
    const nextNodeSequence =
      workspace.nodes.reduce((max, node) => Math.max(max, node.sequence), 0) + 1;
    const nextRouteSequence =
      workspace.executedRoutes.reduce((max, route) => Math.max(max, route.sequence), 0) + 1;

    switch (step.kind) {
      case 'input':
      case 'result': {
        const isInput = step.kind === 'input';
        // Only result nodes carry a turn id: the canvas fetches process
        // traces through it, and no other node kind can ever have one.
        const turnId = isInput ? null : turnIdFor(taskId, stepIndex);
        const node: WorkspaceNode = {
          id: nodeIdFor(taskId, stepIndex),
          sequence: nextNodeSequence,
          agentId: step.agentId,
          kind: isInput ? 'input' : 'result',
          title: step.title,
          body: step.body,
          status: isInput ? 'active' : 'confirmed',
          attemptCount: isInput
            ? 1
            : (context.attemptCounts.get(inputRef(step.agentId)) ?? 1),
          inputVersion: null,
          turnId,
        };
        deps.append(taskId, { type: isInput ? 'agent_input' : 'agent_result', at, node });
        if (!isInput && turnId !== null) {
          // Provider thinking is never durable (semantic audit P0): the mock
          // trace carries only public text (and tool steps when scripted).
          const entries: TraceEntry[] = [{ kind: 'text', text: step.body }];
          deps.recordTrace(turnId, entries, step.phase);
        }
        break;
      }
      case 'skill': {
        const node: WorkspaceNode = {
          id: nodeIdFor(taskId, stepIndex),
          sequence: nextNodeSequence,
          agentId: step.agentId,
          kind: 'skill',
          title: step.skillId,
          body: step.versionHash.slice(0, 12),
          status: 'confirmed',
          attemptCount: 1,
          inputVersion: null,
          turnId: context.lastResultTurnId,
        };
        deps.append(taskId, { type: 'skill_loaded', at, node });
        break;
      }
      case 'route': {
        const fromNodeId = context.refs.get(step.fromNodeRef);
        const targetIndex = routeTargetIndex(scenario, stepIndex);
        if (fromNodeId === undefined || targetIndex < 0) return; // validated away
        const route: WorkspaceRoute = {
          id: routeIdFor(taskId, stepIndex),
          sequence: nextRouteSequence,
          fromNodeId,
          toNodeId: nodeIdFor(taskId, targetIndex),
          kind: step.routeKind,
          label: step.label,
        };
        deps.append(taskId, { type: 'route_executed', at, route });
        break;
      }
      case 'artifact': {
        const sourceNodeId = context.refs.get(step.sourceNodeRef);
        if (sourceNodeId === undefined) return; // validated away
        const version = context.artifactCount + 1;
        const artifact: ArtifactVersion = {
          id: artifactIdFor(taskId, version),
          version,
          title: step.title,
          files: [{ name: 'content.md', extract: 'content', content: deps.resolveContent(step.contentFixture) }],
          sourceNodeId,
          createdAt: at,
          final: false,
        };
        deps.append(taskId, { type: 'artifact_published', at, artifact });
        break;
      }
      case 'transient_failure':
      case 'manual_failure': {
        const nodeId = context.refs.get(step.nodeRef);
        if (nodeId === undefined) return; // validated away
        const retryable = step.kind === 'transient_failure';
        deps.append(taskId, {
          type: 'agent_attempt_failed',
          at,
          nodeId,
          message: retryable ? TRANSIENT_FAILURE_MESSAGE : MANUAL_FAILURE_MESSAGE,
          retryable,
        });
        break;
      }
      case 'human_request': {
        const node: WorkspaceNode = {
          id: nodeIdFor(taskId, stepIndex),
          sequence: nextNodeSequence,
          agentId: step.agentId,
          kind: 'human_request',
          title: step.question,
          body: step.question,
          status: 'active',
          attemptCount: 1,
          inputVersion: null,
        };
        deps.append(taskId, { type: 'human_requested', at, node, question: step.question });
        break;
      }
      case 'final':
        deps.append(taskId, {
          type: 'final_accepted',
          at,
          artifactId: artifactIdFor(taskId, step.inputVersion),
        });
        break;
    }
  };

  const fire = (taskId: string, stepIndex: number, generation: number): void => {
    timers.delete(taskId);
    const record = readRecord(taskId);
    if (record === null) return;
    const run = record.run;
    // Superseded callback (stopped, replaced by another run, or reset).
    if (run === null || run === undefined || run.runGeneration !== generation) return;
    if (projectTaskStatus(record) !== 'running') return;
    const scenario = scenarioFor(run.scenarioId);
    if (scenario === undefined || stepIndex >= scenario.steps.length) return;

    executeStep(taskId, scenario, stepIndex, record);

    const nextStepIndex = stepIndex + 1;
    if (nextStepIndex >= scenario.steps.length) {
      park(taskId, run, nextStepIndex);
      return;
    }
    const fresh = readRecord(taskId);
    if (fresh === null) return;
    if (projectTaskStatus(fresh) !== 'running') {
      // waiting_human or retryable_failure: continue only via an explicit
      // answer / retry command.
      park(taskId, run, nextStepIndex);
      return;
    }
    schedule(taskId, run.scenarioId, nextStepIndex, scenario.steps[nextStepIndex].delayMs, generation);
  };

  const continueFromPersisted = (record: MockTaskRecord, generation: number): void => {
    const run = record.run;
    if (run === null || run === undefined) return;
    const scenario = scenarioFor(run.scenarioId);
    if (scenario === undefined || run.nextStepIndex >= scenario.steps.length) return;
    schedule(
      record.id,
      run.scenarioId,
      run.nextStepIndex,
      scenario.steps[run.nextStepIndex].delayMs,
      generation,
    );
  };

  const interrupt = (record: MockTaskRecord): void => {
    clearTimer(record.id);
    if (record.run) {
      persistRun(record.id, {
        ...record.run,
        nextDueAt: null,
        runGeneration: record.run.runGeneration + 1,
      });
    }
    deps.append(record.id, { type: 'task_interrupted', at: deps.timestamp() });
  };

  const simulator: MockSimulator = {
    /**
     * Recovery path shared by a normal render and a refreshed browser: at most
     * one running task is resumed from its persisted next step and due time;
     * extra running tasks are isolated as interrupted; empty storage is a
     * no-op. Never appends events for the resumed task itself.
     */
    bootstrap(): void {
      const running: MockTaskRecord[] = [];
      for (const entry of deps.store.listTaskEntries()) {
        if (entry.corrupt) continue;
        if (projectTaskStatus(entry.record) === 'running') running.push(entry.record);
      }
      if (running.length === 0) return;
      const [kept, ...extras] = running;
      for (const extra of extras) interrupt(extra);

      const run = kept.run;
      if (run === null || run === undefined) {
        // Running without scheduling bookkeeping: no safe resume point.
        interrupt(kept);
        return;
      }
      const scenario = scenarioFor(run.scenarioId);
      if (scenario === undefined || run.nextStepIndex >= scenario.steps.length) {
        interrupt(kept);
        return;
      }
      const delay =
        run.nextDueAt === null
          ? scenario.steps[run.nextStepIndex].delayMs
          : Math.max(0, run.nextDueAt - deps.clock.now());
      clearTimer(kept.id);
      const handle = deps.clock.setTimeout(
        () => fire(kept.id, run.nextStepIndex, run.runGeneration),
        delay,
      );
      timers.set(kept.id, handle);
      if (run.nextDueAt === null) {
        persistRun(kept.id, { ...run, nextDueAt: deps.clock.now() + delay });
      }
    },

    start(taskId: string): void {
      const record = readRecord(taskId);
      if (record === null) return;
      const scenarioId = selectScenario(record);
      const scenario = scenarioFor(scenarioId);
      const problems =
        scenario === undefined
          ? [`未找到演示脚本 ${scenarioId}。`]
          : validateMockScenario(scenario, record.frozenTemplate);
      if (scenario === undefined || problems.length > 0) {
        throw new CoreError(
          CORE_ERROR_CODES.INVALID_INPUT,
          `演示脚本未通过冻结模板校验：${problems[0]}`,
          'MockSimulator.start',
          '在开发进度页选择内置演示脚本后重试。',
        );
      }
      const generation = (record.run?.runGeneration ?? 0) + 1;
      deps.append(taskId, { type: 'task_started', at: deps.timestamp() });
      schedule(taskId, scenarioId, 0, scenario.steps[0].delayMs, generation);
    },

    stop(taskId: string): void {
      clearTimer(taskId);
      const record = readRecord(taskId);
      if (record === null) return;
      if (record.run) {
        persistRun(taskId, {
          ...record.run,
          nextDueAt: null,
          runGeneration: record.run.runGeneration + 1,
        });
      }
      deps.append(taskId, { type: 'task_stopped', at: deps.timestamp() });
    },

    resume(taskId: string): void {
      const record = readRecord(taskId);
      if (record === null) return;
      deps.append(taskId, { type: 'task_resumed', at: deps.timestamp() });
      continueFromPersisted(record, record.run?.runGeneration ?? 0);
    },

    retry(taskId: string): void {
      const record = readRecord(taskId);
      if (record === null) return;
      deps.append(taskId, { type: 'task_resumed', at: deps.timestamp() });
      continueFromPersisted(record, record.run?.runGeneration ?? 0);
    },

    answer(taskId: string, answer: string): void {
      const record = readRecord(taskId);
      if (record === null) return;
      const workspace = projectMockWorkspace(record);
      const lastSequence = workspace.nodes.reduce((max, node) => Math.max(max, node.sequence), 0);
      const requestNode = [...record.events]
        .reverse()
        .find(
          (event): event is Extract<MockTaskEvent, { type: 'human_requested' }> =>
            event.type === 'human_requested',
        );
      deps.append(taskId, {
        type: 'human_answered',
        at: deps.timestamp(),
        node: {
          id: deps.newId('node'),
          sequence: lastSequence + 1,
          agentId: requestNode ? requestNode.node.agentId : '',
          kind: 'human_answer',
          title: HUMAN_ANSWER_TITLE,
          body: answer,
          status: 'confirmed',
          attemptCount: 1,
          inputVersion: null,
        },
        answer,
      });
      continueFromPersisted(record, record.run?.runGeneration ?? 0);
    },

    /**
     * Live streaming preview (plan C): while a RESULT step is due, the mock
     * reveals its body/thinking progressively as the injected clock advances
     * across the step's window `[nextDueAt - delayMs, nextDueAt]`. Purely
     * derived state — nothing is written, so a refresh recomputes it.
     */
    activeTurn(taskId: string): LiveTurn | null {
      const record = readRecord(taskId);
      if (record === null) return null;
      if (projectTaskStatus(record) !== 'running') return null;
      const run = record.run;
      if (run === null || run === undefined || run.nextDueAt === null) return null;
      const scenario = scenarioFor(run.scenarioId);
      if (scenario === undefined || run.nextStepIndex >= scenario.steps.length) return null;
      const step = scenario.steps[run.nextStepIndex];
      if (step.kind !== 'result') return null;
      const windowStart = run.nextDueAt - step.delayMs;
      const progress = Math.min(1, Math.max(0, (deps.clock.now() - windowStart) / step.delayMs));
      const reveal = (full: string): string => full.slice(0, Math.ceil(full.length * progress));
      return {
        agentId: step.agentId,
        turnId: turnIdFor(taskId, run.nextStepIndex),
        status: 'running',
        text: reveal(step.body),
        tools: [],
        updatedAt: deps.timestamp(),
      };
    },
  };

  return simulator;
}
