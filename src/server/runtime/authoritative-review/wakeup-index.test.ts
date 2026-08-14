/**
 * Task 11 wakeup index tests (spec §10.4): durable per-task rows survive
 * index-instance recreation ("kill/recreate Coordinator instances — no
 * in-memory queue/timer required"), the coexistence matrix keeps upserts
 * idempotent, dormant rows are preserved but never due, and deletion removes
 * the whole row set.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CorePaths } from '../../storage/core-paths';
import { AuthoritativeWakeupIndexV1, wakeupFile } from './wakeup-index';

const roots: string[] = [];

function makePaths(): CorePaths {
  const dataRoot = mkdtempSync(join(tmpdir(), 'forge-wakeups-data-'));
  const templateRoot = mkdtempSync(join(tmpdir(), 'forge-wakeups-templates-'));
  roots.push(dataRoot, templateRoot);
  return CorePaths.create({ dataRoot, templateRoot });
}

describe('AuthoritativeWakeupIndexV1', () => {
  beforeAll(() => {
    roots.length = 0;
  });

  afterAll(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists durable rows across index-instance recreation (no in-memory state)', async () => {
    const paths = makePaths();
    const first = new AuthoritativeWakeupIndexV1({ paths });
    const at = '2026-08-14T10:30:00.000Z';
    await first.upsert('task-a', { kind: 'lease_expiry', at, dormant: false, workItemId: 'wi-1', operationId: 'op-1', eligibilityBlocked: false });
    await first.upsert('task-a', { kind: 'runnable', at: null, dormant: false, workItemId: null, operationId: null, eligibilityBlocked: false });
    await first.upsert('task-b', { kind: 'retry_due', at, dormant: false, workItemId: 'wi-2', operationId: 'op-2', eligibilityBlocked: false });
    // A FRESH instance over the same data root (process restart).
    const second = new AuthoritativeWakeupIndexV1({ paths });
    const rows = await second.read('task-a');
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.kind === 'lease_expiry')).toMatchObject({
      taskId: 'task-a',
      kind: 'lease_expiry',
      at,
      workItemId: 'wi-1',
      operationId: 'op-1',
    });
    expect(await second.allTasks()).toEqual(['task-a', 'task-b']);
  });

  it('is idempotent for the same (kind, workItemId) identity and keeps entries distinct', async () => {
    const paths = makePaths();
    const index = new AuthoritativeWakeupIndexV1({ paths });
    for (let round = 0; round < 3; round += 1) {
      await index.upsert('task-a', { kind: 'retry_due', at: '2026-08-14T10:20:00.000Z', dormant: false, workItemId: 'wi-9', operationId: 'op-9', eligibilityBlocked: false });
    }
    await index.upsert('task-a', { kind: 'retry_due', at: '2026-08-14T10:25:00.000Z', dormant: false, workItemId: 'wi-8', operationId: 'op-8', eligibilityBlocked: false });
    const rows = await index.read('task-a');
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.taskId === 'task-a')).toBe(true);
  });

  it('keeps dormant rows readable but never due; upsert flips dormancy', async () => {
    const paths = makePaths();
    const index = new AuthoritativeWakeupIndexV1({ paths });
    const at = '2026-08-14T10:00:00.000Z';
    await index.upsert('task-a', { kind: 'retry_due', at, dormant: true, workItemId: 'wi-1', operationId: 'op-1', eligibilityBlocked: false });
    expect(await index.due('2026-08-14T11:00:00.000Z')).toEqual([]);
    // Resume reactivates the SAME identity: the dormant row is replaced live.
    await index.upsert('task-a', { kind: 'retry_due', at, dormant: false, workItemId: 'wi-1', operationId: 'op-1', eligibilityBlocked: false });
    const due = await index.due('2026-08-14T11:00:00.000Z');
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ kind: 'retry_due', workItemId: 'wi-1', at });
  });

  it('treats a null at as due now and filters future at rows', async () => {
    const paths = makePaths();
    const index = new AuthoritativeWakeupIndexV1({ paths });
    await index.upsert('task-a', { kind: 'runnable', at: null, dormant: false, workItemId: null, operationId: null, eligibilityBlocked: false });
    await index.upsert('task-a', { kind: 'lease_expiry', at: '2026-08-14T10:40:00.000Z', dormant: false, workItemId: 'wi-1', operationId: 'op-1', eligibilityBlocked: false });
    const due = await index.due('2026-08-14T10:00:00.000Z');
    expect(due.map((row) => row.kind)).toEqual(['runnable']);
    expect((await index.due('2026-08-14T10:41:00.000Z')).map((row) => row.kind)).toEqual(
      expect.arrayContaining(['runnable', 'lease_expiry']),
    );
  });

  it('removes one entry and the whole task row set', async () => {
    const paths = makePaths();
    const index = new AuthoritativeWakeupIndexV1({ paths });
    await index.upsert('task-a', { kind: 'lease_expiry', at: '2026-08-14T10:30:00.000Z', dormant: false, workItemId: 'wi-1', operationId: 'op-1', eligibilityBlocked: false });
    await index.upsert('task-a', { kind: 'runnable', at: null, dormant: false, workItemId: null, operationId: null, eligibilityBlocked: false });
    await index.remove('task-a', 'runnable', null);
    expect(await index.read('task-a')).toHaveLength(1);
    await index.removeTask('task-a');
    expect(await index.read('task-a')).toEqual([]);
    expect(await index.allTasks()).toEqual([]);
  });

  it('survives a torn read as absent (durable atomic replace never tears)', async () => {
    const paths = makePaths();
    const index = new AuthoritativeWakeupIndexV1({ paths });
    await index.upsert('task-a', { kind: 'runnable', at: null, dormant: false, workItemId: null, operationId: null, eligibilityBlocked: false });
    // A missing file after deletion is "no wakeups", never an error.
    const { rm } = await import('node:fs/promises');
    await rm(wakeupFile(paths, 'task-a'), { force: true });
    expect(await index.read('task-a')).toEqual([]);
    // Corrupt bytes fail closed (never guessed).
    const { writeFile } = await import('node:fs/promises');
    await writeFile(wakeupFile(paths, 'task-a'), Buffer.from('{not json', 'utf8'));
    await expect(index.read('task-a')).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });
});