/**
 * Task 13 finding-draft registry (design §11.8/§11.9, spec §11.3): materializes
 * the reviewer's finding DRAFTS (ordinary anchored drafts, constrained
 * cross-scope drafts, and whole-observation drafts) into canonical `finding`
 * blobs at `complete_review_assignment` freeze time.
 *
 * The finding-SERVICE (Task 18) owns the full lifecycle; this registry is the
 * FROZEN freezable form: it assigns a deterministic system findingId from
 * `(attemptId, clientFindingKey)`, builds a valid `FindingV2` (source
 * `reviewer`, status `open`, repairProgress derived from defectClass), and
 * computes its content-addressed `finding` BlobRef. The registry is per-freeze
 * in-memory and idempotent by clientFindingKey, so the same draft appearing on
 * two journal records materializes ONCE.
 *
 * Cross-scope routing obligations (spec §11.3) are computed here: a
 * cross-scope finding whose primary target is NOT reviewed by this assignment
 * becomes an `unreviewed_primary` obligation (the finding context routes to the
 * target's planned assignment / deterministic successor); a primary target that
 * IS reviewed enters the `reviewed_primary_whole_decision` set (the whole
 * observation must explicitly confirm/reject before settlement can pass).
 *
 * Pure module — no fs/EventStore/clock/random; digests from input bytes only.
 */
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { refOfBlob } from '../../authoritative-review/object-registry';
import type { FindingV2, ReviewEvidenceV2 } from '../../authoritative-review/authority-types';

/** Deterministic system findingId of one draft (design §18.3: the system
 * assigns official finding IDs; the clientFindingKey is operation-local). */
export function findingDraftId(attemptId: string, clientFindingKey: string): string {
  return `finding-${canonicalJsonSha256({ attemptId, clientFindingKey }).slice(0, 32)}`;
}

/** Bounded public evidence strings → canonical ReviewEvidenceV2 entries. */
export function evidenceStringsToReviewEvidence(evidence: readonly string[]): readonly ReviewEvidenceV2[] {
  return evidence.map((text) => ({
    evidenceDigest: canonicalJsonSha256({ text }),
    text,
    refs: [],
  }));
}

/** Repair-progress stages of a reviewer finding derived from its defect class. */
export function repairProgressForDefectClass(defectClass: FindingV2['defectClass']): FindingV2['repairProgress'] {
  switch (defectClass) {
    case 'content':
      return { map: 'not_required', content: 'pending' };
    case 'map':
      return { map: 'pending', content: 'not_required' };
    case 'mixed':
      return { map: 'pending', content: 'pending' };
  }
}

export interface FindingDraftInputV2 {
  clientFindingKey: string;
  defectClass: FindingV2['defectClass'];
  severity: FindingV2['severity'];
  primaryLocation: { kind: FindingV2['primaryLocation']['kind']; id: string };
  relatedSlotIds?: readonly string[];
  relatedRelationIds?: readonly string[];
  suggestedRepairSlotIds?: readonly string[];
  evidence: readonly string[];
}

export interface FindingDraftContextV2 {
  attemptId: string;
  reviewerAttemptId: string;
  roundKind: 'map' | 'content';
  roundId: string;
}

/** Builds one canonical FindingV2 from a draft (source reviewer, status open). */
export function buildFindingFromDraft(
  context: FindingDraftContextV2,
  draft: FindingDraftInputV2,
): FindingV2 {
  return {
    findingId: findingDraftId(context.attemptId, draft.clientFindingKey),
    reviewContext: { kind: context.roundKind, roundId: context.roundId },
    primaryLocation: { kind: draft.primaryLocation.kind, id: draft.primaryLocation.id },
    relatedSlotIds: draft.relatedSlotIds ?? [],
    relatedRelationIds: draft.relatedRelationIds ?? [],
    defectClass: draft.defectClass,
    severity: draft.severity,
    source: 'reviewer',
    evidence: evidenceStringsToReviewEvidence(draft.evidence),
    suggestedRepairSlotIds: draft.suggestedRepairSlotIds ?? [],
    status: 'open',
    repairProgress: repairProgressForDefectClass(draft.defectClass),
    openedBy: { kind: 'reviewer', reviewerAttemptId: context.reviewerAttemptId },
  };
}

/** One cross-scope routing obligation (spec §11.3). */
export interface CrossScopeRoutingObligationV2 {
  clientFindingKey: string;
  findingId: string;
  /** the assigned verdict target that anchored the draft (sourceTarget). */
  sourceTargetId: string;
  /** an existing target in the SAME frozen baseline. */
  primaryTarget: string;
  routing: 'unreviewed_primary' | 'reviewed_primary_whole_decision';
}

export class FindingDraftRegistryV2 {
  private readonly findings = new Map<string, FindingV2>();

  private readonly refs = new Map<string, BlobRefV2>();

  private readonly obligations: CrossScopeRoutingObligationV2[] = [];

  constructor(
    private readonly context: FindingDraftContextV2,
    /** the targets this assignment actually reviews (verdict records). */
    private readonly reviewedTargets: ReadonlySet<string>,
  ) {}

  /** Materializes an ordinary (anchored) finding draft once. */
  materialize(draft: FindingDraftInputV2): { finding: FindingV2; ref: BlobRefV2; findingId: string } {
    const existing = this.findings.get(draft.clientFindingKey);
    if (existing !== undefined) {
      return { finding: existing, ref: this.refs.get(draft.clientFindingKey) as BlobRefV2, findingId: existing.findingId };
    }
    const finding = buildFindingFromDraft(this.context, draft);
    const ref = refOfBlob('finding', finding);
    this.findings.set(draft.clientFindingKey, finding);
    this.refs.set(draft.clientFindingKey, ref);
    return { finding, ref, findingId: finding.findingId };
  }

  /**
   * Registers a cross-scope finding draft: materializes it AND computes the
   * routing obligation. `primaryTarget` must exist in the frozen baseline; the
   * source target is the assigned verdict target that anchored the draft.
   */
  materializeCrossScope(draft: FindingDraftInputV2, sourceTargetId: string, primaryTarget: string): { finding: FindingV2; ref: BlobRefV2; findingId: string; obligation: CrossScopeRoutingObligationV2 } {
    const { finding, ref } = this.materialize(draft);
    const reviewedHere = this.reviewedTargets.has(primaryTarget);
    const obligation: CrossScopeRoutingObligationV2 = {
      clientFindingKey: draft.clientFindingKey,
      findingId: finding.findingId,
      sourceTargetId,
      primaryTarget,
      routing: reviewedHere ? 'reviewed_primary_whole_decision' : 'unreviewed_primary',
    };
    this.obligations.push(obligation);
    return { finding, ref, findingId: finding.findingId, obligation };
  }

  /** All materialized finding refs, deterministic (clientFindingKey order). */
  get refsList(): readonly BlobRefV2[] {
    return [...this.refs.keys()].sort().map((key) => this.refs.get(key) as BlobRefV2);
  }

  get findingsList(): readonly FindingV2[] {
    return [...this.findings.keys()].sort().map((key) => this.findings.get(key) as FindingV2);
  }

  get routingObligations(): readonly CrossScopeRoutingObligationV2[] {
    return [...this.obligations];
  }
}
