import { describe, expect, it } from 'vitest';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { refOfBlob } from '../../authoritative-review/object-registry';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { SlotContentVersionV2 } from '../../authoritative-review/authority-types';
import { validateMigrationSuccessorCarrier } from './work-item-coordinator';
import { mapReviewCarrier } from './map-review-service';
import {
  buildMigrationActivationDecision,
  buildContentMigrationSpec,
  buildMigrationValidationPlanSpec,
  buildMigrationValidationBatchResult,
  buildMigratedProvisionalManifest,
  MigrationServiceV2,
  buildMigrationProgressEvents,
  buildMigrationFinalizeCore,
  buildMigrationIntent,
  buildMigrationSettlement,
  classifyMigrationSlot,
  combineMigrationRoute,
  nextMissingMigrationBatchOrdinal,
  proveLocalValidatorEquivalence,
  validateMigrationBatchClosure,
  validateMigrationActivationRouteCarriers,
  validateAndClassifyMigrationBatchResults,
  classifyAndUnionMigrationFindingSets,
  createProductionMigrationRuntime,
} from './migration-service';
import { ValidatorRegistry } from './validator-registry';
import { SystemCommandRegistry, SYSTEM_COMMAND_NOT_IMPLEMENTED_CODE } from './system-command-registry';
import {
  AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES,
  builtinSourceOf,
} from './builtin-validators';
import { buildAuthoritativeReviewTestProfileBody } from '../../structured-slots/test-support/authoritative-review-test-registry';
import type { ValidatorRegistrationV2 } from '../../template/structured-slot-contract-v2';

const digest = (label: string): string => canonicalJsonSha256({ label });
const ref = (kind: Parameters<typeof refOfBlob>[0], label: string): BlobRefV2 => refOfBlob(kind, { label });

function builtinRegistration(handlerKey: string): ValidatorRegistrationV2 {
  const entry = AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES.find((candidate) => candidate.handlerKey === handlerKey);
  if (entry === undefined) throw new Error(`missing builtin ${handlerKey}`);
  return {
    validatorId: `v-${handlerKey.split('.').pop()}`,
    handlerKey: entry.handlerKey,
    implementationDigest: entry.implementationDigest,
    implementationRef: { kind: 'builtin', moduleId: entry.moduleId, exportName: entry.exportName },
    trigger: entry.trigger,
    executionPhase: entry.executionPhase,
    selector: { kind: 'all' },
    enforcement: 'blocking',
    deterministic: true,
    inputContractVersion: entry.inputContractVersion,
    outputContractVersion: entry.outputContractVersion,
    budgetProfileId: entry.budgetProfileId,
  };
}

function setVersion(slotId: string, schema = digest('schema')): { ref: BlobRefV2; value: SlotContentVersionV2 } {
  const value: SlotContentVersionV2 = {
    state: 'set',
    slotId,
    slotRevision: 1,
    taskContentRevision: 7,
    mapRef: ref('map_snapshot', 'source-map'),
    mapSemanticDigest: digest('source-semantic'),
    contentSchemaDigest: schema,
    contentDigest: digest(`content:${slotId}`),
    blobRef: ref('content_value', `body:${slotId}`),
    provenance: {
      kind: 'generated',
      producer: { kind: 'generation_batch', planRevisionId: 'gp-1', batchOrdinal: 1, attemptId: 'att-1' },
      contentRevisionCommitCoreRef: ref('content_revision_commit_core', `commit:${slotId}`),
      contentCommitValidatorAggregateRef: ref('validator_aggregate', `aggregate:${slotId}`),
      contentCommitWarningRootRef: ref('validation_warning_root', `warnings:${slotId}`),
      committedByAttemptId: 'att-1',
    },
  };
  return { ref: ref('content_version', `version:${slotId}`), value };
}

function unsetVersion(slotId: string): { ref: BlobRefV2; value: SlotContentVersionV2 } {
  const value: SlotContentVersionV2 = {
    state: 'unset',
    slotId,
    slotRevision: 1,
    taskContentRevision: 7,
    mapRef: ref('map_snapshot', 'source-map'),
    mapSemanticDigest: digest('source-semantic'),
    contentSchemaDigest: digest('schema'),
    unsetReason: 'initial',
    unsetProvenance: { kind: 'created_empty' },
  };
  return { ref: ref('content_version', `unset:${slotId}`), value };
}

describe('Task 20 migration action coverage', () => {
  it('constructs exactly one frozen action for compatible set, optional unset, mixed, new, and schema reset slots', () => {
    const set = setVersion('set');
    const optional = unsetVersion('optional');
    const mixed = setVersion('mixed');
    const reset = setVersion('reset', digest('old-schema'));
    const common = {
      taskId: 'task-1',
      sourceMapRef: ref('map_snapshot', 'source-map'),
      targetMapRef: ref('map_snapshot', 'target-map'),
      stableIdentityEvidenceRef: ref('finding', 'stable'),
      proofPolicyVersion: '1',
    };
    const cases = [
      classifyMigrationSlot({ ...common, slotId: 'set', source: set, targetContentSchemaDigest: digest('schema'), targetPresence: 'required', mixedFindingStageRootRef: null }),
      classifyMigrationSlot({ ...common, slotId: 'optional', source: optional, targetContentSchemaDigest: digest('schema'), targetPresence: 'optional', mixedFindingStageRootRef: null }),
      classifyMigrationSlot({ ...common, slotId: 'mixed', source: mixed, targetContentSchemaDigest: digest('schema'), targetPresence: 'required', mixedFindingStageRootRef: ref('finding_stage_root', 'mixed') }),
      classifyMigrationSlot({ ...common, slotId: 'new', source: null, targetContentSchemaDigest: digest('schema'), targetPresence: 'required', mixedFindingStageRootRef: null }),
      classifyMigrationSlot({ ...common, slotId: 'reset', source: reset, targetContentSchemaDigest: digest('new-schema'), targetPresence: 'required', mixedFindingStageRootRef: null }),
    ];
    expect(cases.map((c) => c.decision.action)).toEqual([
      'inherit_or_validate',
      'carry_unset',
      'rewrite_required',
      'new_or_schema_reset',
      'new_or_schema_reset',
    ]);
    expect(cases[3].decision).toMatchObject({ unsetReason: 'new_slot', sourceVersionRef: null });
    expect(cases[4].decision).toMatchObject({ unsetReason: 'schema_reset', sourceVersionRef: reset.ref });
  });

  it('never carries a required unset and routes it to rewrite-required', () => {
    const source = unsetVersion('required');
    const result = classifyMigrationSlot({
      taskId: 'task-1', slotId: 'required', source,
      sourceMapRef: ref('map_snapshot', 'source-map'), targetMapRef: ref('map_snapshot', 'target-map'),
      targetContentSchemaDigest: digest('schema'), targetPresence: 'required',
      stableIdentityEvidenceRef: ref('finding', 'stable'), proofPolicyVersion: '1',
      mixedFindingStageRootRef: ref('finding_stage_root', 'required-unset'),
    });
    expect(result.decision.action).toBe('rewrite_required');
  });
});

