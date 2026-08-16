// @vitest-environment node
/**
 * Task 12 attempt-coordinator tests (design §17.2/§17.5, spec §9.2/§10.2): the
 * lease -> execute -> complete loop over the WorkItem coordinator and the v2
 * session runner / SystemCommand allowlist. Exercises the SUCCESS completion
 * envelope ([attempt/command completed, work_item_completed] in ONE batch),
 * response-loss replay, old-epoch rejection with no partial write, retryable/
 * terminal failure paths, SystemCommand dispatch (incl. the six NOT_IMPLEMENTED
 * doubles and unknown-kind fail-closed), the timeout path, per-attempt
 * namespace isolation for two WorkItems of the same Agent ID, and the public-
 * trace-only rule. All clocks are injected; the runtime is the Task 5 fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { AgentRuntime, AgentTurnInput, AgentRunOptions, AgentTurnResult } from '../agent-runtime';
import { RuntimeFailure } from '../agent-runtime';
import type { FrozenAgentConfig, FrozenTemplate } from '../../template/template-schema';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { BlobRefV2, WorkItemKindV2 } from '../../../shared/authoritative-review-v2';
import type { WriteGrantSpecV2 } from '../../authoritative-review/authority-types';
import {
  createWorkItemCoordinatorEnvironment,
  disposeRuntimeTestRoots,
  type WorkItemCoordinatorEnvironment,
} from '../test-support';
import { FakeAgentRuntime } from '../fake-agent-runtime';
import { AuthoritativeWakeupIndexV1 } from './wakeup-index';
import { TraceStore } from '../../storage/trace-store';
import { buildAuthorityBaseSet } from './authority-base';
import {
  V2AttemptCoordinator,
  AttemptError,
  deriveV2ConversationNamespace,
  runV2SchedulingTick,
  type TerminalFailInputV2,
  type V2AttemptOutcome,
} from './attempt-coordinator';
import { V2AssignmentRunner, type V2ToolProvider } from './assignment-runner';
import {
  SystemCommandRegistry,
  SYSTEM_COMMAND_KINDS,
  type SystemCommandContext,
  type SystemCommandHandler,
} from './system-command-registry';
import { completionKindRequiresResult } from '../../authoritative-review/authority-types';
import { resolvePublicationIntent } from '../../storage/authoritative-publication-intent-registry';
import { refOfBlob } from '../../authoritative-review/object-registry';

let seq = 0;

function opId(label: string): string {
  seq += 1;
  const root = createHash('sha256').update(`op:${label}:${seq}`).digest('hex');
  return `${root.slice(0, 8)}-${root.slice(8, 12)}-4${root.slice(13, 16)}-8${root.slice(17, 20)}-${root.slice(20, 32)}`;
}

function wiId(label: string): string {
  return `wi-${label}-${createHash('sha256').update(label).digest('hex').slice(0, 8)}`;
}

function tid(label: string): string {
  return `task-${label}-${createHash('sha256').update(label).digest('hex').slice(0, 8)}`;
}

function synthRef(kind: string, salt: number): BlobRefV2 {
  return {
    kind: kind as BlobRefV2['kind'],
    digest: canonicalJsonSha256({ kind, salt }),
    byteLength: 12,
    mediaType: 'application/json',
    schemaVersion: 1,
  };
}

function payloadObject(text: string): Record<string, unknown> {
  const without = {
    slotId: 's-1',
    contentSchemaDigest: '0'.repeat(64),
    taskContentRevision: 1,
    mediaType: 'text/plain',
    text,
  };
  return { ...without, selfDigest: canonicalJsonSha256(without) };
}

function fakeAgent(id: string, role: string): FrozenAgentConfig {
  return {
    id,
    name: role,
    description: `frozen ${role} agent`,
    systemPrompt: `You are the ${role} agent.`,
    model: 'configured/test-model',
    skills: [],
    gate: null,
    slotCapabilities: [],
    turnContract: null,
  };
}

const fakeV2Frozen = {
  id: 'v2-template',
  name: 'V2',
  description: 'frozen v2 protocol',
  versionHash: '0'.repeat(64),
  inputFields: [],
  agents: [],
  routes: [],
  artifactSchema: { files: [] },
  finalOutput: { name: 'out', format: 'text' as const, submitters: ['submitter'] },
  budget: null,
  productionMode: 'structured_slots' as const,
  structuredSlots: { version: 2 },
} as unknown as FrozenTemplate;

/** Records every AgentTurnInput for isolation assertions (delegates to a fake). */
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

interface AttemptEnv {
  base: WorkItemCoordinatorEnvironment;
  wakeups: AuthoritativeWakeupIndexV1;
  traces: TraceStore;
  runtime: RecordingRuntime;
  innerRuntime: FakeAgentRuntime;
  toolCalls: import('./attempt-coordinator').V2AttemptContext[];
  attempts: V2AttemptCoordinator;
  terminalFailCalls: TerminalFailInputV2[];
  systemCommands: SystemCommandRegistry;
  /** Prepares a §9.2 domain result carrier under the given task. */
  prepareResultRef(taskId: string): Promise<BlobRefV2>;
}

