/**
 * Task 13 grant-service (design §11.11/§14.2/§18.4, spec §10.2/§11, §16.3):
 * WriteGrantSpec / GrantInstance lifecycle validation and the closure-bound
 * authority gate every v2 tool consults BEFORE any mutation.
 *
 * The WorkItem coordinator (Task 10) already creates the immutable WriteGrantSpec
 * in the workitem-creation batch and signs the lease-bound GrantInstance in the
 * lease envelope (`shouldSignGrantInstance`). This module owns the TOOL-SIDE
 * half: resolving the spec/instance from the attempt context, proving they are
 * still current (stale baseline/epoch, same-root/different-manifest), proving a
 * write target is inside the spec's scope, proving the payload is inside the
 * frozen profile byte limits, and enforcing the §11 "no task/grant/path/lease/
 * attempt/authority fields" rule by NEVER accepting those as parameters.
 *
 * The Task 13 GRANT-SPEC TENSION resolution is enforced here: reviewer and
 * submitter sessions carry a `review_observation` WriteGrantSpec whose write
 * authority is EMPTY (`grantWriteAuthority() === 'none'`), so every write gate
 * rejects their writes while the frozen created-event validator (grantSpecRef
 * !== null on every agent_assignment) is satisfied. `shouldSignGrantInstance`
 * continues to gate materialization — reviewer/submitter instances are never
 * signed, so their dispatch `grantInstanceRef` stays null.
 *
 * Idempotency (§11): every mutating write family keys on a stable
 * `clientOperationId` (or the one frozen trusted-runner tool-call identity).
 * `classifyToolReplay` is the pure replay/conflict decision over the journal's
 * committed operations: same operation + same canonical body replays the prior
 * result; same operation + different body conflicts with zero writes.
 *
 * V1 byte-for-byte: this is a NEW module; nothing v1 is touched.
 */
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { AuthoritativeReviewProjectionV2 } from '../../storage/authoritative-review-state';
import {
  canonicalJsonSha256,
} from '../../structured-slots/canonical-json';
import type {
  AuthoritativeReviewProfile,
  AuthorityBaseSetV2,
  GrantInstanceV2,
  RepairBatchGrantSpecV2,
  WriteGrantSpecV2,
} from '../../authoritative-review/authority-types';
import {
  grantWriteAuthority,
  grantSpecMapWriteScope,
  grantSpecWriteSlotIds,
  type GrantWriteAuthorityV2,
} from '../../authoritative-review/authority-types';
import type { V2AttemptContext } from './attempt-coordinator';

/** Stable grant error codes (public surface, §14.3 stable-code family). */
export type GrantErrorCodeV2 =
  | 'GRANT_NOT_FOUND'
  | 'GRANT_STALE'
  | 'WRITE_OUT_OF_SCOPE'
  | 'PAYLOAD_LIMIT_EXCEEDED'
  | 'SCOPE_EXPANSION_REJECTED'
  | 'OPERATION_CONFLICT'
  | 'REPLAYED'
  | 'TASK_WRITE_LEASE_CONFLICT';

/** Typed grant-service error (stable code + zero-writes rejection). */
export class GrantError extends Error {
  readonly code: GrantErrorCodeV2;

  constructor(code: GrantErrorCodeV2, message: string) {
    super(message);
    this.name = 'GrantError';
    this.code = code;
  }
}

/** Exact five-key BlobRef equality — the ONLY ref identity (spec §7.1). */
export function sameRefV2(a: BlobRefV2, b: BlobRefV2): boolean {
  return (
    a.kind === b.kind &&
    a.digest === b.digest &&
    a.byteLength === b.byteLength &&
    a.mediaType === b.mediaType &&
    a.schemaVersion === b.schemaVersion
  );
}

/** Throw GRANT_STALE unless the two refs are the exact same authority ref. */
export function assertExactBase(expected: BlobRefV2, actual: BlobRefV2, what: string): void {
  if (!sameRefV2(expected, actual)) {
    throw new GrantError(
      'GRANT_STALE',
      `grant authority ${what} is stale: expected ${expected.digest.slice(0, 12)}… got ${actual.digest.slice(0, 12)}…`,
    );
  }
}

/**
 * The resolved, closure-bound grant of one attempt. `instance` is null for
 * review/submitter sessions (never signed) and for read-only tools.
 */
