/**
 * Task 20 content migration across an approved replacement Map.
 *
 * This module keeps the authority-bearing migration objects as pure,
 * content-addressed builders. Runtime orchestration persists these objects and
 * publishes only their refs; validator output is never folded back into the
 * immutable intent. The helpers here are deliberately deterministic so an
 * interrupted 10k-slot migration can resume from its first missing ordinal and
 * produce byte-identical settlement/decision roots.
 */
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { refOfBlob } from '../../authoritative-review/object-registry';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type {
  ContentCompatibilityProofV2,
  ContentMigrationIntentCoreV2,
  ContentMigrationSpecV2,
  ContentMigrationSettlementCoreV2,
  ContentMigrationValidationPlanSpecV2,
  ContentPlanFinalizeCoreV2,
  LocalValidatorEquivalenceProofV2,
  MigrationActivationDecisionV2,
  MigrationBatchRouteOutcomeV2,
  MigrationIntentDecisionV2,
  MigrationBatchSlotResultV2,
  MigrationValidationBatchResultV2,
  MigrationSettlementOutcomeV2,
  MapReviewPublishCarriersV2,
  FindingSetV2,
  FindingV2,
  ValidatorAggregateV2,
  MapSnapshotV2,
  ContentRevisionManifestV2,
  MapReviewSettlementCoreV2,
  MapReviewRoundV2,
  ProposedMapCoreV2,
  SlotContentVersionV2,
  SlotPresenceV2,
  SuccessorWorkItemCarrierV2,
  SystemCommandTerminalCarrierV2,
  AuthorityBaseSetV2,
} from '../../authoritative-review/authority-types';
import type { PublicationEventEnvelopeV2 } from '../../storage/authoritative-publication-intent-registry';
import {
  NotRebuildableError,
  PUBLICATION_INTENT_REGISTRY_V2,
  type PublicationIntentRegistry,
} from '../../storage/authoritative-publication-intent-registry';
import { parsePublicationOperationPayload } from '../../authoritative-review/object-schema-parsers-3';
import type { AuthoritativeAppendFacadeV2 } from '../../storage/authoritative-append-facade';
import { buildAuthorityBaseSet } from './authority-base';
import { mapReviewCarrier } from './map-review-service';
import { validateMigrationSuccessorCarrier } from './work-item-coordinator';
import { computeProvisionalOrFinalizedManifest } from '../../authoritative-review/content-domain';
import type { SystemCommandHandler } from './system-command-registry';
import { SystemCommandRegistry } from './system-command-registry';
import { ValidatorEngine, registrationSetDigestOf, type TriggerExecutionResult } from './validator-engine';
import type { ValidatorRegistry } from './validator-registry';
import { ContentPlanMemoryBlobStore, buildContentRevisionCommitCore, contentPlanEnrichment } from './content-plan-service';
import type { ValidatorRegistrationV2 } from '../../template/structured-slot-contract-v2';
import type { AuthoritativeReviewProfileSnapshotV1Body } from '../../structured-slots/authoritative-review-profile';
import type { ValidatorSlotType } from './validator-engine';
import { attemptContinuationOperationId } from './attempt-coordinator';

export interface MigrationSourceSlotV2 {
  ref: BlobRefV2;
  value: SlotContentVersionV2;
}

export interface ClassifyMigrationSlotInputV2 {
  taskId: string;
  slotId: string;
  source: MigrationSourceSlotV2 | null;
  sourceMapRef: BlobRefV2;
  targetMapRef: BlobRefV2;
  targetContentSchemaDigest: string;
  targetPresence: SlotPresenceV2;
  stableIdentityEvidenceRef: BlobRefV2;
  proofPolicyVersion: string;
  mixedFindingStageRootRef: BlobRefV2 | null;
}

export interface ClassifiedMigrationSlotV2 {
  decision: MigrationIntentDecisionV2;
  compatibilityProof: ContentCompatibilityProofV2 | null;
}

function withDigest<T extends Record<string, unknown>, K extends string>(body: T, key: K): T & Record<K, string> {
  return { ...body, [key]: canonicalJsonSha256(body) } as T & Record<K, string>;
}

function compatibilityProof(input: ClassifyMigrationSlotInputV2, source: MigrationSourceSlotV2): ContentCompatibilityProofV2 {
  return withDigest({
    taskId: input.taskId,
    slotId: input.slotId,
    sourceVersionRef: source.ref,
    sourceMapRef: input.sourceMapRef,
    targetMapRef: input.targetMapRef,
    sourceContentSchemaDigest: source.value.contentSchemaDigest,
    targetContentSchemaDigest: input.targetContentSchemaDigest,
    stableIdentityEvidenceRef: input.stableIdentityEvidenceRef,
    proofPolicyVersion: input.proofPolicyVersion,
  }, 'proofDigest');
}

/** Exactly one migration intent action per target content-bearing slot. */
export function classifyMigrationSlot(input: ClassifyMigrationSlotInputV2): ClassifiedMigrationSlotV2 {
  const source = input.source;
  if (source === null) {
    return {
      decision: { action: 'new_or_schema_reset', slotId: input.slotId, unsetReason: 'new_slot', sourceVersionRef: null },
      compatibilityProof: null,
    };
  }
  if (source.value.contentSchemaDigest !== input.targetContentSchemaDigest) {
    return {
      decision: { action: 'new_or_schema_reset', slotId: input.slotId, unsetReason: 'schema_reset', sourceVersionRef: source.ref },
      compatibilityProof: null,
    };
  }
  const proof = compatibilityProof(input, source);
  if (input.mixedFindingStageRootRef !== null || source.value.state === 'rewrite_required' || (source.value.state === 'unset' && input.targetPresence === 'required')) {
    if (input.mixedFindingStageRootRef === null) {
      throw new Error(`rewrite_required slot '${input.slotId}' requires a finding-stage root`);
    }
    return {
      decision: {
        action: 'rewrite_required', slotId: input.slotId, sourceVersionRef: source.ref,
        rewriteReason: 'mixed_rewrite_required', findingStageRootRef: input.mixedFindingStageRootRef,
      },
      compatibilityProof: proof,
    };
  }
  if (source.value.state === 'unset') {
    return {
      decision: { action: 'carry_unset', slotId: input.slotId, sourceVersionRef: source.ref, compatibilityProofRef: refOfBlob('content_compatibility_proof', proof) },
      compatibilityProof: proof,
    };
  }
  return {
    decision: { action: 'inherit_or_validate', slotId: input.slotId, sourceVersionRef: source.ref, compatibilityProofRef: refOfBlob('content_compatibility_proof', proof) },
    compatibilityProof: proof,
  };
}

export interface LocalValidatorCustodyDimensionsV2 {
  frozenRegistrationSetDigest: string;
  selectorExpansionDigest: string;
  contentBytesDigest: string;
  localMapSubgraphDigest: string;
  localRelationContextDigest: string;
}

export type LocalValidatorEquivalenceResultV2 =
  | { kind: 'equivalent'; proof: LocalValidatorEquivalenceProofV2 }
  | { kind: 'fresh_validation_required'; changedDimensions: readonly (keyof LocalValidatorCustodyDimensionsV2)[] };

/** Reuse is all-or-nothing over the five frozen local-validator dimensions. */
export function proveLocalValidatorEquivalence(input: {
  slotId: string;
  sourceVersionRef: BlobRefV2;
  sourceMapRef: BlobRefV2;
  targetMapRef: BlobRefV2;
  sourceBatchInputRef: BlobRefV2;
  equivalencePolicyVersion: string;
  source: LocalValidatorCustodyDimensionsV2;
  target: LocalValidatorCustodyDimensionsV2;
}): LocalValidatorEquivalenceResultV2 {
  const dimensions: readonly (keyof LocalValidatorCustodyDimensionsV2)[] = [
    'frozenRegistrationSetDigest', 'selectorExpansionDigest', 'contentBytesDigest',
    'localMapSubgraphDigest', 'localRelationContextDigest',
  ];
  const changedDimensions = dimensions.filter((key) => input.source[key] !== input.target[key]);
  if (changedDimensions.length > 0) return { kind: 'fresh_validation_required', changedDimensions };
  const proof = withDigest({
    slotId: input.slotId,
    sourceVersionRef: input.sourceVersionRef,
    sourceMapRef: input.sourceMapRef,
    targetMapRef: input.targetMapRef,
    sourceBatchInputRef: input.sourceBatchInputRef,
    frozenRegistrationSetDigest: input.source.frozenRegistrationSetDigest,
    localMapSubgraphDigest: input.source.localMapSubgraphDigest,
    localRelationContextDigest: input.source.localRelationContextDigest,
    selectorExpansionDigest: input.source.selectorExpansionDigest,
    equivalencePolicyVersion: input.equivalencePolicyVersion,
  }, 'proofDigest');
  return { kind: 'equivalent', proof };
}

export function buildMigrationIntent(input: Omit<ContentMigrationIntentCoreV2, 'coreDigest'>): ContentMigrationIntentCoreV2 {
  const decisions = [...input.decisions].sort((a, b) => a.slotId.localeCompare(b.slotId));
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.slotId)) throw new Error(`duplicate migration action for slot '${decision.slotId}'`);
    seen.add(decision.slotId);
  }
  return withDigest({ ...input, decisions }, 'coreDigest');
}

export function buildContentMigrationSpec(input: Omit<ContentMigrationSpecV2, 'specDigest'>): ContentMigrationSpecV2 {
  return withDigest({ ...input }, 'specDigest');
}

export function buildMigrationValidationPlanSpec(
  input: Omit<ContentMigrationValidationPlanSpecV2, 'specDigest'>,
): ContentMigrationValidationPlanSpecV2 {
  const orderedBatchSlotIds = input.orderedBatchSlotIds.map((batch) => [...batch].sort());
  const seen = new Set<string>();
  for (const batch of orderedBatchSlotIds) {
    if (batch.length === 0) throw new Error('migration validation plan cannot contain an empty batch');
    for (const slotId of batch) {
      if (seen.has(slotId)) throw new Error(`duplicate migration validation slot '${slotId}'`);
      seen.add(slotId);
    }
  }
  return withDigest({ ...input, orderedBatchSlotIds }, 'specDigest');
}

export function buildMigrationValidationBatchResult(
  input: Omit<MigrationValidationBatchResultV2, 'resultDigest'>,
): MigrationValidationBatchResultV2 {
  const slotResults = [...input.slotResults].sort((a, b) => a.slotId.localeCompare(b.slotId));
  return withDigest({ ...input, slotResults }, 'resultDigest');
}

export interface CompletedMigrationBatchV2 {
  batchOrdinal: number;
  batchResultRootRef: BlobRefV2;
}

export function partitionMigrationValidationBatches(slotIds: readonly string[], batchSize: number): readonly (readonly string[])[] {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('migration batch size must be a positive integer');
  const ordered = [...slotIds].sort();
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i - 1] === ordered[i]) throw new Error(`duplicate migration slot '${ordered[i]}'`);
  }
  const batches: string[][] = [];
  for (let offset = 0; offset < ordered.length; offset += batchSize) batches.push(ordered.slice(offset, offset + batchSize));
  return batches;
}

export function nextMissingMigrationBatchOrdinal(
  plan: { orderedBatchSlotIds: readonly (readonly string[])[] },
  completed: readonly CompletedMigrationBatchV2[],
): number | null {
  const byOrdinal = new Map<number, BlobRefV2>();
  for (const entry of completed) {
    if (byOrdinal.has(entry.batchOrdinal)) throw new Error(`duplicate migration batch ordinal ${entry.batchOrdinal}`);
    byOrdinal.set(entry.batchOrdinal, entry.batchResultRootRef);
  }
  for (let ordinal = 0; ordinal < plan.orderedBatchSlotIds.length; ordinal++) {
    if (!byOrdinal.has(ordinal)) return ordinal;
  }
  return null;
}

