/**
 * Task 9: installation-persistent cursor signing keyring (spec §14.2, design
 * §19.1).
 *
 * The keyring lives under the data root (`cursor-keys/`, CorePaths helpers):
 * - `active.json` — the current signing key `{version, keyId, secret, createdAt}`;
 * - `retired.json` — retired keys kept through the frozen retention window so
 *   held cursors keep verifying across rotation;
 * - `created.json` — the durable bootstrap marker. A marker WITHOUT readable
 *   key material means an initialized installation lost its files: the keyring
 *   fails closed and NEVER silently mints a replacement (which would
 *   invalidate every cursor held by clients).
 *
 * Verification outcomes: `valid` / `invalid` (tamper) / `CURSOR_STALE`
 * (`signing_key_retired` — the keyId left the retention window) /
 * `CURSOR_STALE`-equivalent for an unknown keyId (fail closed; spec §14.2
 * allows CURSOR_STALE for key retirement or corruption, never a guess).
 *
 * This is the v2 replacement for the v1 in-memory `createTaskLocalCursorSigner`
 * (projection-service.ts) — the v1 signer is untouched and stays v1-only.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CorePaths } from './core-paths';
import { StorageError, STORAGE_ERROR_CODES, writeNewAtomicDurable, writeReplaceAtomicDurable, syncDirectory } from './atomic-file';
import { canonicalJson } from '../structured-slots/canonical-json';

/** Stable CURSOR_STALE diagnostics (spec §14.2). */
export const CURSOR_STALE_EXPIRED = 'CURSOR_STALE(signing_key_retired)';

export const CURSOR_STALE_UNKNOWN_KEY = 'CURSOR_STALE(unknown_key_id)';

export type CursorVerifyOutcome = 'valid' | 'invalid' | typeof CURSOR_STALE_EXPIRED | typeof CURSOR_STALE_UNKNOWN_KEY;

interface ActiveKeyFileV2 {
  version: 2;
  keyId: string;
  secret: string;
  createdAt: string;
}

interface RetiredKeyFileV2 {
  version: 2;
  retired: Array<{ keyId: string; secret: string; createdAt: string; retiredAt: string }>;
}

function keyringFailure(message: string): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.TASK_CORRUPTED,
    message,
    null,
    '检查安装目录 cursor-keys/ 下的密钥文件。',
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultClock(): string {
  return new Date().toISOString();
}

export interface ReviewCursorKeyringOptions {
  /** Injectable wall clock (ISO 8601); tests freeze time. */
  clock?: () => string;
  /** Frozen retention window for retired verification keys (spec §14.2). */
  retentionMs?: number;
}

export class ReviewCursorKeyring {
  private readonly paths: CorePaths;

  private readonly clock: () => string;

  private readonly retentionMs: number;

  private active: ActiveKeyFileV2 | null = null;

  private retired: RetiredKeyFileV2 | null = null;

  constructor(paths: CorePaths, options: ReviewCursorKeyringOptions = {}) {
    this.paths = paths;
    this.clock = options.clock ?? defaultClock;
    this.retentionMs = options.retentionMs ?? 30 * 24 * 60 * 60 * 1000;
  }

  /**
   * Bootstrap/load: creates the durable keyring on FIRST boot (marker absent);
   * on every later boot loads and validates the persisted keys. A marker
   * without readable key material fails closed.
   */
  async initialize(): Promise<void> {
    const marker = await this.readMarker();
    if (marker === null) {
      if (await this.fileExists(this.paths.cursorKeyringActiveFile()) || await this.fileExists(this.paths.cursorKeyringRetiredFile())) {
        throw keyringFailure('cursor 密钥目录存在但缺少初始化标记，无法判定安装状态，拒绝静默重建。');
      }
      await this.mintFresh();
      return;
    }
    const active = await this.readActive();
    const retired = await this.readRetired();
    if (active === null || retired === null) {
      // A failed re-initialize must not leave a stale in-memory key behind:
      // cursors signed with a key whose durable file vanished could never
      // verify after a restart — fail closed.
      this.active = null;
      this.retired = null;
      throw keyringFailure('cursor 密钥文件缺失或不可读：拒绝静默重建（会使所有已发游标失效）。');
    }
    this.active = active;
    this.retired = retired;
  }

