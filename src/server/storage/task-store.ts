/**
 * Frozen task creation and snapshot store (plan Phase B Task 3 Step 5).
 *
 * `tasks/<task-id>/` (spec §8.1) is published as one whole directory: an
 * immutable `task.json` (identity + frozen input + full template version
 * hash), the exact template cache hash directory copied to `snapshot/`
 * through a temporary sibling and reopened through `loadTemplateDirectory`
 * for fail-loud revalidation, plus empty `events/`, `artifacts/` and
 * `structured-slots/` directories (spec §7.1). The staging directory is
 * renamed into place only when every step succeeded; any failure isolates the
 * incomplete directory under a dot-prefixed name so it can never be listed as
 * usable (spec §8.3), and the error stays public — no raw causes, no absolute
 * paths (iron rule 6).
 *
 * Request validation mirrors the frozen Phase A Gateway contract: exactly the
 * template-declared input fields, required values present and non-empty.
 * Business content exists only in fixtures and request values, never here
 * (iron rule 1).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { InputField, TaskSummary } from '../../shared/contracts';
import {
  structuredProtocolOf,
  type BlobRefV2,
  type StructuredProtocol,
} from '../../shared/authoritative-review-v2';
import type { CorePaths } from './core-paths';
import { CorePathError } from './core-paths';
import { STORAGE_ERROR_CODES, StorageError, writeNewAtomic, writeNewAtomicDurable, syncDirectory } from './atomic-file';
import { loadTemplateDirectory } from '../template/template-loader';
import { TEMPLATE_ERROR_CODES, TemplateError, type FrozenTemplate } from '../template/template-schema';
import type { StructuredRuntimeEnvironmentV1 } from '../structured-slots/runtime-capability';
import type { AuthoritativeReviewRuntimeEnvironmentV1 } from '../structured-slots/authoritative-review-capability';
import type { TemplateCatalog } from '../template/template-catalog';
import { AuthoritativeReviewProfileArchive, type ProfileArchiveByteStore } from '../structured-slots/authoritative-review-profile-archive';
import { canonicalJson, canonicalJsonSha256 } from '../structured-slots/canonical-json';
import { refOfBlob } from '../authoritative-review/object-registry';
import type { AuthoritativeTaskIndexV1 } from './authoritative-task-index';
import { TaskIndexError } from './authoritative-task-index';
import type { AuthoritativeReviewProfileBindingV1 } from '../structured-slots/authoritative-review-profile';
import type { AuthoritativeReviewProfileSnapshotV1Body } from '../structured-slots/authoritative-review-profile';

export interface CreateTaskRequest {
  templateId: string;
  name: string;
  input: Record<string, string>;
}

/** Immutable contents of `task.json`, written once at creation. */
export interface TaskRecord {
  id: string;
  name: string;
  templateId: string;
  templateName: string;
  /** Full template cache version hash frozen into this task. */
  templateVersion: string;
  frozenInput: Record<string, string>;
  createdAt: string;
}

/** Task summary enriched with the frozen version hash (plan Task 3 Step 1). */
export interface CreatedTask extends TaskSummary {
  templateVersion: string;
}

const FULL_VERSION_HASH = /^[0-9a-f]{64}$/;

const INCOMPLETE_PREFIX = '.incomplete-';

/** The 64-hex SHA-256 naming rule of v2 blob digests (listing filter). */
const BLOB_DIGEST = /^[0-9a-f]{64}$/;

function invalidInput(message: string, action: string): StorageError {
  return new StorageError(STORAGE_ERROR_CODES.INVALID_INPUT, message, null, action);
}

function validateName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw invalidInput('任务名称不能为空。', '填写任务名称后重新提交。');
  }
  return name;
}

/** Exactly the declared fields: undeclared, non-string or missing required fail. */
function validateInput(
  inputFields: InputField[],
  input: unknown,
): Record<string, string> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalidInput('任务输入必须是字符串字段表。', '按模板声明的输入字段重新填写。');
  }
  const declared = new Set(inputFields.map((field) => field.id));
  const entries = Object.entries(input as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (!declared.has(key)) {
      throw invalidInput(`输入字段 ${key} 未在模板中声明。`, '移除未声明的输入字段后重新提交。');
    }
    if (typeof value !== 'string') {
      throw invalidInput(`输入字段 ${key} 的值必须是字符串。`, '按模板声明的输入字段重新填写。');
    }
  }
  for (const field of inputFields) {
    if (!field.required) {
      continue;
    }
    const value = (input as Record<string, unknown>)[field.id];
    if (typeof value !== 'string' || value.length === 0) {
      throw invalidInput(`缺少必填输入字段 ${field.id}。`, '补齐必填输入字段后重新提交。');
    }
  }
  return { ...(input as Record<string, string>) };
}

