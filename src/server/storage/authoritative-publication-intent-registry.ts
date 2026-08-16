/**
 * Task 8 typed publication intent registry (spec §8, design §19.1).
 *
 * A CLOSED allowlist mapping every registered handler kind/version to exactly
 * one `publication_operation_payload` branch (the frozen
 * `PublicationOperationPayloadV2` union): strict payload parsing, exact
 * event-schema identity, deterministic event-envelope building, payload
 * child-ref extraction and deterministic result identity. Pins persist only
 * { handlerKind, handlerVersion, canonicalOperationPayloadRef,
 * expectedResultIdentity } — never callbacks or Agent text — and startup
 * replay resolves ONLY this allowlist and rebuilds byte-identical events.
 *
 * Resolution rules (all fail closed, never guess):
 * - unknown handler kind or version                                  -> null
 * - payload that does not parse under the closed union               -> throw
 * - parsed payload family != registration family                     -> throw
 * - registered but not rebuildable (payload lacks fields the event   -> NotRebuildableError
 *   needs for byte-identical rebuild) — listed in `missingInputs`
 *
 * The state-only families (lease_or_retry, lifecycle, question, recovery,
 * delete) and the artifact_publish version-allocation family are registered
 * NOW. Task 10 extended the `PublicationOperationPayloadV2` union (exact
 * runtime lease/retry/lifecycle fields) so EVERY workitem state-machine
 * mutation the coordinator commits — create/lease/retryable-failure/requeue/
 * reclaim/park plus lifecycle stop/resume/manual_retry — is byte-identically
 * rebuildable through this allowlist. `question` (answer delivery), `recovery`
 * and `delete` remain non-rebuildable Task 11+ burdens. Later tasks extend
 * the allowlist through `registerPublicationIntent`, never by runtime payload
 * content.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../structured-slots/canonical-json';
import { parsePublicationOperationPayload } from '../authoritative-review/object-schema-parsers-3';
import { completionKindRequiresResult } from '../authoritative-review/authority-types';
import type {
  PublicationOperationPayloadV2,
  WorkItemReclaimReasonV2,
  WorkItemSuspensionReasonV2,
  SealValidationBundleV2,
  ArtifactCustodyV2,
  MapSnapshotV2,
  ContentRevisionManifestV2,
  ReviewBundleV2,
  WriteGrantSpecV2,
  AuthorityBaseSetV2,
} from '../authoritative-review/authority-types';
import type {
  WorkItemKindV2,
  SealRecordV2,
  SystemArtifactDeliveryV2,
  BlobRefV2,
} from '../../shared/authoritative-review-v2';
import type { AuthoritativeReviewEventV2 } from './authoritative-review-events';
import type { TaskEvent } from './task-events';

/**
 * Standard legacy display-node helper: the shared EventNode body every legacy
 * `human_requested`/`human_answered` companion carries (design §17.3 public
 * display events). Sequence comes from the payload's expectedLastSequence
 * (the DETERMINISTIC batch position — the node sequence equals the current
 * tail + 1, the first event of the batch).
 */
function legacyDisplayNode(agentId: string, title: string, body: string, sequence: number, kind: 'human_request' | 'human_answer'): Extract<TaskEvent, { type: 'human_requested' }>['node'] {
  return {
    sequence,
    agentId,
    kind,
    title,
    body,
    status: 'confirmed',
    attemptCount: 1,
    inputVersion: null,
  };
}

/** An event envelope before the facade stamps the deterministic id. */
export type AuthoritativeReviewEventEnvelopeV2 =
  AuthoritativeReviewEventV2 extends infer _Self
    ? _Self extends AuthoritativeReviewEventV2
      ? Omit<_Self, 'id'>
      : never
    : never;

/**
 * Task 11: a v2 atomic batch MAY legally carry a small set of LEGACY
 * companion events (the shared frozen TaskEvent union always accepted them
 * beside v2 members — the fold skips non-v2 members). The v2 START envelope
 * carries `task_started`, the composed STOP envelope carries `task_stopped`
 * / `task_interrupted`, and the question OPEN/ANSWER envelopes carry the
 * public `human_requested`/`human_answered` display events (§17.2/§17.3). The
 * facade validates every envelope through the same `validateTaskEvent`.
 */
export type PublicationEventEnvelopeV2 =
  | AuthoritativeReviewEventEnvelopeV2
  | Omit<TaskEvent & { at: string }, 'id'>;

/** The exact closed publication payload families (design §19.1, frozen union). */
export type PublicationPayloadFamilyV2 =
  | 'domain_publish'
  | 'lease_or_retry'
  | 'lifecycle'
  | 'question'
  | 'recovery'
  | 'delete'
  | 'artifact_publish'
  | 'seal_publish';

/**
 * The pin-persisted publication intent (design §19.1 exact shape). Startup
 * replay resolves handler kind/version against the registry and the payload
 * ref; the expected result identity is re-verified by the deterministic
 * builder.
 */
export interface PublicationIntentV2 {
  handlerKind: string;
  handlerVersion: number;
  canonicalOperationPayloadRef: BlobRefV2;
  expectedResultIdentity: string;
}

/** Typed error: a registered handler cannot rebuild its event byte-identically. */
export class NotRebuildableError extends Error {
  readonly handlerKind: string;

  readonly missingInputs: readonly string[];

  constructor(handlerKind: string, missingInputs: readonly string[]) {
    super(
      `publication handler '${handlerKind}' cannot rebuild its event envelope byte-identically: missing inputs ${missingInputs.join(
        ', ',
      )}`,
    );
    this.name = 'NotRebuildableError';
    this.handlerKind = handlerKind;
    this.missingInputs = missingInputs;
  }
}

/** A ref the builder needs resolved from the pin's prepared refs, keyed by name. */
export interface PublicationIntentResolvedRef {
  key: string;
  ref: BlobRefV2;
}

/** Build context for deterministic event-envelope construction. */
/**
 * One closed registration: handler kind/version -> exactly one payload family
 * and one event schema. `buildEvents` is a pure deterministic function of the
 * payload (and pinned refs) — the same inputs always produce the same event
 * bytes, which is what makes crashed-pin replay byte-identical.
 */
export interface PublicationIntentRegistrationV2 {
  handlerKind: string;
  handlerVersion: number;
  payloadFamily: PublicationPayloadFamilyV2;
  /** Exact event types the builder may produce; anything else fails closed. */
  expectedEventTypes: readonly string[];
  /** True when `buildEvents` can rebuild byte-identically from the payload. */
  rebuildable: boolean;
  /** Why a non-rebuildable handler cannot rebuild (for diagnostics). */
  missingInputs: readonly string[];
  /** Strict closed-union payload parser. */
  parsePayload(value: unknown): PublicationOperationPayloadV2;
  /** Child refs of the publication payload itself (exact per family). */
  childRefsOf(payload: PublicationOperationPayloadV2): readonly BlobRefV2[];
  /** Pin refs the builder needs resolved (subset of the prepared refs). */
  resolveRefs(payload: PublicationOperationPayloadV2): readonly PublicationIntentResolvedRef[];
  /**
   * Deterministic event-envelope construction. `at` is the pin-frozen event
   * timestamp; `refs` are the pin refs resolved by `resolveRefs` (some
   * builders derive event fields from pinned blob content). Envelopes carry
   * `at` but no `id` — the facade stamps ids via `deterministicEventId`, so a
   * crashed pin replays the exact bytes the original committer produced.
   * Throws `NotRebuildableError` when the payload cannot be rebuilt.
   */
  buildEvents(
    payload: PublicationOperationPayloadV2,
    at: string,
    refs?: ReadonlyMap<string, unknown>,
  ): readonly PublicationEventEnvelopeV2[];
  /** Deterministic identity of the committed result (events INCLUDING ids). */
  expectedResultIdentity(
    payload: PublicationOperationPayloadV2,
    events: readonly (AuthoritativeReviewEventV2 | TaskEvent)[],
  ): string;
}

/**
 * Deterministic filename-safe event id (spec §9.1): function of operation
 * identity + handler + index only, so a crashed pin replays the exact bytes
 * the original committer would have produced. `evt-` + 32 hex chars.
 */
export function deterministicEventId(operationId: string, handlerKind: string, index: number): string {
  const digest = createHash('sha256')
    .update(canonicalJson({ handlerKind, operationId, index }), 'utf8')
    .digest('hex');
  return `evt-${digest.slice(0, 32)}`;
}

function sha256OfEvents(events: readonly (AuthoritativeReviewEventV2 | TaskEvent)[]): string {
  return createHash('sha256').update(canonicalJson(events), 'utf8').digest('hex');
}

/**
 * Ref identity: the full frozen ref bytes (content address + schema) must
 * match. A bare-digest comparison would pass a ref whose kind/media/schema
 * disagree, which is exactly the "schema-legal but inconsistent" case the
 * closure validation exists to reject.
 */
function sameRef(a: BlobRefV2 | null | undefined, b: BlobRefV2 | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return (
    a.kind === b.kind &&
    a.digest === b.digest &&
    a.byteLength === b.byteLength &&
    a.mediaType === b.mediaType &&
    a.schemaVersion === b.schemaVersion
  );
}

/** True when `v` is a well-formed BlobRefV2 (used for ref-kind-only checks). */
function isBlobRef(v: unknown): v is BlobRefV2 {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as BlobRefV2).kind === 'string' &&
    typeof (v as BlobRefV2).digest === 'string' &&
    typeof (v as BlobRefV2).byteLength === 'number' &&
    typeof (v as BlobRefV2).mediaType === 'string' &&
    typeof (v as BlobRefV2).schemaVersion === 'number'
  );
}

/**
 * Task 21 P1#3: the sealed publication's frozen closure. `system_seal_publish`
 * pins eleven refs; every one must resolve before the six-event envelope can
 * be rebuilt. Missing keys (or a non-numeric allocated version) -> the builder
 * fails closed with NotRebuildableError, so a crash-pin replay can never emit
 * an envelope from a partially-resolved object graph.
 */
function sealPublishMissingInputs(refs: ReadonlyMap<string, unknown> | undefined): readonly string[] {
  const missing: string[] = [];
  const need = (key: string): void => {
    const value = refs?.get(key);
    if (value === null || value === undefined) missing.push(key);
  };
  need('delivery');
  need('artifact');
  need('sealRecord');
  need('sealValidationBundle');
  need('custody');
  need('map');
  need('contentRevisionManifest');
  need('reviewBundle');
  need('submitterGrantSpec');
  need('submitterAuthorityBase');
  need('sealAuthorityBase');
  if (typeof refs?.get('allocatedArtifactVersion') !== 'number') missing.push('allocatedArtifactVersion');
  return missing;
}

/**
 * Task 21 P1#3: cross-object Seal/Delivery/Submitter closure validation
 * (design §16.3 / spec §13.5). Every resolved blob must agree with the pinned
 * payload refs and with each other, so a replay can never rebuild the six
 * events from an object graph that is individually schema-legal but mutually
 * inconsistent. Returns the failing check names (empty = closure is
 * consistent). All checks are pure functions of the pinned payload + resolved
 * blobs — no time, no randomness, so the rebuilt envelope stays byte-identical
 * to the original commit.
 */
