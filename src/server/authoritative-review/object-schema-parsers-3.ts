/**
 * Per-kind blob parsers, part 3 (profile/grant/review/validator/seal/
 * publication kinds). Authors: design §9/§11.4/§11.10/§11.11/§16/§17.2/§13;
 * spec §4.3/§7.1/§8/§10.3.1. Every parser rejects unknown fields and illegal
 * combinations with `SchemaError`.
 */
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';
import { AUTHORITATIVE_BLOB_KINDS_V2 } from '../../shared/authoritative-review-v2';
import { canonicalJsonSha256 } from '../structured-slots/canonical-json';
import {
  AUTHORITATIVE_REVIEW_PROFILE_SNAPSHOT_MAX_BYTES,
  PROFILE_ASSEMBLER_BUDGET_FIELDS,
  PROFILE_ASSEMBLER_IDENTITY_FIELDS,
  PROFILE_BUDGET_PROFILE_FIELDS,
  PROFILE_RUNTIME_FIELDS,
  PROFILE_SNAPSHOT_GROUP_KEYS,
  PROFILE_TEMPLATE_GROUPS,
  PROFILE_VALIDATOR_IDENTITY_FIELDS,
} from './object-schema-parsers-3-constants';
import {
  SchemaError,
  type AssignmentLedgerBlobV2,
  type AuthorityBaseSetV2,
  type ContentPlanPublishCarriersV2,
  type ContentReviewFindingOpeningCarrierV2,
  type ContentReviewObservationCarrierV2,
  type ContentReviewPublishCarriersV2,
  type ContentReviewRoundPlanCarrierV2,
  type MapBuildPublishCarriersV2,
  type MapReviewObservationCarrierV2,
  type MapReviewPublishCarriersV2,
  type MapReviewRoundPlanCarrierV2,
  type ProjectionCheckpointV2,
  type PublicationOperationPayloadV2,
  type RepairBatchGrantSpecV2,
  type RepairKeyLedgerV2,
  type RepairPlanSpecV2,
  type RepairPublishCarriersV2,
  type ReviewerFindingVerificationCarrierV2,
  type RepairStagingRootV2,
  type ReviewAdoptionLedgerBlobV2,
  type ReviewAdoptionRootV2,
  type ReviewBundleV2,
  type ReviewFactV2,
  type ReviewFactOriginV2,
  type SealValidationBundleV2,
  type StructuredSessionKindV2,
  type SuccessorWorkItemCarrierV2,
  type SystemCommandTerminalCarrierV2,
  type ValidationReceiptV2,
  type ValidationWarningCustodyRootV2,
  type ValidationWarningRootV2,
  type ValidatorAggregateV2,
  type ValidatorFailureV2,
  type ValidatorInputEnvelopeV2,
  type ValidatorResultV2,
  type WriteGrantSpecV2,
} from './authority-types';
import {
  R,
  compareTrigger,
  en,
  ex,
  everyEmbeddedRef,
  hs,
  hx,
  onn,
  parseEvidenceList,
  rec,
  rf,
  rfKind,
  rfa,
  rfaKind,
  rfn,
  str,
  sa,
  assertRefsSortedByDigest,
  assertSortedStrings,
} from './schema-common';

/** Task 13: the eight closed structured session kinds (review_observation spec). */
const WRITE_GRANT_SESSION_KINDS: readonly string[] = [
  'structure_chunk', 'review_map_batch', 'review_map_whole', 'generation_batch',
  'review_content_batch', 'review_content_whole', 'map_repair', 'content_repair',
];

/* ---- profile_snapshot (§4.3/§7.1) ------------------------------ */
/**
 * Exact profile envelope: identity/version/qualification/ABIs plus
 * `profileDigest = sha256(canonical bytes with that field omitted)`. The
 * BlobRef digest is separately computed over the COMPLETE canonical object
 * bytes; the two identities never equal. Task 5 extends the limit body
 * (runtime/template/installedHandlers/budgetProfiles/assemblerBudget groups,
 * field lists owned by object-schema-parsers-3-constants) while keeping this
 * envelope contract and the digest rule. Semantic cross-group consistency is
 * the profile module's job; this parser enforces the exact shape.
 */
export function parseProfileSnapshotObject(value: unknown): {
  schemaVersion: 1;
  profileIdentity: string;
  profileVersion: number;
  qualificationState: 'test_only' | 'provisional' | 'final';
  profileDigest: string;
  abi: { validatorAbi: 'forge-validator/v2'; assemblerAbi: 'forge-assembler/v2'; profileAbi: 'forge-authoritative-review/v1' };
} {
  const o = rec(value, 'profile_snapshot');
  ex(o, ['schemaVersion', 'profileIdentity', 'profileVersion', 'qualificationState', 'profileDigest', 'abi', ...PROFILE_SNAPSHOT_GROUP_KEYS], 'profile_snapshot');
  if (o.schemaVersion !== 1) throw new SchemaError('profile_snapshot.schemaVersion must be 1');
  const qual = str(o.qualificationState, 'qualificationState');
  if (qual !== 'test_only' && qual !== 'provisional' && qual !== 'final') throw new SchemaError('profile_snapshot.qualificationState unknown');
  const abi = rec(o.abi, 'abi');
  ex(abi, ['validatorAbi', 'assemblerAbi', 'profileAbi'], 'abi');
  if (abi.validatorAbi !== 'forge-validator/v2' || abi.assemblerAbi !== 'forge-assembler/v2' || abi.profileAbi !== 'forge-authoritative-review/v1') {
    throw new SchemaError('profile_snapshot.abi literals mismatch');
  }
  parseProfileGroups(o);
  const copy = { ...o } as Record<string, unknown>;
  delete copy.profileDigest;
  const computed = canonicalJsonSha256(copy);
  const declared = hx(o.profileDigest, 'profileDigest');
  if (declared !== computed) {
    throw new SchemaError('profile_snapshot.profileDigest does not match canonical bytes minus the field');
  }
  return {
    schemaVersion: 1,
    profileIdentity: str(o.profileIdentity, 'profileIdentity'),
    profileVersion: onn(o.profileVersion, 'profileVersion'),
    qualificationState: qual as 'test_only' | 'provisional' | 'final',
    profileDigest: declared,
    abi: {
      validatorAbi: 'forge-validator/v2',
      assemblerAbi: 'forge-assembler/v2',
      profileAbi: 'forge-authoritative-review/v1',
    },
  };
}

/** Exact closed shape of the five profile groups (Task 5 body extension). */
function parseProfileGroups(o: Record<string, unknown>): void {
  if (o.runtime === undefined || o.template === undefined || o.installedHandlers === undefined || o.budgetProfiles === undefined || o.assemblerBudget === undefined) {
    throw new SchemaError('profile_snapshot must carry the runtime/template/installedHandlers/budgetProfiles/assemblerBudget groups');
  }
  parseProfileRuntimeGroup(rec(o.runtime, 'runtime'));
  parseProfileTemplateGroup(rec(o.template, 'template'));
  parseProfileInstalledHandlers(rec(o.installedHandlers, 'installedHandlers'));
  parseProfileBudgetProfiles(rec(o.budgetProfiles, 'budgetProfiles'));
  parseProfileAssemblerBudget(rec(o.assemblerBudget, 'assemblerBudget'));
}

/** Profile limits are positive finite integers (design §22.2, Task 4 convention). */
function posInt(v: unknown, w: string): number {
  const n = onn(v, w);
  if (n < 1) throw new SchemaError(`${w} must be a positive integer`);
  return n;
}

function parseProfileRuntimeGroup(runtime: Record<string, unknown>): void {
  ex(runtime, PROFILE_RUNTIME_FIELDS, 'runtime');
  const bytesByKind = rec(runtime.maxBytesByKind, 'runtime.maxBytesByKind');
  for (const kind of AUTHORITATIVE_BLOB_KINDS_V2) {
    posInt(bytesByKind[kind], `runtime.maxBytesByKind.${kind}`);
  }
  if (Object.keys(bytesByKind).length !== AUTHORITATIVE_BLOB_KINDS_V2.length) {
    throw new SchemaError('runtime.maxBytesByKind must cover exactly the closed blob kind registry');
  }
  for (const field of PROFILE_RUNTIME_FIELDS) {
    if (field === 'maxBytesByKind') continue;
    posInt(runtime[field], `runtime.${field}`);
  }
}

function parseProfileTemplateGroup(template: Record<string, unknown>): void {
  if (Object.keys(template).length !== Object.keys(PROFILE_TEMPLATE_GROUPS).length) {
    throw new SchemaError('template group key set mismatch');
  }
  for (const [group, fields] of Object.entries(PROFILE_TEMPLATE_GROUPS)) {
    const groupValue = rec(template[group], `template.${group}`);
    ex(groupValue, fields, `template.${group}`);
    for (const field of fields) posInt(groupValue[field], `template.${group}.${field}`);
  }
}

function parseProfileInstalledHandlers(handlers: Record<string, unknown>): void {
  ex(handlers, ['validators', 'assembler'], 'installedHandlers');
  const validators = (handlers.validators as unknown[]).map((v, i) => {
    const entry = rec(v, `installedHandlers.validators[${i}]`);
    ex(entry, PROFILE_VALIDATOR_IDENTITY_FIELDS, `installedHandlers.validators[${i}]`);
    const trigger = str(entry.trigger, `installedHandlers.validators[${i}].trigger`);
    if (!(TRIGGER_ENUM as readonly string[]).includes(trigger)) {
      throw new SchemaError(`installedHandlers.validators[${i}].trigger unknown`);
    }
    const phase = entry.executionPhase;
    if (phase !== null && phase !== 'batch_commit' && phase !== 'plan_finalize') {
      throw new SchemaError(`installedHandlers.validators[${i}].executionPhase must be null|batch_commit|plan_finalize`);
    }
    if (trigger !== 'content_commit' && phase !== null) {
      throw new SchemaError(`installedHandlers.validators[${i}].executionPhase is only legal for content_commit`);
    }
    return {
      handlerKey: str(entry.handlerKey, `installedHandlers.validators[${i}].handlerKey`),
      implementationDigest: hx(entry.implementationDigest, `installedHandlers.validators[${i}].implementationDigest`),
      moduleId: str(entry.moduleId, `installedHandlers.validators[${i}].moduleId`),
      exportName: str(entry.exportName, `installedHandlers.validators[${i}].exportName`),
      trigger,
      executionPhase: phase,
    };
  });
  const keys = validators.map((e) => `${e.handlerKey}:${e.implementationDigest}:${e.trigger}:${String(e.executionPhase)}`);
  for (let i = 1; i < keys.length; i++) {
    if (keys[i - 1] >= keys[i]) throw new SchemaError('installedHandlers.validators must be sorted by identity');
  }
  const assembler = rec(handlers.assembler, 'installedHandlers.assembler');
  ex(assembler, PROFILE_ASSEMBLER_IDENTITY_FIELDS, 'installedHandlers.assembler');
  str(assembler.handlerKey, 'installedHandlers.assembler.handlerKey');
  hx(assembler.implementationDigest, 'installedHandlers.assembler.implementationDigest');
  str(assembler.moduleId, 'installedHandlers.assembler.moduleId');
  str(assembler.exportName, 'installedHandlers.assembler.exportName');
}

function parseProfileBudgetProfiles(budgets: Record<string, unknown>): void {
  if (Object.keys(budgets).length < 1) throw new SchemaError('budgetProfiles must declare at least one budget profile');
  for (const [id, raw] of Object.entries(budgets)) {
    const entry = rec(raw, `budgetProfiles.${id}`);
    ex(entry, PROFILE_BUDGET_PROFILE_FIELDS, `budgetProfiles.${id}`);
    for (const field of PROFILE_BUDGET_PROFILE_FIELDS) posInt(entry[field], `budgetProfiles.${id}.${field}`);
  }
}

function parseProfileAssemblerBudget(budget: Record<string, unknown>): void {
  ex(budget, PROFILE_ASSEMBLER_BUDGET_FIELDS, 'assemblerBudget');
  for (const field of PROFILE_ASSEMBLER_BUDGET_FIELDS) posInt(budget[field], `assemblerBudget.${field}`);
}

/* ---- projection_checkpoint (§4.2/§16.2) ------------------------- */
export function parseProjectionCheckpoint(value: unknown): ProjectionCheckpointV2 {
  const o = rec(value, 'projection_checkpoint');
  ex(o, ['checkpointId', 'taskId', 'throughSequence', 'priorCheckpointDigest', 'projectionSchemaVersion', 'baseRefs', 'checkpointDigest'], 'projection_checkpoint');
  const refs = rfa(o.baseRefs, 'baseRefs');
  assertRefsSortedByDigest(refs, 'baseRefs');
  const out: ProjectionCheckpointV2 = {
    checkpointId: str(o.checkpointId, 'checkpointId'),
    taskId: str(o.taskId, 'taskId'),
    throughSequence: onn(o.throughSequence, 'throughSequence'),
    priorCheckpointDigest: hx(o.priorCheckpointDigest, 'priorCheckpointDigest'),
    projectionSchemaVersion: str(o.projectionSchemaVersion, 'projectionSchemaVersion'),
    baseRefs: refs,
    checkpointDigest: '',
  };
  hs(out, o.checkpointDigest, 'checkpointDigest', 'projection_checkpoint');
  return { ...out, checkpointDigest: hx(o.checkpointDigest, 'checkpointDigest') };
}

/* ---- publication_operation_payload (§7.1/§8) -------------------- */
const PUBLISH_KINDS = [
  'map_build_commit', 'map_candidate_commit', 'content_revision_commit', 'content_plan_finalize',
  'review_assignment_commit', 'map_review_settlement', 'map_review_round_completed', 'content_review_settlement', 'map_activation',
  // Task 18 content-review branches (freeze / round closure / settlement / cycle-boundary round creation).
  'content_review_assignment_commit', 'content_review_round_completed', 'content_review_round_planned',
  'generation_finalize', 'repair_finalize', 'migration_settlement', 'seal_publish',
  // Task 15 map-build service: finish proposal + the two finalizer envelopes.
  'map_build_finish', 'map_finalize_commit', 'map_finalize_rejected',
  // Task 19 repair service: plan creation / serial batches / scope flow.
  'repair_plan_creation', 'repair_batch_commit', 'repair_scope_request', 'repair_scope_approval', 'repair_scope_rejection',
] as const;
/** Task 10 extended builder set (see authority-types.ts union doc). */
const EVENT_BUILDERS = [
  'work_item_created', 'work_item_leased', 'work_item_retryable_failed',
  'work_item_requeued', 'work_item_lease_reclaimed', 'work_item_parked',
  'task_terminal_failed', 'work_item_terminal_failed',
  // Task 12: the SUCCESS completion envelope ([attempt/command completed,
  // work_item_completed] in one batch).
  'work_item_completed',
] as const;
const LIFECYCLE_KINDS = ['stop', 'resume', 'manual_retry', 'run_migration_batch', 'start'] as const;
const RECLAIM_REASONS = ['lease_expired', 'crash_recovery', 'user_stop', 'operator_interrupt'] as const;
const SUSPENSION_REASONS = ['user_stop', 'operator_interrupt'] as const;
const ATTEMPT_FAMILIES = ['structured', 'generic', 'command'] as const;
const SYSTEM_COMMAND_KINDS = [
  'map_finalize', 'generation_finalize', 'repair_finalize',
  'migration_validation_batch', 'review_settlement', 'seal',
] as const;
const RECIPE_KEYS = ['retry_system_command', 'restart_map_review_cycle', 'restart_content_review_cycle', 'rebuild_missing_work'] as const;