describe('Task 20 local validator custody', () => {
  const base = {
    slotId: 'slot-1',
    sourceVersionRef: ref('content_version', 'version'),
    sourceMapRef: ref('map_snapshot', 'source-map'),
    targetMapRef: ref('map_snapshot', 'target-map'),
    sourceBatchInputRef: ref('validator_input_envelope', 'old-input'),
    equivalencePolicyVersion: '1',
    source: {
      frozenRegistrationSetDigest: digest('regs'),
      selectorExpansionDigest: digest('selectors'),
      contentBytesDigest: digest('bytes'),
      localMapSubgraphDigest: digest('subgraph'),
      localRelationContextDigest: digest('relations'),
    },
  };

  it('issues a proof only when all five frozen custody dimensions are byte-equivalent', () => {
    const result = proveLocalValidatorEquivalence({ ...base, target: { ...base.source } });
    expect(result.kind).toBe('equivalent');
    if (result.kind === 'equivalent') {
      expect(result.proof.frozenRegistrationSetDigest).toBe(digest('regs'));
      const { proofDigest, ...body } = result.proof;
      expect(proofDigest).toBe(canonicalJsonSha256(body));
    }
  });

  it.each(['frozenRegistrationSetDigest', 'selectorExpansionDigest', 'contentBytesDigest', 'localMapSubgraphDigest', 'localRelationContextDigest'] as const)(
    'requires fresh target validation when %s differs',
    (field) => {
      const result = proveLocalValidatorEquivalence({ ...base, target: { ...base.source, [field]: digest(`changed:${field}`) } });
      expect(result).toEqual({ kind: 'fresh_validation_required', changedDimensions: [field] });
    },
  );
});

describe('Task 20 recoverable plan and route settlement', () => {
  const planRef = ref('migration_validation_plan_spec', 'plan');
  const resultRef0 = ref('migration_validation_batch_result', 'result-0');
  const resultRef1 = ref('migration_validation_batch_result', 'result-1');

  it('resumes at the first missing ordinal and refuses gaps/duplicates before settlement', () => {
    const plan = { orderedBatchSlotIds: [['a'], ['b'], ['c']] };
    expect(nextMissingMigrationBatchOrdinal(plan, [{ batchOrdinal: 0, batchResultRootRef: resultRef0 }, { batchOrdinal: 1, batchResultRootRef: resultRef1 }])).toBe(2);
    expect(() => validateMigrationBatchClosure(plan, [{ batchOrdinal: 1, batchResultRootRef: resultRef1 }])).toThrow(/ordinal 0/);
    expect(() => validateMigrationBatchClosure(plan, [{ batchOrdinal: 0, batchResultRootRef: resultRef0 }, { batchOrdinal: 0, batchResultRootRef: resultRef0 }])).toThrow(/duplicate/);
  });

  it('freezes ordered result roots and never mutates the immutable intent', () => {
    const intent = buildMigrationIntent({
      taskId: 'task-1', migrationSpecRef: ref('migration_spec', 'spec'), sourceManifestRef: ref('content_revision_manifest', 'source-manifest'),
      sourceMapRef: ref('map_snapshot', 'source-map'), targetMapRef: ref('map_snapshot', 'target-map'), decisions: [],
      impactClosureRef: ref('finding_set', 'impact'), migrationPolicyVersion: '1',
    });
    const intentBefore = JSON.stringify(intent);
    const settlement = buildMigrationSettlement({
      migrationIntentCoreRef: ref('migration_intent_core', 'intent'), migrationValidationPlanSpecRef: planRef,
      orderedBatches: [{ batchOrdinal: 0, batchResultRootRef: resultRef0 }, { batchOrdinal: 1, batchResultRootRef: resultRef1 }],
      decisions: [], batchClassifiedFindingSetRef: null, batchRouteOutcome: 'clear',
    });
    expect(settlement.orderedBatchResultRootRefs).toEqual([resultRef0, resultRef1]);
    expect(JSON.stringify(intent)).toBe(intentBefore);
  });

  it('freezes the spec, candidate-bound plan, and batch result identities independently', () => {
    const spec = buildContentMigrationSpec({
      migrationId: 'migration-1', mapReviewSettlementCoreRef: ref('map_review_settlement_core', 'map-settlement'),
      sourceManifestRef: ref('content_revision_manifest', 'source-manifest'), sourceMapRef: ref('map_snapshot', 'source-map'),
      targetMapRef: ref('map_snapshot', 'target-map'), impactClosureRef: ref('finding_set', 'impact'), migrationPolicyVersion: '1',
    });
    const specRef = ref('migration_spec', 'spec-frozen');
    const intentRef = ref('migration_intent_core', 'intent-frozen');
    const plan = buildMigrationValidationPlanSpec({
      migrationValidationPlanId: 'mvp-1', migrationIntentCoreRef: intentRef,
      candidateRef: ref('map_candidate', 'candidate'), proposedMapCoreRef: ref('proposed_map_core', 'proposed'),
      sourceManifestRef: spec.sourceManifestRef, frozenRegistrationSetDigest: digest('registrations'),
      orderedBatchSlotIds: [['a', 'b'], ['c']], profileRef: ref('profile_snapshot', 'profile'),
    });
    const planRefBuilt = ref('migration_validation_plan_spec', plan.specDigest);
    const batch = buildMigrationValidationBatchResult({
      migrationValidationPlanSpecRef: planRefBuilt, batchOrdinal: 0, slotResults: [], batchOutcome: 'clear',
    });
    expect(spec.specDigest).toBeTruthy();
    expect(plan.specDigest).toBeTruthy();
    expect(batch.resultDigest).toBeTruthy();
    expect(specRef).not.toEqual(intentRef);
  });

  it.each([
    ['clear', 'clear', 'clear'],
    ['content_repair', 'clear', 'content_repair'],
    ['clear', 'content_repair', 'content_repair'],
    ['content_repair', 'map_repair', 'map_repair'],
    ['map_repair', 'content_repair', 'map_repair'],
    ['clear', 'infrastructure_failure', 'infrastructure_failure'],
  ] as const)('combines batch=%s and finalizer=%s into %s', (batch, finalizer, expected) => {
    expect(combineMigrationRoute(batch, finalizer)).toBe(expected);
  });

  it('enforces the system-owned clear/content/map activation contracts', () => {
    const finalized = ref('content_revision_manifest', 'route-finalized');
    const provisional = ref('content_revision_manifest', 'route-provisional');
    const contentRepair = { track: 'content', successor: {} } as never;
    const mapRepair = { track: 'map', successor: {} } as never;
    const reviewRound = { reviewRoundId: 'review-after-migration' } as never;
    const reviewWorkItem = { workItemId: 'review-after-migration-1' } as never;
    expect(() => validateMigrationActivationRouteCarriers('clear', mapReviewCarrier({
      outcome: 'activate',
      contentRevisionManifestRef: finalized,
      manifestPhase: 'finalized',
      contentRound: reviewRound,
      reviewWorkItems: [reviewWorkItem],
    }), finalized)).not.toThrow();
    expect(() => validateMigrationActivationRouteCarriers('content_repair', mapReviewCarrier({ outcome: 'activate', contentRevisionManifestRef: provisional, manifestPhase: 'provisional', mixedContentRepair: contentRepair }), provisional)).not.toThrow();
    expect(() => validateMigrationActivationRouteCarriers('map_repair', mapReviewCarrier({ outcome: 'map_repair', contentRevisionManifestRef: ref('content_revision_manifest', 'old'), mixedContentRepair: mapRepair }), provisional)).not.toThrow();
    expect(() => validateMigrationActivationRouteCarriers('map_repair', mapReviewCarrier({ outcome: 'activate', contentRevisionManifestRef: provisional, mixedContentRepair: mapRepair }), provisional)).toThrow(/must not activate/);
    expect(() => validateMigrationActivationRouteCarriers('content_repair', mapReviewCarrier({ outcome: 'activate', contentRevisionManifestRef: provisional, manifestPhase: 'provisional' }), provisional)).toThrow(/ContentRepairPlan/);
    expect(() => validateMigrationActivationRouteCarriers('clear', mapReviewCarrier({ outcome: 'activate', contentRevisionManifestRef: finalized, manifestPhase: 'finalized' }), finalized)).toThrow(/content review round/);
  });

  it('builds the only legal preactivation finalizer context and four-way activation decision', () => {
    const finalize = buildMigrationFinalizeCore({
      producerPlanSpecRef: planRef,
      provisionalManifestRef: ref('content_revision_manifest', 'provisional'),
      candidateRef: ref('map_candidate', 'candidate'), proposedMapCoreRef: ref('proposed_map_core', 'proposed'),
      targetMapRef: ref('map_snapshot', 'target-map'), migrationSettlementCoreRef: ref('migration_settlement_core', 'settlement'),
      settlementOperationId: 'op-post', expectedContentRootDigest: digest('content-root'),
      requiredSlotCoverageDigest: digest('coverage'), expectedBatchClosureDigest: digest('closure'),
    });
    expect(finalize.mapContext).toMatchObject({ kind: 'migration_preactivation', settlementOperationId: 'op-post' });
    const finalizeRef = ref('content_plan_finalize_core', 'finalize');
    const decision = buildMigrationActivationDecision({
      migrationSettlementCoreRef: ref('migration_settlement_core', 'settlement'),
      provisionalManifestRef: ref('content_revision_manifest', 'provisional'), contentPlanFinalizeCoreRef: finalizeRef,
      finalizerAggregateRef: ref('validator_aggregate', 'finalizer'), combinedClassifiedFindingSetRef: null,
      batchRouteOutcome: 'clear', finalizerRouteOutcome: 'content_repair', decisionPolicyVersion: '1',
    });
    expect(decision.combinedRouteOutcome).toBe('content_repair');
  });

  it('rebases every settlement outcome onto the target Map without relabeling source versions', () => {
    const sourceSet = setVersion('set');
    const sourceMixed = setVersion('mixed');
    const sourceUnset = unsetVersion('optional');
    const settlementRef = ref('migration_settlement_core', 'settlement-manifest');
    const proofRef = ref('content_compatibility_proof', 'proof-manifest');
    const localProofRef = ref('local_validator_equivalence_proof', 'local-proof-manifest');
    const findingStageRootRef = ref('finding_stage_root', 'mixed-manifest');
    const built = buildMigratedProvisionalManifest({
      taskId: 'task-1', targetMapRef: ref('map_snapshot', 'target-map'), targetMapSemanticDigest: digest('target-semantic'),
      taskContentRevision: 8, producerPlanSpecRef: planRef, priorManifestRef: ref('content_revision_manifest', 'source-manifest'),
      migrationSettlementCoreRef: settlementRef,
      decisions: [
        { outcome: 'inherit_equivalent', slotId: 'set', sourceVersionRef: sourceSet.ref, compatibilityProofRef: proofRef, localValidatorEquivalenceProofRef: localProofRef },
        { outcome: 'carry_unset', slotId: 'optional', sourceVersionRef: sourceUnset.ref, compatibilityProofRef: proofRef },
        { outcome: 'unset', slotId: 'new', unsetReason: 'new_slot' },
        { outcome: 'rewrite_required', slotId: 'mixed', sourceVersionRef: sourceMixed.ref, rewriteCause: 'mixed_rewrite_required', blockingValidatorAggregateRef: null, validationReceiptRef: null, findingStageRootRef },
      ],
      sourceVersions: new Map([[sourceSet.ref.digest, sourceSet.value], [sourceMixed.ref.digest, sourceMixed.value], [sourceUnset.ref.digest, sourceUnset.value]]),
      targetSchemaDigestOf: (slotId) => digest(`schema:${slotId}`),
    });
    expect(built.manifest.manifestPhase).toBe('provisional');
    expect(built.manifest.entries.map((entry) => entry.slotId)).toEqual(['mixed', 'new', 'optional', 'set']);
    expect(built.versions.get('set')).toMatchObject({ state: 'set', mapRef: ref('map_snapshot', 'target-map'), provenance: { kind: 'inherited_after_map_activation', sourceVersionRef: sourceSet.ref } });
    expect(built.versions.get('optional')).toMatchObject({ state: 'unset', unsetReason: 'carried_optional_unset' });
    expect(built.versions.get('mixed')).toMatchObject({ state: 'rewrite_required', rewriteCause: { kind: 'mixed_rewrite_required', findingStageRootRef } });
    expect(sourceSet.value.mapRef).toEqual(ref('map_snapshot', 'source-map'));
  });
});

