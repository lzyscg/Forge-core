// @vitest-environment node
/**
 * Attempt coordinator tests (Task 11 Steps 1-3, 6).
 *
 * The coordinator owns the concurrency/safety-critical layer of the
 * structured slot engine: deterministic attempt-epoch allocation (CAS inside
 * the task mutex), the terminal-batch authority (exactly one terminal per
 * started attempt, the six legal status/reason pairs, fill draft terminals
 * never without an opened event) and startup dangling recovery. Tests run
 * against the REAL EventStore so the CAS/idempotency/replay semantics are the
 * authoritative Task 6 primitives, never a mock.
 *
 * No business vocabulary lives here (iron rule 1): node/agent/attempt ids are
 * stable platform identifiers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  disposeAllTestRoots,
  makeEventNode,
  makeTaskEvent,
  makeTempCorePaths,
} from '../../test-support';
import { EventStore, type CommittedEvent } from '../../storage/event-store';
import type { StructuredAttemptReason, StructuredAttemptStatus, TaskEvent } from '../../storage/task-events';
import {
  CoordinatorError,
  activeAttemptForInput,
  recoverDanglingAttempts,
  startAttempt,
  terminalize,
} from './attempt-coordinator';

afterEach(() => {
  disposeAllTestRoots();
});

function isAttemptTerminal(
  event: TaskEvent,
): event is Extract<TaskEvent, { type: 'structured_slot_attempt_terminal' }> {
  return event.type === 'structured_slot_attempt_terminal';
}

function isDraftTerminal(
  event: TaskEvent,
): event is Extract<TaskEvent, { type: 'structured_fill_draft_terminal' }> {
  return event.type === 'structured_fill_draft_terminal';
}

/** A real store + pre-bound coordinator primitives for one task. */
async function coordinatorContext(): Promise<{
  paths: ReturnType<typeof makeTempCorePaths>['paths'];
  taskId: string;
  store: EventStore;
  readEvents: () => Promise<CommittedEvent[]>;
  appendBatch: (commitId: string, events: readonly TaskEvent[], expectedLastSequence: number) => Promise<CommittedEvent[]>;
  seedInput: (inputNodeId: string, agentId?: string) => Promise<void>;
}> {
  const { paths } = makeTempCorePaths();
  const taskId = 'task-coordinator';
  const store = new EventStore(paths);
  await store.append(
    taskId,
    makeTaskEvent({ type: 'task_started', at: '2026-01-01T00:00:00.000Z' }),
  );
  return {
    paths,
    taskId,
    store,
    readEvents: () => store.read(taskId),
    appendBatch: (commitId, events, expectedLastSequence) =>
      store.appendBatch(taskId, commitId, events, { expectedLastSequence }),
    async seedInput(inputNodeId, agentId = 'agent-a') {
      const committed = await store.read(taskId);
      const sequence =
        1 +
        Math.max(
          0,
          ...committed
            .map((entry) => entry.event)
            .filter((event) => 'node' in event)
            .map((event) => event.node.sequence),
        );
      await store.append(
        taskId,
        makeTaskEvent({
          id: inputNodeId,
          at: '2026-01-01T00:00:00.000Z',
          type: 'agent_input',
          node: makeEventNode({ sequence, agentId, kind: 'input' }),
        }),
      );
    },
  };
}

