/**
 * Task 17 content-plan-service (spec §13.2/§7.3/§12.2/§13.3.1, design
 * §11.5/§12.2/§12.3/§14/§17.5): deterministic GenerationPlan consumption,
 * scoped generation batches, SlotContentVersionV2/ContentRevisionManifestV2
 * publication, validator phase isolation (`content_commit/batch_commit` for
 * every partial batch, `content_commit/plan_finalize` for the finalizer ONLY),
 * and the blocking-successor GenerationPlan.
 *
 * NORMATIVE CORE:
 * - ONE writable generation batch at a time: a batch commit is legal only when
 *   its ordinal is the NEXT uncommitted ordinal of the CURRENT active plan
 *   revision, its grant `writeSlotIds` equal the plan's batch slot set, its
 *   expected manifest CAS the current manifest, and its active Map ref the
 *   current Map snapshot — any stale Map/manifest grant, out-of-scope write or
 *   out-of-order batch is rejected with ZERO writes;
 * - each clear batch freezes `ContentRevisionCommitCoreV2` (no validator
 *   output) and runs ONLY the `content_commit/batch_commit` registrations over
 *   the batch's content targets; on clear it publishes a PROVISIONAL manifest
 *   revision (finalizer refs empty) that stores the batch core/aggregate/
 *   warning provenance per replaced set version, and creates the NEXT batch
 *   WorkItem OR the `system_generation_finalize` WorkItem;
 * - the LAST batch creates the `system_generation_finalize` WorkItem. The
 *   finalizer binds the complete provisional manifest in `ContentPlanFinalizeCoreV2`
 *   and runs ONLY `content_commit/plan_finalize` (the "global" required-slot
 *   coverage validator). A global validator must NEVER reject the first legal
 *   partial batch — phase separation is the isolation guarantee;
 * - finalizer clear publishes the FINALIZED manifest (finalizer aggregate/
 *   warning refs non-empty) + `structured_generation_plan_completed` + plans
 *   Content Review (`structured_review_round_planned`, content cycle 1) + the
 *   content review WorkItems (Task 18 consumes them). NO review exists before
 *   finalization;
 * - finalizer blocking_invalid publishes a deterministic successor
 *   GenerationPlan (revision 2, supersedes the rejected plan) whose
 *   `orderedBatchSlotIds` are the DETERMINISTIC correction batches over the
 *   blocked slots; the untouched slots' versions stay current via
 *   `importedContentManifestRef` = the complete provisional manifest. Advisory
 *   receipts never create a successor. Infrastructure failures return
 *   `retryable_failure` — the SystemCommand is retried.
 *
 * PUBLICATION MODEL: the three Task 17 branches (`content_revision_commit`,
 * `content_plan_finalize`, `generation_finalize`) are registered publication
 * handlers on the module allowlist AND on injected registries via
 * `registerContentPlanPublicationHandlers` — a crashed pin replays the envelope
 * byte-identically.
 *
 * V1 byte-for-byte: this is a NEW module; v1 surfaces are untouched.
 */
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { AuthoritativeAppendFacadeV2 } from '../../storage/authoritative-append-facade';
import type { PublicationIntentRegistry, PublicationEventEnvelopeV2, PublicationIntentResolvedRef } from '../../storage/authoritative-publication-intent-registry';
import { NotRebuildableError, PUBLICATION_INTENT_REGISTRY_V2 } from '../../storage/authoritative-publication-intent-registry';
import { parsePublicationOperationPayload } from '../../authoritative-review/object-schema-parsers-3';
import type { SystemCommandHandler } from './system-command-registry';
import { ValidatorEngine } from './validator-engine';
import type { TriggerExecutionResult, ValidatorBlobStore, ValidatorSlotType } from './validator-engine';
import type {
  AuthoritativeReviewProfile,
  ContentPlanFinalizeCoreV2,
  ContentPlanPublishCarriersV2,
  ContentRevisionCommitCoreV2,
  ContentRevisionManifestV2,
  ContentReviewRoundPlanCarrierV2,
  ContentValueV2,
  GenerationPlanSpecV2,
  PublicationOperationPayloadV2,
  ReviewPolicyParameters,
  SlotContentVersionV2,
  SuccessorWorkItemCarrierV2,
  SystemCommandTerminalCarrierV2,
  ValidationWarningCustodyRootV2,
} from '../../authoritative-review/authority-types';
import { grantSpecWriteSlotIds } from '../../authoritative-review/authority-types';
import { refOfBlob } from '../../authoritative-review/object-registry';
import { computeProvisionalOrFinalizedManifest } from '../../authoritative-review/content-domain';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { AuthoritativeReviewProjectionV2 } from '../../storage/authoritative-review-state';
import type { AuthoritativeReviewProfileSnapshotV1Body } from '../../structured-slots/authoritative-review-profile';
import { attemptContinuationOperationId } from './attempt-coordinator';
import { buildAuthorityBaseSet, sameRef } from './authority-base';
import {
  buildReviewObservationGrantSpec,
  initialGenerationWorkItemId,
  reviewAssignmentIdOf,
  reviewBatchWorkItemId,
  reviewWholeAssignmentId,
  reviewWholeWorkItemId,
} from './review-coordinator';
import type { GrantService } from './grant-service';
import type { WorkItemCoordinatorV2 } from './work-item-coordinator';
import { validateSuccessorCarrier } from './work-item-coordinator';

/* ------------------------------------------------------------------ */
/* Deterministic ids (§11.11 / Task 16 conventions)                    */
/* ------------------------------------------------------------------ */

/** Deterministic generation-batch WorkItem id for a plan's batch ordinal. */
export function generationBatchWorkItemId(taskId: string, generationPlanId: string, batchOrdinal: number): string {
  return `wi-genb-${canonicalJsonSha256({ taskId, generationPlanId, batchOrdinal }).slice(0, 24)}`;
}

/** Deterministic `system_generation_finalize` WorkItem id. */
export function generationFinalizeWorkItemId(taskId: string, generationPlanId: string): string {
  return `wi-genfin-${canonicalJsonSha256({ taskId, generationPlanId }).slice(0, 24)}`;
}

/** Deterministic successor GenerationPlan id (revision n+1 of the lineage). */
export function successorGenerationPlanId(supersededGenerationPlanId: string, revision: number): string {
  return `gp-${canonicalJsonSha256({ supersededGenerationPlanId, revision, label: 'successor' }).slice(0, 24)}`;
}

/** Deterministic content-review round id (content cycle ordinal n). */
export function contentReviewRoundId(taskId: string, contentCycleOrdinal: number, finalizedManifestRef: BlobRefV2): string {
  return `cr-${canonicalJsonSha256({ taskId, contentCycleOrdinal, manifestRef: finalizedManifestRef.digest }).slice(0, 24)}`;
}

/** Deterministic batch-commit publication operation id (replay-safe). */
export function contentBatchCommitOperationId(taskId: string, workItemId: string, batchOrdinal: number): string {
  return `cb-${canonicalJsonSha256({ taskId, workItemId, batchOrdinal }).slice(0, 32)}`;
}

/** Deterministic finalizer publication operation id (= the coordinator's
 * continuation op so the §9.2 completion envelope REPLAYS, not double-commits). */
export function contentFinalizeOperationId(taskId: string, workItemId: string, commandId: string): string {
  return attemptContinuationOperationId(taskId, workItemId, commandId, 'complete');
}

/* ------------------------------------------------------------------ */
/* Pure builders (design §11.5/§12.3/§13.2)                            */
/* ------------------------------------------------------------------ */

/** Deterministic complete slot partition: sort by documentOrder then slotId,
 * chunk by `contentBatchTargetSlots` (default 24; the profile soft ceiling 64
 * never expands a batch — §12.3 "模板默认软上限"). */
export function partitionGenerationBatches(
  slots: readonly { slotId: string; documentOrder: number }[],
  batchSize: number,
): string[][] {
  const size = Math.max(1, Math.floor(batchSize));
  const ordered = [...slots].sort(
    (a, b) => a.documentOrder - b.documentOrder || (a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0),
  );
  const batches: string[][] = [];
  for (let i = 0; i < ordered.length; i += size) {
    batches.push(ordered.slice(i, i + size).map((s) => s.slotId));
  }
  return batches;
}

/** The deterministic correction batches of a blocking successor: the blocked
 * slots sorted by the plan's document order, chunked by contentBatchTargetSlots. */
export function partitionCorrectionBatches(
  correctionSlots: readonly { slotId: string; documentOrder: number }[],
  batchSize: number,
): string[][] {
  return partitionGenerationBatches(correctionSlots, batchSize);
}

/** §11.5 canonical content value (blobRef target of a set version). */
export function buildContentValue(input: {
  slotId: string;
  contentSchemaDigest: string;
  taskContentRevision: number;
  mediaType: 'text/markdown' | 'text/plain';
  text: string;
}): ContentValueV2 {
  const body = {
    slotId: input.slotId,
    contentSchemaDigest: input.contentSchemaDigest,
    taskContentRevision: input.taskContentRevision,
    mediaType: input.mediaType,
    text: input.text,
  };
  return { ...body, selfDigest: canonicalJsonSha256(body) };
}

/** §11.5 set content version with generated provenance (batch core/aggregate/
 * warning refs per replaced set version). */
export function buildContentSetVersion(input: {
  slotId: string;
  slotRevision: number;
  taskContentRevision: number;
  mapRef: BlobRefV2;
  mapSemanticDigest: string;
  contentSchemaDigest: string;
  blobRef: BlobRefV2;
  producer: { kind: 'generation_batch'; planRevisionId: string; batchOrdinal: number; attemptId: string };
  contentRevisionCommitCoreRef: BlobRefV2;
  contentCommitValidatorAggregateRef: BlobRefV2;
  contentCommitWarningRootRef: BlobRefV2;
  committedByAttemptId: string;
}): SlotContentVersionV2 {
  return {
    state: 'set',
    slotId: input.slotId,
    slotRevision: input.slotRevision,
    contentDigest: input.blobRef.digest,
    taskContentRevision: input.taskContentRevision,
    mapRef: input.mapRef,
    mapSemanticDigest: input.mapSemanticDigest,
    contentSchemaDigest: input.contentSchemaDigest,
    blobRef: input.blobRef,
    provenance: {
      kind: 'generated',
      producer: input.producer,
      contentRevisionCommitCoreRef: input.contentRevisionCommitCoreRef,
      contentCommitValidatorAggregateRef: input.contentCommitValidatorAggregateRef,
      contentCommitWarningRootRef: input.contentCommitWarningRootRef,
      committedByAttemptId: input.committedByAttemptId,
    },
  };
}

/** §11.5 ContentRevisionCommitCore — frozen BEFORE the batch validators run. */
export function buildContentRevisionCommitCore(input: {
  priorManifestRef: BlobRefV2;
  producerPlanSpecRef: BlobRefV2;
  batchOrdinal: number;
  authorizedReplacementEntriesWithoutValidation: readonly { slotId: string; expectedCurrentVersionRef: BlobRefV2 | null }[];
  expectedMapRef: BlobRefV2;
}): ContentRevisionCommitCoreV2 {
  const body = { ...input };
  return { ...body, coreDigest: canonicalJsonSha256(body) };
}

/** §11.5 ContentPlanFinalizeCore — the finalizer's input (mapContext active). */
export function buildContentPlanFinalizeCore(input: {
  producerPlanSpecRef: BlobRefV2;
  provisionalManifestRef: BlobRefV2;
  activeMapRef: BlobRefV2;
  expectedContentRootDigest: string;
  requiredSlotCoverageDigest: string;
  expectedBatchClosureDigest: string;
}): ContentPlanFinalizeCoreV2 {
  const body = {
    producerPlanSpecRef: input.producerPlanSpecRef,
    provisionalManifestRef: input.provisionalManifestRef,
    mapContext: { kind: 'active' as const, activeMapRef: input.activeMapRef },
    expectedContentRootDigest: input.expectedContentRootDigest,
    requiredSlotCoverageDigest: input.requiredSlotCoverageDigest,
    expectedBatchClosureDigest: input.expectedBatchClosureDigest,
  };
  return { ...body, coreDigest: canonicalJsonSha256(body) };
}

