/**
 * Pure WorkItem domain (Task 3, design §17.2; spec §10.1/§16.2): the closed
 * AuthorityBaseSetV2 required/null field matrix per WorkItem kind, WorkItem
 * field discriminants (agent vs system, structured vs generic), legal state
 * transitions, park disposition invariants, display-digest aliasing, retry
 * budget bounds and the monotonic digest-bound progress checkpoint.
 *
 * Pure module: no fs/EventStore/provider/HTTP/React, no wall clock, no random.
 */
import { SchemaError, type AuthorityBaseSetV2, type StructuredSessionKindV2, type WorkItemParkDispositionV2, type WorkItemStateV2, type WorkItemV2 } from './authority-types';
import type { WorkItemKindV2 } from '../../shared/authoritative-review-v2';

export type WorkItemExecutionKindV2 = 'structured_session' | 'generic_turn' | null;

/* ------------------------------------------------------------------ */
/* AuthorityBaseSetV2 field matrix (§17.2/§10.1)                       */
/* ------------------------------------------------------------------ */

export interface AuthorityBaseRuleV2 {
  /** Fields that MUST be non-null for this kind (profile/template refs are mandatory for every kind). */
  required: readonly (keyof AuthorityBaseSetV2)[];
  /** Optional fields that MAY be non-null; every other ref field must be null. */
  optional: readonly (keyof AuthorityBaseSetV2)[];
  /** exactly one of these field groups must be non-null (e.g. mapRef | mapCandidateRef). */
  oneOf: readonly (keyof AuthorityBaseSetV2)[][];
}

/**
 * Closed field matrix per allocation key (§17.2/§10.1). `optional` fields may
 * be non-null; anything outside required+optional must be null.
 */
const MATRIX: Readonly<Record<string, AuthorityBaseRuleV2>> = {
  // structured sessions
  structure_chunk: { required: ['planSpecRef'], optional: ['findingSetRef'], oneOf: [] },
  review_map_batch: { required: ['mapCandidateRef', 'reviewCoverageCoreRef', 'reviewRoundRef'], optional: ['findingSetRef'], oneOf: [] },
  review_map_whole: { required: ['mapCandidateRef', 'reviewCoverageCoreRef', 'reviewRoundRef'], optional: ['findingSetRef'], oneOf: [] },
  generation_batch: { required: ['mapRef', 'contentRevisionManifestRef', 'planSpecRef'], optional: ['findingSetRef'], oneOf: [] },
  review_content_batch: { required: ['mapRef', 'contentRevisionManifestRef', 'reviewCoverageCoreRef', 'reviewRoundRef'], optional: ['findingSetRef'], oneOf: [] },
  review_content_whole: { required: ['mapRef', 'contentRevisionManifestRef', 'reviewCoverageCoreRef', 'reviewRoundRef'], optional: ['findingSetRef'], oneOf: [] },
  map_repair: { required: ['planSpecRef', 'stagingManifestRef'], optional: ['findingSetRef'], oneOf: [['mapRef', 'mapCandidateRef']] },
  content_repair: { required: ['mapRef', 'contentRevisionManifestRef', 'planSpecRef', 'stagingManifestRef'], optional: ['findingSetRef'], oneOf: [] },
  // generic submitter
  submitter: { required: ['sealRecordRef', 'artifactRef', 'artifactDeliveryRef'], optional: [], oneOf: [] },
  // system commands
  system_map_finalize: { required: ['planSpecRef'], optional: ['stagingManifestRef', 'findingSetRef'], oneOf: [] },
  system_generation_finalize: { required: ['mapRef', 'contentRevisionManifestRef', 'planSpecRef'], optional: ['stagingManifestRef', 'findingSetRef'], oneOf: [] },
  system_repair_finalize: { required: ['planSpecRef', 'stagingManifestRef'], optional: ['findingSetRef'], oneOf: [['mapRef', 'mapCandidateRef']] },
  system_migration_validation_batch: { required: ['mapCandidateRef', 'planSpecRef'], optional: ['reviewRoundRef', 'findingSetRef'], oneOf: [] },
  system_review_settlement: { required: ['contentRevisionManifestRef', 'reviewCoverageCoreRef', 'reviewRoundRef'], optional: ['findingSetRef'], oneOf: [['mapRef', 'mapCandidateRef']] },
  system_seal: { required: ['mapRef', 'mapReviewBundleRef', 'contentRevisionManifestRef', 'reviewBundleRef'], optional: ['reviewCoverageCoreRef', 'findingSetRef'], oneOf: [] },
};

