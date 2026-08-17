/**
 * Task 22 SystemArtifactDelivery (spec §13.5, design §16.3): the closed v2
 * final-submission validator that makes the generic Submitter's `submit_final`
 * reachable ONLY through the exact current SystemArtifactDelivery chain.
 *
 * The delivery is immutable and fully constructible before the publication
 * lock; `artifactVersion` lives only on `artifact_published_v2`. The Submitter
 * receives the delivery ref, uses the generic runner, and may submit only the
 * exact current artifact. `deriveV2Reachability` is the PURE closed rule —
 * reachable, or unreachable with a stable reason — and it:
 *
 * - never calls the v1 committed Agent Route walk;
 * - carries NO human-authorization bypass (a human flag cannot make an
 *   unreachable delivery reachable — the closure type has no such member);
 * - never leaks internal paths / provider text (reasons are a closed
 *   snake_case union).
 *
 * The resolving validator closes the delivery/SealRecord/artifact/custody refs
 * against the projected current delivery + published artifact + producing
 * System Seal WorkItem, and fails closed on ANY unresolvable or mismatched
 * binding — a bare digest never satisfies the closure.
 */
import type { BlobRefV2, SealRecordV2, SystemArtifactDeliveryV2 } from '../../../shared/authoritative-review-v2';
import type { ArtifactCustodyV2 } from '../../authoritative-review/authority-types';
import { parseBlob } from '../../authoritative-review/object-registry';
import type { AuthoritativeReviewProjectionV2 } from '../../storage/authoritative-review-state';
import { sameRef } from './authority-base';

/** Closed stable reason of an unreachable v2 final submission (never free text). */
export type FinalSubmissionUnreachableReasonV2 =
  | 'delivery_missing'
  | 'delivery_stale'
  | 'delivery_consumed'
  | 'delivery_submitter_work_item_mismatch'
  | 'delivery_submitter_agent_mismatch'
  | 'seal_work_item_not_completed'
  | 'seal_record_missing'
  | 'seal_record_ref_mismatch'
  | 'artifact_ref_mismatch'
  | 'custody_ref_mismatch'
  | 'template_snapshot_mismatch';

/** The closed reachability result of one final submission. */
export type FinalSubmissionReachabilityV2 =
  | { reachable: true }
  | { reachable: false; reason: FinalSubmissionUnreachableReasonV2 };

/** The identity the coordinator holds when validating one generic submission. */
export interface FinalSubmissionValidationInputV2 {
  taskId: string;
  /** The attempt-bound `inputArtifactDeliveryId` (null = not delivery-bound). */
  deliveryId: string | null;
  /** The current generic submitter WorkItem being completed. */
  workItemId: string;
  /** The agent executing the current turn (the lease owner). */
  agentId: string;
}

/** The structural closure the PURE reachability rule consumes. */
export interface SystemArtifactDeliveryClosureV2 {
  /** The delivery id the attempt is bound to. */
  deliveryId: string;
  /** The projection's current delivery (null when none). */
  current: {
    deliveryId: string;
    deliveryRef: BlobRefV2;
    artifactRef: BlobRefV2;
    sealRecordRef: BlobRefV2;
    submitterWorkItemId: string;
  } | null;
  /** The resolved delivery blob (null when unresolvable). */
  delivery: SystemArtifactDeliveryV2 | null;
  /** The ref under which the delivery blob was resolved (null when unresolvable). */
  deliveryRef: BlobRefV2 | null;
  /** The resolved SealRecord blob (null when unresolvable). */
  sealRecord: SealRecordV2 | null;
  /** The producing System Seal WorkItem projection (null when missing). */
  sealWorkItem: { workItemId: string; state: string } | null;
  /** The current submitter WorkItem being completed (null when missing). */
  currentWorkItem: { workItemId: string; state: string } | null;
  /** The agent executing the current turn. */
  agentId: string;
  /** The task-frozen template snapshot hash. */
  templateSnapshotHash: string;
  /** The projection's current published artifact (null when none). */
  publishedArtifact: {
    artifactRef: BlobRefV2;
    custodyRef: BlobRefV2;
    sealRecordRef: BlobRefV2;
    deliveryRef: BlobRefV2;
  } | null;
  /** The resolved artifact custody blob (null when unresolvable). */
  custody: ArtifactCustodyV2 | null;
}

