/**
 * Shared public contracts of the authoritative per-slot review lifecycle v2
 * (spec 2026-08-14; design 2026-08-13). Single source for:
 *
 * - the frozen-snapshot protocol discriminator (§4.1);
 * - the closed `AuthoritativeBlobKindV2` registry and `BlobRefV2` (§7.1);
 * - the profile snapshot bootstrap and the separately derived execution
 *   eligibility (§4.3);
 * - public Map/review/Finding/Seal DTOs (design §11/§16/§19.2);
 * - the pending question and versioned answer/delete/reopen mutations
 *   (§10.3.1/§10.5/§10.6);
 * - artifact provenance (§13.5.1).
 *
 * Internal plan/fact object bodies live in the pure domain module (Task 3);
 * this module only freezes what crosses the shared wire, the process boundary
 * or the closed kind registry. Every shape here is a frozen contract — v1
 * shapes stay byte-compatible and this module only ADDS members and fields.
 */

/* ----------------------------- §4.1 protocol discrimination ----------------------------- */

/**
 * Structured-slot protocol of one task's frozen template snapshot (spec
 * §4.1). `none` = basic template (or a structured template that has not
 * frozen a contract); `v1` = structured slot contract version 1; `v2` =
 * authoritative per-slot review contract. Clients never derive this from
 * status, template ID or event history.
 */
export type StructuredProtocol = 'none' | 'v1' | 'v2';

/** Structural input of `structuredProtocolOf` (satisfied by FrozenTemplate). */
export interface StructuredProtocolSource {
  productionMode: 'basic' | 'structured_slots';
  structuredSlots: { version: number } | null;
}

/**
 * Reads the protocol EXCLUSIVELY from the task's frozen snapshot (spec §4.1).
 * Never consults the current catalog entry, template ID, newest source files,
 * event-name heuristics or capability status. Missing snapshot identity is a
 * producer concern: callers fall back to the immutable task identity and fail
 * closed to `none` — never guessing v2.
 */
export function structuredProtocolOf(source: StructuredProtocolSource): StructuredProtocol {
  if (source.productionMode !== 'structured_slots' || source.structuredSlots === null) {
    return 'none';
  }
  return source.structuredSlots.version === 1 ? 'v1' : 'v2';
}

/* ----------------------------- §7.1 blob identity ----------------------------- */

/**
 * The closed v2 blob-kind registry (spec §7.1). Every family named there is
 * covered: profile snapshot and publication operation payload from the first
 * v2 commit; Map build specs/chunks/manifests/key ledgers; Map candidates/
 * validation cores/snapshots/bundles; content values/versions/manifests/
 * commit and finalize cores; generation/repair/migration specs and results;
 * review facts/ledgers/adoptions/round cores/bundles; Findings/verifications;
 * authority bases/grants/dispatch payloads; validator envelopes/receipts/
 * failures/aggregates/warning roots; Seal bundles/records/artifacts/
 * deliveries; checkpoints. Kind names follow the design §19.1 storage naming
 * (snake_case); kinds it does not name use the canonical object names frozen
 * in the design (proposed_map_core, contribution_manifest, finding_set,
 * finding_stage_root, review_adoption_root, content_compatibility_proof,
 * local_validator_equivalence_proof). `publication_pin` is a durable state
 * file keyed by pin id, not a content-addressed BlobRefV2 kind.
 */
export const AUTHORITATIVE_BLOB_KINDS_V2 = [
  'artifact',
  'assignment_dispatch',
  'authority_base_set',
  'content_compatibility_proof',
  'content_plan_finalize_core',
  'content_revision_commit_core',
  'content_revision_manifest',
  'content_review_coverage_core',
  'content_review_settlement_core',
  'content_value',
  'content_version',
  'contribution_manifest',
  'failure_recovery_payload',
  'finding',
  'finding_set',
  'finding_stage_root',
  'finding_verification_record',
  'generation_plan_spec',
  'grant_instance',
  'local_validator_equivalence_proof',
  'map_build_chunk',
  'map_build_key_ledger',
  'map_build_manifest',
  'map_build_spec',
  'map_candidate',
  'map_candidate_validation_core',
  'map_review_bundle',
  'map_review_coverage_core',
  'map_review_round',
  'map_review_settlement_core',
  'map_snapshot',
  'migration_activation_decision',
  'migration_intent_core',
  'migration_settlement_core',
  'migration_spec',
  'migration_validation_batch_result',
  'migration_validation_plan_spec',
  'profile_snapshot',
  'projection_checkpoint',
  'proposed_map_core',
  'publication_operation_payload',
  'repair_key_ledger',
  'repair_plan_spec',
  'repair_staging_root',
  'review_adoption_ledger',
  'review_adoption_root',
  'review_assignment_ledger',
  'review_bundle',
  'review_fact',
  'round_budget_override',
  'seal_record',
  'seal_validation_bundle',
  'system_artifact_delivery',
  'validation_receipt',
  'validation_warning_custody_root',
  'validation_warning_root',
  'validator_aggregate',
  'validator_failure',
  'validator_input_envelope',
  'write_grant_spec',
] as const;

