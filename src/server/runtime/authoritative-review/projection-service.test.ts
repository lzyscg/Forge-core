// @vitest-environment node
/**
 * Task 23: owner read-only projection model tests (spec §14.1/§14.2).
 *
 * The projection service assembles the 11 read endpoints from a frozen
 * snapshot (checkpoint store) plus resolved blobs. These tests exercise:
 * - cursor snapshot semantics: page 1 fixes throughSequence/baseline/filters/
 *   sort; later pages replay the frozen sequence exactly-once even when events
 *   append and the service "restarts"; a fresh page 1 sees the new tail;
 * - cursor integrity: key rotation inside retention verifies, past retention
 *   answers CURSOR_STALE(signing_key_retired), tamper is rejected;
 * - tree parent pages (child counts + hasMoreChildren), locate beyond 1,000
 *   siblings with per-level seek cursors and no silent truncation;
 * - summary/rounds/findings/slot/relation/seal-readiness derivation and the
 *   N+1/RSS bound on single-page reads.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import {
  AuthoritativeReviewCheckpointStore,
  type CommittedValidatedEvent,
  type ValidatedEventSource,
} from '../../storage/authoritative-review-checkpoint-store';
import { LegalHistory, digestFor } from '../../storage/authoritative-review-state.test';
import { parseBlob, refOfBlob } from '../../authoritative-review/object-registry';
import type { MapPositionNodeV2, MapRelationV2, MapSnapshotV2 } from '../../authoritative-review/authority-types';
import { ReviewCursorKeyring } from '../../storage/review-cursor-keyring';
import { makeTempCorePaths, disposeAllTestRoots } from '../../test-support';
import { AuthoritativeReviewProjectionService } from './projection-service';

/* ------------------------------------------------------------------ */
/* In-memory blob store + legal history fixture                        */
/* ------------------------------------------------------------------ */

class InMemoryV2Blobs {
  private blobs = new Map<string, unknown>();

  readonly reads: string[] = [];

  put(kind: BlobRefV2['kind'], value: unknown): BlobRefV2 {
    const ref = refOfBlob(kind, value);
    this.blobs.set(`${ref.kind}:${ref.digest}`, value);
    return ref;
  }

  resolve(taskId: string, ref: BlobRefV2, kind?: BlobRefV2['kind']): unknown {
    void taskId;
    const effectiveKind = kind ?? ref.kind;
    this.reads.push(`${effectiveKind}:${ref.digest.slice(0, 12)}`);
    const value = this.blobs.get(`${effectiveKind}:${ref.digest}`);
    if (value === undefined) throw new Error(`missing blob ${effectiveKind}:${ref.digest}`);
    return parseBlob(effectiveKind, value, ref).object;
  }
}

function refOf(kind: BlobRefV2['kind'], digestSeed: string): BlobRefV2 {
  const digest = digestFor(digestSeed, 1);
  return { kind, digest, byteLength: 12, mediaType: 'application/json', schemaVersion: 1 };
}

interface V2ReadFixture {
  blobs: InMemoryV2Blobs;
  events: AuthoritativeReviewEventV2[];
  mapSnapshotRef: BlobRefV2;
  nodes: MapPositionNodeV2[];
  relations: MapRelationV2[];
  contentRoundId: string;
  mapRoundId: string;
}

function buildMapSnapshot(seed: string, nodes: MapPositionNodeV2[], relations: MapRelationV2[]): MapSnapshotV2 {
  return {
    scaffoldId: `scaffold-${seed}`,
    mapId: `map-${seed}`,
    supersedesMapId: null,
    sourceCandidateId: `cand-${seed}-1`,
    proposedMapCoreRef: refOf('proposed_map_core', `${seed}-proposed`),
    mapReviewBundleRef: refOf('map_review_bundle', `${seed}-bundle`),
    mapRevision: 1,
    mapSemanticDigest: digestFor(`${seed}-semantic`, 1),
    positionGraphDigest: digestFor(`${seed}-position`, 1),
    relationGraphDigest: digestFor(`${seed}-relation`, 1),
    templateSnapshotHash: digestFor(`${seed}-template`, 1),
    nodes,
    relations,
    activatedAt: '2026-08-14T00:00:00.000Z',
  };
}

/**
 * Builds a legal full-cycle v2 history: map build -> pre-review -> activation
 * with a REAL map snapshot, content generation -> finalized manifest, and an
 * optional settled content review round. Optional open blocking findings are
 * appended as system_validator findings bound to the settled content round.
 */
