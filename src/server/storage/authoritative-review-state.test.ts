// @vitest-environment node
/**
 * Task 9: pure v2 projector tests (spec §9.3, §10.3.1, §13.3.1).
 *
 * Two strategies:
 * 1. Seeded deterministic generators emit LONG LEGAL histories across the
 *    closed union (lease cycles, epoch advancement, plan successor lineage,
 *    Map/manifest/round progression, question/budget dispositions, attempt
 *    kinds, the system Seal delivery chain, failures and reopen) — asserting
 *    the projection completes, its invariants hold at every prefix, and the
 *    projection digest is a deterministic function of the history.
 * 2. Mutation-based illegal histories: each corruption rule is exercised by
 *    mutating exactly one event (or one blob) of an otherwise legal history
 *    and asserting a structured `ProjectionCorruptionError` carrying the
 *    offending reason/sequence/eventId — never a partial projection.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthoritativeReviewEventV2 } from './authoritative-review-events';
import { validateAuthoritativeReviewEventV2 } from './authoritative-review-events';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';
import {
  ProjectionCorruptionError,
  projectAuthoritativeReviewState,
  projectAuthoritativeReviewStateSync,
  projectionDigestOf,
  type AuthoritativeReviewProjectionV2,
  type BlobObjectResolver,
} from './authoritative-review-state';

const AT = '2026-08-14T00:00:00.000Z';
const HASH = (c: string): string => c.repeat(64);
const NEXT = 'b'.repeat(64);
const TOKEN43 = 'A'.repeat(43);

let seq = 0;

function eventId(label: string): string {
  seq += 1;
  return `evt-${label}-${String(seq).padStart(4, '0')}`;
}

/** Deterministic per-history digests: every ref digest derives from the seed. */
/** Deterministic UUID v4 (the reopen mutation requires UUID operation ids). */
export function uuidFor(seed: string): string {
  const d = digestFor(seed, 0);
  return `${d.slice(0, 8)}-${d.slice(8, 12)}-4${d.slice(13, 16)}-8${d.slice(17, 20)}-${d.slice(20, 32)}`;
}

/** Deterministic digest for one seed/salt. */
export function digestFor(seed: string, salt: number): string {
  const chars = '0123456789abcdef';
  let out = '';
  const source = `${seed}#${salt}`;
  for (let i = 0; i < 64; i += 1) {
    out += chars[source.charCodeAt(i % source.length) % 16];
  }
  return out;
}

export function refFor(kind: string, seed: string, salt: number): BlobRefV2 {
  return {
    kind: kind as BlobRefV2['kind'],
    digest: digestFor(seed, salt),
    byteLength: 12,
    mediaType: 'application/json',
    schemaVersion: 1,
  };
}

let refCounter = 0;

export function makeRef(kind: string): BlobRefV2 {
  refCounter += 1;
  return refFor(kind, 'fixture', refCounter);
}

type AnyEvent = AuthoritativeReviewEventV2;

function ev(input: Record<string, unknown>): AnyEvent {
  return validateAuthoritativeReviewEventV2({
    protocolVersion: 2,
    id: eventId(String(input.type)),
    at: (input.at as string | undefined) ?? AT,
    ...input,
  });
}

/**
 * A deterministic legal-history builder. Every step appends a VALIDATED event;
 * the whole history is legal per the Task 9 projector rules by construction,
 * so any assertion failure in `projectAuthoritativeReviewState` exposes a
 * projector bug rather than a generator bug.
 */
export class LegalHistory {
  readonly events: AuthoritativeReviewEventV2[] = [];

  private workItemCounter = 0;

  private attemptCounter = 0;

  private commandCounter = 0;

  private questionCounter = 0;

  private roundCounter = 0;

  private overrideCounter = 0;

  private planCounter = 0;

  lastAuthorityBaseRef: BlobRefV2;

  constructor(readonly seed: string) {
    this.lastAuthorityBaseRef = makeRef('authority_base_set');
  }

  get sequence(): number {
    return this.events.length;
  }

  push(e: Record<string, unknown>): void {
    this.events.push(ev(e));
  }

  newAuthorityBase(): BlobRefV2 {
    this.lastAuthorityBaseRef = makeRef('authority_base_set');
    return this.lastAuthorityBaseRef;
  }

  ref(kind: string): BlobRefV2 {
    return makeRef(kind);
  }

  /** Creates a fresh agent WorkItem in `ready` state. */
  createAgentWorkItem(options: {
    sessionKind: 'structure_chunk' | 'review_map_batch' | 'review_map_whole' | 'generation_batch' | 'review_content_batch' | 'review_content_whole' | 'map_repair' | 'content_repair';
    logicalAssignmentId: string;
    reviewAssignmentId?: string | null;
    roundId?: string | null;
    grantSpecRef?: BlobRefV2 | null;
    inputArtifactDeliveryId?: string | null;
    initialLeaseEpoch?: number;
    maxAutomaticRetries?: number;
    roleBinding?: string;
  }): { workItemId: string; base: BlobRefV2 } {
    this.workItemCounter += 1;
    const workItemId = `wi-${this.seed}-${this.workItemCounter}`;
    this.push({
      type: 'structured_work_item_created',
      workItemId,
      kind: 'agent_assignment',
      roleBinding: options.roleBinding ?? 'orchestrator',
      agentExecutionKind: 'structured_session',
      sessionKind: options.sessionKind,
      roundId: options.roundId ?? null,
      logicalAssignmentId: options.logicalAssignmentId,
      reviewAssignmentId: options.reviewAssignmentId ?? null,
      grantSpecRef: options.grantSpecRef ?? this.ref('write_grant_spec'),
      inputArtifactDeliveryId: options.inputArtifactDeliveryId ?? null,
      authorityBaseRef: this.newAuthorityBase(),
      payloadRef: this.ref('assignment_dispatch'),
      initialLeaseEpoch: options.initialLeaseEpoch ?? 0,
      maxAutomaticRetries: options.maxAutomaticRetries ?? 2,
    });
    return { workItemId, base: this.lastAuthorityBaseRef };
  }

  /** Creates a generic (submitter) agent WorkItem. */
  createSubmitterWorkItem(inputArtifactDeliveryId: string): { workItemId: string } {
    this.workItemCounter += 1;
    const workItemId = `wi-${this.seed}-${this.workItemCounter}`;
    this.push({
      type: 'structured_work_item_created',
      workItemId,
      kind: 'agent_assignment',
      roleBinding: 'submitter',
      agentExecutionKind: 'generic_turn',
      sessionKind: null,
      roundId: null,
      logicalAssignmentId: `la-${workItemId}`,
      reviewAssignmentId: null,
      grantSpecRef: this.ref('write_grant_spec'),
      inputArtifactDeliveryId,
      authorityBaseRef: this.newAuthorityBase(),
      payloadRef: this.ref('assignment_dispatch'),
      initialLeaseEpoch: 0,
      maxAutomaticRetries: 2,
    });
    return { workItemId };
  }

  createSystemWorkItem(
    kind: 'system_map_finalize' | 'system_generation_finalize' | 'system_repair_finalize' | 'system_migration_validation_batch' | 'system_review_settlement' | 'system_seal',
    options: { maxAutomaticRetries?: number } = {},
  ): { workItemId: string; commandKind: string } {
    this.workItemCounter += 1;
    const workItemId = `wi-${this.seed}-${this.workItemCounter}`;
    const commandKind = kind.replace('system_', '');
    this.push({
      type: 'structured_work_item_created',
      workItemId,
      kind,
      roleBinding: null,
      agentExecutionKind: null,
      sessionKind: null,
      roundId: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      grantSpecRef: null,
      inputArtifactDeliveryId: null,
      authorityBaseRef: this.newAuthorityBase(),
      payloadRef: this.ref(kind === 'system_review_settlement' ? 'content_review_settlement_core' : 'map_build_spec'),
      initialLeaseEpoch: 0,
      maxAutomaticRetries: options.maxAutomaticRetries ?? 2,
    });
    return { workItemId, commandKind };
  }

  lease(workItemId: string, leaseEpoch: number, owner = 'agent-1', expectedLastSequence = 0): void {
    this.push({
      type: 'structured_work_item_leased',
      workItemId,
      leaseEpoch,
      leaseOwner: owner,
      leaseExpiresAt: AT,
      expectedLastSequence,
      authorityBaseRef: this.lastAuthorityBaseRef,
    });
  }

  dispatch(
    workItemId: string,
    attemptId: string,
    logicalAssignmentId: string,
    agentExecutionKind: 'structured_session' | 'generic_turn',
    sessionKind: string | null,
    reviewAssignmentId: string | null,
    inputArtifactDeliveryId: string | null,
  ): void {
    this.push({
      type: 'structured_assignment_dispatched',
      dispatchRef: this.ref('assignment_dispatch'),
      workItemId,
      attemptId,
      logicalAssignmentId,
      reviewAssignmentId,
      agentExecutionKind,
      sessionKind,
      inputArtifactDeliveryId,
      authorityBaseRef: this.lastAuthorityBaseRef,
    });
  }

  attemptStarted(workItemId: string, attemptId: string, logicalAssignmentId: string, sessionKind: string, reviewAssignmentId: string | null, leaseEpoch: number, kind: 'v2' | 'generic', agentId = 'agent-1', deliveryId: string | null = null): void {
    // Envelope order (design §17.2): lease, AssignmentDispatch, attempt start.
    this.push({
      type: 'structured_assignment_dispatched',
      dispatchRef: this.ref('assignment_dispatch'),
      workItemId,
      attemptId,
      logicalAssignmentId,
      reviewAssignmentId,
      agentExecutionKind: kind === 'generic' ? 'generic_turn' : 'structured_session',
      sessionKind: kind === 'generic' ? null : sessionKind,
      inputArtifactDeliveryId: kind === 'generic' ? deliveryId : null,
      authorityBaseRef: this.lastAuthorityBaseRef,
    });
    if (kind === 'generic') {
      this.push({
        type: 'structured_generic_agent_attempt_started',
        attemptId,
        workItemId,
        agentId,
        logicalAssignmentId,
        leaseEpoch,
        inputArtifactDeliveryId: deliveryId as string,
        authorityBaseRef: this.lastAuthorityBaseRef,
      });
      return;
    }
    this.push({
      type: 'structured_agent_attempt_started_v2',
      workItemId,
      logicalAssignmentId,
      reviewAssignmentId,
      attemptId,
      sessionKind: sessionKind as 'structure_chunk',
      leaseEpoch,
      authorityBaseRef: this.lastAuthorityBaseRef,
    });
  }

  attemptCompleted(workItemId: string, attemptId: string, logicalAssignmentId: string, sessionKind: string, reviewAssignmentId: string | null, leaseEpoch: number, kind: 'v2' | 'generic', agentId = 'agent-1', deliveryId: string | null = null): void {
    if (kind === 'generic') {
      this.push({
        type: 'structured_generic_agent_attempt_completed',
        attemptId,
        workItemId,
        agentId,
        logicalAssignmentId,
        leaseEpoch,
        inputArtifactDeliveryId: deliveryId as string,
        authorityBaseRef: this.lastAuthorityBaseRef,
      });
      return;
    }
    this.push({
      type: 'structured_agent_attempt_completed_v2',
      workItemId,
      logicalAssignmentId,
      reviewAssignmentId,
      attemptId,
      sessionKind: sessionKind as 'structure_chunk',
      leaseEpoch,
      authorityBaseRef: this.lastAuthorityBaseRef,
    });
  }

  workItemCompleted(workItemId: string, leaseEpoch: number): void {
    this.push({
      type: 'structured_work_item_completed',
      workItemId,
      leaseEpoch,
      authorityBaseRef: this.lastAuthorityBaseRef,
    });
  }

  /** Full legal lease-execute-complete cycle for one agent workitem. */
  completeAgentCycle(options: {
    workItemId: string;
    logicalAssignmentId: string;
    sessionKind: 'structure_chunk' | 'review_map_batch' | 'review_map_whole' | 'generation_batch' | 'review_content_batch' | 'review_content_whole' | 'map_repair' | 'content_repair';
    reviewAssignmentId?: string | null;
    leaseEpoch: number;
    kind?: 'v2' | 'generic';
    onLease?: () => void;
    onStarted?: () => void;
  }): void {
    const { workItemId, logicalAssignmentId, sessionKind } = options;
    const leaseEpoch = options.leaseEpoch;
    const kind = options.kind ?? 'v2';
    const reviewAssignmentId = options.reviewAssignmentId ?? null;
    this.lease(workItemId, leaseEpoch);
    if (options.onLease) options.onLease();
    this.attemptStarted(workItemId, `att-${workItemId}-${leaseEpoch}`, logicalAssignmentId, sessionKind, reviewAssignmentId, leaseEpoch, kind);
    if (options.onStarted) options.onStarted();
    this.attemptCompleted(workItemId, `att-${workItemId}-${leaseEpoch}`, logicalAssignmentId, sessionKind, reviewAssignmentId, leaseEpoch, kind);
    this.workItemCompleted(workItemId, leaseEpoch);
  }