/** Closed v2 blob kind (explicit union — never `string`). */
export type AuthoritativeBlobKindV2 = (typeof AUTHORITATIVE_BLOB_KINDS_V2)[number];

export type BlobRefV2MediaType = 'application/json' | 'text/markdown' | 'text/plain';

/**
 * Content-addressed reference (spec §7.1). `digest` is the lowercase SHA-256
 * of the exact canonical bytes. Every cross-object authority or custody link
 * is a BlobRefV2; a bare digest never keeps an object alive and never
 * satisfies a Gate.
 */
export interface BlobRefV2 {
  kind: AuthoritativeBlobKindV2;
  digest: string;
  byteLength: number;
  mediaType: BlobRefV2MediaType;
  schemaVersion: number;
}

/* ----------------------------- §13.5.1 artifact provenance ----------------------------- */

/**
 * Discriminated artifact producer provenance (spec §13.5.1 / design §16.3):
 * v2 system artifacts carry the exact system Seal WorkItem, SealRecord,
 * artifact and custody refs and FORBID a fabricated source node; agent
 * sources keep `sourceNodeId`. All cross-object custody is BlobRefV2.
 */
export type ArtifactProvenanceV2 =
  | { producerKind: 'agent'; sourceNodeId: string; producerAgentId: string }
  | {
      producerKind: 'system';
      producerWorkItemId: string;
      sealRecordRef: BlobRefV2;
      artifactRef: BlobRefV2;
      custodyRef: BlobRefV2;
    };

/* ----------------------------- §4.3 profile bootstrap + eligibility ----------------------------- */

/**
 * Bootstrap identity of the immutable profile snapshot (spec §4.3). The
 * complete validated profile (identity/version, every limit and policy,
 * implementation ABI identities) is frozen into the canonical profile body;
 * `profileDigest = sha256(canonicalBytesWithoutDigest)` is a distinct
 * identity from `profileSnapshotRef.digest` (SHA-256 over the complete object
 * bytes). The body/limits matrix is registered in the pure domain object
 * registry (Task 3).
 */
export interface AuthoritativeReviewProfileSnapshotV1 {
  schemaVersion: 1;
  profileIdentity: string;
  profileVersion: number;
  qualificationState: 'test_only' | 'provisional' | 'final';
  /** SHA-256 of the canonical profile body with this field omitted. */
  profileDigest: string;
  abi: {
    validatorAbi: 'forge-validator/v2';
    assemblerAbi: 'forge-assembler/v2';
    profileAbi: 'forge-authoritative-review/v1';
  };
}

export type AuthoritativeExecutionEligibilityReasonV1 =
  | 'base_capability_disabled'
  | 'authoritative_capability_disabled'
  | 'profile_digest_mismatch'
  | 'required_abi_unavailable';

/**
 * Temporary deployment eligibility (spec §4.3): a reversible, non-event
 * derivation of the frozen vs current profile/ABI — never TaskStatus, never
 * rewritten into event history. Read/genesis/diagnosis/delete do not require
 * eligibility; any mutation that would create execution events does.
 */
export type AuthoritativeReviewExecutionEligibilityV1 =
  | {
      state: 'eligible';
      frozenProfileDigest: string;
      currentProfileDigest: string;
    }
  | {
      state: 'blocked';
      reason: AuthoritativeExecutionEligibilityReasonV1;
      frozenProfileDigest: string;
      currentProfileDigest: string | null;
    };

/* ----------------------------- §10.1 WorkItem kinds ----------------------------- */

