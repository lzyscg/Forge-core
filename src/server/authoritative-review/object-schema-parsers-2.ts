/**
 * Per-kind blob parsers, part 2 (plan/map/migration kinds). Authors:
 * design §10.1/§11.5/§13; spec §7.1. Every parser rejects unknown fields and
 * illegal combinations with `SchemaError`.
 */
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';
import {
  SchemaError,
  type ContentMigrationIntentCoreV2,
  type ContentMigrationSettlementCoreV2,
  type ContentMigrationSpecV2,
  type ContentMigrationValidationPlanSpecV2,
  type GenerationPlanSpecV2,
  type GrantInstanceV2,
  type LocalValidatorEquivalenceProofV2,
  type MapBuildChunkV2,
  type MapBuildKeyLedgerV2,
  type MapBuildManifestV2,
  type MapBuildSpecV2,
  type MapCandidateSnapshotV2,
  type MapCandidateValidationCoreV2,
  type MapReviewBundleV2,
  type MapReviewCoverageCoreV2,
  type MapReviewRoundV2,
  type MapReviewSettlementCoreV2,
  type MapSnapshotV2,
  type MigrationActivationDecisionV2,
  type MigrationValidationBatchResultV2,
  type ProposedMapCoreV2,
} from './authority-types';
import {
  checkRelationEndpointsAndCycles,
  ex,
  hs,
  hx,
  onn,
  parseMapRelations,
  parsePositionNodes,
  rec,
  rf,
  rfKind,
  rfa,
  rfaKind,
  rfn,
  str,
  sa,
} from './schema-common';

/* generation_plan_spec -------------------------------------------- */
export function parseGenerationPlanSpec(value: unknown): GenerationPlanSpecV2 {
  const o = rec(value, 'generation_plan_spec');
  ex(o, ['generationPlanId', 'revision', 'supersedesGenerationPlanId', 'sourceValidationReceiptRef', 'activeMapRef', 'baseContentRevisionManifestRef', 'importedContentManifestRef', 'correctionScopeDigest', 'orderedBatchSlotIds', 'specDigest'], 'generation_plan_spec');
  const batches = (o.orderedBatchSlotIds as unknown[]).map((v, i) => sa(v, `orderedBatchSlotIds[${i}]`));
  const out: GenerationPlanSpecV2 = {
    generationPlanId: str(o.generationPlanId, 'generationPlanId'),
    revision: onn(o.revision, 'revision'),
    supersedesGenerationPlanId: o.supersedesGenerationPlanId === null ? null : str(o.supersedesGenerationPlanId, 'supersedesGenerationPlanId'),
    sourceValidationReceiptRef: rfn(o.sourceValidationReceiptRef, 'sourceValidationReceiptRef'),
    activeMapRef: rfKind(o.activeMapRef, 'map_snapshot', 'activeMapRef'),
    baseContentRevisionManifestRef: rfKind(o.baseContentRevisionManifestRef, 'content_revision_manifest', 'baseContentRevisionManifestRef'),
    importedContentManifestRef: rfKind(o.importedContentManifestRef, 'content_revision_manifest', 'importedContentManifestRef'),
    correctionScopeDigest: o.correctionScopeDigest === null ? null : hx(o.correctionScopeDigest, 'correctionScopeDigest'),
    orderedBatchSlotIds: batches,
    specDigest: '',
  };
  hs(out, o.specDigest, 'specDigest', 'generation_plan_spec');
  return { ...out, specDigest: hx(o.specDigest, 'specDigest') };
}

/* grant_instance -------------------------------------------------- */
export function parseGrantInstance(value: unknown): GrantInstanceV2 {
  const o = rec(value, 'grant_instance');
  ex(o, ['grantInstanceId', 'grantSpecRef', 'workItemId', 'leaseEpoch', 'boundAttemptId', 'agentId', 'instanceDigest'], 'grant_instance');
  const out: GrantInstanceV2 = {
    grantInstanceId: str(o.grantInstanceId, 'grantInstanceId'),
    grantSpecRef: rfKind(o.grantSpecRef, 'write_grant_spec', 'grantSpecRef'),
    workItemId: str(o.workItemId, 'workItemId'),
    leaseEpoch: onn(o.leaseEpoch, 'leaseEpoch'),
    boundAttemptId: str(o.boundAttemptId, 'boundAttemptId'),
    agentId: str(o.agentId, 'agentId'),
    instanceDigest: '',
  };
  hs(out, o.instanceDigest, 'instanceDigest', 'grant_instance');
  return { ...out, instanceDigest: hx(o.instanceDigest, 'instanceDigest') };
}

/* local_validator_equivalence_proof ------------------------------- */
export function parseLocalValidatorEquivalenceProof(value: unknown): LocalValidatorEquivalenceProofV2 {
  const o = rec(value, 'local_validator_equivalence_proof');
  ex(o, ['slotId', 'sourceVersionRef', 'sourceMapRef', 'targetMapRef', 'sourceBatchInputRef', 'frozenRegistrationSetDigest', 'localMapSubgraphDigest', 'localRelationContextDigest', 'selectorExpansionDigest', 'equivalencePolicyVersion', 'proofDigest'], 'local_validator_equivalence_proof');
  const out: LocalValidatorEquivalenceProofV2 = {
    slotId: str(o.slotId, 'slotId'),
    sourceVersionRef: rfKind(o.sourceVersionRef, 'content_version', 'sourceVersionRef'),
    sourceMapRef: rfKind(o.sourceMapRef, 'map_snapshot', 'sourceMapRef'),
    targetMapRef: rfKind(o.targetMapRef, 'map_snapshot', 'targetMapRef'),
    sourceBatchInputRef: rfKind(o.sourceBatchInputRef, 'validator_input_envelope', 'sourceBatchInputRef'),
    frozenRegistrationSetDigest: hx(o.frozenRegistrationSetDigest, 'frozenRegistrationSetDigest'),
    localMapSubgraphDigest: hx(o.localMapSubgraphDigest, 'localMapSubgraphDigest'),
    localRelationContextDigest: hx(o.localRelationContextDigest, 'localRelationContextDigest'),
    selectorExpansionDigest: hx(o.selectorExpansionDigest, 'selectorExpansionDigest'),
    equivalencePolicyVersion: str(o.equivalencePolicyVersion, 'equivalencePolicyVersion'),
    proofDigest: '',
  };
  hs(out, o.proofDigest, 'proofDigest', 'local_validator_equivalence_proof');
  return { ...out, proofDigest: hx(o.proofDigest, 'proofDigest') };
}

