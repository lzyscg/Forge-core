// @vitest-environment node
/**
 * Task 8 typed publication intent registry tests (spec §8, design §19.1).
 *
 * The registry is a CLOSED allowlist mapping each handler kind/version to one
 * publication_operation_payload branch: strict payload parsing, exact
 * event-schema identity, deterministic event-envelope building, child-ref
 * extraction and deterministic result identity. Unknown/mismatched
 * handler/payload/event/result must fail closed; registrations can be added
 * by later tasks through the explicit registration API, never at runtime by
 * payload content.
 *
 * buildEvents produces events WITHOUT an id — the facade stamps ids
 * deterministically via `deterministicEventId(operationId, handlerKind, index)`,
 * which is what makes a crashed pin's replay byte-identical.
 */
import { describe, expect, it } from 'vitest';
import {
  deterministicEventId,
  publicationPayloadChildRefs,
  registerPublicationIntent,
  resolvePublicationIntent,
  PublicationIntentRegistry,
  NotRebuildableError,
  type PublicationIntentRegistrationV2,
} from './authoritative-publication-intent-registry';
import type { AuthoritativeReviewEventV2 } from './authoritative-review-events';
import type { PublicationOperationPayloadV2 } from '../authoritative-review/authority-types';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';

const H_REF = (kind: string, digest: string): BlobRefV2 => ({
  kind: kind as BlobRefV2['kind'],
  digest,
  byteLength: 12,
  mediaType: 'application/json',
  schemaVersion: 1,
});

const H1 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const H2 = '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const H3 = '2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const H4 = '3123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const H5 = '4123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('PublicationIntentRegistry', () => {
  it('resolves each built-in handler kind/version to exactly one payload family', () => {
    const expectations: ReadonlyArray<[string, number, string]> = [
      ['lifecycle/stop', 1, 'lifecycle'],
      ['lifecycle/resume', 1, 'lifecycle'],
      ['artifact_publish', 1, 'artifact_publish'],
      ['work_item_leased', 1, 'lease_or_retry'],
      ['work_item_requeued', 1, 'lease_or_retry'],
      ['work_item_lease_reclaimed', 1, 'lease_or_retry'],
      ['human_answer', 1, 'question'],
      ['retry_system_command', 1, 'recovery'],
      ['restart_map_review_cycle', 1, 'recovery'],
      ['restart_content_review_cycle', 1, 'recovery'],
      ['rebuild_missing_work', 1, 'recovery'],
      ['task_delete', 1, 'delete'],
    ];
    for (const [handlerKind, handlerVersion, family] of expectations) {
      const registration = resolvePublicationIntent(handlerKind, handlerVersion);
      expect(registration).not.toBeNull();
      expect(registration?.payloadFamily).toBe(family);
    }
  });

  it('fails closed on unknown handler kind, unknown version and unregistered combinations', () => {
    expect(resolvePublicationIntent('lifecycle/unknown', 1)).toBeNull();
    expect(resolvePublicationIntent('lifecycle/stop', 2)).toBeNull();
    expect(resolvePublicationIntent('lifecycle/stop', 0)).toBeNull();
    expect(resolvePublicationIntent('', 1)).toBeNull();
    expect(resolvePublicationIntent('map_build_commit', 1)).toBeNull();
  });

  it('rejects duplicate registrations through the explicit registration API', () => {
    expect(() => registerPublicationIntent(makeRegistration('lifecycle/stop'))).toThrowError(/already registered|重复|duplicate/i);
    // A genuinely unknown key still registers (later tasks add handlers this way).
    registerPublicationIntent(makeRegistration('test/new-handler'));
    expect(resolvePublicationIntent('test/new-handler', 1)?.payloadFamily).toBe('lifecycle');
  });
});

function makeRegistration(handlerKind: string): PublicationIntentRegistrationV2 {
  return {
    handlerKind,
    handlerVersion: 1,
    payloadFamily: 'lifecycle',
    expectedEventTypes: ['structured_task_suspension_applied_v2'],
    rebuildable: false,
    missingInputs: ['synthetic test field'],
    childRefsOf: () => [],
    parsePayload: (value) => value as PublicationOperationPayloadV2,
    resolveRefs: () => [],
    buildEvents: () => {
      throw new NotRebuildableError(handlerKind, ['synthetic test field']);
    },
    expectedResultIdentity: () => 'never',
  };
}

