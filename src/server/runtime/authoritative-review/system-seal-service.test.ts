/**
 * Task 21 tests: the Seal service consumes the PURE system-derived gate
 * (`seal-authority-resolver.ts` + `evaluateSealGate`) — never a caller boolean
 * summary. Hostile tests here are real resolved worlds: internally self-
 * consistent alias blobs whose pointers are OLD/UNRELATED authority must land
 * on the exact frozen `sealConditionCodes`, in stable order. P2#8 asserts the
 * SealValidationBundle warning custody is built from seal_input advisory
 * custody (seal_output stays empty) and survives SealRecord -> bundle replay.
 */
import { describe, expect, it, vi } from 'vitest';

import type { BlobRefV2, SealRecordV2 } from '../../../shared/authoritative-review-v2';
import { AssemblerRegistryV2, ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION } from './assembler-registry';
import { zhihuAssemblerFixture } from './builtin-assemblers/zhihu-chapter-v1.test';
import { parseBlob } from '../../authoritative-review/object-registry';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { sealConditionCodes, evaluateSealGate, type SealGateInputV2 } from '../../authoritative-review/seal-gate';
import type {
  SealValidationBundleV2,
  ValidationWarningCustodyRootV2,
  ValidationWarningRootV2,
  ValidatorAggregateV2,
} from '../../authoritative-review/authority-types';
import { buildAuthorityBaseSet } from './authority-base';
import {
  SystemSealServiceV2,
  buildSealWarningCustodyRoot,
  sealPublishOperationId,
  createArtifactStoreSystemSealPublisher,
  createSystemSealCommandHandler,
  type SealValidatorRunV2,
  type SystemSealServiceDependenciesV2,
} from './system-seal-service';
import {
  createSystemSealAuthorityResolver,
  type SealAuthorityResolverDependenciesV2,
  type SealAuthorityResolverV2,
  type SealProjectionViewV2,
} from './seal-authority-resolver';

/* ------------------------------------------------------------------ */
/* primitives                                                         */
/* ------------------------------------------------------------------ */

const TASK = 'task';
const ROUND_ID = 'round-1';
const TEMPLATE_HASH = 'template';
const CUR_MAP_DIGEST = '1'.repeat(64);
const CONTENT_ROOT = 'c'.repeat(64);
/** strictly-sorted content slot ids (manifest entries must be sorted). */
const CONTENT_SLOTS = ['closure', 'end', 'opening', 'scene', 'title'];
/** optional-unset slot exercised by the condition-4 fail-closed path. */
const UNSET_SLOT = 'end';
/** required-set slot covered ONLY by adoption (no committed fact). */
const ADOPTED_SLOT = 'adopted-slot';

const sha = (value: unknown): string => canonicalJsonSha256(value);
const seedDigest = (seed: string): string => sha({ seed }).slice(0, 64);
const r = (kind: BlobRefV2['kind'], digest: string): BlobRefV2 => ({
  kind,
  digest,
  byteLength: 1,
  mediaType: 'application/json',
  schemaVersion: 1,
});
const byDigest = (a: BlobRefV2, b: BlobRefV2): number => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0);
const selfDigest = (obj: Record<string, unknown>, field: string): string => {
  const { [field]: _omit, ...rest } = obj;
  return canonicalJsonSha256(rest);
};
const withSelfDigest = <T extends Record<string, unknown>>(body: T, field: string): T => ({
  ...body,
  [field]: selfDigest(body, field),
});
const clone = <T>(value: T): T => structuredClone(value) as T;

interface SealWorldConfig {
  staleReviewManifest?: boolean;
  staleReviewMap?: boolean;
  noMapReviewBundle?: boolean;
  missingSlotFact?: string;
  violatedRelation?: boolean;
  /** active Map carries a blocking relation with NO committed fact at all. */
  blockingRelationNoFact?: boolean;
  /** finalized manifest contains an optional-unset slot (absence fact unprovable). */
  optionalUnsetSlot?: boolean;
  /** a required-set slot covered ONLY by adoption (no committed fact). */
  adoptedCoverageSlot?: boolean;
  unsettledContentRound?: boolean;
  openBlockingFinding?: boolean;
  pendingContentRound?: boolean;
  activeRepairWorkItem?: boolean;
  blockingSettlementAggregate?: boolean;
  staleSettlementClosure?: boolean;
  staleTemplate?: boolean;
  currentSealPresent?: boolean;
  wrongSealWorkItemKind?: boolean;
  sealInputAdvisory?: boolean;
}

interface SealWorldRefs {
  templateSnapshotRef: BlobRefV2;
  profileSnapshotRef: BlobRefV2;
  mapRef: BlobRefV2;
  mapReviewBundleRef: BlobRefV2;
  baseManifestRef: BlobRefV2;
  reviewBundleRef: BlobRefV2;
  sealAuthorityBaseRef: BlobRefV2;
  sealInputAggregateRef: BlobRefV2;
  sealInputWarningRootRef: BlobRefV2;
  coverageCoreRef: BlobRefV2;
}

interface SealWorld {
  store: Map<string, unknown>;
  projection: SealProjectionViewV2;
  refs: SealWorldRefs;
  sealContext: {
    taskId: string;
    commandId: string;
    sealWorkItemId: string;
    sealLeaseEpoch: number;
    sealAuthorityBaseRef: BlobRefV2;
    payloadRef: BlobRefV2;
  };
  put(kind: Parameters<typeof parseBlob>[0], value: unknown): BlobRefV2;
  resolveBlob(taskId: string, ref: BlobRefV2): Promise<unknown>;
  readProjection(): Promise<SealProjectionViewV2>;
}

function mkFact(slotId: string, verdict: string): Record<string, unknown> {
  return {
    factId: `fact-${slotId}`,
    targetKind: 'content_slot',
    targetStableId: slotId,
    verdict,
    factOrigin: { kind: 'batch', adoptionEligible: true },
    adoptionEligible: true,
    localSubjectDigest: seedDigest(`subject-${slotId}`),
    localContextDigest: seedDigest(`context-${slotId}`),
    reviewPolicyDigest: seedDigest('policy'),
    findingIds: [],
    evidence: [],
    reviewerAttemptId: 'attempt-1',
    recordedAt: 't',
  };
}

function mkRelationFact(relationId: string, verdict: string): Record<string, unknown> {
  return {
    factId: `fact-${relationId}`,
    targetKind: 'content_relation',
    targetStableId: relationId,
    verdict,
    factOrigin: { kind: 'batch', adoptionEligible: true },
    adoptionEligible: true,
    localSubjectDigest: seedDigest(`rel-subject-${relationId}`),
    localContextDigest: seedDigest(`rel-context-${relationId}`),
    reviewPolicyDigest: seedDigest('policy'),
    findingIds: [],
    evidence: [],
    reviewerAttemptId: 'attempt-1',
    recordedAt: 't',
  };
}

