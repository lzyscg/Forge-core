// @vitest-environment node
/**
 * Task 18 content-review-service tests (spec §13.2/§13.3/§13.3.1, design
 * §11.6/§11.10/§12.4/§12.6/§16.1): the presence-aware coverage facts, the
 * whole-tree observation closure, the FINAL coverage core, the acyclic
 * settlement DAG + System Seal WorkItem, and the content-cycle budget boundary.
 *
 * The harness drives the REAL Map build -> Map review -> activation -> baseline
 * manifest pipeline (the map-review-service pattern), then commits a finalized
 * manifest and plans the content review round via the service's
 * `planContentReviewRound` (the Task 17 finalizer seam).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import { PublicationIntentRegistry } from '../../storage/authoritative-publication-intent-registry';
import { fullProfileForTests, refOfBlob, parseBlob } from '../../authoritative-review/object-registry';
import { buildAuthoritativeReviewTestProfileBody } from '../../structured-slots/test-support/authoritative-review-test-registry';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { buildAuthorityBaseSet } from './authority-base';
import { GrantService } from './grant-service';
import { ValidatorRegistry } from './validator-registry';
import { AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES, builtinSourceOf } from './builtin-validators';
import type { ValidatorRegistrationV2 } from '../../template/structured-slot-contract-v2';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { V2AttemptContext } from './attempt-coordinator';
import type { WriteGrantSpecV2, MapRelationV2, ReviewRoundV2, ContentRevisionManifestV2, SlotContentVersionV2, ReviewFactTargetKindV2 } from '../../authoritative-review/authority-types';
import {
  authoritativeTestContentValue,
  createWorkItemCoordinatorEnvironment,
  disposeRuntimeTestRoots,
  type WorkItemCoordinatorEnvironment,
} from '../test-support';
import {
  EMPTY_BUILD_FRONTIER_DIGEST,
  MapBuildService,
} from './map-build-service';
import {
  MapReviewService,
  deterministicSettlementWorkItemId,
} from './map-review-service';
import {
  ContentReviewService,
  buildContentReviewCoverageCore,
  contentRoundShape,
  contentRoundBudgetCheck,
  planContentReview,
  deterministicContentSettlementWorkItemId,
  deterministicSealWorkItemId,
  ReviewRepairLimitExceededError,
  registerContentReviewPublicationHandlers,
} from './content-review-service';
import {
  ReviewCoordinatorV2,
  reviewAssignmentIdOf,
  reviewWholeAssignmentId,
  reviewBatchWorkItemId,
  reviewWholeWorkItemId,
} from './review-coordinator';
import { planMapReview, type MapReviewPlanV2 } from './observation-planner';
import { buildReviewAssignmentFreeze, type ReviewDraftRecordV2, type FrozenReviewAssignmentV2 } from './tool-factory';
import { attemptContinuationOperationId } from './attempt-coordinator';
import {
  ContentPlanService,
  generationFinalizeWorkItemId,
  contentReviewRoundId,
} from './content-plan-service';
import { ReviewAdoptionService } from './review-adoption-service';
import { FindingService, buildFindingStageRoot } from './finding-service';
import type { ValidatorSlotType } from './validator-engine';

const PROFILE = fullProfileForTests();
const PROFILE_BODY = buildAuthoritativeReviewTestProfileBody();
const REGISTRY = new ValidatorRegistry(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES);

function alwaysValidSource(salt: string): string {
  return `'use strict';
module.exports = { validate: function validate(input) { return { status: 'valid', executionDigest: '${hash(salt)}' }; } };`;
}
function testValidatorEntry(trigger: 'map_review_settlement' | 'map_activation' | 'review_settlement', source: string, keySuffix = ''): import('./validator-registry').InstalledValidatorEntry {
  return {
    handlerKey: `test.review.${trigger}${keySuffix}`,
    implementationDigest: createHash('sha256').update(source, 'utf8').digest('hex'),
    moduleId: '@forge/authoritative-review',
    exportName: 'reviewTestHandler',
    trigger,
    executionPhase: null,
    abi: 'forge-validator/v2',
    budgetProfileId: 'authoritative-validator-default',
    inputContractVersion: 2,
    outputContractVersion: 2,
  };
}
function testRegistrationFor(trigger: 'map_review_settlement' | 'map_activation' | 'review_settlement', source: string, validatorId: string): ValidatorRegistrationV2 {
  const entry = testValidatorEntry(trigger, source);
  return {
    validatorId,
    handlerKey: entry.handlerKey,
    implementationDigest: entry.implementationDigest,
    implementationRef: { kind: 'builtin', moduleId: entry.moduleId, exportName: entry.exportName },
    trigger: entry.trigger,
    executionPhase: entry.executionPhase,
    selector: { kind: 'all' },
    enforcement: 'blocking',
    deterministic: true,
    inputContractVersion: 2,
    outputContractVersion: 2,
    budgetProfileId: entry.budgetProfileId,
  };
}
const SETTLEMENT_SOURCE = alwaysValidSource('review_settlement');
const ACTIVATION_SOURCE = alwaysValidSource('map_activation');
const CONTENT_SETTLEMENT_SOURCE = alwaysValidSource('content_review_settlement');
const REVIEW_REGISTRY = new ValidatorRegistry([
  ...AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES,
  testValidatorEntry('map_review_settlement', SETTLEMENT_SOURCE),
  testValidatorEntry('map_activation', ACTIVATION_SOURCE),
  testValidatorEntry('review_settlement', CONTENT_SETTLEMENT_SOURCE),
]);
function reviewSourceResolver(handlerKey: string): string | null {
  if (handlerKey === 'test.review.map_review_settlement') return SETTLEMENT_SOURCE;
  if (handlerKey === 'test.review.map_activation') return ACTIVATION_SOURCE;
  if (handlerKey === 'test.review.review_settlement') return CONTENT_SETTLEMENT_SOURCE;
  return null;
}

const REVIEW_POLICY = {
  mapReview: 'required' as const,
  contentSelector: 'content_bearing' as const,
  mapBatchTargetSlots: 24,
  contentBatchTargetSlots: 2,
  assignmentSoftLimit: 64,
  wholeMapObservation: 'required' as const,
  wholeContentTreeObservation: 'required' as const,
  reviewAdvisoryRelations: false,
  maxRounds: 8,
};

let seq = 0;
function opId(label: string): string {
  seq += 1;
  return `op-${createHash('sha256').update(`op:${label}:${seq}`).digest('hex').slice(0, 32)}`;
}
function hash(salt: string): string {
  return createHash('sha256').update(salt, 'utf8').digest('hex');
}

interface ContentReviewEnv {
  env: WorkItemCoordinatorEnvironment;
  taskId: string;
  service: ContentReviewService;
  coordinator: ReviewCoordinatorV2;
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown>;
  readEvents(taskId: string): Promise<readonly AuthoritativeReviewEventV2[]>;
  reviewPolicyDigest: string;
  roundId: string;
  finalizedManifestRef: BlobRefV2;
  setSlotIds: string[];
  mapSnapshotRef: BlobRefV2;
  mapSemanticDigest: string;
  reviewPolicy: typeof REVIEW_POLICY;
  maxRounds: number;
}

let envs: ContentReviewEnv[] = [];

async function makeContentReviewEnv(opts: { maxRounds?: number } = {}): Promise<ContentReviewEnv> {
  const profile = PROFILE;
  const maxRounds = opts.maxRounds ?? REVIEW_POLICY.maxRounds;
  const reviewPolicy = { ...REVIEW_POLICY, maxRounds };
  const registry = new PublicationIntentRegistry();
  const { registerMapBuildPublicationHandlers } = await import('./map-build-service');
  const { registerMapReviewPublicationHandlers } = await import('./map-review-service');
  const { registerContentPlanPublicationHandlers } = await import('./content-plan-service');
  registerMapBuildPublicationHandlers(registry);
  registerMapReviewPublicationHandlers(registry);
  registerContentPlanPublicationHandlers(registry);
  registerContentReviewPublicationHandlers(registry);
  const env = await createWorkItemCoordinatorEnvironment({ registry });
  const taskId = 'task-content-review';
  const mapBuildId = 'mb-1';
  // Task-local authority refs: the env's stand-ins were prepared under the
  // env's OWN task root; the blob store is per-task, so GC walking THIS task's
  // events would fail closed on the shared refs (the F1 GC regression test).
  const templateSnapshotRef = await env.facade.prepareBlob(
    taskId,
    'content_value',
    authoritativeTestContentValue('template snapshot stand-in (task-local)'),
  );
  const profileSnapshotRef = await env.facade.prepareBlob(taskId, 'profile_snapshot', PROFILE_BODY);

  // --- Task 15: map build spec + start ---
  const specBody = {
    mapBuildId,
    revision: 1,
    supersedesMapBuildId: null,
    sourceValidationReceiptRef: null,
    snapshotHash: 'a'.repeat(64),
    plannedChunkPolicy: { maxChunks: 16, maxNodesPerChunk: 512, maxRelationsPerChunk: 64 },
  };
  const spec = { ...specBody, specDigest: canonicalJsonSha256(specBody) };
  const specRef = await env.facade.prepareBlob(taskId, 'map_build_spec', spec);
  const base = buildAuthorityBaseSet({
    taskId,
    templateSnapshotRef: templateSnapshotRef,
    profileSnapshotRef: profileSnapshotRef,
    refs: { planSpecRef: specRef },
    kind: 'agent_assignment',
    agentExecutionKind: 'structured_session',
    sessionKind: 'structure_chunk',
  });
  const baseRef = await env.facade.prepareBlob(taskId, 'authority_base_set', base);
  const workItemId = 'wi-build-1';
  const grantBody = {
    grantSpecId: 'gs-build-1',
    workItemId,
    kind: 'initial_structure_chunk' as const,
    snapshotHash: 'a'.repeat(64),
    authorityBaseRef: baseRef,
    mapBuildSpecRef: specRef,
    expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST,
    structureChunkScope: { chunkOrdinal: 1, parentFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, maxNodes: 512, maxRelations: 64 },
  };
  const grantSpec = { ...grantBody, specDigest: canonicalJsonSha256(grantBody) } as WriteGrantSpecV2;
  const grantSpecRef = await env.facade.prepareBlob(taskId, 'write_grant_spec', grantSpec);
  const tail0 = await env.eventStore.tail(taskId);
  await env.facade.publishWithPin({
    taskId,
    operationId: opId('start-task'),
    payload: {
      family: 'lifecycle',
      operationId: opId('start-task'),
      taskId,
      kind: 'start',
      suspensionId: null,
      workItemId,
      reason: null,
      leaseEpoch: null,
      expectedLastSequence: null,
      authorityBaseRef: baseRef,
      attemptFamily: null,
      attemptId: null,
      commandId: null,
      agentId: null,
      commandKind: null,
      logicalAssignmentId: 'la-build-1',
      reviewAssignmentId: null,
      sessionKind: 'structure_chunk',
      inputArtifactDeliveryId: null,
      workItemKind: 'agent_assignment',
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session',
      roundId: null,
      grantSpecRef,
      payloadRef: specRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries: 2,
      mapBuildId,
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
    },
    intent: { handlerKind: 'lifecycle/start_task', handlerVersion: 1 },
    preparedRefs: [baseRef, specRef, grantSpecRef],
    expectedTailSequence: tail0.lastSequence,
    expectedTailCommitId: tail0.lastCommitId,
  });

  // --- Task 15: chunk + finish + finalize -> candidate + map review round ---
  const nodes = [
    nodeDecl('root'),
    nodeDecl('n1', { parentBuildNodeKey: 'root', documentOrder: 2, siblingOrder: 1 }),
    nodeDecl('n2', { parentBuildNodeKey: 'root', documentOrder: 3, siblingOrder: 2 }),
    nodeDecl('n3', { parentBuildNodeKey: 'root', documentOrder: 4, siblingOrder: 3 }),
  ];
  const resolver = (id: string, ref: BlobRefV2) => env.resolverFor(id)(ref);
  const grants = new GrantService({ resolver, readProjection: env.readProjection, profile });
  const mapBuild = new MapBuildService({
    facade: env.facade,
    grants,
    readProjection: env.readProjection,
    resolver,
    tail: (id) => env.eventStore.tail(id),
    readEvents: async (id) => (await env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
    committedOperation: async (id, operationId) =>
      (await env.eventStore.readBatchByCommitId(id, operationId))?.map((e) => e.event as AuthoritativeReviewEventV2) ?? null,
    clock: () => env.now.value,
    profile,
    profileBody: PROFILE_BODY,
    validatorRegistry: REGISTRY,
    registrationsFor: () => [completenessRegistration()],
    relationPolicy: 'optional',
    reviewPolicyDigest: hash('review-policy'),
    templateSnapshotRef: templateSnapshotRef,
    profileSnapshotRef: profileSnapshotRef,
    orchestratorRoleBinding: 'orchestrator',
    defaultAutomaticRetries: async () => 2,
  });

  const leased = await env.coordinator.leaseNext(taskId, 'worker-a', opId('lease-build-1'));
  if (leased === null) throw new Error('expected a leaseable structure_chunk workitem');
  const buildCtx: V2AttemptContext = {
    taskId,
    workItemId,
    attemptId: leased.attemptId ?? '',
    leaseEpoch: leased.leaseEpoch,
    namespace: `structured/structure_chunk/${workItemId}/${leased.attemptId}`,
    agentId: leased.leaseOwner ?? 'worker-a',
    roleBinding: 'orchestrator',
    executionKind: 'structured',
    sessionKind: 'structure_chunk',
    dispatchRef: leased.dispatchRef,
    authorityBaseRef: leased.authorityBaseRef,
    grantInstanceRef: leased.grantInstanceRef,
    inputArtifactDeliveryId: null,
    agent: null,
    currentAssignmentText: '',
    committedCheckpointText: '',
  };
  const chunkResult = await mapBuild.appendChunk(buildCtx, {
    ordinal: 1,
    expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST,
    nodes: nodes as Record<string, unknown>[],
    relations: [],
    clientOperationId: 'op-c1',
  });
  await mapBuild.finishMapBuild(buildCtx, {
    expectedChunkCount: 1,
    expectedFrontierDigest: chunkResult.frontierDigest,
    expectedRootCount: 1,
    clientOperationId: 'op-finish',
  });
  await env.coordinator.completeWorkItem({
    taskId,
    operationId: opId('complete-last'),
    workItemId,
    attemptId: buildCtx.attemptId,
    resultRefs: [chunkResult.chunkRef],
  });
  const finalizeLease = await env.coordinator.leaseNext(taskId, 'worker-a', opId('lease-finalize'));
  if (finalizeLease === null) throw new Error('expected a leaseable system_map_finalize');
  const finalizeOutcome = await mapBuild.executeMapFinalize({
    taskId,
    commandId: finalizeLease.commandId ?? '',
    workItemId: finalizeLease.workItemId,
    commandKind: 'map_finalize',
    leaseEpoch: finalizeLease.leaseEpoch,
    authorityBaseRef: finalizeLease.authorityBaseRef,
    payloadRef: specRef,
  });
  if (finalizeOutcome.kind !== 'completed') throw new Error('map finalize did not complete');

  // --- Task 16: map review -> activation ---
  const events0 = (await env.eventStore.read(taskId)).map((e) => e.event as AuthoritativeReviewEventV2);
  const roundEvent = events0.find((e) => e.type === 'structured_map_review_round_planned');
  if (roundEvent === undefined || roundEvent.type !== 'structured_map_review_round_planned') throw new Error('no map review round planned');
  const candidateEvent = events0.find((e) => e.type === 'structured_map_candidate_committed');
  if (candidateEvent === undefined || candidateEvent.type !== 'structured_map_candidate_committed') throw new Error('no candidate');

  const reviewCoordinator = new ReviewCoordinatorV2({
    coordinator: env.coordinator,
    facade: env.facade,
    resolver,
    readProjection: env.readProjection,
    readEvents: async (id) => (await env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
    profile,
    reviewPolicy: { ...REVIEW_POLICY, maxRounds },
    templateSnapshotRef: templateSnapshotRef,
    profileSnapshotRef: profileSnapshotRef,
    reviewerRoleBinding: 'reviewer',
    generatorRoleBinding: 'generator',
    orchestratorRoleBinding: 'orchestrator',
    snapshotHash: 'a'.repeat(64),
    defaultAutomaticRetries: async () => 2,
  });
  const mapReviewService = new MapReviewService({
    facade: env.facade,
    reviewCoordinator,
    readProjection: env.readProjection,
    resolver,
    tail: (id) => env.eventStore.tail(id),
    readEvents: async (id) => (await env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
    committedOperation: async (id, operationId) =>
      (await env.eventStore.readBatchByCommitId(id, operationId))?.map((e) => e.event as AuthoritativeReviewEventV2) ?? null,
    clock: () => env.now.value,
    profile,
    profileBody: PROFILE_BODY,
    validatorRegistry: REVIEW_REGISTRY,
    sourceResolver: reviewSourceResolver,
    registrationsFor: (trigger) => [
      testRegistrationFor(trigger === 'map_review_settlement' ? 'map_review_settlement' : 'map_activation', trigger === 'map_activation' ? ACTIVATION_SOURCE : SETTLEMENT_SOURCE, `v-${trigger}`),
    ],
    reviewPolicy: { ...REVIEW_POLICY, maxRounds },
    reviewPolicyDigest: hash('review-policy'),
    templateSnapshotRef: templateSnapshotRef,
    profileSnapshotRef: profileSnapshotRef,
    snapshotHash: 'a'.repeat(64),
    reviewerRoleBinding: 'reviewer',
    generatorRoleBinding: 'generator',
    orchestratorRoleBinding: 'orchestrator',
  });

  // Map review round + workitems.
  const mapRoundId = roundEvent.mapReviewRoundId;
  const candidate = (await resolver(taskId, roundEvent.candidateRef)) as { validationCoreRef: BlobRefV2 };
  const candidateCore = (await resolver(taskId, candidate.validationCoreRef)) as { nodes: { slotId: string; slotType: string; contentBearing: boolean; parentSlotId: string | null; documentOrder: number; siblingOrder: number; nodeSpecDigest: string }[]; relations: MapRelationV2[] };
  const mapPlan = planMapReview({
    nodes: candidateCore.nodes,
    relations: candidateCore.relations,
    profile,
    reviewPolicy: { ...REVIEW_POLICY, maxRounds },
    assignmentCount: roundEvent.assignmentCount,
  });
  const plannedRound = {
    mapReviewRoundId: mapRoundId,
    candidateId: roundEvent.candidateId,
    candidateDigest: roundEvent.candidateRef.digest,
    contentRevisionManifestRef: null,
    contentRootDigest: null,
    reviewPolicyDigest: hash('review-policy'),
    coverageNodeIds: candidateCore.nodes.map((n) => n.slotId),
    coverageRelationIds: candidateCore.relations.map((r) => r.relationId),
    assignmentIds: Array.from({ length: roundEvent.assignmentCount }, (_, i) => reviewAssignmentIdOf(mapRoundId, i)).concat([reviewWholeAssignmentId(mapRoundId)]),
    inheritedRecordRefs: [],
    wholeMapObservationRefs: [],
    verificationFindingStages: [],
    state: 'planned',
    settlementRef: null,
  };
  // The planned map core's finding_stage_root must have bytes on disk from
  // creation (the F1 GC regression: GC walks the planned core's child refs).
  const mapPlannedFindingStageRootRef = await env.facade.prepareBlob(
    taskId,
    'finding_stage_root',
    buildFindingStageRoot(mapRoundId, []),
  );
  const plannedCoreBody = {
    mapReviewRoundId: mapRoundId,
    candidateRef: roundEvent.candidateRef,
    contentRevisionManifestRef: null,
    contentRootDigest: null,
    reviewPolicyDigest: hash('review-policy'),
    coverageLedgerRootRefs: [] as readonly BlobRefV2[],
    wholeMapObservationRootRefs: [] as readonly BlobRefV2[],
    findingStageRootRef: mapPlannedFindingStageRootRef,
  };
  const plannedCore = { ...plannedCoreBody, coreDigest: canonicalJsonSha256(plannedCoreBody) };
  const coverageCoreRef = await env.facade.prepareBlob(taskId, 'map_review_coverage_core', plannedCore);
  const roundRef = await env.facade.prepareBlob(taskId, 'map_review_round', plannedRound);
  await reviewCoordinator.createRoundReviewWorkItems({
    taskId,
    round: plannedRound as never,
    roundRef,
    coverageCoreRef,
    mapCandidateRef: roundEvent.candidateRef,
    plan: mapPlan,
  });

  // Batch 0 freeze + whole observation + complete.
  const batchWiId = reviewBatchWorkItemId(mapRoundId, 0);
  const batchLease = await env.coordinator.leaseNext(taskId, 'worker-r', opId('lease-map-batch'));
  if (batchLease === null || batchLease.workItemId !== batchWiId) throw new Error('expected the map batch review workitem');
  const batchAttemptId = batchLease.attemptId ?? '';
  const batchTargets = [...mapPlan.batches[0].nodeIds, ...mapPlan.batches[0].relationIds];
  const baselineTargetKinds: Record<string, ReviewFactTargetKindV2> = {};
  for (const id of mapPlan.batches[0].nodeIds) baselineTargetKinds[id] = 'map_node';
  const batchRecords: ReviewDraftRecordV2[] = batchTargets.map((targetId) => ({
    op: 'submit_map_node_review',
    body: { targetId, verdict: 'pass', evidence: [], findingDrafts: [], crossScopeFindingDrafts: [] },
    at: env.now.value,
  }));
  const batchFreeze = buildReviewAssignmentFreeze({
    assignmentId: batchWiId,
    workItemId: batchWiId,
    reviewAssignmentId: reviewAssignmentIdOf(mapRoundId, 0),
    roundKind: 'map',
    roundId: mapRoundId,
    attemptId: batchAttemptId,
    reviewerAttemptId: batchAttemptId,
    reviewPolicyDigest: hash('review-policy'),
    records: batchRecords,
    verificationFindingStages: [],
    assignmentTargets: batchTargets,
    baselineTargetKinds,
    requireOrdinaryCoverage: true,
  });
  if (!batchFreeze.ok) throw new Error(`batch freeze failed: ${batchFreeze.errors.join('; ')}`);
  await mapReviewService.freezeReviewAssignment(taskId, batchFreeze.freeze);
  await env.coordinator.completeWorkItem({
    taskId,
    operationId: attemptContinuationOperationId(taskId, batchWiId, batchAttemptId, 'complete'),
    workItemId: batchWiId,
    attemptId: batchAttemptId,
    resultRefs: [refOfBlob('review_assignment_ledger', batchFreeze.freeze.ledger)],
  });
  const wholeWiId = reviewWholeWorkItemId(mapRoundId);
  const wholeLease = await env.coordinator.leaseNext(taskId, 'worker-r', opId('lease-map-whole'));
  if (wholeLease === null || wholeLease.workItemId !== wholeWiId) throw new Error('expected the map whole review workitem');
  const wholeAttemptId = wholeLease.attemptId ?? '';
  const wholeRecords: ReviewDraftRecordV2[] = [
    {
      op: 'submit_map_whole_finding',
      body: { findingDraft: { clientFindingKey: 'k-1', defectClass: 'map', severity: 'advisory', primaryLocation: { kind: 'map', id: roundEvent.candidateRef.digest }, evidence: [] }, anchoredVerdict: null },
      at: env.now.value,
    },
  ];
  const wholeFreeze = buildReviewAssignmentFreeze({
    assignmentId: wholeWiId,
    workItemId: wholeWiId,
    reviewAssignmentId: reviewWholeAssignmentId(mapRoundId),
    roundKind: 'map',
    roundId: mapRoundId,
    attemptId: wholeAttemptId,
    reviewerAttemptId: wholeAttemptId,
    reviewPolicyDigest: hash('review-policy'),
    records: wholeRecords,
    verificationFindingStages: [],
    assignmentTargets: [],
    baselineTargetKinds: {},
    requireOrdinaryCoverage: false,
  });
  if (!wholeFreeze.ok) throw new Error(`whole freeze failed: ${wholeFreeze.errors.join('; ')}`);
  await mapReviewService.freezeReviewAssignment(taskId, wholeFreeze.freeze);
  await env.coordinator.completeWorkItem({
    taskId,
    operationId: attemptContinuationOperationId(taskId, wholeWiId, wholeAttemptId, 'complete'),
    workItemId: wholeWiId,
    attemptId: wholeAttemptId,
    resultRefs: [refOfBlob('review_assignment_ledger', wholeFreeze.freeze.ledger)],
  });
  const mapAdvanced = await mapReviewService.maybeCompleteRound(taskId, mapRoundId);
  if (!mapAdvanced) throw new Error('map round did not complete');
  const mapSettlementWiId = deterministicSettlementWorkItemId(taskId, mapRoundId);
  const msLease = await env.coordinator.leaseNext(taskId, 'worker-s', opId('lease-map-settlement'));
  if (msLease === null || msLease.workItemId !== mapSettlementWiId) throw new Error('expected the map settlement workitem');
  const msEvents = (await env.eventStore.read(taskId)).map((e) => e.event as AuthoritativeReviewEventV2);
  const mapCompleted = msEvents.find((e) => e.type === 'structured_map_review_round_completed' && e.mapReviewRoundId === mapRoundId);
  if (mapCompleted === undefined || mapCompleted.type !== 'structured_map_review_round_completed') throw new Error('no map round completed');
  const mapOutcome = await mapReviewService.executeMapReviewSettlement({
    taskId,
    commandId: msLease.commandId ?? '',
    workItemId: mapSettlementWiId,
    commandKind: 'review_settlement',
    leaseEpoch: msLease.leaseEpoch,
    authorityBaseRef: msLease.authorityBaseRef,
    payloadRef: mapCompleted.coverageCoreRef,
  });
  if (mapOutcome.kind !== 'completed') throw new Error(`map settlement failed: ${mapOutcome.failureCode}`);

  // --- Task 17: real generation pipeline -> finalized manifest + round-planned ---
  const events1 = (await env.eventStore.read(taskId)).map((e) => e.event as AuthoritativeReviewEventV2);
  const activated = events1.find((e) => e.type === 'structured_map_activated');
  if (activated === undefined || activated.type !== 'structured_map_activated') throw new Error('no map activated');
  const mapSnapshotRef = activated.mapSnapshotRef;
  const snapshot = (await resolver(taskId, mapSnapshotRef)) as { mapSemanticDigest: string; nodes: { slotId: string; slotType: string; contentBearing: boolean; parentSlotId: string | null; documentOrder: number }[] };
  const baselineManifestEvent = events1.find((e) => e.type === 'structured_content_revision_committed' && e.manifestPhase === 'baseline_unset');
  if (baselineManifestEvent === undefined || baselineManifestEvent.type !== 'structured_content_revision_committed') throw new Error('no baseline manifest');
  const baselineManifestRef = baselineManifestEvent.contentRevisionManifestRef;
  const genCreated = events1.find((e) => e.type === 'structured_work_item_created' && e.sessionKind === 'generation_batch');
  if (genCreated === undefined || genCreated.type !== 'structured_work_item_created') throw new Error('no generation workitem');
  const planSpecRef = genCreated.payloadRef;
  const planSpec = (await resolver(taskId, planSpecRef)) as import('../../authoritative-review/authority-types').GenerationPlanSpecV2;
  const mapSemanticDigest = activated.mapSemanticDigest;

  const contentRegistry = new ValidatorRegistry(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES);
  const contentService = new ContentPlanService({
    facade: env.facade,
    coordinator: env.coordinator,
    grants,
    readProjection: env.readProjection,
    resolver,
    tail: (id) => env.eventStore.tail(id),
    readEvents: async (id) => (await env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
    clock: () => env.now.value,
    profile,
    profileBody: PROFILE_BODY,
    validatorRegistry: contentRegistry,
    sourceResolver: (handlerKey) => (handlerKey.startsWith('test.') ? null : builtinSourceOf(handlerKey)),
    registrationsFor: (trigger, phase) => {
      if (phase === 'batch_commit') return [contentRegistrationFor('authoritative.review.slotSchema')];
      return [contentRegistrationFor('authoritative.review.coverage')];
    },
    reviewPolicy,
    reviewPolicyDigest: hash('review-policy'),
    templateSnapshotRef: templateSnapshotRef,
    profileSnapshotRef: profileSnapshotRef,
    snapshotHash: 'a'.repeat(64),
    generatorRoleBinding: 'generator',
    reviewerRoleBinding: 'reviewer',
    slotTypes: SLOT_TYPES,
    slotTypeOf: () => 'doc',
    contentSchemaDigestOf: (slotId) => hash(`schema-${slotId}`),
    defaultAutomaticRetries: async () => 2,
  });

  // Drive every generation batch + the finalizer (Task 17 commitGenerationBatch).
  let currentWiId = genCreated.workItemId;
  for (let ordinal = 1; ordinal <= planSpec.orderedBatchSlotIds.length; ordinal++) {
    const lease = await env.coordinator.leaseNext(taskId, 'worker-g', opId(`lease-gen-${ordinal}`));
    if (lease === null || lease.workItemId !== currentWiId) throw new Error(`expected generation workitem ${ordinal}`);
    const ctx: V2AttemptContext = {
      taskId,
      workItemId: currentWiId,
      attemptId: lease.attemptId ?? '',
      leaseEpoch: lease.leaseEpoch,
      namespace: `structured/generation_batch/${currentWiId}/${lease.attemptId}`,
      agentId: lease.leaseOwner ?? 'worker-g',
      roleBinding: 'generator',
      executionKind: 'structured',
      sessionKind: 'generation_batch',
      dispatchRef: lease.dispatchRef,
      authorityBaseRef: lease.authorityBaseRef,
      grantInstanceRef: lease.grantInstanceRef,
      inputArtifactDeliveryId: null,
      agent: null,
      currentAssignmentText: '',
      committedCheckpointText: '',
    };
    const slotContents: Record<string, { text: string; mediaType: 'text/markdown' | 'text/plain' }> = {};
    for (const slotId of planSpec.orderedBatchSlotIds[ordinal - 1]) {
      slotContents[slotId] = { text: `content for ${slotId}`, mediaType: 'text/markdown' };
    }
    const outcome = await contentService.commitGenerationBatch({ taskId, workItemId: currentWiId, attemptId: ctx.attemptId, batchOrdinal: ordinal, ctx, slotContents });
    if (outcome.kind !== 'committed') throw new Error(`generation batch ${ordinal} not committed: ${JSON.stringify(outcome).slice(0, 400)}`);
    await env.coordinator.completeWorkItem({
      taskId,
      operationId: attemptContinuationOperationId(taskId, currentWiId, ctx.attemptId, 'complete'),
      workItemId: currentWiId,
      attemptId: ctx.attemptId,
      resultRefs: [outcome.manifestRef],
    });
    const genState = await env.readProjection(taskId);
    const nextWi = (() => {
      for (const w of Object.values(genState.workItems)) {
        if (w.sessionKind === 'generation_batch' && w.state === 'ready') return w.workItemId;
      }
      return null;
    })();
    if (nextWi !== null) currentWiId = nextWi;
  }
  // Run the finalizer (Task 17 executeGenerationFinalize clear).
  const finalizeWiId = generationFinalizeWorkItemId(taskId, planSpec.generationPlanId);
  const genFinalizeLease = await env.coordinator.leaseNext(taskId, 'worker-s', opId('lease-gen-finalize'));
  if (genFinalizeLease === null || genFinalizeLease.workItemId !== finalizeWiId) throw new Error('expected the generation finalize workitem');
  const manifestRef = (await env.readProjection(taskId)).currentManifest?.contentRevisionManifestRef ?? baselineManifestRef;
  const genFinalizeOutcome = await contentService.executeGenerationFinalize({
    taskId,
    commandId: genFinalizeLease.commandId ?? '',
    workItemId: finalizeWiId,
    commandKind: 'generation_finalize',
    leaseEpoch: genFinalizeLease.leaseEpoch,
    authorityBaseRef: genFinalizeLease.authorityBaseRef,
    payloadRef: manifestRef,
  });
  if (genFinalizeOutcome.kind !== 'completed') throw new Error(`generation finalize failed: ${genFinalizeOutcome.kind}`);

  // Extract the Task 17 round-planned event + finalized manifest + review workitems.
  const events2 = (await env.eventStore.read(taskId)).map((e) => e.event as AuthoritativeReviewEventV2);
  const roundPlannedEvent = events2.find((e) => e.type === 'structured_review_round_planned');
  if (roundPlannedEvent === undefined || roundPlannedEvent.type !== 'structured_review_round_planned') throw new Error('no content review round planned');
  const finalizedEvent = events2.filter((e) => e.type === 'structured_content_revision_committed' && e.manifestPhase === 'finalized').pop();
  if (finalizedEvent === undefined || finalizedEvent.type !== 'structured_content_revision_committed') throw new Error('no finalized manifest');
  const finalizedManifestRef = finalizedEvent.contentRevisionManifestRef;
  const setSlotIds = planSpec.orderedBatchSlotIds.flat();

  // Content review service.
  const adoptionService = new ReviewAdoptionService({
    facade: env.facade,
    readProjection: env.readProjection,
    resolver,
    readEvents: async (id) => (await env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
    adoptionChunkSize: 100,
  });
  const findingService = new FindingService({
    facade: env.facade,
    readProjection: env.readProjection,
    readEvents: async (id) => (await env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
    resolver,
  });
  const service = new ContentReviewService({
    facade: env.facade,
    reviewCoordinator,
    readProjection: env.readProjection,
    resolver,
    tail: (id) => env.eventStore.tail(id),
    readEvents: async (id) => (await env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
    committedOperation: async (id, operationId) =>
      (await env.eventStore.readBatchByCommitId(id, operationId))?.map((e) => e.event as AuthoritativeReviewEventV2) ?? null,
    clock: () => env.now.value,
    profile,
    profileBody: PROFILE_BODY,
    validatorRegistry: REVIEW_REGISTRY,
    sourceResolver: reviewSourceResolver,
    registrationsFor: () => [testRegistrationFor('review_settlement', CONTENT_SETTLEMENT_SOURCE, 'v-content-settlement')],
    reviewPolicy,
    reviewPolicyDigest: hash('review-policy'),
    templateSnapshotRef: templateSnapshotRef,
    profileSnapshotRef: profileSnapshotRef,
    snapshotHash: 'a'.repeat(64),
    reviewerRoleBinding: 'reviewer',
    generatorRoleBinding: 'generator',
    orchestratorRoleBinding: 'orchestrator',
    adoptionService,
    findingService,
  });

  const built: ContentReviewEnv = {
    env,
    taskId,
    service,
    coordinator: reviewCoordinator,
    resolver,
    readEvents: async (id) => (await env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
    reviewPolicyDigest: hash('review-policy'),
    roundId: roundPlannedEvent.reviewRoundId,
    finalizedManifestRef,
    setSlotIds,
    mapSnapshotRef,
    mapSemanticDigest,
    reviewPolicy,
    maxRounds,
  };
  envs.push(built);
  return built;
}

function nodeDecl(buildNodeKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    buildNodeKey,
    slotType: 'doc',
    parentBuildNodeKey: null,
    documentOrder: 1,
    siblingOrder: 0,
    contentBearing: true,
    ...overrides,
  };
}

function completenessRegistration(): ValidatorRegistrationV2 {
  const entry = AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES.find((e) => e.handlerKey === 'authoritative.review.completeness');
  if (!entry) throw new Error('no completeness entry');
  return {
    validatorId: 'v-completeness',
    handlerKey: entry.handlerKey,
    implementationDigest: entry.implementationDigest,
    implementationRef: { kind: 'builtin', moduleId: entry.moduleId, exportName: entry.exportName },
    trigger: entry.trigger,
    executionPhase: entry.executionPhase,
    selector: { kind: 'all' },
    enforcement: 'blocking',
    deterministic: true,
    inputContractVersion: entry.inputContractVersion,
    outputContractVersion: entry.outputContractVersion,
    budgetProfileId: entry.budgetProfileId,
  };
}

function contentRegistrationFor(handlerKey: string): ValidatorRegistrationV2 {
  const entry = AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES.find((e) => e.handlerKey === handlerKey);
  if (!entry) throw new Error(`no builtin entry ${handlerKey}`);
  return {
    validatorId: `v-${handlerKey.split('.').pop()}`,
    handlerKey: entry.handlerKey,
    implementationDigest: entry.implementationDigest,
    implementationRef: { kind: 'builtin', moduleId: entry.moduleId, exportName: entry.exportName },
    trigger: entry.trigger,
    executionPhase: entry.executionPhase,
    selector: { kind: 'all' },
    enforcement: 'blocking',
    deterministic: true,
    inputContractVersion: entry.inputContractVersion,
    outputContractVersion: entry.outputContractVersion,
    budgetProfileId: entry.budgetProfileId,
  };
}

const SLOT_TYPES: readonly ValidatorSlotType[] = [
  { id: 'doc', name: 'Doc', description: 'd', contentPresence: 'required', contentSchema: { type: 'string', minLength: 1 } },
];

afterEach(() => {
  disposeRuntimeTestRoots();
  envs = [];
});

/* ------------------------------------------------------------------ */
/* Step 1: presence-aware coverage                                    */
/* ------------------------------------------------------------------ */