/* map_build_chunk ------------------------------------------------- */
export function parseMapBuildChunk(value: unknown): MapBuildChunkV2 {
  const o = rec(value, 'map_build_chunk');
  ex(o, ['chunkId', 'mapBuildId', 'chunkOrdinal', 'parentFrontierDigest', 'nodeDeclarations', 'relationDeclarations', 'chunkDigest'], 'map_build_chunk');
  const nodes = (o.nodeDeclarations as unknown[]).map((v, i) => {
    const e = rec(v, `nodeDeclarations[${i}]`);
    ex(e, ['buildNodeKey', 'slotType', 'parentBuildNodeKey', 'documentOrder', 'siblingOrder', 'contentBearing'], `nodeDeclarations[${i}]`);
    return {
      buildNodeKey: str(e.buildNodeKey, 'buildNodeKey'),
      slotType: str(e.slotType, 'slotType'),
      parentBuildNodeKey: e.parentBuildNodeKey === null ? null : str(e.parentBuildNodeKey, 'parentBuildNodeKey'),
      documentOrder: onn(e.documentOrder, 'documentOrder'),
      siblingOrder: onn(e.siblingOrder, 'siblingOrder'),
      contentBearing: e.contentBearing === true || e.contentBearing === false ? e.contentBearing : (() => { throw new SchemaError('contentBearing must be boolean'); })(),
    };
  });
  const keys = nodes.map((n) => n.buildNodeKey);
  if (new Set(keys).size !== keys.length) throw new SchemaError('map_build_chunk.nodeDeclarations has duplicate buildNodeKey');
  for (let i = 0; i < nodes.length; i++) {
    const parent = nodes[i].parentBuildNodeKey;
    // Task 15 correction (design §10.2): a parent may reference a PREVIOUS
    // chunk's committed key (the build service's key ledger validates scope);
    // the blob parser only enforces SAME-CHUNK ordering — a parent declared
    // later in this chunk is rejected, a cross-chunk parent is legal.
    if (parent !== null && keys.includes(parent) && !keys.slice(0, i).includes(parent)) {
      throw new SchemaError(`map_build_chunk: parent '${parent}' must be declared earlier in the chunk or in a previous chunk's ledger`);
    }
  }
  const rels = (o.relationDeclarations as unknown[]).map((v, i) => {
    const e = rec(v, `relationDeclarations[${i}]`);
    ex(e, ['buildRelationKey', 'typeId', 'fromBuildNodeKey', 'toBuildNodeKey', 'attributes'], `relationDeclarations[${i}]`);
    return {
      buildRelationKey: str(e.buildRelationKey, 'buildRelationKey'),
      typeId: str(e.typeId, 'typeId'),
      fromBuildNodeKey: str(e.fromBuildNodeKey, 'fromBuildNodeKey'),
      toBuildNodeKey: str(e.toBuildNodeKey, 'toBuildNodeKey'),
      attributes: (v as { attributes: unknown }).attributes as Record<string, unknown>,
    };
  });
  const relKeys = rels.map((r) => r.buildRelationKey);
  if (new Set(relKeys).size !== relKeys.length) throw new SchemaError('map_build_chunk.relationDeclarations has duplicate buildRelationKey');
  for (const r of rels) {
    // Task 15 correction + fix round (design §10.2): a relation endpoint may
    // reference a PREVIOUS chunk's committed node key (the build service's key
    // ledger validates cross-chunk scope) or a NODE key declared in this chunk
    // — it can NEVER reference another RELATION key of this chunk (endpoints
    // are nodes; a relation key is declared later in the declaration order).
    for (const endpoint of [r.fromBuildNodeKey, r.toBuildNodeKey]) {
      if (relKeys.includes(endpoint)) {
        throw new SchemaError(`map_build_chunk: relation '${r.buildRelationKey}' endpoint '${endpoint}' is a relation key, not a node key`);
      }
    }
  }
  const out: MapBuildChunkV2 = {
    chunkId: str(o.chunkId, 'chunkId'),
    mapBuildId: str(o.mapBuildId, 'mapBuildId'),
    chunkOrdinal: onn(o.chunkOrdinal, 'chunkOrdinal'),
    parentFrontierDigest: hx(o.parentFrontierDigest, 'parentFrontierDigest'),
    nodeDeclarations: nodes,
    relationDeclarations: rels,
    chunkDigest: '',
  };
  hs(out, o.chunkDigest, 'chunkDigest', 'map_build_chunk');
  return { ...out, chunkDigest: hx(o.chunkDigest, 'chunkDigest') };
}

/* map_build_key_ledger / manifest / spec -------------------------- */
export function parseMapBuildKeyLedger(value: unknown): MapBuildKeyLedgerV2 {
  const o = rec(value, 'map_build_key_ledger');
  ex(o, ['mapBuildId', 'revision', 'entries', 'ledgerDigest'], 'map_build_key_ledger');
  const entries = (o.entries as unknown[]).map((v, i) => {
    const e = rec(v, `entries[${i}]`);
    ex(e, ['buildKey', 'kind', 'officialId', 'declaredByChunkOrdinal', 'status'], `entries[${i}]`);
    if (e.kind !== 'node' && e.kind !== 'relation') throw new SchemaError('kind must be node|relation');
    if (e.status !== 'active' && e.status !== 'tombstone') throw new SchemaError('status must be active|tombstone');
    return {
      buildKey: str(e.buildKey, 'buildKey'),
      kind: e.kind as 'node' | 'relation',
      officialId: e.officialId === null ? null : str(e.officialId, 'officialId'),
      declaredByChunkOrdinal: onn(e.declaredByChunkOrdinal, 'declaredByChunkOrdinal'),
      status: e.status as 'active' | 'tombstone',
    };
  });
  for (let i = 1; i < entries.length; i++) {
    if (entries[i - 1].buildKey >= entries[i].buildKey) throw new SchemaError('map_build_key_ledger.entries must be sorted by buildKey');
  }
  const out: MapBuildKeyLedgerV2 = {
    mapBuildId: str(o.mapBuildId, 'mapBuildId'),
    revision: onn(o.revision, 'revision'),
    entries,
    ledgerDigest: '',
  };
  hs(out, o.ledgerDigest, 'ledgerDigest', 'map_build_key_ledger');
  return { ...out, ledgerDigest: hx(o.ledgerDigest, 'ledgerDigest') };
}