function sealPublishClosureErrors(
  p: Extract<PublicationOperationPayloadV2, { family: 'seal_publish' }>,
  refs: ReadonlyMap<string, unknown>,
): readonly string[] {
  const bad: string[] = [];
  const check = (ok: boolean, name: string): void => {
    if (!ok) bad.push(name);
  };
  const delivery = refs.get('delivery') as SystemArtifactDeliveryV2;
  const artifact = refs.get('artifact') as { artifactId: string; mediaType: 'text/markdown' | 'text/plain' } | undefined;
  const sealRecord = refs.get('sealRecord') as SealRecordV2 | undefined;
  const bundle = refs.get('sealValidationBundle') as SealValidationBundleV2 | undefined;
  const custody = refs.get('custody') as ArtifactCustodyV2 | undefined;
  const map = refs.get('map') as MapSnapshotV2 | undefined;
  const manifest = refs.get('contentRevisionManifest') as ContentRevisionManifestV2 | undefined;
  const submitterGrantSpec = refs.get('submitterGrantSpec') as WriteGrantSpecV2 | undefined;
  const submitterAuthorityBase = refs.get('submitterAuthorityBase') as AuthorityBaseSetV2 | undefined;
  const sealAuthorityBase = refs.get('sealAuthorityBase') as AuthorityBaseSetV2 | undefined;

  // delivery ↔ pinned payload refs/identities (events 2/3/4).
  check(sameRef(delivery?.sealRecordRef, p.sealRecordRef), 'delivery.sealRecordRef');
  check(sameRef(delivery?.artifactRef, p.artifactRef), 'delivery.artifactRef');
  check(sameRef(delivery?.custodyRef, p.custodyRef), 'delivery.custodyRef');
  check(delivery?.sealRecordDigest === p.sealRecordRef.digest, 'delivery.sealRecordDigest');
  check(delivery?.artifactDigest === p.artifactRef.digest, 'delivery.artifactDigest');
  check(delivery?.custodyDigest === p.custodyRef.digest, 'delivery.custodyDigest');
  check(delivery?.submitterWorkItemId === p.submitterWorkItemId, 'delivery.submitterWorkItemId');
  check(
    delivery?.artifactId === artifact?.artifactId && typeof delivery?.artifactId === 'string' && delivery.artifactId.length > 0,
    'delivery.artifactId',
  );
  check(typeof delivery?.deliveryId === 'string' && delivery.deliveryId.length > 0, 'delivery.deliveryId');
  check(typeof delivery?.submitterAgentId === 'string' && delivery.submitterAgentId.length > 0, 'delivery.submitterAgentId');
  check(
    typeof delivery?.templateSnapshotHash === 'string' &&
      typeof sealRecord?.templateSnapshotHash === 'string' &&
      delivery.templateSnapshotHash === sealRecord.templateSnapshotHash,
    'delivery.templateSnapshotHash',
  );

  // sealRecord ↔ pinned payload refs/identities (event 1) + resolved map/manifest.
  check(sameRef(sealRecord?.sealValidationBundleRef, p.sealValidationBundleRef), 'sealRecord.sealValidationBundleRef');
  check(sameRef(sealRecord?.artifactRef, p.artifactRef), 'sealRecord.artifactRef');
  check(sameRef(sealRecord?.mapRef, p.mapRef), 'sealRecord.mapRef');
  check(sameRef(sealRecord?.contentRevisionManifestRef, p.contentRevisionManifestRef), 'sealRecord.contentRevisionManifestRef');
  check(sameRef(sealRecord?.reviewBundleRef, p.reviewBundleRef), 'sealRecord.reviewBundleRef');
  check(sealRecord?.artifactDigest === p.artifactRef.digest, 'sealRecord.artifactDigest');
  check(
    typeof sealRecord?.templateSnapshotHash === 'string' && sealRecord.templateSnapshotHash.length > 0,
    'sealRecord.templateSnapshotHash',
  );
  check(
    typeof sealRecord?.mapSemanticDigest === 'string' &&
      typeof map?.mapSemanticDigest === 'string' &&
      sealRecord.mapSemanticDigest === map.mapSemanticDigest,
    'sealRecord.mapSemanticDigest',
  );
  check(
    typeof sealRecord?.contentRootDigest === 'string' &&
      typeof manifest?.contentRootDigest === 'string' &&
      sealRecord.contentRootDigest === manifest.contentRootDigest,
    'sealRecord.contentRootDigest',
  );

  // sealValidationBundle ↔ pinned payload + aggregate/warning ref-kind
  // (design §16.3). The aggregate/warning blobs are NOT payload refs, so the
  // builder can only verify their declared ref-kind here (their bodies are
  // resolved by the generic blob closure elsewhere).
  check(sameRef(bundle?.artifactRef, p.artifactRef), 'bundle.artifactRef');
  check(bundle?.artifactDigest === p.artifactRef.digest, 'bundle.artifactDigest');
  check(bundle?.sealWorkItemId === p.sealWorkItemId, 'bundle.sealWorkItemId');
  check(
    isBlobRef(bundle?.sealInputAggregateRef) && bundle.sealInputAggregateRef.kind === 'validator_aggregate',
    'bundle.sealInputAggregateRef',
  );
  check(
    isBlobRef(bundle?.sealOutputAggregateRef) && bundle.sealOutputAggregateRef.kind === 'validator_aggregate',
    'bundle.sealOutputAggregateRef',
  );
  check(
    isBlobRef(bundle?.sealWarningCustodyRootRef) && bundle.sealWarningCustodyRootRef.kind === 'validation_warning_custody_root',
    'bundle.sealWarningCustodyRootRef',
  );
  check(
    typeof bundle?.assemblerDigest === 'string' && bundle.assemblerDigest.length > 0,
    'bundle.assemblerDigest',
  );
  check(
    typeof sealRecord?.assemblerDigest === 'string' && sealRecord.assemblerDigest === bundle?.assemblerDigest,
    'sealRecord.assemblerDigest',
  );

  // custody ↔ pinned payload (event 2 provenance + custody blob bindings).
  check(sameRef(custody?.artifactRef, p.artifactRef), 'custody.artifactRef');
  check(sameRef(custody?.sealRecordRef, p.sealRecordRef), 'custody.sealRecordRef');
  check(custody?.sealWorkItemId === p.sealWorkItemId, 'custody.sealWorkItemId');
  check(
    typeof custody?.templateSnapshotHash === 'string' &&
      typeof sealRecord?.templateSnapshotHash === 'string' &&
      custody.templateSnapshotHash === sealRecord.templateSnapshotHash,
    'custody.templateSnapshotHash',
  );
  check(
    Array.isArray(custody?.files) &&
      custody.files.some((entry) => entry !== null && typeof entry === 'object' && entry.name === p.artifactFile && entry.hash === p.artifactFileHash),
    'custody.files',
  );

  // artifact shape (event 2 artifactId/mediaType).
  check(
    typeof artifact?.artifactId === 'string' &&
      artifact.artifactId.length > 0 &&
      (artifact.mediaType === 'text/markdown' || artifact.mediaType === 'text/plain'),
    'artifact',
  );

  // submitter grant + authority bases (event 4 work-item bindings).
  check(submitterGrantSpec?.workItemId === p.submitterWorkItemId, 'submitterGrantSpec.workItemId');
  check(sameRef(submitterGrantSpec?.authorityBaseRef, p.submitterAuthorityBaseRef), 'submitterGrantSpec.authorityBaseRef');
  check(
    typeof submitterGrantSpec?.kind === 'string' &&
      submitterGrantSpec.kind.length > 0 &&
      typeof submitterGrantSpec?.specDigest === 'string' &&
      submitterGrantSpec.specDigest.length > 0,
    'submitterGrantSpec',
  );
  check(
    typeof submitterAuthorityBase?.baseSetDigest === 'string' && isBlobRef(submitterAuthorityBase?.templateSnapshotRef),
    'submitterAuthorityBase',
  );
  check(
    typeof sealAuthorityBase?.baseSetDigest === 'string' && isBlobRef(sealAuthorityBase?.templateSnapshotRef),
    'sealAuthorityBase',
  );

  return bad;
}

