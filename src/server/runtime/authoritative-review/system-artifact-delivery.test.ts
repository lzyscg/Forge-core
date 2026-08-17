// @vitest-environment node
/**
 * Task 22 SystemArtifactDelivery reachability tests (spec §13.5, design §16.3):
 * the closed v2 final-submission validator. `deriveV2Reachability` is pure and
 * returns a CLOSED reachable/unreachable result with a stable reason — it never
 * contains internal paths or provider text, never calls the v1 Agent Route walk
 * and carries NO human-authorization bypass (a human flag cannot make an
 * unreachable delivery reachable). `SystemArtifactDeliveryValidatorV2` resolves
 * the delivery/SealRecord/custody blobs through injected deps and delegates to
 * the pure rule.
 *
 * Every reject branch is exercised: missing/stale/consumed delivery, wrong
 * submitter work item / agent, un-completed producing System Seal WorkItem,
 * missing/mismatched SealRecord, mismatched artifact/custody refs and a
 * mismatched template snapshot.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { refOfBlob } from '../../authoritative-review/object-registry';
import type { BlobRefV2, SealRecordV2, SystemArtifactDeliveryV2 } from '../../../shared/authoritative-review-v2';
import type { ArtifactCustodyV2 } from '../../authoritative-review/authority-types';
import {
  deriveV2Reachability,
  SystemArtifactDeliveryValidatorV2,
  type FinalSubmissionUnreachableReasonV2,
  type SystemArtifactDeliveryClosureV2,
} from './system-artifact-delivery';

const H = (label: string) => canonicalJsonSha256({ label });
const TEMPLATE_HASH = 'a'.repeat(64);

interface DeliveryChain {
  artifactBody: { artifactId: string; mediaType: 'text/markdown'; text: string };
  artifactRef: BlobRefV2;
  sealRecordRef: BlobRefV2;
  custodyRef: BlobRefV2;
  deliveryRef: BlobRefV2;
  delivery: SystemArtifactDeliveryV2;
  sealRecord: SealRecordV2;
  custody: ArtifactCustodyV2;
}

/** Builds a fully self-consistent seal/delivery chain (refs close exactly). */
function buildChain(overrides: {
  sealWorkItemId?: string;
  submitterWorkItemId?: string;
  submitterAgentId?: string;
  deliveryId?: string;
  templateSnapshotHash?: string;
  artifactId?: string;
} = {}): DeliveryChain {
  const sealWorkItemId = overrides.sealWorkItemId ?? 'wi-seal';
  const submitterWorkItemId = overrides.submitterWorkItemId ?? 'wi-submit';
  const submitterAgentId = overrides.submitterAgentId ?? 'submitter';
  const deliveryId = overrides.deliveryId ?? 'del-1';
  const templateSnapshotHash = overrides.templateSnapshotHash ?? TEMPLATE_HASH;
  const artifactId = overrides.artifactId ?? 'artifact-1';
  const artifactBody = { artifactId, mediaType: 'text/markdown' as const, text: '# sealed' };
  const artifactRef = refOfBlob('artifact', artifactBody);
  const mapRef = refOfBlob('map_snapshot', { label: 'map' });
  const mapReviewBundleRef = refOfBlob('map_review_bundle', { label: 'mrb' });
  const contentRevisionManifestRef = refOfBlob('content_revision_manifest', { label: 'finalized' });
  const contentRootDigest = H('content-root');
  const reviewBundleRef = refOfBlob('review_bundle', { label: 'review' });
  const sealValidationBundleRef = refOfBlob('seal_validation_bundle', { label: 'svb' });
  const sealRecord: SealRecordV2 = {
    taskId: 'task-1',
    mapRef,
    mapSemanticDigest: H('map-semantic'),
    mapReviewBundleRef,
    contentRevisionManifestRef,
    contentRootDigest,
    reviewBundleRef,
    sealValidationBundleRef,
    templateSnapshotHash,
    assemblerDigest: H('assembler'),
    artifactRef,
    artifactDigest: artifactRef.digest,
  };
  const sealRecordRef = refOfBlob('seal_record', sealRecord);
  const custodyBody: Omit<ArtifactCustodyV2, 'custodyDigest'> = {
    taskId: 'task-1',
    sealWorkItemId,
    artifactRef,
    sealRecordRef,
    templateSnapshotHash,
    files: [{ name: 'chapter.md', hash: artifactRef.digest, byteLength: 16 }],
  };
  const custody: ArtifactCustodyV2 = {
    ...custodyBody,
    custodyDigest: canonicalJsonSha256(custodyBody),
  };
  const custodyRef = refOfBlob('artifact_custody', custody);
  const delivery: SystemArtifactDeliveryV2 = {
    deliveryId,
    producer: 'system:structured_seal',
    sealRecordRef,
    sealRecordDigest: sealRecordRef.digest,
    artifactId,
    artifactRef,
    artifactDigest: artifactRef.digest,
    custodyRef,
    custodyDigest: custodyRef.digest,
    submitterWorkItemId,
    submitterAgentId,
    templateSnapshotHash,
  };
  const deliveryRef = refOfBlob('system_artifact_delivery', delivery);
  return { artifactBody, artifactRef, sealRecordRef, custodyRef, deliveryRef, delivery, sealRecord, custody };
}

