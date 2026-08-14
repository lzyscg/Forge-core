/**
 * Task 8 durable publication pins + cross-process store lock/fence +
 * generation barrier (spec §8/§8.1, design §19.1).
 *
 * PublicationPin:
 *   { pinId, taskId, operationId, expectedTailSequence, expectedTailCommitId,
 *     blobRefs[], gcGeneration, createdAtServer, ownerEpoch, intent,
 *     state, prepareExpiresAt, ownerLeaseExpiresAt, abandonedGeneration,
 *     ownerPid, ownerProcessStartToken, ownerProcessStartTime }
 * Pins live at `dataRoot/publication-pins/<pinId>.json`; file AND parent
 * directory are fsynced. Same operation with equal refs/intent is idempotent;
 * a different payload conflicts (PIN_CONFLICT). Lifecycle: active -> committed
 * (durable terminal marker, then removal) or abandoned (survives at least one
 * additional full GC generation).
 *
 * Store lock + fence: one data-root scoped exclusive lock (mkdir atomicity at
 * `.store-lock`) with an owner marker INSIDE the directory that carries the
 * record-owner nonce. Every destructive operation is ownership-checked: the
 * fast path re-verifies its marker and record immediately before returning a
 * hold, a takeover only removes a directory whose marker belongs to the
 * provably-dead recorded owner, and release() never touches a directory whose
 * marker is not its own — a superseded hold cannot destroy a successor's
 * lock directory. The durable fence record `.store-lock-record.json` carries
 * { ownerPid, processStartToken (per-process session), processStartTime,
 * bootId, leaseEpoch, acquisitionNonce, durableGeneration, acquiredAt }.
 * Stale takeover requires PROVING the recorded owner dead: boot mismatch, PID
 * probe failure, zombie state, or (when /proc is readable) a process-start
 * mismatch; wall-clock expiry alone can never steal a live lock. Ambiguous
 * cases stay fail-closed (LOCK_BUSY, never a steal).
 *
 * Generation barrier: `.v2-generation.json` is advanced only while holding
 * the lock (writeReplaceAtomicDurable), so GC excludes objects newer than
 * its mark-start generation.
 *
 * All liveness/time inputs are injectable (options.clock,
 * options.processAlive, options.bootId) and the ABA pause windows are
 * injectable (options.pauseBeforeMarker / pauseBeforeOwnershipVerify) so
 * tests are deterministic — no real process kills, no flaky timing.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CorePaths } from './core-paths';
import { STORAGE_ERROR_CODES, StorageError, writeNewAtomicDurable, writeReplaceAtomicDurable } from './atomic-file';
import type { PublicationIntentV2 } from './authoritative-publication-intent-registry';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';

export type PublicationPinStateV2 = 'active' | 'committed' | 'abandoned';

/**
 * The exact durable pin shape (design §19.1 plus the Task 8 lifecycle
 * extensions: frozen prepare TTL, owner lease, terminal/abandoned states, and
 * the CREATOR's process identity stamped at prepare time — liveness of an
 * uncommitted pin is proven by its creator, never by wall clock alone).
 * Agent text and executable callbacks never appear here.
 */
export interface PublicationPinV2 {
  pinId: string;
  taskId: string;
  operationId: string;
  expectedTailSequence: number;
  expectedTailCommitId: string | null;
  blobRefs: readonly BlobRefV2[];
  /** Generation counter snapshot taken at prepare time. */
  gcGeneration: number;
  createdAtServer: string;
  /** Epoch of the lock hold that will commit this pin (0 = not yet stamped). */
  ownerEpoch: number;
  intent: PublicationIntentV2;
  state: PublicationPinStateV2;
  /** Frozen prepare TTL: past this time an uncommitted pin may be abandoned. */
  prepareExpiresAt: string;
  /** Owner lease expiry; with the owner provably dead and both expiries passed, the pin is abandoned. */
  ownerLeaseExpiresAt: string;
  /** Generation counter value at abandonment (null while active). */
  abandonedGeneration: number | null;
  /** Creator process identity (stamped at prepare; null for legacy pins). */
  ownerPid?: number | null;
  /** Creator per-process session token. */
  ownerProcessStartToken?: string | null;
  /** Creator process start time (Linux /proc; null where unavailable). */
  ownerProcessStartTime?: string | null;
}

/** Durable fencing record of the current lock owner (spec §8.1). */
export interface StoreFenceRecord {
  ownerPid: number;
  /** Per-PROCESS session token (a fresh mint per fence instance). */
  processStartToken: string;
  /** Process start time when readable (/proc/self/stat), else null. */
  processStartTime: string | null;
  /** The installation boot identity that was current at acquisition. */
  bootId: string;
  leaseEpoch: number;
  acquisitionNonce: string;
  durableGeneration: number;
  acquiredAt: string;
}

/** The proof an EventStore.appendBatch call must carry for v2 members. */
export interface StoreFenceProof {
  ownerPid: number;
  processStartToken: string;
  leaseEpoch: number;
  acquisitionNonce: string;
  durableGeneration: number;
}