export function parsePublicationOperationPayload(value: unknown): PublicationOperationPayloadV2 {
  const o = rec(value, 'publication_operation_payload');
  const family = str(o.family, 'publication_operation_payload.family');
  if (family === 'domain_publish') {
    ex(o, ['family', 'operationId', 'taskId', 'publishKind', 'blobRefs', 'expectedResultIdentity', 'mapBuild', 'mapReview', 'contentPlan', 'contentReview', 'repair'], 'publication_operation_payload');
    if (!(PUBLISH_KINDS as readonly string[]).includes(str(o.publishKind, 'publishKind'))) throw new SchemaError('publishKind unknown');
    return {
      family,
      operationId: str(o.operationId, 'operationId'),
      taskId: str(o.taskId, 'taskId'),
      publishKind: str(o.publishKind, 'publishKind') as PublicationOperationPayloadV2 extends infer _ ? never : never,
      blobRefs: rfa(o.blobRefs, 'blobRefs'),
      expectedResultIdentity: str(o.expectedResultIdentity, 'expectedResultIdentity'),
      mapBuild: parseMapBuildPublishCarriers(o.mapBuild),
      mapReview: parseMapReviewPublishCarriers(o.mapReview),
      contentPlan: parseContentPlanPublishCarriers(o.contentPlan),
      contentReview: parseContentReviewPublishCarriers(o.contentReview),
      repair: parseRepairPublishCarriers(o.repair),
    } as PublicationOperationPayloadV2;
  }
  if (family === 'lease_or_retry') {
    ex(o, [
      'family', 'operationId', 'taskId', 'workItemId', 'leaseEpoch', 'eventBuilder', 'authorityBaseRef',
      'kind', 'roleBinding', 'agentExecutionKind', 'sessionKind', 'roundId', 'logicalAssignmentId',
      'reviewAssignmentId', 'grantSpecRef', 'inputArtifactDeliveryId', 'payloadRef',
      'initialLeaseEpoch', 'maxAutomaticRetries', 'leaseOwner', 'leaseExpiresAt',
      'expectedLastSequence', 'attemptFamily', 'attemptId', 'commandId', 'agentId', 'commandKind',
      'dispatchRef', 'grantInstanceRef', 'reason', 'failureCode', 'failureDigest', 'retryOrdinal',
      'retryNotBefore', 'validatorAggregateRef', 'budgetPolicyDigest', 'failureRecoveryPayloadRef', 'taskFailure',
      'resultRefs',
    ], 'publication_operation_payload');
    if (!(EVENT_BUILDERS as readonly string[]).includes(str(o.eventBuilder, 'eventBuilder'))) throw new SchemaError('eventBuilder unknown');
    const attemptFamily = o.attemptFamily === null ? null : str(o.attemptFamily, 'attemptFamily');
    if (attemptFamily !== null && !(ATTEMPT_FAMILIES as readonly string[]).includes(attemptFamily)) throw new SchemaError('attemptFamily unknown');
    const reason = o.reason === null ? null : str(o.reason, 'reason');
    if (reason !== null && !(RECLAIM_REASONS as readonly string[]).includes(reason)) throw new SchemaError('reason unknown');
    const agentExecutionKind = o.agentExecutionKind === null ? null : str(o.agentExecutionKind, 'agentExecutionKind');
    if (agentExecutionKind !== null && agentExecutionKind !== 'structured_session' && agentExecutionKind !== 'generic_turn') {
      throw new SchemaError('agentExecutionKind must be structured_session|generic_turn|null');
    }
    const commandKind = o.commandKind === null ? null : str(o.commandKind, 'commandKind');
    if (commandKind !== null && !(SYSTEM_COMMAND_KINDS as readonly string[]).includes(commandKind)) throw new SchemaError('commandKind unknown');
    return {
      family,
      operationId: str(o.operationId, 'operationId'),
      taskId: str(o.taskId, 'taskId'),
      workItemId: str(o.workItemId, 'workItemId'),
      leaseEpoch: onn(o.leaseEpoch, 'leaseEpoch'),
      eventBuilder: str(o.eventBuilder, 'eventBuilder') as PublicationOperationPayloadV2 extends infer _ ? never : never,
      authorityBaseRef: rf(o.authorityBaseRef, 'authorityBaseRef'),
      kind: o.kind === null ? null : (str(o.kind, 'kind') as PublicationOperationPayloadV2 extends infer _ ? never : never),
      roleBinding: o.roleBinding === null ? null : str(o.roleBinding, 'roleBinding'),
      agentExecutionKind,
      sessionKind: o.sessionKind === null ? null : (str(o.sessionKind, 'sessionKind') as PublicationOperationPayloadV2 extends infer _ ? never : never),
      roundId: o.roundId === null ? null : str(o.roundId, 'roundId'),
      logicalAssignmentId: o.logicalAssignmentId === null ? null : str(o.logicalAssignmentId, 'logicalAssignmentId'),
      reviewAssignmentId: o.reviewAssignmentId === null ? null : str(o.reviewAssignmentId, 'reviewAssignmentId'),
      grantSpecRef: rfn(o.grantSpecRef, 'grantSpecRef'),
      inputArtifactDeliveryId: o.inputArtifactDeliveryId === null ? null : str(o.inputArtifactDeliveryId, 'inputArtifactDeliveryId'),
      payloadRef: rfn(o.payloadRef, 'payloadRef'),
      initialLeaseEpoch: o.initialLeaseEpoch === null ? null : onn(o.initialLeaseEpoch, 'initialLeaseEpoch'),
      maxAutomaticRetries: o.maxAutomaticRetries === null ? null : onn(o.maxAutomaticRetries, 'maxAutomaticRetries'),
      leaseOwner: o.leaseOwner === null ? null : str(o.leaseOwner, 'leaseOwner'),
      leaseExpiresAt: o.leaseExpiresAt === null ? null : str(o.leaseExpiresAt, 'leaseExpiresAt'),
      expectedLastSequence: o.expectedLastSequence === null ? null : onn(o.expectedLastSequence, 'expectedLastSequence'),
      attemptFamily,
      attemptId: o.attemptId === null ? null : str(o.attemptId, 'attemptId'),
      commandId: o.commandId === null ? null : str(o.commandId, 'commandId'),
      agentId: o.agentId === null ? null : str(o.agentId, 'agentId'),
      commandKind,
      dispatchRef: rfn(o.dispatchRef, 'dispatchRef'),
      grantInstanceRef: rfn(o.grantInstanceRef, 'grantInstanceRef'),
      reason,
      failureCode: o.failureCode === null ? null : str(o.failureCode, 'failureCode'),
      failureDigest: o.failureDigest === null ? null : hx(o.failureDigest, 'failureDigest'),
      retryOrdinal: o.retryOrdinal === null ? null : onn(o.retryOrdinal, 'retryOrdinal'),
      retryNotBefore: o.retryNotBefore === null ? null : str(o.retryNotBefore, 'retryNotBefore'),
      validatorAggregateRef: rfn(o.validatorAggregateRef, 'validatorAggregateRef'),
      budgetPolicyDigest: o.budgetPolicyDigest === null ? null : hx(o.budgetPolicyDigest, 'budgetPolicyDigest'),
      failureRecoveryPayloadRef: rfn(o.failureRecoveryPayloadRef, 'failureRecoveryPayloadRef'),
      taskFailure: o.taskFailure === null ? null : (o.taskFailure === true || o.taskFailure === false ? o.taskFailure : (() => { throw new SchemaError('taskFailure must be boolean|null'); })()),
      resultRefs: rfa(o.resultRefs, 'resultRefs'),
    } as PublicationOperationPayloadV2;
  }
  if (family === 'lifecycle') {
    ex(o, ['family', 'operationId', 'taskId', 'kind', 'suspensionId', 'workItemId', 'reason', 'leaseEpoch', 'expectedLastSequence', 'authorityBaseRef', 'attemptFamily', 'attemptId', 'commandId', 'agentId', 'commandKind', 'logicalAssignmentId', 'reviewAssignmentId', 'sessionKind', 'inputArtifactDeliveryId', 'workItemKind', 'roleBinding', 'agentExecutionKind', 'roundId', 'grantSpecRef', 'payloadRef', 'initialLeaseEpoch', 'maxAutomaticRetries', 'mapBuildId', 'supersedesMapBuildId', 'sourceValidationReceiptRef'], 'publication_operation_payload');
    if (!(LIFECYCLE_KINDS as readonly string[]).includes(str(o.kind, 'kind'))) throw new SchemaError('kind unknown');
    const reason = o.reason === null ? null : str(o.reason, 'reason');
    if (reason !== null && !(SUSPENSION_REASONS as readonly string[]).includes(reason)) throw new SchemaError('reason unknown');
    const attemptFamily = o.attemptFamily === null ? null : str(o.attemptFamily, 'attemptFamily');
    if (attemptFamily !== null && !(ATTEMPT_FAMILIES as readonly string[]).includes(attemptFamily)) throw new SchemaError('attemptFamily unknown');
    const commandKind = o.commandKind === null ? null : str(o.commandKind, 'commandKind');
    if (commandKind !== null && !(SYSTEM_COMMAND_KINDS as readonly string[]).includes(commandKind)) throw new SchemaError('commandKind unknown');
    const agentExecutionKind = o.agentExecutionKind === null ? null : str(o.agentExecutionKind, 'agentExecutionKind');
    if (agentExecutionKind !== null && agentExecutionKind !== 'structured_session' && agentExecutionKind !== 'generic_turn') {
      throw new SchemaError('agentExecutionKind must be structured_session|generic_turn|null');
    }
    const workItemKind = o.workItemKind === null ? null : (str(o.workItemKind, 'workItemKind') as PublicationOperationPayloadV2 extends infer _ ? never : never);
    return {
      family,
      operationId: str(o.operationId, 'operationId'),
      taskId: str(o.taskId, 'taskId'),
      kind: str(o.kind, 'kind') as PublicationOperationPayloadV2 extends infer _ ? never : never,
      suspensionId: o.suspensionId === null ? null : str(o.suspensionId, 'suspensionId'),
      workItemId: o.workItemId === null ? null : str(o.workItemId, 'workItemId'),
      reason,
      leaseEpoch: o.leaseEpoch === null ? null : onn(o.leaseEpoch, 'leaseEpoch'),
      expectedLastSequence: o.expectedLastSequence === null ? null : onn(o.expectedLastSequence, 'expectedLastSequence'),
      authorityBaseRef: rfn(o.authorityBaseRef, 'authorityBaseRef'),
      attemptFamily,
      attemptId: o.attemptId === null ? null : str(o.attemptId, 'attemptId'),
      commandId: o.commandId === null ? null : str(o.commandId, 'commandId'),
      agentId: o.agentId === null ? null : str(o.agentId, 'agentId'),
      commandKind,
      logicalAssignmentId: o.logicalAssignmentId === null ? null : str(o.logicalAssignmentId, 'logicalAssignmentId'),
      reviewAssignmentId: o.reviewAssignmentId === null ? null : str(o.reviewAssignmentId, 'reviewAssignmentId'),
      sessionKind: o.sessionKind === null ? null : (str(o.sessionKind, 'sessionKind') as PublicationOperationPayloadV2 extends infer _ ? never : never),
      inputArtifactDeliveryId: o.inputArtifactDeliveryId === null ? null : str(o.inputArtifactDeliveryId, 'inputArtifactDeliveryId'),
      workItemKind,
      roleBinding: o.roleBinding === null ? null : str(o.roleBinding, 'roleBinding'),
      agentExecutionKind,
      roundId: o.roundId === null ? null : str(o.roundId, 'roundId'),
      grantSpecRef: rfn(o.grantSpecRef, 'grantSpecRef'),
      payloadRef: rfn(o.payloadRef, 'payloadRef'),
      initialLeaseEpoch: o.initialLeaseEpoch === null ? null : onn(o.initialLeaseEpoch, 'initialLeaseEpoch'),
      maxAutomaticRetries: o.maxAutomaticRetries === null ? null : onn(o.maxAutomaticRetries, 'maxAutomaticRetries'),
      mapBuildId: o.mapBuildId === null ? null : str(o.mapBuildId, 'mapBuildId'),
      supersedesMapBuildId: o.supersedesMapBuildId === null ? null : str(o.supersedesMapBuildId, 'supersedesMapBuildId'),
      sourceValidationReceiptRef: rfn(o.sourceValidationReceiptRef, 'sourceValidationReceiptRef'),
    } as PublicationOperationPayloadV2;
  }
  if (family === 'question') {
    // Task 11 (constraint A round 2): exact per-mode key matrix. The answer
    // branch carries the delivery identities the delivered event demands;
    // the open branch carries the opened-event + attempt-terminal + park
    // carriers. Every other field must be null for the active mode.
    ex(o, ['family', 'operationId', 'taskId', 'questionId', 'questionVersion', 'mode', 'questionDigest', 'text', 'answerText', 'openedCommitId', 'expectedLastSequence', 'originalWorkItemId', 'replacementWorkItemId', 'deliveryId', 'attemptId', 'leaseEpoch', 'logicalAssignmentId', 'reviewAssignmentId', 'sessionKind', 'agentId', 'answerDigest', 'authorityBaseRef', 'kind', 'roleBinding', 'agentExecutionKind', 'roundId', 'grantSpecRef', 'inputArtifactDeliveryId', 'payloadRef', 'initialLeaseEpoch', 'maxAutomaticRetries', 'failureCode', 'failureDigest'], 'publication_operation_payload');
    const mode = str(o.mode, 'mode');
    if (mode !== 'open' && mode !== 'answer') throw new SchemaError('question.mode must be open|answer');
    const required = (fields: readonly string[], missing: string[]): void => {
      for (const field of fields) {
        if (o[field] === null || o[field] === undefined) missing.push(field);
      }
    };
    const nulled = (fields: readonly string[], bad: string[]): void => {
      for (const field of fields) {
        if (o[field] !== null) bad.push(field);
      }
    };
    // Common exact fields.
    const out: Record<string, unknown> = {
      family,
      operationId: str(o.operationId, 'operationId'),
      taskId: str(o.taskId, 'taskId'),
      questionId: str(o.questionId, 'questionId'),
      questionVersion: str(o.questionVersion, 'questionVersion'),
      mode,
      authorityBaseRef: rf(o.authorityBaseRef, 'authorityBaseRef'),
    };
    if (mode === 'open') {
      const missing: string[] = [];
      required(['questionDigest', 'text', 'openedCommitId', 'originalWorkItemId', 'attemptId', 'leaseEpoch', 'logicalAssignmentId', 'sessionKind', 'agentId', 'failureCode', 'failureDigest'], missing);
      nulled(['replacementWorkItemId', 'deliveryId', 'answerText', 'answerDigest', 'kind', 'roleBinding', 'agentExecutionKind', 'roundId', 'grantSpecRef', 'inputArtifactDeliveryId', 'payloadRef', 'initialLeaseEpoch', 'maxAutomaticRetries'], missing);
      if (missing.length > 0) throw new SchemaError(`question open payload missing or illegal fields: ${missing.join(', ')}`);
      out.questionDigest = hx(o.questionDigest, 'questionDigest');
      out.text = str(o.text, 'text');
      out.answerText = null;
      out.openedCommitId = str(o.openedCommitId, 'openedCommitId');
      out.originalWorkItemId = str(o.originalWorkItemId, 'originalWorkItemId');
      out.attemptId = str(o.attemptId, 'attemptId');
      out.leaseEpoch = onn(o.leaseEpoch, 'leaseEpoch');
      out.logicalAssignmentId = str(o.logicalAssignmentId, 'logicalAssignmentId');
      out.reviewAssignmentId = o.reviewAssignmentId === null ? null : str(o.reviewAssignmentId, 'reviewAssignmentId');
      out.sessionKind = str(o.sessionKind, 'sessionKind') as PublicationOperationPayloadV2 extends infer _ ? never : never;
      out.agentId = str(o.agentId, 'agentId');
      out.failureCode = str(o.failureCode, 'failureCode');
      out.failureDigest = hx(o.failureDigest, 'failureDigest');
      out.replacementWorkItemId = null;
      out.deliveryId = null;
      out.answerDigest = null;
      out.kind = null;
      out.roleBinding = null;
      out.agentExecutionKind = null;
      out.roundId = null;
      out.grantSpecRef = null;
      out.inputArtifactDeliveryId = null;
      out.payloadRef = null;
      out.initialLeaseEpoch = null;
      out.maxAutomaticRetries = null;
    } else {
      const missing: string[] = [];
      required(['originalWorkItemId', 'replacementWorkItemId', 'deliveryId', 'logicalAssignmentId', 'answerDigest', 'answerText', 'agentId', 'kind', 'roleBinding', 'payloadRef', 'initialLeaseEpoch', 'maxAutomaticRetries', 'leaseEpoch', 'sessionKind'], missing);
      nulled(['questionDigest', 'text', 'openedCommitId', 'attemptId', 'failureCode', 'failureDigest'], missing);
      if (missing.length > 0) throw new SchemaError(`question answer payload missing or illegal fields: ${missing.join(', ')}`);
      out.originalWorkItemId = str(o.originalWorkItemId, 'originalWorkItemId');
      out.replacementWorkItemId = str(o.replacementWorkItemId, 'replacementWorkItemId');
      out.deliveryId = str(o.deliveryId, 'deliveryId');
      out.logicalAssignmentId = str(o.logicalAssignmentId, 'logicalAssignmentId');
      out.answerDigest = hx(o.answerDigest, 'answerDigest');
      out.answerText = str(o.answerText, 'answerText');
      out.agentId = str(o.agentId, 'agentId');
      out.leaseEpoch = onn(o.leaseEpoch, 'leaseEpoch');
      out.kind = str(o.kind, 'kind') as PublicationOperationPayloadV2 extends infer _ ? never : never;
      out.roleBinding = o.roleBinding === null ? null : str(o.roleBinding, 'roleBinding');
      out.agentExecutionKind = o.agentExecutionKind === null ? null : str(o.agentExecutionKind, 'agentExecutionKind');
      out.roundId = o.roundId === null ? null : str(o.roundId, 'roundId');
      out.grantSpecRef = rfn(o.grantSpecRef, 'grantSpecRef');
      out.inputArtifactDeliveryId = o.inputArtifactDeliveryId === null ? null : str(o.inputArtifactDeliveryId, 'inputArtifactDeliveryId');
      out.payloadRef = rf(o.payloadRef, 'payloadRef');
      out.initialLeaseEpoch = onn(o.initialLeaseEpoch, 'initialLeaseEpoch');
      out.maxAutomaticRetries = onn(o.maxAutomaticRetries, 'maxAutomaticRetries');
      out.questionDigest = null;
      out.text = null;
      out.openedCommitId = null;
      out.attemptId = null;
      out.sessionKind = str(o.sessionKind, 'sessionKind') as PublicationOperationPayloadV2 extends infer _ ? never : never;
      out.reviewAssignmentId = o.reviewAssignmentId === null ? null : str(o.reviewAssignmentId, 'reviewAssignmentId');
      out.failureCode = null;
      out.failureDigest = null;
    }
    out.expectedLastSequence = o.expectedLastSequence === null ? null : onn(o.expectedLastSequence, 'expectedLastSequence');
    return out as PublicationOperationPayloadV2;
  }
  if (family === 'recovery') {
    ex(o, ['family', 'operationId', 'taskId', 'expectedLastSequence', 'operatorId', 'reason', 'recipeKey', 'track', 'failureRecoveryPayloadRef', 'overrideRef', 'replacementWorkItemId', 'replacementKind', 'replacementRoleBinding', 'replacementAgentExecutionKind', 'replacementSessionKind', 'replacementRoundId', 'replacementLogicalAssignmentId', 'replacementReviewAssignmentId', 'replacementGrantSpecRef', 'replacementInputArtifactDeliveryId', 'replacementPayloadRef', 'replacementAuthorityBaseRef', 'replacementLeaseEpoch', 'replacementMaxAutomaticRetries'], 'publication_operation_payload');
    if (!(RECIPE_KEYS as readonly string[]).includes(str(o.recipeKey, 'recipeKey'))) throw new SchemaError('recipeKey unknown');
    const track = o.track === null ? null : str(o.track, 'track');
    if (track !== null && track !== 'map' && track !== 'content') throw new SchemaError('track must be map|content|null');
    const replacementAgentExecutionKind = o.replacementAgentExecutionKind === null ? null : str(o.replacementAgentExecutionKind, 'replacementAgentExecutionKind');
    if (replacementAgentExecutionKind !== null && replacementAgentExecutionKind !== 'structured_session' && replacementAgentExecutionKind !== 'generic_turn') {
      throw new SchemaError('replacementAgentExecutionKind must be structured_session|generic_turn|null');
    }
    const replacementSessionKind = o.replacementSessionKind === null ? null : (str(o.replacementSessionKind, 'replacementSessionKind') as PublicationOperationPayloadV2 extends infer _ ? never : never);
    const replacementKind = o.replacementKind === null ? null : (str(o.replacementKind, 'replacementKind') as PublicationOperationPayloadV2 extends infer _ ? never : never);
    if (replacementKind !== null && o.replacementWorkItemId === null) {
      throw new SchemaError('replacementWorkItemId is required when a replacement is declared');
    }
    return {
      family,
      operationId: str(o.operationId, 'operationId'),
      taskId: str(o.taskId, 'taskId'),
      expectedLastSequence: onn(o.expectedLastSequence, 'expectedLastSequence'),
      operatorId: str(o.operatorId, 'operatorId'),
      reason: str(o.reason, 'reason'),
      recipeKey: str(o.recipeKey, 'recipeKey') as PublicationOperationPayloadV2 extends infer _ ? never : never,
      track,
      failureRecoveryPayloadRef: rf(o.failureRecoveryPayloadRef, 'failureRecoveryPayloadRef'),
      overrideRef: rfn(o.overrideRef, 'overrideRef'),
      replacementWorkItemId: o.replacementWorkItemId === null ? null : str(o.replacementWorkItemId, 'replacementWorkItemId'),
      replacementKind,
      replacementRoleBinding: o.replacementRoleBinding === null ? null : str(o.replacementRoleBinding, 'replacementRoleBinding'),
      replacementAgentExecutionKind,
      replacementSessionKind,
      replacementRoundId: o.replacementRoundId === null ? null : str(o.replacementRoundId, 'replacementRoundId'),
      replacementLogicalAssignmentId: o.replacementLogicalAssignmentId === null ? null : str(o.replacementLogicalAssignmentId, 'replacementLogicalAssignmentId'),
      replacementReviewAssignmentId: o.replacementReviewAssignmentId === null ? null : str(o.replacementReviewAssignmentId, 'replacementReviewAssignmentId'),
      replacementGrantSpecRef: rfn(o.replacementGrantSpecRef, 'replacementGrantSpecRef'),
      replacementInputArtifactDeliveryId: o.replacementInputArtifactDeliveryId === null ? null : str(o.replacementInputArtifactDeliveryId, 'replacementInputArtifactDeliveryId'),
      replacementPayloadRef: rfn(o.replacementPayloadRef, 'replacementPayloadRef'),
      replacementAuthorityBaseRef: rfn(o.replacementAuthorityBaseRef, 'replacementAuthorityBaseRef'),
      replacementLeaseEpoch: o.replacementLeaseEpoch === null ? null : onn(o.replacementLeaseEpoch, 'replacementLeaseEpoch'),
      replacementMaxAutomaticRetries: o.replacementMaxAutomaticRetries === null ? null : onn(o.replacementMaxAutomaticRetries, 'replacementMaxAutomaticRetries'),
    } as PublicationOperationPayloadV2;
  }
  if (family === 'delete') {
    ex(o, ['family', 'operationId', 'taskId', 'deleteEpoch'], 'publication_operation_payload');
    return {
      family,
      operationId: str(o.operationId, 'operationId'),
      taskId: str(o.taskId, 'taskId'),
      deleteEpoch: onn(o.deleteEpoch, 'deleteEpoch'),
    } as PublicationOperationPayloadV2;
  }
  if (family === 'artifact_publish') {
    ex(o, ['family', 'operationId', 'taskId', 'artifactRef', 'sealRecordRef', 'deliveryRef', 'expectedArtifactVersion'], 'publication_operation_payload');
    return {
      family,
      operationId: str(o.operationId, 'operationId'),
      taskId: str(o.taskId, 'taskId'),
      artifactRef: rfKind(o.artifactRef, 'artifact', 'artifactRef'),
      sealRecordRef: rfKind(o.sealRecordRef, 'seal_record', 'sealRecordRef'),
      deliveryRef: rfKind(o.deliveryRef, 'system_artifact_delivery', 'deliveryRef'),
      expectedArtifactVersion: onn(o.expectedArtifactVersion, 'expectedArtifactVersion'),
    } as PublicationOperationPayloadV2;
  }
  throw new SchemaError('publication_operation_payload.family must be domain_publish|lease_or_retry|lifecycle|question|recovery|delete|artifact_publish');
}

