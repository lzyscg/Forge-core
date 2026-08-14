/**
 * Append-only committed event store (plan Phase B Task 3; tightened to the
 * canonical task event union in plan Phase B Task 4).
 *
 * One committed event = one immutable file `events/<six-digit-sequence>-<event-id>.json`
 * (spec §8.1): a torn tail can never poison the whole history. The single
 * process allocates the next sequence by scanning committed filenames
 * (ignoring `.tmp-*` residue and malformed names), validates every payload
 * against the canonical union in `task-events.ts` before writing, and
 * serializes appends per task through a mutex queue so concurrent callers can
 * never race a sequence. A duplicate event id is idempotent only when its
 * canonical JSON bytes match the committed copy — anything else is an
 * EVENT_ID_CONFLICT. Reading re-validates every committed file: malformed
 * JSON, payloads outside the canonical union and sequence gaps all fail loud
 * (TASK_CORRUPTED); isolating them into a diagnostic summary is the
 * projector's job in plan Task 4 (spec §8.3).
 *
 * No business vocabulary lives here (iron rule 1): the union member names are
 * stable platform identifiers; semantic folding belongs to the projection.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function mkdir0(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
import type { CorePaths } from './core-paths';
import { formatBatchFileName, isSafeSegment, parseBatchFileName, parseEventFileName } from './core-paths';
import { STORAGE_ERROR_CODES, StorageError, writeNewAtomic, writeNewAtomicDurable } from './atomic-file';
import { validateTaskEvent, normalizeLegacyEvent, type TaskEvent } from './task-events';
import type { StoreFenceProof, StoreFenceRecord } from './authoritative-publication-store';
import { parseStoreFenceRecord, fenceRecordMatchesProof } from './authoritative-publication-store';

const TMP_PREFIX = '.tmp-';

/** One committed event plus the on-disk metadata projections need. */
export interface CommittedEvent {
  sequence: number;
  fileName: string;
  /** Byte length of the committed canonical JSON file. */
  size: number;
  event: TaskEvent;
}

/**
 * On-disk atomic batch envelope (spec §7.3). One file
 * `<first>-<last>-<commitId>.batch.json` carries a contiguous run of events;
 * `canonicalPayloadSha256` is the SHA-256 of the canonical JSON of `events`.
 */
export interface TaskEventBatchEnvelopeV1 {
  version: 1;
  commitId: string;
  taskId: string;
  firstSequence: number;
  eventCount: number;
  events: TaskEvent[];
  canonicalPayloadSha256: string;
}

/** Options for `EventStore.appendBatch` (spec §7.3). */
export interface AppendBatchOptions {
  /** The current logical tail the caller observed; mismatches fail the CAS. */
  expectedLastSequence: number;
  /**
   * Required for batches containing AuthoritativeReviewEventV2 members (spec
   * §8.1): a store-fence proof minted under the current lock hold. Validated
   * against the durable fence record/generation on disk; a stale or forged
   * proof is rejected fail-closed before anything touches the filesystem.
   */
  fenceProof?: StoreFenceProof;
  /**
   * Audit-only: the publication pin id is recorded in the batch envelope for
   * v2 batches (design §19.1 step 3). The envelope digest covers events
   * only, so v1 replay/idempotency is unaffected and read paths keep
   * accepting envelopes with or without the field.
   */
  publicationPinId?: string;
}

function corrupt(message: string): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.TASK_CORRUPTED,
    message,
    null,
    '检查该任务的本地事件目录。',
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Deterministic JSON: object keys sorted recursively. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isPlainObject(value)) {
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      ordered[key] = canonicalize(value[key]);
    }
    return ordered;
  }
  return value;
}

function canonicalJson(event: TaskEvent): string {
  return JSON.stringify(canonicalize(event));
}

/** SHA-256 of the canonical JSON of an events array (spec §7.3). */
function canonicalPayloadSha256(events: readonly TaskEvent[]): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(events))).digest('hex');
}

/** True for an AuthoritativeReviewEventV2 member (spec §9.1). */
export function isV2Event(event: TaskEvent): boolean {
  return (event as { protocolVersion?: unknown }).protocolVersion === 2;
}

interface ScannedEvent extends CommittedEvent {
  canonical: string;
}

/** A fully validated on-disk batch envelope plus its flattened members. */
interface ValidatedBatch extends TaskEventBatchEnvelopeV1 {
  fileName: string;
  /** Byte length of the committed envelope file. */
  size: number;
  /** Flattened committed entries, one per member, sharing `fileName`. */
  committed: ScannedEvent[];
}

/**
 * Reads and validates one committed file. Malformed JSON, a payload outside
 * the canonical union, or a filename/payload id mismatch all fail loud: the
 * store never guesses over damaged history.
 */