/** Injectable environment so tests simulate process death deterministically. */
export interface PublicationStoreOptions {
  /** Publisher process identity recorded in the fence record. */
  ownerPid?: number;
  /**
   * Installation boot identity. Default reads/creates the durable boot-id
   * file under the data root — a fence from another boot session is provably
   * dead even when its PID is reused.
   */
  bootId?: string;
  /** Liveness probe for a recorded owner PID (default process.kill(pid, 0)). */
  processAlive?: (pid: number) => boolean;
  /** Injectable wall clock (ISO 8601; default Date.now). */
  clock?: () => string;
  /** Acquire-retry pause (default 25 ms; tests use 0). */
  retrySleepMs?: number;
  /**
   * Deterministic ABA test seams: pause right before the owner marker is
   * written (the mkdir->marker window) and right before the final
   * ownership verification of an acquisition. Production never sets these.
   */
  pauseBeforeMarker?: () => Promise<void>;
  pauseBeforeOwnershipVerify?: () => Promise<void>;
}

interface LockMarker {
  nonce: string;
  ownerPid: number;
  createdAt: string;
}

function sameProofFields(record: StoreFenceRecord, proof: StoreFenceProof): boolean {
  return (
    record.ownerPid === proof.ownerPid &&
    record.processStartToken === proof.processStartToken &&
    record.leaseEpoch === proof.leaseEpoch &&
    record.acquisitionNonce === proof.acquisitionNonce &&
    record.durableGeneration === proof.durableGeneration
  );
}

function proofOf(record: StoreFenceRecord): StoreFenceProof {
  return {
    ownerPid: record.ownerPid,
    processStartToken: record.processStartToken,
    leaseEpoch: record.leaseEpoch,
    acquisitionNonce: record.acquisitionNonce,
    durableGeneration: record.durableGeneration,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Strict fence-record parse shared by the store and EventStore fence checks. */
export function parseStoreFenceRecord(value: unknown): StoreFenceRecord | null {
  if (value === null || !isPlainObject(value)) return null;
  const o = value as Record<string, unknown>;
  if (
    typeof o.ownerPid !== 'number' ||
    typeof o.processStartToken !== 'string' ||
    typeof o.leaseEpoch !== 'number' ||
    typeof o.acquisitionNonce !== 'string' ||
    typeof o.durableGeneration !== 'number'
  ) {
    return null;
  }
  return {
    ownerPid: o.ownerPid,
    processStartToken: o.processStartToken,
    processStartTime:
      typeof o.processStartTime === 'string' || o.processStartTime === null ? o.processStartTime : null,
    // Legacy records (pre-Fix-1) carried the boot id in processStartToken.
    bootId: typeof o.bootId === 'string' ? o.bootId : o.processStartToken,
    leaseEpoch: o.leaseEpoch,
    acquisitionNonce: o.acquisitionNonce,
    durableGeneration: o.durableGeneration,
    acquiredAt: typeof o.acquiredAt === 'string' ? o.acquiredAt : '',
  };
}

function corruptStorage(message: string): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.TASK_CORRUPTED,
    message,
    null,
    '修复或重建该存储。',
  );
}

/**
 * Strict JSON read that distinguishes ABSENT (null) from CORRUPT (throws):
 * a corrupted pin/record/generation file must produce a diagnostic, never a
 * silent skip that could lose pin roots to GC or masquerade as a dead owner.
 */
async function readJsonStrict(path: string, what: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw corruptStorage(`${what} 不可读。`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw corruptStorage(`${what} 不是有效 JSON。`);
  }
}

