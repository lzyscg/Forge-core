/**
 * Pure Finding domain (Task 3, design §11.8/§11.9/§13; spec §13.3): defect
 * classification (content|map|mixed), severity derivation (blocking facts can
 * never be downgraded to advisory), lifecycle transitions, repairProgress
 * stages, verification records with exact baseline binding, and the
 * deterministic repair route (mixed => Map first).
 *
 * Pure module: no fs/EventStore/provider/HTTP/React, no wall clock, no random.
 */
import {
  SchemaError,
  type FindingV2,
} from './authority-types';

export type FindingStageV2 = 'map' | 'content';

/* ------------------------------------------------------------------ */
/* Classification and routing (§11.8/§13)                              */
/* ------------------------------------------------------------------ */

export interface FindingRouteV2 {
  /** 'map_repair' whenever any blocking map/mixed Finding exists — Map first. */
  route: 'content_repair' | 'map_repair' | 'none';
  mapFirst: boolean;
  mapRepairPlanFindings: FindingV2[];
  contentRepairPlanFindings: FindingV2[];
}

/** Open/repair states that keep a blocking Finding active (§16.2 condition 7). */
export const ACTIVE_FINDING_STATES = ['open', 'repair_planned', 'repair_dispatched', 'addressed'] as const;

export function isActiveBlockingFinding(f: Pick<FindingV2, 'severity' | 'status'>): boolean {
  return f.severity === 'blocking' && (ACTIVE_FINDING_STATES as readonly string[]).includes(f.status);
}

/**
 * Deterministic routing: any blocking map or mixed Finding creates a
 * MapRepairPlan and forces the Map stage first; pure content blocking goes to
 * ContentRepairPlan; advisory-only findings never create a plan.
 */
export function classifyAndRouteFindings(findings: readonly FindingV2[]): FindingRouteV2 {
  const mapRepairPlanFindings: FindingV2[] = [];
  const contentRepairPlanFindings: FindingV2[] = [];
  for (const f of findings) {
    if (f.severity !== 'blocking') continue;
    if (f.defectClass === 'map' || f.defectClass === 'mixed') mapRepairPlanFindings.push(f);
    else if (f.defectClass === 'content') contentRepairPlanFindings.push(f);
  }
  const mapFirst = mapRepairPlanFindings.length > 0;
  return {
    route: mapFirst ? 'map_repair' : contentRepairPlanFindings.length > 0 ? 'content_repair' : 'none',
    mapFirst,
    mapRepairPlanFindings,
    contentRepairPlanFindings,
  };
}

/** Required repair stages per defect class (§11.8): mixed needs both, in order map then content. */
export function requiredStagesOf(defectClass: FindingV2['defectClass']): FindingStageV2[] {
  if (defectClass === 'mixed') return ['map', 'content'];
  return defectClass === 'map' ? ['map'] : ['content'];
}

/* ------------------------------------------------------------------ */
/* Severity derivation (§11.8: blocking facts cannot be downgraded)    */
/* ------------------------------------------------------------------ */

