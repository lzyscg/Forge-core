/**
 * Task 16 review-coordinator (spec §13.1 steps 5-6, design §12.1/§12.3/§12.6/
 * §17.2): the deterministic creation of the Map pre-review WorkItems and the
 * settlement-envelope successor WorkItem.
 *
 * NORMATIVE CORE:
 * - after the round blob + planned coverage core exist, the coordinator creates
 *   EXACTLY `assignmentCount` `review_map_batch` WorkItems plus ONE
 *   `review_map_whole` (whole-Map observation) WorkItem — the round-planned
 *   `assignmentCount` is the projector's frozen closure gate, so the number of
 *   batch assignments MUST equal it;
 * - every review WorkItem carries the Task 13 `review_observation` WriteGrantSpec
 *   (the grant-tension wiring lands HERE): an EMPTY write authority bound to the
 *   assignment/round, satisfying the frozen created-event validator while
 *   preserving "reviewer 不能获得结构槽写 Grant" (design §7/§11.11);
 * - deterministic WorkItem/assignment ids derived from (roundId, index) so
 *   recovery never depends on process state;
 * - the settlement successor: the first `generation_batch` WorkItem + its
 *   `initial_generation_batch` WriteGrantSpec + the deterministic GenerationPlan
 *   spec, folded into the §13.1 activation envelope by the map-review-service
 *   (design §11.11 "只为确定性 generation plan 的首个批次创建 WorkItem/spec").
 *
 * V1 byte-for-byte: new module; v1 surfaces untouched.
 */
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { AuthoritativeAppendFacadeV2 } from '../../storage/authoritative-append-facade';
import type { AuthoritativeReviewProjectionV2 } from '../../storage/authoritative-review-state';
import type {
  AuthoritativeReviewProfile,
  AuthorityBaseSetV2,
  GenerationPlanSpecV2,
  MapPositionNodeV2,
  MapReviewCoverageCoreV2,
  MapReviewRoundV2,
  ReviewPolicyParameters,
  SuccessorWorkItemCarrierV2,
  WriteGrantSpecV2,
} from '../../authoritative-review/authority-types';
import { REVIEW_OBSERVATION_GRANT_KIND } from '../../authoritative-review/authority-types';
import { buildAuthorityBaseSet } from './authority-base';
import type { WorkItemCoordinatorV2 } from './work-item-coordinator';
import type { AuthoritativeReviewEventV2 } from '../../storage/authoritative-review-events';
import type { MapReviewPlanV2 } from './observation-planner';

/** Deterministic review batch WorkItem id (roundId + index). */
export function reviewBatchWorkItemId(roundId: string, index: number): string {
  return `wi-review-${canonicalJsonSha256({ roundId, index }).slice(0, 24)}`;
}

/** Deterministic whole-map observation WorkItem id. */
export function reviewWholeWorkItemId(roundId: string): string {
  return `wi-review-whole-${canonicalJsonSha256({ roundId, label: 'whole' }).slice(0, 24)}`;
}

/** Deterministic review-assignment id of a batch WorkItem. */
export function reviewAssignmentIdOf(roundId: string, index: number): string {
  return `rev-${canonicalJsonSha256({ roundId, index }).slice(0, 24)}`;
}

/** Deterministic whole-map observation assignment id. */
export function reviewWholeAssignmentId(roundId: string): string {
  return `rev-whole-${canonicalJsonSha256({ roundId, label: 'whole' }).slice(0, 24)}`;
}

/** Deterministic operation id of one review-workitem creation (replay-safe). */
export function reviewWorkItemOperationId(taskId: string, workItemId: string): string {
  return `rw-${canonicalJsonSha256({ taskId, workItemId }).slice(0, 32)}`;
}

/** Deterministic first-batch generation WorkItem id. */
export function initialGenerationWorkItemId(taskId: string, generationPlanId: string): string {
  return `wi-gen-${canonicalJsonSha256({ taskId, generationPlanId }).slice(0, 24)}`;
}

export interface ReviewCoordinatorDependencies {
  coordinator: WorkItemCoordinatorV2;
  facade: Pick<AuthoritativeAppendFacadeV2, 'prepareBlob' | 'publishWithPin'>;
  resolver(taskId: string, ref: BlobRefV2): Promise<unknown> | unknown;
  readProjection(taskId: string): Promise<AuthoritativeReviewProjectionV2>;
  readEvents(taskId: string): Promise<readonly AuthoritativeReviewEventV2[]>;
  profile: AuthoritativeReviewProfile;
  reviewPolicy: ReviewPolicyParameters;
  templateSnapshotRef: BlobRefV2;
  profileSnapshotRef: BlobRefV2;
  reviewerRoleBinding: string;
  generatorRoleBinding: string;
  orchestratorRoleBinding: string;
  /** The frozen template snapshot hash (binds every grant spec). */
  snapshotHash: string;
  defaultAutomaticRetries(): Promise<number>;
}

