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

export class EventStore {
  private readonly paths: CorePaths;

  /** Per-task append/read serialization within this single process. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(paths: CorePaths) {
    this.paths = paths;
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
    const committed = await this.scanCommitted(taskId);
    const prior = committed.find((entry) => entry.event.id === event.id);
    if (prior !== undefined) {
      if (prior.canonical !== canonical) {
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
    const sequence = (committed[committed.length - 1]?.sequence ?? 0) + 1;
    const fileName = `${String(sequence).padStart(6, '0')}-${event.id}.json`;
    const bytes = Buffer.from(canonical, 'utf8');
    await writeNewAtomic(this.paths.taskEventFile(taskId, fileName), bytes);
    const { canonical: _canonical, ...result } = {
      sequence,
      fileName,
      size: bytes.length,
      event,
      canonical,
    };
    return result;
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
    const { events: committed, batches } = await this.scanHistory(taskId);
    const existing = batches.get(commitId);
    if (existing !== undefined) {
      if (existing.canonicalPayloadSha256 === digest) {
        return existing.committed.map(({ canonical: _canonical, ...result }) => result);
      }
      throw new StorageError(
        STORAGE_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        '同一 commitId 提交了不同的批次载荷。',
        null,
        '使用新的 commitId 提交不同的事件批次。',
      );
    }
    const tail = committed[committed.length - 1]?.sequence ?? 0;
    if (expectedLastSequence !== tail) {
      throw new StorageError(
        STORAGE_ERROR_CODES.EXPECTED_SEQUENCE_MISMATCH,
        '预期最后序列与当前已提交序列不一致。',
        null,
        '刷新最新状态后重试。',
      );
    }
    for (const event of events) {
      const prior = committed.find((entry) => entry.event.id === event.id);
      if (prior !== undefined) {
        throw new StorageError(
          STORAGE_ERROR_CODES.EVENT_ID_CONFLICT,
          '同一事件 id 已存在于任务历史。',
          null,
          '使用新的事件 id 追加新事件。',
        );
      }
    }
    const firstSequence = tail + 1;
    const lastSequence = tail + events.length;
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
      if (name.startsWith(TMP_PREFIX)) {
        continue; // Temporary residue never counts as committed (spec §8.2).
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
}
