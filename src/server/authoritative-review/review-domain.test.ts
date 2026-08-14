// @vitest-environment node
/**
 * Review-domain tests (Task 3 brief Step 1): fact/adoption rules,
 * whole-observation non-adoption, zero-relations natural coverage, coverage
 * settlement closure, deterministic batching and layered observation.
 * Normative: design §11.4/§11.6/§11.10/§12.3/§12.6/§16.1; spec §7.4.
 */
import { describe, expect, it } from 'vitest';
import { refOfBlob } from './object-registry';
import {
  adoptHistoricalFact,
  assertCoverageSourcesDisjoint,
  assertReviewRoundTransition,
  canFactBeAdopted,
  planLayeredObservations,
  planReviewBatches,
  settleContentRoundCoverage,
  validateAdoptionRecordContext,
} from './review-domain';
import type { ReviewFactV2 } from './authority-types';
import type { BatchRelationV2, BatchTargetV2 } from './review-domain';

function fact(overrides: Partial<ReviewFactV2> = {}): ReviewFactV2 {
  return {
    factId: 'f1',
    targetKind: 'content_slot' as const,
    targetStableId: 's1',
    verdict: 'pass' as const,
    factOrigin: { kind: 'batch', adoptionEligible: true },
    adoptionEligible: true,
    localSubjectDigest: 'sub',
    localContextDigest: 'ctx',
    reviewPolicyDigest: 'pol',
    findingIds: [],
    evidence: [],
    reviewerAttemptId: 'a1',
    recordedAt: '2026-08-14T10:00:00.000Z',
    ...overrides,
  };
}

describe('review facts and adoption (§11.4/§7.4)', () => {
  it('whole-observation facts are never adoption-eligible', () => {
    expect(
      canFactBeAdopted({ ...fact(), factOrigin: { kind: 'whole_observation', adoptionEligible: false }, adoptionEligible: false }),
    ).toBe(false);
    expect(canFactBeAdopted(fact())).toBe(true);
  });

  it('adoption hard-rejects whole-observation facts and adoptionEligible=false', () => {
    const whole: ReviewFactV2 = {
      ...fact(),
      factOrigin: { kind: 'whole_observation', adoptionEligible: false },
      adoptionEligible: false,
    };
    expect(() => adoptHistoricalFact(whole, 'round-2', 't-2')).toThrow(/never adoption-eligible/);
    expect(() =>
      adoptHistoricalFact({ ...fact(), adoptionEligible: false }, 'round-2', 't-2'),
    ).toThrow(/adoption-eligible/);
  });

  it('adoption succeeds when subject/context/policy all match the current baseline', () => {
    const record = adoptHistoricalFact(fact(), 'round-2', 't-2');
    expect(record.roundKind).toBe('content');
    expect(record.roundId).toBe('round-2');
    expect(record.factId).toBe('f1');
    expect(record.expectedLocalSubjectDigest).toBe('sub');
    expect(record.adoptedBy).toBe('system');
    expect(() =>
      validateAdoptionRecordContext(record, { subjectDigest: 'sub', contextDigest: 'ctx', policyDigest: 'pol' }),
    ).not.toThrow();
  });

  it('adoption context mismatch is rejected (cannot inherit)', () => {
    const record = adoptHistoricalFact(fact(), 'round-2', 't-2');
    expect(() =>
      validateAdoptionRecordContext(record, { subjectDigest: 'other', contextDigest: 'ctx', policyDigest: 'pol' }),
    ).toThrow('SCHEMA_INVALID');
    expect(() =>
      validateAdoptionRecordContext(record, { subjectDigest: 'sub', contextDigest: 'ctx', policyDigest: 'pol2' }),
    ).toThrow('SCHEMA_INVALID');
  });

  it('map facts adopt into map rounds, content facts into content rounds', () => {
    const mapFact = {
      ...fact(),
      targetKind: 'map_node' as const,
    };
    expect(adoptHistoricalFact(mapFact, 'map-round', 'cand-1').roundKind).toBe('map');
  });
});

