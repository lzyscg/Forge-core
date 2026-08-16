// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { fullProfileForTests, refOfBlob } from '../../authoritative-review/object-registry';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { FrozenTemplate } from '../../template/template-schema';
import type { SlotContentVersionV2 } from '../../authoritative-review/authority-types';
import { PUBLICATION_INTENT_REGISTRY_V2, PublicationIntentRegistry } from '../../storage/authoritative-publication-intent-registry';
import { validateAuthoritativeReviewEventV2, type AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import { createWorkItemCoordinatorEnvironment, disposeRuntimeTestRoots } from '../test-support';
import type { WorkItemCoordinatorEnvironment } from '../test-support';
import { AuthoritativeReviewGc } from '../../storage/authoritative-review-gc';
import { AuthoritativeWakeupIndexV1 } from './wakeup-index';
import { TraceStore } from '../../storage/trace-store';
import { FakeAgentRuntime } from '../fake-agent-runtime';
import { V2AssignmentRunner } from './assignment-runner';
import { V2AttemptCoordinator, attemptContinuationOperationId } from './attempt-coordinator';
import { SystemCommandRegistry } from './system-command-registry';
import { ValidatorRegistry } from './validator-registry';
import { registrationSetDigestOf } from './validator-engine';
import { AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES, builtinSourceOf } from './builtin-validators';
import { buildAuthoritativeReviewTestProfileBody } from '../../structured-slots/test-support/authoritative-review-test-registry';
import type { ValidatorRegistrationV2 } from '../../template/structured-slot-contract-v2';
import {
  buildContentMigrationSpec,
  buildMigrationIntent,
  buildMigrationValidationPlanSpec,
  createProductionMigrationRuntime,
  registerMigrationPublicationHandlers,
  validateAndClassifyMigrationBatchResults,
} from './migration-service';
import { buildAuthorityBaseSet } from './authority-base';
import { buildContentRevisionCommitCore, buildEmptyAdoptionRoot } from './content-plan-service';
import { buildBaselineUnsetManifest, buildGenerationPlanSpec, mapReviewCarrier, registerMapReviewPublicationHandlers } from './map-review-service';
import { buildContentReviewCoverageCore } from './content-review-service';
import { buildFindingStageRoot } from './finding-service';
import { buildReviewObservationGrantSpec } from './review-coordinator';
import { GrantService } from './grant-service';
import { RepairService, registerRepairPublicationHandlers } from './repair-service';
import { AuthoritativeReviewPrivateStore } from '../../storage/authoritative-review-private-store';
import type { V2AttemptContext } from './attempt-coordinator';

afterEach(() => disposeRuntimeTestRoots());

const H = (label: string) => canonicalJsonSha256({ label });
const R = (kind: Parameters<typeof refOfBlob>[0], label: string): BlobRefV2 => refOfBlob(kind, { label });

async function mapWithBoundedConcurrency<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += 256) {
    results.push(...await Promise.all(items.slice(offset, offset + 256).map(fn)));
  }
  return results;
}

function durableMigrationRegistry(): PublicationIntentRegistry {
  const registry = new PublicationIntentRegistry();
  registerMapReviewPublicationHandlers(registry);
  registerMigrationPublicationHandlers(registry);
  registerRepairPublicationHandlers(registry);
  return registry;
}

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

type FinalizerRouteScenario =
  | 'clear'
  | 'content_repair'
  | 'map_repair'
  | 'map_repair_slot_primary'
  | 'map_repair_map_primary'
  | 'map_repair_multi_target'
  | 'infrastructure_failure';

function finalizerHarness(scenario: FinalizerRouteScenario) {
  if (scenario === 'clear') return null;
  const repairTargets = scenario === 'content_repair'
    ? "{ mapNodeIds: [], relationIds: [], slotIds: ['slot-00000'] }"
    : scenario === 'map_repair_slot_primary'
      ? "{ mapNodeIds: ['slot-00001'], relationIds: [], slotIds: ['slot-00000'] }"
      : scenario === 'map_repair_map_primary'
        ? "{ mapNodeIds: [], relationIds: [], slotIds: [] }"
        : scenario === 'map_repair_multi_target'
          ? "{ mapNodeIds: ['slot-00000', 'slot-00001'], relationIds: ['rel-00000'], slotIds: [] }"
          : "{ mapNodeIds: ['slot-00000'], relationIds: [], slotIds: ['slot-00000'] }";
  const targetKind = scenario === 'map_repair' || scenario === 'map_repair_multi_target'
    ? 'node'
    : scenario === 'map_repair_map_primary'
      ? 'map'
      : 'slot';
  const stableTargetId = scenario === 'map_repair_map_primary' ? '$map' : 'slot-00000';
  const body = scenario === 'infrastructure_failure'
    ? "throw new Error('injected plan-finalize infrastructure failure');"
    : `return { status: 'domain_invalid', issues: [{ validatorId: input.validatorId, implementationDigest: input.implementationDigest, issueCode: 'MIGRATION_${scenario.toUpperCase()}', location: { targetKind: '${targetKind}', stableTargetId: '${stableTargetId}', jsonPointer: null }, repairTargets: ${repairTargets}, evidenceDigest: '' }], executionDigest: '' };`;
  const source = `'use strict'; module.exports = { validate: function validate(input) { ${body} } };`;
  const builtin = AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES.find((entry) => entry.handlerKey === 'authoritative.review.coverage');
  if (builtin === undefined) throw new Error('missing coverage builtin');
  const implementationDigest = createHash('sha256').update(source, 'utf8').digest('hex');
  const entry = {
    ...builtin,
    handlerKey: `test.migration.finalizer.${scenario}`,
    implementationDigest,
    exportName: `migrationFinalizer${scenario}`,
  };
  const registration: ValidatorRegistrationV2 = {
    validatorId: `v-migration-${scenario}`,
    handlerKey: entry.handlerKey,
    implementationDigest,
    implementationRef: { kind: 'builtin', moduleId: entry.moduleId, exportName: entry.exportName },
    trigger: 'content_commit', executionPhase: 'plan_finalize', selector: { kind: 'all' }, enforcement: 'blocking',
    deterministic: true, inputContractVersion: entry.inputContractVersion, outputContractVersion: entry.outputContractVersion,
    budgetProfileId: entry.budgetProfileId,
  };
  return { entry, registration, source };
}

const frozenV2 = {
  id: 'migration-integration', name: 'Migration integration', description: 'v2', versionHash: '0'.repeat(64),
  inputFields: [], agents: [], routes: [], artifactSchema: { files: [] },
  finalOutput: { name: 'out', format: 'text', submitters: ['submitter'] }, budget: null,
  productionMode: 'structured_slots', structuredSlots: { version: 2 },
} as unknown as FrozenTemplate;

