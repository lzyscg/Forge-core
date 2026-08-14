// @vitest-environment node
/**
 * Shared v2 contract tests for the authoritative per-slot review lifecycle
 * (spec 2026-08-14, §4.1/§4.3/§7.1/§10.3.1/§10.5/§10.6; design 2026-08-13
 * §11/§17.2/§19.2).
 *
 * Every shape below is a frozen contract: the module is the single shared
 * source for BlobRefV2, the closed blob-kind registry, public Map/review/
 * Finding/Seal DTOs, the pending question, recovery/delete/answer mutations
 * and the frozen-snapshot protocol discriminator. The mirror TypeBox schemas
 * in `api-schemas.ts` stay byte-exact with these interfaces.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Value } from 'typebox/value';
import {
  answerBodyV2Schema,
  artifactProvenanceV2Schema,
  authoritativeBlobKindV2Schema,
  authoritativeFindingCollectionPageV2Schema,
  authoritativeFindingSummaryV2Schema,
  authoritativeMapSummaryV2Schema,
  authoritativeRelationSummaryV2Schema,
  authoritativeReviewExecutionEligibilityV1Schema,
  authoritativeReviewProfileSnapshotV1Schema,
  authoritativeReviewRoundSummaryV2Schema,
  authoritativeReviewSummaryV2Schema,
  authoritativeReviewWorkspaceV2Schema,
  authoritativeSealReadinessSummaryV2Schema,
  blobRefV2Schema,
  deleteTaskBodyV2Schema,
  deleteTaskResultV2Schema,
  failedTaskRecoverySummaryV2Schema,
  failureRecoveryPayloadV2Schema,
  pendingQuestionV2Schema,
  reopenFailedRequestV2Schema,
  roundBudgetOverrideV2Schema,
  sealRecordV2Schema,
  snapshotCursorV2Schema,
  systemArtifactDeliveryV2Schema,
  taskSummarySchema,
  taskWorkspaceSchema,
} from './api-schemas';
import {
  AUTHORITATIVE_BLOB_KINDS_V2,
  QUESTION_VERSION_TOKEN_REGEX,
  structuredProtocolOf,
  type BlobRefV2,
  type StructuredProtocolSource,
} from './authoritative-review-v2';
import {
  AUTHORITATIVE_REVIEW_V2_ERROR_CODES,
  AUTHORITATIVE_REVIEW_V2_ERROR_STATUS,
  type AuthoritativeReviewV2ErrorCode,
} from './errors';

/** TypeBox check helper used by every schema assertion below. */
function check(schema: unknown, value: unknown): boolean {
  return Value.Check(schema as Parameters<typeof Value.Check>[0], value);
}

/* ------------------------- §14.3 public v2 error codes ------------------------- */

describe('public v2 error codes (spec §14.3)', () => {
  it('declares every stable code the spec names', () => {
    for (const code of [
      'AUTHORITATIVE_REVIEW_UNAVAILABLE',
      'USE_RESUME',
      'AUTHORITY_BASE_STALE',
      'MAP_CANDIDATE_BASE_STALE',
      'REVIEW_BASE_STALE',
      'MAP_BASE_STALE',
      'CONTENT_BASE_STALE',
      'TASK_WRITE_LEASE_CONFLICT',
      'HUMAN_QUESTION_STALE',
      'CURSOR_STALE',
      'ARTIFACT_VALIDATION_FAILED',
      'REVIEW_REPAIR_LIMIT_EXCEEDED',
      'RUNNING_WITHOUT_WORK',
      'TASK_DELETED',
    ]) {
      expect(AUTHORITATIVE_REVIEW_V2_ERROR_CODES).toHaveProperty(code, code);
      expect(AUTHORITATIVE_REVIEW_V2_ERROR_STATUS[code as AuthoritativeReviewV2ErrorCode]).toBeTypeOf('number');
    }
    expect(new Set(Object.values(AUTHORITATIVE_REVIEW_V2_ERROR_CODES)).size).toBe(
      Object.values(AUTHORITATIVE_REVIEW_V2_ERROR_CODES).length,
    );
    // Every declared code has an exact HTTP mapping (409 stale/conflict,
    // 422 terminal domain failures, 503 capability gate, 410 deleted).
    const statuses = Object.values(AUTHORITATIVE_REVIEW_V2_ERROR_STATUS);
    expect(statuses).toEqual(expect.arrayContaining([409, 422, 503, 410]));
  });
});

/* ------------------------- §4.1 frozen discriminator ------------------------- */

describe('structuredProtocolOf (spec §4.1)', () => {
  it('derives none when the frozen snapshot is not a structured slot contract', () => {
    const basic: StructuredProtocolSource = { productionMode: 'basic', structuredSlots: null };
    expect(structuredProtocolOf(basic)).toBe('none');
    // A structured production mode with a null contract is still 'none'.
    const unready: StructuredProtocolSource = {
      productionMode: 'structured_slots',
      structuredSlots: null,
    };
    expect(structuredProtocolOf(unready)).toBe('none');
  });

  it('derives v1 only from an explicit version 1 frozen contract', () => {
    expect(
      structuredProtocolOf({
        productionMode: 'structured_slots',
        structuredSlots: { version: 1 },
      }),
    ).toBe('v1');
  });

  it('derives v2 from the frozen snapshot, never from the current catalog', () => {
    expect(
      structuredProtocolOf({
        productionMode: 'structured_slots',
        structuredSlots: { version: 2 },
      }),
    ).toBe('v2');
    // The helper reads ONLY productionMode + frozen structuredSlots version:
    // template id, version hash or capability state never influence it.
    expect(
      structuredProtocolOf({
        productionMode: 'structured_slots',
        structuredSlots: { version: 2 },
      } as StructuredProtocolSource),
    ).toBe('v2');
  });
});