export interface CreateRoundReviewWorkItemsInputV2 {
  taskId: string;
  round: MapReviewRoundV2;
  roundRef: BlobRefV2;
  coverageCoreRef: BlobRefV2;
  mapCandidateRef: BlobRefV2;
  plan: MapReviewPlanV2;
}

export interface CreateRoundReviewWorkItemsResultV2 {
  batchWorkItemIds: string[];
  wholeWorkItemId: string;
  assignmentIds: string[];
}

/**
 * The Task 13 grant-tension wiring: constructs the `review_observation`
 * WriteGrantSpec (EMPTY write authority, bound to assignment/round/base).
 */
export function buildReviewObservationGrantSpec(input: {
  grantSpecId: string;
  workItemId: string;
  authorityBaseRef: BlobRefV2;
  sessionKind: 'review_map_batch' | 'review_map_whole' | 'review_content_batch' | 'review_content_whole' | null;
  reviewAssignmentId: string | null;
  roundId: string | null;
  roundKind: 'map' | 'content' | null;
  snapshotHash: string;
  maxContextBytes: number;
}): WriteGrantSpecV2 {
  const body = {
    grantSpecId: input.grantSpecId,
    workItemId: input.workItemId,
    kind: REVIEW_OBSERVATION_GRANT_KIND,
    snapshotHash: input.snapshotHash,
    authorityBaseRef: input.authorityBaseRef,
    sessionKind: input.sessionKind,
    reviewAssignmentId: input.reviewAssignmentId,
    roundId: input.roundId,
    roundKind: input.roundKind,
    readScope: { maxContextBytes: input.maxContextBytes },
  };
  return { ...body, specDigest: canonicalJsonSha256(body) } as WriteGrantSpecV2;
}

/** The result of preparing the settlement successor (GenerationPlan first batch). */
export interface PreparedGenerationSuccessorV2 {
  generationPlanId: string;
  planSpecRef: BlobRefV2;
  authorityBaseRef: BlobRefV2;
  grantSpecRef: BlobRefV2;
  carrier: SuccessorWorkItemCarrierV2;
  orderedBatchSlotIds: readonly (readonly string[])[];
}

export class ReviewCoordinatorV2 {
  private readonly deps: ReviewCoordinatorDependencies;

  constructor(deps: ReviewCoordinatorDependencies) {
    this.deps = deps;
  }