describe('PublicationIntentRegistry deterministic builders', () => {
  it('builds the suspension-applied event deterministically for lifecycle/stop (id stamped by facade)', () => {
    const registration = resolvePublicationIntent('lifecycle/stop', 1) as PublicationIntentRegistrationV2;
    const payload: PublicationOperationPayloadV2 = {
      family: 'lifecycle',
      operationId: 'a11f5f50-0000-4000-8000-000000000000',
      taskId: 'task-1',
      kind: 'stop',
      suspensionId: 'sus-1',
      workItemId: null,
      reason: 'user_stop',
      leaseEpoch: null,
      expectedLastSequence: null,
      authorityBaseRef: null,
      attemptFamily: null,
      attemptId: null,
      commandId: null,
      agentId: null,
      commandKind: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      sessionKind: null,
      inputArtifactDeliveryId: null,
      workItemKind: null,
      roleBinding: null,
      agentExecutionKind: null,
      roundId: null,
      grantSpecRef: null,
      payloadRef: null,
      initialLeaseEpoch: null,
      maxAutomaticRetries: null,
      mapBuildId: null,
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
    };
    const at = '2026-08-14T10:00:00.000Z';
    const first = registration.buildEvents(payload, at);
    const stamp = (events: readonly (AuthoritativeReviewEventV2 | Omit<AuthoritativeReviewEventV2, 'id'> | (import('./authoritative-publication-intent-registry').PublicationEventEnvelopeV2))[]): AuthoritativeReviewEventV2[] =>
      events.map((event, index) => ({
        ...event,
        id: deterministicEventId(payload.operationId, registration.handlerKind, index),
      })) as AuthoritativeReviewEventV2[];
    const stamped = stamp(first);
    expect(registration.buildEvents(payload, at)).toEqual(first);
    expect(stamp(registration.buildEvents(payload, at))).toEqual(stamped);
    expect(stamped).toHaveLength(1);
    expect(stamped[0]?.type).toBe('structured_task_suspension_applied_v2');
    expect(stamped[0]).toMatchObject({
      protocolVersion: 2,
      suspensionId: 'sus-1',
      reason: 'user_stop',
      operationId: 'a11f5f50-0000-4000-8000-000000000000',
      at,
    });
    expect(stamped[0]?.id).toMatch(/^evt-[0-9a-f]{32}$/);
    // Deterministic result identity over the exact final event bytes.
    const identity = registration.expectedResultIdentity(payload, stamped);
    expect(identity).toMatch(/^[0-9a-f]{64}$/);
    const rerun = stampIds(registration, payload, registration.buildEvents(payload, at));
    expect(registration.expectedResultIdentity(payload, rerun)).toBe(identity);
  });

  it('builds the suspension-cleared event deterministically for lifecycle/resume', () => {
    const registration = resolvePublicationIntent('lifecycle/resume', 1) as PublicationIntentRegistrationV2;
    const payload: PublicationOperationPayloadV2 = {
      family: 'lifecycle',
      operationId: 'b22f5f50-0000-4000-8000-000000000000',
      taskId: 'task-1',
      kind: 'resume',
      suspensionId: 'sus-1',
      workItemId: 'wi-2',
      reason: null,
      leaseEpoch: null,
      expectedLastSequence: null,
      authorityBaseRef: null,
      attemptFamily: null,
      attemptId: null,
      commandId: null,
      agentId: null,
      commandKind: null,
      logicalAssignmentId: null,
      reviewAssignmentId: null,
      sessionKind: null,
      inputArtifactDeliveryId: null,
      workItemKind: null,
      roleBinding: null,
      agentExecutionKind: null,
      roundId: null,
      grantSpecRef: null,
      payloadRef: null,
      initialLeaseEpoch: null,
      maxAutomaticRetries: null,
      mapBuildId: null,
      supersedesMapBuildId: null,
      sourceValidationReceiptRef: null,
    };
    const events = stampIds(registration, payload, registration.buildEvents(payload, '2026-08-14T10:00:00.000Z'));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('structured_task_suspension_cleared_v2');
    expect(events[0]).toMatchObject({
      protocolVersion: 2,
      suspensionId: 'sus-1',
      operationId: 'b22f5f50-0000-4000-8000-000000000000',
    });
  });

  it('builds artifact_published_v2 deterministically from pinned delivery/artifact refs', () => {
    const registration = resolvePublicationIntent('artifact_publish', 1) as PublicationIntentRegistrationV2;
    const artifactRef = { ...H_REF('artifact', H1), mediaType: 'text/markdown' as const };
    const payload: PublicationOperationPayloadV2 = {
      family: 'artifact_publish',
      operationId: 'c33f5f50-0000-4000-8000-000000000000',
      taskId: 'task-1',
      artifactRef,
      sealRecordRef: H_REF('seal_record', H2),
      deliveryRef: H_REF('system_artifact_delivery', H3),
      expectedArtifactVersion: 7,
    };
    const refs = new Map<string, unknown>();
    refs.set('delivery', {
      deliveryId: 'del-1',
      producer: 'system:structured_seal',
      sealRecordRef: H_REF('seal_record', H2),
      sealRecordDigest: H2,
      artifactId: 'art-1',
      artifactRef,
      artifactDigest: H1,
      custodyRef: H_REF('seal_record', H4),
      custodyDigest: H4,
      submitterWorkItemId: 'wi-9',
      submitterAgentId: 'agent-1',
      templateSnapshotHash: H5,
    });
    refs.set('artifact', { artifactId: 'art-1', mediaType: 'text/markdown', text: 'hello' });
    const built = registration.buildEvents(payload, '2026-08-14T10:00:00.000Z', refs);
    const events = stampIds(registration, payload, built);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('artifact_published_v2');
    const published = events[0] as Extract<AuthoritativeReviewEventV2, { type: 'artifact_published_v2' }>;
    expect(published.artifactId).toBe('art-1');
    expect(published.artifactVersion).toBe(7);
    expect(published.deliveryRef.digest).toBe(H3);
    expect(published.mediaType).toBe('text/markdown');
    expect(published.files).toEqual([{ name: 'art-1.md', hash: H1 }]);
    expect(published.provenance).toEqual({
      producerKind: 'system',
      producerWorkItemId: 'wi-9',
      sealRecordRef: H_REF('seal_record', H2),
      artifactRef,
      custodyRef: H_REF('seal_record', H4),
    });
    expect(stampIds(registration, payload, registration.buildEvents(payload, '2026-08-14T10:00:00.000Z', refs))).toEqual(events);
  });

  it('fails closed (NotRebuildableError) for registered families whose payload cannot rebuild the event byte-identically', () => {
    const cases: ReadonlyArray<[string, number, PublicationOperationPayloadV2]> = [
      // Task 11 (constraint A round 2): human_answer is now REBUILDABLE; a
      // mode-open payload under the answer handler still fails closed because
      // the builder demands the answer-mode fields it cannot rebuild.
      [
        'human_answer',
        1,
        {
          family: 'question',
          operationId: 'e55f5f50-0000-4000-8000-000000000000',
          taskId: 'task-1',
          questionId: 'q-1',
          questionVersion: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          mode: 'open',
          questionDigest: H1,
          text: 'question text',
          answerText: null,
          openedCommitId: 'c-1',
          expectedLastSequence: 0,
          originalWorkItemId: 'w-1',
          replacementWorkItemId: null,
          deliveryId: null,
          attemptId: 'att-1',
          leaseEpoch: 1,
          logicalAssignmentId: 'la-1',
          reviewAssignmentId: null,
          sessionKind: 'structure_chunk',
          agentId: 'agent-1',
          answerDigest: null,
          authorityBaseRef: H_REF('authority_base_set', H1),
          kind: null,
          roleBinding: null,
          agentExecutionKind: null,
          roundId: null,
          grantSpecRef: null,
          inputArtifactDeliveryId: null,
          payloadRef: null,
          initialLeaseEpoch: null,
          maxAutomaticRetries: null,
          failureCode: 'WAITING_HUMAN',
          failureDigest: H1,
        },
      ],
      [
        'retry_system_command',
        1,
        {
          family: 'recovery',
          operationId: 'f66f5f50-0000-4000-8000-000000000000',
          taskId: 'task-1',
          expectedLastSequence: 2,
          operatorId: 'task_owner',
          reason: 'reopen',
          recipeKey: 'restart_map_review_cycle',
          track: 'map',
          failureRecoveryPayloadRef: H_REF('failure_recovery_payload', H1),
          overrideRef: null,
          replacementWorkItemId: null,
          replacementKind: null,
          replacementRoleBinding: null,
          replacementAgentExecutionKind: null,
          replacementSessionKind: null,
          replacementRoundId: null,
          replacementLogicalAssignmentId: null,
          replacementReviewAssignmentId: null,
          replacementGrantSpecRef: null,
          replacementInputArtifactDeliveryId: null,
          replacementPayloadRef: null,
          replacementAuthorityBaseRef: null,
          replacementLeaseEpoch: null,
          replacementMaxAutomaticRetries: null,
        },
      ],
      [
        'task_delete',
        1,
        { family: 'delete', operationId: 'a77f5f50-0000-4000-8000-000000000000', taskId: 'task-1', deleteEpoch: 1 },
      ],
    ];
    for (const [handlerKind, handlerVersion, payload] of cases) {
      const registration = resolvePublicationIntent(handlerKind, handlerVersion);
      expect(registration).not.toBeNull();
      expect(() => registration?.buildEvents(payload, '2026-08-14T10:00:00.000Z')).toThrowError(
        NotRebuildableError,
      );
    }
  });
});