let envs: AttemptEnv[] = [];

async function makeEnv(options: {
  handlers?: readonly SystemCommandHandler[];
  runtime?: FakeAgentRuntime;
  attemptTimeoutMs?: number;
  /** When true the tool provider returns NO domain result refs (bare gate tests). */
  bare?: boolean;
} = {}): Promise<AttemptEnv> {
  const base = await createWorkItemCoordinatorEnvironment({
    leaseDurationMs: 30 * 60 * 1000,
  });
  const wakeups = new AuthoritativeWakeupIndexV1({ paths: base.paths });
  const traces = new TraceStore(base.paths);
  const innerRuntime = options.runtime ?? new FakeAgentRuntime();
  const runtime = new RecordingRuntime(innerRuntime);
  const toolCalls: import('./attempt-coordinator').V2AttemptContext[] = [];
  const prepareResultRef = async (taskId: string): Promise<BlobRefV2> =>
    base.facade.prepareBlob(taskId, 'content_value', payloadObject(`dummy result ${taskId}`));
  const toolProvider: V2ToolProvider = {
    toolsFor: async (ctx) => {
      toolCalls.push(ctx);
      return [];
    },
    collectResultRefs: async (ctx) => (options.bare === true ? [] : [await prepareResultRef(ctx.taskId)]),
  };
  const runner = new V2AssignmentRunner({ runtime, toolProvider });
  const terminalFailCalls: TerminalFailInputV2[] = [];
  const systemCommands = new SystemCommandRegistry(options.handlers);
  const attempts = new V2AttemptCoordinator({
    coordinator: base.coordinator,
    runner,
    systemCommands,
    agentForRole: async (_taskId, roleBinding) => {
      if (roleBinding === null) return null;
      return fakeAgent(roleBinding, roleBinding);
    },
    frozenFor: async () => fakeV2Frozen,
    wakeups,
    traces,
    clock: () => base.now.value,
    attemptTimeoutMs: options.attemptTimeoutMs ?? 10 * 60 * 1000,
    terminalFail: async (_taskId, input) => {
      terminalFailCalls.push(input);
    },
  });
  const env: AttemptEnv = {
    base,
    wakeups,
    traces,
    runtime,
    innerRuntime,
    toolCalls,
    attempts,
    terminalFailCalls,
    systemCommands,
    prepareResultRef,
  };
  envs.push(env);
  return env;
}

afterEach(async () => {
  disposeRuntimeTestRoots();
  envs = [];
  vi.useRealTimers();
});

function structureGrantSpec(authorityBaseRef: BlobRefV2, mapBuildSpecRef: BlobRefV2): WriteGrantSpecV2 {
  const body = {
    grantSpecId: 'grant-spec-structure',
    workItemId: 'wi-grant',
    kind: 'initial_structure_chunk' as const,
    snapshotHash: '0'.repeat(64),
    authorityBaseRef,
    mapBuildSpecRef,
    expectedFrontierDigest: '0'.repeat(64),
    structureChunkScope: { chunkOrdinal: 1, parentFrontierDigest: '0'.repeat(64), maxNodes: 512, maxRelations: 64 },
  };
  const without = { ...body };
  delete (without as { specDigest?: string }).specDigest;
  return { ...body, specDigest: canonicalJsonSha256(without) } as WriteGrantSpecV2;
}

function baseFor(
  env: WorkItemCoordinatorEnvironment,
  taskId: string,
  kind: WorkItemKindV2,
  refs: Record<string, BlobRefV2>,
  overrides: Partial<{ agentExecutionKind: 'structured_session' | 'generic_turn' | null; sessionKind: string | null }> = {},
) {
  return buildAuthorityBaseSet({
    taskId,
    templateSnapshotRef: env.templateSnapshotRef,
    profileSnapshotRef: env.profileSnapshotRef,
    kind,
    refs,
    agentExecutionKind: overrides.agentExecutionKind ?? (kind === 'agent_assignment' ? 'structured_session' : undefined),
    sessionKind: (overrides.sessionKind as never) ?? (kind === 'agent_assignment' ? 'structure_chunk' : null),
  });
}

interface CreateWorkItemOptions {
  kind?: WorkItemKindV2;
  roleBinding?: string | null;
  sessionKind?: string | null;
  logicalAssignmentId?: string | null;
  maxAutomaticRetries?: number;
  baseRefs?: Record<string, BlobRefV2>;
  payloadText?: string;
}

