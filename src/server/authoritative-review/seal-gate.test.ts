// @vitest-environment node
/**
 * Seal Gate tests (Task 3 brief Step 1): all ten hard conditions of design
 * §16.2; the Gate is a pure structured rejection with no model verdict. The
 * central case: the Gate rejects a ReviewBundle that binds a different
 * same-root manifest.
 */
import { describe, expect, it } from 'vitest';
import { refOfBlob } from './object-registry';
import { evaluateSealGate, sealConditionCodes } from './seal-gate';
import type { SealGateInputV2 } from './seal-gate';

/** Baseline: every condition satisfied except the overridden one. */
function happyInput(overrides: Partial<SealGateInputV2> = {}): SealGateInputV2 {
  const mapRef = refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'm' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r' }), sourceCandidateId: 'c' });
  const manifestRef = refOfBlob('content_revision_manifest', { manifestDigest: 'man' });
  return {
    taskId: 't1',
    templateSnapshotHash: 'snap-1',
    assemblerDigest: 'asm-1',
    resourceManifestDigest: 'res-1',
    frozenTemplateSnapshotHash: 'snap-1',
    frozenAssemblerDigest: 'asm-1',
    frozenResourceManifestDigest: 'res-1',
    activeMapRef: mapRef,
    activeMapSemanticDigest: 'sem',
    activeMapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r' }),
    mapRefInMapReviewBundle: mapRef,
    baseFinalizedManifestRef: manifestRef,
    reviewBundleCoverageManifestRef: manifestRef,
    reviewBundleRef: refOfBlob('review_bundle', { bundleDigest: 'rb' }),
    contentRootDigest: 'root-1',
    contentRootDigestOfReviewBundle: 'root-1',
    requiredSetSlots: ['s1', 's2'],
    slotFacts: new Map([
      ['s1', { disposition: 'reviewed', verdict: 'pass' }],
      ['s2', { disposition: 'reviewed', verdict: 'pass' }],
    ]),
    optionalUnsetSlotIds: ['s3'],
    optionalUnsetSlots: new Map([['s3', { disposition: 'absent_not_applicable' }]]),
    blockingRelationIds: ['rel1'],
    relationVerdicts: new Map([['rel1', 'satisfied']]),
    wholeTreeObservationComplete: true,
    blockingFindings: [],
    pendingOrStaleReviewTargetCount: 0,
    activeRepairGrant: false,
    preSealValidatorAggregates: [{ outcome: 'clear', advisoryReceiptCount: 0, inputClosureMatchesBaseline: true }],
    ...overrides,
  };
}