export function validateMigrationBatchClosure(
  plan: { orderedBatchSlotIds: readonly (readonly string[])[] },
  completed: readonly CompletedMigrationBatchV2[],
): readonly BlobRefV2[] {
  const byOrdinal = new Map<number, BlobRefV2>();
  for (const entry of completed) {
    if (!Number.isInteger(entry.batchOrdinal) || entry.batchOrdinal < 0 || entry.batchOrdinal >= plan.orderedBatchSlotIds.length) {
      throw new Error(`migration batch ordinal ${entry.batchOrdinal} is outside the frozen plan`);
    }
    if (byOrdinal.has(entry.batchOrdinal)) throw new Error(`duplicate migration batch ordinal ${entry.batchOrdinal}`);
    byOrdinal.set(entry.batchOrdinal, entry.batchResultRootRef);
  }
  const ordered: BlobRefV2[] = [];
  for (let ordinal = 0; ordinal < plan.orderedBatchSlotIds.length; ordinal++) {
    const result = byOrdinal.get(ordinal);
    if (result === undefined) throw new Error(`migration batch closure is missing ordinal ${ordinal}`);
    ordered.push(result);
  }
  return ordered;
}

export async function classifyAndUnionMigrationFindingSets(input: {
  findingSetRefs: readonly BlobRefV2[];
  resolve(ref: BlobRefV2): Promise<unknown> | unknown;
}): Promise<{ findingSet: FindingSetV2 | null; routeOutcome: MigrationBatchRouteOutcomeV2 }> {
  const findingRefs = new Map<string, BlobRefV2>();
  let routeOutcome: MigrationBatchRouteOutcomeV2 = 'clear';
  for (const setRef of input.findingSetRefs) {
    const rawSet = await input.resolve(setRef);
    if (rawSet === null || typeof rawSet !== 'object') throw new Error('migration FindingSet is unresolvable');
    const set = rawSet as FindingSetV2;
    const actualSetRef = refOfBlob('finding_set', set);
    if (!sameRef(actualSetRef, setRef)) throw new Error('migration FindingSet bytes do not match its persisted ref');
    for (const findingRef of set.findingRefs) {
      const rawFinding = await input.resolve(findingRef);
      if (rawFinding === null || typeof rawFinding !== 'object') throw new Error('migration Finding is unresolvable');
      const finding = rawFinding as FindingV2;
      const actualFindingRef = refOfBlob('finding', finding);
      if (!sameRef(actualFindingRef, findingRef)) throw new Error('migration Finding bytes do not match its persisted ref');
      findingRefs.set(findingRef.digest, findingRef);
      if (finding.severity !== 'blocking') continue;
      routeOutcome = combineMigrationRoute(
        routeOutcome,
        finding.defectClass === 'content' ? 'content_repair' : 'map_repair',
      );
    }
  }
  if (findingRefs.size === 0) return { findingSet: null, routeOutcome };
  const ordered = [...findingRefs.values()].sort((a, b) => a.digest.localeCompare(b.digest));
  const body = {
    findingSetId: `migration-findings-${canonicalJsonSha256(ordered).slice(0, 24)}`,
    findingRefs: ordered,
  };
  return { findingSet: { ...body, setDigest: canonicalJsonSha256(body) }, routeOutcome };
}

export async function validateAndClassifyMigrationBatchResults(input: {
  plan: ContentMigrationValidationPlanSpecV2;
  planSpecRef: BlobRefV2;
  orderedResultRefs: readonly BlobRefV2[];
  resolve(ref: BlobRefV2): Promise<unknown> | unknown;
}): Promise<{
  results: readonly MigrationValidationBatchResultV2[];
  resultBySlot: ReadonlyMap<string, MigrationBatchSlotResultV2>;
  rejectedFindingSetRefs: ReadonlyMap<string, BlobRefV2>;
  findingSetRefs: readonly BlobRefV2[];
  batchRouteOutcome: MigrationBatchRouteOutcomeV2;
}> {
  const results: MigrationValidationBatchResultV2[] = [];
  const resultBySlot = new Map<string, MigrationBatchSlotResultV2>();
  const rejectedFindingSetRefs = new Map<string, BlobRefV2>();
  const findingSetRefs: BlobRefV2[] = [];
  let batchRouteOutcome: MigrationBatchRouteOutcomeV2 = 'clear';
  for (let ordinal = 0; ordinal < input.orderedResultRefs.length; ordinal += 1) {
    const resultRef = input.orderedResultRefs[ordinal] as BlobRefV2;
    const raw = await input.resolve(resultRef);
    if (raw === null || typeof raw !== 'object') throw new Error(`migration batch result ordinal ${ordinal} is unresolvable`);
    const result = raw as MigrationValidationBatchResultV2;
    if (!sameRef(refOfBlob('migration_validation_batch_result', result), resultRef)) {
      throw new Error(`migration batch result ordinal ${ordinal} bytes do not match its persisted ref`);
    }
    if (!sameRef(result.migrationValidationPlanSpecRef, input.planSpecRef)) throw new Error(`migration batch result ordinal ${ordinal} belongs to a different plan`);
    if (result.batchOrdinal !== ordinal) throw new Error(`migration batch result must carry ordinal ${ordinal}`);
    const expectedSlots = [...(input.plan.orderedBatchSlotIds[ordinal] ?? [])].sort();
    const actualSlots = result.slotResults.map((item) => item.slotId).sort();
    if (canonicalJsonSha256(actualSlots) !== canonicalJsonSha256(expectedSlots)) {
      throw new Error(`migration batch result ordinal ${ordinal} slot set does not match the frozen plan`);
    }
    let derivedOutcome: MigrationBatchRouteOutcomeV2 = 'clear';
    for (const slotResult of result.slotResults) {
      if (resultBySlot.has(slotResult.slotId)) throw new Error(`migration slot '${slotResult.slotId}' has duplicate batch results`);
      resultBySlot.set(slotResult.slotId, slotResult);
      if (slotResult.outcome === 'equivalent') continue;
      const rawAggregate = await input.resolve(slotResult.validatorAggregateRef);
      if (rawAggregate === null || typeof rawAggregate !== 'object') throw new Error(`migration slot '${slotResult.slotId}' aggregate is unresolvable`);
      const aggregate = rawAggregate as ValidatorAggregateV2;
      if (aggregate.outcome === 'infrastructure_failure') {
        throw new Error(`migration batch ordinal ${ordinal} persisted an infrastructure failure`);
      }
      if (slotResult.outcome === 'revalidated') {
        if (aggregate.outcome !== 'clear') throw new Error(`migration revalidated slot '${slotResult.slotId}' aggregate is not clear`);
      } else {
        if (aggregate.outcome !== 'blocking_invalid') throw new Error(`migration rejected slot '${slotResult.slotId}' aggregate is not blocking-invalid`);
        rejectedFindingSetRefs.set(slotResult.slotId, slotResult.findingSetRef);
        findingSetRefs.push(slotResult.findingSetRef);
        const classified = await classifyAndUnionMigrationFindingSets({ findingSetRefs: [slotResult.findingSetRef], resolve: input.resolve });
        derivedOutcome = combineMigrationRoute(derivedOutcome, classified.routeOutcome);
      }
    }
    if (result.batchOutcome !== derivedOutcome) {
      throw new Error(`migration batch outcome '${result.batchOutcome}' does not equal derived '${derivedOutcome}' for ordinal ${ordinal}`);
    }
    batchRouteOutcome = combineMigrationRoute(batchRouteOutcome, derivedOutcome);
    results.push(result);
  }
  return { results, resultBySlot, rejectedFindingSetRefs, findingSetRefs, batchRouteOutcome };
}

export function buildMigrationSettlement(input: {
  migrationIntentCoreRef: BlobRefV2;
  migrationValidationPlanSpecRef: BlobRefV2;
  orderedBatches: readonly CompletedMigrationBatchV2[];
  decisions: readonly MigrationSettlementOutcomeV2[];
  batchClassifiedFindingSetRef: BlobRefV2 | null;
  batchRouteOutcome: MigrationBatchRouteOutcomeV2;
}): ContentMigrationSettlementCoreV2 {
  const orderedBatchResultRootRefs = [...input.orderedBatches]
    .sort((a, b) => a.batchOrdinal - b.batchOrdinal)
    .map((entry, expected) => {
      if (entry.batchOrdinal !== expected) throw new Error(`migration batch closure is missing ordinal ${expected}`);
      return entry.batchResultRootRef;
    });
  const decisions = [...input.decisions].sort((a, b) => a.slotId.localeCompare(b.slotId));
  return withDigest({
    migrationIntentCoreRef: input.migrationIntentCoreRef,
    migrationValidationPlanSpecRef: input.migrationValidationPlanSpecRef,
    orderedBatchResultRootRefs,
    decisions,
    batchClassifiedFindingSetRef: input.batchClassifiedFindingSetRef,
    batchRouteOutcome: input.batchRouteOutcome,
  }, 'settlementDigest');
}