/* ---- Task 15 domain_publish carriers (map-build service) --------- */
function parseMapBuildPublishCarriers(value: unknown): MapBuildPublishCarriersV2 | null {
  if (value === null) return null;
  const o = rec(value, 'mapBuild');
  ex(o, ['mapBuildId', 'chunkId', 'chunkOrdinal', 'parentFrontierDigest', 'expectedChunkCount', 'expectedRootCount', 'candidateId', 'candidateDigest', 'baseMapId', 'manifestRef', 'contributionManifestRef', 'validationReceiptRef', 'validatorAggregateRef', 'round', 'terminal', 'successor', 'successorBuildStart'], 'mapBuild');
  return {
    mapBuildId: o.mapBuildId === null ? null : str(o.mapBuildId, 'mapBuild.mapBuildId'),
    chunkId: o.chunkId === null ? null : str(o.chunkId, 'mapBuild.chunkId'),
    chunkOrdinal: o.chunkOrdinal === null ? null : onn(o.chunkOrdinal, 'mapBuild.chunkOrdinal'),
    parentFrontierDigest: o.parentFrontierDigest === null ? null : hx(o.parentFrontierDigest, 'mapBuild.parentFrontierDigest'),
    expectedChunkCount: o.expectedChunkCount === null ? null : onn(o.expectedChunkCount, 'mapBuild.expectedChunkCount'),
    expectedRootCount: o.expectedRootCount === null ? null : onn(o.expectedRootCount, 'mapBuild.expectedRootCount'),
    candidateId: o.candidateId === null ? null : str(o.candidateId, 'mapBuild.candidateId'),
    candidateDigest: o.candidateDigest === null ? null : hx(o.candidateDigest, 'mapBuild.candidateDigest'),
    baseMapId: o.baseMapId === null ? null : str(o.baseMapId, 'mapBuild.baseMapId'),
    manifestRef: rfn(o.manifestRef, 'mapBuild.manifestRef'),
    contributionManifestRef: rfn(o.contributionManifestRef, 'mapBuild.contributionManifestRef'),
    validationReceiptRef: rfn(o.validationReceiptRef, 'mapBuild.validationReceiptRef'),
    validatorAggregateRef: rfn(o.validatorAggregateRef, 'mapBuild.validatorAggregateRef'),
    round: parseMapReviewRoundPlanCarrier(o.round),
    terminal: parseSystemCommandTerminalCarrier(o.terminal),
    successor: parseSuccessorWorkItemCarrier(o.successor),
    successorBuildStart: parseSuccessorBuildStartCarrier(o.successorBuildStart),
  };
}

function parseSuccessorBuildStartCarrier(value: unknown): MapBuildPublishCarriersV2['successorBuildStart'] {
  if (value === null) return null;
  const o = rec(value, 'successorBuildStart');
  ex(o, ['mapBuildId', 'revision', 'supersedesMapBuildId', 'mapBuildSpecRef', 'sourceValidationReceiptRef'], 'successorBuildStart');
  return {
    mapBuildId: str(o.mapBuildId, 'successorBuildStart.mapBuildId'),
    revision: onn(o.revision, 'successorBuildStart.revision'),
    supersedesMapBuildId: o.supersedesMapBuildId === null ? null : str(o.supersedesMapBuildId, 'successorBuildStart.supersedesMapBuildId'),
    mapBuildSpecRef: rfKind(o.mapBuildSpecRef, 'map_build_spec', 'successorBuildStart.mapBuildSpecRef'),
    sourceValidationReceiptRef: rfn(o.sourceValidationReceiptRef, 'successorBuildStart.sourceValidationReceiptRef'),
  };
}

/**
 * Task 16 map-review carriers: `review_assignment_commit`, `map_review_round_completed`
 * and `map_review_settlement` (the activation envelope). Every carrier is null
 * when the publish branch does not use it (the exact-key parser rejects
 * anything else).
 */
function parseMapReviewPublishCarriers(value: unknown): MapReviewPublishCarriersV2 | null {
  if (value === null || value === undefined) return null;
  const o = rec(value, 'mapReview');
  const mapReviewKeys = [
    'assignmentId', 'mapReviewRoundId', 'workItemId', 'attemptId', 'reviewAssignmentId',
    'source', 'ledgerRef', 'coverageTargetCount', 'findingCount', 'observations', 'verificationRecords',
    'coverageCoreRef', 'settlementCoreRef', 'outcome',
    'mapId', 'mapRevision', 'supersedesMapId', 'mapSnapshotRef', 'mapReviewBundleRef',
    'mapSemanticDigest', 'contentRevisionManifestRef', 'activationValidatorAggregateRef',
    'migrationSettlementCoreRef', 'migrationActivationDecisionRef',
    'taskContentRevision', 'manifestPhase', 'producerPlanSpecRef', 'priorManifestRef',
    'successor', 'terminal', 'contentRound', 'reviewWorkItems', 'mixedContentRepair', 'verifiedClosedFindingIds',
  ];
  const extendedMapReviewKeys = [...mapReviewKeys];
  if (Object.prototype.hasOwnProperty.call(o, 'migrationProvisionalManifestRef')) extendedMapReviewKeys.push('migrationProvisionalManifestRef');
  if (Object.prototype.hasOwnProperty.call(o, 'migrationFinalizerAggregateRef')) extendedMapReviewKeys.push('migrationFinalizerAggregateRef');
  if (Object.prototype.hasOwnProperty.call(o, 'migrationProgress')) extendedMapReviewKeys.push('migrationProgress');
  ex(o, extendedMapReviewKeys, 'mapReview');
  const source = o.source === null ? null : str(o.source, 'mapReview.source');
  if (source !== null && source !== 'batch' && source !== 'whole_map_observation') {
    throw new SchemaError('mapReview.source must be batch|whole_map_observation|null');
  }
  const outcome = o.outcome === null ? null : str(o.outcome, 'mapReview.outcome');
  if (outcome !== null && outcome !== 'map_repair' && outcome !== 'activate') {
    throw new SchemaError('mapReview.outcome must be map_repair|activate|null');
  }
  const manifestPhase = o.manifestPhase === null ? null : str(o.manifestPhase, 'mapReview.manifestPhase');
  if (manifestPhase !== null && manifestPhase !== 'baseline_unset' && manifestPhase !== 'provisional' && manifestPhase !== 'finalized') {
    throw new SchemaError('mapReview.manifestPhase must be baseline_unset|provisional|finalized|null');
  }
  const observations = o.observations === null ? null : (o.observations as unknown[]).map((v, i) => parseMapReviewObservationCarrier(v, `mapReview.observations[${i}]`));
  return {
    assignmentId: o.assignmentId === null ? null : str(o.assignmentId, 'mapReview.assignmentId'),
    mapReviewRoundId: o.mapReviewRoundId === null ? null : str(o.mapReviewRoundId, 'mapReview.mapReviewRoundId'),
    workItemId: o.workItemId === null ? null : str(o.workItemId, 'mapReview.workItemId'),
    attemptId: o.attemptId === null ? null : str(o.attemptId, 'mapReview.attemptId'),
    reviewAssignmentId: o.reviewAssignmentId === null ? null : str(o.reviewAssignmentId, 'mapReview.reviewAssignmentId'),
    source,
    ledgerRef: rfn(o.ledgerRef, 'mapReview.ledgerRef'),
    coverageTargetCount: o.coverageTargetCount === null ? null : onn(o.coverageTargetCount, 'mapReview.coverageTargetCount'),
    findingCount: o.findingCount === null ? null : onn(o.findingCount, 'mapReview.findingCount'),
    observations,
    verificationRecords: parseReviewerVerificationCarriers(o.verificationRecords, 'mapReview.verificationRecords'),
    coverageCoreRef: rfn(o.coverageCoreRef, 'mapReview.coverageCoreRef'),
    settlementCoreRef: rfn(o.settlementCoreRef, 'mapReview.settlementCoreRef'),
    outcome,
    mapId: o.mapId === null ? null : str(o.mapId, 'mapReview.mapId'),
    mapRevision: o.mapRevision === null ? null : onn(o.mapRevision, 'mapReview.mapRevision'),
    supersedesMapId: o.supersedesMapId === null ? null : str(o.supersedesMapId, 'mapReview.supersedesMapId'),
    mapSnapshotRef: rfn(o.mapSnapshotRef, 'mapReview.mapSnapshotRef'),
    mapReviewBundleRef: rfn(o.mapReviewBundleRef, 'mapReview.mapReviewBundleRef'),
    mapSemanticDigest: o.mapSemanticDigest === null ? null : hx(o.mapSemanticDigest, 'mapReview.mapSemanticDigest'),
    contentRevisionManifestRef: rfn(o.contentRevisionManifestRef, 'mapReview.contentRevisionManifestRef'),
    activationValidatorAggregateRef: rfn(o.activationValidatorAggregateRef, 'mapReview.activationValidatorAggregateRef'),
    migrationSettlementCoreRef: rfn(o.migrationSettlementCoreRef, 'mapReview.migrationSettlementCoreRef'),
    migrationActivationDecisionRef: rfn(o.migrationActivationDecisionRef, 'mapReview.migrationActivationDecisionRef'),
    migrationProvisionalManifestRef: o.migrationProvisionalManifestRef === undefined ? null : rfn(o.migrationProvisionalManifestRef, 'mapReview.migrationProvisionalManifestRef'),
    migrationFinalizerAggregateRef: o.migrationFinalizerAggregateRef === undefined ? null : rfn(o.migrationFinalizerAggregateRef, 'mapReview.migrationFinalizerAggregateRef'),
    taskContentRevision: o.taskContentRevision === null ? null : onn(o.taskContentRevision, 'mapReview.taskContentRevision'),
    manifestPhase,
    producerPlanSpecRef: rfn(o.producerPlanSpecRef, 'mapReview.producerPlanSpecRef'),
    priorManifestRef: rfn(o.priorManifestRef, 'mapReview.priorManifestRef'),
    successor: parseSuccessorWorkItemCarrier(o.successor),
    terminal: parseSystemCommandTerminalCarrier(o.terminal),
    contentRound: parseContentReviewRoundPlanCarrier(o.contentRound),
    reviewWorkItems: o.reviewWorkItems === null
      ? null
      : (o.reviewWorkItems as unknown[]).map((v, i) => parseSuccessorWorkItemCarrier(v)).filter((s): s is SuccessorWorkItemCarrierV2 => s !== null),
    mixedContentRepair: parseRepairPublishCarriers(o.mixedContentRepair),
    verifiedClosedFindingIds: o.verifiedClosedFindingIds === null || o.verifiedClosedFindingIds === undefined ? null : sa(o.verifiedClosedFindingIds, 'mapReview.verifiedClosedFindingIds'),
    migrationProgress: parseMigrationProgressCarrier(o.migrationProgress),
  };
}

function parseMigrationProgressCarrier(value: unknown): import('./authority-types').MigrationProgressPublishCarrierV2 | null {
  if (value === null || value === undefined) return null;
  const o = rec(value, 'mapReview.migrationProgress');
  ex(o, ['stage', 'migrationValidationPlanId', 'intentCoreRef', 'planSpecRef', 'batchOrdinal', 'batchResultRootRef', 'batchOutcome', 'successor', 'terminal'], 'mapReview.migrationProgress');
  const stage = str(o.stage, 'mapReview.migrationProgress.stage');
  if (stage !== 'initial' && stage !== 'batch') throw new SchemaError('migrationProgress.stage must be initial|batch');
  const batchOutcome = o.batchOutcome === null ? null : str(o.batchOutcome, 'mapReview.migrationProgress.batchOutcome');
  if (batchOutcome !== null && !['clear', 'content_repair', 'map_repair', 'infrastructure_failure'].includes(batchOutcome)) {
    throw new SchemaError('migrationProgress.batchOutcome unknown');
  }
  const successor = parseSuccessorWorkItemCarrier(o.successor);
  const terminal = parseSystemCommandTerminalCarrier(o.terminal);
  if (successor === null || terminal === null) throw new SchemaError('migrationProgress requires successor and terminal');
  const out = {
    stage: stage as 'initial' | 'batch',
    migrationValidationPlanId: o.migrationValidationPlanId === null ? null : str(o.migrationValidationPlanId, 'migrationValidationPlanId'),
    intentCoreRef: rfn(o.intentCoreRef, 'migrationProgress.intentCoreRef'),
    planSpecRef: rfKind(o.planSpecRef, 'migration_validation_plan_spec', 'migrationProgress.planSpecRef'),
    batchOrdinal: o.batchOrdinal === null ? null : onn(o.batchOrdinal, 'migrationProgress.batchOrdinal'),
    batchResultRootRef: o.batchResultRootRef === null ? null : rfKind(o.batchResultRootRef, 'migration_validation_batch_result', 'migrationProgress.batchResultRootRef'),
    batchOutcome: batchOutcome as import('./authority-types').MigrationBatchRouteOutcomeV2 | null,
    successor,
    terminal,
  };
  if (stage === 'initial' && (out.migrationValidationPlanId === null || out.intentCoreRef === null || out.batchOrdinal !== null || out.batchResultRootRef !== null || out.batchOutcome !== null)) {
    throw new SchemaError('initial migrationProgress carriers are inconsistent');
  }
  if (stage === 'batch' && (out.migrationValidationPlanId !== null || out.intentCoreRef !== null || out.batchOrdinal === null || out.batchResultRootRef === null || out.batchOutcome === null)) {
    throw new SchemaError('batch migrationProgress carriers are inconsistent');
  }
  return out;
}

/**
 * Task 17 content-plan carriers (deterministic rebuild; exact-key parser).
 */
