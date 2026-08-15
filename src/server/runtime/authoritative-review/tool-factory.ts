/**
 * Task 13 tool-factory (spec §11, design §18/§11.9/§12.4): the closure-bound
 * per-session tool set of an authoritative v2 attempt.
 *
 * NORMATIVE CORE: spec §11.1/§11.2/§11.3 define the EXACT per-session tool
 * lists; design §9's capability table discriminates which session kind gets
 * which tool. Tools never accept task/path/grant/lease/attempt/authority
 * fields — the server closure (`V2AttemptContext`) supplies them. Every
 * mutating tool requires `clientOperationId` (the frozen trusted-runner stable
 * tool-call identity is the only allowed equivalent) and FORBIDS every
 * authority field; `mapPassed/treePassed/sealApproved` outputs are unknown
 * fields and rejected by the strict schemas.
 *
 * The reviewer tool surface (§11.3) is implemented here:
 * - batch verdict tools accept ordinary anchored `findingDrafts` AND bounded
 *   `crossScopeFindingDrafts` (anchored to the assigned verdict target);
 * - WHOLE sessions alone receive the whole-finding tool
 *   (`submit_map_whole_finding` / `submit_whole_tree_finding`);
 * - `submit_finding_verification` is present ONLY when the frozen assignment
 *   contains verification targets; its exact body is only
 *   findingId/repairStage/verdict(resolved|still_present)/evidence/
 *   clientOperationId, while the closure binds task/round/assignment/attempt/
 *   base;
 * - reviewer sessions expose NO Map/content write, Seal, Grant, free-standing
 *   `submit_finding`, or Finding-close tool.
 *
 * The verification flow (spec §11.3, design §11.9): `submit_finding_verification`
 * validates reviewer-source/current-addressed-stage/round-verification-target/
 * baseline/one-record-per-stage and writes ONLY the current attempt's private
 * review journal. `complete_review_assignment` reads the journal, verifies one
 * record for each `verificationFindingStage` PLUS all ordinary verdict targets,
 * then FREEZES ReviewFacts and FindingVerificationRecords TOGETHER in one
 * AssignmentLedgerBlob and delegates the atomic publication to the injected
 * `freezeReviewAssignment` seam (later tasks wire the facade builder).
 * Stale/non-addressed/system-validator/wrong-stage/wrong-baseline/duplicate
 * verification rejects WITHOUT partial publication.
 *
 * V1 byte-for-byte: this is a NEW module; the v1 tool surface is untouched.
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type Static, type TSchema } from 'typebox';
import type { BlobRefV2, AuthoritativeBlobKindV2 } from '../../../shared/authoritative-review-v2';
import type { AuthoritativeReviewProjectionV2 } from '../../storage/authoritative-review-state';
import type { AgentTurnInput } from '../agent-runtime';
import type { V2AttemptContext } from './attempt-coordinator';
import type { ResolvedAttemptGrant } from './grant-service';
import {
  GrantError,
  GrantService,
  assertContentWriteAuthorized,
  assertPayloadWithinProfile,
  classifyToolReplay,
} from './grant-service';
import type { AuthoritativeReviewPrivateStore, ReviewDraftBindingV2 } from '../../storage/authoritative-review-private-store';
import { PrivateStoreError } from '../../storage/authoritative-review-private-store';
import { canonicalJsonBytes, canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type {
  AssignmentLedgerBlobV2,
  AuthoritativeReviewProfile,
  ContentReviewCoverageCoreV2,
  FindingVerificationRecordV2,
  FindingV2,
  MapReviewRoundV2,
  ReviewFactV2,
  ReviewPolicyParameters,
  ReviewRoundV2,
} from '../../authoritative-review/authority-types';
import { grantWriteAuthority } from '../../authoritative-review/authority-types';
import { refOfBlob } from '../../authoritative-review/object-registry';
import { deterministicEventId } from '../../storage/authoritative-publication-intent-registry';
import {
  FindingDraftRegistryV2,
  evidenceStringsToReviewEvidence,
  type CrossScopeRoutingObligationV2,
} from './finding-draft-registry';
import { resolveContentRoundFromCore } from './content-review-service';

/* ------------------------------------------------------------------ */
/* Closed per-session tool lists (spec §11.1/§11.2/§11.3, design §9)   */
/* ------------------------------------------------------------------ */

export const STRUCTURE_CHUNK_TOOLS = [
  'read_structure_contract',
  'read_map_build_frontier',
  'append_map_candidate_chunk',
  'finish_map_build',
] as const;

export const MAP_REPAIR_TOOLS = [
  'read_active_map',
  'read_slot_content',
  'read_map_repair_staging',
  'submit_map_patch',
  'request_scope_expansion',
] as const;

export const GENERATION_BATCH_TOOLS = [
  'read_active_map',
  'read_slot_content',
  'read_related_context',
  'write_slot_content',
  'submit_content_draft',
  'request_scope_expansion',
] as const;

export const CONTENT_REPAIR_TOOLS = GENERATION_BATCH_TOOLS;

export const REVIEW_MAP_BATCH_TOOLS = [
  'read_map_candidate',
  'submit_map_node_review',
  'submit_map_relation_review',
  'submit_finding_verification',
  'complete_review_assignment',
] as const;

export const REVIEW_MAP_WHOLE_TOOLS = [
  'read_map_candidate',
  'submit_map_whole_finding',
  'submit_finding_verification',
  'complete_review_assignment',
] as const;

export const REVIEW_CONTENT_BATCH_TOOLS = [
  'read_active_map',
  'read_slot_content',
  'read_relation_context',
  'submit_slot_review',
  'submit_relation_review',
  'submit_finding_verification',
  'complete_review_assignment',
] as const;

export const REVIEW_CONTENT_WHOLE_TOOLS = [
  'read_active_map',
  'read_slot_content',
  'read_relation_context',
  'submit_whole_tree_finding',
  'submit_finding_verification',
  'complete_review_assignment',
] as const;

export const REVIEWER_TOOL_NAMES = new Set<string>([
  ...REVIEW_MAP_BATCH_TOOLS,
  ...REVIEW_MAP_WHOLE_TOOLS,
  ...REVIEW_CONTENT_BATCH_TOOLS,
  ...REVIEW_CONTENT_WHOLE_TOOLS,
]);

/** Tools a reviewer MUST NEVER receive (spec §11.3, design §7/§18.3). */
export const REVIEWER_FORBIDDEN_TOOLS = new Set<string>([
  'write_slot_content',
  'append_map_candidate_chunk',
  'finish_map_build',
  'submit_map_patch',
  'submit_content_draft',
  'request_scope_expansion',
  'seal',
  'submit_final_artifact',
  'submit_finding',
]);

export type V2ToolName =
  | (typeof STRUCTURE_CHUNK_TOOLS)[number]
  | (typeof MAP_REPAIR_TOOLS)[number]
  | (typeof GENERATION_BATCH_TOOLS)[number]
  | (typeof REVIEW_MAP_BATCH_TOOLS)[number]
  | (typeof REVIEW_MAP_WHOLE_TOOLS)[number]
  | (typeof REVIEW_CONTENT_BATCH_TOOLS)[number]
  | (typeof REVIEW_CONTENT_WHOLE_TOOLS)[number];

/* ------------------------------------------------------------------ */
/* Exact tool schemas (strict — unknown fields rejected)               */
/* ------------------------------------------------------------------ */

const CO_ID = Type.String({ minLength: 1, maxLength: 256 });
const DIGEST = Type.String({ minLength: 64, maxLength: 64 });
const EVIDENCE = Type.Array(Type.String({ maxLength: 8192 }));

/**
 * STRICT object schema: the spec requires EXACT tool bodies — every mutating
 * tool's schema rejects unknown fields (authority fields, mapPassed/
 * treePassed/sealApproved, …). TypeBox `Type.Object` is permissive by default,
 * so we force `additionalProperties: false` on every tool schema object.
 */
function strictObject<T extends Record<string, TSchema>>(properties: T): TSchema {
  return { ...Type.Object(properties), additionalProperties: false } as TSchema;
}

const pageFields = {
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
} as const;

const findingDraftSchema = strictObject({
  clientFindingKey: Type.String({ minLength: 1, maxLength: 256 }),
  defectClass: Type.Union([Type.Literal('content'), Type.Literal('map'), Type.Literal('mixed')]),
  severity: Type.Union([Type.Literal('blocking'), Type.Literal('advisory')]),
  primaryLocation: strictObject({
    kind: Type.Union([Type.Literal('slot'), Type.Literal('relation'), Type.Literal('map_node'), Type.Literal('map')]),
    id: Type.String({ minLength: 1, maxLength: 512 }),
  }),
  relatedSlotIds: Type.Optional(Type.Array(Type.String({ maxLength: 512 }))),
  relatedRelationIds: Type.Optional(Type.Array(Type.String({ maxLength: 512 }))),
  suggestedRepairSlotIds: Type.Optional(Type.Array(Type.String({ maxLength: 512 }))),
  evidence: EVIDENCE,
});

/** Constrained cross-scope draft: anchored to the assigned verdict target,
 * names ONE existing target in the same frozen baseline as `primaryTarget`.
 * `primaryTargetKind` is OPTIONAL (FIX-M1): when absent the freeze derives the
 * kind from the round's frozen target lists — it never guesses map_node. */
