import { beforeEach, describe, expect, it } from 'vitest';
import type { TemplateDetail } from '../../shared/contracts';
import { templateFixture } from './__fixtures__/zhihu-single-chapter';
import { MOCK_STORAGE_KEYS, type MockTaskEvent, type MockTaskRecord } from './mock-schema';
import { MockStore } from './mock-store';
import { MemoryStorage, createFixedClock } from './mock-fixtures';

const SEED_TEMPLATES: TemplateDetail[] = [templateFixture.template];
const CREATED_AT = '2026-01-01T00:00:00.000Z';

function makeRecord(overrides: Partial<MockTaskRecord> = {}): MockTaskRecord {
  return {
    id: 'task-1',
    name: 'sample task',
    templateId: templateFixture.template.id,
    templateName: templateFixture.template.name,
    frozenInput: { ...templateFixture.sampleInput },
    frozenTemplate: templateFixture.template,
    events: [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function parseEnvelope(storage: MemoryStorage, key: string): {
  schemaVersion: number;
  revision: number;
  updatedAt: string;
  data: Record<string, unknown>;
} {
  const raw = storage.getItem(key);
  expect(raw, `expected a value under ${key}`).not.toBeNull();
  return JSON.parse(raw as string);
}

describe('MockStore', () => {
  let storage: MemoryStorage;
  let clock: ReturnType<typeof createFixedClock>;
  let store: MockStore;

  beforeEach(() => {
    storage = new MemoryStorage();
    clock = createFixedClock();
    store = new MockStore(storage, clock, { templates: SEED_TEMPLATES });
  });

  it('writes envelopes with schemaVersion, revision and updatedAt under the three versioned keys', () => {
    store.ensureCatalog();
    store.createTaskRecord(makeRecord());
    store.saveDevelopment({ nextScenario: 'happy_path' });

    for (const key of Object.values(MOCK_STORAGE_KEYS)) {
      const envelope = parseEnvelope(storage, key);
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.revision).toBeGreaterThanOrEqual(1);
      expect(typeof envelope.updatedAt).toBe('string');
      expect(envelope.data).toBeTypeOf('object');
    }
    expect(storage.keys()).toEqual(expect.arrayContaining(Object.values(MOCK_STORAGE_KEYS)));
  });

  it('appendTaskEvent appends without rewriting prior events and increments revision', () => {
    store.createTaskRecord(makeRecord());
    const first: MockTaskEvent = { type: 'task_started', at: '2026-01-01T00:00:01.000Z' };
    const second: MockTaskEvent = { type: 'task_stopped', at: '2026-01-01T00:00:02.000Z' };

    store.appendTaskEvent('task-1', first);
    const before = parseEnvelope(storage, MOCK_STORAGE_KEYS.tasks);
    const beforeRecord = before.data['task-1'] as MockTaskRecord;
    expect(beforeRecord.events).toEqual([first]);

    store.appendTaskEvent('task-1', second);
    const after = parseEnvelope(storage, MOCK_STORAGE_KEYS.tasks);
    const afterRecord = after.data['task-1'] as MockTaskRecord;

    expect(after.revision).toBe(before.revision + 1);
    expect(afterRecord.events).toHaveLength(2);
    expect(afterRecord.events[0]).toEqual(first);
    expect(afterRecord.events[1]).toEqual(second);
    expect(afterRecord.updatedAt).toBe(second.at);
    expect(afterRecord.createdAt).toBe(CREATED_AT);
  });

  it('treats an unreadable tasks envelope as isolated and recreates it on the next write', () => {
    storage.setItem(MOCK_STORAGE_KEYS.tasks, '{{{ not readable json');
    expect(store.listTaskEntries()).toEqual([]);

    store.createTaskRecord(makeRecord({ id: 'task-rebuilt' }));
    const envelope = parseEnvelope(storage, MOCK_STORAGE_KEYS.tasks);
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.data['task-rebuilt']).toBeTypeOf('object');
  });

  it('flags one invalid record as corrupt and keeps sibling records readable', () => {
    store.createTaskRecord(makeRecord({ id: 'task-healthy' }));
    store.createTaskRecord(makeRecord({ id: 'task-broken' }));

    const envelope = parseEnvelope(storage, MOCK_STORAGE_KEYS.tasks);
    envelope.data['task-broken'] = { not: 'a task record' };
    storage.setItem(MOCK_STORAGE_KEYS.tasks, JSON.stringify(envelope));

    const entries = store.listTaskEntries();
    const healthy = entries.find((entry) => entry.id === 'task-healthy');
    const broken = entries.find((entry) => entry.id === 'task-broken');
    expect(healthy && 'record' in healthy && healthy.record.id).toBe('task-healthy');
    expect(broken && 'corrupt' in broken && broken.corrupt).toBe(true);
  });

  it('refuses to append events to a corrupt record', () => {
    store.createTaskRecord(makeRecord({ id: 'task-broken' }));
    const envelope = parseEnvelope(storage, MOCK_STORAGE_KEYS.tasks);
    envelope.data['task-broken'] = 'garbage';
    storage.setItem(MOCK_STORAGE_KEYS.tasks, JSON.stringify(envelope));

    try {
      store.appendTaskEvent('task-broken', { type: 'task_started', at: CREATED_AT });
    } catch (error) {
      expect((error as { code?: unknown }).code).toBe('TASK_CORRUPTED');
      return;
    }
    expect.unreachable('appendTaskEvent should throw for corrupt records');
  });

  it('refuses to append events to an unknown task', () => {
    try {
      store.appendTaskEvent('task-missing', { type: 'task_started', at: CREATED_AT });
    } catch (error) {
      expect((error as { code?: unknown }).code).toBe('TASK_NOT_FOUND');
      return;
    }
    expect.unreachable('appendTaskEvent should throw for unknown tasks');
  });

  it('resetMockKeys removes only mock-namespaced keys', () => {
    store.ensureCatalog();
    store.createTaskRecord(makeRecord());
    store.saveDevelopment({ nextScenario: 'happy_path' });
    storage.setItem('unrelated:key', 'keep me');

    store.resetMockKeys();

    for (const key of Object.values(MOCK_STORAGE_KEYS)) {
      expect(storage.getItem(key)).toBeNull();
    }
    expect(storage.getItem('unrelated:key')).toBe('keep me');
  });

  it('reseeds the catalog when the stored catalog envelope is corrupt', () => {
    store.ensureCatalog();
    storage.setItem(MOCK_STORAGE_KEYS.catalog, 'not an envelope');

    const detail = store.getTemplateDetail(templateFixture.template.id);
    expect(detail?.id).toBe(templateFixture.template.id);
    expect(parseEnvelope(storage, MOCK_STORAGE_KEYS.catalog).schemaVersion).toBe(1);
  });

  it('reloadTemplate refreshes updatedAt from the seed source and returns null for unknown ids', () => {
    const seeded = store.ensureCatalog();
    const seededAt = seeded.templates[templateFixture.template.id].updatedAt;
    clock.advance(5 * 60 * 1000);

    const reloaded = store.reloadTemplate(templateFixture.template.id);
    expect(reloaded?.id).toBe(templateFixture.template.id);
    const catalog = store.ensureCatalog();
    expect(catalog.templates[templateFixture.template.id].updatedAt).not.toBe(seededAt);

    expect(store.reloadTemplate('template-missing')).toBeNull();
  });

  it('persists development settings across store instances and falls back when corrupt', () => {
    store.saveDevelopment({ nextScenario: 'manual_retry' });
    const reopened = new MockStore(storage, clock, { templates: SEED_TEMPLATES });
    expect(reopened.loadDevelopment().nextScenario).toBe('manual_retry');

    storage.setItem(MOCK_STORAGE_KEYS.development, '{ broken');
    const recovered = new MockStore(storage, clock, { templates: SEED_TEMPLATES });
    expect(recovered.loadDevelopment().nextScenario).toBe('happy_path');
  });

  it('deleteTaskRecord removes one record and keeps every sibling untouched', () => {
    store.createTaskRecord(makeRecord({ id: 'task-keep' }));
    store.createTaskRecord(makeRecord({ id: 'task-drop' }));

    store.deleteTaskRecord('task-drop');

    expect(store.listTaskEntries().map((entry) => entry.id)).toEqual(['task-keep']);
    expect(store.getTaskEntry('task-drop')).toBeNull();
    const envelope = parseEnvelope(storage, MOCK_STORAGE_KEYS.tasks);
    expect(Object.keys(envelope.data)).toEqual(['task-keep']);
  });

  it('deleteTaskRecord removes corrupt records exactly like healthy ones', () => {
    store.createTaskRecord(makeRecord({ id: 'task-broken' }));
    const envelope = parseEnvelope(storage, MOCK_STORAGE_KEYS.tasks);
    envelope.data['task-broken'] = 'garbage';
    storage.setItem(MOCK_STORAGE_KEYS.tasks, JSON.stringify(envelope));

    store.deleteTaskRecord('task-broken');

    expect(store.listTaskEntries()).toEqual([]);
  });

  it('deleteTaskRecord refuses unknown task ids', () => {
    try {
      store.deleteTaskRecord('task-missing');
    } catch (error) {
      expect((error as { code?: unknown }).code).toBe('TASK_NOT_FOUND');
      return;
    }
    expect.unreachable('deleteTaskRecord should throw for unknown tasks');
  });
});