/** Provisional manifest revision (finalizer refs EMPTY — never Seal-eligible). */
export function buildProvisionalManifest(input: {
  taskId: string;
  mapRef: BlobRefV2;
  mapSemanticDigest: string;
  taskContentRevision: number;
  priorManifestRef: BlobRefV2;
  producerPlanSpecRef: BlobRefV2;
  entries: readonly { slotId: string; versionRef: BlobRefV2 }[];
  resolvedVersions: ReadonlyMap<string, SlotContentVersionV2>;
}): ContentRevisionManifestV2 {
  return computeProvisionalOrFinalizedManifest({
    ...input,
    manifestPhase: 'provisional',
    finalizerValidatorAggregateRefs: [],
    finalizerWarningRootRefs: [],
  });
}

/** Finalized manifest revision (finalizer refs NON-empty — Seal-eligible). */
export function buildFinalizedManifest(input: {
  taskId: string;
  mapRef: BlobRefV2;
  mapSemanticDigest: string;
  taskContentRevision: number;
  priorManifestRef: BlobRefV2;
  producerPlanSpecRef: BlobRefV2;
  entries: readonly { slotId: string; versionRef: BlobRefV2 }[];
  resolvedVersions: ReadonlyMap<string, SlotContentVersionV2>;
  finalizerValidatorAggregateRefs: readonly BlobRefV2[];
  finalizerWarningRootRefs: readonly BlobRefV2[];
}): ContentRevisionManifestV2 {
  return computeProvisionalOrFinalizedManifest({
    ...input,
    manifestPhase: 'finalized',
  });
}

/** §9 content warning custody root for the plan_finalize run (the finalized
 * manifest's `finalizerWarningRootRefs`). */
export function buildContentFinalizerWarningCustodyRoot(input: {
  taskId: string;
  inputRef: BlobRefV2;
  inputDigest: string;
  aggregateRef: BlobRefV2;
  warningRootRef: BlobRefV2;
  planRevisionId: string;
}): ValidationWarningCustodyRootV2 {
  const body = {
    scope: 'content_review' as const,
    taskId: input.taskId,
    baseRefs: [input.inputRef],
    entries: [
      {
        trigger: 'content_commit' as const,
        inputRef: input.inputRef,
        inputDigest: input.inputDigest,
        executionScope: { planRevisionId: input.planRevisionId },
        validatorAggregateRef: input.aggregateRef,
        warningRootRef: input.warningRootRef,
      },
    ],
    supersessionPolicyVersion: '1',
  };
  return { ...body, rootDigest: canonicalJsonSha256(body) };
}

/** §11.4 empty adoption root (the round-planned event's adoptionRootRef). */
export function buildEmptyAdoptionRoot(roundId: string): { roundId: string; orderedChunkRefs: readonly BlobRefV2[]; adoptedTargetCount: number; coverageDigest: string; rootDigest: string } {
  const body = { roundId, orderedChunkRefs: [] as readonly BlobRefV2[], adoptedTargetCount: 0, coverageDigest: canonicalJsonSha256({ roundId, empty: true }) };
  return { ...body, rootDigest: canonicalJsonSha256(body) };
}

/** §9 content warning custody root for ONE generation batch (the set version's
 * `contentCommitWarningRootRef`). The engine produces a per-trigger
 * `ValidationWarningRootV2`; this custody root is the registered
 * `validation_warning_custody_root` the version provenance binds. */
export function buildContentBatchWarningCustodyRoot(input: {
  taskId: string;
  inputRef: BlobRefV2;
  inputDigest: string;
  aggregateRef: BlobRefV2;
  warningRootRef: BlobRefV2;
  batchOrdinal: number;
  planRevisionId: string;
}): ValidationWarningCustodyRootV2 {
  const body = {
    scope: 'content_review' as const,
    taskId: input.taskId,
    baseRefs: [input.inputRef],
    entries: [
      {
        trigger: 'content_commit' as const,
        inputRef: input.inputRef,
        inputDigest: input.inputDigest,
        executionScope: { planRevisionId: input.planRevisionId, batchOrdinal: input.batchOrdinal },
        validatorAggregateRef: input.aggregateRef,
        warningRootRef: input.warningRootRef,
      },
    ],
    supersessionPolicyVersion: '1',
  };
  return { ...body, rootDigest: canonicalJsonSha256(body) };
}

/** Blocking-successor GenerationPlan: imports the untouched versions via
 * `baseContentRevisionManifestRef`/`importedContentManifestRef` = the complete
 * provisional manifest, and re-runs ONLY the deterministic correction batches.
 * The successor revision is the superseded plan's revision + 1 (the first
 * blocking successor is revision 2; a later blocking of the successor itself
 * derives revision 3 without violating the projector's successor rules). */
export function buildSuccessorGenerationPlan(input: {
  generationPlanId: string;
  revision: number;
  supersedesGenerationPlanId: string;
  sourceValidationReceiptRef: BlobRefV2;
  activeMapRef: BlobRefV2;
  importedContentManifestRef: BlobRefV2;
  correctionSlotIds: readonly string[];
  correctionSlotsWithOrder: readonly { slotId: string; documentOrder: number }[];
  reviewPolicy: ReviewPolicyParameters;
}): GenerationPlanSpecV2 {
  const correctionBatches = partitionCorrectionBatches(input.correctionSlotsWithOrder, input.reviewPolicy.contentBatchTargetSlots);
  const body = {
    generationPlanId: input.generationPlanId,
    revision: input.revision,
    supersedesGenerationPlanId: input.supersedesGenerationPlanId,
    sourceValidationReceiptRef: input.sourceValidationReceiptRef,
    activeMapRef: input.activeMapRef,
    baseContentRevisionManifestRef: input.importedContentManifestRef,
    importedContentManifestRef: input.importedContentManifestRef,
    correctionScopeDigest: canonicalJsonSha256([...input.correctionSlotIds].sort()),
    orderedBatchSlotIds: correctionBatches,
  };
  return { ...body, specDigest: canonicalJsonSha256(body) };
}

/* ------------------------------------------------------------------ */
/* Memory validator store (content targets + provisional manifest      */
/* enrichment — the Task 21 resolver seam, test/service local)         */
/* ------------------------------------------------------------------ */

/**
 * In-memory ValidatorBlobStore whose resolve ENRICHES the two shapes the
 * content validators need but the strict blob parsers forbid:
 * - content_value targets gain `typeId` (the slot's slot type) + `content`
 *   (= text) so the engine enriches contentSchema/contentPresence from the
 *   template slot types (Task 14 M-6 wiring seam);
 * - content_revision_manifest entries gain `state` (set/unset/rewrite_required)
 *   derived from the resolved content versions so the plan_finalize coverage
 *   handler can judge required-slot coverage over the resolved manifest.
 */
export class ContentPlanMemoryBlobStore implements ValidatorBlobStore {
  private readonly data = new Map<string, unknown>();

  constructor(
    private readonly enrich: (ref: BlobRefV2, value: unknown) => unknown,
  ) {}

  put(kind: import('../../../shared/authoritative-review-v2').AuthoritativeBlobKindV2, value: unknown): BlobRefV2 {
    const ref = refOfBlob(kind, value);
    if (!this.data.has(ref.digest)) {
      this.data.set(ref.digest, value);
    }
    return ref;
  }

  resolve(ref: BlobRefV2): unknown | null {
    const value = this.data.get(ref.digest) ?? null;
    if (value === null) return null;
    return this.enrich(ref, value);
  }
}

/** Build the standard enrichment for content validation runs. */
export function contentPlanEnrichment(input: {
  slotTypeOf: (slotId: string) => string;
  versionStateOf: (slotId: string) => 'set' | 'unset' | 'rewrite_required';
}): (ref: BlobRefV2, value: unknown) => unknown {
  return (ref, value) => {
    if (ref.kind === 'content_value' && typeof value === 'object' && value !== null) {
      const v = value as { slotId: string; text: string };
      return { ...v, typeId: input.slotTypeOf(v.slotId), content: v.text };
    }
    if (ref.kind === 'content_revision_manifest' && typeof value === 'object' && value !== null) {
      const m = value as { entries: readonly { slotId: string }[] };
      return {
        ...m,
        entries: m.entries.map((e) => ({ ...e, state: input.versionStateOf(e.slotId) })),
      };
    }
    return value;
  };
}

/* ------------------------------------------------------------------ */
/* Service dependencies                                                */
/* ------------------------------------------------------------------ */

export interface ContentPlanServiceDependencies {
  facade: Pick<AuthoritativeAppendFacadeV2, 'prepareBlob' | 'publishWithPin'>;
  coordinator: WorkItemCoordinatorV2;
  grants: GrantService;
  readProjection(taskId: string): Promise<AuthoritativeReviewProjectionV2>;
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown> | unknown;
  tail(taskId: string): Promise<{ lastSequence: number; lastCommitId: string | null }>;
  readEvents(taskId: string): Promise<readonly AuthoritativeReviewEventV2[]>;
  clock(): string;
  profile: AuthoritativeReviewProfile;
  profileBody: AuthoritativeReviewProfileSnapshotV1Body;
  validatorRegistry: import('./validator-registry').ValidatorRegistry;
  sourceResolver?: (handlerKey: string) => string | null;
  registrationsFor(trigger: 'content_commit', phase: 'batch_commit' | 'plan_finalize'): readonly import('../../template/structured-slot-contract-v2').ValidatorRegistrationV2[];
  reviewPolicy: ReviewPolicyParameters;
  reviewPolicyDigest: string;
  templateSnapshotRef: BlobRefV2;
  profileSnapshotRef: BlobRefV2;
  /** The frozen template snapshot hash (binds every grant spec). */
  snapshotHash: string;
  generatorRoleBinding: string;
  reviewerRoleBinding: string;
  /** Template slot types (the engine enriches content targets with these). */
  slotTypes: readonly ValidatorSlotType[];
  /** slotId -> slot type id (the map node's slotType). */
  slotTypeOf(slotId: string): string;
  /** slotId -> resolved template content schema digest (the version's contentSchemaDigest). */
  contentSchemaDigestOf(slotId: string): string;
  defaultAutomaticRetries(): Promise<number>;
}

/** The committed result of one clear generation batch. */
export type GenerationBatchOutcome =
  | { kind: 'committed'; manifestRef: BlobRefV2; manifest: ContentRevisionManifestV2; nextWorkItemId: string }
  | { kind: 'blocked'; failureCode: string; aggregateRef: BlobRefV2; receiptRef: BlobRefV2 | null }
  | { kind: 'infrastructure_failure'; failureCode: string; aggregateRef: BlobRefV2 };

/** A plan spec with its resolved authority-base ref (the base's planSpecRef). */
export type ResolvedPlanSpecV2 = GenerationPlanSpecV2 & { specRef: BlobRefV2 };

/** The finalizer outcome. */
export type GenerationFinalizeOutcome =
  | { kind: 'completed'; resultRefs: readonly BlobRefV2[] }
  | { kind: 'blocked'; failureCode: string; resultRefs: readonly BlobRefV2[] }
  | { kind: 'infrastructure_failure'; failureCode: string };

/* ------------------------------------------------------------------ */
/* The service                                                         */
/* ------------------------------------------------------------------ */

export class ContentPlanError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContentPlanError';
    this.code = code;
  }
}

export class ContentPlanService {
  private readonly deps: ContentPlanServiceDependencies;

  constructor(deps: ContentPlanServiceDependencies) {
    this.deps = deps;
  }

  /* ------------------------- batch commit ------------------------ */

