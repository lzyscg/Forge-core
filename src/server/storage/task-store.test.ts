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
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  catalogWithOneTemplate,
  disposeAllTestRoots,
  makeTempCorePaths,
  validTaskRequest,
} from '../test-support';
import {
  createDisabledRuntimeEnvironment,
  createTestRuntimeEnvironment,
  isStructuredRuntimeEnabled,
} from '../structured-slots/runtime-capability';
import { loadTemplateDirectory } from '../template/template-loader';
import { TemplateCatalog } from '../template/template-catalog';
import type { CorePaths } from './core-paths';
import { TaskStore, type CreateTaskRequest } from './task-store';
import type { FrozenTemplate } from '../template/template-schema';
import type { AuthoritativeReviewProfileBindingV1 } from '../structured-slots/authoritative-review-profile';
import { resolve } from 'node:path';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';
import type { PreparedActiveTaskRowV2 } from './authoritative-task-index';

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
    // The structured-slots subtree is published empty at creation (spec §7.1)
    // and removed together with the whole task directory on deleteTask.
    expect(readdirSync(paths.taskStructuredSlotsRoot(task.id))).toEqual([]);
    await taskStore.deleteTask(task.id);
    expect(() => readdirSync(paths.taskStructuredSlotsRoot(task.id))).toThrow();
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
    // The protocol is derived from the FROZEN snapshot via the shared helper:
    // this template is basic, so the summary fails closed to 'none' — never
    // a guess from template id or catalog status (spec §4.1).
    expect(task.structuredProtocol).toBe('none');
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
    // Corrupt records carry no readable frozen identity: the protocol fails
    // closed to 'none' and never guesses v2 (spec §4.1).
    expect(broken?.structuredProtocol).toBe('none');
    const healthySummary = listed.find((item) => item.id === healthy.id);
    expect(healthySummary?.status).toBe('ready');
    expect(healthySummary?.diagnostic).toBeNull();
    expect(healthySummary?.structuredProtocol).toBe('none');
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