function isTaskRecord(value: unknown): value is TaskRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.templateId !== 'string' ||
    typeof record.templateName !== 'string' ||
    typeof record.templateVersion !== 'string' ||
    typeof record.createdAt !== 'string' ||
    !FULL_VERSION_HASH.test(record.templateVersion)
  ) {
    return false;
  }
  if (typeof record.frozenInput !== 'object' || record.frozenInput === null || Array.isArray(record.frozenInput)) {
    return false;
  }
  return Object.values(record.frozenInput as Record<string, unknown>).every(
    (value) => typeof value === 'string',
  );
}

/** Copies a complete directory tree, skipping dotfiles (cache manifests of residue). */
async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (entry.isDirectory()) {
      await copyTree(join(from, entry.name), join(to, entry.name));
    } else if (entry.isFile()) {
      await copyFile(join(from, entry.name), join(to, entry.name));
    }
  }
}

function toSummary(record: TaskRecord, structuredProtocol: StructuredProtocol): TaskSummary {
  return {
    id: record.id,
    name: record.name,
    templateId: record.templateId,
    templateName: record.templateName,
    status: 'ready',
    currentAgentName: null,
    latestVersion: null,
    updatedAt: record.createdAt,
    diagnostic: null,
    // The protocol comes from the task's frozen snapshot through the shared
    // helper; the record-only path fails closed to 'none' and never guesses v2.
    structuredProtocol,
  };
}

export class TaskStore {
  private readonly paths: CorePaths;

  private readonly catalog: TemplateCatalog;

  /**
   * The structured runtime environment obtained from THIS catalog (design
   * O05): the same capability/profile the Catalog and cache reopen use. The
   * store never reads or accepts a second default.
   */
  private readonly runtimeEnvironment: StructuredRuntimeEnvironmentV1;

  /**
   * The ONE authoritative review runtime environment (spec §17, Task 5),
   * obtained from the same catalog: contract-v2 snapshot reopens revalidate
   * against the identical capability/profile/registry reference. The store
   * never reads or accepts a second default.
   */
  private readonly authoritativeReviewEnvironment: AuthoritativeReviewRuntimeEnvironmentV1;

  /**
   * The installation task index (Task 11, spec §10.5): TaskStore.create is the
   * SOLE ID/root publisher and holds the index dependency so the prepared
   * entry, the complete temp root (with the task-frozen profile blob) and the
   * activation advance under the SAME installation store fence. V1/basic
   * creates never touch the index. CoreService must NOT add the index after
   * `tasks.create()` returns — it is wired here, at construction.
   */
  private readonly index: AuthoritativeTaskIndexV1 | undefined;

  /**
   * In-memory frozen-snapshot cache (plan 2026-08-06): a task snapshot is
   * immutable once frozen, so repeated reads may serve the cached object.
   * The scheduler consults it every guard iteration; without the cache each
   * read re-parses every snapshot YAML/prompt/skill and recomputes the
   * SHA-256 hash. Evicted on deleteTask.
   */
  private readonly frozenCache = new Map<string, FrozenTemplate>();

  constructor(
    paths: CorePaths,
    catalog: TemplateCatalog,
    index?: AuthoritativeTaskIndexV1,
  ) {
    this.paths = paths;
    this.catalog = catalog;
    this.runtimeEnvironment = catalog.runtimeEnvironment;
    this.authoritativeReviewEnvironment = catalog.authoritativeReviewEnvironment;
    // Wired at construction (spec §10.5: "TaskStore.create ... receives an
    // AuthoritativeTaskIndexV1 dependency"). V1/basic creates never read it.
    this.index = index;
  }

