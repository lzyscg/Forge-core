/**
 * Authoritative review v2 profile (Task 5, spec §4.3/§16.1, design §22.2).
 *
 * The immutable `AuthoritativeReviewProfileSnapshotV1` is the canonical
 * profile object whose complete validated body carries: identity/version,
 * qualification state, ABI identities, the `runtime` limit group (satisfying
 * the pure-domain `AuthoritativeReviewProfile` interface), the `template`
 * ceilings over every one of the 42 Contract v2 limit fields, the exact
 * installed validator/assembler registry identities, validator budget-profile
 * definitions and the assembler budget ceiling.
 *
 * Identity rules (§4.3/§7.1): `profileDigest = sha256(canonical bytes WITHOUT
 * the field)`; `profileSnapshotRef.digest = sha256(exact complete object
 * bytes)`. The two digests are distinct identities and are never equated. The
 * profile body is validated here with the exact registered parser
 * (object-schema-parsers-3), plus the semantic consistency rules and the
 * first-release capacity floor (maxSlots >= 10,000 while v1 stays at 2,500;
 * 256 primary targets; 1,024 total objects per assignment; one active lease).
 *
 * Templates can only tighten: `assertTemplateLimitsWithinProfile` rejects any
 * of the 42 contract fields above the profile ceiling and any review-policy
 * value above its profile bound.
 */
import { readFileSync } from 'node:fs';
import { canonicalJsonBytes, canonicalJsonSha256 } from './canonical-json';
import { parseProfileSnapshotObject, refOfBlob } from '../authoritative-review/object-registry';
import type { AuthoritativeReviewProfile, BlobKindByteLimits } from '../authoritative-review/authority-types';
import type { ValidatorTriggerV2 } from '../authoritative-review/authority-types';
import {
  PROFILE_ASSEMBLER_BUDGET_FIELDS,
  PROFILE_BUDGET_PROFILE_FIELDS,
  PROFILE_RUNTIME_FIELDS,
  PROFILE_TEMPLATE_GROUPS,
  AUTHORITATIVE_REVIEW_PROFILE_SNAPSHOT_MAX_BYTES,
} from '../authoritative-review/object-schema-parsers-3-constants';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';

/** The closed profile family identity (spec §5.2). */
export const AUTHORITATIVE_REVIEW_PROFILE_IDENTITY = 'forge-authoritative-review/v1' as const;

/** Validation failure code shared by every profile module reject path. */
export const AUTHORITATIVE_REVIEW_PROFILE_INVALID = 'AUTHORITATIVE_REVIEW_PROFILE_INVALID';

/** First-release capacity floor (spec §16.1 / design §22.2). */
export const V2_PROFILE_MAX_SLOTS_FLOOR = 10_000;
export const V2_PROFILE_ASSIGNMENT_PRIMARY_TARGETS_FLOOR = 256;
export const V2_PROFILE_ASSIGNMENT_TOTAL_OBJECTS_FLOOR = 1_024;

function invalid(reason: string): never {
  throw new Error(`${AUTHORITATIVE_REVIEW_PROFILE_INVALID}: ${reason}`);
}

export type ValidatorExecutionPhaseV2 = 'batch_commit' | 'plan_finalize' | null;

/** One installed validator identity (spec §6.5 / design §9). */
export interface InstalledValidatorHandlerIdentityV1 {
  handlerKey: string;
  implementationDigest: string;
  moduleId: string;
  exportName: string;
  trigger: ValidatorTriggerV2;
  executionPhase: ValidatorExecutionPhaseV2;
}

/** The installed assembler identity (spec §13.5). */
export interface InstalledAssemblerHandlerIdentityV1 {
  handlerKey: string;
  implementationDigest: string;
  moduleId: string;
  exportName: string;
}

/** Exact installed validator/assembler registry identities frozen in the body. */
export interface InstalledHandlerIdentitiesV1 {
  validators: readonly InstalledValidatorHandlerIdentityV1[];
  assembler: InstalledAssemblerHandlerIdentityV1;
}

