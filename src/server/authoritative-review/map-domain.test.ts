// @vitest-environment node
/**
 * Map identity tests (Task 3 brief Step 1): equal Map semantics with
 * different snapshot bytes/ref digests; position/relation graph digests;
 * subgraph digest determinism; MapReviewRound coverage + settlement DAG.
 * Normative: design §10.1/§10.2/§10.4/§11.1-§11.3; spec §7.2.
 */
import { describe, expect, it } from 'vitest';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';
import { refOfBlob } from './object-registry';
import {
  assembleMapSnapshot,
  assertMapReviewRoundTransition,
  computeMapCandidateValidationCore,
  computeMapReviewCoverageCore,
  computeMapReviewSettlementCore,
  computeProposedMapCore,
  diffNormalizedMaps,
  normalizeMapGraph,
  resolveMapRelationGraphDigest,
  resolveMapPositionGraphDigest,
  resolveMapSemanticDigest,
  resolveReviewSubgraphDigest,
  validateMapGraph,
} from './map-domain';
import type { MapPositionNodeV2, MapRelationV2 } from './authority-types';

function node(slotId: string, parent: string | null, order: number, sibling = 0, digest?: string): MapPositionNodeV2 {
  return {
    slotId,
    slotType: parent === null ? 'root' : 'section',
    contentBearing: true,
    parentSlotId: parent,
    documentOrder: order,
    siblingOrder: sibling,
    nodeSpecDigest: digest ?? `spec-${slotId}`,
  };
}

function relation(id: string, typeId: string, from: string, to: string, attrs?: Record<string, unknown>): MapRelationV2 {
  return {
    relationId: id,
    typeId,
    fromSlotId: from,
    toSlotId: to,
    attributes: attrs ?? {},
    relationDigest: `rel-${id}-digest`,
  };
}

describe('map identity: equal semantics, different bytes', () => {
  it('equal Map semantics with different MapSnapshot bytes/ref digests', () => {
    const nodes = [node('a', null, 0), node('b', 'a', 1), node('c', 'a', 2)];
    const rels = [relation('r1', 'sequence', 'a', 'b')];
    const graph = normalizeMapGraph('snap-1', nodes, rels);

    const base = {
      proposedMapCoreRef: refOfBlob('proposed_map_core', {
        scaffoldId: 'scaffold',
        proposedMapId: 'map-rev-1',
        supersedesMapId: null,
        sourceCandidateRef: refOfBlob('map_candidate', { candidateId: 'c1' }),
        mapRevision: 1,
        mapSemanticDigest: resolveMapSemanticDigest(graph),
        positionGraphDigest: resolveMapPositionGraphDigest(graph),
        relationGraphDigest: resolveMapRelationGraphDigest(graph),
        templateSnapshotHash: 'snap-1',
        nodes,
        relations: rels,
        coreDigest: '',
      }),
      mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'b1' }),
      sourceCandidateId: 'c1',
    } as const;

    // Two activations of the SAME semantic graph via different review bundles,
    // candidate sources and activation times — must share mapSemanticDigest but
    // have different complete-object refs.
    const a = assembleMapSnapshot({ ...base });
    const b = assembleMapSnapshot({
      ...base,
      sourceCandidateId: 'c2',
      mapRevision: 2,
      mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'b2' }),
      activatedAt: '2026-08-14T10:00:02.000Z',
    });

    expect(resolveMapSemanticDigest(a)).toBe(resolveMapSemanticDigest(b));
    expect(a.mapSemanticDigest).toBe(b.mapSemanticDigest);
    const refA = refOfBlob('map_snapshot', a);
    const refB = refOfBlob('map_snapshot', b);
    expect(refA.digest).not.toBe(refB.digest);
    expect(refA.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mapSemanticDigest never equals the snapshot ref digest', () => {
    const nodes = [node('a', null, 0)];
    const graph = normalizeMapGraph('snap-1', nodes, []);
    const snapshot = assembleMapSnapshot({
      proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'x' }),
      mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r' }),
      sourceCandidateId: 'c1',
    });
    expect(resolveMapSemanticDigest(snapshot)).not.toBe(refOfBlob('map_snapshot', snapshot).digest);
  });

  it('normalization is order-insensitive and digest stable under shuffled input', () => {
    const nodes = [node('a', null, 0, 0), node('b', 'a', 1, 0), node('c', 'a', 2, 1)];
    const rels = [relation('r1', 'sequence', 'a', 'b'), relation('r2', 'causal', 'b', 'c')];
    const forward = normalizeMapGraph('snap-1', nodes, rels);
    const shuffled = normalizeMapGraph(
      'snap-1',
      [nodes[2], nodes[0], nodes[1]],
      [rels[1], rels[0]],
    );
    expect(resolveMapSemanticDigest(forward)).toBe(resolveMapSemanticDigest(shuffled));
    expect(resolveMapPositionGraphDigest(forward)).toBe(resolveMapPositionGraphDigest(shuffled));
    expect(resolveMapRelationGraphDigest(forward)).toBe(resolveMapRelationGraphDigest(shuffled));
  });

  it('template identity participates in the semantic digest', () => {
    const nodes = [node('a', null, 0)];
    const g1 = normalizeMapGraph('snap-1', nodes, []);
    const g2 = normalizeMapGraph('snap-2', nodes, []);
    expect(resolveMapSemanticDigest(g1)).not.toBe(resolveMapSemanticDigest(g2));
  });

  it('relation changes move the relation graph digest but not necessarily the position digest', () => {
    const nodes = [node('a', null, 0), node('b', 'a', 1)];
    const withRel = normalizeMapGraph('s', nodes, [relation('r1', 'sequence', 'a', 'b')]);
    const withoutRel = normalizeMapGraph('s', nodes, []);
    expect(resolveMapRelationGraphDigest(withRel)).not.toBe(resolveMapRelationGraphDigest(withoutRel));
    expect(resolveMapPositionGraphDigest(withRel)).toBe(resolveMapPositionGraphDigest(withoutRel));
  });
});