async function readCommittedFile(
  eventsRoot: string,
  fileName: string,
  parsed: { sequence: number; eventId: string },
): Promise<ScannedEvent> {
  let bytes: Buffer;
  try {
    bytes = await readFile(`${eventsRoot}/${fileName}`);
  } catch {
    throw corrupt('已提交事件文件不可读。');
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw corrupt('已提交事件文件不是有效 JSON。');
  }
  if (!isPlainObject(value) || typeof value.id !== 'string') {
    throw corrupt('已提交事件缺少 id。');
  }
  if (value.id !== parsed.eventId) {
    throw corrupt('已提交事件文件名与事件 id 不一致。');
  }
  let event: TaskEvent;
  try {
    event = validateTaskEvent(normalizeLegacyEvent(value));
  } catch {
    throw corrupt('已提交事件未通过规范事件校验。');
  }
  return {
    sequence: parsed.sequence,
    fileName,
    size: bytes.length,
    event,
    canonical: canonicalJson(event),
  };
}

/**
 * Reads and fully validates one batch envelope file (spec §7.3): safe shape,
 * version, filename↔commitId/firstSequence consistency, taskId match,
 * eventCount ↔ filename range, every member through the canonical union, and
 * the canonical payload SHA-256 digest. Any deviation fails loud as
 * TASK_CORRUPTED, so the read path and appendBatch's replay path share this
 * exact validation and preflight can never bypass digest/event checks.
 */
async function readBatchFile(
  eventsRoot: string,
  fileName: string,
  parsed: { firstSequence: number; lastSequence: number; commitId: string },
  taskId: string,
): Promise<ValidatedBatch> {
  let bytes: Buffer;
  try {
    bytes = await readFile(`${eventsRoot}/${fileName}`);
  } catch {
    throw corrupt('已提交批次事件文件不可读。');
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw corrupt('已提交批次事件文件不是有效 JSON。');
  }
  if (!isPlainObject(value)) {
    throw corrupt('已提交批次事件文件必须是对象。');
  }
  if (value.version !== 1) {
    throw corrupt('已提交批次事件文件版本不受支持。');
  }
  if (value.commitId !== parsed.commitId) {
    throw corrupt('已提交批次事件文件名与 commitId 不一致。');
  }
  if (value.taskId !== taskId) {
    throw corrupt('已提交批次事件文件 taskId 与任务不一致。');
  }
  if (value.firstSequence !== parsed.firstSequence) {
    throw corrupt('已提交批次事件文件 firstSequence 与文件名不一致。');
  }
  if (
    typeof value.eventCount !== 'number' ||
    !Number.isInteger(value.eventCount) ||
    value.eventCount < 1
  ) {
    throw corrupt('已提交批次事件文件 eventCount 无效。');
  }
  if (parsed.firstSequence + value.eventCount - 1 !== parsed.lastSequence) {
    throw corrupt('已提交批次事件文件序列范围与事件数量不一致。');
  }
  if (!Array.isArray(value.events) || value.events.length !== value.eventCount) {
    throw corrupt('已提交批次事件文件 events 数量与 eventCount 不一致。');
  }
  const events: TaskEvent[] = [];
  for (const candidate of value.events) {
    try {
      events.push(validateTaskEvent(normalizeLegacyEvent(candidate)));
    } catch {
      throw corrupt('已提交批次事件文件包含未通过规范事件校验的事件。');
    }
  }
  const digest = canonicalPayloadSha256(events);
  if (typeof value.canonicalPayloadSha256 !== 'string' || value.canonicalPayloadSha256 !== digest) {
    throw corrupt('已提交批次事件文件规范载荷摘要不匹配。');
  }
  return {
    version: 1,
    commitId: parsed.commitId,
    taskId,
    firstSequence: parsed.firstSequence,
    eventCount: value.eventCount,
    events,
    canonicalPayloadSha256: digest,
    fileName,
    size: bytes.length,
    committed: events.map((event, index) => ({
      sequence: parsed.firstSequence + index,
      fileName,
      size: bytes.length,
      event,
      canonical: canonicalJson(event),
    })),
  };
}

export interface EventStoreOptions {
  /**
   * Test seam: replaces the append-manifest writer. The manifest is a
   * DISPOSABLE accelerator — a failing writer must never fail the already
   * durably committed append (the next access rebuilds from the full
   * validated scan). Production callers leave it undefined.
   */
  manifestWriter?: (taskId: string, manifest: AppendManifestV1) => Promise<void>;
}

export class EventStore {
  private readonly paths: CorePaths;

  private readonly manifestWriter: (taskId: string, manifest: AppendManifestV1) => Promise<void>;

