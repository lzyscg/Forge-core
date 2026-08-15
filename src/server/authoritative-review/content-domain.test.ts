// @vitest-environment node
/**
 * Content identity tests (Task 3 brief Step 1): equal content roots with
 * different manifest refs; complete unset|rewrite_required|set manifest
 * coverage; optional-unset system coverage and required-unset rejection;
 * migration objects and deterministic routing.
 * Normative: design §7.3/§11.5/§11.6/§11.10; spec §7.3.
 */
import { describe, expect, it } from 'vitest';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';
import { refOfBlob } from './object-registry';
import {
  assertManifestAgainstMap,
  assertManifestSemanticDigest,
  computeContentRootDigest,
  computeProvisionalOrFinalizedManifest,
  computePresenceCoverage,
  deriveCombinedRouteOutcome,
  slotLeafDigest,
  validateContentRevisionManifest,
} from './content-domain';
import type {
  ContentRevisionManifestV2,
  SlotContentVersionV2,
} from './authority-types';

let seq = 0;
function manifestRef(kind: BlobRefV2['kind'] = 'content_revision_manifest', v?: unknown): BlobRefV2 {
  return refOfBlob(kind, v ?? { manifestDigest: `m${(seq += 1)}` });
}

function setVersion(slotId: string, contentDigest: string, mapRef: BlobRefV2, mapSemanticDigest: string): SlotContentVersionV2 {
  const revisionRef = refOfBlob('content_revision_commit_core', { coreDigest: 'cc' });
  return {
    state: 'set',
    slotId,
    slotRevision: 1,
    contentDigest,
    taskContentRevision: 1,
    mapRef,
    mapSemanticDigest,
    contentSchemaDigest: `schema-${slotId}`,
    blobRef: refOfBlob('content_value', { slotId, contentDigest, text: 'body' }),
    provenance: {
      kind: 'generated',
      producer: { kind: 'generation_batch', planRevisionId: 'p1', batchOrdinal: 0, attemptId: 'a1' },
      contentRevisionCommitCoreRef: revisionRef,
      contentCommitValidatorAggregateRef: refOfBlob('validator_aggregate', { aggregateDigest: 'ag' }),
      contentCommitWarningRootRef: refOfBlob('validation_warning_custody_root', { rootDigest: 'w' }),
      committedByAttemptId: 'a1',
    },
  };
}

function unsetVersion(slotId: string, mapRef: BlobRefV2, mapSemanticDigest: string, reason: 'initial' | 'new_slot' | 'schema_reset' | 'carried_optional_unset' = 'initial'): SlotContentVersionV2 {
  return {
    state: 'unset',
    slotId,
    slotRevision: 1,
    taskContentRevision: 1,
    mapRef,
    mapSemanticDigest,
    contentSchemaDigest: `schema-${slotId}`,
    unsetReason: reason,
    unsetProvenance: { kind: 'created_empty' },
  };
}

function rewriteVersion(slotId: string, mapRef: BlobRefV2, mapSemanticDigest: string, cause: 'validation_rejected' | 'mixed_rewrite_required' = 'validation_rejected'): SlotContentVersionV2 {
  return {
    state: 'rewrite_required',
    slotId,
    slotRevision: 1,
    taskContentRevision: 1,
    mapRef,
    mapSemanticDigest,
    contentSchemaDigest: `schema-${slotId}`,
    sourceVersionRef: refOfBlob('content_version', { slotId, state: 'set' }),
    contentMigrationSettlementCoreRef: refOfBlob('migration_settlement_core', { settlementDigest: 'ms' }),
    rewriteCause:
      cause === 'validation_rejected'
        ? {
            kind: 'validation_rejected',
            blockingValidatorAggregateRef: refOfBlob('validator_aggregate', { aggregateDigest: 'bv' }),
            validationReceiptRef: refOfBlob('validation_receipt', { receiptDigest: 'vr' }),
            findingSetRef: refOfBlob('finding_set', { setDigest: 'fs' }),
          }
        : { kind: 'mixed_rewrite_required', findingStageRootRef: refOfBlob('finding_stage_root', { rootDigest: 'fr' }) },
    sourceContentDigest: 'src-digest',
  };
}

