/**
 * Task 11 installation task index tests (spec §10.5): the fenced migration
 * barrier (crash resumes the same captured set, unreadable dirs still
 * registered, marker fsync, v2 creation disabled until the marker), the
 * prepared→active immutable identity rows with formal GC roots, startup
 * creation recovery, and the post-marker unindexed-directory fail-closed
 * quarantine.
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CorePaths } from './core-paths';
import {
  AuthoritativeTaskIndexV1,
  TaskIndexError,
  deletedTaskTombstoneFile,
  taskIndexMigrationMarkerFile,
  taskIndexMigrationStagingFile,
} from './authoritative-task-index';

const roots: string[] = [];

function makePaths(): CorePaths {
  const dataRoot = mkdtempSync(join(tmpdir(), 'forge-task-index-data-'));
  const templateRoot = mkdtempSync(join(tmpdir(), 'forge-task-index-templates-'));
  roots.push(dataRoot, templateRoot);
  return CorePaths.create({ dataRoot, templateRoot });
}

const PROFILE_REF = {
  kind: 'profile_snapshot',
  digest: 'a'.repeat(64),
  byteLength: 100,
  mediaType: 'application/json',
  schemaVersion: 1,
} as const;
const TEMPLATE_REF = {
  kind: 'content_value',
  digest: 'b'.repeat(64),
  byteLength: 20,
  mediaType: 'text/plain',
  schemaVersion: 1,
} as const;
const HASH64 = 'c'.repeat(64);

function seedTaskDir(paths: CorePaths, taskId: string, templateVersion = HASH64): void {
  const root = paths.taskRoot(taskId);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, 'events'), { recursive: true });
  writeFileSync(
    join(root, 'task.json'),
    JSON.stringify({ id: taskId, name: taskId, templateId: 't', templateName: 't', templateVersion, frozenInput: {}, createdAt: '2026-08-14T10:00:00.000Z' }, null, 2),
    'utf8',
  );
}

describe('AuthoritativeTaskIndexV1 migration barrier', () => {
  beforeAll(() => {
    roots.length = 0;
  });

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('captures every pre-marker directory (even unreadable roots) and fsyncs the marker; v2 create stays disabled before it', async () => {
    const paths = makePaths();
    const index = new AuthoritativeTaskIndexV1({ paths, clock: () => '2026-08-14T10:00:00.000Z' });
    expect(await index.migrationComplete()).toBe(false);
    // v2 create is disabled until the marker.
    await expect(index.prepareTask({ taskId: 'task-a', templateSnapshotHash: HASH64, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF })).rejects.toMatchObject({ code: 'MIGRATION_INCOMPLETE' });
    seedTaskDir(paths, 'legacy-task'); // healthy
    const unreadable = paths.taskRoot('raw-legacy');
    mkdirSync(unreadable, { recursive: true }); // unreadable record: no task.json
    const { captured } = await index.runMigrationBarrier();
    expect(captured.sort()).toEqual(['legacy-task', 'raw-legacy']);
    const legacy = await index.legacyIds();
    expect(legacy.sort()).toEqual(['legacy-task', 'raw-legacy']);
    // Unreadable legacy dirs are STILL registered (their pre-v2 existence is
    // proven by the capture), and their IDs can never be reused for v2.
    await expect(index.prepareTask({ taskId: 'legacy-task', templateSnapshotHash: HASH64, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF })).rejects.toMatchObject({ code: 'ID_UNAVAILABLE' });
    // The marker is durably present; a second run is a no-op.
    expect(await index.migrationComplete()).toBe(true);
    const again = await index.runMigrationBarrier();
    expect(again.captured.sort()).toEqual(['legacy-task', 'raw-legacy']);
    // Prepare now works for a NEW id.
    const prepared = await index.prepareTask({ taskId: 'task-a', templateSnapshotHash: HASH64, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF });
    expect(prepared.state).toBe('prepared');
  });

  it('crash before marker completion resumes the SAME captured set', async () => {
    const paths = makePaths();
    const index = new AuthoritativeTaskIndexV1({ paths, clock: () => '2026-08-14T10:00:00.000Z' });
    seedTaskDir(paths, 'alpha');
    // Simulate a crash AFTER the staging capture but BEFORE the marker: leave
    // the staging file and remove nothing else; then a fresh instance runs the
    // barrier and must reuse the staging capture.
    const first = new AuthoritativeTaskIndexV1({ paths });
    await first.runMigrationBarrier();
    // Force the crash-mid-barrier shape: keep staging, delete marker.
    const { rm } = await import('node:fs/promises');
    await rm(taskIndexMigrationMarkerFile(paths), { force: true });
    writeFileSync(
      taskIndexMigrationStagingFile(paths),
      JSON.stringify({ version: 'authoritative-task-index-migration-v1', capturedAt: '2026-08-14T10:00:00.000Z', taskIds: ['alpha', 'ghost'] }, null, 2),
      'utf8',
    );
    seedTaskDir(paths, 'beta'); // appears AFTER the capture — must NOT join the resumed set
    const resumed = new AuthoritativeTaskIndexV1({ paths });
    const result = await resumed.runMigrationBarrier();
    expect(result.resumed).toBe(true);
    expect(result.captured.sort()).toEqual(['alpha', 'ghost']);
    const legacy = await resumed.legacyIds();
    expect(legacy.sort()).toEqual(['alpha', 'ghost']);
    // beta is post-capture: it has no legacy row and no prepared/active row.
    expect(await resumed.entryFor('beta')).toBeNull();
  });

  it('rejects reused/tombstoned IDs and promotes prepared → active under the fence', async () => {
    const paths = makePaths();
    const index = new AuthoritativeTaskIndexV1({ paths, clock: () => '2026-08-14T10:00:00.000Z' });
    seedTaskDir(paths, 'pre-existing');
    await index.runMigrationBarrier();
    await index.prepareTask({ taskId: 'task-b', templateSnapshotHash: HASH64, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF });
    // Same id again: conflict.
    await expect(index.prepareTask({ taskId: 'task-b', templateSnapshotHash: HASH64, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF })).rejects.toMatchObject({ code: 'ID_UNAVAILABLE' });
    // Tombstoned id (deletion tombstone file present): conflict.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(paths.dataRoot, 'deleted-tasks'), { recursive: true });
    writeFileSync(deletedTaskTombstoneFile(paths, 'tomb-task'), JSON.stringify({ state: 'purged' }), 'utf8');
    await expect(index.prepareTask({ taskId: 'tomb-task', templateSnapshotHash: HASH64, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF })).rejects.toMatchObject({ code: 'ID_UNAVAILABLE' });
    // Promotion is idempotent.
    const active = await index.activateTask('task-b');
    expect(active.state).toBe('active');
    expect((await index.activateTask('task-b')).state).toBe('active');
    const rows = await index.v2Rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ taskId: 'task-b', protocol: 'v2', templateSnapshotHash: HASH64, state: 'active' });
    const gc = await index.gcRootsProvider();
    expect(gc['task-b']).toEqual([PROFILE_REF, TEMPLATE_REF]);
  });

  it('recovers prepared/active/mismatched rows on startup (creation recovery)', async () => {
    const paths = makePaths();
    const index = new AuthoritativeTaskIndexV1({ paths, clock: () => '2026-08-14T10:00:00.000Z' });
    await index.runMigrationBarrier();
    // prepared + no root -> cancelled.
    await index.prepareTask({ taskId: 'prep-none', templateSnapshotHash: HASH64, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF });
    // prepared + complete matching root -> activated.
    await index.prepareTask({ taskId: 'prep-ready', templateSnapshotHash: HASH64, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF });
    seedTaskDir(paths, 'prep-ready');
    // prepared + mismatched root -> quarantined + cancelled.
    await index.prepareTask({ taskId: 'prep-bad', templateSnapshotHash: HASH64, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF });
    seedTaskDir(paths, 'prep-bad', 'd'.repeat(64));
    // active + mismatched root -> quarantined.
    await index.prepareTask({ taskId: 'active-bad', templateSnapshotHash: HASH64, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF });
    seedTaskDir(paths, 'active-bad', 'd'.repeat(64));
    await index.activateTask('active-bad');
    // active + missing root + tombstone -> deletion recovery, never corruption.
    await index.prepareTask({ taskId: 'active-deleted', templateSnapshotHash: HASH64, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF });
    await index.activateTask('active-deleted');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(paths.dataRoot, 'deleted-tasks'), { recursive: true });
    writeFileSync(deletedTaskTombstoneFile(paths, 'active-deleted'), JSON.stringify({ state: 'prepared' }), 'utf8');

    const outcome = await index.runCreationRecovery();
    expect(outcome.cancelled.sort()).toEqual(['prep-bad', 'prep-none']);
    expect(outcome.activated).toEqual(['prep-ready']);
    expect(outcome.quarantined.sort()).toEqual(['active-bad', 'prep-bad']);
    expect(outcome.activeMissing).toEqual(['active-deleted']);
    // prep-bad was quarantined AND cancelled.
    expect(await index.entryFor('prep-bad')).toBeNull();
    expect(await index.entryFor('prep-ready')).toMatchObject({ state: 'active' });
    // Post-recovery GC roots cover every live indexed v2 row. The tombstoned
    // task ('active-deleted') is EXCLUDED: its blobs were physically renamed
    // into the installation trash — outside the GC sweep surface — so marking
    // its refs would abort the round as unresolvable corruption. The ROW (the
    // identity) stays forever; that is what the tombstone retains through
    // detached/purged (Task 11 continuation ruling).
    const gc = await index.gcRootsProvider();
    expect(Object.keys(gc).sort()).toEqual(['active-bad', 'prep-ready']);
  });

  it('a post-marker unindexed directory is quarantined and never classified legacy', async () => {
    const paths = makePaths();
    const index = new AuthoritativeTaskIndexV1({ paths, clock: () => '2026-08-14T10:00:00.000Z' });
    seedTaskDir(paths, 'before');
    await index.runMigrationBarrier();
    // After the marker a NEW directory appears with no index row: bytes cannot
    // change its classification.
    seedTaskDir(paths, 'after-marker');
    expect(await index.entryFor('after-marker')).toBeNull();
    const target = await index.quarantineUnindexedDirectory('after-marker', 'post-marker unindexed');
    expect(target).not.toBeNull();
    expect(target?.startsWith(join(paths.tasksRoot, '.quarantine-'))).toBe(true);
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(paths.tasksRoot);
    expect(names.some((name) => name.startsWith('.quarantine-after-marker-'))).toBe(true);
    // Never a legacy row even after the quarantine (it never existed pre-marker).
    expect((await index.legacyIds()).sort()).toEqual(['before']);
  });
});