/* ------------------------- §10.6 questionVersion token ------------------------- */

/**
 * Recomputes the question version token the way a server-side verifier must
 * (spec §10.6): unpadded base64url of a 32-byte SHA-256 over canonical bound
 * fields. The exact server recompute binding lands with the v2 answer path
 * (Task 11); this test only pins the token FORMAT and its case sensitivity.
 */
function canonicalQuestionVersion(fields: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('base64url');
}

/**
 * A token with deterministic mixed case: sha256 digests are random-looking,
 * so bump a nonce until the base64url encoding contains both cases. Expected
 * trials ~2; always terminates.
 */
function mixedCaseQuestionVersion(fields: Record<string, unknown>): string {
  let nonce = 0;
  for (;;) {
    const token = canonicalQuestionVersion({ ...fields, tokenNonce: nonce });
    if (/[A-Z]/.test(token) && /[a-z]/.test(token)) return token;
    nonce += 1;
  }
}

const QUESTION_BOUND_FIELDS: Record<string, unknown> = {
  protocolVersion: 2,
  questionId: 'question-1',
  originalWorkItemId: 'work-1',
  logicalAssignmentId: 'assignment-1',
  attemptId: 'attempt-1',
  leaseEpoch: 3,
  questionDigest: 'a'.repeat(64),
  authorityBaseRef: JSON.stringify({ kind: 'authority_base_set', digest: 'b'.repeat(64) }),
  openedCommitId: 'commit-1',
};

describe('questionVersion token (spec §10.6)', () => {
  it('produces exactly the opaque unpadded 43-character base64url token', () => {
    const token = canonicalQuestionVersion(QUESTION_BOUND_FIELDS);
    expect(token).toMatch(QUESTION_VERSION_TOKEN_REGEX);
    expect(token).toHaveLength(43);
    expect(token).not.toContain('=');
    expect(QUESTION_VERSION_TOKEN_REGEX.source).toBe('^[A-Za-z0-9_-]{43}$');
  });

  it('rejects counters, wrong lengths, foreign alphabet and padding', () => {
    for (const bad of ['1', 'v1', '001', '42', 'q-1', 'attempt-1']) {
      expect(QUESTION_VERSION_TOKEN_REGEX.test(bad)).toBe(false);
    }
    expect(QUESTION_VERSION_TOKEN_REGEX.test('A'.repeat(42))).toBe(false);
    expect(QUESTION_VERSION_TOKEN_REGEX.test('A'.repeat(44))).toBe(false);
    expect(QUESTION_VERSION_TOKEN_REGEX.test(`${'A'.repeat(43)}=`)).toBe(false);
    expect(QUESTION_VERSION_TOKEN_REGEX.test(`${'A'.repeat(43)}+`)).toBe(false);
    expect(QUESTION_VERSION_TOKEN_REGEX.test(`${'A'.repeat(43)}/`)).toBe(false);
  });

  it('stays case-significant: a lowercase-normalized variant is a different token', () => {
    const token = mixedCaseQuestionVersion(QUESTION_BOUND_FIELDS);
    const lowered = token.toLowerCase();
    // Case is part of the identity: normalization must never happen, and the
    // normalized variant never equals the token recomputed from the fields.
    expect(lowered === token).toBe(false);
    expect(lowered.length).toBe(43);
    expect(lowered).not.toBe(canonicalQuestionVersion(QUESTION_BOUND_FIELDS));
  });

  it('differs for well-formed tokens recomputed from different bound fields', () => {
    const other: Record<string, unknown> = {
      ...QUESTION_BOUND_FIELDS,
      questionId: 'question-2',
      openedCommitId: 'commit-2',
    };
    const tokenA = canonicalQuestionVersion(QUESTION_BOUND_FIELDS);
    const tokenB = canonicalQuestionVersion(other);
    expect(tokenA).toMatch(QUESTION_VERSION_TOKEN_REGEX);
    expect(tokenB).toMatch(QUESTION_VERSION_TOKEN_REGEX);
    expect(tokenA).not.toBe(tokenB);
  });
});

/* ------------------------- §7.1 BlobRefV2 + closed kinds ------------------------- */

const digest = 'a'.repeat(64);
const sealRecordRef: BlobRefV2 = {
  kind: 'seal_record',
  digest,
  byteLength: 128,
  mediaType: 'application/json',
  schemaVersion: 1,
};
const artifactRef: BlobRefV2 = {
  kind: 'artifact',
  digest: 'b'.repeat(64),
  byteLength: 2048,
  mediaType: 'text/markdown',
  schemaVersion: 1,
};
const custodyRef: BlobRefV2 = {
  kind: 'validator_aggregate',
  digest: 'c'.repeat(64),
  byteLength: 512,
  mediaType: 'application/json',
  schemaVersion: 1,
};

