/**
 * Task 18 review-adoption-service (design §11.4/§19, spec §7.4): the
 * system-owned adoption of HISTORICAL batch review facts into the current
 * content round.
 *
 * NORMATIVE CORE:
 * - ONLY committed assignment facts are adoption candidates: the service reads
 *   the round's PRIOR `review_assignment_ledger` blobs (from committed
 *   assignment events of completed earlier rounds) and resolves their
 *   `review_fact` blobs. Whole-observation facts (or any fact with
 *   `adoptionEligible != true`) are HARD REJECTED — identical local digests
 *   never justify inheriting a whole-tree observation;
 * - a historical fact is adopted ONLY when the EXACT stable target/subject/
 *   context/policy match holds against the current baseline, and the adoption
 *   produces an `ReviewAdoptionRecord` in the current round's adoption root;
 * - current committed assignment facts and adopted historical facts are
 *   DISJOINT coverage sources (design §12.4) — a target never appears in both;
 * - adoptions are stored as bounded canonical chunks (`review_adoption_ledger`)
 *   closed by one `review_adoption_root` (spec §19); 0 adoptions use the
 *   canonical empty root (Task 17's round-planned adoptionRootRef).
 *
 * PUBLICATION MODEL: this service only COMPUTES the adoption root; the
 * content-review-service binds `adoptionRootRef` into the FINAL coverage core
 * at round completion. No standalone adoption event exists — the root is a
 * content-addressed blob reachable from the coverage core + child refs.
 *
 * V1 byte-for-byte: new module; v1 surfaces untouched. Pure deterministic
 * builders + a read-only compute path — no EventStore import.
 */
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { AuthoritativeAppendFacadeV2 } from '../../storage/authoritative-append-facade';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { AuthoritativeReviewProjectionV2 } from '../../storage/authoritative-review-state';
import type {
  ReviewAdoptionLedgerBlobV2,
  ReviewAdoptionRecordV2,
  ReviewAdoptionRootV2,
  ReviewFactV2,
} from '../../authoritative-review/authority-types';
import { refOfBlob } from '../../authoritative-review/object-registry';
import {
  canFactBeAdopted,
  adoptHistoricalFact,
  validateAdoptionRecordContext,
  assertCoverageSourcesDisjoint,
} from '../../authoritative-review/review-domain';

/** The current baseline a historical fact must match EXACTLY (design §11.4). */
export interface AdoptionBaselineContextV2 {
  reviewPolicyDigest: string;
  /** subject digest of the current baseline target (stable per target id). */
  subjectDigestOf(targetStableId: string): string;
  /** local context digest of the current baseline target. */
  contextDigestOf(targetStableId: string): string;
}

/** The adoptable historical facts for one round (targets coverage - assignment). */
export function selectAdoptableFacts(input: {
  /** resolved historical committed facts (batch origin only; whole facts REJECTED). */
  facts: readonly ReviewFactV2[];
  /** every coverage target of the current round (full tree-Gate set). */
  coverageTargetIds: readonly string[];
  /** the targets the current round assigns NEW Agent judgment (never adopted). */
  assignmentTargetIds: readonly string[];
  roundId: string;
  /** the current Map id (content round) — adoption binds the exact map. */
  currentContextStableId: string;
  baseline: AdoptionBaselineContextV2;
}): { records: readonly ReviewAdoptionRecordV2[]; adoptedTargetIds: readonly string[] } {
  const coverage = new Set(input.coverageTargetIds);
  const assigned = new Set(input.assignmentTargetIds);
  // §12.4 disjointness: a committed current target can never also be adopted.
  assertCoverageSourcesDisjoint(assigned, new Set());
  const seen = new Set<string>();
  const records: ReviewAdoptionRecordV2[] = [];
  const adoptedTargetIds: string[] = [];
  // Deterministic order: factId-sorted candidates; the FIRST fact matching a
  // target wins (later facts for the same target are redundant — one adoption
  // per target).
  const sorted = [...input.facts].sort((a, b) => (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0));
  for (const fact of sorted) {
    if (!canFactBeAdopted(fact)) {
      // Whole-observation facts and adoption-ineligible facts are hard
      // rejected — identical digests never justify inheriting them.
      continue;
    }
    if (!coverage.has(fact.targetStableId)) continue;
    if (assigned.has(fact.targetStableId)) continue;
    if (seen.has(fact.targetStableId)) continue;
    const record = adoptHistoricalFact(fact, input.roundId, input.currentContextStableId);
    validateAdoptionRecordContext(record, {
      subjectDigest: input.baseline.subjectDigestOf(fact.targetStableId),
      contextDigest: input.baseline.contextDigestOf(fact.targetStableId),
      policyDigest: input.baseline.reviewPolicyDigest,
    });
    seen.add(fact.targetStableId);
    records.push(record);
    adoptedTargetIds.push(fact.targetStableId);
  }
  return { records, adoptedTargetIds };
}

/** Bounded canonical adoption chunks (spec §19): sorted records, chunked. */
export function partitionAdoptionRecords(
  records: readonly ReviewAdoptionRecordV2[],
  chunkSize: number,
): ReviewAdoptionRecordV2[][] {
  const size = Math.max(1, chunkSize);
  const out: ReviewAdoptionRecordV2[][] = [];
  const sorted = [...records].sort((a, b) => (a.adoptionId < b.adoptionId ? -1 : a.adoptionId > b.adoptionId ? 1 : 0));
  for (let i = 0; i < sorted.length; i += size) out.push(sorted.slice(i, i + size));
  return out;
}

