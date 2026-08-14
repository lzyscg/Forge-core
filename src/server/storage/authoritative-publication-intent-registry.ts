/**
 * Task 8 typed publication intent registry (spec §8, design §19.1).
 *
 * A CLOSED allowlist mapping every registered handler kind/version to exactly
 * one `publication_operation_payload` branch (the frozen
 * `PublicationOperationPayloadV2` union): strict payload parsing, exact
 * event-schema identity, deterministic event-envelope building, payload
 * child-ref extraction and deterministic result identity. Pins persist only
 * { handlerKind, handlerVersion, canonicalOperationPayloadRef,
 * expectedResultIdentity } — never callbacks or Agent text — and startup
 * replay resolves ONLY this allowlist and rebuilds byte-identical events.
 *
 * Resolution rules (all fail closed, never guess):
 * - unknown handler kind or version                                  -> null
 * - payload that does not parse under the closed union               -> throw
 * - parsed payload family != registration family                     -> throw
 * - registered but not rebuildable (payload lacks fields the event   -> NotRebuildableError
 *   needs for byte-identical rebuild) — listed in `missingInputs`
 *
 * The state-only families (lease_or_retry, lifecycle, question, recovery,
 * delete) and the artifact_publish version-allocation family are registered
 * NOW; `rebuildable` entries today are lifecycle stop/resume and
 * artifact_publish. Later tasks (10-22) extend the allowlist through
 * `registerPublicationIntent`, never by runtime payload content.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../structured-slots/canonical-json';
import { parsePublicationOperationPayload } from '../authoritative-review/object-schema-parsers-3';
import type { PublicationOperationPayloadV2 } from '../authoritative-review/authority-types';
import type { AuthoritativeReviewEventV2 } from './authoritative-review-events';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';

/** An event envelope before the facade stamps the deterministic id. */
export type AuthoritativeReviewEventEnvelopeV2 = Omit<AuthoritativeReviewEventV2, 'id'>;

/** The exact closed publication payload families (design §19.1, frozen union). */
export type PublicationPayloadFamilyV2 =
  | 'domain_publish'
  | 'lease_or_retry'
  | 'lifecycle'
  | 'question'
  | 'recovery'
  | 'delete'
  | 'artifact_publish';

/**
 * The pin-persisted publication intent (design §19.1 exact shape). Startup
 * replay resolves handler kind/version against the registry and the payload
 * ref; the expected result identity is re-verified by the deterministic
 * builder.
 */
export interface PublicationIntentV2 {
  handlerKind: string;
  handlerVersion: number;
  canonicalOperationPayloadRef: BlobRefV2;
  expectedResultIdentity: string;
}

/** Typed error: a registered handler cannot rebuild its event byte-identically. */
export class NotRebuildableError extends Error {
  readonly handlerKind: string;

  readonly missingInputs: readonly string[];

  constructor(handlerKind: string, missingInputs: readonly string[]) {
    super(
      `publication handler '${handlerKind}' cannot rebuild its event envelope byte-identically: missing inputs ${missingInputs.join(
        ', ',
      )}`,
    );
    this.name = 'NotRebuildableError';
    this.handlerKind = handlerKind;
    this.missingInputs = missingInputs;
  }
}

/** A ref the builder needs resolved from the pin's prepared refs, keyed by name. */
export interface PublicationIntentResolvedRef {
  key: string;
  ref: BlobRefV2;
}

/** Build context for deterministic event-envelope construction. */
/**
 * One closed registration: handler kind/version -> exactly one payload family
 * and one event schema. `buildEvents` is a pure deterministic function of the
 * payload (and pinned refs) — the same inputs always produce the same event
 * bytes, which is what makes crashed-pin replay byte-identical.
 */