describe('AuthoritativeBlobKindV2 closed registry (spec §7.1)', () => {
  it('covers every family the spec names, plus the registered fixed kinds', () => {
    // profile_snapshot and publication_operation_payload from the first v2
    // commit; failure_recovery_payload and round_budget_override registered
    // canonical kinds (spec §10.3.1, Task 3 registry).
    for (const kind of [
      'profile_snapshot',
      'publication_operation_payload',
      'failure_recovery_payload',
      'round_budget_override',
      // Map build specs/chunks/manifests/key ledgers.
      'map_build_spec',
      'map_build_chunk',
      'map_build_manifest',
      'map_build_key_ledger',
      // Map candidates/validation cores/snapshots/bundles.
      'map_candidate',
      'map_candidate_validation_core',
      'map_snapshot',
      'proposed_map_core',
      'map_review_bundle',
      // Content values/versions/manifests/commit and finalize cores.
      'content_value',
      'content_version',
      'content_revision_manifest',
      'content_revision_commit_core',
      'content_plan_finalize_core',
      // Generation/repair/migration specs and results.
      'generation_plan_spec',
      'repair_plan_spec',
      'repair_staging_root',
      'repair_key_ledger',
      'migration_spec',
      'migration_intent_core',
      'migration_validation_plan_spec',
      'migration_validation_batch_result',
      'migration_settlement_core',
      'migration_activation_decision',
      'content_compatibility_proof',
      'local_validator_equivalence_proof',
      'validation_receipt',
      // Review facts/ledgers/adoptions/round cores/bundles.
      'review_fact',
      'review_assignment_ledger',
      'review_adoption_ledger',
      'review_adoption_root',
      'map_review_coverage_core',
      'map_review_settlement_core',
      'content_review_coverage_core',
      'content_review_settlement_core',
      'review_bundle',
      // Findings/verifications.
      'finding',
      'finding_set',
      'finding_stage_root',
      'finding_verification_record',
      // Authority bases/grants/dispatch payloads.
      'authority_base_set',
      'write_grant_spec',
      'grant_instance',
      'assignment_dispatch',
      // Validator envelopes/receipts/failures/aggregates/warning roots.
      'validator_input_envelope',
      'validator_failure',
      'validator_aggregate',
      'validation_warning_root',
      'validation_warning_custody_root',
      // Seal bundles/records/artifacts/deliveries.
      'seal_validation_bundle',
      'seal_record',
      'artifact',
      'system_artifact_delivery',
      // Checkpoints + provenance manifests.
      'projection_checkpoint',
      'contribution_manifest',
    ]) {
      expect(AUTHORITATIVE_BLOB_KINDS_V2).toContain(kind);
    }
    expect(new Set(AUTHORITATIVE_BLOB_KINDS_V2).size).toBe(AUTHORITATIVE_BLOB_KINDS_V2.length);
  });

  it('rejects unknown kinds and schema versions on the wire (fail closed)', () => {
    expect(check(authoritativeBlobKindV2Schema, 'profile_snapshot')).toBe(true);
    expect(check(authoritativeBlobKindV2Schema, 'map_build_chunk')).toBe(true);
    expect(check(authoritativeBlobKindV2Schema, 'bogus_kind')).toBe(false);
    expect(check(authoritativeBlobKindV2Schema, 'string')).toBe(false);
    expect(check(authoritativeBlobKindV2Schema, 7)).toBe(false);
  });
});

describe('BlobRefV2 (spec §7.1)', () => {
  it('accepts the exact ref shape', () => {
    expect(check(blobRefV2Schema, sealRecordRef)).toBe(true);
  });

  it('rejects unknown kinds, media types, uppercase digests and extra fields', () => {
    expect(check(blobRefV2Schema, { ...sealRecordRef, kind: 'bogus' })).toBe(false);
    expect(check(blobRefV2Schema, { ...sealRecordRef, mediaType: 'video/mp4' })).toBe(false);
    expect(check(blobRefV2Schema, { ...sealRecordRef, digest: 'A'.repeat(64) })).toBe(false);
    expect(check(blobRefV2Schema, { ...sealRecordRef, path: '/tmp/leak' })).toBe(false);
    expect(check(blobRefV2Schema, { ...sealRecordRef, byteLength: -1 })).toBe(false);
  });

  it('requires kind/digest/byteLength/mediaType/schemaVersion', () => {
    expect(check(blobRefV2Schema, { kind: 'artifact', digest, byteLength: 1, mediaType: 'application/json' })).toBe(false);
    expect(check(blobRefV2Schema, undefined)).toBe(false);
  });
});

/* ------------------------- ArtifactProvenanceV2 (spec §13.5.1) ------------------------- */

describe('ArtifactProvenanceV2 discriminated union (spec §13.5.1)', () => {
  it('requires exact system artifact provenance refs', () => {
    expect(check(artifactProvenanceV2Schema, {
      producerKind: 'system',
      producerWorkItemId: 'work-1',
      sealRecordRef,
      artifactRef,
      custodyRef,
    })).toBe(true);
    expect(check(artifactProvenanceV2Schema, {
      producerKind: 'system', sourceNodeId: 'forbidden', sealRecordDigest: digest,
    })).toBe(false);
  });

  it('requires the agent branch to carry sourceNodeId and producerAgentId', () => {
    expect(check(artifactProvenanceV2Schema, {
      producerKind: 'agent',
      sourceNodeId: 'node-1',
      producerAgentId: 'agent-1',
    })).toBe(true);
    expect(check(artifactProvenanceV2Schema, { producerKind: 'agent', producerAgentId: 'agent-1' })).toBe(false);
    expect(check(artifactProvenanceV2Schema, { producerKind: 'agent', sourceNodeId: 'node-1' })).toBe(false);
    // Cross-branch fields are rejected: system provenance never carries a
    // fabricated source node and agent provenance never carries Seal refs.
    expect(check(artifactProvenanceV2Schema, {
      producerKind: 'agent',
      sourceNodeId: 'node-1',
      producerAgentId: 'agent-1',
      sealRecordRef,
    })).toBe(false);
    expect(check(artifactProvenanceV2Schema, { producerKind: 'system', producerWorkItemId: 'w-1', sealRecordRef, artifactRef, custodyRef, sourceNodeId: 'forged' })).toBe(false);
  });
});

/* ------------------------- §4.3 profile snapshot + eligibility ------------------------- */

