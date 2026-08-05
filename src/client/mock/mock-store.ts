import { Value } from 'typebox/value';
import type { TSchema } from 'typebox';
import type { TemplateDetail } from '../../shared/contracts';
import { CORE_ERROR_CODES, CoreError } from '../gateway/core-errors';
import {
  type CatalogData,
  type DevelopmentData,
  DEFAULT_MOCK_SCENARIO,
  type MockClock,
  MOCK_STORAGE_KEYS,
  type MockTaskEntry,
  type MockTaskEvent,
  type MockTaskRecord,
  type MockRunSchedule,
  type StorageEnvelope,
  catalogDataSchema,
  createEnvelopeSchema,
  developmentDataSchema,
  taskRecordSchema,
  tasksDataSchema,
} from './mock-schema';

const catalogEnvelopeSchema = createEnvelopeSchema(catalogDataSchema);
const tasksEnvelopeSchema = createEnvelopeSchema(tasksDataSchema);
const developmentEnvelopeSchema = createEnvelopeSchema(developmentDataSchema);

export interface MockStoreSeeds {
  templates: TemplateDetail[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parseEnvelope<T>(raw: string | null, schema: TSchema): StorageEnvelope<T> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Value.Check(schema, parsed)) return parsed as StorageEnvelope<T>;
  } catch {
    // Unreadable or schema-invalid envelope: isolated, treated as absent.
  }
  return null;
}

function readRevision(raw: string | null): number {
  if (raw === null) return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const revision = (parsed as { revision?: unknown }).revision;
      if (typeof revision === 'number' && Number.isInteger(revision)) return revision;
    }
  } catch {
    // Corrupt envelope: revision restarts from zero.
  }
  return 0;
}

/**
 * Versioned, append-only persistence over a standard Storage interface.
 * Every value is wrapped in { schemaVersion: 1, revision, updatedAt, data }
 * and validated with TypeBox before use. Corruption is isolated: a broken
 * envelope reseeds or starts empty; a broken task record is flagged corrupt
 * while sibling records remain readable.
 */
export class MockStore {
  private readonly storage: Storage;
  private readonly clock: MockClock;
  private readonly seeds: MockStoreSeeds;

  constructor(storage: Storage, clock: MockClock, seeds: MockStoreSeeds) {
    this.storage = storage;
    this.clock = clock;
    this.seeds = seeds;
  }

  /* ------------------------------ catalog ------------------------------ */

  ensureCatalog(): CatalogData {
    const existing = parseEnvelope<CatalogData>(
      this.storage.getItem(MOCK_STORAGE_KEYS.catalog),
      catalogEnvelopeSchema,
    );
    if (existing) return clone(existing.data);
    const data = this.buildSeedCatalog();
    this.writeEnvelope(MOCK_STORAGE_KEYS.catalog, data);
    return clone(data);
  }

  getTemplateDetail(templateId: string): TemplateDetail | null {
    const catalog = this.ensureCatalog();
    const entry = catalog.templates[templateId];
    return entry ? clone(entry.template) : null;
  }

  reloadTemplate(templateId: string): TemplateDetail | null {
    const seed = this.seeds.templates.find((template) => template.id === templateId);
    if (!seed) return null;
    const catalog = this.ensureCatalog();
    const next: CatalogData = {
      templates: {
        ...catalog.templates,
        [templateId]: { template: clone(seed), updatedAt: this.timestamp() },
      },
      diagnostics: { ...catalog.diagnostics },
    };
    this.writeEnvelope(MOCK_STORAGE_KEYS.catalog, next);
    return clone(seed);
  }

  private buildSeedCatalog(): CatalogData {
    const updatedAt = this.timestamp();
    const templates: CatalogData['templates'] = {};
    for (const template of this.seeds.templates) {
      templates[template.id] = { template: clone(template), updatedAt };
    }
    return { templates, diagnostics: {} };
  }

  /* ------------------------------- tasks ------------------------------- */

  listTaskEntries(): MockTaskEntry[] {
    const envelope = this.readTasksEnvelope();
    return Object.entries(envelope.data).map(([id, raw]) => {
      if (Value.Check(taskRecordSchema, raw)) {
        return { id, record: clone(raw as MockTaskRecord), corrupt: false };
      }
      return { id, corrupt: true, updatedAt: envelope.updatedAt };
    });
  }

  getTaskEntry(taskId: string): MockTaskEntry | null {
    return this.listTaskEntries().find((entry) => entry.id === taskId) ?? null;
  }

  createTaskRecord(record: MockTaskRecord): void {
    if (!Value.Check(taskRecordSchema, record)) {
      throw new Error('internal: task record failed schema validation before write');
    }
    const envelope = this.readTasksEnvelope();
    this.writeEnvelope(MOCK_STORAGE_KEYS.tasks, {
      ...envelope.data,
      [record.id]: clone(record),
    });
  }