/** One validator budget profile (design §9: frozen bytes/targets/duration/output/issues/memory). */
export interface ValidatorBudgetProfileV1 {
  maxInputBytes: number;
  maxSelectedTargets: number;
  maxDurationMs: number;
  maxOutputBytes: number;
  maxIssues: number;
  maxMemoryMiB: number;
}

/** Assembler budget ceiling (spec §13.5 frozen identity fields). */
export interface AssemblerBudgetCeilingV1 {
  maxTimeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
}

/** Per-kind blob byte caps: exact `BlobKindByteLimits` from the pure domain. */
export type AuthoritativeReviewMaxBytesByKindV1 = BlobKindByteLimits;

/**
 * The `runtime` group — the concrete production limits that satisfy the
 * pure-domain `AuthoritativeReviewProfile` interface (structural identity).
 */
export interface AuthoritativeReviewProfileLimitsV1 {
  maxBytesByKind: AuthoritativeReviewMaxBytesByKindV1;
  maxSlots: number;
  maxRelationTotal: number;
  maxRelationsPerSlot: number;
  maxRelationHops: number;
  maxClosureNodes: number;
  assignmentMaxPrimaryTargets: number;
  assignmentMaxTotalObjects: number;
  maxFindingsPerPrimaryTarget: number;
  maxFindingsPerRound: number;
  evidenceMaxBytesPerItem: number;
  evidenceMaxBytesTotal: number;
  maxRepairGrantWriteSlots: number;
  maxScopeExpansionsPerRound: number;
  maxRoundsPerTrack: number;
  maxPlannedWorkItemsPerRound: number;
  maxConsecutiveAttemptsWithoutProgress: number;
  maxActiveLeasesPerTask: number;
  mapChunkMaxNodes: number;
  mapChunkMaxRelations: number;
}

/** Compile-time structural check: the runtime group satisfies the pure-domain profile. */
type _SatisfiesPureDomainProfile = AuthoritativeReviewProfileLimitsV1 extends AuthoritativeReviewProfile
  ? true
  : never;
const _satisfiesPureDomainShape: _SatisfiesPureDomainProfile = true;

/** The `template` group — ceilings over all 42 Contract v2 limit fields. */
export interface TemplateLimitCeilingsV1 {
  schema: { maxSchemaDepth: number; maxSchemaNodes: number; maxEnumItems: number; maxPatternLength: number };
  structure: { maxSlots: number; maxTreeDepth: number; maxChildrenPerSlot: number };
  payload: { maxSpecBytesPerSlot: number; maxContentBytesPerSlot: number; maxScaffoldPayloadBytes: number };
  draft: { maxChangedSlots: number; maxDraftBytes: number };
  attempt: {
    maxSlotToolCallsPerAttempt: number;
    maxValidationRunsPerAttempt: number;
    maxValidatorInvocationsPerAttempt: number;
    maxAggregateValidatorCpuMsPerAttempt: number;
    maxAggregateValidatorWallClockMsPerAttempt: number;
    maxValidatorOutputBytesPerAttempt: number;
    maxAttemptWallClockMs: number;
  };
  validation: {
    maxValidators: number;
    maxValidatorInvocationsPerGate: number;
    maxAggregateValidatorCpuMsPerGate: number;
    maxAggregateValidatorWallClockMsPerGate: number;
    maxValidatorOutputBytesPerGate: number;
    maxIssuesPerRun: number;
  };
  output: { maxArtifactFiles: number; maxArtifactBytesPerFile: number; maxTotalArtifactBytes: number };
  relations: {
    maxRelationsPerMap: number;
    maxRelationsPerSlot: number;
    maxRelationImpactHops: number;
    maxRelationClosureNodes: number;
  };
  authoritative: {
    maxAssignmentsPerRound: number;
    maxPlannedWorkItemsPerRound: number;
    maxConsecutiveAttemptsWithoutProgress: number;
    maxFindingsPerSlot: number;
    maxFindingsPerRelation: number;
    maxFindingsPerRound: number;
    maxEvidenceBytesPerItem: number;
    maxEvidenceBytesTotal: number;
    maxWriteSlotsPerRepairGrant: number;
    maxScopeExpansionsPerRound: number;
  };
}