async function prepareDurable10kFixture(
  env: WorkItemCoordinatorEnvironment,
  taskId: string,
  options: {
    slotCount?: number;
    validatableSlotCount?: number;
    withRelation?: boolean;
    sourceCorruption?: 'manifest_map' | 'version_map' | 'aggregate_map';
  } = {},
) {
  const slotCount = options.slotCount ?? 10_000;
  const validatableSlotCount = options.validatableSlotCount ?? 600;
  const slotIds = Array.from({ length: slotCount }, (_, index) => `slot-${String(index).padStart(5, '0')}`);
  const validatableSlotIds = slotIds.slice(0, validatableSlotCount);
  await env.facade.prepareBlob(taskId, 'profile_snapshot', buildAuthoritativeReviewTestProfileBody());
  const templateBlob = await env.blobStore.readJson('task-coordinator-support', env.templateSnapshotRef, env.templateSnapshotRef.kind);
  await env.facade.prepareBlob(taskId, env.templateSnapshotRef.kind, templateBlob);
  const nodes = slotIds.map((slotId, documentOrder) => {
    const body = {
      slotId,
      slotType: documentOrder < validatableSlotCount ? 'doc' : 'optional-doc',
      contentBearing: true,
      parentSlotId: documentOrder === 0 ? null : slotIds[0]!,
      documentOrder,
      siblingOrder: documentOrder === 0 ? 0 : documentOrder - 1,
    };
    return { ...body, nodeSpecDigest: canonicalJsonSha256(body) };
  });
  const relations = options.withRelation === true && slotIds.length >= 2
    ? [{
        relationId: 'rel-00000', typeId: 'sequence', fromSlotId: slotIds[0]!, toSlotId: slotIds[1]!,
        attributes: {}, relationDigest: H('durable-relation-00000'),
      }]
    : [];
  const contentBody = {
    slotId: validatableSlotIds[validatableSlotIds.length - 1] ?? slotIds[0]!,
    contentSchemaDigest: H('durable-schema'), taskContentRevision: 1,
    mediaType: 'text/plain' as const, text: 'durable shared content',
  };
  const content = { ...contentBody, selfDigest: canonicalJsonSha256(contentBody) };
  const contentRef = await env.facade.prepareBlob(taskId, 'content_value', content);
  const mapBuildSpecBody = {
    mapBuildId: 'build-durable', revision: 1, supersedesMapBuildId: null, sourceValidationReceiptRef: null,
    snapshotHash: 'a'.repeat(64), plannedChunkPolicy: { maxChunks: 16, maxNodesPerChunk: 1_024, maxRelationsPerChunk: 256 },
  };
  const mapBuildSpec = { ...mapBuildSpecBody, specDigest: canonicalJsonSha256(mapBuildSpecBody) };
  const mapBuildSpecRef = await env.facade.prepareBlob(taskId, 'map_build_spec', mapBuildSpec);
  const contributionBody = {
    contributionManifestId: 'cm-durable', producerKind: 'map_build' as const, planId: 'build-durable', planRevision: 1,
    orderedChunkOrBatchRefs: [] as BlobRefV2[], stagingRootRef: null, keyLedgerRefs: [] as BlobRefV2[], agentAttemptIdentities: [],
  };
  const contribution = { ...contributionBody, manifestDigest: canonicalJsonSha256(contributionBody) };
  const contributionRef = await env.facade.prepareBlob(taskId, 'contribution_manifest', contribution);
  const candidateCoreBody = {
    candidateId: 'candidate-durable', baseMapId: null, positionGraphDigest: H('durable-position'), relationGraphDigest: H('durable-relations'),
    templateSnapshotHash: 'a'.repeat(64), nodes, relations,
    candidateProvenanceWithoutValidation: {
      producerKind: 'system_map_finalize' as const, producerWorkItemId: 'wi-map-finalize', commandId: 'cmd-map-finalize',
      mapBuildId: 'build-durable', mapBuildRevision: 1, contributionManifestRef: contributionRef,
    },
  };
  const candidateCore = { ...candidateCoreBody, coreDigest: canonicalJsonSha256(candidateCoreBody) };
  const candidateCoreRef = await env.facade.prepareBlob(taskId, 'map_candidate_validation_core', candidateCore);
  const inputEnvelope = {
    trigger: 'map_candidate_commit' as const, taskId, templateSnapshotHash: 'a'.repeat(64),
    mapCandidateValidationCoreRef: candidateCoreRef, selectedTargetRefs: [contentRef],
  };
  const inputRef = await env.facade.prepareBlob(taskId, 'validator_input_envelope', inputEnvelope);
  const warningBody = {
    trigger: 'map_candidate_commit' as const, executionPhase: null, inputRef, inputDigest: inputRef.digest,
    orderedAdvisoryReceiptRefs: [] as BlobRefV2[], warningCount: 0,
  };
  const warning = { ...warningBody, rootDigest: canonicalJsonSha256(warningBody) };
  const warningRef = await env.facade.prepareBlob(taskId, 'validation_warning_root', warning);
  const batchReg = registration('authoritative.review.slotSchema');
  const aggregateBody = {
    trigger: 'map_candidate_commit' as const, executionPhase: null, inputRef, inputDigest: inputRef.digest,
    registrationSetDigest: registrationSetDigestOf([batchReg]), validExecutionDigests: [H('durable-source-valid')],
    blockingInvalidReceiptRefs: [] as BlobRefV2[], advisoryReceiptRefs: [] as BlobRefV2[], infrastructureFailureRefs: [] as BlobRefV2[],
    warningRootRef: warningRef, outcome: 'clear' as const,
  };
  const aggregate = { ...aggregateBody, aggregateDigest: canonicalJsonSha256(aggregateBody) };
  const aggregateRef = await env.facade.prepareBlob(taskId, 'validator_aggregate', aggregate);
  const custodyBody = {
    scope: 'map_candidate' as const, taskId, baseRefs: [inputRef],
    entries: [{ trigger: 'map_candidate_commit' as const, inputRef, inputDigest: inputRef.digest, executionScope: {}, validatorAggregateRef: aggregateRef, warningRootRef: warningRef }],
    supersessionPolicyVersion: '1',
  };
  const custody = { ...custodyBody, rootDigest: canonicalJsonSha256(custodyBody) };
  const custodyRef = await env.facade.prepareBlob(taskId, 'validation_warning_custody_root', custody);
  const candidateBody = {
    candidateId: 'candidate-durable', baseMapId: null, validationCoreRef: candidateCoreRef,
    candidateValidationAggregateRef: aggregateRef, candidateWarningCustodyRootRef: custodyRef, createdAt: env.now.value,
  };
  const candidate = { ...candidateBody, candidateDigest: canonicalJsonSha256(candidateBody) };
  const candidateRef = await env.facade.prepareBlob(taskId, 'map_candidate', candidate);
  const sourceMapBuildSpecBody = {
    mapBuildId: 'build-durable-source', revision: 1, supersedesMapBuildId: null, sourceValidationReceiptRef: null,
    snapshotHash: 'a'.repeat(64), plannedChunkPolicy: { maxChunks: 16, maxNodesPerChunk: 1_024, maxRelationsPerChunk: 256 },
  };
  const sourceMapBuildSpec = { ...sourceMapBuildSpecBody, specDigest: canonicalJsonSha256(sourceMapBuildSpecBody) };
  const sourceMapBuildSpecRef = await env.facade.prepareBlob(taskId, 'map_build_spec', sourceMapBuildSpec);
  const sourceCandidateBody = {
    candidateId: 'candidate-durable-source', baseMapId: null, validationCoreRef: candidateCoreRef,
    candidateValidationAggregateRef: aggregateRef, candidateWarningCustodyRootRef: custodyRef, createdAt: env.now.value,
  };
  const sourceCandidate = { ...sourceCandidateBody, candidateDigest: canonicalJsonSha256(sourceCandidateBody) };
  const sourceCandidateRef = await env.facade.prepareBlob(taskId, 'map_candidate', sourceCandidate);
  const findingStageBody = { rootId: 'finding-stage-durable', roundId: 'round-durable', entries: [] as never[] };
  const findingStage = { ...findingStageBody, rootDigest: canonicalJsonSha256(findingStageBody) };
  const findingStageRef = await env.facade.prepareBlob(taskId, 'finding_stage_root', findingStage);
  const coverageBody = {
    mapReviewRoundId: 'round-durable', candidateRef, contentRevisionManifestRef: null, contentRootDigest: null,
    reviewPolicyDigest: H('durable-review-policy'), coverageLedgerRootRefs: [] as BlobRefV2[], wholeMapObservationRootRefs: [] as BlobRefV2[], findingStageRootRef: findingStageRef,
  };
  const coverage = { ...coverageBody, coreDigest: canonicalJsonSha256(coverageBody) };
  const coverageRef = await env.facade.prepareBlob(taskId, 'map_review_coverage_core', coverage);
  const settlementBody = { coverageCoreRef: coverageRef, mapReviewSettlementValidatorAggregateRef: aggregateRef };
  const settlement = { ...settlementBody, coreDigest: canonicalJsonSha256(settlementBody) };
  const settlementRef = await env.facade.prepareBlob(taskId, 'map_review_settlement_core', settlement);
  const proposedBody = {
    scaffoldId: 'scaffold-durable', proposedMapId: 'map-durable-target', supersedesMapId: 'map-durable-source', sourceCandidateRef: candidateRef,
    mapRevision: 2, mapSemanticDigest: H('durable-semantic'), positionGraphDigest: H('durable-position'), relationGraphDigest: H('durable-relations'),
    templateSnapshotHash: 'a'.repeat(64), nodes, relations,
  };
  const proposed = { ...proposedBody, coreDigest: canonicalJsonSha256(proposedBody) };
  const proposedRef = await env.facade.prepareBlob(taskId, 'proposed_map_core', proposed);
  const bundleBody = { settlementCoreRef: settlementRef, proposedMapCoreRef: proposedRef, mapActivationValidatorAggregateRef: aggregateRef, mapWarningCustodyRootRef: custodyRef };
  const bundle = { ...bundleBody, bundleDigest: canonicalJsonSha256(bundleBody) };
  const bundleRef = await env.facade.prepareBlob(taskId, 'map_review_bundle', bundle);
  const targetSnapshot = {
    scaffoldId: 'scaffold-durable', mapId: 'map-durable-target', supersedesMapId: 'map-durable-source', sourceCandidateId: candidate.candidateId,
    proposedMapCoreRef: proposedRef, mapReviewBundleRef: bundleRef, mapRevision: 2,
    mapSemanticDigest: proposed.mapSemanticDigest, positionGraphDigest: proposed.positionGraphDigest, relationGraphDigest: proposed.relationGraphDigest,
    templateSnapshotHash: proposed.templateSnapshotHash, nodes, relations, activatedAt: env.now.value,
  };
  const targetMapRef = await env.facade.prepareBlob(taskId, 'map_snapshot', targetSnapshot);
  // Force one real target-Map revalidation while the other 599 validatable
  // slots exercise equivalence reuse. The changed leaf owns the shared fixture
  // bytes, so the production validator receives a correctly bound content value.
  const changedNodeIndex = Math.max(0, validatableSlotCount - 1);
  const sourceNodes = nodes.map((node, index) => index === changedNodeIndex
    ? { ...node, nodeSpecDigest: H('durable-source-validator-node') }
    : node);
  const sourceSnapshot = {
    ...targetSnapshot,
    mapId: 'map-durable-source',
    supersedesMapId: null,
    mapRevision: 1,
    sourceCandidateId: 'candidate-durable-source',
    nodes: sourceNodes,
  };
  const sourceMapRef = await env.facade.prepareBlob(taskId, 'map_snapshot', sourceSnapshot);
  const baseline = buildBaselineUnsetManifest({
    taskId,
    mapRef: sourceMapRef,
    mapSemanticDigest: sourceSnapshot.mapSemanticDigest,
    taskContentRevision: 1,
    contentBearingSlots: validatableSlotIds.map((slotId, documentOrder) => ({ slotId, documentOrder })),
    contentSchemaOf: () => contentBody.contentSchemaDigest,
  });
  await mapWithBoundedConcurrency(baseline.versions, (version) => env.facade.prepareBlob(taskId, 'content_version', version));
  const baselineRef = await env.facade.prepareBlob(taskId, 'content_revision_manifest', baseline.manifest);
  const generationPlan = buildGenerationPlanSpec({
    generationPlanId: 'gp-durable',
    revision: 1,
    supersedesGenerationPlanId: null,
    sourceValidationReceiptRef: null,
    activeMapRef: sourceMapRef,
    baseContentRevisionManifestRef: baselineRef,
    importedContentManifestRef: baselineRef,
    correctionScopeDigest: null,
    orderedBatchSlotIds: [validatableSlotIds],
  });
  const generationPlanRef = await env.facade.prepareBlob(taskId, 'generation_plan_spec', generationPlan);
  const sourceContentBySlot = new Map<string, { value: typeof content; ref: BlobRefV2 }>();
  const preparedSourceContents = await mapWithBoundedConcurrency(validatableSlotIds, async (slotId) => {
    const isSharedFixtureSlot = slotId === contentBody.slotId;
    const slotContentBody = isSharedFixtureSlot ? contentBody : {
      slotId,
      contentSchemaDigest: H('durable-schema'),
      taskContentRevision: 1,
      mediaType: 'text/plain' as const,
      text: `durable content for ${slotId}`,
    };
    const slotContent = isSharedFixtureSlot ? content : { ...slotContentBody, selfDigest: canonicalJsonSha256(slotContentBody) };
    const slotContentRef = isSharedFixtureSlot
      ? contentRef
      : await env.facade.prepareBlob(taskId, 'content_value', slotContent);
    return { slotId, value: slotContent, ref: slotContentRef };
  });
  for (const prepared of preparedSourceContents) sourceContentBySlot.set(prepared.slotId, prepared);
  // Mirror one real content-plan batch exactly: the plan's complete 600-slot
  // selected set, the commit replacement closure, and every produced version
  // share the same immutable core/input/aggregate/custody provenance.
  const sourceCommitCore = buildContentRevisionCommitCore({
    priorManifestRef: baselineRef,
    producerPlanSpecRef: generationPlanRef,
    batchOrdinal: 0,
    authorizedReplacementEntriesWithoutValidation: validatableSlotIds.map((slotId) => ({ slotId, expectedCurrentVersionRef: null })),
    expectedMapRef: options.sourceCorruption === 'aggregate_map' ? targetMapRef : sourceMapRef,
  });
  const sourceCommitCoreRef = await env.facade.prepareBlob(taskId, 'content_revision_commit_core', sourceCommitCore);
  const sourceInput = {
    trigger: 'content_commit' as const,
    executionPhase: 'batch_commit' as const,
    taskId,
    templateSnapshotHash: 'a'.repeat(64),
    contentValidationCoreRef: sourceCommitCoreRef,
    selectedTargetRefs: validatableSlotIds.map((slotId) => sourceContentBySlot.get(slotId)!.ref),
  };
  const sourceInputRef = await env.facade.prepareBlob(taskId, 'validator_input_envelope', sourceInput);
  const sourceWarningBody = {
    trigger: 'content_commit' as const,
    executionPhase: 'batch_commit' as const,
    inputRef: sourceInputRef,
    inputDigest: sourceInputRef.digest,
    orderedAdvisoryReceiptRefs: [] as BlobRefV2[],
    warningCount: 0,
  };
  const sourceWarning = { ...sourceWarningBody, rootDigest: canonicalJsonSha256(sourceWarningBody) };
  const sourceWarningRef = await env.facade.prepareBlob(taskId, 'validation_warning_root', sourceWarning);
  const sourceAggregateBody = {
    trigger: 'content_commit' as const,
    executionPhase: 'batch_commit' as const,
    inputRef: sourceInputRef,
    inputDigest: sourceInputRef.digest,
    registrationSetDigest: registrationSetDigestOf([batchReg]),
    validExecutionDigests: [H('durable-source-valid')],
    blockingInvalidReceiptRefs: [] as BlobRefV2[],
    advisoryReceiptRefs: [] as BlobRefV2[],
    infrastructureFailureRefs: [] as BlobRefV2[],
    warningRootRef: sourceWarningRef,
    outcome: 'clear' as const,
  };
  const sourceAggregate = { ...sourceAggregateBody, aggregateDigest: canonicalJsonSha256(sourceAggregateBody) };
  const sourceAggregateRef = await env.facade.prepareBlob(taskId, 'validator_aggregate', sourceAggregate);
  const sourceCustodyBody = {
    scope: 'content_review' as const,
    taskId,
    baseRefs: [sourceInputRef],
    entries: [{
      trigger: 'content_commit' as const,
      inputRef: sourceInputRef,
      inputDigest: sourceInputRef.digest,
      executionScope: { planRevisionId: generationPlan.generationPlanId, batchOrdinal: 0 },
      validatorAggregateRef: sourceAggregateRef,
      warningRootRef: sourceWarningRef,
    }],
    supersessionPolicyVersion: '1',
  };
  const sourceCustody = { ...sourceCustodyBody, rootDigest: canonicalJsonSha256(sourceCustodyBody) };
  const sourceCustodyRef = await env.facade.prepareBlob(taskId, 'validation_warning_custody_root', sourceCustody);
  const entries: Array<{ slotId: string; versionRef: BlobRefV2 }> = [];
  const versionsBySlot = new Map<string, { version: SlotContentVersionV2; ref: BlobRefV2 }>();
  const preparedVersions = await mapWithBoundedConcurrency(validatableSlotIds, async (slotId) => {
    const slotContentRef = sourceContentBySlot.get(slotId)!.ref;
    const version: SlotContentVersionV2 = {
      state: 'set', slotId, slotRevision: 1, taskContentRevision: 2,
      mapRef: options.sourceCorruption === 'version_map' && slotId === validatableSlotIds[0] ? targetMapRef : sourceMapRef,
      mapSemanticDigest: sourceSnapshot.mapSemanticDigest, contentSchemaDigest: contentBody.contentSchemaDigest,
      contentDigest: slotContentRef.digest, blobRef: slotContentRef,
      provenance: {
        kind: 'generated', producer: { kind: 'generation_batch', planRevisionId: generationPlan.generationPlanId, batchOrdinal: 0, attemptId: 'att-durable' },
        contentRevisionCommitCoreRef: sourceCommitCoreRef, contentCommitValidatorAggregateRef: sourceAggregateRef,
        contentCommitWarningRootRef: sourceCustodyRef, committedByAttemptId: 'att-durable',
      },
    };
    const versionRef = await env.facade.prepareBlob(taskId, 'content_version', version);
    return { slotId, version, versionRef };
  });
  for (const { slotId, version, versionRef } of preparedVersions) {
    versionsBySlot.set(slotId, { version, ref: versionRef });
    entries.push({ slotId, versionRef });
  }
  const manifestBody = {
    taskId,
    mapRef: options.sourceCorruption === 'manifest_map' ? targetMapRef : sourceMapRef,
    mapSemanticDigest: sourceSnapshot.mapSemanticDigest,
    taskContentRevision: 2, manifestPhase: 'finalized' as const,
    entries, producerPlanSpecRef: generationPlanRef, priorManifestRef: baselineRef,
    finalizerValidatorAggregateRefs: [sourceAggregateRef], finalizerWarningRootRefs: [sourceCustodyRef], contentRootDigest: H('durable-content-root'),
  };
  const manifest = { ...manifestBody, manifestDigest: canonicalJsonSha256(manifestBody) };
  const manifestRef = await env.facade.prepareBlob(taskId, 'content_revision_manifest', manifest);
  const round = {
    mapReviewRoundId: 'round-durable', candidateId: candidate.candidateId, candidateDigest: candidate.candidateDigest,
    contentRevisionManifestRef: manifestRef, contentRootDigest: manifest.contentRootDigest, reviewPolicyDigest: coverage.reviewPolicyDigest,
    coverageNodeIds: slotIds, coverageRelationIds: relations.map((relation) => relation.relationId), assignmentIds: [], inheritedRecordRefs: [], wholeMapObservationRefs: [],
    verificationFindingStages: [], state: 'completed' as const, settlementRef: null,
  };
  const roundRef = await env.facade.prepareBlob(taskId, 'map_review_round', round);
  const seedReviewWorkItemId = 'wi-map-review-durable-seed';
  const seedReviewAttemptId = 'att-map-review-durable-seed';
  const seedReviewAssignmentId = 'ra-map-review-durable-seed';
  const seedReviewLogicalAssignmentId = 'la-map-review-durable-seed';
  const seedReviewAuthority = buildAuthorityBaseSet({
    taskId,
    templateSnapshotRef: env.templateSnapshotRef,
    profileSnapshotRef: env.profileSnapshotRef,
    kind: 'agent_assignment',
    agentExecutionKind: 'structured_session',
    sessionKind: 'review_map_batch',
    refs: {
      mapCandidateRef: candidateRef,
      reviewCoverageCoreRef: coverageRef,
      reviewRoundRef: roundRef,
    },
  });
  const seedReviewAuthorityRef = await env.facade.prepareBlob(taskId, 'authority_base_set', seedReviewAuthority);
  const seedReviewGrant = buildReviewObservationGrantSpec({
    grantSpecId: 'grant-map-review-durable-seed',
    workItemId: seedReviewWorkItemId,
    authorityBaseRef: seedReviewAuthorityRef,
    sessionKind: 'review_map_batch',
    reviewAssignmentId: seedReviewAssignmentId,
    roundId: 'round-durable',
    roundKind: 'map',
    snapshotHash: 'a'.repeat(64),
    maxContextBytes: 1_024,
  });
  const seedReviewGrantRef = await env.facade.prepareBlob(taskId, 'write_grant_spec', seedReviewGrant);
  const seedDispatchBody = {
    dispatchId: 'dispatch-map-review-durable-seed',
    workItemId: seedReviewWorkItemId,
    logicalAssignmentId: seedReviewLogicalAssignmentId,
    reviewAssignmentId: seedReviewAssignmentId,
    attemptId: seedReviewAttemptId,
    authorityBaseRef: seedReviewAuthorityRef,
    agentExecutionKind: 'structured_session' as const,
    sessionKind: 'review_map_batch' as const,
    grantInstanceRef: null,
    inputArtifactDeliveryId: null,
    scopeDecisionReason: null,
  };
  const seedDispatch = { ...seedDispatchBody, dispatchDigest: canonicalJsonSha256(seedDispatchBody) };
  const seedDispatchRef = await env.facade.prepareBlob(taskId, 'assignment_dispatch', seedDispatch);
  const seedLedgerBody = {
    assignmentId: 'assignment-map-review-durable-seed',
    workItemId: seedReviewWorkItemId,
    reviewAssignmentId: seedReviewAssignmentId,
    roundKind: 'map' as const,
    roundId: 'round-durable',
    factRefs: [] as BlobRefV2[],
    findingDraftRefs: [] as BlobRefV2[],
    verificationRecordRefs: [] as BlobRefV2[],
    coverageTargetIds: [] as string[],
  };
  const seedLedger = { ...seedLedgerBody, ledgerDigest: canonicalJsonSha256(seedLedgerBody) };
  const seedLedgerRef = await env.facade.prepareBlob(taskId, 'review_assignment_ledger', seedLedger);
  const impactBody = { findingSetId: 'migration-impact-durable', findingRefs: [] as BlobRefV2[] };
  const impact = { ...impactBody, setDigest: canonicalJsonSha256(impactBody) };
  const impactRef = await env.facade.prepareBlob(taskId, 'finding_set', impact);
  const migrationSpec = buildContentMigrationSpec({
    migrationId: 'migration-durable', mapReviewSettlementCoreRef: settlementRef, sourceManifestRef: manifestRef,
    sourceMapRef, targetMapRef, impactClosureRef: impactRef, migrationPolicyVersion: '1',
  });
  const migrationSpecRef = await env.facade.prepareBlob(taskId, 'migration_spec', migrationSpec);
  const inheritedDecisions = await mapWithBoundedConcurrency(validatableSlotIds, async (slotId) => {
    const source = versionsBySlot.get(slotId)!;
    const proofBody = {
      taskId, slotId, sourceVersionRef: source.ref, sourceMapRef, targetMapRef,
      sourceContentSchemaDigest: source.version.contentSchemaDigest, targetContentSchemaDigest: source.version.contentSchemaDigest,
      stableIdentityEvidenceRef: impactRef, proofPolicyVersion: '1',
    };
    const proof = { ...proofBody, proofDigest: canonicalJsonSha256(proofBody) };
    const proofRef = await env.facade.prepareBlob(taskId, 'content_compatibility_proof', proof);
    return { action: 'inherit_or_validate' as const, slotId, sourceVersionRef: source.ref, compatibilityProofRef: proofRef };
  });
  const decisions = [
    ...inheritedDecisions,
    ...slotIds.slice(validatableSlotIds.length).map((slotId) => ({
      action: 'new_or_schema_reset' as const,
      slotId,
      unsetReason: 'new_slot' as const,
      sourceVersionRef: null,
    })),
  ];
  const intent = buildMigrationIntent({ taskId, migrationSpecRef, sourceManifestRef: manifestRef, sourceMapRef, targetMapRef, decisions, impactClosureRef: impactRef, migrationPolicyVersion: '1' });
  const intentRef = await env.facade.prepareBlob(taskId, 'migration_intent_core', intent);
  const batches = Array.from({ length: Math.ceil(validatableSlotIds.length / 8) }, (_, ordinal) => validatableSlotIds.slice(ordinal * 8, (ordinal + 1) * 8));
  const plan = buildMigrationValidationPlanSpec({
    migrationValidationPlanId: 'mvp-durable-10k', migrationIntentCoreRef: intentRef, candidateRef,
    proposedMapCoreRef: proposedRef, sourceManifestRef: manifestRef, frozenRegistrationSetDigest: registrationSetDigestOf([batchReg]),
    orderedBatchSlotIds: batches, profileRef: env.profileSnapshotRef,
  });
  const planRef = await env.facade.prepareBlob(taskId, 'migration_validation_plan_spec', plan);
  return {
    slotCount, validatableSlotCount, relationCount: relations.length,
    plan, planRef, intentRef, candidateRef, roundRef, batchReg, sourceMapRef, targetMapRef,
    bundleRef, coverageRef, settlementRef, manifestRef, baselineRef, mapBuildSpecRef, contributionRef,
    aggregateRef, inputRef, warningRef, custodyRef, sourceAggregateRef, sourceInputRef, sourceWarningRef, sourceCustodyRef,
    generationPlanRef, seedReviewWorkItemId, seedReviewAttemptId, seedReviewAssignmentId, seedReviewLogicalAssignmentId,
    seedReviewAuthorityRef, seedReviewGrantRef, seedDispatchRef, seedLedgerRef,
    sourceMapBuildSpecRef, sourceCandidateRef,
  };
}