const crossScopeFindingDraftSchema = strictObject({
  clientFindingKey: Type.String({ minLength: 1, maxLength: 256 }),
  primaryTarget: Type.String({ minLength: 1, maxLength: 512 }),
  primaryTargetKind: Type.Optional(Type.Union([Type.Literal('slot'), Type.Literal('relation'), Type.Literal('map_node')])),
  defectClass: Type.Union([Type.Literal('content'), Type.Literal('map'), Type.Literal('mixed')]),
  severity: Type.Union([Type.Literal('blocking'), Type.Literal('advisory')]),
  evidence: EVIDENCE,
});

const mapVerdictSchema = strictObject({
  targetId: Type.String({ minLength: 1, maxLength: 512 }),
  verdict: Type.Union([Type.Literal('pass'), Type.Literal('reject')]),
  evidence: EVIDENCE,
  findingDrafts: Type.Optional(Type.Array(findingDraftSchema)),
  crossScopeFindingDrafts: Type.Optional(Type.Array(crossScopeFindingDraftSchema)),
  clientOperationId: CO_ID,
});

const relationVerdictSchema = strictObject({
  targetId: Type.String({ minLength: 1, maxLength: 512 }),
  verdict: Type.Union([Type.Literal('satisfied'), Type.Literal('violated')]),
  evidence: EVIDENCE,
  findingDrafts: Type.Optional(Type.Array(findingDraftSchema)),
  crossScopeFindingDrafts: Type.Optional(Type.Array(crossScopeFindingDraftSchema)),
  clientOperationId: CO_ID,
});

const wholeFindingSchema = strictObject({
  findingDraft: findingDraftSchema,
  anchoredVerdict: Type.Optional(
    strictObject({
      targetId: Type.String({ minLength: 1, maxLength: 512 }),
      verdict: Type.Union([Type.Literal('pass'), Type.Literal('reject'), Type.Literal('satisfied'), Type.Literal('violated')]),
      evidence: EVIDENCE,
    }),
  ),
  clientOperationId: CO_ID,
});

const requestScopeExpansionMapSchema = strictObject({
  findingIds: Type.Array(Type.String({ maxLength: 512 })),
  requestedNodeIds: Type.Array(Type.String({ maxLength: 512 })),
  requestedRelationIds: Type.Array(Type.String({ maxLength: 512 })),
  reason: Type.String({ minLength: 1, maxLength: 4000 }),
  clientOperationId: CO_ID,
});

const requestScopeExpansionContentSchema = strictObject({
  findingIds: Type.Array(Type.String({ maxLength: 512 })),
  requestedSlotIds: Type.Array(Type.String({ maxLength: 512 })),
  reason: Type.String({ minLength: 1, maxLength: 4000 }),
  clientOperationId: CO_ID,
});

const mapNodeSchema = strictObject({
  buildNodeKey: Type.String({ minLength: 1, maxLength: 512 }),
  slotType: Type.String({ minLength: 1, maxLength: 256 }),
  parentBuildNodeKey: Type.Optional(Type.String({ maxLength: 512 })),
  documentOrder: Type.Integer(),
  siblingOrder: Type.Integer(),
  contentBearing: Type.Boolean(),
});

const mapRelationSchema = strictObject({
  buildRelationKey: Type.String({ minLength: 1, maxLength: 512 }),
  typeId: Type.String({ minLength: 1, maxLength: 256 }),
  fromBuildNodeKey: Type.String({ minLength: 1, maxLength: 512 }),
  toBuildNodeKey: Type.String({ minLength: 1, maxLength: 512 }),
  attributes: Type.Object({}, { additionalProperties: true }),
});

const mapPatchOperationSchema = strictObject({
  kind: Type.Union([Type.Literal('add_node'), Type.Literal('remove_node'), Type.Literal('add_relation'), Type.Literal('remove_relation'), Type.Literal('update_attributes')]),
  targetId: Type.Optional(Type.String({ maxLength: 512 })),
  node: Type.Optional(mapNodeSchema),
  relation: Type.Optional(mapRelationSchema),
});

/** The exact schemas per tool name (strict; authority fields forbidden). */
const TOOL_SCHEMAS: Readonly<Record<V2ToolName, TSchema>> = {
  read_structure_contract: strictObject({}),
  read_map_build_frontier: strictObject(pageFields),
  read_map_repair_staging: strictObject(pageFields),
  read_active_map: strictObject({ parentId: Type.Optional(Type.String({ maxLength: 512 })), ...pageFields }),
  read_slot_content: strictObject({ slotIds: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { minItems: 1, maxItems: 256 }) }),
  read_related_context: strictObject({ slotId: Type.String({ minLength: 1, maxLength: 512 }), maxHops: Type.Integer({ minimum: 0, maximum: 8 }) }),
  read_map_candidate: strictObject(pageFields),
  read_relation_context: strictObject({ relationId: Type.String({ minLength: 1, maxLength: 512 }), ...pageFields }),

  append_map_candidate_chunk: strictObject({
    ordinal: Type.Integer({ minimum: 1 }),
    expectedFrontierDigest: DIGEST,
    nodes: Type.Array(mapNodeSchema, { minItems: 1, maxItems: 1024 }),
    relations: Type.Array(mapRelationSchema, { maxItems: 256 }),
    clientOperationId: CO_ID,
  }),
  finish_map_build: strictObject({
    expectedChunkCount: Type.Integer({ minimum: 1 }),
    expectedFrontierDigest: DIGEST,
    expectedRootCount: Type.Integer({ minimum: 1 }),
    clientOperationId: CO_ID,
  }),
  submit_map_patch: strictObject({
    expectedStagingDigest: DIGEST,
    operations: Type.Array(mapPatchOperationSchema, { minItems: 1, maxItems: 1024 }),
    clientOperationId: CO_ID,
  }),
  request_scope_expansion: strictObject({}),
  write_slot_content: strictObject({
    slotId: Type.String({ minLength: 1, maxLength: 512 }),
    value: Type.String({ maxLength: 1_048_576 }),
    clientOperationId: CO_ID,
  }),
  submit_content_draft: strictObject({
    expectedManifestDigest: DIGEST,
    clientOperationId: CO_ID,
  }),
  submit_map_node_review: mapVerdictSchema,
  submit_map_relation_review: relationVerdictSchema,
  submit_slot_review: mapVerdictSchema,
  submit_relation_review: relationVerdictSchema,
  submit_map_whole_finding: wholeFindingSchema,
  submit_whole_tree_finding: wholeFindingSchema,
  submit_finding_verification: strictObject({
    findingId: Type.String({ minLength: 1, maxLength: 512 }),
    repairStage: Type.Union([Type.Literal('map'), Type.Literal('content')]),
    verdict: Type.Union([Type.Literal('resolved'), Type.Literal('still_present')]),
    evidence: EVIDENCE,
    clientOperationId: CO_ID,
  }),
  complete_review_assignment: strictObject({
    clientOperationId: CO_ID,
  }),
};

/** The scope-expansion schema depends on the session domain (map vs content). */
function scopeExpansionSchema(sessionKind: string): TSchema {
  if (sessionKind === 'map_repair') return requestScopeExpansionMapSchema;
  return requestScopeExpansionContentSchema;
}

/* ------------------------------------------------------------------ */
/* Domain handler seam (later tasks wire the real domain services)     */
/* ------------------------------------------------------------------ */

export interface V2DomainHandlers {
  /** orchestrator build writes (Task 15 map-build-service). */
  appendMapCandidateChunk?(ctx: V2AttemptContext, params: Record<string, unknown>): Promise<unknown>;
  finishMapBuild?(ctx: V2AttemptContext, params: Record<string, unknown>): Promise<unknown>;
  submitMapPatch?(ctx: V2AttemptContext, params: Record<string, unknown>): Promise<unknown>;
  /** generator/repair writes (Task 16 content-plan-service). */
  writeSlotContent?(ctx: V2AttemptContext, params: Record<string, unknown>): Promise<unknown>;
  submitContentDraft?(ctx: V2AttemptContext, params: Record<string, unknown>): Promise<unknown>;
  requestScopeExpansion?(ctx: V2AttemptContext, params: Record<string, unknown>): Promise<unknown>;
  /** bounded reads (later projection services). */
  read?(ctx: V2AttemptContext, toolName: string, params: Record<string, unknown>): Promise<unknown>;
}

/** The frozen review-assignment freeze handed to the publication seam. */
export interface FrozenReviewAssignmentV2 {
  ledger: AssignmentLedgerBlobV2;
  facts: readonly ReviewFactV2[];
  verifications: readonly FindingVerificationRecordV2[];
  findings: readonly FindingV2[];
  factRefs: readonly BlobRefV2[];
  verificationRecordRefs: readonly BlobRefV2[];
  findingDraftRefs: readonly BlobRefV2[];
  /** whole-observation finding refs (whole sessions only). */
  wholeObservationRefs: readonly BlobRefV2[];
  /** cross-scope routing obligations (spec §11.3). */
  routingObligations: readonly CrossScopeRoutingObligationV2[];
}

/* ------------------------------------------------------------------ */
/* Pure verification validation + freeze construction (unit-tested)    */
/* ------------------------------------------------------------------ */

export interface VerificationSubmissionV2 {
  findingId: string;
  repairStage: 'map' | 'content';
  verdict: 'resolved' | 'still_present';
  evidence: readonly string[];
}