export type ProfileQualificationStateV1 = 'test_only' | 'provisional' | 'final';

/**
 * The canonical immutable profile snapshot object (spec §4.3). `profileDigest`
 * is the SHA-256 of the canonical bytes with that field omitted; the snapshot
 * BlobRef digest covers the COMPLETE object bytes — never equated.
 */
export interface AuthoritativeReviewProfileSnapshotV1Body {
  schemaVersion: 1;
  profileIdentity: string;
  profileVersion: number;
  qualificationState: ProfileQualificationStateV1;
  profileDigest: string;
  abi: {
    validatorAbi: 'forge-validator/v2';
    assemblerAbi: 'forge-assembler/v2';
    profileAbi: 'forge-authoritative-review/v1';
  };
  runtime: AuthoritativeReviewProfileLimitsV1;
  template: TemplateLimitCeilingsV1;
  installedHandlers: InstalledHandlerIdentitiesV1;
  budgetProfiles: Record<string, ValidatorBudgetProfileV1>;
  assemblerBudget: AssemblerBudgetCeilingV1;
}

/**
 * The FrozenTemplate binding (spec §4.3): the exact profile identity, the
 * resolved object-field digest and the byte-exact snapshot BlobRef. TaskStore
 * copies the profile bytes into the frozen snapshot at task creation (Task 11);
 * the loader hash binds all three values here.
 */
export interface AuthoritativeReviewProfileBindingV1 {
  profileIdentity: string;
  profileDigest: string;
  profileSnapshotRef: BlobRefV2;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Deep-freezes the normalized body (mirroring the object-registry convention). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    if (!Array.isArray(value)) {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        deepFreeze((value as Record<string, unknown>)[key]);
      }
    } else {
      for (const entry of value) deepFreeze(entry);
    }
  }
  return value;
}

function readGroup<G>(body: Record<string, unknown>, group: string): G {
  const value = body[group];
  if (!isPlainObject(value)) invalid(`profile body group '${group}' must be a plain object`);
  return value as unknown as G;
}

/**
 * Strict full-body validation: runs the registered envelope parser (which
 * verifies the exact shape of every group and the digest rule) and then the
 * semantic cross-group rules. Returns the deep-frozen normalized body.
 */