  /** Per-task append/read serialization within this single process. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(paths: CorePaths, options: EventStoreOptions = {}) {
    this.paths = paths;
    this.manifestWriter = options.manifestWriter ?? (async (taskId, manifest) => {
      const eventsRoot = this.paths.taskEventsRoot(taskId);
      await mkdir0(eventsRoot);
      const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
      await writeFile(join(eventsRoot, this.manifestFileName()), bytes);
    });
  }

  /**
   * Appends one committed event to the task history after validating it
   * against the canonical union (invalid payloads never touch the filesystem
   * and never advance the sequence). Duplicate ids replay the prior commit
   * when canonical bytes match; conflicting bytes fail. v2 events are
   * rejected outright: every v2 mutation must flow through the
   * AuthoritativeAppendFacadeV2 (spec §8.1), never raw single-file appends.
   */
  async append(taskId: string, event: TaskEvent): Promise<CommittedEvent> {
    const validated = validateTaskEvent(event);
    if (isV2Event(validated)) {
      throw new StorageError(
        STORAGE_ERROR_CODES.EVENT_INVALID,
        'v2 事件必须通过 AuthoritativeAppendFacadeV2 提交，禁止直接单事件追加。',
        null,
        '通过 v2 append facade 提交。',
      );
    }
    return this.enqueue(taskId, () => this.appendExclusive(taskId, validated));
  }

  /** Returns committed events in sequence order; unknown tasks read empty. */
  read(taskId: string): Promise<CommittedEvent[]> {
    return this.enqueue(taskId, async () =>
      (await this.scanCommitted(taskId)).map(({ canonical: _canonical, ...committed }) => committed),
    );
  }

  /** Runs work behind the per-task mutex; failures never jam the queue. */
  private enqueue<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    const run = previous.then(work, work);
    this.queues.set(
      taskId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async appendExclusive(taskId: string, event: TaskEvent): Promise<CommittedEvent> {
    const canonical = canonicalJson(event);
    const index = await this.loadHistory(taskId);
    const priorSequence = index.eventIds[event.id];
    if (priorSequence !== undefined) {
      // Idempotent replay: re-read the EXACT committed file of the hit and
      // compare canonical bytes (the manifest index never decides content).
      const prior = await this.readEntryForReplay(taskId, priorSequence, event.id);
      if (prior === null || prior.canonical !== canonical) {
        throw new StorageError(
          STORAGE_ERROR_CODES.EVENT_ID_CONFLICT,
          '同一事件 id 提交了不同的内容。',
          null,
          '使用新的事件 id 追加新事件。',
        );
      }
      const { canonical: _canonical, ...replay } = prior;
      return replay;
    }
    const sequence = index.tailSequence + 1;
    const fileName = `${String(sequence).padStart(6, '0')}-${event.id}.json`;
    const bytes = Buffer.from(canonical, 'utf8');
    await writeNewAtomic(this.paths.taskEventFile(taskId, fileName), bytes);
    const envelopeDigest = createHash('sha256').update(bytes).digest('hex');
    await this.maintainManifestAfterAppend(taskId, index, fileName, envelopeDigest, null, [event], sequence);
    const { canonical: _canonical, ...result } = {
      sequence,
      fileName,
      size: bytes.length,
      event,
      canonical,
    };
    return result;
  }

  /** Re-reads the single-event file of a manifest-flagged id (byte compare). */
  private async readEntryForReplay(
    taskId: string,
    sequence: number,
    eventId: string,
  ): Promise<ScannedEvent | null> {
    try {
      const fileName = `${String(sequence).padStart(6, '0')}-${eventId}.json`;
      const parsed = parseEventFileName(fileName);
      if (parsed === null) {
        return null;
      }
      return await readCommittedFile(this.paths.taskEventsRoot(taskId), fileName, parsed);
    } catch {
      return null; // the manifest flagged a hit the disk cannot confirm
    }
  }

  /**
   * Appends a batch of events as ONE atomic envelope file
   * `<first>-<last>-<commitId>.batch.json` (spec §7.3). All members are
   * validated against the canonical union before anything touches the
   * filesystem, and the write is all-or-nothing. Inside the per-task mutex:
   * an existing commitId replays the original committed result when the
   * canonical payload matches, else fails with IDEMPOTENCY_CONFLICT; a fresh
   * commit enforces `expectedLastSequence` as a CAS against the current
   * logical tail (EXPECTED_SEQUENCE_MISMATCH otherwise), rejects event ids
   * already present in the history, allocates contiguous sequences and writes
   * the one envelope file via `writeNewAtomic`.
   */
  async appendBatch(
    taskId: string,
    commitId: string,
    events: readonly TaskEvent[],
    options: AppendBatchOptions,
  ): Promise<CommittedEvent[]> {
    if (!isSafeSegment(commitId)) {
      throw new StorageError(
        STORAGE_ERROR_CODES.EVENT_INVALID,
        'commitId 必须是稳定的文件安全标识。',
        null,
        '修正 commitId 后重试。',
      );
    }
    if (!Array.isArray(events) || events.length === 0) {
      throw new StorageError(
        STORAGE_ERROR_CODES.EVENT_INVALID,
        '批次事件不能为空。',
        null,
        '提供至少一个事件。',
      );
    }
    const validated = events.map((event) => validateTaskEvent(event));
    const ids = new Set(validated.map((event) => event.id));
    if (ids.size !== validated.length) {
      throw new StorageError(
        STORAGE_ERROR_CODES.EVENT_INVALID,
        '批次内事件 id 重复。',
        null,
        '每个事件使用唯一的事件 id。',
      );
    }
    const hasV2 = validated.some(isV2Event);
    if (hasV2) {
      await this.requireLiveFenceProof(options.fenceProof);
    }
    const digest = canonicalPayloadSha256(validated);
    return this.enqueue(taskId, () =>
      this.appendBatchExclusive(
        taskId,
        commitId,
        validated,
        digest,
        options.expectedLastSequence,
        hasV2,
        options.publicationPinId,
      ),
    );
  }

  /**
   * Spec §8.1 fence enforcement: a batch carrying AuthoritativeReviewEventV2
   * members is rejected unless the call presents a currently valid store-fence
   * proof — exact field equality against the durable fence record written by
   * the (lock-holding) publication facade. No record or any mismatch fails
   * closed before anything touches the filesystem. v1 batches never reach
   * this check.
   */
  private async requireLiveFenceProof(proof: StoreFenceProof | undefined): Promise<void> {
    if (proof === undefined) {
      throw new StorageError(
        STORAGE_ERROR_CODES.EVENT_INVALID,
        '包含 v2 事件的批次必须携带当前有效的 store fence 证明。',
        null,
        '通过 AuthoritativeAppendFacadeV2 提交 v2 批次。',
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.paths.storeFenceRecordFile(), 'utf8'));
    } catch {
      value = null;
    }
    const record = parseStoreFenceRecord(value);
    if (record === null) {
      throw new StorageError(
        STORAGE_ERROR_CODES.EVENT_INVALID,
        '没有当前有效的 store fence 记录。',
        null,
        '重新通过 AuthoritativeAppendFacadeV2 获取当前证明。',
      );
    }
    if (!fenceRecordMatchesProof(record, proof)) {
      // The record we minted a proof against was replaced (e.g. a racing
      // takeover) — TRANSIENT, retryable by the facade's commit loop, never a
      // permanent validation failure.
      throw new StorageError(
        STORAGE_ERROR_CODES.LOCK_SUPERSEDED,
        'store fence 证明与当前 fence 记录不匹配，本次持有已被替换。',
        null,
        '重新获取证明后重试。',
      );
    }
  }