/** Closed WorkItem execution kinds (spec §10.1, frozen design §17.2). */
export type WorkItemKindV2 =
  | 'agent_assignment'
  | 'system_map_finalize'
  | 'system_generation_finalize'
  | 'system_repair_finalize'
  | 'system_migration_validation_batch'
  | 'system_review_settlement'
  | 'system_seal';

/* ----------------------------- §10.6 human questions ----------------------------- */

export type PendingQuestionSourceV2 = 'agent_request' | 'progress_guard';

/**
 * Exact syntax of the opaque `questionVersion` token (spec §10.6): unpadded
 * base64url encoding of a 32-byte SHA-256, generated in Node as
 * `createHash('sha256').update(canonicalBytes).digest('base64url')`. Case is
 * significant; implementations must never lowercase or otherwise normalize
 * the encoded token.
 */
export const QUESTION_VERSION_TOKEN_PATTERN = '^[A-Za-z0-9_-]{43}$';

/** Anchored RegExp mirror of `QUESTION_VERSION_TOKEN_PATTERN`. */
export const QUESTION_VERSION_TOKEN_REGEX = /^[A-Za-z0-9_-]{43}$/;

/** True only for the exact unpadded base64url token shape. */
export function isQuestionVersionToken(value: unknown): value is string {
  return typeof value === 'string' && QUESTION_VERSION_TOKEN_REGEX.test(value);
}

/**
 * The pending v2 human question (spec §10.6). `questionVersion` is the
 * opaque, case-sensitive token bound to the question identity, original
 * WorkItem/assignment, digest, authority base and opened commit — never a
 * counter or tail sequence.
 */
export interface PendingQuestionV2 {
  questionId: string;
  questionDigest: string;
  questionVersion: string;
  source: PendingQuestionSourceV2;
  text: string;
}

export type AnswerTaskDecisionV2 =
  | { decision: 'continue' | 'accept'; text: string }
  | { decision: 'stop' };

/**
 * The v2 answer mutation (spec §10.6): the question identity token and an
 * operation id are mandatory on every branch. `{ answer }` is the ordinary
 * text-answer variant (matches the wire schema exactly); the decision union
 * serves the structured progress-guard choices. The server atomically checks
 * the current unconsumed identity; stale tabs receive HUMAN_QUESTION_STALE.
 */
export type AnswerTaskBodyV2 =
  | ({
      questionId: string;
      questionVersion: string;
      operationId: string;
    } & { answer: string })
  | ({
      questionId: string;
      questionVersion: string;
      operationId: string;
    } & AnswerTaskDecisionV2);

/* ----------------------------- §10.5 delete v2 ----------------------------- */

/**
 * The fenced v2 delete mutation (spec §10.5): a UUID v4 operation id and a
 * trimmed 1..500 code-point reason. The server-fixed local owner principal
 * supplies `requestedBy='task_owner'`; clients cannot forge an actor.
 */
export interface DeleteTaskBodyV2 {
  operationId: string;
  reason: string;
}

/** Delete tombstone result (spec §10.5): detached or purged, never prepared. */
export interface DeleteTaskResultV2 {
  operationId: string;
  state: 'detached' | 'purged';
}

/** UUID v4 exact pattern used by delete/reopen operation ids. */
export const UUID_V4_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

export const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True only for the exact lowercase UUID v4 shape. */
export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_REGEX.test(value);
}

/* ----------------------------- §10.3.1 failed-task recovery ----------------------------- */

export type RecoveryRecipeKeyV2 =
  | 'retry_system_command'
  | 'restart_map_review_cycle'
  | 'restart_content_review_cycle'
  | 'rebuild_missing_work';

/**
 * The fenced reopen mutation (spec §10.3.1): exact expected tail, UUID v4
 * operation, trimmed 1..1000 code-point reason, one frozen recipe and its
 * track. The exact recipe/track pairing is enforced by the wire schema and by
 * the server policy table; the flat interface mirrors the spec's type.
 */
export interface ReopenFailedRequestV2 {
  expectedLastSequence: number;
  operationId: string;
  reason: string;
  recipeKey: RecoveryRecipeKeyV2;
  track: 'map' | 'content' | null;
}

/**
 * The canonical recovery payload stored with `structured_task_failed_v2`
 * (spec §10.3.1): event-ledger identities (IDs/epoch/terminal event+commit)
 * plus only real object refs — never invented WorkItem/Attempt blob kinds.
 * `rebuild_missing_work` forbids failed identity fields by construction.
 */
