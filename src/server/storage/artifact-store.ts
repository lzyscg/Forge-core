/**
 * Append-only artifact version store (plan Phase B Task 4).
 *
 * Artifact versions live at `artifacts/vNNN/` (spec §8.1), each published
 * through a temporary sibling directory holding `meta.json` plus
 * `content.md`/`content.txt` and renamed into place only when complete. The
 * store allocates versions itself (max existing + 1) and never accepts a
 * caller-supplied version. Committed versions are never replaced; metadata
 * carries the uuid, version, title, source node, format, SHA-256 content
 * hash and creation time. Every scan re-checks committed versions — a
 * damaged meta/content or hash mismatch fails loud with TASK_CORRUPTED and
 * blocks further publishing instead of being skipped (spec §8.3; isolating
 * damage into a diagnostic summary belongs to the list layer). Temporary
 * residue (`.tmp-*`) and malformed names are never listed and never counted.
 *
 * No business vocabulary lives here (iron rule 1).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactVersion } from '../../shared/contracts';
import type { CorePaths } from './core-paths';
import { CorePathError } from './core-paths';
import { STORAGE_ERROR_CODES, StorageError, writeNewAtomic } from './atomic-file';

/** Caller-supplied publish input. Versions are allocated by the store only. */
export interface ArtifactProposal {
  title: string;
  content: string;
  sourceNodeId: string;
  format: 'markdown' | 'text';
}

/** Committed metadata (`meta.json`) of one artifact version. */
export interface ArtifactMeta {
  id: string;
  version: number;
  title: string;
  sourceNodeId: string;
  format: 'markdown' | 'text';
  contentHash: string;
  createdAt: string;
}

/** One committed version: validated metadata plus the full body text. */
export interface ArtifactEntry {
  meta: ArtifactMeta;
  content: string;
}

const TMP_PREFIX = '.tmp-';

const VERSION_DIR = /^v(\d{3})$/;

const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

const CONTENT_FILE_NAME: Record<ArtifactProposal['format'], string> = {
  markdown: 'content.md',
  text: 'content.txt',
};

function invalidInput(message: string, action: string): StorageError {
  return new StorageError(STORAGE_ERROR_CODES.INVALID_INPUT, message, null, action);
}

function corrupt(message: string): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.TASK_CORRUPTED,
    message,
    null,
    '检查该任务的本地产物目录。',
  );
}

function notFound(taskId: string): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.TASK_NOT_FOUND,
    `未找到任务 ${taskId} 的产物版本。`,
    null,
    '返回任务列表。',
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Extracts and validates the four declared proposal fields. */
function validateProposal(candidate: unknown): ArtifactProposal {
  if (!isPlainObject(candidate)) {
    throw invalidInput('产物提案必须是对象。', '按模板产物要求重新提交。');
  }
  if (typeof candidate.title !== 'string' || candidate.title.length === 0) {
    throw invalidInput('产物标题不能为空。', '填写产物标题后重新提交。');
  }
  if (typeof candidate.content !== 'string' || candidate.content.length === 0) {
    throw invalidInput('产物正文不能为空。', '填写产物正文后重新提交。');
  }
  if (typeof candidate.sourceNodeId !== 'string' || candidate.sourceNodeId.length === 0) {
    throw invalidInput('产物来源节点缺失。', '在任务画布内重新提交产物。');
  }
  const format = candidate.format;
  if (format !== 'markdown' && format !== 'text') {
    throw invalidInput('产物格式必须是 markdown 或 text。', '按模板声明的产物格式重新提交。');
  }
  // Any caller-supplied extra field (notably `version`) is ignored: the store
  // alone allocates versions.
  return {
    title: candidate.title,
    content: candidate.content,
    sourceNodeId: candidate.sourceNodeId,
    format,
  };
}

/** Re-validates one committed meta.json; damage fails loud, never guessed. */
function validateMeta(raw: string, expectedVersion: number): ArtifactMeta {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw corrupt('产物元数据不是有效 JSON。');
  }
  if (
    !isPlainObject(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.title !== 'string' ||
    value.title.length === 0 ||
    typeof value.sourceNodeId !== 'string' ||
    value.sourceNodeId.length === 0 ||
    typeof value.contentHash !== 'string' ||
    !CONTENT_HASH_PATTERN.test(value.contentHash) ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    throw corrupt('产物元数据缺失或不可用。');
  }
  const format = value.format;
  if (format !== 'markdown' && format !== 'text') {
    throw corrupt('产物元数据格式非法。');
  }
  if (
    typeof value.version !== 'number' ||
    !Number.isInteger(value.version) ||
    value.version !== expectedVersion
  ) {
    throw corrupt('产物元数据版本与目录不一致。');
  }
  return {
    id: value.id,
    version: value.version,
    title: value.title,
    sourceNodeId: value.sourceNodeId,
    format,
    contentHash: value.contentHash,
    createdAt: value.createdAt,
  };
}