/** Strict child-ref extraction of a publication payload (all 7 families). */
export function publicationPayloadChildRefs(payload: PublicationOperationPayloadV2): readonly BlobRefV2[] {
  // Strict closed-union parse first: unparseable values never get guessed.
  const parsed = parsePublicationOperationPayload(payload);
  switch (parsed.family) {
    case 'domain_publish': {
      const refs: BlobRefV2[] = [...parsed.blobRefs];
      const mb = parsed.mapBuild;
      if (mb !== null) {
        if (mb.manifestRef !== null) refs.push(mb.manifestRef);
        if (mb.contributionManifestRef !== null) refs.push(mb.contributionManifestRef);
        if (mb.validationReceiptRef !== null) refs.push(mb.validationReceiptRef);
        if (mb.validatorAggregateRef !== null) refs.push(mb.validatorAggregateRef);
        if (mb.terminal !== null) refs.push(mb.terminal.authorityBaseRef);
        if (mb.round !== null) {
          refs.push(mb.round.candidateRef);
          if (mb.round.contentRevisionManifestRef !== null) refs.push(mb.round.contentRevisionManifestRef);
          if (mb.round.consumedOverrideRef !== null) refs.push(mb.round.consumedOverrideRef);
        }
        if (mb.successor !== null) {
          refs.push(mb.successor.authorityBaseRef, mb.successor.payloadRef);
          if (mb.successor.grantSpecRef !== null) refs.push(mb.successor.grantSpecRef);
        }
        if (mb.successorBuildStart !== null) {
          refs.push(mb.successorBuildStart.mapBuildSpecRef);
          if (mb.successorBuildStart.sourceValidationReceiptRef !== null) refs.push(mb.successorBuildStart.sourceValidationReceiptRef);
        }
      }
      const mr = parsed.mapReview;
      if (mr !== null) {
        if (mr.ledgerRef !== null) refs.push(mr.ledgerRef);
        if (mr.observations !== null) for (const o of mr.observations) refs.push(o.observationRef, ...o.childObservationRefs);
        if (mr.coverageCoreRef !== null) refs.push(mr.coverageCoreRef);
        if (mr.settlementCoreRef !== null) refs.push(mr.settlementCoreRef);
        if (mr.mapSnapshotRef !== null) refs.push(mr.mapSnapshotRef);
        if (mr.mapReviewBundleRef !== null) refs.push(mr.mapReviewBundleRef);
        if (mr.contentRevisionManifestRef !== null) refs.push(mr.contentRevisionManifestRef);
        if (mr.activationValidatorAggregateRef !== null) refs.push(mr.activationValidatorAggregateRef);
        if (mr.migrationSettlementCoreRef !== null) refs.push(mr.migrationSettlementCoreRef);
        if (mr.migrationActivationDecisionRef !== null) refs.push(mr.migrationActivationDecisionRef);
        if (mr.migrationProvisionalManifestRef !== null) refs.push(mr.migrationProvisionalManifestRef);
        if (mr.migrationFinalizerAggregateRef !== null) refs.push(mr.migrationFinalizerAggregateRef);
        if (mr.migrationFindingOpenings !== null) for (const fo of mr.migrationFindingOpenings) refs.push(fo.findingRef);
        if (mr.producerPlanSpecRef !== null) refs.push(mr.producerPlanSpecRef);
        if (mr.priorManifestRef !== null) refs.push(mr.priorManifestRef);
        if (mr.terminal !== null) refs.push(mr.terminal.authorityBaseRef);
        if (mr.successor !== null) {
          refs.push(mr.successor.authorityBaseRef, mr.successor.payloadRef);
          if (mr.successor.grantSpecRef !== null) refs.push(mr.successor.grantSpecRef);
        }
        if (mr.contentRound !== null) {
          refs.push(mr.contentRound.mapRef, mr.contentRound.contentRevisionManifestRef, mr.contentRound.adoptionRootRef);
          if (mr.contentRound.consumedOverrideRef !== null) refs.push(mr.contentRound.consumedOverrideRef);
        }
        if (mr.reviewWorkItems !== null) {
          for (const s of mr.reviewWorkItems) {
            refs.push(s.authorityBaseRef, s.payloadRef);
            if (s.grantSpecRef !== null) refs.push(s.grantSpecRef);
          }
        }
        if (mr.migrationProgress !== null) {
          refs.push(mr.migrationProgress.planSpecRef, mr.migrationProgress.successor.authorityBaseRef, mr.migrationProgress.successor.payloadRef, mr.migrationProgress.terminal.authorityBaseRef);
          if (mr.migrationProgress.intentCoreRef !== null) refs.push(mr.migrationProgress.intentCoreRef);
          if (mr.migrationProgress.batchResultRootRef !== null) refs.push(mr.migrationProgress.batchResultRootRef);
          if (mr.migrationProgress.successor.grantSpecRef !== null) refs.push(mr.migrationProgress.successor.grantSpecRef);
        }
      }
      const cp = parsed.contentPlan;
      if (cp !== null) {
        if (cp.generationPlanSpecRef !== null) refs.push(cp.generationPlanSpecRef);
        if (cp.sourceValidationReceiptRef !== null) refs.push(cp.sourceValidationReceiptRef);
        if (cp.contentRevisionCommitCoreRef !== null) refs.push(cp.contentRevisionCommitCoreRef);
        if (cp.validatorAggregateRef !== null) refs.push(cp.validatorAggregateRef);
        if (cp.contentRevisionManifestRef !== null) refs.push(cp.contentRevisionManifestRef);
        if (cp.producerPlanSpecRef !== null) refs.push(cp.producerPlanSpecRef);
        if (cp.priorManifestRef !== null) refs.push(cp.priorManifestRef);
        if (cp.successor !== null) {
          refs.push(cp.successor.authorityBaseRef, cp.successor.payloadRef);
          if (cp.successor.grantSpecRef !== null) refs.push(cp.successor.grantSpecRef);
        }
        if (cp.finalizerWarningRootRef !== null) refs.push(cp.finalizerWarningRootRef);
        if (cp.reviewRound !== null) {
          refs.push(cp.reviewRound.mapRef, cp.reviewRound.contentRevisionManifestRef, cp.reviewRound.adoptionRootRef);
          if (cp.reviewRound.consumedOverrideRef !== null) refs.push(cp.reviewRound.consumedOverrideRef);
        }
        if (cp.reviewWorkItems !== null) {
          for (const s of cp.reviewWorkItems) {
            refs.push(s.authorityBaseRef, s.payloadRef);
            if (s.grantSpecRef !== null) refs.push(s.grantSpecRef);
          }
        }
        if (cp.validationReceiptRef !== null) refs.push(cp.validationReceiptRef);
        if (cp.successorPlanRef !== null) refs.push(cp.successorPlanRef);
        if (cp.terminal !== null) refs.push(cp.terminal.authorityBaseRef);
      }
      const cr = parsed.contentReview;
      if (cr !== null) {
        if (cr.ledgerRef !== null) refs.push(cr.ledgerRef);
        if (cr.observations !== null) for (const o of cr.observations) refs.push(o.observationRef, ...o.childObservationRefs);
        if (cr.findingOpenings !== null) for (const fo of cr.findingOpenings) refs.push(fo.findingRef);
        if (cr.coverageCoreRef !== null) refs.push(cr.coverageCoreRef);
        if (cr.roundPlanned !== null) {
          refs.push(cr.roundPlanned.mapRef, cr.roundPlanned.contentRevisionManifestRef, cr.roundPlanned.adoptionRootRef);
          if (cr.roundPlanned.consumedOverrideRef !== null) refs.push(cr.roundPlanned.consumedOverrideRef);
        }
        if (cr.reviewWorkItems !== null) {
          for (const s of cr.reviewWorkItems) {
            refs.push(s.authorityBaseRef, s.payloadRef);
            if (s.grantSpecRef !== null) refs.push(s.grantSpecRef);
          }
        }
        if (cr.settlementCoreRef !== null) refs.push(cr.settlementCoreRef);
        if (cr.reviewBundleRef !== null) refs.push(cr.reviewBundleRef);
        if (cr.reviewWarningCustodyRootRef !== null) refs.push(cr.reviewWarningCustodyRootRef);
        if (cr.mapRef !== null) refs.push(cr.mapRef);
        if (cr.contentRevisionManifestRef !== null) refs.push(cr.contentRevisionManifestRef);
        if (cr.reviewSettlementValidatorAggregateRef !== null) refs.push(cr.reviewSettlementValidatorAggregateRef);
        if (cr.sealAuthorityBaseRef !== null) refs.push(cr.sealAuthorityBaseRef);
        if (cr.successor !== null) {
          refs.push(cr.successor.authorityBaseRef, cr.successor.payloadRef);
          if (cr.successor.grantSpecRef !== null) refs.push(cr.successor.grantSpecRef);
        }
        if (cr.terminal !== null) refs.push(cr.terminal.authorityBaseRef);
      }
      const rp = parsed.repair;
      if (rp !== null) {
        if (rp.repairPlanSpecRef !== null) refs.push(rp.repairPlanSpecRef);
        if (rp.sourceValidationReceiptRef !== null) refs.push(rp.sourceValidationReceiptRef);
        if (rp.stagingRootRef !== null) refs.push(rp.stagingRootRef);
        if (rp.validatorAggregateRef !== null) refs.push(rp.validatorAggregateRef);
        if (rp.validationReceiptRef !== null) refs.push(rp.validationReceiptRef);
        if (rp.successorPlanSpecRef !== null) refs.push(rp.successorPlanSpecRef);
        if (rp.contentRevisionManifestRef !== null) refs.push(rp.contentRevisionManifestRef);
        if (rp.priorManifestRef !== null) refs.push(rp.priorManifestRef);
        if (rp.repairBuildStart !== null) {
          refs.push(rp.repairBuildStart.mapBuildSpecRef);
          if (rp.repairBuildStart.sourceValidationReceiptRef !== null) refs.push(rp.repairBuildStart.sourceValidationReceiptRef);
        }
        if (rp.mapBuildManifestRef !== null) refs.push(rp.mapBuildManifestRef);
        if (rp.contributionManifestRef !== null) refs.push(rp.contributionManifestRef);
        if (rp.candidateRef !== null) refs.push(rp.candidateRef);
        if (rp.mapRound !== null) {
          refs.push(rp.mapRound.candidateRef);
          if (rp.mapRound.contentRevisionManifestRef !== null) refs.push(rp.mapRound.contentRevisionManifestRef);
          if (rp.mapRound.consumedOverrideRef !== null) refs.push(rp.mapRound.consumedOverrideRef);
        }
        if (rp.contentRound !== null) {
          refs.push(rp.contentRound.mapRef, rp.contentRound.contentRevisionManifestRef, rp.contentRound.adoptionRootRef);
          if (rp.contentRound.consumedOverrideRef !== null) refs.push(rp.contentRound.consumedOverrideRef);
        }
        if (rp.reviewWorkItems !== null) {
          for (const s of rp.reviewWorkItems) {
            refs.push(s.authorityBaseRef, s.payloadRef);
            if (s.grantSpecRef !== null) refs.push(s.grantSpecRef);
          }
        }
        if (rp.overrideTransfer !== null) refs.push(rp.overrideTransfer.overrideRef, rp.overrideTransfer.fromRepairPlanRef, rp.overrideTransfer.toRepairPlanRef);
        if (rp.successor !== null) {
          refs.push(rp.successor.authorityBaseRef, rp.successor.payloadRef);
          if (rp.successor.grantSpecRef !== null) refs.push(rp.successor.grantSpecRef);
        }
        if (rp.terminal !== null) refs.push(rp.terminal.authorityBaseRef);
      }
      return refs;
    }
    case 'lease_or_retry':
      return [parsed.authorityBaseRef];
    case 'lifecycle':
      return [];
    case 'question': {
      const refs: BlobRefV2[] = [parsed.authorityBaseRef];
      if (parsed.grantSpecRef !== null) refs.push(parsed.grantSpecRef);
      if (parsed.payloadRef !== null) refs.push(parsed.payloadRef);
      return refs;
    }
    case 'recovery': {
      const refs: BlobRefV2[] = [parsed.failureRecoveryPayloadRef];
      if (parsed.overrideRef !== null) {
        refs.push(parsed.overrideRef);
      }
      return refs;
    }
    case 'delete':
      return [];
    case 'artifact_publish':
      return [parsed.artifactRef, parsed.sealRecordRef, parsed.deliveryRef];
    case 'seal_publish':
      return [
        parsed.artifactRef,
        parsed.sealRecordRef,
        parsed.sealValidationBundleRef,
        parsed.deliveryRef,
        parsed.custodyRef,
        parsed.mapRef,
        parsed.contentRevisionManifestRef,
        parsed.reviewBundleRef,
        parsed.sealAuthorityBaseRef,
        parsed.submitterAuthorityBaseRef,
        parsed.submitterGrantSpecRef,
      ];
  }
}

/**
 * The closed registry. Later tasks add handlers through `register`; the
 * module-level singleton (`PUBLICATION_INTENT_REGISTRY_V2`) is the runtime
 * allowlist, and fresh instances are for tests/qualification.
 */
export class PublicationIntentRegistry {
  private readonly registrations = new Map<string, PublicationIntentRegistrationV2>();

  constructor() {
    this.seedBuiltins();
  }

  private seedBuiltins(): void {
    this.seedLifecycle();
    this.seedLeaseOrRetry();
    this.seedQuestion();
    this.seedRecovery();
    this.seedDelete();
    this.seedArtifactPublish();
    this.seedSealPublish();
  }

  /** Explicit registration API: duplicate handler kind/version is a program error. */
  register(registration: PublicationIntentRegistrationV2): void {
    const key = `${registration.handlerKind}@${registration.handlerVersion}`;
    if (this.registrations.has(key)) {
      throw new Error(
        `publication intent handler '${registration.handlerKind}' v${registration.handlerVersion} is already registered`,
      );
    }
    this.registrations.set(key, registration);
  }

  /** Allowlist-only resolution; null for unknown kind/version. */
  resolve(handlerKind: string, handlerVersion: number): PublicationIntentRegistrationV2 | null {
    return this.registrations.get(`${handlerKind}@${handlerVersion}`) ?? null;
  }