/** Strict parse of one pin file; anything else fails closed. */
function parsePin(value: unknown): PublicationPinV2 {
  if (!isPlainObject(value)) throw corruptPin('pin 文件必须是对象。');
  const required: Record<string, unknown> = value;
  for (const key of [
    'pinId',
    'taskId',
    'operationId',
    'expectedTailSequence',
    'expectedTailCommitId',
    'blobRefs',
    'gcGeneration',
    'createdAtServer',
    'ownerEpoch',
    'intent',
    'state',
    'prepareExpiresAt',
    'ownerLeaseExpiresAt',
  ]) {
    if (!(key in required)) throw corruptPin(`pin 缺少字段 ${key}。`);
  }
  if (typeof required.pinId !== 'string' || typeof required.taskId !== 'string' || typeof required.operationId !== 'string') {
    throw corruptPin('pin 标识字段必须是字符串。');
  }
  if (typeof required.expectedTailSequence !== 'number' || !Number.isInteger(required.expectedTailSequence)) {
    throw corruptPin('pin expectedTailSequence 必须是整数。');
  }
  if (!Array.isArray(required.blobRefs)) throw corruptPin('pin blobRefs 必须是数组。');
  if (typeof required.gcGeneration !== 'number' || !Number.isInteger(required.gcGeneration)) {
    throw corruptPin('pin gcGeneration 必须是整数。');
  }
  if (typeof required.ownerEpoch !== 'number' || !Number.isInteger(required.ownerEpoch)) {
    throw corruptPin('pin ownerEpoch 必须是整数。');
  }
  if (required.state !== 'active' && required.state !== 'abandoned' && required.state !== 'committed') {
    throw corruptPin(`pin state 必须是 active/committed/abandoned，实际为 ${String(required.state)}。`);
  }
  const abandonedGeneration =
    typeof required.abandonedGeneration === 'number' ? required.abandonedGeneration
    : required.abandonedGeneration === null || required.abandonedGeneration === undefined ? null
    : (() => { throw corruptPin('pin abandonedGeneration 必须是整数或 null。'); })();
  if (abandonedGeneration !== null && !Number.isInteger(abandonedGeneration)) {
    throw corruptPin('pin abandonedGeneration 必须是整数或 null。');
  }
  if (!isPlainObject(required.intent)) throw corruptPin('pin intent 必须是对象。');
  const intent = required.intent as Record<string, unknown>;
  for (const key of ['handlerKind', 'handlerVersion', 'canonicalOperationPayloadRef', 'expectedResultIdentity']) {
    if (!(key in intent)) throw corruptPin(`pin intent 缺少字段 ${key}。`);
  }
  if (typeof intent.handlerKind !== 'string' || typeof intent.handlerVersion !== 'number') {
    throw corruptPin('pin intent 标识字段无效。');
  }
  const ownerPid =
    typeof required.ownerPid === 'number' ? required.ownerPid
    : required.ownerPid === null || required.ownerPid === undefined ? null
    : (() => { throw corruptPin('pin ownerPid 必须是整数或 null。'); })();
  return {
    pinId: required.pinId,
    taskId: required.taskId,
    operationId: required.operationId,
    expectedTailSequence: required.expectedTailSequence,
    expectedTailCommitId:
      typeof required.expectedTailCommitId === 'string' || required.expectedTailCommitId === null
        ? required.expectedTailCommitId
        : null,
    blobRefs: toRefs(required.blobRefs),
    gcGeneration: required.gcGeneration,
    createdAtServer: String(required.createdAtServer),
    ownerEpoch: required.ownerEpoch,
    intent: {
      handlerKind: intent.handlerKind,
      handlerVersion: intent.handlerVersion,
      canonicalOperationPayloadRef: toRef(intent.canonicalOperationPayloadRef),
      expectedResultIdentity: String(intent.expectedResultIdentity),
    },
    state: required.state,
    prepareExpiresAt: String(required.prepareExpiresAt),
    ownerLeaseExpiresAt: String(required.ownerLeaseExpiresAt),
    abandonedGeneration,
    ownerPid,
    ownerProcessStartToken:
      typeof required.ownerProcessStartToken === 'string' || required.ownerProcessStartToken === null
        ? required.ownerProcessStartToken
        : null,
    ownerProcessStartTime:
      typeof required.ownerProcessStartTime === 'string' || required.ownerProcessStartTime === null
        ? required.ownerProcessStartTime
        : null,
  };
}

function toRef(value: unknown): BlobRefV2 {
  if (!isPlainObject(value)) throw corruptPin('pin 内的 BlobRefV2 必须是对象。');
  const o = value as Record<string, unknown>;
  if (
    typeof o.kind !== 'string' ||
    typeof o.digest !== 'string' ||
    typeof o.byteLength !== 'number' ||
    typeof o.mediaType !== 'string' ||
    typeof o.schemaVersion !== 'number'
  ) {
    throw corruptPin('pin 内的 BlobRefV2 字段无效。');
  }
  return { kind: o.kind as BlobRefV2['kind'], digest: o.digest, byteLength: o.byteLength, mediaType: o.mediaType as BlobRefV2['mediaType'], schemaVersion: o.schemaVersion };
}

function toRefs(values: unknown[]): BlobRefV2[] {
  return values.map(toRef);
}

function corruptPin(message: string): StorageError {
  return new StorageError(STORAGE_ERROR_CODES.TASK_CORRUPTED, `发表 pin 损坏: ${message}`, null, '修复或重建该 pin。');
}

/** The lock directory owner marker: keeps rmdir from removing a held lock. */
const LOCK_MARKER_NAME = 'owner.json';

/** Linux /proc process facts used to disambiguate PID reuse/zombies. */
function readProcFacts(pid: number): { starttime: string; state: string } | null {
  try {
    const statLine = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // /proc/<pid>/stat field layout: comm may contain spaces/parens, so split
    // after the LAST ')' — fields 3.. follow: state(3) ... starttime(22).
    const afterComm = statLine.indexOf(')');
    if (afterComm < 0) return null;
    const fields = statLine.slice(afterComm + 2).split(' ');
    return { state: fields[0] ?? '', starttime: fields[19] ?? '' };
  } catch {
    return null; // non-Linux or process gone
  }
}

export class StoreLockFence {
  private readonly paths: CorePaths;

  private readonly options: Required<Pick<PublicationStoreOptions, 'retrySleepMs'>> &
    Pick<
      PublicationStoreOptions,
      'ownerPid' | 'processAlive' | 'clock' | 'bootId' | 'pauseBeforeMarker' | 'pauseBeforeOwnershipVerify'
    >;

  /** A fresh per-process (per fence instance) session token. */
  private readonly sessionTokenValue: string = randomUUID();

