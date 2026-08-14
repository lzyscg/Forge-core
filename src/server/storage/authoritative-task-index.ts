/**
 * Task 11 installation task index (spec §10.5, design §19.1 prose): the
 * installation-level immutable v2 task/protocol identity used even when the
 * task root is corrupt or detached.
 *
 * On-disk layout (all under the data root):
 * - `task-index/index.json` — the durable row set (one object per task).
 * - `task-index/migration-staging.json` — the fenced pre-marker capture; a
 *   crash before marker completion resumes the SAME captured set.
 * - `task-index/migration-marker.json` — the completed `authoritative-task-
 *   index-migration-v1` marker; v2 task creation stays disabled until it is
 *   durably present.
 *
 * Row states (spec §10.5): `prepared` | `active` | `legacy_preexisting`.
 * `TaskStore.create` is the sole ID allocator and advances prepared→active
 * under the installation fence; listing/opening ignores prepared entries and
 * directories without an active matching index for newly created v2 tasks.
 * `legacy_preexisting` rows permit view/delete through existing legacy rules
 * without claiming parse validity; their IDs can never be reused for v2.
 *
 * GC: every prepared/active row's `profileSnapshotRef` and
 * `templateSnapshotRef` (the frozen-template alias) are FORMAL GC roots;
 * tombstoned rows are excluded from the root provider (their blobs live in
 * the installation trash, outside the GC sweep surface) while the ROW itself
 * stays — the tombstone retains the identity, not resolvable roots. Creation
 * recovery resolves prepared entries before GC may sweep that task.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';
import type { CorePaths } from './core-paths';
import { isSafeSegment } from './core-paths';
import { STORAGE_ERROR_CODES, StorageError, writeNewAtomicDurable, writeReplaceAtomicDurable } from './atomic-file';

export const TASK_INDEX_MIGRATION_VERSION = 'authoritative-task-index-migration-v1' as const;

/** Stable public index error codes. */
export type TaskIndexErrorCodeV2 =
  | 'MIGRATION_INCOMPLETE' // v2 create before the barrier marker
  | 'ID_UNAVAILABLE' // tombstoned / legacy-preexisting / already indexed id
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_STATE_CONFLICT'
  | 'INDEX_CORRUPT';

export class TaskIndexError extends Error {
  readonly code: TaskIndexErrorCodeV2;

  /** Public envelope members (iron rule 6). */
  readonly location: string | null = null;

  readonly action: string | null = null;

  constructor(code: TaskIndexErrorCodeV2, message: string) {
    super(message);
    this.name = 'TaskIndexError';
    this.code = code;
  }
}

/** One immutable v2 identity row (state advances prepared → active). */
export interface PreparedActiveTaskRowV2 {
  protocolVersion: 2;
  taskId: string;
  protocol: 'v2';
  templateSnapshotHash: string;
  /** The frozen profile snapshot ref (formal GC root, spec §4.3/§8). */
  profileSnapshotRef: BlobRefV2;
  /** The frozen template snapshot ref (the frozen-template alias root). */
  templateSnapshotRef: BlobRefV2;
  state: 'prepared' | 'active';
  createdAt: string;
}

/** A pre-marker directory captured by the fenced migration barrier. */
export interface LegacyPreexistingTaskRowV2 {
  protocolVersion: 2;
  taskId: string;
  state: 'legacy_preexisting';
  createdAt: string;
}

export type TaskIndexRowV2 = PreparedActiveTaskRowV2 | LegacyPreexistingTaskRowV2;

/** The migration-barrier capture (crash-resume snapshot). */
export interface MigrationStagingV2 {
  version: typeof TASK_INDEX_MIGRATION_VERSION;
  capturedAt: string;
  taskIds: string[];
}

export interface TaskIndexDependencies {
  paths: CorePaths;
  /** Injectable fence: v2 create/index mutations run under the store fence. */
  withStoreFence?: <T>(fn: () => Promise<T>) => Promise<T>;
  clock?: () => string;
}

function corrupted(message: string): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.TASK_CORRUPTED,
    `任务索引损坏: ${message}`,
    null,
    '联系平台检查任务索引文件。',
  );
}

/** task-index/ root under the data root (single derivation site). */
export function taskIndexRoot(paths: CorePaths): string {
  return join(paths.dataRoot, 'task-index');
}

export function taskIndexFile(paths: CorePaths): string {
  return join(taskIndexRoot(paths), 'index.json');
}

export function taskIndexMigrationMarkerFile(paths: CorePaths): string {
  return join(taskIndexRoot(paths), 'migration-marker.json');
}