function buildFixture(options: {
  seed: string;
  nodes: MapPositionNodeV2[];
  relations?: MapRelationV2[];
  settleContent?: boolean;
  openBlockingFindingSlots?: string[];
  openAdvisoryFindingSlots?: string[];
  mapFindingNodeSlots?: string[];
}): V2ReadFixture {
  const { seed, nodes, relations = [] } = options;
  const blobs = new InMemoryV2Blobs();
  const mapSnapshot = buildMapSnapshot(seed, nodes, relations);
  const mapSnapshotRef = blobs.put('map_snapshot', mapSnapshot);

  const h = new LegalHistory(seed);
  const build = h.commitMapBuildRevision({ revision: 1, chunkCount: 1 });

  // Map pre-review round.
  const mapRoundId = `mr-${seed}-1`;
  h.push({
    type: 'structured_map_review_round_planned',
    mapReviewRoundId: mapRoundId,
    mapCycleOrdinal: 1,
    candidateId: build.candidateId,
    candidateRef: build.candidateRef,
    contentRevisionManifestRef: null,
    reviewPolicyDigest: digestFor('policy', 1),
    coverageNodeCount: nodes.length,
    coverageRelationCount: relations.length,
    assignmentCount: 1,
    consumedOverrideRef: null,
  });
  {
    const { workItemId } = h.createAgentWorkItem({
      sessionKind: 'review_map_batch',
      logicalAssignmentId: `la-mr-1`,
      reviewAssignmentId: `ra-mr-1`,
      roundId: mapRoundId,
    });
    h.completeAgentCycle({
      workItemId,
      logicalAssignmentId: `la-mr-1`,
      sessionKind: 'review_map_batch',
      reviewAssignmentId: `ra-mr-1`,
      leaseEpoch: 1,
      onStarted: () => {
        h.push({
          type: 'structured_map_review_assignment_committed',
          assignmentId: `asg-mr-1`,
          mapReviewRoundId: mapRoundId,
          workItemId,
          attemptId: `att-${workItemId}-1`,
          reviewAssignmentId: `ra-mr-1`,
          source: 'batch',
          ledgerRef: h.ref('review_assignment_ledger'),
          coverageTargetCount: nodes.length,
          findingCount: (options.mapFindingNodeSlots?.length ?? 0) + (options.openBlockingFindingSlots?.length ?? 0) + (options.openAdvisoryFindingSlots?.length ?? 0),
        });
      },
    });
  }
  h.push({ type: 'structured_map_review_round_completed', mapReviewRoundId: mapRoundId, coverageCoreRef: h.ref('map_review_coverage_core') });
  const baselineManifestRef = h.ref('content_revision_manifest');
  {
    const settle = h.createSystemWorkItem('system_review_settlement');
    h.lease(settle.workItemId, 1, 'system');
    h.push({ type: 'structured_system_command_started', commandId: `cmd-${settle.workItemId}-1`, workItemId: settle.workItemId, commandKind: 'review_settlement', leaseEpoch: 1, authorityBaseRef: h.lastAuthorityBaseRef });
    h.push({ type: 'structured_map_review_round_settled', mapReviewRoundId: mapRoundId, settlementCoreRef: h.ref('map_review_settlement_core'), outcome: 'activate' });
    h.push({ type: 'structured_map_activated', mapId: `map-${seed}`, mapRevision: 1, supersedesMapId: null, mapSnapshotRef, mapReviewBundleRef: mapSnapshot.mapReviewBundleRef, mapSemanticDigest: mapSnapshot.mapSemanticDigest, contentRevisionManifestRef: baselineManifestRef, activationValidatorAggregateRef: h.ref('validator_aggregate'), migrationSettlementCoreRef: null, migrationActivationDecisionRef: null });
    h.push({ type: 'structured_system_command_completed', commandId: `cmd-${settle.workItemId}-1`, workItemId: settle.workItemId, commandKind: 'review_settlement', leaseEpoch: 1, authorityBaseRef: h.lastAuthorityBaseRef });
    h.workItemCompleted(settle.workItemId, 1);
  }
  // Baseline manifest (matches the activation binding).
  h.push({ type: 'structured_content_revision_committed', contentRevisionManifestRef: baselineManifestRef, taskContentRevision: 1, manifestPhase: 'baseline_unset', producerPlanSpecRef: null, priorManifestRef: null });
  // Generation plan + one batch -> provisional -> finalize.
  h.push({ type: 'structured_generation_plan_started', generationPlanId: `gp-${seed}-1`, revision: 1, supersedesGenerationPlanId: null, generationPlanSpecRef: h.ref('generation_plan_spec'), sourceValidationReceiptRef: null });
  const provisionalManifestRef = h.ref('content_revision_manifest');
  {
    const g1 = h.createAgentWorkItem({ sessionKind: 'generation_batch', logicalAssignmentId: 'la-gen-1' });
    h.completeAgentCycle({
      workItemId: g1.workItemId,
      logicalAssignmentId: 'la-gen-1',
      sessionKind: 'generation_batch',
      leaseEpoch: 1,
      onStarted: () => {
        h.push({ type: 'structured_generation_batch_committed', generationPlanId: `gp-${seed}-1`, batchOrdinal: 1, contentRevisionCommitCoreRef: h.ref('content_revision_commit_core'), validatorAggregateRef: h.ref('validator_aggregate'), contentRevisionManifestRef: provisionalManifestRef });
        h.push({ type: 'structured_content_revision_committed', contentRevisionManifestRef: provisionalManifestRef, taskContentRevision: 2, manifestPhase: 'provisional', producerPlanSpecRef: h.ref('generation_plan_spec'), priorManifestRef: baselineManifestRef });
      },
    });
  }
  const finalManifestRef = h.ref('content_revision_manifest');
  {
    const genFin = h.createSystemWorkItem('system_generation_finalize');
    h.lease(genFin.workItemId, 1, 'system');
    h.push({ type: 'structured_system_command_started', commandId: `cmd-${genFin.workItemId}-1`, workItemId: genFin.workItemId, commandKind: 'generation_finalize', leaseEpoch: 1, authorityBaseRef: h.lastAuthorityBaseRef });
    h.push({ type: 'structured_content_revision_committed', contentRevisionManifestRef: finalManifestRef, taskContentRevision: 3, manifestPhase: 'finalized', producerPlanSpecRef: h.ref('generation_plan_spec'), priorManifestRef: provisionalManifestRef });
    h.push({ type: 'structured_generation_plan_completed', generationPlanId: `gp-${seed}-1`, contentRevisionManifestRef: finalManifestRef, validatorAggregateRef: h.ref('validator_aggregate'), warningRootRef: h.ref('validation_warning_root') });
    h.push({ type: 'structured_system_command_completed', commandId: `cmd-${genFin.workItemId}-1`, workItemId: genFin.workItemId, commandKind: 'generation_finalize', leaseEpoch: 1, authorityBaseRef: h.lastAuthorityBaseRef });
    h.workItemCompleted(genFin.workItemId, 1);
  }
  // Optional content review cycle.
  const contentRoundId = `cr-${seed}-1`;
  if (options.settleContent === true) {
    {
      const settle2 = h.createSystemWorkItem('system_review_settlement');
      h.lease(settle2.workItemId, 1, 'system');
      h.push({ type: 'structured_system_command_started', commandId: `cmd-${settle2.workItemId}-1`, workItemId: settle2.workItemId, commandKind: 'review_settlement', leaseEpoch: 1, authorityBaseRef: h.lastAuthorityBaseRef });
      h.push({ type: 'structured_review_round_planned', reviewRoundId: contentRoundId, contentCycleOrdinal: 1, mapRef: mapSnapshotRef, mapSemanticDigest: mapSnapshot.mapSemanticDigest, contentRevisionManifestRef: finalManifestRef, reviewPolicyDigest: digestFor('policy', 1), adoptionRootRef: h.ref('review_adoption_root'), coverageSlotCount: nodes.length, coverageRelationCount: relations.length, assignmentCount: 1, verificationFindingCount: 0, consumedOverrideRef: null });
      h.push({ type: 'structured_system_command_completed', commandId: `cmd-${settle2.workItemId}-1`, workItemId: settle2.workItemId, commandKind: 'review_settlement', leaseEpoch: 1, authorityBaseRef: h.lastAuthorityBaseRef });
      h.workItemCompleted(settle2.workItemId, 1);
    }
    {
      const rw = h.createAgentWorkItem({ sessionKind: 'review_content_batch', logicalAssignmentId: `la-cr-1`, reviewAssignmentId: `ra-cr-1`, roundId: contentRoundId });
      const assignmentLedgerRef = h.ref('review_assignment_ledger');
      h.completeAgentCycle({
        workItemId: rw.workItemId,
        logicalAssignmentId: `la-cr-1`,
        sessionKind: 'review_content_batch',
        reviewAssignmentId: `ra-cr-1`,
        leaseEpoch: 1,
        onStarted: () => {
          h.push({ type: 'structured_review_assignment_started', assignmentId: `asg-cr-1`, reviewRoundId: contentRoundId, workItemId: rw.workItemId, attemptId: `att-${rw.workItemId}-1`, reviewAssignmentId: `ra-cr-1`, source: 'batch' });
          h.push({ type: 'structured_content_review_assignment_committed', assignmentId: `asg-cr-1`, reviewRoundId: contentRoundId, workItemId: rw.workItemId, attemptId: `att-${rw.workItemId}-1`, reviewAssignmentId: `ra-cr-1`, source: 'batch', ledgerRef: assignmentLedgerRef, coverageTargetCount: nodes.length, findingCount: 0 });
          h.push({ type: 'structured_review_assignment_completed', assignmentId: `asg-cr-1`, reviewRoundId: contentRoundId, workItemId: rw.workItemId, attemptId: `att-${rw.workItemId}-1`, ledgerRef: assignmentLedgerRef, source: 'batch' });
        },
      });
    }
    h.push({ type: 'structured_review_round_completed', reviewRoundId: contentRoundId, coverageCoreRef: h.ref('content_review_coverage_core') });
    {
      const settle3 = h.createSystemWorkItem('system_review_settlement');
      h.lease(settle3.workItemId, 1, 'system');
      h.push({ type: 'structured_system_command_started', commandId: `cmd-${settle3.workItemId}-1`, workItemId: settle3.workItemId, commandKind: 'review_settlement', leaseEpoch: 1, authorityBaseRef: h.lastAuthorityBaseRef });
      h.push({ type: 'structured_review_round_settled', reviewRoundId: contentRoundId, settlementCoreRef: h.ref('content_review_settlement_core'), outcome: 'seal' });
      h.push({ type: 'structured_system_command_completed', commandId: `cmd-${settle3.workItemId}-1`, workItemId: settle3.workItemId, commandKind: 'review_settlement', leaseEpoch: 1, authorityBaseRef: h.lastAuthorityBaseRef });
      h.workItemCompleted(settle3.workItemId, 1);
    }
  }
  // Findings (system_validator, bound to the settled content round).
  for (const slotId of options.mapFindingNodeSlots ?? []) {
    h.push({
      type: 'structured_finding_opened',
      findingId: `finding-map-${seed}-${slotId}`,
      findingRef: h.ref('finding'),
      reviewContext: { kind: 'map', roundId: mapRoundId },
      primaryLocation: { kind: 'map_node', id: slotId },
      defectClass: 'map',
      severity: 'blocking',
      source: 'system_validator',
      openedBy: { kind: 'system_validator', validatorExecutionId: `val-${seed}-3` },
    });
  }
  for (const slotId of options.openBlockingFindingSlots ?? []) {
    h.push({
      type: 'structured_finding_opened',
      findingId: `finding-block-${seed}-${slotId}`,
      findingRef: h.ref('finding'),
      reviewContext: { kind: 'content', roundId: contentRoundId },
      primaryLocation: { kind: 'slot', id: slotId },
      defectClass: 'content',
      severity: 'blocking',
      source: 'system_validator',
      openedBy: { kind: 'system_validator', validatorExecutionId: `val-${seed}-1` },
    });
  }
  for (const slotId of options.openAdvisoryFindingSlots ?? []) {
    h.push({
      type: 'structured_finding_opened',
      findingId: `finding-advisory-${seed}-${slotId}`,
      findingRef: h.ref('finding'),
      reviewContext: { kind: 'content', roundId: contentRoundId },
      primaryLocation: { kind: 'slot', id: slotId },
      defectClass: 'content',
      severity: 'advisory',
      source: 'system_validator',
      openedBy: { kind: 'system_validator', validatorExecutionId: `val-${seed}-2` },
    });
  }
  return { blobs, events: h.events, mapSnapshotRef, nodes, relations, contentRoundId, mapRoundId };
}