  constructor(paths: CorePaths, options: PublicationStoreOptions = {}) {
    this.paths = paths;
    this.options = {
      retrySleepMs: options.retrySleepMs ?? 25,
      ownerPid: options.ownerPid ?? process.pid,
      processAlive: options.processAlive,
      clock: options.clock,
      bootId: options.bootId,
      pauseBeforeMarker: options.pauseBeforeMarker,
      pauseBeforeOwnershipVerify: options.pauseBeforeOwnershipVerify,
    };
  }

  /** This process instance's session token (recorded as the owner identity). */
  sessionToken(): string {
    return this.sessionTokenValue;
  }

  /** The owner PID this fence instance records (injectable in tests). */
  ownerPidOf(): number {
    return this.options.ownerPid ?? process.pid;
  }

  /** This process's start time when /proc is readable (else null). */
  processStartTimeOfSelf(): string | null {
    return readProcFacts(process.pid)?.starttime ?? null;
  }

  /** The durable boot identity of this installation (created on first read). */
  async currentBootId(): Promise<string> {
    if (this.options.bootId !== undefined) return this.options.bootId;
    const file = this.paths.storeBootIdFile();
    const existing = await readJsonStrict(file, 'store boot-id 文件');
    if (existing !== null) {
      if (!isPlainObject(existing) || typeof existing.bootId !== 'string' || existing.bootId.length === 0) {
        throw corruptStorage('store boot-id 文件损坏。');
      }
      return existing.bootId as string;
    }
    const bootId = randomUUID();
    await writeNewAtomicDurable(file, Buffer.from(JSON.stringify({ bootId }), 'utf8'));
    return bootId;
  }

  nowIso(): string {
    return this.options.clock?.() ?? new Date().toISOString();
  }

  private probe(): (pid: number) => boolean {
    return this.options.processAlive ?? defaultProcessAlive;
  }

  /**
   * Fence-record owner liveness (provably-dead only): boot mismatch, PID
   * probe failure, zombie state, or a /proc-verified process-start mismatch
   * (PID reuse). Genuinely ambiguous cases (same boot, probe alive, no /proc)
   * are treated as LIVE — wall-clock expiry alone can never steal a live
   * lock, and an ambiguous owner means fail-closed LOCK_BUSY, never a steal.
   */
  async isOwnerAlive(record: StoreFenceRecord): Promise<boolean> {
    if (record.bootId !== (await this.currentBootId())) return false;
    // The injected liveness probe is the authoritative death simulator — the
    // recorded owner is dead when the probe says so, even if it is us.
    if (!this.probe()(record.ownerPid)) return false;
    if (record.ownerPid === (this.options.ownerPid ?? process.pid) && record.processStartToken === this.sessionTokenValue) {
      return true; // we are the recorded owner
    }
    const facts = readProcFacts(record.ownerPid);
    if (facts !== null) {
      if (facts.state === 'Z') return false; // zombie: no process, just a corpse
      if (record.processStartTime !== null && facts.starttime !== record.processStartTime) {
        return false; // PID reused by a different process
      }
    }
    return true;
  }

  /** Pin-creator liveness (same provable-death semantics, no boot dimension). */
  async ownerIdentityLive(fields: {
    ownerPid: number | null;
    ownerProcessStartToken: string | null;
    ownerProcessStartTime: string | null;
  }): Promise<boolean> {
    if (fields.ownerPid === null) return false;
    if (!this.probe()(fields.ownerPid)) return false;
    if (
      fields.ownerPid === (this.options.ownerPid ?? process.pid) &&
      fields.ownerProcessStartToken === this.sessionTokenValue
    ) {
      return true;
    }
    const facts = readProcFacts(fields.ownerPid);
    if (facts !== null) {
      if (facts.state === 'Z') return false;
      if (fields.ownerProcessStartTime !== null && facts.starttime !== fields.ownerProcessStartTime) {
        return false;
      }
    }
    return true;
  }

  /**
   * Reads the fence record: an ABSENT file is null (never locked/acquired in
   * this installation); an unparsable or shape-invalid file is CORRUPTION —
   * never silently treated as absent (that would let a corrupt record
   * masquerade as a dead owner and be overwritten by a takeover).
   */
  async readRecord(): Promise<StoreFenceRecord | null> {
    const value = await readJsonStrict(this.paths.storeFenceRecordFile(), 'store fence 记录');
    if (value === null) return null;
    const parsed = parseStoreFenceRecord(value);
    if (parsed === null) {
      throw corruptStorage('store fence 记录损坏。');
    }
    return parsed;
  }

