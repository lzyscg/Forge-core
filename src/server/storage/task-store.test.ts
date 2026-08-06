// @vitest-environment node
/**
 * Task store tests (plan Phase B Task 3, verbatim frozen-snapshot case).
 *
 * A created task is an immutable directory `tasks/<task-id>/` containing
 * `task.json` (identity + frozen input + full template version hash),
 * `snapshot/` (the exact cached template hash directory, reopened and
 * revalidated), plus empty `events/` and `artifacts/` directories (spec §8.1).
 * Request validation mirrors the frozen Phase A Gateway contract: exactly the
 * template-declared input fields, required values present and non-empty.
 * Failed creations are isolated and never listed as usable; a corrupt
 * `task.json` is listed as `corrupt` without throwing (spec §8.3).
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  catalogWithOneTemplate,
  disposeAllTestRoots,
  validTaskRequest,
} from '../test-support';
import { loadTemplateDirectory } from '../template/template-loader';
import type { CorePaths } from './core-paths';
import { TaskStore, type CreateTaskRequest } from './task-store';

afterEach(() => {
  disposeAllTestRoots();
});

const FULL_HASH = /^[0-9a-f]{64}$/;

/** Relative file tree of a directory, slash-joined and sorted. */
function relativeTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk(root, '');
  return out;
}

async function usableTaskDirectories(paths: CorePaths): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(paths.tasksRoot);
  } catch {
    return [];
  }
  return names.filter((name) => !name.startsWith('.')).sort();
}

