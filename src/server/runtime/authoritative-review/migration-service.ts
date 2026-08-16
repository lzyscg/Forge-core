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
  ValidationReceiptV2,
  ValidationWarningRootV2,
  ValidationWarningCustodyRootV2,
  ValidatorInputEnvelopeV2,
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
import {
  ContentPlanMemoryBlobStore,
  buildContentBatchWarningCustodyRoot,
  buildContentFinalizerWarningCustodyRoot,
  buildContentRevisionCommitCore,
  contentPlanEnrichment,
} from './content-plan-service';
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

async function resolveVerifiedMigrationBlob<T>(input: {
  ref: BlobRefV2;
  kind: Parameters<typeof refOfBlob>[0];
  label: string;
  resolve(ref: BlobRefV2): Promise<unknown> | unknown;
}): Promise<T> {
  const raw = await input.resolve(input.ref);
  if (raw === null || typeof raw !== 'object') throw new Error(`${input.label} is unresolvable`);
  if (!sameRef(refOfBlob(input.kind, raw), input.ref)) {
    throw new Error(`${input.label} bytes do not match its persisted ref`);
  }
  return raw as T;
}

function hasExactRef(refs: readonly BlobRefV2[], expected: BlobRefV2): boolean {
  return refs.some((candidate) => sameRef(candidate, expected));
}

function validateCanonicalSelfDigest(value: Record<string, unknown>, key: string, label: string): void {
  const expected = value[key];
  const body = { ...value };
  delete body[key];
  if (typeof expected !== 'string' || expected !== canonicalJsonSha256(body)) {
    throw new Error(`${label} has an invalid canonical ${key}`);
  }
}

function validateMigrationRepairPlanIdentity(
  plan: import('../../authoritative-review/authority-types').RepairPlanSpecV2,
): void {
  const body = { ...plan } as Record<string, unknown>;
  delete body.specDigest;
  delete body.planRevisionId;
  if (plan.specDigest !== canonicalJsonSha256(body)) {
    throw new Error('migration route RepairPlan has an invalid canonical specDigest');
  }
  const expectedRevisionId = canonicalJsonSha256({
    repairPlanId: plan.repairPlanId,
    revision: plan.revision,
    specDigest: plan.specDigest,
  });
  if (plan.planRevisionId !== expectedRevisionId) {
    throw new Error('migration route RepairPlan has an invalid planRevisionId binding');
  }
}

function validateWarningClosure(input: {
  aggregate: ValidatorAggregateV2;
  warningRef: BlobRefV2;
  warning: ValidationWarningRootV2;
  phase: 'batch_commit' | 'plan_finalize';
}): void {
  validateCanonicalSelfDigest(input.warning as unknown as Record<string, unknown>, 'rootDigest', `migration ${input.phase} warning`);
  if (!sameRef(input.aggregate.warningRootRef, input.warningRef)) throw new Error('migration warning ref does not equal aggregate warning root');
  if (input.warning.trigger !== 'content_commit' || input.warning.executionPhase !== input.phase) {
    throw new Error(`migration ${input.phase} warning has the wrong trigger/executionPhase`);
  }
  if (!sameRef(input.warning.inputRef, input.aggregate.inputRef) || input.warning.inputDigest !== input.aggregate.inputRef.digest) {
    throw new Error(`migration ${input.phase} warning does not bind the aggregate input`);
  }
  const advisory = [...input.aggregate.advisoryReceiptRefs].sort((a, b) => a.digest.localeCompare(b.digest));
  if (canonicalJsonSha256(input.warning.orderedAdvisoryReceiptRefs) !== canonicalJsonSha256(advisory)
    || input.warning.warningCount !== advisory.length) {
    throw new Error(`migration ${input.phase} warning does not close the aggregate advisory receipts`);
  }
}

function validateAggregateOutcomeClosure(aggregate: ValidatorAggregateV2, label: string): void {
  const derived = aggregate.infrastructureFailureRefs.length > 0
    ? 'infrastructure_failure'
    : aggregate.blockingInvalidReceiptRefs.length > 0
      ? 'blocking_invalid'
      : 'clear';
  if (aggregate.outcome !== derived) throw new Error(`${label} outcome is not derived from its receipt/failure closure`);
}

async function validateAdvisoryReceiptClosure(input: {
  aggregate: ValidatorAggregateV2;
  envelopeRef: BlobRefV2;
  coreRef: BlobRefV2;
  targetRefs: readonly BlobRefV2[];
  resolve(ref: BlobRefV2): Promise<unknown> | unknown;
}): Promise<void> {
  for (const receiptRef of input.aggregate.advisoryReceiptRefs) {
    const receipt = await resolveVerifiedMigrationBlob<ValidationReceiptV2>({
      ref: receiptRef, kind: 'validation_receipt', label: 'migration advisory receipt', resolve: input.resolve,
    });
    validateCanonicalSelfDigest(receipt as unknown as Record<string, unknown>, 'receiptDigest', 'migration advisory receipt');
    if (receipt.receiptKind !== 'generation'
      || receiptLineageRef(receipt, 'envelope') === null || !sameRef(receiptLineageRef(receipt, 'envelope')!, input.envelopeRef)
      || receiptLineageRef(receipt, 'core') === null || !sameRef(receiptLineageRef(receipt, 'core')!, input.coreRef)) {
      throw new Error('migration advisory receipt does not bind the validator input/core');
    }
    for (let index = 0; index < input.targetRefs.length; index += 1) {
      const targetRef = receiptLineageRef(receipt, `target.${String(index).padStart(6, '0')}`);
      if (targetRef === null || !sameRef(targetRef, input.targetRefs[index]!)) {
        throw new Error('migration advisory receipt does not bind the selected target bytes');
      }
    }
  }
}

function receiptLineageRef(receipt: ValidationReceiptV2, label: string): BlobRefV2 | null {
  return receipt.lineageRefs.find((entry) => entry.label === label)?.ref ?? null;
}

function findingSupportedByReceipt(finding: FindingV2, receipt: ValidationReceiptV2, aggregateRef: BlobRefV2): boolean {
  if (!finding.evidence.some((evidence) => evidence.refs.some((candidate) => sameRef(candidate, aggregateRef)))) return false;
  return receipt.blockerIssues.some((issue) => {
    const targetIds = new Set([
      issue.location.stableTargetId,
      ...issue.repairTargets.slotIds,
      ...issue.repairTargets.relationIds,
      ...issue.repairTargets.mapNodeIds,
    ]);
    const primaryMatches = finding.primaryLocation.kind === 'map'
      ? issue.location.targetKind === 'map' && finding.primaryLocation.id === issue.location.stableTargetId
      : targetIds.has(finding.primaryLocation.id);
    return finding.evidence.some((evidence) => evidence.evidenceDigest === issue.evidenceDigest)
      && primaryMatches
      && finding.relatedSlotIds.every((slotId) => issue.repairTargets.slotIds.includes(slotId) || issue.repairTargets.mapNodeIds.includes(slotId))
      && finding.relatedRelationIds.every((relationId) => issue.repairTargets.relationIds.includes(relationId));
  });
}

