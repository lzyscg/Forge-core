// @vitest-environment node
/**
 * Task 21 P1#1 integration: the PRODUCTION System Seal execution through the
 * real registry + AttemptCoordinator + facade + projector. A committed
 * `system_seal` WorkItem (ready) is leased and executed by the composition's
 * `V2AttemptCoordinator` (the six-handler `SystemCommandRegistry` with the
 * real SystemSealServiceV2 installed), and the six-event seal envelope commits
 * through the facade's `system_seal_publish` registration. The test NEVER
 * instantiates `SystemSealServiceV2` directly — everything flows through the
 * installed registry.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { parseBlob, refOfBlob } from '../../authoritative-review/object-registry';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { FrozenTemplate } from '../../template/template-schema';
import type { FrozenStructuredSlotContractV2 } from '../../template/structured-slot-contract-v2';
import type { ValidatorRegistrationV2 } from '../../template/structured-slot-contract-v2';
import { validateAuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import { createWorkItemCoordinatorEnvironment, disposeRuntimeTestRoots } from '../test-support';
import type { WorkItemCoordinatorEnvironment } from '../test-support';
import { ArtifactStore } from '../../storage/artifact-store';
import { AuthoritativeWakeupIndexV1 } from './wakeup-index';
import { TraceStore } from '../../storage/trace-store';
import { FakeAgentRuntime } from '../fake-agent-runtime';
import { V2AssignmentRunner } from './assignment-runner';
import { buildAuthorityBaseSet } from './authority-base';
import { buildReviewObservationGrantSpec } from './review-coordinator';
import { ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION } from './assembler-registry';
import { buildAuthoritativeReviewTestProfileBody } from '../../structured-slots/test-support/authoritative-review-test-registry';
import { AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES } from './builtin-validators';
import {
  installAuthoritativeReviewRuntime,
  deterministicSubmitterWorkItemId,
} from './production-composition';
import { attemptContinuationOperationId } from './attempt-coordinator';
import type { V2SchedulingPassResult } from '../task-scheduler';

afterEach(() => disposeRuntimeTestRoots());

const H = (label: string) => canonicalJsonSha256({ label });
const sha = (value: unknown): string => canonicalJsonSha256(value);
const TEMPLATE_HASH = 'a'.repeat(64);
const TASK = 'task-seal-production';
const ROUND_ID = 'content-round-1';

function selfDigest<T extends Record<string, unknown>>(body: T, field: keyof T & string): T {
  const { [field]: _omit, ...rest } = body;
  return { ...body, [field]: canonicalJsonSha256(rest) } as T;
}

function registration(handlerKey: string): ValidatorRegistrationV2 {
  const entry = AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES.find((candidate) => candidate.handlerKey === handlerKey);
  if (entry === undefined) throw new Error(`missing builtin ${handlerKey}`);
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

/** The zhihu-chapter v2 contract the seal assembler needs. */
function buildSealContract(): FrozenStructuredSlotContractV2 {
  const slotType = (id: string, presence: 'forbidden' | 'optional' | 'required') => ({
    id,
    name: id,
    description: id,
    specSchema: { type: 'object' },
    content: presence === 'forbidden' ? { presence } : { presence, schema: { type: 'string' } },
  });
  return {
    version: 2,
    slotTypes: [
      slotType('chapter', 'forbidden'),
      slotType('title', 'required'),
      slotType('opening', 'required'),
      slotType('scene_block', 'required'),
      slotType('emotional_closure', 'required'),
      slotType('chapter_end', 'required'),
    ],
    layoutGrammar: {} as never,
    accessProfiles: [],
    relationTypes: [],
    relationshipPolicy: { mode: 'disabled' },
    reviewPolicy: {
      mapReview: 'required',
      contentSelector: 'content_bearing',
      mapBatchTargetSlots: 24,
      contentBatchTargetSlots: 2,
      assignmentSoftLimit: 64,
      wholeMapObservation: 'required',
      wholeContentTreeObservation: 'required',
      reviewAdvisoryRelations: false,
      maxRounds: 8,
    },
    validators: [registration('authoritative.review.artifactPath')],
    assembler: ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION,
    limits: {} as never,
    canonicalBytes: new Uint8Array(),
    semanticDigest: H('seal-contract-semantic'),
    implementationIdentityClosure: [],
  } as unknown as FrozenStructuredSlotContractV2;
}

const CONTRACT = buildSealContract();

const frozenV2: FrozenTemplate = {
  id: 'seal-integration',
  name: 'Seal integration',
  description: 'v2',
  versionHash: '0'.repeat(64),
  productionMode: 'structured_slots',
  structuredSlots: CONTRACT as never,
  structuredPhases: null,
  structuredReviewLifecycle: {
    protocol: 'authoritative_review_v1',
    roleBindings: { orchestrator: 'orchestrator', generator: 'generator', reviewer: 'reviewer', submitter: 'submitter' },
    systemArtifactProducer: 'system:structured_seal',
  },
  authoritativeReviewProfile: {
    profileIdentity: 'forge-authoritative-review/v1',
    profileDigest: H('seal-profile-digest'),
    profileSnapshotRef: refOfBlob('profile_snapshot', { label: 'placeholder' }),
  },
  inputFields: [],
  agents: [],
  routes: [],
  artifactSchema: { files: [] },
  finalOutput: { name: 'out', format: 'markdown', submitters: ['submitter'] },
  budget: null,
  sourcePath: 'fixture:seal-integration',
} as unknown as FrozenTemplate;

/** The zhihu-chapter content-bearing slot ids in assembler order. */
const CONTENT_SLOTS = ['title', 'opening', 'scene', 'emotional_closure', 'chapter_end'];

/** One committed review fact for a slot (pass). */
function mkFact(slotId: string): Record<string, unknown> {
  return {
    factId: `fact-${slotId}`,
    targetKind: 'content_slot',
    targetStableId: slotId,
    verdict: 'pass',
    factOrigin: { kind: 'batch', adoptionEligible: true },
    adoptionEligible: true,
    localSubjectDigest: H(`subject-${slotId}`),
    localContextDigest: H(`context-${slotId}`),
    reviewPolicyDigest: H('review-policy'),
    findingIds: [],
    evidence: [],
    reviewerAttemptId: 'attempt-review-1',
    recordedAt: '2026-08-14T10:00:00.000Z',
  };
}

