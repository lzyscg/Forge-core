/**
 * Pure Review domain (Task 3, design §11.4/§11.6/§11.7/§11.10/§12.3/§12.4/
 * §12.6/§15.4/§16.1; spec §7.4): ReviewFact/ReviewAdoptionRecord legality
 * (whole-observation facts are never adopted), assignment/observation closure,
 * coverage settlement with the six §16.1 conditions (zero relations satisfy
 * naturally), deterministic §12.3 batch planning and §12.6 layered
 * observations.
 *
 * Pure module: no fs/EventStore/provider/HTTP/React, no wall clock, no random.
 */
import { canonicalJsonSha256 } from '../structured-slots/canonical-json';
import {
  SchemaError,
  type ContentSlotCoverageFactV2,
  type ReviewAdoptionRecordV2,
  type ReviewFactV2,
  type ReviewRoundStateV2,
} from './authority-types';

/* ------------------------------------------------------------------ */
/* §11.4/§7.4 facts and adoption                                       */
/* ------------------------------------------------------------------ */

/** Only batch facts are adoption-eligible; whole-observation facts never are. */
export function canFactBeAdopted(fact: Pick<ReviewFactV2, 'factOrigin' | 'adoptionEligible'>): boolean {
  return fact.factOrigin.kind === 'batch' && fact.adoptionEligible === true && fact.factOrigin.adoptionEligible === true;
}

/**
 * System-created adoption for ONE historical batch fact into the current
 * round. Whole-observation facts (or `adoptionEligible != true`) are hard
 * rejected — identical local digests never justify inheriting them.
 */
export function adoptHistoricalFact(
  fact: ReviewFactV2,
  currentRoundId: string,
  currentContextStableId: string,
): ReviewAdoptionRecordV2 {
  if (fact.factOrigin.kind === 'whole_observation') {
    throw new SchemaError('whole-observation fact is never adoption-eligible');
  }
  if (fact.adoptionEligible !== true || fact.factOrigin.adoptionEligible !== true) {
    throw new SchemaError('adoption requires fact.adoptionEligible === true (batch origin; only batch facts are adoption-eligible)');
  }
  const roundKind: 'map' | 'content' =
    fact.targetKind === 'map_node' || fact.targetKind === 'map_relation' ? 'map' : 'content';
  return {
    adoptionId: `adoption:${currentRoundId}:${fact.factId}`,
    roundKind,
    roundId: currentRoundId,
    candidateId: roundKind === 'map' ? currentContextStableId : null,
    mapId: roundKind === 'content' ? currentContextStableId : null,
    factId: fact.factId,
    targetStableId: fact.targetStableId,
    expectedLocalSubjectDigest: fact.localSubjectDigest,
    expectedLocalContextDigest: fact.localContextDigest,
    reviewPolicyDigest: fact.reviewPolicyDigest,
    adoptedBy: 'system',
  };
}

/** Adoption is legal only when subject/context/policy all match the CURRENT baseline. */
export function validateAdoptionRecordContext(
  record: Pick<
    ReviewAdoptionRecordV2,
    'expectedLocalSubjectDigest' | 'expectedLocalContextDigest' | 'reviewPolicyDigest'
  >,
  current: { subjectDigest: string; contextDigest: string; policyDigest: string },
): void {
  if (
    record.expectedLocalSubjectDigest !== current.subjectDigest ||
    record.expectedLocalContextDigest !== current.contextDigest ||
    record.reviewPolicyDigest !== current.policyDigest
  ) {
    throw new SchemaError('adoption cannot inherit: subject/context/policy digest do not match the current baseline');
  }
}

/* ------------------------------------------------------------------ */
/* Round lifecycle (§11.10)                                            */
/* ------------------------------------------------------------------ */

const ROUND_ORDER: readonly ReviewRoundStateV2[] = [
  'planned',
  'reviewing_batches',
  'whole_tree_observation',
  'completed',
  'settled',
];

export function assertReviewRoundTransition(from: ReviewRoundStateV2, to: ReviewRoundStateV2): void {
  const i = ROUND_ORDER.indexOf(from);
  const j = ROUND_ORDER.indexOf(to);
  if (i === -1 || j !== i + 1) {
    throw new SchemaError(`illegal ReviewRound transition '${from}' -> '${to}' (must advance one step)`);
  }
}

