/**
 * Per-kind blob parsers, part 1 (record/local-object kinds). Authors:
 * design §7/§10/§11.4/§11.8/§11.9; spec §10.3.1. Every parser rejects
 * unknown fields and illegal combinations with `SchemaError`.
 */
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';
import {
  SchemaError,
  type AssignmentLedgerBlobV2,
  type AuthorityBaseSetV2,
  type ContentCompatibilityProofV2,
  type ContentPlanFinalizeCoreV2,
  type ContentRevisionCommitCoreV2,
  type ContentRevisionManifestV2,
  type ContentReviewCoverageCoreV2,
  type ContentReviewSettlementCoreV2,
  type ContentValueV2,
  type ContributionManifestV2,
  type FindingSetV2,
  type FindingStageRootV2,
  type FindingV2,
  type FindingVerificationRecordV2,
  type GrantInstanceV2,
  type MapBuildChunkV2,
  type MapBuildKeyLedgerV2,
  type MapBuildManifestV2,
  type MapBuildSpecV2,
  type MapCandidateSnapshotV2,
  type ReviewEvidenceV2,
  type SlotContentRewriteCauseV2,
  type SlotContentSetProvenanceV2,
  type SlotContentUnsetProvenanceV2,
  type SlotContentUnsetReasonV2,
  type SlotContentVersionV2,
} from './authority-types';
import {
  R,
  bl,
  ex,
  hs,
  hx,
  int,
  oStr,
  onn,
  parseEvidenceList,
  parseMapRelations,
  parsePositionNodes,
  rec,
  rf,
  rfKind,
  rfKindN,
  rfa,
  rfaKind,
  rfn,
  sa,
  str,
} from './schema-common';

const JSON_MEDIA = ['application/json', 'text/markdown', 'text/plain'] as const;
const TEXT_MEDIA = ['text/markdown', 'text/plain'] as const;

/* artifact -------------------------------------------------------- */
export function parseArtifact(value: unknown): { artifactId: string; mediaType: 'text/markdown' | 'text/plain'; text: string } {
  const o = rec(value, 'artifact');
  ex(o, ['artifactId', 'mediaType', 'text'], 'artifact');
  return {
    artifactId: str(o.artifactId, 'artifact.artifactId'),
    mediaType: (o.mediaType as never) === 'text/markdown' || (o.mediaType as never) === 'text/plain'
      ? (o.mediaType as 'text/markdown' | 'text/plain')
      : (() => { throw new SchemaError('artifact.mediaType must be text/markdown|text/plain'); })(),
    text: str(o.text, 'artifact.text'),
  };
}

/* assignment_dispatch -------------------------------------------- */
const SESSION_KINDS = [
  'structure_chunk', 'review_map_batch', 'review_map_whole', 'generation_batch',
  'review_content_batch', 'review_content_whole', 'map_repair', 'content_repair',
] as const;

export function parseAssignmentDispatch(value: unknown): Record<string, unknown> {
  const o = rec(value, 'assignment_dispatch');
  ex(o, ['dispatchId', 'workItemId', 'logicalAssignmentId', 'reviewAssignmentId', 'attemptId', 'authorityBaseRef', 'agentExecutionKind', 'sessionKind', 'grantInstanceRef', 'inputArtifactDeliveryId', 'dispatchDigest'], 'assignment_dispatch');
  const gen = str(o.agentExecutionKind, 'assignment_dispatch.agentExecutionKind');
  if (gen !== 'structured_session' && gen !== 'generic_turn') throw new SchemaError('assignment_dispatch.agentExecutionKind must be structured_session|generic_turn');
  const session = oStr(o.sessionKind, 'assignment_dispatch.sessionKind');
  if (session !== null && !(SESSION_KINDS as readonly string[]).includes(session)) throw new SchemaError('assignment_dispatch.sessionKind unknown');
  if (gen === 'structured_session' && session === null) throw new SchemaError('assignment_dispatch: structured_session requires a sessionKind');
  if (gen === 'generic_turn' && session !== null) throw new SchemaError('assignment_dispatch: generic_turn forbids sessionKind');
  const reviewAssignmentId = oStr(o.reviewAssignmentId, 'assignment_dispatch.reviewAssignmentId');
  const isReview = session !== null && (session.startsWith('review_'));
  if (!isReview && reviewAssignmentId !== null) throw new SchemaError('assignment_dispatch.reviewAssignmentId is only legal for review sessions');
  const grant = rfn(o.grantInstanceRef, 'assignment_dispatch.grantInstanceRef');
  if (grant !== null && rf(grant, 'grantInstanceRef').kind !== 'grant_instance') throw new SchemaError('assignment_dispatch.grantInstanceRef must be a grant_instance ref');
  const inputArtifactDeliveryId = oStr(o.inputArtifactDeliveryId, 'assignment_dispatch.inputArtifactDeliveryId');
  if (gen === 'generic_turn' && inputArtifactDeliveryId === null) {
    throw new SchemaError('assignment_dispatch: generic_turn requires inputArtifactDeliveryId');
  }
  if (gen === 'structured_session' && inputArtifactDeliveryId !== null) {
    throw new SchemaError('assignment_dispatch: structured_session forbids inputArtifactDeliveryId');
  }
  const result: Record<string, unknown> = {
    dispatchId: str(o.dispatchId, 'dispatchId'),
    workItemId: str(o.workItemId, 'workItemId'),
    logicalAssignmentId: str(o.logicalAssignmentId, 'logicalAssignmentId'),
    reviewAssignmentId,
    attemptId: str(o.attemptId, 'attemptId'),
    authorityBaseRef: rfKind(o.authorityBaseRef, 'authority_base_set', 'authorityBaseRef'),
    agentExecutionKind: gen,
    sessionKind: session,
    grantInstanceRef: grant,
    inputArtifactDeliveryId,
  };
  hs(result, o.dispatchDigest, 'dispatchDigest', 'assignment_dispatch');
  result.dispatchDigest = hx(o.dispatchDigest, 'assignment_dispatch.dispatchDigest');
  return result;
}

