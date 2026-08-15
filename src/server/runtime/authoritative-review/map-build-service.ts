/**
 * Task 15 map-build service (spec §13.1, design §10.2/§17.5/§19.1/§12.1): the
 * recoverable initial Map build — spec persistence, contiguous chunk ordinals
 * against a frontier/key-ledger CAS, stable build-local keys, the finish
 * proposal, and the `map_finalize` SystemCommand handler that finalizes from
 * the EVENT-BOUND manifest/key ledger (never a directory scan), runs
 * `map_candidate_commit`, and publishes the §9.2 atomic envelope.
 *
 * NORMATIVE CORE:
 * - chunks commit in contiguous ordinal order (1..n) against the parent
 *   frontier digest and the build-local key ledger; relations may reference
 *   previously committed keys or any key declared in the same chunk; parents
 *   must reference previously committed keys or keys declared EARLIER in the
 *   same chunk (the parser's rule);
 * - build keys are `buildNodeKey`/`buildRelationKey` scoped to ONE `mapBuildId`
 *   (agents never pick official slotId/relationId); duplicate/missing/
 *   tombstoned keys are rejected; `status: tombstone` ledger entries are
 *   abandoned history a later chunk may never reference;
 * - byte/slot/depth/children/relation limits come from the profile (chunk blob
 *   bytes, maxSlots, maxRelationTotal, maxRelationsPerSlot, chunk node/relation
 *   caps) plus two defensive platform constants (max tree depth, max children
 *   per parent — the profile does not define them, documented in the report);
 * - relation policy 'disabled' rejects any relation declaration; 'optional'
 *   and 'required' allow them; zero relations are always legal and produce the
 *   canonical empty relation digest at finalize;
 * - an Agent finish call publishes ONLY the finish proposal + ONE
 *   `system_map_finalize` WorkItem (§17.5 "只有 finish_map_build 的声明通过…
 *   校验后，系统才创建 system_map_finalize"); an Agent attempt NEVER writes
 *   `structured_map_candidate_committed` (finalizer-only publication);
 * - the finalizer traverses ONLY the event-bound chunks (the committed
 *   `structured_map_chunk_committed` events) and the key ledger reconstructed
 *   from them; it never scans `map-builds/` for a "latest" file;
 * - candidate provenance is `system_map_finalize` with a contribution manifest
 *   of the Agent chunk attempts; blocking candidate validation retains the
 *   aggregate/input/receipt, marks the old build rejected, and creates ONE
 *   successor MapBuild revision that imports the immutable chunk blobs with
 *   explicit replacement ordinals — it NEVER auto-retries the same finalizer;
 *   infrastructure failure retries WITHOUT a successor.
 *
 * PUBLICATION MODEL: every map-build event rides the `domain_publish` payload
 * family through a registered publication-intent handler, so a crashed pin
 * replays the envelope byte-identically (spec §8/design §19.1). The four
 * handlers are registered on the module-level allowlist AND on any injected
 * registry via `registerMapBuildPublicationHandlers`.
 *
 * V1 byte-for-byte: this is a NEW module; v1 surfaces are untouched.
 */