export function parseMapBuildManifest(value: unknown): MapBuildManifestV2 {
  const o = rec(value, 'map_build_manifest');
  ex(o, ['mapBuildId', 'manifestOrdinal', 'orderedChunkEntries', 'keyLedgerRef', 'manifestDigest'], 'map_build_manifest');
  const entries = (o.orderedChunkEntries as unknown[]).map((v, i) => {
    const e = rec(v, `orderedChunkEntries[${i}]`);
    ex(e, ['chunkOrdinal', 'chunkRef'], `orderedChunkEntries[${i}]`);
    return { chunkOrdinal: onn(e.chunkOrdinal, 'chunkOrdinal'), chunkRef: rfKind(e.chunkRef, 'map_build_chunk', 'chunkRef') };
  });
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].chunkOrdinal !== i) throw new SchemaError('map_build_manifest.orderedChunkEntries must be contiguous ordinals 0..n-1');
  }
  const out: MapBuildManifestV2 = {
    mapBuildId: str(o.mapBuildId, 'mapBuildId'),
    manifestOrdinal: onn(o.manifestOrdinal, 'manifestOrdinal'),
    orderedChunkEntries: entries,
    keyLedgerRef: rfKind(o.keyLedgerRef, 'map_build_key_ledger', 'keyLedgerRef'),
    manifestDigest: '',
  };
  hs(out, o.manifestDigest, 'manifestDigest', 'map_build_manifest');
  return { ...out, manifestDigest: hx(o.manifestDigest, 'manifestDigest') };
}

export function parseMapBuildSpec(value: unknown): MapBuildSpecV2 {
  const o = rec(value, 'map_build_spec');
  ex(o, ['mapBuildId', 'revision', 'supersedesMapBuildId', 'sourceValidationReceiptRef', 'snapshotHash', 'plannedChunkPolicy', 'specDigest'], 'map_build_spec');
  const policy = rec(o.plannedChunkPolicy, 'plannedChunkPolicy');
  ex(policy, ['maxChunks', 'maxNodesPerChunk', 'maxRelationsPerChunk'], 'plannedChunkPolicy');
  const out: MapBuildSpecV2 = {
    mapBuildId: str(o.mapBuildId, 'mapBuildId'),
    revision: onn(o.revision, 'revision'),
    supersedesMapBuildId: o.supersedesMapBuildId === null ? null : str(o.supersedesMapBuildId, 'supersedesMapBuildId'),
    sourceValidationReceiptRef: rfn(o.sourceValidationReceiptRef, 'sourceValidationReceiptRef'),
    snapshotHash: str(o.snapshotHash, 'snapshotHash'),
    plannedChunkPolicy: {
      maxChunks: onn(policy.maxChunks, 'maxChunks'),
      maxNodesPerChunk: onn(policy.maxNodesPerChunk, 'maxNodesPerChunk'),
      maxRelationsPerChunk: onn(policy.maxRelationsPerChunk, 'maxRelationsPerChunk'),
    },
    specDigest: '',
  };
  hs(out, o.specDigest, 'specDigest', 'map_build_spec');
  return { ...out, specDigest: hx(o.specDigest, 'specDigest') };
}

/* map_candidate / validation core / snapshot chain ---------------- */
function parseCandidateProvenance(value: unknown): MapCandidateValidationCoreV2['candidateProvenanceWithoutValidation'] {
  const o = rec(value, 'candidateProvenanceWithoutValidation');
  if (o.producerKind === 'system_map_finalize') {
    ex(o, ['producerKind', 'producerWorkItemId', 'commandId', 'mapBuildId', 'mapBuildRevision', 'contributionManifestRef'], 'candidateProvenanceWithoutValidation');
    return {
      producerKind: 'system_map_finalize',
      producerWorkItemId: str(o.producerWorkItemId, 'producerWorkItemId'),
      commandId: str(o.commandId, 'commandId'),
      mapBuildId: str(o.mapBuildId, 'mapBuildId'),
      mapBuildRevision: onn(o.mapBuildRevision, 'mapBuildRevision'),
      contributionManifestRef: rfKind(o.contributionManifestRef, 'contribution_manifest', 'contributionManifestRef'),
    };
  }
  if (o.producerKind === 'system_repair_finalize') {
    ex(o, ['producerKind', 'producerWorkItemId', 'commandId', 'repairPlanId', 'repairPlanRevision', 'contributionManifestRef'], 'candidateProvenanceWithoutValidation');
    return {
      producerKind: 'system_repair_finalize',
      producerWorkItemId: str(o.producerWorkItemId, 'producerWorkItemId'),
      commandId: str(o.commandId, 'commandId'),
      repairPlanId: str(o.repairPlanId, 'repairPlanId'),
      repairPlanRevision: onn(o.repairPlanRevision, 'repairPlanRevision'),
      contributionManifestRef: rfKind(o.contributionManifestRef, 'contribution_manifest', 'contributionManifestRef'),
    };
  }
  throw new SchemaError('candidateProvenanceWithoutValidation.producerKind must be system_map_finalize|system_repair_finalize');
}