  private async appendBatchExclusive(
    taskId: string,
    commitId: string,
    events: TaskEvent[],
    digest: string,
    expectedLastSequence: number,
    hasV2: boolean,
    publicationPinId: string | undefined,
  ): Promise<CommittedEvent[]> {
    const index = await this.loadHistory(taskId);
    const existingFileName = index.commitIds[commitId];
    if (existingFileName !== undefined) {
      const existingDigest = index.envelopes[existingFileName];
      if (existingDigest === digest) {
        // Idempotent replay: rebuild the committed entries by re-reading the
        // named envelope (the index never decides content).
        const parsed = parseBatchFileName(existingFileName);
        if (parsed !== null) {
          const validated = await readBatchFile(this.paths.taskEventsRoot(taskId), existingFileName, parsed, taskId);
          return validated.committed.map(({ canonical: _canonical, ...result }) => result);
        }
      }
      throw new StorageError(
        STORAGE_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        '同一 commitId 提交了不同的批次载荷。',
        null,
        '使用新的 commitId 提交不同的事件批次。',
      );
    }
    if (expectedLastSequence !== index.tailSequence) {
      throw new StorageError(
        STORAGE_ERROR_CODES.EXPECTED_SEQUENCE_MISMATCH,
        '预期最后序列与当前已提交序列不一致。',
        null,
        '刷新最新状态后重试。',
      );
    }
    for (const event of events) {
      if (index.eventIds[event.id] !== undefined) {
        throw new StorageError(
          STORAGE_ERROR_CODES.EVENT_ID_CONFLICT,
          '同一事件 id 已存在于任务历史。',
          null,
          '使用新的事件 id 追加新事件。',
        );
      }
    }
    const firstSequence = index.tailSequence + 1;
    const lastSequence = index.tailSequence + events.length;
    const fileName = formatBatchFileName(firstSequence, lastSequence, commitId);
    const envelope: TaskEventBatchEnvelopeV1 & { publicationPinId?: string } = {
      version: 1,
      commitId,
      taskId,
      firstSequence,
      eventCount: events.length,
      events,
      canonicalPayloadSha256: digest,
      // Audit-only for v2 batches (design §19.1 step 3): the digest still
      // covers events only, so v1 replay/idempotency is byte-unchanged.
      ...(publicationPinId !== undefined ? { publicationPinId } : {}),
    };
    const bytes = Buffer.from(JSON.stringify(canonicalize(envelope)), 'utf8');
    // v2 batches are pinned by the publication facade: their batch file must
    // be durable (renamed file PLUS parent-directory fsync, spec §8.1 step 4).
    // v1 keeps the legacy byte/behavior write path untouched.
    let reservedRange = false;
    try {
      if (hasV2) {
        // Cross-process range reservation (spec §8.1 convergence, defense in
        // depth over the per-instance CAS): the batch file name embeds the
        // commitId, so two overlapping writes WOULD collide on sequence range
        // without a range-keyed mutex. The reservation is keyed by the range
        // ALONE; the record-keyed proof stamps it so a stale reservation
        // (crashed committer) is provably removable while a live owner's
        // reservation blocks the overlap.
        await this.reserveBatchRange(taskId, firstSequence, lastSequence);
        reservedRange = true;
        await writeNewAtomicDurable(this.paths.taskBatchEventFile(taskId, fileName), bytes);
      } else {
        await writeNewAtomic(this.paths.taskBatchEventFile(taskId, fileName), bytes);
      }
    } finally {
      if (reservedRange) {
        await rm(join(this.paths.taskEventsRoot(taskId), this.rangeReservationName(firstSequence, lastSequence)), {
          force: true,
        }).catch(() => undefined);
      }
    }
    await this.maintainManifestAfterAppend(taskId, index, fileName, digest, commitId, events, firstSequence);
    return events.map((event, index) => ({
      sequence: firstSequence + index,
      fileName,
      size: bytes.length,
      event,
    }));
  }