export type FailureRecoveryPayloadV2 =
  | {
      kind: 'retry_system_command';
      failedWorkItemId: string;
      failedCommandId: string;
      failedLeaseEpoch: number;
      terminalEventId: string;
      terminalCommitId: string;
      authorityBaseRef: BlobRefV2;
      systemKind: Extract<WorkItemKindV2, `system_${string}`>;
      systemPayloadRef: BlobRefV2;
    }
  | {
      kind: 'restart_review_cycle';
      track: 'map' | 'content';
      failedWorkItemId: string;
      failedAttemptOrCommandId: string;
      failedLeaseEpoch: number;
      terminalEventId: string;
      terminalCommitId: string;
      authorityBaseRef: BlobRefV2;
      rejectedSubjectRef: BlobRefV2;
      findingSetRef: BlobRefV2;
      failedCycleOrdinal: number;
    }
  | {
      kind: 'rebuild_missing_work';
      predecessorResultRef: BlobRefV2;
      expectedSuccessorKind: WorkItemKindV2;
      expectedSuccessorPayloadRef: BlobRefV2;
      authorityBaseRef: BlobRefV2;
      grantSpecInputRef: BlobRefV2 | null;
    };

/**
 * One available round-budget override (spec §10.3.1/§13.3.1): a registered
 * canonical Blob kind owned by the reopen event; `state` is exactly
 * `available` until the unique round-created event consumes it.
 */
export interface RoundBudgetOverrideV2 {
  overrideId: string;
  failedEventId: string;
  track: 'map' | 'content';
  repairLineageId: string;
  initialRepairPlanRef: BlobRefV2;
  currentAuthorizedRepairPlanRef: BlobRefV2;
  predecessorOverrideRef: BlobRefV2 | null;
  transferOrdinal: number;
  operationId: string;
  operatorId: string;
  reasonDigest: string;
  state: 'available';
}

/**
 * The bounded recovery summary the owner sees on a failed task (spec
 * §10.3.1): failure code, failed sequence, legal recipe keys/tracks,
 * `reopenAllowed` and the clone fallback — never private refs or evidence.
 */
export interface FailedTaskRecoverySummaryV2 {
  failureCode: string;
  failedSequence: number;
  legalRecipes: ReadonlyArray<{ recipeKey: RecoveryRecipeKeyV2; track: 'map' | 'content' | null }>;
  reopenAllowed: boolean;
  cloneFallback: boolean;
}

/* ----------------------------- §14.2 read API cursors ----------------------------- */

/**
 * Authenticated opaque snapshot cursor (spec §14.2): the first collection
 * request fixes throughSequence/projection baseline/filters/sort and returns
 * a cursor with a signing key id; later pages stay stable while events
 * append. CURSOR_STALE is reserved for retention/key retirement, changed
 * query identity or corruption.
 */
export interface SnapshotCursorV2 {
  version: 2;
  keyId: string;
  token: string;
}

/** Stable collection page shape of every cursor-paginated v2 read. */
export interface CollectionPageV2<T> {
  items: T[];
  nextCursor: SnapshotCursorV2 | null;
}

/* ----------------------------- public Map/review/Finding/Seal DTOs ----------------------------- */

/**
 * Public identity of the current Map state (design §10.1): `mapSemanticDigest`
 * identifies only normalized structure/relations/template identity and NEVER
 * equals `mapSnapshotRef.digest` (which covers the whole snapshot, including
 * review/provenance/revision). Null refs until the first Map activation.
 */
export interface AuthoritativeMapSummaryV2 {
  mapId: string;
  mapRevision: number;
  mapSemanticDigest: string;
  supersedesMapId: string | null;
  mapSnapshotRef: BlobRefV2 | null;
  mapReviewBundleRef: BlobRefV2 | null;
  /** Current frozen candidate awaiting/settled pre-review; null when activated. */
  candidateRef: BlobRefV2 | null;
}

export type RelationshipPolicyModeV2 = 'disabled' | 'optional';

/**
 * Relationship-layer summary (design §15 view 3): the platform has no
 * minimum-relation rule, so `mode: 'disabled' || relationCount === 0` is a
 * valid neutral state, never an error or pending state.
 */
export interface AuthoritativeRelationSummaryV2 {
  mode: RelationshipPolicyModeV2;
  relationCount: number;
}

