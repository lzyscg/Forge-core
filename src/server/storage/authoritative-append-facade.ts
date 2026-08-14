/**
 * Task 8 authoritative append facade (spec §8/§8.1, design §19.1): the SOLE
 * path that commits AuthoritativeReviewEventV2 batches.
 *
 * `publishWithPin` implements put-before-append: a durable PublicationPin is
 * created FIRST (idempotent per operation, PIN_CONFLICT on different payload),
 * the payload and prepared blobs are durably written with parent-directory
 * fsync and a creation-generation sidecar, then — under the data-root store
 * lock — the on-disk tail is reloaded (never an instance cache), the
 * operation/refs/tail/pin are re-verified, the registered intent rebuilds the
 * deterministic event envelope, `appendBatch` runs with a live fence proof,
 * the committed tail is re-read, and the generation/fence record is durably
 * advanced before the lock releases. The pin is only cleaned after the
 * durable commit; response-loss replay returns the committed result.
 *
 * Startup recovery (startupRecovery) resolves every pin: committed pins are
 * cleaned after ref verification; legal uncommitted pins replay ONLY from a
 * registered, rebuildable intent whose payload parses under the closed union
 * with matching family and whose expected tail/authority still holds; every
 * expired illegal pin is abandoned (quarantined for at least one GC
 * generation) — never guessed.
 *
 * All v2 mutations flow through this facade; a raw EventStore.appendBatch
 * with v2 members is rejected at the store level without a live fence proof.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CorePaths } from './core-paths';
import type { EventStore, CommittedEvent } from './event-store';
import type { AuthoritativeReviewBlobStore } from './authoritative-review-blob-store';
import type { AuthoritativeReviewProfile, PublicationOperationPayloadV2 } from '../authoritative-review/authority-types';
import type { AuthoritativeBlobKindV2, BlobRefV2 } from '../../shared/authoritative-review-v2';
import { STORAGE_ERROR_CODES, StorageError, writeNewAtomicDurable } from './atomic-file';
import { canonicalJson, canonicalJsonBytesAndSha256 } from '../structured-slots/canonical-json';
import {
  assertNoSelfReference,
  isRegisteredKind,
  maxBytesForBlob,
  mediaTypeOf,
  parseBlob,
  schemaVersionOf,
} from '../authoritative-review/object-registry';
import { SchemaError } from '../authoritative-review/authority-types';
import type { AuthoritativePublicationStore, PublicationPinV2, LockHold } from './authoritative-publication-store';
import {
  PUBLICATION_INTENT_REGISTRY_V2,
  PublicationIntentRegistry,
  deterministicEventId,
  type PublicationIntentRegistrationV2,
} from './authoritative-publication-intent-registry';
import { parsePublicationOperationPayload } from '../authoritative-review/object-schema-parsers-3';
import type { AuthoritativeReviewEventV2 } from './authoritative-review-events';
import type { TaskEvent } from './task-events';
import { validateTaskEvent } from './task-events';

/** The pin intent a caller declares; the facade derives and verifies the rest. */
export interface DeclaredPublicationIntentV2 {
  handlerKind: string;
  handlerVersion: number;
  /**
   * Declared deterministic result identity. For rebuildable handlers the
   * facade REPLACES it with the registry-computed identity (a mismatching
   * declaration is a fail-closed error); for non-rebuildable handlers the
   * declared value is recorded as-is (the pin can never legally replay).
   */
  expectedResultIdentity?: string;
}

export interface PublishWithPinInput {
  taskId: string;
  /** Stable operation/commit id — response-loss replay keys on it. */
  operationId: string;
  /** Canonical publication_operation_payload object (strictly parseable). */
  payload: unknown;
  intent: DeclaredPublicationIntentV2;
  /** Result blobs prepared via `prepareBlob` (empty for state-only). */
  preparedRefs?: readonly BlobRefV2[];
  expectedTailSequence: number;
  expectedTailCommitId: string | null;
}

export interface PreparedPublication {
  pin: PublicationPinV2;
  payloadRef: BlobRefV2;
}

