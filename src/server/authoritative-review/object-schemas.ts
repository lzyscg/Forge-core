/**
 * Task 3 object-schemas: assembles the closed per-kind registration table
 * behind `object-registry.ts` (spec §7.1/§8; design §10/§11/§13/§16/§17).
 * Every member of `AuthoritativeBlobKindV2` appears exactly once; the
 * `Record` type enforces exhaustiveness at compile time.
 *
 * Pure module: no fs/EventStore/provider/HTTP/React, no wall clock, no random.
 */
import { AUTHORITATIVE_REVIEW_PROFILE_SNAPSHOT_MAX_BYTES } from './object-schema-parsers-3-constants';
import type { AuthoritativeBlobKindV2, BlobRefV2 } from '../../shared/authoritative-review-v2';
import { canonicalJsonSha256 } from '../structured-slots/canonical-json';
import type { AuthoritativeReviewProfile, BlobKindByteLimits } from './authority-types';
import { everyEmbeddedRef } from './schema-common';
import {
  parseArtifact,
  parseAssignmentDispatch,
  parseAuthorityBaseSet,
  parseContentCompatibilityProof,
  parseContentPlanFinalizeCore,
  parseContentRevisionCommitCoreBlob,
  parseContentRevisionManifest,
  parseContentReviewCoverageCore,
  parseContentReviewSettlementCore,
  parseContentValue,
  parseContributionManifest,
  parseFailureRecoveryPayload,
  parseFinding,
  parseFindingSet,
  parseFindingStageRoot,
  parseFindingVerificationRecord,
  parseSlotVersion,
} from './object-schema-parsers-1';
import {
  parseContentMigrationIntentCore,
  parseContentMigrationSettlementCore,
  parseContentMigrationSpec,
  parseContentMigrationValidationPlanSpec,
  parseGenerationPlanSpec,
  parseGrantInstance,
  parseLocalValidatorEquivalenceProof,
  parseMapBuildChunk,
  parseMapBuildKeyLedger,
  parseMapBuildManifest,
  parseMapBuildSpec,
  parseMapCandidate,
  parseMapCandidateValidationCore,
  parseMapReviewBundle,
  parseMapReviewCoverageCore,
  parseMapReviewRound,
  parseMapReviewSettlementCore,
  parseMapSnapshot,
  parseMigrationActivationDecision,
  parseMigrationValidationBatchResult,
  parseProposedMapCore,
} from './object-schema-parsers-2';
import {
  parseProfileSnapshotObject,
  parseProjectionCheckpoint,
  parsePublicationOperationPayload,
  parseRepairKeyLedger,
  parseRepairPlanSpec,
  parseRepairStagingRoot,
  parseReviewAdoptionLedger,
  parseReviewAdoptionRoot,
  parseReviewAssignmentLedger,
  parseReviewBundle,
  parseReviewFact,
  parseRoundBudgetOverride,
  parseSealRecord,
  parseSealValidationBundle,
  parseSystemArtifactDelivery,
  parseValidationReceipt,
  parseValidationWarningCustodyRoot,
  parseValidationWarningRoot,
  parseValidatorAggregate,
  parseValidatorFailure,
  parseValidatorInputEnvelope,
  parseWriteGrantSpec,
} from './object-schema-parsers-3';

export { parseProfileSnapshotObject };
export { AUTHORITATIVE_REVIEW_PROFILE_SNAPSHOT_MAX_BYTES as PROFILE_SNAPSHOT_BOOTSTRAP_MAX_BYTES };


/**
 * Task-11 A-M1 / Ruling-2 HARD GATE: the frozen projection carries no field
 * for the round-limit reopen's attempt-private imported staging manifest (and
 * no active candidate/Map/manifest before the first activation), so the
 * lifecycle publishes EXPLICIT PLACEHOLDER refs for those plan-base fields.
 * A placeholder digest is `canonicalJsonSha256({ placeholder: literal })` for
 * one of the three fixed literals below — it NEVER exists on disk, and
 * neither GC mark nor an attempt lease may resolve it (that would be a
 * permanent TASK_CORRUPTED abort). Task 13 replaces every placeholder with a
 * REAL projection ref in the same release that removes this predicate.
 */
export const REOPEN_PLACEHOLDER_LITERALS = [
  'repairBase:map',
  'repairBase:manifest',
  'staging:imported',
] as const;