describe('coverage settlement (§16.1)', () => {
  it('zero-relations natural coverage: no relations means the relation condition holds', () => {
    const result = settleContentRoundCoverage({
      reviewRoundId: 'r1',
      coverageSlotIds: ['a'],
      coverageRelationIds: [],
      resolvedCoreSlotFacts: [{ slotId: 'a', disposition: 'reviewed', verdict: 'pass' }],
      blockingRelationVerdicts: new Map(),
      verificationTargets: [],
      currentVerificationRecords: new Map(),
      assignmentComplete: true,
      wholeTreeObservationBoundToBaseline: true,
      findings: [],
      reviewPolicyDigestBound: true,
    });
    expect(result.complete).toBe(true);
    expect(result.unmet).toEqual([]);
  });

  it('missing slot fact, missing verification or stale observation are reported as unmet conditions', () => {
    const result = settleContentRoundCoverage({
      reviewRoundId: 'r1',
      coverageSlotIds: ['a', 'b'],
      coverageRelationIds: [],
      resolvedCoreSlotFacts: [{ slotId: 'a', disposition: 'reviewed', verdict: 'pass' }],
      blockingRelationVerdicts: new Map(),
      verificationTargets: ['f1'],
      currentVerificationRecords: new Map(),
      assignmentComplete: true,
      wholeTreeObservationBoundToBaseline: false,
      findings: [],
      reviewPolicyDigestBound: true,
    });
    expect(result.complete).toBe(false);
    expect(result.unmet).toEqual(expect.arrayContaining([expect.stringContaining('slot')]));
    expect(result.unmet).toEqual(expect.arrayContaining([expect.stringContaining('observation')]));
    expect(result.unmet).toEqual(expect.arrayContaining([expect.stringContaining('verification')]));
  });

  it('blocking relation violated blocks settlement even when every slot passes', () => {
    const result = settleContentRoundCoverage({
      reviewRoundId: 'r1',
      coverageSlotIds: ['a'],
      coverageRelationIds: ['rel1'],
      resolvedCoreSlotFacts: [{ slotId: 'a', disposition: 'reviewed', verdict: 'pass' }],
      blockingRelationVerdicts: new Map([['rel1', 'violated']]),
      verificationTargets: [],
      currentVerificationRecords: new Map(),
      assignmentComplete: true,
      wholeTreeObservationBoundToBaseline: true,
      findings: [],
      reviewPolicyDigestBound: true,
    });
    expect(result.complete).toBe(false);
    expect(result.unmet.join(' ')).toContain('rel1');
  });

  it('open blocking Finding blocks settlement; advisory Finding does not', () => {
    const blocking = settleContentRoundCoverage({
      reviewRoundId: 'r1',
      coverageSlotIds: [],
      coverageRelationIds: [],
      resolvedCoreSlotFacts: [],
      blockingRelationVerdicts: new Map(),
      verificationTargets: [],
      currentVerificationRecords: new Map(),
      assignmentComplete: true,
      wholeTreeObservationBoundToBaseline: true,
      findings: [{ severity: 'blocking', status: 'open' }],
      reviewPolicyDigestBound: true,
    });
    expect(blocking.complete).toBe(false);
    const advisory = settleContentRoundCoverage({
      reviewRoundId: 'r1',
      coverageSlotIds: [],
      coverageRelationIds: [],
      resolvedCoreSlotFacts: [],
      blockingRelationVerdicts: new Map(),
      verificationTargets: [],
      currentVerificationRecords: new Map(),
      assignmentComplete: true,
      wholeTreeObservationBoundToBaseline: true,
      findings: [{ severity: 'advisory', status: 'open' }],
      reviewPolicyDigestBound: true,
    });
    expect(advisory.complete).toBe(true);
  });
});

describe('coverage fact uniqueness (Minor #7)', () => {
  it('duplicate coverage facts for one slot are a hard failure, never last-writer-wins', () => {
    expect(() =>
      settleContentRoundCoverage({
        reviewRoundId: 'r1',
        coverageSlotIds: ['a'],
        coverageRelationIds: [],
        resolvedCoreSlotFacts: [
          { disposition: 'reviewed', slotId: 'a', verdict: 'pass' },
          { disposition: 'reviewed', slotId: 'a', verdict: 'reject' },
        ],
        blockingRelationVerdicts: new Map(),
        verificationTargets: [],
        currentVerificationRecords: new Map(),
        assignmentComplete: true,
        wholeTreeObservationBoundToBaseline: true,
        findings: [],
        reviewPolicyDigestBound: true,
      }),
    ).toThrow('more than one coverage fact');
  });
});

