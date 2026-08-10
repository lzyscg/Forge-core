/**
 * Frozen task creation and snapshot store (plan Phase B Task 3 Step 5).
 *
 * `tasks/<task-id>/` (spec §8.1) is published as one whole directory: an
 * immutable `task.json` (identity + frozen input + full template version
 * hash), the exact template cache hash directory copied to `snapshot/`
 * through a temporary sibling and reopened through `loadTemplateDirectory`
 * for fail-loud revalidation, plus empty `events/` and `artifacts/`
 * directories. The staging directory is renamed into place only when every
 * step succeeded; any failure isolates the incomplete directory under a
 * dot-prefixed name so it can never be listed as usable (spec §8.3), and the
 * error stays public — no raw causes, no absolute paths (iron rule 6).
 *
 * Request validation mirrors the frozen Phase A Gateway contract: exactly the
 * template-declared input fields, required values present and non-empty.
 * Business content exists only in fixtures and request values, never here
 * (iron rule 1).
 */
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { InputField, TaskSummary } from '../../shared/contracts';
import type { CorePaths } from './core-paths';
import { CorePathError } from './core-paths';
import { STORAGE_ERROR_CODES, StorageError, writeNewAtomic } from './atomic-file';
import { loadTemplateDirectory } from '../template/template-loader';
import { TEMPLATE_ERROR_CODES, TemplateError, type FrozenTemplate } from '../template/template-schema';
import type { StructuredRuntimeEnvironmentV1 } from '../structured-slots/runtime-capability';
import type { TemplateCatalog } from '../template/template-catalog';

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

function toSummary(record: TaskRecord): TaskSummary {
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
   * In-memory frozen-snapshot cache (plan 2026-08-06): a task snapshot is
   * immutable once frozen, so repeated reads may serve the cached object.
   * The scheduler consults it every guard iteration; without the cache each
   * read re-parses every snapshot YAML/prompt/skill and recomputes the
   * SHA-256 hash. Evicted on deleteTask.
   */
  private readonly frozenCache = new Map<string, FrozenTemplate>();

  constructor(paths: CorePaths, catalog: TemplateCatalog) {
    this.paths = paths;
    this.catalog = catalog;
    this.runtimeEnvironment = catalog.runtimeEnvironment;
  }

  /**
   * Creates one immutable task directory from a validated request and the
   * exact cached template version. Failed creations are isolated and never
   * exposed through listing.
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
    await this.publishTaskDirectory(taskId, record, frozen);
    return { ...toSummary(record), templateVersion: record.templateVersion };
  }

  /**
   * Reads and revalidates the frozen template snapshot of one task. Snapshots
   * load in historical mode (spec §7.3): a legacy snapshot without a
   * supported turn contract stays readable (contract folds to null and the
   * scheduler gates the task), never corrupt.
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
      });
    } catch {
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
        summaries.push(toSummary(await this.readTaskRecord(name)));
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
      await rename(stageDir, this.paths.taskRoot(taskId));
    } catch (error) {
      await this.isolate(stageDir, taskId);
      if (error instanceof TemplateError || error instanceof StorageError) {
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