function mkEnvelope(trigger: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { trigger, taskId: TASK, templateSnapshotHash: TEMPLATE_HASH, ...extra, selectedTargetRefs: [] };
}

function mkAggregate(o: {
  trigger: string;
  inputRef: BlobRefV2;
  advisory?: BlobRefV2[];
  blocking?: BlobRefV2[];
  infra?: BlobRefV2[];
  warningRootRef: BlobRefV2;
}): ValidatorAggregateV2 {
  const blocking = [...(o.blocking ?? [])].sort(byDigest);
  const advisory = [...(o.advisory ?? [])].sort(byDigest);
  const infra = [...(o.infra ?? [])].sort(byDigest);
  const outcome: ValidatorAggregateV2['outcome'] = infra.length > 0 ? 'infrastructure_failure' : blocking.length > 0 ? 'blocking_invalid' : 'clear';
  const body = {
    trigger: o.trigger,
    executionPhase: null,
    inputRef: o.inputRef,
    inputDigest: o.inputRef.digest,
    registrationSetDigest: seedDigest(`reg:${o.trigger}`),
    validExecutionDigests: [],
    blockingInvalidReceiptRefs: blocking,
    advisoryReceiptRefs: advisory,
    infrastructureFailureRefs: infra,
    warningRootRef: o.warningRootRef,
    aggregateDigest: '',
    outcome,
  };
  return withSelfDigest(body, 'aggregateDigest') as unknown as ValidatorAggregateV2;
}