describe('TaskStore', () => {
  it('freezes the exact cached template and declared inputs', async () => {
    const { paths, catalog } = await catalogWithOneTemplate();
    const taskStore = new TaskStore(paths, catalog);
    const task = await taskStore.create(validTaskRequest());
    expect((await taskStore.readFrozenTemplate(task.id)).versionHash).toBe(task.templateVersion);
    await catalog.reload(task.templateId);
    expect((await taskStore.readFrozenTemplate(task.id)).versionHash).toBe(task.templateVersion);
  });

  it('keeps the snapshot frozen when a reload produces a new template version', async () => {
    const { paths, catalog } = await catalogWithOneTemplate();
    const taskStore = new TaskStore(paths, catalog);
    const task = await taskStore.create(validTaskRequest());
    const frozenBefore = task.templateVersion;

    writeFileSync(
      join(paths.templateSource(task.templateId), 'skills/style-guide/SKILL.md'),
      `${readFileSync(join(paths.templateSource(task.templateId), 'skills/style-guide/SKILL.md'), 'utf8')}\n- 新增约束。\n`,
      'utf8',
    );
    const reloaded = await catalog.reload(task.templateId);
    expect(reloaded.version).not.toBe(frozenBefore.slice(0, 12));

    // The existing task still resolves its original frozen snapshot.
    const frozen = await taskStore.readFrozenTemplate(task.id);
    expect(frozen.versionHash).toBe(frozenBefore);
    expect(frozen.id).toBe(task.templateId);
    expect(frozen.sourcePath).toBe(paths.taskSnapshotRoot(task.id));
    // A task created afterwards freezes the new version instead.
    const later = await taskStore.create(validTaskRequest());
    expect(later.templateVersion).not.toBe(frozenBefore);
    expect((await taskStore.readFrozenTemplate(later.id)).versionHash).toBe(later.templateVersion);
  });

  it('serves repeated frozen-template reads from the in-memory cache', async () => {
    const { paths, catalog } = await catalogWithOneTemplate();
    const taskStore = new TaskStore(paths, catalog);
    const task = await taskStore.create(validTaskRequest());
    const first = await taskStore.readFrozenTemplate(task.id);
    expect(first.versionHash).toBe(task.templateVersion);
    // Corrupt the on-disk snapshot: the cache must serve the second read
    // instead of re-parsing (plan 2026-08-06, snapshots are immutable).
    writeFileSync(join(paths.taskSnapshotRoot(task.id), 'template.yaml'), '{broken', 'utf8');
    const second = await taskStore.readFrozenTemplate(task.id);
    expect(second.versionHash).toBe(task.templateVersion);
  });

  it('evicts the cached frozen template on deleteTask', async () => {
    const { paths, catalog } = await catalogWithOneTemplate();
    const taskStore = new TaskStore(paths, catalog);
    const task = await taskStore.create(validTaskRequest());
    await taskStore.readFrozenTemplate(task.id);
    await taskStore.deleteTask(task.id);
    await expect(taskStore.readFrozenTemplate(task.id)).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });

  it('writes the immutable task directory layout with empty events and artifacts', async () => {
    const { paths, catalog } = await catalogWithOneTemplate();
    const taskStore = new TaskStore(paths, catalog);
    const request = validTaskRequest();
    const task = await taskStore.create(request);
    const taskDir = paths.taskRoot(task.id);

    const record = JSON.parse(readFileSync(paths.taskFile(task.id), 'utf8'));
    expect(record).toEqual({
      id: task.id,
      name: request.name,
      templateId: 'test-template',
      templateName: '双 Agent 协作模板',
      templateVersion: task.templateVersion,
      frozenInput: request.input,
      createdAt: record.createdAt,
    });
    expect(task.templateVersion).toMatch(FULL_HASH);
    expect(Number.isNaN(new Date(record.createdAt).getTime())).toBe(false);
    expect(readdirSync(paths.taskSnapshotRoot(task.id))).toEqual(
      expect.arrayContaining(['template.yaml', 'pipeline.yaml', 'agents', 'skills', 'manifest.json']),
    );
    expect(readdirSync(paths.taskEventsRoot(task.id))).toEqual([]);
    expect(readdirSync(paths.taskArtifactsRoot(task.id))).toEqual([]);
    // No staging residue remains under the tasks root.
    expect(readdirSync(paths.tasksRoot).filter((name) => name.startsWith('.'))).toEqual([]);
    expect(taskDir).toBe(paths.taskRoot(task.id));
  });

  it('copies the exact cache hash directory into the snapshot', async () => {
    const { paths, catalog } = await catalogWithOneTemplate();
    const taskStore = new TaskStore(paths, catalog);
    const task = await taskStore.create(validTaskRequest());
    const cacheVersionRoot = paths.templateCacheVersionRoot(task.templateId, task.templateVersion);
    const snapshotRoot = paths.taskSnapshotRoot(task.id);

    expect(relativeTree(snapshotRoot)).toEqual(relativeTree(cacheVersionRoot));
    expect(readFileSync(join(snapshotRoot, 'manifest.json'), 'utf8')).toBe(
      readFileSync(join(cacheVersionRoot, 'manifest.json'), 'utf8'),
    );
    const reopened = await loadTemplateDirectory(snapshotRoot);
    expect(reopened.versionHash).toBe(task.templateVersion);
  });

  it('returns a ready summary with frozen identity fields', async () => {
    const { catalog, paths } = await catalogWithOneTemplate();
    const taskStore = new TaskStore(paths, catalog);
    const task = await taskStore.create(validTaskRequest());

    expect(task).toMatchObject({
      id: task.id,
      name: '冻结任务',
      templateId: 'test-template',
      templateName: '双 Agent 协作模板',
      status: 'ready',
      currentAgentName: null,
      latestVersion: null,
      diagnostic: null,
    });
    expect(task.updatedAt).toBe(JSON.parse(readFileSync(paths.taskFile(task.id), 'utf8')).createdAt);
  });

  it('rejects input that does not exactly match the declared fields', async () => {
    const { paths, catalog } = await catalogWithOneTemplate();
    const taskStore = new TaskStore(paths, catalog);
    const base = validTaskRequest();
    const variants: CreateTaskRequest[] = [
      { ...base, input: { 'style-note': '缺少必填字段' } },
      { ...base, input: { ...base.input, 'source-material': '' } },
      { ...base, input: { ...base.input, 'undeclared-field': 'x' } },
      { ...base, input: { ...base.input, 'style-note': 42 as unknown as string } },
      { ...base, input: null as unknown as Record<string, string> },
      { ...base, name: '   ' },
      { ...base, name: 7 as unknown as string },
    ];
    for (const variant of variants) {
      await expect(taskStore.create(variant)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    // Optional fields may be omitted entirely.
    const withoutOptional = await taskStore.create({
      ...base,
      input: { 'source-material': '仅必填字段。' },
    });
    const record = JSON.parse(readFileSync(paths.taskFile(withoutOptional.id), 'utf8'));
    expect(record.frozenInput).toEqual({ 'source-material': '仅必填字段。' });
    // Every rejected request left no usable task directory behind.
    expect(await usableTaskDirectories(paths)).toEqual([withoutOptional.id]);
  });

  it('rejects unknown template ids with TEMPLATE_NOT_FOUND', async () => {
    const { paths, catalog } = await catalogWithOneTemplate();
    const taskStore = new TaskStore(paths, catalog);
    await expect(taskStore.create(validTaskRequest('template-missing'))).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
    });
    expect(await usableTaskDirectories(paths)).toEqual([]);
  });

  it('isolates the incomplete task directory when snapshot copying fails', async () => {
    const { paths, catalog } = await catalogWithOneTemplate();
    const taskStore = new TaskStore(paths, catalog);
    const templateId = 'test-template';
    const cacheHashDirs = readdirSync(join(paths.templateCacheRoot, templateId)).filter((name) =>
      /^[0-9a-f]{64}$/.test(name),
    );
    expect(cacheHashDirs.length).toBe(1);
    rmSync(join(paths.templateCacheRoot, templateId, cacheHashDirs[0]), { recursive: true, force: true });

    await expect(taskStore.create(validTaskRequest())).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
    });
    // Nothing is listed as usable; residue, if any, is dot-prefixed and ignored.
    expect(await usableTaskDirectories(paths)).toEqual([]);
    expect(await taskStore.listTasks()).toEqual([]);
  });

  it('lists healthy tasks and quarantines a corrupt task.json without throwing', async () => {
    const { paths, catalog } = await catalogWithOneTemplate();
    const taskStore = new TaskStore(paths, catalog);
    const healthy = await taskStore.create(validTaskRequest());

    mkdirSync(paths.taskRoot('broken-task'), { recursive: true });
    writeFileSync(paths.taskFile('broken-task'), '{not-json', 'utf8');
    mkdirSync(join(paths.tasksRoot, '.tmp-task-leftover'), { recursive: true });
    mkdirSync(join(paths.tasksRoot, '.incomplete-leftover'), { recursive: true });

    const listed = await taskStore.listTasks();
    expect(listed.map((item) => item.id)).toEqual([healthy.id, 'broken-task']);
    const broken = listed.find((item) => item.id === 'broken-task');
    expect(broken).toMatchObject({
      status: 'corrupt',
      templateId: '',
      templateName: '',
      currentAgentName: null,
      latestVersion: null,
    });
    expect(typeof broken?.diagnostic).toBe('string');
    const healthySummary = listed.find((item) => item.id === healthy.id);
    expect(healthySummary?.status).toBe('ready');
    expect(healthySummary?.diagnostic).toBeNull();
  });

  it('rejects readFrozenTemplate for unknown and corrupt tasks', async () => {
    const { paths, catalog } = await catalogWithOneTemplate();
    const taskStore = new TaskStore(paths, catalog);
    await expect(taskStore.readFrozenTemplate('no-such-task')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });

    mkdirSync(paths.taskRoot('broken-task'), { recursive: true });
    writeFileSync(paths.taskFile('broken-task'), '{not-json', 'utf8');
    await expect(taskStore.readFrozenTemplate('broken-task')).rejects.toMatchObject({
      code: 'TASK_CORRUPTED',
    });

    const task = await taskStore.create(validTaskRequest());
    rmSync(paths.taskSnapshotRoot(task.id), { recursive: true, force: true });
    await expect(taskStore.readFrozenTemplate(task.id)).rejects.toMatchObject({
      code: 'TASK_CORRUPTED',
    });
  });

  it('refuses task ids that could escape the tasks root', async () => {
    const { paths, catalog } = await catalogWithOneTemplate();
    const taskStore = new TaskStore(paths, catalog);
    await expect(taskStore.readFrozenTemplate('../escape')).rejects.toMatchObject({
      code: 'CORE_PATH_INVALID',
    });
  });
});