  /** Creates EXACTLY `assignmentCount` review_map_batch WorkItems + the ONE
   * whole-map observation WorkItem, each with a review_observation grant spec. */
  async createRoundReviewWorkItems(input: CreateRoundReviewWorkItemsInputV2): Promise<CreateRoundReviewWorkItemsResultV2> {
    const { taskId, round, roundRef, coverageCoreRef, mapCandidateRef, plan } = input;
    const count = plan.batches.length;
    const maxAutomaticRetries = await this.deps.defaultAutomaticRetries();
    const batchWorkItemIds: string[] = [];
    const assignmentIds: string[] = [];
    for (let index = 0; index < count; index++) {
      const workItemId = reviewBatchWorkItemId(round.mapReviewRoundId, index);
      const reviewAssignmentId = reviewAssignmentIdOf(round.mapReviewRoundId, index);
      batchWorkItemIds.push(workItemId);
      assignmentIds.push(reviewAssignmentId);
      await this.deps.coordinator.createWorkItem({
        taskId,
        operationId: reviewWorkItemOperationId(taskId, workItemId),
        workItemId,
        kind: 'agent_assignment',
        roleBinding: this.deps.reviewerRoleBinding,
        agentExecutionKind: 'structured_session',
        sessionKind: 'review_map_batch',
        roundId: round.mapReviewRoundId,
        logicalAssignmentId: `la-${workItemId}`,
        reviewAssignmentId,
        payload: { kind: 'map_review_round', value: round },
        authorityBase: buildAuthorityBaseSet({
          taskId,
          templateSnapshotRef: this.deps.templateSnapshotRef,
          profileSnapshotRef: this.deps.profileSnapshotRef,
          refs: { mapCandidateRef, reviewCoverageCoreRef: coverageCoreRef, reviewRoundRef: roundRef },
          kind: 'agent_assignment',
          agentExecutionKind: 'structured_session',
          sessionKind: 'review_map_batch',
        }),
        grantSpec: {
          build: (baseRef) =>
            buildReviewObservationGrantSpec({
              grantSpecId: `gs-${workItemId}`,
              workItemId,
              authorityBaseRef: baseRef,
              sessionKind: 'review_map_batch',
              reviewAssignmentId,
              roundId: round.mapReviewRoundId,
              roundKind: 'map',
              snapshotHash: this.deps.snapshotHash,
              maxContextBytes: this.deps.profile.assignmentMaxTotalObjects,
            }),
        },
        maxAutomaticRetries,
      });
    }
    const wholeWorkItemId = reviewWholeWorkItemId(round.mapReviewRoundId);
    const wholeReviewAssignmentId = reviewWholeAssignmentId(round.mapReviewRoundId);
    assignmentIds.push(wholeReviewAssignmentId);
    await this.deps.coordinator.createWorkItem({
      taskId,
      operationId: reviewWorkItemOperationId(taskId, wholeWorkItemId),
      workItemId: wholeWorkItemId,
      kind: 'agent_assignment',
      roleBinding: this.deps.reviewerRoleBinding,
      agentExecutionKind: 'structured_session',
      sessionKind: 'review_map_whole',
      roundId: round.mapReviewRoundId,
      logicalAssignmentId: `la-${wholeWorkItemId}`,
      reviewAssignmentId: wholeReviewAssignmentId,
      payload: { kind: 'map_review_round', value: round },
      authorityBase: buildAuthorityBaseSet({
        taskId,
        templateSnapshotRef: this.deps.templateSnapshotRef,
        profileSnapshotRef: this.deps.profileSnapshotRef,
        refs: { mapCandidateRef, reviewCoverageCoreRef: coverageCoreRef, reviewRoundRef: roundRef },
        kind: 'agent_assignment',
        agentExecutionKind: 'structured_session',
        sessionKind: 'review_map_whole',
      }),
      grantSpec: {
        build: (baseRef) =>
          buildReviewObservationGrantSpec({
            grantSpecId: `gs-${wholeWorkItemId}`,
            workItemId: wholeWorkItemId,
            authorityBaseRef: baseRef,
            sessionKind: 'review_map_whole',
            reviewAssignmentId: wholeReviewAssignmentId,
            roundId: round.mapReviewRoundId,
            roundKind: 'map',
            snapshotHash: this.deps.snapshotHash,
            maxContextBytes: this.deps.profile.assignmentMaxTotalObjects,
          }),
      },
      maxAutomaticRetries,
    });
    return { batchWorkItemIds, wholeWorkItemId, assignmentIds };
  }

  /**
   * Creates the `system_review_settlement` WorkItem (the ONLY activator) after
   * the round is completed. Its authority base binds mapCandidateRef +
   * reviewCoverageCoreRef (FINAL) + reviewRoundRef; the matrix amendment makes
   * contentRevisionManifestRef OPTIONAL so the initial activation (no content
   * yet) is legal while post-migration settlement still binds the manifest.
   */
  async createSettlementWorkItem(input: {
    taskId: string;
    workItemId: string;
    authorityBase: AuthorityBaseSetV2;
    coverageCore: MapReviewCoverageCoreV2;
    maxAutomaticRetries: number;
  }): Promise<void> {
    await this.deps.coordinator.createWorkItem({
      taskId: input.taskId,
      operationId: reviewWorkItemOperationId(input.taskId, input.workItemId),
      workItemId: input.workItemId,
      kind: 'system_review_settlement',
      roleBinding: null,
      agentExecutionKind: null,
      sessionKind: null,
      roundId: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      payload: { kind: 'map_review_coverage_core', value: input.coverageCore },
      authorityBase: input.authorityBase,
      grantSpecRef: null,
      maxAutomaticRetries: input.maxAutomaticRetries,
      initialLeaseEpoch: 0,
    });
  }

