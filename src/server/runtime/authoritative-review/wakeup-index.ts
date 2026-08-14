/**
 * Task 11 durable wakeup index (spec §10.4, design §17.3 — "process-local
 * queues and timers are only accelerators; the scan, normal completion
 * notification, retry timer, and resume path all upsert the same durable
 * wakeup identity").
 *
 * One atomic JSON file per task at `dataRoot/wakeups/<taskId>.json` (written
 * with the same write-new-atomic-durable discipline as the publication
 * stores), so a crashed process rebuilds every timer/claim surface from disk:
 *
 * - `lease_expiry`: the coordinator's `LeasedWorkV2.wakeup` — reclaim the
 *   leased workitem when `at` passes.
 * - `retry_due`: the coordinator's `RetryRecordedResultV2(mode:'retryable')
 *   .wakeup` — requeue the retryable-failed workitem when `at` passes.
 * - `runnable`: a ready workitem exists and the task is eligible — the
 *   scheduler loop claims it through normal tail-CAS leasing (no in-memory
 *   queue needed). `at` is null (claim promptly) or a timestamp after a
 *   requeue/manual-retry/resume activation.
 *
 * Dormant semantics: a stopped/interrupted overlay task keeps its underlying
 * retry-due and runnable entries but they are carried as DORMANT (`dormant:
 * true`) — the scan never acts on them and resume reactivates them without
 * loss (§10.4 stopped/interrupted row). Deletion removes the whole row
 * (TASK_DELETED blocks every caller anyway).
 *
 * Purity: this module only reads/writes JSON under the derivable wakeups
 * root; no EventStore, no clock beyond the injected one.
 */
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CorePaths } from '../../storage/core-paths';
import { STORAGE_ERROR_CODES, StorageError, writeReplaceAtomicDurable } from '../../storage/atomic-file';
import { canonicalJson } from '../../structured-slots/canonical-json';
import { isSafeSegment } from '../../storage/core-paths';

/** The closed wakeup kinds (spec §10.4 / Task 10 handoff). */
export type WakeupKindV2 = 'lease_expiry' | 'retry_due' | 'runnable';

/** One durable wakeup entry of a task. */
export interface WakeupRowV2 {
  taskId: string;
  kind: WakeupKindV2;
  /** ISO instant when the wakeup becomes due; null means "due now". */
  at: string | null;
  /** 0 = dormant (suspended task); otherwise the last due/dormant instant. */
  dormant: boolean;
  /** The workitem the wakeup concerns (null for task-level runnable). */
  workItemId: string | null;
  /** The STABLE operation id to reuse on retransmission (response-loss replay). */
  operationId: string | null;
  /**
   * Eligibility state at the last upsert: when `executionEligibility` is
   * blocked the runnable wakeup stays (never busy-loops) and the
   * environment/startup reconciliation reactivates it once the exact profile
   * becomes eligible (§4.3).
   */
  eligibilityBlocked: boolean;
}

export interface WakeupIndexDependencies {
  paths: CorePaths;
}

function corrupted(message: string): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.TASK_CORRUPTED,
    `唤醒索引损坏: ${message}`,
    null,
    '联系平台检查唤醒索引文件。',
  );
}

/** The wakeups root helper (documented, single derivation site). */
export function wakeupsRoot(paths: CorePaths): string {
  return join(paths.dataRoot, 'wakeups');
}

export function wakeupFile(paths: CorePaths, taskId: string): string {
  if (!isSafeSegment(taskId)) throw new Error(`wakeup-index: unsafe taskId '${taskId}'`);
  return join(wakeupsRoot(paths), `${taskId}.json`);
}

/**
 * The durable task wakeup index. All mutation paths are per-task atomic
 * replace; concurrent writers on one task resolve through the same
 * write-new-atomic-durable rename discipline (last writer wins deterministically,
 * never a torn file).
 */
export class AuthoritativeWakeupIndexV1 {
  private readonly paths: CorePaths;

  constructor(deps: WakeupIndexDependencies) {
    this.paths = deps.paths;
  }

