/**
 * Pure Map domain (Task 3, design §10/§11.1-§11.3/§12.1/§13; spec §7.2):
 * normalization, structural validation, position/relation/semantic digests,
 * review subgraph digests and impact closure, diff, Map node/relation
 * coverage and the acyclic Map settlement DAG (candidate validation core ->
 * candidate -> review coverage core -> settlement core -> proposed map core ->
 * activation aggregate -> MapReviewBundle -> MapSnapshot).
 *
 * Pure module: no fs/EventStore/provider/HTTP/React, no wall clock, no random.
 * All "times" are values passed in.
 */
import { canonicalJsonSha256 } from '../structured-slots/canonical-json';
import {
  SchemaError,
  type MapInvalidationPolicyIndexV2,
  type MapPositionNodeV2,
  type MapRelationV2,
  type MapReviewBundleV2,
  type MapReviewCoverageCoreV2,
  type MapReviewSettlementCoreV2,
  type MapReviewRoundStateV2,
  type MapSemanticSourceV2,
  type MapSnapshotV2,
  type NormalizedMapGraphV2,
} from './authority-types';
import type { AuthoritativeReviewProfile } from './authority-types';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';

export type { MapPositionNodeV2, MapRelationV2, NormalizedMapGraphV2 };

/* ------------------------------------------------------------------ */
/* Normalization and structural validation                             */
/* ------------------------------------------------------------------ */

export function isMapSemanticSource(value: unknown): value is MapSemanticSourceV2 {
  const o = value as Record<string, unknown> | null;
  return (
    typeof o === 'object' &&
    o !== null &&
    typeof o.templateSnapshotHash === 'string' &&
    Array.isArray(o.nodes) &&
    Array.isArray(o.relations)
  );
}

function assertPositionNodes(value: readonly MapPositionNodeV2[]): void {
  const ids = new Set<string>();
  let roots = 0;
  for (const n of value) {
    if (ids.has(n.slotId)) throw new SchemaError(`duplicate slotId '${n.slotId}' in position graph`);
    ids.add(n.slotId);
    if (n.parentSlotId === null) roots += 1;
  }
  if (roots !== 1) throw new SchemaError('position graph must have exactly one root');
  for (const n of value) {
    if (n.parentSlotId !== null && !ids.has(n.parentSlotId)) {
      throw new SchemaError(`slotId '${n.slotId}' references unknown parent '${n.parentSlotId}'`);
    }
  }
}

function assertRelations(value: readonly MapRelationV2[], nodeIds: ReadonlySet<string>): void {
  const relIds = new Set<string>();
  for (const r of value) {
    if (relIds.has(r.relationId)) throw new SchemaError(`duplicate relationId '${r.relationId}'`);
    relIds.add(r.relationId);
    if (!nodeIds.has(r.fromSlotId)) throw new SchemaError(`relation '${r.relationId}' has unknown fromSlotId '${r.fromSlotId}'`);
    if (!nodeIds.has(r.toSlotId)) throw new SchemaError(`relation '${r.relationId}' has unknown toSlotId '${r.toSlotId}'`);
    if (r.fromSlotId === r.toSlotId) throw new SchemaError(`relation '${r.relationId}' is a self loop`);
  }
  // directed cycle detection
  const out = new Map<string, string[]>();
  for (const r of value) {
    const list = out.get(r.fromSlotId) ?? [];
    list.push(r.toSlotId);
    out.set(r.fromSlotId, list);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];
  for (const start of nodeIds) {
    if (done.has(start)) continue;
    stack.push(start);
    while (stack.length > 0) {
      const cur = stack[stack.length - 1] as string;
      if (!visiting.has(cur)) visiting.add(cur);
      let advanced = false;
      for (const next of out.get(cur) ?? []) {
        if (visiting.has(next)) throw new SchemaError(`relation graph contains a directed cycle through '${next}'`);
        if (!done.has(next)) {
          stack.push(next);
          advanced = true;
          break;
        }
      }
      if (!advanced) {
        stack.pop();
        visiting.delete(cur);
        done.add(cur);
      }
    }
  }
}