export function buildMigratedProvisionalManifest(input: {
  taskId: string;
  targetMapRef: BlobRefV2;
  targetMapSemanticDigest: string;
  taskContentRevision: number;
  producerPlanSpecRef: BlobRefV2;
  priorManifestRef: BlobRefV2;
  migrationSettlementCoreRef: BlobRefV2;
  decisions: readonly MigrationSettlementOutcomeV2[];
  sourceVersions: ReadonlyMap<string, SlotContentVersionV2>;
  targetSchemaDigestOf(slotId: string): string;
  rejectedFindingSetRefsBySlot?: ReadonlyMap<string, BlobRefV2>;
}): { manifest: import('../../authoritative-review/authority-types').ContentRevisionManifestV2; versions: ReadonlyMap<string, SlotContentVersionV2> } {
  const versions = new Map<string, SlotContentVersionV2>();
  for (const decision of [...input.decisions].sort((a, b) => a.slotId.localeCompare(b.slotId))) {
    const schemaDigest = input.targetSchemaDigestOf(decision.slotId);
    let version: SlotContentVersionV2;
    if (decision.outcome === 'unset') {
      version = {
        state: 'unset', slotId: decision.slotId, slotRevision: 1,
        taskContentRevision: input.taskContentRevision, mapRef: input.targetMapRef,
        mapSemanticDigest: input.targetMapSemanticDigest, contentSchemaDigest: schemaDigest,
        unsetReason: decision.unsetReason, unsetProvenance: { kind: 'created_empty' },
      };
    } else {
      const source = input.sourceVersions.get(decision.sourceVersionRef.digest);
      if (source === undefined || source.slotId !== decision.slotId) {
        throw new Error(`migration source version for slot '${decision.slotId}' is missing or mismatched`);
      }
      if (decision.outcome === 'carry_unset') {
        if (source.state !== 'unset') throw new Error(`carry_unset source '${decision.slotId}' is not unset`);
        version = {
          state: 'unset', slotId: decision.slotId, slotRevision: source.slotRevision + 1,
          taskContentRevision: input.taskContentRevision, mapRef: input.targetMapRef,
          mapSemanticDigest: input.targetMapSemanticDigest, contentSchemaDigest: schemaDigest,
          unsetReason: 'carried_optional_unset',
          unsetProvenance: {
            kind: 'rebased_after_map_activation', sourceVersionRef: decision.sourceVersionRef,
            contentMigrationSettlementCoreRef: input.migrationSettlementCoreRef,
            compatibilityProofRef: decision.compatibilityProofRef,
          },
        };
      } else if (decision.outcome === 'inherit_equivalent' || decision.outcome === 'inherit_revalidated') {
        if (source.state !== 'set') throw new Error(`inherited source '${decision.slotId}' is not set`);
        version = {
          state: 'set', slotId: decision.slotId, slotRevision: source.slotRevision + 1,
          taskContentRevision: input.taskContentRevision, mapRef: input.targetMapRef,
          mapSemanticDigest: input.targetMapSemanticDigest, contentSchemaDigest: schemaDigest,
          contentDigest: source.contentDigest, blobRef: source.blobRef,
          provenance: {
            kind: 'inherited_after_map_activation', sourceVersionRef: decision.sourceVersionRef,
            contentMigrationSettlementCoreRef: input.migrationSettlementCoreRef,
            compatibilityProofRef: decision.compatibilityProofRef,
            localValidatorEquivalenceProofRef: decision.outcome === 'inherit_equivalent' ? decision.localValidatorEquivalenceProofRef : null,
            migratedBatchValidatorAggregateRef: decision.outcome === 'inherit_revalidated' ? decision.migratedBatchValidatorAggregateRef : null,
            migratedBatchWarningRootRef: decision.outcome === 'inherit_revalidated' ? decision.migratedBatchWarningRootRef : null,
            migrationReason: 'stable_slot_and_schema_compatible',
          },
        };
      } else {
        const sourceContentDigest = source.state === 'set' ? source.contentDigest : source.state === 'rewrite_required' ? source.sourceContentDigest : null;
        if (decision.rewriteCause === 'mixed_rewrite_required') {
          if (decision.findingStageRootRef === null) throw new Error(`mixed rewrite '${decision.slotId}' lacks finding-stage custody`);
          version = {
            state: 'rewrite_required', slotId: decision.slotId, slotRevision: source.slotRevision + 1,
            taskContentRevision: input.taskContentRevision, mapRef: input.targetMapRef,
            mapSemanticDigest: input.targetMapSemanticDigest, contentSchemaDigest: schemaDigest,
            sourceVersionRef: decision.sourceVersionRef, contentMigrationSettlementCoreRef: input.migrationSettlementCoreRef,
            rewriteCause: { kind: 'mixed_rewrite_required', findingStageRootRef: decision.findingStageRootRef }, sourceContentDigest,
          };
        } else {
          const findingSetRef = input.rejectedFindingSetRefsBySlot?.get(decision.slotId);
          if (decision.blockingValidatorAggregateRef === null || decision.validationReceiptRef === null || findingSetRef === undefined) {
            throw new Error(`validation rewrite '${decision.slotId}' lacks aggregate/receipt/finding custody`);
          }
          version = {
            state: 'rewrite_required', slotId: decision.slotId, slotRevision: source.slotRevision + 1,
            taskContentRevision: input.taskContentRevision, mapRef: input.targetMapRef,
            mapSemanticDigest: input.targetMapSemanticDigest, contentSchemaDigest: schemaDigest,
            sourceVersionRef: decision.sourceVersionRef, contentMigrationSettlementCoreRef: input.migrationSettlementCoreRef,
            rewriteCause: { kind: 'validation_rejected', blockingValidatorAggregateRef: decision.blockingValidatorAggregateRef, validationReceiptRef: decision.validationReceiptRef, findingSetRef },
            sourceContentDigest,
          };
        }
      }
    }
    versions.set(decision.slotId, version);
  }
  const entries = [...versions.entries()].map(([slotId, version]) => ({ slotId, versionRef: refOfBlob('content_version', version) }));
  const manifest = computeProvisionalOrFinalizedManifest({
    taskId: input.taskId, mapRef: input.targetMapRef, mapSemanticDigest: input.targetMapSemanticDigest,
    taskContentRevision: input.taskContentRevision, manifestPhase: 'provisional', entries,
    producerPlanSpecRef: input.producerPlanSpecRef, priorManifestRef: input.priorManifestRef,
    resolvedVersions: versions,
  });
  return { manifest, versions };
}

/** Infrastructure dominates, then Map/mixed, then content. */
export function combineMigrationRoute(
  batch: MigrationBatchRouteOutcomeV2,
  finalizer: MigrationBatchRouteOutcomeV2,
): MigrationBatchRouteOutcomeV2 {
  if (batch === 'infrastructure_failure' || finalizer === 'infrastructure_failure') return 'infrastructure_failure';
  if (batch === 'map_repair' || finalizer === 'map_repair') return 'map_repair';
  if (batch === 'content_repair' || finalizer === 'content_repair') return 'content_repair';
  return 'clear';
}

export function validateMigrationActivationRouteCarriers(
  route: Exclude<MigrationBatchRouteOutcomeV2, 'infrastructure_failure'>,
  carriers: MapReviewPublishCarriersV2,
  migratedManifestRef: BlobRefV2,
): void {
  if (route === 'map_repair') {
    if (carriers.outcome !== 'map_repair') throw new Error('map_repair migration route must not activate the target Map');
    if (carriers.mixedContentRepair?.track !== 'map') throw new Error('map_repair migration route requires a candidate-bound MapRepairPlan');
    return;
  }
  if (carriers.outcome !== 'activate') throw new Error(`${route} migration route must activate the target Map`);
  if (carriers.contentRevisionManifestRef === null || !sameRef(carriers.contentRevisionManifestRef, migratedManifestRef)) {
    throw new Error(`${route} migration route must bind the exact migrated manifest`);
  }
  if (route === 'clear') {
    if (carriers.manifestPhase !== 'finalized') throw new Error('clear migration route requires a finalized manifest');
    if (carriers.mixedContentRepair !== null) throw new Error('clear migration route cannot create a RepairPlan');
    if (carriers.contentRound === null || (carriers.reviewWorkItems?.length ?? 0) === 0) {
      throw new Error('clear migration route requires a content review round and its WorkItems');
    }
  } else {
    if (carriers.manifestPhase !== 'provisional') throw new Error('content_repair migration route requires a provisional manifest');
    if (carriers.mixedContentRepair?.track !== 'content') throw new Error('content_repair migration route requires a ContentRepairPlan');
    if (carriers.contentRound !== null || (carriers.reviewWorkItems?.length ?? 0) > 0) throw new Error('content_repair migration route cannot start review or Seal');
  }
}

export function buildMigrationFinalizeCore(input: {
  producerPlanSpecRef: BlobRefV2;
  provisionalManifestRef: BlobRefV2;
  candidateRef: BlobRefV2;
  proposedMapCoreRef: BlobRefV2;
  targetMapRef: BlobRefV2;
  migrationSettlementCoreRef: BlobRefV2;
  settlementOperationId: string;
  expectedContentRootDigest: string;
  requiredSlotCoverageDigest: string;
  expectedBatchClosureDigest: string;
}): ContentPlanFinalizeCoreV2 {
  return withDigest({
    producerPlanSpecRef: input.producerPlanSpecRef,
    provisionalManifestRef: input.provisionalManifestRef,
    mapContext: {
      kind: 'migration_preactivation' as const,
      candidateRef: input.candidateRef,
      proposedMapCoreRef: input.proposedMapCoreRef,
      targetMapRef: input.targetMapRef,
      migrationValidationPlanSpecRef: input.producerPlanSpecRef,
      migrationSettlementCoreRef: input.migrationSettlementCoreRef,
      settlementOperationId: input.settlementOperationId,
    },
    expectedContentRootDigest: input.expectedContentRootDigest,
    requiredSlotCoverageDigest: input.requiredSlotCoverageDigest,
    expectedBatchClosureDigest: input.expectedBatchClosureDigest,
  }, 'coreDigest');
}

export function buildMigrationActivationDecision(input: {
  migrationSettlementCoreRef: BlobRefV2;
  provisionalManifestRef: BlobRefV2;
  contentPlanFinalizeCoreRef: BlobRefV2;
  finalizerAggregateRef: BlobRefV2;
  combinedClassifiedFindingSetRef: BlobRefV2 | null;
  batchRouteOutcome: MigrationBatchRouteOutcomeV2;
  finalizerRouteOutcome: MigrationBatchRouteOutcomeV2;
  decisionPolicyVersion: string;
}): MigrationActivationDecisionV2 {
  return withDigest({
    migrationSettlementCoreRef: input.migrationSettlementCoreRef,
    provisionalManifestRef: input.provisionalManifestRef,
    contentPlanFinalizeCoreRef: input.contentPlanFinalizeCoreRef,
    finalizerAggregateRef: input.finalizerAggregateRef,
    combinedClassifiedFindingSetRef: input.combinedClassifiedFindingSetRef,
    combinedRouteOutcome: combineMigrationRoute(input.batchRouteOutcome, input.finalizerRouteOutcome),
    decisionPolicyVersion: input.decisionPolicyVersion,
  }, 'decisionDigest');
}

/** Stable comparison identity used by restart/equality qualification. */
export function migrationExecutionDigest(value: ContentMigrationSettlementCoreV2 | MigrationActivationDecisionV2): string {
  return canonicalJsonSha256(value);
}

export type MigrationProgressCarrierV2 =
  | {
      stage: 'initial';
      migrationValidationPlanId: string;
      intentCoreRef: BlobRefV2;
      planSpecRef: BlobRefV2;
      batchOrdinal: null;
      batchResultRootRef: null;
      batchOutcome: null;
      successor: SuccessorWorkItemCarrierV2;
      terminal: SystemCommandTerminalCarrierV2;
    }
  | {
      stage: 'batch';
      migrationValidationPlanId: null;
      intentCoreRef: null;
      planSpecRef: BlobRefV2;
      batchOrdinal: number;
      batchResultRootRef: BlobRefV2;
      batchOutcome: MigrationBatchRouteOutcomeV2;
      successor: SuccessorWorkItemCarrierV2;
      terminal: SystemCommandTerminalCarrierV2;
    };

/** Byte-rebuildable event envelope for initial and per-batch system commands. */
export function buildMigrationProgressEvents(carrier: MigrationProgressCarrierV2, at: string): readonly PublicationEventEnvelopeV2[] {
  const events: PublicationEventEnvelopeV2[] = [];
  if (carrier.stage === 'initial') {
    events.push({
      protocolVersion: 2, at, type: 'structured_migration_validation_plan_started',
      migrationValidationPlanId: carrier.migrationValidationPlanId,
      intentCoreRef: carrier.intentCoreRef,
      planSpecRef: carrier.planSpecRef,
    });
  } else {
    events.push({
      protocolVersion: 2, at, type: 'structured_migration_validation_batch_completed',
      planSpecRef: carrier.planSpecRef,
      batchOrdinal: carrier.batchOrdinal,
      batchResultRootRef: carrier.batchResultRootRef,
      batchOutcome: carrier.batchOutcome,
    });
  }
  const successor = carrier.successor;
  events.push({
    protocolVersion: 2, at, type: 'structured_work_item_created',
    workItemId: successor.workItemId, kind: successor.kind, roleBinding: successor.roleBinding,
    agentExecutionKind: successor.agentExecutionKind, sessionKind: successor.sessionKind,
    roundId: successor.roundId, logicalAssignmentId: successor.logicalAssignmentId,
    reviewAssignmentId: successor.reviewAssignmentId, grantSpecRef: successor.grantSpecRef,
    inputArtifactDeliveryId: successor.inputArtifactDeliveryId,
    authorityBaseRef: successor.authorityBaseRef, payloadRef: successor.payloadRef,
    initialLeaseEpoch: successor.initialLeaseEpoch, maxAutomaticRetries: successor.maxAutomaticRetries,
  });
  const terminal = carrier.terminal;
  events.push(
    { protocolVersion: 2, at, type: 'structured_system_command_completed', ...terminal },
    { protocolVersion: 2, at, type: 'structured_work_item_completed', workItemId: terminal.workItemId, leaseEpoch: terminal.leaseEpoch, authorityBaseRef: terminal.authorityBaseRef },
  );
  return events;
}