/** True when `ref` is one of the fixed reopen placeholders (never resolved). */
export function isReopenPlaceholderRef(ref: BlobRefV2): boolean {
  return REOPEN_PLACEHOLDER_LITERALS.some(
    (literal) => ref.digest === canonicalJsonSha256({ placeholder: literal }),
  );
}




export interface BlobSchemaRegistration<T = unknown> {
  kind: AuthoritativeBlobKindV2;
  schemaVersion: number;
  mediaType: BlobRefV2['mediaType'];
  parse(value: unknown): T;
  childRefs(value: T): readonly BlobRefV2[];
  maxBytes(profile: AuthoritativeReviewProfile): number;
}

function reg<T>(
  kind: AuthoritativeBlobKindV2,
  parse: (value: unknown) => T,
  opts?: { mediaType?: BlobRefV2['mediaType']; maxBytes?: (profile: AuthoritativeReviewProfile) => number },
): BlobSchemaRegistration<T> {
  return {
    kind,
    schemaVersion: 1,
    mediaType: opts?.mediaType ?? 'application/json',
    parse,
    childRefs: (value: T): readonly BlobRefV2[] => {
      const out: BlobRefV2[] = [];
      everyEmbeddedRef(value as unknown, out);
      return out;
    },
    maxBytes: opts?.maxBytes ?? ((profile) => profile.maxBytesByKind[kind]),
  };
}

/**
 * The closed 59-member registration table. TypeScript enforces that every
 * `AuthoritativeBlobKindV2` member is present — a missing kind is a compile
 * error, and `parseBlob` rejects any unregistered kind at runtime.
 */
export const registrations: Readonly<Record<AuthoritativeBlobKindV2, BlobSchemaRegistration<unknown>>> = {
  artifact: reg('artifact', parseArtifact, { mediaType: 'text/markdown' }),
  assignment_dispatch: reg('assignment_dispatch', parseAssignmentDispatch),
  authority_base_set: reg('authority_base_set', parseAuthorityBaseSet),
  content_compatibility_proof: reg('content_compatibility_proof', parseContentCompatibilityProof),
  content_plan_finalize_core: reg('content_plan_finalize_core', parseContentPlanFinalizeCore),
  content_revision_commit_core: reg('content_revision_commit_core', parseContentRevisionCommitCoreBlob),
  content_revision_manifest: reg('content_revision_manifest', parseContentRevisionManifest),
  content_review_coverage_core: reg('content_review_coverage_core', parseContentReviewCoverageCore),
  content_review_settlement_core: reg('content_review_settlement_core', parseContentReviewSettlementCore),
  content_value: reg('content_value', parseContentValue),
  content_version: reg('content_version', parseSlotVersion),
  contribution_manifest: reg('contribution_manifest', parseContributionManifest),
  failure_recovery_payload: reg('failure_recovery_payload', parseFailureRecoveryPayload),
  finding: reg('finding', parseFinding),
  finding_set: reg('finding_set', parseFindingSet),
  finding_stage_root: reg('finding_stage_root', parseFindingStageRoot),
  finding_verification_record: reg('finding_verification_record', parseFindingVerificationRecord),
  generation_plan_spec: reg('generation_plan_spec', parseGenerationPlanSpec),
  grant_instance: reg('grant_instance', parseGrantInstance),
  local_validator_equivalence_proof: reg('local_validator_equivalence_proof', parseLocalValidatorEquivalenceProof),
  map_build_chunk: reg('map_build_chunk', parseMapBuildChunk),
  map_build_key_ledger: reg('map_build_key_ledger', parseMapBuildKeyLedger),
  map_build_manifest: reg('map_build_manifest', parseMapBuildManifest),
  map_build_spec: reg('map_build_spec', parseMapBuildSpec),
  map_candidate: reg('map_candidate', parseMapCandidate),
  map_candidate_validation_core: reg('map_candidate_validation_core', parseMapCandidateValidationCore),
  map_review_bundle: reg('map_review_bundle', parseMapReviewBundle),
  map_review_coverage_core: reg('map_review_coverage_core', parseMapReviewCoverageCore),
  map_review_round: reg('map_review_round', parseMapReviewRound),
  map_review_settlement_core: reg('map_review_settlement_core', parseMapReviewSettlementCore),
  map_snapshot: reg('map_snapshot', parseMapSnapshot),
  migration_activation_decision: reg('migration_activation_decision', parseMigrationActivationDecision),
  migration_intent_core: reg('migration_intent_core', parseContentMigrationIntentCore),
  migration_settlement_core: reg('migration_settlement_core', parseContentMigrationSettlementCore),
  migration_spec: reg('migration_spec', parseContentMigrationSpec),
  migration_validation_batch_result: reg('migration_validation_batch_result', parseMigrationValidationBatchResult),
  migration_validation_plan_spec: reg('migration_validation_plan_spec', parseContentMigrationValidationPlanSpec),
  profile_snapshot: reg('profile_snapshot', parseProfileSnapshotObject, {
    maxBytes: () => AUTHORITATIVE_REVIEW_PROFILE_SNAPSHOT_MAX_BYTES,
  }),
  projection_checkpoint: reg('projection_checkpoint', parseProjectionCheckpoint),
  proposed_map_core: reg('proposed_map_core', parseProposedMapCore),
  publication_operation_payload: reg('publication_operation_payload', parsePublicationOperationPayload),
  repair_key_ledger: reg('repair_key_ledger', parseRepairKeyLedger),
  repair_plan_spec: reg('repair_plan_spec', parseRepairPlanSpec),
  repair_staging_root: reg('repair_staging_root', parseRepairStagingRoot),
  review_adoption_ledger: reg('review_adoption_ledger', parseReviewAdoptionLedger),
  review_adoption_root: reg('review_adoption_root', parseReviewAdoptionRoot),
  review_assignment_ledger: reg('review_assignment_ledger', parseReviewAssignmentLedger),
  review_bundle: reg('review_bundle', parseReviewBundle),
  review_fact: reg('review_fact', parseReviewFact),
  round_budget_override: reg('round_budget_override', parseRoundBudgetOverride),
  seal_record: reg('seal_record', parseSealRecord),
  seal_validation_bundle: reg('seal_validation_bundle', parseSealValidationBundle),
  system_artifact_delivery: reg('system_artifact_delivery', parseSystemArtifactDelivery),
  validation_receipt: reg('validation_receipt', parseValidationReceipt),
  validation_warning_custody_root: reg('validation_warning_custody_root', parseValidationWarningCustodyRoot),
  validation_warning_root: reg('validation_warning_root', parseValidationWarningRoot),
  validator_aggregate: reg('validator_aggregate', parseValidatorAggregate),
  validator_failure: reg('validator_failure', parseValidatorFailure),
  validator_input_envelope: reg('validator_input_envelope', parseValidatorInputEnvelope),
  write_grant_spec: reg('write_grant_spec', parseWriteGrantSpec),
};

