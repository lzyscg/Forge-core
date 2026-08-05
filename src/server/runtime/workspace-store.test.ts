// @vitest-environment node
/**
 * Per-agent temporary workspace store tests (plan Phase E Task 1 Step 1).
 *
 * The workspace is the agent's file-only scratch area under
 * `tasks/<id>/workspaces/<agentId>/` (plan Global Constraint 6): three file
 * tools, no shell. Every failure is a typed, non-retryable RuntimeFailure
 * with a stable code and a presentable Chinese message. Limits: single file
 * ≤64 KiB (bytes, not chars), ≤32 files per agent, SAFE_SEGMENT segments,
 * depth ≤4, path ≤512. Path safety is checked twice — statically on the
 * resolved path and again after `realpath` — so symlink escapes are rejected
 * on both read and write.
 */
import { mkdir, readFile as fsReadFile, rm, symlink, writeFile as fsWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuntimeFailure } from './agent-runtime';
import { disposeAllTestRoots, makeTempCorePaths } from '../test-support';
import type { CorePaths } from '../storage/core-paths';
import { WorkspaceStore, WORKSPACE_ERROR_CODES, WORKSPACE_LIMITS } from './workspace-store';

let paths: CorePaths;
let store: WorkspaceStore;
const outsideRoots: string[] = [];

const TASK = 'task-1';
const AGENT = 'agent-alpha';

beforeEach(() => {
  ({ paths } = makeTempCorePaths('forge-core-workspace-'));
  store = new WorkspaceStore(paths);
});