  /**
   * Acquires the data-root exclusive store lock. Never steals a live lock:
   * takeover requires the recorded owner to be provably dead and the lock
   * directory's marker to belong to the doomed record (a markerless or
   * foreign-marker directory is an in-flight acquisition or an ambiguity —
   * LOCK_BUSY, never a steal). The lease epoch is advanced durably through
   * the fence record before the directory exchange, and the fresh hold is
   * verified (record nonce + own marker still present) immediately before it
   * is returned.
   */
  async acquire(timeoutMs = 30_000): Promise<LockHold> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const acquired = await this.tryAcquireOnce();
      if (acquired !== null) return acquired;
      if (Date.now() >= deadline) {
        throw new StorageError(
          STORAGE_ERROR_CODES.LOCK_BUSY,
          '跨进程 store 锁被存活的持有者占用，等待超时。',
          null,
          '稍后重试。',
        );
      }
      if (this.options.retrySleepMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.options.retrySleepMs));
      }
    }
  }

  /** Strict read of the lock-directory owner marker (absent/corrupt = null). */
  private async readMarker(lockDir: string): Promise<LockMarker | null> {
    const value = await readJsonStrict(join(lockDir, LOCK_MARKER_NAME), 'store 锁标记');
    if (value === null) return null;
    if (!isPlainObject(value)) return null;
    const o = value as Record<string, unknown>;
    if (typeof o.nonce !== 'string' || typeof o.ownerPid !== 'number') return null;
    return { nonce: o.nonce, ownerPid: o.ownerPid, createdAt: typeof o.createdAt === 'string' ? o.createdAt : '' };
  }

  private async tryAcquireOnce(): Promise<LockHold | null> {
    const lockDir = this.paths.storeLockDir();
    const nonce = randomUUID();
    const ownerPid = this.options.ownerPid ?? process.pid;
    const bootId = await this.currentBootId();
    const recordPath = this.paths.storeFenceRecordFile();
    const record: StoreFenceRecord = {
      ownerPid,
      processStartToken: this.sessionTokenValue,
      processStartTime: this.processStartTimeOfSelf(),
      bootId,
      leaseEpoch: 1,
      acquisitionNonce: nonce,
      durableGeneration: 0,
      acquiredAt: this.nowIso(),
    };

    let created = false;
    try {
      await mkdir(lockDir);
      created = true;
    } catch {
      // Lock directory exists — evaluate takeover.
    }

    if (created) {
      await this.options.pauseBeforeMarker?.();
      await this.writeMarker(lockDir, nonce, ownerPid);
      const prior = await this.readRecord();
      record.leaseEpoch = (prior?.leaseEpoch ?? 0) + 1;
      record.durableGeneration = await this.readGeneration();
      await writeReplaceAtomicDurable(recordPath, Buffer.from(JSON.stringify(record), 'utf8'));
      await this.options.pauseBeforeOwnershipVerify?.();
      // Final ownership gate: OUR nonce must still own both the record and
      // the directory marker; anything else means we lost a race and must
      // relinquish only what is provably ours.
      if (await this.holdStillOwns(lockDir, nonce, record.leaseEpoch)) {
        return new LockHold(this, record.leaseEpoch, nonce, record.durableGeneration);
      }
      await this.releaseOwnDirectory(lockDir, nonce);
      return null;
    }

    // Contested path. A live owner is never stolen; neither is a mid-flight
    // acquirer (marker absent = acquire in progress, or record absent).
    const ownerRecord = await this.readRecord();
    if (ownerRecord !== null) {
      if (await this.isOwnerAlive(ownerRecord)) return null;
    } else {
      return null; // no durable owner is provable — ambiguous, fail closed
    }
    // The owner is provably dead: only a directory whose marker belongs to
    // the doomed record may be exchanged (or a dead acquirer's orphan).
    const marker = await this.readMarker(lockDir);
    const doomedNonce = ownerRecord.acquisitionNonce;
    const markerMatchesDoomed = marker !== null && marker.nonce === doomedNonce;
    const markerOwnerDead = marker !== null && !this.probe()(marker.ownerPid);
    if (!markerMatchesDoomed && !markerOwnerDead) return null;
    record.leaseEpoch = ownerRecord.leaseEpoch + 1;
    record.durableGeneration = await this.readGeneration();
    await writeReplaceAtomicDurable(recordPath, Buffer.from(JSON.stringify(record), 'utf8'));
    // Last-writer guard: only the last record writer proceeds.
    const written = await this.readRecord();
    if (written === null || written.acquisitionNonce !== nonce || written.leaseEpoch !== record.leaseEpoch) {
      return null;
    }
    await rm(join(lockDir, LOCK_MARKER_NAME), { force: true }).catch(() => undefined);
    try {
      const contents = await readdir(lockDir);
      if (contents.length > 0) return null; // an acquirer landed inside — wait
    } catch {
      return null;
    }
    try {
      await rmdir(lockDir);
    } catch {
      return null;
    }
    try {
      await mkdir(lockDir);
      await this.options.pauseBeforeMarker?.();
      await this.writeMarker(lockDir, nonce, ownerPid);
      await this.options.pauseBeforeOwnershipVerify?.();
      if (await this.holdStillOwns(lockDir, nonce, record.leaseEpoch)) {
        return new LockHold(this, record.leaseEpoch, nonce, record.durableGeneration);
      }
      await this.releaseOwnDirectory(lockDir, nonce);
    } catch {
      await this.releaseOwnDirectory(lockDir, nonce).catch(() => undefined);
    }
    return null;
  }

  /**
   * Final ownership proof before a hold is returned: the record must still
   * carry our nonce at OUR epoch AND the lock directory must still carry OUR
   * marker (a takeover or an ABA exchange in between fails the gate).
   */
  private async holdStillOwns(lockDir: string, nonce: string, epoch: number): Promise<boolean> {
    const current = await this.readRecord();
    if (current === null || current.acquisitionNonce !== nonce || current.leaseEpoch !== epoch) return false;
    const marker = await this.readMarker(lockDir);
    return marker !== null && marker.nonce === nonce && marker.ownerPid === (this.options.ownerPid ?? process.pid);
  }

  private async writeMarker(lockDir: string, nonce: string, ownerPid: number): Promise<void> {
    const marker: LockMarker = { nonce, ownerPid, createdAt: this.nowIso() };
    try {
      await writeFile(join(lockDir, LOCK_MARKER_NAME), JSON.stringify(marker), { flag: 'wx' });
    } catch {
      await writeFile(join(lockDir, LOCK_MARKER_NAME), JSON.stringify(marker), { flag: 'w' });
    }
  }

  /**
   * Ownership-checked directory release: NEVER removes a directory whose
   * marker is not ours (a superseded hold must not destroy a successor's
   * lock directory). No-ops when the marker is absent or foreign.
   */
  async releaseOwnDirectory(lockDir: string, nonce: string): Promise<void> {
    const marker = await this.readMarker(lockDir);
    if (marker === null || marker.nonce !== nonce) return;
    await rm(join(lockDir, LOCK_MARKER_NAME), { force: true }).catch(() => undefined);
    await rmdir(lockDir).catch(() => undefined);
  }

  /** Lock-path accessor for LockHold.release. */
  lockDirectoryPath(): string {
    return this.paths.storeLockDir();
  }

  /** Durable monotonic generation counter (missing file = generation 0). */
  async readGeneration(): Promise<number> {
    const value = await readJsonStrict(this.paths.v2GenerationFile(), 'v2 generation 计数文件');
    if (value === null) return 0;
    if (
      !isPlainObject(value) ||
      typeof value.generation !== 'number' ||
      !Number.isInteger(value.generation) ||
      value.generation < 0
    ) {
      throw corruptStorage('v2 generation 计数器文件损坏。');
    }
    return value.generation;
  }
}