async function validateFindingSetReceiptClosure(input: {
  aggregateRef: BlobRefV2;
  aggregate: ValidatorAggregateV2;
  findingSetRef: BlobRefV2;
  requiredReceiptRef?: BlobRefV2;
  expectedEnvelopeRef: BlobRefV2;
  expectedCoreRef: BlobRefV2;
  expectedTargetRefs: readonly BlobRefV2[];
  expectedRegistrationSetDigest: string;
  resolve(ref: BlobRefV2): Promise<unknown> | unknown;
}): Promise<{ findingSet: FindingSetV2; findings: readonly FindingV2[] }> {
  const findingSet = await resolveVerifiedMigrationBlob<FindingSetV2>({
    ref: input.findingSetRef, kind: 'finding_set', label: 'migration FindingSet', resolve: input.resolve,
  });
  validateCanonicalSelfDigest(findingSet as unknown as Record<string, unknown>, 'setDigest', 'migration FindingSet');
  const receiptRefs = input.aggregate.blockingInvalidReceiptRefs;
  if (input.requiredReceiptRef !== undefined && !hasExactRef(input.aggregate.blockingInvalidReceiptRefs, input.requiredReceiptRef)) {
    throw new Error('migration validation receipt is not a member of the blocking aggregate');
  }
  const receipts: ValidationReceiptV2[] = [];
  for (const receiptRef of receiptRefs) {
    const receipt = await resolveVerifiedMigrationBlob<ValidationReceiptV2>({
      ref: receiptRef, kind: 'validation_receipt', label: 'migration validation receipt', resolve: input.resolve,
    });
    validateCanonicalSelfDigest(receipt as unknown as Record<string, unknown>, 'receiptDigest', 'migration validation receipt');
    if (receipt.receiptKind !== 'generation'
      || receiptLineageRef(receipt, 'envelope') === null
      || !sameRef(receiptLineageRef(receipt, 'envelope')!, input.expectedEnvelopeRef)
      || receiptLineageRef(receipt, 'core') === null
      || !sameRef(receiptLineageRef(receipt, 'core')!, input.expectedCoreRef)) {
      throw new Error('migration validation receipt does not bind the batch input/core');
    }
    for (let index = 0; index < input.expectedTargetRefs.length; index += 1) {
      const targetRef = receiptLineageRef(receipt, `target.${String(index).padStart(6, '0')}`);
      if (targetRef === null || !sameRef(targetRef, input.expectedTargetRefs[index]!)) {
        throw new Error('migration validation receipt does not bind the selected target bytes');
      }
    }
    const receiptAggregate = await resolveVerifiedMigrationBlob<ValidatorAggregateV2>({
      ref: receipt.validatorAggregateRef, kind: 'validator_aggregate',
      label: 'migration validation receipt aggregate', resolve: input.resolve,
    });
    validateCanonicalSelfDigest(receiptAggregate as unknown as Record<string, unknown>, 'aggregateDigest', 'migration validation receipt aggregate');
    if (receiptAggregate.trigger !== 'content_commit' || receiptAggregate.executionPhase !== input.aggregate.executionPhase
      || !sameRef(receiptAggregate.inputRef, input.expectedEnvelopeRef)
      || receiptAggregate.registrationSetDigest !== input.expectedRegistrationSetDigest) {
      throw new Error('migration validation receipt aggregate does not bind the installed execution');
    }
    receipts.push(receipt);
  }
  const findings: FindingV2[] = [];
  for (const findingRef of findingSet.findingRefs) {
    const finding = await resolveVerifiedMigrationBlob<FindingV2>({
      ref: findingRef, kind: 'finding', label: 'migration Finding', resolve: input.resolve,
    });
    if (!receipts.some((receipt) => findingSupportedByReceipt(finding, receipt, input.aggregateRef))) {
      throw new Error(`migration Finding '${finding.findingId}' is unrelated to the blocking receipt closure`);
    }
    findings.push(finding);
  }
  for (const receipt of receipts) {
    for (const issue of receipt.blockerIssues) {
      if (!findings.some((finding) => finding.evidence.some((evidence) => evidence.evidenceDigest === issue.evidenceDigest))) {
        throw new Error(`migration blocking receipt issue '${issue.issueCode}' is absent from the supplied FindingSet`);
      }
    }
  }
  return { findingSet, findings };
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
  taskId: string;
  plan: ContentMigrationValidationPlanSpecV2;
  planSpecRef: BlobRefV2;
  intent: ContentMigrationIntentCoreV2;
  selectorRegistrations: readonly ValidatorRegistrationV2[];
  orderedResultRefs: readonly BlobRefV2[];
  resolve(ref: BlobRefV2): Promise<unknown> | unknown;
}): Promise<{
  results: readonly MigrationValidationBatchResultV2[];
  resultBySlot: ReadonlyMap<string, MigrationBatchSlotResultV2>;
  rejectedFindingSetRefs: ReadonlyMap<string, BlobRefV2>;
  findingSetRefs: readonly BlobRefV2[];
  batchRouteOutcome: MigrationBatchRouteOutcomeV2;
}> {
  const targetSelectorExpansionCache = new Map<string, Promise<string>>();
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
    validateCanonicalSelfDigest(result as unknown as Record<string, unknown>, 'resultDigest', `migration batch result ordinal ${ordinal}`);
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
      const intentDecision = input.intent.decisions.find((decision) => decision.slotId === slotResult.slotId);
      if (intentDecision?.action !== 'inherit_or_validate') {
        throw new Error(`migration batch slot '${slotResult.slotId}' is not an inherit_or_validate action`);
      }
      const compatibility = await resolveVerifiedMigrationBlob<ContentCompatibilityProofV2>({
        ref: intentDecision.compatibilityProofRef, kind: 'content_compatibility_proof',
        label: `migration compatibility proof '${slotResult.slotId}'`, resolve: input.resolve,
      });
      validateCanonicalSelfDigest(compatibility as unknown as Record<string, unknown>, 'proofDigest', `migration compatibility proof '${slotResult.slotId}'`);
      if (compatibility.taskId !== input.taskId || compatibility.slotId !== slotResult.slotId
        || !sameRef(compatibility.sourceVersionRef, intentDecision.sourceVersionRef)
        || !sameRef(compatibility.sourceMapRef, input.intent.sourceMapRef)
        || !sameRef(compatibility.targetMapRef, input.intent.targetMapRef)) {
        throw new Error(`migration compatibility proof '${slotResult.slotId}' does not bind the frozen source/target identity`);
      }
      const sourceVersion = await resolveVerifiedMigrationBlob<SlotContentVersionV2>({
        ref: intentDecision.sourceVersionRef, kind: 'content_version', label: `migration source version '${slotResult.slotId}'`, resolve: input.resolve,
      });
      if (sourceVersion.state !== 'set' || sourceVersion.slotId !== slotResult.slotId) {
        throw new Error(`migration source version for '${slotResult.slotId}' is not the expected set slot`);
      }
      if (slotResult.outcome === 'equivalent') {
        const proof = await resolveVerifiedMigrationBlob<LocalValidatorEquivalenceProofV2>({
          ref: slotResult.localValidatorEquivalenceProofRef, kind: 'local_validator_equivalence_proof',
          label: `migration equivalence proof '${slotResult.slotId}'`, resolve: input.resolve,
        });
        validateCanonicalSelfDigest(proof as unknown as Record<string, unknown>, 'proofDigest', `migration equivalence proof '${slotResult.slotId}'`);
        if (proof.slotId !== slotResult.slotId || !sameRef(proof.sourceVersionRef, intentDecision.sourceVersionRef)
          || !sameRef(proof.sourceMapRef, input.intent.sourceMapRef) || !sameRef(proof.targetMapRef, input.intent.targetMapRef)
          || proof.frozenRegistrationSetDigest !== input.plan.frozenRegistrationSetDigest) {
          throw new Error(`migration equivalence proof '${slotResult.slotId}' does not bind the frozen plan/source/target`);
        }
        await validateEquivalentMigrationResult({
          taskId: input.taskId,
          slotId: slotResult.slotId,
          sourceVersionRef: intentDecision.sourceVersionRef,
          sourceVersion,
          sourceManifestRef: input.plan.sourceManifestRef,
          sourceMapRef: input.intent.sourceMapRef,
          targetMapRef: input.intent.targetMapRef,
          plan: input.plan,
          intent: input.intent,
          proof,
          expectedRegistrationSetDigest: input.plan.frozenRegistrationSetDigest,
          selectorRegistrations: input.selectorRegistrations,
          targetSelectorExpansionCache,
          resolve: input.resolve,
        });
        continue;
      }
      const aggregate = await resolveVerifiedMigrationBlob<ValidatorAggregateV2>({
        ref: slotResult.validatorAggregateRef, kind: 'validator_aggregate',
        label: `migration slot '${slotResult.slotId}' aggregate`, resolve: input.resolve,
      });
      validateCanonicalSelfDigest(aggregate as unknown as Record<string, unknown>, 'aggregateDigest', `migration slot '${slotResult.slotId}' aggregate`);
      if (aggregate.trigger !== 'content_commit' || aggregate.executionPhase !== 'batch_commit') {
        throw new Error(`migration slot '${slotResult.slotId}' aggregate has the wrong trigger/executionPhase`);
      }
      if (aggregate.registrationSetDigest !== input.plan.frozenRegistrationSetDigest) {
        throw new Error(`migration slot '${slotResult.slotId}' aggregate has the wrong frozen registration set`);
      }
      if (aggregate.inputDigest !== aggregate.inputRef.digest) throw new Error(`migration slot '${slotResult.slotId}' aggregate input digest is inconsistent`);
      validateAggregateOutcomeClosure(aggregate, `migration slot '${slotResult.slotId}' aggregate`);
      const envelope = await resolveVerifiedMigrationBlob<ValidatorInputEnvelopeV2>({
        ref: aggregate.inputRef, kind: 'validator_input_envelope',
        label: `migration slot '${slotResult.slotId}' validator input`, resolve: input.resolve,
      });
      if (envelope.trigger !== 'content_commit' || envelope.executionPhase !== 'batch_commit' || envelope.taskId !== input.taskId) {
        throw new Error(`migration slot '${slotResult.slotId}' input has the wrong trigger/executionPhase/task`);
      }
      const core = await resolveVerifiedMigrationBlob<import('../../authoritative-review/authority-types').ContentRevisionCommitCoreV2>({
        ref: envelope.contentValidationCoreRef, kind: 'content_revision_commit_core',
        label: `migration slot '${slotResult.slotId}' commit core`, resolve: input.resolve,
      });
      validateCanonicalSelfDigest(core as unknown as Record<string, unknown>, 'coreDigest', `migration slot '${slotResult.slotId}' commit core`);
      if (!sameRef(core.priorManifestRef, input.plan.sourceManifestRef) || !sameRef(core.producerPlanSpecRef, input.planSpecRef)
        || core.batchOrdinal !== ordinal || !sameRef(core.expectedMapRef, input.intent.targetMapRef)
        || core.authorizedReplacementEntriesWithoutValidation.length !== 1
        || core.authorizedReplacementEntriesWithoutValidation[0]?.slotId !== slotResult.slotId
        || core.authorizedReplacementEntriesWithoutValidation[0]?.expectedCurrentVersionRef === null
        || !sameRef(core.authorizedReplacementEntriesWithoutValidation[0]!.expectedCurrentVersionRef!, intentDecision.sourceVersionRef)) {
        throw new Error(`migration slot '${slotResult.slotId}' commit core does not bind the frozen plan/ordinal/source/target`);
      }
      if (envelope.selectedTargetRefs.length !== 1 || !sameRef(envelope.selectedTargetRefs[0]!, sourceVersion.blobRef)) {
        throw new Error(`migration slot '${slotResult.slotId}' input selected targets do not bind the source content bytes`);
      }
      const warning = await resolveVerifiedMigrationBlob<ValidationWarningRootV2>({
        ref: aggregate.warningRootRef, kind: 'validation_warning_root',
        label: `migration slot '${slotResult.slotId}' warning root`, resolve: input.resolve,
      });
      validateWarningClosure({ aggregate, warningRef: aggregate.warningRootRef, warning, phase: 'batch_commit' });
      await validateAdvisoryReceiptClosure({
        aggregate, envelopeRef: aggregate.inputRef, coreRef: envelope.contentValidationCoreRef,
        targetRefs: envelope.selectedTargetRefs, resolve: input.resolve,
      });
      if (aggregate.outcome === 'infrastructure_failure') {
        throw new Error(`migration batch ordinal ${ordinal} persisted an infrastructure failure`);
      }
      if (slotResult.outcome === 'revalidated') {
        if (aggregate.outcome !== 'clear') throw new Error(`migration revalidated slot '${slotResult.slotId}' aggregate is not clear`);
        if (!sameRef(slotResult.warningRootRef, aggregate.warningRootRef)) throw new Error(`migration revalidated slot '${slotResult.slotId}' warning ref is not the aggregate warning root`);
      } else {
        if (aggregate.outcome !== 'blocking_invalid') throw new Error(`migration rejected slot '${slotResult.slotId}' aggregate is not blocking-invalid`);
        await validateFindingSetReceiptClosure({
          aggregateRef: slotResult.validatorAggregateRef,
          aggregate,
          findingSetRef: slotResult.findingSetRef,
          requiredReceiptRef: slotResult.validationReceiptRef,
          expectedEnvelopeRef: aggregate.inputRef,
          expectedCoreRef: envelope.contentValidationCoreRef,
          expectedTargetRefs: envelope.selectedTargetRefs,
          expectedRegistrationSetDigest: input.plan.frozenRegistrationSetDigest,
          resolve: input.resolve,
        });
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
  /** Exact installed plan-finalize registry snapshot. Production composition
   * always supplies this; fakes may omit it only when both phases share the
   * same frozen registration set. */
  finalizerRegistrationSetDigest?: string;
  /** Installed batch registrations are required by production equivalence
   * custody so settlement can independently reconstruct selector expansion. */
  batchRegistrations: readonly ValidatorRegistrationV2[];
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
    reviewRoundId: string;
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
    reviewRoundId: string;
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
    settlementWorkItemId: string;
    settlementOperationKey: string;
    route: Exclude<MigrationBatchRouteOutcomeV2, 'infrastructure_failure'>;
    plan: ContentMigrationValidationPlanSpecV2;
    sourceManifestRef: BlobRefV2;
    targetMapRef: BlobRefV2;
    migratedManifestRef: BlobRefV2;
    migrationSettlementCoreRef: BlobRefV2;
    migrationActivationDecisionRef: BlobRefV2;
    combinedClassifiedFindingSetRef: BlobRefV2 | null;
    classifiedFindings: readonly FindingV2[];
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
  'localValidatorCustody' | 'freshValidate' | 'runMigrationFinalizer' | 'prepareActivationRoute' | 'readCurrentAuthority' | 'batchRegistrations'
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
      const primaryIsMap = issue.location.targetKind === 'map'
        || issue.location.targetKind === 'node'
        || issue.location.targetKind === 'relation';
      const hasMap = primaryIsMap
        || issue.repairTargets.mapNodeIds.length > 0
        || issue.repairTargets.relationIds.length > 0;
      const hasContent = issue.repairTargets.slotIds.length > 0;
      const defectClass: FindingV2['defectClass'] = hasMap ? (hasContent ? 'mixed' : 'map') : 'content';
      const findingId = `migration-finding-${canonicalJsonSha256({ roundId, issue }).slice(0, 24)}`;
      const primaryKind: FindingV2['primaryLocation']['kind'] =
        issue.location.targetKind === 'relation'
          ? 'relation'
          : issue.location.targetKind === 'slot'
            ? 'slot'
            : issue.location.targetKind === 'node'
              ? 'map_node'
              : 'map';
      findings.push({
        findingId,
        reviewContext: { kind: 'map', roundId },
        primaryLocation: { kind: primaryKind, id: issue.location.stableTargetId },
        // Map nodes use stable slot IDs.  Preserve the complete authoritative
        // node target set in the Finding's stable related-slot identity set;
        // suggestedRepairSlotIds remains content-only for the Content track.
        relatedSlotIds: [...new Set([...issue.repairTargets.slotIds, ...issue.repairTargets.mapNodeIds])].sort(),
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

interface AuthoritativeSourceValidatorCustodyV2 {
  aggregateRef: BlobRefV2;
  aggregate: ValidatorAggregateV2;
  envelope: ValidatorInputEnvelopeV2;
  validatedVersion: SlotContentVersionV2 & { state: 'set' };
  selectorExpansionDigest: string;
}

type SetSlotContentVersionV2 = Extract<SlotContentVersionV2, { state: 'set' }>;

/** Resolve the original clear batch validator through any number of
 * equivalence-only migrations.  Each inherited link is independently bound to
 * its immutable source/target Maps and content bytes, so an equivalence-only
 * version can safely be used as the source of a later Map replacement. */
async function resolveAuthoritativeSourceValidatorCustody(input: {
  taskId: string;
  slotId: string;
  sourceVersionRef: BlobRefV2;
  sourceManifestRef: BlobRefV2;
  sourceMapRef: BlobRefV2;
  expectedRegistrationSetDigest: string;
  selectorRegistrations: readonly ValidatorRegistrationV2[];
  resolve(ref: BlobRefV2): Promise<unknown> | unknown;
}): Promise<AuthoritativeSourceValidatorCustodyV2> {
  const seen = new Set<string>();
  const inheritedProofs: LocalValidatorEquivalenceProofV2[] = [];
  let currentRef = input.sourceVersionRef;
  const initial = await resolveVerifiedMigrationBlob<SlotContentVersionV2>({
    ref: currentRef, kind: 'content_version', label: `migration source version '${input.slotId}'`, resolve: input.resolve,
  });
  if (initial.state !== 'set' || initial.slotId !== input.slotId) throw new Error('migration source custody is not a set version for the requested slot');
  const sourceManifest = await resolveVerifiedMigrationBlob<ContentRevisionManifestV2>({
    ref: input.sourceManifestRef, kind: 'content_revision_manifest', label: 'migration authoritative source manifest', resolve: input.resolve,
  });
  validateCanonicalSelfDigest(sourceManifest as unknown as Record<string, unknown>, 'manifestDigest', 'migration authoritative source manifest');
  const sourceMap = await resolveVerifiedMigrationBlob<MapSnapshotV2>({
    ref: input.sourceMapRef, kind: 'map_snapshot', label: 'migration authoritative source Map', resolve: input.resolve,
  });
  const exactManifestEntries = sourceManifest.entries.filter((entry) => entry.slotId === input.slotId);
  if (sourceManifest.taskId !== input.taskId || !sameRef(sourceManifest.mapRef, input.sourceMapRef)
    || sourceManifest.mapSemanticDigest !== sourceMap.mapSemanticDigest
    || exactManifestEntries.length !== 1 || !sameRef(exactManifestEntries[0]!.versionRef, input.sourceVersionRef)
    || !sameRef(initial.mapRef, input.sourceMapRef) || initial.mapSemanticDigest !== sourceMap.mapSemanticDigest) {
    throw new Error('migration source manifest, source Map, and source version do not form one authoritative lineage');
  }
  let current: SetSlotContentVersionV2 = initial;

  while (current.provenance.kind === 'inherited_after_map_activation'
    && current.provenance.migratedBatchValidatorAggregateRef === null) {
    if (current.provenance.localValidatorEquivalenceProofRef === null) {
      throw new Error('equivalence-only inherited version lacks its equivalence proof');
    }
    if (seen.has(currentRef.digest)) throw new Error('migration source-version equivalence lineage contains a cycle');
    seen.add(currentRef.digest);
    const proof = await resolveVerifiedMigrationBlob<LocalValidatorEquivalenceProofV2>({
      ref: current.provenance.localValidatorEquivalenceProofRef,
      kind: 'local_validator_equivalence_proof', label: `migration inherited equivalence proof '${input.slotId}'`, resolve: input.resolve,
    });
    validateCanonicalSelfDigest(proof as unknown as Record<string, unknown>, 'proofDigest', `migration inherited equivalence proof '${input.slotId}'`);
    inheritedProofs.push(proof);
    const priorRef: BlobRefV2 = current.provenance.sourceVersionRef;
    const resolvedPrior = await resolveVerifiedMigrationBlob<SlotContentVersionV2>({
      ref: priorRef, kind: 'content_version', label: `migration inherited source version '${input.slotId}'`, resolve: input.resolve,
    });
    if (resolvedPrior.state !== 'set' || resolvedPrior.slotId !== input.slotId) {
      throw new Error('migration inherited source version is not a set version for the requested slot');
    }
    const prior: SetSlotContentVersionV2 = resolvedPrior;
    if (proof.slotId !== input.slotId || !sameRef(proof.sourceVersionRef, priorRef)
      || !sameRef(proof.sourceMapRef, prior.mapRef) || !sameRef(proof.targetMapRef, current.mapRef)
      || proof.frozenRegistrationSetDigest !== input.expectedRegistrationSetDigest
      || !sameRef(prior.blobRef, current.blobRef) || prior.contentDigest !== current.contentDigest) {
      throw new Error('migration inherited equivalence lineage is not authoritative');
    }
    const sourceMap = await resolveVerifiedMigrationBlob<MapSnapshotV2>({
      ref: prior.mapRef, kind: 'map_snapshot', label: `migration inherited source Map '${input.slotId}'`, resolve: input.resolve,
    });
    const targetMap = await resolveVerifiedMigrationBlob<MapSnapshotV2>({
      ref: current.mapRef, kind: 'map_snapshot', label: `migration inherited target Map '${input.slotId}'`, resolve: input.resolve,
    });
    const sourceLocal = localMapDimensions(sourceMap, input.slotId);
    const targetLocal = localMapDimensions(targetMap, input.slotId);
    if (sourceLocal.subgraph !== targetLocal.subgraph || sourceLocal.relations !== targetLocal.relations
      || proof.localMapSubgraphDigest !== sourceLocal.subgraph
      || proof.localRelationContextDigest !== sourceLocal.relations) {
      throw new Error('migration inherited equivalence Map dimensions do not match');
    }
    const priorBytes = await resolveVerifiedMigrationBlob<unknown>({
      ref: prior.blobRef, kind: prior.blobRef.kind as Parameters<typeof refOfBlob>[0], label: `migration inherited source content '${input.slotId}'`, resolve: input.resolve,
    });
    const currentBytes = await resolveVerifiedMigrationBlob<unknown>({
      ref: current.blobRef, kind: current.blobRef.kind as Parameters<typeof refOfBlob>[0], label: `migration inherited target content '${input.slotId}'`, resolve: input.resolve,
    });
    if (canonicalJsonSha256(priorBytes) !== canonicalJsonSha256(currentBytes)) throw new Error('migration inherited equivalence content bytes differ');
    currentRef = priorRef;
    current = prior;
  }

  const aggregateRef = aggregateRefOfVersion(current);
  if (aggregateRef === null) throw new Error('migration source lineage has no authoritative validator aggregate');
  const aggregate = await resolveVerifiedMigrationBlob<ValidatorAggregateV2>({
    ref: aggregateRef, kind: 'validator_aggregate', label: `migration source aggregate '${input.slotId}'`, resolve: input.resolve,
  });
  validateCanonicalSelfDigest(aggregate as unknown as Record<string, unknown>, 'aggregateDigest', `migration source aggregate '${input.slotId}'`);
  if (aggregate.trigger !== 'content_commit' || aggregate.executionPhase !== 'batch_commit'
    || aggregate.registrationSetDigest !== input.expectedRegistrationSetDigest || aggregate.outcome !== 'clear') {
    throw new Error('migration source aggregate is not an installed clear content batch execution');
  }
  validateAggregateOutcomeClosure(aggregate, `migration source aggregate '${input.slotId}'`);
  const envelope = await resolveVerifiedMigrationBlob<ValidatorInputEnvelopeV2>({
    ref: aggregate.inputRef, kind: 'validator_input_envelope', label: `migration source input '${input.slotId}'`, resolve: input.resolve,
  });
  if (envelope.trigger !== 'content_commit' || envelope.executionPhase !== 'batch_commit' || envelope.taskId !== input.taskId
    || !hasExactRef(envelope.selectedTargetRefs, current.blobRef)) {
    throw new Error('migration source input does not bind the source content batch');
  }
  for (const proof of inheritedProofs) {
    if (!sameRef(proof.sourceBatchInputRef, aggregate.inputRef)) {
      throw new Error('migration inherited equivalence proof does not bind the authoritative selector/input lineage');
    }
  }
  const core = await resolveVerifiedMigrationBlob<import('../../authoritative-review/authority-types').ContentRevisionCommitCoreV2>({
    ref: envelope.contentValidationCoreRef, kind: 'content_revision_commit_core', label: `migration source commit core '${input.slotId}'`, resolve: input.resolve,
  });
  validateCanonicalSelfDigest(core as unknown as Record<string, unknown>, 'coreDigest', `migration source commit core '${input.slotId}'`);
  const validatedMap = await resolveVerifiedMigrationBlob<MapSnapshotV2>({
    ref: current.mapRef, kind: 'map_snapshot', label: `migration originating validated Map '${input.slotId}'`, resolve: input.resolve,
  });
  if (!sameRef(core.expectedMapRef, current.mapRef) || current.mapSemanticDigest !== validatedMap.mapSemanticDigest) {
    throw new Error('migration source commit core/version does not bind the originating validated Map');
  }
  if (current.provenance.kind === 'generated' && !sameRef(current.provenance.contentRevisionCommitCoreRef, envelope.contentValidationCoreRef)) {
    throw new Error('generated source version does not bind the validator commit core');
  }
  if (current.provenance.kind === 'generated' && !sameRef(current.provenance.contentCommitValidatorAggregateRef, aggregateRef)) {
    throw new Error('generated source version does not bind the validator aggregate');
  }
  if (current.provenance.kind === 'inherited_after_map_activation'
    && (current.provenance.migratedBatchValidatorAggregateRef === null
      || !sameRef(current.provenance.migratedBatchValidatorAggregateRef, aggregateRef))) {
    throw new Error('revalidated inherited source version does not bind the validator aggregate');
  }
  const producerPlanRaw = await resolveVerifiedMigrationBlob<Record<string, unknown>>({
    ref: core.producerPlanSpecRef,
    kind: core.producerPlanSpecRef.kind as Parameters<typeof refOfBlob>[0],
    label: `migration source producer plan '${input.slotId}'`, resolve: input.resolve,
  });
  if (core.producerPlanSpecRef.kind === 'repair_plan_spec') {
    validateMigrationRepairPlanIdentity(
      producerPlanRaw as unknown as import('../../authoritative-review/authority-types').RepairPlanSpecV2,
    );
  } else {
    validateCanonicalSelfDigest(producerPlanRaw, 'specDigest', `migration source producer plan '${input.slotId}'`);
  }
  let frozenBatchSlotIds: readonly string[];
  if (core.producerPlanSpecRef.kind === 'generation_plan_spec') {
    const producerPlan = producerPlanRaw as unknown as import('../../authoritative-review/authority-types').GenerationPlanSpecV2;
    frozenBatchSlotIds = producerPlan.orderedBatchSlotIds[core.batchOrdinal] ?? [];
    if (!sameRef(producerPlan.activeMapRef, current.mapRef)
      || current.provenance.kind !== 'generated'
      || current.provenance.producer.kind !== 'generation_batch'
      || current.provenance.producer.planRevisionId !== producerPlan.generationPlanId
      || current.provenance.producer.batchOrdinal !== core.batchOrdinal) {
      throw new Error('migration source generation plan does not bind the version producer/Map/batch');
    }
  } else if (core.producerPlanSpecRef.kind === 'repair_plan_spec') {
    const producerPlan = producerPlanRaw as unknown as import('../../authoritative-review/authority-types').RepairPlanSpecV2;
    const batch = producerPlan.orderedBatchScopes.find((candidate) => candidate.batchOrdinal === core.batchOrdinal);
    frozenBatchSlotIds = batch?.kind === 'content' ? batch.slotIds : [];
    if ((producerPlan.repairBase.kind !== 'content' && producerPlan.repairBase.kind !== 'map_active')
      || !sameRef(producerPlan.repairBase.mapRef, current.mapRef)
      || current.provenance.kind !== 'generated'
      || current.provenance.producer.kind !== 'content_repair_batch'
      || current.provenance.producer.planRevisionId !== producerPlan.planRevisionId
      || current.provenance.producer.batchOrdinal !== core.batchOrdinal) {
      throw new Error('migration source repair plan does not bind the version producer/Map/batch');
    }
  } else if (core.producerPlanSpecRef.kind === 'migration_validation_plan_spec') {
    const producerPlan = producerPlanRaw as unknown as ContentMigrationValidationPlanSpecV2;
    frozenBatchSlotIds = producerPlan.orderedBatchSlotIds[core.batchOrdinal] ?? [];
    if (current.provenance.kind !== 'inherited_after_map_activation') {
      throw new Error('migration source validation plan does not bind an inherited revalidated version');
    }
    const producerIntent = await resolveVerifiedMigrationBlob<ContentMigrationIntentCoreV2>({
      ref: producerPlan.migrationIntentCoreRef,
      kind: 'migration_intent_core',
      label: `migration source producer intent '${input.slotId}'`,
      resolve: input.resolve,
    });
    validateCanonicalSelfDigest(producerIntent as unknown as Record<string, unknown>, 'coreDigest', `migration source producer intent '${input.slotId}'`);
    const producerSettlement = await resolveVerifiedMigrationBlob<ContentMigrationSettlementCoreV2>({
      ref: current.provenance.contentMigrationSettlementCoreRef,
      kind: 'migration_settlement_core',
      label: `migration source producer settlement '${input.slotId}'`,
      resolve: input.resolve,
    });
    validateCanonicalSelfDigest(producerSettlement as unknown as Record<string, unknown>, 'settlementDigest', `migration source producer settlement '${input.slotId}'`);
    const settlementDecision = producerSettlement.decisions.find((decision) => decision.slotId === input.slotId);
    if (!sameRef(producerIntent.targetMapRef, current.mapRef)
      || !sameRef(core.priorManifestRef, producerPlan.sourceManifestRef)
      || !sameRef(producerSettlement.migrationValidationPlanSpecRef, core.producerPlanSpecRef)
      || settlementDecision?.outcome !== 'inherit_revalidated'
      || !sameRef(settlementDecision.migratedBatchValidatorAggregateRef, aggregateRef)) {
      throw new Error('migration source plan/intent/settlement does not close the revalidated producer lineage');
    }
  } else {
    throw new Error('migration source validator core names an unsupported producer plan');
  }
  const frozenSet = new Set(frozenBatchSlotIds);
  if (!frozenSet.has(input.slotId)) throw new Error('migration source slot is absent from its frozen producer batch');
  const replacementSlotIds = core.authorizedReplacementEntriesWithoutValidation.map((entry) => entry.slotId);
  if (new Set(replacementSlotIds).size !== replacementSlotIds.length
    || !replacementSlotIds.includes(input.slotId)
    || replacementSlotIds.some((slotId) => !frozenSet.has(slotId))) {
    throw new Error('migration source commit replacements do not belong to the frozen producer batch');
  }
  if (core.producerPlanSpecRef.kind !== 'migration_validation_plan_spec'
    && canonicalJsonSha256([...replacementSlotIds].sort()) !== canonicalJsonSha256([...frozenBatchSlotIds].sort())) {
    throw new Error('migration source commit replacements do not exactly cover the frozen producer batch');
  }
  const selectedSlotIds: string[] = [];
  for (const targetRef of envelope.selectedTargetRefs) {
    const target = await resolveVerifiedMigrationBlob<{ slotId?: unknown }>({
      ref: targetRef, kind: targetRef.kind as Parameters<typeof refOfBlob>[0],
      label: `migration source selected target '${input.slotId}'`, resolve: input.resolve,
    });
    if (typeof target.slotId !== 'string') throw new Error('migration source selected target lacks a stable slot ID');
    selectedSlotIds.push(target.slotId);
  }
  if (new Set(selectedSlotIds).size !== selectedSlotIds.length
    || !selectedSlotIds.includes(input.slotId)
    || selectedSlotIds.some((slotId) => !frozenSet.has(slotId))
    || canonicalJsonSha256([...selectedSlotIds].sort()) !== canonicalJsonSha256([...replacementSlotIds].sort())) {
    throw new Error('migration source validator targets do not exactly match the committed replacement batch');
  }
  const selectorExpansionDigest = selectorExpansionDigestFor({
    registrations: input.selectorRegistrations,
    candidates: envelope.selectedTargetRefs.map((ref, index) => {
      const slotId = selectedSlotIds[index]!;
      const node = validatedMap.nodes.find((candidate) => candidate.slotId === slotId);
      if (node === undefined || !node.contentBearing) {
        throw new Error(`migration source selector target '${slotId}' is absent from its validated Map`);
      }
      return { ref, slotId, typeId: node.slotType };
    }),
  });
  for (const proof of inheritedProofs) {
    if (proof.selectorExpansionDigest !== selectorExpansionDigest) {
      throw new Error('migration inherited equivalence proof does not bind the authoritative selector/input lineage');
    }
  }
  const validatedContent = await resolveVerifiedMigrationBlob<{ slotId?: unknown }>({
    ref: current.blobRef,
    kind: current.blobRef.kind as Parameters<typeof refOfBlob>[0],
    label: `migration originating validated content '${input.slotId}'`,
    resolve: input.resolve,
  });
  if (validatedContent.slotId !== input.slotId || current.contentDigest !== current.blobRef.digest) {
    throw new Error('migration source version does not bind the originating content bytes/slot');
  }
  const originatingLocal = localMapDimensions(validatedMap, input.slotId);
  const migrationSourceLocal = localMapDimensions(sourceMap, input.slotId);
  if (originatingLocal.subgraph !== migrationSourceLocal.subgraph
    || originatingLocal.relations !== migrationSourceLocal.relations) {
    throw new Error('migration source Map differs from the Map lineage actually validated for this slot');
  }
  const custodyRef = current.provenance.kind === 'generated'
    ? current.provenance.contentCommitWarningRootRef
    : current.provenance.migratedBatchWarningRootRef;
  if (custodyRef === null) throw new Error('migration source version lacks warning custody');
  const custody = await resolveVerifiedMigrationBlob<ValidationWarningCustodyRootV2>({
    ref: custodyRef, kind: 'validation_warning_custody_root', label: `migration source warning custody '${input.slotId}'`, resolve: input.resolve,
  });
  validateCanonicalSelfDigest(custody as unknown as Record<string, unknown>, 'rootDigest', `migration source warning custody '${input.slotId}'`);
  const custodyEntry = custody.entries.find((entry) => sameRef(entry.validatorAggregateRef, aggregateRef));
  if (custody.taskId !== input.taskId || custodyEntry === undefined || !sameRef(custodyEntry.inputRef, aggregate.inputRef)
    || custodyEntry.inputDigest !== aggregate.inputDigest || !sameRef(custodyEntry.warningRootRef, aggregate.warningRootRef)) {
    throw new Error('migration source warning custody does not close the aggregate/input/warning lineage');
  }
  const warning = await resolveVerifiedMigrationBlob<ValidationWarningRootV2>({
    ref: aggregate.warningRootRef, kind: 'validation_warning_root', label: `migration source warning '${input.slotId}'`, resolve: input.resolve,
  });
  validateWarningClosure({ aggregate, warningRef: aggregate.warningRootRef, warning, phase: 'batch_commit' });
  await validateAdvisoryReceiptClosure({
    aggregate, envelopeRef: aggregate.inputRef, coreRef: envelope.contentValidationCoreRef,
    targetRefs: envelope.selectedTargetRefs, resolve: input.resolve,
  });
  return { aggregateRef, aggregate, envelope, validatedVersion: current, selectorExpansionDigest };
}

async function validateEquivalentMigrationResult(input: {
  taskId: string;
  slotId: string;
  sourceVersionRef: BlobRefV2;
  sourceVersion: SlotContentVersionV2 & { state: 'set' };
  sourceManifestRef: BlobRefV2;
  sourceMapRef: BlobRefV2;
  targetMapRef: BlobRefV2;
  plan: ContentMigrationValidationPlanSpecV2;
  intent: ContentMigrationIntentCoreV2;
  proof: LocalValidatorEquivalenceProofV2;
  expectedRegistrationSetDigest: string;
  selectorRegistrations: readonly ValidatorRegistrationV2[];
  targetSelectorExpansionCache?: Map<string, Promise<string>>;
  resolve(ref: BlobRefV2): Promise<unknown> | unknown;
}): Promise<void> {
  const custody = await resolveAuthoritativeSourceValidatorCustody({
    taskId: input.taskId, slotId: input.slotId, sourceVersionRef: input.sourceVersionRef,
    sourceManifestRef: input.sourceManifestRef, sourceMapRef: input.sourceMapRef,
    expectedRegistrationSetDigest: input.expectedRegistrationSetDigest,
    selectorRegistrations: input.selectorRegistrations,
    resolve: input.resolve,
  });
  if (!sameRef(input.proof.sourceBatchInputRef, custody.aggregate.inputRef)) throw new Error('migration equivalence proof does not bind the authoritative source input');
  const sourceMap = await resolveVerifiedMigrationBlob<MapSnapshotV2>({
    ref: input.sourceMapRef, kind: 'map_snapshot', label: `migration equivalence source Map '${input.slotId}'`, resolve: input.resolve,
  });
  const targetMap = await resolveVerifiedMigrationBlob<MapSnapshotV2>({
    ref: input.targetMapRef, kind: 'map_snapshot', label: `migration equivalence target Map '${input.slotId}'`, resolve: input.resolve,
  });
  const sourceLocal = localMapDimensions(sourceMap, input.slotId);
  const targetLocal = localMapDimensions(targetMap, input.slotId);
  const sourceBytes = await resolveVerifiedMigrationBlob<unknown>({
    ref: custody.validatedVersion.blobRef, kind: custody.validatedVersion.blobRef.kind as Parameters<typeof refOfBlob>[0],
    label: `migration validated source bytes '${input.slotId}'`, resolve: input.resolve,
  });
  const targetBytes = await resolveVerifiedMigrationBlob<unknown>({
    ref: input.sourceVersion.blobRef, kind: input.sourceVersion.blobRef.kind as Parameters<typeof refOfBlob>[0],
    label: `migration current source bytes '${input.slotId}'`, resolve: input.resolve,
  });
  const targetSelectorCacheKey = canonicalJsonSha256({
    planDigest: input.plan.specDigest,
    sourceInputDigest: custody.aggregate.inputRef.digest,
    sourceMapDigest: input.sourceMapRef.digest,
    targetMapDigest: input.targetMapRef.digest,
  });
  let targetSelectorPromise = input.targetSelectorExpansionCache?.get(targetSelectorCacheKey);
  if (targetSelectorPromise === undefined) {
    targetSelectorPromise = deriveTargetSelectorExpansionDigest({
      sourceEnvelope: custody.envelope,
      sourceMap,
      targetMap,
      plan: input.plan,
      intent: input.intent,
      registrations: input.selectorRegistrations,
      resolve: input.resolve,
    });
    input.targetSelectorExpansionCache?.set(targetSelectorCacheKey, targetSelectorPromise);
  }
  const targetSelectorExpansionDigest = await targetSelectorPromise;
  const exact = custody.aggregate.registrationSetDigest === input.expectedRegistrationSetDigest
    && input.proof.frozenRegistrationSetDigest === input.expectedRegistrationSetDigest
    && input.proof.selectorExpansionDigest === custody.selectorExpansionDigest
    && input.proof.selectorExpansionDigest === targetSelectorExpansionDigest
    && canonicalJsonSha256(sourceBytes) === canonicalJsonSha256(targetBytes)
    && sourceLocal.subgraph === targetLocal.subgraph && input.proof.localMapSubgraphDigest === sourceLocal.subgraph
    && sourceLocal.relations === targetLocal.relations && input.proof.localRelationContextDigest === sourceLocal.relations;
  if (!exact) throw new Error('migration equivalence proof does not recompute all five authoritative custody dimensions');
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

interface SelectorExpansionCandidateV2 {
  ref: BlobRefV2;
  slotId: string;
  typeId: string;
}

/** Freeze the selector result per installed validator identity. Registration
 * set identity deliberately excludes selectors, so selector custody must bind
 * both the selector bytes and their canonical ordered target expansion. */
function selectorExpansionDigestFor(input: {
  registrations: readonly ValidatorRegistrationV2[];
  candidates: readonly SelectorExpansionCandidateV2[];
}): string {
  const expansion = [...input.registrations]
    .sort((a, b) => a.validatorId.localeCompare(b.validatorId))
    .map((registration) => ({
      validatorId: registration.validatorId,
      selector: registration.selector,
      selectedTargetRefs: input.candidates
        .filter((candidate) => registration.selector.kind === 'all'
          || registration.selector.typeIds.includes(candidate.typeId))
        .map((candidate) => candidate.ref),
    }));
  return canonicalJsonSha256(expansion);
}

/** Reconstruct the target-side selector expansion without consulting the old
 * envelope as target authority. The envelope supplies only the source batch's
 * ordered slots. Every target counterpart is independently justified by the
 * frozen migration intent and exact target Map; reset/removed/rewritten slots
 * therefore disappear and force a fresh target-Map validation. */
async function deriveTargetSelectorExpansionDigest(input: {
  sourceEnvelope: ValidatorInputEnvelopeV2;
  sourceMap: MapSnapshotV2;
  targetMap: MapSnapshotV2;
  plan: ContentMigrationValidationPlanSpecV2;
  intent: ContentMigrationIntentCoreV2;
  registrations: readonly ValidatorRegistrationV2[];
  resolve(ref: BlobRefV2): Promise<unknown> | unknown;
}): Promise<string> {
  if (!sameRef(input.plan.migrationIntentCoreRef, refOfBlob('migration_intent_core', input.intent))) {
    throw new Error('migration target selector expansion does not bind the frozen intent');
  }
  const decisions = new Map(input.intent.decisions.map((decision) => [decision.slotId, decision]));
  const targetCandidates: SelectorExpansionCandidateV2[] = [];
  const seen = new Set<string>();
  for (const sourceRef of input.sourceEnvelope.selectedTargetRefs) {
    const sourceTarget = await resolveVerifiedMigrationBlob<{ slotId?: unknown }>({
      ref: sourceRef,
      kind: sourceRef.kind as Parameters<typeof refOfBlob>[0],
      label: 'migration source selector target',
      resolve: input.resolve,
    });
    if (typeof sourceTarget.slotId !== 'string' || seen.has(sourceTarget.slotId)) {
      throw new Error('migration source selector expansion lacks unique stable slot identities');
    }
    seen.add(sourceTarget.slotId);
    const sourceNode = input.sourceMap.nodes.find((candidate) => candidate.slotId === sourceTarget.slotId);
    const targetNode = input.targetMap.nodes.find((candidate) => candidate.slotId === sourceTarget.slotId);
    const decision = decisions.get(sourceTarget.slotId);
    if (sourceNode === undefined || !sourceNode.contentBearing) {
      throw new Error(`migration source selector slot '${sourceTarget.slotId}' is absent from the source Map`);
    }
    if (targetNode === undefined || !targetNode.contentBearing || decision?.action !== 'inherit_or_validate') continue;
    const version = await resolveVerifiedMigrationBlob<SlotContentVersionV2>({
      ref: decision.sourceVersionRef,
      kind: 'content_version',
      label: `migration target selector source version '${sourceTarget.slotId}'`,
      resolve: input.resolve,
    });
    if (version.state !== 'set' || version.slotId !== sourceTarget.slotId
      || !sameRef(version.blobRef, sourceRef)) continue;
    targetCandidates.push({ ref: version.blobRef, slotId: version.slotId, typeId: targetNode.slotType });
  }
  return selectorExpansionDigestFor({ registrations: input.registrations, candidates: targetCandidates });
}

function deriveTargetContentCoverage(input: {
  targetMap: MapSnapshotV2;
  slotTypes: readonly ValidatorSlotType[];
}): { contentSlotIds: string[]; requiredSlotIds: string[] } {
  const presenceByType = new Map(input.slotTypes.map((slotType) => [slotType.id, slotType.contentPresence]));
  const contentSlotIds: string[] = [];
  const requiredSlotIds: string[] = [];
  for (const node of input.targetMap.nodes) {
    if (!node.contentBearing) continue;
    const presence = presenceByType.get(node.slotType);
    if (presence === undefined) throw new Error(`target Map slot '${node.slotId}' names an unknown frozen slot type '${node.slotType}'`);
    contentSlotIds.push(node.slotId);
    if (presence === 'required') requiredSlotIds.push(node.slotId);
  }
  return { contentSlotIds: contentSlotIds.sort(), requiredSlotIds: requiredSlotIds.sort() };
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
  const installedBatchRegistrationSetDigest = registrationSetDigestOf(registrations.batch_commit);
  if (input.frozenRegistrationSetDigest !== installedBatchRegistrationSetDigest) {
    throw new Error('production migration runtime frozen batch registration set does not equal the installed registry snapshot');
  }
  const persistableStore = (versionStateOf: (slotId: string) => 'set' | 'unset' | 'rewrite_required') =>
    new ContentPlanMemoryBlobStore(contentPlanEnrichment({ slotTypeOf: input.slotTypeOf, versionStateOf }));
  // Every authoritative blob is content-addressed and immutable. Reusing
  // successful resolutions keeps large migrations from rereading the same
  // source manifest/Map/producer batch hundreds of times. Missing refs are not
  // cached because a later command in this runtime may prepare that exact ref.
  const immutableResolutionCache = new Map<string, unknown>();
  const targetSelectorExpansionCache = new Map<string, Promise<string>>();
  const resolveImmutable = async (taskId: string, ref: BlobRefV2): Promise<unknown> => {
    const key = `${taskId}:${ref.kind}:${ref.digest}`;
    if (immutableResolutionCache.has(key)) return immutableResolutionCache.get(key);
    const value = await input.resolve(taskId, ref);
    if (value !== null) immutableResolutionCache.set(key, value);
    return value;
  };
  const resolveRequired = async <T>(taskId: string, ref: BlobRefV2, label: string): Promise<T> => {
    const value = await resolveImmutable(taskId, ref);
    if (value === null || typeof value !== 'object') throw new Error(`${label} is unresolvable`);
    return value as T;
  };
  const deps: MigrationServiceDependenciesV2 = {
    ...input,
    resolve: resolveImmutable,
    finalizerRegistrationSetDigest: registrationSetDigestOf(registrations.plan_finalize),
    batchRegistrations: registrations.batch_commit,
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
      const resolved = await resolveAuthoritativeSourceValidatorCustody({
        taskId,
        slotId,
        sourceVersionRef: decision.sourceVersionRef,
        sourceManifestRef: plan.sourceManifestRef,
        sourceMapRef: (await resolveRequired<ContentMigrationIntentCoreV2>(taskId, plan.migrationIntentCoreRef, 'migration intent')).sourceMapRef,
        expectedRegistrationSetDigest: installedBatchRegistrationSetDigest,
        selectorRegistrations: registrations.batch_commit,
        resolve: (ref) => resolveImmutable(taskId, ref),
      });
      const aggregate = resolved.aggregate;
      const envelope = resolved.envelope;
      const content = await resolveRequired<unknown>(taskId, version.blobRef, 'source content bytes');
      const intent = await resolveRequired<ContentMigrationIntentCoreV2>(taskId, plan.migrationIntentCoreRef, 'migration intent');
      const sourceMap = await resolveRequired<MapSnapshotV2>(taskId, intent.sourceMapRef, 'source Map');
      const targetMap = await resolveRequired<MapSnapshotV2>(taskId, intent.targetMapRef, 'target Map');
      const sourceLocal = localMapDimensions(sourceMap, slotId);
      const targetLocal = localMapDimensions(targetMap, slotId);
      const sourceSelectorExpansionDigest = resolved.selectorExpansionDigest;
      const targetSelectorCacheKey = canonicalJsonSha256({
        planDigest: plan.specDigest,
        sourceInputDigest: aggregate.inputRef.digest,
        sourceMapDigest: intent.sourceMapRef.digest,
        targetMapDigest: intent.targetMapRef.digest,
      });
      let targetSelectorPromise = targetSelectorExpansionCache.get(targetSelectorCacheKey);
      if (targetSelectorPromise === undefined) {
        targetSelectorPromise = deriveTargetSelectorExpansionDigest({
          sourceEnvelope: envelope,
          sourceMap,
          targetMap,
          plan,
          intent,
          registrations: registrations.batch_commit,
          resolve: (ref) => resolveImmutable(taskId, ref),
        });
        targetSelectorExpansionCache.set(targetSelectorCacheKey, targetSelectorPromise);
      }
      const targetSelectorExpansionDigest = await targetSelectorPromise;
      return {
        sourceBatchInputRef: aggregate.inputRef,
        source: {
          frozenRegistrationSetDigest: aggregate.registrationSetDigest,
          selectorExpansionDigest: sourceSelectorExpansionDigest,
          contentBytesDigest: canonicalJsonSha256(content),
          localMapSubgraphDigest: sourceLocal.subgraph,
          localRelationContextDigest: sourceLocal.relations,
        },
        target: {
          frozenRegistrationSetDigest: installedBatchRegistrationSetDigest,
          selectorExpansionDigest: targetSelectorExpansionDigest,
          contentBytesDigest: canonicalJsonSha256(content),
          localMapSubgraphDigest: targetLocal.subgraph,
          localRelationContextDigest: targetLocal.relations,
        },
      };
    },
    async freshValidate({ taskId, reviewRoundId, slotId, decision, plan, planSpecRef, batchOrdinal }) {
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
      const findings = findingsFromValidatorRun(run, reviewRoundId);
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
    async runMigrationFinalizer({ taskId, reviewRoundId, finalizeCore, finalizeCoreRef, provisionalManifestRef, targetMapRef }) {
      const productionResolve = (ref: BlobRefV2) => input.resolve(taskId, ref);
      const manifest = await resolveVerifiedMigrationBlob<ContentRevisionManifestV2>({
        ref: provisionalManifestRef, kind: 'content_revision_manifest', label: 'migration provisional manifest', resolve: productionResolve,
      });
      const targetMap = await resolveVerifiedMigrationBlob<MapSnapshotV2>({
        ref: targetMapRef, kind: 'map_snapshot', label: 'migration finalizer target Map', resolve: productionResolve,
      });
      const systemCoverage = deriveTargetContentCoverage({ targetMap, slotTypes: input.slotTypes });
      const configuredRequiredSlotIds = [...await input.requiredSlotIdsOf(taskId, targetMapRef)].sort();
      if (canonicalJsonSha256(configuredRequiredSlotIds) !== canonicalJsonSha256(systemCoverage.requiredSlotIds)) {
        throw new Error('configured required-slot set disagrees with the exact target Map and frozen slot types');
      }
      const manifestSlotIds = manifest.entries.map((entry) => entry.slotId).sort();
      if (canonicalJsonSha256(manifestSlotIds) !== canonicalJsonSha256(systemCoverage.contentSlotIds)) {
        throw new Error('migrated manifest does not exactly cover the target Map content-bearing slots');
      }
      const versions = new Map<string, SlotContentVersionV2>();
      for (const entry of manifest.entries) {
        const version = await resolveVerifiedMigrationBlob<SlotContentVersionV2>({
          ref: entry.versionRef, kind: 'content_version', label: `migration version ${entry.slotId}`, resolve: productionResolve,
        });
        if (version.slotId !== entry.slotId || !sameRef(version.mapRef, targetMapRef)) {
          throw new Error(`migration version '${entry.slotId}' does not bind the target Map/manifest entry`);
        }
        versions.set(entry.slotId, version);
      }
      const store = persistableStore((slotId) => versions.get(slotId)?.state ?? 'unset');
      store.put('content_plan_finalize_core', finalizeCore);
      store.put('content_revision_manifest', manifest);
      const engine = new ValidatorEngine({ registry: input.validatorRegistry, blobs: store, sourceResolver: input.sourceResolver });
      const run = await engine.execute({
        trigger: 'content_commit', executionPhase: 'plan_finalize',
        identity: { taskId, templateSnapshotHash: input.templateSnapshotHash, workItemId: `migration-finalize-${finalizeCoreRef.digest.slice(0, 12)}`, attemptId: null, commandId: `migration-finalize-${finalizeCoreRef.digest.slice(0, 12)}` },
        coreRef: finalizeCoreRef, selectedTargetRefs: [], registrations: registrations.plan_finalize,
        universe: {
          slotIds: [...versions.keys()].sort(),
          relationIds: targetMap.relations.map((relation) => relation.relationId).sort(),
          mapNodeIds: targetMap.nodes.map((node) => node.slotId).sort(),
          artifactDigest: null,
        },
        slotTypes: input.slotTypes, context: { requiredSlotIds: systemCoverage.requiredSlotIds }, profile: input.profileBody,
      });
      const findings = findingsFromValidatorRun(run, reviewRoundId);
      const produced = runPreparedBlobs(store, run, findings);
      if (run.aggregate.outcome === 'clear'
        && systemCoverage.requiredSlotIds.some((slotId) => versions.get(slotId)?.state !== 'set')) {
        throw new Error('clear migration finalizer omitted required set content');
      }
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
  const priorReviewSettlementHandler = input.systemCommands.resolve('review_settlement');
  input.systemCommands.replace(createMigrationValidationBatchSystemCommandHandler(service));
  input.systemCommands.replace(createMigrationReviewSettlementSystemCommandHandler(
    service,
    input.resolve,
    priorReviewSettlementHandler,
  ));
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
    const reviewRound = await this.resolveAs<MapReviewRoundV2>(input.taskId, input.reviewRoundRef, 'migration Map review round');
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
      let equivalence: LocalValidatorEquivalenceResultV2;
      try {
        const custody = await this.deps.localValidatorCustody({ taskId: input.taskId, slotId, decision, plan });
        equivalence = proveLocalValidatorEquivalence({
          slotId,
          sourceVersionRef: decision.sourceVersionRef,
          sourceMapRef: intent.sourceMapRef,
          targetMapRef: intent.targetMapRef,
          sourceBatchInputRef: custody.sourceBatchInputRef,
          equivalencePolicyVersion: this.deps.equivalencePolicyVersion,
          source: custody.source,
          target: custody.target,
        });
      } catch {
        // Missing, corrupt, or non-transitively-authoritative old custody is a
        // cache miss, not a migration failure.  The target-Map validator owns
        // the conservative fallback decision.
        equivalence = {
          kind: 'fresh_validation_required',
          changedDimensions: [
            'frozenRegistrationSetDigest', 'selectorExpansionDigest', 'contentBytesDigest',
            'localMapSubgraphDigest', 'localRelationContextDigest',
          ],
        };
      }
      if (equivalence.kind === 'equivalent') {
        const proofRef = await this.deps.facade.prepareBlob(input.taskId, 'local_validator_equivalence_proof', equivalence.proof);
        preparedRefs.push(proofRef);
        slotResults.push({ outcome: 'equivalent', slotId, localValidatorEquivalenceProofRef: proofRef });
      } else {
        const fresh = await this.deps.freshValidate({
          taskId: input.taskId, reviewRoundId: reviewRound.mapReviewRoundId,
          slotId, decision, plan, planSpecRef: input.planSpecRef, batchOrdinal: ordinal,
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
    const reviewRound = await this.resolveAs<MapReviewRoundV2>(input.taskId, input.reviewRoundRef, 'migration Map review round');
    const completed = await this.deps.completedBatches(input.taskId, input.planSpecRef);
    const orderedResultRefs = validateMigrationBatchClosure(plan, completed);
    const classifiedBatches = await validateAndClassifyMigrationBatchResults({
      taskId: input.taskId,
      plan,
      planSpecRef: input.planSpecRef,
      intent,
      selectorRegistrations: this.deps.batchRegistrations,
      orderedResultRefs,
      resolve: (ref) => this.deps.resolve(input.taskId, ref),
    });
    const resultBySlot = classifiedBatches.resultBySlot;
    let batchRouteOutcome = classifiedBatches.batchRouteOutcome;
    const rejectedFindingSetRefs = classifiedBatches.rejectedFindingSetRefs;
    const preparedRefs: BlobRefV2[] = [...orderedResultRefs];
    const batchWarningCustodyRefs = new Map<string, BlobRefV2>();
    for (const result of classifiedBatches.results) {
      for (const slotResult of result.slotResults) {
        if (slotResult.outcome !== 'revalidated') continue;
        const aggregate = await this.resolveAs<ValidatorAggregateV2>(
          input.taskId,
          slotResult.validatorAggregateRef,
          `migration revalidated aggregate ${slotResult.slotId}`,
        );
        const custody = buildContentBatchWarningCustodyRoot({
          taskId: input.taskId,
          inputRef: aggregate.inputRef,
          inputDigest: aggregate.inputDigest,
          aggregateRef: slotResult.validatorAggregateRef,
          warningRootRef: slotResult.warningRootRef,
          batchOrdinal: result.batchOrdinal,
          planRevisionId: plan.migrationValidationPlanId,
        });
        const custodyRef = await this.deps.facade.prepareBlob(
          input.taskId,
          'validation_warning_custody_root',
          custody,
        );
        preparedRefs.push(custodyRef);
        batchWarningCustodyRefs.set(slotResult.slotId, custodyRef);
      }
    }
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
          const warningCustodyRef = batchWarningCustodyRefs.get(decision.slotId);
          if (warningCustodyRef === undefined) throw new Error(`migration revalidated slot '${decision.slotId}' lacks warning custody`);
          settlementDecisions.push({
            outcome: 'inherit_revalidated', slotId: decision.slotId, sourceVersionRef: decision.sourceVersionRef,
            compatibilityProofRef: decision.compatibilityProofRef,
            migratedBatchValidatorAggregateRef: slotResult.validatorAggregateRef,
            migratedBatchWarningRootRef: warningCustodyRef,
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
      taskId: input.taskId, reviewRoundId: reviewRound.mapReviewRoundId,
      finalizeCore, finalizeCoreRef, provisionalManifestRef, targetMapRef: intent.targetMapRef,
    });
    for (const blob of finalizer.preparedBlobs) preparedRefs.push(await this.deps.facade.prepareBlob(input.taskId, blob.kind, blob.value));
    preparedRefs.push(finalizer.finalizerAggregateRef, finalizer.finalizerWarningRootRef);
    const finalizerResolve = (ref: BlobRefV2) => this.deps.resolve(input.taskId, ref);
    const finalizerAggregate = await resolveVerifiedMigrationBlob<ValidatorAggregateV2>({
      ref: finalizer.finalizerAggregateRef, kind: 'validator_aggregate', label: 'migration finalizer aggregate', resolve: finalizerResolve,
    });
    validateCanonicalSelfDigest(finalizerAggregate as unknown as Record<string, unknown>, 'aggregateDigest', 'migration finalizer aggregate');
    if (finalizerAggregate.trigger !== 'content_commit' || finalizerAggregate.executionPhase !== 'plan_finalize') {
      throw new Error('migration finalizer aggregate has the wrong trigger/executionPhase');
    }
    const expectedFinalizerRegistrationDigest = this.deps.finalizerRegistrationSetDigest ?? this.deps.frozenRegistrationSetDigest;
    if (finalizerAggregate.registrationSetDigest !== expectedFinalizerRegistrationDigest) {
      throw new Error('migration finalizer aggregate has the wrong installed registration set');
    }
    if (finalizerAggregate.inputDigest !== finalizerAggregate.inputRef.digest) throw new Error('migration finalizer aggregate input digest is inconsistent');
    validateAggregateOutcomeClosure(finalizerAggregate, 'migration finalizer aggregate');
    const finalizerEnvelope = await resolveVerifiedMigrationBlob<ValidatorInputEnvelopeV2>({
      ref: finalizerAggregate.inputRef, kind: 'validator_input_envelope', label: 'migration finalizer input', resolve: finalizerResolve,
    });
    if (finalizerEnvelope.trigger !== 'content_commit' || finalizerEnvelope.executionPhase !== 'plan_finalize'
      || finalizerEnvelope.taskId !== input.taskId || !sameRef(finalizerEnvelope.contentValidationCoreRef, finalizeCoreRef)
      || finalizerEnvelope.selectedTargetRefs.length !== 0) {
      throw new Error('migration finalizer input does not bind the task/finalize core/empty selected targets');
    }
    const resolvedFinalizeCore = await resolveVerifiedMigrationBlob<ContentPlanFinalizeCoreV2>({
      ref: finalizerEnvelope.contentValidationCoreRef, kind: 'content_plan_finalize_core', label: 'migration finalizer core', resolve: finalizerResolve,
    });
    validateCanonicalSelfDigest(resolvedFinalizeCore as unknown as Record<string, unknown>, 'coreDigest', 'migration finalizer core');
    const finalizerWarning = await resolveVerifiedMigrationBlob<ValidationWarningRootV2>({
      ref: finalizer.finalizerWarningRootRef, kind: 'validation_warning_root', label: 'migration finalizer warning root', resolve: finalizerResolve,
    });
    validateWarningClosure({
      aggregate: finalizerAggregate, warningRef: finalizer.finalizerWarningRootRef,
      warning: finalizerWarning, phase: 'plan_finalize',
    });
    await validateAdvisoryReceiptClosure({
      aggregate: finalizerAggregate, envelopeRef: finalizerAggregate.inputRef,
      coreRef: finalizeCoreRef, targetRefs: [], resolve: finalizerResolve,
    });
    let derivedFinalizerRoute: MigrationBatchRouteOutcomeV2;
    if (finalizerAggregate.outcome === 'infrastructure_failure') {
      derivedFinalizerRoute = 'infrastructure_failure';
    } else if (finalizerAggregate.outcome === 'clear') {
      if (finalizer.classifiedFindingSetRef !== null) throw new Error('clear migration finalizer cannot carry a classified FindingSet');
      derivedFinalizerRoute = 'clear';
    } else {
      if (finalizer.classifiedFindingSetRef === null) throw new Error('blocking migration finalizer lacks classified FindingSet custody');
      await validateFindingSetReceiptClosure({
        aggregateRef: finalizer.finalizerAggregateRef,
        aggregate: finalizerAggregate,
        findingSetRef: finalizer.classifiedFindingSetRef,
        expectedEnvelopeRef: finalizerAggregate.inputRef,
        expectedCoreRef: finalizeCoreRef,
        expectedTargetRefs: [],
        expectedRegistrationSetDigest: expectedFinalizerRegistrationDigest,
        resolve: finalizerResolve,
      });
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
    const combinedFindingObjects: FindingV2[] = [];
    if (combinedFindings.findingSet !== null) {
      combinedClassifiedFindingSetRef = await this.deps.facade.prepareBlob(input.taskId, 'finding_set', combinedFindings.findingSet);
      preparedRefs.push(combinedClassifiedFindingSetRef);
      for (const findingRef of combinedFindings.findingSet.findingRefs) {
        const finding = await resolveVerifiedMigrationBlob<FindingV2>({
          ref: findingRef, kind: 'finding', label: 'combined migration Finding',
          resolve: (ref) => this.deps.resolve(input.taskId, ref),
        });
        combinedFindingObjects.push(finding);
        preparedRefs.push(findingRef);
      }
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
      const finalizerWarningCustody = buildContentFinalizerWarningCustodyRoot({
        taskId: input.taskId,
        inputRef: finalizerAggregate.inputRef,
        inputDigest: finalizerAggregate.inputDigest,
        aggregateRef: finalizer.finalizerAggregateRef,
        warningRootRef: finalizer.finalizerWarningRootRef,
        planRevisionId: plan.migrationValidationPlanId,
      });
      const finalizerWarningCustodyRef = await this.deps.facade.prepareBlob(
        input.taskId,
        'validation_warning_custody_root',
        finalizerWarningCustody,
      );
      preparedRefs.push(finalizerWarningCustodyRef);
      const finalized = computeProvisionalOrFinalizedManifest({
        taskId: input.taskId, mapRef: intent.targetMapRef, mapSemanticDigest: targetMap.mapSemanticDigest,
        taskContentRevision: migrated.manifest.taskContentRevision, manifestPhase: 'finalized', entries: migrated.manifest.entries,
        producerPlanSpecRef: input.planSpecRef, priorManifestRef: plan.sourceManifestRef,
        finalizerValidatorAggregateRefs: [finalizer.finalizerAggregateRef], finalizerWarningRootRefs: [finalizerWarningCustodyRef],
        resolvedVersions: migrated.versions,
      });
      migratedManifestRef = await this.deps.facade.prepareBlob(input.taskId, 'content_revision_manifest', finalized);
      preparedRefs.push(migratedManifestRef);
    }
    const route = await this.deps.prepareActivationRoute({
      taskId: input.taskId,
      settlementWorkItemId: input.workItemId,
      settlementOperationKey: attemptContinuationOperationId(input.taskId, input.workItemId, input.commandId, 'complete'),
      route: decision.combinedRouteOutcome,
      plan,
      sourceManifestRef: plan.sourceManifestRef,
      targetMapRef: intent.targetMapRef,
      migratedManifestRef,
      migrationSettlementCoreRef: settlementRef,
      migrationActivationDecisionRef: decisionRef,
      combinedClassifiedFindingSetRef,
      classifiedFindings: combinedFindingObjects,
    });
    const migrationFindingOpenings = combinedFindingObjects.length === 0 ? null : combinedFindingObjects.map((finding) => ({
      findingId: finding.findingId,
      findingRef: refOfBlob('finding', finding),
      reviewContext: finding.reviewContext,
      primaryLocation: finding.primaryLocation,
      defectClass: finding.defectClass,
      severity: finding.severity,
      source: finding.source,
      openedBy: finding.openedBy,
    }));
    const routeCarriers = { ...route.carriers, migrationFindingOpenings };
    validateMigrationActivationRouteCarriers(decision.combinedRouteOutcome, routeCarriers, migratedManifestRef);
    if (combinedFindingObjects.length > 0
      && (decision.combinedRouteOutcome === 'content_repair' || decision.combinedRouteOutcome === 'map_repair')) {
      const repairPlanRef = routeCarriers.mixedContentRepair?.repairPlanSpecRef;
      if (repairPlanRef === null || repairPlanRef === undefined) throw new Error('migration repair route lacks its exact RepairPlan spec ref');
      const repairPlan = await resolveVerifiedMigrationBlob<import('../../authoritative-review/authority-types').RepairPlanSpecV2>({
        ref: repairPlanRef, kind: 'repair_plan_spec', label: 'migration route RepairPlan',
        resolve: (ref) => this.deps.resolve(input.taskId, ref),
      });
      validateMigrationRepairPlanIdentity(repairPlan);
      const expectedFindingIds = combinedFindingObjects
        .filter((finding) => decision.combinedRouteOutcome === 'content_repair'
          ? finding.defectClass === 'content'
          : finding.defectClass !== 'content')
        .map((finding) => finding.findingId)
        .sort();
      const plannedFindingIds = [...new Set(repairPlan.orderedBatchScopes.flatMap((scope) => scope.findingIds))].sort();
      if (canonicalJsonSha256(plannedFindingIds) !== canonicalJsonSha256(expectedFindingIds)) {
        throw new Error('migration route RepairPlan does not consume the exact projected system Findings');
      }
    }
    const terminal: SystemCommandTerminalCarrierV2 = {
      workItemId: input.workItemId, commandId: input.commandId, commandKind: 'review_settlement',
      leaseEpoch: input.leaseEpoch, authorityBaseRef: input.authorityBaseRef,
    };
    const carriers = {
      ...routeCarriers,
      migrationSettlementCoreRef: settlementRef,
      migrationActivationDecisionRef: decisionRef,
      migrationProvisionalManifestRef: provisionalManifestRef,
      migrationFinalizerAggregateRef: finalizer.finalizerAggregateRef,
      terminal,
    };
    preparedRefs.push(...route.preparedRefs);
    const operationId = attemptContinuationOperationId(input.taskId, input.workItemId, input.commandId, 'complete');
    // Capture the publish tail BEFORE the final projection/authority read.
    // A change before the read is rejected by that read; a change after this
    // captured tail is rejected by publishWithPin's CAS. There is no window in
    // which stale migration output can be pinned on top of newer authority.
    const tail = await this.deps.tail(input.taskId);
    await this.assertPostMigrationAuthorityCurrent(input, plan, intent);
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

/**
 * Installs the production post-migration half of `review_settlement` without
 * stealing ordinary Map-review settlement commands. The payload kind is the
 * closed system-owned stage discriminator; non-migration payloads continue to
 * the handler that was installed before the migration runtime was composed.
 */
export function createMigrationReviewSettlementSystemCommandHandler(
  service: MigrationServiceV2,
  resolve: (taskId: string, ref: BlobRefV2) => Promise<unknown> | unknown,
  prior: SystemCommandHandler | null,
): SystemCommandHandler {
  return {
    commandKind: 'review_settlement',
    async execute(ctx) {
      if (ctx.payloadRef.kind !== 'migration_validation_plan_spec') {
        if (prior !== null) return prior.execute(ctx);
        return {
          kind: 'retryable_failure',
          failureCode: 'MAP_REVIEW_SETTLEMENT_HANDLER_MISSING',
          failureDigest: canonicalJsonSha256({ commandId: ctx.commandId, payloadRef: ctx.payloadRef }),
        };
      }
      const base = await resolve(ctx.taskId, ctx.authorityBaseRef) as AuthorityBaseSetV2 | null;
      if (base === null || base.reviewCoverageCoreRef === null || base.reviewRoundRef === null) {
        return {
          kind: 'retryable_failure',
          failureCode: 'MIGRATION_AUTHORITY_STALE',
          failureDigest: canonicalJsonSha256({ commandId: ctx.commandId, authorityBaseRef: ctx.authorityBaseRef }),
        };
      }
      return service.executePostMigrationSettlement({
        taskId: ctx.taskId,
        commandId: ctx.commandId,
        workItemId: ctx.workItemId,
        leaseEpoch: ctx.leaseEpoch,
        authorityBaseRef: ctx.authorityBaseRef,
        planSpecRef: ctx.payloadRef,
        reviewCoverageCoreRef: base.reviewCoverageCoreRef,
        reviewRoundRef: base.reviewRoundRef,
        settlementOperationId: attemptContinuationOperationId(ctx.taskId, ctx.workItemId, ctx.commandId, 'complete'),
      });
    },
  };
}
