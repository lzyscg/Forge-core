/**
 * Per-agent temporary workspace store (plan Phase E Task 1).
 *
 * The workspace is the agent's file-only scratch area under
 * `tasks/<id>/workspaces/<agentId>/` (plan Global Constraint 6): three file
 * tools, no shell, and writes take effect immediately (they never pass
 * through the action buffer or the event union). Files are overwritable
 * scratch, unlike committed history — `writeReplaceAtomic` is the write
 * primitive.
 *
 * Every failure is a typed, non-retryable `RuntimeFailure` with a stable
 * code and a presentable Chinese message (iron rule 6: no absolute paths,
 * no raw causes). Path safety is enforced twice: statically on the resolved
 * path (length, absoluteness, NUL, segment count 1..4, SAFE_SEGMENT per
 * segment, root containment) and again after `realpath`, so symlinks cannot
 * escape the workspace on reads; writes additionally realpath-check the
 * parent directory before any byte lands. Size, file-count and depth limits
 * bound the footprint of a single agent.
 *
 * No business vocabulary lives here (iron rule 1).
 */
import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeReplaceAtomic } from '../storage/atomic-file';
import type { CorePaths } from '../storage/core-paths';
import { isSafeSegment } from '../storage/core-paths';
import { RuntimeFailure } from './agent-runtime';

/** Hard footprint bounds for one agent workspace (plan Global Constraint 6). */
export const WORKSPACE_LIMITS = {
  maxFileBytes: 65_536,
  maxFilesPerAgent: 32,
  maxPathDepth: 4,
  maxPathLength: 512,
} as const;

/** Stable workspace error codes owned by this module. */
export const WORKSPACE_ERROR_CODES = {
  /** The relative path is unsafe, malformed, or escapes the workspace. */
  WORKSPACE_PATH_UNSAFE: 'WORKSPACE_PATH_UNSAFE',
  /** The file content exceeds the per-file byte limit. */
  WORKSPACE_FILE_TOO_LARGE: 'WORKSPACE_FILE_TOO_LARGE',
  /** The agent already holds the maximum number of files. */
  WORKSPACE_TOO_MANY_FILES: 'WORKSPACE_TOO_MANY_FILES',
  /** The requested file does not exist in the workspace. */
  WORKSPACE_FILE_NOT_FOUND: 'WORKSPACE_FILE_NOT_FOUND',
} as const;

export type WorkspaceErrorCode = (typeof WORKSPACE_ERROR_CODES)[keyof typeof WORKSPACE_ERROR_CODES];

/** One workspace file as listed by the store. */
export interface WorkspaceFileEntry {
  /** Path relative to the agent workspace root, forward slashes. */
  path: string;
  /** Byte size on disk. */
  bytes: number;
}

const WORKSPACE_ERROR_MESSAGES: Record<WorkspaceErrorCode, string> = {
  WORKSPACE_PATH_UNSAFE: '工作区路径不安全或超出允许范围。',
  WORKSPACE_FILE_TOO_LARGE: '工作区文件超过大小上限。',
  WORKSPACE_TOO_MANY_FILES: '工作区文件数量超过上限。',
  WORKSPACE_FILE_NOT_FOUND: '工作区文件不存在。',
};