  /** Returns the durable rows of one task (empty when none recorded). */
  async read(taskId: string): Promise<WakeupRowV2[]> {
    try {
      const raw = await readFile(wakeupFile(this.paths, taskId), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw corrupted('not an array');
      }
      const rows: WakeupRowV2[] = [];
      for (const entry of parsed) {
        if (typeof entry !== 'object' || entry === null) throw corrupted('bad row');
        const row = entry as Record<string, unknown>;
        if (
          typeof row.taskId !== 'string' ||
          row.taskId !== taskId ||
          (row.kind !== 'lease_expiry' && row.kind !== 'retry_due' && row.kind !== 'runnable') ||
          (row.at !== null && typeof row.at !== 'string') ||
          typeof row.dormant !== 'boolean' ||
          (row.workItemId !== null && typeof row.workItemId !== 'string') ||
          (row.operationId !== null && typeof row.operationId !== 'string') ||
          typeof row.eligibilityBlocked !== 'boolean'
        ) {
          throw corrupted('malformed row');
        }
        rows.push(row as unknown as WakeupRowV2);
      }
      rows.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : `${a.workItemId ?? ''}`.localeCompare(`${b.workItemId ?? ''}`)));
      return rows;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw corrupted((error as Error).message);
    }
  }

  /** Replaces the durable rows of one task (atomic durable write). */
  async write(taskId: string, rows: readonly WakeupRowV2[]): Promise<void> {
    await mkdir(wakeupsRoot(this.paths), { recursive: true });
    const canonical = rows.map((row) => ({ ...row, taskId }));
    await writeReplaceAtomicDurable(
      wakeupFile(this.paths, taskId),
      Buffer.from(`${JSON.stringify(canonical)}\n`, 'utf8'),
    );
  }

  /**
   * Affirms one wakeup: the coexistence matrix keeps at most one live/one
   * dormant entry per (kind, workItemId) — re-upserting the same identity is
   * idempotent (byte-stable when nothing changed).
   */
  async upsert(taskId: string, row: Omit<WakeupRowV2, 'taskId'>): Promise<void> {
    const rows = await this.read(taskId);
    const rest = rows.filter(
      (existing) => !(existing.kind === row.kind && existing.workItemId === row.workItemId),
    );
    rest.push({ ...row, taskId });
    await this.write(taskId, rest);
  }

  /** Removes every wakeup of one task (deletion/terminal cleanup). */
  async removeTask(taskId: string): Promise<void> {
    await rm(wakeupFile(this.paths, taskId), { force: true });
  }

  /** Removes one entry (terminal cleanup of a specific workitem). */
  async remove(taskId: string, kind: WakeupKindV2, workItemId: string | null): Promise<void> {
    const rows = await this.read(taskId);
    const rest = rows.filter(
      (existing) => !(existing.kind === kind && existing.workItemId === workItemId),
    );
    if (rest.length === rows.length) return;
    await this.write(taskId, rest);
  }

  /** Every task with at least one wakeup row. */
  async allTasks(): Promise<string[]> {
    try {
      const names = await readdir(wakeupsRoot(this.paths));
      const ids: string[] = [];
      for (const name of names) {
        if (name.endsWith('.json')) ids.push(name.slice(0, -'.json'.length));
      }
      return ids.sort();
    } catch {
      return [];
    }
  }

  /** All rows across the installation (startup scan repair source). */
  async all(): Promise<WakeupRowV2[]> {
    const rows: WakeupRowV2[] = [];
    for (const taskId of await this.allTasks()) {
      rows.push(...(await this.read(taskId)));
    }
    return rows;
  }

  /**
   * Deterministic due snapshot at `now`: non-dormant entries whose `at` passed
   * (null at = due now). Used by the scheduler loop and the startup scan.
   */
  async due(now: string): Promise<WakeupRowV2[]> {
    const rows = await this.all();
    return rows.filter((row) => !row.dormant && (row.at === null || row.at <= now));
  }

  /** Canonical bytes of one row set (debug/audit pinning). */
  canonicalBytes(taskId: string, rows: readonly WakeupRowV2[]): string {
    return canonicalJson(rows.map((row) => ({ ...row, taskId })));
  }
}