export interface PublishedV2Result {
  events: CommittedEvent[];
  pinId: string;
  generation: number;
}

export interface RecoverySummary {
  /** Pins of committed operations cleaned after ref verification. */
  cleaned: string[];
  /** Legal uncommitted pins resumed to a byte-identical commit. */
  resumed: string[];
  /** Expired illegal pins abandoned (no guessing). */
  abandoned: string[];
}

export interface AppendFacadeOptions {
  eventStore: EventStore;
  blobStore: AuthoritativeReviewBlobStore;
  publicationStore: AuthoritativePublicationStore;
  /** The task-bound frozen profile (max-bytes enforcement on the durable put). */
  profile: AuthoritativeReviewProfile;
  /** Data-root paths (durable blob addresses + task roots). */
  paths: CorePaths;
  /** The closed intent allowlist (defaults to the module-level registry). */
  registry?: PublicationIntentRegistry;
  /** Injectable wall clock (ISO 8601) for pin TTL/lease freezing. */
  clock?: () => string;
  /** Frozen prepare TTL (default 24 h). */
  prepareTtlMs?: number;
  /** Owner lease window (default 10 min). */
  ownerLeaseMs?: number;
}

function invalidInput(message: string): StorageError {
  return new StorageError(STORAGE_ERROR_CODES.INVALID_INPUT, message, null, '修正结构化载荷后重试。');
}

function corrupt(message: string): StorageError {
  return new StorageError(STORAGE_ERROR_CODES.TASK_CORRUPTED, message, null, '修复或重建该任务。');
}

export class AuthoritativeAppendFacadeV2 {
  private readonly eventStore: EventStore;

  private readonly blobStore: AuthoritativeReviewBlobStore;

  private readonly publicationStore: AuthoritativePublicationStore;

  private readonly paths: CorePaths;

  private readonly profile: AuthoritativeReviewProfile;

  private readonly registry: PublicationIntentRegistry;

  private readonly clock: () => string;

  private readonly prepareTtlMs: number;

  private readonly ownerLeaseMs: number;

  constructor(options: AppendFacadeOptions) {
    this.eventStore = options.eventStore;
    this.blobStore = options.blobStore;
    this.publicationStore = options.publicationStore;
    this.profile = options.profile;
    this.paths = options.paths;
    this.registry = options.registry ?? PUBLICATION_INTENT_REGISTRY_V2;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.prepareTtlMs = options.prepareTtlMs ?? 24 * 60 * 60 * 1000;
    this.ownerLeaseMs = options.ownerLeaseMs ?? 10 * 60 * 1000;
  }

  /**
   * Durable v2 blob put under a pin (spec §8 step 2): canonicalize, validate
   * against the registry, atomically rename, fsync the file AND its parent
   * directory, and record the creation-generation sidecar so GC excludes
   * objects newer than its mark-start generation. Same-address bytes must be
   * exact or the task is corrupt. The Task 6 blob store path is untouched.
   */
  async prepareBlob<K extends AuthoritativeBlobKindV2>(
    taskId: string,
    kind: K,
    value: unknown,
  ): Promise<BlobRefV2> {
    if (!isRegisteredKind(kind)) {
      throw invalidInput(`未注册的 v2 blob kind '${kind}'。`);
    }
    const max = maxBytesForBlob(kind, this.profile);
    let bytes: Buffer;
    let sha256: string;
    try {
      ({ bytes, sha256 } = canonicalJsonBytesAndSha256(value));
    } catch (error) {
      throw invalidInput(`v2 blob ${kind} 载荷不可规范化: ${(error as Error).message}`);
    }
    if (bytes.length > max) {
      throw invalidInput(`v2 blob ${kind} 超出该任务 profile 的大小上限 (${bytes.length} > ${max} 字节)。`);
    }
    let stored: BlobRefV2;
    try {
      const pending: BlobRefV2 = {
        kind,
        digest: sha256,
        byteLength: bytes.length,
        mediaType: mediaTypeOf(kind),
        schemaVersion: schemaVersionOf(kind),
      };
      const parsed = parseBlob(kind, value, pending);
      assertNoSelfReference(kind, value);
      stored = parsed.ref;
    } catch (error) {
      if (error instanceof SchemaError) {
        throw invalidInput(`v2 blob ${kind} 校验失败: ${(error as Error).message}`);
      }
      throw error;
    }
    const destination = this.paths.taskStructuredV2BlobFile(taskId, kind, stored.digest);
    try {
      await writeNewAtomicDurable(destination, bytes);
    } catch (error) {
      if ((error as StorageError).code === STORAGE_ERROR_CODES.FILE_EXISTS) {
        await this.assertSameAddressBytes(destination, bytes, kind);
      } else {
        throw error;
      }
    }
    await this.recordBlobGeneration(destination, stored);
    return stored;
  }