export interface ResolvedAttemptGrant {
  spec: WriteGrantSpecV2;
  specRef: BlobRefV2;
  instance: GrantInstanceV2 | null;
  workItemId: string;
  leaseEpoch: number;
  attemptId: string;
  agentId: string;
  authorityBaseRef: BlobRefV2;
  baseSet: AuthorityBaseSetV2;
}

/** Resolves the committed dispatch blob of a leased attempt (null when unknown). */
export type DispatchResolver = (
  taskId: string,
  workItemId: string,
  attemptId: string,
) => Promise<{ dispatch: Record<string, unknown>; dispatchRef: BlobRefV2 } | null>;

export interface GrantServiceDependencies {
  /** Resolves a BlobRefV2 to its canonical object bytes. */
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown> | unknown;
  /** Reproduces the current authority projection (corruption propagates). */
  readProjection(taskId: string): Promise<AuthoritativeReviewProjectionV2>;
  /** The frozen profile (byte caps / assignment caps). */
  profile: AuthoritativeReviewProfile;
  /** Resolves the committed dispatch by attempt identity (scheduler path). */
  resolveDispatch?: DispatchResolver;
}

/* ------------------------------------------------------------------ */
/* Pure spec/scope/instance rules (heavily unit-tested)                */
/* ------------------------------------------------------------------ */

/** Full spec equality — same kind and identical every field (scope included). */
export function specsEqual(a: WriteGrantSpecV2, b: WriteGrantSpecV2): boolean {
  return canonicalJsonSha256(specWithoutDigest(a)) === canonicalJsonSha256(specWithoutDigest(b));
}

/** The spec bytes minus its self-digest (the canonical scope identity). */
export function specWithoutDigest(spec: WriteGrantSpecV2): Record<string, unknown> {
  const rec = { ...(spec as unknown as Record<string, unknown>) };
  delete rec.specDigest;
  return rec;
}

/**
 * Spec/WorkItem/AuthorityBase chain uniformity (design §11.11): the spec's
 * authorityBaseRef must be the EXACT base the WorkItem references, and the base
 * set's plan refs must match the spec's plan refs when the base binds a plan.
 * Returns the error list ([] when legal) — never throws.
 */
export function specUniformErrors(
  spec: WriteGrantSpecV2,
  workItemBaseRef: BlobRefV2,
  baseSet: AuthorityBaseSetV2,
): string[] {
  const errors: string[] = [];
  if (!sameRefV2(spec.authorityBaseRef, workItemBaseRef)) {
    errors.push('WriteGrantSpec.authorityBaseRef does not match the WorkItem authorityBaseRef');
  }
  // Cross-check the spec's plan refs against the base set's plan ref.
  const basePlan = baseSet.planSpecRef;
  const specPlan = specPlanRef(spec);
  if (basePlan !== null && specPlan !== null && !sameRefV2(basePlan, specPlan)) {
    errors.push('WriteGrantSpec plan ref does not match the AuthorityBaseSet plan ref');
  }
  return errors;
}

/** The plan ref a spec binds (map build / generation / repair), or null. */
export function specPlanRef(spec: WriteGrantSpecV2): BlobRefV2 | null {
  switch (spec.kind) {
    case 'initial_structure_chunk':
      return spec.mapBuildSpecRef;
    case 'initial_generation_batch':
      return spec.generationPlanSpecRef;
    case 'map_repair_batch':
    case 'content_repair_batch':
      return spec.repairPlanSpecRef;
    case 'review_observation':
      return null;
  }
}

/**
 * Reclaim re-sign rule (design §11.11): a re-signed instance must be bound to
 * the SAME spec scope — the scope NEVER changes across reclaims. A successor
 * plan revision gets a NEW spec; the OLD spec is immutable and never widened.
 */
export function assertReclaimScopeUnchanged(oldSpec: WriteGrantSpecV2, candidate: WriteGrantSpecV2): void {
  if (!specsEqual(oldSpec, candidate)) {
    throw new GrantError(
      'SCOPE_EXPANSION_REJECTED',
      'a reclaimed GrantInstance must re-sign the UNCHANGED WriteGrantSpec scope (scope expansion only happens via successor specs)',
    );
  }
}

/** Scope-expansion cannot mutate the CURRENT Grant (Task 19 owns successors). */
export function assertScopeNotExpanded(
  current: WriteGrantSpecV2,
  candidate: WriteGrantSpecV2,
): void {
  if (!specsEqual(current, candidate)) {
    throw new GrantError(
      'SCOPE_EXPANSION_REJECTED',
      'the current Grant scope is immutable; scope expansion requires a successor plan revision and replacement WriteGrantSpec',
    );
  }
}