export function taskIndexMigrationStagingFile(paths: CorePaths): string {
  return join(taskIndexRoot(paths), 'migration-staging.json');
}

/** deleted-tasks/ root (shared derivation with the deletion module). */
export function deletedTasksRoot(paths: CorePaths): string {
  return join(paths.dataRoot, 'deleted-tasks');
}

export function deletedTaskTombstoneFile(paths: CorePaths, taskId: string): string {
  if (!isSafeSegment(taskId)) throw new Error(`task-index: unsafe taskId '${taskId}'`);
  return join(deletedTasksRoot(paths), `${taskId}.json`);
}

function parseRows(raw: string, file: string): TaskIndexRowV2[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corrupted(`${file} 不是有效 JSON`);
  }
  if (!Array.isArray(parsed)) throw corrupted(`${file} 必须是数组`);
  const rows: TaskIndexRowV2[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) throw corrupted(`${file} 存在畸形行`);
    const o = entry as Record<string, unknown>;
    if (o.protocolVersion !== 2 || typeof o.taskId !== 'string' || !isSafeSegment(o.taskId)) {
      throw corrupted(`${file} 存在非法行`);
    }
    if (o.state === 'legacy_preexisting') {
      if (typeof o.createdAt !== 'string') throw corrupted(`${file} 存在非法 legacy 行`);
      rows.push({ protocolVersion: 2, taskId: o.taskId, state: 'legacy_preexisting', createdAt: o.createdAt });
      continue;
    }
    if (o.state !== 'prepared' && o.state !== 'active') throw corrupted(`${file} 存在未知 state`);
    if (
      o.protocol !== 'v2' ||
      typeof o.templateSnapshotHash !== 'string' ||
      typeof o.createdAt !== 'string' ||
      typeof o.profileSnapshotRef !== 'object' ||
      o.profileSnapshotRef === null ||
      typeof o.templateSnapshotRef !== 'object' ||
      o.templateSnapshotRef === null
    ) {
      throw corrupted(`${file} 存在非法 v2 行`);
    }
    rows.push({
      protocolVersion: 2,
      taskId: o.taskId,
      protocol: 'v2',
      templateSnapshotHash: o.templateSnapshotHash,
      profileSnapshotRef: o.profileSnapshotRef as BlobRefV2,
      templateSnapshotRef: o.templateSnapshotRef as BlobRefV2,
      state: o.state as 'prepared' | 'active',
      createdAt: o.createdAt,
    });
  }
  return rows;
}

function noFence<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

/**
 * The installation task index (spec §10.5). Rows advance prepared→active under
 * the fence; the migration barrier is completed exactly once per installation
 * (crash resumes the captured set).
 */
export class AuthoritativeTaskIndexV1 {
  private readonly paths: CorePaths;

  private readonly withStoreFence: <T>(fn: () => Promise<T>) => Promise<T>;

  private readonly clock: () => string;

  constructor(deps: TaskIndexDependencies) {
    this.paths = deps.paths;
    this.withStoreFence = deps.withStoreFence ?? noFence;
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  /* ------------------- migration barrier ------------------- */

  async migrationComplete(): Promise<boolean> {
    try {
      const marker = await readFile(taskIndexMigrationMarkerFile(this.paths), 'utf8');
      const parsed: unknown = JSON.parse(marker);
      return (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { version?: unknown }).version === TASK_INDEX_MIGRATION_VERSION
      );
    } catch {
      return false;
    }
  }