/** Default liveness probe: process.kill(pid, 0) via the injected default. */
function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A held store lock; release() only ever removes what is provably ours. */
export class LockHold {
  readonly epoch: number;

  readonly nonce: string;

  generation: number;

  private readonly fence: StoreLockFence;

  private released = false;

  constructor(fence: StoreLockFence, epoch: number, nonce: string, generation: number) {
    this.fence = fence;
    this.epoch = epoch;
    this.nonce = nonce;
    this.generation = generation;
  }

  /** Proof minted from the current fence record (valid while this hold lives). */
  async proof(): Promise<StoreFenceProof> {
    const record = await this.fence.readRecord();
    if (record === null || record.acquisitionNonce !== this.nonce || record.leaseEpoch !== this.epoch) {
      throw new StorageError(
        STORAGE_ERROR_CODES.LOCK_SUPERSEDED,
        'store 锁记录已被替换，本次持有不再有效。',
        null,
        '重新获取锁。',
      );
    }
    return proofOf(record);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.fence.releaseOwnDirectory(this.fence.lockDirectoryPath(), this.nonce);
  }
}

export interface AbandonResult {
  /** Pin ids newly transitioned to abandoned. */
  abandoned: string[];
}

/**
 * Durable publication pin store + the shared store lock/fence + generation
 * barrier for one installation data root.
 */
export class AuthoritativePublicationStore {
  private readonly paths: CorePaths;

  private readonly fence: StoreLockFence;

  constructor(paths: CorePaths, options: PublicationStoreOptions = {}) {
    this.paths = paths;
    this.fence = new StoreLockFence(paths, options);
  }

  /** The shared cross-process lock/fence (facade commit and GC use this one). */
  lock(): StoreLockFence {
    return this.fence;
  }

  async readGeneration(): Promise<number> {
    return this.fence.readGeneration();
  }

  /**
   * Advances the durable generation counter AND the fence record's
   * generation while this hold is current. Only the lock holder may advance;
   * GC compares its mark-start generation against object generations.
   */
  async advanceGeneration(hold: LockHold): Promise<number> {
    const next = (await this.fence.readGeneration()) + 1;
    await writeReplaceAtomicDurable(
      this.paths.v2GenerationFile(),
      Buffer.from(JSON.stringify({ generation: next }), 'utf8'),
    );
    const record = await this.fence.readRecord();
    if (record !== null) {
      await writeReplaceAtomicDurable(
        this.paths.storeFenceRecordFile(),
        Buffer.from(JSON.stringify({ ...record, durableGeneration: next }), 'utf8'),
      );
    }
    hold.generation = next;
    return next;
  }