/**
 * Validates one `submit_finding_verification` against the frozen round and the
 * projected findings. Returns the error list ([] when legal). Every rejection
 * happens BEFORE any journal write — zero partial publication.
 */
export function validateVerificationSubmission(input: {
  submission: VerificationSubmissionV2;
  round: MapReviewRoundV2 | ReviewRoundV2;
  findings: Readonly<Record<string, { source: string; state: string; addressStages: readonly string[]; verifiedStages: readonly string[]; reviewContext: { kind: string; roundId: string } }>>;
}): string[] {
  const errors: string[] = [];
  const { submission, round, findings } = input;
  const finding = findings[submission.findingId];
  if (finding === undefined) {
    errors.push(`finding '${submission.findingId}' does not exist`);
    return errors;
  }
  // reviewer-source only (system-validator findings are re-run by the engine).
  if (finding.source !== 'reviewer') {
    errors.push(`finding '${submission.findingId}' is source '${finding.source}', not reviewer`);
  }
  // current addressed stage — the verification must target the CURRENT stage.
  if (finding.state !== 'addressed') {
    errors.push(`finding '${submission.findingId}' is '${finding.state}', not addressed`);
  }
  if (!finding.addressStages.includes(submission.repairStage)) {
    errors.push(`repairStage '${submission.repairStage}' is not the current addressed stage of finding '${submission.findingId}'`);
  }
  // the stage must be a frozen verification target of the current round.
  const targets = round.verificationFindingStages;
  const targetKey = `${submission.findingId}:${submission.repairStage}`;
  if (!targets.includes(targetKey)) {
    errors.push(`finding '${submission.findingId}' stage '${submission.repairStage}' is not a frozen verification target of this round`);
  }
  // The frozen finding-stage target owns verification authority. A mixed
  // Finding is opened in a Map round and later verified for its content stage
  // in a Content round, so opening-context kind is not a legal stage filter.
  // Exact-round binding applies only to non-addressed findings.
  if (finding.state !== 'addressed' && finding.reviewContext.roundId !== roundIdOf(round)) {
    errors.push(`finding '${submission.findingId}' binds round '${finding.reviewContext.roundId}', not '${roundIdOf(round)}'`);
  }
  // one record per stage — no duplicate verification already recorded.
  if (finding.verifiedStages.includes(submission.repairStage)) {
    errors.push(`finding '${submission.findingId}' stage '${submission.repairStage}' is already verified`);
  }
  return errors;
}

function roundKindOf(round: MapReviewRoundV2 | ReviewRoundV2): 'map' | 'content' {
  return 'mapReviewRoundId' in round ? 'map' : 'content';
}

function roundIdOf(round: MapReviewRoundV2 | ReviewRoundV2): string {
  return 'mapReviewRoundId' in round ? round.mapReviewRoundId : round.reviewRoundId;
}

/** True for the whole-observation reviewer session kinds. */
export function isWholeSessionKind(sessionKind: string): boolean {
  return sessionKind === 'review_map_whole' || sessionKind === 'review_content_whole';
}

/**
 * The ASSIGNMENT-scoped ordinary target set of the round (design §11.10):
 * `coverage*` is the full tree-Gate coverage, while `assignment*` contains ONLY
 * the targets requiring NEW Agent judgment this round — the difference is
 * covered by still-valid `inheritedRecordRefs`. Content rounds carry
 * `assignmentSlotIds`/`assignmentRelationIds`; Map rounds carry NO per-target
 * assignment fields (only `assignmentIds`). Returns null when the round does
 * not carry the assignment target set — the completion MUST fail closed and
 * ask Task 14's AssignmentDispatch seam rather than silently falling back to
 * the full round coverage.
 */
export function assignmentTargetsOf(round: MapReviewRoundV2 | ReviewRoundV2): readonly string[] | null {
  if ('mapReviewRoundId' in round) {
    return null; // map rounds carry no per-target assignment fields
  }
  const slotTargets = round.assignmentSlotIds;
  const relationTargets = round.assignmentRelationIds;
  if (slotTargets.length === 0 && relationTargets.length === 0) {
    return null;
  }
  return [...slotTargets, ...relationTargets];
}

/** targetId → targetKind over the round's frozen BASELINE (cross-scope
 * primary targets must exist in the exact frozen baseline; FIX-M1 derives
 * their kind here instead of guessing). */
export function baselineTargetKindsOf(round: MapReviewRoundV2 | ReviewRoundV2): Readonly<Record<string, ReviewFactV2['targetKind']>> {
  const out: Record<string, ReviewFactV2['targetKind']> = {};
  if ('mapReviewRoundId' in round) {
    for (const id of round.coverageNodeIds) out[id] = 'map_node';
    for (const id of round.coverageRelationIds) out[id] = 'map_relation';
  } else {
    for (const id of round.coverageSlotIds) out[id] = 'content_slot';
    for (const id of round.coverageRelationIds) out[id] = 'content_relation';
  }
  return out;
}

export interface ReviewDraftRecordV2 {
  op: string;
  body: Record<string, unknown>;
  /** the durable journal entry timestamp (system-owned; binds fact recordedAt). */
  at: string;
}

/** Deterministic factId of one ordinary verdict fact (system-owned). */
export function reviewFactId(attemptId: string, targetKind: string, targetStableId: string): string {
  return `fact-${canonicalJsonSha256({ attemptId, targetKind, targetStableId }).slice(0, 32)}`;
}

/** Deterministic verification recordId of one verification. */
export function verificationRecordId(attemptId: string, findingId: string, repairStage: string): string {
  return `ver-${canonicalJsonSha256({ attemptId, findingId, repairStage }).slice(0, 32)}`;
}

/** The ordinary verdict tool that covers one target kind (spec §11.3). */
export function verdictToolForTargetKind(targetKind: ReviewFactV2['targetKind']): string {
  switch (targetKind) {
    case 'map_node':
      return 'submit_map_node_review';
    case 'map_relation':
      return 'submit_map_relation_review';
    case 'content_slot':
      return 'submit_slot_review';
    case 'content_relation':
      return 'submit_relation_review';
  }
}

/** Target kind of one ordinary verdict record's tool. */
export function targetKindOfOp(op: string): ReviewFactV2['targetKind'] {
  switch (op) {
    case 'submit_map_node_review':
      return 'map_node';
    case 'submit_map_relation_review':
      return 'map_relation';
    case 'submit_slot_review':
      return 'content_slot';
    case 'submit_relation_review':
      return 'content_relation';
    default:
      return 'map_node';
  }
}

const WHOLE_FINDING_OPS = new Set(['submit_map_whole_finding', 'submit_whole_tree_finding']);
const ORDINARY_VERDICT_OPS = new Set(['submit_map_node_review', 'submit_map_relation_review', 'submit_slot_review', 'submit_relation_review']);

/** The legal verdict values of one fact target kind (parseReviewFact enforces
 * pass|reject for node/slot facts and satisfied|violated for relation facts). */
export function verdictValuesForTargetKind(targetKind: ReviewFactV2['targetKind']): readonly string[] {
  return targetKind === 'content_relation' || targetKind === 'map_relation'
    ? ['satisfied', 'violated']
    : ['pass', 'reject'];
}

/** Fact target kind → finding primaryLocation kind (FIX-M1 inverse mapping). */
export function factTargetKindToPrimaryLocationKind(targetKind: ReviewFactV2['targetKind']): FindingV2['primaryLocation']['kind'] {
  switch (targetKind) {
    case 'content_slot':
      return 'slot';
    case 'content_relation':
    case 'map_relation':
      return 'relation';
    case 'map_node':
      return 'map_node';
  }
}

/** Journal-derived subject digest (Task 21 replaces with the resolved
 * baseline digest; a fabricated value never satisfies a Gate — it fails safe). */
function journalSubjectDigest(body: Record<string, unknown>): string {
  return canonicalJsonSha256({ subject: body.targetId, verdict: body.verdict, evidence: body.evidence ?? [] });
}

function journalContextDigest(roundId: string, targetId: string): string {
  return canonicalJsonSha256({ context: roundId, targetId });
}

function draftOf(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const draft = body[key];
  return typeof draft === 'object' && draft !== null ? (draft as Record<string, unknown>) : {};
}

/**
 * Builds the review-assignment freeze (facts + finding drafts + verification
 * records + ledger) from the journal records.
 *
 * COVERAGE COMPLETENESS (spec §11.3 / brief Step 2): for a BATCH session the
 * freeze requires EXACTLY the ASSIGNMENT-scoped target set (design §11.10:
 * `assignment*`, NOT the full tree-Gate `coverage*`) to have one final verdict
 * record each (the record's tool must cover that target kind), and every
 * ordinary record's target must be a member of that set. A WHOLE session
 * freezes its whole-finding records instead (no ordinary verdict requirement).
 * Unassigned / partial / duplicate coverage rejects with ZERO partial
 * publication.
 */