  private async assertSameAddressBytes(
    path: string,
    bytes: Buffer,
    kind: AuthoritativeBlobKindV2,
  ): Promise<void> {
    let existing: Buffer;
    try {
      existing = await readFile(path);
    } catch {
      throw corrupt(`v2 blob ${kind} 同一摘要地址的既有文件不可读，任务已损坏。`);
    }
    if (!existing.equals(bytes)) {
      throw corrupt(`v2 blob ${kind} 同一摘要地址存在不同字节，任务已损坏。`);
    }
  }

  /** The `.gen.json` sidecar: creation generation, written durably once. */
  private async recordBlobGeneration(blobFile: string, ref: BlobRefV2): Promise<void> {
    const sidecar = `${blobFile}.gen.json`;
    const generation = await this.publicationStore.readGeneration();
    try {
      await writeNewAtomicDurable(
        sidecar,
        Buffer.from(JSON.stringify({ generation, kind: ref.kind, digest: ref.digest }), 'utf8'),
      );
    } catch (error) {
      if ((error as StorageError).code !== STORAGE_ERROR_CODES.FILE_EXISTS) {
        throw error;
      }
    }
  }

  /**
   * Put phase (spec §8 steps 1-2): durable pin, durable payload put, prepared
   * refs present on disk. The operation may then crash; startup recovery or a
   * later publishWithPin resumes from the pin.
   */
  async preparePublication(input: PublishWithPinInput): Promise<PreparedPublication> {
    if (input.operationId.length === 0) {
      throw invalidInput('operationId 不能为空。');
    }
    const registration = this.registry.resolve(input.intent.handlerKind, input.intent.handlerVersion);
    if (registration === null) {
      throw new StorageError(
        STORAGE_ERROR_CODES.EVENT_INVALID,
        `未注册的 publication handler '${input.intent.handlerKind}' v${input.intent.handlerVersion}。`,
        null,
        '使用注册的 handler kind/version。',
      );
    }
    const now = this.clock();
    // 1. pin FIRST: derived payload ref. The deterministic result identity is
    //    computed (and durably back-filled) by the commit under the lock; an
    //    explicitly declared value is recorded and verified there instead.
    const payloadRef = await this.computePayloadRef(input.payload);
    const pin = await this.publicationStore.createPin({
      taskId: input.taskId,
      operationId: input.operationId,
      expectedTailSequence: input.expectedTailSequence,
      expectedTailCommitId: input.expectedTailCommitId,
      blobRefs: input.preparedRefs ?? [],
      gcGeneration: await this.publicationStore.readGeneration(),
      createdAtServer: now,
      ownerEpoch: 0,
      intent: {
        handlerKind: input.intent.handlerKind,
        handlerVersion: input.intent.handlerVersion,
        canonicalOperationPayloadRef: payloadRef,
        expectedResultIdentity: input.intent.expectedResultIdentity ?? '',
      },
      state: 'active',
      abandonedGeneration: null,
      prepareExpiresAt: new Date(new Date(now).getTime() + this.prepareTtlMs).toISOString(),
      ownerLeaseExpiresAt: new Date(new Date(now).getTime() + this.ownerLeaseMs).toISOString(),
      // Creator identity stamped at PREPARE (Finding 6): liveness of an
      // uncommitted pin is proven by its creator, never by wall clock alone —
      // even before any lock hold attributes an epoch to the pin.
      ownerPid: this.publicationStore.lock().ownerPidOf(),
      ownerProcessStartToken: this.publicationStore.lock().sessionToken(),
      ownerProcessStartTime: this.publicationStore.lock().processStartTimeOfSelf(),
    });
    // 2. durable payload put, then every prepared result blob verified present.
    await this.prepareBlob(input.taskId, 'publication_operation_payload', input.payload);
    await this.verifyPreparedRefsPresent(input.taskId, pin);
    return { pin, payloadRef };
  }