const ALLOCATION_KEY = (kind: WorkItemKindV2, execution: WorkItemExecutionKindV2, session: StructuredSessionKindV2 | null): string => {
  if (kind !== 'agent_assignment') return kind;
  if (execution === 'generic_turn') return 'submitter';
  if (session === null || !(session in MATRIX)) return 'submitter';
  return session;
};

/**
 * Validate the AuthorityBaseSet field matrix for one WorkItem kind/execution
 * combination. profile/template refs are mandatory for EVERY kind; unrelated
 * fields must be null; the matrix's oneOf groups require exactly one member.
 */
export function validateAuthorityBaseForWorkItem(
  base: AuthorityBaseSetV2,
  kind: WorkItemKindV2,
  execution?: WorkItemExecutionKindV2,
  session?: StructuredSessionKindV2 | null,
): string[] {
  const errors: string[] = [];
  const key = ALLOCATION_KEY(kind, execution ?? null, session ?? null);
  const rule = MATRIX[key];
  if (!rule) {
    errors.push(`no authority matrix for WorkItem kind '${key}'`);
    return errors;
  }
  if (!base.profileSnapshotRef) errors.push('profileSnapshotRef is mandatory for every WorkItem');
  if (!base.templateSnapshotRef) errors.push('templateSnapshotRef is mandatory for every WorkItem');
  const oneOfMember = rule.oneOf.flat();
  const allowed = new Set<keyof AuthorityBaseSetV2>([...rule.required, ...rule.optional, ...oneOfMember]);
  const refFields: readonly (keyof AuthorityBaseSetV2)[] = [
    'mapRef', 'mapCandidateRef', 'mapReviewBundleRef', 'contentRevisionManifestRef',
    'planSpecRef', 'stagingManifestRef', 'reviewCoverageCoreRef', 'reviewRoundRef',
    'reviewBundleRef', 'sealRecordRef', 'artifactRef', 'findingSetRef', 'artifactDeliveryRef',
  ];
  for (const field of refFields) {
    const value = base[field];
    if (value === null || value === undefined) continue;
    if (!allowed.has(field)) {
      errors.push(`${String(field)} is not allowed for '${key}'`);
    }
  }
  for (const field of rule.required) {
    const value = base[field];
    if (value === null || value === undefined) {
      errors.push(`${String(field)} is required for '${key}'`);
    }
  }
  for (const group of rule.oneOf) {
    const present = group.filter((field) => base[field] !== null && base[field] !== undefined);
    if (present.length !== 1) {
      errors.push(`'${key}' requires exactly one of ${group.map((f) => String(f)).join(' | ')}`);
    }
  }
  return errors;
}

export function assertGrantSpecAuthorityConsistent(input: {
  workItemAuthorityBaseRefDigest: string;
  grantSpecAuthorityBaseRefDigest: string;
  authorityBaseRefDigest: string;
}): void {
  if (
    input.workItemAuthorityBaseRefDigest !== input.authorityBaseRefDigest ||
    input.grantSpecAuthorityBaseRefDigest !== input.authorityBaseRefDigest
  ) {
    throw new SchemaError('WorkItem/GrantSpec must reference the SAME authorityBaseRef as their base set');
  }
}

/* ------------------------------------------------------------------ */
/* WorkItem field discriminants (§17.2/§10.1)                          */
/* ------------------------------------------------------------------ */

const REVIEW_SESSIONS: readonly string[] = ['review_map_batch', 'review_map_whole', 'review_content_batch', 'review_content_whole'];
const WRITE_SESSIONS: readonly string[] = ['structure_chunk', 'generation_batch', 'map_repair', 'content_repair'];
const SYSTEM_KINDS: readonly WorkItemKindV2[] = [
  'system_map_finalize',
  'system_generation_finalize',
  'system_repair_finalize',
  'system_migration_validation_batch',
  'system_review_settlement',
  'system_seal',
];

