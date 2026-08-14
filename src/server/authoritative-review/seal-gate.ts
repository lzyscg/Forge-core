/**
 * Pure Seal Gate (Task 3, design §16.2; spec §13.5/§7.1). The system-only
 * ten-condition deterministic gate — never a model verdict. Conditions 1/2
 * use the EXACT refs (a bare digest or equal semantic/content root never
 * satisfies a Gate); condition 5 treats the zero-relation set as naturally
 * satisfied; condition 9 counts advisory receipts as clear.
 *
 * Pure module: no fs/EventStore/provider/HTTP/React, no wall clock, no random.
 * Cross-object resolution (resolving a ref to its object) happens in the
 * runtime; this module consumes resolved identities and facts.
 */
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';

export const sealConditionCodes = {
  MAP_REF_MISMATCH: 'MAP_REF_MISMATCH',
  MANIFEST_REF_MISMATCH: 'MANIFEST_REF_MISMATCH',
  MAP_REVIEW_BUNDLE_MISSING: 'MAP_REVIEW_BUNDLE_MISSING',
  PRESENCE_COVERAGE_INCOMPLETE: 'PRESENCE_COVERAGE_INCOMPLETE',
  RELATION_COVERAGE_INCOMPLETE: 'RELATION_COVERAGE_INCOMPLETE',
  OBSERVATION_INCOMPLETE: 'OBSERVATION_INCOMPLETE',
  BLOCKING_FINDINGS_OPEN: 'BLOCKING_FINDINGS_OPEN',
  PENDING_OR_STALE_REVIEW: 'PENDING_OR_STALE_REVIEW',
  VALIDATOR_NOT_CLEAR: 'VALIDATOR_NOT_CLEAR',
  TEMPLATE_MISMATCH: 'TEMPLATE_MISMATCH',
} as const;

export type SealConditionCode = (typeof sealConditionCodes)[keyof typeof sealConditionCodes];

export interface SealGateUnmetConditionV2 {
  code: SealConditionCode;
  /** stable reason text (never module internals, paths or provider output). */
  detail: string;
}

export type SlotCoverageFact =
  | { disposition: 'reviewed'; slotId?: string; verdict: 'pass' | 'reject' }
  | { disposition: 'absent_not_applicable'; slotId?: string };

export interface PreSealValidatorAggregateV2 {
  outcome: 'clear' | 'blocking_invalid' | 'infrastructure_failure';
  advisoryReceiptCount: number;
  inputClosureMatchesBaseline: boolean;
}

export interface SealGateInputV2 {
  taskId: string;
  templateSnapshotHash: string;
  assemblerDigest: string;
  resourceManifestDigest: string;
  /** §16.2 condition 10: the frozen template's pinned identities. */
  frozenTemplateSnapshotHash: string;
  frozenAssemblerDigest: string;
  frozenResourceManifestDigest: string;
  /** §16.2 condition 1/3: the ACTIVE Map and its pre-review bundle. */
  activeMapRef: BlobRefV2;
  activeMapSemanticDigest: string;
  activeMapReviewBundleRef: BlobRefV2 | null;
  mapRefInMapReviewBundle: BlobRefV2;
  /** The current ReviewBundle ref whose custody closure binds the same refs below. */
  reviewBundleRef: BlobRefV2;
  /** Condition 2: the base's current manifest vs the ReviewBundle coverage core's manifest. */
  baseFinalizedManifestRef: BlobRefV2;
  reviewBundleCoverageManifestRef: BlobRefV2;
  contentRootDigest: string;
  contentRootDigestOfReviewBundle: string;
  /** Condition 4: presence-aware coverage; every required/set slot needs a current fact. */
  requiredSetSlots: readonly string[];
  slotFacts: ReadonlyMap<string, SlotCoverageFact>;
  /** Every optional-unset slot of the current Map: each needs the system absence fact. */
  optionalUnsetSlotIds: readonly string[];
  optionalUnsetSlots: ReadonlyMap<string, SlotCoverageFact>;
  /** Condition 5: ALL actual blocking relations need a current satisfied. */
  blockingRelationIds: readonly string[];
  relationVerdicts: ReadonlyMap<string, 'satisfied' | 'violated'>;
  /** Condition 6: root-level whole-tree receipt with full child closure on the current baseline. */
  wholeTreeObservationComplete: boolean;
  /** Condition 7: none in open/repair_planned/repair_dispatched/addressed. */
  blockingFindings: readonly { findingId: string; severity: 'blocking' | 'advisory'; status: string }[];
  /** Condition 8. */
  pendingOrStaleReviewTargetCount: number;
  activeRepairGrant: boolean;
  /** Condition 9: advisory receipts count as clear; blocking/infrastructure do not. */
  preSealValidatorAggregates: readonly PreSealValidatorAggregateV2[];
}