function buildSealWorld(cfg: SealWorldConfig = {}): SealWorld {
  const store = new Map<string, unknown>();
  const refs = {} as SealWorldRefs;
  const put = (kind: Parameters<typeof parseBlob>[0], value: unknown): BlobRefV2 => {
    const { ref } = parseBlob(kind, value);
    store.set(`${ref.kind}:${ref.digest}`, value);
    return ref;
  };
  const resolveBlob = async (_taskId: string, ref: BlobRefV2): Promise<unknown> => {
    return store.get(`${ref.kind}:${ref.digest}`) ?? null;
  };
  let projection: SealProjectionViewV2;
  const readProjection: SealWorld['readProjection'] = async () => projection;

  refs.templateSnapshotRef = r('profile_snapshot', seedDigest('template-ref'));
  refs.profileSnapshotRef = r('profile_snapshot', seedDigest('profile-ref'));

  /* ---- Map track federation blobs ---- */
  const proposalCoreRef = r('proposed_map_core', seedDigest('proposed-core'));
  const mapSettlementCoverageCoreRef = r('map_review_coverage_core', seedDigest('map-settlement-coverage-core'));
  const mapWarningCustodyRootRef = r('validation_warning_custody_root', seedDigest('map-warning-custody'));

  const mapSettlementEnvelopeRef = put('validator_input_envelope', mkEnvelope('map_review_settlement', { mapReviewCoverageCoreRef: mapSettlementCoverageCoreRef }));
  const mapSettlementAggregateRef = put('validator_aggregate', mkAggregate({ trigger: 'map_review_settlement', inputRef: mapSettlementEnvelopeRef, warningRootRef: r('validation_warning_root', seedDigest('map-set-warn')) }));
  const mapSettlementCoreRef = put('map_review_settlement_core', withSelfDigest({
    coverageCoreRef: mapSettlementCoverageCoreRef,
    mapReviewSettlementValidatorAggregateRef: mapSettlementAggregateRef,
    coreDigest: '',
  }, 'coreDigest'));

  const mapActivationEnvelopeRef = put('validator_input_envelope', mkEnvelope('map_activation', { mapReviewSettlementCoreRef: mapSettlementCoreRef, proposedMapCoreRef: proposalCoreRef }));
  const mapActivationAggregateRef = put('validator_aggregate', mkAggregate({ trigger: 'map_activation', inputRef: mapActivationEnvelopeRef, warningRootRef: r('validation_warning_root', seedDigest('map-act-warn')) }));

  const mapReviewBundleRef = cfg.noMapReviewBundle
    ? r('map_review_bundle', '0'.repeat(64))
    : put('map_review_bundle', withSelfDigest({
        settlementCoreRef: mapSettlementCoreRef,
        proposedMapCoreRef: proposalCoreRef,
        mapActivationValidatorAggregateRef: mapActivationAggregateRef,
        mapWarningCustodyRootRef,
        bundleDigest: '',
      }, 'bundleDigest'));
  refs.mapReviewBundleRef = mapReviewBundleRef;

  /* ---- active Map snapshot ---- */
  const relations = (cfg.violatedRelation || cfg.blockingRelationNoFact)
    ? [{ relationId: 'rel-1', typeId: 'cross_ref', fromSlotId: 'title', toSlotId: 'opening', attributes: {}, relationDigest: seedDigest('rel-1') }]
    : [];
  const mapSnapshot = {
    scaffoldId: 'scaffold',
    mapId: 'map-1',
    supersedesMapId: null,
    sourceCandidateId: 'candidate-1',
    proposedMapCoreRef: proposalCoreRef,
    mapReviewBundleRef,
    mapRevision: 1,
    mapSemanticDigest: CUR_MAP_DIGEST,
    positionGraphDigest: seedDigest('position'),
    relationGraphDigest: seedDigest('relation-graph'),
    templateSnapshotHash: TEMPLATE_HASH,
    nodes: [
      { slotId: 'root', slotType: 'chapter', contentBearing: false, parentSlotId: null, documentOrder: 0, siblingOrder: 0, nodeSpecDigest: seedDigest('node-root') },
      { slotId: 'title', slotType: 'title', contentBearing: true, parentSlotId: 'root', documentOrder: 0, siblingOrder: 0, nodeSpecDigest: seedDigest('node-title') },
      { slotId: 'opening', slotType: 'opening', contentBearing: true, parentSlotId: 'root', documentOrder: 1, siblingOrder: 1, nodeSpecDigest: seedDigest('node-opening') },
      { slotId: 'scene', slotType: 'scene_block', contentBearing: true, parentSlotId: 'root', documentOrder: 2, siblingOrder: 2, nodeSpecDigest: seedDigest('node-scene') },
      { slotId: 'closure', slotType: 'emotional_closure', contentBearing: true, parentSlotId: 'root', documentOrder: 3, siblingOrder: 3, nodeSpecDigest: seedDigest('node-closure') },
      { slotId: 'end', slotType: 'chapter_end', contentBearing: true, parentSlotId: 'root', documentOrder: 4, siblingOrder: 4, nodeSpecDigest: seedDigest('node-end') },
    ],
    relations,
    activatedAt: 't',
  };
  const mapRef = put('map_snapshot', mapSnapshot);
  refs.mapRef = mapRef;

  /* ---- content versions + content revision manifest (finalized authority) ---- */
  const manifestSlotIds = [...CONTENT_SLOTS];
  if (cfg.adoptedCoverageSlot) manifestSlotIds.push(ADOPTED_SLOT);
  const mkSetVersion = (slotId: string): Record<string, unknown> => {
    const blobRef = r('content_value', seedDigest(`content-${slotId}`));
    return {
      state: 'set',
      slotId,
      slotRevision: 1,
      contentDigest: blobRef.digest,
      taskContentRevision: 1,
      mapRef,
      mapSemanticDigest: CUR_MAP_DIGEST,
      contentSchemaDigest: seedDigest('schema'),
      blobRef,
      provenance: {
        kind: 'generated',
        producer: { kind: 'generation_batch', planRevisionId: 'plan-1', batchOrdinal: 0, attemptId: 'attempt-1' },
        contentRevisionCommitCoreRef: r('content_revision_commit_core', seedDigest(`commit-core-${slotId}`)),
        contentCommitValidatorAggregateRef: r('validator_aggregate', seedDigest(`commit-agg-${slotId}`)),
        contentCommitWarningRootRef: r('validation_warning_custody_root', seedDigest(`commit-warn-${slotId}`)),
        committedByAttemptId: 'attempt-1',
      },
    };
  };
  const versionRefs = new Map<string, BlobRefV2>();
  for (const slotId of manifestSlotIds) {
    const isUnset = cfg.optionalUnsetSlot && slotId === UNSET_SLOT;
    const version = isUnset
      ? { state: 'unset', slotId, slotRevision: 1, taskContentRevision: 1, mapRef, mapSemanticDigest: CUR_MAP_DIGEST, contentSchemaDigest: seedDigest('schema'), unsetReason: 'carried_optional_unset', unsetProvenance: { kind: 'created_empty' } }
      : mkSetVersion(slotId);
    versionRefs.set(slotId, put('content_version', version));
  }
  const manifestEntries = [...manifestSlotIds].sort()
    .map((slotId) => ({ slotId, versionRef: versionRefs.get(slotId) as BlobRefV2 }));
  const manifestBody = {
    taskId: TASK,
    mapRef,
    mapSemanticDigest: CUR_MAP_DIGEST,
    taskContentRevision: 1,
    manifestPhase: 'finalized' as const,
    entries: manifestEntries,
    producerPlanSpecRef: null,
    priorManifestRef: null,
    finalizerValidatorAggregateRefs: [r('validator_aggregate', seedDigest('manifest-finalizer'))],
    finalizerWarningRootRefs: [],
    contentRootDigest: CONTENT_ROOT,
    manifestDigest: '',
  };
  const manifestRef = put('content_revision_manifest', withSelfDigest(manifestBody, 'manifestDigest'));
  refs.baseManifestRef = manifestRef;

  /* ---- stale old manifest: SAME content root, DIFFERENT authority/ref ---- */
  let reviewManifestRef: BlobRefV2 = manifestRef;
  if (cfg.staleReviewManifest) {
    reviewManifestRef = put('content_revision_manifest', withSelfDigest({
      ...clone(manifestBody),
      producerPlanSpecRef: r('generation_plan_spec', seedDigest('old-plan')),
      manifestDigest: '',
    }, 'manifestDigest'));
  }

  /* ---- committed coverage ledger + adoption root + stage root ---- */
  let factBodies = CONTENT_SLOTS
    .filter((s) => !(cfg.optionalUnsetSlot && s === UNSET_SLOT))
    .map((s) => mkFact(s, 'pass'));
  if (cfg.missingSlotFact) factBodies = factBodies.filter((f) => f.targetStableId !== cfg.missingSlotFact);
  if (cfg.violatedRelation) factBodies = [...factBodies, mkRelationFact('rel-1', 'violated')];
  const storedFactRefs = factBodies.map((fact) => put('review_fact', fact)).sort(byDigest);
  const committedSlotIds = factBodies
    .filter((fact) => fact.targetKind === 'content_slot')
    .map((fact) => fact.targetStableId as string)
    .sort();
  const ledgerRef = put('review_assignment_ledger', withSelfDigest({
    assignmentId: 'assign-1',
    workItemId: 'review-work-1',
    reviewAssignmentId: null,
    roundKind: 'content',
    roundId: ROUND_ID,
    factRefs: storedFactRefs,
    findingDraftRefs: [],
    verificationRecordRefs: [],
    coverageTargetIds: committedSlotIds,
    ledgerDigest: '',
  }, 'ledgerDigest'));
  const wholeLedgerRef = put('review_assignment_ledger', withSelfDigest({
    assignmentId: 'whole-1',
    workItemId: 'review-work-whole',
    reviewAssignmentId: null,
    roundKind: 'content',
    roundId: ROUND_ID,
    factRefs: [],
    findingDraftRefs: [],
    verificationRecordRefs: [],
    coverageTargetIds: [],
    ledgerDigest: '',
  }, 'ledgerDigest'));
  // Adoption coverage: an adopted slot has NO resolvable verdict (the adoption
  // record carries only a factId string — the frozen schema provides no fact
  // ref/verdict here). The resolver must fail that slot closed.
  const adoptionRootRef = cfg.adoptedCoverageSlot
    ? (() => {
        const adoptionLedgerRef = put('review_adoption_ledger', withSelfDigest({
          roundId: ROUND_ID,
          chunkIndex: 0,
          adoptionRecords: [{
            adoptionId: 'adoption-1',
            roundKind: 'content',
            roundId: ROUND_ID,
            candidateId: null,
            mapId: null,
            factId: `fact-${ADOPTED_SLOT}`,
            targetStableId: ADOPTED_SLOT,
            expectedLocalSubjectDigest: seedDigest(`adopt-subject-${ADOPTED_SLOT}`),
            expectedLocalContextDigest: seedDigest(`adopt-context-${ADOPTED_SLOT}`),
            reviewPolicyDigest: seedDigest('policy'),
            adoptedBy: 'system',
          }],
          blobDigest: '',
        }, 'blobDigest'));
        return put('review_adoption_root', withSelfDigest({
          roundId: ROUND_ID,
          orderedChunkRefs: [adoptionLedgerRef],
          adoptedTargetCount: 1,
          coverageDigest: seedDigest('adoption-cov'),
          rootDigest: '',
        }, 'rootDigest'));
      })()
    : put('review_adoption_root', withSelfDigest({
        roundId: ROUND_ID,
        orderedChunkRefs: [],
        adoptedTargetCount: 0,
        coverageDigest: seedDigest('adoption-cov'),
        rootDigest: '',
      }, 'rootDigest'));
  const findingStageRootRef = put('finding_stage_root', withSelfDigest({
    rootId: 'stage-1',
    roundId: ROUND_ID,
    entries: [],
    rootDigest: '',
  }, 'rootDigest'));

  /* ---- content review coverage core + settlement aggregate ---- */
  const coverageCoreRef = put('content_review_coverage_core', withSelfDigest({
    reviewRoundId: ROUND_ID,
    mapRef: cfg.staleReviewMap ? r('map_snapshot', '2'.repeat(64)) : mapRef,
    contentRevisionManifestRef: reviewManifestRef,
    reviewPolicyDigest: seedDigest('policy'),
    coverageLedgerRootRefs: [ledgerRef],
    adoptionRootRef,
    wholeTreeObservationRootRefs: [wholeLedgerRef],
    findingStageRootRef,
    coreDigest: '',
  }, 'coreDigest'));
  refs.coverageCoreRef = coverageCoreRef;

  const contentSettlementEnvelopeRef = put('validator_input_envelope', mkEnvelope(
    'review_settlement',
    { contentReviewCoverageCoreRef: cfg.staleSettlementClosure ? r('content_review_coverage_core', seedDigest('other-coverage-core')) : coverageCoreRef },
  ));
  const contentSettlementAggregateRef = put('validator_aggregate', mkAggregate({
    trigger: 'review_settlement',
    inputRef: contentSettlementEnvelopeRef,
    blocking: cfg.blockingSettlementAggregate ? [r('validation_receipt', seedDigest('settlement-blocking'))] : [],
    warningRootRef: r('validation_warning_root', seedDigest('content-set-warn')),
  }));
  const settlementCoreRef = put('content_review_settlement_core', withSelfDigest({
    coverageCoreRef,
    reviewSettlementValidatorAggregateRef: contentSettlementAggregateRef,
    coreDigest: '',
  }, 'coreDigest'));

  /* ---- ReviewBundle + seal authority base ---- */
  const reviewWarningCustodyRootRef = r('validation_warning_custody_root', seedDigest('review-warning-custody'));
  const reviewBundleRef = put('review_bundle', withSelfDigest({
    settlementCoreRef,
    mapRef: cfg.staleReviewMap ? r('map_snapshot', '2'.repeat(64)) : mapRef,
    contentRevisionManifestRef: reviewManifestRef,
    reviewWarningCustodyRootRef,
    bundleDigest: '',
  }, 'bundleDigest'));
  refs.reviewBundleRef = reviewBundleRef;

  const sealAuthorityBaseRef = put('authority_base_set', buildAuthorityBaseSet({
    taskId: TASK,
    templateSnapshotRef: refs.templateSnapshotRef,
    profileSnapshotRef: refs.profileSnapshotRef,
    refs: {
      mapRef,
      mapReviewBundleRef,
      contentRevisionManifestRef: manifestRef,
      reviewBundleRef,
    },
    kind: 'system_seal',
  }));
  refs.sealAuthorityBaseRef = sealAuthorityBaseRef;

  /* ---- seal_input validator custody (P2#8: advisory from seal_input) ---- */
  const sealInputEnvelopeRef = put('validator_input_envelope', mkEnvelope('seal_input', { reviewBundleRef }));
  const advisoryReceiptRef = r('validation_receipt', seedDigest('seal-input-advisory'));
  const sealInputWarningRootRef = put('validation_warning_root', withSelfDigest({
    trigger: 'seal_input',
    executionPhase: null,
    inputRef: sealInputEnvelopeRef,
    inputDigest: sealInputEnvelopeRef.digest,
    orderedAdvisoryReceiptRefs: cfg.sealInputAdvisory ? [advisoryReceiptRef] : [],
    warningCount: cfg.sealInputAdvisory ? 1 : 0,
    rootDigest: '',
  }, 'rootDigest'));
  refs.sealInputWarningRootRef = sealInputWarningRootRef;
  refs.sealInputAggregateRef = put('validator_aggregate', mkAggregate({
    trigger: 'seal_input',
    inputRef: sealInputEnvelopeRef,
    advisory: cfg.sealInputAdvisory ? [advisoryReceiptRef] : [],
    warningRootRef: sealInputWarningRootRef,
  }));

  /* ---- projection view ---- */
  const contentRounds: SealProjectionViewV2['contentRounds'] = {
    [ROUND_ID]: { state: cfg.unsettledContentRound ? 'completed' : 'settled' },
  };
  if (cfg.pendingContentRound) contentRounds['round-2'] = { state: 'planned' };

  const findings: SealProjectionViewV2['findings'] = {};
  if (cfg.openBlockingFinding) findings['finding-1'] = { severity: 'blocking', state: 'open' };

  const workItems: SealProjectionViewV2['workItems'] = {
    'seal-work': {
      kind: cfg.wrongSealWorkItemKind ? 'agent_assignment' : 'system_seal',
      authorityBaseRef: sealAuthorityBaseRef,
      payloadRef: reviewBundleRef,
      leaseEpoch: 0,
      state: 'leased',
      sessionKind: null,
    },
  };
  if (cfg.activeRepairWorkItem) {
    workItems['repair-work'] = {
      kind: 'agent_assignment',
      authorityBaseRef: r('authority_base_set', seedDigest('repair-base')),
      payloadRef: r('content_revision_manifest', seedDigest('repair-payload')),
      leaseEpoch: 1,
      state: 'leased',
      sessionKind: 'content_repair',
    };
  }

  projection = {
    activeLease: { workItemId: 'seal-work', leaseEpoch: 0, commandId: 'seal-command' },
    currentMap: {
      mapSnapshotRef: mapRef,
      mapReviewBundleRef,
      mapSemanticDigest: CUR_MAP_DIGEST,
    },
    currentManifest: {
      contentRevisionManifestRef: manifestRef,
      manifestPhase: 'finalized',
    },
    currentSeal: cfg.currentSealPresent ? { sealRecordRef: r('seal_record', seedDigest('existing-seal')) } : null,
    workItems,
    contentRounds,
    mapRounds: { 'map-round-1': { state: 'settled' } },
    findings,
  };

  return {
    store,
    projection,
    refs,
    sealContext: {
      taskId: TASK,
      commandId: 'seal-command',
      sealWorkItemId: 'seal-work',
      sealLeaseEpoch: 0,
      sealAuthorityBaseRef,
      payloadRef: reviewBundleRef,
    },
    put,
    resolveBlob,
    readProjection,
  };
}