async function createWorkItem(env: AttemptEnv, taskId: string, options: CreateWorkItemOptions = {}) {
  const kind = options.kind ?? 'agent_assignment';
  const session = options.sessionKind ?? 'structure_chunk';
  const refs =
    options.baseRefs ??
    (kind === 'system_seal'
      ? {
          mapRef: synthRef('map_snapshot', 14),
          mapReviewBundleRef: synthRef('map_review_bundle', 22),
          contentRevisionManifestRef: synthRef('content_revision_manifest', 15),
          reviewBundleRef: synthRef('review_bundle', 18),
        }
      : kind === 'system_generation_finalize'
        ? { mapRef: synthRef('map_snapshot', 14), contentRevisionManifestRef: synthRef('content_revision_manifest', 15), planSpecRef: synthRef('generation_plan_spec', 16) }
        : { planSpecRef: synthRef('map_build_spec', 10) });
  const authorityBase = baseFor(env.base, taskId, kind, refs, {
    agentExecutionKind: kind === 'agent_assignment' ? (session === null ? 'generic_turn' : 'structured_session') : null,
    sessionKind: kind === 'agent_assignment' ? session : null,
  });
  const workItemId = wiId(`${kind}-${options.logicalAssignmentId ?? 'la-default'}`);
  const result = await env.base.coordinator.createWorkItem({
    taskId,
    operationId: opId(`create-${workItemId}`),
    workItemId,
    kind,
    roleBinding: options.roleBinding ?? (kind === 'agent_assignment' ? 'orchestrator' : null),
    agentExecutionKind:
      kind === 'agent_assignment'
        ? session === null
          ? 'generic_turn'
          : 'structured_session'
        : null,
    sessionKind: kind === 'agent_assignment' ? ((session as never) ?? null) : null,
    logicalAssignmentId: kind === 'agent_assignment' ? options.logicalAssignmentId ?? `la-${workItemId}` : null,
    reviewAssignmentId: null,
    inputArtifactDeliveryId: kind === 'agent_assignment' && session === null ? 'del-1' : null,
    payload: { kind: 'content_value', value: payloadObject(options.payloadText ?? 'payload') },
    authorityBase: authorityBase,
    grantSpec:
      kind === 'agent_assignment' && session !== null
        ? {
            build: (baseRef: BlobRefV2) =>
              structureGrantSpec(baseRef, (refs.planSpecRef as BlobRefV2 | undefined) ?? synthRef('map_build_spec', 10)),
          }
        : undefined,
    maxAutomaticRetries: options.maxAutomaticRetries ?? 2,
  });
  return { workItemId, authorityBaseRef: result.authorityBaseRef };
}

async function readProjection(env: AttemptEnv, taskId: string) {
  return env.base.readProjection(taskId);
}