describe('content root identity (§7.3)', () => {
  it('equal content roots with different manifest refs are different revisions', () => {
    const mapRefA = refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'm1' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r1' }), sourceCandidateId: 'c1' });
    const mapRefB = refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'm2' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r2' }), sourceCandidateId: 'c2' });

    const vxA = setVersion('x', 'cd-x', mapRefA, 'sem-1');
    const vyA = setVersion('y', 'cd-y', mapRefA, 'sem-1');
    const vxB = setVersion('x', 'cd-x', mapRefB, 'sem-2');
    const vyB = setVersion('y', 'cd-y', mapRefB, 'sem-2');
    const a = computeProvisionalOrFinalizedManifest({
      taskId: 't1',
      mapRef: mapRefA,
      mapSemanticDigest: 'sem-1',
      taskContentRevision: 1,
      manifestPhase: 'provisional',
      entries: [
        { slotId: 'x', versionRef: refOfBlob('content_version', vxA) },
        { slotId: 'y', versionRef: refOfBlob('content_version', vyA) },
      ],
      producerPlanSpecRef: refOfBlob('generation_plan_spec', { specDigest: 'gp' }),
      resolvedVersions: new Map([['x', vxA], ['y', vyA]]),
    });
    const b = computeProvisionalOrFinalizedManifest({
      taskId: 't1',
      mapRef: mapRefB,
      mapSemanticDigest: 'sem-2',
      taskContentRevision: 2,
      manifestPhase: 'provisional',
      entries: [
        { slotId: 'x', versionRef: refOfBlob('content_version', vxB) },
        { slotId: 'y', versionRef: refOfBlob('content_version', vyB) },
      ],
      producerPlanSpecRef: refOfBlob('generation_plan_spec', { specDigest: 'gp2' }),
      resolvedVersions: new Map([['x', vxB], ['y', vyB]]),
    });

    expect(a.contentRootDigest).toBe(b.contentRootDigest); // same normalized leaves
    expect(refOfBlob('content_revision_manifest', a).digest).not.toBe(
      refOfBlob('content_revision_manifest', b).digest,
    );
    expect(() => assertManifestAgainstMap(a, refOfBlob('content_revision_manifest', b))).toThrow('AUTHORITY_BASE_STALE');
    expect(() => assertManifestSemanticDigest(a, 'other-sem')).toThrow('REVIEW_BASE_STALE');
  });

  it('leaf digests: unset uses UNSET(contentSchemaDigest), rewrite_required carries slot identity', () => {
    const u = slotLeafDigest('unset', { contentSchemaDigest: 'sch' });
    const u2 = slotLeafDigest('unset', { contentSchemaDigest: 'sch' });
    expect(u).toBe(u2);
    expect(slotLeafDigest('unset', { contentSchemaDigest: 'sch2' })).not.toBe(u);
    const rw = slotLeafDigest('rewrite_required', { contentSchemaDigest: 'sch', slotId: 'x', sourceContentDigest: null });
    const rwOther = slotLeafDigest('rewrite_required', { contentSchemaDigest: 'sch', slotId: 'y', sourceContentDigest: null });
    expect(rw).not.toBe(rwOther);
  });

  it('contentRootDigest digests NORMALIZED leaves from resolved versions, order-insensitively', () => {
    const mapRef = refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'm' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r' }), sourceCandidateId: 'c' });
    const vx = setVersion('x', 'cd-x', mapRef, 'sem');
    const vy = setVersion('y', 'cd-y', mapRef, 'sem');
    expect(computeContentRootDigest([vx, vy])).toBe(computeContentRootDigest([vy, vx]));
    // the versionRef digest (whole content_version object) is NEVER the leaf:
    // the same content bound to a different Map keeps the SAME root.
    const mapRefB = refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'm2' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r2' }), sourceCandidateId: 'c2' });
    const vx2 = setVersion('x', 'cd-x', mapRefB, 'sem-2');
    const vy2 = setVersion('y', 'cd-y', mapRefB, 'sem-2');
    expect(refOfBlob('content_version', vx).digest).not.toBe(refOfBlob('content_version', vx2).digest);
    expect(computeContentRootDigest([vx, vy])).toBe(computeContentRootDigest([vx2, vy2]));
  });
});