describe('TaskStore structured mode (Task 5, spec §5 / O05)', () => {
  const STRUCTURED_FIXTURE = fileURLToPath(
    new URL('../template/__fixtures__/structured-valid', import.meta.url),
  );

  /** A catalog over the structured-valid fixture under the given environment. */
  async function catalogWithStructured(
    options: { runtimeEnvironment?: ReturnType<typeof createTestRuntimeEnvironment> } = {},
  ): Promise<{ paths: CorePaths; catalog: TemplateCatalog; templateId: string }> {
    const { paths, templateRoot } = makeTempCorePaths('forge-core-structured-');
    cpSync(STRUCTURED_FIXTURE, join(templateRoot, 'structured-test'), { recursive: true });
    const catalog = new TemplateCatalog(paths, {
      runtimeEnvironment: options.runtimeEnvironment,
    });
    await catalog.initialize();
    // Sanity: an ENABLED environment must load the structured fixture as valid.
    // A DISABLED environment is expected to gate it (that is the point of the
    // disabled fixtures below), so no validity requirement applies there.
    if (
      options.runtimeEnvironment !== undefined &&
      isStructuredRuntimeEnabled(options.runtimeEnvironment)
    ) {
      const detail = catalog.get('structured-test');
      if (!detail || detail.status !== 'valid') {
        throw new Error('task-store test-support: structured fixture did not initialize as valid');
      }
    }
    return { paths, catalog, templateId: 'structured-test' };
  }

  function structuredRequest(templateId: string): CreateTaskRequest {
    return { templateId, name: 'Structured Task', input: { 'source-text': 'neutral source text' } };
  }

  it('creates a structured task with an enabled runtime and reopens the snapshot', async () => {
    const { paths, catalog, templateId } = await catalogWithStructured({
      runtimeEnvironment: createTestRuntimeEnvironment(),
    });
    const taskStore = new TaskStore(paths, catalog);
    const task = await taskStore.create(structuredRequest(templateId));
    expect(task.templateVersion).toMatch(FULL_HASH);
    const frozen = await taskStore.readFrozenTemplate(task.id);
    expect(frozen.productionMode).toBe('structured_slots');
    expect(frozen.structuredSlots).not.toBeNull();
    expect(frozen.versionHash).toBe(task.templateVersion);
    // The protocol derives from the frozen snapshot's contract version: the
    // v1 fixture yields 'v1' through the shared helper (spec §4.1).
    expect(task.structuredProtocol).toBe('v1');
    expect((await taskStore.listTasks())[0].structuredProtocol).toBe('v1');
    // The task snapshot carries the slots contract subtree.
    expect(relativeTree(paths.taskSnapshotRoot(task.id))).toContain('slots/contract.yaml');
  });

  it('reopens the structured snapshot after a catalog reload (source -> cache -> task)', async () => {
    const { paths, catalog, templateId } = await catalogWithStructured({
      runtimeEnvironment: createTestRuntimeEnvironment(),
    });
    const taskStore = new TaskStore(paths, catalog);
    const task = await taskStore.create(structuredRequest(templateId));
    await catalog.reload(templateId);
    const frozen = await taskStore.readFrozenTemplate(task.id);
    expect(frozen.productionMode).toBe('structured_slots');
    expect(frozen.versionHash).toBe(task.templateVersion);
  });

  it('maps a gated structured template to TEMPLATE_RUNTIME_UNAVAILABLE, never TEMPLATE_NOT_FOUND', async () => {
    // Explicit DISABLED fixture (Task 19): the catalog is initialized under the
    // disabled environment so the structured template is gated — phase-independent,
    // never reads the checked-in manifest.
    const { paths, catalog, templateId } = await catalogWithStructured({
      runtimeEnvironment: createDisabledRuntimeEnvironment(),
    });
    const taskStore = new TaskStore(paths, catalog);
    await expect(taskStore.create(structuredRequest(templateId))).rejects.toMatchObject({
      code: 'TEMPLATE_RUNTIME_UNAVAILABLE',
    });
    expect(await usableTaskDirectories(paths)).toEqual([]);
  });

  it('rejects a gated structured template that the catalog has never seen as TEMPLATE_NOT_FOUND', async () => {
    const { paths, catalog } = await catalogWithStructured();
    const taskStore = new TaskStore(paths, catalog);
    await expect(taskStore.create(structuredRequest('template-missing'))).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
    });
  });

  it('propagates TEMPLATE_RUNTIME_UNAVAILABLE when reopening a structured snapshot under a disabled runtime', async () => {
    // Freeze a structured task under an ENABLED fixture, then reopen the SAME
    // roots with an EXPLICIT disabled fixture (Task 19): the historical
    // snapshot's readFrozenTemplate must surface TEMPLATE_RUNTIME_UNAVAILABLE
    // (design O05), never TASK_CORRUPTED. Phase-independent — the disabled
    // reopen never reads the checked-in manifest.
    const { paths, catalog, templateId } = await catalogWithStructured({
      runtimeEnvironment: createTestRuntimeEnvironment(),
    });
    const enabledStore = new TaskStore(paths, catalog);
    const task = await enabledStore.create(structuredRequest(templateId));

    const disabledCatalog = new TemplateCatalog(paths, {
      runtimeEnvironment: createDisabledRuntimeEnvironment(),
    });
    await disabledCatalog.initialize();
    const disabledStore = new TaskStore(paths, disabledCatalog);
    await expect(disabledStore.readFrozenTemplate(task.id)).rejects.toMatchObject({
      code: 'TEMPLATE_RUNTIME_UNAVAILABLE',
    });
  });
});

/* --------------------------------------------------------------------------
 * Task 11 deliverable 6: TaskStore.create choreography (spec §10.5) +
 * constraint-B archived-profile binding.
 * ------------------------------------------------------------------------ */