function createMigrationRepairHarness(env: WorkItemCoordinatorEnvironment, taskId: string) {
  const profile = fullProfileForTests();
  const profileBody = buildAuthoritativeReviewTestProfileBody();
  const resolver = (id: string, blobRef: BlobRefV2) => env.blobStore.readJson(id, blobRef, blobRef.kind);
  const privateStore = new AuthoritativeReviewPrivateStore(env.paths, taskId);
  const grants = new GrantService({ resolver, readProjection: env.readProjection, profile });
  const service = new RepairService({
    facade: env.facade,
    grants,
    readProjection: env.readProjection,
    resolver,
    tail: (id) => env.eventStore.tail(id),
    readEvents: async (id) => (await env.eventStore.read(id)).map((entry) => entry.event as AuthoritativeReviewEventV2),
    committedOperation: async (id, operationId) =>
      (await env.eventStore.readBatchByCommitId(id, operationId))?.map((entry) => entry.event as AuthoritativeReviewEventV2) ?? null,
    clock: () => env.now.value,
    profile,
    profileBody,
    validatorRegistry: new ValidatorRegistry(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES),
    sourceResolver: builtinSourceOf,
    registrationsFor: (trigger) => trigger === 'content_commit' ? [registration('authoritative.review.slotSchema')] : [],
    reviewPolicy: {
      mapReview: 'required', contentSelector: 'content_bearing', mapBatchTargetSlots: 24, contentBatchTargetSlots: 2,
      assignmentSoftLimit: 64, wholeMapObservation: 'required', wholeContentTreeObservation: 'required',
      reviewAdvisoryRelations: false, maxRounds: 8,
    },
    reviewPolicyDigest: H('durable-review-policy'),
    templateSnapshotRef: env.templateSnapshotRef,
    profileSnapshotRef: env.profileSnapshotRef,
    snapshotHash: 'a'.repeat(64),
    orchestratorRoleBinding: 'orchestrator', generatorRoleBinding: 'generator', reviewerRoleBinding: 'reviewer',
    privateStore,
    slotTypeOf: () => 'doc',
    contentSchemaDigestOf: () => H('durable-schema'),
    slotTypes: [
      { id: 'doc', name: 'doc', description: 'doc', contentPresence: 'required', contentSchema: { type: 'string' } },
      { id: 'optional-doc', name: 'optional-doc', description: 'optional doc', contentPresence: 'optional', contentSchema: { type: 'string' } },
    ],
    defaultAutomaticRetries: async () => 3,
  });
  return { service, privateStore };
}