/** Registers the byte-rebuildable initial/batch publication envelope. */
export function registerMigrationPublicationHandlers(registry: PublicationIntentRegistry): void {
  if (registry.resolve('migration_settlement', 1) !== null) return;
  registry.register({
    handlerKind: 'migration_settlement',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: [
      'structured_migration_validation_plan_started',
      'structured_migration_validation_batch_completed',
      'structured_work_item_created',
      'structured_system_command_completed',
      'structured_work_item_completed',
    ],
    rebuildable: true,
    missingInputs: [],
    parsePayload: parsePublicationOperationPayload,
    childRefsOf: (payload) => payload.family === 'domain_publish' ? [...payload.blobRefs] : [],
    resolveRefs: () => [],
    buildEvents: (payload, at) => {
      if (payload.family !== 'domain_publish' || payload.publishKind !== 'migration_settlement') {
        throw new NotRebuildableError('migration_settlement', ['domain_publish migration_settlement payload']);
      }
      const progress = payload.mapReview?.migrationProgress;
      if (progress === null || progress === undefined) throw new NotRebuildableError('migration_settlement', ['mapReview.migrationProgress']);
      return [...buildMigrationProgressEvents(progress as MigrationProgressCarrierV2, at)];
    },
    expectedResultIdentity: (_payload, events) => canonicalJsonSha256(events),
  });
}

registerMigrationPublicationHandlers(PUBLICATION_INTENT_REGISTRY_V2);

export interface MigrationTargetSlotV2 {
  slotId: string;
  source: MigrationSourceSlotV2 | null;
  targetContentSchemaDigest: string;
  targetPresence: SlotPresenceV2;
  mixedFindingStageRootRef: BlobRefV2 | null;
}

export interface MigrationServiceDependenciesV2 {
  facade: Pick<AuthoritativeAppendFacadeV2, 'prepareBlob' | 'publishWithPin'>;
  tail(taskId: string): Promise<{ lastSequence: number; lastCommitId: string | null }>;
  templateSnapshotRef: BlobRefV2;
  profileSnapshotRef: BlobRefV2;
  frozenRegistrationSetDigest: string;
  migrationPolicyVersion: string;
  equivalencePolicyVersion: string;
  maxAutomaticRetries: number;
  clock(): string;
  resolve(taskId: string, ref: BlobRefV2): Promise<unknown> | unknown;
  completedBatches(taskId: string, planSpecRef: BlobRefV2): Promise<readonly CompletedMigrationBatchV2[]>;
  /** Fresh projector/authority read used by the preactivation CAS gate. The
   * post-migration path fails closed when production composition omits it. */
  readCurrentAuthority?(taskId: string, workItemId: string): Promise<{
    activeMapRef: BlobRefV2 | null;
    activeManifestRef: BlobRefV2 | null;
    currentCandidateRef: BlobRefV2 | null;
    migrationValidationPlanId: string | null;
    migrationSettled: boolean;
    workItemPayloadRef: BlobRefV2 | null;
    workItemAuthorityBaseRef: BlobRefV2 | null;
    reviewRoundRef: BlobRefV2 | null;
    reviewRoundState: 'planned' | 'reviewing' | 'completed' | 'settled' | null;
  }>;
  localValidatorCustody(input: {
    taskId: string;
    slotId: string;
    decision: Extract<MigrationIntentDecisionV2, { action: 'inherit_or_validate' }>;
    plan: ContentMigrationValidationPlanSpecV2;
  }): Promise<{
    sourceBatchInputRef: BlobRefV2;
    source: LocalValidatorCustodyDimensionsV2;
    target: LocalValidatorCustodyDimensionsV2;
  }>;
  freshValidate(input: {
    taskId: string;
    slotId: string;
    decision: Extract<MigrationIntentDecisionV2, { action: 'inherit_or_validate' }>;
    plan: ContentMigrationValidationPlanSpecV2;
    planSpecRef: BlobRefV2;
    batchOrdinal: number;
  }): Promise<{
    slotResult: MigrationBatchSlotResultV2;
    batchOutcome: MigrationBatchRouteOutcomeV2;
    preparedBlobs: readonly { kind: Parameters<AuthoritativeAppendFacadeV2['prepareBlob']>[1]; value: unknown }[];
  }>;
  runMigrationFinalizer(input: {
    taskId: string;
    finalizeCore: ContentPlanFinalizeCoreV2;
    finalizeCoreRef: BlobRefV2;
    provisionalManifestRef: BlobRefV2;
    targetMapRef: BlobRefV2;
  }): Promise<{
    finalizerAggregateRef: BlobRefV2;
    finalizerWarningRootRef: BlobRefV2;
    routeOutcome: MigrationBatchRouteOutcomeV2;
    classifiedFindingSetRef: BlobRefV2 | null;
    preparedBlobs: readonly { kind: Parameters<AuthoritativeAppendFacadeV2['prepareBlob']>[1]; value: unknown }[];
  }>;
  prepareActivationRoute(input: {
    taskId: string;
    route: Exclude<MigrationBatchRouteOutcomeV2, 'infrastructure_failure'>;
    plan: ContentMigrationValidationPlanSpecV2;
    sourceManifestRef: BlobRefV2;
    targetMapRef: BlobRefV2;
    migratedManifestRef: BlobRefV2;
    migrationSettlementCoreRef: BlobRefV2;
    migrationActivationDecisionRef: BlobRefV2;
  }): Promise<{ carriers: MapReviewPublishCarriersV2; preparedRefs: readonly BlobRefV2[] }>;
}

type MigrationRoutePreparationV2 = { carriers: MapReviewPublishCarriersV2; preparedRefs: readonly BlobRefV2[] };

export interface MigrationProductionReviewCoordinatorV2 {
  prepareClearActivation(input: Parameters<MigrationServiceDependenciesV2['prepareActivationRoute']>[0]): Promise<MigrationRoutePreparationV2>;
}

export interface MigrationProductionRepairCoordinatorV2 {
  prepareContentRepairActivation(input: Parameters<MigrationServiceDependenciesV2['prepareActivationRoute']>[0]): Promise<MigrationRoutePreparationV2>;
  prepareMapRepair(input: Parameters<MigrationServiceDependenciesV2['prepareActivationRoute']>[0]): Promise<MigrationRoutePreparationV2>;
}

export type ProductionMigrationRuntimeInputV2 = Omit<
  MigrationServiceDependenciesV2,
  'localValidatorCustody' | 'freshValidate' | 'runMigrationFinalizer' | 'prepareActivationRoute' | 'readCurrentAuthority'
> & {
  validatorRegistry: ValidatorRegistry;
  profileBody: AuthoritativeReviewProfileSnapshotV1Body;
  templateSnapshotHash: string;
  registrationsFor(phase: 'batch_commit' | 'plan_finalize'): readonly ValidatorRegistrationV2[];
  slotTypes: readonly ValidatorSlotType[];
  slotTypeOf(slotId: string): string;
  requiredSlotIdsOf(taskId: string, targetMapRef: BlobRefV2): Promise<readonly string[]> | readonly string[];
  readProjection(taskId: string): Promise<{
    currentMap: { mapSnapshotRef: BlobRefV2 } | null;
    currentManifest: { contentRevisionManifestRef: BlobRefV2 } | null;
    currentCandidate: { candidateRef: BlobRefV2 } | null;
    migrationValidationPlan: { migrationValidationPlanId: string } | null;
    migrationSettled: boolean;
    workItems: Record<string, { payloadRef: BlobRefV2; authorityBaseRef: BlobRefV2 }>;
    mapRounds: Record<string, { state: 'planned' | 'reviewing' | 'completed' | 'settled' }>;
  }>;
  sourceResolver?: (handlerKey: string) => string | null;
  reviewCoordinator: MigrationProductionReviewCoordinatorV2;
  repairCoordinator: MigrationProductionRepairCoordinatorV2;
  systemCommands: SystemCommandRegistry;
};

function routeOfBlockingFindings(findings: readonly FindingV2[]): MigrationBatchRouteOutcomeV2 {
  let route: MigrationBatchRouteOutcomeV2 = 'clear';
  for (const finding of findings) {
    if (finding.severity !== 'blocking') continue;
    route = combineMigrationRoute(route, finding.defectClass === 'content' ? 'content_repair' : 'map_repair');
  }
  return route;
}

function findingsFromValidatorRun(run: TriggerExecutionResult, roundId: string): readonly FindingV2[] {
  const findings: FindingV2[] = [];
  for (const receipt of run.receipts) {
    for (const issue of receipt.blockerIssues) {
      const hasMap = issue.repairTargets.mapNodeIds.length > 0 || issue.repairTargets.relationIds.length > 0;
      const hasContent = issue.repairTargets.slotIds.length > 0;
      const defectClass: FindingV2['defectClass'] = hasMap ? (hasContent ? 'mixed' : 'map') : 'content';
      const findingId = `migration-finding-${canonicalJsonSha256({ roundId, issue }).slice(0, 24)}`;
      const primaryKind: FindingV2['primaryLocation']['kind'] =
        issue.location.targetKind === 'relation'
          ? 'relation'
          : issue.location.targetKind === 'slot'
            ? 'slot'
            : issue.location.targetKind === 'map_node'
              ? 'map_node'
              : 'map';
      findings.push({
        findingId,
        reviewContext: { kind: 'content', roundId },
        primaryLocation: { kind: primaryKind, id: issue.location.stableTargetId },
        relatedSlotIds: [...issue.repairTargets.slotIds].sort(),
        relatedRelationIds: [...issue.repairTargets.relationIds].sort(),
        defectClass,
        severity: 'blocking',
        source: 'system_validator',
        evidence: [{ evidenceDigest: issue.evidenceDigest, text: issue.issueCode, refs: [run.aggregateRef] }],
        suggestedRepairSlotIds: [...issue.repairTargets.slotIds].sort(),
        status: 'open',
        repairProgress: {
          map: defectClass === 'content' ? 'not_required' : 'pending',
          content: defectClass === 'map' ? 'not_required' : 'pending',
        },
        openedBy: { kind: 'system_validator', validatorExecutionId: issue.implementationDigest },
      });
    }
  }
  return findings.sort((a, b) => a.findingId.localeCompare(b.findingId));
}

function runPreparedBlobs(
  store: ContentPlanMemoryBlobStore,
  run: TriggerExecutionResult,
  findings: readonly FindingV2[],
): { preparedBlobs: Array<{ kind: Parameters<AuthoritativeAppendFacadeV2['prepareBlob']>[1]; value: unknown }>; findingSet: FindingSetV2 | null } {
  const preparedBlobs = [...store.produced] as Array<{ kind: Parameters<AuthoritativeAppendFacadeV2['prepareBlob']>[1]; value: unknown }>;
  preparedBlobs.push(
    { kind: 'validator_input_envelope', value: run.envelope },
    { kind: 'validator_aggregate', value: run.aggregate },
    { kind: 'validation_warning_root', value: run.warningRoot },
    ...run.receipts.map((value) => ({ kind: 'validation_receipt' as const, value })),
    ...run.failures.map((value) => ({ kind: 'validator_failure' as const, value })),
    ...findings.map((value) => ({ kind: 'finding' as const, value })),
  );
  if (findings.length === 0) return { preparedBlobs, findingSet: null };
  const findingRefs = findings.map((value) => refOfBlob('finding', value)).sort((a, b) => a.digest.localeCompare(b.digest));
  const body = { findingSetId: `migration-findings-${canonicalJsonSha256(findingRefs).slice(0, 24)}`, findingRefs };
  const findingSet = { ...body, setDigest: canonicalJsonSha256(body) };
  preparedBlobs.push({ kind: 'finding_set', value: findingSet });
  return { preparedBlobs, findingSet };
}

function aggregateRefOfVersion(version: SlotContentVersionV2): BlobRefV2 | null {
  if (version.state !== 'set') return null;
  if (version.provenance.kind === 'generated') return version.provenance.contentCommitValidatorAggregateRef;
  return version.provenance.migratedBatchValidatorAggregateRef;
}

function localMapDimensions(map: MapSnapshotV2, slotId: string): { subgraph: string; relations: string } {
  const node = map.nodes.find((candidate) => candidate.slotId === slotId) ?? null;
  const relations = map.relations
    .filter((relation) => relation.fromSlotId === slotId || relation.toSlotId === slotId)
    .sort((a, b) => a.relationId.localeCompare(b.relationId));
  return {
    subgraph: canonicalJsonSha256({ node, parent: map.nodes.find((candidate) => candidate.slotId === node?.parentSlotId) ?? null }),
    relations: canonicalJsonSha256(relations),
  };
}