function makeResolver(world: SealWorld, cfg: SealWorldConfig = {}): SealAuthorityResolverV2 {
  const templateAsset = { templateSnapshotHash: TEMPLATE_HASH, resourceManifestDigest: seedDigest('resource-manifest'), assembler: ZHIHU_CHAPTER_ASSEMBLER_REGISTRATION };
  const relationEnforcement = new Map<string, 'blocking' | 'advisory'>();
  if (cfg.violatedRelation || cfg.blockingRelationNoFact) relationEnforcement.set('cross_ref', 'blocking');
  const contentPresence = new Map<string, 'required' | 'optional'>();
  for (const slotId of [...CONTENT_SLOTS, ADOPTED_SLOT]) contentPresence.set(slotId, 'required');
  if (cfg.optionalUnsetSlot) contentPresence.set(UNSET_SLOT, 'optional');
  const deps: SealAuthorityResolverDependenciesV2 = {
    readProjection: world.readProjection,
    resolveBlob: world.resolveBlob,
    resolveTemplateIdentity: async () => ({ ...templateAsset, relationEnforcement, contentPresence }),
    installedTemplateIdentity: async () => (cfg.staleTemplate ? { ...templateAsset, templateSnapshotHash: 'template-other' } : templateAsset),
    readProfileSnapshotRef: async () => world.refs.profileSnapshotRef,
    buildAssemblerInput: async (input) => ({
      authority: {
        mapRef: input.activeMapRef,
        contentRevisionManifestRef: input.contentRevisionManifestRef,
        templateSnapshotHash: input.templateSnapshotHash,
      },
      tree: zhihuAssemblerFixture().tree,
    }),
    submitterIdentity: async () => ({ workItemId: 'submit-work', agentId: 'submitter', logicalAssignmentId: 'submit-logical', maxAutomaticRetries: 2 }),
  };
  return createSystemSealAuthorityResolver(deps);
}