import { canonicalJsonBytesAndSha256, canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { AuthoritativeAppendFacadeV2 } from '../../storage/authoritative-append-facade';
import type { PublicationIntentRegistry, PublicationEventEnvelopeV2, PublicationIntentResolvedRef } from '../../storage/authoritative-publication-intent-registry';
import { NotRebuildableError, PUBLICATION_INTENT_REGISTRY_V2 } from '../../storage/authoritative-publication-intent-registry';
import { parsePublicationOperationPayload } from '../../authoritative-review/object-schema-parsers-3';
import type { SystemCommandHandler } from './system-command-registry';
import { ValidatorEngine } from './validator-engine';
import type { TriggerExecutionResult, ValidatorBlobStore } from './validator-engine';
import type {
  AuthoritativeReviewProfile,
  ContributionManifestV2,
  MapBuildChunkV2,
  MapBuildKeyLedgerV2,
  MapBuildManifestV2,
  MapBuildNodeKeyDeclarationV2,
  MapBuildPublishCarriersV2,
  MapBuildRelationKeyDeclarationV2,
  MapBuildSpecV2,
  MapCandidateProvenanceV2,
  MapCandidateSnapshotV2,
  MapCandidateValidationCoreV2,
  MapPositionNodeV2,
  MapRelationV2,
  MapReviewRoundPlanCarrierV2,
  PublicationOperationPayloadV2,
  SuccessorWorkItemCarrierV2,
  SystemCommandTerminalCarrierV2,
  ValidationWarningCustodyRootV2,
} from '../../authoritative-review/authority-types';
import { refOfBlob } from '../../authoritative-review/object-registry';
import { resolveMapPositionGraphDigest, resolveMapRelationGraphDigest } from '../../authoritative-review/map-domain';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { AuthoritativeReviewProjectionV2 } from '../../storage/authoritative-review-state';
import type { ValidatorRegistrationV2 } from '../../template/structured-slot-contract-v2';
import { validateSuccessorCarrier } from './work-item-coordinator';
import { GrantService } from './grant-service';
import type { V2AttemptContext } from './attempt-coordinator';
import { attemptContinuationOperationId } from './attempt-coordinator';
import { buildAuthorityBaseSet } from './authority-base';
import type { AuthoritativeBlobKindV2 } from '../../../shared/authoritative-review-v2';
import type { WorkItemKindV2 } from '../../../shared/authoritative-review-v2';
import type { AuthoritativeReviewProfileSnapshotV1Body } from '../../structured-slots/authoritative-review-profile';

/* ------------------------------------------------------------------ */
/* Platform constants (defensive structural limits the profile lacks)  */
/* ------------------------------------------------------------------ */

/** The canonical empty-build parent frontier (matches the initial grant's declared digest). */
export const EMPTY_BUILD_FRONTIER_DIGEST = '0'.repeat(64);

/** Defensive platform cap on position-tree depth (design §22 "…目标/字节/数量上限"). */
export const MAP_BUILD_MAX_TREE_DEPTH = 128;

/** Defensive platform cap on children per parent (deterministic grouping happens above it). */
export const MAP_BUILD_MAX_CHILDREN_PER_PARENT = 4096;

export type BuildRelationPolicyV2 = 'disabled' | 'optional' | 'required';

/* ------------------------------------------------------------------ */
/* Pure build domain                                                   */
/* ------------------------------------------------------------------ */

export interface BuildChunkInputV2 {
  mapBuildId: string;
  chunkOrdinal: number;
  parentFrontierDigest: string;
  nodeDeclarations: readonly MapBuildNodeKeyDeclarationV2[];
  relationDeclarations: readonly MapBuildRelationKeyDeclarationV2[];
}

export function resolveChunkId(mapBuildId: string, chunkOrdinal: number): string {
  return `ck-${canonicalJsonSha256({ mapBuildId, chunkOrdinal }).slice(0, 24)}`;
}

export function buildChunk(input: BuildChunkInputV2): MapBuildChunkV2 {
  const chunkId = resolveChunkId(input.mapBuildId, input.chunkOrdinal);
  const body = {
    chunkId,
    mapBuildId: input.mapBuildId,
    chunkOrdinal: input.chunkOrdinal,
    parentFrontierDigest: input.parentFrontierDigest,
    nodeDeclarations: input.nodeDeclarations,
    relationDeclarations: input.relationDeclarations,
  };
  return { ...body, chunkDigest: canonicalJsonSha256(body) };
}

/** The parent frontier of a committed chunk list (CAS identity of the build prefix). */
export function resolveBuildFrontierDigest(mapBuildId: string, chunkRefs: readonly BlobRefV2[]): string {
  // The empty build's frontier is the canonical zero digest (matches the initial
  // structure-chunk grant's declared parentFrontierDigest).
  if (chunkRefs.length === 0) return EMPTY_BUILD_FRONTIER_DIGEST;
  return canonicalJsonSha256({ mapBuildId, chunkRefs });
}

/** Structural node spec digest (design §10.1 — the node's own spec, not position). */
export function nodeSpecDigestOf(slotType: string, contentBearing: boolean): string {
  return canonicalJsonSha256({ slotType, contentBearing });
}

/** Official slotId assigned at finalize (design §10.2 — never reused across builds). */
export function officialSlotIdOf(mapBuildId: string, buildNodeKey: string): string {
  return `sl-${canonicalJsonSha256({ mapBuildId, buildNodeKey }).slice(0, 32)}`;
}

/** Official relationId assigned at finalize. */
export function officialRelationIdOf(mapBuildId: string, buildRelationKey: string): string {
  return `rl-${canonicalJsonSha256({ mapBuildId, buildRelationKey }).slice(0, 32)}`;
}

/** Deterministic key ledger reconstructed from the event-bound chunks. */
export function resolveBuildKeyLedger(
  mapBuildId: string,
  revision: number,
  chunks: readonly { chunkOrdinal: number; nodeDeclarations: readonly MapBuildNodeKeyDeclarationV2[]; relationDeclarations: readonly MapBuildRelationKeyDeclarationV2[] }[],
): MapBuildKeyLedgerV2 {
  const entries: Array<{ buildKey: string; kind: 'node' | 'relation'; officialId: string | null; declaredByChunkOrdinal: number; status: 'active' | 'tombstone' }> = [];
  for (const chunk of [...chunks].sort((a, b) => a.chunkOrdinal - b.chunkOrdinal)) {
    for (const node of chunk.nodeDeclarations) {
      entries.push({ buildKey: node.buildNodeKey, kind: 'node', officialId: null, declaredByChunkOrdinal: chunk.chunkOrdinal, status: 'active' });
    }
    for (const rel of chunk.relationDeclarations) {
      entries.push({ buildKey: rel.buildRelationKey, kind: 'relation', officialId: null, declaredByChunkOrdinal: chunk.chunkOrdinal, status: 'active' });
    }
  }
  entries.sort((a, b) => (a.buildKey < b.buildKey ? -1 : a.buildKey > b.buildKey ? 1 : 0));
  const body = { mapBuildId, revision, entries };
  return { ...body, ledgerDigest: canonicalJsonSha256(body) };
}

/** Deterministic manifest of the event-bound ordered chunks (finalizer's only traversal source). */
export function resolveBuildManifest(
  mapBuildId: string,
  manifestOrdinal: number,
  chunks: readonly { chunkOrdinal: number; chunkRef: BlobRefV2 }[],
  keyLedgerRef: BlobRefV2,
): MapBuildManifestV2 {
  // The frozen manifest parser requires `orderedChunkEntries[i].chunkOrdinal === i`
  // (0-based index into the ordered list); the CHUNK blobs themselves carry the
  // 1-based build ordinals. The manifest index maps 0..n-1 onto chunks 1..n.
  const orderedChunkEntries = [...chunks]
    .sort((a, b) => a.chunkOrdinal - b.chunkOrdinal)
    .map((c, index) => ({ chunkOrdinal: index, chunkRef: c.chunkRef }));
  const body = { mapBuildId, manifestOrdinal, orderedChunkEntries, keyLedgerRef };
  return { ...body, manifestDigest: canonicalJsonSha256(body) };
}

export interface BuildChunkStateV2 {
  chunkOrdinal: number;
  chunkRef: BlobRefV2;
  chunk: MapBuildChunkV2;
}

export interface ReconstructedBuildStateV2 {
  mapBuildId: string;
  chunks: readonly BuildChunkStateV2[];
  frontierDigest: string;
  keyLedger: MapBuildKeyLedgerV2;
  nodeCount: number;
  relationCount: number;
  rootCount: number;
  nextOrdinal: number;
}

export interface BuildLimitsV2 {
  maxChunks: number;
  maxNodesPerChunk: number;
  maxRelationsPerChunk: number;
  maxSlots: number;
  maxRelationTotal: number;
  maxRelationsPerSlot: number;
  maxChunkBytes: number;
}

export function buildLimitsOf(profile: AuthoritativeReviewProfile, spec: MapBuildSpecV2): BuildLimitsV2 {
  return {
    maxChunks: spec.plannedChunkPolicy.maxChunks,
    maxNodesPerChunk: Math.min(spec.plannedChunkPolicy.maxNodesPerChunk, profile.mapChunkMaxNodes),
    maxRelationsPerChunk: Math.min(spec.plannedChunkPolicy.maxRelationsPerChunk, profile.mapChunkMaxRelations),
    maxSlots: profile.maxSlots,
    maxRelationTotal: profile.maxRelationTotal,
    maxRelationsPerSlot: profile.maxRelationsPerSlot,
    maxChunkBytes: profile.maxBytesByKind.map_build_chunk,
  };
}

export function reconstructBuildState(
  mapBuildId: string,
  revision: number,
  chunks: readonly BuildChunkStateV2[],
): ReconstructedBuildStateV2 {
  const sorted = [...chunks].sort((a, b) => a.chunkOrdinal - b.chunkOrdinal);
  const keyLedger = resolveBuildKeyLedger(
    mapBuildId,
    revision,
    sorted.map((c) => ({ chunkOrdinal: c.chunkOrdinal, nodeDeclarations: c.chunk.nodeDeclarations, relationDeclarations: c.chunk.relationDeclarations })),
  );
  const nodeCount = sorted.reduce((n, c) => n + c.chunk.nodeDeclarations.length, 0);
  const relationCount = sorted.reduce((n, c) => n + c.chunk.relationDeclarations.length, 0);
  const rootCount = sorted.reduce((n, c) => n + c.chunk.nodeDeclarations.filter((x) => x.parentBuildNodeKey === null).length, 0);
  const frontierDigest = resolveBuildFrontierDigest(mapBuildId, sorted.map((c) => c.chunkRef));
  return {
    mapBuildId,
    chunks: sorted,
    frontierDigest,
    keyLedger,
    nodeCount,
    relationCount,
    rootCount,
    nextOrdinal: sorted.length + 1,
  };
}

/** Structural tree audit over ALL accumulated node declarations (depth/children/cycles). */
export function validateTreeShape(
  allNodes: readonly MapBuildNodeKeyDeclarationV2[],
  maxDepth = MAP_BUILD_MAX_TREE_DEPTH,
  maxChildren = MAP_BUILD_MAX_CHILDREN_PER_PARENT,
): string[] {
  const errors: string[] = [];
  const byKey = new Map(allNodes.map((n) => [n.buildNodeKey, n]));
  const depth = new Map<string, number>();
  const children = new Map<string, number>();
  for (const n of allNodes) {
    let d = 0;
    let cur: MapBuildNodeKeyDeclarationV2 | null = n;
    const seen = new Set<string>();
    while (cur !== null && cur.parentBuildNodeKey !== null) {
      if (seen.has(cur.buildNodeKey)) {
        errors.push(`cycle through '${cur.buildNodeKey}'`);
        break;
      }
      seen.add(cur.buildNodeKey);
      const parent = byKey.get(cur.parentBuildNodeKey);
      if (parent === undefined) {
        errors.push(`parent '${cur.parentBuildNodeKey}' of '${cur.buildNodeKey}' is undeclared`);
        break;
      }
      d += 1;
      cur = parent;
    }
    depth.set(n.buildNodeKey, d);
    if (d > maxDepth) errors.push(`node '${n.buildNodeKey}' depth ${d} > maxDepth ${maxDepth}`);
  }
  for (const n of allNodes) {
    if (n.parentBuildNodeKey === null) continue;
    children.set(n.parentBuildNodeKey, (children.get(n.parentBuildNodeKey) ?? 0) + 1);
  }
  for (const [parent, count] of children) {
    if (count > maxChildren) errors.push(`parent '${parent}' has ${count} children > maxChildren ${maxChildren}`);
  }
  return errors;
}

export function validateChunkAppend(input: {
  mapBuildId: string;
  ordinal: number;
  expectedFrontierDigest: string;
  nodes: readonly MapBuildNodeKeyDeclarationV2[];
  relations: readonly MapBuildRelationKeyDeclarationV2[];
  prior: ReconstructedBuildStateV2;
  limits: BuildLimitsV2;
  relationPolicy: BuildRelationPolicyV2;
  chunkBytes: number;
}): string[] {
  const errors: string[] = [];
  const expectedOrdinal = input.prior.nextOrdinal;
  if (input.ordinal !== expectedOrdinal) errors.push(`chunk ordinal ${input.ordinal} != expected ${expectedOrdinal} (contiguous ordinals)`);
  if (input.expectedFrontierDigest !== input.prior.frontierDigest) errors.push(`parent frontier digest mismatch (frontier/key-ledger CAS)`);
  if (input.nodes.length === 0) errors.push('a chunk must declare at least one node');
  if (input.nodes.length > input.limits.maxNodesPerChunk) errors.push(`node count ${input.nodes.length} > maxNodesPerChunk ${input.limits.maxNodesPerChunk}`);
  if (input.relations.length > input.limits.maxRelationsPerChunk) errors.push(`relation count ${input.relations.length} > maxRelationsPerChunk ${input.limits.maxRelationsPerChunk}`);
  if (input.chunkBytes > input.limits.maxChunkBytes) errors.push(`chunk bytes ${input.chunkBytes} > maxChunkBytes ${input.limits.maxChunkBytes}`);
  if (input.prior.chunks.length + 1 > input.limits.maxChunks) errors.push('exceeds maxChunks');
  if (input.prior.nodeCount + input.nodes.length > input.limits.maxSlots) errors.push(`exceeds maxSlots ${input.limits.maxSlots}`);
  if (input.prior.relationCount + input.relations.length > input.limits.maxRelationTotal) errors.push(`exceeds maxRelationTotal ${input.limits.maxRelationTotal}`);
  if (input.relationPolicy === 'disabled' && input.relations.length > 0) errors.push('relations are disabled by the relation policy');

  const ledgerActive = new Map<string, 'node' | 'relation'>();
  const ledgerTombstone = new Set<string>();
  for (const e of input.prior.keyLedger.entries) {
    if (e.status === 'tombstone') ledgerTombstone.add(e.buildKey);
    else ledgerActive.set(e.buildKey, e.kind);
  }

  const chunkNodeKeys: string[] = [];
  const nodeKeySet = new Set<string>();
  for (const n of input.nodes) {
    if (nodeKeySet.has(n.buildNodeKey)) errors.push(`duplicate buildNodeKey '${n.buildNodeKey}' within the chunk`);
    nodeKeySet.add(n.buildNodeKey);
    chunkNodeKeys.push(n.buildNodeKey);
    if (ledgerTombstone.has(n.buildNodeKey)) errors.push(`tombstoned buildNodeKey '${n.buildNodeKey}' may not be redeclared`);
    if (ledgerActive.has(n.buildNodeKey)) errors.push(`duplicate buildNodeKey '${n.buildNodeKey}' already in the key ledger`);
  }
  for (const n of input.nodes) {
    if (n.parentBuildNodeKey === null) continue;
    if (ledgerTombstone.has(n.parentBuildNodeKey)) {
      errors.push(`parent '${n.parentBuildNodeKey}' is tombstoned and may not be referenced`);
    } else if (ledgerActive.has(n.parentBuildNodeKey)) {
      if (ledgerActive.get(n.parentBuildNodeKey) !== 'node') errors.push(`parent '${n.parentBuildNodeKey}' is not a node key`);
    } else {
      const earlier = chunkNodeKeys.slice(0, chunkNodeKeys.indexOf(n.buildNodeKey));
      if (!earlier.includes(n.parentBuildNodeKey)) {
        errors.push(`parent '${n.parentBuildNodeKey}' must be committed earlier or declared earlier in this chunk`);
      }
    }
  }

  const chunkRelKeys = new Set<string>();
  for (const r of input.relations) {
    if (chunkRelKeys.has(r.buildRelationKey)) errors.push(`duplicate buildRelationKey '${r.buildRelationKey}' within the chunk`);
    chunkRelKeys.add(r.buildRelationKey);
    if (ledgerTombstone.has(r.buildRelationKey)) errors.push(`tombstoned buildRelationKey '${r.buildRelationKey}' may not be redeclared`);
    if (ledgerActive.has(r.buildRelationKey)) errors.push(`duplicate buildRelationKey '${r.buildRelationKey}' already in the key ledger`);
  }
  const chunkAllNodeKeys = new Set(chunkNodeKeys);
  const perSlot = new Map<string, number>();
  for (const r of input.relations) {
    if (r.fromBuildNodeKey === r.toBuildNodeKey) errors.push(`relation '${r.buildRelationKey}' is a self loop`);
    for (const endpoint of [r.fromBuildNodeKey, r.toBuildNodeKey]) {
      if (ledgerTombstone.has(endpoint)) {
        errors.push(`relation '${r.buildRelationKey}' references tombstoned buildNodeKey '${endpoint}'`);
      } else if (ledgerActive.has(endpoint)) {
        // F1 (adversarial review): an endpoint must be a NODE key — a ledger
        // entry of kind 'relation' is never a legal endpoint.
        if (ledgerActive.get(endpoint) !== 'node') {
          errors.push(`relation '${r.buildRelationKey}' references buildRelationKey '${endpoint}' as an endpoint (endpoints must be nodes)`);
        }
      } else if (chunkRelKeys.has(endpoint)) {
        // F4 (adversarial review): a relation endpoint cannot reference a key
        // declared LATER in this chunk — a relation key in the same chunk is
        // never a legal endpoint (design §10.2 '本 chunk 中先声明的 key').
        errors.push(`relation '${r.buildRelationKey}' references buildRelationKey '${endpoint}' as an endpoint (endpoints must be nodes)`);
      } else if (!chunkAllNodeKeys.has(endpoint)) {
        errors.push(`relation '${r.buildRelationKey}' references undeclared buildNodeKey '${endpoint}'`);
      }
      perSlot.set(endpoint, (perSlot.get(endpoint) ?? 0) + 1);
    }
  }
  for (const [key, count] of perSlot) {
    if (count > input.limits.maxRelationsPerSlot) errors.push(`slot '${key}' exceeds maxRelationsPerSlot ${input.limits.maxRelationsPerSlot}`);
  }

  let chunkRoots = 0;
  for (const n of input.nodes) if (n.parentBuildNodeKey === null) chunkRoots += 1;
  if (input.prior.rootCount + chunkRoots > 1) errors.push('a Map build may declare at most one root (exactly one at finalize)');

  const allNodes = [
    ...input.prior.chunks.flatMap((c) => c.chunk.nodeDeclarations),
    ...input.nodes,
  ];
  errors.push(...validateTreeShape(allNodes));
  return errors;
}

/* ------------------------------------------------------------------ */
/* Candidate / contribution construction                               */
/* ------------------------------------------------------------------ */

export function candidateNodesAndRelations(
  mapBuildId: string,
  chunks: readonly { nodeDeclarations: readonly MapBuildNodeKeyDeclarationV2[]; relationDeclarations: readonly MapBuildRelationKeyDeclarationV2[] }[],
): { nodes: MapPositionNodeV2[]; relations: MapRelationV2[] } {
  const declarations: MapBuildNodeKeyDeclarationV2[] = [];
  const relDeclarations: MapBuildRelationKeyDeclarationV2[] = [];
  for (const c of chunks) {
    declarations.push(...c.nodeDeclarations);
    relDeclarations.push(...c.relationDeclarations);
  }
  const official = new Map<string, string>();
  for (const n of declarations) official.set(n.buildNodeKey, officialSlotIdOf(mapBuildId, n.buildNodeKey));
  const nodes: MapPositionNodeV2[] = declarations.map((n) => ({
    slotId: official.get(n.buildNodeKey) as string,
    slotType: n.slotType,
    contentBearing: n.contentBearing,
    parentSlotId: n.parentBuildNodeKey === null ? null : (official.get(n.parentBuildNodeKey) as string),
    documentOrder: n.documentOrder,
    siblingOrder: n.siblingOrder,
    nodeSpecDigest: nodeSpecDigestOf(n.slotType, n.contentBearing),
  }));
  const relations: MapRelationV2[] = relDeclarations.map((r) => {
    const fromSlotId = official.get(r.fromBuildNodeKey) as string;
    const toSlotId = official.get(r.toBuildNodeKey) as string;
    return {
      relationId: officialRelationIdOf(mapBuildId, r.buildRelationKey),
      typeId: r.typeId,
      fromSlotId,
      toSlotId,
      attributes: r.attributes,
      relationDigest: canonicalJsonSha256({ typeId: r.typeId, fromSlotId, toSlotId, attributes: r.attributes }),
    };
  });
  return { nodes, relations };
}

export function resolveCandidateId(mapBuildId: string, mapBuildRevision: number): string {
  return `cand-${canonicalJsonSha256({ mapBuildId, mapBuildRevision }).slice(0, 24)}`;
}

export function buildCandidateValidationCore(input: {
  candidateId: string;
  baseMapId: string | null;
  mapBuildId: string;
  mapBuildRevision: number;
  snapshotHash: string;
  producerWorkItemId: string;
  commandId: string;
  contributionManifestRef: BlobRefV2;
  chunks: readonly { nodeDeclarations: readonly MapBuildNodeKeyDeclarationV2[]; relationDeclarations: readonly MapBuildRelationKeyDeclarationV2[] }[];
}): MapCandidateValidationCoreV2 {
  const { nodes, relations } = candidateNodesAndRelations(input.mapBuildId, input.chunks);
  const templateSnapshotHash = input.snapshotHash;
  const source = { templateSnapshotHash, nodes, relations };
  const positionGraphDigest = resolveMapPositionGraphDigest(source);
  const relationGraphDigest = resolveMapRelationGraphDigest(source);
  const candidateProvenanceWithoutValidation: MapCandidateProvenanceV2 = {
    producerKind: 'system_map_finalize',
    producerWorkItemId: input.producerWorkItemId,
    commandId: input.commandId,
    mapBuildId: input.mapBuildId,
    mapBuildRevision: input.mapBuildRevision,
    contributionManifestRef: input.contributionManifestRef,
  };
  const body = {
    candidateId: input.candidateId,
    baseMapId: input.baseMapId,
    positionGraphDigest,
    relationGraphDigest,
    templateSnapshotHash,
    nodes,
    relations,
    candidateProvenanceWithoutValidation,
  };
  return { ...body, coreDigest: canonicalJsonSha256(body) };
}

export function buildContributionManifest(input: {
  mapBuildId: string;
  mapBuildRevision: number;
  chunkRefs: readonly BlobRefV2[];
  keyLedgerRef: BlobRefV2;
  agentAttemptIdentities: readonly { workItemId: string; attemptId: string }[];
}): ContributionManifestV2 {
  const body = {
    contributionManifestId: `cm-${canonicalJsonSha256({ mapBuildId: input.mapBuildId, mapBuildRevision: input.mapBuildRevision }).slice(0, 24)}`,
    producerKind: 'map_build' as const,
    planId: input.mapBuildId,
    planRevision: input.mapBuildRevision,
    orderedChunkOrBatchRefs: input.chunkRefs,
    stagingRootRef: null,
    keyLedgerRefs: [input.keyLedgerRef],
    agentAttemptIdentities: input.agentAttemptIdentities,
  };
  return { ...body, manifestDigest: canonicalJsonSha256(body) };
}

export function buildCandidateSnapshot(input: {
  candidateId: string;
  baseMapId: string | null;
  validationCoreRef: BlobRefV2;
  candidateValidationAggregateRef: BlobRefV2;
  candidateWarningCustodyRootRef: BlobRefV2;
  createdAt: string;
}): MapCandidateSnapshotV2 {
  const body = { ...input };
  return { ...body, candidateDigest: canonicalJsonSha256(body) };
}

/** Deterministic round assignment count (spec §12.3 / §13.1: all nodes + actual relations). */
export function resolveRoundAssignmentCount(nodeCount: number, relationCount: number, profile: AuthoritativeReviewProfile): number {
  const total = nodeCount + relationCount;
  return Math.max(1, Math.ceil(total / profile.assignmentMaxPrimaryTargets));
}

export function resolveMapReviewRoundId(candidateId: string, mapCycleOrdinal: number): string {
  return `round-${canonicalJsonSha256({ candidateId, mapCycleOrdinal }).slice(0, 24)}`;
}

/** One-entry map_candidate warning custody root (the clear-path candidate's custody). */
export function buildCandidateWarningCustodyRoot(input: {
  taskId: string;
  trigger: 'map_candidate_commit';
  inputRef: BlobRefV2;
  inputDigest: string;
  validatorAggregateRef: BlobRefV2;
  warningRootRef: BlobRefV2;
}): ValidationWarningCustodyRootV2 {
  const entries = [
    {
      trigger: input.trigger,
      inputRef: input.inputRef,
      inputDigest: input.inputDigest,
      executionScope: {} as { planRevisionId?: string; batchOrdinal?: number; roundId?: string; sealWorkItemId?: string },
      validatorAggregateRef: input.validatorAggregateRef,
      warningRootRef: input.warningRootRef,
    },
  ];
  const body = {
    scope: 'map_candidate' as const,
    taskId: input.taskId,
    baseRefs: [input.inputRef],
    entries,
    supersessionPolicyVersion: '1',
  };
  return { ...body, rootDigest: canonicalJsonSha256(body) };
}

/* ------------------------------------------------------------------ */
/* Publication handler registration (deterministic §9.2 rebuilds)      */
/* ------------------------------------------------------------------ */

/** In-memory validator blob store capturing every engine-produced object. */
export class MemoryValidatorBlobStore implements ValidatorBlobStore {
  readonly produced: Array<{ kind: AuthoritativeBlobKindV2; value: unknown }> = [];

  private readonly data = new Map<string, unknown>();

  put(kind: AuthoritativeBlobKindV2, value: unknown): BlobRefV2 {
    const ref = refOfBlob(kind, value);
    if (!this.data.has(ref.digest)) {
      this.data.set(ref.digest, value);
      this.produced.push({ kind, value });
    }
    return ref;
  }

  resolve(ref: BlobRefV2): unknown | null {
    return this.data.get(ref.digest) ?? null;
  }
}

function mapBuildCarrier(carriers: Partial<MapBuildPublishCarriersV2> = {}): MapBuildPublishCarriersV2 {
  return {
    mapBuildId: null,
    chunkId: null,
    chunkOrdinal: null,
    parentFrontierDigest: null,
    expectedChunkCount: null,
    expectedRootCount: null,
    candidateId: null,
    candidateDigest: null,
    baseMapId: null,
    manifestRef: null,
    contributionManifestRef: null,
    validationReceiptRef: null,
    validatorAggregateRef: null,
    round: null,
    terminal: null,
    successor: null,
    successorBuildStart: null,
    ...carriers,
  };
}

function need<T>(value: T | null | undefined, name: string): asserts value is T {
  if (value === null || value === undefined) throw new NotRebuildableError('map-build', [name]);
}

/** Registers the four map-build publication handlers on a publication-intent registry. */
export function registerMapBuildPublicationHandlers(registry: PublicationIntentRegistry): void {
  registerMapBuildCommit(registry);
  registerMapBuildFinish(registry);
  registerMapFinalizeCommit(registry);
  registerMapFinalizeRejected(registry);
}

function registerMapBuildCommit(registry: PublicationIntentRegistry): void {
  if (registry.resolve('map_build_commit', 1) !== null) return;
  registry.register({
    handlerKind: 'map_build_commit',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: ['structured_map_chunk_committed'],
    rebuildable: true,
    missingInputs: [],
    parsePayload: parseDomainPublishPayload,
    childRefsOf: (p) => (p.family === 'domain_publish' ? [...p.blobRefs] : []),
    resolveRefs: (p) => {
      const mb = p.family === 'domain_publish' ? p.mapBuild : null;
      if (p.family !== 'domain_publish' || mb === null) return [];
      const chunkRef = p.blobRefs[0];
      if (chunkRef === undefined) return [];
      return [{ key: 'chunk', ref: chunkRef }];
    },
    buildEvents: (payload, at, refs) => {
      const p = asDomain(payload);
      const mb = p.mapBuild;
      need(mb, 'mapBuild');
      const chunk = refs?.get('chunk');
      if (chunk === null || typeof chunk !== 'object') throw new NotRebuildableError('map_build_commit', ['chunk']);
      const c = chunk as Record<string, unknown>;
      need(c.mapBuildId, 'chunk.mapBuildId');
      need(c.chunkId, 'chunk.chunkId');
      need(c.chunkOrdinal, 'chunk.chunkOrdinal');
      need(c.parentFrontierDigest, 'chunk.parentFrontierDigest');
      return [
        {
          protocolVersion: 2,
          at,
          type: 'structured_map_chunk_committed',
          mapBuildId: c.mapBuildId as string,
          chunkId: c.chunkId as string,
          chunkOrdinal: c.chunkOrdinal as number,
          chunkRef: p.blobRefs[0] as BlobRefV2,
          parentFrontierDigest: c.parentFrontierDigest as string,
        },
      ];
    },
    expectedResultIdentity: (_payload, events) => sha256Of(events),
  });
}

function registerMapBuildFinish(registry: PublicationIntentRegistry): void {
  if (registry.resolve('map_build_finish', 1) !== null) return;
  registry.register({
    handlerKind: 'map_build_finish',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: ['structured_map_build_finish_proposed', 'structured_work_item_created'],
    rebuildable: true,
    missingInputs: [],
    parsePayload: parseDomainPublishPayload,
    childRefsOf: (p) => (p.family === 'domain_publish' ? [...p.blobRefs] : []),
    resolveRefs: () => [],
    buildEvents: (payload, at) => {
      const p = asDomain(payload);
      const mb = p.mapBuild;
      need(mb, 'mapBuild');
      need(mb.mapBuildId, 'mapBuildId');
      need(mb.expectedChunkCount, 'expectedChunkCount');
      need(mb.parentFrontierDigest, 'parentFrontierDigest');
      need(mb.expectedRootCount, 'expectedRootCount');
      need(mb.successor, 'successor');
      const s = mb.successor;
      need(s.workItemId, 'successor.workItemId');
      need(s.kind, 'successor.kind');
      need(s.authorityBaseRef, 'successor.authorityBaseRef');
      need(s.payloadRef, 'successor.payloadRef');
      return [
        {
          protocolVersion: 2,
          at,
          type: 'structured_map_build_finish_proposed',
          mapBuildId: mb.mapBuildId,
          expectedChunkCount: mb.expectedChunkCount as number,
          expectedFrontierDigest: mb.parentFrontierDigest as string,
          expectedRootCount: mb.expectedRootCount as number,
        },
        {
          protocolVersion: 2,
          at,
          type: 'structured_work_item_created',
          workItemId: s.workItemId,
          kind: s.kind as WorkItemKindV2,
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
      ];
    },
    expectedResultIdentity: (_payload, events) => sha256Of(events),
  });
}

function registerMapFinalizeCommit(registry: PublicationIntentRegistry): void {
  if (registry.resolve('map_finalize_commit', 1) !== null) return;
  registry.register({
    handlerKind: 'map_finalize_commit',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: [
      'structured_map_build_finalized',
      'structured_map_candidate_committed',
      'structured_map_review_round_planned',
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
      if (p.mapBuild !== null && p.mapBuild.round !== null) {
        out.push({ key: 'candidate', ref: p.mapBuild.round.candidateRef });
      }
      return out;
    },
    buildEvents: (payload, at, refs) => {
      const p = asDomain(payload);
      const mb = p.mapBuild;
      need(mb, 'mapBuild');
      need(mb.mapBuildId, 'mapBuildId');
      need(mb.manifestRef, 'manifestRef');
      need(mb.contributionManifestRef, 'contributionManifestRef');
      need(mb.candidateId, 'candidateId');
      need(mb.candidateDigest, 'candidateDigest');
      if (mb.baseMapId === undefined) throw new NotRebuildableError('map-build', ['baseMapId']);
      need(mb.round, 'round');
      need(mb.terminal, 'terminal');
      const r = mb.round;
      const t = mb.terminal;
      const candidateRef = r.candidateRef;
      const envelopes: PublicationEventEnvelopeV2[] = [
        {
          protocolVersion: 2,
          at,
          type: 'structured_map_build_finalized',
          mapBuildId: mb.mapBuildId as string,
          manifestRef: mb.manifestRef as BlobRefV2,
          contributionManifestRef: mb.contributionManifestRef as BlobRefV2,
        },
        {
          protocolVersion: 2,
          at,
          type: 'structured_map_candidate_committed',
          candidateId: mb.candidateId as string,
          candidateRef: candidateRef,
          candidateDigest: mb.candidateDigest as string,
          baseMapId: mb.baseMapId as string | null,
        },
        {
          protocolVersion: 2,
          at,
          type: 'structured_map_review_round_planned',
          mapReviewRoundId: r.mapReviewRoundId,
          mapCycleOrdinal: r.mapCycleOrdinal,
          candidateId: r.candidateId,
          candidateRef: r.candidateRef,
          contentRevisionManifestRef: r.contentRevisionManifestRef,
          reviewPolicyDigest: r.reviewPolicyDigest,
          coverageNodeCount: r.coverageNodeCount,
          coverageRelationCount: r.coverageRelationCount,
          assignmentCount: r.assignmentCount,
          consumedOverrideRef: r.consumedOverrideRef,
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

function registerMapFinalizeRejected(registry: PublicationIntentRegistry): void {
  if (registry.resolve('map_finalize_rejected', 1) !== null) return;
  registry.register({
    handlerKind: 'map_finalize_rejected',
    handlerVersion: 1,
    payloadFamily: 'domain_publish',
    expectedEventTypes: [
      // F3 (adversarial review): the successor MapBuild revision is STARTED in
      // the same envelope so its lineage projects (later successor chunks must
      // not corrupt with chunk_unknown_build).
      'structured_map_build_started',
      'structured_map_build_rejected',
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
      const mb = p.mapBuild;
      need(mb, 'mapBuild');
      need(mb.mapBuildId, 'mapBuildId');
      need(mb.validationReceiptRef, 'validationReceiptRef');
      need(mb.validatorAggregateRef, 'validatorAggregateRef');
      need(mb.successor, 'successor');
      need(mb.terminal, 'terminal');
      need(mb.successorBuildStart, 'successorBuildStart');
      const s = mb.successor;
      const t = mb.terminal;
      const start = mb.successorBuildStart;
      const envelopes: PublicationEventEnvelopeV2[] = [
        {
          protocolVersion: 2,
          at,
          type: 'structured_map_build_rejected',
          mapBuildId: mb.mapBuildId as string,
          validatorAggregateRef: mb.validatorAggregateRef as BlobRefV2,
          validationReceiptRef: mb.validationReceiptRef as BlobRefV2,
        },
        {
          // F3 (adversarial review): the successor revision is STARTED AFTER the
          // rejected event — the projector's rejected handler marks the CURRENT
          // revision, so the rejected build must still be current when the
          // rejection commits; the started event then supersedes it.
          protocolVersion: 2,
          at,
          type: 'structured_map_build_started',
          mapBuildId: start.mapBuildId,
          revision: start.revision,
          mapBuildSpecRef: start.mapBuildSpecRef,
          supersedesMapBuildId: start.supersedesMapBuildId,
          sourceValidationReceiptRef: start.sourceValidationReceiptRef,
        },
        {
          protocolVersion: 2,
          at,
          type: 'structured_work_item_created',
          workItemId: s.workItemId,
          kind: s.kind as WorkItemKindV2,
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

function asDomain(payload: { family: string }): Extract<PublicationOperationPayloadV2, { family: 'domain_publish' }> {
  if (payload.family !== 'domain_publish') {
    throw new NotRebuildableError('map-build', [`payload family '${payload.family}' is not domain_publish`]);
  }
  return payload as Extract<PublicationOperationPayloadV2, { family: 'domain_publish' }>;
}

function parseDomainPublishPayload(value: unknown): import('../../authoritative-review/authority-types').PublicationOperationPayloadV2 {
  return parsePublicationOperationPayload(value);
}

function sha256Of(events: readonly PublicationEventEnvelopeV2[]): string {
  return canonicalJsonSha256(events);
}

/* ------------------------------------------------------------------ */
/* The service                                                         */
/* ------------------------------------------------------------------ */

export interface MapBuildServiceDependencies {
  facade: Pick<AuthoritativeAppendFacadeV2, 'prepareBlob' | 'publishWithPin'>;
  grants: GrantService;
  readProjection(taskId: string): Promise<AuthoritativeReviewProjectionV2>;
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown> | unknown;
  tail(taskId: string): Promise<{ lastSequence: number; lastCommitId: string | null }>;
  readEvents(taskId: string): Promise<readonly AuthoritativeReviewEventV2[]>;
  committedOperation(taskId: string, operationId: string): Promise<readonly AuthoritativeReviewEventV2[] | null>;
  clock(): string;
  profile: AuthoritativeReviewProfile;
  profileBody: AuthoritativeReviewProfileSnapshotV1Body;
  validatorRegistry: import('./validator-registry').ValidatorRegistry;
  sourceResolver?: (handlerKey: string) => string | null;
  registrationsFor(trigger: 'map_candidate_commit'): readonly ValidatorRegistrationV2[];
  relationPolicy: BuildRelationPolicyV2;
  reviewPolicyDigest: string;
  templateSnapshotRef: BlobRefV2;
  profileSnapshotRef: BlobRefV2;
  orchestratorRoleBinding: string;
  defaultAutomaticRetries(): Promise<number>;
}

export interface AppendChunkParamsV2 {
  ordinal: number;
  expectedFrontierDigest: string;
  nodes: readonly Record<string, unknown>[];
  relations: readonly Record<string, unknown>[];
  clientOperationId: string;
}

export interface AppendChunkResultV2 {
  accepted: true;
  chunkRef: BlobRefV2;
  chunkOrdinal: number;
  frontierDigest: string;
  keyLedgerRef: BlobRefV2;
  manifestRef: BlobRefV2;
}

export interface FinishMapBuildParamsV2 {
  expectedChunkCount: number;
  expectedFrontierDigest: string;
  expectedRootCount: number;
  clientOperationId: string;
}

export interface FinishMapBuildResultV2 {
  proposed: true;
  mapBuildId: string;
  systemWorkItemId: string;
}

/** MapBuild tool-handler errors (mapped to tool results by the factory). */
export class MapBuildError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MapBuildError';
    this.code = code;
  }
}

export class MapBuildService {
  private readonly deps: MapBuildServiceDependencies;

  /** Latest projection per task (refreshed by each finalizer run; deterministic reads). */
  private readonly projectionCache = new Map<string, AuthoritativeReviewProjectionV2>();

  constructor(deps: MapBuildServiceDependencies) {
    this.deps = deps;
  }

  /* ------------------------- chunk append ------------------------- */

  /** `append_map_candidate_chunk`: grant-scoped, build-local key scope, no aggregate publication. */
  async appendChunk(ctx: V2AttemptContext, params: AppendChunkParamsV2): Promise<AppendChunkResultV2> {
    const grant = await this.deps.grants.resolveAttemptGrant(ctx);
    if (grant.spec.kind !== 'initial_structure_chunk') {
      throw new MapBuildError('WRITE_OUT_OF_SCOPE', `append_map_candidate_chunk requires an initial_structure_chunk grant`);
    }
    const spec = (await this.deps.resolver(ctx.taskId, grant.spec.mapBuildSpecRef)) as MapBuildSpecV2 | null;
    if (spec === null || typeof spec !== 'object') {
      throw new MapBuildError('GRANT_STALE', `map_build_spec '${grant.spec.mapBuildSpecRef.digest.slice(0, 12)}…' is unresolvable`);
    }
    const scope = grant.spec.structureChunkScope;
    if (params.ordinal !== scope.chunkOrdinal) {
      throw new MapBuildError('WRITE_OUT_OF_SCOPE', `chunk ordinal ${params.ordinal} != grant chunk ordinal ${scope.chunkOrdinal}`);
    }
    if (params.expectedFrontierDigest !== scope.parentFrontierDigest) {
      throw new MapBuildError('WRITE_OUT_OF_SCOPE', `expectedFrontierDigest does not match the grant's parent frontier`);
    }
    const { nodeDeclarations, relationDeclarations } = declarationsFromTool(params.nodes, params.relations);
    const chunk = buildChunk({
      mapBuildId: spec.mapBuildId,
      chunkOrdinal: params.ordinal,
      parentFrontierDigest: params.expectedFrontierDigest,
      nodeDeclarations,
      relationDeclarations,
    });
    const chunkRef = refOfBlob('map_build_chunk', chunk);
    const { bytes } = canonicalJsonBytesAndSha256(chunk);
    const operationId = chunkCommitOperationId(ctx.taskId, ctx.workItemId, ctx.attemptId, params.clientOperationId);
    // Response-loss replay: a retransmission with the same operation id returns
    // the committed chunk BEFORE any re-validation (the committed chunk now
    // advances the build state, so ordinal validation would fail). The tool
    // journal normally replays before reaching the handler; this is the
    // second-line idempotency so a crash between the commit and the journal
    // write can never double-publish.
    const committed = await this.deps.committedOperation(ctx.taskId, operationId);
    if (committed !== null) {
      const committedChunk = committed.find((e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_chunk_committed' }> => e.type === 'structured_map_chunk_committed');
      if (committedChunk !== undefined) {
        const nextState = await this.readBuildState(ctx.taskId, spec);
        return { accepted: true, chunkRef: committedChunk.chunkRef, chunkOrdinal: committedChunk.chunkOrdinal, frontierDigest: nextState.frontierDigest, keyLedgerRef: refOfBlob('map_build_key_ledger', nextState.keyLedger), manifestRef: refOfBlob('map_build_manifest', resolveBuildManifest(spec.mapBuildId, 1, nextState.chunks.map((c) => ({ chunkOrdinal: c.chunkOrdinal, chunkRef: c.chunkRef })), refOfBlob('map_build_key_ledger', nextState.keyLedger))) };
      }
    }
    const state = await this.readBuildState(ctx.taskId, spec);
    const errors = validateChunkAppend({
      mapBuildId: spec.mapBuildId,
      ordinal: params.ordinal,
      expectedFrontierDigest: params.expectedFrontierDigest,
      nodes: nodeDeclarations,
      relations: relationDeclarations,
      prior: state,
      limits: buildLimitsOf(this.deps.profile, spec),
      relationPolicy: this.deps.relationPolicy,
      chunkBytes: bytes.length,
    });
    if (errors.length > 0) {
      throw new MapBuildError('INVALID_INPUT', errors.join('; '));
    }
    const nextState = reconstructBuildState(spec.mapBuildId, spec.revision, [...state.chunks, { chunkOrdinal: chunk.chunkOrdinal, chunkRef, chunk }]);
    const keyLedgerRef = await this.deps.facade.prepareBlob(ctx.taskId, 'map_build_key_ledger', nextState.keyLedger);
    const manifestRef = await this.deps.facade.prepareBlob(
      ctx.taskId,
      'map_build_manifest',
      resolveBuildManifest(spec.mapBuildId, 1, nextState.chunks.map((c) => ({ chunkOrdinal: c.chunkOrdinal, chunkRef: c.chunkRef })), keyLedgerRef),
    );
    const durableChunkRef = await this.deps.facade.prepareBlob(ctx.taskId, 'map_build_chunk', chunk);
    const tail = await this.deps.tail(ctx.taskId);
    await this.deps.facade.publishWithPin({
      taskId: ctx.taskId,
      operationId,
      payload: {
        family: 'domain_publish',
        operationId,
        taskId: ctx.taskId,
        publishKind: 'map_build_commit',
        blobRefs: [durableChunkRef, keyLedgerRef, manifestRef],
        expectedResultIdentity: canonicalJsonSha256({ operationId, publishKind: 'map_build_commit' }),
        mapReview: null,
        contentPlan: null,
        mapBuild: mapBuildCarrier({ mapBuildId: spec.mapBuildId, chunkId: chunk.chunkId, chunkOrdinal: chunk.chunkOrdinal, parentFrontierDigest: chunk.parentFrontierDigest }),
      },
      intent: { handlerKind: 'map_build_commit', handlerVersion: 1 },
      preparedRefs: [durableChunkRef, keyLedgerRef, manifestRef],
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    return { accepted: true, chunkRef: durableChunkRef, chunkOrdinal: chunk.chunkOrdinal, frontierDigest: nextState.frontierDigest, keyLedgerRef, manifestRef };
  }

  /* ------------------------- finish proposal ---------------------- */

  /** `finish_map_build`: validates the whole build and atomically creates the finish proposal + ONE system_map_finalize WorkItem. */
  async finishMapBuild(ctx: V2AttemptContext, params: FinishMapBuildParamsV2): Promise<FinishMapBuildResultV2> {
    const grant = await this.deps.grants.resolveAttemptGrant(ctx);
    if (grant.spec.kind !== 'initial_structure_chunk') {
      throw new MapBuildError('WRITE_OUT_OF_SCOPE', `finish_map_build requires an initial_structure_chunk grant`);
    }
    const spec = (await this.deps.resolver(ctx.taskId, grant.spec.mapBuildSpecRef)) as MapBuildSpecV2 | null;
    if (spec === null || typeof spec !== 'object') {
      throw new MapBuildError('GRANT_STALE', `map_build_spec '${grant.spec.mapBuildSpecRef.digest.slice(0, 12)}…' is unresolvable`);
    }
    const operationId = finishProposalOperationId(ctx.taskId, ctx.workItemId, ctx.attemptId, params.clientOperationId);
    // Response-loss replay: a retransmission with the same operation id returns
    // the committed finish result BEFORE any double-proposal guard.
    const committed = await this.deps.committedOperation(ctx.taskId, operationId);
    if (committed !== null) {
      const systemCreated = committed.find(
        (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_work_item_created' }> =>
          e.type === 'structured_work_item_created' && e.kind === 'system_map_finalize',
      );
      if (systemCreated !== undefined) {
        return { proposed: true, mapBuildId: spec.mapBuildId, systemWorkItemId: systemCreated.workItemId };
      }
    }
    const state = await this.readBuildState(ctx.taskId, spec);
    if (params.expectedChunkCount !== state.chunks.length) {
      throw new MapBuildError('INVALID_INPUT', `expectedChunkCount ${params.expectedChunkCount} != committed chunks ${state.chunks.length}`);
    }
    if (params.expectedFrontierDigest !== state.frontierDigest) {
      throw new MapBuildError('INVALID_INPUT', `expectedFrontierDigest does not match the committed frontier`);
    }
    if (params.expectedRootCount !== state.rootCount || state.rootCount !== 1) {
      throw new MapBuildError('INVALID_INPUT', `expectedRootCount must be 1 (a Map build has exactly one root), got ${params.expectedRootCount} vs committed ${state.rootCount}`);
    }
    // F2 (adversarial review): a SECOND finish proposal with a DIFFERENT
    // clientOperationId must be rejected with ZERO writes — the projector
    // corrupts on a duplicate `structured_map_build_finish_proposed` and the
    // deterministic system_finalize workitem id would collide.
    if (await this.hasProposalForBuild(ctx.taskId, spec.mapBuildId)) {
      throw new MapBuildError('INVALID_INPUT', `build '${spec.mapBuildId}' already has a finish proposal; a second finish_map_build is illegal`);
    }
    const systemWorkItemId = systemFinalizeWorkItemId(ctx.taskId, spec.mapBuildId);
    const authorityBase = buildAuthorityBaseSet({
      taskId: ctx.taskId,
      templateSnapshotRef: this.deps.templateSnapshotRef,
      profileSnapshotRef: this.deps.profileSnapshotRef,
      refs: { planSpecRef: grant.spec.mapBuildSpecRef },
      kind: 'system_map_finalize',
    });
    const authorityBaseRef = await this.deps.facade.prepareBlob(ctx.taskId, 'authority_base_set', authorityBase);
    const maxAutomaticRetries = await this.deps.defaultAutomaticRetries();
    const tail = await this.deps.tail(ctx.taskId);
    const successor: SuccessorWorkItemCarrierV2 = {
      workItemId: systemWorkItemId,
      kind: 'system_map_finalize',
      roleBinding: null,
      agentExecutionKind: null,
      sessionKind: null,
      roundId: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      grantSpecRef: null,
      inputArtifactDeliveryId: null,
      authorityBaseRef,
      payloadRef: grant.spec.mapBuildSpecRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries,
    };
    const carryErrors = validateSuccessorCarrier(successor);
    if (carryErrors.length > 0) {
      throw new MapBuildError('INVALID_INPUT', `successor workitem carry invalid: ${carryErrors.join('; ')}`);
    }
    await this.deps.facade.publishWithPin({
      taskId: ctx.taskId,
      operationId,
      payload: {
        family: 'domain_publish',
        operationId,
        taskId: ctx.taskId,
        publishKind: 'map_build_finish',
        blobRefs: [grant.spec.mapBuildSpecRef, authorityBaseRef],
        expectedResultIdentity: canonicalJsonSha256({ operationId, publishKind: 'map_build_finish' }),
        mapReview: null,
        contentPlan: null,
        mapBuild: mapBuildCarrier({
          mapBuildId: spec.mapBuildId,
          expectedChunkCount: params.expectedChunkCount,
          parentFrontierDigest: params.expectedFrontierDigest,
          expectedRootCount: params.expectedRootCount,
          successor,
        }),
      },
      intent: { handlerKind: 'map_build_finish', handlerVersion: 1 },
      preparedRefs: [authorityBaseRef],
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    return { proposed: true, mapBuildId: spec.mapBuildId, systemWorkItemId };
  }

  /* ------------------------- finalizer ---------------------------- */

  /**
   * The `map_finalize` SystemCommand handler (replaces the Task 12
   * NOT_IMPLEMENTED double via `SystemCommandRegistry.replace`). It finalizes
   * from the EVENT-BOUND manifest/key ledger, runs `map_candidate_commit`,
   * and publishes the §9.2 atomic envelope. The operation id equals the
   * attempt-coordinator's completion operation id, so the coordinator's
   * `completeWorkItem` REPLAYS the committed batch instead of double-committing.
   */
  async executeMapFinalize(input: {
    taskId: string;
    commandId: string;
    workItemId: string;
    commandKind: 'map_finalize';
    leaseEpoch: number;
    authorityBaseRef: BlobRefV2;
    payloadRef: BlobRefV2;
  }): Promise<{ kind: 'completed'; resultRefs: readonly BlobRefV2[] } | { kind: 'retryable_failure'; failureCode: string; failureDigest: string }> {
    try {
      const spec = (await this.deps.resolver(input.taskId, input.payloadRef)) as MapBuildSpecV2 | null;
      if (spec === null || typeof spec !== 'object') {
        throw new MapBuildError('GRANT_STALE', `map_finalize payload spec is unresolvable`);
      }
      const state = await this.readBuildState(input.taskId, spec);
      const project = await this.deps.readProjection(input.taskId);
      this.projectionCache.set(input.taskId, project);
      const proposal = await this.expectedProposalMatches(project, spec.mapBuildId, state, input.taskId);
      if (proposal !== null) throw new MapBuildError('INVALID_INPUT', proposal);
      const artifacts = await this.prepareFinalizeArtifacts(input.taskId, spec, state, input);
      const { run: engineRun, store } = await this.runValidator(input, artifacts.coreRef, artifacts.core, spec, state);
      const durableRefs = await this.persistEngineOutputs(input.taskId, engineRun, store);
      const aggregate = engineRun.aggregate;

      if (aggregate.outcome === 'clear') {
        return await this.publishClearEnvelope(input, spec, state, artifacts, engineRun, durableRefs);
      }
      if (aggregate.outcome === 'blocking_invalid') {
        return await this.publishRejectedEnvelope(input, spec, state, engineRun, durableRefs);
      }
      return {
        kind: 'retryable_failure',
        failureCode: 'VALIDATOR_INFRASTRUCTURE_FAILURE',
        failureDigest: canonicalJsonSha256({ commandId: input.commandId, aggregateRef: durableRefs.aggregateRef }),
      };
    } catch (error) {
      if (error instanceof MapBuildError) {
        return { kind: 'retryable_failure', failureCode: error.code, failureDigest: canonicalJsonSha256({ commandId: input.commandId, code: error.code }) };
      }
      return { kind: 'retryable_failure', failureCode: 'MAP_FINALIZE_FAILED', failureDigest: canonicalJsonSha256({ commandId: input.commandId, error: (error as Error).message }) };
    }
  }
  /** Prepares the key ledger, final manifest, contribution manifest and the
   * candidate validation core (the core carries the REAL contribution ref). */
  private async prepareFinalizeArtifacts(
    taskId: string,
    spec: MapBuildSpecV2,
    state: ReconstructedBuildStateV2,
    input: { workItemId: string; commandId: string },
  ): Promise<{
    keyLedgerRef: BlobRefV2;
    manifestRef: BlobRefV2;
    contributionManifestRef: BlobRefV2;
    core: MapCandidateValidationCoreV2;
    coreRef: BlobRefV2;
  }> {
    const keyLedgerRef = await this.deps.facade.prepareBlob(taskId, 'map_build_key_ledger', state.keyLedger);
    const manifestRef = await this.deps.facade.prepareBlob(
      taskId,
      'map_build_manifest',
      resolveBuildManifest(spec.mapBuildId, 1, state.chunks.map((c) => ({ chunkOrdinal: c.chunkOrdinal, chunkRef: c.chunkRef })), keyLedgerRef),
    );
    const contribution = buildContributionManifest({
      mapBuildId: spec.mapBuildId,
      mapBuildRevision: spec.revision,
      chunkRefs: state.chunks.map((c) => c.chunkRef),
      keyLedgerRef,
      agentAttemptIdentities: this.structureChunkAttemptIdentities(taskId),
    });
    const contributionManifestRef = await this.deps.facade.prepareBlob(taskId, 'contribution_manifest', contribution);
    const core = buildCandidateValidationCore({
      candidateId: resolveCandidateId(spec.mapBuildId, spec.revision),
      baseMapId: null,
      mapBuildId: spec.mapBuildId,
      mapBuildRevision: spec.revision,
      snapshotHash: spec.snapshotHash,
      producerWorkItemId: input.workItemId,
      commandId: input.commandId,
      contributionManifestRef,
      chunks: stateChunkSources(state),
    });
    const coreRef = await this.deps.facade.prepareBlob(taskId, 'map_candidate_validation_core', core);
    return { keyLedgerRef, manifestRef, contributionManifestRef, core, coreRef };
  }

  private async expectedProposalMatches(
    project: AuthoritativeReviewProjectionV2,
    mapBuildId: string,
    state: ReconstructedBuildStateV2,
    taskId: string,
  ): Promise<string | null> {
    // F3 (adversarial review): a successor plan lives under the SHARED lineage
    // of its original build (keyed by the first build's id), so the lineage is
    // found by scanning for a revision that owns this plan id.
    const lineageEntry = Object.values(project.mapBuilds).find((l) => Object.values(l.revisions).some((r) => r.planId === mapBuildId));
    if (lineageEntry === undefined) return `build '${mapBuildId}' is not the active build`;
    const head = lineageEntry.revisions[String(lineageEntry.currentRevision)];
    if (head === undefined || head.planId !== mapBuildId) return `build '${mapBuildId}' is not the current revision`;
    if (head.state !== 'active') return `build '${mapBuildId}' is '${head.state}', not active`;
    if (project.lastFinalizedBuildId === mapBuildId) return `build '${mapBuildId}' is already finalized`;
    // F5 (adversarial review): re-verify the finish proposal's DECLARED counts.
    // A chunk appended AFTER the proposal must NEVER be silently folded into the
    // finalized candidate — the proposal is the frozen build boundary.
    const events = await this.deps.readEvents(taskId);
    const proposal = events.find(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_build_finish_proposed' }> =>
        e.type === 'structured_map_build_finish_proposed' && e.mapBuildId === mapBuildId,
    );
    if (proposal === undefined) return `build '${mapBuildId}' has no finish proposal`;
    if (proposal.expectedChunkCount !== state.chunks.length) {
      return `proposal declared ${proposal.expectedChunkCount} chunks but ${state.chunks.length} are committed (a chunk was appended after the proposal)`;
    }
    if (proposal.expectedFrontierDigest !== state.frontierDigest) {
      return 'proposal frontier does not match the committed frontier (build changed after the proposal)';
    }
    if (proposal.expectedRootCount !== state.rootCount || state.rootCount !== 1) {
      return `proposal declared root count ${proposal.expectedRootCount} but ${state.rootCount} are committed`;
    }
    return null;
  }

  private async runValidator(
    input: { taskId: string; commandId: string; workItemId: string },
    coreRef: BlobRefV2,
    core: MapCandidateValidationCoreV2,
    spec: MapBuildSpecV2,
    state: ReconstructedBuildStateV2,
  ): Promise<{ run: TriggerExecutionResult; store: MemoryValidatorBlobStore }> {
    const { nodes, relations } = candidateNodesAndRelations(spec.mapBuildId, stateChunkSources(state));
    const store = new MemoryValidatorBlobStore();
    // Seed the engine's input universe: the core blob (and the envelope refs
    // the engine builds) must resolve inside the engine's own store.
    store.put('map_candidate_validation_core', core);
    const engine = new ValidatorEngine({
      registry: this.deps.validatorRegistry,
      blobs: store,
      sourceResolver: this.deps.sourceResolver,
    });
    const run = await engine.execute({
      trigger: 'map_candidate_commit',
      identity: {
        taskId: input.taskId,
        templateSnapshotHash: spec.snapshotHash,
        workItemId: input.workItemId,
        attemptId: null,
        commandId: input.commandId,
      },
      coreRef,
      selectedTargetRefs: [],
      registrations: this.deps.registrationsFor('map_candidate_commit'),
      universe: {
        slotIds: nodes.map((n) => n.slotId),
        relationIds: relations.map((r) => r.relationId),
        mapNodeIds: nodes.map((n) => n.slotId),
        artifactDigest: null,
      },
      profile: this.deps.profileBody,
    });
    return { run, store };
  }

  private async persistEngineOutputs(
    taskId: string,
    run: TriggerExecutionResult,
    store: MemoryValidatorBlobStore,
  ): Promise<{
    envelopeRef: BlobRefV2;
    aggregateRef: BlobRefV2;
    warningRootRef: BlobRefV2;
    receiptRefs: readonly BlobRefV2[];
    failureRefs: readonly BlobRefV2[];
  }> {
    // Persist EVERY object the engine produced (the aggregate → receipt →
    // intermediate-aggregate DAG stays recursively reviewable after GC).
    for (const produced of store.produced) {
      await this.deps.facade.prepareBlob(taskId, produced.kind, produced.value);
    }
    const envelopeRef = await this.deps.facade.prepareBlob(taskId, 'validator_input_envelope', run.envelope);
    const aggregateRef = await this.deps.facade.prepareBlob(taskId, 'validator_aggregate', run.aggregate);
    const warningRootRef = await this.deps.facade.prepareBlob(taskId, 'validation_warning_root', run.warningRoot);
    const receiptRefs: BlobRefV2[] = [];
    for (const receipt of run.receipts) {
      receiptRefs.push(await this.deps.facade.prepareBlob(taskId, 'validation_receipt', receipt));
    }
    const failureRefs: BlobRefV2[] = [];
    for (const failure of run.failures) {
      failureRefs.push(await this.deps.facade.prepareBlob(taskId, 'validator_failure', failure));
    }
    return { envelopeRef, aggregateRef, warningRootRef, receiptRefs, failureRefs };
  }

  private async publishClearEnvelope(
    input: { taskId: string; commandId: string; workItemId: string; commandKind: 'map_finalize'; leaseEpoch: number; authorityBaseRef: BlobRefV2 },
    spec: MapBuildSpecV2,
    state: ReconstructedBuildStateV2,
    artifacts: { keyLedgerRef: BlobRefV2; manifestRef: BlobRefV2; contributionManifestRef: BlobRefV2; core: MapCandidateValidationCoreV2; coreRef: BlobRefV2 },
    engineRun: TriggerExecutionResult,
    durableRefs: { aggregateRef: BlobRefV2; warningRootRef: BlobRefV2 },
  ): Promise<{ kind: 'completed'; resultRefs: readonly BlobRefV2[] }> {
    const { keyLedgerRef, manifestRef, contributionManifestRef, coreRef } = artifacts;
    const candidateId = resolveCandidateId(spec.mapBuildId, spec.revision);
    const custody = buildCandidateWarningCustodyRoot({
      taskId: input.taskId,
      trigger: 'map_candidate_commit',
      inputRef: engineRun.envelopeRef,
      inputDigest: engineRun.envelopeRef.digest,
      validatorAggregateRef: durableRefs.aggregateRef,
      warningRootRef: durableRefs.warningRootRef,
    });
    const custodyRef = await this.deps.facade.prepareBlob(input.taskId, 'validation_warning_custody_root', custody);
    const candidate = buildCandidateSnapshot({
      candidateId,
      baseMapId: null,
      validationCoreRef: coreRef,
      candidateValidationAggregateRef: durableRefs.aggregateRef,
      candidateWarningCustodyRootRef: custodyRef,
      createdAt: this.deps.clock(),
    });
    const candidateRef = await this.deps.facade.prepareBlob(input.taskId, 'map_candidate', candidate);
    const nodeCount = state.nodeCount;
    const relationCount = state.relationCount;
    const round: MapReviewRoundPlanCarrierV2 = {
      mapReviewRoundId: resolveMapReviewRoundId(candidateId, 1),
      mapCycleOrdinal: 1,
      candidateId,
      candidateRef,
      contentRevisionManifestRef: null,
      reviewPolicyDigest: this.deps.reviewPolicyDigest,
      coverageNodeCount: nodeCount,
      coverageRelationCount: relationCount,
      assignmentCount: resolveRoundAssignmentCount(nodeCount, relationCount, this.deps.profile),
      consumedOverrideRef: null,
    };
    const terminal: SystemCommandTerminalCarrierV2 = {
      workItemId: input.workItemId,
      commandId: input.commandId,
      commandKind: input.commandKind,
      leaseEpoch: input.leaseEpoch,
      authorityBaseRef: input.authorityBaseRef,
    };
    const operationId = attemptContinuationOperationId(input.taskId, input.workItemId, input.commandId, 'complete');
    const tail = await this.deps.tail(input.taskId);
    const resultRefs = [candidateRef, coreRef, durableRefs.aggregateRef, manifestRef, contributionManifestRef, keyLedgerRef, custodyRef];
    await this.deps.facade.publishWithPin({
      taskId: input.taskId,
      operationId,
      payload: {
        family: 'domain_publish',
        operationId,
        taskId: input.taskId,
        publishKind: 'map_finalize_commit',
        blobRefs: [manifestRef, contributionManifestRef, candidateRef, keyLedgerRef],
        expectedResultIdentity: canonicalJsonSha256({ operationId, publishKind: 'map_finalize_commit' }),
        mapReview: null,
        contentPlan: null,
        mapBuild: mapBuildCarrier({
          mapBuildId: spec.mapBuildId,
          manifestRef,
          contributionManifestRef,
          candidateId,
          candidateDigest: candidateRef.digest,
          baseMapId: null,
          round,
          terminal,
        }),
      },
      intent: { handlerKind: 'map_finalize_commit', handlerVersion: 1 },
      preparedRefs: resultRefs,
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    return { kind: 'completed', resultRefs };
  }

  private async publishRejectedEnvelope(
    input: { taskId: string; commandId: string; workItemId: string; commandKind: 'map_finalize'; leaseEpoch: number; authorityBaseRef: BlobRefV2 },
    spec: MapBuildSpecV2,
    state: ReconstructedBuildStateV2,
    engineRun: TriggerExecutionResult,
    durableRefs: { aggregateRef: BlobRefV2; receiptRefs: readonly BlobRefV2[] },
  ): Promise<{ kind: 'completed'; resultRefs: readonly BlobRefV2[] }> {
    const receiptRef = durableRefs.receiptRefs[0];
    if (receiptRef === undefined) {
      throw new MapBuildError('VALIDATOR_INFRASTRUCTURE_FAILURE', 'blocking_invalid aggregate carried no blocking receipt');
    }
    const successorBuildId = `mb-${canonicalJsonSha256({ mapBuildId: spec.mapBuildId, revision: spec.revision, label: 'successor' }).slice(0, 16)}`;
    // F3 (adversarial review): the successor revision is 2 (the projector's
    // applyPlanStarted requires the superseding revision = current + 1), and
    // `structured_map_build_started` must register the successor lineage in the
    // SAME envelope so later successor chunks project cleanly.
    const successorRevision = 2;
    const successorSpecBody = {
      mapBuildId: successorBuildId,
      revision: successorRevision,
      supersedesMapBuildId: spec.mapBuildId,
      sourceValidationReceiptRef: receiptRef,
      snapshotHash: spec.snapshotHash,
      plannedChunkPolicy: spec.plannedChunkPolicy,
    };
    const successorSpec = { ...successorSpecBody, specDigest: canonicalJsonSha256(successorSpecBody) };
    const successorSpecRef = await this.deps.facade.prepareBlob(input.taskId, 'map_build_spec', successorSpec);
    const successorState = reconstructBuildState(
      successorBuildId,
      successorRevision,
      state.chunks.map((c) => ({ chunkOrdinal: c.chunkOrdinal, chunkRef: c.chunkRef, chunk: c.chunk })),
    );
    const successorLedgerRef = await this.deps.facade.prepareBlob(input.taskId, 'map_build_key_ledger', successorState.keyLedger);
    const successorWorkItemId = successorStructureWorkItemId(input.taskId, successorBuildId);
    const authorityBase = buildAuthorityBaseSet({
      taskId: input.taskId,
      templateSnapshotRef: this.deps.templateSnapshotRef,
      profileSnapshotRef: this.deps.profileSnapshotRef,
      refs: { planSpecRef: successorSpecRef },
      kind: 'agent_assignment',
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
    });
    const authorityBaseRef = await this.deps.facade.prepareBlob(input.taskId, 'authority_base_set', authorityBase);
    const grantBody = {
      grantSpecId: `gs-${canonicalJsonSha256({ successorBuildId }).slice(0, 24)}`,
      workItemId: successorWorkItemId,
      kind: 'initial_structure_chunk' as const,
      snapshotHash: spec.snapshotHash,
      authorityBaseRef,
      mapBuildSpecRef: successorSpecRef,
      expectedFrontierDigest: successorState.frontierDigest,
      structureChunkScope: {
        // The successor's FIRST OWN chunk is per-stream ordinal 1 (the projector
        // enforces 1..n per mapBuildId event stream); the imported chunks are
        // seeded into the combined state but never re-committed under the
        // successor's id.
        chunkOrdinal: 1,
        parentFrontierDigest: successorState.frontierDigest,
        maxNodes: Math.min(spec.plannedChunkPolicy.maxNodesPerChunk, this.deps.profile.mapChunkMaxNodes),
        maxRelations: Math.min(spec.plannedChunkPolicy.maxRelationsPerChunk, this.deps.profile.mapChunkMaxRelations),
      },
    };
    const grantSpecRef = await this.deps.facade.prepareBlob(input.taskId, 'write_grant_spec', { ...grantBody, specDigest: canonicalJsonSha256(grantBody) });
    const maxAutomaticRetries = await this.deps.defaultAutomaticRetries();
    const successor: SuccessorWorkItemCarrierV2 = {
      workItemId: successorWorkItemId,
      kind: 'agent_assignment',
      roleBinding: this.deps.orchestratorRoleBinding,
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
      roundId: null,
      logicalAssignmentId: `la-${successorWorkItemId}`,
      reviewAssignmentId: null,
      grantSpecRef,
      inputArtifactDeliveryId: null,
      authorityBaseRef,
      payloadRef: successorSpecRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries,
    };
    const carryErrors = validateSuccessorCarrier(successor);
    if (carryErrors.length > 0) {
      throw new MapBuildError('INVALID_INPUT', `successor workitem carry invalid: ${carryErrors.join('; ')}`);
    }
    const terminal: SystemCommandTerminalCarrierV2 = {
      workItemId: input.workItemId,
      commandId: input.commandId,
      commandKind: input.commandKind,
      leaseEpoch: input.leaseEpoch,
      authorityBaseRef: input.authorityBaseRef,
    };
    const operationId = attemptContinuationOperationId(input.taskId, input.workItemId, input.commandId, 'complete');
    const tail = await this.deps.tail(input.taskId);
    const resultRefs = [durableRefs.aggregateRef, receiptRef, successorSpecRef, successorLedgerRef, authorityBaseRef, grantSpecRef];
    await this.deps.facade.publishWithPin({
      taskId: input.taskId,
      operationId,
      payload: {
        family: 'domain_publish',
        operationId,
        taskId: input.taskId,
        publishKind: 'map_finalize_rejected',
        blobRefs: [receiptRef, successorSpecRef, successorLedgerRef, authorityBaseRef, grantSpecRef],
        expectedResultIdentity: canonicalJsonSha256({ operationId, publishKind: 'map_finalize_rejected' }),
        mapReview: null,
        contentPlan: null,
        mapBuild: mapBuildCarrier({
          mapBuildId: spec.mapBuildId,
          validationReceiptRef: receiptRef,
          validatorAggregateRef: durableRefs.aggregateRef,
          successor,
          terminal,
          successorBuildStart: {
            mapBuildId: successorBuildId,
            revision: successorRevision,
            supersedesMapBuildId: spec.mapBuildId,
            mapBuildSpecRef: successorSpecRef,
            sourceValidationReceiptRef: receiptRef,
          },
        }),
      },
      intent: { handlerKind: 'map_finalize_rejected', handlerVersion: 1 },
      preparedRefs: resultRefs,
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    return { kind: 'completed', resultRefs };
  }

  /* ------------------------- state reconstruction ------------------ */

  private async readBuildState(taskId: string, spec: MapBuildSpecV2): Promise<ReconstructedBuildStateV2> {
    const events = await this.deps.readEvents(taskId);
    const ownChunks = await this.readChunkEvents(events, taskId, spec.mapBuildId);
    let chunks = [...ownChunks];
    let ownCount = ownChunks.length;
    // A successor build seeds the imported immutable chunks of its superseded
    // parent. The combined state renumbers ALL chunks contiguously (imported
    // first, then the successor's OWN per-stream ordinals renumbered after the
    // imported chain — "explicit replacement ordinals"), while `nextOrdinal`
    // stays the PER-STREAM next ordinal of the build's own chunk events (the
    // projector enforces 1..n per mapBuildId event stream).
    if (spec.supersedesMapBuildId !== null) {
      const parentEvents = await this.readChunkEvents(events, taskId, spec.supersedesMapBuildId);
      // import EVERY parent chunk (the successor's own stream is separate; the
      // per-stream ordinals collide, so the combined state renumbers all).
      chunks = [...parentEvents, ...ownChunks].map((c, i) => ({ ...c, chunkOrdinal: i + 1 }));
    }
    const state = reconstructBuildState(spec.mapBuildId, spec.revision, chunks);
    if (spec.supersedesMapBuildId !== null) {
      state.nextOrdinal = ownCount + 1;
    }
    return state;
  }

  /** F2 (adversarial review): true when a finish proposal already exists for the build. */
  private async hasProposalForBuild(taskId: string, mapBuildId: string): Promise<boolean> {
    const events = await this.deps.readEvents(taskId);
    return events.some(
      (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_build_finish_proposed' }> =>
        e.type === 'structured_map_build_finish_proposed' && e.mapBuildId === mapBuildId,
    );
  }

  private async readChunkEvents(
    events: readonly AuthoritativeReviewEventV2[],
    taskId: string,
    mapBuildId: string,
  ): Promise<BuildChunkStateV2[]> {
    const chunkEvents = events
      .filter(
        (e): e is Extract<AuthoritativeReviewEventV2, { type: 'structured_map_chunk_committed' }> =>
          e.type === 'structured_map_chunk_committed' && e.mapBuildId === mapBuildId,
      )
      .sort((a, b) => a.chunkOrdinal - b.chunkOrdinal);
    const chunks: BuildChunkStateV2[] = [];
    let lastOrdinal = 0;
    for (const e of chunkEvents) {
      if (e.chunkOrdinal !== lastOrdinal + 1) {
        throw new MapBuildError('INVALID_INPUT', `committed chunk ordinals are not contiguous (${e.chunkOrdinal} after ${lastOrdinal})`);
      }
      lastOrdinal = e.chunkOrdinal;
      const chunk = (await this.deps.resolver(taskId, e.chunkRef)) as MapBuildChunkV2 | null;
      if (chunk === null || typeof chunk !== 'object') {
        throw new MapBuildError('GRANT_STALE', `chunk '${e.chunkRef.digest.slice(0, 12)}…' is unresolvable`);
      }
      chunks.push({ chunkOrdinal: e.chunkOrdinal, chunkRef: e.chunkRef, chunk });
    }
    return chunks;
  }

  /** The completed structure-chunk Agent attempts of this build (contribution manifest provenance). */
  private structureChunkAttemptIdentities(taskId: string): readonly { workItemId: string; attemptId: string }[] {
    // Derived deterministically from the projection: every completed
    // structure_chunk attempt. The initial build contains only structure_chunk
    // write workitems, so the completed set is exactly the build's contributors
    // (a successor build's imported chunks were committed by the superseded
    // build's attempts — the manifest lists them as history, never as the
    // successor's own attempts; Task 16 may refine per-build attribution).
    const out: Array<{ workItemId: string; attemptId: string }> = [];
    const projection = this.projectionCache.get(taskId);
    if (projection === undefined) return out;
    for (const attempt of Object.values(projection.attempts)) {
      if (attempt.family === 'structured' && attempt.sessionKind === 'structure_chunk' && attempt.state === 'completed') {
        out.push({ workItemId: attempt.workItemId, attemptId: attempt.attemptId });
      }
    }
    return out.sort((a, b) => (a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0));
  }
}

/* ------------------------------------------------------------------ */
/* Deterministic operation / work-item ids                             */
/* ------------------------------------------------------------------ */

export function chunkCommitOperationId(taskId: string, workItemId: string, attemptId: string, clientOperationId: string): string {
  return `ck-${canonicalJsonSha256({ taskId, workItemId, attemptId, clientOperationId }).slice(0, 32)}`;
}

export function finishProposalOperationId(taskId: string, workItemId: string, attemptId: string, clientOperationId: string): string {
  return `fp-${canonicalJsonSha256({ taskId, workItemId, attemptId, clientOperationId }).slice(0, 32)}`;
}

export function systemFinalizeWorkItemId(taskId: string, mapBuildId: string): string {
  return `wi-finalize-${canonicalJsonSha256({ taskId, mapBuildId }).slice(0, 24)}`;
}

export function successorStructureWorkItemId(taskId: string, mapBuildId: string): string {
  return `wi-build-${canonicalJsonSha256({ taskId, mapBuildId }).slice(0, 24)}`;
}

function stateChunkSources(state: ReconstructedBuildStateV2): readonly { nodeDeclarations: readonly MapBuildNodeKeyDeclarationV2[]; relationDeclarations: readonly MapBuildRelationKeyDeclarationV2[] }[] {
  return state.chunks.map((c) => ({ nodeDeclarations: c.chunk.nodeDeclarations, relationDeclarations: c.chunk.relationDeclarations }));
}

function declarationsFromTool(
  nodes: readonly Record<string, unknown>[],
  relations: readonly Record<string, unknown>[],
): { nodeDeclarations: MapBuildNodeKeyDeclarationV2[]; relationDeclarations: MapBuildRelationKeyDeclarationV2[] } {
  const nodeDeclarations: MapBuildNodeKeyDeclarationV2[] = nodes.map((n) => ({
    buildNodeKey: String(n.buildNodeKey ?? ''),
    slotType: String(n.slotType ?? ''),
    parentBuildNodeKey: n.parentBuildNodeKey === null || n.parentBuildNodeKey === undefined ? null : String(n.parentBuildNodeKey),
    documentOrder: typeof n.documentOrder === 'number' ? n.documentOrder : 0,
    siblingOrder: typeof n.siblingOrder === 'number' ? n.siblingOrder : 0,
    contentBearing: n.contentBearing === true,
  }));
  const relationDeclarations: MapBuildRelationKeyDeclarationV2[] = relations.map((r) => ({
    buildRelationKey: String(r.buildRelationKey ?? ''),
    typeId: String(r.typeId ?? ''),
    fromBuildNodeKey: String(r.fromBuildNodeKey ?? ''),
    toBuildNodeKey: String(r.toBuildNodeKey ?? ''),
    attributes: (r.attributes ?? {}) as Record<string, unknown>,
  }));
  return { nodeDeclarations, relationDeclarations };
}

/* ------------------------------------------------------------------ */
/* Module-level runtime allowlist registration                         */
/* ------------------------------------------------------------------ */

/**
 * Task 15 SystemCommand handler: replaces the Task 12 `map_finalize`
 * NOT_IMPLEMENTED double via `SystemCommandRegistry.replace(...)`. The handler
 * carries NO Agent prompt/tool/question surface — it finalizes from the
 * event-bound manifest and publishes the §9.2 envelope.
 */
export function createMapFinalizeSystemCommandHandler(service: MapBuildService): SystemCommandHandler {
  return {
    commandKind: 'map_finalize',
    async execute(ctx) {
      const outcome = await service.executeMapFinalize({
        taskId: ctx.taskId,
        commandId: ctx.commandId,
        workItemId: ctx.workItemId,
        commandKind: 'map_finalize',
        leaseEpoch: ctx.leaseEpoch,
        authorityBaseRef: ctx.authorityBaseRef,
        payloadRef: ctx.payloadRef,
      });
      if (outcome.kind === 'completed') {
        return { kind: 'completed', resultRefs: outcome.resultRefs };
      }
      return { kind: 'retryable_failure', failureCode: outcome.failureCode, failureDigest: outcome.failureDigest };
    },
  };
}

// Register the four map-build publication handlers on the runtime allowlist so
// the default facade (which resolves against the singleton) can replay their
// pins. Idempotent — `registerMapBuildPublicationHandlers` checks `resolve`
// first. Tests with fresh registries call the same function explicitly.
registerMapBuildPublicationHandlers(PUBLICATION_INTENT_REGISTRY_V2);