/** Production Task 20 composition: installed ValidatorEngine + frozen
 * selectors/profile + system-owned route coordinators + command registry. */
export function createProductionMigrationRuntime(input: ProductionMigrationRuntimeInputV2): {
  service: MigrationServiceV2;
  systemCommands: SystemCommandRegistry;
} {
  const registrations = {
    batch_commit: [...input.registrationsFor('batch_commit')],
    plan_finalize: [...input.registrationsFor('plan_finalize')],
  };
  const persistableStore = (versionStateOf: (slotId: string) => 'set' | 'unset' | 'rewrite_required') =>
    new ContentPlanMemoryBlobStore(contentPlanEnrichment({ slotTypeOf: input.slotTypeOf, versionStateOf }));
  const resolveRequired = async <T>(taskId: string, ref: BlobRefV2, label: string): Promise<T> => {
    const value = await input.resolve(taskId, ref);
    if (value === null || typeof value !== 'object') throw new Error(`${label} is unresolvable`);
    return value as T;
  };
  const deps: MigrationServiceDependenciesV2 = {
    ...input,
    async readCurrentAuthority(taskId, workItemId) {
      const state = await input.readProjection(taskId);
      const wi = state.workItems[workItemId];
      const base = wi === undefined ? null : await input.resolve(taskId, wi.authorityBaseRef) as AuthorityBaseSetV2 | null;
      const round = base?.reviewRoundRef === null || base?.reviewRoundRef === undefined
        ? null
        : await input.resolve(taskId, base.reviewRoundRef) as MapReviewRoundV2 | null;
      return {
        activeMapRef: state.currentMap?.mapSnapshotRef ?? null,
        activeManifestRef: state.currentManifest?.contentRevisionManifestRef ?? null,
        currentCandidateRef: state.currentCandidate?.candidateRef ?? null,
        migrationValidationPlanId: state.migrationValidationPlan?.migrationValidationPlanId ?? null,
        migrationSettled: state.migrationSettled,
        workItemPayloadRef: wi?.payloadRef ?? null,
        workItemAuthorityBaseRef: wi?.authorityBaseRef ?? null,
        reviewRoundRef: base?.reviewRoundRef ?? null,
        reviewRoundState: round === null ? null : state.mapRounds[round.mapReviewRoundId]?.state ?? null,
      };
    },
    async localValidatorCustody({ taskId, slotId, decision, plan }) {
      const version = await resolveRequired<SlotContentVersionV2>(taskId, decision.sourceVersionRef, 'migration source version');
      if (version.state !== 'set') throw new Error(`migration validatable slot '${slotId}' source is not set`);
      const aggregateRef = aggregateRefOfVersion(version);
      if (aggregateRef === null) throw new Error(`migration validatable slot '${slotId}' lacks source aggregate custody`);
      const aggregate = await resolveRequired<ValidatorAggregateV2>(taskId, aggregateRef, 'source validator aggregate');
      const envelope = await resolveRequired<{ selectedTargetRefs: readonly BlobRefV2[] }>(taskId, aggregate.inputRef, 'source validator envelope');
      const content = await resolveRequired<unknown>(taskId, version.blobRef, 'source content bytes');
      const intent = await resolveRequired<ContentMigrationIntentCoreV2>(taskId, plan.migrationIntentCoreRef, 'migration intent');
      const sourceMap = await resolveRequired<MapSnapshotV2>(taskId, intent.sourceMapRef, 'source Map');
      const targetMap = await resolveRequired<MapSnapshotV2>(taskId, intent.targetMapRef, 'target Map');
      const sourceLocal = localMapDimensions(sourceMap, slotId);
      const targetLocal = localMapDimensions(targetMap, slotId);
      return {
        sourceBatchInputRef: aggregate.inputRef,
        source: {
          frozenRegistrationSetDigest: aggregate.registrationSetDigest,
          selectorExpansionDigest: canonicalJsonSha256(envelope.selectedTargetRefs),
          contentBytesDigest: canonicalJsonSha256(content),
          localMapSubgraphDigest: sourceLocal.subgraph,
          localRelationContextDigest: sourceLocal.relations,
        },
        target: {
          frozenRegistrationSetDigest: registrationSetDigestOf(registrations.batch_commit),
          selectorExpansionDigest: canonicalJsonSha256([version.blobRef]),
          contentBytesDigest: canonicalJsonSha256(content),
          localMapSubgraphDigest: targetLocal.subgraph,
          localRelationContextDigest: targetLocal.relations,
        },
      };
    },
    async freshValidate({ taskId, slotId, decision, plan, planSpecRef, batchOrdinal }) {
      const version = await resolveRequired<SlotContentVersionV2>(taskId, decision.sourceVersionRef, 'migration source version');
      if (version.state !== 'set') throw new Error(`migration validatable slot '${slotId}' source is not set`);
      const content = await resolveRequired<unknown>(taskId, version.blobRef, 'migration source content');
      const intent = await resolveRequired<ContentMigrationIntentCoreV2>(taskId, plan.migrationIntentCoreRef, 'migration intent');
      const core = buildContentRevisionCommitCore({
        priorManifestRef: plan.sourceManifestRef,
        producerPlanSpecRef: planSpecRef,
        batchOrdinal,
        authorizedReplacementEntriesWithoutValidation: [{ slotId, expectedCurrentVersionRef: decision.sourceVersionRef }],
        expectedMapRef: intent.targetMapRef,
      });
      const store = persistableStore(() => 'set');
      const coreRef = store.put('content_revision_commit_core', core);
      const targetRef = store.put('content_value', content);
      const engine = new ValidatorEngine({ registry: input.validatorRegistry, blobs: store, sourceResolver: input.sourceResolver });
      const run = await engine.execute({
        trigger: 'content_commit', executionPhase: 'batch_commit',
        identity: { taskId, templateSnapshotHash: input.templateSnapshotHash, workItemId: `migration-${plan.migrationValidationPlanId}-${batchOrdinal}`, attemptId: null, commandId: `migration-batch-${batchOrdinal}` },
        coreRef, selectedTargetRefs: [targetRef], registrations: registrations.batch_commit,
        universe: { slotIds: [slotId], relationIds: [], mapNodeIds: [], artifactDigest: null },
        slotTypes: input.slotTypes, context: { requiredSlotIds: [slotId] }, profile: input.profileBody,
      });
      const findings = findingsFromValidatorRun(run, plan.migrationValidationPlanId);
      const produced = runPreparedBlobs(store, run, findings);
      if (run.aggregate.outcome === 'clear') {
        return { slotResult: { outcome: 'revalidated', slotId, validatorAggregateRef: run.aggregateRef, warningRootRef: run.warningRootRef }, batchOutcome: 'clear', preparedBlobs: produced.preparedBlobs };
      }
      if (run.aggregate.outcome === 'infrastructure_failure') {
        return { slotResult: { outcome: 'revalidated', slotId, validatorAggregateRef: run.aggregateRef, warningRootRef: run.warningRootRef }, batchOutcome: 'infrastructure_failure', preparedBlobs: produced.preparedBlobs };
      }
      const receipt = run.receipts.find((candidate) => candidate.blockerIssues.length > 0);
      if (receipt === undefined || produced.findingSet === null) throw new Error('blocking migration batch lacks receipt/FindingSet custody');
      return {
        slotResult: { outcome: 'rejected', slotId, validatorAggregateRef: run.aggregateRef, validationReceiptRef: refOfBlob('validation_receipt', receipt), findingSetRef: refOfBlob('finding_set', produced.findingSet) },
        batchOutcome: routeOfBlockingFindings(findings), preparedBlobs: produced.preparedBlobs,
      };
    },
    async runMigrationFinalizer({ taskId, finalizeCore, finalizeCoreRef, provisionalManifestRef, targetMapRef }) {
      const manifest = await resolveRequired<ContentRevisionManifestV2>(taskId, provisionalManifestRef, 'migration provisional manifest');
      const versions = new Map<string, SlotContentVersionV2>();
      for (const entry of manifest.entries) versions.set(entry.slotId, await resolveRequired<SlotContentVersionV2>(taskId, entry.versionRef, `migration version ${entry.slotId}`));
      const store = persistableStore((slotId) => versions.get(slotId)?.state ?? 'unset');
      store.put('content_plan_finalize_core', finalizeCore);
      store.put('content_revision_manifest', manifest);
      const requiredSlotIds = await input.requiredSlotIdsOf(taskId, targetMapRef);
      const engine = new ValidatorEngine({ registry: input.validatorRegistry, blobs: store, sourceResolver: input.sourceResolver });
      const run = await engine.execute({
        trigger: 'content_commit', executionPhase: 'plan_finalize',
        identity: { taskId, templateSnapshotHash: input.templateSnapshotHash, workItemId: `migration-finalize-${finalizeCoreRef.digest.slice(0, 12)}`, attemptId: null, commandId: `migration-finalize-${finalizeCoreRef.digest.slice(0, 12)}` },
        coreRef: finalizeCoreRef, selectedTargetRefs: [], registrations: registrations.plan_finalize,
        universe: { slotIds: [...versions.keys()].sort(), relationIds: [], mapNodeIds: [], artifactDigest: null },
        slotTypes: input.slotTypes, context: { requiredSlotIds: [...requiredSlotIds].sort() }, profile: input.profileBody,
      });
      const findings = findingsFromValidatorRun(run, `migration-finalizer-${finalizeCoreRef.digest.slice(0, 12)}`);
      const produced = runPreparedBlobs(store, run, findings);
      return {
        finalizerAggregateRef: run.aggregateRef,
        finalizerWarningRootRef: run.warningRootRef,
        routeOutcome: run.aggregate.outcome === 'infrastructure_failure' ? 'infrastructure_failure' : routeOfBlockingFindings(findings),
        classifiedFindingSetRef: produced.findingSet === null ? null : refOfBlob('finding_set', produced.findingSet),
        preparedBlobs: produced.preparedBlobs,
      };
    },
    async prepareActivationRoute(routeInput) {
      if (routeInput.route === 'clear') return input.reviewCoordinator.prepareClearActivation(routeInput);
      if (routeInput.route === 'content_repair') return input.repairCoordinator.prepareContentRepairActivation(routeInput);
      return input.repairCoordinator.prepareMapRepair(routeInput);
    },
  };
  const service = new MigrationServiceV2(deps);
  input.systemCommands.replace(createMigrationValidationBatchSystemCommandHandler(service));
  return { service, systemCommands: input.systemCommands };
}

export interface BeginMigrationInputV2 {
  taskId: string;
  commandId: string;
  workItemId: string;
  leaseEpoch: number;
  authorityBaseRef: BlobRefV2;
  mapReviewSettlementCoreRef: BlobRefV2;
  reviewCoverageCoreRef: BlobRefV2;
  reviewRoundRef: BlobRefV2;
  candidateRef: BlobRefV2;
  proposedMapCoreRef: BlobRefV2;
  sourceManifestRef: BlobRefV2;
  sourceMapRef: BlobRefV2;
  targetMapRef: BlobRefV2;
  impactClosureRef: BlobRefV2;
  targetSlots: readonly MigrationTargetSlotV2[];
  batchSize: number;
}

export interface PreparedMigrationPlanV2 {
  migrationSpecRef: BlobRefV2;
  migrationIntentCoreRef: BlobRefV2;
  migrationValidationPlanSpecRef: BlobRefV2;
  successorWorkItemId: string;
  resultRefs: readonly BlobRefV2[];
}