export interface PublicationIntentRegistrationV2 {
  handlerKind: string;
  handlerVersion: number;
  payloadFamily: PublicationPayloadFamilyV2;
  /** Exact event types the builder may produce; anything else fails closed. */
  expectedEventTypes: readonly string[];
  /** True when `buildEvents` can rebuild byte-identically from the payload. */
  rebuildable: boolean;
  /** Why a non-rebuildable handler cannot rebuild (for diagnostics). */
  missingInputs: readonly string[];
  /** Strict closed-union payload parser. */
  parsePayload(value: unknown): PublicationOperationPayloadV2;
  /** Child refs of the publication payload itself (exact per family). */
  childRefsOf(payload: PublicationOperationPayloadV2): readonly BlobRefV2[];
  /** Pin refs the builder needs resolved (subset of the prepared refs). */
  resolveRefs(payload: PublicationOperationPayloadV2): readonly PublicationIntentResolvedRef[];
  /**
   * Deterministic event-envelope construction. `at` is the pin-frozen event
   * timestamp; `refs` are the pin refs resolved by `resolveRefs` (some
   * builders derive event fields from pinned blob content). Envelopes carry
   * `at` but no `id` — the facade stamps ids via `deterministicEventId`, so a
   * crashed pin replays the exact bytes the original committer produced.
   * Throws `NotRebuildableError` when the payload cannot be rebuilt.
   */
  buildEvents(
    payload: PublicationOperationPayloadV2,
    at: string,
    refs?: ReadonlyMap<string, unknown>,
  ): readonly AuthoritativeReviewEventEnvelopeV2[];
  /** Deterministic identity of the committed result (events INCLUDING ids). */
  expectedResultIdentity(
    payload: PublicationOperationPayloadV2,
    events: readonly AuthoritativeReviewEventV2[],
  ): string;
}

/**
 * Deterministic filename-safe event id (spec §9.1): function of operation
 * identity + handler + index only, so a crashed pin replays the exact bytes
 * the original committer would have produced. `evt-` + 32 hex chars.
 */
export function deterministicEventId(operationId: string, handlerKind: string, index: number): string {
  const digest = createHash('sha256')
    .update(canonicalJson({ handlerKind, operationId, index }), 'utf8')
    .digest('hex');
  return `evt-${digest.slice(0, 32)}`;
}

function sha256OfEvents(events: readonly AuthoritativeReviewEventV2[]): string {
  return createHash('sha256').update(canonicalJson(events), 'utf8').digest('hex');
}

/** Strict child-ref extraction of a publication payload (all 7 families). */
export function publicationPayloadChildRefs(payload: PublicationOperationPayloadV2): readonly BlobRefV2[] {
  // Strict closed-union parse first: unparseable values never get guessed.
  const parsed = parsePublicationOperationPayload(payload);
  switch (parsed.family) {
    case 'domain_publish':
      return [...parsed.blobRefs];
    case 'lease_or_retry':
      return [parsed.authorityBaseRef];
    case 'lifecycle':
      return [];
    case 'question':
      return [parsed.authorityBaseRef];
    case 'recovery': {
      const refs: BlobRefV2[] = [parsed.failureRecoveryPayloadRef];
      if (parsed.overrideRef !== null) {
        refs.push(parsed.overrideRef);
      }
      return refs;
    }
    case 'delete':
      return [];
    case 'artifact_publish':
      return [parsed.artifactRef, parsed.sealRecordRef, parsed.deliveryRef];
  }
}

/**
 * The closed registry. Later tasks add handlers through `register`; the
 * module-level singleton (`PUBLICATION_INTENT_REGISTRY_V2`) is the runtime
 * allowlist, and fresh instances are for tests/qualification.
 */
export class PublicationIntentRegistry {
  private readonly registrations = new Map<string, PublicationIntentRegistrationV2>();

  constructor() {
    this.seedBuiltins();
  }

  private seedBuiltins(): void {
    this.seedLifecycle();
    this.seedLeaseOrRetry();
    this.seedQuestion();
    this.seedRecovery();
    this.seedDelete();
    this.seedArtifactPublish();
  }