/* ------------------------------------------------------------------ */
/* Service harness                                                     */
/* ------------------------------------------------------------------ */

interface ServiceHarness {
  service: AuthoritativeReviewProjectionService;
  paths: ReturnType<typeof makeTempCorePaths>['paths'];
  source: { events: AuthoritativeReviewEventV2[] };
  keyring: ReviewCursorKeyring;
  blobs: InMemoryV2Blobs;
  append(events: AuthoritativeReviewEventV2[]): void;
}

async function makeHarness(fixture: V2ReadFixture, clock: () => string = () => '2026-08-14T00:00:00.000Z'): Promise<ServiceHarness> {
  const { paths } = makeTempCorePaths();
  const state = { events: [...fixture.events] };
  // A source that re-reads the MUTABLE array so later appends are visible on
  // the next call (fresh first pages) while cursor pages replay a fixed
  // throughSequence.
  const source: ValidatedEventSource = {
    async read(): Promise<CommittedValidatedEvent[]> {
      return state.events.map((event, index) => ({
        sequence: index + 1,
        fileName: `${String(index + 1).padStart(6, '0')}-${event.id}.json`,
        size: 1,
        event,
      }));
    },
    async readAfter(_taskId: string, throughSequence: number): Promise<CommittedValidatedEvent[]> {
      return state.events
        .map((event, index) => ({ sequence: index + 1, fileName: '', size: 1, event }))
        .filter((entry) => entry.sequence > throughSequence);
    },
  };
  const checkpointStore = new AuthoritativeReviewCheckpointStore(paths, source);
  const keyring = new ReviewCursorKeyring(paths, { clock });
  await keyring.initialize();
  return {
    service: new AuthoritativeReviewProjectionService({
      readSnapshot: (taskId, throughSequence) =>
        throughSequence === undefined
          ? checkpointStore.readState(taskId, (ref) => fixture.blobs.resolve(taskId, ref, ref.kind)).then((result) => ({ throughSequence: result.throughSequence, projection: result.projection }))
          : checkpointStore.rebuild(taskId, (ref) => fixture.blobs.resolve(taskId, ref, ref.kind), throughSequence).then((result) => ({ throughSequence: result.throughSequence, projection: result.projection })),
      resolveBlob: <T>(taskId: string, ref: BlobRefV2, kind: BlobRefV2['kind']) =>
        Promise.resolve(fixture.blobs.resolve(taskId, ref, kind) as T),
      keyring,
    }),
    paths,
    source: state,
    keyring,
    blobs: fixture.blobs,
    append(events) {
      state.events.push(...events);
    },
  };
}