export class ArtifactStore {
  private readonly paths: CorePaths;

  /** Per-task publish serialization within this single process. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(paths: CorePaths) {
    this.paths = paths;
  }

  /**
   * Publishes one new artifact version. Invalid proposals are rejected
   * before touching disk; damaged committed versions fail loud and block the
   * publish instead of being skipped.
   */
  async publish(taskId: string, proposal: ArtifactProposal): Promise<ArtifactVersion> {
    const validated = validateProposal(proposal);
    return this.enqueue(taskId, () => this.publishExclusive(taskId, validated));
  }

  /** Reads one committed version. Unknown versions/tasks report TASK_NOT_FOUND. */
  async read(taskId: string, version: number): Promise<ArtifactEntry> {
    // taskArtifactVersionRoot rejects version < 1 (CORE_PATH_INVALID) first.
    const versionRoot = this.paths.taskArtifactVersionRoot(taskId, version);
    let dirStat: Awaited<ReturnType<typeof stat>>;
    try {
      dirStat = await stat(versionRoot);
    } catch {
      throw notFound(taskId);
    }
    if (!dirStat.isDirectory()) {
      throw notFound(taskId);
    }
    return this.readEntry(taskId, version);
  }

  /** Lists committed versions ordered by version; unknown tasks list empty. */
  async list(taskId: string): Promise<ArtifactEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.paths.taskArtifactsRoot(taskId));
    } catch {
      return [];
    }
    const versions: number[] = [];
    for (const name of names) {
      if (name.startsWith(TMP_PREFIX)) {
        continue; // Temporary staging residue is never listed (spec §8.2).
      }
      const match = VERSION_DIR.exec(name);
      if (match === null) {
        continue; // Malformed names are ignored, never projected.
      }
      versions.push(Number(match[1]));
    }
    versions.sort((a, b) => a - b);
    const entries: ArtifactEntry[] = [];
    for (const version of versions) {
      entries.push(await this.readEntry(taskId, version));
    }
    return entries;
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

  private async publishExclusive(
    taskId: string,
    proposal: ArtifactProposal,
  ): Promise<{
    id: string;
    version: number;
    title: string;
    content: string;
    sourceNodeId: string;
    createdAt: string;
    final: false;
  }> {
    // Publishing under an unknown task would invent a task directory; refuse.
    try {
      const taskStat = await stat(this.paths.taskRoot(taskId));
      if (!taskStat.isDirectory()) {
        throw notFound(taskId);
      }
    } catch (error) {
      if (error instanceof StorageError || error instanceof CorePathError) {
        throw error; // Unsafe identifiers fail loud, never as "not found".
      }
      throw notFound(taskId);
    }
    // Re-check every committed version before allocating the next one:
    // damaged history blocks publishing instead of being skipped over.
    const committed = await this.list(taskId);
    const version = (committed[committed.length - 1]?.meta.version ?? 0) + 1;
    const meta: ArtifactMeta = {
      id: randomUUID(),
      version,
      title: proposal.title,
      sourceNodeId: proposal.sourceNodeId,
      format: proposal.format,
      contentHash: sha256(proposal.content),
      createdAt: new Date().toISOString(),
    };
    const versionDirName = `v${String(version).padStart(3, '0')}`;
    const destination = this.paths.taskArtifactVersionRoot(taskId, version);
    const stageDir = join(this.paths.taskArtifactsRoot(taskId), `${TMP_PREFIX}${versionDirName}-${randomUUID()}`);
    try {
      await writeNewAtomic(
        join(stageDir, 'meta.json'),
        Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8'),
      );
      await writeNewAtomic(
        join(stageDir, CONTENT_FILE_NAME[proposal.format]),
        Buffer.from(proposal.content, 'utf8'),
      );
      await rename(stageDir, destination);
    } catch (error) {
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof StorageError) {
        throw error;
      }
      throw corrupt('产物版本发布失败。');
    }
    return {
      id: meta.id,
      version: meta.version,
      title: meta.title,
      content: proposal.content,
      sourceNodeId: meta.sourceNodeId,
      createdAt: meta.createdAt,
      final: false,
    };
  }

  /** Reads and re-validates one committed version directory. */
  private async readEntry(taskId: string, version: number): Promise<ArtifactEntry> {
    const versionRoot = this.paths.taskArtifactVersionRoot(taskId, version);
    let metaRaw: string;
    try {
      metaRaw = await readFile(join(versionRoot, 'meta.json'), 'utf8');
    } catch {
      throw corrupt('产物元数据不可读。');
    }
    const meta = validateMeta(metaRaw, version);
    let content: string;
    try {
      content = await readFile(join(versionRoot, CONTENT_FILE_NAME[meta.format]), 'utf8');
    } catch {
      throw corrupt('产物正文不可读。');
    }
    if (sha256(content) !== meta.contentHash) {
      throw corrupt('产物正文与元数据哈希不一致。');
    }
    return { meta, content };
  }
}