  /** Explicit registration API: duplicate handler kind/version is a program error. */
  register(registration: PublicationIntentRegistrationV2): void {
    const key = `${registration.handlerKind}@${registration.handlerVersion}`;
    if (this.registrations.has(key)) {
      throw new Error(
        `publication intent handler '${registration.handlerKind}' v${registration.handlerVersion} is already registered`,
      );
    }
    this.registrations.set(key, registration);
  }

  /** Allowlist-only resolution; null for unknown kind/version. */
  resolve(handlerKind: string, handlerVersion: number): PublicationIntentRegistrationV2 | null {
    return this.registrations.get(`${handlerKind}@${handlerVersion}`) ?? null;
  }

  private seedLifecycle(): void {
    const family: PublicationPayloadFamilyV2 = 'lifecycle';
    const childRefs = (): readonly BlobRefV2[] => [];
    const resolveRefs = (): readonly PublicationIntentResolvedRef[] => [];
    this.register({
      handlerKind: 'lifecycle/stop',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: ['structured_task_suspension_applied_v2'],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
      resolveRefs,
      buildEvents: (payload, at) => {
        const p = payload as Extract<PublicationOperationPayloadV2, { family: 'lifecycle' }>;
        if (p.suspensionId === null) {
          throw new NotRebuildableError('lifecycle/stop', [
            'suspensionId must name the suspension for byte-identical rebuild',
          ]);
        }
        if (p.kind !== 'stop') {
          throw new NotRebuildableError('lifecycle/stop', [`payload kind '${p.kind}' is not stop`]);
        }
        return [
          {
            protocolVersion: 2,
            at,
            type: 'structured_task_suspension_applied_v2',
            suspensionId: p.suspensionId,
            reason: 'user_stop',
            operationId: p.operationId,
          },
        ];
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });
    this.register({
      handlerKind: 'lifecycle/resume',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: ['structured_task_suspension_cleared_v2'],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, childRefs),
      resolveRefs,
      buildEvents: (payload, at) => {
        const p = payload as Extract<PublicationOperationPayloadV2, { family: 'lifecycle' }>;
        if (p.suspensionId === null) {
          throw new NotRebuildableError('lifecycle/resume', [
            'suspensionId must name the suspension for byte-identical rebuild',
          ]);
        }
        if (p.kind !== 'resume') {
          throw new NotRebuildableError('lifecycle/resume', [`payload kind '${p.kind}' is not resume`]);
        }
        return [
          {
            protocolVersion: 2,
            at,
            type: 'structured_task_suspension_cleared_v2',
            suspensionId: p.suspensionId,
            operationId: p.operationId,
          },
        ];
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });
  }

  private seedLeaseOrRetry(): void {
    const family: PublicationPayloadFamilyV2 = 'lease_or_retry';
    const builders = ['work_item_leased', 'work_item_requeued', 'work_item_lease_reclaimed'] as const;
    for (const builder of builders) {
      this.register({
        handlerKind: builder === 'work_item_leased' ? 'work_item_leased' : builder === 'work_item_requeued' ? 'work_item_requeued' : 'work_item_lease_reclaimed',
        handlerVersion: 1,
        payloadFamily: family,
        expectedEventTypes: [builder === 'work_item_leased' ? 'structured_work_item_leased' : builder === 'work_item_requeued' ? 'structured_work_item_requeued' : 'structured_work_item_lease_reclaimed'],
        rebuildable: false,
        missingInputs:
          builder === 'work_item_lease_reclaimed'
            ? ['reason is not carried by the frozen lease_or_retry payload']
            : ['leaseOwner/leaseExpiresAt/expectedLastSequence are runtime lease facts absent from the frozen payload'],
        parsePayload: parsePublicationOperationPayload,
        childRefsOf: (p) => childRefsOfChecked(p, family, (parsed) =>
          parsed.family === 'lease_or_retry' ? [parsed.authorityBaseRef] : [],
        ),
        resolveRefs: (p) =>
          p.family === 'lease_or_retry' ? [{ key: 'authorityBase', ref: p.authorityBaseRef }] : [],
        buildEvents: () => {
          throw new NotRebuildableError(handlerKindForLease(builder), [
            builder === 'work_item_lease_reclaimed' ? 'reason' : 'leaseOwner, leaseExpiresAt, expectedLastSequence',
          ]);
        },
        expectedResultIdentity: () => {
          throw new NotRebuildableError(handlerKindForLease(builder), ['not rebuildable']);
        },
      });
    }
  }

  private seedQuestion(): void {
    const family: PublicationPayloadFamilyV2 = 'question';
    this.register({
      handlerKind: 'human_answer',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: ['structured_human_answer_delivered_v2'],
      rebuildable: false,
      missingInputs: [
        'originalWorkItemId/replacementWorkItemId/logicalAssignmentId/deliveryId are state facts absent from the frozen question payload',
      ],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) =>
        childRefsOfChecked(p, family, (parsed) =>
          parsed.family === 'question' ? [parsed.authorityBaseRef] : [],
        ),
      resolveRefs: (p) => (p.family === 'question' ? [{ key: 'authorityBase', ref: p.authorityBaseRef }] : []),
      buildEvents: () => {
        throw new NotRebuildableError('human_answer', [
          'originalWorkItemId, replacementWorkItemId, logicalAssignmentId, deliveryId',
        ]);
      },
      expectedResultIdentity: () => {
        throw new NotRebuildableError('human_answer', ['not rebuildable']);
      },
    });
  }