describe('map structural validation', () => {
  it('rejects duplicate slot ids, dangling parents, non-contiguous document order', () => {
    expect(
      validateMapGraph({ templateSnapshotHash: 's', nodes: [node('a', null, 0), node('a', null, 1)], relations: [] }),
    ).not.toEqual([]);
    expect(
      () => normalizeMapGraph('s', [node('a', null, 0), node('b', 'ghost', 1)], []),
    ).toThrow('SCHEMA_INVALID');
    expect(validateMapGraph(normalizeMapGraph('s', [node('a', null, 0), node('b', 'a', 1), node('c', 'a', 3)], []))).not.toEqual([]);
  });

  it('rejects relations with unknown endpoints, self loops and directed cycles', () => {
    expect(
      () => normalizeMapGraph('s', [node('a', null, 0)], [relation('r1', 't', 'a', 'zz')]),
    ).toThrow('SCHEMA_INVALID');
    expect(
      () => normalizeMapGraph('s', [node('a', null, 0)], [relation('r1', 't', 'a', 'a')]),
    ).toThrow('SCHEMA_INVALID');
    const nodes = [node('a', null, 0), node('b', 'a', 1)];
    expect(
      () =>
        normalizeMapGraph('s', nodes, [
          relation('r1', 't', 'a', 'b'),
          relation('r2', 't', 'b', 'a'),
        ]),
    ).toThrow('cycle');
  });

  it('zero relations are legal and produce a canonical empty relation digest', () => {
    const graph = normalizeMapGraph('s', [node('a', null, 0)], []);
    expect(graph.relations).toEqual([]);
    expect(resolveMapRelationGraphDigest(graph)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('map review subgraph and impact closure (§10.4)', () => {
  const nodes = [node('a', null, 0), node('b', 'a', 1), node('c', 'a', 2), node('d', 'c', 3)];
  const rels = [relation('r1', 'causal', 'a', 'b'), relation('r2', 'causal', 'b', 'c')];
  const graph = normalizeMapGraph('s', nodes, rels);
  const policy = { causal: { direction: 'downstream' as const, maxHops: 2 } };

  it('subgraph digest is deterministic and stable under input order', () => {
    const d1 = resolveReviewSubgraphDigest(graph, 'b', policy);
    const d2 = resolveReviewSubgraphDigest(graph, 'b', policy);
    expect(d1).toBe(d2);
    const graph2 = normalizeMapGraph('s', [nodes[1], nodes[2], nodes[0], nodes[3]], [rels[1], rels[0]]);
    expect(resolveReviewSubgraphDigest(graph2, 'b', policy)).toBe(d1);
  });

  it('different neighbor or relation contexts change the subgraph digest', () => {
    const graphNoRels = normalizeMapGraph('s', nodes, []);
    expect(resolveReviewSubgraphDigest(graphNoRels, 'b', policy)).not.toBe(
      resolveReviewSubgraphDigest(graph, 'b', policy),
    );
  });
});

describe('map diff (§15.2)', () => {
  it('diff detects node/relation additions, removals and changes', () => {
    const nodesA = [node('a', null, 0), node('b', 'a', 1)];
    const nodesB = [node('a', null, 0), node('b', 'a', 1, 0, 'spec-b-v2'), node('c', 'a', 2)];
    const relA = normalizeMapGraph('s', nodesA, [relation('r1', 'sequence', 'a', 'b')]);
    const relB = normalizeMapGraph('s', nodesB, []);
    const diff = diffNormalizedMaps(relA, relB);
    expect(diff.addedNodeIds).toContain('c');
    expect(diff.removedRelationIds).toContain('r1');
    expect(diff.changedNodeIds).toContain('b');
    expect(diff.staleNodeIds).toEqual(
      expect.arrayContaining(['b', 'c']),
    );
  });
});

describe('map review round lifecycle (§11.1-§11.3)', () => {
  const nodes = [node('a', null, 0), node('b', 'a', 1)];
  const graph = normalizeMapGraph('s', nodes, []);
  const candidate = {
    candidateId: 'cand-1',
    baseMapId: null,
    candidateDigest: 'cd',
    validationCoreRef: refOfBlob('map_candidate_validation_core', { coreDigest: 'vc' }),
    candidateValidationAggregateRef: refOfBlob('validator_aggregate', { aggregateDigest: 'ag' }),
    candidateWarningCustodyRootRef: refOfBlob('validation_warning_custody_root', { rootDigest: 'w' }),
    createdAt: '2026-08-14T09:00:00.000Z',
  };

  it('transition chain planned -> reviewing_batches -> whole_map_observation -> completed -> settled', () => {
    expect(() => assertMapReviewRoundTransition('planned', 'reviewing_batches')).not.toThrow();
    expect(() => assertMapReviewRoundTransition('reviewing_batches', 'whole_map_observation')).not.toThrow();
    expect(() => assertMapReviewRoundTransition('whole_map_observation', 'completed')).not.toThrow();
    expect(() => assertMapReviewRoundTransition('completed', 'settled')).not.toThrow();
    expect(() => assertMapReviewRoundTransition('planned', 'settled')).toThrow('SCHEMA_INVALID');
    expect(() => assertMapReviewRoundTransition('completed', 'reviewing_batches')).toThrow('SCHEMA_INVALID');
  });

  it('candidate validation core covers every node and relation', () => {
    const core = computeMapCandidateValidationCore({
      candidateId: 'cand-1',
      baseMapId: null,
      positionGraphDigest: resolveMapPositionGraphDigest(graph),
      relationGraphDigest: resolveMapRelationGraphDigest(graph),
      templateSnapshotHash: 's',
      nodes,
      relations: [],
      candidateProvenanceWithoutValidation: {
        producerKind: 'system_map_finalize',
        producerWorkItemId: 'wi-1',
        commandId: 'cmd-1',
        mapBuildId: 'build-1',
        mapBuildRevision: 1,
        contributionManifestRef: refOfBlob('contribution_manifest', { manifestDigest: 'm' }),
      },
    });
    expect(core.coreDigest).toMatch(/^[0-9a-f]{64}$/);
    const coreNodes = (core as { nodes: MapPositionNodeV2[] }).nodes;
    expect(coreNodes.map((n) => n.slotId)).toEqual(['a', 'b']);
  });

  it('map review coverage core binds candidate, manifest baseline and finding stage root', () => {
    const coverage = computeMapReviewCoverageCore({
      mapReviewRoundId: 'round-1',
      candidateRef: refOfBlob('map_candidate', candidate),
      contentRevisionManifestRef: null,
      contentRootDigest: null,
      reviewPolicyDigest: 'policy-1',
      coverageLedgerRootRefs: [refOfBlob('review_assignment_ledger', { ledgerDigest: 'l1' })],
      wholeMapObservationRootRefs: [refOfBlob('review_assignment_ledger', { ledgerDigest: 'l2' })],
      findingStageRootRef: refOfBlob('finding_stage_root', { rootDigest: 'f' }),
    });
    expect(coverage.coreDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(coverage.candidateRef.digest).toBe(refOfBlob('map_candidate', candidate).digest);
  });

  it('settlement core and proposed map/bundle form one acyclic chain', () => {
    const coverageRef = refOfBlob('map_review_coverage_core', { coreDigest: 'cov' });

    const settlement = computeMapReviewSettlementCore({
      coverageCoreRef: coverageRef,
      mapReviewSettlementValidatorAggregateRef: refOfBlob('validator_aggregate', { aggregateDigest: 'ag2' }),
    });
    expect(settlement.coreDigest).toMatch(/^[0-9a-f]{64}$/);

    const proposed = computeProposedMapCore({
      scaffoldId: 'scaffold',
      proposedMapId: 'map-1',
      supersedesMapId: null,
      sourceCandidateRef: refOfBlob('map_candidate', candidate),
      mapRevision: 1,
      mapSemanticDigest: resolveMapSemanticDigest(graph),
      positionGraphDigest: resolveMapPositionGraphDigest(graph),
      relationGraphDigest: resolveMapRelationGraphDigest(graph),
      templateSnapshotHash: 's',
      nodes,
      relations: [],
    });
    expect(proposed.coreDigest).toMatch(/^[0-9a-f]{64}$/);

    // assertion helper: the settlement core must NOT reference itself as a child
    const own = refOfBlob('map_review_settlement_core', settlement);
    const childRefs = [
      settlement.coverageCoreRef,
      settlement.mapReviewSettlementValidatorAggregateRef,
    ];
    expect(childRefs.some((r) => r.digest === own.digest && r.kind === own.kind)).toBe(false);
  });
});

describe('manifest-vs-map staleness (content-domain surface used by map tests)', () => {
  it('assertManifestAgainstMap throws AUTHORITY_BASE_STALE for a binding mismatch', async () => {
    const { assertManifestAgainstMap } = await import('./content-domain');
    const refB: BlobRefV2 = refOfBlob('map_snapshot', {
      proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'x' }),
      mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'y' }),
      sourceCandidateId: 'c',
    });
    const manifestA = {
      taskId: 'task-1',
      mapRef: refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'x2' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'y2' }), sourceCandidateId: 'c2' }),
      mapSemanticDigest: 'd',
      taskContentRevision: 1,
      manifestPhase: 'baseline_unset' as const,
      entries: [],
      producerPlanSpecRef: null,
      priorManifestRef: null,
      finalizerValidatorAggregateRefs: [],
      finalizerWarningRootRefs: [],
      contentRootDigest: '',
      manifestDigest: '',
    };
    expect(() => assertManifestAgainstMap(manifestA, refB)).toThrow('AUTHORITY_BASE_STALE');
  });
});