function makeService(world: SealWorld, cfg: SealWorldConfig = {}) {
  const resolver = makeResolver(world, cfg);
  const publisher = {
    stage: vi.fn(async () => ({ artifactId: 'artifact-1', custodyRef: r('artifact', seedDigest('custody')) })),
    publish: vi.fn(async (input: { deliveryRef: BlobRefV2 }) => ({ artifactVersion: 1, deliveryRef: input.deliveryRef })),
  };
  const routeInputBlocking = vi.fn(async () => ({ kind: 'completed' as const, resultRefs: [] as BlobRefV2[] }));
  const recordOutputBlocking = vi.fn(async () => ({
    kind: 'terminal_failure' as const,
    failureCode: 'ARTIFACT_VALIDATION_FAILED',
    failureDigest: 'f'.repeat(64),
    taskFailure: true,
  }));
  const validate = vi.fn(async (stage: 'seal_input' | 'seal_output'): Promise<SealValidatorRunV2> => {
    if (stage === 'seal_input') {
      return { outcome: 'clear', aggregateRef: world.refs.sealInputAggregateRef, blockingReceiptRef: null };
    }
    return { outcome: 'clear', aggregateRef: r('validator_aggregate', seedDigest('seal-output-aggregate')), blockingReceiptRef: null };
  });
  const deps: SystemSealServiceDependenciesV2 = {
    assemblerRegistry: new AssemblerRegistryV2(),
    blobs: {
      prepare: async (kind, value) => {
        const { ref } = parseBlob(kind, value);
        world.store.set(`${ref.kind}:${ref.digest}`, value);
        return ref;
      },
    },
    publisher,
    validate,
    routeInputBlocking,
    recordOutputBlocking,
    resolveBlob: world.resolveBlob,
    resolveSealAuthority: resolver,
  };
  const service = new SystemSealServiceV2(deps);
  return { service, deps, world, publisher, validate, routeInputBlocking, recordOutputBlocking, resolver };
}

function parsed<T>(world: SealWorld, ref: BlobRefV2): T {
  const raw = world.store.get(`${ref.kind}:${ref.digest}`);
  if (raw === undefined) throw new Error(`world store missing ${ref.kind}:${ref.digest}`);
  return parseBlob(ref.kind, raw, ref).object as T;
}

async function gateFromResolver(world: SealWorld, cfg: SealWorldConfig = {}): Promise<SealGateInputV2> {
  const resolver = makeResolver(world, cfg);
  const resolved = await resolver({
    taskId: world.sealContext.taskId,
    workItemId: world.sealContext.sealWorkItemId,
    commandId: world.sealContext.commandId,
    leaseEpoch: world.sealContext.sealLeaseEpoch,
    authorityBaseRef: world.sealContext.sealAuthorityBaseRef,
    payloadRef: world.sealContext.payloadRef,
  });
  return resolved.gate;
}

/* ------------------------------------------------------------------ */
/* derived PURE gate + hostile stale/alias worlds                     */
/* ------------------------------------------------------------------ */