function stampIds(
  registration: PublicationIntentRegistrationV2,
  payload: PublicationOperationPayloadV2,
  events: readonly (AuthoritativeReviewEventV2 | Omit<AuthoritativeReviewEventV2, 'id'> | (import('./authoritative-publication-intent-registry').PublicationEventEnvelopeV2))[],
): AuthoritativeReviewEventV2[] {
  return events.map((event, index) => ({
    ...event,
    id: deterministicEventId(payload.operationId, registration.handlerKind, index),
  })) as AuthoritativeReviewEventV2[];
}

describe('publication_operation_payload child-ref extraction', () => {
  it('covers every payload family exactly, including null overrideRef', () => {
    const authority = H_REF('authority_base_set', H1);
    const families: ReadonlyArray<[PublicationOperationPayloadV2, BlobRefV2[]]> = [
      [
        { family: 'domain_publish', operationId: 'op-1', taskId: 't', publishKind: 'map_build_commit', blobRefs: [H_REF('map_build_spec', H2)], expectedResultIdentity: 'x', mapBuild: null, mapReview: null, contentPlan: null, contentReview: null, repair: null },
        [H_REF('map_build_spec', H2)],
      ],
      [
        { family: 'lease_or_retry', operationId: 'op-1', taskId: 't', workItemId: 'w', leaseEpoch: 1, eventBuilder: 'work_item_leased', authorityBaseRef: authority, kind: null, roleBinding: null, agentExecutionKind: null, sessionKind: null, roundId: null, logicalAssignmentId: null, reviewAssignmentId: null, grantSpecRef: null, inputArtifactDeliveryId: null, payloadRef: null, initialLeaseEpoch: null, maxAutomaticRetries: null, leaseOwner: null, leaseExpiresAt: null, expectedLastSequence: null, attemptFamily: null, attemptId: null, commandId: null, agentId: null, commandKind: null, dispatchRef: null, grantInstanceRef: null, reason: null, failureCode: null, failureDigest: null, retryOrdinal: null, retryNotBefore: null, validatorAggregateRef: null, budgetPolicyDigest: null, failureRecoveryPayloadRef: null, taskFailure: null, resultRefs: [] },
        [authority],
      ],
      [
        { family: 'lifecycle', operationId: 'op-1', taskId: 't', kind: 'stop', suspensionId: null, workItemId: null, reason: null, leaseEpoch: null, expectedLastSequence: null, authorityBaseRef: null, attemptFamily: null, attemptId: null, commandId: null, agentId: null, commandKind: null, logicalAssignmentId: null, reviewAssignmentId: null, sessionKind: null, inputArtifactDeliveryId: null, workItemKind: null, roleBinding: null, agentExecutionKind: null, roundId: null, grantSpecRef: null, payloadRef: null, initialLeaseEpoch: null, maxAutomaticRetries: null, mapBuildId: null, supersedesMapBuildId: null, sourceValidationReceiptRef: null },
        [],
      ],
      [
        { family: 'question', operationId: 'op-1', taskId: 't', questionId: 'q', questionVersion: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', mode: 'answer', questionDigest: null, text: null, answerText: 'reply', openedCommitId: null, expectedLastSequence: 3, originalWorkItemId: 'w-old', replacementWorkItemId: 'w-new', deliveryId: 'del-1', attemptId: null, leaseEpoch: 1, logicalAssignmentId: 'la-1', reviewAssignmentId: null, sessionKind: 'structure_chunk', agentId: 'agent-1', answerDigest: H3, authorityBaseRef: authority, kind: 'agent_assignment', roleBinding: 'orchestrator', agentExecutionKind: 'structured_session', roundId: null, grantSpecRef: null, inputArtifactDeliveryId: null, payloadRef: H_REF('content_value', H2), initialLeaseEpoch: 2, maxAutomaticRetries: 3, failureCode: null, failureDigest: null },
        [authority, H_REF('content_value', H2)],
      ],
      [
        { family: 'recovery', operationId: 'op-1', taskId: 't', expectedLastSequence: 4, operatorId: 'task_owner', reason: 'reopen', recipeKey: 'rebuild_missing_work', track: 'map', failureRecoveryPayloadRef: H_REF('failure_recovery_payload', H4), overrideRef: H_REF('round_budget_override', H5), replacementWorkItemId: null, replacementKind: null, replacementRoleBinding: null, replacementAgentExecutionKind: null, replacementSessionKind: null, replacementRoundId: null, replacementLogicalAssignmentId: null, replacementReviewAssignmentId: null, replacementGrantSpecRef: null, replacementInputArtifactDeliveryId: null, replacementPayloadRef: null, replacementAuthorityBaseRef: null, replacementLeaseEpoch: null, replacementMaxAutomaticRetries: null },
        [H_REF('failure_recovery_payload', H4), H_REF('round_budget_override', H5)],
      ],
      [
        { family: 'recovery', operationId: 'op-1', taskId: 't', expectedLastSequence: 4, operatorId: 'task_owner', reason: 'reopen', recipeKey: 'retry_system_command', track: null, failureRecoveryPayloadRef: H_REF('failure_recovery_payload', H4), overrideRef: null, replacementWorkItemId: null, replacementKind: null, replacementRoleBinding: null, replacementAgentExecutionKind: null, replacementSessionKind: null, replacementRoundId: null, replacementLogicalAssignmentId: null, replacementReviewAssignmentId: null, replacementGrantSpecRef: null, replacementInputArtifactDeliveryId: null, replacementPayloadRef: null, replacementAuthorityBaseRef: null, replacementLeaseEpoch: null, replacementMaxAutomaticRetries: null },
        [H_REF('failure_recovery_payload', H4)],
      ],
      [
        { family: 'delete', operationId: 'op-1', taskId: 't', deleteEpoch: 2 },
        [],
      ],
      [
        { family: 'artifact_publish', operationId: 'op-1', taskId: 't', artifactRef: H_REF('artifact', H5), sealRecordRef: H_REF('seal_record', H4), deliveryRef: H_REF('system_artifact_delivery', H3), expectedArtifactVersion: 1 },
        [H_REF('artifact', H5), H_REF('seal_record', H4), H_REF('system_artifact_delivery', H3)],
      ],
    ];
    for (const [payload, expected] of families) {
      expect(publicationPayloadChildRefs(payload)).toEqual(expected);
    }
  });

  it('throws schema-validated errors on unparseable payload values instead of guessing', () => {
    expect(() => publicationPayloadChildRefs({ family: 'artifact_publish' } as unknown as PublicationOperationPayloadV2)).toThrow();
  });
});

describe('PublicationIntentRegistry isolation', () => {
  it('lets later tasks register handlers on a fresh instance without global pollution', () => {
    const singletonKey = 'work_item_leased';
    const before = resolvePublicationIntent(singletonKey, 1);
    expect(before).not.toBeNull();
    const instance = new PublicationIntentRegistry();
    expect(instance.resolve(singletonKey, 1)).not.toBeNull();
    // The fresh instance is seeded with the builtins; a test-only addition
    // does not leak into the module-level allowlist.
    instance.register(makeRegistration('test/isolated'));
    expect(instance.resolve('test/isolated', 1)).not.toBeNull();
    expect(resolvePublicationIntent('test/isolated', 1)).toBeNull();
  });

  it('marks every Task 10 workitem-mutation handler byte-rebuildable (constraint A)', () => {
    const rebuildable: ReadonlyArray<[string, number]> = [
      ['work_item_created', 1],
      ['work_item_leased', 1],
      ['work_item_retryable_failed', 1],
      ['work_item_requeued', 1],
      ['work_item_lease_reclaimed', 1],
      ['work_item_parked', 1],
      ['lifecycle/manual_retry', 1],
      ['lifecycle/stop', 1],
      ['lifecycle/resume', 1],
      // Task 11 (constraint A round 2): start/question/recovery/failure handlers.
      ['lifecycle/start_task', 1],
      ['human_question_open', 1],
      ['human_answer', 1],
      ['retry_system_command', 1],
      ['restart_map_review_cycle', 1],
      ['restart_content_review_cycle', 1],
      ['rebuild_missing_work', 1],
      ['task_terminal_failed', 1],
      // Task 12 (constraint A round 3): the SUCCESS completion envelope.
      ['work_item_completed', 1],
    ];
    for (const [handlerKind, handlerVersion] of rebuildable) {
      const registration = resolvePublicationIntent(handlerKind, handlerVersion);
      expect(registration?.rebuildable).toBe(true);
      expect(registration?.missingInputs).toEqual([]);
    }
    // The delete tombstone produces NO v2 event (Task 11 ruling): it stays
    // registered but NON-rebuildable — no pin may ever replay a delete.
    for (const handlerKind of ['task_delete']) {
      expect(resolvePublicationIntent(handlerKind, 1)?.rebuildable).toBe(false);
    }
  });

  it('rejects half-state cycle builders whose attemptFamily is null (designated §9.2 admission gate)', () => {
    const authority = H_REF('authority_base_set', H1);
    const leaseLike = (eventBuilder: 'work_item_leased' | 'work_item_retryable_failed' | 'work_item_lease_reclaimed' | 'work_item_parked'): PublicationOperationPayloadV2 => ({
      family: 'lease_or_retry',
      operationId: 'op-family-null',
      taskId: 't',
      workItemId: 'w',
      leaseEpoch: 1,
      eventBuilder,
      authorityBaseRef: authority,
      kind: 'agent_assignment',
      roleBinding: 'orchestrator',
      agentExecutionKind: 'structured_session',
      sessionKind: 'structure_chunk',
      roundId: null,
      logicalAssignmentId: 'la-1',
      reviewAssignmentId: null,
      grantSpecRef: null,
      inputArtifactDeliveryId: null,
      payloadRef: null,
      initialLeaseEpoch: 0,
      maxAutomaticRetries: 2,
      leaseOwner: 'worker-a',
      leaseExpiresAt: '2026-08-14T10:30:00.000Z',
      expectedLastSequence: 0,
      attemptFamily: null,
      attemptId: null,
      commandId: null,
      agentId: null,
      commandKind: null,
      dispatchRef: null,
      grantInstanceRef: null,
      reason: 'lease_expired',
      failureCode: 'HANDLER_FAILED',
      failureDigest: H1,
      retryOrdinal: 1,
      retryNotBefore: '2026-08-14T10:00:05.000Z',
      validatorAggregateRef: null,
      budgetPolicyDigest: H2,
      failureRecoveryPayloadRef: null,
      taskFailure: null,
      resultRefs: [],
    });
    for (const builder of ['work_item_leased', 'work_item_retryable_failed', 'work_item_lease_reclaimed', 'work_item_parked'] as const) {
      const registration = resolvePublicationIntent(builder, 1);
      expect(registration).not.toBeNull();
      expect(() => registration?.buildEvents(leaseLike(builder), '2026-08-14T10:00:00.000Z')).toThrowError(
        NotRebuildableError,
      );
    }
    // requeue carries no execution family at all — it must stay legal.
    const requeued = resolvePublicationIntent('work_item_requeued', 1);
    const requeuePayload = {
      ...leaseLike('work_item_leased'),
      eventBuilder: 'work_item_requeued' as const,
    } as PublicationOperationPayloadV2;
    expect(() => requeued?.buildEvents(requeuePayload, '2026-08-14T10:00:00.000Z')).not.toThrow();
  });

  it('exposes exact event-schema identity per registration', () => {
    expect(resolvePublicationIntent('lifecycle/stop', 1)?.expectedEventTypes).toEqual([
      'structured_agent_attempt_abandoned_v2',
      'structured_generic_agent_attempt_abandoned',
      'structured_system_command_abandoned',
      'structured_work_item_lease_reclaimed',
      'task_stopped',
      'task_interrupted',
      'structured_task_suspension_applied_v2',
    ]);
    expect(resolvePublicationIntent('lifecycle/resume', 1)?.expectedEventTypes).toEqual([
      'structured_task_suspension_cleared_v2',
    ]);
    expect(resolvePublicationIntent('artifact_publish', 1)?.expectedEventTypes).toEqual([
      'artifact_published_v2',
    ]);
  });

  it('derives deterministic filename-safe event ids from operation + handler + index', () => {
    const a = deterministicEventId('op-1', 'lifecycle/stop', 0);
    const b = deterministicEventId('op-1', 'lifecycle/stop', 0);
    const c = deterministicEventId('op-1', 'lifecycle/stop', 1);
    const d = deterministicEventId('op-2', 'lifecycle/stop', 0);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^evt-[0-9a-f]{32}$/);
  });
});

