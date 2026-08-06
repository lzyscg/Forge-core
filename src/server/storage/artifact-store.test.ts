// @vitest-environment node
/**
 * Append-only artifact store tests (plan Phase B Task 4, verbatim first case).
 *
 * Artifact versions live at `artifacts/vNNN/` (spec §8.1), each published
 * through a temporary sibling directory holding `meta.json` plus
 * `content.md`/`content.txt` and renamed into place only when complete. The
 * store allocates versions itself (max existing + 1) and never accepts a
 * caller-supplied version. Committed versions are never replaced; metadata
 * carries the uuid, version, title, source node, format, SHA-256 content hash
 * and creation time. Temporary residue is never listed, and a damaged
 * committed version fails loud (spec §8.3 isolation belongs to the list
 * layer).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  catalogWithOneTemplate,
  disposeAllTestRoots,
  validTaskRequest,
} from '../test-support';
import type { CorePaths } from './core-paths';
import { ArtifactStore, type ArtifactProposal } from './artifact-store';
import { TaskStore } from './task-store';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function artifactProposal(content: string): ArtifactProposal {
  return {
    title: `产物 ${content}`,
    content,
    sourceNodeId: randomUUID(),
    format: 'markdown',
  };
}

let paths: CorePaths;
let store: ArtifactStore;
let taskId: string;

beforeEach(async () => {
  const fixture = await catalogWithOneTemplate();
  paths = fixture.paths;
  const tasks = new TaskStore(paths, fixture.catalog);
  store = new ArtifactStore(paths);
  taskId = (await tasks.create(validTaskRequest())).id;
});

afterEach(() => {
  disposeAllTestRoots();
});

describe('ArtifactStore', () => {
  it('appends V1 and V2 without replacing content', async () => {
    const v1 = await store.publish(taskId, artifactProposal('first'));
    const v2 = await store.publish(taskId, artifactProposal('second'));
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect((await store.read(taskId, 1)).content).toBe('first');
  });

  it('allocates store-side versions and writes complete metadata atomically', async () => {
    const proposal = artifactProposal('正文内容');
    const published = await store.publish(taskId, proposal);
    await store.publish(taskId, artifactProposal('second'));
    await store.publish(taskId, artifactProposal('third'));

    expect(readdirSync(paths.taskArtifactsRoot(taskId)).sort()).toEqual([
      'v001',
      'v002',
      'v003',
    ]);
    const versionRoot = paths.taskArtifactVersionRoot(taskId, 1);
    const meta = JSON.parse(readFileSync(join(versionRoot, 'meta.json'), 'utf8'));
    expect(meta.id).toMatch(UUID_RE);
    expect(meta).toMatchObject({
      version: 1,
      title: proposal.title,
      sourceNodeId: proposal.sourceNodeId,
      format: 'markdown',
      contentHash: sha256('正文内容'),
    });
    expect(Number.isNaN(new Date(meta.createdAt).getTime())).toBe(false);
    expect(readFileSync(join(versionRoot, 'content.md'), 'utf8')).toBe('正文内容');
    // Published as one whole directory: no torn files or staging residue.
    expect(readdirSync(versionRoot).sort()).toEqual(['content.md', 'meta.json']);
    expect(
      readdirSync(paths.taskArtifactsRoot(taskId)).filter((name) => name.startsWith('.tmp-')),
    ).toEqual([]);
    expect(published).toEqual({
      id: meta.id,
      version: 1,
      title: proposal.title,
      files: [{ name: 'content.md', extract: 'content', content: '正文内容' }],
      sourceNodeId: proposal.sourceNodeId,
      createdAt: meta.createdAt,
      final: false,
    });
  });

  it('ignores a version supplied by the caller', async () => {
    const sneaky = { ...artifactProposal('only'), version: 99 } as unknown as ArtifactProposal;
    const published = await store.publish(taskId, sneaky);
    expect(published.version).toBe(1);
    expect(readdirSync(paths.taskArtifactsRoot(taskId))).toEqual(['v001']);
  });

  it('serializes concurrent publishes into intact distinct versions', async () => {
    const proposals = Array.from({ length: 6 }, (_, index) => artifactProposal(`content-${index}`));
    const published = await Promise.all(proposals.map((p) => store.publish(taskId, p)));

    expect(published.map((item) => item.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    const contents = new Set(proposals.map((p) => p.content));
    for (const item of published) {
      const stored = await store.read(taskId, item.version);
      expect(stored.content).toBe(item.files[0].content);
      expect(contents.has(stored.content)).toBe(true);
    }
    expect(
      readdirSync(paths.taskArtifactsRoot(taskId)).filter((name) => name.startsWith('.tmp-')),
    ).toEqual([]);
  });

  it('writes text-format artifacts as content.txt', async () => {
    await store.publish(taskId, { ...artifactProposal('plain'), format: 'text' });
    const versionRoot = paths.taskArtifactVersionRoot(taskId, 1);
    expect(readdirSync(versionRoot).sort()).toEqual(['content.txt', 'meta.json']);
    expect((await store.read(taskId, 1)).meta.format).toBe('text');
  });

  it('reads committed versions and rejects unknown ones without guessing', async () => {
    await store.publish(taskId, artifactProposal('first'));
    await expect(store.read(taskId, 2)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    await expect(store.read(taskId, 0)).rejects.toMatchObject({ code: 'CORE_PATH_INVALID' });
    expect(await store.list('no-such-task')).toEqual([]);
  });

  it('fails loud when committed content no longer matches its metadata hash', async () => {
    await store.publish(taskId, artifactProposal('first'));
    await appendFile(join(paths.taskArtifactVersionRoot(taskId, 1), 'content.md'), 'extra', 'utf8');

    await expect(store.read(taskId, 1)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
    await expect(store.list(taskId)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
  });

  it('fails loud when a committed version directory is damaged', async () => {
    await store.publish(taskId, artifactProposal('first'));
    writeFileSync(join(paths.taskArtifactVersionRoot(taskId, 1), 'meta.json'), '{corrupt', 'utf8');

    await expect(store.read(taskId, 1)).rejects.toMatchObject({ code: 'TASK_CORRUPTED' });
    // Damaged committed versions block further publishing instead of being skipped.
    await expect(store.publish(taskId, artifactProposal('second'))).rejects.toMatchObject({
      code: 'TASK_CORRUPTED',
    });
  });

  it('skips temporary staging directories and ignores malformed names', async () => {
    await store.publish(taskId, artifactProposal('first'));
    const artifactsRoot = paths.taskArtifactsRoot(taskId);
    const stagingDir = join(artifactsRoot, `.tmp-v002-${randomUUID()}`);
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, 'meta.json'), '{staging', 'utf8');
    writeFileSync(join(artifactsRoot, 'notes.txt'), 'irrelevant', 'utf8');

    const second = await store.publish(taskId, artifactProposal('second'));
    expect(second.version).toBe(2);
    const listed = await store.list(taskId);
    expect(listed.map((item) => item.meta.version)).toEqual([1, 2]);
  });

  it('rejects malformed proposals before touching disk', async () => {
    const base = artifactProposal('content');
    const invalid: unknown[] = [
      null,
      'not-an-object',
      { ...base, title: '' },
      { ...base, title: 42 },
      { ...base, content: 42 },
      { ...base, content: '' },
      { ...base, sourceNodeId: '' },
      { ...base, format: 'pdf' },
    ];
    for (const candidate of invalid) {
      await expect(
        store.publish(taskId, candidate as ArtifactProposal),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    // Nothing was committed.
    expect(readdirSync(paths.taskArtifactsRoot(taskId))).toEqual([]);
  });
});
