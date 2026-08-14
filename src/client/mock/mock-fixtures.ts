/**
 * Test-only helpers for the mock gateway. Production components and gateway
 * modules must never import this file; they accept the standard Storage and
 * MockClock interfaces instead.
 */
import type { MockScenarioId, TaskSummary, WorkspaceNode } from '../../shared/contracts';
import { structuredProtocolOf } from '../../shared/authoritative-review-v2';
import type { DevelopmentGateway } from '../gateway/development-gateway';
import type { ForgeCoreGateway } from '../gateway/forge-core-gateway';
import {
  INPUT_CHAPTER_BRIEF_ID,
  REVIEWER_AGENT_ID,
  TEMPLATE_ID,
  WRITER_AGENT_ID,
  templateFixture,
} from './__fixtures__/zhihu-single-chapter';
import { createMockGateway } from './mock-gateway';
import type { MockScenarioDefinition } from './mock-scenarios';
import type { MockClock, MockTaskEvent, MockTaskRecord } from './mock-schema';
import { MOCK_STORAGE_KEYS } from './mock-schema';
import { MockStore } from './mock-store';

/** In-memory Storage implementation with insertion-ordered keys. */
export class MemoryStorage {
  readonly #map = new Map<string, string>();

  get length(): number {
    return this.#map.size;
  }

  clear(): void {
    this.#map.clear();
  }

  getItem(key: string): string | null {
    return this.#map.has(key) ? (this.#map.get(key) as string) : null;
  }

  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null;
  }

  keys(): string[] {
    return [...this.#map.keys()];
  }

  removeItem(key: string): void {
    this.#map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#map.set(key, String(value));
  }
}

/** Deterministic clock with an inspectable, manually advanced timer queue. */
export interface FixedClock extends MockClock {
  advance(ms: number): void;
  runAll(): void;
  readonly pendingTimers: number;
}

export function createFixedClock(startMs: number = Date.UTC(2026, 0, 1)): FixedClock {
  let current = startMs;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;

  const fireNextDue = (limit: number | null): boolean => {
    let chosen: { id: number; at: number; fn: () => void } | null = null;
    for (const [id, timer] of timers) {
      if (limit !== null && timer.at > limit) continue;
      if (!chosen || timer.at < chosen.at || (timer.at === chosen.at && id < chosen.id)) {
        chosen = { id, at: timer.at, fn: timer.fn };
      }
    }
    if (!chosen) return false;
    timers.delete(chosen.id);
    current = Math.max(current, chosen.at);
    chosen.fn();
    return true;
  };

  return {
    now: () => current,
    setTimeout: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: current + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    advance: (ms) => {
      const limit = current + ms;
      while (fireNextDue(limit)) {
        // Timers scheduled by fired callbacks stay due while at <= limit.
      }
      current = limit;
    },
    runAll: () => {
      while (fireNextDue(null)) {
        // Drain until the queue is empty.
      }
    },
    get pendingTimers() {
      return timers.size;
    },
  };
}

/** Shared frozen-time clock for tests that do not advance time. */
export const fixedClock: FixedClock = createFixedClock();

/** A createTask request satisfying the fixture template's declared inputs. */
export const validCreateRequest = {
  templateId: TEMPLATE_ID,
  name: templateFixture.sampleTaskName,
  input: { ...templateFixture.sampleInput },
};

/**
 * The mock simulates basic templates only, so every fixture-derived summary
 * must carry the frozen-snapshot protocol `none` through the shared helper
 * (spec §4.1). Test helpers assert this so a future structured mock fixture
 * cannot accidentally leak a guessed protocol.
 */
export function expectMockBasicProtocol(summary: TaskSummary): void {
  const expected = structuredProtocolOf({ productionMode: 'basic', structuredSlots: null });
  if (summary.structuredProtocol !== expected) {
    throw new Error(
      `mock fixture summary must fail closed to '${expected}', got '${summary.structuredProtocol}'`,
    );
  }
}

/* ------------------------- seeded storage builders ------------------------ */

const SEED_BASE = Date.UTC(2026, 0, 2);
const SEED_CREATED_AT = new Date(SEED_BASE).toISOString();