/**
 * Normalize a Map graph: validate position/relation invariants and return a
 * canonical object with nodes sorted by slotId and relations sorted by
 * relationId. The SAME semantic graph always normalizes to the SAME bytes, so
 * every digest below is stable under input order (design §10.1/§10.2).
 */
export function normalizeMapGraph(
  templateSnapshotHash: string,
  nodes: readonly MapPositionNodeV2[],
  relations: readonly MapRelationV2[],
): NormalizedMapGraphV2 {
  if (templateSnapshotHash.length === 0) throw new SchemaError('templateSnapshotHash must be non-empty');
  const sortedNodes = [...nodes].sort((a, b) => (a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0));
  const sortedRelations = [...relations].sort((a, b) => (a.relationId < b.relationId ? -1 : a.relationId > b.relationId ? 1 : 0));
  assertPositionNodes(sortedNodes);
  assertRelations(sortedRelations, new Set(sortedNodes.map((n) => n.slotId)));
  return { templateSnapshotHash, nodes: sortedNodes, relations: sortedRelations };
}

/** Soft structural audit (returns problem strings; hard invariants throw in normalize). */
export function validateMapGraph(graph: NormalizedMapGraphV2): string[] {
  const errors: string[] = [];
  const ids = graph.nodes.map((n) => n.slotId);
  if (new Set(ids).size !== ids.length) errors.push('duplicate slotId');
  const roots = graph.nodes.filter((n) => n.parentSlotId === null);
  if (roots.length !== 1) errors.push('root count != 1');
  const idSet = new Set(ids);
  const perParent = new Map<string | null, MapPositionNodeV2[]>();
  for (const n of graph.nodes) {
    if (n.parentSlotId !== null && !idSet.has(n.parentSlotId)) errors.push(`parent of '${n.slotId}' unknown`);
    const bucket = perParent.get(n.parentSlotId) ?? [];
    bucket.push(n);
    perParent.set(n.parentSlotId, bucket);
  }
  for (const [parent, bucket] of perParent) {
    const orders = bucket.map((n) => n.documentOrder).sort((a, b) => a - b);
    for (let i = 1; i < orders.length; i++) {
      if (orders[i - 1] === orders[i]) errors.push(`duplicate documentOrder under parent '${String(parent)}'`);
    }
    for (let i = 1; i < orders.length; i++) {
      if (orders[i - 1] + 1 !== orders[i]) errors.push(`non-contiguous documentOrder under parent '${String(parent)}'`);
    }
    const siblings = bucket.map((n) => n.siblingOrder).sort((a, b) => a - b);
    for (let i = 1; i < siblings.length; i++) {
      if (siblings[i - 1] === siblings[i]) errors.push(`duplicate siblingOrder under parent '${String(parent)}'`);
    }
  }
  for (const r of graph.relations) {
    const expected = canonicalJsonSha256({ typeId: r.typeId, fromSlotId: r.fromSlotId, toSlotId: r.toSlotId, attributes: r.attributes });
    if (r.relationDigest !== expected) {
      errors.push(`relation '${r.relationId}' relationDigest does not match its canonical (typeId, endpoints, attributes)`);
    }
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* Digests (§10.1/§7.2): position graph, relation graph, semantics      */
/* ------------------------------------------------------------------ */

/** Position network digest: normalized nodes only (identity/type/order/edges). */
export function resolveMapPositionGraphDigest(source: MapSemanticSourceV2): string {
  const nodes = [...source.nodes]
    .sort((a, b) => (a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0))
    .map((n) => ({
      slotId: n.slotId,
      slotType: n.slotType,
      contentBearing: n.contentBearing,
      parentSlotId: n.parentSlotId,
      documentOrder: n.documentOrder,
      siblingOrder: n.siblingOrder,
      nodeSpecDigest: n.nodeSpecDigest,
    }));
  return canonicalJsonSha256({ nodes });
}

/** Relation network digest: normalized actual relations only (empty set => canonical empty digest). */
export function resolveMapRelationGraphDigest(source: MapSemanticSourceV2): string {
  const relations = [...source.relations]
    .sort((a, b) => (a.relationId < b.relationId ? -1 : a.relationId > b.relationId ? 1 : 0))
    .map((r) => ({ relationId: r.relationId, typeId: r.typeId, fromSlotId: r.fromSlotId, toSlotId: r.toSlotId, attributes: r.attributes }));
  return canonicalJsonSha256({ relations });
}

/**
 * §7.2 mapSemanticDigest: normalized position structure + declared actual
 * relations + template identity ONLY. Never includes review/provenance/
 * revision/activation — and never equals `MapSnapshotRef.digest`.
 */
export function resolveMapSemanticDigest(source: MapSemanticSourceV2): string {
  const nodes = [...source.nodes]
    .sort((a, b) => (a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0))
    .map((n) => ({
      slotId: n.slotId,
      slotType: n.slotType,
      contentBearing: n.contentBearing,
      parentSlotId: n.parentSlotId,
      documentOrder: n.documentOrder,
      siblingOrder: n.siblingOrder,
      nodeSpecDigest: n.nodeSpecDigest,
    }));
  const relations = [...source.relations]
    .sort((a, b) => (a.relationId < b.relationId ? -1 : a.relationId > b.relationId ? 1 : 0))
    .map((r) => ({ relationId: r.relationId, typeId: r.typeId, fromSlotId: r.fromSlotId, toSlotId: r.toSlotId, attributes: r.attributes }));
  return canonicalJsonSha256({ templateSnapshotHash: source.templateSnapshotHash, nodes, relations });
}

/* ------------------------------------------------------------------ */
/* §10.4 review subgraph digest and impact closure                     */
/* ------------------------------------------------------------------ */

function immediatePositionNeighbors(graph: NormalizedMapGraphV2, slotId: string): string[] {
  const byOrder = new Map<number, MapPositionNodeV2>();
  for (const n of graph.nodes) byOrder.set(n.documentOrder, n);
  const node = graph.nodes.find((n) => n.slotId === slotId);
  if (!node) return [];
  const out: string[] = [];
  const prev = byOrder.get(node.documentOrder - 1);
  const next = byOrder.get(node.documentOrder + 1);
  if (prev && prev.parentSlotId === node.parentSlotId) out.push(prev.slotId);
  if (next && next.parentSlotId === node.parentSlotId) out.push(next.slotId);
  return out;
}

function relationsOf(graph: NormalizedMapGraphV2, slotId: string): MapRelationV2[] {
  return graph.relations.filter((r) => r.fromSlotId === slotId || r.toSlotId === slotId);
}

/**
 * Finite impact closure of a slot under the relation invalidation policies
 * (design §10.3/§10.4): starting from position-adjacent and relation-connected
 * nodes, follow each relation type's declared direction up to `maxHops`, and
 * fail closed when the closure would exceed `maxClosureNodes` or a hop bound.
 */
export function resolveImpactClosure(
  graph: NormalizedMapGraphV2,
  seedSlotId: string,
  policies: MapInvalidationPolicyIndexV2,
  maxHops: number,
  maxClosureNodes: number,
): string[] {
  if (!graph.nodes.some((n) => n.slotId === seedSlotId)) {
    throw new SchemaError(`impact closure seed '${seedSlotId}' is not a node of the graph`);
  }
  const closure = new Set<string>([seedSlotId]);
  const queue: Array<{ slotId: string; hops: number }> = [{ slotId: seedSlotId, hops: 0 }];
  while (queue.length > 0) {
    const { slotId, hops } = queue.shift() as { slotId: string; hops: number };
    for (const rel of relationsOf(graph, slotId)) {
      const policy = policies[rel.typeId];
      const effectiveHops = policy ? Math.min(policy.maxHops, maxHops) : maxHops;
      if (hops >= effectiveHops) continue;
      const downstream = rel.toSlotId === slotId ? rel.fromSlotId : rel.toSlotId;
      const upstream = rel.toSlotId === slotId ? rel.toSlotId : rel.fromSlotId;
      const candidates: string[] = [];
      if (!policy || policy.direction === 'downstream' || policy.direction === 'both') candidates.push(downstream);
      if (policy && (policy.direction === 'upstream' || policy.direction === 'both')) candidates.push(upstream);
      for (const candidate of candidates) {
        if (candidate === slotId) continue;
        if (!closure.has(candidate)) {
          closure.add(candidate);
          if (closure.size > maxClosureNodes) {
            throw new SchemaError(`impact closure exceeds maxClosureNodes=${maxClosureNodes}`);
          }
          queue.push({ slotId: candidate, hops: hops + 1 });
        }
      }
    }
  }
  return [...closure].sort();
}

/**
 * §10.4 reviewSubgraphDigest(slotId): normalized node spec + parent path,
 * document order and immediate neighbors, connected relation instances and
 * their other endpoints' specs, and the finite impact closure. It never
 * includes slot content.
 */
export function resolveReviewSubgraphDigest(
  graph: NormalizedMapGraphV2,
  slotId: string,
  policies: MapInvalidationPolicyIndexV2,
  maxHops = 3,
  maxClosureNodes = 8192,
): string {
  const node = graph.nodes.find((n) => n.slotId === slotId);
  if (!node) throw new SchemaError(`subgraph digest for unknown slot '${slotId}'`);
  const byId = new Map(graph.nodes.map((n) => [n.slotId, n]));
  const parentPath: string[] = [];
  let cur: MapPositionNodeV2 | undefined = node;
  while (cur && cur.parentSlotId !== null) {
    parentPath.unshift(cur.parentSlotId as string);
    cur = byId.get(cur.parentSlotId as string);
  }
  const relations = relationsOf(graph, slotId)
    .sort((a, b) => (a.relationId < b.relationId ? -1 : 1))
    .map((r) => {
      const otherId = r.fromSlotId === slotId ? r.toSlotId : r.fromSlotId;
      const other = byId.get(otherId);
      return {
        relationId: r.relationId,
        relationDigest: r.relationDigest,
        otherEndpoint: {
          slotId: otherId,
          nodeSpecDigest: other ? other.nodeSpecDigest : null,
        },
      };
    });
  const closure = resolveImpactClosure(graph, slotId, policies, maxHops, maxClosureNodes)
    .filter((id) => id !== slotId)
    .map((id) => ({ slotId: id, nodeSpecDigest: byId.get(id)?.nodeSpecDigest ?? null }));
  return canonicalJsonSha256({
    slotId,
    nodeSpecDigest: node.nodeSpecDigest,
    parentPath,
    documentOrder: node.documentOrder,
    siblingOrder: node.siblingOrder,
    positionNeighbors: immediatePositionNeighbors(graph, slotId),
    relations,
    impactClosure: closure,
  });
}

/* ------------------------------------------------------------------ */
/* §15.2 normalized Map diff                                           */
/* ------------------------------------------------------------------ */

export interface MapDiffV2 {
  addedNodeIds: string[];
  removedNodeIds: string[];
  changedNodeIds: string[];
  addedRelationIds: string[];
  removedRelationIds: string[];
  changedRelationIds: string[];
  /** Nodes whose review bindings must be considered stale under §15.2. */
  staleNodeIds: string[];
  /** Relations whose review bindings must be considered stale under §15.2. */
  staleRelationIds: string[];
}

export function diffNormalizedMaps(prev: NormalizedMapGraphV2, next: NormalizedMapGraphV2): MapDiffV2 {
  const prevNodes = new Map(prev.nodes.map((n) => [n.slotId, n]));
  const nextNodes = new Map(next.nodes.map((n) => [n.slotId, n]));
  const prevRels = new Map(prev.relations.map((r) => [r.relationId, r]));
  const nextRels = new Map(next.relations.map((r) => [r.relationId, r]));

  const addedNodeIds: string[] = [];
  const removedNodeIds: string[] = [];
  const changedNodeIds: string[] = [];
  for (const id of nextNodes.keys()) if (!prevNodes.has(id)) addedNodeIds.push(id);
  for (const id of prevNodes.keys()) if (!nextNodes.has(id)) removedNodeIds.push(id);
  for (const [id, n] of prevNodes) {
    const m = nextNodes.get(id);
    if (!m) continue;
    const sameSpec = n.nodeSpecDigest === m.nodeSpecDigest && n.slotType === m.slotType && n.contentBearing === m.contentBearing;
    const samePos = n.parentSlotId === m.parentSlotId && n.documentOrder === m.documentOrder && n.siblingOrder === m.siblingOrder;
    if (sameSpec && samePos) continue;
    changedNodeIds.push(id);
  }

  const addedRelationIds: string[] = [];
  const removedRelationIds: string[] = [];
  const changedRelationIds: string[] = [];
  for (const id of nextRels.keys()) if (!prevRels.has(id)) addedRelationIds.push(id);
  for (const id of prevRels.keys()) if (!nextRels.has(id)) removedRelationIds.push(id);
  for (const [id, r] of prevRels) {
    const s = nextRels.get(id);
    if (!s) continue;
    if (r.relationDigest !== s.relationDigest || r.typeId !== s.typeId || r.fromSlotId !== s.fromSlotId || r.toSlotId !== s.toSlotId) {
      changedRelationIds.push(id);
    }
  }

  const staleNodeIds = new Set<string>([...addedNodeIds, ...removedNodeIds, ...changedNodeIds]);
  const staleRelationIds = new Set<string>([...addedRelationIds, ...removedRelationIds, ...changedRelationIds]);
  // position neighbors of structural changes are also affected (design §15.2)
  for (const [id, n] of prevNodes) {
    if (!staleNodeIds.has(id)) {
      const m = nextNodes.get(id);
      if (m && m.documentOrder !== n.documentOrder) staleNodeIds.add(id);
    }
  }
  return {
    addedNodeIds,
    removedNodeIds,
    changedNodeIds,
    addedRelationIds,
    removedRelationIds,
    changedRelationIds,
    staleNodeIds: [...staleNodeIds].sort(),
    staleRelationIds: [...staleRelationIds].sort(),
  };
}

/* ------------------------------------------------------------------ */
/* Map review round lifecycle + coverage (§11.3/§12.1)                 */
/* ------------------------------------------------------------------ */

const MAP_ROUND_ORDER: readonly MapReviewRoundStateV2[] = [
  'planned',
  'reviewing_batches',
  'whole_map_observation',
  'completed',
  'settled',
];

export function assertMapReviewRoundTransition(from: MapReviewRoundStateV2, to: MapReviewRoundStateV2): void {
  const i = MAP_ROUND_ORDER.indexOf(from);
  const j = MAP_ROUND_ORDER.indexOf(to);
  if (i === -1 || j !== i + 1) {
    throw new SchemaError(`illegal MapReviewRound transition '${from}' -> '${to}' (must advance one step)`);
  }
}

/** Every candidate node and actual relation joins the pre-review assignment universe (§12.1). */
export function mapReviewTargetsOf(graph: NormalizedMapGraphV2): { nodeIds: string[]; relationIds: string[] } {
  return {
    nodeIds: graph.nodes.map((n) => n.slotId).sort(),
    relationIds: graph.relations.map((r) => r.relationId).sort(),
  };
}

/* ------------------------------------------------------------------ */
/* Acyclic Map settlement DAG constructors (§10.1/§11.3)               */
/* ------------------------------------------------------------------ */

export function computeMapCandidateValidationCore(input: {
  candidateId: string;
  baseMapId: string | null;
  positionGraphDigest: string;
  relationGraphDigest: string;
  templateSnapshotHash: string;
  nodes: readonly MapPositionNodeV2[];
  relations: readonly MapRelationV2[];
  candidateProvenanceWithoutValidation: Record<string, unknown>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input, coreDigest: '' };
  out.coreDigest = canonicalJsonSha256({ ...input });
  return out;
}

export function computeMapCandidateSnapshot(input: {
  candidateId: string;
  baseMapId: string | null;
  validationCoreRef: BlobRefV2;
  candidateValidationAggregateRef: BlobRefV2;
  candidateWarningCustodyRootRef: BlobRefV2;
  createdAt: string;
}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input, candidateDigest: '' };
  out.candidateDigest = canonicalJsonSha256({ ...input });
  return out;
}

export function computeProposedMapCore(input: {
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
}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input, coreDigest: '' };
  out.coreDigest = canonicalJsonSha256({ ...input });
  return out;
}