function parseContentPlanPublishCarriers(value: unknown): ContentPlanPublishCarriersV2 | null {
  if (value === null || value === undefined) return null;
  const o = rec(value, 'contentPlan');
  ex(o, [
    'generationPlanId', 'generationPlanRevision', 'supersedesGenerationPlanId',
    'generationPlanSpecRef', 'sourceValidationReceiptRef', 'planStarted',
    'batchOrdinal', 'contentRevisionCommitCoreRef', 'validatorAggregateRef',
    'contentRevisionManifestRef', 'taskContentRevision', 'manifestPhase',
    'producerPlanSpecRef', 'priorManifestRef', 'successor',
    'finalizerWarningRootRef', 'reviewRound', 'reviewWorkItems',
    'validationReceiptRef', 'successorPlanRevision', 'successorPlanRef',
    'terminal',
  ], 'contentPlan');
  const manifestPhase = o.manifestPhase === null ? null : str(o.manifestPhase, 'contentPlan.manifestPhase');
  if (manifestPhase !== null && manifestPhase !== 'provisional' && manifestPhase !== 'finalized') {
    throw new SchemaError('contentPlan.manifestPhase must be provisional|finalized|null');
  }
  const planStartedRaw = o.planStarted;
  if (planStartedRaw !== null && typeof planStartedRaw !== 'boolean') {
    throw new SchemaError('contentPlan.planStarted must be a boolean or null');
  }
  const planStarted = planStartedRaw as boolean | null;
  const reviewWorkItems = o.reviewWorkItems === null
    ? null
    : (o.reviewWorkItems as unknown[]).map((v, i) => parseSuccessorWorkItemCarrier(v)).filter((s): s is SuccessorWorkItemCarrierV2 => s !== null);
  return {
    generationPlanId: o.generationPlanId === null ? null : str(o.generationPlanId, 'contentPlan.generationPlanId'),
    generationPlanRevision: o.generationPlanRevision === null ? null : onn(o.generationPlanRevision, 'contentPlan.generationPlanRevision'),
    supersedesGenerationPlanId: o.supersedesGenerationPlanId === null ? null : str(o.supersedesGenerationPlanId, 'contentPlan.supersedesGenerationPlanId'),
    generationPlanSpecRef: rfn(o.generationPlanSpecRef, 'contentPlan.generationPlanSpecRef'),
    sourceValidationReceiptRef: rfn(o.sourceValidationReceiptRef, 'contentPlan.sourceValidationReceiptRef'),
    planStarted,
    batchOrdinal: o.batchOrdinal === null ? null : onn(o.batchOrdinal, 'contentPlan.batchOrdinal'),
    contentRevisionCommitCoreRef: rfn(o.contentRevisionCommitCoreRef, 'contentPlan.contentRevisionCommitCoreRef'),
    validatorAggregateRef: rfn(o.validatorAggregateRef, 'contentPlan.validatorAggregateRef'),
    contentRevisionManifestRef: rfn(o.contentRevisionManifestRef, 'contentPlan.contentRevisionManifestRef'),
    taskContentRevision: o.taskContentRevision === null ? null : onn(o.taskContentRevision, 'contentPlan.taskContentRevision'),
    manifestPhase,
    producerPlanSpecRef: rfn(o.producerPlanSpecRef, 'contentPlan.producerPlanSpecRef'),
    priorManifestRef: rfn(o.priorManifestRef, 'contentPlan.priorManifestRef'),
    successor: parseSuccessorWorkItemCarrier(o.successor),
    finalizerWarningRootRef: rfn(o.finalizerWarningRootRef, 'contentPlan.finalizerWarningRootRef'),
    reviewRound: parseContentReviewRoundPlanCarrier(o.reviewRound),
    reviewWorkItems,
    validationReceiptRef: rfn(o.validationReceiptRef, 'contentPlan.validationReceiptRef'),
    successorPlanRevision: o.successorPlanRevision === null ? null : onn(o.successorPlanRevision, 'contentPlan.successorPlanRevision'),
    successorPlanRef: rfn(o.successorPlanRef, 'contentPlan.successorPlanRef'),
    terminal: parseSystemCommandTerminalCarrier(o.terminal),
  };
}

function parseContentReviewRoundPlanCarrier(value: unknown): ContentReviewRoundPlanCarrierV2 | null {
  if (value === null) return null;
  const o = rec(value, 'reviewRound');
  ex(o, [
    'reviewRoundId', 'contentCycleOrdinal', 'mapRef', 'mapSemanticDigest',
    'contentRevisionManifestRef', 'reviewPolicyDigest', 'adoptionRootRef',
    'coverageSlotCount', 'coverageRelationCount', 'assignmentCount',
    'verificationFindingCount', 'consumedOverrideRef',
  ], 'reviewRound');
  const out: ContentReviewRoundPlanCarrierV2 = {
    reviewRoundId: str(o.reviewRoundId, 'reviewRound.reviewRoundId'),
    contentCycleOrdinal: onn(o.contentCycleOrdinal, 'reviewRound.contentCycleOrdinal'),
    mapRef: rfKind(o.mapRef, 'map_snapshot', 'reviewRound.mapRef'),
    mapSemanticDigest: hx(o.mapSemanticDigest, 'reviewRound.mapSemanticDigest'),
    contentRevisionManifestRef: rfKind(o.contentRevisionManifestRef, 'content_revision_manifest', 'reviewRound.contentRevisionManifestRef'),
    reviewPolicyDigest: hx(o.reviewPolicyDigest, 'reviewRound.reviewPolicyDigest'),
    adoptionRootRef: rfKind(o.adoptionRootRef, 'review_adoption_root', 'reviewRound.adoptionRootRef'),
    coverageSlotCount: onn(o.coverageSlotCount, 'reviewRound.coverageSlotCount'),
    coverageRelationCount: onn(o.coverageRelationCount, 'reviewRound.coverageRelationCount'),
    assignmentCount: onn(o.assignmentCount, 'reviewRound.assignmentCount'),
    verificationFindingCount: onn(o.verificationFindingCount, 'reviewRound.verificationFindingCount'),
    consumedOverrideRef: rfn(o.consumedOverrideRef, 'reviewRound.consumedOverrideRef'),
  };
  return out;
}

function parseContentReviewObservationCarrier(value: unknown, where: string): ContentReviewObservationCarrierV2 {
  const o = rec(value, where);
  ex(o, ['observationId', 'level', 'parentObservationId', 'observationRef', 'coveredTargetCount', 'childObservationRefs'], where);
  return {
    observationId: str(o.observationId, `${where}.observationId`),
    level: onn(o.level, `${where}.level`),
    parentObservationId: o.parentObservationId === null ? null : str(o.parentObservationId, `${where}.parentObservationId`),
    observationRef: rf(o.observationRef, `${where}.observationRef`),
    coveredTargetCount: onn(o.coveredTargetCount, `${where}.coveredTargetCount`),
    childObservationRefs: rfa(o.childObservationRefs, `${where}.childObservationRefs`),
  };
}

function parseContentReviewFindingOpeningCarrier(value: unknown, where: string): ContentReviewFindingOpeningCarrierV2 {
  const o = rec(value, where);
  ex(o, ['findingId', 'findingRef', 'reviewContext', 'primaryLocation', 'defectClass', 'severity', 'source', 'openedBy'], where);
  const ctx = rec(o.reviewContext, `${where}.reviewContext`);
  ex(ctx, ['kind', 'roundId'], `${where}.reviewContext`);
  if (ctx.kind !== 'map' && ctx.kind !== 'content') throw new SchemaError(`${where}.reviewContext.kind must be map|content`);
  const loc = rec(o.primaryLocation, `${where}.primaryLocation`);
  ex(loc, ['kind', 'id'], `${where}.primaryLocation`);
  const locKind = loc.kind;
  if (locKind !== 'slot' && locKind !== 'relation' && locKind !== 'map_node' && locKind !== 'map') throw new SchemaError(`${where}.primaryLocation.kind unknown`);
  const defectClass = str(o.defectClass, `${where}.defectClass`);
  if (defectClass !== 'content' && defectClass !== 'map' && defectClass !== 'mixed') throw new SchemaError(`${where}.defectClass unknown`);
  const severity = str(o.severity, `${where}.severity`);
  if (severity !== 'blocking' && severity !== 'advisory') throw new SchemaError(`${where}.severity unknown`);
  const source = str(o.source, `${where}.source`);
  if (source !== 'reviewer' && source !== 'system_validator') throw new SchemaError(`${where}.source unknown`);
  const opened = rec(o.openedBy, `${where}.openedBy`);
  const openedBy: ContentReviewFindingOpeningCarrierV2['openedBy'] =
    opened.kind === 'reviewer'
      ? { kind: 'reviewer', reviewerAttemptId: str(opened.reviewerAttemptId, `${where}.openedBy.reviewerAttemptId`) }
      : opened.kind === 'system_validator'
        ? { kind: 'system_validator', validatorExecutionId: str(opened.validatorExecutionId, `${where}.openedBy.validatorExecutionId`) }
        : (() => { throw new SchemaError(`${where}.openedBy.kind unknown`); })();
  return {
    findingId: str(o.findingId, `${where}.findingId`),
    findingRef: rf(o.findingRef, `${where}.findingRef`),
    reviewContext: { kind: ctx.kind as 'map' | 'content', roundId: str(ctx.roundId, `${where}.reviewContext.roundId`) },
    primaryLocation: { kind: locKind as 'slot' | 'relation' | 'map_node' | 'map', id: str(loc.id, `${where}.primaryLocation.id`) },
    defectClass: defectClass as ContentReviewFindingOpeningCarrierV2['defectClass'],
    severity: severity as ContentReviewFindingOpeningCarrierV2['severity'],
    source: source as ContentReviewFindingOpeningCarrierV2['source'],
    openedBy,
  };
}

function parseReviewerVerificationCarriers(value: unknown, where: string): readonly ReviewerFindingVerificationCarrierV2[] | null {
  if (value === null || value === undefined) return null;
  return (value as unknown[]).map((entry, index) => {
    const at = `${where}[${index}]`;
    const o = rec(entry, at);
    ex(o, ['recordId', 'recordRef', 'findingId', 'reviewContext', 'assignmentId', 'repairStage', 'verdict'], at);
    const context = rec(o.reviewContext, `${at}.reviewContext`);
    ex(context, ['kind', 'roundId'], `${at}.reviewContext`);
    const kind = str(context.kind, `${at}.reviewContext.kind`);
    if (kind !== 'map' && kind !== 'content') throw new SchemaError(`${at}.reviewContext.kind must be map|content`);
    const repairStage = str(o.repairStage, `${at}.repairStage`);
    if (repairStage !== 'map' && repairStage !== 'content') throw new SchemaError(`${at}.repairStage must be map|content`);
    const verdict = str(o.verdict, `${at}.verdict`);
    if (verdict !== 'resolved' && verdict !== 'still_present') throw new SchemaError(`${at}.verdict must be resolved|still_present`);
    return {
      recordId: str(o.recordId, `${at}.recordId`),
      recordRef: rfKind(o.recordRef, 'finding_verification_record', `${at}.recordRef`),
      findingId: str(o.findingId, `${at}.findingId`),
      reviewContext: { kind, roundId: str(context.roundId, `${at}.reviewContext.roundId`) },
      assignmentId: str(o.assignmentId, `${at}.assignmentId`),
      repairStage,
      verdict,
    };
  });
}

/**
 * Task 18 content-review carriers (deterministic rebuild; exact-key parser).
 * `roundPlanned` reuses the `content_review_round_planned` round-plan carrier
 * (the §13.3.1 cycle-boundary round creation); `reviewWorkItems` carries the
 * batch + whole content review successor carriers.
 */
function parseContentReviewPublishCarriers(value: unknown): ContentReviewPublishCarriersV2 | null {
  if (value === null || value === undefined) return null;
  const o = rec(value, 'contentReview');
  ex(o, [
    'assignmentId', 'reviewRoundId', 'workItemId', 'attemptId', 'reviewAssignmentId',
    'source', 'ledgerRef', 'coverageTargetCount', 'findingCount', 'observations', 'findingOpenings', 'verificationRecords',
    'coverageCoreRef', 'roundPlanned', 'reviewWorkItems',
    'settlementCoreRef', 'outcome', 'reviewBundleRef', 'reviewWarningCustodyRootRef',
    'mapRef', 'contentRevisionManifestRef', 'reviewSettlementValidatorAggregateRef',
    'sealWorkItemId', 'sealAuthorityBaseRef', 'verifiedClosedFindingIds', 'successor', 'terminal',
  ], 'contentReview');
  const source = o.source === null ? null : str(o.source, 'contentReview.source');
  if (source !== null && source !== 'batch' && source !== 'whole_tree_observation') {
    throw new SchemaError('contentReview.source must be batch|whole_tree_observation|null');
  }
  const outcome = o.outcome === null ? null : str(o.outcome, 'contentReview.outcome');
  if (outcome !== null && outcome !== 'content_repair' && outcome !== 'seal') {
    throw new SchemaError('contentReview.outcome must be content_repair|seal|null');
  }
  const observations = o.observations === null
    ? null
    : (o.observations as unknown[]).map((v, i) => parseContentReviewObservationCarrier(v, `contentReview.observations[${i}]`));
  const findingOpenings = o.findingOpenings === null
    ? null
    : (o.findingOpenings as unknown[]).map((v, i) => parseContentReviewFindingOpeningCarrier(v, `contentReview.findingOpenings[${i}]`));
  const reviewWorkItems = o.reviewWorkItems === null
    ? null
    : (o.reviewWorkItems as unknown[]).map((v, i) => parseSuccessorWorkItemCarrier(v)).filter((s): s is SuccessorWorkItemCarrierV2 => s !== null);
  return {
    assignmentId: o.assignmentId === null ? null : str(o.assignmentId, 'contentReview.assignmentId'),
    reviewRoundId: o.reviewRoundId === null ? null : str(o.reviewRoundId, 'contentReview.reviewRoundId'),
    workItemId: o.workItemId === null ? null : str(o.workItemId, 'contentReview.workItemId'),
    attemptId: o.attemptId === null ? null : str(o.attemptId, 'contentReview.attemptId'),
    reviewAssignmentId: o.reviewAssignmentId === null ? null : str(o.reviewAssignmentId, 'contentReview.reviewAssignmentId'),
    source,
    ledgerRef: rfn(o.ledgerRef, 'contentReview.ledgerRef'),
    coverageTargetCount: o.coverageTargetCount === null ? null : onn(o.coverageTargetCount, 'contentReview.coverageTargetCount'),
    findingCount: o.findingCount === null ? null : onn(o.findingCount, 'contentReview.findingCount'),
    observations,
    findingOpenings,
    verificationRecords: parseReviewerVerificationCarriers(o.verificationRecords, 'contentReview.verificationRecords'),
    coverageCoreRef: rfn(o.coverageCoreRef, 'contentReview.coverageCoreRef'),
    roundPlanned: parseContentReviewRoundPlanCarrier(o.roundPlanned),
    reviewWorkItems,
    settlementCoreRef: rfn(o.settlementCoreRef, 'contentReview.settlementCoreRef'),
    outcome,
    reviewBundleRef: rfn(o.reviewBundleRef, 'contentReview.reviewBundleRef'),
    reviewWarningCustodyRootRef: rfn(o.reviewWarningCustodyRootRef, 'contentReview.reviewWarningCustodyRootRef'),
    mapRef: rfn(o.mapRef, 'contentReview.mapRef'),
    contentRevisionManifestRef: rfn(o.contentRevisionManifestRef, 'contentReview.contentRevisionManifestRef'),
    reviewSettlementValidatorAggregateRef: rfn(o.reviewSettlementValidatorAggregateRef, 'contentReview.reviewSettlementValidatorAggregateRef'),
    sealWorkItemId: o.sealWorkItemId === null ? null : str(o.sealWorkItemId, 'contentReview.sealWorkItemId'),
    sealAuthorityBaseRef: rfn(o.sealAuthorityBaseRef, 'contentReview.sealAuthorityBaseRef'),
    verifiedClosedFindingIds: o.verifiedClosedFindingIds === null || o.verifiedClosedFindingIds === undefined ? null : sa(o.verifiedClosedFindingIds, 'contentReview.verifiedClosedFindingIds'),
    successor: parseSuccessorWorkItemCarrier(o.successor),
    terminal: parseSystemCommandTerminalCarrier(o.terminal),
  };
}