interface SealFixture {
  env: WorkItemCoordinatorEnvironment;
  mapSnapshotRef: BlobRefV2;
  finalizedManifestRef: BlobRefV2;
  reviewBundleRef: BlobRefV2;
  sealAuthorityBaseRef: BlobRefV2;
  sealWorkItemId: string;
  coverageCoreRef: BlobRefV2;
  profileSnapshotRef: BlobRefV2;
  templateSnapshotRef: BlobRefV2;
}

/** Builds every blob and commits the seed events for a ready system_seal WorkItem. */
async function prepareSealFixture(): Promise<SealFixture> {
  const env = await createWorkItemCoordinatorEnvironment();
  // The profile snapshot must live under THIS task's blob store (the env
  // pre-prepares it under its support task id).
  const profileSnapshotRef = await env.facade.prepareBlob(TASK, 'profile_snapshot', buildAuthoritativeReviewTestProfileBody());
  const templateSnapshotRef = env.templateSnapshotRef;

  const put = <K extends Parameters<typeof parseBlob>[0]>(kind: K, value: unknown): Promise<BlobRefV2> =>
    env.facade.prepareBlob(TASK, kind, value);

  /* ---- content values + versions (the finalized manifest's set entries) ---- */
  const contentVersions: Record<string, BlobRefV2> = {};
  for (const slotId of CONTENT_SLOTS) {
    const body = {
      slotId,
      contentSchemaDigest: H('schema'),
      taskContentRevision: 2,
      mediaType: 'text/markdown' as const,
      text: `sealed ${slotId} content`,
    };
    const valueRef = await put('content_value', { ...body, selfDigest: sha(body) });
    const version: Record<string, unknown> = {
      state: 'set',
      slotId,
      slotRevision: 1,
      taskContentRevision: 2,
      mapRef: refOfBlob('map_snapshot', { label: 'map' }),
      mapSemanticDigest: H('map-semantic'),
      contentSchemaDigest: H('schema'),
      contentDigest: valueRef.digest,
      blobRef: valueRef,
      provenance: {
        kind: 'generated',
        producer: { kind: 'generation_batch', planRevisionId: 'gp-1', batchOrdinal: 0, attemptId: 'att-1' },
        contentRevisionCommitCoreRef: refOfBlob('content_revision_commit_core', { label: 'core' }),
        contentCommitValidatorAggregateRef: refOfBlob('validator_aggregate', { label: 'commit-agg' }),
        contentCommitWarningRootRef: refOfBlob('validation_warning_custody_root', { label: 'commit-warn' }),
        committedByAttemptId: 'att-1',
      },
    };
    contentVersions[slotId] = await put('content_version', version);
  }

  /* ---- active Map snapshot (zhihu chapter scaffold, zero relations) ---- */
  const nodeSpec = (slotId: string, slotType: string, contentBearing: boolean, parentSlotId: string | null, documentOrder: number) => {
    const body = { slotId, slotType, contentBearing, parentSlotId, documentOrder, siblingOrder: documentOrder };
    return { ...body, nodeSpecDigest: sha(body) };
  };
  const nodes = [
    nodeSpec('chapter', 'chapter', false, null, 0),
    nodeSpec('title', 'title', true, 'chapter', 1),
    nodeSpec('opening', 'opening', true, 'chapter', 2),
    nodeSpec('scene', 'scene_block', true, 'chapter', 3),
    nodeSpec('emotional_closure', 'emotional_closure', true, 'chapter', 4),
    nodeSpec('chapter_end', 'chapter_end', true, 'chapter', 5),
  ];
  const MAP_SEMANTIC = H('map-semantic');

  /* ---- the map review bundle + map review settlement (pre-seal) ---- */
  const mapSettlementCoverageCoreRef = await put('map_review_coverage_core', selfDigest({
    mapReviewRoundId: 'map-round-1',
    candidateRef: refOfBlob('map_candidate', { label: 'candidate' }),
    contentRevisionManifestRef: refOfBlob('content_revision_manifest', { label: 'baseline' }),
    contentRootDigest: null,
    reviewPolicyDigest: H('review-policy'),
    coverageLedgerRootRefs: [],
    wholeMapObservationRootRefs: [],
    findingStageRootRef: refOfBlob('finding_stage_root', { label: 'map-stage' }),
    coreDigest: '',
  }, 'coreDigest'));
  const mapSettlementEnvelopeRef = await put('validator_input_envelope', {
    trigger: 'map_review_settlement',
    taskId: TASK,
    templateSnapshotHash: TEMPLATE_HASH,
    mapReviewCoverageCoreRef: mapSettlementCoverageCoreRef,
    selectedTargetRefs: [],
  });
  const mapSettlementWarningRef = await put('validation_warning_root', selfDigest({
    trigger: 'map_review_settlement',
    executionPhase: null,
    inputRef: mapSettlementEnvelopeRef,
    inputDigest: mapSettlementEnvelopeRef.digest,
    orderedAdvisoryReceiptRefs: [],
    warningCount: 0,
    rootDigest: '',
  }, 'rootDigest'));
  const mapSettlementAggregateRef = await put('validator_aggregate', selfDigest({
    trigger: 'map_review_settlement',
    executionPhase: null,
    inputRef: mapSettlementEnvelopeRef,
    inputDigest: mapSettlementEnvelopeRef.digest,
    registrationSetDigest: H('map-set-reg'),
    validExecutionDigests: [H('map-set-valid')],
    blockingInvalidReceiptRefs: [],
    advisoryReceiptRefs: [],
    infrastructureFailureRefs: [],
    warningRootRef: mapSettlementWarningRef,
    outcome: 'clear',
    aggregateDigest: '',
  }, 'aggregateDigest'));
  const mapSettlementCoreRef = await put('map_review_settlement_core', selfDigest({
    coverageCoreRef: mapSettlementCoverageCoreRef,
    mapReviewSettlementValidatorAggregateRef: mapSettlementAggregateRef,
    coreDigest: '',
  }, 'coreDigest'));
  const proposedMapCoreRef = await put('proposed_map_core', selfDigest({
    scaffoldId: 'scaffold-1',
    proposedMapId: 'map-1',
    supersedesMapId: null,
    sourceCandidateRef: refOfBlob('map_candidate', { label: 'candidate' }),
    mapRevision: 1,
    mapSemanticDigest: MAP_SEMANTIC,
    positionGraphDigest: H('position'),
    relationGraphDigest: H('relation-graph'),
    templateSnapshotHash: TEMPLATE_HASH,
    nodes,
    relations: [],
    coreDigest: '',
  }, 'coreDigest'));
  const mapActivationEnvelopeRef = await put('validator_input_envelope', {
    trigger: 'map_activation',
    taskId: TASK,
    templateSnapshotHash: TEMPLATE_HASH,
    mapReviewSettlementCoreRef: mapSettlementCoreRef,
    proposedMapCoreRef,
    selectedTargetRefs: [],
  });
  const mapActivationWarningRef = await put('validation_warning_root', selfDigest({
    trigger: 'map_activation',
    executionPhase: null,
    inputRef: mapActivationEnvelopeRef,
    inputDigest: mapActivationEnvelopeRef.digest,
    orderedAdvisoryReceiptRefs: [],
    warningCount: 0,
    rootDigest: '',
  }, 'rootDigest'));
  const mapActivationAggregateRef = await put('validator_aggregate', selfDigest({
    trigger: 'map_activation',
    executionPhase: null,
    inputRef: mapActivationEnvelopeRef,
    inputDigest: mapActivationEnvelopeRef.digest,
    registrationSetDigest: H('map-act-reg'),
    validExecutionDigests: [H('map-act-valid')],
    blockingInvalidReceiptRefs: [],
    advisoryReceiptRefs: [],
    infrastructureFailureRefs: [],
    warningRootRef: mapActivationWarningRef,
    outcome: 'clear',
    aggregateDigest: '',
  }, 'aggregateDigest'));
  const mapWarningCustodyRootRef = await put('validation_warning_custody_root', selfDigest({
    scope: 'map_review',
    taskId: TASK,
    baseRefs: [mapActivationEnvelopeRef],
    entries: [],
    supersessionPolicyVersion: '1',
    rootDigest: '',
  }, 'rootDigest'));
  const mapReviewBundleRef = await put('map_review_bundle', selfDigest({
    settlementCoreRef: mapSettlementCoreRef,
    proposedMapCoreRef,
    mapActivationValidatorAggregateRef: mapActivationAggregateRef,
    mapWarningCustodyRootRef,
    bundleDigest: '',
  }, 'bundleDigest'));

  const mapSnapshotRef = await put('map_snapshot', {
    scaffoldId: 'scaffold-1',
    mapId: 'map-1',
    supersedesMapId: null,
    sourceCandidateId: 'candidate-1',
    proposedMapCoreRef,
    mapReviewBundleRef,
    mapRevision: 1,
    mapSemanticDigest: MAP_SEMANTIC,
    positionGraphDigest: H('position'),
    relationGraphDigest: H('relation-graph'),
    templateSnapshotHash: TEMPLATE_HASH,
    nodes,
    relations: [],
    activatedAt: '2026-08-14T10:00:00.000Z',
  });

  /* ---- baseline + finalized content revision manifests ---- */
  const manifestEntries = [...CONTENT_SLOTS].sort().map((slotId) => ({ slotId, versionRef: contentVersions[slotId]! }));
  const baselineRef = await put('content_revision_manifest', selfDigest({
    taskId: TASK,
    mapRef: mapSnapshotRef,
    mapSemanticDigest: MAP_SEMANTIC,
    taskContentRevision: 1,
    manifestPhase: 'baseline_unset',
    entries: manifestEntries,
    producerPlanSpecRef: null,
    priorManifestRef: null,
    finalizerValidatorAggregateRefs: [],
    finalizerWarningRootRefs: [],
    contentRootDigest: H('content-root'),
    manifestDigest: '',
  }, 'manifestDigest'));
  const finalizedManifestRef = await put('content_revision_manifest', selfDigest({
    taskId: TASK,
    mapRef: mapSnapshotRef,
    mapSemanticDigest: MAP_SEMANTIC,
    taskContentRevision: 2,
    manifestPhase: 'finalized',
    entries: manifestEntries,
    producerPlanSpecRef: null,
    priorManifestRef: baselineRef,
    finalizerValidatorAggregateRefs: [refOfBlob('validator_aggregate', { label: 'finalizer' })],
    finalizerWarningRootRefs: [],
    contentRootDigest: H('content-root'),
    manifestDigest: '',
  }, 'manifestDigest'));

  /* ---- content review coverage (committed facts + whole-tree observation) ---- */
  const factRefs: BlobRefV2[] = [];
  for (const slotId of CONTENT_SLOTS) {
    factRefs.push(await put('review_fact', mkFact(slotId)));
  }
  factRefs.sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
  const ledgerRef = await put('review_assignment_ledger', selfDigest({
    assignmentId: 'assign-content-1',
    workItemId: 'wi-review-content',
    reviewAssignmentId: null,
    roundKind: 'content',
    roundId: ROUND_ID,
    factRefs,
    findingDraftRefs: [],
    verificationRecordRefs: [],
    coverageTargetIds: [...CONTENT_SLOTS].sort(),
    ledgerDigest: '',
  }, 'ledgerDigest'));
  const wholeLedgerRef = await put('review_assignment_ledger', selfDigest({
    assignmentId: 'assign-whole-1',
    workItemId: 'wi-review-whole',
    reviewAssignmentId: null,
    roundKind: 'content',
    roundId: ROUND_ID,
    factRefs: [],
    findingDraftRefs: [],
    verificationRecordRefs: [],
    coverageTargetIds: [],
    ledgerDigest: '',
  }, 'ledgerDigest'));
  const adoptionRootRef = await put('review_adoption_root', selfDigest({
    roundId: ROUND_ID,
    orderedChunkRefs: [],
    adoptedTargetCount: 0,
    coverageDigest: H('adoption-cov'),
    rootDigest: '',
  }, 'rootDigest'));
  const findingStageRootRef = await put('finding_stage_root', selfDigest({
    rootId: 'stage-content-1',
    roundId: ROUND_ID,
    entries: [],
    rootDigest: '',
  }, 'rootDigest'));
  const coverageCoreRef = await put('content_review_coverage_core', selfDigest({
    reviewRoundId: ROUND_ID,
    mapRef: mapSnapshotRef,
    contentRevisionManifestRef: finalizedManifestRef,
    reviewPolicyDigest: H('review-policy'),
    coverageLedgerRootRefs: [ledgerRef],
    adoptionRootRef,
    wholeTreeObservationRootRefs: [wholeLedgerRef],
    findingStageRootRef,
    coreDigest: '',
  }, 'coreDigest'));

  /* ---- the committed content-review assignment (round completion needs it) ---- */
  const reviewWorkItemId = 'wi-review-content';
  const reviewAssignmentId = 'ra-review-content';
  const logicalAssignmentId = 'la-review-content';
  const attemptId = 'att-review-content';
  const reviewAuthorityBaseRef = await put('authority_base_set', buildAuthorityBaseSet({
    taskId: TASK,
    templateSnapshotRef,
    profileSnapshotRef,
    refs: {
      mapRef: mapSnapshotRef,
      contentRevisionManifestRef: finalizedManifestRef,
      reviewCoverageCoreRef: coverageCoreRef,
      reviewRoundRef: coverageCoreRef,
    },
    kind: 'agent_assignment',
    agentExecutionKind: 'structured_session',
    sessionKind: 'review_content_batch',
  }));
  const reviewGrantSpecRef = await put('write_grant_spec', buildReviewObservationGrantSpec({
    grantSpecId: `gs-${reviewWorkItemId}`,
    workItemId: reviewWorkItemId,
    authorityBaseRef: reviewAuthorityBaseRef,
    sessionKind: 'review_content_batch',
    reviewAssignmentId,
    roundId: ROUND_ID,
    roundKind: 'content',
    snapshotHash: TEMPLATE_HASH,
    maxContextBytes: 1_024,
  }));
  const reviewDispatchBody = {
    dispatchId: `dispatch-${reviewWorkItemId}`,
    workItemId: reviewWorkItemId,
    logicalAssignmentId,
    reviewAssignmentId,
    attemptId,
    authorityBaseRef: reviewAuthorityBaseRef,
    agentExecutionKind: 'structured_session' as const,
    sessionKind: 'review_content_batch' as const,
    grantInstanceRef: null,
    inputArtifactDeliveryId: null,
    scopeDecisionReason: null,
  };
  const reviewDispatchRef = await put('assignment_dispatch', { ...reviewDispatchBody, dispatchDigest: sha(reviewDispatchBody) });

  /* ---- content review settlement aggregate (pre-seal condition 9) ---- */
  const contentSettlementEnvelopeRef = await put('validator_input_envelope', {
    trigger: 'review_settlement',
    taskId: TASK,
    templateSnapshotHash: TEMPLATE_HASH,
    contentReviewCoverageCoreRef: coverageCoreRef,
    selectedTargetRefs: [],
  });
  const contentSettlementWarningRef = await put('validation_warning_root', selfDigest({
    trigger: 'review_settlement',
    executionPhase: null,
    inputRef: contentSettlementEnvelopeRef,
    inputDigest: contentSettlementEnvelopeRef.digest,
    orderedAdvisoryReceiptRefs: [],
    warningCount: 0,
    rootDigest: '',
  }, 'rootDigest'));
  const contentSettlementAggregateRef = await put('validator_aggregate', selfDigest({
    trigger: 'review_settlement',
    executionPhase: null,
    inputRef: contentSettlementEnvelopeRef,
    inputDigest: contentSettlementEnvelopeRef.digest,
    registrationSetDigest: H('content-set-reg'),
    validExecutionDigests: [H('content-set-valid')],
    blockingInvalidReceiptRefs: [],
    advisoryReceiptRefs: [],
    infrastructureFailureRefs: [],
    warningRootRef: contentSettlementWarningRef,
    outcome: 'clear',
    aggregateDigest: '',
  }, 'aggregateDigest'));

  /* ---- ReviewBundle + seal authority base ---- */
  const reviewWarningCustodyRootRef = await put('validation_warning_custody_root', selfDigest({
    scope: 'content_review',
    taskId: TASK,
    baseRefs: [contentSettlementEnvelopeRef],
    entries: [],
    supersessionPolicyVersion: '1',
    rootDigest: '',
  }, 'rootDigest'));
  const settlementCoreRef = await put('content_review_settlement_core', selfDigest({
    coverageCoreRef,
    reviewSettlementValidatorAggregateRef: contentSettlementAggregateRef,
    coreDigest: '',
  }, 'coreDigest'));
  const reviewBundleBody = selfDigest({
    settlementCoreRef,
    mapRef: mapSnapshotRef,
    contentRevisionManifestRef: finalizedManifestRef,
    reviewWarningCustodyRootRef,
    bundleDigest: '',
  }, 'bundleDigest');
  const reviewBundleRef = await put('review_bundle', reviewBundleBody);

  const sealBase = buildAuthorityBaseSet({
    taskId: TASK,
    templateSnapshotRef,
    profileSnapshotRef,
    refs: {
      mapRef: mapSnapshotRef,
      mapReviewBundleRef,
      contentRevisionManifestRef: finalizedManifestRef,
      reviewBundleRef,
    },
    kind: 'system_seal',
  });
  const sealAuthorityBaseRef = await put('authority_base_set', sealBase);

  /* ---- map build chain blobs (candidate + build spec + contribution) ---- */
  const mapBuildSpecBody = {
    mapBuildId: 'build-1',
    revision: 1,
    supersedesMapBuildId: null,
    sourceValidationReceiptRef: null,
    snapshotHash: TEMPLATE_HASH,
    plannedChunkPolicy: { maxChunks: 8, maxNodesPerChunk: 512, maxRelationsPerChunk: 64 },
  };
  const mapBuildSpecRef = await put('map_build_spec', { ...mapBuildSpecBody, specDigest: sha(mapBuildSpecBody) });
  const contributionBody = {
    contributionManifestId: 'cm-1',
    producerKind: 'map_build' as const,
    planId: 'build-1',
    planRevision: 1,
    orderedChunkOrBatchRefs: [] as BlobRefV2[],
    stagingRootRef: null,
    keyLedgerRefs: [] as BlobRefV2[],
    agentAttemptIdentities: [],
  };
  const contributionRef = await put('contribution_manifest', { ...contributionBody, manifestDigest: sha(contributionBody) });
  const candidateValidationCoreRef = await put('map_candidate_validation_core', selfDigest({
    candidateId: 'candidate-1',
    baseMapId: null,
    positionGraphDigest: H('position'),
    relationGraphDigest: H('relation-graph'),
    templateSnapshotHash: TEMPLATE_HASH,
    nodes,
    relations: [],
    candidateProvenanceWithoutValidation: {
      producerKind: 'system_map_finalize' as const,
      producerWorkItemId: 'wi-map-finalize',
      commandId: 'cmd-map-finalize',
      mapBuildId: 'build-1',
      mapBuildRevision: 1,
      contributionManifestRef: contributionRef,
    },
    coreDigest: '',
  }, 'coreDigest'));
  const candidateEnvelopeRef = await put('validator_input_envelope', {
    trigger: 'map_candidate_commit',
    taskId: TASK,
    templateSnapshotHash: TEMPLATE_HASH,
    mapCandidateValidationCoreRef: candidateValidationCoreRef,
    selectedTargetRefs: [],
  });
  const candidateAggregateRef = await put('validator_aggregate', selfDigest({
    trigger: 'map_candidate_commit',
    executionPhase: null,
    inputRef: candidateEnvelopeRef,
    inputDigest: candidateEnvelopeRef.digest,
    registrationSetDigest: H('candidate-reg'),
    validExecutionDigests: [H('candidate-valid')],
    blockingInvalidReceiptRefs: [],
    advisoryReceiptRefs: [],
    infrastructureFailureRefs: [],
    warningRootRef: refOfBlob('validation_warning_root', { label: 'candidate-warn' }),
    outcome: 'clear',
    aggregateDigest: '',
  }, 'aggregateDigest'));
  const candidateWarningCustodyRootRef = await put('validation_warning_custody_root', selfDigest({
    scope: 'map_candidate',
    taskId: TASK,
    baseRefs: [candidateValidationCoreRef],
    entries: [],
    supersessionPolicyVersion: '1',
    rootDigest: '',
  }, 'rootDigest'));
  const candidateRef = await put('map_candidate', selfDigest({
    candidateId: 'candidate-1',
    baseMapId: null,
    validationCoreRef: candidateValidationCoreRef,
    candidateValidationAggregateRef: candidateAggregateRef,
    candidateWarningCustodyRootRef,
    createdAt: env.now.value,
    candidateDigest: '',
  }, 'candidateDigest'));

  /* ---- seed events: map build -> activation -> manifests -> settled round ---- */
  const seedEvents = [
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_build_started' as const, mapBuildId: 'build-1', revision: 1,
      mapBuildSpecRef, supersedesMapBuildId: null, sourceValidationReceiptRef: null,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_build_finish_proposed' as const, mapBuildId: 'build-1',
      expectedChunkCount: 1, expectedFrontierDigest: H('frontier'), expectedRootCount: 1,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_build_finalized' as const, mapBuildId: 'build-1',
      manifestRef: contributionRef, contributionManifestRef: contributionRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_candidate_committed' as const, candidateId: 'candidate-1',
      candidateRef, candidateDigest: candidateRef.digest, baseMapId: null,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_map_activated' as const, mapId: 'map-1', mapRevision: 1,
      supersedesMapId: null, mapSnapshotRef, mapReviewBundleRef,
      mapSemanticDigest: MAP_SEMANTIC, contentRevisionManifestRef: baselineRef,
      activationValidatorAggregateRef: candidateAggregateRef, migrationSettlementCoreRef: null, migrationActivationDecisionRef: null,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_content_revision_committed' as const, contentRevisionManifestRef: baselineRef,
      taskContentRevision: 1, manifestPhase: 'baseline_unset', producerPlanSpecRef: null, priorManifestRef: null,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_content_revision_committed' as const, contentRevisionManifestRef: finalizedManifestRef,
      taskContentRevision: 2, manifestPhase: 'finalized', producerPlanSpecRef: null, priorManifestRef: baselineRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_review_round_planned' as const, reviewRoundId: ROUND_ID,
      contentCycleOrdinal: 1, mapRef: mapSnapshotRef, mapSemanticDigest: MAP_SEMANTIC,
      contentRevisionManifestRef: finalizedManifestRef, reviewPolicyDigest: H('review-policy'),
      adoptionRootRef, coverageSlotCount: CONTENT_SLOTS.length, coverageRelationCount: 0,
      assignmentCount: 1, verificationFindingCount: 0, consumedOverrideRef: null,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_work_item_created' as const, workItemId: reviewWorkItemId,
      kind: 'agent_assignment', roleBinding: 'reviewer', agentExecutionKind: 'structured_session', sessionKind: 'review_content_batch',
      roundId: ROUND_ID, logicalAssignmentId, reviewAssignmentId, grantSpecRef: reviewGrantSpecRef,
      inputArtifactDeliveryId: null, authorityBaseRef: reviewAuthorityBaseRef, payloadRef: coverageCoreRef,
      initialLeaseEpoch: 0, maxAutomaticRetries: 3,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_work_item_leased' as const, workItemId: reviewWorkItemId,
      leaseEpoch: 1, leaseOwner: 'reviewer-content', leaseExpiresAt: '2026-08-14T10:30:00.000Z', expectedLastSequence: 0,
      authorityBaseRef: reviewAuthorityBaseRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_assignment_dispatched' as const, dispatchRef: reviewDispatchRef,
      workItemId: reviewWorkItemId, attemptId, logicalAssignmentId, reviewAssignmentId,
      agentExecutionKind: 'structured_session', sessionKind: 'review_content_batch', inputArtifactDeliveryId: null,
      authorityBaseRef: reviewAuthorityBaseRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_agent_attempt_started_v2' as const, workItemId: reviewWorkItemId,
      logicalAssignmentId, reviewAssignmentId, attemptId, sessionKind: 'review_content_batch', leaseEpoch: 1,
      authorityBaseRef: reviewAuthorityBaseRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_review_assignment_started' as const, assignmentId: 'assign-content-1',
      reviewRoundId: ROUND_ID, workItemId: reviewWorkItemId, attemptId, reviewAssignmentId, source: 'batch',
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_content_review_assignment_committed' as const, assignmentId: 'assign-content-1',
      reviewRoundId: ROUND_ID, workItemId: reviewWorkItemId, attemptId, reviewAssignmentId, source: 'batch',
      ledgerRef, coverageTargetCount: CONTENT_SLOTS.length, findingCount: 0,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_review_assignment_completed' as const, assignmentId: 'assign-content-1',
      reviewRoundId: ROUND_ID, workItemId: reviewWorkItemId, attemptId, ledgerRef, source: 'batch',
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_agent_attempt_completed_v2' as const, workItemId: reviewWorkItemId,
      logicalAssignmentId, reviewAssignmentId, attemptId, sessionKind: 'review_content_batch', leaseEpoch: 1,
      authorityBaseRef: reviewAuthorityBaseRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_work_item_completed' as const, workItemId: reviewWorkItemId,
      leaseEpoch: 1, authorityBaseRef: reviewAuthorityBaseRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_review_round_completed' as const, reviewRoundId: ROUND_ID,
      coverageCoreRef,
    },
    {
      protocolVersion: 2, at: env.now.value, type: 'structured_review_round_settled' as const, reviewRoundId: ROUND_ID,
      settlementCoreRef, outcome: 'seal',
    },
  ];
  const validatedSeedEvents = seedEvents.map((event, index) => validateAuthoritativeReviewEventV2({
    ...event,
    id: `evt-seal-seed-${index}`,
  }));
  const seedHold = await env.publicationStore.lock().acquire();
  try {
    await env.eventStore.appendBatch(TASK, 'seed-seal-authority', validatedSeedEvents, {
      expectedLastSequence: 0,
      fenceProof: await seedHold.proof(),
    });
  } finally {
    await seedHold.release();
  }

  /* ---- the committed system_seal WorkItem (ready) ---- */
  const sealWorkItemId = 'wi-seal-production';
  await env.coordinator.createWorkItem({
    taskId: TASK,
    operationId: '11111111-1111-4111-8111-111111111111',
    workItemId: sealWorkItemId,
    kind: 'system_seal',
    roleBinding: null,
    agentExecutionKind: null,
    sessionKind: null,
    logicalAssignmentId: null,
    reviewAssignmentId: null,
    inputArtifactDeliveryId: null,
    payload: { kind: 'review_bundle', value: reviewBundleBody },
    authorityBase: sealBase,
    maxAutomaticRetries: 3,
  });

  return {
    env,
    mapSnapshotRef,
    finalizedManifestRef,
    reviewBundleRef,
    sealAuthorityBaseRef,
    sealWorkItemId,
    coverageCoreRef,
    profileSnapshotRef,
    templateSnapshotRef,
  };
}