  /**
   * Creates one immutable task directory from a validated request and the
   * exact cached template version. Failed creations are isolated and never
   * exposed through listing.
   *
   * V2 creations run the spec §10.5 choreography under the installation store
   * fence: prepared index entry FIRST (outside the task root), then the
   * complete temp root whose v2 blob store carries the task-FROZEN profile
   * snapshot (constraint B — the blob store always gets the frozen profile,
   * never the current one) and the frozen-template alias, then the atomic
   * rename with parent fsync, then the prepared→active promotion before the
   * fence releases. A crash after ANY phase is repaired by
   * `runCreationRecovery` at startup.
   */
  async create(request: CreateTaskRequest): Promise<CreatedTask> {
    const frozen = this.catalog.getFrozen(request.templateId);
    if (frozen === undefined) {
      // A known-but-unavailable structured template must surface the runtime
      // gate, never masquerade as a missing template (design O05).
      const diagnostic = this.catalog.getDiagnostic(request.templateId);
      if (diagnostic?.code === TEMPLATE_ERROR_CODES.TEMPLATE_RUNTIME_UNAVAILABLE) {
        throw new TemplateError(
          TEMPLATE_ERROR_CODES.TEMPLATE_RUNTIME_UNAVAILABLE,
          `结构化运行时能力未就绪，无法为模板 ${request.templateId} 创建任务。`,
          null,
          '等待结构化运行时就绪后重新创建。',
        );
      }
      throw new TemplateError(
        TEMPLATE_ERROR_CODES.TEMPLATE_NOT_FOUND,
        `未找到模板 ${request.templateId}。`,
        null,
        '返回模板列表重新加载。',
      );
    }
    const name = validateName(request.name);
    const frozenInput = validateInput(frozen.inputFields, request.input);
    const taskId = randomUUID();
    const createdAt = new Date().toISOString();
    const record: TaskRecord = {
      id: taskId,
      name,
      templateId: frozen.id,
      templateName: frozen.name,
      templateVersion: frozen.versionHash,
      frozenInput,
      createdAt,
    };
    const isV2 = frozen.authoritativeReviewProfile !== null;
    if (!isV2) {
      // V1/basic creates keep the legacy path byte-for-byte.
      await this.publishTaskDirectory(taskId, record, frozen, []);
      return { ...toSummary(record, structuredProtocolOf(frozen)), templateVersion: record.templateVersion };
    }
    return this.createV2(taskId, record, frozen);
  }