export function buildReviewAssignmentFreeze(input: {
  assignmentId: string;
  workItemId: string;
  reviewAssignmentId: string | null;
  roundKind: 'map' | 'content';
  roundId: string;
  attemptId: string;
  reviewerAttemptId: string;
  reviewPolicyDigest: string;
  records: readonly ReviewDraftRecordV2[];
  /** every verificationFindingStage of the round (frozen targets). */
  verificationFindingStages: readonly string[];
  /** the ASSIGNMENT-scoped ordinary target IDs (batch sessions; NOT the round
   * coverage — the inherited difference is covered by inheritedRecordRefs). */
  assignmentTargets: readonly string[];
  /** targetId → targetKind over the round's frozen baseline (cross-scope
   * primary targets must exist in it; FIX-M1 derives their kind). */
  baselineTargetKinds: Readonly<Record<string, ReviewFactV2['targetKind']>>;
  /** true for batch sessions (require EXACT assignment targets); false for whole sessions. */
  requireOrdinaryCoverage: boolean;
}): { ok: true; freeze: FrozenReviewAssignmentV2 } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const facts: ReviewFactV2[] = [];
  const verifications: FindingVerificationRecordV2[] = [];
  const wholeObservationRefs: BlobRefV2[] = [];

  const ordinaryRecords: ReviewDraftRecordV2[] = [];
  const wholeRecords: ReviewDraftRecordV2[] = [];
  for (const record of input.records) {
    if (record.op === 'submit_finding_verification') continue;
    if (WHOLE_FINDING_OPS.has(record.op)) {
      wholeRecords.push(record);
    } else if (ORDINARY_VERDICT_OPS.has(record.op)) {
      ordinaryRecords.push(record);
    } else if (record.op === 'complete_review_assignment') {
      continue; // the completion marker is not a verdict
    } else {
      errors.push(`review record '${record.op}' is not a legal verdict/verification record`);
    }
  }

  if (input.requireOrdinaryCoverage && wholeRecords.length > 0) {
    errors.push('a batch assignment cannot freeze whole-observation findings');
  }
  if (!input.requireOrdinaryCoverage && ordinaryRecords.length > 0) {
    errors.push('a whole-observation assignment cannot freeze ordinary verdicts');
  }

  // ---- Ordinary verdict records: EXACT round-coverage completeness (I-2).
  const verdictByTarget = new Map<string, ReviewDraftRecordV2>();
  for (const record of ordinaryRecords) {
    const targetId = String(record.body.targetId ?? '');
    if (targetId === '') {
      errors.push(`review record '${record.op}' carries no targetId`);
      continue;
    }
    if (!input.assignmentTargets.includes(targetId)) {
      errors.push(`verdict target '${targetId}' is not a member of the assignment's target set (unassigned target)`);
      continue;
    }
    const expectedOp = verdictToolForTargetKind(targetKindOfOp(record.op));
    if (record.op !== expectedOp) {
      errors.push(`verdict tool '${record.op}' does not cover target '${targetId}' (expected '${expectedOp}')`);
    }
    if (verdictByTarget.has(targetId)) {
      errors.push(`duplicate verdict target '${targetId}' (one final submission per target)`);
    } else {
      verdictByTarget.set(targetId, record);
    }
  }
  if (input.requireOrdinaryCoverage) {
    for (const target of input.assignmentTargets) {
      if (!verdictByTarget.has(target)) {
        errors.push(`missing ordinary verdict for assignment target '${target}'`);
      }
    }
  }

  // The finding-draft registry is built AFTER the verdict set so cross-scope
  // routing distinguishes a REVIEWED primary (whole-decision obligation) from
  // an UNREVIEWED primary (deterministic successor obligation).
  const registry = new FindingDraftRegistryV2(
    { attemptId: input.attemptId, reviewerAttemptId: input.reviewerAttemptId, roundKind: input.roundKind, roundId: input.roundId },
    new Set(verdictByTarget.keys()),
  );

  // ---- Whole-finding records (I-1): anchored whole-observation findings.
  const wholeByKey = new Map<string, ReviewDraftRecordV2>();
  for (const record of wholeRecords) {
    const draft = draftOf(record.body, 'findingDraft');
    const key = String(draft.clientFindingKey ?? '');
    if (key === '') {
      errors.push('a whole-finding record carries no clientFindingKey');
      continue;
    }
    if (wholeByKey.has(key)) {
      errors.push(`duplicate whole finding '${key}'`);
    } else {
      wholeByKey.set(key, record);
    }
  }

  // ---- Ordinary verdict facts + their finding drafts (I-3).
    for (const [targetId, record] of verdictByTarget) {
    const body = record.body;
    const targetKind = targetKindOfOp(record.op);
    const draftInputs = Array.isArray(body.findingDrafts) ? (body.findingDrafts as unknown[]) : [];
    const findingIds: string[] = [];
    for (const raw of draftInputs) {
      const d = raw as Record<string, unknown>;
      if (typeof d.clientFindingKey !== 'string' || d.clientFindingKey === '') {
        errors.push('an ordinary finding draft carries no clientFindingKey');
        continue;
      }
      const materialized = registry.materialize({
        clientFindingKey: d.clientFindingKey,
        defectClass: d.defectClass as FindingV2['defectClass'],
        severity: d.severity as FindingV2['severity'],
        primaryLocation: {
          kind: ((d.primaryLocation as Record<string, unknown> | null)?.kind ?? 'map_node') as FindingV2['primaryLocation']['kind'],
          id: String((d.primaryLocation as Record<string, unknown> | null)?.id ?? ''),
        },
        relatedSlotIds: Array.isArray(d.relatedSlotIds) ? (d.relatedSlotIds as string[]) : [],
        relatedRelationIds: Array.isArray(d.relatedRelationIds) ? (d.relatedRelationIds as string[]) : [],
        suggestedRepairSlotIds: Array.isArray(d.suggestedRepairSlotIds) ? (d.suggestedRepairSlotIds as string[]) : [],
        evidence: Array.isArray(d.evidence) ? (d.evidence as string[]) : [],
      });
      findingIds.push(materialized.findingId);
    }
    // Cross-scope drafts (spec §11.3): anchored to this assigned source target,
    // naming an existing target in the SAME frozen baseline as primaryTarget.
    const crossScopeInputs = Array.isArray(body.crossScopeFindingDrafts) ? (body.crossScopeFindingDrafts as unknown[]) : [];
    for (const raw of crossScopeInputs) {
      const d = raw as Record<string, unknown>;
      const primaryTarget = String(d.primaryTarget ?? '');
      if (typeof d.clientFindingKey !== 'string' || d.clientFindingKey === '') {
        errors.push('a cross-scope finding draft carries no clientFindingKey');
        continue;
      }
      if (primaryTarget === '') {
        errors.push('a cross-scope finding draft carries no primaryTarget');
        continue;
      }
      // FIX-M1: the primary target kind is the draft's own declared kind when
      // present, else derived from the round's frozen baseline — NEVER a
      // hardcoded map_node guess.
      const declaredKind = d.primaryTargetKind;
      const primaryKind: ReviewFactV2['targetKind'] | null =
        declaredKind === 'slot'
          ? 'content_slot'
          : declaredKind === 'relation'
            ? 'content_relation'
            : declaredKind === 'map_node'
              ? 'map_node'
              : (input.baselineTargetKinds[primaryTarget] ?? null);
      if (primaryKind === null) {
        errors.push(`cannot determine the primary target kind of '${primaryTarget}' (declare primaryTargetKind or bind it in the round baseline)`);
        continue;
      }
      // The registry's routing distinguishes a REVIEWED primary target
      // (whole-observation mandatory-decision obligation) from an UNREVIEWED
      // primary (deterministic successor obligation).
      registry.materializeCrossScope({
        clientFindingKey: d.clientFindingKey,
        defectClass: d.defectClass as FindingV2['defectClass'],
        severity: d.severity as FindingV2['severity'],
        primaryLocation: { kind: factTargetKindToPrimaryLocationKind(primaryKind), id: primaryTarget },
        evidence: Array.isArray(d.evidence) ? (d.evidence as string[]) : [],
      }, targetId, primaryTarget);
    }
    const fact: ReviewFactV2 = {
      factId: reviewFactId(input.attemptId, targetKind, targetId),
      targetKind,
      targetStableId: targetId,
      verdict: String(body.verdict ?? ''),
      factOrigin: { kind: 'batch', adoptionEligible: true },
      adoptionEligible: true,
      localSubjectDigest: String(body.subjectDigest ?? '') || journalSubjectDigest(body),
      localContextDigest: String(body.contextDigest ?? '') || journalContextDigest(input.roundId, targetId),
      reviewPolicyDigest: input.reviewPolicyDigest,
      findingIds,
      evidence: evidenceStringsToReviewEvidence(Array.isArray(body.evidence) ? (body.evidence as string[]) : []),
      reviewerAttemptId: input.reviewerAttemptId,
      recordedAt: String(body.recordedAt ?? '') || record.at,
    };
    facts.push(fact);
  }

  // ---- Whole-observation facts (I-1): the anchored whole-finding draft +
  // optional anchored verdict → whole_observation fact (adoptionEligible false).
  for (const record of wholeByKey.values()) {
    const body = record.body;
    const draft = draftOf(body, 'findingDraft');
    const clientKey = String(draft.clientFindingKey ?? '');
    const materialized = registry.materialize({
      clientFindingKey: clientKey,
      defectClass: draft.defectClass as FindingV2['defectClass'],
      severity: draft.severity as FindingV2['severity'],
      primaryLocation: {
        kind: ((draft.primaryLocation as Record<string, unknown> | null)?.kind ?? 'map') as FindingV2['primaryLocation']['kind'],
        id: String((draft.primaryLocation as Record<string, unknown> | null)?.id ?? ''),
      },
      relatedSlotIds: Array.isArray(draft.relatedSlotIds) ? (draft.relatedSlotIds as string[]) : [],
      relatedRelationIds: Array.isArray(draft.relatedRelationIds) ? (draft.relatedRelationIds as string[]) : [],
      suggestedRepairSlotIds: Array.isArray(draft.suggestedRepairSlotIds) ? (draft.suggestedRepairSlotIds as string[]) : [],
      evidence: Array.isArray(draft.evidence) ? (draft.evidence as string[]) : [],
    });
    wholeObservationRefs.push(materialized.ref);
    const anchored = body.anchoredVerdict;
    if (typeof anchored === 'object' && anchored !== null) {
      const av = anchored as Record<string, unknown>;
      const targetId = String(av.targetId ?? materialized.finding.primaryLocation.id);
      // M-a: the anchored fact's target kind is looked up by the ANCHORED
      // TARGET id in the round baseline (baselineTargetKindsOf) — anchoring on
      // a target different from the finding's primary is legal ONLY when that
      // target exists in the baseline; unknown → reject (never mis-typed).
      const targetKind = input.baselineTargetKinds[targetId];
      if (targetKind === undefined) {
        errors.push(`cannot type the anchored fact: target '${targetId}' is not in the round baseline`);
        continue;
      }
      const verdict = String(av.verdict ?? '');
      const legalVerdicts = verdictValuesForTargetKind(targetKind);
      if (!legalVerdicts.includes(verdict)) {
        errors.push(`anchored verdict '${verdict}' is illegal for target kind '${targetKind}' (expected ${legalVerdicts.join('|')})`);
        continue;
      }
      facts.push({
        factId: reviewFactId(input.attemptId, targetKind, targetId),
        targetKind,
        targetStableId: targetId,
        verdict,
        factOrigin: { kind: 'whole_observation', adoptionEligible: false },
        adoptionEligible: false,
        localSubjectDigest: String(av.subjectDigest ?? '') || journalSubjectDigest(av),
        localContextDigest: journalContextDigest(input.roundId, targetId),
        reviewPolicyDigest: input.reviewPolicyDigest,
        findingIds: [materialized.findingId],
        evidence: evidenceStringsToReviewEvidence(Array.isArray(av.evidence) ? (av.evidence as string[]) : []),
        reviewerAttemptId: input.reviewerAttemptId,
        recordedAt: String(body.recordedAt ?? '') || record.at,
      });
    }
  }

  // ---- Verification records — exactly one per frozen verificationFindingStage.
  const verificationByKey = new Map<string, ReviewDraftRecordV2>();
  for (const record of input.records) {
    if (record.op !== 'submit_finding_verification') continue;
    const key = `${String(record.body.findingId ?? '')}:${String(record.body.repairStage ?? '')}`;
    if (verificationByKey.has(key)) {
      errors.push(`duplicate verification for '${key}' (one record per stage)`);
    } else {
      verificationByKey.set(key, record);
    }
  }
  for (const stage of input.verificationFindingStages) {
    const record = verificationByKey.get(stage);
    if (record === undefined) {
      errors.push(`missing verification record for frozen target '${stage}'`);
    }
  }
  for (const [key, record] of verificationByKey) {
    const [findingId, repairStage] = key.split(':');
    verifications.push({
      recordId: verificationRecordId(input.attemptId, findingId, repairStage),
      reviewContext: { kind: input.roundKind, roundId: input.roundId },
      assignmentId: input.assignmentId,
      findingId,
      repairStage: repairStage as 'map' | 'content',
      verdict: (record.body.verdict ?? 'still_present') as 'resolved' | 'still_present',
      candidateId: input.roundKind === 'map' ? (record.body.candidateId as string | null) ?? null : null,
      mapId: input.roundKind === 'content' ? (record.body.mapId as string | null) ?? null : null,
      mapContextDigests: {},
      evidenceSlotDigests: {},
      reviewPolicyDigest: input.reviewPolicyDigest,
      evidence: evidenceStringsToReviewEvidence(Array.isArray(record.body.evidence) ? (record.body.evidence as string[]) : []),
      reviewerAttemptId: input.reviewerAttemptId,
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  // The frozen ledger parser requires the ref arrays in canonical order (sorted
  // by ref digest) and the coverage target ids sorted by string — the freeze
  // MUST produce parser-valid ledger bytes (the seam publishes them). The
  // ledgerDigest is the canonical hash of the body WITHOUT that field (hs).
  const sortRefs = (refs: readonly BlobRefV2[]): BlobRefV2[] =>
    [...refs].sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
  const factRefs = sortRefs(facts.map((fact) => refOfBlob('review_fact', fact)));
  const verificationRecordRefs = sortRefs(verifications.map((rec) => refOfBlob('finding_verification_record', rec)));
  const findingDraftRefs = sortRefs(registry.refsList);
  const without = {
    assignmentId: input.assignmentId,
    workItemId: input.workItemId,
    reviewAssignmentId: input.reviewAssignmentId,
    roundKind: input.roundKind,
    roundId: input.roundId,
    factRefs,
    findingDraftRefs,
    verificationRecordRefs,
    coverageTargetIds: input.requireOrdinaryCoverage ? [...verdictByTarget.keys()].sort() : sortRefs(wholeObservationRefs).map((r) => r.digest),
  };
  const ledger: AssignmentLedgerBlobV2 = { ...without, ledgerDigest: canonicalJsonSha256(without) };
  const freeze: FrozenReviewAssignmentV2 = {
    ledger,
    facts,
    verifications,
    findings: registry.findingsList,
    factRefs,
    verificationRecordRefs,
    findingDraftRefs,
    wholeObservationRefs,
    routingObligations: registry.routingObligations,
  };
  return { ok: true, freeze };
}

/* ------------------------------------------------------------------ */
/* The factory                                                         */
/* ------------------------------------------------------------------ */

export type V2ToolFactoryDependencies = {
  grants: GrantService;
  privateStore: AuthoritativeReviewPrivateStore;
  profile: AuthoritativeReviewProfile;
  readProjection(taskId: string): Promise<AuthoritativeReviewProjectionV2>;
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown> | unknown;
  /** Resolves the full attempt context from the Pi seam input (scheduler path). */
  contextResolver?(taskId: string, workItemId: string, attemptId: string, agentId: string): Promise<V2AttemptContext | null>;
  /** Domain writes (later tasks). Absent handlers fail closed. */
  handlers?: V2DomainHandlers;
  /**
   * FIX-1 (Task 14 seam): resolves the ASSIGNMENT-scoped ordinary target set of
   * the current review assignment (design §11.10 — `assignment*`, NOT the full
   * tree-Gate `coverage*`; the inherited difference is covered by
   * inheritedRecordRefs). Task 14 supplies it from the AssignmentDispatch /
   * assignment blob. Where the round carries assignment* per-target fields the
   * factory uses them; otherwise this seam is REQUIRED and the completion FAILS
   * CLOSED when it is absent — never a silent fallback to round coverage.
   */
  resolveAssignmentTargets?(ctx: V2AttemptContext): Promise<readonly string[] | null>;
  /** The atomic AssignmentLedgerBlob/event publication seam (later facade wiring). */
  freezeReviewAssignment?(taskId: string, freeze: FrozenReviewAssignmentV2): Promise<{ ledgerRef: BlobRefV2; eventId: string }>;
  /** Task 18: the review policy (needed to reconstruct the content round from
   * the planned coverage core the workitems bind as reviewRoundRef). */
  reviewPolicy?: ReviewPolicyParameters;
  log?(line: string): void;
};

type ToolResult = {
  content: { type: 'text'; text: string }[];
  details: { ok: boolean; code: string | null; data: unknown };
};

function okResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], details: { ok: true, code: null, data } };
}