/* authority_base_set --------------------------------------------- */
const BASE_NULLABLE_REF_FIELDS = [
  'mapRef', 'mapCandidateRef', 'mapReviewBundleRef', 'contentRevisionManifestRef',
  'planSpecRef', 'stagingManifestRef', 'reviewCoverageCoreRef', 'reviewRoundRef',
  'reviewBundleRef', 'sealRecordRef', 'artifactRef', 'findingSetRef', 'artifactDeliveryRef',
] as const;

export function parseAuthorityBaseSet(value: unknown): AuthorityBaseSetV2 {
  const o = rec(value, 'authority_base_set');
  ex(o, ['taskId', 'templateSnapshotRef', 'profileSnapshotRef', ...BASE_NULLABLE_REF_FIELDS, 'displayDigests', 'baseSetDigest'], 'authority_base_set');
  const out: AuthorityBaseSetV2 = {
    taskId: str(o.taskId, 'authority_base_set.taskId'),
    templateSnapshotRef: rf(o.templateSnapshotRef, 'authority_base_set.templateSnapshotRef'),
    profileSnapshotRef: rfKind(o.profileSnapshotRef, 'profile_snapshot', 'authority_base_set.profileSnapshotRef'),
    mapRef: rfn(o.mapRef, 'authority_base_set.mapRef'),
    mapCandidateRef: rfn(o.mapCandidateRef, 'authority_base_set.mapCandidateRef'),
    mapReviewBundleRef: rfn(o.mapReviewBundleRef, 'authority_base_set.mapReviewBundleRef'),
    contentRevisionManifestRef: rfn(o.contentRevisionManifestRef, 'authority_base_set.contentRevisionManifestRef'),
    planSpecRef: rfn(o.planSpecRef, 'authority_base_set.planSpecRef'),
    stagingManifestRef: rfn(o.stagingManifestRef, 'authority_base_set.stagingManifestRef'),
    reviewCoverageCoreRef: rfn(o.reviewCoverageCoreRef, 'authority_base_set.reviewCoverageCoreRef'),
    reviewRoundRef: rfn(o.reviewRoundRef, 'authority_base_set.reviewRoundRef'),
    reviewBundleRef: rfn(o.reviewBundleRef, 'authority_base_set.reviewBundleRef'),
    sealRecordRef: rfn(o.sealRecordRef, 'authority_base_set.sealRecordRef'),
    artifactRef: rfn(o.artifactRef, 'authority_base_set.artifactRef'),
    findingSetRef: rfn(o.findingSetRef, 'authority_base_set.findingSetRef'),
    artifactDeliveryRef: rfn(o.artifactDeliveryRef, 'authority_base_set.artifactDeliveryRef'),
    displayDigests: {},
    baseSetDigest: '',
  };
  if (out.mapRef !== null && out.mapRef.kind !== 'map_snapshot') throw new SchemaError('authority_base_set.mapRef must be a map_snapshot ref');
  if (out.mapCandidateRef !== null && out.mapCandidateRef.kind !== 'map_candidate') throw new SchemaError('authority_base_set.mapCandidateRef must be a map_candidate ref');
  if (out.mapReviewBundleRef !== null && out.mapReviewBundleRef.kind !== 'map_review_bundle') throw new SchemaError('authority_base_set.mapReviewBundleRef must be a map_review_bundle ref');
  if (out.contentRevisionManifestRef !== null && out.contentRevisionManifestRef.kind !== 'content_revision_manifest') throw new SchemaError('authority_base_set.contentRevisionManifestRef must be a content_revision_manifest ref');
  if (out.reviewBundleRef !== null && out.reviewBundleRef.kind !== 'review_bundle') throw new SchemaError('authority_base_set.reviewBundleRef must be a review_bundle ref');
  if (out.sealRecordRef !== null && out.sealRecordRef.kind !== 'seal_record') throw new SchemaError('authority_base_set.sealRecordRef must be a seal_record ref');
  if (out.artifactRef !== null && out.artifactRef.kind !== 'artifact') throw new SchemaError('authority_base_set.artifactRef must be an artifact ref');
  if (out.findingSetRef !== null && out.findingSetRef.kind !== 'finding_set') throw new SchemaError('authority_base_set.findingSetRef must be a finding_set ref');
  if (out.artifactDeliveryRef !== null && out.artifactDeliveryRef.kind !== 'system_artifact_delivery') throw new SchemaError('authority_base_set.artifactDeliveryRef must be a system_artifact_delivery ref');
  if (out.reviewCoverageCoreRef !== null && out.reviewCoverageCoreRef.kind !== 'map_review_coverage_core' && out.reviewCoverageCoreRef.kind !== 'content_review_coverage_core') throw new SchemaError('authority_base_set.reviewCoverageCoreRef must be a review coverage core ref');
  // display digests are display-only aliases: every entry must equal its set ref digest.
  const dd = rec(o.displayDigests, 'authority_base_set.displayDigests');
  for (const key of Object.keys(dd)) {
    const field = key as (typeof BASE_NULLABLE_REF_FIELDS)[number];
    if (!(BASE_NULLABLE_REF_FIELDS as readonly string[]).includes(field)) throw new SchemaError(`authority_base_set.displayDigests has unknown alias '${key}'`);
    const ref = out[field];
    if (ref === null) throw new SchemaError(`authority_base_set.displayDigests.${key} references a null field`);
    if (hx(dd[key], `authority_base_set.displayDigests.${key}`) !== ref.digest) {
      throw new SchemaError(`authority_base_set.displayDigests.${key} does not equal the ${field} ref digest`);
    }
  }
  hs(out, o.baseSetDigest, 'baseSetDigest', 'authority_base_set');
  return { ...out, baseSetDigest: hx(o.baseSetDigest, 'authority_base_set.baseSetDigest') };
}