function idleScheduling(): import('../task-scheduler').AuthoritativeV2SchedulingEngine {
  return {
    async runPass(): Promise<V2SchedulingPassResult> {
      return {
        scanned: 1, reclaimed: [], requeued: [], leased: [], blocked: [], skipped: [], wakeupRemoved: [], corrupt: [],
      };
    },
  } as unknown as import('../task-scheduler').AuthoritativeV2SchedulingEngine;
}

function installComposition(fixture: SealFixture) {
  const { env } = fixture;
  const artifacts = new ArtifactStore(env.paths, env.eventStore, (taskId, ref) => env.blobStore.readJson(taskId, ref, ref.kind));
  const wakeups = new AuthoritativeWakeupIndexV1({ paths: env.paths });
  const traces = new TraceStore(env.paths);
  const runner = new V2AssignmentRunner({
    runtime: new FakeAgentRuntime(),
    toolProvider: { async toolsFor() { return []; }, async collectResultRefs() { return []; } },
  });
  return installAuthoritativeReviewRuntime({
    coordinator: env.coordinator,
    facade: env.facade,
    blobStore: env.blobStore,
    wakeups,
    artifacts,
    scheduling: idleScheduling(),
    readProjection: (taskId) => env.readProjection(taskId),
    resolver: (taskId, ref) => env.blobStore.readJson(taskId, ref, ref.kind),
    frozenProfile: async () => ({
      profileSnapshotRef: fixture.profileSnapshotRef,
      templateSnapshotRef: fixture.templateSnapshotRef,
      profileDigest: H('seal-profile-digest'),
      snapshotHash: TEMPLATE_HASH,
    }),
    frozenTemplate: async () => frozenV2,
    profileBody: async () => buildAuthoritativeReviewTestProfileBody(),
    frozenAutomaticRetries: async () => 3,
    eligibility: () => ({
      state: 'eligible',
      frozenProfileDigest: H('seal-profile-digest'),
      currentProfileDigest: H('seal-profile-digest'),
    }),
    runner,
    clock: () => env.now.value,
    traces,
    eventStore: env.eventStore,
    publicationStore: env.publicationStore,
  });
}

