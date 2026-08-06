/**
 * Append-only artifact version directory store (plan Phase B Task 4; v7
 * artifact version directory schema in plan 2026-08-07 Phase 1).
 *
 * Artifact versions live at `artifacts/vNNN/` (spec §3.1): one directory per
 * version carrying every file that version produced or accrued (the writer's
 * `content.md`/`revision.md`, the reviewer's `review.md`, …). The store
 * allocates versions itself from the authoritative event stream (the count of
 * committed `artifact_published` events plus one — spec §8) and never accepts
 * a caller-supplied version. Committed versions are never replaced; a
 * production file set is written atomically through a temporary sibling
 * renamed into place only when complete, and an annotate file is appended
 * atomically (staging → event → rename, spec §8).
 *
 * The event stream is the sole authority over file integrity (spec §3.1):
 * `meta.json` carries the artifact id and identity but NO file hashes — the
 * hashes live on the `artifact_published`/`artifact_annotated` events. On
 * read the store cross-checks the disk files against those events (spec §8);
 * the read window tolerates "event exists, directory missing" by claiming a
 * staged sibling (rename) instead of declaring corruption. An orphan
 * directory without a backing event (a publish that completed on disk but
 * whose event crashed) is reclaimed by the next publish of that version
 * (claim-by-hash) or ignored by reads until reclaimed.
 *
 * The store injects `EventStore` for version counting, annotate uniqueness
 * and the disk↔event cross-check (EventStore does not depend on
 * ArtifactStore, so there is no cycle — spec §8).
 *
 * No business vocabulary lives here (iron rule 1).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { CorePaths } from './core-paths';
import { CorePathError } from './core-paths';
import { STORAGE_ERROR_CODES, StorageError, writeNewAtomic } from './atomic-file';
import type { EventStore, CommittedEvent } from './event-store';
import type { TaskEvent } from './task-events';

const TMP_PREFIX = '.tmp-';
const ANNOTATE_TMP_PREFIX = '.tmp-annotate-';

const VERSION_DIR = /^v(\d{3})$/;

/** A production file the writer seals into a new version. */
export interface ArtifactFileInput {
  name: string;
  content: string;
}

/** Caller-supplied publish input. Versions are allocated by the store only. */
export interface ArtifactProposal {
  title: string;
  files: ArtifactFileInput[];
  sourceNodeId: string;
  format: 'markdown' | 'text';
}

/** Committed metadata (`meta.json`) of one artifact version (no file hashes). */
export interface ArtifactMeta {
  id: string;
  version: number;
  title: string;
  sourceNodeId: string;
  format: 'markdown' | 'text';
  createdAt: string;
}

/** One committed file: its name plus the full body text. */
export interface ArtifactStoredFile {
  name: string;
  content: string;
}

/** One committed version: validated metadata plus every file body. */
export interface ArtifactEntry {
  meta: ArtifactMeta;
  files: ArtifactStoredFile[];
}

/** What `publish` returns — the identity the committer records on the event. */
export interface PublishedArtifact {
  id: string;
  version: number;
  title: string;
  files: Array<{ name: string; hash: string }>;
  sourceNodeId: string;
  format: 'markdown' | 'text';
  createdAt: string;
}

/** Caller-supplied annotate input. */
export interface AnnotateProposal {
  version: number;
  file: string;
  content: string;
  turnId: string;
  /** The annotating turn's result-node id (replay self-exclusion key). */
  nodeId: string;
}

/** What `annotate` returns — the content hash the committer records. */
export interface AnnotatedFile {
  version: number;
  file: string;
  contentHash: string;
  turnId: string;
  nodeId: string;
}

const META_FILE = 'meta.json';

/** File names a publish/annotate may never claim (reserved). */
const RESERVED_FILE_NAMES = new Set([META_FILE]);

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

/** A safe, single-segment file name (no traversal, no reserved names). */
function assertFileName(name: unknown, where: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw invalidInput(`${where} 必须是非空文件名。`, '按模板产物要求重新提交。');
  }
  if (RESERVED_FILE_NAMES.has(name)) {
    throw invalidInput(`${where} 是保留文件名。`, '使用模板声明的产物文件名。');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw invalidInput(`${where} 含有非法路径片段。`, '使用纯文件名。');
  }
  return name;
}

