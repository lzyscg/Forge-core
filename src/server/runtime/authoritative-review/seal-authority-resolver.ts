/**
 * Task 21 P1#2 (system-derived Seal Gate): the runtime resolver that turns a
 * SystemCommand `seal` execution into the PURE `SealGateInputV2` (seal-gate.ts,
 * design §16.2 / spec §13.5). No caller-supplied boolean summary, no
 * caller-supplied authority refs, no semantic-root stand-ins: every gate input
 * is derived from the authoritative event projection plus the resolved blob
 * graph, and every required identity (lease, work item, authority base,
 * profile, template, Map, manifest, MapReviewBundle, ReviewBundle) is bound by
 * EXACT ref equality. Equal mapSemanticDigest / contentRootDigest never
 * substitutes for ref equality.
 *
 * Conservative premise (§16.2 §16.3): when a condition class cannot be fully
 * reconstructed from the current projection + resolvable blob graph (e.g.
 * adopted historical coverage, unresolvable validator envelopes), the resolver
 * FAILS THAT CONDITION closed instead of accepting a fabricated clean bill —
 * it never guesses. Only seal-gate.ts's frozen `sealConditionCodes` name unmet
 * gate conditions; pre-gate authority binding failures use their own stable
 * `SealAuthorityError` codes and are never gate conditions.
 *
 * Pure module: no fs/EventStore/provider/HTTP/React, no wall clock, no random.
 */
import type {
  AuthoritativeBlobKindV2,
  BlobRefV2,
} from '../../../shared/authoritative-review-v2';
import type { AssemblerRegistrationV2 } from '../../template/structured-slot-contract-v2';
import type {
  AssignmentLedgerBlobV2,
  AuthorityBaseSetV2,
  ContentRevisionManifestV2,
  ContentReviewCoverageCoreV2,
  ContentReviewSettlementCoreV2,
  MapReviewBundleV2,
  MapReviewSettlementCoreV2,
  MapSnapshotV2,
  ReviewBundleV2,
  ReviewFactV2,
  SlotContentVersionV2,
  ValidatorAggregateV2,
  ValidatorInputEnvelopeV2,
} from '../../authoritative-review/authority-types';
import { parseBlob } from '../../authoritative-review/object-registry';
import {
  type PreSealValidatorAggregateV2,
  type SealGateInputV2,
  type SlotCoverageFact,
} from '../../authoritative-review/seal-gate';
import { sameRef } from './authority-base';
import type { ZhihuChapterAssemblerInputV1 } from './builtin-assemblers/zhihu-chapter-v1';

/** Stable pre-gate authority-binding failure (never a sealConditionCodes). */
export class SealAuthorityError extends Error {
  readonly code: string;
  constructor(code: string, reason: string) {
    super(`SEAL_AUTHORITY:${code}: ${reason}`);
    this.name = 'SealAuthorityError';
    this.code = code;
  }
}

/** The structural slice of `AuthoritativeReviewProjectionV2` the resolver reads. */
export interface SealProjectionViewV2 {
  activeLease: { workItemId: string; leaseEpoch: number; commandId: string | null } | null;
  currentMap: {
    mapSnapshotRef: BlobRefV2;
    mapReviewBundleRef: BlobRefV2;
    mapSemanticDigest: string;
  } | null;
  currentManifest: {
    contentRevisionManifestRef: BlobRefV2;
    manifestPhase: 'baseline_unset' | 'provisional' | 'finalized';
  } | null;
  currentSeal: { sealRecordRef: BlobRefV2 } | null;
  workItems: Record<string, {
    kind: string;
    authorityBaseRef: BlobRefV2;
    payloadRef: BlobRefV2;
    leaseEpoch: number;
    state: string;
    sessionKind: string | null;
  }>;
  contentRounds: Record<string, { state: 'planned' | 'reviewing' | 'completed' | 'settled' }>;
  mapRounds: Record<string, { state: 'planned' | 'reviewing' | 'completed' | 'settled' }>;
  findings: Record<string, { severity: 'blocking' | 'advisory'; state: string }>;
}

export interface SealAuthorityResolutionRequestV2 {
  taskId: string;
  workItemId: string;
  commandId: string;
  leaseEpoch: number;
  /** The SystemCommand ctx authority base ref (must be the work item's exact ref). */
  authorityBaseRef: BlobRefV2;
  /** The SystemCommand ctx payload ref (must be the authority review bundle). */
  payloadRef: BlobRefV2;
}

