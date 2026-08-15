/**
 * Task 16 observation-planner (spec §12.3/§12.6/§13.1 step 5, design
 * §12.1/§12.3/§12.6): the deterministic, graph-aware Map pre-review plan.
 *
 * NORMATIVE CORE:
 * - Map pre-review covers EVERY candidate node and EVERY actual candidate
 *   relation exactly once — including advisory relations even when
 *   `reviewPolicy.reviewAdvisoryRelations=false` (spec §13.1 step 5: the flag
 *   is NOT consulted during Map pre-review);
 * - the content-review relation-satisfaction selector DOES consult the flag
 *   (spec §13.2 step 6): advisory relations are excluded when the flag is
 *   false, blocking relations are always retained;
 * - deterministic §12.3 planning: first-unassigned-by-document-order seeds a
 *   batch, candidates are ordered by blocking-relation connected, direct
 *   position adjacency, advisory-relation connected, then remaining document
 *   order, ties broken by stable id — shuffled inputs freeze identical batches;
 * - the planner produces EXACTLY the round-planned `assignmentCount` batches
 *   (the `structured_map_review_round_planned.assignmentCount` is the frozen
 *   closure-gate count), each batch within the profile's
 *   `assignmentMaxPrimaryTargets` and `assignmentMaxTotalObjects`;
 * - zero-relation graphs add NO relation assignment (spec §13.1: the coverage
 *   set is empty and never blocks Map approval);
 * - layered whole-Map observations (design §12.6) close to exactly ONE root,
 *   every candidate node covered at the leaf level, every level's parent at
 *   exactly the level below.
 *
 * Pure module: no fs/EventStore/provider/HTTP/React, no wall clock, no random.
 */
import type {
  AuthoritativeReviewProfile,
  MapPositionNodeV2,
  MapRelationV2,
  ReviewPolicyParameters,
} from '../../authoritative-review/authority-types';
import {
  planLayeredObservations,
  planReviewBatches,
  type ObservationLevelV2,
} from '../../authoritative-review/review-domain';

/** One deterministic Map pre-review batch assignment (nodeIds + relationIds). */
export interface MapReviewBatchV2 {
  batchIndex: number;
  nodeIds: string[];
  relationIds: string[];
}

/** The complete deterministic Map pre-review plan. */
export interface MapReviewPlanV2 {
  /** Exactly `assignmentCount` batches. */
  batches: MapReviewBatchV2[];
  /** Every candidate node id (stable document-order). */
  nodeTargets: string[];
  /** Every actual candidate relation id (advisory INCLUDED always). */
  relationTargets: string[];
  /** Layered whole-Map observation levels (one root closure). */
  observationLevels: ObservationLevelV2[];
  /** relationId → batchIndex (deterministic earliest-covered-endpoint). */
  relationBatchAssignment: Readonly<Record<string, number>>;
}

/**
 * Map pre-review relation target selection: EVERY actual candidate relation —
 * advisory relations are covered even when `reviewAdvisoryRelations=false`
 * (spec §13.1 step 5 "advisory relations ARE covered by Map pre-review ALWAYS").
 */
export function selectMapRelationTargets(relations: readonly MapRelationV2[]): string[] {
  return relations.map((r) => r.relationId).sort();
}

/**
 * Content relation-satisfaction target selection (spec §13.2 step 6): blocking
 * relations are always required; advisory relations are added ONLY when
 * `reviewAdvisoryRelations=true`. Zero relations satisfy either quantifier
 * naturally. (Task 18's content planner consumes this; the distinction is
 * proven here.)
 */
export function selectContentRelationTargets(
  relations: readonly MapRelationV2[],
  reviewAdvisoryRelations: boolean,
  isBlocking: (r: MapRelationV2) => boolean = () => true,
): string[] {
  const out: string[] = [];
  for (const r of relations) {
    if (isBlocking(r) || reviewAdvisoryRelations) out.push(r.relationId);
  }
  return out.sort();
}

/**
 * Deterministic Map pre-review planning. `assignmentCount` is the frozen
 * round-planned count (the projector's closure gate demands exactly that many
 * committed batch assignments); the planner computes a batch target from it so
 * the result has EXACTLY `assignmentCount` batches, each within the profile's
 * target/object limits. Zero relations produce zero relation assignments.
 */