  private seedRecovery(): void {
    const family: PublicationPayloadFamilyV2 = 'recovery';
    for (const recipeKey of [
      'retry_system_command',
      'restart_map_review_cycle',
      'restart_content_review_cycle',
      'rebuild_missing_work',
    ] as const) {
      this.register({
        handlerKind: recipeKey,
        handlerVersion: 1,
        payloadFamily: family,
        expectedEventTypes: ['structured_task_reopened_v2'],
        rebuildable: false,
        missingInputs: [
          'operatorId and reason are operator-owned reopen facts absent from the frozen recovery payload',
        ],
        parsePayload: parsePublicationOperationPayload,
        childRefsOf: (p) =>
          childRefsOfChecked(p, family, (parsed) => {
            if (parsed.family !== 'recovery') return [];
            const refs: BlobRefV2[] = [parsed.failureRecoveryPayloadRef];
            if (parsed.overrideRef !== null) refs.push(parsed.overrideRef);
            return refs;
          }),
        resolveRefs: (p) => {
          if (p.family !== 'recovery') return [];
          const out: PublicationIntentResolvedRef[] = [
            { key: 'failureRecoveryPayload', ref: p.failureRecoveryPayloadRef },
          ];
          if (p.overrideRef !== null) out.push({ key: 'override', ref: p.overrideRef });
          return out;
        },
        buildEvents: () => {
          throw new NotRebuildableError(recipeKey, ['operatorId', 'reason']);
        },
        expectedResultIdentity: () => {
          throw new NotRebuildableError(recipeKey, ['not rebuildable']);
        },
      });
    }
  }