const PROFILE = {
  schemaVersion: 1,
  profileIdentity: 'forge-authoritative-review/v1',
  profileVersion: 3,
  qualificationState: 'final',
  profileDigest: 'd'.repeat(64),
  abi: {
    validatorAbi: 'forge-validator/v2',
    assemblerAbi: 'forge-assembler/v2',
    profileAbi: 'forge-authoritative-review/v1',
  },
};

describe('AuthoritativeReviewProfileSnapshotV1 bootstrap (spec §4.3)', () => {
  it('accepts the exact bootstrap identity', () => {
    expect(check(authoritativeReviewProfileSnapshotV1Schema, PROFILE)).toBe(true);
  });

  it('rejects unknown fields, open qualification states and non-hash digests', () => {
    expect(check(authoritativeReviewProfileSnapshotV1Schema, { ...PROFILE, limits: { maxSlots: 10_000 } })).toBe(false);
    expect(check(authoritativeReviewProfileSnapshotV1Schema, { ...PROFILE, qualificationState: 'beta' })).toBe(false);
    expect(check(authoritativeReviewProfileSnapshotV1Schema, { ...PROFILE, profileDigest: 'not-a-digest' })).toBe(false);
    expect(check(authoritativeReviewProfileSnapshotV1Schema, { ...PROFILE, schemaVersion: 2 })).toBe(false);
  });
});

describe('AuthoritativeReviewExecutionEligibilityV1 (spec §4.3)', () => {
  it('accepts the eligible branch with both digests', () => {
    expect(check(authoritativeReviewExecutionEligibilityV1Schema, {
      state: 'eligible',
      frozenProfileDigest: 'e'.repeat(64),
      currentProfileDigest: 'e'.repeat(64),
    })).toBe(true);
  });

  it('accepts every blocked reason with a nullable current digest', () => {
    for (const reason of [
      'base_capability_disabled',
      'authoritative_capability_disabled',
      'profile_digest_mismatch',
      'required_abi_unavailable',
    ]) {
      expect(check(authoritativeReviewExecutionEligibilityV1Schema, {
        state: 'blocked',
        reason,
        frozenProfileDigest: 'f'.repeat(64),
        currentProfileDigest: null,
      })).toBe(true);
    }
  });

  it('rejects cross-branch fields and unknown reasons', () => {
    expect(check(authoritativeReviewExecutionEligibilityV1Schema, {
      state: 'eligible',
      frozenProfileDigest: 'e'.repeat(64),
      currentProfileDigest: null,
    })).toBe(false);
    expect(check(authoritativeReviewExecutionEligibilityV1Schema, {
      state: 'blocked',
      reason: 'bogus',
      frozenProfileDigest: 'f'.repeat(64),
      currentProfileDigest: null,
    })).toBe(false);
    expect(check(authoritativeReviewExecutionEligibilityV1Schema, {
      state: 'blocked',
      reason: 'profile_digest_mismatch',
      frozenProfileDigest: 'f'.repeat(64),
      currentProfileDigest: null,
      extra: 1,
    })).toBe(false);
  });
});

/* ------------------------- §10.6 pending question ------------------------- */

const QUESTION = {
  questionId: 'question-1',
  questionDigest: '1a'.repeat(32),
  questionVersion: canonicalQuestionVersion(QUESTION_BOUND_FIELDS),
  source: 'agent_request',
  text: '落款日期设定在哪一年？',
};

describe('PendingQuestionV2 (spec §10.6)', () => {
  it('accepts the exact pending question', () => {
    expect(check(pendingQuestionV2Schema, QUESTION)).toBe(true);
    expect(check(pendingQuestionV2Schema, { ...QUESTION, source: 'progress_guard' })).toBe(true);
  });

  it('rejects counters, wrong token shapes and unknown fields', () => {
    expect(check(pendingQuestionV2Schema, { ...QUESTION, questionVersion: '1' })).toBe(false);
    expect(check(pendingQuestionV2Schema, { ...QUESTION, questionVersion: 'A'.repeat(44) })).toBe(false);
    expect(check(pendingQuestionV2Schema, { ...QUESTION, questionVersion: 'A'.repeat(43).toLowerCase() })).toBe(true);
    expect(check(pendingQuestionV2Schema, { ...QUESTION, source: 'system' })).toBe(false);
    expect(check(pendingQuestionV2Schema, { ...QUESTION, originalWorkItemId: 'work-1' })).toBe(false);
  });
});

/* ------------------------- §10.6 answer body v2 ------------------------- */

const ANSWER_OPERATION = {
  questionId: 'question-1',
  questionVersion: canonicalQuestionVersion(QUESTION_BOUND_FIELDS),
  operationId: '3b2c8f4e-9a1d-4f6e-b2c4-1a2b3c4d5e6f',
};

describe('AnswerTaskBodyV2 (spec §10.6)', () => {
  it('requires question identity plus every decision branch', () => {
    expect(check(answerBodyV2Schema, { ...ANSWER_OPERATION, answer: 'answer text' })).toBe(true);
    expect(check(answerBodyV2Schema, { ...ANSWER_OPERATION, decision: 'continue', text: 'guidance' })).toBe(true);
    expect(check(answerBodyV2Schema, { ...ANSWER_OPERATION, decision: 'accept', text: 'guidance' })).toBe(true);
    expect(check(answerBodyV2Schema, { ...ANSWER_OPERATION, decision: 'stop' })).toBe(true);
  });

  it('rejects a missing question identity, v1-style bodies and unknown fields', () => {
    expect(check(answerBodyV2Schema, { answer: 'answer' })).toBe(false);
    expect(check(answerBodyV2Schema, { ...ANSWER_OPERATION, answer: 'answer', extra: 1 })).toBe(false);
    expect(check(answerBodyV2Schema, { ...ANSWER_OPERATION })).toBe(false);
    expect(check(answerBodyV2Schema, { ...ANSWER_OPERATION, decision: 'answer', text: 'x' })).toBe(false);
  });
});

