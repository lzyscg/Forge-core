/**
 * Task 18 finding-service (design §11.8/§11.9, spec §13.3): the Finding
 * lifecycle, classification, verification stages, finding-stage root and the
 * deterministic repair route.
 *
 * NORMATIVE CORE:
 * - lifecycle `open -> repair_planned -> repair_dispatched -> addressed ->
 *   verified_closed` (or back to `open` on `still_present`); a repair commit
 *   only ever advances ONE required stage to `addressed`, never closes;
 * - `content | map | mixed` classification; `mixed` ALWAYS routes Map first —
 *   its content stage cannot close while the Map stage is unresolved;
 * - verification verdicts are ONLY `resolved | still_present`; `resolved` is a
 *   semantic fact the SYSTEM projects to that stage's `verified`; a Finding
 *   closes only when ALL required stages are verified;
 * - system-validator Findings reject the reviewer verification tool (source
 *   gate) and close ONLY by a validator rerun (`structured_validator_finding_
 *   verification_recorded` on the frozen baseline);
 * - the finding-stage root is the `finding_stage_root` blob the FINAL coverage
 *   core binds: sorted entries `{findingId, repairStage, state}` derived from
 *   the projected findings, repair progress, and verification records;
 * - the deterministic repair route (design §11.5) combines the finalizer
 *   aggregate outcome with the blocking Finding classes: any map/mixed blocking
 *   routes Map repair FIRST; content-only blocking routes content repair; pure
 *   advisory stays clear.
 *
 * PUBLICATION MODEL: the service computes/projects + prepares blobs; the
 * content-review-service binds `findingStageRootRef` into the FINAL coverage
 * core. Reviewer verification drafts are frozen by the Task 13 freeze seam; the
 * settlement projects verified/closed/reopen from the committed records — the
 * Agent never writes stage progress.
 *
 * V1 byte-for-byte: new module; v1 surfaces untouched. Pure deterministic
 * builders + a read-only projection path — no EventStore import.
 */
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { AuthoritativeAppendFacadeV2 } from '../../storage/authoritative-append-facade';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { AuthoritativeReviewProjectionV2, ProjectedFindingV2 } from '../../storage/authoritative-review-state';
import type {
  FindingStageRootV2,
  FindingV2,
  FindingVerificationRecordV2,
  ReviewAdoptionRecordV2,
} from '../../authoritative-review/authority-types';
import { refOfBlob } from '../../authoritative-review/object-registry';
import { deriveCombinedRouteOutcome, type RouteClassification } from '../../authoritative-review/content-domain';

/** The required repair stages of one defect class (design §11.8). */
export const REQUIRED_STAGES_BY_DEFECT: Record<FindingV2['defectClass'], readonly ('map' | 'content')[]> = {
  content: ['content'],
  map: ['map'],
  mixed: ['map', 'content'],
};

/** A projected finding's derived lifecycle status (design §11.8). */
export interface ProjectedFindingLifecycleV2 {
  findingId: string;
  defectClass: FindingV2['defectClass'];
  severity: FindingV2['severity'];
  source: FindingV2['source'];
  status: FindingV2['status'];
  /** stages whose repair is committed (addressed). */
  addressStages: readonly string[];
  /** stages verified by `resolved` records / validator rerun. */
  verifiedStages: readonly string[];
  /** true when every required stage is verified (verified_closed eligible). */
  closed: boolean;
  /** true when a blocking obligation is unresolved (blocking + not closed). */
  blockingUnclosed: boolean;
}

/** The lifecycle status of one projected finding (design §11.8 transitions). */
export function projectFindingLifecycle(input: {
  finding: Pick<ProjectedFindingV2, 'findingId' | 'defectClass' | 'severity' | 'source' | 'state' | 'addressStages' | 'verifiedStages'>;
}): ProjectedFindingLifecycleV2 {
  const f = input.finding;
  const required = REQUIRED_STAGES_BY_DEFECT[f.defectClass];
  const addressStages = [...f.addressStages];
  const verifiedStages = [...f.verifiedStages];
  const allVerified = required.every((stage) => verifiedStages.includes(stage));
  let status: FindingV2['status'];
  if (allVerified) {
    status = 'verified_closed';
  } else if (f.state === 'addressed') {
    status = 'addressed';
  } else if (addressStages.length > 0) {
    // A committed stage that is not yet addressed (repair dispatched) — the
    // projection tracks state open|addressed|verified_closed; derived stages
    // refine the intermediate lifecycle.
    status = 'repair_dispatched';
  } else {
    status = 'open';
  }
  return {
    findingId: f.findingId,
    defectClass: f.defectClass,
    severity: f.severity,
    source: f.source,
    status,
    addressStages,
    verifiedStages,
    closed: allVerified,
    blockingUnclosed: f.severity === 'blocking' && !allVerified,
  };
}

/** The frozen verification targets of a round: `findingId:repairStage` per
 * reviewer-source blocking finding whose stage is currently addressed (design
 * §11.9 — the next assignment must verify each). System-validator findings are
 * verified by validator rerun, never the reviewer tool. */
export function verificationStagesOf(findings: readonly ProjectedFindingLifecycleV2[]): string[] {
  const out: string[] = [];
  for (const f of findings) {
    if (f.source === 'system_validator') continue;
    for (const stage of f.addressStages) {
      if (f.verifiedStages.includes(stage)) continue;
      out.push(`${f.findingId}:${stage}`);
    }
  }
  return out.sort();
}