/* content_compatibility_proof ------------------------------------ */
export function parseContentCompatibilityProof(value: unknown): ContentCompatibilityProofV2 {
  const o = rec(value, 'content_compatibility_proof');
  ex(o, ['taskId', 'slotId', 'sourceVersionRef', 'sourceMapRef', 'targetMapRef', 'sourceContentSchemaDigest', 'targetContentSchemaDigest', 'stableIdentityEvidenceRef', 'proofPolicyVersion', 'proofDigest'], 'content_compatibility_proof');
  const out = {
    taskId: str(o.taskId, 'taskId'),
    slotId: str(o.slotId, 'slotId'),
    sourceVersionRef: rfKind(o.sourceVersionRef, 'content_version', 'sourceVersionRef'),
    sourceMapRef: rfKind(o.sourceMapRef, 'map_snapshot', 'sourceMapRef'),
    targetMapRef: rfKind(o.targetMapRef, 'map_snapshot', 'targetMapRef'),
    sourceContentSchemaDigest: str(o.sourceContentSchemaDigest, 'sourceContentSchemaDigest'),
    targetContentSchemaDigest: str(o.targetContentSchemaDigest, 'targetContentSchemaDigest'),
    stableIdentityEvidenceRef: rf(o.stableIdentityEvidenceRef, 'stableIdentityEvidenceRef'),
    proofPolicyVersion: str(o.proofPolicyVersion, 'proofPolicyVersion'),
    proofDigest: '',
  };
  hs(out, o.proofDigest, 'proofDigest', 'content_compatibility_proof');
  return { ...out, proofDigest: hx(o.proofDigest, 'proofDigest') };
}

/* content_plan_finalize_core ------------------------------------- */
export function parseContentPlanFinalizeCore(value: unknown): ContentPlanFinalizeCoreV2 {
  const o = rec(value, 'content_plan_finalize_core');
  ex(o, ['producerPlanSpecRef', 'provisionalManifestRef', 'mapContext', 'expectedContentRootDigest', 'requiredSlotCoverageDigest', 'expectedBatchClosureDigest', 'coreDigest'], 'content_plan_finalize_core');
  const ctx = rec(o.mapContext, 'content_plan_finalize_core.mapContext');
  let mapContext: ContentPlanFinalizeCoreV2['mapContext'];
  if (ctx.kind === 'active') {
    ex(ctx, ['kind', 'activeMapRef'], 'mapContext');
    mapContext = { kind: 'active', activeMapRef: rfKind(ctx.activeMapRef, 'map_snapshot', 'mapContext.activeMapRef') };
  } else if (ctx.kind === 'migration_preactivation') {
    ex(ctx, ['kind', 'candidateRef', 'proposedMapCoreRef', 'targetMapRef', 'migrationValidationPlanSpecRef', 'migrationSettlementCoreRef', 'settlementOperationId'], 'mapContext');
    mapContext = {
      kind: 'migration_preactivation',
      candidateRef: rfKind(ctx.candidateRef, 'map_candidate', 'candidateRef'),
      proposedMapCoreRef: rfKind(ctx.proposedMapCoreRef, 'proposed_map_core', 'proposedMapCoreRef'),
      targetMapRef: rfKind(ctx.targetMapRef, 'map_snapshot', 'targetMapRef'),
      migrationValidationPlanSpecRef: rfKind(ctx.migrationValidationPlanSpecRef, 'migration_validation_plan_spec', 'migrationValidationPlanSpecRef'),
      migrationSettlementCoreRef: rfKind(ctx.migrationSettlementCoreRef, 'migration_settlement_core', 'migrationSettlementCoreRef'),
      settlementOperationId: str(ctx.settlementOperationId, 'settlementOperationId'),
    };
  } else {
    throw new SchemaError('content_plan_finalize_core.mapContext.kind must be active|migration_preactivation');
  }
  const out: ContentPlanFinalizeCoreV2 = {
    producerPlanSpecRef: rf(o.producerPlanSpecRef, 'producerPlanSpecRef'),
    provisionalManifestRef: rfKind(o.provisionalManifestRef, 'content_revision_manifest', 'provisionalManifestRef'),
    mapContext,
    expectedContentRootDigest: hx(o.expectedContentRootDigest, 'expectedContentRootDigest'),
    requiredSlotCoverageDigest: hx(o.requiredSlotCoverageDigest, 'requiredSlotCoverageDigest'),
    expectedBatchClosureDigest: hx(o.expectedBatchClosureDigest, 'expectedBatchClosureDigest'),
    coreDigest: '',
  };
  hs(out, o.coreDigest, 'coreDigest', 'content_plan_finalize_core');
  return { ...out, coreDigest: hx(o.coreDigest, 'coreDigest') };
}

/* content_revision_commit_core ----------------------------------- */
export function parseContentRevisionCommitCore(value: unknown): ContentRevisionCommitCoreV2 {
  const o = rec(value, 'content_revision_commit_core');
  ex(o, ['priorManifestRef', 'producerPlanSpecRef', 'batchOrdinal', 'authorizedReplacementEntriesWithoutValidation', 'expectedMapRef', 'coreDigest'], 'content_revision_commit_core');
  const entries = (o.authorizedReplacementEntriesWithoutValidation as unknown[]).map((v, i) => {
    const e = rec(v, `authorizedReplacementEntriesWithoutValidation[${i}]`);
    ex(e, ['slotId', 'expectedCurrentVersionRef'], `aRE[${i}]`);
    return {
      slotId: str(e.slotId, 'slotId'),
      expectedCurrentVersionRef: rfn(e.expectedCurrentVersionRef, 'expectedCurrentVersionRef'),
    };
  });
  const out: ContentRevisionCommitCoreV2 = {
    priorManifestRef: rfKind(o.priorManifestRef, 'content_revision_manifest', 'priorManifestRef'),
    producerPlanSpecRef: rf(o.producerPlanSpecRef, 'producerPlanSpecRef'),
    batchOrdinal: onn(o.batchOrdinal, 'batchOrdinal'),
    authorizedReplacementEntriesWithoutValidation: entries,
    expectedMapRef: rfKind(o.expectedMapRef, 'map_snapshot', 'expectedMapRef'),
    coreDigest: '',
  };
  hs(out, o.coreDigest, 'coreDigest', 'content_revision_commit_core');
  return { ...out, coreDigest: hx(o.coreDigest, 'coreDigest') };
}