function migrationRepairCoordinator(
  env: WorkItemCoordinatorEnvironment,
  taskId: string,
  fixture: Awaited<ReturnType<typeof prepareDurable10kFixture>>,
  repair: ReturnType<typeof createMigrationRepairHarness>,
): Parameters<typeof createProductionMigrationRuntime>[0]['repairCoordinator'] {
  const prepare = async (
    track: 'content' | 'map',
    input: Parameters<Parameters<typeof createProductionMigrationRuntime>[0]['repairCoordinator']['prepareContentRepairActivation']>[0],
  ) => {
    const prepared = await repair.service.prepareMigrationRepairRoute({
      taskId,
      track,
      settlementWorkItemId: input.settlementWorkItemId,
      settlementOperationKey: input.settlementOperationKey,
      settlementDigest: input.migrationSettlementCoreRef.digest,
      candidateRef: input.plan.candidateRef,
      targetMapRef: input.targetMapRef,
      migratedManifestRef: input.migratedManifestRef,
      classifiedFindings: input.classifiedFindings,
    });
    if (track === 'map') {
      return {
        carriers: mapReviewCarrier({
          mapReviewRoundId: 'round-durable', settlementCoreRef: fixture.settlementRef,
          outcome: 'map_repair', contentRevisionManifestRef: fixture.manifestRef,
          mixedContentRepair: prepared.carriers,
        }),
        preparedRefs: prepared.preparedRefs,
      };
    }
    const decision = await env.blobStore.readJson<{ finalizerAggregateRef: BlobRefV2 }>(taskId, input.migrationActivationDecisionRef, 'migration_activation_decision');
    const migrated = await env.blobStore.readJson<{ taskContentRevision: number }>(taskId, input.migratedManifestRef, 'content_revision_manifest');
    return {
      carriers: mapReviewCarrier({
        mapReviewRoundId: 'round-durable', settlementCoreRef: fixture.settlementRef,
        outcome: 'activate', mapId: 'map-durable-target', mapRevision: 2, supersedesMapId: 'map-durable-source',
        mapSnapshotRef: fixture.targetMapRef, mapReviewBundleRef: fixture.bundleRef,
        mapSemanticDigest: H('durable-semantic'), contentRevisionManifestRef: input.migratedManifestRef,
        activationValidatorAggregateRef: decision.finalizerAggregateRef, taskContentRevision: migrated.taskContentRevision,
        manifestPhase: 'provisional', producerPlanSpecRef: fixture.planRef, priorManifestRef: fixture.manifestRef,
        mixedContentRepair: prepared.carriers,
      }),
      preparedRefs: prepared.preparedRefs,
    };
  };
  return {
    prepareContentRepairActivation: (input) => prepare('content', input),
    prepareMapRepair: (input) => prepare('map', input),
  };
}