  /** `<first>-<last>.batch-reserved` — range-keyed, never a committed file. */
  private rangeReservationName(firstSequence: number, lastSequence: number): string {
    return `${String(firstSequence).padStart(6, '0')}-${String(lastSequence).padStart(6, '0')}.batch-reserved`;
  }

  /**
   * O_EXCL range reservation for a v2 batch. On clash: a reservation that
   * matches the CURRENTLY LIVE fence record means a real concurrent holder of
   * the same range -> EXPECTED_SEQUENCE_MISMATCH (retryable at the operation
   * level, never silent overlap); a reservation that no longer matches the
   * record is a crashed committer's residue -> removed and retried once.
   */
  private async reserveBatchRange(taskId: string, firstSequence: number, lastSequence: number): Promise<void> {
    const eventsRoot = this.paths.taskEventsRoot(taskId);
    await mkdir0(eventsRoot);
    for (let attempt = 0; ; attempt += 1) {
      const reservationPath = join(eventsRoot, this.rangeReservationName(firstSequence, lastSequence));
      let created = true;
      try {
        const payload = await this.currentReservationPayload();
        await writeFile(reservationPath, JSON.stringify(payload), { flag: 'wx' });
      } catch {
        created = false;
      }
      if (created) return;
      // Clash: decide stale-vs-live against the CURRENT fence record.
      const current = await this.readFenceRecord();
      const existing = await this.readReservation(reservationPath);
      if (existing !== null && current !== null && this.reservationMatches(existing, current)) {
        throw new StorageError(
          STORAGE_ERROR_CODES.EXPECTED_SEQUENCE_MISMATCH,
          '该序列区间已被并发的 v2 批次保留，出现重叠。',
          null,
          '在最新提交后重试。',
        );
      }
      if (attempt < 1 && existing !== null) {
        await rm(reservationPath, { force: true });
        continue;
      }
      throw new StorageError(
        STORAGE_ERROR_CODES.EXPECTED_SEQUENCE_MISMATCH,
        '该序列区间被无法判定归属的 v2 保留占据。',
        null,
        '在最新提交后重试。',
      );
    }
  }

  private async readFenceRecord(): Promise<StoreFenceRecord | null> {
    try {
      return parseStoreFenceRecord(JSON.parse(await readFile(this.paths.storeFenceRecordFile(), 'utf8')));
    } catch {
      return null;
    }
  }