  /**
   * Locked commit phase (spec §8.1 steps 1-5) for an already-prepared pin.
   * The pin is intentionally NOT cleaned here — publishWithPin and startup
   * recovery own that transition, which is what makes the crash matrix
   * deterministic. Idempotent: an already committed operation replays its
   * committed result.
   */
  async commitPrepared(pinId: string): Promise<PublishedV2Result> {
    const pin = await this.publicationStore.readPin(pinId);
    if (pin === null) {
      throw new StorageError(STORAGE_ERROR_CODES.EVENT_INVALID, '该 pin 不存在或已被清理。', null, '重新发表该操作。');
    }
    // Response-loss replay: the operation may already be committed. Different
    // payloads under one operation id conflict even after the original pin
    // was cleaned (the committed event bytes must be re-derivable).
    const committed = await this.eventStore.readBatchByCommitId(pin.taskId, pin.operationId);
    if (committed !== null) {
      // Committed operations need ref verification + pin cleanup; the
      // commitId+digest idempotency at the store level already guards the
      // envelope bytes. Structural re-derivation applies only to rebuildable
      // handlers (a MISSING blob here is TASK_CORRUPTED, never a conflict).
      await this.verifyPreparedRefsPresent(pin.taskId, pin);
      await this.verifyReplayMatches(pin, committed);
      await this.publicationStore.markPinCommittedAndRemove(pinId);
      return { events: committed, pinId, generation: await this.publicationStore.readGeneration() };
    }
    return this.commitWithHold(pinId);
  }

  /**
   * Locked commit with a bounded idempotent retry: a transient superseded
   * hold (LOCK_SUPERSEDED — the mkdir-lock exchange raced) loses nothing —
   * the operation was not committed, so a fresh hold simply re-runs the same
   * deterministic CAS. Convergence is guaranteed by the fence/CAS, never by
   * last-writer-wins.
   */
  private async commitWithHold(pinId: string): Promise<PublishedV2Result> {
    const pin = await this.publicationStore.readPin(pinId);
    if (pin === null) {
      throw new StorageError(STORAGE_ERROR_CODES.EVENT_INVALID, '该 pin 不存在或已被清理。', null, '重新发表该操作。');
    }
    for (let attempt = 0; ; attempt += 1) {
      const hold = await this.publicationStore.lock().acquire();
      try {
        return await this.commitUnderLock(pin, hold);
      } catch (error) {
        if (attempt < 2 && (error as StorageError).code === STORAGE_ERROR_CODES.LOCK_SUPERSEDED) {
          // Transient: our hold's fence record was superseded before we
          // appended. Retry idempotently — no appends happened under the
          // superseded hold.
          continue;
        }
        throw error;
      } finally {
        await hold.release();
      }
    }
  }