/** One finding-stage-root entry (state derived from the lifecycle). */
export interface FindingStageEntryV2 {
  findingId: string;
  repairStage: 'map' | 'content';
  state: 'pending' | 'committed' | 'verified';
}

/** The finding-stage root entries of a round (design §11.8 repairProgress). */
export function findingStageEntriesOf(findings: readonly ProjectedFindingLifecycleV2[]): FindingStageEntryV2[] {
  const out: FindingStageEntryV2[] = [];
  for (const f of findings) {
    for (const stage of REQUIRED_STAGES_BY_DEFECT[f.defectClass]) {
      let state: 'pending' | 'committed' | 'verified' = 'pending';
      if (f.verifiedStages.includes(stage)) {
        state = 'verified';
      } else if (f.addressStages.includes(stage)) {
        state = 'committed';
      }
      out.push({ findingId: f.findingId, repairStage: stage, state });
    }
  }
  // The parser requires entries sorted by findingId; within one finding the
  // required-stage order (map before content for mixed) is preserved.
  return out.sort((a, b) => (a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0));
}

/** Deterministic `finding_stage_root` builder (exact-key parser contract). */
export function buildFindingStageRoot(roundId: string, entries: readonly FindingStageEntryV2[]): FindingStageRootV2 {
  // The parser requires entries sorted by findingId; within one finding the
  // required-stage order (map before content for mixed) is preserved by the
  // stable sort (design §11.8).
  const sorted = [...entries].sort((a, b) => (a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0));
  const body = {
    rootId: `fsr-${canonicalJsonSha256({ roundId }).slice(0, 24)}`,
    roundId,
    entries: sorted,
  };
  return { ...body, rootDigest: canonicalJsonSha256(body) };
}

/** Deterministic repair route: infrastructure dominates; any map/mixed blocking
 * routes Map repair FIRST; content-only blocking routes content repair;
 * advisory-only stays clear (design §11.5 / §13.3). */
export function repairRouteOf(
  findings: readonly ProjectedFindingLifecycleV2[],
  finalizerAggregateOutcome: 'clear' | 'blocking_invalid' | 'infrastructure_failure',
): RouteClassification {
  return deriveCombinedRouteOutcome(
    findings.map((f) => ({ severity: f.severity, defectClass: f.defectClass })),
    finalizerAggregateOutcome,
  );
}

/** Cross-scope routing obligations (spec §11.3): a blocking cross-scope finding
 * whose primary target is NOT reviewed by the assignment routes to the target's
 * deterministic successor; a reviewed primary enters the whole-observation
 * mandatory-decision set. `reviewed_primary_whole_decision` obligations block
 * settlement until the whole-tree observation explicitly confirms/rejects. */
export function classifyCrossScopeObligation(input: {
  finding: Pick<FindingV2, 'severity' | 'status'>;
  primaryReviewed: boolean;
}): 'unreviewed_primary' | 'reviewed_primary_whole_decision' {
  if (input.primaryReviewed) return 'reviewed_primary_whole_decision';
  return 'unreviewed_primary';
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export interface FindingServiceDependencies {
  facade: Pick<AuthoritativeAppendFacadeV2, 'prepareBlob'>;
  readProjection(taskId: string): Promise<AuthoritativeReviewProjectionV2>;
  readEvents(taskId: string): Promise<readonly AuthoritativeReviewEventV2[]>;
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown> | unknown;
}

export class FindingService {
  private readonly deps: FindingServiceDependencies;

  constructor(deps: FindingServiceDependencies) {
    this.deps = deps;
  }

  /** The round's projected findings with derived lifecycle status. */
  async projectRoundFindings(taskId: string, roundId: string): Promise<ProjectedFindingLifecycleV2[]> {
    const state = await this.deps.readProjection(taskId);
    const out: ProjectedFindingLifecycleV2[] = [];
    for (const finding of Object.values(state.findings)) {
      if (finding.reviewContext.kind !== 'content' && finding.reviewContext.kind !== 'map') continue;
      if (finding.reviewContext.roundId !== roundId) continue;
      out.push(projectFindingLifecycle({ finding }));
    }
    return out;
  }

  /** Builds + prepares the round's REAL `finding_stage_root` (the Task 17
   * planned coverage core referenced a fabricated root; the FINAL coverage
   * core binds this real one). */
  async prepareFindingStageRoot(taskId: string, roundId: string): Promise<{ rootRef: BlobRefV2; root: FindingStageRootV2 }> {
    const findings = await this.projectRoundFindings(taskId, roundId);
    const root = buildFindingStageRoot(roundId, findingStageEntriesOf(findings));
    const rootRef = await this.deps.facade.prepareBlob(taskId, 'finding_stage_root', root);
    return { rootRef, root };
  }

  /** The deterministic content-repair successor route of the round's blocking
   * findings (spec §13.3.1: over the current finalizer aggregate outcome). */
  async contentRepairRoute(taskId: string, roundId: string): Promise<RouteClassification> {
    const findings = await this.projectRoundFindings(taskId, roundId);
    // The finalizer aggregate is a settlement-time input; the service's route
    // is the pure projection over the round's blocking findings (the settlement
    // handler passes its own aggregate outcome).
    return repairRouteOf(findings, 'clear');
  }

  /** Content-addressed ref of a canonical `finding` blob (used by tests/ledgers). */
  static findingRefOf(finding: FindingV2): BlobRefV2 {
    return refOfBlob('finding', finding);
  }
}

// Re-exported type shims (structural consumers only; no runtime cost).
export type { ReviewAdoptionRecordV2, FindingVerificationRecordV2 };
