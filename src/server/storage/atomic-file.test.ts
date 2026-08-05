// @vitest-environment node
/**
 * Atomic new-file write tests (plan Phase B Task 3 Step 1, verbatim case).
 *
 * Proves the write contract every committed file in the local state model
 * relies on (spec §8.2): same-directory unique temporary file, full flush and
 * close, atomic rename; a destination that already exists is never replaced
 * and never deleted; failures clean exactly their own temporary file.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeNewAtomic, writeReplaceAtomic } from './atomic-file';

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function tempPath(fileName: string): string {
  return join(makeTempDir('forge-core-atomic-'), fileName);
}

async function tempResidue(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.startsWith('.tmp-'));
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('writeNewAtomic', () => {
  it('never exposes a partially written destination', async () => {
    const path = tempPath('event.json');
    await writeNewAtomic(path, Buffer.from('{"ok":true}'));
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ok: true });
    await expect(writeNewAtomic(path, Buffer.from('replace'))).rejects.toMatchObject({
      code: 'FILE_EXISTS',
    });
  });

  it('writes the exact bytes and leaves no temporary residue behind', async () => {
    const dir = makeTempDir('forge-core-atomic-');
    const bytes = Buffer.from([0, 1, 2, 123, 250, 255]);
    await writeNewAtomic(join(dir, 'binary.bin'), bytes);
    expect(Buffer.compare(await readFile(join(dir, 'binary.bin')), bytes)).toBe(0);
    expect(await tempResidue(dir)).toEqual([]);
  });

  it('never deletes or alters an existing destination and cleans its own temp file', async () => {
    const dir = makeTempDir('forge-core-atomic-');
    const path = join(dir, 'keep.json');
    await writeFile(path, 'original', 'utf8');

    await expect(writeNewAtomic(path, Buffer.from('replacement'))).rejects.toMatchObject({
      code: 'FILE_EXISTS',
    });
    expect(await readFile(path, 'utf8')).toBe('original');
    expect(await tempResidue(dir)).toEqual([]);
  });

  it('creates missing parent directories', async () => {
    const dir = makeTempDir('forge-core-atomic-');
    const path = join(dir, 'nested/deep/file.json');
    await writeNewAtomic(path, Buffer.from('{}'));
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({});
  });

  it('keeps concurrent writers from exposing a torn file or temp residue', async () => {
    const dir = makeTempDir('forge-core-atomic-');
    const path = join(dir, 'race.json');
    const candidates = Array.from({ length: 8 }, (_, index) => `writer-${index}`);

    const results = await Promise.allSettled(
      candidates.map((payload) => writeNewAtomic(path, Buffer.from(payload))),
    );
    expect(results.filter((result) => result.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    for (const rejected of results.filter((result) => result.status === 'rejected')) {
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: 'FILE_EXISTS' });
    }
    // The committed destination is always exactly one writer's complete payload.
    expect(candidates).toContain(await readFile(path, 'utf8'));
    expect(await tempResidue(dir)).toEqual([]);
  });
});

describe('writeReplaceAtomic', () => {
  it('writes a brand-new file with the exact bytes', async () => {
    const dir = makeTempDir('forge-core-atomic-');
    const path = join(dir, 'scratch.txt');
    await writeReplaceAtomic(path, Buffer.from('first'));
    expect(await readFile(path, 'utf8')).toBe('first');
    expect(await tempResidue(dir)).toEqual([]);
  });

  it('overwrites an existing destination atomically and leaves no residue', async () => {
    const dir = makeTempDir('forge-core-atomic-');
    const path = join(dir, 'scratch.txt');
    await writeFile(path, 'original', 'utf8');
    await writeReplaceAtomic(path, Buffer.from('replacement'));
    expect(await readFile(path, 'utf8')).toBe('replacement');
    expect(await tempResidue(dir)).toEqual([]);
  });

  it('creates missing parent directories', async () => {
    const dir = makeTempDir('forge-core-atomic-');
    const path = join(dir, 'nested/deep/scratch.txt');
    await writeReplaceAtomic(path, Buffer.from('deep'));
    expect(await readFile(path, 'utf8')).toBe('deep');
  });

  it('cleans only its own temp file when the rename fails', async () => {
    const dir = makeTempDir('forge-core-atomic-');
    // A directory at the destination makes rename fail without ever
    // destroying the destination or leaking this call's temp file.
    const path = join(dir, 'blocked');
    mkdirSync(path);
    await writeFile(join(path, 'keep.txt'), 'kept', 'utf8');
    await expect(writeReplaceAtomic(path, Buffer.from('nope'))).rejects.toBeTruthy();
    expect(await readdir(path)).toEqual(['keep.txt']);
    expect(await tempResidue(dir)).toEqual([]);
  });

  it('keeps concurrent replacers consistent', async () => {
    const dir = makeTempDir('forge-core-atomic-');
    const path = join(dir, 'race.txt');
    const candidates = Array.from({ length: 8 }, (_, index) => `replacer-${index}`);
    await Promise.all(candidates.map((payload) => writeReplaceAtomic(path, Buffer.from(payload))));
    expect(candidates).toContain(await readFile(path, 'utf8'));
    expect(await tempResidue(dir)).toEqual([]);
  });
});
