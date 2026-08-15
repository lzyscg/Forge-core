// @vitest-environment node
/**
 * Task 16 map-review-service tests (spec §13.1/§13.4/§11.3, design
 * §11.3/§12.1/§12.4/§12.6/§17.5): the Map pre-review round planning, the
 * reviewer ledger publication (Task 13 freeze seam), the acyclic settlement
 * DAG, the ATOMIC first Map activation with the baseline-unset manifest, the
 * rejected-activation path (old Map/content stay current), equal-semantic/
 * different-ref invalidation, and the no-generation-before-activation invariant.
 *
 * NORMATIVE CORE asserted here:
 * - draft verdicts are invisible until assignment completion; completion
 *   requires every target + evidence/context digest + no conflict + current
 *   attempt/base (the Task 13 freeze enforces it);
 * - `CoverageCore -> settlement aggregate -> SettlementCore -> ProposedMapCore
 *   -> activation aggregate -> MapReviewBundle/MapSnapshot` is acyclic and
 *   missing/reject/blocking/validator-failure cannot activate;
 * - the settlement handler is the ONLY activator: no `structured_map_activated`
 *   with a clear MapReviewBundle means no GenerationPlan/WorkItem exists.
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
import { AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES } from './builtin-validators';
import type { ValidatorRegistrationV2 } from '../../template/structured-slot-contract-v2';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { V2AttemptContext } from './attempt-coordinator';
import type { WriteGrantSpecV2, MapReviewRoundV2, ReviewFactV2 } from '../../authoritative-review/authority-types';
import { REVIEW_OBSERVATION_GRANT_KIND } from '../../authoritative-review/authority-types';
import {
  authoritativeTestContentValue,
  createWorkItemCoordinatorEnvironment,
  disposeRuntimeTestRoots,
  type WorkItemCoordinatorEnvironment,
} from '../test-support';
import {
  EMPTY_BUILD_FRONTIER_DIGEST,
  MapBuildService,
  buildChunk,
  registerMapBuildPublicationHandlers,
  type BuildRelationPolicyV2,
} from './map-build-service';
import { createMapReviewSettlementSystemCommandHandler, MapReviewService, buildMapReviewRound, registerMapReviewPublicationHandlers, deterministicSettlementWorkItemId, contentSchemaDigestOf } from './map-review-service';
import { ReviewCoordinatorV2, reviewAssignmentIdOf, reviewWholeAssignmentId, reviewBatchWorkItemId, reviewWholeWorkItemId, buildReviewObservationGrantSpec } from './review-coordinator';
import { planMapReview, type MapReviewPlanV2 } from './observation-planner';
import { buildReviewAssignmentFreeze, type ReviewDraftRecordV2, type FrozenReviewAssignmentV2 } from './tool-factory';
import { SystemCommandRegistry } from './system-command-registry';
import { attemptContinuationOperationId } from './attempt-coordinator';
import { validateWorkItemCarry } from './authority-base';

const PROFILE = fullProfileForTests();
const PROFILE_BODY = buildAuthoritativeReviewTestProfileBody();
const REGISTRY = new ValidatorRegistry(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES);

/* Test-only validator entries for the map-review settlement/activation
 * triggers (no installed builtin covers them; the map-build completeness
 * handler is map_candidate_commit-only). The always-valid handler returns
 * `valid` for ANY input; the always-invalid one returns a blocking issue. */