/**
 * Out-of-scope write rejection (design §14.2/§18.4): a content write is legal
 * only when the spec's write authority is generation/content_repair AND the
 * slot is in its writeSlotIds. Every other authority (structure/map_repair/
 * none) rejects with ZERO writes.
 */
export function assertContentWriteAuthorized(spec: WriteGrantSpecV2, slotId: string): void {
  const authority = grantWriteAuthority(spec);
  if (authority !== 'generation' && authority !== 'content_repair') {
    throw new GrantError(
      'WRITE_OUT_OF_SCOPE',
      `grant authority '${authority}' grants no content write for slot '${slotId}'`,
    );
  }
  const allowed = grantSpecWriteSlotIds(spec);
  if (!allowed.includes(slotId)) {
    throw new GrantError(
      'WRITE_OUT_OF_SCOPE',
      `slot '${slotId}' is not inside the grant's writeSlotIds (${allowed.length} authorized)`,
    );
  }
}

/**
 * Out-of-scope Map write rejection: only `map_repair_batch` specs carry a
 * MapWriteScope, and the node/relation/operation must be inside it.
 */
export function assertMapWriteAuthorized(
  spec: WriteGrantSpecV2,
  target: { kind: 'node' | 'relation' | 'parent' | 'operation'; id: string },
): void {
  const scope = grantSpecMapWriteScope(spec);
  if (scope === null) {
    throw new GrantError('WRITE_OUT_OF_SCOPE', `grant authority '${grantWriteAuthority(spec)}' grants no Map write`);
  }
  if (target.kind === 'node') {
    if (!scope.nodeIds.includes(target.id)) {
      throw new GrantError('WRITE_OUT_OF_SCOPE', `map node '${target.id}' is not inside the grant's mapWriteScope`);
    }
  } else if (target.kind === 'relation') {
    if (!scope.relationIds.includes(target.id)) {
      throw new GrantError('WRITE_OUT_OF_SCOPE', `map relation '${target.id}' is not inside the grant's mapWriteScope`);
    }
  } else if (target.kind === 'parent') {
    if (!scope.parentContainers.includes(target.id)) {
      throw new GrantError('WRITE_OUT_OF_SCOPE', `parent container '${target.id}' is not an authorized new-node parent`);
    }
  } else {
    if (!scope.operations.includes(target.id as (typeof scope.operations)[number])) {
      throw new GrantError('WRITE_OUT_OF_SCOPE', `map operation '${target.id}' is not inside the grant's operations`);
    }
  }
}

/** Oversized payload (design §22/§12.3; profile maxBytesByKind). */
export function assertPayloadWithinProfile(
  profile: AuthoritativeReviewProfile,
  kind: keyof AuthoritativeReviewProfile['maxBytesByKind'] & string,
  bytes: number,
): void {
  const cap = profile.maxBytesByKind[kind] ?? Number.POSITIVE_INFINITY;
  if (bytes > cap) {
    throw new GrantError('PAYLOAD_LIMIT_EXCEEDED', `payload of ${bytes} bytes exceeds the profile cap of ${cap} for '${kind}'`);
  }
}

/** Total evidence bytes across one submission (profile evidence caps). */
export function assertEvidenceWithinProfile(
  profile: AuthoritativeReviewProfile,
  totalBytes: number,
): void {
  if (totalBytes > profile.evidenceMaxBytesTotal) {
    throw new GrantError(
      'PAYLOAD_LIMIT_EXCEEDED',
      `evidence of ${totalBytes} bytes exceeds the profile cap of ${profile.evidenceMaxBytesTotal}`,
    );
  }
}

/**
 * GrantInstance signing (design §11.11): a lease signs ONE instance bound to
 * the WorkItem, attempt, Agent, epoch and the SAME authority base. The instance
 * digest covers the exact canonical bytes minus its own digest field.
 */
export function signGrantInstance(input: {
  grantSpecRef: BlobRefV2;
  workItemId: string;
  leaseEpoch: number;
  boundAttemptId: string;
  agentId: string;
  grantInstanceId: string;
}): GrantInstanceV2 {
  const body: Omit<GrantInstanceV2, 'instanceDigest'> = {
    grantInstanceId: input.grantInstanceId,
    grantSpecRef: input.grantSpecRef,
    workItemId: input.workItemId,
    leaseEpoch: input.leaseEpoch,
    boundAttemptId: input.boundAttemptId,
    agentId: input.agentId,
  };
  return { ...body, instanceDigest: canonicalJsonSha256(body) };
}