  private async commitUnderLock(pin: PublicationPinV2, hold: LockHold): Promise<PublishedV2Result> {
    // 0. idempotent replay first (inside the lock): if another instance
    //    committed this operation while we waited, return its committed
    //    result — the pin only needs structural verification, never a CAS.
    const committedNow = await this.eventStore.readBatchByCommitId(pin.taskId, pin.operationId);
    if (committedNow !== null) {
      await this.verifyPreparedRefsPresent(pin.taskId, pin);
      await this.verifyReplayMatches(pin, committedNow);
      await this.publicationStore.markPinCommittedAndRemove(pin.pinId);
      return { events: committedNow, pinId: pin.pinId, generation: await this.publicationStore.readGeneration() };
    }
    // 1. reload the tail from disk — never an instance cache.
    const tail = await this.eventStore.tail(pin.taskId);
    if (tail.lastSequence !== pin.expectedTailSequence || tail.lastCommitId !== pin.expectedTailCommitId) {
      throw new StorageError(
        STORAGE_ERROR_CODES.EXPECTED_SEQUENCE_MISMATCH,
        '预期尾部与当前已提交序列不一致。',
        null,
        '刷新最新状态后重试。',
      );
    }
    // 2a. re-read the pin: another instance may have committed and cleaned it.
    const current = await this.publicationStore.readPin(pin.pinId);
    if (current === null || current.state !== 'active') {
      const committed = await this.eventStore.readBatchByCommitId(pin.taskId, pin.operationId);
      if (committed !== null) {
        await this.verifyReplayMatches(pin, committed);
        return { events: committed, pinId: pin.pinId, generation: await this.publicationStore.readGeneration() };
      }
      throw new StorageError(STORAGE_ERROR_CODES.EVENT_INVALID, 'pin 在加锁期间失效。', null, '重新发表该操作。');
    }
    // 2b. strict intent resolution: registered, same payload family, payload parses.
    const registration = this.registry.resolve(current.intent.handlerKind, current.intent.handlerVersion);
    if (registration === null) {
      throw new StorageError(
        STORAGE_ERROR_CODES.EVENT_INVALID,
        `pin 携带未注册的 publication handler '${current.intent.handlerKind}'。`,
        null,
        '该 pin 无法合法重建。',
      );
    }
    let parsed: PublicationOperationPayloadV2;
    try {
      parsed = registration.parsePayload(
        (await this.blobStore.readJson(
          current.taskId,
          current.intent.canonicalOperationPayloadRef,
          'publication_operation_payload',
        )) as PublicationOperationPayloadV2,
      );
    } catch (error) {
      if (error instanceof SchemaError || (error as { code?: string }).code === STORAGE_ERROR_CODES.TASK_CORRUPTED) {
        throw new StorageError(STORAGE_ERROR_CODES.EVENT_INVALID, `pin payload 校验失败: ${(error as Error).message}`, null, '该 pin 无法合法重建。');
      }
      throw error;
    }
    if (parsed.family !== registration.payloadFamily) {
      throw new StorageError(
        STORAGE_ERROR_CODES.EVENT_INVALID,
        `payload family '${parsed.family}' 与 handler '${registration.handlerKind}' 注册 family '${registration.payloadFamily}' 不一致。`,
        null,
        '该 pin 无法合法重建。',
      );
    }
    // 3. every referenced BlobRef must resolve exactly (byte-length + parse).
    await this.verifyPreparedRefsPresent(current.taskId, current);
    // 4. artifact version allocation from the fresh combined v1/v2 history.
    if (registration.payloadFamily === 'artifact_publish') {
      await this.assertArtifactVersionFree(current.taskId, parsed);
    }
    // 5. deterministic envelope rebuild + exact schema/identity verification.
    const events = await this.buildAndVerifyEnvelope(registration, current, parsed);
    // 6. owner stamp: attribute this lock hold to the pin (durable replace).
    if (current.ownerEpoch !== hold.epoch) {
      await this.stampPinOwner(current, hold);
    }
    // 7. appendBatch with the live fence proof + audit pin id.
    const proof = await hold.proof();
    const appended = await this.eventStore.appendBatch(current.taskId, current.operationId, events, {
      expectedLastSequence: tail.lastSequence,
      fenceProof: proof,
      publicationPinId: current.pinId,
    });
    // 8. re-read the committed tail, then durably advance the generation and
    //    fence record before releasing the lock (spec §8.1 steps 4-5).
    const after = await this.eventStore.tail(current.taskId);
    if (after.lastSequence !== tail.lastSequence + events.length || after.lastCommitId !== current.operationId) {
      throw corrupt('追加后的尾部与本次提交不一致。');
    }
    const generation = await this.publicationStore.advanceGeneration(hold);
    return { events: appended, pinId: current.pinId, generation };
  }