/** Task 19 `repair` domain-publish carriers (exact-key; null when unused). */
function parseRepairPublishCarriers(value: unknown): RepairPublishCarriersV2 | null {
  if (value === null || value === undefined) return null;
  const o = rec(value, 'repair');
  ex(o, [
    'track', 'repairPlanId', 'planRevisionId', 'repairPlanSpecRef', 'sourceValidationReceiptRef',
    'supersedesPlanRevisionId', 'successorPlanSpecRef', 'successorPlanRevisionId', 'successorReason', 'batchOrdinal', 'stagingRootRef', 'workItemId',
    'attemptId', 'validatorAggregateRef', 'validationReceiptRef', 'requestId', 'operatorId', 'reason', 'findingIds',
    'requestedNodeIds', 'requestedRelationIds', 'requestedSlotIds', 'grantSpecId', 'grantKind',
    'addressedFindingIds', 'contentRevisionManifestRef', 'taskContentRevision', 'manifestPhase',
    'priorManifestRef', 'repairBuildStart', 'repairBuildFinish', 'mapBuildManifestRef',
    'contributionManifestRef', 'candidateId', 'candidateDigest', 'candidateRef', 'baseMapId',
    'mapRound', 'contentRound', 'reviewWorkItems', 'overrideTransfer', 'supersededWorkItem', 'successor', 'terminal',
  ], 'repair');
  const track = o.track === null ? null : str(o.track, 'repair.track');
  if (track !== null && track !== 'map' && track !== 'content') {
    throw new SchemaError('repair.track must be map|content|null');
  }
  const successorReason = o.successorReason === null
    ? null
    : str(o.successorReason, 'repair.successorReason');
  if (successorReason !== null && successorReason !== 'scope_expansion' && successorReason !== 'validation_correction' && successorReason !== 'recovery') {
    throw new SchemaError('repair.successorReason must be scope_expansion|validation_correction|recovery|null');
  }
  const manifestPhase = o.manifestPhase === null ? null : str(o.manifestPhase, 'repair.manifestPhase');
  if (manifestPhase !== null && manifestPhase !== 'provisional' && manifestPhase !== 'finalized') {
    throw new SchemaError('repair.manifestPhase must be provisional|finalized|null');
  }
  const grantKind = o.grantKind === null ? null : str(o.grantKind, 'repair.grantKind');
  if (grantKind !== null && grantKind !== 'map_repair_batch' && grantKind !== 'content_repair_batch') {
    throw new SchemaError('repair.grantKind must be map_repair_batch|content_repair_batch|null');
  }
  const repairBuildStart = o.repairBuildStart === null ? null : parseRepairBuildStartCarrier(o.repairBuildStart);
  const repairBuildFinish = o.repairBuildFinish === null ? null : parseRepairBuildFinishCarrier(o.repairBuildFinish);
  const overrideTransfer = o.overrideTransfer === null ? null : parseOverrideTransferCarrier(o.overrideTransfer);
  const reviewWorkItems = o.reviewWorkItems === null
    ? null
    : (o.reviewWorkItems as unknown[]).map((v, i) => parseSuccessorWorkItemCarrier(v)).filter((s): s is SuccessorWorkItemCarrierV2 => s !== null);
  return {
    track,
    repairPlanId: o.repairPlanId === null ? null : str(o.repairPlanId, 'repair.repairPlanId'),
    planRevisionId: o.planRevisionId === null ? null : hx(o.planRevisionId, 'repair.planRevisionId'),
    repairPlanSpecRef: rfn(o.repairPlanSpecRef, 'repair.repairPlanSpecRef'),
    sourceValidationReceiptRef: rfn(o.sourceValidationReceiptRef, 'repair.sourceValidationReceiptRef'),
    supersedesPlanRevisionId: o.supersedesPlanRevisionId === null ? null : hx(o.supersedesPlanRevisionId, 'repair.supersedesPlanRevisionId'),
    successorPlanSpecRef: rfn(o.successorPlanSpecRef, 'repair.successorPlanSpecRef'),
    successorPlanRevisionId: o.successorPlanRevisionId === null ? null : hx(o.successorPlanRevisionId, 'repair.successorPlanRevisionId'),
    successorReason,
    batchOrdinal: o.batchOrdinal === null ? null : onn(o.batchOrdinal, 'repair.batchOrdinal'),
    stagingRootRef: rfn(o.stagingRootRef, 'repair.stagingRootRef'),
    workItemId: o.workItemId === null ? null : str(o.workItemId, 'repair.workItemId'),
    attemptId: o.attemptId === null ? null : str(o.attemptId, 'repair.attemptId'),
    validatorAggregateRef: rfn(o.validatorAggregateRef, 'repair.validatorAggregateRef'),
    validationReceiptRef: rfn(o.validationReceiptRef, 'repair.validationReceiptRef'),
    requestId: o.requestId === null ? null : str(o.requestId, 'repair.requestId'),
    operatorId: o.operatorId === null ? null : str(o.operatorId, 'repair.operatorId'),
    reason: o.reason === null ? null : str(o.reason, 'repair.reason'),
    findingIds: o.findingIds === null ? null : sa(o.findingIds, 'repair.findingIds'),
    requestedNodeIds: o.requestedNodeIds === null ? null : sa(o.requestedNodeIds, 'repair.requestedNodeIds'),
    requestedRelationIds: o.requestedRelationIds === null ? null : sa(o.requestedRelationIds, 'repair.requestedRelationIds'),
    requestedSlotIds: o.requestedSlotIds === null ? null : sa(o.requestedSlotIds, 'repair.requestedSlotIds'),
    grantSpecId: o.grantSpecId === null ? null : str(o.grantSpecId, 'repair.grantSpecId'),
    grantKind,
    addressedFindingIds: o.addressedFindingIds === null ? null : sa(o.addressedFindingIds, 'repair.addressedFindingIds'),
    contentRevisionManifestRef: rfn(o.contentRevisionManifestRef, 'repair.contentRevisionManifestRef'),
    taskContentRevision: o.taskContentRevision === null ? null : onn(o.taskContentRevision, 'repair.taskContentRevision'),
    manifestPhase,
    priorManifestRef: rfn(o.priorManifestRef, 'repair.priorManifestRef'),
    repairBuildStart,
    repairBuildFinish,
    mapBuildManifestRef: rfn(o.mapBuildManifestRef, 'repair.mapBuildManifestRef'),
    contributionManifestRef: rfn(o.contributionManifestRef, 'repair.contributionManifestRef'),
    candidateId: o.candidateId === null ? null : str(o.candidateId, 'repair.candidateId'),
    candidateDigest: o.candidateDigest === null ? null : hx(o.candidateDigest, 'repair.candidateDigest'),
    candidateRef: rfn(o.candidateRef, 'repair.candidateRef'),
    baseMapId: o.baseMapId === null ? null : str(o.baseMapId, 'repair.baseMapId'),
    mapRound: parseMapReviewRoundPlanCarrier(o.mapRound),
    contentRound: parseContentReviewRoundPlanCarrier(o.contentRound),
    reviewWorkItems,
    overrideTransfer,
    supersededWorkItem: o.supersededWorkItem === null ? null : parseSupersededWorkItemCarrier(o.supersededWorkItem),
    successor: parseSuccessorWorkItemCarrier(o.successor),
    terminal: parseSystemCommandTerminalCarrier(o.terminal),
  };
}

function parseSupersededWorkItemCarrier(value: unknown): NonNullable<RepairPublishCarriersV2['supersededWorkItem']> {
  const o = rec(value, 'supersededWorkItem');
  ex(o, ['workItemId', 'leaseEpoch', 'reason', 'authorityBaseRef', 'attemptAbandonment'], 'supersededWorkItem');
  const reason = str(o.reason, 'supersededWorkItem.reason');
  if (reason !== 'new_authority_base' && reason !== 'human_disposition') {
    throw new SchemaError('supersededWorkItem.reason must be new_authority_base|human_disposition');
  }
  const attemptAbandonment = o.attemptAbandonment === null ? null : parseAttemptAbandonmentCarrier(o.attemptAbandonment);
  return {
    workItemId: str(o.workItemId, 'supersededWorkItem.workItemId'),
    leaseEpoch: onn(o.leaseEpoch, 'supersededWorkItem.leaseEpoch'),
    reason: reason as 'new_authority_base' | 'human_disposition',
    authorityBaseRef: rfKind(o.authorityBaseRef, 'authority_base_set', 'supersededWorkItem.authorityBaseRef'),
    attemptAbandonment,
  };
}

/** R2-2 (re-review round 2): the mid-session cycle the approval envelope ends
 * atomically before the supersede (attempt-abandoned + lease-reclaimed). The
 * session-kind membership is enforced by the EVENT validator (the attempt-
 * abandoned event demands a registered StructuredSessionKindV2). */
function parseAttemptAbandonmentCarrier(value: unknown): NonNullable<NonNullable<RepairPublishCarriersV2['supersededWorkItem']>['attemptAbandonment']> {
  const o = rec(value, 'attemptAbandonment');
  ex(o, ['attemptId', 'logicalAssignmentId', 'reviewAssignmentId', 'sessionKind', 'leaseEpoch', 'authorityBaseRef'], 'attemptAbandonment');
  return {
    attemptId: str(o.attemptId, 'attemptAbandonment.attemptId'),
    logicalAssignmentId: str(o.logicalAssignmentId, 'attemptAbandonment.logicalAssignmentId'),
    reviewAssignmentId: o.reviewAssignmentId === null ? null : str(o.reviewAssignmentId, 'attemptAbandonment.reviewAssignmentId'),
    sessionKind: str(o.sessionKind, 'attemptAbandonment.sessionKind') as StructuredSessionKindV2,
    leaseEpoch: onn(o.leaseEpoch, 'attemptAbandonment.leaseEpoch'),
    authorityBaseRef: rfKind(o.authorityBaseRef, 'authority_base_set', 'attemptAbandonment.authorityBaseRef'),
  };
}

function parseRepairBuildStartCarrier(value: unknown): NonNullable<RepairPublishCarriersV2['repairBuildStart']> {
  const o = rec(value, 'repairBuildStart');
  ex(o, ['mapBuildId', 'revision', 'mapBuildSpecRef', 'supersedesMapBuildId', 'sourceValidationReceiptRef'], 'repairBuildStart');
  return {
    mapBuildId: str(o.mapBuildId, 'repairBuildStart.mapBuildId'),
    revision: onn(o.revision, 'repairBuildStart.revision'),
    mapBuildSpecRef: rfKind(o.mapBuildSpecRef, 'map_build_spec', 'repairBuildStart.mapBuildSpecRef'),
    supersedesMapBuildId: o.supersedesMapBuildId === null ? null : str(o.supersedesMapBuildId, 'repairBuildStart.supersedesMapBuildId'),
    sourceValidationReceiptRef: rfn(o.sourceValidationReceiptRef, 'repairBuildStart.sourceValidationReceiptRef'),
  };
}

function parseRepairBuildFinishCarrier(value: unknown): NonNullable<RepairPublishCarriersV2['repairBuildFinish']> {
  const o = rec(value, 'repairBuildFinish');
  ex(o, ['mapBuildId', 'expectedChunkCount', 'expectedFrontierDigest', 'expectedRootCount'], 'repairBuildFinish');
  return {
    mapBuildId: str(o.mapBuildId, 'repairBuildFinish.mapBuildId'),
    expectedChunkCount: onn(o.expectedChunkCount, 'repairBuildFinish.expectedChunkCount'),
    expectedFrontierDigest: hx(o.expectedFrontierDigest, 'repairBuildFinish.expectedFrontierDigest'),
    expectedRootCount: onn(o.expectedRootCount, 'repairBuildFinish.expectedRootCount'),
  };
}

function parseOverrideTransferCarrier(value: unknown): NonNullable<RepairPublishCarriersV2['overrideTransfer']> {
  const o = rec(value, 'overrideTransfer');
  ex(o, ['overrideRef', 'fromRepairPlanRef', 'toRepairPlanRef', 'transferOperationId'], 'overrideTransfer');
  return {
    overrideRef: rfKind(o.overrideRef, 'round_budget_override', 'overrideTransfer.overrideRef'),
    fromRepairPlanRef: rfKind(o.fromRepairPlanRef, 'repair_plan_spec', 'overrideTransfer.fromRepairPlanRef'),
    toRepairPlanRef: rfKind(o.toRepairPlanRef, 'repair_plan_spec', 'overrideTransfer.toRepairPlanRef'),
    transferOperationId: str(o.transferOperationId, 'overrideTransfer.transferOperationId'),
  };
}

function parseMapReviewObservationCarrier(value: unknown, where: string): MapReviewObservationCarrierV2 {
  const o = rec(value, where);
  ex(o, ['observationId', 'level', 'parentObservationId', 'observationRef', 'coveredTargetCount', 'childObservationRefs'], where);
  return {
    observationId: str(o.observationId, `${where}.observationId`),
    level: onn(o.level, `${where}.level`),
    parentObservationId: o.parentObservationId === null ? null : str(o.parentObservationId, `${where}.parentObservationId`),
    observationRef: rf(o.observationRef, `${where}.observationRef`),
    coveredTargetCount: onn(o.coveredTargetCount, `${where}.coveredTargetCount`),
    childObservationRefs: rfa(o.childObservationRefs, `${where}.childObservationRefs`),
  };
}

function parseMapReviewRoundPlanCarrier(value: unknown): MapReviewRoundPlanCarrierV2 | null {
  if (value === null) return null;
  const o = rec(value, 'round');
  ex(o, ['mapReviewRoundId', 'mapCycleOrdinal', 'candidateId', 'candidateRef', 'contentRevisionManifestRef', 'reviewPolicyDigest', 'coverageNodeCount', 'coverageRelationCount', 'assignmentCount', 'consumedOverrideRef'], 'round');
  const candidateRef = rfKind(o.candidateRef, 'map_candidate', 'round.candidateRef');
  const out: MapReviewRoundPlanCarrierV2 = {
    mapReviewRoundId: str(o.mapReviewRoundId, 'round.mapReviewRoundId'),
    mapCycleOrdinal: onn(o.mapCycleOrdinal, 'round.mapCycleOrdinal'),
    candidateId: str(o.candidateId, 'round.candidateId'),
    candidateRef,
    contentRevisionManifestRef: o.contentRevisionManifestRef === null ? null : rfKind(o.contentRevisionManifestRef, 'content_revision_manifest', 'round.contentRevisionManifestRef'),
    reviewPolicyDigest: hx(o.reviewPolicyDigest, 'round.reviewPolicyDigest'),
    coverageNodeCount: onn(o.coverageNodeCount, 'round.coverageNodeCount'),
    coverageRelationCount: onn(o.coverageRelationCount, 'round.coverageRelationCount'),
    assignmentCount: onn(o.assignmentCount, 'round.assignmentCount'),
    consumedOverrideRef: rfn(o.consumedOverrideRef, 'round.consumedOverrideRef'),
  };
  return out;
}

function parseSystemCommandTerminalCarrier(value: unknown): SystemCommandTerminalCarrierV2 | null {
  if (value === null) return null;
  const o = rec(value, 'terminal');
  ex(o, ['workItemId', 'commandId', 'commandKind', 'leaseEpoch', 'authorityBaseRef'], 'terminal');
  if (!(SYSTEM_COMMAND_KINDS as readonly string[]).includes(str(o.commandKind, 'terminal.commandKind'))) throw new SchemaError('terminal.commandKind unknown');
  const out: SystemCommandTerminalCarrierV2 = {
    workItemId: str(o.workItemId, 'terminal.workItemId'),
    commandId: str(o.commandId, 'terminal.commandId'),
    commandKind: str(o.commandKind, 'terminal.commandKind') as SystemCommandTerminalCarrierV2['commandKind'],
    leaseEpoch: onn(o.leaseEpoch, 'terminal.leaseEpoch'),
    authorityBaseRef: rfKind(o.authorityBaseRef, 'authority_base_set', 'terminal.authorityBaseRef'),
  };
  return out;
}

function parseSuccessorWorkItemCarrier(value: unknown): SuccessorWorkItemCarrierV2 | null {
  if (value === null) return null;
  const o = rec(value, 'successor');
  ex(o, ['workItemId', 'kind', 'roleBinding', 'agentExecutionKind', 'sessionKind', 'roundId', 'logicalAssignmentId', 'reviewAssignmentId', 'grantSpecRef', 'inputArtifactDeliveryId', 'authorityBaseRef', 'payloadRef', 'initialLeaseEpoch', 'maxAutomaticRetries'], 'successor');
  const agentExecutionKind = o.agentExecutionKind === null ? null : str(o.agentExecutionKind, 'successor.agentExecutionKind');
  if (agentExecutionKind !== null && agentExecutionKind !== 'structured_session' && agentExecutionKind !== 'generic_turn') {
    throw new SchemaError('successor.agentExecutionKind must be structured_session|generic_turn|null');
  }
  const sessionKind = o.sessionKind === null ? null : str(o.sessionKind, 'successor.sessionKind');
  const out: SuccessorWorkItemCarrierV2 = {
    workItemId: str(o.workItemId, 'successor.workItemId'),
    kind: str(o.kind, 'successor.kind') as SuccessorWorkItemCarrierV2['kind'],
    roleBinding: o.roleBinding === null ? null : str(o.roleBinding, 'successor.roleBinding'),
    agentExecutionKind,
    sessionKind: sessionKind as SuccessorWorkItemCarrierV2['sessionKind'],
    roundId: o.roundId === null ? null : str(o.roundId, 'successor.roundId'),
    logicalAssignmentId: o.logicalAssignmentId === null ? null : str(o.logicalAssignmentId, 'successor.logicalAssignmentId'),
    reviewAssignmentId: o.reviewAssignmentId === null ? null : str(o.reviewAssignmentId, 'successor.reviewAssignmentId'),
    grantSpecRef: rfn(o.grantSpecRef, 'successor.grantSpecRef'),
    inputArtifactDeliveryId: o.inputArtifactDeliveryId === null ? null : str(o.inputArtifactDeliveryId, 'successor.inputArtifactDeliveryId'),
    authorityBaseRef: rfKind(o.authorityBaseRef, 'authority_base_set', 'successor.authorityBaseRef'),
    payloadRef: rf(o.payloadRef, 'successor.payloadRef'),
    initialLeaseEpoch: onn(o.initialLeaseEpoch, 'successor.initialLeaseEpoch'),
    maxAutomaticRetries: onn(o.maxAutomaticRetries, 'successor.maxAutomaticRetries'),
  };
  return out;
}

/* ---- repair objects (§13) --------------------------------------- */
export function parseRepairKeyLedger(value: unknown): RepairKeyLedgerV2 {
  const o = rec(value, 'repair_key_ledger');
  ex(o, ['repairPlanId', 'planRevisionId', 'entries', 'ledgerDigest'], 'repair_key_ledger');
  const entries = (o.entries as unknown[]).map((v, i) => {
    const e = rec(v, `entries[${i}]`);
    ex(e, ['planKey', 'kind', 'officialId', 'status', 'predecessorPlanKey'], `entries[${i}]`);
    if (e.kind !== 'node' && e.kind !== 'relation') throw new SchemaError('kind must be node|relation');
    if (e.status !== 'active' && e.status !== 'tombstone') throw new SchemaError('status must be active|tombstone');
    return {
      planKey: str(e.planKey, 'planKey'),
      kind: e.kind as 'node' | 'relation',
      officialId: e.officialId === null ? null : str(e.officialId, 'officialId'),
      status: e.status as 'active' | 'tombstone',
      predecessorPlanKey: e.predecessorPlanKey === null ? null : str(e.predecessorPlanKey, 'predecessorPlanKey'),
    };
  });
  for (let i = 1; i < entries.length; i++) {
    if (entries[i - 1].planKey >= entries[i].planKey) throw new SchemaError('repair_key_ledger.entries must be sorted by planKey');
  }
  const out: RepairKeyLedgerV2 = {
    repairPlanId: str(o.repairPlanId, 'repairPlanId'),
    planRevisionId: hx(o.planRevisionId, 'planRevisionId'),
    entries,
    ledgerDigest: '',
  };
  hs(out, o.ledgerDigest, 'ledgerDigest', 'repair_key_ledger');
  return { ...out, ledgerDigest: hx(o.ledgerDigest, 'ledgerDigest') };
}

function parseRepairAuthorityBase(value: unknown, where: string): RepairPlanSpecV2['repairBase'] {
  const o = rec(value, where);
  const kind = str(o.kind, `${where}.kind`);
  if (kind === 'map_active') {
    ex(o, ['kind', 'mapRef'], where);
    return { kind, mapRef: rfKind(o.mapRef, 'map_snapshot', 'mapRef') } as RepairPlanSpecV2['repairBase'];
  }
  if (kind === 'map_candidate') {
    ex(o, ['kind', 'candidateRef'], where);
    return { kind, candidateRef: rfKind(o.candidateRef, 'map_candidate', 'candidateRef') } as RepairPlanSpecV2['repairBase'];
  }
  if (kind === 'content') {
    ex(o, ['kind', 'mapRef', 'contentRevisionManifestRef'], where);
    return {
      kind,
      mapRef: rfKind(o.mapRef, 'map_snapshot', 'mapRef'),
      contentRevisionManifestRef: rfKind(o.contentRevisionManifestRef, 'content_revision_manifest', 'contentRevisionManifestRef'),
    } as RepairPlanSpecV2['repairBase'];
  }
  throw new SchemaError(`${where}.kind must be map_active|map_candidate|content`);
}