/**
 * The PURE closed reachability rule (design §16.3): delivery present/current,
 * the producing System Seal WorkItem completed, SealRecord/artifact/custody/
 * template refs all matching, and the delivery's submitter identical to the
 * current WorkItem + executing agent. Any failure returns unreachable with a
 * stable reason; there is NO human-authorization bypass and NO v1 route walk.
 */
export function deriveV2Reachability(input: SystemArtifactDeliveryClosureV2): FinalSubmissionReachabilityV2 {
  // 1. The delivery is present and CURRENT (never a stale or bare binding).
  if (input.current === null || input.current.deliveryId !== input.deliveryId) {
    return { reachable: false, reason: 'delivery_missing' };
  }
  if (input.delivery === null || input.delivery.deliveryId !== input.deliveryId) {
    return { reachable: false, reason: 'delivery_missing' };
  }
  if (input.deliveryRef === null || !sameRef(input.current.deliveryRef, input.deliveryRef)) {
    return { reachable: false, reason: 'delivery_stale' };
  }
  if (input.current.submitterWorkItemId !== input.delivery.submitterWorkItemId) {
    return { reachable: false, reason: 'delivery_stale' };
  }
  // 2. The delivery targets EXACTLY the current submitter WorkItem.
  if (input.currentWorkItem === null || input.delivery.submitterWorkItemId !== input.currentWorkItem.workItemId) {
    return { reachable: false, reason: 'delivery_submitter_work_item_mismatch' };
  }
  if (input.currentWorkItem.state === 'completed') {
    return { reachable: false, reason: 'delivery_consumed' };
  }
  if (input.delivery.submitterAgentId !== input.agentId) {
    return { reachable: false, reason: 'delivery_submitter_agent_mismatch' };
  }
  // 3. The producing System Seal WorkItem must be completed.
  if (input.sealWorkItem === null || input.sealWorkItem.state !== 'completed') {
    return { reachable: false, reason: 'seal_work_item_not_completed' };
  }
  // 4. SealRecord closure: same ref chain across projection + delivery + the
  //    resolved record, and the record closes through the exact artifact.
  if (input.sealRecord === null) {
    return { reachable: false, reason: 'seal_record_missing' };
  }
  const sealCloses =
    sameRef(input.delivery.sealRecordRef, input.current.sealRecordRef) &&
    (input.publishedArtifact === null || sameRef(input.publishedArtifact.sealRecordRef, input.delivery.sealRecordRef)) &&
    sameRef(input.sealRecord.artifactRef, input.delivery.artifactRef) &&
    input.sealRecord.artifactDigest === input.delivery.artifactDigest;
  if (!sealCloses) {
    return { reachable: false, reason: 'seal_record_ref_mismatch' };
  }
  // 5. Artifact closure: the current published artifact IS the delivery's
  //    artifact (the "exact current artifact" rule — a different version/delivery
  //    is never reachable).
  if (input.publishedArtifact === null) {
    return { reachable: false, reason: 'artifact_ref_mismatch' };
  }
  if (
    !sameRef(input.delivery.artifactRef, input.current.artifactRef) ||
    !sameRef(input.publishedArtifact.artifactRef, input.delivery.artifactRef) ||
    !sameRef(input.publishedArtifact.deliveryRef, input.current.deliveryRef)
  ) {
    return { reachable: false, reason: 'artifact_ref_mismatch' };
  }
  // 6. Custody closure: the real custody manifest binds the exact artifact +
  //    SealRecord + template snapshot.
  if (input.custody === null) {
    return { reachable: false, reason: 'custody_ref_mismatch' };
  }
  if (
    !sameRef(input.custody.sealRecordRef, input.delivery.sealRecordRef) ||
    !sameRef(input.custody.artifactRef, input.delivery.artifactRef) ||
    input.custody.templateSnapshotHash !== input.delivery.templateSnapshotHash
  ) {
    return { reachable: false, reason: 'custody_ref_mismatch' };
  }
  // 7. Template snapshot closure: the delivery binds the FROZEN task snapshot.
  if (input.delivery.templateSnapshotHash !== input.templateSnapshotHash) {
    return { reachable: false, reason: 'template_snapshot_mismatch' };
  }
  return { reachable: true };
}