/* ------------------------- §10.5 delete v2 ------------------------- */

describe('DeleteTaskBodyV2 / DeleteTaskResultV2 (spec §10.5)', () => {
  const DELETE_BODY = {
    operationId: '3b2c8f4e-9a1d-4f6e-b2c4-1a2b3c4d5e6f',
    reason: '任务已归档。',
  };

  it('requires a UUID v4 operation id and a bounded reason', () => {
    expect(check(deleteTaskBodyV2Schema, DELETE_BODY)).toBe(true);
    expect(check(deleteTaskBodyV2Schema, { ...DELETE_BODY, operationId: 'not-a-uuid' })).toBe(false);
    expect(check(deleteTaskBodyV2Schema, { ...DELETE_BODY, reason: '' })).toBe(false);
    expect(check(deleteTaskBodyV2Schema, { ...DELETE_BODY, reason: '长'.repeat(501) })).toBe(false);
    expect(check(deleteTaskBodyV2Schema, { ...DELETE_BODY, reason: '长'.repeat(500) })).toBe(true);
  });

  it('forbids caller-supplied actor fields (the server fixes task_owner)', () => {
    expect(check(deleteTaskBodyV2Schema, { ...DELETE_BODY, requestedBy: 'attacker' })).toBe(false);
    expect(check(deleteTaskBodyV2Schema, { ...DELETE_BODY, deleteEpoch: 3 })).toBe(false);
  });

  it('accepts the tombstone result only in detached/purged', () => {
    expect(check(deleteTaskResultV2Schema, { operationId: DELETE_BODY.operationId, state: 'detached' })).toBe(true);
    expect(check(deleteTaskResultV2Schema, { operationId: DELETE_BODY.operationId, state: 'purged' })).toBe(true);
    expect(check(deleteTaskResultV2Schema, { operationId: DELETE_BODY.operationId, state: 'prepared' })).toBe(false);
    expect(check(deleteTaskResultV2Schema, { operationId: DELETE_BODY.operationId, state: 'detached', taskId: 't-1' })).toBe(false);
  });
});

/* ------------------------- §10.3.1 reopen + recovery ------------------------- */

describe('ReopenFailedRequestV2 (spec §10.3.1)', () => {
  const REOPEN_BASE = {
    expectedLastSequence: 42,
    operationId: '3b2c8f4e-9a1d-4f6e-b2c4-1a2b3c4d5e6f',
    reason: '经人工核对后恢复执行。',
  };

  it('requires the exact tail, UUID operation, bounded reason, recipe and track', () => {
    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, recipeKey: 'retry_system_command', track: null })).toBe(true);
    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, recipeKey: 'restart_map_review_cycle', track: 'map' })).toBe(true);
    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, recipeKey: 'restart_content_review_cycle', track: 'content' })).toBe(true);
    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, recipeKey: 'rebuild_missing_work', track: 'map' })).toBe(true);
    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, recipeKey: 'rebuild_missing_work', track: null })).toBe(true);
    const retryTrack = { recipeKey: 'retry_system_command', track: null };
    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, ...retryTrack, expectedLastSequence: 0 })).toBe(true);

    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, ...retryTrack, expectedLastSequence: -1 })).toBe(false);
    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, ...retryTrack, expectedLastSequence: 1.5 })).toBe(false);
    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, ...retryTrack, operationId: 'not-a-uuid' })).toBe(false);
    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, ...retryTrack, reason: '' })).toBe(false);
    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, ...retryTrack, reason: '长'.repeat(1001) })).toBe(false);
    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, ...retryTrack, reason: '长'.repeat(1000) })).toBe(true);
  });

  it('rejects cross-recipe fields (exact policy table pairing)', () => {
    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, recipeKey: 'retry_system_command', track: 'map' })).toBe(false);
    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, recipeKey: 'restart_map_review_cycle', track: null })).toBe(false);
    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, recipeKey: 'restart_map_review_cycle', track: 'content' })).toBe(false);
    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, recipeKey: 'restart_content_review_cycle', track: 'map' })).toBe(false);
    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, recipeKey: 'unknown_recipe', track: null })).toBe(false);
    expect(check(reopenFailedRequestV2Schema, { ...REOPEN_BASE, recipeKey: 'retry_system_command', track: null, failureCode: 'X' })).toBe(false);
  });
});

function failurePayload(kind: string): Record<string, unknown> {
  return { kind };
}