function parseRepairBatchScope(value: unknown, where: string): RepairPlanSpecV2['orderedBatchScopes'][number] {
  const o = rec(value, where);
  const kind = str(o.kind, `${where}.kind`);
  if (kind === 'map') {
    ex(o, ['kind', 'batchOrdinal', 'findingIds', 'scope'], where);
    const scope = rec(o.scope, 'scope');
    ex(scope, ['nodeIds', 'relationIds', 'allowedPlanKeys', 'parentContainers', 'relationTypeIds', 'operations'], 'scope');
    const ops = sa(scope.operations, 'operations');
    const ALLOWED_OPS = ['add_node', 'remove_node', 'add_relation', 'remove_relation', 'update_attributes'];
    for (const op of ops) if (!(ALLOWED_OPS as readonly string[]).includes(op)) throw new SchemaError('scope.operations unknown op');
    return {
      kind,
      batchOrdinal: onn(o.batchOrdinal, 'batchOrdinal'),
      findingIds: sa(o.findingIds, 'findingIds'),
      scope: {
        nodeIds: sa(scope.nodeIds, 'nodeIds'),
        relationIds: sa(scope.relationIds, 'relationIds'),
        allowedPlanKeys: sa(scope.allowedPlanKeys, 'allowedPlanKeys'),
        parentContainers: sa(scope.parentContainers, 'parentContainers'),
        relationTypeIds: sa(scope.relationTypeIds, 'relationTypeIds'),
        operations: ops as RepairPlanSpecV2['orderedBatchScopes'][number]['kind'] extends never ? never : never,
      },
    } as RepairPlanSpecV2['orderedBatchScopes'][number];
  }
  if (kind === 'content') {
    ex(o, ['kind', 'batchOrdinal', 'findingIds', 'slotIds'], where);
    return {
      kind,
      batchOrdinal: onn(o.batchOrdinal, 'batchOrdinal'),
      findingIds: sa(o.findingIds, 'findingIds'),
      slotIds: sa(o.slotIds, 'slotIds'),
    } as RepairPlanSpecV2['orderedBatchScopes'][number];
  }
  throw new SchemaError(`${where}.kind must be map|content`);
}

export function parseRepairPlanSpec(value: unknown): RepairPlanSpecV2 {
  const o = rec(value, 'repair_plan_spec');
  ex(o, ['repairPlanId', 'revision', 'planRevisionId', 'origin', 'sourceReceiptRef', 'repairBase', 'orderedBatchScopes', 'keyLineageRef', 'importedStagingManifestRef', 'specDigest'], 'repair_plan_spec');
  const origin = rec(o.origin, 'origin');
  let parsedOrigin: RepairPlanSpecV2['origin'];
  if (origin.kind === 'initial') {
    ex(origin, ['kind', 'settlementId', 'settlementDigest', 'creationOperationKey'], 'origin');
    parsedOrigin = {
      kind: 'initial',
      settlementId: str(origin.settlementId, 'settlementId'),
      settlementDigest: hx(origin.settlementDigest, 'settlementDigest'),
      creationOperationKey: str(origin.creationOperationKey, 'creationOperationKey'),
    };
  } else if (origin.kind === 'successor') {
    ex(origin, ['kind', 'supersedesPlanSpecRef', 'successorReason', 'successorOperationKey'], 'origin');
    if (origin.successorReason !== 'scope_expansion' && origin.successorReason !== 'validation_correction' && origin.successorReason !== 'recovery') {
      throw new SchemaError('origin.successorReason unknown');
    }
    parsedOrigin = {
      kind: 'successor',
      supersedesPlanSpecRef: rfKind(origin.supersedesPlanSpecRef, 'repair_plan_spec', 'supersedesPlanSpecRef'),
      successorReason: origin.successorReason as 'scope_expansion' | 'validation_correction' | 'recovery',
      successorOperationKey: str(origin.successorOperationKey, 'successorOperationKey'),
    };
  } else {
    throw new SchemaError('origin.kind must be initial|successor');
  }
  const out: RepairPlanSpecV2 = {
    repairPlanId: str(o.repairPlanId, 'repairPlanId'),
    revision: onn(o.revision, 'revision'),
    planRevisionId: hx(o.planRevisionId, 'planRevisionId'),
    origin: parsedOrigin,
    sourceReceiptRef: rfn(o.sourceReceiptRef, 'sourceReceiptRef'),
    repairBase: parseRepairAuthorityBase(o.repairBase, 'repairBase'),
    orderedBatchScopes: (o.orderedBatchScopes as unknown[]).map((v, i) => parseRepairBatchScope(v, `orderedBatchScopes[${i}]`)),
    keyLineageRef: rfKind(o.keyLineageRef, 'repair_key_ledger', 'keyLineageRef'),
    importedStagingManifestRef: rf(o.importedStagingManifestRef, 'importedStagingManifestRef'),
    specDigest: hx(o.specDigest, 'specDigest'),
  };
  // Self-digest rule (design §13: "specDigest covers all BlobRefs and
  // origin"): specDigest must cover the canonical object minus THAT field and
  // minus planRevisionId (which is DERIVED from specDigest — including it
  // would be circular). Two different bodies can therefore never claim the
  // same specDigest. Verified before the planRevisionId binding below.
  const digestBody = { ...out } as Record<string, unknown>;
  delete digestBody.specDigest;
  delete digestBody.planRevisionId;
  if (canonicalJsonSha256(digestBody) !== out.specDigest) {
    throw new SchemaError('repair_plan_spec.specDigest does not match canonical bytes minus (specDigest, planRevisionId)');
  }
  // planRevisionId = hash(repairPlanId, revision, specDigest) — immutable
  // WorkItem/Grant identity that never references event-derived state.
  const computedPlanRevisionId = canonicalJsonSha256({
    repairPlanId: out.repairPlanId,
    revision: out.revision,
    specDigest: out.specDigest,
  });
  if (out.planRevisionId !== computedPlanRevisionId) {
    throw new SchemaError('repair_plan_spec.planRevisionId does not match hash(repairPlanId, revision, specDigest)');
  }
  return out;
}

export function parseRepairStagingRoot(value: unknown): RepairStagingRootV2 {
  const o = rec(value, 'repair_staging_root');
  const hasContentManifestRef = Object.prototype.hasOwnProperty.call(o, 'contentManifestRef');
  ex(
    o,
    hasContentManifestRef
      ? ['repairPlanId', 'planRevisionId', 'batchOrdinal', 'mapRootDigest', 'contentRootDigest', 'contentManifestRef', 'priorStagingRootRef', 'keyLedgerRef', 'stagingDigest']
      : ['repairPlanId', 'planRevisionId', 'batchOrdinal', 'mapRootDigest', 'contentRootDigest', 'priorStagingRootRef', 'keyLedgerRef', 'stagingDigest'],
    'repair_staging_root',
  );
  const common = {
    repairPlanId: str(o.repairPlanId, 'repairPlanId'),
    planRevisionId: hx(o.planRevisionId, 'planRevisionId'),
    batchOrdinal: onn(o.batchOrdinal, 'batchOrdinal'),
    mapRootDigest: o.mapRootDigest === null ? null : hx(o.mapRootDigest, 'mapRootDigest'),
    contentRootDigest: o.contentRootDigest === null ? null : hx(o.contentRootDigest, 'contentRootDigest'),
    priorStagingRootRef: rfn(o.priorStagingRootRef, 'priorStagingRootRef'),
    keyLedgerRef: rfKind(o.keyLedgerRef, 'repair_key_ledger', 'keyLedgerRef'),
  };

  if (!hasContentManifestRef) {
    // schemaVersion=1 roots written before cumulative content custody did not
    // carry contentManifestRef. Validate their historical byte shape first,
    // then expose a nullable read view. Never hash or persist that normalized
    // view at the historical content address.
    const historical = {
      ...common,
      stagingDigest: '',
    };
    hs(historical, o.stagingDigest, 'stagingDigest', 'repair_staging_root');
    return {
      ...historical,
      contentManifestRef: null,
      stagingDigest: hx(o.stagingDigest, 'stagingDigest'),
    };
  }

  const out: RepairStagingRootV2 = {
    ...common,
    contentManifestRef: o.contentManifestRef === null ? null : rfKind(o.contentManifestRef, 'content_revision_manifest', 'contentManifestRef'),
    stagingDigest: '',
  };
  hs(out, o.stagingDigest, 'stagingDigest', 'repair_staging_root');
  return { ...out, stagingDigest: hx(o.stagingDigest, 'stagingDigest') };
}

/* ---- review ledgers, bundle, fact (§11.4/§11.10/§19) ------------ */
export function parseReviewAdoptionLedger(value: unknown): ReviewAdoptionLedgerBlobV2 {
  const o = rec(value, 'review_adoption_ledger');
  ex(o, ['roundId', 'chunkIndex', 'adoptionRecords', 'blobDigest'], 'review_adoption_ledger');
  const records = (o.adoptionRecords as unknown[]).map((v, i) => parseReviewAdoptionRecord(v, `adoptionRecords[${i}]`)) as unknown as ReviewAdoptionLedgerBlobV2['adoptionRecords'];
  const out: ReviewAdoptionLedgerBlobV2 = {
    roundId: str(o.roundId, 'roundId'),
    chunkIndex: onn(o.chunkIndex, 'chunkIndex'),
    adoptionRecords: records,
    blobDigest: '',
  };
  hs(out, o.blobDigest, 'blobDigest', 'review_adoption_ledger');
  return { ...out, blobDigest: hx(o.blobDigest, 'blobDigest') };
}

function parseReviewAdoptionRecord(value: unknown, where: string): Record<string, unknown> {
  const o = rec(value, where);
  ex(o, ['adoptionId', 'roundKind', 'roundId', 'candidateId', 'mapId', 'factId', 'targetStableId', 'expectedLocalSubjectDigest', 'expectedLocalContextDigest', 'reviewPolicyDigest', 'adoptedBy'], where);
  if (o.roundKind !== 'map' && o.roundKind !== 'content') throw new SchemaError('roundKind must be map|content');
  if (o.adoptedBy !== 'system') throw new SchemaError('adoptedBy must be system');
  return {
    adoptionId: str(o.adoptionId, 'adoptionId'),
    roundKind: o.roundKind,
    roundId: str(o.roundId, 'roundId'),
    candidateId: o.candidateId === null ? null : str(o.candidateId, 'candidateId'),
    mapId: o.mapId === null ? null : str(o.mapId, 'mapId'),
    factId: str(o.factId, 'factId'),
    targetStableId: str(o.targetStableId, 'targetStableId'),
    expectedLocalSubjectDigest: hx(o.expectedLocalSubjectDigest, 'expectedLocalSubjectDigest'),
    expectedLocalContextDigest: hx(o.expectedLocalContextDigest, 'expectedLocalContextDigest'),
    reviewPolicyDigest: hx(o.reviewPolicyDigest, 'reviewPolicyDigest'),
    adoptedBy: 'system',
  };
}

export function parseReviewAdoptionRoot(value: unknown): ReviewAdoptionRootV2 {
  const o = rec(value, 'review_adoption_root');
  ex(o, ['roundId', 'orderedChunkRefs', 'adoptedTargetCount', 'coverageDigest', 'rootDigest'], 'review_adoption_root');
  const refs = rfaKind(o.orderedChunkRefs, 'review_adoption_ledger', 'orderedChunkRefs');
  assertRefsSortedByDigest(refs, 'orderedChunkRefs');
  const out: ReviewAdoptionRootV2 = {
    roundId: str(o.roundId, 'roundId'),
    orderedChunkRefs: refs,
    adoptedTargetCount: onn(o.adoptedTargetCount, 'adoptedTargetCount'),
    coverageDigest: hx(o.coverageDigest, 'coverageDigest'),
    rootDigest: '',
  };
  hs(out, o.rootDigest, 'rootDigest', 'review_adoption_root');
  return { ...out, rootDigest: hx(o.rootDigest, 'rootDigest') };
}

export function parseReviewAssignmentLedger(value: unknown): AssignmentLedgerBlobV2 {
  const o = rec(value, 'review_assignment_ledger');
  ex(o, ['assignmentId', 'workItemId', 'reviewAssignmentId', 'roundKind', 'roundId', 'factRefs', 'findingDraftRefs', 'verificationRecordRefs', 'coverageTargetIds', 'ledgerDigest'], 'review_assignment_ledger');
  if (o.roundKind !== 'map' && o.roundKind !== 'content') throw new SchemaError('roundKind must be map|content');
  const factRefs = rfaKind(o.factRefs, 'review_fact', 'factRefs');
  const draftRefs = rfaKind(o.findingDraftRefs, 'finding', 'findingDraftRefs');
  const verRefs = rfaKind(o.verificationRecordRefs, 'finding_verification_record', 'verificationRecordRefs');
  assertRefsSortedByDigest(factRefs, 'factRefs');
  assertRefsSortedByDigest(draftRefs, 'findingDraftRefs');
  assertRefsSortedByDigest(verRefs, 'verificationRecordRefs');
  const targets = sa(o.coverageTargetIds, 'coverageTargetIds');
  assertSortedStrings(targets, 'coverageTargetIds');
  const out: AssignmentLedgerBlobV2 = {
    assignmentId: str(o.assignmentId, 'assignmentId'),
    workItemId: str(o.workItemId, 'workItemId'),
    reviewAssignmentId: o.reviewAssignmentId === null ? null : str(o.reviewAssignmentId, 'reviewAssignmentId'),
    roundKind: o.roundKind as 'map' | 'content',
    roundId: str(o.roundId, 'roundId'),
    factRefs,
    findingDraftRefs: draftRefs,
    verificationRecordRefs: verRefs,
    coverageTargetIds: targets,
    ledgerDigest: '',
  };
  hs(out, o.ledgerDigest, 'ledgerDigest', 'review_assignment_ledger');
  return { ...out, ledgerDigest: hx(o.ledgerDigest, 'ledgerDigest') };
}

export function parseReviewBundle(value: unknown): ReviewBundleV2 {
  const o = rec(value, 'review_bundle');
  ex(o, ['settlementCoreRef', 'mapRef', 'contentRevisionManifestRef', 'reviewWarningCustodyRootRef', 'bundleDigest'], 'review_bundle');
  const out: ReviewBundleV2 = {
    settlementCoreRef: rfKind(o.settlementCoreRef, 'content_review_settlement_core', 'settlementCoreRef'),
    mapRef: rfKind(o.mapRef, 'map_snapshot', 'mapRef'),
    contentRevisionManifestRef: rfKind(o.contentRevisionManifestRef, 'content_revision_manifest', 'contentRevisionManifestRef'),
    reviewWarningCustodyRootRef: rfKind(o.reviewWarningCustodyRootRef, 'validation_warning_custody_root', 'reviewWarningCustodyRootRef'),
    bundleDigest: '',
  };
  hs(out, o.bundleDigest, 'bundleDigest', 'review_bundle');
  return { ...out, bundleDigest: hx(o.bundleDigest, 'bundleDigest') };
}

export function parseReviewFact(value: unknown): ReviewFactV2 {
  const o = rec(value, 'review_fact');
  ex(o, ['factId', 'targetKind', 'targetStableId', 'verdict', 'factOrigin', 'adoptionEligible', 'localSubjectDigest', 'localContextDigest', 'reviewPolicyDigest', 'findingIds', 'evidence', 'reviewerAttemptId', 'recordedAt'], 'review_fact');
  const targetKind = str(o.targetKind, 'targetKind');
  if (targetKind !== 'map_node' && targetKind !== 'map_relation' && targetKind !== 'content_slot' && targetKind !== 'content_relation') {
    throw new SchemaError('targetKind unknown');
  }
  const verdict = str(o.verdict, 'verdict');
  if (targetKind === 'content_relation') {
    if (verdict !== 'satisfied' && verdict !== 'violated') throw new SchemaError('content_relation verdict must be satisfied|violated');
  } else if (verdict !== 'pass' && verdict !== 'reject') {
    throw new SchemaError('map_node/map_relation/content_slot verdict must be pass|reject');
  }
  const origin = rec(o.factOrigin, 'factOrigin');
  let factOrigin: ReviewFactOriginV2;
  if (origin.kind === 'batch') {
    ex(origin, ['kind', 'adoptionEligible'], 'factOrigin');
    if (origin.adoptionEligible !== true) throw new SchemaError('batch factOrigin.adoptionEligible must be true');
    factOrigin = { kind: 'batch', adoptionEligible: true };
  } else if (origin.kind === 'whole_observation') {
    ex(origin, ['kind', 'adoptionEligible'], 'factOrigin');
    if (origin.adoptionEligible !== false) throw new SchemaError('whole_observation factOrigin.adoptionEligible must be false');
    factOrigin = { kind: 'whole_observation', adoptionEligible: false };
  } else {
    throw new SchemaError('factOrigin.kind must be batch|whole_observation');
  }
  const adoptionEligible = o.adoptionEligible === true || o.adoptionEligible === false ? o.adoptionEligible : (() => { throw new SchemaError('adoptionEligible must be a boolean'); })();
  if (adoptionEligible !== factOrigin.adoptionEligible) {
    throw new SchemaError('review_fact.adoptionEligible must match factOrigin (batch true, whole_observation false)');
  }
  return {
    factId: str(o.factId, 'factId'),
    targetKind: targetKind as ReviewFactV2['targetKind'],
    targetStableId: str(o.targetStableId, 'targetStableId'),
    verdict,
    factOrigin,
    adoptionEligible,
    localSubjectDigest: hx(o.localSubjectDigest, 'localSubjectDigest'),
    localContextDigest: hx(o.localContextDigest, 'localContextDigest'),
    reviewPolicyDigest: hx(o.reviewPolicyDigest, 'reviewPolicyDigest'),
    findingIds: sa(o.findingIds, 'findingIds'),
    evidence: parseEvidenceList(o.evidence, 'evidence'),
    reviewerAttemptId: str(o.reviewerAttemptId, 'reviewerAttemptId'),
    recordedAt: str(o.recordedAt, 'recordedAt'),
  };
}