describe('activeAttemptForInput (pure projection)', () => {
  const started = (turnId: string, inputNodeId = 'input-1', sessionKind = 'structure'): TaskEvent =>
    makeTaskEvent({
      type: 'structured_slot_attempt_started',
      inputNodeId,
      agentId: 'agent-a',
      attemptEpoch: 1,
      turnId,
      sessionKind,
    } as never) as TaskEvent;

  const terminal = (turnId: string): TaskEvent =>
    makeTaskEvent({
      type: 'structured_slot_attempt_terminal',
      inputNodeId: 'input-1',
      attemptEpoch: 1,
      turnId,
      status: 'abandoned',
      reason: 'crash_recovery',
    } as never) as TaskEvent;

  it('returns null with no committed attempt', () => {
    expect(activeAttemptForInput([], 'input-1')).toBeNull();
  });

  it('returns the latest started-without-terminal attempt for the input', () => {
    const attempt = activeAttemptForInput([started('input-1-t1')], 'input-1');
    expect(attempt).toEqual({
      inputNodeId: 'input-1',
      attemptEpoch: 1,
      turnId: 'input-1-t1',
      sessionKind: 'structure',
    });
  });

  it('returns null once the attempt has a terminal', () => {
    expect(
      activeAttemptForInput([started('input-1-t1'), terminal('input-1-t1')], 'input-1'),
    ).toBeNull();
  });

  it('ignores terminalized attempts and reports the latest open one', () => {
    const events = [
      started('input-1-t1'),
      terminal('input-1-t1'),
      started('input-1-t2'),
    ];
    const attempt = activeAttemptForInput(events, 'input-1');
    expect(attempt?.turnId).toBe('input-1-t2');
  });

  it('ignores attempts of other input nodes', () => {
    const events = [started('input-9-t1', 'input-9', 'seal')];
    expect(activeAttemptForInput(events, 'input-1')).toBeNull();
  });
});

describe('startAttempt — deterministic epoch allocation (CAS)', () => {
  it('two concurrent starts for one input win a single epoch-1 batch deterministically', async () => {
    const ctx = await coordinatorContext();
    await ctx.seedInput('input-1');

    const events = await ctx.readEvents();
    const call = {
      taskId: ctx.taskId,
      inputNodeId: 'input-1',
      agentId: 'agent-a',
      sessionKind: 'structure' as const,
      events,
      readEvents: ctx.readEvents,
      appendBatch: ctx.appendBatch,
    };
    const [first, second] = await Promise.all([startAttempt(call), startAttempt(call)]);

    expect(first.attemptEpoch).toBe(1);
    expect(first.turnId).toBe('input-1-t1');
    expect(second.attemptEpoch).toBe(1);
    expect(second.turnId).toBe('input-1-t1');
    expect(second.turnId).toBe(first.turnId);

    const finalEvents = await ctx.readEvents();
    const started = finalEvents.filter(
      (entry) => entry.event.type === 'structured_slot_attempt_started',
    );
    expect(started).toHaveLength(1);
    expect(started[0]?.event).toMatchObject({
      inputNodeId: 'input-1',
      agentId: 'agent-a',
      attemptEpoch: 1,
      turnId: 'input-1-t1',
      sessionKind: 'structure',
    });
  });

  it('allocates strictly increasing epochs after a terminal', async () => {
    const ctx = await coordinatorContext();
    await ctx.seedInput('input-1');

    const events = await ctx.readEvents();
    const base = {
      taskId: ctx.taskId,
      inputNodeId: 'input-1',
      agentId: 'agent-a',
      sessionKind: 'structure' as const,
      readEvents: ctx.readEvents,
      appendBatch: ctx.appendBatch,
    };
    const first = await startAttempt({ ...base, events });
    const tail1 = (await ctx.readEvents()).at(-1)!.sequence;
    await terminalize({
      taskId: ctx.taskId,
      inputNodeId: 'input-1',
      attemptEpoch: first.attemptEpoch,
      turnId: first.turnId,
      status: 'abandoned',
      reason: 'task_stop',
      expectedTail: tail1,
      readEvents: ctx.readEvents,
      appendBatch: ctx.appendBatch,
    });

    const second = await startAttempt({ ...base, events: await ctx.readEvents() });
    expect(second.attemptEpoch).toBe(2);
    expect(second.turnId).toBe('input-1-t2');
  });

  it('fill start appends exactly attempt_started + deterministic draft_opened in ONE batch', async () => {
    const ctx = await coordinatorContext();
    await ctx.seedInput('input-1');

    const result = await startAttempt({
      taskId: ctx.taskId,
      inputNodeId: 'input-1',
      agentId: 'agent-a',
      sessionKind: 'fill',
      events: await ctx.readEvents(),
      readEvents: ctx.readEvents,
      appendBatch: ctx.appendBatch,
      draftContext: { scaffoldId: 'scaffold-1', generationId: 'gen-1', baseRevision: 0 },
    });
    expect(result.turnId).toBe('input-1-t1');

    const batch = await ctx.store.readBatchByCommitId(ctx.taskId, 'input-1-t1-start');
    expect(batch).not.toBeNull();
    const batchEvents = batch!.map((entry) => entry.event);
    expect(batchEvents.map((event) => event.type).sort()).toEqual([
      'structured_fill_draft_opened',
      'structured_slot_attempt_started',
    ]);
    const started = batchEvents.find(
      (event) => event.type === 'structured_slot_attempt_started',
    )!;
    expect(started).toMatchObject({
      inputNodeId: 'input-1',
      agentId: 'agent-a',
      attemptEpoch: 1,
      turnId: 'input-1-t1',
      sessionKind: 'fill',
    });
    const opened = batchEvents.find((event) => event.type === 'structured_fill_draft_opened')!;
    expect(opened).toMatchObject({
      draftId: 'input-1-t1-draft',
      turnId: 'input-1-t1',
      scaffoldId: 'scaffold-1',
      generationId: 'gen-1',
      baseRevision: 0,
    });
  });

  it('requires the fill draft context (scaffold/generation/baseRevision)', async () => {
    const ctx = await coordinatorContext();
    await ctx.seedInput('input-1');
    await expect(
      startAttempt({
        taskId: ctx.taskId,
        inputNodeId: 'input-1',
        agentId: 'agent-a',
        sessionKind: 'fill',
        events: await ctx.readEvents(),
        readEvents: ctx.readEvents,
        appendBatch: ctx.appendBatch,
      }),
    ).rejects.toThrow(CoordinatorError);
  });
});