  /** The keyId of the current signing key (throws before initialize). */
  activeKeyId(): string {
    if (this.active === null) {
      throw keyringFailure('cursor 密钥环尚未初始化。');
    }
    return this.active.keyId;
  }

  /**
   * Signs a canonical payload with the ACTIVE key and stamps keyId
   * (SnapshotCursorV2 `keyId` + `token`; spec §14.2).
   */
  sign(payload: string): { keyId: string; signature: string } {
    if (this.active === null) {
      throw keyringFailure('cursor 密钥环尚未初始化。');
    }
    return {
      keyId: this.active.keyId,
      signature: createHmac('sha256', Buffer.from(this.active.secret, 'hex')).update(payload).digest('hex'),
    };
  }

  /**
   * Verifies a cursor signature under the named key. Retired keys inside the
   * retention window still verify; past retention they answer
   * CURSOR_STALE(signing_key_retired); unknown keyIds fail closed.
   */
  verify(payload: string, signature: string, keyId: string): CursorVerifyOutcome {
    if (this.active === null) {
      throw keyringFailure('cursor 密钥环尚未初始化。');
    }
    const secret = this.secretOf(keyId);
    if (secret === null) {
      return CURSOR_STALE_UNKNOWN_KEY;
    }
    if (!this.withinRetention(keyId)) {
      return CURSOR_STALE_EXPIRED;
    }
    const expected = createHmac('sha256', Buffer.from(secret, 'hex')).update(payload).digest('hex');
    return expected === signature ? 'valid' : 'invalid';
  }

  /**
   * Rotates the signing key: the active key moves to the retired verification
   * keyring (frozen retention) and a fresh active key is minted durably.
   */
  async rotate(): Promise<{ keyId: string }> {
    if (this.active === null) {
      throw keyringFailure('cursor 密钥环尚未初始化。');
    }
    await this.retirePastRetention();
    const retired = this.retired ?? { version: 2, retired: [] };
    retired.retired.push({ ...this.active, retiredAt: this.clock() });
    const fresh = this.newKey();
    await this.persistRetired(retired);
    await this.persistActive(fresh);
    this.retired = retired;
    this.active = fresh;
    return { keyId: fresh.keyId };
  }

  /**
   * Retires key material whose verification window has fully elapsed; returns
   * the affected keyIds. Retired entries are kept as TOMBSTONES (they are
   * never purged): a cursor held past retention must deterministically answer
   * CURSOR_STALE(signing_key_retired) — never the ambiguous unknown-key
   * outcome. The retention window is a verification window, not a deletion
   * policy; tombstone growth is bounded by the rotation rate.
   */
  async retirePastRetention(): Promise<{ removedKeyIds: string[] }> {
    if (this.retired === null) {
      return { removedKeyIds: [] };
    }
    const now = Date.parse(this.clock());
    const removedKeyIds = this.retired.retired
      .filter((entry) => now - Date.parse(entry.retiredAt) > this.retentionMs)
      .map((entry) => entry.keyId);
    if (removedKeyIds.length === 0) {
      return { removedKeyIds };
    }
    // Persist the (unchanged) retired set durably so the tombstone state
    // survives restarts; entries past retention simply answer STALE from now on.
    await this.persistRetired(this.retired);
    return { removedKeyIds };
  }

  /** The active keyring for diagnostics (Task 11 read API). */
  keyringState(): { activeKeyId: string; retiredKeyIds: string[] } {
    return {
      activeKeyId: this.active?.keyId ?? '',
      retiredKeyIds: (this.retired?.retired ?? []).map((entry) => entry.keyId),
    };
  }

  /* ------------------------- persistence ------------------------- */

