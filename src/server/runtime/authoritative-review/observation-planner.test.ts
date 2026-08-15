// @vitest-environment node
/**
 * Task 16 observation-planner tests (spec §13.1 step 5 / §12.3 / §12.6,
 * design §12.1/§12.3/§12.6): the deterministic layered whole-Map review plan.
 *
 * NORMATIVE CORE:
 * - Map pre-review covers EVERY candidate node and EVERY actual candidate
 *   relation exactly once — including advisory relations even when
 *   `reviewPolicy.reviewAdvisoryRelations=false` (spec §13.1 step 5: the flag
 *   is NOT consulted during Map pre-review);
 * - shuffled nodes/relations freeze IDENTICAL batches by document order /
 *   locality (deterministic §12.3 planning, ties by stable id);
 * - target/object limits: every batch stays within the profile's
 *   assignmentMaxPrimaryTargets and assignmentMaxTotalObjects;
 * - zero-relation graphs add NO relation assignment;
 * - layered whole-Map observations close to exactly one root (spec §12.6);
 * - the content-review selector DOES consult the flag: advisory relations are
 *   excluded from content relation-satisfaction targets when the flag is false,
 *   while all blocking relations are retained (spec §13.2 step 6).
 */
import { describe, expect, it } from 'vitest';
import { fullProfileForTests } from '../../authoritative-review/object-registry';
import type { MapPositionNodeV2, MapRelationV2, ReviewPolicyParameters } from '../../authoritative-review/authority-types';
import {
  planMapReview,
  selectContentRelationTargets,
  selectMapRelationTargets,
  type MapReviewPlanV2,
} from './observation-planner';

const PROFILE = fullProfileForTests();

function node(slotId: string, overrides: Partial<MapPositionNodeV2> = {}): MapPositionNodeV2 {
  return {
    slotId,
    slotType: 'doc',
    contentBearing: true,
    parentSlotId: null,
    documentOrder: Number(slotId.replace(/\D/g, '')) || 0,
    siblingOrder: 0,
    nodeSpecDigest: 'a'.repeat(64),
    ...overrides,
  };
}

function rel(relationId: string, fromId: string, toId: string): MapRelationV2 {
  return {
    relationId,
    typeId: 'xref',
    fromSlotId: fromId,
    toSlotId: toId,
    attributes: {},
    relationDigest: 'b'.repeat(64),
  };
}

function policy(overrides: Partial<ReviewPolicyParameters> = {}): ReviewPolicyParameters {
  return {
    mapReview: 'required',
    contentSelector: 'content_bearing',
    mapBatchTargetSlots: 24,
    contentBatchTargetSlots: 24,
    assignmentSoftLimit: 64,
    wholeMapObservation: 'required',
    wholeContentTreeObservation: 'required',
    reviewAdvisoryRelations: false,
    maxRounds: 8,
    ...overrides,
  };
}

function shuffle<T>(input: readonly T[]): T[] {
  return [...input].sort(() => 0.5 - Math.random());
}

/** Deterministic small tree: root + 3 children + 4 grandchildren. */
function sampleTree(): { nodes: MapPositionNodeV2[]; relations: MapRelationV2[] } {
  const nodes = [
    node('s-root', { documentOrder: 0, contentBearing: false }),
    node('s-a', { documentOrder: 1, parentSlotId: 's-root' }),
    node('s-b', { documentOrder: 2, parentSlotId: 's-root' }),
    node('s-c', { documentOrder: 3, parentSlotId: 's-root' }),
    node('s-a1', { documentOrder: 4, parentSlotId: 's-a' }),
    node('s-a2', { documentOrder: 5, parentSlotId: 's-a' }),
    node('s-b1', { documentOrder: 6, parentSlotId: 's-b' }),
    node('s-b2', { documentOrder: 7, parentSlotId: 's-b' }),
  ];
  const relations = [
    rel('r-ab', 's-a', 's-b'),
    rel('r-a1b1', 's-a1', 's-b1'),
  ];
  return { nodes, relations };
}