export function validateWorkItemForKind(workItem: WorkItemV2): string[] {
  const errors: string[] = [];
  const kind = workItem.kind;
  if (kind === 'agent_assignment') {
    if (!workItem.logicalAssignmentId) errors.push('agent assignments require logicalAssignmentId');
    const isReview = workItem.sessionKind !== null && REVIEW_SESSIONS.includes(workItem.sessionKind);
    if (isReview && !workItem.reviewAssignmentId) errors.push('review/observation assignments require reviewAssignmentId');
    if (!isReview && workItem.reviewAssignmentId !== null) errors.push('reviewAssignmentId is only legal for review sessions');
    if (workItem.agentExecutionKind === 'structured_session') {
      const legalSessions = [...WRITE_SESSIONS, ...REVIEW_SESSIONS];
      if (!workItem.sessionKind || !legalSessions.includes(workItem.sessionKind)) {
        errors.push('structured_session requires a legal structured sessionKind');
      }
      if (workItem.inputArtifactDeliveryId !== null) errors.push('structured_session forbids inputArtifactDeliveryId');
    } else if (workItem.agentExecutionKind === 'generic_turn') {
      if (workItem.sessionKind !== null) errors.push('generic_turn forbids sessionKind');
      if (!workItem.inputArtifactDeliveryId) errors.push('generic_turn (submitter) requires inputArtifactDeliveryId');
    } else {
      errors.push('agent_assignment requires agentExecutionKind structured_session|generic_turn');
    }
  } else if (SYSTEM_KINDS.includes(kind)) {
    if (workItem.logicalAssignmentId !== null || workItem.reviewAssignmentId !== null) {
      errors.push('system WorkItems carry no assignment identities');
    }
    if (workItem.agentExecutionKind !== null || workItem.sessionKind !== null) {
      errors.push('system WorkItems carry no Agent execution identity');
    }
    if (workItem.grantSpecRef !== null) errors.push('system WorkItems never hold a write grant spec');
    if (workItem.roleBinding !== null && workItem.roleBinding !== 'supervisor') errors.push('system WorkItems only allow the supervisor role binding');
  } else {
    errors.push(`unknown WorkItem kind '${kind}'`);
  }
  if (workItem.state === 'leased' && !workItem.leaseOwner) errors.push('leased WorkItem requires leaseOwner');
  return errors;
}

/* ------------------------------------------------------------------ */
/* State transitions (§17.2)                                           */
/* ------------------------------------------------------------------ */

const TRANSITIONS: Readonly<Record<WorkItemStateV2, readonly WorkItemStateV2[]>> = {
  ready: ['leased', 'superseded'],
  leased: ['completed', 'retryable_failed', 'terminal_failed', 'parked', 'superseded'],
  retryable_failed: ['ready', 'parked', 'terminal_failed', 'superseded'],
  parked: ['ready', 'superseded'],
  completed: [],
  terminal_failed: [],
  superseded: [],
};

export function assertWorkItemTransition(from: WorkItemStateV2, to: WorkItemStateV2): void {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new SchemaError(`illegal WorkItem transition '${from}' -> '${to}'`);
  }
}

/** Reclaim semantics: epoch strictly advances and the lease owner is cleared. */
export function assertReclaimAdvancesEpoch(previous: WorkItemV2, next: WorkItemV2): void {
  if (previous.state !== 'leased') throw new SchemaError('reclaim requires a leased WorkItem');
  if (next.state !== 'ready') throw new SchemaError('reclaim must return the WorkItem to ready');
  if (next.leaseEpoch !== previous.leaseEpoch + 1) throw new SchemaError('reclaim must advance leaseEpoch by exactly 1');
  if (next.leaseOwner !== null) throw new SchemaError('reclaimed WorkItem must clear leaseOwner');
}

/* ------------------------------------------------------------------ */
/* Park disposition invariants (§17.2)                                 */
/* ------------------------------------------------------------------ */

export function assertParkDispositionInvariants(disposition: WorkItemParkDispositionV2): void {
  if (disposition === null) return;
  if (disposition.kind === 'retry_budget_exhausted') {
    const keys = Object.keys(disposition).sort();
    if (keys.join(',') !== 'budgetPolicyDigest,kind,retryOrdinal') {
      throw new SchemaError('retry_budget_exhausted disposition must carry exactly kind/retryOrdinal/budgetPolicyDigest');
    }
    if (typeof disposition.retryOrdinal !== 'number' || disposition.retryOrdinal < 0) {
      throw new SchemaError('retryOrdinal must be a non-negative integer');
    }
    if (typeof disposition.budgetPolicyDigest !== 'string' || disposition.budgetPolicyDigest.length === 0) {
      throw new SchemaError('budgetPolicyDigest must be a non-empty digest string');
    }
    return;
  }
  if (disposition.kind === 'human_question') {
    const keys = Object.keys(disposition).sort();
    if (keys.join(',') !== 'kind,questionId,questionVersion') {
      throw new SchemaError('human_question disposition must carry exactly kind/questionId/questionVersion');
    }
    if (typeof disposition.questionId !== 'string' || disposition.questionId.length === 0) {
      throw new SchemaError('questionId must be a non-empty string');
    }
    if (typeof disposition.questionVersion !== 'string' || disposition.questionVersion.length === 0) {
      throw new SchemaError('questionVersion must be a non-empty token');
    }
    return;
  }
  throw new SchemaError(`unknown park disposition kind '${(disposition as { kind: string }).kind}'`);
}

