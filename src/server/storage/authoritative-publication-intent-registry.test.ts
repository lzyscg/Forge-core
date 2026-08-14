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
    };
    const at = '2026-08-14T10:00:00.000Z';
    const first = registration.buildEvents(payload, at);
    const stamp = (events: readonly (AuthoritativeReviewEventV2 | Omit<AuthoritativeReviewEventV2, 'id'>)[]): AuthoritativeReviewEventV2[] =>
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
      [
        'work_item_leased',
        1,
        {
          family: 'lease_or_retry',
          operationId: 'd44f5f50-0000-4000-8000-000000000000',
          taskId: 'task-1',
          workItemId: 'wi-1',
          leaseEpoch: 1,
          eventBuilder: 'work_item_leased',
          authorityBaseRef: H_REF('authority_base_set', H1),
        },
      ],
      [
        'human_answer',
        1,
        {
          family: 'question',
          operationId: 'e55f5f50-0000-4000-8000-000000000000',
          taskId: 'task-1',
          questionId: 'q-1',
          questionVersion: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          answerDigest: H1,
          authorityBaseRef: H_REF('authority_base_set', H1),
        },
      ],
      [
        'retry_system_command',
        1,
        {
          family: 'recovery',
          operationId: 'f66f5f50-0000-4000-8000-000000000000',
          taskId: 'task-1',
          recipeKey: 'retry_system_command',
          failureRecoveryPayloadRef: H_REF('failure_recovery_payload', H1),
          overrideRef: null,
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
  events: readonly (AuthoritativeReviewEventV2 | Omit<AuthoritativeReviewEventV2, 'id'>)[],
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
        { family: 'domain_publish', operationId: 'op-1', taskId: 't', publishKind: 'map_build_commit', blobRefs: [H_REF('map_build_spec', H2)], expectedResultIdentity: 'x' },
        [H_REF('map_build_spec', H2)],
      ],
      [
        { family: 'lease_or_retry', operationId: 'op-1', taskId: 't', workItemId: 'w', leaseEpoch: 1, eventBuilder: 'work_item_leased', authorityBaseRef: authority },
        [authority],
      ],
      [
        { family: 'lifecycle', operationId: 'op-1', taskId: 't', kind: 'stop', suspensionId: null, workItemId: null },
        [],
      ],
      [
        { family: 'question', operationId: 'op-1', taskId: 't', questionId: 'q', questionVersion: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', answerDigest: H3, authorityBaseRef: authority },
        [authority],
      ],
      [
        { family: 'recovery', operationId: 'op-1', taskId: 't', recipeKey: 'rebuild_missing_work', failureRecoveryPayloadRef: H_REF('failure_recovery_payload', H4), overrideRef: H_REF('round_budget_override', H5) },
        [H_REF('failure_recovery_payload', H4), H_REF('round_budget_override', H5)],
      ],
      [
        { family: 'recovery', operationId: 'op-1', taskId: 't', recipeKey: 'retry_system_command', failureRecoveryPayloadRef: H_REF('failure_recovery_payload', H4), overrideRef: null },
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

  it('exposes exact event-schema identity per registration', () => {
    expect(resolvePublicationIntent('lifecycle/stop', 1)?.expectedEventTypes).toEqual([
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