  private async buildAndVerifyEnvelope(
    registration: PublicationIntentRegistrationV2,
    pin: PublicationPinV2,
    parsed: PublicationOperationPayloadV2,
  ): Promise<AuthoritativeReviewEventV2[]> {
    const refs = new Map<string, unknown>();
    for (const resolved of registration.resolveRefs(parsed)) {
      const object = await this.blobStore.readJson(pin.taskId, resolved.ref, resolved.ref.kind);
      refs.set(resolved.key, object);
    }
    let envelopes;
    try {
      envelopes = registration.buildEvents(parsed, pin.createdAtServer, refs);
    } catch (error) {
      if (error instanceof Error && error.name === 'NotRebuildableError') {
        throw new StorageError(
          STORAGE_ERROR_CODES.EVENT_INVALID,
          `pin 无法字节一致重建事件: ${error.message}`,
          null,
          '该 pin 无法合法重建。',
        );
      }
      throw error;
    }
    const expected = new Set(registration.expectedEventTypes);
    if (envelopes.length === 0 || envelopes.some((envelope) => !expected.has(envelope.type))) {
      throw new StorageError(
        STORAGE_ERROR_CODES.EVENT_INVALID,
        '重建的事件类型与注册的 schema 身份不一致。',
        null,
        '该 pin 无法合法重建。',
      );
    }
    const events: AuthoritativeReviewEventV2[] = envelopes.map((envelope, index) => {
      // Task 11: a v2 atomic batch may carry LEGACY companion events
      // (task_started/task_stopped/human_requested/human_answered — §17.2/17.3
      // display + lifecycle companions). The id stamp is deterministic for
      // every envelope; validateTaskEvent covers both unions fail-closed.
      const withId = {
        ...envelope,
        id: deterministicEventId(pin.operationId, registration.handlerKind, index),
      } as TaskEvent;
      validateTaskEvent(withId); // fail closed: envelopes must validate
      return withId as AuthoritativeReviewEventV2;
    });
    const computedIdentity = registration.expectedResultIdentity(parsed, events);
    if (pin.intent.expectedResultIdentity !== '' && pin.intent.expectedResultIdentity !== computedIdentity) {
      throw new StorageError(
        STORAGE_ERROR_CODES.EVENT_INVALID,
        'pin 记录的结果身份与重建结果不一致。',
        null,
        '该 pin 无法合法重建。',
      );
    }
    if (pin.intent.expectedResultIdentity === '') {
      await this.publicationStore.rewritePinIdentity(pin.pinId, computedIdentity);
    }
    return events;
  }

  private async stampPinOwner(pin: PublicationPinV2, hold: LockHold): Promise<void> {
    await this.publicationStore.rewritePinOwner(pin.pinId, hold.epoch, this.clock(), this.ownerLeaseMs);
  }

  private async assertArtifactVersionFree(
    taskId: string,
    parsed: PublicationOperationPayloadV2,
  ): Promise<void> {
    if (parsed.family !== 'artifact_publish') return;
    const expected = parsed.expectedArtifactVersion;
    const max = await this.currentMaxArtifactVersion(taskId);
    if (expected <= max) {
      throw new StorageError(
        STORAGE_ERROR_CODES.ARTIFACT_VERSION_CONFLICT,
        `artifact version ${expected} 已被占用 (当前最大 ${max})。`,
        null,
        '选择下一个可用版本。',
      );
    }
  }

  private async currentMaxArtifactVersion(taskId: string): Promise<number> {
    let max = 0;
    for (const { event } of await this.eventStore.read(taskId)) {
      if (event.type === 'artifact_published') {
        max = Math.max(max, event.artifact.version);
      } else if (event.type === 'artifact_published_v2') {
        max = Math.max(max, event.artifactVersion);
      }
    }
    return max;
  }

  /** Publish + commit + cleanup in one call (the runtime mutation path). */
  async publishWithPin(input: PublishWithPinInput): Promise<PublishedV2Result> {
    const prepared = await this.preparePublication(input);
    const result = await this.commitPrepared(prepared.pin.pinId);
    await this.publicationStore.markPinCommittedAndRemove(prepared.pin.pinId);
    return result;
  }

