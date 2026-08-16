import { describe, expect, it } from 'vitest';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { refOfBlob } from '../../authoritative-review/object-registry';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { MapReviewRoundV2, SlotContentVersionV2 } from '../../authoritative-review/authority-types';
import { mapReviewCarrier } from './map-review-service';
import { MigrationServiceV2, type MigrationTargetSlotV2 } from './migration-service';

const hash = (label: string) => canonicalJsonSha256({ label });
const ref = (kind: Parameters<typeof refOfBlob>[0], label: string): BlobRefV2 => refOfBlob(kind, { label });

interface StressModelRun {
  service: MigrationServiceV2;
  objects: Map<string, unknown>;
  completed: Array<{ batchOrdinal: number; batchResultRootRef: BlobRefV2 }>;
  eventRoots: BlobRefV2[];
  targetSlots: MigrationTargetSlotV2[];
  freshInvocations: { value: number };
  currentPlanRef: { value: BlobRefV2 | null };
  postWorkItemId: { value: string };
  refs: {
    sourceMapRef: BlobRefV2; targetMapRef: BlobRefV2; sourceManifestRef: BlobRefV2;
    candidateRef: BlobRefV2; proposedMapCoreRef: BlobRefV2; coverageRef: BlobRefV2;
    reviewRoundRef: BlobRefV2; postAuthorityBaseRef: BlobRefV2; mapSettlementRef: BlobRefV2;
  };
}