afterEach(async () => {
  while (outsideRoots.length > 0) {
    const root = outsideRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
  disposeAllTestRoots();
});

async function makeOutsideDir(suffix: string): Promise<string> {
  const dir = join(tmpdir(), `forge-core-ws-outside-${process.pid}-${suffix}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  outsideRoots.push(dir);
  return dir;
}

function expectWorkspaceFailure(code: keyof typeof WORKSPACE_ERROR_CODES) {
  return expect.objectContaining({
    name: 'RuntimeFailure',
    code: WORKSPACE_ERROR_CODES[code],
    retryable: false,
  });
}

describe('WorkspaceStore', () => {
  it('round-trips a written file and reports path and byte size', async () => {
    const written = await store.writeFile(TASK, AGENT, 'notes/draft.md', '初稿正文');
    expect(written).toEqual({ path: 'notes/draft.md', bytes: 12 });
    expect(await store.readFile(TASK, AGENT, 'notes/draft.md')).toBe('初稿正文');
    // The file physically lives under the agent workspace root.
    const onDisk = await fsReadFile(
      join(paths.taskWorkspaceRoot(TASK, AGENT), 'notes/draft.md'),
      'utf8',
    );
    expect(onDisk).toBe('初稿正文');
  });

  it('keeps the workspaces of different agents and tasks separate', async () => {
    await store.writeFile(TASK, AGENT, 'a.txt', 'alpha');
    await store.writeFile(TASK, 'agent-beta', 'a.txt', 'beta');
    await store.writeFile('task-2', AGENT, 'a.txt', 'other-task');
    expect(await store.readFile(TASK, AGENT, 'a.txt')).toBe('alpha');
    expect(await store.readFile(TASK, 'agent-beta', 'a.txt')).toBe('beta');
    expect(await store.readFile('task-2', AGENT, 'a.txt')).toBe('other-task');
  });

  it('overwrites an existing file without counting it twice', async () => {
    await store.writeFile(TASK, AGENT, 'draft.md', 'v1');
    await store.writeFile(TASK, AGENT, 'draft.md', 'v2');
    expect(await store.readFile(TASK, AGENT, 'draft.md')).toBe('v2');
    expect(await store.listFiles(TASK, AGENT)).toEqual([{ path: 'draft.md', bytes: 2 }]);
  });

  it('lists files recursively sorted by path', async () => {
    await store.writeFile(TASK, AGENT, 'z-late.txt', 'z');
    await store.writeFile(TASK, AGENT, 'deep/nested/b.txt', 'b');
    await store.writeFile(TASK, AGENT, 'a-first.txt', 'a');
    await store.writeFile(TASK, AGENT, 'deep/a.txt', 'a2');
    expect(await store.listFiles(TASK, AGENT)).toEqual([
      { path: 'a-first.txt', bytes: 1 },
      { path: 'deep/a.txt', bytes: 2 },
      { path: 'deep/nested/b.txt', bytes: 1 },
      { path: 'z-late.txt', bytes: 1 },
    ]);
  });

  it('lists an empty or never-created workspace as empty', async () => {
    expect(await store.listFiles(TASK, AGENT)).toEqual([]);
  });

  it('rejects unsafe paths statically with WORKSPACE_PATH_UNSAFE', async () => {
    const unsafePaths = [
      '../escape.txt',
      'a/../../escape.txt',
      './a.txt',
      'a/../b.txt',
      '/etc/passwd',
      '',
      '.',
      '..',
      'a//b.txt',
      'a/b.txt/',
      '.hidden',
      'a/.hidden/b.txt',
      'a\0b.txt',
      'very/deeply/nested/path/exceeding-depth.txt',
      'x'.repeat(513),
    ];
    for (const relPath of unsafePaths) {
      await expect(store.writeFile(TASK, AGENT, relPath, 'x')).rejects.toEqual(
        expectWorkspaceFailure('WORKSPACE_PATH_UNSAFE'),
      );
      await expect(store.readFile(TASK, AGENT, relPath)).rejects.toEqual(
        expectWorkspaceFailure('WORKSPACE_PATH_UNSAFE'),
      );
    }
    expect(await store.listFiles(TASK, AGENT)).toEqual([]);
  });

  it('accepts paths at the depth and length limits', async () => {
    await store.writeFile(TASK, AGENT, 'a/b/c/d.txt', 'depth-4');
    expect(await store.readFile(TASK, AGENT, 'a/b/c/d.txt')).toBe('depth-4');
    // Total length near the 512 limit, split into components that stay
    // within the filesystem's per-component bound.
    const longPath = `${'x'.repeat(255)}/${'y'.repeat(251)}.txt`;
    expect(longPath.length).toBeLessThanOrEqual(WORKSPACE_LIMITS.maxPathLength);
    await store.writeFile(TASK, AGENT, longPath, 'long');
    expect(await store.readFile(TASK, AGENT, longPath)).toBe('long');
  });

  it('rejects files over the byte limit, counting multi-byte bytes not chars', async () => {
    // 21845 × '中' (3 bytes each) + 'a' = exactly 65536 bytes = limit.
    const atLimit = '中'.repeat(21845) + 'a';
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(WORKSPACE_LIMITS.maxFileBytes);
    const written = await store.writeFile(TASK, AGENT, 'limit.txt', atLimit);
    expect(written.bytes).toBe(WORKSPACE_LIMITS.maxFileBytes);
    expect(await store.readFile(TASK, AGENT, 'limit.txt')).toBe(atLimit);

    // One extra multi-byte char pushes past the limit.
    const overLimit = '中'.repeat(21846);
    expect(Buffer.byteLength(overLimit, 'utf8')).toBeGreaterThan(WORKSPACE_LIMITS.maxFileBytes);
    await expect(store.writeFile(TASK, AGENT, 'over.txt', overLimit)).rejects.toEqual(
      expectWorkspaceFailure('WORKSPACE_FILE_TOO_LARGE'),
    );
  });

  it('rejects the 33rd file but still allows overwriting at the limit', async () => {
    for (let index = 0; index < WORKSPACE_LIMITS.maxFilesPerAgent; index += 1) {
      await store.writeFile(TASK, AGENT, `file-${String(index).padStart(2, '0')}.txt`, 'x');
    }
    await expect(store.writeFile(TASK, AGENT, 'file-33.txt', 'x')).rejects.toEqual(
      expectWorkspaceFailure('WORKSPACE_TOO_MANY_FILES'),
    );
    // Overwriting an existing file does not grow the count.
    await store.writeFile(TASK, AGENT, 'file-00.txt', 'replaced');
    expect(await store.readFile(TASK, AGENT, 'file-00.txt')).toBe('replaced');
    expect(await store.listFiles(TASK, AGENT)).toHaveLength(WORKSPACE_LIMITS.maxFilesPerAgent);
  });

  it('reads a missing file as WORKSPACE_FILE_NOT_FOUND', async () => {
    await expect(store.readFile(TASK, AGENT, 'missing.txt')).rejects.toEqual(
      expectWorkspaceFailure('WORKSPACE_FILE_NOT_FOUND'),
    );
    await store.writeFile(TASK, AGENT, 'dir/inner.txt', 'x');
    await expect(store.readFile(TASK, AGENT, 'dir')).rejects.toEqual(
      expectWorkspaceFailure('WORKSPACE_FILE_NOT_FOUND'),
    );
  });

  it('rejects symlink escapes on read through the realpath double-check', async () => {
    const outsideDir = await makeOutsideDir('read');
    const outsideFile = join(outsideDir, 'secret.txt');
    await fsWriteFile(outsideFile, 'secret', 'utf8');
    const root = paths.taskWorkspaceRoot(TASK, AGENT);
    await mkdir(root, { recursive: true });
    await symlink(outsideFile, join(root, 'innocent.txt'));
    await symlink(outsideDir, join(root, 'innocent-dir'));

    await expect(store.readFile(TASK, AGENT, 'innocent.txt')).rejects.toEqual(
      expectWorkspaceFailure('WORKSPACE_PATH_UNSAFE'),
    );
    // Listing never follows or reports symlinks.
    expect(await store.listFiles(TASK, AGENT)).toEqual([]);
  });

  it('rejects writes through symlinked directories escaping the workspace', async () => {
    const outsideDir = await makeOutsideDir('write');
    const root = paths.taskWorkspaceRoot(TASK, AGENT);
    await mkdir(root, { recursive: true });
    await symlink(outsideDir, join(root, 'link'));

    await expect(store.writeFile(TASK, AGENT, 'link/escape.txt', 'x')).rejects.toEqual(
      expectWorkspaceFailure('WORKSPACE_PATH_UNSAFE'),
    );
    await expect(fsReadFile(join(outsideDir, 'escape.txt'))).rejects.toBeTruthy();
  });

  it('keeps symlinks inside the workspace readable', async () => {
    await store.writeFile(TASK, AGENT, 'real.txt', 'real');
    const root = paths.taskWorkspaceRoot(TASK, AGENT);
    await symlink(join(root, 'real.txt'), join(root, 'alias.txt'));
    expect(await store.readFile(TASK, AGENT, 'alias.txt')).toBe('real');
  });

  it('never exposes absolute paths or raw causes in failure messages', async () => {
    const failures: RuntimeFailure[] = [];
    await store.readFile(TASK, AGENT, '../escape').catch((error: RuntimeFailure) => {
      failures.push(error);
    });
    await store.readFile(TASK, AGENT, 'missing.txt').catch((error: RuntimeFailure) => {
      failures.push(error);
    });
    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(RuntimeFailure);
      expect(failure.retryable).toBe(false);
      expect(failure.message.length).toBeGreaterThan(0);
      expect(failure.message).not.toContain('/');
      expect(failure.message).not.toContain('ENOENT');
    }
  });
});