  /** One map build revision with chunks, finish proposal, finalize and candidate. */
  commitMapBuildRevision(options: { revision: number; chunkCount: number; supersedesMapBuildId?: string | null; activationSettling?: boolean }): {
    mapBuildId: string;
    candidateId: string;
    candidateRef: BlobRefV2;
  } {
    void options.activationSettling;
    this.planCounter += 1;
    const mapBuildId = `mb-${this.seed}-${this.planCounter}`;
    this.push({
      type: 'structured_map_build_started',
      mapBuildId,
      revision: options.revision,
      mapBuildSpecRef: this.ref('map_build_spec'),
      supersedesMapBuildId: options.supersedesMapBuildId ?? null,
      sourceValidationReceiptRef: options.revision > 1 ? this.ref('validation_receipt') : null,
    });
    for (let ordinal = 1; ordinal <= options.chunkCount; ordinal += 1) {
      const { workItemId } = this.createAgentWorkItem({
        sessionKind: 'structure_chunk',
        logicalAssignmentId: `la-${mapBuildId}-${ordinal}`,
      });
      this.completeAgentCycle({
        workItemId,
        logicalAssignmentId: `la-${mapBuildId}-${ordinal}`,
        sessionKind: 'structure_chunk',
        leaseEpoch: 1,
        onStarted: () => {
          this.push({
            type: 'structured_map_chunk_committed',
            mapBuildId,
            chunkId: `chunk-${mapBuildId}-${ordinal}`,
            chunkOrdinal: ordinal,
            chunkRef: this.ref('map_build_chunk'),
            parentFrontierDigest: digestFor(mapBuildId, ordinal),
          });
        },
      });
    }
    const { workItemId: finishWorkItem } = this.createAgentWorkItem({
      sessionKind: 'structure_chunk',
      logicalAssignmentId: `la-${mapBuildId}-finish`,
    });
    this.completeAgentCycle({
      workItemId: finishWorkItem,
      logicalAssignmentId: `la-${mapBuildId}-finish`,
      sessionKind: 'structure_chunk',
      leaseEpoch: 1,
      onStarted: () => {
        this.push({
          type: 'structured_map_build_finish_proposed',
          mapBuildId,
          expectedChunkCount: options.chunkCount,
          expectedFrontierDigest: digestFor(mapBuildId, 0),
          expectedRootCount: 1,
        });
      },
    });
    const { workItemId: finalizeWorkItem, commandKind } = this.createSystemWorkItem('system_map_finalize');
    this.lease(finalizeWorkItem, 1, 'system');
    this.push({
      type: 'structured_system_command_started',
      commandId: `cmd-${finalizeWorkItem}-1`,
      workItemId: finalizeWorkItem,
      commandKind: commandKind as 'map_finalize',
      leaseEpoch: 1,
      authorityBaseRef: this.lastAuthorityBaseRef,
    });
    this.push({
      type: 'structured_map_build_finalized',
      mapBuildId,
      manifestRef: this.ref('map_build_manifest'),
      contributionManifestRef: this.ref('contribution_manifest'),
    });
    this.push({
      type: 'structured_system_command_completed',
      commandId: `cmd-${finalizeWorkItem}-1`,
      workItemId: finalizeWorkItem,
      commandKind: commandKind as 'map_finalize',
      leaseEpoch: 1,
      authorityBaseRef: this.lastAuthorityBaseRef,
    });
    this.workItemCompleted(finalizeWorkItem, 1);
    const candidateRef = this.ref('map_candidate');
    this.push({
      type: 'structured_map_candidate_committed',
      candidateId: `cand-${this.seed}-${this.planCounter}`,
      candidateRef,
      candidateDigest: candidateRef.digest,
      baseMapId: null,
    });
    return { mapBuildId, candidateId: `cand-${this.seed}-${this.planCounter}`, candidateRef };
  }
}

export async function expectCorrupt(
  events: readonly AuthoritativeReviewEventV2[],
  reasonPart: string,
  sequence?: number,
  resolver?: BlobObjectResolver,
): Promise<ProjectionCorruptionError> {
  let error: unknown = null;
  try {
    await projectAuthoritativeReviewState(events, resolver);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ProjectionCorruptionError);
  const corruption = error as ProjectionCorruptionError;
  expect(corruption.reason).toContain(reasonPart);
  if (sequence !== undefined) {
    expect(corruption.sequence).toBe(sequence);
    expect(corruption.eventId).toBe(events[sequence - 1]?.id ?? null);
  }
  return corruption;
}

export async function projectOk(
  events: readonly AuthoritativeReviewEventV2[],
  resolver?: BlobObjectResolver,
): Promise<AuthoritativeReviewProjectionV2> {
  const result = await projectAuthoritativeReviewState(events, resolver);
  if (!result.ok) {
    throw result.error;
  }
  return result.state;
}

afterEach(() => {
  seq = 0;
  refCounter = 0;
});

/* ------------------------------------------------------------------ */
/* Full legal lifecycle builders used by both legal and corrupt tests  */
/* ------------------------------------------------------------------ */

