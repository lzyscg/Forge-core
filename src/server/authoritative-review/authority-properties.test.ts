// @vitest-environment node
/**
 * Property tests (Task 3 brief Step 6): seeded shuffled inputs prove
 * deterministic sort/digest for every stable identity; each pre-validation /
 * final-object DAG is constructed and proven acyclic (no object references
 * its own aggregate, transitively).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthoritativeBlobKindV2, BlobRefV2 } from '../../shared/authoritative-review-v2';
import { canonicalJsonSha256 } from '../structured-slots/canonical-json';
import {
  refOfBlob,
  closureOf,
  parseBlob,
} from './object-registry';
import {
  normalizeMapGraph,
  resolveMapSemanticDigest,
  resolveMapPositionGraphDigest,
  resolveMapRelationGraphDigest,
  resolveReviewSubgraphDigest,
} from './map-domain';
import {
  computeContentRootDigest,
  computeProvisionalOrFinalizedManifest,
  slotLeafDigest,
} from './content-domain';
import {
  planReviewBatches,
  planLayeredObservations,
} from './review-domain';
import type { MapPositionNodeV2, MapRelationV2 } from './authority-types';

/** Deterministic mulberry32 PRNG (test code only). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function makeNodes(count: number): { nodes: MapPositionNodeV2[]; relations: MapRelationV2[] } {
  const nodes: MapPositionNodeV2[] = [
    { slotId: 'slot-000', slotType: 'root', contentBearing: false, parentSlotId: null, documentOrder: 0, siblingOrder: 0, nodeSpecDigest: 'spec-000' },
  ];
  for (let i = 1; i < count; i++) {
    const parent = nodes[Math.floor(Math.sqrt(i - 1))].slotId;
    nodes.push({
      slotId: `slot-${String(i).padStart(3, '0')}`,
      slotType: 'section',
      contentBearing: i % 5 !== 0,
      parentSlotId: parent,
      documentOrder: i,
      siblingOrder: i % 3,
      nodeSpecDigest: `spec-${i}`,
    });
  }
  const relations: MapRelationV2[] = [];
  for (let i = 0; i < count - 1 && i < 40; i++) {
    relations.push({
      relationId: `rel-${String(i).padStart(3, '0')}`,
      typeId: i % 2 === 0 ? 'sequence' : 'causal',
      fromSlotId: nodes[Math.min(i, count - 1)].slotId,
      toSlotId: nodes[Math.min(i + 1, count - 1)].slotId,
      attributes: {},
      relationDigest: `rel-digest-${i}`,
    });
  }
  return { nodes, relations };
}

describe('property: deterministic digest under seeded shuffle', () => {
  it('map semantic/position/relation digests are invariant to any input order', () => {
    for (const seed of [1, 7, 42, 12345]) {
      const rand = mulberry32(seed);
      const { nodes, relations } = makeNodes(50);
      const canonical = normalizeMapGraph('snap-p', nodes, relations);
      const semantic = resolveMapSemanticDigest(canonical);
      const position = resolveMapPositionGraphDigest(canonical);
      const relation = resolveMapRelationGraphDigest(canonical);
      const subgraph = resolveReviewSubgraphDigest(canonical, 'slot-010', { causal: { direction: 'downstream', maxHops: 2 }, sequence: { direction: 'downstream', maxHops: 2 } });

      for (let round = 0; round < 5; round++) {
        const again = normalizeMapGraph('snap-p', shuffle(nodes, rand), shuffle(relations, rand));
        expect(resolveMapSemanticDigest(again)).toBe(semantic);
        expect(resolveMapPositionGraphDigest(again)).toBe(position);
        expect(resolveMapRelationGraphDigest(again)).toBe(relation);
        expect(resolveReviewSubgraphDigest(again, 'slot-010', { causal: { direction: 'downstream', maxHops: 2 }, sequence: { direction: 'downstream', maxHops: 2 } })).toBe(subgraph);
      }
    }
  });

  it('content root digest is invariant to leaf order and pins normalized-leaf semantics', () => {
    const rand = mulberry32(99);
    const mapRefA = refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'ma' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'ra' }), sourceCandidateId: 'ca' });
    const slots = Array.from({ length: 40 }, (_, i) => `k-${String(i).padStart(3, '0')}`);
    const versionsA = slots.map((slotId, i) => {
      const blobRef = refOfBlob('content_value', { slotId, contentDigest: `cd-${i}`, text: 'x' });
      return {
        state: 'set' as const,
        slotId,
        slotRevision: 1,
        contentDigest: blobRef.digest,
        taskContentRevision: 1,
        mapRef: mapRefA,
        mapSemanticDigest: 'sem-a',
        contentSchemaDigest: `sch-${i}`,
        blobRef,
        provenance: {
          kind: 'generated' as const,
          producer: { kind: 'generation_batch' as const, planRevisionId: 'p1', batchOrdinal: 0, attemptId: 'a1' },
          contentRevisionCommitCoreRef: refOfBlob('content_revision_commit_core', { coreDigest: 'cc' }),
          contentCommitValidatorAggregateRef: refOfBlob('validator_aggregate', { aggregateDigest: 'ag' }),
          contentCommitWarningRootRef: refOfBlob('validation_warning_custody_root', { rootDigest: 'w' }),
          committedByAttemptId: 'a1',
        },
      } as const;
    });
    const rootA = computeContentRootDigest(versionsA);
    for (let round = 0; round < 5; round++) {
      const shuffled = shuffle(versionsA, rand);
      expect(computeContentRootDigest(shuffled)).toBe(rootA);
    }
    // SAME content digest/schema on a DIFFERENT Map (different version bytes,
    // different versionRef digests) keeps the SAME root — only the manifest
    // ref distinguishes the revisions.
    const mapRefB = refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'mb' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'rb' }), sourceCandidateId: 'cb' });
    const versionsB = versionsA.map((v) => ({ ...v, mapRef: mapRefB, mapSemanticDigest: 'sem-b' }));
    expect(refOfBlob('content_version', versionsA[0]).digest).not.toBe(refOfBlob('content_version', versionsB[0]).digest);
    expect(computeContentRootDigest(versionsB)).toBe(rootA);
  });

  it('review batch planning and layered observation are order-invariant', () => {
    for (const seed of [3, 300]) {
      const rand = mulberry32(seed);
      const { nodes, relations } = makeNodes(30);
      const targets = nodes.map((n) => ({ id: n.slotId, documentOrder: n.documentOrder, parentId: n.parentSlotId }));
      const rels = relations.map((r, i) => ({ relationId: r.relationId, typeId: r.typeId, fromId: r.fromSlotId, toId: r.toSlotId, enforcement: (i % 3 === 0 ? 'advisory' : 'blocking') as 'blocking' | 'advisory' }));

      const base = planReviewBatches(targets, rels, { batchTarget: 8 });
      const obs = planLayeredObservations(targets.map((t) => ({ slotId: t.id, parentId: t.parentId, documentOrder: t.documentOrder })), { leafBatchSize: 8 });

      for (let round = 0; round < 5; round++) {
        const again = planReviewBatches(shuffle(targets, rand), shuffle(rels, rand), { batchTarget: 8 });
        expect(again.batches).toEqual(base.batches);
        expect(again.relationBatchAssignment).toEqual(base.relationBatchAssignment);
        const obsAgain = planLayeredObservations(shuffle(targets.map((t) => ({ slotId: t.id, parentId: t.parentId, documentOrder: t.documentOrder })), rand), { leafBatchSize: 8 });
        expect(obsAgain).toEqual(obs);
      }
    }
  });

  it('manifest digest and root are stable under shuffled entry input when sorted canonically', () => {
    const rand = mulberry32(555);
    const mapRef = refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'm' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r' }), sourceCandidateId: 'c' });
    const entries = Array.from({ length: 25 }, (_, i) => {
      const slotId = `p-${String(i).padStart(3, '0')}`;
      return { slotId, versionRef: refOfBlob('content_version', { slotId, state: 'set', contentDigest: `cd-${i}` }) };
    });
    const resolved = new Map(
      entries.map((e, i) => [e.slotId, { slotId: e.slotId, state: 'set' as const, slotRevision: 1, contentDigest: `cd-${i}`, taskContentRevision: 1, mapRef, mapSemanticDigest: 'sem-p', contentSchemaDigest: `sch-${i}`, blobRef: refOfBlob('content_value', { slotId: e.slotId, contentDigest: `cd-${i}`, text: 'x' }), provenance: { kind: 'generated' as const, producer: { kind: 'generation_batch' as const, planRevisionId: 'p1', batchOrdinal: 0, attemptId: 'a1' }, contentRevisionCommitCoreRef: refOfBlob('content_revision_commit_core', { coreDigest: 'cc' }), contentCommitValidatorAggregateRef: refOfBlob('validator_aggregate', { aggregateDigest: 'ag' }), contentCommitWarningRootRef: refOfBlob('validation_warning_custody_root', { rootDigest: 'w' }), committedByAttemptId: 'a1' } }]),
    );
    const build = (order: readonly { slotId: string; versionRef: unknown }[]) =>
      computeProvisionalOrFinalizedManifest({
        taskId: 't-p',
        mapRef,
        mapSemanticDigest: 'sem-p',
        taskContentRevision: 1,
        manifestPhase: 'provisional',
        entries: order.map((e) => ({ slotId: e.slotId, versionRef: e.versionRef as never })),
        producerPlanSpecRef: refOfBlob('generation_plan_spec', { specDigest: 'gp' }),
        resolvedVersions: resolved as unknown as ReadonlyMap<string, never>,
      });
    const base = build(entries);
    for (let round = 0; round < 5; round++) {
      const again = build(shuffle(entries, rand));
      expect(again.manifestDigest).toBe(base.manifestDigest);
      expect(again.contentRootDigest).toBe(base.contentRootDigest);
      const refBase = refOfBlob('content_revision_manifest', base);
      const refAgain = refOfBlob('content_revision_manifest', again);
      expect(refAgain).toEqual(refBase);
    }
  });
});

describe('property: no object references its own aggregate (acyclic DAGs)', () => {
  /** Self-digest helper: digest field covers the canonical object minus itself. */
  function withDigest(fields: Record<string, unknown>, key: string): Record<string, unknown> {
    const { [key]: _omitted, ...rest } = fields;
    void _omitted;
    return { ...rest, [key]: canonicalJsonSha256(rest) };
  }

  const H = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('map chain: validation core -> candidate snapshot -> coverage -> settlement -> proposed map -> bundle -> snapshot', () => {
    const { nodes, relations } = makeNodes(12);
    const graph = normalizeMapGraph('snap-p', nodes, relations);
    const pos = resolveMapPositionGraphDigest(graph);
    const rel = resolveMapRelationGraphDigest(graph);
    const sem = resolveMapSemanticDigest(graph);
    const aggregate = (d: string) => refOfBlob('validator_aggregate', { aggregateDigest: d });
    const custody = (d: string) => refOfBlob('validation_warning_custody_root', { rootDigest: d });
    const findingStageRoot = refOfBlob('finding_stage_root', { rootDigest: 'f' });

    const core = withDigest(
      {
        candidateId: 'cand-p',
        baseMapId: null,
        positionGraphDigest: pos,
        relationGraphDigest: rel,
        templateSnapshotHash: 'snap-p',
        nodes,
        relations,
        candidateProvenanceWithoutValidation: {
          producerKind: 'system_map_finalize' as const,
          producerWorkItemId: 'wi-p',
          commandId: 'cmd-p',
          mapBuildId: 'build-p',
          mapBuildRevision: 1,
          contributionManifestRef: refOfBlob('contribution_manifest', { manifestDigest: 'cm' }),
        },
      },
      'coreDigest',
    );
    const coreRef = refOfBlob('map_candidate_validation_core', core as never);

    const candidate = withDigest(
      {
        candidateId: 'cand-p',
        baseMapId: null,
        validationCoreRef: coreRef,
        candidateValidationAggregateRef: aggregate('ag'),
        candidateWarningCustodyRootRef: custody('w'),
        createdAt: '2026-08-14T09:00:00.000Z',
      },
      'candidateDigest',
    );
    const candidateRef = refOfBlob('map_candidate', candidate as never);

    const coverage = withDigest(
      {
        mapReviewRoundId: 'round-p',
        candidateRef,
        contentRevisionManifestRef: null,
        contentRootDigest: null,
        reviewPolicyDigest: H,
        coverageLedgerRootRefs: [],
        wholeMapObservationRootRefs: [],
        findingStageRootRef: findingStageRoot,
      },
      'coreDigest',
    );
    const coverageRef = refOfBlob('map_review_coverage_core', coverage as never);

    const settlement = withDigest(
      {
        coverageCoreRef: coverageRef,
        mapReviewSettlementValidatorAggregateRef: aggregate('ag2'),
      },
      'coreDigest',
    );
    const settlementRef = refOfBlob('map_review_settlement_core', settlement as never);

    const proposed = withDigest(
      {
        scaffoldId: 'scaffold-p',
        proposedMapId: 'map-p',
        supersedesMapId: null,
        sourceCandidateRef: candidateRef,
        mapRevision: 1,
        mapSemanticDigest: sem,
        positionGraphDigest: pos,
        relationGraphDigest: rel,
        templateSnapshotHash: 'snap-p',
        nodes,
        relations,
      },
      'coreDigest',
    );
    const proposedRef = refOfBlob('proposed_map_core', proposed as never);

    const bundle = withDigest(
      {
        settlementCoreRef: settlementRef,
        proposedMapCoreRef: proposedRef,
        mapActivationValidatorAggregateRef: aggregate('ag3'),
        mapWarningCustodyRootRef: custody('w2'),
      },
      'bundleDigest',
    );
    const bundleRef = refOfBlob('map_review_bundle', bundle as never);

    const snapshot = {
      scaffoldId: 'scaffold-p',
      mapId: 'map-p',
      supersedesMapId: null,
      sourceCandidateId: 'cand-p',
      proposedMapCoreRef: proposedRef,
      mapReviewBundleRef: bundleRef,
      mapRevision: 1,
      mapSemanticDigest: sem,
      positionGraphDigest: pos,
      relationGraphDigest: rel,
      templateSnapshotHash: 'snap-p',
      nodes,
      relations,
      activatedAt: '2026-08-14T09:01:00.000Z',
    };
    const snapshotRef = refOfBlob('map_snapshot', snapshot as never);

    const chain: Array<[AuthoritativeBlobKindV2, unknown, BlobRefV2]> = [
      ['map_candidate_validation_core', core, coreRef],
      ['map_candidate', candidate, candidateRef],
      ['map_review_coverage_core', coverage, coverageRef],
      ['map_review_settlement_core', settlement, settlementRef],
      ['proposed_map_core', proposed, proposedRef],
      ['map_review_bundle', bundle, bundleRef],
      ['map_snapshot', snapshot, snapshotRef],
    ];
    for (const [kind, value, ref] of chain) {
      const { object: parsed, ref: computedRef } = parseBlob(kind, value);
      expect(computedRef).toEqual({ kind, digest: ref.digest, byteLength: ref.byteLength, mediaType: ref.mediaType, schemaVersion: ref.schemaVersion });
      const closure = closureOf(parsed, () => null, kind);
      for (const r of closure) {
        expect(r.digest === computedRef.digest && r.kind === computedRef.kind && r.byteLength === computedRef.byteLength).toBe(false);
      }
    }
  });

  it('content chain: commit core -> versions/manifest -> coverage core -> settlement core -> bundle', () => {
    const mapRef = refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'm' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r' }), sourceCandidateId: 'c' });
    const priorManifestRef = refOfBlob('content_revision_manifest', { manifestDigest: D('prior') });
    const planRef = refOfBlob('generation_plan_spec', { specDigest: D('gp') });

    const commitCore = withDigest(
      {
        priorManifestRef,
        producerPlanSpecRef: planRef,
        batchOrdinal: 0,
        authorizedReplacementEntriesWithoutValidation: [{ slotId: 's1', expectedCurrentVersionRef: null }],
        expectedMapRef: mapRef,
      },
      'coreDigest',
    );
    const commitCoreRef = refOfBlob('content_revision_commit_core', commitCore as never);

    const contentValue = {
      slotId: 's1',
      contentSchemaDigest: 'sch',
      taskContentRevision: 1,
      mediaType: 'text/markdown' as const,
      text: 'x',
      selfDigest: D('cv'),
    };
    const contentValueRef = refOfBlob('content_value', contentValue);
    const version = {
      state: 'set' as const,
      slotId: 's1',
      slotRevision: 1,
      contentDigest: contentValueRef.digest,
      taskContentRevision: 1,
      mapRef,
      mapSemanticDigest: H,
      contentSchemaDigest: 'sch',
      blobRef: contentValueRef,
      provenance: {
        kind: 'generated',
        producer: { kind: 'generation_batch', planRevisionId: 'p1', batchOrdinal: 0, attemptId: 'a1' },
        contentRevisionCommitCoreRef: commitCoreRef,
        contentCommitValidatorAggregateRef: refOfBlob('validator_aggregate', { aggregateDigest: D('ag') }),
        contentCommitWarningRootRef: refOfBlob('validation_warning_custody_root', { rootDigest: D('w') }),
        committedByAttemptId: 'a1',
      },
    };
    const versionRef = refOfBlob('content_version', version as never);

    const manifest = withDigest(
      {
        taskId: 't',
        mapRef,
        mapSemanticDigest: H,
        taskContentRevision: 1,
        manifestPhase: 'provisional',
        entries: [{ slotId: 's1', versionRef }],
        producerPlanSpecRef: planRef,
        priorManifestRef,
        finalizerValidatorAggregateRefs: [],
        finalizerWarningRootRefs: [],
        contentRootDigest: H,
      },
      'manifestDigest',
    );
    const manifestRef = refOfBlob('content_revision_manifest', manifest as never);

    const coverage = withDigest(
      {
        reviewRoundId: 'round-c',
        mapRef,
        contentRevisionManifestRef: manifestRef,
        reviewPolicyDigest: H,
        coverageLedgerRootRefs: [],
        adoptionRootRef: refOfBlob('review_adoption_root', { rootDigest: D('ar') }),
        wholeTreeObservationRootRefs: [],
        findingStageRootRef: refOfBlob('finding_stage_root', { rootDigest: D('f') }),
      },
      'coreDigest',
    );
    const coverageRef = refOfBlob('content_review_coverage_core', coverage as never);

    const settlement = withDigest(
      {
        coverageCoreRef: coverageRef,
        reviewSettlementValidatorAggregateRef: refOfBlob('validator_aggregate', { aggregateDigest: D('ag2') }),
      },
      'coreDigest',
    );
    const settlementRef = refOfBlob('content_review_settlement_core', settlement as never);

    const bundle = withDigest(
      {
        settlementCoreRef: settlementRef,
        mapRef,
        contentRevisionManifestRef: manifestRef,
        reviewWarningCustodyRootRef: refOfBlob('validation_warning_custody_root', { rootDigest: D('w2') }),
      },
      'bundleDigest',
    );
    const bundleRef = refOfBlob('review_bundle', bundle as never);

    const chain: Array<[AuthoritativeBlobKindV2, unknown, BlobRefV2]> = [
      ['content_revision_commit_core', commitCore, commitCoreRef],
      ['content_version', version, versionRef],
      ['content_revision_manifest', manifest, manifestRef],
      ['content_review_coverage_core', coverage, coverageRef],
      ['content_review_settlement_core', settlement, settlementRef],
      ['review_bundle', bundle, bundleRef],
    ];
    for (const [kind, value, ref] of chain) {
      const { object: parsed, ref: computedRef } = parseBlob(kind, value);
      expect(computedRef).toEqual({ kind, digest: ref.digest, byteLength: ref.byteLength, mediaType: ref.mediaType, schemaVersion: ref.schemaVersion });
      const closure = closureOf(parsed, () => null, kind);
      for (const r of closure) {
        expect(r.digest === computedRef.digest && r.kind === computedRef.kind && r.byteLength === computedRef.byteLength).toBe(false);
      }
    }
  });
});

function D(seed: string): string {
  // deterministic digest-shaped placeholder: sha256 of the seed
  return createHash('sha256').update(seed).digest('hex');
}