function buildStressModelRun(seed?: Pick<StressModelRun, 'objects' | 'completed' | 'eventRoots' | 'targetSlots' | 'freshInvocations' | 'currentPlanRef' | 'postWorkItemId' | 'refs'>): StressModelRun {
  const objects = seed?.objects ?? new Map<string, unknown>();
  const completed = seed?.completed ?? [];
  const eventRoots = seed?.eventRoots ?? [];
  const freshInvocations = seed?.freshInvocations ?? { value: 0 };
  const currentPlanRef = seed?.currentPlanRef ?? { value: null };
  const postWorkItemId = seed?.postWorkItemId ?? { value: '' };
  const refs = seed?.refs ?? {
    sourceMapRef: ref('map_snapshot', '10k-source-map'), targetMapRef: ref('map_snapshot', '10k-target-map'),
    sourceManifestRef: ref('content_revision_manifest', '10k-source-manifest'), candidateRef: ref('map_candidate', '10k-candidate'),
    proposedMapCoreRef: ref('proposed_map_core', '10k-proposed'), coverageRef: ref('map_review_coverage_core', '10k-coverage'),
    reviewRoundRef: ref('map_review_round', '10k-round'), postAuthorityBaseRef: ref('authority_base_set', '10k-post-base'),
    mapSettlementRef: ref('map_review_settlement_core', '10k-map-settlement'),
  };
  const targetSchema = canonicalJsonSha256({ slotType: 'doc' });
  if (!objects.has(refs.reviewRoundRef.digest)) {
    const reviewRound: MapReviewRoundV2 = {
      mapReviewRoundId: 'round-10k', candidateId: 'candidate-10k', candidateDigest: hash('candidate-10k'),
      contentRevisionManifestRef: refs.sourceManifestRef, contentRootDigest: hash('10k-source-root'),
      reviewPolicyDigest: hash('10k-review-policy'), coverageNodeIds: [], coverageRelationIds: [],
      assignmentIds: [], inheritedRecordRefs: [], wholeMapObservationRefs: [], verificationFindingStages: [],
      state: 'completed', settlementRef: refs.mapSettlementRef,
    };
    objects.set(refs.reviewRoundRef.digest, reviewRound);
  }
  const targetSlots = seed?.targetSlots ?? [];
  if (targetSlots.length === 0) {
    const sourceEntries: Array<{ slotId: string; versionRef: BlobRefV2 }> = [];
    for (let index = 0; index < 10_000; index += 1) {
      const slotId = `slot-${String(index).padStart(5, '0')}`;
      const findingStageRootRef = ref('finding_stage_root', `10k-mixed-${slotId}`);
      const mode = index % 101 === 0 ? 'rewrite' : index % 103 === 0 ? 'new' : index % 107 === 0 ? 'carry' : index % 109 === 0 ? 'reset' : 'inherit';
      let source: MigrationTargetSlotV2['source'] = null;
      if (mode !== 'new') {
        const schema = mode === 'reset' ? hash(`old-schema-${slotId}`) : targetSchema;
        const version: SlotContentVersionV2 = mode === 'carry'
          ? {
              state: 'unset', slotId, slotRevision: 1, taskContentRevision: 1, mapRef: refs.sourceMapRef,
              mapSemanticDigest: hash('10k-source-semantic'), contentSchemaDigest: schema, unsetReason: 'initial', unsetProvenance: { kind: 'created_empty' },
            }
          : {
              state: 'set', slotId, slotRevision: 1, taskContentRevision: 1, mapRef: refs.sourceMapRef,
              mapSemanticDigest: hash('10k-source-semantic'), contentSchemaDigest: schema,
              contentDigest: hash(`content-${slotId}`), blobRef: ref('content_value', `10k-content-${slotId}`),
              provenance: {
                kind: 'generated', producer: { kind: 'generation_batch', planRevisionId: 'gp-10k', batchOrdinal: Math.floor(index / 64), attemptId: `att-${index}` },
                contentRevisionCommitCoreRef: ref('content_revision_commit_core', `10k-core-${slotId}`),
                contentCommitValidatorAggregateRef: ref('validator_aggregate', `10k-old-aggregate-${slotId}`),
                contentCommitWarningRootRef: ref('validation_warning_root', `10k-old-warning-${slotId}`), committedByAttemptId: `att-${index}`,
              },
            };
        const versionRef = refOfBlob('content_version', version);
        objects.set(versionRef.digest, version);
        sourceEntries.push({ slotId, versionRef });
        source = { ref: versionRef, value: version };
      }
      targetSlots.push({
        slotId, source, targetContentSchemaDigest: targetSchema, targetPresence: mode === 'carry' ? 'optional' : 'required',
        mixedFindingStageRootRef: mode === 'rewrite' ? findingStageRootRef : null,
      });
    }
    objects.set(refs.sourceManifestRef.digest, {
      taskId: 'task-10k', mapRef: refs.sourceMapRef, mapSemanticDigest: hash('10k-source-semantic'), taskContentRevision: 1,
      manifestPhase: 'finalized', entries: sourceEntries, producerPlanSpecRef: ref('generation_plan_spec', '10k-source-plan'),
      priorManifestRef: null, finalizerValidatorAggregateRefs: [ref('validator_aggregate', '10k-old-finalizer')],
      finalizerWarningRootRefs: [], contentRootDigest: hash('10k-source-root'), manifestDigest: hash('10k-source-manifest'),
    });
    const nodes = targetSlots.map((slot, documentOrder) => ({
      slotId: slot.slotId, slotType: 'doc', contentBearing: true, parentSlotId: null, documentOrder, siblingOrder: documentOrder,
      nodeSpecDigest: hash(`node-${slot.slotId}`),
    }));
    objects.set(refs.targetMapRef.digest, { mapSemanticDigest: hash('10k-target-semantic'), nodes, relations: [] });
    objects.set(refs.proposedMapCoreRef.digest, { nodes, relations: [] });
    objects.set(refs.mapSettlementRef.digest, { coverageCoreRef: refs.coverageRef });
    objects.set(refs.postAuthorityBaseRef.digest, {
      mapCandidateRef: refs.candidateRef, contentRevisionManifestRef: refs.sourceManifestRef,
      reviewCoverageCoreRef: refs.coverageRef, reviewRoundRef: refs.reviewRoundRef,
    });
  }

  const service = new MigrationServiceV2({
    facade: {
      async prepareBlob(_taskId, kind, value) { const blobRef = refOfBlob(kind, value); objects.set(blobRef.digest, value); return blobRef; },
      async publishWithPin(pin) {
        const payload = pin.payload as {
          family?: string;
          publishKind?: string;
          blobRefs?: BlobRefV2[];
          mapReview?: { migrationProgress?: { stage?: string; batchOrdinal?: number | null; batchResultRootRef?: BlobRefV2 | null } };
        };
        if (payload.family === 'domain_publish') {
          const progress = payload.mapReview?.migrationProgress;
          const batchOrdinal = progress?.batchOrdinal;
          const batchResultRootRef = progress?.batchResultRootRef;
          if (progress?.stage === 'batch' && typeof batchOrdinal === 'number' && batchResultRootRef !== null && batchResultRootRef !== undefined) {
            if (!completed.some((entry) => entry.batchOrdinal === batchOrdinal)) {
              completed.push({ batchOrdinal, batchResultRootRef });
              completed.sort((a, b) => a.batchOrdinal - b.batchOrdinal);
              eventRoots.push(batchResultRootRef);
            }
          }
          if (payload.publishKind === 'map_review_settlement') eventRoots.push(...(payload.blobRefs ?? []));
        }
        return {} as never;
      },
    },
    async tail() { return { lastSequence: eventRoots.length, lastCommitId: eventRoots.length === 0 ? null : `commit-${eventRoots.length}` }; },
    templateSnapshotRef: ref('profile_snapshot', '10k-template'), profileSnapshotRef: ref('profile_snapshot', '10k-profile'),
    frozenRegistrationSetDigest: hash('10k-registry'), batchRegistrations: [], migrationPolicyVersion: '1', equivalencePolicyVersion: '1', maxAutomaticRetries: 3,
    clock: () => '2026-08-16T00:00:00.000Z', async resolve(_taskId, blobRef) { return objects.get(blobRef.digest) ?? null; },
    async completedBatches() { return [...completed]; },
    async readCurrentAuthority() {
      const plan = currentPlanRef.value === null ? null : objects.get(currentPlanRef.value.digest) as { migrationValidationPlanId: string };
      return {
        activeMapRef: refs.sourceMapRef, activeManifestRef: refs.sourceManifestRef, currentCandidateRef: refs.candidateRef,
        migrationValidationPlanId: plan?.migrationValidationPlanId ?? null, migrationSettled: false,
        workItemPayloadRef: currentPlanRef.value, workItemAuthorityBaseRef: refs.postAuthorityBaseRef, reviewRoundRef: refs.reviewRoundRef,
        reviewRoundState: 'completed' as const,
      };
    },
    async localValidatorCustody({ slotId }) {
      const source = {
        frozenRegistrationSetDigest: hash('10k-registry'), selectorExpansionDigest: hash(`selector-${slotId}`),
        contentBytesDigest: hash(`bytes-${slotId}`), localMapSubgraphDigest: hash(`subgraph-${slotId}`),
        localRelationContextDigest: hash(`relations-${slotId}`),
      };
      const sourceEnvelope = { source: '10k-equivalence', slotId };
      const sourceBatchInputRef = refOfBlob('validator_input_envelope', sourceEnvelope);
      objects.set(sourceBatchInputRef.digest, sourceEnvelope);
      return {
        sourceBatchInputRef, source,
        // This fast model exercises deterministic high-volume fresh
        // validation. Exact equivalence custody, including 599 inherited
        // versions and sequential Map replacement, is covered by the durable
        // production integration suite where real aggregate/input/warning
        // lineage is available.
        target: { ...source, selectorExpansionDigest: hash(`changed-selector-${slotId}`) },
      };
    },
    async freshValidate({ taskId, slotId, decision, plan, planSpecRef, batchOrdinal }) {
      freshInvocations.value += 1;
      const sourceVersion = objects.get(decision.sourceVersionRef.digest) as SlotContentVersionV2;
      if (sourceVersion.state !== 'set') throw new Error('10k fresh source is not set');
      const intent = objects.get(plan.migrationIntentCoreRef.digest) as { targetMapRef: BlobRefV2 };
      const coreBody = {
        priorManifestRef: plan.sourceManifestRef, producerPlanSpecRef: planSpecRef, batchOrdinal,
        authorizedReplacementEntriesWithoutValidation: [{ slotId, expectedCurrentVersionRef: decision.sourceVersionRef }],
        expectedMapRef: intent.targetMapRef,
      };
      const core = { ...coreBody, coreDigest: canonicalJsonSha256(coreBody) };
      const coreRef = refOfBlob('content_revision_commit_core', core);
      const envelope = {
        trigger: 'content_commit' as const, executionPhase: 'batch_commit' as const, taskId,
        templateSnapshotHash: hash('10k-template-hash'), contentValidationCoreRef: coreRef,
        selectedTargetRefs: [sourceVersion.blobRef],
      };
      const envelopeRef = refOfBlob('validator_input_envelope', envelope);
      const warningBody = {
        trigger: 'content_commit' as const, executionPhase: 'batch_commit' as const,
        inputRef: envelopeRef, inputDigest: envelopeRef.digest, orderedAdvisoryReceiptRefs: [] as BlobRefV2[], warningCount: 0,
      };
      const warning = { ...warningBody, rootDigest: canonicalJsonSha256(warningBody) };
      const warningRootRef = refOfBlob('validation_warning_root', warning);
      const aggregateBody = {
        trigger: 'content_commit' as const, executionPhase: 'batch_commit' as const,
        inputRef: envelopeRef, inputDigest: envelopeRef.digest, registrationSetDigest: plan.frozenRegistrationSetDigest,
        validExecutionDigests: [hash(`10k-valid-${slotId}`)], blockingInvalidReceiptRefs: [] as BlobRefV2[],
        advisoryReceiptRefs: [] as BlobRefV2[], infrastructureFailureRefs: [] as BlobRefV2[], warningRootRef, outcome: 'clear' as const,
      };
      const aggregate = { ...aggregateBody, aggregateDigest: canonicalJsonSha256(aggregateBody) };
      const validatorAggregateRef = refOfBlob('validator_aggregate', aggregate);
      objects.set(coreRef.digest, core);
      objects.set(envelopeRef.digest, envelope);
      objects.set(warningRootRef.digest, warning);
      objects.set(validatorAggregateRef.digest, aggregate);
      return {
        slotResult: { outcome: 'revalidated' as const, slotId, validatorAggregateRef, warningRootRef },
        batchOutcome: 'clear' as const, preparedBlobs: [],
      };
    },
    async runMigrationFinalizer({ taskId, finalizeCoreRef }) {
      const envelope = {
        trigger: 'content_commit' as const, executionPhase: 'plan_finalize' as const, taskId,
        templateSnapshotHash: hash('10k-template-hash'), contentValidationCoreRef: finalizeCoreRef, selectedTargetRefs: [] as BlobRefV2[],
      };
      const envelopeRef = refOfBlob('validator_input_envelope', envelope);
      const warningBody = {
        trigger: 'content_commit' as const, executionPhase: 'plan_finalize' as const,
        inputRef: envelopeRef, inputDigest: envelopeRef.digest, orderedAdvisoryReceiptRefs: [] as BlobRefV2[], warningCount: 0,
      };
      const warning = { ...warningBody, rootDigest: canonicalJsonSha256(warningBody) };
      const finalizerWarningRootRef = refOfBlob('validation_warning_root', warning);
      const aggregateBody = {
        trigger: 'content_commit' as const, executionPhase: 'plan_finalize' as const,
        inputRef: envelopeRef, inputDigest: envelopeRef.digest, registrationSetDigest: hash('10k-registry'),
        validExecutionDigests: [hash('10k-finalizer-valid')], blockingInvalidReceiptRefs: [] as BlobRefV2[],
        advisoryReceiptRefs: [] as BlobRefV2[], infrastructureFailureRefs: [] as BlobRefV2[], warningRootRef: finalizerWarningRootRef,
        outcome: 'clear' as const,
      };
      const aggregate = { ...aggregateBody, aggregateDigest: canonicalJsonSha256(aggregateBody) };
      const finalizerAggregateRef = refOfBlob('validator_aggregate', aggregate);
      objects.set(envelopeRef.digest, envelope);
      objects.set(finalizerWarningRootRef.digest, warning);
      objects.set(finalizerAggregateRef.digest, aggregate);
      return {
        finalizerAggregateRef, finalizerWarningRootRef,
        routeOutcome: 'clear' as const, classifiedFindingSetRef: null, preparedBlobs: [],
      };
    },
    async prepareActivationRoute(input) {
      if (input.route === 'map_repair') {
        return {
          carriers: mapReviewCarrier({
            outcome: 'map_repair', contentRevisionManifestRef: refs.sourceManifestRef,
            mixedContentRepair: { track: 'map' } as never,
          }),
          preparedRefs: [],
        };
      }
      return {
        carriers: mapReviewCarrier({
          mapReviewRoundId: 'round-10k', settlementCoreRef: refs.mapSettlementRef, outcome: 'activate', mapId: 'map-10k', mapRevision: 2,
          supersedesMapId: 'map-old', mapSnapshotRef: refs.targetMapRef, mapReviewBundleRef: ref('map_review_bundle', '10k-bundle'),
          mapSemanticDigest: hash('10k-target-semantic'), contentRevisionManifestRef: input.migratedManifestRef,
          activationValidatorAggregateRef: ref('validator_aggregate', '10k-map-activation'), taskContentRevision: 2,
          manifestPhase: 'finalized', producerPlanSpecRef: null, priorManifestRef: refs.sourceManifestRef,
          contentRound: {
            reviewRoundId: 'content-round-10k', contentCycleOrdinal: 2, mapRef: refs.targetMapRef,
            mapSemanticDigest: hash('10k-target-semantic'), contentRevisionManifestRef: input.migratedManifestRef,
            reviewPolicyDigest: hash('10k-review-policy'), adoptionRootRef: ref('review_adoption_root', '10k-adoption'),
            coverageSlotCount: 10_000, coverageRelationCount: 0, assignmentCount: 1, verificationFindingCount: 0, consumedOverrideRef: null,
          },
          reviewWorkItems: [{ workItemId: 'wi-review-10k' }] as never,
        }),
        preparedRefs: [],
      };
    },
  });
  return { service, objects, completed, eventRoots, targetSlots, freshInvocations, currentPlanRef, postWorkItemId, refs };
}