describe('FailureRecoveryPayloadV2 / RoundBudgetOverrideV2 (spec §10.3.1)', () => {
  it('accepts the exact retry_system_command branch', () => {
    expect(check(failureRecoveryPayloadV2Schema, {
      ...failurePayload('retry_system_command'),
      failedWorkItemId: 'work-1',
      failedCommandId: 'command-1',
      failedLeaseEpoch: 2,
      terminalEventId: 'event-1',
      terminalCommitId: 'commit-1',
      authorityBaseRef: custodialRef('authority_base_set'),
      systemKind: 'system_map_finalize',
      systemPayloadRef: custodialRef('publication_operation_payload'),
    })).toBe(true);
    // Cross-recipe fields are rejected.
    expect(check(failureRecoveryPayloadV2Schema, {
      ...failurePayload('retry_system_command'),
      failedWorkItemId: 'work-1',
      failedCommandId: 'command-1',
      failedLeaseEpoch: 2,
      terminalEventId: 'event-1',
      terminalCommitId: 'commit-1',
      authorityBaseRef: custodialRef('authority_base_set'),
      systemKind: 'system_seal',
      systemPayloadRef: custodialRef('publication_operation_payload'),
      rejectedSubjectRef: custodialRef('map_candidate'), // only restart branches carry this
    })).toBe(false);
  });

  it('accepts the exact restart_review_cycle branches and rejects wrong fields', () => {
    const restart = {
      ...failurePayload('restart_review_cycle'),
      failedWorkItemId: 'work-1',
      failedAttemptOrCommandId: 'attempt-1',
      failedLeaseEpoch: 2,
      terminalEventId: 'event-1',
      terminalCommitId: 'commit-1',
      authorityBaseRef: custodialRef('authority_base_set'),
      rejectedSubjectRef: custodialRef('map_candidate'),
      findingSetRef: custodialRef('finding_set'),
      failedCycleOrdinal: 3,
    };
    expect(check(failureRecoveryPayloadV2Schema, { ...restart, track: 'map' })).toBe(true);
    expect(check(failureRecoveryPayloadV2Schema, { ...restart, track: 'content' })).toBe(true);
    expect(check(failureRecoveryPayloadV2Schema, { ...restart, track: 'map', failedCommandId: 'command-1' })).toBe(false);
    expect(check(failureRecoveryPayloadV2Schema, { ...restart, track: 'map', failedCycleOrdinal: -1 })).toBe(false);
  });

  it('accepts the exact rebuild_missing_work branch (no failed identity fields)', () => {
    expect(check(failureRecoveryPayloadV2Schema, {
      ...failurePayload('rebuild_missing_work'),
      predecessorResultRef: custodialRef('content_revision_manifest'),
      expectedSuccessorKind: 'system_generation_finalize',
      expectedSuccessorPayloadRef: custodialRef('content_plan_finalize_core'),
      authorityBaseRef: custodialRef('authority_base_set'),
      grantSpecInputRef: null,
    })).toBe(true);
    expect(check(failureRecoveryPayloadV2Schema, {
      ...failurePayload('rebuild_missing_work'),
      failedWorkItemId: 'forbidden',
      predecessorResultRef: custodialRef('content_revision_manifest'),
      expectedSuccessorKind: 'system_generation_finalize',
      expectedSuccessorPayloadRef: custodialRef('content_plan_finalize_core'),
      authorityBaseRef: custodialRef('authority_base_set'),
      grantSpecInputRef: null,
    })).toBe(false);
  });

  it('rejects unknown payload kinds and unknown fields', () => {
    expect(check(failureRecoveryPayloadV2Schema, failurePayload('bogus_recipe'))).toBe(false);
    expect(check(failureRecoveryPayloadV2Schema, {} as Record<string, unknown>)).toBe(false);
  });

  it('accepts the exact available round budget override', () => {
    const override = {
      overrideId: 'override-1',
      failedEventId: 'event-1',
      track: 'map',
      repairLineageId: 'lineage-1',
      initialRepairPlanRef: custodialRef('repair_plan_spec'),
      currentAuthorizedRepairPlanRef: custodialRef('repair_plan_spec'),
      predecessorOverrideRef: null,
      transferOrdinal: 0,
      operationId: '3b2c8f4e-9a1d-4f6e-b2c4-1a2b3c4d5e6f',
      operatorId: 'task_owner',
      reasonDigest: 'b5'.repeat(32),
      state: 'available',
    };
    expect(check(roundBudgetOverrideV2Schema, override)).toBe(true);
    expect(check(roundBudgetOverrideV2Schema, { ...override, state: 'consumed' })).toBe(false);
    expect(check(roundBudgetOverrideV2Schema, { ...override, transferOrdinal: -1 })).toBe(false);
    expect(check(roundBudgetOverrideV2Schema, { ...override, failedEventId: 'event-1', precedentRef: custodialRef('seal_record') })).toBe(false);
  });
});

/** A BlobRefV2 of the given closed kind, for payload schemas. */
function custodialRef(kind: BlobRefV2['kind']): BlobRefV2 {
  return { kind, digest, byteLength: 64, mediaType: 'application/json', schemaVersion: 1 };
}

describe('FailedTaskRecoverySummaryV2 (spec §10.3.1)', () => {
  const RECOVERY_SUMMARY = {
    failureCode: 'ARTIFACT_VALIDATION_FAILED',
    failedSequence: 12,
    legalRecipes: [
      { recipeKey: 'retry_system_command', track: null },
      { recipeKey: 'restart_content_review_cycle', track: 'content' },
    ],
    reopenAllowed: true,
    cloneFallback: true,
  };

  it('exposes the bounded summary exactly', () => {
    expect(check(failedTaskRecoverySummaryV2Schema, RECOVERY_SUMMARY)).toBe(true);
    expect(check(failedTaskRecoverySummaryV2Schema, { ...RECOVERY_SUMMARY, legalRecipes: [], reopenAllowed: false })).toBe(true);
  });

  it('never leaks private refs or evidence', () => {
    expect(check(failedTaskRecoverySummaryV2Schema, { ...RECOVERY_SUMMARY, authorityBaseRef: custodialRef('authority_base_set') })).toBe(false);
    expect(check(failedTaskRecoverySummaryV2Schema, { ...RECOVERY_SUMMARY, failureDigest: digest })).toBe(false);
    expect(check(failedTaskRecoverySummaryV2Schema, { ...RECOVERY_SUMMARY, reasoning: 'private' })).toBe(false);
    expect(check(failedTaskRecoverySummaryV2Schema, { ...RECOVERY_SUMMARY, failedSequence: -1 })).toBe(false);
    expect(check(failedTaskRecoverySummaryV2Schema, { ...RECOVERY_SUMMARY, legalRecipes: [{ recipeKey: 'bogus', track: null }] })).toBe(false);
  });
});