/** Extracts and validates a publish proposal. */
function validateProposal(candidate: unknown): ArtifactProposal {
  if (!isPlainObject(candidate)) {
    throw invalidInput('产物提案必须是对象。', '按模板产物要求重新提交。');
  }
  if (typeof candidate.title !== 'string' || candidate.title.length === 0) {
    throw invalidInput('产物标题不能为空。', '填写产物标题后重新提交。');
  }
  if (typeof candidate.sourceNodeId !== 'string' || candidate.sourceNodeId.length === 0) {
    throw invalidInput('产物来源节点缺失。', '在任务画布内重新提交产物。');
  }
  const format = candidate.format;
  if (format !== 'markdown' && format !== 'text') {
    throw invalidInput('产物格式必须是 markdown 或 text。', '按模板声明的产物格式重新提交。');
  }
  if (!Array.isArray(candidate.files) || candidate.files.length === 0) {
    throw invalidInput('产物文件列表不能为空。', '至少提交一个产物文件。');
  }
  const seen = new Set<string>();
  const files: ArtifactFileInput[] = candidate.files.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw invalidInput(`产物文件[${index}]必须是对象。`, '按模板产物要求重新提交。');
    }
    const name = assertFileName(entry.name, `产物文件[${index}].name`);
    if (seen.has(name)) {
      throw invalidInput(`产物文件[${index}]重名。`, '产物文件名不能重复。');
    }
    seen.add(name);
    if (typeof entry.content !== 'string' || entry.content.length === 0) {
      throw invalidInput(`产物文件[${index}]正文不能为空。`, '填写产物正文后重新提交。');
    }
    return { name, content: entry.content };
  });
  return { title: candidate.title, files, sourceNodeId: candidate.sourceNodeId, format };
}

function validateAnnotate(candidate: AnnotateProposal): AnnotateProposal {
  if (!Number.isInteger(candidate.version) || candidate.version < 1) {
    throw invalidInput('标注的产物版本必须是正整数。', '使用已发布版本重试。');
  }
  assertFileName(candidate.file, '标注文件名');
  if (typeof candidate.content !== 'string' || candidate.content.length === 0) {
    throw invalidInput('标注内容不能为空。', '填写标注内容后重新提交。');
  }
  if (typeof candidate.turnId !== 'string' || candidate.turnId.length === 0) {
    throw invalidInput('标注回合标识缺失。', '通过生产画布重新提交。');
  }
  if (typeof candidate.nodeId !== 'string' || candidate.nodeId.length === 0) {
    throw invalidInput('标注节点标识缺失。', '通过生产画布重新提交。');
  }
  return candidate;
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
  // meta.json must NOT carry file hashes (spec §3.1) — they live on the event.
  if (value.contentHash !== undefined || value.files !== undefined) {
    throw corrupt('产物元数据携带了不应有的字段。');
  }
  return {
    id: value.id,
    version: value.version,
    title: value.title,
    sourceNodeId: value.sourceNodeId,
    format,
    createdAt: value.createdAt,
  };
}

/** Filters the committed events to the artifact_published members, in order. */
function publishedEvents(events: readonly CommittedEvent[]): Extract<TaskEvent, { type: 'artifact_published' }>[] {
  const result: Extract<TaskEvent, { type: 'artifact_published' }>[] = [];
  for (const entry of events) {
    if (entry.event.type === 'artifact_published') {
      result.push(entry.event);
    }
  }
  return result;
}

/** Filters the committed events to the artifact_annotated members, in order. */
function annotatedEvents(events: readonly CommittedEvent[]): Extract<TaskEvent, { type: 'artifact_annotated' }>[] {
  const result: Extract<TaskEvent, { type: 'artifact_annotated' }>[] = [];
  for (const entry of events) {
    if (entry.event.type === 'artifact_annotated') {
      result.push(entry.event);
    }
  }
  return result;
}