/** One immutable adoption ledger chunk. */
export function buildAdoptionLedger(
  roundId: string,
  chunkIndex: number,
  records: readonly ReviewAdoptionRecordV2[],
): ReviewAdoptionLedgerBlobV2 {
  const body = { roundId, chunkIndex, adoptionRecords: [...records] };
  return { ...body, blobDigest: canonicalJsonSha256(body) };
}

/** The adoption root closing the chunk closure. */
export function buildAdoptionRoot(
  roundId: string,
  orderedChunkRefs: readonly BlobRefV2[],
  adoptedTargetCount: number,
): ReviewAdoptionRootV2 {
  const body = {
    roundId,
    orderedChunkRefs: [...orderedChunkRefs].sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0)),
    adoptedTargetCount,
    coverageDigest: canonicalJsonSha256({ roundId, orderedChunkRefs, adoptedTargetCount }),
  };
  return { ...body, rootDigest: canonicalJsonSha256(body) };
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export interface ReviewAdoptionServiceDependencies {
  facade: Pick<AuthoritativeAppendFacadeV2, 'prepareBlob'>;
  readProjection(taskId: string): Promise<AuthoritativeReviewProjectionV2>;
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown> | unknown;
  readEvents(taskId: string): Promise<readonly AuthoritativeReviewEventV2[]>;
  /** Bounded per-chunk record count (profile adoption chunk size). */
  adoptionChunkSize: number;
}

/** A computed adoption root + its ref (the final coverage core binds it). */
export interface ComputedAdoptionRootV2 {
  rootRef: BlobRefV2;
  root: ReviewAdoptionRootV2;
  ledgerRefs: readonly BlobRefV2[];
  records: readonly ReviewAdoptionRecordV2[];
  adoptedTargetIds: readonly string[];
}

export class ReviewAdoptionService {
  private readonly deps: ReviewAdoptionServiceDependencies;

  constructor(deps: ReviewAdoptionServiceDependencies) {
    this.deps = deps;
  }

  /**
   * Computes the adoption root for the current round from the historical
   * committed facts of PRIOR rounds (the round's `review_assignment_ledger`
   * blobs reached from events). Only committed batch facts that exactly match
   * the current baseline and cover a coverage-minus-assignment target are
   * adopted; whole-observation/ineligible facts and current targets are never
   * adopted.
   */
  async computeAdoptionRoot(input: {
    taskId: string;
    roundId: string;
    /** every coverage target of the current round. */
    coverageTargetIds: readonly string[];
    /** the current assignment's committed targets (disjoint from adopted). */
    assignmentTargetIds: readonly string[];
    currentContextStableId: string;
    baseline: AdoptionBaselineContextV2;
  }): Promise<ComputedAdoptionRootV2> {
    const { taskId, roundId } = input;
    const events = await this.deps.readEvents(taskId);
    const facts: ReviewFactV2[] = [];
    // Prior-round committed ledgers: content assignments of rounds other than
    // the current one (the current round's own facts are current, not adopted).
    // Map pre-review ledgers are also resolved — their Map targets fail the
    // content coverage filter below, so only content facts can be adopted.
    const ledgerRefs = new Map<string, BlobRefV2>();
    for (const event of events) {
      if (event.type === 'structured_content_review_assignment_committed' && event.reviewRoundId !== roundId) {
        ledgerRefs.set(event.ledgerRef.digest, event.ledgerRef);
      }
      if (event.type === 'structured_map_review_assignment_committed') {
        ledgerRefs.set(event.ledgerRef.digest, event.ledgerRef);
      }
    }
    for (const ref of ledgerRefs.values()) {
      const ledger = (await this.deps.resolver(taskId, ref)) as { factRefs?: readonly BlobRefV2[] } | null;
      if (ledger === null || typeof ledger !== 'object' || !Array.isArray(ledger.factRefs)) continue;
      for (const factRef of ledger.factRefs) {
        const fact = (await this.deps.resolver(taskId, factRef)) as ReviewFactV2 | null;
        if (fact === null || typeof fact !== 'object' || typeof fact.factId !== 'string') continue;
        facts.push(fact);
      }
    }
    const { records, adoptedTargetIds } = selectAdoptableFacts({
      facts,
      coverageTargetIds: input.coverageTargetIds,
      assignmentTargetIds: input.assignmentTargetIds,
      roundId,
      currentContextStableId: input.currentContextStableId,
      baseline: input.baseline,
    });
    // Disjointness is enforced by selectAdoptableFacts (assigned set).
    const ledgerRefsOut: BlobRefV2[] = [];
    const chunks = partitionAdoptionRecords(records, this.deps.adoptionChunkSize);
    for (let index = 0; index < chunks.length; index++) {
      const chunk = buildAdoptionLedger(roundId, index, chunks[index]);
      const ref = await this.deps.facade.prepareBlob(taskId, 'review_adoption_ledger', chunk);
      ledgerRefsOut.push(ref);
    }
    const root = buildAdoptionRoot(roundId, ledgerRefsOut, adoptedTargetIds.length);
    const rootRef = await this.deps.facade.prepareBlob(taskId, 'review_adoption_root', root);
    return { rootRef, root, ledgerRefs: ledgerRefsOut, records, adoptedTargetIds };
  }
}

/** Deterministic canonical empty adoption root (the round-planned ref; 0 adoptions). */
export function emptyAdoptionRootOf(roundId: string): ReviewAdoptionRootV2 {
  return buildAdoptionRoot(roundId, [], 0);
}

/** The content-addressed empty adoption root ref (Task 17's planned ref). */
export function emptyAdoptionRootRefOf(roundId: string): BlobRefV2 {
  return refOfBlob('review_adoption_root', emptyAdoptionRootOf(roundId));
}