describe('Task 20 authoritative migration result classification', () => {
  const planRef = ref('migration_validation_plan_spec', 'closure-plan');
  const plan = buildMigrationValidationPlanSpec({
    migrationValidationPlanId: 'mvp-closure', migrationIntentCoreRef: ref('migration_intent_core', 'closure-intent'),
    candidateRef: ref('map_candidate', 'closure-candidate'), proposedMapCoreRef: ref('proposed_map_core', 'closure-proposed'),
    sourceManifestRef: ref('content_revision_manifest', 'closure-manifest'), frozenRegistrationSetDigest: digest('closure-regs'),
    orderedBatchSlotIds: [['slot-a'], ['slot-b']], profileRef: ref('profile_snapshot', 'closure-profile'),
  });

  it('rejects swapped ordinals, omitted slots, and a caller-claimed clear rejection', async () => {
    const objects = new Map<string, unknown>();
    const finding = {
      findingId: 'finding-content', reviewContext: { kind: 'content' as const, roundId: 'migration-closure' },
      primaryLocation: { kind: 'slot' as const, id: 'slot-a' }, relatedSlotIds: ['slot-a'], relatedRelationIds: [],
      defectClass: 'content' as const, severity: 'blocking' as const, source: 'system_validator' as const,
      evidence: [], suggestedRepairSlotIds: ['slot-a'], status: 'open' as const,
      repairProgress: { map: 'not_required' as const, content: 'pending' as const },
      openedBy: { kind: 'system_validator' as const, validatorExecutionId: 'validator-content' },
    };
    const findingRef = refOfBlob('finding', finding);
    const setBody = { findingSetId: 'set-content', findingRefs: [findingRef] };
    const findingSet = { ...setBody, setDigest: canonicalJsonSha256(setBody) };
    const findingSetRef = refOfBlob('finding_set', findingSet);
    const rejectedAggregateRef = ref('validator_aggregate', 'closure-rejected-aggregate');
    objects.set(findingRef.digest, finding);
    objects.set(findingSetRef.digest, findingSet);
    objects.set(rejectedAggregateRef.digest, { outcome: 'blocking_invalid' });
    const result = buildMigrationValidationBatchResult({
      migrationValidationPlanSpecRef: planRef, batchOrdinal: 0,
      slotResults: [{ outcome: 'rejected', slotId: 'slot-a', validatorAggregateRef: rejectedAggregateRef, validationReceiptRef: ref('validation_receipt', 'closure-receipt'), findingSetRef }],
      batchOutcome: 'clear',
    });
    const resultRef = refOfBlob('migration_validation_batch_result', result);
    objects.set(resultRef.digest, result);
    const resolve = async (blobRef: BlobRefV2) => objects.get(blobRef.digest) ?? null;
    await expect(validateAndClassifyMigrationBatchResults({ plan, planSpecRef: planRef, orderedResultRefs: [resultRef], resolve })).rejects.toThrow(/batch outcome.*content_repair/);

    const swapped = buildMigrationValidationBatchResult({
      migrationValidationPlanSpecRef: planRef, batchOrdinal: 1, slotResults: result.slotResults, batchOutcome: 'content_repair',
    });
    const swappedRef = refOfBlob('migration_validation_batch_result', swapped);
    objects.set(swappedRef.digest, swapped);
    await expect(validateAndClassifyMigrationBatchResults({ plan, planSpecRef: planRef, orderedResultRefs: [swappedRef], resolve })).rejects.toThrow(/ordinal 0/);

    const omitted = buildMigrationValidationBatchResult({ migrationValidationPlanSpecRef: planRef, batchOrdinal: 0, slotResults: [], batchOutcome: 'clear' });
    const omittedRef = refOfBlob('migration_validation_batch_result', omitted);
    objects.set(omittedRef.digest, omitted);
    await expect(validateAndClassifyMigrationBatchResults({ plan, planSpecRef: planRef, orderedResultRefs: [omittedRef], resolve })).rejects.toThrow(/slot set/);
  });

  it('unions batch-content and finalizer-map Findings canonically and routes Map repair', async () => {
    const objects = new Map<string, unknown>();
    const setRefs = (['content', 'map'] as const).map((defectClass) => {
      const finding = {
        findingId: `finding-${defectClass}`, reviewContext: { kind: 'content' as const, roundId: 'migration-union' },
        primaryLocation: defectClass === 'content' ? { kind: 'slot' as const, id: 'slot-a' } : { kind: 'map' as const, id: 'map' },
        relatedSlotIds: defectClass === 'content' ? ['slot-a'] : [], relatedRelationIds: [], defectClass,
        severity: 'blocking' as const, source: 'system_validator' as const, evidence: [],
        suggestedRepairSlotIds: defectClass === 'content' ? ['slot-a'] : [], status: 'open' as const,
        repairProgress: defectClass === 'content'
          ? { map: 'not_required' as const, content: 'pending' as const }
          : { map: 'pending' as const, content: 'not_required' as const },
        openedBy: { kind: 'system_validator' as const, validatorExecutionId: `validator-${defectClass}` },
      };
      const findingRef = refOfBlob('finding', finding);
      objects.set(findingRef.digest, finding);
      const body = { findingSetId: `set-${defectClass}`, findingRefs: [findingRef] };
      const set = { ...body, setDigest: canonicalJsonSha256(body) };
      const setRef = refOfBlob('finding_set', set);
      objects.set(setRef.digest, set);
      return setRef;
    });
    const classified = await classifyAndUnionMigrationFindingSets({
      findingSetRefs: setRefs,
      resolve: async (blobRef) => objects.get(blobRef.digest) ?? null,
    });
    expect(classified.routeOutcome).toBe('map_repair');
    expect(classified.findingSet?.findingRefs).toHaveLength(2);
    expect(classified.findingSet?.findingRefs.map((item) => item.digest)).toEqual(
      [...classified.findingSet!.findingRefs].map((item) => item.digest).sort(),
    );
  });
});