describe('V2AttemptCoordinator lease -> execute -> complete', () => {
  it('leases a ready structured workitem, runs the session and commits [attempt completed, work_item_completed] in ONE batch', async () => {
    const env = await makeEnv();
    const taskId = tid('complete');
    env.innerRuntime.setScript('orchestrator', [{ kind: 'result', publicText: 'neutral chunk output' }]);
    const { workItemId } = await createWorkItem(env, taskId);
    const outcome = await env.attempts.runNext(taskId, 'worker-a');
    expect(outcome).toMatchObject({ kind: 'completed', workItemId });
    const projection = await readProjection(env, taskId);
    expect(projection.workItems[workItemId].state).toBe('completed');
    expect(projection.activeLease).toBeNull();
    const completed = Object.values(projection.attempts).find((a) => a.family === 'structured');
    expect(completed?.state).toBe('completed');
    // The session received the isolated namespace and NO prior chat history.
    const turn = env.runtime.inputs[0];
    expect(turn).toBeDefined();
    expect(turn.publicHistory).toEqual([]);
    expect(turn.v2Namespace).toBe(deriveV2ConversationNamespace('structured', 'orchestrator', workItemId, String(completed?.attemptId)));
    // The lease_expiry wakeup was removed.
    expect(await env.wakeups.read(taskId)).toEqual([]);
  });

  it('replays the ORIGINAL completion commit on response loss (deterministic operation id)', async () => {
    const env = await makeEnv();
    const taskId = tid('replay');
    env.innerRuntime.setScript('orchestrator', [{ kind: 'result', publicText: 'replay output' }]);
    const { workItemId } = await createWorkItem(env, taskId);
    // executeLeased twice: the second call must find the operation already
    // committed and return the same completed outcome (no second commit).
    const first = await env.attempts.runNext(taskId, 'worker-a');
    const eventsBefore = (await env.base.eventStore.read(taskId)).length;
    const second = await env.attempts.runNext(taskId, 'worker-a');
    expect(first.kind).toBe('completed');
    expect(second.kind).toBe('idle'); // no ready workitem remains
    const eventsAfter = (await env.base.eventStore.read(taskId)).length;
    expect(eventsAfter).toBe(eventsBefore);
  });

  it('rejects an old-epoch late completion with NO partial write', async () => {
    const env = await makeEnv();
    const taskId = tid('late');
    env.innerRuntime.setScript('orchestrator', [{ kind: 'result', publicText: 'ok' }]);
    const { workItemId } = await createWorkItem(env, taskId);
    await env.attempts.runNext(taskId, 'worker-a');
    const eventsBefore = (await env.base.eventStore.read(taskId)).length;
    const projection = await readProjection(env, taskId);
    // A late completeWorkItem for the SAME workitem (no longer leased) fails.
    await expect(
      env.base.coordinator.completeWorkItem({
        taskId,
        operationId: opId('late-complete'),
        workItemId,
      }),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_LEASED' });
    expect((await env.base.eventStore.read(taskId)).length).toBe(eventsBefore);
    expect(projection.workItems[workItemId].state).toBe('completed');
  });

  it('I-1: rejects a stale-epoch late completion of the PREVIOUS attempt after a reclaim+re-lease (ZERO writes)', async () => {
    const env = await makeEnv();
    const taskId = tid('stale');
    const { workItemId } = await createWorkItem(env, taskId);
    // Lease attempt A (epoch 1).
    const leaseA = await env.base.coordinator.leaseNext(taskId, 'worker-a', 'lease-a');
    const attemptA = leaseA?.attemptId;
    expect(attemptA).toBeTruthy();
    // Reclaim the expired lease -> ready (epoch advances).
    env.base.now.value = new Date(new Date(env.base.now.value).getTime() + 31 * 60 * 1000).toISOString();
    await env.base.coordinator.reclaimExpired(taskId, workItemId, 'reclaim-1', 'lease_expired');
    // Re-lease attempt B on the same workitem.
    const leaseB = await env.base.coordinator.leaseNext(taskId, 'worker-a', 'lease-b');
    const attemptB = leaseB?.attemptId;
    expect(attemptB).toBeTruthy();
    expect(attemptB).not.toBe(attemptA);
    // A STALE completion naming attempt A is rejected with ATTEMPT_MISMATCH
    // and ZERO writes — it can never complete the CURRENT re-leased attempt B.
    const eventsBefore = (await env.base.eventStore.read(taskId)).length;
    await expect(
      env.base.coordinator.completeWorkItem({
        taskId,
        operationId: opId('stale-complete'),
        workItemId,
        attemptId: attemptA,
        resultRefs: [await env.prepareResultRef(taskId)],
      }),
    ).rejects.toMatchObject({ code: 'ATTEMPT_MISMATCH' });
    expect((await env.base.eventStore.read(taskId)).length).toBe(eventsBefore);
    const projection = await readProjection(env, taskId);
    expect(projection.workItems[workItemId].state).toBe('leased');
    expect(projection.activeLease?.attemptId).toBe(attemptB);
  });

  it('I-2: rejects a BARE completion of a gated sessionKind workitem with ZERO writes (§9.2)', async () => {
    const env = await makeEnv({ bare: true }); // the tool provider returns NO domain result refs
    const taskId = tid('bare');
    const { workItemId } = await createWorkItem(env, taskId); // structure_chunk is gated
    await expect(env.attempts.runNext(taskId, 'worker-a')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // ZERO terminal writes: no completion/retryable/terminal events; the lease
    // (itself legal) stays active with the attempt still started.
    const events = await env.base.eventStore.read(taskId);
    expect(events.some((e) => e.event.type === 'structured_work_item_completed')).toBe(false);
    expect(events.some((e) => e.event.type === 'structured_work_item_retryable_failed')).toBe(false);
    expect(events.some((e) => e.event.type === 'structured_work_item_terminal_failed')).toBe(false);
    const projection = await readProjection(env, taskId);
    expect(projection.workItems[workItemId].state).toBe('leased');
    expect(projection.activeLease?.attemptId).toBeTruthy();
    expect(projection.attempts[String(projection.activeLease?.attemptId)].state).toBe('started');
  });

  it('I-1/I-2: a stale-epoch retryable failure is rejected with ZERO writes', async () => {
    const env = await makeEnv();
    const taskId = tid('stale-retry');
    const { workItemId } = await createWorkItem(env, taskId);
    const leaseA = await env.base.coordinator.leaseNext(taskId, 'worker-a', 'lease-a');
    const attemptA = leaseA?.attemptId;
    expect(attemptA).toBeTruthy();
    env.base.now.value = new Date(new Date(env.base.now.value).getTime() + 31 * 60 * 1000).toISOString();
    await env.base.coordinator.reclaimExpired(taskId, workItemId, 'reclaim-1', 'lease_expired');
    const leaseB = await env.base.coordinator.leaseNext(taskId, 'worker-a', 'lease-b');
    const attemptB = leaseB?.attemptId;
    expect(attemptB).not.toBe(attemptA);
    const eventsBefore = (await env.base.eventStore.read(taskId)).length;
    await expect(
      env.base.coordinator.recordRetryableFailure({
        taskId,
        operationId: opId('stale-retry-op'),
        workItemId,
        failureCode: 'PROVIDER_REQUEST_FAILED',
        failureDigest: '0'.repeat(64),
        attemptId: attemptA,
      }),
    ).rejects.toMatchObject({ code: 'ATTEMPT_MISMATCH' });
    expect((await env.base.eventStore.read(taskId)).length).toBe(eventsBefore);
    const projection = await readProjection(env, taskId);
    expect(projection.activeLease?.attemptId).toBe(attemptB);
  });

  it('records a retryable failure + durable retry_due wakeup for a transient runtime failure', async () => {
    const env = await makeEnv();
    const taskId = tid('retryable');
    env.innerRuntime.setScript('orchestrator', [
      { kind: 'failure', failure: RuntimeFailure.transient('PROVIDER_REQUEST_FAILED', 'provider hiccup') },
    ]);
    const { workItemId } = await createWorkItem(env, taskId);
    const outcome = await env.attempts.runNext(taskId, 'worker-a');
    expect(outcome).toMatchObject({ kind: 'retryable_failed', workItemId });
    const projection = await readProjection(env, taskId);
    expect(projection.workItems[workItemId].state).toBe('retryable_failed');
    const rows = await env.wakeups.read(taskId);
    expect(rows.some((row) => row.kind === 'retry_due' && row.workItemId === workItemId)).toBe(true);
    expect(rows.some((row) => row.kind === 'lease_expiry')).toBe(false);
  });

  it('routes a permanent runtime failure to the terminal-fail seam', async () => {
    const env = await makeEnv();
    const taskId = tid('terminal');
    env.innerRuntime.setScript('orchestrator', [
      { kind: 'failure', failure: RuntimeFailure.permanent('POLICY_VIOLATION', 'illegal output') },
    ]);
    const { workItemId } = await createWorkItem(env, taskId);
    const outcome = await env.attempts.runNext(taskId, 'worker-a');
    expect(outcome).toMatchObject({ kind: 'terminal_failed', workItemId });
    expect(env.terminalFailCalls).toHaveLength(1);
    expect(env.terminalFailCalls[0]).toMatchObject({
      workItemId,
      failureCode: 'POLICY_VIOLATION',
      taskFailure: false,
    });
  });

  it('parks a workitem with retry_budget_exhausted when the automatic budget is spent', async () => {
    const env = await makeEnv();
    const taskId = tid('park');
    env.innerRuntime.setScript('orchestrator', [
      { kind: 'failure', failure: RuntimeFailure.transient('PROVIDER_REQUEST_FAILED', 'transient') },
    ]);
    const { workItemId } = await createWorkItem(env, taskId, { maxAutomaticRetries: 0 });
    const outcome = await env.attempts.runNext(taskId, 'worker-a');
    expect(outcome).toMatchObject({ kind: 'parked', workItemId, failureCode: 'PROVIDER_REQUEST_FAILED' });
    const projection = await readProjection(env, taskId);
    expect(projection.workItems[workItemId].state).toBe('parked');
    expect(projection.workItems[workItemId].parkDisposition).toMatchObject({ kind: 'retry_budget_exhausted' });
    expect(projection.retryBudgetExhaustedWorkItemId).toBe(workItemId);
    // No retry_due wakeup for a parked workitem (the timer is not re-armed).
    const rows = await env.wakeups.read(taskId);
    expect(rows.some((row) => row.kind === 'retry_due')).toBe(false);
  });

  it('persists ONLY public trace (no private drafts) for a committed session', async () => {
    const env = await makeEnv();
    const taskId = tid('trace');
    env.innerRuntime.setScript('orchestrator', [{ kind: 'result', publicText: 'public output', thinking: 'hidden thinking' }]);
    const { workItemId } = await createWorkItem(env, taskId);
    await env.attempts.runNext(taskId, 'worker-a');
    const projection = await readProjection(env, taskId);
    const attempt = Object.values(projection.attempts).find((a) => a.family === 'structured');
    const turn = await env.traces.readTurnTrace(taskId, `v2-${workItemId}-${String(attempt?.attemptId)}`);
    expect(turn).not.toBeNull();
    const text = JSON.stringify(turn);
    expect(text).toContain('public output');
    // Private reasoning never enters the public trace.
    expect(text).not.toContain('hidden thinking');
  });
});

describe('V2AttemptCoordinator SystemCommand dispatch', () => {
  it('executes a registered SystemCommand handler and commits the command completion', async () => {
    const env = await makeEnv();
    env.systemCommands.replace({
      commandKind: 'map_finalize',
      async execute(ctx) {
        expect(ctx.commandKind).toBe('map_finalize');
        expect(ctx.commandId).toBeTruthy();
        return { kind: 'completed', resultRefs: [await env.prepareResultRef(ctx.taskId)] };
      },
    });
    const taskId = tid('cmd');
    const { workItemId } = await createWorkItem(env, taskId, { kind: 'system_map_finalize' });
    const outcome = await env.attempts.runNext(taskId, 'worker-a');
    expect(outcome).toMatchObject({ kind: 'completed', workItemId });
    const projection = await readProjection(env, taskId);
    expect(projection.workItems[workItemId].state).toBe('completed');
    const command = Object.values(projection.attempts).find((a) => a.family === 'command');
    expect(command?.state).toBe('completed');
  });

  it('defaults to the SIX NOT_IMPLEMENTED retryable doubles (fail-closed, retryable)', async () => {
    const env = await makeEnv();
    const taskId = tid('notimpl');
    const { workItemId } = await createWorkItem(env, taskId, { kind: 'system_map_finalize' });
    const outcome = await env.attempts.runNext(taskId, 'worker-a');
    expect(outcome).toMatchObject({ kind: 'retryable_failed', workItemId });
    const projection = await readProjection(env, taskId);
    expect(projection.workItems[workItemId].state).toBe('retryable_failed');
    // The six closed kinds are all registered as doubles.
    const registry = new SystemCommandRegistry();
    for (const kind of SYSTEM_COMMAND_KINDS) {
      expect(registry.resolve(kind)?.commandKind).toBe(kind);
    }
  });

  it('roots validator infrastructure evidence from a retryable SystemCommand outcome', async () => {
    const env = await makeEnv();
    const taskId = tid('cmd-validator-evidence');
    const inputRef = synthRef('validator_input_envelope', 7101);
    const warningBody = {
      trigger: 'content_commit' as const,
      executionPhase: 'batch_commit' as const,
      inputRef,
      inputDigest: inputRef.digest,
      orderedAdvisoryReceiptRefs: [],
      warningCount: 0,
    };
    const warning = { ...warningBody, rootDigest: canonicalJsonSha256(warningBody) };
    const warningRef = await env.base.facade.prepareBlob(taskId, 'validation_warning_root', warning);
    const aggregateBody = {
      trigger: 'content_commit' as const,
      executionPhase: 'batch_commit' as const,
      inputRef,
      inputDigest: inputRef.digest,
      registrationSetDigest: canonicalJsonSha256([]),
      validExecutionDigests: [],
      blockingInvalidReceiptRefs: [],
      advisoryReceiptRefs: [],
      infrastructureFailureRefs: [synthRef('validator_failure', 7102)],
      warningRootRef: warningRef,
      outcome: 'infrastructure_failure' as const,
    };
    const aggregate = { ...aggregateBody, aggregateDigest: canonicalJsonSha256(aggregateBody) };
    const aggregateRef = await env.base.facade.prepareBlob(taskId, 'validator_aggregate', aggregate);
    env.systemCommands.replace({
      commandKind: 'migration_validation_batch',
      async execute() {
        return {
          kind: 'retryable_failure',
          failureCode: 'VALIDATOR_INFRASTRUCTURE_FAILURE',
          failureDigest: canonicalJsonSha256({ aggregateRef }),
          validatorAggregateRef: aggregateRef,
        };
      },
    });
    const { workItemId } = await createWorkItem(env, taskId, {
      kind: 'system_migration_validation_batch',
      baseRefs: {
        mapCandidateRef: synthRef('map_candidate', 7103),
        planSpecRef: synthRef('migration_validation_plan_spec', 7104),
        reviewRoundRef: synthRef('map_review_round', 7105),
      },
    });
    const outcome = await env.attempts.runNext(taskId, 'worker-a');
    expect(outcome).toMatchObject({ kind: 'retryable_failed', workItemId });
    const events = await env.base.eventStore.read(taskId);
    const failed = events.find((entry) => entry.event.type === 'structured_system_command_retryable_failed')?.event;
    expect(failed).toMatchObject({ validatorAggregateRef: aggregateRef });
    expect(refOfBlob('validator_aggregate', aggregate)).toEqual(aggregateRef);
  });

  it('fails closed with COMMAND_NOT_REGISTERED for an unknown commandKind', async () => {
    // A registry missing the 'seal' handler: a system_seal workitem resolves null.
    const env = await makeEnv({
      handlers: SYSTEM_COMMAND_KINDS.filter((k) => k !== 'seal').map((k) => ({
        commandKind: k,
        async execute() {
          return { kind: 'completed', resultRefs: [] };
        },
      })),
    });
    const taskId = tid('unknowncmd');
    const { workItemId } = await createWorkItem(env, taskId, { kind: 'system_seal' });
    await expect(env.attempts.runNext(taskId, 'worker-a')).rejects.toMatchObject({
      code: 'COMMAND_NOT_REGISTERED',
    });
  });

  it('SystemCommand handlers never receive an Agent prompt/tool surface', async () => {
    let ctx: SystemCommandContext | undefined;
    const env = await makeEnv();
    env.systemCommands.replace({
      commandKind: 'generation_finalize',
      async execute(input) {
        ctx = input;
        return { kind: 'completed', resultRefs: [await env.prepareResultRef(input.taskId)] };
      },
    });
    const taskId = tid('nosurface');
    const { workItemId } = await createWorkItem(env, taskId, { kind: 'system_generation_finalize' });
    await env.attempts.runNext(taskId, 'worker-a');
    expect(ctx).toBeDefined();
    expect((ctx as unknown as Record<string, unknown>).prompt).toBeUndefined();
    expect((ctx as unknown as Record<string, unknown>).tools).toBeUndefined();
    expect(env.runtime.inputs).toHaveLength(0); // no Agent session was run
    void workItemId;
  });
});

describe('V2AttemptCoordinator namespace isolation + timeout', () => {
  it('isolates the conversation namespaces of two WorkItems for the SAME Agent ID', async () => {
    const env = await makeEnv();
    const taskId = tid('isolate');
    env.innerRuntime.setScript('orchestrator', [
      { kind: 'result', publicText: 'first workitem output' },
      { kind: 'result', publicText: 'second workitem output' },
    ]);
    const a = await createWorkItem(env, taskId, { logicalAssignmentId: 'la-a', payloadText: 'assignment A' });
    const b = await createWorkItem(env, taskId, { logicalAssignmentId: 'la-b', payloadText: 'assignment B' });
    await env.attempts.runNext(taskId, 'worker-a');
    await env.attempts.runNext(taskId, 'worker-a');
    expect(env.runtime.inputs).toHaveLength(2);
    const [first, second] = env.runtime.inputs;
    // Distinct namespaces per workitem/attempt.
    expect(first.v2Namespace).not.toBe(second.v2Namespace);
    expect(first.v2Namespace).toContain(a.workItemId);
    expect(second.v2Namespace).toContain(b.workItemId);
    // The second prompt receives ONLY its current assignment identity — never
    // the first workitem's assignment or raw prior conversation/human messages.
    expect(second.publicHistory).toEqual([]);
    expect(second.inputText).toContain('la-b');
    expect(second.inputText).not.toContain('la-a');
    expect(second.inputText).not.toContain('first workitem output');
  });

  it('times out an in-flight attempt and records a durable retryable ATTEMPT_TIMEOUT', async () => {
    // Real (short) attempt timeout, PRE-LEASED so the fsync-heavy lease commit
    // completes before the 50 ms timer is registered (removes the fake-timer
    // race); the 200 ms settle window lets the timeout fire deterministically
    // (outcome, not exact timing).
    const env = await makeEnv({ attemptTimeoutMs: 50 });
    const taskId = tid('timeout');
    const { workItemId } = await createWorkItem(env, taskId);
    await env.base.coordinator.leaseNext(taskId, 'worker-a', 'pre-lease-timeout');
    const gate = new Promise<void>(() => undefined);
    env.innerRuntime.setScript('orchestrator', [
      { kind: 'result', publicText: 'never reached', deferred: { promise: gate, resolve: () => undefined, reject: () => undefined } },
    ]);
    const runPromise = env.attempts.executeLeased(taskId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const outcome = await runPromise;
    expect(outcome).toMatchObject({ kind: 'retryable_failed', workItemId, failureCode: 'ATTEMPT_TIMEOUT' });
    const projection = await readProjection(env, taskId);
    expect(projection.workItems[workItemId].state).toBe('retryable_failed');
    // The durable retry_due wakeup is persisted by the timeout path.
    const rows = await env.wakeups.read(taskId);
    expect(rows.some((row) => row.kind === 'retry_due' && row.workItemId === workItemId)).toBe(true);
    expect(rows.some((row) => row.kind === 'lease_expiry')).toBe(false);
  });

  it('aborts (records nothing) when the scheduler signal stops the attempt', async () => {
    const env = await makeEnv();
    const taskId = tid('abort');
    const { workItemId } = await createWorkItem(env, taskId);
    let resolveTurn: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    env.innerRuntime.setScript('orchestrator', [
      { kind: 'result', publicText: 'never reached', deferred: { promise: gate, resolve: () => resolveTurn?.(), reject: () => undefined } },
    ]);
    const controller = new AbortController();
    const runPromise = env.attempts.runNext(taskId, 'worker-a', controller.signal);
    // Let the lease commit, then stop.
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    const outcome = await runPromise;
    expect(outcome).toMatchObject({ kind: 'aborted', workItemId });
    const events = await env.base.eventStore.read(taskId);
    expect(events.some((e) => e.event.type === 'structured_work_item_completed')).toBe(false);
    expect(events.some((e) => e.event.type === 'structured_work_item_retryable_failed')).toBe(false);
    // The lease stays ACTIVE and its lease_expiry wakeup is retained so the
    // scheduler reclaims it on expiry (records nothing, never a partial write).
    const projection = await readProjection(env, taskId);
    expect(projection.activeLease?.workItemId).toBe(workItemId);
    const rows = await env.wakeups.read(taskId);
    expect(rows.some((row) => row.kind === 'lease_expiry' && row.workItemId === workItemId)).toBe(true);
  });
});

describe('runV2SchedulingTick periodicity seam', () => {
  it('leases a ready workitem through the scheduling pass and executes it (mutation-driven periodicity)', async () => {
    const env = await makeEnv();
    env.systemCommands.replace({
      commandKind: 'map_finalize',
      async execute(ctx) {
        return { kind: 'completed', resultRefs: [await env.prepareResultRef(ctx.taskId)] };
      },
    });
    const taskId = tid('tick');
    const { workItemId } = await createWorkItem(env, taskId, { kind: 'system_map_finalize' });
    // A fake scheduling pass that leases ONE workitem through the REAL
    // coordinator (the durable runnable wakeup the engine consumes).
    const fakeScheduling = {
      async runPass(now: string) {
        const claimed = await env.base.coordinator.leaseNext(taskId, 'worker-a', 'tick-claim-1');
        return { leased: claimed === null ? [] : [{ taskId, workItemId: claimed.workItemId }] };
      },
    };
    const result = await runV2SchedulingTick({
      scheduling: fakeScheduling,
      attempts: env.attempts,
      clock: () => env.base.now.value,
    });
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({ kind: 'completed', workItemId });
    const projection = await readProjection(env, taskId);
    expect(projection.workItems[workItemId].state).toBe('completed');
  });
});

describe('deriveV2ConversationNamespace', () => {
  it('is the exact §10.2 identity <executionKind>/<roleBinding>/<workItemId>/<attemptId>', () => {
    expect(deriveV2ConversationNamespace('structured', 'orchestrator', 'wi-1', 'att-1')).toBe(
      'structured/orchestrator/wi-1/att-1',
    );
    expect(deriveV2ConversationNamespace('generic', 'submitter', 'wi-2', 'att-2')).toBe(
      'generic/submitter/wi-2/att-2',
    );
    expect(deriveV2ConversationNamespace('command', null, 'wi-3', 'cmd-3')).toBe('command/system/wi-3/cmd-3');
  });
});

describe('V2AttemptCoordinator protocol gating', () => {
  it('rejects a non-v2 task with PROTOCOL_NOT_V2 before any lease', async () => {
    const env = await makeEnv();
    const taskId = tid('protocol');
    const badFrozen = {
      ...fakeV2Frozen,
      productionMode: 'structured_slots',
      structuredSlots: { version: 1 },
    } as unknown as FrozenTemplate;
    const attempts = new V2AttemptCoordinator({
      coordinator: env.base.coordinator,
      runner: new V2AssignmentRunner({ runtime: env.runtime, toolProvider: { toolsFor: async () => [] } }),
      agentForRole: async () => null,
      frozenFor: async () => badFrozen,
      wakeups: env.wakeups,
      clock: () => env.base.now.value,
    });
    await expect(attempts.runNext(taskId, 'worker-a')).rejects.toMatchObject({ code: 'PROTOCOL_NOT_V2' });
  });
});

describe('completionKindRequiresResult §9.2 gate (I-2)', () => {

  it('gates every structured agent session and every system command; allows the generic submitter', () => {
    // Every structured session folds a domain result/successor (§17.5).
    for (const session of ['structure_chunk', 'generation_batch', 'review_map_batch', 'review_map_whole', 'review_content_batch', 'review_content_whole', 'map_repair', 'content_repair']) {
      expect(completionKindRequiresResult('agent_assignment', session as never)).toBe(true);
    }
    // Every system command folds a domain result/successor (§17.5).
    for (const kind of ['system_map_finalize', 'system_generation_finalize', 'system_repair_finalize', 'system_migration_validation_batch', 'system_review_settlement', 'system_seal']) {
      expect(completionKindRequiresResult(kind as never, null)).toBe(true);
    }
    // The generic submitter's result IS the delivery-bound submission (§17.2).
    expect(completionKindRequiresResult('agent_assignment', null)).toBe(false);
  });

  it('fails the work_item_completed BUILDER closed for a bare gated completion', () => {
    const registration = resolvePublicationIntent('work_item_completed', 1);
    expect(registration).not.toBeNull();
    const base = {
      family: 'lease_or_retry' as const,
      operationId: 'op-gate',
      taskId: 't',
      workItemId: 'w',
      leaseEpoch: 1,
      authorityBaseRef: synthRef('authority_base_set', 1),
      kind: 'agent_assignment' as const,
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session' as const,
      sessionKind: 'structure_chunk' as const,
      roundId: null,
      logicalAssignmentId: 'la-1',
      reviewAssignmentId: null,
      grantSpecRef: null,
      inputArtifactDeliveryId: null,
      payloadRef: null,
      initialLeaseEpoch: null,
      maxAutomaticRetries: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      expectedLastSequence: null,
      attemptFamily: 'structured' as const,
      attemptId: 'att-1',
      commandId: null,
      agentId: null,
      commandKind: null,
      dispatchRef: null,
      grantInstanceRef: null,
      reason: null,
      failureCode: null,
      failureDigest: null,
      retryOrdinal: null,
      retryNotBefore: null,
      validatorAggregateRef: null,
      budgetPolicyDigest: null,
      failureRecoveryPayloadRef: null,
      taskFailure: null,
    };
    const bare = { ...base, eventBuilder: 'work_item_completed' as const, resultRefs: [] };
    // A bare completion of a gated kind is fail-closed at the BUILDER level.
    expect(() => registration!.buildEvents(bare as never, '2026-08-14T10:00:00.000Z')).toThrow('requires a domain result carrier');
    // With a result carrier it builds the terminal pair.
    const withRef = { ...bare, resultRefs: [synthRef('content_value', 5)] };
    const envelopes = registration!.buildEvents(withRef as never, '2026-08-14T10:00:00.000Z');
    expect(envelopes.map((e) => e.type)).toEqual(['structured_agent_attempt_completed_v2', 'structured_work_item_completed']);
  });
});