function reachableClosure(chain: DeliveryChain, overrides: Partial<SystemArtifactDeliveryClosureV2> = {}): SystemArtifactDeliveryClosureV2 {
  const base: SystemArtifactDeliveryClosureV2 = {
    deliveryId: chain.delivery.deliveryId,
    current: {
      deliveryId: chain.delivery.deliveryId,
      deliveryRef: chain.deliveryRef,
      artifactRef: chain.artifactRef,
      sealRecordRef: chain.sealRecordRef,
      submitterWorkItemId: chain.delivery.submitterWorkItemId,
    },
    delivery: chain.delivery,
    deliveryRef: chain.deliveryRef,
    sealRecord: chain.sealRecord,
    sealWorkItem: { workItemId: 'wi-seal', state: 'completed' },
    currentWorkItem: { workItemId: chain.delivery.submitterWorkItemId, state: 'started' },
    agentId: chain.delivery.submitterAgentId,
    templateSnapshotHash: chain.delivery.templateSnapshotHash,
    publishedArtifact: {
      artifactRef: chain.artifactRef,
      custodyRef: chain.custodyRef,
      sealRecordRef: chain.sealRecordRef,
      deliveryRef: chain.deliveryRef,
    },
    custody: chain.custody,
  };
  return { ...base, ...overrides };
}