function alwaysValidSource(salt: string): string {
  return `'use strict';
module.exports = { validate: function validate(input) { return { status: 'valid', executionDigest: '${hash(salt)}' }; } };`;
}
function alwaysInvalidSource(salt: string): string {
  return `'use strict';
module.exports = { validate: function validate(input) { return { status: 'domain_invalid', issues: [ { validatorId: input.validatorId, implementationDigest: input.implementationDigest, issueCode: 'test.blocking', location: { targetKind: 'node', stableTargetId: '', jsonPointer: null }, repairTargets: { mapNodeIds: [], relationIds: [], slotIds: [] }, evidenceDigest: '' } ], executionDigest: '' }; } };`;
}
function testValidatorEntry(trigger: 'map_review_settlement' | 'map_activation', source: string, keySuffix = ''): import('./validator-registry').InstalledValidatorEntry {
  return {
    handlerKey: `test.mapReview.${trigger}${keySuffix}`,
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
const SETTLEMENT_SOURCE = alwaysValidSource('map_review_settlement');
const ACTIVATION_SOURCE = alwaysValidSource('map_activation');
const BLOCKING_ACTIVATION_SOURCE = alwaysInvalidSource('map_activation-blocking');
const REVIEW_REGISTRY = new ValidatorRegistry([
  ...AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES,
  testValidatorEntry('map_review_settlement', SETTLEMENT_SOURCE),
  testValidatorEntry('map_activation', ACTIVATION_SOURCE),
  testValidatorEntry('map_activation', BLOCKING_ACTIVATION_SOURCE, '.blocking'),
]);
function testRegistrationFor(trigger: 'map_review_settlement' | 'map_activation', source: string, validatorId: string, keySuffix = ''): ValidatorRegistrationV2 {
  const entry = testValidatorEntry(trigger, source, keySuffix);
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
function reviewSourceResolver(handlerKey: string): string | null {
  if (handlerKey === 'test.mapReview.map_review_settlement') return SETTLEMENT_SOURCE;
  if (handlerKey === 'test.mapReview.map_activation') return ACTIVATION_SOURCE;
  if (handlerKey === 'test.mapReview.map_activation.blocking') return BLOCKING_ACTIVATION_SOURCE;
  return null;
}

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

function specValue(mapBuildId = 'mb-1', overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const body = {
    mapBuildId,
    revision: 1,
    supersedesMapBuildId: null,
    sourceValidationReceiptRef: null,
    snapshotHash: 'a'.repeat(64),
    plannedChunkPolicy: { maxChunks: 16, maxNodesPerChunk: 512, maxRelationsPerChunk: 64 },
    ...overrides,
  };
  return { ...body, specDigest: canonicalJsonSha256(body) };
}

function nodeDecl(buildNodeKey: string, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
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

/* ------------------------------------------------------------------ */
/* Review environment                                                  */
/* ------------------------------------------------------------------ */

interface ReviewEnv {
  env: WorkItemCoordinatorEnvironment;
  profile: typeof PROFILE;
  taskId: string;
  mapBuild: MapBuildService;
  service: MapReviewService;
  coordinator: ReviewCoordinatorV2;
  grants: GrantService;
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown>;
  readEvents(taskId: string): Promise<readonly AuthoritativeReviewEventV2[]>;
  snapshotHash: string;
  reviewPolicyDigest: string;
  templateSnapshotRef: BlobRefV2;
  profileSnapshotRef: BlobRefV2;
  roundId: string;
  candidateRef: BlobRefV2;
  nodeIds: string[];
  relationIds: string[];
  assignmentCount: number;
}

let envs: ReviewEnv[] = [];

/** Builds a full task with a candidate + round-planned event (Task 15 clear path). */
async function makeReviewEnv(opts: { relationPolicy?: BuildRelationPolicyV2; nodes?: Record<string, unknown>[]; relations?: Record<string, unknown>[]; profile?: typeof PROFILE } = {}): Promise<ReviewEnv> {
  const profile = opts.profile ?? PROFILE;
  const registry = new PublicationIntentRegistry();
  registerMapBuildPublicationHandlers(registry);
  registerMapReviewPublicationHandlers(registry);
  const env = await createWorkItemCoordinatorEnvironment({ registry });
  const taskId = 'task-map-review';
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
  const startOperation = opId('start-task');
  const tail0 = await env.eventStore.tail(taskId);
  await env.facade.publishWithPin({
    taskId,
    operationId: startOperation,
    payload: {
      family: 'lifecycle',
      operationId: startOperation,
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

  const nodes = opts.nodes ?? [nodeDecl('root'), nodeDecl('a', { parentBuildNodeKey: 'root', documentOrder: 2, siblingOrder: 1 }), nodeDecl('b', { parentBuildNodeKey: 'root', documentOrder: 3, siblingOrder: 2 })];
  const relations = opts.relations ?? [];
  // Build the candidate through a sequence of chunk appends (all in one chunk).
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
    registrationsFor: () => [registrationFor('authoritative.review.completeness')],
    relationPolicy: opts.relationPolicy ?? 'optional',
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
    relations: relations as Record<string, unknown>[],
    clientOperationId: 'op-c1',
  });
  await mapBuild.finishMapBuild(buildCtx, {
    expectedChunkCount: 1,
    expectedFrontierDigest: chunkResult.frontierDigest,
    expectedRootCount: 1,
    clientOperationId: 'op-finish',
  });
  // Complete the structure_chunk workitem (it carried the finish declaration) so
  // the system_map_finalize workitem becomes claimable.
  await env.coordinator.completeWorkItem({
    taskId,
    operationId: opId('complete-last'),
    workItemId,
    attemptId: buildCtx.attemptId,
    resultRefs: [chunkResult.chunkRef],
  });
  // Lease the system_map_finalize and run it.
  const finalizeLease = await env.coordinator.leaseNext(taskId, 'worker-a', opId('lease-finalize'));
  if (finalizeLease === null) throw new Error('expected a leaseable system_map_finalize');
  const outcome = await mapBuild.executeMapFinalize({
    taskId,
    commandId: finalizeLease.commandId ?? '',
    workItemId: finalizeLease.workItemId,
    commandKind: 'map_finalize',
    leaseEpoch: finalizeLease.leaseEpoch,
    authorityBaseRef: finalizeLease.authorityBaseRef,
    payloadRef: specRef,
  });
  expect(outcome.kind).toBe('completed');

  const events = (await env.eventStore.read(taskId)).map((e) => e.event as AuthoritativeReviewEventV2);
  const roundEvent = events.find((e) => e.type === 'structured_map_review_round_planned');
  if (roundEvent === undefined || roundEvent.type !== 'structured_map_review_round_planned') throw new Error('no round planned');
  const candidateEvent = events.find((e) => e.type === 'structured_map_candidate_committed');
  if (candidateEvent === undefined || candidateEvent.type !== 'structured_map_candidate_committed') throw new Error('no candidate');

  const reviewCoordinator = new ReviewCoordinatorV2({
    coordinator: env.coordinator,
    facade: env.facade,
    resolver,
    readProjection: env.readProjection,
    readEvents: async (id) => (await env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
    profile,
    reviewPolicy: { mapReview: 'required', contentSelector: 'content_bearing', mapBatchTargetSlots: 24, contentBatchTargetSlots: 24, assignmentSoftLimit: 64, wholeMapObservation: 'required', wholeContentTreeObservation: 'required', reviewAdvisoryRelations: false, maxRounds: 8 },
    templateSnapshotRef: env.templateSnapshotRef,
    profileSnapshotRef: env.profileSnapshotRef,
    reviewerRoleBinding: 'reviewer',
    generatorRoleBinding: 'generator',
    orchestratorRoleBinding: 'orchestrator',
    snapshotHash: 'a'.repeat(64),
    defaultAutomaticRetries: async () => 2,
  });
  const service = new MapReviewService({
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
    registrationsFor: (trigger) => [testRegistrationFor(trigger, trigger === 'map_activation' ? ACTIVATION_SOURCE : SETTLEMENT_SOURCE, `v-${trigger}`)],
    reviewPolicy: { mapReview: 'required', contentSelector: 'content_bearing', mapBatchTargetSlots: 24, contentBatchTargetSlots: 24, assignmentSoftLimit: 64, wholeMapObservation: 'required', wholeContentTreeObservation: 'required', reviewAdvisoryRelations: false, maxRounds: 8 },
    reviewPolicyDigest: hash('review-policy'),
    templateSnapshotRef: env.templateSnapshotRef,
    profileSnapshotRef: env.profileSnapshotRef,
    snapshotHash: 'a'.repeat(64),
    reviewerRoleBinding: 'reviewer',
    generatorRoleBinding: 'generator',
    orchestratorRoleBinding: 'orchestrator',
  });

  const built: ReviewEnv = {
    env,
    profile,
    taskId,
    mapBuild,
    service,
    coordinator: reviewCoordinator,
    grants,
    resolver,
    readEvents: async (id) => (await env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
    snapshotHash: 'a'.repeat(64),
    reviewPolicyDigest: hash('review-policy'),
    templateSnapshotRef: env.templateSnapshotRef,
    profileSnapshotRef: env.profileSnapshotRef,
    roundId: roundEvent.mapReviewRoundId,
    candidateRef: roundEvent.candidateRef,
    nodeIds: (await candidateNodeIds(taskId, env, roundEvent.candidateRef)),
    relationIds: (await candidateRelationIds(taskId, env, roundEvent.candidateRef)),
    assignmentCount: roundEvent.assignmentCount,
  };
  envs.push(built);
  return built;
}

async function resolveFrontierForChunk1(taskId: string, env: WorkItemCoordinatorEnvironment, mapBuildId: string): Promise<string> {
  const events = (await env.eventStore.read(taskId)).map((e) => e.event as AuthoritativeReviewEventV2);
  const chunks = events.filter((e) => e.type === 'structured_map_chunk_committed' && e.mapBuildId === mapBuildId);
  if (chunks.length === 0) return EMPTY_BUILD_FRONTIER_DIGEST;
  return canonicalJsonSha256({ mapBuildId, chunkRefs: chunks.map((c) => (c as { chunkRef: BlobRefV2 }).chunkRef) });
}

async function candidateNodeIds(taskId: string, env: WorkItemCoordinatorEnvironment, candidateRef: BlobRefV2): Promise<string[]> {
  const candidate = (await env.resolverFor(taskId)(candidateRef)) as { validationCoreRef: BlobRefV2 };
  const core = (await env.resolverFor(taskId)(candidate.validationCoreRef)) as { nodes: { slotId: string }[] };
  return core.nodes.map((n) => n.slotId);
}

async function candidateRelationIds(taskId: string, env: WorkItemCoordinatorEnvironment, candidateRef: BlobRefV2): Promise<string[]> {
  const candidate = (await env.resolverFor(taskId)(candidateRef)) as { validationCoreRef: BlobRefV2 };
  const core = (await env.resolverFor(taskId)(candidate.validationCoreRef)) as { relations: { relationId: string }[] };
  return core.relations.map((r) => r.relationId);
}

async function readRoundBlob(b: ReviewEnv): Promise<MapReviewRoundV2> {
  // The round blob was prepared during planRound; resolve the latest one from the events.
  const events = await b.readEvents(b.taskId);
  const planned = events.find(
    (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_round_planned' }> =>
      e.type === 'structured_map_review_round_planned' && e.mapReviewRoundId === b.roundId,
  );
  const candidate = (await b.resolver(b.taskId, b.candidateRef)) as { validationCoreRef: BlobRefV2 };
  const core = (await b.resolver(b.taskId, candidate.validationCoreRef)) as { nodes: { slotId: string }[]; relations: { relationId: string }[] };
  return buildMapReviewRound({
    mapReviewRoundId: b.roundId,
    candidateId: planned?.candidateId ?? 'cand-1',
    candidateDigest: b.candidateRef.digest,
    contentRevisionManifestRef: null,
    contentRootDigest: null,
    reviewPolicyDigest: b.reviewPolicyDigest,
    coverageNodeIds: core.nodes.map((n) => n.slotId),
    coverageRelationIds: core.relations.map((r) => r.relationId),
    assignmentIds: Array.from({ length: b.assignmentCount }, (_, i) => reviewAssignmentIdOf(b.roundId, i)).concat([reviewWholeAssignmentId(b.roundId)]),
    verificationFindingStages: [],
  });
}

async function planRound(b: ReviewEnv): Promise<{ roundRef: BlobRefV2; coverageCoreRef: BlobRefV2 }> {
  const round = await readRoundBlob(b);
  return b.service.planRound({ taskId: b.taskId, round, candidateRef: b.candidateRef, reviewPolicyDigest: b.reviewPolicyDigest });
}

function mapPlanOf(b: ReviewEnv): MapReviewPlanV2 {
  return planMapReview({
    nodes: nodeListOf(b),
    relations: [],
    profile: b.profile,
    reviewPolicy: { mapReview: 'required', contentSelector: 'content_bearing', mapBatchTargetSlots: 24, contentBatchTargetSlots: 24, assignmentSoftLimit: 64, wholeMapObservation: 'required', wholeContentTreeObservation: 'required', reviewAdvisoryRelations: false, maxRounds: 8 },
    assignmentCount: b.assignmentCount,
  });
}

function nodeListOf(b: ReviewEnv): { slotId: string; slotType: string; contentBearing: boolean; parentSlotId: string | null; documentOrder: number; siblingOrder: number; nodeSpecDigest: string }[] {
  return b.nodeIds.map((id, i) => ({ slotId: id, slotType: 'doc', contentBearing: true, parentSlotId: i === 0 ? null : 'root', documentOrder: i, siblingOrder: 0, nodeSpecDigest: 'a'.repeat(64) }));
}

function batchFreeze(b: ReviewEnv, workItemId: string, attemptId: string, reviewAssignmentId: string): { freeze: FrozenReviewAssignmentV2; targets: string[] } {
  const plan = mapPlanOf(b);
  const batch = plan.batches[0];
  const targets = [...batch.nodeIds, ...batch.relationIds];
  const baselineTargetKinds: Record<string, ReviewFactV2['targetKind']> = {};
  for (const id of batch.nodeIds) baselineTargetKinds[id] = 'map_node';
  for (const id of batch.relationIds) baselineTargetKinds[id] = 'map_relation';
  const records: ReviewDraftRecordV2[] = targets.map((targetId) => {
    const isNode = batch.nodeIds.includes(targetId);
    return {
      op: isNode ? 'submit_map_node_review' : 'submit_map_relation_review',
      body: { targetId, verdict: 'pass', evidence: [], findingDrafts: [], crossScopeFindingDrafts: [] },
      at: b.env.now.value,
    };
  });
  const result = buildReviewAssignmentFreeze({
    assignmentId: workItemId,
    workItemId,
    reviewAssignmentId,
    roundKind: 'map',
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
  if (!result.ok) throw new Error(`freeze failed: ${result.errors.join('; ')}`);
  return { freeze: result.freeze, targets };
}

function wholeFreeze(b: ReviewEnv, workItemId: string, attemptId: string, reviewAssignmentId: string): { freeze: FrozenReviewAssignmentV2 } {
  const records: ReviewDraftRecordV2[] = [
    {
      op: 'submit_map_whole_finding',
      body: {
        findingDraft: { clientFindingKey: 'k-1', defectClass: 'map', severity: 'advisory', primaryLocation: { kind: 'map', id: b.candidateRef.digest }, evidence: [] },
        anchoredVerdict: null,
      },
      at: b.env.now.value,
    },
  ];
  const result = buildReviewAssignmentFreeze({
    assignmentId: workItemId,
    workItemId,
    reviewAssignmentId,
    roundKind: 'map',
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
  if (!result.ok) throw new Error(`whole freeze failed: ${result.errors.join('; ')}`);
  return { freeze: result.freeze };
}

async function leaseAndCompleteBatch(b: ReviewEnv): Promise<void> {
  const workItemId = reviewBatchWorkItemId(b.roundId, 0);
  const reviewAssignmentId = reviewAssignmentIdOf(b.roundId, 0);
  const lease = await b.env.coordinator.leaseNext(b.taskId, 'worker-r', opId('lease-review-batch'));
  if (lease === null || lease.workItemId !== workItemId) throw new Error('expected the batch review workitem');
  const attemptId = lease.attemptId ?? '';
  const { freeze } = batchFreeze(b, workItemId, attemptId, reviewAssignmentId);
  await b.service.freezeReviewAssignment(b.taskId, freeze);
  await b.env.coordinator.completeWorkItem({
    taskId: b.taskId,
    operationId: attemptContinuationOperationId(b.taskId, workItemId, attemptId, 'complete'),
    workItemId,
    attemptId,
    resultRefs: [refOfBlob('review_assignment_ledger', freeze.ledger)],
  });
}

async function leaseAndCompleteWhole(b: ReviewEnv): Promise<void> {
  // The claim order leases the batch workitem first. If it is NOT yet
  // completed, complete it (with its own freeze) so the whole-map observation
  // workitem becomes claimable. If it is already completed, skip ahead.
  const batchWorkItemId = reviewBatchWorkItemId(b.roundId, 0);
  const projection = await b.env.readProjection(b.taskId);
  const batchWi = projection.workItems[batchWorkItemId];
  if (batchWi !== undefined && batchWi.state !== 'completed') {
    const batchLease = await b.env.coordinator.leaseNext(b.taskId, 'worker-r', opId('lease-review-batch-for-whole'));
    if (batchLease === null || batchLease.workItemId !== batchWorkItemId) throw new Error('expected the batch review workitem first');
    const batchAttemptId = batchLease.attemptId ?? '';
    const { freeze: batchLedger } = batchFreeze(b, batchWorkItemId, batchAttemptId, reviewAssignmentIdOf(b.roundId, 0));
    await b.service.freezeReviewAssignment(b.taskId, batchLedger);
    await b.env.coordinator.completeWorkItem({
      taskId: b.taskId,
      operationId: attemptContinuationOperationId(b.taskId, batchWorkItemId, batchAttemptId, 'complete'),
      workItemId: batchWorkItemId,
      attemptId: batchAttemptId,
      resultRefs: [refOfBlob('review_assignment_ledger', batchLedger.ledger)],
    });
  }

  const workItemId = reviewWholeWorkItemId(b.roundId);
  const reviewAssignmentId = reviewWholeAssignmentId(b.roundId);
  const lease = await b.env.coordinator.leaseNext(b.taskId, 'worker-r', opId('lease-review-whole'));
  if (lease === null || lease.workItemId !== workItemId) throw new Error('expected the whole review workitem');
  const attemptId = lease.attemptId ?? '';
  const { freeze } = wholeFreeze(b, workItemId, attemptId, reviewAssignmentId);
  await b.service.freezeReviewAssignment(b.taskId, freeze);
  await b.env.coordinator.completeWorkItem({
    taskId: b.taskId,
    operationId: attemptContinuationOperationId(b.taskId, workItemId, attemptId, 'complete'),
    workItemId,
    attemptId,
    resultRefs: [refOfBlob('review_assignment_ledger', freeze.ledger)],
  });
}

async function runSettlement(b: ReviewEnv): Promise<{ kind: 'completed' | 'retryable_failure'; failureCode?: string; events: readonly AuthoritativeReviewEventV2[] }> {
  const advanced = await b.service.maybeCompleteRound(b.taskId, b.roundId);
  if (!advanced) throw new Error('round did not advance to completed');
  const settlementWorkItemId = deterministicSettlementWorkItemId(b.taskId, b.roundId);
  const lease = await b.env.coordinator.leaseNext(b.taskId, 'worker-s', opId('lease-settlement'));
  if (lease === null || lease.workItemId !== settlementWorkItemId) throw new Error('expected the settlement workitem');
  const commandId = lease.commandId ?? '';
  // The settlement WorkItem's payload IS the final coverage core (the round-
  // completed event's coverageCoreRef).
  const eventsBefore = await b.readEvents(b.taskId);
  const completed = eventsBefore.find((e) => e.type === 'structured_map_review_round_completed' && e.mapReviewRoundId === b.roundId);
  if (completed === undefined || completed.type !== 'structured_map_review_round_completed') throw new Error('no round completed');
  const coverageCoreRef = completed.coverageCoreRef;
  const outcome = await b.service.executeMapReviewSettlement({
    taskId: b.taskId,
    commandId,
    workItemId: settlementWorkItemId,
    commandKind: 'review_settlement',
    leaseEpoch: lease.leaseEpoch,
    authorityBaseRef: lease.authorityBaseRef,
    payloadRef: coverageCoreRef,
  });
  const events = await b.readEvents(b.taskId);
  return { kind: outcome.kind, failureCode: outcome.kind === 'retryable_failure' ? outcome.failureCode : undefined, events };
}

afterEach(() => {
  disposeRuntimeTestRoots();
  envs = [];
});

/* ------------------------------------------------------------------ */
/* Step 2: reviewer-ledger tests                                       */
/* ------------------------------------------------------------------ */

describe('reviewer ledger publication (Task 13 freeze seam)', { timeout: 30_000 }, () => {
  it('completes the batch assignment and freezes an AssignmentLedgerBlob with a batch fact', async () => {
    const b = await makeReviewEnv();
    const { roundRef, coverageCoreRef } = await planRound(b);
    await b.coordinator.createRoundReviewWorkItems({
      taskId: b.taskId,
      round: await readRoundBlob(b),
      roundRef,
      coverageCoreRef,
      mapCandidateRef: b.candidateRef,
      plan: mapPlanOf(b),
    });
    await leaseAndCompleteBatch(b);
    const events = await b.readEvents(b.taskId);
    const committed = events.find((e) => e.type === 'structured_map_review_assignment_committed');
    expect(committed).toBeDefined();
    expect(committed?.source).toBe('batch');
    // The ledger blob is resolvable and parseable.
    const ledgerRef = (committed as { ledgerRef: BlobRefV2 }).ledgerRef;
    const ledger = (await b.resolver(b.taskId, ledgerRef)) as { roundKind: string; factRefs: BlobRefV2[] };
    expect(ledger.roundKind).toBe('map');
    expect(ledger.factRefs.length).toBe(b.assignmentCount === 1 ? b.nodeIds.length : 1);
  });

  it('draft verdicts are invisible until assignment completion (no assignment event before the freeze)', async () => {
    const b = await makeReviewEnv();
    const { roundRef, coverageCoreRef } = await planRound(b);
    await b.coordinator.createRoundReviewWorkItems({
      taskId: b.taskId,
      round: await readRoundBlob(b),
      roundRef,
      coverageCoreRef,
      mapCandidateRef: b.candidateRef,
      plan: mapPlanOf(b),
    });
    const events = await b.readEvents(b.taskId);
    expect(events.some((e) => e.type === 'structured_map_review_assignment_committed')).toBe(false);
  });

  it('completion requires EVERY assignment target (a partial freeze is rejected with ZERO publication)', async () => {
    const b = await makeReviewEnv();
    const { roundRef, coverageCoreRef } = await planRound(b);
    await b.coordinator.createRoundReviewWorkItems({
      taskId: b.taskId,
      round: await readRoundBlob(b),
      roundRef,
      coverageCoreRef,
      mapCandidateRef: b.candidateRef,
      plan: mapPlanOf(b),
    });
    const workItemId = reviewBatchWorkItemId(b.roundId, 0);
    const reviewAssignmentId = reviewAssignmentIdOf(b.roundId, 0);
    const lease = await b.env.coordinator.leaseNext(b.taskId, 'worker-r', opId('lease-review-partial'));
    if (lease === null || lease.workItemId !== workItemId) throw new Error('expected the batch review workitem');
    const attemptId = lease.attemptId ?? '';
    const plan = mapPlanOf(b);
    const batch = plan.batches[0];
    const targets = [...batch.nodeIds, ...batch.relationIds];
    // Only the FIRST target is submitted — the freeze must reject the rest.
    const baselineTargetKinds: Record<string, ReviewFactV2['targetKind']> = {};
    for (const id of batch.nodeIds) baselineTargetKinds[id] = 'map_node';
    const records: ReviewDraftRecordV2[] = [
      { op: 'submit_map_node_review', body: { targetId: targets[0], verdict: 'pass', evidence: [], findingDrafts: [], crossScopeFindingDrafts: [] }, at: b.env.now.value },
    ];
    const result = buildReviewAssignmentFreeze({
      assignmentId: workItemId,
      workItemId,
      reviewAssignmentId,
      roundKind: 'map',
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
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('missing ordinary verdict'))).toBe(true);
    }
    // Zero publication happened.
    const events = await b.readEvents(b.taskId);
    expect(events.some((e) => e.type === 'structured_map_review_assignment_committed')).toBe(false);
  });

  it('the whole-map observation publishes layered observation events, not a batch assignment', async () => {
    const b = await makeReviewEnv();
    const { roundRef, coverageCoreRef } = await planRound(b);
    await b.coordinator.createRoundReviewWorkItems({
      taskId: b.taskId,
      round: await readRoundBlob(b),
      roundRef,
      coverageCoreRef,
      mapCandidateRef: b.candidateRef,
      plan: mapPlanOf(b),
    });
    await leaseAndCompleteWhole(b);
    const events = await b.readEvents(b.taskId);
    const observations = events.filter((e) => e.type === 'structured_map_observation_recorded');
    expect(observations.length).toBeGreaterThanOrEqual(1);
    const roots = observations.filter((o) => o.parentObservationId === null);
    expect(roots).toHaveLength(1);
    // The whole observation publishes observation events, NOT an additional
    // batch assignment (the batch workitem's own committed event is the only
    // assignment event; the whole workitem adds zero).
    const committedAssignments = events.filter((e) => e.type === 'structured_map_review_assignment_committed');
    expect(committedAssignments).toHaveLength(1);
    expect((committedAssignments[0] as { source: string }).source).toBe('batch');
  });

  it('Minor 3 (review): a crash between round-planned and WorkItem creation self-heals via ensureRoundReviewWorkItems', async () => {
    const b = await makeReviewEnv();
    // The round is planned but NO review WorkItems were created (crash window).
    const before = await b.readEvents(b.taskId);
    expect(before.some((e) => e.type === 'structured_work_item_created' && e.sessionKind?.startsWith('review_'))).toBe(false);
    const recreated = await b.service.ensureRoundReviewWorkItems(b.taskId, b.roundId);
    expect(recreated).toBe(true);
    const after = await b.readEvents(b.taskId);
    const reviewCreated = after.filter((e) => e.type === 'structured_work_item_created' && e.sessionKind?.startsWith('review_'));
    expect(reviewCreated).toHaveLength(b.assignmentCount + 1);
    // Idempotent: a second call finds everything present.
    const second = await b.service.ensureRoundReviewWorkItems(b.taskId, b.roundId);
    expect(second).toBe(false);
    // The round can now proceed to review + settlement.
    await leaseAndCompleteBatch(b);
    await leaseAndCompleteWhole(b);
    const result = await runSettlement(b);
    expect(result.kind).toBe('completed');
    expect(result.events.some((e) => e.type === 'structured_map_activated')).toBe(true);
  });

  it('the review workitems carry a review_observation grant spec (empty write authority)', async () => {
    const b = await makeReviewEnv();
    const { roundRef, coverageCoreRef } = await planRound(b);
    await b.coordinator.createRoundReviewWorkItems({
      taskId: b.taskId,
      round: await readRoundBlob(b),
      roundRef,
      coverageCoreRef,
      mapCandidateRef: b.candidateRef,
      plan: mapPlanOf(b),
    });
    const events = await b.readEvents(b.taskId);
    const created = events.filter((e) => e.type === 'structured_work_item_created' && e.sessionKind?.startsWith('review_'));
    expect(created).toHaveLength(b.assignmentCount + 1);
    for (const event of created) {
      const specRef = (event as { grantSpecRef: BlobRefV2 | null }).grantSpecRef;
      expect(specRef).not.toBeNull();
      const spec = (await b.resolver(b.taskId, specRef as BlobRefV2)) as { kind: string; reviewAssignmentId: string | null };
      expect(spec.kind).toBe(REVIEW_OBSERVATION_GRANT_KIND);
      expect(spec.reviewAssignmentId).not.toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Step 3: settlement DAG and Gate tests                               */
/* ------------------------------------------------------------------ */

describe('Map settlement DAG and activation', { timeout: 30_000 }, () => {
  it('a fully reviewed round activates the Map atomically with a baseline-unset manifest', async () => {
    const b = await makeReviewEnv();
    const { roundRef, coverageCoreRef } = await planRound(b);
    await b.coordinator.createRoundReviewWorkItems({
      taskId: b.taskId,
      round: await readRoundBlob(b),
      roundRef,
      coverageCoreRef,
      mapCandidateRef: b.candidateRef,
      plan: mapPlanOf(b),
    });
    await leaseAndCompleteBatch(b);
    await leaseAndCompleteWhole(b);
    const result = await runSettlement(b);
    expect(result.kind).toBe('completed');
    const events = result.events;
    const activated = events.find((e) => e.type === 'structured_map_activated');
    expect(activated).toBeDefined();
    const manifestEvent = events.find((e) => e.type === 'structured_content_revision_committed');
    expect(manifestEvent).toBeDefined();
    expect(manifestEvent?.manifestPhase).toBe('baseline_unset');
    // The activation order: round settled BEFORE map activated BEFORE manifest.
    const settledIndex = events.findIndex((e) => e.type === 'structured_map_review_round_settled');
    const activatedIndex = events.findIndex((e) => e.type === 'structured_map_activated');
    const manifestIndex = events.findIndex((e) => e.type === 'structured_content_revision_committed');
    expect(settledIndex).toBeGreaterThanOrEqual(0);
    expect(activatedIndex).toBeGreaterThan(settledIndex);
    expect(manifestIndex).toBeGreaterThan(activatedIndex);
    // The manifest resolves and covers every content-bearing node as unset.
    const manifestRef = (manifestEvent as { contentRevisionManifestRef: BlobRefV2 }).contentRevisionManifestRef;
    const manifest = (await b.resolver(b.taskId, manifestRef)) as { entries: { slotId: string }[]; manifestPhase: string; contentRootDigest: string };
    expect(manifest.entries.map((e) => e.slotId).sort()).toEqual(b.nodeIds.filter((id) => id !== 'root').sort());
    await parseBlob('content_revision_manifest', manifest, manifestRef);
  });

  it('the settlement DAG is acyclic: the coverage core is frozen WITHOUT the settlement aggregate', async () => {
    const b = await makeReviewEnv();
    const { roundRef, coverageCoreRef: plannedCoverageCoreRef } = await planRound(b);
    await b.coordinator.createRoundReviewWorkItems({
      taskId: b.taskId,
      round: await readRoundBlob(b),
      roundRef,
      coverageCoreRef: plannedCoverageCoreRef,
      mapCandidateRef: b.candidateRef,
      plan: mapPlanOf(b),
    });
    await leaseAndCompleteBatch(b);
    await leaseAndCompleteWhole(b);
    await runSettlement(b);
    const events = await b.readEvents(b.taskId);
    const completed = events.find((e) => e.type === 'structured_map_review_round_completed');
    const finalCoverageCoreRef = (completed as { coverageCoreRef: BlobRefV2 }).coverageCoreRef;
    const core = (await b.resolver(b.taskId, finalCoverageCoreRef)) as { settlementRef?: unknown };
    // The coverage core has NO settlement aggregate / settlement core ref.
    expect((core as { mapReviewSettlementValidatorAggregateRef?: unknown }).mapReviewSettlementValidatorAggregateRef).toBeUndefined();
    expect((core as { settlementCoreRef?: unknown }).settlementCoreRef).toBeUndefined();
  });

  it('a missing batch assignment blocks round completion and activation', async () => {
    // A two-assignment round (3 nodes with assignmentMaxPrimaryTargets=2): only
    // the first batch completes — the second batch is missing, so the round
    // cannot close.
    const b = await makeReviewEnv({ profile: fullProfileForTests({ assignmentMaxPrimaryTargets: 2, assignmentMaxTotalObjects: 8 }) });
    expect(b.assignmentCount).toBe(2);
    const { roundRef, coverageCoreRef } = await planRound(b);
    await b.coordinator.createRoundReviewWorkItems({
      taskId: b.taskId,
      round: await readRoundBlob(b),
      roundRef,
      coverageCoreRef,
      mapCandidateRef: b.candidateRef,
      plan: mapPlanOf(b),
    });
    await leaseAndCompleteBatch(b);
    const advanced = await b.service.maybeCompleteRound(b.taskId, b.roundId);
    expect(advanced).toBe(false);
    const events = await b.readEvents(b.taskId);
    expect(events.some((e) => e.type === 'structured_map_review_round_completed')).toBe(false);
    expect(events.some((e) => e.type === 'structured_map_activated')).toBe(false);
  });

  it('a missing whole-map observation blocks activation', async () => {
    const b = await makeReviewEnv();
    const { roundRef, coverageCoreRef } = await planRound(b);
    await b.coordinator.createRoundReviewWorkItems({
      taskId: b.taskId,
      round: await readRoundBlob(b),
      roundRef,
      coverageCoreRef,
      mapCandidateRef: b.candidateRef,
      plan: mapPlanOf(b),
    });
    await leaseAndCompleteBatch(b);
    // No whole-map observation.
    const advanced = await b.service.maybeCompleteRound(b.taskId, b.roundId);
    expect(advanced).toBe(false);
    const events = await b.readEvents(b.taskId);
    expect(events.some((e) => e.type === 'structured_map_activated')).toBe(false);
  });

  it('Minor 1 (review): a degenerate root-only observation does NOT complete the round (leaf coverage gate)', async () => {
    const b = await makeReviewEnv();
    const { roundRef, coverageCoreRef } = await planRound(b);
    await b.coordinator.createRoundReviewWorkItems({
      taskId: b.taskId,
      round: await readRoundBlob(b),
      roundRef,
      coverageCoreRef,
      mapCandidateRef: b.candidateRef,
      plan: mapPlanOf(b),
    });
    await leaseAndCompleteBatch(b);
    // Publish ONLY a root observation event (level 1, no children) — the
    // leaf-observation union covers nothing, so the round must NOT close.
    const { mapReviewCarrier: carrier } = await import('./map-review-service');
    const obsRef = await b.env.facade.prepareBlob(b.taskId, 'content_value', authoritativeTestContentValue('degenerate root observation'));
    const tail = await b.env.eventStore.tail(b.taskId);
    await b.env.facade.publishWithPin({
      taskId: b.taskId,
      operationId: `obs-degenerate-${b.roundId}`,
      payload: {
        family: 'domain_publish',
        operationId: `obs-degenerate-${b.roundId}`,
        taskId: b.taskId,
        publishKind: 'review_assignment_commit',
        blobRefs: [],
        expectedResultIdentity: 'x',
        mapBuild: null,
        contentPlan: null,
        contentReview: null,
        repair: null,
        mapReview: carrier({
          mapReviewRoundId: b.roundId,
          observations: [{ observationId: 'obs-root-only', level: 1, parentObservationId: null, observationRef: obsRef, coveredTargetCount: 1, childObservationRefs: [] }],
        }),
      },
      intent: { handlerKind: 'review_assignment_commit', handlerVersion: 1 },
      preparedRefs: [obsRef],
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    const advanced = await b.service.maybeCompleteRound(b.taskId, b.roundId);
    expect(advanced).toBe(false);
    const events = await b.readEvents(b.taskId);
    expect(events.some((e) => e.type === 'structured_map_review_round_completed')).toBe(false);
    expect(events.some((e) => e.type === 'structured_map_activated')).toBe(false);
  });

  it('a blocking map_activation validator rejects activation (old Map/content stay current)', async () => {
    const b = await makeReviewEnv();
    const { roundRef, coverageCoreRef } = await planRound(b);
    await b.coordinator.createRoundReviewWorkItems({
      taskId: b.taskId,
      round: await readRoundBlob(b),
      roundRef,
      coverageCoreRef,
      mapCandidateRef: b.candidateRef,
      plan: mapPlanOf(b),
    });
    await leaseAndCompleteBatch(b);
    await leaseAndCompleteWhole(b);
    const advanced = await b.service.maybeCompleteRound(b.taskId, b.roundId);
    expect(advanced).toBe(true);
    // Override the service's registrations to a validator that rejects activation.
    const settlementWorkItemId = deterministicSettlementWorkItemId(b.taskId, b.roundId);
    const lease = await b.env.coordinator.leaseNext(b.taskId, 'worker-s', opId('lease-settlement'));
    if (lease === null || lease.workItemId !== settlementWorkItemId) throw new Error('expected the settlement workitem');
    const blockingService = new MapReviewService({
      facade: b.env.facade,
      reviewCoordinator: b.coordinator,
      readProjection: b.env.readProjection,
      resolver: b.resolver,
      tail: (id) => b.env.eventStore.tail(id),
      readEvents: async (id) => (await b.env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
      committedOperation: async (id, operationId) => null,
      clock: () => b.env.now.value,
      profile: PROFILE,
      profileBody: PROFILE_BODY,
      validatorRegistry: REVIEW_REGISTRY,
      sourceResolver: reviewSourceResolver,
      registrationsFor: (trigger) => {
        if (trigger === 'map_activation') {
          return [testRegistrationFor('map_activation', BLOCKING_ACTIVATION_SOURCE, 'v-activation-blocking', '.blocking')];
        }
        return [testRegistrationFor(trigger, SETTLEMENT_SOURCE, `v-${trigger}`)];
      },
      reviewPolicy: { mapReview: 'required', contentSelector: 'content_bearing', mapBatchTargetSlots: 24, contentBatchTargetSlots: 24, assignmentSoftLimit: 64, wholeMapObservation: 'required', wholeContentTreeObservation: 'required', reviewAdvisoryRelations: false, maxRounds: 8 },
      reviewPolicyDigest: b.reviewPolicyDigest,
      templateSnapshotRef: b.templateSnapshotRef,
      profileSnapshotRef: b.profileSnapshotRef,
      snapshotHash: b.snapshotHash,
      reviewerRoleBinding: 'reviewer',
      generatorRoleBinding: 'generator',
      orchestratorRoleBinding: 'orchestrator',
    });
    const outcome = await blockingService.executeMapReviewSettlement({
      taskId: b.taskId,
      commandId: lease.commandId ?? '',
      workItemId: settlementWorkItemId,
      commandKind: 'review_settlement',
      leaseEpoch: lease.leaseEpoch,
      authorityBaseRef: lease.authorityBaseRef,
      payloadRef: (await b.readEvents(b.taskId)).find(
        (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_round_completed' }> =>
          e.type === 'structured_map_review_round_completed' && e.mapReviewRoundId === b.roundId,
      )?.coverageCoreRef ?? (await b.readEvents(b.taskId))[0] as never,
    });
    expect(outcome.kind).toBe('retryable_failure');
    const events = await b.readEvents(b.taskId);
    expect(events.some((e) => e.type === 'structured_map_activated')).toBe(false);
    expect(events.some((e) => e.type === 'structured_content_revision_committed')).toBe(false);
    expect(events.some((e) => e.type === 'structured_work_item_created' && e.sessionKind === 'generation_batch')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Step 4: candidate replacement / authority tests                     */
/* ------------------------------------------------------------------ */

describe('first-activation authority and equal-semantic/different-ref invalidation', { timeout: 30_000 }, () => {
  it('activates a MapSnapshot whose mapSemanticDigest differs from the snapshot ref, and the manifest binds the EXACT snapshot ref', async () => {
    const b = await makeReviewEnv();
    const { roundRef, coverageCoreRef } = await planRound(b);
    await b.coordinator.createRoundReviewWorkItems({
      taskId: b.taskId,
      round: await readRoundBlob(b),
      roundRef,
      coverageCoreRef,
      mapCandidateRef: b.candidateRef,
      plan: mapPlanOf(b),
    });
    await leaseAndCompleteBatch(b);
    await leaseAndCompleteWhole(b);
    await runSettlement(b);
    const events = await b.readEvents(b.taskId);
    const activated = events.find((e) => e.type === 'structured_map_activated');
    const snapshotRef = (activated as { mapSnapshotRef: BlobRefV2 }).mapSnapshotRef;
    const snapshot = (await b.resolver(b.taskId, snapshotRef)) as { mapSemanticDigest: string; mapId: string; mapReviewBundleRef: BlobRefV2 };
    // mapSemanticDigest is NOT the snapshot ref digest (spec §7.2).
    expect(snapshot.mapSemanticDigest).not.toBe(snapshotRef.digest);
    // The MapSnapshot's mapReviewBundleRef resolves to a MapReviewBundle with an
    // acyclic DAG (settlement core -> proposed map core -> activation aggregate).
    const bundle = (await b.resolver(b.taskId, snapshot.mapReviewBundleRef)) as { settlementCoreRef: BlobRefV2; proposedMapCoreRef: BlobRefV2; mapActivationValidatorAggregateRef: BlobRefV2; bundleDigest: string };
    expect(bundle.settlementCoreRef.kind).toBe('map_review_settlement_core');
    expect(bundle.proposedMapCoreRef.kind).toBe('proposed_map_core');
    await parseBlob('map_review_bundle', bundle, snapshot.mapReviewBundleRef);
    // The manifest binds the EXACT snapshot ref (equal semantic digest with a
    // new snapshot ref is still a different authority revision).
    const manifestEvent = events.find((e) => e.type === 'structured_content_revision_committed');
    const manifest = (await b.resolver(b.taskId, (manifestEvent as { contentRevisionManifestRef: BlobRefV2 }).contentRevisionManifestRef)) as { mapRef: BlobRefV2; mapSemanticDigest: string };
    expect(manifest.mapRef.digest).toBe(snapshotRef.digest);
    expect(manifest.mapSemanticDigest).toBe(snapshot.mapSemanticDigest);
    // A candidate with the same semantic digest but a NEW snapshot ref would be
    // a different authority revision — the manifest mapRef is exact.
    const otherRef = { ...snapshotRef, digest: '0'.repeat(64) };
    expect(manifest.mapRef.digest).not.toBe(otherRef.digest);
  });
});

/* ------------------------------------------------------------------ */
/* Step 7: no content generation before activation                     */
/* ------------------------------------------------------------------ */

describe('no content generation before activation', { timeout: 30_000 }, () => {
  it('no generation WorkItem/attempt/event precedes structured_map_activated with a clear MapReviewBundle', async () => {
    const b = await makeReviewEnv();
    const { roundRef, coverageCoreRef } = await planRound(b);
    await b.coordinator.createRoundReviewWorkItems({
      taskId: b.taskId,
      round: await readRoundBlob(b),
      roundRef,
      coverageCoreRef,
      mapCandidateRef: b.candidateRef,
      plan: mapPlanOf(b),
    });
    await leaseAndCompleteBatch(b);
    await leaseAndCompleteWhole(b);
    const result = await runSettlement(b);
    expect(result.kind).toBe('completed');
    const events = result.events;
    const activatedIndex = events.findIndex((e) => e.type === 'structured_map_activated');
    expect(activatedIndex).toBeGreaterThanOrEqual(0);
    // The first generation_batch WorkItem is created IN the activation envelope
    // (after map_activated); no generation attempt/event precedes it.
    const generationCreated = events.find((e) => e.type === 'structured_work_item_created' && e.sessionKind === 'generation_batch');
    expect(generationCreated).toBeDefined();
    expect(events.findIndex((e) => e === generationCreated)).toBeGreaterThan(activatedIndex);
    expect(events.some((e) => e.type === 'structured_generation_batch_committed')).toBe(false);
    const attempts = events.filter((e) => e.type === 'structured_agent_attempt_started_v2' && e.sessionKind === 'generation_batch');
    expect(attempts).toHaveLength(0);
    // A clear MapReviewBundle exists on the activated Map.
    const activated = events.find((e) => e.type === 'structured_map_activated');
    const snapshot = (await b.resolver(b.taskId, (activated as { mapSnapshotRef: BlobRefV2 }).mapSnapshotRef)) as { mapReviewBundleRef: BlobRefV2 };
    expect(snapshot.mapReviewBundleRef.kind).toBe('map_review_bundle');
  });

  it('the first generation-batch WorkItem carries the initial_generation_batch grant bound to the active Map + baseline manifest', async () => {
    const b = await makeReviewEnv();
    const { roundRef, coverageCoreRef } = await planRound(b);
    await b.coordinator.createRoundReviewWorkItems({
      taskId: b.taskId,
      round: await readRoundBlob(b),
      roundRef,
      coverageCoreRef,
      mapCandidateRef: b.candidateRef,
      plan: mapPlanOf(b),
    });
    await leaseAndCompleteBatch(b);
    await leaseAndCompleteWhole(b);
    await runSettlement(b);
    const events = await b.readEvents(b.taskId);
    const generationCreated = events.find((e) => e.type === 'structured_work_item_created' && e.sessionKind === 'generation_batch');
    const grantSpecRef = (generationCreated as { grantSpecRef: BlobRefV2 }).grantSpecRef;
    const grant = (await b.resolver(b.taskId, grantSpecRef)) as { kind: string; activeMapRef: BlobRefV2; expectedContentRevisionManifestRef: BlobRefV2; writeSlotIds: string[] };
    expect(grant.kind).toBe('initial_generation_batch');
    const activated = events.find((e) => e.type === 'structured_map_activated');
    expect(grant.activeMapRef.digest).toBe((activated as { mapSnapshotRef: BlobRefV2 }).mapSnapshotRef.digest);
    const manifestEvent = events.find((e) => e.type === 'structured_content_revision_committed');
    expect(grant.expectedContentRevisionManifestRef.digest).toBe((manifestEvent as { contentRevisionManifestRef: BlobRefV2 }).contentRevisionManifestRef.digest);
  });
});