/* content_revision_manifest -------------------------------------- */
export function parseContentRevisionManifest(value: unknown): ContentRevisionManifestV2 {
  const o = rec(value, 'content_revision_manifest');
  ex(o, ['taskId', 'mapRef', 'mapSemanticDigest', 'taskContentRevision', 'manifestPhase', 'entries', 'producerPlanSpecRef', 'priorManifestRef', 'finalizerValidatorAggregateRefs', 'finalizerWarningRootRefs', 'contentRootDigest', 'manifestDigest'], 'content_revision_manifest');
  const phase = (() => {
    const p = str(o.manifestPhase, 'manifestPhase');
    if (p !== 'baseline_unset' && p !== 'provisional' && p !== 'finalized') throw new SchemaError('manifestPhase must be baseline_unset|provisional|finalized');
    return p as ContentRevisionManifestV2['manifestPhase'];
  })();
  const entries = (o.entries as unknown[]).map((v, i) => {
    const e = rec(v, `entries[${i}]`);
    ex(e, ['slotId', 'versionRef'], `entries[${i}]`);
    return { slotId: str(e.slotId, 'slotId'), versionRef: rfKind(e.versionRef, 'content_version', 'versionRef') };
  });
  for (let i = 1; i < entries.length; i++) {
    if (entries[i - 1].slotId >= entries[i].slotId) throw new SchemaError('content_revision_manifest.entries must be strictly sorted by slotId');
  }
  const finalizerAggs = rfaKind(o.finalizerValidatorAggregateRefs, 'validator_aggregate', 'finalizerValidatorAggregateRefs');
  const finalizerWarnings = rfaKind(o.finalizerWarningRootRefs, 'validation_warning_custody_root', 'finalizerWarningRootRefs');
  if (phase === 'baseline_unset') {
    if (o.producerPlanSpecRef !== null) throw new SchemaError('baseline_unset manifest must have producerPlanSpecRef null');
    if (o.priorManifestRef !== null) throw new SchemaError('baseline_unset manifest must have priorManifestRef null');
    if (finalizerAggs.length > 0 || finalizerWarnings.length > 0) throw new SchemaError('baseline_unset manifest must have empty finalizer refs');
  }
  if (phase === 'provisional' && (finalizerAggs.length > 0 || finalizerWarnings.length > 0)) {
    throw new SchemaError('provisional manifest must have empty finalizer refs (finalized only after plan-finalize clear)');
  }
  if (phase === 'finalized' && finalizerAggs.length === 0) {
    throw new SchemaError('finalized manifest requires finalizerValidatorAggregateRefs');
  }
  const out: ContentRevisionManifestV2 = {
    taskId: str(o.taskId, 'taskId'),
    mapRef: rfKind(o.mapRef, 'map_snapshot', 'mapRef'),
    mapSemanticDigest: hx(o.mapSemanticDigest, 'mapSemanticDigest'),
    taskContentRevision: onn(o.taskContentRevision, 'taskContentRevision'),
    manifestPhase: phase,
    entries,
    producerPlanSpecRef: rfn(o.producerPlanSpecRef, 'producerPlanSpecRef'),
    priorManifestRef: rfn(o.priorManifestRef, 'priorManifestRef'),
    finalizerValidatorAggregateRefs: finalizerAggs,
    finalizerWarningRootRefs: finalizerWarnings,
    contentRootDigest: hx(o.contentRootDigest, 'contentRootDigest'),
    manifestDigest: '',
  };
  hs(out, o.manifestDigest, 'manifestDigest', 'content_revision_manifest');
  return { ...out, manifestDigest: hx(o.manifestDigest, 'manifestDigest') };
}

/* content_review_coverage_core / settlement core ------------------ */
export function parseContentReviewCoverageCore(value: unknown): ContentReviewCoverageCoreV2 {
  const o = rec(value, 'content_review_coverage_core');
  ex(o, ['reviewRoundId', 'mapRef', 'contentRevisionManifestRef', 'reviewPolicyDigest', 'coverageLedgerRootRefs', 'adoptionRootRef', 'wholeTreeObservationRootRefs', 'findingStageRootRef', 'coreDigest'], 'content_review_coverage_core');
  const out: ContentReviewCoverageCoreV2 = {
    reviewRoundId: str(o.reviewRoundId, 'reviewRoundId'),
    mapRef: rfKind(o.mapRef, 'map_snapshot', 'mapRef'),
    contentRevisionManifestRef: rfKind(o.contentRevisionManifestRef, 'content_revision_manifest', 'contentRevisionManifestRef'),
    reviewPolicyDigest: hx(o.reviewPolicyDigest, 'reviewPolicyDigest'),
    coverageLedgerRootRefs: rfaKind(o.coverageLedgerRootRefs, 'review_assignment_ledger', 'coverageLedgerRootRefs'),
    adoptionRootRef: rfKind(o.adoptionRootRef, 'review_adoption_root', 'adoptionRootRef'),
    wholeTreeObservationRootRefs: rfaKind(o.wholeTreeObservationRootRefs, 'review_assignment_ledger', 'wholeTreeObservationRootRefs'),
    findingStageRootRef: rfKind(o.findingStageRootRef, 'finding_stage_root', 'findingStageRootRef'),
    coreDigest: '',
  };
  hs(out, o.coreDigest, 'coreDigest', 'content_review_coverage_core');
  return { ...out, coreDigest: hx(o.coreDigest, 'coreDigest') };
}

export function parseContentReviewSettlementCore(value: unknown): ContentReviewSettlementCoreV2 {
  const o = rec(value, 'content_review_settlement_core');
  ex(o, ['coverageCoreRef', 'reviewSettlementValidatorAggregateRef', 'coreDigest'], 'content_review_settlement_core');
  const out: ContentReviewSettlementCoreV2 = {
    coverageCoreRef: rfKind(o.coverageCoreRef, 'content_review_coverage_core', 'coverageCoreRef'),
    reviewSettlementValidatorAggregateRef: rfKind(o.reviewSettlementValidatorAggregateRef, 'validator_aggregate', 'reviewSettlementValidatorAggregateRef'),
    coreDigest: '',
  };
  hs(out, o.coreDigest, 'coreDigest', 'content_review_settlement_core');
  return { ...out, coreDigest: hx(o.coreDigest, 'coreDigest') };
}