describe('deriveV2Reachability (pure, closed)', () => {
  it('returns reachable for a fully-closed delivery chain', () => {
    const chain = buildChain();
    expect(deriveV2Reachability(reachableClosure(chain))).toEqual({ reachable: true });
  });

  it('rejects when no current delivery exists (delivery_missing)', () => {
    const chain = buildChain();
    expect(deriveV2Reachability(reachableClosure(chain, { current: null }))).toEqual({
      reachable: false,
      reason: 'delivery_missing',
    });
  });

  it('rejects when the current delivery names a different deliveryId (delivery_missing)', () => {
    const chain = buildChain();
    expect(
      deriveV2Reachability(
        reachableClosure(chain, { current: { ...reachableClosure(chain).current!, deliveryId: 'del-other' } }),
      ),
    ).toEqual({ reachable: false, reason: 'delivery_missing' });
  });

  it('rejects when the resolved delivery blob is missing (delivery_missing)', () => {
    const chain = buildChain();
    expect(deriveV2Reachability(reachableClosure(chain, { delivery: null }))).toEqual({
      reachable: false,
      reason: 'delivery_missing',
    });
  });

  it('rejects when the delivery blob was resolved under a stale ref (delivery_stale)', () => {
    const chain = buildChain();
    // Same deliveryId but different bytes -> a DIFFERENT ref under the current
    // deliveryId: the current delivery ref no longer addresses this blob.
    const other = buildChain({ templateSnapshotHash: 'b'.repeat(64) });
    expect(other.delivery.deliveryId).toBe(chain.delivery.deliveryId);
    expect(
      deriveV2Reachability(reachableClosure(chain, { deliveryRef: other.deliveryRef, delivery: other.delivery })),
    ).toEqual({ reachable: false, reason: 'delivery_stale' });
  });

  it('rejects when the submission is already consumed (delivery_consumed)', () => {
    const chain = buildChain();
    expect(
      deriveV2Reachability(reachableClosure(chain, { currentWorkItem: { workItemId: 'wi-submit', state: 'completed' } })),
    ).toEqual({ reachable: false, reason: 'delivery_consumed' });
  });

  it('rejects when the delivery targets a different submitter work item', () => {
    // The delivery targets wi-submit-a, but the CURRENT work item being
    // completed is wi-submit-b (the projection's current delivery stays
    // consistent with the delivery blob).
    const chain = buildChain({ submitterWorkItemId: 'wi-submit-a' });
    expect(
      deriveV2Reachability(
        reachableClosure(chain, {
          currentWorkItem: { workItemId: 'wi-submit-b', state: 'started' },
        }),
      ),
    ).toEqual({ reachable: false, reason: 'delivery_submitter_work_item_mismatch' });
  });

  it('rejects when the current work item is not the delivery target (work item mismatch)', () => {
    const chain = buildChain();
    expect(
      deriveV2Reachability(reachableClosure(chain, { currentWorkItem: { workItemId: 'wi-other', state: 'started' } })),
    ).toEqual({ reachable: false, reason: 'delivery_submitter_work_item_mismatch' });
  });

  it('rejects when the executing agent is not the declared submitter', () => {
    const chain = buildChain({ submitterAgentId: 'submitter' });
    expect(deriveV2Reachability(reachableClosure(chain, { agentId: 'attacker' }))).toEqual({
      reachable: false,
      reason: 'delivery_submitter_agent_mismatch',
    });
  });

  it('rejects when the producing System Seal WorkItem is missing or not completed', () => {
    const chain = buildChain();
    expect(deriveV2Reachability(reachableClosure(chain, { sealWorkItem: null }))).toEqual({
      reachable: false,
      reason: 'seal_work_item_not_completed',
    });
    expect(
      deriveV2Reachability(reachableClosure(chain, { sealWorkItem: { workItemId: 'wi-seal', state: 'started' } })),
    ).toEqual({ reachable: false, reason: 'seal_work_item_not_completed' });
  });

  it('rejects when the SealRecord blob is missing', () => {
    const chain = buildChain();
    expect(deriveV2Reachability(reachableClosure(chain, { sealRecord: null }))).toEqual({
      reachable: false,
      reason: 'seal_record_missing',
    });
  });

  it('rejects when the SealRecord does not close through the delivery refs', () => {
    const chain = buildChain();
    const other = buildChain({ artifactId: 'artifact-other' });
    expect(
      deriveV2Reachability(
        reachableClosure(chain, { sealRecord: { ...chain.sealRecord, artifactRef: other.artifactRef, artifactDigest: other.artifactRef.digest } }),
      ),
    ).toEqual({ reachable: false, reason: 'seal_record_ref_mismatch' });
  });

  it('rejects when the published artifact ref does not match the delivery', () => {
    const chain = buildChain();
    const other = buildChain({ artifactId: 'artifact-other' });
    expect(
      deriveV2Reachability(
        reachableClosure(chain, {
          publishedArtifact: {
            artifactRef: other.artifactRef,
            custodyRef: chain.custodyRef,
            sealRecordRef: chain.sealRecordRef,
            deliveryRef: chain.deliveryRef,
          },
        }),
      ),
    ).toEqual({ reachable: false, reason: 'artifact_ref_mismatch' });
  });

  it('rejects when the custody blob is missing or does not close', () => {
    const chain = buildChain();
    expect(deriveV2Reachability(reachableClosure(chain, { custody: null }))).toEqual({
      reachable: false,
      reason: 'custody_ref_mismatch',
    });
    const other = buildChain({ artifactId: 'artifact-other' });
    expect(
      deriveV2Reachability(
        reachableClosure(chain, { custody: { ...chain.custody, artifactRef: other.artifactRef } }),
      ),
    ).toEqual({ reachable: false, reason: 'custody_ref_mismatch' });
  });

  it('rejects when the template snapshot hash does not match the frozen task', () => {
    const chain = buildChain();
    expect(deriveV2Reachability(reachableClosure(chain, { templateSnapshotHash: 'b'.repeat(64) }))).toEqual({
      reachable: false,
      reason: 'template_snapshot_mismatch',
    });
  });

  it('never lets a human-authorization flag bypass reachability', () => {
    // The closure type carries no `humanAuthorized` member; a hostile object
    // that smuggles one is ignored — the stale/missing chain still rejects.
    const chain = buildChain();
    const closure = reachableClosure(chain, { current: null }) as SystemArtifactDeliveryClosureV2 & { humanAuthorized?: boolean };
    closure.humanAuthorized = true;
    expect(deriveV2Reachability(closure)).toEqual({ reachable: false, reason: 'delivery_missing' });
  });

  it('returns stable closed reasons without provider/internal text', () => {
    const chain = buildChain();
    const reasons: FinalSubmissionUnreachableReasonV2[] = [
      'delivery_missing',
      'delivery_stale',
      'delivery_consumed',
      'delivery_submitter_work_item_mismatch',
      'delivery_submitter_agent_mismatch',
      'seal_work_item_not_completed',
      'seal_record_missing',
      'seal_record_ref_mismatch',
      'artifact_ref_mismatch',
      'custody_ref_mismatch',
      'template_snapshot_mismatch',
    ];
    for (const reason of reasons) {
      // Every reason must be reachable as a closed discriminator (no free text).
      expect(typeof reason).toBe('string');
      expect(reason).toMatch(/^[a-z0-9_]+$/);
    }
    const closure = reachableClosure(chain, { current: null });
    const result = deriveV2Reachability(closure);
    expect(result.reachable).toBe(false);
    if (!result.reachable) {
      expect(reasons).toContain(result.reason);
    }
    expect(JSON.stringify(deriveV2Reachability(closure))).not.toContain('/');
  });
});

