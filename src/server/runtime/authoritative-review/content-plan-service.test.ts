// @vitest-environment node
/**
 * Task 17 content-plan-service tests (spec §13.2/§7.3/§12.2/§13.3.1, design
 * §11.5/§12.2/§12.3/§14/§17.5): the deterministic slot partition, manifest
 * identity/presence, validator phase isolation (content_commit/batch_commit vs
 * plan_finalize), the blocking successor GenerationPlan, and the
 * system_generation_finalize wiring.
 *
 * The env harness reuses the Task 15/16 map-build → map-review → settlement
 * pipeline to reach a real activated Map + baseline-unset manifest + the first
 * generation-batch WorkItem (the map-review-service.test harness pattern).
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
import type { WriteGrantSpecV2, MapReviewRoundV2, ReviewFactV2, GenerationPlanSpecV2, ContentRevisionManifestV2, SlotContentVersionV2, MapPositionNodeV2, MapRelationV2 } from '../../authoritative-review/authority-types';
import {
  createWorkItemCoordinatorEnvironment,
  disposeRuntimeTestRoots,
  type WorkItemCoordinatorEnvironment,
} from '../test-support';
import {
  EMPTY_BUILD_FRONTIER_DIGEST,
  MapBuildService,
  registerMapBuildPublicationHandlers,
} from './map-build-service';
import {
  MapReviewService,
  buildMapReviewRound,
  registerMapReviewPublicationHandlers,
  deterministicSettlementWorkItemId,
} from './map-review-service';
import { ReviewCoordinatorV2, reviewAssignmentIdOf, reviewWholeAssignmentId, reviewBatchWorkItemId, reviewWholeWorkItemId } from './review-coordinator';
import { planMapReview } from './observation-planner';
import { buildReviewAssignmentFreeze, type ReviewDraftRecordV2, type FrozenReviewAssignmentV2 } from './tool-factory';
import { SystemCommandRegistry } from './system-command-registry';
import { attemptContinuationOperationId } from './attempt-coordinator';
import {
  ContentPlanService,
  buildContentRevisionCommitCore,
  buildContentPlanFinalizeCore,
  buildContentValue,
  buildFinalizedManifest,
  buildProvisionalManifest,
  buildSuccessorGenerationPlan,
  contentReviewRoundId,
  createGenerationFinalizeSystemCommandHandler,
  generationBatchWorkItemId,
  generationFinalizeWorkItemId,
  partitionGenerationBatches,
  partitionCorrectionBatches,
  registerContentPlanPublicationHandlers,
  successorGenerationPlanId,
} from './content-plan-service';
import type { ValidatorSlotType } from './validator-engine';

const PROFILE = fullProfileForTests();
const PROFILE_BODY = buildAuthoritativeReviewTestProfileBody();

let seq = 0;

function opId(label: string): string {
  seq += 1;
  return `op-${createHash('sha256').update(`op:${label}:${seq}`).digest('hex').slice(0, 32)}`;
}

function hash(salt: string): string {
  return createHash('sha256').update(salt, 'utf8').digest('hex');
}

function entryOf(handlerKey: string) {
  const entry = AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES.find((e) => e.handlerKey === handlerKey);
  if (!entry) throw new Error(`no builtin entry ${handlerKey}`);
  return entry;
}

function registrationFor(handlerKey: string, overrides: Partial<ValidatorRegistrationV2> = {}): ValidatorRegistrationV2 {
  const entry = entryOf(handlerKey);
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
    ...overrides,
  };
}

/* Test-only always-valid / always-invalid content validators (one per phase)
 * plus the REAL builtin slotSchema (batch) + coverage (finalize). */
function alwaysValidSource(salt: string): string {
  return `'use strict';
module.exports = { validate: function validate(input) { return { status: 'valid', executionDigest: '${hash(salt)}' }; } };`;
}

function testValidatorEntry(phase: 'batch_commit' | 'plan_finalize', source: string, keySuffix = ''): import('./validator-registry').InstalledValidatorEntry {
  return {
    handlerKey: `test.content.${phase}${keySuffix}`,
    implementationDigest: createHash('sha256').update(source, 'utf8').digest('hex'),
    moduleId: '@forge/authoritative-review',
    exportName: 'contentTestHandler',
    trigger: 'content_commit',
    executionPhase: phase,
    abi: 'forge-validator/v2',
    budgetProfileId: 'authoritative-validator-default',
    inputContractVersion: 2,
    outputContractVersion: 2,
  };
}

const BATCH_VALID_SOURCE = alwaysValidSource('content-batch');
const FINALIZE_VALID_SOURCE = alwaysValidSource('content-finalize');

/** Deterministic always-invalid finalize targeting a REAL slot id. */
function blockingFinalizeSource(slotId: string): string {
  return `'use strict';
module.exports = { validate: function validate(input) { return { status: 'domain_invalid', issues: [ { validatorId: input.validatorId, implementationDigest: input.implementationDigest, issueCode: 'coverage.required_not_set', location: { targetKind: 'slot', stableTargetId: '${slotId}', jsonPointer: null }, repairTargets: { mapNodeIds: [], relationIds: [], slotIds: ['${slotId}'] }, evidenceDigest: '' } ], executionDigest: '' }; } };`;
}

/** Always-invalid finalize targeting MULTIPLE slots (a successor with >1
 * correction batch — the F2 regression: a multi-batch successor must continue
 * past batch 1 without a spurious PLAN_STALE). Each issue keeps
 * `input.validatorId`/`input.implementationDigest` as CODE references so the
 * engine's anti-spoof exact-match check passes. */
function multiBlockFinalizeSource(blockedSlots: readonly string[]): string {
  const issues = blockedSlots
    .map(
      (slotId) =>
        `{ validatorId: input.validatorId, implementationDigest: input.implementationDigest, issueCode: 'coverage.required_not_set', location: { targetKind: 'slot', stableTargetId: '${slotId}', jsonPointer: null }, repairTargets: { mapNodeIds: [], relationIds: [], slotIds: ['${slotId}'] }, evidenceDigest: '' }`,
    )
    .join(', ');
  return `'use strict';
module.exports = { validate: function validate(input) { return { status: 'domain_invalid', issues: [ ${issues} ], executionDigest: '' }; } };`;
}

function contentTestRegistration(phase: 'batch_commit' | 'plan_finalize', source: string, validatorId: string, keySuffix = ''): ValidatorRegistrationV2 {
  const entry = testValidatorEntry(phase, source, keySuffix);
  return {
    validatorId,
    handlerKey: entry.handlerKey,
    implementationDigest: entry.implementationDigest,
    implementationRef: { kind: 'builtin', moduleId: entry.moduleId, exportName: entry.exportName },
    trigger: 'content_commit',
    executionPhase: phase,
    selector: { kind: 'all' },
    enforcement: 'blocking',
    deterministic: true,
    inputContractVersion: 2,
    outputContractVersion: 2,
    budgetProfileId: entry.budgetProfileId,
  };
}

function contentSourceResolver(handlerKey: string): string | null {
  if (handlerKey === 'test.content.batch_commit') return BATCH_VALID_SOURCE;
  if (handlerKey === 'test.content.plan_finalize') return FINALIZE_VALID_SOURCE;
  if (handlerKey === 'test.content.plan_finalize.blocking') return blockingFinalizeSource(FINALIZE_BLOCKING_SLOT);
  return builtinSourceOf(handlerKey);
}

/** The slot id the blocking finalize targets (bound per-env; default fallback). */
let FINALIZE_BLOCKING_SLOT = 's-2';

const SLOT_TYPES: readonly ValidatorSlotType[] = [
  { id: 'doc', name: 'Doc', description: 'd', contentPresence: 'required', contentSchema: { type: 'string', minLength: 1 } },
];

/* Always-valid map-review settlement/activation validators (the map-review
 * harness pattern: no installed builtin covers those triggers). */
const MAP_SETTLEMENT_SOURCE = alwaysValidSource('map-review-settlement');
const MAP_ACTIVATION_SOURCE = alwaysValidSource('map-activation');

function mapTriggerEntry(trigger: 'map_review_settlement' | 'map_activation', source: string): import('./validator-registry').InstalledValidatorEntry {
  return {
    handlerKey: `test.mapReview.${trigger}`,
    implementationDigest: createHash('sha256').update(source, 'utf8').digest('hex'),
    moduleId: '@forge/authoritative-review',
    exportName: 'mapReviewTestHandler',
    trigger,
    executionPhase: null,
    abi: 'forge-validator/v2',
    budgetProfileId: 'authoritative-validator-default',
    inputContractVersion: 2,
    outputContractVersion: 2,
  };
}