/* ---- round_budget_override (§10.3.1) ----------------------------- */
export function parseRoundBudgetOverride(value: unknown): Record<string, unknown> {
  const o = rec(value, 'round_budget_override');
  ex(o, ['overrideId', 'failedEventId', 'track', 'repairLineageId', 'initialRepairPlanRef', 'currentAuthorizedRepairPlanRef', 'predecessorOverrideRef', 'transferOrdinal', 'operationId', 'operatorId', 'reasonDigest', 'state'], 'round_budget_override');
  if (o.track !== 'map' && o.track !== 'content') throw new SchemaError('track must be map|content');
  if (o.state !== 'available') throw new SchemaError('round_budget_override.state must be exactly available');
  return {
    overrideId: str(o.overrideId, 'overrideId'),
    failedEventId: str(o.failedEventId, 'failedEventId'),
    track: o.track,
    repairLineageId: str(o.repairLineageId, 'repairLineageId'),
    initialRepairPlanRef: rfKind(o.initialRepairPlanRef, 'repair_plan_spec', 'initialRepairPlanRef'),
    currentAuthorizedRepairPlanRef: rfKind(o.currentAuthorizedRepairPlanRef, 'repair_plan_spec', 'currentAuthorizedRepairPlanRef'),
    predecessorOverrideRef: rfn(o.predecessorOverrideRef, 'predecessorOverrideRef'),
    transferOrdinal: onn(o.transferOrdinal, 'transferOrdinal'),
    operationId: str(o.operationId, 'operationId'),
    operatorId: str(o.operatorId, 'operatorId'),
    reasonDigest: hx(o.reasonDigest, 'reasonDigest'),
    state: 'available',
  };
}

/* ---- seal record / validation bundle / delivery (§16.3) --------- */
export function parseSealRecord(value: unknown): Record<string, unknown> {
  const o = rec(value, 'seal_record');
  ex(o, ['taskId', 'mapRef', 'mapSemanticDigest', 'mapReviewBundleRef', 'contentRevisionManifestRef', 'contentRootDigest', 'reviewBundleRef', 'sealValidationBundleRef', 'templateSnapshotHash', 'assemblerDigest', 'artifactRef', 'artifactDigest'], 'seal_record');
  const artifactRef = rfKind(o.artifactRef, 'artifact', 'artifactRef');
  const artifactDigest = hx(o.artifactDigest, 'artifactDigest');
  if (artifactDigest !== artifactRef.digest) throw new SchemaError('seal_record.artifactDigest is a display alias and must equal artifactRef.digest');
  return {
    taskId: str(o.taskId, 'taskId'),
    mapRef: rfKind(o.mapRef, 'map_snapshot', 'mapRef'),
    mapSemanticDigest: hx(o.mapSemanticDigest, 'mapSemanticDigest'),
    mapReviewBundleRef: rfKind(o.mapReviewBundleRef, 'map_review_bundle', 'mapReviewBundleRef'),
    contentRevisionManifestRef: rfKind(o.contentRevisionManifestRef, 'content_revision_manifest', 'contentRevisionManifestRef'),
    contentRootDigest: hx(o.contentRootDigest, 'contentRootDigest'),
    reviewBundleRef: rfKind(o.reviewBundleRef, 'review_bundle', 'reviewBundleRef'),
    sealValidationBundleRef: rfKind(o.sealValidationBundleRef, 'seal_validation_bundle', 'sealValidationBundleRef'),
    templateSnapshotHash: str(o.templateSnapshotHash, 'templateSnapshotHash'),
    assemblerDigest: str(o.assemblerDigest, 'assemblerDigest'),
    artifactRef,
    artifactDigest,
  };
}

export function parseSealValidationBundle(value: unknown): SealValidationBundleV2 {
  const o = rec(value, 'seal_validation_bundle');
  ex(o, ['sealWorkItemId', 'reviewBundleRef', 'contentRevisionManifestRef', 'sealInputAggregateRef', 'sealOutputAggregateRef', 'sealWarningCustodyRootRef', 'assemblerDigest', 'artifactRef', 'artifactDigest', 'bundleDigest'], 'seal_validation_bundle');
  const artifactRef = rfKind(o.artifactRef, 'artifact', 'artifactRef');
  if (hx(o.artifactDigest, 'artifactDigest') !== artifactRef.digest) throw new SchemaError('seal_validation_bundle.artifactDigest must equal artifactRef.digest');
  const out: SealValidationBundleV2 = {
    sealWorkItemId: str(o.sealWorkItemId, 'sealWorkItemId'),
    reviewBundleRef: rfKind(o.reviewBundleRef, 'review_bundle', 'reviewBundleRef'),
    contentRevisionManifestRef: rfKind(o.contentRevisionManifestRef, 'content_revision_manifest', 'contentRevisionManifestRef'),
    sealInputAggregateRef: rfKind(o.sealInputAggregateRef, 'validator_aggregate', 'sealInputAggregateRef'),
    sealOutputAggregateRef: rfKind(o.sealOutputAggregateRef, 'validator_aggregate', 'sealOutputAggregateRef'),
    sealWarningCustodyRootRef: rfKind(o.sealWarningCustodyRootRef, 'validation_warning_custody_root', 'sealWarningCustodyRootRef'),
    assemblerDigest: str(o.assemblerDigest, 'assemblerDigest'),
    artifactRef,
    artifactDigest: artifactRef.digest,
    bundleDigest: '',
  };
  hs(out, o.bundleDigest, 'bundleDigest', 'seal_validation_bundle');
  return { ...out, bundleDigest: hx(o.bundleDigest, 'bundleDigest') };
}

export function parseSystemArtifactDelivery(value: unknown): Record<string, unknown> {
  const o = rec(value, 'system_artifact_delivery');
  ex(o, ['deliveryId', 'producer', 'sealRecordRef', 'sealRecordDigest', 'artifactId', 'artifactRef', 'artifactDigest', 'custodyRef', 'custodyDigest', 'submitterWorkItemId', 'submitterAgentId', 'templateSnapshotHash'], 'system_artifact_delivery');
  if (o.producer !== 'system:structured_seal') throw new SchemaError('producer must be system:structured_seal');
  const sealRef = rfKind(o.sealRecordRef, 'seal_record', 'sealRecordRef');
  const artifactRef = rfKind(o.artifactRef, 'artifact', 'artifactRef');
  const custodyRef = rf(o.custodyRef, 'custodyRef');
  if (hx(o.sealRecordDigest, 'sealRecordDigest') !== sealRef.digest) throw new SchemaError('sealRecordDigest must equal sealRecordRef.digest');
  if (hx(o.artifactDigest, 'artifactDigest') !== artifactRef.digest) throw new SchemaError('artifactDigest must equal artifactRef.digest');
  if (hx(o.custodyDigest, 'custodyDigest') !== custodyRef.digest) throw new SchemaError('custodyDigest must equal custodyRef.digest');
  return {
    deliveryId: str(o.deliveryId, 'deliveryId'),
    producer: 'system:structured_seal',
    sealRecordRef: sealRef,
    sealRecordDigest: sealRef.digest,
    artifactId: str(o.artifactId, 'artifactId'),
    artifactRef,
    artifactDigest: artifactRef.digest,
    custodyRef,
    custodyDigest: custodyRef.digest,
    submitterWorkItemId: str(o.submitterWorkItemId, 'submitterWorkItemId'),
    submitterAgentId: str(o.submitterAgentId, 'submitterAgentId'),
    templateSnapshotHash: str(o.templateSnapshotHash, 'templateSnapshotHash'),
  };
}

/* ---- validator objects (§9) ------------------------------------- */
const TRIGGER_ENUM = ['map_candidate_commit', 'map_review_settlement', 'map_activation', 'content_commit', 'repair_finalize', 'review_settlement', 'seal_input', 'seal_output'] as const;
const EXEC_PHASE = ['batch_commit', 'plan_finalize'] as const;

export function parseValidatorInputEnvelope(value: unknown): ValidatorInputEnvelopeV2 {
  const o = rec(value, 'validator_input_envelope');
  const trigger = str(o.trigger, 'trigger');
  const sel = rfa(o.selectedTargetRefs, 'selectedTargetRefs');
  if (trigger === 'map_candidate_commit') {
    ex(o, ['trigger', 'taskId', 'templateSnapshotHash', 'mapCandidateValidationCoreRef', 'selectedTargetRefs'], 'validator_input_envelope');
    return { trigger, taskId: str(o.taskId, 'taskId'), templateSnapshotHash: str(o.templateSnapshotHash, 'templateSnapshotHash'), mapCandidateValidationCoreRef: rfKind(o.mapCandidateValidationCoreRef, 'map_candidate_validation_core', 'mapCandidateValidationCoreRef'), selectedTargetRefs: sel };
  }
  if (trigger === 'map_review_settlement') {
    ex(o, ['trigger', 'taskId', 'templateSnapshotHash', 'mapReviewCoverageCoreRef', 'selectedTargetRefs'], 'validator_input_envelope');
    return { trigger, taskId: str(o.taskId, 'taskId'), templateSnapshotHash: str(o.templateSnapshotHash, 'templateSnapshotHash'), mapReviewCoverageCoreRef: rfKind(o.mapReviewCoverageCoreRef, 'map_review_coverage_core', 'mapReviewCoverageCoreRef'), selectedTargetRefs: sel };
  }
  if (trigger === 'map_activation') {
    ex(o, ['trigger', 'taskId', 'templateSnapshotHash', 'mapReviewSettlementCoreRef', 'proposedMapCoreRef', 'selectedTargetRefs'], 'validator_input_envelope');
    return { trigger, taskId: str(o.taskId, 'taskId'), templateSnapshotHash: str(o.templateSnapshotHash, 'templateSnapshotHash'), mapReviewSettlementCoreRef: rfKind(o.mapReviewSettlementCoreRef, 'map_review_settlement_core', 'mapReviewSettlementCoreRef'), proposedMapCoreRef: rfKind(o.proposedMapCoreRef, 'proposed_map_core', 'proposedMapCoreRef'), selectedTargetRefs: sel };
  }
  if (trigger === 'content_commit') {
    ex(o, ['trigger', 'executionPhase', 'taskId', 'templateSnapshotHash', 'contentValidationCoreRef', 'selectedTargetRefs'], 'validator_input_envelope');
    const phase = str(o.executionPhase, 'executionPhase');
    if (phase !== 'batch_commit' && phase !== 'plan_finalize') throw new SchemaError('content_commit executionPhase must be batch_commit|plan_finalize');
    return { trigger, executionPhase: phase as 'batch_commit' | 'plan_finalize', taskId: str(o.taskId, 'taskId'), templateSnapshotHash: str(o.templateSnapshotHash, 'templateSnapshotHash'), contentValidationCoreRef: rf(o.contentValidationCoreRef, 'contentValidationCoreRef'), selectedTargetRefs: sel };
  }
  if (trigger === 'review_settlement') {
    ex(o, ['trigger', 'taskId', 'templateSnapshotHash', 'contentReviewCoverageCoreRef', 'selectedTargetRefs'], 'validator_input_envelope');
    return { trigger, taskId: str(o.taskId, 'taskId'), templateSnapshotHash: str(o.templateSnapshotHash, 'templateSnapshotHash'), contentReviewCoverageCoreRef: rfKind(o.contentReviewCoverageCoreRef, 'content_review_coverage_core', 'contentReviewCoverageCoreRef'), selectedTargetRefs: sel };
  }
  if (trigger === 'repair_finalize') {
    ex(o, ['trigger', 'taskId', 'templateSnapshotHash', 'repairPlanSpecRef', 'stagingRootRef', 'keyLedgerRef', 'stagedArtifactRef', 'selectedTargetRefs'], 'validator_input_envelope');
    const stagedArtifactRef = rf(o.stagedArtifactRef, 'stagedArtifactRef');
    if (stagedArtifactRef.kind !== 'map_candidate_validation_core' && stagedArtifactRef.kind !== 'content_revision_manifest') {
      throw new SchemaError('repair_finalize stagedArtifactRef must be map_candidate_validation_core|content_revision_manifest');
    }
    return {
      trigger,
      taskId: str(o.taskId, 'taskId'),
      templateSnapshotHash: str(o.templateSnapshotHash, 'templateSnapshotHash'),
      repairPlanSpecRef: rfKind(o.repairPlanSpecRef, 'repair_plan_spec', 'repairPlanSpecRef'),
      stagingRootRef: rfKind(o.stagingRootRef, 'repair_staging_root', 'stagingRootRef'),
      keyLedgerRef: rfKind(o.keyLedgerRef, 'repair_key_ledger', 'keyLedgerRef'),
      stagedArtifactRef,
      selectedTargetRefs: sel,
    };
  }
  if (trigger === 'seal_input') {
    ex(o, ['trigger', 'taskId', 'templateSnapshotHash', 'reviewBundleRef', 'selectedTargetRefs'], 'validator_input_envelope');
    return { trigger, taskId: str(o.taskId, 'taskId'), templateSnapshotHash: str(o.templateSnapshotHash, 'templateSnapshotHash'), reviewBundleRef: rfKind(o.reviewBundleRef, 'review_bundle', 'reviewBundleRef'), selectedTargetRefs: sel };
  }
  if (trigger === 'seal_output') {
    ex(o, ['trigger', 'taskId', 'templateSnapshotHash', 'reviewBundleRef', 'artifactRef', 'selectedTargetRefs'], 'validator_input_envelope');
    return { trigger, taskId: str(o.taskId, 'taskId'), templateSnapshotHash: str(o.templateSnapshotHash, 'templateSnapshotHash'), reviewBundleRef: rfKind(o.reviewBundleRef, 'review_bundle', 'reviewBundleRef'), artifactRef: rfKind(o.artifactRef, 'artifact', 'artifactRef'), selectedTargetRefs: sel };
  }
  throw new SchemaError('validator_input_envelope.trigger unknown');
}

function parseValidatorIssues(value: unknown, where: string): ValidationReceiptV2['blockerIssues'] {
  return (value as unknown[]).map((v, i) => {
    const o = rec(v, `${where}[${i}]`);
    ex(o, ['validatorId', 'implementationDigest', 'issueCode', 'location', 'repairTargets', 'evidenceDigest'], `${where}[${i}]`);
    const loc = rec(o.location, 'location');
    ex(loc, ['targetKind', 'stableTargetId', 'jsonPointer'], 'location');
    const tgt = rec(o.repairTargets, 'repairTargets');
    ex(tgt, ['mapNodeIds', 'relationIds', 'slotIds'], 'repairTargets');
    return {
      validatorId: str(o.validatorId, 'validatorId'),
      implementationDigest: hx(o.implementationDigest, 'implementationDigest'),
      issueCode: str(o.issueCode, 'issueCode'),
      location: {
        targetKind: str(loc.targetKind, 'targetKind'),
        stableTargetId: str(loc.stableTargetId, 'stableTargetId'),
        jsonPointer: loc.jsonPointer === null ? null : str(loc.jsonPointer, 'jsonPointer'),
      },
      repairTargets: {
        mapNodeIds: sa(tgt.mapNodeIds, 'mapNodeIds'),
        relationIds: sa(tgt.relationIds, 'relationIds'),
        slotIds: sa(tgt.slotIds, 'slotIds'),
      },
      evidenceDigest: hx(o.evidenceDigest, 'evidenceDigest'),
    };
  });
}

export function parseValidationReceipt(value: unknown): ValidationReceiptV2 {
  const o = rec(value, 'validation_receipt');
  ex(o, ['receiptKind', 'validatorAggregateRef', 'blockerIssues', 'lineageRefs', 'receiptDigest'], 'validation_receipt');
  const kind = str(o.receiptKind, 'receiptKind');
  const RECEIPT_KINDS = ['map_build', 'generation', 'map_repair', 'content_repair', 'map_activation', 'map_review_settlement', 'review_settlement', 'repair_finalize', 'seal_input', 'seal_output'];
  if (!(RECEIPT_KINDS as readonly string[]).includes(kind)) throw new SchemaError('receiptKind unknown');
  const lineage = (o.lineageRefs as unknown[]).map((v, i) => {
    const e = rec(v, `lineageRefs[${i}]`);
    ex(e, ['label', 'ref'], `lineageRefs[${i}]`);
    return { label: str(e.label, 'label'), ref: rf(e.ref, 'ref') };
  });
  const labels = lineage.map((l) => l.label);
  for (let i = 1; i < labels.length; i++) {
    if (labels[i - 1] >= labels[i]) throw new SchemaError('validation_receipt.lineageRefs must be sorted by label');
  }
  const out: ValidationReceiptV2 = {
    receiptKind: kind as ValidationReceiptV2['receiptKind'],
    validatorAggregateRef: rfKind(o.validatorAggregateRef, 'validator_aggregate', 'validatorAggregateRef'),
    blockerIssues: parseValidatorIssues(o.blockerIssues, 'blockerIssues'),
    lineageRefs: lineage,
    receiptDigest: '',
  };
  hs(out, o.receiptDigest, 'receiptDigest', 'validation_receipt');
  return { ...out, receiptDigest: hx(o.receiptDigest, 'receiptDigest') };
}

export function parseValidationWarningRoot(value: unknown): ValidationWarningRootV2 {
  const o = rec(value, 'validation_warning_root');
  ex(o, ['trigger', 'executionPhase', 'inputRef', 'inputDigest', 'orderedAdvisoryReceiptRefs', 'warningCount', 'rootDigest'], 'validation_warning_root');
  if (!(TRIGGER_ENUM as readonly string[]).includes(str(o.trigger, 'trigger'))) throw new SchemaError('trigger unknown');
  const phase = o.executionPhase;
  if (phase !== null && phase !== 'batch_commit' && phase !== 'plan_finalize') throw new SchemaError('executionPhase must be null|batch_commit|plan_finalize');
  const refs = rfaKind(o.orderedAdvisoryReceiptRefs, 'validation_receipt', 'orderedAdvisoryReceiptRefs');
  assertRefsSortedByDigest(refs, 'orderedAdvisoryReceiptRefs');
  if (onn(o.warningCount, 'warningCount') !== refs.length) throw new SchemaError('validation_warning_root.warningCount must equal the receipt count');
  const inputRef = rfKind(o.inputRef, 'validator_input_envelope', 'inputRef');
  if (hx(o.inputDigest, 'inputDigest') !== inputRef.digest) throw new SchemaError('inputDigest must equal inputRef.digest');
  const out: ValidationWarningRootV2 = {
    trigger: o.trigger as ValidationWarningRootV2['trigger'],
    executionPhase: phase as ValidationWarningRootV2['executionPhase'],
    inputRef,
    inputDigest: inputRef.digest,
    orderedAdvisoryReceiptRefs: refs,
    warningCount: refs.length,
    rootDigest: '',
  };
  hs(out, o.rootDigest, 'rootDigest', 'validation_warning_root');
  return { ...out, rootDigest: hx(o.rootDigest, 'rootDigest') };
}