/** Instance currency (design §11.11): workitem/epoch/attempt/agent/base binding. */
export function assertInstanceCurrent(
  instance: GrantInstanceV2,
  checks: {
    workItemId: string;
    leaseEpoch: number;
    attemptId: string;
    agentId: string;
    specRef: BlobRefV2;
    authorityBaseRef: BlobRefV2;
  },
): void {
  if (instance.workItemId !== checks.workItemId) {
    throw new GrantError('GRANT_STALE', `grant instance is bound to workitem '${instance.workItemId}', not '${checks.workItemId}'`);
  }
  if (instance.leaseEpoch !== checks.leaseEpoch) {
    throw new GrantError('GRANT_STALE', `grant instance epoch ${instance.leaseEpoch} does not match lease epoch ${checks.leaseEpoch}`);
  }
  if (instance.boundAttemptId !== checks.attemptId) {
    throw new GrantError('GRANT_STALE', `grant instance is bound to attempt '${instance.boundAttemptId}', not '${checks.attemptId}'`);
  }
  if (instance.agentId !== checks.agentId) {
    throw new GrantError('GRANT_STALE', `grant instance is bound to agent '${instance.agentId}', not '${checks.agentId}'`);
  }
  if (!sameRefV2(instance.grantSpecRef, checks.specRef)) {
    throw new GrantError('GRANT_STALE', 'grant instance does not reference the current WriteGrantSpec');
  }
}

/** Same-root/different-manifest staleness (design §11.5/§15.1): a manifest ref
 * change is stale even when the content root digest is identical. */
export function assertManifestCurrent(
  expected: BlobRefV2,
  actual: BlobRefV2,
  what: string,
): void {
  assertExactBase(expected, actual, what);
}

/* ------------------------------------------------------------------ */
/* Task 19 repair grant builders (design §11.11 / spec §13.3)          */
/* ------------------------------------------------------------------ */

/**
 * The deterministic `map_repair_batch` / `content_repair_batch` WriteGrantSpec
 * of one repair batch (spec §13.3): binds the plan spec ref, the repair base
 * and the batch's staging CAS (`expectedStagingRootRef` = the staging root the
 * batch must observe; `planKeyLedgerRef` = the ledger the batch extends). The
 * writeScope is the plan's batch scope — a map batch carries the exact
 * MapWriteScopeV2 (nodes/relations/plan keys/parents/relation types/
 * operations), a content batch the exact slot list. The spec digest covers the
 * canonical bytes minus the self-digest (the frozen parser rule).
 */
export function buildRepairBatchGrantSpec(input: {
  grantSpecId: string;
  workItemId: string;
  kind: 'map_repair_batch' | 'content_repair_batch';
  snapshotHash: string;
  authorityBaseRef: BlobRefV2;
  repairPlanSpecRef: BlobRefV2;
  repairBase: RepairBatchGrantSpecV2['repairBase'];
  expectedStagingRootRef: BlobRefV2;
  planKeyLedgerRef: BlobRefV2 | null;
  batchOrdinal: number;
  findingIds: readonly string[];
  maxContextBytes: number;
  writeScope: RepairBatchGrantSpecV2['writeScope'];
}): RepairBatchGrantSpecV2 {
  const body: Omit<RepairBatchGrantSpecV2, 'specDigest'> = {
    grantSpecId: input.grantSpecId,
    workItemId: input.workItemId,
    kind: input.kind,
    snapshotHash: input.snapshotHash,
    authorityBaseRef: input.authorityBaseRef,
    repairPlanSpecRef: input.repairPlanSpecRef,
    repairBase: input.repairBase,
    expectedStagingRootRef: input.expectedStagingRootRef,
    planKeyLedgerRef: input.planKeyLedgerRef,
    batchOrdinal: input.batchOrdinal,
    findingIds: [...input.findingIds].sort(),
    readScope: { maxContextBytes: input.maxContextBytes },
    writeScope: input.writeScope as RepairBatchGrantSpecV2['writeScope'],
  };
  return { ...body, specDigest: canonicalJsonSha256(body) };
}

/** The plan-key ledger ref a repair grant binds (null for a plan without
 * keys — never for repair batches, which always carry the revision ledger). */