export interface ExecuteMigrationBatchInputV2 {
  taskId: string;
  commandId: string;
  workItemId: string;
  leaseEpoch: number;
  authorityBaseRef: BlobRefV2;
  planSpecRef: BlobRefV2;
  reviewCoverageCoreRef: BlobRefV2;
  reviewRoundRef: BlobRefV2;
}

export type ExecuteMigrationBatchResultV2 =
  | {
      kind: 'completed';
      batchOrdinal: number;
      batchResultRootRef: BlobRefV2;
      successorWorkItemId: string;
      resultRefs: readonly BlobRefV2[];
    }
  | {
      kind: 'retryable_failure';
      batchOrdinal: number;
      failureCode: string;
      failureDigest: string;
      validatorAggregateRef: BlobRefV2;
      resultRefs: readonly BlobRefV2[];
    };

export interface ExecutePostMigrationSettlementInputV2 {
  taskId: string;
  commandId: string;
  workItemId: string;
  leaseEpoch: number;
  authorityBaseRef: BlobRefV2;
  planSpecRef: BlobRefV2;
  reviewCoverageCoreRef: BlobRefV2;
  reviewRoundRef: BlobRefV2;
  settlementOperationId: string;
}

function migrationIdOf(input: Pick<BeginMigrationInputV2, 'taskId' | 'candidateRef' | 'sourceManifestRef'>): string {
  return `migration-${canonicalJsonSha256(input).slice(0, 24)}`;
}

function migrationPlanIdOf(migrationId: string, intentDigest: string): string {
  return `mvp-${canonicalJsonSha256({ migrationId, intentDigest }).slice(0, 24)}`;
}

function migrationWorkItemId(planId: string, label: string | number): string {
  return `wi-migration-${canonicalJsonSha256({ planId, label }).slice(0, 24)}`;
}

/**
 * The persistent Task 20 coordinator. It owns only system-generated immutable
 * objects and publishes through the append facade; no Agent is involved.
 */
export class MigrationServiceV2 {
  constructor(private readonly deps: MigrationServiceDependenciesV2) {}

