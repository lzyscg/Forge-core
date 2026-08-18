// @vitest-environment node
/**
 * Production composition regression coverage.
 *
 * This intentionally drives the installed production tick instead of calling
 * V2AttemptCoordinator directly: a lease/attempt-start event is not proof
 * that the Agent runtime was actually invoked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FrozenTemplate } from '../../template/template-schema';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import { ArtifactStore } from '../../storage/artifact-store';
import { AuthoritativeWakeupIndexV1 } from './wakeup-index';
import { TraceStore } from '../../storage/trace-store';
import { FakeAgentRuntime } from '../fake-agent-runtime';
import { V2AssignmentRunner } from './assignment-runner';
import { buildAuthorityBaseSet } from './authority-base';
import { installAuthoritativeReviewRuntime } from './production-composition';
import {
  authoritativeTestContentValue,
  createWorkItemCoordinatorEnvironment,
  disposeRuntimeTestRoots,
} from '../test-support';

afterEach(() => disposeRuntimeTestRoots());

const ORCHESTRATOR = {
  id: 'orchestrator',
  name: 'Orchestrator',
  description: 'production tick regression agent',
  systemPrompt: 'Run the current assignment.',
  model: 'configured/test-model',
  skills: [],
  gate: null,
  slotCapabilities: [],
  turnContract: null,
};

const FROZEN_TEMPLATE = {
  id: 'production-tick-regression',
  name: 'Production tick regression',
  description: 'production tick regression fixture',
  versionHash: '0'.repeat(64),
  inputFields: [],
  agents: [ORCHESTRATOR],
  routes: [],
  artifactSchema: { files: [] },
  finalOutput: { name: 'output', format: 'text', submitters: ['orchestrator'] },
  budget: null,
  productionMode: 'structured_slots',
  structuredSlots: { version: 2 },
  structuredReviewLifecycle: null,
} as unknown as FrozenTemplate;

function uuidLike(label: string): string {
  return `${label.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-000000000001`;
}

function eligible() {
  return {
    state: 'eligible' as const,
    frozenProfileDigest: '1'.repeat(64),
    currentProfileDigest: '1'.repeat(64),
  };
}

describe('production composition Agent execution', () => {
  it('executes a freshly leased agent assignment through the real tick', async () => {
    const env = await createWorkItemCoordinatorEnvironment();
    const taskId = 'task-production-tick-agent';
    const mapBuildSpecRef = await env.publishMapBuildSpec(taskId);
    const authorityBase = buildAuthorityBaseSet({
      taskId,
      templateSnapshotRef: env.templateSnapshotRef,
      profileSnapshotRef: env.profileSnapshotRef,
      kind: 'agent_assignment',
      refs: { planSpecRef: mapBuildSpecRef },
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
    });
    const workItemId = 'wi-production-agent';
    await env.coordinator.createWorkItem({
      taskId,
      operationId: uuidLike('create'),
      workItemId,
      kind: 'agent_assignment',
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
      logicalAssignmentId: 'la-production-agent',
      reviewAssignmentId: null,
      inputArtifactDeliveryId: null,
      payload: { kind: 'content_value', value: authoritativeTestContentValue('agent assignment') },
      authorityBase,
      grantSpec: {
        build: (authorityBaseRef: BlobRefV2) => env.structureChunkGrantSpec(authorityBaseRef, mapBuildSpecRef),
      },
      maxAutomaticRetries: 2,
    });

    const runtime = new FakeAgentRuntime({
      scripts: { orchestrator: [{ kind: 'result', publicText: 'agent executed' }] },
    });
    const resultRef = await env.publishContentValue(taskId, 'domain result carrier');
    const ensuredRounds: string[] = [];
    const runner = new V2AssignmentRunner({
      runtime,
      toolProvider: {
        async toolsFor() {
          return [];
        },
        async collectResultRefs() {
          return [resultRef];
        },
      },
    });
    const readProjectionWithPlannedRound = async (id: string) => {
      const projection = await env.readProjection(id);
      return {
        ...projection,
        mapRounds: {
          ...projection.mapRounds,
          'round-production-successor': {
            roundId: 'round-production-successor',
            ordinal: 1,
            state: 'planned' as const,
            consumedOverrideRef: null,
            plannedAtSequence: 1,
            assignmentCount: 1,
          },
        },
      };
    };
    const leasedScheduling = {
      async runPass() {
        const leased = await env.coordinator.leaseNext(taskId, 'task_owner', 'tick-lease-agent');
        return { leased: leased === null ? [] : [{ taskId, workItemId: leased.workItemId }] };
      },
    } as never;
    const advancedRounds: string[] = [];
    const composition = installAuthoritativeReviewRuntime({
      coordinator: env.coordinator,
      facade: env.facade,
      blobStore: env.blobStore,
      wakeups: new AuthoritativeWakeupIndexV1({ paths: env.paths }),
      artifacts: new ArtifactStore(env.paths, env.eventStore, (id, ref) => env.blobStore.readJson(id, ref, ref.kind)),
      scheduling: leasedScheduling,
      readProjection: readProjectionWithPlannedRound,
      resolver: (id, ref) => env.blobStore.readJson(id, ref, ref.kind),
      frozenProfile: async () => ({
        profileSnapshotRef: env.profileSnapshotRef,
        templateSnapshotRef: env.templateSnapshotRef,
        profileDigest: '1'.repeat(64),
        snapshotHash: '2'.repeat(64),
      }),
      frozenTemplate: async () => FROZEN_TEMPLATE,
      profileBody: async () => ({} as never),
      frozenAutomaticRetries: async () => 2,
      eligibility: eligible,
      runner,
      clock: () => env.now.value,
      traces: new TraceStore(env.paths),
      eventStore: env.eventStore,
      publicationStore: env.publicationStore,
      mapReviewService: {
        ensureRoundReviewWorkItems: async (_id: string, roundId: string) => {
          ensuredRounds.push(roundId);
          return true;
        },
        maybeCompleteRound: async (_id: string, roundId: string) => {
          advancedRounds.push(roundId);
          return false;
        },
      } as never,
    });

    const tick = await composition.runTick();

    expect(runtime.countInvocations('orchestrator')).toBe(1);
    expect(tick.outcomes).toHaveLength(1);
    expect(tick.outcomes[0]).toMatchObject({ kind: 'completed', workItemId });
    expect((await env.readProjection(taskId)).workItems[workItemId]?.state).toBe('completed');
    expect(ensuredRounds).toEqual(['round-production-successor']);
    expect(advancedRounds).toEqual(['round-production-successor']);
  });
});