async function executeStressModelMigration(run: StressModelRun, interruptAt: number | null) {
  const begin = await run.service.beginMigration({
    taskId: 'task-10k', commandId: 'cmd-initial-10k', workItemId: 'wi-initial-10k', leaseEpoch: 1,
    authorityBaseRef: ref('authority_base_set', '10k-initial-base'), mapReviewSettlementCoreRef: run.refs.mapSettlementRef,
    reviewCoverageCoreRef: run.refs.coverageRef, reviewRoundRef: run.refs.reviewRoundRef, candidateRef: run.refs.candidateRef,
    proposedMapCoreRef: run.refs.proposedMapCoreRef, sourceManifestRef: run.refs.sourceManifestRef, sourceMapRef: run.refs.sourceMapRef,
    targetMapRef: run.refs.targetMapRef, impactClosureRef: ref('finding_set', '10k-impact'), targetSlots: run.targetSlots, batchSize: 64,
  });
  run.currentPlanRef.value = begin.migrationValidationPlanSpecRef;
  run.postWorkItemId.value = begin.successorWorkItemId;
  const plan = run.objects.get(begin.migrationValidationPlanSpecRef.digest) as { orderedBatchSlotIds: readonly (readonly string[])[] };
  for (let ordinal = 0; ordinal < plan.orderedBatchSlotIds.length; ordinal += 1) {
    if (interruptAt !== null && ordinal === interruptAt) break;
    const result = await run.service.executeNextBatch({
      taskId: 'task-10k', commandId: `cmd-batch-${ordinal}`, workItemId: `wi-batch-${ordinal}`, leaseEpoch: 1,
      authorityBaseRef: ref('authority_base_set', `10k-batch-base-${ordinal}`), planSpecRef: begin.migrationValidationPlanSpecRef,
      reviewCoverageCoreRef: run.refs.coverageRef, reviewRoundRef: run.refs.reviewRoundRef,
    });
    expect(result.kind).toBe('completed');
  }
  return { begin, batchCount: plan.orderedBatchSlotIds.length };
}