  /**
   * The fenced v2 create (spec §10.5 steps 1–5; constraint B profile
   * choreography). The task-frozen profile bytes land INSIDE the temp root
   * BEFORE the rename, so a complete root always resolves its own archived
   * profile — create-before-start followed by any number of GC generations
   * keeps both root refs alive (they are index rows from the moment the
   * prepared entry is durable).
   */
  private async createV2(
    taskId: string,
    record: TaskRecord,
    frozen: FrozenTemplate,
  ): Promise<CreatedTask> {
    const profile = this.frozenProfileSnapshot(frozen);
    const alias = this.frozenTemplateAlias(frozen, profile);
    if (this.index === undefined) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_INPUT,
        'contract v2 任务创建需要安装任务索引。',
        null,
        '联系平台检查服务装配。',
      );
    }
    await this.index.withFence(async () => {
      await this.index?.prepareTaskUnderFence({
        taskId,
        templateSnapshotHash: record.templateVersion,
        profileSnapshotRef: profile.ref,
        templateSnapshotRef: alias.ref,
      });
      await this.publishTaskDirectory(taskId, record, frozen, [
        { kind: 'profile_snapshot', ref: profile.ref, bytes: profile.bytes },
        { kind: 'content_value', ref: alias.ref, bytes: alias.bytes },
      ]);
      await this.index?.activateTaskUnderFence(taskId);
    });
    return { ...toSummary(record, structuredProtocolOf(frozen)), templateVersion: record.templateVersion };
  }

  /**
   * The EXACT task-frozen profile snapshot (constraint B): canonical bytes +
   * complete-object ref computed through the environment archive (single
   * derivation). The ref must equal the binding frozen into the snapshot's
   * version hash — the current deployment profile is never substituted and a
   * mismatch fails closed (the template cache would be torn mid-reload).
   */
  private frozenProfileSnapshot(frozen: FrozenTemplate): { ref: BlobRefV2; bytes: Buffer } {
    const binding = frozen.authoritativeReviewProfile;
    if (binding === null) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_INPUT,
        '该任务模板没有冻结的 authoritative profile。',
        null,
        '重新加载模板后创建任务。',
      );
    }
    const environment = this.authoritativeReviewEnvironment;
    const profile = environment.profile;
    const archive = environment.archive;
    if (profile === null) {
      throw new TemplateError(
        TEMPLATE_ERROR_CODES.TEMPLATE_RUNTIME_UNAVAILABLE,
        'authoritative review 能力未就绪，无法创建 contract v2 任务。',
        null,
        '等待 authoritative review 能力就绪后重新创建。',
      );
    }
    const ref = archive.refOf(profile);
    if (ref.digest !== binding.profileSnapshotRef.digest || ref.byteLength !== binding.profileSnapshotRef.byteLength) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_INPUT,
        '当前部署 profile 与冻结的任务 profile 不一致，无法创建任务。',
        null,
        '刷新模板列表后重新创建。',
      );
    }
    return { ref, bytes: Buffer.from(archive.canonicalBytesOf(profile)) };
  }

  /**
   * The frozen-template ALIAS blob (a registered `content_value` whose text
   * canonicalizes the snapshot identity): the index row references it as a
   * formal GC root, so the frozen snapshot stays reachable through deletion's
   * detached-quarantine retention without ever resolving a directory. The
   * alias is deterministic — identical template + profile produce identical
   * bytes (idempotent same-address writes).
   */
  private frozenTemplateAlias(
    frozen: FrozenTemplate,
    profile: { ref: BlobRefV2 },
  ): { ref: BlobRefV2; bytes: Buffer } {
    const binding = frozen.authoritativeReviewProfile;
    if (binding === null) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_INPUT,
        '该任务模板没有冻结的 authoritative profile。',
        null,
        '重新加载模板后创建任务。',
      );
    }
    const text = canonicalJson({
      protocolVersion: 2,
      kind: 'authoritative_frozen_template_alias',
      snapshotHash: frozen.versionHash,
      profileIdentity: binding.profileIdentity,
      profileDigest: binding.profileDigest,
      profileSnapshotRef: profile.ref,
    });
    const without = {
      slotId: 'snapshot-alias',
      contentSchemaDigest: '0'.repeat(64),
      taskContentRevision: 1,
      mediaType: 'text/plain',
      text,
    };
    const value = { ...without, selfDigest: canonicalJsonSha256(without) };
    const ref = refOfBlob('content_value', value);
    const bytes = Buffer.from(canonicalJson(value), 'utf8');
    return { ref, bytes };
  }

  /**
   * Reads and revalidates the frozen template snapshot of one task. Snapshots
   * load in historical mode (spec §7.3): a legacy snapshot without a
   * supported turn contract stays readable (contract folds to null and the
   * scheduler gates the task), never corrupt.
   *
   * Contract-v2 snapshots reopen against the task-FROZEN archived profile
   * (spec §4.3 / constraint B): the current deployment profile (B or disabled)
   * is NEVER substituted — the snapshot's own `profile_snapshot` blob under
   * `structured-slots/v2/blobs/` is the authority, so reads stay available
   * across profile changes and the version hash still verifies against the
   * immutable task record.
   */
  async readFrozenTemplate(taskId: string): Promise<FrozenTemplate> {
    // Cache check BEFORE readTaskRecord: a deleted task must observe the
    // eviction and surface TASK_NOT_FOUND, never a stale snapshot.
    const cached = this.frozenCache.get(taskId);
    if (cached !== undefined) {
      return cached;
    }
    const record = await this.readTaskRecord(taskId);
    const snapshotRoot = this.paths.taskSnapshotRoot(taskId);
    let frozen: FrozenTemplate;
    try {
      frozen = await loadTemplateDirectory(snapshotRoot, {
        historicalSnapshot: true,
        runtimeEnvironment: this.runtimeEnvironment,
        authoritativeReviewEnvironment: this.authoritativeReviewEnvironment,
        // Task 11 constraint-B: v2 snapshots carry their own archived profile;
        // a task without one (v1/basic) resolves to null and takes the old path.
        frozenAuthoritativeProfile: (await this.archivedFrozenProfile(taskId)) ?? undefined,
      });
    } catch (error) {
      // A structured snapshot whose host runtime is unavailable must surface
      // the SAME `TEMPLATE_RUNTIME_UNAVAILABLE` the Loader/Catalog use — never
      // masquerade as corruption (design O05). Only genuine snapshot damage is
      // TASK_CORRUPTED.
      if (error instanceof TemplateError && error.code === TEMPLATE_ERROR_CODES.TEMPLATE_RUNTIME_UNAVAILABLE) {
        throw error;
      }
      throw new StorageError(
        STORAGE_ERROR_CODES.TASK_CORRUPTED,
        '任务快照缺失或不可用。',
        null,
        '检查该任务的本地快照目录。',
      );
    }
    if (frozen.versionHash !== record.templateVersion) {
      throw new StorageError(
        STORAGE_ERROR_CODES.TASK_CORRUPTED,
        '任务快照版本与任务记录不一致。',
        null,
        '检查该任务的本地快照目录。',
      );
    }
    // Identity comes from the immutable task record; the loader only knows
    // the snapshot directory name.
    const resolved: FrozenTemplate = { ...frozen, id: record.templateId, sourcePath: snapshotRoot };
    this.frozenCache.set(taskId, resolved);
    return resolved;
  }

  /** Reads the immutable `task.json`, mapping damage to public codes. */
  async readTaskRecord(taskId: string): Promise<TaskRecord> {
    let raw: string;
    try {
      raw = await readFile(this.paths.taskFile(taskId), 'utf8');
    } catch (error) {
      if (error instanceof CorePathError) {
        throw error; // Unsafe identifiers fail loud, never as "not found".
      }
      throw new StorageError(
        STORAGE_ERROR_CODES.TASK_NOT_FOUND,
        `未找到任务 ${taskId}。`,
        null,
        '返回任务列表。',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StorageError(
        STORAGE_ERROR_CODES.TASK_CORRUPTED,
        '任务记录不是有效 JSON。',
        null,
        '检查该任务的本地任务目录。',
      );
    }
    if (!isTaskRecord(parsed) || parsed.id !== taskId) {
      throw new StorageError(
        STORAGE_ERROR_CODES.TASK_CORRUPTED,
        '任务记录缺失或与任务目录不一致。',
        null,
        '检查该任务的本地任务目录。',
      );
    }
    return parsed;
  }

  /**
   * Constraint-B: resolves the task-FROZEN archived profile binding of a v2
   * snapshot from the task's OWN v2 blob store (`blobs/profile_snapshot/`,
   * written at create under the fence — the current deployment profile is
   * never consulted). Exactly one canonical body must exist: zero candidates
   * means a v1/basic task (null — the loader takes the legacy reopen path),
   * more than one means a tampered root (fail closed). The body is
   * re-validated through the registered profile_snapshot parser and its
   * complete-object ref + profileDigest alias form the binding.
   */
  private async archivedFrozenProfile(
    taskId: string,
  ): Promise<{ binding: AuthoritativeReviewProfileBindingV1; profile: AuthoritativeReviewProfileSnapshotV1Body } | null> {
    const profileKindsRoot = join(this.paths.taskStructuredV2BlobsRoot(taskId), 'profile_snapshot');
    let prefixes: string[];
    try {
      prefixes = readdirSync(profileKindsRoot);
    } catch {
      return null; // No v2 blobs at all: v1/basic task.
    }
    const digests: string[] = [];
    for (const prefix of prefixes) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) {
        throw corruptedTask('profile_snapshot 目录存在非法的摘要前缀。');
      }
      let names: string[];
      try {
        names = readdirSync(join(profileKindsRoot, prefix));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!BLOB_DIGEST.test(name)) {
          throw corruptedTask('profile_snapshot 目录存在非法的摘要文件。');
        }
        digests.push(name);
      }
    }
    if (digests.length === 0) {
      return null; // A v2 root always carries its profile blob; an absent one
      // is indistinguishable from a v1/basic root here and fails as corrupt
      // snapshot later (never guessed as v2).
    }
    if (digests.length > 1) {
      throw corruptedTask('任务根目录存在多个 frozen profile 快照。');
    }
    const digest = digests[0] as string;
    const archive = new AuthoritativeReviewProfileArchive(
      new TaskProfileArchiveByteStore(this.paths, taskId),
    );
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(this.paths.taskStructuredV2BlobFile(taskId, 'profile_snapshot', digest));
    } catch {
      throw corruptedTask('frozen profile 快照缺失。');
    }
    let body: AuthoritativeReviewProfileSnapshotV1Body | null;
    try {
      body = archive.resolve({
        kind: 'profile_snapshot',
        digest,
        byteLength: bytes.byteLength,
        mediaType: 'application/json',
        schemaVersion: 1,
      });
    } catch {
      throw corruptedTask('frozen profile 快照不可解析。');
    }
    if (body === null) {
      throw corruptedTask('frozen profile 快照缺失。');
    }
    const ref = archive.refOf(body);
    return {
      binding: {
        profileIdentity: body.profileIdentity,
        profileDigest: body.profileDigest,
        profileSnapshotRef: ref,
      },
      profile: body,
    };
  }

  /**
   * Permanently removes one task directory — frozen record, template
   * snapshot, committed events, artifacts, traces and workspaces alike.
   * Healthy and corrupt tasks are removable exactly the same way (the
   * existence check is the directory, never the record); unknown ids reject
   * with TASK_NOT_FOUND and unsafe identifiers fail loud through CorePaths.
   * Deletion is irreversible; callers own any confirmation step.
   */
  async deleteTask(taskId: string): Promise<void> {
    const root = this.paths.taskRoot(taskId);
    let dirStat: Awaited<ReturnType<typeof stat>>;
    try {
      dirStat = await stat(root);
    } catch {
      throw new StorageError(
        STORAGE_ERROR_CODES.TASK_NOT_FOUND,
        `未找到任务 ${taskId}。`,
        null,
        '返回任务列表。',
      );
    }
    if (!dirStat.isDirectory()) {
      throw new StorageError(
        STORAGE_ERROR_CODES.TASK_NOT_FOUND,
        `未找到任务 ${taskId}。`,
        null,
        '返回任务列表。',
      );
    }
    try {
      await rm(root, { recursive: true, force: false });
    } catch {
      throw new StorageError(
        STORAGE_ERROR_CODES.TASK_CORRUPTED,
        '任务目录删除失败。',
        null,
        '检查该任务的本地任务目录后重试。',
      );
    }
    this.frozenCache.delete(taskId);
  }

  /**
   * Task directory names eligible for listing: directories only, skipping
   * `.tmp-*` staging and `.incomplete-*` quarantined residue. Single source
   * of truth for the skip policy shared by `listTasks` and the CoreService
   * projection (plan Task 4).
   */
  async listTaskIds(): Promise<string[]> {    let names: string[];
    try {
      names = await readdir(this.paths.tasksRoot);
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (const name of names) {
      if (name.startsWith('.')) {
        continue;
      }
      let dirStat: Awaited<ReturnType<typeof stat>>;
      try {
        dirStat = await stat(join(this.paths.tasksRoot, name));
      } catch {
        continue;
      }
      if (dirStat.isDirectory()) {
        ids.push(name);
      }
    }
    return ids;
  }

  /**
   * Lists task directories. Healthy tasks project to their ready summary;
   * damaged ones become a `corrupt` summary with a public diagnostic instead
   * of throwing (spec §8.3). Temporary and isolated directories are skipped.
   */
  async listTasks(): Promise<TaskSummary[]> {
    const ids = await this.listTaskIds();
    const summaries: TaskSummary[] = [];
    for (const name of ids) {
      let dirStat: Awaited<ReturnType<typeof stat>>;
      try {
        dirStat = await stat(join(this.paths.tasksRoot, name));
      } catch {
        continue;
      }
      try {
        const record = await this.readTaskRecord(name);
        // The frozen snapshot is the ONLY protocol authority (spec §4.1):
        // healthy tasks derive through the shared helper; a snapshot that
        // cannot be read fails closed to 'none' — never a v2 guess.
        let protocol: StructuredProtocol = 'none';
        try {
          protocol = structuredProtocolOf(await this.readFrozenTemplate(name));
        } catch {
          // Unreadable/gated snapshot: keep the record summary, fail closed.
        }
        summaries.push(toSummary(record, protocol));
      } catch {
        summaries.push({
          id: name,
          name,
          templateId: '',
          templateName: '',
          status: 'corrupt',
          currentAgentName: null,
          latestVersion: null,
          updatedAt: dirStat.mtime.toISOString(),
          diagnostic: '任务数据损坏，需要人工检查任务目录。',
          // Corrupt record: no frozen identity is readable — fail closed.
          structuredProtocol: 'none',
        });
      }
    }
    summaries.sort((a, b) =>
      a.updatedAt !== b.updatedAt
        ? a.updatedAt < b.updatedAt
          ? -1
          : 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
    );
    return summaries;
  }

  /** Stages the full task directory, validates the snapshot, renames once. */
  private async publishTaskDirectory(
    taskId: string,
    record: TaskRecord,
    frozen: FrozenTemplate,
    v2Blobs: ReadonlyArray<{ kind: string; ref: BlobRefV2; bytes: Buffer }>,
  ): Promise<void> {
    await mkdir(this.paths.tasksRoot, { recursive: true });
    const stageDir = join(this.paths.tasksRoot, `.tmp-task-${taskId}`);
    try {
      await writeNewAtomic(
        join(stageDir, 'task.json'),
        Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'),
      );
      const snapshotRoot = join(stageDir, 'snapshot');
      const cacheVersionRoot = this.paths.templateCacheVersionRoot(frozen.id, frozen.versionHash);
      await copyTree(cacheVersionRoot, snapshotRoot);
      const reopened = await loadTemplateDirectory(snapshotRoot, {
        runtimeEnvironment: this.runtimeEnvironment,
        authoritativeReviewEnvironment: this.authoritativeReviewEnvironment,
        // V2 staged snapshots revalidate against the SAME frozen profile the
        // template bound (the create-time env IS the frozen one — the
        // byte-exact ref was verified before any write); v1/basic stay on the
        // legacy reopen path.
        frozenAuthoritativeProfile:
          v2Blobs.length > 0 && frozen.authoritativeReviewProfile !== null && this.authoritativeReviewEnvironment.profile !== null
            ? {
                binding: frozen.authoritativeReviewProfile,
                profile: this.authoritativeReviewEnvironment.profile,
              }
            : undefined,
      });
      if (reopened.versionHash !== frozen.versionHash) {
        throw new TemplateError(
          TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
          '模板快照未通过复核校验。',
          null,
          '重试重新加载模板后重新创建任务。',
        );
      }
      await mkdir(join(stageDir, 'events'), { recursive: true });
      await mkdir(join(stageDir, 'artifacts'), { recursive: true });
      // The structured-slots subtree (spec §7.1) is published empty; the blob,
      // private and custody stores populate it on demand and deleteTask removes
      // the whole task root (and therefore this subtree) with it.
      await mkdir(join(stageDir, 'structured-slots'), { recursive: true });
      // V2 choreography step 3 (spec §10.5): the task-frozen profile snapshot
      // and the frozen-template alias land INSIDE the temp root with the same
      // durable write discipline (file + parent fsync), BEFORE the rename — a
      // complete root always carries the blobs its index row references.
      if (v2Blobs.length > 0) {
        const blobsRoot = join(stageDir, 'structured-slots', 'v2', 'blobs');
        for (const blob of v2Blobs) {
          const destination = this.paths.taskStructuredV2BlobFileUnder(blobsRoot, blob.kind, blob.ref.digest);
          await writeNewAtomicDurable(destination, blob.bytes);
        }
      }
      await rename(stageDir, this.paths.taskRoot(taskId));
      // Spec §10.5 step 4: fsync the tasks parent so the rename is durable
      // before the index entry advances to active.
      await syncDirectory(this.paths.tasksRoot);
    } catch (error) {
      await this.isolate(stageDir, taskId);
      if (error instanceof TemplateError || error instanceof StorageError || error instanceof TaskIndexError) {
        throw error;
      }
      throw new TemplateError(
        TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
        '模板快照创建失败。',
        null,
        '重试重新加载模板后重新创建任务。',
      );
    }
  }

  /** Renames a failed staging directory aside; deletion is the last resort. */
  private async isolate(stageDir: string, taskId: string): Promise<void> {
    try {
      await rename(stageDir, join(this.paths.tasksRoot, `${INCOMPLETE_PREFIX}${taskId}`));
    } catch {
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Read-only archive byte store backed by ONE task's v2 blob store (constraint B). */
class TaskProfileArchiveByteStore implements ProfileArchiveByteStore {
  private readonly paths: CorePaths;

  private readonly taskId: string;

  constructor(paths: CorePaths, taskId: string) {
    this.paths = paths;
    this.taskId = taskId;
  }

  read(digest: string): Uint8Array | null {
    try {
      return readFileSync(this.paths.taskStructuredV2BlobFile(this.taskId, 'profile_snapshot', digest));
    } catch {
      return null;
    }
  }

  put(_digest: string, _bytes: Uint8Array): void {
    throw new Error('task profile archive is read-only');
  }
}

function corruptedTask(message: string): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.TASK_CORRUPTED,
    `任务数据损坏: ${message}`,
    null,
    '检查该任务的本地任务目录。',
  );
}