export function parseMapCandidateValidationCore(value: unknown): MapCandidateValidationCoreV2 {
  const o = rec(value, 'map_candidate_validation_core');
  ex(o, ['candidateId', 'baseMapId', 'positionGraphDigest', 'relationGraphDigest', 'templateSnapshotHash', 'nodes', 'relations', 'candidateProvenanceWithoutValidation', 'coreDigest'], 'map_candidate_validation_core');
  const nodes = parsePositionNodes(o.nodes, 'map_candidate_validation_core.nodes');
  const relations = parseMapRelations(o.relations, 'map_candidate_validation_core.relations');
  checkRelationEndpointsAndCycles(relations, nodes.map((n) => n.slotId), 'map_candidate_validation_core.relations');
  const out: MapCandidateValidationCoreV2 = {
    candidateId: str(o.candidateId, 'candidateId'),
    baseMapId: o.baseMapId === null ? null : str(o.baseMapId, 'baseMapId'),
    positionGraphDigest: hx(o.positionGraphDigest, 'positionGraphDigest'),
    relationGraphDigest: hx(o.relationGraphDigest, 'relationGraphDigest'),
    templateSnapshotHash: str(o.templateSnapshotHash, 'templateSnapshotHash'),
    nodes,
    relations,
    candidateProvenanceWithoutValidation: parseCandidateProvenance(o.candidateProvenanceWithoutValidation),
    coreDigest: '',
  };
  hs(out, o.coreDigest, 'coreDigest', 'map_candidate_validation_core');
  return { ...out, coreDigest: hx(o.coreDigest, 'coreDigest') };
}

export function parseMapCandidate(value: unknown): MapCandidateSnapshotV2 {
  const o = rec(value, 'map_candidate');
  ex(o, ['candidateId', 'baseMapId', 'candidateDigest', 'validationCoreRef', 'candidateValidationAggregateRef', 'candidateWarningCustodyRootRef', 'createdAt'], 'map_candidate');
  const out: MapCandidateSnapshotV2 = {
    candidateId: str(o.candidateId, 'candidateId'),
    baseMapId: o.baseMapId === null ? null : str(o.baseMapId, 'baseMapId'),
    candidateDigest: '',
    validationCoreRef: rfKind(o.validationCoreRef, 'map_candidate_validation_core', 'validationCoreRef'),
    candidateValidationAggregateRef: rfKind(o.candidateValidationAggregateRef, 'validator_aggregate', 'candidateValidationAggregateRef'),
    candidateWarningCustodyRootRef: rfKind(o.candidateWarningCustodyRootRef, 'validation_warning_custody_root', 'candidateWarningCustodyRootRef'),
    createdAt: str(o.createdAt, 'createdAt'),
  };
  hs(out, o.candidateDigest, 'candidateDigest', 'map_candidate');
  return { ...out, candidateDigest: hx(o.candidateDigest, 'candidateDigest') };
}

export function parseProposedMapCore(value: unknown): ProposedMapCoreV2 {
  const o = rec(value, 'proposed_map_core');
  ex(o, ['scaffoldId', 'proposedMapId', 'supersedesMapId', 'sourceCandidateRef', 'mapRevision', 'mapSemanticDigest', 'positionGraphDigest', 'relationGraphDigest', 'templateSnapshotHash', 'nodes', 'relations', 'coreDigest'], 'proposed_map_core');
  const nodes = parsePositionNodes(o.nodes, 'proposed_map_core.nodes');
  const relations = parseMapRelations(o.relations, 'proposed_map_core.relations');
  checkRelationEndpointsAndCycles(relations, nodes.map((n) => n.slotId), 'proposed_map_core.relations');
  const out: ProposedMapCoreV2 = {
    scaffoldId: str(o.scaffoldId, 'scaffoldId'),
    proposedMapId: str(o.proposedMapId, 'proposedMapId'),
    supersedesMapId: o.supersedesMapId === null ? null : str(o.supersedesMapId, 'supersedesMapId'),
    sourceCandidateRef: rfKind(o.sourceCandidateRef, 'map_candidate', 'sourceCandidateRef'),
    mapRevision: onn(o.mapRevision, 'mapRevision'),
    mapSemanticDigest: hx(o.mapSemanticDigest, 'mapSemanticDigest'),
    positionGraphDigest: hx(o.positionGraphDigest, 'positionGraphDigest'),
    relationGraphDigest: hx(o.relationGraphDigest, 'relationGraphDigest'),
    templateSnapshotHash: str(o.templateSnapshotHash, 'templateSnapshotHash'),
    nodes,
    relations,
    coreDigest: '',
  };
  hs(out, o.coreDigest, 'coreDigest', 'proposed_map_core');
  return { ...out, coreDigest: hx(o.coreDigest, 'coreDigest') };
}

export function parseMapSnapshot(value: unknown): MapSnapshotV2 {
  const o = rec(value, 'map_snapshot');
  ex(o, ['scaffoldId', 'mapId', 'supersedesMapId', 'sourceCandidateId', 'proposedMapCoreRef', 'mapReviewBundleRef', 'mapRevision', 'mapSemanticDigest', 'positionGraphDigest', 'relationGraphDigest', 'templateSnapshotHash', 'nodes', 'relations', 'activatedAt'], 'map_snapshot');
  const nodes = parsePositionNodes(o.nodes, 'map_snapshot.nodes');
  const relations = parseMapRelations(o.relations, 'map_snapshot.relations');
  checkRelationEndpointsAndCycles(relations, nodes.map((n) => n.slotId), 'map_snapshot.relations');
  return {
    scaffoldId: str(o.scaffoldId, 'scaffoldId'),
    mapId: str(o.mapId, 'mapId'),
    supersedesMapId: o.supersedesMapId === null ? null : str(o.supersedesMapId, 'supersedesMapId'),
    sourceCandidateId: str(o.sourceCandidateId, 'sourceCandidateId'),
    proposedMapCoreRef: rfKind(o.proposedMapCoreRef, 'proposed_map_core', 'proposedMapCoreRef'),
    mapReviewBundleRef: rfKind(o.mapReviewBundleRef, 'map_review_bundle', 'mapReviewBundleRef'),
    mapRevision: onn(o.mapRevision, 'mapRevision'),
    mapSemanticDigest: hx(o.mapSemanticDigest, 'mapSemanticDigest'),
    positionGraphDigest: hx(o.positionGraphDigest, 'positionGraphDigest'),
    relationGraphDigest: hx(o.relationGraphDigest, 'relationGraphDigest'),
    templateSnapshotHash: str(o.templateSnapshotHash, 'templateSnapshotHash'),
    nodes,
    relations,
    activatedAt: str(o.activatedAt, 'activatedAt'),
  };
}