/** The coordinator's delivery-validation seam (wired by the composition root). */
export interface FinalSubmissionSeamV2 {
  validateFinalSubmission(input: FinalSubmissionValidationInputV2): Promise<FinalSubmissionReachabilityV2>;
}

/** Dependencies of the blob-resolving validator (never EventStore). */
export interface SystemArtifactDeliveryValidatorDepsV2 {
  readProjection(taskId: string): Promise<AuthoritativeReviewProjectionV2>;
  resolveBlob(taskId: string, ref: BlobRefV2): Promise<unknown>;
  /** The task-FROZEN template snapshot hash (spec §4.1 — never the catalog). */
  frozenTemplateHash(taskId: string): Promise<string>;
}

/**
 * Resolves the delivery/SealRecord/artifact/custody blobs against the projected
 * current delivery and delegates to the pure rule. Every ref is validated via
 * `parseBlob(kind, value, expectedRef)` so a "bare digest" or a blob whose bytes
 * disagree with its ref FAILS CLOSED (delivery_missing / seal_record_missing /
 * custody_ref_mismatch) — a content-addressed ref only ever satisfies the
 * closure when the exact bytes are present.
 */
export class SystemArtifactDeliveryValidatorV2 implements FinalSubmissionSeamV2 {
  constructor(private readonly deps: SystemArtifactDeliveryValidatorDepsV2) {}

  async validateFinalSubmission(input: FinalSubmissionValidationInputV2): Promise<FinalSubmissionReachabilityV2> {
    if (input.deliveryId === null) {
      return { reachable: false, reason: 'delivery_missing' };
    }
    const state = await this.deps.readProjection(input.taskId);
    const current = state.delivery;

    let delivery: SystemArtifactDeliveryV2 | null = null;
    let deliveryRef: BlobRefV2 | null = null;
    if (current !== null) {
      try {
        const raw = await this.deps.resolveBlob(input.taskId, current.deliveryRef);
        const parsed = parseBlob('system_artifact_delivery', raw, current.deliveryRef);
        delivery = parsed.object as SystemArtifactDeliveryV2;
        deliveryRef = parsed.ref;
      } catch {
        delivery = null;
        deliveryRef = null;
      }
    }

    let sealRecord: SealRecordV2 | null = null;
    if (delivery !== null) {
      try {
        const raw = await this.deps.resolveBlob(input.taskId, delivery.sealRecordRef);
        const parsed = parseBlob('seal_record', raw, delivery.sealRecordRef);
        sealRecord = parsed.object as SealRecordV2;
      } catch {
        sealRecord = null;
      }
    }

    let custody: ArtifactCustodyV2 | null = null;
    if (delivery !== null) {
      try {
        const raw = await this.deps.resolveBlob(input.taskId, delivery.custodyRef);
        const parsed = parseBlob('artifact_custody', raw, delivery.custodyRef);
        custody = parsed.object as ArtifactCustodyV2;
      } catch {
        custody = null;
      }
    }

    const sealWorkItemId = state.currentSeal?.sealWorkItemId ?? null;
    const sealWorkItem = sealWorkItemId === null ? null : (state.workItems[sealWorkItemId] ?? null);
    const currentWorkItem = state.workItems[input.workItemId] ?? null;
    const templateSnapshotHash = await this.deps.frozenTemplateHash(input.taskId);

    return deriveV2Reachability({
      deliveryId: input.deliveryId,
      current,
      delivery,
      deliveryRef,
      sealRecord,
      sealWorkItem,
      currentWorkItem,
      agentId: input.agentId,
      templateSnapshotHash,
      publishedArtifact: state.publishedArtifact === null
        ? null
        : {
            artifactRef: state.publishedArtifact.artifactRef,
            custodyRef: state.publishedArtifact.custodyRef,
            sealRecordRef: state.publishedArtifact.sealRecordRef,
            deliveryRef: state.publishedArtifact.deliveryRef,
          },
      custody,
    });
  }
}
