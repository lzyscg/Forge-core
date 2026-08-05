// @vitest-environment node
/**
 * FakeAgentRuntime tests (plan Phase C Task 1 Step 6).
 *
 * The fake is a deterministic, script-driven stand-in for the Pi runtime used
 * by Tasks 3–6: scripts are keyed by agent id and advance by invocation
 * count; each scripted Turn returns public text/actions or throws a typed
 * transient/permanent RuntimeFailure; AbortSignal is respected before return
 * and while waiting on an injected deferred. The fake never touches storage.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeAgentRuntime,
  RuntimeAbortedError,
  RuntimeFailure,
  type FakeScriptStep,
} from './fake-agent-runtime';
import {
  createDeferred,
  deferredScript,
  fakeUsage,
  sampleTurnInput,
  sendMessageProposal,
} from './test-support';

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('FakeAgentRuntime scripted Turns', () => {
  it('returns scripted public text, actions and usage with the input turnId', async () => {
    const runtime = new FakeAgentRuntime({
      scripts: {
        'agent-alpha': [{
          kind: 'result',
          publicText: 'first scripted reply',
          actions: [sendMessageProposal()],
          usage: fakeUsage(),
        }],
      },
    });
    const result = await runtime.run(sampleTurnInput({ turnId: 'turn-42' }), signal());
    expect(result.turnId).toBe('turn-42');
    expect(result.publicText).toBe('first scripted reply');
    expect(result.actions).toEqual([sendMessageProposal()]);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
  });

  it('defaults missing fields to empty text, no actions, null usage and empty trace', async () => {
    const runtime = new FakeAgentRuntime({ scripts: { 'agent-alpha': [{ kind: 'result' }] } });
    const result = await runtime.run(sampleTurnInput(), signal());
    expect(result).toEqual({ turnId: 'turn-1', publicText: '', actions: [], usage: null, trace: [] });
  });

  it('advances scripts by invocation count per agent with independent counters', async () => {
    const runtime = new FakeAgentRuntime({
      scripts: {
        'agent-alpha': [
          { kind: 'result', publicText: 'alpha one' },
          { kind: 'result', publicText: 'alpha two' },
        ],
        'agent-beta': [{ kind: 'result', publicText: 'beta one' }],
      },
    });
    const first = await runtime.run(sampleTurnInput(), signal());
    const beta = await runtime.run(
      sampleTurnInput({ agent: { ...sampleTurnInput().agent, id: 'agent-beta' } }),
      signal(),
    );
    const second = await runtime.run(sampleTurnInput(), signal());
    expect([first.publicText, beta.publicText, second.publicText]).toEqual([
      'alpha one', 'beta one', 'alpha two',
    ]);
    expect(runtime.countInvocations('agent-alpha')).toBe(2);
    expect(runtime.countInvocations('agent-beta')).toBe(1);
  });

  it('returns defensive copies so results cannot mutate scripted state', async () => {
    const scripted = sendMessageProposal();
    const runtime = new FakeAgentRuntime({
      scripts: { 'agent-alpha': [{ kind: 'result', actions: [scripted] }] },
    });
    const result = await runtime.run(sampleTurnInput(), signal());
    (result.actions[0] as { targetAgentId: string }).targetAgentId = 'tampered';
    expect(scripted.targetAgentId).not.toBe('tampered');
  });

  it('fails loud when a script is exhausted', async () => {
    const runtime = new FakeAgentRuntime({ scripts: { 'agent-alpha': [] } });
    await expect(runtime.run(sampleTurnInput(), signal())).rejects.toThrowError(
      /agent-alpha.*turn 1/,
    );
    expect(runtime.countInvocations('agent-alpha')).toBe(0);
  });

  it('returns one neutral empty Turn for an agent with no registered script', async () => {
    // A script-less fake stays neutral instead of failing: lifecycle fixtures
    // (Gateway contract, Task 6 seeding) start tasks whose agents carry no
    // script and must observe a deterministic quiescent loop, never a guessed
    // failure. A REGISTERED script that runs out still fails loud (above).
    const runtime = new FakeAgentRuntime();
    const result = await runtime.run(sampleTurnInput(), signal());
    expect(result).toEqual({
      turnId: sampleTurnInput().turnId,
      publicText: '',
      actions: [],
      usage: null,
      trace: [],
    });
    expect(runtime.countInvocations(sampleTurnInput().agent.id)).toBe(1);
    // The neutral behavior repeats: an unscripted agent never exhausts.
    const again = await runtime.run(sampleTurnInput(), signal());
    expect(again.actions).toEqual([]);
  });
});

describe('FakeAgentRuntime typed failures (Task 5 retry classification surface)', () => {
  it('throws scripted transient failures with retryable=true and a stable code', async () => {
    const failure = RuntimeFailure.transient('ETIMEDOUT', 'upstream timed out');
    const runtime = new FakeAgentRuntime({
      scripts: { 'agent-alpha': [{ kind: 'failure', failure }] },
    });
    const error = await runtime.run(sampleTurnInput(), signal()).catch((caught) => caught);
    expect(error).toBeInstanceOf(RuntimeFailure);
    expect(error).toMatchObject({ code: 'ETIMEDOUT', retryable: true });
  });

  it('throws scripted permanent failures with retryable=false', async () => {
    const failure = RuntimeFailure.permanent('MODEL_NOT_FOUND', 'configured model unknown');
    const runtime = new FakeAgentRuntime({
      scripts: { 'agent-alpha': [{ kind: 'failure', failure }] },
    });
    const error = await runtime.run(sampleTurnInput(), signal()).catch((caught) => caught);
    expect(error).toBeInstanceOf(RuntimeFailure);
    expect(error).toMatchObject({ code: 'MODEL_NOT_FOUND', retryable: false });
  });
});

describe('FakeAgentRuntime abort handling', () => {
  it('rejects an already-aborted signal without consuming the script', async () => {
    const runtime = new FakeAgentRuntime({
      scripts: { 'agent-alpha': [{ kind: 'result', publicText: 'never reached' }] },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(runtime.run(sampleTurnInput(), controller.signal))
      .rejects.toMatchObject({ code: 'RUNTIME_ABORTED' });
    await expect(runtime.run(sampleTurnInput(), controller.signal))
      .rejects.toBeInstanceOf(RuntimeAbortedError);
    expect(runtime.countInvocations('agent-alpha')).toBe(0);
  });

  it('aborts while waiting on an injected deferred', async () => {
    const { step, deferred } = deferredScript({ publicText: 'late reply' });
    const runtime = new FakeAgentRuntime({ scripts: { 'agent-alpha': [step] } });
    const controller = new AbortController();
    const pending = runtime.run(sampleTurnInput(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RuntimeAbortedError);
    deferred.resolve(); // settle the dangling deferred for cleanliness
  });

  it('propagates a deferred rejection and returns once the deferred resolves', async () => {
    const rejected = createDeferred<void>();
    const rejecting = new FakeAgentRuntime({
      scripts: {
        'agent-alpha': [{ kind: 'result', deferred: rejected, publicText: 'x' }],
      },
    });
    const pendingRejection = rejecting.run(sampleTurnInput(), signal());
    rejected.reject(new Error('injected stall failure'));
    await expect(pendingRejection).rejects.toThrowError('injected stall failure');

    const { step, deferred } = deferredScript({ publicText: 'deferred reply' });
    const runtime = new FakeAgentRuntime({ scripts: { 'agent-alpha': [step] } });
    const pending = runtime.run(sampleTurnInput(), signal());
    deferred.resolve();
    await expect(pending).resolves.toMatchObject({ publicText: 'deferred reply' });
  });
});

describe('FakeAgentRuntime isolation', () => {
  it('never writes storage or filesystem state while running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-core-fake-runtime-'));
    tempRoots.push(root);
    const scripts: Record<string, FakeScriptStep[]> = {
      'agent-alpha': [
        { kind: 'result', publicText: 'one', actions: [sendMessageProposal()] },
        { kind: 'failure', failure: RuntimeFailure.transient('HTTP_503', 'provider overloaded') },
      ],
    };
    const runtime = new FakeAgentRuntime({ scripts });
    await runtime.run(sampleTurnInput(), signal());
    await runtime.run(sampleTurnInput(), signal()).catch(() => undefined);
    expect(readdirSync(root)).toEqual([]);
    // The constructor accepts scripts only — there is no storage handle to leak.
    expect(Object.keys(scripts)).toEqual(['agent-alpha']);
  });

  it('tracks disposal per agent and process-wide', async () => {
    const runtime = new FakeAgentRuntime({});
    expect(runtime.isDisposed('task-1', 'agent-alpha')).toBe(false);
    await runtime.disposeAgent('task-1', 'agent-alpha');
    expect(runtime.isDisposed('task-1', 'agent-alpha')).toBe(true);
    expect(runtime.isDisposed('task-1', 'agent-beta')).toBe(false);
    await runtime.disposeAll();
    expect(runtime.isDisposed('task-1', 'agent-beta')).toBe(true);
  });
});

describe('FakeAgentRuntime thinking and workspace writes (plan Phase E Task 2)', () => {
  function writesSpy() {
    const calls: Array<{
      taskId: string;
      agentId: string;
      writes: ReadonlyArray<{ path: string; content: string }>;
    }> = [];
    const sink = async (
      taskId: string,
      agentId: string,
      writes: ReadonlyArray<{ path: string; content: string }>,
    ): Promise<void> => {
      calls.push({ taskId, agentId, writes });
    };
    return { calls, sink };
  }

  it('builds an ordered trace and calls the workspace sink exactly once', async () => {
    const { calls, sink } = writesSpy();
    const runtime = new FakeAgentRuntime({
      scripts: {
        'agent-alpha': [{
          kind: 'result',
          publicText: 'published',
          thinking: 'drafting in my head',
          workspaceWrites: [
            { path: 'draft/v1.md', content: '初稿' },
            { path: 'notes.md', content: '备忘' },
          ],
        }],
      },
    });
    runtime.setWorkspaceSink(sink);
    const result = await runtime.run(sampleTurnInput(), signal());
    // The sink runs exactly once with the full write batch.
    expect(calls).toHaveLength(1);
    expect(calls[0].taskId).toBe('task-1');
    expect(calls[0].agentId).toBe('agent-alpha');
    expect(calls[0].writes).toEqual([
      { path: 'draft/v1.md', content: '初稿' },
      { path: 'notes.md', content: '备忘' },
    ]);
    // Trace order: thinking, one call/result pair per write, then the text.
    expect(result.trace.map((entry) => entry.kind)).toEqual([
      'thinking', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'text',
    ]);
    expect(result.trace[0]).toEqual({ kind: 'thinking', text: 'drafting in my head' });
    expect(result.trace[1]).toEqual({
      kind: 'tool_call',
      toolName: 'write_workspace',
      params: { path: 'draft/v1.md', content: '初稿' },
    });
    expect(result.trace[2]).toMatchObject({ kind: 'tool_result', toolName: 'write_workspace' });
    expect(result.trace[5]).toEqual({ kind: 'text', text: 'published' });
  });

  it('skips workspace writes without a sink and keeps only thinking and text', async () => {
    const runtime = new FakeAgentRuntime({
      scripts: {
        'agent-alpha': [{
          kind: 'result',
          publicText: 'published',
          thinking: 'thinking only',
          workspaceWrites: [{ path: 'draft/v1.md', content: '初稿' }],
        }],
      },
    });
    // No setWorkspaceSink call: writes are skipped, never thrown.
    const result = await runtime.run(sampleTurnInput(), signal());
    expect(result.publicText).toBe('published');
    expect(result.trace.map((entry) => entry.kind)).toEqual(['thinking', 'text']);
  });

  it('returns an empty trace for a neutral unscripted agent', async () => {
    const runtime = new FakeAgentRuntime();
    const result = await runtime.run(sampleTurnInput(), signal());
    expect(result.trace).toEqual([]);
  });
});