/* ==================================================================== */
/* Task 21 P1#3: system_seal_publish cross-object closure validation    */
/* (design §16.3 / spec §13.5)                                          */
/* ==================================================================== */

/** Distinct 64-hex content-address stand-in (unique per index). */
const DX = (index: number): string => index.toString(16).padStart(2, '0').repeat(32);

interface SealPublishFixture {
  payload: Extract<PublicationOperationPayloadV2, { family: 'seal_publish' }>;
  refs: Map<string, unknown>;
}

const SEAL_AT = '2026-08-14T10:00:00.000Z';

/** A fully consistent §16.3/§13.5 Seal/Delivery closure (every cross-object ref agrees). */
function sealPublishFixture(): SealPublishFixture {
  const artifactRef = { ...H_REF('artifact', DX(1)), mediaType: 'text/markdown' as const };
  const sealRecordRef = H_REF('seal_record', DX(2));
  const bundleRef = H_REF('seal_validation_bundle', DX(3));
  const custodyRef = H_REF('artifact_custody', DX(4));
  const deliveryRef = H_REF('system_artifact_delivery', DX(5));
  const mapRef = H_REF('map_snapshot', DX(6));
  const manifestRef = H_REF('content_revision_manifest', DX(7));
  const reviewBundleRef = H_REF('review_bundle', DX(8));
  const sealAuthorityBaseRef = H_REF('authority_base_set', DX(9));
  const submitterAuthorityBaseRef = H_REF('authority_base_set', DX(10));
  const submitterGrantSpecRef = H_REF('write_grant_spec', DX(11));

  const mapSemanticDigest = DX(12);
  const contentRootDigest = DX(13);
  const assemblerDigest = DX(14);
  const templateSnapshotHash = DX(15);
  const artifactFile = 'chapter.md';
  const artifactFileHash = DX(16);
  const sealWorkItemId = 'wi-seal';
  const submitterWorkItemId = 'wi-submitter';
  const submitterAgentId = 'agent-submitter';

  const payload: Extract<PublicationOperationPayloadV2, { family: 'seal_publish' }> = {
    family: 'seal_publish',
    operationId: 'op-seal-closure',
    taskId: 'task-1',
    artifactRef,
    artifactFile,
    artifactFileHash,
    sealRecordRef,
    sealValidationBundleRef: bundleRef,
    deliveryRef,
    custodyRef,
    mapRef,
    contentRevisionManifestRef: manifestRef,
    reviewBundleRef,
    sealWorkItemId,
    sealCommandId: 'cmd-seal',
    sealLeaseEpoch: 1,
    sealAuthorityBaseRef,
    submitterWorkItemId,
    submitterAuthorityBaseRef,
    submitterGrantSpecRef,
    submitterLogicalAssignmentId: 'la-submitter',
    submitterMaxAutomaticRetries: 2,
  };

  const refs = new Map<string, unknown>();
  refs.set('allocatedArtifactVersion', 5);
  refs.set('artifact', { artifactId: 'art-closure', mediaType: 'text/markdown', text: 'hello' });
  refs.set('delivery', {
    deliveryId: 'del-closure',
    producer: 'system:structured_seal',
    sealRecordRef,
    sealRecordDigest: DX(2),
    artifactId: 'art-closure',
    artifactRef,
    artifactDigest: DX(1),
    custodyRef,
    custodyDigest: DX(4),
    submitterWorkItemId,
    submitterAgentId,
    templateSnapshotHash,
  });
  refs.set('sealRecord', {
    taskId: 'task-1',
    mapRef,
    mapSemanticDigest,
    mapReviewBundleRef: H_REF('map_review_bundle', DX(17)),
    contentRevisionManifestRef: manifestRef,
    contentRootDigest,
    reviewBundleRef,
    sealValidationBundleRef: bundleRef,
    templateSnapshotHash,
    assemblerDigest,
    artifactRef,
    artifactDigest: DX(1),
  });
  refs.set('sealValidationBundle', {
    sealWorkItemId,
    reviewBundleRef,
    contentRevisionManifestRef: manifestRef,
    sealInputAggregateRef: H_REF('validator_aggregate', DX(18)),
    sealOutputAggregateRef: H_REF('validator_aggregate', DX(19)),
    sealWarningCustodyRootRef: H_REF('validation_warning_custody_root', DX(20)),
    assemblerDigest,
    artifactRef,
    artifactDigest: DX(1),
    bundleDigest: DX(21),
  });
  refs.set('custody', {
    taskId: 'task-1',
    sealWorkItemId,
    artifactRef,
    sealRecordRef,
    templateSnapshotHash,
    files: [{ name: artifactFile, hash: artifactFileHash, byteLength: 7 }],
    custodyDigest: DX(22),
  });
  refs.set('map', {
    scaffoldId: 'sc-1',
    mapId: 'map-1',
    supersedesMapId: null,
    sourceCandidateId: 'c-1',
    proposedMapCoreRef: H_REF('proposed_map_core', DX(23)),
    mapReviewBundleRef: H_REF('map_review_bundle', DX(17)),
    mapRevision: 1,
    mapSemanticDigest,
    positionGraphDigest: DX(24),
    relationGraphDigest: DX(25),
    templateSnapshotHash,
    nodes: [],
    relations: [],
    activatedAt: SEAL_AT,
  });
  refs.set('contentRevisionManifest', {
    taskId: 'task-1',
    mapRef,
    mapSemanticDigest,
    taskContentRevision: 1,
    manifestPhase: 'finalized',
    entries: [],
    producerPlanSpecRef: null,
    priorManifestRef: null,
    finalizerValidatorAggregateRefs: [H_REF('validator_aggregate', DX(26))],
    finalizerWarningRootRefs: [],
    contentRootDigest,
    manifestDigest: DX(27),
  });
  refs.set('reviewBundle', {
    settlementCoreRef: H_REF('content_review_settlement_core', DX(28)),
    mapRef,
    contentRevisionManifestRef: manifestRef,
    reviewWarningCustodyRootRef: H_REF('validation_warning_custody_root', DX(29)),
    bundleDigest: DX(30),
  });
  refs.set('submitterGrantSpec', {
    grantSpecId: 'grant-closure',
    workItemId: submitterWorkItemId,
    kind: 'review_observation',
    snapshotHash: templateSnapshotHash,
    authorityBaseRef: submitterAuthorityBaseRef,
    sessionKind: null,
    reviewAssignmentId: null,
    roundId: null,
    roundKind: null,
    readScope: { maxContextBytes: 1024 },
    specDigest: DX(31),
  });
  const authorityBase = (baseSetDigest: string): Record<string, unknown> => ({
    taskId: 'task-1',
    templateSnapshotRef: H_REF('profile_snapshot', DX(32)),
    profileSnapshotRef: H_REF('profile_snapshot', DX(33)),
    mapRef: null,
    mapCandidateRef: null,
    mapReviewBundleRef: null,
    contentRevisionManifestRef: null,
    planSpecRef: null,
    stagingManifestRef: null,
    reviewCoverageCoreRef: null,
    reviewRoundRef: null,
    reviewBundleRef: null,
    sealRecordRef: null,
    artifactRef: null,
    findingSetRef: null,
    artifactDeliveryRef: null,
    displayDigests: {},
    baseSetDigest,
  });
  refs.set('submitterAuthorityBase', authorityBase(DX(34)));
  refs.set('sealAuthorityBase', authorityBase(DX(35)));

  return { payload, refs };
}