  /** State-only mutation: the same typed intent path with an empty prepared-ref set. */
  async commitStateOnly(input: Omit<PublishWithPinInput, 'preparedRefs'>): Promise<PublishedV2Result> {
    if (
      input.payload !== null &&
      typeof input.payload === 'object' &&
      'blobRefs' in (input.payload as Record<string, unknown>) &&
      Array.isArray((input.payload as { blobRefs?: unknown }).blobRefs) &&
      (input.payload as { blobRefs: unknown[] }).blobRefs.length > 0
    ) {
      throw invalidInput('commitStateOnly 不接受携带结果 refs 的载荷。');
    }
    return this.publishWithPin({ ...input, preparedRefs: [] });
  }

  /**
   * Startup pin recovery: abandon expired illegal pins, clean committed pins
   * after ref verification, resume legal uncommitted pins byte-identically.
   * Never guesses an event envelope for anything else.
   */
  async startupRecovery(): Promise<RecoverySummary> {
    const summary: RecoverySummary = { cleaned: [], resumed: [], abandoned: [] };
    const committedOrphans = await this.publicationStore.cleanCommittedOrphanPins();
    summary.cleaned.push(...committedOrphans);
    for (const pin of await this.publicationStore.snapshotPins()) {
      if (pin.state !== 'active') continue;
      const committed = await this.eventStore.readBatchByCommitId(pin.taskId, pin.operationId);
      if (committed !== null) {
        // Committed operations clean their pins after ref verification.
        await this.verifyPreparedRefsPresent(pin.taskId, pin);
        await this.publicationStore.markPinCommittedAndRemove(pin.pinId);
        summary.cleaned.push(pin.pinId);
        continue;
      }
      if (await this.canResume(pin)) {
        await this.commitPrepared(pin.pinId);
        await this.publicationStore.markPinCommittedAndRemove(pin.pinId);
        summary.resumed.push(pin.pinId);
        continue;
      }
      // Every other pin: NEVER guessed. Expired ones (frozen TTL + lease +
      // provably-dead owner) are abandoned; live-creator pins wait in place.
    }
    const expired = await this.publicationStore.tryAbandonExpiredPins();
    summary.abandoned.push(...expired.abandoned);
    return summary;
  }

  /**
   * A pin may legally resume iff its intent is registered AND rebuildable,
   * its payload parses under the closed union with the registered family,
   * the task still exists, and the expected tail still matches.
   */
  private async canResume(pin: PublicationPinV2): Promise<boolean> {
    const registration = this.registry.resolve(pin.intent.handlerKind, pin.intent.handlerVersion);
    if (registration === null || !registration.rebuildable) return false;
    let parsed: PublicationOperationPayloadV2;
    try {
      parsed = registration.parsePayload(
        (await this.blobStore.readJson(
          pin.taskId,
          pin.intent.canonicalOperationPayloadRef,
          'publication_operation_payload',
        )) as PublicationOperationPayloadV2,
      );
    } catch {
      return false;
    }
    if (parsed.family !== registration.payloadFamily) return false;
    try {
      if (!(await stat(join(this.paths.taskRoot(pin.taskId)))).isDirectory()) return false;
    } catch {
      return false;
    }
    const tail = await this.eventStore.tail(pin.taskId);
    if (tail.lastSequence !== pin.expectedTailSequence || tail.lastCommitId !== pin.expectedTailCommitId) {
      return false;
    }
    return true;
  }

  private async computePayloadRef(payload: unknown): Promise<BlobRefV2> {
    let bytes: Buffer;
    let sha256: string;
    try {
      ({ bytes, sha256 } = canonicalJsonBytesAndSha256(payload));
    } catch (error) {
      throw invalidInput(`publication 载荷不可规范化: ${(error as Error).message}`);
    }
    const pending: BlobRefV2 = {
      kind: 'publication_operation_payload',
      digest: sha256,
      byteLength: bytes.length,
      mediaType: mediaTypeOf('publication_operation_payload'),
      schemaVersion: schemaVersionOf('publication_operation_payload'),
    };
    try {
      parseBlob('publication_operation_payload', payload, pending);
      parsePublicationOperationPayload(payload);
    } catch (error) {
      if (error instanceof SchemaError) {
        throw invalidInput(`publication 载荷校验失败: ${error.message}`);
      }
      throw error;
    }
    return pending;
  }