describe('manifest phase and coverage (§7.3/§11.5)', () => {
  const mapRef = refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'm' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r' }), sourceCandidateId: 'c' });
  const sem = 'sem';

  it('complete unset|rewrite_required|set manifest coverage is valid when sorted and complete', () => {
    const versions: SlotContentVersionV2[] = [
      unsetVersion('a', mapRef, sem, 'new_slot'),
      rewriteVersion('b', mapRef, sem),
      setVersion('c', 'cd-c', mapRef, sem),
    ];
    const manifest = computeProvisionalOrFinalizedManifest({
      taskId: 't1',
      mapRef,
      mapSemanticDigest: sem,
      taskContentRevision: 1,
      manifestPhase: 'provisional',
      entries: versions.map((v) => ({ slotId: v.slotId, versionRef: refOfBlob('content_version', v) })),
      producerPlanSpecRef: refOfBlob('migration_validation_plan_spec', { specDigest: 'mvp' }),
      resolvedVersions: new Map(versions.map((v) => [v.slotId, v])),
    });
    expect(() =>
      validateContentRevisionManifest(manifest, new Set(['a', 'b', 'c'])),
    ).not.toThrow();
    // incomplete coverage: manifest missing a slot of the current Map
    expect(() =>
      validateContentRevisionManifest(manifest, new Set(['a', 'c'])),
    ).toThrow('SCHEMA_INVALID');
  });

  it('baseline_unset requires all-unset created_empty entries, null plan and empty finalizer refs', () => {
    const manifest = computeProvisionalOrFinalizedManifest({
      taskId: 't1',
      mapRef,
      mapSemanticDigest: sem,
      taskContentRevision: 0,
      manifestPhase: 'baseline_unset',
      entries: [
        { slotId: 'a', versionRef: refOfBlob('content_version', unsetVersion('a', mapRef, sem)) },
        { slotId: 'b', versionRef: refOfBlob('content_version', unsetVersion('b', mapRef, sem)) },
      ],
      producerPlanSpecRef: null,
      resolvedVersions: new Map([
        ['a', unsetVersion('a', mapRef, sem)],
        ['b', unsetVersion('b', mapRef, sem)],
      ]),
    });
    expect(manifest.producerPlanSpecRef).toBeNull();
    expect(manifest.finalizerValidatorAggregateRefs).toEqual([]);
    // a baseline_unset manifest with a non-unset version is illegal
    const illegal = {
      ...manifest,
      entries: [
        { slotId: 'a', versionRef: refOfBlob('content_version', setVersion('a', 'cd', mapRef, sem)) },
        { slotId: 'b', versionRef: refOfBlob('content_version', unsetVersion('b', mapRef, sem)) },
      ],
    };
    expect(() =>
      validateContentRevisionManifest(
        illegal,
        new Set(['a', 'b']),
        new Map(versionsOf(illegal).map((v) => [v.slotId, v])),
      ),
    ).toThrow('SCHEMA_INVALID');
  });

  function versionsOf(m: { entries: readonly { slotId: string }[] }): SlotContentVersionV2[] {
    return [];
  }

  it('finalized requires set entries for every content slot, provisional forbids finalizer refs', () => {
    const versions = [setVersion('a', 'cd-a', mapRef, sem), setVersion('b', 'cd-b', mapRef, sem)];
    const provisional = computeProvisionalOrFinalizedManifest({
      taskId: 't1',
      mapRef,
      mapSemanticDigest: sem,
      taskContentRevision: 1,
      manifestPhase: 'provisional',
      entries: versions.map((v) => ({ slotId: v.slotId, versionRef: refOfBlob('content_version', v) })),
      producerPlanSpecRef: refOfBlob('generation_plan_spec', { specDigest: 'gp' }),
      resolvedVersions: new Map(versions.map((v) => [v.slotId, v])),
    });
    expect(() => validateContentRevisionManifest(provisional, new Set(['a', 'b']), new Map(versions.map((v) => [v.slotId, v])))).not.toThrow();
    expect(provisional.finalizerValidatorAggregateRefs).toEqual([]);

    const finalized = computeProvisionalOrFinalizedManifest({
      ...provisional,
      taskContentRevision: 2,
      manifestPhase: 'finalized',
      finalizerValidatorAggregateRefs: [refOfBlob('validator_aggregate', { aggregateDigest: 'fa' })],
      finalizerWarningRootRefs: [refOfBlob('validation_warning_custody_root', { rootDigest: 'fw' })],
      resolvedVersions: new Map(versions.map((v) => [v.slotId, v])),
    });
    expect(() => validateContentRevisionManifest(finalized, new Set(['a', 'b']), new Map(versions.map((v) => [v.slotId, v])))).not.toThrow();

    // finalized may not carry rewrite_required or unset entries
    const rw = rewriteVersion('a', mapRef, sem);
    expect(() =>
      validateContentRevisionManifest(
        { ...finalized, entries: [{ slotId: 'a', versionRef: refOfBlob('content_version', rw) }, finalized.entries[1] ] },
        new Set(['a', 'b']),
        new Map([['a', rw], ['b', versions[1]]]),
      ),
    ).toThrow('SCHEMA_INVALID');

    // finalized without finalizer refs is illegal
    expect(() =>
      validateContentRevisionManifest(
        { ...finalized, finalizerValidatorAggregateRefs: [] },
        new Set(['a', 'b']),
        new Map(versions.map((v) => [v.slotId, v])),
      ),
    ).toThrow('SCHEMA_INVALID');
    // Minor #4: a declared contentRootDigest that does not match the resolved
    // leaf root is rejected, even when every phase rule passes.
    const tampered = { ...finalized, contentRootDigest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' };
    expect(() =>
      validateContentRevisionManifest(tampered, new Set(['a', 'b']), new Map(versions.map((v) => [v.slotId, v]))),
    ).toThrow('contentRootDigest');
    void tampered;
  });
});

describe('presence-aware coverage (§11.6/§12.2)', () => {
  const mapRef = refOfBlob('map_snapshot', { proposedMapCoreRef: refOfBlob('proposed_map_core', { coreDigest: 'm' }), mapReviewBundleRef: refOfBlob('map_review_bundle', { bundleDigest: 'r' }), sourceCandidateId: 'c' });
  const sem = 'sem';

  function manifestWith(versions: SlotContentVersionV2[], phase: ContentRevisionManifestV2['manifestPhase'] = 'provisional'): ContentRevisionManifestV2 {
    return computeProvisionalOrFinalizedManifest({
      taskId: 't1',
      mapRef,
      mapSemanticDigest: sem,
      taskContentRevision: 1,
      manifestPhase: phase,
      entries: versions.map((v) => ({ slotId: v.slotId, versionRef: refOfBlob('content_version', v) })),
      producerPlanSpecRef: refOfBlob('generation_plan_spec', { specDigest: 'gp' }),
      resolvedVersions: new Map(versions.map((v) => [v.slotId, v])),
    });
  }

  it('optional-unset slots produce system absent_not_applicable coverage facts', () => {
    const manifest = manifestWith([
      unsetVersion('opt', mapRef, sem, 'carried_optional_unset'),
      setVersion('req', 'cd', mapRef, sem),
    ]);
    const presence = { opt: 'optional' as const, req: 'required' as const };
    const resolver = (slotId: string) => [unsetVersion('opt', mapRef, sem, 'carried_optional_unset'), setVersion('req', 'cd', mapRef, sem)].find((v) => v.slotId === slotId) ?? null;
    const result = computePresenceCoverage(manifest, presence, resolver);
    expect(result.planable).toBe(true);
    expect(result.facts).toHaveLength(2);
    const absent = result.facts.find((f) => f.slotId === 'opt');
    expect(absent).toMatchObject({
      disposition: 'absent_not_applicable',
      producedBy: 'system',
    });
    const reviewed = result.facts.find((f) => f.slotId === 'req');
    expect(reviewed?.disposition).toBe('reviewed');
  });

  it('required-unset slots make the round unplanable and route to repair (fail closed)', () => {
    const manifest = manifestWith([unsetVersion('req', mapRef, sem, 'initial')]);
    const resolver = (slotId: string) => (slotId === 'req' ? unsetVersion('req', mapRef, sem, 'initial') : null);
    const result = computePresenceCoverage(manifest, { req: 'required' }, resolver);
    expect(result.planable).toBe(false);
    expect(result.unplanableReasons.join(' ')).toContain('req');
  });

  it('rewrite_required slots are never covered by an absent fact and block planning', () => {
    const manifest = manifestWith([rewriteVersion('rw', mapRef, sem)]);
    const resolver = (slotId: string) => (slotId === 'rw' ? rewriteVersion('rw', mapRef, sem) : null);
    const result = computePresenceCoverage(manifest, { rw: 'optional' }, resolver);
    expect(result.planable).toBe(false);
    expect(result.facts).toHaveLength(0);
  });
});

describe('migration routing (§11.5)', () => {
  it('deriveCombinedRouteOutcome: map or mixed findings route Map first; content-only routes content; clear routes clear', () => {
    expect(deriveCombinedRouteOutcome([], 'clear')).toBe('clear');
    expect(deriveCombinedRouteOutcome([{ severity: 'blocking', defectClass: 'content' }], 'clear')).toBe('content_repair');
    expect(deriveCombinedRouteOutcome([{ severity: 'blocking', defectClass: 'map' }], 'clear')).toBe('map_repair');
    expect(deriveCombinedRouteOutcome([{ severity: 'blocking', defectClass: 'mixed' }], 'clear')).toBe('map_repair');
    // infrastructure failure dominates everything
    expect(deriveCombinedRouteOutcome([{ severity: 'blocking', defectClass: 'content' }], 'infrastructure_failure')).toBe('infrastructure_failure');
    // advisory-only findings stay clear
    expect(deriveCombinedRouteOutcome([{ severity: 'advisory', defectClass: 'content' }], 'clear')).toBe('clear');
  });

  it('migration intent decisions validate action/reason/provenance combinations', async () => {
    const { validateMigrationIntentDecisions } = await import('./content-domain');
    const proofRef = refOfBlob('content_compatibility_proof', { proofDigest: 'p' });
    const sourceRef = refOfBlob('content_version', { slotId: 's', state: 'set' });
    const rootRef = refOfBlob('finding_stage_root', { rootDigest: 'f' });
    expect(() =>
      validateMigrationIntentDecisions([
        { action: 'inherit_or_validate', slotId: 's1', sourceVersionRef: sourceRef, compatibilityProofRef: proofRef },
        { action: 'carry_unset', slotId: 's2', sourceVersionRef: sourceRef, compatibilityProofRef: proofRef },
        { action: 'rewrite_required', slotId: 's3', sourceVersionRef: sourceRef, rewriteReason: 'mixed_rewrite_required', findingStageRootRef: rootRef },
        { action: 'new_or_schema_reset', slotId: 's4', unsetReason: 'new_slot', sourceVersionRef: null },
      ]),
    ).not.toThrow();
    // rewrite_required without its finding stage root
    expect(() =>
      validateMigrationIntentDecisions([
        { action: 'rewrite_required', slotId: 's3', sourceVersionRef: sourceRef, rewriteReason: 'mixed_rewrite_required', findingStageRootRef: null as never },
      ]),
    ).toThrow('SCHEMA_INVALID');
  });
});