/* map review / settlement / bundle (design §11.3) ----------------- */
/**
 * Task 16 `map_review_round` blob — the frozen MapReviewRound identity the
 * review WorkItems and the settlement bind via `reviewRoundRef` (design
 * §11.3; spec §10.1). Rounds are also event identities; this canonical object
 * is the resolvable reviewRoundRef payload the tool-factory reads.
 */
export function parseMapReviewRound(value: unknown): MapReviewRoundV2 {
  const o = rec(value, 'map_review_round');
  ex(o, [
    'mapReviewRoundId',
    'candidateId',
    'candidateDigest',
    'contentRevisionManifestRef',
    'contentRootDigest',
    'reviewPolicyDigest',
    'coverageNodeIds',
    'coverageRelationIds',
    'assignmentIds',
    'inheritedRecordRefs',
    'wholeMapObservationRefs',
    'verificationFindingStages',
    'state',
    'settlementRef',
  ], 'map_review_round');
  const state = str(o.state, 'state');
  if (!['planned', 'reviewing_batches', 'whole_map_observation', 'completed', 'settled'].includes(state)) {
    throw new SchemaError('map_review_round.state unknown');
  }
  const out: MapReviewRoundV2 = {
    mapReviewRoundId: str(o.mapReviewRoundId, 'mapReviewRoundId'),
    candidateId: str(o.candidateId, 'candidateId'),
    candidateDigest: hx(o.candidateDigest, 'candidateDigest'),
    contentRevisionManifestRef: rfn(o.contentRevisionManifestRef, 'contentRevisionManifestRef'),
    contentRootDigest: o.contentRootDigest === null ? null : hx(o.contentRootDigest, 'contentRootDigest'),
    reviewPolicyDigest: hx(o.reviewPolicyDigest, 'reviewPolicyDigest'),
    coverageNodeIds: sa(o.coverageNodeIds, 'coverageNodeIds'),
    coverageRelationIds: sa(o.coverageRelationIds, 'coverageRelationIds'),
    assignmentIds: sa(o.assignmentIds, 'assignmentIds'),
    inheritedRecordRefs: rfa(o.inheritedRecordRefs, 'inheritedRecordRefs'),
    wholeMapObservationRefs: rfa(o.wholeMapObservationRefs, 'wholeMapObservationRefs'),
    verificationFindingStages: sa(o.verificationFindingStages, 'verificationFindingStages'),
    state: state as MapReviewRoundV2['state'],
    settlementRef: rfn(o.settlementRef, 'settlementRef'),
  };
  return out;
}

export function parseMapReviewCoverageCore(value: unknown): MapReviewCoverageCoreV2 {
  const o = rec(value, 'map_review_coverage_core');
  ex(o, ['mapReviewRoundId', 'candidateRef', 'contentRevisionManifestRef', 'contentRootDigest', 'reviewPolicyDigest', 'coverageLedgerRootRefs', 'wholeMapObservationRootRefs', 'findingStageRootRef', 'coreDigest'], 'map_review_coverage_core');
  const out: MapReviewCoverageCoreV2 = {
    mapReviewRoundId: str(o.mapReviewRoundId, 'mapReviewRoundId'),
    candidateRef: rfKind(o.candidateRef, 'map_candidate', 'candidateRef'),
    contentRevisionManifestRef: rfn(o.contentRevisionManifestRef, 'contentRevisionManifestRef'),
    contentRootDigest: o.contentRootDigest === null ? null : hx(o.contentRootDigest, 'contentRootDigest'),
    reviewPolicyDigest: hx(o.reviewPolicyDigest, 'reviewPolicyDigest'),
    coverageLedgerRootRefs: rfaKind(o.coverageLedgerRootRefs, 'review_assignment_ledger', 'coverageLedgerRootRefs'),
    wholeMapObservationRootRefs: rfaKind(o.wholeMapObservationRootRefs, 'review_assignment_ledger', 'wholeMapObservationRootRefs'),
    findingStageRootRef: rfKind(o.findingStageRootRef, 'finding_stage_root', 'findingStageRootRef'),
    coreDigest: '',
  };
  hs(out, o.coreDigest, 'coreDigest', 'map_review_coverage_core');
  return { ...out, coreDigest: hx(o.coreDigest, 'coreDigest') };
}

export function parseMapReviewSettlementCore(value: unknown): MapReviewSettlementCoreV2 {
  const o = rec(value, 'map_review_settlement_core');
  ex(o, ['coverageCoreRef', 'mapReviewSettlementValidatorAggregateRef', 'coreDigest'], 'map_review_settlement_core');
  const out: MapReviewSettlementCoreV2 = {
    coverageCoreRef: rfKind(o.coverageCoreRef, 'map_review_coverage_core', 'coverageCoreRef'),
    mapReviewSettlementValidatorAggregateRef: rfKind(o.mapReviewSettlementValidatorAggregateRef, 'validator_aggregate', 'mapReviewSettlementValidatorAggregateRef'),
    coreDigest: '',
  };
  hs(out, o.coreDigest, 'coreDigest', 'map_review_settlement_core');
  return { ...out, coreDigest: hx(o.coreDigest, 'coreDigest') };
}

export function parseMapReviewBundle(value: unknown): MapReviewBundleV2 {
  const o = rec(value, 'map_review_bundle');
  ex(o, ['settlementCoreRef', 'proposedMapCoreRef', 'mapActivationValidatorAggregateRef', 'mapWarningCustodyRootRef', 'bundleDigest'], 'map_review_bundle');
  const out: MapReviewBundleV2 = {
    settlementCoreRef: rfKind(o.settlementCoreRef, 'map_review_settlement_core', 'settlementCoreRef'),
    proposedMapCoreRef: rfKind(o.proposedMapCoreRef, 'proposed_map_core', 'proposedMapCoreRef'),
    mapActivationValidatorAggregateRef: rfKind(o.mapActivationValidatorAggregateRef, 'validator_aggregate', 'mapActivationValidatorAggregateRef'),
    mapWarningCustodyRootRef: rfKind(o.mapWarningCustodyRootRef, 'validation_warning_custody_root', 'mapWarningCustodyRootRef'),
    bundleDigest: '',
  };
  hs(out, o.bundleDigest, 'bundleDigest', 'map_review_bundle');
  return { ...out, bundleDigest: hx(o.bundleDigest, 'bundleDigest') };
}