export function planMapReview(input: {
  nodes: readonly MapPositionNodeV2[];
  relations: readonly MapRelationV2[];
  profile: AuthoritativeReviewProfile;
  reviewPolicy: ReviewPolicyParameters;
  assignmentCount: number;
}): MapReviewPlanV2 {
  const { nodes, relations, profile, reviewPolicy, assignmentCount } = input;
  const count = Math.max(1, assignmentCount);
  // F1 (adversarial review): the review-domain planner batches NODES ONLY —
  // relations attach to the earliest-covered-endpoint batch and never create
  // batches. The round-planned assignmentCount is `ceil((nodes+relations)/256)`,
  // so the NODE batch target must be derived from the NODE count only
  // (`ceil(nodes/count)`); relations then ride the endpoint batches under the
  // per-batch OBJECT limit. This makes a 300-node/300-relation and a
  // 2113/2112 candidate plan to EXACTLY the frozen assignmentCount.
  const nodeTarget = Math.max(1, Math.min(profile.assignmentMaxPrimaryTargets, Math.ceil(nodes.length / count)));
  // The soft limit is the same as the batch target so the review-domain planner
  // fills batches to exactly `nodeTarget` — its produced batch count is then
  // `ceil(nodes/nodeTarget) <= count`, and the deterministic split below raises
  // it to EXACTLY `count` when count > nodes (relation-dense tiny-node rounds).
  const softLimit = Math.max(nodeTarget, Math.min(profile.assignmentMaxPrimaryTargets, reviewPolicy.assignmentSoftLimit));

  const targets = [...nodes]
    .map((n) => ({ id: n.slotId, documentOrder: n.documentOrder, parentId: n.parentSlotId }))
    .sort((a, b) => a.documentOrder - b.documentOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const planned = planReviewBatches(targets, [], { batchTarget: nodeTarget, assignmentSoftLimit: softLimit });

  // Every node covered exactly once (the review-domain planner covers all).
  const coveredNodes = new Set(planned.batches.flat());
  if (coveredNodes.size !== nodes.length) {
    throw new Error(`planMapReview: planned batches cover ${coveredNodes.size}/${nodes.length} nodes`);
  }

  // Deterministically raise the batch count to EXACTLY `count` by splitting the
  // largest batch (ties by index) at its midpoint (document-order preserving).
  const nodeBatches: string[][] = [...planned.batches];
  while (nodeBatches.length < count) {
    let largestIndex = 0;
    for (let i = 1; i < nodeBatches.length; i++) {
      if (nodeBatches[i].length > nodeBatches[largestIndex].length) largestIndex = i;
    }
    const largest = nodeBatches[largestIndex];
    if (largest.length <= 1) break; // cannot split a single-node batch further
    const mid = Math.ceil(largest.length / 2);
    nodeBatches.splice(largestIndex, 1, largest.slice(0, mid), largest.slice(mid));
  }

  // Assign every actual relation deterministically under the per-batch OBJECT
  // limit: earliest-covered-endpoint batch with capacity, else the first batch
  // with capacity; fail closed when the round cannot hold the relation graph.
  const relationIds = relations
    .map((r) => r.relationId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const batchOfNode = new Map<string, number>();
  for (let i = 0; i < nodeBatches.length; i++) {
    for (const nodeId of nodeBatches[i]) batchOfNode.set(nodeId, i);
  }
  const objectCountOf = (batchIndex: number, assigned: Readonly<Record<string, number>>): number =>
    nodeBatches[batchIndex].length + Object.values(assigned).filter((index) => index === batchIndex).length;
  const relationBatchAssignment: Record<string, number> = {};
  for (const relationId of relationIds) {
    const rel = relations.find((r) => r.relationId === relationId) as MapRelationV2;
    const endpointBatches = [rel.fromSlotId, rel.toSlotId]
      .map((endpoint) => batchOfNode.get(endpoint))
      .filter((index): index is number => index !== undefined)
      .sort((a, b) => a - b);
    let assigned = -1;
    for (const index of endpointBatches) {
      if (objectCountOf(index, relationBatchAssignment) < profile.assignmentMaxTotalObjects) {
        assigned = index;
        break;
      }
    }
    if (assigned === -1) {
      for (let i = 0; i < nodeBatches.length; i++) {
        if (objectCountOf(i, relationBatchAssignment) < profile.assignmentMaxTotalObjects) {
          assigned = i;
          break;
        }
      }
    }
    if (assigned === -1) {
      throw new Error(`planMapReview: the relation graph exceeds the round's per-batch object capacity (${profile.assignmentMaxTotalObjects})`);
    }
    relationBatchAssignment[relationId] = assigned;
  }

  const batches: MapReviewBatchV2[] = nodeBatches.map((nodeIds, batchIndex) => {
    const batchRelationIds = Object.entries(relationBatchAssignment)
      .filter(([, index]) => index === batchIndex)
      .map(([relationId]) => relationId)
      .sort();
    // Target/object limits: primary targets (nodes) and total objects.
    if (nodeIds.length > profile.assignmentMaxPrimaryTargets) {
      throw new Error(`planMapReview: batch ${batchIndex} has ${nodeIds.length} primary targets > ${profile.assignmentMaxPrimaryTargets}`);
    }
    if (nodeIds.length + batchRelationIds.length > profile.assignmentMaxTotalObjects) {
      throw new Error(`planMapReview: batch ${batchIndex} has ${nodeIds.length + batchRelationIds.length} objects > ${profile.assignmentMaxTotalObjects}`);
    }
    return { batchIndex, nodeIds, relationIds: batchRelationIds };
  });

  if (batches.length !== count) {
    throw new Error(`planMapReview: planned ${batches.length} batches != assignmentCount ${count}`);
  }

  // Every actual relation assigned to exactly one batch.
  const coveredRelations = batches.flatMap((b) => b.relationIds);
  if (new Set(coveredRelations).size !== relations.length) {
    throw new Error(`planMapReview: planned batches cover ${coveredRelations.length}/${relations.length} relations`);
  }

  const observationLevels = planLayeredObservations(
    nodes.map((n) => ({ slotId: n.slotId, parentId: n.parentSlotId, documentOrder: n.documentOrder })),
    { leafBatchSize: Math.max(1, nodeTarget) },
  ).levels;

  return {
    batches,
    nodeTargets: targets.map((t) => t.id),
    relationTargets: [...relationIds],
    observationLevels,
    relationBatchAssignment,
  };
}
