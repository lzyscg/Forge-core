/**
 * Task 11 fenced v2 task deletion (spec §10.5, design §19.1 prose): the v2
 * delete is a lifecycle operation, NOT the legacy recursive directory removal.
 *
 * Flow (same installation store fence):
 *  1. reproject/consult the installation task index; reject a CONFLICTING
 *     delete operation (idempotency: same operationId + same canonical body
 *     replays the committed tombstone result even after a crash);
 *  2. durably write the `prepared` tombstone OUTSIDE the task directory;
 *  3. block every facade append/lease-claim/timer/recovery/read with
 *     `TASK_DELETED` (callers consult `assertNotDeleted` before acting; the
 *     scheduler/startup-recovery/lifecycle receive the deletion gate injected);
 *  4. remove the task's durable wakeups;
 *  5. mark every active publication pin of the task NON-REPLAYABLE by
 *     renaming it away from the `*.json` scan surface (a rebuilt pin must
 *     never resurrect a deleted task's batch);
 *  6. atomically rename the task root into the installation trash
 *     (`dataRoot/trash/<taskId>-<deleteEpoch>`), fsyncing BOTH parents;
 *  7. advance the tombstone to `detached` and release the fence;
 *  8. asynchronously purge the quarantine recursively and advance to
 *     `purged`; crash at ANY phase resumes from the tombstone.
 *
 * A directory that REAPPEARS for a tombstoned id is quarantined as an orphan
 * and never scheduled (no resurrection). The tombstone is retained per
 * installation policy and prevents task-ID reuse.
 */
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CorePaths } from './core-paths';
import { isSafeSegment } from './core-paths';
import { STORAGE_ERROR_CODES, StorageError, writeNewAtomicDurable, writeReplaceAtomicDurable, syncDirectory } from './atomic-file';
import { deletedTaskTombstoneFile, deletedTasksRoot } from './authoritative-task-index';
import type { AuthoritativeTaskIndexV1 } from './authoritative-task-index';
import type { AuthoritativeWakeupIndexV1 } from '../runtime/authoritative-review/wakeup-index';
import type { PublicationPinV2 } from './authoritative-publication-store';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';

/** The frozen server-fixed local owner principal (spec §10.3.1/§10.5). */
export const TASK_OWNER_PRINCIPAL = { id: 'task_owner', permissions: ['task:reopen_failed', 'task:delete'] } as const;

/** Stable public deletion code. */
export type TaskDeleteErrorCodeV2 =
  | 'TASK_DELETED'
  | 'DELETE_CONFLICT'
  | 'DELETE_NOT_FOUND'
  | 'DELETE_TOMBSTONE_CORRUPT';

export class TaskDeleteError extends Error {
  readonly code: TaskDeleteErrorCodeV2;

  /** Public envelope members (iron rule 6). */
  readonly location: string | null = null;

  readonly action: string | null = null;

  constructor(code: TaskDeleteErrorCodeV2, message: string) {
    super(message);
    this.name = 'TaskDeleteError';
    this.code = code;
  }
}

/** The durable deletion tombstone (spec §10.5 exact shape). */
export interface DeletedTaskTombstoneV2 {
  protocolVersion: 2;
  taskId: string;
  templateSnapshotHash: string;
  deleteOperationId: string;
  requestedBy: string;
  reason: string;
  observedTailCommitId: string | null;
  deleteEpoch: number;
  state: 'prepared' | 'detached' | 'purged';
  createdAt: string;
}

/** The public delete result (spec §10.5 — detached or purged, never prepared). */
export interface DeleteTaskResultV2 {
  operationId: string;
  state: 'detached' | 'purged';
}

/** The fenced delete request (client body + server-fixed owner principal). */
export interface DeleteTaskRequestV2 {
  operationId: string;
  reason: string;
  /** Always the server-fixed local principal; client actor fields are ignored. */
  requestedBy?: string;
}

export interface AuthoritativeTaskDeletionDependencies {
  paths: CorePaths;
  index: AuthoritativeTaskIndexV1;
  wakeups: AuthoritativeWakeupIndexV1;
  /** Injectable fence: tombstone advancement runs under the store fence. */
  withStoreFence?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Durable pin snapshot (Task 8 seam — never guessed). */
  snapshotPins?: () => Promise<ReadonlyArray<Readonly<Pick<PublicationPinV2, 'pinId' | 'taskId'>>>>;
  /** Remove one pin file (mark non-replayable). */
  renamePinFile?: (pinId: string, detachedName: string) => Promise<void>;
  clock?: () => string;
}

function corrupted(message: string): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.TASK_CORRUPTED,
    `删除墓碑损坏: ${message}`,
    null,
    '联系平台检查删除墓碑文件。',
  );
}

