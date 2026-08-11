// @vitest-environment node
/**
 * Attempt meter tests (Task 11 Steps 2-3, 5).
 *
 * The persistent resource meter pins the pre-validation semantics of spec §5 /
 * design §7.6 + N04: only a recorded cached result makes an exact replay free;
 * every other call (changed args, invalid/unauthorized, a different
 * toolCallId, a re-precharge without a result) counts; the call beyond the
 * exact per-attempt max closes the Attempt with RESOURCE_LIMIT_EXCEEDED; the
 * wall-clock deadline aborts the composite signal even with NO tool call and
 * the coordinator surfaces failed/runtime_failure; compaction/session
 * continuation NEVER resets the meter (persisted snapshot is the truth).
 *
 * No business vocabulary lives here (iron rule 1): tool/turn ids are stable
 * platform identifiers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { disposeAllTestRoots, makeEventNode, makeTaskEvent, makeTempCorePaths } from '../../test-support';
import type { StructuredSlotLimitsV1 } from '../../../shared/structured-slots';
import { EventStore } from '../../storage/event-store';
import { StructuredSlotPrivateStore } from '../../storage/structured-slot-private-store';
import { STRUCTURED_SLOT_PROFILE_CANDIDATE } from '../../structured-slots/platform-profile';
import { startAttempt, terminalize } from './attempt-coordinator';
import { AttemptMeter, RESOURCE_LIMIT_EXCEEDED } from './attempt-meter';

afterEach(() => {
  disposeAllTestRoots();
});

/** Profile-shaped limits with the attempt group overridden for the test. */
function attemptLimits(
  overrides: Partial<StructuredSlotLimitsV1['attempt']> = {},
): StructuredSlotLimitsV1 {
  return {
    ...STRUCTURED_SLOT_PROFILE_CANDIDATE,
    attempt: { ...STRUCTURED_SLOT_PROFILE_CANDIDATE.attempt, ...overrides },
  };
}

interface MeterHarness {
  paths: ReturnType<typeof makeTempCorePaths>['paths'];
  taskId: string;
  privateStore: StructuredSlotPrivateStore;
}

async function meterHarness(taskId = 'task-meter'): Promise<MeterHarness> {
  const { paths } = makeTempCorePaths();
  return { paths, taskId, privateStore: new StructuredSlotPrivateStore(paths, taskId) };
}