export function grantSpecPlanKeyLedgerRef(spec: WriteGrantSpecV2): BlobRefV2 | null {
  return spec.kind === 'map_repair_batch' || spec.kind === 'content_repair_batch' ? spec.planKeyLedgerRef : null;
}

/** The expected staging-root CAS of a repair grant (the base staging root for
 * batch 1; the latest committed staging root for later batches). */
export function grantSpecExpectedStagingRootRef(spec: WriteGrantSpecV2): BlobRefV2 | null {
  return spec.kind === 'map_repair_batch' || spec.kind === 'content_repair_batch' ? spec.expectedStagingRootRef : null;
}

/** The finding set a repair grant is authorized to address (sorted ids). */
export function grantSpecFindingIds(spec: WriteGrantSpecV2): readonly string[] {
  return spec.kind === 'map_repair_batch' || spec.kind === 'content_repair_batch' ? spec.findingIds : [];
}

/* ------------------------------------------------------------------ */
/* Idempotency (response-loss replay + same-op/different-body conflict)*/
/* ------------------------------------------------------------------ */

/** One committed mutating tool operation (from the private journal). */
export interface CommittedToolOperationV2 {
  clientOperationId: string;
  /** canonical body digest (SHA-256 over canonicalJson(body)). */
  bodyDigest: string;
  /** the original result payload (replayed verbatim). */
  result: unknown;
}

export type ToolReplayV2 =
  | { status: 'new' }
  | { status: 'replay'; committed: CommittedToolOperationV2 }
  | { status: 'conflict' };

/**
 * The §11 idempotency decision: same clientOperationId + same canonical body
 * replays the prior result; same id + different body conflicts (ZERO writes).
 */
export function classifyToolReplay(
  clientOperationId: string,
  body: unknown,
  committed: readonly CommittedToolOperationV2[],
): ToolReplayV2 {
  const digest = canonicalJsonSha256(body);
  let matched: CommittedToolOperationV2 | null = null;
  for (const op of committed) {
    if (op.clientOperationId === clientOperationId) {
      matched = op;
      break;
    }
  }
  if (matched === null) return { status: 'new' };
  if (matched.bodyDigest === digest) return { status: 'replay', committed: matched };
  return { status: 'conflict' };
}

/* ------------------------------------------------------------------ */
/* Runtime resolution (async, projection-backed)                       */
/* ------------------------------------------------------------------ */

export class GrantService {
  private readonly resolver: GrantServiceDependencies['resolver'];

  private readonly readProjection: GrantServiceDependencies['readProjection'];

  private readonly profile: AuthoritativeReviewProfile;

  private readonly resolveDispatch: DispatchResolver | undefined;

  constructor(deps: GrantServiceDependencies) {
    this.resolver = deps.resolver;
    this.readProjection = deps.readProjection;
    this.profile = deps.profile;
    this.resolveDispatch = deps.resolveDispatch;
  }

  get profileRef(): AuthoritativeReviewProfile {
    return this.profile;
  }