function at(offsetSeconds: number): string {
  return new Date(SEED_BASE + offsetSeconds * 1000).toISOString();
}

function seedNode(
  id: string,
  sequence: number,
  agentId: string,
  overrides: Partial<WorkspaceNode> = {},
): WorkspaceNode {
  return {
    id,
    sequence,
    agentId,
    kind: 'input',
    title: 'sample node',
    body: 'sample body',
    status: 'active',
    attemptCount: 1,
    inputVersion: null,
    ...overrides,
  };
}

function seedRecord(partial: {
  id: string;
  name: string;
  events: MockTaskEvent[];
}): MockTaskRecord {
  const updatedAt =
    partial.events.length > 0 ? partial.events[partial.events.length - 1].at : SEED_CREATED_AT;
  return {
    id: partial.id,
    name: partial.name,
    templateId: templateFixture.template.id,
    templateName: templateFixture.template.name,
    frozenInput: { ...templateFixture.sampleInput },
    frozenTemplate: structuredClone(templateFixture.template),
    events: partial.events,
    createdAt: SEED_CREATED_AT,
    updatedAt,
  };
}

function buildCompletedEvents(): MockTaskEvent[] {
  const v1 = templateFixture.sampleArtifacts.v1;
  const brief = templateFixture.sampleInput[INPUT_CHAPTER_BRIEF_ID];
  return [
    { type: 'task_started', at: at(1) },
    {
      type: 'agent_input',
      at: at(2),
      node: seedNode('node-seed-writer-input', 1, WRITER_AGENT_ID, {
        title: templateFixture.template.inputFields[0].label,
        body: brief,
      }),
    },
    {
      type: 'agent_result',
      at: at(3),
      node: seedNode('node-seed-writer-result', 2, WRITER_AGENT_ID, {
        kind: 'result',
        status: 'confirmed',
        title: v1.title,
        body: v1.content,
      }),
    },
    {
      type: 'route_executed',
      at: at(4),
      route: {
        id: 'route-seed-submit',
        sequence: 1,
        fromNodeId: 'node-seed-writer-result',
        toNodeId: 'node-seed-reviewer-input',
        kind: 'artifact',
        label: templateFixture.template.routes[0].label,
      },
    },
    {
      type: 'agent_input',
      at: at(5),
      node: seedNode('node-seed-reviewer-input', 3, REVIEWER_AGENT_ID, {
        title: templateFixture.template.routes[0].label,
        body: v1.title,
      }),
    },
    {
      type: 'agent_result',
      at: at(6),
      node: seedNode('node-seed-reviewer-result', 4, REVIEWER_AGENT_ID, {
        kind: 'result',
        status: 'confirmed',
        title: templateFixture.template.finalOutput.name,
        body: v1.content,
      }),
    },
    {
      type: 'artifact_published',
      at: at(7),
      artifact: {
        id: 'artifact-seed-v1',
        version: 1,
        title: v1.title,
        files: [{ name: 'content.md', extract: 'content', content: v1.content }],
        sourceNodeId: 'node-seed-writer-result',
        createdAt: at(7),
        final: false,
      },
    },
    { type: 'final_accepted', at: at(8), artifactId: 'artifact-seed-v1' },
  ];
}

function buildWaitingEvents(): MockTaskEvent[] {
  return [
    { type: 'task_started', at: at(1) },
    {
      type: 'agent_input',
      at: at(2),
      node: seedNode('node-wait-writer-input', 1, WRITER_AGENT_ID, {
        title: templateFixture.template.inputFields[0].label,
        body: templateFixture.sampleInput[INPUT_CHAPTER_BRIEF_ID],
      }),
    },
    {
      type: 'human_requested',
      at: at(3),
      node: seedNode('node-wait-human-request', 2, WRITER_AGENT_ID, { kind: 'human_request' }),
      question: templateFixture.sampleHumanQuestion,
    },
  ];
}

/**
 * Storage pre-seeded through the public MockStore API: one ready task, one
 * completed task, one waiting_human task and one task reserved for corruption
 * tests ('task-corrupt'), plus the fixture catalog and development defaults.
 */