describe('system_seal_publish closure validation (Task 21 P1#3)', () => {
  const registration = resolvePublicationIntent('system_seal_publish', 1) as PublicationIntentRegistrationV2;

  it('resolves the full frozen Seal/Delivery closure from the pin payload refs', () => {
    const { payload } = sealPublishFixture();
    const resolved = registration.resolveRefs(payload);
    expect(resolved).toHaveLength(11);
    const byKey = new Map(resolved.map((r) => [r.key, r.ref]));
    expect(byKey.get('delivery')).toBe(payload.deliveryRef);
    expect(byKey.get('artifact')).toBe(payload.artifactRef);
    expect(byKey.get('sealRecord')).toBe(payload.sealRecordRef);
    expect(byKey.get('sealValidationBundle')).toBe(payload.sealValidationBundleRef);
    expect(byKey.get('custody')).toBe(payload.custodyRef);
    expect(byKey.get('map')).toBe(payload.mapRef);
    expect(byKey.get('contentRevisionManifest')).toBe(payload.contentRevisionManifestRef);
    expect(byKey.get('reviewBundle')).toBe(payload.reviewBundleRef);
    expect(byKey.get('submitterGrantSpec')).toBe(payload.submitterGrantSpecRef);
    expect(byKey.get('submitterAuthorityBase')).toBe(payload.submitterAuthorityBaseRef);
    expect(byKey.get('sealAuthorityBase')).toBe(payload.sealAuthorityBaseRef);
  });

  it('rebuilds the six seal events byte-identically from a consistent closure', () => {
    const { payload, refs } = sealPublishFixture();
    const first = registration.buildEvents(payload, SEAL_AT, refs);
    const second = registration.buildEvents(payload, SEAL_AT, refs);
    expect(second).toEqual(first);
    expect(first.map((e) => e.type)).toEqual([
      'structured_scaffold_sealed_v2',
      'artifact_published_v2',
      'structured_system_artifact_delivery_created',
      'structured_work_item_created',
      'structured_system_command_completed',
      'structured_work_item_completed',
    ]);
    const published = first[1] as Extract<AuthoritativeReviewEventV2, { type: 'artifact_published_v2' }>;
    expect(published.artifactId).toBe('art-closure');
    expect(published.artifactVersion).toBe(5);
    expect(published.deliveryRef).toBe(payload.deliveryRef);
    expect(published.files).toEqual([{ name: 'chapter.md', hash: DX(16) }]);
    const submitter = first[3] as Extract<AuthoritativeReviewEventV2, { type: 'structured_work_item_created' }>;
    expect(submitter.workItemId).toBe('wi-submitter');
    expect(submitter.roleBinding).toBe('agent-submitter'); // delivery.submitterAgentId
    expect(submitter.inputArtifactDeliveryId).toBe('del-closure'); // delivery.deliveryId
    // Determinism: stamped ids are identical across independent rebuilds.
    const stamped = stampIds(registration, payload, first);
    expect(stampIds(registration, payload, registration.buildEvents(payload, SEAL_AT, refs))).toEqual(stamped);
  });

  /** Fails closed with NotRebuildableError when a single ref/identity disagrees. */
  const closureRejects = (name: string, mutate: (f: SealPublishFixture) => void): void => {
    it(`fails closed (NotRebuildableError) when ${name}`, () => {
      const f = sealPublishFixture();
      mutate(f);
      expect(() => registration.buildEvents(f.payload, SEAL_AT, f.refs)).toThrowError(NotRebuildableError);
    });
  };

  closureRejects('the delivery.sealRecordRef disagrees with the payload sealRecordRef', (f) => {
    f.refs.set('delivery', { ...(f.refs.get('delivery') as Record<string, unknown>), sealRecordRef: H_REF('seal_record', DX(90)) });
  });
  closureRejects('the delivery.artifactRef disagrees with the payload artifactRef', (f) => {
    f.refs.set('delivery', { ...(f.refs.get('delivery') as Record<string, unknown>), artifactRef: H_REF('artifact', DX(90)) });
  });
  closureRejects('the delivery.custodyRef disagrees with the payload custodyRef', (f) => {
    f.refs.set('delivery', { ...(f.refs.get('delivery') as Record<string, unknown>), custodyRef: H_REF('artifact_custody', DX(90)) });
  });
  closureRejects('the delivery.submitterWorkItemId disagrees with the payload submitterWorkItemId', (f) => {
    f.refs.set('delivery', { ...(f.refs.get('delivery') as Record<string, unknown>), submitterWorkItemId: 'wi-other' });
  });
  closureRejects('the delivery.templateSnapshotHash disagrees with the sealRecord templateSnapshotHash', (f) => {
    f.refs.set('delivery', { ...(f.refs.get('delivery') as Record<string, unknown>), templateSnapshotHash: DX(91) });
  });
  closureRejects('the sealRecord.sealValidationBundleRef disagrees with the payload sealValidationBundleRef', (f) => {
    f.refs.set('sealRecord', { ...(f.refs.get('sealRecord') as Record<string, unknown>), sealValidationBundleRef: H_REF('seal_validation_bundle', DX(90)) });
  });
  closureRejects('the sealRecord.mapSemanticDigest disagrees with the resolved map mapSemanticDigest', (f) => {
    f.refs.set('sealRecord', { ...(f.refs.get('sealRecord') as Record<string, unknown>), mapSemanticDigest: DX(92) });
  });
  closureRejects('the sealValidationBundle.artifactRef disagrees with the payload artifactRef', (f) => {
    f.refs.set('sealValidationBundle', { ...(f.refs.get('sealValidationBundle') as Record<string, unknown>), artifactRef: H_REF('artifact', DX(90)) });
  });
  closureRejects('the sealValidationBundle carries a non-validator sealInputAggregateRef', (f) => {
    f.refs.set('sealValidationBundle', { ...(f.refs.get('sealValidationBundle') as Record<string, unknown>), sealInputAggregateRef: H_REF('map_snapshot', DX(90)) });
  });
  closureRejects('the custody.files do not correspond to the payload artifactFile/artifactFileHash', (f) => {
    f.refs.set('custody', { ...(f.refs.get('custody') as Record<string, unknown>), files: [{ name: 'chapter.md', hash: DX(93), byteLength: 7 }] });
  });
  closureRejects('the artifact.artifactId disagrees with the delivery.artifactId / event artifactId', (f) => {
    f.refs.set('delivery', { ...(f.refs.get('delivery') as Record<string, unknown>), artifactId: 'art-other' });
  });
  closureRejects('a referenced closure blob is missing entirely', (f) => {
    f.refs.delete('sealValidationBundle');
  });
  closureRejects('the submitterAuthorityBase resolves to an object of the wrong kind', (f) => {
    f.refs.set('submitterAuthorityBase', { artifactId: 'art-x', mediaType: 'text/markdown', text: 'x' });
  });
  closureRejects('the submitterGrantSpec.workItemId disagrees with the payload submitterWorkItemId', (f) => {
    f.refs.set('submitterGrantSpec', { ...(f.refs.get('submitterGrantSpec') as Record<string, unknown>), workItemId: 'wi-other' });
  });
  closureRejects('the submitterGrantSpec.authorityBaseRef disagrees with the payload submitterAuthorityBaseRef', (f) => {
    f.refs.set('submitterGrantSpec', { ...(f.refs.get('submitterGrantSpec') as Record<string, unknown>), authorityBaseRef: H_REF('authority_base_set', DX(90)) });
  });
});