export interface SealTemplateIdentityV2 {
  templateSnapshotHash: string;
  resourceManifestDigest: string;
  assembler: AssemblerRegistrationV2;
}

/**
 * The frozen template identity PLUS the template-owned coverage facts the gate
 * derivation needs: relation-type enforcement (which actual Map relations are
 * blocking — condition 5 must enumerate the ACTIVE Map's blocking relations,
 * never a verdict subset) and slot presence (required|optional).
 */
export interface SealTemplateIdentityWithCoverageV2 extends SealTemplateIdentityV2 {
  /** relation TYPE id -> enforcement (frozen contract; blocking relations never
   * escape the gate just because no verdict was committed). */
  relationEnforcement: ReadonlyMap<string, 'blocking' | 'advisory'>;
  /** slotId -> presence (required|optional) from the frozen template. */
  contentPresence: ReadonlyMap<string, 'required' | 'optional'>;
}

export interface SealAuthorityResolverDependenciesV2 {
  /** Event-derived projection (system-owned state, never caller input). */
  readProjection(taskId: string): Promise<SealProjectionViewV2>;
  /** Resolve any registered blob; null/undefined resolves FAIL (fail closed). */
  resolveBlob(taskId: string, ref: BlobRefV2): Promise<unknown>;
  /** Identity pinned by the authority base templateSnapshotRef (resolved side). */
  resolveTemplateIdentity(templateSnapshotRef: BlobRefV2): Promise<SealTemplateIdentityWithCoverageV2>;
  /** Identity pinned by the runtime (frozen side; condition 10). */
  installedTemplateIdentity(): Promise<SealTemplateIdentityV2>;
  /** The exact profile snapshot ref the runtime installed (profile binding). */
  readProfileSnapshotRef(): Promise<BlobRefV2>;
  /** Canonical assembler input for the derived authority (never caller content
   * for the authority fields — the registry re-verifies the authority). */
  buildAssemblerInput(input: {
    taskId: string;
    activeMapRef: BlobRefV2;
    contentRevisionManifestRef: BlobRefV2;
    reviewBundleRef: BlobRefV2;
    templateSnapshotHash: string;
  }): Promise<ZhihuChapterAssemblerInputV1>;
  /** The deterministic submitter identity of the seal's next stage. */
  submitterIdentity(): Promise<{
    workItemId: string;
    agentId: string;
    logicalAssignmentId: string;
    maxAutomaticRetries: number;
  }>;
}

export interface ResolvedSealAuthorityV2 {
  /** The pure §16.2 ten-condition gate input, all system-derived. */
  gate: SealGateInputV2;
  /** The installed/frozen assembler registration the seal must run. */
  assembler: AssemblerRegistrationV2;
  assemblerInput: ZhihuChapterAssemblerInputV1;
  submitter: {
    workItemId: string;
    agentId: string;
    logicalAssignmentId: string;
    maxAutomaticRetries: number;
  };
}

export type SealAuthorityResolverV2 = (
  input: SealAuthorityResolutionRequestV2,
) => Promise<ResolvedSealAuthorityV2>;

async function resolveAs<T>(
  input: {
    taskId: string;
    ref: BlobRefV2;
    kind: AuthoritativeBlobKindV2;
    what: string;
    resolveBlob(taskId: string, ref: BlobRefV2): Promise<unknown>;
  },
): Promise<T> {
  if (input.ref.kind !== input.kind) {
    throw new SealAuthorityError('SEAL_AUTHORITY_STALE', `${input.what}: expected kind '${input.kind}'`);
  }
  const raw = await input.resolveBlob(input.taskId, input.ref);
  if (raw === null || raw === undefined) {
    throw new SealAuthorityError('SEAL_AUTHORITY_STALE', `${input.what}: blob unresolvable`);
  }
  return parseBlob(input.kind, raw, input.ref).object as T;
}

const REVIEW_SESSION_KINDS: readonly string[] = [
  'review_map_batch',
  'review_map_whole',
  'review_content_batch',
  'review_content_whole',
];
const REPAIR_SESSION_KINDS: readonly string[] = ['map_repair', 'content_repair'];
const NON_TERMINAL_WORK_ITEM_STATES: readonly string[] = ['ready', 'leased', 'parked', 'retryable_failed'];

/**
 * The production resolver. Every gate input below comes from the projection or
 * the resolved blob graph bound by exact refs — never from the caller.
 */