  /**
   * Durable pin creation. The same operationId with equal refs/intent is
   * idempotent (returns the existing pin); a different payload conflicts
   * (PIN_CONFLICT) — never last-writer-wins. `pinId` is store-derived.
   */
  async createPin(
    input: Omit<PublicationPinV2, 'pinId' | 'state'> & { state?: PublicationPinStateV2 },
  ): Promise<PublicationPinV2> {
    const pinId = `pin-${randomUUID()}`;
    const pin: PublicationPinV2 = {
      ...input,
      pinId,
      state: input.state ?? 'active',
      abandonedGeneration: input.abandonedGeneration ?? null,
      ownerPid: input.ownerPid ?? null,
      ownerProcessStartToken: input.ownerProcessStartToken ?? null,
      ownerProcessStartTime: input.ownerProcessStartTime ?? null,
    };
    const existing = await this.findPinByOperation(pin.taskId, pin.operationId);
    if (existing !== null) {
      if (samePublicationInstance(existing, pin)) return existing;
      throw new StorageError(
        STORAGE_ERROR_CODES.PIN_CONFLICT,
        '同一 operationId 已经以不同载荷发表。',
        null,
        '使用新的 operationId 或与既有载荷一致的引用重试。',
      );
    }
    await writeNewAtomicDurable(this.paths.publicationPinFile(pinId), Buffer.from(JSON.stringify(pin), 'utf8'));
    return pin;
  }

  async readPin(pinId: string): Promise<PublicationPinV2 | null> {
    const value = await readJsonStrict(this.paths.publicationPinFile(pinId), `pin ${pinId}`);
    if (value === null) return null;
    return parsePin(value);
  }

  /**
   * Every current pin file (active + abandoned), strictly parsed. A corrupt
   * pin file FAILS CLOSED (TASK_CORRUPTED) — a corrupted abandoned pin must
   * never lose its blob roots silently to GC.
   */
  async snapshotPins(): Promise<PublicationPinV2[]> {
    let names: string[];
    try {
      names = await readdir(this.paths.publicationPinsRoot());
    } catch {
      return [];
    }
    const out: PublicationPinV2[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue; // committed-* markers are audit only
      if (name.startsWith('.tmp-')) continue;
      const pinId = name.slice(0, -'.json'.length);
      const value = await readJsonStrict(this.paths.publicationPinFile(pinId), `pin ${pinId}`);
      if (value === null) continue;
      out.push(parsePin(value));
    }
    return out;
  }

  private async findPinByOperation(taskId: string, operationId: string): Promise<PublicationPinV2 | null> {
    const pins = await this.snapshotPins();
    return pins.find((pin) => pin.taskId === taskId && pin.operationId === operationId) ?? null;
  }

  /**
   * Durable commit terminal: rewrite the pin with `state: committed`, write
   * the durable committed-marker, then remove the pin file. A crash between
   * the marker and the removal is cleaned by `cleanCommittedOrphanPins`.
   */
  async markPinCommittedAndRemove(pinId: string): Promise<void> {
    const pin = await this.readPin(pinId);
    if (pin === null) return;
    const terminal = { ...pin, state: 'committed' as const };
    await writeReplaceAtomicDurable(
      this.paths.publicationPinFile(pinId),
      Buffer.from(JSON.stringify(terminal), 'utf8'),
    );
    await writeNewAtomicDurable(
      join(this.paths.publicationPinsRoot(), `committed-${pinId}`),
      Buffer.from(JSON.stringify({ pinId, committedAt: this.fence.nowIso() }), 'utf8'),
    );
    await rm(this.paths.publicationPinFile(pinId), { force: true });
  }

