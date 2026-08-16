/**
 * Pure authority domain types (Task 3). Canonical internal object interfaces
 * of the authoritative per-slot review lifecycle v2 — the storage-free domain
 * vocabulary every later v2 runtime task builds on.
 *
 * Sources (frozen, transcribed exactly — never paraphrased or shrunk):
 * - design 2026-08-13 §10.1/§10.4/§11.1-§11.11/§13/§16.2/§17.2;
 * - spec 2026-08-14 §7.1/§7.2/§7.3/§7.4/§8/§10.1/§10.3.1;
 * - shared contracts `src/shared/authoritative-review-v2.ts`.
 *
 * Purity rules: this module never touches node:fs, EventStore, Pi/provider
 * code, HTTP, React, `Date.now()`/`new Date()` or `Math.random()`. All
 * digests are computed from input bytes only; all times are values passed in.
 */
import type {
  AuthoritativeBlobKindV2,
  BlobRefV2,
  WorkItemKindV2,
} from '../../shared/authoritative-review-v2';

/* ------------------------------------------------------------------ */
/* Schema assertion helpers                                            */
/* ------------------------------------------------------------------ */

/** Stable schema rejection. Unknown fields and illegal combinations throw this. */
export class SchemaError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`SCHEMA_INVALID: ${reason}`);
    this.name = 'SchemaError';
    this.reason = reason;
  }
}

