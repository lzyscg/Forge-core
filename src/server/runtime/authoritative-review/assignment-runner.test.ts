// @vitest-environment node
/**
 * Task 12 assignment-runner tests (design §17.2/§18, spec §10.2/§11): consumes
 * a leased AssignmentDispatch, injects the v2 tool provider, runs the session
 * in the attempt's ISOLATED namespace, and returns a committable outcome. The
 * runner is thin — session assembly + error classification; domain facts and
 * the completion commit belong to the attempt-coordinator / v2 committer.
 */
import { describe, expect, it } from 'vitest';
import type { AgentRuntime, AgentTurnInput, AgentRunOptions, AgentTurnResult } from '../agent-runtime';
import { RuntimeAbortedError, RuntimeFailure } from '../agent-runtime';
import { FakeAgentRuntime } from '../fake-agent-runtime';
import type { FrozenAgentConfig } from '../../template/template-schema';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { V2AssignmentRunner, type V2ToolProvider } from './assignment-runner';
import type { V2AttemptContext } from './attempt-coordinator';

function ref(kind: string, salt: number): BlobRefV2 {
  return {
    kind: kind as BlobRefV2['kind'],
    digest: canonicalJsonSha256({ kind, salt }),
    byteLength: 12,
    mediaType: 'application/json',
    schemaVersion: 1,
  };
}

function fakeAgent(id: string): FrozenAgentConfig {
  return {
    id,
    name: id,
    description: `frozen ${id}`,
    systemPrompt: `You are ${id}.`,
    model: 'configured/test-model',
    skills: [],
    gate: null,
    slotCapabilities: [],
    turnContract: null,
  };
}

function context(overrides: Partial<V2AttemptContext> = {}): V2AttemptContext {
  return {
    taskId: 'task-1',
    workItemId: 'wi-1',
    attemptId: 'att-1',
    leaseEpoch: 1,
    namespace: 'structured/orchestrator/wi-1/att-1',
    agentId: 'worker-a',
    roleBinding: 'orchestrator',
    executionKind: 'structured',
    sessionKind: 'structure_chunk',
    dispatchRef: ref('assignment_dispatch', 3),
    authorityBaseRef: ref('authority_base_set', 1),
    grantInstanceRef: null,
    inputArtifactDeliveryId: null,
    agent: fakeAgent('orchestrator'),
    currentAssignmentText: '{"workItemId":"wi-1","logicalAssignmentId":"la-1"}',
    committedCheckpointText: '',
    ...overrides,
  };
}

/** Records every turn input and the tool contexts for assertions. */
class RecordingRuntime implements AgentRuntime {
  readonly inputs: AgentTurnInput[] = [];

  constructor(private readonly inner: AgentRuntime) {}

  async run(input: AgentTurnInput, signal: AbortSignal, options?: AgentRunOptions): Promise<AgentTurnResult> {
    this.inputs.push(input);
    return this.inner.run(input, signal, options);
  }

  async disposeAgent(taskId: string, agentId: string): Promise<void> {
    return this.inner.disposeAgent(taskId, agentId);
  }

  async disposeAll(): Promise<void> {
    return this.inner.disposeAll();
  }
}