describe('round lifecycle and coverage sources (§11.10/§12.4)', () => {
  it('planned -> reviewing_batches -> whole_tree_observation -> completed -> settled', () => {
    expect(() => assertReviewRoundTransition('planned', 'reviewing_batches')).not.toThrow();
    expect(() => assertReviewRoundTransition('reviewing_batches', 'whole_tree_observation')).not.toThrow();
    expect(() => assertReviewRoundTransition('whole_tree_observation', 'completed')).not.toThrow();
    expect(() => assertReviewRoundTransition('completed', 'settled')).not.toThrow();
    expect(() => assertReviewRoundTransition('planned', 'completed')).toThrow('SCHEMA_INVALID');
  });

  it('current committed facts and adopted historical facts are disjoint coverage sources', () => {
    const ledgerTargets = new Set(['a', 'b']);
    const adoptedTargets = new Set(['c', 'd']);
    expect(() => assertCoverageSourcesDisjoint(ledgerTargets, adoptedTargets)).not.toThrow();
    expect(() => assertCoverageSourcesDisjoint(ledgerTargets, new Set(['b']))).toThrow('SCHEMA_INVALID');
  });
});

describe('deterministic batching (§12.3)', () => {
  const targets: BatchTargetV2[] = [
    { id: 'a', documentOrder: 0, parentId: null },
    { id: 'b', documentOrder: 1, parentId: null },
    { id: 'c', documentOrder: 2, parentId: 'a' },
    { id: 'd', documentOrder: 3, parentId: null },
    { id: 'e', documentOrder: 4, parentId: null },
    { id: 'f', documentOrder: 5, parentId: null },
  ];
  const relations: BatchRelationV2[] = [
    { relationId: 'r1', typeId: 'causal', fromId: 'a', toId: 'f', enforcement: 'blocking' },
    { relationId: 'r2', typeId: 'sequence', fromId: 'c', toId: 'd', enforcement: 'advisory' },
  ];

  it('same input always yields the same deterministic plan', () => {
    const p1 = planReviewBatches(targets, relations, { batchTarget: 3 });
    const p2 = planReviewBatches([...targets].reverse(), [...relations].reverse(), { batchTarget: 3 });
    expect(p2.batches).toEqual(p1.batches);
    expect(p2.relationBatchAssignment).toEqual(p1.relationBatchAssignment);
  });

  it('blocking-connected targets cluster before document order', () => {
    const { batches } = planReviewBatches(targets, relations, { batchTarget: 3 });
    const first = batches[0] ?? [];
    // seed a then blocking connected f must be in the same batch as a when room allows
    expect(first.includes('a')).toBe(true);
    expect(first.includes('f')).toBe(true);
  });

  it('every relation is assigned to exactly one batch covering one of its endpoints', () => {
    const { batches, relationBatchAssignment } = planReviewBatches(targets, relations, { batchTarget: 2 });
    for (const rel of relations) {
      const idx = relationBatchAssignment[rel.relationId];
      expect(idx).toBeGreaterThanOrEqual(0);
      const batch = batches[idx];
      expect(batch.includes(rel.fromId) || batch.includes(rel.toId)).toBe(true);
    }
  });

  it('empty relation set degrades to purely positional batching without inventing edges', () => {
    const { batches } = planReviewBatches(targets, [], { batchTarget: 2 });
    expect(batches).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });
});

describe('layered whole observations (§12.6)', () => {
  const tree = [
    { slotId: 'root', parentId: null, documentOrder: 0 },
    { slotId: 'a', parentId: 'root', documentOrder: 0 },
    { slotId: 'b', parentId: 'root', documentOrder: 1 },
    { slotId: 'a1', parentId: 'a', documentOrder: 0 },
    { slotId: 'a2', parentId: 'a', documentOrder: 1 },
    { slotId: 'a3', parentId: 'a', documentOrder: 2 },
    { slotId: 'b1', parentId: 'b', documentOrder: 0 },
  ];

  it('produces leaf batches plus parent levels and a root observation, deterministically', () => {
    const plan = planLayeredObservations(tree.map((n) => ({ ...n })), { leafBatchSize: 2 });
    expect(plan.levels.length).toBeGreaterThanOrEqual(3);
    const lastLevel = plan.levels[plan.levels.length - 1];
    expect(lastLevel.observations).toHaveLength(1);
    expect(lastLevel.observations[0].parentScopeId).toBeNull();
    // every non-root level's observations are referenced by a parent level
    for (let i = 0; i < plan.levels.length - 1; i++) {
      const parentIds = new Set(plan.levels[i + 1].observations.map((o) => o.observationScopeId));
      const covered = plan.levels[i + 1].observations.flatMap((o) => o.childObservationScopeIds);
      expect(covered.length).toBe(plan.levels[i].observations.length);
      void parentIds;
    }
    const plan2 = planLayeredObservations(tree.map((n) => ({ ...n })), { leafBatchSize: 2 });
    expect(plan2).toEqual(plan);
  });
});