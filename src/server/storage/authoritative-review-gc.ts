/**
 * Task 8 recursive GC (spec §8, design §19.1): mark/sweep over the v2 blob
 * store with a generation barrier and a store-lock recheck.
 *
 * Roots come ONLY from:
 *   1. exact BlobRefV2 fields of committed v2 events (structural enumeration
 *      over the validated closed union — every ref-shaped value is
 *      strict-checked; bare digest strings never keep an object alive);
 *   2. active pins (incl. their intent canonicalOperationPayloadRef) and
 *      abandoned pins still inside their quarantine window (at least one
 *      additional full GC generation after abandonment);
 *   3. the injected installation-roots provider (Task 11 supplies
 *      task-index/tombstone roots; the seam defaults to empty).
 * Child refs come ONLY from the Task 3 object-registry extractors.
 * Checkpoints are NOT roots.
 *
 * Protocol: the mark-start generation and the pin snapshot are captured under
 * the same store lock (so a publication commit cannot interleave a stale mark
 * decision); the mark walks the registry child extractors; before ANY delete,
 * the lock is re-acquired and event roots, pins, installed roots and the
 * generation are re-checked under the same barrier. Objects newer than the
 * mark-start generation are excluded; a missing event-referenced blob during
 * mark is a fail-closed corruption abort, never a skip.
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CorePaths } from './core-paths';
import type { EventStore } from './event-store';
import { isV2Event } from './event-store';
import type { AuthoritativeReviewBlobStore } from './authoritative-review-blob-store';
import { refKey } from './authoritative-review-blob-store';
import { childRefsForBlob, isRegisteredKind } from '../authoritative-review/object-registry';
import { SchemaError } from '../authoritative-review/authority-types';
import type { AuthoritativePublicationStore, PublicationPinV2 } from './authoritative-publication-store';
import { STORAGE_ERROR_CODES, StorageError, syncDirectory } from './atomic-file';
import type { TaskEvent } from './task-events';
import type { AuthoritativeBlobKindV2, BlobRefV2 } from '../../shared/authoritative-review-v2';

/** Installation-level roots (Task 11: task-index/tombstone roots). */
export type GcInstallationRoots = Readonly<Record<string, readonly BlobRefV2[] | undefined>>;

export type GcInstallationRootsProvider = () => Promise<GcInstallationRoots> | GcInstallationRoots;

export interface GcOptions {
  rootsProvider?: GcInstallationRootsProvider;
  /**
   * Test/qualification seam: runs after mark and before the delete recheck so
   * tests can interleave a REAL concurrent publication between mark and
   * delete (the recheck must then keep the new generation's objects alive).
   */
  beforeDeleteRecheck?: () => Promise<void>;
  /**
   * Test/qualification seam: runs immediately before each per-file delete
   * decision (outside the delete itself, inside the recheck barrier) so tests
   * can drop a pin into the middle of the sweep and prove the per-file pin
   * re-snapshot protects its blobs.
   */
  beforeEachDelete?: (taskId: string, ref: BlobRefV2) => Promise<void>;
}

export interface GcRunResult {
  markStartGeneration: number;
  /** Blob identities marked live through registry child extraction. */
  markedRefs: number;
  deletedBlobs: number;
  /** Objects excluded because they are newer than the mark-start generation. */
  protectedNewBlobs: number;
  /** Abandoned pins past their quarantine window. */
  deletedPins: number;
}

interface BlobFileEntry {
  taskId: string;
  ref: BlobRefV2;
  path: string;
  sidecarPath: string;
  generation: number;
}

const SHA256_NAME = /^[0-9a-f]{64}$/;
const REF_MEDIA_TYPES = ['application/json', 'text/markdown', 'text/plain'] as const;

function corrupt(message: string): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.TASK_CORRUPTED,
    message,
    null,
    '修复或重建该任务。',
  );
}

/** Strict BlobRefV2 shape validation (spec §7.1): exact keys + registry kind. */
function strictBlobRefValue(value: unknown, where: string): BlobRefV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw corrupt(`${where} 不是 BlobRefV2 对象。`);
  }
  const o = value as Record<string, unknown>;
  const keys = ['kind', 'digest', 'byteLength', 'mediaType', 'schemaVersion'];
  if (keys.some((key) => !(key in o))) {
    throw corrupt(`${where} 缺少 BlobRefV2 字段。`);
  }
  if (Object.keys(o).length !== keys.length) {
    throw corrupt(`${where} 携带未知 BlobRefV2 字段。`);
  }
  const kind = o.kind;
  const digest = o.digest;
  const byteLength = o.byteLength;
  const mediaType = o.mediaType;
  const schemaVersion = o.schemaVersion;
  if (typeof kind !== 'string' || !isRegisteredKind(kind)) {
    throw corrupt(`${where}.kind 不是已注册的 v2 blob 类型。`);
  }
  if (typeof digest !== 'string' || !SHA256_NAME.test(digest)) {
    throw corrupt(`${where}.digest 必须是 64 位小写十六进制。`);
  }
  if (typeof byteLength !== 'number' || !Number.isInteger(byteLength) || byteLength < 0) {
    throw corrupt(`${where}.byteLength 无效。`);
  }
  if (typeof mediaType !== 'string' || !(REF_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    throw corrupt(`${where}.mediaType 无效。`);
  }
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw corrupt(`${where}.schemaVersion 无效。`);
  }
  return { kind: kind as AuthoritativeBlobKindV2, digest, byteLength, mediaType: mediaType as BlobRefV2['mediaType'], schemaVersion };
}

