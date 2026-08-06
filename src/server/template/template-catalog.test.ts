// @vitest-environment node
/**
 * Template catalog tests (plan Phase B Task 2): startup isolation, public
 * contract mapping, explicit reload semantics and last-valid cache behavior.
 * Tests read the on-disk cache layout (hash directories, manifest.json,
 * current.json) directly to prove the managed cache contract.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CorePaths } from '../storage/core-paths';
import { TemplateCatalog } from './template-catalog';

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`__fixtures__/${name}`, import.meta.url));
}

/** Version-1 turn contract blocks; the committed fixtures stay legacy. */
const WRITER_CONTRACT_YAML = [
  'turnContract:',
  '  version: 1',
  '  production:',
  '    completionAction: finish_production',
  '    output:',
  '      formats: [markdown]',
  '      sources: [inline, workspace_file]',
  '  dispatch:',
  '    cardinality: single',
  '    allowedActions: [publish_artifact]',
  '    targets:',
  '      publish_artifact: reviewer',
  '    productionPackageRef: current',
  '',
].join('\n');

const REVIEWER_CONTRACT_YAML = [
  'turnContract:',
  '  version: 1',
  '  production:',
  '    completionAction: finish_production',
  '    output:',
  '      formats: [markdown, text]',
  '      sources: [inline, current_input_artifact]',
  '  dispatch:',
  '    cardinality: single',
  '    allowedActions: [send_message, submit_final_artifact]',
  '    targets:',
  '      send_message: writer',
  '    productionPackageRef: current',
  '',
].join('\n');

/** Upgrades a copied legacy fixture to the current turn contract in place. */
function appendContracts(dest: string): void {
  for (const [agentId, contract] of [
    ['writer', WRITER_CONTRACT_YAML],
    ['reviewer', REVIEWER_CONTRACT_YAML],
  ] as const) {
    const file = join(dest, `agents/${agentId}.yaml`);
    writeFileSync(
      file,
      `${readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').trimEnd()}\n${contract}`,
      'utf8',
    );
  }
}

function copyFixture(name: string, templateId: string, templateRoot: string): string {
  const dest = join(templateRoot, templateId);
  cpSync(fixturePath(name), dest, { recursive: true });
  appendContracts(dest);
  return dest;
}

async function makeCatalog(
  sources: Array<{ fixture: string; id: string }>,
): Promise<{ paths: CorePaths; catalog: TemplateCatalog }> {
  const dataRoot = makeTempDir('forge-core-t2c-data-');
  const templateRoot = makeTempDir('forge-core-t2c-templates-');
  for (const source of sources) {
    copyFixture(source.fixture, source.id, templateRoot);
  }
  const paths = CorePaths.create({ dataRoot, templateRoot });
  const catalog = new TemplateCatalog(paths);
  await catalog.initialize();
  return { paths, catalog };
}

function hashDirectories(paths: CorePaths, templateId: string): string[] {
  return readdirSync(join(paths.templateCacheRoot, templateId)).filter(
    (entry) => entry !== 'current.json' && !entry.startsWith('.tmp-'),
  );
}

function currentHash(paths: CorePaths, templateId: string): string {
  const raw = readFileSync(paths.templateCacheCurrentFile(templateId), 'utf8');
  return (JSON.parse(raw) as { versionHash: string }).versionHash;
}