export function parseValidationWarningCustodyRoot(value: unknown): ValidationWarningCustodyRootV2 {
  const o = rec(value, 'validation_warning_custody_root');
  ex(o, ['scope', 'taskId', 'baseRefs', 'entries', 'supersessionPolicyVersion', 'rootDigest'], 'validation_warning_custody_root');
  const scope = str(o.scope, 'scope');
  if (scope !== 'map_candidate' && scope !== 'map_review' && scope !== 'content_review' && scope !== 'seal') throw new SchemaError('scope unknown');
  const baseRefs = rfa(o.baseRefs, 'baseRefs');
  assertRefsSortedByDigest(baseRefs, 'baseRefs');
  const entries = (o.entries as unknown[]).map((v, i) => {
    const e = rec(v, `entries[${i}]`);
    ex(e, ['trigger', 'inputRef', 'inputDigest', 'executionScope', 'validatorAggregateRef', 'warningRootRef'], `entries[${i}]`);
    if (!(TRIGGER_ENUM as readonly string[]).includes(str(e.trigger, 'trigger'))) throw new SchemaError('entry trigger unknown');
    const es = rec(e.executionScope, 'executionScope');
    const esOut: Record<string, unknown> = {};
    for (const k of Object.keys(es)) {
      if (k === 'planRevisionId' || k === 'roundId' || k === 'sealWorkItemId') esOut[k] = str(es[k], k);
      else if (k === 'batchOrdinal') esOut[k] = onn(es[k], k);
      else throw new SchemaError(`executionScope unknown field '${k}'`);
    }
    const inputRef = rfKind(e.inputRef, 'validator_input_envelope', 'inputRef');
    if (hx(e.inputDigest, 'inputDigest') !== inputRef.digest) throw new SchemaError('entry inputDigest must equal inputRef.digest');
    return {
      trigger: e.trigger as string,
      inputRef,
      inputDigest: inputRef.digest,
      executionScope: esOut,
      validatorAggregateRef: rfKind(e.validatorAggregateRef, 'validator_aggregate', 'validatorAggregateRef'),
      warningRootRef: rfKind(e.warningRootRef, 'validation_warning_root', 'warningRootRef'),
    };
  });
  // canonical order: frozen trigger order, then execution phase/ordinal, then inputDigest.
  const keyOf = (e: (typeof entries)[number]): string => {
    const t = String(TRIGGER_ENUM.indexOf(e.trigger as never)).padStart(2, '0');
    const es = e.executionScope as Record<string, unknown>;
    const extra = typeof es.planRevisionId === 'string' ? es.planRevisionId : '';
    const ord = typeof es.batchOrdinal === 'number' ? String(es.batchOrdinal).padStart(10, '0') : '';
    return `${t}:${extra}:${ord}:${e.inputDigest}`;
  };
  for (let i = 1; i < entries.length; i++) {
    if (keyOf(entries[i - 1]) >= keyOf(entries[i])) throw new SchemaError('validation_warning_custody_root.entries not in canonical order');
  }
  const out: ValidationWarningCustodyRootV2 = {
    scope: scope as ValidationWarningCustodyRootV2['scope'],
    taskId: str(o.taskId, 'taskId'),
    baseRefs,
    entries: entries as ValidationWarningCustodyRootV2['entries'],
    supersessionPolicyVersion: str(o.supersessionPolicyVersion, 'supersessionPolicyVersion'),
    rootDigest: '',
  };
  hs(out, o.rootDigest, 'rootDigest', 'validation_warning_custody_root');
  return { ...out, rootDigest: hx(o.rootDigest, 'rootDigest') };
}

export function parseValidatorAggregate(value: unknown): ValidatorAggregateV2 {
  const o = rec(value, 'validator_aggregate');
  ex(o, ['trigger', 'executionPhase', 'inputRef', 'inputDigest', 'registrationSetDigest', 'validExecutionDigests', 'blockingInvalidReceiptRefs', 'advisoryReceiptRefs', 'infrastructureFailureRefs', 'warningRootRef', 'aggregateDigest', 'outcome'], 'validator_aggregate');
  if (!(TRIGGER_ENUM as readonly string[]).includes(str(o.trigger, 'trigger'))) throw new SchemaError('trigger unknown');
  const phase = o.executionPhase;
  if (phase !== null && phase !== 'batch_commit' && phase !== 'plan_finalize') throw new SchemaError('executionPhase must be null|batch_commit|plan_finalize');
  if (phase !== null && o.trigger !== 'content_commit') throw new SchemaError('executionPhase is only legal for content_commit');
  const inputRef = rfKind(o.inputRef, 'validator_input_envelope', 'inputRef');
  if (hx(o.inputDigest, 'inputDigest') !== inputRef.digest) throw new SchemaError('inputDigest must equal inputRef.digest');
  const blocking = rfaKind(o.blockingInvalidReceiptRefs, 'validation_receipt', 'blockingInvalidReceiptRefs');
  const advisory = rfaKind(o.advisoryReceiptRefs, 'validation_receipt', 'advisoryReceiptRefs');
  const infra = rfaKind(o.infrastructureFailureRefs, 'validator_failure', 'infrastructureFailureRefs');
  assertRefsSortedByDigest(blocking, 'blockingInvalidReceiptRefs');
  assertRefsSortedByDigest(advisory, 'advisoryReceiptRefs');
  assertRefsSortedByDigest(infra, 'infrastructureFailureRefs');
  const validDigests = sa(o.validExecutionDigests, 'validExecutionDigests');
  assertSortedStrings(validDigests, 'validExecutionDigests');
  // Spec §12 outcome priority: infrastructure_failure > blocking_invalid > clear.
  // Infra and blocking-invalid MAY co-occur on one aggregate (a sibling
  // registration failing while another finds a domain violation) — the outcome
  // is still derived by priority, never rejected.
  const derived: ValidatorAggregateV2['outcome'] = infra.length > 0 ? 'infrastructure_failure' : blocking.length > 0 ? 'blocking_invalid' : 'clear';
  if (str(o.outcome, 'outcome') !== derived) throw new SchemaError('validator_aggregate.outcome must be derived: infrastructure_failure > blocking_invalid > clear');
  const out: ValidatorAggregateV2 = {
    trigger: o.trigger as ValidatorAggregateV2['trigger'],
    executionPhase: phase as ValidatorAggregateV2['executionPhase'],
    inputRef,
    inputDigest: inputRef.digest,
    registrationSetDigest: hx(o.registrationSetDigest, 'registrationSetDigest'),
    validExecutionDigests: validDigests,
    blockingInvalidReceiptRefs: blocking,
    advisoryReceiptRefs: advisory,
    infrastructureFailureRefs: infra,
    warningRootRef: rfKind(o.warningRootRef, 'validation_warning_root', 'warningRootRef'),
    aggregateDigest: '',
    outcome: derived,
  };
  hs(out, o.aggregateDigest, 'aggregateDigest', 'validator_aggregate');
  return { ...out, aggregateDigest: hx(o.aggregateDigest, 'aggregateDigest') };
}

export function parseValidatorFailure(value: unknown): ValidatorFailureV2 {
  const o = rec(value, 'validator_failure');
  ex(o, ['validatorId', 'handlerKey', 'implementationDigest', 'executionId', 'inputRef', 'inputDigest', 'failureCode', 'failureDigest', 'workItemId', 'attemptId', 'commandId'], 'validator_failure');
  const attemptId = o.attemptId === null ? null : str(o.attemptId, 'attemptId');
  const commandId = o.commandId === null ? null : str(o.commandId, 'commandId');
  if ((attemptId === null) === (commandId === null)) {
    throw new SchemaError('validator_failure must carry exactly one of attemptId | commandId');
  }
  const inputRef = rfKind(o.inputRef, 'validator_input_envelope', 'inputRef');
  if (hx(o.inputDigest, 'inputDigest') !== inputRef.digest) throw new SchemaError('inputDigest must equal inputRef.digest');
  return {
    validatorId: str(o.validatorId, 'validatorId'),
    handlerKey: str(o.handlerKey, 'handlerKey'),
    implementationDigest: hx(o.implementationDigest, 'implementationDigest'),
    executionId: str(o.executionId, 'executionId'),
    inputRef,
    inputDigest: inputRef.digest,
    failureCode: str(o.failureCode, 'failureCode'),
    failureDigest: hx(o.failureDigest, 'failureDigest'),
    workItemId: str(o.workItemId, 'workItemId'),
    attemptId,
    commandId,
  };
}

/* ---- write_grant_spec (§11.11) ----------------------------------- */
function parseMapWriteScope(value: unknown, where: string): Record<string, unknown> {
  const o = rec(value, where);
  ex(o, ['nodeIds', 'relationIds', 'allowedPlanKeys', 'parentContainers', 'relationTypeIds', 'operations'], where);
  const ops = sa(o.operations, 'operations');
  const ALLOWED_OPS = ['add_node', 'remove_node', 'add_relation', 'remove_relation', 'update_attributes'];
  for (const op of ops) if (!(ALLOWED_OPS as readonly string[]).includes(op)) throw new SchemaError('operations unknown op');
  return {
    nodeIds: sa(o.nodeIds, 'nodeIds'),
    relationIds: sa(o.relationIds, 'relationIds'),
    allowedPlanKeys: sa(o.allowedPlanKeys, 'allowedPlanKeys'),
    parentContainers: sa(o.parentContainers, 'parentContainers'),
    relationTypeIds: sa(o.relationTypeIds, 'relationTypeIds'),
    operations: ops,
  };
}

export function parseWriteGrantSpec(value: unknown): WriteGrantSpecV2 {
  const o = rec(value, 'write_grant_spec');
  const kind = str(o.kind, 'kind');
  if (kind === 'initial_structure_chunk') {
    ex(o, ['grantSpecId', 'workItemId', 'kind', 'snapshotHash', 'authorityBaseRef', 'mapBuildSpecRef', 'expectedFrontierDigest', 'structureChunkScope', 'specDigest'], 'write_grant_spec');
    const scope = rec(o.structureChunkScope, 'structureChunkScope');
    ex(scope, ['chunkOrdinal', 'parentFrontierDigest', 'maxNodes', 'maxRelations'], 'structureChunkScope');
    const out: Record<string, unknown> = {
      grantSpecId: str(o.grantSpecId, 'grantSpecId'),
      workItemId: str(o.workItemId, 'workItemId'),
      kind,
      snapshotHash: str(o.snapshotHash, 'snapshotHash'),
      authorityBaseRef: rfKind(o.authorityBaseRef, 'authority_base_set', 'authorityBaseRef'),
      mapBuildSpecRef: rfKind(o.mapBuildSpecRef, 'map_build_spec', 'mapBuildSpecRef'),
      expectedFrontierDigest: hx(o.expectedFrontierDigest, 'expectedFrontierDigest'),
      structureChunkScope: {
        chunkOrdinal: onn(scope.chunkOrdinal, 'chunkOrdinal'),
        parentFrontierDigest: hx(scope.parentFrontierDigest, 'parentFrontierDigest'),
        maxNodes: onn(scope.maxNodes, 'maxNodes'),
        maxRelations: onn(scope.maxRelations, 'maxRelations'),
      },
    };
    hs(out, o.specDigest, 'specDigest', 'write_grant_spec');
    return { ...out, specDigest: hx(o.specDigest, 'specDigest') } as WriteGrantSpecV2;
  }
  if (kind === 'initial_generation_batch') {
    ex(o, ['grantSpecId', 'workItemId', 'kind', 'snapshotHash', 'authorityBaseRef', 'generationPlanSpecRef', 'activeMapRef', 'expectedContentRevisionManifestRef', 'writeSlotIds', 'readScope', 'specDigest'], 'write_grant_spec');
    const rs = rec(o.readScope, 'readScope');
    ex(rs, ['maxContextBytes'], 'readScope');
    const out: Record<string, unknown> = {
      grantSpecId: str(o.grantSpecId, 'grantSpecId'),
      workItemId: str(o.workItemId, 'workItemId'),
      kind,
      snapshotHash: str(o.snapshotHash, 'snapshotHash'),
      authorityBaseRef: rfKind(o.authorityBaseRef, 'authority_base_set', 'authorityBaseRef'),
      generationPlanSpecRef: rfKind(o.generationPlanSpecRef, 'generation_plan_spec', 'generationPlanSpecRef'),
      activeMapRef: rfKind(o.activeMapRef, 'map_snapshot', 'activeMapRef'),
      expectedContentRevisionManifestRef: rfKind(o.expectedContentRevisionManifestRef, 'content_revision_manifest', 'expectedContentRevisionManifestRef'),
      writeSlotIds: sa(o.writeSlotIds, 'writeSlotIds'),
      readScope: { maxContextBytes: onn(rs.maxContextBytes, 'maxContextBytes') },
    };
    hs(out, o.specDigest, 'specDigest', 'write_grant_spec');
    return { ...out, specDigest: hx(o.specDigest, 'specDigest') } as WriteGrantSpecV2;
  }
  if (kind === 'map_repair_batch' || kind === 'content_repair_batch') {
    ex(o, ['grantSpecId', 'workItemId', 'kind', 'snapshotHash', 'authorityBaseRef', 'repairPlanSpecRef', 'repairBase', 'expectedStagingRootRef', 'planKeyLedgerRef', 'batchOrdinal', 'findingIds', 'readScope', 'writeScope', 'specDigest'], 'write_grant_spec');
    const repairBase = rec(o.repairBase, 'repairBase');
    if (kind === 'map_repair_batch') {
      if (repairBase.kind !== 'map_active' && repairBase.kind !== 'map_candidate') throw new SchemaError('map repair grant repairBase must be map_active|map_candidate');
    } else if (repairBase.kind !== 'content') {
      throw new SchemaError('content repair grant repairBase must be kind=content');
    }
    const writeScope = rec(o.writeScope, 'writeScope');
    let ws: Record<string, unknown>;
    if (kind === 'map_repair_batch') {
      ws = { mapWriteScope: parseMapWriteScope(writeScope.mapWriteScope, 'mapWriteScope') };
      if (writeScope.writeSlotIds !== undefined) throw new SchemaError('map repair grant must use mapWriteScope');
    } else {
      ex(writeScope, ['writeSlotIds'], 'writeScope');
      ws = { writeSlotIds: sa(writeScope.writeSlotIds, 'writeSlotIds') };
    }
    const rs = rec(o.readScope, 'readScope');
    ex(rs, ['maxContextBytes'], 'readScope');
    const out: Record<string, unknown> = {
      grantSpecId: str(o.grantSpecId, 'grantSpecId'),
      workItemId: str(o.workItemId, 'workItemId'),
      kind,
      snapshotHash: str(o.snapshotHash, 'snapshotHash'),
      authorityBaseRef: rfKind(o.authorityBaseRef, 'authority_base_set', 'authorityBaseRef'),
      repairPlanSpecRef: rfKind(o.repairPlanSpecRef, 'repair_plan_spec', 'repairPlanSpecRef'),
      repairBase: repairBase as Record<string, unknown>,
      expectedStagingRootRef: rfKind(o.expectedStagingRootRef, 'repair_staging_root', 'expectedStagingRootRef'),
      planKeyLedgerRef: rfn(o.planKeyLedgerRef, 'planKeyLedgerRef'),
      batchOrdinal: onn(o.batchOrdinal, 'batchOrdinal'),
      findingIds: sa(o.findingIds, 'findingIds'),
      readScope: { maxContextBytes: onn(rs.maxContextBytes, 'maxContextBytes') },
      writeScope: ws,
    };
    hs(out, o.specDigest, 'specDigest', 'write_grant_spec');
    return { ...out, specDigest: hx(o.specDigest, 'specDigest') } as WriteGrantSpecV2;
  }
  if (kind === 'review_observation') {
    ex(o, ['grantSpecId', 'workItemId', 'kind', 'snapshotHash', 'authorityBaseRef', 'sessionKind', 'reviewAssignmentId', 'roundId', 'roundKind', 'readScope', 'specDigest'], 'write_grant_spec');
    const session = o.sessionKind === null ? null : str(o.sessionKind, 'sessionKind');
    if (session !== null && !WRITE_GRANT_SESSION_KINDS.includes(session)) {
      throw new SchemaError('write_grant_spec.sessionKind must be a structured session kind or null');
    }
    const roundKind = o.roundKind === null ? null : str(o.roundKind, 'roundKind');
    if (roundKind !== null && roundKind !== 'map' && roundKind !== 'content') {
      throw new SchemaError('write_grant_spec.roundKind must be map|content|null');
    }
    const rs = rec(o.readScope, 'readScope');
    ex(rs, ['maxContextBytes'], 'readScope');
    const out: Record<string, unknown> = {
      grantSpecId: str(o.grantSpecId, 'grantSpecId'),
      workItemId: str(o.workItemId, 'workItemId'),
      kind,
      snapshotHash: str(o.snapshotHash, 'snapshotHash'),
      authorityBaseRef: rfKind(o.authorityBaseRef, 'authority_base_set', 'authorityBaseRef'),
      sessionKind: session,
      reviewAssignmentId: o.reviewAssignmentId === null ? null : str(o.reviewAssignmentId, 'reviewAssignmentId'),
      roundId: o.roundId === null ? null : str(o.roundId, 'roundId'),
      roundKind,
      readScope: { maxContextBytes: onn(rs.maxContextBytes, 'maxContextBytes') },
    };
    hs(out, o.specDigest, 'specDigest', 'write_grant_spec');
    return { ...out, specDigest: hx(o.specDigest, 'specDigest') } as WriteGrantSpecV2;
  }
  throw new SchemaError('write_grant_spec.kind must be initial_structure_chunk|initial_generation_batch|map_repair_batch|content_repair_batch|review_observation');
}