export function seededStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  const clock = createFixedClock(SEED_BASE);
  const store = new MockStore(storage, clock, { templates: [templateFixture.template] });
  store.ensureCatalog();
  store.createTaskRecord(
    seedRecord({ id: 'task-seeded-ready', name: '示例任务 待启动', events: [] }),
  );
  store.createTaskRecord(
    seedRecord({ id: 'task-seeded-completed', name: '示例任务 已完成', events: buildCompletedEvents() }),
  );
  store.createTaskRecord(
    seedRecord({ id: 'task-seeded-waiting', name: '示例任务 等待补充', events: buildWaitingEvents() }),
  );
  store.createTaskRecord(seedRecord({ id: 'task-corrupt', name: '示例任务 待损坏', events: [] }));
  store.saveDevelopment({ nextScenario: 'happy_path' });
  return storage;
}

/**
 * Corrupt one task record in place while keeping the tasks envelope itself
 * schema-valid: the envelope parses, only the addressed record fails
 * validation and must be isolated by the store and gateway.
 */
export function corruptOneTask(storage: MemoryStorage, taskId: string): void {
  const raw = storage.getItem(MOCK_STORAGE_KEYS.tasks);
  if (raw === null) throw new Error('corruptOneTask requires seeded tasks');
  const envelope = JSON.parse(raw) as { data: Record<string, unknown> };
  envelope.data[taskId] = 'corrupted-by-test-harness';
  storage.setItem(MOCK_STORAGE_KEYS.tasks, JSON.stringify(envelope));
}

/* --------------------------- simulator harness ----------------------------
 * TEST ONLY: one deterministic gateway over fresh storage plus a fake clock,
 * pre-selected to a scenario. clock.runAll() drains every pending timer in
 * due-time order, so a whole simulated run completes synchronously. Reading
 * events back through the store is test privilege; production never does.
 */

export interface SimulatorHarness {
  readonly storage: MemoryStorage;
  readonly clock: FixedClock;
  readonly gateway: ForgeCoreGateway & DevelopmentGateway;
  events(taskId: string): MockTaskEvent[];
  createAndRun(request?: typeof validCreateRequest): Promise<TaskSummary>;
}

export function createSimulatorHarness(
  scenarioId: MockScenarioId,
  options: { scenarios?: MockScenarioDefinition[] } = {},
): SimulatorHarness {
  const storage = new MemoryStorage();
  const clock = createFixedClock();
  const store = new MockStore(storage, clock, { templates: [templateFixture.template] });
  store.ensureCatalog();
  // An explicit development selection, so startTask plays this scenario.
  store.saveDevelopment({ nextScenario: scenarioId });
  const gateway = createMockGateway(storage, clock, options);
  return {
    storage,
    clock,
    gateway,
    events: (taskId) => {
      const entry = store.getTaskEntry(taskId);
      if (entry === null || entry.corrupt) {
        throw new Error(`harness.events: missing task ${taskId}`);
      }
      return structuredClone(entry.record.events);
    },
    createAndRun: async (request = validCreateRequest) => {
      const task = await gateway.createTask(request);
      await gateway.startTask(task.id);
      return task;
    },
  };
}

/**
 * Greatest number of simultaneously active agents in an event sequence:
 * agent_input starts activity for its agent; agent_result or
 * agent_attempt_failed (resolved through the node's input event) ends it.
 * Serial scripts must never exceed one.
 */
export function maximumConcurrentActiveAgents(events: MockTaskEvent[]): number {
  const agentByNode = new Map<string, string>();
  const active = new Set<string>();
  let maximum = 0;
  for (const event of events) {
    if (event.type === 'agent_input') {
      agentByNode.set(event.node.id, event.node.agentId);
      active.add(event.node.agentId);
    } else if (event.type === 'agent_result') {
      active.delete(event.node.agentId);
    } else if (event.type === 'agent_attempt_failed') {
      const agentId = agentByNode.get(event.nodeId);
      if (agentId !== undefined) active.delete(agentId);
    }
    maximum = Math.max(maximum, active.size);
  }
  return maximum;
}