/** §11.10: every coverage target is either assigned this round or inherited via valid refs. */
export function assertRoundClosureComplete(input: {
  coverageTargetIds: readonly string[];
  assignmentTargetIds: readonly string[];
  inheritedRecordRefs: readonly unknown[];
}): void {
  const assigned = new Set(input.assignmentTargetIds);
  for (const id of input.coverageTargetIds) {
    if (!assigned.has(id) && input.inheritedRecordRefs.length === 0) {
      throw new SchemaError(`round target '${id}' is neither assigned nor covered by inherited records`);
    }
  }
}

/** §12.4: current committed facts and adopted historical facts are disjoint coverage sources. */
export function assertCoverageSourcesDisjoint(
  committedTargets: ReadonlySet<string>,
  adoptedTargets: ReadonlySet<string>,
): void {
  for (const id of committedTargets) {
    if (adoptedTargets.has(id)) {
      throw new SchemaError(`target '${id}' is both newly committed and adopted — coverage sources must be disjoint`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* §16.1 content round settlement                                      */
/* ------------------------------------------------------------------ */

export interface ContentRoundSettlementInputV2 {
  reviewRoundId: string;
  coverageSlotIds: readonly string[];
  coverageRelationIds: readonly string[];
  resolvedCoreSlotFacts: readonly (ContentSlotCoverageFactV2 | { disposition: 'reviewed'; slotId: string; verdict: 'pass' | 'reject' })[];
  blockingRelationVerdicts: ReadonlyMap<string, 'satisfied' | 'violated'>;
  verificationTargets: readonly string[];
  currentVerificationRecords: ReadonlyMap<string, unknown>;
  assignmentComplete: boolean;
  wholeTreeObservationBoundToBaseline: boolean;
  findings: readonly { severity: 'blocking' | 'advisory'; status: string }[];
  reviewPolicyDigestBound: boolean;
}

export interface ContentRoundSettlementResultV2 {
  complete: boolean;
  unmet: string[];
}

/**
 * §16.1 six conditions for the round to be `completed`. Relations AMOUNT to
 * zero => the relation condition is naturally satisfied; optional-unset is
 * covered by the system absence fact; required-unset/rewrite_required must
 * never appear here (they were already routed to repair during planning).
 */
export function settleContentRoundCoverage(
  input: ContentRoundSettlementInputV2,
): ContentRoundSettlementResultV2 {
  const unmet: string[] = [];

  const factBySlot = new Map<string, unknown>();
  for (const f of input.resolvedCoreSlotFacts) {
    if ('disposition' in f && 'slotId' in f) {
      const slotId = (f as { slotId: string }).slotId;
      if (f.disposition === 'reviewed' || f.disposition === 'absent_not_applicable') {
        if (factBySlot.has(slotId)) {
          // a slot with more than one coverage fact is corrupted coverage —
          // never silently last-writer-wins.
          throw new SchemaError(`slot '${slotId}' has more than one coverage fact (corrupted ledger)`);
        }
        factBySlot.set(slotId, f);
      }
    }
  }
  for (const slotId of input.coverageSlotIds) {
    if (!factBySlot.has(slotId)) {
      unmet.push(`slot '${slotId}' lacks exactly one current coverage fact`);
      continue;
    }
    const fact = factBySlot.get(slotId) as ContentSlotCoverageFactV2 & { verdict?: 'pass' | 'reject' };
    if (fact.disposition === 'reviewed' && fact.verdict === 'reject') {
      unmet.push(`slot '${slotId}' has a current reject`);
    }
  }

  for (const relationId of input.coverageRelationIds) {
    const verdict = input.blockingRelationVerdicts.get(relationId);
    if (verdict !== 'satisfied') {
      unmet.push(`blocking relation '${relationId}' lacks a current satisfied verdict`);
    }
  }

  for (const target of input.verificationTargets) {
    if (!input.currentVerificationRecords.has(target)) {
      unmet.push(`verification target '${target}' lacks a current verification record`);
    }
  }

  if (!input.assignmentComplete) unmet.push('not every assignment is complete and conflict-free');
  if (!input.wholeTreeObservationBoundToBaseline) unmet.push('whole-tree observation is not bound to the current complete baseline');
  if (!input.reviewPolicyDigestBound) unmet.push('review policy digest is not bound');
  for (const f of input.findings) {
    if (f.severity === 'blocking' && f.status !== 'verified_closed') {
      unmet.push(`blocking finding remains non-closed`);
    }
  }
  return { complete: unmet.length === 0, unmet };
}

/** §11.3 Map pre-review settlement shares the same shape with candidate targets. */
export function settleMapReviewCoverage(input: {
  coverageNodeIds: readonly string[];
  coverageRelationIds: readonly string[];
  nodeVerdicts: ReadonlyMap<string, 'pass' | 'reject'>;
  relationVerdicts: ReadonlyMap<string, 'pass' | 'reject'>;
  wholeMapObservationBoundToBaseline: boolean;
  assignmentComplete: boolean;
  blockingFindingsNonClosed: number;
}): ContentRoundSettlementResultV2 {
  const unmet: string[] = [];
  for (const nodeId of input.coverageNodeIds) {
    if (input.nodeVerdicts.get(nodeId) !== 'pass') unmet.push(`Map node '${nodeId}' lacks a current pass`);
  }
  for (const relationId of input.coverageRelationIds) {
    if (input.relationVerdicts.get(relationId) !== 'pass') unmet.push(`Map relation '${relationId}' lacks a current pass`);
  }
  if (!input.wholeMapObservationBoundToBaseline) unmet.push('whole-map observation is not bound to the candidate baseline');
  if (!input.assignmentComplete) unmet.push('not every assignment is complete');
  if (input.blockingFindingsNonClosed > 0) unmet.push(`${input.blockingFindingsNonClosed} blocking Finding(s) remain non-closed`);
  return { complete: unmet.length === 0, unmet };
}

/* ------------------------------------------------------------------ */
/* §12.3 deterministic batch planning                                  */
/* ------------------------------------------------------------------ */

export interface BatchTargetV2 {
  id: string;
  documentOrder: number;
  parentId: string | null;
}

export interface BatchRelationV2 {
  relationId: string;
  typeId: string;
  fromId: string;
  toId: string;
  enforcement: 'blocking' | 'advisory';
}

export interface BatchPlanV2 {
  batches: string[][];
  relationBatchAssignment: Record<string, number>;
}

/**
 * §12.3 deterministic, graph-aware planning. First unassigned target (by
 * document order) seeds a batch; candidates are ordered blocking-relation
 * connected, then direct position adjacency, then advisory-relation connected,
 * then remaining document order; ties break by slotId/relationId
 * lexicographic. Each relation joins the batch of its earliest covered
 * endpoint. Zero relations degrade to purely positional batching.
 */
export function planReviewBatches(
  targets: readonly BatchTargetV2[],
  relations: readonly BatchRelationV2[],
  opts: { batchTarget: number; assignmentSoftLimit?: number },
): BatchPlanV2 {
  const batchTarget = Math.max(1, opts.batchTarget);
  const softLimit = opts.assignmentSoftLimit ?? batchTarget;
  const ordered = [...targets].sort(
    (a, b) => a.documentOrder - b.documentOrder || (a.id < b.id ? -1 : 1),
  );
  const byId = new Map(targets.map((t) => [t.id, t]));
  const relsById = new Map(relations.map((r) => [r.relationId, r]));
  const relationsByTarget = new Map<string, string[]>();
  for (const r of relations) {
    for (const endpoint of [r.fromId, r.toId]) {
      const list = relationsByTarget.get(endpoint) ?? [];
      list.push(r.relationId);
      relationsByTarget.set(endpoint, list);
    }
  }
  const positionNeighbors = new Map<string, string[]>();
  for (const t of ordered) {
    const prev = ordered.find((o) => o.id === t.id) ? ordered.filter((o) => o.documentOrder === t.documentOrder - 1 && o.parentId === t.parentId) : [];
    const next = ordered.filter((o) => o.documentOrder === t.documentOrder + 1 && o.parentId === t.parentId);
    positionNeighbors.set(t.id, [...prev, ...next].map((o) => o.id));
  }

  const unassigned = new Set(ordered.map((t) => t.id));
  const inBatch = new Map<string, number>(); // target -> batch index
  const batches: string[][] = [];
  let relationAssignment: Record<string, number> = {};

  const priorityOf = (candidateId: string, batch: readonly string[]): number => {
    const members = new Set(batch);
    const connected = relationsByTarget.get(candidateId) ?? [];
    let blocking = 0;
    let advisory = 0;
    for (const rid of connected) {
      if (!members.has(relsById.get(rid)?.fromId ?? '') && !members.has(relsById.get(rid)?.toId ?? '')) continue;
      if ((relsById.get(rid) ?? { enforcement: 'advisory' }).enforcement === 'blocking') blocking = 1;
      else advisory = 1;
    }
    if (blocking > 0) return 1;
    const neighbors = positionNeighbors.get(candidateId) ?? [];
    if (neighbors.some((n) => members.has(n))) return 2;
    if (advisory > 0) return 3;
    return 4;
  };

  while (unassigned.size > 0) {
    const seed = ordered.find((t) => unassigned.has(t.id)) as BatchTargetV2;
    const batch: string[] = [seed.id];
    inBatch.set(seed.id, batches.length);
    unassigned.delete(seed.id);
    while (batch.length < Math.max(batchTarget, softLimit)) {
      const candidates = [...unassigned]
        .map((id) => ({ id, priority: priorityOf(id, batch) }))
        .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
      const next = candidates[0];
      if (!next || next.priority > 4) break;
      if (batch.length >= batchTarget) {
        const canGrow = candidates.filter((c) => c.priority < 4).length > 0 && batch.length < softLimit;
        if (!canGrow) break;
      }
      batch.push(next.id);
      inBatch.set(next.id, batches.length);
      unassigned.delete(next.id);
    }
    // assign relations to the batch of their earliest covered endpoint
    for (const member of batch) {
      for (const rid of relationsByTarget.get(member) ?? []) {
        if (relationAssignment[rid] === undefined) relationAssignment[rid] = inBatch.get(member) as number;
      }
    }
    batches.push(batch);
  }
  // relations whose endpoints were never batched (shouldn't happen) fall into batch 0
  for (const r of relations) {
    if (relationAssignment[r.relationId] === undefined) relationAssignment[r.relationId] = 0;
  }
  return { batches, relationBatchAssignment: relationAssignment };
}

/* ------------------------------------------------------------------ */
/* §12.6 layered whole observations                                    */
/* ------------------------------------------------------------------ */

export interface ObservationNodeV2 {
  slotId: string;
  parentId: string | null;
  documentOrder: number;
}

export interface ObservationLevelV2 {
  level: number;
  observations: Array<{
    observationScopeId: string;
    parentScopeId: string | null;
    coverageSlotIds: string[];
    childObservationScopeIds: string[];
    baseDigest: string;
  }>;
}

/**
 * Deterministic layered observation plan: leaf batches follow document order
 * under their parents, every parent container gets one observation per level
 * covering its direct subtree, until the root level. The plan is a pure
 * function of the tree — recovery never depends on process state.
 */
export function planLayeredObservations(
  nodes: readonly ObservationNodeV2[],
  opts: { leafBatchSize: number },
): { levels: ObservationLevelV2[] } {
  const leafBatchSize = Math.max(1, opts.leafBatchSize);
  const parentOf = new Map<string | null, string | null>();
  for (const n of nodes) parentOf.set(n.slotId, n.parentId);
  const byParent = new Map<string | null, ObservationNodeV2[]>();
  for (const n of nodes) {
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.documentOrder - b.documentOrder || (a.slotId < b.slotId ? -1 : 1));
  }

  // One observation per level per CONTAINER; `containerId` is the tree node
  // (or null for the root context) whose subtree this observation covers;
  // `parentScopeId` is the CONTAINER of the next-coarser level.
  type Obs = { scopeId: string; parentScopeId: string | null; slotIds: string[]; containerId: string | null };

  const containerOrder = (a: string | null, b: string | null): number =>
    a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0;
  const byParentKeys = [...byParent.keys()].sort(containerOrder);
  let current: Obs[] = [];
  for (const containerId of byParentKeys) {
    const children = byParent.get(containerId) ?? [];
    const chunks: Obs[] = [];
    const mkChunk = (idx: number, slotIds: string[]): void => {
      chunks.push({
        scopeId: observationScopeId({ level: 1, parentScopeId: containerId ?? 'root', index: idx, slotIds }),
        parentScopeId: containerId,
        slotIds,
        containerId,
      });
    };
    if (children.length === 0) mkChunk(0, []);
    for (let i = 0; i < children.length; i += leafBatchSize) {
      mkChunk(i / leafBatchSize, children.slice(i, i + leafBatchSize).map((c) => c.slotId));
    }
    current.push(...chunks);
  }

  const levels: ObservationLevelV2[] = [];
  let level = 1;
  while (true) {
    levels.push({
      level,
      observations: current.map((c) => ({
        observationScopeId: c.scopeId,
        parentScopeId: c.parentScopeId,
        coverageSlotIds: c.slotIds,
        childObservationScopeIds: [],
        baseDigest: observationScopeId({ level, parentScopeId: c.parentScopeId ?? 'root', index: 0, slotIds: c.slotIds }),
      })),
    });
    // children of the level just pushed: the level-below observations whose
    // container equals this observation's container.
    if (levels.length > 1) {
      const lower = levels[levels.length - 2].observations;
      const upper = levels[levels.length - 1].observations;
      upper.forEach((o, i) => {
        const container = (current[i] as Obs).containerId;
        o.childObservationScopeIds = lower.filter((p) => p.parentScopeId === container).map((p) => p.observationScopeId);
      });
    }
    if (current.length === 1 && current[0].parentScopeId === null) break;
    // next level: one observation per container of the current level's
    // parentScope; the parent scope climbs one tree level per iteration.
    const byParentScope = new Map<string | null, Obs[]>();
    for (const c of current) {
      const list = byParentScope.get(c.parentScopeId) ?? [];
      list.push(c);
      byParentScope.set(c.parentScopeId, list);
    }
    const next: Obs[] = [];
    for (const [scope, list] of byParentScope) {
      const slotIds = [...new Set(list.flatMap((c) => c.slotIds))].sort();
      const scopeId = observationScopeId({ level: level + 1, parentScopeId: scope ?? 'root', index: 0, slotIds });
      next.push({
        scopeId,
        parentScopeId: scope === null ? null : (parentOf.get(scope) ?? null),
        slotIds,
        containerId: scope,
      });
    }
    current = next;
    level += 1;
  }
  return { levels };
}

function observationScopeId(input: { level: number; parentScopeId: string; index: number; slotIds: string[] }): string {
  return canonicalJsonSha256({ ...input });
}

/**
 * §12.6 closure gate: root receipt plus full child closures bound to the same
 * baseline. Each observation must bind the same base digest; the root level
 * must be present with every child present transitively.
 */
export function assertObservationClosureComplete(
  records: ReadonlyArray<{
    observationScopeId: string;
    parentScopeId: string | null;
    childObservationScopeIds: readonly string[];
    baseDigest: string;
  }>,
  expectedBaseDigest: string,
): string[] {
  const unmet: string[] = [];
  const byId = new Map(records.map((r) => [r.observationScopeId, r]));
  const roots = records.filter((r) => r.parentScopeId === null);
  if (roots.length !== 1) {
    unmet.push(`whole-observation closure must have exactly one root receipt, got ${roots.length}`);
    return unmet;
  }
  for (const r of records) {
    if (r.baseDigest !== expectedBaseDigest) {
      unmet.push(`observation '${r.observationScopeId}' binds a different baseline than the current round`);
    }
    for (const child of r.childObservationScopeIds) {
      if (!byId.has(child)) unmet.push(`observation '${r.observationScopeId}' references missing child '${child}'`);
    }
  }
  return unmet;
}

/* ------------------------------------------------------------------ */
/* ReviewFact identity helpers                                         */
/* ------------------------------------------------------------------ */

/** Whole-observation reject/violated facts carry adoptionEligible=false INTO the fact digest. */
export function wholeObservationFact(input: Omit<ReviewFactV2, 'factOrigin' | 'adoptionEligible'>): ReviewFactV2 {
  return {
    ...input,
    factOrigin: { kind: 'whole_observation', adoptionEligible: false },
    adoptionEligible: false,
  };
}