/**
 * Task 10 authority-base runtime (design §17.2, spec §10.1): exact
 * AuthorityBaseSetV2 construction, per-kind field matrices, staleness by EXACT
 * ref equality and carrier uniformity (WorkItem/GrantSpec/AssignmentDispatch/
 * plan events all reference the SAME authorityBaseRef — never naked digest
 * copies), plus the park-disposition and WorkItem carry validators the
 * coordinator runs before any pin is created.
 *
 * The pure matrices/tables live in `work-item-domain.ts`; this module packages
 * them for the runtime: digest binding (baseSetDigest, display digests),
 * chain-uniform staleness checks (`StaleAuthorityBaseError`) and the closed
 * carry validators.
 */
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { SchemaError } from '../../authoritative-review/authority-types';
import type { AuthorityBaseSetV2, WorkItemV2, WorkItemParkDispositionV2 } from '../../authoritative-review/authority-types';
import type { WorkItemKindV2, BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { StructuredSessionKindV2 } from '../../authoritative-review/authority-types';
import {
  assertParkDispositionInvariants,
  validateAuthorityBaseForWorkItem,
  validateWorkItemForKind,
  type WorkItemExecutionKindV2,
} from '../../authoritative-review/work-item-domain';

export type { WorkItemExecutionKindV2 };

/** Every nullable ref field of an AuthorityBaseSetV2 (display-digest keys). */
export type AuthorityBaseRefFieldV2 =
  | 'mapRef'
  | 'mapCandidateRef'
  | 'mapReviewBundleRef'
  | 'contentRevisionManifestRef'
  | 'planSpecRef'
  | 'stagingManifestRef'
  | 'reviewCoverageCoreRef'
  | 'reviewRoundRef'
  | 'reviewBundleRef'
  | 'sealRecordRef'
  | 'artifactRef'
  | 'findingSetRef'
  | 'artifactDeliveryRef';

export const AUTHORITY_BASE_REF_FIELDS: readonly AuthorityBaseRefFieldV2[] = [
  'mapRef',
  'mapCandidateRef',
  'mapReviewBundleRef',
  'contentRevisionManifestRef',
  'planSpecRef',
  'stagingManifestRef',
  'reviewCoverageCoreRef',
  'reviewRoundRef',
  'reviewBundleRef',
  'sealRecordRef',
  'artifactRef',
  'findingSetRef',
  'artifactDeliveryRef',
];

/** Staleness diagnostic: a carrier no longer references the exact authority. */
export class StaleAuthorityBaseError extends Error {
  readonly reason: 'ref_mismatch' | 'profile_mismatch';

  readonly what: string;

  constructor(reason: StaleAuthorityBaseError['reason'], what: string, detail?: string) {
    super(`stale authority base (${reason}) for ${what}${detail === undefined ? '' : `: ${detail}`}`);
    this.name = 'StaleAuthorityBaseError';
    this.reason = reason;
    this.what = what;
  }
}

/** Exact five-key ref equality — the ONLY authority identity (spec §7.1). */
export function sameRef(a: BlobRefV2, b: BlobRefV2): boolean {
  return (
    a.kind === b.kind &&
    a.digest === b.digest &&
    a.byteLength === b.byteLength &&
    a.mediaType === b.mediaType &&
    a.schemaVersion === b.schemaVersion
  );
}

/** Throw `StaleAuthorityBaseError` unless `expected` and `actual` are the exact same ref. */
export function assertExactRef(expected: BlobRefV2, actual: BlobRefV2, what: string): void {
  if (!sameRef(expected, actual)) {
    throw new StaleAuthorityBaseError('ref_mismatch', what, `expected=${expected.digest.slice(0, 12)}… actual=${actual.digest.slice(0, 12)}…`);
  }
}

/** Pure staleness predicate: a completion/base is stale unless the refs are EXACTLY equal. */
export function assertBaseStaysCurrent(expected: BlobRefV2, actual: BlobRefV2, what: string): void {
  assertExactRef(expected, actual, what);
}

export interface BuildAuthorityBaseSetInputV2 {
  taskId: string;
  templateSnapshotRef: BlobRefV2;
  profileSnapshotRef: BlobRefV2;
  /** Only fields that MUST be non-null; everything else stays null. */
  refs: Partial<Record<AuthorityBaseRefFieldV2, BlobRefV2>>;
  kind: WorkItemKindV2;
  agentExecutionKind?: WorkItemExecutionKindV2;
  sessionKind?: StructuredSessionKindV2 | null;
}

/**
 * Construct one canonical AuthorityBaseSetV2: matrix validation, mandatory
 * profile/template refs, display-digest aliases and the self-digest
 * (baseSetDigest = canonical bytes minus that field — the registry parser
 * verifies it). Deterministic: identical inputs produce identical bytes.
 */
export function buildAuthorityBaseSet(input: BuildAuthorityBaseSetInputV2): AuthorityBaseSetV2 {
  const execution = input.agentExecutionKind ?? null;
  const session = input.sessionKind ?? null;
  const base: AuthorityBaseSetV2 = {
    taskId: input.taskId,
    templateSnapshotRef: input.templateSnapshotRef,
    profileSnapshotRef: input.profileSnapshotRef,
    mapRef: input.refs.mapRef ?? null,
    mapCandidateRef: input.refs.mapCandidateRef ?? null,
    mapReviewBundleRef: input.refs.mapReviewBundleRef ?? null,
    contentRevisionManifestRef: input.refs.contentRevisionManifestRef ?? null,
    planSpecRef: input.refs.planSpecRef ?? null,
    stagingManifestRef: input.refs.stagingManifestRef ?? null,
    reviewCoverageCoreRef: input.refs.reviewCoverageCoreRef ?? null,
    reviewRoundRef: input.refs.reviewRoundRef ?? null,
    reviewBundleRef: input.refs.reviewBundleRef ?? null,
    sealRecordRef: input.refs.sealRecordRef ?? null,
    artifactRef: input.refs.artifactRef ?? null,
    findingSetRef: input.refs.findingSetRef ?? null,
    artifactDeliveryRef: input.refs.artifactDeliveryRef ?? null,
    displayDigests: {},
    baseSetDigest: '',
  };
  const displayDigests: Record<string, string> = {};
  for (const field of AUTHORITY_BASE_REF_FIELDS) {
    const ref = base[field];
    if (ref !== null) {
      displayDigests[field] = ref.digest;
    }
  }
  base.displayDigests = displayDigests;
  const errors = validateAuthorityBaseSet(base, input.kind, execution, session);
  if (errors.length > 0) {
    throw new SchemaError(`invalid AuthorityBaseSet for '${input.kind}': ${errors.join('; ')}`);
  }
  const { baseSetDigest: _digest, ...withoutDigest } = base;
  base.baseSetDigest = canonicalJsonSha256(withoutDigest);
  return base;
}

/** Matrix + mandatory-ref + display-digest validation (errors, or [] when legal). */
export function validateAuthorityBaseSet(
  base: AuthorityBaseSetV2,
  kind: WorkItemKindV2,
  execution?: WorkItemExecutionKindV2,
  session?: StructuredSessionKindV2 | null,
): string[] {
  if (base.profileSnapshotRef === null || base.profileSnapshotRef === undefined) {
    return ['profileSnapshotRef is mandatory for every WorkItem'];
  }
  if (base.templateSnapshotRef === null || base.templateSnapshotRef === undefined) {
    return ['templateSnapshotRef is mandatory for every WorkItem'];
  }
  const errors = validateAuthorityBaseForWorkItem(base, kind, execution ?? null, session ?? null);
  if (errors.length > 0) return errors;
  return [];
}

/**
 * Closed park-disposition validation (design §17.2: only parked carries one;
 * the two branches are exclusive and exactly-keyed). Throws SchemaError.
 */
export function validateParkDisposition(disposition: WorkItemParkDispositionV2): void {
  assertParkDispositionInvariants(disposition);
}

/**
 * WorkItem carry validation (design §17.2 discriminants): agent vs system,
 * structured vs generic, review assignments, grant ownership, delivery
 * binding. Returns the error list ([] when legal).
 */
export function validateWorkItemCarry(
  carry: Pick<
    WorkItemV2,
    | 'kind'
    | 'roleBinding'
    | 'agentExecutionKind'
    | 'sessionKind'
    | 'roundId'
    | 'logicalAssignmentId'
    | 'reviewAssignmentId'
    | 'grantSpecRef'
    | 'inputArtifactDeliveryId'
  >,
): string[] {
  return validateWorkItemForKind({
    workItemId: '',
    authorityBaseRef: { kind: 'authority_base_set', digest: '', byteLength: 0, mediaType: 'application/json', schemaVersion: 1 },
    payloadRef: { kind: 'content_value', digest: '', byteLength: 0, mediaType: 'text/plain', schemaVersion: 1 },
    state: 'ready',
    parkDisposition: null,
    leaseEpoch: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    attemptCount: 0,
    retryOrdinal: 0,
    retryNotBefore: null,
    maxAutomaticRetries: 0,
    ...carry,
  });
}

/** Resolved carriers the authority chain must bind to ONE base + ONE profile. */
export interface AuthorityCarriersV2 {
  /** The resolved AuthorityBaseSet the WorkItem references. */
  baseSet: AuthorityBaseSetV2;
  /** The base ref the AssignmentDispatch blob carries (null when absent). */
  dispatchBaseRef: BlobRefV2 | null;
  /** The base ref the WriteGrantSpec blob carries (null when absent). */
  grantSpecBaseRef: BlobRefV2 | null;
  /** Plan refs the grant spec carries (mapBuildSpecRef/generationPlanSpecRef/repairPlanSpecRef). */
  grantSpecPlanRefs: readonly BlobRefV2[];
}

/**
 * Chain uniformity (§17.2 "WorkItem、GrantSpec、AssignmentDispatch、attempt/
 * command 和所有结果事件引用同一个 authorityBaseRef，不能各自复制一组裸
 * digest"): every carrier must reference the EXACT base ref the WorkItem uses
 * (so a dispatch/grant built under a different profile is stale BY REFERENCE),
 * and a grant spec's plan refs must be the EXACT plan refs the base binds.
 */
export function assertAuthorityCarriersUniform(
  workItemBaseRef: BlobRefV2,
  carriers: AuthorityCarriersV2,
): void {
  const { baseSet, dispatchBaseRef, grantSpecBaseRef, grantSpecPlanRefs } = carriers;
  if (dispatchBaseRef !== null) {
    assertExactRef(workItemBaseRef, dispatchBaseRef, 'AssignmentDispatch.authorityBaseRef');
  }
  if (grantSpecBaseRef !== null) {
    assertExactRef(workItemBaseRef, grantSpecBaseRef, 'WriteGrantSpec.authorityBaseRef');
  }
  // Plan cross-binding: a grant spec's plan refs must be the EXACT plan refs
  // the base binds. Plan-less bases (review/observation sessions) cannot cross-
  // check — their grants carry no canonical plan and the frozen created-event
  // validator nonetheless demands a grant ref — the BASE-ref equality above
  // remains the uniformity guarantee.
  if (baseSet.planSpecRef !== null) {
    for (const planRef of grantSpecPlanRefs) {
      assertExactRef(baseSet.planSpecRef, planRef, 'plan carrier');
    }
  }
}
