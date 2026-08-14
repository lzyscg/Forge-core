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
      action: 'unset';
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

/** §11.11 closed three-branch WriteGrantSpec union. */
export type WriteGrantSpecV2 =
  | InitialStructureGrantSpecV2
  | InitialGenerationGrantSpecV2
  | RepairBatchGrantSpecV2;

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
  entries: readonly { buildKey: string; kind: 'node' | 'relation'; officialId: string | null; declaredByChunkOrdinal: number }[];
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
  receiptKind: 'map_build' | 'generation' | 'map_repair' | 'content_repair' | 'map_activation' | 'map_review_settlement' | 'review_settlement' | 'seal_input' | 'seal_output';
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
  | 'work_item_parked';

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
        | 'content_review_settlement'
        | 'map_activation'
        | 'generation_finalize'
        | 'repair_finalize'
        | 'migration_settlement'
        | 'seal_publish';
      blobRefs: readonly BlobRefV2[];
      expectedResultIdentity: string;
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
      retryOrdinal: number | null;
      retryNotBefore: string | null;
      validatorAggregateRef: BlobRefV2 | null;
      budgetPolicyDigest: string | null;
    }
  | {
      family: 'lifecycle';
      operationId: string;
      taskId: string;
      kind: 'stop' | 'resume' | 'manual_retry' | 'run_migration_batch';
      suspensionId: string | null;
      workItemId: string | null;
      /** Task 10 extension: stop reason (null keeps the Task 8 user_stop default). */
      reason: WorkItemSuspensionReasonV2 | null;
      /** Task 10 extension: manual_retry resume fields (new epoch etc.). */
      leaseEpoch: number | null;
      expectedLastSequence: number | null;
      authorityBaseRef: BlobRefV2 | null;
    }
  | {
      family: 'question';
      operationId: string;
      taskId: string;
      questionId: string;
      questionVersion: string;
      answerDigest: string;
      authorityBaseRef: BlobRefV2;
    }
  | {
      family: 'recovery';
      operationId: string;
      taskId: string;
      recipeKey: 'retry_system_command' | 'restart_map_review_cycle' | 'restart_content_review_cycle' | 'rebuild_missing_work';
      failureRecoveryPayloadRef: BlobRefV2;
      overrideRef: BlobRefV2 | null;
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