export function assembleMapSnapshot(input: {
  scaffoldId?: string;
  mapId?: string;
  supersedesMapId?: string | null;
  sourceCandidateId: string;
  proposedMapCoreRef: BlobRefV2;
  mapReviewBundleRef: BlobRefV2;
  mapRevision?: number;
  mapSemanticDigest?: string;
  positionGraphDigest?: string;
  relationGraphDigest?: string;
  templateSnapshotHash?: string;
  nodes?: readonly MapPositionNodeV2[];
  relations?: readonly MapRelationV2[];
  activatedAt?: string;
}): MapSnapshotV2 {
  return {
    scaffoldId: input.scaffoldId ?? 'scaffold',
    mapId: input.mapId ?? 'map-1',
    supersedesMapId: input.supersedesMapId ?? null,
    sourceCandidateId: input.sourceCandidateId,
    proposedMapCoreRef: input.proposedMapCoreRef,
    mapReviewBundleRef: input.mapReviewBundleRef,
    mapRevision: input.mapRevision ?? 1,
    mapSemanticDigest: input.mapSemanticDigest ?? 'semantic',
    positionGraphDigest: input.positionGraphDigest ?? 'position',
    relationGraphDigest: input.relationGraphDigest ?? 'relation',
    templateSnapshotHash: input.templateSnapshotHash ?? 'snapshot',
    nodes: input.nodes ?? [],
    relations: input.relations ?? [],
    activatedAt: input.activatedAt ?? '2026-08-14T09:00:00.000Z',
  };
}