/* migration objects (design §11.5) --------------------------------- */
function parseMigrationIntentDecision(value: unknown, where: string): ContentMigrationIntentCoreV2['decisions'][number] {
  const o = rec(value, where);
  const action = str(o.action, `${where}.action`);
  if (action === 'inherit_or_validate' || action === 'carry_unset') {
    ex(o, ['action', 'slotId', 'sourceVersionRef', 'compatibilityProofRef'], where);
    return {
      action,
      slotId: str(o.slotId, 'slotId'),
      sourceVersionRef: rfKind(o.sourceVersionRef, 'content_version', 'sourceVersionRef'),
      compatibilityProofRef: rfKind(o.compatibilityProofRef, 'content_compatibility_proof', 'compatibilityProofRef'),
    } as ContentMigrationIntentCoreV2['decisions'][number];
  }
  if (action === 'rewrite_required') {
    ex(o, ['action', 'slotId', 'sourceVersionRef', 'rewriteReason', 'findingStageRootRef'], where);
    if (o.rewriteReason !== 'mixed_rewrite_required') throw new SchemaError('rewrite_required decision rewriteReason must be mixed_rewrite_required');
    return {
      action,
      slotId: str(o.slotId, 'slotId'),
      sourceVersionRef: rfKind(o.sourceVersionRef, 'content_version', 'sourceVersionRef'),
      rewriteReason: 'mixed_rewrite_required',
      findingStageRootRef: rfKind(o.findingStageRootRef, 'finding_stage_root', 'findingStageRootRef'),
    } as ContentMigrationIntentCoreV2['decisions'][number];
  }
  if (action === 'unset') {
    ex(o, ['action', 'slotId', 'unsetReason', 'sourceVersionRef'], where);
    if (o.unsetReason !== 'new_slot' && o.unsetReason !== 'schema_reset') throw new SchemaError('unset decision unsetReason must be new_slot|schema_reset');
    return {
      action,
      slotId: str(o.slotId, 'slotId'),
      unsetReason: o.unsetReason as 'new_slot' | 'schema_reset',
      sourceVersionRef: rfn(o.sourceVersionRef, 'sourceVersionRef'),
    } as ContentMigrationIntentCoreV2['decisions'][number];
  }
  throw new SchemaError(`${where}.action must be inherit_or_validate|carry_unset|rewrite_required|unset`);
}

export function parseContentMigrationIntentCore(value: unknown): ContentMigrationIntentCoreV2 {
  const o = rec(value, 'migration_intent_core');
  ex(o, ['taskId', 'migrationSpecRef', 'sourceManifestRef', 'sourceMapRef', 'targetMapRef', 'decisions', 'impactClosureRef', 'migrationPolicyVersion', 'coreDigest'], 'migration_intent_core');
  const out: ContentMigrationIntentCoreV2 = {
    taskId: str(o.taskId, 'taskId'),
    migrationSpecRef: rfKind(o.migrationSpecRef, 'migration_spec', 'migrationSpecRef'),
    sourceManifestRef: rfKind(o.sourceManifestRef, 'content_revision_manifest', 'sourceManifestRef'),
    sourceMapRef: rfKind(o.sourceMapRef, 'map_snapshot', 'sourceMapRef'),
    targetMapRef: rfKind(o.targetMapRef, 'map_snapshot', 'targetMapRef'),
    decisions: (o.decisions as unknown[]).map((v, i) => parseMigrationIntentDecision(v, `decisions[${i}]`)),
    impactClosureRef: rf(o.impactClosureRef, 'impactClosureRef'),
    migrationPolicyVersion: str(o.migrationPolicyVersion, 'migrationPolicyVersion'),
    coreDigest: '',
  };
  hs(out, o.coreDigest, 'coreDigest', 'migration_intent_core');
  return { ...out, coreDigest: hx(o.coreDigest, 'coreDigest') };
}

function parseMigrationSettlementOutcome(value: unknown, where: string): ContentMigrationSettlementCoreV2['decisions'][number] {
  const o = rec(value, where);
  const outcome = str(o.outcome, `${where}.outcome`);
  if (outcome === 'inherit_equivalent') {
    ex(o, ['outcome', 'slotId', 'sourceVersionRef', 'compatibilityProofRef', 'localValidatorEquivalenceProofRef'], where);
    return {
      outcome,
      slotId: str(o.slotId, 'slotId'),
      sourceVersionRef: rfKind(o.sourceVersionRef, 'content_version', 'sourceVersionRef'),
      compatibilityProofRef: rfKind(o.compatibilityProofRef, 'content_compatibility_proof', 'compatibilityProofRef'),
      localValidatorEquivalenceProofRef: rfKind(o.localValidatorEquivalenceProofRef, 'local_validator_equivalence_proof', 'localValidatorEquivalenceProofRef'),
    } as ContentMigrationSettlementCoreV2['decisions'][number];
  }
  if (outcome === 'inherit_revalidated') {
    ex(o, ['outcome', 'slotId', 'sourceVersionRef', 'compatibilityProofRef', 'migratedBatchValidatorAggregateRef', 'migratedBatchWarningRootRef'], where);
    return {
      outcome,
      slotId: str(o.slotId, 'slotId'),
      sourceVersionRef: rfKind(o.sourceVersionRef, 'content_version', 'sourceVersionRef'),
      compatibilityProofRef: rfKind(o.compatibilityProofRef, 'content_compatibility_proof', 'compatibilityProofRef'),
      migratedBatchValidatorAggregateRef: rfKind(o.migratedBatchValidatorAggregateRef, 'validator_aggregate', 'migratedBatchValidatorAggregateRef'),
      migratedBatchWarningRootRef: rfKind(o.migratedBatchWarningRootRef, 'validation_warning_custody_root', 'migratedBatchWarningRootRef'),
    } as ContentMigrationSettlementCoreV2['decisions'][number];
  }
  if (outcome === 'carry_unset') {
    ex(o, ['outcome', 'slotId', 'sourceVersionRef', 'compatibilityProofRef'], where);
    return {
      outcome,
      slotId: str(o.slotId, 'slotId'),
      sourceVersionRef: rfKind(o.sourceVersionRef, 'content_version', 'sourceVersionRef'),
      compatibilityProofRef: rfKind(o.compatibilityProofRef, 'content_compatibility_proof', 'compatibilityProofRef'),
    } as ContentMigrationSettlementCoreV2['decisions'][number];
  }
  if (outcome === 'unset') {
    ex(o, ['outcome', 'slotId', 'unsetReason'], where);
    if (o.unsetReason !== 'new_slot' && o.unsetReason !== 'schema_reset') throw new SchemaError('unset outcome unsetReason must be new_slot|schema_reset');
    return { outcome, slotId: str(o.slotId, 'slotId'), unsetReason: o.unsetReason as 'new_slot' | 'schema_reset' } as ContentMigrationSettlementCoreV2['decisions'][number];
  }
  if (outcome === 'rewrite_required') {
    ex(o, ['outcome', 'slotId', 'sourceVersionRef', 'rewriteCause', 'blockingValidatorAggregateRef', 'validationReceiptRef', 'findingStageRootRef'], where);
    if (o.rewriteCause !== 'validation_rejected' && o.rewriteCause !== 'mixed_rewrite_required') throw new SchemaError('rewriteCause must be validation_rejected|mixed_rewrite_required');
    return {
      outcome,
      slotId: str(o.slotId, 'slotId'),
      sourceVersionRef: rfKind(o.sourceVersionRef, 'content_version', 'sourceVersionRef'),
      rewriteCause: o.rewriteCause as 'validation_rejected' | 'mixed_rewrite_required',
      blockingValidatorAggregateRef: rfn(o.blockingValidatorAggregateRef, 'blockingValidatorAggregateRef'),
      validationReceiptRef: rfn(o.validationReceiptRef, 'validationReceiptRef'),
      findingStageRootRef: rfn(o.findingStageRootRef, 'findingStageRootRef'),
    } as ContentMigrationSettlementCoreV2['decisions'][number];
  }
  throw new SchemaError(`${where}.outcome must be inherit_equivalent|inherit_revalidated|carry_unset|unset|rewrite_required`);
}