  private async readReservation(path: string): Promise<StoreFenceProof | null> {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      if (
        typeof value.ownerPid !== 'number' ||
        typeof value.processStartToken !== 'string' ||
        typeof value.leaseEpoch !== 'number' ||
        typeof value.acquisitionNonce !== 'string' ||
        typeof value.durableGeneration !== 'number'
      ) {
        return null;
      }
      return {
        ownerPid: value.ownerPid,
        processStartToken: value.processStartToken,
        leaseEpoch: value.leaseEpoch,
        acquisitionNonce: value.acquisitionNonce,
        durableGeneration: value.durableGeneration,
      };
    } catch {
      return null;
    }
  }

  private reservationMatches(reservation: StoreFenceProof, record: StoreFenceRecord): boolean {
    return (
      reservation.ownerPid === record.ownerPid &&
      reservation.processStartToken === record.processStartToken &&
      reservation.leaseEpoch === record.leaseEpoch &&
      reservation.acquisitionNonce === record.acquisitionNonce
    );
  }

  /** The reservation carries the fence-owner identity so staleness is provable. */
  private async currentReservationPayload(): Promise<StoreFenceProof> {
    const current = await this.readFenceRecord();
    if (current === null) {
      throw new StorageError(
        STORAGE_ERROR_CODES.EVENT_INVALID,
        '没有当前有效的 store fence 记录，无法保留 v2 序列区间。',
        null,
        '重新通过 AuthoritativeAppendFacadeV2 获取当前证明。',
      );
    }
    return {
      ownerPid: current.ownerPid,
      processStartToken: current.processStartToken,
      leaseEpoch: current.leaseEpoch,
      acquisitionNonce: current.acquisitionNonce,
      durableGeneration: current.durableGeneration,
    };
  }

  /**
   * Returns the fully validated flattened members of an existing batch for a
   * known commitId, or null when no such batch is committed. Runs the exact
   * same validated scanner as appendBatch's replay path, so a corrupt
   * envelope (bad digest, wrong eventCount, invalid member) fails loud with
   * TASK_CORRUPTED and a legacy single-event file is never mistaken for a
   * named batch. Used for response-loss preflight and race reconciliation.
   */
  async readBatchByCommitId(taskId: string, commitId: string): Promise<CommittedEvent[] | null> {
    return this.enqueue(taskId, async () => {
      const { batches } = await this.scanHistory(taskId);
      const existing = batches.get(commitId);
      if (existing === undefined) {
        return null;
      }
      return existing.committed.map(({ canonical: _canonical, ...result }) => result);
    });
  }

  /**
   * Scans committed event files from disk on every access: the plan allocates
   * sequences "after scanning committed filenames", and rescanning also makes
   * out-of-band damage (corruption while the server is stopped, spec §8.3)
   * fail loud on the very next access instead of hiding behind a cache.
   * Both legacy single-event files and batch envelopes are flattened into a
   * single contiguous logical history: committed sequences must form a
   * contiguous run starting at 1; duplicates and gaps both fail loud as
   * corruption. The batch pattern is checked first so a batch envelope is
   * never mistaken for a legacy single event (and vice versa).
   */
  private async scanHistory(taskId: string): Promise<{
    events: ScannedEvent[];
    batches: Map<string, ValidatedBatch>;
  }> {
    const eventsRoot = this.paths.taskEventsRoot(taskId);
    let names: string[];
    try {
      names = await readdir(eventsRoot);
    } catch {
      return { events: [], batches: new Map() };
    }
    const scanned: ScannedEvent[] = [];
    const batches = new Map<string, ValidatedBatch>();
    for (const name of names) {
      if (name.startsWith(TMP_PREFIX) || name.startsWith('.')) {
        continue; // Temporary residue and dotfile store metadata never count as committed (spec §8.2).
      }
      const batch = parseBatchFileName(name);
      if (batch !== null) {
        const validated = await readBatchFile(eventsRoot, name, batch, taskId);
        batches.set(validated.commitId, validated);
        scanned.push(...validated.committed);
        continue;
      }
      const parsed = parseEventFileName(name);
      if (parsed === null) {
        continue; // Malformed names are ignored, never projected.
      }
      scanned.push(await readCommittedFile(eventsRoot, name, parsed));
    }
    scanned.sort((a, b) => a.sequence - b.sequence);
    for (let index = 0; index < scanned.length; index += 1) {
      if (scanned[index]?.sequence !== index + 1) {
        throw corrupt('已提交事件序列不连续。');
      }
    }
    return { events: scanned, batches };
  }

  /** Flattened committed events (legacy + batch) in contiguous sequence order. */
  private async scanCommitted(taskId: string): Promise<ScannedEvent[]> {
    return (await this.scanHistory(taskId)).events;
  }

  /**
   * Fresh on-disk task tail identity (spec §8.1 step 1: reload from disk,
   * never an instance cache): the current logical last sequence and the
   * commitId of the batch that carries it (null when the tail was written by
   * legacy single-event files). The publication facade verifies a pin's
   * expectedTail* against this, and GC uses it for the delete recheck.
   */
  async tail(taskId: string): Promise<{ lastSequence: number; lastCommitId: string | null }> {
    return this.enqueue(taskId, async () => {
      const { events, batches } = await this.scanHistory(taskId);
      const last = events[events.length - 1];
      if (last === undefined) return { lastSequence: 0, lastCommitId: null };
      let lastCommitId: string | null = null;
      for (const batch of batches.values()) {
        if (batch.committed[batch.committed.length - 1]?.sequence === last.sequence) {
          lastCommitId = batch.commitId;
          break;
        }
      }
      return { lastSequence: last.sequence, lastCommitId };
    });
  }

  /**
   * Validated tail-range access (spec §9.4): the committed events with
   * sequence strictly greater than `throughSequence`, in sequence order.
   * The range is FULLY validated from disk (a corrupt tail fails loud as
   * TASK_CORRUPTED — corrupt authority is never masked); the checkpoint
   * store replays from here and MUST never fall back past a corrupt event.
   */
  async readAfter(taskId: string, throughSequence: number): Promise<CommittedEvent[]> {
    if (!Number.isInteger(throughSequence) || throughSequence < 0) {
      throw new StorageError(
        STORAGE_ERROR_CODES.EVENT_INVALID,
        'throughSequence 必须是非负整数。',
        null,
        '修正参数后重试。',
      );
    }
    return this.enqueue(taskId, async () => {
      const events = await this.scanCommitted(taskId);
      return events
        .filter((entry) => entry.sequence > throughSequence)
        .map(({ canonical: _canonical, ...committed }) => committed);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Persistent per-task append manifest (spec §9.4, design §19.1)       */
  /*                                                                    */
  /* `events/.append-manifest.json`: a DISPOSABLE accelerator holding   */
  /* the tail sequence, the commit-ID index, the event-ID index and     */
  /* per-envelope digests, so the append CAS avoids rescanning the full */
  /* history on normal writes. It is never authority: on ANY divergence */
  /* from disk (missing/corrupt manifest, tail file mismatch) the store */
  /* rebuilds it from the exact same validated full scan and retries,   */
  /* and it can never override a committed file (the CAS stays the      */
  /* single decision point).                                            */
  /* ------------------------------------------------------------------ */

  /** The append-manifest file name lives beside committed events (dotfile, invisible to scans). */
  private manifestFileName(): string {
    return '.append-manifest.json';
  }

  /** Reads the manifest; missing/corrupt/untrustworthy => null (rebuild). */
  private async readManifest(taskId: string): Promise<AppendManifestV1 | null> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(this.paths.taskEventsRoot(taskId), this.manifestFileName()), 'utf8'));
    } catch {
      return null;
    }
    if (!isPlainObject(value) || value.version !== 1 || value.taskId !== taskId) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.tailSequence !== 'number' ||
      !Number.isInteger(record.tailSequence) ||
      record.tailSequence < 0 ||
      (record.tailFileName !== null && typeof record.tailFileName !== 'string') ||
      (record.tailCommitId !== null && typeof record.tailCommitId !== 'string') ||
      !isPlainObject(record.eventIds) ||
      !isPlainObject(record.commitIds) ||
      !isPlainObject(record.envelopes)
    ) {
      return null;
    }
    return record as unknown as AppendManifestV1;
  }

  private async writeManifest(taskId: string, manifest: AppendManifestV1): Promise<void> {
    // Best-effort: the manifest is disposable. A failure here must never
    // fail an already-durably-committed append — the write is caught by the
    // callers, which invalidate the on-disk manifest so the next access
    // rebuilds from the full validated scan.
    try {
      await this.manifestWriter(taskId, manifest);
    } catch {
      try {
        await rm(join(this.paths.taskEventsRoot(taskId), this.manifestFileName()), { force: true });
      } catch {
        // the stale manifest will be rejected by the divergence guard
      }
    }
  }

  /**
   * Loads the committed CAS index FAST when the manifest matches disk:
   * the tail envelope is re-read and fully re-validated (the same
   * readBatchFile/readCommittedFile validation the scan uses), and its
   * digest must equal the manifest's recorded envelope digest. Anything
   * else rebuilds the manifest from the authoritative full scan.
   *
   * The manifest index carries ONLY CAS metadata (tail, ids, digests);
   * event bytes are re-validated on every read path, and the idempotent
   * replay path re-reads the exact file of a hit. The manifest never
   * overrides a committed file: it is disposable accelerator state and is
   * rebuilt the moment disk disagrees.
   */
  private async loadHistory(taskId: string): Promise<HistoryIndex> {
    const manifest = await this.readManifest(taskId);
    if (manifest !== null && (await this.verifyManifestTail(taskId, manifest))) {
      return indexFromManifest(manifest);
    }
    const scanned = await this.scanHistory(taskId);
    const rebuilt = indexFromScan(taskId, scanned.events, scanned.batches);
    await this.writeManifest(taskId, rebuilt.manifest); // best-effort (M7)
    return rebuilt;
  }

  /** Re-validates the manifest tail envelope against disk (O(1) file). */
  private async verifyManifestTail(taskId: string, manifest: AppendManifestV1): Promise<boolean> {
    const tailFileName = manifest.tailFileName;
    // Directory-level divergence guard: the manifest is trusted only when the
    // number of committed envelopes on disk matches its index. An extra or
    // missing envelope (out-of-band damage, a crashed foreign writer or a
    // corrupted index) forces a full-scan rebuild — the accelerator never
    // decides over disk.
    let committedNames: string[] = [];
    try {
      const names = await readdir(this.paths.taskEventsRoot(taskId));
      committedNames = names.filter(
        (name) => !name.startsWith(TMP_PREFIX) && !name.startsWith('.') && (parseBatchFileName(name) !== null || parseEventFileName(name) !== null),
      );
    } catch {
      return false;
    }
    if (committedNames.length !== Object.keys(manifest.envelopes).length) {
      return false;
    }
    if (tailFileName === null || manifest.tailSequence === 0) {
      return manifest.tailSequence === 0 && Object.keys(manifest.eventIds).length === 0;
    }
    try {
      const eventsRoot = this.paths.taskEventsRoot(taskId);
      const tailFile: string = tailFileName;
      const batch = parseBatchFileName(tailFile);
      if (batch !== null) {
        if (batch.lastSequence !== manifest.tailSequence) return false;
        const validated = await readBatchFile(eventsRoot, tailFile, batch, taskId);
        return validated.canonicalPayloadSha256 === manifest.envelopes[tailFile];
      }
      const single = parseEventFileName(tailFile);
      if (single !== null && single.sequence === manifest.tailSequence) {
        const validated = await readCommittedFile(eventsRoot, tailFile, {
          sequence: single.sequence,
          eventId: single.eventId,
        });
        const digest = createHash('sha256')
          .update(Buffer.from(validated.canonical, 'utf8'))
          .digest('hex');
        return digest === manifest.envelopes[tailFile];
      }
      return false;
    } catch {
      return false; // missing or unreadable tail envelope => rebuild/retry
    }
  }

  /** Extends the manifest after one committed envelope (no rescan). */
  private async maintainManifestAfterAppend(
    taskId: string,
    index: HistoryIndex,
    fileName: string,
    digest: string,
    commitId: string | null,
    events: readonly TaskEvent[],
    firstSequence: number,
  ): Promise<void> {
    if (commitId === null) {
      const entry = events[0];
      if (entry === undefined) return;
      index.manifest.eventIds[entry.id] = firstSequence;
      index.manifest.envelopes[fileName] = digest;
      index.manifest.tailFileName = fileName;
      index.manifest.tailSequence = firstSequence;
      index.manifest.tailCommitId = null;
      await this.writeManifest(taskId, index.manifest);
      return;
    }
    for (let offset = 0; offset < events.length; offset += 1) {
      index.manifest.eventIds[events[offset]?.id ?? ''] = firstSequence + offset;
    }
    index.manifest.envelopes[fileName] = digest;
    index.manifest.commitIds[commitId] = fileName;
    index.manifest.tailFileName = fileName;
    index.manifest.tailSequence = firstSequence + events.length - 1;
    index.manifest.tailCommitId = commitId;
    await this.writeManifest(taskId, index.manifest);
  }
}
/** The CAS metadata view over a task history (manifest-fast or scan). */
interface HistoryIndex {
  tailSequence: number;
  tailCommitId: string | null;
  eventIds: Record<string, number>;
  commitIds: Record<string, string>;
  envelopes: Record<string, string>;
  manifest: AppendManifestV1;
}

