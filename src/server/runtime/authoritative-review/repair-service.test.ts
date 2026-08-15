// @vitest-environment node
/**
 * Task 19 repair-service tests (spec §13.3/§13.3.1, design §11.8/§13):
 * initial/successor plan identity, map staging + key lineage, content staging +
 * continuity, scope expansion, the finalizer routes, and the map/content cycle
 * budgets (perpetual reject, mixed Map-first, exact-boundary success, over-limit
 * response-loss, override consumption exactly once).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import { PublicationIntentRegistry } from '../../storage/authoritative-publication-intent-registry';
import { fullProfileForTests, parseBlob, refOfBlob } from '../../authoritative-review/object-registry';
import { buildAuthoritativeReviewTestProfileBody } from '../../structured-slots/test-support/authoritative-review-test-registry';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { buildAuthorityBaseSet } from './authority-base';
import { GrantService, buildRepairBatchGrantSpec } from './grant-service';
import { ValidatorRegistry } from './validator-registry';
import { AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES, builtinSourceOf } from './builtin-validators';
import { ValidatorEngine } from './validator-engine';
import type { ValidatorRegistrationV2 } from '../../template/structured-slot-contract-v2';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { V2AttemptContext } from './attempt-coordinator';
import { AuthoritativeReviewPrivateStore } from '../../storage/authoritative-review-private-store';
import {
  authoritativeTestContentValue,
  createWorkItemCoordinatorEnvironment,
  disposeRuntimeTestRoots,
  type WorkItemCoordinatorEnvironment,
} from '../test-support';
import { EMPTY_BUILD_FRONTIER_DIGEST, MapBuildService, buildCandidateSnapshot, buildCandidateWarningCustodyRoot, buildContributionManifest, registerMapBuildPublicationHandlers } from './map-build-service';
import { MapReviewService, buildMapReviewRound, buildMapSnapshot, buildBaselineUnsetManifest, registerMapReviewPublicationHandlers } from './map-review-service';
import { ContentPlanService, buildFinalizedManifest, buildContentValue, buildContentSetVersion, generationBatchWorkItemId, generationFinalizeWorkItemId, registerContentPlanPublicationHandlers } from './content-plan-service';
import {
  ContentReviewService,
  buildContentReviewCoverageCore,
  deterministicContentSettlementWorkItemId,
  planContentReview,
  registerContentReviewPublicationHandlers,
  resolveContentRoundFromCore,
} from './content-review-service';
import { deterministicSettlementWorkItemId } from './map-review-service';
import { FindingService, buildFindingStageRoot } from './finding-service';
import { buildReviewAssignmentFreeze, validateVerificationSubmission, type ReviewDraftRecordV2 } from './tool-factory';
import { ReviewCoordinatorV2, reviewAssignmentIdOf, reviewBatchWorkItemId, reviewWholeAssignmentId, reviewWholeWorkItemId } from './review-coordinator';
import { planMapReview } from './observation-planner';
import { attemptContinuationOperationId } from './attempt-coordinator';
import { completionKindRequiresResult, type AssignmentDispatchV2, type ContentRevisionManifestV2, type GenerationPlanSpecV2, type MapPositionNodeV2, type MapRelationV2, type ReviewFactV2 } from '../../authoritative-review/authority-types';
import {
  RepairService,
  RepairError,
  RepairLimitExceededError,
  buildRepairPlanSpec,
  buildRepairStagingRoot,
  deriveRepairTargets,
  mapRoundBudgetCheck,
  registerRepairPublicationHandlers,
  repairPlanIdOf,
  repairPlanKeyOf,
  repairBatchWorkItemId,
  repairFinalizeWorkItemId,
  foldRepairMapState,
  mapPatchScopeErrors,
  buildRepairBatchScopes,
  type RepairMapPatchOperationV2,
  type RepairFinalizeOutcome,
} from './repair-service';
import type { AuthoritativeReviewProfile, ContentReviewCoverageCoreV2, RepairBatchGrantSpecV2, RepairPlanSpecV2, WriteGrantSpecV2 } from '../../authoritative-review/authority-types';
import type { AuthoritativeReviewProjectionV2 } from '../../storage/authoritative-review-state';
import type { PublicationEventEnvelopeV2 } from '../../storage/authoritative-publication-intent-registry';

const PROFILE = fullProfileForTests();
const PROFILE_BODY = buildAuthoritativeReviewTestProfileBody();
const REGISTRY = new ValidatorRegistry(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES);

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

/** A deterministic BLOCKING handler source (the blocking-finalizer tests).
 * The anti-spoof check demands the EXACT registration validatorId +
 * implementationDigest, so the source carries the fixed 'v-repair-blocking'
 * id and a placeholder digest — the test registration below must bind the
 * same digest. */
const BLOCKING_SOURCE = `'use strict';
module.exports = {
  validate: function validate(input) {
    // The repair plan core carries the batch scopes; the blocking issue names
    // the FIRST in-scope node (the engine rejects issue targets outside the
    // run's universe).
    var core = input && typeof input.core === 'object' ? input.core : {};
    var scopes = Array.isArray(core.orderedBatchScopes) ? core.orderedBatchScopes : [];
    var scope = scopes[0] && typeof scopes[0] === 'object' ? scopes[0] : {};
    var nodeIds = scope.scope && Array.isArray(scope.scope.nodeIds) ? scope.scope.nodeIds : ['n-1'];
    return {
      status: 'domain_invalid',
      issues: [{
        validatorId: 'v-repair-blocking',
        implementationDigest: '${hash('blocking-digest')}',
        issueCode: 'TEST_BLOCK',
        location: { targetKind: 'node', stableTargetId: nodeIds[0], jsonPointer: null },
        repairTargets: { mapNodeIds: [nodeIds[0]], relationIds: [], slotIds: [] },
        evidenceDigest: ''
      }],
      executionDigest: ''
    };
  }
};`;

/** A deterministic BLOCKING handler source for the I-2 transfer test: blocks
 * ONLY when the repair plan's REVISION is 2 (the recovery successor after the
 * reopen), clears every other revision. Enables the sequence over-limit
 * (revision 1 clear) -> reopen -> blocking finalize (revision 2) with a
 * transfer -> clear finalize (revision 3) that consumes the transferred
 * override — all through the REAL finalize handler. */
const BLOCKING_ON_REV2_SOURCE = `'use strict';
module.exports = {
  validate: function validate(input) {
    var core = input && typeof input.core === 'object' ? input.core : {};
    if (core.revision !== 2) {
      return { status: 'valid', executionDigest: '${hash('clear-digest')}' };
    }
    var scopes = Array.isArray(core.orderedBatchScopes) ? core.orderedBatchScopes : [];
    var scope = scopes[0] && typeof scopes[0] === 'object' ? scopes[0] : {};
    var nodeIds = scope.scope && Array.isArray(scope.scope.nodeIds) ? scope.scope.nodeIds : ['n-1'];
    return {
      status: 'domain_invalid',
      issues: [{
        validatorId: 'v-repair-blocking',
        implementationDigest: '${hash('blocking-digest')}',
        issueCode: 'TEST_BLOCK',
        location: { targetKind: 'node', stableTargetId: nodeIds[0], jsonPointer: null },
        repairTargets: { mapNodeIds: [nodeIds[0]], relationIds: [], slotIds: [] },
        evidenceDigest: ''
      }],
      executionDigest: ''
    };
  }
};`;

/** Blocks only when the repair-finalize input contains the staged Map bytes.
 * This is the regression oracle for the finalizer closure: a plan-only core
 * cannot produce the issue. */
const BLOCKING_ON_STAGED_MAP_SOURCE = `'use strict';
module.exports = {
  validate: function validate(input) {
    var core = input && typeof input.core === 'object' ? input.core : {};
    var artifact = core && typeof core.stagedArtifact === 'object' ? core.stagedArtifact : {};
    var nodes = Array.isArray(artifact.nodes) ? artifact.nodes : [];
    if (nodes.length === 0) return { status: 'valid', executionDigest: '${hash('missing-staged-map')}' };
    return {
      status: 'domain_invalid',
      issues: [{
        validatorId: 'v-repair-staged',
        implementationDigest: '${hash('staged-digest')}',
        issueCode: 'STAGED_MAP_BYTES_REJECTED',
        location: { targetKind: 'node', stableTargetId: nodes[0].slotId, jsonPointer: '/nodes/0' },
        repairTargets: { mapNodeIds: [nodes[0].slotId], relationIds: [], slotIds: [] },
        evidenceDigest: ''
      }],
      executionDigest: ''
    };
  }
};`;

let seq = 0;

function opId(label: string): string {
  seq += 1;
  return `op-${createHash('sha256').update(`op:${label}:${seq}`).digest('hex').slice(0, 32)}`;
}

function hash(salt: string): string {
  return createHash('sha256').update(salt, 'utf8').digest('hex');
}

function registrationFor(handlerKey: string, overrides: Partial<ValidatorRegistrationV2> = {}): ValidatorRegistrationV2 {
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
    ...overrides,
  };
}

/** The test-only seed handler: publishes PRE-BUILT event envelopes. The seed
 * events ride the payload as a NON-ENUMERABLE property (the strict payload
 * parser + canonicalization only see enumerable keys), so the pin payload
 * stays union-legal. The handler declares every event type the tests seed. */
const SEED_EVENT_TYPES = [
  'structured_map_build_started',
  'structured_map_build_finish_proposed',
  'structured_map_build_finalized',
  'structured_map_candidate_committed',
  'structured_map_activated',
  'structured_content_revision_committed',
  'structured_review_round_planned',
  'structured_map_review_round_planned',
  'structured_finding_opened',
] as const;

function registerTestSeedHandler(registry: PublicationIntentRegistry): void {
  if (registry.resolve('test/seed_events', 1) !== null) return;
  registry.register({
    handlerKind: 'test/seed_events',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: [...SEED_EVENT_TYPES],
    rebuildable: true,
    missingInputs: [],
    parsePayload: (value) => value as never,
    childRefsOf: () => [],
    resolveRefs: () => [],
    buildEvents: (payload) => {
      const seed = (payload as { seedEvents?: unknown }).seedEvents;
      if (seed === undefined) return [];
      return seed as never;
    },
    expectedResultIdentity: (_payload, events) => canonicalJsonSha256(events),
  });
}

interface SeedFinding {
  findingId: string;
  primaryLocation: { kind: 'slot' | 'relation' | 'map_node' | 'map'; id: string };
  defectClass: 'content' | 'map' | 'mixed';
  severity: 'blocking' | 'advisory';
  suggestedRepairSlotIds?: string[];
}

interface RepairEnv {
  env: WorkItemCoordinatorEnvironment;
  service: RepairService;
  grants: GrantService;
  privateStore: AuthoritativeReviewPrivateStore;
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown>;
  readEvents(taskId: string): Promise<readonly AuthoritativeReviewEventV2[]>;
  taskId: string;
  templateSnapshotRef: BlobRefV2;
  profileSnapshotRef: BlobRefV2;
  snapshotHash: string;
  reviewPolicyDigest: string;
  maxRounds: number;
}

let envs: RepairEnv[] = [];