import { AuthoritativeTaskIndexV1 } from './authoritative-task-index';
import { AuthoritativePublicationStore } from './authoritative-publication-store';
import { AuthoritativeReviewBlobStore } from './authoritative-review-blob-store';
import { AuthoritativeReviewGc } from './authoritative-review-gc';
import { EventStore } from './event-store';
import { AuthoritativeWakeupIndexV1 } from '../runtime/authoritative-review/wakeup-index';
import { AuthoritativeTaskDeletionV2, deletionTrashPath } from './authoritative-task-deletion';
import { canonicalJsonSha256 } from '../structured-slots/canonical-json';
import { fullProfileForTests } from '../authoritative-review/object-registry';
import {
  buildAuthoritativeReviewTestProfileBody,
  createAuthoritativeReviewTestEnvironment,
  createAuthoritativeReviewTestHandlerRegistry,
} from '../structured-slots/test-support/authoritative-review-test-registry';
import {
  AUTHORITATIVE_REVIEW_PROFILE_IDENTITY as AUTHORITATIVE_PROFILE_IDENTITY,
  validateAuthoritativeReviewProfile,
} from '../structured-slots/authoritative-review-profile';
import {
  createAuthoritativeReviewRuntimeEnvironment,
  createProductionAuthoritativeReviewEnvironment,
  deriveAuthoritativeReviewExecutionEligibility,
} from '../structured-slots/authoritative-review-capability';
/** The v2 fixture template id (contract v2 + authoritative profile binding). */
const V2_TEMPLATE_ID = 'authoritative-valid';

/** Copies the checked-in v2 fixture into a template root. */
function installAuthoritativeFixture(templateRoot: string): void {
  let source: string;
  try {
    source = fileURLToPath(new URL('../template/__fixtures__/authoritative-valid', import.meta.url));
  } catch {
    source = resolve(
      process.cwd(),
      'src',
      'server',
      'template',
      '__fixtures__',
      'authoritative-valid',
    );
  }
  cpSync(source, join(templateRoot, V2_TEMPLATE_ID), { recursive: true });
}

/** A valid v2 create request for the authoritative fixture. */
function v2Request(): CreateTaskRequest {
  return { templateId: V2_TEMPLATE_ID, name: '权威评审任务', input: { 'source-text': '用于权威评审的素材。' } };
}

/**
 * One v2 installation: fresh roots, the authoritative fixture in the catalog,
 * an enabled test environment and the REAL store fence (the same
 * mkdir-lock/fence the facade commits and GC use). Returns the TaskStore wired
 * with the index dependency exactly like CoreService will, plus the raw
 * storage surface for crash/GC/race analysis.
 */
async function v2Installation(options: {
  authoritativeReviewEnvironment?: ReturnType<typeof createAuthoritativeReviewTestEnvironment>;
  shared?: { paths: CorePaths };
} = {}) {
  const fresh = options.shared === undefined;
  const paths = fresh
    ? makeTempCorePaths('forge-core-store-v2-').paths
    : options.shared?.paths as CorePaths;
  if (fresh) {
    installAuthoritativeFixture(join(paths.templateRoot));
  }
  const templateRoot = join(paths.templateRoot);
  const env = options.authoritativeReviewEnvironment ?? createAuthoritativeReviewTestEnvironment();
  const catalog = new TemplateCatalog(paths, {
    runtimeEnvironment: createTestRuntimeEnvironment(),
    authoritativeReviewEnvironment: env,
  });
  await catalog.initialize();
  const detail = catalog.get(V2_TEMPLATE_ID);
  if (fresh && (!detail || detail.status !== 'valid')) {
    throw new Error('task-store v2 harness: the authoritative fixture did not initialize as valid');
  }
  const publicationStore = new AuthoritativePublicationStore(paths, {
    bootId: 'task-store-v2-boot',
    ownerPid: process.pid,
    processAlive: () => true,
    retrySleepMs: 0,
  });
  const withStoreFence = async <T>(fn: () => Promise<T>): Promise<T> => {
    const hold = await publicationStore.lock().acquire();
    try {
      return await fn();
    } finally {
      await hold.release();
    }
  };
  const clock = () => '2026-08-14T10:00:00.000Z';
  const index = new AuthoritativeTaskIndexV1({ paths, withStoreFence, clock });
  if (!(await index.migrationComplete())) {
    const barrier = await index.runMigrationBarrier();
    if (!(await index.migrationComplete())) throw new Error('v2 harness: migration barrier failed');
    void barrier;
  } else if (fresh) {
    // A fresh installation completes the barrier exactly once.
  }
  const taskStore = new TaskStore(paths, catalog, index);
  const eventStore = new EventStore(paths);
  const blobStore = new AuthoritativeReviewBlobStore(paths, fullProfileForTests());
  const wakeups = new AuthoritativeWakeupIndexV1({ paths });
  const deletion = new AuthoritativeTaskDeletionV2({
    paths,
    index,
    wakeups,
    withStoreFence,
    snapshotPins: () => publicationStore.snapshotPins(),
    clock,
  });
  const gc = new AuthoritativeReviewGc(paths, blobStore, eventStore, publicationStore, {
    // Task 11 constraint-D wiring: the index rows are the formal roots; the
    // index itself excludes tombstoned rows (their blobs live in trash).
    rootsProvider: () => index.gcRootsProvider(),
  });
  return { paths, catalog, env, index, taskStore, eventStore, publicationStore, blobStore, wakeups, deletion, gc };
}