  /** Read -> validate -> copy -> append -> write. History is never rewritten. */
  appendTaskEvent(taskId: string, event: MockTaskEvent): void {
    const envelope = this.readTasksEnvelope();
    const raw = envelope.data[taskId];
    if (raw === undefined) {
      throw new CoreError(
        CORE_ERROR_CODES.TASK_NOT_FOUND,
        `未找到任务 ${taskId}。`,
        'MockStore.appendTaskEvent',
        '返回任务列表刷新后重试。',
      );
    }
    if (!Value.Check(taskRecordSchema, raw)) {
      throw new CoreError(
        CORE_ERROR_CODES.TASK_CORRUPTED,
        `任务 ${taskId} 的本地模拟数据未通过校验，已被隔离。`,
        'MockStore.appendTaskEvent',
        '在开发进度页重置模拟数据后重试。',
      );
    }
    const record = raw as MockTaskRecord;
    const updated: MockTaskRecord = {
      ...clone(record),
      events: [...record.events, clone(event)],
      updatedAt: event.at,
    };
    this.writeEnvelope(MOCK_STORAGE_KEYS.tasks, { ...envelope.data, [taskId]: updated });
  }

  /**
   * Permanently removes one task record from the tasks envelope — healthy
   * and corrupt records alike (the check is presence, never validity).
   * Throws like appendTaskEvent for missing ids. The envelope revision
   * advances, so the deletion is observable like any other write.
   */
  deleteTaskRecord(taskId: string): void {
    const envelope = this.readTasksEnvelope();
    if (envelope.data[taskId] === undefined) {
      throw new CoreError(
        CORE_ERROR_CODES.TASK_NOT_FOUND,
        `未找到任务 ${taskId}。`,
        'MockStore.deleteTaskRecord',
        '返回任务列表刷新后重试。',
      );
    }
    const data = { ...envelope.data };
    delete data[taskId];
    this.writeEnvelope(MOCK_STORAGE_KEYS.tasks, data);
  }

  /**
   * Persist simulator scheduling bookkeeping (scenario, next step, due time,
   * run generation) without touching the append-only event history. `null`
   * clears the schedule. Throws like appendTaskEvent for missing/corrupt ids.
   */
  setTaskRun(taskId: string, run: MockRunSchedule | null): void {
    const envelope = this.readTasksEnvelope();
    const raw = envelope.data[taskId];
    if (raw === undefined) {
      throw new CoreError(
        CORE_ERROR_CODES.TASK_NOT_FOUND,
        `未找到任务 ${taskId}。`,
        'MockStore.setTaskRun',
        '返回任务列表刷新后重试。',
      );
    }
    if (!Value.Check(taskRecordSchema, raw)) {
      throw new CoreError(
        CORE_ERROR_CODES.TASK_CORRUPTED,
        `任务 ${taskId} 的本地模拟数据未通过校验，已被隔离。`,
        'MockStore.setTaskRun',
        '在开发进度页重置模拟数据后重试。',
      );
    }
    const record = raw as MockTaskRecord;
    const updated: MockTaskRecord = {
      ...clone(record),
      run: run === null ? null : clone(run),
      updatedAt: this.timestamp(),
    };
    this.writeEnvelope(MOCK_STORAGE_KEYS.tasks, { ...envelope.data, [taskId]: updated });
  }

  private readTasksEnvelope(): StorageEnvelope<Record<string, unknown>> {
    const existing = parseEnvelope<Record<string, unknown>>(
      this.storage.getItem(MOCK_STORAGE_KEYS.tasks),
      tasksEnvelopeSchema,
    );
    if (existing) return existing;
    return { schemaVersion: 1, revision: 0, updatedAt: this.timestamp(), data: {} };
  }

  /* ---------------------------- development ---------------------------- */

  loadDevelopment(): DevelopmentData {
    const existing = parseEnvelope<DevelopmentData>(
      this.storage.getItem(MOCK_STORAGE_KEYS.development),
      developmentEnvelopeSchema,
    );
    if (existing) return { ...existing.data };
    return { nextScenario: DEFAULT_MOCK_SCENARIO };
  }

  /**
   * The persisted development settings, or null when the development console
   * has never saved a choice. Lets callers distinguish an explicit selection
   * from the unset default without changing loadDevelopment's contract.
   */
  peekDevelopment(): DevelopmentData | null {
    const existing = parseEnvelope<DevelopmentData>(
      this.storage.getItem(MOCK_STORAGE_KEYS.development),
      developmentEnvelopeSchema,
    );
    return existing ? { ...existing.data } : null;
  }

  saveDevelopment(data: DevelopmentData): void {
    this.writeEnvelope(MOCK_STORAGE_KEYS.development, { nextScenario: data.nextScenario });
  }

  /* ------------------------------- reset ------------------------------- */

  /** Remove only keys inside the mock namespace; everything else is kept. */
  resetMockKeys(): void {
    for (const key of Object.values(MOCK_STORAGE_KEYS)) {
      this.storage.removeItem(key);
    }
  }

  /* ----------------------------- internals ----------------------------- */

  private writeEnvelope(key: string, data: unknown): void {
    const revision = readRevision(this.storage.getItem(key));
    const envelope: StorageEnvelope<unknown> = {
      schemaVersion: 1,
      revision: revision + 1,
      updatedAt: this.timestamp(),
      data,
    };
    this.storage.setItem(key, JSON.stringify(envelope));
  }

  private timestamp(): string {
    return new Date(this.clock.now()).toISOString();
  }
}