describe('Task 20 migration WorkItem custody', () => {
  it('requires the system batch payload and authority base to bind the exact plan ref', () => {
    const planRef = ref('migration_validation_plan_spec', 'plan-carry');
    const baseRef = ref('authority_base_set', 'migration-base');
    const carrier = {
      workItemId: 'wi-migration-0', kind: 'system_migration_validation_batch' as const,
      roleBinding: null, agentExecutionKind: null, sessionKind: null, roundId: null,
      logicalAssignmentId: null, reviewAssignmentId: null, grantSpecRef: null,
      inputArtifactDeliveryId: null, authorityBaseRef: baseRef, payloadRef: planRef,
      initialLeaseEpoch: 0, maxAutomaticRetries: 3,
    };
    expect(validateMigrationSuccessorCarrier(carrier, planRef, baseRef)).toEqual([]);
    expect(validateMigrationSuccessorCarrier({ ...carrier, payloadRef: ref('migration_validation_plan_spec', 'other') }, planRef, baseRef)).toContain('migration successor payloadRef must be the exact migration validation plan spec ref');
    expect(validateMigrationSuccessorCarrier({ ...carrier, authorityBaseRef: ref('authority_base_set', 'other-base') }, planRef, baseRef)).toContain('migration successor authorityBaseRef must be the prepared migration base ref');
  });
});

describe('Task 20 atomic migration progress envelopes', () => {
  const authorityBaseRef = ref('authority_base_set', 'progress-base');
  const terminal = { workItemId: 'wi-initial', commandId: 'cmd-initial', commandKind: 'review_settlement' as const, leaseEpoch: 1, authorityBaseRef };
  const successor = {
    workItemId: 'wi-batch-0', kind: 'system_migration_validation_batch' as const,
    roleBinding: null, agentExecutionKind: null, sessionKind: null, roundId: null,
    logicalAssignmentId: null, reviewAssignmentId: null, grantSpecRef: null,
    inputArtifactDeliveryId: null, authorityBaseRef: ref('authority_base_set', 'batch-base'),
    payloadRef: ref('migration_validation_plan_spec', 'progress-plan'), initialLeaseEpoch: 0, maxAutomaticRetries: 3,
  };

  it('atomically starts a plan, creates its first batch, and completes the initial command', () => {
    const events = buildMigrationProgressEvents({
      stage: 'initial', migrationValidationPlanId: 'mvp-1',
      intentCoreRef: ref('migration_intent_core', 'intent'), planSpecRef: successor.payloadRef,
      batchOrdinal: null, batchResultRootRef: null, batchOutcome: null, successor, terminal,
    }, '2026-08-16T00:00:00.000Z');
    expect(events.map((event) => event.type)).toEqual([
      'structured_migration_validation_plan_started', 'structured_work_item_created',
      'structured_system_command_completed', 'structured_work_item_completed',
    ]);
  });

  it('atomically records a batch and creates exactly one next command', () => {
    const events = buildMigrationProgressEvents({
      stage: 'batch', migrationValidationPlanId: null, intentCoreRef: null, planSpecRef: successor.payloadRef,
      batchOrdinal: 0, batchResultRootRef: ref('migration_validation_batch_result', 'progress-result'),
      batchOutcome: 'clear', successor: { ...successor, workItemId: 'wi-batch-1' },
      terminal: { ...terminal, workItemId: 'wi-batch-0', commandId: 'cmd-batch-0', commandKind: 'migration_validation_batch' },
    }, '2026-08-16T00:00:01.000Z');
    expect(events.map((event) => event.type)).toEqual([
      'structured_migration_validation_batch_completed', 'structured_work_item_created',
      'structured_system_command_completed', 'structured_work_item_completed',
    ]);
  });
});