/** Derived slot-review state counts (design §11.6). */
export interface AuthoritativeReviewSummaryV2 {
  version: 2;
  mapCycleOrdinal: number;
  contentCycleOrdinal: number;
  /** Slots with no current effective review. */
  pendingCount: number;
  /** Slots with a current effective pass. */
  passCount: number;
  /** Slots with a current effective reject. */
  rejectCount: number;
  /** Slots whose historical verdicts bound changed digests. */
  staleCount: number;
  openBlockingFindingCount: number;
  relation: AuthoritativeRelationSummaryV2;
}

export type FindingDefectClassV2 = 'content' | 'map' | 'mixed';
export type FindingSeverityV2 = 'blocking' | 'advisory';
export type FindingSourceV2 = 'reviewer' | 'system_validator';
export type FindingStatusV2 =
  | 'open'
  | 'repair_planned'
  | 'repair_dispatched'
  | 'addressed'
  | 'verified_closed';
export type FindingPrimaryLocationKindV2 = 'slot' | 'relation' | 'map_node' | 'map';

/** Public Finding summary (design §11.8): classification/lifecycle only. */
export interface AuthoritativeFindingSummaryV2 {
  findingId: string;
  reviewContext: { kind: 'map' | 'content'; roundId: string };
  primaryLocation: { kind: FindingPrimaryLocationKindV2; id: string };
  defectClass: FindingDefectClassV2;
  severity: FindingSeverityV2;
  source: FindingSourceV2;
  status: FindingStatusV2;
}

export type ReviewRoundKindV2 = 'map' | 'content';
export type ReviewRoundStateV2 =
  | 'planned'
  | 'reviewing_batches'
  | 'whole_map_observation'
  | 'whole_tree_observation'
  | 'completed'
  | 'settled';

/** One review round row of the cursor-paginated rounds views (design §11.3/§11.10). */
export interface AuthoritativeReviewRoundSummaryV2 {
  reviewRoundId: string;
  kind: ReviewRoundKindV2;
  state: ReviewRoundStateV2;
}

/**
 * Seal readiness projection (design §16.2): a system-derived gate result with
 * the closed unmet-condition count and the sealed artifact identity — never a
 * model verdict. Detailed per-condition reasons are served by the seal
 * readiness route.
 */
export interface AuthoritativeSealReadinessSummaryV2 {
  readiness: 'ready' | 'not_ready';
  unmetConditionCount: number;
  sealed: boolean;
  sealRecordRef: BlobRefV2 | null;
}

/**
 * The immutable v2 SealRecord identity (design §16.3): binds the current Map,
 * content manifest, review/validation bundles, template snapshot, assembler
 * and artifact. Display aliases (`mapSemanticDigest`, `contentRootDigest`,
 * `artifactDigest`) must equal the corresponding resolved ref digests.
 */
export interface SealRecordV2 {
  taskId: string;
  mapRef: BlobRefV2;
  mapSemanticDigest: string;
  mapReviewBundleRef: BlobRefV2;
  contentRevisionManifestRef: BlobRefV2;
  contentRootDigest: string;
  reviewBundleRef: BlobRefV2;
  sealValidationBundleRef: BlobRefV2;
  templateSnapshotHash: string;
  assemblerDigest: string;
  artifactRef: BlobRefV2;
  artifactDigest: string;
}

/**
 * System artifact delivery (spec §13.5): immutable and fully constructible
 * before the publication lock; deliberately EXCLUDES `artifactVersion` (the
 * version is allocated inside the lock and derived from `artifact_published_v2`).
 */
export interface SystemArtifactDeliveryV2 {
  deliveryId: string;
  producer: 'system:structured_seal';
  sealRecordRef: BlobRefV2;
  sealRecordDigest: string;
  artifactId: string;
  artifactRef: BlobRefV2;
  artifactDigest: string;
  custodyRef: BlobRefV2;
  custodyDigest: string;
  submitterWorkItemId: string;
  submitterAgentId: string;
  templateSnapshotHash: string;
}

/**
 * The versioned v2 summary carried by `TaskWorkspace` (spec §14/§19.2). The
 * workspace discriminates by version: v1 templates carry the optional
 * `structuredSlots` summary, v2 templates carry this field instead. The
 * execution eligibility is exposed SEPARATELY from the event-derived task
 * status (spec §4.3).
 */
export interface AuthoritativeReviewWorkspaceV2 {
  version: 2;
  executionEligibility: AuthoritativeReviewExecutionEligibilityV1;
  pendingQuestion: PendingQuestionV2 | null;
}