  /**
   * Resolves the closure-bound grant of the current attempt: the workitem's
   * spec ref, the spec blob, the base set, and (for write sessions) the
   * lease-bound GrantInstance. A null instance is legal ONLY for read-only
   * sessions; write-session tools reject with GRANT_NOT_FOUND before mutation.
   */
  async resolveAttemptGrant(ctx: V2AttemptContext): Promise<ResolvedAttemptGrant> {
    const state = await this.readProjection(ctx.taskId);
    const wi = state.workItems[ctx.workItemId];
    if (wi === undefined) {
      throw new GrantError('GRANT_NOT_FOUND', `no workitem '${ctx.workItemId}' in the current projection`);
    }
    if (wi.grantSpecRef === null) {
      throw new GrantError('GRANT_NOT_FOUND', `workitem '${ctx.workItemId}' carries no WriteGrantSpec`);
    }
    const spec = (await this.resolver(ctx.taskId, wi.grantSpecRef)) as WriteGrantSpecV2;
    if (!spec || typeof spec !== 'object') {
      throw new GrantError('GRANT_NOT_FOUND', `WriteGrantSpec blob '${wi.grantSpecRef.digest.slice(0, 12)}…' is unresolvable`);
    }
    const baseSet = (await this.resolver(ctx.taskId, wi.authorityBaseRef)) as AuthorityBaseSetV2;
    if (!baseSet || typeof baseSet !== 'object') {
      throw new GrantError('GRANT_NOT_FOUND', `AuthorityBaseSet blob '${wi.authorityBaseRef.digest.slice(0, 12)}…' is unresolvable`);
    }
    const uniform = specUniformErrors(spec, wi.authorityBaseRef, baseSet);
    if (uniform.length > 0) {
      throw new GrantError('GRANT_STALE', uniform.join('; '));
    }
    let instance: GrantInstanceV2 | null = null;
    if (grantWriteAuthority(spec) !== 'none') {
      const dispatch = await this.resolveDispatchForAttempt(ctx);
      instance = dispatch === null ? null : await this.resolveInstanceFromDispatch(ctx, dispatch);
      if (instance === null) {
        throw new GrantError('GRANT_NOT_FOUND', `write session '${ctx.sessionKind}' has no lease-bound GrantInstance`);
      }
      assertInstanceCurrent(instance, {
        workItemId: ctx.workItemId,
        leaseEpoch: ctx.leaseEpoch,
        attemptId: ctx.attemptId,
        agentId: ctx.agentId,
        specRef: wi.grantSpecRef,
        authorityBaseRef: wi.authorityBaseRef,
      });
    }
    return {
      spec,
      specRef: wi.grantSpecRef,
      instance,
      workItemId: ctx.workItemId,
      leaseEpoch: ctx.leaseEpoch,
      attemptId: ctx.attemptId,
      agentId: ctx.agentId,
      authorityBaseRef: wi.authorityBaseRef,
      baseSet,
    };
  }

  /**
   * Stale baseline/epoch gate (design §18.4, spec §10.2): every mutation
   * REPROJECTS the current authority and rejects when the lease/attempt is no
   * longer current — zero writes. `ctx` is the tool closure's attempt identity;
   * `state` is the freshly projected authority.
   */
  assertAttemptCurrent(ctx: V2AttemptContext, state: AuthoritativeReviewProjectionV2): void {
    const lease = state.activeLease;
    if (lease === null || lease.workItemId !== ctx.workItemId) {
      throw new GrantError('TASK_WRITE_LEASE_CONFLICT', `workitem '${ctx.workItemId}' is not the active lease`);
    }
    const boundAttempt = lease.attemptId ?? lease.commandId;
    if (boundAttempt === null || boundAttempt !== ctx.attemptId) {
      throw new GrantError(
        'TASK_WRITE_LEASE_CONFLICT',
        `active lease binds attempt '${String(boundAttempt)}', not '${ctx.attemptId}'`,
      );
    }
    if (lease.leaseEpoch !== ctx.leaseEpoch) {
      throw new GrantError(
        'TASK_WRITE_LEASE_CONFLICT',
        `active lease epoch ${lease.leaseEpoch} does not match closure epoch ${ctx.leaseEpoch}`,
      );
    }
  }

  private async resolveDispatchForAttempt(ctx: V2AttemptContext): Promise<{ dispatch: Record<string, unknown>; dispatchRef: BlobRefV2 } | null> {
    if (ctx.dispatchRef !== null) {
      const blob = (await this.resolver(ctx.taskId, ctx.dispatchRef)) as Record<string, unknown> | null;
      if (blob === null || typeof blob !== 'object') {
        throw new GrantError('GRANT_NOT_FOUND', `dispatch blob '${ctx.dispatchRef.digest.slice(0, 12)}…' is unresolvable`);
      }
      return { dispatch: blob, dispatchRef: ctx.dispatchRef };
    }
    if (this.resolveDispatch === undefined) {
      return null;
    }
    return this.resolveDispatch(ctx.taskId, ctx.workItemId, ctx.attemptId);
  }

  private async resolveInstanceFromDispatch(
    ctx: V2AttemptContext,
    dispatch: { dispatch: Record<string, unknown>; dispatchRef: BlobRefV2 },
  ): Promise<GrantInstanceV2 | null> {
    const instanceRef = (dispatch.dispatch as { grantInstanceRef?: BlobRefV2 | null }).grantInstanceRef ?? null;
    if (instanceRef === null) return null;
    const blob = (await this.resolver(ctx.taskId, instanceRef)) as GrantInstanceV2 | null;
    if (blob === null || typeof blob !== 'object') {
      throw new GrantError('GRANT_NOT_FOUND', `grant instance blob '${instanceRef.digest.slice(0, 12)}…' is unresolvable`);
    }
    return blob;
  }
}