export function parseContentMigrationSettlementCore(value: unknown): ContentMigrationSettlementCoreV2 {
  const o = rec(value, 'migration_settlement_core');
  ex(o, ['migrationIntentCoreRef', 'migrationValidationPlanSpecRef', 'orderedBatchResultRootRefs', 'decisions', 'batchClassifiedFindingSetRef', 'batchRouteOutcome', 'settlementDigest'], 'migration_settlement_core');
  const route = str(o.batchRouteOutcome, 'batchRouteOutcome');
  if (route !== 'clear' && route !== 'content_repair' && route !== 'map_repair' && route !== 'infrastructure_failure') throw new SchemaError('batchRouteOutcome unknown');
  const out: ContentMigrationSettlementCoreV2 = {
    migrationIntentCoreRef: rfKind(o.migrationIntentCoreRef, 'migration_intent_core', 'migrationIntentCoreRef'),
    migrationValidationPlanSpecRef: rfKind(o.migrationValidationPlanSpecRef, 'migration_validation_plan_spec', 'migrationValidationPlanSpecRef'),
    orderedBatchResultRootRefs: rfaKind(o.orderedBatchResultRootRefs, 'migration_validation_batch_result', 'orderedBatchResultRootRefs'),
    decisions: (o.decisions as unknown[]).map((v, i) => parseMigrationSettlementOutcome(v, `decisions[${i}]`)),
    batchClassifiedFindingSetRef: rfn(o.batchClassifiedFindingSetRef, 'batchClassifiedFindingSetRef'),
    batchRouteOutcome: route as ContentMigrationSettlementCoreV2['batchRouteOutcome'],
    settlementDigest: '',
  };
  hs(out, o.settlementDigest, 'settlementDigest', 'migration_settlement_core');
  return { ...out, settlementDigest: hx(o.settlementDigest, 'settlementDigest') };
}

function parseMigrationBatchSlotResult(value: unknown, where: string): MigrationValidationBatchResultV2['slotResults'][number] {
  const o = rec(value, where);
  const outcome = str(o.outcome, `${where}.outcome`);
  if (outcome === 'equivalent') {
    ex(o, ['outcome', 'slotId', 'localValidatorEquivalenceProofRef'], where);
    return {
      outcome,
      slotId: str(o.slotId, 'slotId'),
      localValidatorEquivalenceProofRef: rfKind(o.localValidatorEquivalenceProofRef, 'local_validator_equivalence_proof', 'localValidatorEquivalenceProofRef'),
    } as MigrationValidationBatchResultV2['slotResults'][number];
  }
  if (outcome === 'revalidated') {
    ex(o, ['outcome', 'slotId', 'validatorAggregateRef', 'warningRootRef'], where);
    return {
      outcome,
      slotId: str(o.slotId, 'slotId'),
      validatorAggregateRef: rfKind(o.validatorAggregateRef, 'validator_aggregate', 'validatorAggregateRef'),
      warningRootRef: rfKind(o.warningRootRef, 'validation_warning_root', 'warningRootRef'),
    } as MigrationValidationBatchResultV2['slotResults'][number];
  }
  if (outcome === 'rejected') {
    ex(o, ['outcome', 'slotId', 'validatorAggregateRef', 'validationReceiptRef', 'findingSetRef'], where);
    return {
      outcome,
      slotId: str(o.slotId, 'slotId'),
      validatorAggregateRef: rfKind(o.validatorAggregateRef, 'validator_aggregate', 'validatorAggregateRef'),
      validationReceiptRef: rfKind(o.validationReceiptRef, 'validation_receipt', 'validationReceiptRef'),
      findingSetRef: rfKind(o.findingSetRef, 'finding_set', 'findingSetRef'),
    } as MigrationValidationBatchResultV2['slotResults'][number];
  }
  throw new SchemaError(`${where}.outcome must be equivalent|revalidated|rejected`);
}

