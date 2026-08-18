// @vitest-environment node
/**
 * Production domain-runtime integration coverage.
 *
 * This crosses the real CoreService storage/lifecycle/scheduler boundary and
 * then executes a Pi-shaped tool against the task-scoped production handler.
 * It deliberately does not install a test-only handler double: the handler
 * must append the authoritative map-build event and the tool factory must
 * fold the resulting chunk ref into the attempt result.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CoreService } from '../../core-service';
import { disposeAllTestRoots, makeTempCorePaths } from '../../test-support';
import { createTestRuntimeEnvironment } from '../../structured-slots/runtime-capability';
import { createAuthoritativeReviewTestEnvironment } from '../../structured-slots/test-support/authoritative-review-test-registry';
import { FakeAgentRuntime } from '../fake-agent-runtime';
import { ProductionV2DomainRuntimeFactory } from './production-domain-runtime';
import { serializeCompiledSchema } from './production-domain-runtime';
import { ProductionV2ToolRuntime } from './production-tool-runtime';
import { MapReviewService } from './map-review-service';
import { ContentReviewService } from './content-review-service';
import { compileSlotSchemaV1 } from '../../structured-slots/slot-schema';
import type { StructuredSlotLimitsV1 } from '../../../shared/structured-slots';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { FrozenReviewAssignmentV2 } from './tool-factory';

afterEach(() => disposeAllTestRoots());

const TEMPLATE_ID = 'authoritative-valid';

const schemaLimits = {
  schema: { maxSchemaDepth: 8, maxSchemaNodes: 32, maxEnumItems: 8, maxPatternLength: 64 },
} as StructuredSlotLimitsV1;

describe('production v2 domain runtime', { timeout: 30_000 }, () => {
  it('serializes compiled slot-schema matchers before they cross the Pi boundary', () => {
    const compiled = compileSlotSchemaV1({
      type: 'object',
      additionalProperties: {
        type: 'string',
        pattern: '^chapter-[a-z]+$',
      },
    }, schemaLimits);
    const publicSchema = serializeCompiledSchema(compiled);

    expect(() => structuredClone(publicSchema)).not.toThrow();
    expect(publicSchema).toMatchObject({
      additionalProperties: {
        type: 'string',
        pattern: { pattern: '^chapter-[a-z]+$', sourceLength: 16 },
      },
    });
  });

  it('executes a real task-scoped map tool and folds its authoritative result ref', async () => {
    const roots = makeTempCorePaths('forge-core-production-domain-');
    cpSync(
      fileURLToPath(new URL('../../template/__fixtures__/authoritative-valid', import.meta.url)),
      join(roots.templateRoot, TEMPLATE_ID),
      { recursive: true },
    );
    const environment = createAuthoritativeReviewTestEnvironment();
    const service = new CoreService(roots.paths, {
      runtime: new FakeAgentRuntime(),
      runtimeEnvironment: createTestRuntimeEnvironment(),
      authoritativeReviewEnvironment: environment,
    });
    await service.initialize();

    const task = await service.createTask({
      templateId: TEMPLATE_ID,
      name: 'production domain runtime',
      input: { 'source-text': '素材。' },
    });
    await service.v2Lifecycle.startV2(task.id, {
      operationId: 'production-domain-start-000000000000000000000000000',
      userInputText: '',
    });
    const pass = await service.runV2SchedulingPass('2026-08-18T00:00:00.000Z');
    const leased = pass.leased[0];
    expect(leased?.taskId).toBe(task.id);

    const state = await service.v2CheckpointStore.readState(task.id, (ref) =>
      service.v2BlobStore.readJson(task.id, ref, ref.kind),
    );
    const lease = state.projection.activeLease;
    expect(lease).not.toBeNull();
    const context = await service.v2Composition.attempts.contextForAttempt(
      task.id,
      leased!.workItemId,
      lease!.attemptId!,
    );
    expect(context).not.toBeNull();

    const frozen = await service.tasks.readFrozenTemplate(task.id);
    const record = await service.tasks.readTaskRecord(task.id);
    const indexRow = await service.v2Index.entryFor(task.id);
    expect(indexRow).not.toBeNull();
    if (indexRow === null || indexRow.state === 'legacy_preexisting') {
      throw new Error('created authoritative task did not receive an active v2 index row');
    }
    expect(frozen.authoritativeReviewProfile).not.toBeNull();

    const readProjection = async (taskId: string) =>
      (await service.v2CheckpointStore.readState(taskId, (ref) =>
        service.v2BlobStore.readJson(taskId, ref, ref.kind),
      )).projection;
    const readEvents = async (taskId: string): Promise<readonly AuthoritativeReviewEventV2[]> =>
      (await service.events.read(taskId)).map((entry) => entry.event as AuthoritativeReviewEventV2);
    const committedOperation = async (taskId: string, operationId: string) => {
      const entries = await service.events.readBatchByCommitId(taskId, operationId);
      return entries === null ? null : entries.map((entry) => entry.event as AuthoritativeReviewEventV2);
    };
    const runtimeFactory = new ProductionV2DomainRuntimeFactory({
      paths: roots.paths,
      facade: service.v2Facade,
      coordinator: service.v2Coordinator,
      profileBody: async () => environment.profile!,
      frozenProfile: async () => ({
        profileSnapshotRef: indexRow!.profileSnapshotRef,
        templateSnapshotRef: indexRow!.templateSnapshotRef,
        profileDigest: frozen.authoritativeReviewProfile!.profileDigest,
        snapshotHash: record.templateVersion,
      }),
      frozenTemplate: (taskId) => service.tasks.readFrozenTemplate(taskId),
      readProjection,
      resolver: (taskId, ref: BlobRefV2) => service.v2BlobStore.readJson(taskId, ref, ref.kind),
      tail: (taskId) => service.events.tail(taskId),
      readEvents,
      committedOperation,
      defaultAutomaticRetries: async () => environment.profile!.runtime.maxConsecutiveAttemptsWithoutProgress,
      clock: () => '2026-08-18T00:00:00.000Z',
    });
    const domain = await runtimeFactory.for(task.id);
    expect(domain).toBeDefined();

    const runtime = new ProductionV2ToolRuntime({
      paths: roots.paths,
      profileBody: async () => environment.profile!,
      readProjection,
      resolver: (taskId, ref) => service.v2BlobStore.readJson(taskId, ref, ref.kind),
      contextResolver: async () => context,
      taskRuntimeFor: (taskId) => runtimeFactory.for(taskId),
    });
    const tools = await runtime.toolsFor(context!);
    expect(tools.map((tool) => tool.name)).toEqual([
      'read_structure_contract',
      'read_map_build_frontier',
      'append_map_candidate_chunk',
      'finish_map_build',
    ]);

    const frontierTool = tools.find((tool) => tool.name === 'read_map_build_frontier')!;
    const contractTool = tools.find((tool) => tool.name === 'read_structure_contract')!;
    const contractResult = await contractTool.execute(
      'contract-read',
      {},
      new AbortController().signal,
      undefined,
      {} as never,
    );
    expect(() => structuredClone(contractResult)).not.toThrow();

    const frontierResult = await frontierTool.execute(
      'frontier-read',
      { limit: 10 },
      new AbortController().signal,
      undefined,
      {} as never,
    );
    const frontier = frontierResult.details as {
      ok: boolean;
      data: { mapBuildId: string; frontierDigest: string };
    };
    expect(frontier.ok).toBe(true);

    const appendTool = tools.find((tool) => tool.name === 'append_map_candidate_chunk')!;
    const appendResult = await appendTool.execute(
      'chunk-append',
      {
        ordinal: 1,
        expectedFrontierDigest: frontier.data.frontierDigest,
        nodes: [{
          buildNodeKey: 'root',
          slotType: 'document',
          parentBuildNodeKey: null,
          documentOrder: 1,
          siblingOrder: 0,
          contentBearing: false,
        }],
        relations: [],
        clientOperationId: 'production-domain-chunk-000000000000000000000000000',
      },
      new AbortController().signal,
      undefined,
      {} as never,
    );
    const appended = appendResult.details as { ok: boolean; data: { chunkRef: BlobRefV2 } };
    expect(appended.ok).toBe(true);
    expect(appended.data.chunkRef.kind).toBe('map_build_chunk');

    const events = await service.events.read(task.id);
    expect(events.some((entry) => entry.event.type === 'structured_map_chunk_committed')).toBe(true);
    await expect(runtime.collectResultRefs(context!)).resolves.toEqual([appended.data.chunkRef]);

    const mapFreeze = vi.spyOn(MapReviewService.prototype, 'freezeReviewAssignment').mockResolvedValue({
      ledgerRef: appended.data.chunkRef,
      eventId: 'map-freeze-event',
    });
    const mapAdvance = vi.spyOn(MapReviewService.prototype, 'maybeCompleteRound').mockResolvedValue(true);
    const contentFreeze = vi.spyOn(ContentReviewService.prototype, 'freezeReviewAssignment').mockResolvedValue({
      ledgerRef: appended.data.chunkRef,
      eventId: 'content-freeze-event',
    });
    const contentAdvance = vi.spyOn(ContentReviewService.prototype, 'maybeCompleteRound').mockResolvedValue(true);

    const freeze = (roundKind: 'map' | 'content', roundId: string): FrozenReviewAssignmentV2 => ({
      ledger: {
        assignmentId: `assignment-${roundId}`,
        workItemId: `work-item-${roundId}`,
        reviewAssignmentId: null,
        roundKind,
        roundId,
        factRefs: [],
        findingDraftRefs: [],
        verificationRecordRefs: [],
        coverageTargetIds: [],
        ledgerDigest: '0'.repeat(64),
      },
      facts: [],
      verifications: [],
      findings: [],
      factRefs: [],
      verificationRecordRefs: [],
      findingDraftRefs: [],
      wholeObservationRefs: [],
      routingObligations: [],
    });

    await expect(domain!.freezeReviewAssignment(task.id, freeze('map', 'round-map'))).resolves.toEqual({
      ledgerRef: appended.data.chunkRef,
      eventId: 'map-freeze-event',
    });
    await expect(domain!.freezeReviewAssignment(task.id, freeze('content', 'round-content'))).resolves.toEqual({
      ledgerRef: appended.data.chunkRef,
      eventId: 'content-freeze-event',
    });
    expect(mapFreeze).toHaveBeenCalledTimes(1);
    expect(mapAdvance).toHaveBeenCalledWith(task.id, 'round-map');
    expect(contentFreeze).toHaveBeenCalledTimes(1);
    expect(contentAdvance).toHaveBeenCalledWith(task.id, 'round-content');
  });
});