function openDurableRuntime(
  env: WorkItemCoordinatorEnvironment,
  taskId: string,
  fixture: Awaited<ReturnType<typeof prepareDurable10kFixture>>,
  options: {
    finalizerScenario?: FinalizerRouteScenario;
    repairCoordinator?: Parameters<typeof createProductionMigrationRuntime>[0]['repairCoordinator'];
    requiredSlotIdsOverride?: readonly string[];
  } = {},
) {
  const finalizer = finalizerHarness(options.finalizerScenario ?? 'clear');
  const profileBody = buildAuthoritativeReviewTestProfileBody();
  const runtimeProfileBody = finalizer === null ? profileBody : {
    ...profileBody,
    installedHandlers: {
      ...profileBody.installedHandlers,
      validators: [...profileBody.installedHandlers.validators, {
        handlerKey: finalizer.entry.handlerKey,
        implementationDigest: finalizer.entry.implementationDigest,
        moduleId: finalizer.entry.moduleId,
        exportName: finalizer.entry.exportName,
        trigger: finalizer.entry.trigger,
        executionPhase: finalizer.entry.executionPhase,
      }],
    },
  };
  const commands = new SystemCommandRegistry();
  const { service } = createProductionMigrationRuntime({
    facade: env.facade, tail: (id) => env.eventStore.tail(id), templateSnapshotRef: env.templateSnapshotRef,
    profileSnapshotRef: env.profileSnapshotRef, frozenRegistrationSetDigest: registrationSetDigestOf([fixture.batchReg]),
    migrationPolicyVersion: '1', equivalencePolicyVersion: '1', maxAutomaticRetries: 3, clock: () => env.now.value,
    resolve: (id, blobRef) => env.blobStore.readJson(id, blobRef, blobRef.kind),
    completedBatches: async (id, requestedPlanRef) => (await env.eventStore.read(id)).flatMap((entry) => entry.event.type === 'structured_migration_validation_batch_completed'
      && entry.event.planSpecRef.digest === requestedPlanRef.digest
      ? [{ batchOrdinal: entry.event.batchOrdinal, batchResultRootRef: entry.event.batchResultRootRef }]
      : []),
    validatorRegistry: new ValidatorRegistry(finalizer === null ? AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES : [...AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES, finalizer.entry]),
    profileBody: runtimeProfileBody, templateSnapshotHash: 'a'.repeat(64),
    registrationsFor: (phase) => phase === 'batch_commit' ? [fixture.batchReg] : [finalizer?.registration ?? registration('authoritative.review.coverage')],
    slotTypes: [
      { id: 'doc', name: 'doc', description: 'doc', contentPresence: 'required', contentSchema: { type: 'string' } },
      { id: 'optional-doc', name: 'optional-doc', description: 'optional doc', contentPresence: 'optional', contentSchema: { type: 'string' } },
    ],
    slotTypeOf: (slotId) => Number(slotId.slice(5)) < fixture.validatableSlotCount ? 'doc' : 'optional-doc',
    requiredSlotIdsOf: () => options.requiredSlotIdsOverride
      ?? Array.from({ length: fixture.validatableSlotCount }, (_, index) => `slot-${String(index).padStart(5, '0')}`),
    readProjection: env.readProjection,
    sourceResolver: (handlerKey) => finalizer !== null && handlerKey === finalizer.entry.handlerKey ? finalizer.source : builtinSourceOf(handlerKey),
    reviewCoordinator: {
      async prepareClearActivation(input) {
        const contentRoundId = 'content-round-durable-after-migration';
        const adoption = buildEmptyAdoptionRoot(contentRoundId);
        const adoptionRootRef = await env.facade.prepareBlob(taskId, 'review_adoption_root', adoption);
        const findingStage = buildFindingStageRoot(contentRoundId, []);
        const findingStageRootRef = await env.facade.prepareBlob(taskId, 'finding_stage_root', findingStage);
        const contentCoverage = buildContentReviewCoverageCore({
          reviewRoundId: contentRoundId,
          mapRef: fixture.targetMapRef,
          contentRevisionManifestRef: input.migratedManifestRef,
          reviewPolicyDigest: H('durable-review-policy'),
          coverageLedgerRootRefs: [],
          adoptionRootRef,
          wholeTreeObservationRootRefs: [],
          findingStageRootRef,
        });
        const contentCoverageRef = await env.facade.prepareBlob(taskId, 'content_review_coverage_core', contentCoverage);
        const reviewWorkItemId = 'wi-review-durable-after-migration';
        const reviewAssignmentId = 'ra-review-durable-after-migration';
        const authorityBase = buildAuthorityBaseSet({
          taskId,
          templateSnapshotRef: env.templateSnapshotRef,
          profileSnapshotRef: env.profileSnapshotRef,
          kind: 'agent_assignment',
          agentExecutionKind: 'structured_session',
          sessionKind: 'review_content_batch',
          refs: {
            mapRef: fixture.targetMapRef,
            contentRevisionManifestRef: input.migratedManifestRef,
            reviewCoverageCoreRef: contentCoverageRef,
            reviewRoundRef: contentCoverageRef,
          },
        });
        const authorityBaseRef = await env.facade.prepareBlob(taskId, 'authority_base_set', authorityBase);
        const grant = buildReviewObservationGrantSpec({
          grantSpecId: 'grant-review-durable-after-migration',
          workItemId: reviewWorkItemId,
          authorityBaseRef,
          sessionKind: 'review_content_batch',
          reviewAssignmentId,
          roundId: contentRoundId,
          roundKind: 'content',
          snapshotHash: 'a'.repeat(64),
          maxContextBytes: 1_024,
        });
        const grantSpecRef = await env.facade.prepareBlob(taskId, 'write_grant_spec', grant);
        const migratedManifest = await env.blobStore.readJson<{ taskContentRevision: number }>(taskId, input.migratedManifestRef, 'content_revision_manifest');
        const decision = await env.blobStore.readJson<{ finalizerAggregateRef: BlobRefV2 }>(taskId, input.migrationActivationDecisionRef, 'migration_activation_decision');
        return {
          carriers: mapReviewCarrier({
            mapReviewRoundId: 'round-durable',
            settlementCoreRef: fixture.settlementRef,
            outcome: 'activate',
            mapId: 'map-durable-target',
            mapRevision: 2,
            supersedesMapId: 'map-durable-source',
            mapSnapshotRef: fixture.targetMapRef,
            mapReviewBundleRef: fixture.bundleRef,
            mapSemanticDigest: H('durable-semantic'),
            contentRevisionManifestRef: input.migratedManifestRef,
            activationValidatorAggregateRef: decision.finalizerAggregateRef,
            taskContentRevision: migratedManifest.taskContentRevision,
            manifestPhase: 'finalized',
            producerPlanSpecRef: fixture.planRef,
            priorManifestRef: fixture.manifestRef,
            contentRound: {
              reviewRoundId: contentRoundId,
              contentCycleOrdinal: 1,
              mapRef: fixture.targetMapRef,
              mapSemanticDigest: H('durable-semantic'),
              contentRevisionManifestRef: input.migratedManifestRef,
              reviewPolicyDigest: H('durable-review-policy'),
              adoptionRootRef,
              coverageSlotCount: fixture.slotCount,
              coverageRelationCount: fixture.relationCount,
              assignmentCount: 1,
              verificationFindingCount: 0,
              consumedOverrideRef: null,
            },
            reviewWorkItems: [{
              workItemId: reviewWorkItemId,
              kind: 'agent_assignment',
              roleBinding: 'reviewer',
              agentExecutionKind: 'structured_session',
              sessionKind: 'review_content_batch',
              roundId: contentRoundId,
              logicalAssignmentId: `la-${reviewWorkItemId}`,
              reviewAssignmentId,
              grantSpecRef,
              inputArtifactDeliveryId: null,
              authorityBaseRef,
              payloadRef: contentCoverageRef,
              initialLeaseEpoch: 0,
              maxAutomaticRetries: 3,
            }],
          }),
          preparedRefs: [adoptionRootRef, findingStageRootRef, contentCoverageRef, authorityBaseRef, grantSpecRef],
        };
      },
    },
    repairCoordinator: options.repairCoordinator ?? { async prepareContentRepairActivation() { throw new Error('migration repair adapter not installed'); }, async prepareMapRepair() { throw new Error('migration repair adapter not installed'); } },
    systemCommands: commands,
  });
  const attempts = new V2AttemptCoordinator({
    coordinator: env.coordinator,
    runner: new V2AssignmentRunner({ runtime: new FakeAgentRuntime(), toolProvider: { async toolsFor() { return []; }, async collectResultRefs() { return []; } } }),
    systemCommands: commands, agentForRole: async () => null, frozenFor: async () => frozenV2,
    wakeups: new AuthoritativeWakeupIndexV1({ paths: env.paths }), traces: new TraceStore(env.paths), clock: () => env.now.value,
  });
  return { attempts, service };
}