export function validateAuthoritativeReviewProfile(value: unknown): AuthoritativeReviewProfileSnapshotV1Body {
  const parsed = parseProfileSnapshotObject(value);
  const body = value as Record<string, unknown>;
  const runtime = readGroup<Record<string, number>>(body, 'runtime');
  const template = readGroup<Record<string, Record<string, number>>>(body, 'template');

  // First-release capacity floor (spec §16.1): every profile is a future
  // qualification candidate, so the floor holds for test/provisional too.
  if (runtime.maxSlots < V2_PROFILE_MAX_SLOTS_FLOOR) {
    invalid(`runtime.maxSlots must be >= ${V2_PROFILE_MAX_SLOTS_FLOOR}`);
  }
  if (runtime.assignmentMaxPrimaryTargets < V2_PROFILE_ASSIGNMENT_PRIMARY_TARGETS_FLOOR) {
    invalid(`runtime.assignmentMaxPrimaryTargets must be >= ${V2_PROFILE_ASSIGNMENT_PRIMARY_TARGETS_FLOOR}`);
  }
  if (runtime.assignmentMaxTotalObjects < V2_PROFILE_ASSIGNMENT_TOTAL_OBJECTS_FLOOR) {
    invalid(`runtime.assignmentMaxTotalObjects must be >= ${V2_PROFILE_ASSIGNMENT_TOTAL_OBJECTS_FLOOR}`);
  }
  if (runtime.maxActiveLeasesPerTask !== 1) {
    invalid('runtime.maxActiveLeasesPerTask is frozen at 1 for the first release');
  }
  if (runtime.assignmentMaxTotalObjects < runtime.assignmentMaxPrimaryTargets) {
    invalid('runtime.assignmentMaxTotalObjects must cover assignmentMaxPrimaryTargets');
  }
  if (runtime.maxRelationTotal < runtime.maxRelationsPerSlot) {
    invalid('runtime.maxRelationTotal must cover maxRelationsPerSlot');
  }
  if (runtime.evidenceMaxBytesTotal < runtime.evidenceMaxBytesPerItem) {
    invalid('runtime.evidenceMaxBytesTotal must cover evidenceMaxBytesPerItem');
  }
  if (runtime.maxPlannedWorkItemsPerRound < runtime.assignmentMaxTotalObjects) {
    invalid('runtime.maxPlannedWorkItemsPerRound must cover assignmentMaxTotalObjects');
  }
  if (runtime.mapChunkMaxRelations > runtime.maxRelationTotal) {
    invalid('runtime.mapChunkMaxRelations must not exceed maxRelationTotal');
  }

  // Template ceilings are platform ceilings: internally consistent with the
  // runtime group wherever the two groups share a concept (design §22.2).
  const templateGroups = template as Record<string, Record<string, number>>;
  assertCeiling(templateGroups['structure'], 'maxSlots', runtime.maxSlots, 'template.structure.maxSlots');
  for (const [field, runtimeValue] of [
    ['maxRelationsPerMap', runtime.maxRelationTotal],
    ['maxRelationsPerSlot', runtime.maxRelationsPerSlot],
    ['maxRelationImpactHops', runtime.maxRelationHops],
    ['maxRelationClosureNodes', runtime.maxClosureNodes],
  ] as const) {
    assertCeiling(templateGroups['relations'], field, runtimeValue, `template.relations.${field}`);
  }
  for (const [field, runtimeValue] of [
    ['maxPlannedWorkItemsPerRound', runtime.maxPlannedWorkItemsPerRound],
    ['maxConsecutiveAttemptsWithoutProgress', runtime.maxConsecutiveAttemptsWithoutProgress],
    ['maxFindingsPerRound', runtime.maxFindingsPerRound],
    ['maxEvidenceBytesPerItem', runtime.evidenceMaxBytesPerItem],
    ['maxEvidenceBytesTotal', runtime.evidenceMaxBytesTotal],
    ['maxWriteSlotsPerRepairGrant', runtime.maxRepairGrantWriteSlots],
    ['maxScopeExpansionsPerRound', runtime.maxScopeExpansionsPerRound],
  ] as const) {
    assertCeiling(templateGroups['authoritative'], field, runtimeValue, `template.authoritative.${field}`);
  }
  // One round must be able to cut the whole tree at the default batch target
  // (design §22.2: 单轮最大 assignments 必须至少支持把全部 maxSlots 切完).
  const defaultBatchTarget = 24;
  const neededAssignments = Math.ceil(runtime.maxSlots / defaultBatchTarget);
  if (templateGroups['authoritative']['maxAssignmentsPerRound'] < neededAssignments) {
    invalid(`template.authoritative.maxAssignmentsPerRound must support cutting maxSlots at batch target ${defaultBatchTarget}`);
  }
  if (templateGroups['authoritative']['maxPlannedWorkItemsPerRound'] < templateGroups['authoritative']['maxAssignmentsPerRound']) {
    invalid('template.authoritative.maxPlannedWorkItemsPerRound must cover maxAssignmentsPerRound');
  }

  const installedHandlers = readGroup<{
    validators: unknown[];
    assembler: Record<string, unknown>;
  }>(body, 'installedHandlers');
  if (!Array.isArray(installedHandlers.validators) || installedHandlers.validators.length < 1) {
    invalid('installedHandlers.validators must declare at least one installed validator');
  }
  const assembler = installedHandlers.assembler;
  if (!isPlainObject(assembler) || typeof assembler.handlerKey !== 'string' || assembler.handlerKey.length === 0) {
    invalid('installedHandlers.assembler must declare one installed assembler');
  }

  return deepFreeze({
    schemaVersion: 1,
    profileIdentity: parsed.profileIdentity,
    profileVersion: parsed.profileVersion,
    qualificationState: parsed.qualificationState,
    profileDigest: parsed.profileDigest,
    abi: parsed.abi,
    runtime: runtime as unknown as AuthoritativeReviewProfileLimitsV1,
    template: template as unknown as TemplateLimitCeilingsV1,
    installedHandlers: installedHandlers as unknown as InstalledHandlerIdentitiesV1,
    budgetProfiles: readGroup(body, 'budgetProfiles') as Record<string, ValidatorBudgetProfileV1>,
    assemblerBudget: readGroup(body, 'assemblerBudget') as AssemblerBudgetCeilingV1,
  });
}