describe('system-derived Seal Gate (P1#2)', () => {
  it('derives an eligible pure gate from the projection + resolved blob graph', async () => {
    const world = buildSealWorld();
    const gate = await gateFromResolver(world);
    expect(evaluateSealGate(gate).eligible).toBe(true);
  });

  it.each([
    ['stale review manifest (same content root)', { staleReviewManifest: true }, sealConditionCodes.MANIFEST_REF_MISMATCH],
    ['stale review map ref', { staleReviewMap: true }, sealConditionCodes.MAP_REF_MISMATCH],
    ['absent active MapReviewBundle', { noMapReviewBundle: true }, sealConditionCodes.MAP_REVIEW_BUNDLE_MISSING],
    ['missing slot pass fact', { missingSlotFact: 'title' }, sealConditionCodes.PRESENCE_COVERAGE_INCOMPLETE],
    ['blocking relation violated', { violatedRelation: true }, sealConditionCodes.RELATION_COVERAGE_INCOMPLETE],
    ['blocking relation with NO committed fact', { blockingRelationNoFact: true }, sealConditionCodes.RELATION_COVERAGE_INCOMPLETE],
    ['optional-unset slot in finalized manifest', { optionalUnsetSlot: true }, sealConditionCodes.PRESENCE_COVERAGE_INCOMPLETE],
    ['adoption-only covered required-set slot', { adoptedCoverageSlot: true }, sealConditionCodes.PRESENCE_COVERAGE_INCOMPLETE],
    ['unsettled content round', { unsettledContentRound: true }, sealConditionCodes.OBSERVATION_INCOMPLETE],
    ['open blocking finding', { openBlockingFinding: true }, sealConditionCodes.BLOCKING_FINDINGS_OPEN],
    ['pending content round', { pendingContentRound: true }, sealConditionCodes.PENDING_OR_STALE_REVIEW],
    ['active repair work item', { activeRepairWorkItem: true }, sealConditionCodes.PENDING_OR_STALE_REVIEW],
    ['blocking settlement aggregate', { blockingSettlementAggregate: true }, sealConditionCodes.VALIDATOR_NOT_CLEAR],
    ['settlement closure unbound', { staleSettlementClosure: true }, sealConditionCodes.VALIDATOR_NOT_CLEAR],
    ['stale installed template identity', { staleTemplate: true }, sealConditionCodes.TEMPLATE_MISMATCH],
  ])('flags %s with the FROZEN condition code and a stable single reason', async (_label, cfg, code) => {
    const world = buildSealWorld(cfg);
    const gate = await gateFromResolver(world, cfg);
    const result = evaluateSealGate(gate);
    expect(result.eligible).toBe(false);
    expect(result.unmetConditions.map((c) => c.code)).toEqual([code]);
    expect(result.unmetConditions[0]!.detail.length).toBeGreaterThan(0);
  });

  it('derives blockingRelationIds from the active Map relations filtered by frozen template enforcement — independent of facts', async () => {
    const world = buildSealWorld({ blockingRelationNoFact: true });
    const gate = await gateFromResolver(world, { blockingRelationNoFact: true });
    // A blocking relation that NO committed fact covers must still be enumerated.
    expect(gate.blockingRelationIds).toContain('rel-1');
    expect(gate.relationVerdicts.has('rel-1')).toBe(false);
    expect(evaluateSealGate(gate).unmetConditions.map((c) => c.code)).toEqual([sealConditionCodes.RELATION_COVERAGE_INCOMPLETE]);
  });

  it('splits set slots from optional-unset slots (fail-closed on absence proof)', async () => {
    const world = buildSealWorld({ optionalUnsetSlot: true });
    const gate = await gateFromResolver(world, { optionalUnsetSlot: true });
    // The unset slot must NOT be demanded as a reviewed pass; it lands in the
    // optional-unset set where the EMPTY absence facts fail the gate closed.
    expect(gate.requiredSetSlots).not.toContain(UNSET_SLOT);
    expect(gate.optionalUnsetSlotIds).toContain(UNSET_SLOT);
    expect(gate.optionalUnsetSlots.has(UNSET_SLOT)).toBe(false);
    const result = evaluateSealGate(gate);
    expect(result.unmetConditions.map((c) => c.code)).toEqual([sealConditionCodes.PRESENCE_COVERAGE_INCOMPLETE]);
    expect(result.unmetConditions[0]!.detail).toContain('absent_not_applicable');
  });

  it('fails adopted-only coverage closed (no fabricated adopted verdict)', async () => {
    const world = buildSealWorld({ adoptedCoverageSlot: true });
    const gate = await gateFromResolver(world, { adoptedCoverageSlot: true });
    expect(gate.requiredSetSlots).toContain(ADOPTED_SLOT);
    expect(gate.slotFacts.has(ADOPTED_SLOT)).toBe(false);
    const result = evaluateSealGate(gate);
    expect(result.unmetConditions.map((c) => c.code)).toEqual([sealConditionCodes.PRESENCE_COVERAGE_INCOMPLETE]);
  });

  it('fails closed at the service boundary with a stable code for every hostile world', async () => {
    const cases: Array<[SealWorldConfig, string]> = [
      [{ staleReviewManifest: true }, sealConditionCodes.MANIFEST_REF_MISMATCH],
      [{ staleReviewMap: true }, sealConditionCodes.MAP_REF_MISMATCH],
      [{ noMapReviewBundle: true }, sealConditionCodes.MAP_REVIEW_BUNDLE_MISSING],
      [{ missingSlotFact: 'title' }, sealConditionCodes.PRESENCE_COVERAGE_INCOMPLETE],
      [{ violatedRelation: true }, sealConditionCodes.RELATION_COVERAGE_INCOMPLETE],
      [{ blockingRelationNoFact: true }, sealConditionCodes.RELATION_COVERAGE_INCOMPLETE],
      [{ optionalUnsetSlot: true }, sealConditionCodes.PRESENCE_COVERAGE_INCOMPLETE],
      [{ adoptedCoverageSlot: true }, sealConditionCodes.PRESENCE_COVERAGE_INCOMPLETE],
      [{ unsettledContentRound: true }, sealConditionCodes.OBSERVATION_INCOMPLETE],
      [{ openBlockingFinding: true }, sealConditionCodes.BLOCKING_FINDINGS_OPEN],
      [{ pendingContentRound: true }, sealConditionCodes.PENDING_OR_STALE_REVIEW],
      [{ activeRepairWorkItem: true }, sealConditionCodes.PENDING_OR_STALE_REVIEW],
      [{ blockingSettlementAggregate: true }, sealConditionCodes.VALIDATOR_NOT_CLEAR],
      [{ staleSettlementClosure: true }, sealConditionCodes.VALIDATOR_NOT_CLEAR],
      [{ staleTemplate: true }, sealConditionCodes.TEMPLATE_MISMATCH],
    ];
    for (const [cfg, code] of cases) {
      const world = buildSealWorld(cfg);
      const h = makeService(world, cfg);
      const outcome = await h.service.execute(world.sealContext);
      if (outcome.kind !== 'retryable_failure') throw new Error(`expected retryable_failure for ${code}`);
      expect(outcome.failureCode).toContain('SEAL_GATE_UNMET:');
      expect(outcome.failureCode).toContain(code);
      expect(h.validate).not.toHaveBeenCalled();
      expect(h.publisher.stage).not.toHaveBeenCalled();
      expect(h.publisher.publish).not.toHaveBeenCalled();
    }
  });

  it('binds lease/work-item/authority-base/payload by EXACT ref and epoch — not strings', async () => {
    const world = buildSealWorld();
    const h = makeService(world);

    const wrongLease = await h.service.execute({ ...world.sealContext, sealLeaseEpoch: 99 });
    expect(wrongLease).toMatchObject({ kind: 'retryable_failure', failureCode: 'SEAL_AUTHORITY:SEAL_LEASE_STALE' });

    const wrongKindWorld = buildSealWorld({ wrongSealWorkItemKind: true });
    const h2 = makeService(wrongKindWorld);
    const wrongItem = await h2.service.execute(wrongKindWorld.sealContext);
    expect(wrongItem).toMatchObject({ kind: 'retryable_failure', failureCode: 'SEAL_AUTHORITY:SEAL_WORK_ITEM_MISSING' });

    const wrongBase = await h.service.execute({ ...world.sealContext, sealAuthorityBaseRef: r('authority_base_set', '3'.repeat(64)) });
    expect(wrongBase).toMatchObject({ kind: 'retryable_failure', failureCode: 'SEAL_AUTHORITY:SEAL_AUTHORITY_STALE' });

    const wrongPayload = await h.service.execute({ ...world.sealContext, payloadRef: r('review_bundle', '4'.repeat(64)) });
    expect(wrongPayload).toMatchObject({ kind: 'retryable_failure', failureCode: 'SEAL_AUTHORITY:SEAL_AUTHORITY_STALE' });

    const sealedWorld = buildSealWorld({ currentSealPresent: true });
    const h3 = makeService(sealedWorld);
    const already = await h3.service.execute(sealedWorld.sealContext);
    expect(already).toMatchObject({ kind: 'retryable_failure', failureCode: 'SEAL_AUTHORITY:SEAL_ALREADY_PUBLISHED' });
  });

  it('content-root equality is never ref equality (same root, different manifest ref)', async () => {
    const world = buildSealWorld({ staleReviewManifest: true });
    const gate = await gateFromResolver(world);
    expect(gate.baseFinalizedManifestRef.digest).not.toBe(gate.reviewBundleCoverageManifestRef.digest);
    expect(gate.contentRootDigest).toBe(gate.contentRootDigestOfReviewBundle);
    const result = evaluateSealGate(gate);
    expect(result.unmetConditions.map((c) => c.code)).toEqual([sealConditionCodes.MANIFEST_REF_MISMATCH]);
  });
});