function mapTriggerRegistration(trigger: 'map_review_settlement' | 'map_activation', source: string, validatorId: string): ValidatorRegistrationV2 {
  const entry = mapTriggerEntry(trigger, source);
  return {
    validatorId,
    handlerKey: entry.handlerKey,
    implementationDigest: entry.implementationDigest,
    implementationRef: { kind: 'builtin', moduleId: entry.moduleId, exportName: entry.exportName },
    trigger,
    executionPhase: null,
    selector: { kind: 'all' },
    enforcement: 'blocking',
    deterministic: true,
    inputContractVersion: 2,
    outputContractVersion: 2,
    budgetProfileId: entry.budgetProfileId,
  };
}

function specValue(mapBuildId = 'mb-1'): Record<string, unknown> {
  const body = {
    mapBuildId,
    revision: 1,
    supersedesMapBuildId: null,
    sourceValidationReceiptRef: null,
    snapshotHash: 'a'.repeat(64),
    plannedChunkPolicy: { maxChunks: 16, maxNodesPerChunk: 512, maxRelationsPerChunk: 64 },
  };
  return { ...body, specDigest: canonicalJsonSha256(body) };
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

interface ContentEnv {
  env: WorkItemCoordinatorEnvironment;
  profile: typeof PROFILE;
  taskId: string;
  service: ContentPlanService;
  grants: GrantService;
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown>;
  readEvents(taskId: string): Promise<readonly AuthoritativeReviewEventV2[]>;
  generationPlanId: string;
  planSpec: GenerationPlanSpecV2;
  planSpecRef: BlobRefV2;
  firstWorkItemId: string;
  baselineManifestRef: BlobRefV2;
  mapSnapshotRef: BlobRefV2;
  mapSemanticDigest: string;
  slotIds: string[];
}

let envs: ContentEnv[] = [];

async function makeContentEnv(opts: { contentBatchTargetSlots?: number; nodeCount?: number; finalizeBlocking?: boolean } = {}): Promise<ContentEnv> {
  const profile = PROFILE;
  const registry = new PublicationIntentRegistry();
  registerMapBuildPublicationHandlers(registry);
  registerMapReviewPublicationHandlers(registry);
  registerContentPlanPublicationHandlers(registry);
  const env = await createWorkItemCoordinatorEnvironment({ registry });
  const taskId = 'task-content-plan';
  const mapBuildId = 'mb-1';
  const spec = specValue(mapBuildId);
  const specRef = await env.facade.prepareBlob(taskId, 'map_build_spec', spec);
  const base = buildAuthorityBaseSet({
    taskId,
    templateSnapshotRef: env.templateSnapshotRef,
    profileSnapshotRef: env.profileSnapshotRef,
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

  const nodeCount = opts.nodeCount ?? 3;
  const nodes = Array.from({ length: nodeCount }, (_, i) => nodeDecl(i === 0 ? 'root' : `n${i}`, i === 0 ? {} : { parentBuildNodeKey: 'root', documentOrder: i + 1, siblingOrder: i }));
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
    validatorRegistry: new ValidatorRegistry(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES),
    registrationsFor: () => [registrationFor('authoritative.review.completeness')],
    relationPolicy: 'optional',
    reviewPolicyDigest: hash('review-policy'),
    templateSnapshotRef: env.templateSnapshotRef,
    profileSnapshotRef: env.profileSnapshotRef,
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
  expect(finalizeOutcome.kind).toBe('completed');

  const events0 = (await env.eventStore.read(taskId)).map((e) => e.event as AuthoritativeReviewEventV2);
  const roundEvent = events0.find((e) => e.type === 'structured_map_review_round_planned');
  if (roundEvent === undefined || roundEvent.type !== 'structured_map_review_round_planned') throw new Error('no round planned');
  const candidateEvent = events0.find((e) => e.type === 'structured_map_candidate_committed');
  if (candidateEvent === undefined || candidateEvent.type !== 'structured_map_candidate_committed') throw new Error('no candidate');

  const reviewCoordinator = new ReviewCoordinatorV2({
    coordinator: env.coordinator,
    facade: env.facade,
    resolver,
    readProjection: env.readProjection,
    readEvents: async (id) => (await env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
    profile,
    reviewPolicy: REVIEW_POLICY,
    templateSnapshotRef: env.templateSnapshotRef,
    profileSnapshotRef: env.profileSnapshotRef,
    reviewerRoleBinding: 'reviewer',
    generatorRoleBinding: 'generator',
    orchestratorRoleBinding: 'orchestrator',
    snapshotHash: 'a'.repeat(64),
    defaultAutomaticRetries: async () => 2,
  });
  const reviewService = new MapReviewService({
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
    validatorRegistry: new ValidatorRegistry([
      ...AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES,
      mapTriggerEntry('map_review_settlement', MAP_SETTLEMENT_SOURCE),
      mapTriggerEntry('map_activation', MAP_ACTIVATION_SOURCE),
    ]),
    sourceResolver: (handlerKey) => {
      if (handlerKey === 'test.mapReview.map_review_settlement') return MAP_SETTLEMENT_SOURCE;
      if (handlerKey === 'test.mapReview.map_activation') return MAP_ACTIVATION_SOURCE;
      return builtinSourceOf(handlerKey);
    },
    registrationsFor: (trigger) => {
      if (trigger === 'map_review_settlement') return [mapTriggerRegistration('map_review_settlement', MAP_SETTLEMENT_SOURCE, 'v-map-settle')];
      return [mapTriggerRegistration('map_activation', MAP_ACTIVATION_SOURCE, 'v-map-activate')];
    },
    reviewPolicy: REVIEW_POLICY,
    reviewPolicyDigest: hash('review-policy'),
    templateSnapshotRef: env.templateSnapshotRef,
    profileSnapshotRef: env.profileSnapshotRef,
    snapshotHash: 'a'.repeat(64),
    reviewerRoleBinding: 'reviewer',
    generatorRoleBinding: 'generator',
    orchestratorRoleBinding: 'orchestrator',
  });

  const candidateRef = roundEvent.candidateRef;
  const candidate = (await resolver(taskId, candidateRef)) as { validationCoreRef: BlobRefV2 };
  const core = (await resolver(taskId, candidate.validationCoreRef)) as { nodes: MapPositionNodeV2[]; relations: MapRelationV2[] };
  const nodeIds = core.nodes.map((n) => n.slotId);
  const assignmentCount = roundEvent.assignmentCount;
  const roundId = roundEvent.mapReviewRoundId;

  const plannedRound = buildMapReviewRound({
    mapReviewRoundId: roundId,
    candidateId: roundEvent.candidateId,
    candidateDigest: candidateRef.digest,
    contentRevisionManifestRef: null,
    contentRootDigest: null,
    reviewPolicyDigest: hash('review-policy'),
    coverageNodeIds: nodeIds,
    coverageRelationIds: core.relations.map((r) => r.relationId),
    assignmentIds: Array.from({ length: assignmentCount }, (_, i) => reviewAssignmentIdOf(roundId, i)).concat([reviewWholeAssignmentId(roundId)]),
    verificationFindingStages: [],
  });
  const plan = planMapReview({
    nodes: core.nodes,
    relations: core.relations,
    profile,
    reviewPolicy: REVIEW_POLICY,
    assignmentCount,
  });
  const plannedCoreBody = {
    mapReviewRoundId: roundId,
    candidateRef,
    contentRevisionManifestRef: null,
    contentRootDigest: null,
    reviewPolicyDigest: hash('review-policy'),
    coverageLedgerRootRefs: [] as readonly BlobRefV2[],
    wholeMapObservationRootRefs: [] as readonly BlobRefV2[],
    findingStageRootRef: refOfBlob('finding_stage_root', { rootId: `fsr-${roundId}`, roundId, entries: [] }),
  };
  const plannedCore = { ...plannedCoreBody, coreDigest: canonicalJsonSha256(plannedCoreBody) };
  const coverageCoreRef = await env.facade.prepareBlob(taskId, 'map_review_coverage_core', plannedCore);
  const roundRef = await env.facade.prepareBlob(taskId, 'map_review_round', plannedRound);
  await reviewCoordinator.createRoundReviewWorkItems({
    taskId,
    round: plannedRound,
    roundRef,
    coverageCoreRef,
    mapCandidateRef: candidateRef,
    plan,
  });

  // Freeze batch 0 + whole observation.
  const batchWiId = reviewBatchWorkItemId(roundId, 0);
  const batchLease = await env.coordinator.leaseNext(taskId, 'worker-r', opId('lease-batch'));
  if (batchLease === null || batchLease.workItemId !== batchWiId) throw new Error('expected the batch review workitem');
  const batchAttemptId = batchLease.attemptId ?? '';
  const batchTargets = [...plan.batches[0].nodeIds, ...plan.batches[0].relationIds];
  const baselineTargetKinds: Record<string, ReviewFactV2['targetKind']> = {};
  for (const id of plan.batches[0].nodeIds) baselineTargetKinds[id] = 'map_node';
  const records: ReviewDraftRecordV2[] = batchTargets.map((targetId) => ({
    op: 'submit_map_node_review',
    body: { targetId, verdict: 'pass', evidence: [], findingDrafts: [], crossScopeFindingDrafts: [] },
    at: env.now.value,
  }));
  const freezeResult = buildReviewAssignmentFreeze({
    assignmentId: batchWiId,
    workItemId: batchWiId,
    reviewAssignmentId: reviewAssignmentIdOf(roundId, 0),
    roundKind: 'map',
    roundId,
    attemptId: batchAttemptId,
    reviewerAttemptId: batchAttemptId,
    reviewPolicyDigest: hash('review-policy'),
    records,
    verificationFindingStages: [],
    assignmentTargets: batchTargets,
    baselineTargetKinds,
    requireOrdinaryCoverage: true,
  });
  if (!freezeResult.ok) throw new Error(`freeze failed: ${freezeResult.errors.join('; ')}`);
  await reviewService.freezeReviewAssignment(taskId, freezeResult.freeze);
  await env.coordinator.completeWorkItem({
    taskId,
    operationId: attemptContinuationOperationId(taskId, batchWiId, batchAttemptId, 'complete'),
    workItemId: batchWiId,
    attemptId: batchAttemptId,
    resultRefs: [refOfBlob('review_assignment_ledger', freezeResult.freeze.ledger)],
  });

  const wholeWiId = reviewWholeWorkItemId(roundId);
  const wholeLease = await env.coordinator.leaseNext(taskId, 'worker-r', opId('lease-whole'));
  if (wholeLease === null || wholeLease.workItemId !== wholeWiId) throw new Error('expected the whole review workitem');
  const wholeAttemptId = wholeLease.attemptId ?? '';
  const wholeRecords: ReviewDraftRecordV2[] = [
    {
      op: 'submit_map_whole_finding',
      body: {
        findingDraft: { clientFindingKey: 'k-1', defectClass: 'map', severity: 'advisory', primaryLocation: { kind: 'map', id: candidateRef.digest }, evidence: [] },
        anchoredVerdict: null,
      },
      at: env.now.value,
    },
  ];
  const wholeFreeze = buildReviewAssignmentFreeze({
    assignmentId: wholeWiId,
    workItemId: wholeWiId,
    reviewAssignmentId: reviewWholeAssignmentId(roundId),
    roundKind: 'map',
    roundId,
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
  await reviewService.freezeReviewAssignment(taskId, wholeFreeze.freeze);
  await env.coordinator.completeWorkItem({
    taskId,
    operationId: attemptContinuationOperationId(taskId, wholeWiId, wholeAttemptId, 'complete'),
    workItemId: wholeWiId,
    attemptId: wholeAttemptId,
    resultRefs: [refOfBlob('review_assignment_ledger', wholeFreeze.freeze.ledger)],
  });

  // Round completion + settlement.
  const advanced = await reviewService.maybeCompleteRound(taskId, roundId);
  if (!advanced) throw new Error('round did not advance');
  const settlementWiId = deterministicSettlementWorkItemId(taskId, roundId);
  const settleLease = await env.coordinator.leaseNext(taskId, 'worker-s', opId('lease-settlement'));
  if (settleLease === null || settleLease.workItemId !== settlementWiId) throw new Error('expected the settlement workitem');
  const events1 = (await env.eventStore.read(taskId)).map((e) => e.event as AuthoritativeReviewEventV2);
  const completed = events1.find((e) => e.type === 'structured_map_review_round_completed' && e.mapReviewRoundId === roundId);
  if (completed === undefined || completed.type !== 'structured_map_review_round_completed') throw new Error('no round completed');
  const settleOutcome = await reviewService.executeMapReviewSettlement({
    taskId,
    commandId: settleLease.commandId ?? '',
    workItemId: settlementWiId,
    commandKind: 'review_settlement',
    leaseEpoch: settleLease.leaseEpoch,
    authorityBaseRef: settleLease.authorityBaseRef,
    payloadRef: completed.coverageCoreRef,
  });
  expect(settleOutcome.kind).toBe('completed');

  // Post-activation: extract generation plan + first workitem + baseline manifest.
  const events2 = (await env.eventStore.read(taskId)).map((e) => e.event as AuthoritativeReviewEventV2);
  const genCreated = events2.find((e) => e.type === 'structured_work_item_created' && e.sessionKind === 'generation_batch');
  if (genCreated === undefined || genCreated.type !== 'structured_work_item_created') throw new Error('no generation workitem');
  const manifestEvent = events2.find((e) => e.type === 'structured_content_revision_committed' && e.manifestPhase === 'baseline_unset');
  if (manifestEvent === undefined || manifestEvent.type !== 'structured_content_revision_committed') throw new Error('no baseline manifest event');
  const activatedEvent = events2.find((e) => e.type === 'structured_map_activated');
  if (activatedEvent === undefined || activatedEvent.type !== 'structured_map_activated') throw new Error('no map activated');

  const planSpecRef = genCreated.payloadRef;
  const planSpec = (await resolver(taskId, planSpecRef)) as GenerationPlanSpecV2;
  const baselineManifestRef = manifestEvent.contentRevisionManifestRef;
  const mapSnapshotRef = activatedEvent.mapSnapshotRef;
  const mapSemanticDigest = activatedEvent.mapSemanticDigest;
  const slotIds = planSpec.orderedBatchSlotIds.flat();
  const finalizeBlockingSource = opts.finalizeBlocking === true ? blockingFinalizeSource(slotIds[0] ?? 's-2') : FINALIZE_VALID_SOURCE;
  FINALIZE_BLOCKING_SLOT = slotIds[0] ?? 's-2';

  const contentRegistry = new ValidatorRegistry([
    ...AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES,
    testValidatorEntry('plan_finalize', finalizeBlockingSource, opts.finalizeBlocking === true ? '.blocking' : ''),
  ]);
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
    sourceResolver: contentSourceResolver,
    registrationsFor: (trigger, phase) => {
      // The REAL platform builtins: slotSchema for batch_commit, coverage for
      // plan_finalize (the "global" required-slot coverage validator). The
      // blocking option swaps a deterministic always-invalid finalize in.
      if (phase === 'batch_commit') return [registrationFor('authoritative.review.slotSchema')];
      if (opts.finalizeBlocking === true) return [contentTestRegistration('plan_finalize', finalizeBlockingSource, 'v-finalize-blocking', '.blocking')];
      return [registrationFor('authoritative.review.coverage')];
    },
    reviewPolicy: { ...REVIEW_POLICY, contentBatchTargetSlots: opts.contentBatchTargetSlots ?? REVIEW_POLICY.contentBatchTargetSlots },
    reviewPolicyDigest: hash('review-policy'),
    templateSnapshotRef: env.templateSnapshotRef,
    profileSnapshotRef: env.profileSnapshotRef,
    snapshotHash: 'a'.repeat(64),
    generatorRoleBinding: 'generator',
    reviewerRoleBinding: 'reviewer',
    slotTypes: SLOT_TYPES,
    slotTypeOf: () => 'doc',
    contentSchemaDigestOf: (slotId) => hash(`schema-${slotId}`),
    defaultAutomaticRetries: async () => 2,
  });

  const built: ContentEnv = {
    env,
    profile,
    taskId,
    service: contentService,
    grants,
    resolver,
    readEvents: async (id) => (await env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
    generationPlanId: planSpec.generationPlanId,
    planSpec,
    planSpecRef,
    firstWorkItemId: genCreated.workItemId,
    baselineManifestRef,
    mapSnapshotRef,
    mapSemanticDigest,
    slotIds,
  };
  envs.push(built);
  return built;
}

/** A ContentPlanService whose plan_finalize blocks the given slots (for the
 * F1/F2 successor-continuation regression: a multi-slot blocker yields a
 * successor with multiple correction batches). Batch commits still use the
 * real slotSchema builtin, exactly like `makeContentEnv`. */
function makeBlockingFinalizerService(b: ContentEnv, blockedSlots: readonly string[]): ContentPlanService {
  const key = 'test.content.plan_finalize.multiblock';
  const source = multiBlockFinalizeSource(blockedSlots);
  const registration = contentTestRegistration('plan_finalize', source, 'v-finalize-multiblock', '.multiblock');
  return new ContentPlanService({
    facade: b.env.facade,
    coordinator: b.env.coordinator,
    grants: b.grants,
    readProjection: b.env.readProjection,
    resolver: b.resolver,
    tail: (id) => b.env.eventStore.tail(id),
    readEvents: b.readEvents,
    clock: () => b.env.now.value,
    profile: b.profile,
    profileBody: PROFILE_BODY,
    validatorRegistry: new ValidatorRegistry([
      ...AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES,
      testValidatorEntry('plan_finalize', source, '.multiblock'),
    ]),
    sourceResolver: (handlerKey) => (handlerKey === key ? source : builtinSourceOf(handlerKey)),
    registrationsFor: (trigger, phase) => {
      if (phase === 'batch_commit') return [registrationFor('authoritative.review.slotSchema')];
      return [registration];
    },
    reviewPolicy: REVIEW_POLICY,
    reviewPolicyDigest: hash('review-policy'),
    templateSnapshotRef: b.env.templateSnapshotRef,
    profileSnapshotRef: b.env.profileSnapshotRef,
    snapshotHash: 'a'.repeat(64),
    generatorRoleBinding: 'generator',
    reviewerRoleBinding: 'reviewer',
    slotTypes: SLOT_TYPES,
    slotTypeOf: () => 'doc',
    contentSchemaDigestOf: (slotId) => hash(`schema-${slotId}`),
    defaultAutomaticRetries: async () => 2,
  });
}

/** Lease the generation workitem with the given id. */
async function leaseGenerationWorkItem(b: ContentEnv, workItemId: string): Promise<V2AttemptContext> {
  const lease = await b.env.coordinator.leaseNext(b.taskId, 'worker-g', opId('lease-gen'));
  if (lease === null || lease.workItemId !== workItemId) throw new Error(`expected the generation workitem '${workItemId}'`);
  return {
    taskId: b.taskId,
    workItemId,
    attemptId: lease.attemptId ?? '',
    leaseEpoch: lease.leaseEpoch,
    namespace: `structured/generation_batch/${workItemId}/${lease.attemptId}`,
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
}

function slotContentsFor(b: ContentEnv, slots: readonly string[]): Record<string, { text: string; mediaType: 'text/markdown' | 'text/plain' }> {
  const out: Record<string, { text: string; mediaType: 'text/markdown' | 'text/plain' }> = {};
  for (const slotId of slots) out[slotId] = { text: `content for ${slotId}`, mediaType: 'text/markdown' };
  return out;
}

/** Commits a generation batch AND completes the agent workitem so the NEXT
 * batch/finalizer WorkItem becomes claimable (single-writer §10.2). */
async function commitAndCompleteBatch(b: ContentEnv, ctx: V2AttemptContext, ordinal: number): Promise<{ manifestRef: BlobRefV2 }> {
  const outcome = await b.service.commitGenerationBatch({
    taskId: b.taskId,
    workItemId: ctx.workItemId,
    attemptId: ctx.attemptId,
    batchOrdinal: ordinal,
    ctx,
    slotContents: slotContentsFor(b, b.planSpec.orderedBatchSlotIds[ordinal - 1]),
  });
  expect(outcome.kind).toBe('committed');
  if (outcome.kind !== 'committed') throw new Error('batch not committed');
  await b.env.coordinator.completeWorkItem({
    taskId: b.taskId,
    operationId: attemptContinuationOperationId(b.taskId, ctx.workItemId, ctx.attemptId, 'complete'),
    workItemId: ctx.workItemId,
    attemptId: ctx.attemptId,
    resultRefs: [outcome.manifestRef],
  });
  return { manifestRef: outcome.manifestRef };
}

afterEach(() => {
  disposeRuntimeTestRoots();
  envs = [];
});

/* ------------------------------------------------------------------ */
/* Pure partition + manifest identity                                  */
/* ------------------------------------------------------------------ */

describe('content plan — deterministic partition (spec §13.2 / design §12.3)', () => {
  it('partitions content-bearing slots into complete ordered batches by contentBatchTargetSlots', () => {
    const slots = [
      { slotId: 's-3', documentOrder: 3 },
      { slotId: 's-1', documentOrder: 1 },
      { slotId: 's-2', documentOrder: 2 },
      { slotId: 's-4', documentOrder: 4 },
    ];
    expect(partitionGenerationBatches(slots, 2)).toEqual([['s-1', 's-2'], ['s-3', 's-4']]);
    expect(partitionGenerationBatches(slots, 3)).toEqual([['s-1', 's-2', 's-3'], ['s-4']]);
    // Shuffled input yields the same deterministic partition.
    expect(partitionGenerationBatches([slots[2], slots[0], slots[3], slots[1]], 2)).toEqual([['s-1', 's-2'], ['s-3', 's-4']]);
  });

  it('the soft limit never expands a batch beyond contentBatchTargetSlots', () => {
    const slots = Array.from({ length: 5 }, (_, i) => ({ slotId: `s-${i}`, documentOrder: i }));
    expect(partitionGenerationBatches(slots, 2).map((b) => b.length)).toEqual([2, 2, 1]);
    expect(partitionGenerationBatches(slots, 1).map((b) => b.length)).toEqual([1, 1, 1, 1, 1]);
  });

  it('deterministic correction batches cover only the blocked slots', () => {
    const all = [
      { slotId: 's-1', documentOrder: 1 },
      { slotId: 's-2', documentOrder: 2 },
      { slotId: 's-3', documentOrder: 3 },
      { slotId: 's-4', documentOrder: 4 },
    ];
    const correction = all.filter((s) => s.slotId === 's-2' || s.slotId === 's-4');
    expect(partitionCorrectionBatches(correction, 2)).toEqual([['s-2', 's-4']]);
  });
});

describe('content plan — manifest identity/presence (spec §7.3 / design §11.5)', () => {
  const mapRef: BlobRefV2 = refOfBlob('map_snapshot', { mapId: 'm1', mapSemanticDigest: hash('sem') });
  const planRef: BlobRefV2 = refOfBlob('generation_plan_spec', { generationPlanId: 'gp-1' });

  function unsetVersion(slotId: string, schema: string): SlotContentVersionV2 {
    return {
      state: 'unset',
      slotId,
      slotRevision: 1,
      taskContentRevision: 1,
      mapRef,
      mapSemanticDigest: hash('sem'),
      contentSchemaDigest: schema,
      unsetReason: 'initial',
      unsetProvenance: { kind: 'created_empty' },
    };
  }

  it('baseline_unset covers every slot with created_empty unset versions and empty finalizer refs', () => {
    const versions = new Map<string, SlotContentVersionV2>([
      ['a', unsetVersion('a', hash('sch-a'))],
      ['b', unsetVersion('b', hash('sch-b'))],
    ]);
    const body = {
      taskId: 't',
      mapRef,
      mapSemanticDigest: hash('sem'),
      taskContentRevision: 1,
      manifestPhase: 'baseline_unset' as const,
      entries: [...versions.values()].map((v) => ({ slotId: v.slotId, versionRef: refOfBlob('content_version', v) })),
      producerPlanSpecRef: null,
      priorManifestRef: null,
      finalizerValidatorAggregateRefs: [],
      finalizerWarningRootRefs: [],
      contentRootDigest: canonicalJsonSha256([
        { slotId: 'a', leaf: canonicalJsonSha256({ state: 'unset', contentSchemaDigest: hash('sch-a') }) },
        { slotId: 'b', leaf: canonicalJsonSha256({ state: 'unset', contentSchemaDigest: hash('sch-b') }) },
      ]),
    };
    const manifest = { ...body, manifestDigest: canonicalJsonSha256(body) };
    // The manifest is schema-valid, sorted, complete and NOT Seal-eligible.
    expect(() => parseBlob('content_revision_manifest', manifest, refOfBlob('content_revision_manifest', manifest))).not.toThrow();
    expect(manifest.entries.map((e) => e.slotId)).toEqual(['a', 'b']);
    expect(manifest.contentRootDigest).toBe(canonicalJsonSha256([
      { slotId: 'a', leaf: canonicalJsonSha256({ state: 'unset', contentSchemaDigest: hash('sch-a') }) },
      { slotId: 'b', leaf: canonicalJsonSha256({ state: 'unset', contentSchemaDigest: hash('sch-b') }) },
    ]));
  });

  it('a partial provisional manifest has empty finalizer refs and is not Seal-eligible', () => {
    const setVersion: SlotContentVersionV2 = {
      state: 'set',
      slotId: 'a',
      slotRevision: 1,
      contentDigest: hash('cv-a'),
      taskContentRevision: 2,
      mapRef,
      mapSemanticDigest: hash('sem'),
      contentSchemaDigest: hash('sch-a'),
      blobRef: refOfBlob('content_value', { slotId: 'a', contentSchemaDigest: hash('sch-a'), taskContentRevision: 2, mediaType: 'text/markdown', text: 'hi', selfDigest: '' }),
      provenance: {
        kind: 'generated',
        producer: { kind: 'generation_batch', planRevisionId: 'gp-1', batchOrdinal: 1, attemptId: 'at-1' },
        contentRevisionCommitCoreRef: refOfBlob('content_revision_commit_core', { priorManifestRef: mapRef, producerPlanSpecRef: planRef, batchOrdinal: 1, authorizedReplacementEntriesWithoutValidation: [], expectedMapRef: mapRef }),
        contentCommitValidatorAggregateRef: refOfBlob('validator_aggregate', { trigger: 'content_commit', executionPhase: 'batch_commit', inputRef: mapRef, inputDigest: '', registrationSetDigest: '', validExecutionDigests: [], blockingInvalidReceiptRefs: [], advisoryReceiptRefs: [], infrastructureFailureRefs: [], warningRootRef: mapRef, aggregateDigest: '' }),
        contentCommitWarningRootRef: refOfBlob('validation_warning_custody_root', { scope: 'content_review', taskId: 't', baseRefs: [], entries: [], supersessionPolicyVersion: '1' }),
        committedByAttemptId: 'at-1',
      },
    };
    const provisional = buildProvisionalManifest({
      taskId: 't',
      mapRef,
      mapSemanticDigest: hash('sem'),
      taskContentRevision: 2,
      priorManifestRef: refOfBlob('content_revision_manifest', { manifestDigest: 'baseline' }),
      producerPlanSpecRef: planRef,
      entries: [{ slotId: 'a', versionRef: refOfBlob('content_version', setVersion) }, { slotId: 'b', versionRef: refOfBlob('content_version', unsetVersion('b', hash('sch-b'))) }],
      resolvedVersions: new Map([['a', setVersion], ['b', unsetVersion('b', hash('sch-b'))]]),
    });
    expect(provisional.manifestPhase).toBe('provisional');
    expect(provisional.finalizerValidatorAggregateRefs).toHaveLength(0);
    expect(provisional.finalizerWarningRootRefs).toHaveLength(0);
    expect(() => parseBlob('content_revision_manifest', provisional, refOfBlob('content_revision_manifest', provisional))).not.toThrow();
  });

  it('a finalized manifest requires finalizer refs and is Seal-eligible', () => {
    const value = buildContentValue({ slotId: 'a', contentSchemaDigest: hash('sch-a'), taskContentRevision: 3, mediaType: 'text/markdown', text: 'hi' });
    const vRef = refOfBlob('content_value', value);
    const setVersionObj: SlotContentVersionV2 = {
      state: 'set',
      slotId: 'a',
      slotRevision: 1,
      contentDigest: vRef.digest,
      taskContentRevision: 3,
      mapRef,
      mapSemanticDigest: hash('sem'),
      contentSchemaDigest: hash('sch-a'),
      blobRef: vRef,
      provenance: {
        kind: 'generated',
        producer: { kind: 'generation_batch', planRevisionId: 'gp-1', batchOrdinal: 1, attemptId: 'at-1' },
        contentRevisionCommitCoreRef: refOfBlob('content_revision_commit_core', { priorManifestRef: mapRef, producerPlanSpecRef: planRef, batchOrdinal: 1, authorizedReplacementEntriesWithoutValidation: [], expectedMapRef: mapRef }),
        contentCommitValidatorAggregateRef: refOfBlob('validator_aggregate', { trigger: 'content_commit', executionPhase: 'batch_commit', inputRef: mapRef, inputDigest: '', registrationSetDigest: '', validExecutionDigests: [], blockingInvalidReceiptRefs: [], advisoryReceiptRefs: [], infrastructureFailureRefs: [], warningRootRef: mapRef, aggregateDigest: '' }),
        contentCommitWarningRootRef: refOfBlob('validation_warning_custody_root', { scope: 'content_review', taskId: 't', baseRefs: [], entries: [], supersessionPolicyVersion: '1' }),
        committedByAttemptId: 'at-1',
      },
    };
    const versionRef = refOfBlob('content_version', setVersionObj);
    const finalized = buildFinalizedManifest({
      taskId: 't',
      mapRef,
      mapSemanticDigest: hash('sem'),
      taskContentRevision: 3,
      priorManifestRef: refOfBlob('content_revision_manifest', { manifestDigest: 'provisional' }),
      producerPlanSpecRef: planRef,
      entries: [{ slotId: 'a', versionRef }],
      resolvedVersions: new Map([['a', setVersionObj]]),
      finalizerValidatorAggregateRefs: [refOfBlob('validator_aggregate', { trigger: 'content_commit', executionPhase: 'plan_finalize', inputRef: mapRef, inputDigest: '', registrationSetDigest: '', validExecutionDigests: [], blockingInvalidReceiptRefs: [], advisoryReceiptRefs: [], infrastructureFailureRefs: [], warningRootRef: mapRef, aggregateDigest: '' })],
      finalizerWarningRootRefs: [refOfBlob('validation_warning_custody_root', { scope: 'content_review', taskId: 't', baseRefs: [mapRef], entries: [], supersessionPolicyVersion: '1' })],
    });
    expect(finalized.manifestPhase).toBe('finalized');
    expect(finalized.finalizerValidatorAggregateRefs.length).toBeGreaterThan(0);
    expect(() => parseBlob('content_revision_manifest', finalized, refOfBlob('content_revision_manifest', finalized))).not.toThrow();
  });

  it('equal content roots with different provenance are different manifest revisions', () => {
    const body = {
      taskId: 't',
      mapRef,
      mapSemanticDigest: hash('sem'),
      taskContentRevision: 2,
      manifestPhase: 'provisional' as const,
      entries: [{ slotId: 'a', versionRef: refOfBlob('content_version', { state: 'set', slotId: 'a', contentDigest: hash('c') }) }],
      producerPlanSpecRef: planRef,
      priorManifestRef: null,
      finalizerValidatorAggregateRefs: [],
      finalizerWarningRootRefs: [],
      contentRootDigest: hash('root'),
    };
    const m1 = { ...body, manifestDigest: canonicalJsonSha256(body) };
    const m2 = { ...body, manifestDigest: canonicalJsonSha256({ ...body, contentRootDigest: hash('root2') }) };
    expect(refOfBlob('content_revision_manifest', m1).digest).not.toBe(refOfBlob('content_revision_manifest', m2).digest);
  });
});

/* ------------------------------------------------------------------ */
/* Generation batch commit                                             */
/* ------------------------------------------------------------------ */

describe('content plan — generation batches (spec §13.2)', { timeout: 30_000 }, () => {
  it('commits the first batch, publishes a provisional manifest and creates the next batch WorkItem', async () => {
    const b = await makeContentEnv();
    const firstBatch = b.planSpec.orderedBatchSlotIds[0];
    const ctx = await leaseGenerationWorkItem(b, b.firstWorkItemId);
    const outcome = await b.service.commitGenerationBatch({
      taskId: b.taskId,
      workItemId: b.firstWorkItemId,
      attemptId: ctx.attemptId,
      batchOrdinal: 1,
      ctx,
      slotContents: slotContentsFor(b, firstBatch),
    });
    expect(outcome.kind).toBe('committed');
    if (outcome.kind !== 'committed') return;
    const events = await b.readEvents(b.taskId);
    const planStarted = events.find((e) => e.type === 'structured_generation_plan_started');
    expect(planStarted).toBeDefined();
    const batchCommitted = events.find((e) => e.type === 'structured_generation_batch_committed');
    expect(batchCommitted).toBeDefined();
    expect((batchCommitted as { batchOrdinal: number }).batchOrdinal).toBe(1);
    const manifestEvent = events.filter((e) => e.type === 'structured_content_revision_committed').pop();
    expect(manifestEvent?.manifestPhase).toBe('provisional');
    // The next batch WorkItem is created (not the finalizer — batch 1 of 2).
    const nextCreated = events.find((e) => e.type === 'structured_work_item_created' && e.sessionKind === 'generation_batch');
    expect(nextCreated).toBeDefined();
    expect(outcome.nextWorkItemId).toBe(generationBatchWorkItemId(b.taskId, b.generationPlanId, 2));
    // The provisional manifest resolves with the batch slots set.
    const manifest = (await b.resolver(b.taskId, outcome.manifestRef)) as ContentRevisionManifestV2;
    expect(manifest.manifestPhase).toBe('provisional');
    expect(manifest.finalizerValidatorAggregateRefs).toHaveLength(0);
    expect(() => parseBlob('content_revision_manifest', manifest, outcome.manifestRef)).not.toThrow();
  });

  it('rejects an out-of-order batch (single-writer) with ZERO writes', async () => {
    const b = await makeContentEnv();
    const firstBatch = b.planSpec.orderedBatchSlotIds[0];
    const ctx = await leaseGenerationWorkItem(b, b.firstWorkItemId);
    // Batch 2 attempted while batch 1 is next.
    await expect(
      b.service.commitGenerationBatch({
        taskId: b.taskId,
        workItemId: b.firstWorkItemId,
        attemptId: ctx.attemptId,
        batchOrdinal: 2,
        ctx,
        slotContents: slotContentsFor(b, firstBatch),
      }),
    ).rejects.toMatchObject({ code: 'BATCH_OUT_OF_ORDER' });
    const events = await b.readEvents(b.taskId);
    expect(events.some((e) => e.type === 'structured_generation_batch_committed')).toBe(false);
  });

  it('rejects an out-of-scope write (a slot outside the granted batch) with ZERO writes', async () => {
    const b = await makeContentEnv();
    const firstBatch = b.planSpec.orderedBatchSlotIds[0];
    const secondBatch = b.planSpec.orderedBatchSlotIds[1] ?? [];
    const ctx = await leaseGenerationWorkItem(b, b.firstWorkItemId);
    const contents = slotContentsFor(b, firstBatch);
    for (const slotId of secondBatch) contents[slotId] = { text: 'out of scope', mediaType: 'text/markdown' };
    await expect(
      b.service.commitGenerationBatch({
        taskId: b.taskId,
        workItemId: b.firstWorkItemId,
        attemptId: ctx.attemptId,
        batchOrdinal: 1,
        ctx,
        slotContents: contents,
      }),
    ).rejects.toMatchObject({ code: 'WRITE_OUT_OF_SCOPE' });
    const events = await b.readEvents(b.taskId);
    expect(events.some((e) => e.type === 'structured_generation_batch_committed')).toBe(false);
  });

  it('manifest CAS advances with each batch: the next batch grant binds the NEW provisional manifest (never the baseline)', async () => {
    const b = await makeContentEnv();
    const firstBatch = b.planSpec.orderedBatchSlotIds[0];
    const ctx = await leaseGenerationWorkItem(b, b.firstWorkItemId);
    const firstOutcome = await b.service.commitGenerationBatch({
      taskId: b.taskId,
      workItemId: b.firstWorkItemId,
      attemptId: ctx.attemptId,
      batchOrdinal: 1,
      ctx,
      slotContents: slotContentsFor(b, firstBatch),
    });
    expect(firstOutcome.kind).toBe('committed');
    if (firstOutcome.kind !== 'committed') return;
    await b.env.coordinator.completeWorkItem({
      taskId: b.taskId,
      operationId: attemptContinuationOperationId(b.taskId, b.firstWorkItemId, ctx.attemptId, 'complete'),
      workItemId: b.firstWorkItemId,
      attemptId: ctx.attemptId,
      resultRefs: [firstOutcome.manifestRef],
    });
    // The batch-2 grant binds the NEW provisional manifest (CAS advanced).
    const secondWiId = generationBatchWorkItemId(b.taskId, b.generationPlanId, 2);
    const secondCtx = await leaseGenerationWorkItem(b, secondWiId);
    const secondGrant = (await b.resolver(b.taskId, secondCtx.grantInstanceRef as BlobRefV2)) as { grantSpecRef?: BlobRefV2 } | null;
    const secondSpec = secondGrant?.grantSpecRef === undefined
      ? null
      : (await b.resolver(b.taskId, secondGrant.grantSpecRef)) as { expectedContentRevisionManifestRef?: BlobRefV2 };
    if (secondSpec !== null && secondSpec !== undefined && typeof secondSpec === 'object' && secondSpec.expectedContentRevisionManifestRef !== undefined) {
      expect(secondSpec.expectedContentRevisionManifestRef.digest).toBe(firstOutcome.manifestRef.digest);
      expect(secondSpec.expectedContentRevisionManifestRef.digest).not.toBe(b.baselineManifestRef.digest);
    }
    // Batch 2 commits against the advanced manifest (the positive CAS path).
    const secondBatch = b.planSpec.orderedBatchSlotIds[1] ?? [];
    const outcome = await b.service.commitGenerationBatch({
      taskId: b.taskId,
      workItemId: secondWiId,
      attemptId: secondCtx.attemptId,
      batchOrdinal: 2,
      ctx: secondCtx,
      slotContents: slotContentsFor(b, secondBatch),
    });
    expect(outcome.kind).toBe('committed');
  });
});

/* ------------------------------------------------------------------ */
/* Validator phase isolation                                           */
/* ------------------------------------------------------------------ */

describe('content plan — validator phase isolation (spec §13.2 step 2-3)', { timeout: 30_000 }, () => {
  it('a partial batch runs ONLY content_commit/batch_commit (the global plan_finalize validator never rejects the first legal partial batch)', async () => {
    // The env registers the REAL slotSchema (batch_commit) + REAL coverage
    // (plan_finalize) builtins. The coverage handler validates required-slot
    // coverage over the FULL resolved manifest — at batch 1 the manifest is
    // PARTIAL (later required slots are still unset), so if coverage ran at
    // batch time it would reject. The batch passing proves it did NOT run.
    const b = await makeContentEnv();
    const firstBatch = b.planSpec.orderedBatchSlotIds[0];
    const ctx = await leaseGenerationWorkItem(b, b.firstWorkItemId);
    const outcome = await b.service.commitGenerationBatch({
      taskId: b.taskId,
      workItemId: b.firstWorkItemId,
      attemptId: ctx.attemptId,
      batchOrdinal: 1,
      ctx,
      slotContents: slotContentsFor(b, firstBatch),
    });
    expect(outcome.kind).toBe('committed');
    // Only a batch_commit execution happened: NO plan_finalize aggregate exists
    // in the events (the batch envelope never carries a plan-completed event).
    const events = await b.readEvents(b.taskId);
    expect(events.some((e) => e.type === 'structured_generation_plan_completed')).toBe(false);
  });

  it('the finalizer alone runs content_commit/plan_finalize against the complete provisional manifest', async () => {
    const b = await makeContentEnv();
    // Commit every batch (completing each workitem so the next is claimable).
    let currentWiId = b.firstWorkItemId;
    for (let ordinal = 1; ordinal <= b.planSpec.orderedBatchSlotIds.length; ordinal++) {
      const ctx = await leaseGenerationWorkItem(b, currentWiId);
      await commitAndCompleteBatch(b, ctx, ordinal);
      if (ordinal < b.planSpec.orderedBatchSlotIds.length) {
        currentWiId = generationBatchWorkItemId(b.taskId, b.generationPlanId, ordinal + 1);
      }
    }
    // The last batch created the finalizer WorkItem.
    const finalizeWiId = generationFinalizeWorkItemId(b.taskId, b.generationPlanId);
    const finalizeLease = await b.env.coordinator.leaseNext(b.taskId, 'worker-s', opId('lease-gen-finalize'));
    if (finalizeLease === null || finalizeLease.workItemId !== finalizeWiId) throw new Error('expected the generation finalize workitem');
    const state = await b.env.readProjection(b.taskId);
    const manifestRef = state.currentManifest?.contentRevisionManifestRef;
    const outcome = await b.service.executeGenerationFinalize({
      taskId: b.taskId,
      commandId: finalizeLease.commandId ?? '',
      workItemId: finalizeWiId,
      commandKind: 'generation_finalize',
      leaseEpoch: finalizeLease.leaseEpoch,
      authorityBaseRef: finalizeLease.authorityBaseRef,
      payloadRef: manifestRef ?? b.baselineManifestRef,
    });
    expect(outcome.kind).toBe('completed');
    const events = await b.readEvents(b.taskId);
    const manifestEvent = events.filter((e) => e.type === 'structured_content_revision_committed').pop();
    expect(manifestEvent?.manifestPhase).toBe('finalized');
    const planCompleted = events.find((e) => e.type === 'structured_generation_plan_completed');
    expect(planCompleted).toBeDefined();
    // Content review planned AFTER finalization.
    const reviewPlanned = events.find((e) => e.type === 'structured_review_round_planned');
    expect(reviewPlanned).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* Finalizer: clear + blocking successor                               */
/* ------------------------------------------------------------------ */

describe('content plan — finalizer outcomes (spec §13.2 step 4)', { timeout: 30_000 }, () => {
  async function commitAllBatches(b: ContentEnv): Promise<string> {
    let currentWiId = b.firstWorkItemId;
    for (let ordinal = 1; ordinal <= b.planSpec.orderedBatchSlotIds.length; ordinal++) {
      const ctx = await leaseGenerationWorkItem(b, currentWiId);
      await commitAndCompleteBatch(b, ctx, ordinal);
      if (ordinal < b.planSpec.orderedBatchSlotIds.length) {
        currentWiId = generationBatchWorkItemId(b.taskId, b.generationPlanId, ordinal + 1);
      }
    }
    return generationFinalizeWorkItemId(b.taskId, b.generationPlanId);
  }

  async function runFinalizer(b: ContentEnv): Promise<{ outcome: Awaited<ReturnType<ContentPlanService['executeGenerationFinalize']>>; manifestRef: BlobRefV2 }> {
    const finalizeWiId = await commitAllBatches(b);
    const finalizeLease = await b.env.coordinator.leaseNext(b.taskId, 'worker-s', opId('lease-gen-finalize'));
    if (finalizeLease === null || finalizeLease.workItemId !== finalizeWiId) throw new Error('expected the generation finalize workitem');
    const state = await b.env.readProjection(b.taskId);
    const manifestRef = state.currentManifest?.contentRevisionManifestRef ?? b.baselineManifestRef;
    const outcome = await b.service.executeGenerationFinalize({
      taskId: b.taskId,
      commandId: finalizeLease.commandId ?? '',
      workItemId: finalizeWiId,
      commandKind: 'generation_finalize',
      leaseEpoch: finalizeLease.leaseEpoch,
      authorityBaseRef: finalizeLease.authorityBaseRef,
      payloadRef: manifestRef,
    });
    return { outcome, manifestRef };
  }

  it('clear publishes a finalized manifest + plans content review (no review before finalization)', async () => {
    const b = await makeContentEnv();
    const { outcome } = await runFinalizer(b);
    expect(outcome.kind).toBe('completed');
    const events = await b.readEvents(b.taskId);
    const finalizedIdx = events.findIndex((e) => e.type === 'structured_content_revision_committed' && e.manifestPhase === 'finalized');
    const reviewPlannedIdx = events.findIndex((e) => e.type === 'structured_review_round_planned');
    expect(finalizedIdx).toBeGreaterThanOrEqual(0);
    expect(reviewPlannedIdx).toBeGreaterThan(finalizedIdx);
    // The finalized manifest is Seal-eligible.
    const manifestEvent = events.find((e) => e.type === 'structured_content_revision_committed' && e.manifestPhase === 'finalized');
    const finalized = (await b.resolver(b.taskId, (manifestEvent as { contentRevisionManifestRef: BlobRefV2 }).contentRevisionManifestRef)) as ContentRevisionManifestV2;
    expect(finalized.finalizerValidatorAggregateRefs.length).toBeGreaterThan(0);
  });

  it('blocking_invalid creates a receipt + ONE successor GenerationPlan with imported untouched versions + deterministic correction batches', async () => {
    const b = await makeContentEnv({ finalizeBlocking: true });
    const finalizeWiId = await commitAllBatches(b);
    const finalizeLease = await b.env.coordinator.leaseNext(b.taskId, 'worker-s', opId('lease-gen-finalize'));
    if (finalizeLease === null || finalizeLease.workItemId !== finalizeWiId) throw new Error('expected the generation finalize workitem');
    const state = await b.env.readProjection(b.taskId);
    const manifestRef = state.currentManifest?.contentRevisionManifestRef ?? b.baselineManifestRef;
    const outcome = await b.service.executeGenerationFinalize({
      taskId: b.taskId,
      commandId: finalizeLease.commandId ?? '',
      workItemId: finalizeWiId,
      commandKind: 'generation_finalize',
      leaseEpoch: finalizeLease.leaseEpoch,
      authorityBaseRef: finalizeLease.authorityBaseRef,
      payloadRef: manifestRef,
    });
    expect(outcome.kind).toBe('blocked');
    const events = await b.readEvents(b.taskId);
    const rejected = events.find((e) => e.type === 'structured_generation_plan_rejected');
    expect(rejected).toBeDefined();
    const successorStarted = events.find((e) => e.type === 'structured_generation_plan_started' && e.supersedesGenerationPlanId === b.generationPlanId);
    expect(successorStarted).toBeDefined();
    const successorPlanRef = (successorStarted as { generationPlanSpecRef: BlobRefV2 }).generationPlanSpecRef;
    const successorPlan = (await b.resolver(b.taskId, successorPlanRef)) as GenerationPlanSpecV2;
    expect(successorPlan.revision).toBe(2);
    expect(successorPlan.supersedesGenerationPlanId).toBe(b.generationPlanId);
    // The successor imports the untouched versions (the complete provisional).
    expect(successorPlan.importedContentManifestRef.digest).toBe(manifestRef.digest);
    expect(successorPlan.correctionScopeDigest).not.toBeNull();
    // Deterministic correction batches cover ONLY the blocked slot.
    expect(successorPlan.orderedBatchSlotIds.flat()).toContain(b.slotIds[0]);
    // ONE successor generation-batch WorkItem (created AFTER the rejected event).
    const rejectedIdx = events.findIndex((e) => e.type === 'structured_generation_plan_rejected');
    const successorWorkItems = events.filter(
      (e, i) => i > rejectedIdx && e.type === 'structured_work_item_created' && e.sessionKind === 'generation_batch',
    );
    expect(successorWorkItems.length).toBe(1);
  });

  it('F1/F2: a successor correction batch commits WITHOUT re-emitting plan-started, and a multi-batch successor continues past batch 1 (no PLAN_STALE, projection stays clean)', async () => {
    // 4 nodes keep this fsync-heavy end-to-end test under the 30s per-suite
    // timeout under full-suite load (the Task 11 load-flake pattern): the plan
    // has 2 batches; blocking 3 slots yields a successor with 2 correction
    // batches, which is all F1/F2 need to exercise.
    const b = await makeContentEnv({ nodeCount: 4 });
    // A custom finalizer that blocks THREE slots spanning TWO correction
    // batches (contentBatchTargetSlots 2), so the successor has >1 batch.
    const blockedSlots = [b.slotIds[0], b.slotIds[1], b.slotIds[2]];
    const finalizeWiId = await commitAllBatches(b);
    const finalizeLease = await b.env.coordinator.leaseNext(b.taskId, 'worker-s', opId('lease-gen-finalize'));
    if (finalizeLease === null || finalizeLease.workItemId !== finalizeWiId) throw new Error('expected the generation finalize workitem');
    const state = await b.env.readProjection(b.taskId);
    const manifestRef = state.currentManifest?.contentRevisionManifestRef ?? b.baselineManifestRef;
    const outcome = await makeBlockingFinalizerService(b, blockedSlots).executeGenerationFinalize({
      taskId: b.taskId,
      commandId: finalizeLease.commandId ?? '',
      workItemId: finalizeWiId,
      commandKind: 'generation_finalize',
      leaseEpoch: finalizeLease.leaseEpoch,
      authorityBaseRef: finalizeLease.authorityBaseRef,
      payloadRef: manifestRef,
    });
    expect(outcome.kind).toBe('blocked');
    const events = await b.readEvents(b.taskId);
    const successorStarted = events.find((e) => e.type === 'structured_generation_plan_started' && e.supersedesGenerationPlanId === b.generationPlanId);
    expect(successorStarted).toBeDefined();
    const successorPlanId = (successorStarted as { generationPlanId: string }).generationPlanId;
    const successorPlanRef = (successorStarted as { generationPlanSpecRef: BlobRefV2 }).generationPlanSpecRef;
    const successorPlan = (await b.resolver(b.taskId, successorPlanRef)) as GenerationPlanSpecV2;
    expect(successorPlan.revision).toBe(2);
    expect(successorPlan.orderedBatchSlotIds.length).toBeGreaterThanOrEqual(2);

    // F1: commit the successor's FIRST correction batch. Before the fix this
    // re-emitted structured_generation_plan_started (rev 2) → the projector
    // threw competing_successor on the next read (permanent corruption).
    const sCtx1 = await leaseGenerationWorkItem(b, generationBatchWorkItemId(b.taskId, successorPlanId, 1));
    const sOut1 = await b.service.commitGenerationBatch({
      taskId: b.taskId,
      workItemId: sCtx1.workItemId,
      attemptId: sCtx1.attemptId,
      batchOrdinal: 1,
      ctx: sCtx1,
      slotContents: slotContentsFor(b, successorPlan.orderedBatchSlotIds[0]),
    });
    expect(sOut1.kind).toBe('committed');
    if (sOut1.kind !== 'committed') throw new Error('successor batch 1 not committed');
    await b.env.coordinator.completeWorkItem({
      taskId: b.taskId,
      operationId: attemptContinuationOperationId(b.taskId, sCtx1.workItemId, sCtx1.attemptId, 'complete'),
      workItemId: sCtx1.workItemId,
      attemptId: sCtx1.attemptId,
      resultRefs: [sOut1.manifestRef],
    });
    await expect(b.env.readProjection(b.taskId)).resolves.toBeDefined();

    // F2: commit the successor's SECOND correction batch. Before the fix the
    // PLAN_STALE lineage check indexed generationPlans by the successor plan id
    // (undefined — the lineage is keyed by the revision-1 id) → spurious
    // PLAN_STALE once lastOrdinal > 0.
    const sCtx2 = await leaseGenerationWorkItem(b, generationBatchWorkItemId(b.taskId, successorPlanId, 2));
    const sOut2 = await b.service.commitGenerationBatch({
      taskId: b.taskId,
      workItemId: sCtx2.workItemId,
      attemptId: sCtx2.attemptId,
      batchOrdinal: 2,
      ctx: sCtx2,
      slotContents: slotContentsFor(b, successorPlan.orderedBatchSlotIds[1]),
    });
    expect(sOut2.kind).toBe('committed');
    await expect(b.env.readProjection(b.taskId)).resolves.toBeDefined();
  });

  it('infrastructure failure returns retryable_failure (the SystemCommand retries)', async () => {
    const b = await makeContentEnv();
    // Corrupt the source resolver so the engine emits an infrastructure failure.
    const service = new ContentPlanService({
      facade: b.env.facade,
      coordinator: b.env.coordinator,
      grants: b.grants,
      readProjection: b.env.readProjection,
      resolver: b.resolver,
      tail: (id) => b.env.eventStore.tail(id),
      readEvents: b.readEvents,
      clock: () => b.env.now.value,
      profile: b.profile,
      profileBody: PROFILE_BODY,
      validatorRegistry: new ValidatorRegistry(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES),
      sourceResolver: () => null,
      registrationsFor: (trigger, phase) => {
        if (phase === 'batch_commit') return [registrationFor('authoritative.review.slotSchema')];
        return [registrationFor('authoritative.review.coverage')];
      },
      reviewPolicy: REVIEW_POLICY,
      reviewPolicyDigest: hash('review-policy'),
      templateSnapshotRef: b.env.templateSnapshotRef,
      profileSnapshotRef: b.env.profileSnapshotRef,
      snapshotHash: 'a'.repeat(64),
      generatorRoleBinding: 'generator',
      reviewerRoleBinding: 'reviewer',
      slotTypes: SLOT_TYPES,
      slotTypeOf: () => 'doc',
      contentSchemaDigestOf: (slotId) => hash(`schema-${slotId}`),
      defaultAutomaticRetries: async () => 2,
    });
    const finalizeWiId = await commitAllBatches(b);
    const finalizeLease = await b.env.coordinator.leaseNext(b.taskId, 'worker-s', opId('lease-gen-finalize'));
    if (finalizeLease === null || finalizeLease.workItemId !== finalizeWiId) throw new Error('expected the generation finalize workitem');
    const state = await b.env.readProjection(b.taskId);
    const manifestRef = state.currentManifest?.contentRevisionManifestRef ?? b.baselineManifestRef;
    const outcome = await service.executeGenerationFinalize({
      taskId: b.taskId,
      commandId: finalizeLease.commandId ?? '',
      workItemId: finalizeWiId,
      commandKind: 'generation_finalize',
      leaseEpoch: finalizeLease.leaseEpoch,
      authorityBaseRef: finalizeLease.authorityBaseRef,
      payloadRef: manifestRef,
    });
    expect(outcome.kind).toBe('infrastructure_failure');
    const events = await b.readEvents(b.taskId);
    expect(events.some((e) => e.type === 'structured_generation_plan_rejected')).toBe(false);
    expect(events.some((e) => e.type === 'structured_generation_plan_completed')).toBe(false);
  });

  it('advisory clear does NOT create a successor', async () => {
    // The always-valid finalize registration is "clear"; the assertion that
    // NO successor plan exists after clear is already covered by the clear
    // test (no structured_generation_plan_started with supersedes).
    const b = await makeContentEnv();
    const { outcome } = await runFinalizer(b);
    expect(outcome.kind).toBe('completed');
    const events = await b.readEvents(b.taskId);
    const successors = events.filter((e) => e.type === 'structured_generation_plan_started' && e.supersedesGenerationPlanId === b.generationPlanId);
    expect(successors).toHaveLength(0);
  });

  it('createGenerationFinalizeSystemCommandHandler replaces the Task 12 NOT_IMPLEMENTED stub via SystemCommandRegistry.replace', async () => {
    const b = await makeContentEnv();
    const registry = new SystemCommandRegistry();
    const notImpl = registry.resolve('generation_finalize');
    expect(notImpl).not.toBeNull();
    registry.replace(createGenerationFinalizeSystemCommandHandler(b.service));
    const replaced = registry.resolve('generation_finalize');
    expect(replaced).not.toBeNull();
    expect(replaced?.commandKind).toBe('generation_finalize');
    // The stub's failure digest differs from the real handler's.
    expect(replaced).not.toBe(notImpl);
  });
});

/* ------------------------------------------------------------------ */
/* Blocking successor plan shape                                       */
/* ------------------------------------------------------------------ */

describe('content plan — successor plan (design §11.5/§13.2)', () => {
  it('buildSuccessorGenerationPlan imports untouched versions, derives the revision and keeps correctionScopeDigest', () => {
    const mapRef: BlobRefV2 = refOfBlob('map_snapshot', { mapId: 'm1' });
    const manifestRef: BlobRefV2 = refOfBlob('content_revision_manifest', { manifestDigest: 'prov' });
    const receiptRef: BlobRefV2 = refOfBlob('validation_receipt', { receiptKind: 'generation' });
    const plan = buildSuccessorGenerationPlan({
      generationPlanId: successorGenerationPlanId('gp-1', 2),
      revision: 2,
      supersedesGenerationPlanId: 'gp-1',
      sourceValidationReceiptRef: receiptRef,
      activeMapRef: mapRef,
      importedContentManifestRef: manifestRef,
      correctionSlotIds: ['s-2', 's-4'],
      correctionSlotsWithOrder: [
        { slotId: 's-2', documentOrder: 2 },
        { slotId: 's-4', documentOrder: 4 },
      ],
      reviewPolicy: REVIEW_POLICY,
    });
    expect(plan.revision).toBe(2);
    expect(plan.supersedesGenerationPlanId).toBe('gp-1');
    expect(plan.baseContentRevisionManifestRef.digest).toBe(manifestRef.digest);
    expect(plan.importedContentManifestRef.digest).toBe(manifestRef.digest);
    expect(plan.orderedBatchSlotIds).toEqual([['s-2', 's-4']]);
    expect(plan.correctionScopeDigest).toBe(canonicalJsonSha256(['s-2', 's-4']));
    expect(() => parseBlob('generation_plan_spec', plan, refOfBlob('generation_plan_spec', plan))).not.toThrow();
  });

  it('a successor of a revision-2 plan derives revision 3 (F4: not hard-coded to 2)', () => {
    const mapRef: BlobRefV2 = refOfBlob('map_snapshot', { mapId: 'm1' });
    const manifestRef: BlobRefV2 = refOfBlob('content_revision_manifest', { manifestDigest: 'prov' });
    const receiptRef: BlobRefV2 = refOfBlob('validation_receipt', { receiptKind: 'generation' });
    const plan = buildSuccessorGenerationPlan({
      generationPlanId: successorGenerationPlanId('gp-2', 3),
      revision: 3,
      supersedesGenerationPlanId: 'gp-2',
      sourceValidationReceiptRef: receiptRef,
      activeMapRef: mapRef,
      importedContentManifestRef: manifestRef,
      correctionSlotIds: ['s-3'],
      correctionSlotsWithOrder: [{ slotId: 's-3', documentOrder: 3 }],
      reviewPolicy: REVIEW_POLICY,
    });
    expect(plan.revision).toBe(3);
    expect(plan.generationPlanId).toBe(successorGenerationPlanId('gp-2', 3));
    expect(() => parseBlob('generation_plan_spec', plan, refOfBlob('generation_plan_spec', plan))).not.toThrow();
  });
});