function failResult(code: string, message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], details: { ok: false, code, data: { message } } };
}

/**
 * M-4/M-c: estimates the DOMINANT payload bytes of a domain write (the field
 * that becomes the canonical blob) and maps it to the profile blob kind it
 * gates. This is a HEURISTIC tool-layer bound, not the authoritative cap: for
 * `write_slot_content` the value length is a LOWER bound of the canonical
 * `content_value` blob (which also carries slotId/digests), so a value near the
 * cap may still be rejected at blob creation. The AUTHORITATIVE byte cap is
 * enforced at blob creation (the facade's prepareBlob / the domain service) —
 * Task 14/15 must call `assertPayloadWithinProfile` there.
 */
function estimatePayloadBytes(name: V2ToolName, params: Record<string, unknown>): { kind: AuthoritativeBlobKindV2 | null; bytes: number } {
  switch (name) {
    case 'write_slot_content':
      return { kind: 'content_value', bytes: String(params.value ?? '').length };
    case 'append_map_candidate_chunk':
      return { kind: 'map_build_chunk', bytes: canonicalJsonBytes({ nodes: params.nodes, relations: params.relations }).length };
    case 'submit_map_patch':
      return { kind: 'repair_staging_root', bytes: canonicalJsonBytes(params.operations ?? []).length };
    case 'submit_content_draft':
      return { kind: 'content_revision_commit_core', bytes: canonicalJsonBytes(params).length };
    case 'request_scope_expansion':
      return { kind: 'repair_plan_spec', bytes: canonicalJsonBytes(params).length };
    default:
      return { kind: null, bytes: 0 };
  }
}