  /** Removes pin files whose terminal committed marker exists (audit markers stay). */
  async cleanCommittedOrphanPins(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.paths.publicationPinsRoot());
    } catch {
      return [];
    }
    const cleaned: string[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const pinId = name.slice(0, -'.json'.length);
      const value = await readJsonStrict(this.paths.publicationPinFile(pinId), `pin ${pinId}`);
      if (value === null) continue;
      const pin = parsePin(value);
      if (pin.state !== 'committed') continue;
      await rm(this.paths.publicationPinFile(pinId), { force: true });
      cleaned.push(pin.pinId);
    }
    return cleaned;
  }

  /**
   * Abandonment gating: an uncommitted ACTIVE pin becomes abandoned only when
   * the frozen prepare TTL AND the owner lease both passed AND the owner is
   * provably dead — the creator's process identity stamped at prepare (or, on
   * legacy pins, the fence-epoch owner chain). Wall-clock expiry alone never
   * abandons a pin whose creator is live. `abandonedGeneration` freezes the
   * current generation so GC quarantines the pin for at least one additional
   * full generation.
   */
  async tryAbandonExpiredPins(): Promise<AbandonResult> {
    const pins = await this.snapshotPins();
    const record = await this.fence.readRecord();
    const now = this.fence.nowIso();
    const abandoned: string[] = [];
    for (const pin of pins) {
      if (pin.state !== 'active') continue;
      if (now <= pin.prepareExpiresAt || now <= pin.ownerLeaseExpiresAt) continue;
      if (pin.ownerPid !== undefined && pin.ownerPid !== null) {
        // Creator-stamped pin: liveness is proven by the creator process.
        if (
          await this.fence.ownerIdentityLive({
            ownerPid: pin.ownerPid,
            ownerProcessStartToken: pin.ownerProcessStartToken ?? null,
            ownerProcessStartTime: pin.ownerProcessStartTime ?? null,
          })
        ) {
          continue;
        }
      } else if (await this.isPinProtectedByLiveOwner(pin, record)) {
        continue;
      }
      const next = { ...pin, state: 'abandoned' as const, abandonedGeneration: await this.fence.readGeneration() };
      await writeReplaceAtomicDurable(
        this.paths.publicationPinFile(pin.pinId),
        Buffer.from(JSON.stringify(next), 'utf8'),
      );
      abandoned.push(pin.pinId);
    }
    return { abandoned };
  }

  private async isPinProtectedByLiveOwner(pin: PublicationPinV2, record: StoreFenceRecord | null): Promise<boolean> {
    if (pin.ownerEpoch === 0 || record === null) return false;
    if (record.leaseEpoch !== pin.ownerEpoch) return false;
    return this.fence.isOwnerAlive(record);
  }

  /** True when the pin's creator/owner chain is currently live. */
  async pinOwnerIsLive(pin: PublicationPinV2): Promise<boolean> {
    if (pin.ownerPid !== undefined && pin.ownerPid !== null) {
      return this.fence.ownerIdentityLive({
        ownerPid: pin.ownerPid,
        ownerProcessStartToken: pin.ownerProcessStartToken ?? null,
        ownerProcessStartTime: pin.ownerProcessStartTime ?? null,
      });
    }
    const record = await this.fence.readRecord();
    return this.isPinProtectedByLiveOwner(pin, record);
  }

  /**
   * GC sweep of quarantined abandoned pins: a pin past `abandonedGeneration +
   * 1` has survived at least one additional full GC generation and its pin
   * file may be removed (its objects are swept by the same GC run).
   */
  async sweepQuarantinedPins(markStartGeneration: number): Promise<string[]> {
    const pins = await this.snapshotPins();
    const swept: string[] = [];
    for (const pin of pins) {
      if (pin.state !== 'abandoned' || pin.abandonedGeneration === null) continue;
      if (markStartGeneration <= pin.abandonedGeneration + 1) continue;
      await rm(this.paths.publicationPinFile(pin.pinId), { force: true });
      swept.push(pin.pinId);
    }
    return swept;
  }

  /**
   * Durable back-fill of the deterministic result identity on an ACTIVE pin
   * (facade prepare/commit computes it after the first build). No-op when the
   * recorded identity already matches.
   */
  async rewritePinIdentity(pinId: string, computedIdentity: string): Promise<void> {
    const pin = await this.readPin(pinId);
    if (pin === null || pin.state !== 'active') return;
    if (pin.intent.expectedResultIdentity === computedIdentity) return;
    await writeReplaceAtomicDurable(
      this.paths.publicationPinFile(pinId),
      Buffer.from(
        JSON.stringify({
          ...pin,
          intent: { ...pin.intent, expectedResultIdentity: computedIdentity },
        }),
        'utf8',
      ),
    );
  }

  /**
   * Durable owner attribution: the lock hold that is about to commit stamps
   * its epoch onto the pin and refreshes the owner lease window. Pins with
   * epoch 0 are unattributed; abandonment never treats them as live unless
   * the creator identity proves them so.
   */
  async rewritePinOwner(pinId: string, epoch: number, now: string, ownerLeaseMs: number): Promise<void> {
    const pin = await this.readPin(pinId);
    if (pin === null || pin.state !== 'active') return;
    await writeReplaceAtomicDurable(
      this.paths.publicationPinFile(pinId),
      Buffer.from(
        JSON.stringify({
          ...pin,
          ownerEpoch: epoch,
          ownerLeaseExpiresAt: new Date(new Date(now).getTime() + ownerLeaseMs).toISOString(),
        }),
        'utf8',
      ),
    );
  }
}

/** Semantic identity comparison: operation/tail/refs/intent decide idempotency. */
function samePublicationInstance(a: PublicationPinV2, b: PublicationPinV2): boolean {
  if (a.taskId !== b.taskId || a.operationId !== b.operationId) return false;
  if (a.expectedTailSequence !== b.expectedTailSequence || a.expectedTailCommitId !== b.expectedTailCommitId) {
    return false;
  }
  if (a.blobRefs.length !== b.blobRefs.length) return false;
  for (let i = 0; i < a.blobRefs.length; i += 1) {
    const ra = a.blobRefs[i];
    const rb = b.blobRefs[i];
    if (ra === undefined || rb === undefined || !refEqual(ra, rb)) return false;
  }
  return (
    a.intent.handlerKind === b.intent.handlerKind &&
    a.intent.handlerVersion === b.intent.handlerVersion &&
    a.intent.expectedResultIdentity === b.intent.expectedResultIdentity &&
    refEqual(a.intent.canonicalOperationPayloadRef, b.intent.canonicalOperationPayloadRef)
  );
}

function refEqual(a: BlobRefV2, b: BlobRefV2): boolean {
  return (
    a.kind === b.kind &&
    a.digest === b.digest &&
    a.byteLength === b.byteLength &&
    a.mediaType === b.mediaType &&
    a.schemaVersion === b.schemaVersion
  );
}

export { sameProofFields as fenceRecordMatchesProof };