export function parseMigrationValidationBatchResult(value: unknown): MigrationValidationBatchResultV2 {
  const o = rec(value, 'migration_validation_batch_result');
  ex(o, ['migrationValidationPlanSpecRef', 'batchOrdinal', 'slotResults', 'batchOutcome', 'resultDigest'], 'migration_validation_batch_result');
  const route = str(o.batchOutcome, 'batchOutcome');
  if (route !== 'clear' && route !== 'content_repair' && route !== 'map_repair' && route !== 'infrastructure_failure') throw new SchemaError('batchOutcome unknown');
  const out: MigrationValidationBatchResultV2 = {
    migrationValidationPlanSpecRef: rfKind(o.migrationValidationPlanSpecRef, 'migration_validation_plan_spec', 'migrationValidationPlanSpecRef'),
    batchOrdinal: onn(o.batchOrdinal, 'batchOrdinal'),
    slotResults: (o.slotResults as unknown[]).map((v, i) => parseMigrationBatchSlotResult(v, `slotResults[${i}]`)),
    batchOutcome: route as MigrationValidationBatchResultV2['batchOutcome'],
    resultDigest: '',
  };
  hs(out, o.resultDigest, 'resultDigest', 'migration_validation_batch_result');
  return { ...out, resultDigest: hx(o.resultDigest, 'resultDigest') };
}

export function parseMigrationActivationDecision(value: unknown): MigrationActivationDecisionV2 {
  const o = rec(value, 'migration_activation_decision');
  ex(o, ['migrationSettlementCoreRef', 'provisionalManifestRef', 'contentPlanFinalizeCoreRef', 'finalizerAggregateRef', 'combinedClassifiedFindingSetRef', 'combinedRouteOutcome', 'decisionPolicyVersion', 'decisionDigest'], 'migration_activation_decision');
  const route = str(o.combinedRouteOutcome, 'combinedRouteOutcome');
  if (route !== 'clear' && route !== 'content_repair' && route !== 'map_repair' && route !== 'infrastructure_failure') throw new SchemaError('combinedRouteOutcome unknown');
  const out: MigrationActivationDecisionV2 = {
    migrationSettlementCoreRef: rfKind(o.migrationSettlementCoreRef, 'migration_settlement_core', 'migrationSettlementCoreRef'),
    provisionalManifestRef: rfKind(o.provisionalManifestRef, 'content_revision_manifest', 'provisionalManifestRef'),
    contentPlanFinalizeCoreRef: rfKind(o.contentPlanFinalizeCoreRef, 'content_plan_finalize_core', 'contentPlanFinalizeCoreRef'),
    finalizerAggregateRef: rfKind(o.finalizerAggregateRef, 'validator_aggregate', 'finalizerAggregateRef'),
    combinedClassifiedFindingSetRef: rfn(o.combinedClassifiedFindingSetRef, 'combinedClassifiedFindingSetRef'),
    combinedRouteOutcome: route as MigrationActivationDecisionV2['combinedRouteOutcome'],
    decisionPolicyVersion: str(o.decisionPolicyVersion, 'decisionPolicyVersion'),
    decisionDigest: '',
  };
  hs(out, o.decisionDigest, 'decisionDigest', 'migration_activation_decision');
  return { ...out, decisionDigest: hx(o.decisionDigest, 'decisionDigest') };
}

export function parseContentMigrationSpec(value: unknown): ContentMigrationSpecV2 {
  const o = rec(value, 'migration_spec');
  ex(o, ['migrationId', 'mapReviewSettlementCoreRef', 'sourceManifestRef', 'sourceMapRef', 'targetMapRef', 'impactClosureRef', 'migrationPolicyVersion', 'specDigest'], 'migration_spec');
  const out: ContentMigrationSpecV2 = {
    migrationId: str(o.migrationId, 'migrationId'),
    mapReviewSettlementCoreRef: rfKind(o.mapReviewSettlementCoreRef, 'map_review_settlement_core', 'mapReviewSettlementCoreRef'),
    sourceManifestRef: rfKind(o.sourceManifestRef, 'content_revision_manifest', 'sourceManifestRef'),
    sourceMapRef: rfKind(o.sourceMapRef, 'map_snapshot', 'sourceMapRef'),
    targetMapRef: rfKind(o.targetMapRef, 'map_snapshot', 'targetMapRef'),
    impactClosureRef: rf(o.impactClosureRef, 'impactClosureRef'),
    migrationPolicyVersion: str(o.migrationPolicyVersion, 'migrationPolicyVersion'),
    specDigest: '',
  };
  hs(out, o.specDigest, 'specDigest', 'migration_spec');
  return { ...out, specDigest: hx(o.specDigest, 'specDigest') };
}

export function parseContentMigrationValidationPlanSpec(value: unknown): ContentMigrationValidationPlanSpecV2 {
  const o = rec(value, 'migration_validation_plan_spec');
  ex(o, ['migrationValidationPlanId', 'migrationIntentCoreRef', 'candidateRef', 'proposedMapCoreRef', 'sourceManifestRef', 'frozenRegistrationSetDigest', 'orderedBatchSlotIds', 'profileRef', 'specDigest'], 'migration_validation_plan_spec');
  const out: ContentMigrationValidationPlanSpecV2 = {
    migrationValidationPlanId: str(o.migrationValidationPlanId, 'migrationValidationPlanId'),
    migrationIntentCoreRef: rfKind(o.migrationIntentCoreRef, 'migration_intent_core', 'migrationIntentCoreRef'),
    candidateRef: rfKind(o.candidateRef, 'map_candidate', 'candidateRef'),
    proposedMapCoreRef: rfKind(o.proposedMapCoreRef, 'proposed_map_core', 'proposedMapCoreRef'),
    sourceManifestRef: rfKind(o.sourceManifestRef, 'content_revision_manifest', 'sourceManifestRef'),
    frozenRegistrationSetDigest: hx(o.frozenRegistrationSetDigest, 'frozenRegistrationSetDigest'),
    orderedBatchSlotIds: (o.orderedBatchSlotIds as unknown[]).map((v, i) => sa(v, `orderedBatchSlotIds[${i}]`)),
    profileRef: rfKind(o.profileRef, 'profile_snapshot', 'profileRef'),
    specDigest: '',
  };
  hs(out, o.specDigest, 'specDigest', 'migration_validation_plan_spec');
  return { ...out, specDigest: hx(o.specDigest, 'specDigest') };
}