/**
 * Structural root enumeration over the CLOSED v2 event union: every
 * BlobRefV2-shaped value (strictly validated) is a formal root; bare digest
 * strings, review contexts, openedBy/parkDisposition branches and files[]
 * summaries are ignored. Events come from a validated ledger, so a
 * ref-shaped-but-invalid value is itself corruption.
 */
function eventRootRefs(event: TaskEvent): BlobRefV2[] {
  const out: BlobRefV2[] = [];
  collectRefs(event, out, `事件 ${event.id}`);
  return out;
}

function collectRefs(value: unknown, out: BlobRefV2[], where: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectRefs(entry, out, `${where}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const o = value as Record<string, unknown>;
  // Ref-shaped leaf: kind + digest + byteLength is the discriminator; the
  // strict 5-key check below keeps anything else from being a fake root.
  if (
    typeof o.kind === 'string' &&
    typeof o.digest === 'string' &&
    typeof o.byteLength === 'number'
  ) {
    out.push(strictBlobRefValue(o, where));
    return;
  }
  for (const key of Object.keys(o)) collectRefs(o[key], out, `${where}.${key}`);
}

export class AuthoritativeReviewGc {
  private readonly paths: CorePaths;

  private readonly blobStore: AuthoritativeReviewBlobStore;

  private readonly eventStore: EventStore;

  private readonly publicationStore: AuthoritativePublicationStore;

  private readonly options: Required<Pick<GcOptions, 'beforeDeleteRecheck' | 'beforeEachDelete'>> &
    Pick<GcOptions, 'rootsProvider'>;

  constructor(
    paths: CorePaths,
    blobStore: AuthoritativeReviewBlobStore,
    eventStore: EventStore,
    publicationStore: AuthoritativePublicationStore,
    options: GcOptions = {},
  ) {
    this.paths = paths;
    this.blobStore = blobStore;
    this.eventStore = eventStore;
    this.publicationStore = publicationStore;
    this.options = {
      rootsProvider: options.rootsProvider,
      beforeDeleteRecheck: options.beforeDeleteRecheck ?? (async () => undefined),
      beforeEachDelete: options.beforeEachDelete ?? (async (_taskId, _ref) => undefined),
    };
  }

  /**
   * One mark/sweep round. Returns immediately-observable facts; throws
   * TASK_CORRUPTED (aborting the round, deleting nothing) when a formally
   * referenced blob is missing or unparseable.
   */
  async run(): Promise<GcRunResult> {
    // mark capture under the store lock: generation + pin snapshot cannot
    // interleave a publication commit.
    const hold = await this.publicationStore.lock().acquire();
    let markStartGeneration: number;
    let pinSnapshot: PublicationPinV2[];
    let installedRoots: GcInstallationRoots;
    try {
      markStartGeneration = await this.publicationStore.readGeneration();
      pinSnapshot = await this.publicationStore.snapshotPins();
      installedRoots = (await this.options.rootsProvider?.()) ?? {};
    } finally {
      await hold.release();
    }

    const live = new Set<string>();
    const liveKey = (taskId: string, ref: BlobRefV2): string => `${taskId}:${refKey(ref)}`;
    let markedRefs = 0;

    const markBlob = async (taskId: string, ref: BlobRefV2): Promise<void> => {
      const key = liveKey(taskId, ref);
      if (live.has(key)) return;
      live.add(key);
      markedRefs += 1;
      let object: unknown;
      try {
        object = await this.blobStore.readJson(taskId, ref, ref.kind);
      } catch (error) {
        if ((error as StorageError).code === STORAGE_ERROR_CODES.TASK_CORRUPTED) {
          // Fail-closed: a formally referenced blob must never be skipped.
          throw corrupt(`GC: 事件/pin 引用的 v2 blob (${ref.kind}:${ref.digest.slice(0, 12)}…) 缺失或不可解析。`);
        }
        throw error;
      }
      let children: readonly BlobRefV2[];
      try {
        children = childRefsForBlob(ref.kind, object);
      } catch (error) {
        if (error instanceof SchemaError) {
          throw corrupt(`GC: v2 blob ${ref.kind} 的子引用提取失败: ${error.message}`);
        }
        throw error;
      }
      for (const child of children) {
        await markBlob(taskId, child);
      }
    };

    // 1. event roots: every v2 event in every committed ledger.
    const taskIds = new Set<string>();
    for (const pin of pinSnapshot) taskIds.add(pin.taskId);
    for (const taskId of await this.listTasks()) taskIds.add(taskId);
    for (const taskId of taskIds) {
      let events: readonly { event: TaskEvent }[];
      try {
        events = await this.eventStore.read(taskId);
      } catch (error) {
        if ((error as StorageError).code === STORAGE_ERROR_CODES.TASK_CORRUPTED) {
          throw corrupt(`GC: 任务 ${taskId} 的事件账本损坏，拒绝执行 mark。`);
        }
        throw error;
      }
      for (const { event } of events) {
        if (!isV2Event(event)) continue;
        for (const ref of eventRootRefs(event)) {
          await markBlob(taskId, ref);
        }
      }
    }
    // 2. pin roots at the mark snapshot (quarantine window respected).
    for (const pin of pinSnapshot) {
      if (!(await this.pinIsRoot(pin, markStartGeneration))) continue;
      await this.markPinRefs(pin, markBlob);
    }
    // 3. installed roots (Task 11 seam).
    for (const [taskId, refs] of Object.entries(installedRoots)) {
      for (const ref of refs ?? []) {
        await markBlob(taskId, ref);
      }
    }
    // Re-read pins during the sweep: pins created after the snapshot (even
    // without the lock) keep their refs alive.
    for (const pin of await this.publicationStore.snapshotPins()) {
      if (!(await this.pinIsRoot(pin, markStartGeneration))) continue;
      await this.markPinRefs(pin, markBlob);
    }

    const files = await this.enumerateAllBlobs();
    // The pre-delete seam: a REAL concurrent publication may interleave here.
    await this.options.beforeDeleteRecheck();

    // Final recheck under the SAME store lock: fresh event roots, pins,
    // installed roots and generation; then delete within the barrier.
    const recheckHold = await this.publicationStore.lock().acquire();
    try {
      const recheckGeneration = await this.publicationStore.readGeneration();
      const totals: GcRunResult = {
        markStartGeneration,
        markedRefs,
        deletedBlobs: 0,
        protectedNewBlobs: 0,
        deletedPins: 0,
      };
      // Re-enumerate event roots under the barrier (a concurrently committed
      // event protects its refs even if appended after mark).
      const recheckTasks = new Set<string>();
      for (const pin of await this.publicationStore.snapshotPins()) recheckTasks.add(pin.taskId);
      for (const taskId of await this.listTasks()) recheckTasks.add(taskId);
      for (const taskId of recheckTasks) {
        for (const { event } of await this.eventStore.read(taskId)) {
          if (!isV2Event(event)) continue;
          for (const ref of eventRootRefs(event)) {
            await markBlob(taskId, ref);
          }
        }
      }
      for (const pin of await this.publicationStore.snapshotPins()) {
        if (await this.pinIsRoot(pin, markStartGeneration)) {
          await this.markPinRefs(pin, markBlob);
        }
      }
      const recheckedInstalled = (await this.options.rootsProvider?.()) ?? {};
      for (const [taskId, refs] of Object.entries(recheckedInstalled)) {
        for (const ref of refs ?? []) {
          await markBlob(taskId, ref);
        }
      }
      // Delete only files that were visible before the recheck barrier and
      // are still unreferenced AND not newer than the mark-start generation.
      // Each decision re-snapshots the CURRENT pin set immediately before the
      // rm (Finding 7): a pin landing mid-loop saves its blobs no matter
      // where the delete loop is.
      const markedBefore = new Set(Array.from(live));
      const firstPaths = new Set(files.map((file) => file.path));
      for (const file of files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
        if (markedBefore.has(liveKey(file.taskId, file.ref))) continue;
        if (file.generation > markStartGeneration) {
          totals.protectedNewBlobs += 1;
          continue;
        }
        await this.options.beforeEachDelete(file.taskId, file.ref);
        // Per-file fresh pin recheck: any active/quarantined pin protecting
        // this exact file (or its payload ref) keeps it alive.
        if (await this.refProtectedByCurrentPins(file.taskId, file.ref, markStartGeneration)) continue;
        await rm(file.path, { force: true });
        await rm(file.sidecarPath, { force: true });
        await syncDirectory(dirname(file.path));
        totals.deletedBlobs += 1;
      }
      // Files that appeared after the first enumeration are never deleted in
      // this round; ones newer than the mark-start generation are counted as
      // protected (the first enumeration already counted its own).
      for (const file of await this.enumerateAllBlobs()) {
        if (firstPaths.has(file.path)) continue;
        if (live.has(liveKey(file.taskId, file.ref))) continue;
        if (file.generation > markStartGeneration || file.generation > recheckGeneration) {
          totals.protectedNewBlobs += 1;
        }
      }
      totals.deletedPins = (await this.publicationStore.sweepQuarantinedPins(markStartGeneration)).length;
      return totals;
    } finally {
      await recheckHold.release();
    }
  }

  /**
   * Live pin set check for ONE blob: any active pin, or any quarantined
   * abandoned pin, whose payload ref or prepared refs cover `ref` protects it
   * THIS INSTANT — regardless of where the mark/recheck snapshots happened.
   */
  private async refProtectedByCurrentPins(
    taskId: string,
    ref: BlobRefV2,
    markStartGeneration: number,
  ): Promise<boolean> {
    const key = refKey(ref);
    for (const pin of await this.publicationStore.snapshotPins()) {
      if (pin.taskId !== taskId) continue;
      if (!(await this.pinIsRoot(pin, markStartGeneration))) continue;
      if (refKey(pin.intent.canonicalOperationPayloadRef) === key) return true;
      if (pin.blobRefs.some((candidate) => refKey(candidate) === key)) return true;
    }
    return false;
  }

  private async pinIsRoot(pin: PublicationPinV2, markStartGeneration: number): Promise<boolean> {
    if (pin.state === 'active') return true;
    if (pin.state === 'abandoned' && pin.abandonedGeneration !== null) {
      // Quarantine: roots until the guard generation markStart has passed
      // abandonedGeneration + 1 (sweep only from abandonedGeneration + 2).
      return markStartGeneration <= pin.abandonedGeneration + 1;
    }
    return false;
  }

  private async markPinRefs(
    pin: PublicationPinV2,
    markBlob: (taskId: string, ref: BlobRefV2) => Promise<void>,
  ): Promise<void> {
    await markBlob(pin.taskId, pin.intent.canonicalOperationPayloadRef);
    for (const ref of pin.blobRefs) {
      await markBlob(pin.taskId, ref);
    }
  }

  private async listTasks(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.paths.tasksRoot);
    } catch {
      return [];
    }
    const tasks: string[] = [];
    for (const name of names) {
      if (name.startsWith('.')) continue;
      try {
        if ((await stat(this.paths.taskStructuredV2BlobsRoot(name))).isDirectory()) {
          tasks.push(name);
        }
      } catch {
        // No v2 blobs — nothing to scan.
      }
    }
    return tasks;
  }

  /** Every `blobs/<kind>/<first2>/<digest>` file with its creation generation. */
  private async enumerateAllBlobs(): Promise<BlobFileEntry[]> {
    const out: BlobFileEntry[] = [];
    for (const taskId of await this.listTasks()) {
      await this.enumerateTaskBlobs(taskId, out);
    }
    return out;
  }

  private async enumerateTaskBlobs(taskId: string, out: BlobFileEntry[]): Promise<void> {
    const blobsRoot = this.paths.taskStructuredV2BlobsRoot(taskId);
    let kinds: string[];
    try {
      kinds = await readdir(blobsRoot);
    } catch {
      return;
    }
    for (const kind of kinds) {
      const kindDir = join(blobsRoot, kind);
      if (!(await isDirectory(kindDir))) continue;
      let prefixes: string[];
      try {
        prefixes = await readdir(kindDir);
      } catch {
        continue;
      }
      for (const prefix of prefixes) {
        const prefixDir = join(kindDir, prefix);
        if (!(await isDirectory(prefixDir))) continue;
        let names: string[];
        try {
          names = await readdir(prefixDir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!SHA256_NAME.test(name)) continue; // *.gen.json sidecars are not objects
          const digest = name;
          const ref: BlobRefV2 = {
            kind: kind as AuthoritativeBlobKindV2,
            digest,
            byteLength: 0,
            mediaType: 'application/json',
            schemaVersion: 1,
          };
          if (!isRegisteredKind(kind)) continue;
          out.push({
            taskId,
            ref,
            path: join(prefixDir, name),
            sidecarPath: join(prefixDir, `${name}.gen.json`),
            generation: await this.readGenerationSidecar(join(prefixDir, `${name}.gen.json`)),
          });
        }
      }
    }
  }

  /** Missing sidecar = created outside the generation-stamped facade path. */
  private async readGenerationSidecar(path: string): Promise<number> {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as { generation?: unknown };
      if (typeof value.generation === 'number' && Number.isInteger(value.generation) && value.generation >= 0) {
        return value.generation;
      }
      return 0;
    } catch {
      return 0;
    }
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}