  /**
   * One generation batch commit (spec §13.2 step 2). Validates the batch
   * ordinal is NEXT, the grant scope equals the plan's batch slot set, the
   * grant's expected manifest CASes the current manifest and the grant's Map
   * ref is the current Map snapshot — then freezes the commit core, runs ONLY
   * `content_commit/batch_commit`, and on clear publishes the provisional
   * manifest + `structured_generation_batch_committed` + the successor WorkItem
   * (next batch OR `system_generation_finalize`). A global validator must never
   * run here (the plan_finalize coverage handler is excluded by phase).
   */
  async commitGenerationBatch(input: {
    taskId: string;
    workItemId: string;
    attemptId: string;
    batchOrdinal: number;
    /** The real lease context (dispatchRef/grantInstanceRef/agentId) — the
     * grant-service resolves the signed GrantInstance through it. */
    ctx: import('./attempt-coordinator').V2AttemptContext;
    slotContents: Readonly<Record<string, { text: string; mediaType: 'text/markdown' | 'text/plain' }>>;
  }): Promise<GenerationBatchOutcome> {
    const state = await this.deps.readProjection(input.taskId);
    const wi = state.workItems[input.workItemId];
    if (wi === undefined) throw new ContentPlanError('WORK_ITEM_NOT_FOUND', `no workitem '${input.workItemId}'`);
    const plan = await this.readPlanForWorkItem(input.taskId, wi);
    if (plan === null) throw new ContentPlanError('PLAN_UNKNOWN', 'generation workitem has no resolvable plan');
    // Single-writer: this batch ordinal must be the NEXT uncommitted ordinal.
    const events = await this.deps.readEvents(input.taskId);
    const committedOrdinals = events
      .filter(
        (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_generation_batch_committed' }> =>
          e.type === 'structured_generation_batch_committed' && e.generationPlanId === plan.generationPlanId,
      )
      .map((e) => e.batchOrdinal);
    const lastOrdinal = committedOrdinals.length === 0 ? 0 : Math.max(...committedOrdinals);
    // The initial plan is STARTED by its FIRST batch envelope (Task 16's
    // activation creates the plan + first WorkItem but no started event), so
    // the lineage is absent exactly when no batch has committed yet. A batch
    // AFTER the first must see the plan as the current active revision.
    // A SUCCESSOR plan lives under the SHARED lineage of its original plan
    // (keyed by the revision-1 id), so the lineage is found by scanning for a
    // revision that owns this plan id (map-build F3 precedent) — never by
    // indexing `generationPlans[plan.generationPlanId]`, which is undefined
    // for successor revisions.
    const activeLineage = Object.values(state.generationPlans).find((l) =>
      Object.values(l.revisions).some((r) => r.planId === plan.generationPlanId),
    );
    const lineageOk = activeLineage !== undefined && activeLineage.revisions[String(activeLineage.currentRevision)]?.planId === plan.generationPlanId;
    if (!lineageOk && lastOrdinal > 0) {
      throw new ContentPlanError('PLAN_STALE', 'the generation plan is not the current active revision');
    }
    const totalBatches = plan.orderedBatchSlotIds.length;
    if (input.batchOrdinal < 1 || input.batchOrdinal > totalBatches) {
      throw new ContentPlanError('BATCH_OUT_OF_RANGE', `batchOrdinal ${input.batchOrdinal} outside 1..${totalBatches}`);
    }
    if (input.batchOrdinal !== lastOrdinal + 1) {
      throw new ContentPlanError('BATCH_OUT_OF_ORDER', `batchOrdinal ${input.batchOrdinal} is not the next ordinal ${lastOrdinal + 1}`);
    }

    const currentManifest = state.currentManifest === null ? null : (await this.deps.resolver(input.taskId, state.currentManifest.contentRevisionManifestRef));
    if (currentManifest === null || typeof currentManifest !== 'object') {
      throw new ContentPlanError('MANIFEST_UNRESOLVED', 'current manifest unresolvable');
    }
    const currentManifestRef = state.currentManifest === null ? null : state.currentManifest.contentRevisionManifestRef;
    if (currentManifestRef === null) throw new ContentPlanError('MANIFEST_UNRESOLVED', 'current manifest ref unresolvable');
    if (state.currentMap === null) throw new ContentPlanError('MAP_UNRESOLVED', 'no current Map');
    const currentMapRef = state.currentMap.mapSnapshotRef;

    // Grant/scope/CAS checks (§14.2: any out-of-scope write rejects the whole
    // batch atomically; stale Map/manifest grants reject with zero writes).
    const grant = await this.deps.grants.resolveAttemptGrant(input.ctx);
    const batchSlotIds = plan.orderedBatchSlotIds[input.batchOrdinal - 1] ?? [];
    const grantWriteIds = [...grantSpecWriteSlotIds(grant.spec)];
    if (grantWriteIds.length !== batchSlotIds.length || ![...batchSlotIds].every((id) => grantWriteIds.includes(id))) {
      throw new ContentPlanError('GRANT_STALE', 'grant writeSlotIds do not match the plan batch slot set');
    }
    if (grant.spec.kind === 'initial_generation_batch') {
      if (!sameRef(grant.spec.expectedContentRevisionManifestRef, currentManifestRef)) {
        throw new ContentPlanError('AUTHORITY_BASE_STALE', 'grant expected manifest does not CAS the current manifest');
      }
      if (!sameRef(grant.spec.activeMapRef, currentMapRef)) {
        throw new ContentPlanError('AUTHORITY_BASE_STALE', 'grant active Map is not the current Map snapshot');
      }
    }
    // Overscope: every written slot must be a granted batch slot.
    for (const slotId of Object.keys(input.slotContents)) {
      if (!batchSlotIds.includes(slotId)) {
        throw new ContentPlanError('WRITE_OUT_OF_SCOPE', `slot '${slotId}' is not in batch ${input.batchOrdinal}`);
      }
    }

    // Content values + versions.
    const manifest = currentManifest as ContentRevisionManifestV2;
    const mapSemanticDigest = (await this.deps.resolver(input.taskId, currentMapRef)) as { mapSemanticDigest: string };
    if (mapSemanticDigest === null || typeof mapSemanticDigest !== 'object') {
      throw new ContentPlanError('MAP_UNRESOLVED', 'active Map snapshot unresolvable');
    }
    const contentSchemaDigestOf = this.deps.contentSchemaDigestOf.bind(this.deps);
    const contentValues = new Map<string, ContentValueV2>();
    for (const slotId of batchSlotIds) {
      const raw = input.slotContents[slotId];
      if (raw === undefined) throw new ContentPlanError('SLOT_CONTENT_MISSING', `batch ${input.batchOrdinal} has no content for slot '${slotId}'`);
      const value = buildContentValue({
        slotId,
        contentSchemaDigest: contentSchemaDigestOf(slotId),
        taskContentRevision: manifest.taskContentRevision + 1,
        mediaType: raw.mediaType,
        text: raw.text,
      });
      contentValues.set(slotId, value);
    }

    // Freeze the commit core BEFORE validators run.
    const authorizedReplacementEntries = batchSlotIds.map((slotId) => ({ slotId, expectedCurrentVersionRef: null }));
    const commitCore = buildContentRevisionCommitCore({
      priorManifestRef: currentManifestRef,
      producerPlanSpecRef: plan.specRef as BlobRefV2,
      batchOrdinal: input.batchOrdinal,
      authorizedReplacementEntriesWithoutValidation: authorizedReplacementEntries,
      expectedMapRef: currentMapRef,
    });
    const commitCoreRef = await this.deps.facade.prepareBlob(input.taskId, 'content_revision_commit_core', commitCore);

    // Run ONLY content_commit/batch_commit registrations.
    const run = await this.runBatchValidator(input.taskId, input.workItemId, input.attemptId, commitCoreRef, commitCore, currentMapRef, batchSlotIds, contentValues, mapSemanticDigest.mapSemanticDigest);
    await this.persistEngineOutputs(input.taskId, run.run, run.store);
    if (run.run.aggregate.outcome === 'blocking_invalid') {
      const receiptRef = run.run.receipts[0] === undefined ? null : refOfBlob('validation_receipt', run.run.receipts[0]);
      return { kind: 'blocked', failureCode: 'GENERATION_BATCH_BLOCKED', aggregateRef: run.run.aggregateRef, receiptRef };
    }
    if (run.run.aggregate.outcome !== 'clear') {
      return { kind: 'infrastructure_failure', failureCode: 'VALIDATOR_INFRASTRUCTURE_FAILURE', aggregateRef: run.run.aggregateRef };
    }

    // On clear: build the set versions (with the batch's core/aggregate/warning
    // provenance) + the provisional manifest.
    const warningRootRef = refOfBlob('validation_warning_root', run.run.warningRoot);
    const custody = buildContentBatchWarningCustodyRoot({
      taskId: input.taskId,
      inputRef: run.run.envelopeRef,
      inputDigest: run.run.envelopeRef.digest,
      aggregateRef: run.run.aggregateRef,
      warningRootRef,
      batchOrdinal: input.batchOrdinal,
      planRevisionId: plan.generationPlanId,
    });
    const warningCustodyRef = await this.deps.facade.prepareBlob(input.taskId, 'validation_warning_custody_root', custody);
    const newVersions = new Map<string, SlotContentVersionV2>();
    const valueRefs = new Map<string, BlobRefV2>();
    const entryBySlot = new Map<string, { slotId: string; versionRef: BlobRefV2 }>();
    for (const slotId of batchSlotIds) {
      const value = contentValues.get(slotId) as ContentValueV2;
      const valueRef = await this.deps.facade.prepareBlob(input.taskId, 'content_value', value);
      valueRefs.set(slotId, valueRef);
      const version = buildContentSetVersion({
        slotId,
        slotRevision: 1,
        taskContentRevision: manifest.taskContentRevision + 1,
        mapRef: currentMapRef,
        mapSemanticDigest: mapSemanticDigest.mapSemanticDigest,
        contentSchemaDigest: contentSchemaDigestOf(slotId),
        blobRef: valueRef,
        producer: { kind: 'generation_batch', planRevisionId: plan.generationPlanId, batchOrdinal: input.batchOrdinal, attemptId: input.attemptId },
        contentRevisionCommitCoreRef: commitCoreRef,
        contentCommitValidatorAggregateRef: run.run.aggregateRef,
        contentCommitWarningRootRef: warningCustodyRef,
        committedByAttemptId: input.attemptId,
      });
      const versionRef = await this.deps.facade.prepareBlob(input.taskId, 'content_version', version);
      newVersions.set(slotId, version);
      entryBySlot.set(slotId, { slotId, versionRef });
    }
    const priorEntryById = new Map(manifest.entries.map((e) => [e.slotId, e]));
    for (const [slotId, entry] of entryBySlot) priorEntryById.set(slotId, entry);
    const allVersions = new Map<string, SlotContentVersionV2>();
    for (const entry of manifest.entries) {
      if (newVersions.has(entry.slotId)) continue;
      const priorVersion = await this.resolveVersion(input.taskId, entry.versionRef);
      if (priorVersion !== null) allVersions.set(entry.slotId, priorVersion);
    }
    for (const [slotId, version] of newVersions) allVersions.set(slotId, version);
    const newEntries = [...priorEntryById.values()].sort((a, b) => (a.slotId < b.slotId ? -1 : 1));
    const provisional = buildProvisionalManifest({
      taskId: input.taskId,
      mapRef: currentMapRef,
      mapSemanticDigest: mapSemanticDigest.mapSemanticDigest,
      taskContentRevision: manifest.taskContentRevision + 1,
      priorManifestRef: currentManifestRef,
      producerPlanSpecRef: plan.specRef as BlobRefV2,
      entries: newEntries,
      resolvedVersions: allVersions,
    });
    const provisionalRef = await this.deps.facade.prepareBlob(input.taskId, 'content_revision_manifest', provisional);

    // Successor: next batch OR the finalizer WorkItem.
    const isLast = input.batchOrdinal === totalBatches;
    const nextWorkItemId = isLast
      ? generationFinalizeWorkItemId(input.taskId, plan.generationPlanId)
      : generationBatchWorkItemId(input.taskId, plan.generationPlanId, input.batchOrdinal + 1);
    const successor = await this.prepareBatchSuccessor({
      taskId: input.taskId,
      plan,
      batchOrdinal: input.batchOrdinal,
      nextWorkItemId,
      isLast,
      provisionalRef,
      mapSemanticDigest: mapSemanticDigest.mapSemanticDigest,
    });
    const carryErrors = validateSuccessorCarrier(successor.carrier);
    if (carryErrors.length > 0) {
      throw new ContentPlanError('INVALID_INPUT', `generation successor carry invalid: ${carryErrors.join('; ')}`);
    }

    const operationId = contentBatchCommitOperationId(input.taskId, input.workItemId, input.batchOrdinal);
    const versionRefs = batchSlotIds.map((slotId) => entryBySlot.get(slotId)?.versionRef).filter((r): r is BlobRefV2 => r !== undefined);
    const blobRefs = [
      commitCoreRef,
      run.run.aggregateRef,
      warningCustodyRef,
      provisionalRef,
      ...valueRefs.values(),
      ...versionRefs,
      successor.authorityBaseRef,
      ...(successor.grantSpecRef === null ? [] : [successor.grantSpecRef]),
    ];
    await this.publish(input.taskId, {
      operationId,
      publishKind: 'content_revision_commit',
      blobRefs,
      carriers: contentPlanCarrier({
        generationPlanId: plan.generationPlanId,
        generationPlanRevision: plan.revision,
        supersedesGenerationPlanId: plan.supersedesGenerationPlanId,
        generationPlanSpecRef: plan.specRef as BlobRefV2,
        sourceValidationReceiptRef: plan.sourceValidationReceiptRef,
        planStarted: input.batchOrdinal === 1 && plan.revision === 1,
        batchOrdinal: input.batchOrdinal,
        contentRevisionCommitCoreRef: commitCoreRef,
        validatorAggregateRef: run.run.aggregateRef,
        contentRevisionManifestRef: provisionalRef,
        taskContentRevision: provisional.taskContentRevision,
        manifestPhase: 'provisional',
        producerPlanSpecRef: plan.specRef as BlobRefV2,
        priorManifestRef: currentManifestRef,
        successor: successor.carrier,
      }),
      preparedRefs: blobRefs,
    });
    return { kind: 'committed', manifestRef: provisionalRef, manifest: provisional, nextWorkItemId };
  }

  /* ------------------------- finalizer ---------------------------- */

  /**
   * The `system_generation_finalize` handler. Binds the COMPLETE provisional
   * manifest in `ContentPlanFinalizeCoreV2` and runs ONLY
   * `content_commit/plan_finalize`. On clear publishes the FINALIZED manifest
   * (finalizer custody refs) + `structured_generation_plan_completed` + Content
   * Review planning + the review WorkItems. On blocking publishes the receipt +
   * ONE successor GenerationPlan (imported untouched versions + deterministic
   * correction batches). On infrastructure failure returns retryable_failure.
   */
  async executeGenerationFinalize(input: {
    taskId: string;
    commandId: string;
    workItemId: string;
    commandKind: 'generation_finalize';
    leaseEpoch: number;
    authorityBaseRef: BlobRefV2;
    payloadRef: BlobRefV2;
  }): Promise<GenerationFinalizeOutcome> {
    try {
      const state = await this.deps.readProjection(input.taskId);
      const wi = state.workItems[input.workItemId];
      if (wi === undefined) throw new ContentPlanError('WORK_ITEM_NOT_FOUND', `no workitem '${input.workItemId}'`);
      const base = (await this.deps.resolver(input.taskId, input.authorityBaseRef)) as {
        mapRef: BlobRefV2 | null;
        contentRevisionManifestRef: BlobRefV2 | null;
        planSpecRef: BlobRefV2 | null;
      } | null;
      if (base === null || typeof base !== 'object' || base.mapRef === null || base.contentRevisionManifestRef === null || base.planSpecRef === null) {
        throw new ContentPlanError('GRANT_STALE', 'finalize authority base is unresolvable or missing map/manifest/plan refs');
      }
      const baseMapRef: BlobRefV2 = base.mapRef;
      const baseManifestRef: BlobRefV2 = base.contentRevisionManifestRef;
      const basePlanSpecRef: BlobRefV2 = base.planSpecRef;
      if (state.currentManifest === null || !sameRef(state.currentManifest.contentRevisionManifestRef, baseManifestRef)) {
        throw new ContentPlanError('GRANT_STALE', 'finalize base manifest is not the current manifest');
      }
      if (state.currentMap === null || !sameRef(state.currentMap.mapSnapshotRef, baseMapRef)) {
        throw new ContentPlanError('GRANT_STALE', 'finalize base Map is not the current Map snapshot');
      }
      // The payload must be the exact provisional manifest the base binds.
      if (input.payloadRef.kind !== 'content_revision_manifest' || input.payloadRef.digest !== baseManifestRef.digest) {
        throw new ContentPlanError('GRANT_STALE', 'finalize payload does not match the authority base manifest');
      }
      const provisional = (await this.deps.resolver(input.taskId, baseManifestRef)) as ContentRevisionManifestV2 | null;
      if (provisional === null || typeof provisional !== 'object') throw new ContentPlanError('MANIFEST_UNRESOLVED', 'provisional manifest unresolvable');
      const plan = (await this.deps.resolver(input.taskId, basePlanSpecRef)) as GenerationPlanSpecV2 | null;
      if (plan === null || typeof plan !== 'object') throw new ContentPlanError('PLAN_UNRESOLVED', 'plan spec unresolvable');

      // The manifest must be the COMPLETE provisional (every plan slot set).
      const planSlots = new Set(plan.orderedBatchSlotIds.flat());
      const provisionalBySlot = new Map(provisional.entries.map((e) => [e.slotId, e]));
      const setSlotIds: string[] = [];
      const resolvedVersions = new Map<string, SlotContentVersionV2>();
      for (const slotId of planSlots) {
        const entry = provisionalBySlot.get(slotId);
        if (entry === undefined) throw new ContentPlanError('MANIFEST_INCOMPLETE', `provisional manifest missing slot '${slotId}'`);
        const version = await this.resolveVersion(input.taskId, entry.versionRef);
        if (version === null) throw new ContentPlanError('MANIFEST_INCOMPLETE', `cannot resolve version of slot '${slotId}'`);
        resolvedVersions.set(slotId, version);
        if (version.state !== 'set') throw new ContentPlanError('MANIFEST_INCOMPLETE', `slot '${slotId}' is not set (${version.state})`);
        setSlotIds.push(slotId);
      }

      const requiredSlotIds = setSlotIds.filter((slotId) => this.requiredSlotOf(slotId));
      const finalizeCore = buildContentPlanFinalizeCore({
        producerPlanSpecRef: basePlanSpecRef,
        provisionalManifestRef: baseManifestRef,
        activeMapRef: baseMapRef,
        expectedContentRootDigest: provisional.contentRootDigest,
        requiredSlotCoverageDigest: canonicalJsonSha256([...requiredSlotIds].sort()),
        expectedBatchClosureDigest: canonicalJsonSha256(plan.orderedBatchSlotIds.map((batch) => canonicalJsonSha256(batch))),
      });
      const finalizeCoreRef = await this.deps.facade.prepareBlob(input.taskId, 'content_plan_finalize_core', finalizeCore);

      const run = await this.runFinalizeValidator(input.taskId, input.workItemId, input.commandId, finalizeCoreRef, finalizeCore, baseManifestRef, requiredSlotIds, resolvedVersions);
      await this.persistEngineOutputs(input.taskId, run.run, run.store);
      if (run.run.aggregate.outcome === 'blocking_invalid') {
        const resultRefs = await this.publishBlockingSuccessor(input, plan, provisional, { mapRef: baseMapRef, contentRevisionManifestRef: baseManifestRef, planSpecRef: basePlanSpecRef }, run.run);
        return { kind: 'blocked', failureCode: 'GENERATION_PLAN_BLOCKED', resultRefs };
      }
      if (run.run.aggregate.outcome !== 'clear') {
        return { kind: 'infrastructure_failure', failureCode: 'VALIDATOR_INFRASTRUCTURE_FAILURE' };
      }

      // Clear: finalized manifest + plan completed + content review planning.
      const finalizerWarningRootRef = refOfBlob('validation_warning_root', run.run.warningRoot);
      const finalizerCustody = buildContentFinalizerWarningCustodyRoot({
        taskId: input.taskId,
        inputRef: run.run.envelopeRef,
        inputDigest: run.run.envelopeRef.digest,
        aggregateRef: run.run.aggregateRef,
        warningRootRef: finalizerWarningRootRef,
        planRevisionId: plan.generationPlanId,
      });
      const finalizerCustodyRef = await this.deps.facade.prepareBlob(input.taskId, 'validation_warning_custody_root', finalizerCustody);
      const finalized = buildFinalizedManifest({
        taskId: input.taskId,
        mapRef: baseMapRef,
        mapSemanticDigest: provisional.mapSemanticDigest,
        taskContentRevision: provisional.taskContentRevision + 1,
        priorManifestRef: baseManifestRef,
        producerPlanSpecRef: basePlanSpecRef,
        entries: provisional.entries,
        resolvedVersions,
        finalizerValidatorAggregateRefs: [run.run.aggregateRef],
        finalizerWarningRootRefs: [finalizerCustodyRef],
      });
      const finalizedRef = await this.deps.facade.prepareBlob(input.taskId, 'content_revision_manifest', finalized);
      const reviewPlanning = await this.prepareContentReviewPlanning(input, finalizedRef, setSlotIds);

      const resultRefs = [
        finalizeCoreRef,
        run.run.aggregateRef,
        finalizerWarningRootRef,
        finalizerCustodyRef,
        finalizedRef,
        reviewPlanning.adoptionRootRef,
        reviewPlanning.reviewWorkItems.length > 0 ? reviewPlanning.coverageCoreRef : reviewPlanning.adoptionRootRef,
        ...reviewPlanning.workItemRefs,
      ];
      const terminal: SystemCommandTerminalCarrierV2 = {
        workItemId: input.workItemId,
        commandId: input.commandId,
        commandKind: input.commandKind,
        leaseEpoch: input.leaseEpoch,
        authorityBaseRef: input.authorityBaseRef,
      };
      const operationId = contentFinalizeOperationId(input.taskId, input.workItemId, input.commandId);
      const blobRefs = [
        finalizeCoreRef,
        run.run.aggregateRef,
        finalizerWarningRootRef,
        finalizerCustodyRef,
        finalizedRef,
        reviewPlanning.adoptionRootRef,
        ...reviewPlanning.preparedRefs,
      ];
      await this.publish(input.taskId, {
        operationId,
        publishKind: 'content_plan_finalize',
        blobRefs,
        carriers: contentPlanCarrier({
          generationPlanId: plan.generationPlanId,
          generationPlanRevision: plan.revision,
          supersedesGenerationPlanId: plan.supersedesGenerationPlanId,
          generationPlanSpecRef: basePlanSpecRef,
          sourceValidationReceiptRef: plan.sourceValidationReceiptRef,
          contentRevisionManifestRef: finalizedRef,
          taskContentRevision: finalized.taskContentRevision,
          manifestPhase: 'finalized',
          producerPlanSpecRef: basePlanSpecRef,
          priorManifestRef: baseManifestRef,
          validatorAggregateRef: run.run.aggregateRef,
          finalizerWarningRootRef: refOfBlob('validation_warning_root', run.run.warningRoot),
          reviewRound: reviewPlanning.round,
          reviewWorkItems: reviewPlanning.reviewWorkItems,
          terminal,
        }),
        preparedRefs: blobRefs,
      });
      return { kind: 'completed', resultRefs };
    } catch (error) {
      if (error instanceof ContentPlanError) {
        return { kind: 'infrastructure_failure', failureCode: error.code };
      }
      return { kind: 'infrastructure_failure', failureCode: 'GENERATION_FINALIZE_FAILED' };
    }
  }

  /* ------------------------- internals ---------------------------- */

  private async runBatchValidator(
    taskId: string,
    workItemId: string,
    attemptId: string,
    commitCoreRef: BlobRefV2,
    commitCore: ContentRevisionCommitCoreV2,
    activeMapRef: BlobRefV2,
    batchSlotIds: readonly string[],
    contentValues: ReadonlyMap<string, ContentValueV2>,
    mapSemanticDigest: string,
  ): Promise<{ run: TriggerExecutionResult; store: ContentPlanMemoryBlobStore }> {
    const store = new ContentPlanMemoryBlobStore(
      contentPlanEnrichment({
        slotTypeOf: (slotId) => this.deps.slotTypeOf(slotId),
        versionStateOf: () => 'set',
      }),
    );
    store.put('content_revision_commit_core', commitCore);
    const targetRefs: BlobRefV2[] = [];
    for (const slotId of batchSlotIds) {
      const value = contentValues.get(slotId) as ContentValueV2;
      targetRefs.push(store.put('content_value', value));
    }
    void activeMapRef;
    void mapSemanticDigest;
    const engine = new ValidatorEngine({
      registry: this.deps.validatorRegistry,
      blobs: store,
      sourceResolver: this.deps.sourceResolver,
    });
    const run = await engine.execute({
      trigger: 'content_commit',
      executionPhase: 'batch_commit',
      identity: { taskId, templateSnapshotHash: this.deps.snapshotHash, workItemId, attemptId, commandId: null },
      coreRef: commitCoreRef,
      selectedTargetRefs: targetRefs,
      registrations: this.deps.registrationsFor('content_commit', 'batch_commit'),
      universe: { slotIds: [...batchSlotIds], relationIds: [], mapNodeIds: [], artifactDigest: null },
      slotTypes: this.deps.slotTypes,
      context: { requiredSlotIds: [...batchSlotIds] },
      profile: this.deps.profileBody,
    });
    return { run, store };
  }

  private async runFinalizeValidator(
    taskId: string,
    workItemId: string,
    commandId: string,
    finalizeCoreRef: BlobRefV2,
    finalizeCore: ContentPlanFinalizeCoreV2,
    provisionalManifestRef: BlobRefV2,
    requiredSlotIds: readonly string[],
    resolvedVersions: ReadonlyMap<string, SlotContentVersionV2>,
  ): Promise<{ run: TriggerExecutionResult; store: ContentPlanMemoryBlobStore }> {
    const store = new ContentPlanMemoryBlobStore(
      contentPlanEnrichment({
        slotTypeOf: (slotId) => this.deps.slotTypeOf(slotId),
        versionStateOf: (slotId) => (resolvedVersions.get(slotId)?.state ?? 'unset'),
      }),
    );
    store.put('content_plan_finalize_core', finalizeCore);
    // The manifest must be resolvable from the store (deep-resolved by the engine).
    const manifest = (await this.deps.resolver(taskId, provisionalManifestRef)) as ContentRevisionManifestV2;
    store.put('content_revision_manifest', manifest);
    const engine = new ValidatorEngine({
      registry: this.deps.validatorRegistry,
      blobs: store,
      sourceResolver: this.deps.sourceResolver,
    });
    const run = await engine.execute({
      trigger: 'content_commit',
      executionPhase: 'plan_finalize',
      identity: { taskId, templateSnapshotHash: this.deps.snapshotHash, workItemId, attemptId: null, commandId },
      coreRef: finalizeCoreRef,
      selectedTargetRefs: [],
      registrations: this.deps.registrationsFor('content_commit', 'plan_finalize'),
      universe: {
        slotIds: [...resolvedVersions.keys()],
        relationIds: [],
        mapNodeIds: [],
        artifactDigest: null,
      },
      slotTypes: this.deps.slotTypes,
      context: { requiredSlotIds: [...requiredSlotIds] },
      profile: this.deps.profileBody,
    });
    return { run, store };
  }

  private async persistEngineOutputs(
    taskId: string,
    run: TriggerExecutionResult,
    store: ContentPlanMemoryBlobStore,
  ): Promise<void> {
    void store;
    await this.deps.facade.prepareBlob(taskId, 'validator_input_envelope', run.envelope);
    await this.deps.facade.prepareBlob(taskId, 'validator_aggregate', run.aggregate);
    await this.deps.facade.prepareBlob(taskId, 'validation_warning_root', run.warningRoot);
    for (const receipt of run.receipts) {
      await this.deps.facade.prepareBlob(taskId, 'validation_receipt', receipt);
    }
    for (const failure of run.failures) {
      await this.deps.facade.prepareBlob(taskId, 'validator_failure', failure);
    }
  }

  /** Blocking finalizer: receipt + ONE successor GenerationPlan + successor
   * generation-batch WorkItem + the §9.2 terminal pair, in ONE batch. */
  private async publishBlockingSuccessor(
    input: { taskId: string; commandId: string; workItemId: string; commandKind: 'generation_finalize'; leaseEpoch: number; authorityBaseRef: BlobRefV2; payloadRef: BlobRefV2 },
    plan: GenerationPlanSpecV2,
    provisional: ContentRevisionManifestV2,
    base: { mapRef: BlobRefV2; contentRevisionManifestRef: BlobRefV2; planSpecRef: BlobRefV2 },
    run: TriggerExecutionResult,
  ): Promise<readonly BlobRefV2[]> {
    const { taskId } = input;
    const receipt = run.receipts[0];
    if (receipt === undefined) throw new ContentPlanError('RECEIPT_MISSING', 'blocking finalizer produced no receipt');
    const receiptRef = await this.deps.facade.prepareBlob(taskId, 'validation_receipt', receipt);

    // Deterministic correction slots: the union of the blocker issues' repair
    // slot targets + slot locations (sorted by the plan's document order).
    const planSlots = new Map<string, number>();
    let order = 0;
    for (const batch of plan.orderedBatchSlotIds) {
      for (const slotId of batch) {
        if (!planSlots.has(slotId)) planSlots.set(slotId, order++);
      }
    }
    const correctionSet = new Set<string>();
    for (const issue of receipt.blockerIssues) {
      for (const slotId of issue.repairTargets.slotIds) correctionSet.add(slotId);
      if (issue.location.targetKind === 'slot') correctionSet.add(issue.location.stableTargetId);
    }
    // F5 (adversarial review): correction scope is derived ONLY from plan slots.
    // The finalize validator's universe is exactly the plan's slots, so any
    // blocker naming a non-plan slot is a system invariant violation — fail
    // closed rather than folding an out-of-scope slot into a correction batch.
    const unknownTargets = [...correctionSet].filter((slotId) => !planSlots.has(slotId));
    if (unknownTargets.length > 0) {
      throw new ContentPlanError('CORRECTION_SCOPE_INVALID', `blocker issues name slots outside the plan: ${unknownTargets.join(', ')}`);
    }
    // The coverage validator's required-not-set issues name the missing slot.
    const correctionSlotIds = [...correctionSet].sort((a, b) => (planSlots.get(a) ?? 0) - (planSlots.get(b) ?? 0) || (a < b ? -1 : 1));
    if (correctionSlotIds.length === 0) {
      throw new ContentPlanError('CORRECTION_SCOPE_EMPTY', 'blocking finalizer produced no correction slots');
    }

    // F4 (adversarial review): the successor revision is the superseded plan's
    // revision + 1 (first blocking successor = revision 2; a second blocking of
    // the successor derives revision 3). The carrier threads it so the
    // `generation_finalize` rebuild stays deterministic.
    const successorRevision = plan.revision + 1;
    const successorPlanId = successorGenerationPlanId(plan.generationPlanId, successorRevision);
    const successorPlan = buildSuccessorGenerationPlan({
      generationPlanId: successorPlanId,
      revision: successorRevision,
      supersedesGenerationPlanId: plan.generationPlanId,
      sourceValidationReceiptRef: receiptRef,
      activeMapRef: base.mapRef,
      importedContentManifestRef: base.contentRevisionManifestRef,
      correctionSlotIds,
      correctionSlotsWithOrder: correctionSlotIds.map((slotId) => ({ slotId, documentOrder: planSlots.get(slotId) ?? 0 })),
      reviewPolicy: this.deps.reviewPolicy,
    });
    const successorPlanRef = await this.deps.facade.prepareBlob(taskId, 'generation_plan_spec', successorPlan);

    // Successor generation-batch WorkItem (first correction batch).
    const successorWorkItemId = generationBatchWorkItemId(taskId, successorPlanId, 1);
    const firstBatchSlotIds = successorPlan.orderedBatchSlotIds[0] ?? [];
    const authorityBase = buildAuthorityBaseSet({
      taskId,
      templateSnapshotRef: this.deps.templateSnapshotRef,
      profileSnapshotRef: this.deps.profileSnapshotRef,
      refs: { mapRef: base.mapRef, contentRevisionManifestRef: base.contentRevisionManifestRef, planSpecRef: successorPlanRef },
      kind: 'agent_assignment',
      agentExecutionKind: 'structured_session',
      sessionKind: 'generation_batch',
    });
    const authorityBaseRef = await this.deps.facade.prepareBlob(taskId, 'authority_base_set', authorityBase);
    const grantBody = {
      grantSpecId: `gs-${successorWorkItemId}`,
      workItemId: successorWorkItemId,
      kind: 'initial_generation_batch' as const,
      snapshotHash: this.deps.snapshotHash,
      authorityBaseRef,
      generationPlanSpecRef: successorPlanRef,
      activeMapRef: base.mapRef,
      expectedContentRevisionManifestRef: base.contentRevisionManifestRef,
      writeSlotIds: firstBatchSlotIds,
      readScope: { maxContextBytes: this.deps.profile.assignmentMaxTotalObjects },
    };
    const grantSpec = { ...grantBody, specDigest: canonicalJsonSha256(grantBody) };
    const grantSpecRef = await this.deps.facade.prepareBlob(taskId, 'write_grant_spec', grantSpec);
    const maxAutomaticRetries = await this.deps.defaultAutomaticRetries();
    const successor: SuccessorWorkItemCarrierV2 = {
      workItemId: successorWorkItemId,
      kind: 'agent_assignment',
      roleBinding: this.deps.generatorRoleBinding,
      agentExecutionKind: 'structured_session',
      sessionKind: 'generation_batch',
      roundId: null,
      logicalAssignmentId: `la-${successorWorkItemId}`,
      reviewAssignmentId: null,
      grantSpecRef,
      inputArtifactDeliveryId: null,
      authorityBaseRef,
      payloadRef: successorPlanRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries,
    };
    const carryErrors = validateSuccessorCarrier(successor);
    if (carryErrors.length > 0) throw new ContentPlanError('INVALID_INPUT', `successor carry invalid: ${carryErrors.join('; ')}`);

    const terminal: SystemCommandTerminalCarrierV2 = {
      workItemId: input.workItemId,
      commandId: input.commandId,
      commandKind: input.commandKind,
      leaseEpoch: input.leaseEpoch,
      authorityBaseRef: input.authorityBaseRef,
    };
    const operationId = contentFinalizeOperationId(taskId, input.workItemId, input.commandId);
    const blobRefs = [receiptRef, successorPlanRef, authorityBaseRef, grantSpecRef];
    await this.publish(taskId, {
      operationId,
      publishKind: 'generation_finalize',
      blobRefs,
      carriers: contentPlanCarrier({
        generationPlanId: plan.generationPlanId,
        generationPlanRevision: plan.revision,
        supersedesGenerationPlanId: plan.supersedesGenerationPlanId,
        generationPlanSpecRef: base.planSpecRef,
        sourceValidationReceiptRef: plan.sourceValidationReceiptRef,
        validatorAggregateRef: run.aggregateRef,
        validationReceiptRef: receiptRef,
        successorPlanRevision: successorRevision,
        successorPlanRef,
        successor,
        terminal,
      }),
      preparedRefs: blobRefs,
    });
    return [...blobRefs, refOfBlob('validation_receipt', receipt)];
  }

  /** The next batch's WorkItem/grant/base OR the `system_generation_finalize`
   * WorkItem. Returns the prepared authority base + grant spec + carrier. */
  private async prepareBatchSuccessor(input: {
    taskId: string;
    plan: ResolvedPlanSpecV2;
    batchOrdinal: number;
    nextWorkItemId: string;
    isLast: boolean;
    provisionalRef: BlobRefV2;
    mapSemanticDigest: string;
  }): Promise<{ authorityBaseRef: BlobRefV2; grantSpecRef: BlobRefV2 | null; carrier: SuccessorWorkItemCarrierV2 }> {
    const { taskId, plan, nextWorkItemId, isLast, provisionalRef } = input;
    const planSpecRef = plan.specRef;
    const activeMapRef = plan.activeMapRef;
    const maxAutomaticRetries = await this.deps.defaultAutomaticRetries();
    if (isLast) {
      const authorityBase = buildAuthorityBaseSet({
        taskId,
        templateSnapshotRef: this.deps.templateSnapshotRef,
        profileSnapshotRef: this.deps.profileSnapshotRef,
        refs: { mapRef: activeMapRef, contentRevisionManifestRef: provisionalRef, planSpecRef },
        kind: 'system_generation_finalize',
      });
      const authorityBaseRef = await this.deps.facade.prepareBlob(taskId, 'authority_base_set', authorityBase);
      const carrier: SuccessorWorkItemCarrierV2 = {
        workItemId: nextWorkItemId,
        kind: 'system_generation_finalize',
        roleBinding: null,
        agentExecutionKind: null,
        sessionKind: null,
        roundId: null,
        logicalAssignmentId: null,
        reviewAssignmentId: null,
        grantSpecRef: null,
        inputArtifactDeliveryId: null,
        authorityBaseRef,
        payloadRef: provisionalRef,
        initialLeaseEpoch: 0,
        maxAutomaticRetries,
      };
      return { authorityBaseRef, grantSpecRef: null, carrier };
    }
    const nextBatchSlotIds = plan.orderedBatchSlotIds[input.batchOrdinal] ?? [];
    const authorityBase = buildAuthorityBaseSet({
      taskId,
      templateSnapshotRef: this.deps.templateSnapshotRef,
      profileSnapshotRef: this.deps.profileSnapshotRef,
      refs: { mapRef: activeMapRef, contentRevisionManifestRef: provisionalRef, planSpecRef },
      kind: 'agent_assignment',
      agentExecutionKind: 'structured_session',
      sessionKind: 'generation_batch',
    });
    const authorityBaseRef = await this.deps.facade.prepareBlob(taskId, 'authority_base_set', authorityBase);
    const grantBody = {
      grantSpecId: `gs-${nextWorkItemId}`,
      workItemId: nextWorkItemId,
      kind: 'initial_generation_batch' as const,
      snapshotHash: this.deps.snapshotHash,
      authorityBaseRef,
      generationPlanSpecRef: planSpecRef,
      activeMapRef,
      expectedContentRevisionManifestRef: provisionalRef,
      writeSlotIds: nextBatchSlotIds,
      readScope: { maxContextBytes: this.deps.profile.assignmentMaxTotalObjects },
    };
    const grantSpec = { ...grantBody, specDigest: canonicalJsonSha256(grantBody) };
    const grantSpecRef = await this.deps.facade.prepareBlob(taskId, 'write_grant_spec', grantSpec);
    const carrier: SuccessorWorkItemCarrierV2 = {
      workItemId: nextWorkItemId,
      kind: 'agent_assignment',
      roleBinding: this.deps.generatorRoleBinding,
      agentExecutionKind: 'structured_session',
      sessionKind: 'generation_batch',
      roundId: null,
      logicalAssignmentId: `la-${nextWorkItemId}`,
      reviewAssignmentId: null,
      grantSpecRef,
      inputArtifactDeliveryId: null,
      authorityBaseRef,
      payloadRef: planSpecRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries,
    };
    return { authorityBaseRef, grantSpecRef, carrier };
  }

  /** Content-review planning on finalizer clear: the round-planned event
   * carrier + the content review WorkItems (batch + whole) with review_observation
   * grant specs. Task 18 consumes the round + these WorkItems. */
  private async prepareContentReviewPlanning(
    input: { taskId: string; authorityBaseRef: BlobRefV2 },
    finalizedRef: BlobRefV2,
    setSlotIds: readonly string[],
  ): Promise<{
    round: ContentReviewRoundPlanCarrierV2;
    adoptionRootRef: BlobRefV2;
    coverageCoreRef: BlobRefV2;
    reviewWorkItems: readonly SuccessorWorkItemCarrierV2[];
    workItemRefs: readonly BlobRefV2[];
    preparedRefs: readonly BlobRefV2[];
  }> {
    const { taskId } = input;
    const roundId = contentReviewRoundId(taskId, 1, finalizedRef);
    const coverageSlotCount = setSlotIds.length;
    const batchSize = Math.max(1, this.deps.reviewPolicy.contentBatchTargetSlots);
    const assignmentCount = Math.max(1, Math.ceil(coverageSlotCount / batchSize));
    const adoptionRoot = buildEmptyAdoptionRoot(roundId);
    const adoptionRootRef = await this.deps.facade.prepareBlob(taskId, 'review_adoption_root', adoptionRoot);
    const mapRef = (await this.readCurrentMapRef(taskId)) ?? finalizedRef;
    const state = await this.deps.readProjection(taskId);
    const mapSemanticDigest = state.currentMap === null ? '' : (await this.readMapSemanticDigest(taskId, state.currentMap.mapSnapshotRef));
    const round: ContentReviewRoundPlanCarrierV2 = {
      reviewRoundId: roundId,
      contentCycleOrdinal: 1,
      mapRef,
      mapSemanticDigest,
      contentRevisionManifestRef: finalizedRef,
      reviewPolicyDigest: this.deps.reviewPolicyDigest,
      adoptionRootRef,
      coverageSlotCount,
      coverageRelationCount: 0,
      assignmentCount,
      verificationFindingCount: 0,
      consumedOverrideRef: null,
    };
    // Planned coverage core (empty ledger roots — the workitem matrix binds it
    // before any ledger exists; Task 18 computes the FINAL coverage core).
    const coverageCoreBody = {
      reviewRoundId: roundId,
      mapRef,
      contentRevisionManifestRef: finalizedRef,
      reviewPolicyDigest: this.deps.reviewPolicyDigest,
      coverageLedgerRootRefs: [] as readonly BlobRefV2[],
      adoptionRootRef,
      wholeTreeObservationRootRefs: [] as readonly BlobRefV2[],
      findingStageRootRef: refOfBlob('finding_stage_root', { rootId: `fsr-${roundId}`, roundId, entries: [] }),
    };
    const coverageCore = { ...coverageCoreBody, coreDigest: canonicalJsonSha256(coverageCoreBody) };
    const coverageCoreRef = await this.deps.facade.prepareBlob(taskId, 'content_review_coverage_core', coverageCore);
    const preparedRefs: BlobRefV2[] = [adoptionRootRef, coverageCoreRef];
    const reviewWorkItems: SuccessorWorkItemCarrierV2[] = [];
    const workItemRefs: BlobRefV2[] = [];
    const maxAutomaticRetries = await this.deps.defaultAutomaticRetries();
    for (let index = 0; index < assignmentCount; index++) {
      const workItemId = reviewBatchWorkItemId(roundId, index);
      const reviewAssignmentId = reviewAssignmentIdOf(roundId, index);
      const authorityBase = buildAuthorityBaseSet({
        taskId,
        templateSnapshotRef: this.deps.templateSnapshotRef,
        profileSnapshotRef: this.deps.profileSnapshotRef,
        refs: { mapRef, contentRevisionManifestRef: finalizedRef, reviewCoverageCoreRef: coverageCoreRef, reviewRoundRef: refOfBlob('content_review_coverage_core', coverageCore) },
        kind: 'agent_assignment',
        agentExecutionKind: 'structured_session',
        sessionKind: 'review_content_batch',
      });
      const authorityBaseRef = await this.deps.facade.prepareBlob(taskId, 'authority_base_set', authorityBase);
      const grant = buildReviewObservationGrantSpec({
        grantSpecId: `gs-${workItemId}`,
        workItemId,
        authorityBaseRef,
        sessionKind: 'review_content_batch',
        reviewAssignmentId,
        roundId,
        roundKind: 'content',
        snapshotHash: this.deps.snapshotHash,
        maxContextBytes: this.deps.profile.assignmentMaxTotalObjects,
      });
      const grantSpecRef = await this.deps.facade.prepareBlob(taskId, 'write_grant_spec', grant);
      const carrier: SuccessorWorkItemCarrierV2 = {
        workItemId,
        kind: 'agent_assignment',
        roleBinding: this.deps.reviewerRoleBinding,
        agentExecutionKind: 'structured_session',
        sessionKind: 'review_content_batch',
        roundId,
        logicalAssignmentId: `la-${workItemId}`,
        reviewAssignmentId,
        grantSpecRef,
        inputArtifactDeliveryId: null,
        authorityBaseRef,
        payloadRef: coverageCoreRef,
        initialLeaseEpoch: 0,
        maxAutomaticRetries,
      };
      reviewWorkItems.push(carrier);
      workItemRefs.push(authorityBaseRef, grantSpecRef);
      preparedRefs.push(authorityBaseRef, grantSpecRef);
    }
    const wholeWorkItemId = reviewWholeWorkItemId(roundId);
    const wholeAssignmentId = reviewWholeAssignmentId(roundId);
    const wholeBase = buildAuthorityBaseSet({
      taskId,
      templateSnapshotRef: this.deps.templateSnapshotRef,
      profileSnapshotRef: this.deps.profileSnapshotRef,
      refs: { mapRef, contentRevisionManifestRef: finalizedRef, reviewCoverageCoreRef: coverageCoreRef, reviewRoundRef: refOfBlob('content_review_coverage_core', coverageCore) },
      kind: 'agent_assignment',
      agentExecutionKind: 'structured_session',
      sessionKind: 'review_content_whole',
    });
    const wholeBaseRef = await this.deps.facade.prepareBlob(taskId, 'authority_base_set', wholeBase);
    const wholeGrant = buildReviewObservationGrantSpec({
      grantSpecId: `gs-${wholeWorkItemId}`,
      workItemId: wholeWorkItemId,
      authorityBaseRef: wholeBaseRef,
      sessionKind: 'review_content_whole',
      reviewAssignmentId: wholeAssignmentId,
      roundId,
      roundKind: 'content',
      snapshotHash: this.deps.snapshotHash,
      maxContextBytes: this.deps.profile.assignmentMaxTotalObjects,
    });
    const wholeGrantRef = await this.deps.facade.prepareBlob(taskId, 'write_grant_spec', wholeGrant);
    const wholeCarrier: SuccessorWorkItemCarrierV2 = {
      workItemId: wholeWorkItemId,
      kind: 'agent_assignment',
      roleBinding: this.deps.reviewerRoleBinding,
      agentExecutionKind: 'structured_session',
      sessionKind: 'review_content_whole',
      roundId,
      logicalAssignmentId: `la-${wholeWorkItemId}`,
      reviewAssignmentId: wholeAssignmentId,
      grantSpecRef: wholeGrantRef,
      inputArtifactDeliveryId: null,
      authorityBaseRef: wholeBaseRef,
      payloadRef: coverageCoreRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries,
    };
    reviewWorkItems.push(wholeCarrier);
    workItemRefs.push(wholeBaseRef, wholeGrantRef);
    preparedRefs.push(wholeBaseRef, wholeGrantRef);
    for (const carrier of reviewWorkItems) {
      const errors = validateSuccessorCarrier(carrier);
      if (errors.length > 0) throw new ContentPlanError('INVALID_INPUT', `content review successor carry invalid: ${errors.join('; ')}`);
    }
    return { round, adoptionRootRef, coverageCoreRef, reviewWorkItems, workItemRefs, preparedRefs };
  }

  private async readPlanForWorkItem(taskId: string, wi: { authorityBaseRef: BlobRefV2 }): Promise<ResolvedPlanSpecV2 | null> {
    const base = (await this.deps.resolver(taskId, wi.authorityBaseRef)) as { planSpecRef: BlobRefV2 | null } | null;
    if (base === null || typeof base !== 'object' || base.planSpecRef === null) return null;
    const plan = (await this.deps.resolver(taskId, base.planSpecRef)) as GenerationPlanSpecV2 | null;
    if (plan === null || typeof plan !== 'object') return null;
    return { ...plan, specRef: base.planSpecRef };
  }

  private async resolveVersion(taskId: string, versionRef: BlobRefV2): Promise<SlotContentVersionV2 | null> {
    const version = (await this.deps.resolver(taskId, versionRef)) as SlotContentVersionV2 | null;
    if (version === null || typeof version !== 'object') return null;
    return version;
  }

  private requiredSlotOf(slotId: string): boolean {
    const type = this.deps.slotTypes.find((t) => t.id === this.deps.slotTypeOf(slotId));
    return type?.contentPresence === 'required';
  }

  private async readCurrentMapRef(taskId: string): Promise<BlobRefV2 | null> {
    const state = await this.deps.readProjection(taskId);
    return state.currentMap === null ? null : state.currentMap.mapSnapshotRef;
  }

  private async readMapSemanticDigest(taskId: string, mapSnapshotRef: BlobRefV2): Promise<string> {
    const snapshot = (await this.deps.resolver(taskId, mapSnapshotRef)) as { mapSemanticDigest?: string } | null;
    return snapshot !== null && typeof snapshot === 'object' && typeof snapshot.mapSemanticDigest === 'string' ? snapshot.mapSemanticDigest : '';
  }

  /** One content-plan publication through the facade. */
  private async publish(taskId: string, input: {
    operationId: string;
    publishKind: 'content_revision_commit' | 'content_plan_finalize' | 'generation_finalize';
    blobRefs: readonly BlobRefV2[];
    carriers: ContentPlanPublishCarriersV2;
    preparedRefs: readonly BlobRefV2[];
  }): Promise<void> {
    const tail = await this.deps.tail(taskId);
    await this.deps.facade.publishWithPin({
      taskId,
      operationId: input.operationId,
      payload: {
        family: 'domain_publish',
        operationId: input.operationId,
        taskId,
        publishKind: input.publishKind,
        blobRefs: input.blobRefs,
        expectedResultIdentity: canonicalJsonSha256({ operationId: input.operationId, publishKind: input.publishKind }),
        mapBuild: null,
        mapReview: null,
        contentPlan: input.carriers,
      },
      intent: { handlerKind: input.publishKind, handlerVersion: 1 },
      preparedRefs: input.preparedRefs,
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Generator tool handlers (wired into the V2ToolFactory domain seam)  */
/* ------------------------------------------------------------------ */

/**
 * Task 17 wiring: the `write_slot_content` + `submit_content_draft` domain
 * handlers the tool-factory's `V2DomainHandlers` seam consumes (spec §11.2).
 * `write_slot_content` builds + prepares the canonical ContentValueV2 blob
 * (the tool layer enforces the grant scope + the lower-bound profile cap; the
 * canonical byte cap is enforced here at blob creation — Task 13 M-c). The
 * journal persists the prepared ref. `submit_content_draft` resolves the batch
 * ordinal from the plan + grant, reads the journal's written values, and
 * delegates to the service's atomic batch commit.
 */
export function createContentPlanToolHandlers(deps: {
  service: ContentPlanService;
  grants: GrantService;
  privateStore: import('../../storage/authoritative-review-private-store').AuthoritativeReviewPrivateStore;
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown> | unknown;
  readProjection(taskId: string): Promise<AuthoritativeReviewProjectionV2>;
  facade: Pick<AuthoritativeAppendFacadeV2, 'prepareBlob'>;
  contentSchemaDigestOf(slotId: string): string;
}): import('./tool-factory').V2DomainHandlers {
  return {
    async writeSlotContent(ctx, params) {
      const slotId = String(params.slotId ?? '');
      const value = String(params.value ?? '');
      const mediaType = params.mediaType === 'text/plain' ? 'text/plain' : 'text/markdown';
      const state = await deps.readProjection(ctx.taskId);
      if (state.currentManifest === null) throw new ContentPlanError('MANIFEST_UNRESOLVED', 'no current manifest');
      const valueBlob = buildContentValue({
        slotId,
        contentSchemaDigest: deps.contentSchemaDigestOf(slotId),
        taskContentRevision: state.currentManifest.taskContentRevision + 1,
        mediaType,
        text: value,
      });
      const contentValueRef = await deps.facade.prepareBlob(ctx.taskId, 'content_value', valueBlob);
      return { slotId, contentValueRef };
    },
    async submitContentDraft(ctx, params) {
      const state = await deps.readProjection(ctx.taskId);
      const wi = state.workItems[ctx.workItemId];
      if (wi === undefined) throw new ContentPlanError('WORK_ITEM_NOT_FOUND', `no workitem '${ctx.workItemId}'`);
      const grant = await deps.grants.resolveAttemptGrant(ctx);
      const writeSlotIds = [...grantSpecWriteSlotIds(grant.spec)];
      const base = (await deps.resolver(ctx.taskId, wi.authorityBaseRef)) as { planSpecRef: BlobRefV2 | null } | null;
      if (base === null || typeof base !== 'object' || base.planSpecRef === null) throw new ContentPlanError('PLAN_UNKNOWN', 'no plan in the workitem base');
      const plan = (await deps.resolver(ctx.taskId, base.planSpecRef)) as GenerationPlanSpecV2 | null;
      if (plan === null || typeof plan !== 'object') throw new ContentPlanError('PLAN_UNRESOLVED', 'plan spec unresolvable');
      const batchOrdinal = plan.orderedBatchSlotIds.findIndex((batch) => {
        const batchSet = [...batch].sort();
        const writeSet = [...writeSlotIds].sort();
        return batchSet.length === writeSet.length && batchSet.every((id, i) => id === writeSet[i]);
      });
      if (batchOrdinal < 0) throw new ContentPlanError('GRANT_STALE', 'grant writeSlotIds do not match any plan batch');
      const journal = {
        workItemId: ctx.workItemId,
        leaseEpoch: ctx.leaseEpoch,
        attemptId: ctx.attemptId,
        authorityBaseRef: grant.authorityBaseRef,
        grantSpecRef: grant.specRef,
      };
      const view = await deps.privateStore.readAllReviewDraft(journal);
      const slotContents: Record<string, { text: string; mediaType: 'text/markdown' | 'text/plain' }> = {};
      for (const entry of view.committed) {
        if (entry.op !== 'write_slot_content') continue;
        const result = entry.result as { slotId?: string; contentValueRef?: BlobRefV2 } | null;
        if (result === null || typeof result !== 'object' || typeof result.slotId !== 'string') continue;
        const valueBlob = (await deps.resolver(ctx.taskId, result.contentValueRef as BlobRefV2)) as ContentValueV2 | null;
        if (valueBlob === null || typeof valueBlob !== 'object') continue;
        slotContents[result.slotId] = { text: valueBlob.text, mediaType: valueBlob.mediaType };
      }
      const outcome = await deps.service.commitGenerationBatch({
        taskId: ctx.taskId,
        workItemId: ctx.workItemId,
        attemptId: ctx.attemptId,
        batchOrdinal: batchOrdinal + 1,
        ctx,
        slotContents,
      });
      if (outcome.kind === 'committed') {
        return { committed: true, manifestRef: outcome.manifestRef, nextWorkItemId: outcome.nextWorkItemId };
      }
      if (outcome.kind === 'blocked') {
        return { committed: false, failureCode: outcome.failureCode };
      }
      return { committed: false, failureCode: outcome.failureCode };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Carrier factory + helpers                                           */
/* ------------------------------------------------------------------ */

export function contentPlanCarrier(carriers: Partial<ContentPlanPublishCarriersV2> = {}): ContentPlanPublishCarriersV2 {
  return {
    generationPlanId: null,
    generationPlanRevision: null,
    supersedesGenerationPlanId: null,
    generationPlanSpecRef: null,
    sourceValidationReceiptRef: null,
    planStarted: null,
    batchOrdinal: null,
    contentRevisionCommitCoreRef: null,
    validatorAggregateRef: null,
    contentRevisionManifestRef: null,
    taskContentRevision: null,
    manifestPhase: null,
    producerPlanSpecRef: null,
    priorManifestRef: null,
    successor: null,
    finalizerWarningRootRef: null,
    reviewRound: null,
    reviewWorkItems: null,
    validationReceiptRef: null,
    successorPlanRevision: null,
    successorPlanRef: null,
    terminal: null,
    ...carriers,
  };
}

/* ------------------------------------------------------------------ */
/* Publication handler registration (deterministic §9.2 rebuilds)      */
/* ------------------------------------------------------------------ */

function need<T>(value: T | null | undefined, name: string): asserts value is T {
  if (value === null || value === undefined) throw new NotRebuildableError('content-plan', [name]);
}

function asDomain(payload: { family: string }): Extract<PublicationOperationPayloadV2, { family: 'domain_publish' }> {
  if (payload.family !== 'domain_publish') {
    throw new NotRebuildableError('content-plan', [`payload family '${payload.family}' is not domain_publish`]);
  }
  return payload as Extract<PublicationOperationPayloadV2, { family: 'domain_publish' }>;
}

function parseDomainPublishPayload(value: unknown): PublicationOperationPayloadV2 {
  return parsePublicationOperationPayload(value);
}

function sha256Of(events: readonly PublicationEventEnvelopeV2[]): string {
  return canonicalJsonSha256(events);
}

/** Registers the three Task 17 content-plan publication handlers. */
export function registerContentPlanPublicationHandlers(registry: PublicationIntentRegistry): void {
  registerContentRevisionCommit(registry);
  registerContentPlanFinalize(registry);
  registerGenerationFinalize(registry);
}

function registerContentRevisionCommit(registry: PublicationIntentRegistry): void {
  if (registry.resolve('content_revision_commit', 1) !== null) return;
  registry.register({
    handlerKind: 'content_revision_commit',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: [
      'structured_generation_plan_started',
      'structured_generation_batch_committed',
      'structured_content_revision_committed',
      'structured_work_item_created',
    ],
    rebuildable: true,
    missingInputs: [],
    parsePayload: parseDomainPublishPayload,
    childRefsOf: (p) => (p.family === 'domain_publish' ? [...p.blobRefs] : []),
    resolveRefs: (p) => {
      if (p.family !== 'domain_publish') return [];
      const out: PublicationIntentResolvedRef[] = [];
      const cp = p.contentPlan;
      if (cp !== null && cp.contentRevisionManifestRef !== null) out.push({ key: 'manifest', ref: cp.contentRevisionManifestRef });
      return out;
    },
    buildEvents: (payload, at, refs) => {
      const p = asDomain(payload);
      const cp = p.contentPlan;
      need(cp, 'contentPlan');
      need(cp.generationPlanId, 'generationPlanId');
      need(cp.batchOrdinal, 'batchOrdinal');
      need(cp.contentRevisionCommitCoreRef, 'contentRevisionCommitCoreRef');
      need(cp.validatorAggregateRef, 'validatorAggregateRef');
      need(cp.taskContentRevision, 'taskContentRevision');
      need(cp.manifestPhase, 'manifestPhase');
      need(cp.producerPlanSpecRef, 'producerPlanSpecRef');
      need(cp.priorManifestRef, 'priorManifestRef');
      const manifestRef = cp.contentRevisionManifestRef ?? refs?.get('manifest');
      if (manifestRef === null || manifestRef === undefined) throw new NotRebuildableError('content_revision_commit', ['contentRevisionManifestRef']);
      const envelopes: PublicationEventEnvelopeV2[] = [];
      if (cp.planStarted === true) {
        need(cp.generationPlanRevision, 'generationPlanRevision');
        need(cp.generationPlanSpecRef, 'generationPlanSpecRef');
        envelopes.push({
          protocolVersion: 2,
          at,
          type: 'structured_generation_plan_started',
          generationPlanId: cp.generationPlanId,
          revision: cp.generationPlanRevision,
          supersedesGenerationPlanId: cp.supersedesGenerationPlanId,
          generationPlanSpecRef: cp.generationPlanSpecRef,
          sourceValidationReceiptRef: cp.sourceValidationReceiptRef,
        });
      }
      envelopes.push(
        {
          protocolVersion: 2,
          at,
          type: 'structured_generation_batch_committed',
          generationPlanId: cp.generationPlanId,
          batchOrdinal: cp.batchOrdinal,
          contentRevisionCommitCoreRef: cp.contentRevisionCommitCoreRef,
          validatorAggregateRef: cp.validatorAggregateRef,
          contentRevisionManifestRef: manifestRef as BlobRefV2,
        },
        {
          protocolVersion: 2,
          at,
          type: 'structured_content_revision_committed',
          contentRevisionManifestRef: manifestRef as BlobRefV2,
          taskContentRevision: cp.taskContentRevision,
          manifestPhase: cp.manifestPhase,
          producerPlanSpecRef: cp.producerPlanSpecRef,
          priorManifestRef: cp.priorManifestRef,
        },
      );
      const s = cp.successor;
      if (s !== null) {
        envelopes.push({
          protocolVersion: 2,
          at,
          type: 'structured_work_item_created',
          workItemId: s.workItemId,
          kind: s.kind,
          roleBinding: s.roleBinding,
          agentExecutionKind: s.agentExecutionKind,
          sessionKind: s.sessionKind,
          roundId: s.roundId,
          logicalAssignmentId: s.logicalAssignmentId,
          reviewAssignmentId: s.reviewAssignmentId,
          grantSpecRef: s.grantSpecRef,
          inputArtifactDeliveryId: s.inputArtifactDeliveryId,
          authorityBaseRef: s.authorityBaseRef,
          payloadRef: s.payloadRef,
          initialLeaseEpoch: s.initialLeaseEpoch,
          maxAutomaticRetries: s.maxAutomaticRetries,
        });
      }
      return envelopes;
    },
    expectedResultIdentity: (_payload, events) => sha256Of(events),
  });
}

function registerContentPlanFinalize(registry: PublicationIntentRegistry): void {
  if (registry.resolve('content_plan_finalize', 1) !== null) return;
  registry.register({
    handlerKind: 'content_plan_finalize',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: [
      'structured_content_revision_committed',
      'structured_generation_plan_completed',
      'structured_review_round_planned',
      'structured_work_item_created',
      'structured_system_command_completed',
      'structured_work_item_completed',
    ],
    rebuildable: true,
    missingInputs: [],
    parsePayload: parseDomainPublishPayload,
    childRefsOf: (p) => (p.family === 'domain_publish' ? [...p.blobRefs] : []),
    resolveRefs: (p) => {
      if (p.family !== 'domain_publish') return [];
      const out: PublicationIntentResolvedRef[] = [];
      const cp = p.contentPlan;
      if (cp !== null && cp.contentRevisionManifestRef !== null) out.push({ key: 'manifest', ref: cp.contentRevisionManifestRef });
      return out;
    },
    buildEvents: (payload, at, refs) => {
      const p = asDomain(payload);
      const cp = p.contentPlan;
      need(cp, 'contentPlan');
      need(cp.generationPlanId, 'generationPlanId');
      need(cp.contentRevisionManifestRef, 'contentRevisionManifestRef');
      need(cp.taskContentRevision, 'taskContentRevision');
      need(cp.manifestPhase, 'manifestPhase');
      need(cp.producerPlanSpecRef, 'producerPlanSpecRef');
      need(cp.priorManifestRef, 'priorManifestRef');
      need(cp.validatorAggregateRef, 'validatorAggregateRef');
      need(cp.terminal, 'terminal');
      const manifestRef = cp.contentRevisionManifestRef ?? refs?.get('manifest');
      if (manifestRef === null || manifestRef === undefined) throw new NotRebuildableError('content_plan_finalize', ['contentRevisionManifestRef']);
      const t = cp.terminal;
      const envelopes: PublicationEventEnvelopeV2[] = [
        {
          protocolVersion: 2,
          at,
          type: 'structured_content_revision_committed',
          contentRevisionManifestRef: manifestRef as BlobRefV2,
          taskContentRevision: cp.taskContentRevision,
          manifestPhase: cp.manifestPhase,
          producerPlanSpecRef: cp.producerPlanSpecRef,
          priorManifestRef: cp.priorManifestRef,
        },
        {
          protocolVersion: 2,
          at,
          type: 'structured_generation_plan_completed',
          generationPlanId: cp.generationPlanId,
          contentRevisionManifestRef: manifestRef as BlobRefV2,
          validatorAggregateRef: cp.validatorAggregateRef,
          warningRootRef: cp.finalizerWarningRootRef,
        },
      ];
      const rr = cp.reviewRound;
      if (rr !== null) {
        envelopes.push({
          protocolVersion: 2,
          at,
          type: 'structured_review_round_planned',
          reviewRoundId: rr.reviewRoundId,
          contentCycleOrdinal: rr.contentCycleOrdinal,
          mapRef: rr.mapRef,
          mapSemanticDigest: rr.mapSemanticDigest,
          contentRevisionManifestRef: rr.contentRevisionManifestRef,
          reviewPolicyDigest: rr.reviewPolicyDigest,
          adoptionRootRef: rr.adoptionRootRef,
          coverageSlotCount: rr.coverageSlotCount,
          coverageRelationCount: rr.coverageRelationCount,
          assignmentCount: rr.assignmentCount,
          verificationFindingCount: rr.verificationFindingCount,
          consumedOverrideRef: rr.consumedOverrideRef,
        });
      }
      if (cp.reviewWorkItems !== null) {
        for (const s of cp.reviewWorkItems) {
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_work_item_created',
            workItemId: s.workItemId,
            kind: s.kind,
            roleBinding: s.roleBinding,
            agentExecutionKind: s.agentExecutionKind,
            sessionKind: s.sessionKind,
            roundId: s.roundId,
            logicalAssignmentId: s.logicalAssignmentId,
            reviewAssignmentId: s.reviewAssignmentId,
            grantSpecRef: s.grantSpecRef,
            inputArtifactDeliveryId: s.inputArtifactDeliveryId,
            authorityBaseRef: s.authorityBaseRef,
            payloadRef: s.payloadRef,
            initialLeaseEpoch: s.initialLeaseEpoch,
            maxAutomaticRetries: s.maxAutomaticRetries,
          });
        }
      }
      envelopes.push(
        {
          protocolVersion: 2,
          at,
          type: 'structured_system_command_completed',
          commandId: t.commandId,
          workItemId: t.workItemId,
          commandKind: t.commandKind,
          leaseEpoch: t.leaseEpoch,
          authorityBaseRef: t.authorityBaseRef,
        },
        {
          protocolVersion: 2,
          at,
          type: 'structured_work_item_completed',
          workItemId: t.workItemId,
          leaseEpoch: t.leaseEpoch,
          authorityBaseRef: t.authorityBaseRef,
        },
      );
      return envelopes;
    },
    expectedResultIdentity: (_payload, events) => sha256Of(events),
  });
}

function registerGenerationFinalize(registry: PublicationIntentRegistry): void {
  if (registry.resolve('generation_finalize', 1) !== null) return;
  registry.register({
    handlerKind: 'generation_finalize',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: [
      'structured_generation_plan_rejected',
      'structured_generation_plan_started',
      'structured_work_item_created',
      'structured_system_command_completed',
      'structured_work_item_completed',
    ],
    rebuildable: true,
    missingInputs: [],
    parsePayload: parseDomainPublishPayload,
    childRefsOf: (p) => (p.family === 'domain_publish' ? [...p.blobRefs] : []),
    resolveRefs: () => [],
    buildEvents: (payload, at) => {
      const p = asDomain(payload);
      const cp = p.contentPlan;
      need(cp, 'contentPlan');
      need(cp.generationPlanId, 'generationPlanId');
      need(cp.validatorAggregateRef, 'validatorAggregateRef');
      need(cp.validationReceiptRef, 'validationReceiptRef');
      need(cp.successorPlanRevision, 'successorPlanRevision');
      need(cp.successorPlanRef, 'successorPlanRef');
      need(cp.successor, 'successor');
      need(cp.terminal, 'terminal');
      const s = cp.successor;
      const t = cp.terminal;
      const envelopes: PublicationEventEnvelopeV2[] = [
        {
          protocolVersion: 2,
          at,
          type: 'structured_generation_plan_rejected',
          generationPlanId: cp.generationPlanId,
          validatorAggregateRef: cp.validatorAggregateRef,
          validationReceiptRef: cp.validationReceiptRef,
        },
        {
          protocolVersion: 2,
          at,
          type: 'structured_generation_plan_started',
          generationPlanId: successorGenerationPlanId(cp.generationPlanId, cp.successorPlanRevision as number),
          revision: cp.successorPlanRevision as number,
          supersedesGenerationPlanId: cp.generationPlanId,
          generationPlanSpecRef: cp.successorPlanRef,
          sourceValidationReceiptRef: cp.validationReceiptRef,
        },
        {
          protocolVersion: 2,
          at,
          type: 'structured_work_item_created',
          workItemId: s.workItemId,
          kind: s.kind,
          roleBinding: s.roleBinding,
          agentExecutionKind: s.agentExecutionKind,
          sessionKind: s.sessionKind,
          roundId: s.roundId,
          logicalAssignmentId: s.logicalAssignmentId,
          reviewAssignmentId: s.reviewAssignmentId,
          grantSpecRef: s.grantSpecRef,
          inputArtifactDeliveryId: s.inputArtifactDeliveryId,
          authorityBaseRef: s.authorityBaseRef,
          payloadRef: s.payloadRef,
          initialLeaseEpoch: s.initialLeaseEpoch,
          maxAutomaticRetries: s.maxAutomaticRetries,
        },
        {
          protocolVersion: 2,
          at,
          type: 'structured_system_command_completed',
          commandId: t.commandId,
          workItemId: t.workItemId,
          commandKind: t.commandKind,
          leaseEpoch: t.leaseEpoch,
          authorityBaseRef: t.authorityBaseRef,
        },
        {
          protocolVersion: 2,
          at,
          type: 'structured_work_item_completed',
          workItemId: t.workItemId,
          leaseEpoch: t.leaseEpoch,
          authorityBaseRef: t.authorityBaseRef,
        },
      ];
      return envelopes;
    },
    expectedResultIdentity: (_payload, events) => sha256Of(events),
  });
}

/* ------------------------------------------------------------------ */
/* Module-level runtime allowlist registration                         */
/* ------------------------------------------------------------------ */
export function createGenerationFinalizeSystemCommandHandler(service: ContentPlanService): SystemCommandHandler {
  return {
    commandKind: 'generation_finalize',
    async execute(ctx) {
      const outcome = await service.executeGenerationFinalize({
        taskId: ctx.taskId,
        commandId: ctx.commandId,
        workItemId: ctx.workItemId,
        commandKind: 'generation_finalize',
        leaseEpoch: ctx.leaseEpoch,
        authorityBaseRef: ctx.authorityBaseRef,
        payloadRef: ctx.payloadRef,
      });
      if (outcome.kind === 'completed' || outcome.kind === 'blocked') {
        return { kind: 'completed', resultRefs: outcome.resultRefs };
      }
      return { kind: 'retryable_failure', failureCode: outcome.failureCode, failureDigest: canonicalJsonSha256({ commandId: ctx.commandId, code: outcome.failureCode }) };
    },
  };
}

// Register the three content-plan publication handlers on the runtime allowlist
// so the default facade can replay their pins. Idempotent — the registration
// functions check `resolve` first. Tests with fresh registries call the same
// functions explicitly.
registerContentPlanPublicationHandlers(PUBLICATION_INTENT_REGISTRY_V2);