  /**
   * The fenced installation barrier: capture every task-directory name that
   * exists BEFORE the marker, durably write one legacy_preexisting row per name
   * (even when its record is unreadable), fsync the index, and only then write
   * the marker. A crash before the marker resumes the same captured set.
   */
  async runMigrationBarrier(): Promise<{ captured: string[]; resumed: boolean }> {
    if (await this.migrationComplete()) {
      return { captured: await this.legacyIds(), resumed: false };
    }
    return this.withStoreFence(async () => {
      await mkdir(taskIndexRoot(this.paths), { recursive: true });
      if (await this.migrationComplete()) {
        return { captured: await this.legacyIds(), resumed: false };
      }
      let staging: MigrationStagingV2 | null = null;
      try {
        const raw = await readFile(taskIndexMigrationStagingFile(this.paths), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          Array.isArray((parsed as { taskIds?: unknown }).taskIds)
        ) {
          staging = parsed as MigrationStagingV2;
        }
      } catch {
        staging = null;
      }
      const resumed = staging !== null;
      if (staging === null) {
        // Capture BEFORE the marker: every directory currently under tasksRoot.
        let names: string[] = [];
        try {
          names = (await readdir(this.paths.tasksRoot)).filter(
            (name) => !name.startsWith('.'),
          );
        } catch {
          names = [];
        }
        const taskIds: string[] = [];
        for (const name of names) {
          try {
            if (!(await stat(join(this.paths.tasksRoot, name))).isDirectory()) continue;
          } catch {
            continue;
          }
          taskIds.push(name);
        }
        staging = { version: TASK_INDEX_MIGRATION_VERSION, capturedAt: this.clock(), taskIds };
        await writeNewAtomicDurable(
          taskIndexMigrationStagingFile(this.paths),
          Buffer.from(`${JSON.stringify(staging, null, 2)}\n`, 'utf8'),
        );
      }
      // Register every captured name — even unreadable ones — then the marker.
      const existing = await this.readRows();
      const byId = new Map(existing.map((row) => [row.taskId, row]));
      for (const taskId of staging.taskIds) {
        if (!byId.has(taskId)) {
          byId.set(taskId, {
            protocolVersion: 2,
            taskId,
            state: 'legacy_preexisting',
            createdAt: this.clock(),
          });
        }
      }
      await this.writeRows([...byId.values()]);
      await writeNewAtomicDurable(
        taskIndexMigrationMarkerFile(this.paths),
        Buffer.from(`${JSON.stringify({ version: TASK_INDEX_MIGRATION_VERSION, completedAt: this.clock() }, null, 2)}\n`, 'utf8'),
      );
      await rm(taskIndexMigrationStagingFile(this.paths), { force: true });
      return { captured: [...staging.taskIds], resumed };
    });
  }

  /* ------------------- row access ------------------- */