  private newKey(): ActiveKeyFileV2 {
    return {
      version: 2,
      keyId: `key-${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      secret: randomBytes(32).toString('hex'),
      createdAt: this.clock(),
    };
  }

  private async mintFresh(): Promise<void> {
    const root = this.paths.cursorKeyringRoot();
    await mkdir(root, { recursive: true });
    const fresh = this.newKey();
    const retired: RetiredKeyFileV2 = { version: 2, retired: [] };
    await writeNewAtomicDurable(this.paths.cursorKeyringActiveFile(), Buffer.from(canonicalJson(fresh), 'utf8'));
    await writeNewAtomicDurable(this.paths.cursorKeyringRetiredFile(), Buffer.from(canonicalJson(retired), 'utf8'));
    const marker = { version: 2, createdAt: this.clock() };
    await writeNewAtomicDurable(this.paths.cursorKeyringCreatedMarkerFile(), Buffer.from(canonicalJson(marker), 'utf8'));
    await syncDirectory(root);
    this.active = fresh;
    this.retired = retired;
  }

  private async persistActive(active: ActiveKeyFileV2): Promise<void> {
    await writeReplaceAtomicDurable(this.paths.cursorKeyringActiveFile(), Buffer.from(canonicalJson(active), 'utf8'));
    await syncDirectory(this.paths.cursorKeyringRoot());
  }

  private async persistRetired(retired: RetiredKeyFileV2): Promise<void> {
    await writeReplaceAtomicDurable(this.paths.cursorKeyringRetiredFile(), Buffer.from(canonicalJson(retired), 'utf8'));
    await syncDirectory(this.paths.cursorKeyringRoot());
  }

  private secretOf(keyId: string): string | null {
    if (this.active !== null && this.active.keyId === keyId) {
      return this.active.secret;
    }
    for (const entry of this.retired?.retired ?? []) {
      if (entry.keyId === keyId) {
        return entry.secret;
      }
    }
    return null;
  }

  private withinRetention(keyId: string): boolean {
    if (this.active !== null && this.active.keyId === keyId) {
      return true;
    }
    const now = Date.parse(this.clock());
    const entry = (this.retired?.retired ?? []).find((candidate) => candidate.keyId === keyId);
    if (entry === undefined) {
      return false;
    }
    // Inside the frozen retention window the key still verifies; past the
    // window the tombstone answers STALE (the material is no longer relevant).
    return now - Date.parse(entry.retiredAt) <= this.retentionMs;
  }

  private async readMarker(): Promise<{ version: number; createdAt: string } | null> {
    try {
      const value = JSON.parse(await readFile(this.paths.cursorKeyringCreatedMarkerFile(), 'utf8')) as Record<string, unknown>;
      if (isPlainObject(value) && value.version === 2 && typeof value.createdAt === 'string') {
        return { version: 2, createdAt: value.createdAt };
      }
      throw keyringFailure('cursor 密钥初始化标记格式无效。');
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      return null; // absent
    }
  }

  private async readActive(): Promise<ActiveKeyFileV2 | null> {
    try {
      const value = JSON.parse(await readFile(this.paths.cursorKeyringActiveFile(), 'utf8')) as Record<string, unknown>;
      if (
        !isPlainObject(value) ||
        value.version !== 2 ||
        typeof value.keyId !== 'string' ||
        !/^key-[0-9a-f]{16}$/.test(value.keyId) ||
        typeof value.secret !== 'string' ||
        !/^[0-9a-f]{64}$/.test(value.secret) ||
        typeof value.createdAt !== 'string'
      ) {
        throw keyringFailure('cursor 活动密钥文件格式无效。');
      }
      return value as unknown as ActiveKeyFileV2;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      return null; // missing
    }
  }

  private async readRetired(): Promise<RetiredKeyFileV2 | null> {
    try {
      const value = JSON.parse(await readFile(this.paths.cursorKeyringRetiredFile(), 'utf8')) as Record<string, unknown>;
      if (!isPlainObject(value) || value.version !== 2 || !Array.isArray(value.retired)) {
        throw keyringFailure('cursor 退役密钥文件格式无效。');
      }
      for (const entry of value.retired as unknown[]) {
        const record = entry as Record<string, unknown>;
        if (
          !isPlainObject(record) ||
          typeof record.keyId !== 'string' ||
          !/^key-[0-9a-f]{16}$/.test(record.keyId) ||
          typeof record.secret !== 'string' ||
          !/^[0-9a-f]{64}$/.test(record.secret) ||
          typeof record.createdAt !== 'string' ||
          typeof record.retiredAt !== 'string'
        ) {
          throw keyringFailure('cursor 退役密钥文件格式无效。');
        }
      }
      return value as unknown as RetiredKeyFileV2;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      return null; // missing
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await readFile(path);
      return true;
    } catch {
      return false;
    }
  }
}