describe('terminalize — terminal batch authority', () => {
  it('completion and stop racing concurrently commit exactly one terminal; the loser returns it', async () => {
    const ctx = await coordinatorContext();
    await ctx.seedInput('input-1');
    const start = await startAttempt({
      taskId: ctx.taskId,
      inputNodeId: 'input-1',
      agentId: 'agent-a',
      sessionKind: 'structure',
      events: await ctx.readEvents(),
      readEvents: ctx.readEvents,
      appendBatch: ctx.appendBatch,
    });
    const tail = (await ctx.readEvents()).at(-1)!.sequence;

    const common = {
      taskId: ctx.taskId,
      inputNodeId: 'input-1',
      attemptEpoch: start.attemptEpoch,
      turnId: start.turnId,
      expectedTail: tail,
      readEvents: ctx.readEvents,
      appendBatch: ctx.appendBatch,
    };
    const completion = terminalize({
      ...common,
      status: 'committed' as const,
      reason: 'completion_dispatch' as const,
      companions: [
        makeTaskEvent({
          at: '2026-01-01T00:00:00.000Z',
          type: 'agent_result',
          node: makeEventNode({ sequence: 2, kind: 'result' }),
        }),
      ],
    });
    const stop = terminalize({
      ...common,
      status: 'abandoned' as const,
      reason: 'task_stop' as const,
      companions: [makeTaskEvent({ at: '2026-01-01T00:00:00.000Z', type: 'task_stopped' })],
    });
    const [completionResult, stopResult] = await Promise.all([completion, stop]);

    const finalEvents = await ctx.readEvents();
    const terminalEvents = finalEvents.map((entry) => entry.event).filter(isAttemptTerminal);
    expect(terminalEvents).toHaveLength(1);
    // Both callers observe the committed terminal — never a second write.
    for (const result of [completionResult, stopResult]) {
      expect(
        result.committed.some(
          (entry) => entry.event.type === 'structured_slot_attempt_terminal',
        ),
      ).toBe(true);
    }
    const surviving = terminalEvents[0]!;
    expect(['committed', 'abandoned']).toContain(surviving.status);
  });

  it('accepts exactly the six legal status/reason pairs', async () => {
    const ctx = await coordinatorContext();
    const pairs: ReadonlyArray<readonly [StructuredAttemptStatus, StructuredAttemptReason]> = [
      ['committed', 'completion_dispatch'],
      ['committed', 'rework_dispatch'],
      ['failed', 'runtime_failure'],
      ['abandoned', 'task_stop'],
      ['abandoned', 'crash_recovery'],
      ['waiting_human', 'human_request'],
    ];
    for (const [index, [status, reason]] of pairs.entries()) {
      const inputNodeId = `input-legal-${index + 1}`;
      await ctx.seedInput(inputNodeId);
      const start = await startAttempt({
        taskId: ctx.taskId,
        inputNodeId,
        agentId: 'agent-a',
        sessionKind: 'structure',
        events: await ctx.readEvents(),
        readEvents: ctx.readEvents,
        appendBatch: ctx.appendBatch,
      });
      const tail = (await ctx.readEvents()).at(-1)!.sequence;
      const result = await terminalize({
        taskId: ctx.taskId,
        inputNodeId,
        attemptEpoch: start.attemptEpoch,
        turnId: start.turnId,
        status,
        reason,
        expectedTail: tail,
        readEvents: ctx.readEvents,
        appendBatch: ctx.appendBatch,
      });
      expect(
        result.committed.some(
          (entry) =>
            entry.event.type === 'structured_slot_attempt_terminal' &&
            entry.event.status === status &&
            entry.event.reason === reason,
        ),
      ).toBe(true);
    }
  });

  it('rejects any other status/reason pair with a stable error and writes nothing', async () => {
    const ctx = await coordinatorContext();
    await ctx.seedInput('input-illegal');
    const start = await startAttempt({
      taskId: ctx.taskId,
      inputNodeId: 'input-illegal',
      agentId: 'agent-a',
      sessionKind: 'structure',
      events: await ctx.readEvents(),
      readEvents: ctx.readEvents,
      appendBatch: ctx.appendBatch,
    });
    const tail = (await ctx.readEvents()).at(-1)!.sequence;
    const illegal: ReadonlyArray<readonly [StructuredAttemptStatus, StructuredAttemptReason]> = [
      ['committed', 'runtime_failure'],
      ['failed', 'completion_dispatch'],
      ['failed', 'task_stop'],
      ['abandoned', 'runtime_failure'],
      ['abandoned', 'human_request'],
      ['waiting_human', 'completion_dispatch'],
      ['committed', 'crash_recovery'],
    ];
    for (const [status, reason] of illegal) {
      await expect(
        terminalize({
          taskId: ctx.taskId,
          inputNodeId: 'input-illegal',
          attemptEpoch: start.attemptEpoch,
          turnId: start.turnId,
          status,
          reason,
          expectedTail: tail,
          readEvents: ctx.readEvents,
          appendBatch: ctx.appendBatch,
        }),
      ).rejects.toThrow(/ILLEGAL_TERMINAL_PAIR/);
    }
    const finalEvents = await ctx.readEvents();
    expect(
      finalEvents.some((entry) => entry.event.type === 'structured_slot_attempt_terminal'),
    ).toBe(false);
  });

  it('refuses a fill draft terminal companion without its opened event', async () => {
    const ctx = await coordinatorContext();
    await ctx.seedInput('input-noopen');
    // A fill start committed WITHOUT the deterministic draft_opened is a
    // corrupted/incomplete history; the terminal must never validate on it.
    const events0 = await ctx.readEvents();
    const tail0 = events0.at(-1)!.sequence;
    await ctx.appendBatch(
      'input-noopen-t1-start',
      [
        makeTaskEvent({
          id: 'input-noopen-t1-attempt-started',
          at: '2026-01-01T00:00:00.000Z',
          type: 'structured_slot_attempt_started',
          inputNodeId: 'input-noopen',
          agentId: 'agent-a',
          attemptEpoch: 1,
          turnId: 'input-noopen-t1',
          sessionKind: 'fill',
        }),
      ],
      tail0,
    );
    const tail = (await ctx.readEvents()).at(-1)!.sequence;
    await expect(
      terminalize({
        taskId: ctx.taskId,
        inputNodeId: 'input-noopen',
        attemptEpoch: 1,
        turnId: 'input-noopen-t1',
        status: 'committed',
        reason: 'completion_dispatch',
        companions: [
          makeTaskEvent({
            id: 'input-noopen-t1-draft-terminal',
            at: '2026-01-01T00:00:00.000Z',
            type: 'structured_fill_draft_terminal',
            draftId: 'input-noopen-t1-draft',
            turnId: 'input-noopen-t1',
            status: 'merged',
            baseRevision: 0,
            resultRevision: 0,
            changeCount: 1,
            content: null,
          }),
        ],
        expectedTail: tail,
        readEvents: ctx.readEvents,
        appendBatch: ctx.appendBatch,
      }),
    ).rejects.toThrow(/FILL_DRAFT_NOT_OPENED/);
    expect(
      (await ctx.readEvents()).some((entry) => entry.event.type === 'structured_slot_attempt_terminal'),
    ).toBe(false);
  });

  it('accepts a fill draft terminal companion when the draft was opened', async () => {
    const ctx = await coordinatorContext();
    await ctx.seedInput('input-open');
    const start = await startAttempt({
      taskId: ctx.taskId,
      inputNodeId: 'input-open',
      agentId: 'agent-a',
      sessionKind: 'fill',
      events: await ctx.readEvents(),
      readEvents: ctx.readEvents,
      appendBatch: ctx.appendBatch,
      draftContext: { scaffoldId: 'scaffold-1', generationId: 'gen-1', baseRevision: 0 },
    });
    const tail = (await ctx.readEvents()).at(-1)!.sequence;
    const result = await terminalize({
      taskId: ctx.taskId,
      inputNodeId: 'input-open',
      attemptEpoch: start.attemptEpoch,
      turnId: start.turnId,
      status: 'committed',
      reason: 'completion_dispatch',
      companions: [
        makeTaskEvent({
          at: '2026-01-01T00:00:00.000Z',
          type: 'structured_fill_draft_terminal',
          draftId: 'input-open-t1-draft',
          turnId: start.turnId,
          status: 'merged',
          baseRevision: 0,
          resultRevision: 0,
          changeCount: 1,
          content: null,
        }),
      ],
      expectedTail: tail,
      readEvents: ctx.readEvents,
      appendBatch: ctx.appendBatch,
    });
    expect(
      result.committed.some((entry) => entry.event.type === 'structured_fill_draft_terminal'),
    ).toBe(true);
  });
});