export function assertFindingSeveritySource(input: {
  severity: FindingV2['severity'];
  verdict?: 'pass' | 'reject' | 'satisfied' | 'violated';
  enforcement?: 'blocking' | 'advisory';
}): void {
  const mustBeBlocking = input.verdict === 'reject' || input.verdict === 'violated' || input.enforcement === 'blocking';
  if (mustBeBlocking && input.severity !== 'blocking') {
    throw new SchemaError('SCHEMA_INVALID: a reject/violated/blocking-enforcement fact requires a blocking Finding — downgrades are rejected');
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle (§11.8)                                                   */
/* ------------------------------------------------------------------ */

const FINDING_STATUS_ORDER: readonly string[] = ['open', 'repair_planned', 'repair_dispatched', 'addressed', 'verified_closed'];

export function assertFindingTransition(from: FindingV2['status'], to: FindingV2['status']): void {
  const i = FINDING_STATUS_ORDER.indexOf(from);
  const j = FINDING_STATUS_ORDER.indexOf(to);
  if (i === -1 || j !== i + 1) {
    throw new SchemaError(`illegal Finding transition '${from}' -> '${to}' (must advance one step)`);
  }
}

/**
 * Apply one stage verification verdict. `resolved` only becomes `verified`
 * for that stage; a mixed Finding stays blocking until BOTH stages are
 * verified. `still_present` reopens the Finding and resets the stage.
 */
export function applyFindingVerification(
  finding: FindingV2,
  input: {
    reviewContext: { kind: 'map' | 'content'; roundId: string };
    repairStage: FindingStageV2;
    verdict: 'resolved' | 'still_present';
    mapContextDigests: Readonly<Record<string, string>>;
    evidence: readonly unknown[];
  },
): FindingV2 {
  const progress = { ...finding.repairProgress };
  if (finding.status !== 'addressed' && finding.status !== 'open') {
    throw new SchemaError(`Finding '${finding.findingId}' is not addressed — verification only applies to addressed stages`);
  }
  if (input.verdict === 'still_present') {
    progress[input.repairStage] = 'pending';
    return { ...finding, status: 'open', repairProgress: progress };
  }
  // resolved: the semantic judgement is in; the system additionally requires a
  // current effective verdict on the repaired target before projecting verified.
  progress[input.repairStage] = 'verified';
  const required = requiredStagesOf(finding.defectClass);
  const allVerified = required.every((stage) => progress[stage] === 'verified');
  if (allVerified) {
    return { ...finding, status: 'verified_closed', repairProgress: progress };
  }
  // mixed with map verified: advance to the content stage (requested again).
  const nextStageIndex = required.findIndex((stage) => progress[stage] !== 'verified');
  const next = required[nextStageIndex] as FindingStageV2 | undefined;
  const advanced: FindingV2['repairProgress'] = { ...progress };
  if (next) advanced[next] = 'pending';
  return { ...finding, status: 'repair_planned', repairProgress: advanced };
}

/* ------------------------------------------------------------------ */
/* Verification baseline binding (§11.9)                               */
/* ------------------------------------------------------------------ */

/** Map stage verification binds candidateId; content stage binds the active mapId. */
export function assertFindingVerificationBaseline(
  repairStage: FindingStageV2,
  identity: { candidateId: string | null; mapId: string | null },
): void {
  if (repairStage === 'map' && (identity.candidateId === null || identity.mapId !== null)) {
    throw new SchemaError('map-stage verification must bind candidateId and keep mapId null');
  }
  if (repairStage === 'content' && (identity.mapId === null || identity.candidateId !== null)) {
    throw new SchemaError('content-stage verification must bind mapId and keep candidateId null');
  }
}

/**
 * Proposal for the pure verification rule (design §11.9): `resolved` alone is
 * not enough — the repaired targets must carry current effective verdicts in
 * the verifying round before the stage may be projected verified.
 */
export function assertStageVerifiedTargets(input: {
  repairStage: FindingStageV2;
  targetStableIds: readonly string[];
  currentVerdicts: ReadonlyMap<string, 'pass' | 'reject' | 'satisfied' | 'violated'>;
}): void {
  for (const target of input.targetStableIds) {
    const verdict = input.currentVerdicts.get(target);
    if (verdict !== 'pass' && verdict !== 'satisfied') {
      throw new SchemaError(`stage target '${target}' lacks a current passing verdict`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Cross-scope routing obligations (§11.8/§11.10)                      */
/* ------------------------------------------------------------------ */

export interface RoutingObligationsV2 {
  /** Primary targets not yet reviewed: attach the Finding to their planned assignment. */
  attachToAssignment: string[];
  /** Primary targets already reviewed: enter the whole-observation mandatory set. */
  mandatoryWholeDecision: string[];
}

/** A blocking cross-scope Finding is an obligation until a current-baseline verdict settles it. */
export function computeRoutingObligations(
  crossScopeFindingPrimaryTargets: readonly string[],
  reviewedTargets: ReadonlySet<string>,
): RoutingObligationsV2 {
  const attachToAssignment: string[] = [];
  const mandatoryWholeDecision: string[] = [];
  for (const target of crossScopeFindingPrimaryTargets) {
    if (reviewedTargets.has(target)) mandatoryWholeDecision.push(target);
    else attachToAssignment.push(target);
  }
  return { attachToAssignment, mandatoryWholeDecision };
}

/** Every finding stage listed in a round's verification plan exists and matches the Finding. */
export function validateVerificationFindingStages(
  finding: FindingV2,
  stages: readonly FindingStageV2[],
): void {
  if (stages.length === 0) throw new SchemaError('verification finding stages must be non-empty');
  const required = requiredStagesOf(finding.defectClass);
  if (stages.some((s) => !required.includes(s))) {
    throw new SchemaError(`verification stages ${stages.join(',')} do not match the Finding's required stages ${required.join(',')}`);
  }
}