function manifestCachedAt(paths: CorePaths, templateId: string, hash: string): string {
  const raw = readFileSync(join(paths.templateCacheVersionRoot(templateId, hash), 'manifest.json'), 'utf8');
  return (JSON.parse(raw) as { cachedAt: string }).cachedAt;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('TemplateCatalog', () => {
  it('initializes from a valid source and maps the public template contract', async () => {
    const { paths, catalog } = await makeCatalog([{ fixture: 'valid', id: 'test-template' }]);

    const summaries = catalog.list();
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary?.id).toBe('test-template');
    expect(summary?.name).toBe('双 Agent 协作模板');
    expect(summary?.agentCount).toBe(2);
    expect(summary?.status).toBe('valid');
    expect(summary?.version).toMatch(/^[0-9a-f]{12}$/);
    expect(summary?.version).toBe(currentHash(paths, 'test-template').slice(0, 12));
    expect(Number.isNaN(new Date(summary?.updatedAt ?? '').getTime())).toBe(false);

    const detail = catalog.get('test-template');
    expect(detail).toBeDefined();
    expect(detail?.inputFields.map((field) => field.id)).toEqual(['source-material', 'style-note']);
    expect(detail?.agents.map((agent) => agent.id)).toEqual(['writer', 'reviewer']);
    for (const agent of detail?.agents ?? []) {
      for (const skill of agent.skills) {
        expect(Object.keys(skill).sort()).toEqual(['description', 'id', 'name']);
      }
    }
    expect(detail?.routes).toEqual([
      { from: 'writer', to: 'reviewer', kind: 'artifact', label: '提交初稿' },
      { from: 'reviewer', to: 'writer', kind: 'message', label: '退回意见' },
    ]);
    expect(detail?.finalOutput).toEqual({ name: '终稿', format: 'markdown', submitters: ['reviewer'] });
    expect(hashDirectories(paths, 'test-template')).toHaveLength(1);
  });

  it('returns undefined for unknown template ids', async () => {
    const { catalog } = await makeCatalog([{ fixture: 'valid', id: 'known' }]);
    expect(catalog.get('unknown')).toBeUndefined();
    expect(catalog.getFrozen('unknown')).toBeUndefined();
  });

  it('reloads to a new version after content changes and keeps both cached versions', async () => {
    const { paths, catalog } = await makeCatalog([{ fixture: 'valid', id: 'test-template' }]);
    const v1 = catalog.get('test-template')?.version;
    const skillFile = join(paths.templateSource('test-template'), 'skills/style-guide/SKILL.md');
    writeFileSync(skillFile, `${readFileSync(skillFile, 'utf8')}\n- 新增约束。\n`, 'utf8');

    const reloaded = await catalog.reload('test-template');
    expect(reloaded.version).not.toBe(v1);
    expect(reloaded.status).toBe('valid');
    expect(catalog.get('test-template')).toEqual(reloaded);
    expect(hashDirectories(paths, 'test-template')).toHaveLength(2);
    expect(currentHash(paths, 'test-template').slice(0, 12)).toBe(reloaded.version);
  });

  it('reuses an existing hash directory when a previous version returns', async () => {
    const { paths, catalog } = await makeCatalog([{ fixture: 'valid', id: 'test-template' }]);
    const v1 = catalog.get('test-template')?.version;
    const hashV1 = currentHash(paths, 'test-template');
    const cachedAtV1 = manifestCachedAt(paths, 'test-template', hashV1);

    const skillFile = join(paths.templateSource('test-template'), 'skills/style-guide/SKILL.md');
    const original = readFileSync(skillFile, 'utf8');
    writeFileSync(skillFile, `${original}\n- 临时修改。\n`, 'utf8');
    await catalog.reload('test-template');
    writeFileSync(skillFile, original, 'utf8');

    const restored = await catalog.reload('test-template');
    expect(restored.version).toBe(v1);
    expect(hashDirectories(paths, 'test-template')).toHaveLength(2);
    expect(currentHash(paths, 'test-template')).toBe(hashV1);
    // The pre-existing hash directory was reused, never rewritten.
    expect(manifestCachedAt(paths, 'test-template', hashV1)).toBe(cachedAtV1);
  });

  it('never replaces the cached version when an explicit reload fails', async () => {
    const { paths, catalog } = await makeCatalog([{ fixture: 'valid', id: 'test-template' }]);
    const before = catalog.get('test-template');
    const hashBefore = currentHash(paths, 'test-template');
    writeFileSync(join(paths.templateSource('test-template'), 'pipeline.yaml'), 'routes: [not-a-map]\n', 'utf8');

    await expect(catalog.reload('test-template')).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID',
      location: 'pipeline.yaml',
    });
    expect(catalog.get('test-template')).toEqual(before);
    expect(currentHash(paths, 'test-template')).toBe(hashBefore);
  });

  it('isolates a broken template without hiding healthy ones', async () => {
    const { catalog } = await makeCatalog([
      { fixture: 'valid', id: 'good' },
      { fixture: 'invalid-route', id: 'bad' },
    ]);
    expect(catalog.list().map((summary) => summary.id)).toEqual(['good']);
    expect(catalog.get('bad')).toBeUndefined();
    expect(catalog.get('good')?.status).toBe('valid');
  });

  it('serves the last valid cache when the source breaks before startup', async () => {
    const { paths, catalog } = await makeCatalog([{ fixture: 'valid', id: 'test-template' }]);
    const v1 = catalog.get('test-template')?.version;
    writeFileSync(
      join(paths.templateSource('test-template'), 'pipeline.yaml'),
      'agents: 12\nroutes: []\nfinalOutput:\n  submitters: []\n',
      'utf8',
    );

    const restarted = new TemplateCatalog(paths);
    await restarted.initialize();
    const detail = restarted.get('test-template');
    expect(detail?.status).toBe('invalid_using_cache');
    expect(detail?.version).toBe(v1);
    expect(restarted.list()[0]?.status).toBe('invalid_using_cache');
    expect(restarted.getDiagnostic('test-template')).not.toBeNull();
  });

  it('serves the last valid cache when the source directory disappears', async () => {
    const { paths, catalog } = await makeCatalog([{ fixture: 'valid', id: 'test-template' }]);
    const v1 = catalog.get('test-template')?.version;
    rmSync(paths.templateSource('test-template'), { recursive: true, force: true });

    const restarted = new TemplateCatalog(paths);
    await restarted.initialize();
    expect(restarted.get('test-template')?.status).toBe('invalid_using_cache');
    expect(restarted.get('test-template')?.version).toBe(v1);
  });

  it('normalizes legacy cached manifests with scalar targets into candidate sets', async () => {
    const { paths, catalog } = await makeCatalog([{ fixture: 'valid', id: 'test-template' }]);
    const cacheDir = join(paths.templateCacheRoot, 'test-template');
    const hash = readdirSync(cacheDir).find((name) => /^[0-9a-f]{64}$/.test(name));
    expect(hash).toBeDefined();
    // Rewrite the cached manifest with a pre-change scalar target (the shape
    // written by older versions); invalid_using_cache must normalize it.
    const manifestPath = join(cacheDir, hash as string, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      agents: Array<{
        id: string;
        turnContract: { dispatch: { targets: Record<string, unknown> } } | null;
      }>;
    };
    const writer = manifest.agents.find((agent) => agent.id === 'writer');
    if (writer?.turnContract) {
      writer.turnContract.dispatch.targets.publish_artifact = 'reviewer';
    }
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

    // Break the source so the catalog boots from the legacy cache.
    writeFileSync(
      join(paths.templateSource('test-template'), 'pipeline.yaml'),
      'agents: 12\nroutes: []\nfinalOutput:\n  submitters: []\n',
      'utf8',
    );
    const restarted = new TemplateCatalog(paths);
    await restarted.initialize();
    expect(restarted.get('test-template')?.status).toBe('invalid_using_cache');
    const frozen = restarted.getFrozen('test-template');
    expect(frozen?.agents.find((agent) => agent.id === 'writer')?.turnContract?.dispatch.targets).toEqual({
      publish_artifact: ['reviewer'],
    });
  });

  it('recovers the cached version when current.json is corrupt', async () => {
    const { paths, catalog } = await makeCatalog([{ fixture: 'valid', id: 'test-template' }]);
    const v1 = catalog.get('test-template')?.version;
    writeFileSync(
      join(paths.templateSource('test-template'), 'template.yaml'),
      'name: [unclosed\n',
      'utf8',
    );
    writeFileSync(paths.templateCacheCurrentFile('test-template'), 'not-json{', 'utf8');

    const restarted = new TemplateCatalog(paths);
    await restarted.initialize();
    expect(restarted.get('test-template')?.status).toBe('invalid_using_cache');
    expect(restarted.get('test-template')?.version).toBe(v1);
  });

  it('ignores .tmp- leftovers in the cache root at startup', async () => {
    const { paths, catalog } = await makeCatalog([{ fixture: 'valid', id: 'test-template' }]);
    mkdirSync(join(paths.templateCacheRoot, '.tmp-stage-leftover'), { recursive: true });
    mkdirSync(join(paths.templateCacheRoot, 'test-template', '.tmp-partial'), { recursive: true });

    const restarted = new TemplateCatalog(paths);
    await restarted.initialize();
    expect(restarted.list()).toHaveLength(1);
    expect(restarted.get('test-template')?.status).toBe('valid');
  });

  it('rejects reload for a template the catalog has never seen', async () => {
    const { catalog } = await makeCatalog([{ fixture: 'valid', id: 'known' }]);
    await expect(catalog.reload('unknown')).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });

  it('rejects reload when the source directory is missing but the template is cached', async () => {
    const { paths, catalog } = await makeCatalog([{ fixture: 'valid', id: 'test-template' }]);
    rmSync(paths.templateSource('test-template'), { recursive: true, force: true });
    await expect(catalog.reload('test-template')).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
    // The cached version stays usable.
    expect(catalog.get('test-template')?.status).toBe('valid');
  });
});