export function computeMapReviewCoverageCore(input: {
  mapReviewRoundId: string;
  candidateRef: BlobRefV2;
  contentRevisionManifestRef: BlobRefV2 | null;
  contentRootDigest: string | null;
  reviewPolicyDigest: string;
  coverageLedgerRootRefs: readonly BlobRefV2[];
  wholeMapObservationRootRefs: readonly BlobRefV2[];
  findingStageRootRef: BlobRefV2;
}): MapReviewCoverageCoreV2 {
  const out: MapReviewCoverageCoreV2 = { ...input, coreDigest: '' };
  out.coreDigest = canonicalJsonSha256({ ...input });
  return out;
}

export function computeMapReviewSettlementCore(input: {
  coverageCoreRef: BlobRefV2;
  mapReviewSettlementValidatorAggregateRef: BlobRefV2;
}): MapReviewSettlementCoreV2 {
  const out: MapReviewSettlementCoreV2 = { ...input, coreDigest: '' };
  out.coreDigest = canonicalJsonSha256({ ...input });
  return out;
}

export function assembleMapReviewBundle(input: {
  settlementCoreRef: BlobRefV2;
  proposedMapCoreRef: BlobRefV2;
  mapActivationValidatorAggregateRef: BlobRefV2;
  mapWarningCustodyRootRef: BlobRefV2;
}): MapReviewBundleV2 {
  const out: MapReviewBundleV2 = { ...input, bundleDigest: '' };
  out.bundleDigest = canonicalJsonSha256({ ...input });
  return out;
}