export interface SealGateResultV2 {
  eligible: boolean;
  unmetConditionCount: number;
  unmetConditions: SealGateUnmetConditionV2[];
}

function refsEqual(a: BlobRefV2, b: BlobRefV2): boolean {
  return a.kind === b.kind && a.digest === b.digest && a.byteLength === b.byteLength;
}

/**
 * The ten hard conditions of design §16.2. Returns structured unmet
 * conditions; the runtime calls the Assembler only when the list is empty.
 * `contentRootDigest` equality is NOT a substitute for ref equality anywhere.
 */
export function evaluateSealGate(input: SealGateInputV2): SealGateResultV2 {
  const unmet: SealGateUnmetConditionV2[] = [];

  // 1. exact MapSnapshotRef equality with the MapReviewBundle closure.
  if (!refsEqual(input.activeMapRef, input.mapRefInMapReviewBundle)) {
    unmet.push({
      code: sealConditionCodes.MAP_REF_MISMATCH,
      detail: 'the active MapSnapshotRef differs from the MapReviewBundle closure ref (equal mapSemanticDigest is not enough)',
    });
  }

  // 2. exact finalized ContentRevisionManifestRef equality with the ReviewBundle's
  //    coverage core ref; identical contentRootDigest never satisfies it.
  if (!refsEqual(input.baseFinalizedManifestRef, input.reviewBundleCoverageManifestRef)) {
    unmet.push({
      code: sealConditionCodes.MANIFEST_REF_MISMATCH,
      detail:
        input.contentRootDigest === input.contentRootDigestOfReviewBundle
          ? 'the ReviewBundle binds a DIFFERENT manifest with the SAME content root — page revisions differ and the Gate rejects'
          : 'the ReviewBundle binds a different contentRevisionManifestRef than the current finalized manifest',
    });
  }

  // 3. the active Map must carry a current mapReviewBundleRef.
  if (input.activeMapReviewBundleRef === null || input.activeMapReviewBundleRef.digest.length === 0) {
    unmet.push({ code: sealConditionCodes.MAP_REVIEW_BUNDLE_MISSING, detail: 'the active Map lacks a current system-approved mapReviewBundleRef' });
  }

  // 4. presence-aware slot coverage: every required/set slot needs a current
  //    pass; optional-unset needs the current system absence fact.
  for (const slotId of input.requiredSetSlots) {
    const fact = input.slotFacts.get(slotId);
    if (fact === undefined || fact.disposition !== 'reviewed' || fact.verdict !== 'pass') {
      unmet.push({
        code: sealConditionCodes.PRESENCE_COVERAGE_INCOMPLETE,
        detail: `slot '${slotId}' lacks a current pass (required/rewrite_required never seal)`,
      });
    }
  }
  for (const slotId of input.optionalUnsetSlotIds) {
    const fact = input.optionalUnsetSlots.get(slotId);
    if (fact === undefined || fact.disposition !== 'absent_not_applicable') {
      unmet.push({
        code: sealConditionCodes.PRESENCE_COVERAGE_INCOMPLETE,
        detail: `optional slot '${slotId}' lacks the current system absent_not_applicable fact`,
      });
    }
  }

  // 5. all actual blocking relations satisfied; zero relations pass naturally.
  for (const relationId of input.blockingRelationIds) {
    if (input.relationVerdicts.get(relationId) !== 'satisfied') {
      unmet.push({
        code: sealConditionCodes.RELATION_COVERAGE_INCOMPLETE,
        detail: `blocking relation '${relationId}' lacks a current satisfied verdict`,
      });
    }
  }

  // 6. layered whole-tree observation root + child closure current.
  if (!input.wholeTreeObservationComplete) {
    unmet.push({ code: sealConditionCodes.OBSERVATION_INCOMPLETE, detail: 'the layered whole-tree observation is not complete on the current baseline' });
  }

  // 7. no open/repair_planned/repair_dispatched/addressed blocking Finding.
  for (const f of input.blockingFindings) {
    if (f.severity === 'blocking' && (f.status === 'open' || f.status === 'repair_planned' || f.status === 'repair_dispatched' || f.status === 'addressed')) {
      unmet.push({ code: sealConditionCodes.BLOCKING_FINDINGS_OPEN, detail: `blocking finding '${f.findingId}' is still '${f.status}'` });
    }
  }

  // 8. no pending/stale review and no active RepairGrant.
  if (input.pendingOrStaleReviewTargetCount > 0) {
    unmet.push({ code: sealConditionCodes.PENDING_OR_STALE_REVIEW, detail: `${input.pendingOrStaleReviewTargetCount} target(s) have pending or stale review state` });
  }
  if (input.activeRepairGrant) {
    unmet.push({ code: sealConditionCodes.PENDING_OR_STALE_REVIEW, detail: 'an active RepairGrant is outstanding' });
  }

  // 9. every deterministic pre-seal ValidatorAggregate executed with outcome
  //    clear (advisory receipts count as clear); input closure must bind the
  //    same Map/manifest/ReviewBundle refs.
  if (input.reviewBundleRef.kind !== 'review_bundle' || input.reviewBundleRef.digest.length === 0) {
    unmet.push({ code: sealConditionCodes.VALIDATOR_NOT_CLEAR, detail: 'the current ReviewBundle ref is missing or malformed' });
  }
  if (input.preSealValidatorAggregates.length === 0) {
    unmet.push({ code: sealConditionCodes.VALIDATOR_NOT_CLEAR, detail: 'no pre-seal ValidatorAggregate executed' });
  }
  for (const aggregate of input.preSealValidatorAggregates) {
    if (aggregate.outcome !== 'clear') {
      unmet.push({
        code: sealConditionCodes.VALIDATOR_NOT_CLEAR,
        detail: aggregate.outcome === 'blocking_invalid'
          ? 'a pre-seal validator produced blocking invalid (advisory-only would count as clear)'
          : 'a pre-seal validator produced an infrastructure failure',
      });
    }
    if (!aggregate.inputClosureMatchesBaseline) {
      unmet.push({ code: sealConditionCodes.VALIDATOR_NOT_CLEAR, detail: 'a pre-seal aggregate input closure does not bind the same Map/manifest/ReviewBundle' });
    }
  }

  // 10. assembler/resource-manifest/snapshot hash consistency with the frozen template.
  if (input.templateSnapshotHash !== input.frozenTemplateSnapshotHash) {
    unmet.push({ code: sealConditionCodes.TEMPLATE_MISMATCH, detail: 'template snapshot hash differs from the frozen template identity' });
  }
  if (input.assemblerDigest !== input.frozenAssemblerDigest) {
    unmet.push({ code: sealConditionCodes.TEMPLATE_MISMATCH, detail: 'assembler digest differs from the frozen template identity' });
  }
  if (input.resourceManifestDigest !== input.frozenResourceManifestDigest) {
    unmet.push({ code: sealConditionCodes.TEMPLATE_MISMATCH, detail: 'resource manifest digest differs from the frozen template identity' });
  }

  return {
    eligible: unmet.length === 0,
    unmetConditionCount: unmet.length,
    unmetConditions: unmet,
  };
}

/** §16.2 condition 10 exact: frozen template identity must match the gate inputs. */
export function assertTemplateIdentityMatchesSeal(input: {
  templateSnapshotHash: string;
  assemblerDigest: string;
  resourceManifestDigest: string;
  frozenTemplateSnapshotHash: string;
  frozenAssemblerDigest: string;
  frozenResourceManifestDigest: string;
}): string[] {
  const errors: string[] = [];
  if (input.templateSnapshotHash !== input.frozenTemplateSnapshotHash) errors.push('snapshot hash mismatch');
  if (input.assemblerDigest !== input.frozenAssemblerDigest) errors.push('assembler digest mismatch');
  if (input.resourceManifestDigest !== input.frozenResourceManifestDigest) errors.push('resource manifest digest mismatch');
  return errors;
}