/* content_value -------------------------------------------------- */
export function parseContentValue(value: unknown): ContentValueV2 {
  const o = rec(value, 'content_value');
  ex(o, ['slotId', 'contentSchemaDigest', 'taskContentRevision', 'mediaType', 'text', 'selfDigest'], 'content_value');
  const media = str(o.mediaType, 'mediaType');
  if (!(TEXT_MEDIA as readonly string[]).includes(media)) throw new SchemaError('content_value.mediaType must be text/markdown|text/plain');
  const out: ContentValueV2 = {
    slotId: str(o.slotId, 'slotId'),
    contentSchemaDigest: str(o.contentSchemaDigest, 'contentSchemaDigest'),
    taskContentRevision: onn(o.taskContentRevision, 'taskContentRevision'),
    mediaType: media as ContentValueV2['mediaType'],
    text: str(o.text, 'text'),
    selfDigest: '',
  };
  hs(out, o.selfDigest, 'selfDigest', 'content_value');
  return { ...out, selfDigest: hx(o.selfDigest, 'selfDigest') };
}

/* content_version (SlotContentVersionV2) -------------------------- */
const UNSET_REASONS = ['initial', 'new_slot', 'schema_reset', 'carried_optional_unset'] as const;
const REWRITE_CAUSES = ['validation_rejected', 'mixed_rewrite_required'] as const;

function parseSlotVersion(value: unknown): SlotContentVersionV2 {
  const o = rec(value, 'content_version');
  const state = str(o.state, 'content_version.state');
  const common = () => ({
    slotId: str(o.slotId, 'slotId'),
    slotRevision: onn(o.slotRevision, 'slotRevision'),
    taskContentRevision: onn(o.taskContentRevision, 'taskContentRevision'),
    mapRef: rfKind(o.mapRef, 'map_snapshot', 'mapRef'),
    mapSemanticDigest: hx(o.mapSemanticDigest, 'mapSemanticDigest'),
    contentSchemaDigest: str(o.contentSchemaDigest, 'contentSchemaDigest'),
  });
  if (state === 'unset') {
    ex(o, ['state', 'slotId', 'slotRevision', 'taskContentRevision', 'mapRef', 'mapSemanticDigest', 'contentSchemaDigest', 'unsetReason', 'unsetProvenance'], 'content_version');
    const reason = str(o.unsetReason, 'unsetReason');
    if (!(UNSET_REASONS as readonly string[]).includes(reason)) throw new SchemaError('unsetReason unknown');
    const up = rec(o.unsetProvenance, 'unsetProvenance');
    let unsetProvenance: SlotContentUnsetProvenanceV2;
    if (up.kind === 'created_empty') {
      ex(up, ['kind'], 'unsetProvenance');
      unsetProvenance = { kind: 'created_empty' };
    } else if (up.kind === 'rebased_after_map_activation') {
      ex(up, ['kind', 'sourceVersionRef', 'contentMigrationSettlementCoreRef', 'compatibilityProofRef'], 'unsetProvenance');
      unsetProvenance = {
        kind: 'rebased_after_map_activation',
        sourceVersionRef: rfKind(up.sourceVersionRef, 'content_version', 'sourceVersionRef'),
        contentMigrationSettlementCoreRef: rfKind(up.contentMigrationSettlementCoreRef, 'migration_settlement_core', 'contentMigrationSettlementCoreRef'),
        compatibilityProofRef: rfKind(up.compatibilityProofRef, 'content_compatibility_proof', 'compatibilityProofRef'),
      };
    } else {
      throw new SchemaError('unsetProvenance.kind must be created_empty|rebased_after_map_activation');
    }
    if (reason !== 'carried_optional_unset' && up.kind === 'rebased_after_map_activation') {
      throw new SchemaError('rebased_after_map_activation provenance requires carried_optional_unset');
    }
    return { state: 'unset', ...common(), unsetReason: reason as SlotContentUnsetReasonV2, unsetProvenance } as SlotContentVersionV2;
  }
  if (state === 'rewrite_required') {
    ex(o, ['state', 'slotId', 'slotRevision', 'taskContentRevision', 'mapRef', 'mapSemanticDigest', 'contentSchemaDigest', 'sourceVersionRef', 'contentMigrationSettlementCoreRef', 'rewriteCause', 'sourceContentDigest'], 'content_version');
    const rc = rec(o.rewriteCause, 'rewriteCause');
    let rewriteCause: SlotContentRewriteCauseV2;
    if (rc.kind === 'validation_rejected') {
      ex(rc, ['kind', 'blockingValidatorAggregateRef', 'validationReceiptRef', 'findingSetRef'], 'rewriteCause');
      rewriteCause = {
        kind: 'validation_rejected',
        blockingValidatorAggregateRef: rfKind(rc.blockingValidatorAggregateRef, 'validator_aggregate', 'blockingValidatorAggregateRef'),
        validationReceiptRef: rfKind(rc.validationReceiptRef, 'validation_receipt', 'validationReceiptRef'),
        findingSetRef: rfKind(rc.findingSetRef, 'finding_set', 'findingSetRef'),
      };
    } else if (rc.kind === 'mixed_rewrite_required') {
      ex(rc, ['kind', 'findingStageRootRef'], 'rewriteCause');
      rewriteCause = { kind: 'mixed_rewrite_required', findingStageRootRef: rfKind(rc.findingStageRootRef, 'finding_stage_root', 'findingStageRootRef') };
    } else {
      throw new SchemaError('rewriteCause.kind must be validation_rejected|mixed_rewrite_required');
    }
    return {
      state: 'rewrite_required',
      ...common(),
      sourceVersionRef: rfKind(o.sourceVersionRef, 'content_version', 'sourceVersionRef'),
      contentMigrationSettlementCoreRef: rfKind(o.contentMigrationSettlementCoreRef, 'migration_settlement_core', 'contentMigrationSettlementCoreRef'),
      rewriteCause,
      sourceContentDigest: o.sourceContentDigest === null ? null : hx(o.sourceContentDigest, 'sourceContentDigest'),
    } as SlotContentVersionV2;
  }
  if (state === 'set') {
    ex(o, ['state', 'slotId', 'slotRevision', 'contentDigest', 'taskContentRevision', 'mapRef', 'mapSemanticDigest', 'contentSchemaDigest', 'blobRef', 'provenance'], 'content_version');
    const pv = rec(o.provenance, 'provenance');
    let provenance: SlotContentSetProvenanceV2;
    if (pv.kind === 'generated') {
      ex(pv, ['kind', 'producer', 'contentRevisionCommitCoreRef', 'contentCommitValidatorAggregateRef', 'contentCommitWarningRootRef', 'committedByAttemptId'], 'provenance');
      const prod = rec(pv.producer, 'producer');
      ex(prod, ['kind', 'planRevisionId', 'batchOrdinal', 'attemptId'], 'producer');
      if (prod.kind !== 'generation_batch' && prod.kind !== 'content_repair_batch') throw new SchemaError('producer.kind must be generation_batch|content_repair_batch');
      provenance = {
        kind: 'generated',
        producer: {
          kind: prod.kind as 'generation_batch' | 'content_repair_batch',
          planRevisionId: str(prod.planRevisionId, 'planRevisionId'),
          batchOrdinal: onn(prod.batchOrdinal, 'batchOrdinal'),
          attemptId: str(prod.attemptId, 'attemptId'),
        },
        contentRevisionCommitCoreRef: rfKind(pv.contentRevisionCommitCoreRef, 'content_revision_commit_core', 'contentRevisionCommitCoreRef'),
        contentCommitValidatorAggregateRef: rfKind(pv.contentCommitValidatorAggregateRef, 'validator_aggregate', 'contentCommitValidatorAggregateRef'),
        contentCommitWarningRootRef: rfKind(pv.contentCommitWarningRootRef, 'validation_warning_custody_root', 'contentCommitWarningRootRef'),
        committedByAttemptId: str(pv.committedByAttemptId, 'committedByAttemptId'),
      };
    } else if (pv.kind === 'inherited_after_map_activation') {
      ex(pv, ['kind', 'sourceVersionRef', 'contentMigrationSettlementCoreRef', 'compatibilityProofRef', 'localValidatorEquivalenceProofRef', 'migratedBatchValidatorAggregateRef', 'migratedBatchWarningRootRef', 'migrationReason'], 'provenance');
      if (pv.migrationReason !== 'stable_slot_and_schema_compatible') throw new SchemaError('inherited migrationReason must be stable_slot_and_schema_compatible');
      provenance = {
        kind: 'inherited_after_map_activation',
        sourceVersionRef: rfKind(pv.sourceVersionRef, 'content_version', 'sourceVersionRef'),
        contentMigrationSettlementCoreRef: rfKind(pv.contentMigrationSettlementCoreRef, 'migration_settlement_core', 'contentMigrationSettlementCoreRef'),
        compatibilityProofRef: rfKind(pv.compatibilityProofRef, 'content_compatibility_proof', 'compatibilityProofRef'),
        localValidatorEquivalenceProofRef: rfn(pv.localValidatorEquivalenceProofRef, 'localValidatorEquivalenceProofRef'),
        migratedBatchValidatorAggregateRef: rfn(pv.migratedBatchValidatorAggregateRef, 'migratedBatchValidatorAggregateRef'),
        migratedBatchWarningRootRef: rfn(pv.migratedBatchWarningRootRef, 'migratedBatchWarningRootRef'),
        migrationReason: 'stable_slot_and_schema_compatible',
      };
    } else {
      throw new SchemaError('set provenance.kind must be generated|inherited_after_map_activation');
    }
    const blobRef = rf(o.blobRef, 'blobRef');
    if (blobRef.kind !== 'content_value') throw new SchemaError('blobRef must be a content_value ref');
    const contentDigest = hx(o.contentDigest, 'contentDigest');
    if (contentDigest !== blobRef.digest) throw new SchemaError('contentDigest is a display alias and must equal blobRef.digest');
    return {
      state: 'set',
      ...common(),
      contentDigest,
      blobRef,
      provenance,
    } as SlotContentVersionV2;
  }
  throw new SchemaError('content_version.state must be unset|rewrite_required|set');
}