async function runDurable10k(
  restartAt: number | null,
  options: {
    slotCount?: number;
    validatableSlotCount?: number;
    withRelation?: boolean;
    sourceCorruption?: 'manifest_map' | 'version_map' | 'aggregate_map';
    finalizerScenario?: FinalizerRouteScenario;
    requiredSlotIdsOverride?: readonly string[];
    repairCoordinator?: Parameters<typeof createProductionMigrationRuntime>[0]['repairCoordinator'];
  } = {},
) {
  const registry = durableMigrationRegistry();
  let env = await createWorkItemCoordinatorEnvironment({ registry });
  const taskId = 'task-migration-durable-10k';
  const fixture = await prepareDurable10kFixture(env, taskId, options);
  let repairHarness = createMigrationRepairHarness(env, taskId);
  let runtimeOptions = {
    ...options,
    repairCoordinator: options.repairCoordinator ?? migrationRepairCoordinator(env, taskId, fixture, repairHarness),
  };
  const seedEvents = [
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_build_started', mapBuildId: 'build-durable-source', revision: 1,
      mapBuildSpecRef: fixture.sourceMapBuildSpecRef, supersedesMapBuildId: null, sourceValidationReceiptRef: null,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_build_finish_proposed', mapBuildId: 'build-durable-source',
      expectedChunkCount: 1, expectedFrontierDigest: H('durable-frontier'), expectedRootCount: 1,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_build_finalized', mapBuildId: 'build-durable-source',
      manifestRef: fixture.contributionRef, contributionManifestRef: fixture.contributionRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_candidate_committed', candidateId: 'candidate-durable-source',
      candidateRef: fixture.sourceCandidateRef, candidateDigest: fixture.sourceCandidateRef.digest, baseMapId: null,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_activated', mapId: 'map-durable-source', mapRevision: 1,
      supersedesMapId: null, mapSnapshotRef: fixture.sourceMapRef, mapReviewBundleRef: fixture.bundleRef,
      mapSemanticDigest: H('durable-semantic'), contentRevisionManifestRef: fixture.baselineRef,
      activationValidatorAggregateRef: fixture.aggregateRef, migrationSettlementCoreRef: null, migrationActivationDecisionRef: null,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_content_revision_committed', contentRevisionManifestRef: fixture.baselineRef,
      taskContentRevision: 1, manifestPhase: 'baseline_unset', producerPlanSpecRef: null, priorManifestRef: null,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_content_revision_committed', contentRevisionManifestRef: fixture.manifestRef,
      taskContentRevision: 2, manifestPhase: 'finalized', producerPlanSpecRef: fixture.generationPlanRef, priorManifestRef: fixture.baselineRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_build_started', mapBuildId: 'build-durable', revision: 1,
      mapBuildSpecRef: fixture.mapBuildSpecRef, supersedesMapBuildId: null, sourceValidationReceiptRef: null,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_build_finish_proposed', mapBuildId: 'build-durable',
      expectedChunkCount: 1, expectedFrontierDigest: H('durable-frontier-target'), expectedRootCount: 1,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_build_finalized', mapBuildId: 'build-durable',
      manifestRef: fixture.contributionRef, contributionManifestRef: fixture.contributionRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_candidate_committed', candidateId: 'candidate-durable',
      candidateRef: fixture.candidateRef, candidateDigest: fixture.candidateRef.digest, baseMapId: null,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_review_round_planned', mapReviewRoundId: 'round-durable',
      mapCycleOrdinal: 1, candidateId: 'candidate-durable', candidateRef: fixture.candidateRef,
      contentRevisionManifestRef: fixture.manifestRef, reviewPolicyDigest: H('durable-review-policy'),
      coverageNodeCount: fixture.slotCount, coverageRelationCount: fixture.relationCount, assignmentCount: 1, consumedOverrideRef: null,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_work_item_created', workItemId: fixture.seedReviewWorkItemId,
      kind: 'agent_assignment', roleBinding: 'reviewer', agentExecutionKind: 'structured_session', sessionKind: 'review_map_batch',
      roundId: 'round-durable', logicalAssignmentId: fixture.seedReviewLogicalAssignmentId, reviewAssignmentId: fixture.seedReviewAssignmentId,
      grantSpecRef: fixture.seedReviewGrantRef, inputArtifactDeliveryId: null, authorityBaseRef: fixture.seedReviewAuthorityRef,
      payloadRef: fixture.coverageRef, initialLeaseEpoch: 0, maxAutomaticRetries: 3,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_work_item_leased', workItemId: fixture.seedReviewWorkItemId,
      leaseEpoch: 1, leaseOwner: 'reviewer-seed', leaseExpiresAt: '2026-08-14T10:30:00.000Z', expectedLastSequence: 0,
      authorityBaseRef: fixture.seedReviewAuthorityRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_assignment_dispatched', dispatchRef: fixture.seedDispatchRef,
      workItemId: fixture.seedReviewWorkItemId, attemptId: fixture.seedReviewAttemptId,
      logicalAssignmentId: fixture.seedReviewLogicalAssignmentId, reviewAssignmentId: fixture.seedReviewAssignmentId,
      agentExecutionKind: 'structured_session', sessionKind: 'review_map_batch', inputArtifactDeliveryId: null,
      authorityBaseRef: fixture.seedReviewAuthorityRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_agent_attempt_started_v2', workItemId: fixture.seedReviewWorkItemId,
      logicalAssignmentId: fixture.seedReviewLogicalAssignmentId, reviewAssignmentId: fixture.seedReviewAssignmentId,
      attemptId: fixture.seedReviewAttemptId, sessionKind: 'review_map_batch', leaseEpoch: 1, authorityBaseRef: fixture.seedReviewAuthorityRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_review_assignment_committed',
      assignmentId: 'assignment-map-review-durable-seed', mapReviewRoundId: 'round-durable', workItemId: fixture.seedReviewWorkItemId,
      attemptId: fixture.seedReviewAttemptId, reviewAssignmentId: fixture.seedReviewAssignmentId, source: 'batch',
      ledgerRef: fixture.seedLedgerRef, coverageTargetCount: 10_000, findingCount: 0,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_agent_attempt_completed_v2', workItemId: fixture.seedReviewWorkItemId,
      logicalAssignmentId: fixture.seedReviewLogicalAssignmentId, reviewAssignmentId: fixture.seedReviewAssignmentId,
      attemptId: fixture.seedReviewAttemptId, sessionKind: 'review_map_batch', leaseEpoch: 1, authorityBaseRef: fixture.seedReviewAuthorityRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_work_item_completed', workItemId: fixture.seedReviewWorkItemId,
      leaseEpoch: 1, authorityBaseRef: fixture.seedReviewAuthorityRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_review_round_completed', mapReviewRoundId: 'round-durable',
      coverageCoreRef: fixture.coverageRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_migration_validation_plan_started',
      migrationValidationPlanId: fixture.plan.migrationValidationPlanId, intentCoreRef: fixture.intentRef, planSpecRef: fixture.planRef,
    },
  ];
  const validatedSeedEvents = seedEvents.map((event, index) => validateAuthoritativeReviewEventV2({
    ...event,
    id: `evt-durable-seed-${index}`,
  }));
  const seedHold = await env.publicationStore.lock().acquire();
  try {
    await env.eventStore.appendBatch(taskId, 'seed-durable-authority', validatedSeedEvents, {
      expectedLastSequence: 0,
      fenceProof: await seedHold.proof(),
    });
  } finally {
    await seedHold.release();
  }
  const base = buildAuthorityBaseSet({
    taskId, templateSnapshotRef: env.templateSnapshotRef, profileSnapshotRef: env.profileSnapshotRef,
    kind: 'system_migration_validation_batch', refs: { mapCandidateRef: fixture.candidateRef, planSpecRef: fixture.planRef, reviewRoundRef: fixture.roundRef },
  });
  await env.coordinator.createWorkItem({
    taskId, operationId: '22222222-2222-4222-8222-222222222222', workItemId: 'wi-durable-batch-0',
    kind: 'system_migration_validation_batch', roleBinding: null, agentExecutionKind: null, sessionKind: null,
    logicalAssignmentId: null, reviewAssignmentId: null, inputArtifactDeliveryId: null,
    payload: { kind: 'migration_validation_plan_spec', value: fixture.plan }, authorityBase: base, maxAutomaticRetries: 3,
  });
  let runtime = openDurableRuntime(env, taskId, fixture, runtimeOptions);
  for (let ordinal = 0; ordinal < fixture.plan.orderedBatchSlotIds.length; ordinal += 1) {
    if (restartAt !== null && ordinal === restartAt) {
      const gc = new AuthoritativeReviewGc(env.paths, env.blobStore, env.eventStore, env.publicationStore, { rootsProvider: async () => ({}) });
      await gc.run();
      const reopened = await createWorkItemCoordinatorEnvironment({ paths: env.paths, registry });
      env = reopened;
      repairHarness = createMigrationRepairHarness(env, taskId);
      runtimeOptions = {
        ...options,
        repairCoordinator: options.repairCoordinator ?? migrationRepairCoordinator(env, taskId, fixture, repairHarness),
      };
      runtime = openDurableRuntime(env, taskId, fixture, runtimeOptions);
      expect((await env.readProjection(taskId)).migrationBatchOrdinals).toEqual(Array.from({ length: restartAt }, (_, index) => index));
    }
    const outcome = await runtime.attempts.runNext(taskId, `worker-${ordinal}`);
    expect(outcome).toMatchObject({ kind: 'completed' });
  }
  let settlementOutcome: Awaited<ReturnType<typeof runtime.attempts.runNext>> | { kind: 'threw'; error: string };
  try {
    settlementOutcome = await runtime.attempts.runNext(taskId, 'worker-post-migration');
  } catch (error) {
    settlementOutcome = { kind: 'threw', error: (error as Error).message };
  }
  const events = (await env.eventStore.read(taskId)).map((entry) => entry.event);
  const roots = events.flatMap((event) => event.type === 'structured_migration_validation_batch_completed'
    ? [{ ordinal: event.batchOrdinal, ref: event.batchResultRootRef }]
    : []).sort((a, b) => a.ordinal - b.ordinal);
  const equivalenceRefs: BlobRefV2[] = [];
  let revalidatedCount = 0;
  for (const root of roots) {
    const result = await env.blobStore.readJson(taskId, root.ref, root.ref.kind) as { slotResults: Array<{ outcome: string; localValidatorEquivalenceProofRef?: BlobRefV2 }> };
    for (const slot of result.slotResults) {
      if (slot.outcome === 'revalidated') revalidatedCount += 1;
      if (slot.localValidatorEquivalenceProofRef !== undefined) equivalenceRefs.push(slot.localValidatorEquivalenceProofRef);
    }
  }
  if (settlementOutcome?.kind !== 'completed') {
    return {
      roots,
      equivalenceRefs,
      revalidatedCount,
      route: null,
      settlementRef: null,
      decisionRef: null,
      manifestRef: null,
      eventRoot: canonicalJsonSha256(events),
      settlementOutcome,
      events,
      env,
      fixture,
      repairHarness,
    };
  }
  const settlementEvent = events.find((event) => event.type === 'structured_migration_validation_settlement_completed');
  const activationEvent = events.find((event) => event.type === 'structured_map_activated' && event.migrationSettlementCoreRef !== null);
  if (settlementEvent?.type !== 'structured_migration_validation_settlement_completed') {
    throw new Error('durable migration did not publish its terminal settlement event');
  }
  const terminalDecision = await env.blobStore.readJson<{ combinedRouteOutcome: string }>(taskId, settlementEvent.activationDecisionRef, 'migration_activation_decision');
  return {
    roots,
    equivalenceRefs,
    revalidatedCount,
    route: terminalDecision.combinedRouteOutcome,
    settlementRef: settlementEvent.settlementCoreRef,
    decisionRef: settlementEvent.activationDecisionRef,
    manifestRef: activationEvent?.type === 'structured_map_activated'
      ? activationEvent.contentRevisionManifestRef
      : settlementEvent.provisionalManifestRef,
    eventRoot: canonicalJsonSha256(events),
    settlementOutcome,
    events,
    env,
    fixture,
    repairHarness,
  };
}

