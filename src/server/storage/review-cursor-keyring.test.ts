// @vitest-environment node
/**
 * Task 9: installation-persistent cursor signing keyring (spec §14.2, design
 * §19.1).
 *
 * The keyring is created durably at service bootstrap under the data root and
 * retained across restarts. Cursors carry `keyId`; verification keeps retired
 * keys through a frozen retention window, so rotation never invalidates held
 * cursors within retention. Past retention a retired key answers
 * CURSOR_STALE(signing_key_retired). Missing/unreadable key files fail
 * closed (an initialized installation never silently mints a replacement —
 * that would invalidate every held cursor).
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempCorePaths, disposeAllTestRoots } from '../test-support';
import {
  ReviewCursorKeyring,
  CURSOR_STALE_EXPIRED,
  CURSOR_STALE_UNKNOWN_KEY,
  type CursorVerifyOutcome,
} from './review-cursor-keyring';

afterEach(() => {
  disposeAllTestRoots();
});

describe('ReviewCursorKeyring', () => {
  it('bootstraps an active key durably and signs/verifies a cursor payload', async () => {
    const { paths } = makeTempCorePaths();
    const keyring = new ReviewCursorKeyring(paths, { clock: () => '2026-08-14T00:00:00.000Z' });
    await keyring.initialize();
    expect(keyring.activeKeyId()).toMatch(/^key-[0-9a-f]{16}$/);
    // The active key file and bootstrap marker exist on disk.
    const active = JSON.parse(await readFile(paths.cursorKeyringActiveFile(), 'utf8')) as { keyId: string; secret: string };
    expect(active.keyId).toBe(keyring.activeKeyId());
    expect(active.secret).toMatch(/^[0-9a-f]{64}$/);
    const marker = JSON.parse(await readFile(paths.cursorKeyringCreatedMarkerFile(), 'utf8')) as { version: number };
    expect(marker.version).toBe(2);
    // Sign under the active key and verify with the returned keyId.
    const { keyId, signature } = keyring.sign('cursor-payload');
    expect(keyring.verify('cursor-payload', signature, keyId)).toBe('valid');
    expect(keyring.verify('tampered', signature, keyId)).toBe('invalid');
  });

  it('reconstructs the same keyring identity after a process restart (durable)', async () => {
    const { paths } = makeTempCorePaths();
    const first = new ReviewCursorKeyring(paths, { clock: () => '2026-08-14T00:00:00.000Z' });
    await first.initialize();
    const keyId = first.activeKeyId();
    const { signature } = first.sign('payload-1');
    // New instance over the same data root: identical active key, cursors
    // continue to verify across restarts (spec §14.2 retention).
    const second = new ReviewCursorKeyring(paths, { clock: () => '2026-08-14T00:01:00.000Z' });
    await second.initialize();
    expect(second.activeKeyId()).toBe(keyId);
    expect(second.verify('payload-1', signature, keyId)).toBe('valid');
  });

  it('rotates: old cursors verify during retention; past retention they are stale', async () => {
    const { paths } = makeTempCorePaths();
    let now = '2026-08-14T00:00:00.000Z';
    const keyring = new ReviewCursorKeyring(paths, { clock: () => now, retentionMs: 10 * 60 * 1000 });
    await keyring.initialize();
    const oldKeyId = keyring.activeKeyId();
    const { signature } = keyring.sign('page-token');
    // Rotate twice: old key retired with retention, newest active.
    now = '2026-08-14T00:01:00.000Z';
    await keyring.rotate();
    const rotatedKeyId = keyring.activeKeyId();
    expect(rotatedKeyId).not.toBe(oldKeyId);
    // Within retention the old cursor still verifies (with its keyId).
    expect(keyring.verify('page-token', signature, oldKeyId)).toBe('valid');
    // The new key signs fresh cursors.
    const fresh = keyring.sign('page-token');
    expect(fresh.keyId).toBe(rotatedKeyId);
    expect(keyring.verify('page-token', fresh.signature, rotatedKeyId)).toBe('valid');
    // Advancing past retention retires the old key: CURSOR_STALE.
    now = '2026-08-14T00:20:00.000Z';
    const retired = await keyring.retirePastRetention();
    expect(retired.removedKeyIds).toContain(oldKeyId);
    const outcome = keyring.verify('page-token', signature, oldKeyId);
    expect(outcome).toBe(CURSOR_STALE_EXPIRED);
    // A keyId that never existed is never 'expired' (fail closed).
    expect(keyring.verify('page-token', '00'.repeat(64), 'key-0000000000000000')).toBe(CURSOR_STALE_UNKNOWN_KEY);
  });

  it('persists retirement and reports the verification keyring across restarts', async () => {
    const { paths } = makeTempCorePaths();
    let now = '2026-08-14T00:00:00.000Z';
    const keyring = new ReviewCursorKeyring(paths, { clock: () => now, retentionMs: 60 * 60 * 1000 });
    await keyring.initialize();
    const oldKeyId = keyring.activeKeyId();
    const { signature } = keyring.sign('held-cursor');
    now = '2026-08-14T00:05:00.000Z';
    await keyring.rotate();
    // Restart mid-retention: the persisted retired keyring still verifies.
    const restarted = new ReviewCursorKeyring(paths, { clock: () => now, retentionMs: 60 * 60 * 1000 });
    await restarted.initialize();
    expect(restarted.verify('held-cursor', signature, oldKeyId)).toBe('valid');
    now = '2026-08-14T02:00:00.000Z';
    await restarted.retirePastRetention();
    expect(restarted.verify('held-cursor', signature, oldKeyId)).toBe(CURSOR_STALE_EXPIRED);
  });

  it('fails closed when an initialized keyring loses its active key file', async () => {
    const { paths } = makeTempCorePaths();
    const keyring = new ReviewCursorKeyring(paths, { clock: () => '2026-08-14T00:00:00.000Z' });
    await keyring.initialize();
    await rm(paths.cursorKeyringActiveFile(), { force: true });
    await expect(keyring.initialize()).rejects.toThrow(/拒绝静默重建|密钥/);
    let error: unknown = null;
    try {
      keyring.sign('any');
    } catch (e) {
      error = e;
    }
    expect(error).not.toBeNull();
  });

  it('fails closed on an unreadable (corrupt) active key file', async () => {
    const { paths } = makeTempCorePaths();
    const keyring = new ReviewCursorKeyring(paths, { clock: () => '2026-08-14T00:00:00.000Z' });
    await keyring.initialize();
    await writeFile(paths.cursorKeyringActiveFile(), '{ not json', 'utf8');
    await expect(keyring.initialize()).rejects.toThrow(/拒绝静默重建|密钥/);
    // The corrupt file is never silently replaced.
    const bytes = await readFile(paths.cursorKeyringActiveFile(), 'utf8');
    expect(bytes).toBe('{ not json');
  });

  it('never mints a key when the created marker exists but keys are missing', async () => {
    const { paths } = makeTempCorePaths();
    const keyring = new ReviewCursorKeyring(paths, { clock: () => '2026-08-14T00:00:00.000Z' });
    await keyring.initialize();
    await rm(paths.cursorKeyringRoot(), { recursive: true, force: true });
    await import('node:fs/promises').then((fs) => fs.mkdir(paths.cursorKeyringRoot(), { recursive: true }));
    await writeFile(join(paths.cursorKeyringRoot(), 'created.json'), '{"version":2,"createdAt":"2026-08-14T00:00:00.000Z"}', 'utf8');
    await expect(keyring.initialize()).rejects.toThrow(/拒绝静默重建|密钥/);
  });
});

export type { CursorVerifyOutcome };