/* ------------------------------------------------------------------ */
/* SystemSealServiceV2 validator && publication branches               */
/* ------------------------------------------------------------------ */

describe('SystemSealServiceV2 validator and publication branches (derived gate)', () => {
  it('prepares bundle/record/artifact/delivery and publishes once on a fully derived clear world', async () => {
    const world = buildSealWorld();
    const h = makeService(world);
    const outcome = await h.service.execute(world.sealContext);
    expect(outcome).toMatchObject({ kind: 'completed', resultRefs: expect.any(Array) });
    expect(h.publisher.stage).toHaveBeenCalledTimes(1);
    expect(h.publisher.publish).toHaveBeenCalledTimes(1);
    const published = h.publisher.publish.mock.calls[0]![0] as unknown as {
      operationId: string;
      sealWorkItemId: string;
      delivery: Record<string, unknown>;
      files: Array<{ name: string; mediaType: string }>;
    };
    expect(published.delivery).not.toHaveProperty('artifactVersion');
    expect(published).toMatchObject({ sealWorkItemId: 'seal-work', files: [{ name: 'chapter.md', mediaType: 'text/markdown' }] });
    expect(typeof published.operationId).toBe('string');
  });

  it('routes seal_input blocking with aggregate/receipt and never assembles or publishes', async () => {
    const world = buildSealWorld();
    const h = makeService(world);
    h.validate.mockImplementationOnce(async () => ({ outcome: 'blocking_invalid' as const, aggregateRef: world.refs.sealInputAggregateRef, blockingReceiptRef: r('validation_receipt', seedDigest('blocking')) }));
    await expect(h.service.execute(world.sealContext)).resolves.toMatchObject({ kind: 'completed' });
    expect(h.routeInputBlocking).toHaveBeenCalledWith(expect.objectContaining({ kind: 'validator_aggregate' }), expect.objectContaining({ kind: 'validation_receipt' }));
    expect(h.publisher.stage).not.toHaveBeenCalled();
    expect(h.publisher.publish).not.toHaveBeenCalled();
  });

  it('records seal_output blocking as ARTIFACT_VALIDATION_FAILED and does not publish', async () => {
    const world = buildSealWorld();
    const h = makeService(world);
    h.validate
      .mockResolvedValueOnce({ outcome: 'clear', aggregateRef: world.refs.sealInputAggregateRef, blockingReceiptRef: null })
      .mockResolvedValueOnce({ outcome: 'blocking_invalid', aggregateRef: r('validator_aggregate', seedDigest('output-blocking')), blockingReceiptRef: r('validation_receipt', seedDigest('output-blocking-receipt')) });
    await expect(h.service.execute(world.sealContext)).resolves.toMatchObject({ kind: 'terminal_failure', failureCode: 'ARTIFACT_VALIDATION_FAILED' });
    expect(h.recordOutputBlocking).toHaveBeenCalled();
    expect(h.publisher.stage).not.toHaveBeenCalled();
    expect(h.publisher.publish).not.toHaveBeenCalled();
  });

  it('preserves seal_input infrastructure aggregate for retry', async () => {
    const world = buildSealWorld();
    const h = makeService(world);
    h.validate.mockResolvedValueOnce({ outcome: 'infrastructure_failure', aggregateRef: world.refs.sealInputAggregateRef, blockingReceiptRef: null });
    await expect(h.service.execute(world.sealContext)).resolves.toMatchObject({
      kind: 'retryable_failure', failureCode: 'SEAL_INPUT_INFRASTRUCTURE', validatorAggregateRef: { kind: 'validator_aggregate' },
    });
  });

  it('turns stage/append infrastructure crashes into stable retryable failures with aggregate custody', async () => {
    const stageWorld = buildSealWorld();
    const hs = makeService(stageWorld);
    hs.publisher.stage.mockRejectedValueOnce(new Error('disk offline'));
    await expect(hs.service.execute(stageWorld.sealContext)).resolves.toMatchObject({
      kind: 'retryable_failure', failureCode: 'ARTIFACT_STAGE_INFRASTRUCTURE',
      validatorAggregateRef: { kind: 'validator_aggregate' },
    });
    const appendWorld = buildSealWorld();
    const ha = makeService(appendWorld);
    ha.publisher.publish.mockRejectedValueOnce(new Error('response lost'));
    await expect(ha.service.execute(appendWorld.sealContext)).resolves.toMatchObject({
      kind: 'retryable_failure', failureCode: 'SEAL_PUBLISH_INFRASTRUCTURE',
      validatorAggregateRef: { kind: 'validator_aggregate' },
    });
  });
});

/* ------------------------------------------------------------------ */
/* P2#8: Seal validation bundle warning custody = seal_input advisories */
/* ------------------------------------------------------------------ */