/* ------------------------------------------------------------------ */
/* §11.3 map_approved eligibility (six conditions)                     */
/* ------------------------------------------------------------------ */

export interface MapApprovalInputV2 {
  candidateRef: BlobRefV2;
  contentRevisionManifestRef: BlobRefV2 | null;
  reviewPolicyDigest: string;
  nodeVerdicts: Readonly<Record<string, 'pass' | 'reject' | 'missing'>>;
  relationVerdicts: Readonly<Record<string, 'pass' | 'reject' | 'missing'>>;
  wholeMapObservationComplete: boolean;
  blockingMapOrMixedFindingStagesVerified: boolean;
  activationAggregateOutcome: 'clear' | 'blocking_invalid' | 'infrastructure_failure';
}

/**
 * Whether the system may derive `map_approved = true` for the candidate: all
 * nodes and actual relations carry current passes, layered observation is
 * complete, the round's blocking map/mixed Findings are stage-verified, the
 * candidate/manifest/policy bindings are unchanged, and the activation
 * aggregate is clear (advisory receipts allowed).
 */
export function evaluateMapApproval(input: MapApprovalInputV2): { approved: boolean; unmet: string[] } {
  const unmet: string[] = [];
  for (const [slotId, verdict] of Object.entries(input.nodeVerdicts)) {
    if (verdict !== 'pass') unmet.push(`node '${slotId}' lacks a current pass`);
  }
  for (const [relationId, verdict] of Object.entries(input.relationVerdicts)) {
    if (verdict !== 'pass') unmet.push(`relation '${relationId}' lacks a current pass`);
  }
  if (!input.wholeMapObservationComplete) unmet.push('layered whole-map observation is not complete');
  if (!input.blockingMapOrMixedFindingStagesVerified) unmet.push('blocking map/mixed Finding map stages are not verified');
  if (input.activationAggregateOutcome !== 'clear') unmet.push(`activation aggregate outcome is '${input.activationAggregateOutcome}'`);
  return { approved: unmet.length === 0, unmet };
}