function workspaceFailure(code: WorkspaceErrorCode): RuntimeFailure {
  return new RuntimeFailure(code, WORKSPACE_ERROR_MESSAGES[code], false);
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export class WorkspaceStore {
  private readonly paths: CorePaths;

  constructor(paths: CorePaths) {
    this.paths = paths;
  }

  /**
   * Writes (or overwrites) one scratch file and reports its relative path
   * and byte size. Checks run before any byte lands: static containment,
   * the byte limit, the per-agent file count, and a realpath containment
   * check of the parent directory.
   */
  async writeFile(
    taskId: string,
    agentId: string,
    relPath: string,
    content: string,
  ): Promise<WorkspaceFileEntry> {
    const root = this.paths.taskWorkspaceRoot(taskId, agentId);
    const target = this.resolveContained(root, relPath);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > WORKSPACE_LIMITS.maxFileBytes) {
      throw workspaceFailure(WORKSPACE_ERROR_CODES.WORKSPACE_FILE_TOO_LARGE);
    }
    if (!(await pathExists(target))) {
      const count = await this.countFiles(root);
      if (count >= WORKSPACE_LIMITS.maxFilesPerAgent) {
        throw workspaceFailure(WORKSPACE_ERROR_CODES.WORKSPACE_TOO_MANY_FILES);
      }
    }
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    await this.assertRealContained(root, parent);
    await writeReplaceAtomic(target, Buffer.from(content, 'utf8'));
    return { path: toPosix(relative(root, target)), bytes };
  }

  /**
   * Reads one scratch file as UTF-8 text. After the static containment
   * check the target is re-checked through `realpath`, so a symlink whose
   * destination escapes the workspace is rejected, never followed.
   */
  async readFile(taskId: string, agentId: string, relPath: string): Promise<string> {
    const root = this.paths.taskWorkspaceRoot(taskId, agentId);
    const target = this.resolveContained(root, relPath);
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(target);
    } catch {
      throw workspaceFailure(WORKSPACE_ERROR_CODES.WORKSPACE_FILE_NOT_FOUND);
    }
    if (!fileStat.isFile()) {
      throw workspaceFailure(WORKSPACE_ERROR_CODES.WORKSPACE_FILE_NOT_FOUND);
    }
    let real: string;
    let realRoot: string;
    try {
      real = await realpath(target);
      realRoot = await realpath(root);
    } catch {
      throw workspaceFailure(WORKSPACE_ERROR_CODES.WORKSPACE_FILE_NOT_FOUND);
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw workspaceFailure(WORKSPACE_ERROR_CODES.WORKSPACE_PATH_UNSAFE);
    }
    try {
      return await readFile(real, 'utf8');
    } catch {
      throw workspaceFailure(WORKSPACE_ERROR_CODES.WORKSPACE_FILE_NOT_FOUND);
    }
  }

  /**
   * Lists every regular file in the agent workspace as relative paths with
   * byte sizes, sorted by path. Symlinks and dotted residue are never
   * reported or followed; the walk stops at the depth limit.
   */
  async listFiles(taskId: string, agentId: string): Promise<WorkspaceFileEntry[]> {
    const root = this.paths.taskWorkspaceRoot(taskId, agentId);
    const entries: WorkspaceFileEntry[] = [];
    await this.walk(root, root, 0, entries);
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return entries;
  }

  /**
   * Validates one relative path and resolves it inside `root`. Rejects empty,
   * oversized, absolute or NUL-bearing paths, paths outside 1..4 segments,
   * unsafe segments, and anything that does not stay under `root + sep`.
   */
  private resolveContained(root: string, relPath: string): string {
    if (
      typeof relPath !== 'string' ||
      relPath.length === 0 ||
      relPath.length > WORKSPACE_LIMITS.maxPathLength ||
      relPath.includes('\0') ||
      isAbsolute(relPath)
    ) {
      throw workspaceFailure(WORKSPACE_ERROR_CODES.WORKSPACE_PATH_UNSAFE);
    }
    const segments = relPath.split('/');
    if (segments.length < 1 || segments.length > WORKSPACE_LIMITS.maxPathDepth) {
      throw workspaceFailure(WORKSPACE_ERROR_CODES.WORKSPACE_PATH_UNSAFE);
    }
    for (const segment of segments) {
      if (!isSafeSegment(segment)) {
        throw workspaceFailure(WORKSPACE_ERROR_CODES.WORKSPACE_PATH_UNSAFE);
      }
    }
    const resolved = resolve(root, relPath);
    if (!resolved.startsWith(root + sep)) {
      throw workspaceFailure(WORKSPACE_ERROR_CODES.WORKSPACE_PATH_UNSAFE);
    }
    return resolved;
  }

  /** Realpath containment: `dir` must resolve inside (or equal) `root`. */
  private async assertRealContained(root: string, dir: string): Promise<void> {
    let realDir: string;
    let realRoot: string;
    try {
      realDir = await realpath(dir);
      realRoot = await realpath(root);
    } catch {
      throw workspaceFailure(WORKSPACE_ERROR_CODES.WORKSPACE_PATH_UNSAFE);
    }
    if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
      throw workspaceFailure(WORKSPACE_ERROR_CODES.WORKSPACE_PATH_UNSAFE);
    }
  }

  /** Depth-guarded recursive walk collecting regular files, skipping
   * symlinks and dotted names (temp residue never counts). */
  private async walk(
    root: string,
    dir: string,
    depth: number,
    out: WorkspaceFileEntry[],
  ): Promise<void> {
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // A missing workspace lists as empty.
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.') || dirent.isSymbolicLink()) {
        continue;
      }
      const full = join(dir, dirent.name);
      const entryDepth = depth + 1;
      if (dirent.isDirectory()) {
        if (entryDepth < WORKSPACE_LIMITS.maxPathDepth) {
          await this.walk(root, full, entryDepth, out);
        }
      } else if (dirent.isFile() && entryDepth <= WORKSPACE_LIMITS.maxPathDepth) {
        try {
          const fileStat = await stat(full);
          out.push({ path: toPosix(relative(root, full)), bytes: fileStat.size });
        } catch {
          // Unreadable entries are skipped, never surfaced.
        }
      }
    }
  }

  private async countFiles(root: string): Promise<number> {
    const entries: WorkspaceFileEntry[] = [];
    await this.walk(root, root, 0, entries);
    return entries.length;
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