function noFence<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

function parseTombstone(raw: string, file: string): DeletedTaskTombstoneV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corrupted(`${file} 不是有效 JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw corrupted(`${file} 畸形`);
  const o = parsed as Record<string, unknown>;
  if (
    o.protocolVersion !== 2 ||
    typeof o.taskId !== 'string' ||
    !isSafeSegment(o.taskId) ||
    typeof o.templateSnapshotHash !== 'string' ||
    typeof o.deleteOperationId !== 'string' ||
    typeof o.requestedBy !== 'string' ||
    typeof o.reason !== 'string' ||
    (o.observedTailCommitId !== null && typeof o.observedTailCommitId !== 'string') ||
    typeof o.deleteEpoch !== 'number' ||
    (o.state !== 'prepared' && o.state !== 'detached' && o.state !== 'purged') ||
    typeof o.createdAt !== 'string'
  ) {
    throw corrupted(`${file} 字段非法`);
  }
  return o as unknown as DeletedTaskTombstoneV2;
}

/** The installation trash root (quarantine of detached task roots). */
export function deletionTrashRoot(paths: CorePaths): string {
  return join(paths.dataRoot, 'trash');
}

export function deletionTrashPath(paths: CorePaths, taskId: string, deleteEpoch: number): string {
  if (!isSafeSegment(taskId)) throw new Error(`task-deletion: unsafe taskId '${taskId}'`);
  return join(deletionTrashRoot(paths), `${taskId}-${deleteEpoch}`);
}

/**
 * The fenced deletion engine. Runs the prepared→detached→purged tombstone
 * machine; every phase is crash-resumable and idempotent under the fence.
 */
export class AuthoritativeTaskDeletionV2 {
  private readonly paths: CorePaths;

  private readonly index: AuthoritativeTaskIndexV1;

  private readonly wakeups: AuthoritativeWakeupIndexV1;

  private readonly withStoreFence: <T>(fn: () => Promise<T>) => Promise<T>;

  private readonly snapshotPins: () => Promise<ReadonlyArray<Readonly<Pick<PublicationPinV2, 'pinId' | 'taskId'>>>>;

  private readonly renamePinFile: (pinId: string, detachedName: string) => Promise<void>;

  private readonly clock: () => string;

  constructor(deps: AuthoritativeTaskDeletionDependencies) {
    this.paths = deps.paths;
    this.index = deps.index;
    this.wakeups = deps.wakeups;
    this.withStoreFence = deps.withStoreFence ?? noFence;
    // The production wiring owns the real Task 8 pin snapshot (the adapter
    // lives in CoreService construction); tests inject an honest pin reader.
    this.snapshotPins = deps.snapshotPins ?? (async () => []);
    this.renamePinFile =
      deps.renamePinFile ??
      (async (pinId, detachedName) => {
        const source = join(this.paths.publicationPinsRoot(), `${pinId}.json`);
        const target = join(this.paths.publicationPinsRoot(), detachedName);
        await rename(source, target);
      });
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  async tombstoneFor(taskId: string): Promise<DeletedTaskTombstoneV2 | null> {
    try {
      return parseTombstone(
        await readFile(deletedTaskTombstoneFile(this.paths, taskId), 'utf8'),
        `${taskId}.json`,
      );
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  }

  async listTombstones(): Promise<DeletedTaskTombstoneV2[]> {
    let names: string[] = [];
    try {
      names = await readdir(deletedTasksRoot(this.paths));
    } catch {
      return [];
    }
    const out: DeletedTaskTombstoneV2[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const taskId = name.slice(0, -'.json'.length);
      if (!isSafeSegment(taskId)) continue;
      const tombstone = await this.tombstoneFor(taskId);
      if (tombstone !== null) out.push(tombstone);
    }
    return out;
  }

  /** Blocks every facade/read/claim path with the stable TASK_DELETED code. */
  async assertNotDeleted(taskId: string): Promise<void> {
    const tombstone = await this.tombstoneFor(taskId);
    if (tombstone !== null && tombstone.state !== 'purged') {
      throw new TaskDeleteError('TASK_DELETED', `任务 ${taskId} 正在删除或已删除。`);
    }
  }

  /** True when the task is deleted (purged tombstones included). */
  async isDeleted(taskId: string): Promise<boolean> {
    return (await this.tombstoneFor(taskId)) !== null;
  }

  /**
   * The retained row refs of a deleted v2 task (identity retention): the
   * prepared/active ROW keeps the profile/alias refs forever, which is what
   * "the tombstone retains the roots through the detached quarantine" means —
   * the index still answers `entryFor` for a detached/purged task. These refs
   * are NEVER merged into the GC root provider (their blobs live in the
   * installation trash, outside the sweep surface — see the index's
   * `gcRootsProvider`); CoreService/startup read them for audit and for the
   * detached→purged tombstone bookkeeping.
   */
  async retainedRootsFor(taskId: string): Promise<BlobRefV2[]> {
    const tombstone = await this.tombstoneFor(taskId);
    if (tombstone === null || tombstone.state === 'purged') return [];
    const row = await this.index.entryFor(taskId);
    if (row === null || row.state === 'legacy_preexisting') return [];
    return [row.profileSnapshotRef, row.templateSnapshotRef];
  }

  /**
   * The fenced delete (spec §10.5). Same operationId + same canonical body
   * replays the committed result; a different operation conflicts BEFORE any
   * tombstone write; missing/unknown fields fail before deletion begins.
   */
  async runDelete(taskId: string, request: DeleteTaskRequestV2): Promise<DeleteTaskResultV2> {
    if (request.operationId.length === 0 || request.reason.trim().length === 0) {
      throw new TaskDeleteError('DELETE_NOT_FOUND', '删除请求必须携带 operationId 与原因。');
    }
    return this.withStoreFence(async () => {
      const existing = await this.tombstoneFor(taskId);
      if (existing !== null && existing.deleteOperationId === request.operationId) {
        // Response-loss replay: same operation returns the committed state.
        if (existing.reason === request.reason) {
          if (existing.state === 'prepared') {
            // Review A-M2: a crash between prepared and detached must not be
            // reported as detached. Re-attempt the detachment idempotently
            // (ENOENT = already moved is fine) and advance the tombstone only
            // after the rename succeeded; a persistent rename failure keeps
            // the durable prepared state and surfaces it loudly.
            await this.detachTask(taskId, existing);
            await this.writeDetached(taskId, existing, existing.deleteEpoch);
          }
          return {
            operationId: existing.deleteOperationId,
            state: existing.state === 'purged' ? 'purged' : 'detached',
          };
        }
        throw new TaskDeleteError('DELETE_CONFLICT', '同一删除操作携带了不同的原因。');
      }
      if (existing !== null && existing.state !== 'purged') {
        throw new TaskDeleteError('DELETE_CONFLICT', `任务 ${taskId} 已存在删除操作 ${existing.deleteOperationId}。`);
      }
      if (existing !== null && existing.state === 'purged') {
        // Purged + different operation: the ID is retired forever.
        throw new TaskDeleteError('DELETE_CONFLICT', `任务 ${taskId} 已删除，任务 ID 不可复用。`);
      }
      const deleteEpoch = (existing?.deleteEpoch ?? 0) + 1;
      const tombstone: DeletedTaskTombstoneV2 = {
        protocolVersion: 2,
        taskId,
        templateSnapshotHash: existing?.templateSnapshotHash ?? '',
        deleteOperationId: request.operationId,
        requestedBy: TASK_OWNER_PRINCIPAL.id,
        reason: request.reason,
        observedTailCommitId: null,
        deleteEpoch,
        state: 'prepared',
        createdAt: this.clock(),
      };
      await mkdir(deletedTasksRoot(this.paths), { recursive: true });
      await writeNewAtomicDurable(
        deletedTaskTombstoneFile(this.paths, taskId),
        Buffer.from(`${JSON.stringify(tombstone, null, 2)}\n`, 'utf8'),
      );
      const detached = { ...tombstone, state: 'detached' as const };
      await this.detachTask(taskId, tombstone);
      await writeReplaceAtomicDurable(
        deletedTaskTombstoneFile(this.paths, taskId),
        Buffer.from(`${JSON.stringify(detached, null, 2)}\n`, 'utf8'),
      );
      // The confirmed result is the fenced DETACHED state (§10.5: detached is
      // written before the fence releases). The recursive purge happens
      // AFTERWARD via purgeTask (crash-resumed from the tombstone).
      return { operationId: request.operationId, state: 'detached' };
    });
  }

  /**
   * Recovery/cleanup steps shared by runDelete and startup resume (fenced):
   * wakeup removal, pin non-replayability, atomic quarantine rename + parent
   * fsync, then the async recursive purge advancing to purged.
   */
  private async detachTask(taskId: string, tombstone: DeletedTaskTombstoneV2): Promise<void> {
    await this.wakeups.removeTask(taskId);
    // Mark every active pin of this task NON-REPLAYABLE (rename off the *.json
    // scan surface); a rebuilt pin must never resurrect the task's batch.
    for (const pin of await this.snapshotPins()) {
      if (pin.taskId !== taskId) continue;
      try {
        await this.renamePinFile(pin.pinId, `${pin.pinId}.json.detached-${tombstone.deleteEpoch}`);
      } catch {
        // The pin may already be cleaned by another instance — non-fatal.
      }
    }
    // Atomic quarantine rename with BOTH parent fsyncs.
    await mkdir(deletionTrashRoot(this.paths), { recursive: true });
    const source = this.paths.taskRoot(taskId);
    const target = deletionTrashPath(this.paths, taskId, tombstone.deleteEpoch);
    let sourceMissing = false;
    try {
      if ((await stat(source)).isDirectory()) {
        // A same-target trash dir from a crashed earlier attempt is removed
        // only after it is provably ours (epoch-keyed — never foreign data).
        await rm(target, { recursive: true, force: true });
        await rename(source, target);
        await syncDirectory(this.paths.tasksRoot);
        await syncDirectory(deletionTrashRoot(this.paths));
      } else {
        sourceMissing = true;
      }
    } catch (error) {
      // Review A-M2: only ENOENT (the root was already moved by an earlier
      // detachment) is deletion recovery. ANY other rename failure keeps the
      // prepared tombstone — the caller must never report detached.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        sourceMissing = true;
      } else {
        throw error;
      }
    }
    void sourceMissing;
  }

  /** Writes the durable detached state (fenced callers only). */
  private async writeDetached(taskId: string, tombstone: DeletedTaskTombstoneV2, _deleteEpoch: number): Promise<void> {
    const detached = { ...tombstone, state: 'detached' as const };
    await writeReplaceAtomicDurable(
      deletedTaskTombstoneFile(this.paths, taskId),
      Buffer.from(`${JSON.stringify(detached, null, 2)}
`, 'utf8'),
    );
  }

  /** Recursive purge of the detached quarantine; crash-resumable. */
  async purgeTask(taskId: string, deleteEpoch: number): Promise<void> {
    const target = deletionTrashPath(this.paths, taskId, deleteEpoch);
    try {
      await rm(target, { recursive: true, force: true });
    } catch {
      // Review A-M4: a locking filesystem may keep the directory. The
      // tombstone stays DETACHED and the purge is retried on the next
      // startup — purged is only written AFTER the rm succeeded.
      return;
    }
    const current = await this.tombstoneFor(taskId);
    if (current !== null && current.state !== 'purged') {
      await writeReplaceAtomicDurable(
        deletedTaskTombstoneFile(this.paths, taskId),
        Buffer.from(`${JSON.stringify({ ...current, state: 'purged' }, null, 2)}\n`, 'utf8'),
      );
    }
  }

  /**
   * Startup recovery from every tombstone phase (spec §10.5 "a crash at any
   * phase is resumed from the tombstone"; a reappearing directory is
   * quarantined and never revives).
   */
  async runStartupRecovery(): Promise<{ resumed: string[]; purged: string[] }> {
    const resumed: string[] = [];
    const purged: string[] = [];
    await this.withStoreFence(async () => {
      for (const tombstone of await this.listTombstones()) {
        if (tombstone.state === 'purged') {
          // Retained: prevents ID reuse and directory resurrection forever.
          await this.quarantineReappeared(tombstone);
          purged.push(tombstone.taskId);
          continue;
        }
        if (tombstone.state === 'prepared') {
          // Crash between prepared and detached: re-run the detachment.
          await this.detachTask(tombstone.taskId, { ...tombstone, state: 'prepared' });
          await writeReplaceAtomicDurable(
            deletedTaskTombstoneFile(this.paths, tombstone.taskId),
            Buffer.from(`${JSON.stringify({ ...tombstone, state: 'detached' }, null, 2)}\n`, 'utf8'),
          );
          await this.purgeTask(tombstone.taskId, tombstone.deleteEpoch);
          resumed.push(tombstone.taskId);
          continue;
        }
        // detached: resume the purge.
        await this.purgeTask(tombstone.taskId, tombstone.deleteEpoch);
        resumed.push(tombstone.taskId);
      }
    });
    return { resumed, purged };
  }

  /** A reappearing directory for a tombstoned ID is quarantined, never revived. */
  private async quarantineReappeared(tombstone: DeletedTaskTombstoneV2): Promise<void> {
    const source = this.paths.taskRoot(tombstone.taskId);
    try {
      if (!(await stat(source)).isDirectory()) return;
    } catch {
      return;
    }
    const target = join(deletionTrashRoot(this.paths), `.revived-${tombstone.taskId}-${tombstone.deleteEpoch}`);
    await mkdir(deletionTrashRoot(this.paths), { recursive: true });
    await rename(source, target);
    await syncDirectory(this.paths.tasksRoot);
  }
}