  private seedLifecycle(): void {
    const family: PublicationPayloadFamilyV2 = 'lifecycle';
    const childRefs = (parsed: PublicationOperationPayloadV2): readonly BlobRefV2[] => {
      if (parsed.family !== 'lifecycle') return [];
      const refs: BlobRefV2[] = [];
      if (parsed.authorityBaseRef !== null) refs.push(parsed.authorityBaseRef);
      if (parsed.grantSpecRef !== null) refs.push(parsed.grantSpecRef);
      if (parsed.payloadRef !== null) refs.push(parsed.payloadRef);
      if (parsed.sourceValidationReceiptRef !== null) refs.push(parsed.sourceValidationReceiptRef);
      return refs;
    };
    const resolveRefs = (): readonly PublicationIntentResolvedRef[] => [];
    /**
     * Task 11 (constraint A round 2): the stop builder is the FULL §17.3
     * composition when the payload carries the reclaim carriers (the v2
     * lifecycle service composes [abandon, reclaim, task_stopped,
     * suspension_applied] in ONE batch); the Task 10 overlay-only seed (a
     * `workItemId:null` payload) keeps producing exactly the single overlay
     * event, so applySuspension bytes are unchanged.
     */
    this.register({
      handlerKind: 'lifecycle/stop',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: [
        'structured_agent_attempt_abandoned_v2',
        'structured_generic_agent_attempt_abandoned',
        'structured_system_command_abandoned',
        'structured_work_item_lease_reclaimed',
        'task_stopped',
        'task_interrupted',
        'structured_task_suspension_applied_v2',
      ],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
      resolveRefs,
      buildEvents: (payload, at) => {
        const p = payload as Extract<PublicationOperationPayloadV2, { family: 'lifecycle' }>;
        if (p.suspensionId === null) {
          throw new NotRebuildableError('lifecycle/stop', [
            'suspensionId must name the suspension for byte-identical rebuild',
          ]);
        }
        if (p.kind !== 'stop') {
          throw new NotRebuildableError('lifecycle/stop', [`payload kind '${p.kind}' is not stop`]);
        }
        const reason = p.reason ?? 'user_stop';
        const composed = p.workItemId !== null || p.attemptFamily !== null;
        const envelopes: PublicationEventEnvelopeV2[] = [];
        if (composed) {
          const missing: string[] = [];
          const need = (value: unknown, name: string): void => {
            if (value === null || value === undefined) missing.push(name);
          };
          need(p.workItemId, 'workItemId');
          need(p.leaseEpoch, 'leaseEpoch');
          need(p.authorityBaseRef, 'authorityBaseRef');
          need(p.attemptFamily, 'attemptFamily');
          if (p.attemptFamily === 'structured') {
            need(p.attemptId, 'attemptId');
            need(p.logicalAssignmentId, 'logicalAssignmentId');
            need(p.sessionKind, 'sessionKind');
          } else if (p.attemptFamily === 'generic') {
            need(p.attemptId, 'attemptId');
            need(p.agentId, 'agentId');
            need(p.logicalAssignmentId, 'logicalAssignmentId');
            need(p.inputArtifactDeliveryId, 'inputArtifactDeliveryId');
          } else {
            need(p.commandId, 'commandId');
            need(p.commandKind, 'commandKind');
          }
          if (missing.length > 0) throw new NotRebuildableError('lifecycle/stop', missing);
          if (p.attemptFamily === 'structured') {
            envelopes.push({
              protocolVersion: 2,
              at,
              type: 'structured_agent_attempt_abandoned_v2',
              workItemId: p.workItemId as string,
              logicalAssignmentId: p.logicalAssignmentId as string,
              reviewAssignmentId: p.reviewAssignmentId,
              attemptId: p.attemptId as string,
              sessionKind: p.sessionKind as NonNullable<Extract<PublicationOperationPayloadV2, { family: 'lifecycle' }>['sessionKind']>,
              leaseEpoch: p.leaseEpoch as number,
              reason,
              authorityBaseRef: p.authorityBaseRef as BlobRefV2,
            });
          } else if (p.attemptFamily === 'generic') {
            envelopes.push({
              protocolVersion: 2,
              at,
              type: 'structured_generic_agent_attempt_abandoned',
              attemptId: p.attemptId as string,
              workItemId: p.workItemId as string,
              agentId: p.agentId as string,
              logicalAssignmentId: p.logicalAssignmentId as string,
              leaseEpoch: p.leaseEpoch as number,
              inputArtifactDeliveryId: p.inputArtifactDeliveryId as string,
              reason,
              authorityBaseRef: p.authorityBaseRef as BlobRefV2,
            });
          } else {
            envelopes.push({
              protocolVersion: 2,
              at,
              type: 'structured_system_command_abandoned',
              commandId: p.commandId as string,
              workItemId: p.workItemId as string,
              commandKind: p.commandKind as NonNullable<Extract<PublicationOperationPayloadV2, { family: 'lifecycle' }>['commandKind']>,
              leaseEpoch: p.leaseEpoch as number,
              reason,
              authorityBaseRef: p.authorityBaseRef as BlobRefV2,
            });
          }
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_work_item_lease_reclaimed',
            workItemId: p.workItemId as string,
            leaseEpoch: p.leaseEpoch as number,
            reason,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
          envelopes.push({ at, type: reason === 'operator_interrupt' ? 'task_interrupted' : 'task_stopped' });
        }
        envelopes.push({
          protocolVersion: 2,
          at,
          type: 'structured_task_suspension_applied_v2',
          suspensionId: p.suspensionId,
          // Task 10 extension: the payload may name the interrupt reason; the
          // Task 8 default (payloads without the field) stays user_stop.
          reason,
          operationId: p.operationId,
        });
        return envelopes;
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });
    /**
     * Task 11 (constraint A round 2): the ONE-BATCH v2 START (design §17.2) —
     * `task_started` + `structured_map_build_started` + the first
     * structure-chunk `structured_work_item_created` with AuthorityBase and
     * initial_structure_chunk WriteGrantSpec pinned in the SAME publication.
     * No legacy `agent_input` is ever seeded by v2 (the new build has no v1
     * input node).
     */
    this.register({
      handlerKind: 'lifecycle/start_task',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: ['task_started', 'structured_map_build_started', 'structured_work_item_created'],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
      resolveRefs,
      buildEvents: (payload, at) => {
        const p = payload as Extract<PublicationOperationPayloadV2, { family: 'lifecycle' }>;
        if (p.kind !== 'start') {
          throw new NotRebuildableError('lifecycle/start_task', [`payload kind '${p.kind}' is not start`]);
        }
        const missing: string[] = [];
        const need = (value: unknown, name: string): void => {
          if (value === null || value === undefined) missing.push(name);
        };
        need(p.workItemId, 'workItemId');
        need(p.workItemKind, 'workItemKind');
        need(p.roleBinding, 'roleBinding');
        need(p.sessionKind, 'sessionKind');
        need(p.logicalAssignmentId, 'logicalAssignmentId');
        need(p.grantSpecRef, 'grantSpecRef');
        need(p.payloadRef, 'payloadRef');
        need(p.initialLeaseEpoch, 'initialLeaseEpoch');
        need(p.maxAutomaticRetries, 'maxAutomaticRetries');
        need(p.mapBuildId, 'mapBuildId');
        need(p.authorityBaseRef, 'authorityBaseRef');
        if (missing.length > 0) throw new NotRebuildableError('lifecycle/start_task', missing);
        return [
          { at, type: 'task_started' },
          {
            protocolVersion: 2,
            at,
            type: 'structured_map_build_started',
            mapBuildId: p.mapBuildId as string,
            revision: 1,
            mapBuildSpecRef: p.payloadRef as BlobRefV2,
            supersedesMapBuildId: p.supersedesMapBuildId,
            sourceValidationReceiptRef: p.sourceValidationReceiptRef,
          },
          {
            protocolVersion: 2,
            at,
            type: 'structured_work_item_created',
            workItemId: p.workItemId as string,
            kind: p.workItemKind as WorkItemKindV2,
            roleBinding: p.roleBinding,
            agentExecutionKind: p.agentExecutionKind ?? null,
            sessionKind: p.sessionKind as NonNullable<Extract<PublicationOperationPayloadV2, { family: 'lifecycle' }>['sessionKind']>,
            roundId: p.roundId ?? null,
            logicalAssignmentId: p.logicalAssignmentId as string,
            reviewAssignmentId: p.reviewAssignmentId ?? null,
            grantSpecRef: p.grantSpecRef,
            inputArtifactDeliveryId: p.inputArtifactDeliveryId ?? null,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
            payloadRef: p.payloadRef as BlobRefV2,
            initialLeaseEpoch: p.initialLeaseEpoch as number,
            maxAutomaticRetries: p.maxAutomaticRetries as number,
          },
        ];
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });
    this.register({
      handlerKind: 'lifecycle/resume',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: ['structured_task_suspension_cleared_v2'],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
      resolveRefs,
      buildEvents: (payload, at) => {
        const p = payload as Extract<PublicationOperationPayloadV2, { family: 'lifecycle' }>;
        if (p.suspensionId === null) {
          throw new NotRebuildableError('lifecycle/resume', [
            'suspensionId must name the suspension for byte-identical rebuild',
          ]);
        }
        if (p.kind !== 'resume') {
          throw new NotRebuildableError('lifecycle/resume', [`payload kind '${p.kind}' is not resume`]);
        }
        return [
          {
            protocolVersion: 2,
            at,
            type: 'structured_task_suspension_cleared_v2',
            suspensionId: p.suspensionId,
            operationId: p.operationId,
          },
        ];
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });
    // Task 10: the v2 manual-retry command (spec §10.3 / design §17.2) — the
    // ONLY command that clears a retry_budget_exhausted park.
    this.register({
      handlerKind: 'lifecycle/manual_retry',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: ['structured_task_retry_resumed_v2'],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
      resolveRefs,
      buildEvents: (payload, at) => {
        const p = payload as Extract<PublicationOperationPayloadV2, { family: 'lifecycle' }>;
        if (p.kind !== 'manual_retry') {
          throw new NotRebuildableError('lifecycle/manual_retry', [`payload kind '${p.kind}' is not manual_retry`]);
        }
        const missing: string[] = [];
        if (p.workItemId === null) missing.push('workItemId');
        if (p.leaseEpoch === null) missing.push('leaseEpoch');
        if (p.expectedLastSequence === null) missing.push('expectedLastSequence');
        if (p.authorityBaseRef === null) missing.push('authorityBaseRef');
        if (missing.length > 0) {
          throw new NotRebuildableError('lifecycle/manual_retry', missing);
        }
        return [
          {
            protocolVersion: 2,
            at,
            type: 'structured_task_retry_resumed_v2',
            workItemId: p.workItemId as string,
            leaseEpoch: p.leaseEpoch as number,
            expectedLastSequence: p.expectedLastSequence as number,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          },
        ];
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });
  }

  /** Task 10 rebuilt lease/retry family: EVERY member is now byte-rebuildable. */
  private seedLeaseOrRetry(): void {
    const family: PublicationPayloadFamilyV2 = 'lease_or_retry';
    const childRefs = (parsed: PublicationOperationPayloadV2): readonly BlobRefV2[] => {
      if (parsed.family !== 'lease_or_retry') return [];
      const refs: BlobRefV2[] = [parsed.authorityBaseRef];
      if (parsed.dispatchRef !== null) refs.push(parsed.dispatchRef);
      if (parsed.grantInstanceRef !== null) refs.push(parsed.grantInstanceRef);
      if (parsed.validatorAggregateRef !== null) refs.push(parsed.validatorAggregateRef);
      for (const resultRef of parsed.resultRefs) refs.push(resultRef);
      return refs;
    };
    const resolveRefs = (): readonly PublicationIntentResolvedRef[] => [];
    type LeaseOrRetryPayload = Extract<PublicationOperationPayloadV2, { family: 'lease_or_retry' }>;
    // The facade re-parses every payload under the closed union and verifies
    // the family before buildEvents runs; the builder re-verifies the exact
    // eventBuilder and fails closed (NotRebuildableError) on anything else.
    const lease = (p: PublicationOperationPayloadV2): LeaseOrRetryPayload => {
      if (p.family !== 'lease_or_retry') {
        throw new NotRebuildableError('lease_or_retry', [`payload family '${p.family}' is not lease_or_retry`]);
      }
      return p;
    };

    // work_item_created
    this.register({
      handlerKind: 'work_item_created',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: ['structured_work_item_created'],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
      resolveRefs,
      buildEvents: (payload, at) => {
        const p = lease(payload);
        const missing: string[] = [];
        if (p.eventBuilder !== 'work_item_created') missing.push('eventBuilder');
        if (p.kind === null) missing.push('kind');
        if (p.payloadRef === null) missing.push('payloadRef');
        if (p.maxAutomaticRetries === null) missing.push('maxAutomaticRetries');
        if (missing.length > 0) throw new NotRebuildableError('work_item_created', missing);
        return [
          {
            protocolVersion: 2,
            at,
            type: 'structured_work_item_created',
            workItemId: p.workItemId as string,
            kind: p.kind as WorkItemKindV2,
            roleBinding: p.roleBinding,
            agentExecutionKind: p.agentExecutionKind,
            sessionKind: p.sessionKind,
            roundId: p.roundId,
            logicalAssignmentId: p.logicalAssignmentId as string,
            reviewAssignmentId: p.reviewAssignmentId,
            grantSpecRef: p.grantSpecRef,
            inputArtifactDeliveryId: p.inputArtifactDeliveryId as string,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
            payloadRef: p.payloadRef as BlobRefV2,
            initialLeaseEpoch: p.initialLeaseEpoch ?? 0,
            maxAutomaticRetries: p.maxAutomaticRetries as number,
          },
        ];
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });

    // work_item_leased — the full §9.2 envelope: lease + dispatch + attempt/command start.
    this.register({
      handlerKind: 'work_item_leased',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: [
        'structured_work_item_leased',
        'structured_assignment_dispatched',
        'structured_agent_attempt_started_v2',
        'structured_generic_agent_attempt_started',
        'structured_system_command_started',
      ],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
      resolveRefs,
      buildEvents: (payload, at) => {
        const p = lease(payload);
        if (p.eventBuilder !== 'work_item_leased') {
          throw new NotRebuildableError('work_item_leased', ['eventBuilder']);
        }
        // §9.2: a lease with NO execution carrier is a projector-legal half
        // state from which no later reclaim can ever succeed
        // (attempt_not_abandoned) — the admission surface must reject it here.
        if (p.attemptFamily === null) {
          throw new NotRebuildableError('work_item_leased', [
            'attemptFamily must name the execution carrier (structured|generic|command)',
          ]);
        }
        const missing: string[] = [];
        if (p.leaseOwner === null) missing.push('leaseOwner');
        if (p.leaseExpiresAt === null) missing.push('leaseExpiresAt');
        if (p.expectedLastSequence === null) missing.push('expectedLastSequence');
        if (p.attemptFamily === 'structured' || p.attemptFamily === 'generic') {
          if (p.dispatchRef === null) missing.push('dispatchRef');
          if (p.attemptId === null) missing.push('attemptId');
          if (p.logicalAssignmentId === null) missing.push('logicalAssignmentId');
          if (p.attemptFamily === 'structured' && p.sessionKind === null) missing.push('sessionKind');
          if (p.attemptFamily === 'generic') {
            if (p.agentId === null) missing.push('agentId');
            if (p.inputArtifactDeliveryId === null) missing.push('inputArtifactDeliveryId');
          }
        } else if (p.attemptFamily === 'command') {
          if (p.commandId === null) missing.push('commandId');
          if (p.commandKind === null) missing.push('commandKind');
        }
        if (missing.length > 0) throw new NotRebuildableError('work_item_leased', missing);
        const envelopes: AuthoritativeReviewEventEnvelopeV2[] = [
          {
            protocolVersion: 2,
            at,
            type: 'structured_work_item_leased',
            workItemId: p.workItemId as string,
            leaseEpoch: p.leaseEpoch as number,
            leaseOwner: p.leaseOwner as string,
            leaseExpiresAt: p.leaseExpiresAt as string,
            expectedLastSequence: p.expectedLastSequence as number,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          },
        ];
        if (p.attemptFamily === 'structured' || p.attemptFamily === 'generic') {
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_assignment_dispatched',
            dispatchRef: p.dispatchRef as BlobRefV2,
            workItemId: p.workItemId as string,
            attemptId: p.attemptId as string,
            logicalAssignmentId: p.logicalAssignmentId as string,
            reviewAssignmentId: p.reviewAssignmentId,
            agentExecutionKind: p.attemptFamily === 'generic' ? 'generic_turn' : 'structured_session',
            sessionKind: p.sessionKind,
            inputArtifactDeliveryId: p.inputArtifactDeliveryId as string,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
          if (p.attemptFamily === 'structured') {
            envelopes.push({
              protocolVersion: 2,
              at,
              type: 'structured_agent_attempt_started_v2',
              workItemId: p.workItemId as string,
              logicalAssignmentId: p.logicalAssignmentId as string,
              reviewAssignmentId: p.reviewAssignmentId,
              attemptId: p.attemptId as string,
              sessionKind: p.sessionKind as NonNullable<LeaseOrRetryPayload['sessionKind']>,
              leaseEpoch: p.leaseEpoch as number,
              authorityBaseRef: p.authorityBaseRef as BlobRefV2,
            });
          } else {
            envelopes.push({
              protocolVersion: 2,
              at,
              type: 'structured_generic_agent_attempt_started',
              attemptId: p.attemptId as string,
              workItemId: p.workItemId as string,
              agentId: p.agentId as string,
              logicalAssignmentId: p.logicalAssignmentId as string,
              leaseEpoch: p.leaseEpoch as number,
              inputArtifactDeliveryId: p.inputArtifactDeliveryId as string,
              authorityBaseRef: p.authorityBaseRef as BlobRefV2,
            });
          }
        } else if (p.attemptFamily === 'command') {
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_system_command_started',
            commandId: p.commandId as string,
            workItemId: p.workItemId as string,
            commandKind: p.commandKind as NonNullable<LeaseOrRetryPayload['commandKind']>,
            leaseEpoch: p.leaseEpoch as number,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
        }
        return envelopes;
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });

    // work_item_retryable_failed — attempt/command failure + workitem record.
    this.register({
      handlerKind: 'work_item_retryable_failed',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: [
        'structured_agent_attempt_retryable_failed_v2',
        'structured_generic_agent_attempt_retryable_failed',
        'structured_system_command_retryable_failed',
        'structured_work_item_retryable_failed',
      ],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
      resolveRefs,
      buildEvents: (payload, at) => {
        const p = lease(payload);
        if (p.eventBuilder !== 'work_item_retryable_failed') {
          throw new NotRebuildableError('work_item_retryable_failed', ['eventBuilder']);
        }
        if (p.attemptFamily === null) {
          throw new NotRebuildableError('work_item_retryable_failed', [
            'attemptFamily must name the execution carrier (structured|generic|command)',
          ]);
        }
        const missing: string[] = [];
        if (p.failureCode === null) missing.push('failureCode');
        if (p.failureDigest === null) missing.push('failureDigest');
        if (p.retryOrdinal === null) missing.push('retryOrdinal');
        if (p.retryNotBefore === null) missing.push('retryNotBefore');
        if (p.maxAutomaticRetries === null) missing.push('maxAutomaticRetries');
        if (missing.length > 0) throw new NotRebuildableError('work_item_retryable_failed', missing);
        const envelopes: AuthoritativeReviewEventEnvelopeV2[] = [];
        if (p.attemptFamily === 'structured') {
          if (p.attemptId === null || p.logicalAssignmentId === null || p.sessionKind === null) {
            throw new NotRebuildableError('work_item_retryable_failed', ['attemptId, logicalAssignmentId, sessionKind']);
          }
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_agent_attempt_retryable_failed_v2',
            workItemId: p.workItemId as string,
            logicalAssignmentId: p.logicalAssignmentId as string,
            reviewAssignmentId: p.reviewAssignmentId,
            attemptId: p.attemptId as string,
            sessionKind: p.sessionKind as NonNullable<LeaseOrRetryPayload['sessionKind']>,
            leaseEpoch: p.leaseEpoch as number,
            failureCode: p.failureCode as string,
            failureDigest: p.failureDigest as string,
            retryOrdinal: p.retryOrdinal as number,
            retryNotBefore: p.retryNotBefore as string,
            validatorAggregateRef: p.validatorAggregateRef,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
        } else if (p.attemptFamily === 'generic') {
          if (p.attemptId === null || p.agentId === null || p.logicalAssignmentId === null || p.inputArtifactDeliveryId === null) {
            throw new NotRebuildableError('work_item_retryable_failed', ['attemptId, agentId, logicalAssignmentId, inputArtifactDeliveryId']);
          }
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_generic_agent_attempt_retryable_failed',
            attemptId: p.attemptId as string,
            workItemId: p.workItemId as string,
            agentId: p.agentId as string,
            logicalAssignmentId: p.logicalAssignmentId as string,
            leaseEpoch: p.leaseEpoch as number,
            inputArtifactDeliveryId: p.inputArtifactDeliveryId as string,
            failureCode: p.failureCode as string,
            failureDigest: p.failureDigest as string,
            retryOrdinal: p.retryOrdinal as number,
            retryNotBefore: p.retryNotBefore as string,
            validatorAggregateRef: p.validatorAggregateRef,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
        } else if (p.attemptFamily === 'command') {
          if (p.commandId === null || p.commandKind === null) {
            throw new NotRebuildableError('work_item_retryable_failed', ['commandId, commandKind']);
          }
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_system_command_retryable_failed',
            commandId: p.commandId as string,
            workItemId: p.workItemId as string,
            commandKind: p.commandKind,
            leaseEpoch: p.leaseEpoch as number,
            failureCode: p.failureCode as string,
            failureDigest: p.failureDigest as string,
            retryOrdinal: p.retryOrdinal as number,
            retryNotBefore: p.retryNotBefore as string,
            validatorAggregateRef: p.validatorAggregateRef,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
        }
        envelopes.push({
          protocolVersion: 2,
          at,
          type: 'structured_work_item_retryable_failed',
          workItemId: p.workItemId as string,
          leaseEpoch: p.leaseEpoch as number,
          failureCode: p.failureCode as string,
          failureDigest: p.failureDigest as string,
          retryOrdinal: p.retryOrdinal as number,
          retryNotBefore: p.retryNotBefore as string,
          maxAutomaticRetries: p.maxAutomaticRetries as number,
          validatorAggregateRef: p.validatorAggregateRef,
          authorityBaseRef: p.authorityBaseRef as BlobRefV2,
        });
        return envelopes;
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });

    // work_item_requeued — the timer-expiry CAS transition (no epoch advance).
    this.register({
      handlerKind: 'work_item_requeued',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: ['structured_work_item_requeued'],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
      resolveRefs,
      buildEvents: (payload, at) => {
        const p = lease(payload);
        if (p.eventBuilder !== 'work_item_requeued') {
          throw new NotRebuildableError('work_item_requeued', ['eventBuilder']);
        }
        if (p.expectedLastSequence === null) {
          throw new NotRebuildableError('work_item_requeued', ['expectedLastSequence']);
        }
        return [
          {
            protocolVersion: 2,
            at,
            type: 'structured_work_item_requeued',
            workItemId: p.workItemId as string,
            leaseEpoch: p.leaseEpoch as number,
            expectedLastSequence: p.expectedLastSequence as number,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          },
        ];
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });

    // work_item_lease_reclaimed — abandon first, then the reclaim (epoch rules).
    this.register({
      handlerKind: 'work_item_lease_reclaimed',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: [
        'structured_agent_attempt_abandoned_v2',
        'structured_generic_agent_attempt_abandoned',
        'structured_system_command_abandoned',
        'structured_work_item_lease_reclaimed',
      ],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
      resolveRefs,
      buildEvents: (payload, at) => {
        const p = lease(payload);
        if (p.eventBuilder !== 'work_item_lease_reclaimed') {
          throw new NotRebuildableError('work_item_lease_reclaimed', ['eventBuilder']);
        }
        if (p.reason === null) {
          throw new NotRebuildableError('work_item_lease_reclaimed', ['reason']);
        }
        if (p.attemptFamily === null) {
          throw new NotRebuildableError('work_item_lease_reclaimed', [
            'attemptFamily must name the execution carrier (structured|generic|command)',
          ]);
        }
        const envelopes: AuthoritativeReviewEventEnvelopeV2[] = [];
        if (p.attemptFamily === 'structured') {
          if (p.attemptId === null || p.logicalAssignmentId === null || p.sessionKind === null) {
            throw new NotRebuildableError('work_item_lease_reclaimed', ['attemptId, logicalAssignmentId, sessionKind']);
          }
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_agent_attempt_abandoned_v2',
            workItemId: p.workItemId as string,
            logicalAssignmentId: p.logicalAssignmentId as string,
            reviewAssignmentId: p.reviewAssignmentId,
            attemptId: p.attemptId as string,
            sessionKind: p.sessionKind as NonNullable<LeaseOrRetryPayload['sessionKind']>,
            leaseEpoch: p.leaseEpoch as number,
            reason: p.reason as WorkItemReclaimReasonV2,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
        } else if (p.attemptFamily === 'generic') {
          if (p.attemptId === null || p.agentId === null || p.logicalAssignmentId === null || p.inputArtifactDeliveryId === null) {
            throw new NotRebuildableError('work_item_lease_reclaimed', ['attemptId, agentId, logicalAssignmentId, inputArtifactDeliveryId']);
          }
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_generic_agent_attempt_abandoned',
            attemptId: p.attemptId as string,
            workItemId: p.workItemId as string,
            agentId: p.agentId as string,
            logicalAssignmentId: p.logicalAssignmentId as string,
            leaseEpoch: p.leaseEpoch as number,
            inputArtifactDeliveryId: p.inputArtifactDeliveryId as string,
            reason: p.reason as WorkItemReclaimReasonV2,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
        } else if (p.attemptFamily === 'command') {
          if (p.commandId === null || p.commandKind === null) {
            throw new NotRebuildableError('work_item_lease_reclaimed', ['commandId, commandKind']);
          }
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_system_command_abandoned',
            commandId: p.commandId as string,
            workItemId: p.workItemId as string,
            commandKind: p.commandKind,
            leaseEpoch: p.leaseEpoch as number,
            reason: p.reason as WorkItemReclaimReasonV2,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
        }
        envelopes.push({
          protocolVersion: 2,
          at,
          type: 'structured_work_item_lease_reclaimed',
          workItemId: p.workItemId as string,
          leaseEpoch: p.leaseEpoch as number,
          reason: p.reason as WorkItemReclaimReasonV2,
          authorityBaseRef: p.authorityBaseRef as BlobRefV2,
        });
        return envelopes;
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });

    // work_item_parked — budget exhaustion: attempt/command TERMINAL first,
    // then the retry_budget_exhausted park (the only legal exhausted shape).
    this.register({
      handlerKind: 'work_item_parked',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: [
        'structured_agent_attempt_terminal_failed_v2',
        'structured_generic_agent_attempt_terminal_failed',
        'structured_system_command_terminal_failed',
        'structured_work_item_parked',
      ],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
      resolveRefs,
      buildEvents: (payload, at) => {
        const p = lease(payload);
        if (p.eventBuilder !== 'work_item_parked') {
          throw new NotRebuildableError('work_item_parked', ['eventBuilder']);
        }
        if (p.attemptFamily === null) {
          throw new NotRebuildableError('work_item_parked', [
            'attemptFamily must name the execution carrier (structured|generic|command)',
          ]);
        }
        const missing: string[] = [];
        if (p.failureCode === null) missing.push('failureCode');
        if (p.failureDigest === null) missing.push('failureDigest');
        if (p.retryOrdinal === null) missing.push('retryOrdinal');
        if (p.budgetPolicyDigest === null) missing.push('budgetPolicyDigest');
        if (missing.length > 0) throw new NotRebuildableError('work_item_parked', missing);
        const envelopes: AuthoritativeReviewEventEnvelopeV2[] = [];
        if (p.attemptFamily === 'structured') {
          if (p.attemptId === null || p.logicalAssignmentId === null || p.sessionKind === null) {
            throw new NotRebuildableError('work_item_parked', ['attemptId, logicalAssignmentId, sessionKind']);
          }
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_agent_attempt_terminal_failed_v2',
            workItemId: p.workItemId as string,
            logicalAssignmentId: p.logicalAssignmentId as string,
            reviewAssignmentId: p.reviewAssignmentId,
            attemptId: p.attemptId as string,
            sessionKind: p.sessionKind as NonNullable<LeaseOrRetryPayload['sessionKind']>,
            leaseEpoch: p.leaseEpoch as number,
            failureCode: p.failureCode as string,
            failureDigest: p.failureDigest as string,
            validatorAggregateRef: p.validatorAggregateRef,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
        } else if (p.attemptFamily === 'generic') {
          if (p.attemptId === null || p.agentId === null || p.logicalAssignmentId === null || p.inputArtifactDeliveryId === null) {
            throw new NotRebuildableError('work_item_parked', ['attemptId, agentId, logicalAssignmentId, inputArtifactDeliveryId']);
          }
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_generic_agent_attempt_terminal_failed',
            attemptId: p.attemptId as string,
            workItemId: p.workItemId as string,
            agentId: p.agentId as string,
            logicalAssignmentId: p.logicalAssignmentId as string,
            leaseEpoch: p.leaseEpoch as number,
            inputArtifactDeliveryId: p.inputArtifactDeliveryId as string,
            failureCode: p.failureCode as string,
            failureDigest: p.failureDigest as string,
            validatorAggregateRef: p.validatorAggregateRef,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
        } else if (p.attemptFamily === 'command') {
          if (p.commandId === null || p.commandKind === null) {
            throw new NotRebuildableError('work_item_parked', ['commandId, commandKind']);
          }
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_system_command_terminal_failed',
            commandId: p.commandId as string,
            workItemId: p.workItemId as string,
            commandKind: p.commandKind,
            leaseEpoch: p.leaseEpoch as number,
            failureCode: p.failureCode as string,
            failureDigest: p.failureDigest as string,
            validatorAggregateRef: p.validatorAggregateRef,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
        }
        envelopes.push({
          protocolVersion: 2,
          at,
          type: 'structured_work_item_parked',
          workItemId: p.workItemId as string,
          leaseEpoch: p.leaseEpoch as number,
          parkDisposition: {
            kind: 'retry_budget_exhausted',
            retryOrdinal: p.retryOrdinal as number,
            budgetPolicyDigest: p.budgetPolicyDigest as string,
          },
          authorityBaseRef: p.authorityBaseRef as BlobRefV2,
        });
        return envelopes;
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });

    // Task 11 (constraint A round 2): the `RUNNING_WITHOUT_WORK` startup
    // compensation (spec §10.4) — ONE `structured_task_failed_v2` whose
    // terminal attempt/command ALREADY committed (the task is otherwise stuck
    // falsely running). The failure carriers ride the lease_or_retry payload,
    // so the compensation is byte-rebuildable.
    this.register({
      handlerKind: 'task_terminal_failed',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: ['structured_task_failed_v2'],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
      resolveRefs,
      buildEvents: (payload, at) => {
        const p = lease(payload);
        if (p.eventBuilder !== 'task_terminal_failed') {
          throw new NotRebuildableError('task_terminal_failed', ['eventBuilder']);
        }
        const missing: string[] = [];
        const need = (value: unknown, name: string): void => {
          if (value === null || value === undefined) missing.push(name);
        };
        need(p.workItemId, 'workItemId');
        need(p.leaseEpoch, 'leaseEpoch');
        need(p.failureCode, 'failureCode');
        need(p.failureDigest, 'failureDigest');
        need(p.authorityBaseRef, 'authorityBaseRef');
        if (p.attemptFamily === 'structured' || p.attemptFamily === 'generic') {
          need(p.attemptId, 'attemptId');
          if (p.attemptFamily === 'generic') need(p.logicalAssignmentId, 'logicalAssignmentId');
        } else if (p.attemptFamily === 'command') {
          need(p.commandId, 'commandId');
        } else {
          missing.push('attemptFamily');
        }
        if (missing.length > 0) throw new NotRebuildableError('task_terminal_failed', missing);
        return [
          {
            protocolVersion: 2,
            at,
            type: 'structured_task_failed_v2',
            workItemId: p.workItemId as string,
            attemptId: p.attemptFamily === 'command' ? null : (p.attemptId as string),
            commandId: p.attemptFamily === 'command' ? (p.commandId as string) : null,
            leaseEpoch: p.leaseEpoch as number,
            failureCode: p.failureCode as string,
            failureDigest: p.failureDigest as string,
            failureRecoveryPayloadRef: p.failureRecoveryPayloadRef,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          },
        ];
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });

    // Task 11 (constraint A round 2): the terminal-failure envelope (Task 12
    // attempt-coordinator handoff): attempt/command terminal_failed +
    // work_item_terminal_failed in ONE batch, plus structured_task_failed_v2
    // when `taskFailure` is true (§10.3 permanent failure atomicity).
    this.register({
      handlerKind: 'work_item_terminal_failed',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: [
        'structured_agent_attempt_terminal_failed_v2',
        'structured_generic_agent_attempt_terminal_failed',
        'structured_system_command_terminal_failed',
        'structured_work_item_terminal_failed',
        'structured_task_failed_v2',
      ],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
      resolveRefs,
      buildEvents: (payload, at) => {
        const p = lease(payload);
        if (p.eventBuilder !== 'work_item_terminal_failed') {
          throw new NotRebuildableError('work_item_terminal_failed', ['eventBuilder']);
        }
        if (p.attemptFamily === null) {
          throw new NotRebuildableError('work_item_terminal_failed', ['attemptFamily']);
        }
        const missing: string[] = [];
        const need = (value: unknown, name: string): void => {
          if (value === null || value === undefined) missing.push(name);
        };
        need(p.workItemId, 'workItemId');
        need(p.leaseEpoch, 'leaseEpoch');
        need(p.failureCode, 'failureCode');
        need(p.failureDigest, 'failureDigest');
        if (p.attemptFamily === 'structured') {
          need(p.attemptId, 'attemptId');
          need(p.logicalAssignmentId, 'logicalAssignmentId');
          need(p.sessionKind, 'sessionKind');
        } else if (p.attemptFamily === 'generic') {
          need(p.attemptId, 'attemptId');
          need(p.agentId, 'agentId');
          need(p.logicalAssignmentId, 'logicalAssignmentId');
          need(p.inputArtifactDeliveryId, 'inputArtifactDeliveryId');
        } else {
          need(p.commandId, 'commandId');
          need(p.commandKind, 'commandKind');
        }
        if (missing.length > 0) throw new NotRebuildableError('work_item_terminal_failed', missing);
        const envelopes: PublicationEventEnvelopeV2[] = [];
        if (p.attemptFamily === 'structured') {
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_agent_attempt_terminal_failed_v2',
            workItemId: p.workItemId as string,
            logicalAssignmentId: p.logicalAssignmentId as string,
            reviewAssignmentId: p.reviewAssignmentId,
            attemptId: p.attemptId as string,
            sessionKind: p.sessionKind as NonNullable<LeaseOrRetryPayload['sessionKind']>,
            leaseEpoch: p.leaseEpoch as number,
            failureCode: p.failureCode as string,
            failureDigest: p.failureDigest as string,
            validatorAggregateRef: p.validatorAggregateRef,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
        } else if (p.attemptFamily === 'generic') {
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_generic_agent_attempt_terminal_failed',
            attemptId: p.attemptId as string,
            workItemId: p.workItemId as string,
            agentId: p.agentId as string,
            logicalAssignmentId: p.logicalAssignmentId as string,
            leaseEpoch: p.leaseEpoch as number,
            inputArtifactDeliveryId: p.inputArtifactDeliveryId as string,
            failureCode: p.failureCode as string,
            failureDigest: p.failureDigest as string,
            validatorAggregateRef: p.validatorAggregateRef,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
        } else {
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_system_command_terminal_failed',
            commandId: p.commandId as string,
            workItemId: p.workItemId as string,
            commandKind: p.commandKind as NonNullable<LeaseOrRetryPayload['commandKind']>,
            leaseEpoch: p.leaseEpoch as number,
            failureCode: p.failureCode as string,
            failureDigest: p.failureDigest as string,
            validatorAggregateRef: p.validatorAggregateRef,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
        }
        envelopes.push({
          protocolVersion: 2,
          at,
          type: 'structured_work_item_terminal_failed',
          workItemId: p.workItemId as string,
          leaseEpoch: p.leaseEpoch as number,
          terminalAttemptId: p.attemptFamily === 'command' ? null : (p.attemptId as string),
          terminalCommandId: p.attemptFamily === 'command' ? (p.commandId as string) : null,
          failureCode: p.failureCode as string,
          failureDigest: p.failureDigest as string,
          validatorAggregateRef: p.validatorAggregateRef,
          authorityBaseRef: p.authorityBaseRef as BlobRefV2,
        });
        if (p.taskFailure === true) {
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_task_failed_v2',
            workItemId: p.workItemId as string,
            attemptId: p.attemptFamily === 'command' ? null : (p.attemptId as string),
            commandId: p.attemptFamily === 'command' ? (p.commandId as string) : null,
            leaseEpoch: p.leaseEpoch as number,
            failureCode: p.failureCode as string,
            failureDigest: p.failureDigest as string,
            failureRecoveryPayloadRef: p.failureRecoveryPayloadRef,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
        }
        return envelopes;
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });

    // Task 12 (constraint A round 3): the SUCCESS completion envelope — the
    // attempt/command `completed` terminal + `structured_work_item_completed`
    // in ONE batch (spec §9.2 "Agent completion plus ... attempt terminal,
    // WorkItem completion" all-or-none; the projector demands the attempt be
    // completed before the workitem completion event). Domain facts ride the
    // SAME batch only through domain-completion handlers registered by later
    // tasks (the `human_answer` pattern); this generic handler is the base
    // terminal pair the attempt-coordinator commits, with the §9.2 all-or-none
    // GATE: workitem kinds whose §17.5 envelope folds a domain result/successor
    // (every structured agent session + every system command) MUST carry a
    // non-empty `resultRefs` carrier — a bare completion of those kinds is
    // fail-closed here (and at the coordinator), so "a completed WorkItem
    // without its result" is unreachable (§9.2). Only the generic submitter
    // (null sessionKind) completes bare, because its result IS the
    // delivery-bound submission carried by the attempt identity.
    this.register({
      handlerKind: 'work_item_completed',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: [
        'structured_agent_attempt_completed_v2',
        'structured_generic_agent_attempt_completed',
        'structured_system_command_completed',
        'structured_work_item_completed',
      ],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
      resolveRefs,
      buildEvents: (payload, at) => {
        const p = lease(payload);
        if (p.eventBuilder !== 'work_item_completed') {
          throw new NotRebuildableError('work_item_completed', ['eventBuilder']);
        }
        if (p.attemptFamily === null) {
          throw new NotRebuildableError('work_item_completed', [
            'attemptFamily must name the execution carrier (structured|generic|command)',
          ]);
        }
        // §9.2 completion gate: gated kinds MUST fold a domain result carrier.
        if (p.kind !== null && completionKindRequiresResult(p.kind, p.sessionKind) && (p.resultRefs?.length ?? 0) === 0) {
          throw new NotRebuildableError('work_item_completed', [
            `kind '${p.kind}' requires a domain result carrier (resultRefs) in the same batch (§9.2)`,
          ]);
        }
        const missing: string[] = [];
        if (p.workItemId === '') missing.push('workItemId');
        if (p.leaseEpoch === null) missing.push('leaseEpoch');
        const envelopes: AuthoritativeReviewEventEnvelopeV2[] = [];
        if (p.attemptFamily === 'structured') {
          if (p.attemptId === null || p.logicalAssignmentId === null || p.sessionKind === null) {
            throw new NotRebuildableError('work_item_completed', ['attemptId, logicalAssignmentId, sessionKind']);
          }
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_agent_attempt_completed_v2',
            workItemId: p.workItemId as string,
            logicalAssignmentId: p.logicalAssignmentId as string,
            reviewAssignmentId: p.reviewAssignmentId,
            attemptId: p.attemptId as string,
            sessionKind: p.sessionKind as NonNullable<LeaseOrRetryPayload['sessionKind']>,
            leaseEpoch: p.leaseEpoch as number,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
        } else if (p.attemptFamily === 'generic') {
          if (p.attemptId === null || p.agentId === null || p.logicalAssignmentId === null || p.inputArtifactDeliveryId === null) {
            throw new NotRebuildableError('work_item_completed', ['attemptId, agentId, logicalAssignmentId, inputArtifactDeliveryId']);
          }
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_generic_agent_attempt_completed',
            attemptId: p.attemptId as string,
            workItemId: p.workItemId as string,
            agentId: p.agentId as string,
            logicalAssignmentId: p.logicalAssignmentId as string,
            leaseEpoch: p.leaseEpoch as number,
            inputArtifactDeliveryId: p.inputArtifactDeliveryId as string,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
        } else if (p.attemptFamily === 'command') {
          if (p.commandId === null || p.commandKind === null) {
            throw new NotRebuildableError('work_item_completed', ['commandId, commandKind']);
          }
          envelopes.push({
            protocolVersion: 2,
            at,
            type: 'structured_system_command_completed',
            commandId: p.commandId as string,
            workItemId: p.workItemId as string,
            commandKind: p.commandKind as NonNullable<LeaseOrRetryPayload['commandKind']>,
            leaseEpoch: p.leaseEpoch as number,
            authorityBaseRef: p.authorityBaseRef as BlobRefV2,
          });
        }
        if (missing.length > 0) throw new NotRebuildableError('work_item_completed', missing);
        envelopes.push({
          protocolVersion: 2,
          at,
          type: 'structured_work_item_completed',
          workItemId: p.workItemId as string,
          leaseEpoch: p.leaseEpoch as number,
          authorityBaseRef: p.authorityBaseRef as BlobRefV2,
        });
        return envelopes;
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });
  }

  private seedQuestion(): void {
    const family: PublicationPayloadFamilyV2 = 'question';
    const childRefs = (parsed: PublicationOperationPayloadV2): readonly BlobRefV2[] => {
      if (parsed.family !== 'question') return [];
      const refs: BlobRefV2[] = [parsed.authorityBaseRef];
      if (parsed.grantSpecRef !== null) refs.push(parsed.grantSpecRef);
      if (parsed.payloadRef !== null) refs.push(parsed.payloadRef);
      return refs;
    };
    const resolveRefs = (): readonly PublicationIntentResolvedRef[] => [];
    // Task 11 (constraint A round 2): the §17.3 OPEN envelope — attempt
    // terminal, question opened, question park and the public display event in
    // ONE batch. The attempt-terminal carrier set comes from the payload, so
    // a crashed pin replays the exact bytes.
    this.register({
      handlerKind: 'human_question_open',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: [
        'structured_agent_attempt_terminal_failed_v2',
        'structured_human_question_opened_v2',
        'structured_work_item_parked',
        'human_requested',
      ],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
      resolveRefs,
      buildEvents: (payload, at) => {
        const p = payload as Extract<PublicationOperationPayloadV2, { family: 'question' }>;
        if (p.mode !== 'open') {
          throw new NotRebuildableError('human_question_open', [`payload mode '${p.mode}' is not open`]);
        }
        const missing: string[] = [];
        const need = (value: unknown, name: string): void => {
          if (value === null || value === undefined) missing.push(name);
        };
        need(p.questionDigest, 'questionDigest');
        need(p.text, 'text');
        need(p.openedCommitId, 'openedCommitId');
        need(p.originalWorkItemId, 'originalWorkItemId');
        need(p.attemptId, 'attemptId');
        need(p.leaseEpoch, 'leaseEpoch');
        need(p.logicalAssignmentId, 'logicalAssignmentId');
        need(p.sessionKind, 'sessionKind');
        need(p.failureCode, 'failureCode');
        need(p.failureDigest, 'failureDigest');
        if (missing.length > 0) throw new NotRebuildableError('human_question_open', missing);
        const sequence = p.expectedLastSequence ?? 0;
        return [
          {
            protocolVersion: 2,
            at,
            type: 'structured_agent_attempt_terminal_failed_v2',
            workItemId: p.originalWorkItemId as string,
            logicalAssignmentId: p.logicalAssignmentId as string,
            reviewAssignmentId: p.reviewAssignmentId,
            attemptId: p.attemptId as string,
            sessionKind: p.sessionKind as NonNullable<Extract<PublicationOperationPayloadV2, { family: 'question' }>['sessionKind']>,
            leaseEpoch: p.leaseEpoch as number,
            failureCode: p.failureCode as string,
            failureDigest: p.failureDigest as string,
            validatorAggregateRef: null,
            authorityBaseRef: p.authorityBaseRef,
          },
          {
            protocolVersion: 2,
            at,
            type: 'structured_human_question_opened_v2',
            questionId: p.questionId,
            questionVersion: p.questionVersion,
            questionDigest: p.questionDigest as string,
            originalWorkItemId: p.originalWorkItemId as string,
            attemptId: p.attemptId as string,
            leaseEpoch: p.leaseEpoch as number,
            logicalAssignmentId: p.logicalAssignmentId as string,
            authorityBaseRef: p.authorityBaseRef,
          },
          {
            protocolVersion: 2,
            at,
            type: 'structured_work_item_parked',
            workItemId: p.originalWorkItemId as string,
            leaseEpoch: p.leaseEpoch as number,
            parkDisposition: {
              kind: 'human_question',
              questionId: p.questionId,
              questionVersion: p.questionVersion,
            },
            authorityBaseRef: p.authorityBaseRef,
          },
          {
            at,
            type: 'human_requested',
            node: legacyDisplayNode(
              p.agentId as string,
              'Human Question',
              p.text as string,
              sequence + 1,
              'human_request',
            ),
            question: p.text as string,
            source: 'agent_request',
          },
        ];
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });
    // Task 11 (constraint A round 2): the §17.3 ANSWER envelope — the delivered
    // event consumes the exact pending question, the original question-bound
    // WorkItem is superseded (human_disposition), the replacement WorkItem is
    // created, and the public display event lands — all in ONE batch. The
    // union extension (deliveryId/originalWorkItemId/replacementWorkItemId/
    // logicalAssignmentId) makes this byte-rebuildable from the pin alone.
    this.register({
      handlerKind: 'human_answer',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: [
        'human_answered',
        'structured_human_answer_delivered_v2',
        'structured_work_item_superseded',
        'structured_work_item_created',
      ],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
      resolveRefs,
      buildEvents: (payload, at) => {
        const p = payload as Extract<PublicationOperationPayloadV2, { family: 'question' }>;
        if (p.mode !== 'answer') {
          throw new NotRebuildableError('human_answer', [`payload mode '${p.mode}' is not answer`]);
        }
        const missing: string[] = [];
        const need = (value: unknown, name: string): void => {
          if (value === null || value === undefined) missing.push(name);
        };
        need(p.deliveryId, 'deliveryId');
        need(p.originalWorkItemId, 'originalWorkItemId');
        need(p.replacementWorkItemId, 'replacementWorkItemId');
        need(p.logicalAssignmentId, 'logicalAssignmentId');
        need(p.answerDigest, 'answerDigest');
        need(p.kind, 'kind');
        need(p.roleBinding, 'roleBinding');
        need(p.payloadRef, 'payloadRef');
        need(p.initialLeaseEpoch, 'initialLeaseEpoch');
        need(p.maxAutomaticRetries, 'maxAutomaticRetries');
        need(p.leaseEpoch, 'leaseEpoch');
        if (missing.length > 0) throw new NotRebuildableError('human_answer', missing);
        const sequence = p.expectedLastSequence ?? 0;
        return [
          {
            at,
            type: 'human_answered',
            node: legacyDisplayNode(
              p.agentId as string,
              'Human Answer',
              p.answerText as string,
              sequence + 1,
              'human_answer',
            ),
            answer: p.answerText as string,
          },
          {
            protocolVersion: 2,
            at,
            type: 'structured_human_answer_delivered_v2',
            deliveryId: p.deliveryId as string,
            questionId: p.questionId,
            questionVersion: p.questionVersion,
            originalWorkItemId: p.originalWorkItemId as string,
            replacementWorkItemId: p.replacementWorkItemId as string,
            logicalAssignmentId: p.logicalAssignmentId as string,
            answerDigest: p.answerDigest as string,
            operationId: p.operationId,
            authorityBaseRef: p.authorityBaseRef,
          },
          {
            protocolVersion: 2,
            at,
            type: 'structured_work_item_superseded',
            workItemId: p.originalWorkItemId as string,
            leaseEpoch: p.leaseEpoch as number,
            reason: 'human_disposition',
            authorityBaseRef: p.authorityBaseRef,
          },
          {
            protocolVersion: 2,
            at,
            type: 'structured_work_item_created',
            workItemId: p.replacementWorkItemId as string,
            kind: p.kind as WorkItemKindV2,
            roleBinding: p.roleBinding,
            agentExecutionKind: p.agentExecutionKind ?? null,
            sessionKind: p.sessionKind ?? null,
            roundId: p.roundId ?? null,
            logicalAssignmentId: p.logicalAssignmentId as string,
            reviewAssignmentId: p.reviewAssignmentId,
            grantSpecRef: p.grantSpecRef,
            inputArtifactDeliveryId: p.inputArtifactDeliveryId ?? null,
            authorityBaseRef: p.authorityBaseRef,
            payloadRef: p.payloadRef as BlobRefV2,
            initialLeaseEpoch: p.initialLeaseEpoch as number,
            maxAutomaticRetries: p.maxAutomaticRetries as number,
          },
        ];
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });
  }

  private seedRecovery(): void {
    const family: PublicationPayloadFamilyV2 = 'recovery';
    // Task 11 (constraint A round 2): the §10.3.1 policy table is applied ONLY
    // from the frozen projection + recovery payload; the operator-owned reopen
    // facts (operatorId/reason/track) now ride in the payload, so every recipe
    // envelope is byte-rebuildable from the pin (spec §10.4 crash-pin replay).
    const buildReopened = (recipeKey: string) => (payload: PublicationOperationPayloadV2, at: string): readonly PublicationEventEnvelopeV2[] => {
      const p = payload as Extract<PublicationOperationPayloadV2, { family: 'recovery' }>;
      if (p.recipeKey !== recipeKey) {
        throw new NotRebuildableError(recipeKey, [`payload recipe '${p.recipeKey}' is not ${recipeKey}`]);
      }
      if (p.reason === '') {
        throw new NotRebuildableError(recipeKey, ['reason must be a non-empty bounded string']);
      }
      const track: 'map' | 'content' | null =
        p.track === 'map' || p.track === 'content' ? p.track : null;
      if (recipeKey === 'restart_map_review_cycle' && track !== 'map') {
        throw new NotRebuildableError(recipeKey, [`track must be 'map', got '${String(p.track)}'`]);
      }
      if (recipeKey === 'restart_content_review_cycle' && track !== 'content') {
        throw new NotRebuildableError(recipeKey, [`track must be 'content', got '${String(p.track)}'`]);
      }
      if (recipeKey === 'retry_system_command' && track !== null) {
        throw new NotRebuildableError(recipeKey, ['track must be null for retry_system_command']);
      }
      return [
        {
          protocolVersion: 2,
          at,
          type: 'structured_task_reopened_v2',
          expectedLastSequence: p.expectedLastSequence,
          operationId: p.operationId,
          operatorId: p.operatorId,
          reason: p.reason,
          recipeKey: p.recipeKey,
          track: recipeKey === 'retry_system_command' ? null : track,
          failureRecoveryPayloadRef: p.failureRecoveryPayloadRef,
          overrideRef: p.overrideRef,
        },
      ];
    };
    const buildFor = (recipeKey: string) => (payload: PublicationOperationPayloadV2, at: string): readonly PublicationEventEnvelopeV2[] => {
      const reopened = buildReopened(recipeKey)(payload, at);
      const p = payload as Extract<PublicationOperationPayloadV2, { family: 'recovery' }>;
      if (p.replacementWorkItemId === null || p.replacementKind === null) {
        throw new NotRebuildableError(recipeKey, ['replacementWorkItemId/replacementKind']);
      }
      const missing: string[] = [];
      const need = (value: unknown, name: string): void => {
        if (value === null || value === undefined) missing.push(name);
      };
      need(p.replacementPayloadRef, 'replacementPayloadRef');
      need(p.replacementAuthorityBaseRef, 'replacementAuthorityBaseRef');
      need(p.replacementLeaseEpoch, 'replacementLeaseEpoch');
      need(p.replacementMaxAutomaticRetries, 'replacementMaxAutomaticRetries');
      if (p.replacementKind === 'agent_assignment') {
        need(p.replacementRoleBinding, 'replacementRoleBinding');
        need(p.replacementLogicalAssignmentId, 'replacementLogicalAssignmentId');
        if (p.replacementAgentExecutionKind === 'structured_session') need(p.replacementSessionKind, 'replacementSessionKind');
      }
      if (missing.length > 0) throw new NotRebuildableError(recipeKey, missing);
      return [
        ...reopened,
        {
          protocolVersion: 2,
          at,
          type: 'structured_work_item_created',
          workItemId: p.replacementWorkItemId as string,
          kind: p.replacementKind as WorkItemKindV2,
          roleBinding: p.replacementRoleBinding,
          agentExecutionKind: p.replacementAgentExecutionKind ?? null,
          sessionKind: p.replacementSessionKind ?? null,
          roundId: p.replacementRoundId ?? null,
          logicalAssignmentId: p.replacementLogicalAssignmentId as string,
          reviewAssignmentId: p.replacementReviewAssignmentId,
          grantSpecRef: p.replacementGrantSpecRef,
          inputArtifactDeliveryId: p.replacementInputArtifactDeliveryId ?? null,
          authorityBaseRef: p.replacementAuthorityBaseRef as BlobRefV2,
          payloadRef: p.replacementPayloadRef as BlobRefV2,
          initialLeaseEpoch: p.replacementLeaseEpoch as number,
          maxAutomaticRetries: p.replacementMaxAutomaticRetries as number,
        },
      ];
    };
    const childRefs = (parsed: PublicationOperationPayloadV2): readonly BlobRefV2[] => {
      if (parsed.family !== 'recovery') return [];
      const refs: BlobRefV2[] = [parsed.failureRecoveryPayloadRef];
      if (parsed.overrideRef !== null) refs.push(parsed.overrideRef);
      return refs;
    };
    for (const recipeKey of [
      'retry_system_command',
      'restart_map_review_cycle',
      'restart_content_review_cycle',
      'rebuild_missing_work',
    ] as const) {
      this.register({
        handlerKind: recipeKey,
        handlerVersion: 1,
        payloadFamily: family,
        expectedEventTypes: ['structured_task_reopened_v2', 'structured_work_item_created'],
        rebuildable: true,
        missingInputs: [],
        parsePayload: parsePublicationOperationPayload,
        childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
        resolveRefs: (p) => {
          if (p.family !== 'recovery') return [];
          const out: PublicationIntentResolvedRef[] = [
            { key: 'failureRecoveryPayload', ref: p.failureRecoveryPayloadRef },
          ];
          if (p.overrideRef !== null) out.push({ key: 'override', ref: p.overrideRef });
          return out;
        },
        buildEvents: buildFor(recipeKey),
        expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
      });
    }
  }

  private seedDelete(): void {
    const family: PublicationPayloadFamilyV2 = 'delete';
    /**
     * Task 11 RULING (constraint A round 2) — delete stays NON-rebuildable and
     * MUST, because the v2 delete PRODUCES NO v2 EVENT at all: the tombstone
     * is an installation-level task-index record (spec §10.5), not an event.
     * A rebuildable delete handler would need the tombstone's state inside the
     * publication payload — which is precisely the un-derivable fact. The
     * delete family remains a REGISTERED family so the payload union stays
     * closed and pins of any future delete operation fail closed instead of
     * being guessed; `AuthoritativeTaskDeletionV2` never commits through the
     * facade and therefore never creates a pin. schemaVersion stays 1 (no
     * production bytes exist; capability disabled).
     */
    this.register({
      handlerKind: 'task_delete',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: [],
      rebuildable: false,
      missingInputs: ['the delete tombstone is a task-index record, not a v2 event (Task 11 ruling)'],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, () => []),
      resolveRefs: () => [],
      buildEvents: () => {
        throw new NotRebuildableError('task_delete', ['delete produces no v2 event (tombstone lives in the task index)']);
      },
      expectedResultIdentity: () => {
        throw new NotRebuildableError('task_delete', ['not rebuildable']);
      },
    });
  }

  private seedArtifactPublish(): void {
    const family: PublicationPayloadFamilyV2 = 'artifact_publish';
    this.register({
      handlerKind: 'artifact_publish',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: ['artifact_published_v2'],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) =>
        childRefsOfChecked(p, family, (parsed) =>
          parsed.family === 'artifact_publish'
            ? [parsed.artifactRef, parsed.sealRecordRef, parsed.deliveryRef]
            : [],
        ),
      resolveRefs: (p) => {
        if (p.family !== 'artifact_publish') return [];
        return [
          { key: 'delivery', ref: p.deliveryRef },
          { key: 'sealRecord', ref: p.sealRecordRef },
          { key: 'artifact', ref: p.artifactRef },
        ];
      },
      buildEvents: (payload, at, refs) => {
        const p = payload as Extract<PublicationOperationPayloadV2, { family: 'artifact_publish' }>;
        const delivery = refs?.get('delivery') as
          | { submitterWorkItemId: string; custodyRef: BlobRefV2; artifactId: string }
          | undefined;
        const artifact = refs?.get('artifact') as
          | { artifactId: string; mediaType: 'text/markdown' | 'text/plain' }
          | undefined;
        if (delivery === undefined || artifact === undefined) {
          throw new NotRebuildableError('artifact_publish', [
            'deliveryRef/artifactRef blobs must resolve before the event envelope can be rebuilt',
          ]);
        }
        const extension = artifact.mediaType === 'text/markdown' ? 'md' : 'txt';
        return [
          {
            protocolVersion: 2,
            at,
            type: 'artifact_published_v2',
            artifactId: artifact.artifactId,
            artifactVersion: p.expectedArtifactVersion,
            deliveryRef: p.deliveryRef,
            files: [{ name: `${artifact.artifactId}.${extension}`, hash: p.artifactRef.digest }],
            mediaType: artifact.mediaType,
            provenance: {
              producerKind: 'system',
              producerWorkItemId: delivery.submitterWorkItemId,
              sealRecordRef: p.sealRecordRef,
              artifactRef: p.artifactRef,
              custodyRef: delivery.custodyRef,
            },
          },
        ];
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });
  }

  private seedSealPublish(): void {
    const family: PublicationPayloadFamilyV2 = 'seal_publish';
    this.register({
      handlerKind: 'system_seal_publish',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: [
        'structured_scaffold_sealed_v2',
        'artifact_published_v2',
        'structured_system_artifact_delivery_created',
        'structured_work_item_created',
        'structured_system_command_completed',
        'structured_work_item_completed',
      ],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, (parsed) => parsed.family === 'seal_publish' ? [
        parsed.artifactRef, parsed.sealRecordRef, parsed.sealValidationBundleRef,
        parsed.deliveryRef, parsed.custodyRef, parsed.mapRef,
        parsed.contentRevisionManifestRef, parsed.reviewBundleRef,
        parsed.sealAuthorityBaseRef, parsed.submitterAuthorityBaseRef,
        parsed.submitterGrantSpecRef,
      ] : []),
      resolveRefs: (p) => p.family === 'seal_publish' ? [
        { key: 'delivery', ref: p.deliveryRef },
        { key: 'artifact', ref: p.artifactRef },
        { key: 'sealRecord', ref: p.sealRecordRef },
        { key: 'sealValidationBundle', ref: p.sealValidationBundleRef },
        { key: 'custody', ref: p.custodyRef },
        { key: 'map', ref: p.mapRef },
        { key: 'contentRevisionManifest', ref: p.contentRevisionManifestRef },
        { key: 'reviewBundle', ref: p.reviewBundleRef },
        { key: 'submitterGrantSpec', ref: p.submitterGrantSpecRef },
        { key: 'submitterAuthorityBase', ref: p.submitterAuthorityBaseRef },
        { key: 'sealAuthorityBase', ref: p.sealAuthorityBaseRef },
      ] : [],
      buildEvents: (payload, at, refs) => {
        const p = payload as Extract<PublicationOperationPayloadV2, { family: 'seal_publish' }>;
        // Task 21 P1#3: the full frozen closure must resolve BEFORE the event
        // envelope is rebuilt — a missing object can never be re-derived.
        const missing = sealPublishMissingInputs(refs);
        if (missing.length > 0) {
          throw new NotRebuildableError('system_seal_publish', missing);
        }
        // Cross-object Seal/Delivery/Submitter consistency: every resolved blob
        // must agree with the pinned payload refs and each other, otherwise the
        // crash-pin replay would rebuild a schema-legal but mutually inconsistent
        // six-event envelope.
        const closureErrors = sealPublishClosureErrors(p, refs as ReadonlyMap<string, unknown>);
        if (closureErrors.length > 0) {
          throw new NotRebuildableError('system_seal_publish', closureErrors);
        }
        const delivery = refs?.get('delivery') as SystemArtifactDeliveryV2;
        const artifact = refs?.get('artifact') as { artifactId: string; mediaType: 'text/markdown' | 'text/plain'; text: string };
        const artifactVersion = refs?.get('allocatedArtifactVersion');
        return [
          {
            protocolVersion: 2, at, type: 'structured_scaffold_sealed_v2',
            sealWorkItemId: p.sealWorkItemId,
            sealRecordRef: p.sealRecordRef,
            sealValidationBundleRef: p.sealValidationBundleRef,
            mapRef: p.mapRef,
            contentRevisionManifestRef: p.contentRevisionManifestRef,
            reviewBundleRef: p.reviewBundleRef,
            artifactRef: p.artifactRef,
          },
          {
            protocolVersion: 2, at, type: 'artifact_published_v2',
            artifactId: artifact.artifactId,
            artifactVersion,
            deliveryRef: p.deliveryRef,
            files: [{ name: p.artifactFile, hash: p.artifactFileHash }],
            mediaType: artifact.mediaType,
            provenance: {
              producerKind: 'system',
              producerWorkItemId: p.sealWorkItemId,
              sealRecordRef: p.sealRecordRef,
              artifactRef: p.artifactRef,
              custodyRef: p.custodyRef,
            },
          },
          {
            protocolVersion: 2, at, type: 'structured_system_artifact_delivery_created',
            deliveryId: delivery.deliveryId,
            deliveryRef: p.deliveryRef,
            artifactId: artifact.artifactId,
            artifactRef: p.artifactRef,
            sealRecordRef: p.sealRecordRef,
            submitterWorkItemId: p.submitterWorkItemId,
          },
          {
            protocolVersion: 2, at, type: 'structured_work_item_created',
            workItemId: p.submitterWorkItemId,
            kind: 'agent_assignment',
            roleBinding: delivery.submitterAgentId,
            agentExecutionKind: 'generic_turn',
            sessionKind: null,
            roundId: null,
            logicalAssignmentId: p.submitterLogicalAssignmentId,
            reviewAssignmentId: null,
            grantSpecRef: p.submitterGrantSpecRef,
            inputArtifactDeliveryId: delivery.deliveryId,
            authorityBaseRef: p.submitterAuthorityBaseRef,
            payloadRef: p.deliveryRef,
            initialLeaseEpoch: 1,
            maxAutomaticRetries: p.submitterMaxAutomaticRetries,
          },
          {
            protocolVersion: 2, at, type: 'structured_system_command_completed',
            commandId: p.sealCommandId,
            workItemId: p.sealWorkItemId,
            commandKind: 'seal',
            leaseEpoch: p.sealLeaseEpoch,
            authorityBaseRef: p.sealAuthorityBaseRef,
          },
          {
            protocolVersion: 2, at, type: 'structured_work_item_completed',
            workItemId: p.sealWorkItemId,
            leaseEpoch: p.sealLeaseEpoch,
            authorityBaseRef: p.sealAuthorityBaseRef,
          },
        ];
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });
  }
}

function childRefsOfChecked(
  payload: PublicationOperationPayloadV2,
  family: PublicationPayloadFamilyV2,
  extract: (parsed: PublicationOperationPayloadV2) => readonly BlobRefV2[],
): readonly BlobRefV2[] {
  // Strict parse: wrong family or unparseable values fail closed with a
  // SchemaError instead of being guessed.
  const parsed = parsePublicationOperationPayload(payload);
  if (parsed.family !== family) {
    throw new Error(`publication payload family '${parsed.family}' does not match registration family '${family}'`);
  }
  return extract(parsed);
}

/** The module-level runtime allowlist (resolved by the facade and recovery). */
export const PUBLICATION_INTENT_REGISTRY_V2 = new PublicationIntentRegistry();

/** Duplicate registration on the runtime allowlist is a program error. */
export function registerPublicationIntent(registration: PublicationIntentRegistrationV2): void {
  PUBLICATION_INTENT_REGISTRY_V2.register(registration);
}

/** Allowlist-only runtime resolution; null for unknown handler kind/version. */
export function resolvePublicationIntent(
  handlerKind: string,
  handlerVersion: number,
): PublicationIntentRegistrationV2 | null {
  return PUBLICATION_INTENT_REGISTRY_V2.resolve(handlerKind, handlerVersion);
}