  /**
   * Prepares the deterministic GenerationPlan spec + the first generation-batch
   * WorkItem's AuthorityBase/GrantSpec and returns the §9.2 successor carrier
   * the settlement handler folds into the activation envelope (design §11.11).
   */
  async prepareGenerationSuccessor(input: {
    taskId: string;
    mapId: string;
    mapSnapshotRef: BlobRefV2;
    mapSemanticDigest: string;
    manifestRef: BlobRefV2;
    contentBearingSlots: readonly { slotId: string; documentOrder: number }[];
    profileSnapshotRef: BlobRefV2;
    templateSnapshotRef: BlobRefV2;
  }): Promise<PreparedGenerationSuccessorV2> {
    const { taskId, mapId, mapSnapshotRef, mapSemanticDigest, manifestRef, contentBearingSlots } = input;
    const batchSize = Math.max(1, this.deps.reviewPolicy.contentBatchTargetSlots);
    const ordered = [...contentBearingSlots].sort(
      (a, b) => a.documentOrder - b.documentOrder || (a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0),
    );
    const orderedBatchSlotIds: string[][] = [];
    for (let i = 0; i < ordered.length; i += batchSize) {
      orderedBatchSlotIds.push(ordered.slice(i, i + batchSize).map((s) => s.slotId));
    }
    const generationPlanId = `gp-${canonicalJsonSha256({ mapId, label: 'initial-generation' }).slice(0, 24)}`;
    const planBody: Omit<GenerationPlanSpecV2, 'specDigest'> = {
      generationPlanId,
      revision: 1,
      supersedesGenerationPlanId: null,
      sourceValidationReceiptRef: null,
      activeMapRef: mapSnapshotRef,
      baseContentRevisionManifestRef: manifestRef,
      importedContentManifestRef: manifestRef,
      correctionScopeDigest: null,
      orderedBatchSlotIds,
    };
    const planSpec: GenerationPlanSpecV2 = { ...planBody, specDigest: canonicalJsonSha256(planBody) };
    const planSpecRef = await this.deps.facade.prepareBlob(taskId, 'generation_plan_spec', planSpec);
    const workItemId = initialGenerationWorkItemId(taskId, generationPlanId);
    const authorityBase = buildAuthorityBaseSet({
      taskId,
      templateSnapshotRef: this.deps.templateSnapshotRef,
      profileSnapshotRef: this.deps.profileSnapshotRef,
      refs: { mapRef: mapSnapshotRef, contentRevisionManifestRef: manifestRef, planSpecRef },
      kind: 'agent_assignment',
      agentExecutionKind: 'structured_session',
      sessionKind: 'generation_batch',
    });
    const authorityBaseRef = await this.deps.facade.prepareBlob(taskId, 'authority_base_set', authorityBase);
    const firstBatchSlotIds = orderedBatchSlotIds[0] ?? [];
    const grantBody = {
      grantSpecId: `gs-${workItemId}`,
      workItemId,
      kind: 'initial_generation_batch' as const,
      snapshotHash: this.deps.snapshotHash,
      authorityBaseRef,
      generationPlanSpecRef: planSpecRef,
      activeMapRef: mapSnapshotRef,
      expectedContentRevisionManifestRef: manifestRef,
      writeSlotIds: firstBatchSlotIds,
      readScope: { maxContextBytes: this.deps.profile.assignmentMaxTotalObjects },
    };
    const grantSpec = { ...grantBody, specDigest: canonicalJsonSha256(grantBody) } as WriteGrantSpecV2;
    const grantSpecRef = await this.deps.facade.prepareBlob(taskId, 'write_grant_spec', grantSpec);
    const maxAutomaticRetries = await this.deps.defaultAutomaticRetries();
    const carrier: SuccessorWorkItemCarrierV2 = {
      workItemId,
      kind: 'agent_assignment',
      roleBinding: this.deps.generatorRoleBinding,
      agentExecutionKind: 'structured_session',
      sessionKind: 'generation_batch',
      roundId: null,
      logicalAssignmentId: `la-${workItemId}`,
      reviewAssignmentId: null,
      grantSpecRef,
      inputArtifactDeliveryId: null,
      authorityBaseRef,
      payloadRef: planSpecRef,
      initialLeaseEpoch: 0,
      maxAutomaticRetries,
    };
    return { generationPlanId, planSpecRef, authorityBaseRef, grantSpecRef, carrier, orderedBatchSlotIds };
  }

  /** The deterministic content-bearing slot list of the candidate (Map node list). */
  static contentBearingSlotsOf(nodes: readonly MapPositionNodeV2[]): { slotId: string; documentOrder: number }[] {
    return nodes
      .filter((n) => n.contentBearing)
      .map((n) => ({ slotId: n.slotId, documentOrder: n.documentOrder }))
      .sort((a, b) => a.documentOrder - b.documentOrder || (a.slotId < b.slotId ? -1 : 1));
  }
}