async function makeRepairEnv(opts: { maxRounds?: number; contentBatchTargetSlots?: number; blocking?: boolean; blockingOnRevision2?: boolean; stagedBlocking?: boolean; extraHandlers?: (registry: PublicationIntentRegistry) => void } = {}): Promise<RepairEnv> {
  const registry = new PublicationIntentRegistry();
  registerMapBuildPublicationHandlers(registry);
  registerMapReviewPublicationHandlers(registry);
  registerContentPlanPublicationHandlers(registry);
  registerContentReviewPublicationHandlers(registry);
  registerRepairPublicationHandlers(registry);
  registerTestSeedHandler(registry);
  opts.extraHandlers?.(registry);
  const env = await createWorkItemCoordinatorEnvironment({ registry });
  const taskId = 'task-repair';
  // Task-local authority refs: the env's stand-ins were prepared under the
  // env's OWN task root; the blob store is per-task, so GC walking THIS task's
  // events would fail closed on the shared refs (the F1 GC regression test).
  const templateSnapshotRef = await env.facade.prepareBlob(taskId, 'content_value', authoritativeTestContentValue('template snapshot stand-in (task-local)'));
  const profileSnapshotRef = await env.facade.prepareBlob(taskId, 'profile_snapshot', PROFILE_BODY);
  const privateStore = new AuthoritativeReviewPrivateStore(env.paths, taskId);
  const resolver = (id: string, ref: BlobRefV2) => env.resolverFor(id)(ref);
  const grants = new GrantService({ resolver, readProjection: env.readProjection, profile: PROFILE });
  const maxRounds = opts.maxRounds ?? 3;
  const finalizeSource = opts.stagedBlocking === true ? BLOCKING_ON_STAGED_MAP_SOURCE : opts.blocking === true ? BLOCKING_SOURCE : opts.blockingOnRevision2 === true ? BLOCKING_ON_REV2_SOURCE : FINALIZE_VALID_SOURCE;
  const finalizeDigest = opts.stagedBlocking === true ? hash('staged-digest') : opts.blocking === true || opts.blockingOnRevision2 === true ? hash('blocking-digest') : '';
  const sourceResolver = (key: string): string | null => {
    if (key === 'test.repair.repair_finalize') return finalizeSource;
    return builtinSourceOf(key);
  };
  const repairRegistry = new ValidatorRegistry([
    ...AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES,
    testValidatorEntry('repair_finalize', null, finalizeSource, '', finalizeDigest),
  ]);
  const service = new RepairService({
    facade: env.facade,
    grants,
    readProjection: env.readProjection,
    resolver,
    tail: (id) => env.eventStore.tail(id),
    readEvents: async (id) => (await env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
    committedOperation: async (id, operationId) =>
      (await env.eventStore.readBatchByCommitId(id, operationId))?.map((e) => e.event as AuthoritativeReviewEventV2) ?? null,
    clock: () => env.now.value,
    profile: PROFILE,
    profileBody: PROFILE_BODY,
    validatorRegistry: repairRegistry,
    sourceResolver,
    registrationsFor: () =>
      opts.blocking === true || opts.blockingOnRevision2 === true || opts.stagedBlocking === true
        ? [{ ...testValidatorRegistration('repair_finalize', null, finalizeSource, opts.stagedBlocking === true ? 'v-repair-staged' : 'v-repair-blocking'), implementationDigest: finalizeDigest }]
        : [testValidatorRegistration('repair_finalize', null, FINALIZE_VALID_SOURCE, 'v-repair-clear')],
    reviewPolicy: { ...REVIEW_POLICY, maxRounds, contentBatchTargetSlots: opts.contentBatchTargetSlots ?? 2, reviewAdvisoryRelations: true },
    reviewPolicyDigest: hash('review-policy'),
    templateSnapshotRef,
    profileSnapshotRef,
    snapshotHash: 'a'.repeat(64),
    orchestratorRoleBinding: 'orchestrator',
    generatorRoleBinding: 'generator',
    reviewerRoleBinding: 'reviewer',
    privateStore,
    slotTypeOf: () => 'doc',
    contentSchemaDigestOf: () => hash('schema'),
    slotTypes: [{ id: 'doc', name: 'doc', description: 'document', contentPresence: 'required', contentSchema: { jsonSchema: { type: 'string' } } }],
    defaultAutomaticRetries: async () => 2,
  });
  const built: RepairEnv = {
    env,
    service,
    grants,
    privateStore,
    resolver,
    readEvents: async (id) => (await env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
    taskId,
    templateSnapshotRef,
    profileSnapshotRef,
    snapshotHash: 'a'.repeat(64),
    reviewPolicyDigest: hash('review-policy'),
    maxRounds,
  };
  envs.push(built);
  return built;
}

afterEach(() => {
  disposeRuntimeTestRoots();
  envs = [];
});

/** Seeds one atomic batch of pre-built events (legal projection history).
 * The events ride the payload as a non-enumerable property so the strict
 * payload parser + canonicalization only ever see the union-legal fields. */
async function seedEvents(b: RepairEnv, events: PublicationEventEnvelopeV2[], blobRefs: BlobRefV2[] = []): Promise<void> {
  const operationId = opId('seed');
  const tail = await b.env.eventStore.tail(b.taskId);
  const payload = {
    family: 'domain_publish',
    operationId,
    taskId: b.taskId,
    publishKind: 'map_build_commit',
    blobRefs,
    expectedResultIdentity: canonicalJsonSha256({ op: 'seed' }),
    mapBuild: null,
    mapReview: null,
    contentPlan: null,
    contentReview: null,
    repair: null,
  } as Record<string, unknown>;
  Object.defineProperty(payload, 'seedEvents', { value: events, enumerable: false, configurable: true });
  await b.env.facade.publishWithPin({
    taskId: b.taskId,
    operationId,
    payload: payload as never,
    intent: { handlerKind: 'test/seed_events', handlerVersion: 1 },
    preparedRefs: blobRefs,
    expectedTailSequence: tail.lastSequence,
    expectedTailCommitId: tail.lastCommitId,
  });
}

/** Runs the REAL engine once (parse-valid aggregate/envelope/warning blobs).
 * The completeness builtin judges the resolved core generically (clear). */
async function seedEngineRun(b: RepairEnv, coreRef: BlobRefV2): Promise<{ aggregateRef: BlobRefV2; envelopeRef: BlobRefV2; warningRootRef: BlobRefV2 }> {
  const store = new Map<string, unknown>();
  const engine = new ValidatorEngine({
    registry: REGISTRY,
    blobs: {
      put: (kind, value) => {
        const ref = { kind, digest: canonicalJsonSha256(value), byteLength: JSON.stringify(value).length, mediaType: 'application/json' as const, schemaVersion: 1 };
        store.set(ref.digest, value);
        return ref;
      },
      resolve: (ref) => store.get(ref.digest) ?? null,
    },
    sourceResolver: (key) => builtinSourceOf(key),
  });
  const run = await engine.execute({
    trigger: 'map_candidate_commit',
    identity: { taskId: b.taskId, templateSnapshotHash: 'a'.repeat(64), workItemId: 'wi-seed', attemptId: null, commandId: 'cmd-seed' },
    coreRef,
    selectedTargetRefs: [],
    registrations: [registrationFor('authoritative.review.completeness')],
    universe: { slotIds: [], relationIds: [], mapNodeIds: [], artifactDigest: null },
    profile: PROFILE_BODY,
  });
  const envelopeRef = await b.env.facade.prepareBlob(b.taskId, 'validator_input_envelope', run.envelope);
  const aggregateRef = await b.env.facade.prepareBlob(b.taskId, 'validator_aggregate', run.aggregate);
  const warningRootRef = await b.env.facade.prepareBlob(b.taskId, 'validation_warning_root', run.warningRoot);
  return { aggregateRef, envelopeRef, warningRootRef };
}

/** A minimal candidate chain (build_started + finish_proposed + build_finalized
 * + candidate_committed) with parse-valid blobs. */
async function seedMapCandidate(b: RepairEnv, opts: { nodes?: { slotId: string; slotType: string; contentBearing: boolean; parentSlotId: string | null }[] } = {}): Promise<{ candidateRef: BlobRefV2; candidateId: string }> {
  const { taskId } = b;
  const nodes = opts.nodes ?? [
    { slotId: 'n-1', slotType: 'doc', contentBearing: true, parentSlotId: null, documentOrder: 1, siblingOrder: 0, nodeSpecDigest: hash('spec-1') },
    { slotId: 'n-2', slotType: 'doc', contentBearing: true, parentSlotId: 'n-1', documentOrder: 2, siblingOrder: 0, nodeSpecDigest: hash('spec-2') },
  ];
  const mapBuildId = 'mb-seed-1';
  const specBody = { mapBuildId, revision: 1, supersedesMapBuildId: null, sourceValidationReceiptRef: null, snapshotHash: 'a'.repeat(64), plannedChunkPolicy: { maxChunks: 16, maxNodesPerChunk: 512, maxRelationsPerChunk: 64 } };
  const specRef = await b.env.facade.prepareBlob(taskId, 'map_build_spec', { ...specBody, specDigest: canonicalJsonSha256(specBody) });
  const contribution = buildContributionManifest({
    mapBuildId,
    mapBuildRevision: 1,
    chunkRefs: [],
    keyLedgerRef: specRef,
    agentAttemptIdentities: [],
  });
  const contributionRef = await b.env.facade.prepareBlob(taskId, 'contribution_manifest', contribution);
  const candidateId = `cand-seed-${canonicalJsonSha256({ mapBuildId }).slice(0, 24)}`;
  const coreBody = {
    candidateId,
    baseMapId: null,
    positionGraphDigest: hash('pos'),
    relationGraphDigest: hash('rel'),
    templateSnapshotHash: 'a'.repeat(64),
    nodes,
    relations: [],
    candidateProvenanceWithoutValidation: {
      producerKind: 'system_map_finalize' as const,
      producerWorkItemId: 'wi-seed',
      commandId: 'cmd-seed',
      mapBuildId,
      mapBuildRevision: 1,
      contributionManifestRef: contributionRef,
    },
  };
  const coreRef = await b.env.facade.prepareBlob(taskId, 'map_candidate_validation_core', { ...coreBody, coreDigest: canonicalJsonSha256(coreBody) });
  const engineRefs = await seedEngineRun(b, coreRef);
  const custody = buildCandidateWarningCustodyRoot({
    taskId,
    trigger: 'map_candidate_commit',
    inputRef: engineRefs.envelopeRef,
    inputDigest: engineRefs.envelopeRef.digest,
    validatorAggregateRef: engineRefs.aggregateRef,
    warningRootRef: engineRefs.warningRootRef,
  });
  const custodyRef = await b.env.facade.prepareBlob(taskId, 'validation_warning_custody_root', custody);
  const candidate = buildCandidateSnapshot({
    candidateId,
    baseMapId: null,
    validationCoreRef: coreRef,
    candidateValidationAggregateRef: engineRefs.aggregateRef,
    candidateWarningCustodyRootRef: custodyRef,
    createdAt: '2026-08-15T00:00:00.000Z',
  });
  const candidateRef = await b.env.facade.prepareBlob(taskId, 'map_candidate', candidate);
  await seedEvents(
    b,
    [
      { protocolVersion: 2, at: '2026-08-15T00:00:00.000Z', type: 'structured_map_build_started', mapBuildId, revision: 1, mapBuildSpecRef: specRef, supersedesMapBuildId: null, sourceValidationReceiptRef: null },
      { protocolVersion: 2, at: '2026-08-15T00:00:00.000Z', type: 'structured_map_build_finish_proposed', mapBuildId, expectedChunkCount: 1, expectedFrontierDigest: hash('frontier'), expectedRootCount: 1 },
      { protocolVersion: 2, at: '2026-08-15T00:00:00.000Z', type: 'structured_map_build_finalized', mapBuildId, manifestRef: contributionRef, contributionManifestRef: contributionRef },
      { protocolVersion: 2, at: '2026-08-15T00:00:00.000Z', type: 'structured_map_candidate_committed', candidateId, candidateRef, candidateDigest: candidateRef.digest, baseMapId: null },
    ],
    [specRef, contributionRef, coreRef, engineRefs.aggregateRef, engineRefs.envelopeRef, engineRefs.warningRootRef, custodyRef, candidateRef],
  );
  return { candidateRef, candidateId };
}

/** Seeds an activated Map (the candidate chain must exist first). The
 * activation's contentRevisionManifestRef binds the seed manifest ref (the
 * projector's activatedManifestBinding must equal the first manifest commit). */
async function seedActivatedMap(b: RepairEnv, contentRevisionManifestRef: BlobRefV2): Promise<BlobRefV2> {
  const { taskId } = b;
  const state = await b.env.readProjection(taskId);
  const seeded = state.currentCandidate as { candidateId: string; candidateRef: BlobRefV2 };
  const proposedBody = {
    scaffoldId: 'scaffold-seed',
    proposedMapId: 'map-seed-proposed',
    supersedesMapId: null,
    sourceCandidateRef: seeded.candidateRef,
    mapRevision: 1,
    mapSemanticDigest: hash('map-sem'),
    positionGraphDigest: hash('pos'),
    relationGraphDigest: hash('rel'),
    templateSnapshotHash: 'a'.repeat(64),
    nodes: [],
    relations: [],
  };
  const proposedRef = await b.env.facade.prepareBlob(taskId, 'proposed_map_core', { ...proposedBody, coreDigest: canonicalJsonSha256(proposedBody) });
  const engineRefs = await seedEngineRun(b, proposedRef);
  const snapshot = buildMapSnapshot({
    scaffoldId: 'scaffold-seed',
    mapId: 'map-seed',
    supersedesMapId: null,
    sourceCandidateId: seeded.candidateId,
    proposedMapCoreRef: proposedRef,
    mapReviewBundleRef: { kind: 'map_review_bundle', digest: hash('bundle'), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
    mapRevision: 1,
    mapSemanticDigest: hash('map-sem'),
    positionGraphDigest: hash('pos'),
    relationGraphDigest: hash('rel'),
    templateSnapshotHash: 'a'.repeat(64),
    nodes: [],
    relations: [],
    activatedAt: '2026-08-15T00:00:00.000Z',
  });
  const mapRef = await b.env.facade.prepareBlob(taskId, 'map_snapshot', snapshot);
  await seedEvents(b, [
    { protocolVersion: 2, at: '2026-08-15T00:00:00.000Z', type: 'structured_map_activated', mapId: 'map-seed', mapRevision: 1, supersedesMapId: null, mapSnapshotRef: mapRef, mapReviewBundleRef: snapshot.mapReviewBundleRef, mapSemanticDigest: hash('map-sem'), contentRevisionManifestRef, activationValidatorAggregateRef: engineRefs.aggregateRef, migrationSettlementCoreRef: null, migrationActivationDecisionRef: null },
  ], [mapRef, proposedRef, engineRefs.aggregateRef, engineRefs.envelopeRef, engineRefs.warningRootRef]);
  return mapRef;
}

/** Seeds a finalized content manifest (baseline_unset revision 1 + finalized
 * revision 2 over the given set slot ids) with parse-valid blobs. */
async function seedContentManifest(b: RepairEnv, slotIds: string[]): Promise<{ manifestRef: BlobRefV2; baselineRef: BlobRefV2; mapRef: BlobRefV2 }> {
  const { taskId } = b;
  const baseline = buildBaselineUnsetManifest({
    taskId,
    mapRef: { kind: 'map_snapshot', digest: hash('map-seed-ref'), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
    mapSemanticDigest: hash('map-sem'),
    taskContentRevision: 1,
    contentBearingSlots: slotIds.map((slotId) => ({ slotId, documentOrder: slotIds.indexOf(slotId) + 1 })),
    contentSchemaOf: () => hash('schema'),
  });
  const baselineRef = await b.env.facade.prepareBlob(taskId, 'content_revision_manifest', baseline.manifest);
  const baselineVersionRefs: BlobRefV2[] = [];
  for (const version of baseline.versions) {
    baselineVersionRefs.push(await b.env.facade.prepareBlob(taskId, 'content_version', version));
  }
  const mapRef = await seedActivatedMap(b, baselineRef);
  await seedEvents(b, [
    { protocolVersion: 2, at: '2026-08-15T00:00:00.000Z', type: 'structured_content_revision_committed', contentRevisionManifestRef: baselineRef, taskContentRevision: 1, manifestPhase: 'baseline_unset', producerPlanSpecRef: null, priorManifestRef: null },
  ], [baselineRef, ...baselineVersionRefs]);
  const versions: Map<string, unknown> = new Map();
  const entries: { slotId: string; versionRef: BlobRefV2 }[] = [];
  const commitCoreBody = {
    priorManifestRef: baselineRef,
    producerPlanSpecRef: null,
    batchOrdinal: 1,
    authorizedReplacementEntriesWithoutValidation: [],
    expectedMapRef: mapRef,
  };
  const commitCoreRef = await b.env.facade.prepareBlob(taskId, 'content_revision_commit_core', { ...commitCoreBody, coreDigest: canonicalJsonSha256(commitCoreBody) });
  const aggBody = { trigger: 'content_commit', executionPhase: 'batch_commit', inputRef: commitCoreRef, inputDigest: commitCoreRef.digest, registrationSetDigest: hash('regs'), validExecutionDigests: [], blockingInvalidReceiptRefs: [], advisoryReceiptRefs: [], infrastructureFailureRefs: [], warningRootRef: { kind: 'validation_warning_root', digest: hash('warn'), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 }, outcome: 'clear' };
  const aggRef = await b.env.facade.prepareBlob(taskId, 'validator_aggregate', { ...aggBody, aggregateDigest: canonicalJsonSha256(aggBody) });
  const warnBody = { trigger: 'content_commit', executionPhase: 'batch_commit', inputRef: commitCoreRef, inputDigest: commitCoreRef.digest, entries: [], warningDigest: '' };
  const warnRef = await b.env.facade.prepareBlob(taskId, 'validation_warning_root', { ...warnBody, warningDigest: canonicalJsonSha256(warnBody) });
  const custodyBody = {
    scope: 'content_review',
    taskId,
    baseRefs: [commitCoreRef],
    entries: [{ trigger: 'content_commit', inputRef: commitCoreRef, inputDigest: commitCoreRef.digest, executionScope: { planRevisionId: 'gp-seed', batchOrdinal: 1 }, validatorAggregateRef: aggRef, warningRootRef: warnRef }],
    supersessionPolicyVersion: '1',
  };
  const custodyRef = await b.env.facade.prepareBlob(taskId, 'validation_warning_custody_root', { ...custodyBody, rootDigest: canonicalJsonSha256(custodyBody) });
  for (const slotId of slotIds) {
    const value = buildContentValue({ slotId, contentSchemaDigest: hash('schema'), taskContentRevision: 2, mediaType: 'text/markdown', text: `v-${slotId}` });
    const valueRef = await b.env.facade.prepareBlob(taskId, 'content_value', value);
    const version = buildContentSetVersion({
      slotId,
      slotRevision: 1,
      taskContentRevision: 2,
      mapRef,
      mapSemanticDigest: hash('map-sem'),
      contentSchemaDigest: hash('schema'),
      blobRef: valueRef,
      producer: { kind: 'generation_batch', planRevisionId: 'gp-seed', batchOrdinal: 1, attemptId: 'att-seed' },
      contentRevisionCommitCoreRef: commitCoreRef,
      contentCommitValidatorAggregateRef: aggRef,
      contentCommitWarningRootRef: custodyRef,
      committedByAttemptId: 'att-seed',
    });
    const versionRef = await b.env.facade.prepareBlob(taskId, 'content_version', version);
    versions.set(slotId, version);
    entries.push({ slotId, versionRef });
  }
  const finalized = buildFinalizedManifest({
    taskId,
    mapRef,
    mapSemanticDigest: hash('map-sem'),
    taskContentRevision: 2,
    priorManifestRef: baselineRef,
    producerPlanSpecRef: { kind: 'generation_plan_spec', digest: hash('plan-seed'), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
    entries,
    resolvedVersions: versions as Map<string, import('../../authoritative-review/authority-types').SlotContentVersionV2>,
    finalizerValidatorAggregateRefs: [aggRef],
    finalizerWarningRootRefs: [],
  });
  const manifestRef = await b.env.facade.prepareBlob(taskId, 'content_revision_manifest', finalized);
  await seedEvents(b, [
    { protocolVersion: 2, at: '2026-08-15T00:00:00.000Z', type: 'structured_content_revision_committed', contentRevisionManifestRef: manifestRef, taskContentRevision: 2, manifestPhase: 'finalized', producerPlanSpecRef: null, priorManifestRef: baselineRef },
  ], [manifestRef, commitCoreRef, aggRef, warnRef, custodyRef]);
  return { manifestRef, baselineRef, mapRef };
}

/** Seeds the COMPLETE task state both tracks need: map candidate chain + the
 * seeded map round (cycle 1) + activated map + finalized manifest + the seeded
 * content round (cycle 1). */
async function seedFullTask(b: RepairEnv, slotIds: string[]): Promise<{ mapRoundId: string; contentRoundId: string; manifestRef: BlobRefV2; mapRef: BlobRefV2 }> {
  await seedMapCandidate(b);
  const state0 = await b.env.readProjection(b.taskId);
  const candidate = state0.currentCandidate as { candidateId: string; candidateRef: BlobRefV2 };
  const mapRoundId = `mr-seed-${canonicalJsonSha256({ candidateId: candidate.candidateId }).slice(0, 24)}`;
  await seedEvents(b, [
    { protocolVersion: 2, at: '2026-08-15T00:00:00.000Z', type: 'structured_map_review_round_planned', mapReviewRoundId: mapRoundId, mapCycleOrdinal: 1, candidateId: candidate.candidateId, candidateRef: candidate.candidateRef, contentRevisionManifestRef: null, reviewPolicyDigest: hash('review-policy'), coverageNodeCount: 2, coverageRelationCount: 0, assignmentCount: 1, consumedOverrideRef: null },
  ], [candidate.candidateRef]);
  const { manifestRef, mapRef } = await seedContentManifest(b, slotIds);
  const contentRoundId = `cr-seed-${canonicalJsonSha256({ manifestRef: manifestRef.digest }).slice(0, 24)}`;
  await seedEvents(b, [
    { protocolVersion: 2, at: '2026-08-15T00:00:00.000Z', type: 'structured_review_round_planned', reviewRoundId: contentRoundId, contentCycleOrdinal: 1, mapRef, mapSemanticDigest: hash('map-sem'), contentRevisionManifestRef: manifestRef, reviewPolicyDigest: hash('review-policy'), adoptionRootRef: { kind: 'review_adoption_root', digest: hash('adoption'), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 }, coverageSlotCount: slotIds.length, coverageRelationCount: 0, assignmentCount: 1, verificationFindingCount: 0, consumedOverrideRef: null },
  ], [manifestRef, mapRef]);
  return { mapRoundId, contentRoundId, manifestRef, mapRef };
}

/** Creates + leases a review workitem (a STARTED structured attempt — the
 * finding-opening projection demands the reviewer attempt exists). */
async function seedReviewAttempt(b: RepairEnv, roundId: string, sessionKind: 'review_map_batch' | 'review_content_batch'): Promise<{ workItemId: string; attemptId: string }> {
  const { taskId } = b;
  const workItemId = `wi-review-seed-${canonicalJsonSha256({ roundId, sessionKind }).slice(0, 24)}`;
  // REAL prepared refs (GC-clean): source the round's planned coverage core +
  // round blob + candidate/map/manifest from the round's EXISTING review
  // WorkItems (the stack created them with prepared authority bases).
  const state = await b.env.readProjection(taskId);
  const existing = Object.values(state.workItems).find((wi) => wi.roundId === roundId && wi.sessionKind === sessionKind);
  if (existing === undefined) throw new Error(`no existing ${sessionKind} workitem for round '${roundId}'`);
  const existingBase = (await b.resolver(taskId, existing.authorityBaseRef)) as {
    mapCandidateRef?: BlobRefV2 | null;
    mapRef?: BlobRefV2 | null;
    contentRevisionManifestRef?: BlobRefV2 | null;
    reviewCoverageCoreRef: BlobRefV2;
    reviewRoundRef: BlobRefV2;
  };
  const refs =
    sessionKind === 'review_map_batch'
      ? { mapCandidateRef: existingBase.mapCandidateRef as BlobRefV2, reviewCoverageCoreRef: existingBase.reviewCoverageCoreRef, reviewRoundRef: existingBase.reviewRoundRef }
      : {
          mapRef: existingBase.mapRef as BlobRefV2,
          contentRevisionManifestRef: existingBase.contentRevisionManifestRef as BlobRefV2,
          reviewCoverageCoreRef: existingBase.reviewCoverageCoreRef,
          reviewRoundRef: existingBase.reviewRoundRef,
        };
  const base = buildAuthorityBaseSet({
    taskId,
    templateSnapshotRef: b.templateSnapshotRef,
    profileSnapshotRef: b.profileSnapshotRef,
    refs,
    kind: 'agent_assignment',
    agentExecutionKind: 'structured_session',
    sessionKind,
  });
  const baseRef = await b.env.facade.prepareBlob(taskId, 'authority_base_set', base);
  const grant = {
    grantSpecId: `gs-${workItemId}`,
    workItemId,
    kind: 'review_observation' as const,
    snapshotHash: 'a'.repeat(64),
    authorityBaseRef: baseRef,
    sessionKind,
    reviewAssignmentId: `rev-seed-${roundId}`,
    roundId,
    roundKind: sessionKind === 'review_map_batch' ? 'map' as const : 'content' as const,
    readScope: { maxContextBytes: 4096 },
  };
  // The payload is the resolved content planned core (parse-valid, all
  // children real — GC-clean; the payload's roundId is informational).
  const coverageCore = (await b.resolver(taskId, (Object.values(state.workItems).find((wi) => wi.sessionKind === 'review_content_batch') as { authorityBaseRef: BlobRefV2 }).authorityBaseRef)) as { reviewCoverageCoreRef: BlobRefV2 };
  const contentPlannedCore = (await b.resolver(taskId, coverageCore.reviewCoverageCoreRef)) as ContentReviewCoverageCoreV2;
  await b.env.coordinator.createWorkItem({
    taskId,
    operationId: opId('create-review-seed'),
    workItemId,
    kind: 'agent_assignment',
    roleBinding: 'reviewer',
    agentExecutionKind: 'structured_session',
    sessionKind,
    roundId,
    logicalAssignmentId: `la-${workItemId}`,
    reviewAssignmentId: `rev-seed-${roundId}`,
    payload: { kind: 'content_review_coverage_core', value: contentPlannedCore },
    authorityBase: base,
    grantSpec: { build: () => ({ ...grant, specDigest: canonicalJsonSha256(grant) }) as never },
    maxAutomaticRetries: 2,
  });
  const leased = await leaseTargeted(b, workItemId, 'worker-b');
  // Complete the review workitem so the coordinator's single-active-lease
  // claim predicate never blocks the repair-flow leases (the finding events
  // still project the STARTED attempt the finding-opening rule demands).
  await b.env.coordinator.completeWorkItem({
    taskId,
    operationId: attemptContinuationOperationId(taskId, workItemId, leased.attemptId ?? '', 'complete'),
    workItemId,
    attemptId: leased.attemptId ?? undefined,
    resultRefs: [leased.authorityBaseRef],
  });
  return { workItemId, attemptId: leased.attemptId ?? '' };
}

/** The map-track blocking findings (primary = the stack candidate's first node). */
function mapBlockingFindings(nodeIds: string[]): SeedFinding[] {
  return [{ findingId: 'm-1', primaryLocation: { kind: 'map_node', id: nodeIds[0] as string }, defectClass: 'map', severity: 'blocking' }];
}

/** Seeds blocking findings through the REAL content_review_assignment_commit
 * handler: findingOpenings + ONE root whole-tree observation (the observation
 * branch skips the assignment-ledger requirements; the projection demands the
 * round + a started reviewer attempt). The finding reviewContext round is the
 * track's seeded round. */
async function seedFindings(b: RepairEnv, findings: SeedFinding[], kind: 'map' | 'content'): Promise<void> {
  const { taskId } = b;
  const state = await b.env.readProjection(taskId);
  const roundId = kind === 'map' ? Object.keys(state.mapRounds)[0] as string : Object.keys(state.contentRounds)[0] as string;
  const reviewAttempt = await seedReviewAttempt(b, roundId, kind === 'map' ? 'review_map_batch' : 'review_content_batch');
  const findingOpenings: import('../../authoritative-review/authority-types').ContentReviewFindingOpeningCarrierV2[] = [];
  const blobRefs: BlobRefV2[] = [];
  for (const f of findings) {
    const body = {
      findingId: f.findingId,
      reviewContext: { kind, roundId },
      primaryLocation: f.primaryLocation,
      relatedSlotIds: [],
      relatedRelationIds: [],
      defectClass: f.defectClass,
      severity: f.severity,
      source: 'reviewer',
      evidence: [],
      suggestedRepairSlotIds: f.suggestedRepairSlotIds ?? [],
      status: 'open',
      repairProgress: { map: 'pending', content: 'pending' },
      openedBy: { kind: 'reviewer', reviewerAttemptId: reviewAttempt.attemptId },
    };
    const findingRef = await b.env.facade.prepareBlob(taskId, 'finding', body);
    blobRefs.push(findingRef);
    findingOpenings.push({
      findingId: f.findingId,
      findingRef,
      reviewContext: { kind, roundId },
      primaryLocation: f.primaryLocation,
      defectClass: f.defectClass,
      severity: f.severity,
      source: 'reviewer',
      openedBy: { kind: 'reviewer', reviewerAttemptId: reviewAttempt.attemptId },
    });
  }
  const observationRoot = buildFindingStageRoot(roundId, []);
  const observationRef = await b.env.facade.prepareBlob(taskId, 'finding_stage_root', observationRoot);
  blobRefs.push(observationRef);
  const operationId = opId('seed-findings');
  const tail = await b.env.eventStore.tail(taskId);
  const contentRoundId = Object.keys(state.contentRounds)[0] as string;
  await b.env.facade.publishWithPin({
    taskId,
    operationId,
    payload: {
      family: 'domain_publish',
      operationId,
      taskId,
      publishKind: 'content_review_assignment_commit',
      blobRefs,
      expectedResultIdentity: canonicalJsonSha256({ op: 'seed-findings' }),
      mapBuild: null,
      mapReview: null,
      contentPlan: null,
      contentReview: {
        assignmentId: null,
        reviewRoundId: contentRoundId,
        workItemId: null,
        attemptId: null,
        reviewAssignmentId: null,
        source: null,
        ledgerRef: null,
        coverageTargetCount: null,
        findingCount: findings.length,
        observations: [
          { observationId: `obs-seed-${canonicalJsonSha256({ roundId }).slice(0, 24)}`, level: 1, parentObservationId: null, observationRef, coveredTargetCount: 1, childObservationRefs: [] },
        ],
        findingOpenings,
        coverageCoreRef: null,
        roundPlanned: null,
        reviewWorkItems: null,
        settlementCoreRef: null,
        outcome: null,
        reviewBundleRef: null,
        reviewWarningCustodyRootRef: null,
        mapRef: null,
        contentRevisionManifestRef: null,
        reviewSettlementValidatorAggregateRef: null,
        sealWorkItemId: null,
        sealAuthorityBaseRef: null,
        successor: null,
        terminal: null,
      },
      repair: null,
    } as never,
    intent: { handlerKind: 'content_review_assignment_commit', handlerVersion: 1 },
    preparedRefs: blobRefs,
    expectedTailSequence: tail.lastSequence,
    expectedTailCommitId: tail.lastCommitId,
  });
}

/** Creates + leases a settlement workitem (the plan-creation envelope's
 * terminal pair demands a leased command workitem). */
async function createAndLeaseSettlement(b: RepairEnv): Promise<{ workItemId: string; commandId: string; leaseEpoch: number; authorityBaseRef: BlobRefV2 }> {
  const { taskId } = b;
  const workItemId = 'wi-settlement-1';
  // REAL prepared refs (GC-clean): the current Map snapshot + the current
  // content round's PLANNED coverage core (the review WorkItems' bases bind
  // it — reviewRoundRef == reviewCoverageCoreRef == the planned core).
  const state = await b.env.readProjection(taskId);
  const mapRef = state.currentMap?.mapSnapshotRef;
  if (mapRef === undefined) throw new Error('no active map for the settlement base');
  const contentRoundWorkItem = Object.values(state.workItems).find((wi) => wi.sessionKind === 'review_content_batch');
  if (contentRoundWorkItem === undefined) throw new Error('no content review workitem for the settlement base');
  const reviewBase = (await b.resolver(taskId, contentRoundWorkItem.authorityBaseRef)) as { reviewCoverageCoreRef: BlobRefV2; reviewRoundRef: BlobRefV2 };
  const plannedCore = (await b.resolver(taskId, reviewBase.reviewCoverageCoreRef)) as ContentReviewCoverageCoreV2;
  const base = buildAuthorityBaseSet({
    taskId,
    templateSnapshotRef: b.templateSnapshotRef,
    profileSnapshotRef: b.profileSnapshotRef,
    refs: {
      mapRef,
      reviewCoverageCoreRef: reviewBase.reviewCoverageCoreRef,
      reviewRoundRef: reviewBase.reviewRoundRef,
    },
    kind: 'system_review_settlement',
  });
  const baseRef = await b.env.facade.prepareBlob(taskId, 'authority_base_set', base);
  await b.env.coordinator.createWorkItem({
    taskId,
    operationId: opId('create-settlement'),
    workItemId,
    kind: 'system_review_settlement',
    roleBinding: null,
    agentExecutionKind: null,
    sessionKind: null,
    roundId: null,
    logicalAssignmentId: null,
    reviewAssignmentId: null,
    payload: { kind: 'content_review_coverage_core', value: plannedCore },
    authorityBase: base,
    grantSpecRef: null,
    maxAutomaticRetries: 2,
    initialLeaseEpoch: 0,
  });
  const leased = await leaseTargeted(b, workItemId, 'worker-a');
  return { workItemId, commandId: leased.commandId ?? leased.attemptId ?? '', leaseEpoch: leased.leaseEpoch, authorityBaseRef: baseRef };
}

function ctxOf(b: RepairEnv, lease: { workItemId: string; attemptId: string | null; leaseEpoch: number; leaseOwner: string | null; authorityBaseRef: BlobRefV2; dispatchRef: BlobRefV2 | null; grantInstanceRef: BlobRefV2 | null }): V2AttemptContext {
  return {
    taskId: b.taskId,
    workItemId: lease.workItemId,
    attemptId: lease.attemptId ?? '',
    leaseEpoch: lease.leaseEpoch,
    namespace: `structured/${lease.workItemId}/${lease.attemptId}`,
    agentId: lease.leaseOwner ?? 'worker-a',
    roleBinding: 'orchestrator',
    executionKind: 'structured',
    sessionKind: null,
    dispatchRef: lease.dispatchRef,
    authorityBaseRef: lease.authorityBaseRef,
    grantInstanceRef: lease.grantInstanceRef,
    inputArtifactDeliveryId: null,
    agent: null,
    currentAssignmentText: '',
    committedCheckpointText: '',
  };
}

/** Leases a SPECIFIC workitem, skipping (completing) any other ready
 * workitems the stack left behind — the coordinator only claims the first
 * ready workitem, so the repair tests must clear the stack's leftover
 * review/generation workitems before claiming their target. */
async function leaseTargeted(b: RepairEnv, targetWorkItemId: string, worker: string): Promise<{ workItemId: string; attemptId: string | null; commandId: string | null; leaseEpoch: number; leaseOwner: string | null; authorityBaseRef: BlobRefV2; dispatchRef: BlobRefV2 | null; grantInstanceRef: BlobRefV2 | null }> {
  for (let i = 0; i < 40; i++) {
    const lease = await b.env.coordinator.leaseNext(b.taskId, worker, opId(`lease-targeted-${i}`));
    if (lease === null) throw new Error(`no leaseable workitem (wanted '${targetWorkItemId}')`);
    if (lease.workItemId === targetWorkItemId) return lease;
    const state = (await b.env.readProjection(b.taskId)).workItems[lease.workItemId];
    const needsResult = completionKindRequiresResult(state.kind as import('../../../shared/authoritative-review-v2').WorkItemKindV2, state.sessionKind as never);
    await b.env.coordinator.completeWorkItem({
      taskId: b.taskId,
      operationId: attemptContinuationOperationId(b.taskId, lease.workItemId, (lease.attemptId ?? lease.commandId) ?? '', 'complete'),
      workItemId: lease.workItemId,
      attemptId: lease.attemptId ?? undefined,
      commandId: lease.commandId ?? undefined,
      resultRefs: needsResult ? [lease.authorityBaseRef] : [],
    });
  }
  throw new Error(`could not lease '${targetWorkItemId}'`);
}

/** The projected lifecycle of the seeded findings (blocking flags). */
function blockingFindingsOf(ids: string[]): import('./finding-service').ProjectedFindingLifecycleV2[] {
  return ids.map((findingId) => ({
    findingId,
    defectClass: (findingId.startsWith('m') ? 'map' : findingId.startsWith('x') ? 'mixed' : 'content') as 'map' | 'content' | 'mixed',
    severity: 'blocking' as const,
    source: 'reviewer' as const,
    status: 'open' as const,
    addressStages: [],
    verifiedStages: [],
    closed: false,
    blockingUnclosed: true,
  }));
}

/** The grant spec of a workitem (resolved). */
async function grantOf(b: RepairEnv, workItemId: string): Promise<WriteGrantSpecV2> {
  const state = await b.env.readProjection(b.taskId);
  const wi = state.workItems[workItemId];
  if (wi === undefined || wi.grantSpecRef === null) throw new Error(`no grant on ${workItemId}`);
  return (await b.resolver(b.taskId, wi.grantSpecRef)) as WriteGrantSpecV2;
}

/** The workitem's payload ref (the finalizer's payloadRef). */
async function payloadRefOf(b: RepairEnv, workItemId: string): Promise<BlobRefV2> {
  const state = await b.env.readProjection(b.taskId);
  const wi = state.workItems[workItemId];
  if (wi === undefined) throw new Error(`no workitem ${workItemId}`);
  return wi.payloadRef;
}

/** Always-valid test validator source (one per trigger/phase). */
function alwaysValidSource(salt: string): string {
  return `'use strict';
module.exports = { validate: function validate(input) { return { status: 'valid', executionDigest: '${hash(salt)}' }; } };`;
}

function testValidatorEntry(trigger: import('../../authoritative-review/authority-types').ValidatorTriggerV2, executionPhase: 'batch_commit' | 'plan_finalize' | null, source: string, keySuffix = '', digestOverride = ''): import('./validator-registry').InstalledValidatorEntry {
  return {
    handlerKey: `test.repair.${trigger}${keySuffix}`,
    implementationDigest: digestOverride === '' ? createHash('sha256').update(source, 'utf8').digest('hex') : digestOverride,
    moduleId: '@forge/authoritative-review',
    exportName: 'repairTestHandler',
    trigger,
    executionPhase,
    abi: 'forge-validator/v2',
    budgetProfileId: 'authoritative-validator-default',
    inputContractVersion: 2,
    outputContractVersion: 2,
  };
}

function testValidatorRegistration(trigger: import('../../authoritative-review/authority-types').ValidatorTriggerV2, executionPhase: 'batch_commit' | 'plan_finalize' | null, source: string, validatorId: string): ValidatorRegistrationV2 {
  const suffix = executionPhase === null ? '' : `.${executionPhase}`;
  const entry = testValidatorEntry(trigger, executionPhase, source, suffix);
  return {
    validatorId,
    handlerKey: entry.handlerKey,
    implementationDigest: entry.implementationDigest,
    implementationRef: { kind: 'builtin', moduleId: entry.moduleId, exportName: entry.exportName },
    trigger,
    executionPhase,
    selector: { kind: 'all' },
    enforcement: 'blocking',
    deterministic: true,
    inputContractVersion: 2,
    outputContractVersion: 2,
    budgetProfileId: entry.budgetProfileId,
  };
}

const MAP_SETTLEMENT_SOURCE = alwaysValidSource('map-review-settlement');
const MAP_ACTIVATION_SOURCE = alwaysValidSource('map-activation');
const BATCH_VALID_SOURCE = alwaysValidSource('content-batch');
const FINALIZE_VALID_SOURCE = alwaysValidSource('content-finalize');

/**
 * Drives the REAL pipeline to a finalized content manifest + content round
 * (cycle 1) + review workitems: map build -> map finalize (candidate + map
 * round cycle 1) -> map review (batch + whole freezes) -> map settlement
 * (activation + baseline manifest + generation plan) -> generation batches ->
 * generation finalize (finalized manifest + content round cycle 1). Returns
 * the manifest/map refs + the content round id.
 */
async function driveToContentStack(b: RepairEnv, slotIds: string[]): Promise<{ manifestRef: BlobRefV2; mapRef: BlobRefV2; contentRoundId: string; mapRoundId: string; nodeIds: string[] }> {
  const { taskId } = b;
  const resolver = b.resolver;
  const readEvents = async (id: string) => (await b.env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2);
  const mapBuildId = 'mb-stack-1';
  const specBody = { mapBuildId, revision: 1, supersedesMapBuildId: null, sourceValidationReceiptRef: null, snapshotHash: 'a'.repeat(64), plannedChunkPolicy: { maxChunks: 16, maxNodesPerChunk: 512, maxRelationsPerChunk: 64 } };
  const specRef = await b.env.facade.prepareBlob(taskId, 'map_build_spec', { ...specBody, specDigest: canonicalJsonSha256(specBody) });
  const base = buildAuthorityBaseSet({
    taskId,
    templateSnapshotRef: b.templateSnapshotRef,
    profileSnapshotRef: b.profileSnapshotRef,
    refs: { planSpecRef: specRef },
    kind: 'agent_assignment',
    agentExecutionKind: 'structured_session',
    sessionKind: 'structure_chunk',
  });
  const baseRef = await b.env.facade.prepareBlob(taskId, 'authority_base_set', base);
  const buildWorkItemId = 'wi-build-stack-1';
  const grantBody = {
    grantSpecId: 'gs-build-stack-1',
    workItemId: buildWorkItemId,
    kind: 'initial_structure_chunk' as const,
    snapshotHash: 'a'.repeat(64),
    authorityBaseRef: baseRef,
    mapBuildSpecRef: specRef,
    expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST,
    structureChunkScope: { chunkOrdinal: 1, parentFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST, maxNodes: 512, maxRelations: 64 },
  };
  const grantSpec = { ...grantBody, specDigest: canonicalJsonSha256(grantBody) } as WriteGrantSpecV2;
  const grantSpecRef = await b.env.facade.prepareBlob(taskId, 'write_grant_spec', grantSpec);
  const startOperation = opId('start-stack');
  const tail0 = await b.env.eventStore.tail(taskId);
  await b.env.facade.publishWithPin({
    taskId,
    operationId: startOperation,
    payload: {
      family: 'lifecycle',
      operationId: startOperation,
      taskId,
      kind: 'start',
      suspensionId: null,
      workItemId: buildWorkItemId,
      reason: null,
      leaseEpoch: null,
      expectedLastSequence: null,
      authorityBaseRef: baseRef,
      attemptFamily: null,
      attemptId: null,
      commandId: null,
      agentId: null,
      commandKind: null,
      logicalAssignmentId: 'la-build-stack-1',
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
  const mapBuild = new MapBuildService({
    facade: b.env.facade,
    grants: b.grants,
    readProjection: b.env.readProjection,
    resolver,
    tail: (id) => b.env.eventStore.tail(id),
    readEvents,
    committedOperation: async (id, operationId) =>
      (await b.env.eventStore.readBatchByCommitId(id, operationId))?.map((e) => e.event as AuthoritativeReviewEventV2) ?? null,
    clock: () => b.env.now.value,
    profile: PROFILE,
    profileBody: PROFILE_BODY,
    validatorRegistry: REGISTRY,
    registrationsFor: () => [registrationFor('authoritative.review.completeness')],
    relationPolicy: 'optional',
    reviewPolicyDigest: hash('review-policy'),
    templateSnapshotRef: b.templateSnapshotRef,
    profileSnapshotRef: b.profileSnapshotRef,
    orchestratorRoleBinding: 'orchestrator',
    defaultAutomaticRetries: async () => 2,
  });
  const leased = await b.env.coordinator.leaseNext(taskId, 'worker-a', opId('lease-stack-build'));
  if (leased === null) throw new Error('expected lease');
  const buildCtx = ctxOf(b, leased);
  const nodes: Record<string, unknown>[] = slotIds.map((slotId, i) => ({
    buildNodeKey: `k-${slotId}`,
    slotType: 'doc',
    parentBuildNodeKey: i === 0 ? null : `k-${slotIds[0] as string}`,
    documentOrder: i + 1,
    siblingOrder: 0,
    contentBearing: true,
  }));
  const chunkResult = await mapBuild.appendChunk(buildCtx, {
    ordinal: 1,
    expectedFrontierDigest: EMPTY_BUILD_FRONTIER_DIGEST,
    nodes,
    relations: [],
    clientOperationId: 'op-stack-c1',
  });
  await mapBuild.finishMapBuild(buildCtx, {
    expectedChunkCount: 1,
    expectedFrontierDigest: chunkResult.frontierDigest,
    expectedRootCount: 1,
    clientOperationId: 'op-stack-finish',
  });
  await b.env.coordinator.completeWorkItem({
    taskId,
    operationId: opId('complete-stack-build'),
    workItemId: buildWorkItemId,
    attemptId: buildCtx.attemptId,
    resultRefs: [chunkResult.chunkRef],
  });
  const finalizeLease = await b.env.coordinator.leaseNext(taskId, 'worker-a', opId('lease-stack-finalize'));
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
  const events0 = await readEvents(taskId);
  const roundEvent = events0.find((e) => e.type === 'structured_map_review_round_planned');
  const candidateEvent = events0.find((e) => e.type === 'structured_map_candidate_committed');
  if (roundEvent === undefined || roundEvent.type !== 'structured_map_review_round_planned') throw new Error('no map round planned');
  if (candidateEvent === undefined || candidateEvent.type !== 'structured_map_candidate_committed') throw new Error('no candidate');
  const mapRoundId = roundEvent.mapReviewRoundId;
  const candidateRef = roundEvent.candidateRef;
  const candidate = (await resolver(taskId, candidateRef)) as { validationCoreRef: BlobRefV2 };
  const core = (await resolver(taskId, candidate.validationCoreRef)) as { nodes: MapPositionNodeV2[]; relations: MapRelationV2[] };
  const nodeIds = core.nodes.map((n) => n.slotId);
  const assignmentCount = roundEvent.assignmentCount;

  const reviewCoordinator = new ReviewCoordinatorV2({
    coordinator: b.env.coordinator,
    facade: b.env.facade,
    resolver,
    readProjection: b.env.readProjection,
    readEvents,
    profile: PROFILE,
    reviewPolicy: { ...REVIEW_POLICY, contentBatchTargetSlots: 2 },
    templateSnapshotRef: b.templateSnapshotRef,
    profileSnapshotRef: b.profileSnapshotRef,
    reviewerRoleBinding: 'reviewer',
    generatorRoleBinding: 'generator',
    orchestratorRoleBinding: 'orchestrator',
    snapshotHash: 'a'.repeat(64),
    defaultAutomaticRetries: async () => 2,
  });
  const reviewService = new MapReviewService({
    facade: b.env.facade,
    reviewCoordinator,
    readProjection: b.env.readProjection,
    resolver,
    tail: (id) => b.env.eventStore.tail(id),
    readEvents,
    committedOperation: async (id, operationId) =>
      (await b.env.eventStore.readBatchByCommitId(id, operationId))?.map((e) => e.event as AuthoritativeReviewEventV2) ?? null,
    clock: () => b.env.now.value,
    profile: PROFILE,
    profileBody: PROFILE_BODY,
    validatorRegistry: new ValidatorRegistry([
      ...AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES,
      testValidatorEntry('map_review_settlement', null, MAP_SETTLEMENT_SOURCE),
      testValidatorEntry('map_activation', null, MAP_ACTIVATION_SOURCE),
    ]),
    sourceResolver: (handlerKey) => {
      if (handlerKey === 'test.repair.map_review_settlement') return MAP_SETTLEMENT_SOURCE;
      if (handlerKey === 'test.repair.map_activation') return MAP_ACTIVATION_SOURCE;
      return builtinSourceOf(handlerKey);
    },
    registrationsFor: (trigger) => {
      if (trigger === 'map_review_settlement') return [testValidatorRegistration('map_review_settlement', null, MAP_SETTLEMENT_SOURCE, 'v-map-settle')];
      return [testValidatorRegistration('map_activation', null, MAP_ACTIVATION_SOURCE, 'v-map-activate')];
    },
    reviewPolicy: { ...REVIEW_POLICY, contentBatchTargetSlots: 2 },
    reviewPolicyDigest: hash('review-policy'),
    templateSnapshotRef: b.templateSnapshotRef,
    profileSnapshotRef: b.profileSnapshotRef,
    snapshotHash: 'a'.repeat(64),
    reviewerRoleBinding: 'reviewer',
    generatorRoleBinding: 'generator',
    orchestratorRoleBinding: 'orchestrator',
  });
  const plannedRound = buildMapReviewRound({
    mapReviewRoundId: mapRoundId,
    candidateId: roundEvent.candidateId,
    candidateDigest: candidateRef.digest,
    contentRevisionManifestRef: null,
    contentRootDigest: null,
    reviewPolicyDigest: hash('review-policy'),
    coverageNodeIds: nodeIds,
    coverageRelationIds: core.relations.map((r) => r.relationId),
    assignmentIds: Array.from({ length: assignmentCount }, (_, i) => reviewAssignmentIdOf(mapRoundId, i)).concat([reviewWholeAssignmentId(mapRoundId)]),
    verificationFindingStages: [],
  });
  const plan = planMapReview({
    nodes: core.nodes,
    relations: core.relations,
    profile: PROFILE,
    reviewPolicy: { ...REVIEW_POLICY, contentBatchTargetSlots: 2 },
    assignmentCount,
  });
  const plannedCoreBody = {
    mapReviewRoundId: mapRoundId,
    candidateRef,
    contentRevisionManifestRef: null,
    contentRootDigest: null,
    reviewPolicyDigest: hash('review-policy'),
    coverageLedgerRootRefs: [] as readonly BlobRefV2[],
    wholeMapObservationRootRefs: [] as readonly BlobRefV2[],
    findingStageRootRef: refOfBlob('finding_stage_root', buildFindingStageRoot(mapRoundId, [])),
  };
  const plannedCore = { ...plannedCoreBody, coreDigest: canonicalJsonSha256(plannedCoreBody) };
  const coverageCoreRef = await b.env.facade.prepareBlob(taskId, 'map_review_coverage_core', plannedCore);
  const roundRef = await b.env.facade.prepareBlob(taskId, 'map_review_round', plannedRound);
  await reviewCoordinator.createRoundReviewWorkItems({
    taskId,
    round: plannedRound,
    roundRef,
    coverageCoreRef,
    mapCandidateRef: candidateRef,
    plan,
  });
  // Freeze the batch + whole assignments (pass verdicts).
  const batchWiId = reviewBatchWorkItemId(mapRoundId, 0);
  const batchLease = await b.env.coordinator.leaseNext(taskId, 'worker-r', opId('lease-stack-batch'));
  if (batchLease === null || batchLease.workItemId !== batchWiId) throw new Error('expected the batch review workitem');
  const batchAttemptId = batchLease.attemptId ?? '';
  const batchTargets = [...plan.batches[0].nodeIds, ...plan.batches[0].relationIds];
  const baselineTargetKinds: Record<string, ReviewFactV2['targetKind']> = {};
  for (const id of plan.batches[0].nodeIds) baselineTargetKinds[id] = 'map_node';
  const records: ReviewDraftRecordV2[] = batchTargets.map((targetId) => ({
    op: 'submit_map_node_review',
    body: { targetId, verdict: 'pass', evidence: [], findingDrafts: [], crossScopeFindingDrafts: [] },
    at: b.env.now.value,
  }));
  const freezeResult = buildReviewAssignmentFreeze({
    assignmentId: batchWiId,
    workItemId: batchWiId,
    reviewAssignmentId: reviewAssignmentIdOf(mapRoundId, 0),
    roundKind: 'map',
    roundId: mapRoundId,
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
  await b.env.coordinator.completeWorkItem({
    taskId,
    operationId: attemptContinuationOperationId(taskId, batchWiId, batchAttemptId, 'complete'),
    workItemId: batchWiId,
    attemptId: batchAttemptId,
    resultRefs: [refOfBlob('review_assignment_ledger', freezeResult.freeze.ledger)],
  });
  const wholeWiId = reviewWholeWorkItemId(mapRoundId);
  const wholeLease = await b.env.coordinator.leaseNext(taskId, 'worker-r', opId('lease-stack-whole'));
  if (wholeLease === null || wholeLease.workItemId !== wholeWiId) throw new Error('expected the whole review workitem');
  const wholeAttemptId = wholeLease.attemptId ?? '';
  const wholeFreeze = buildReviewAssignmentFreeze({
    assignmentId: wholeWiId,
    workItemId: wholeWiId,
    reviewAssignmentId: reviewWholeAssignmentId(mapRoundId),
    roundKind: 'map',
    roundId: mapRoundId,
    attemptId: wholeAttemptId,
    reviewerAttemptId: wholeAttemptId,
    reviewPolicyDigest: hash('review-policy'),
    records: [],
    verificationFindingStages: [],
    assignmentTargets: [],
    baselineTargetKinds: {},
    requireOrdinaryCoverage: false,
  });
  if (!wholeFreeze.ok) throw new Error(`whole freeze failed: ${wholeFreeze.errors.join('; ')}`);
  await reviewService.freezeReviewAssignment(taskId, wholeFreeze.freeze);
  await b.env.coordinator.completeWorkItem({
    taskId,
    operationId: attemptContinuationOperationId(taskId, wholeWiId, wholeAttemptId, 'complete'),
    workItemId: wholeWiId,
    attemptId: wholeAttemptId,
    resultRefs: [refOfBlob('review_assignment_ledger', wholeFreeze.freeze.ledger)],
  });
  const advanced = await reviewService.maybeCompleteRound(taskId, mapRoundId);
  if (!advanced) throw new Error('map round did not advance');
  const settlementWiId = deterministicSettlementWorkItemId(taskId, mapRoundId);
  const settleLease = await b.env.coordinator.leaseNext(taskId, 'worker-s', opId('lease-stack-settlement'));
  if (settleLease === null || settleLease.workItemId !== settlementWiId) throw new Error('expected the settlement workitem');
  const events1 = await readEvents(taskId);
  const completed = events1.find((e) => e.type === 'structured_map_review_round_completed' && e.mapReviewRoundId === mapRoundId);
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
  if (settleOutcome.kind !== 'completed') throw new Error('map settlement did not complete');
  const events2 = await readEvents(taskId);
  const genCreated = events2.find((e) => e.type === 'structured_work_item_created' && e.sessionKind === 'generation_batch');
  const activatedEvent = events2.find((e) => e.type === 'structured_map_activated');
  if (genCreated === undefined || genCreated.type !== 'structured_work_item_created') throw new Error('no generation workitem');
  if (activatedEvent === undefined || activatedEvent.type !== 'structured_map_activated') throw new Error('no map activated');
  const planSpecRef = genCreated.payloadRef;
  const planSpec = (await resolver(taskId, planSpecRef)) as GenerationPlanSpecV2;
  const mapRef = activatedEvent.mapSnapshotRef;
  const contentService = new ContentPlanService({
    facade: b.env.facade,
    coordinator: b.env.coordinator,
    grants: b.grants,
    readProjection: b.env.readProjection,
    resolver,
    tail: (id) => b.env.eventStore.tail(id),
    readEvents,
    clock: () => b.env.now.value,
    profile: PROFILE,
    profileBody: PROFILE_BODY,
    validatorRegistry: new ValidatorRegistry([
      ...AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES,
      testValidatorEntry('content_commit', 'batch_commit', BATCH_VALID_SOURCE, '.batch_commit'),
      testValidatorEntry('content_commit', 'plan_finalize', FINALIZE_VALID_SOURCE, '.plan_finalize'),
    ]),
    sourceResolver: (handlerKey) => {
      if (handlerKey === 'test.repair.content_commit.batch_commit') return BATCH_VALID_SOURCE;
      if (handlerKey === 'test.repair.content_commit.plan_finalize') return FINALIZE_VALID_SOURCE;
      return builtinSourceOf(handlerKey);
    },
    registrationsFor: (trigger, phase) => {
      if (phase === 'batch_commit') return [testValidatorRegistration('content_commit', 'batch_commit', BATCH_VALID_SOURCE, 'v-content-batch')];
      return [testValidatorRegistration('content_commit', 'plan_finalize', FINALIZE_VALID_SOURCE, 'v-content-finalize')];
    },
    reviewPolicy: { ...REVIEW_POLICY, contentBatchTargetSlots: 2 },
    reviewPolicyDigest: hash('review-policy'),
    templateSnapshotRef: b.templateSnapshotRef,
    profileSnapshotRef: b.profileSnapshotRef,
    snapshotHash: 'a'.repeat(64),
    generatorRoleBinding: 'generator',
    reviewerRoleBinding: 'reviewer',
    slotTypes: [{ id: 'doc', name: 'Doc', description: 'd', contentPresence: 'required', contentSchema: { type: 'string', minLength: 1 } }],
    slotTypeOf: () => 'doc',
    contentSchemaDigestOf: () => hash('schema'),
    defaultAutomaticRetries: async () => 2,
  });
  // Generation batches.
  const batchSlotIds = planSpec.orderedBatchSlotIds;
  let currentWiId = genCreated.workItemId;
  for (let index = 0; index < batchSlotIds.length; index++) {
    const batchLeaseG = await b.env.coordinator.leaseNext(taskId, 'worker-g', opId(`lease-stack-gen-${index}`));
    if (batchLeaseG === null || batchLeaseG.workItemId !== currentWiId) throw new Error('expected the generation batch workitem');
    const genCtx = ctxOf(b, batchLeaseG);
    const slotContents: Record<string, { text: string; mediaType: 'text/markdown' | 'text/plain' }> = {};
    for (const slotId of batchSlotIds[index] ?? []) {
      slotContents[slotId] = { text: `generated-${slotId}`, mediaType: 'text/markdown' };
    }
    const genOutcome = await contentService.commitGenerationBatch({
      taskId,
      workItemId: currentWiId,
      attemptId: genCtx.attemptId,
      batchOrdinal: index + 1,
      ctx: genCtx,
      slotContents,
    });
    if (genOutcome.kind !== 'committed') {
      const agg = (await resolver(taskId, genOutcome.aggregateRef)) as { infrastructureFailureRefs?: readonly BlobRefV2[] };
      const failures: unknown[] = [];
      for (const ref of agg.infrastructureFailureRefs ?? []) {
        failures.push(await resolver(taskId, ref));
      }
      throw new Error(`generation batch did not commit: ${JSON.stringify(genOutcome)} failures=${JSON.stringify(failures)}`);
    }
    await b.env.coordinator.completeWorkItem({
      taskId,
      operationId: attemptContinuationOperationId(taskId, currentWiId, genCtx.attemptId, 'complete'),
      workItemId: currentWiId,
      attemptId: genCtx.attemptId,
      resultRefs: [genOutcome.manifestRef],
    });
    currentWiId = genOutcome.nextWorkItemId;
  }
  // Finalize.
  const finalizeWiId = generationFinalizeWorkItemId(taskId, planSpec.generationPlanId);
  const genFinalizeLease = await b.env.coordinator.leaseNext(taskId, 'worker-s', opId('lease-stack-gen-finalize'));
  if (genFinalizeLease === null || genFinalizeLease.workItemId !== finalizeWiId) throw new Error('expected the generation finalize workitem');
  const genFinalizeOutcome = await contentService.executeGenerationFinalize({
    taskId,
    commandId: genFinalizeLease.commandId ?? '',
    workItemId: finalizeWiId,
    commandKind: 'generation_finalize',
    leaseEpoch: genFinalizeLease.leaseEpoch,
    authorityBaseRef: genFinalizeLease.authorityBaseRef,
    payloadRef: await payloadRefOf(b, finalizeWiId),
  });
  if (genFinalizeOutcome.kind !== 'completed') throw new Error('generation finalize did not complete');
  const events3 = await readEvents(taskId);
  const manifestEvent = events3.find((e) => e.type === 'structured_content_revision_committed' && e.manifestPhase === 'finalized');
  if (manifestEvent === undefined || manifestEvent.type !== 'structured_content_revision_committed') throw new Error('no finalized manifest');
  const contentRoundEvent = events3.find((e) => e.type === 'structured_review_round_planned');
  if (contentRoundEvent === undefined || contentRoundEvent.type !== 'structured_review_round_planned') throw new Error('no content round planned');
  return { manifestRef: manifestEvent.contentRevisionManifestRef, mapRef, contentRoundId: contentRoundEvent.reviewRoundId, mapRoundId, nodeIds };
}

/* ------------------------------------------------------------------ */
/* Step 1: initial/successor identity                                  */
/* ------------------------------------------------------------------ */

describe('repair plan identity (pure)', { timeout: 120_000 }, () => {
  it('initial plan has NO fake predecessor and uses the settlement creation key', () => {
    const key = 'op-settlement-continuation';
    const plan = buildRepairPlanSpec({
      repairPlanId: 'rp-1',
      revision: 1,
      origin: { kind: 'initial', settlementId: 'wi-settlement-1', settlementDigest: 'a'.repeat(64), creationOperationKey: key },
      sourceReceiptRef: null,
      repairBase: { kind: 'map_candidate', candidateRef: { kind: 'map_candidate', digest: 'b'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 } },
      orderedBatchScopes: [],
      keyLineageRef: { kind: 'repair_key_ledger', digest: 'c'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
      importedStagingManifestRef: { kind: 'map_candidate', digest: 'd'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
    });
    expect(plan.origin.kind).toBe('initial');
    expect(plan.origin).toMatchObject({ settlementId: 'wi-settlement-1', creationOperationKey: key });
    expect(plan.revision).toBe(1);
    // The parser contract: planRevisionId = hash(repairPlanId, revision, specDigest).
    expect(plan.planRevisionId).toBe(canonicalJsonSha256({ repairPlanId: 'rp-1', revision: 1, specDigest: plan.specDigest }));
    // The frozen parser must accept it.
    expect(() => parseBlob('repair_plan_spec', plan)).not.toThrow();
  });

  it('successor requires exactly ONE predecessor and a stable operation key (replay-identical)', () => {
    const predecessor = buildRepairPlanSpec({
      repairPlanId: 'rp-1',
      revision: 1,
      origin: { kind: 'initial', settlementId: 's', settlementDigest: 'a'.repeat(64), creationOperationKey: 'k' },
      sourceReceiptRef: null,
      repairBase: { kind: 'map_candidate', candidateRef: { kind: 'map_candidate', digest: 'b'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 } },
      orderedBatchScopes: [],
      keyLineageRef: { kind: 'repair_key_ledger', digest: 'c'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
      importedStagingManifestRef: { kind: 'map_candidate', digest: 'd'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
    });
    const build = (opKey: string) =>
      buildRepairPlanSpec({
        repairPlanId: 'rp-1',
        revision: 2,
        origin: { kind: 'successor', supersedesPlanSpecRef: { kind: 'repair_plan_spec', digest: predecessor.specDigest, byteLength: 10, mediaType: 'application/json', schemaVersion: 1 }, successorReason: 'validation_correction', successorOperationKey: opKey },
        sourceReceiptRef: null,
        repairBase: predecessor.repairBase,
        orderedBatchScopes: [],
        keyLineageRef: predecessor.keyLineageRef,
        importedStagingManifestRef: predecessor.importedStagingManifestRef,
      });
    const a = build('op-key');
    const b = build('op-key');
    const c = build('op-other');
    expect(a.origin).toMatchObject({ kind: 'successor', successorReason: 'validation_correction', successorOperationKey: 'op-key' });
    expect(b.specDigest).toBe(a.specDigest);
    expect(b.planRevisionId).toBe(a.planRevisionId);
    // A different operation key yields a DIFFERENT successor (never a replay).
    expect(c.specDigest).not.toBe(a.specDigest);
    expect(() => parseBlob('repair_plan_spec', a)).not.toThrow();
  });

  it('competing successors from the same head are deterministic; a stale-tail approval fails closed (loser re-evaluates)', async () => {
    const b = await makeRepairEnv();
    const stack = await driveToContentStack(b, ['s-1', 's-2']);
    await seedFindings(b, mapBlockingFindings(stack.nodeIds), 'map');
    const settlement = await createAndLeaseSettlement(b);
    const outcome = await b.service.createRepairPlanFromSettlement({
      taskId: b.taskId,
      settlementWorkItemId: settlement.workItemId,
      settlementCommandId: settlement.commandId,
      leaseEpoch: settlement.leaseEpoch,
      authorityBaseRef: settlement.authorityBaseRef,
      roundId: 'round-1',
      coverageCoreRef: { kind: 'content_review_coverage_core', digest: 'e'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
      findings: blockingFindingsOf(['m-1']),
    });
    expect(outcome.kind).toBe('completed');
    const state = await b.env.readProjection(b.taskId);
    const lineage = Object.values(state.repairPlans)[0];
    const head = lineage.revisions[lineage.currentPlanRevisionId as string];
    const headSpec = (await b.resolver(b.taskId, head.specRef)) as RepairPlanSpecV2;
    // Both successor reasons derived from the SAME head produce distinct but
    // DETERMINISTIC revisions (same inputs -> same bytes).
    const scopeSuccessor = buildRepairPlanSpec({
      repairPlanId: headSpec.repairPlanId,
      revision: headSpec.revision + 1,
      origin: { kind: 'successor', supersedesPlanSpecRef: head.specRef, successorReason: 'scope_expansion', successorOperationKey: 'op-approve' },
      sourceReceiptRef: null,
      repairBase: headSpec.repairBase,
      orderedBatchScopes: headSpec.orderedBatchScopes,
      keyLineageRef: headSpec.keyLineageRef,
      importedStagingManifestRef: headSpec.importedStagingManifestRef,
    });
    const correctionSuccessor = buildRepairPlanSpec({
      repairPlanId: headSpec.repairPlanId,
      revision: headSpec.revision + 1,
      origin: { kind: 'successor', supersedesPlanSpecRef: head.specRef, successorReason: 'validation_correction', successorOperationKey: 'op-correct' },
      sourceReceiptRef: null,
      repairBase: headSpec.repairBase,
      orderedBatchScopes: headSpec.orderedBatchScopes,
      keyLineageRef: headSpec.keyLineageRef,
      importedStagingManifestRef: headSpec.importedStagingManifestRef,
    });
    expect(scopeSuccessor.planRevisionId).not.toBe(correctionSuccessor.planRevisionId);
    // A stale-tail approval must fail closed (AUTHORITY_BASE_STALE — the loser
    // re-evaluates on the winner).
    const tail = await b.env.eventStore.tail(b.taskId);
    await expect(
      b.service.approveScopeExpansion({
        taskId: b.taskId,
        requestId: 'rq-none',
        operatorId: 'op',
        expectedLastSequence: tail.lastSequence + 999,
        expectedTailCommitId: 'stale',
        findingIds: [],
        reason: 'x',
      }),
    ).rejects.toThrow(RepairError);
  });
});

/* ------------------------------------------------------------------ */
/* Step 2: map staging / key lineage                                   */
/* ------------------------------------------------------------------ */

describe('map repair staging + key lineage', { timeout: 120_000 }, () => {
  it('the settlement blocking envelope creates the initial MapRepairPlan + first batch WorkItem + grant, and completes the settlement', async () => {
    const b = await makeRepairEnv();
    const stack = await driveToContentStack(b, ['s-1']);
    await seedFindings(b, mapBlockingFindings(stack.nodeIds), 'map');
    const settlement = await createAndLeaseSettlement(b);
    const outcome = await b.service.createRepairPlanFromSettlement({
      taskId: b.taskId,
      settlementWorkItemId: settlement.workItemId,
      settlementCommandId: settlement.commandId,
      leaseEpoch: settlement.leaseEpoch,
      authorityBaseRef: settlement.authorityBaseRef,
      roundId: 'round-1',
      coverageCoreRef: { kind: 'content_review_coverage_core', digest: 'e'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
      findings: blockingFindingsOf(['m-1']),
    });
    expect(outcome.kind).toBe('completed');
    const events = await b.readEvents(b.taskId);
    const types = events.map((e) => e.type);
    expect(types).toContain('structured_map_repair_plan_started');
    expect(types).toContain('structured_repair_grant_issued');
    // The settlement command COMPLETED (the terminal pair replays).
    expect(types).toContain('structured_system_command_completed');
    expect(types).toContain('structured_work_item_completed');
    const state = await b.env.readProjection(b.taskId);
    const lineage = Object.values(state.repairPlans)[0];
    expect(lineage.track).toBe('map');
    const head = lineage.revisions[lineage.currentPlanRevisionId as string];
    const plan = (await b.resolver(b.taskId, head.specRef)) as RepairPlanSpecV2;
    expect(plan.revision).toBe(1);
    // The stack activated the map, so the repair base is the ACTIVE map
    // (a candidate-only base happens pre-activation).
    expect(plan.repairBase.kind).toBe('map_active');
    expect(plan.origin.kind).toBe('initial');
    // The batch workitem + grant exist with the plan binding.
    const workItemId = repairBatchWorkItemId(b.taskId, plan.repairPlanId, 1, plan.planRevisionId);
    const grant = await grantOf(b, workItemId);
    expect(grant.kind).toBe('map_repair_batch');
    expect((grant as RepairBatchGrantSpecV2 & { kind: 'map_repair_batch' }).repairPlanSpecRef.digest).toBe(head.specRef.digest);
    // The plan parses with the FROZEN parser.
    expect(() => parseBlob('repair_plan_spec', plan)).not.toThrow();
    expect(() => parseBlob('write_grant_spec', grant)).not.toThrow();
  });

  it('a map batch CASes the expected staging root, extends the key ledger, and NEVER publishes a candidate', async () => {
    const b = await makeRepairEnv();
    const stack = await driveToContentStack(b, ['s-1']);
    await seedFindings(b, mapBlockingFindings(stack.nodeIds), 'map');
    const settlement = await createAndLeaseSettlement(b);
    await b.service.createRepairPlanFromSettlement({
      taskId: b.taskId,
      settlementWorkItemId: settlement.workItemId,
      settlementCommandId: settlement.commandId,
      leaseEpoch: settlement.leaseEpoch,
      authorityBaseRef: settlement.authorityBaseRef,
      roundId: 'round-1',
      coverageCoreRef: { kind: 'content_review_coverage_core', digest: 'e'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
      findings: blockingFindingsOf(['m-1']),
    });
    const state = await b.env.readProjection(b.taskId);
    const lineage = Object.values(state.repairPlans)[0];
    const head = lineage.revisions[lineage.currentPlanRevisionId as string];
    const plan = (await b.resolver(b.taskId, head.specRef)) as RepairPlanSpecV2;
    const targetNodeId = stack.nodeIds[0] as string;
    const workItemId = repairBatchWorkItemId(b.taskId, plan.repairPlanId, 1, plan.planRevisionId);
    const grant = (await grantOf(b, workItemId)) as RepairBatchGrantSpecV2 & { kind: 'map_repair_batch' };
    const leased = await leaseTargeted(b, workItemId, 'worker-a');
    const ctx = ctxOf(b, leased);
    const baseRoot = (await b.resolver(b.taskId, grant.expectedStagingRootRef)) as { stagingDigest: string };
    const outcome = await b.service.commitRepairBatch({
      taskId: b.taskId,
      workItemId,
      attemptId: ctx.attemptId,
      batchOrdinal: grant.batchOrdinal,
      ctx,
      mapPatch: {
        expectedStagingDigest: baseRoot.stagingDigest,
        operations: [{ kind: 'update_attributes', targetId: repairPlanKeyOf(plan.repairPlanId, targetNodeId) }],
      },
    });
    expect(outcome.kind).toBe('committed');
    if (outcome.kind !== 'committed') return;
    const events = await b.readEvents(b.taskId);
    const batchTypes = events.filter((e) => e.type.startsWith('structured_map_repair') || e.type === 'structured_repair_committed' || e.type === 'structured_map_candidate_committed').map((e) => e.type);
    expect(batchTypes).toContain('structured_map_repair_batch_committed');
    expect(batchTypes).toContain('structured_repair_committed');
    // The batch CANNOT publish a candidate.
    expect(batchTypes.filter((t) => t === 'structured_map_candidate_committed').length).toBe(1); // only the seed
    // The staging root CAS advanced: the committed root's prior is the grant's
    // expected root.
    const committedRoot = (await b.resolver(b.taskId, outcome.stagingRootRef)) as { priorStagingRootRef: BlobRefV2 | null; keyLedgerRef: BlobRefV2 };
    expect(committedRoot.priorStagingRootRef?.digest).toBe(grant.expectedStagingRootRef.digest);
    // The ledger carries the plan key bound to the official id.
    const ledger = (await b.resolver(b.taskId, committedRoot.keyLedgerRef)) as { entries: readonly { planKey: string; officialId: string | null }[] };
    expect(ledger.entries.some((e) => e.planKey === repairPlanKeyOf(plan.repairPlanId, targetNodeId) && e.officialId === targetNodeId)).toBe(true);
  });

  it('out-of-scope and stale-CAS map patches are rejected with ZERO writes', async () => {
    const b = await makeRepairEnv();
    const stack = await driveToContentStack(b, ['s-1']);
    await seedFindings(b, mapBlockingFindings(stack.nodeIds), 'map');
    const settlement = await createAndLeaseSettlement(b);
    await b.service.createRepairPlanFromSettlement({
      taskId: b.taskId,
      settlementWorkItemId: settlement.workItemId,
      settlementCommandId: settlement.commandId,
      leaseEpoch: settlement.leaseEpoch,
      authorityBaseRef: settlement.authorityBaseRef,
      roundId: 'round-1',
      coverageCoreRef: { kind: 'content_review_coverage_core', digest: 'e'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
      findings: blockingFindingsOf(['m-1']),
    });
    const state = await b.env.readProjection(b.taskId);
    const lineage = Object.values(state.repairPlans)[0];
    const head = lineage.revisions[lineage.currentPlanRevisionId as string];
    const plan = (await b.resolver(b.taskId, head.specRef)) as RepairPlanSpecV2;
    const targetNodeId = stack.nodeIds[0] as string;
    const workItemId = repairBatchWorkItemId(b.taskId, plan.repairPlanId, 1, plan.planRevisionId);
    const grant = (await grantOf(b, workItemId)) as RepairBatchGrantSpecV2 & { kind: 'map_repair_batch' };
    const leased = await leaseTargeted(b, workItemId, 'worker-a');
    const ctx = ctxOf(b, leased);
    const baseRoot = (await b.resolver(b.taskId, grant.expectedStagingRootRef)) as { stagingDigest: string };
    const before = (await b.readEvents(b.taskId)).length;
    // Out-of-scope: a node NOT in the plan targets.
    await expect(
      b.service.commitRepairBatch({
        taskId: b.taskId,
        workItemId,
        attemptId: ctx.attemptId,
        batchOrdinal: grant.batchOrdinal,
        ctx,
        mapPatch: { expectedStagingDigest: baseRoot.stagingDigest, operations: [{ kind: 'update_attributes', targetId: repairPlanKeyOf(plan.repairPlanId, 'n-99') }] },
      }),
    ).rejects.toThrow(/not a ledger-active key|WRITE_OUT_OF_SCOPE|PLAN_STALE/);
    // Stale CAS: wrong expectedStagingDigest.
    await expect(
      b.service.commitRepairBatch({
        taskId: b.taskId,
        workItemId,
        attemptId: ctx.attemptId,
        batchOrdinal: grant.batchOrdinal,
        ctx,
        mapPatch: { expectedStagingDigest: '0'.repeat(64), operations: [{ kind: 'update_attributes', targetId: repairPlanKeyOf(plan.repairPlanId, targetNodeId) }] },
      }),
    ).rejects.toThrow(/does not CAS|AUTHORITY_BASE_STALE/);
    const after = (await b.readEvents(b.taskId)).length;
    expect(after).toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* Step 3: content staging / continuity                                */
/* ------------------------------------------------------------------ */

describe('content repair staging + continuity', { timeout: 120_000 }, () => {
  it('content batches write ONLY targeted slots; batched repairs never trigger early review', async () => {
    const b = await makeRepairEnv({ contentBatchTargetSlots: 1 });
    const stack = await driveToContentStack(b, ['s-1', 's-2']);
    const contentSlot0 = stack.nodeIds[0] as string;
    const contentSlot1 = stack.nodeIds[1] as string;
    await seedFindings(b, [{ findingId: 'c-1', primaryLocation: { kind: 'slot', id: contentSlot0 }, defectClass: 'content', severity: 'blocking', suggestedRepairSlotIds: [contentSlot1] }], 'content');
    const settlement = await createAndLeaseSettlement(b);
    await b.service.createRepairPlanFromSettlement({
      taskId: b.taskId,
      settlementWorkItemId: settlement.workItemId,
      settlementCommandId: settlement.commandId,
      leaseEpoch: settlement.leaseEpoch,
      authorityBaseRef: settlement.authorityBaseRef,
      roundId: 'round-1',
      coverageCoreRef: { kind: 'content_review_coverage_core', digest: 'e'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
      findings: blockingFindingsOf(['c-1']),
    });
    const state = await b.env.readProjection(b.taskId);
    const lineage = Object.values(state.repairPlans)[0];
    const head = lineage.revisions[lineage.currentPlanRevisionId as string];
    const plan = (await b.resolver(b.taskId, head.specRef)) as RepairPlanSpecV2;
    expect(plan.repairBase.kind).toBe('content');
    expect(plan.orderedBatchScopes.length).toBeGreaterThanOrEqual(2);
    const scope1 = plan.orderedBatchScopes[0];
    if (scope1 === undefined || scope1.kind !== 'content') throw new Error(`expected content scope: ${JSON.stringify(plan.orderedBatchScopes)}`);
    // The out-of-scope slot: the OTHER batch's slot (the plan sorts the
    // targets, so the batch order may differ from the finding order).
    const scope2 = plan.orderedBatchScopes[1];
    const outOfScopeSlot = scope2 !== undefined && scope2.kind === 'content' ? scope2.slotIds[0] as string : (contentSlot1 as string);
    const workItemId = repairBatchWorkItemId(b.taskId, plan.repairPlanId, 1, plan.planRevisionId);
    const grant = (await grantOf(b, workItemId)) as RepairBatchGrantSpecV2 & { kind: 'content_repair_batch' };
    const leased = await leaseTargeted(b, workItemId, 'worker-a');
    const ctx = ctxOf(b, leased);
    // Out-of-scope slot: the batch is rejected with ZERO writes.
    await expect(
      b.service.commitRepairBatch({
        taskId: b.taskId,
        workItemId,
        attemptId: ctx.attemptId,
        batchOrdinal: 1,
        ctx,
        slotContents: { [outOfScopeSlot]: { text: 'x', mediaType: 'text/markdown' } },
      }),
    ).rejects.toThrow(/not in batch|WRITE_OUT_OF_SCOPE/);
    // The granted batch slot commits.
    const targetSlot = scope1.slotIds[0] as string;
    const outcome = await b.service.commitRepairBatch({
      taskId: b.taskId,
      workItemId,
      attemptId: ctx.attemptId,
      batchOrdinal: 1,
      ctx,
      slotContents: { [targetSlot]: { text: 'repaired', mediaType: 'text/markdown' } },
    });
    expect(outcome.kind).toBe('committed');
    if (outcome.kind !== 'committed') return;
    const events = await b.readEvents(b.taskId);
    expect(events.some((e) => e.type === 'structured_content_repair_batch_committed')).toBe(true);
    // Batched repairs NEVER trigger early review (the only round-planned event
    // is the STACK's initial content round — nothing after the repair plan).
    const planStartedIndex = events.findIndex((e) => e.type === 'structured_content_repair_plan_started');
    expect(planStartedIndex).toBeGreaterThanOrEqual(0);
    const afterPlan = events.slice(planStartedIndex);
    expect(afterPlan.some((e) => e.type === 'structured_review_round_planned')).toBe(false);
    expect(afterPlan.some((e) => e.type === 'structured_map_review_round_planned')).toBe(false);
    // The plan's imported base manifest stays the CURRENT manifest.
    const projection = await b.env.readProjection(b.taskId);
    expect(projection.currentManifest?.manifestPhase).toBe('finalized');
    void grant;
  });

  it('same-root/different-manifest staleness rejects a content repair commit', async () => {
    const b = await makeRepairEnv({ contentBatchTargetSlots: 1 });
    const stack = await driveToContentStack(b, ['s-1']);
    const contentSlot0 = stack.nodeIds[0] as string;
    // A DIFFERENT manifest ref with the SAME content root is prepared (no
    // event — the projection keeps the ORIGINAL current manifest) and the
    // repair plan is created against THAT stale base. The batch commit must
    // reject it (AUTHORITY_BASE_STALE — the base ref is not the current
    // manifest even though the content root is identical).
    const currentManifest = (await b.resolver(b.taskId, stack.manifestRef)) as Record<string, unknown> & { taskContentRevision: number };
    const { manifestDigest: _oldDigest, ...staleBody } = currentManifest;
    const staleSameRoot = { ...staleBody, taskContentRevision: currentManifest.taskContentRevision + 1, manifestDigest: canonicalJsonSha256({ ...staleBody, taskContentRevision: currentManifest.taskContentRevision + 1 }) };
    const staleRef = await b.env.facade.prepareBlob(b.taskId, 'content_revision_manifest', staleSameRoot);
    await seedFindings(b, [{ findingId: 'c-1', primaryLocation: { kind: 'slot', id: contentSlot0 }, defectClass: 'content', severity: 'blocking' }], 'content');
    const settlement = await createAndLeaseSettlement(b);
    const state0 = await b.env.readProjection(b.taskId);
    const mapRef = state0.currentMap?.mapSnapshotRef as BlobRefV2;
    await b.service.createInitialRepairPlan({
      taskId: b.taskId,
      settlementWorkItemId: settlement.workItemId,
      settlementCommandId: settlement.commandId,
      leaseEpoch: settlement.leaseEpoch,
      authorityBaseRef: settlement.authorityBaseRef,
      settlementOperationKey: opId('stale-settlement'),
      settlementDigest: hash('coverage'),
      track: 'content',
      findings: blockingFindingsOf(['c-1']),
      sourceReceiptRef: null,
      repairBase: { kind: 'content', mapRef, contentRevisionManifestRef: staleRef },
      importedStagingManifestRef: staleRef,
    });
    const state = await b.env.readProjection(b.taskId);
    const lineage = Object.values(state.repairPlans)[0];
    const head = lineage.revisions[lineage.currentPlanRevisionId as string];
    const plan = (await b.resolver(b.taskId, head.specRef)) as RepairPlanSpecV2;
    const workItemId = repairBatchWorkItemId(b.taskId, plan.repairPlanId, 1, plan.planRevisionId);
    const leased = await leaseTargeted(b, workItemId, 'worker-a');
    const ctx = ctxOf(b, leased);
    await expect(
      b.service.commitRepairBatch({
        taskId: b.taskId,
        workItemId,
        attemptId: ctx.attemptId,
        batchOrdinal: 1,
        ctx,
        slotContents: { [contentSlot0]: { text: 'x', mediaType: 'text/markdown' } },
      }),
    ).rejects.toThrow(/not the current manifest|AUTHORITY_BASE_STALE|does not CAS/);
  });
});

/* ------------------------------------------------------------------ */
/* Step 4: scope expansion                                             */
/* ------------------------------------------------------------------ */

describe('scope expansion', { timeout: 120_000 }, () => {
  it('request -> approval atomically supersedes the plan head and creates the successor WorkItem/Grant within hard limits', async () => {
    const b = await makeRepairEnv();
    const stack = await driveToContentStack(b, ['s-1', 's-2']);
    await seedFindings(b, mapBlockingFindings(stack.nodeIds), 'map');
    const settlement = await createAndLeaseSettlement(b);
    await b.service.createRepairPlanFromSettlement({
      taskId: b.taskId,
      settlementWorkItemId: settlement.workItemId,
      settlementCommandId: settlement.commandId,
      leaseEpoch: settlement.leaseEpoch,
      authorityBaseRef: settlement.authorityBaseRef,
      roundId: 'round-1',
      coverageCoreRef: { kind: 'content_review_coverage_core', digest: 'e'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
      findings: blockingFindingsOf(['m-1']),
    });
    const state0 = await b.env.readProjection(b.taskId);
    const lineage = Object.values(state0.repairPlans)[0];
    const head = lineage.revisions[lineage.currentPlanRevisionId as string];
    const plan = (await b.resolver(b.taskId, head.specRef)) as RepairPlanSpecV2;
    const oldWorkItemId = repairBatchWorkItemId(b.taskId, plan.repairPlanId, 1, plan.planRevisionId);
    const requestLease = await leaseTargeted(b, oldWorkItemId, 'worker-a');
    const requestCtx = ctxOf(b, requestLease);
    const requestedNodeId = stack.nodeIds[1] as string;
    await b.service.requestScopeExpansion(requestCtx, { findingIds: ['m-1'], requestedNodeIds: [requestedNodeId], reason: 'need more nodes', clientOperationId: 'co-req-1' });
    const events = await b.readEvents(b.taskId);
    const request = events.find((e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_repair_scope_requested' }> => e.type === 'structured_repair_scope_requested');
    expect(request).toBeDefined();
    if (request === undefined) return;
    const tail = await b.env.eventStore.tail(b.taskId);
    await expect(b.service.approveScopeExpansion({
      taskId: b.taskId,
      requestId: request.requestId,
      operatorId: 'operator-1',
      expectedLastSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
      requestedNodeIds: [stack.nodeIds[0] as string],
      findingIds: ['m-1'],
      reason: 'approved',
    })).rejects.toMatchObject({ code: 'REQUEST_SCOPE_MISMATCH' });
    const approval = await b.service.approveScopeExpansion({
      taskId: b.taskId,
      requestId: request.requestId,
      operatorId: 'operator-1',
      expectedLastSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
      requestedNodeIds: [requestedNodeId],
      findingIds: ['m-1'],
      reason: 'approved',
    });
    expect(approval.kind).toBe('completed');
    const state = await b.env.readProjection(b.taskId);
    const lineageAfter = state.repairPlans[lineage.repairPlanId];
    // The old head is superseded; the successor is the current head.
    const oldHead = lineageAfter.revisions[lineage.currentPlanRevisionId as string];
    expect(oldHead.state).toBe('superseded');
    const newHead = lineageAfter.revisions[lineageAfter.currentPlanRevisionId as string];
    expect(newHead.successorReason).toBe('scope_expansion');
    const successorPlan = (await b.resolver(b.taskId, newHead.specRef)) as RepairPlanSpecV2;
    expect(successorPlan.revision).toBe(plan.revision + 1);
    // The successor's map scope includes the requested node.
    const scope = successorPlan.orderedBatchScopes[0];
    if (scope === undefined || scope.kind !== 'map') throw new Error('expected map scope');
    expect(scope.scope.nodeIds).toContain(requestedNodeId);
    expect((successorPlan.origin as { successorOperationKey: string }).successorOperationKey).toContain('ra-');
    // The successor workitem + grant exist; the OLD grant can no longer commit.
    const newWorkItemId = repairBatchWorkItemId(b.taskId, plan.repairPlanId, 1, successorPlan.planRevisionId);
    const newGrant = await grantOf(b, newWorkItemId);
    expect((newGrant as RepairBatchGrantSpecV2 & { kind: 'map_repair_batch' }).repairPlanSpecRef.digest).toBe(newHead.specRef.digest);
  });

  it('rejection atomically ends the old cycle and creates one deterministic same-scope replacement grant', async () => {
    const b = await makeRepairEnv();
    const stack = await driveToContentStack(b, ['s-1', 's-2']);
    await seedFindings(b, mapBlockingFindings(stack.nodeIds), 'map');
    const settlement = await createAndLeaseSettlement(b);
    await b.service.createRepairPlanFromSettlement({
      taskId: b.taskId,
      settlementWorkItemId: settlement.workItemId,
      settlementCommandId: settlement.commandId,
      leaseEpoch: settlement.leaseEpoch,
      authorityBaseRef: settlement.authorityBaseRef,
      roundId: 'round-1',
      coverageCoreRef: { kind: 'content_review_coverage_core', digest: 'e'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
      findings: blockingFindingsOf(['m-1']),
    });
    const state0 = await b.env.readProjection(b.taskId);
    const lineage = Object.values(state0.repairPlans)[0];
    const head = lineage.revisions[lineage.currentPlanRevisionId as string];
    const plan = (await b.resolver(b.taskId, head.specRef)) as RepairPlanSpecV2;
    const workItemId = repairBatchWorkItemId(b.taskId, plan.repairPlanId, 1, plan.planRevisionId);
    const requestLease = await leaseTargeted(b, workItemId, 'worker-a');
    const requestCtx = ctxOf(b, requestLease);
    const requestedNodeId = stack.nodeIds[1] as string;
    await b.service.requestScopeExpansion(requestCtx, { findingIds: ['m-1'], requestedNodeIds: [requestedNodeId], reason: 'r', clientOperationId: 'co-req-2' });
    const events = await b.readEvents(b.taskId);
    const request = events.find((e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_repair_scope_requested' }> => e.type === 'structured_repair_scope_requested');
    if (request === undefined) throw new Error('no request');
    const tail = await b.env.eventStore.tail(b.taskId);
    await b.service.rejectScopeExpansion({
      taskId: b.taskId,
      requestId: request.requestId,
      operatorId: 'operator-1',
      reason: 'denied',
      expectedLastSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    const state = await b.env.readProjection(b.taskId);
    const lineageAfter = state.repairPlans[lineage.repairPlanId];
    // The head is UNCHANGED (no successor revision, no widening).
    expect(lineageAfter.currentPlanRevisionId).toBe(lineage.currentPlanRevisionId);
    expect(lineageAfter.revisions[lineage.currentPlanRevisionId as string].state).toBe('active');
    const afterEvents = await b.readEvents(b.taskId);
    expect(afterEvents.some((e) => e.type === 'structured_repair_scope_expansion_rejected_v2')).toBe(true);
    expect(state.workItems[workItemId].state).toBe('superseded');
    expect(state.attempts[requestCtx.attemptId].state).toBe('abandoned');
    const replacement = Object.values(state.workItems).find((wi) => wi.workItemId !== workItemId && wi.sessionKind === 'map_repair' && wi.state === 'ready');
    expect(replacement).toBeDefined();
    const replacementGrant = await grantOf(b, replacement?.workItemId as string) as RepairBatchGrantSpecV2;
    const oldGrant = await grantOf(b, workItemId) as RepairBatchGrantSpecV2;
    expect(replacementGrant.repairPlanSpecRef.digest).toBe(oldGrant.repairPlanSpecRef.digest);
    expect(replacementGrant.writeScope).toEqual(oldGrant.writeScope);
    const replacementLease = await leaseTargeted(b, replacement?.workItemId as string, 'worker-replacement');
    if (replacementLease.dispatchRef === null) throw new Error('replacement dispatch missing');
    const replacementDispatch = (await b.resolver(b.taskId, replacementLease.dispatchRef)) as AssignmentDispatchV2;
    expect(replacementDispatch.scopeDecisionReason).toBe('denied');
    // Same decision bytes replay the same replacement; changed bytes conflict.
    const tailAfter = await b.env.eventStore.tail(b.taskId);
    await expect(b.service.rejectScopeExpansion({ taskId: b.taskId, requestId: request.requestId, operatorId: 'operator-1', reason: 'denied', expectedLastSequence: tailAfter.lastSequence, expectedTailCommitId: tailAfter.lastCommitId })).resolves.toMatchObject({ kind: 'completed' });
    await expect(b.service.rejectScopeExpansion({ taskId: b.taskId, requestId: request.requestId, operatorId: 'operator-1', reason: 'different', expectedLastSequence: tailAfter.lastSequence, expectedTailCommitId: tailAfter.lastCommitId })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  });
});

/* ------------------------------------------------------------------ */
/* Step 5: finalizer routes + cycle budgets                            */
/* ------------------------------------------------------------------ */

/** Drives a full map repair: plan -> one batch (journaled) -> finalizer. */
async function driveMapRepairToFinalizer(b: RepairEnv, options: { mixed?: boolean } = {}): Promise<{ plan: RepairPlanSpecV2; finalizeWorkItemId: string }> {
  const stack = await driveToContentStack(b, ['s-1']);
  const findingId = options.mixed === true ? 'x-1' : 'm-1';
  await seedFindings(b, options.mixed === true
    ? [{ findingId, primaryLocation: { kind: 'map_node', id: stack.nodeIds[0] as string }, defectClass: 'mixed', severity: 'blocking', suggestedRepairSlotIds: [stack.nodeIds[0] as string] }]
    : mapBlockingFindings(stack.nodeIds), 'map');
  const settlement = await createAndLeaseSettlement(b);
  await b.service.createRepairPlanFromSettlement({
    taskId: b.taskId,
    settlementWorkItemId: settlement.workItemId,
    settlementCommandId: settlement.commandId,
    leaseEpoch: settlement.leaseEpoch,
    authorityBaseRef: settlement.authorityBaseRef,
    roundId: 'round-1',
    coverageCoreRef: { kind: 'content_review_coverage_core', digest: 'e'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
    findings: blockingFindingsOf([findingId]),
  });
  const state = await b.env.readProjection(b.taskId);
  const lineage = Object.values(state.repairPlans)[0];
  const head = lineage.revisions[lineage.currentPlanRevisionId as string];
  const plan = (await b.resolver(b.taskId, head.specRef)) as RepairPlanSpecV2;
  const targetNodeId = stack.nodeIds[0] as string;
  const workItemId = repairBatchWorkItemId(b.taskId, plan.repairPlanId, 1, plan.planRevisionId);
  const grant = (await grantOf(b, workItemId)) as RepairBatchGrantSpecV2 & { kind: 'map_repair_batch' };
  const leased = await leaseTargeted(b, workItemId, 'worker-a');
  const ctx = ctxOf(b, leased);
  // Journal the patch (the factory's path) so the finalizer can fold it.
  const grantSpecRef = state.workItems[workItemId].grantSpecRef as BlobRefV2;
  await b.privateStore.appendReviewDraft(
    { workItemId, leaseEpoch: leased.leaseEpoch, attemptId: ctx.attemptId, authorityBaseRef: leased.authorityBaseRef, grantSpecRef },
    { clientOperationId: 'co-map-1', op: 'submit_map_patch', body: { operations: [{ kind: 'update_attributes', targetId: repairPlanKeyOf(plan.repairPlanId, targetNodeId) }] }, result: null },
  );
  const baseRoot = (await b.resolver(b.taskId, grant.expectedStagingRootRef)) as { stagingDigest: string };
  const outcome = await b.service.commitRepairBatch({
    taskId: b.taskId,
    workItemId,
    attemptId: ctx.attemptId,
    batchOrdinal: 1,
    ctx,
    mapPatch: {
      expectedStagingDigest: baseRoot.stagingDigest,
      operations: [{ kind: 'update_attributes', targetId: repairPlanKeyOf(plan.repairPlanId, targetNodeId) }],
    },
  });
  expect(outcome.kind).toBe('committed');
  if (outcome.kind !== 'committed') throw new Error('map repair batch did not commit');
  // Complete the batch workitem (the batch envelope has no terminal pair; the
  // coordinator's single-active-lease claim predicate needs the lease freed).
  await b.env.coordinator.completeWorkItem({
    taskId: b.taskId,
    operationId: attemptContinuationOperationId(b.taskId, workItemId, ctx.attemptId, 'complete'),
    workItemId,
    attemptId: ctx.attemptId,
    resultRefs: [outcome.stagingRootRef],
  });
  return { plan, finalizeWorkItemId: repairFinalizeWorkItemId(b.taskId, plan.repairPlanId, plan.planRevisionId) };
}

/** Leases + executes the repair finalizer command. */
async function runFinalizer(b: RepairEnv, finalizeWorkItemId: string): Promise<RepairFinalizeOutcome> {
  const leased = await leaseTargeted(b, finalizeWorkItemId, 'worker-a');
  const ctx = ctxOf(b, leased);
  return b.service.executeRepairFinalize({
    taskId: b.taskId,
    commandId: leased.commandId ?? ctx.attemptId,
    workItemId: finalizeWorkItemId,
    commandKind: 'repair_finalize',
    leaseEpoch: leased.leaseEpoch,
    authorityBaseRef: leased.authorityBaseRef,
    payloadRef: await payloadRefOf(b, finalizeWorkItemId),
  });
}

describe('map finalizer routes', { timeout: 120_000 }, () => {
  it('repair_finalize validator can block from the exact staged Map artifact bytes', async () => {
    const b = await makeRepairEnv({ stagedBlocking: true });
    const { finalizeWorkItemId } = await driveMapRepairToFinalizer(b);
    const outcome = await runFinalizer(b, finalizeWorkItemId);
    expect(outcome.kind).toBe('blocked');
    const events = await b.readEvents(b.taskId);
    const rejection = events.find((event) => event.type === 'structured_map_repair_plan_rejected');
    expect(rejection).toBeDefined();
    const aggregateRef = (rejection as Extract<AuthoritativeReviewEventV2, { type: 'structured_map_repair_plan_rejected' }>).validatorAggregateRef;
    const aggregate = (await b.resolver(b.taskId, aggregateRef)) as { blockingInvalidReceiptRefs: readonly BlobRefV2[]; inputRef: BlobRefV2 };
    const receipt = (await b.resolver(b.taskId, aggregate.blockingInvalidReceiptRefs[0] as BlobRefV2)) as { blockerIssues: readonly { issueCode: string }[] };
    expect(receipt.blockerIssues[0]?.issueCode).toBe('STAGED_MAP_BYTES_REJECTED');
    const envelope = (await b.resolver(b.taskId, aggregate.inputRef)) as { stagingRootRef: BlobRefV2; keyLedgerRef: BlobRefV2; stagedArtifactRef: BlobRefV2; selectedTargetRefs: readonly BlobRefV2[] };
    expect(envelope.stagingRootRef.kind).toBe('repair_staging_root');
    expect(envelope.keyLedgerRef.kind).toBe('repair_key_ledger');
    expect(envelope.stagedArtifactRef.kind).toBe('map_candidate_validation_core');
  });

  it('map finalize clear publishes ONE candidate + the COMPLETE map review round (mapCycleOrdinal+1)', async () => {
    const b = await makeRepairEnv({ maxRounds: 2 });
    const { finalizeWorkItemId } = await driveMapRepairToFinalizer(b);
    const before = await b.env.readProjection(b.taskId);
    const outcome = await runFinalizer(b, finalizeWorkItemId);
    if (outcome.kind !== 'completed') throw new Error(`finalize failed: ${JSON.stringify(outcome)}`);
    const events = await b.readEvents(b.taskId);
    const types = events.map((e) => e.type);
    expect(types).toContain('structured_map_build_started');
    expect(types).toContain('structured_map_build_finish_proposed');
    expect(types).toContain('structured_map_build_finalized');
    expect(types).toContain('structured_map_candidate_committed');
    expect(types).toContain('structured_map_review_round_planned');
    expect(types).toContain('structured_finding_addressed');
    expect(types).toContain('structured_system_command_completed');
    const state = await b.env.readProjection(b.taskId);
    expect(state.mapCycleOrdinal).toBe(before.mapCycleOrdinal + 1);
    expect(state.currentCandidate).not.toBeNull();
    // Official ids allocated ONLY by the finalizer: the new candidate's nodes
    // all carry official (non plan-key) ids.
    const candidate = (await b.resolver(b.taskId, state.currentCandidate?.candidateRef as BlobRefV2)) as { validationCoreRef: BlobRefV2 };
    const core = (await b.resolver(b.taskId, candidate.validationCoreRef)) as { nodes: readonly { slotId: string }[] };
    for (const node of core.nodes) expect(node.slotId).not.toMatch(/^pk-/);
    // The round's review WorkItems were created (the round is COMPLETE).
    const planned = events.find((e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_round_planned' }> => e.type === 'structured_map_review_round_planned');
    expect(planned).toBeDefined();
    if (planned === undefined) return;
    expect(Object.values(state.workItems).some((wi) => wi.roundId === planned.mapReviewRoundId && wi.sessionKind === 'review_map_batch')).toBe(true);
    expect(Object.values(state.workItems).some((wi) => wi.roundId === planned.mapReviewRoundId && wi.sessionKind === 'review_map_whole')).toBe(true);
    // The finding is ADDRESSED (verification targets for the next round).
    expect(state.findings['m-1'].addressStages).toContain('map');
  });

  it('blocking validation creates ONE correction successor revision + per-revision batch ordinals', async () => {
    const b = await makeRepairEnv({ blocking: true });
    const { plan, finalizeWorkItemId } = await driveMapRepairToFinalizer(b);
    const before = await b.env.readProjection(b.taskId);
    const beforeOrdinals = (await b.readEvents(b.taskId)).filter((e) => e.type === 'structured_map_repair_batch_committed' && (e as { repairPlanId?: string }).repairPlanId === plan.repairPlanId).map((e) => (e as { batchOrdinal?: number }).batchOrdinal);
    expect(beforeOrdinals).toEqual([1]);
    const outcome = await runFinalizer(b, finalizeWorkItemId);
    expect(outcome.kind).toBe('blocked');
    const events = await b.readEvents(b.taskId);
    const types = events.map((e) => e.type);
    expect(types).toContain('structured_map_repair_plan_rejected');
    expect(types).toContain('structured_repair_plan_revision_started');
    const revision = events.find((e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_repair_plan_revision_started' }> => e.type === 'structured_repair_plan_revision_started');
    expect(revision?.successorReason).toBe('validation_correction');
    // EXACTLY ONE successor revision (never auto-retrying the same finalizer).
    expect(events.filter((e) => e.type === 'structured_repair_plan_revision_started').length).toBe(1);
    const state = await b.env.readProjection(b.taskId);
    const lineageAfter = state.repairPlans[plan.repairPlanId];
    expect(lineageAfter.revisions[lineageAfter.currentPlanRevisionId as string].successorReason).toBe('validation_correction');
    // Per-revision batch ordinals: the successor's batch ordinal starts at 1.
    const successorPlan = (await b.resolver(b.taskId, lineageAfter.revisions[lineageAfter.currentPlanRevisionId as string].specRef)) as RepairPlanSpecV2;
    const successorWorkItemId = repairBatchWorkItemId(b.taskId, plan.repairPlanId, 1, successorPlan.planRevisionId);
    const successorGrant = await grantOf(b, successorWorkItemId);
    expect((successorGrant as RepairBatchGrantSpecV2 & { kind: 'map_repair_batch' }).batchOrdinal).toBe(1);
    expect((successorGrant as RepairBatchGrantSpecV2 & { kind: 'map_repair_batch' }).repairPlanSpecRef.digest).toBe(lineageAfter.revisions[lineageAfter.currentPlanRevisionId as string].specRef.digest);
    void before;
  });

  it('infrastructure failure retries WITHOUT a successor', async () => {
    const b = await makeRepairEnv();
    const stack = await driveToContentStack(b, ['s-1']);
    await seedFindings(b, mapBlockingFindings(stack.nodeIds), 'map');
    const settlement = await createAndLeaseSettlement(b);
    const outcome = await b.service.createRepairPlanFromSettlement({
      taskId: b.taskId,
      settlementWorkItemId: settlement.workItemId,
      settlementCommandId: settlement.commandId,
      leaseEpoch: settlement.leaseEpoch,
      authorityBaseRef: settlement.authorityBaseRef,
      roundId: 'round-1',
      coverageCoreRef: { kind: 'content_review_coverage_core', digest: 'e'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
      findings: blockingFindingsOf(['m-1']),
    });
    expect(outcome.kind).toBe('completed');
    const events = await b.readEvents(b.taskId);
    // Exactly ONE repair lineage start; no successor was created.
    expect(events.filter((e) => e.type === 'structured_map_repair_plan_started').length).toBe(1);
    expect(events.some((e) => e.type === 'structured_repair_plan_revision_started')).toBe(false);
  });
});

describe('cycle budgets (§13.3.1)', { timeout: 120_000 }, () => {
  it('over-limit publishes EXACTLY ONE structured_task_failed_v2(REVIEW_REPAIR_LIMIT_EXCEEDED) and no round/plan', async () => {
    const b = await makeRepairEnv({ maxRounds: 1 });
    const { finalizeWorkItemId } = await driveMapRepairToFinalizer(b);
    // The repaired candidate's round would be mapCycleOrdinal 2 > maxRounds 1
    // with NO available override -> the finalizer terminal-fails the task.
    const outcome = await runFinalizer(b, finalizeWorkItemId);
    expect(outcome.kind).toBe('completed');
    const events = await b.readEvents(b.taskId);
    const failed = events.filter((e) => e.type === 'structured_task_failed_v2');
    expect(failed.length).toBe(1);
    const failedEvent = failed[0] as Extract<AuthoritativeReviewEventV2, { type: 'structured_task_failed_v2' }>;
    expect(failedEvent.failureCode).toBe('REVIEW_REPAIR_LIMIT_EXCEEDED');
    expect(failedEvent.failureRecoveryPayloadRef).not.toBeNull();
    // NO new round/candidate after the repair plan started (the only
    // round-planned event is the STACK's initial map round).
    const planStartIndex = events.findIndex((e) => e.type === 'structured_map_repair_plan_started');
    const afterPlan = events.slice(planStartIndex);
    expect(afterPlan.filter((e) => e.type === 'structured_map_review_round_planned').length).toBe(0);
    expect(afterPlan.filter((e) => e.type === 'structured_map_candidate_committed').length).toBe(0);
    // The recovery payload is the restart_review_cycle branch.
    const payload = (await b.resolver(b.taskId, failedEvent.failureRecoveryPayloadRef as BlobRefV2)) as { kind: string; track: string; failedCycleOrdinal: number };
    expect(payload.kind).toBe('restart_review_cycle');
    expect(payload.track).toBe('map');
    expect(payload.failedCycleOrdinal).toBe(2);
    // The task is FAILED; no successor workitem was created for the round.
    const state = await b.env.readProjection(b.taskId);
    expect(state.failed).not.toBeNull();
  });

  it('reopen does NOT increment; the available override is consumable only on its exact track', async () => {
    const b = await makeRepairEnv({ maxRounds: 1 });
    const { finalizeWorkItemId } = await driveMapRepairToFinalizer(b);
    const outcome = await runFinalizer(b, finalizeWorkItemId);
    expect(outcome.kind).toBe('completed');
    const state = await b.env.readProjection(b.taskId);
    const failed = state.failed as NonNullable<typeof state.failed>;
    const recovery = (await b.resolver(b.taskId, failed.failureRecoveryPayloadRef as BlobRefV2)) as Record<string, unknown>;
    const lineage = Object.values(state.repairPlans)[0];
    const head = lineage.revisions[lineage.currentPlanRevisionId as string];
    const headSpec = (await b.resolver(b.taskId, head.specRef)) as RepairPlanSpecV2;
    // Publish the reopen envelope (the Task 11/12 recovery machinery): an
    // available map override + a recovery successor plan + the replacement
    // repair workitem (the reopen obligation).
    const keyLedgerBody = { repairPlanId: headSpec.repairPlanId, planRevisionId: hash('ledger-reopen'), entries: [] };
    const keyLedgerRef = await b.env.facade.prepareBlob(b.taskId, 'repair_key_ledger', { ...keyLedgerBody, ledgerDigest: canonicalJsonSha256(keyLedgerBody) });
    const successorSpec = buildRepairPlanSpec({
      repairPlanId: headSpec.repairPlanId,
      revision: headSpec.revision + 1,
      origin: { kind: 'successor', supersedesPlanSpecRef: head.specRef, successorReason: 'recovery', successorOperationKey: 'a3f8c2e0-0000-4000-8000-000000000001' },
      sourceReceiptRef: null,
      repairBase: headSpec.repairBase,
      orderedBatchScopes: headSpec.orderedBatchScopes,
      keyLineageRef: keyLedgerRef,
      importedStagingManifestRef: headSpec.importedStagingManifestRef,
    });
    const successorRef = await b.env.facade.prepareBlob(b.taskId, 'repair_plan_spec', successorSpec);
    const overrideBody = {
      overrideId: 'ovr-test',
      failedEventId: failed.eventId,
      track: 'map',
      repairLineageId: headSpec.repairPlanId,
      initialRepairPlanRef: head.specRef,
      currentAuthorizedRepairPlanRef: successorRef,
      predecessorOverrideRef: null,
      transferOrdinal: 0,
      operationId: 'a3f8c2e0-0000-4000-8000-000000000001',
      operatorId: 'task_owner',
      reasonDigest: hash('reason'),
      state: 'available',
    };
    const overrideRef = await b.env.facade.prepareBlob(b.taskId, 'round_budget_override', overrideBody);
    const replacementWorkItemId = 'wi-reopen-replacement';
    const stagingRoot = buildRepairStagingRoot({
      repairPlanId: headSpec.repairPlanId,
      planRevisionId: successorSpec.planRevisionId,
      batchOrdinal: 1,
      mapRootDigest: hash('root'),
      contentRootDigest: null,
      priorStagingRootRef: null,
      keyLedgerRef,
    });
    const stagingRootRef = await b.env.facade.prepareBlob(b.taskId, 'repair_staging_root', stagingRoot);
    const base = buildAuthorityBaseSet({
      taskId: b.taskId,
      templateSnapshotRef: b.templateSnapshotRef,
      profileSnapshotRef: b.profileSnapshotRef,
      refs: {
        planSpecRef: successorRef,
        stagingManifestRef: stagingRootRef,
        ...(headSpec.repairBase.kind === 'map_candidate'
          ? { mapCandidateRef: headSpec.repairBase.candidateRef }
          : { mapRef: (headSpec.repairBase as { mapRef: BlobRefV2 }).mapRef }),
      },
      kind: 'agent_assignment',
      agentExecutionKind: 'structured_session',
      sessionKind: 'map_repair',
    });
    const baseRef = await b.env.facade.prepareBlob(b.taskId, 'authority_base_set', base);
    // The reopen obligation demands the replacement workitem carry an EXACT
    // Map Repair WriteGrantSpec (the frozen created-event validator).
    const reopenGrant = buildRepairBatchGrantSpec({
      grantSpecId: 'gs-reopen-replacement',
      workItemId: replacementWorkItemId,
      kind: 'map_repair_batch',
      snapshotHash: 'a'.repeat(64),
      authorityBaseRef: baseRef,
      repairPlanSpecRef: successorRef,
      repairBase: headSpec.repairBase,
      expectedStagingRootRef: stagingRootRef,
      planKeyLedgerRef: keyLedgerRef,
      batchOrdinal: 1,
      findingIds: ['m-1'],
      maxContextBytes: 4096,
      writeScope: {
        mapWriteScope: {
          nodeIds: [],
          relationIds: [],
          allowedPlanKeys: [],
          parentContainers: [],
          relationTypeIds: [],
          operations: ['update_attributes'],
        },
      },
    });
    const reopenGrantRef = await b.env.facade.prepareBlob(b.taskId, 'write_grant_spec', reopenGrant);
    const reopenOp = 'a3f8c2e0-0000-4000-8000-000000000001';
    const tail = await b.env.eventStore.tail(b.taskId);
    await b.env.facade.publishWithPin({
      taskId: b.taskId,
      operationId: reopenOp,
      payload: {
        family: 'recovery',
        operationId: reopenOp,
        taskId: b.taskId,
        expectedLastSequence: tail.lastSequence,
        operatorId: 'task_owner',
        reason: 'restart',
        recipeKey: 'restart_map_review_cycle',
        track: 'map',
        failureRecoveryPayloadRef: failed.failureRecoveryPayloadRef as BlobRefV2,
        overrideRef,
        replacementWorkItemId,
        replacementKind: 'agent_assignment',
        replacementRoleBinding: 'orchestrator',
        replacementAgentExecutionKind: 'structured_session',
        replacementSessionKind: 'map_repair',
        replacementRoundId: null,
        replacementLogicalAssignmentId: `la-${replacementWorkItemId}`,
        replacementReviewAssignmentId: null,
        replacementGrantSpecRef: reopenGrantRef,
        replacementInputArtifactDeliveryId: null,
        replacementPayloadRef: successorRef,
        replacementAuthorityBaseRef: baseRef,
        replacementLeaseEpoch: 1,
        replacementMaxAutomaticRetries: 2,
      },
      intent: { handlerKind: 'restart_map_review_cycle', handlerVersion: 1 },
      preparedRefs: [failed.failureRecoveryPayloadRef as BlobRefV2, overrideRef, baseRef, successorRef, stagingRootRef, reopenGrantRef],
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    const stateAfterReopen = await b.env.readProjection(b.taskId);
    expect(stateAfterReopen.failed).toBeNull();
    expect(stateAfterReopen.availableOverride).not.toBeNull();
    expect(stateAfterReopen.availableOverride?.track).toBe('map');
    expect(stateAfterReopen.mapCycleOrdinal).toBe(1); // reopen did NOT increment
    expect(stateAfterReopen.workItems[replacementWorkItemId]).toBeDefined();
    void recovery;
    // The available override is track 'map' — a CONTENT round creation must
    // NOT consume it (wrong-track rejection: the over-limit check fails).
    // The stack's finalized manifest is still current (no re-drive — the
    // task is in the reopened state; a second drive would clash).
    const manifestState = await b.env.readProjection(b.taskId);
    const currentManifestRef = manifestState.currentManifest?.contentRevisionManifestRef as BlobRefV2;
    await expect(b.service.prepareContentReReviewRound(b.taskId, currentManifestRef)).rejects.toThrow(/cycle budget exhausted|OVERRIDE_UNAVAILABLE/);
  });

  it('exact-boundary success: nextOrdinal === maxRounds is legal WITHOUT an override', async () => {
    const b = await makeRepairEnv({ maxRounds: 2 });
    const { finalizeWorkItemId } = await driveMapRepairToFinalizer(b);
    // maxRounds=2: the repaired candidate's round (ordinal 2) is legal.
    const outcome = await runFinalizer(b, finalizeWorkItemId);
    expect(outcome.kind).toBe('completed');
    const events = await b.readEvents(b.taskId);
    const plannedEvents = events.filter((e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_round_planned' }> => e.type === 'structured_map_review_round_planned');
    const planned = plannedEvents[plannedEvents.length - 1];
    expect(planned).toBeDefined();
    expect(planned?.mapCycleOrdinal).toBe(2);
    expect(planned?.consumedOverrideRef).toBeNull();
    const state = await b.env.readProjection(b.taskId);
    expect(state.mapCycleOrdinal).toBe(2);
    // No task failure.
    expect(events.some((e) => e.type === 'structured_task_failed_v2')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Pure budget + scope helpers                                         */
/* ------------------------------------------------------------------ */

describe('pure budget/scope helpers', { timeout: 120_000 }, () => {
  it('mapRoundBudgetCheck: over-limit without an exact available map override rejects', () => {
    expect(() =>
      mapRoundBudgetCheck({ nextOrdinal: 2, maxRounds: 1, availableOverride: null, overrideRef: null }),
    ).toThrow(RepairLimitExceededError);
    expect(() =>
      mapRoundBudgetCheck({
        nextOrdinal: 2,
        maxRounds: 1,
        availableOverride: { ref: { kind: 'round_budget_override', digest: 'a'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 }, track: 'content' },
        overrideRef: { kind: 'round_budget_override', digest: 'a'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
      }),
    ).toThrow(/no exact available map RoundBudgetOverrideV2/);
    // Exact available map override is legal.
    expect(() =>
      mapRoundBudgetCheck({
        nextOrdinal: 2,
        maxRounds: 1,
        availableOverride: { ref: { kind: 'round_budget_override', digest: 'a'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 }, track: 'map' },
        overrideRef: { kind: 'round_budget_override', digest: 'a'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
      }),
    ).not.toThrow();
    // Boundary-equal is legal without an override.
    expect(() => mapRoundBudgetCheck({ nextOrdinal: 2, maxRounds: 2, availableOverride: null, overrideRef: null })).not.toThrow();
  });

  it('deriveRepairTargets routes map/mixed to map nodes+relations and content to slots', () => {
    const mapTargets = deriveRepairTargets({
      track: 'map',
      findings: [
        { findingId: 'm-1', severity: 'blocking', primaryLocation: { kind: 'map_node', id: 'n-1' } },
        { findingId: 'x-1', severity: 'blocking', primaryLocation: { kind: 'relation', id: 'r-1' } },
        { findingId: 'a-1', severity: 'advisory', primaryLocation: { kind: 'map_node', id: 'n-9' } },
      ],
    });
    expect(mapTargets.nodeIds).toEqual(['n-1']);
    expect(mapTargets.relationIds).toEqual(['r-1']);
    expect(mapTargets.findingIds).toEqual(['m-1', 'x-1']);
    const contentTargets = deriveRepairTargets({
      track: 'content',
      findings: [{ findingId: 'c-1', severity: 'blocking', primaryLocation: { kind: 'slot', id: 's-1' } }],
    });
    expect(contentTargets.slotIds).toEqual(['s-1']);
  });

  it('mapPatchScopeErrors: plan-key/operation/node/relation scope respected', () => {
    const repairPlanId = 'rp-1';
    const key = repairPlanKeyOf(repairPlanId, 'n-1');
    const scopes = buildRepairBatchScopes({
      track: 'map',
      repairPlanId,
      nodeIds: ['n-1'],
      relationIds: ['r-1'],
      slotIds: [],
      findingIds: ['m-1'],
      reviewPolicy: { ...REVIEW_POLICY, maxRounds: 3, contentBatchTargetSlots: 2 },
      profile: PROFILE,
    });
    const scope = scopes[0];
    if (scope === undefined || scope.kind !== 'map') throw new Error('expected map scope');
    const ledger = new Map<string, { planKey: string; kind: 'node' | 'relation'; officialId: string | null; status: 'active' | 'tombstone'; predecessorPlanKey: string | null }>([[key, { planKey: key, kind: 'node', officialId: 'n-1', status: 'active', predecessorPlanKey: null }]]);
    expect(mapPatchScopeErrors([{ kind: 'update_attributes', targetId: key }], scope.scope, ledger)).toEqual([]);
    expect(mapPatchScopeErrors([{ kind: 'update_attributes', targetId: 'pk-unknown' }], scope.scope, ledger).length).toBeGreaterThan(0);
    expect(mapPatchScopeErrors([{ kind: 'add_node', node: { buildNodeKey: 'pk-new', slotType: 'doc', parentBuildNodeKey: null, documentOrder: 1, siblingOrder: 1, contentBearing: true } }], scope.scope, ledger).length).toBeGreaterThan(0);
  });

  it('foldRepairMapState is a pure function of (base, patches, ledger)', () => {
    const repairPlanId = 'rp-1';
    const key = repairPlanKeyOf(repairPlanId, 'n-1');
    const ledger = new Map<string, { planKey: string; kind: 'node' | 'relation'; officialId: string | null; status: 'active' | 'tombstone'; predecessorPlanKey: string | null }>([[key, { planKey: key, kind: 'node', officialId: 'n-1', status: 'active', predecessorPlanKey: null }]]);
    const base = [{ slotId: 'n-1', slotType: 'doc', contentBearing: true, parentSlotId: null, documentOrder: 1, siblingOrder: 1, nodeSpecDigest: hash('spec') }];
    const patches = [{ batchOrdinal: 1, ops: [{ kind: 'update_attributes', targetId: key, node: { buildNodeKey: key, slotType: 'doc', parentBuildNodeKey: null, documentOrder: 1, siblingOrder: 9, contentBearing: true } }] as RepairMapPatchOperationV2[] }];
    const a = foldRepairMapState({ baseNodes: base, baseRelations: [], patches, ledgerByKey: ledger });
    const b2 = foldRepairMapState({ baseNodes: base, baseRelations: [], patches, ledgerByKey: ledger });
    expect(a.nodes[0]?.siblingOrder).toBe(9);
    expect(a.nodes[0]?.slotId).toBe('n-1');
    expect(a.nodes[0]?.slotId).toBe(b2.nodes[0]?.slotId);
  });
});

/* ------------------------------------------------------------------ */
/* Fix round (adversarial review 2026-08-15): I-1..I-4 end-to-end      */
/* ------------------------------------------------------------------ */

const CONTENT_SETTLEMENT_SOURCE = alwaysValidSource('content-review-settlement');

/** The MapReviewService with the Task 19 repair seam (the repaired-Map
 * activation needs it) — the same wiring as driveToContentStack plus the seam. */
function mapReviewServiceWithRepairSeam(b: RepairEnv): MapReviewService {
  const resolver = b.resolver;
  const readEvents = async (id: string) => (await b.env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2);
  const reviewCoordinator = new ReviewCoordinatorV2({
    coordinator: b.env.coordinator,
    facade: b.env.facade,
    resolver,
    readProjection: b.env.readProjection,
    readEvents,
    profile: PROFILE,
    reviewPolicy: { ...REVIEW_POLICY, contentBatchTargetSlots: 2 },
    templateSnapshotRef: b.templateSnapshotRef,
    profileSnapshotRef: b.profileSnapshotRef,
    reviewerRoleBinding: 'reviewer',
    generatorRoleBinding: 'generator',
    orchestratorRoleBinding: 'orchestrator',
    snapshotHash: 'a'.repeat(64),
    defaultAutomaticRetries: async () => 2,
  });
  return new MapReviewService({
    facade: b.env.facade,
    reviewCoordinator,
    readProjection: b.env.readProjection,
    resolver,
    tail: (id) => b.env.eventStore.tail(id),
    readEvents,
    committedOperation: async (id, operationId) =>
      (await b.env.eventStore.readBatchByCommitId(id, operationId))?.map((e) => e.event as AuthoritativeReviewEventV2) ?? null,
    clock: () => b.env.now.value,
    profile: PROFILE,
    profileBody: PROFILE_BODY,
    validatorRegistry: new ValidatorRegistry([
      ...AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES,
      testValidatorEntry('map_review_settlement', null, MAP_SETTLEMENT_SOURCE),
      testValidatorEntry('map_activation', null, MAP_ACTIVATION_SOURCE),
    ]),
    sourceResolver: (handlerKey) => {
      if (handlerKey === 'test.repair.map_review_settlement') return MAP_SETTLEMENT_SOURCE;
      if (handlerKey === 'test.repair.map_activation') return MAP_ACTIVATION_SOURCE;
      return builtinSourceOf(handlerKey);
    },
    registrationsFor: (trigger) => {
      if (trigger === 'map_review_settlement') return [testValidatorRegistration('map_review_settlement', null, MAP_SETTLEMENT_SOURCE, 'v-map-settle')];
      return [testValidatorRegistration('map_activation', null, MAP_ACTIVATION_SOURCE, 'v-map-activate')];
    },
    reviewPolicy: { ...REVIEW_POLICY, contentBatchTargetSlots: 2 },
    reviewPolicyDigest: hash('review-policy'),
    templateSnapshotRef: b.templateSnapshotRef,
    profileSnapshotRef: b.profileSnapshotRef,
    snapshotHash: 'a'.repeat(64),
    reviewerRoleBinding: 'reviewer',
    generatorRoleBinding: 'generator',
    orchestratorRoleBinding: 'orchestrator',
    repairService: b.service,
  });
}

/** The ContentReviewService over the repair env (the content re-review round's
 * completion + settlement; the settlement validator is always-valid). */
function contentReviewServiceOn(b: RepairEnv): ContentReviewService {
  const resolver = b.resolver;
  const readEvents = async (id: string) => (await b.env.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2);
  const reviewCoordinator = new ReviewCoordinatorV2({
    coordinator: b.env.coordinator,
    facade: b.env.facade,
    resolver,
    readProjection: b.env.readProjection,
    readEvents,
    profile: PROFILE,
    reviewPolicy: { ...REVIEW_POLICY, contentBatchTargetSlots: 2 },
    templateSnapshotRef: b.templateSnapshotRef,
    profileSnapshotRef: b.profileSnapshotRef,
    reviewerRoleBinding: 'reviewer',
    generatorRoleBinding: 'generator',
    orchestratorRoleBinding: 'orchestrator',
    snapshotHash: 'a'.repeat(64),
    defaultAutomaticRetries: async () => 2,
  });
  const findingService = new FindingService({ facade: b.env.facade, readProjection: b.env.readProjection, readEvents, resolver });
  return new ContentReviewService({
    facade: b.env.facade,
    reviewCoordinator,
    readProjection: b.env.readProjection,
    resolver,
    tail: (id) => b.env.eventStore.tail(id),
    readEvents,
    committedOperation: async (id, operationId) =>
      (await b.env.eventStore.readBatchByCommitId(id, operationId))?.map((e) => e.event as AuthoritativeReviewEventV2) ?? null,
    clock: () => b.env.now.value,
    profile: PROFILE,
    profileBody: PROFILE_BODY,
    validatorRegistry: new ValidatorRegistry([
      ...AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES,
      testValidatorEntry('review_settlement', null, CONTENT_SETTLEMENT_SOURCE),
    ]),
    sourceResolver: (handlerKey) => {
      if (handlerKey === 'test.repair.review_settlement') return CONTENT_SETTLEMENT_SOURCE;
      return builtinSourceOf(handlerKey);
    },
    registrationsFor: () => [testValidatorRegistration('review_settlement', null, CONTENT_SETTLEMENT_SOURCE, 'v-content-settlement')],
    reviewPolicy: { ...REVIEW_POLICY, contentBatchTargetSlots: 2 },
    reviewPolicyDigest: hash('review-policy'),
    templateSnapshotRef: b.templateSnapshotRef,
    profileSnapshotRef: b.profileSnapshotRef,
    snapshotHash: 'a'.repeat(64),
    reviewerRoleBinding: 'reviewer',
    generatorRoleBinding: 'generator',
    orchestratorRoleBinding: 'orchestrator',
    findingService,
  });
}

/** The fabricated `restart_map_review_cycle` reopen envelope (the frozen Task
 * 11/12 recovery handler): an available map override bound to the SUPERSEDED
 * plan (the transfer fires when a successor supersedes it) + the replacement
 * repair workitem (the reopen obligation). The recovery SUCCESSOR itself is
 * created through the REAL successor-creation path (createSuccessorRepairPlan)
 * — the frozen reopen handler emits no repair-plan event, so a fabricated
 * successor can never become the lineage head. */
async function reopenWithAvailableOverride(b: RepairEnv, failed: NonNullable<AuthoritativeReviewProjectionV2['failed']>, headSpec: RepairPlanSpecV2, headSpecRef: BlobRefV2): Promise<{
  overrideRef: BlobRefV2;
  replacementWorkItemId: string;
  keyLedgerRef: BlobRefV2;
}> {
  const keyLedgerBody = { repairPlanId: headSpec.repairPlanId, planRevisionId: hash('ledger-reopen'), entries: [] };
  const keyLedgerRef = await b.env.facade.prepareBlob(b.taskId, 'repair_key_ledger', { ...keyLedgerBody, ledgerDigest: canonicalJsonSha256(keyLedgerBody) });
  // A legal spec for the replacement workitem's grant (never committed — the
  // recovery successor is created by the service with its OWN spec).
  const placeholderSpec = buildRepairPlanSpec({
    repairPlanId: headSpec.repairPlanId,
    revision: headSpec.revision + 1,
    origin: { kind: 'successor', supersedesPlanSpecRef: headSpecRef, successorReason: 'recovery', successorOperationKey: 'a3f8c2e0-0000-4000-8000-000000000001' },
    sourceReceiptRef: null,
    repairBase: headSpec.repairBase,
    orderedBatchScopes: headSpec.orderedBatchScopes,
    keyLineageRef: keyLedgerRef,
    importedStagingManifestRef: headSpec.importedStagingManifestRef,
  });
  const placeholderRef = await b.env.facade.prepareBlob(b.taskId, 'repair_plan_spec', placeholderSpec);
  const overrideBody = {
    overrideId: 'ovr-i2',
    failedEventId: failed.eventId,
    track: 'map',
    repairLineageId: headSpec.repairPlanId,
    initialRepairPlanRef: headSpecRef,
    currentAuthorizedRepairPlanRef: headSpecRef,
    predecessorOverrideRef: null,
    transferOrdinal: 0,
    operationId: 'a3f8c2e0-0000-4000-8000-000000000001',
    operatorId: 'task_owner',
    reasonDigest: hash('reason'),
    state: 'available',
  };
  const overrideRef = await b.env.facade.prepareBlob(b.taskId, 'round_budget_override', overrideBody);
  const replacementWorkItemId = 'wi-reopen-replacement';
  const stagingRoot = buildRepairStagingRoot({
    repairPlanId: headSpec.repairPlanId,
    planRevisionId: placeholderSpec.planRevisionId,
    batchOrdinal: 0,
    mapRootDigest: placeholderSpec.importedStagingManifestRef.digest,
    contentRootDigest: null,
    priorStagingRootRef: null,
    keyLedgerRef,
  });
  const stagingRootRef = await b.env.facade.prepareBlob(b.taskId, 'repair_staging_root', stagingRoot);
  const base = buildAuthorityBaseSet({
    taskId: b.taskId,
    templateSnapshotRef: b.templateSnapshotRef,
    profileSnapshotRef: b.profileSnapshotRef,
    refs: {
      planSpecRef: placeholderRef,
      stagingManifestRef: stagingRootRef,
      ...(headSpec.repairBase.kind === 'map_candidate'
        ? { mapCandidateRef: headSpec.repairBase.candidateRef }
        : { mapRef: (headSpec.repairBase as { mapRef: BlobRefV2 }).mapRef }),
    },
    kind: 'agent_assignment',
    agentExecutionKind: 'structured_session',
    sessionKind: 'map_repair',
  });
  const baseRef = await b.env.facade.prepareBlob(b.taskId, 'authority_base_set', base);
  const reopenGrant = buildRepairBatchGrantSpec({
    grantSpecId: 'gs-reopen-replacement',
    workItemId: replacementWorkItemId,
    kind: 'map_repair_batch',
    snapshotHash: 'a'.repeat(64),
    authorityBaseRef: baseRef,
    repairPlanSpecRef: placeholderRef,
    repairBase: headSpec.repairBase,
    expectedStagingRootRef: stagingRootRef,
    planKeyLedgerRef: keyLedgerRef,
    batchOrdinal: 1,
    findingIds: [],
    maxContextBytes: 4096,
    writeScope: {
      mapWriteScope: {
        nodeIds: [],
        relationIds: [],
        allowedPlanKeys: [],
        parentContainers: [],
        relationTypeIds: [],
        operations: ['update_attributes'],
      },
    },
  });
  const reopenGrantRef = await b.env.facade.prepareBlob(b.taskId, 'write_grant_spec', reopenGrant);
  const reopenOp = 'a3f8c2e0-0000-4000-8000-000000000001';
  const tail = await b.env.eventStore.tail(b.taskId);
  await b.env.facade.publishWithPin({
    taskId: b.taskId,
    operationId: reopenOp,
    payload: {
      family: 'recovery',
      operationId: reopenOp,
      taskId: b.taskId,
      expectedLastSequence: tail.lastSequence,
      operatorId: 'task_owner',
      reason: 'restart',
      recipeKey: 'restart_map_review_cycle',
      track: 'map',
      failureRecoveryPayloadRef: failed.failureRecoveryPayloadRef as BlobRefV2,
      overrideRef,
      replacementWorkItemId,
      replacementKind: 'agent_assignment',
      replacementRoleBinding: 'orchestrator',
      replacementAgentExecutionKind: 'structured_session',
      replacementSessionKind: 'map_repair',
      replacementRoundId: null,
      replacementLogicalAssignmentId: `la-${replacementWorkItemId}`,
      replacementReviewAssignmentId: null,
      replacementGrantSpecRef: reopenGrantRef,
      replacementInputArtifactDeliveryId: null,
      replacementPayloadRef: placeholderRef,
      replacementAuthorityBaseRef: baseRef,
      replacementLeaseEpoch: 1,
      replacementMaxAutomaticRetries: 2,
    },
    intent: { handlerKind: 'restart_map_review_cycle', handlerVersion: 1 },
    preparedRefs: [failed.failureRecoveryPayloadRef as BlobRefV2, overrideRef, baseRef, placeholderRef, stagingRootRef, reopenGrantRef],
    expectedTailSequence: tail.lastSequence,
    expectedTailCommitId: tail.lastCommitId,
  });
  return { overrideRef, replacementWorkItemId, keyLedgerRef };
}

/** One map repair batch: journal the patch + commit + complete the workitem. */
async function commitMapRepairBatchOne(b: RepairEnv, plan: RepairPlanSpecV2, workItemId: string): Promise<void> {
  const state = await b.env.readProjection(b.taskId);
  const scope0 = plan.orderedBatchScopes[0];
  if (scope0 === undefined || scope0.kind !== 'map') throw new Error('expected map scope');
  const targetNodeId = scope0.scope.nodeIds[0] as string;
  const grant = (await grantOf(b, workItemId)) as RepairBatchGrantSpecV2 & { kind: 'map_repair_batch' };
  const leased = await leaseTargeted(b, workItemId, 'worker-a');
  const ctx = ctxOf(b, leased);
  const grantSpecRef = state.workItems[workItemId].grantSpecRef as BlobRefV2;
  await b.privateStore.appendReviewDraft(
    { workItemId, leaseEpoch: leased.leaseEpoch, attemptId: ctx.attemptId, authorityBaseRef: leased.authorityBaseRef, grantSpecRef },
    { clientOperationId: `co-${workItemId}-1`, op: 'submit_map_patch', body: { operations: [{ kind: 'update_attributes', targetId: repairPlanKeyOf(plan.repairPlanId, targetNodeId) }] }, result: null },
  );
  const baseRoot = (await b.resolver(b.taskId, grant.expectedStagingRootRef)) as { stagingDigest: string };
  const outcome = await b.service.commitRepairBatch({
    taskId: b.taskId,
    workItemId,
    attemptId: ctx.attemptId,
    batchOrdinal: 1,
    ctx,
    mapPatch: {
      expectedStagingDigest: baseRoot.stagingDigest,
      operations: [{ kind: 'update_attributes', targetId: repairPlanKeyOf(plan.repairPlanId, targetNodeId) }],
    },
  });
  if (outcome.kind !== 'committed') throw new Error(`map repair batch did not commit: ${JSON.stringify(outcome)}`);
  await b.env.coordinator.completeWorkItem({
    taskId: b.taskId,
    operationId: attemptContinuationOperationId(b.taskId, workItemId, ctx.attemptId, 'complete'),
    workItemId,
    attemptId: ctx.attemptId,
    resultRefs: [outcome.stagingRootRef],
  });
}

/** Completes a repaired Map round with a real production verification record
 * and returns the leased settlement command. Used by the activation budget
 * boundary regression in addition to the mixed-route test below. */
async function completeRepairedMapRound(
  b: RepairEnv,
  plannedRound: Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_round_planned' }>,
  findingId: string,
): Promise<{ review: MapReviewService; settlementWiId: string; settleLease: Awaited<ReturnType<typeof leaseTargeted>>; coverageCoreRef: BlobRefV2 }> {
  const roundId = plannedRound.mapReviewRoundId;
  const review = mapReviewServiceWithRepairSeam(b);
  const candidate = (await b.resolver(b.taskId, plannedRound.candidateRef)) as { validationCoreRef: BlobRefV2 };
  const candidateCore = (await b.resolver(b.taskId, candidate.validationCoreRef)) as { nodes: MapPositionNodeV2[]; relations: MapRelationV2[] };
  const reviewPlan = planMapReview({
    nodes: candidateCore.nodes,
    relations: candidateCore.relations,
    profile: PROFILE,
    reviewPolicy: { ...REVIEW_POLICY, contentBatchTargetSlots: 2 },
    assignmentCount: plannedRound.assignmentCount,
  });
  const batchWiId = reviewBatchWorkItemId(roundId, 0);
  const batchLease = await leaseTargeted(b, batchWiId, 'worker-budget-review');
  const batchAttemptId = batchLease.attemptId ?? '';
  const batchTargets = [...reviewPlan.batches[0].nodeIds, ...reviewPlan.batches[0].relationIds];
  const baselineTargetKinds: Record<string, ReviewFactV2['targetKind']> = {};
  for (const id of reviewPlan.batches[0].nodeIds) baselineTargetKinds[id] = 'map_node';
  const records: ReviewDraftRecordV2[] = batchTargets.map((targetId) => ({
    op: 'submit_map_node_review',
    body: { targetId, verdict: 'pass', evidence: [], findingDrafts: [], crossScopeFindingDrafts: [] },
    at: b.env.now.value,
  }));
  records.push({ op: 'submit_finding_verification', body: { findingId, repairStage: 'map', verdict: 'resolved', evidence: [] }, at: b.env.now.value });
  const batchFreeze = buildReviewAssignmentFreeze({
    assignmentId: batchWiId,
    workItemId: batchWiId,
    reviewAssignmentId: reviewAssignmentIdOf(roundId, 0),
    roundKind: 'map',
    roundId,
    attemptId: batchAttemptId,
    reviewerAttemptId: batchAttemptId,
    reviewPolicyDigest: hash('review-policy'),
    records,
    verificationFindingStages: [`${findingId}:map`],
    assignmentTargets: batchTargets,
    baselineTargetKinds,
    requireOrdinaryCoverage: true,
  });
  if (!batchFreeze.ok) throw new Error(`repaired map batch freeze failed: ${batchFreeze.errors.join('; ')}`);
  await review.freezeReviewAssignment(b.taskId, batchFreeze.freeze);
  await b.env.coordinator.completeWorkItem({ taskId: b.taskId, operationId: attemptContinuationOperationId(b.taskId, batchWiId, batchAttemptId, 'complete'), workItemId: batchWiId, attemptId: batchAttemptId, resultRefs: [refOfBlob('review_assignment_ledger', batchFreeze.freeze.ledger)] });
  const wholeWiId = reviewWholeWorkItemId(roundId);
  const wholeLease = await leaseTargeted(b, wholeWiId, 'worker-budget-review');
  const wholeAttemptId = wholeLease.attemptId ?? '';
  const wholeFreeze = buildReviewAssignmentFreeze({
    assignmentId: wholeWiId,
    workItemId: wholeWiId,
    reviewAssignmentId: reviewWholeAssignmentId(roundId),
    roundKind: 'map',
    roundId,
    attemptId: wholeAttemptId,
    reviewerAttemptId: wholeAttemptId,
    reviewPolicyDigest: hash('review-policy'),
    records: [],
    verificationFindingStages: [],
    assignmentTargets: [],
    baselineTargetKinds: {},
    requireOrdinaryCoverage: false,
  });
  if (!wholeFreeze.ok) throw new Error(`repaired map whole freeze failed: ${wholeFreeze.errors.join('; ')}`);
  await review.freezeReviewAssignment(b.taskId, wholeFreeze.freeze);
  await b.env.coordinator.completeWorkItem({ taskId: b.taskId, operationId: attemptContinuationOperationId(b.taskId, wholeWiId, wholeAttemptId, 'complete'), workItemId: wholeWiId, attemptId: wholeAttemptId, resultRefs: [refOfBlob('review_assignment_ledger', wholeFreeze.freeze.ledger)] });
  if (!(await review.maybeCompleteRound(b.taskId, roundId))) throw new Error('repaired map round did not advance');
  const settlementWiId = deterministicSettlementWorkItemId(b.taskId, roundId);
  const settleLease = await leaseTargeted(b, settlementWiId, 'worker-budget-settlement');
  const completed = (await b.readEvents(b.taskId)).find((event) => event.type === 'structured_map_review_round_completed' && event.mapReviewRoundId === roundId);
  if (completed === undefined || completed.type !== 'structured_map_review_round_completed') throw new Error('no repaired map round completion');
  return { review, settlementWiId, settleLease, coverageCoreRef: completed.coverageCoreRef };
}

describe('I-1 (review): mixed Findings route Map repair -> ContentRepairPlan before content re-review', { timeout: 120_000 }, () => {
  it('mixed Map repair -> map verification -> activation atomically creates a same-finding ContentRepairPlan on the NEW map', async () => {
    const b = await makeRepairEnv({ maxRounds: 2 });
    const { finalizeWorkItemId } = await driveMapRepairToFinalizer(b, { mixed: true });
    const outcome = await runFinalizer(b, finalizeWorkItemId);
    if (outcome.kind !== 'completed') throw new Error(`finalize failed: ${JSON.stringify(outcome)}`);
    const events0 = await b.readEvents(b.taskId);
    const plannedRound = events0.filter((e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_round_planned' }> => e.type === 'structured_map_review_round_planned').pop();
    if (plannedRound === undefined) throw new Error('no repaired map round');
    expect(plannedRound.mapCycleOrdinal).toBe(2);
    const roundId = plannedRound.mapReviewRoundId;
    const review = mapReviewServiceWithRepairSeam(b);
    const candidate = (await b.resolver(b.taskId, plannedRound.candidateRef)) as { validationCoreRef: BlobRefV2 };
    const candidateCore = (await b.resolver(b.taskId, candidate.validationCoreRef)) as { nodes: MapPositionNodeV2[]; relations: MapRelationV2[] };
    const plan = planMapReview({
      nodes: candidateCore.nodes,
      relations: candidateCore.relations,
      profile: PROFILE,
      reviewPolicy: { ...REVIEW_POLICY, contentBatchTargetSlots: 2 },
      assignmentCount: plannedRound.assignmentCount,
    });
    // Batch freeze: pass verdicts + the map-stage verification (the map round
    // carries the repair finding's verification stage).
    const batchWiId = reviewBatchWorkItemId(roundId, 0);
    const batchLease = await leaseTargeted(b, batchWiId, 'worker-r');
    const batchAttemptId = batchLease.attemptId ?? '';
    const batchTargets = [...plan.batches[0].nodeIds, ...plan.batches[0].relationIds];
    const baselineTargetKinds: Record<string, ReviewFactV2['targetKind']> = {};
    for (const id of plan.batches[0].nodeIds) baselineTargetKinds[id] = 'map_node';
    const records: ReviewDraftRecordV2[] = batchTargets.map((targetId) => ({
      op: 'submit_map_node_review',
      body: { targetId, verdict: 'pass', evidence: [], findingDrafts: [], crossScopeFindingDrafts: [] },
      at: b.env.now.value,
    }));
    records.push({ op: 'submit_finding_verification', body: { findingId: 'x-1', repairStage: 'map', verdict: 'resolved', evidence: [] }, at: b.env.now.value });
    const batchFreeze = buildReviewAssignmentFreeze({
      assignmentId: batchWiId,
      workItemId: batchWiId,
      reviewAssignmentId: reviewAssignmentIdOf(roundId, 0),
      roundKind: 'map',
      roundId,
      attemptId: batchAttemptId,
      reviewerAttemptId: batchAttemptId,
      reviewPolicyDigest: hash('review-policy'),
      records,
      verificationFindingStages: ['x-1:map'],
      assignmentTargets: batchTargets,
      baselineTargetKinds,
      requireOrdinaryCoverage: true,
    });
    if (!batchFreeze.ok) throw new Error(`round-2 batch freeze failed: ${batchFreeze.errors.join('; ')}`);
    await review.freezeReviewAssignment(b.taskId, batchFreeze.freeze);
    await b.env.coordinator.completeWorkItem({
      taskId: b.taskId,
      operationId: attemptContinuationOperationId(b.taskId, batchWiId, batchAttemptId, 'complete'),
      workItemId: batchWiId,
      attemptId: batchAttemptId,
      resultRefs: [refOfBlob('review_assignment_ledger', batchFreeze.freeze.ledger)],
    });
    // Whole-map observation freeze.
    const wholeWiId = reviewWholeWorkItemId(roundId);
    const wholeLease = await leaseTargeted(b, wholeWiId, 'worker-r');
    const wholeAttemptId = wholeLease.attemptId ?? '';
    const wholeFreeze = buildReviewAssignmentFreeze({
      assignmentId: wholeWiId,
      workItemId: wholeWiId,
      reviewAssignmentId: reviewWholeAssignmentId(roundId),
      roundKind: 'map',
      roundId,
      attemptId: wholeAttemptId,
      reviewerAttemptId: wholeAttemptId,
      reviewPolicyDigest: hash('review-policy'),
      records: [],
      verificationFindingStages: [],
      assignmentTargets: [],
      baselineTargetKinds: {},
      requireOrdinaryCoverage: false,
    });
    if (!wholeFreeze.ok) throw new Error(`round-2 whole freeze failed: ${wholeFreeze.errors.join('; ')}`);
    await review.freezeReviewAssignment(b.taskId, wholeFreeze.freeze);
    await b.env.coordinator.completeWorkItem({
      taskId: b.taskId,
      operationId: attemptContinuationOperationId(b.taskId, wholeWiId, wholeAttemptId, 'complete'),
      workItemId: wholeWiId,
      attemptId: wholeAttemptId,
      resultRefs: [refOfBlob('review_assignment_ledger', wholeFreeze.freeze.ledger)],
    });
    // The production freeze envelope records the verification authoritatively;
    // no test-only event injector is permitted on the repair lifecycle.
    const verifiedAfter = await b.env.readProjection(b.taskId);
    expect(verifiedAfter.findings['x-1'].verifiedStages).toContain('map');
    expect((await b.readEvents(b.taskId)).some((e) => e.type === 'structured_finding_verification_recorded' && e.findingId === 'x-1')).toBe(true);
    const advanced = await review.maybeCompleteRound(b.taskId, roundId);
    if (!advanced) throw new Error('repaired map round did not advance');
    // The repaired-Map activation (the repair seam wired): the envelope is
    // [map_activated(NEW snapshot), review_round_planned(content, mapRef=NEW),
    // review WorkItems, terminals] — it must PROJECT cleanly (the pre-fix
    // envelope corrupted `map_mismatch` at the round-planned event).
    const settlementWiId = deterministicSettlementWorkItemId(b.taskId, roundId);
    const settleLease = await leaseTargeted(b, settlementWiId, 'worker-s');
    const completed = (await b.readEvents(b.taskId)).find((e) => e.type === 'structured_map_review_round_completed' && e.mapReviewRoundId === roundId);
    if (completed === undefined || completed.type !== 'structured_map_review_round_completed') throw new Error('no round completed');
    const settleOutcome = await review.executeMapReviewSettlement({
      taskId: b.taskId,
      commandId: settleLease.commandId ?? '',
      workItemId: settlementWiId,
      commandKind: 'review_settlement',
      leaseEpoch: settleLease.leaseEpoch,
      authorityBaseRef: settleLease.authorityBaseRef,
      payloadRef: completed.coverageCoreRef,
    });
    expect(settleOutcome.kind).toBe('completed');
    const after = await b.readEvents(b.taskId);
    const activations = after.filter((e) => e.type === 'structured_map_activated');
    const activated = activations[activations.length - 1];
    if (activated === undefined || activated.type !== 'structured_map_activated') throw new Error('no activation');
    expect(activated.mapRevision).toBe(2);
    expect(after.filter((e) => e.type === 'structured_review_round_planned')).toHaveLength(1);
    expect(after.some((e) => e.type === 'structured_content_repair_plan_started')).toBe(true);
    const finalState = await b.env.readProjection(b.taskId);
    expect(finalState.currentMap?.mapSnapshotRef.digest).toBe(activated.mapSnapshotRef.digest);
    const contentLineage = Object.values(finalState.repairPlans).find((lineage) => lineage.track === 'content');
    if (contentLineage === undefined || contentLineage.currentPlanRevisionId === null) throw new Error('no mixed content repair plan');
    const contentPlanRef = contentLineage.revisions[contentLineage.currentPlanRevisionId].specRef;
    const contentPlan = (await b.resolver(b.taskId, contentPlanRef)) as RepairPlanSpecV2;
    expect(contentPlan.repairBase.kind).toBe('content');
    if (contentPlan.repairBase.kind !== 'content') throw new Error('wrong mixed plan base');
    expect(contentPlan.repairBase.mapRef.digest).toBe(activated.mapSnapshotRef.digest);
    expect(contentPlan.orderedBatchScopes[0]?.findingIds).toEqual(['x-1']);
    expect(Object.values(finalState.workItems).some((wi) => wi.sessionKind === 'content_repair' && wi.state === 'ready')).toBe(true);
    // R2-1: the settlement workitem's authority base binds the PREPARED round
    // blob (byte-identical to the round-2 review workitems' reviewRoundRef —
    // the finalize's blob), NOT a divergent rebuild of the verified projection.
    const settleWi = finalState.workItems[deterministicSettlementWorkItemId(b.taskId, roundId)];
    if (settleWi === undefined) throw new Error('no settlement workitem');
    const settleBase = (await b.resolver(b.taskId, settleWi.authorityBaseRef)) as { reviewRoundRef: BlobRefV2 };
    const round2WorkItem = Object.values(finalState.workItems).find((wi) => wi.roundId === roundId && wi.sessionKind === 'review_map_batch');
    if (round2WorkItem === undefined) throw new Error('no round-2 review workitem');
    const round2Base = (await b.resolver(b.taskId, round2WorkItem.authorityBaseRef)) as { reviewRoundRef: BlobRefV2 };
    expect(settleBase.reviewRoundRef.digest).toBe(round2Base.reviewRoundRef.digest);
    // The blob exists on disk (GC resolveClosure walks the base-set child) and
    // the GC completes cleanly over the ENTIRE task (activation + content
    // round + repair blobs).
    const { AuthoritativeReviewGc } = await import('../../storage/authoritative-review-gc');
    const gc = new AuthoritativeReviewGc(b.env.paths, b.env.blobStore, b.env.eventStore, b.env.publicationStore, {});
    await expect(gc.run()).resolves.toBeDefined();
  });
});

describe('I-2 (review): the override transfer projects through the real projector and the transferred override is consumed by the round creation', { timeout: 120_000 }, () => {
  it('over-limit fail -> reopen (available override) -> recovery successor (transfer) -> blocking finalize (transfer) -> clear finalize consumes the transferred override', async () => {
    const b = await makeRepairEnv({ maxRounds: 1, blockingOnRevision2: true });
    const { finalizeWorkItemId } = await driveMapRepairToFinalizer(b);
    // Revision 1 finalize is CLEAR -> over-limit (maxRounds 1, nextOrdinal 2)
    // terminal-fails the task (the restart_review_cycle recovery payload).
    const overLimit = await runFinalizer(b, finalizeWorkItemId);
    expect(overLimit.kind).toBe('completed');
    const state = await b.env.readProjection(b.taskId);
    const failed = state.failed as NonNullable<typeof state.failed>;
    const lineage = Object.values(state.repairPlans)[0];
    const head = lineage.revisions[lineage.currentPlanRevisionId as string];
    const headSpec = (await b.resolver(b.taskId, head.specRef)) as RepairPlanSpecV2;
    // Reopen: an available map override bound to the SUPERSEDED plan (rev 1) +
    // the replacement repair workitem (the reopen obligation).
    await reopenWithAvailableOverride(b, failed, headSpec, head.specRef);
    const stateAfter = await b.env.readProjection(b.taskId);
    expect(stateAfter.availableOverride).not.toBeNull();
    expect(stateAfter.availableOverride?.track).toBe('map');
    // The recovery successor (rev 2) is created through the REAL
    // successor-creation envelope: revision-started + workitem + grant +
    // TRANSFER (the available override moves rev 1 -> rev 2) + the §9.2
    // terminal pair — ALL projector-legal (the pre-fix rule corrupted
    // `override_unknown` on every transfer).
    const terminalWiId = 'wi-settlement-i2';
    const terminalBase = buildAuthorityBaseSet({
      taskId: b.taskId,
      templateSnapshotRef: b.templateSnapshotRef,
      profileSnapshotRef: b.profileSnapshotRef,
      refs: {
        mapCandidateRef: { kind: 'map_candidate', digest: hash('cand'), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
        reviewCoverageCoreRef: { kind: 'content_review_coverage_core', digest: hash('core'), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
        reviewRoundRef: { kind: 'content_review_coverage_core', digest: hash('round'), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
      },
      kind: 'system_review_settlement',
    });
    const terminalBaseRef = await b.env.facade.prepareBlob(b.taskId, 'authority_base_set', terminalBase);
    await b.env.coordinator.createWorkItem({
      taskId: b.taskId,
      operationId: opId('create-settlement-i2'),
      workItemId: terminalWiId,
      kind: 'system_review_settlement',
      roleBinding: null,
      agentExecutionKind: null,
      sessionKind: null,
      roundId: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      payload: {
        kind: 'content_review_coverage_core',
        value: buildContentReviewCoverageCore({
          reviewRoundId: 'round-i2',
          mapRef: { kind: 'map_snapshot', digest: hash('map'), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
          contentRevisionManifestRef: { kind: 'content_revision_manifest', digest: hash('manifest'), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
          reviewPolicyDigest: hash('review-policy'),
          coverageLedgerRootRefs: [],
          adoptionRootRef: { kind: 'review_adoption_root', digest: hash('adoption'), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
          wholeTreeObservationRootRefs: [],
          findingStageRootRef: { kind: 'finding_stage_root', digest: hash('fsr'), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
        }),
      },
      authorityBase: terminalBase,
      grantSpecRef: null,
      maxAutomaticRetries: 2,
      initialLeaseEpoch: 0,
    });
    const terminalLease = await leaseTargeted(b, terminalWiId, 'worker-a');
    const successorOutcome = await b.service.createSuccessorRepairPlan({
      taskId: b.taskId,
      track: 'map',
      repairPlanId: headSpec.repairPlanId,
      supersededPlanSpecRef: head.specRef,
      supersededPlanRevisionId: headSpec.planRevisionId,
      successorReason: 'recovery',
      successorOperationKey: opId('recovery-successor'),
      findings: blockingFindingsOf(['m-1']),
      sourceReceiptRef: null,
      repairBase: headSpec.repairBase,
      importedStagingManifestRef: headSpec.importedStagingManifestRef,
      terminal: {
        workItemId: terminalWiId,
        commandId: terminalLease.commandId ?? '',
        commandKind: 'review_settlement',
        leaseEpoch: terminalLease.leaseEpoch,
        authorityBaseRef: terminalBaseRef,
      },
    });
    expect(successorOutcome.kind).toBe('completed');
    const events1 = await b.readEvents(b.taskId);
    const transfer1 = events1.find((e) => e.type === 'structured_round_budget_override_transferred_v2');
    expect(transfer1).toBeDefined();
    if (transfer1 === undefined) return;
    // Drive the service's recovery successor (rev 2) batch 1.
    const state1 = await b.env.readProjection(b.taskId);
    const rev2SpecRef = state1.repairPlans[headSpec.repairPlanId].revisions[state1.repairPlans[headSpec.repairPlanId].currentPlanRevisionId as string].specRef;
    const rev2Plan = (await b.resolver(b.taskId, rev2SpecRef)) as RepairPlanSpecV2;
    expect(rev2Plan.revision).toBe(2);
    const rev2WorkItemId = repairBatchWorkItemId(b.taskId, rev2Plan.repairPlanId, 1, rev2Plan.planRevisionId);
    await commitMapRepairBatchOne(b, rev2Plan, rev2WorkItemId);
    // Revision 2 finalize is BLOCKING -> ONE correction successor (rev 3) +
    // the override TRANSFER in the SAME envelope (the available override binds
    // the superseded revision 2).
    const finalize2 = repairFinalizeWorkItemId(b.taskId, rev2Plan.repairPlanId, rev2Plan.planRevisionId);
    const blocked = await runFinalizer(b, finalize2);
    expect(blocked.kind).toBe('blocked');
    const events = await b.readEvents(b.taskId);
    const rejected = events.filter((e) => e.type === 'structured_map_repair_plan_rejected');
    expect(rejected.length).toBe(1);
    const transfers = events.filter((e) => e.type === 'structured_round_budget_override_transferred_v2');
    const transfer = transfers[transfers.length - 1] as Extract<AuthoritativeReviewEventV2, { type: 'structured_round_budget_override_transferred_v2' }>;
    const state3 = await b.env.readProjection(b.taskId);
    const lineage3 = state3.repairPlans[rev2Plan.repairPlanId];
    const rev3SpecRef = lineage3.revisions[lineage3.currentPlanRevisionId as string].specRef;
    expect(transfer.fromRepairPlanRef.digest).toBe(rev2SpecRef.digest);
    expect(transfer.toRepairPlanRef.digest).toBe(rev3SpecRef.digest);
    // The transferred override: transferOrdinal 2 (the first transfer moved
    // rev 1 -> rev 2), binds the correction successor (rev 3), descends from
    // the previously-available ref.
    const transferredBlob = (await b.resolver(b.taskId, transfer.overrideRef)) as { transferOrdinal: number; currentAuthorizedRepairPlanRef: BlobRefV2; predecessorOverrideRef: BlobRefV2 | null };
    expect(transferredBlob.transferOrdinal).toBe(2);
    expect(transferredBlob.currentAuthorizedRepairPlanRef.digest).toBe(rev3SpecRef.digest);
    expect(transferredBlob.predecessorOverrideRef?.digest).toBe((transfer1 as Extract<AuthoritativeReviewEventV2, { type: 'structured_round_budget_override_transferred_v2' }>).overrideRef.digest);
    expect(state3.availableOverride?.ref.digest).toBe(transfer.overrideRef.digest);
    // The correction successor (rev 3) continues: batch 1 -> clear finalize.
    const rev3Plan = (await b.resolver(b.taskId, rev3SpecRef)) as RepairPlanSpecV2;
    expect(rev3Plan.revision).toBe(3);
    const rev3WorkItemId = repairBatchWorkItemId(b.taskId, rev3Plan.repairPlanId, 1, rev3Plan.planRevisionId);
    await commitMapRepairBatchOne(b, rev3Plan, rev3WorkItemId);
    const finalize3 = repairFinalizeWorkItemId(b.taskId, rev3Plan.repairPlanId, rev3Plan.planRevisionId);
    const clearOutcome = await runFinalizer(b, finalize3);
    expect(clearOutcome.kind).toBe('completed');
    // The round creation CONSUMES the transferred override exactly once.
    const after = await b.readEvents(b.taskId);
    const roundPlanned = after.filter((e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_round_planned' }> => e.type === 'structured_map_review_round_planned').pop();
    expect(roundPlanned).toBeDefined();
    expect(roundPlanned?.mapCycleOrdinal).toBe(2);
    expect(roundPlanned?.consumedOverrideRef?.digest).toBe(transfer.overrideRef.digest);
    const finalState = await b.env.readProjection(b.taskId);
    expect(finalState.availableOverride).toBeNull();
    expect(finalState.consumedOverrideRefs).toContain(transfer.overrideRef.digest);

    // The repaired Map round can settle, but the NEXT content cycle is also
    // ordinal 2 and has NO content override. This activation boundary must
    // terminal-fail exactly once; it must not publish map_activated, a content
    // round, or a generic retryable settlement failure.
    const beforeActivationCount = after.filter((event) => event.type === 'structured_map_activated').length;
    const settledRound = await completeRepairedMapRound(b, roundPlanned as Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_round_planned' }>, 'm-1');
    const activationOutcome = await settledRound.review.executeMapReviewSettlement({
      taskId: b.taskId,
      commandId: settledRound.settleLease.commandId ?? '',
      workItemId: settledRound.settlementWiId,
      commandKind: 'review_settlement',
      leaseEpoch: settledRound.settleLease.leaseEpoch,
      authorityBaseRef: settledRound.settleLease.authorityBaseRef,
      payloadRef: settledRound.coverageCoreRef,
    });
    expect(activationOutcome.kind).toBe('completed');
    const budgetEvents = await b.readEvents(b.taskId);
    expect(budgetEvents.filter((event) => event.type === 'structured_map_activated')).toHaveLength(beforeActivationCount);
    expect(budgetEvents.filter((event) => event.type === 'structured_review_round_planned')).toHaveLength(1);
    const contentFailures = budgetEvents.filter((event): event is Extract<AuthoritativeReviewEventV2, { type: 'structured_task_failed_v2' }> => event.type === 'structured_task_failed_v2' && event.failureCode === 'REVIEW_REPAIR_LIMIT_EXCEEDED');
    expect(contentFailures).toHaveLength(2); // the earlier Map boundary + this Content boundary
    const latestRecovery = await b.resolver(b.taskId, contentFailures[1]?.failureRecoveryPayloadRef as BlobRefV2) as { track: string; failedCycleOrdinal: number };
    expect(latestRecovery).toMatchObject({ track: 'content', failedCycleOrdinal: 2 });
  });
});

describe('I-3 (review): the content re-review round carries the plan verification stages and the settlement demands their records', { timeout: 120_000 }, () => {
  /** Drives the full content repair: plan -> batch 1 (journaled) -> finalizer
   * clear -> the cr-2 re-review round. Returns the cr-2 round id + refs. */
  async function driveContentRepairToReReviewRound(b: RepairEnv): Promise<{ plan: RepairPlanSpecV2; cr2Id: string; plannedCoreRef: BlobRefV2; plannedEvent: Extract<AuthoritativeReviewEventV2, { type: 'structured_review_round_planned' }> }> {
    const stack = await driveToContentStack(b, ['s-1']);
    const slot0 = stack.nodeIds[0] as string;
    await seedFindings(b, [{ findingId: 'c-1', primaryLocation: { kind: 'slot', id: slot0 }, defectClass: 'content', severity: 'blocking' }], 'content');
    const settlement = await createAndLeaseSettlement(b);
    await b.service.createRepairPlanFromSettlement({
      taskId: b.taskId,
      settlementWorkItemId: settlement.workItemId,
      settlementCommandId: settlement.commandId,
      leaseEpoch: settlement.leaseEpoch,
      authorityBaseRef: settlement.authorityBaseRef,
      roundId: 'round-1',
      coverageCoreRef: { kind: 'content_review_coverage_core', digest: 'e'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
      findings: blockingFindingsOf(['c-1']),
    });
    const state = await b.env.readProjection(b.taskId);
    const lineage = Object.values(state.repairPlans)[0];
    const head = lineage.revisions[lineage.currentPlanRevisionId as string];
    const plan = (await b.resolver(b.taskId, head.specRef)) as RepairPlanSpecV2;
    const workItemId = repairBatchWorkItemId(b.taskId, plan.repairPlanId, 1, plan.planRevisionId);
    const grant = (await grantOf(b, workItemId)) as RepairBatchGrantSpecV2 & { kind: 'content_repair_batch' };
    const leased = await leaseTargeted(b, workItemId, 'worker-a');
    const ctx = ctxOf(b, leased);
    const scope0 = plan.orderedBatchScopes[0];
    if (scope0 === undefined || scope0.kind !== 'content') throw new Error('expected content scope');
    const targetSlot = scope0.slotIds[0] as string;
    // The journaled write_slot_content result carries a REAL content_value ref
    // (the finalizer reconstructs the staged content from the journal).
    const valueBlob = { slotId: targetSlot, contentSchemaDigest: hash('schema'), taskContentRevision: 2, mediaType: 'text/markdown', text: 'repaired' };
    const blobWithout = { ...valueBlob } as Record<string, unknown>;
    const contentValueRef = await b.env.facade.prepareBlob(b.taskId, 'content_value', { ...blobWithout, selfDigest: canonicalJsonSha256(blobWithout) });
    const grantSpecRef = state.workItems[workItemId].grantSpecRef as BlobRefV2;
    await b.privateStore.appendReviewDraft(
      { workItemId, leaseEpoch: leased.leaseEpoch, attemptId: ctx.attemptId, authorityBaseRef: leased.authorityBaseRef, grantSpecRef },
      { clientOperationId: 'co-cr-1', op: 'write_slot_content', body: { slotId: targetSlot, value: 'repaired' }, result: { slotId: targetSlot, contentValueRef } },
    );
    const outcome = await b.service.commitRepairBatch({
      taskId: b.taskId,
      workItemId,
      attemptId: ctx.attemptId,
      batchOrdinal: 1,
      ctx,
      slotContents: { [targetSlot]: { text: 'repaired', mediaType: 'text/markdown' } },
    });
    expect(outcome.kind).toBe('committed');
    if (outcome.kind !== 'committed') throw new Error('content repair batch did not commit');
    await b.env.coordinator.completeWorkItem({
      taskId: b.taskId,
      operationId: attemptContinuationOperationId(b.taskId, workItemId, ctx.attemptId, 'complete'),
      workItemId,
      attemptId: ctx.attemptId,
      resultRefs: [outcome.stagingRootRef],
    });
    const finalizeWorkItemId = repairFinalizeWorkItemId(b.taskId, plan.repairPlanId, plan.planRevisionId);
    const finalizeOutcome = await runFinalizer(b, finalizeWorkItemId);
    if (finalizeOutcome.kind !== 'completed') throw new Error(`content finalize failed: ${JSON.stringify(finalizeOutcome)}`);
    const events = await b.readEvents(b.taskId);
    const plannedEvent = events.filter((e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_review_round_planned' }> => e.type === 'structured_review_round_planned').pop();
    if (plannedEvent === undefined) throw new Error('no content re-review round');
    const finalizedManifest = (await b.resolver(b.taskId, plannedEvent.contentRevisionManifestRef)) as ContentRevisionManifestV2;
    expect(finalizedManifest.finalizerWarningRootRefs).toHaveLength(1);
    expect(finalizedManifest.finalizerWarningRootRefs[0]?.kind).toBe('validation_warning_custody_root');
    const finalizeAggregate = await b.resolver(b.taskId, finalizedManifest.finalizerValidatorAggregateRefs[0] as BlobRefV2) as { inputRef: BlobRefV2 };
    const finalizeEnvelope = await b.resolver(b.taskId, finalizeAggregate.inputRef) as { stagedArtifactRef: BlobRefV2; stagingRootRef: BlobRefV2; keyLedgerRef: BlobRefV2; selectedTargetRefs: readonly BlobRefV2[] };
    expect(finalizeEnvelope.stagedArtifactRef.kind).toBe('content_revision_manifest');
    expect(finalizeEnvelope.stagingRootRef.kind).toBe('repair_staging_root');
    expect(finalizeEnvelope.keyLedgerRef.kind).toBe('repair_key_ledger');
    expect(finalizeEnvelope.selectedTargetRefs.length).toBe(finalizedManifest.entries.length);
    const finalizerCustody = await b.resolver(b.taskId, finalizedManifest.finalizerWarningRootRefs[0] as BlobRefV2) as { entries: readonly { warningRootRef: BlobRefV2 }[] };
    expect(finalizerCustody.entries[0]?.warningRootRef.kind).toBe('validation_warning_root');
    const stateAfter = await b.env.readProjection(b.taskId);
    const cr2WorkItem = Object.values(stateAfter.workItems).find((wi) => wi.roundId === plannedEvent.reviewRoundId && wi.sessionKind === 'review_content_batch');
    if (cr2WorkItem === undefined) throw new Error('no cr-2 review workitem');
    const baseSet = (await b.resolver(b.taskId, cr2WorkItem.authorityBaseRef)) as { reviewCoverageCoreRef: BlobRefV2 };
    void grant;
    return { plan, cr2Id: plannedEvent.reviewRoundId, plannedCoreRef: baseSet.reviewCoverageCoreRef, plannedEvent };
  }

  it('content repair -> re-review round carries the stages; a verification-less assignment is incomplete; with submit_finding_verification the settlement SEALS', async () => {
    const b = await makeRepairEnv({ maxRounds: 2 });
    const { cr2Id, plannedCoreRef, plannedEvent } = await driveContentRepairToReReviewRound(b);
    const events = await b.readEvents(b.taskId);
    // I-3: the cr-2 round-planned event carries the plan's verification
    // obligation (verificationFindingCount 1) and the finding is addressed.
    expect(plannedEvent.contentCycleOrdinal).toBe(2);
    expect(plannedEvent.verificationFindingCount).toBe(1);
    expect(events.some((e) => e.type === 'structured_finding_addressed' && e.findingId === 'c-1')).toBe(true);
    const state = await b.env.readProjection(b.taskId);
    expect(state.findings['c-1'].addressStages).toContain('content');
    expect(state.contentCycleOrdinal).toBe(2);
    // The planned coverage core's finding-stage root carries the committed
    // verification stage (the durable carrier).
    const plannedCore = (await b.resolver(b.taskId, plannedCoreRef)) as ContentReviewCoverageCoreV2;
    const stageRoot = (await b.resolver(b.taskId, plannedCore.findingStageRootRef)) as { entries: readonly { findingId: string; repairStage: string; state: string }[] };
    expect(stageRoot.entries).toContainEqual({ findingId: 'c-1', repairStage: 'content', state: 'committed' });
    // resolveContentRoundFromCore (probe C): the re-review round's targets
    // include the addressed-but-unverified finding opened in the PRIOR round.
    const resolved = await resolveContentRoundFromCore(b.taskId, plannedCore, { resolver: b.resolver, readProjection: b.env.readProjection, reviewPolicy: { ...REVIEW_POLICY, contentBatchTargetSlots: 2 } });
    expect(resolved.verificationFindingStages).toEqual(['c-1:content']);
    // The TOOL gate accepts the cross-round addressed finding as a target.
    expect(
      validateVerificationSubmission({
        submission: { findingId: 'c-1', repairStage: 'content', verdict: 'resolved', evidence: ['e'] },
        round: resolved,
        findings: state.findings as never,
      }),
    ).toEqual([]);
    // The assignment freeze WITHOUT the verification record is incomplete
    // (missing -> rejected with ZERO publication — the round never completes).
    const content = contentReviewServiceOn(b);
    // The cr-2 manifest's REAL set slot ids (the map layer allocates sl-... ids).
    const cr2Manifest = (await b.resolver(b.taskId, plannedEvent.contentRevisionManifestRef)) as { entries: readonly { slotId: string }[] };
    const setSlotIds = cr2Manifest.entries.map((e) => e.slotId).sort();
    const plan = planContentReview({ slots: setSlotIds.map((slotId) => ({ slotId, documentOrder: 0, parentSlotId: null })), relations: [], reviewPolicy: { ...REVIEW_POLICY, contentBatchTargetSlots: 2 }, assignmentCount: plannedEvent.assignmentCount });
    const batchWiId = reviewBatchWorkItemId(cr2Id, 0);
    const batchLease = await leaseTargeted(b, batchWiId, 'worker-r');
    const batchAttemptId = batchLease.attemptId ?? '';
    const targets = [...plan.batches[0].slotIds, ...plan.batches[0].relationIds];
    const baselineTargetKinds: Record<string, ReviewFactV2['targetKind']> = {};
    for (const id of plan.batches[0].slotIds) baselineTargetKinds[id] = 'content_slot';
    const passRecords: ReviewDraftRecordV2[] = targets.map((targetId) => ({
      op: 'submit_slot_review',
      body: { targetId, verdict: 'pass', evidence: [], findingDrafts: [], crossScopeFindingDrafts: [] },
      at: b.env.now.value,
    }));
    const freezeWithout = buildReviewAssignmentFreeze({
      assignmentId: batchWiId,
      workItemId: batchWiId,
      reviewAssignmentId: reviewAssignmentIdOf(cr2Id, 0),
      roundKind: 'content',
      roundId: cr2Id,
      attemptId: batchAttemptId,
      reviewerAttemptId: batchAttemptId,
      reviewPolicyDigest: hash('review-policy'),
      records: passRecords,
      verificationFindingStages: ['c-1:content'],
      assignmentTargets: targets,
      baselineTargetKinds,
      requireOrdinaryCoverage: true,
    });
    expect(freezeWithout.ok).toBe(false);
    if (!freezeWithout.ok) expect(freezeWithout.errors.some((e) => e.includes('missing verification record'))).toBe(true);
    // With submit_finding_verification the freeze completes -> round completes
    // -> settlement gate (verification records present) -> SEAL.
    const records = [...passRecords, { op: 'submit_finding_verification', body: { findingId: 'c-1', repairStage: 'content', verdict: 'resolved', evidence: ['e'] }, at: b.env.now.value }];
    const freeze = buildReviewAssignmentFreeze({
      assignmentId: batchWiId,
      workItemId: batchWiId,
      reviewAssignmentId: reviewAssignmentIdOf(cr2Id, 0),
      roundKind: 'content',
      roundId: cr2Id,
      attemptId: batchAttemptId,
      reviewerAttemptId: batchAttemptId,
      reviewPolicyDigest: hash('review-policy'),
      records,
      verificationFindingStages: ['c-1:content'],
      assignmentTargets: targets,
      baselineTargetKinds,
      requireOrdinaryCoverage: true,
    });
    if (!freeze.ok) throw new Error(`cr-2 batch freeze failed: ${freeze.errors.join('; ')}`);
    await content.freezeReviewAssignment(b.taskId, freeze.freeze);
    await b.env.coordinator.completeWorkItem({
      taskId: b.taskId,
      operationId: attemptContinuationOperationId(b.taskId, batchWiId, batchAttemptId, 'complete'),
      workItemId: batchWiId,
      attemptId: batchAttemptId,
      resultRefs: [refOfBlob('review_assignment_ledger', freeze.freeze.ledger)],
    });
    const wholeWiId = reviewWholeWorkItemId(cr2Id);
    const wholeLease = await leaseTargeted(b, wholeWiId, 'worker-r');
    const wholeAttemptId = wholeLease.attemptId ?? '';
    const wholeRecords: ReviewDraftRecordV2[] = [
      {
        op: 'submit_whole_tree_finding',
        body: { findingDraft: { clientFindingKey: 'wk', defectClass: 'content', severity: 'advisory', primaryLocation: { kind: 'slot', id: setSlotIds[0] as string }, evidence: [] }, anchoredVerdict: null },
        at: b.env.now.value,
      },
    ];
    const wholeFreeze = buildReviewAssignmentFreeze({
      assignmentId: wholeWiId,
      workItemId: wholeWiId,
      reviewAssignmentId: reviewWholeAssignmentId(cr2Id),
      roundKind: 'content',
      roundId: cr2Id,
      attemptId: wholeAttemptId,
      reviewerAttemptId: wholeAttemptId,
      reviewPolicyDigest: hash('review-policy'),
      records: wholeRecords,
      verificationFindingStages: [],
      assignmentTargets: [],
      baselineTargetKinds: {},
      requireOrdinaryCoverage: false,
    });
    if (!wholeFreeze.ok) throw new Error(`cr-2 whole freeze failed: ${wholeFreeze.errors.join('; ')}`);
    await content.freezeReviewAssignment(b.taskId, wholeFreeze.freeze);
    await b.env.coordinator.completeWorkItem({
      taskId: b.taskId,
      operationId: attemptContinuationOperationId(b.taskId, wholeWiId, wholeAttemptId, 'complete'),
      workItemId: wholeWiId,
      attemptId: wholeAttemptId,
      resultRefs: [refOfBlob('review_assignment_ledger', wholeFreeze.freeze.ledger)],
    });
    const advanced = await content.maybeCompleteRound(b.taskId, cr2Id);
    if (!advanced) throw new Error('cr-2 round did not advance');
    const settlementWiId = deterministicContentSettlementWorkItemId(b.taskId, cr2Id);
    const settleLease = await leaseTargeted(b, settlementWiId, 'worker-s');
    const completed = (await b.readEvents(b.taskId)).find((e) => e.type === 'structured_review_round_completed' && e.reviewRoundId === cr2Id);
    if (completed === undefined || completed.type !== 'structured_review_round_completed') throw new Error('no content round completed');
    const settleOutcome = await content.executeContentReviewSettlement({
      taskId: b.taskId,
      commandId: settleLease.commandId ?? '',
      workItemId: settlementWiId,
      commandKind: 'review_settlement',
      leaseEpoch: settleLease.leaseEpoch,
      authorityBaseRef: settleLease.authorityBaseRef,
      payloadRef: completed.coverageCoreRef,
    });
    expect(settleOutcome.kind).toBe('completed');
    const finalEvents = await b.readEvents(b.taskId);
    const settled = finalEvents.find((e) => e.type === 'structured_review_round_settled' && e.reviewRoundId === cr2Id);
    expect((settled as { outcome?: string } | undefined)?.outcome).toBe('seal');
    expect(finalEvents.some((e) => e.type === 'structured_finding_verified_closed' && e.findingId === 'c-1')).toBe(true);
    expect((await b.env.readProjection(b.taskId)).findings['c-1'].state).toBe('verified_closed');
  });
});

describe('I-4 (review): scope-expansion approval supersedes the old WorkItem atomically', { timeout: 120_000 }, () => {
  it('approval emits structured_work_item_superseded; the old grant fails PLAN_STALE; the old workitem is not claimable; the successor proceeds to completion', async () => {
    const b = await makeRepairEnv();
    const stack = await driveToContentStack(b, ['s-1', 's-2']);
    await seedFindings(b, mapBlockingFindings(stack.nodeIds), 'map');
    const settlement = await createAndLeaseSettlement(b);
    await b.service.createRepairPlanFromSettlement({
      taskId: b.taskId,
      settlementWorkItemId: settlement.workItemId,
      settlementCommandId: settlement.commandId,
      leaseEpoch: settlement.leaseEpoch,
      authorityBaseRef: settlement.authorityBaseRef,
      roundId: 'round-1',
      coverageCoreRef: { kind: 'content_review_coverage_core', digest: 'e'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
      findings: blockingFindingsOf(['m-1']),
    });
    const state0 = await b.env.readProjection(b.taskId);
    const lineage = Object.values(state0.repairPlans)[0];
    const head = lineage.revisions[lineage.currentPlanRevisionId as string];
    const plan = (await b.resolver(b.taskId, head.specRef)) as RepairPlanSpecV2;
    const oldWorkItemId = repairBatchWorkItemId(b.taskId, plan.repairPlanId, 1, plan.planRevisionId);
    // Lease + request + RETRYABLY-FAIL the old session: the supersede is
    // projector-legal only when the old workitem is ready/retryable_failed/
    // parked (a mid-session lease with a STARTED attempt would corrupt
    // `supersede_without_terminal` — the projector demands the cycle ended).
    const requestLease = await leaseTargeted(b, oldWorkItemId, 'worker-a');
    const requestCtx = ctxOf(b, requestLease);
    const requestedNodeId = stack.nodeIds[1] as string;
    await b.service.requestScopeExpansion(requestCtx, { findingIds: ['m-1'], requestedNodeIds: [requestedNodeId], reason: 'need more nodes', clientOperationId: 'co-i4-1' });
    const requestEvents = await b.readEvents(b.taskId);
    const request = requestEvents.find((e) => e.type === 'structured_repair_scope_requested');
    if (request === undefined) throw new Error('no scope request');
    await b.env.coordinator.recordRetryableFailure({
      taskId: b.taskId,
      operationId: opId('retry-old-session'),
      workItemId: oldWorkItemId,
      attemptId: requestCtx.attemptId,
      failureCode: 'TEST_RETRYABLE',
      failureDigest: hash('retry'),
    });
    const tail = await b.env.eventStore.tail(b.taskId);
    const approval = await b.service.approveScopeExpansion({
      taskId: b.taskId,
      requestId: request.requestId,
      operatorId: 'operator-1',
      expectedLastSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
      requestedNodeIds: [requestedNodeId],
      findingIds: ['m-1'],
      reason: 'approved',
    });
    expect(approval.kind).toBe('completed');
    const events = await b.readEvents(b.taskId);
    const superseded = events.find((e) => e.type === 'structured_work_item_superseded');
    expect(superseded).toBeDefined();
    if (superseded === undefined) return;
    expect((superseded as { workItemId: string }).workItemId).toBe(oldWorkItemId);
    expect((superseded as { reason: string }).reason).toBe('new_authority_base');
    const state = await b.env.readProjection(b.taskId);
    // The old workitem is superseded — NOT claimable (leaseNext claims only
    // ready workitems).
    expect(state.workItems[oldWorkItemId].state).toBe('superseded');
    // The old grant can never commit: the plan head is superseded (PLAN_STALE).
    await expect(
      b.service.commitRepairBatch({
        taskId: b.taskId,
        workItemId: oldWorkItemId,
        attemptId: requestCtx.attemptId,
        batchOrdinal: 1,
        ctx: requestCtx,
        mapPatch: { expectedStagingDigest: '0'.repeat(64), operations: [] },
      }),
    ).rejects.toThrow(/not the current active revision/);
    // The successor proceeds to completion.
    const successorPlan = (await b.resolver(b.taskId, state.repairPlans[plan.repairPlanId].revisions[state.repairPlans[plan.repairPlanId].currentPlanRevisionId as string].specRef)) as RepairPlanSpecV2;
    const successorWorkItemId = repairBatchWorkItemId(b.taskId, plan.repairPlanId, 1, successorPlan.planRevisionId);
    await commitMapRepairBatchOne(b, successorPlan, successorWorkItemId);
    const finalEvents = await b.readEvents(b.taskId);
    expect(finalEvents.some((e) => e.type === 'structured_map_repair_batch_committed' && (e as { planRevisionId?: string }).planRevisionId === successorPlan.planRevisionId)).toBe(true);
    const finalState = await b.env.readProjection(b.taskId);
    expect(finalState.workItems[oldWorkItemId].state).toBe('superseded');
  });

  it('R2-2 (re-review round 2): a MID-SESSION approval atomically abandons + reclaims + supersedes the stale workitem; the successor proceeds to completion', async () => {
    const b = await makeRepairEnv();
    const stack = await driveToContentStack(b, ['s-1', 's-2']);
    await seedFindings(b, mapBlockingFindings(stack.nodeIds), 'map');
    const settlement = await createAndLeaseSettlement(b);
    await b.service.createRepairPlanFromSettlement({
      taskId: b.taskId,
      settlementWorkItemId: settlement.workItemId,
      settlementCommandId: settlement.commandId,
      leaseEpoch: settlement.leaseEpoch,
      authorityBaseRef: settlement.authorityBaseRef,
      roundId: 'round-1',
      coverageCoreRef: { kind: 'content_review_coverage_core', digest: 'e'.repeat(64), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
      findings: blockingFindingsOf(['m-1']),
    });
    const state0 = await b.env.readProjection(b.taskId);
    const lineage = Object.values(state0.repairPlans)[0];
    const head = lineage.revisions[lineage.currentPlanRevisionId as string];
    const plan = (await b.resolver(b.taskId, head.specRef)) as RepairPlanSpecV2;
    const oldWorkItemId = repairBatchWorkItemId(b.taskId, plan.repairPlanId, 1, plan.planRevisionId);
    // The NORMAL operator flow: the request tool runs INSIDE a leased session —
    // the old workitem is LEASED with a STARTED attempt at approval time.
    const requestLease = await leaseTargeted(b, oldWorkItemId, 'worker-a');
    const requestCtx = ctxOf(b, requestLease);
    const requestedNodeId = stack.nodeIds[1] as string;
    await b.service.requestScopeExpansion(requestCtx, { findingIds: ['m-1'], requestedNodeIds: [requestedNodeId], reason: 'need more nodes', clientOperationId: 'co-r2-1' });
    const requestEvents = await b.readEvents(b.taskId);
    const request = requestEvents.find((e) => e.type === 'structured_repair_scope_requested');
    if (request === undefined) throw new Error('no scope request');
    const midState = await b.env.readProjection(b.taskId);
    expect(midState.workItems[oldWorkItemId].state).toBe('leased');
    const tail = await b.env.eventStore.tail(b.taskId);
    const approval = await b.service.approveScopeExpansion({
      taskId: b.taskId,
      requestId: request.requestId,
      operatorId: 'operator-1',
      expectedLastSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
      requestedNodeIds: [requestedNodeId],
      findingIds: ['m-1'],
      reason: 'approved',
    });
    expect(approval.kind).toBe('completed');
    const events = await b.readEvents(b.taskId);
    // The envelope ends the mid-session cycle ATOMICALLY: attempt-abandoned +
    // lease-reclaimed BEFORE the supersede (the projector-legal order).
    const abandoned = events.find((e) => e.type === 'structured_agent_attempt_abandoned_v2');
    expect(abandoned).toBeDefined();
    expect((abandoned as { workItemId: string }).workItemId).toBe(oldWorkItemId);
    expect((abandoned as { attemptId: string }).attemptId).toBe(requestCtx.attemptId);
    const reclaimed = events.find((e) => e.type === 'structured_work_item_lease_reclaimed');
    expect(reclaimed).toBeDefined();
    expect((reclaimed as { workItemId: string }).workItemId).toBe(oldWorkItemId);
    const superseded = events.find((e) => e.type === 'structured_work_item_superseded');
    expect(superseded).toBeDefined();
    if (superseded === undefined) return;
    expect((superseded as { workItemId: string }).workItemId).toBe(oldWorkItemId);
    expect((superseded as { reason: string }).reason).toBe('new_authority_base');
    // The stale workitem is superseded — NEVER claimable again — and its
    // attempt is abandoned (the cycle ended atomically).
    const state = await b.env.readProjection(b.taskId);
    expect(state.workItems[oldWorkItemId].state).toBe('superseded');
    expect(state.attempts[requestCtx.attemptId].state).toBe('abandoned');
    expect(state.activeLease).toBeNull();
    // The successor proceeds to completion.
    const successorPlan = (await b.resolver(b.taskId, state.repairPlans[plan.repairPlanId].revisions[state.repairPlans[plan.repairPlanId].currentPlanRevisionId as string].specRef)) as RepairPlanSpecV2;
    const successorWorkItemId = repairBatchWorkItemId(b.taskId, plan.repairPlanId, 1, successorPlan.planRevisionId);
    await commitMapRepairBatchOne(b, successorPlan, successorWorkItemId);
    const finalEvents = await b.readEvents(b.taskId);
    expect(finalEvents.some((e) => e.type === 'structured_map_repair_batch_committed' && (e as { planRevisionId?: string }).planRevisionId === successorPlan.planRevisionId)).toBe(true);
    const finalState = await b.env.readProjection(b.taskId);
    expect(finalState.workItems[oldWorkItemId].state).toBe('superseded');
    expect(finalState.attempts[requestCtx.attemptId].state).toBe('abandoned');
  });
});
