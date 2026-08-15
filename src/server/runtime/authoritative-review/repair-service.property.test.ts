// @vitest-environment node
/**
 * Task 19 repair-service property tests (design §13 / spec §13.3): the repair
 * plan + batch partition + staging-root chain are PURE functions of their
 * inputs, so a crashed/restarted service instance (which holds NO in-memory
 * state — every continuation is reconstructed from the committed events +
 * blobs) reproduces the identical continuation and never reruns completed
 * batch ordinals.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import { fullProfileForTests } from '../../authoritative-review/object-registry';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { buildRepairPlanSpec, buildRepairBatchScopes, buildRepairStagingRoot, repairPlanKeyOf } from './repair-service';
import type { AuthoritativeReviewProfile, RepairPlanSpecV2 } from '../../authoritative-review/authority-types';

const PROFILE = fullProfileForTests();

const REVIEW_POLICY = {
  mapReview: 'required' as const,
  contentSelector: 'content_bearing' as const,
  mapBatchTargetSlots: 24,
  contentBatchTargetSlots: 1,
  assignmentSoftLimit: 64,
  wholeMapObservation: 'required' as const,
  wholeContentTreeObservation: 'required' as const,
  reviewAdvisoryRelations: false,
  maxRounds: 8,
};

function hash(salt: string): string {
  return canonicalJsonSha256({ salt });
}

function ref(kind: BlobRefV2['kind'], salt: string): BlobRefV2 {
  return { kind, digest: hash(salt), byteLength: 10, mediaType: 'application/json' as const, schemaVersion: 1 };
}

function planInput(overrides: Partial<Parameters<typeof buildRepairPlanSpec>[0]> = {}): Parameters<typeof buildRepairPlanSpec>[0] {
  return {
    repairPlanId: 'rp-prop-1',
    revision: 1,
    origin: { kind: 'initial', settlementId: 'wi-s-1', settlementDigest: 'a'.repeat(64), creationOperationKey: 'op-settle' },
    sourceReceiptRef: null,
    repairBase: { kind: 'content', mapRef: ref('map_snapshot', 'map'), contentRevisionManifestRef: ref('content_revision_manifest', 'manifest') },
    orderedBatchScopes: buildRepairBatchScopes({
      track: 'content',
      repairPlanId: 'rp-prop-1',
      nodeIds: [],
      relationIds: [],
      slotIds: ['s-1', 's-2', 's-3', 's-4', 's-5'],
      findingIds: ['c-1'],
      reviewPolicy: REVIEW_POLICY,
      profile: PROFILE,
    }),
    keyLineageRef: ref('repair_key_ledger', 'ledger'),
    importedStagingManifestRef: ref('content_revision_manifest', 'manifest'),
    ...overrides,
  };
}

afterEach(() => {
  // no runtime roots (pure tests only)
});

describe('repair determinism across service instances', () => {
  it('the batch partition is a pure function of the targets + policy (identical across restarts)', () => {
    const targets = { nodeIds: [] as string[], relationIds: [] as string[], slotIds: ['s-1', 's-2', 's-3', 's-4', 's-5'] };
    const a = buildRepairBatchScopes({
      track: 'content',
      repairPlanId: 'rp-prop-1',
      nodeIds: targets.nodeIds,
      relationIds: targets.relationIds,
      slotIds: targets.slotIds,
      findingIds: ['c-1', 'c-2'],
      reviewPolicy: REVIEW_POLICY,
      profile: PROFILE,
    });
    const b = buildRepairBatchScopes({
      track: 'content',
      repairPlanId: 'rp-prop-1',
      nodeIds: targets.nodeIds,
      relationIds: targets.relationIds,
      slotIds: targets.slotIds,
      findingIds: ['c-1', 'c-2'],
      reviewPolicy: REVIEW_POLICY,
      profile: PROFILE,
    });
    // A restarted service partitions identically (contentBatchTargetSlots=1 ->
    // one slot per batch, sorted, finding set frozen).
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBe(5);
    expect(a.map((sc) => (sc.kind === 'content' ? sc.slotIds : []))).toEqual([['s-1'], ['s-2'], ['s-3'], ['s-4'], ['s-5']]);
  });

  it('the plan spec identity is a pure function of its inputs (byte-identical across restarts)', () => {
    const a = buildRepairPlanSpec(planInput());
    const b = buildRepairPlanSpec(planInput());
    expect(a.specDigest).toBe(b.specDigest);
    expect(a.planRevisionId).toBe(b.planRevisionId);
    expect(a.planRevisionId).toBe(canonicalJsonSha256({ repairPlanId: a.repairPlanId, revision: a.revision, specDigest: a.specDigest }));
    // The plan-key derivation is also a pure function.
    expect(repairPlanKeyOf(a.repairPlanId, 's-1')).toBe(repairPlanKeyOf(b.repairPlanId, 's-1'));
  });

  it('the staging-root chain is a pure function (a resumed continuation is byte-identical)', () => {
    const plan = buildRepairPlanSpec(planInput());
    const keyLedgerRef = plan.keyLineageRef;
    const base = buildRepairStagingRoot({
      repairPlanId: plan.repairPlanId,
      planRevisionId: plan.planRevisionId,
      batchOrdinal: 0,
      mapRootDigest: null,
      contentRootDigest: hash('manifest'),
      priorStagingRootRef: null,
      keyLedgerRef,
    });
    const baseRef = { kind: 'repair_staging_root' as const, digest: canonicalJsonSha256(base), byteLength: 10, mediaType: 'application/json' as const, schemaVersion: 1 };
    const batch1 = buildRepairStagingRoot({
      repairPlanId: plan.repairPlanId,
      planRevisionId: plan.planRevisionId,
      batchOrdinal: 1,
      mapRootDigest: null,
      contentRootDigest: hash('root-1'),
      priorStagingRootRef: baseRef,
      keyLedgerRef,
    });
    const batch2 = buildRepairStagingRoot({
      repairPlanId: plan.repairPlanId,
      planRevisionId: plan.planRevisionId,
      batchOrdinal: 2,
      mapRootDigest: null,
      contentRootDigest: hash('root-2'),
      priorStagingRootRef: { kind: 'repair_staging_root', digest: canonicalJsonSha256(batch1), byteLength: 10, mediaType: 'application/json', schemaVersion: 1 },
      keyLedgerRef,
    });
    // The resumed continuation recomputes the SAME chain (the current staging
    // root of a batch is a pure function of the prior committed root).
    expect(batch1.priorStagingRootRef?.digest).toBe(baseRef.digest);
    expect(batch2.priorStagingRootRef?.digest).toBe(canonicalJsonSha256(batch1));
    expect(batch1.batchOrdinal).toBe(1);
    expect(batch2.batchOrdinal).toBe(2);
    // Re-running the pure builders produces byte-identical roots (no rerun of
    // completed ordinals can ever change the committed continuation).
    const batch1Again = buildRepairStagingRoot({
      repairPlanId: plan.repairPlanId,
      planRevisionId: plan.planRevisionId,
      batchOrdinal: 1,
      mapRootDigest: null,
      contentRootDigest: hash('root-1'),
      priorStagingRootRef: baseRef,
      keyLedgerRef,
    });
    expect(canonicalJsonSha256(batch1Again)).toBe(canonicalJsonSha256(batch1));
  });
});