  private seedDelete(): void {
    const family: PublicationPayloadFamilyV2 = 'delete';
    this.register({
      handlerKind: 'task_delete',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: [],
      rebuildable: false,
      missingInputs: ['the delete tombstone is a task-index record, not a v2 event (Task 11)'],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) => childRefsOfChecked(p, family, () => []),
      resolveRefs: () => [],
      buildEvents: () => {
        throw new NotRebuildableError('task_delete', ['delete produces no v2 event (tombstone lives in the task index)']);
      },
      expectedResultIdentity: () => {
        throw new NotRebuildableError('task_delete', ['not rebuildable']);
      },
    });
  }

  private seedArtifactPublish(): void {
    const family: PublicationPayloadFamilyV2 = 'artifact_publish';
    this.register({
      handlerKind: 'artifact_publish',
      handlerVersion: 1,
      payloadFamily: family,
      expectedEventTypes: ['artifact_published_v2'],
      rebuildable: true,
      missingInputs: [],
      parsePayload: parsePublicationOperationPayload,
      childRefsOf: (p) =>
        childRefsOfChecked(p, family, (parsed) =>
          parsed.family === 'artifact_publish'
            ? [parsed.artifactRef, parsed.sealRecordRef, parsed.deliveryRef]
            : [],
        ),
      resolveRefs: (p) => {
        if (p.family !== 'artifact_publish') return [];
        return [
          { key: 'delivery', ref: p.deliveryRef },
          { key: 'sealRecord', ref: p.sealRecordRef },
          { key: 'artifact', ref: p.artifactRef },
        ];
      },
      buildEvents: (payload, at, refs) => {
        const p = payload as Extract<PublicationOperationPayloadV2, { family: 'artifact_publish' }>;
        const delivery = refs?.get('delivery') as
          | { submitterWorkItemId: string; custodyRef: BlobRefV2; artifactId: string }
          | undefined;
        const artifact = refs?.get('artifact') as
          | { artifactId: string; mediaType: 'text/markdown' | 'text/plain' }
          | undefined;
        if (delivery === undefined || artifact === undefined) {
          throw new NotRebuildableError('artifact_publish', [
            'deliveryRef/artifactRef blobs must resolve before the event envelope can be rebuilt',
          ]);
        }
        const extension = artifact.mediaType === 'text/markdown' ? 'md' : 'txt';
        return [
          {
            protocolVersion: 2,
            at,
            type: 'artifact_published_v2',
            artifactId: artifact.artifactId,
            artifactVersion: p.expectedArtifactVersion,
            deliveryRef: p.deliveryRef,
            files: [{ name: `${artifact.artifactId}.${extension}`, hash: p.artifactRef.digest }],
            mediaType: artifact.mediaType,
            provenance: {
              producerKind: 'system',
              producerWorkItemId: delivery.submitterWorkItemId,
              sealRecordRef: p.sealRecordRef,
              artifactRef: p.artifactRef,
              custodyRef: delivery.custodyRef,
            },
          },
        ];
      },
      expectedResultIdentity: (_payload, events) => sha256OfEvents(events),
    });
  }
}

function handlerKindForLease(builder: 'work_item_leased' | 'work_item_requeued' | 'work_item_lease_reclaimed'): string {
  return builder;
}

function childRefsOfChecked(
  payload: PublicationOperationPayloadV2,
  family: PublicationPayloadFamilyV2,
  extract: (parsed: PublicationOperationPayloadV2) => readonly BlobRefV2[],
): readonly BlobRefV2[] {
  // Strict parse: wrong family or unparseable values fail closed with a
  // SchemaError instead of being guessed.
  const parsed = parsePublicationOperationPayload(payload);
  if (parsed.family !== family) {
    throw new Error(`publication payload family '${parsed.family}' does not match registration family '${family}'`);
  }
  return extract(parsed);
}

/** The module-level runtime allowlist (resolved by the facade and recovery). */
export const PUBLICATION_INTENT_REGISTRY_V2 = new PublicationIntentRegistry();

/** Duplicate registration on the runtime allowlist is a program error. */
export function registerPublicationIntent(registration: PublicationIntentRegistrationV2): void {
  PUBLICATION_INTENT_REGISTRY_V2.register(registration);
}

/** Allowlist-only runtime resolution; null for unknown handler kind/version. */
export function resolvePublicationIntent(
  handlerKind: string,
  handlerVersion: number,
): PublicationIntentRegistrationV2 | null {
  return PUBLICATION_INTENT_REGISTRY_V2.resolve(handlerKind, handlerVersion);
}