export { parseSlotVersion };

/* contribution_manifest ------------------------------------------ */
export function parseContributionManifest(value: unknown): ContributionManifestV2 {
  const o = rec(value, 'contribution_manifest');
  ex(o, ['contributionManifestId', 'producerKind', 'planId', 'planRevision', 'orderedChunkOrBatchRefs', 'stagingRootRef', 'keyLedgerRefs', 'agentAttemptIdentities', 'manifestDigest'], 'contribution_manifest');
  const producerKind = str(o.producerKind, 'producerKind');
  if (producerKind !== 'map_build' && producerKind !== 'repair') throw new SchemaError('producerKind must be map_build|repair');
  const out: ContributionManifestV2 = {
    contributionManifestId: str(o.contributionManifestId, 'contributionManifestId'),
    producerKind: producerKind as ContributionManifestV2['producerKind'],
    planId: str(o.planId, 'planId'),
    planRevision: onn(o.planRevision, 'planRevision'),
    orderedChunkOrBatchRefs: rfa(o.orderedChunkOrBatchRefs, 'orderedChunkOrBatchRefs'),
    stagingRootRef: rfn(o.stagingRootRef, 'stagingRootRef'),
    keyLedgerRefs: rfa(o.keyLedgerRefs, 'keyLedgerRefs'),
    agentAttemptIdentities: (o.agentAttemptIdentities as unknown[]).map((v, i) => {
      const e = rec(v, `agentAttemptIdentities[${i}]`);
      ex(e, ['workItemId', 'attemptId'], `agentAttemptIdentities[${i}]`);
      return { workItemId: str(e.workItemId, 'workItemId'), attemptId: str(e.attemptId, 'attemptId') };
    }),
    manifestDigest: '',
  };
  hs(out, o.manifestDigest, 'manifestDigest', 'contribution_manifest');
  return { ...out, manifestDigest: hx(o.manifestDigest, 'manifestDigest') };
}