describe('presence-aware content coverage (spec §13.2 step 5 / design §11.6)', { timeout: 30_000 }, () => {
  it('set required/optional slots each require one current pass/reject fact; optional-unset gets one system absent_not_applicable', async () => {
    const b = await makeContentReviewEnv();
    const coverage = await b.service.computeRoundCoverage(b.taskId, b.finalizedManifestRef);
    expect(coverage.planable).toBe(true);
    // All slots are set (required by default): every set slot requires a reviewer fact.
    expect(coverage.setSlotIds).toEqual([...b.setSlotIds].sort());
    const reviewed = coverage.facts.filter((f) => f.disposition === 'reviewed');
    expect(reviewed).toHaveLength(b.setSlotIds.length);
    expect(coverage.facts.filter((f) => f.disposition === 'absent_not_applicable')).toHaveLength(0);
  });

  it('zero relations passes relation coverage; blocking relations are always covered, advisory only when reviewAdvisoryRelations', async () => {
    const b = await makeContentReviewEnv();
    const relations: MapRelationV2[] = [
      { relationId: 'r-1', typeId: 'rt-1', fromSlotId: 'n1', toSlotId: 'n2', attributes: {}, relationDigest: hash('r-1') },
      { relationId: 'r-2', typeId: 'rt-2', fromSlotId: 'n2', toSlotId: 'n3', attributes: {}, relationDigest: hash('r-2') },
    ];
    const isBlocking = (r: MapRelationV2): boolean => r.relationId === 'r-1';
    const withAdvisory = planContentReview({ slots: b.setSlotIds.map((slotId) => ({ slotId, documentOrder: 0, parentSlotId: null })), relations, reviewPolicy: { ...b.reviewPolicy, reviewAdvisoryRelations: true }, assignmentCount: 2, isBlocking });
    expect(withAdvisory.relationTargets).toEqual(['r-1', 'r-2']);
    const withoutAdvisory = planContentReview({ slots: b.setSlotIds.map((slotId) => ({ slotId, documentOrder: 0, parentSlotId: null })), relations, reviewPolicy: { ...b.reviewPolicy, reviewAdvisoryRelations: false }, assignmentCount: 2, isBlocking });
    expect(withoutAdvisory.relationTargets).toEqual(['r-1']);
    // Zero relations passes naturally.
    const zero = planContentReview({ slots: b.setSlotIds.map((slotId) => ({ slotId, documentOrder: 0, parentSlotId: null })), relations: [], reviewPolicy: b.reviewPolicy, assignmentCount: 1 });
    expect(zero.relationTargets).toEqual([]);
  });

  it('required-unset/rewrite_required makes the round UNPLANABLE (route to repair before review)', async () => {
    const b = await makeContentReviewEnv();
    // Fabricate a manifest whose entry version is unset required / rewrite_required.
    const manifest = (await b.resolver(b.taskId, b.finalizedManifestRef)) as ContentRevisionManifestV2;
    const unsetVersion: SlotContentVersionV2 = {
      state: 'unset',
      slotId: 'n1',
      slotRevision: 1,
      taskContentRevision: 2,
      mapRef: b.mapSnapshotRef,
      mapSemanticDigest: b.mapSemanticDigest,
      contentSchemaDigest: canonicalJsonSha256({ slotType: 'doc' }),
      unsetReason: 'initial',
      unsetProvenance: { kind: 'created_empty' },
    };
    const unsetRef = await b.env.facade.prepareBlob(b.taskId, 'content_version', unsetVersion);
    const brokenBody = { ...manifest, entries: [{ slotId: 'n1', versionRef: unsetRef }] };
    const { manifestDigest: _md, ...brokenBodyNoDigest } = brokenBody;
    void _md;
    const brokenManifest: ContentRevisionManifestV2 = { ...brokenBodyNoDigest, manifestDigest: canonicalJsonSha256(brokenBodyNoDigest) };
    const brokenRef = await b.env.facade.prepareBlob(b.taskId, 'content_revision_manifest', brokenManifest);
    const coverage = await b.service.computeRoundCoverage(b.taskId, brokenRef);
    expect(coverage.planable).toBe(false);
    expect(coverage.unplanableReasons.some((r) => r.includes('required slot') && r.includes('unset'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Step 3: whole-tree observation                                     */
/* ------------------------------------------------------------------ */

describe('whole-tree observation (spec §13.2 step 7 / design §12.6)', { timeout: 30_000 }, () => {
  async function completeBatchAssignments(b: ContentReviewEnv): Promise<void> {
    const events = await b.readEvents(b.taskId);
    const planned = events.find((e) => e.type === 'structured_review_round_planned' && e.reviewRoundId === b.roundId);
    if (planned === undefined || planned.type !== 'structured_review_round_planned') throw new Error('no content round planned');
    const count = planned.assignmentCount;
    const manifest = (await b.resolver(b.taskId, b.finalizedManifestRef)) as ContentRevisionManifestV2;
    const plan = planContentReview({
      slots: b.setSlotIds.map((slotId) => ({ slotId, documentOrder: 0, parentSlotId: null })),
      relations: [],
      reviewPolicy: b.reviewPolicy,
      assignmentCount: count,
    });
    const done = new Set<number>();
    while (done.size < count) {
      // The coordinator's claim order sorts by (phase, roundOrdinal, workItemId)
      // — the lease order is NOT the batch index order; lease-then-match.
      const lease = await b.env.coordinator.leaseNext(b.taskId, 'worker-r', opId('lease-content-batch'));
      if (lease === null) throw new Error('expected a content batch workitem');
      let index = -1;
      for (let i = 0; i < count; i++) {
        if (reviewBatchWorkItemId(b.roundId, i) === lease.workItemId) {
          index = i;
          break;
        }
      }
      if (index === -1) throw new Error(`unexpected lease of '${lease.workItemId}'`);
      if (done.has(index)) throw new Error(`content batch workitem ${index} leased twice`);
      done.add(index);
      const workItemId = lease.workItemId;
      const attemptId = lease.attemptId ?? '';
      const batch = plan.batches[index];
      const targets = [...batch.slotIds, ...batch.relationIds];
      const baselineTargetKinds: Record<string, ReviewFactTargetKindV2> = {};
      for (const id of batch.slotIds) baselineTargetKinds[id] = 'content_slot';
      for (const id of batch.relationIds) baselineTargetKinds[id] = 'content_relation';
      const records: ReviewDraftRecordV2[] = targets.map((targetId) => ({
        op: batch.slotIds.includes(targetId) ? 'submit_slot_review' : 'submit_relation_review',
        body: { targetId, verdict: batch.slotIds.includes(targetId) ? 'pass' : 'satisfied', evidence: [], findingDrafts: [], crossScopeFindingDrafts: [] },
        at: b.env.now.value,
      }));
      const freeze = buildReviewAssignmentFreeze({
        assignmentId: workItemId,
        workItemId,
        reviewAssignmentId: reviewAssignmentIdOf(b.roundId, index),
        roundKind: 'content',
        roundId: b.roundId,
        attemptId,
        reviewerAttemptId: attemptId,
        reviewPolicyDigest: b.reviewPolicyDigest,
        records,
        verificationFindingStages: [],
        assignmentTargets: targets,
        baselineTargetKinds,
        requireOrdinaryCoverage: true,
      });
      if (!freeze.ok) throw new Error(`content batch freeze failed: ${freeze.errors.join('; ')}`);
      await b.service.freezeReviewAssignment(b.taskId, freeze.freeze);
      await b.env.coordinator.completeWorkItem({
        taskId: b.taskId,
        operationId: attemptContinuationOperationId(b.taskId, workItemId, attemptId, 'complete'),
        workItemId,
        attemptId,
        resultRefs: [refOfBlob('review_assignment_ledger', freeze.freeze.ledger)],
      });
    }
    void manifest;
  }

  async function completeWholeObservation(b: ContentReviewEnv): Promise<void> {
    const workItemId = reviewWholeWorkItemId(b.roundId);
    const lease = await b.env.coordinator.leaseNext(b.taskId, 'worker-r', opId('lease-content-whole'));
    if (lease === null || lease.workItemId !== workItemId) throw new Error('expected the content whole workitem');
    const attemptId = lease.attemptId ?? '';
    const records: ReviewDraftRecordV2[] = [
      {
        op: 'submit_whole_tree_finding',
        body: { findingDraft: { clientFindingKey: 'k-1', defectClass: 'content', severity: 'advisory', primaryLocation: { kind: 'slot', id: b.setSlotIds[0] }, evidence: [] }, anchoredVerdict: null },
        at: b.env.now.value,
      },
    ];
    const freeze = buildReviewAssignmentFreeze({
      assignmentId: workItemId,
      workItemId,
      reviewAssignmentId: reviewWholeAssignmentId(b.roundId),
      roundKind: 'content',
      roundId: b.roundId,
      attemptId,
      reviewerAttemptId: attemptId,
      reviewPolicyDigest: b.reviewPolicyDigest,
      records,
      verificationFindingStages: [],
      assignmentTargets: [],
      baselineTargetKinds: {},
      requireOrdinaryCoverage: false,
    });
    if (!freeze.ok) throw new Error(`whole freeze failed: ${freeze.errors.join('; ')}`);
    await b.service.freezeReviewAssignment(b.taskId, freeze.freeze);
    await b.env.coordinator.completeWorkItem({
      taskId: b.taskId,
      operationId: attemptContinuationOperationId(b.taskId, workItemId, attemptId, 'complete'),
      workItemId,
      attemptId,
      resultRefs: [refOfBlob('review_assignment_ledger', freeze.freeze.ledger)],
    });
  }

  it('whole-tree observation publishes layered observation events with exactly one root; no batch assignment event', async () => {
    const b = await makeContentReviewEnv();
    await completeBatchAssignments(b);
    await completeWholeObservation(b);
    const events = await b.readEvents(b.taskId);
    const observations = events.filter(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_whole_tree_observation_recorded' }> =>
        e.type === 'structured_whole_tree_observation_recorded' && e.reviewRoundId === b.roundId,
    );
    expect(observations.length).toBeGreaterThanOrEqual(1);
    const roots = observations.filter((o) => o.parentObservationId === null);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.level).toBe(1);
    // The whole session adds NO batch assignment events.
    const batchCommitted = events.filter(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_content_review_assignment_committed' }> =>
        e.type === 'structured_content_review_assignment_committed' && e.reviewRoundId === b.roundId,
    );
    expect(batchCommitted).toHaveLength(b.setSlotIds.length <= 2 ? 1 : 2);
  });

  it('the round completes only after every batch assignment + the whole-tree observation root closure; a missing whole blocks it', async () => {
    const b = await makeContentReviewEnv();
    await completeBatchAssignments(b);
    const advancedMissing = await b.service.maybeCompleteRound(b.taskId, b.roundId);
    expect(advancedMissing).toBe(false);
    await completeWholeObservation(b);
    const advanced = await b.service.maybeCompleteRound(b.taskId, b.roundId);
    expect(advanced).toBe(true);
    const events = await b.readEvents(b.taskId);
    const completed = events.find((e) => e.type === 'structured_review_round_completed' && e.reviewRoundId === b.roundId);
    expect(completed).toBeDefined();
    // The FINAL coverage core binds real ledger/observation/adoption/finding-stage roots.
    const core = (await b.resolver(b.taskId, (completed as { coverageCoreRef: BlobRefV2 }).coverageCoreRef)) as {
      coverageLedgerRootRefs: BlobRefV2[];
      wholeTreeObservationRootRefs: BlobRefV2[];
      adoptionRootRef: BlobRefV2;
      findingStageRootRef: BlobRefV2;
    };
    expect(core.coverageLedgerRootRefs.length).toBeGreaterThan(0);
    expect(core.wholeTreeObservationRootRefs.length).toBeGreaterThan(0);
    await parseBlob('content_review_coverage_core', core, (completed as { coverageCoreRef: BlobRefV2 }).coverageCoreRef);
  });
});

/* ------------------------------------------------------------------ */
/* Step 5: settlement DAG + Seal + cycle budget                       */
/* ------------------------------------------------------------------ */

describe('content settlement DAG + System Seal WorkItem', { timeout: 30_000 }, () => {
  async function settle(b: ContentReviewEnv, opts: {
    blockingFinding?: { clientFindingKey: string; defectClass: 'content' | 'map' | 'mixed'; severity: 'blocking' | 'advisory'; primaryLocation: { kind: 'slot' | 'relation' | 'map_node' | 'map'; id: string } };
    /** a slot submitted with a REJECT verdict and NO findingDrafts (F2). */
    rejectSlot?: string;
  } = {}): Promise<{ kind: string; failureCode?: string; events: readonly AuthoritativeReviewEventV2[] }> {
    const batchCount = b.setSlotIds.length <= 2 ? 1 : 2;
    const plan = planContentReview({ slots: b.setSlotIds.map((slotId) => ({ slotId, documentOrder: 0, parentSlotId: null })), relations: [], reviewPolicy: b.reviewPolicy, assignmentCount: batchCount });
    const doneBatches = new Set<number>();
    while (doneBatches.size < batchCount) {
      // The coordinator's claim order sorts by (phase, roundOrdinal, workItemId),
      // so the lease order is NOT the batch index order — lease-then-match.
      const lease = await b.env.coordinator.leaseNext(b.taskId, 'worker-r', opId('lease-settle-batch'));
      if (lease === null) throw new Error('expected a content batch workitem');
      let index = -1;
      for (let i = 0; i < batchCount; i++) {
        if (reviewBatchWorkItemId(b.roundId, i) === lease.workItemId) {
          index = i;
          break;
        }
      }
      if (index === -1) throw new Error(`unexpected lease of '${lease.workItemId}'`);
      if (doneBatches.has(index)) throw new Error(`content batch workitem ${index} leased twice`);
      doneBatches.add(index);
      const workItemId = lease.workItemId;
      const attemptId = lease.attemptId ?? '';
      const batch = plan.batches[index];
      const targets = [...batch.slotIds, ...batch.relationIds];
      const baselineTargetKinds: Record<string, ReviewFactTargetKindV2> = {};
      for (const id of batch.slotIds) baselineTargetKinds[id] = 'content_slot';
      const records: ReviewDraftRecordV2[] = targets.map((targetId) => ({
        op: 'submit_slot_review',
        body: { targetId, verdict: opts.rejectSlot === targetId ? 'reject' : 'pass', evidence: [], findingDrafts: [], crossScopeFindingDrafts: [] },
        at: b.env.now.value,
      }));
      // A blocking finding draft anchors to the FIRST assigned target (design
      // §11.3: ordinary findingDrafts belong to the verdict call).
      if (index === 0 && opts.blockingFinding !== undefined) {
        const targetId = targets[0];
        const record = records.find((r) => r.body.targetId === targetId);
        if (record !== undefined) {
          record.body.findingDrafts = [opts.blockingFinding];
        }
      }
      const freeze = buildReviewAssignmentFreeze({
        assignmentId: workItemId,
        workItemId,
        reviewAssignmentId: reviewAssignmentIdOf(b.roundId, index),
        roundKind: 'content',
        roundId: b.roundId,
        attemptId,
        reviewerAttemptId: attemptId,
        reviewPolicyDigest: b.reviewPolicyDigest,
        records,
        verificationFindingStages: [],
        assignmentTargets: targets,
        baselineTargetKinds,
        requireOrdinaryCoverage: true,
      });
      if (!freeze.ok) throw new Error(`settle batch freeze failed: ${freeze.errors.join('; ')}`);
      await b.service.freezeReviewAssignment(b.taskId, freeze.freeze);
      await b.env.coordinator.completeWorkItem({
        taskId: b.taskId,
        operationId: attemptContinuationOperationId(b.taskId, workItemId, attemptId, 'complete'),
        workItemId,
        attemptId,
        resultRefs: [refOfBlob('review_assignment_ledger', freeze.freeze.ledger)],
      });
    }
    const wholeWiId = reviewWholeWorkItemId(b.roundId);
    const wholeLease = await b.env.coordinator.leaseNext(b.taskId, 'worker-r', opId('lease-settle-whole'));
    if (wholeLease === null || wholeLease.workItemId !== wholeWiId) throw new Error('expected the whole workitem');
    const wholeAttemptId = wholeLease.attemptId ?? '';
    const wholeRecords: ReviewDraftRecordV2[] = [
      {
        op: 'submit_whole_tree_finding',
        body: { findingDraft: { clientFindingKey: 'wk', defectClass: 'content', severity: 'advisory', primaryLocation: { kind: 'slot', id: b.setSlotIds[0] }, evidence: [] }, anchoredVerdict: null },
        at: b.env.now.value,
      },
    ];
    const wholeFreeze = buildReviewAssignmentFreeze({
      assignmentId: wholeWiId,
      workItemId: wholeWiId,
      reviewAssignmentId: reviewWholeAssignmentId(b.roundId),
      roundKind: 'content',
      roundId: b.roundId,
      attemptId: wholeAttemptId,
      reviewerAttemptId: wholeAttemptId,
      reviewPolicyDigest: b.reviewPolicyDigest,
      records: wholeRecords,
      verificationFindingStages: [],
      assignmentTargets: [],
      baselineTargetKinds: {},
      requireOrdinaryCoverage: false,
    });
    if (!wholeFreeze.ok) throw new Error(`whole freeze failed: ${wholeFreeze.errors.join('; ')}`);
    await b.service.freezeReviewAssignment(b.taskId, wholeFreeze.freeze);
    await b.env.coordinator.completeWorkItem({
      taskId: b.taskId,
      operationId: attemptContinuationOperationId(b.taskId, wholeWiId, wholeAttemptId, 'complete'),
      workItemId: wholeWiId,
      attemptId: wholeAttemptId,
      resultRefs: [refOfBlob('review_assignment_ledger', wholeFreeze.freeze.ledger)],
    });
    const advanced = await b.service.maybeCompleteRound(b.taskId, b.roundId);
    if (!advanced) throw new Error('round did not advance');
    const settlementWiId = deterministicContentSettlementWorkItemId(b.taskId, b.roundId);
    const lease = await b.env.coordinator.leaseNext(b.taskId, 'worker-s', opId('lease-content-settlement'));
    if (lease === null || lease.workItemId !== settlementWiId) throw new Error('expected the content settlement workitem');
    const events = await b.readEvents(b.taskId);
    const completed = events.find((e) => e.type === 'structured_review_round_completed' && e.reviewRoundId === b.roundId);
    if (completed === undefined || completed.type !== 'structured_review_round_completed') throw new Error('no content round completed');
    const outcome = await b.service.executeContentReviewSettlement({
      taskId: b.taskId,
      commandId: lease.commandId ?? '',
      workItemId: settlementWiId,
      commandKind: 'review_settlement',
      leaseEpoch: lease.leaseEpoch,
      authorityBaseRef: lease.authorityBaseRef,
      payloadRef: completed.coverageCoreRef,
    });
    return { kind: outcome.kind, failureCode: outcome.kind === 'retryable_failure' ? outcome.failureCode : undefined, events: await b.readEvents(b.taskId) };
  }

  it('clear creates the acyclic DAG (coverage core -> aggregate -> settlement core -> ReviewBundle) + a System Seal WorkItem', async () => {
    const b = await makeContentReviewEnv();
    const result = await settle(b);
    expect(result.kind).toBe('completed');
    const events = result.events;
    const settled = events.find((e) => e.type === 'structured_review_round_settled' && e.reviewRoundId === b.roundId);
    expect(settled).toBeDefined();
    expect((settled as { outcome: string }).outcome).toBe('seal');
    const sealCreated = events.find((e) => e.type === 'structured_work_item_created' && e.kind === 'system_seal');
    expect(sealCreated).toBeDefined();
    const sealWiId = (sealCreated as { workItemId: string }).workItemId;
    expect(sealWiId).toBe(deterministicSealWorkItemId(b.taskId, b.roundId));
    // The Seal WorkItem authority base binds mapRef + mapReviewBundleRef + manifest + reviewBundle.
    const sealAuthorityBaseRef = (sealCreated as { authorityBaseRef: BlobRefV2 }).authorityBaseRef;
    const sealBase = (await b.resolver(b.taskId, sealAuthorityBaseRef)) as { mapRef: BlobRefV2; mapReviewBundleRef: BlobRefV2; contentRevisionManifestRef: BlobRefV2; reviewBundleRef: BlobRefV2 };
    expect(sealBase.mapRef.digest).toBe(b.mapSnapshotRef.digest);
    expect(sealBase.contentRevisionManifestRef.digest).toBe(b.finalizedManifestRef.digest);
    expect(sealBase.reviewBundleRef.kind).toBe('review_bundle');
    // DAG acyclic + exact-ref bound.
    const settledEvent = settled as { settlementCoreRef: BlobRefV2 };
    const settlementCore = (await b.resolver(b.taskId, settledEvent.settlementCoreRef)) as { coverageCoreRef: BlobRefV2; reviewSettlementValidatorAggregateRef: BlobRefV2 };
    expect(settlementCore.coverageCoreRef.kind).toBe('content_review_coverage_core');
    const roundCompleted = events.find((e) => e.type === 'structured_review_round_completed' && e.reviewRoundId === b.roundId);
    expect(settlementCore.coverageCoreRef.digest).toBe((roundCompleted as { coverageCoreRef: BlobRefV2 }).coverageCoreRef.digest);
    const bundle = (await b.resolver(b.taskId, sealBase.reviewBundleRef)) as { settlementCoreRef: BlobRefV2; mapRef: BlobRefV2; contentRevisionManifestRef: BlobRefV2; bundleDigest: string };
    expect(bundle.settlementCoreRef.digest).toBe(settledEvent.settlementCoreRef.digest);
    await parseBlob('review_bundle', bundle, sealBase.reviewBundleRef);
  });

  it('a blocking Finding creates repair, NEVER a Seal WorkItem', async () => {
    const b = await makeContentReviewEnv();
    const result = await settle(b, {
      blockingFinding: {
        clientFindingKey: 'bk',
        defectClass: 'content',
        severity: 'blocking',
        primaryLocation: { kind: 'slot', id: b.setSlotIds[0] },
      },
    });
    expect(result.kind).toBe('retryable_failure');
    expect(result.failureCode).toBe('CONTENT_REVIEW_BLOCKED');
    const after = result.events;
    expect(after.some((e) => e.type === 'structured_work_item_created' && e.kind === 'system_seal')).toBe(false);
    expect(after.some((e) => e.type === 'structured_review_round_settled' && e.reviewRoundId === b.roundId)).toBe(false);
    // The freeze emitted `structured_finding_opened` for the materialized draft
    // (design §11.8: the opening payload is an append-only fact).
    const opened = after.find((e) => e.type === 'structured_finding_opened');
    expect(opened).toBeDefined();
  });

  it('F2: a REJECT verdict with NO findingDrafts blocks settlement (CONTENT_REVIEW_BLOCKED, no Seal) — the §16.1 gate runs before the validator', async () => {
    const b = await makeContentReviewEnv();
    const result = await settle(b, { rejectSlot: b.setSlotIds[0] });
    expect(result.kind).toBe('retryable_failure');
    expect(result.failureCode).toBe('CONTENT_REVIEW_BLOCKED');
    const after = result.events;
    expect(after.some((e) => e.type === 'structured_work_item_created' && e.kind === 'system_seal')).toBe(false);
    expect(after.some((e) => e.type === 'structured_review_round_settled' && e.reviewRoundId === b.roundId)).toBe(false);
  });

  it('GC succeeds — the planned map + content coverage cores bound finding_stage_root refs always have bytes on disk', async () => {
    const b = await makeContentReviewEnv();
    // Complete the round (batch + whole + settlement) so the FINAL coverage
    // core + settlement + seal blobs are event-rooted too.
    const settled = await settle(b);
    expect(settled.kind).toBe('completed');
    const { AuthoritativeReviewGc } = await import('../../storage/authoritative-review-gc');
    const gc = new AuthoritativeReviewGc(b.env.paths, b.env.blobStore, b.env.eventStore, b.env.publicationStore, {});
    // GC mark walks every event child ref (incl. authority_base_set ->
    // planned coverage core -> finding_stage_root). Before the F1 fix this
    // threw TASK_CORRUPTED on the fabricated finding_stage_root ref.
    await expect(gc.run()).resolves.toBeDefined();
    // Both the map and content review WorkItem authority bases bound a planned    // Both the map and content review WorkItem authority bases bound a planned
    // coverage core whose finding_stage_root ref now resolves to bytes.
    const events = await b.readEvents(b.taskId);
    for (const sessionKind of ['review_map_batch', 'review_content_batch'] as const) {
      const wiEvent = events.find(
        (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_work_item_created' }> =>
          e.type === 'structured_work_item_created' && e.sessionKind === sessionKind,
      );
      if (wiEvent === undefined) continue;
      const base = (await b.resolver(b.taskId, wiEvent.authorityBaseRef)) as { reviewCoverageCoreRef: BlobRefV2 };
      const core = (await b.resolver(b.taskId, base.reviewCoverageCoreRef)) as { findingStageRootRef: BlobRefV2 };
      const root = (await b.resolver(b.taskId, core.findingStageRootRef)) as { rootId: string } | null;
      expect(root).not.toBeNull();
      expect(root?.rootId).toMatch(/^fsr-[0-9a-f]{24}$/);
    }
  });
});

describe('content cycle budget (spec §13.3.1)', { timeout: 30_000 }, () => {
  it('round creation increments contentCycleOrdinal exactly once; maxRounds-1/max are legal, maxRounds+1 over-limit is rejected', async () => {
    const b = await makeContentReviewEnv({ maxRounds: 2 });
    // After the initial round (cycle 1), a successor round (cycle 2) is legal at
    // maxRounds=2; a third (cycle 3) is over-limit.
    const round2 = await b.service.planContentReviewRound({ taskId: b.taskId, finalizedManifestRef: b.finalizedManifestRef, setSlotIds: b.setSlotIds, overrideRef: null });
    expect(round2.created).toBe(true);
    expect(round2.round?.contentCycleOrdinal).toBe(2);
    await expect(
      b.service.planContentReviewRound({ taskId: b.taskId, finalizedManifestRef: b.finalizedManifestRef, setSlotIds: b.setSlotIds, overrideRef: null }),
    ).rejects.toBeInstanceOf(ReviewRepairLimitExceededError);
  });

  it('an exact available Content RoundBudgetOverrideV2 is consumed once; wrong/preconsumed override rejects', async () => {
    const overrideRef = refOfBlob('round_budget_override', { overrideId: 'ov-1', track: 'content' });
    const available = { ref: overrideRef, track: 'content' as const };
    // Over-limit with the EXACT available content override is legal.
    expect(() => contentRoundBudgetCheck({ nextOrdinal: 2, maxRounds: 1, availableOverride: available, overrideRef })).not.toThrow();
    // Without the override the over-limit round is rejected.
    expect(() => contentRoundBudgetCheck({ nextOrdinal: 2, maxRounds: 1, availableOverride: available, overrideRef: null })).toThrow(ReviewRepairLimitExceededError);
    // Wrong track / preconsumed (no available) / wrong ref all reject.
    expect(() => contentRoundBudgetCheck({ nextOrdinal: 2, maxRounds: 1, availableOverride: { ref: overrideRef, track: 'map' }, overrideRef })).toThrow(/no exact available content/);
    expect(() => contentRoundBudgetCheck({ nextOrdinal: 2, maxRounds: 1, availableOverride: null, overrideRef })).toThrow(/no exact available content/);
    const otherRef = refOfBlob('round_budget_override', { overrideId: 'ov-2' });
    expect(() => contentRoundBudgetCheck({ nextOrdinal: 2, maxRounds: 1, availableOverride: available, overrideRef: otherRef })).toThrow(/no exact available content/);
    // A within-budget round never consults the override.
    expect(() => contentRoundBudgetCheck({ nextOrdinal: 1, maxRounds: 1, availableOverride: null, overrideRef: null })).not.toThrow();
  });

  it('F5: planContentReviewRound rejects a required-unset/rewrite_required manifest BEFORE preparing any blob (zero writes)', async () => {
    const b = await makeContentReviewEnv({ maxRounds: 8 });
    // Fabricate a manifest whose entry version is unset required.
    const manifest = (await b.resolver(b.taskId, b.finalizedManifestRef)) as ContentRevisionManifestV2;
    const unsetVersion: SlotContentVersionV2 = {
      state: 'unset',
      slotId: b.setSlotIds[0],
      slotRevision: 1,
      taskContentRevision: 2,
      mapRef: b.mapSnapshotRef,
      mapSemanticDigest: b.mapSemanticDigest,
      contentSchemaDigest: canonicalJsonSha256({ slotType: 'doc' }),
      unsetReason: 'initial',
      unsetProvenance: { kind: 'created_empty' },
    };
    const unsetRef = await b.env.facade.prepareBlob(b.taskId, 'content_version', unsetVersion);
    const brokenBody = { ...manifest, entries: [{ slotId: b.setSlotIds[0], versionRef: unsetRef }] };
    const { manifestDigest: _md, ...brokenBodyNoDigest } = brokenBody;
    void _md;
    const brokenManifest: ContentRevisionManifestV2 = { ...brokenBodyNoDigest, manifestDigest: canonicalJsonSha256(brokenBodyNoDigest) };
    const brokenRef = await b.env.facade.prepareBlob(b.taskId, 'content_revision_manifest', brokenManifest);
    const before = (await b.env.eventStore.read(b.taskId)).length;
    await expect(
      b.service.planContentReviewRound({ taskId: b.taskId, finalizedManifestRef: brokenRef, setSlotIds: b.setSlotIds, overrideRef: null }),
    ).rejects.toThrow(/cannot be planned/);
    // Zero writes: no round-planned event, no new blobs, no cycle ordinal burned.
    const after = (await b.env.eventStore.read(b.taskId)).length;
    expect(after).toBe(before);
    expect((await b.env.readProjection(b.taskId)).contentCycleOrdinal).toBe(1);
  });
});


describe('contentRoundShape + coverage core (pure builders)', () => {
  it('contentRoundShape produces a parse-consistent ReviewRoundV2 shape', () => {
    const mapRef = refOfBlob('map_snapshot', { mapId: 'map-1' });
    const manifestRef = refOfBlob('content_revision_manifest', { manifestId: 'm-1' });
    const round = contentRoundShape({
      reviewRoundId: 'cr-1',
      mapRef,
      mapSemanticDigest: 'd',
      contentRevisionManifestRef: manifestRef,
      contentRootDigest: 'r',
      reviewPolicyDigest: 'p',
      coverageSlotIds: ['s-1'],
      coverageRelationIds: [],
      assignmentSlotIds: ['s-1'],
      assignmentRelationIds: [],
      assignmentIds: ['rev-1'],
      verificationFindingStages: [],
    });
    expect(round.reviewRoundId).toBe('cr-1');
    expect(round.state).toBe('reviewing_batches');
    expect(round.verificationFindingStages).toEqual([]);
  });

  it('buildContentReviewCoverageCore computes a deterministic coreDigest over the body', () => {
    const mapRef = refOfBlob('map_snapshot', { mapId: 'map-1' });
    const manifestRef = refOfBlob('content_revision_manifest', { manifestId: 'm-1' });
    const adoptionRef = refOfBlob('review_adoption_root', { roundId: 'cr-1' });
    const fsrRef = refOfBlob('finding_stage_root', { roundId: 'cr-1' });
    const core = buildContentReviewCoverageCore({
      reviewRoundId: 'cr-1',
      mapRef,
      contentRevisionManifestRef: manifestRef,
      reviewPolicyDigest: 'p',
      coverageLedgerRootRefs: [],
      adoptionRootRef: adoptionRef,
      wholeTreeObservationRootRefs: [],
      findingStageRootRef: fsrRef,
    });
    const body = {
      reviewRoundId: 'cr-1',
      mapRef,
      contentRevisionManifestRef: manifestRef,
      reviewPolicyDigest: 'p',
      coverageLedgerRootRefs: [],
      adoptionRootRef: adoptionRef,
      wholeTreeObservationRootRefs: [],
      findingStageRootRef: fsrRef,
    };
    expect(core.coreDigest).toBe(canonicalJsonSha256(body));
  });

  it('contentReviewRoundId is deterministic from taskId/ordinal/manifest ref', () => {
    const manifestRef = refOfBlob('content_revision_manifest', { manifestId: 'm-1' });
    const a = contentReviewRoundId('t', 1, manifestRef);
    const b = contentReviewRoundId('t', 1, manifestRef);
    expect(a).toBe(b);
    expect(contentReviewRoundId('t', 2, manifestRef)).not.toBe(a);
  });
});