export class ArtifactStore {
  private readonly paths: CorePaths;

  private readonly events: EventStore;

  /** Per-task publish/annotate serialization within this single process. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(paths: CorePaths, events: EventStore) {
    this.paths = paths;
    this.events = events;
  }

  /**
   * Publishes one new artifact version. Invalid proposals are rejected before
   * touching disk; the version is allocated from the authoritative event count
   * (committed `artifact_published` events + 1) so the on-disk version number
   * can never drift from the event stream. An orphan directory left by a
   * publish that completed on disk but whose event crashed is reclaimed
   * (claim-by-hash) instead of colliding.
   */
  async publish(taskId: string, proposal: ArtifactProposal): Promise<PublishedArtifact> {
    const validated = validateProposal(proposal);
    return this.enqueue(taskId, () => this.publishExclusive(taskId, validated));
  }

  /**
   * Appends one annotate file to an existing version directory atomically
   * (staging → event → rename). Uniqueness holds across the committed
   * `artifact_annotated` events: a second annotation of the same
   * (version, file) by a different turn is rejected, while a replay of the
   * same turn (same `nodeId`) is self-excluded and treated as idempotent.
   */
  async annotate(taskId: string, proposal: AnnotateProposal): Promise<AnnotatedFile> {
    const validated = validateAnnotate(proposal);
    return this.enqueue(taskId, () => this.annotateExclusive(taskId, validated));
  }

  /** Reads one file of a committed version (for `read_artifact_version`). */
  async readFile(taskId: string, version: number, file: string): Promise<string> {
    assertFileName(file, '文件名');
    const entry = await this.read(taskId, version);
    const found = entry.files.find((item) => item.name === file);
    if (found === undefined) {
      throw notFound(taskId);
    }
    return found.content;
  }

  /** Reads one committed version. Unknown versions/tasks report TASK_NOT_FOUND. */
  async read(taskId: string, version: number): Promise<ArtifactEntry> {
    return this.enqueue(taskId, () => this.readExclusive(taskId, version));
  }