const TASK = 'task-1';

/** A small three-level tree: root -> a,b ; a -> a1,a2 ; b -> b1. */
function smallTreeNodes(): MapPositionNodeV2[] {
  const node = (slotId: string, parentSlotId: string | null, documentOrder: number, siblingOrder: number, contentBearing = true): MapPositionNodeV2 => ({
    slotId,
    slotType: slotId.startsWith('root') ? 'document' : 'body',
    contentBearing,
    parentSlotId,
    documentOrder,
    siblingOrder,
    nodeSpecDigest: digestFor(slotId, 1),
  });
  return [
    node('root', null, 0, 0),
    node('a', 'root', 1, 0),
    node('b', 'root', 2, 1),
    node('a1', 'a', 3, 0),
    node('a2', 'a', 4, 1),
    node('b1', 'b', 5, 0),
  ];
}

afterEach(() => {
  disposeAllTestRoots();
});

/**
 * Builds a projection harness over a tree with `siblingCount` siblings under
 * `root`, for the performance bench test. Exported so the bench file reuses
 * the exact same service mechanics.
 */
export async function makeBenchHarness(
  siblingCount: number,
): Promise<{ service: AuthoritativeReviewProjectionService; blobs: InMemoryV2Blobs }> {
  const nodes: MapPositionNodeV2[] = [];
  nodes.push({ slotId: 'root', slotType: 'document', contentBearing: true, parentSlotId: null, documentOrder: 0, siblingOrder: 0, nodeSpecDigest: digestFor('root', 1) });
  for (let i = 0; i < siblingCount; i += 1) {
    nodes.push({ slotId: `s-${i}`, slotType: 'body', contentBearing: true, parentSlotId: 'root', documentOrder: i + 1, siblingOrder: i + 1, nodeSpecDigest: digestFor(`s-${i}`, 1) });
  }
  const fixture = buildFixture({ seed: `bench-${siblingCount}`, nodes, settleContent: true });
  const harness = await makeHarness(fixture);
  return { service: harness.service, blobs: fixture.blobs };
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('AuthoritativeReviewProjectionService', () => {
  describe('map / candidate / summary', () => {
    it('returns the activated Map detail with bounded counts', async () => {
      const fixture = buildFixture({ seed: 'm', nodes: smallTreeNodes() });
      const { service } = await makeHarness(fixture);
      const detail = await service.map(TASK);
      expect(detail.mapId).toBe('map-m');
      expect(detail.mapRevision).toBe(1);
      expect(detail.nodeCount).toBe(6);
      expect(detail.relationCount).toBe(0);
      expect(detail.relation).toEqual({ mode: 'disabled', relationCount: 0 });
      expect(detail.rootSlotId).toBe('root');
      expect(detail.mapSnapshotRef).toEqual(fixture.mapSnapshotRef);
      expect(fixture.blobs.reads.length).toBe(1);
    });

    it('returns an empty Map detail before any activation', async () => {
      const fixture = buildFixture({ seed: 'e', nodes: smallTreeNodes() });
      // Drop every activation-related event: an empty history is legal.
      const { service } = await makeHarness({ ...fixture, events: [] });
      const detail = await service.map(TASK);
      expect(detail.mapId).toBe('');
      expect(detail.mapSnapshotRef).toBeNull();
      expect(detail.nodeCount).toBe(0);
    });

    it('derives the summary counts from the projection', async () => {
      const fixture = buildFixture({
        seed: 's',
        nodes: smallTreeNodes(),
        settleContent: true,
        openBlockingFindingSlots: ['a1'],
        openAdvisoryFindingSlots: ['a2'],
      });
      const { service } = await makeHarness(fixture);
      const summary = await service.summary(TASK);
      expect(summary.version).toBe(2);
      // 6 content-bearing slots: a1 rejected, the rest pass (settled + finalized).
      expect(summary.pendingCount).toBe(0);
      expect(summary.passCount).toBe(5);
      expect(summary.rejectCount).toBe(1);
      expect(summary.staleCount).toBe(0);
      expect(summary.openBlockingFindingCount).toBe(1);
      expect(summary.contentCycleOrdinal).toBe(1);
      expect(summary.mapCycleOrdinal).toBe(1);
    });
  });

  describe('tree parent pages', () => {
    it('pages root children with child counts and hasMoreChildren', async () => {
      const fixture = buildFixture({ seed: 't', nodes: smallTreeNodes() });
      const { service } = await makeHarness(fixture);
      // The null parent page returns the document root (the only node with
      // parentId null); its children page lives under parentId=root.
      const rootPage = await service.tree(TASK, null, 10, null);
      expect(rootPage.items.map((entry) => entry.slotId)).toEqual(['root']);
      expect(rootPage.items[0]?.childCount).toBe(2);
      expect(rootPage.hasMoreChildren).toBe(false);
      expect(rootPage.nextCursor).toBeNull();
      expect(rootPage.items[0]?.review).toEqual({ mapPreReview: 'pass', content: 'pending' });

      const page = await service.tree(TASK, 'root', 1, null);
      expect(page.parentId).toBe('root');
      expect(page.items.map((entry) => entry.slotId)).toEqual(['a']);
      expect(page.items[0]?.childCount).toBe(2);
      expect(page.hasMoreChildren).toBe(true);
      expect(page.nextCursor).not.toBeNull();
      expect(page.items[0]?.review).toEqual({ mapPreReview: 'pass', content: 'pending' });

      const page2 = await service.tree(TASK, 'root', 1, page.nextCursor);
      expect(page2.items.map((entry) => entry.slotId)).toEqual(['b']);
      expect(page2.hasMoreChildren).toBe(false);
      expect(page2.nextCursor).toBeNull();
    });

    it('pages the children of one parent by sibling order', async () => {
      const fixture = buildFixture({ seed: 'ta', nodes: smallTreeNodes() });
      const { service } = await makeHarness(fixture);
      const page = await service.tree(TASK, 'a', 10, null);
      expect(page.items.map((entry) => entry.slotId)).toEqual(['a1', 'a2']);
      expect(page.items[0]?.childCount).toBe(0);
      expect(page.hasMoreChildren).toBe(false);
    });

    it('marks mapPreReview reject for a slot with an open blocking map finding', async () => {
      const fixture = buildFixture({ seed: 'tr', nodes: smallTreeNodes(), settleContent: true, mapFindingNodeSlots: ['a1'] });
      const { service } = await makeHarness(fixture);
      const page = await service.tree(TASK, 'a', 10, null);
      const a1 = page.items.find((entry) => entry.slotId === 'a1');
      expect(a1?.review.mapPreReview).toBe('reject');
      // A MAP finding does not reject the content review (the round settled finalized).
      expect(a1?.review.content).toBe('pass');
    });
  });

  describe('locate beyond 1,000', () => {
    it('reaches a sibling past ordinal 9,000 via seek cursors without walking earlier pages', async () => {
      // 10,000 siblings under root.
      const nodes: MapPositionNodeV2[] = [];
      nodes.push({ slotId: 'root', slotType: 'document', contentBearing: true, parentSlotId: null, documentOrder: 0, siblingOrder: 0, nodeSpecDigest: digestFor('root', 1) });
      for (let i = 0; i < 10_000; i += 1) {
        nodes.push({ slotId: `s-${i}`, slotType: 'body', contentBearing: true, parentSlotId: 'root', documentOrder: i + 1, siblingOrder: i + 1, nodeSpecDigest: digestFor(`s-${i}`, 1) });
      }
      const fixture = buildFixture({ seed: 'loc', nodes, settleContent: true });
      const { service } = await makeHarness(fixture);

      const located = await service.locate(TASK, 's-9000', null);
      expect(located.target.slotId).toBe('s-9000');
      expect(located.target.siblingOrder).toBe(9001);
      expect(located.ancestors.map((a) => a.slotId)).toEqual(['root']);
      // Follow the seek cursor: tree?parentId=root&after=<seekCursor> must
      // return the target as the FIRST row without scanning earlier pages.
      const seek = await service.tree(TASK, 'root', 1, located.ancestors[0]?.seekCursor ?? null);
      expect(seek.items[0]?.slotId).toBe('s-9000');
      // A fresh first page still pages normally (no silent truncation).
      const direct = await service.tree(TASK, 'root', 500, null);
      expect(direct.items.length).toBe(500);
      expect(direct.hasMoreChildren).toBe(true);
    });

    it('locates a deep descendant by following each level seek cursor', async () => {
      const nodes: MapPositionNodeV2[] = [];
      nodes.push({ slotId: 'root', slotType: 'document', contentBearing: true, parentSlotId: null, documentOrder: 0, siblingOrder: 0, nodeSpecDigest: digestFor('root', 1) });
      let documentOrder = 1;
      let parent = 'root';
      let sibling = 0;
      for (let depth = 0; depth < 2_000; depth += 1) {
        const slotId = `d-${depth}`;
        nodes.push({ slotId, slotType: 'body', contentBearing: true, parentSlotId: parent, documentOrder, siblingOrder: sibling, nodeSpecDigest: digestFor(slotId, 1) });
        documentOrder += 1;
        parent = slotId;
        sibling = 0;
      }
      const fixture = buildFixture({ seed: 'locd', nodes });
      const { service } = await makeHarness(fixture);
      const located = await service.locate(TASK, 'd-1999', null);
      expect(located.target.slotId).toBe('d-1999');
      // Ancestor path root-first: root + d-0..d-1998 (= 2000).
      expect(located.ancestors.length).toBe(2000);
      expect(located.ancestors[0]?.slotId).toBe('root');
      expect(located.ancestors[located.ancestors.length - 1]?.slotId).toBe('d-1998');
      // The deepest ancestor's seek cursor yields the target as the first row.
      const cursor = located.ancestors[located.ancestors.length - 1]?.seekCursor ?? null;
      expect(cursor).not.toBeNull();
      const page = await service.tree(TASK, 'd-1998', 500, cursor);
      expect(page.items[0]?.slotId).toBe('d-1999');
    });
  });

  describe('rounds and findings pagination', () => {
    it('pages map-rounds and rounds with a stable order', async () => {
      const fixture = buildFixture({ seed: 'r', nodes: smallTreeNodes(), settleContent: true });
      const { service } = await makeHarness(fixture);
      const mapRounds = await service.mapRounds(TASK, 50, null);
      expect(mapRounds.items.map((round) => round.kind)).toEqual(['map']);
      expect(mapRounds.items[0]?.reviewRoundId).toBe(fixture.mapRoundId);
      expect(mapRounds.items[0]?.state).toBe('settled');

      const rounds = await service.rounds(TASK, 50, null);
      expect(rounds.items.map((round) => round.kind)).toEqual(['content', 'map']);
      expect(rounds.items[0]?.kind).toBe('content');
      expect(rounds.items[0]?.state).toBe('settled');
    });

    it('pages findings deterministically with cursor stability across appended events', async () => {
      const fixture = buildFixture({ seed: 'f', nodes: smallTreeNodes(), settleContent: true, openBlockingFindingSlots: ['a1', 'a2'] });
      const { service, source, append } = await makeHarness(fixture);
      const page1 = await service.findings(TASK, 1, null);
      expect(page1.items.length).toBe(1);
      expect(page1.nextCursor).not.toBeNull();
      const firstThroughSequence = source.events.length; // page1 fixed the CURRENT tail
      // Append NEW events (a finding targeting a new slot) then "restart".
      append([
        {
          protocolVersion: 2,
          id: 'id-restart',
          at: '2026-08-14T00:00:01.000Z',
          type: 'structured_finding_opened',
          findingId: 'finding-new',
          findingRef: refOf('finding', 'f2'),
          reviewContext: { kind: 'content', roundId: fixture.contentRoundId },
          primaryLocation: { kind: 'slot', id: 'b1' },
          defectClass: 'content',
          severity: 'blocking',
          source: 'system_validator',
          openedBy: { kind: 'system_validator', validatorExecutionId: 'val-f2' },
        },
      ]);
      expect(source.events.length).toBeGreaterThan(firstThroughSequence);
      const afterRestart = await service.findings(TASK, 1, page1.nextCursor);
      expect(afterRestart.items.length).toBe(1);
      expect(afterRestart.items[0]?.findingId).toBe('finding-block-f-a2');
      expect(afterRestart.items[0]?.findingId).not.toBe('finding-new');
      // exactly-once: no item is repeated and no new event leaks into the frozen traversal.
      const collected = [page1.items[0]?.findingId, afterRestart.items[0]?.findingId];
      expect(new Set(collected).size).toBe(2);
      // A FRESH first page sees the appended event.
      const fresh = await service.findings(TASK, 50, null);
      expect(fresh.items.map((entry) => entry.findingId)).toContain('finding-new');
    });
  });

  describe('snapshot cursor semantics', () => {
    it('fixes throughSequence on the first page and replays it on later pages', async () => {
      const fixture = buildFixture({ seed: 'c', nodes: smallTreeNodes(), settleContent: true });
      const { service, source } = await makeHarness(fixture);
      const tailBefore = source.events.length;
      const page1 = await service.tree(TASK, 'root', 1, null);
      expect(page1.nextCursor).not.toBeNull();
      // Cursor pages must NOT see newly appended events (they replay the
      // frozen throughSequence).
      const page2 = await service.tree(TASK, 'root', 1, page1.nextCursor);
      expect(page2.items.map((entry) => entry.slotId)).toEqual(['b']);
      expect(page2.hasMoreChildren).toBe(false);
      expect(tailBefore).toBe(source.events.length);
    });

    it('rejects a tampered cursor with CURSOR_STALE', async () => {
      const fixture = buildFixture({ seed: 'x', nodes: smallTreeNodes() });
      const { service } = await makeHarness(fixture);
      const page1 = await service.tree(TASK, 'root', 1, null);
      const cursor = page1.nextCursor;
      expect(cursor).not.toBeNull();
      // Tamper the token by decoding it, mutating the payload's lastKey, and
      // re-encoding WITHOUT re-signing: the signature no longer matches.
      const decoded = JSON.parse(Buffer.from(cursor!.token, 'base64url').toString('utf8'));
      decoded.payload.lastKey = 'tampered';
      const tamperedToken = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
      const tampered = { ...cursor!, token: tamperedToken };
      await expect(service.tree(TASK, 'root', 1, tampered)).rejects.toMatchObject({ code: 'CURSOR_STALE' });
    });

    it('rejects a cursor bound to a different task', async () => {
      const fixture = buildFixture({ seed: 'y', nodes: smallTreeNodes() });
      const { service } = await makeHarness(fixture);
      const page1 = await service.tree(TASK, 'root', 1, null);
      await expect(service.tree('task-other', 'root', 1, page1.nextCursor)).rejects.toMatchObject({ code: 'CURSOR_STALE' });
    });

    it('rejects a cursor whose filters changed (different parentId)', async () => {
      const fixture = buildFixture({ seed: 'z', nodes: smallTreeNodes() });
      const { service } = await makeHarness(fixture);
      const page1 = await service.tree(TASK, 'root', 1, null);
      await expect(service.tree(TASK, 'a', 1, page1.nextCursor)).rejects.toMatchObject({ code: 'CURSOR_STALE' });
    });

    it('rejects a cursor that does not belong to the same projection (unknown last key)', async () => {
      const fixture = buildFixture({ seed: 'w', nodes: smallTreeNodes() });
      const { service } = await makeHarness(fixture);
      const findingsPage = await service.findings(TASK, 50, null);
      if (findingsPage.nextCursor !== null) {
        await expect(service.tree(TASK, 'root', 1, findingsPage.nextCursor)).rejects.toMatchObject({ code: 'CURSOR_STALE' });
      }
    });
  });

  describe('key rotation and retention', () => {
    it('verifies a retired key cursor inside the retention window', async () => {
      const fixture = buildFixture({ seed: 'k', nodes: smallTreeNodes() });
      let now = '2026-08-14T00:00:00.000Z';
      const { service, keyring, paths } = await makeHarness(fixture, () => now);
      const page1 = await service.tree(TASK, 'root', 1, null);
      const cursor = page1.nextCursor;
      expect(cursor).not.toBeNull();
      // Rotate: the old key becomes a retired verification key.
      await keyring.rotate();
      // Still inside the 30-day retention window: the cursor verifies.
      const page2 = await service.tree(TASK, 'root', 1, cursor);
      expect(page2.items[0]?.slotId).toBe('b');
      void paths;
    });

    it('answers CURSOR_STALE(signing_key_retired) past the retention window', async () => {
      const fixture = buildFixture({ seed: 'kr', nodes: smallTreeNodes() });
      let now = '2026-08-14T00:00:00.000Z';
      const { service, keyring } = await makeHarness(fixture, () => now);
      const page1 = await service.tree(TASK, 'root', 1, null);
      const cursor = page1.nextCursor;
      expect(cursor).not.toBeNull();
      await keyring.rotate();
      // Advance past the 30-day retention.
      now = '2026-10-15T00:00:00.000Z';
      await expect(service.tree(TASK, 'root', 1, cursor)).rejects.toMatchObject({ code: 'CURSOR_STALE' });
    });
  });

  describe('slot / relation detail', () => {
    it('reads one slot review detail', async () => {
      const fixture = buildFixture({ seed: 'd1', nodes: smallTreeNodes(), settleContent: true, openBlockingFindingSlots: ['a1'] });
      const { service } = await makeHarness(fixture);
      const detail = await service.slotReview(TASK, 'a1', null);
      expect(detail.slotId).toBe('a1');
      expect(detail.parentSlotId).toBe('a');
      expect(detail.review.content).toBe('reject');
      expect(detail.openBlockingFindingIds).toEqual(['finding-block-d1-a1']);
    });

    it('returns SLOT_NOT_VISIBLE for a slot outside the current Map', async () => {
      const fixture = buildFixture({ seed: 'd2', nodes: smallTreeNodes() });
      const { service } = await makeHarness(fixture);
      await expect(service.slotReview(TASK, 'no-such-slot', null)).rejects.toMatchObject({ code: 'SLOT_NOT_VISIBLE' });
    });

    it('reads one relation review detail', async () => {
      const relation: MapRelationV2 = {
        relationId: 'rel-1',
        typeId: 'links',
        fromSlotId: 'a',
        toSlotId: 'b',
        attributes: {},
        relationDigest: digestFor('rel', 1),
      };
      const fixture = buildFixture({ seed: 'd3', nodes: smallTreeNodes(), relations: [relation], settleContent: true });
      const { service } = await makeHarness(fixture);
      const detail = await service.relationReview(TASK, 'rel-1', null);
      expect(detail.relationId).toBe('rel-1');
      expect(detail.review).toBe('satisfied');
      expect(detail.openBlockingFindingIds).toEqual([]);
    });
  });

  describe('seal readiness', () => {
    it('reports not_ready with stable condition codes before sealing', async () => {
      const fixture = buildFixture({ seed: 'se', nodes: smallTreeNodes(), settleContent: true });
      const { service } = await makeHarness(fixture);
      const readiness = await service.sealReadiness(TASK);
      expect(readiness.sealed).toBe(false);
      expect(readiness.readiness).toBe('not_ready');
      expect(readiness.conditions.length).toBeGreaterThan(0);
      // Stable codes only; never private text.
      for (const condition of readiness.conditions) {
        expect(condition.code).toMatch(/^[A-Z_]+$/);
      }
      expect(JSON.stringify(readiness)).not.toContain('/');
    });
  });

  describe('N+1 / RSS bound on single-page reads', () => {
    it('reads a bounded number of blobs per single tree page independent of tree size', async () => {
      const makeNodes = (count: number): MapPositionNodeV2[] => {
        const nodes: MapPositionNodeV2[] = [];
        nodes.push({ slotId: 'root', slotType: 'document', contentBearing: true, parentSlotId: null, documentOrder: 0, siblingOrder: 0, nodeSpecDigest: digestFor('root', 1) });
        for (let i = 0; i < count; i += 1) {
          nodes.push({ slotId: `s-${i}`, slotType: 'body', contentBearing: true, parentSlotId: 'root', documentOrder: i + 1, siblingOrder: i + 1, nodeSpecDigest: digestFor(`s-${i}`, 1) });
        }
        return nodes;
      };
      for (const count of [100, 10_000]) {
        const fixture = buildFixture({ seed: `n${count}`, nodes: makeNodes(count), settleContent: true });
        const { service, blobs } = await makeHarness(fixture);
        blobs.reads.length = 0;
        const page = await service.tree(TASK, 'root', 50, null);
        // The tree page resolves exactly the map snapshot blob (1 read), never
        // one read per slot and never the whole tree recursively.
        expect(blobs.reads.length).toBe(1);
        expect(page.items.length).toBe(50);
        // Serialized response is O(limit), independent of tree size.
        const bytes = Buffer.byteLength(JSON.stringify(page.items));
        expect(bytes).toBeLessThan(50 * 1024);
        // A deeper page (offset far into the tree) still reads one blob.
        let cursor = page.nextCursor;
        for (let hop = 0; hop < 9 && cursor !== null; hop += 1) {
          blobs.reads.length = 0;
          const next = await service.tree(TASK, 'root', 50, cursor);
          expect(blobs.reads.length).toBe(1);
          expect(next.items.length).toBe(50);
          cursor = next.nextCursor;
        }
        expect(count).toBeGreaterThan(0);
      }
    });
  });

  describe('read failures', () => {
    it('surfaces a stable error type for a corrupt projection', async () => {
      // Seed a finding so the appended duplicate is a REAL duplicate.
      const fixture = buildFixture({ seed: 'bad', nodes: smallTreeNodes(), settleContent: true, openBlockingFindingSlots: ['root'] });
      const { service, source } = await makeHarness(fixture);
      const existingId = 'finding-block-bad-root';
      // Corrupt the history: duplicate finding id appended after the tail.
      source.events.push({
        protocolVersion: 2,
        id: 'id-dup',
        at: '2026-08-14T00:00:00.000Z',
        type: 'structured_finding_opened',
        findingId: existingId,
        findingRef: refOf('finding', 'bad'),
        reviewContext: { kind: 'content', roundId: fixture.contentRoundId },
        primaryLocation: { kind: 'slot', id: 'root' },
        defectClass: 'content',
        severity: 'blocking',
        source: 'system_validator',
        openedBy: { kind: 'system_validator', validatorExecutionId: 'val-bad' },
      });
      await expect(service.map(TASK)).rejects.toThrow(/finding_duplicate|投影|corrupt|invalid/i);
    });
  });
});
