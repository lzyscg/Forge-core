// @vitest-environment node
/**
 * Task 18 review-adoption-service tests (design §11.4/§19, spec §7.4): ONLY
 * committed batch facts are adoption-eligible; historical facts require an
 * exact stable target/subject/context/policy match + an AdoptionRecord in the
 * current root; whole-observation facts (and adoption-ineligible facts) are
 * hard rejected; current committed and adopted target sets are disjoint;
 * adoptions are stored as bounded canonical chunks closed by one root.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import { PublicationIntentRegistry } from '../../storage/authoritative-publication-intent-registry';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { ReviewFactV2, ReviewAdoptionRecordV2 } from '../../authoritative-review/authority-types';
import { refOfBlob } from '../../authoritative-review/object-registry';
import {
  createWorkItemCoordinatorEnvironment,
  disposeRuntimeTestRoots,
} from '../test-support';
import {
  ReviewAdoptionService,
  selectAdoptableFacts,
  partitionAdoptionRecords,
  buildAdoptionLedger,
  buildAdoptionRoot,
  type AdoptionBaselineContextV2,
} from './review-adoption-service';
import { wholeObservationFact } from '../../authoritative-review/review-domain';

function batchFact(overrides: Partial<ReviewFactV2> = {}): ReviewFactV2 {
  return {
    factId: overrides.factId ?? 'fact-1',
    targetKind: 'content_slot',
    targetStableId: 's-1',
    verdict: 'pass',
    factOrigin: { kind: 'batch', adoptionEligible: true },
    adoptionEligible: true,
    localSubjectDigest: 'a'.repeat(64),
    localContextDigest: 'b'.repeat(64),
    reviewPolicyDigest: 'c'.repeat(64),
    findingIds: [],
    evidence: [],
    reviewerAttemptId: 'att-1',
    recordedAt: 't0',
    ...overrides,
  };
}

const MATCHING: AdoptionBaselineContextV2 = {
  reviewPolicyDigest: 'c'.repeat(64),
  subjectDigestOf: () => 'a'.repeat(64),
  contextDigestOf: () => 'b'.repeat(64),
};

describe('adoptable-fact selection (design §11.4 / spec §7.4)', () => {
  it('adopts a committed batch fact whose target/subject/context/policy all match the current baseline', () => {
    const { records, adoptedTargetIds } = selectAdoptableFacts({
      facts: [batchFact()],
      coverageTargetIds: ['s-1'],
      assignmentTargetIds: [],
      roundId: 'r-2',
      currentContextStableId: 'map-1',
      baseline: MATCHING,
    });
    expect(adoptedTargetIds).toEqual(['s-1']);
    expect(records).toHaveLength(1);
    const record = records[0] as ReviewAdoptionRecordV2;
    expect(record.adoptionId).toContain('r-2');
    expect(record.mapId).toBe('map-1');
    expect(record.expectedLocalSubjectDigest).toBe('a'.repeat(64));
    expect(record.adoptedBy).toBe('system');
  });

  it('rejects a whole-observation fact even when every digest matches', () => {
    const whole = wholeObservationFact(batchFact());
    const { records, adoptedTargetIds } = selectAdoptableFacts({
      facts: [whole],
      coverageTargetIds: ['s-1'],
      assignmentTargetIds: [],
      roundId: 'r-2',
      currentContextStableId: 'map-1',
      baseline: MATCHING,
    });
    expect(records).toHaveLength(0);
    expect(adoptedTargetIds).toHaveLength(0);
  });

  it('rejects an adoption-ineligible batch fact (adoptionEligible false)', () => {
    const ineligible = batchFact({ adoptionEligible: false, factOrigin: { kind: 'batch', adoptionEligible: false } as unknown as ReviewFactV2['factOrigin'] });
    const { records } = selectAdoptableFacts({
      facts: [ineligible],
      coverageTargetIds: ['s-1'],
      assignmentTargetIds: [],
      roundId: 'r-2',
      currentContextStableId: 'map-1',
      baseline: MATCHING,
    });
    expect(records).toHaveLength(0);
  });

  it('rejects a historical fact whose subject/context/policy digest differs from the current baseline', () => {
    const stale = batchFact({ localSubjectDigest: 'subject-old', localContextDigest: 'context-old', reviewPolicyDigest: 'policy-old' });
    expect(() =>
      selectAdoptableFacts({
        facts: [stale],
        coverageTargetIds: ['s-1'],
        assignmentTargetIds: [],
        roundId: 'r-2',
        currentContextStableId: 'map-1',
        baseline: MATCHING,
      }),
    ).toThrow(/subject\/context\/policy digest do not match/);
  });

  it('rejects an adopted target that is ALSO a current committed assignment target (disjoint sources)', () => {
    const { records, adoptedTargetIds } = selectAdoptableFacts({
      facts: [batchFact({ targetStableId: 's-1' }), batchFact({ factId: 'fact-2', targetStableId: 's-2' })],
      coverageTargetIds: ['s-1', 's-2'],
      // s-1 is currently assigned — it must NOT be adopted; s-2 may be.
      assignmentTargetIds: ['s-1'],
      roundId: 'r-2',
      currentContextStableId: 'map-1',
      baseline: MATCHING,
    });
    expect(adoptedTargetIds).toEqual(['s-2']);
    expect(records).toHaveLength(1);
  });

  it('deduplicates to ONE adoption per target (the first factId wins)', () => {
    const { records, adoptedTargetIds } = selectAdoptableFacts({
      facts: [batchFact({ factId: 'fact-b', targetStableId: 's-1' }), batchFact({ factId: 'fact-a', targetStableId: 's-1' })],
      coverageTargetIds: ['s-1'],
      assignmentTargetIds: [],
      roundId: 'r-2',
      currentContextStableId: 'map-1',
      baseline: MATCHING,
    });
    expect(adoptedTargetIds).toEqual(['s-1']);
    expect(records).toHaveLength(1);
    expect(records[0]?.factId).toBe('fact-a');
  });

  it('does not adopt a target outside the current round coverage', () => {
    const { records } = selectAdoptableFacts({
      facts: [batchFact({ targetStableId: 's-99' })],
      coverageTargetIds: ['s-1'],
      assignmentTargetIds: [],
      roundId: 'r-2',
      currentContextStableId: 'map-1',
      baseline: MATCHING,
    });
    expect(records).toHaveLength(0);
  });
});

describe('adoption chunks + root (spec §19)', () => {
  it('partitions records into bounded canonical chunks sorted by adoptionId', () => {
    const records: ReviewAdoptionRecordV2[] = Array.from({ length: 5 }, (_, i) => ({
      adoptionId: `a-${i}`,
      roundKind: 'content',
      roundId: 'r-1',
      candidateId: null,
      mapId: 'map-1',
      factId: `f-${i}`,
      targetStableId: `s-${i}`,
      expectedLocalSubjectDigest: 'subj',
      expectedLocalContextDigest: 'ctx',
      reviewPolicyDigest: 'policy',
      adoptedBy: 'system',
    }));
    const chunks = partitionAdoptionRecords(records, 2);
    expect(chunks.map((c) => c.length)).toEqual([2, 2, 1]);
    const root = buildAdoptionRoot('r-1', chunks.map((c) => refOfBlob('review_adoption_ledger', buildAdoptionLedger('r-1', 0, c))), 5);
    expect(root.orderedChunkRefs).toHaveLength(3);
    expect(root.adoptedTargetCount).toBe(5);
    expect(root.rootDigest).toMatch(/^[0-9a-f]{64}$/);
    // Ledger digest is the canonical body digest.
    const ledger = buildAdoptionLedger('r-1', 0, [records[0] as ReviewAdoptionRecordV2]);
    expect(ledger.blobDigest).toBe(canonicalJsonSha256({ roundId: 'r-1', chunkIndex: 0, adoptionRecords: [records[0]] }));
  });
});

describe('ReviewAdoptionService.computeAdoptionRoot', { timeout: 30_000 }, () => {
  let env: Awaited<ReturnType<typeof createWorkItemCoordinatorEnvironment>> | null = null;

  afterEach(() => {
    disposeRuntimeTestRoots();
    env = null;
  });

  async function makeEnv(): Promise<Awaited<ReturnType<typeof createWorkItemCoordinatorEnvironment>> & { taskId: string }> {
    const registry = new PublicationIntentRegistry();
    const { registerContentReviewPublicationHandlers } = await import('./content-review-service');
    registerContentReviewPublicationHandlers(registry);
    const base = await createWorkItemCoordinatorEnvironment({ registry });
    env = base;
    return { ...base, taskId: 'task-adoption' };
  }

  async function publishPriorLedger(b: Awaited<ReturnType<typeof makeEnv>>, ledgerRef: BlobRefV2): Promise<void> {
    const tail = await b.eventStore.tail(b.taskId);
    await b.facade.publishWithPin({
      taskId: b.taskId,
      operationId: `op-prior-${ledgerRef.digest.slice(0, 8)}`,
      payload: {
        family: 'domain_publish',
        operationId: `op-prior-${ledgerRef.digest.slice(0, 8)}`,
        taskId: b.taskId,
        publishKind: 'content_review_assignment_commit',
        blobRefs: [ledgerRef],
        expectedResultIdentity: canonicalJsonSha256({ op: 'prior' }),
        mapBuild: null,
        mapReview: null,
        contentPlan: null,
        contentReview: {
          assignmentId: 'a-prior',
          reviewRoundId: 'r-1',
          workItemId: 'wi-1',
          attemptId: 'att-1',
          reviewAssignmentId: 'rev-1',
          source: 'batch',
          ledgerRef,
          coverageTargetCount: 1,
          findingCount: 0,
          observations: null,
          findingOpenings: null,
          coverageCoreRef: null,
          roundPlanned: null,
          reviewWorkItems: null,
          settlementCoreRef: null,
          outcome: null,
          reviewBundleRef: null,
          reviewWarningCustodyRootRef: null,
          mapRef: null,
          contentRevisionManifestRef: null,
          reviewSettlementValidatorAggregateRef: null,
          sealWorkItemId: null,
          sealAuthorityBaseRef: null,
          successor: null,
          terminal: null,
        },
      },
      intent: { handlerKind: 'content_review_assignment_commit', handlerVersion: 1 },
      preparedRefs: [ledgerRef],
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
  }

  it('adopts a historical committed batch fact from a prior round ledger into the current root', async () => {
    const b = await makeEnv();
    const resolver = (taskId: string, ref: BlobRefV2) => b.resolverFor(taskId)(ref);
    const fact = batchFact();
    const factRef = await b.facade.prepareBlob(b.taskId, 'review_fact', fact);
    const ledgerBody = {
      assignmentId: 'a-prior',
      workItemId: 'wi-1',
      reviewAssignmentId: 'rev-1',
      roundKind: 'content' as const,
      roundId: 'r-1',
      factRefs: [factRef],
      findingDraftRefs: [],
      verificationRecordRefs: [],
      coverageTargetIds: ['s-1'],
    };
    const ledger = { ...ledgerBody, ledgerDigest: canonicalJsonSha256(ledgerBody) };
    const ledgerRef = await b.facade.prepareBlob(b.taskId, 'review_assignment_ledger', ledger);
    await publishPriorLedger(b, ledgerRef);
    const service = new ReviewAdoptionService({
      facade: b.facade,
      readProjection: b.readProjection,
      resolver,
      readEvents: async (id) => (await b.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
      adoptionChunkSize: 100,
    });
    const out = await service.computeAdoptionRoot({
      taskId: b.taskId,
      roundId: 'r-2',
      coverageTargetIds: ['s-1'],
      assignmentTargetIds: [],
      currentContextStableId: 'map-1',
      baseline: MATCHING,
    });
    expect(out.records).toHaveLength(1);
    expect(out.adoptedTargetIds).toEqual(['s-1']);
    expect(out.root.adoptedTargetCount).toBe(1);
    // The root resolves through the facade.
    const resolved = (await resolver(b.taskId, out.rootRef)) as { roundId: string; rootDigest: string };
    expect(resolved.roundId).toBe('r-2');
  });

  it('the current round OWN committed ledgers are not adoption candidates', async () => {
    const b = await makeEnv();
    const resolver = (taskId: string, ref: BlobRefV2) => b.resolverFor(taskId)(ref);
    const fact = batchFact();
    const factRef = await b.facade.prepareBlob(b.taskId, 'review_fact', fact);
    const ledgerBody = {
      assignmentId: 'a-current',
      workItemId: 'wi-2',
      reviewAssignmentId: 'rev-2',
      roundKind: 'content' as const,
      roundId: 'r-2',
      factRefs: [factRef],
      findingDraftRefs: [],
      verificationRecordRefs: [],
      coverageTargetIds: ['s-1'],
    };
    const ledger = { ...ledgerBody, ledgerDigest: canonicalJsonSha256(ledgerBody) };
    const ledgerRef = await b.facade.prepareBlob(b.taskId, 'review_assignment_ledger', ledger);
    // The ledger is committed for the CURRENT round r-2 (no prior r-1 ledger —
    // the current round's own ledger must NOT be an adoption candidate).
    const tail = await b.eventStore.tail(b.taskId);
    await b.facade.publishWithPin({
      taskId: b.taskId,
      operationId: `op-current-${ledgerRef.digest.slice(0, 8)}`,
      payload: {
        family: 'domain_publish',
        operationId: `op-current-${ledgerRef.digest.slice(0, 8)}`,
        taskId: b.taskId,
        publishKind: 'content_review_assignment_commit',
        blobRefs: [ledgerRef],
        expectedResultIdentity: canonicalJsonSha256({ op: 'current' }),
        mapBuild: null,
        mapReview: null,
        contentPlan: null,
        contentReview: {
          assignmentId: 'a-current',
          reviewRoundId: 'r-2',
          workItemId: 'wi-2',
          attemptId: 'att-2',
          reviewAssignmentId: 'rev-2',
          source: 'batch',
          ledgerRef,
          coverageTargetCount: 1,
          findingCount: 0,
          observations: null,
          findingOpenings: null,
          coverageCoreRef: null,
          roundPlanned: null,
          reviewWorkItems: null,
          settlementCoreRef: null,
          outcome: null,
          reviewBundleRef: null,
          reviewWarningCustodyRootRef: null,
          mapRef: null,
          contentRevisionManifestRef: null,
          reviewSettlementValidatorAggregateRef: null,
          sealWorkItemId: null,
          sealAuthorityBaseRef: null,
          successor: null,
          terminal: null,
        },
      },
      intent: { handlerKind: 'content_review_assignment_commit', handlerVersion: 1 },
      preparedRefs: [ledgerRef],
      expectedTailSequence: tail.lastSequence,
      expectedTailCommitId: tail.lastCommitId,
    });
    const service = new ReviewAdoptionService({
      facade: b.facade,
      readProjection: b.readProjection,
      resolver,
      readEvents: async (id) => (await b.eventStore.read(id)).map((e) => e.event as AuthoritativeReviewEventV2),
      adoptionChunkSize: 100,
    });
    const out = await service.computeAdoptionRoot({
      taskId: b.taskId,
      roundId: 'r-2',
      coverageTargetIds: ['s-1'],
      assignmentTargetIds: [],
      currentContextStableId: 'map-1',
      baseline: MATCHING,
    });
    // The r-2 ledger is the CURRENT round's own ledger — not adoptable.
    expect(out.records).toHaveLength(0);
    expect(out.root.adoptedTargetCount).toBe(0);
  });
});