/** A parked WorkItem always carries a disposition; non-parked never does. */
export function assertParkedConsistency(workItem: WorkItemV2): void {
  if (workItem.state === 'parked' && workItem.parkDisposition === null) {
    throw new SchemaError('parked WorkItem must carry a park disposition');
  }
  if (workItem.state !== 'parked' && workItem.parkDisposition !== null) {
    throw new SchemaError('non-parked WorkItem must not carry a park disposition');
  }
  assertParkDispositionInvariants(workItem.parkDisposition);
}

/* ------------------------------------------------------------------ */
/* Retry budget + progress checkpoint (§10.3/§16.2)                    */
/* ------------------------------------------------------------------ */

export function assertRetryBudgetWithinPolicy(input: {
  retryOrdinal: number;
  maxAutomaticRetries: number;
}): void {
  if (input.retryOrdinal > input.maxAutomaticRetries) {
    throw new SchemaError('REVIEW_REPAIR_LIMIT_EXCEEDED: automatic retry budget exhausted');
  }
}

export interface ProgressCheckpointV2 {
  coverageCount: number;
  observationLevel: number;
  findingStageCount: number;
  planOrdinal: number;
  digest: string;
}

/**
 * §16.2 monotonic progress guard: repetition WITHOUT new coverage/Finding/
 * plan advancement is the ONLY no-progress signal; a large planned plan never
 * triggers it. Checkpoint regression is a system failure (fail closed).
 */
export function assertProgressCheckpointMonotonic(previous: ProgressCheckpointV2, next: ProgressCheckpointV2): void {
  const advanced =
    next.coverageCount > previous.coverageCount ||
    next.observationLevel > previous.observationLevel ||
    next.findingStageCount > previous.findingStageCount ||
    next.planOrdinal > previous.planOrdinal;
  const digestAdvanced = next.digest !== previous.digest;
  if (!advanced && !digestAdvanced) {
    throw new SchemaError('NO_SEMANTIC_PROGRESS: retry did not advance the digest-bound progress checkpoint');
  }
  const regressed =
    next.coverageCount < previous.coverageCount ||
    next.observationLevel < previous.observationLevel ||
    next.findingStageCount < previous.findingStageCount ||
    next.planOrdinal < previous.planOrdinal;
  if (regressed) {
    throw new SchemaError('progress checkpoint regression is a system failure');
  }
}

/* ------------------------------------------------------------------ */
/* Display digests (§17.2: alias only, never custody)                  */
/* ------------------------------------------------------------------ */

export function assertDisplayDigestsAreAliases(base: AuthorityBaseSetV2): string[] {
  const errors: string[] = [];
  const refFields: readonly (keyof AuthorityBaseSetV2)[] = [
    'mapRef', 'mapCandidateRef', 'mapReviewBundleRef', 'contentRevisionManifestRef',
    'planSpecRef', 'stagingManifestRef', 'reviewCoverageCoreRef', 'reviewRoundRef',
    'reviewBundleRef', 'sealRecordRef', 'artifactRef', 'findingSetRef', 'artifactDeliveryRef',
  ];
  for (const field of refFields) {
    const ref = base[field];
    if (ref === null || ref === undefined) continue;
    const alias = base.displayDigests?.[field];
    if (typeof alias === 'string' && alias !== (ref as { digest: string }).digest) {
      errors.push(`displayDigests.${String(field)} does not equal the corresponding ref digest`);
    }
  }
  if (base.displayDigests) {
    for (const [key, value] of Object.entries(base.displayDigests)) {
      if (!(refFields as readonly string[]).includes(key)) {
        errors.push(`displayDigests has unknown alias '${key}'`);
        continue;
      }
      const ref = base[key as keyof AuthorityBaseSetV2];
      if (ref === null || ref === undefined) errors.push(`displayDigests.${key} references a null field`);
      else if (typeof value !== 'string' || value !== (ref as { digest: string }).digest) {
        errors.push(`displayDigests.${key} does not equal the ${key} ref digest`);
      }
    }
  }
  return errors;
}