export function assertRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SchemaError(`${where} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

export function assertString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SchemaError(`${where} must be a non-empty string`);
  }
  return value;
}

export function assertOptionalString(value: unknown, where: string): string | null {
  if (value === null || value === undefined) return null;
  return assertString(value, where);
}

export function assertInteger(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new SchemaError(`${where} must be an integer`);
  }
  return value;
}

export function assertOptionalInteger(value: unknown, where: string): number | null {
  if (value === null || value === undefined) return null;
  return assertInteger(value, where);
}

export function assertNonNegativeInteger(value: unknown, where: string): number {
  const n = assertInteger(value, where);
  if (n < 0) throw new SchemaError(`${where} must be >= 0`);
  return n;
}

export function assertBoolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') throw new SchemaError(`${where} must be a boolean`);
  return value;
}

export function assertArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new SchemaError(`${where} must be an array`);
  return value;
}

export function assertStringArray(value: unknown, where: string): string[] {
  return assertArray(value, where).map((v, i) => assertString(v, `${where}[${i}]`));
}

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function assertSha256Hex(value: unknown, where: string): string {
  const s = assertString(value, where);
  if (!SHA256_HEX_PATTERN.test(s)) throw new SchemaError(`${where} is not a lowercase SHA-256 hex digest`);
  return s;
}

export function assertOptionalSha256Hex(value: unknown, where: string): string | null {
  if (value === null || value === undefined) return null;
  return assertSha256Hex(value, where);
}

/**
 * Exact-key strictness: any key outside `allowed` is rejected (spec §25.2:
 * "v1/v2 schema 严格拒绝未知字段"). Every registered object body uses this.
 */
export function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new SchemaError(`${where} has unknown field '${key}'`);
    }
  }
}

/**
 * Closed-kind BlobRefV2 validation. `kind` must be a member of the closed
 * registry, digest a 64-hex SHA-256, byteLength >= 0, mediaType and
 * schemaVersion within the frozen wire contract (spec §7.1).
 */
export function assertBlobRef(value: unknown, where: string): BlobRefV2 {
  const rec = assertRecord(value, where);
  assertExactKeys(rec, ['kind', 'digest', 'byteLength', 'mediaType', 'schemaVersion'], where);
  const kind = assertString(rec.kind, `${where}.kind`);
  const ref: BlobRefV2 = {
    kind: kind as BlobRefV2['kind'],
    digest: assertSha256Hex(rec.digest, `${where}.digest`),
    byteLength: assertNonNegativeInteger(rec.byteLength, `${where}.byteLength`),
    mediaType: assertString(rec.mediaType, `${where}.mediaType`) as BlobRefV2['mediaType'],
    schemaVersion: assertInteger(rec.schemaVersion, `${where}.schemaVersion`),
  };
  if (ref.mediaType !== 'application/json' && ref.mediaType !== 'text/markdown' && ref.mediaType !== 'text/plain') {
    throw new SchemaError(`${where}.mediaType is not a BlobRefV2 mediaType`);
  }
  if (ref.schemaVersion < 1) throw new SchemaError(`${where}.schemaVersion must be >= 1`);
  return ref;
}

export function assertNullableBlobRef(value: unknown, where: string): BlobRefV2 | null {
  if (value === null || value === undefined) return null;
  return assertBlobRef(value, where);
}

export function assertRefArray(value: unknown, where: string): BlobRefV2[] {
  return assertArray(value, where).map((v, i) => assertBlobRef(v, `${where}[${i}]`));
}

export function assertRefRecordArray(
  value: unknown,
  where: string,
  key: string,
): Array<{ label: string; ref: BlobRefV2 }> {
  return assertArray(value, where).map((v, i) => {
    const rec = assertRecord(v, `${where}[${i}]`);
    assertExactKeys(rec, [key, 'ref'], `${where}[${i}]`);
    return { label: assertString(rec[key], `${where}[${i}].${key}`), ref: assertBlobRef(rec.ref, `${where}[${i}].ref`) };
  });
}

export function assertEnum<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  const s = assertString(value, where);
  if (!(allowed as readonly string[]).includes(s)) {
    throw new SchemaError(`${where} must be one of ${allowed.join('|')}`);
  }
  return s as T;
}

export function assertNullableRecord(
  value: unknown,
  where: string,
  check: (rec: Record<string, unknown>) => void,
): void {
  if (value === null || value === undefined) return;
  const rec = assertRecord(value, where);
  check(rec);
}

/* ------------------------------------------------------------------ */
/* AuthoritativeReviewProfile (structural; Task 5 owns the concrete     */
/* production profile module)                                           */
/* ------------------------------------------------------------------ */

/** Per-kind maximum canonical byte size (design §22; spec §7.1). */
export type BlobKindByteLimits = { readonly [K in AuthoritativeBlobKindV2]: number };

/**
 * Structural profile contract consumed by the pure domains (design §22,
 * §12.3, §16.1). Task 5's concrete profile module must satisfy this shape.
 */
export interface AuthoritativeReviewProfile {
  /** Per-kind blob byte caps; `profile_snapshot` uses the bootstrap maximum instead. */
  maxBytesByKind: BlobKindByteLimits;
  /** Whole-tree slot capacity floor (>=10,000 for the first qualified profile). */
  maxSlots: number;
  /** Total relation instances and per-slot relation cap (only when relations are enabled). */
  maxRelationTotal: number;
  maxRelationsPerSlot: number;
  /** Relation impact propagation caps (§10.3/§10.4). */
  maxRelationHops: number;
  maxClosureNodes: number;
  /** One assignment: primary targets and total covered objects (§12.3). */
  assignmentMaxPrimaryTargets: number;
  assignmentMaxTotalObjects: number;
  /** Finding caps (§22). */
  maxFindingsPerPrimaryTarget: number;
  maxFindingsPerRound: number;
  /** Evidence byte caps (§22/§8.3). */
  evidenceMaxBytesPerItem: number;
  evidenceMaxBytesTotal: number;
  /** Single RepairGrant max write slots (§22). */
  maxRepairGrantWriteSlots: number;
  /** Scope expansions per round (§22). */
  maxScopeExpansionsPerRound: number;
  /** Hard per-track review/repair round budget (§13.3.1). */
  maxRoundsPerTrack: number;
  /** Planned WorkItems per round incl. batching/observation/settlement (§12.5). */
  maxPlannedWorkItemsPerRound: number;
  /** No-semantic-progress retry cap (§12.5/§16.2). */
  maxConsecutiveAttemptsWithoutProgress: number;
  /** Frozen at 1 for the first release (§17.2). */
  maxActiveLeasesPerTask: number;
  /** MapBuild chunk caps (§13.1/§22). */
  mapChunkMaxNodes: number;
  mapChunkMaxRelations: number;
}

/**
 * Template review-policy subset the pure domains consume (design §8.1/§6.2
 * spec). The full contract-v2 parser (later task) supplies these; only the
 * fields the pure rules read are modeled here.
 */
export interface ReviewPolicyParameters {
  mapReview: 'required';
  contentSelector: 'content_bearing';
  mapBatchTargetSlots: number;
  contentBatchTargetSlots: number;
  assignmentSoftLimit: number;
  wholeMapObservation: 'required';
  wholeContentTreeObservation: 'required';
  reviewAdvisoryRelations: boolean;
  maxRounds: number;
}

/* ------------------------------------------------------------------ */
/* §10 Map: position graph, relation graph, candidates, snapshots      */
/* ------------------------------------------------------------------ */

export interface MapPositionNodeV2 {
  slotId: string;
  slotType: string;
  contentBearing: boolean;
  parentSlotId: string | null;
  documentOrder: number;
  siblingOrder: number;
  /** System-computed structural spec digest of the node (node identity rules §10.2). */
  nodeSpecDigest: string;
}

export interface MapRelationV2 {
  relationId: string;
  typeId: string;
  fromSlotId: string;
  toSlotId: string;
  attributes: Record<string, unknown>;
  relationDigest: string;
}

/** Normalized Map graph: position network (always present) + optional relation network. */
export interface NormalizedMapGraphV2 {
  templateSnapshotHash: string;
  nodes: readonly MapPositionNodeV2[];
  relations: readonly MapRelationV2[];
}

/** Relation invalidation propagation policy of one relation type (design §10.3/§10.4). */
export interface MapInvalidationPolicyV2 {
  direction: 'downstream' | 'upstream' | 'both';
  maxHops: number;
}

export type MapInvalidationPolicyIndexV2 = Readonly<Record<string, MapInvalidationPolicyV2>>;

/** Everything an object needs to participate in the pure Map layer. */
export interface MapSemanticSourceV2 {
  templateSnapshotHash: string;
  nodes: readonly MapPositionNodeV2[];
  relations: readonly MapRelationV2[];
}

/** Candidate provenance (§10.1): only system finalizers publish candidates. */
export type MapCandidateProvenanceV2 =
  | {
      producerKind: 'system_map_finalize';
      producerWorkItemId: string;
      commandId: string;
      mapBuildId: string;
      mapBuildRevision: number;
      contributionManifestRef: BlobRefV2;
    }
  | {
      producerKind: 'system_repair_finalize';
      producerWorkItemId: string;
      commandId: string;
      repairPlanId: string;
      repairPlanRevision: number;
      contributionManifestRef: BlobRefV2;
    };

/** §10.1 frozen core frozen BEFORE `map_candidate_commit` validators run. */
export interface MapCandidateValidationCoreV2 {
  candidateId: string;
  baseMapId: string | null;
  positionGraphDigest: string;
  relationGraphDigest: string;
  templateSnapshotHash: string;
  nodes: readonly MapPositionNodeV2[];
  relations: readonly MapRelationV2[];
  candidateProvenanceWithoutValidation: MapCandidateProvenanceV2;
  coreDigest: string;
}

/** §10.1 the frozen, reviewable-but-not-active candidate. */
export interface MapCandidateSnapshotV2 {
  candidateId: string;
  baseMapId: string | null;
  candidateDigest: string;
  validationCoreRef: BlobRefV2;
  candidateValidationAggregateRef: BlobRefV2;
  candidateWarningCustodyRootRef: BlobRefV2;
  /** system-owned (a value passed in — never `new Date()` here). */
  createdAt: string;
}

/** §10.1 core of the proposed (not yet activated) Map. */
export interface ProposedMapCoreV2 {
  scaffoldId: string;
  proposedMapId: string;
  supersedesMapId: string | null;
  sourceCandidateRef: BlobRefV2;
  mapRevision: number;
  mapSemanticDigest: string;
  positionGraphDigest: string;
  relationGraphDigest: string;
  templateSnapshotHash: string;
  nodes: readonly MapPositionNodeV2[];
  relations: readonly MapRelationV2[];
  coreDigest: string;
}

/** §10.1 the immutable ACTIVATED Map revision. */
export interface MapSnapshotV2 {
  scaffoldId: string;
  mapId: string;
  supersedesMapId: string | null;
  sourceCandidateId: string;
  proposedMapCoreRef: BlobRefV2;
  mapReviewBundleRef: BlobRefV2;
  mapRevision: number;
  mapSemanticDigest: string;
  positionGraphDigest: string;
  relationGraphDigest: string;
  templateSnapshotHash: string;
  nodes: readonly MapPositionNodeV2[];
  relations: readonly MapRelationV2[];
  /** system-owned (a value passed in). */
  activatedAt: string;
}

/* ------------------------------------------------------------------ */
/* §11.1/§11.2 Map node/relation review records + §11.3 round/bundle   */
/* ------------------------------------------------------------------ */

export type ReviewEvidenceV2 = {
  evidenceDigest: string;
  text: string;
  refs: readonly BlobRefV2[];
};

export type MapReviewVerdictV2 = 'pass' | 'reject';
export type ReviewFactSourceV2 = 'batch' | 'whole_observation';
export type MapReviewSourceV2 = 'batch' | 'whole_map_observation';
export type ContentReviewSourceV2 = 'batch' | 'whole_tree_observation';

export interface MapNodeReviewRecordV2 {
  recordId: string;
  mapReviewRoundId: string;
  assignmentId: string;
  candidateId: string;
  candidateDigest: string;
  slotId: string;
  verdict: MapReviewVerdictV2;
  nodeSpecDigest: string;
  positionContextDigest: string;
  relationContextDigest: string;
  reviewPolicyDigest: string;
  findingIds: readonly string[];
  evidence: readonly ReviewEvidenceV2[];
  source: MapReviewSourceV2;
  reviewerAttemptId: string;
  recordedAt: string;
}

export interface MapRelationReviewRecordV2 {
  recordId: string;
  mapReviewRoundId: string;
  assignmentId: string;
  candidateId: string;
  relationId: string;
  verdict: MapReviewVerdictV2;
  relationDigest: string;
  endpointNodeSpecDigests: Readonly<Record<string, string>>;
  reviewPolicyDigest: string;
  findingIds: readonly string[];
  evidence: readonly ReviewEvidenceV2[];
  source: MapReviewSourceV2;
  reviewerAttemptId: string;
  recordedAt: string;
}

export type MapReviewRoundStateV2 =
  | 'planned'
  | 'reviewing_batches'
  | 'whole_map_observation'
  | 'completed'
  | 'settled';

/** §11.3 round ledger identity (rounds are event identities, not blob kinds). */
export interface MapReviewRoundV2 {
  mapReviewRoundId: string;
  candidateId: string;
  candidateDigest: string;
  contentRevisionManifestRef: BlobRefV2 | null;
  /** redundant display value — never authority. */
  contentRootDigest: string | null;
  reviewPolicyDigest: string;
  coverageNodeIds: readonly string[];
  coverageRelationIds: readonly string[];
  assignmentIds: readonly string[];
  inheritedRecordRefs: readonly BlobRefV2[];
  wholeMapObservationRefs: readonly BlobRefV2[];
  verificationFindingStages: readonly string[];
  state: MapReviewRoundStateV2;
  settlementRef: BlobRefV2 | null;
}

/** §11.3 first of the acyclic three-segment Map settlement DAG. */
export interface MapReviewCoverageCoreV2 {
  mapReviewRoundId: string;
  candidateRef: BlobRefV2;
  contentRevisionManifestRef: BlobRefV2 | null;
  /** redundant display value. */
  contentRootDigest: string | null;
  reviewPolicyDigest: string;
  coverageLedgerRootRefs: readonly BlobRefV2[];
  wholeMapObservationRootRefs: readonly BlobRefV2[];
  findingStageRootRef: BlobRefV2;
  coreDigest: string;
}

/** §11.3 second segment — frozen only after the settlement aggregate is clear. */
export interface MapReviewSettlementCoreV2 {
  coverageCoreRef: BlobRefV2;
  mapReviewSettlementValidatorAggregateRef: BlobRefV2;
  coreDigest: string;
}

/** §11.3 final Map pre-review object; `map_approved` derives from its presence. */
export interface MapReviewBundleV2 {
  settlementCoreRef: BlobRefV2;
  proposedMapCoreRef: BlobRefV2;
  mapActivationValidatorAggregateRef: BlobRefV2;
  mapWarningCustodyRootRef: BlobRefV2;
  bundleDigest: string;
}

/* ------------------------------------------------------------------ */
/* §11.4 ReviewFact / ReviewAdoptionRecord                             */
/* ------------------------------------------------------------------ */

export type ReviewFactTargetKindV2 = 'map_node' | 'map_relation' | 'content_slot' | 'content_relation';

/** §7.4 exact origin union. */
export type ReviewFactOriginV2 =
  | { kind: 'batch'; adoptionEligible: true }
  | { kind: 'whole_observation'; adoptionEligible: false };

/** §11.4 immutable review fact — the domain view of one submitted verdict. */
export interface ReviewFactV2 {
  factId: string;
  targetKind: ReviewFactTargetKindV2;
  targetStableId: string;
  verdict: string;
  factOrigin: ReviewFactOriginV2;
  adoptionEligible: boolean;
  localSubjectDigest: string;
  localContextDigest: string;
  reviewPolicyDigest: string;
  findingIds: readonly string[];
  evidence: readonly ReviewEvidenceV2[];
  reviewerAttemptId: string;
  recordedAt: string;
}

/** §11.4 system-created per-fact adoption proving local digest identity with the current baseline. */
export interface ReviewAdoptionRecordV2 {
  adoptionId: string;
  roundKind: 'map' | 'content';
  roundId: string;
  candidateId: string | null;
  mapId: string | null;
  factId: string;
  targetStableId: string;
  expectedLocalSubjectDigest: string;
  expectedLocalContextDigest: string;
  reviewPolicyDigest: string;
  adoptedBy: 'system';
}

/* ------------------------------------------------------------------ */
/* §11.5 content versions, manifest, migration objects                 */
/* ------------------------------------------------------------------ */

export type SlotPresenceV2 = 'required' | 'optional';

export type SlotContentUnsetReasonV2 = 'initial' | 'new_slot' | 'schema_reset' | 'carried_optional_unset';

export type SlotContentUnsetProvenanceV2 =
  | { kind: 'created_empty' }
  | {
      kind: 'rebased_after_map_activation';
      sourceVersionRef: BlobRefV2;
      contentMigrationSettlementCoreRef: BlobRefV2;
      compatibilityProofRef: BlobRefV2;
    };

export type SlotContentRewriteCauseV2 =
  | {
      kind: 'validation_rejected';
      blockingValidatorAggregateRef: BlobRefV2;
      validationReceiptRef: BlobRefV2;
      findingSetRef: BlobRefV2;
    }
  | { kind: 'mixed_rewrite_required'; findingStageRootRef: BlobRefV2 };

export type SlotContentSetProvenanceV2 =
  | {
      kind: 'generated';
      producer:
        | { kind: 'generation_batch'; planRevisionId: string; batchOrdinal: number; attemptId: string }
        | { kind: 'content_repair_batch'; planRevisionId: string; batchOrdinal: number; attemptId: string };
      contentRevisionCommitCoreRef: BlobRefV2;
      contentCommitValidatorAggregateRef: BlobRefV2;
      contentCommitWarningRootRef: BlobRefV2;
      committedByAttemptId: string;
    }
  | {
      kind: 'inherited_after_map_activation';
      sourceVersionRef: BlobRefV2;
      contentMigrationSettlementCoreRef: BlobRefV2;
      compatibilityProofRef: BlobRefV2;
      localValidatorEquivalenceProofRef: BlobRefV2 | null;
      migratedBatchValidatorAggregateRef: BlobRefV2 | null;
      migratedBatchWarningRootRef: BlobRefV2 | null;
      migrationReason: 'stable_slot_and_schema_compatible';
    };

/** §11.5 exact three-state slot content version — each instance is a canonical Blob. */
export type SlotContentVersionV2 =
  | {
      state: 'unset';
      slotId: string;
      slotRevision: number;
      taskContentRevision: number;
      mapRef: BlobRefV2;
      mapSemanticDigest: string;
      contentSchemaDigest: string;
      unsetReason: SlotContentUnsetReasonV2;
      unsetProvenance: SlotContentUnsetProvenanceV2;
    }
  | {
      state: 'rewrite_required';
      slotId: string;
      slotRevision: number;
      taskContentRevision: number;
      mapRef: BlobRefV2;
      mapSemanticDigest: string;
      contentSchemaDigest: string;
      sourceVersionRef: BlobRefV2;
      contentMigrationSettlementCoreRef: BlobRefV2;
      rewriteCause: SlotContentRewriteCauseV2;
      sourceContentDigest: string | null;
    }
  | {
      state: 'set';
      slotId: string;
      slotRevision: number;
      contentDigest: string;
      taskContentRevision: number;
      mapRef: BlobRefV2;
      mapSemanticDigest: string;
      contentSchemaDigest: string;
      blobRef: BlobRefV2;
      provenance: SlotContentSetProvenanceV2;
    };

export interface ContentCompatibilityProofV2 {
  taskId: string;
  slotId: string;
  sourceVersionRef: BlobRefV2;
  sourceMapRef: BlobRefV2;
  targetMapRef: BlobRefV2;
  sourceContentSchemaDigest: string;
  targetContentSchemaDigest: string;
  stableIdentityEvidenceRef: BlobRefV2;
  proofPolicyVersion: string;
  proofDigest: string;
}

export type MigrationIntentDecisionV2 =
  | {
      action: 'inherit_or_validate';
      slotId: string;
      sourceVersionRef: BlobRefV2;
      compatibilityProofRef: BlobRefV2;
    }
  | {
      action: 'carry_unset';
      slotId: string;
      sourceVersionRef: BlobRefV2;
      compatibilityProofRef: BlobRefV2;
    }
  | {
      action: 'rewrite_required';
      slotId: string;
      sourceVersionRef: BlobRefV2;
      rewriteReason: 'mixed_rewrite_required';
      findingStageRootRef: BlobRefV2;
    }
  | {
      action: 'new_or_schema_reset';
      slotId: string;
      unsetReason: 'new_slot' | 'schema_reset';
      sourceVersionRef: BlobRefV2 | null;
    };

export interface ContentMigrationIntentCoreV2 {
  taskId: string;
  migrationSpecRef: BlobRefV2;
  sourceManifestRef: BlobRefV2;
  sourceMapRef: BlobRefV2;
  targetMapRef: BlobRefV2;
  decisions: readonly MigrationIntentDecisionV2[];
  impactClosureRef: BlobRefV2;
  migrationPolicyVersion: string;
  coreDigest: string;
}

export type MigrationSettlementOutcomeV2 =
  | {
      outcome: 'inherit_equivalent';
      slotId: string;
      sourceVersionRef: BlobRefV2;
      compatibilityProofRef: BlobRefV2;
      localValidatorEquivalenceProofRef: BlobRefV2;
    }
  | {
      outcome: 'inherit_revalidated';
      slotId: string;
      sourceVersionRef: BlobRefV2;
      compatibilityProofRef: BlobRefV2;
      migratedBatchValidatorAggregateRef: BlobRefV2;
      migratedBatchWarningRootRef: BlobRefV2;
    }
  | {
      outcome: 'carry_unset';
      slotId: string;
      sourceVersionRef: BlobRefV2;
      compatibilityProofRef: BlobRefV2;
    }
  | {
      outcome: 'unset';
      slotId: string;
      unsetReason: 'new_slot' | 'schema_reset';
    }
  | {
      outcome: 'rewrite_required';
      slotId: string;
      sourceVersionRef: BlobRefV2;
      rewriteCause: 'validation_rejected' | 'mixed_rewrite_required';
      blockingValidatorAggregateRef: BlobRefV2 | null;
      validationReceiptRef: BlobRefV2 | null;
      findingStageRootRef: BlobRefV2 | null;
    };

export type MigrationBatchRouteOutcomeV2 = 'clear' | 'content_repair' | 'map_repair' | 'infrastructure_failure';

export interface ContentMigrationSettlementCoreV2 {
  migrationIntentCoreRef: BlobRefV2;
  migrationValidationPlanSpecRef: BlobRefV2;
  orderedBatchResultRootRefs: readonly BlobRefV2[];
  decisions: readonly MigrationSettlementOutcomeV2[];
  batchClassifiedFindingSetRef: BlobRefV2 | null;
  batchRouteOutcome: MigrationBatchRouteOutcomeV2;
  settlementDigest: string;
}

export type MigrationBatchSlotResultV2 =
  | { outcome: 'equivalent'; slotId: string; localValidatorEquivalenceProofRef: BlobRefV2 }
  | { outcome: 'revalidated'; slotId: string; validatorAggregateRef: BlobRefV2; warningRootRef: BlobRefV2 }
  | {
      outcome: 'rejected';
      slotId: string;
      validatorAggregateRef: BlobRefV2;
      validationReceiptRef: BlobRefV2;
      findingSetRef: BlobRefV2;
    };

export interface MigrationValidationBatchResultV2 {
  migrationValidationPlanSpecRef: BlobRefV2;
  batchOrdinal: number;
  slotResults: readonly MigrationBatchSlotResultV2[];
  batchOutcome: MigrationBatchRouteOutcomeV2;
  resultDigest: string;
}

export interface MigrationActivationDecisionV2 {
  migrationSettlementCoreRef: BlobRefV2;
  provisionalManifestRef: BlobRefV2;
  contentPlanFinalizeCoreRef: BlobRefV2;
  finalizerAggregateRef: BlobRefV2;
  combinedClassifiedFindingSetRef: BlobRefV2 | null;
  combinedRouteOutcome: MigrationBatchRouteOutcomeV2;
  decisionPolicyVersion: string;
  decisionDigest: string;
}

export interface ContentMigrationSpecV2 {
  migrationId: string;
  mapReviewSettlementCoreRef: BlobRefV2;
  sourceManifestRef: BlobRefV2;
  sourceMapRef: BlobRefV2;
  targetMapRef: BlobRefV2;
  impactClosureRef: BlobRefV2;
  migrationPolicyVersion: string;
  specDigest: string;
}

export interface ContentMigrationValidationPlanSpecV2 {
  migrationValidationPlanId: string;
  migrationIntentCoreRef: BlobRefV2;
  candidateRef: BlobRefV2;
  proposedMapCoreRef: BlobRefV2;
  sourceManifestRef: BlobRefV2;
  frozenRegistrationSetDigest: string;
  orderedBatchSlotIds: readonly (readonly string[])[];
  profileRef: BlobRefV2;
  specDigest: string;
}

export interface LocalValidatorEquivalenceProofV2 {
  slotId: string;
  sourceVersionRef: BlobRefV2;
  sourceMapRef: BlobRefV2;
  targetMapRef: BlobRefV2;
  sourceBatchInputRef: BlobRefV2;
  frozenRegistrationSetDigest: string;
  localMapSubgraphDigest: string;
  localRelationContextDigest: string;
  selectorExpansionDigest: string;
  equivalencePolicyVersion: string;
  proofDigest: string;
}

export type ContentRevisionManifestPhaseV2 = 'baseline_unset' | 'provisional' | 'finalized';

export interface ContentRevisionManifestEntryV2 {
  slotId: string;
  versionRef: BlobRefV2;
}

/** §11.5 the authoritative content revision — sorted by slot ID, complete over the Map. */
export interface ContentRevisionManifestV2 {
  taskId: string;
  mapRef: BlobRefV2;
  /** must equal resolve(mapRef).mapSemanticDigest. */
  mapSemanticDigest: string;
  taskContentRevision: number;
  manifestPhase: ContentRevisionManifestPhaseV2;
  entries: readonly ContentRevisionManifestEntryV2[];
  producerPlanSpecRef: BlobRefV2 | null;
  priorManifestRef: BlobRefV2 | null;
  finalizerValidatorAggregateRefs: readonly BlobRefV2[];
  finalizerWarningRootRefs: readonly BlobRefV2[];
  contentRootDigest: string;
  manifestDigest: string;
}

export type ContentValidationCoreV2 =
  | { phase: 'batch_commit'; contentRevisionCommitCoreRef: BlobRefV2 }
  | { phase: 'plan_finalize'; contentPlanFinalizeCoreRef: BlobRefV2 };

export interface ContentRevisionCommitCoreV2 {
  priorManifestRef: BlobRefV2;
  producerPlanSpecRef: BlobRefV2;
  batchOrdinal: number;
  authorizedReplacementEntriesWithoutValidation: readonly { slotId: string; expectedCurrentVersionRef: BlobRefV2 | null }[];
  expectedMapRef: BlobRefV2;
  coreDigest: string;
}

export type ContentPlanFinalizeMapContextV2 =
  | { kind: 'active'; activeMapRef: BlobRefV2 }
  | {
      kind: 'migration_preactivation';
      candidateRef: BlobRefV2;
      proposedMapCoreRef: BlobRefV2;
      targetMapRef: BlobRefV2;
      migrationValidationPlanSpecRef: BlobRefV2;
      migrationSettlementCoreRef: BlobRefV2;
      settlementOperationId: string;
    };

export interface ContentPlanFinalizeCoreV2 {
  producerPlanSpecRef: BlobRefV2;
  provisionalManifestRef: BlobRefV2;
  mapContext: ContentPlanFinalizeMapContextV2;
  expectedContentRootDigest: string;
  requiredSlotCoverageDigest: string;
  expectedBatchClosureDigest: string;
  coreDigest: string;
}

/** §11.6 presence-aware content coverage fact — closed two-state union. */
export type ContentSlotCoverageFactV2 =
  | {
      disposition: 'reviewed';
      slotId: string;
      contentVersionRef: BlobRefV2;
      reviewFactRef: BlobRefV2;
    }
  | {
      disposition: 'absent_not_applicable';
      slotId: string;
      contentVersionRef: BlobRefV2;
      presencePolicyDigest: string;
      producedBy: 'system';
    };

/** §11.6 slot review record (single verdict, not itself the gate fact). */
export interface SlotReviewRecordV2 {
  recordId: string;
  reviewRoundId: string;
  assignmentId: string;
  slotId: string;
  verdict: MapReviewVerdictV2;
  contentVersionRef: BlobRefV2;
  contentDigest: string | null;
  contextSlotDigests: Readonly<Record<string, string>>;
  mapSubgraphDigest: string;
  reviewPolicyDigest: string;
  findingIds: readonly string[];
  evidence: readonly ReviewEvidenceV2[];
  source: ContentReviewSourceV2;
  reviewerAttemptId: string;
  recordedAt: string;
}

/** §11.7 relation satisfaction record (content review of an actual relation). */
export interface RelationReviewRecordV2 {
  recordId: string;
  reviewRoundId: string;
  assignmentId: string;
  relationId: string;
  verdict: 'satisfied' | 'violated';
  relationDigest: string;
  relationContextDigest: string;
  evidenceSlotDigests: Readonly<Record<string, string>>;
  mapId: string;
  reviewPolicyDigest: string;
  findingIds: readonly string[];
  evidence: readonly ReviewEvidenceV2[];
  reviewerAttemptId: string;
}

/* ------------------------------------------------------------------ */
/* §11.10 content ReviewRound and the acyclic three-segment DAG        */
/* ------------------------------------------------------------------ */

export type ReviewRoundStateV2 =
  | 'planned'
  | 'reviewing_batches'
  | 'whole_tree_observation'
  | 'completed'
  | 'settled';

export interface ReviewRoundV2 {
  reviewRoundId: string;
  mapRef: BlobRefV2;
  mapSemanticDigest: string;
  contentRevisionManifestRef: BlobRefV2;
  /** redundant display value. */
  contentRootDigest: string;
  reviewPolicyDigest: string;
  coverageSlotIds: readonly string[];
  coverageRelationIds: readonly string[];
  assignmentSlotIds: readonly string[];
  assignmentRelationIds: readonly string[];
  verificationFindingIds: readonly string[];
  verificationFindingStages: readonly string[];
  assignmentIds: readonly string[];
  inheritedRecordRefs: readonly BlobRefV2[];
  wholeTreeObservationRefs: readonly BlobRefV2[];
  state: ReviewRoundStateV2;
  settlementRef: BlobRefV2 | null;
}

export interface ContentReviewCoverageCoreV2 {
  reviewRoundId: string;
  mapRef: BlobRefV2;
  contentRevisionManifestRef: BlobRefV2;
  reviewPolicyDigest: string;
  coverageLedgerRootRefs: readonly BlobRefV2[];
  adoptionRootRef: BlobRefV2;
  wholeTreeObservationRootRefs: readonly BlobRefV2[];
  findingStageRootRef: BlobRefV2;
  coreDigest: string;
}

export interface ContentReviewSettlementCoreV2 {
  coverageCoreRef: BlobRefV2;
  reviewSettlementValidatorAggregateRef: BlobRefV2;
  coreDigest: string;
}

export interface ReviewBundleV2 {
  settlementCoreRef: BlobRefV2;
  mapRef: BlobRefV2;
  contentRevisionManifestRef: BlobRefV2;
  reviewWarningCustodyRootRef: BlobRefV2;
  bundleDigest: string;
}

/** §12.4/§19: one immutable AssignmentLedgerBlob freezes one completed review assignment. */
export interface AssignmentLedgerBlobV2 {
  assignmentId: string;
  workItemId: string;
  reviewAssignmentId: string | null;
  roundKind: 'map' | 'content';
  roundId: string;
  factRefs: readonly BlobRefV2[];
  findingDraftRefs: readonly BlobRefV2[];
  verificationRecordRefs: readonly BlobRefV2[];
  /** deterministic canonical order (sorted by target stable id). */
  coverageTargetIds: readonly string[];
  ledgerDigest: string;
}

/** §19: adoption chunk ledger (system-owned; not an Agent assignment). */
export interface ReviewAdoptionLedgerBlobV2 {
  roundId: string;
  chunkIndex: number;
  adoptionRecords: readonly ReviewAdoptionRecordV2[];
  blobDigest: string;
}

/** §19: adoption root closing the chunk closure; 0 adoptions use the canonical empty root. */
export interface ReviewAdoptionRootV2 {
  roundId: string;
  orderedChunkRefs: readonly BlobRefV2[];
  adoptedTargetCount: number;
  coverageDigest: string;
  rootDigest: string;
}

/** §11.3/§11.10: finding stage terminal states tracked by round settlement. */
export interface FindingStageRootV2 {
  rootId: string;
  roundId: string;
  entries: readonly { findingId: string; repairStage: 'map' | 'content'; state: 'pending' | 'committed' | 'verified' }[];
  rootDigest: string;
}

/** Deterministic ordered finding set (used by rewrite causes and routing obligations). */
export interface FindingSetV2 {
  findingSetId: string;
  findingRefs: readonly BlobRefV2[];
  setDigest: string;
}

/* ------------------------------------------------------------------ */
/* §11.8/§11.9 Finding and verification                                */
/* ------------------------------------------------------------------ */

export type FindingRepairStageStateV2 = 'not_required' | 'pending' | 'committed' | 'verified';

export interface FindingV2 {
  findingId: string;
  reviewContext: { kind: 'map' | 'content'; roundId: string };
  primaryLocation: { kind: 'slot' | 'relation' | 'map_node' | 'map'; id: string };
  relatedSlotIds: readonly string[];
  relatedRelationIds: readonly string[];
  defectClass: 'content' | 'map' | 'mixed';
  severity: 'blocking' | 'advisory';
  source: 'reviewer' | 'system_validator';
  evidence: readonly ReviewEvidenceV2[];
  suggestedRepairSlotIds: readonly string[];
  status: 'open' | 'repair_planned' | 'repair_dispatched' | 'addressed' | 'verified_closed';
  repairProgress: { map: FindingRepairStageStateV2; content: FindingRepairStageStateV2 };
  openedBy:
    | { kind: 'reviewer'; reviewerAttemptId: string }
    | { kind: 'system_validator'; validatorExecutionId: string };
}

export interface FindingVerificationRecordV2 {
  recordId: string;
  reviewContext: { kind: 'map' | 'content'; roundId: string };
  assignmentId: string;
  findingId: string;
  repairStage: 'map' | 'content';
  verdict: 'resolved' | 'still_present';
  candidateId: string | null;
  mapId: string | null;
  mapContextDigests: Readonly<Record<string, string>>;
  evidenceSlotDigests: Readonly<Record<string, string>>;
  reviewPolicyDigest: string;
  evidence: readonly ReviewEvidenceV2[];
  reviewerAttemptId: string;
}

/* ------------------------------------------------------------------ */
/* §11.11 WriteGrantSpec / GrantInstance / repair-scope types          */
/* ------------------------------------------------------------------ */

export type RepairAuthorityBaseV2 =
  | { kind: 'map_active'; mapRef: BlobRefV2 }
  | { kind: 'map_candidate'; candidateRef: BlobRefV2 }
  | { kind: 'content'; mapRef: BlobRefV2; contentRevisionManifestRef: BlobRefV2 };

export interface MapWriteScopeV2 {
  nodeIds: readonly string[];
  relationIds: readonly string[];
  allowedPlanKeys: readonly string[];
  parentContainers: readonly string[];
  relationTypeIds: readonly string[];
  operations: readonly ('add_node' | 'remove_node' | 'add_relation' | 'remove_relation' | 'update_attributes')[];
}

export interface InitialStructureGrantSpecV2 {
  grantSpecId: string;
  workItemId: string;
  kind: 'initial_structure_chunk';
  snapshotHash: string;
  authorityBaseRef: BlobRefV2;
  mapBuildSpecRef: BlobRefV2;
  expectedFrontierDigest: string;
  structureChunkScope: {
    chunkOrdinal: number;
    parentFrontierDigest: string;
    maxNodes: number;
    maxRelations: number;
  };
  specDigest: string;
}

export interface InitialGenerationGrantSpecV2 {
  grantSpecId: string;
  workItemId: string;
  kind: 'initial_generation_batch';
  snapshotHash: string;
  authorityBaseRef: BlobRefV2;
  generationPlanSpecRef: BlobRefV2;
  activeMapRef: BlobRefV2;
  expectedContentRevisionManifestRef: BlobRefV2;
  writeSlotIds: readonly string[];
  /** bounded full-tree read scope (profile byte cap). */
  readScope: { maxContextBytes: number };
  specDigest: string;
}

export interface RepairBatchGrantSpecV2 {
  grantSpecId: string;
  workItemId: string;
  kind: 'map_repair_batch' | 'content_repair_batch';
  snapshotHash: string;
  authorityBaseRef: BlobRefV2;
  repairPlanSpecRef: BlobRefV2;
  repairBase: RepairAuthorityBaseV2;
  expectedStagingRootRef: BlobRefV2;
  planKeyLedgerRef: BlobRefV2 | null;
  batchOrdinal: number;
  findingIds: readonly string[];
  readScope: { maxContextBytes: number };
  writeScope: { writeSlotIds: readonly string[] } | { mapWriteScope: MapWriteScopeV2 };
  specDigest: string;
}

/**
 * Task 13 GRANT-SPEC TENSION RESOLUTION (Task 10 review ruling carried here):
 * the frozen Task 7 created-event validator mandates `grantSpecRef !== null`
 * on EVERY `agent_assignment` workitem, but design §11.11 defined WriteGrantSpec
 * kinds only for the four write sessions (initial_structure_chunk /
 * initial_generation_batch / map_repair_batch / content_repair_batch). The
 * reviewer and submitter workitems therefore need a LEGAL, registrable spec
 * whose write authority is EMPTY. This branch is that spec: it carries NO
 * write-scope field at all (the exact-key parser can never accept a write
 * target), grants read-only + verification + bounded evidence, and is bound to
 * the review assignment/round. It satisfies the frozen validator while
 * preserving design §7/§11.11 "审核 Agent 不能获得结构槽写 Grant". Task 10's
 * `shouldSignGrantInstance` predicate continues to gate MATERIALIZATION: the
 * reviewer/submitter spec is never signed into a GrantInstance (its dispatch
 * `grantInstanceRef` stays null) — the tool closure reads the SPEC only.
 */
export const REVIEW_OBSERVATION_GRANT_KIND = 'review_observation' as const;

export interface ReviewObservationGrantSpecV2 {
  grantSpecId: string;
  workItemId: string;
  kind: typeof REVIEW_OBSERVATION_GRANT_KIND;
  snapshotHash: string;
  authorityBaseRef: BlobRefV2;
  /** null for the generic submitter (never a structured reviewer). */
  sessionKind: StructuredSessionKindV2 | null;
  reviewAssignmentId: string | null;
  roundId: string | null;
  roundKind: 'map' | 'content' | null;
  /** bounded full-tree/assignment read scope (profile byte cap). */
  readScope: { maxContextBytes: number };
  specDigest: string;
}

/**
 * §11.11 closed WriteGrantSpec union — Task 13 EXTENDED with the
 * `review_observation` branch (the grant-spec tension resolution). schemaVersion
 * stays 1: the capability is disabled, zero production payload blobs exist, and
 * the four original branches parse byte-identically.
 */
export type WriteGrantSpecV2 =
  | InitialStructureGrantSpecV2
  | InitialGenerationGrantSpecV2
  | RepairBatchGrantSpecV2
  | ReviewObservationGrantSpecV2;

/** Write-authority classification of a spec (empty for reviewer/submitter). */
export type GrantWriteAuthorityV2 = 'structure' | 'generation' | 'map_repair' | 'content_repair' | 'none';

export function grantWriteAuthority(spec: WriteGrantSpecV2): GrantWriteAuthorityV2 {
  switch (spec.kind) {
    case 'initial_structure_chunk':
      return 'structure';
    case 'initial_generation_batch':
      return 'generation';
    case 'map_repair_batch':
      return 'map_repair';
    case 'content_repair_batch':
      return 'content_repair';
    case REVIEW_OBSERVATION_GRANT_KIND:
      return 'none';
  }
}

/** The write-slot ids of a content write spec (empty for every other kind). */
export function grantSpecWriteSlotIds(spec: WriteGrantSpecV2): readonly string[] {
  switch (spec.kind) {
    case 'initial_generation_batch':
      return spec.writeSlotIds;
    case 'content_repair_batch':
      return 'writeSlotIds' in spec.writeScope ? spec.writeScope.writeSlotIds : [];
    default:
      return [];
  }
}

/** The Map-write scope of a map write spec (null for every other kind). */
export function grantSpecMapWriteScope(spec: WriteGrantSpecV2): MapWriteScopeV2 | null {
  if (spec.kind !== 'map_repair_batch') return null;
  return 'mapWriteScope' in spec.writeScope ? spec.writeScope.mapWriteScope : null;
}

export interface GrantInstanceV2 {
  grantInstanceId: string;
  grantSpecRef: BlobRefV2;
  workItemId: string;
  leaseEpoch: number;
  boundAttemptId: string;
  agentId: string;
  instanceDigest: string;
}

/* ------------------------------------------------------------------ */
/* §11.11/§13 plan specs, build ledger objects, contribution manifest  */
/* ------------------------------------------------------------------ */

export interface MapBuildSpecV2 {
  mapBuildId: string;
  revision: number;
  supersedesMapBuildId: string | null;
  sourceValidationReceiptRef: BlobRefV2 | null;
  snapshotHash: string;
  plannedChunkPolicy: { maxChunks: number; maxNodesPerChunk: number; maxRelationsPerChunk: number };
  specDigest: string;
}

export interface MapBuildNodeKeyDeclarationV2 {
  buildNodeKey: string;
  slotType: string;
  parentBuildNodeKey: string | null;
  documentOrder: number;
  siblingOrder: number;
  contentBearing: boolean;
}

export interface MapBuildRelationKeyDeclarationV2 {
  buildRelationKey: string;
  typeId: string;
  fromBuildNodeKey: string;
  toBuildNodeKey: string;
  attributes: Record<string, unknown>;
}

export interface MapBuildChunkV2 {
  chunkId: string;
  mapBuildId: string;
  chunkOrdinal: number;
  parentFrontierDigest: string;
  nodeDeclarations: readonly MapBuildNodeKeyDeclarationV2[];
  relationDeclarations: readonly MapBuildRelationKeyDeclarationV2[];
  chunkDigest: string;
}

export interface MapBuildManifestV2 {
  mapBuildId: string;
  manifestOrdinal: number;
  orderedChunkEntries: readonly { chunkOrdinal: number; chunkRef: BlobRefV2 }[];
  keyLedgerRef: BlobRefV2;
  manifestDigest: string;
}

export interface MapBuildKeyLedgerV2 {
  mapBuildId: string;
  revision: number;
  entries: readonly {
    buildKey: string;
    kind: 'node' | 'relation';
    officialId: string | null;
    declaredByChunkOrdinal: number;
    /**
     * Task 15 (map-build service, design §10.2): build keys are active while a
     * later chunk may reference them; a `tombstone` key is abandoned history
     * (a superseded/rejected build's key the successor does NOT import) and
     * may never be referenced again. schemaVersion stays 1 — the capability is
     * disabled and no production ledger bytes exist (documented in the Task 15
     * report).
     */
    status: 'active' | 'tombstone';
  }[];
  ledgerDigest: string;
}

export interface GenerationPlanSpecV2 {
  generationPlanId: string;
  revision: number;
  supersedesGenerationPlanId: string | null;
  sourceValidationReceiptRef: BlobRefV2 | null;
  activeMapRef: BlobRefV2;
  baseContentRevisionManifestRef: BlobRefV2;
  importedContentManifestRef: BlobRefV2;
  correctionScopeDigest: string | null;
  orderedBatchSlotIds: readonly (readonly string[])[];
  specDigest: string;
}

export type RepairPlanOriginV2 =
  | { kind: 'initial'; settlementId: string; settlementDigest: string; creationOperationKey: string }
  | {
      kind: 'successor';
      supersedesPlanSpecRef: BlobRefV2;
      successorReason: 'scope_expansion' | 'validation_correction' | 'recovery';
      successorOperationKey: string;
    };

export type RepairBatchScopeV2 =
  | { kind: 'map'; batchOrdinal: number; findingIds: readonly string[]; scope: MapWriteScopeV2 }
  | { kind: 'content'; batchOrdinal: number; findingIds: readonly string[]; slotIds: readonly string[] };

export interface RepairPlanSpecV2 {
  repairPlanId: string;
  revision: number;
  planRevisionId: string;
  origin: RepairPlanOriginV2;
  sourceReceiptRef: BlobRefV2 | null;
  repairBase: RepairAuthorityBaseV2;
  orderedBatchScopes: readonly RepairBatchScopeV2[];
  keyLineageRef: BlobRefV2;
  importedStagingManifestRef: BlobRefV2;
  specDigest: string;
}

export interface RepairKeyLedgerV2 {
  repairPlanId: string;
  planRevisionId: string;
  entries: readonly {
    planKey: string;
    kind: 'node' | 'relation';
    officialId: string | null;
    status: 'active' | 'tombstone';
    predecessorPlanKey: string | null;
  }[];
  ledgerDigest: string;
}

export interface RepairStagingRootV2 {
  repairPlanId: string;
  planRevisionId: string;
  batchOrdinal: number;
  mapRootDigest: string | null;
  contentRootDigest: string | null;
  /** Complete cumulative staged content artifact for this ordinal. Null for
   * Map repair roots. This event-rooted edge retains every content version
   * and its validator provenance before the finalizer publishes a revision. */
  contentManifestRef: BlobRefV2 | null;
  priorStagingRootRef: BlobRefV2 | null;
  keyLedgerRef: BlobRefV2;
  stagingDigest: string;
}

/** §10.1/§12.5 candidate/build contribution manifest (private; traceable provenance). */
export interface ContributionManifestV2 {
  contributionManifestId: string;
  producerKind: 'map_build' | 'repair';
  planId: string;
  planRevision: number;
  orderedChunkOrBatchRefs: readonly BlobRefV2[];
  stagingRootRef: BlobRefV2 | null;
  keyLedgerRefs: readonly BlobRefV2[];
  agentAttemptIdentities: readonly { workItemId: string; attemptId: string }[];
  manifestDigest: string;
}

/* ------------------------------------------------------------------ */
/* §9/§12 validator objects                                            */
/* ------------------------------------------------------------------ */

export interface ValidatorIssueV2 {
  validatorId: string;
  implementationDigest: string;
  issueCode: string;
  location: { targetKind: string; stableTargetId: string; jsonPointer: string | null };
  repairTargets: { mapNodeIds: readonly string[]; relationIds: readonly string[]; slotIds: readonly string[] };
  evidenceDigest: string;
}

export type ValidatorResultV2 =
  | { status: 'valid'; executionDigest: string }
  | { status: 'domain_invalid'; issues: readonly [ValidatorIssueV2, ...ValidatorIssueV2[]]; executionDigest: string };

export type ValidatorTriggerV2 =
  | 'map_candidate_commit'
  | 'map_review_settlement'
  | 'map_activation'
  | 'content_commit'
  | 'repair_finalize'
  | 'review_settlement'
  | 'seal_input'
  | 'seal_output';

/** §9 exact seven-branch input envelope — its own canonical Blob. */
export type ValidatorInputEnvelopeV2 =
  | { trigger: 'map_candidate_commit'; taskId: string; templateSnapshotHash: string; mapCandidateValidationCoreRef: BlobRefV2; selectedTargetRefs: readonly BlobRefV2[] }
  | { trigger: 'map_review_settlement'; taskId: string; templateSnapshotHash: string; mapReviewCoverageCoreRef: BlobRefV2; selectedTargetRefs: readonly BlobRefV2[] }
  | { trigger: 'map_activation'; taskId: string; templateSnapshotHash: string; mapReviewSettlementCoreRef: BlobRefV2; proposedMapCoreRef: BlobRefV2; selectedTargetRefs: readonly BlobRefV2[] }
  | { trigger: 'content_commit'; executionPhase: 'batch_commit' | 'plan_finalize'; taskId: string; templateSnapshotHash: string; contentValidationCoreRef: BlobRefV2; selectedTargetRefs: readonly BlobRefV2[] }
  | { trigger: 'review_settlement'; taskId: string; templateSnapshotHash: string; contentReviewCoverageCoreRef: BlobRefV2; selectedTargetRefs: readonly BlobRefV2[] }
  | { trigger: 'repair_finalize'; taskId: string; templateSnapshotHash: string; repairPlanSpecRef: BlobRefV2; stagingRootRef: BlobRefV2; keyLedgerRef: BlobRefV2; stagedArtifactRef: BlobRefV2; selectedTargetRefs: readonly BlobRefV2[] }
  | { trigger: 'seal_input'; taskId: string; templateSnapshotHash: string; reviewBundleRef: BlobRefV2; selectedTargetRefs: readonly BlobRefV2[] }
  | { trigger: 'seal_output'; taskId: string; templateSnapshotHash: string; reviewBundleRef: BlobRefV2; artifactRef: BlobRefV2; selectedTargetRefs: readonly BlobRefV2[] };

export type ValidatorAggregateOutcomeV2 = 'clear' | 'blocking_invalid' | 'infrastructure_failure';

/** §9 exact normalized aggregate consumed by every finalizer/Gate. */
export interface ValidatorAggregateV2 {
  trigger: ValidatorTriggerV2;
  executionPhase: 'batch_commit' | 'plan_finalize' | null;
  inputRef: BlobRefV2;
  /** must equal inputRef.digest (redundant display). */
  inputDigest: string;
  registrationSetDigest: string;
  validExecutionDigests: readonly string[];
  blockingInvalidReceiptRefs: readonly BlobRefV2[];
  advisoryReceiptRefs: readonly BlobRefV2[];
  infrastructureFailureRefs: readonly BlobRefV2[];
  warningRootRef: BlobRefV2;
  aggregateDigest: string;
  outcome: ValidatorAggregateOutcomeV2;
}

export interface ValidationWarningRootV2 {
  trigger: ValidatorTriggerV2;
  executionPhase: 'batch_commit' | 'plan_finalize' | null;
  inputRef: BlobRefV2;
  inputDigest: string;
  orderedAdvisoryReceiptRefs: readonly BlobRefV2[];
  warningCount: number;
  rootDigest: string;
}

export type ValidationWarningCustodyScopeV2 = 'map_candidate' | 'map_review' | 'content_review' | 'seal';

export interface ValidationWarningCustodyRootV2 {
  scope: ValidationWarningCustodyScopeV2;
  taskId: string;
  baseRefs: readonly BlobRefV2[];
  entries: readonly {
    trigger: ValidatorTriggerV2;
    inputRef: BlobRefV2;
    inputDigest: string;
    executionScope: { planRevisionId?: string; batchOrdinal?: number; roundId?: string; sealWorkItemId?: string };
    validatorAggregateRef: BlobRefV2;
    warningRootRef: BlobRefV2;
  }[];
  supersessionPolicyVersion: string;
  rootDigest: string;
}

/** §9 infrastructure-failure evidence blob (never "missing execution"). */
export interface ValidatorFailureV2 {
  validatorId: string;
  handlerKey: string;
  implementationDigest: string;
  executionId: string;
  inputRef: BlobRefV2;
  inputDigest: string;
  failureCode: string;
  failureDigest: string;
  workItemId: string;
  /** exactly one of attemptId | commandId. */
  attemptId: string | null;
  commandId: string | null;
}

/** §9/§16 validation receipts (blocking invalid evidence + lineage refs). */
export interface ValidationReceiptV2 {
  receiptKind: 'map_build' | 'generation' | 'map_repair' | 'content_repair' | 'map_activation' | 'map_review_settlement' | 'review_settlement' | 'repair_finalize' | 'seal_input' | 'seal_output';
  validatorAggregateRef: BlobRefV2;
  blockerIssues: readonly ValidatorIssueV2[];
  /** deterministic labeled lineage refs (chunk/key ledger/active manifest/etc.). */
  lineageRefs: readonly { label: string; ref: BlobRefV2 }[];
  receiptDigest: string;
}

/* ------------------------------------------------------------------ */
/* §16.3 SealValidationBundle, §17.2 AuthorityBaseSet/WorkItem         */
/* ------------------------------------------------------------------ */

export interface SealValidationBundleV2 {
  sealWorkItemId: string;
  reviewBundleRef: BlobRefV2;
  contentRevisionManifestRef: BlobRefV2;
  sealInputAggregateRef: BlobRefV2;
  sealOutputAggregateRef: BlobRefV2;
  /** seal_output warning entries must be empty in the first release. */
  sealWarningCustodyRootRef: BlobRefV2;
  assemblerDigest: string;
  artifactRef: BlobRefV2;
  /** must equal artifactRef.digest (redundant display). */
  artifactDigest: string;
  bundleDigest: string;
}

export type StructuredSessionKindV2 =
  | 'structure_chunk'
  | 'review_map_batch'
  | 'review_map_whole'
  | 'generation_batch'
  | 'review_content_batch'
  | 'review_content_whole'
  | 'map_repair'
  | 'content_repair';

/**
 * §17.2 exact authority base (spec §10.1 adds the mandatory profile ref;
 * profile/template refs are required for every WorkItem kind).
 */
export interface AuthorityBaseSetV2 {
  taskId: string;
  templateSnapshotRef: BlobRefV2;
  profileSnapshotRef: BlobRefV2;
  mapRef: BlobRefV2 | null;
  mapCandidateRef: BlobRefV2 | null;
  mapReviewBundleRef: BlobRefV2 | null;
  contentRevisionManifestRef: BlobRefV2 | null;
  planSpecRef: BlobRefV2 | null;
  stagingManifestRef: BlobRefV2 | null;
  reviewCoverageCoreRef: BlobRefV2 | null;
  reviewRoundRef: BlobRefV2 | null;
  reviewBundleRef: BlobRefV2 | null;
  sealRecordRef: BlobRefV2 | null;
  artifactRef: BlobRefV2 | null;
  findingSetRef: BlobRefV2 | null;
  artifactDeliveryRef: BlobRefV2 | null;
  /** every entry must equal the corresponding set ref's digest (log/UI only). */
  displayDigests: Readonly<Record<string, string>>;
  baseSetDigest: string;
}

export type WorkItemStateV2 =
  | 'ready'
  | 'leased'
  | 'parked'
  | 'completed'
  | 'retryable_failed'
  | 'terminal_failed'
  | 'superseded';

/** §17.2 park disposition: only `parked` may carry one, and the branches are exclusive. */
export type WorkItemParkDispositionV2 =
  | null
  | { kind: 'retry_budget_exhausted'; retryOrdinal: number; budgetPolicyDigest: string }
  | { kind: 'human_question'; questionId: string; questionVersion: string };

/** §17.2 persistent WorkItem (event-ledger identity — NOT a registered blob kind). */
export interface WorkItemV2 {
  workItemId: string;
  kind: WorkItemKindV2;
  roleBinding: string | null;
  agentExecutionKind: 'structured_session' | 'generic_turn' | null;
  sessionKind: StructuredSessionKindV2 | null;
  roundId: string | null;
  logicalAssignmentId: string | null;
  reviewAssignmentId: string | null;
  grantSpecRef: BlobRefV2 | null;
  inputArtifactDeliveryId: string | null;
  authorityBaseRef: BlobRefV2;
  payloadRef: BlobRefV2;
  state: WorkItemStateV2;
  parkDisposition: WorkItemParkDispositionV2;
  leaseEpoch: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  retryOrdinal: number;
  retryNotBefore: string | null;
  maxAutomaticRetries: number;
}

/** §17.2 agent_input materialization record (not a registered blob kind). */
export interface AssignmentDispatchV2 {
  dispatchId: string;
  workItemId: string;
  logicalAssignmentId: string;
  reviewAssignmentId: string | null;
  attemptId: string;
  authorityBaseRef: BlobRefV2;
  agentExecutionKind: 'structured_session' | 'generic_turn';
  sessionKind: StructuredSessionKindV2 | null;
  grantInstanceRef: BlobRefV2 | null;
  inputArtifactDeliveryId: string | null;
  /** Human scope-disposition carried into a same-scope replacement dispatch. */
  scopeDecisionReason: string | null;
  dispatchDigest: string;
}

/* ------------------------------------------------------------------ */
/* §8 publication operation payload (registered blob kind union)       */
/* ------------------------------------------------------------------ */

/** §17.2/§10.2 reclaim reasons (also carried by attempt/command abandon events). */
export type WorkItemReclaimReasonV2 =
  | 'lease_expired'
  | 'crash_recovery'
  | 'user_stop'
  | 'operator_interrupt';

/** §17.3 suspension overlay reasons (projector derives stopped vs interrupted). */
export type WorkItemSuspensionReasonV2 = 'user_stop' | 'operator_interrupt';

/** Closed system command kinds (SystemCommandAttempt.commandKind, §17.2). */
export type SystemCommandKindV2 =
  | 'map_finalize'
  | 'generation_finalize'
  | 'repair_finalize'
  | 'migration_validation_batch'
  | 'review_settlement'
  | 'seal';

/** Which execution carrier a lease/retry mutation addresses. */
export type AttemptExecutionKindV2 = 'structured' | 'generic' | 'command';

/**
 * Task 12 §9.2 completion gate: true when the workitem's §17.5 completion
 * envelope folds a domain result/successor, so a bare `work_item_completed`
 * (no domain result carrier) is ILLEGAL. Enumerated per design §17.5:
 * - every structured agent session (sessionKind non-null) folds its chunk/
 *   ledger/content/staging result + successor in the same batch;
 * - every system command (map_finalize, generation_finalize, repair_finalize,
 *   migration_validation_batch, review_settlement, seal) folds its candidate/
 *   manifest/round/Seal/delivery result + successor in the same batch;
 * - the generic Submitter (null sessionKind) is NOT gated at the bare level:
 *   its result IS the delivery-bound submission (the completion event carries
 *   the exact `inputArtifactDeliveryId` the projector validates), wired through
 *   the ActionCommitter v2 seam in Task 20.
 */
export function completionKindRequiresResult(
  kind: WorkItemKindV2,
  sessionKind: StructuredSessionKindV2 | null,
): boolean {
  if (kind === 'agent_assignment') {
    return sessionKind !== null;
  }
  return true;
}

/**
 * Task 10 EXTENDED closed event-builder set of the lease_or_retry family
 * (design §19.1 "lease/retry state-only mutation"; spec §7.1). The frozen
 * Task 3 union carried only the three original builders whose envelopes were
 * NOT byte-identically rebuildable (leaseOwner/leaseExpiresAt/
 * expectedLastSequence/reason were absent). Task 10 adds the exact fields the
 * workitem state-machine mutations commit: creation, lease (+dispatch/attempt
 * start), retryable failure (+attempt/command failure), requeue, reclaim
 * (+abandon) and budget park (+attempt/command terminal). schemaVersion stays
 * 1: the capability is disabled, no production payload blobs exist, and every
 * builder still fails closed on absent per-builder fields.
 */
export type WorkItemMutationEventBuilderV2 =
  | 'work_item_created'
  | 'work_item_leased'
  | 'work_item_retryable_failed'
  | 'work_item_requeued'
  | 'work_item_lease_reclaimed'
  | 'work_item_parked'
  /**
   * Task 11 (constraint A round 2): the startup `RUNNING_WITHOUT_WORK`
   * compensation (spec §10.4) commits `structured_task_failed_v2` through the
   * EXACT lease_or_retry payload with this builder — the failure carriers
   * (failureCode/failureDigest/workItemId/leaseEpoch/authorityBaseRef/
   * failureRecoveryPayloadRef) already live in the union, so the branch is
   * byte-rebuildable.
   */
  | 'task_terminal_failed'
  /**
   * Task 11 (constraint A round 2): the terminal-failure envelope the
   * attempt-coordinator (Task 12) uses — [attempt/command terminal_failed,
   * work_item_terminal_failed] and, when `taskFailure=true`,
   * `structured_task_failed_v2` in the SAME batch (§10.3). Registered NOW so
   * the reopen/startup/rejection tests have a legal failing path.
   */
  | 'work_item_terminal_failed'
  /**
   * Task 12 (constraint A round 3): the SUCCESS completion envelope the
   * attempt-coordinator commits — [attempt/command completed,
   * work_item_completed] in ONE batch (§9.2 "Agent completion plus ... attempt
   * terminal, WorkItem completion" all-or-none). The terminal carrier set
   * (attemptFamily/attemptId/commandId/logicalAssignmentId/sessionKind/
   * agentId/inputArtifactDeliveryId) already lives in the union, so the branch
   * is byte-rebuildable from the pin alone.
   */
  | 'work_item_completed';

/**
 * Task 15 §9.2 command-terminal carriers the map_finalize domain-completion
 * handler folds into its ONE-batch envelope (spec §9.2 "SystemCommand
 * completion plus domain result, command terminal, WorkItem completion, and
 * successor"). The payload carries the EXACT command identity so a crashed pin
 * replays the terminal pair byte-identically.
 */
export interface SystemCommandTerminalCarrierV2 {
  workItemId: string;
  commandId: string;
  commandKind: SystemCommandKindV2;
  leaseEpoch: number;
  authorityBaseRef: BlobRefV2;
}

/**
 * Task 15 §9.2 successor-WorkItem carrier the map-build publication handlers
 * fold into their atomic envelope (the `human_answer` replacement pattern).
 * The exact `structured_work_item_created` fields ride the payload so the
 * successor is byte-rebuildable from the pin alone.
 */
export interface SuccessorWorkItemCarrierV2 {
  workItemId: string;
  kind: WorkItemKindV2;
  roleBinding: string | null;
  agentExecutionKind: 'structured_session' | 'generic_turn' | null;
  sessionKind: StructuredSessionKindV2 | null;
  roundId: string | null;
  logicalAssignmentId: string | null;
  reviewAssignmentId: string | null;
  grantSpecRef: BlobRefV2 | null;
  inputArtifactDeliveryId: string | null;
  authorityBaseRef: BlobRefV2;
  payloadRef: BlobRefV2;
  initialLeaseEpoch: number;
  maxAutomaticRetries: number;
}

/**
 * Task 15 `structured_map_review_round_planned` carrier the map_finalize
 * clear-path envelope folds (spec §13.1 step 4: clear creates the candidate
 * AND plans the MapReviewRound atomically).
 */
export interface MapReviewRoundPlanCarrierV2 {
  mapReviewRoundId: string;
  mapCycleOrdinal: number;
  candidateId: string;
  candidateRef: BlobRefV2;
  contentRevisionManifestRef: BlobRefV2 | null;
  reviewPolicyDigest: string;
  coverageNodeCount: number;
  coverageRelationCount: number;
  assignmentCount: number;
  consumedOverrideRef: BlobRefV2 | null;
}

/**
 * Task 15 map-build publication carriers (deterministic rebuild; each carrier
 * is null when a publish branch does not use it). The build-service publication
 * handlers validate exactly the fields their branch needs and fail closed
 * (NotRebuildable) on any missing carrier.
 */
export interface MapBuildPublishCarriersV2 {
  mapBuildId: string | null;
  chunkId: string | null;
  chunkOrdinal: number | null;
  parentFrontierDigest: string | null;
  expectedChunkCount: number | null;
  expectedRootCount: number | null;
  candidateId: string | null;
  candidateDigest: string | null;
  baseMapId: string | null;
  manifestRef: BlobRefV2 | null;
  contributionManifestRef: BlobRefV2 | null;
  validationReceiptRef: BlobRefV2 | null;
  validatorAggregateRef: BlobRefV2 | null;
  /** §13.1 round planning (clear path only). */
  round: MapReviewRoundPlanCarrierV2 | null;
  /** §9.2 command-terminal pair (map_finalize completion only). */
  terminal: SystemCommandTerminalCarrierV2 | null;
  /** §9.2 successor WorkItem (finish proposal / rejected path). */
  successor: SuccessorWorkItemCarrierV2 | null;
  /**
   * F3 (adversarial review): the blocking path starts the successor MapBuild
   * revision in the SAME envelope — `structured_map_build_started` registers
   * the successor lineage so later successor chunks project cleanly.
   */
  successorBuildStart: {
    mapBuildId: string;
    revision: number;
    supersedesMapBuildId: string | null;
    mapBuildSpecRef: BlobRefV2;
    sourceValidationReceiptRef: BlobRefV2 | null;
  } | null;
}

/**
 * Task 16 one `structured_map_observation_recorded` carrier (design §12.6):
 * the deterministic layered whole-Map observation event. The observationRef is
 * the whole-observation ledger summary; childObservationRefs close the child
 * digest closure.
 */
export interface MapReviewObservationCarrierV2 {
  observationId: string;
  level: number;
  parentObservationId: string | null;
  observationRef: BlobRefV2;
  coveredTargetCount: number;
  childObservationRefs: readonly BlobRefV2[];
}

/** Task 20 persistent migration command carrier (initial or one batch). */
export interface MigrationProgressPublishCarrierV2 {
  stage: 'initial' | 'batch';
  migrationValidationPlanId: string | null;
  intentCoreRef: BlobRefV2 | null;
  planSpecRef: BlobRefV2;
  batchOrdinal: number | null;
  batchResultRootRef: BlobRefV2 | null;
  batchOutcome: MigrationBatchRouteOutcomeV2 | null;
  successor: SuccessorWorkItemCarrierV2;
  terminal: SystemCommandTerminalCarrierV2;
}

/**
 * Task 16 map-review publication carriers (deterministic rebuild; each carrier
 * is null when a publish branch does not use it). Covers the three Task 16
 * domain-publish branches: `review_assignment_commit` (the §12.4 freeze of one
 * completed assignment — batch AND whole observation), `map_review_round_completed`
 * (the coverage-core closure), and `map_review_settlement` (the §13.1
 * activation envelope: round settled + Map activated + baseline-unset manifest
 * + successor generation WorkItem + command/WorkItem terminals).
 */
export interface MapReviewPublishCarriersV2 {
  // --- review_assignment_commit (batch/whole freeze) ---
  assignmentId: string | null;
  mapReviewRoundId: string | null;
  workItemId: string | null;
  attemptId: string | null;
  reviewAssignmentId: string | null;
  source: 'batch' | 'whole_map_observation' | null;
  ledgerRef: BlobRefV2 | null;
  coverageTargetCount: number | null;
  findingCount: number | null;
  /** whole-session observation events (level closure; batch sessions leave null). */
  observations: readonly MapReviewObservationCarrierV2[] | null;
  verificationRecords: readonly ReviewerFindingVerificationCarrierV2[] | null;
  // --- map_review_round_completed ---
  coverageCoreRef: BlobRefV2 | null;
  // --- map_review_settlement (activation envelope) ---
  settlementCoreRef: BlobRefV2 | null;
  outcome: 'map_repair' | 'activate' | null;
  mapId: string | null;
  mapRevision: number | null;
  supersedesMapId: string | null;
  mapSnapshotRef: BlobRefV2 | null;
  mapReviewBundleRef: BlobRefV2 | null;
  mapSemanticDigest: string | null;
  contentRevisionManifestRef: BlobRefV2 | null;
  activationValidatorAggregateRef: BlobRefV2 | null;
  migrationSettlementCoreRef: BlobRefV2 | null;
  migrationActivationDecisionRef: BlobRefV2 | null;
  migrationProvisionalManifestRef: BlobRefV2 | null;
  migrationFinalizerAggregateRef: BlobRefV2 | null;
  /** System-validator Findings opened by the post-migration settlement. The
   * activation decision's combined FindingSet is their canonical closure. */
  migrationFindingOpenings: readonly ContentReviewFindingOpeningCarrierV2[] | null;
  // --- content_revision_committed (baseline_unset) ---
  taskContentRevision: number | null;
  manifestPhase: 'baseline_unset' | 'provisional' | 'finalized' | null;
  producerPlanSpecRef: BlobRefV2 | null;
  priorManifestRef: BlobRefV2 | null;
  // --- §9.2 successor WorkItem + command-terminal pair ---
  successor: SuccessorWorkItemCarrierV2 | null;
  terminal: SystemCommandTerminalCarrierV2 | null;
  /**
   * Task 19 (repair-round activation): the complete content re-review round
   * the map settlement creates AFTER a repaired Map activates (the mixed
   * finding stays on the Map track until activation; the later required
   * content re-review is counted by the content track — spec §13.3.1). The
   * round-planned event + the review WorkItems ride the SAME activation
   * envelope; `manifestPhase` stays null so NO content_revision_committed is
   * emitted (the manifest is unchanged by the map repair).
   */
  contentRound: ContentReviewRoundPlanCarrierV2 | null;
  reviewWorkItems: readonly SuccessorWorkItemCarrierV2[] | null;
  /** Mixed Finding route: activation creates a ContentRepairPlan, not a review round. */
  mixedContentRepair: RepairPublishCarriersV2 | null;
  /** Blocking findings closed by this system settlement before activation. */
  verifiedClosedFindingIds: readonly string[] | null;
  /** Task 20 initial/batch progress; post-migration uses the activation refs above. */
  migrationProgress: MigrationProgressPublishCarrierV2 | null;
}

/**
 * Task 17 one `structured_review_round_planned` carrier (design §12.2, spec
 * §13.2 step 4): the content-review round the generation finalizer plans on
 * clear. `contentCycleOrdinal` starts at 1 (spec §13.3.1); the round binds the
 * exact finalized manifest + active Map + an empty adoption root (Task 18
 * computes the presence-aware coverage core and review WorkItems from it).
 */
export interface ContentReviewRoundPlanCarrierV2 {
  reviewRoundId: string;
  contentCycleOrdinal: number;
  mapRef: BlobRefV2;
  mapSemanticDigest: string;
  contentRevisionManifestRef: BlobRefV2;
  reviewPolicyDigest: string;
  adoptionRootRef: BlobRefV2;
  coverageSlotCount: number;
  coverageRelationCount: number;
  assignmentCount: number;
  verificationFindingCount: number;
  consumedOverrideRef: BlobRefV2 | null;
}

/**
 * Task 17 content-plan publication carriers (deterministic rebuild; each
 * carrier is null when a publish branch does not use it). Covers the three
 * Task 17 domain-publish branches:
 * - `content_revision_commit` (one generation batch): the plan-started event
 *   (FIRST batch only) + `structured_generation_batch_committed` + the
 *   `structured_content_revision_committed` provisional-manifest event + the
 *   successor WorkItem (next batch or the `system_generation_finalize`
 *   WorkItem). No terminal pair — the agent session completes separately.
 * - `content_plan_finalize` (finalizer clear): the `structured_content_revision_committed`
 *   finalized event + `structured_generation_plan_completed` + the
 *   `structured_review_round_planned` content-review planning + the content
 *   review WorkItems + the §9.2 command-terminal pair.
 * - `generation_finalize` (finalizer blocking): the `structured_generation_plan_rejected`
 *   + the successor `structured_generation_plan_started` (revision 2) + the
 *   successor generation-batch WorkItem + the §9.2 command-terminal pair.
 */
export interface ContentPlanPublishCarriersV2 {
  // --- content_revision_commit (batch) ---
  generationPlanId: string | null;
  generationPlanRevision: number | null;
  supersedesGenerationPlanId: string | null;
  generationPlanSpecRef: BlobRefV2 | null;
  sourceValidationReceiptRef: BlobRefV2 | null;
  planStarted: boolean | null;
  batchOrdinal: number | null;
  contentRevisionCommitCoreRef: BlobRefV2 | null;
  validatorAggregateRef: BlobRefV2 | null;
  contentRevisionManifestRef: BlobRefV2 | null;
  taskContentRevision: number | null;
  manifestPhase: 'provisional' | 'finalized' | null;
  producerPlanSpecRef: BlobRefV2 | null;
  priorManifestRef: BlobRefV2 | null;
  /** §9.2 successor WorkItem (next batch or the finalizer). */
  successor: SuccessorWorkItemCarrierV2 | null;
  // --- content_plan_finalize (finalizer clear) ---
  finalizerWarningRootRef: BlobRefV2 | null;
  reviewRound: ContentReviewRoundPlanCarrierV2 | null;
  reviewWorkItems: readonly SuccessorWorkItemCarrierV2[] | null;
  // --- generation_finalize (finalizer blocking) ---
  validationReceiptRef: BlobRefV2 | null;
  /** The successor plan's revision (superseded plan revision + 1; the rebuild
   * derives the successor plan id + plan-started revision from it). */
  successorPlanRevision: number | null;
  successorPlanRef: BlobRefV2 | null;
  // --- §9.2 command-terminal pair (finalizer envelopes only) ---
  terminal: SystemCommandTerminalCarrierV2 | null;
}

/** One layered whole-tree observation event carrier (spec §13.2 step 7, design
 * §12.6): the event-level convention is ROOT-FIRST (level 1 = root, no parent;
 * children at level 2, …). `observationRef` closes the observation summary; the
 * whole-tree session publishes these events, never a batch assignment event. */
export interface ContentReviewObservationCarrierV2 {
  observationId: string;
  level: number;
  parentObservationId: string | null;
  observationRef: BlobRefV2;
  coveredTargetCount: number;
  childObservationRefs: readonly BlobRefV2[];
}

/** The `structured_finding_opened` carrier of one materialized finding draft. */
export interface ContentReviewFindingOpeningCarrierV2 {
  findingId: string;
  findingRef: BlobRefV2;
  reviewContext: { kind: 'map' | 'content'; roundId: string };
  primaryLocation: { kind: 'slot' | 'relation' | 'map_node' | 'map'; id: string };
  defectClass: 'content' | 'map' | 'mixed';
  severity: 'blocking' | 'advisory';
  source: 'reviewer' | 'system_validator';
  openedBy:
    | { kind: 'reviewer'; reviewerAttemptId: string }
    | { kind: 'system_validator'; validatorExecutionId: string };
}

/** One reviewer verification fact frozen with its assignment ledger. The
 * event is authoritative state; the ledger ref alone is only custody. */
export interface ReviewerFindingVerificationCarrierV2 {
  recordId: string;
  recordRef: BlobRefV2;
  findingId: string;
  reviewContext: { kind: 'map' | 'content'; roundId: string };
  assignmentId: string;
  repairStage: 'map' | 'content';
  verdict: 'resolved' | 'still_present';
}

/**
 * Task 18 content-review publication carriers (deterministic rebuild; each
 * carrier is null when a publish branch does not use it). Covers the four
 * Task 18 domain-publish branches:
 * - `content_review_assignment_commit` (the §12.4 freeze of one completed
 *   content review assignment — batch AND whole-tree observation);
 * - `content_review_round_completed` (the FINAL coverage-core closure);
 * - `content_review_settlement` (the §13.2 settlement envelope: round settled
 *   with outcome content_repair | seal + the System Seal WorkItem on clear or
 *   the deterministic content-repair successor on blocking + the §9.2
 *   command-terminal pair);
 * - `content_review_round_planned` (the §13.3.1 cycle-budget boundary that
 *   atomically creates a NEW complete content round; consumed by the initial
 *   finalizer clear AND the content-repair finalizer).
 */
export interface ContentReviewPublishCarriersV2 {
  // --- content_review_assignment_commit (batch/whole freeze) ---
  assignmentId: string | null;
  reviewRoundId: string | null;
  workItemId: string | null;
  attemptId: string | null;
  reviewAssignmentId: string | null;
  source: 'batch' | 'whole_tree_observation' | null;
  ledgerRef: BlobRefV2 | null;
  coverageTargetCount: number | null;
  findingCount: number | null;
  /** whole-session observation events (root-first level closure; batch sessions leave null). */
  observations: readonly ContentReviewObservationCarrierV2[] | null;
  /** `structured_finding_opened` carriers for every materialized finding draft
   * of the freeze (design §11.8: the opening payload is an append-only fact). */
  findingOpenings: readonly ContentReviewFindingOpeningCarrierV2[] | null;
  verificationRecords: readonly ReviewerFindingVerificationCarrierV2[] | null;
  // --- content_review_round_completed ---
  coverageCoreRef: BlobRefV2 | null;
  // --- content_review_round_planned (a NEW complete round, cycle budget) ---
  roundPlanned: ContentReviewRoundPlanCarrierV2 | null;
  reviewWorkItems: readonly SuccessorWorkItemCarrierV2[] | null;
  // --- content_review_settlement (settlement envelope) ---
  settlementCoreRef: BlobRefV2 | null;
  outcome: 'content_repair' | 'seal' | null;
  reviewBundleRef: BlobRefV2 | null;
  reviewWarningCustodyRootRef: BlobRefV2 | null;
  mapRef: BlobRefV2 | null;
  contentRevisionManifestRef: BlobRefV2 | null;
  reviewSettlementValidatorAggregateRef: BlobRefV2 | null;
  sealWorkItemId: string | null;
  /** the System Seal WorkItem's authority base set (kind system_seal). */
  sealAuthorityBaseRef: BlobRefV2 | null;
  /** Blocking findings closed by this system settlement before Seal creation. */
  verifiedClosedFindingIds: readonly string[] | null;
  // --- §9.2 successor WorkItem + command-terminal pair ---
  successor: SuccessorWorkItemCarrierV2 | null;
  terminal: SystemCommandTerminalCarrierV2 | null;
}

/**
 * Task 19 repair publication carriers (deterministic rebuild; each carrier is
 * null when a publish branch does not use it). Covers the repair-service
 * domain-publish branches:
 * - `repair_plan_creation` (the settlement-blocking envelope): the initial
 *   `structured_map_repair_plan_started` / `structured_content_repair_plan_started`
 *   + the first repair-batch WorkItem + `structured_repair_grant_issued` + the
 *   §9.2 command-terminal pair (the settlement command COMPLETES with the plan
 *   created — the Task 15/17 blocking-envelope pattern);
 * - `repair_batch_commit` (one serial batch): `structured_*_repair_batch_committed`
 *   + `structured_repair_committed` + the successor WorkItem (next batch OR the
 *   `system_repair_finalize` WorkItem) + its `structured_repair_grant_issued`;
 * - `repair_finalize` (the System finalizer): clear-map publishes the repair
 *   build chain (`structured_map_build_started` + `structured_map_build_finish_
 *   proposed` + `structured_map_build_finalized` + `structured_map_candidate_
 *   committed`) + the complete MapReviewRound (`structured_map_review_round_
 *   planned` + review WorkItems) + `structured_finding_addressed` + the
 *   terminal pair; clear-content publishes the repaired FINALIZED manifest
 *   (`structured_content_revision_committed`) + the complete ContentReviewRound
 *   (`structured_review_round_planned` + review WorkItems) + finding addressed +
 *   terminal pair; blocking publishes `structured_*_repair_plan_rejected` +
 *   ONE `structured_repair_plan_revision_started` (validation_correction) +
 *   the correction-batch WorkItem/Grant + the terminal pair; infrastructure
 *   failure retries (no successor);
 * - `repair_scope_request` (the Task 13 `request_scope_expansion` tool seam):
 *   `structured_repair_scope_requested`;
 * - `repair_scope_approval`: `structured_repair_scope_expansion_approved_v2`
 *   (self-registers the successor revision in the projection) + the successor
 *   repair WorkItem/Grant + the optional
 *   `structured_round_budget_override_transferred_v2` (the §13.3.1 override
 *   follows the authorized plan within the same lineage);
 * - `repair_scope_rejection`: `structured_repair_scope_expansion_rejected_v2`.
 */
export interface RepairPublishCarriersV2 {
  // --- plan started (initial creation) / revision started (successors) ---
  track: 'map' | 'content' | null;
  repairPlanId: string | null;
  planRevisionId: string | null;
  repairPlanSpecRef: BlobRefV2 | null;
  sourceValidationReceiptRef: BlobRefV2 | null;
  /** The superseded revision of a `structured_repair_plan_revision_started`
   * successor (null for the initial plan-started event). */
  supersedesPlanRevisionId: string | null;
  /** The successor plan revision's spec ref (approval / correction successors). */
  successorPlanSpecRef: BlobRefV2 | null;
  /** The successor plan revision id (the approved event registers it). */
  successorPlanRevisionId: string | null;
  successorReason: 'scope_expansion' | 'validation_correction' | 'recovery' | null;
  // --- batch commit ---
  batchOrdinal: number | null;
  stagingRootRef: BlobRefV2 | null;
  workItemId: string | null;
  attemptId: string | null;
  // --- plan rejected (blocking finalizer) ---
  validatorAggregateRef: BlobRefV2 | null;
  validationReceiptRef: BlobRefV2 | null;
  // --- scope request / approval / rejection ---
  requestId: string | null;
  /** Authenticated operator identity for a persisted scope decision. */
  operatorId: string | null;
  reason: string | null;
  findingIds: readonly string[] | null;
  requestedNodeIds: readonly string[] | null;
  requestedRelationIds: readonly string[] | null;
  requestedSlotIds: readonly string[] | null;
  // --- grant issued (each repair WorkItem carries exactly one) ---
  grantSpecId: string | null;
  grantKind: 'map_repair_batch' | 'content_repair_batch' | null;
  // --- finding addressed (the finalizer envelope, per plan finding) ---
  addressedFindingIds: readonly string[] | null;
  // --- clear content finalize: the repaired finalized manifest ---
  contentRevisionManifestRef: BlobRefV2 | null;
  taskContentRevision: number | null;
  manifestPhase: 'provisional' | 'finalized' | null;
  priorManifestRef: BlobRefV2 | null;
  // --- clear map finalize: the repair build chain (reuses the Task 15 build
  // event chain so the projector's candidate rules hold: one candidate per
  // finalized build, proposal-before-finalize, active head) ---
  repairBuildStart: {
    mapBuildId: string;
    revision: number;
    mapBuildSpecRef: BlobRefV2;
    supersedesMapBuildId: string | null;
    sourceValidationReceiptRef: BlobRefV2 | null;
  } | null;
  repairBuildFinish: { mapBuildId: string; expectedChunkCount: number; expectedFrontierDigest: string; expectedRootCount: number } | null;
  /** `structured_map_build_finalized.manifestRef` — the repair contribution
   * manifest (the repair build has no chunk manifest; the contribution
   * manifest IS the complete staged-map manifest; documented decision). */
  mapBuildManifestRef: BlobRefV2 | null;
  contributionManifestRef: BlobRefV2 | null;
  candidateId: string | null;
  candidateDigest: string | null;
  candidateRef: BlobRefV2 | null;
  baseMapId: string | null;
  // --- complete re-review rounds (the §13.3.1 cycle boundaries) ---
  mapRound: MapReviewRoundPlanCarrierV2 | null;
  contentRound: ContentReviewRoundPlanCarrierV2 | null;
  reviewWorkItems: readonly SuccessorWorkItemCarrierV2[] | null;
  /** §13.3.1 override transfer inside the same lineage (successor-creation
   * envelopes only, when an available override is bound to the superseded
   * plan). */
  overrideTransfer: {
    overrideRef: BlobRefV2;
    fromRepairPlanRef: BlobRefV2;
    toRepairPlanRef: BlobRefV2;
    transferOperationId: string;
  } | null;
  /** I-4 (adversarial review): the scope-expansion approval atomically
   * supersedes the OLD WorkItem of the superseded plan revision
   * (`structured_work_item_superseded`, reason new_authority_base) so it can
   * never be claimed again — without it the stale WorkItem's retries park the
   * task into retryable_failure and the successor is starved. Null when the
   * superseded revision has no claimable WorkItem (the envelope still creates
   * the successor). R2-2 (re-review round 2): when the old WorkItem is LEASED
   * mid-session at approval time (the normal operator flow — the request tool
   * is only callable from a leased session), `attemptAbandonment` carries the
   * active cycle and the envelope ends it atomically FIRST
   * (structured_agent_attempt_abandoned_v2 + structured_work_item_lease_
   * reclaimed — the projector's supersede rule demands the cycle ended), then
   * supersedes at the post-reclaim lease epoch (leaseEpoch = current + 1). */
  supersededWorkItem: {
    workItemId: string;
    /** the epoch the supersede event carries (post-reclaim for a mid-session
     * lease: current + 1; the current epoch otherwise). */
    leaseEpoch: number;
    reason: 'new_authority_base' | 'human_disposition';
    authorityBaseRef: BlobRefV2;
    attemptAbandonment: {
      attemptId: string;
      logicalAssignmentId: string;
      reviewAssignmentId: string | null;
      sessionKind: StructuredSessionKindV2;
      /** the CURRENT (pre-reclaim) lease epoch — the abandon + reclaim ride it. */
      leaseEpoch: number;
      authorityBaseRef: BlobRefV2;
    } | null;
  } | null;
  // --- §9.2 successor WorkItem + command-terminal pair ---
  successor: SuccessorWorkItemCarrierV2 | null;
  terminal: SystemCommandTerminalCarrierV2 | null;
}

/**
 * §8/§7.1 exact closed union of canonical publication operation payloads.
 * Every branch carries exact keys, authority/event-builder inputs and child
 * refs; pins never persist executable callbacks or raw Agent text.
 */
export type PublicationOperationPayloadV2 =
  | {
      family: 'domain_publish';
      operationId: string;
      taskId: string;
      publishKind:
        | 'map_build_commit'
        | 'map_candidate_commit'
        | 'content_revision_commit'
        | 'content_plan_finalize'
        | 'review_assignment_commit'
        | 'map_review_settlement'
        | 'map_review_round_completed'
        | 'content_review_settlement'
        | 'content_review_round_planned'
        | 'content_review_round_completed'
        | 'content_review_assignment_commit'
        | 'map_activation'
        | 'generation_finalize'
        | 'repair_finalize'
        | 'migration_settlement'
        | 'seal_publish'
        | 'map_build_finish'
        | 'map_finalize_commit'
        | 'map_finalize_rejected'
        | 'repair_plan_creation'
        | 'repair_batch_commit'
        | 'repair_scope_request'
        | 'repair_scope_approval'
        | 'repair_scope_rejection';
      blobRefs: readonly BlobRefV2[];
      expectedResultIdentity: string;
      /** Task 15 map-build carriers (null for every non-map-build publish kind). */
      mapBuild: MapBuildPublishCarriersV2 | null;
      /** Task 16 map-review carriers (null for every non-map-review publish kind). */
      mapReview: MapReviewPublishCarriersV2 | null;
      /** Task 17 content-plan carriers (null for every non-content-plan publish kind). */
      contentPlan: ContentPlanPublishCarriersV2 | null;
      /** Task 18 content-review carriers (null for every non-content-review publish kind). */
      contentReview: ContentReviewPublishCarriersV2 | null;
      /** Task 19 repair carriers (null for every non-repair publish kind). */
      repair: RepairPublishCarriersV2 | null;
    }
  | {
      family: 'lease_or_retry';
      operationId: string;
      taskId: string;
      workItemId: string;
      leaseEpoch: number;
      eventBuilder: WorkItemMutationEventBuilderV2;
      /** The authoritative base the mutation commits against (exact ref). */
      authorityBaseRef: BlobRefV2;
      // --- work_item_created carriers (event fields, §17.2 discriminants) ---
      kind: WorkItemKindV2 | null;
      roleBinding: string | null;
      agentExecutionKind: 'structured_session' | 'generic_turn' | null;
      sessionKind: StructuredSessionKindV2 | null;
      roundId: string | null;
      logicalAssignmentId: string | null;
      reviewAssignmentId: string | null;
      grantSpecRef: BlobRefV2 | null;
      inputArtifactDeliveryId: string | null;
      payloadRef: BlobRefV2 | null;
      initialLeaseEpoch: number | null;
      maxAutomaticRetries: number | null;
      // --- work_item_leased (runtime lease facts — the Task 3 gap) ---
      leaseOwner: string | null;
      leaseExpiresAt: string | null;
      expectedLastSequence: number | null;
      // --- lease / reclaim / failure execution identity ---
      attemptFamily: AttemptExecutionKindV2 | null;
      attemptId: string | null;
      commandId: string | null;
      agentId: string | null;
      commandKind: SystemCommandKindV2 | null;
      dispatchRef: BlobRefV2 | null;
      grantInstanceRef: BlobRefV2 | null;
      // --- work_item_lease_reclaimed (the other Task 3 gap) ---
      reason: WorkItemReclaimReasonV2 | null;
      // --- work_item_retryable_failed / work_item_parked ---
      failureCode: string | null;
      failureDigest: string | null;
      /** Task 11: the RUNNING_WITHOUT_WORK failure's recovery payload (§10.4). */
      failureRecoveryPayloadRef: BlobRefV2 | null;
      /** Task 11: work_item_terminal_failed also emits structured_task_failed_v2. */
      taskFailure: boolean | null;
      retryOrdinal: number | null;
      retryNotBefore: string | null;
      validatorAggregateRef: BlobRefV2 | null;
      budgetPolicyDigest: string | null;
      /**
       * Task 12 (constraint A round 3): the SUCCESS-completion result carrier
       * of the `work_item_completed` builder. For workitem kinds whose §17.5
       * envelope folds a domain result/successor (every structured agent
       * session and every system command), this MUST be non-empty — the
       * all-or-none gate closes the "completed WorkItem without its result"
       * half-state (§9.2). The refs are pinned/verified in the SAME batch;
       * later domain-completion builders emit the events that reference them.
       * Empty for un-gated kinds (the generic submitter, whose result is the
       * delivery-bound submission).
       */
      resultRefs: BlobRefV2[];
    }
  | {
      /**
       * Task 11 extension (constraint A round 2): the lifecycle family now
       * also carries (a) the v2 START envelope carriers (`task_started` +
       * `structured_map_build_started` + first `structured_work_item_created`
       * in ONE batch — §17.2 start) and (b) the composed STOP envelope
       * carriers (reclaim of the leased workitem + `task_stopped` + overlay in
       * ONE batch — §17.3 user stop / operator interrupt). Any carrier that a
       * mutation does not need stays null; the exact-key parser enforces the
       * per-`kind` field matrix.
       */
      family: 'lifecycle';
      operationId: string;
      taskId: string;
      kind: 'stop' | 'resume' | 'manual_retry' | 'run_migration_batch' | 'start';
      suspensionId: string | null;
      workItemId: string | null;
      /** Task 10 extension: stop reason (null keeps the Task 8 user_stop default). */
      reason: WorkItemSuspensionReasonV2 | null;
      /** Task 10 extension: manual_retry resume fields (new epoch etc.). */
      leaseEpoch: number | null;
      expectedLastSequence: number | null;
      authorityBaseRef: BlobRefV2 | null;
      // --- composed-stop reclaim carriers (lease_or_retry lease/reclaim shape) ---
      attemptFamily: AttemptExecutionKindV2 | null;
      attemptId: string | null;
      commandId: string | null;
      agentId: string | null;
      commandKind: SystemCommandKindV2 | null;
      logicalAssignmentId: string | null;
      reviewAssignmentId: string | null;
      sessionKind: StructuredSessionKindV2 | null;
      inputArtifactDeliveryId: string | null;
      // --- start envelope carriers (work_item_created + map build) ---
      workItemKind: WorkItemKindV2 | null;
      roleBinding: string | null;
      agentExecutionKind: 'structured_session' | 'generic_turn' | null;
      roundId: string | null;
      grantSpecRef: BlobRefV2 | null;
      payloadRef: BlobRefV2 | null;
      initialLeaseEpoch: number | null;
      maxAutomaticRetries: number | null;
      mapBuildId: string | null;
      supersedesMapBuildId: string | null;
      sourceValidationReceiptRef: BlobRefV2 | null;
    }
  | {
      /**
       * Task 11 extension (constraint A round 2): the human-question family now
       * covers BOTH the open (structured_human_question_opened_v2) and the
       * answer (structured_human_answer_delivered_v2) flow atomically. The
       * answer branch carries the delivery successor identities the Task 7
       * union lacked (deliveryId/originalWorkItemId/replacementWorkItemId/
       * logicalAssignmentId) so `human_answer` is byte-rebuildable; the open
       * branch carries the attempt-terminal + park carriers the §17.3 open
       * envelope needs. `mode` discriminates; every other field is keyed
       * exactly per mode.
       */
      family: 'question';
      operationId: string;
      taskId: string;
      questionId: string;
      questionVersion: string;
      mode: 'open' | 'answer';
      /** The opened question's canonical digest (mode open). */
      questionDigest: string | null;
      /** Text of the public display question (mode open; bounded, public). */
      text: string | null;
      /** Public display answer text (mode answer; bounded, public). */
      answerText: string | null;
      /** Commit id of the batch that opened the question (token binding). */
      openedCommitId: string | null;
      /** Tail sequence at commit time (nothing should be inferred from it). */
      expectedLastSequence: number | null;
      /** Original (question-bound) WorkItem identity — both modes. */
      originalWorkItemId: string | null;
      /** Answer successor identity (mode answer only). */
      replacementWorkItemId: string | null;
      deliveryId: string | null;
      attemptId: string | null;
      leaseEpoch: number | null;
      logicalAssignmentId: string | null;
      reviewAssignmentId: string | null;
      sessionKind: StructuredSessionKindV2 | null;
      /** Leased agent identity (display-node owner; both modes). */
      agentId: string | null;
      answerDigest: string | null;
      authorityBaseRef: BlobRefV2;
      /** Create carriers of the answer replacement workitem (mode answer). */
      kind: WorkItemKindV2 | null;
      roleBinding: string | null;
      agentExecutionKind: 'structured_session' | 'generic_turn' | null;
      roundId: string | null;
      grantSpecRef: BlobRefV2 | null;
      inputArtifactDeliveryId: string | null;
      payloadRef: BlobRefV2 | null;
      initialLeaseEpoch: number | null;
      maxAutomaticRetries: number | null;
      /**
       * The terminal-failure identity of the attempt the question OPEN closes
       * (mode open): the attempt's own terminal event needs the full carrier
       * set to be rebuildable.
       */
      failureCode: string | null;
      failureDigest: string | null;
    }
  | {
      /**
       * Task 11 extension (constraint A round 2): the recovery family now
       * carries the operator-owned reopen facts (operatorId/reason/track) and
       * the exact tail, so every §10.3.1 recipe is byte-rebuildable. The
       * frozen server-fixed principal `task_owner` supplies operatorId; the
       * body can never name an operator (spec §10.3.1).
       */
      family: 'recovery';
      operationId: string;
      taskId: string;
      expectedLastSequence: number;
      operatorId: string;
      reason: string;
      recipeKey: 'retry_system_command' | 'restart_map_review_cycle' | 'restart_content_review_cycle' | 'rebuild_missing_work';
      track: 'map' | 'content' | null;
      failureRecoveryPayloadRef: BlobRefV2;
      overrideRef: BlobRefV2 | null;
      /** The replacement WorkItem created in the SAME batch (§10.3.1). */
      replacementWorkItemId: string | null;
      replacementKind: WorkItemKindV2 | null;
      replacementRoleBinding: string | null;
      replacementAgentExecutionKind: 'structured_session' | 'generic_turn' | null;
      replacementSessionKind: StructuredSessionKindV2 | null;
      replacementRoundId: string | null;
      replacementLogicalAssignmentId: string | null;
      replacementReviewAssignmentId: string | null;
      replacementGrantSpecRef: BlobRefV2 | null;
      replacementInputArtifactDeliveryId: string | null;
      replacementPayloadRef: BlobRefV2 | null;
      replacementAuthorityBaseRef: BlobRefV2 | null;
      replacementLeaseEpoch: number | null;
      replacementMaxAutomaticRetries: number | null;
    }
  | {
      family: 'delete';
      operationId: string;
      taskId: string;
      deleteEpoch: number;
    }
  | {
      family: 'artifact_publish';
      operationId: string;
      taskId: string;
      artifactRef: BlobRefV2;
      sealRecordRef: BlobRefV2;
      deliveryRef: BlobRefV2;
      expectedArtifactVersion: number;
    };

/* ------------------------------------------------------------------ */
/* Other registered objects (judgment-derived strict bodies, §8 prose) */
/* ------------------------------------------------------------------ */

/** §13.5/§19.1 canonical content bytes envelope (media text body). */
export interface ContentValueV2 {
  slotId: string;
  contentSchemaDigest: string;
  taskContentRevision: number;
  mediaType: 'text/markdown' | 'text/plain';
  text: string;
  selfDigest: string;
}

/** §4.3 snapshot checkpoint (accelerator only — never a GC root). */
export interface ProjectionCheckpointV2 {
  checkpointId: string;
  taskId: string;
  throughSequence: number;
  priorCheckpointDigest: string;
  projectionSchemaVersion: string;
  baseRefs: readonly BlobRefV2[];
  checkpointDigest: string;
}