describe('SealWarningCustodyRoot (P2#8)', () => {
  it('builds the seal custody from seal_input advisory warnings; seal_output stays empty', async () => {
    const world = buildSealWorld({ sealInputAdvisory: true });
    const aggregate = parsed<ValidatorAggregateV2>(world, world.refs.sealInputAggregateRef);
    const custody = buildSealWarningCustodyRoot({
      taskId: TASK,
      sealWorkItemId: 'seal-work',
      reviewBundleRef: world.refs.reviewBundleRef,
      sealInputAggregateRef: world.refs.sealInputAggregateRef,
      sealInputAggregate: aggregate,
    });
    expect(custody.scope).toBe('seal');
    expect(custody.entries).toHaveLength(1);
    expect(custody.entries[0]!.trigger).toBe('seal_input');
    expect(custody.entries.some((entry) => entry.trigger === 'seal_output')).toBe(false);
    expect(custody.entries[0]!.validatorAggregateRef).toEqual(world.refs.sealInputAggregateRef);
  });

  it('SealRecord -> SealValidationBundle replay exposes the seal_input advisory warnings', async () => {
    const world = buildSealWorld({ sealInputAdvisory: true });
    const h = makeService(world);
    const outcome = await h.service.execute(world.sealContext);
    if (outcome.kind !== 'completed') throw new Error('seal did not complete');
    const [bundleRef, sealRecordRef] = outcome.resultRefs;
    const record = parsed<SealRecordV2>(world, sealRecordRef);
    expect(record.sealValidationBundleRef).toEqual(bundleRef);
    const bundle = parsed<SealValidationBundleV2>(world, bundleRef);
    expect(bundle.sealWarningCustodyRootRef.kind).toBe('validation_warning_custody_root');
    const replayed = parsed<ValidationWarningCustodyRootV2>(world, bundle.sealWarningCustodyRootRef);
    expect(replayed.scope).toBe('seal');
    expect(replayed.entries.map((entry) => entry.trigger)).toEqual(['seal_input']);
    const warningRoot = parsed<ValidationWarningRootV2>(world, replayed.entries[0]!.warningRootRef);
    expect(warningRoot.orderedAdvisoryReceiptRefs.length).toBeGreaterThan(0);
  });

  it('keeps the input warnings visible even for a clear seal_input with zero advisories', async () => {
    const world = buildSealWorld();
    const h = makeService(world);
    const outcome = await h.service.execute(world.sealContext);
    if (outcome.kind !== 'completed') throw new Error('seal did not complete');
    const [bundleRef] = outcome.resultRefs;
    const bundle = parsed<SealValidationBundleV2>(world, bundleRef);
    const replayed = parsed<ValidationWarningCustodyRootV2>(world, bundle.sealWarningCustodyRootRef);
    expect(replayed.entries.map((entry) => entry.trigger)).toEqual(['seal_input']);
  });
});

/* ------------------------------------------------------------------ */
/* SystemCommand handler (P1#2: no caller-supplied gate/refs inbound) */
/* ------------------------------------------------------------------ */

describe('createSystemSealCommandHandler', () => {
  it('passes only the ctx identity to the service — authority is derived, never inbound', async () => {
    const world = buildSealWorld();
    const h = makeService(world);
    const handler = createSystemSealCommandHandler(h.service);
    const result = await handler.execute({
      taskId: TASK,
      commandId: 'seal-command',
      workItemId: 'seal-work',
      commandKind: 'seal',
      leaseEpoch: 0,
      authorityBaseRef: world.sealContext.sealAuthorityBaseRef,
      payloadRef: world.sealContext.payloadRef,
    });
    expect(result.kind).toBe('completed');
  });
});

/* ------------------------------------------------------------------ */
/* production ArtifactStore publisher adapter                          */
/* ------------------------------------------------------------------ */

describe('production ArtifactStore publisher adapter', () => {
  it('uses only system_seal stage/promote around the facade-allocated event version', async () => {
    const artifactStore = {
      stageSystemArtifact: vi.fn(async () => ({})),
      promoteSystemArtifact: vi.fn(async () => ({})),
    };
    const deliveryRef = r('system_artifact_delivery', seedDigest('delivery'));
    const facade = {
      publishWithPin: vi.fn(async () => ({
        events: [{ sequence: 1, fileName: 'batch', size: 1, event: {
          protocolVersion: 2, id: 'publish', at: '2026-08-16T00:00:00.000Z', type: 'artifact_published_v2',
          artifactId: 'artifact-seal-work', artifactVersion: 7, deliveryRef,
          files: [{ name: 'chapter.md', hash: 'a'.repeat(64) }], mediaType: 'text/markdown',
          provenance: { producerKind: 'system', producerWorkItemId: 'seal-work', sealRecordRef: r('seal_record', seedDigest('record')), artifactRef: r('artifact', seedDigest('artifact')), custodyRef: r('artifact', seedDigest('custody')) },
        } }], pinId: 'pin', generation: 1,
      })),
    };
    const publisher = createArtifactStoreSystemSealPublisher({
      facade: facade as never,
      readTail: async () => ({ lastSequence: 0, lastCommitId: null }),
      artifactStore: artifactStore as never,
    });
    const sealRecordRef = r('seal_record', seedDigest('record'));
    const artifactRef = r('artifact', seedDigest('artifact'));
    const staged = await publisher.stage({
      taskId: TASK, sealWorkItemId: 'seal-work', sealRecordRef,
      templateSnapshotHash: 'snapshot', artifactRef,
      files: [{ name: 'chapter.md', mediaType: 'text/markdown', content: '# chapter' }],
    });
    await publisher.publish({
      taskId: TASK, operationId: sealPublishOperationId('seal-work', artifactRef.digest),
      sealWorkItemId: 'seal-work', sealCommandId: 'command', sealLeaseEpoch: 0,
      sealAuthorityBaseRef: r('authority_base_set', seedDigest('seal-base')), sealRecordRef,
      sealValidationBundleRef: r('seal_validation_bundle', seedDigest('bundle')), artifactRef, custodyRef: staged.custodyRef,
      deliveryRef, delivery: {
        deliveryId: 'delivery', producer: 'system:structured_seal' as const, sealRecordRef, sealRecordDigest: sealRecordRef.digest,
        artifactId: staged.artifactId, artifactRef, artifactDigest: artifactRef.digest,
        custodyRef: staged.custodyRef, custodyDigest: staged.custodyRef.digest,
        submitterWorkItemId: 'submit', submitterAgentId: 'agent', templateSnapshotHash: 'snapshot',
      },
      submitterAuthorityBaseRef: r('authority_base_set', seedDigest('submit-base')), submitterGrantSpecRef: r('write_grant_spec', seedDigest('grant')),
      submitterLogicalAssignmentId: 'logical', submitterMaxAutomaticRetries: 2,
      mapRef: r('map_snapshot', seedDigest('map')), contentRevisionManifestRef: r('content_revision_manifest', seedDigest('manifest')),
      reviewBundleRef: r('review_bundle', seedDigest('bundle-review')), files: [{ name: 'chapter.md', mediaType: 'text/markdown', hash: 'a'.repeat(64) }],
    });
    expect(artifactStore.stageSystemArtifact).toHaveBeenCalledWith('system_seal', TASK, expect.objectContaining({ artifactId: 'artifact-seal-work' }));
    expect(artifactStore.promoteSystemArtifact).toHaveBeenCalledWith('system_seal', TASK, expect.objectContaining({ artifactVersion: 7, deliveryRef }));
    expect(facade.publishWithPin).toHaveBeenCalledWith(expect.objectContaining({
      preparedRefs: expect.arrayContaining([
        artifactRef, sealRecordRef, deliveryRef,
        expect.objectContaining({ kind: 'seal_validation_bundle' }),
        expect.objectContaining({ kind: 'map_snapshot' }),
        expect.objectContaining({ kind: 'content_revision_manifest' }),
        expect.objectContaining({ kind: 'review_bundle' }),
        expect.objectContaining({ kind: 'authority_base_set' }),
        expect.objectContaining({ kind: 'write_grant_spec' }),
      ]),
    }));
  });
});