/** The tool names the session kind exposes (verification conditional). */
export function toolsForSessionKind(sessionKind: string | null): readonly V2ToolName[] | null {
  switch (sessionKind) {
    case 'structure_chunk':
      return STRUCTURE_CHUNK_TOOLS;
    case 'map_repair':
      return MAP_REPAIR_TOOLS;
    case 'generation_batch':
      return GENERATION_BATCH_TOOLS;
    case 'content_repair':
      return CONTENT_REPAIR_TOOLS;
    case 'review_map_batch':
      return REVIEW_MAP_BATCH_TOOLS;
    case 'review_map_whole':
      return REVIEW_MAP_WHOLE_TOOLS;
    case 'review_content_batch':
      return REVIEW_CONTENT_BATCH_TOOLS;
    case 'review_content_whole':
      return REVIEW_CONTENT_WHOLE_TOOLS;
    default:
      return null;
  }
}

export class V2ToolFactory {
  private readonly deps: V2ToolFactoryDependencies;

  constructor(deps: V2ToolFactoryDependencies) {
    this.deps = deps;
  }

  /* ------------------------- V2ToolProvider seam ------------------- */

  /** The closed per-session tool set of one attempt (V2ToolProvider). */
  async toolsFor(ctx: V2AttemptContext): Promise<ToolDefinition[]> {
    if (ctx.sessionKind === null) {
      // Generic Submitter: no structured write tools (design §9 "Submitter 仍
      // 使用通用下游 turn，不属于结构槽写会话").
      return [];
    }
    const names = toolsForSessionKind(ctx.sessionKind);
    if (names === null) {
      throw new Error(`tool-factory: unknown v2 session kind '${String(ctx.sessionKind)}'`);
    }
    const grant = await this.deps.grants.resolveAttemptGrant(ctx);
    const hasVerification = ctx.sessionKind.startsWith('review_') && (await this.hasVerificationTargets(ctx, grant));
    const tools: ToolDefinition[] = [];
    for (const name of names) {
      if (name === 'submit_finding_verification' && !hasVerification) continue;
      tools.push(this.buildToolDefinition(ctx, name));
    }
    return tools;
  }

  /** Domain result refs the completion prepared (the frozen ledger, when the
   * review assignment completed; the committed chunk refs, when the session was
   * a structure_chunk build). The §9.2 completion gate requires gated sessions
   * to fold their domain result — a completed review assignment MUST carry its
   * AssignmentLedgerBlob ref and a completed structure_chunk MUST carry its
   * committed chunk refs, or the bare completion is rejected. */
  async collectResultRefs(ctx: V2AttemptContext): Promise<readonly BlobRefV2[]> {
    if (ctx.sessionKind?.startsWith('review_')) {
      try {
        const journal = await this.reviewJournal(ctx);
        const view = await this.deps.privateStore.readAllReviewDraft(journal);
        const complete = view.committed.find((e) => e.op === 'complete_review_assignment');
        if (complete === undefined) return [];
        const result = complete.result as { ledgerRef?: BlobRefV2 } | null;
        return result?.ledgerRef !== undefined && result?.ledgerRef !== null ? [result.ledgerRef] : [];
      } catch {
        return [];
      }
    }
    if (ctx.sessionKind === 'structure_chunk') {
      try {
        const journal = await this.reviewJournal(ctx);
        const view = await this.deps.privateStore.readAllReviewDraft(journal);
        const chunkRefs: BlobRefV2[] = [];
        for (const entry of view.committed) {
          if (entry.op !== 'append_map_candidate_chunk') continue;
          const result = entry.result as { chunkRef?: BlobRefV2 } | null;
          if (result?.chunkRef !== undefined && result?.chunkRef !== null) chunkRefs.push(result.chunkRef);
        }
        return chunkRefs;
      } catch {
        return [];
      }
    }
    if (ctx.sessionKind === 'generation_batch') {
      // Task 17: a completed generation batch folds its committed provisional
      // manifest ref (the submit_content_draft result) so the §9.2 completion
      // gate is never bare.
      try {
        const journal = await this.reviewJournal(ctx);
        const view = await this.deps.privateStore.readAllReviewDraft(journal);
        // The journal records EVERY submit_content_draft result, including a
        // blocked batch ({ committed: false }). The LAST entry carrying a
        // manifestRef is the committed batch — a blocked-then-re-written
        // session must still fold its committed provisional manifest.
        for (let i = view.committed.length - 1; i >= 0; i--) {
          const entry = view.committed[i];
          if (entry.op !== 'submit_content_draft') continue;
          const result = entry.result as { manifestRef?: BlobRefV2 } | null;
          if (result?.manifestRef !== undefined && result?.manifestRef !== null) return [result.manifestRef];
        }
        return [];
      } catch {
        return [];
      }
    }
    if (ctx.sessionKind === 'map_repair' || ctx.sessionKind === 'content_repair') {
      // Task 19: a committed repair batch folds its staging root ref (the
      // submit_map_patch / submit_content_draft result) so the §9.2
      // completion gate is never bare.
      try {
        const journal = await this.reviewJournal(ctx);
        const view = await this.deps.privateStore.readAllReviewDraft(journal);
        for (let i = view.committed.length - 1; i >= 0; i--) {
          const entry = view.committed[i];
          if (entry.op !== 'submit_map_patch' && entry.op !== 'submit_content_draft') continue;
          const result = entry.result as { stagingRootRef?: BlobRefV2 } | null;
          if (result?.stagingRootRef !== undefined && result?.stagingRootRef !== null) return [result.stagingRootRef];
        }
        return [];
      } catch {
        return [];
      }
    }
    return [];
  }

  /* ------------------------- PiV2ToolRuntime seam ------------------ */

  /**
   * The Pi seam: reconstructs the V2AttemptContext from the turn input
   * (taskId + workItemId + attemptId parsed from the isolated namespace) via
   * the injected `contextResolver`, then returns the closed tool set. Returns
   * null for basic/v3 turns (no v2Session) or an unresolvable attempt.
   */
  async createContext(input: AgentTurnInput): Promise<{ toolDefinitions: ToolDefinition[] } | null> {
    if (input.v2Session === null || input.v2Session === undefined) return null;
    if (this.deps.contextResolver === undefined) return null;
    const workItemId = input.inputNodeId;
    const attemptId = attemptIdFromNamespace(input.v2Namespace ?? '');
    if (attemptId === null) return null;
    const ctx = await this.deps.contextResolver(input.taskId, workItemId, attemptId, input.agent.id);
    if (ctx === null) return null;
    const toolDefinitions = await this.toolsFor(ctx);
    return { toolDefinitions };
  }

  /* ----------------------------- helpers --------------------------- */

  private async hasVerificationTargets(ctx: V2AttemptContext, grant: ResolvedAttemptGrant): Promise<boolean> {
    const ref = grant.baseSet.reviewRoundRef;
    if (ref === null) return false;
    const resolved = await this.deps.resolver(ctx.taskId, ref);
    if (resolved === null || typeof resolved !== 'object') return false;
    if ('verificationFindingStages' in resolved) {
      const stages = (resolved as { verificationFindingStages?: readonly string[] }).verificationFindingStages ?? [];
      return stages.length > 0;
    }
    // Content rounds: reconstruct the round from the planned coverage core.
    const round = await this.resolveContentRound(ctx, resolved);
    return round.verificationFindingStages.length > 0;
  }

  private buildToolDefinition(ctx: V2AttemptContext, name: V2ToolName): ToolDefinition {
    const schema = name === 'request_scope_expansion' ? scopeExpansionSchema(ctx.sessionKind ?? '') : TOOL_SCHEMAS[name];
    const execute = this.executorFor(ctx, name);
    return {
      name,
      label: name,
      description: toolDescription(name),
      parameters: schema,
      executionMode: 'sequential' as const,
      execute: async (toolCallId: string, params: Static<TSchema>): Promise<ToolResult> => {
        try {
          return await execute(toolCallId, params as Record<string, unknown>);
        } catch (error) {
          if (error instanceof GrantError) return failResult(error.code, error.message);
          if (error instanceof PrivateStoreError) return failResult(error.code, error.message);
          throw error;
        }
      },
    };
  }

