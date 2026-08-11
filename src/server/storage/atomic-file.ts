/**
 * Atomic new-file writes and shared storage error contract (plan Phase B
 * Task 3 Step 3).
 *
 * Every committed file in the local state model (spec §8.2) is written as a
 * same-directory unique temporary file (`wx`, so the temp itself can never
 * clobber anything), fully flushed and closed, then atomically renamed onto
 * the destination. An existing destination is never replaced and never
 * deleted: its presence is checked explicitly before rename (mandatory on
 * Windows, where rename refuses to overwrite; belt-and-braces on POSIX, where
 * rename would silently overwrite), and a rename failure mapped to
 * FILE_EXISTS cleans only the exact temporary file this call created.
 *
 * `StorageError` carries the public page-facing contract (iron rule 6):
 * stable code, presentable message, no absolute paths, no raw causes. Code
 * values shared with the frozen client table (INVALID_INPUT, TASK_NOT_FOUND,
 * TASK_CORRUPTED) use the identical strings; the server never imports client
 * modules (one-way dependency).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { PublicCoreError } from '../../shared/errors';

export const STORAGE_ERROR_CODES = {
  FILE_EXISTS: 'FILE_EXISTS',
  EVENT_INVALID: 'EVENT_INVALID',
  EVENT_ID_CONFLICT: 'EVENT_ID_CONFLICT',
  /** Same commitId replaying a different batch payload (spec §7.3). */
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  /** expectedLastSequence CAS does not match the current logical tail. */
  EXPECTED_SEQUENCE_MISMATCH: 'EXPECTED_SEQUENCE_MISMATCH',
  INVALID_INPUT: 'INVALID_INPUT',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_CORRUPTED: 'TASK_CORRUPTED',
  /**
   * Sealed artifact custody integrity failed (design §17.3 / spec §12): a
   * staged/promoted file or SealRecord no longer matches its recorded digest.
   * Never absorbed back into slot content.
   */
  ARTIFACT_INTEGRITY_FAILED: 'ARTIFACT_INTEGRITY_FAILED',
} as const;

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[keyof typeof STORAGE_ERROR_CODES];

/** Public error type thrown by every storage module failure path. */
export class StorageError extends Error implements PublicCoreError {
  readonly code: string;

  readonly location: string | null;

  readonly action: string | null;

  constructor(
    code: StorageErrorCode,
    message: string,
    location: string | null = null,
    action: string | null = null,
  ) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.location = location;
    this.action = action;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function fileExists(): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.FILE_EXISTS,
    '目标文件已存在，已提交的记录不可覆盖。',
    null,
    '以追加方式写入新文件。',
  );
}

/**
 * Writes `bytes` to `destination` as a brand-new committed file. Fails with
 * FILE_EXISTS when the destination already exists; never deletes or rewrites
 * it. Parent directories are created on demand. On any failure the only
 * cleanup is the exact temporary file created by this call.
 */
export async function writeNewAtomic(destination: string, bytes: Buffer): Promise<void> {
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true });
  if (await pathExists(destination)) {
    throw fileExists();
  }
  const tempFile = join(directory, `.tmp-${basename(destination)}-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempFile, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    // Re-check immediately before rename: a committed file must never be
    // overwritten, and on POSIX rename would otherwise silently replace it.
    if (await pathExists(destination)) {
      throw fileExists();
    }
    await rename(tempFile, destination);
  } catch (error) {
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }
    await rm(tempFile, { force: true }).catch(() => undefined);
    if (error instanceof StorageError) {
      throw error;
    }
    // A rename failure with the destination now present is a lost race
    // against another committing call: report it as FILE_EXISTS, never as a
    // raw cause, and never by deleting the winner.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' && (await pathExists(destination))) {
      throw fileExists();
    }
    throw error;
  }
}

/**
 * Writes `bytes` to `destination`, atomically replacing any existing file.
 * This is the overwritable sibling of `writeNewAtomic`, reserved for scratch
 * storage that is allowed to change (plan Phase E agent workspace files);
 * committed history still uses `writeNewAtomic` exclusively. The same
 * discipline applies: same-directory unique temporary file (`wx`, so the temp
 * itself can never clobber anything), full flush and close, then rename. On
 * any failure the only cleanup is the exact temporary file this call created;
 * the destination is never deleted except by the final successful rename
 * (or the one documented replace-refusal retry below).
 */
export async function writeReplaceAtomic(destination: string, bytes: Buffer): Promise<void> {
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true });
  // Scratch destinations may carry long names (workspace paths up to the
  // 512-char limit); the temp name stays bounded so it never trips the OS
  // filename limit. The uuid alone guarantees per-call uniqueness.
  const tempFile = join(directory, `.tmp-${basename(destination).slice(0, 32)}-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempFile, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempFile, destination);
  } catch (error) {
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }
    // POSIX rename atomically replaces an existing file; a platform that
    // refuses the overwrite gets one retry after removing the destination.
    // Scratch storage tolerates that tiny window; committed history never
    // reaches this function.
    const errno = (error as NodeJS.ErrnoException).code;
    const replaceRefused =
      (errno === 'EEXIST' || errno === 'EPERM' || errno === 'EACCES') &&
      (await pathExists(destination));
    if (replaceRefused) {
      try {
        await rm(destination, { force: true });
        await rename(tempFile, destination);
        return;
      } catch {
        // Fall through: clean this call's temp file and surface the failure.
      }
    }
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}