describe('SystemArtifactDeliveryValidatorV2 (blob-resolving)', () => {
  function install(blobs: Record<string, unknown>, projectionOverrides: Record<string, unknown> = {}) {
    const byKey = new Map<string, unknown>();
    for (const [key, value] of Object.entries(blobs)) {
      byKey.set(key, value);
    }
    const validator = new SystemArtifactDeliveryValidatorV2({
      readProjection: async () => ({
        delivery: null,
        publishedArtifact: null,
        currentSeal: null,
        workItems: {},
        ...projectionOverrides,
      }) as never as import('../../storage/authoritative-review-state').AuthoritativeReviewProjectionV2,
      resolveBlob: async (_taskId, ref) => byKey.get(`${ref.kind}:${ref.digest}`) ?? null,
      frozenTemplateHash: async () => TEMPLATE_HASH,
    });
    return validator;
  }

  it('resolves the delivery/SealRecord/custody chain and returns reachable', async () => {
    const chain = buildChain();
    const blobs: Record<string, unknown> = {};
    blobs[`system_artifact_delivery:${chain.deliveryRef.digest}`] = chain.delivery;
    blobs[`seal_record:${chain.sealRecordRef.digest}`] = chain.sealRecord;
    blobs[`artifact_custody:${chain.custodyRef.digest}`] = chain.custody;
    blobs[`artifact:${chain.artifactRef.digest}`] = chain.artifactBody;
    const validator = install(blobs, {
      delivery: {
        deliveryId: chain.delivery.deliveryId,
        deliveryRef: chain.deliveryRef,
        artifactId: chain.delivery.artifactId,
        artifactRef: chain.artifactRef,
        sealRecordRef: chain.sealRecordRef,
        submitterWorkItemId: chain.delivery.submitterWorkItemId,
      },
      publishedArtifact: {
        artifactId: chain.delivery.artifactId,
        artifactVersion: 1,
        deliveryRef: chain.deliveryRef,
        files: [],
        mediaType: 'text/markdown',
        producerWorkItemId: 'wi-seal',
        sealRecordRef: chain.sealRecordRef,
        artifactRef: chain.artifactRef,
        custodyRef: chain.custodyRef,
      },
      currentSeal: { sealWorkItemId: 'wi-seal', sealRecordRef: chain.sealRecordRef },
      workItems: {
        'wi-seal': { workItemId: 'wi-seal', state: 'completed' },
        'wi-submit': { workItemId: 'wi-submit', state: 'started' },
      },
    });
    const result = await validator.validateFinalSubmission({
      taskId: 'task-1',
      deliveryId: chain.delivery.deliveryId,
      workItemId: 'wi-submit',
      agentId: 'submitter',
    });
    expect(result).toEqual({ reachable: true });
  });

  it('rejects when the deliveryId is null (delivery_missing)', async () => {
    const validator = install({});
    const result = await validator.validateFinalSubmission({
      taskId: 'task-1',
      deliveryId: null,
      workItemId: 'wi-submit',
      agentId: 'submitter',
    });
    expect(result).toEqual({ reachable: false, reason: 'delivery_missing' });
  });

  it('rejects when the projection has no current delivery (delivery_missing)', async () => {
    const validator = install({});
    const result = await validator.validateFinalSubmission({
      taskId: 'task-1',
      deliveryId: 'del-1',
      workItemId: 'wi-submit',
      agentId: 'submitter',
    });
    expect(result).toEqual({ reachable: false, reason: 'delivery_missing' });
  });

  it('rejects when the delivery blob is unresolvable (delivery_missing)', async () => {
    const chain = buildChain();
    const validator = install({}, {
      delivery: {
        deliveryId: chain.delivery.deliveryId,
        deliveryRef: chain.deliveryRef,
        artifactId: chain.delivery.artifactId,
        artifactRef: chain.artifactRef,
        sealRecordRef: chain.sealRecordRef,
        submitterWorkItemId: chain.delivery.submitterWorkItemId,
      },
      currentSeal: { sealWorkItemId: 'wi-seal', sealRecordRef: chain.sealRecordRef },
      workItems: { 'wi-seal': { workItemId: 'wi-seal', state: 'completed' }, 'wi-submit': { workItemId: 'wi-submit', state: 'started' } },
    });
    const result = await validator.validateFinalSubmission({
      taskId: 'task-1',
      deliveryId: chain.delivery.deliveryId,
      workItemId: 'wi-submit',
      agentId: 'submitter',
    });
    expect(result).toEqual({ reachable: false, reason: 'delivery_missing' });
  });

  it('rejects when a ref is a bare digest / wrong bytes under the current ref (delivery_missing)', async () => {
    const chain = buildChain();
    const validator = install(
      {
        [`system_artifact_delivery:${chain.deliveryRef.digest}`]: { ...chain.delivery, artifactId: 'different' },
        [`seal_record:${chain.sealRecordRef.digest}`]: chain.sealRecord,
        [`artifact_custody:${chain.custodyRef.digest}`]: chain.custody,
        [`artifact:${chain.artifactRef.digest}`]: chain.artifactBody,
      },
      {
        delivery: {
          deliveryId: chain.delivery.deliveryId,
          deliveryRef: chain.deliveryRef,
          artifactId: chain.delivery.artifactId,
          artifactRef: chain.artifactRef,
          sealRecordRef: chain.sealRecordRef,
          submitterWorkItemId: chain.delivery.submitterWorkItemId,
        },
        currentSeal: { sealWorkItemId: 'wi-seal', sealRecordRef: chain.sealRecordRef },
        workItems: { 'wi-seal': { workItemId: 'wi-seal', state: 'completed' }, 'wi-submit': { workItemId: 'wi-submit', state: 'started' } },
      },
    );
    const result = await validator.validateFinalSubmission({
      taskId: 'task-1',
      deliveryId: chain.delivery.deliveryId,
      workItemId: 'wi-submit',
      agentId: 'submitter',
    });
    expect(result).toEqual({ reachable: false, reason: 'delivery_missing' });
  });

  it('rejects when the target work item does not exist (work item mismatch)', async () => {
    const chain = buildChain();
    const validator = install(
      {
        [`system_artifact_delivery:${chain.deliveryRef.digest}`]: chain.delivery,
        [`seal_record:${chain.sealRecordRef.digest}`]: chain.sealRecord,
        [`artifact_custody:${chain.custodyRef.digest}`]: chain.custody,
        [`artifact:${chain.artifactRef.digest}`]: chain.artifactBody,
      },
      {
        delivery: {
          deliveryId: chain.delivery.deliveryId,
          deliveryRef: chain.deliveryRef,
          artifactId: chain.delivery.artifactId,
          artifactRef: chain.artifactRef,
          sealRecordRef: chain.sealRecordRef,
          submitterWorkItemId: chain.delivery.submitterWorkItemId,
        },
        currentSeal: { sealWorkItemId: 'wi-seal', sealRecordRef: chain.sealRecordRef },
        workItems: { 'wi-seal': { workItemId: 'wi-seal', state: 'completed' } },
      },
    );
    const result = await validator.validateFinalSubmission({
      taskId: 'task-1',
      deliveryId: chain.delivery.deliveryId,
      workItemId: 'wi-submit',
      agentId: 'submitter',
    });
    expect(result).toEqual({ reachable: false, reason: 'delivery_submitter_work_item_mismatch' });
  });
});