describe('Seal Gate (§16.2)', () => {
  it('all ten conditions met -> eligible with zero unmet conditions', () => {
    const result = evaluateSealGate(happyInput());
    expect(result.eligible).toBe(true);
    expect(result.unmetConditions).toEqual([]);
    expect(result.unmetConditionCount).toBe(0);
  });

  it('condition 2: rejects a ReviewBundle binding a different same-root manifest', () => {
    const otherManifestRef = refOfBlob('content_revision_manifest', { manifestDigest: 'man-other' });
    const input = happyInput({
      reviewBundleCoverageManifestRef: otherManifestRef,
      contentRootDigestOfReviewBundle: 'root-1', // SAME root, different manifest
    });
    const result = evaluateSealGate(input);
    expect(result.eligible).toBe(false);
    expect(result.unmetConditions.map((c) => c.code)).toContain('MANIFEST_REF_MISMATCH');
  });

  it('condition 1: only equal mapSemanticDigest is not enough — the exact map ref must match', () => {
    const otherMapRef = refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'm2' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r2' }), sourceCandidateId: 'c2' });
    const input = happyInput({
      mapRefInMapReviewBundle: otherMapRef,
      activeMapSemanticDigest: 'sem', // identical semantic digest, different ref
    });
    const result = evaluateSealGate(input);
    expect(result.eligible).toBe(false);
    expect(result.unmetConditions.map((c) => c.code)).toContain('MAP_REF_MISMATCH');
  });

  it('condition 3: active Map must carry a current mapReviewBundleRef', () => {
    const input = happyInput({ activeMapReviewBundleRef: null });
    expect(evaluateSealGate(input).unmetConditions[0]?.code).toBe('MAP_REVIEW_BUNDLE_MISSING');
  });

  it('condition 4: required-unset or rewrite_required slots never pass; optional-unset needs the system absence fact', () => {
    const missingAbsence = happyInput({ optionalUnsetSlots: new Map() });
    expect(evaluateSealGate(missingAbsence).unmetConditions.map((c) => c.code)).toContain('PRESENCE_COVERAGE_INCOMPLETE');

    const slotMissing = happyInput({ slotFacts: new Map([['s1', { disposition: 'reviewed', verdict: 'pass' }]]) });
    expect(evaluateSealGate(slotMissing).unmetConditions.map((c) => c.code)).toContain('PRESENCE_COVERAGE_INCOMPLETE');
    const rejected = happyInput({ slotFacts: new Map([
      ['s1', { disposition: 'reviewed', verdict: 'reject' }],
      ['s2', { disposition: 'reviewed', verdict: 'pass' }],
    ]) });
    expect(evaluateSealGate(rejected).unmetConditions.map((c) => c.code)).toContain('PRESENCE_COVERAGE_INCOMPLETE');
  });

  it('condition 5: zero blocking relations pass naturally; violated blocks', () => {
    const zero = happyInput({ blockingRelationIds: [], relationVerdicts: new Map() });
    expect(evaluateSealGate(zero).eligible).toBe(true);
    const violated = happyInput({ relationVerdicts: new Map([['rel1', 'violated']]) });
    expect(evaluateSealGate(violated).unmetConditions.map((c) => c.code)).toContain('RELATION_COVERAGE_INCOMPLETE');
  });

  it('condition 6: layered whole-tree observation must be complete and current', () => {
    expect(evaluateSealGate(happyInput({ wholeTreeObservationComplete: false })).unmetConditions[0]?.code).toBe(
      'OBSERVATION_INCOMPLETE',
    );
  });

  it('condition 7: any non-closed blocking Finding blocks the Gate', () => {
    const input = happyInput({
      blockingFindings: [
        { findingId: 'f1', severity: 'blocking', status: 'addressed' },
      ],
    });
    const { eligible, unmetConditions } = evaluateSealGate(input);
    expect(eligible).toBe(false);
    expect(unmetConditions.map((c) => c.code)).toContain('BLOCKING_FINDINGS_OPEN');
  });

  it('condition 8: pending/stale review or an active RepairGrant blocks', () => {
    expect(evaluateSealGate(happyInput({ pendingOrStaleReviewTargetCount: 1 })).eligible).toBe(false);
    expect(evaluateSealGate(happyInput({ pendingOrStaleReviewTargetCount: 0, activeRepairGrant: true })).eligible).toBe(false);
  });

  it('condition 9: advisory receipts count as clear; blocking invalid / infrastructure do not', () => {
    const advisory = happyInput({ preSealValidatorAggregates: [{ outcome: 'clear', advisoryReceiptCount: 2, inputClosureMatchesBaseline: true }] });
    expect(evaluateSealGate(advisory).eligible).toBe(true);

    const blockingInvalid = happyInput({ preSealValidatorAggregates: [{ outcome: 'blocking_invalid', advisoryReceiptCount: 0, inputClosureMatchesBaseline: true }] });
    expect(evaluateSealGate(blockingInvalid).eligible).toBe(false);

    const infra = happyInput({ preSealValidatorAggregates: [{ outcome: 'infrastructure_failure', advisoryReceiptCount: 0, inputClosureMatchesBaseline: true }] });
    expect(evaluateSealGate(infra).unmetConditions.map((c) => c.code)).toContain('VALIDATOR_NOT_CLEAR');
  });

  it('condition 10: assembler/resource manifest/snapshot hash must match the frozen template', () => {
    expect(evaluateSealGate(happyInput({ assemblerDigest: 'wrong' })).unmetConditions[0]?.code).toBe('TEMPLATE_MISMATCH');
    expect(evaluateSealGate(happyInput({ resourceManifestDigest: 'wrong' })).unmetConditions[0]?.code).toBe('TEMPLATE_MISMATCH');
    expect(evaluateSealGate(happyInput({ templateSnapshotHash: 'wrong' })).unmetConditions[0]?.code).toBe('TEMPLATE_MISMATCH');
  });

  it('is a pure deterministic function with a bounded condition-code vocabulary', () => {
    const a = evaluateSealGate(happyInput());
    const b = evaluateSealGate(happyInput());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.values(sealConditionCodes).sort()).toEqual(Object.values(sealConditionCodes).sort());
    expect(new Set(Object.values(sealConditionCodes)).size).toBe(Object.values(sealConditionCodes).length);
  });
});