  async beginMigration(input: BeginMigrationInputV2): Promise<PreparedMigrationPlanV2> {
    const migrationId = migrationIdOf(input);
    const spec = buildContentMigrationSpec({
      migrationId,
      mapReviewSettlementCoreRef: input.mapReviewSettlementCoreRef,
      sourceManifestRef: input.sourceManifestRef,
      sourceMapRef: input.sourceMapRef,
      targetMapRef: input.targetMapRef,
      impactClosureRef: input.impactClosureRef,
      migrationPolicyVersion: this.deps.migrationPolicyVersion,
    });
    const migrationSpecRef = await this.deps.facade.prepareBlob(input.taskId, 'migration_spec', spec);
    const preparedRefs: BlobRefV2[] = [migrationSpecRef];
    const decisions: MigrationIntentDecisionV2[] = [];
    for (const target of [...input.targetSlots].sort((a, b) => a.slotId.localeCompare(b.slotId))) {
      const classified = classifyMigrationSlot({
        taskId: input.taskId,
        slotId: target.slotId,
        source: target.source,
        sourceMapRef: input.sourceMapRef,
        targetMapRef: input.targetMapRef,
        targetContentSchemaDigest: target.targetContentSchemaDigest,
        targetPresence: target.targetPresence,
        stableIdentityEvidenceRef: input.candidateRef,
        proofPolicyVersion: this.deps.migrationPolicyVersion,
        mixedFindingStageRootRef: target.mixedFindingStageRootRef,
      });
      decisions.push(classified.decision);
      if (classified.compatibilityProof !== null) {
        preparedRefs.push(await this.deps.facade.prepareBlob(input.taskId, 'content_compatibility_proof', classified.compatibilityProof));
      }
    }
    const intent = buildMigrationIntent({
      taskId: input.taskId,
      migrationSpecRef,
      sourceManifestRef: input.sourceManifestRef,
      sourceMapRef: input.sourceMapRef,
      targetMapRef: input.targetMapRef,
      decisions,
      impactClosureRef: input.impactClosureRef,
      migrationPolicyVersion: this.deps.migrationPolicyVersion,
    });
    const intentRef = await this.deps.facade.prepareBlob(input.taskId, 'migration_intent_core', intent);
    preparedRefs.push(intentRef);
    const validationSlotIds = decisions.filter((decision) => decision.action === 'inherit_or_validate').map((decision) => decision.slotId);
    const orderedBatchSlotIds = partitionMigrationValidationBatches(validationSlotIds, input.batchSize);
    // Keep an explicit one-batch closure for the no-validator case. The batch
    // result is still the durable proof that every target action was examined.
    const frozenBatches = orderedBatchSlotIds;
    const plan = withDigest({
      migrationValidationPlanId: migrationPlanIdOf(migrationId, intent.coreDigest),
      migrationIntentCoreRef: intentRef,
      candidateRef: input.candidateRef,
      proposedMapCoreRef: input.proposedMapCoreRef,
      sourceManifestRef: input.sourceManifestRef,
      frozenRegistrationSetDigest: this.deps.frozenRegistrationSetDigest,
      orderedBatchSlotIds: frozenBatches,
      profileRef: this.deps.profileSnapshotRef,
    }, 'specDigest') as ContentMigrationValidationPlanSpecV2;
    const planRef = await this.deps.facade.prepareBlob(input.taskId, 'migration_validation_plan_spec', plan);
    preparedRefs.push(planRef);
    const successor = await this.prepareSuccessor({
      taskId: input.taskId,
      plan,
      planRef,
      candidateRef: input.candidateRef,
      sourceManifestRef: input.sourceManifestRef,
      reviewCoverageCoreRef: input.reviewCoverageCoreRef,
      reviewRoundRef: input.reviewRoundRef,
      nextOrdinal: frozenBatches.length === 0 ? null : 0,
    });
    preparedRefs.push(successor.authorityBaseRef);
    const terminal: SystemCommandTerminalCarrierV2 = {
      workItemId: input.workItemId,
      commandId: input.commandId,
      commandKind: 'review_settlement',
      leaseEpoch: input.leaseEpoch,
      authorityBaseRef: input.authorityBaseRef,
    };
    const operationId = attemptContinuationOperationId(input.taskId, input.workItemId, input.commandId, 'complete');
    const tail = await this.deps.tail(input.taskId);
    await this.deps.facade.publishWithPin({
      taskId: input.taskId,
      operationId,
      payload: {
        family: 'domain_publish', operationId, taskId: input.taskId,
        publishKind: 'migration_settlement', blobRefs: preparedRefs,
        expectedResultIdentity: canonicalJsonSha256({ operationId, stage: 'initial' }),
        mapBuild: null, contentPlan: null, contentReview: null, repair: null,
        mapReview: mapReviewCarrier({ migrationProgress: {
          stage: 'initial', migrationValidationPlanId: plan.migrationValidationPlanId,
          intentCoreRef: intentRef, planSpecRef: planRef,
          batchOrdinal: null, batchResultRootRef: null, batchOutcome: null,
          successor, terminal,
        } }),
      },
      intent: { handlerKind: 'migration_settlement', handlerVersion: 1 },
      preparedRefs,
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    return {
      migrationSpecRef,
      migrationIntentCoreRef: intentRef,
      migrationValidationPlanSpecRef: planRef,
      successorWorkItemId: successor.workItemId,
      resultRefs: preparedRefs,
    };
  }

  async executeNextBatch(input: ExecuteMigrationBatchInputV2): Promise<ExecuteMigrationBatchResultV2> {
    const plan = await this.resolveAs<ContentMigrationValidationPlanSpecV2>(input.taskId, input.planSpecRef, 'migration validation plan');
    const completed = await this.deps.completedBatches(input.taskId, input.planSpecRef);
    const ordinal = nextMissingMigrationBatchOrdinal(plan, completed);
    if (ordinal === null) throw new Error('migration validation plan is already complete');
    const intent = await this.resolveAs<ContentMigrationIntentCoreV2>(input.taskId, plan.migrationIntentCoreRef, 'migration intent');
    const bySlot = new Map(intent.decisions.map((decision) => [decision.slotId, decision]));
    const slotResults: MigrationBatchSlotResultV2[] = [];
    const preparedRefs: BlobRefV2[] = [];
    let batchOutcome: MigrationBatchRouteOutcomeV2 = 'clear';
    for (const slotId of plan.orderedBatchSlotIds[ordinal]) {
      const decision = bySlot.get(slotId);
      if (decision === undefined || decision.action !== 'inherit_or_validate') {
        throw new Error(`migration validation batch references non-validatable slot '${slotId}'`);
      }
      const custody = await this.deps.localValidatorCustody({ taskId: input.taskId, slotId, decision, plan });
      const equivalence = proveLocalValidatorEquivalence({
        slotId,
        sourceVersionRef: decision.sourceVersionRef,
        sourceMapRef: intent.sourceMapRef,
        targetMapRef: intent.targetMapRef,
        sourceBatchInputRef: custody.sourceBatchInputRef,
        equivalencePolicyVersion: this.deps.equivalencePolicyVersion,
        source: custody.source,
        target: custody.target,
      });
      if (equivalence.kind === 'equivalent') {
        const proofRef = await this.deps.facade.prepareBlob(input.taskId, 'local_validator_equivalence_proof', equivalence.proof);
        preparedRefs.push(proofRef);
        slotResults.push({ outcome: 'equivalent', slotId, localValidatorEquivalenceProofRef: proofRef });
      } else {
        const fresh = await this.deps.freshValidate({
          taskId: input.taskId, slotId, decision, plan, planSpecRef: input.planSpecRef, batchOrdinal: ordinal,
        });
        for (const blob of fresh.preparedBlobs) {
          preparedRefs.push(await this.deps.facade.prepareBlob(input.taskId, blob.kind, blob.value));
        }
        if (fresh.batchOutcome === 'infrastructure_failure') {
          const validatorAggregateRef = fresh.slotResult.outcome === 'equivalent'
            ? null
            : fresh.slotResult.validatorAggregateRef;
          if (validatorAggregateRef === null) {
            throw new Error(`migration infrastructure failure for '${slotId}' lacks validator aggregate custody`);
          }
          return {
            kind: 'retryable_failure',
            batchOrdinal: ordinal,
            failureCode: 'VALIDATOR_INFRASTRUCTURE_FAILURE',
            failureDigest: canonicalJsonSha256({
              planSpecRef: input.planSpecRef,
              batchOrdinal: ordinal,
              validatorAggregateRef,
            }),
            validatorAggregateRef,
            resultRefs: [...preparedRefs, validatorAggregateRef],
          };
        }
        slotResults.push(fresh.slotResult);
        batchOutcome = combineMigrationRoute(batchOutcome, fresh.batchOutcome);
      }
    }
    const result = buildMigrationValidationBatchResult({
      migrationValidationPlanSpecRef: input.planSpecRef,
      batchOrdinal: ordinal,
      slotResults,
      batchOutcome,
    });
    const resultRef = await this.deps.facade.prepareBlob(input.taskId, 'migration_validation_batch_result', result);
    preparedRefs.push(input.planSpecRef, resultRef);
    const nextOrdinal = ordinal + 1 < plan.orderedBatchSlotIds.length ? ordinal + 1 : null;
    const successor = await this.prepareSuccessor({
      taskId: input.taskId,
      plan,
      planRef: input.planSpecRef,
      candidateRef: plan.candidateRef,
      sourceManifestRef: plan.sourceManifestRef,
      reviewCoverageCoreRef: input.reviewCoverageCoreRef,
      reviewRoundRef: input.reviewRoundRef,
      nextOrdinal,
    });
    preparedRefs.push(successor.authorityBaseRef);
    const terminal: SystemCommandTerminalCarrierV2 = {
      workItemId: input.workItemId,
      commandId: input.commandId,
      commandKind: 'migration_validation_batch',
      leaseEpoch: input.leaseEpoch,
      authorityBaseRef: input.authorityBaseRef,
    };
    const operationId = attemptContinuationOperationId(input.taskId, input.workItemId, input.commandId, 'complete');
    const tail = await this.deps.tail(input.taskId);
    await this.deps.facade.publishWithPin({
      taskId: input.taskId,
      operationId,
      payload: {
        family: 'domain_publish', operationId, taskId: input.taskId,
        publishKind: 'migration_settlement', blobRefs: preparedRefs,
        expectedResultIdentity: canonicalJsonSha256({ operationId, stage: 'batch', ordinal }),
        mapBuild: null, contentPlan: null, contentReview: null, repair: null,
        mapReview: mapReviewCarrier({ migrationProgress: {
          stage: 'batch', migrationValidationPlanId: null, intentCoreRef: null,
          planSpecRef: input.planSpecRef, batchOrdinal: ordinal,
          batchResultRootRef: resultRef, batchOutcome, successor, terminal,
        } }),
      },
      intent: { handlerKind: 'migration_settlement', handlerVersion: 1 },
      preparedRefs,
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    return { kind: 'completed', batchOrdinal: ordinal, batchResultRootRef: resultRef, successorWorkItemId: successor.workItemId, resultRefs: preparedRefs };
  }

  async executeMigrationBatchCommand(input: {
    taskId: string; commandId: string; workItemId: string; leaseEpoch: number;
    authorityBaseRef: BlobRefV2; planSpecRef: BlobRefV2;
  }): Promise<
    | { kind: 'completed'; resultRefs: readonly BlobRefV2[] }
    | {
        kind: 'retryable_failure';
        failureCode: string;
        failureDigest: string;
        validatorAggregateRef?: BlobRefV2 | null;
      }
  > {
    try {
      const base = await this.resolveAs<{ reviewRoundRef: BlobRefV2 | null }>(input.taskId, input.authorityBaseRef, 'migration batch authority base');
      if (base.reviewRoundRef === null) throw new Error('migration batch authority base lacks reviewRoundRef');
      const plan = await this.resolveAs<ContentMigrationValidationPlanSpecV2>(input.taskId, input.planSpecRef, 'migration validation plan');
      const intent = await this.resolveAs<ContentMigrationIntentCoreV2>(input.taskId, plan.migrationIntentCoreRef, 'migration intent');
      const spec = await this.resolveAs<ContentMigrationSpecV2>(input.taskId, intent.migrationSpecRef, 'migration spec');
      const mapSettlement = await this.resolveAs<MapReviewSettlementCoreV2>(input.taskId, spec.mapReviewSettlementCoreRef, 'map review settlement core');
      const result = await this.executeNextBatch({ ...input, reviewCoverageCoreRef: mapSettlement.coverageCoreRef, reviewRoundRef: base.reviewRoundRef });
      if (result.kind === 'retryable_failure') return result;
      return { kind: 'completed', resultRefs: result.resultRefs };
    } catch (error) {
      return { kind: 'retryable_failure', failureCode: 'MIGRATION_VALIDATION_BATCH_FAILED', failureDigest: canonicalJsonSha256({ commandId: input.commandId, error: (error as Error).message }) };
    }
  }

  async executePostMigrationSettlement(input: ExecutePostMigrationSettlementInputV2): Promise<
    | { kind: 'completed'; route: Exclude<MigrationBatchRouteOutcomeV2, 'infrastructure_failure'>; resultRefs: readonly BlobRefV2[] }
    | { kind: 'retryable_failure'; failureCode: string; failureDigest: string; validatorAggregateRef?: BlobRefV2 | null }
  > {
    const plan = await this.resolveAs<ContentMigrationValidationPlanSpecV2>(input.taskId, input.planSpecRef, 'migration validation plan');
    const intent = await this.resolveAs<ContentMigrationIntentCoreV2>(input.taskId, plan.migrationIntentCoreRef, 'migration intent');
    await this.assertPostMigrationAuthorityCurrent(input, plan, intent);
    const completed = await this.deps.completedBatches(input.taskId, input.planSpecRef);
    const orderedResultRefs = validateMigrationBatchClosure(plan, completed);
    const classifiedBatches = await validateAndClassifyMigrationBatchResults({
      plan,
      planSpecRef: input.planSpecRef,
      orderedResultRefs,
      resolve: (ref) => this.deps.resolve(input.taskId, ref),
    });
    const resultBySlot = classifiedBatches.resultBySlot;
    let batchRouteOutcome = classifiedBatches.batchRouteOutcome;
    const rejectedFindingSetRefs = classifiedBatches.rejectedFindingSetRefs;
    const settlementDecisions: MigrationSettlementOutcomeV2[] = [];
    for (const decision of intent.decisions) {
      if (decision.action === 'carry_unset') {
        settlementDecisions.push({ outcome: 'carry_unset', slotId: decision.slotId, sourceVersionRef: decision.sourceVersionRef, compatibilityProofRef: decision.compatibilityProofRef });
      } else if (decision.action === 'new_or_schema_reset') {
        settlementDecisions.push({ outcome: 'unset', slotId: decision.slotId, unsetReason: decision.unsetReason });
      } else if (decision.action === 'rewrite_required') {
        settlementDecisions.push({
          outcome: 'rewrite_required', slotId: decision.slotId, sourceVersionRef: decision.sourceVersionRef,
          rewriteCause: 'mixed_rewrite_required', blockingValidatorAggregateRef: null,
          validationReceiptRef: null, findingStageRootRef: decision.findingStageRootRef,
        });
        batchRouteOutcome = combineMigrationRoute(batchRouteOutcome, 'map_repair');
      } else {
        const slotResult = resultBySlot.get(decision.slotId);
        if (slotResult === undefined) throw new Error(`migration slot '${decision.slotId}' lacks a terminal validator result`);
        if (slotResult.outcome === 'equivalent') {
          settlementDecisions.push({
            outcome: 'inherit_equivalent', slotId: decision.slotId, sourceVersionRef: decision.sourceVersionRef,
            compatibilityProofRef: decision.compatibilityProofRef,
            localValidatorEquivalenceProofRef: slotResult.localValidatorEquivalenceProofRef,
          });
        } else if (slotResult.outcome === 'revalidated') {
          settlementDecisions.push({
            outcome: 'inherit_revalidated', slotId: decision.slotId, sourceVersionRef: decision.sourceVersionRef,
            compatibilityProofRef: decision.compatibilityProofRef,
            migratedBatchValidatorAggregateRef: slotResult.validatorAggregateRef,
            migratedBatchWarningRootRef: slotResult.warningRootRef,
          });
        } else {
          settlementDecisions.push({
            outcome: 'rewrite_required', slotId: decision.slotId, sourceVersionRef: decision.sourceVersionRef,
            rewriteCause: 'validation_rejected', blockingValidatorAggregateRef: slotResult.validatorAggregateRef,
            validationReceiptRef: slotResult.validationReceiptRef, findingStageRootRef: null,
          });
        }
      }
    }
    let batchClassifiedFindingSetRef: BlobRefV2 | null = null;
    const preparedRefs: BlobRefV2[] = [...orderedResultRefs];
    const batchFindings = await classifyAndUnionMigrationFindingSets({
      findingSetRefs: classifiedBatches.findingSetRefs,
      resolve: (ref) => this.deps.resolve(input.taskId, ref),
    });
    if (batchFindings.findingSet !== null) {
      batchClassifiedFindingSetRef = await this.deps.facade.prepareBlob(input.taskId, 'finding_set', batchFindings.findingSet);
      preparedRefs.push(batchClassifiedFindingSetRef);
    }
    const settlement = buildMigrationSettlement({
      migrationIntentCoreRef: plan.migrationIntentCoreRef,
      migrationValidationPlanSpecRef: input.planSpecRef,
      orderedBatches: completed,
      decisions: settlementDecisions,
      batchClassifiedFindingSetRef,
      batchRouteOutcome,
    });
    const settlementRef = await this.deps.facade.prepareBlob(input.taskId, 'migration_settlement_core', settlement);
    preparedRefs.push(settlementRef);
    const sourceManifest = await this.resolveAs<ContentRevisionManifestV2>(input.taskId, plan.sourceManifestRef, 'source manifest');
    const sourceVersions = new Map<string, SlotContentVersionV2>();
    for (const entry of sourceManifest.entries) sourceVersions.set(entry.versionRef.digest, await this.resolveAs<SlotContentVersionV2>(input.taskId, entry.versionRef, `source version ${entry.slotId}`));
    const targetMap = await this.resolveAs<MapSnapshotV2>(input.taskId, intent.targetMapRef, 'target Map');
    const proposedMap = await this.resolveAs<ProposedMapCoreV2>(input.taskId, plan.proposedMapCoreRef, 'proposed Map');
    const schemaBySlot = new Map(proposedMap.nodes.filter((node) => node.contentBearing).map((node) => [node.slotId, canonicalJsonSha256({ slotType: node.slotType })]));
    const migrated = buildMigratedProvisionalManifest({
      taskId: input.taskId,
      targetMapRef: intent.targetMapRef,
      targetMapSemanticDigest: targetMap.mapSemanticDigest,
      taskContentRevision: sourceManifest.taskContentRevision + 1,
      producerPlanSpecRef: input.planSpecRef,
      priorManifestRef: plan.sourceManifestRef,
      migrationSettlementCoreRef: settlementRef,
      decisions: settlementDecisions,
      sourceVersions,
      targetSchemaDigestOf: (slotId) => {
        const digest = schemaBySlot.get(slotId);
        if (digest === undefined) throw new Error(`target schema missing for migration slot '${slotId}'`);
        return digest;
      },
      rejectedFindingSetRefsBySlot: rejectedFindingSetRefs,
    });
    for (const version of migrated.versions.values()) preparedRefs.push(await this.deps.facade.prepareBlob(input.taskId, 'content_version', version));
    const provisionalManifestRef = await this.deps.facade.prepareBlob(input.taskId, 'content_revision_manifest', migrated.manifest);
    preparedRefs.push(provisionalManifestRef);
    const finalizeCore = buildMigrationFinalizeCore({
      producerPlanSpecRef: input.planSpecRef,
      provisionalManifestRef,
      candidateRef: plan.candidateRef,
      proposedMapCoreRef: plan.proposedMapCoreRef,
      targetMapRef: intent.targetMapRef,
      migrationSettlementCoreRef: settlementRef,
      settlementOperationId: input.settlementOperationId,
      expectedContentRootDigest: migrated.manifest.contentRootDigest,
      requiredSlotCoverageDigest: canonicalJsonSha256(migrated.manifest.entries.map((entry) => entry.slotId)),
      expectedBatchClosureDigest: canonicalJsonSha256(orderedResultRefs),
    });
    const finalizeCoreRef = await this.deps.facade.prepareBlob(input.taskId, 'content_plan_finalize_core', finalizeCore);
    preparedRefs.push(finalizeCoreRef);
    const finalizer = await this.deps.runMigrationFinalizer({
      taskId: input.taskId, finalizeCore, finalizeCoreRef, provisionalManifestRef, targetMapRef: intent.targetMapRef,
    });
    for (const blob of finalizer.preparedBlobs) preparedRefs.push(await this.deps.facade.prepareBlob(input.taskId, blob.kind, blob.value));
    preparedRefs.push(finalizer.finalizerAggregateRef, finalizer.finalizerWarningRootRef);
    const finalizerAggregate = await this.resolveAs<ValidatorAggregateV2>(input.taskId, finalizer.finalizerAggregateRef, 'migration finalizer aggregate');
    let derivedFinalizerRoute: MigrationBatchRouteOutcomeV2;
    if (finalizerAggregate.outcome === 'infrastructure_failure') {
      derivedFinalizerRoute = 'infrastructure_failure';
    } else if (finalizerAggregate.outcome === 'clear') {
      if (finalizer.classifiedFindingSetRef !== null) throw new Error('clear migration finalizer cannot carry a classified FindingSet');
      derivedFinalizerRoute = 'clear';
    } else {
      if (finalizer.classifiedFindingSetRef === null) throw new Error('blocking migration finalizer lacks classified FindingSet custody');
      derivedFinalizerRoute = (await classifyAndUnionMigrationFindingSets({
        findingSetRefs: [finalizer.classifiedFindingSetRef],
        resolve: (ref) => this.deps.resolve(input.taskId, ref),
      })).routeOutcome;
      if (derivedFinalizerRoute === 'clear') throw new Error('blocking migration finalizer FindingSet contains no blocking Finding');
    }
    if (derivedFinalizerRoute !== finalizer.routeOutcome) {
      throw new Error(`migration finalizer route '${finalizer.routeOutcome}' does not equal derived '${derivedFinalizerRoute}'`);
    }
    const combinedFindings = await classifyAndUnionMigrationFindingSets({
      findingSetRefs: [
        ...classifiedBatches.findingSetRefs,
        ...(finalizer.classifiedFindingSetRef === null ? [] : [finalizer.classifiedFindingSetRef]),
      ],
      resolve: (ref) => this.deps.resolve(input.taskId, ref),
    });
    let combinedClassifiedFindingSetRef: BlobRefV2 | null = null;
    if (combinedFindings.findingSet !== null) {
      combinedClassifiedFindingSetRef = await this.deps.facade.prepareBlob(input.taskId, 'finding_set', combinedFindings.findingSet);
      preparedRefs.push(combinedClassifiedFindingSetRef);
    }
    const decision = buildMigrationActivationDecision({
      migrationSettlementCoreRef: settlementRef,
      provisionalManifestRef,
      contentPlanFinalizeCoreRef: finalizeCoreRef,
      finalizerAggregateRef: finalizer.finalizerAggregateRef,
      combinedClassifiedFindingSetRef,
      batchRouteOutcome,
      finalizerRouteOutcome: derivedFinalizerRoute,
      decisionPolicyVersion: this.deps.migrationPolicyVersion,
    });
    const decisionRef = await this.deps.facade.prepareBlob(input.taskId, 'migration_activation_decision', decision);
    preparedRefs.push(decisionRef);
    if (decision.combinedRouteOutcome === 'infrastructure_failure') {
      return {
        kind: 'retryable_failure',
        failureCode: 'VALIDATOR_INFRASTRUCTURE_FAILURE',
        failureDigest: canonicalJsonSha256({ commandId: input.commandId, aggregateRef: finalizer.finalizerAggregateRef }),
        validatorAggregateRef: finalizer.finalizerAggregateRef,
      };
    }
    let migratedManifestRef = provisionalManifestRef;
    if (decision.combinedRouteOutcome === 'clear') {
      const finalized = computeProvisionalOrFinalizedManifest({
        taskId: input.taskId, mapRef: intent.targetMapRef, mapSemanticDigest: targetMap.mapSemanticDigest,
        taskContentRevision: migrated.manifest.taskContentRevision, manifestPhase: 'finalized', entries: migrated.manifest.entries,
        producerPlanSpecRef: input.planSpecRef, priorManifestRef: plan.sourceManifestRef,
        finalizerValidatorAggregateRefs: [finalizer.finalizerAggregateRef], finalizerWarningRootRefs: [finalizer.finalizerWarningRootRef],
        resolvedVersions: migrated.versions,
      });
      migratedManifestRef = await this.deps.facade.prepareBlob(input.taskId, 'content_revision_manifest', finalized);
      preparedRefs.push(migratedManifestRef);
    }
    const route = await this.deps.prepareActivationRoute({
      taskId: input.taskId,
      route: decision.combinedRouteOutcome,
      plan,
      sourceManifestRef: plan.sourceManifestRef,
      targetMapRef: intent.targetMapRef,
      migratedManifestRef,
      migrationSettlementCoreRef: settlementRef,
      migrationActivationDecisionRef: decisionRef,
    });
    validateMigrationActivationRouteCarriers(decision.combinedRouteOutcome, route.carriers, migratedManifestRef);
    const terminal: SystemCommandTerminalCarrierV2 = {
      workItemId: input.workItemId, commandId: input.commandId, commandKind: 'review_settlement',
      leaseEpoch: input.leaseEpoch, authorityBaseRef: input.authorityBaseRef,
    };
    const carriers = {
      ...route.carriers,
      migrationSettlementCoreRef: settlementRef,
      migrationActivationDecisionRef: decisionRef,
      migrationProvisionalManifestRef: provisionalManifestRef,
      migrationFinalizerAggregateRef: finalizer.finalizerAggregateRef,
      terminal,
    };
    preparedRefs.push(...route.preparedRefs);
    const operationId = attemptContinuationOperationId(input.taskId, input.workItemId, input.commandId, 'complete');
    // Re-read immediately before the pin. This closes the preparation window:
    // a newer legal Map/manifest/candidate/round makes this command stale and
    // produces zero activation/repair writes.
    await this.assertPostMigrationAuthorityCurrent(input, plan, intent);
    const tail = await this.deps.tail(input.taskId);
    await this.deps.facade.publishWithPin({
      taskId: input.taskId, operationId,
      payload: {
        family: 'domain_publish', operationId, taskId: input.taskId, publishKind: 'map_review_settlement',
        blobRefs: preparedRefs, expectedResultIdentity: canonicalJsonSha256({ operationId, route: decision.combinedRouteOutcome }),
        mapBuild: null, contentPlan: null, contentReview: null, repair: null, mapReview: carriers,
      },
      intent: { handlerKind: 'map_review_settlement', handlerVersion: 1 },
      preparedRefs,
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    return { kind: 'completed', route: decision.combinedRouteOutcome, resultRefs: preparedRefs };
  }

  private async resolveAs<T>(taskId: string, ref: BlobRefV2, label: string): Promise<T> {
    const value = await this.deps.resolve(taskId, ref);
    if (value === null || typeof value !== 'object') throw new Error(`${label} is unresolvable`);
    return value as T;
  }

  private async assertPostMigrationAuthorityCurrent(
    input: ExecutePostMigrationSettlementInputV2,
    plan: ContentMigrationValidationPlanSpecV2,
    intent: ContentMigrationIntentCoreV2,
  ): Promise<void> {
    if (this.deps.readCurrentAuthority === undefined) {
      throw new Error('stale migration authority: current projection reader is not installed');
    }
    const current = await this.deps.readCurrentAuthority(input.taskId, input.workItemId);
    const stale = (condition: boolean, label: string): void => {
      if (condition) throw new Error(`stale migration authority: ${label}`);
    };
    stale(current.activeMapRef === null || !sameRef(current.activeMapRef, intent.sourceMapRef), 'active Map changed');
    stale(current.activeManifestRef === null || !sameRef(current.activeManifestRef, plan.sourceManifestRef), 'active manifest changed');
    stale(current.currentCandidateRef === null || !sameRef(current.currentCandidateRef, plan.candidateRef), 'current candidate changed');
    stale(current.migrationValidationPlanId !== plan.migrationValidationPlanId || current.migrationSettled, 'migration plan is not the current unsettled lineage');
    stale(current.workItemPayloadRef === null || !sameRef(current.workItemPayloadRef, input.planSpecRef), 'work item payload changed');
    stale(current.workItemAuthorityBaseRef === null || !sameRef(current.workItemAuthorityBaseRef, input.authorityBaseRef), 'work item authority base changed');
    stale(current.reviewRoundRef === null || !sameRef(current.reviewRoundRef, input.reviewRoundRef), 'review round changed');
    stale(current.reviewRoundState !== 'completed', 'Map review round is not the expected completed unsettled round');

    const base = await this.resolveAs<AuthorityBaseSetV2>(input.taskId, input.authorityBaseRef, 'post-migration authority base');
    stale(base.mapCandidateRef === null || !sameRef(base.mapCandidateRef, plan.candidateRef), 'authority candidate ref mismatch');
    stale(base.contentRevisionManifestRef === null || !sameRef(base.contentRevisionManifestRef, plan.sourceManifestRef), 'authority manifest ref mismatch');
    stale(base.reviewCoverageCoreRef === null || !sameRef(base.reviewCoverageCoreRef, input.reviewCoverageCoreRef), 'authority coverage ref mismatch');
    stale(base.reviewRoundRef === null || !sameRef(base.reviewRoundRef, input.reviewRoundRef), 'authority round ref mismatch');
    const spec = await this.resolveAs<ContentMigrationSpecV2>(input.taskId, intent.migrationSpecRef, 'migration spec');
    const settlement = await this.resolveAs<MapReviewSettlementCoreV2>(input.taskId, spec.mapReviewSettlementCoreRef, 'migration source Map settlement');
    stale(!sameRef(settlement.coverageCoreRef, input.reviewCoverageCoreRef), 'coverage is not the frozen migration-source settlement coverage');
  }

  private async prepareSuccessor(input: {
    taskId: string;
    plan: ContentMigrationValidationPlanSpecV2;
    planRef: BlobRefV2;
    candidateRef: BlobRefV2;
    sourceManifestRef: BlobRefV2;
    reviewCoverageCoreRef: BlobRefV2;
    reviewRoundRef: BlobRefV2;
    nextOrdinal: number | null;
  }): Promise<SuccessorWorkItemCarrierV2> {
    const isBatch = input.nextOrdinal !== null;
    const kind = isBatch ? 'system_migration_validation_batch' as const : 'system_review_settlement' as const;
    const base = buildAuthorityBaseSet({
      taskId: input.taskId,
      templateSnapshotRef: this.deps.templateSnapshotRef,
      profileSnapshotRef: this.deps.profileSnapshotRef,
      kind,
      refs: isBatch
        ? { mapCandidateRef: input.candidateRef, planSpecRef: input.planRef, reviewRoundRef: input.reviewRoundRef }
        : {
            mapCandidateRef: input.candidateRef,
            contentRevisionManifestRef: input.sourceManifestRef,
            reviewCoverageCoreRef: input.reviewCoverageCoreRef,
            reviewRoundRef: input.reviewRoundRef,
          },
    });
    const authorityBaseRef = await this.deps.facade.prepareBlob(input.taskId, 'authority_base_set', base);
    const carrier: SuccessorWorkItemCarrierV2 = {
      workItemId: migrationWorkItemId(input.plan.migrationValidationPlanId, isBatch ? input.nextOrdinal as number : 'post'),
      kind,
      roleBinding: null,
      agentExecutionKind: null,
      sessionKind: null,
      roundId: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      grantSpecRef: null,
      inputArtifactDeliveryId: null,
      authorityBaseRef,
      payloadRef: input.planRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries: this.deps.maxAutomaticRetries,
    };
    const errors = validateMigrationSuccessorCarrier(carrier, input.planRef, authorityBaseRef);
    if (errors.length > 0) throw new Error(`migration successor invalid: ${errors.join('; ')}`);
    return carrier;
  }
}

function sameRef(a: BlobRefV2, b: BlobRefV2): boolean {
  return a.kind === b.kind && a.digest === b.digest && a.byteLength === b.byteLength && a.mediaType === b.mediaType && a.schemaVersion === b.schemaVersion;
}

export function createMigrationValidationBatchSystemCommandHandler(service: MigrationServiceV2): SystemCommandHandler {
  return {
    commandKind: 'migration_validation_batch',
    async execute(ctx) {
      if (ctx.payloadRef.kind !== 'migration_validation_plan_spec') {
        return { kind: 'retryable_failure', failureCode: 'MIGRATION_PLAN_STALE', failureDigest: canonicalJsonSha256({ commandId: ctx.commandId, payloadRef: ctx.payloadRef }) };
      }
      return await service.executeMigrationBatchCommand({
        taskId: ctx.taskId, commandId: ctx.commandId, workItemId: ctx.workItemId,
        leaseEpoch: ctx.leaseEpoch, authorityBaseRef: ctx.authorityBaseRef, planSpecRef: ctx.payloadRef,
      });
    },
  };
}