describe('recoverDanglingAttempts — startup crash recovery', () => {
  it('closes every started-without-terminal attempt and writes Draft terminals when opened', async () => {
    const ctx = await coordinatorContext();
    // A fill attempt with an opened draft (dangling).
    await ctx.seedInput('input-fill');
    await startAttempt({
      taskId: ctx.taskId,
      inputNodeId: 'input-fill',
      agentId: 'agent-a',
      sessionKind: 'fill',
      events: await ctx.readEvents(),
      readEvents: ctx.readEvents,
      appendBatch: ctx.appendBatch,
      draftContext: { scaffoldId: 'scaffold-1', generationId: 'gen-1', baseRevision: 3 },
    });
    // A structure attempt (dangling, no draft).
    await ctx.seedInput('input-struct');
    await startAttempt({
      taskId: ctx.taskId,
      inputNodeId: 'input-struct',
      agentId: 'agent-a',
      sessionKind: 'structure',
      events: await ctx.readEvents(),
      readEvents: ctx.readEvents,
      appendBatch: ctx.appendBatch,
    });
    // An already-closed attempt (never reopened by recovery).
    await ctx.seedInput('input-closed');
    const closedStart = await startAttempt({
      taskId: ctx.taskId,
      inputNodeId: 'input-closed',
      agentId: 'agent-a',
      sessionKind: 'structure',
      events: await ctx.readEvents(),
      readEvents: ctx.readEvents,
      appendBatch: ctx.appendBatch,
    });
    const closedTail = (await ctx.readEvents()).at(-1)!.sequence;
    await terminalize({
      taskId: ctx.taskId,
      inputNodeId: 'input-closed',
      attemptEpoch: closedStart.attemptEpoch,
      turnId: closedStart.turnId,
      status: 'abandoned',
      reason: 'crash_recovery',
      expectedTail: closedTail,
      readEvents: ctx.readEvents,
      appendBatch: ctx.appendBatch,
    });

    const result = await recoverDanglingAttempts({
      taskId: ctx.taskId,
      events: await ctx.readEvents(),
      appendBatch: ctx.appendBatch,
    });
    expect(result.closed).toBe(2);

    const finalEvents = await ctx.readEvents();
    const terminalEvents = finalEvents.map((entry) => entry.event).filter(isAttemptTerminal);
    // input-fill + input-struct recovered; input-closed untouched.
    expect(terminalEvents).toHaveLength(3);
    const recovered = terminalEvents.filter(
      (event) => event.reason === 'crash_recovery' && event.status === 'abandoned',
    );
    expect(recovered.map((event) => event.turnId).sort()).toEqual([
      'input-closed-t1',
      'input-fill-t1',
      'input-struct-t1',
    ]);
    const draftTerminalEvents = finalEvents
      .map((entry) => entry.event)
      .filter(isDraftTerminal);
    expect(draftTerminalEvents).toHaveLength(1);
    expect(draftTerminalEvents[0]).toMatchObject({
      draftId: 'input-fill-t1-draft',
      turnId: 'input-fill-t1',
      status: 'abandoned',
      baseRevision: 3,
    });
  });

  it('writes no Draft terminal for a fill start without an opened event', async () => {
    const ctx = await coordinatorContext();
    await ctx.seedInput('input-fill-noopen');
    const events0 = await ctx.readEvents();
    const tail0 = events0.at(-1)!.sequence;
    await ctx.appendBatch(
      'input-fill-noopen-t1-start',
      [
        makeTaskEvent({
          id: 'input-fill-noopen-t1-attempt-started',
          at: '2026-01-01T00:00:00.000Z',
          type: 'structured_slot_attempt_started',
          inputNodeId: 'input-fill-noopen',
          agentId: 'agent-a',
          attemptEpoch: 1,
          turnId: 'input-fill-noopen-t1',
          sessionKind: 'fill',
        }),
      ],
      tail0,
    );
    await recoverDanglingAttempts({
      taskId: ctx.taskId,
      events: await ctx.readEvents(),
      appendBatch: ctx.appendBatch,
    });
    const finalEvents = await ctx.readEvents();
    const recovered = finalEvents.filter(
      (entry) =>
        entry.event.type === 'structured_slot_attempt_terminal' &&
        entry.event.turnId === 'input-fill-noopen-t1',
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.event).toMatchObject({ status: 'abandoned', reason: 'crash_recovery' });
    expect(
      finalEvents.some(
        (entry) =>
          entry.event.type === 'structured_fill_draft_terminal' &&
          entry.event.draftId === 'input-fill-noopen-t1-draft',
      ),
    ).toBe(false);
  });

  it('is a no-op when no attempt is dangling', async () => {
    const ctx = await coordinatorContext();
    const before = await ctx.readEvents();
    const result = await recoverDanglingAttempts({
      taskId: ctx.taskId,
      events: before,
      appendBatch: ctx.appendBatch,
    });
    expect(result.closed).toBe(0);
    expect(result.committed).toBeNull();
    const after = await ctx.readEvents();
    expect(after.map((entry) => entry.sequence)).toEqual(
      before.map((entry) => entry.sequence),
    );
  });
});