  /** Lists committed versions ordered by version; unknown tasks list empty. */
  async list(taskId: string): Promise<ArtifactEntry[]> {
    return this.enqueue(taskId, () => this.listExclusive(taskId));
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
  ): Promise<PublishedArtifact> {
    await this.ensureTaskRoot(taskId);
    const events = await this.events.read(taskId);
    const committed = publishedEvents(events);
    const version = committed.length + 1;
    const versionDirName = `v${String(version).padStart(3, '0')}`;
    const destination = this.paths.taskArtifactVersionRoot(taskId, version);
    const fileHashes = proposal.files.map((file) => ({ name: file.name, hash: sha256(file.content) }));

    // Reclaim an orphan final directory left by a publish whose event crashed:
    // if the content matches the proposal, return it as the claimed version;
    // a mismatch is corruption, never silently overwritten.
    let dirStat: Awaited<ReturnType<typeof stat>>;
    try {
      dirStat = await stat(destination);
    } catch {
      dirStat = undefined as unknown as Awaited<ReturnType<typeof stat>>;
    }
    if (dirStat !== undefined && dirStat !== null && dirStat.isDirectory()) {
      const claimed = await this.readVersionDir(taskId, version, destination);
      const diskHashByName = new Map(claimed.files.map((file) => [file.name, sha256(file.content)]));
      const matches = fileHashes.every(
        (entry) => diskHashByName.get(entry.name) === entry.hash,
      );
      if (!matches) {
        throw corrupt(`产物版本 ${version} 已存在但内容不一致。`);
      }
      return {
        id: claimed.meta.id,
        version: claimed.meta.version,
        title: claimed.meta.title,
        files: claimed.files.map((file) => ({ name: file.name, hash: sha256(file.content) })),
        sourceNodeId: claimed.meta.sourceNodeId,
        format: claimed.meta.format,
        createdAt: claimed.meta.createdAt,
      };
    }

    await this.cleanStagingFor(taskId, versionDirName);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const meta: ArtifactMeta = {
      id,
      version,
      title: proposal.title,
      sourceNodeId: proposal.sourceNodeId,
      format: proposal.format,
      createdAt,
    };
    const stageDir = join(
      this.paths.taskArtifactsRoot(taskId),
      `${TMP_PREFIX}${versionDirName}-${randomUUID()}`,
    );
    try {
      await mkdir(stageDir, { recursive: true });
      await writeNewAtomic(
        join(stageDir, META_FILE),
        Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8'),
      );
      for (const file of proposal.files) {
        await writeNewAtomic(join(stageDir, file.name), Buffer.from(file.content, 'utf8'));
      }
      await rename(stageDir, destination);
    } catch (error) {
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof StorageError) {
        throw error;
      }
      throw corrupt('产物版本发布失败。');
    }
    return {
      id,
      version,
      title: proposal.title,
      files: fileHashes,
      sourceNodeId: proposal.sourceNodeId,
      format: proposal.format,
      createdAt,
    };
  }

  private async annotateExclusive(
    taskId: string,
    proposal: AnnotateProposal,
  ): Promise<AnnotatedFile> {
    await this.ensureTaskRoot(taskId);
    const events = await this.events.read(taskId);
    const prior = annotatedEvents(events).filter(
      (event) => event.version === proposal.version && event.file === proposal.file,
    );
    // Replay self-exclusion: a prior annotation by THIS turn is idempotent.
    const foreign = prior.find((event) => event.nodeId !== proposal.nodeId);
    if (foreign !== undefined) {
      throw invalidInput(
        `产物版本 ${proposal.version} 的 ${proposal.file} 已被标注。`,
        '使用新的版本或文件重试。',
      );
    }
    const contentHash = sha256(proposal.content);
    const isReplay = prior.some((event) => event.nodeId === proposal.nodeId);

    const versionRoot = this.paths.taskArtifactVersionRoot(taskId, proposal.version);
    let dirStat: Awaited<ReturnType<typeof stat>>;
    try {
      dirStat = await stat(versionRoot);
    } catch {
      throw notFound(taskId);
    }
    if (!dirStat.isDirectory()) {
      throw notFound(taskId);
    }

    const filePath = join(versionRoot, proposal.file);
    let existingStat: Awaited<ReturnType<typeof stat>>;
    try {
      existingStat = await stat(filePath);
    } catch {
      existingStat = undefined as unknown as Awaited<ReturnType<typeof stat>>;
    }
    if (existingStat !== undefined && existingStat !== null) {
      // The file is already on disk. Replay idempotence: if the hash matches,
      // return the existing annotation; a mismatch is corruption.
      const existing = await readFile(filePath, 'utf8');
      if (sha256(existing) !== contentHash) {
        throw corrupt(`产物版本 ${proposal.version} 的 ${proposal.file} 已存在但内容不一致。`);
      }
      return {
        version: proposal.version,
        file: proposal.file,
        contentHash,
        turnId: proposal.turnId,
        nodeId: proposal.nodeId,
      };
    }

    if (isReplay) {
      // The event was committed but the file rename never landed (crash
      // window): fall through and re-append the staged file atomically.
    }

    const stageDir = join(
      this.paths.taskArtifactsRoot(taskId),
      `${ANNOTATE_TMP_PREFIX}${randomUUID()}`,
    );
    try {
      await mkdir(stageDir, { recursive: true });
      await writeNewAtomic(join(stageDir, proposal.file), Buffer.from(proposal.content, 'utf8'));
      await rename(join(stageDir, proposal.file), filePath);
    } finally {
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return {
      version: proposal.version,
      file: proposal.file,
      contentHash,
      turnId: proposal.turnId,
      nodeId: proposal.nodeId,
    };
  }

  private async readExclusive(taskId: string, version: number): Promise<ArtifactEntry> {
    const versionRoot = this.paths.taskArtifactVersionRoot(taskId, version);
    let dirStat: Awaited<ReturnType<typeof stat>>;
    try {
      dirStat = await stat(versionRoot);
    } catch {
      // Read-window tolerance (spec §8): "event exists, directory missing" —
      // claim a staged sibling instead of declaring corruption.
      const claimed = await this.claimStagedVersion(taskId, version);
      if (claimed !== null) {
        return this.crossCheck(taskId, version, claimed);
      }
      throw notFound(taskId);
    }
    if (!dirStat.isDirectory()) {
      throw notFound(taskId);
    }
    const entry = await this.readVersionDir(taskId, version, versionRoot);
    return this.crossCheck(taskId, version, entry);
  }

  private async listExclusive(taskId: string): Promise<ArtifactEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.paths.taskArtifactsRoot(taskId));
    } catch {
      return [];
    }
    const versions: number[] = [];
    for (const name of names) {
      if (name.startsWith(TMP_PREFIX) || name.startsWith(ANNOTATE_TMP_PREFIX)) {
        continue;
      }
      const match = VERSION_DIR.exec(name);
      if (match === null) {
        continue;
      }
      versions.push(Number(match[1]));
    }
    versions.sort((a, b) => a - b);
    const events = await this.events.read(taskId);
    const backed = new Set(publishedEvents(events).map((event) => event.artifact.version));
    const entries: ArtifactEntry[] = [];
    for (const version of versions) {
      // Only event-backed versions are committed (spec §3.1: the event stream
      // is the sole authority). Orphan directories without an event are
      // reclaimed by the next publish, never listed.
      if (!backed.has(version)) {
        continue;
      }
      let entry: ArtifactEntry;
      try {
        const versionRoot = this.paths.taskArtifactVersionRoot(taskId, version);
        let dirExists = false;
        try {
          const dirStat = await stat(versionRoot);
          dirExists = dirStat.isDirectory();
        } catch {
          dirExists = false;
        }
        if (!dirExists) {
          const claimed = await this.claimStagedVersion(taskId, version);
          if (claimed === null) {
            throw corrupt(`产物版本 ${version} 的事件存在但目录与暂存均缺失。`);
          }
          entry = claimed;
        } else {
          entry = await this.readVersionDir(taskId, version, versionRoot);
        }
        entries.push(await this.crossCheck(taskId, version, entry));
      } catch (error) {
        if (error instanceof StorageError) {
          throw error;
        }
        throw corrupt(`产物版本 ${version} 不可读。`);
      }
    }
    return entries;
  }

  /** Reads and re-validates one committed version directory's files. */
  private async readVersionDir(
    taskId: string,
    version: number,
    versionRoot: string,
  ): Promise<ArtifactEntry> {
    let metaRaw: string;
    try {
      metaRaw = await readFile(join(versionRoot, META_FILE), 'utf8');
    } catch {
      throw corrupt('产物元数据不可读。');
    }
    const meta = validateMeta(metaRaw, version);
    let names: string[];
    try {
      names = await readdir(versionRoot);
    } catch {
      throw corrupt('产物版本目录不可读。');
    }
    const files: ArtifactStoredFile[] = [];
    for (const name of names) {
      if (name === META_FILE || name.startsWith(TMP_PREFIX) || name.startsWith(ANNOTATE_TMP_PREFIX)) {
        continue;
      }
      let content: string;
      try {
        content = await readFile(join(versionRoot, name), 'utf8');
      } catch {
        throw corrupt(`产物文件 ${name} 不可读。`);
      }
      files.push({ name, content });
    }
    if (files.length === 0) {
      throw corrupt('产物版本目录没有产物文件。');
    }
    return { meta, files };
  }

  /**
   * Disk↔event cross-check (spec §8): the production files declared on the
   * `artifact_published` event must all be present on disk with matching
   * hashes, and every annotate file on disk must be backed by a matching
   * `artifact_annotated` event. Extra/missing production files fail loud.
   */
  private async crossCheck(
    taskId: string,
    version: number,
    entry: ArtifactEntry,
  ): Promise<ArtifactEntry> {
    const events = await this.events.read(taskId);
    const published = publishedEvents(events).find((event) => event.artifact.version === version);
    if (published === undefined) {
      throw corrupt(`产物版本 ${version} 没有对应的发布事件。`);
    }
    const diskByName = new Map(entry.files.map((file) => [file.name, file]));
    for (const declared of published.artifact.files) {
      const disk = diskByName.get(declared.name);
      if (disk === undefined) {
        throw corrupt(`产物版本 ${version} 缺少文件 ${declared.name}。`);
      }
      if (sha256(disk.content) !== declared.hash) {
        throw corrupt(`产物版本 ${version} 的 ${declared.name} 与事件哈希不一致。`);
      }
    }
    const annotatedForVersion = annotatedEvents(events).filter((event) => event.version === version);
    for (const file of entry.files) {
      const isProduction = published.artifact.files.some((declared) => declared.name === file.name);
      if (isProduction) {
        continue;
      }
      const match = annotatedForVersion.find((event) => event.file === file.name);
      if (match === undefined) {
        throw corrupt(`产物版本 ${version} 的 ${file.name} 没有对应的标注事件。`);
      }
      if (sha256(file.content) !== match.contentHash) {
        throw corrupt(`产物版本 ${version} 的 ${file.name} 与标注事件哈希不一致。`);
      }
    }
    return entry;
  }

  /**
   * Read-window tolerance (spec §8): when an event exists for a version but
   * the final directory is missing, claim a staged sibling whose meta id or
   * file hashes match the event, renaming it into place. Returns the claimed
   * entry, or null when no recoverable staging exists.
   */
  private async claimStagedVersion(taskId: string, version: number): Promise<ArtifactEntry | null> {
    const events = await this.events.read(taskId);
    const published = publishedEvents(events).find((event) => event.artifact.version === version);
    if (published === undefined) {
      return null; // No event to claim against — not a recoverable window.
    }
    const artifactsRoot = this.paths.taskArtifactsRoot(taskId);
    let names: string[];
    try {
      names = await readdir(artifactsRoot);
    } catch {
      return null;
    }
    const versionDirName = `v${String(version).padStart(3, '0')}`;
    const candidates = names.filter(
      (name) => name.startsWith(`${TMP_PREFIX}${versionDirName}`) || name.startsWith(`${TMP_PREFIX}v${String(version).padStart(3, '0')}`),
    );
    for (const candidate of candidates) {
      const stageDir = join(artifactsRoot, candidate);
      let entry: ArtifactEntry;
      try {
        entry = await this.readVersionDir(taskId, version, stageDir);
      } catch {
        continue; // A damaged staging candidate is skipped, not fatal.
      }
      if (entry.meta.id !== published.artifact.artifactId) {
        const idMatch = published.artifact.artifactId !== null && entry.meta.id === published.artifact.artifactId;
        if (!idMatch) {
          // Fall back to content-hash matching (spec §6 staging claim).
          const hashMatch = published.artifact.files.every((declared) => {
            const disk = entry.files.find((file) => file.name === declared.name);
            return disk !== undefined && sha256(disk.content) === declared.hash;
          });
          if (!hashMatch) {
            continue;
          }
        }
      }
      const destination = this.paths.taskArtifactVersionRoot(taskId, version);
      try {
        await rename(stageDir, destination);
      } catch {
        continue;
      }
      return this.readVersionDir(taskId, version, destination);
    }
    return null;
  }

  /** Removes staging directories for one version dir name. */
  private async cleanStagingFor(taskId: string, versionDirName: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.paths.taskArtifactsRoot(taskId));
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(`${TMP_PREFIX}${versionDirName}`)) {
        await rm(join(this.paths.taskArtifactsRoot(taskId), name), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      }
    }
  }

  /** Refuses to invent a task directory for an unknown task. */
  private async ensureTaskRoot(taskId: string): Promise<void> {
    try {
      const taskStat = await stat(this.paths.taskRoot(taskId));
      if (!taskStat.isDirectory()) {
        throw notFound(taskId);
      }
    } catch (error) {
      if (error instanceof StorageError || error instanceof CorePathError) {
        throw error;
      }
      throw notFound(taskId);
    }
  }
}