/** A fake monotonic clock + timer: tests advance `now` and fire timers. */
function fakeClock(startMs = 0): {
  now: number;
  monotonicNow: () => number;
  setTimeoutFn: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn: (handle: unknown) => void;
  fireTimers: () => void;
} {
  const state = { now: startMs, timers: [] as Array<{ cb: () => void }> };
  return {
    get now(): number {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
    monotonicNow: () => state.now,
    setTimeoutFn: (cb) => {
      const timer = { cb };
      state.timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => undefined,
    fireTimers: () => {
      for (const timer of [...state.timers]) {
        timer.cb();
      }
    },
  };
}

describe('AttemptMeter — persistent precharge/result signatures', () => {
  it('counts exact calls without a cached result, frees exact replays after recordToolResult, and counts changed/invalid/different calls', async () => {
    const { privateStore } = await meterHarness();
    const meter = await AttemptMeter.create({
      turnId: 'input-1-t1',
      privateStore,
      limits: attemptLimits({ maxSlotToolCallsPerAttempt: 10 }),
    });
    const exact = { toolCallId: 'tc-1', canonicalArgsHash: 'hash-a', toolName: 'write_draft_content' };

    // An exact call without a recorded result counts — twice.
    expect((await meter.prechargeRawTool(exact)).status).toBe('ok');
    expect((await meter.prechargeRawTool(exact)).status).toBe('ok');
    expect(meter.usage.slotToolCalls).toBe(2);

    // After recordToolResult, an EXACT replay is free (never re-counted).
    await meter.recordToolResult({ toolCallId: 'tc-1', canonicalArgsHash: 'hash-a', result: { ok: true } });
    const replay = await meter.prechargeRawTool(exact);
    expect(replay.status).toBe('ok');
    if (replay.status === 'ok') {
      expect(replay.replayed).toBe(true);
    }
    expect(meter.usage.slotToolCalls).toBe(2);

    // Same toolCallId with changed args counts.
    const changed = await meter.prechargeRawTool({
      toolCallId: 'tc-1',
      canonicalArgsHash: 'hash-b',
      toolName: 'write_draft_content',
    });
    expect(changed.status).toBe('ok');
    if (changed.status === 'ok') {
      expect(changed.replayed).toBe(false);
    }
    expect(meter.usage.slotToolCalls).toBe(3);

    // Invalid / unauthorized / truncated calls reach the ingress and count.
    const invalid = await meter.prechargeRawTool({
      toolCallId: 'tc-2',
      canonicalArgsHash: 'hash-invalid',
      toolName: 'write_draft_content',
    });
    expect(invalid.status).toBe('ok');

    // A different toolCallId counts even for the same args hash.
    const different = await meter.prechargeRawTool({
      toolCallId: 'tc-3',
      canonicalArgsHash: 'hash-a',
      toolName: 'write_draft_content',
    });
    expect(different.status).toBe('ok');
    expect(meter.usage.slotToolCalls).toBe(5);
  });

  it('closes the Attempt on the call beyond the exact max and returns the SAME terminal failure afterwards', async () => {
    const { privateStore } = await meterHarness();
    const opts = {
      turnId: 'input-1-t1',
      privateStore,
      limits: attemptLimits({ maxSlotToolCallsPerAttempt: 2 }),
    };
    const meter = await AttemptMeter.create(opts);
    expect(
      (await meter.prechargeRawTool({ toolCallId: 'a', canonicalArgsHash: 'h1', toolName: 'x' }))
        .status,
    ).toBe('ok');
    // Reaching exactly the max is legal.
    expect(
      (await meter.prechargeRawTool({ toolCallId: 'b', canonicalArgsHash: 'h2', toolName: 'x' }))
        .status,
    ).toBe('ok');
    // The next call beyond the exact max closes the Attempt.
    const beyond = await meter.prechargeRawTool({
      toolCallId: 'c',
      canonicalArgsHash: 'h3',
      toolName: 'x',
    });
    expect(beyond.status).toBe('closed');
    if (beyond.status === 'closed') {
      expect(beyond.failure.code).toBe(RESOURCE_LIMIT_EXCEEDED);
      expect(beyond.failure.cause).toBe('slot_tool_limit');
    }
    expect(meter.signal.aborted).toBe(true);

    // Every subsequent charge returns the SAME terminal failure (no second state).
    const again = await meter.prechargeRawTool({
      toolCallId: 'd',
      canonicalArgsHash: 'h4',
      toolName: 'x',
    });
    expect(again.status).toBe('closed');
    if (again.status === 'closed' && beyond.status === 'closed') {
      expect(again.failure).toBe(beyond.failure);
    }
  });
});

describe('AttemptMeter — validation accounting', () => {
  it('reserveValidation and recordValidationUsage account invocations/CPU/wall/output; exactly-at-max is legal; overage closes', async () => {
    const { privateStore } = await meterHarness();
    const meter = await AttemptMeter.create({
      turnId: 'input-1-t1',
      privateStore,
      limits: attemptLimits({
        maxValidationRunsPerAttempt: 10,
        maxValidatorInvocationsPerAttempt: 100,
        maxAggregateValidatorCpuMsPerAttempt: 1000,
        maxAggregateValidatorWallClockMsPerAttempt: 2000,
        maxValidatorOutputBytesPerAttempt: 10_000,
      }),
    });

    const run1 = { invocations: 40, cpuMs: 100, wallMs: 200, outputBytes: 1000 };
    expect((await meter.reserveValidation(run1)).status).toBe('ok');
    expect((await meter.recordValidationUsage(run1)).status).toBe('ok');
    expect(meter.usage.validationRuns).toBe(1);
    expect(meter.usage.validatorInvocations).toBe(40);

    // Reaching exactly the max invocation budget is legal (60 + 40 = 100).
    const run2 = { invocations: 60, cpuMs: 1, wallMs: 1, outputBytes: 1 };
    expect((await meter.recordValidationUsage(run2)).status).toBe('ok');
    expect(meter.usage.validatorInvocations).toBe(100);

    // The next reservation that would exceed closes the Attempt.
    const over = await meter.reserveValidation({ invocations: 1, cpuMs: 1, wallMs: 1, outputBytes: 1 });
    expect(over.status).toBe('closed');
    if (over.status === 'closed') {
      expect(over.failure.code).toBe(RESOURCE_LIMIT_EXCEEDED);
      expect(over.failure.cause).toBe('validator_invocations');
    }
    expect(meter.signal.aborted).toBe(true);
  });

  it('reaching exactly maxValidationRunsPerAttempt is legal; the next run closes', async () => {
    const { privateStore } = await meterHarness();
    const meter = await AttemptMeter.create({
      turnId: 'input-1-t1',
      privateStore,
      limits: attemptLimits({ maxValidationRunsPerAttempt: 2, maxValidatorInvocationsPerAttempt: 1000 }),
    });
    expect(
      (await meter.recordValidationUsage({ invocations: 1, cpuMs: 1, wallMs: 1, outputBytes: 1 }))
        .status,
    ).toBe('ok');
    expect(
      (await meter.recordValidationUsage({ invocations: 1, cpuMs: 1, wallMs: 1, outputBytes: 1 }))
        .status,
    ).toBe('ok');
    // Reserve the third run: validationRuns would be 3 > 2 → closed.
    const over = await meter.reserveValidation({ invocations: 1, cpuMs: 1, wallMs: 1, outputBytes: 1 });
    expect(over.status).toBe('closed');
    if (over.status === 'closed') {
      expect(over.failure.cause).toBe('validation_limit');
    }
  });

  it('persists and reloads fractional validator aggregates (ns/1e6) without failing the snapshot parser', async () => {
    const { privateStore } = await meterHarness();
    const opts = {
      turnId: 'input-1-t1',
      privateStore,
      limits: attemptLimits({ maxValidatorInvocationsPerAttempt: 100, maxAggregateValidatorCpuMsPerAttempt: 1000 }),
    };
    const meter = await AttemptMeter.create(opts);
    // The writer records aggregates from monotonic clocks, which may be
    // fractional (ms derived from ns/1e6). The parser must accept them.
    const run = { invocations: 1, cpuMs: 12.5, wallMs: 20.25, outputBytes: 100.5 };
    expect((await meter.recordValidationUsage(run)).status).toBe('ok');
    // A re-created meter reads the snapshot: fractional aggregates round-trip.
    const second = await AttemptMeter.create(opts);
    expect(second.usage.validatorCpuMs).toBe(12.5);
    expect(second.usage.validatorWallClockMs).toBe(20.25);
    expect(second.usage.validatorOutputBytes).toBe(100.5);
    expect(second.usage.validatorInvocations).toBe(1);
  });
});

describe('AttemptMeter — composite abort signal', () => {
  it('combines the scheduler stop signal without minting a resource terminal', async () => {
    const { privateStore } = await meterHarness();
    const scheduler = new AbortController();
    const meter = await AttemptMeter.create({
      turnId: 'input-1-t1',
      privateStore,
      limits: attemptLimits(),
      schedulerSignal: scheduler.signal,
    });
    expect(meter.signal.aborted).toBe(false);
    scheduler.abort();
    expect(meter.signal.aborted).toBe(true);
    // A stop is not a resource closure: no terminal failure is minted.
    expect(meter.terminalFailure).toBeNull();
    expect(meter.closed).toBe(false);
  });

  it('a re-created meter over a closed attempt reports the same closed state', async () => {
    const { privateStore } = await meterHarness();
    const opts = {
      turnId: 'input-1-t1',
      privateStore,
      limits: attemptLimits({ maxSlotToolCallsPerAttempt: 1 }),
    };
    const first = await AttemptMeter.create(opts);
    await first.prechargeRawTool({ toolCallId: 'a', canonicalArgsHash: 'h1', toolName: 'x' });
    await first.prechargeRawTool({ toolCallId: 'b', canonicalArgsHash: 'h2', toolName: 'x' });
    expect(first.closed).toBe(true);

    const second = await AttemptMeter.create(opts);
    expect(second.signal.aborted).toBe(true);
    expect(second.closed).toBe(true);
    expect(second.terminalFailure?.code).toBe(RESOURCE_LIMIT_EXCEEDED);
  });
});

describe('AttemptMeter — deadline and persistence', () => {
  it('aborts the composite signal on the wall-clock deadline and the coordinator surfaces failed/runtime_failure', async () => {
    const { paths, taskId, privateStore } = await meterHarness('task-deadline');
    const store = new EventStore(paths);
    await store.append(taskId, makeTaskEvent({ at: '2026-01-01T00:00:00.000Z', type: 'task_started' }));
    await store.append(
      taskId,
      makeTaskEvent({
        at: '2026-01-01T00:00:00.000Z',
        id: 'input-1',
        type: 'agent_input',
        node: makeEventNode({ sequence: 1, agentId: 'agent-a' }),
      }),
    );
    const start = await startAttempt({
      taskId,
      inputNodeId: 'input-1',
      agentId: 'agent-a',
      sessionKind: 'structure',
      events: await store.read(taskId),
      readEvents: () => store.read(taskId),
      appendBatch: (commitId, events, expectedLastSequence) =>
        store.appendBatch(taskId, commitId, events, { expectedLastSequence }),
    });

    const clock = fakeClock(0);
    const meter = await AttemptMeter.create({
      turnId: start.turnId,
      privateStore,
      limits: attemptLimits({ maxAttemptWallClockMs: 100 }),
      monotonicNow: clock.monotonicNow,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
    expect(meter.signal.aborted).toBe(false);

    // Advance through provider wait with NO tool call: the deadline fires.
    clock.now = 150;
    clock.fireTimers();
    expect(meter.signal.aborted).toBe(true);
    expect(meter.closed).toBe(true);
    expect(meter.terminalFailure?.code).toBe(RESOURCE_LIMIT_EXCEEDED);
    expect(meter.terminalFailure?.cause).toBe('deadline');

    // The coordinator surfaces failed/runtime_failure.
    const tail = (await store.read(taskId)).at(-1)!.sequence;
    const result = await terminalize({
      taskId,
      inputNodeId: 'input-1',
      attemptEpoch: start.attemptEpoch,
      turnId: start.turnId,
      status: 'failed',
      reason: 'runtime_failure',
      expectedTail: tail,
      readEvents: () => store.read(taskId),
      appendBatch: (commitId, events, expectedLastSequence) =>
        store.appendBatch(taskId, commitId, events, { expectedLastSequence }),
    });
    expect(
      result.committed.some(
        (entry) =>
          entry.event.type === 'structured_slot_attempt_terminal' &&
          entry.event.status === 'failed' &&
          entry.event.reason === 'runtime_failure',
      ),
    ).toBe(true);
  });

  it('never resets the meter across compaction / session continuation', async () => {
    const { privateStore } = await meterHarness();
    const opts = {
      turnId: 'input-1-t1',
      privateStore,
      limits: attemptLimits({ maxSlotToolCallsPerAttempt: 100, maxValidatorInvocationsPerAttempt: 100 }),
    };
    const first = await AttemptMeter.create(opts);
    await first.prechargeRawTool({ toolCallId: 'tc-1', canonicalArgsHash: 'hash-a', toolName: 'write_draft_content' });
    await first.prechargeRawTool({ toolCallId: 'tc-2', canonicalArgsHash: 'hash-b', toolName: 'replace_draft_content' });
    await first.recordToolResult({ toolCallId: 'tc-1', canonicalArgsHash: 'hash-a', result: { ok: true } });
    await first.recordValidationUsage({ invocations: 3, cpuMs: 10, wallMs: 20, outputBytes: 100 });

    // Session continuation: a NEW meter over the same turn reads the snapshot.
    const second = await AttemptMeter.create(opts);
    expect(second.usage.slotToolCalls).toBe(2);
    expect(second.usage.validatorInvocations).toBe(3);
    expect(second.usage.validatorCpuMs).toBe(10);
    // The recorded result is cached → an exact replay stays free.
    const replay = await second.prechargeRawTool({ toolCallId: 'tc-1', canonicalArgsHash: 'hash-a', toolName: 'write_draft_content' });
    expect(replay.status).toBe('ok');
    if (replay.status === 'ok') {
      expect(replay.replayed).toBe(true);
    }
    expect(second.usage.slotToolCalls).toBe(2);
    // A NEW call after continuation still counts — the meter continues, not reset.
    const fresh = await second.prechargeRawTool({ toolCallId: 'tc-3', canonicalArgsHash: 'hash-c', toolName: 'write_draft_content' });
    expect(fresh.status).toBe('ok');
    expect(second.usage.slotToolCalls).toBe(3);
    // The deadline start is preserved across continuation (never reset).
    expect(second.startedAtMs).toBe(first.startedAtMs);
  });
});
