/**
 * Task 11 fenced deletion tests (spec §10.5): prepared tombstone outside the
 * task root, TASK_DELETED blocking for every subsequent caller, wakeup
 * removal, non-replayable pins, atomic quarantine rename with parent fsync,
 * detached→async purge, crash/restart resume at prepared/detached/purged, a
 * reappearing directory quarantined and never revived, response-loss replay
 * and conflict, and the fixed local task_owner principal.
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CorePaths } from './core-paths';
import {
  AuthoritativeTaskIndexV1,
  deletedTaskTombstoneFile,
} from './authoritative-task-index';
import {
  AuthoritativeTaskDeletionV2,
  TASK_OWNER_PRINCIPAL,
  TaskDeleteError,
  deletionTrashPath,
  deletionTrashRoot,
  type DeletedTaskTombstoneV2,
} from './authoritative-task-deletion';
import { AuthoritativeWakeupIndexV1 } from '../runtime/authoritative-review/wakeup-index';
import { taskIndexMigrationMarkerFile } from './authoritative-task-index';

const roots: string[] = [];
const HASH = 'c'.repeat(64);
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

function makePaths(): CorePaths {
  const dataRoot = mkdtempSync(join(tmpdir(), 'forge-delete-data-'));
  const templateRoot = mkdtempSync(join(tmpdir(), 'forge-delete-templates-'));
  roots.push(dataRoot, templateRoot);
  return CorePaths.create({ dataRoot, templateRoot });
}

function seedV2Task(paths: CorePaths, taskId: string): void {
  const root = paths.taskRoot(taskId);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, 'events'), { recursive: true });
  mkdirSync(join(root, 'structured-slots'), { recursive: true });
  writeFileSync(
    join(root, 'task.json'),
    JSON.stringify({ id: taskId, name: taskId, templateId: 't', templateName: 't', templateVersion: HASH, frozenInput: {}, createdAt: '2026-08-14T10:00:00.000Z' }),
    'utf8',
  );
}

interface DeleteEnv {
  paths: CorePaths;
  index: AuthoritativeTaskIndexV1;
  wakeups: AuthoritativeWakeupIndexV1;
  deletion: AuthoritativeTaskDeletionV2;
  pins: Array<{ pinId: string; taskId: string }>;
  now: { value: string };
}

async function makeEnv(shared?: CorePaths): Promise<DeleteEnv> {
  const paths = shared ?? makePaths();
  const now = { value: '2026-08-14T10:00:00.000Z' };
  const index = new AuthoritativeTaskIndexV1({ paths, clock: () => now.value });
  if (shared === undefined) {
    await index.runMigrationBarrier();
  } else {
    const { access } = await import('node:fs/promises');
    let marker = false;
    try {
      await access(taskIndexMigrationMarkerFile(paths));
      marker = true;
    } catch {
      marker = false;
    }
    if (!marker) await index.runMigrationBarrier();
  }
  const wakeups = new AuthoritativeWakeupIndexV1({ paths });
  const pins: DeleteEnv['pins'] = [];
  const deletion = new AuthoritativeTaskDeletionV2({
    paths,
    index,
    wakeups,
    clock: () => now.value,
    snapshotPins: async () => [...pins],
    renamePinFile: async (pinId) => {
      pins.splice(
        pins.findIndex((pin) => pin.pinId === pinId),
        1,
      );
    },
  });
  return { paths, index, wakeups, deletion, pins, now };
}

describe('AuthoritativeTaskDeletionV2', () => {
  beforeAll(() => {
    roots.length = 0;
  });

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('deletes a running v2 task under the fixed task_owner principal: prepared tombstone, TASK_DELETED blocking, wakeup removal, pin non-replayability, quarantine, detached, purge', async () => {
    const env = await makeEnv();
    const { paths, deletion, wakeups } = env;
    seedV2Task(paths, 'task-a');
    await env.index.prepareTask({ taskId: 'task-a', templateSnapshotHash: HASH, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF });
    await env.index.activateTask('task-a');
    await wakeups.upsert('task-a', { kind: 'lease_expiry', at: '2026-08-14T10:30:00.000Z', dormant: false, workItemId: 'wi-1', operationId: 'op-1', eligibilityBlocked: false });
    await wakeups.upsert('task-a', { kind: 'runnable', at: null, dormant: false, workItemId: null, operationId: null, eligibilityBlocked: false });
    env.pins.push({ pinId: 'pin-1', taskId: 'task-a' }, { pinId: 'pin-2', taskId: 'other' });

    const result = await deletion.runDelete('task-a', { operationId: '3f9b63b3-0000-4000-8000-000000000001', reason: '过时任务' });
    expect(result).toEqual({ operationId: '3f9b63b3-0000-4000-8000-000000000001', state: 'detached' });

    // Blocks every caller with TASK_DELETED while detached.
    await expect(deletion.assertNotDeleted('task-a')).rejects.toMatchObject({ code: 'TASK_DELETED' });
    // Reason + fixed principal recorded; body cannot forge an actor. The
    // fenced command confirms DETACHED; purge is the afterward phase.
    const tombstone = await deletion.tombstoneFor('task-a');
    expect(tombstone).toMatchObject({
      taskId: 'task-a',
      deleteOperationId: '3f9b63b3-0000-4000-8000-000000000001',
      requestedBy: TASK_OWNER_PRINCIPAL.id,
      deleteEpoch: 1,
      state: 'detached',
    });
    // Wakeups removed; pins non-replayable; the root is quarantined.
    expect(await wakeups.read('task-a')).toEqual([]);
    expect(env.pins).toEqual([{ pinId: 'pin-2', taskId: 'other' }]);
    const { stat } = await import('node:fs/promises');
    await expect(stat(deletionTrashPath(paths, 'task-a', 1))).resolves.toBeTruthy();
    // The recursive purge completes the machine: quarantine gone, purged.
    await deletion.purgeTask('task-a', 1);
    let quarantineGone = false;
    try {
      await stat(deletionTrashPath(paths, 'task-a', 1));
    } catch {
      quarantineGone = true;
    }
    expect(quarantineGone).toBe(true);
    expect((await deletion.tombstoneFor('task-a'))?.state).toBe('purged');
  });

  it('same operation/body replays the committed result; different body conflicts; different op conflicts', async () => {
    const env = await makeEnv();
    seedV2Task(env.paths, 'task-b');
    await env.index.prepareTask({ taskId: 'task-b', templateSnapshotHash: HASH, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF });
    await env.index.activateTask('task-b');
    const op = '3f9b63b3-0000-4000-8000-000000000002';
    const first = await env.deletion.runDelete('task-b', { operationId: op, reason: '清理' });
    // Response loss: same operation + same canonical body returns the result.
    const replay = await env.deletion.runDelete('task-b', { operationId: op, reason: '清理' });
    expect(replay).toEqual(first);
    // After the purge a replay still returns the tombstone result (purged).
    await env.deletion.purgeTask('task-b', 1);
    expect(await env.deletion.runDelete('task-b', { operationId: op, reason: '清理' })).toEqual({ operationId: op, state: 'purged' });
    // Same operation + different reason: idempotency conflict.
    await expect(env.deletion.runDelete('task-b', { operationId: op, reason: '改了原因' })).rejects.toMatchObject({ code: 'DELETE_CONFLICT' });
    // Different operation on the purged id: conflict (ID is retired).
    await expect(env.deletion.runDelete('task-b', { operationId: '3f9b63b3-0000-4000-8000-000000000003', reason: '再来一次' })).rejects.toMatchObject({ code: 'DELETE_CONFLICT' });
  });

  it('crash/restart at prepared resumes; missing-root prepared tombstones are deletion recovery; purged stays retained', async () => {
    const env = await makeEnv();
    const { paths, deletion } = env;
    seedV2Task(paths, 'task-c');
    await env.index.prepareTask({ taskId: 'task-c', templateSnapshotHash: HASH, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF });
    await env.index.activateTask('task-c');
    // Crash right after the prepared tombstone (before detach): write the
    // prepared tombstone file by hand and simulate restart with a fresh
    // instance over the SAME data root.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(paths.dataRoot, 'deleted-tasks'), { recursive: true });
    writeFileSync(
      deletedTaskTombstoneFile(paths, 'task-c'),
      JSON.stringify({
        protocolVersion: 2,
        taskId: 'task-c',
        templateSnapshotHash: HASH,
        deleteOperationId: '3f9b63b3-0000-4000-8000-000000000004',
        requestedBy: 'task_owner',
        reason: '清理',
        observedTailCommitId: null,
        deleteEpoch: 1,
        state: 'prepared',
        createdAt: '2026-08-14T10:00:00.000Z',
      }),
      'utf8',
    );
    const restarted = await makeEnv(paths);
    await expect(restarted.deletion.assertNotDeleted('task-c')).rejects.toMatchObject({ code: 'TASK_DELETED' });
    const { resumed, purged } = await restarted.deletion.runStartupRecovery();
    expect(resumed).toEqual(['task-c']);
    expect(purged).toEqual([]);
    const tombstone = await restarted.deletion.tombstoneFor('task-c');
    expect(tombstone?.state).toBe('purged');
    // A reappearing directory for the tombstoned id is quarantined (never revived).
    seedV2Task(paths, 'task-c');
    await restarted.deletion.runStartupRecovery();
    const { readdir } = await import('node:fs/promises');
    const trashNames = await readdir(deletionTrashRoot(paths));
    expect(trashNames.some((name) => name.startsWith('.revived-task-c-'))).toBe(true);
    // The purged tombstone prevents ID reuse.
    await expect(restarted.index.prepareTask({ taskId: 'task-c', templateSnapshotHash: HASH, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF })).rejects.toMatchObject({ code: 'ID_UNAVAILABLE' });
  });

  it('crash/restart at detached resumes the purge; missing directory with prepared tombstone is deletion recovery, never corruption', async () => {
    const env = await makeEnv();
    const { paths, deletion } = env;
    seedV2Task(paths, 'task-d');
    await env.index.prepareTask({ taskId: 'task-d', templateSnapshotHash: HASH, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF });
    await env.index.activateTask('task-d');
    // Manually detach (root moved into trash) and leave the tombstone
    // DETACHED (crash before purge completion).
    const { mkdir, rename } = await import('node:fs/promises');
    await mkdir(deletionTrashRoot(paths), { recursive: true });
    await rename(paths.taskRoot('task-d'), deletionTrashPath(paths, 'task-d', 1));
    await mkdir(join(paths.dataRoot, 'deleted-tasks'), { recursive: true });
    writeFileSync(
      deletedTaskTombstoneFile(paths, 'task-d'),
      JSON.stringify({
        protocolVersion: 2,
        taskId: 'task-d',
        templateSnapshotHash: HASH,
        deleteOperationId: '3f9b63b3-0000-4000-8000-000000000005',
        requestedBy: 'task_owner',
        reason: '清理',
        observedTailCommitId: null,
        deleteEpoch: 1,
        state: 'detached',
        createdAt: '2026-08-14T10:00:00.000Z',
      }),
      'utf8',
    );
    const restarted = await makeEnv(paths);
    await restarted.deletion.runStartupRecovery();
    expect((await restarted.deletion.tombstoneFor('task-d'))?.state).toBe('purged');

    // Missing active directory with a prepared tombstone = deletion recovery.
    seedV2Task(paths, 'task-e');
    await env.index.prepareTask({ taskId: 'task-e', templateSnapshotHash: HASH, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF });
    await env.index.activateTask('task-e');
    const { rm } = await import('node:fs/promises');
    await rm(paths.taskRoot('task-e'), { recursive: true });
    writeFileSync(
      deletedTaskTombstoneFile(paths, 'task-e'),
      JSON.stringify({
        protocolVersion: 2,
        taskId: 'task-e',
        templateSnapshotHash: HASH,
        deleteOperationId: '3f9b63b3-0000-4000-8000-000000000006',
        requestedBy: 'task_owner',
        reason: '清理',
        observedTailCommitId: null,
        deleteEpoch: 1,
        state: 'prepared',
        createdAt: '2026-08-14T10:00:00.000Z',
      }),
      'utf8',
    );
    const secondRestart = await makeEnv(paths);
    await secondRestart.deletion.runStartupRecovery();
    expect((await secondRestart.deletion.tombstoneFor('task-e'))?.state).toBe('purged');
  });

  it('two instances over one shared data root converge (fence serializes); lease/pin/scheduling callers all see TASK_DELETED', async () => {
    const shared = makePaths();
    const envA = await makeEnv(shared);
    const envB = await makeEnv(shared);
    seedV2Task(shared, 'task-f');
    await envA.index.prepareTask({ taskId: 'task-f', templateSnapshotHash: HASH, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF });
    await envA.index.activateTask('task-f');
    // Deterministic serialization over the shared root: A runs first, B
    // conflicts on the SAME id (the fence serializes production instances;
    // here the sequential run proves the shared-root convergence).
    const resultA = await envA.deletion.runDelete('task-f', { operationId: '3f9b63b3-0000-4000-8000-000000000007', reason: '清理' });
    expect(resultA.state).toBe('detached');
    await expect(envB.deletion.runDelete('task-f', { operationId: '3f9b63b3-0000-4000-8000-000000000008', reason: '清理' })).rejects.toMatchObject({ code: 'DELETE_CONFLICT' });
    // B still observes the same tombstone (shared data root).
    await expect(envB.deletion.assertNotDeleted('task-f')).rejects.toMatchObject({ code: 'TASK_DELETED' });
    expect(await envB.deletion.isDeleted('task-f')).toBe(true);
    // Retained GC roots: prepared→detached retention through quarantine.
    const rootsAtB = await envB.deletion.retainedRootsFor('task-f');
    expect(rootsAtB).toEqual([PROFILE_REF, TEMPLATE_REF]);
    // After purge the retention releases.
    await envB.deletion.purgeTask('task-f', 1);
    expect(await envB.deletion.retainedRootsFor('task-f')).toEqual([]);
    expect(await envB.deletion.isDeleted('task-f')).toBe(true);
  });

  it('fails cleanly (task_owner principal) when the client tries to forge an actor', async () => {
    const env = await makeEnv();
    const { deletion } = env;
    seedV2Task(env.paths, 'task-g');
    // requestedBy is ignored: the server-fixed principal always wins.
    await deletion.runDelete('task-g', { operationId: '3f9b63b3-0000-4000-8000-000000000009', reason: '清理', requestedBy: 'evil-client' });
    const tombstone = await deletion.tombstoneFor('task-g');
    expect(tombstone?.requestedBy).toBe('task_owner');
    // Missing/empty body fields fail BEFORE any tombstone is written.
    await expect(deletion.runDelete('task-h', { operationId: '', reason: '' })).rejects.toBeInstanceOf(TaskDeleteError);
    expect(await deletion.tombstoneFor('task-h')).toBeNull();
  });
}, 30_000);
describe('AuthoritativeTaskDeletionV2 review A-M2/A-M4 (prepared replay + purge strictness)', { timeout: 30_000 }, () => {
  it('A-M2: a same-op replay on a PREPARED tombstone re-attempts the detach (never reports detached falsely)', async () => {
    const env = await makeEnv();
    const { paths, deletion } = env;
    seedV2Task(paths, 'task-replay-prepared');
    await env.index.prepareTask({ taskId: 'task-replay-prepared', templateSnapshotHash: HASH, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF });
    await env.index.activateTask('task-replay-prepared');
    // Crash AFTER the prepared tombstone but BEFORE the detach: the root is
    // still present, so the replay must complete the detachment and only then
    // report detached.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(paths.dataRoot, 'deleted-tasks'), { recursive: true });
    const prepared: DeletedTaskTombstoneV2 = {
      protocolVersion: 2,
      taskId: 'task-replay-prepared',
      templateSnapshotHash: HASH,
      deleteOperationId: '3f9b63b3-0000-4000-8000-00000000000a',
      requestedBy: 'task_owner',
      reason: '清理',
      observedTailCommitId: null,
      deleteEpoch: 1,
      state: 'prepared',
      createdAt: '2026-08-14T10:00:00.000Z',
    };
    writeFileSync(deletedTaskTombstoneFile(paths, 'task-replay-prepared'), JSON.stringify(prepared), 'utf8');
    const replayed = await deletion.runDelete('task-replay-prepared', {
      operationId: '3f9b63b3-0000-4000-8000-00000000000a',
      reason: '清理',
    });
    expect(replayed.state).toBe('detached');
    // The detach actually happened: the root is in trash and the tombstone is
    // durably detached.
    const { readdir } = await import('node:fs/promises');
    const trashNames = await readdir(deletionTrashRoot(paths));
    expect(trashNames.some((name) => name.startsWith('task-replay-prepared-'))).toBe(true);
    const current = await deletion.tombstoneFor('task-replay-prepared');
    expect(current?.state).toBe('detached');
  });

  it('A-M4: a purge that cannot remove the trash keeps the tombstone DETACHED (retried later)', async () => {
    const env = await makeEnv();
    const { paths, deletion } = env;
    seedV2Task(paths, 'task-purge-locked');
    await env.index.prepareTask({ taskId: 'task-purge-locked', templateSnapshotHash: HASH, profileSnapshotRef: PROFILE_REF, templateSnapshotRef: TEMPLATE_REF });
    await env.index.activateTask('task-purge-locked');
    await deletion.runDelete('task-purge-locked', {
      operationId: '3f9b63b3-0000-4000-8000-00000000000b',
      reason: '清理',
    });
    // Simulate a LOCKED trash directory: a nested dir with mode 0o000 makes
    // the recursive rm fail deterministically (descending needs +x) — the
    // durable tombstone must STAY detached.
    const trashPath = deletionTrashPath(paths, 'task-purge-locked', 1);
    const { chmod, mkdir, rm, writeFile } = await import('node:fs/promises');
    await rm(trashPath, { recursive: true, force: true });
    await mkdir(trashPath, { recursive: true });
    await writeFile(join(trashPath, 'payload'), 'locked', 'utf8');
    const lockedDir = join(trashPath, 'locked-dir');
    await mkdir(lockedDir, { recursive: true });
    await writeFile(join(lockedDir, 'nested'), 'x', 'utf8');
    await chmod(lockedDir, 0o000);
    await deletion.purgeTask('task-purge-locked', 1);
    const after = await deletion.tombstoneFor('task-purge-locked');
    expect(after?.state).toBe('detached');
    // The next purge (once the path is removable) advances to purged.
    await chmod(lockedDir, 0o700);
    await deletion.purgeTask('task-purge-locked', 1);
    const purged = await deletion.tombstoneFor('task-purge-locked');
    expect(purged?.state).toBe('purged');
  });
});