/** Chunk of the sealed lifecycle: map build → pre-review → activation → generation → content review → seal → delivery → submitter. */
export function buildFullLifecycle(seed: string): AuthoritativeReviewEventV2[] {
  const h = new LegalHistory(seed);
  // Initial map build revision 1 with 2 chunks.
  const build = h.commitMapBuildRevision({ revision: 1, chunkCount: 2 });
  // Map pre-review round 1.
  h.push({
    type: 'structured_map_review_round_planned',
    mapReviewRoundId: `mr-${seed}-1`,
    mapCycleOrdinal: 1,
    candidateId: build.candidateId,
    candidateRef: build.candidateRef,
    contentRevisionManifestRef: null,
    reviewPolicyDigest: digestFor('policy', 1),
    coverageNodeCount: 20,
    coverageRelationCount: 3,
    assignmentCount: 2,
    consumedOverrideRef: null,
  });
  for (let i = 1; i <= 2; i += 1) {
    const { workItemId } = h.createAgentWorkItem({
      sessionKind: 'review_map_batch',
      logicalAssignmentId: `la-mr-${i}`,
      reviewAssignmentId: `ra-mr-${i}`,
      roundId: `mr-${seed}-1`,
    });
    h.completeAgentCycle({
      workItemId,
      logicalAssignmentId: `la-mr-${i}`,
      sessionKind: 'review_map_batch',
      reviewAssignmentId: `ra-mr-${i}`,
      leaseEpoch: 1,
      onStarted: () => {
        h.push({
          type: 'structured_map_review_assignment_committed',
          assignmentId: `asg-mr-${i}`,
          mapReviewRoundId: `mr-${seed}-1`,
          workItemId,
          attemptId: `att-${workItemId}-1`,
          reviewAssignmentId: `ra-mr-${i}`,
          source: 'batch',
          ledgerRef: h.ref('review_assignment_ledger'),
          coverageTargetCount: 10,
          findingCount: 0,
        });
      },
    });
  }
  h.push({ type: 'structured_map_review_round_completed', mapReviewRoundId: `mr-${seed}-1`, coverageCoreRef: h.ref('map_review_coverage_core') });
  // Settlement workitem: system_review_settlement.
  const settle = h.createSystemWorkItem('system_review_settlement');
  h.lease(settle.workItemId, 1, 'system');
  h.push({
    type: 'structured_system_command_started',
    commandId: `cmd-${settle.workItemId}-1`,
    workItemId: settle.workItemId,
    commandKind: 'review_settlement',
    leaseEpoch: 1,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.push({
    type: 'structured_map_review_round_settled',
    mapReviewRoundId: `mr-${seed}-1`,
    settlementCoreRef: h.ref('map_review_settlement_core'),
    outcome: 'activate',
  });
  const mapRef = h.ref('map_snapshot');
  const mapReviewBundleRef = h.ref('map_review_bundle');
  h.push({
    type: 'structured_map_activated',
    mapId: `map-${seed}`,
    mapRevision: 1,
    supersedesMapId: null,
    mapSnapshotRef: mapRef,
    mapReviewBundleRef,
    mapSemanticDigest: digestFor('semantic', 1),
    contentRevisionManifestRef: mapRef,
    activationValidatorAggregateRef: h.ref('validator_aggregate'),
    migrationSettlementCoreRef: null,
    migrationActivationDecisionRef: null,
  });
  h.push({
    type: 'structured_content_revision_committed',
    contentRevisionManifestRef: mapRef,
    taskContentRevision: 1,
    manifestPhase: 'baseline_unset',
    producerPlanSpecRef: null,
    priorManifestRef: null,
  });
  h.push({
    type: 'structured_generation_plan_started',
    generationPlanId: `gp-${seed}-1`,
    revision: 1,
    supersedesGenerationPlanId: null,
    generationPlanSpecRef: h.ref('generation_plan_spec'),
    sourceValidationReceiptRef: null,
  });
  h.push({
    type: 'structured_system_command_completed',
    commandId: `cmd-${settle.workItemId}-1`,
    workItemId: settle.workItemId,
    commandKind: 'review_settlement',
    leaseEpoch: 1,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.workItemCompleted(settle.workItemId, 1);
  // One generation batch then finalize.
  const g1 = h.createAgentWorkItem({ sessionKind: 'generation_batch', logicalAssignmentId: 'la-gen-1' });
  const provisionalManifestRef = h.ref('content_revision_manifest');
  h.completeAgentCycle({
    workItemId: g1.workItemId,
    logicalAssignmentId: 'la-gen-1',
    sessionKind: 'generation_batch',
    leaseEpoch: 1,
    onStarted: () => {
      h.push({
        type: 'structured_generation_batch_committed',
        generationPlanId: `gp-${seed}-1`,
        batchOrdinal: 1,
        contentRevisionCommitCoreRef: h.ref('content_revision_commit_core'),
        validatorAggregateRef: h.ref('validator_aggregate'),
        contentRevisionManifestRef: provisionalManifestRef,
      });
      h.push({
        type: 'structured_content_revision_committed',
        contentRevisionManifestRef: provisionalManifestRef,
        taskContentRevision: 2,
        manifestPhase: 'provisional',
        producerPlanSpecRef: h.ref('generation_plan_spec'),
        priorManifestRef: mapRef,
      });
    },
  });
  const genFin = h.createSystemWorkItem('system_generation_finalize');
  h.lease(genFin.workItemId, 1, 'system');
  h.push({
    type: 'structured_system_command_started',
    commandId: `cmd-${genFin.workItemId}-1`,
    workItemId: genFin.workItemId,
    commandKind: 'generation_finalize',
    leaseEpoch: 1,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  const finalManifestRef = h.ref('content_revision_manifest');
  // Envelope order (design §17.5): the domain result (finalized manifest)
  // precedes the command completion and the plan-completed result.
  h.push({
    type: 'structured_content_revision_committed',
    contentRevisionManifestRef: finalManifestRef,
    taskContentRevision: 3,
    manifestPhase: 'finalized',
    producerPlanSpecRef: h.ref('generation_plan_spec'),
    priorManifestRef: provisionalManifestRef,
  });
  h.push({
    type: 'structured_generation_plan_completed',
    generationPlanId: `gp-${seed}-1`,
    contentRevisionManifestRef: finalManifestRef,
    validatorAggregateRef: h.ref('validator_aggregate'),
    warningRootRef: h.ref('validation_warning_root'),
  });
  h.push({
    type: 'structured_system_command_completed',
    commandId: `cmd-${genFin.workItemId}-1`,
    workItemId: genFin.workItemId,
    commandKind: 'generation_finalize',
    leaseEpoch: 1,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.workItemCompleted(genFin.workItemId, 1);
  // Content review cycle: the settlement command plans the round and
  // completes; review workitems run afterwards (single active lease).
  const settle2 = h.createSystemWorkItem('system_review_settlement');
  h.lease(settle2.workItemId, 1, 'system');
  h.push({
    type: 'structured_system_command_started',
    commandId: `cmd-${settle2.workItemId}-1`,
    workItemId: settle2.workItemId,
    commandKind: 'review_settlement',
    leaseEpoch: 1,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.push({
    type: 'structured_review_round_planned',
    reviewRoundId: `cr-${seed}-1`,
    contentCycleOrdinal: 1,
    mapRef,
    mapSemanticDigest: digestFor('semantic', 1),
    contentRevisionManifestRef: finalManifestRef,
    reviewPolicyDigest: digestFor('policy', 1),
    adoptionRootRef: h.ref('review_adoption_root'),
    coverageSlotCount: 40,
    coverageRelationCount: 3,
    assignmentCount: 2,
    verificationFindingCount: 0,
    consumedOverrideRef: null,
  });
  h.push({
    type: 'structured_system_command_completed',
    commandId: `cmd-${settle2.workItemId}-1`,
    workItemId: settle2.workItemId,
    commandKind: 'review_settlement',
    leaseEpoch: 1,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.workItemCompleted(settle2.workItemId, 1);
  for (let i = 1; i <= 2; i += 1) {
    const rw = h.createAgentWorkItem({
      sessionKind: 'review_content_batch',
      logicalAssignmentId: `la-cr-${i}`,
      reviewAssignmentId: `ra-cr-${i}`,
      roundId: `cr-${seed}-1`,
    });
    const assignmentLedgerRef = h.ref('review_assignment_ledger');
    h.completeAgentCycle({
      workItemId: rw.workItemId,
      logicalAssignmentId: `la-cr-${i}`,
      sessionKind: 'review_content_batch',
      reviewAssignmentId: `ra-cr-${i}`,
      leaseEpoch: 1,
      onStarted: () => {
          h.push({
            type: 'structured_review_assignment_started',
            assignmentId: `asg-cr-${i}`,
            reviewRoundId: `cr-${seed}-1`,
            workItemId: rw.workItemId,
            attemptId: `att-${rw.workItemId}-1`,
            reviewAssignmentId: `ra-cr-${i}`,
            source: 'batch',
          });
          h.push({
            type: 'structured_content_review_assignment_committed',
            assignmentId: `asg-cr-${i}`,
            reviewRoundId: `cr-${seed}-1`,
            workItemId: rw.workItemId,
            attemptId: `att-${rw.workItemId}-1`,
            reviewAssignmentId: `ra-cr-${i}`,
            source: 'batch',
            ledgerRef: assignmentLedgerRef,
            coverageTargetCount: 20,
            findingCount: 0,
          });
          // F1: the assignment completion freezes the ledger blob.
          h.push({
            type: 'structured_review_assignment_completed',
            assignmentId: `asg-cr-${i}`,
            reviewRoundId: `cr-${seed}-1`,
            workItemId: rw.workItemId,
            attemptId: `att-${rw.workItemId}-1`,
            ledgerRef: assignmentLedgerRef,
            source: 'batch',
          });
        },
    });
  }
  h.push({ type: 'structured_review_round_completed', reviewRoundId: `cr-${seed}-1`, coverageCoreRef: h.ref('content_review_coverage_core') });
  // The round settlement is a NEW settlement command.
  const settle3 = h.createSystemWorkItem('system_review_settlement');
  h.lease(settle3.workItemId, 1, 'system');
  h.push({
    type: 'structured_system_command_started',
    commandId: `cmd-${settle3.workItemId}-1`,
    workItemId: settle3.workItemId,
    commandKind: 'review_settlement',
    leaseEpoch: 1,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.push({
    type: 'structured_review_round_settled',
    reviewRoundId: `cr-${seed}-1`,
    settlementCoreRef: h.ref('content_review_settlement_core'),
    outcome: 'seal',
  });
  h.push({
    type: 'structured_system_command_completed',
    commandId: `cmd-${settle3.workItemId}-1`,
    workItemId: settle3.workItemId,
    commandKind: 'review_settlement',
    leaseEpoch: 1,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.workItemCompleted(settle3.workItemId, 1);
  // Seal: scaffold_sealed → artifact published → delivery → submitter.
  const seal = h.createSystemWorkItem('system_seal');
  h.lease(seal.workItemId, 1, 'system');
  h.push({
    type: 'structured_system_command_started',
    commandId: `cmd-${seal.workItemId}-1`,
    workItemId: seal.workItemId,
    commandKind: 'seal',
    leaseEpoch: 1,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  const sealRecordRef = h.ref('seal_record');
  const artifactRef = h.ref('artifact');
  const custodyRef = h.ref('seal_validation_bundle');
  const sealValidationBundleRef = h.ref('seal_validation_bundle');
  h.push({
    type: 'structured_scaffold_sealed_v2',
    sealWorkItemId: seal.workItemId,
    sealRecordRef,
    sealValidationBundleRef,
    mapRef,
    contentRevisionManifestRef: finalManifestRef,
    reviewBundleRef: h.ref('review_bundle'),
    artifactRef,
  });
  const deliveryRef = h.ref('system_artifact_delivery');
  h.push({
    type: 'artifact_published_v2',
    artifactId: `artifact-${seed}`,
    artifactVersion: 1,
    deliveryRef,
    files: [{ name: 'chapter.md', hash: digestFor('file', 1) }],
    mediaType: 'text/markdown',
    provenance: {
      producerKind: 'system',
      producerWorkItemId: seal.workItemId,
      sealRecordRef,
      artifactRef,
      custodyRef,
    },
  });
  h.push({
    type: 'structured_system_artifact_delivery_created',
    deliveryId: `dl-${seed}`,
    deliveryRef,
    artifactId: `artifact-${seed}`,
    artifactRef,
    sealRecordRef,
    submitterWorkItemId: `wi-${seed}-submitter`,
  });
  h.push({
    type: 'structured_system_command_completed',
    commandId: `cmd-${seal.workItemId}-1`,
    workItemId: seal.workItemId,
    commandKind: 'seal',
    leaseEpoch: 1,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.workItemCompleted(seal.workItemId, 1);
  // The submitter workitem id is pre-declared by the delivery event.
  h.push({
    type: 'structured_work_item_created',
    workItemId: `wi-${seed}-submitter`,
    kind: 'agent_assignment',
    roleBinding: 'submitter',
    agentExecutionKind: 'generic_turn',
    sessionKind: null,
    roundId: null,
    logicalAssignmentId: `la-${seed}-submitter`,
    reviewAssignmentId: null,
    grantSpecRef: h.ref('write_grant_spec'),
    inputArtifactDeliveryId: `dl-${seed}`,
    authorityBaseRef: h.lastAuthorityBaseRef,
    payloadRef: h.ref('assignment_dispatch'),
    initialLeaseEpoch: 0,
    maxAutomaticRetries: 2,
  });
  h.lease(`wi-${seed}-submitter`, 1, 'submitter-1');
  h.attemptStarted(`wi-${seed}-submitter`, `att-${seed}-submitter-1`, `la-${seed}-submitter`, 'submitter', null, 1, 'generic', 'submitter-1', `dl-${seed}`);
  h.attemptCompleted(`wi-${seed}-submitter`, `att-${seed}-submitter-1`, `la-${seed}-submitter`, 'submitter', null, 1, 'generic', 'submitter-1', `dl-${seed}`);
  h.workItemCompleted(`wi-${seed}-submitter`, 1);
  return h.events;
}

/** A fresh legal history with an injected retry/reclaim cycle in chunk 2's workitem slot. */
function buildWithRetryCycle(seed: string, mode: 'retry' | 'reclaim' | 'expiry-reclaim'): AuthoritativeReviewEventV2[] {
  const h = new LegalHistory(seed);
  const { workItemId } = h.createAgentWorkItem({ sessionKind: 'structure_chunk', logicalAssignmentId: `la-${seed}-retry` });
  h.lease(workItemId, 1);
  h.attemptStarted(workItemId, `att-${workItemId}-1`, `la-${seed}-retry`, 'structure_chunk', null, 1, 'v2');
  if (mode === 'retry') {
    h.push({
      type: 'structured_agent_attempt_retryable_failed_v2',
      workItemId,
      logicalAssignmentId: `la-${seed}-retry`,
      reviewAssignmentId: null,
      attemptId: `att-${workItemId}-1`,
      sessionKind: 'structure_chunk',
      leaseEpoch: 1,
      failureCode: 'HANDLER_FAILED',
      failureDigest: digestFor('fail', 1),
      retryOrdinal: 1,
      retryNotBefore: AT,
      validatorAggregateRef: null,
      authorityBaseRef: h.lastAuthorityBaseRef,
    });
    h.push({
      type: 'structured_work_item_retryable_failed',
      workItemId,
      leaseEpoch: 1,
      failureCode: 'HANDLER_FAILED',
      failureDigest: digestFor('fail', 1),
      retryOrdinal: 1,
      retryNotBefore: AT,
      maxAutomaticRetries: 2,
      validatorAggregateRef: null,
      authorityBaseRef: h.lastAuthorityBaseRef,
    });
    h.push({
      type: 'structured_work_item_requeued',
      workItemId,
      leaseEpoch: 1,
      expectedLastSequence: 0,
      authorityBaseRef: h.lastAuthorityBaseRef,
    });
    h.lease(workItemId, 2);
    h.attemptStarted(workItemId, `att-${workItemId}-2`, `la-${seed}-retry`, 'structure_chunk', null, 2, 'v2');
    h.attemptCompleted(workItemId, `att-${workItemId}-2`, `la-${seed}-retry`, 'structure_chunk', null, 2, 'v2');
    h.workItemCompleted(workItemId, 2);
    return h.events;
  }
  h.push({
    type: 'structured_agent_attempt_abandoned_v2',
    workItemId,
    logicalAssignmentId: `la-${seed}-retry`,
    reviewAssignmentId: null,
    attemptId: `att-${workItemId}-1`,
    sessionKind: 'structure_chunk',
    leaseEpoch: 1,
    reason: mode === 'expiry-reclaim' ? 'lease_expired' : 'crash_recovery',
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.push({
    type: 'structured_work_item_lease_reclaimed',
    workItemId,
    leaseEpoch: 1,
    reason: mode === 'expiry-reclaim' ? 'lease_expired' : 'crash_recovery',
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  // Reclaim advances the workitem to ready(2); the next lease strictly
  // advances again (lease epoch rule: current + 1).
  h.lease(workItemId, 3);
  h.attemptStarted(workItemId, `att-${workItemId}-3`, `la-${seed}-retry`, 'structure_chunk', null, 3, 'v2');
  h.attemptCompleted(workItemId, `att-${workItemId}-3`, `la-${seed}-retry`, 'structure_chunk', null, 3, 'v2');
  h.workItemCompleted(workItemId, 3);
  return h.events;
}

/** A legal budget-exhaustion → manual retry history (maxAutomaticRetries=1). */
export function buildBudgetFlow(seed: string): AuthoritativeReviewEventV2[] {
  const h = new LegalHistory(seed);
  const { workItemId } = h.createAgentWorkItem({ sessionKind: 'structure_chunk', logicalAssignmentId: `la-${seed}-budget`, maxAutomaticRetries: 1 });
  h.lease(workItemId, 1);
  h.attemptStarted(workItemId, `att-${workItemId}-1`, `la-${seed}-budget`, 'structure_chunk', null, 1, 'v2');
  h.push({
    type: 'structured_agent_attempt_retryable_failed_v2',
    workItemId,
    logicalAssignmentId: `la-${seed}-budget`,
    reviewAssignmentId: null,
    attemptId: `att-${workItemId}-1`,
    sessionKind: 'structure_chunk',
    leaseEpoch: 1,
    failureCode: 'HANDLER_FAILED',
    failureDigest: digestFor('fail', 1),
    retryOrdinal: 1,
    retryNotBefore: AT,
    validatorAggregateRef: null,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.push({
    type: 'structured_work_item_retryable_failed',
    workItemId,
    leaseEpoch: 1,
    failureCode: 'HANDLER_FAILED',
    failureDigest: digestFor('fail', 1),
    retryOrdinal: 1,
    retryNotBefore: AT,
    maxAutomaticRetries: 1,
    validatorAggregateRef: null,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.push({
    type: 'structured_work_item_requeued',
    workItemId,
    leaseEpoch: 1,
    expectedLastSequence: 0,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.lease(workItemId, 2);
  h.attemptStarted(workItemId, `att-${workItemId}-2`, `la-${seed}-budget`, 'structure_chunk', null, 2, 'v2');
  // Second failure exhausted the budget: park (orchestrated by the coordinator).
  h.push({
    type: 'structured_agent_attempt_terminal_failed_v2',
    workItemId,
    logicalAssignmentId: `la-${seed}-budget`,
    reviewAssignmentId: null,
    attemptId: `att-${workItemId}-2`,
    sessionKind: 'structure_chunk',
    leaseEpoch: 2,
    failureCode: 'BUDGET_EXHAUSTED',
    failureDigest: digestFor('fail', 2),
    validatorAggregateRef: null,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.push({
    type: 'structured_work_item_parked',
    workItemId,
    leaseEpoch: 2,
    parkDisposition: { kind: 'retry_budget_exhausted', retryOrdinal: 2, budgetPolicyDigest: digestFor('budget', 1) },
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.push({
    type: 'structured_task_retry_resumed_v2',
    workItemId,
    leaseEpoch: 3,
    expectedLastSequence: 0,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.lease(workItemId, 4);
  h.attemptStarted(workItemId, `att-${workItemId}-4`, `la-${seed}-budget`, 'structure_chunk', null, 4, 'v2');
  h.attemptCompleted(workItemId, `att-${workItemId}-4`, `la-${seed}-budget`, 'structure_chunk', null, 4, 'v2');
  h.workItemCompleted(workItemId, 4);
  return h.events;
}

/** A legal human-question flow: open → park → answer → supersede → replacement. */
export function buildQuestionFlow(seed: string): AuthoritativeReviewEventV2[] {
  const h = new LegalHistory(seed);
  const { workItemId } = h.createAgentWorkItem({ sessionKind: 'structure_chunk', logicalAssignmentId: `la-${seed}-q`, maxAutomaticRetries: 2 });
  h.lease(workItemId, 1, 'agent-1');
  h.attemptStarted(workItemId, `att-${workItemId}-1`, `la-${seed}-q`, 'structure_chunk', null, 1, 'v2', 'agent-1');
  const questionId = `q-${seed}`;
  h.push({
    type: 'structured_human_question_opened_v2',
    questionId,
    questionVersion: TOKEN43,
    questionDigest: digestFor('question', 1),
    originalWorkItemId: workItemId,
    attemptId: `att-${workItemId}-1`,
    leaseEpoch: 1,
    logicalAssignmentId: `la-${seed}-q`,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.push({
    type: 'structured_agent_attempt_abandoned_v2',
    workItemId,
    logicalAssignmentId: `la-${seed}-q`,
    reviewAssignmentId: null,
    attemptId: `att-${workItemId}-1`,
    sessionKind: 'structure_chunk',
    leaseEpoch: 1,
    reason: 'user_stop',
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.push({
    type: 'structured_work_item_parked',
    workItemId,
    leaseEpoch: 1,
    parkDisposition: { kind: 'human_question', questionId, questionVersion: TOKEN43 },
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  // Answer consumes the question; the replacement workitem is created after the supersede.
  h.push({
    type: 'structured_human_answer_delivered_v2',
    deliveryId: `del-${seed}`,
    questionId,
    questionVersion: TOKEN43,
    originalWorkItemId: workItemId,
    replacementWorkItemId: `wi-${seed}-replacement`,
    logicalAssignmentId: `la-${seed}-q`,
    answerDigest: digestFor('answer', 1),
    operationId: `op-answer-${seed}`,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.push({
    type: 'structured_work_item_superseded',
    workItemId,
    leaseEpoch: 1,
    reason: 'human_disposition',
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.push({
    type: 'structured_work_item_created',
    workItemId: `wi-${seed}-replacement`,
    kind: 'agent_assignment',
    roleBinding: 'orchestrator',
    agentExecutionKind: 'structured_session',
    sessionKind: 'structure_chunk',
    roundId: null,
    logicalAssignmentId: `la-${seed}-replacement`,
    reviewAssignmentId: null,
    grantSpecRef: h.ref('write_grant_spec'),
    inputArtifactDeliveryId: null,
    authorityBaseRef: h.lastAuthorityBaseRef,
    payloadRef: h.ref('assignment_dispatch'),
    initialLeaseEpoch: 0,
    maxAutomaticRetries: 2,
  });
  h.lease(`wi-${seed}-replacement`, 1);
  h.attemptStarted(`wi-${seed}-replacement`, `att-${seed}-replacement-1`, `la-${seed}-replacement`, 'structure_chunk', null, 1, 'v2');
  h.attemptCompleted(`wi-${seed}-replacement`, `att-${seed}-replacement-1`, `la-${seed}-replacement`, 'structure_chunk', null, 1, 'v2');
  h.workItemCompleted(`wi-${seed}-replacement`, 1);
  return h.events;
}

/**
 * A legal round-limit failure + reopen + override consumption history.
 * Returns the events plus the blob fixtures the resolver must serve
 * (failure recovery payload + available round budget override).
 */
function buildReopenOverrideFlow(seed: string, track: 'map' | 'content'): {
  events: AuthoritativeReviewEventV2[];
  fixtures: Record<string, unknown>;
} {
  const h = new LegalHistory(seed);
  let roundTarget: { candidateId: string; candidateRef: BlobRefV2 } | null = null;
  let baselineManifestRef: BlobRefV2 | null = null;
  let activeMapRef: BlobRefV2 | null = null;
  if (track === 'map') {
    roundTarget = h.commitMapBuildRevision({ revision: 1, chunkCount: 1 });
  } else {
    // A content round requires a current activated Map (generation only runs
    // after activation), so the content track first runs the legal map cycle.
    roundTarget = h.commitMapBuildRevision({ revision: 1, chunkCount: 1 });
    h.push({
      type: 'structured_map_review_round_planned',
      mapReviewRoundId: `mr-${seed}-0`,
      mapCycleOrdinal: 1,
      candidateId: roundTarget.candidateId,
      candidateRef: roundTarget.candidateRef,
      contentRevisionManifestRef: null,
      reviewPolicyDigest: digestFor('policy', 1),
      coverageNodeCount: 1,
      coverageRelationCount: 0,
      assignmentCount: 1,
      consumedOverrideRef: null,
    });
    const rw0 = h.createAgentWorkItem({ sessionKind: 'review_map_batch', logicalAssignmentId: `la-${seed}-mr0`, reviewAssignmentId: `ra-${seed}-mr0`, roundId: `mr-${seed}-0` });
    h.completeAgentCycle({
      workItemId: rw0.workItemId,
      logicalAssignmentId: `la-${seed}-mr0`,
      sessionKind: 'review_map_batch',
      reviewAssignmentId: `ra-${seed}-mr0`,
      leaseEpoch: 1,
      onStarted: () => {
        h.push({
          type: 'structured_map_review_assignment_committed',
          assignmentId: `asg-${seed}-mr0`,
          mapReviewRoundId: `mr-${seed}-0`,
          workItemId: rw0.workItemId,
          attemptId: `att-${rw0.workItemId}-1`,
          reviewAssignmentId: `ra-${seed}-mr0`,
          source: 'batch',
          ledgerRef: h.ref('review_assignment_ledger'),
          coverageTargetCount: 1,
          findingCount: 0,
        });
      },
    });
    h.push({ type: 'structured_map_review_round_completed', mapReviewRoundId: `mr-${seed}-0`, coverageCoreRef: h.ref('map_review_coverage_core') });
    const settle0 = h.createSystemWorkItem('system_review_settlement');
    h.lease(settle0.workItemId, 1, 'system');
    h.push({ type: 'structured_system_command_started', commandId: `cmd-${settle0.workItemId}-1`, workItemId: settle0.workItemId, commandKind: 'review_settlement', leaseEpoch: 1, authorityBaseRef: h.lastAuthorityBaseRef });
    h.push({ type: 'structured_map_review_round_settled', mapReviewRoundId: `mr-${seed}-0`, settlementCoreRef: h.ref('map_review_settlement_core'), outcome: 'activate' });
    activeMapRef = h.ref('map_snapshot');
    const manifestRef = h.ref('content_revision_manifest');
    baselineManifestRef = manifestRef;
    h.push({
      type: 'structured_map_activated',
      mapId: `map-${seed}`,
      mapRevision: 1,
      supersedesMapId: null,
      mapSnapshotRef: activeMapRef,
      mapReviewBundleRef: h.ref('map_review_bundle'),
      mapSemanticDigest: digestFor('semantic', 1),
      contentRevisionManifestRef: manifestRef,
      activationValidatorAggregateRef: h.ref('validator_aggregate'),
      migrationSettlementCoreRef: null,
      migrationActivationDecisionRef: null,
    });
    h.push({ type: 'structured_system_command_completed', commandId: `cmd-${settle0.workItemId}-1`, workItemId: settle0.workItemId, commandKind: 'review_settlement', leaseEpoch: 1, authorityBaseRef: h.lastAuthorityBaseRef });
    h.workItemCompleted(settle0.workItemId, 1);
    h.push({
      type: 'structured_content_revision_committed',
      contentRevisionManifestRef: manifestRef,
      taskContentRevision: 1,
      manifestPhase: 'baseline_unset',
      producerPlanSpecRef: null,
      priorManifestRef: null,
    });
  }
  // Failed settlement workitem terminal-fails with REVIEW_REPAIR_LIMIT_EXCEEDED.
  const settle = h.createSystemWorkItem('system_review_settlement');
  h.lease(settle.workItemId, 1, 'system');
  h.push({
    type: 'structured_system_command_started',
    commandId: `cmd-${settle.workItemId}-1`,
    workItemId: settle.workItemId,
    commandKind: 'review_settlement',
    leaseEpoch: 1,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.push({
    type: 'structured_system_command_terminal_failed',
    commandId: `cmd-${settle.workItemId}-1`,
    workItemId: settle.workItemId,
    commandKind: 'review_settlement',
    leaseEpoch: 1,
    failureCode: 'REVIEW_REPAIR_LIMIT_EXCEEDED',
    failureDigest: digestFor('fail', 1),
    validatorAggregateRef: h.ref('validator_aggregate'),
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  h.push({
    type: 'structured_work_item_terminal_failed',
    workItemId: settle.workItemId,
    leaseEpoch: 1,
    failureCode: 'REVIEW_REPAIR_LIMIT_EXCEEDED',
    failureDigest: digestFor('fail', 1),
    terminalAttemptId: null,
    terminalCommandId: `cmd-${settle.workItemId}-1`,
    validatorAggregateRef: h.ref('validator_aggregate'),
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  const terminalEvent = h.events[h.events.length - 1];
  const base = h.lastAuthorityBaseRef;
  const rejectedSubjectRef = track === 'map' ? h.ref('map_candidate') : h.ref('content_revision_manifest');
  const findingSetRef = h.ref('finding_set');
  const overrideRef = h.ref('round_budget_override');
  const payloadRef = h.ref('failure_recovery_payload');
  h.push({
    type: 'structured_task_failed_v2',
    workItemId: settle.workItemId,
    attemptId: null,
    commandId: `cmd-${settle.workItemId}-1`,
    leaseEpoch: 1,
    failureCode: 'REVIEW_REPAIR_LIMIT_EXCEEDED',
    failureDigest: digestFor('fail', 1),
    failureRecoveryPayloadRef: payloadRef,
    authorityBaseRef: h.lastAuthorityBaseRef,
  });
  const failedEventId = h.events[h.events.length - 1].id;
  const reopenOperationId = uuidFor(seed);
  h.push({
    type: 'structured_task_reopened_v2',
    expectedLastSequence: h.sequence,
    operationId: reopenOperationId,
    operatorId: 'task_owner',
    reason: 'reopen',
    recipeKey: track === 'map' ? 'restart_map_review_cycle' : 'restart_content_review_cycle',
    track,
    failureRecoveryPayloadRef: payloadRef,
    overrideRef,
  });
  // Replacement repair workitem (the reopen policy table successor).
  h.createAgentWorkItem({
    sessionKind: track === 'map' ? 'map_repair' : 'content_repair',
    logicalAssignmentId: `la-${seed}-repair`,
    grantSpecRef: h.ref('write_grant_spec'),
  });
  // The round-created event consumes the override.
  const roundId = track === 'map' ? `mr-${seed}-2` : `cr-${seed}-2`;
  if (track === 'map') {
    h.push({
      type: 'structured_map_review_round_planned',
      mapReviewRoundId: roundId,
      mapCycleOrdinal: 1,
      candidateId: roundTarget?.candidateId as string,
      candidateRef: roundTarget?.candidateRef as BlobRefV2,
      contentRevisionManifestRef: null,
      reviewPolicyDigest: digestFor('policy', 1),
      coverageNodeCount: 5,
      coverageRelationCount: 0,
      assignmentCount: 1,
      consumedOverrideRef: overrideRef,
    });
  } else {
    h.push({
      type: 'structured_review_round_planned',
      reviewRoundId: roundId,
      contentCycleOrdinal: 1,
      mapRef: activeMapRef as BlobRefV2,
      mapSemanticDigest: digestFor('semantic', 1),
      contentRevisionManifestRef: (baselineManifestRef as BlobRefV2),
      reviewPolicyDigest: digestFor('policy', 1),
      adoptionRootRef: h.ref('review_adoption_root'),
      coverageSlotCount: 5,
      coverageRelationCount: 0,
      assignmentCount: 1,
      verificationFindingCount: 0,
      consumedOverrideRef: overrideRef,
    });
  }
  const fixtures: Record<string, unknown> = {
    [payloadRef.digest]: {
      kind: 'restart_review_cycle',
      track,
      failedWorkItemId: settle.workItemId,
      failedAttemptOrCommandId: `cmd-${settle.workItemId}-1`,
      failedLeaseEpoch: 1,
      terminalEventId: terminalEvent.id,
      terminalCommitId: 'commit-any',
      authorityBaseRef: base,
      rejectedSubjectRef,
      findingSetRef,
      failedCycleOrdinal: 1,
    },
    [overrideRef.digest]: {
      overrideId: `override-${seed}`,
      failedEventId: failedEventId,
      track,
      repairLineageId: `lineage-${seed}`,
      initialRepairPlanRef: h.ref('repair_plan_spec'),
      currentAuthorizedRepairPlanRef: h.ref('repair_plan_spec'),
      predecessorOverrideRef: null,
      transferOrdinal: 1,
      operationId: reopenOperationId,
      operatorId: 'task_owner',
      reasonDigest: digestFor('reason', 1),
      state: 'available',
    },
  };
  return { events: h.events, fixtures };
}

/** A helper resolver serving fixture blobs by digest (fail-closed on misses). */
function fixtureResolver(fixtures: Record<string, unknown>, kinds: Record<string, string> = {}): BlobObjectResolver {
  return async (ref: BlobRefV2): Promise<unknown> => {
    const value = fixtures[ref.digest];
    if (value === undefined) {
      const expectedKind = kinds[ref.digest];
      if (expectedKind !== undefined && expectedKind !== ref.kind) {
        throw new Error(`fixture kind mismatch for ${ref.digest}`);
      }
      throw new Error(`missing fixture blob ${ref.digest.slice(0, 12)}`);
    }
    return value;
  };
}
describe('projectAuthoritativeReviewState — legal histories', () => {
  it('projects the full lifecycle to completion with single-lease and sealed chain invariants', async () => {
    const events = buildFullLifecycle('full');
    expect(events.length).toBeGreaterThan(40);
    const state = await projectOk(events);
    // Single active lease at the end: none (the submitter completed).
    expect(state.activeLease).toBeNull();
    expect(state.taskStatus).toBe('completed');
    expect(state.currentSeal).not.toBeNull();
    expect(state.publishedArtifact).not.toBeNull();
    expect(state.publishedArtifact?.artifactVersion).toBe(1);
    expect(state.mapCycleOrdinal).toBe(1);
    expect(state.contentCycleOrdinal).toBe(1);
    expect(state.mapRounds['mr-full-1'].state).toBe('settled');
    expect(state.contentRounds['cr-full-1'].state).toBe('settled');
    // Every workitem ended in a terminal state.
    for (const wi of Object.values(state.workItems)) {
      expect(['completed', 'terminal_failed', 'superseded']).toContain(wi.state);
    }
    // The system delivery chain is closed end-to-end.
    expect(state.delivery).not.toBeNull();
    expect(state.delivery?.submitterWorkItemId).toBe('wi-full-submitter');
    expect(state.delivery?.artifactRef.digest).toBe(state.publishedArtifact?.artifactRef.digest);
  });

  it('projects a retryable-failure requeue cycle with strict epoch ordering', async () => {
    const events = buildWithRetryCycle('retry', 'retry');
    const state = await projectOk(events);
    const wi = state.workItems[Object.keys(state.workItems)[0] ?? ''];
    expect(wi).toMatchObject({ state: 'completed', leaseEpoch: 2, retryOrdinal: 1 });
    expect(state.activeLease).toBeNull();
  });

  it('projects both reclaim flavours with epoch advancement', async () => {
    for (const mode of ['reclaim', 'expiry-reclaim'] as const) {
      const state = await projectOk(buildWithRetryCycle(`reclaim-${mode}`, mode));
      const wi = state.workItems[Object.keys(state.workItems)[0] ?? ''];
      expect(wi).toMatchObject({ state: 'completed', leaseEpoch: 3 });
    }
  });

  it('projects budget exhaustion park + manual retry resume (single budget disposition)', async () => {
    const events = buildBudgetFlow('budget');
    const state = await projectOk(events);
    const wi = state.workItems[Object.keys(state.workItems)[0] ?? ''];
    expect(wi).toMatchObject({ state: 'completed', leaseEpoch: 4, retryOrdinal: 0 });
    expect(state.retryBudgetExhaustedWorkItemId).toBeNull();
    const prefix = events.slice(0, events.findIndex((e) => e.type === 'structured_task_retry_resumed_v2'));
    const parked = await projectOk(prefix);
    expect(parked.retryBudgetExhaustedWorkItemId).toBe(wi.workItemId);
    expect(parked.taskStatus).toBe('retryable_failure');
  });

  it('projects the human-question flow with pending question transitions', async () => {
    const events = buildQuestionFlow('q');
    const openedAt = events.findIndex((e) => e.type === 'structured_human_question_opened_v2');
    const parkAt = events.findIndex((e) => e.type === 'structured_work_item_parked');
    const pending = await projectOk(events.slice(0, openedAt + 1));
    expect(pending.pendingQuestion?.questionId).toBe('q-q');
    expect(pending.taskStatus).toBe('waiting_human');
    const parked = await projectOk(events.slice(0, parkAt + 1));
    expect(parked.pendingQuestion?.questionId).toBe('q-q');
    expect(parked.workItems[Object.keys(parked.workItems)[0] ?? '']?.state).toBe('parked');
    const finalState = await projectOk(events);
    expect(finalState.pendingQuestion).toBeNull();
    expect(finalState.workItems['wi-q-replacement']).toMatchObject({ state: 'completed' });
  });

  it('rejects second-question and answer-without-replacement histories as corrupt', async () => {
    const events = buildQuestionFlow('q2');
    // Second question while one is pending.
    const inserted = events.slice();
    const openedIndex = events.findIndex((e) => e.type === 'structured_human_question_opened_v2');
    const opened = events[openedIndex];
    const second = validateAuthoritativeReviewEventV2({
      ...(opened as unknown as Record<string, unknown>),
      type: 'structured_human_question_opened_v2',
      id: 'evt-second-question-1',
      questionId: 'q-other',
      questionDigest: 'c'.repeat(64),
    });
    // The workitem is still leased right after the first opened event, so the
    // second-question invariant fires before any question_epoch rule.
    inserted.splice(openedIndex + 1, 0, second);
    await expectCorrupt(inserted, 'second_question');
    // Drop the replacement-workitem creation (and everything after it): the
    // consumed question must have a replacement by the end of projection.
    const replacementIndex = events.findIndex((e) => e.type === 'structured_work_item_created' && e.workItemId === 'wi-q2-replacement');
    const missing = events.slice(0, replacementIndex);
    await expectCorrupt(missing, 'replacement_missing');
  });

  it('projects the failure + reopen + round-budget-override consumption flow legally', async () => {
    for (const track of ['map', 'content'] as const) {
      const { events, fixtures } = buildReopenOverrideFlow(`reopen-${track}`, track);
      const resolver = fixtureResolver(fixtures);
      const state = await projectOk(events, resolver);
      expect(state.taskStatus).toBe('running');
      // The reopen consumed the failed state; the override was consumed by the round.
      expect(state.failed).toBeNull();
      expect(state.availableOverride).toBeNull();
      expect(state.consumedOverrideRefs).toHaveLength(1);
      expect(state[track === 'map' ? 'mapCycleOrdinal' : 'contentCycleOrdinal']).toBe(1);
    }
  });

  it('is deterministic: identical histories produce identical projection digests', async () => {
    for (const builder of [
      () => buildFullLifecycle('det-1'),
      () => buildBudgetFlow('det-2'),
      () => buildQuestionFlow('det-3'),
    ]) {
      const events = builder();
      const first = await projectOk(events);
      const second = await projectOk(events);
      expect(projectionDigestOf(first)).toBe(projectionDigestOf(second));
      expect(projectionDigestOf(first)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('stays invariant-across-prefixes: every legal prefix keeps a single lease and one question', async () => {
    const events = buildFullLifecycle('prefix');
    for (let cut = 1; cut <= events.length; cut += 1) {
      const prefix = events.slice(0, cut);
      let state: AuthoritativeReviewProjectionV2 | null = null;
      try {
        state = await projectOk(prefix);
      } catch (error) {
        // Mid-envelope windows where a successor binding is deferred are legal
        // until the end of projection; the end-of-projection obligations fire
        // only there — never on the folded prefix state.
        const reason = (error as ProjectionCorruptionError).reason;
        expect(['replacement_missing', 'submitter_workitem_missing', 'reopen_replacement_missing']).toContain(reason);
        continue;
      }
      expect(state).not.toBeNull();
      const leased = Object.values(state as AuthoritativeReviewProjectionV2).length === 0 ? [] : Object.values((state as AuthoritativeReviewProjectionV2).workItems).filter((w) => w.state === 'leased');
      expect(leased.length).toBeLessThanOrEqual(1);
      expect((state as AuthoritativeReviewProjectionV2).pendingQuestion).toBeNull();
    }
  });
});

/**
 * A minimal legal preamble: one created workitem + one lease (module scope,
 * shared by the corruption and fix-round suites).
 */
export function preamble(seed: string): { h: LegalHistory; workItemId: string } {
  const h = new LegalHistory(seed);
  const { workItemId } = h.createAgentWorkItem({ sessionKind: 'structure_chunk', logicalAssignmentId: `la-${seed}-p` });
  h.lease(workItemId, 1);
  return { h, workItemId };
}

describe('projectAuthoritativeReviewState — corrupt diagnostics', () => {

  it('rejects a second lease while one is active (single active lease)', async () => {
    const { h, workItemId } = preamble('l2');
    void workItemId;
    const other = h.createAgentWorkItem({ sessionKind: 'structure_chunk', logicalAssignmentId: 'la-l2-other' });
    h.lease(other.workItemId, 1);
    await expectCorrupt(h.events, 'active_lease', h.events.length);
  });

  it('rejects lease of a non-ready workitem and non-advancing epochs', async () => {
    const { h, workItemId } = preamble('le');
    h.attemptStarted(workItemId, `att-${workItemId}-1`, `la-le-p`, 'structure_chunk', null, 1, 'v2');
    h.attemptCompleted(workItemId, `att-${workItemId}-1`, `la-le-p`, 'structure_chunk', null, 1, 'v2');
    h.workItemCompleted(workItemId, 1);
    h.lease(workItemId, 1); // completed workitem + repeated epoch
    await expectCorrupt(h.events, 'transition', h.events.length);
  });

  it('rejects an attempt without a lease / with mismatched identities / wrong attempt family', async () => {
    const h = new LegalHistory('nf');
    const { workItemId } = h.createAgentWorkItem({ sessionKind: 'structure_chunk', logicalAssignmentId: 'la-nf-1' });
    h.attemptStarted(workItemId, `att-${workItemId}-1`, 'la-nf-1', 'structure_chunk', null, 1, 'v2');
    await expectCorrupt(h.events, 'dispatch_without_lease');
    // Mismatched logicalAssignmentId under a legal lease.
    const h2 = preamble('nf2');
    h2.h.attemptStarted(h2.workItemId, `att-${h2.workItemId}-1`, 'wrong-la', 'structure_chunk', null, 1, 'v2');
    await expectCorrupt(h2.h.events, 'identity_mismatch');
    // Generic attempt on a structured workitem.
    const h3 = preamble('nf3');
    h3.h.attemptStarted(h3.workItemId, `att-${h3.workItemId}-1`, `la-nf3-p`, 'structure_chunk', null, 1, 'generic', 'agent-1', 'dl-1');
    await expectCorrupt(h3.h.events, 'attempt_kind');
  });

  it('rejects a completion with a stale authorityBaseRef vs its lease', async () => {
    const { h, workItemId } = preamble('stale');
    h.attemptStarted(workItemId, `att-${workItemId}-1`, `la-stale-p`, 'structure_chunk', null, 1, 'v2');
    h.attemptCompleted(workItemId, `att-${workItemId}-1`, `la-stale-p`, 'structure_chunk', null, 1, 'v2');
    const staleBase = h.ref('authority_base_set');
    h.push({
      type: 'structured_work_item_completed',
      workItemId,
      leaseEpoch: 1,
      authorityBaseRef: staleBase,
    });
    await expectCorrupt(h.events, 'stale_authority_base', h.events.length);
  });

  it('rejects reclaim without the abandoned attempt and reclaim of an unknown item', async () => {
    const { h, workItemId } = preamble('r');
    h.push({
      type: 'structured_work_item_lease_reclaimed',
      workItemId,
      leaseEpoch: 1,
      reason: 'crash_recovery',
      authorityBaseRef: h.lastAuthorityBaseRef,
    });
    await expectCorrupt(h.events, 'attempt_not_abandoned', h.events.length);
    const h2 = new LegalHistory('r2');
    h2.push({
      type: 'structured_work_item_lease_reclaimed',
      workItemId: 'ghost',
      leaseEpoch: 1,
      reason: 'crash_recovery',
      authorityBaseRef: h2.lastAuthorityBaseRef,
    });
    await expectCorrupt(h2.events, 'unknown_work_item');
  });

  it('rejects broken retry-ordinal progression and exhausted-budget failure events', async () => {
    const { h, workItemId } = preamble('ro');
    h.attemptStarted(workItemId, `att-${workItemId}-1`, `la-ro-p`, 'structure_chunk', null, 1, 'v2');
    h.push({
      type: 'structured_agent_attempt_retryable_failed_v2',
      workItemId,
      logicalAssignmentId: `la-ro-p`,
      reviewAssignmentId: null,
      attemptId: `att-${workItemId}-1`,
      sessionKind: 'structure_chunk',
      leaseEpoch: 1,
      failureCode: 'HANDLER_FAILED',
      failureDigest: digestFor('fail', 1),
      retryOrdinal: 2, // must be 1
      retryNotBefore: AT,
      validatorAggregateRef: null,
      authorityBaseRef: h.lastAuthorityBaseRef,
    });
    await expectCorrupt(h.events, 'retry_ordinal', h.events.length);
  });

  it('rejects a second budget-exhausted park and a park on top of a question park', async () => {
    const first = buildBudgetFlow('b2');
    // Append a second workitem that also parks with retry_budget_exhausted.
    const h = new LegalHistory('b2');
    const budgetPrefix = first.slice(0, first.findIndex((e) => e.type === 'structured_task_retry_resumed_v2'));
    void h;
    const second = validateAuthoritativeReviewEventV2({
      protocolVersion: 2,
      id: 'evt-second-park-1',
      at: AT,
      type: 'structured_work_item_created',
      workItemId: 'wi-b2-second',
      kind: 'agent_assignment',
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
      roundId: null,
      logicalAssignmentId: 'la-b2-second',
      reviewAssignmentId: null,
      grantSpecRef: makeRef('write_grant_spec'),
      inputArtifactDeliveryId: null,
      authorityBaseRef: makeRef('authority_base_set'),
      payloadRef: makeRef('assignment_dispatch'),
      initialLeaseEpoch: 0,
      maxAutomaticRetries: 1,
    });
    const sharedBase = makeRef('authority_base_set');
    const park = validateAuthoritativeReviewEventV2({
      protocolVersion: 2,
      id: 'evt-second-park-2',
      at: AT,
      type: 'structured_work_item_parked',
      workItemId: 'wi-b2-second',
      leaseEpoch: 1,
      parkDisposition: { kind: 'retry_budget_exhausted', retryOrdinal: 1, budgetPolicyDigest: digestFor('budget', 2) },
      authorityBaseRef: sharedBase,
    });
    const lease2 = validateAuthoritativeReviewEventV2({
      protocolVersion: 2,
      id: 'evt-second-park-3',
      at: AT,
      type: 'structured_work_item_leased',
      workItemId: 'wi-b2-second',
      leaseEpoch: 1,
      leaseOwner: 'agent-1',
      leaseExpiresAt: AT,
      expectedLastSequence: 0,
      authorityBaseRef: sharedBase,
    });
    // M4: the park requires the cycle attempt to have ended (atomic envelope).
    const dispatch2 = validateAuthoritativeReviewEventV2({
      protocolVersion: 2, id: 'evt-second-park-6', at: AT,
      type: 'structured_assignment_dispatched',
      dispatchRef: makeRef('assignment_dispatch'),
      workItemId: 'wi-b2-second',
      attemptId: 'att-second-1',
      logicalAssignmentId: 'la-b2-second',
      reviewAssignmentId: null,
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
      inputArtifactDeliveryId: null,
      authorityBaseRef: sharedBase,
    });
    const started2 = validateAuthoritativeReviewEventV2({
      protocolVersion: 2, id: 'evt-second-park-4', at: AT,
      type: 'structured_agent_attempt_started_v2',
      workItemId: 'wi-b2-second',
      logicalAssignmentId: 'la-b2-second',
      reviewAssignmentId: null,
      attemptId: 'att-second-1',
      sessionKind: 'structure_chunk',
      leaseEpoch: 1,
      authorityBaseRef: sharedBase,
    });
    const terminal2 = validateAuthoritativeReviewEventV2({
      protocolVersion: 2, id: 'evt-second-park-5', at: AT,
      type: 'structured_agent_attempt_terminal_failed_v2',
      workItemId: 'wi-b2-second',
      logicalAssignmentId: 'la-b2-second',
      reviewAssignmentId: null,
      attemptId: 'att-second-1',
      sessionKind: 'structure_chunk',
      leaseEpoch: 1,
      failureCode: 'BUDGET_EXHAUSTED',
      failureDigest: digestFor('fail', 9),
      validatorAggregateRef: null,
      authorityBaseRef: sharedBase,
    });
    await expectCorrupt([...budgetPrefix, second, lease2, dispatch2, started2, terminal2, park], 'second_budget_disposition');
  });

  it('rejects suspension double-apply and clear-without-apply', async () => {
    const h = new LegalHistory('s');
    h.push({ type: 'structured_task_suspension_applied_v2', suspensionId: 'sus-1', reason: 'user_stop', operationId: 'op-1' });
    // At most one active overlay.
    const applied = validateAuthoritativeReviewEventV2({
      protocolVersion: 2,
      id: 'evt-sus-2',
      at: AT,
      type: 'structured_task_suspension_applied_v2',
      suspensionId: 'sus-2',
      reason: 'operator_interrupt',
      operationId: 'op-2',
    });
    await expectCorrupt([...h.events, applied], 'second_overlay');
    h.push({ type: 'structured_task_suspension_cleared_v2', suspensionId: 'sus-1', operationId: 'op-1' });
    await projectOk(h.events);
    const staleClear = validateAuthoritativeReviewEventV2({
      protocolVersion: 2,
      id: 'evt-sus-3',
      at: AT,
      type: 'structured_task_suspension_cleared_v2',
      suspensionId: 'sus-1',
      operationId: 'op-1',
    });
    await expectCorrupt([...h.events, staleClear], 'no_active_overlay');
  });

  it('rejects plan lineage violations: unknown successor, duplicate revision, wrong head', async () => {
    const h = new LegalHistory('pl');
    h.push({
      type: 'structured_map_build_started',
      mapBuildId: 'mb-pl-1',
      revision: 2, // must be 1 for the first
      mapBuildSpecRef: h.ref('map_build_spec'),
      supersedesMapBuildId: 'ghost-build',
      sourceValidationReceiptRef: null,
    });
    await expectCorrupt(h.events, 'successor');
    const h2 = new LegalHistory('pl2');
    h2.push({
      type: 'structured_map_build_started',
      mapBuildId: 'mb-pl2-1',
      revision: 1,
      mapBuildSpecRef: h.ref('map_build_spec'),
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
    });
    const secondHead = validateAuthoritativeReviewEventV2({
      protocolVersion: 2,
      id: 'evt-plan-2',
      at: AT,
      type: 'structured_map_build_started',
      mapBuildId: 'mb-pl2-2',
      revision: 2,
      mapBuildSpecRef: makeRef('map_build_spec'),
      supersedesMapBuildId: 'mb-pl2-1',
      sourceValidationReceiptRef: null,
    });
    await projectOk([...h2.events, secondHead]);
    const wrongHead = validateAuthoritativeReviewEventV2({
      protocolVersion: 2,
      id: 'evt-plan-3',
      at: AT,
      type: 'structured_map_build_started',
      mapBuildId: 'mb-pl2-3',
      revision: 2,
      mapBuildSpecRef: makeRef('map_build_spec'),
      supersedesMapBuildId: 'mb-pl2-1',
      sourceValidationReceiptRef: null,
    });
    // The second successor already claimed mb-pl2-1; a DIFFERENT successor
    // claiming the same predecessor is a competing successor.
    await expectCorrupt([...h2.events, secondHead, wrongHead], 'competing_successor');
    // Immutable spec lineage: same lineage id + same revision twice.
    const dup = validateAuthoritativeReviewEventV2({
      protocolVersion: 2,
      id: 'evt-plan-4',
      at: AT,
      type: 'structured_map_build_started',
      mapBuildId: 'mb-pl2-1',
      revision: 1,
      mapBuildSpecRef: makeRef('map_build_spec'),
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
    });
    await expectCorrupt([...h2.events, dup], 'revision_clash');
  });

  it('rejects chunks on an unknown/finalized build and non-contiguous chunk ordinals', async () => {
    const h = new LegalHistory('ch');
    h.push({
      type: 'structured_map_build_started',
      mapBuildId: 'mb-ch-1',
      revision: 1,
      mapBuildSpecRef: h.ref('map_build_spec'),
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
    });
    h.push({
      type: 'structured_map_chunk_committed',
      mapBuildId: 'mb-ch-1',
      chunkId: 'chunk-1',
      chunkOrdinal: 2, // must start at 1
      chunkRef: h.ref('map_build_chunk'),
      parentFrontierDigest: digestFor('ch', 1),
    });
    await expectCorrupt(h.events, 'chunk_ordinal');
  });

  it('rejects map round ordinal skips and candidate mismatch', async () => {
  const h = new LegalHistory('mr');
  const c = h.commitMapBuildRevision({ revision: 1, chunkCount: 1 });
  h.push({
    type: 'structured_map_review_round_planned',
    mapReviewRoundId: 'mr-mr-1',
    mapCycleOrdinal: 2, // must be 1
    candidateId: c.candidateId,
    candidateRef: c.candidateRef,
    contentRevisionManifestRef: null,
    reviewPolicyDigest: digestFor('policy', 1),
    coverageNodeCount: 1,
    coverageRelationCount: 0,
    assignmentCount: 1,
    consumedOverrideRef: null,
  });
  await expectCorrupt(h.events, 'round_ordinal', h.events.length);
  // The round must reference the CURRENT candidate.
  const h2 = new LegalHistory('mr2');
  const c2 = h2.commitMapBuildRevision({ revision: 1, chunkCount: 1 });
  h2.push({
    type: 'structured_map_review_round_planned',
    mapReviewRoundId: 'mr-mr2-1',
    mapCycleOrdinal: 1,
    candidateId: 'cand-x',
    candidateRef: makeRef('map_candidate'),
    contentRevisionManifestRef: null,
    reviewPolicyDigest: digestFor('policy', 1),
    coverageNodeCount: 1,
    coverageRelationCount: 0,
    assignmentCount: 1,
    consumedOverrideRef: null,
  });
  await expectCorrupt(h2.events, 'candidate_mismatch', h2.events.length);
  void c;
  void c2;
});

  it('rejects sealed ref closure violations (foreign producer, wrong manifest binding)', async () => {
  const events = buildFullLifecycle('seal');
  const publishIndex = events.findIndex((e) => e.type === 'artifact_published_v2');
  const mutatedProducer = events.map((e, i) => {
    if (i !== publishIndex) return e;
    const publish = e as Extract<AuthoritativeReviewEventV2, { type: 'artifact_published_v2' }>;
    return validateAuthoritativeReviewEventV2({
      ...publish,
      provenance: { ...publish.provenance, producerWorkItemId: 'wi-other-seal' },
    });
  });
  const sealEvent = events.find((e) => e.type === 'structured_scaffold_sealed_v2') as Extract<AuthoritativeReviewEventV2, { type: 'structured_scaffold_sealed_v2' }>;
  const sealedMutated = events.map((e) =>
    e === sealEvent
      ? validateAuthoritativeReviewEventV2({
          ...(e as unknown as Record<string, unknown>),
          contentRevisionManifestRef: makeRef('content_revision_manifest'),
        })
      : e,
  );
  await expectCorrupt(mutatedProducer, 'producer_work_item', publishIndex + 1);
  await expectCorrupt(sealedMutated, 'sealed_manifest_mismatch');
});

  it('rejects recovery-payload branch mismatches and fake terminal identities', async () => {
    // ARTIFACT_VALIDATION_FAILED must carry a retry_system_command payload,
    // never a restart_review_cycle payload.
    const seed = 'rp';
    const h = new LegalHistory(seed);
    const settle = h.createSystemWorkItem('system_seal');
    h.lease(settle.workItemId, 1, 'system');
    h.push({
      type: 'structured_system_command_started',
      commandId: `cmd-${settle.workItemId}-1`,
      workItemId: settle.workItemId,
      commandKind: 'seal',
      leaseEpoch: 1,
      authorityBaseRef: h.lastAuthorityBaseRef,
    });
    h.push({
      type: 'structured_system_command_terminal_failed',
      commandId: `cmd-${settle.workItemId}-1`,
      workItemId: settle.workItemId,
      commandKind: 'seal',
      leaseEpoch: 1,
      failureCode: 'ARTIFACT_VALIDATION_FAILED',
      failureDigest: digestFor('fail', 1),
      validatorAggregateRef: h.ref('validator_aggregate'),
      authorityBaseRef: h.lastAuthorityBaseRef,
    });
    h.push({
      type: 'structured_work_item_terminal_failed',
      workItemId: settle.workItemId,
      leaseEpoch: 1,
      failureCode: 'ARTIFACT_VALIDATION_FAILED',
      failureDigest: digestFor('fail', 1),
      terminalAttemptId: null,
      terminalCommandId: `cmd-${settle.workItemId}-1`,
      validatorAggregateRef: h.ref('validator_aggregate'),
      authorityBaseRef: h.lastAuthorityBaseRef,
    });
    const terminalEvent = h.events[h.events.length - 1];
    const payloadRef = h.ref('failure_recovery_payload');
    h.push({
      type: 'structured_task_failed_v2',
      workItemId: settle.workItemId,
      attemptId: null,
      commandId: `cmd-${settle.workItemId}-1`,
      leaseEpoch: 1,
      failureCode: 'ARTIFACT_VALIDATION_FAILED',
      failureDigest: digestFor('fail', 1),
      failureRecoveryPayloadRef: payloadRef,
      authorityBaseRef: h.lastAuthorityBaseRef,
    });
    const fixtures: Record<string, unknown> = {
      [payloadRef.digest]: {
        kind: 'restart_review_cycle', // WRONG branch for ARTIFACT_VALIDATION_FAILED
        track: 'map',
        failedWorkItemId: settle.workItemId,
        failedAttemptOrCommandId: `cmd-${settle.workItemId}-1`,
        failedLeaseEpoch: 1,
        terminalEventId: terminalEvent.id,
        terminalCommitId: 'commit-x',
        authorityBaseRef: h.lastAuthorityBaseRef,
        rejectedSubjectRef: makeRef('map_candidate'),
        findingSetRef: makeRef('finding_set'),
        failedCycleOrdinal: 1,
      },
    };
    await expectCorrupt(h.events, 'recovery_branch', h.events.length, fixtureResolver(fixtures));
  });

  it('rejects fake/mismatched payload terminal identities against history', async () => {
    const { events, fixtures } = buildReopenOverrideFlow('fake', 'map');
    const failedEvent = events[events.findIndex((e) => e.type === 'structured_task_failed_v2')] as Extract<AuthoritativeReviewEventV2, { type: 'structured_task_failed_v2' }>;
    const digest = failedEvent.failureRecoveryPayloadRef?.digest ?? '';
    const baseFixture = fixtures[digest] as Record<string, unknown>;
    const mutated = {
      ...fixtures,
      [digest]: { ...baseFixture, terminalEventId: 'evt-does-not-exist' },
    };
    await expectCorrupt(events, 'terminal_event', undefined, fixtureResolver(mutated));
  });

  it('resolves the override blob and rejects wrong-track consumption', async () => {
    const { events, fixtures } = buildReopenOverrideFlow('wt', 'map');
    // A content round consuming the MAP-track override.
    const roundIndex = events.findIndex((e) => e.type === 'structured_map_review_round_planned');
    const round = events[roundIndex] as Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_round_planned' }>;
    const contentRound = validateAuthoritativeReviewEventV2({
      protocolVersion: 2,
      id: 'evt-content-round-1',
      at: AT,
      type: 'structured_review_round_planned',
      reviewRoundId: 'cr-wt-9',
      contentCycleOrdinal: 1,
      mapRef: makeRef('map_snapshot'),
      mapSemanticDigest: digestFor('semantic', 9),
      contentRevisionManifestRef: makeRef('content_revision_manifest'),
      reviewPolicyDigest: digestFor('policy', 9),
      adoptionRootRef: makeRef('review_adoption_root'),
      coverageSlotCount: 1,
      coverageRelationCount: 0,
      assignmentCount: 1,
      verificationFindingCount: 0,
      consumedOverrideRef: round.consumedOverrideRef as BlobRefV2,
    });
    const replaced = [...events.slice(0, roundIndex), ...events.slice(roundIndex + 1), contentRound];
    await expectCorrupt(replaced, 'override_track', roundIndex + 1, fixtureResolver(fixtures));
  });

  it('rejects a second consumption and consumption of an unknown override', async () => {
    const { events, fixtures } = buildReopenOverrideFlow('sc', 'map');
    const resolver = fixtureResolver(fixtures);
    const firstRound = events[events.findIndex((e) => e.type === 'structured_map_review_round_planned')] as Extract<AuthoritativeReviewEventV2, { type: 'structured_map_review_round_planned' }>;
    const secondRound = validateAuthoritativeReviewEventV2({
      protocolVersion: 2,
      id: 'evt-second-round-1',
      at: AT,
      type: 'structured_map_review_round_planned',
      mapReviewRoundId: 'mr-sc-99',
      mapCycleOrdinal: 2,
      candidateId: firstRound.candidateId,
      candidateRef: firstRound.candidateRef,
      contentRevisionManifestRef: null,
      reviewPolicyDigest: digestFor('policy', 1),
      coverageNodeCount: 1,
      coverageRelationCount: 0,
      assignmentCount: 1,
      consumedOverrideRef: makeRef('round_budget_override'), // unknown ref
    });
    await expectCorrupt([...events, secondRound], 'override_unknown', events.length + 1, resolver);
  });
});

/* ------------------------------------------------------------------ */
/* Fix round 1 (adversarial review): F1, F2, M1-M4, M6, M8             */
/* ------------------------------------------------------------------ */

describe('projectAuthoritativeReviewState — review fix round 1', () => {
  it('F1: rejects forged assignment completions and pending-assignment round completion', async () => {
    // Legal base: an activated map, a baseline manifest and one planned
    // content round (from the reopen flow builder).
    const { events, fixtures } = buildReopenOverrideFlow('f1', 'content');
    void fixtures;
    const base = events as AuthoritativeReviewEventV2[];
    const ledger = makeRef('review_assignment_ledger');
    const wiCreated = validateAuthoritativeReviewEventV2({
      protocolVersion: 2, id: 'evt-f1-wi', at: AT,
      type: 'structured_work_item_created',
      workItemId: 'wi-f1-reviewer',
      kind: 'agent_assignment',
      roleBinding: 'reviewer',
      agentExecutionKind: 'structured_session',
      sessionKind: 'review_content_batch',
      roundId: 'cr-f1-2',
      logicalAssignmentId: 'la-f1',
      reviewAssignmentId: 'ra-f1',
      grantSpecRef: makeRef('write_grant_spec'),
      inputArtifactDeliveryId: null,
      authorityBaseRef: makeRef('authority_base_set'),
      payloadRef: makeRef('assignment_dispatch'),
      initialLeaseEpoch: 0,
      maxAutomaticRetries: 2,
    });
    const f1LeaseBase = makeRef('authority_base_set');
    const leaseWi = validateAuthoritativeReviewEventV2({
      protocolVersion: 2, id: 'evt-f1-lease', at: AT,
      type: 'structured_work_item_leased',
      workItemId: 'wi-f1-reviewer',
      leaseEpoch: 1,
      leaseOwner: 'agent-r',
      leaseExpiresAt: AT,
      expectedLastSequence: 0,
      authorityBaseRef: f1LeaseBase,
    });
    const dispatchWi = validateAuthoritativeReviewEventV2({
      protocolVersion: 2, id: 'evt-f1-dispatch', at: AT,
      type: 'structured_assignment_dispatched',
      dispatchRef: makeRef('assignment_dispatch'),
      workItemId: 'wi-f1-reviewer',
      attemptId: 'att-f1-1',
      logicalAssignmentId: 'la-f1',
      reviewAssignmentId: 'ra-f1',
      agentExecutionKind: 'structured_session',
      sessionKind: 'review_content_batch',
      inputArtifactDeliveryId: null,
      authorityBaseRef: f1LeaseBase,
    });
    const startedWi = validateAuthoritativeReviewEventV2({
      protocolVersion: 2, id: 'evt-f1-start', at: AT,
      type: 'structured_agent_attempt_started_v2',
      workItemId: 'wi-f1-reviewer',
      logicalAssignmentId: 'la-f1',
      reviewAssignmentId: 'ra-f1',
      attemptId: 'att-f1-1',
      sessionKind: 'review_content_batch',
      leaseEpoch: 1,
      authorityBaseRef: f1LeaseBase,
    });
    const assignmentStarted = validateAuthoritativeReviewEventV2({
      protocolVersion: 2, id: 'evt-f1-asg-start', at: AT,
      type: 'structured_review_assignment_started',
      assignmentId: 'asg-f1',
      reviewRoundId: 'cr-f1-2',
      workItemId: 'wi-f1-reviewer',
      attemptId: 'att-f1-1',
      reviewAssignmentId: 'ra-f1',
      source: 'batch',
    });
    const assignmentCommitted = validateAuthoritativeReviewEventV2({
      protocolVersion: 2, id: 'evt-f1-asg-commit', at: AT,
      type: 'structured_content_review_assignment_committed',
      assignmentId: 'asg-f1',
      reviewRoundId: 'cr-f1-2',
      workItemId: 'wi-f1-reviewer',
      attemptId: 'att-f1-1',
      reviewAssignmentId: 'ra-f1',
      source: 'batch',
      ledgerRef: ledger,
      coverageTargetCount: 5,
      findingCount: 0,
    });
    // Legal path: started+committed+completed closes the assignment.
    const assignmentCompleted = validateAuthoritativeReviewEventV2({
      protocolVersion: 2, id: 'evt-f1-asg-complete', at: AT,
      type: 'structured_review_assignment_completed',
      assignmentId: 'asg-f1',
      reviewRoundId: 'cr-f1-2',
      workItemId: 'wi-f1-reviewer',
      attemptId: 'att-f1-1',
      ledgerRef: ledger,
      source: 'batch',
    });
    const roundCompleted = validateAuthoritativeReviewEventV2({
      protocolVersion: 2, id: 'evt-f1-round-complete', at: AT,
      type: 'structured_review_round_completed',
      reviewRoundId: 'cr-f1-2',
      coverageCoreRef: makeRef('content_review_coverage_core'),
    });
    const legalPrefix = [...base, wiCreated, leaseWi, dispatchWi, startedWi, assignmentStarted, assignmentCommitted];
    // Round completion BEFORE the assignment completed is corrupt.
    await expectCorrupt([...legalPrefix, roundCompleted], 'round_completed_with_pending_assignments');
    // A completion with forged identities/ledger is corrupt.
    const forged = validateAuthoritativeReviewEventV2({
      protocolVersion: 2, id: 'evt-f1-forged', at: AT,
      type: 'structured_review_assignment_completed',
      assignmentId: 'asg-f1',
      reviewRoundId: 'cr-f1-2',
      workItemId: 'wi-other',
      attemptId: 'att-other-9',
      ledgerRef: makeRef('review_assignment_ledger'),
      source: 'batch',
    });
    await expectCorrupt([...legalPrefix, forged], 'assignment_identity_mismatch');
    // A completion for an unknown assignment is corrupt.
    const unknown = validateAuthoritativeReviewEventV2({
      protocolVersion: 2, id: 'evt-f1-unknown', at: AT,
      type: 'structured_review_assignment_completed',
      assignmentId: 'asg-ghost',
      reviewRoundId: 'cr-f1-2',
      workItemId: 'wi-f1-reviewer',
      attemptId: 'att-f1-1',
      ledgerRef: ledger,
      source: 'batch',
    });
    await expectCorrupt([...legalPrefix.concat(assignmentCompleted as AuthoritativeReviewEventV2, roundCompleted).slice(0, legalPrefix.length + 1), unknown], 'assignment_without_commit');
    // A completion with a different ledgerRef is corrupt.
    const wrongLedger = validateAuthoritativeReviewEventV2({
      ...(assignmentCompleted as unknown as Record<string, unknown>),
      id: 'evt-f1-wrong-ledger',
      ledgerRef: makeRef('review_assignment_ledger'),
    });
    await expectCorrupt([...legalPrefix, wrongLedger], 'assignment_ledger_mismatch');
    // The full legal closure passes and the round completes.
    await projectOk([...legalPrefix, assignmentCompleted, roundCompleted]);
  });

  it('F2: legal system-command retry cycle (shared ordinal, no double bump)', async () => {
    const h = new LegalHistory('f2-retry');
    const sys = h.createSystemWorkItem('system_migration_validation_batch');
    h.lease(sys.workItemId, 1, 'system');
    h.push({ type: 'structured_system_command_started', commandId: `cmd-${sys.workItemId}-1`, workItemId: sys.workItemId, commandKind: 'migration_validation_batch', leaseEpoch: 1, authorityBaseRef: h.lastAuthorityBaseRef });
    h.push({ type: 'structured_system_command_retryable_failed', commandId: `cmd-${sys.workItemId}-1`, workItemId: sys.workItemId, commandKind: 'migration_validation_batch', leaseEpoch: 1, failureCode: 'HANDLER_FAILED', failureDigest: digestFor('fail', 1), retryOrdinal: 1, retryNotBefore: AT, validatorAggregateRef: null, authorityBaseRef: h.lastAuthorityBaseRef });
    h.push({ type: 'structured_work_item_retryable_failed', workItemId: sys.workItemId, leaseEpoch: 1, failureCode: 'HANDLER_FAILED', failureDigest: digestFor('fail', 1), retryOrdinal: 1, retryNotBefore: AT, maxAutomaticRetries: 2, validatorAggregateRef: null, authorityBaseRef: h.lastAuthorityBaseRef });
    h.push({ type: 'structured_work_item_requeued', workItemId: sys.workItemId, leaseEpoch: 1, expectedLastSequence: 0, authorityBaseRef: h.lastAuthorityBaseRef });
    h.lease(sys.workItemId, 2, 'system');
    h.push({ type: 'structured_system_command_started', commandId: `cmd-${sys.workItemId}-2`, workItemId: sys.workItemId, commandKind: 'migration_validation_batch', leaseEpoch: 2, authorityBaseRef: h.lastAuthorityBaseRef });
    h.push({ type: 'structured_system_command_completed', commandId: `cmd-${sys.workItemId}-2`, workItemId: sys.workItemId, commandKind: 'migration_validation_batch', leaseEpoch: 2, authorityBaseRef: h.lastAuthorityBaseRef });
    h.workItemCompleted(sys.workItemId, 2);
    const state = await projectOk(h.events);
    const wi = state.workItems[sys.workItemId];
    expect(wi).toMatchObject({ state: 'completed', leaseEpoch: 2, retryOrdinal: 1 });
  });

  it('F2: legal system-command budget exhaustion -> park -> manual retry resume', async () => {
    const h = new LegalHistory('f2-budget');
    const sys = h.createSystemWorkItem('system_review_settlement', { maxAutomaticRetries: 1 });
    h.lease(sys.workItemId, 1, 'system');
    h.push({ type: 'structured_system_command_started', commandId: `cmd-${sys.workItemId}-1`, workItemId: sys.workItemId, commandKind: 'review_settlement', leaseEpoch: 1, authorityBaseRef: h.lastAuthorityBaseRef });
    h.push({ type: 'structured_system_command_retryable_failed', commandId: `cmd-${sys.workItemId}-1`, workItemId: sys.workItemId, commandKind: 'review_settlement', leaseEpoch: 1, failureCode: 'HANDLER_FAILED', failureDigest: digestFor('fail', 1), retryOrdinal: 1, retryNotBefore: AT, validatorAggregateRef: null, authorityBaseRef: h.lastAuthorityBaseRef });
    h.push({ type: 'structured_work_item_retryable_failed', workItemId: sys.workItemId, leaseEpoch: 1, failureCode: 'HANDLER_FAILED', failureDigest: digestFor('fail', 1), retryOrdinal: 1, retryNotBefore: AT, maxAutomaticRetries: 1, validatorAggregateRef: null, authorityBaseRef: h.lastAuthorityBaseRef });
    h.push({ type: 'structured_work_item_requeued', workItemId: sys.workItemId, leaseEpoch: 1, expectedLastSequence: 0, authorityBaseRef: h.lastAuthorityBaseRef });
    h.lease(sys.workItemId, 2, 'system');
    h.push({ type: 'structured_system_command_started', commandId: `cmd-${sys.workItemId}-2`, workItemId: sys.workItemId, commandKind: 'review_settlement', leaseEpoch: 2, authorityBaseRef: h.lastAuthorityBaseRef });
    h.push({ type: 'structured_system_command_terminal_failed', commandId: `cmd-${sys.workItemId}-2`, workItemId: sys.workItemId, commandKind: 'review_settlement', leaseEpoch: 2, failureCode: 'BUDGET_EXHAUSTED', failureDigest: digestFor('fail', 2), validatorAggregateRef: null, authorityBaseRef: h.lastAuthorityBaseRef });
    h.push({ type: 'structured_work_item_parked', workItemId: sys.workItemId, leaseEpoch: 2, parkDisposition: { kind: 'retry_budget_exhausted', retryOrdinal: 2, budgetPolicyDigest: digestFor('budget', 1) }, authorityBaseRef: h.lastAuthorityBaseRef });
    // M8: the WORKITEM-level resume event is a legal budget release too.
    h.push({ type: 'structured_work_item_resumed', workItemId: sys.workItemId, leaseEpoch: 3, expectedLastSequence: 0, authorityBaseRef: h.lastAuthorityBaseRef });
    h.lease(sys.workItemId, 4, 'system');
    h.push({ type: 'structured_system_command_started', commandId: `cmd-${sys.workItemId}-4`, workItemId: sys.workItemId, commandKind: 'review_settlement', leaseEpoch: 4, authorityBaseRef: h.lastAuthorityBaseRef });
    h.push({ type: 'structured_system_command_completed', commandId: `cmd-${sys.workItemId}-4`, workItemId: sys.workItemId, commandKind: 'review_settlement', leaseEpoch: 4, authorityBaseRef: h.lastAuthorityBaseRef });
    h.workItemCompleted(sys.workItemId, 4);
    const state = await projectOk(h.events);
    expect(state.retryBudgetExhaustedWorkItemId).toBeNull();
    expect(state.workItems[sys.workItemId]?.state).toBe('completed');
  });

  it('M1: rejects reopen recipes outside the failure row matrix', async () => {
    const { events, fixtures } = buildReopenOverrideFlow('m1', 'map');
    const resolver = fixtureResolver(fixtures);
    const reopenIndex = events.findIndex((e) => e.type === 'structured_task_reopened_v2');
    const reopened = events[reopenIndex] as Extract<AuthoritativeReviewEventV2, { type: 'structured_task_reopened_v2' }>;
    // retry_system_command is never legal for a REVIEW_REPAIR_LIMIT_EXCEEDED failure.
    const wrongRecipe = validateAuthoritativeReviewEventV2({
      ...(reopened as unknown as Record<string, unknown>),
      id: 'evt-m1-wrong-recipe',
      recipeKey: 'retry_system_command',
      track: null,
      overrideRef: null,
    });
    await expectCorrupt(
      [...events.slice(0, reopenIndex), wrongRecipe, ...events.slice(reopenIndex + 1)],
      'reopen_recipe_mismatch',
      reopenIndex + 1,
      resolver,
    );
    // A round-limit recipe on a NON-round failure is corrupt too.
    const h = new LegalHistory('m1b');
    const seal = h.createSystemWorkItem('system_seal');
    h.lease(seal.workItemId, 1, 'system');
    h.push({ type: 'structured_system_command_started', commandId: `cmd-${seal.workItemId}-1`, workItemId: seal.workItemId, commandKind: 'seal', leaseEpoch: 1, authorityBaseRef: h.lastAuthorityBaseRef });
    h.push({ type: 'structured_system_command_terminal_failed', commandId: `cmd-${seal.workItemId}-1`, workItemId: seal.workItemId, commandKind: 'seal', leaseEpoch: 1, failureCode: 'ARTIFACT_VALIDATION_FAILED', failureDigest: digestFor('fail', 1), validatorAggregateRef: h.ref('validator_aggregate'), authorityBaseRef: h.lastAuthorityBaseRef });
    h.push({ type: 'structured_work_item_terminal_failed', workItemId: seal.workItemId, leaseEpoch: 1, failureCode: 'ARTIFACT_VALIDATION_FAILED', failureDigest: digestFor('fail', 1), terminalAttemptId: null, terminalCommandId: `cmd-${seal.workItemId}-1`, validatorAggregateRef: h.ref('validator_aggregate'), authorityBaseRef: h.lastAuthorityBaseRef });
    const workItemTerminalId = h.events[h.events.length - 1].id;
    const payloadRef = h.ref('failure_recovery_payload');
    h.push({ type: 'structured_task_failed_v2', workItemId: seal.workItemId, attemptId: null, commandId: `cmd-${seal.workItemId}-1`, leaseEpoch: 1, failureCode: 'ARTIFACT_VALIDATION_FAILED', failureDigest: digestFor('fail', 1), failureRecoveryPayloadRef: payloadRef, authorityBaseRef: h.lastAuthorityBaseRef });
    const fixturesB: Record<string, unknown> = {
      [payloadRef.digest]: {
        kind: 'retry_system_command',
        failedWorkItemId: seal.workItemId,
        failedCommandId: `cmd-${seal.workItemId}-1`,
        failedLeaseEpoch: 1,
        terminalEventId: workItemTerminalId,
        terminalCommitId: 'c',
        authorityBaseRef: h.lastAuthorityBaseRef,
        systemKind: 'system_seal',
        systemPayloadRef: makeRef('seal_validation_bundle'),
      },
    };
    h.push({ type: 'structured_task_reopened_v2', expectedLastSequence: h.sequence, operationId: uuidFor('m1b'), operatorId: 'task_owner', reason: 'reopen', recipeKey: 'restart_content_review_cycle', track: 'content', failureRecoveryPayloadRef: payloadRef, overrideRef: makeRef('round_budget_override') });
    await expectCorrupt(h.events, 'reopen_recipe_mismatch', h.events.length, fixtureResolver(fixturesB));
  });

  it('M2: recovery payloads accept the attempt OR workitem terminal event ids', async () => {
    const { events, fixtures } = buildReopenOverrideFlow('m2', 'map');
    const resolver = fixtureResolver(fixtures);
    const failedEvent = events[events.findIndex((e) => e.type === 'structured_task_failed_v2')] as Extract<AuthoritativeReviewEventV2, { type: 'structured_task_failed_v2' }>;
    const digest = failedEvent.failureRecoveryPayloadRef?.digest ?? '';
    const baseFixture = fixtures[digest] as Record<string, unknown>;
    // The attempt/command OWN terminal event id (the command terminal failed
    // event), which the payload may legally name (M2).
    const commandTerminal = events.find((e) => e.type === 'structured_system_command_terminal_failed');
    if (commandTerminal !== undefined) {
      const withAttemptTerminal = {
        ...fixtures,
        [digest]: { ...baseFixture, terminalEventId: commandTerminal.id },
      };
      await projectOk(events, fixtureResolver(withAttemptTerminal));
    }
    // The workitem terminal event id (existing default) still passes.
    await projectOk(events, resolver);
  });

  it('M3: a second publish from the same seal fails fast at the publish event', async () => {
    const events = buildFullLifecycle('m3');
    const publishIndex = events.findIndex((e) => e.type === 'artifact_published_v2');
    const publish = events[publishIndex] as Extract<AuthoritativeReviewEventV2, { type: 'artifact_published_v2' }>;
    const second = validateAuthoritativeReviewEventV2({
      ...(publish as unknown as Record<string, unknown>),
      id: 'evt-m3-second-publish',
      artifactId: 'artifact-m3-2',
      artifactVersion: 2,
    });
    await expectCorrupt([...events.slice(0, publishIndex + 1), second], 'publish_duplicate', publishIndex + 2);
  });

  it('M4: park/supersede of a leased workitem require the attempt to have ended', async () => {
    const { h, workItemId } = preamble('m4');
    h.attemptStarted(workItemId, `att-${workItemId}-1`, `la-m4-p`, 'structure_chunk', null, 1, 'v2');
    h.push({ type: 'structured_work_item_parked', workItemId, leaseEpoch: 1, parkDisposition: { kind: 'human_question', questionId: 'q-m4', questionVersion: TOKEN43 }, authorityBaseRef: h.lastAuthorityBaseRef });
    await expectCorrupt(h.events, 'park_without_terminal', h.events.length);
    // Supersede of a leased workitem with a still-started attempt.
    const h2 = preamble('m4b');
    h2.h.attemptStarted(h2.workItemId, `att-${h2.workItemId}-1`, `la-m4b-p`, 'structure_chunk', null, 1, 'v2');
    h2.h.push({ type: 'structured_work_item_superseded', workItemId: h2.workItemId, leaseEpoch: 1, reason: 'new_authority_base', authorityBaseRef: h2.h.lastAuthorityBaseRef });
    await expectCorrupt(h2.h.events, 'supersede_without_terminal', h2.h.events.length);
  });

  it('M6: an answer with a stale authority base is rejected', async () => {
    const events = buildQuestionFlow('m6');
    const answerIndex = events.findIndex((e) => e.type === 'structured_human_answer_delivered_v2');
    const answer = events[answerIndex] as Extract<AuthoritativeReviewEventV2, { type: 'structured_human_answer_delivered_v2' }>;
    const stale = validateAuthoritativeReviewEventV2({
      ...(answer as unknown as Record<string, unknown>),
      id: 'evt-m6-stale-answer',
      authorityBaseRef: makeRef('authority_base_set'),
    });
    await expectCorrupt([...events.slice(0, answerIndex), stale], 'answer_base_stale', answerIndex + 1);
  });

  it('M8: resume on a human disposition stays illegal; suspension clears never release parks', async () => {
    const question = buildQuestionFlow('m8');
    const parkIndex = question.findIndex((e) => e.type === 'structured_work_item_parked');
    const park = question[parkIndex] as Extract<AuthoritativeReviewEventV2, { type: 'structured_work_item_parked' }>;
    const resumed = validateAuthoritativeReviewEventV2({
      protocolVersion: 2, id: 'evt-m8-resume', at: AT,
      type: 'structured_work_item_resumed',
      workItemId: park.workItemId,
      leaseEpoch: 2,
      expectedLastSequence: 0,
      authorityBaseRef: makeRef('authority_base_set'),
    });
    await expectCorrupt([...question.slice(0, parkIndex + 1), resumed], 'resume_human_disposition');
    // The task-lifecycle resume (suspension clear) never touches a budget park.
    const budget = buildBudgetFlow('m8b');
    const parkInBudget = budget.findIndex((e) => e.type === 'structured_work_item_parked');
    const withSuspension = validateAuthoritativeReviewEventV2({ protocolVersion: 2, id: 'evt-m8-susp', at: AT, type: 'structured_task_suspension_applied_v2', suspensionId: 'sus-m8', reason: 'user_stop', operationId: 'op-m8' });
    const cleared = validateAuthoritativeReviewEventV2({ protocolVersion: 2, id: 'evt-m8-clear', at: AT, type: 'structured_task_suspension_cleared_v2', suspensionId: 'sus-m8', operationId: 'op-m8' });
    const prefix = budget.slice(0, parkInBudget + 1);
    const afterClear = await projectOk([...prefix, withSuspension, cleared]);
    expect(afterClear.taskStatus).toBe('retryable_failure');
    expect(afterClear.retryBudgetExhaustedWorkItemId).not.toBeNull();
  });

  it('M5: the synchronous projection is digest-identical to the async one', async () => {
    const events = buildFullLifecycle('sync-equiv');
    const asyncResult = await projectAuthoritativeReviewState(events);
    const syncState = projectAuthoritativeReviewStateSync(events);
    if (!asyncResult.ok || !syncState.ok) {
      throw new Error('projection failed');
    }
    expect(projectionDigestOf(syncState.state)).toBe(projectionDigestOf(asyncResult.state));
  });
});

/* ------------------------------------------------------------------ */
/* Fix round 2 (re-review): F2-partial, R1, map ledger closure, R2     */
/* ------------------------------------------------------------------ */

describe('projectAuthoritativeReviewState — review fix round 2', () => {
  it('F2 partial: a terminally failed command can never be re-issued as retryable', async () => {
    const h = new LegalHistory('f2p');
    const sys = h.createSystemWorkItem('system_seal');
    h.lease(sys.workItemId, 1, 'system');
    h.push({ type: 'structured_system_command_started', commandId: `cmd-${sys.workItemId}-1`, workItemId: sys.workItemId, commandKind: 'seal', leaseEpoch: 1, authorityBaseRef: h.lastAuthorityBaseRef });
    h.push({ type: 'structured_system_command_terminal_failed', commandId: `cmd-${sys.workItemId}-1`, workItemId: sys.workItemId, commandKind: 'seal', leaseEpoch: 1, failureCode: 'ARTIFACT_VALIDATION_FAILED', failureDigest: digestFor('fail', 1), validatorAggregateRef: h.ref('validator_aggregate'), authorityBaseRef: h.lastAuthorityBaseRef });
    // Re-issuing the SAME command as retryable erases the terminal identity.
    h.push({ type: 'structured_system_command_retryable_failed', commandId: `cmd-${sys.workItemId}-1`, workItemId: sys.workItemId, commandKind: 'seal', leaseEpoch: 1, failureCode: 'HANDLER_FAILED', failureDigest: digestFor('fail', 2), retryOrdinal: 1, retryNotBefore: AT, validatorAggregateRef: null, authorityBaseRef: h.lastAuthorityBaseRef });
    await expectCorrupt(h.events, 'command_transition', h.events.length);
    // A completed command is just as immutable.
    const h2 = new LegalHistory('f2p2');
    const sys2 = h2.createSystemWorkItem('system_seal');
    h2.lease(sys2.workItemId, 1, 'system');
    h2.push({ type: 'structured_system_command_started', commandId: `cmd-${sys2.workItemId}-1`, workItemId: sys2.workItemId, commandKind: 'seal', leaseEpoch: 1, authorityBaseRef: h2.lastAuthorityBaseRef });
    h2.push({ type: 'structured_system_command_completed', commandId: `cmd-${sys2.workItemId}-1`, workItemId: sys2.workItemId, commandKind: 'seal', leaseEpoch: 1, authorityBaseRef: h2.lastAuthorityBaseRef });
    h2.push({ type: 'structured_system_command_retryable_failed', commandId: `cmd-${sys2.workItemId}-1`, workItemId: sys2.workItemId, commandKind: 'seal', leaseEpoch: 1, failureCode: 'HANDLER_FAILED', failureDigest: digestFor('fail', 3), retryOrdinal: 1, retryNotBefore: AT, validatorAggregateRef: null, authorityBaseRef: h2.lastAuthorityBaseRef });
    await expectCorrupt(h2.events, 'command_transition', h2.events.length);
  });

  it('R1: an undefined-returning resolver fails closed, never hangs', async () => {
    const { events } = buildReopenOverrideFlow('r1', 'map');
    const undefinedResolver: BlobObjectResolver = async () => undefined as never;
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('HANG: projection did not terminate')), 3000);
    });
    await expect(Promise.race([projectAuthoritativeReviewState(events, undefinedResolver), timeout])).rejects.toMatchObject({
      reason: 'blob_unresolvable',
    });
  });

  it('map ledger closure: forged/duplicate map freezes and incomplete rounds corrupt; legal closure passes', async () => {
    const h = new LegalHistory('ml');
    const { candidateId, candidateRef } = h.commitMapBuildRevision({ revision: 1, chunkCount: 1 });
    h.push({
      type: 'structured_map_review_round_planned',
      mapReviewRoundId: 'mr-ml-1',
      mapCycleOrdinal: 1,
      candidateId,
      candidateRef,
      contentRevisionManifestRef: null,
      reviewPolicyDigest: digestFor('policy', 1),
      coverageNodeCount: 2,
      coverageRelationCount: 0,
      assignmentCount: 2,
      consumedOverrideRef: null,
    });
    const roundCompleted = (id: string) =>
      validateAuthoritativeReviewEventV2({ protocolVersion: 2, id, at: AT, type: 'structured_map_review_round_completed', mapReviewRoundId: 'mr-ml-1', coverageCoreRef: makeRef('map_review_coverage_core') });
    // Round completion with ZERO frozen assignments is corrupt.
    await expectCorrupt([...h.events, roundCompleted('evt-ml-round-1')], 'round_completed_with_pending_assignments');
    // The two review workitems freeze their ledgers one at a time.
    const committed: AuthoritativeReviewEventV2[] = [];
    const freezeOne = (i: number): void => {
      const rw = h.createAgentWorkItem({ sessionKind: 'review_map_batch', logicalAssignmentId: `la-ml-${i}`, reviewAssignmentId: `ra-ml-${i}`, roundId: 'mr-ml-1' });
      h.completeAgentCycle({
        workItemId: rw.workItemId,
        logicalAssignmentId: `la-ml-${i}`,
        sessionKind: 'review_map_batch',
        reviewAssignmentId: `ra-ml-${i}`,
        leaseEpoch: 1,
        onStarted: () => {
          const freeze = validateAuthoritativeReviewEventV2({
            protocolVersion: 2, id: `evt-ml-commit-${i}`, at: AT,
            type: 'structured_map_review_assignment_committed',
            assignmentId: `asg-ml-${i}`,
            mapReviewRoundId: 'mr-ml-1',
            workItemId: rw.workItemId,
            attemptId: `att-${rw.workItemId}-1`,
            reviewAssignmentId: `ra-ml-${i}`,
            source: 'batch',
            ledgerRef: makeRef('review_assignment_ledger'),
            coverageTargetCount: 1,
            findingCount: 0,
          });
          committed.push(freeze);
          h.push(freeze as unknown as Record<string, unknown>);
        },
      });
    };
    freezeOne(1);
    // One freeze missing (planned 2, frozen 1): still pending.
    await expectCorrupt([...h.events, roundCompleted('evt-ml-round-2')], 'round_completed_with_pending_assignments');
    freezeOne(2);
    // A duplicate assignment id is corrupt.
    const dup = validateAuthoritativeReviewEventV2({
      ...(committed[1] as unknown as Record<string, unknown>),
      id: 'evt-ml-dup',
      assignmentId: 'asg-ml-1',
    });
    await expectCorrupt([...h.events, dup], 'assignment_duplicate');
    // A forged freeze (foreign workitem identity) is corrupt.
    const forged = validateAuthoritativeReviewEventV2({
      ...(committed[1] as unknown as Record<string, unknown>),
      id: 'evt-ml-forged',
      assignmentId: 'asg-forged',
      workItemId: 'wi-ghost',
      attemptId: 'att-ghost-1',
    });
    await expectCorrupt([...h.events, forged], 'unknown_work_item', h.events.length + 1);
    // The LEGAL map closure (both freezes) passes.
    await projectOk(h.events);
    const full = await projectOk([...h.events.slice(), roundCompleted('evt-ml-round-3')]);
    expect(full.mapRounds['mr-ml-1']?.state).toBe('completed');
  });

  it('R2: sync and async projections are digest-identical WITH a working resolver', async () => {
    const { events, fixtures } = buildReopenOverrideFlow('r2', 'map');
    const asyncResult = await projectAuthoritativeReviewState(events, fixtureResolver(fixtures));
    const syncResult = projectAuthoritativeReviewStateSync(events);
    if (!asyncResult.ok || !syncResult.ok) {
      throw new Error('projection failed');
    }
    expect(projectionDigestOf(asyncResult.state)).toBe(projectionDigestOf(syncResult.state));
    expect(asyncResult.state.availableOverride).toBeNull();
  });

  it('allows a second migration only after the first plan settles and resets its ordinal lineage', () => {
    const firstPlanRef = makeRef('migration_validation_plan_spec');
    const secondPlanRef = makeRef('migration_validation_plan_spec');
    const events = [
      ev({
        type: 'structured_migration_validation_plan_started',
        migrationValidationPlanId: 'mvp-first',
        intentCoreRef: makeRef('migration_intent_core'),
        planSpecRef: firstPlanRef,
      }),
      ev({
        type: 'structured_migration_validation_batch_completed',
        planSpecRef: firstPlanRef,
        batchOrdinal: 0,
        batchResultRootRef: makeRef('migration_validation_batch_result'),
        batchOutcome: 'clear',
      }),
      ev({
        type: 'structured_migration_validation_settlement_completed',
        settlementCoreRef: makeRef('migration_settlement_core'),
        provisionalManifestRef: makeRef('content_revision_manifest'),
        finalizerAggregateRef: makeRef('validator_aggregate'),
        activationDecisionRef: makeRef('migration_activation_decision'),
      }),
      ev({
        type: 'structured_migration_validation_plan_started',
        migrationValidationPlanId: 'mvp-second',
        intentCoreRef: makeRef('migration_intent_core'),
        planSpecRef: secondPlanRef,
      }),
      ev({
        type: 'structured_migration_validation_batch_completed',
        planSpecRef: secondPlanRef,
        batchOrdinal: 0,
        batchResultRootRef: makeRef('migration_validation_batch_result'),
        batchOutcome: 'clear',
      }),
    ];
    const projected = projectAuthoritativeReviewStateSync(events);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.state.migrationValidationPlan).toMatchObject({ migrationValidationPlanId: 'mvp-second' });
    expect(projected.state.migrationBatchOrdinals).toEqual([0]);
    expect(projected.state.migrationSettled).toBe(false);
  });
});