async function finishStressModelMigration(run: StressModelRun, planRef: BlobRefV2, startOrdinal: number, batchCount: number) {
  for (let ordinal = startOrdinal; ordinal < batchCount; ordinal += 1) {
    const result = await run.service.executeNextBatch({
      taskId: 'task-10k', commandId: `cmd-batch-${ordinal}`, workItemId: `wi-batch-${ordinal}`, leaseEpoch: 1,
      authorityBaseRef: ref('authority_base_set', `10k-batch-base-${ordinal}`), planSpecRef: planRef,
      reviewCoverageCoreRef: run.refs.coverageRef, reviewRoundRef: run.refs.reviewRoundRef,
    });
    expect(result.kind).toBe('completed');
  }
  return run.service.executePostMigrationSettlement({
    taskId: 'task-10k', commandId: 'cmd-post-10k', workItemId: run.postWorkItemId.value, leaseEpoch: 1,
    authorityBaseRef: run.refs.postAuthorityBaseRef, planSpecRef: planRef, reviewCoverageCoreRef: run.refs.coverageRef,
    reviewRoundRef: run.refs.reviewRoundRef, settlementOperationId: 'op-post-10k',
  });
}

describe('Task 20 10,000-slot deterministic stress model', () => {
  it('resumes the in-memory model at ordinal 73 and preserves refs, route, roots, and validator counts', async () => {
    const uninterrupted = buildStressModelRun();
    const direct = await executeStressModelMigration(uninterrupted, null);
    expect(direct.batchCount).toBeGreaterThan(73);
    const directPost = await finishStressModelMigration(uninterrupted, direct.begin.migrationValidationPlanSpecRef, direct.batchCount, direct.batchCount);

    const interrupted = buildStressModelRun();
    const partial = await executeStressModelMigration(interrupted, 73);
    expect(interrupted.completed).toHaveLength(73);
    expect(interrupted.completed.map((entry) => entry.batchOrdinal)).toEqual(Array.from({ length: 73 }, (_, index) => index));
    // This fast model reconstructs a fresh service from modeled roots. The
    // production EventStore/projector/GC restart proof lives in the integration
    // suite; this case is only the high-volume deterministic property check.
    const rebuiltCompleted = interrupted.eventRoots.slice(0, 73).map((batchResultRootRef, batchOrdinal) => ({ batchOrdinal, batchResultRootRef }));
    interrupted.completed.splice(0, interrupted.completed.length, ...rebuiltCompleted);
    const resumed = buildStressModelRun(interrupted);
    const resumedPost = await finishStressModelMigration(resumed, partial.begin.migrationValidationPlanSpecRef, 73, partial.batchCount);

    expect(directPost.kind).toBe('completed');
    expect(resumedPost.kind).toBe('completed');
    expect(resumedPost).toEqual(directPost);
    expect(resumed.completed.map((entry) => entry.batchResultRootRef)).toEqual(uninterrupted.completed.map((entry) => entry.batchResultRootRef));
    expect(resumed.eventRoots).toEqual(uninterrupted.eventRoots);
    expect(resumed.freshInvocations.value).toBe(uninterrupted.freshInvocations.value);
    expect(resumed.freshInvocations.value).toBeGreaterThan(0);
    const decisions = (resumedPost.kind === 'completed' ? resumedPost.resultRefs : []).filter((item) => item.kind === 'migration_activation_decision');
    const settlements = (resumedPost.kind === 'completed' ? resumedPost.resultRefs : []).filter((item) => item.kind === 'migration_settlement_core');
    const manifests = (resumedPost.kind === 'completed' ? resumedPost.resultRefs : []).filter((item) => item.kind === 'content_revision_manifest');
    expect(decisions).toHaveLength(1);
    expect(settlements).toHaveLength(1);
    expect(manifests.length).toBeGreaterThanOrEqual(1);
    expect(resumedPost).toMatchObject({ kind: 'completed', route: 'map_repair' });
  }, 120_000);
});