describe('V2AssignmentRunner', () => {
  it('consumes a leased AssignmentDispatch and runs the session in the isolated namespace', async () => {
    const inner = new FakeAgentRuntime();
    inner.setScript('orchestrator', [{ kind: 'result', publicText: 'chunk output' }]);
    const recording = new RecordingRuntime(inner);
    const toolContexts: V2AttemptContext[] = [];
    const runner = new V2AssignmentRunner({
      runtime: recording,
      toolProvider: {
        toolsFor: async (ctx) => {
          toolContexts.push(ctx);
          return [];
        },
      },
    });
    const outcome = await runner.runSession(context(), new AbortController().signal);
    expect(outcome).toMatchObject({ kind: 'committed', publicText: 'chunk output' });
    // Tool definitions are resolved by PiAgentRuntime's v2Tools seam. The
    // runner must not resolve a second unused list against a separate lease
    // boundary; it only asks the provider for result refs after the turn.
    expect(toolContexts).toHaveLength(0);
    // The session received the isolated namespace and NO prior chat history.
    const turn = recording.inputs[0];
    expect(turn.v2Namespace).toBe('structured/orchestrator/wi-1/att-1');
    expect(turn.publicHistory).toEqual([]);
    expect(turn.inputText).toContain('la-1');
    expect(turn.slotSession).toBeNull();
    expect(turn.v2Session?.signal).toBeInstanceOf(AbortSignal);
  });

  it('classifies a transient runtime failure as retryable', async () => {
    const inner = new FakeAgentRuntime();
    inner.setScript('orchestrator', [
      { kind: 'failure', failure: RuntimeFailure.transient('PROVIDER_REQUEST_FAILED', 'transient') },
    ]);
    const runner = new V2AssignmentRunner({
      runtime: inner,
      toolProvider: { toolsFor: async () => [] },
    });
    const outcome = await runner.runSession(context(), new AbortController().signal);
    expect(outcome).toMatchObject({ kind: 'retryable_failure', failureCode: 'PROVIDER_REQUEST_FAILED' });
  });

  it('classifies a permanent runtime failure as terminal', async () => {
    const inner = new FakeAgentRuntime();
    inner.setScript('orchestrator', [
      { kind: 'failure', failure: RuntimeFailure.permanent('POLICY_VIOLATION', 'permanent') },
    ]);
    const runner = new V2AssignmentRunner({
      runtime: inner,
      toolProvider: { toolsFor: async () => [] },
    });
    const outcome = await runner.runSession(context(), new AbortController().signal);
    expect(outcome).toMatchObject({ kind: 'terminal_failure', failureCode: 'POLICY_VIOLATION' });
  });

  it('rethrows a provider abort so the coordinator records nothing', async () => {
    const inner = new FakeAgentRuntime();
    inner.setScript('orchestrator', [
      { kind: 'result', publicText: 'never', deferred: { promise: new Promise(() => undefined), resolve: () => undefined, reject: () => undefined } },
    ]);
    const runner = new V2AssignmentRunner({
      runtime: inner,
      toolProvider: { toolsFor: async () => [] },
    });
    const controller = new AbortController();
    const runPromise = runner.runSession(context(), controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(runPromise).rejects.toBeInstanceOf(RuntimeAbortedError);
  });

  it('runs a generic submitter context through the same basic-turn session surface (delivery-bound submit)', async () => {
    const inner = new FakeAgentRuntime();
    inner.setScript('submitter', [
      { kind: 'result', publicText: 'delivery submitted', actions: [{ type: 'submit_final_artifact' }] },
    ]);
    const recording = new RecordingRuntime(inner);
    const runner = new V2AssignmentRunner({
      runtime: recording,
      toolProvider: { toolsFor: async () => [] },
    });
    const genericCtx = context({
      executionKind: 'generic',
      roleBinding: 'submitter',
      sessionKind: null,
      namespace: 'generic/submitter/wi-2/att-2',
      workItemId: 'wi-2',
      attemptId: 'att-2',
      agent: fakeAgent('submitter'),
      inputArtifactDeliveryId: 'del-1',
      dispatchRef: ref('assignment_dispatch', 4),
    });
    const outcome = await runner.runSession(genericCtx, new AbortController().signal);
    expect(outcome).toMatchObject({ kind: 'committed', publicText: 'delivery submitted' });
    const turn = recording.inputs[0];
    expect(turn.v2Namespace).toBe('generic/submitter/wi-2/att-2');
  });

  it('fails a generic turn that does NOT submit exactly the current delivery (M-3)', async () => {
    const inner = new FakeAgentRuntime();
    inner.setScript('submitter', [{ kind: 'result', publicText: 'silent turn' }]);
    const runner = new V2AssignmentRunner({
      runtime: inner,
      toolProvider: { toolsFor: async () => [] },
    });
    const genericCtx = context({
      executionKind: 'generic',
      roleBinding: 'submitter',
      sessionKind: null,
      namespace: 'generic/submitter/wi-2/att-2',
      workItemId: 'wi-2',
      attemptId: 'att-2',
      agent: fakeAgent('submitter'),
      inputArtifactDeliveryId: 'del-1',
      dispatchRef: ref('assignment_dispatch', 4),
    });
    const outcome = await runner.runSession(genericCtx, new AbortController().signal);
    expect(outcome).toMatchObject({ kind: 'terminal_failure', failureCode: 'GENERIC_SUBMIT_REQUIRED' });
  });

  it('collects the domain result refs from the tool provider (I-2 seam)', async () => {
    const resultRef = ref('content_value', 5);
    const runner = new V2AssignmentRunner({
      runtime: new FakeAgentRuntime(),
      toolProvider: {
        toolsFor: async () => [],
        collectResultRefs: async () => [resultRef],
      },
    });
    const outcome = await runner.runSession(context(), new AbortController().signal);
    expect(outcome).toMatchObject({ kind: 'committed' });
    if (outcome.kind === 'committed') {
      expect(outcome.resultRefs).toEqual([resultRef]);
    }
  });

  it('fails closed when no frozen agent is resolved for the role', async () => {
    const runner = new V2AssignmentRunner({
      runtime: new FakeAgentRuntime(),
      toolProvider: { toolsFor: async () => [] },
    });
    await expect(runner.runSession(context({ agent: null }), new AbortController().signal)).rejects.toThrow(
      'without a frozen agent',
    );
  });
});