function indexFromManifest(manifest: AppendManifestV1): HistoryIndex {
  return {
    tailSequence: manifest.tailSequence,
    tailCommitId: manifest.tailCommitId,
    eventIds: { ...manifest.eventIds },
    commitIds: { ...manifest.commitIds },
    envelopes: { ...manifest.envelopes },
    manifest,
  };
}

function indexFromScan(
  taskId: string,
  events: readonly ScannedEvent[],
  batches: ReadonlyMap<string, ValidatedBatch>,
): HistoryIndex {
  const envelopes: Record<string, string> = {};
  const eventIds: Record<string, number> = {};
  const commitIds: Record<string, string> = {};
  let tailFileName: string | null = null;
  let tailCommitId: string | null = null;
  if (events.length > 0) {
    const last = events[events.length - 1];
    tailFileName = last?.fileName ?? null;
    for (const batch of batches.values()) {
      if (batch.committed[batch.committed.length - 1]?.sequence === last?.sequence) {
        tailCommitId = batch.commitId;
        break;
      }
    }
  }
  for (const entry of events) {
    const batchCommitId = parseBatchFileName(entry.fileName)?.commitId ?? null;
    const digest =
      (batchCommitId !== null ? batches.get(batchCommitId)?.canonicalPayloadSha256 : undefined) ??
      createHash('sha256').update(Buffer.from(entry.canonical, 'utf8')).digest('hex');
    envelopes[entry.fileName] = digest;
  }
  for (const entry of events) {
    eventIds[entry.event.id] = entry.sequence;
  }
  for (const batch of batches.values()) {
    commitIds[batch.commitId] = batch.fileName;
  }
  const manifest: AppendManifestV1 = {
    version: 1,
    taskId,
    tailSequence: events[events.length - 1]?.sequence ?? 0,
    tailFileName,
    tailCommitId,
    envelopes,
    eventIds,
    commitIds,
  };
  return {
    tailSequence: manifest.tailSequence,
    tailCommitId,
    eventIds,
    commitIds,
    envelopes,
    manifest,
  };
}

/** The append-manifest accelerator shape (spec §9.4). */
interface AppendManifestV1 {
  version: 1;
  taskId: string;
  tailSequence: number;
  tailFileName: string | null;
  tailCommitId: string | null;
  /** envelope file name -> canonical payload digest (batch) or canonical event digest (single). */
  envelopes: Record<string, string>;
  /** eventId -> committed sequence. */
  eventIds: Record<string, number>;
  /** commitId -> envelope file name. */
  commitIds: Record<string, string>;
}