async function committedEvents(env: WorkItemCoordinatorEnvironment): Promise<Array<Record<string, unknown>>> {
  return (await env.eventStore.read(TASK)).map((entry) => entry.event as unknown as Record<string, unknown>);
}

describe('Task 21 P1#1 production System Seal execution through the real registry', () => {
  it('leases and executes a committed system_seal WorkItem through the AttemptCoordinator to completion', async () => {
    const fixture = await prepareSealFixture();
    const { env, sealWorkItemId, sealAuthorityBaseRef, reviewBundleRef } = fixture;
    const composition = installComposition(fixture);

    // Before execution: the registry must carry the REAL seal handler, not the
    // default NOT_IMPLEMENTED double.
    expect(composition.systemCommands.resolve('seal')).not.toBeNull();
    expect(composition.systemCommands.resolve('seal')!.commandKind).toBe('seal');
    expect((await committedEvents(env)).some((event) => event.type === 'structured_work_item_created' && event.workItemId === sealWorkItemId)).toBe(true);

    const before = await env.readProjection(TASK);
    expect(before.workItems[sealWorkItemId]?.state).toBe('ready');
    expect(before.currentSeal).toBeNull();

    // Drive through the real coordinator + registry (the §10.2 runNext claim).
    const outcome = await composition.attempts.runNext(TASK, 'task_owner');
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'completed', workItemId: sealWorkItemId });
    // The completion REPLAYS the publish batch (same operation id) — proves the
    // terminal envelope committed exactly once with no double terminal.
    if (outcome.kind === 'completed') {
      expect(outcome.replayed).toBe(true);
      expect(outcome.commandId).not.toBeNull();
    }

    const events = await committedEvents(env);
    const types = events.map((event) => event.type);
    // The six-event seal envelope is committed exactly once.
    expect(types.filter((type) => type === 'structured_scaffold_sealed_v2')).toHaveLength(1);
    expect(types.filter((type) => type === 'artifact_published_v2')).toHaveLength(1);
    expect(types.filter((type) => type === 'structured_system_artifact_delivery_created')).toHaveLength(1);
    expect(types.filter((type) => type === 'structured_system_command_completed')).toHaveLength(1);
    // One work-item terminal for the review seed + one for the seal.
    expect(types.filter((type) => type === 'structured_work_item_completed')).toHaveLength(2);
    // Three creations: the review seed + the seal WorkItem + the submitter.
    expect(types.filter((type) => type === 'structured_work_item_created')).toHaveLength(3);

    const sealEvent = events.find((event) => event.type === 'structured_scaffold_sealed_v2')!;
    expect(sealEvent.sealWorkItemId).toBe(sealWorkItemId);
    expect(sealEvent).toMatchObject({ sealWorkItemId, mapRef: fixture.mapSnapshotRef, contentRevisionManifestRef: fixture.finalizedManifestRef, reviewBundleRef });

    const published = events.find((event) => event.type === 'artifact_published_v2')!;
    expect(typeof published.artifactVersion).toBe('number');
    expect(published.artifactVersion).toBe(1); // no v1 publication preceded
    expect(published.deliveryRef).toBeDefined();

    const deliveryEvent = events.find((event) => event.type === 'structured_system_artifact_delivery_created')!;
    const submitterEvent = events.find((event) => event.type === 'structured_work_item_created'
      && event.workItemId === deterministicSubmitterWorkItemId(TASK))!;
    expect(submitterEvent).toBeDefined();
    expect(submitterEvent.kind).toBe('agent_assignment');
    expect(submitterEvent.agentExecutionKind).toBe('generic_turn');
    expect(submitterEvent.inputArtifactDeliveryId).toBe(deliveryEvent.deliveryId);
    // The submitter's authority base is the SEAL authority base (the publish
    // passes submitterAuthorityBaseRef = the seal command's base), and its
    // payload IS the delivery.
    expect(submitterEvent.authorityBaseRef).toEqual(sealAuthorityBaseRef);
    expect(submitterEvent.payloadRef).toEqual(deliveryEvent.deliveryRef);
    expect(submitterEvent.roleBinding).toBe('submitter');

    // The projection reflects the seal.
    const after = await env.readProjection(TASK);
    expect(after.workItems[sealWorkItemId]?.state).toBe('completed');
    expect(after.currentSeal).not.toBeNull();
    expect(after.currentSeal?.sealRecordRef).toEqual(sealEvent.sealRecordRef);
    // The submitter WorkItem is READY and delivery-bound.
    const submitterId = deterministicSubmitterWorkItemId(TASK);
    expect(after.workItems[submitterId]).toMatchObject({ state: 'ready', kind: 'agent_assignment', inputArtifactDeliveryId: deliveryEvent.deliveryId });

    // Response-loss / restart idempotency: a restarted execution of the SAME
    // seal command fails closed (the terminal already committed) — it can never
    // double-seal.
    const restartCtx = {
      taskId: TASK,
      commandId: outcome.kind === 'completed' ? (outcome.commandId as string) : 'cmd-stale',
      workItemId: sealWorkItemId,
      commandKind: 'seal' as const,
      leaseEpoch: 1,
      authorityBaseRef: sealAuthorityBaseRef,
      payloadRef: reviewBundleRef,
    };
    const redrive = await composition.sealCommandHandler.execute(restartCtx as never);
    expect(redrive.kind).toBe('retryable_failure');
    if (redrive.kind === 'retryable_failure') {
      expect(redrive.failureCode.startsWith('SEAL_AUTHORITY:')).toBe(true);
    }
  }, 60_000);

  it('leaves the same operationId + payload result byte-identical on retransmission (facade replay)', async () => {
    const fixture = await prepareSealFixture();
    const { env, sealWorkItemId, sealAuthorityBaseRef, reviewBundleRef } = fixture;
    // Record the exact seal_publish publication the composition issued, then
    // re-issue it: the facade must REPLAY the original commit (same operationId
    // + same payload -> same result, no new events).
    const publishInputs: Array<Record<string, unknown>> = [];
    const recordingFacade = new Proxy(env.facade, {
      get(target, prop) {
        if (prop === 'publishWithPin') {
          return async (input: { intent?: { handlerKind?: string } }) => {
            if (input.intent?.handlerKind === 'system_seal_publish') {
              publishInputs.push(input as unknown as Record<string, unknown>);
            }
            return (target as never as Record<string, Function>).publishWithPin.call(target, input);
          };
        }
        const value = (target as never as Record<string | symbol, unknown>)[prop as string];
        return typeof value === 'function' ? (value as Function).bind(target) : value;
      },
    });
    const artifacts = new ArtifactStore(env.paths, env.eventStore, (taskId, ref) => env.blobStore.readJson(taskId, ref, ref.kind));
    const composition = installAuthoritativeReviewRuntime({
      coordinator: env.coordinator,
      facade: recordingFacade as never,
      blobStore: env.blobStore,
      wakeups: new AuthoritativeWakeupIndexV1({ paths: env.paths }),
      artifacts,
      scheduling: idleScheduling(),
      readProjection: (taskId) => env.readProjection(taskId),
      resolver: (taskId, ref) => env.blobStore.readJson(taskId, ref, ref.kind),
      frozenProfile: async () => ({
        profileSnapshotRef: fixture.profileSnapshotRef,
        templateSnapshotRef: fixture.templateSnapshotRef,
        profileDigest: H('seal-profile-digest'),
        snapshotHash: TEMPLATE_HASH,
      }),
      frozenTemplate: async () => frozenV2,
      profileBody: async () => buildAuthoritativeReviewTestProfileBody(),
      frozenAutomaticRetries: async () => 3,
      eligibility: () => ({ state: 'eligible', frozenProfileDigest: H('seal-profile-digest'), currentProfileDigest: H('seal-profile-digest') }),
      runner: new V2AssignmentRunner({ runtime: new FakeAgentRuntime(), toolProvider: { async toolsFor() { return []; }, async collectResultRefs() { return []; } } }),
      clock: () => env.now.value,
      traces: new TraceStore(env.paths),
      eventStore: env.eventStore,
      publicationStore: env.publicationStore,
    });

    const outcome = await composition.attempts.runNext(TASK, 'task_owner');
    expect(outcome).toMatchObject({ kind: 'completed' });
    expect(publishInputs).toHaveLength(1);
    if (outcome.kind !== 'completed' || publishInputs[0] === undefined) {
      throw new Error(`seal did not complete: ${JSON.stringify(outcome)}`);
    }

    const eventsBefore = (await committedEvents(env)).length;
    const replayed = await env.facade.publishWithPin(publishInputs[0] as never);
    const replayEvent = replayed.events.find((entry) => entry.event.type === 'artifact_published_v2')?.event as
      | Extract<import('../../storage/authoritative-review-events').AuthoritativeReviewEventV2, { type: 'artifact_published_v2' }>
      | undefined;
    expect(replayEvent).toBeDefined();
    // Same operationId + same payload -> byte-identical result, nothing new.
    expect((await committedEvents(env)).length).toBe(eventsBefore);
    expect(replayEvent!.artifactVersion).toBe(1);

    // The re-transmitted publication's operationId is the coordinator's
    // completion id (proves the terminal batch is committed exactly once).
    expect(publishInputs[0].operationId).toBe(
      attemptContinuationOperationId(TASK, sealWorkItemId, outcome.commandId as string, 'complete'),
    );
    void sealAuthorityBaseRef;
    void reviewBundleRef;
  }, 60_000);

  it('drives the scheduling tick (pass + executeLeased) to completion for a freshly leased seal', async () => {
    const fixture = await prepareSealFixture();
    const { env, sealWorkItemId } = fixture;

    // The scheduling pass leases the ready seal WorkItem through the REAL
    // coordinator, then the tick executes it.
    const leasingScheduling = {
      async runPass(): Promise<V2SchedulingPassResult> {
        const leased = await env.coordinator.leaseNext(TASK, 'task_owner', 'tick-lease-op');
        if (leased === null) {
          return { scanned: 1, reclaimed: [], requeued: [], leased: [], blocked: [], skipped: [], wakeupRemoved: [], corrupt: [] };
        }
        await new AuthoritativeWakeupIndexV1({ paths: env.paths }).upsert(TASK, {
          kind: 'lease_expiry', at: leased.wakeup.at, dormant: false, workItemId: leased.workItemId, operationId: 'tick-lease-op', eligibilityBlocked: false,
        });
        return { scanned: 1, reclaimed: [], requeued: [], leased: [{ taskId: TASK, workItemId: leased.workItemId }], blocked: [], skipped: [], wakeupRemoved: [], corrupt: [] };
      },
    } as unknown as import('../task-scheduler').AuthoritativeV2SchedulingEngine;
    const tickComposition = installAuthoritativeReviewRuntime({
      coordinator: env.coordinator,
      facade: env.facade,
      blobStore: env.blobStore,
      wakeups: new AuthoritativeWakeupIndexV1({ paths: env.paths }),
      artifacts: new ArtifactStore(env.paths, env.eventStore, (taskId, ref) => env.blobStore.readJson(taskId, ref, ref.kind)),
      scheduling: leasingScheduling,
      readProjection: (taskId) => env.readProjection(taskId),
      resolver: (taskId, ref) => env.blobStore.readJson(taskId, ref, ref.kind),
      frozenProfile: async () => ({
        profileSnapshotRef: fixture.profileSnapshotRef,
        templateSnapshotRef: fixture.templateSnapshotRef,
        profileDigest: H('seal-profile-digest'),
        snapshotHash: TEMPLATE_HASH,
      }),
      frozenTemplate: async () => frozenV2,
    profileBody: async () => buildAuthoritativeReviewTestProfileBody(),
      frozenAutomaticRetries: async () => 3,
      eligibility: () => ({ state: 'eligible', frozenProfileDigest: H('seal-profile-digest'), currentProfileDigest: H('seal-profile-digest') }),
      runner: new V2AssignmentRunner({ runtime: new FakeAgentRuntime(), toolProvider: { async toolsFor() { return []; }, async collectResultRefs() { return []; } } }),
      clock: () => env.now.value,
      eventStore: env.eventStore,
      publicationStore: env.publicationStore,
    });

    const tick = await tickComposition.runTick();
    expect(tick.outcomes).toHaveLength(1);
    expect(tick.outcomes[0]).toMatchObject({ kind: 'completed', workItemId: sealWorkItemId });
    const events = await committedEvents(env);
    expect(events.filter((event) => event.type === 'structured_scaffold_sealed_v2')).toHaveLength(1);
    // The tick's scheduling pass already claimed the ONLY work item; the seal
    // WorkItem is completed so no SECOND seal is ever driven by a further tick.
    expect(events.filter((event) => event.type === 'structured_scaffold_sealed_v2')).toHaveLength(1);
  }, 60_000);

  it('is installed but idle when the capability is not eligible (no lease, no execution)', async () => {
    const fixture = await prepareSealFixture();
    const { env, sealWorkItemId } = fixture;
    const blockedComposition = installAuthoritativeReviewRuntime({
      coordinator: env.coordinator,
      facade: env.facade,
      blobStore: env.blobStore,
      wakeups: new AuthoritativeWakeupIndexV1({ paths: env.paths }),
      artifacts: new ArtifactStore(env.paths, env.eventStore, (taskId, ref) => env.blobStore.readJson(taskId, ref, ref.kind)),
      scheduling: {
        async runPass(): Promise<V2SchedulingPassResult> {
          // The eligibility gate blocks every task: nothing is leased.
          return { scanned: 1, reclaimed: [], requeued: [], leased: [], blocked: [TASK], skipped: [], wakeupRemoved: [], corrupt: [] };
        },
      } as unknown as import('../task-scheduler').AuthoritativeV2SchedulingEngine,
      readProjection: (taskId) => env.readProjection(taskId),
      resolver: (taskId, ref) => env.blobStore.readJson(taskId, ref, ref.kind),
      frozenProfile: async () => ({
        profileSnapshotRef: fixture.profileSnapshotRef,
        templateSnapshotRef: fixture.templateSnapshotRef,
        profileDigest: H('seal-profile-digest'),
        snapshotHash: TEMPLATE_HASH,
      }),
      frozenTemplate: async () => frozenV2,
    profileBody: async () => buildAuthoritativeReviewTestProfileBody(),
      frozenAutomaticRetries: async () => 3,
      eligibility: () => ({ state: 'blocked', reason: 'authoritative_capability_disabled', frozenProfileDigest: H('seal-profile-digest'), currentProfileDigest: null }),
      runner: new V2AssignmentRunner({ runtime: new FakeAgentRuntime(), toolProvider: { async toolsFor() { return []; }, async collectResultRefs() { return []; } } }),
      clock: () => env.now.value,
      eventStore: env.eventStore,
      publicationStore: env.publicationStore,
    });

    const tick = await blockedComposition.runTick();
    expect(tick.outcomes).toEqual([]);
    const after = await env.readProjection(TASK);
    expect(after.workItems[sealWorkItemId]?.state).toBe('ready');
    expect(after.currentSeal).toBeNull();
    // The registry is installed (seal resolves) but nothing was executed.
    expect(blockedComposition.systemCommands.resolve('seal')).not.toBeNull();
    expect((await committedEvents(env)).some((event) => event.type === 'structured_scaffold_sealed_v2')).toBe(false);
  }, 60_000);
});