  private async verifyPreparedRefsPresent(taskId: string, pin: PublicationPinV2): Promise<void> {
    const refs: BlobRefV2[] = [...pin.blobRefs, pin.intent.canonicalOperationPayloadRef];
    for (const ref of refs) {
      try {
        await this.blobStore.readJson(taskId, ref, ref.kind);
      } catch (error) {
        if ((error as StorageError).code === STORAGE_ERROR_CODES.TASK_CORRUPTED) {
          throw corrupt(`引用的 v2 blob (${ref.kind}:${ref.digest.slice(0, 12)}…) 缺失或不可解析。`);
        }
        throw error;
      }
    }
  }

  /**
   * Response-loss replay verification: the pin's payload must re-derive the
   * SAME committed event structure (ignoring the deterministic id/at, which
   * legitimately differ across processes). Any structural difference means a
   * different payload was committed under this operation id -> conflict.
   */
  private async verifyReplayMatches(
    pin: PublicationPinV2,
    committed: readonly CommittedEvent[],
  ): Promise<void> {
    // The commitId+canonical-digest idempotency at the store level already
    // proves the envelope bytes. Structural re-derivation is an ADDITIONAL
    // same-payload guard for REBUILDABLE handlers; a non-rebuildable (or
    // unknown) handler's committed replay is returned as-is after ref
    // verification — never invented, never conflicted by absence of proofs.
    const registration = this.registry.resolve(pin.intent.handlerKind, pin.intent.handlerVersion);
    if (registration === null || !registration.rebuildable) return;
    const strip = (event: Record<string, unknown>): Record<string, unknown> => {
      const { id: _id, at: _at, ...rest } = event;
      return rest;
    };
    const rebuilt = await this.tryBuildEnvelopeStructure(pin);
    if (rebuilt === null) {
      throw new StorageError(
        STORAGE_ERROR_CODES.PIN_CONFLICT,
        '同一 operationId 已提交不同载荷，且该 pin 无法重建原事件。',
        null,
        '使用新的 operationId。',
      );
    }
    const committedStructure = committed.map((entry) =>
      canonicalJson(strip(entry.event as unknown as Record<string, unknown>)),
    );
    const rebuiltStructure = rebuilt.map((entry) => canonicalJson(strip(entry as Record<string, unknown>)));
    if (
      committedStructure.length !== rebuiltStructure.length ||
      committedStructure.some((bytes, index) => bytes !== rebuiltStructure[index])
    ) {
      throw new StorageError(
        STORAGE_ERROR_CODES.PIN_CONFLICT,
        '同一 operationId 已提交不同的批次载荷。',
        null,
        '使用新的 operationId 提交不同的事件。',
      );
    }
  }

  /** Best-effort structural rebuild of a pin's event envelopes (null on any failure). */
  private async tryBuildEnvelopeStructure(pin: PublicationPinV2): Promise<readonly Record<string, unknown>[] | null> {
    try {
      const registration = this.registry.resolve(pin.intent.handlerKind, pin.intent.handlerVersion);
      if (registration === null) return null;
      const parsed = registration.parsePayload(
        (await this.blobStore.readJson(
          pin.taskId,
          pin.intent.canonicalOperationPayloadRef,
          'publication_operation_payload',
        )) as PublicationOperationPayloadV2,
      );
      if (parsed.family !== registration.payloadFamily) return null;
      const refs = new Map<string, unknown>();
      for (const resolved of registration.resolveRefs(parsed)) {
        refs.set(resolved.key, await this.blobStore.readJson(pin.taskId, resolved.ref, resolved.ref.kind));
      }
      const envelopes = registration.buildEvents(parsed, pin.createdAtServer, refs);
      return envelopes.map((envelope) => ({ ...envelope })) as readonly Record<string, unknown>[];
    } catch {
      return null;
    }
  }
}
