// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import type { FrozenAgentConfig } from '../../template/template-schema';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import { refOfBlob } from '../../authoritative-review/object-registry';
import { buildAuthorityBaseSet } from './authority-base';
import { ProductionV2ToolRuntime } from './production-tool-runtime';
import {
  authoritativeTestContentValue,
  createWorkItemCoordinatorEnvironment,
  disposeRuntimeTestRoots,
} from '../test-support';
import { buildAuthoritativeReviewTestProfileBody } from '../../structured-slots/test-support/authoritative-review-test-registry';

afterEach(() => disposeRuntimeTestRoots());

const ORCHESTRATOR: FrozenAgentConfig = {
  id: 'orchestrator',
  name: 'orchestrator',
  description: 'neutral orchestrator fixture',
  systemPrompt: 'Run the assignment.',
  model: 'configured/test-model',
  skills: [],
  gate: null,
  slotCapabilities: [],
  turnContract: null,
};

describe('ProductionV2ToolRuntime', () => {
  it('binds Pi tools to the leased task owner while keeping the frozen role Agent separate', async () => {
    const env = await createWorkItemCoordinatorEnvironment();
    const taskId = 'task-production-tool-runtime';
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
    const workItemId = 'wi-production-tool-runtime';
    await env.coordinator.createWorkItem({
      taskId,
      operationId: 'create-tool-runtime-000000000000000000000000000000',
      workItemId,
      kind: 'agent_assignment',
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
      logicalAssignmentId: 'la-production-tool-runtime',
      reviewAssignmentId: null,
      inputArtifactDeliveryId: null,
      payload: { kind: 'content_value', value: authoritativeTestContentValue('assignment') },
      authorityBase,
      grantSpec: {
        build: (authorityBaseRef: BlobRefV2) => env.structureChunkGrantSpec(authorityBaseRef, mapBuildSpecRef),
      },
      maxAutomaticRetries: 2,
    });
    const leased = await env.coordinator.leaseNext(taskId, 'task_owner', 'lease-tool-runtime-0000000000000000000000000000');
    expect(leased?.attemptId).toBeTruthy();
    expect(leased?.dispatchRef).not.toBeNull();

    const context = {
      taskId,
      workItemId,
      attemptId: leased!.attemptId!,
      leaseEpoch: leased!.leaseEpoch,
      namespace: `structured/orchestrator/${workItemId}/${leased!.attemptId!}`,
      agentId: leased!.leaseOwner,
      roleBinding: 'orchestrator',
      executionKind: 'structured' as const,
      sessionKind: 'structure_chunk',
      dispatchRef: leased!.dispatchRef,
      authorityBaseRef: leased!.authorityBaseRef,
      grantInstanceRef: leased!.grantInstanceRef,
      inputArtifactDeliveryId: null,
      agent: ORCHESTRATOR,
      currentAssignmentText: '',
      committedCheckpointText: '',
    };
    const runtime = new ProductionV2ToolRuntime({
      paths: env.paths,
      profileBody: async () => buildAuthoritativeReviewTestProfileBody(),
      readProjection: (id) => env.readProjection(id),
      resolver: (id, ref) => env.blobStore.readJson(id, ref, ref.kind),
      contextResolver: async () => context,
    });

    const toolContext = await runtime.createContext({
      taskId,
      turnId: `v2-${workItemId}-${leased!.attemptId!}`,
      agent: ORCHESTRATOR,
      inputNodeId: workItemId,
      inputText: '',
      publicHistory: [],
      availableSkills: [],
      loadedSkills: [],
      slotSession: null,
      v2Session: { signal: new AbortController().signal },
      v2Namespace: context.namespace,
    });

    expect(context.agentId).toBe('task_owner');
    expect(context.agent.id).toBe('orchestrator');
    expect(toolContext?.toolDefinitions.map((tool) => tool.name)).toEqual([
      'read_structure_contract',
      'read_map_build_frontier',
      'append_map_candidate_chunk',
      'finish_map_build',
    ]);
  });

  it('collects the authoritative result ref written by a real domain handler', async () => {
    const env = await createWorkItemCoordinatorEnvironment();
    const taskId = 'task-production-tool-runtime-result';
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
    const workItemId = 'wi-production-tool-runtime-result';
    await env.coordinator.createWorkItem({
      taskId,
      operationId: 'create-tool-runtime-result-000000000000000000000000000',
      workItemId,
      kind: 'agent_assignment',
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
      logicalAssignmentId: 'la-production-tool-runtime-result',
      reviewAssignmentId: null,
      inputArtifactDeliveryId: null,
      payload: { kind: 'content_value', value: authoritativeTestContentValue('assignment') },
      authorityBase,
      grantSpec: {
        build: (authorityBaseRef: BlobRefV2) => env.structureChunkGrantSpec(authorityBaseRef, mapBuildSpecRef),
      },
      maxAutomaticRetries: 2,
    });
    const leased = await env.coordinator.leaseNext(taskId, 'task_owner', 'lease-tool-runtime-result-000000000000000000000000');
    expect(leased?.attemptId).toBeTruthy();
    const context = {
      taskId,
      workItemId,
      attemptId: leased!.attemptId!,
      leaseEpoch: leased!.leaseEpoch,
      namespace: `structured/orchestrator/${workItemId}/${leased!.attemptId!}`,
      agentId: leased!.leaseOwner,
      roleBinding: 'orchestrator',
      executionKind: 'structured' as const,
      sessionKind: 'structure_chunk',
      dispatchRef: leased!.dispatchRef,
      authorityBaseRef: leased!.authorityBaseRef,
      grantInstanceRef: leased!.grantInstanceRef,
      inputArtifactDeliveryId: null,
      agent: ORCHESTRATOR,
      currentAssignmentText: '',
      committedCheckpointText: '',
    };
    const chunkRef = refOfBlob('map_build_chunk', { result: 'chunk' });
    const runtime = new ProductionV2ToolRuntime({
      paths: env.paths,
      profileBody: async () => buildAuthoritativeReviewTestProfileBody(),
      readProjection: (id) => env.readProjection(id),
      resolver: (id, ref) => env.blobStore.readJson(id, ref, ref.kind),
      contextResolver: async () => context,
      handlersFor: async () => ({
        appendMapCandidateChunk: async () => ({ accepted: true, chunkRef }),
      }),
    });
    const tools = await runtime.toolsFor(context);
    const append = tools.find((tool) => tool.name === 'append_map_candidate_chunk');
    expect(append).toBeDefined();
    const result = await append!.execute('tool-call', {
      ordinal: 1,
      expectedFrontierDigest: '0'.repeat(64),
      nodes: [{ buildNodeKey: 'root', slotType: 'chapter', documentOrder: 0, siblingOrder: 0, contentBearing: false }],
      relations: [],
      clientOperationId: 'append-result-ref',
    }, undefined, undefined, {} as never) as { details: { ok: boolean } };

    expect(result.details.ok).toBe(true);
    expect(await runtime.collectResultRefs(context)).toEqual([chunkRef]);
  });
});