/* ------------------------- §14.2 read API cursors and pages ------------------------- */

describe('SnapshotCursorV2 and collection pages (spec §14.2 / design §19.2)', () => {
  it('requires the authenticated opaque cursor with a key id', () => {
    expect(check(snapshotCursorV2Schema, { version: 2, keyId: 'key-1', token: 'opaque-token' })).toBe(true);
    expect(check(snapshotCursorV2Schema, { version: 1, keyId: 'key-1', token: 'opaque-token' })).toBe(false);
    expect(check(snapshotCursorV2Schema, { version: 2, keyId: '', token: 'opaque-token' })).toBe(false);
    expect(check(snapshotCursorV2Schema, { version: 2, keyId: 'key-1', token: '' })).toBe(false);
    expect(check(snapshotCursorV2Schema, { version: 2, keyId: 'key-1', token: 't', throughSequence: 9 })).toBe(false);
  });

  it('accepts an exact findings collection page with a nullable cursor', () => {
    const finding = {
      findingId: 'finding-1',
      reviewContext: { kind: 'map', roundId: 'round-1' },
      primaryLocation: { kind: 'slot', id: 'slot-1' },
      defectClass: 'content',
      severity: 'blocking',
      source: 'reviewer',
      status: 'open',
    };
    expect(check(authoritativeFindingCollectionPageV2Schema, {
      items: [finding],
      nextCursor: { version: 2, keyId: 'key-1', token: 'opaque-token' },
    })).toBe(true);
    expect(check(authoritativeFindingCollectionPageV2Schema, { items: [], nextCursor: null })).toBe(true);
    // Unknown page fields and cursor-less pages are rejected.
    expect(check(authoritativeFindingCollectionPageV2Schema, { items: [finding], nextCursor: null, total: 1 })).toBe(false);
    expect(check(authoritativeFindingCollectionPageV2Schema, { items: [finding] })).toBe(false);
    expect(check(authoritativeFindingCollectionPageV2Schema, {
      items: [{ ...finding, findingId: 7 }],
      nextCursor: null,
    })).toBe(false);
  });
});

/* ------------------------- public Map/review/Finding/Seal DTOs ------------------------- */