function assertCeiling(
  group: Record<string, number>,
  field: string,
  ceiling: number,
  where: string,
): void {
  const value = group[field];
  if (typeof value !== 'number' || value > ceiling) {
    invalid(`${where} must not exceed the runtime ceiling ${ceiling}`);
  }
}

/**
 * `profileDigest = sha256(canonical bytes with the profileDigest field
 * omitted)` (spec §4.3). Recomputes over the parsed body — never trusts the
 * declared field.
 */
export function profileCanonicalDigest(body: AuthoritativeReviewProfileSnapshotV1Body): string {
  const copy = { ...body } as Record<string, unknown>;
  delete copy.profileDigest;
  return canonicalJsonSha256(copy);
}

/** Canonical bytes of the complete profile object. */
export function profileCanonicalBytes(body: AuthoritativeReviewProfileSnapshotV1Body): Buffer {
  return canonicalJsonBytes(body);
}

/**
 * The snapshot BlobRef: digest over the COMPLETE canonical object bytes
 * (spec §7.1), byte-exact `byteLength`. Distinct from `profileCanonicalDigest`.
 */
export function profileSnapshotRefOf(body: AuthoritativeReviewProfileSnapshotV1Body): BlobRefV2 {
  const bytes = profileCanonicalBytes(body);
  if (bytes.length > AUTHORITATIVE_REVIEW_PROFILE_SNAPSHOT_MAX_BYTES) {
    invalid(`profile_snapshot body exceeds the bootstrap maximum of ${AUTHORITATIVE_REVIEW_PROFILE_SNAPSHOT_MAX_BYTES} bytes`);
  }
  return refOfBlob('profile_snapshot', body);
}

/**
 * PRODUCTION profile validation (spec §4.3/§17): only an exact `final` profile
 * satisfies production readiness; test_only/provisional profiles always fail.
 */
export function validateProductionAuthoritativeReviewProfile(
  value: unknown,
): AuthoritativeReviewProfileSnapshotV1Body {
  const profile = validateAuthoritativeReviewProfile(value);
  if (profile.qualificationState !== 'final') {
    invalid('production readiness requires a final profile; test_only/provisional profiles cannot satisfy it');
  }
  return profile;
}