/* failure_recovery_payload (§10.3.1 exact; no invented blob kinds)  */
export function parseFailureRecoveryPayload(value: unknown): Record<string, unknown> {
  const o = rec(value, 'failure_recovery_payload');
  const kind = str(o.kind, 'kind');
  const SYSTEM_KINDS = ['system_map_finalize', 'system_generation_finalize', 'system_repair_finalize', 'system_migration_validation_batch', 'system_review_settlement', 'system_seal'];
  const RECIPES = ['retry_system_command', 'restart_review_cycle', 'rebuild_missing_work'];
  if (!(RECIPES as readonly string[]).includes(kind)) throw new SchemaError('failure_recovery_payload.kind must be retry_system_command|restart_review_cycle|rebuild_missing_work');
  if (kind === 'retry_system_command') {
    ex(o, ['kind', 'failedWorkItemId', 'failedCommandId', 'failedLeaseEpoch', 'terminalEventId', 'terminalCommitId', 'authorityBaseRef', 'systemKind', 'systemPayloadRef'], 'failure_recovery_payload');
    if (!(SYSTEM_KINDS as readonly string[]).includes(str(o.systemKind, 'systemKind'))) throw new SchemaError('systemKind must be a system WorkItem kind');
    return {
      kind,
      failedWorkItemId: str(o.failedWorkItemId, 'failedWorkItemId'),
      failedCommandId: str(o.failedCommandId, 'failedCommandId'),
      failedLeaseEpoch: onn(o.failedLeaseEpoch, 'failedLeaseEpoch'),
      terminalEventId: str(o.terminalEventId, 'terminalEventId'),
      terminalCommitId: str(o.terminalCommitId, 'terminalCommitId'),
      authorityBaseRef: rf(o.authorityBaseRef, 'authorityBaseRef'),
      systemKind: str(o.systemKind, 'systemKind'),
      systemPayloadRef: rf(o.systemPayloadRef, 'systemPayloadRef'),
    };
  }
  if (kind === 'restart_review_cycle') {
    ex(o, ['kind', 'track', 'failedWorkItemId', 'failedAttemptOrCommandId', 'failedLeaseEpoch', 'terminalEventId', 'terminalCommitId', 'authorityBaseRef', 'rejectedSubjectRef', 'findingSetRef', 'failedCycleOrdinal'], 'failure_recovery_payload');
    if (o.track !== 'map' && o.track !== 'content') throw new SchemaError('track must be map|content');
    const fss = rf(o.findingSetRef, 'findingSetRef');
    if (fss.kind !== 'finding_set') throw new SchemaError('findingSetRef must be a finding_set ref');
    return {
      kind,
      track: o.track,
      failedWorkItemId: str(o.failedWorkItemId, 'failedWorkItemId'),
      failedAttemptOrCommandId: str(o.failedAttemptOrCommandId, 'failedAttemptOrCommandId'),
      failedLeaseEpoch: onn(o.failedLeaseEpoch, 'failedLeaseEpoch'),
      terminalEventId: str(o.terminalEventId, 'terminalEventId'),
      terminalCommitId: str(o.terminalCommitId, 'terminalCommitId'),
      authorityBaseRef: rf(o.authorityBaseRef, 'authorityBaseRef'),
      rejectedSubjectRef: rf(o.rejectedSubjectRef, 'rejectedSubjectRef'),
      findingSetRef: fss,
      failedCycleOrdinal: onn(o.failedCycleOrdinal, 'failedCycleOrdinal'),
    };
  }
  ex(o, ['kind', 'predecessorResultRef', 'expectedSuccessorKind', 'expectedSuccessorPayloadRef', 'authorityBaseRef', 'grantSpecInputRef'], 'failure_recovery_payload');
  return {
    kind,
    predecessorResultRef: rf(o.predecessorResultRef, 'predecessorResultRef'),
    expectedSuccessorKind: str(o.expectedSuccessorKind, 'expectedSuccessorKind'),
    expectedSuccessorPayloadRef: rf(o.expectedSuccessorPayloadRef, 'expectedSuccessorPayloadRef'),
    authorityBaseRef: rf(o.authorityBaseRef, 'authorityBaseRef'),
    grantSpecInputRef: rfn(o.grantSpecInputRef, 'grantSpecInputRef'),
  };
}

/* finding --------------------------------------------------------- */
const DEFECT = ['content', 'map', 'mixed'] as const;
const SEVERITY = ['blocking', 'advisory'] as const;
const SOURCE = ['reviewer', 'system_validator'] as const;
const F_STATUS = ['open', 'repair_planned', 'repair_dispatched', 'addressed', 'verified_closed'] as const;
const STAGE_STATE = ['not_required', 'pending', 'committed', 'verified'] as const;

export function parseFinding(value: unknown): FindingV2 {
  const o = rec(value, 'finding');
  ex(o, ['findingId', 'reviewContext', 'primaryLocation', 'relatedSlotIds', 'relatedRelationIds', 'defectClass', 'severity', 'source', 'evidence', 'suggestedRepairSlotIds', 'status', 'repairProgress', 'openedBy'], 'finding');
  const rc = rec(o.reviewContext, 'reviewContext');
  ex(rc, ['kind', 'roundId'], 'reviewContext');
  if (rc.kind !== 'map' && rc.kind !== 'content') throw new SchemaError('reviewContext.kind must be map|content');
  const pl = rec(o.primaryLocation, 'primaryLocation');
  ex(pl, ['kind', 'id'], 'primaryLocation');
  if (pl.kind !== 'slot' && pl.kind !== 'relation' && pl.kind !== 'map_node' && pl.kind !== 'map') throw new SchemaError('primaryLocation.kind unknown');
  const severity = str(o.severity, 'severity');
  if (!(SEVERITY as readonly string[]).includes(severity)) throw new SchemaError('severity unknown');
  const defectClass = str(o.defectClass, 'defectClass');
  if (!(DEFECT as readonly string[]).includes(defectClass)) throw new SchemaError('defectClass unknown');
  const source = str(o.source, 'source');
  if (!(SOURCE as readonly string[]).includes(source)) throw new SchemaError('source unknown');
  const status = str(o.status, 'status');
  if (!(F_STATUS as readonly string[]).includes(status)) throw new SchemaError('status unknown');
  const rp = rec(o.repairProgress, 'repairProgress');
  ex(rp, ['map', 'content'], 'repairProgress');
  const mapStage = str(rp.map, 'repairProgress.map');
  const contentStage = str(rp.content, 'repairProgress.content');
  if (!(STAGE_STATE as readonly string[]).includes(mapStage) || !(STAGE_STATE as readonly string[]).includes(contentStage)) throw new SchemaError('repairProgress stage unknown');
  const ob = rec(o.openedBy, 'openedBy');
  let openedBy: FindingV2['openedBy'];
  if (source === 'reviewer') {
    ex(ob, ['kind', 'reviewerAttemptId'], 'openedBy');
    if (ob.kind !== 'reviewer') throw new SchemaError('openedBy.kind must match source reviewer');
    openedBy = { kind: 'reviewer', reviewerAttemptId: str(ob.reviewerAttemptId, 'reviewerAttemptId') };
  } else {
    ex(ob, ['kind', 'validatorExecutionId'], 'openedBy');
    if (ob.kind !== 'system_validator') throw new SchemaError('openedBy.kind must match source system_validator');
    openedBy = { kind: 'system_validator', validatorExecutionId: str(ob.validatorExecutionId, 'validatorExecutionId') };
  }
  return {
    findingId: str(o.findingId, 'findingId'),
    reviewContext: { kind: rc.kind as 'map' | 'content', roundId: str(rc.roundId, 'roundId') },
    primaryLocation: { kind: pl.kind as FindingV2['primaryLocation']['kind'], id: str(pl.id, 'primaryLocation.id') },
    relatedSlotIds: sa(o.relatedSlotIds, 'relatedSlotIds'),
    relatedRelationIds: sa(o.relatedRelationIds, 'relatedRelationIds'),
    defectClass: defectClass as FindingV2['defectClass'],
    severity: severity as FindingV2['severity'],
    source: source as FindingV2['source'],
    evidence: parseEvidenceList(o.evidence, 'evidence'),
    suggestedRepairSlotIds: sa(o.suggestedRepairSlotIds, 'suggestedRepairSlotIds'),
    status: status as FindingV2['status'],
    repairProgress: { map: mapStage as FindingV2['repairProgress']['map'], content: contentStage as FindingV2['repairProgress']['content'] },
    openedBy,
  };
}