describe('Task 20 facade-only runtime orchestration', () => {
  it('constructs the production ValidatorEngine runtime and installs its SystemCommand handler', async () => {
    const objects = new Map<string, unknown>();
    const published: unknown[] = [];
    const contentBody = {
      slotId: 'slot-1', contentSchemaDigest: digest('factory-schema'), taskContentRevision: 1,
      mediaType: 'text/plain' as const, text: 'production migration content',
    };
    const contentValue = { ...contentBody, selfDigest: canonicalJsonSha256(contentBody) };
    const contentValueRef = refOfBlob('content_value', contentValue);
    const sourceMapRef = ref('map_snapshot', 'factory-source-map');
    const targetMapRef = ref('map_snapshot', 'factory-target-map');
    const inputRef = ref('validator_input_envelope', 'factory-source-input');
    const sourceAggregateRef = ref('validator_aggregate', 'factory-source-aggregate');
    const sourceVersion: SlotContentVersionV2 = {
      state: 'set', slotId: 'slot-1', slotRevision: 1, taskContentRevision: 1,
      mapRef: sourceMapRef, mapSemanticDigest: digest('factory-source-semantic'), contentSchemaDigest: contentBody.contentSchemaDigest,
      contentDigest: canonicalJsonSha256(contentValue), blobRef: contentValueRef,
      provenance: {
        kind: 'generated', producer: { kind: 'generation_batch', planRevisionId: 'gp-factory', batchOrdinal: 0, attemptId: 'att-factory' },
        contentRevisionCommitCoreRef: ref('content_revision_commit_core', 'factory-source-core'),
        contentCommitValidatorAggregateRef: sourceAggregateRef,
        contentCommitWarningRootRef: ref('validation_warning_root', 'factory-source-warning'), committedByAttemptId: 'att-factory',
      },
    };
    const sourceVersionRef = refOfBlob('content_version', sourceVersion);
    const sourceNode = { slotId: 'slot-1', slotType: 'doc', contentBearing: true, parentSlotId: null, documentOrder: 0, siblingOrder: 0, nodeSpecDigest: digest('factory-node-source') };
    const targetNode = { ...sourceNode, documentOrder: 1, nodeSpecDigest: digest('factory-node-target') };
    objects.set(contentValueRef.digest, contentValue);
    objects.set(sourceVersionRef.digest, sourceVersion);
    objects.set(inputRef.digest, { selectedTargetRefs: [contentValueRef] });
    objects.set(sourceAggregateRef.digest, { inputRef, registrationSetDigest: digest('obsolete-registry'), outcome: 'clear' });
    objects.set(sourceMapRef.digest, { nodes: [sourceNode], relations: [] });
    objects.set(targetMapRef.digest, { nodes: [targetNode], relations: [] });
    const intent = buildMigrationIntent({
      taskId: 'task-factory', migrationSpecRef: ref('migration_spec', 'factory-spec'),
      sourceManifestRef: ref('content_revision_manifest', 'factory-manifest'), sourceMapRef, targetMapRef,
      decisions: [{ action: 'inherit_or_validate', slotId: 'slot-1', sourceVersionRef, compatibilityProofRef: ref('content_compatibility_proof', 'factory-proof') }],
      impactClosureRef: ref('finding_set', 'factory-impact'), migrationPolicyVersion: '1',
    });
    const intentRef = refOfBlob('migration_intent_core', intent);
    const batchRegistration = builtinRegistration('authoritative.review.slotSchema');
    const finalizeRegistration = builtinRegistration('authoritative.review.coverage');
    const planRef = ref('migration_validation_plan_spec', 'factory-plan-ref');
    const plan = buildMigrationValidationPlanSpec({
      migrationValidationPlanId: 'mvp-factory', migrationIntentCoreRef: intentRef,
      candidateRef: ref('map_candidate', 'factory-candidate'), proposedMapCoreRef: ref('proposed_map_core', 'factory-proposed'),
      sourceManifestRef: intent.sourceManifestRef,
      frozenRegistrationSetDigest: digest('factory-regs'), orderedBatchSlotIds: [['slot-1']],
      profileRef: ref('profile_snapshot', 'factory-profile'),
    });
    objects.set(intentRef.digest, intent);
    objects.set(planRef.digest, plan);
    const commands = new SystemCommandRegistry();
    const before = await commands.resolve('migration_validation_batch')!.execute({
      taskId: 'task-factory', commandId: 'before', workItemId: 'wi-before', commandKind: 'migration_validation_batch', leaseEpoch: 1,
      authorityBaseRef: ref('authority_base_set', 'before-base'), payloadRef: planRef,
    });
    expect(before).toMatchObject({ kind: 'retryable_failure', failureCode: SYSTEM_COMMAND_NOT_IMPLEMENTED_CODE });
    const runtime = createProductionMigrationRuntime({
      facade: {
        async prepareBlob(_taskId, kind, value) { const blobRef = refOfBlob(kind, value); objects.set(blobRef.digest, value); return blobRef; },
        async publishWithPin(pin) { published.push(pin); return {} as never; },
      },
      async tail() { return { lastSequence: published.length, lastCommitId: null }; },
      templateSnapshotRef: ref('profile_snapshot', 'factory-template'), profileSnapshotRef: ref('profile_snapshot', 'factory-profile'),
      frozenRegistrationSetDigest: plan.frozenRegistrationSetDigest, migrationPolicyVersion: '1', equivalencePolicyVersion: '1',
      maxAutomaticRetries: 3, clock: () => '2026-08-16T00:00:00.000Z',
      async resolve(_taskId, blobRef) { return objects.get(blobRef.digest) ?? null; },
      async completedBatches() { return []; },
      validatorRegistry: new ValidatorRegistry(AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES),
      profileBody: buildAuthoritativeReviewTestProfileBody(), templateSnapshotHash: 'a'.repeat(64),
      registrationsFor: (phase) => phase === 'batch_commit' ? [batchRegistration] : [finalizeRegistration],
      slotTypes: [{ id: 'doc', name: 'doc', description: 'document', contentPresence: 'required', contentSchema: { type: 'string' } }],
      slotTypeOf: () => 'doc', requiredSlotIdsOf: () => ['slot-1'],
      async readProjection() { throw new Error('not used by batch execution'); },
      sourceResolver: builtinSourceOf,
      reviewCoordinator: { async prepareClearActivation() { throw new Error('not used'); } },
      repairCoordinator: {
        async prepareContentRepairActivation() { throw new Error('not used'); },
        async prepareMapRepair() { throw new Error('not used'); },
      },
      systemCommands: commands,
    });
    const result = await runtime.service.executeNextBatch({
      taskId: 'task-factory', commandId: 'cmd-factory', workItemId: 'wi-factory', leaseEpoch: 1,
      authorityBaseRef: ref('authority_base_set', 'factory-base'), planSpecRef: planRef,
      reviewCoverageCoreRef: ref('map_review_coverage_core', 'factory-coverage'), reviewRoundRef: ref('map_review_round', 'factory-round'),
    });
    expect(result).toMatchObject({ kind: 'completed', batchOrdinal: 0 });
    expect(published).toHaveLength(1);
    expect(commands.resolve('migration_validation_batch')).not.toBeNull();
    const batchResult = [...objects.values()].find((value) => typeof value === 'object' && value !== null && 'batchOutcome' in value) as { batchOutcome: string } | undefined;
    expect(batchResult?.batchOutcome).toBe('clear');
  });

  it('persists immutable plan objects and publishes the first system batch in one pinned envelope', async () => {
    const published: unknown[] = [];
    const prepared = new Map<string, unknown>();
    const service = new MigrationServiceV2({
      facade: {
        async prepareBlob(_taskId, kind, value) {
          const blobRef = refOfBlob(kind, value);
          prepared.set(blobRef.digest, value);
          return blobRef;
        },
        async publishWithPin(input) {
          published.push(input);
          return { commit: { commitId: 'commit-1', firstSequence: 1, lastSequence: 4, events: [] }, replayed: false } as never;
        },
      },
      async tail() { return { lastSequence: 0, lastCommitId: null }; },
      templateSnapshotRef: ref('profile_snapshot', 'template'),
      profileSnapshotRef: ref('profile_snapshot', 'profile'),
      frozenRegistrationSetDigest: digest('registrations'), migrationPolicyVersion: '1', equivalencePolicyVersion: '1',
      maxAutomaticRetries: 3, clock: () => '2026-08-16T00:00:00.000Z',
      async resolve(_taskId, blobRef) { return prepared.get(blobRef.digest) ?? null; },
      async completedBatches() { return []; },
      async localValidatorCustody() { throw new Error('not used during initial planning'); },
      async freshValidate() { throw new Error('not used during initial planning'); },
      async runMigrationFinalizer() { throw new Error('not used during initial planning'); },
      async prepareActivationRoute() { throw new Error('not used during initial planning'); },
    });
    const source = setVersion('slot-1');
    const result = await service.beginMigration({
      taskId: 'task-runtime', commandId: 'cmd-initial', workItemId: 'wi-initial', leaseEpoch: 1,
      authorityBaseRef: ref('authority_base_set', 'initial-base'),
      mapReviewSettlementCoreRef: ref('map_review_settlement_core', 'map-settlement'),
      reviewCoverageCoreRef: ref('map_review_coverage_core', 'coverage'), reviewRoundRef: ref('map_review_round', 'round'),
      candidateRef: ref('map_candidate', 'candidate'), proposedMapCoreRef: ref('proposed_map_core', 'proposed'),
      sourceManifestRef: ref('content_revision_manifest', 'source-manifest'), sourceMapRef: ref('map_snapshot', 'source-map'),
      targetMapRef: ref('map_snapshot', 'target-map'), impactClosureRef: ref('finding_set', 'impact'),
      targetSlots: [{ slotId: 'slot-1', source, targetContentSchemaDigest: digest('schema'), targetPresence: 'required', mixedFindingStageRootRef: null }],
      batchSize: 64,
    });
    expect(result.successorWorkItemId).toContain('wi-migration-');
    expect(published).toHaveLength(1);
    const pin = published[0] as { payload: { publishKind: string; mapReview: { migrationProgress: { stage: string; successor: { kind: string } } } } };
    expect(pin.payload.publishKind).toBe('migration_settlement');
    expect(pin.payload.mapReview.migrationProgress).toMatchObject({ stage: 'initial', successor: { kind: 'system_migration_validation_batch' } });
  });

  it('runs a zero-validation migration through post_migration and publishes one clear activation envelope', async () => {
    const published: Array<{ payload: { publishKind: string; mapReview: ReturnType<typeof mapReviewCarrier> } }> = [];
    const objects = new Map<string, unknown>();
    const prepare = async (_taskId: string, kind: Parameters<typeof refOfBlob>[0], value: unknown) => {
      const blobRef = refOfBlob(kind, value);
      objects.set(blobRef.digest, value);
      return blobRef;
    };
    const sourceMapRef = ref('map_snapshot', 'post-source-map');
    const targetMapRef = ref('map_snapshot', 'post-target-map');
    const proposedMapCoreRef = ref('proposed_map_core', 'post-proposed');
    const sourceSchema = canonicalJsonSha256({ slotType: 'optional-text' });
    const sourceValue: SlotContentVersionV2 = {
      state: 'unset', slotId: 'optional', slotRevision: 1, taskContentRevision: 1,
      mapRef: sourceMapRef, mapSemanticDigest: digest('post-source-semantic'), contentSchemaDigest: sourceSchema,
      unsetReason: 'initial', unsetProvenance: { kind: 'created_empty' },
    };
    const sourceVersionRef = refOfBlob('content_version', sourceValue);
    objects.set(sourceVersionRef.digest, sourceValue);
    const sourceManifest = {
      taskId: 'task-post', mapRef: sourceMapRef, mapSemanticDigest: digest('post-source-semantic'), taskContentRevision: 1,
      manifestPhase: 'finalized' as const, entries: [{ slotId: 'optional', versionRef: sourceVersionRef }],
      producerPlanSpecRef: ref('generation_plan_spec', 'post-generation'), priorManifestRef: null,
      finalizerValidatorAggregateRefs: [ref('validator_aggregate', 'post-old-finalizer')], finalizerWarningRootRefs: [],
      contentRootDigest: digest('post-old-root'), manifestDigest: digest('post-old-manifest'),
    };
    const sourceManifestRef = refOfBlob('content_revision_manifest', sourceManifest);
    objects.set(sourceManifestRef.digest, sourceManifest);
    objects.set(targetMapRef.digest, { mapSemanticDigest: digest('post-target-semantic') });
    objects.set(proposedMapCoreRef.digest, { nodes: [
      { slotId: 'optional', slotType: 'optional-text', contentBearing: true },
      { slotId: 'new', slotType: 'new-text', contentBearing: true },
    ] });
    const mapSettlementRef = ref('map_review_settlement_core', 'post-map-settlement');
    const coverageRef = ref('map_review_coverage_core', 'post-coverage');
    const candidateRef = ref('map_candidate', 'post-candidate');
    const reviewRoundRef = ref('map_review_round', 'post-round');
    const postAuthorityBaseRef = ref('authority_base_set', 'post-settlement-base');
    objects.set(mapSettlementRef.digest, { coverageCoreRef: coverageRef, mapReviewSettlementValidatorAggregateRef: ref('validator_aggregate', 'post-map-settle-agg'), coreDigest: digest('post-map-settle-core') });
    objects.set(postAuthorityBaseRef.digest, {
      mapCandidateRef: candidateRef,
      contentRevisionManifestRef: sourceManifestRef,
      reviewCoverageCoreRef: coverageRef,
      reviewRoundRef,
    });
    let activeManifestRef = sourceManifestRef;
    let reviewRoundState: 'completed' | 'settled' = 'completed';
    let finalizerOutcome: 'clear' | 'infrastructure_failure' = 'clear';
    let currentPlanRef: BlobRefV2 | null = null;
    let postWorkItemId = '';
    const deps = {
      facade: {
        prepareBlob: prepare,
        async publishWithPin(input: unknown) { published.push(input as never); return {} as never; },
      },
      async tail() { return { lastSequence: published.length * 4, lastCommitId: published.length === 0 ? null : `commit-${published.length}` }; },
      templateSnapshotRef: ref('profile_snapshot', 'post-template'), profileSnapshotRef: ref('profile_snapshot', 'post-profile'),
      frozenRegistrationSetDigest: digest('post-registrations'), migrationPolicyVersion: '1', equivalencePolicyVersion: '1', maxAutomaticRetries: 3,
      clock: () => '2026-08-16T00:00:00.000Z',
      async resolve(_taskId: string, blobRef: BlobRefV2) { return objects.get(blobRef.digest) ?? null; },
      async completedBatches() { return []; },
      async readCurrentAuthority() {
        return {
          activeMapRef: sourceMapRef,
          activeManifestRef,
          currentCandidateRef: candidateRef,
          migrationValidationPlanId: currentPlanRef === null ? null : (objects.get(currentPlanRef.digest) as { migrationValidationPlanId: string }).migrationValidationPlanId,
          migrationSettled: false,
          workItemPayloadRef: currentPlanRef,
          workItemAuthorityBaseRef: postAuthorityBaseRef,
          reviewRoundRef,
          reviewRoundState,
        };
      },
      async localValidatorCustody() { throw new Error('no validation batches expected'); },
      async freshValidate() { throw new Error('no validation batches expected'); },
      async runMigrationFinalizer() {
        const finalizerAggregateRef = ref('validator_aggregate', `post-finalizer-${finalizerOutcome}`);
        objects.set(finalizerAggregateRef.digest, { outcome: finalizerOutcome });
        return {
          finalizerAggregateRef,
          finalizerWarningRootRef: ref('validation_warning_root', 'post-warning'),
          routeOutcome: finalizerOutcome, classifiedFindingSetRef: null, preparedBlobs: [],
        };
      },
      async prepareActivationRoute(routeInput: { migratedManifestRef: BlobRefV2; plan: { sourceManifestRef: BlobRefV2 } }) {
        return {
          carriers: mapReviewCarrier({
            mapReviewRoundId: 'round-post', settlementCoreRef: mapSettlementRef, outcome: 'activate',
            mapId: 'map-post', mapRevision: 2, supersedesMapId: 'map-old', mapSnapshotRef: targetMapRef,
            mapReviewBundleRef: ref('map_review_bundle', 'post-bundle'), mapSemanticDigest: digest('post-target-semantic'),
            contentRevisionManifestRef: routeInput.migratedManifestRef,
            activationValidatorAggregateRef: ref('validator_aggregate', 'post-map-activation'),
            taskContentRevision: 2, manifestPhase: 'finalized', producerPlanSpecRef: null,
            priorManifestRef: routeInput.plan.sourceManifestRef,
            contentRound: {
              reviewRoundId: 'content-review-post', contentCycleOrdinal: 2, mapRef: targetMapRef,
              mapSemanticDigest: digest('post-target-semantic'), contentRevisionManifestRef: routeInput.migratedManifestRef,
              reviewPolicyDigest: digest('post-review-policy'), adoptionRootRef: ref('review_adoption_root', 'post-adoption'),
              coverageSlotCount: 2, coverageRelationCount: 0, assignmentCount: 1,
              verificationFindingCount: 0, consumedOverrideRef: null,
            },
            reviewWorkItems: [{
              workItemId: 'wi-content-review-post', kind: 'agent_assignment', roleBinding: 'reviewer',
              agentExecutionKind: 'structured_session', sessionKind: 'review_content_batch', roundId: 'content-review-post',
              logicalAssignmentId: 'content-review-assignment-post', reviewAssignmentId: 'content-review-assignment-post',
              grantSpecRef: ref('write_grant_spec', 'post-review-grant'), inputArtifactDeliveryId: null,
              authorityBaseRef: ref('authority_base_set', 'post-review-base'), payloadRef: ref('content_review_coverage_core', 'post-review-payload'),
              initialLeaseEpoch: 1, maxAutomaticRetries: 3,
            }],
          }),
          preparedRefs: [],
        };
      },
    };
    const service = new MigrationServiceV2(deps);
    const begin = await service.beginMigration({
      taskId: 'task-post', commandId: 'cmd-initial', workItemId: 'wi-initial', leaseEpoch: 1,
      authorityBaseRef: ref('authority_base_set', 'post-initial-base'), mapReviewSettlementCoreRef: mapSettlementRef,
      reviewCoverageCoreRef: coverageRef, reviewRoundRef,
      candidateRef, proposedMapCoreRef,
      sourceManifestRef, sourceMapRef, targetMapRef, impactClosureRef: ref('finding_set', 'post-impact'),
      targetSlots: [
        { slotId: 'optional', source: { ref: sourceVersionRef, value: sourceValue }, targetContentSchemaDigest: sourceSchema, targetPresence: 'optional', mixedFindingStageRootRef: null },
        { slotId: 'new', source: null, targetContentSchemaDigest: canonicalJsonSha256({ slotType: 'new-text' }), targetPresence: 'required', mixedFindingStageRootRef: null },
      ],
      batchSize: 64,
    });
    currentPlanRef = begin.migrationValidationPlanSpecRef;
    postWorkItemId = begin.successorWorkItemId;
    void postWorkItemId;
    expect((published[0].payload.mapReview.migrationProgress?.successor.kind)).toBe('system_review_settlement');
    reviewRoundState = 'settled';
    await expect(service.executePostMigrationSettlement({
      taskId: 'task-post', commandId: 'cmd-post-settled-round', workItemId: begin.successorWorkItemId, leaseEpoch: 1,
      authorityBaseRef: postAuthorityBaseRef, planSpecRef: begin.migrationValidationPlanSpecRef,
      reviewCoverageCoreRef: coverageRef, reviewRoundRef, settlementOperationId: 'op-post-settled-round',
    })).rejects.toThrow(/expected completed unsettled round/);
    expect(published).toHaveLength(1);
    reviewRoundState = 'completed';
    activeManifestRef = ref('content_revision_manifest', 'newer-authoritative-manifest');
    await expect(service.executePostMigrationSettlement({
      taskId: 'task-post', commandId: 'cmd-post-stale', workItemId: begin.successorWorkItemId, leaseEpoch: 1,
      authorityBaseRef: postAuthorityBaseRef, planSpecRef: begin.migrationValidationPlanSpecRef,
      reviewCoverageCoreRef: coverageRef, reviewRoundRef, settlementOperationId: 'op-post-stale',
    })).rejects.toThrow(/stale migration authority/);
    expect(published).toHaveLength(1);
    activeManifestRef = sourceManifestRef;
    finalizerOutcome = 'infrastructure_failure';
    const infrastructure = await service.executePostMigrationSettlement({
      taskId: 'task-post', commandId: 'cmd-post-infrastructure', workItemId: begin.successorWorkItemId, leaseEpoch: 1,
      authorityBaseRef: postAuthorityBaseRef, planSpecRef: begin.migrationValidationPlanSpecRef,
      reviewCoverageCoreRef: coverageRef, reviewRoundRef, settlementOperationId: 'op-post-infrastructure',
    });
    expect(infrastructure).toMatchObject({
      kind: 'retryable_failure', failureCode: 'VALIDATOR_INFRASTRUCTURE_FAILURE',
      validatorAggregateRef: { kind: 'validator_aggregate' },
    });
    expect(published).toHaveLength(1);
    finalizerOutcome = 'clear';
    const post = await service.executePostMigrationSettlement({
      taskId: 'task-post', commandId: 'cmd-post', workItemId: begin.successorWorkItemId, leaseEpoch: 1,
      authorityBaseRef: postAuthorityBaseRef, planSpecRef: begin.migrationValidationPlanSpecRef,
      reviewCoverageCoreRef: coverageRef, reviewRoundRef, settlementOperationId: 'op-post',
    });
    expect(post).toMatchObject({ kind: 'completed', route: 'clear' });
    expect(published).toHaveLength(2);
    expect(published[1].payload.mapReview).toMatchObject({
      outcome: 'activate', manifestPhase: 'finalized', migrationSettlementCoreRef: { kind: 'migration_settlement_core' },
      migrationActivationDecisionRef: { kind: 'migration_activation_decision' },
      migrationProvisionalManifestRef: { kind: 'content_revision_manifest' },
      migrationFinalizerAggregateRef: { kind: 'validator_aggregate' },
    });
  });

  it('runs fresh target-Map validation on custody mismatch and never replays a committed ordinal', async () => {
    const objects = new Map<string, unknown>();
    let completed: Array<{ batchOrdinal: number; batchResultRootRef: BlobRefV2 }> = [];
    let freshRuns = 0;
    const planRef = ref('migration_validation_plan_spec', 'fresh-plan');
    const compatibilityProofRef = ref('content_compatibility_proof', 'fresh-compatibility');
    const sourceVersionRef = ref('content_version', 'fresh-version');
    const intent = buildMigrationIntent({
      taskId: 'task-fresh', migrationSpecRef: ref('migration_spec', 'fresh-spec'), sourceManifestRef: ref('content_revision_manifest', 'fresh-manifest'),
      sourceMapRef: ref('map_snapshot', 'fresh-source-map'), targetMapRef: ref('map_snapshot', 'fresh-target-map'),
      decisions: [{ action: 'inherit_or_validate', slotId: 'slot-1', sourceVersionRef, compatibilityProofRef }],
      impactClosureRef: ref('finding_set', 'fresh-impact'), migrationPolicyVersion: '1',
    });
    const intentRef = refOfBlob('migration_intent_core', intent);
    const plan = buildMigrationValidationPlanSpec({
      migrationValidationPlanId: 'mvp-fresh', migrationIntentCoreRef: intentRef,
      candidateRef: ref('map_candidate', 'fresh-candidate'), proposedMapCoreRef: ref('proposed_map_core', 'fresh-proposed'),
      sourceManifestRef: ref('content_revision_manifest', 'fresh-manifest'), frozenRegistrationSetDigest: digest('fresh-regs'),
      orderedBatchSlotIds: [['slot-1']], profileRef: ref('profile_snapshot', 'fresh-profile'),
    });
    objects.set(intentRef.digest, intent);
    objects.set(planRef.digest, plan);
    const service = new MigrationServiceV2({
      facade: {
        async prepareBlob(_taskId, kind, value) { const blobRef = refOfBlob(kind, value); objects.set(blobRef.digest, value); return blobRef; },
        async publishWithPin(pin) {
          const payload = pin.payload as import('../../authoritative-review/authority-types').PublicationOperationPayloadV2;
          const progress = payload.family === 'domain_publish' ? payload.mapReview?.migrationProgress : null;
          if (progress?.stage === 'batch' && progress.batchResultRootRef !== null && progress.batchOrdinal !== null) {
            completed = [{ batchOrdinal: progress.batchOrdinal, batchResultRootRef: progress.batchResultRootRef }];
          }
          return {} as never;
        },
      },
      async tail() { return { lastSequence: completed.length, lastCommitId: completed.length ? 'commit-batch' : null }; },
      templateSnapshotRef: ref('profile_snapshot', 'fresh-template'), profileSnapshotRef: ref('profile_snapshot', 'fresh-profile'),
      frozenRegistrationSetDigest: digest('fresh-regs'), migrationPolicyVersion: '1', equivalencePolicyVersion: '1', maxAutomaticRetries: 3,
      clock: () => '2026-08-16T00:00:00.000Z', async resolve(_taskId, blobRef) { return objects.get(blobRef.digest) ?? null; },
      async completedBatches() { return completed; },
      async localValidatorCustody() {
        const source = { frozenRegistrationSetDigest: digest('fresh-regs'), selectorExpansionDigest: digest('selector'), contentBytesDigest: digest('bytes'), localMapSubgraphDigest: digest('old-subgraph'), localRelationContextDigest: digest('relations') };
        return { sourceBatchInputRef: ref('validator_input_envelope', 'fresh-old-input'), source, target: { ...source, localMapSubgraphDigest: digest('new-subgraph') } };
      },
      async freshValidate() {
        freshRuns += 1;
        return {
          slotResult: { outcome: 'revalidated' as const, slotId: 'slot-1', validatorAggregateRef: ref('validator_aggregate', 'fresh-aggregate'), warningRootRef: ref('validation_warning_root', 'fresh-warning') },
          batchOutcome: 'clear' as const, preparedBlobs: [],
        };
      },
      async runMigrationFinalizer() { throw new Error('not used'); }, async prepareActivationRoute() { throw new Error('not used'); },
    });
    const first = await service.executeNextBatch({
      taskId: 'task-fresh', commandId: 'cmd-batch', workItemId: 'wi-batch', leaseEpoch: 1,
      authorityBaseRef: ref('authority_base_set', 'fresh-base'), planSpecRef: planRef,
      reviewCoverageCoreRef: ref('map_review_coverage_core', 'fresh-coverage'), reviewRoundRef: ref('map_review_round', 'fresh-round'),
    });
    expect(first.batchOrdinal).toBe(0);
    expect(freshRuns).toBe(1);
    await expect(service.executeNextBatch({
      taskId: 'task-fresh', commandId: 'cmd-batch-replayed-wrongly', workItemId: 'wi-batch-other', leaseEpoch: 1,
      authorityBaseRef: ref('authority_base_set', 'fresh-base-2'), planSpecRef: planRef,
      reviewCoverageCoreRef: ref('map_review_coverage_core', 'fresh-coverage'), reviewRoundRef: ref('map_review_round', 'fresh-round'),
    })).rejects.toThrow(/already complete/);
    expect(freshRuns).toBe(1);
  });

  it('does not complete or advance an infrastructure-failed batch and reruns the same ordinal', async () => {
    const objects = new Map<string, unknown>();
    const published: unknown[] = [];
    let freshRuns = 0;
    const planRef = ref('migration_validation_plan_spec', 'infra-plan-ref');
    const intent = buildMigrationIntent({
      taskId: 'task-infra',
      migrationSpecRef: ref('migration_spec', 'infra-spec'),
      sourceManifestRef: ref('content_revision_manifest', 'infra-source-manifest'),
      sourceMapRef: ref('map_snapshot', 'infra-source-map'),
      targetMapRef: ref('map_snapshot', 'infra-target-map'),
      decisions: [{
        action: 'inherit_or_validate', slotId: 'slot-1',
        sourceVersionRef: ref('content_version', 'infra-version'),
        compatibilityProofRef: ref('content_compatibility_proof', 'infra-proof'),
      }],
      impactClosureRef: ref('finding_set', 'infra-impact'),
      migrationPolicyVersion: '1',
    });
    const intentRef = refOfBlob('migration_intent_core', intent);
    const plan = buildMigrationValidationPlanSpec({
      migrationValidationPlanId: 'mvp-infra', migrationIntentCoreRef: intentRef,
      candidateRef: ref('map_candidate', 'infra-candidate'),
      proposedMapCoreRef: ref('proposed_map_core', 'infra-proposed'),
      sourceManifestRef: intent.sourceManifestRef,
      frozenRegistrationSetDigest: digest('infra-regs'),
      orderedBatchSlotIds: [['slot-1']],
      profileRef: ref('profile_snapshot', 'infra-profile'),
    });
    objects.set(intentRef.digest, intent);
    objects.set(planRef.digest, plan);
    const aggregateRef = ref('validator_aggregate', 'infra-aggregate');
    const service = new MigrationServiceV2({
      facade: {
        async prepareBlob(_taskId, kind, value) { const blobRef = refOfBlob(kind, value); objects.set(blobRef.digest, value); return blobRef; },
        async publishWithPin(pin) { published.push(pin); return {} as never; },
      },
      async tail() { return { lastSequence: 0, lastCommitId: null }; },
      templateSnapshotRef: ref('profile_snapshot', 'infra-template'), profileSnapshotRef: ref('profile_snapshot', 'infra-profile'),
      frozenRegistrationSetDigest: digest('infra-regs'), migrationPolicyVersion: '1', equivalencePolicyVersion: '1',
      maxAutomaticRetries: 3, clock: () => '2026-08-16T00:00:00.000Z',
      async resolve(_taskId, blobRef) { return objects.get(blobRef.digest) ?? null; },
      async completedBatches() { return []; },
      async localValidatorCustody() {
        const source = {
          frozenRegistrationSetDigest: digest('infra-regs'), selectorExpansionDigest: digest('selectors'),
          contentBytesDigest: digest('bytes'), localMapSubgraphDigest: digest('old-subgraph'),
          localRelationContextDigest: digest('relations'),
        };
        return { sourceBatchInputRef: ref('validator_input_envelope', 'infra-input'), source, target: { ...source, localMapSubgraphDigest: digest('new-subgraph') } };
      },
      async freshValidate() {
        freshRuns += 1;
        return {
          slotResult: { outcome: 'revalidated' as const, slotId: 'slot-1', validatorAggregateRef: aggregateRef, warningRootRef: ref('validation_warning_root', 'infra-warning') },
          batchOutcome: 'infrastructure_failure' as const,
          preparedBlobs: [],
        };
      },
      async runMigrationFinalizer() { throw new Error('not used'); },
      async prepareActivationRoute() { throw new Error('not used'); },
    });
    const input = {
      taskId: 'task-infra', commandId: 'cmd-infra', workItemId: 'wi-infra', leaseEpoch: 1,
      authorityBaseRef: ref('authority_base_set', 'infra-base'), planSpecRef: planRef,
      reviewCoverageCoreRef: ref('map_review_coverage_core', 'infra-coverage'), reviewRoundRef: ref('map_review_round', 'infra-round'),
    };
    const first = await service.executeNextBatch(input);
    expect(first).toMatchObject({ kind: 'retryable_failure', validatorAggregateRef: aggregateRef, batchOrdinal: 0 });
    const second = await service.executeNextBatch({ ...input, commandId: 'cmd-infra-retry' });
    expect(second).toMatchObject({ kind: 'retryable_failure', validatorAggregateRef: aggregateRef, batchOrdinal: 0 });
    expect(freshRuns).toBe(2);
    expect(published).toHaveLength(0);
  });
});
