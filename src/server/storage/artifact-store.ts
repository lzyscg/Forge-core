/**
 * Append-only artifact version directory store (plan Phase B Task 4; v7
 * artifact version directory schema in plan 2026-08-07 Phase 1).
 *
 * Artifact versions live at `artifacts/vNNN/` (spec §3.1): one directory per
 * version carrying every file that version produced or accrued (the writer's
 * `content.md`/`revision.md`, the reviewer's `review.md`, …). The store
 * allocates versions itself from the authoritative event stream (the maximum
 * committed v1/v2 publication version plus one) and never accepts a
 * caller-supplied version. Committed versions are never replaced; a
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
import type { AuthoritativeReviewEventV2 } from './authoritative-review-events';
import type {
  AuthoritativeBlobKindV2,
  BlobRefV2,
  SealRecordV2,
  SystemArtifactDeliveryV2,
} from '../../shared/authoritative-review-v2';
import type { SealRecord } from '../../shared/structured-slots';
import type { ArtifactCustodyV2, SealValidationBundleV2 } from '../authoritative-review/authority-types';
import { parseBlob } from '../authoritative-review/object-registry';

const TMP_PREFIX = '.tmp-';
const ANNOTATE_TMP_PREFIX = '.tmp-annotate-';
const CUSTODY_MANIFEST_FILE = 'manifest.json';
const CUSTODY_SEAL_RECORD_FILE = 'seal-record.json';
const SYSTEM_STAGE_FILE = 'system-stage.json';

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
export interface ArtifactMetaV1 {
  authorityKind?: 'agent_v1';
  id: string;
  version: number;
  title: string;
  sourceNodeId: string;
  format: 'markdown' | 'text';
  createdAt: string;
}

export interface ArtifactMetaV2 {
  authorityKind: 'system_seal_v2';
  id: string;
  version: number;
  title: string;
  format: 'markdown' | 'text';
  createdAt: string;
  producerWorkItemId: string;
  sealRecordRef: BlobRefV2;
  artifactRef: BlobRefV2;
  custodyRef: BlobRefV2;
  templateSnapshotHash: string;
  deliveryRef: BlobRefV2;
  sourceNodeId?: never;
}

export type ArtifactMeta = ArtifactMetaV1 | ArtifactMetaV2;

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

/**
 * Resolver injected by the composition root for v2 provenance closure
 * validation (Task 21 P1#4): `(taskId, ref) => the resolved blob object`.
 * Only ever invoked for `system_seal_v2` meta — the v1 path never calls it.
 * The resolver must fail closed (throw) when the ref cannot be resolved to
 * exactly those bytes; the store re-validates the object against the ref via
 * the object registry either way.
 */
export type V2BlobResolver = (taskId: string, ref: BlobRefV2) => Promise<unknown>;

/**
 * The single unforgeable System Seal capability surface (Task 21 P1#5). Only
 * `ArtifactStore.createSystemSealPublisher()` hands one out; the privileged
 * exclusive stage/promote implementations are `#`-private instance methods that
 * no caller-supplied string can reach. There is no public caller-string
 * `stageSystemArtifact`/`promoteSystemArtifact` path left.
 */
export interface SystemSealPublisherCapability {
  stage(taskId: string, input: StageSystemArtifactInputV2): Promise<StagedSystemArtifactV2>;
  promote(taskId: string, input: PromoteSystemArtifactInputV2): Promise<ArtifactEntry>;
}

export interface StageSystemArtifactInputV2 {
  sealWorkItemId: string;
  artifactId: string;
  title: string;
  format: 'markdown' | 'text';
  producerWorkItemId: string;
  sealRecordRef: BlobRefV2;
  artifactRef: BlobRefV2;
  custodyRef: BlobRefV2;
  templateSnapshotHash: string;
  files: ArtifactFileInput[];
}

export interface StagedSystemArtifactV2 extends StageSystemArtifactInputV2 {
  stageIdentity: string;
  files: Array<ArtifactFileInput & { sha256: string; byteLength: number }>;
  createdAt: string;
}