/* finding_set ----------------------------------------------------- */
export function parseFindingSet(value: unknown): FindingSetV2 {
  const o = rec(value, 'finding_set');
  ex(o, ['findingSetId', 'findingRefs', 'setDigest'], 'finding_set');
  const refs = rfaKind(o.findingRefs, 'finding', 'findingRefs');
  for (let i = 1; i < refs.length; i++) {
    if (refs[i - 1].digest >= refs[i].digest) throw new SchemaError('finding_set.findingRefs must be sorted by digest');
  }
  const out: FindingSetV2 = { findingSetId: str(o.findingSetId, 'findingSetId'), findingRefs: refs, setDigest: '' };
  hs(out, o.setDigest, 'setDigest', 'finding_set');
  return { ...out, setDigest: hx(o.setDigest, 'setDigest') };
}

/* finding_stage_root ---------------------------------------------- */
export function parseFindingStageRoot(value: unknown): FindingStageRootV2 {
  const o = rec(value, 'finding_stage_root');
  ex(o, ['rootId', 'roundId', 'entries', 'rootDigest'], 'finding_stage_root');
  const entries = (o.entries as unknown[]).map((v, i) => {
    const e = rec(v, `entries[${i}]`);
    ex(e, ['findingId', 'repairStage', 'state'], `entries[${i}]`);
    if (e.repairStage !== 'map' && e.repairStage !== 'content') throw new SchemaError('repairStage unknown');
    if (e.state !== 'pending' && e.state !== 'committed' && e.state !== 'verified') throw new SchemaError('state unknown');
    return { findingId: str(e.findingId, 'findingId'), repairStage: e.repairStage as 'map' | 'content', state: e.state as 'pending' | 'committed' | 'verified' };
  });
  const ids = entries.map((e) => e.findingId);
  for (let i = 1; i < ids.length; i++) {
    if (ids[i - 1] >= ids[i]) throw new SchemaError('finding_stage_root.entries must be sorted by findingId');
  }
  const out: FindingStageRootV2 = { rootId: str(o.rootId, 'rootId'), roundId: str(o.roundId, 'roundId'), entries, rootDigest: '' };
  hs(out, o.rootDigest, 'rootDigest', 'finding_stage_root');
  return { ...out, rootDigest: hx(o.rootDigest, 'rootDigest') };
}

/* finding_verification_record ------------------------------------- */
export function parseFindingVerificationRecord(value: unknown): FindingVerificationRecordV2 {
  const o = rec(value, 'finding_verification_record');
  ex(o, ['recordId', 'reviewContext', 'assignmentId', 'findingId', 'repairStage', 'verdict', 'candidateId', 'mapId', 'mapContextDigests', 'evidenceSlotDigests', 'reviewPolicyDigest', 'evidence', 'reviewerAttemptId'], 'finding_verification_record');
  const rc = rec(o.reviewContext, 'reviewContext');
  ex(rc, ['kind', 'roundId'], 'reviewContext');
  if (rc.kind !== 'map' && rc.kind !== 'content') throw new SchemaError('reviewContext.kind unknown');
  if (o.repairStage !== 'map' && o.repairStage !== 'content') throw new SchemaError('repairStage unknown');
  if (o.verdict !== 'resolved' && o.verdict !== 'still_present') throw new SchemaError('verdict must be resolved|still_present');
  const md = rec(o.mapContextDigests, 'mapContextDigests');
  const ed = rec(o.evidenceSlotDigests, 'evidenceSlotDigests');
  for (const k of Object.keys(md)) if (!/^[0-9a-f]{64}$/.test(str(md[k], 'mapContextDigests'))) throw new SchemaError('mapContextDigests entries must be SHA-256 hex');
  for (const k of Object.keys(ed)) if (!/^[0-9a-f]{64}$/.test(str(ed[k], 'evidenceSlotDigests'))) throw new SchemaError('evidenceSlotDigests entries must be SHA-256 hex');
  return {
    recordId: str(o.recordId, 'recordId'),
    reviewContext: { kind: rc.kind as 'map' | 'content', roundId: str(rc.roundId, 'roundId') },
    assignmentId: str(o.assignmentId, 'assignmentId'),
    findingId: str(o.findingId, 'findingId'),
    repairStage: o.repairStage as 'map' | 'content',
    verdict: o.verdict as 'resolved' | 'still_present',
    candidateId: oStr(o.candidateId, 'candidateId'),
    mapId: oStr(o.mapId, 'mapId'),
    mapContextDigests: md as Readonly<Record<string, string>>, evidenceSlotDigests: ed as Readonly<Record<string, string>>,
    reviewPolicyDigest: hx(o.reviewPolicyDigest, 'reviewPolicyDigest'),
    evidence: parseEvidenceList(o.evidence, 'evidence'),
    reviewerAttemptId: str(o.reviewerAttemptId, 'reviewerAttemptId'),
  };
}