/** Default per-kind byte caps used by `fullProfileForTests` (4 MiB each). */
export function defaultMaxBytesByKind(): BlobKindByteLimits {
  const out = {} as Record<AuthoritativeBlobKindV2, number>;
  for (const kind of Object.keys(registrations) as AuthoritativeBlobKindV2[]) {
    out[kind] = 4 * 1024 * 1024;
  }
  return out;
}

/**
 * Test profile honoring the qualified floor (design §22/§12.3; spec §16.1).
 * Task 5's concrete production profile must satisfy the same interface.
 */
export function fullProfileForTests(overrides: Partial<AuthoritativeReviewProfile> = {}): AuthoritativeReviewProfile {
  return {
    maxBytesByKind: defaultMaxBytesByKind(),
    maxSlots: 10_000,
    maxRelationTotal: 50_000,
    maxRelationsPerSlot: 16,
    maxRelationHops: 3,
    maxClosureNodes: 8_192,
    assignmentMaxPrimaryTargets: 256,
    assignmentMaxTotalObjects: 1_024,
    maxFindingsPerPrimaryTarget: 8,
    maxFindingsPerRound: 1_024,
    evidenceMaxBytesPerItem: 8_192,
    evidenceMaxBytesTotal: 262_144,
    maxRepairGrantWriteSlots: 256,
    maxScopeExpansionsPerRound: 4,
    maxRoundsPerTrack: 8,
    maxPlannedWorkItemsPerRound: 2_000,
    maxConsecutiveAttemptsWithoutProgress: 3,
    maxActiveLeasesPerTask: 1,
    mapChunkMaxNodes: 512,
    mapChunkMaxRelations: 64,
    ...overrides,
  };
}