export interface PromoteSystemArtifactInputV2 {
  sealWorkItemId: string;
  artifactRef: BlobRefV2;
  artifactVersion: number;
  deliveryRef: BlobRefV2;
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

/** One staged/promoted custody file's recorded identity (spec §12). */
export interface PreparedStructuredFile {
  name: string;
  sha256: string;
  byteLength: number;
}

/**
 * Structured custody staging input (spec §12 / design §17.1 step 7). The
 * content identity (J06) keys the custody directory; the version is ALWAYS
 * allocated by the store from the combined committed publication history. The `sealRecord` may
 * carry a provisional `artifactVersionRef`; the store stamps the real
 * `{ artifactId, version }` and stages it as `seal-record.json`.
 */
export interface PrepareStructuredVersionInput {
  contentIdentity: string;
  artifactId?: string;
  /** Optional replay drift guard: must equal the store-allocated version. */
  version?: number;
  files: ArtifactFileInput[];
  meta: { title: string; sourceNodeId: string; format: 'markdown' | 'text' };
  sealRecord: SealRecord;
}

/**
 * A prepared (staged) structured artifact version: all files/meta/manifest/
 * SealRecord live under `structured-slots/custody/<contentIdentity>/`, still
 * invisible to `list`/`read` until the batch event references the promoted
 * version. The SealRecord's `artifactVersionRef` is final.
 */
export interface PreparedStructuredVersion {
  contentIdentity: string;
  artifactId: string;
  version: number;
  title: string;
  sourceNodeId: string;
  format: 'markdown' | 'text';
  files: PreparedStructuredFile[];
  sealRecord: SealRecord;
  createdAt: string;
}

/** The recovery classification of one custody key after a crash. */
export interface RecoverStructuredCustodyResult {
  /**
   * `referenced`: an `artifact_published` event already commits this version —
   * all files + SealRecord verified readable. `orphan_reused`: an unreferenced
   * custody directory matches the expected digest and is kept. `orphan_removed`:
   * unreferenced residue was reconciled away (nothing to promote).
   */
  status: 'referenced' | 'orphan_reused' | 'orphan_removed';
  /** The verified handle on `referenced` / `orphan_reused`; null otherwise. */
  handle: PreparedStructuredVersion | null;
}

/** Expected custody digest used to prove an orphan by hash (spec §12). */
export interface RecoverStructuredCustodyInput {
  contentIdentity: string;
  expectedArtifactId: string;
  expectedVersion: number;
  expectedFiles: Array<{ name: string; sha256: string }>;
}

const META_FILE = 'meta.json';

/** Reserved custody bookkeeping files that are never artifact file bodies. */
const CUSTODY_BOOKKEEPING = new Set([META_FILE, CUSTODY_MANIFEST_FILE, CUSTODY_SEAL_RECORD_FILE]);

/** File names a publish/annotate may never claim (reserved). */
const RESERVED_FILE_NAMES = new Set([META_FILE, CUSTODY_MANIFEST_FILE, CUSTODY_SEAL_RECORD_FILE]);

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

/** Sealed custody integrity failure — never absorbed back into slot content. */
function integrityFailed(message: string): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.ARTIFACT_INTEGRITY_FAILED,
    message,
    null,
    '检查该任务的 sealed artifact 暂存目录。',
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

/** Stable response-loss/restart key; it deliberately excludes artifactVersion. */
export function systemArtifactStageIdentity(sealWorkItemId: string, artifactRef: BlobRefV2): string {
  return sha256(`${sealWorkItemId}\u0000${artifactRef.digest}`);
}

function sameBlobRef(a: BlobRefV2, b: BlobRefV2): boolean {
  return a.kind === b.kind && a.digest === b.digest && a.byteLength === b.byteLength
    && a.mediaType === b.mediaType && a.schemaVersion === b.schemaVersion;
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
  if (value.authorityKind === 'system_seal_v2') {
    const refs = ['sealRecordRef', 'artifactRef', 'custodyRef', 'deliveryRef'] as const;
    if (
      value.sourceNodeId !== undefined
      || typeof value.producerWorkItemId !== 'string'
      || typeof value.templateSnapshotHash !== 'string'
      || refs.some((key) => !isPlainObject(value[key]))
    ) throw corrupt('v2 产物元数据权威字段非法。');
    return {
      authorityKind: 'system_seal_v2',
      id: value.id,
      version: value.version,
      title: value.title,
      format,
      createdAt: value.createdAt,
      producerWorkItemId: value.producerWorkItemId,
      sealRecordRef: value.sealRecordRef as unknown as BlobRefV2,
      artifactRef: value.artifactRef as unknown as BlobRefV2,
      custodyRef: value.custodyRef as unknown as BlobRefV2,
      templateSnapshotHash: value.templateSnapshotHash,
      deliveryRef: value.deliveryRef as unknown as BlobRefV2,
    };
  }
  if (typeof value.sourceNodeId !== 'string' || (value.authorityKind !== undefined && value.authorityKind !== 'agent_v1')) {
    throw corrupt('v1 产物元数据来源节点非法。');
  }
  return {
    ...(value.authorityKind === 'agent_v1' ? { authorityKind: 'agent_v1' as const } : {}),
    id: value.id,
    version: value.version,
    title: value.title,
    sourceNodeId: value.sourceNodeId,
    format,
    createdAt: value.createdAt,
  };
}

function demandV1SourceNodeId(meta: ArtifactMeta): string {
  if (meta.authorityKind === 'system_seal_v2') {
    throw corrupt('v2 system artifact cannot be consumed through the v1 source-node adapter.');
  }
  return meta.sourceNodeId;
}

export type PublishedArtifactAuthority =
  | { kind: 'agent_v1'; event: Extract<TaskEvent, { type: 'artifact_published' }>; sourceNodeId: string }
  | { kind: 'system_seal_v2'; event: Extract<AuthoritativeReviewEventV2, { type: 'artifact_published_v2' }>; provenance: Extract<AuthoritativeReviewEventV2, { type: 'artifact_published_v2' }>['provenance'] };

/** Exact ordered v1/v2 publication authority adapter. */
export function publishedArtifactAuthorities(events: readonly CommittedEvent[]): PublishedArtifactAuthority[] {
  const result: PublishedArtifactAuthority[] = [];
  for (const entry of events) {
    if (entry.event.type === 'artifact_published') {
      result.push({ kind: 'agent_v1', event: entry.event, sourceNodeId: entry.event.artifact.sourceNodeId });
    } else if (entry.event.type === 'artifact_published_v2') {
      result.push({ kind: 'system_seal_v2', event: entry.event, provenance: entry.event.provenance });
    }
  }
  return result;
}

function authorityVersion(authority: PublishedArtifactAuthority): number {
  return authority.kind === 'agent_v1' ? authority.event.artifact.version : authority.event.artifactVersion;
}

function authorityArtifactId(authority: PublishedArtifactAuthority): string | null {
  return authority.kind === 'agent_v1' ? authority.event.artifact.artifactId : authority.event.artifactId;
}

function authorityFiles(authority: PublishedArtifactAuthority): readonly { name: string; hash: string }[] {
  return authority.kind === 'agent_v1' ? authority.event.artifact.files : authority.event.files;
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

  /** v2 provenance closure resolver (Task 21 P1#4); undefined in v1-only stores. */
  private readonly v2Resolver: V2BlobResolver | undefined;

  /** Per-task publish/annotate serialization within this single process. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(paths: CorePaths, events: EventStore, v2Resolver?: V2BlobResolver) {
    this.paths = paths;
    this.events = events;
    this.v2Resolver = v2Resolver;
  }

  /**
   * Publishes one new artifact version. Invalid proposals are rejected before
   * touching disk; the version is allocated from the authoritative combined
   * v1/v2 publication maximum + 1 so the on-disk version number
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

  /**
   * Hands out the SINGLE unforgeable System Seal capability (Task 21 P1#5).
   * There is no caller-string-authenticated `stageSystemArtifact` /
   * `promoteSystemArtifact` on the public class surface; the privileged
   * implementations are `#`-private instance methods reachable ONLY through
   * the closure bound here. An arbitrary holder of a raw `ArtifactStore` can
   * never stage/promote a v2 system artifact — the exclusive methods are not
   * prototype properties, so even `(store as any).stageSystemArtifactExclusive`
   * is undefined at runtime.
   */
  createSystemSealPublisher(): SystemSealPublisherCapability {
    return {
      stage: (taskId, input) =>
        this.enqueue(taskId, () => this.#stageSystemArtifactExclusive(taskId, input)),
      promote: (taskId, input) =>
        this.enqueue(taskId, () => this.#promoteSystemArtifactExclusive(taskId, input)),
    };
  }

  /**
   * Stages a structured artifact custody candidate (spec §12 / design §17.1):
   * allocates the NEXT event-backed version, stages every file/meta/manifest/
   * SealRecord under `structured-slots/custody/<contentIdentity>/`, stamps the
   * SealRecord's final `{ artifactId, version }` and verifies every staged hash.
   * The staged candidate is invisible to `list`/`read`; no event is written.
   * An unreferenced final-dir orphan at the allocated version is removed only
   * after proving no event references it (spec §12).
   */
  async prepareStructuredVersion(
    taskId: string,
    input: PrepareStructuredVersionInput,
  ): Promise<PreparedStructuredVersion> {
    return this.enqueue(taskId, () => this.prepareStructuredVersionExclusive(taskId, input));
  }

  /**
   * Promotes a prepared custody candidate to its unreferenced FINAL
   * `artifacts/vNNN/` directory (spec §12 / design §17.1 step 8). The promoted
   * version stays invisible to `list`/`read` until the batch event references
   * it; the custody directory is consumed by the atomic rename. A pre-existing
   * final directory is reused only when its content matches the recorded
   * digest — otherwise `ARTIFACT_INTEGRITY_FAILED` (never overwritten).
   */
  async promotePreparedVersion(
    taskId: string,
    handle: PreparedStructuredVersion,
  ): Promise<PreparedStructuredVersion> {
    return this.enqueue(taskId, () => this.promotePreparedVersionExclusive(taskId, handle));
  }

  /**
   * Crash recovery for one custody key (spec §12 / design §17.3): after the
   * batch all files + SealRecord are verified readable; before the batch an
   * orphan is reused (digest match) or removed. A hash mismatch anywhere is
   * `ARTIFACT_INTEGRITY_FAILED` — never absorbed back into slot content.
   */
  async recoverStructuredCustody(
    taskId: string,
    input: RecoverStructuredCustodyInput,
  ): Promise<RecoverStructuredCustodyResult> {
    return this.enqueue(taskId, () => this.recoverStructuredCustodyExclusive(taskId, input));
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
    const committed = publishedArtifactAuthorities(events);
    const version = committed.reduce((max, entry) => Math.max(max, authorityVersion(entry)), 0) + 1;
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
        sourceNodeId: demandV1SourceNodeId(claimed.meta),
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
    // Unreferenced final directories (structured custody promote before the
    // batch, spec §12) are invisible to read until the event references them.
    const events = await this.events.read(taskId);
    if (!publishedArtifactAuthorities(events).some((event) => authorityVersion(event) === version)) {
      throw notFound(taskId);
    }
    const entry = await this.readVersionDir(taskId, version, versionRoot);
    return this.crossCheck(taskId, version, entry);
  }

  private async listExclusive(taskId: string): Promise<ArtifactEntry[]> {
    const events = await this.events.read(taskId);
    const backed = new Set(publishedArtifactAuthorities(events).map(authorityVersion));
    // Event authority, not directory enumeration, defines the public list.
    // This also lets a reconstructed store claim a v2 custody stage after the
    // append succeeded but the caller lost the response before promote.
    const versions = [...backed].sort((a, b) => a - b);
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
      if (
        CUSTODY_BOOKKEEPING.has(name) ||
        name.startsWith(TMP_PREFIX) ||
        name.startsWith(ANNOTATE_TMP_PREFIX)
      ) {
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
    const published = publishedArtifactAuthorities(events).find((event) => authorityVersion(event) === version);
    if (published === undefined) {
      throw corrupt(`产物版本 ${version} 没有对应的发布事件。`);
    }
    if (published.kind === 'system_seal_v2') {
      if (entry.meta.authorityKind !== 'system_seal_v2') {
        throw corrupt(`产物版本 ${version} 的 v2 事件不能绑定 v1 meta。`);
      }
      if (
        entry.meta.id !== published.event.artifactId
        || entry.meta.producerWorkItemId !== published.provenance.producerWorkItemId
        || !sameBlobRef(entry.meta.sealRecordRef, published.provenance.sealRecordRef)
        || !sameBlobRef(entry.meta.artifactRef, published.provenance.artifactRef)
        || !sameBlobRef(entry.meta.custodyRef, published.provenance.custodyRef)
        || !sameBlobRef(entry.meta.deliveryRef, published.event.deliveryRef)
      ) throw corrupt(`产物版本 ${version} 的 v2 provenance 与事件不一致。`);
    } else if (entry.meta.authorityKind === 'system_seal_v2') {
      throw corrupt(`产物版本 ${version} 的 v1 事件不能绑定 v2 meta。`);
    }
    const diskByName = new Map(entry.files.map((file) => [file.name, file]));
    for (const declared of authorityFiles(published)) {
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
      const isProduction = authorityFiles(published).some((declared) => declared.name === file.name);
      if (isProduction) {
        continue;
      }
      if (published.kind === 'system_seal_v2') {
        throw corrupt(`v2 产物版本 ${version} 不允许 v1 annotation 文件 ${file.name}。`);
      }
      const match = annotatedForVersion.find((event) => event.file === file.name);
      if (match === undefined) {
        throw corrupt(`产物版本 ${version} 的 ${file.name} 没有对应的标注事件。`);
      }
      if (sha256(file.content) !== match.contentHash) {
        throw corrupt(`产物版本 ${version} 的 ${file.name} 与标注事件哈希不一致。`);
      }
    }
    // P1#4: when a v2 blob resolver is wired in, resolve the FULL provenance
    // closure — delivery → SealRecord → SealValidationBundle → custody →
    // artifact — and fail closed on any missing/wrong-kind/inconsistent link.
    // Without a resolver (v1-only or legacy stores) the disk↔event checks above
    // remain the enforceable surface; production always injects the resolver.
    if (published.kind === 'system_seal_v2' && this.v2Resolver !== undefined) {
      await this.verifyV2Closure(taskId, entry, published, events);
    }
    return entry;
  }

  /**
   * P1#4 closure validation: resolve every provenance link of a v2 system
   * artifact and verify cross-object ref/file consistency. Any missing link,
   * wrong kind, unresolvable/parse-failing blob or inconsistent field is
   * TASK_CORRUPTED — never silently downgraded to a v1 interpretation.
   */
  private async verifyV2Closure(
    taskId: string,
    entry: ArtifactEntry,
    published: Extract<PublishedArtifactAuthority, { kind: 'system_seal_v2' }>,
    events: readonly CommittedEvent[],
  ): Promise<void> {
    const meta = entry.meta as ArtifactMetaV2;
    const { event, provenance } = published;
    const version = meta.version;

    const isRef = (value: unknown): value is BlobRefV2 => isPlainObject(value);
    const checkRef = (actual: unknown, expected: BlobRefV2, what: string): void => {
      if (!isRef(actual) || !sameBlobRef(actual, expected)) {
        throw corrupt(`产物版本 ${version} 闭包 ${what} 与 meta/事件引用不一致。`);
      }
    };
    const checkText = (actual: unknown, expected: string, what: string): void => {
      if (actual !== expected) {
        throw corrupt(`产物版本 ${version} 闭包 ${what} 与 meta/事件不一致。`);
      }
    };

    // 1. deliveryRef → SystemArtifactDeliveryV2 (the event's own delivery ref).
    const delivery = (await this.resolveV2Blob(taskId, meta.deliveryRef, 'system artifact delivery')) as SystemArtifactDeliveryV2;
    checkRef(delivery.sealRecordRef, meta.sealRecordRef, 'delivery.sealRecordRef');
    checkRef(delivery.sealRecordRef, provenance.sealRecordRef, 'delivery.sealRecordRef(事件)');
    checkRef(delivery.artifactRef, meta.artifactRef, 'delivery.artifactRef');
    checkRef(delivery.artifactRef, provenance.artifactRef, 'delivery.artifactRef(事件)');
    checkRef(delivery.custodyRef, meta.custodyRef, 'delivery.custodyRef');
    checkRef(delivery.custodyRef, provenance.custodyRef, 'delivery.custodyRef(事件)');
    checkText(delivery.artifactId, event.artifactId, 'delivery.artifactId');
    checkText(delivery.templateSnapshotHash, meta.templateSnapshotHash, 'delivery.templateSnapshotHash');
    // submitterWorkItemId is not carried by the artifact event/meta; when the
    // delivery-created event is present it must agree.
    for (const committed of events) {
      const link = committed.event;
      if (
        link.type === 'structured_system_artifact_delivery_created'
        && isRef(link.deliveryRef)
        && sameBlobRef(link.deliveryRef, meta.deliveryRef)
      ) {
        checkText(link.submitterWorkItemId, delivery.submitterWorkItemId, 'delivery.submitterWorkItemId');
        checkText(link.artifactId, delivery.artifactId, 'delivery-created.artifactId');
        checkRef(link.artifactRef, delivery.artifactRef, 'delivery-created.artifactRef');
        checkRef(link.sealRecordRef, delivery.sealRecordRef, 'delivery-created.sealRecordRef');
      }
    }

    // 2. sealRecordRef → SealRecordV2.
    const sealRecord = (await this.resolveV2Blob(taskId, meta.sealRecordRef, 'seal record')) as SealRecordV2;
    checkText(sealRecord.taskId, taskId, 'seal record.taskId');
    checkRef(sealRecord.artifactRef, meta.artifactRef, 'seal record.artifactRef');
    checkText(sealRecord.templateSnapshotHash, meta.templateSnapshotHash, 'seal record.templateSnapshotHash');
    await this.resolveV2Blob(taskId, sealRecord.mapRef, 'map snapshot');
    await this.resolveV2Blob(taskId, sealRecord.contentRevisionManifestRef, 'content revision manifest');
    await this.resolveV2Blob(taskId, sealRecord.reviewBundleRef, 'review bundle');
    const bundleRef = sealRecord.sealValidationBundleRef;

    // 3. sealValidationBundleRef → SealValidationBundleV2.
    const bundle = (await this.resolveV2Blob(taskId, bundleRef, 'seal validation bundle')) as SealValidationBundleV2;
    checkRef(bundle.artifactRef, meta.artifactRef, 'seal validation bundle.artifactRef');
    checkText(bundle.sealWorkItemId, provenance.producerWorkItemId, 'seal validation bundle.sealWorkItemId');
    await this.resolveV2Blob(taskId, bundle.sealInputAggregateRef, 'seal input aggregate');
    await this.resolveV2Blob(taskId, bundle.sealOutputAggregateRef, 'seal output aggregate');
    // N1: the seal warning custody root is part of the P2#8 advisory custody
    // chain — deleting/mutating it after publication must fail closed too.
    await this.resolveV2Blob(taskId, bundle.sealWarningCustodyRootRef, 'seal warning custody root');

    // 4. custodyRef → ArtifactCustodyV2, and custody.files must equal the disk
    //    production file set (name + SHA-256 + UTF-8 byte length).
    const custody = (await this.resolveV2Blob(taskId, meta.custodyRef, 'artifact custody')) as ArtifactCustodyV2;
    checkRef(custody.artifactRef, meta.artifactRef, 'artifact custody.artifactRef');
    checkRef(custody.sealRecordRef, meta.sealRecordRef, 'artifact custody.sealRecordRef');
    checkText(custody.templateSnapshotHash, meta.templateSnapshotHash, 'artifact custody.templateSnapshotHash');
    checkText(custody.sealWorkItemId, provenance.producerWorkItemId, 'artifact custody.sealWorkItemId');
    checkText(custody.taskId, taskId, 'artifact custody.taskId');
    if (custody.files.length !== entry.files.length) {
      throw corrupt(`产物版本 ${version} 闭包 custody 文件清单与磁盘不一致。`);
    }
    const diskByName = new Map(entry.files.map((file) => [file.name, file]));
    for (const cust of custody.files) {
      const disk = diskByName.get(cust.name);
      if (disk === undefined) {
        throw corrupt(`产物版本 ${version} 闭包 custody 声明文件 ${cust.name} 但磁盘缺失。`);
      }
      if (cust.hash !== sha256(disk.content) || cust.byteLength !== Buffer.byteLength(disk.content, 'utf8')) {
        throw corrupt(`产物版本 ${version} 闭包 custody 文件 ${cust.name} 与磁盘哈希/字节长不一致。`);
      }
    }

    // 5. artifactRef → artifact blob; its text must match the production disk
    //    file the event declares with the same hash.
    const artifact = (await this.resolveV2Blob(taskId, meta.artifactRef, 'artifact blob')) as {
      artifactId: string;
      mediaType: string;
      text: string;
    };
    checkText(artifact.artifactId, event.artifactId, 'artifact.artifactId');
    checkText(artifact.mediaType, event.mediaType, 'artifact.mediaType');
    const artifactHash = sha256(artifact.text);
    const declaredFile = event.files.find((file) => file.hash === artifactHash);
    if (declaredFile === undefined) {
      throw corrupt(`产物版本 ${version} 闭包 artifact blob 与发布事件文件哈希不一致。`);
    }
    const diskArtifact = diskByName.get(declaredFile.name);
    if (diskArtifact === undefined || diskArtifact.content !== artifact.text) {
      throw corrupt(`产物版本 ${version} 闭包 artifact blob 与磁盘产物文件不一致。`);
    }
  }

  /**
   * Resolves one closure blob through the injected v2 resolver and re-validates
   * it against its ref via the object registry. Missing/unparseable/mismatched
   * blobs are TASK_CORRUPTED (fail closed); a resolver that already threw
   * TASK_CORRUPTED (e.g. the production blob store) propagates as-is.
   */
  private async resolveV2Blob(taskId: string, ref: BlobRefV2, what: string): Promise<unknown> {
    const resolver = this.v2Resolver;
    if (resolver === undefined) {
      throw corrupt(`产物版本闭包无法解析 ${what}：缺少 v2 blob 解析器。`);
    }
    let raw: unknown;
    try {
      raw = await resolver(taskId, ref);
    } catch (error) {
      if (error instanceof StorageError && error.code === STORAGE_ERROR_CODES.TASK_CORRUPTED) {
        throw error;
      }
      throw corrupt(`产物版本闭包 ${what} 解析失败。`);
    }
    if (raw === null || raw === undefined) {
      throw corrupt(`产物版本闭包 ${what} 缺失。`);
    }
    try {
      const { object } = parseBlob(ref.kind, raw, ref);
      return object;
    } catch {
      throw corrupt(`产物版本闭包 ${what} 内容或引用不一致。`);
    }
  }

  /**
   * Read-window tolerance (spec §8): when an event exists for a version but
   * the final directory is missing, claim a staged sibling whose meta id or
   * file hashes match the event, renaming it into place. Returns the claimed
   * entry, or null when no recoverable staging exists.
   */
  private async claimStagedVersion(taskId: string, version: number): Promise<ArtifactEntry | null> {
    const events = await this.events.read(taskId);
    const published = publishedArtifactAuthorities(events).find((event) => authorityVersion(event) === version);
    if (published === undefined) {
      return null; // No event to claim against — not a recoverable window.
    }
    if (published.kind === 'system_seal_v2') {
      return this.#promoteSystemArtifactExclusive(taskId, {
        sealWorkItemId: published.provenance.producerWorkItemId,
        artifactRef: published.provenance.artifactRef,
        artifactVersion: published.event.artifactVersion,
        deliveryRef: published.event.deliveryRef,
      }).catch((error: unknown) => {
        if (error instanceof StorageError && error.code === STORAGE_ERROR_CODES.TASK_NOT_FOUND) return null;
        throw error;
      });
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
      if (entry.meta.id !== authorityArtifactId(published)) {
        const artifactId = authorityArtifactId(published);
        const idMatch = artifactId !== null && entry.meta.id === artifactId;
        if (!idMatch) {
          // Fall back to content-hash matching (spec §6 staging claim).
          const hashMatch = authorityFiles(published).every((declared) => {
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

  // --------------------------------------------------------------------------
  // Authoritative v2 system custody: stage (no version) -> append -> promote.
  // --------------------------------------------------------------------------

  private systemStageDir(taskId: string, stageIdentity: string): string {
    return join(this.paths.taskStructuredCustodyRoot(taskId), `system-${stageIdentity}`);
  }

  private async readSystemStage(taskId: string, stageIdentity: string): Promise<StagedSystemArtifactV2> {
    const stageDir = this.systemStageDir(taskId, stageIdentity);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(stageDir, SYSTEM_STAGE_FILE), 'utf8'));
    } catch {
      throw integrityFailed('v2 system artifact stage manifest 不可读。');
    }
    if (!isPlainObject(value) || value.stageIdentity !== stageIdentity || 'version' in value || 'deliveryRef' in value) {
      throw integrityFailed('v2 system artifact stage manifest 非法。');
    }
    const manifest = value as unknown as StagedSystemArtifactV2;
    if (
      typeof manifest.sealWorkItemId !== 'string'
      || typeof manifest.artifactId !== 'string'
      || typeof manifest.title !== 'string'
      || (manifest.format !== 'markdown' && manifest.format !== 'text')
      || typeof manifest.producerWorkItemId !== 'string'
      || typeof manifest.templateSnapshotHash !== 'string'
      || typeof manifest.createdAt !== 'string'
      || !Array.isArray(manifest.files)
    ) throw integrityFailed('v2 system artifact stage 字段非法。');
    for (const file of manifest.files) {
      assertFileName(file.name, 'v2 system artifact stage 文件名');
      const body = await readFile(join(stageDir, file.name), 'utf8').catch(() => {
        throw integrityFailed(`v2 system artifact stage 文件 ${file.name} 缺失。`);
      });
      if (sha256(body) !== file.sha256 || Buffer.byteLength(body, 'utf8') !== file.byteLength) {
        throw integrityFailed(`v2 system artifact stage 文件 ${file.name} 与清单不一致。`);
      }
      file.content = body;
    }
    return manifest;
  }

  /**
   * Full byte-level idempotent match against the deterministic stage dir.
   * `readSystemStage` already re-reads and re-hashes every staged file, so a
   * match here means the on-disk bytes equal this input exactly.
   */
  private async matchSystemStage(
    taskId: string,
    stageIdentity: string,
    input: StageSystemArtifactInputV2,
    files: StagedSystemArtifactV2['files'],
  ): Promise<StagedSystemArtifactV2> {
    const existing = await this.readSystemStage(taskId, stageIdentity);
    const same = existing.artifactId === input.artifactId
      && existing.producerWorkItemId === input.producerWorkItemId
      && sameBlobRef(existing.sealRecordRef, input.sealRecordRef)
      && sameBlobRef(existing.artifactRef, input.artifactRef)
      && sameBlobRef(existing.custodyRef, input.custodyRef)
      && existing.templateSnapshotHash === input.templateSnapshotHash
      && existing.files.length === files.length
      && existing.files.every((file, index) => file.name === files[index]?.name && file.sha256 === files[index]?.sha256);
    if (!same) throw integrityFailed('相同 Seal stage identity 对应不同 v2 artifact bytes。');
    return existing;
  }

  /**
   * Removes only orphaned per-writer temp dirs for one stage identity. The
   * pattern (`system-<identity>.tmp-*`, i.e. the deterministic dir name plus
   * the `.tmp-` prefix) can never match the deterministic stage dir itself, so
   * cleanup is strictly scoped to crashed writers of THIS identity — never the
   * committed stage and never another identity's stage or temp dir.
   */
  private async cleanSystemStageTmpFor(taskId: string, stageIdentity: string): Promise<void> {
    const custodyRoot = this.paths.taskStructuredCustodyRoot(taskId);
    let names: string[];
    try {
      names = await readdir(custodyRoot);
    } catch {
      return;
    }
    const prefix = `system-${stageIdentity}${TMP_PREFIX}`;
    for (const name of names) {
      if (name.startsWith(prefix)) {
        await rm(join(custodyRoot, name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async #stageSystemArtifactExclusive(
    taskId: string,
    input: StageSystemArtifactInputV2,
  ): Promise<StagedSystemArtifactV2> {
    await this.ensureTaskRoot(taskId);
    if (input.sealWorkItemId.length === 0 || input.artifactId.length === 0 || input.producerWorkItemId !== input.sealWorkItemId) {
      throw invalidInput('v2 system artifact 的 Seal WorkItem 身份非法。', '重新运行 system Seal。');
    }
    if (input.title.length === 0 || input.templateSnapshotHash.length === 0 || !Array.isArray(input.files) || input.files.length === 0) {
      throw invalidInput('v2 system artifact 暂存输入缺失。', '重新运行 system Seal。');
    }
    const seen = new Set<string>();
    const files = input.files.map((file, index) => {
      const name = assertFileName(file.name, `v2 system artifact 文件[${index}].name`);
      if (seen.has(name) || typeof file.content !== 'string' || file.content.length === 0) {
        throw invalidInput('v2 system artifact 文件重复或为空。', '重新运行 assembler。');
      }
      seen.add(name);
      return { name, content: file.content, sha256: sha256(file.content), byteLength: Buffer.byteLength(file.content, 'utf8') };
    });
    const stageIdentity = systemArtifactStageIdentity(input.sealWorkItemId, input.artifactRef);
    const stageDir = this.systemStageDir(taskId, stageIdentity);
    if (await this.isDirectory(stageDir)) {
      return this.matchSystemStage(taskId, stageIdentity, input, files);
    }
    // Per-writer staging (Task 21 P1#7): this process writes every file into a
    // uniquely-named temp dir and only the atomic rename onto the deterministic
    // stageDir claims it. The deterministic stageDir is therefore created fully
    // formed, never byte-by-byte by racing writers. A rename loser never
    // touches the shared stageDir — it validates the winner's bytes instead —
    // so a duplicate/response-loss writer can never delete a committed stage.
    await this.cleanSystemStageTmpFor(taskId, stageIdentity);
    const tmpDir = `${stageDir}${TMP_PREFIX}${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const manifest: StagedSystemArtifactV2 = { ...input, stageIdentity, files, createdAt };
    const manifestBytes = { ...manifest, files: files.map(({ content: _content, ...file }) => file) };
    await mkdir(tmpDir, { recursive: true });
    try {
      await writeNewAtomic(join(tmpDir, SYSTEM_STAGE_FILE), Buffer.from(`${JSON.stringify(manifestBytes, null, 2)}\n`, 'utf8'));
      for (const file of files) await writeNewAtomic(join(tmpDir, file.name), Buffer.from(file.content, 'utf8'));
      await rename(tmpDir, stageDir);
    } catch (error) {
      // The only cleanup ever performed is this writer's own temp dir.
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof StorageError) throw error;
      const errno = (error as NodeJS.ErrnoException).code;
      if ((errno === 'EEXIST' || errno === 'ENOTEMPTY' || errno === 'EPERM') && (await this.isDirectory(stageDir))) {
        // Another process claimed the deterministic stageDir; never delete it.
        return this.matchSystemStage(taskId, stageIdentity, input, files);
      }
      throw integrityFailed('v2 system artifact 暂存失败。');
    }
    return manifest;
  }

  async #promoteSystemArtifactExclusive(
    taskId: string,
    input: PromoteSystemArtifactInputV2,
  ): Promise<ArtifactEntry> {
    await this.ensureTaskRoot(taskId);
    const events = await this.events.read(taskId);
    const authority = publishedArtifactAuthorities(events).find((entry) =>
      entry.kind === 'system_seal_v2' && entry.event.artifactVersion === input.artifactVersion,
    );
    if (authority === undefined || authority.kind !== 'system_seal_v2') throw notFound(taskId);
    if (
      authority.provenance.producerWorkItemId !== input.sealWorkItemId
      || !sameBlobRef(authority.provenance.artifactRef, input.artifactRef)
      || !sameBlobRef(authority.event.deliveryRef, input.deliveryRef)
    ) throw integrityFailed('v2 system artifact promote authority 与事件不一致。');
    const identity = systemArtifactStageIdentity(input.sealWorkItemId, input.artifactRef);
    const staged = await this.readSystemStage(taskId, identity);
    if (
      staged.artifactId !== authority.event.artifactId
      || staged.producerWorkItemId !== authority.provenance.producerWorkItemId
      || !sameBlobRef(staged.sealRecordRef, authority.provenance.sealRecordRef)
      || !sameBlobRef(staged.artifactRef, authority.provenance.artifactRef)
      || !sameBlobRef(staged.custodyRef, authority.provenance.custodyRef)
      || authority.event.files.length !== staged.files.length
      || !authority.event.files.every((file) => staged.files.some((disk) => disk.name === file.name && disk.sha256 === file.hash))
    ) throw integrityFailed('v2 system artifact stage 与已提交事件不一致。');

    const destination = this.paths.taskArtifactVersionRoot(taskId, input.artifactVersion);
    if (await this.isDirectory(destination)) {
      return this.crossCheck(taskId, input.artifactVersion, await this.readVersionDir(taskId, input.artifactVersion, destination));
    }
    const meta: ArtifactMetaV2 = {
      authorityKind: 'system_seal_v2', id: staged.artifactId, version: input.artifactVersion,
      title: staged.title, format: staged.format, createdAt: staged.createdAt,
      producerWorkItemId: staged.producerWorkItemId, sealRecordRef: staged.sealRecordRef,
      artifactRef: staged.artifactRef, custodyRef: staged.custodyRef,
      templateSnapshotHash: staged.templateSnapshotHash, deliveryRef: input.deliveryRef,
    };
    const stageDir = join(this.paths.taskArtifactsRoot(taskId), `${TMP_PREFIX}v${String(input.artifactVersion).padStart(3, '0')}-system-${identity}`);
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(stageDir, { recursive: true });
    try {
      await writeNewAtomic(join(stageDir, META_FILE), Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8'));
      for (const file of staged.files) await writeNewAtomic(join(stageDir, file.name), Buffer.from(file.content, 'utf8'));
      await rename(stageDir, destination);
    } catch (error) {
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof StorageError) throw error;
      if (await this.isDirectory(destination)) {
        return this.crossCheck(taskId, input.artifactVersion, await this.readVersionDir(taskId, input.artifactVersion, destination));
      }
      throw integrityFailed('v2 system artifact promote 失败。');
    }
    return this.crossCheck(taskId, input.artifactVersion, await this.readVersionDir(taskId, input.artifactVersion, destination));
  }

  // --------------------------------------------------------------------------
  // Structured custody (spec §12 / design §17) — stage → promote → batch.
  // --------------------------------------------------------------------------

  /** A content identity must be a single safe segment (64-hex SHA-256). */
  private assertContentIdentity(contentIdentity: string): string {
    if (!/^[a-f0-9]{64}$/.test(contentIdentity)) {
      throw invalidInput('结构化产物内容身份必须是 64 位十六进制 SHA-256。', '重新运行 request_seal。');
    }
    return contentIdentity;
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      const dirStat = await stat(path);
      return dirStat.isDirectory();
    } catch {
      return false;
    }
  }

  /** Reads and re-validates a custody directory's manifest entry. */
  private async readCustodyManifest(
    custodyDir: string,
    version: number,
  ): Promise<{ contentIdentity: string; artifactId: string; files: Array<{ name: string; sha256: string; byteLength: number }> }> {
    let raw: string;
    try {
      raw = await readFile(join(custodyDir, CUSTODY_MANIFEST_FILE), 'utf8');
    } catch {
      throw integrityFailed('custody manifest 不可读。');
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw integrityFailed('custody manifest 不是有效 JSON。');
    }
    if (!isPlainObject(value)) {
      throw integrityFailed('custody manifest 形状非法。');
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.contentIdentity !== 'string' ||
      typeof record.artifactId !== 'string' ||
      typeof record.version !== 'number' ||
      record.version !== version ||
      !Array.isArray(record.files)
    ) {
      throw integrityFailed('custody manifest 字段非法。');
    }
    const files: Array<{ name: string; sha256: string; byteLength: number }> = [];
    for (const entry of record.files) {
      if (!isPlainObject(entry)) {
        throw integrityFailed('custody manifest 文件条目非法。');
      }
      const file = entry as Record<string, unknown>;
      if (
        typeof file.name !== 'string' ||
        typeof file.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        typeof file.byteLength !== 'number' ||
        !Number.isInteger(file.byteLength) ||
        file.byteLength < 0
      ) {
        throw integrityFailed('custody manifest 文件条目字段非法。');
      }
      files.push({ name: file.name, sha256: file.sha256, byteLength: file.byteLength });
    }
    return { contentIdentity: record.contentIdentity, artifactId: record.artifactId, files };
  }

  /** Reads and re-validates a staged `seal-record.json`. */
  private async readCustodySealRecord(
    custodyDir: string,
  ): Promise<SealRecord> {
    let raw: string;
    try {
      raw = await readFile(join(custodyDir, CUSTODY_SEAL_RECORD_FILE), 'utf8');
    } catch {
      throw integrityFailed('custody seal-record 不可读。');
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw integrityFailed('custody seal-record 不是有效 JSON。');
    }
    if (!isPlainObject(value) || typeof (value as Record<string, unknown>).sealId !== 'string') {
      throw integrityFailed('custody seal-record 形状非法。');
    }
    return value as unknown as SealRecord;
  }

  /** Verifies the on-disk custody files against the manifest digests. */
  private async verifyCustodyFiles(
    custodyDir: string,
    files: Array<{ name: string; sha256: string; byteLength: number }>,
  ): Promise<void> {
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(join(custodyDir, file.name), 'utf8');
      } catch {
        throw integrityFailed(`custody 文件 ${file.name} 缺失。`);
      }
      if (Buffer.byteLength(content, 'utf8') !== file.byteLength) {
        throw integrityFailed(`custody 文件 ${file.name} 字节长度与清单不一致。`);
      }
      if (sha256(content) !== file.sha256) {
        throw integrityFailed(`custody 文件 ${file.name} 与清单哈希不一致。`);
      }
    }
  }

  /** Writes one custody directory from the in-memory candidate. */
  private async writeCustodyDir(
    custodyDir: string,
    input: PrepareStructuredVersionInput,
    artifactId: string,
    version: number,
    sealRecord: SealRecord,
    createdAt: string,
  ): Promise<PreparedStructuredVersion> {
    await rm(custodyDir, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(custodyDir, { recursive: true });
    const meta: ArtifactMeta = {
      id: artifactId,
      version,
      title: input.meta.title,
      sourceNodeId: input.meta.sourceNodeId,
      format: input.meta.format,
      createdAt,
    };
    const files: PreparedStructuredFile[] = input.files.map((file) => ({
      name: file.name,
      sha256: sha256(file.content),
      byteLength: Buffer.byteLength(file.content, 'utf8'),
    }));
    const manifest = {
      version,
      contentIdentity: input.contentIdentity,
      artifactId,
      files,
    };
    try {
      await writeNewAtomic(
        join(custodyDir, META_FILE),
        Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8'),
      );
      await writeNewAtomic(
        join(custodyDir, CUSTODY_MANIFEST_FILE),
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      );
      await writeNewAtomic(
        join(custodyDir, CUSTODY_SEAL_RECORD_FILE),
        Buffer.from(`${JSON.stringify(sealRecord, null, 2)}\n`, 'utf8'),
      );
      for (const file of input.files) {
        await writeNewAtomic(join(custodyDir, file.name), Buffer.from(file.content, 'utf8'));
      }
    } catch (error) {
      await rm(custodyDir, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof StorageError) {
        throw error;
      }
      throw integrityFailed('custody 暂存写入失败。');
    }
    return {
      contentIdentity: input.contentIdentity,
      artifactId,
      version,
      title: input.meta.title,
      sourceNodeId: input.meta.sourceNodeId,
      format: input.meta.format,
      files,
      sealRecord,
      createdAt,
    };
  }

  /** Rebuilds a handle from a custody directory (recovery reuse path). */
  private async handleFromCustodyDir(
    custodyDir: string,
    version: number,
  ): Promise<PreparedStructuredVersion> {
    const manifest = await this.readCustodyManifest(custodyDir, version);
    await this.verifyCustodyFiles(custodyDir, manifest.files);
    const sealRecord = await this.readCustodySealRecord(custodyDir);
    let metaRaw: string;
    try {
      metaRaw = await readFile(join(custodyDir, META_FILE), 'utf8');
    } catch {
      throw integrityFailed('custody meta 不可读。');
    }
    const meta = validateMeta(metaRaw, version);
    if (meta.id !== manifest.artifactId || sealRecord.artifactVersionRef.artifactId !== manifest.artifactId) {
      throw integrityFailed('custody 身份与清单不一致。');
    }
    return {
      contentIdentity: manifest.contentIdentity,
      artifactId: manifest.artifactId,
      version,
      title: meta.title,
      sourceNodeId: demandV1SourceNodeId(meta),
      format: meta.format,
      files: manifest.files,
      sealRecord,
      createdAt: meta.createdAt,
    };
  }

  private async prepareStructuredVersionExclusive(
    taskId: string,
    input: PrepareStructuredVersionInput,
  ): Promise<PreparedStructuredVersion> {
    await this.ensureTaskRoot(taskId);
    this.assertContentIdentity(input.contentIdentity);
    if (!Array.isArray(input.files) || input.files.length === 0) {
      throw invalidInput('结构化产物文件列表不能为空。', '至少提交一个产物文件。');
    }
    const validatedFiles: ArtifactFileInput[] = input.files.map((entry, index) => {
      if (!isPlainObject(entry)) {
        throw invalidInput(`结构化产物文件[${index}]必须是对象。`, '按模板产物要求重新提交。');
      }
      const name = assertFileName(entry.name, `结构化产物文件[${index}].name`);
      if (typeof entry.content !== 'string' || entry.content.length === 0) {
        throw invalidInput(`结构化产物文件[${index}]正文不能为空。`, '填写产物正文后重新提交。');
      }
      return { name, content: entry.content };
    });
    if (
      typeof input.meta.title !== 'string' ||
      input.meta.title.length === 0 ||
      typeof input.meta.sourceNodeId !== 'string' ||
      input.meta.sourceNodeId.length === 0
    ) {
      throw invalidInput('结构化产物 meta 缺失标题或来源。', '按模板产物要求重新提交。');
    }
    if (input.meta.format !== 'markdown' && input.meta.format !== 'text') {
      throw invalidInput('结构化产物格式必须是 markdown 或 text。', '按模板声明的产物格式重新提交。');
    }

    const events = await this.events.read(taskId);
    const version = publishedArtifactAuthorities(events)
      .reduce((max, entry) => Math.max(max, authorityVersion(entry)), 0) + 1;
    if (input.version !== undefined && input.version !== version) {
      throw invalidInput('结构化产物版本必须由事件流分配。', '重试以分配一致的版本。');
    }

    // A future prepare may replace a DIFFERENT orphan only after proving no
    // event references it (spec §12). The allocated version is always above
    // the combined committed v1/v2 maximum, so no event can reference it.
    const destination = this.paths.taskArtifactVersionRoot(taskId, version);
    if (await this.isDirectory(destination)) {
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    }

    const artifactId = input.artifactId ?? randomUUID();
    const createdAt = new Date().toISOString();
    const sealRecord: SealRecord = {
      ...input.sealRecord,
      artifactVersionRef: { artifactId, version },
    };
    const custodyDir = join(this.paths.taskStructuredCustodyRoot(taskId), input.contentIdentity);
    return this.writeCustodyDir(custodyDir, { ...input, files: validatedFiles }, artifactId, version, sealRecord, createdAt);
  }

  private async promotePreparedVersionExclusive(
    taskId: string,
    handle: PreparedStructuredVersion,
  ): Promise<PreparedStructuredVersion> {
    await this.ensureTaskRoot(taskId);
    const custodyDir = join(this.paths.taskStructuredCustodyRoot(taskId), handle.contentIdentity);
    if (!(await this.isDirectory(custodyDir))) {
      throw integrityFailed('custody 暂存目录缺失，无法 promote。');
    }
    // Re-verify the staged data matches the handle's recorded digest.
    const manifest = await this.readCustodyManifest(custodyDir, handle.version);
    if (manifest.artifactId !== handle.artifactId) {
      throw integrityFailed('custody 身份与 handle 不一致。');
    }
    await this.verifyCustodyFiles(custodyDir, handle.files);

    const destination = this.paths.taskArtifactVersionRoot(taskId, handle.version);
    if (await this.isDirectory(destination)) {
      // After-promote-before-batch orphan: reuse only when the content matches
      // the recorded digest; anything else is corruption, never overwritten.
      let claimed: ArtifactEntry;
      try {
        claimed = await this.readVersionDir(taskId, handle.version, destination);
      } catch {
        throw integrityFailed(`产物版本 ${handle.version} 已存在但内容不可读。`);
      }
      const diskByName = new Map(claimed.files.map((file) => [file.name, sha256(file.content)]));
      const matches = handle.files.every((file) => diskByName.get(file.name) === file.sha256);
      if (!matches) {
        throw integrityFailed(`产物版本 ${handle.version} 已存在但内容不一致。`);
      }
      return handle;
    }

    await this.cleanStagingFor(taskId, `v${String(handle.version).padStart(3, '0')}`);
    const stageDir = join(
      this.paths.taskArtifactsRoot(taskId),
      `${TMP_PREFIX}v${String(handle.version).padStart(3, '0')}-${randomUUID()}`,
    );
    try {
      await mkdir(stageDir, { recursive: true });
      await writeNewAtomic(join(stageDir, META_FILE), Buffer.from(await readFile(join(custodyDir, META_FILE), 'utf8'), 'utf8'));
      await writeNewAtomic(
        join(stageDir, CUSTODY_MANIFEST_FILE),
        Buffer.from(await readFile(join(custodyDir, CUSTODY_MANIFEST_FILE), 'utf8'), 'utf8'),
      );
      await writeNewAtomic(
        join(stageDir, CUSTODY_SEAL_RECORD_FILE),
        Buffer.from(await readFile(join(custodyDir, CUSTODY_SEAL_RECORD_FILE), 'utf8'), 'utf8'),
      );
      for (const file of handle.files) {
        await writeNewAtomic(
          join(stageDir, file.name),
          Buffer.from(await readFile(join(custodyDir, file.name), 'utf8'), 'utf8'),
        );
      }
      await rename(stageDir, destination);
    } catch (error) {
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof StorageError) {
        throw error;
      }
      throw integrityFailed('custody promote 失败。');
    }
    return handle;
  }

  private async recoverStructuredCustodyExclusive(
    taskId: string,
    input: RecoverStructuredCustodyInput,
  ): Promise<RecoverStructuredCustodyResult> {
    await this.ensureTaskRoot(taskId);
    this.assertContentIdentity(input.contentIdentity);
    const events = await this.events.read(taskId);
    const committed = publishedArtifactAuthorities(events);
    const referenced = committed.find(
      (event) =>
        (authorityArtifactId(event) !== null && authorityArtifactId(event) === input.expectedArtifactId) ||
        authorityVersion(event) === input.expectedVersion,
    );

    const custodyDir = join(this.paths.taskStructuredCustodyRoot(taskId), input.contentIdentity);
    const destination = this.paths.taskArtifactVersionRoot(taskId, input.expectedVersion);

    if (referenced !== undefined) {
      // After the batch: every file + the SealRecord must be readable.
      let entry: ArtifactEntry;
      try {
        entry = await this.readVersionDir(taskId, input.expectedVersion, destination);
        await this.crossCheck(taskId, input.expectedVersion, entry);
      } catch (error) {
        if (
          error instanceof StorageError &&
          error.code === STORAGE_ERROR_CODES.ARTIFACT_INTEGRITY_FAILED
        ) {
          throw error;
        }
        throw integrityFailed(`产物版本 ${input.expectedVersion} 目录缺失或与事件不一致。`);
      }
      let sealRecord: SealRecord;
      try {
        sealRecord = await this.readCustodySealRecord(destination);
      } catch {
        throw integrityFailed('已提交版本的 SealRecord 不可读。');
      }
      if (sealRecord.artifactVersionRef.artifactId !== input.expectedArtifactId) {
        throw integrityFailed('SealRecord 引用的 artifactId 与提交事件不一致。');
      }
      const handle: PreparedStructuredVersion = {
        contentIdentity: input.contentIdentity,
        artifactId: entry.meta.id,
        version: entry.meta.version,
        title: entry.meta.title,
        sourceNodeId: demandV1SourceNodeId(entry.meta),
        format: entry.meta.format,
        files: entry.files.map((file) => ({
          name: file.name,
          sha256: sha256(file.content),
          byteLength: Buffer.byteLength(file.content, 'utf8'),
        })),
        sealRecord,
        createdAt: entry.meta.createdAt,
      };
      return { status: 'referenced', handle };
    }

    // Unreferenced orphan: reconcile by digest (spec §12).
    if (await this.isDirectory(destination)) {
      // A promoted-but-unbatched orphan can be discarded: the custody dir is
      // the recovery source (batch-before-promote crash) or it can be re-staged.
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    }
    if (await this.isDirectory(custodyDir)) {
      try {
        const manifest = await this.readCustodyManifest(custodyDir, input.expectedVersion);
        const expectedByName = new Map(input.expectedFiles.map((file) => [file.name, file.sha256]));
        const matches =
          manifest.artifactId === input.expectedArtifactId &&
          manifest.files.length === input.expectedFiles.length &&
          manifest.files.every((file) => expectedByName.get(file.name) === file.sha256);
        if (matches) {
          const handle = await this.handleFromCustodyDir(custodyDir, input.expectedVersion);
          return { status: 'orphan_reused', handle };
        }
        await rm(custodyDir, { recursive: true, force: true }).catch(() => undefined);
      } catch {
        // A damaged custody directory is removed, never silently accepted.
        await rm(custodyDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    return { status: 'orphan_removed', handle: null };
  }
}