describe('planMapReview', () => {
  it('freezes IDENTICAL batches for shuffled node/relation inputs', () => {
    const { nodes, relations } = sampleTree();
    const p1 = planMapReview({ nodes, relations, profile: PROFILE, reviewPolicy: policy(), assignmentCount: 1 });
    const shuffledNodes = shuffle(nodes);
    const shuffledRelations = shuffle(relations);
    const p2 = planMapReview({ nodes: shuffledNodes, relations: shuffledRelations, profile: PROFILE, reviewPolicy: policy(), assignmentCount: 1 });
    expect(p2).toEqual(p1);
  });

  it('covers every Map node and every actual relation exactly once (advisory included even when reviewAdvisoryRelations=false)', () => {
    const { nodes, relations } = sampleTree();
    const plan = planMapReview({ nodes, relations, profile: PROFILE, reviewPolicy: policy({ reviewAdvisoryRelations: false }), assignmentCount: 1 });
    const coveredNodes = plan.batches.flatMap((b) => b.nodeIds);
    const coveredRelations = plan.batches.flatMap((b) => b.relationIds);
    expect(new Set(coveredNodes).size).toBe(nodes.length);
    expect(coveredNodes.sort()).toEqual(nodes.map((n) => n.slotId).sort());
    expect(new Set(coveredRelations).size).toBe(relations.length);
    expect(coveredRelations.sort()).toEqual(relations.map((r) => r.relationId).sort());
    // selectMapRelationTargets also returns EVERY relation regardless of the flag.
    expect(selectMapRelationTargets(relations)).toEqual(relations.map((r) => r.relationId).sort());
  });

  it('produces exactly the planned assignmentCount batches and stays within target/object limits', () => {
    const { nodes, relations } = sampleTree();
    const assignmentCount = 1;
    const plan = planMapReview({ nodes, relations, profile: PROFILE, reviewPolicy: policy(), assignmentCount });
    expect(plan.batches).toHaveLength(assignmentCount);
    for (const batch of plan.batches) {
      expect(batch.nodeIds.length + batch.relationIds.length).toBeLessThanOrEqual(PROFILE.assignmentMaxTotalObjects);
      expect(batch.nodeIds.length).toBeLessThanOrEqual(PROFILE.assignmentMaxPrimaryTargets);
    }
  });

  it('a large tree batches to exactly the round-planned assignmentCount', () => {
    // Root + middles + leaves (depth 3, <=100 children per parent). 2,000 nodes
    // keep the pure planner fast while proving the count-match property; the
    // full 10,000-slot closure is a Task 28/qualification concern.
    const nodes: MapPositionNodeV2[] = [];
    const push = (slotId: string, parent: string | null, order: number) =>
      nodes.push(node(slotId, { parentSlotId: parent, documentOrder: order }));
    push('n-0', null, 0);
    for (let m = 1; m < 100; m++) push(`n-${m}`, 'n-0', m);
    for (let l = 100; l < 2_000; l++) push(`n-${l}`, `n-${1 + (l % 99)}`, l);
    const relations: MapRelationV2[] = [];
    const assignmentCount = Math.max(1, Math.ceil((nodes.length + relations.length) / PROFILE.assignmentMaxPrimaryTargets));
    expect(assignmentCount).toBe(8);
    const plan = planMapReview({ nodes, relations, profile: PROFILE, reviewPolicy: policy(), assignmentCount });
    expect(plan.batches).toHaveLength(assignmentCount);
    const covered = plan.batches.flatMap((b) => b.nodeIds);
    expect(new Set(covered).size).toBe(nodes.length);
    for (const batch of plan.batches) {
      expect(batch.nodeIds.length).toBeLessThanOrEqual(PROFILE.assignmentMaxPrimaryTargets);
    }
  });

  it('F1 (review): 300 nodes + 300 relations plan to exactly the frozen assignmentCount (3)', () => {
    const nodes: MapPositionNodeV2[] = [];
    for (let i = 0; i < 300; i++) nodes.push(node(`n-${i}`, { parentSlotId: i === 0 ? null : 'n-0', documentOrder: i }));
    const relations: MapRelationV2[] = [];
    for (let i = 0; i < 300; i++) relations.push(rel(`r-${i}`, `n-${i}`, `n-${(i + 1) % 300}`));
    const assignmentCount = Math.max(1, Math.ceil((nodes.length + relations.length) / PROFILE.assignmentMaxPrimaryTargets));
    expect(assignmentCount).toBe(3);
    const plan = planMapReview({ nodes, relations, profile: PROFILE, reviewPolicy: policy(), assignmentCount });
    expect(plan.batches).toHaveLength(assignmentCount);
    const coveredNodes = plan.batches.flatMap((b) => b.nodeIds);
    const coveredRelations = plan.batches.flatMap((b) => b.relationIds);
    expect(new Set(coveredNodes).size).toBe(nodes.length);
    expect(new Set(coveredRelations).size).toBe(relations.length);
    for (const batch of plan.batches) {
      expect(batch.nodeIds.length + batch.relationIds.length).toBeLessThanOrEqual(PROFILE.assignmentMaxTotalObjects);
    }
  });

  it('F1 (review): 2113 nodes + 2112 relations plan to exactly the frozen assignmentCount (17)', () => {
    const nodes: MapPositionNodeV2[] = [];
    for (let i = 0; i < 2_113; i++) nodes.push(node(`n-${i}`, { parentSlotId: i === 0 ? null : 'n-0', documentOrder: i }));
    const relations: MapRelationV2[] = [];
    for (let i = 0; i < 2_112; i++) relations.push(rel(`r-${i}`, `n-${i}`, `n-${(i + 1) % 2_113}`));
    const assignmentCount = Math.max(1, Math.ceil((nodes.length + relations.length) / PROFILE.assignmentMaxPrimaryTargets));
    expect(assignmentCount).toBe(17);
    const plan = planMapReview({ nodes, relations, profile: PROFILE, reviewPolicy: policy(), assignmentCount });
    expect(plan.batches).toHaveLength(assignmentCount);
    const coveredNodes = plan.batches.flatMap((b) => b.nodeIds);
    const coveredRelations = plan.batches.flatMap((b) => b.relationIds);
    expect(new Set(coveredNodes).size).toBe(nodes.length);
    expect(new Set(coveredRelations).size).toBe(relations.length);
    for (const batch of plan.batches) {
      expect(batch.nodeIds.length + batch.relationIds.length).toBeLessThanOrEqual(PROFILE.assignmentMaxTotalObjects);
    }
  });

  it('F1 (review): a dense hub graph respects the per-batch OBJECT limit by deterministic relation redistribution', () => {
    // 256 nodes with a hub relation fan-out — the endpoint batches would
    // overflow the object cap, so relations redistribute deterministically.
    const nodes: MapPositionNodeV2[] = [];
    for (let i = 0; i < 256; i++) nodes.push(node(`n-${i}`, { parentSlotId: i === 0 ? null : 'n-0', documentOrder: i }));
    const rels: MapRelationV2[] = [];
    let k = 0;
    for (let i = 1; i < 256; i++) {
      for (let j = 0; j < 8 && k < 2000; j++, k++) rels.push(rel(`r-${k}`, `n-${i}`, 'n-0'));
    }
    const assignmentCount = Math.max(1, Math.ceil((nodes.length + rels.length) / PROFILE.assignmentMaxPrimaryTargets));
    const plan = planMapReview({ nodes, relations: rels, profile: PROFILE, reviewPolicy: policy(), assignmentCount });
    expect(plan.batches).toHaveLength(assignmentCount);
    const coveredRelations = plan.batches.flatMap((b) => b.relationIds);
    expect(new Set(coveredRelations).size).toBe(rels.length);
    for (const batch of plan.batches) {
      expect(batch.nodeIds.length).toBeLessThanOrEqual(PROFILE.assignmentMaxPrimaryTargets);
      expect(batch.nodeIds.length + batch.relationIds.length).toBeLessThanOrEqual(PROFILE.assignmentMaxTotalObjects);
    }
  });

  it('zero-relation graphs add NO relation assignment', () => {
    const { nodes } = sampleTree();
    const plan = planMapReview({ nodes, relations: [], profile: PROFILE, reviewPolicy: policy(), assignmentCount: 1 });
    expect(plan.relationTargets).toEqual([]);
    for (const batch of plan.batches) expect(batch.relationIds).toEqual([]);
  });

  it('plans bounded layered observations closing to exactly ONE root', () => {
    const { nodes, relations } = sampleTree();
    const plan = planMapReview({ nodes, relations, profile: PROFILE, reviewPolicy: policy(), assignmentCount: 1 });
    expect(plan.observationLevels.length).toBeGreaterThanOrEqual(1);
    // The root closure is the LAST level's single observation (design §12.6
    // "根级回执"): every level above the leaf batches climbs to exactly one
    // root observation whose parent is null.
    const lastLevel = plan.observationLevels[plan.observationLevels.length - 1];
    expect(lastLevel.observations).toHaveLength(1);
    expect(lastLevel.observations[0].parentScopeId).toBeNull();
    const allObservations = plan.observationLevels.flatMap((l) => l.observations);
    const byId = new Map(allObservations.map((o) => [o.observationScopeId, o]));
    // every observation's declared children exist in the plan
    for (const level of plan.observationLevels) {
      for (const o of level.observations) {
        for (const child of o.childObservationScopeIds) {
          expect(byId.get(child)).toBeDefined();
        }
      }
    }
    // the root receipt covers every candidate node
    const rootLevel = plan.observationLevels[plan.observationLevels.length - 1];
    const root = rootLevel.observations[0];
    expect([...root.coverageSlotIds].sort()).toEqual(nodes.map((n) => n.slotId).sort());
  });

  it('layered observations cover every candidate node exactly once at the leaf level', () => {
    const { nodes } = sampleTree();
    const plan = planMapReview({ nodes, relations: [], profile: PROFILE, reviewPolicy: policy(), assignmentCount: 1 });
    const leafLevel = plan.observationLevels[0];
    const covered = leafLevel.observations.flatMap((o) => o.coverageSlotIds);
    expect(new Set(covered).size).toBe(nodes.length);
    expect(covered.sort()).toEqual(nodes.map((n) => n.slotId).sort());
  });
});

describe('content relation-satisfaction selector', () => {
  const blocking = rel('r-block', 's-a', 's-b');
  const advisory = rel('r-adv', 's-a1', 's-b1');
  // Enforcement comes from the relation TYPE (template), not the relation
  // instance; the caller supplies the predicate.
  const isBlocking = (r: MapRelationV2): boolean => r.relationId === 'r-block';

  it('retains ALL blocking relations even when reviewAdvisoryRelations=false', () => {
    expect(selectContentRelationTargets([blocking, advisory], false, isBlocking)).toEqual(['r-block']);
  });

  it('includes advisory relations only when reviewAdvisoryRelations=true', () => {
    expect(selectContentRelationTargets([blocking, advisory], true, isBlocking).sort()).toEqual(['r-adv', 'r-block']);
  });

  it('Map pre-review does NOT consult the flag (advisory always covered)', () => {
    const { nodes } = sampleTree();
    const plan = planMapReview({ nodes, relations: [blocking, advisory], profile: PROFILE, reviewPolicy: policy({ reviewAdvisoryRelations: false }), assignmentCount: 1 });
    expect(plan.relationTargets.sort()).toEqual(['r-adv', 'r-block']);
  });
});
