/**
 * Test-only rendering harness for page-level tests. Production modules must
 * never import this file: it wraps the real router and a real MockGateway so
 * pages are exercised exactly as they will be in the browser, while recording
 * every Gateway call for assertions.
 */
import { render, type RenderResult } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import type { TaskWorkspace } from '../shared/contracts';
import type { DevelopmentGateway } from './gateway/development-gateway';
import type { ForgeCoreGateway } from './gateway/forge-core-gateway';
import { GatewayProvider } from './gateway/gateway-context';
import {
  REVIEWER_AGENT_ID,
  WRITER_AGENT_ID,
  templateFixture,
} from './mock/__fixtures__/zhihu-single-chapter';
import { MemoryStorage, fixedClock } from './mock/mock-fixtures';
import { createMockGateway } from './mock/mock-gateway';
import type { MockClock } from './mock/mock-schema';
import { routes } from './router';

export type RecordedCalls = Record<string, unknown[][]>;

export type RecordingGateway = ForgeCoreGateway &
  DevelopmentGateway & { readonly calls: RecordedCalls };

/**
 * Wraps a fresh MockGateway (MemoryStorage + fixed clock by default) in a
 * transparent proxy that records each method's call arguments without
 * changing return values. Tests may inject their own storage/clock, e.g. to
 * render pages over seeded task data.
 */
export function recordingGateway(
  storage: Storage = new MemoryStorage(),
  clock: MockClock = fixedClock,
): RecordingGateway {
  const base = createMockGateway(storage, clock);
  const calls: RecordedCalls = {};
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'calls') return calls;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop === 'symbol') return value;
      return (...args: unknown[]) => {
        (calls[prop] ??= []).push(args);
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as RecordingGateway;
}

/**
 * Gateway stub whose every method rejects unless overridden; pages under test
 * only touch the operations a test explicitly supplies.
 */
export function stubGateway(
  overrides: Partial<ForgeCoreGateway & DevelopmentGateway> = {},
): ForgeCoreGateway & DevelopmentGateway {
  const unused = (): Promise<never> =>
    Promise.reject(new Error('stub gateway: method not overridden in this test'));
  const base: ForgeCoreGateway & DevelopmentGateway = {
    listTemplates: unused,
    getTemplate: unused,
    reloadTemplate: unused,
    createTask: unused,
    listTasks: unused,
    getWorkspace: unused,
    startTask: unused,
    stopTask: unused,
    resumeTask: unused,
    retryTask: unused,
    answerHuman: unused,
    submitHumanDecision: unused,
    watchTask: () => () => {},
    getTurnTrace: unused,
    getSkillContent: unused,
    cloneTask: unused,
    deleteTask: unused,
    reopenFailed: unused,
    getStructuredContract: unused,
    listStructuredSlots: unused,
    getStructuredSlot: unused,
    listStructuredIssues: unused,
    getStructuredSeal: unused,
    getCapabilities: unused,
    getNextScenario: unused,
    setNextScenario: unused,
    resetMockData: unused,
  };
  return { ...base, ...overrides };
}

export interface RenderPageResult extends RenderResult {
  router: ReturnType<typeof createMemoryRouter>;
}

/**
 * Renders the real route tree at `path` inside a memory router with the given
 * Gateway injected. Returns the Testing Library render result plus the router
 * so navigation assertions can inspect `router.state.location`.
 */
export function renderPage(
  path: string,
  gateway: ForgeCoreGateway & DevelopmentGateway = recordingGateway(),
): RenderPageResult {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const rendered = render(
    <GatewayProvider core={gateway} development={gateway}>
      <RouterProvider router={router} />
    </GatewayProvider>,
  );
  return { ...rendered, router };
}

/* ------------------------ jsdom layout stand-ins --------------------------
 * TEST ONLY: jsdom ships no layout engine, so production code paths that
 * probe ResizeObserver / scrollIntoView with capability checks would skip
 * entirely. Installing callable stand-ins (never fake geometry) lets those
 * code paths run and be spied on. Production browsers need neither.
 */

/** Idempotent installer; called on import so every page test gets the stubs. */
export function installDomLayoutMocks(): void {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  }
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  }
}

installDomLayoutMocks();

/* --------------------- return-loop workspace fixture ----------------------
 * TEST DATA: built exclusively from the public TaskWorkspace contract. The
 * business copy mirrors the fixture template so page tests can assert real
 * lane headings while exercising a full write→review→return→rewrite→final
 * loop: 8 nodes, 3 executed routes, 2 artifact versions (V2 final).
 */

export const RETURN_LOOP_TASK_ID = 'task-return-loop';