describe('TaskStore v2 create choreography (spec §10.5)', { timeout: 30_000 }, () => {
  it('publishes prepared→active with the task-frozen profile blob and alias INSIDE the root', async () => {
    const { paths, index, taskStore, env } = await v2Installation();
    const task = await taskStore.create(v2Request());
    const row = await index.entryFor(task.id);
    expect(row).toMatchObject({ taskId: task.id, protocol: 'v2', state: 'active', templateSnapshotHash: task.templateVersion });
    const active = row as PreparedActiveTaskRowV2;
    const binding = env.profileSnapshotRef as BlobRefV2;
    expect(active.profileSnapshotRef).toEqual(binding);
    // The profile blob exists INSIDE the task root at the blobs address ...
    const profileFile = paths.taskStructuredV2BlobFile(task.id, 'profile_snapshot', active.profileSnapshotRef.digest);
    expect(() => readFileSync(profileFile)).not.toThrow();
    // ... and its bytes ARE the canonical frozen profile (never the current one).
    const archived = JSON.parse(readFileSync(profileFile, 'utf8')) as Record<string, unknown>;
    expect(archived.profileDigest).toBe(env.profile?.profileDigest);
    // The alias blob resolves too (a registered content_value).
    const aliasFile = paths.taskStructuredV2BlobFile(task.id, 'content_value', active.templateSnapshotRef.digest);
    expect(() => readFileSync(aliasFile)).not.toThrow();
    // The snapshot reopens byte-identically and projects v2.
    const frozen = await taskStore.readFrozenTemplate(task.id);
    expect(frozen.authoritativeReviewProfile?.profileSnapshotRef).toEqual(active.profileSnapshotRef);
    // find the alias digest on disk
    const aliasTree = relativeTree(paths.taskRoot(task.id)).filter((name) => name.startsWith('structured-slots/v2/blobs/'));
    expect(aliasTree).toContain(`structured-slots/v2/blobs/profile_snapshot/${active.profileSnapshotRef.digest.slice(0, 2)}/${active.profileSnapshotRef.digest}`);
  });

  it('crash after prepared (no final root): creation recovery cancels the entry and removes the temp root', async () => {
    const { paths, index, taskStore, catalog } = await v2Installation();
    // Phase A crash: only the prepared row landed (no root).
    const frozen = (await catalog.getFrozen(V2_TEMPLATE_ID)) as FrozenTemplate;
    const binding = frozen.authoritativeReviewProfile as AuthoritativeReviewProfileBindingV1;
    const fakeId = 'task-crash-prepared';
    if (!(await index.migrationComplete())) throw new Error('harness');
    await index.prepareTaskUnderFence({
      taskId: fakeId,
      templateSnapshotHash: frozen.versionHash,
      profileSnapshotRef: binding.profileSnapshotRef,
      templateSnapshotRef: binding.profileSnapshotRef,
    });
    expect(await index.entryFor(fakeId)).not.toBeNull();
    await index.runCreationRecovery();
    expect(await index.entryFor(fakeId)).toBeNull();
    // The temp staging root (if any) was removed; no usable directory remains.
    expect((await usableTaskDirectories(paths)).includes(fakeId)).toBe(false);
  });

  it('crash after root rename but before activate: recovery verifies the snapshot hash and activates', async () => {
    const { paths, index, taskStore } = await v2Installation();
    // Phase B/C crash: prepared row + COMPLETE root, not activated. The root
    // is rebuilt from a real create of a sibling (same template => identical
    // profile/alias bytes) so every recovery read is honest.
    const sibling = await taskStore.create(v2Request());
    const siblingRow = (await index.entryFor(sibling.id)) as PreparedActiveTaskRowV2;
    const fakeId = 'task-crash-renamed';
    if (!(await index.migrationComplete())) throw new Error('harness');
    await index.prepareTaskUnderFence({
      taskId: fakeId,
      templateSnapshotHash: sibling.templateVersion,
      profileSnapshotRef: siblingRow.profileSnapshotRef,
      templateSnapshotRef: siblingRow.templateSnapshotRef,
    });
    // Build the complete root exactly like the choreography would: copy the
    // sibling's immutable root (task.json differs only in id/name — same
    // templateVersion, same blobs).
    cpSync(paths.taskRoot(sibling.id), paths.taskRoot(fakeId), { recursive: true });
    const record = JSON.parse(readFileSync(paths.taskFile(fakeId), 'utf8')) as Record<string, unknown>;
    record.id = fakeId;
    record.name = '崩溃重命名任务';
    writeFileSync(paths.taskFile(fakeId), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    const outcome = await index.runCreationRecovery();
    expect(outcome.activated).toContain(fakeId);
    const row = await index.entryFor(fakeId);
    expect(row).toMatchObject({ taskId: fakeId, state: 'active' });
  });

  it('crash with a mismatched/unreadable root: quarantined and the prepared entry cancelled', async () => {
    const { paths, index, taskStore } = await v2Installation();
    const sibling = await taskStore.create(v2Request());
    const siblingRow = (await index.entryFor(sibling.id)) as PreparedActiveTaskRowV2;
    const fakeId = 'task-crash-mismatch';
    await index.prepareTaskUnderFence({
      taskId: fakeId,
      templateSnapshotHash: sibling.templateVersion,
      profileSnapshotRef: siblingRow.profileSnapshotRef,
      templateSnapshotRef: siblingRow.templateSnapshotRef,
    });
    cpSync(paths.taskRoot(sibling.id), paths.taskRoot(fakeId), { recursive: true });
    // Tamper the FROZEN SNAPSHOT HASH authority: the record's templateVersion
    // no longer matches the prepared row (the recovery verifies this hash).
    const tampered = JSON.parse(readFileSync(paths.taskFile(fakeId), 'utf8')) as Record<string, unknown>;
    tampered.templateVersion = 'f'.repeat(64);
    writeFileSync(paths.taskFile(fakeId), `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
    const outcome = await index.runCreationRecovery();
    expect(outcome.quarantined).toContain(fakeId);
    await expect(index.entryFor(fakeId)).resolves.toBeNull();
    // The quarantine is dot-prefixed — never listable.
    expect((await usableTaskDirectories(paths)).includes(fakeId)).toBe(false);
  });

  it('two instances share one installation: concurrent creates serialize and both activate', async () => {
    const harness = await v2Installation();
    const { paths } = harness;
    const second = await v2Installation({ shared: { paths } });
    const [a, b] = await Promise.all([
      harness.taskStore.create(v2Request()),
      second.taskStore.create(v2Request()),
    ]);
    expect(await harness.index.entryFor(a.id)).toMatchObject({ state: 'active' });
    expect(await second.index.entryFor(b.id)).toMatchObject({ state: 'active' });
    // Both roots listable and each reopens its own frozen snapshot.
    expect((await usableTaskDirectories(paths)).sort()).toEqual([a.id, b.id].sort());
  });

  it('a v2 delete + create race: the fenced create never resurrects a tombstoned id', async () => {
    const { taskStore, index, deletion } = await v2Installation();
    const created = await taskStore.create(v2Request());
    const result = await deletion.runDelete(created.id, { operationId: '11111111-1111-4111-8111-111111111111', reason: '资格复核' });
    expect(result.state).toBe('detached');
    // The tombstoned id is retired forever: a prepared write for it rejects.
    await expect(
      index.prepareTaskUnderFence({
        taskId: created.id,
        templateSnapshotHash: 'a'.repeat(64),
        profileSnapshotRef: { kind: 'profile_snapshot', digest: 'b'.repeat(64), byteLength: 1, mediaType: 'application/json', schemaVersion: 1 },
        templateSnapshotRef: { kind: 'content_value', digest: 'c'.repeat(64), byteLength: 1, mediaType: 'text/plain', schemaVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'ID_UNAVAILABLE' });
  });

  it('create-before-start survives multiple GC generations (index refs are formal roots)', async () => {
    const { paths, index, taskStore, gc, deletion } = await v2Installation();
    const created = await taskStore.create(v2Request());
    const frozen = await taskStore.readFrozenTemplate(created.id);
    // The profile/alias blob files exist before any GC round.
    const row = (await index.entryFor(created.id)) as PreparedActiveTaskRowV2;
    const profileFile = paths.taskStructuredV2BlobFile(created.id, 'profile_snapshot', row.profileSnapshotRef.digest);
    const aliasFile = paths.taskStructuredV2BlobFile(created.id, 'content_value', row.templateSnapshotRef.digest);
    expect(() => readFileSync(profileFile)).not.toThrow();
    for (let generation = 0; generation < 3; generation += 1) {
      const result = await gc.run();
      expect(result.deletedBlobs).toBe(0);
      // mark must have walked the installed roots.
      expect(result.markedRefs).toBeGreaterThanOrEqual(2);
    }
    // GC recheck with a live tombstone retains the roots through detached.
    await deletion.runDelete(created.id, { operationId: '22222222-2222-4222-8222-222222222222', reason: '清理' });
    const retained = await deletion.retainedRootsFor(created.id);
    expect(retained.map((ref) => ref.digest)).toEqual(
      expect.arrayContaining([row.profileSnapshotRef.digest, row.templateSnapshotRef.digest]),
    );
    const afterDelete = await gc.run();
    expect(afterDelete.deletedBlobs).toBe(0);
    // The detached quarantine physically moved the blobs OUT of the tasks root
    // (GC's sweep surface never walks dataRoot/trash); the row keeps the
    // identity until the purged tombstone is durable.
    expect(() => readFileSync(profileFile)).toThrow();
    const trashFile = join(deletionTrashPath(paths, created.id, 1), 'structured-slots', 'v2', 'blobs', 'profile_snapshot', row.profileSnapshotRef.digest.slice(0, 2), row.profileSnapshotRef.digest);
    expect(() => readFileSync(trashFile)).not.toThrow();
  });

  it('preexisting corrupt v1 directory keeps legacy deletion and can never be reused for v2', async () => {
    const { paths, index, taskStore } = await v2Installation();
    // A pre-marker directory whose record is corrupt (created BEFORE the
    // barrier on a fresh installation is impossible — reorder: build the dir
    // FIRST, then run the barrier on a fresh installation).
    // => separate fresh installation without the barrier.
    const fresh = makeTempCorePaths('forge-core-store-v2pre-');
    installAuthoritativeFixture(fresh.templateRoot);
    const prePaths = fresh.paths;
    const legacyId = 'legacy-corrupt-v1';
    mkdirSync(join(prePaths.taskRoot(legacyId)), { recursive: true });
    writeFileSync(join(prePaths.taskRoot(legacyId), 'task.json'), '{broken', 'utf8');
    const pub = new AuthoritativePublicationStore(prePaths, { bootId: 'pre-boot', ownerPid: process.pid, processAlive: () => true, retrySleepMs: 0 });
    const fence = async <T>(fn: () => Promise<T>): Promise<T> => {
      const hold = await pub.lock().acquire();
      try { return await fn(); } finally { await hold.release(); }
    };
    const preIndex = new AuthoritativeTaskIndexV1({ paths: prePaths, withStoreFence: fence, clock: () => '2026-08-14T10:00:00.000Z' });
    const barrier = await preIndex.runMigrationBarrier();
    expect(barrier.captured).toContain(legacyId);
    expect(await preIndex.entryFor(legacyId)).toMatchObject({ state: 'legacy_preexisting' });
    // Legacy deletion path removes the corrupt directory.
    const preCatalog = new TemplateCatalog(prePaths);
    await preCatalog.initialize();
    const preStore = new TaskStore(prePaths, preCatalog);
    await preStore.deleteTask(legacyId);
    expect((await usableTaskDirectories(prePaths)).includes(legacyId)).toBe(false);
    // The row stays retired: v2 creation for the id is refused forever.
    await expect(
      preIndex.prepareTaskUnderFence({
        taskId: legacyId,
        templateSnapshotHash: 'a'.repeat(64),
        profileSnapshotRef: { kind: 'profile_snapshot', digest: 'b'.repeat(64), byteLength: 1, mediaType: 'application/json', schemaVersion: 1 },
        templateSnapshotRef: { kind: 'content_value', digest: 'c'.repeat(64), byteLength: 1, mediaType: 'text/plain', schemaVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'ID_UNAVAILABLE' });
  });

  it('v2 create before the migration barrier is refused (MIGRATION_INCOMPLETE)', async () => {
    const paths = makeTempCorePaths('forge-core-store-v2nomig-').paths;
    installAuthoritativeFixture(join(paths.templateRoot));
    const env = createAuthoritativeReviewTestEnvironment();
    const catalog = new TemplateCatalog(paths, {
      runtimeEnvironment: createTestRuntimeEnvironment(),
      authoritativeReviewEnvironment: env,
    });
    await catalog.initialize();
    const index = new AuthoritativeTaskIndexV1({ paths });
    const taskStore = new TaskStore(paths, catalog, index);
    await expect(taskStore.create(v2Request())).rejects.toMatchObject({ code: 'MIGRATION_INCOMPLETE' });
  });

  it('a post-marker unindexed directory is quarantineable and never listable as usable', async () => {
    const { paths, index, taskStore } = await v2Installation();
    mkdirSync(join(paths.taskRoot('unindexed-dir')), { recursive: true });
    const moved = await index.quarantineUnindexedDirectory('unindexed-dir', 'post-marker unindexed');
    expect(moved).not.toBeNull();
    expect((await usableTaskDirectories(paths)).includes('unindexed-dir')).toBe(false);
    // Listing treats it as corrupt at worst (never v2, never legacy).
    const listed = await taskStore.listTasks();
    expect(listed.some((summary) => summary.id === 'unindexed-dir')).toBe(false);
  });
});

describe('TaskStore archived-profile binding (constraint B): A → B → disabled → exact A', { timeout: 30_000 }, () => {
  /** Profile B: SAME identity, SAME handler registry, DIFFERENT bytes (runtime change). */
  function profileB(): { env: ReturnType<typeof createAuthoritativeReviewTestEnvironment>; body: ReturnType<typeof buildAuthoritativeReviewTestProfileBody> } {
    const bodyA = buildAuthoritativeReviewTestProfileBody();
    const body = {
      ...bodyA,
      runtime: { ...bodyA.runtime, maxFindingsPerRound: bodyA.runtime.maxFindingsPerRound + 1 },
    };
    const withDigest = { ...body, profileDigest: '' };
    delete (withDigest as Record<string, unknown>).profileDigest;
    const digest = canonicalJsonSha256(withDigest);
    const validated = validateAuthoritativeReviewProfile({ ...body, profileDigest: digest });
    const capability: Parameters<typeof createAuthoritativeReviewRuntimeEnvironment>[0] = {
      version: 1,
      status: 'enabled',
      profileIdentity: AUTHORITATIVE_PROFILE_IDENTITY,
      profileDigest: validated.profileDigest,
      evidenceDigest: '0'.repeat(64),
      requiredAbis: ['forge-validator/v2', 'forge-assembler/v2'],
    };
    const env = createAuthoritativeReviewRuntimeEnvironment(
      capability,
      validated,
      createAuthoritativeReviewTestHandlerRegistry(),
    );
    return { env, body: validated };
  }

  it('A → B and A → disabled: the task snapshot reopens with the FROZEN profile and the exact A binding', async () => {
    const harness = await v2Installation();
    const { paths } = harness;
    const created = await harness.taskStore.create(v2Request());
    const record = JSON.parse(readFileSync(paths.taskFile(created.id), 'utf8')) as { templateVersion: string };
    const row = (await harness.index.entryFor(created.id)) as PreparedActiveTaskRowV2;

    // Reopen under profile B (same identity, different digest).
    const b = profileB();
    const reopenedWithB = await v2Installation({ shared: { paths }, authoritativeReviewEnvironment: b.env });
    const frozenB = await reopenedWithB.taskStore.readFrozenTemplate(created.id);
    expect(frozenB.versionHash).toBe(record.templateVersion);
    expect(frozenB.authoritativeReviewProfile?.profileSnapshotRef).toEqual(row.profileSnapshotRef);
    expect(frozenB.authoritativeReviewProfile?.profileDigest).toBe(harness.env.profile?.profileDigest);
    // Eligibility is SEPARATE from the (unchanged) snapshot identity.
    const eligibility = deriveAuthoritativeReviewExecutionEligibility({
      frozenProfileDigest: harness.env.profile?.profileDigest as string,
      baseStructuredCapabilityEnabled: true,
      currentCapability: b.env.capability,
      currentProfileDigest: b.env.profile?.profileDigest ?? null,
      requiredAbisAvailable: true,
    });
    expect(eligibility).toMatchObject({ state: 'blocked', reason: 'profile_digest_mismatch' });

    // Reopen under the DISABLED production environment: reads stay available.
    const disabledEnv = createProductionAuthoritativeReviewEnvironment();
    const reopenedDisabled = await v2Installation({ shared: { paths }, authoritativeReviewEnvironment: disabledEnv });
    const frozenDisabled = await reopenedDisabled.taskStore.readFrozenTemplate(created.id);
    expect(frozenDisabled.versionHash).toBe(record.templateVersion);
    expect(frozenDisabled.authoritativeReviewProfile?.profileSnapshotRef).toEqual(row.profileSnapshotRef);
    const disabledEligibility = deriveAuthoritativeReviewExecutionEligibility({
      frozenProfileDigest: harness.env.profile?.profileDigest as string,
      baseStructuredCapabilityEnabled: true,
      currentCapability: disabledEnv.capability,
      currentProfileDigest: disabledEnv.profile?.profileDigest ?? null,
      requiredAbisAvailable: false,
    });
    expect(disabledEligibility).toMatchObject({ state: 'blocked', reason: 'authoritative_capability_disabled' });

    // Exact A restart restores eligibility with the SAME snapshot identity.
    const returnedA = await v2Installation({ shared: { paths } });
    const frozenA = await returnedA.taskStore.readFrozenTemplate(created.id);
    expect(frozenA.versionHash).toBe(record.templateVersion);
    const aEligibility = deriveAuthoritativeReviewExecutionEligibility({
      frozenProfileDigest: returnedA.env.profile?.profileDigest as string,
      baseStructuredCapabilityEnabled: true,
      currentCapability: returnedA.env.capability,
      currentProfileDigest: returnedA.env.profile?.profileDigest ?? null,
      requiredAbisAvailable: true,
    });
    expect(aEligibility).toMatchObject({ state: 'eligible' });
    // One checkbox: the create-time profile bytes are archived in the task
    // root even when the current environment never saw them.
    const archived = readFileSync(
      paths.taskStructuredV2BlobFile(created.id, 'profile_snapshot', row.profileSnapshotRef.digest),
      'utf8',
    );
    const parsed = JSON.parse(archived) as { profileDigest?: string };
    expect(parsed.profileDigest).toBe(harness.env.profile?.profileDigest);
  });

  it('a tampered/missing profile blob fails the reopen as TASK_CORRUPTED (never guessed)', async () => {
    const harness = await v2Installation();
    const created = await harness.taskStore.create(v2Request());
    const row = (await harness.index.entryFor(created.id)) as PreparedActiveTaskRowV2;
    const profileFile = harness.paths.taskStructuredV2BlobFile(created.id, 'profile_snapshot', row.profileSnapshotRef.digest);
    writeFileSync(profileFile, '{}', 'utf8');
    await expect(harness.taskStore.readFrozenTemplate(created.id)).rejects.toMatchObject({
      code: 'TASK_CORRUPTED',
    });
  });
});