/** Staleness family for Map review round baselines (design §21; spec §14.3). */
export function assertMapReviewBaselineCurrent(input: {
  candidateRef: BlobRefV2;
  roundCandidateRef: BlobRefV2;
  manifestRef: BlobRefV2 | null;
  roundManifestRef: BlobRefV2 | null;
  policyDigest: string;
  roundPolicyDigest: string;
}): void {
  if (input.candidateRef.digest !== input.roundCandidateRef.digest || input.candidateRef.kind !== input.roundCandidateRef.kind) {
    throw new SchemaError(`MAP_CANDIDATE_BASE_STALE: candidate baseline moved during the round`);
  }
  if ((input.manifestRef?.digest ?? null) !== (input.roundManifestRef?.digest ?? null)) {
    throw new SchemaError(`AUTHORITY_BASE_STALE: content manifest baseline moved during the round`);
  }
  if (input.policyDigest !== input.roundPolicyDigest) {
    throw new SchemaError(`AUTHORITY_BASE_STALE: review policy digest moved during the round`);
  }
}

/** Map-side staleness guard for grants/WorkItems on the NEW map only (spec §10.3.1 codes). */
export function assertCurrentMapRef(expected: BlobRefV2, actual: BlobRefV2): void {
  if (expected.kind !== 'map_snapshot' || actual.kind !== 'map_snapshot' || expected.digest !== actual.digest) {
    throw new SchemaError(`MAP_BASE_STALE: active Map is no longer the expected revision`);
  }
}

export { SchemaError };

/** Bound consumed by the impact-closure rule when a profile is available. */
export function impactCapsOf(profile: AuthoritativeReviewProfile): { maxHops: number; maxClosureNodes: number } {
  return { maxHops: profile.maxRelationHops, maxClosureNodes: profile.maxClosureNodes };
}