  private executorFor(ctx: V2AttemptContext, name: V2ToolName): (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult> {
    switch (name) {
      case 'read_structure_contract':
      case 'read_map_build_frontier':
      case 'read_map_repair_staging':
      case 'read_active_map':
      case 'read_slot_content':
      case 'read_related_context':
      case 'read_map_candidate':
      case 'read_relation_context':
        return (toolCallId, params) => this.executeRead(ctx, name, params);
      case 'append_map_candidate_chunk':
      case 'finish_map_build':
      case 'submit_map_patch':
      case 'write_slot_content':
      case 'submit_content_draft':
      case 'request_scope_expansion':
        return (toolCallId, params) => this.executeDomainWrite(ctx, name, params);
      case 'submit_map_node_review':
      case 'submit_map_relation_review':
      case 'submit_slot_review':
      case 'submit_relation_review':
      case 'submit_map_whole_finding':
      case 'submit_whole_tree_finding':
      case 'submit_finding_verification':
        return (toolCallId, params) => this.executeReviewSubmission(ctx, name, params);
      case 'complete_review_assignment':
        return (toolCallId, params) => this.executeCompleteReviewAssignment(ctx, params);
    }
  }

  private async executeRead(ctx: V2AttemptContext, name: V2ToolName, params: Record<string, unknown>): Promise<ToolResult> {
    // Read tools reproject authority too: a stale lease cannot read private scope.
    const state = await this.deps.readProjection(ctx.taskId);
    this.deps.grants.assertAttemptCurrent(ctx, state);
    const limit = typeof params.limit === 'number' ? params.limit : 50;
    const bounded = Math.min(limit, this.deps.profile.assignmentMaxPrimaryTargets);
    const handler = this.deps.handlers?.read;
    if (handler === undefined) {
      return failResult('TOOL_NOT_WIRED', `read tool '${name}' is not wired to a projection service yet`);
    }
    const data = await handler(ctx, name, { ...params, limit: bounded });
    return okResult(data);
  }

  /**
   * Domain write (orchestrator/generator/repair): reproject, resolve the grant,
   * enforce §11 idempotency via the attempt journal, then delegate to the
   * handler. Absent handler → fail closed.
   */
  private async executeDomainWrite(ctx: V2AttemptContext, name: V2ToolName, params: Record<string, unknown>): Promise<ToolResult> {
    const state = await this.deps.readProjection(ctx.taskId);
    this.deps.grants.assertAttemptCurrent(ctx, state);
    const grant = await this.deps.grants.resolveAttemptGrant(ctx);
    const authority = grantWriteAuthority(grant.spec);
    if (authority === 'none') {
      return failResult('WRITE_OUT_OF_SCOPE', `grant authority 'none' grants no '${name}' write`);
    }
    // Per-family write scope gate before any side effect.
    if (name === 'write_slot_content') {
      const slotId = String(params.slotId ?? '');
      try {
        assertContentWriteAuthorized(grant.spec, slotId);
      } catch (error) {
        if (error instanceof GrantError) return failResult(error.code, error.message);
        throw error;
      }
    }
    // M-4: profile-based payload bound at the tool layer (a tighter
    // profile.maxBytesByKind cap is enforced here, not only by fixed schemas).
    const payload = estimatePayloadBytes(name, params);
    if (payload.kind !== null) {
      try {
        assertPayloadWithinProfile(this.deps.profile, payload.kind, payload.bytes);
      } catch (error) {
        if (error instanceof GrantError) return failResult(error.code, error.message);
        throw error;
      }
    }
    // §11 idempotency: same clientOperationId + same canonical body replays.
    const clientOperationId = String(params.clientOperationId ?? '');
    if (clientOperationId === '') return failResult('INVALID_INPUT', `mutating tool '${name}' requires clientOperationId`);
    const journal = await this.reviewJournal(ctx);
    const committedOps = (await this.deps.privateStore.readAllReviewDraft(journal)).committed.map((e) => ({
      clientOperationId: e.clientOperationId,
      bodyDigest: e.bodyDigest,
      result: e.result,
    }));
    const replay = classifyToolReplay(clientOperationId, params, committedOps);
    if (replay.status === 'replay') return okResult(replay.committed.result);
    if (replay.status === 'conflict') return failResult('OPERATION_CONFLICT', `clientOperationId '${clientOperationId}' committed a different body`);

    const handler = this.domainHandler(name);
    if (handler === undefined) {
      return failResult('TOOL_NOT_WIRED', `write tool '${name}' is not wired to a domain service yet`);
    }
    const result = await handler(ctx, params);
    await this.deps.privateStore.appendReviewDraft(journal, {
      clientOperationId,
      op: name,
      body: params as Record<string, unknown>,
      result,
    });
    return okResult(result);
  }

  private domainHandler(name: V2ToolName): ((ctx: V2AttemptContext, params: Record<string, unknown>) => Promise<unknown>) | undefined {
    const h = this.deps.handlers;
    if (h === undefined) return undefined;
    switch (name) {
      case 'append_map_candidate_chunk':
        return h.appendMapCandidateChunk;
      case 'finish_map_build':
        return h.finishMapBuild;
      case 'submit_map_patch':
        return h.submitMapPatch;
      case 'write_slot_content':
        return h.writeSlotContent;
      case 'submit_content_draft':
        return h.submitContentDraft;
      case 'request_scope_expansion':
        return h.requestScopeExpansion;
      default:
        return undefined;
    }
  }

  /**
   * Review submission (verdict + whole finding + verification): reproject,
   * validate the closure and (for verification) the frozen verification rules,
   * then write ONLY the current attempt's private review journal. The journal
   * is the source of truth for `complete_review_assignment` — no partial
   * publication ever happens here.
   */
  private async executeReviewSubmission(ctx: V2AttemptContext, name: V2ToolName, params: Record<string, unknown>): Promise<ToolResult> {
    const state = await this.deps.readProjection(ctx.taskId);
    this.deps.grants.assertAttemptCurrent(ctx, state);
    await this.deps.grants.resolveAttemptGrant(ctx); // reviewer spec resolves (no instance needed)
    const clientOperationId = String(params.clientOperationId ?? '');
    if (clientOperationId === '') return failResult('INVALID_INPUT', `mutating tool '${name}' requires clientOperationId`);
    // Evidence byte budget (profile evidenceMaxBytesPerItem/Total): bounded
    // public evidence only — oversized submissions reject before any journal.
    const evidence = Array.isArray(params.evidence) ? (params.evidence as string[]) : [];
    let evidenceBytes = 0;
    for (const item of evidence) {
      evidenceBytes += item.length;
      if (item.length > this.deps.profile.evidenceMaxBytesPerItem) {
        return failResult('PAYLOAD_LIMIT_EXCEEDED', `an evidence item exceeds the profile cap of ${this.deps.profile.evidenceMaxBytesPerItem} bytes`);
      }
    }
    if (evidenceBytes > this.deps.profile.evidenceMaxBytesTotal) {
      return failResult('PAYLOAD_LIMIT_EXCEEDED', `evidence of ${evidenceBytes} bytes exceeds the profile cap of ${this.deps.profile.evidenceMaxBytesTotal}`);
    }
    const journal = await this.reviewJournal(ctx);
    const committedOps = (await this.deps.privateStore.readAllReviewDraft(journal)).committed.map((e) => ({
      clientOperationId: e.clientOperationId,
      bodyDigest: e.bodyDigest,
      result: e.result,
    }));
    const replay = classifyToolReplay(clientOperationId, params, committedOps);
    if (replay.status === 'replay') return okResult(replay.committed.result);
    if (replay.status === 'conflict') return failResult('OPERATION_CONFLICT', `clientOperationId '${clientOperationId}' committed a different body`);

    if (name === 'submit_finding_verification') {
      // Stale/non-addressed/system-validator/wrong-stage/wrong-baseline/
      // duplicate verification rejects BEFORE any journal append.
      const grant = await this.deps.grants.resolveAttemptGrant(ctx);
      const round = await this.resolveRound(ctx, grant);
      const findings = state.findings;
      const errors = validateVerificationSubmission({
        submission: {
          findingId: String(params.findingId ?? ''),
          repairStage: params.repairStage as 'map' | 'content',
          verdict: params.verdict as 'resolved' | 'still_present',
          evidence: Array.isArray(params.evidence) ? (params.evidence as string[]) : [],
        },
        round,
        findings,
      });
      if (errors.length > 0) {
        return failResult('VERIFICATION_REJECTED', errors.join('; '));
      }
    }

    const result = { accepted: true, op: name, targetId: params.targetId ?? null };
    await this.deps.privateStore.appendReviewDraft(journal, {
      clientOperationId,
      op: name,
      body: params as Record<string, unknown>,
      result,
    });
    return okResult(result);
  }

  /**
   * `complete_review_assignment({ clientOperationId })`: reads the attempt
   * journal, verifies one record for every frozen verificationFindingStage PLUS
   * EXACTLY the ASSIGNMENT-scoped ordinary target set (batch sessions),
   * FREEZES ReviewFacts + finding drafts + FindingVerificationRecords into one
   * AssignmentLedgerBlob, and publishes atomically through the injected seam.
   *
   * CRASH-WINDOW SAFETY (I-4): the journal record (with the deterministic
   * ledger ref + event id) and the complete marker are persisted BEFORE the
   * seam, so a response-loss retry hits the replay branch — which re-applies
   * the complete marker, re-invokes the idempotent seam and returns the
   * committed result. A second publication is impossible: the refs are
   * content/op-derived and identical across retries.
   */
  private async executeCompleteReviewAssignment(ctx: V2AttemptContext, params: Record<string, unknown>): Promise<ToolResult> {
    const state = await this.deps.readProjection(ctx.taskId);
    this.deps.grants.assertAttemptCurrent(ctx, state);
    const grant = await this.deps.grants.resolveAttemptGrant(ctx);
    const clientOperationId = String(params.clientOperationId ?? '');
    if (clientOperationId === '') return failResult('INVALID_INPUT', `mutating tool '${nameOfComplete}' requires clientOperationId`);
    const journal = await this.reviewJournal(ctx);
    const view = await this.deps.privateStore.readAllReviewDraft(journal);
    const committedOps = view.committed.map((e) => ({
      clientOperationId: e.clientOperationId,
      bodyDigest: e.bodyDigest,
      result: e.result,
    }));
    const replay = classifyToolReplay(clientOperationId, { op: 'complete_review_assignment' }, committedOps);
    if (replay.status === 'conflict') return failResult('OPERATION_CONFLICT', `clientOperationId '${clientOperationId}' committed a different body`);

    const round = await this.resolveRound(ctx, grant);
    const roundKind = roundKindOf(round);
    const isWhole = isWholeSessionKind(ctx.sessionKind ?? '');
    // FIX-1 (round 3 PRECEDENCE FLIP): the assignment-scoped ordinary target
    // set (design §11.10). Whole sessions carry no ordinary verdicts; batch
    // sessions resolve the set from the per-assignment `resolveAssignmentTargets`
    // seam FIRST (Task 14 supplies it from the AssignmentDispatch/assignment
    // blob) — a round-level `assignment*` fallback is used ONLY for provably
    // single-assignment rounds (assignmentIds.length <= 1); otherwise FAIL
    // CLOSED ASSIGNMENT_TARGETS_UNRESOLVED. Never the full round coverage.
    let assignmentTargets: readonly string[];
    if (isWhole) {
      assignmentTargets = [];
    } else {
      const seamTargets = this.deps.resolveAssignmentTargets === undefined
        ? null
        : await this.deps.resolveAssignmentTargets(ctx);
      if (seamTargets !== null) {
        assignmentTargets = seamTargets;
      } else {
        const roundTargets = assignmentTargetsOf(round);
        const singleAssignmentRound = round.assignmentIds.length <= 1;
        if (roundTargets !== null && singleAssignmentRound) {
          assignmentTargets = roundTargets;
        } else {
          return failResult('ASSIGNMENT_TARGETS_UNRESOLVED', 'the assignment target set is not yet resolvable; Task 14 must supply it from the AssignmentDispatch/assignment blob (per-assignment seam first; round-level assignment* only for provably single-assignment rounds)');
        }
      }
    }
    const build = buildReviewAssignmentFreeze({
      assignmentId: ctx.workItemId,
      workItemId: ctx.workItemId,
      reviewAssignmentId: reviewAssignmentIdOf(ctx, grant.spec as { reviewAssignmentId?: string | null }),
      roundKind,
      roundId: roundIdOf(round),
      attemptId: ctx.attemptId,
      reviewerAttemptId: ctx.attemptId,
      reviewPolicyDigest: (round as { reviewPolicyDigest?: string }).reviewPolicyDigest ?? '',
      records: view.committed.map((e) => ({ op: e.op, body: e.body, at: e.at })),
      verificationFindingStages: round.verificationFindingStages,
      assignmentTargets,
      baselineTargetKinds: baselineTargetKindsOf(round),
      requireOrdinaryCoverage: !isWhole,
    });
    if (!build.ok) {
      return failResult('REVIEW_ASSIGNMENT_INCOMPLETE', build.errors.join('; '));
    }

    // Deterministic result (I-4): the ledger ref is the content address of the
    // frozen ledger; the event id is op-derived — identical on every retry.
    const ledgerRef = refOfBlob('review_assignment_ledger', build.freeze.ledger);
    const result = { published: true, ledgerRef, eventId: deterministicEventId(clientOperationId, 'review_assignment_commit', 0) };

    if (replay.status === 'replay') {
      // A prior attempt committed the journal record (crash window before the
      // seam). Re-apply the complete marker (FIX-M3b: a crash between the
      // append and the marker left complete:false), re-invoke the idempotent
      // seam so the ledger IS durably published, then return the committed
      // result — never a second publication.
      await this.deps.privateStore.markReviewDraftComplete(journal, true);
      if (this.deps.freezeReviewAssignment !== undefined) {
        await this.deps.freezeReviewAssignment(ctx.taskId, build.freeze);
      }
      return okResult(replay.committed.result);
    }

    if (this.deps.freezeReviewAssignment === undefined) {
      return failResult('TOOL_NOT_WIRED', 'complete_review_assignment has no ledger publication seam wired');
    }
    // NEW path: journal + complete marker BEFORE the seam (I-4). A crash after
    // this point is covered by the replay branch above.
    await this.deps.privateStore.appendReviewDraft(journal, {
      clientOperationId,
      op: 'complete_review_assignment',
      body: { op: 'complete_review_assignment' },
      result,
    });
    await this.deps.privateStore.markReviewDraftComplete(journal, true);
    await this.deps.freezeReviewAssignment(ctx.taskId, build.freeze);
    return okResult(result);
  }

  private async reviewJournal(ctx: V2AttemptContext): Promise<ReviewDraftBindingV2> {
    const grant = await this.deps.grants.resolveAttemptGrant(ctx);
    return {
      workItemId: ctx.workItemId,
      leaseEpoch: ctx.leaseEpoch,
      attemptId: ctx.attemptId,
      authorityBaseRef: grant.authorityBaseRef,
      grantSpecRef: grant.specRef,
    };
  }

  private async resolveRound(ctx: V2AttemptContext, grant: ResolvedAttemptGrant): Promise<MapReviewRoundV2 | ReviewRoundV2> {
    const ref = grant.baseSet.reviewRoundRef;
    if (ref === null) {
      throw new GrantError('GRANT_STALE', `workitem '${ctx.workItemId}' has no current review round in its authority base`);
    }
    const resolved = await this.deps.resolver(ctx.taskId, ref);
    if (resolved === null || typeof resolved !== 'object' || !('reviewRoundId' in resolved || 'mapReviewRoundId' in resolved)) {
      throw new GrantError('GRANT_STALE', `review round blob '${ref.digest.slice(0, 12)}…' is unresolvable`);
    }
    if ('verificationFindingStages' in resolved) {
      return resolved as MapReviewRoundV2 | ReviewRoundV2;
    }
    // Content rounds: the workitems bind reviewRoundRef = the PLANNED coverage
    // core; reconstruct the round from it (no content_review_round blob kind).
    return this.resolveContentRound(ctx, resolved);
  }

  /** Reconstructs the content `ReviewRoundV2` from the planned coverage core. */
  private async resolveContentRound(ctx: V2AttemptContext, resolved: unknown): Promise<ReviewRoundV2> {
    const core = resolved as ContentReviewCoverageCoreV2;
    if (core === null || typeof core !== 'object' || typeof core.reviewRoundId !== 'string' || typeof core.coreDigest !== 'string') {
      throw new GrantError('GRANT_STALE', `review round blob '${ctx.workItemId}' is not a resolvable content review coverage core`);
    }
    return resolveContentRoundFromCore(ctx.taskId, core, {
      resolver: this.deps.resolver,
      readProjection: this.deps.readProjection,
      reviewPolicy: this.deps.reviewPolicy ?? {
        mapReview: 'required',
        contentSelector: 'content_bearing',
        mapBatchTargetSlots: 24,
        contentBatchTargetSlots: 24,
        assignmentSoftLimit: 64,
        wholeMapObservation: 'required',
        wholeContentTreeObservation: 'required',
        reviewAdvisoryRelations: false,
        maxRounds: 8,
      },
    });
  }
}

const nameOfComplete = 'complete_review_assignment';

/** Attempt id parsed from the isolated namespace (last `/` segment). */
export function attemptIdFromNamespace(namespace: string): string | null {
  const idx = namespace.lastIndexOf('/');
  if (idx < 0) return null;
  const attemptId = namespace.slice(idx + 1);
  return attemptId.length > 0 ? attemptId : null;
}

/** The review assignment id of the closure (spec carries it; ctx fallback). */
export function reviewAssignmentIdOf(
  ctx: V2AttemptContext,
  spec: { reviewAssignmentId?: string | null },
): string | null {
  return spec.reviewAssignmentId ?? (ctx as { reviewAssignmentId?: string | null }).reviewAssignmentId ?? null;
}

function toolDescription(name: V2ToolName): string {
  switch (name) {
    case 'read_structure_contract':
      return '读取冻结的结构契约。';
    case 'read_map_build_frontier':
      return '分页读取当前 MapBuild 前沿与已提交 key。';
    case 'read_map_repair_staging':
      return '分页读取当前 repair batch 的私有 staging。';
    case 'read_active_map':
      return '分页读取活动 Map。';
    case 'read_slot_content':
      return '读取指定槽位的已提交内容。';
    case 'read_related_context':
      return '读取指定槽位的关系上下文。';
    case 'read_map_candidate':
      return '分页读取待审的 Map 候选。';
    case 'read_relation_context':
      return '读取指定关系的上下文。';
    case 'append_map_candidate_chunk':
      return '追加一个 MapBuild 分块。';
    case 'finish_map_build':
      return '提交 MapBuild finish 提议。';
    case 'submit_map_patch':
      return '向私有 staging 提交 Map repair patch。';
    case 'request_scope_expansion':
      return '请求 scope expansion（生成 successor 计划）。';
    case 'write_slot_content':
      return '写入当前 grant 授权槽位的内容。';
    case 'submit_content_draft':
      return '提交内容批次 draft。';
    case 'submit_map_node_review':
      return '提交 Map 节点 verdict（含 findingDrafts）。';
    case 'submit_map_relation_review':
      return '提交 Map 关系 verdict（含 findingDrafts）。';
    case 'submit_slot_review':
      return '提交内容槽位 verdict（含 findingDrafts）。';
    case 'submit_relation_review':
      return '提交关系满足性 verdict（含 findingDrafts）。';
    case 'submit_map_whole_finding':
      return '整图观察：提交 anchored Finding。';
    case 'submit_whole_tree_finding':
      return '整树观察：提交 anchored Finding。';
    case 'submit_finding_verification':
      return '提交 finding stage 验证（resolved|still_present）。';
    case 'complete_review_assignment':
      return '完成当前审核 assignment 并冻结 ledger。';
  }
}