  private async readRows(): Promise<TaskIndexRowV2[]> {
    try {
      return parseRows(await readFile(taskIndexFile(this.paths), 'utf8'), 'index.json');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async writeRows(rows: readonly TaskIndexRowV2[]): Promise<void> {
    await mkdir(taskIndexRoot(this.paths), { recursive: true });
    await writeReplaceAtomicDurable(
      taskIndexFile(this.paths),
      Buffer.from(`${JSON.stringify(rows, null, 2)}\n`, 'utf8'),
    );
  }

  async list(): Promise<TaskIndexRowV2[]> {
    return this.readRows();
  }

  async entryFor(taskId: string): Promise<TaskIndexRowV2 | null> {
    const rows = await this.readRows();
    return rows.find((row) => row.taskId === taskId) ?? null;
  }

  async legacyIds(): Promise<string[]> {
    const rows = await this.readRows();
    return rows
      .filter((row) => row.state === 'legacy_preexisting')
      .map((row) => row.taskId)
      .sort();
  }

  /** Every prepared/active v2 row (protocol identity even for corrupt roots). */
  async v2Rows(): Promise<PreparedActiveTaskRowV2[]> {
    const rows = await this.readRows();
    return rows.filter(
      (row): row is PreparedActiveTaskRowV2 =>
        row.state === 'prepared' || row.state === 'active',
    );
  }

  /** True when a durable deletion tombstone exists for the id. */
  async hasTombstone(taskId: string): Promise<boolean> {
    try {
      await stat(deletedTaskTombstoneFile(this.paths, taskId));
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------- create choreography (TaskStore.create) ------------------- */

  /**
   * Runs one callback under the installation store fence — the SAME fence the
   * deletion module and facade commits use. TaskStore.create holds the fence
   * across the whole prepared→root→active choreography (spec §10.5), so a
   * concurrent delete/GC can never observe a half-created task.
   */
  withFence<T>(fn: () => Promise<T>): Promise<T> {
    return this.withStoreFence(fn);
  }

  /**
   * Fenced prepared-entry write (create step 2 of §10.5): REQUIRES the
   * completed migration marker and rejects tombstoned / legacy-preexisting /
   * already-indexed IDs. Written OUTSIDE the task root so corruption of the
   * task never hides the identity.
   */
  async prepareTask(input: {
    taskId: string;
    templateSnapshotHash: string;
    profileSnapshotRef: BlobRefV2;
    templateSnapshotRef: BlobRefV2;
  }): Promise<PreparedActiveTaskRowV2> {
    return this.withStoreFence(() => this.prepareTaskUnderFence(input));
  }

  /**
   * The prepare step WITHOUT acquiring the fence — TaskStore.create calls it
   * inside its own `withFence` hold (the mkdir-lock fence is not re-entrant,
   * so the whole choreography acquires exactly once).
   */
  async prepareTaskUnderFence(input: {
    taskId: string;
    templateSnapshotHash: string;
    profileSnapshotRef: BlobRefV2;
    templateSnapshotRef: BlobRefV2;
  }): Promise<PreparedActiveTaskRowV2> {
    if (input.taskId.length === 0 || !isSafeSegment(input.taskId)) {
      throw new TaskIndexError('ID_UNAVAILABLE', 'taskId 不合法');
    }
    if (!(await this.migrationComplete())) {
      throw new TaskIndexError('MIGRATION_INCOMPLETE', 'v2 任务创建前必须完成安装迁移屏障');
    }
    if (await this.hasTombstone(input.taskId)) {
      throw new TaskIndexError('ID_UNAVAILABLE', '该任务 ID 已被删除，不可复用');
    }
    const rows = await this.readRows();
    const existing = rows.find((row) => row.taskId === input.taskId);
    if (existing !== undefined) {
      if (existing.state === 'legacy_preexisting') {
        throw new TaskIndexError('ID_UNAVAILABLE', '迁移前已存在的目录不可用于 v2');
      }
      throw new TaskIndexError('ID_UNAVAILABLE', '该任务 ID 已在索引中');
    }
    const row: PreparedActiveTaskRowV2 = {
      protocolVersion: 2,
      taskId: input.taskId,
      protocol: 'v2',
      templateSnapshotHash: input.templateSnapshotHash,
      profileSnapshotRef: input.profileSnapshotRef,
      templateSnapshotRef: input.templateSnapshotRef,
      state: 'prepared',
      createdAt: this.clock(),
    };
    rows.push(row);
    await this.writeRows(rows);
    return row;
  }

  /** Fenced prepared→active promotion (create step 5 of §10.5). */
  async activateTask(taskId: string): Promise<PreparedActiveTaskRowV2> {
    return this.withStoreFence(() => this.activateTaskUnderFence(taskId));
  }

  /** The promote step without acquiring the fence (see prepareTaskUnderFence). */
  async activateTaskUnderFence(taskId: string): Promise<PreparedActiveTaskRowV2> {
    const rows = await this.readRows();
    const index = rows.findIndex((row) => row.taskId === taskId);
    if (index === -1) throw new TaskIndexError('ENTRY_NOT_FOUND', `索引中不存在任务 ${taskId}`);
    const row = rows[index];
    if (row.state === 'legacy_preexisting') {
      throw new TaskIndexError('ENTRY_STATE_CONFLICT', 'legacy 行不可升级为 v2');
    }
    if (row.state === 'active') return row;
    const promoted: PreparedActiveTaskRowV2 = { ...row, state: 'active' };
    rows[index] = promoted;
    await this.writeRows(rows);
    return promoted;
  }

  /** Cancels a prepared entry (creation recovery: no final root). */
  async cancelPreparedTask(taskId: string): Promise<void> {
    return this.withStoreFence(() => this.cancelPreparedTaskUnderFence(taskId));
  }

  /** The cancel step without acquiring the fence (see prepareTaskUnderFence). */
  async cancelPreparedTaskUnderFence(taskId: string): Promise<void> {
    const rows = await this.readRows();
    const rest = rows.filter((row) => row.taskId !== taskId);
    await this.writeRows(rest);
  }

  /* ------------------- startup creation recovery ------------------- */

  /** Human-visible quarantine of a directory that must never be scheduled. */
  async quarantineUnindexedDirectory(taskId: string, reason: string): Promise<string | null> {
    const root = this.paths.taskRoot(taskId);
    try {
      if (!(await stat(root)).isDirectory()) return null;
    } catch {
      return null;
    }
    const target = join(this.paths.tasksRoot, `.quarantine-${taskId}-${randomUUID().slice(0, 8)}`);
    await rename(root, target);
    return target;
  }

  /**
   * Startup creation recovery (spec §10.5), run before listing/scheduling:
   * - prepared + no final root  -> remove/quarantine any temp root, cancel row;
   * - prepared + complete root  -> verify snapshot hash, activate;
   * - active + missing root     -> corruption/deletion recovery per tombstone;
   * - active + mismatched root  -> quarantine.
   */
  async runCreationRecovery(): Promise<{
    cancelled: string[];
    activated: string[];
    quarantined: string[];
    /** active row whose root is missing with NO tombstone (corruption). */
    activeMissing: string[];
  }> {
    const outcome = { cancelled: [], activated: [], quarantined: [], activeMissing: [] } as {
      cancelled: string[];
      activated: string[];
      quarantined: string[];
      activeMissing: string[];
    };
    for (const row of await this.v2Rows()) {
      const root = this.paths.taskRoot(row.taskId);
      let isDir = false;
      try {
        isDir = (await stat(root)).isDirectory();
      } catch {
        isDir = false;
      }
      if (row.state === 'prepared') {
        if (!isDir) {
          // No final root: the temp root (if any) is removed/quarantined and
          // the entry cancelled — GC may then sweep this task's pins/blobs.
          const tempRoot = join(this.paths.tasksRoot, `.tmp-task-${row.taskId}`);
          await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
          await this.cancelPreparedTask(row.taskId);
          outcome.cancelled.push(row.taskId);
          continue;
        }
        // Complete matching root: verify the snapshot hash then activate.
        try {
          const snapshotHash = await this.frozenSnapshotHashOf(row.taskId);
          if (snapshotHash !== row.templateSnapshotHash) {
            const qu = await this.quarantineUnindexedDirectory(row.taskId, 'prepared snapshot mismatch');
            if (qu !== null) outcome.quarantined.push(row.taskId);
            await this.cancelPreparedTask(row.taskId);
            outcome.cancelled.push(row.taskId);
            continue;
          }
        } catch {
          const qu = await this.quarantineUnindexedDirectory(row.taskId, 'prepared snapshot unreadable');
          if (qu !== null) outcome.quarantined.push(row.taskId);
          await this.cancelPreparedTask(row.taskId);
          outcome.cancelled.push(row.taskId);
          continue;
        }
        await this.activateTask(row.taskId);
        outcome.activated.push(row.taskId);
        continue;
      }
      // active:
      if (!isDir) {
        if (await this.hasTombstone(row.taskId)) {
          // Deletion recovery: the tombstone already retains the roots; the
          // deletion module resumes from the tombstone (never corruption).
          outcome.activeMissing.push(row.taskId);
          continue;
        }
        outcome.activeMissing.push(row.taskId);
        continue;
      }
      try {
        const snapshotHash = await this.frozenSnapshotHashOf(row.taskId);
        if (snapshotHash !== row.templateSnapshotHash) {
          await this.quarantineUnindexedDirectory(row.taskId, 'active root mismatched');
          outcome.quarantined.push(row.taskId);
        }
      } catch {
        await this.quarantineUnindexedDirectory(row.taskId, 'active root unreadable');
        outcome.quarantined.push(row.taskId);
      }
    }
    return outcome;
  }

  /** Reads the frozen snapshot's version hash (task.json is the record; the snapshot hash is authoritative). */
  private async frozenSnapshotHashOf(taskId: string): Promise<string> {
    // The snapshot directory's version hash: TaskStore computes it when it
    // publishes; here we read the snapshot's pipeline identity through the
    // shared record file's templateVersion — the SAME value TaskStore froze.
    const record = JSON.parse(await readFile(this.paths.taskFile(taskId), 'utf8')) as {
      templateVersion?: unknown;
    };
    if (typeof record.templateVersion !== 'string' || !/^[0-9a-f]{64}$/.test(record.templateVersion)) {
      throw new Error('task record templateVersion unreadable');
    }
    return record.templateVersion;
  }

  /* ------------------- GC roots (constraint D) ------------------- */

  /**
   * The installation roots provider: for every prepared/active row its
   * profileSnapshotRef + frozen-template alias ref, EXCEPT rows with a
   * deletion tombstone — a detached/purged task's blobs physically live in the
   * installation trash, outside the GC's sweep surface, so their refs are
   * never resolvable at the task-root addresses again (marking them would
   * abort the round as corruption). The tombstone itself "retains" the row —
   * the index you consult (`entryFor`/`v2Rows`) keeps the identity forever;
   * after the PURGED tombstone is durable the task can never reappear. GC may
   * run at any time, including between a delete's detach and its purge.
   */
  async gcRootsProvider(
    extraRoots: ReadonlyMap<string, readonly BlobRefV2[]> = new Map(),
  ): Promise<Record<string, readonly BlobRefV2[]>> {
    const out: Record<string, readonly BlobRefV2[]> = {};
    for (const row of await this.v2Rows()) {
      if (await this.hasTombstone(row.taskId)) continue;
      const roots = [row.profileSnapshotRef, row.templateSnapshotRef];
      const extra = extraRoots.get(row.taskId);
      if (extra !== undefined) roots.push(...extra);
      out[row.taskId] = roots;
    }
    return out;
  }
}