export function createSystemSealAuthorityResolver(
  deps: SealAuthorityResolverDependenciesV2,
): SealAuthorityResolverV2 {
  return async (request) => {
    const { taskId, workItemId, commandId, leaseEpoch, authorityBaseRef, payloadRef } = request;
    const projection = await deps.readProjection(taskId);

    // ---- Pre-gate authority binding (P1#2: exact refs + epoch, never strings) ----
    if (
      projection.activeLease === null
      || projection.activeLease.workItemId !== workItemId
      || projection.activeLease.commandId !== commandId
      || projection.activeLease.leaseEpoch !== leaseEpoch
    ) {
      throw new SealAuthorityError('SEAL_LEASE_STALE', 'the seal command does not hold the current active lease');
    }
    const workItem = projection.workItems[workItemId];
    if (workItem === undefined || workItem.kind !== 'system_seal') {
      throw new SealAuthorityError('SEAL_WORK_ITEM_MISSING', 'the active lease is not a system_seal work item');
    }
    if (
      !sameRef(workItem.authorityBaseRef, authorityBaseRef)
      || !sameRef(workItem.payloadRef, payloadRef)
      || workItem.leaseEpoch !== leaseEpoch
    ) {
      throw new SealAuthorityError('SEAL_AUTHORITY_STALE', 'work item binds a different authority base / payload / lease epoch');
    }
    if (projection.currentSeal !== null) {
      throw new SealAuthorityError('SEAL_ALREADY_PUBLISHED', 'a SealRecord already exists for this task');
    }

    // ---- Authority base set: profile/template/task binding ----
    const base = await resolveAs<AuthorityBaseSetV2>({ taskId, ref: authorityBaseRef, kind: 'authority_base_set', what: 'seal authority base', resolveBlob: deps.resolveBlob });
    if (base.taskId !== taskId) {
      throw new SealAuthorityError('SEAL_AUTHORITY_STALE', 'seal authority base belongs to another task');
    }
    const installedProfile = await deps.readProfileSnapshotRef();
    if (base.profileSnapshotRef === null || !sameRef(base.profileSnapshotRef, installedProfile)) {
      throw new SealAuthorityError('SEAL_AUTHORITY_STALE', 'seal authority profile snapshot does not match the installed profile');
    }
    const template = await deps.resolveTemplateIdentity(base.templateSnapshotRef);
    const installed = await deps.installedTemplateIdentity();

    // ---- Projection authority refs (§16.2 conditions 1/2/3) ----
    if (projection.currentMap === null) {
      throw new SealAuthorityError('SEAL_MAP_MISSING', 'no active Map in the projection');
    }
    if (projection.currentManifest === null) {
      throw new SealAuthorityError('SEAL_MANIFEST_MISSING', 'no content manifest in the projection');
    }
    const activeMapRef = projection.currentMap.mapSnapshotRef;
    const activeMapReviewBundleRef = projection.currentMap.mapReviewBundleRef;
    const activeMapSemanticDigest = projection.currentMap.mapSemanticDigest;
    const baseFinalizedManifestRef = projection.currentManifest.contentRevisionManifestRef;
    const manifestPhase = projection.currentManifest.manifestPhase;
    if (manifestPhase !== 'finalized') {
      throw new SealAuthorityError('SEAL_MANIFEST_NOT_FINALIZED', 'the current content manifest is not finalized (seal is impossible)');
    }

    // The authority base must bind the CURRENT projected authority by exact ref.
    if (base.mapRef === null || !sameRef(base.mapRef, activeMapRef)) {
      throw new SealAuthorityError('SEAL_AUTHORITY_STALE', 'seal authority base does not bind the current active Map');
    }
    if (base.mapReviewBundleRef === null || !sameRef(base.mapReviewBundleRef, activeMapReviewBundleRef)) {
      throw new SealAuthorityError('SEAL_AUTHORITY_STALE', 'seal authority base does not bind the current active MapReviewBundle');
    }
    if (base.contentRevisionManifestRef === null || !sameRef(base.contentRevisionManifestRef, baseFinalizedManifestRef)) {
      throw new SealAuthorityError('SEAL_AUTHORITY_STALE', 'seal authority base does not bind the current content revision manifest');
    }
    if (base.reviewBundleRef === null) {
      throw new SealAuthorityError('SEAL_AUTHORITY_STALE', 'seal authority base carries no reviewBundleRef');
    }
    // The seal command payload IS the review bundle being sealed (content-review
    // wiring: system_seal payloadRef = reviewBundleRef).
    if (!sameRef(base.reviewBundleRef, payloadRef)) {
      throw new SealAuthorityError('SEAL_AUTHORITY_STALE', 'seal payload is not the authority review bundle');
    }

    // The active Map snapshot must itself reference the projected MapReviewBundle.
    const mapSnapshot = await resolveAs<MapSnapshotV2>({ taskId, ref: activeMapRef, kind: 'map_snapshot', what: 'active Map snapshot', resolveBlob: deps.resolveBlob });
    if (!sameRef(mapSnapshot.mapReviewBundleRef, activeMapReviewBundleRef)) {
      throw new SealAuthorityError('SEAL_AUTHORITY_STALE', 'active Map snapshot does not reference the projected MapReviewBundle');
    }
    if (mapSnapshot.mapSemanticDigest !== activeMapSemanticDigest) {
      throw new SealAuthorityError('SEAL_AUTHORITY_STALE', 'active Map snapshot semantic digest does not match the projection');
    }

    // ---- ReviewBundle closure (conditions 1/2/9) ----
    const reviewBundleRef = base.reviewBundleRef;
    const reviewBundle = await resolveAs<ReviewBundleV2>({ taskId, ref: reviewBundleRef, kind: 'review_bundle', what: 'seal review bundle', resolveBlob: deps.resolveBlob });
    const settlementCore = await resolveAs<ContentReviewSettlementCoreV2>({ taskId, ref: reviewBundle.settlementCoreRef, kind: 'content_review_settlement_core', what: 'review settlement core', resolveBlob: deps.resolveBlob });
    const coverageCore = await resolveAs<ContentReviewCoverageCoreV2>({ taskId, ref: settlementCore.coverageCoreRef, kind: 'content_review_coverage_core', what: 'review coverage core', resolveBlob: deps.resolveBlob });

    let mapReviewBundle: MapReviewBundleV2 | null = null;
    let mapSettlementCore: MapReviewSettlementCoreV2 | null = null;
    if (activeMapReviewBundleRef.digest.length !== 0) {
      try {
        mapReviewBundle = await resolveAs<MapReviewBundleV2>({ taskId, ref: activeMapReviewBundleRef, kind: 'map_review_bundle', what: 'active MapReviewBundle', resolveBlob: deps.resolveBlob });
        mapSettlementCore = await resolveAs<MapReviewSettlementCoreV2>({ taskId, ref: mapReviewBundle.settlementCoreRef, kind: 'map_review_settlement_core', what: 'Map review settlement core', resolveBlob: deps.resolveBlob });
      } catch {
        // Conservative: an unresolvable/changed MapReviewBundle cannot prove the
        // Map pre-review passed under the current authority -> condition 3 fails.
        mapReviewBundle = null;
        mapSettlementCore = null;
      }
    }

    // ---- Conditions 4/5: committed coverage facts of the seal round ----
    const slotFacts = new Map<string, SlotCoverageFact>();
    const relationVerdicts = new Map<string, 'satisfied' | 'violated'>();
    for (const ledgerRef of coverageCore.coverageLedgerRootRefs) {
      let ledger: AssignmentLedgerBlobV2;
      try {
        ledger = await resolveAs<AssignmentLedgerBlobV2>({ taskId, ref: ledgerRef, kind: 'review_assignment_ledger', what: 'coverage ledger', resolveBlob: deps.resolveBlob });
      } catch {
        continue; // unresolvable ledger => facts stay missing => gate fails coverage closed
      }
      for (const factRef of ledger.factRefs) {
        let fact: ReviewFactV2;
        try {
          fact = await resolveAs<ReviewFactV2>({ taskId, ref: factRef, kind: 'review_fact', what: 'coverage fact', resolveBlob: deps.resolveBlob });
        } catch {
          continue;
        }
        if (fact.targetKind === 'content_slot') {
          slotFacts.set(fact.targetStableId, {
            disposition: 'reviewed',
            slotId: fact.targetStableId,
            verdict: fact.verdict === 'pass' ? 'pass' : 'reject',
          });
        } else if (fact.targetKind === 'content_relation') {
          relationVerdicts.set(fact.targetStableId, fact.verdict === 'satisfied' ? 'satisfied' : 'violated');
        }
      }
    }

    // ---- Condition 9: pre-seal aggregates + input closure ----
    const preSealValidatorAggregates: PreSealValidatorAggregateV2[] = [];
    const pushAggregate = async (
      aggregateRef: BlobRefV2 | null | undefined,
      which: string,
      closure: (envelope: ValidatorInputEnvelopeV2) => boolean,
    ): Promise<void> => {
      if (aggregateRef === null || aggregateRef === undefined) {
        preSealValidatorAggregates.push({ outcome: 'infrastructure_failure', advisoryReceiptCount: 0, inputClosureMatchesBaseline: false });
        return;
      }
      try {
        const aggregate = await resolveAs<ValidatorAggregateV2>({ taskId, ref: aggregateRef, kind: 'validator_aggregate', what: which, resolveBlob: deps.resolveBlob });
        let closureOk = false;
        try {
          const envelope = await resolveAs<ValidatorInputEnvelopeV2>({ taskId, ref: aggregate.inputRef, kind: 'validator_input_envelope', what: `${which} input envelope`, resolveBlob: deps.resolveBlob });
          closureOk = closure(envelope);
        } catch {
          closureOk = false;
        }
        preSealValidatorAggregates.push({
          outcome: aggregate.outcome,
          advisoryReceiptCount: aggregate.advisoryReceiptRefs.length,
          inputClosureMatchesBaseline: closureOk,
        });
      } catch {
        preSealValidatorAggregates.push({ outcome: 'infrastructure_failure', advisoryReceiptCount: 0, inputClosureMatchesBaseline: false });
      }
    };
    await pushAggregate(settlementCore.reviewSettlementValidatorAggregateRef, 'content review settlement aggregate', (envelope) =>
      envelope.trigger === 'review_settlement' && sameRef(envelope.contentReviewCoverageCoreRef, settlementCore.coverageCoreRef));
    if (mapReviewBundle !== null) {
      await pushAggregate(mapReviewBundle.mapActivationValidatorAggregateRef, 'map activation aggregate', (envelope) =>
        envelope.trigger === 'map_activation'
        && envelope.proposedMapCoreRef !== null
        && sameRef(envelope.proposedMapCoreRef, mapReviewBundle.proposedMapCoreRef));
    }
    if (mapSettlementCore !== null) {
      await pushAggregate(mapSettlementCore.mapReviewSettlementValidatorAggregateRef, 'map review settlement aggregate', (envelope) =>
        envelope.trigger === 'map_review_settlement' && sameRef(envelope.mapReviewCoverageCoreRef, mapSettlementCore.coverageCoreRef));
    }

    // ---- Condition 2 manifest identity + content roots (display aliases) ----
    let manifest: ContentRevisionManifestV2;
    let reviewManifest: ContentRevisionManifestV2;
    if (sameRef(coverageCore.contentRevisionManifestRef, baseFinalizedManifestRef)) {
      manifest = await resolveAs<ContentRevisionManifestV2>({ taskId, ref: baseFinalizedManifestRef, kind: 'content_revision_manifest', what: 'current finalized manifest', resolveBlob: deps.resolveBlob });
      reviewManifest = manifest;
    } else {
      manifest = await resolveAs<ContentRevisionManifestV2>({ taskId, ref: baseFinalizedManifestRef, kind: 'content_revision_manifest', what: 'current finalized manifest', resolveBlob: deps.resolveBlob });
      reviewManifest = await resolveAs<ContentRevisionManifestV2>({ taskId, ref: coverageCore.contentRevisionManifestRef, kind: 'content_revision_manifest', what: 'review bundle manifest', resolveBlob: deps.resolveBlob });
    }

    // ---- Condition 6: whole-tree observation on a settled round ----
    const round = projection.contentRounds[coverageCore.reviewRoundId];
    const wholeTreeObservationComplete =
      round !== undefined
      && round.state === 'settled'
      && coverageCore.wholeTreeObservationRootRefs.length > 0;

    // ---- Condition 7: projected findings (system-derived states) ----
    const blockingFindings = Object.entries(projection.findings).map(([findingId, f]) => ({
      findingId,
      severity: f.severity,
      status: f.state,
    }));

    // ---- Condition 8: pending/stale reviews + active repair grant ----
    let pendingOrStaleReviewTargetCount = 0;
    for (const roundState of [...Object.values(projection.contentRounds), ...Object.values(projection.mapRounds)]) {
      if (roundState.state === 'planned' || roundState.state === 'reviewing') pendingOrStaleReviewTargetCount += 1;
    }
    for (const wi of Object.values(projection.workItems)) {
      const pendingReviewTarget = REVIEW_SESSION_KINDS.includes(wi.sessionKind ?? '')
        && NON_TERMINAL_WORK_ITEM_STATES.includes(wi.state);
      if (pendingReviewTarget) pendingOrStaleReviewTargetCount += 1;
    }
    let activeRepairGrant = false;
    for (const wi of Object.values(projection.workItems)) {
      if (REPAIR_SESSION_KINDS.includes(wi.sessionKind ?? '') && NON_TERMINAL_WORK_ITEM_STATES.includes(wi.state)) {
        activeRepairGrant = true;
      }
    }

    // ---- Condition 10: resolved vs frozen template identity ----
    const gateTemplateSnapshotHash = template.templateSnapshotHash;
    const gateAssemblerDigest = template.assembler.implementationDigest;
    const gateResourceManifestDigest = template.resourceManifestDigest;

    // ---- Condition 4: split set slots from optional-unset slots, fail-closed ----
    // Every manifest entry resolves to a content_version. 'set' entries are
    // required-set (they need a committed reviewed-pass fact — optional-set
    // slots are treated identically per §11.6). 'unset' entries (optional-unset
    // in a finalized manifest; required-unset/rewrite_required are illegal) are
    // put into optionalUnsetSlotIds WITHOUT any absence fact: the frozen schema
    // cannot prove the system absent_not_applicable fact exists (it is produced
    // by round planning, not committed ledgers), so the gate reports
    // PRESENCE_COVERAGE_INCOMPLETE instead of accepting a fabricated absence.
    // KNOWN GAP: positive reconstruction of both the absence facts and adopted
    // historical coverage (adoption records carry only a factId string — no
    // verdict, no fact ref) needs a design/schema revision before a later task
    // (currently fails closed, never guessed).
    const requiredSetSlots: string[] = [];
    const optionalUnsetSlotIds: string[] = [];
    const optionalUnsetSlots = new Map<string, SlotCoverageFact>();
    for (const entry of manifest.entries) {
      let version: SlotContentVersionV2 | null = null;
      try {
        version = await resolveAs<SlotContentVersionV2>({ taskId, ref: entry.versionRef, kind: 'content_version', what: `content version of slot '${entry.slotId}'`, resolveBlob: deps.resolveBlob });
      } catch {
        version = null;
      }
      if (version === null || version.state === 'unset' || version.state === 'rewrite_required') {
        // unresolvable or non-set: the slot's presence/absence is unprovable
        // from the blob closure => fail closed (the gate demands an absence
        // fact we can never positively prove).
        optionalUnsetSlotIds.push(entry.slotId);
        continue;
      }
      requiredSetSlots.push(entry.slotId);
    }

    const gateActiveMapReviewBundleRef: BlobRefV2 = mapReviewBundle === null
      ? { kind: 'map_review_bundle', digest: '', byteLength: 0, mediaType: 'application/json', schemaVersion: 1 }
      : activeMapReviewBundleRef;

    const gate: SealGateInputV2 = {
      taskId,
      templateSnapshotHash: gateTemplateSnapshotHash,
      assemblerDigest: gateAssemblerDigest,
      resourceManifestDigest: gateResourceManifestDigest,
      frozenTemplateSnapshotHash: installed.templateSnapshotHash,
      frozenAssemblerDigest: installed.assembler.implementationDigest,
      frozenResourceManifestDigest: installed.resourceManifestDigest,
      activeMapRef,
      activeMapSemanticDigest,
      activeMapReviewBundleRef: gateActiveMapReviewBundleRef,
      mapRefInMapReviewBundle: coverageCore.mapRef,
      reviewBundleRef,
      baseFinalizedManifestRef,
      reviewBundleCoverageManifestRef: coverageCore.contentRevisionManifestRef,
      contentRootDigest: manifest.contentRootDigest,
      contentRootDigestOfReviewBundle: reviewManifest.contentRootDigest,
      requiredSetSlots,
      slotFacts,
      optionalUnsetSlotIds,
      optionalUnsetSlots,
      blockingRelationIds: mapSnapshot.relations
        .filter((rel) => template.relationEnforcement.get(rel.typeId) === 'blocking')
        .map((rel) => rel.relationId),
      relationVerdicts,
      wholeTreeObservationComplete,
      blockingFindings,
      pendingOrStaleReviewTargetCount,
      activeRepairGrant,
      preSealValidatorAggregates,
    };

    const assemblerInput = await deps.buildAssemblerInput({
      taskId,
      activeMapRef,
      contentRevisionManifestRef: baseFinalizedManifestRef,
      reviewBundleRef,
      templateSnapshotHash: template.templateSnapshotHash,
    });

    return {
      gate,
      assembler: template.assembler,
      assemblerInput,
      submitter: await deps.submitterIdentity(),
    };
  };
}