describe('TaskStore.deleteTask', () => {
  it('removes the whole task directory and every read misses afterwards', async () => {
    const { paths, catalog } = await catalogWithOneTemplate();
    const taskStore = new TaskStore(paths, catalog);
    const task = await taskStore.create(validTaskRequest());
    const root = paths.taskRoot(task.id);
    expect(readdirSync(root).length).toBeGreaterThan(0);

    await taskStore.deleteTask(task.id);

    expect(() => readdirSync(root)).toThrow();
    await expect(taskStore.readTaskRecord(task.id)).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    await expect(taskStore.readFrozenTemplate(task.id)).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    expect((await taskStore.listTasks()).map((item) => item.id)).not.toContain(task.id);
    expect(await usableTaskDirectories(paths)).toEqual([]);
  });

  it('removes a corrupt task directory exactly like a healthy one', async () => {
    const { paths, catalog } = await catalogWithOneTemplate();
    const taskStore = new TaskStore(paths, catalog);
    mkdirSync(paths.taskRoot('broken-task'), { recursive: true });
    writeFileSync(paths.taskFile('broken-task'), '{not-json', 'utf8');
    expect((await taskStore.listTasks()).some((item) => item.status === 'corrupt')).toBe(true);

    await taskStore.deleteTask('broken-task');

    expect(() => readdirSync(paths.taskRoot('broken-task'))).toThrow();
    expect(await taskStore.listTasks()).toEqual([]);
  });

  it('rejects unknown task ids with TASK_NOT_FOUND', async () => {
    const { paths, catalog } = await catalogWithOneTemplate();
    const taskStore = new TaskStore(paths, catalog);
    await expect(taskStore.deleteTask('no-such-task')).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });

  it('refuses task ids that could escape the tasks root', async () => {
    const { paths, catalog } = await catalogWithOneTemplate();
    const taskStore = new TaskStore(paths, catalog);
    await expect(taskStore.deleteTask('../escape')).rejects.toMatchObject({
      code: 'CORE_PATH_INVALID',
    });
  });
});