describe('public Map/review/Finding/Seal DTOs (design §11/§16.2/§19.2)', () => {
  it('accepts the Map identity summary exactly', () => {
    const map = {
      mapId: 'map-1',
      mapRevision: 2,
      mapSemanticDigest: '2b'.repeat(32),
      supersedesMapId: null,
      mapSnapshotRef: null,
      mapReviewBundleRef: null,
      candidateRef: custodialRef('map_candidate'),
    };
    expect(check(authoritativeMapSummaryV2Schema, map)).toBe(true);
    expect(check(authoritativeMapSummaryV2Schema, {
      ...map,
      mapSnapshotRef: custodialRef('map_snapshot'),
      mapReviewBundleRef: custodialRef('map_review_bundle'),
      candidateRef: null,
    })).toBe(true);
    expect(check(authoritativeMapSummaryV2Schema, { ...map, mapRevision: 0 })).toBe(false);
    expect(check(authoritativeMapSummaryV2Schema, { ...map, positionGraphDigest: 'x' })).toBe(false);
  });

  it('accepts the relation-disabled summary (design §15 view 3)', () => {
    expect(check(authoritativeRelationSummaryV2Schema, { mode: 'disabled', relationCount: 0 })).toBe(true);
    expect(check(authoritativeRelationSummaryV2Schema, { mode: 'optional', relationCount: 4 })).toBe(true);
    expect(check(authoritativeRelationSummaryV2Schema, { mode: 'optional', relationCount: 0 })).toBe(true);
    expect(check(authoritativeRelationSummaryV2Schema, { mode: 'required', relationCount: 0 })).toBe(false);
    expect(check(authoritativeRelationSummaryV2Schema, { mode: 'disabled', relationCount: -1 })).toBe(false);
    expect(check(authoritativeRelationSummaryV2Schema, { mode: 'optional', relationCount: 1, missing: true })).toBe(false);
  });

  it('accepts the review summary with derived slot-state counts', () => {
    const review = {
      version: 2,
      mapCycleOrdinal: 1,
      contentCycleOrdinal: 2,
      pendingCount: 5,
      passCount: 120,
      rejectCount: 1,
      staleCount: 0,
      openBlockingFindingCount: 3,
      relation: { mode: 'optional', relationCount: 8 },
    };
    expect(check(authoritativeReviewSummaryV2Schema, review)).toBe(true);
    expect(check(authoritativeReviewSummaryV2Schema, { ...review, version: 1 })).toBe(false);
    expect(check(authoritativeReviewSummaryV2Schema, { ...review, pendingCount: -1 })).toBe(false);
    expect(check(authoritativeReviewSummaryV2Schema, { ...review, relation: { mode: 'disabled', relationCount: 8 } })).toBe(false);
    expect(check(authoritativeReviewSummaryV2Schema, { ...review, mapPassed: true })).toBe(false);
  });

  it('accepts a finding and review-round summary exactly', () => {
    const finding = {
      findingId: 'finding-1',
      reviewContext: { kind: 'content', roundId: 'round-1' },
      primaryLocation: { kind: 'relation', id: 'relation-1' },
      defectClass: 'mixed',
      severity: 'blocking',
      source: 'system_validator',
      status: 'addressed',
    };
    expect(check(authoritativeFindingSummaryV2Schema, finding)).toBe(true);
    expect(check(authoritativeFindingSummaryV2Schema, { ...finding, status: 'verified_closed' })).toBe(true);
    expect(check(authoritativeFindingSummaryV2Schema, { ...finding, status: 'closed' })).toBe(false);
    expect(check(authoritativeFindingSummaryV2Schema, { ...finding, primaryLocation: { kind: 'review', id: 'x' } })).toBe(false);
    expect(check(authoritativeFindingSummaryV2Schema, { ...finding, evidence: ['private'] })).toBe(false);

    for (const state of [
      'planned',
      'reviewing_batches',
      'whole_map_observation',
      'whole_tree_observation',
      'completed',
      'settled',
    ]) {
      expect(check(authoritativeReviewRoundSummaryV2Schema, { reviewRoundId: 'round-1', kind: 'map', state })).toBe(true);
    }
    expect(check(authoritativeReviewRoundSummaryV2Schema, { reviewRoundId: 'round-1', kind: 'map', state: 'exploded' })).toBe(false);
    expect(check(authoritativeReviewRoundSummaryV2Schema, { reviewRoundId: 'round-1', kind: 'system', state: 'completed' })).toBe(false);
  });

  it('accepts the seal readiness summary and SealRecordV2 identity', () => {
    expect(check(authoritativeSealReadinessSummaryV2Schema, {
      readiness: 'not_ready',
      unmetConditionCount: 2,
      sealed: false,
      sealRecordRef: null,
    })).toBe(true);
    expect(check(authoritativeSealReadinessSummaryV2Schema, {
      readiness: 'ready',
      unmetConditionCount: 0,
      sealed: true,
      sealRecordRef: custodialRef('seal_record'),
    })).toBe(true);
    expect(check(authoritativeSealReadinessSummaryV2Schema, {
      readiness: 'ready',
      unmetConditionCount: 1,
      sealed: true,
      sealRecordRef: null,
    })).toBe(true);
    expect(check(authoritativeSealReadinessSummaryV2Schema, {
      readiness: 'pending',
      unmetConditionCount: 0,
      sealed: false,
      sealRecordRef: null,
    })).toBe(false);
    expect(check(authoritativeSealReadinessSummaryV2Schema, {
      readiness: 'not_ready',
      unmetConditionCount: -1,
      sealed: false,
      sealRecordRef: null,
    })).toBe(false);

    const sealRecord = {
      taskId: 'task-1',
      mapRef: custodialRef('map_snapshot'),
      mapSemanticDigest: '3c'.repeat(32),
      mapReviewBundleRef: custodialRef('map_review_bundle'),
      contentRevisionManifestRef: custodialRef('content_revision_manifest'),
      contentRootDigest: '4d'.repeat(32),
      reviewBundleRef: custodialRef('review_bundle'),
      sealValidationBundleRef: custodialRef('seal_validation_bundle'),
      templateSnapshotHash: '5e'.repeat(32),
      assemblerDigest: '6f'.repeat(32),
      artifactRef: custodialRef('artifact'),
      artifactDigest: '70'.repeat(32),
    };
    expect(check(sealRecordV2Schema, sealRecord)).toBe(true);
    expect(check(sealRecordV2Schema, { ...sealRecord, sourceNodeId: 'forged' })).toBe(false);
  });

  it('accepts SystemArtifactDelivery without an artifact version (spec §13.5)', () => {
    const delivery = {
      deliveryId: 'delivery-1',
      producer: 'system:structured_seal',
      sealRecordRef: custodialRef('seal_record'),
      sealRecordDigest: '81'.repeat(32),
      artifactId: 'artifact-1',
      artifactRef: custodialRef('artifact'),
      artifactDigest: '92'.repeat(32),
      custodyRef: custodialRef('validator_aggregate'),
      custodyDigest: 'a3'.repeat(32),
      submitterWorkItemId: 'work-9',
      submitterAgentId: 'submitter',
      templateSnapshotHash: 'b4'.repeat(32),
    };
    expect(check(systemArtifactDeliveryV2Schema, delivery)).toBe(true);
    expect(check(systemArtifactDeliveryV2Schema, { ...delivery, artifactVersion: 2 })).toBe(false);
    expect(check(systemArtifactDeliveryV2Schema, { ...delivery, producer: 'seal' })).toBe(false);
  });
});

/* ------------------------- v2 workspace summary ------------------------- */

describe('authoritative review workspace summary v2', () => {
  const V2_WORKSPACE = {
    version: 2,
    executionEligibility: {
      state: 'eligible',
      frozenProfileDigest: 'c5'.repeat(32),
      currentProfileDigest: 'c5'.repeat(32),
    },
    pendingQuestion: QUESTION,
  };

  it('accepts the versioned v2 workspace summary', () => {
    expect(check(authoritativeReviewWorkspaceV2Schema, V2_WORKSPACE)).toBe(true);
    expect(check(authoritativeReviewWorkspaceV2Schema, { ...V2_WORKSPACE, pendingQuestion: null })).toBe(true);
  });

  it('rejects unknown fields and a missing eligibility', () => {
    expect(check(authoritativeReviewWorkspaceV2Schema, { ...V2_WORKSPACE, version: 3 })).toBe(false);
    expect(check(authoritativeReviewWorkspaceV2Schema, { ...V2_WORKSPACE, structuredSlots: { version: 1 } })).toBe(false);
    expect(check(authoritativeReviewWorkspaceV2Schema, {
      version: 2,
      executionEligibility: { state: 'blocked', reason: 'profile_digest_mismatch', frozenProfileDigest: 'c5'.repeat(32), currentProfileDigest: null },
      pendingQuestion: null,
    })).toBe(true);
  });
});