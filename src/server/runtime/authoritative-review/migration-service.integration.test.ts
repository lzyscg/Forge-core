// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { refOfBlob } from '../../authoritative-review/object-registry';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { FrozenTemplate } from '../../template/template-schema';
import type { SlotContentVersionV2 } from '../../authoritative-review/authority-types';
import { PUBLICATION_INTENT_REGISTRY_V2 } from '../../storage/authoritative-publication-intent-registry';
import { validateAuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import { createWorkItemCoordinatorEnvironment, disposeRuntimeTestRoots } from '../test-support';
import { AuthoritativeWakeupIndexV1 } from './wakeup-index';
import { TraceStore } from '../../storage/trace-store';
import { FakeAgentRuntime } from '../fake-agent-runtime';
import { V2AssignmentRunner } from './assignment-runner';
import { V2AttemptCoordinator } from './attempt-coordinator';
import { buildAuthorityBaseSet } from './authority-base';
import { SystemCommandRegistry } from './system-command-registry';
import { ValidatorRegistry } from './validator-registry';
import { AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES, builtinSourceOf } from './builtin-validators';
import { buildAuthoritativeReviewTestProfileBody } from '../../structured-slots/test-support/authoritative-review-test-registry';
import type { ValidatorRegistrationV2 } from '../../template/structured-slot-contract-v2';
import {
  buildContentMigrationSpec,
  buildMigrationIntent,
  buildMigrationValidationPlanSpec,
  createProductionMigrationRuntime,
} from './migration-service';

afterEach(() => disposeRuntimeTestRoots());

const H = (label: string) => canonicalJsonSha256({ label });
const R = (kind: Parameters<typeof refOfBlob>[0], label: string): BlobRefV2 => refOfBlob(kind, { label });

function registration(handlerKey: string): ValidatorRegistrationV2 {
  const entry = AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES.find((candidate) => candidate.handlerKey === handlerKey);
  if (entry === undefined) throw new Error(`missing builtin ${handlerKey}`);
  return {
    validatorId: `v-${handlerKey.split('.').pop()}`, handlerKey: entry.handlerKey,
    implementationDigest: entry.implementationDigest,
    implementationRef: { kind: 'builtin', moduleId: entry.moduleId, exportName: entry.exportName },
    trigger: entry.trigger, executionPhase: entry.executionPhase, selector: { kind: 'all' },
    enforcement: 'blocking', deterministic: true, inputContractVersion: entry.inputContractVersion,
    outputContractVersion: entry.outputContractVersion, budgetProfileId: entry.budgetProfileId,
  };
}

const frozenV2 = {
  id: 'migration-integration', name: 'Migration integration', description: 'v2', versionHash: '0'.repeat(64),
  inputFields: [], agents: [], routes: [], artifactSchema: { files: [] },
  finalOutput: { name: 'out', format: 'text', submitters: ['submitter'] }, budget: null,
  productionMode: 'structured_slots', structuredSlots: { version: 2 },
} as unknown as FrozenTemplate;

describe('Task 20 production command integration', () => {
  it('runs AttemptCoordinator -> installed registry -> facade -> projector for a real validator batch', async () => {
    const env = await createWorkItemCoordinatorEnvironment({ registry: PUBLICATION_INTENT_REGISTRY_V2 });
    const taskId = 'task-migration-command-integration';
    const objects = new Map<string, unknown>();
    const resolver = async (_taskId: string, ref: BlobRefV2): Promise<unknown> => {
      const local = objects.get(ref.digest);
      return local ?? env.blobStore.readJson(taskId, ref, ref.kind);
    };
    const contentBody = { slotId: 'slot-1', contentSchemaDigest: H('schema'), taskContentRevision: 1, mediaType: 'text/plain' as const, text: 'integrated content' };
    const content = { ...contentBody, selfDigest: canonicalJsonSha256(contentBody) };
    const contentRef = refOfBlob('content_value', content);
    const sourceMapRef = R('map_snapshot', 'source-map');
    const targetMapRef = R('map_snapshot', 'target-map');
    const inputRef = R('validator_input_envelope', 'old-envelope');
    const aggregateRef = R('validator_aggregate', 'old-aggregate');
    const version: SlotContentVersionV2 = {
      state: 'set', slotId: 'slot-1', slotRevision: 1, taskContentRevision: 1,
      mapRef: sourceMapRef, mapSemanticDigest: H('source-semantic'), contentSchemaDigest: contentBody.contentSchemaDigest,
      contentDigest: canonicalJsonSha256(content), blobRef: contentRef,
      provenance: {
        kind: 'generated', producer: { kind: 'generation_batch', planRevisionId: 'gp-1', batchOrdinal: 0, attemptId: 'att-1' },
        contentRevisionCommitCoreRef: R('content_revision_commit_core', 'old-core'), contentCommitValidatorAggregateRef: aggregateRef,
        contentCommitWarningRootRef: R('validation_warning_root', 'old-warning'), committedByAttemptId: 'att-1',
      },
    };
    const versionRef = refOfBlob('content_version', version);
    const node = { slotId: 'slot-1', slotType: 'doc', contentBearing: true, parentSlotId: null, documentOrder: 0, siblingOrder: 0, nodeSpecDigest: H('node') };
    objects.set(contentRef.digest, content);
    objects.set(versionRef.digest, version);
    objects.set(inputRef.digest, { selectedTargetRefs: [contentRef] });
    objects.set(aggregateRef.digest, { inputRef, registrationSetDigest: H('old-registry'), outcome: 'clear' });
    objects.set(sourceMapRef.digest, { nodes: [node], relations: [] });
    objects.set(targetMapRef.digest, { nodes: [{ ...node, documentOrder: 1 }], relations: [] });

    const sourceManifestRef = R('content_revision_manifest', 'source-manifest');
    const mapSettlementRef = R('map_review_settlement_core', 'map-settlement');
    const coverageRef = R('map_review_coverage_core', 'coverage');
    const reviewRoundRef = R('map_review_round', 'round');
    const candidateRef = R('map_candidate', 'candidate');
    const proposedRef = R('proposed_map_core', 'proposed');
    const spec = buildContentMigrationSpec({
      migrationId: 'migration-integration', mapReviewSettlementCoreRef: mapSettlementRef, sourceManifestRef,
      sourceMapRef, targetMapRef, impactClosureRef: R('finding_set', 'impact'), migrationPolicyVersion: '1',
    });
    const specRef = refOfBlob('migration_spec', spec);
    const intent = buildMigrationIntent({
      taskId, migrationSpecRef: specRef, sourceManifestRef, sourceMapRef, targetMapRef,
      decisions: [{ action: 'inherit_or_validate', slotId: 'slot-1', sourceVersionRef: versionRef, compatibilityProofRef: R('content_compatibility_proof', 'proof') }],
      impactClosureRef: spec.impactClosureRef, migrationPolicyVersion: '1',
    });
    const intentRef = refOfBlob('migration_intent_core', intent);
    const plan = buildMigrationValidationPlanSpec({
      migrationValidationPlanId: 'mvp-integration', migrationIntentCoreRef: intentRef, candidateRef, proposedMapCoreRef: proposedRef,
      sourceManifestRef, frozenRegistrationSetDigest: H('frozen-registry'), orderedBatchSlotIds: [['slot-1']], profileRef: env.profileSnapshotRef,
    });
    const planRef = refOfBlob('migration_validation_plan_spec', plan);
    objects.set(specRef.digest, spec);
    objects.set(intentRef.digest, intent);
    objects.set(planRef.digest, plan);
    objects.set(mapSettlementRef.digest, { coverageCoreRef: coverageRef });

    const startedEvent = validateAuthoritativeReviewEventV2({
      protocolVersion: 2, id: 'evt-migration-plan-started', at: env.now.value,
      type: 'structured_migration_validation_plan_started', migrationValidationPlanId: plan.migrationValidationPlanId,
      intentCoreRef: intentRef, planSpecRef: planRef,
    });
    const seedHold = await env.publicationStore.lock().acquire();
    try {
      await env.eventStore.appendBatch(taskId, 'seed-migration-plan', [startedEvent], {
        expectedLastSequence: 0,
        fenceProof: await seedHold.proof(),
      });
    } finally {
      await seedHold.release();
    }
    const authorityBase = buildAuthorityBaseSet({
      taskId, templateSnapshotRef: env.templateSnapshotRef, profileSnapshotRef: env.profileSnapshotRef,
      kind: 'system_migration_validation_batch', refs: { mapCandidateRef: candidateRef, planSpecRef: planRef, reviewRoundRef },
    });
    const workItemId = 'wi-migration-integration';
    await env.coordinator.createWorkItem({
      taskId, operationId: '11111111-1111-4111-8111-111111111111', workItemId,
      kind: 'system_migration_validation_batch', roleBinding: null, agentExecutionKind: null, sessionKind: null,
      logicalAssignmentId: null, reviewAssignmentId: null, inputArtifactDeliveryId: null,
      payload: { kind: 'migration_validation_plan_spec', value: plan }, authorityBase, maxAutomaticRetries: 3,
    });
    const commands = new SystemCommandRegistry();
    createProductionMigrationRuntime({
      facade: env.facade, tail: (id) => env.eventStore.tail(id), templateSnapshotRef: env.templateSnapshotRef,
      profileSnapshotRef: env.profileSnapshotRef, frozenRegistrationSetDigest: plan.frozenRegistrationSetDigest,
      migrationPolicyVersion: '1', equivalencePolicyVersion: '1', maxAutomaticRetries: 3, clock: () => env.now.value,
      resolve: resolver,
      completedBatches: async (id) => (await env.eventStore.read(id)).flatMap((entry) => entry.event.type === 'structured_migration_validation_batch_completed'
        ? [{ batchOrdinal: entry.event.batchOrdinal, batchResultRootRef: entry.event.batchResultRootRef }]
        : []),
      validatorRegistry: new ValidatorRegistry(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES),
      profileBody: buildAuthoritativeReviewTestProfileBody(), templateSnapshotHash: 'a'.repeat(64),
      registrationsFor: (phase) => [registration(phase === 'batch_commit' ? 'authoritative.review.slotSchema' : 'authoritative.review.coverage')],
      slotTypes: [{ id: 'doc', name: 'doc', description: 'doc', contentPresence: 'required', contentSchema: { type: 'string' } }],
      slotTypeOf: () => 'doc', requiredSlotIdsOf: () => ['slot-1'], readProjection: env.readProjection,
      sourceResolver: builtinSourceOf, reviewCoordinator: { async prepareClearActivation() { throw new Error('not used'); } },
      repairCoordinator: { async prepareContentRepairActivation() { throw new Error('not used'); }, async prepareMapRepair() { throw new Error('not used'); } },
      systemCommands: commands,
    });
    const wakeups = new AuthoritativeWakeupIndexV1({ paths: env.paths });
    const traces = new TraceStore(env.paths);
    const runner = new V2AssignmentRunner({ runtime: new FakeAgentRuntime(), toolProvider: { async toolsFor() { return []; }, async collectResultRefs() { return []; } } });
    const attempts = new V2AttemptCoordinator({
      coordinator: env.coordinator, runner, systemCommands: commands, agentForRole: async () => null,
      frozenFor: async () => frozenV2, wakeups, traces, clock: () => env.now.value,
    });
    const outcome = await attempts.runNext(taskId, 'worker-a');
    expect(outcome).toMatchObject({ kind: 'completed', workItemId });
    const projection = await env.readProjection(taskId);
    expect(projection.migrationBatchOrdinals).toEqual([0]);
    expect(projection.workItems[workItemId]?.state).toBe('completed');
    expect(Object.values(projection.workItems).some((item) => item.kind === 'system_review_settlement' && item.state === 'ready')).toBe(true);
  });
});