export function workspaceWithReturnLoop(): TaskWorkspace {
  const template = templateFixture.template;
  const brief = templateFixture.sampleInput;
  const v1 = templateFixture.sampleArtifacts.v1;
  const v2 = templateFixture.sampleArtifacts.v2;
  const submitLabel = template.routes[0].label;
  const returnLabel = template.routes[1].label;

  return {
    task: {
      id: RETURN_LOOP_TASK_ID,
      name: templateFixture.sampleTaskName,
      templateId: template.id,
      templateName: template.name,
      status: 'completed',
      currentAgentName: null,
      latestVersion: 2,
      updatedAt: '2026-01-02T00:00:08.000Z',
      diagnostic: null,
      structuredProtocol: 'none',
    },
    frozenInput: { ...brief },
    templateVersion: template.version,
    agents: structuredClone(template.agents),
    declaredRoutes: structuredClone(template.routes),
    nodes: [
      {
        id: 'rl-writer-input-1',
        sequence: 1,
        agentId: WRITER_AGENT_ID,
        kind: 'input',
        title: template.inputFields[0].label,
        body: brief[template.inputFields[0].id],
        status: 'confirmed',
        attemptCount: 1,
        inputVersion: null,
      },
      {
        id: 'rl-writer-result-1',
        sequence: 2,
        agentId: WRITER_AGENT_ID,
        kind: 'result',
        title: v1.title,
        body: v1.content,
        status: 'confirmed',
        attemptCount: 1,
        inputVersion: 1,
      },
      {
        id: 'rl-reviewer-input-1',
        sequence: 3,
        agentId: REVIEWER_AGENT_ID,
        kind: 'input',
        title: submitLabel,
        body: v1.title,
        status: 'confirmed',
        attemptCount: 1,
        inputVersion: null,
      },
      {
        id: 'rl-reviewer-result-1',
        sequence: 4,
        agentId: REVIEWER_AGENT_ID,
        kind: 'result',
        title: returnLabel,
        body: '第二节节奏过快，退回修改意见：补足人物反应并压低对话密度。',
        status: 'confirmed',
        attemptCount: 1,
        inputVersion: null,
      },
      {
        id: 'rl-writer-input-2',
        sequence: 5,
        agentId: WRITER_AGENT_ID,
        kind: 'input',
        title: returnLabel,
        body: '第二节节奏过快，退回修改意见：补足人物反应并压低对话密度。',
        status: 'confirmed',
        attemptCount: 1,
        inputVersion: null,
      },
      {
        id: 'rl-writer-result-2',
        sequence: 6,
        agentId: WRITER_AGENT_ID,
        kind: 'result',
        title: v2.title,
        body: v2.content,
        status: 'confirmed',
        attemptCount: 2,
        inputVersion: 2,
      },
      {
        id: 'rl-reviewer-input-2',
        sequence: 7,
        agentId: REVIEWER_AGENT_ID,
        kind: 'input',
        title: submitLabel,
        body: v2.title,
        status: 'confirmed',
        attemptCount: 1,
        inputVersion: null,
      },
      {
        id: 'rl-reviewer-result-2',
        sequence: 8,
        agentId: REVIEWER_AGENT_ID,
        kind: 'result',
        title: template.finalOutput.name,
        body: v2.content,
        status: 'confirmed',
        attemptCount: 1,
        inputVersion: null,
      },
    ],
    executedRoutes: [
      {
        id: 'rl-route-submit-1',
        sequence: 1,
        fromNodeId: 'rl-writer-result-1',
        toNodeId: 'rl-reviewer-input-1',
        kind: 'artifact',
        label: submitLabel,
      },
      {
        id: 'rl-route-return',
        sequence: 2,
        fromNodeId: 'rl-reviewer-result-1',
        toNodeId: 'rl-writer-input-2',
        kind: 'message',
        label: returnLabel,
      },
      {
        id: 'rl-route-submit-2',
        sequence: 3,
        fromNodeId: 'rl-writer-result-2',
        toNodeId: 'rl-reviewer-input-2',
        kind: 'artifact',
        label: submitLabel,
      },
    ],
    artifacts: [
      {
        id: 'rl-artifact-v1',
        version: 1,
        title: v1.title,
        files: [{ name: 'content.md', extract: 'content', content: v1.content }],
        sourceNodeId: 'rl-writer-result-1',
        createdAt: '2026-01-02T00:00:03.000Z',
        final: false,
      },
      {
        id: 'rl-artifact-v2',
        version: 2,
        title: v2.title,
        files: [{ name: 'content.md', extract: 'content', content: v2.content }],
        sourceNodeId: 'rl-writer-result-2',
        createdAt: '2026-01-02T00:00:06.000Z',
        final: true,
      },
    ],
    pendingHumanQuestion: null,
    pendingHumanSource: null,
  };
}

/**
 * Renders the production page at `/tasks/<workspace.task.id>` with a Gateway
 * whose getWorkspace returns the given workspace (watchTask stays a no-op
 * unless the test supplies its own Gateway).
 */
export function renderProductionPage(
  workspace: TaskWorkspace,
  gateway: ForgeCoreGateway & DevelopmentGateway = stubGateway({
    getWorkspace: async () => workspace,
  }),
): RenderPageResult {
  return renderPage(`/tasks/${workspace.task.id}`, gateway);
}