/** Reads and validates one profile file (the exact checked-in or an injected path). */
export function loadAuthoritativeReviewProfileFile(path: string | URL): AuthoritativeReviewProfileSnapshotV1Body {
  return validateAuthoritativeReviewProfile(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

/** Review-policy bounds enforced by the template/profile comparison (spec §6.2/§16.1). */
export interface ReviewPolicyBoundsV1 {
  assignmentSoftLimit: number;
  mapBatchTargetSlots: number;
  contentBatchTargetSlots: number;
  maxRounds: number;
}

/**
 * Templates can only tighten (design §22.2): every one of the 42 contract
 * limit fields must sit at or below the profile ceiling, and the review-policy
 * soft/batch/round values must sit within their profile bounds. `limits` is
 * the frozen Contract v2 `limits` group; `reviewPolicy` (when present) is the
 * normalized `reviewPolicy`. V1 never calls this — the v2 compiler/runtime do
 * not reuse the v1 `maxSlots` assertion (spec §16.1).
 */
export function assertTemplateLimitsWithinProfile(
  limits: Record<string, unknown>,
  profile: AuthoritativeReviewProfileSnapshotV1Body,
  reviewPolicy?: ReviewPolicyBoundsV1,
): void {
  if (!isPlainObject(limits)) invalid('template limits must be a plain object');
  for (const group of Object.keys(limits)) {
    if (!(group in PROFILE_TEMPLATE_GROUPS)) invalid(`unknown template limits group '${group}'`);
  }
  const templateCeilings = profile.template as unknown as Record<string, Record<string, number>>;
  for (const [group, fields] of Object.entries(PROFILE_TEMPLATE_GROUPS)) {
    const groupValue = limits[group];
    if (!isPlainObject(groupValue)) invalid(`template limits.${group} must be a plain object`);
    for (const key of Object.keys(groupValue)) {
      if (!fields.includes(key)) invalid(`unknown template limit '${key}' in group '${group}'`);
    }
    for (const field of fields) {
      const value = groupValue[field];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        invalid(`template limit ${group}.${field} must be a positive safe integer`);
      }
      const ceiling = templateCeilings[group][field];
      if (value > ceiling) {
        invalid(`template limits.${group}.${field} (${value}) exceeds the profile ceiling ${ceiling}`);
      }
    }
  }
  if (reviewPolicy !== undefined) {
    if (
      !Number.isSafeInteger(reviewPolicy.assignmentSoftLimit) ||
      reviewPolicy.assignmentSoftLimit < 1 ||
      reviewPolicy.assignmentSoftLimit > profile.runtime.assignmentMaxTotalObjects
    ) {
      invalid(`reviewPolicy.assignmentSoftLimit must be within the profile assignment total-object ceiling (${profile.runtime.assignmentMaxTotalObjects})`);
    }
    for (const [field, value] of [
      ['mapBatchTargetSlots', reviewPolicy.mapBatchTargetSlots],
      ['contentBatchTargetSlots', reviewPolicy.contentBatchTargetSlots],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > profile.runtime.assignmentMaxPrimaryTargets) {
        invalid(`reviewPolicy.${field} must be within the profile assignment primary-target ceiling (${profile.runtime.assignmentMaxPrimaryTargets})`);
      }
    }
    if (
      !Number.isSafeInteger(reviewPolicy.maxRounds) ||
      reviewPolicy.maxRounds < 1 ||
      reviewPolicy.maxRounds > profile.runtime.maxRoundsPerTrack
    ) {
      invalid(`reviewPolicy.maxRounds must be within the profile per-track round budget (${profile.runtime.maxRoundsPerTrack})`);
    }
    // One round's assignments must be able to cut the whole tree at the
    // template's own batch targets (design §22.2).
    const needed = Math.max(
      Math.ceil(profile.runtime.maxSlots / reviewPolicy.mapBatchTargetSlots),
      Math.ceil(profile.runtime.maxSlots / reviewPolicy.contentBatchTargetSlots),
    );
    const templateAuthoritative = limits['authoritative'];
    const maxAssignments =
      isPlainObject(templateAuthoritative) ? (templateAuthoritative['maxAssignmentsPerRound'] as number | undefined) : undefined;
    if (typeof maxAssignments !== 'number' || maxAssignments < needed) {
      invalid(`template limits.authoritative.maxAssignmentsPerRound must support cutting maxSlots at the template batch targets (${needed} assignments)`);
    }
  }
}

/** True when the profile body carries the complete structural groups (frozen shape). */
export function carriesCompleteProfileBody(profile: AuthoritativeReviewProfileSnapshotV1Body): boolean {
  return (
    isPlainObject(profile.runtime) &&
    PROFILE_RUNTIME_FIELDS.every((field) => field in profile.runtime) &&
    Object.values(profile.budgetProfiles).every((entry) =>
      PROFILE_BUDGET_PROFILE_FIELDS.every((field) => field in (entry as unknown as Record<string, unknown>)),
    ) &&
    PROFILE_ASSEMBLER_BUDGET_FIELDS.every((field) => field in profile.assemblerBudget)
  );
}