describe('Task 20 production command integration', () => {
  it('runs a small clear migration through batch and post_migration on the real AttemptCoordinator path', async () => {
    const result = await runDurable10k(null, { slotCount: 2, validatableSlotCount: 1, finalizerScenario: 'clear' });
    expect(result.settlementOutcome, JSON.stringify(result.settlementOutcome)).toMatchObject({ kind: 'completed' });
    expect(result.route).toBe('clear');
    expect(result.events.some((event) => event.type === 'structured_map_activated' && event.migrationSettlementCoreRef !== null)).toBe(true);
    expect(result.events.filter((event) => event.type === 'structured_finding_opened')).toEqual([]);
    if (result.manifestRef === null) throw new Error('clear migration did not retain its finalized manifest');
    const manifest = await result.env.blobStore.readJson<{ entries: Array<{ slotId: string; versionRef: BlobRefV2 }> }>(
      'task-migration-durable-10k', result.manifestRef, 'content_revision_manifest',
    );
    const migrated = manifest.entries.find((entry) => entry.slotId === 'slot-00000');
    if (migrated === undefined) throw new Error('freshly revalidated slot is absent from the migrated manifest');
    const migratedVersion = await result.env.blobStore.readJson<SlotContentVersionV2>(
      'task-migration-durable-10k', migrated.versionRef, 'content_version',
    );
    expect(migratedVersion.state).toBe('set');
    if (migratedVersion.state === 'set') {
      expect(migratedVersion.provenance.kind).toBe('inherited_after_map_activation');
    }
    if (migratedVersion.state === 'set' && migratedVersion.provenance.kind === 'inherited_after_map_activation') {
      expect(migratedVersion.provenance.migratedBatchWarningRootRef?.kind).toBe('validation_warning_custody_root');
    }
  }, 120_000);

  it.each(['manifest_map', 'version_map', 'aggregate_map'] as const)(
    'does not reuse validator custody when the authoritative source %s lineage disagrees',
    async (sourceCorruption) => {
      const result = await runDurable10k(null, {
        slotCount: 2,
        validatableSlotCount: 1,
        finalizerScenario: 'clear',
        sourceCorruption,
      });
      expect(result.equivalenceRefs).toHaveLength(0);
      expect(result.revalidatedCount).toBe(1);
      expect(result.settlementOutcome, JSON.stringify(result.settlementOutcome)).toMatchObject({ kind: 'completed' });
      expect(result.route).toBe('clear');
    },
    120_000,
  );

  it('keeps finalizer infrastructure failure retryable and publishes no migration settlement/activation', async () => {
    const result = await runDurable10k(null, { slotCount: 2, validatableSlotCount: 1, finalizerScenario: 'infrastructure_failure' });
    expect(result.route).toBeNull();
    expect(result.settlementOutcome.kind).not.toBe('completed');
    expect(result.events.some((event) => event.type === 'structured_migration_validation_settlement_completed')).toBe(false);
    expect(result.events.some((event) => event.type === 'structured_map_activated' && event.migrationSettlementCoreRef !== null)).toBe(false);
    expect(result.settlementOutcome).toMatchObject({ kind: 'retryable_failed' });
  }, 120_000);

  it('projects the exact content Finding/RepairPlan and commits its first real repair batch', async () => {
    const result = await runDurable10k(null, { slotCount: 2, validatableSlotCount: 1, finalizerScenario: 'content_repair' });
    expect(result.settlementOutcome, JSON.stringify(result.settlementOutcome)).toMatchObject({ kind: 'completed' });
    expect(result.route).toBe('content_repair');
    const opened = result.events.filter((event) => event.type === 'structured_finding_opened');
    expect(opened).toHaveLength(1);
    const findingId = opened[0]!.findingId;
    expect(opened[0]).toMatchObject({
      findingId,
      defectClass: 'content',
      primaryLocation: { kind: 'slot', id: 'slot-00000' },
      severity: 'blocking', source: 'system_validator',
    });
    const before = await result.env.readProjection('task-migration-durable-10k');
    expect(before.findings[findingId]).toMatchObject({ state: 'open', defectClass: 'content' });
    const repairWorkItem = Object.values(before.workItems).find((item) => item.sessionKind === 'content_repair' && item.state === 'ready');
    expect(repairWorkItem).toBeDefined();
    const repairPlan = Object.values(before.repairPlans).find((lineage) => lineage.track === 'content');
    expect(repairPlan?.currentPlanRevisionId).not.toBeNull();
    const lease = await result.env.coordinator.leaseNext('task-migration-durable-10k', 'content-repair-worker', 'lease-content-repair-after-migration');
    if (lease === null || lease.attemptId === null || repairWorkItem === undefined) throw new Error('content repair WorkItem did not lease');
    expect(lease.workItemId).toBe(repairWorkItem.workItemId);
    const ctx: V2AttemptContext = {
      taskId: 'task-migration-durable-10k', workItemId: lease.workItemId, attemptId: lease.attemptId,
      leaseEpoch: lease.leaseEpoch, namespace: `structured/${lease.workItemId}/${lease.attemptId}`,
      agentId: lease.leaseOwner, roleBinding: 'generator', executionKind: 'structured', sessionKind: 'content_repair',
      dispatchRef: lease.dispatchRef, authorityBaseRef: lease.authorityBaseRef, grantInstanceRef: lease.grantInstanceRef,
      inputArtifactDeliveryId: null, agent: null, currentAssignmentText: '', committedCheckpointText: '',
    };
    const valueBody = {
      slotId: 'slot-00000', contentSchemaDigest: H('durable-schema'), taskContentRevision: 4,
      mediaType: 'text/markdown' as const, text: 'migration repair content',
    };
    const valueRef = await result.env.facade.prepareBlob('task-migration-durable-10k', 'content_value', {
      ...valueBody, selfDigest: canonicalJsonSha256(valueBody),
    });
    await result.repairHarness.privateStore.appendReviewDraft(
      {
        workItemId: lease.workItemId, leaseEpoch: lease.leaseEpoch, attemptId: lease.attemptId,
        authorityBaseRef: lease.authorityBaseRef, grantSpecRef: before.workItems[lease.workItemId]!.grantSpecRef!,
      },
      {
        clientOperationId: 'write-migration-content-repair', op: 'write_slot_content',
        body: { slotId: 'slot-00000', value: 'migration repair content' },
        result: { slotId: 'slot-00000', contentValueRef: valueRef },
      },
    );
    const committed = await result.repairHarness.service.commitRepairBatch({
      taskId: 'task-migration-durable-10k', workItemId: lease.workItemId, attemptId: lease.attemptId,
      batchOrdinal: 1, ctx, slotContents: { 'slot-00000': { text: 'migration repair content', mediaType: 'text/markdown' } },
    });
    expect(committed.kind).toBe('committed');
    if (committed.kind !== 'committed') throw new Error(`content repair batch failed: ${JSON.stringify(committed)}`);
    await result.env.coordinator.completeWorkItem({
      taskId: 'task-migration-durable-10k',
      operationId: attemptContinuationOperationId('task-migration-durable-10k', lease.workItemId, lease.attemptId, 'complete'),
      workItemId: lease.workItemId, attemptId: lease.attemptId, resultRefs: committed.resultRefs,
    });
    const finalizeLease = await result.env.coordinator.leaseNext(
      'task-migration-durable-10k',
      'content-repair-finalizer',
      'lease-content-repair-finalizer-after-migration',
    );
    if (finalizeLease === null || finalizeLease.commandId === null || finalizeLease.workItemId !== committed.nextWorkItemId) {
      throw new Error('content repair finalizer WorkItem did not lease');
    }
    const beforeFinalize = await result.env.readProjection('task-migration-durable-10k');
    const finalizeWorkItem = beforeFinalize.workItems[finalizeLease.workItemId];
    if (finalizeWorkItem === undefined) throw new Error('content repair finalizer WorkItem is absent from projection');
    const finalized = await result.repairHarness.service.executeRepairFinalize({
      taskId: 'task-migration-durable-10k', commandId: finalizeLease.commandId,
      workItemId: finalizeLease.workItemId, commandKind: 'repair_finalize', leaseEpoch: finalizeLease.leaseEpoch,
      authorityBaseRef: finalizeLease.authorityBaseRef, payloadRef: finalizeWorkItem.payloadRef,
    });
    expect(finalized.kind).toBe('completed');
    const after = await result.env.readProjection('task-migration-durable-10k');
    expect(after.findings[findingId]?.addressStages).toContain('content');
    expect((await result.env.eventStore.read('task-migration-durable-10k')).some((entry) => entry.event.type === 'structured_content_repair_batch_committed')).toBe(true);
  }, 120_000);

  it('projects a mixed Finding onto the Map track with an exact ready MapRepairPlan', async () => {
    const result = await runDurable10k(null, { slotCount: 2, validatableSlotCount: 1, finalizerScenario: 'map_repair' });
    expect(result.settlementOutcome, JSON.stringify(result.settlementOutcome)).toMatchObject({ kind: 'completed' });
    expect(result.route).toBe('map_repair');
    const opened = result.events.filter((event) => event.type === 'structured_finding_opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      defectClass: 'mixed', primaryLocation: { kind: 'map_node', id: 'slot-00000' },
      severity: 'blocking', source: 'system_validator',
    });
    const projected = await result.env.readProjection('task-migration-durable-10k');
    const findingId = opened[0]!.findingId;
    expect(projected.findings[findingId]).toMatchObject({ state: 'open', defectClass: 'mixed' });
    expect(Object.values(projected.repairPlans).some((lineage) => lineage.track === 'map' && lineage.currentPlanRevisionId !== null)).toBe(true);
    expect(Object.values(projected.workItems).some((item) => item.sessionKind === 'map_repair' && item.state === 'ready')).toBe(true);
  }, 120_000);

  it('fails closed when configured required slots disagree with the system-derived target-Map coverage', async () => {
    const result = await runDurable10k(null, {
      slotCount: 2,
      validatableSlotCount: 1,
      requiredSlotIdsOverride: [],
    });
    expect(result.settlementOutcome).not.toMatchObject({ kind: 'completed' });
    expect(result.route).toBeNull();
    expect(result.events.some((event) => event.type === 'structured_map_activated' && event.mapId === 'map-durable-target')).toBe(false);
  }, 120_000);

  it.each([
    {
      scenario: 'map_repair_slot_primary' as const,
      expectedNodes: ['slot-00000', 'slot-00001'],
      expectedRelations: [] as string[],
    },
    {
      scenario: 'map_repair_map_primary' as const,
      expectedNodes: ['slot-00000', 'slot-00001'],
      expectedRelations: ['rel-00000'],
    },
    {
      scenario: 'map_repair_multi_target' as const,
      expectedNodes: ['slot-00000', 'slot-00001'],
      expectedRelations: ['rel-00000'],
    },
  ])('keeps complete $scenario targets through AttemptCoordinator into a ready candidate-bound MapRepairPlan', async ({ scenario, expectedNodes, expectedRelations }) => {
    const result = await runDurable10k(null, {
      slotCount: 2,
      validatableSlotCount: 1,
      withRelation: true,
      finalizerScenario: scenario,
    });
    expect(result.settlementOutcome, JSON.stringify(result.settlementOutcome)).toMatchObject({ kind: 'completed' });
    expect(result.route).toBe('map_repair');
    const projection = await result.env.readProjection('task-migration-durable-10k');
    const lineage = Object.values(projection.repairPlans).find((candidate) => candidate.track === 'map');
    expect(lineage?.currentPlanRevisionId).not.toBeNull();
    const revision = lineage?.revisions[lineage.currentPlanRevisionId as string];
    if (revision === undefined) throw new Error('projected migration MapRepairPlan revision is absent');
    const plan = await result.env.blobStore.readJson('task-migration-durable-10k', revision.specRef, 'repair_plan_spec') as {
      repairBase: { kind: string; candidateRef?: BlobRefV2 };
      orderedBatchScopes: Array<{ kind: string; scope?: { nodeIds: string[]; relationIds: string[] } }>;
    };
    expect(plan.repairBase).toMatchObject({ kind: 'map_candidate' });
    const nodeIds = [...new Set(plan.orderedBatchScopes.flatMap((scope) => scope.scope?.nodeIds ?? []))].sort();
    const relationIds = [...new Set(plan.orderedBatchScopes.flatMap((scope) => scope.scope?.relationIds ?? []))].sort();
    expect(nodeIds).toEqual(expectedNodes);
    expect(relationIds).toEqual(expectedRelations);
    expect(Object.values(projection.workItems).some((item) => item.sessionKind === 'map_repair' && item.state === 'ready')).toBe(true);
  }, 120_000);

  it('uses an equivalence-inherited version in a second Map replacement after GC/reopen and produces the same terminal batch root', async () => {
    const first = await runDurable10k(null, { slotCount: 3, validatableSlotCount: 2 });
    expect(first.route).toBe('clear');
    expect(first.equivalenceRefs).toHaveLength(1);
    if (first.manifestRef === null) throw new Error('first migration did not publish a manifest');

    const gc = new AuthoritativeReviewGc(first.env.paths, first.env.blobStore, first.env.eventStore, first.env.publicationStore, { rootsProvider: async () => ({}) });
    await gc.run();
    const reopened = await createWorkItemCoordinatorEnvironment({ paths: first.env.paths, registry: durableMigrationRegistry() });
    const taskId = 'task-migration-durable-10k';
    const sourceManifest = await reopened.blobStore.readJson<{ entries: Array<{ slotId: string; versionRef: BlobRefV2 }> }>(taskId, first.manifestRef, 'content_revision_manifest');
    const inheritedEntry = sourceManifest.entries.find((entry) => entry.slotId === 'slot-00000');
    if (inheritedEntry === undefined) throw new Error('first migration lost the equivalence-inherited slot');
    const inheritedVersion = await reopened.blobStore.readJson<SlotContentVersionV2>(taskId, inheritedEntry.versionRef, 'content_version');
    expect(inheritedVersion.state === 'set' ? inheritedVersion.provenance : null).toMatchObject({
      kind: 'inherited_after_map_activation',
      migratedBatchValidatorAggregateRef: null,
      localValidatorEquivalenceProofRef: { kind: 'local_validator_equivalence_proof' },
    });
    const firstTargetMap = await reopened.blobStore.readJson<{
      nodes: Array<Record<string, unknown>>;
      relations: Array<Record<string, unknown>>;
      mapSemanticDigest: string;
    }>(taskId, first.fixture.targetMapRef, 'map_snapshot');
    const secondMap = {
      ...firstTargetMap,
      mapId: 'map-durable-target-2',
      supersedesMapId: 'map-durable-target',
      mapRevision: 3,
      nodes: [firstTargetMap.nodes[0]!],
      relations: [],
      activatedAt: '2026-08-16T00:00:00.000Z',
    };
    const secondMapRef = await reopened.facade.prepareBlob(taskId, 'map_snapshot', secondMap);
    const impactBody = { findingSetId: 'migration-impact-second', findingRefs: [] as BlobRefV2[] };
    const impact = { ...impactBody, setDigest: canonicalJsonSha256(impactBody) };
    const impactRef = await reopened.facade.prepareBlob(taskId, 'finding_set', impact);
    const migrationSpec = buildContentMigrationSpec({
      migrationId: 'migration-durable-second',
      mapReviewSettlementCoreRef: first.fixture.settlementRef,
      sourceManifestRef: first.manifestRef,
      sourceMapRef: first.fixture.targetMapRef,
      targetMapRef: secondMapRef,
      impactClosureRef: impactRef,
      migrationPolicyVersion: '1',
    });
    const migrationSpecRef = await reopened.facade.prepareBlob(taskId, 'migration_spec', migrationSpec);
    const compatibilityBody = {
      taskId,
      slotId: 'slot-00000',
      sourceVersionRef: inheritedEntry.versionRef,
      sourceMapRef: first.fixture.targetMapRef,
      targetMapRef: secondMapRef,
      sourceContentSchemaDigest: inheritedVersion.contentSchemaDigest,
      targetContentSchemaDigest: inheritedVersion.contentSchemaDigest,
      stableIdentityEvidenceRef: impactRef,
      proofPolicyVersion: '1',
    };
    const compatibility = { ...compatibilityBody, proofDigest: canonicalJsonSha256(compatibilityBody) };
    const compatibilityRef = await reopened.facade.prepareBlob(taskId, 'content_compatibility_proof', compatibility);
    const intent = buildMigrationIntent({
      taskId,
      migrationSpecRef,
      sourceManifestRef: first.manifestRef,
      sourceMapRef: first.fixture.targetMapRef,
      targetMapRef: secondMapRef,
      decisions: [{ action: 'inherit_or_validate', slotId: 'slot-00000', sourceVersionRef: inheritedEntry.versionRef, compatibilityProofRef: compatibilityRef }],
      impactClosureRef: impactRef,
      migrationPolicyVersion: '1',
    });
    const intentRef = await reopened.facade.prepareBlob(taskId, 'migration_intent_core', intent);
    const plan = buildMigrationValidationPlanSpec({
      migrationValidationPlanId: 'mvp-durable-second',
      migrationIntentCoreRef: intentRef,
      candidateRef: first.fixture.candidateRef,
      proposedMapCoreRef: first.fixture.plan.proposedMapCoreRef,
      sourceManifestRef: first.manifestRef,
      frozenRegistrationSetDigest: registrationSetDigestOf([first.fixture.batchReg]),
      orderedBatchSlotIds: [['slot-00000']],
      profileRef: reopened.profileSnapshotRef,
    });
    const planRef = await reopened.facade.prepareBlob(taskId, 'migration_validation_plan_spec', plan);
    const published: Array<{ payload: unknown }> = [];
    const commands = new SystemCommandRegistry();
    const { service } = createProductionMigrationRuntime({
      facade: {
        prepareBlob: (id, kind, value) => reopened.facade.prepareBlob(id, kind, value),
        async publishWithPin(pin) { published.push({ payload: pin.payload }); return {} as never; },
      },
      tail: async () => ({ lastSequence: 0, lastCommitId: null }),
      templateSnapshotRef: reopened.templateSnapshotRef,
      profileSnapshotRef: reopened.profileSnapshotRef,
      frozenRegistrationSetDigest: plan.frozenRegistrationSetDigest,
      migrationPolicyVersion: '1', equivalencePolicyVersion: '1', maxAutomaticRetries: 3,
      clock: () => '2026-08-16T00:00:00.000Z',
      resolve: (id, ref) => reopened.blobStore.readJson(id, ref, ref.kind),
      completedBatches: async () => [],
      validatorRegistry: new ValidatorRegistry(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES),
      profileBody: buildAuthoritativeReviewTestProfileBody(), templateSnapshotHash: 'a'.repeat(64),
      registrationsFor: (phase) => phase === 'batch_commit' ? [first.fixture.batchReg] : [registration('authoritative.review.coverage')],
      slotTypes: [{ id: 'doc', name: 'doc', description: 'doc', contentPresence: 'required', contentSchema: { type: 'string' } }],
      slotTypeOf: () => 'doc', requiredSlotIdsOf: () => ['slot-00000'], readProjection: reopened.readProjection,
      sourceResolver: builtinSourceOf,
      reviewCoordinator: { async prepareClearActivation() { throw new Error('not used'); } },
      repairCoordinator: { async prepareContentRepairActivation() { throw new Error('not used'); }, async prepareMapRepair() { throw new Error('not used'); } },
      systemCommands: commands,
    });
    const execute = () => service.executeNextBatch({
      taskId, commandId: 'cmd-second-map-batch', workItemId: 'wi-second-map-batch', leaseEpoch: 1,
      authorityBaseRef: R('authority_base_set', 'second-map-base'), planSpecRef: planRef,
      reviewCoverageCoreRef: first.fixture.coverageRef, reviewRoundRef: first.fixture.roundRef,
    });
    const secondA = await execute();
    const secondB = await execute();
    expect(secondA).toMatchObject({ kind: 'completed', batchOrdinal: 0 });
    expect(secondB).toMatchObject({ kind: 'completed', batchOrdinal: 0 });
    if (secondA.kind !== 'completed' || secondB.kind !== 'completed') throw new Error('second migration did not complete');
    expect(secondB.batchResultRootRef).toEqual(secondA.batchResultRootRef);
    const result = await reopened.blobStore.readJson<{ slotResults: Array<{ outcome: string }> }>(taskId, secondA.batchResultRootRef, 'migration_validation_batch_result');
    expect(result.slotResults).toEqual([{ outcome: 'equivalent', slotId: 'slot-00000', localValidatorEquivalenceProofRef: expect.any(Object) }]);
    await expect(validateAndClassifyMigrationBatchResults({
      taskId, plan, planSpecRef: planRef, intent, orderedResultRefs: [secondA.batchResultRootRef],
      resolve: (ref) => reopened.blobStore.readJson(taskId, ref, ref.kind),
    })).resolves.toMatchObject({ batchRouteOutcome: 'clear' });
    expect(published).toHaveLength(2);
  }, 180_000);

  it('recovers a real 10k migration after GC and runtime reconstruction with byte-identical durable results', async () => {
    const uninterrupted = await runDurable10k(null);
    const resumed = await runDurable10k(73);

    expect(uninterrupted.roots).toHaveLength(75);
    expect(uninterrupted.equivalenceRefs).toHaveLength(599);
    expect(uninterrupted.revalidatedCount).toBe(1);
    expect(uninterrupted.route).toBe('clear');
    expect(resumed.roots).toEqual(uninterrupted.roots);
    expect(resumed.equivalenceRefs).toEqual(uninterrupted.equivalenceRefs);
    expect(resumed.revalidatedCount).toBe(uninterrupted.revalidatedCount);
    expect(resumed.settlementRef).toEqual(uninterrupted.settlementRef);
    expect(resumed.decisionRef).toEqual(uninterrupted.decisionRef);
    expect(resumed.manifestRef).toEqual(uninterrupted.manifestRef);
    expect(resumed.route).toBe(uninterrupted.route);
    expect(resumed.eventRoot).toBe(uninterrupted.eventRoot);
  }, 900_000);

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
    const batchRegistration = registration('authoritative.review.slotSchema');
    const plan = buildMigrationValidationPlanSpec({
      migrationValidationPlanId: 'mvp-integration', migrationIntentCoreRef: intentRef, candidateRef, proposedMapCoreRef: proposedRef,
      sourceManifestRef, frozenRegistrationSetDigest: registrationSetDigestOf([batchRegistration]), orderedBatchSlotIds: [['slot-1']], profileRef: env.profileSnapshotRef,
    });
    const planRef = refOfBlob('migration_validation_plan_spec', plan);
    objects.set(specRef.digest, spec);
    objects.set(intentRef.digest, intent);
    objects.set(planRef.digest, plan);
    objects.set(mapSettlementRef.digest, { coverageCoreRef: coverageRef });
    objects.set(reviewRoundRef.digest, {
      mapReviewRoundId: 'round-integration', candidateId: 'candidate-integration', candidateDigest: H('candidate-integration'),
      contentRevisionManifestRef: sourceManifestRef, contentRootDigest: null, reviewPolicyDigest: H('review-policy-integration'),
      coverageNodeIds: ['slot-1'], coverageRelationIds: [], assignmentIds: [], inheritedRecordRefs: [],
      wholeMapObservationRefs: [], verificationFindingStages: [], state: 'completed', settlementRef: mapSettlementRef,
    });

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
      registrationsFor: (phase) => phase === 'batch_commit' ? [batchRegistration] : [registration('authoritative.review.coverage')],
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
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'completed', workItemId });
    const projection = await env.readProjection(taskId);
    expect(projection.migrationBatchOrdinals).toEqual([0]);
    expect(projection.workItems[workItemId]?.state).toBe('completed');
    expect(Object.values(projection.workItems).some((item) => item.kind === 'system_review_settlement' && item.state === 'ready')).toBe(true);
  });
});
