/**
 * Managed template cache (plan Phase B Task 2 Step 4).
 *
 * Layout under the data root, never inside the user-owned source root:
 *
 *   template-cache/<template-id>/<version-hash>/   full validated copy
 *     template.yaml, pipeline.yaml, agents/, skills/, prompts/, manifest.json
 *   template-cache/<template-id>/current.json      atomic current-version pointer
 *
 * Replacement is validate-copy-validate: load the source, copy it into a
 * `.tmp-*` staging sibling, reopen and revalidate the copy, then publish the
 * complete directory with one rename and only afterwards repoint the atomic
 * `current.json`. An existing hash directory is reused as-is and never
 * rewritten. Failures clean their own staging and never touch `current.json`;
 * startup ignores `.tmp-*` residue. The local temp+rename helpers here are
 * private to the cache — the shared `writeNewAtomic` with FILE_EXISTS
 * semantics belongs to plan Task 3.
 */
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CorePaths } from '../storage/core-paths';
import { loadTemplateDirectory } from './template-loader';
import { TEMPLATE_ERROR_CODES, TemplateError, type FrozenAgentConfig, type FrozenTemplate } from './template-schema';

const TMP_PREFIX = '.tmp-';

const HASH_DIRECTORY = /^[0-9a-f]{64}$/;

export interface CachedVersion {
  frozen: FrozenTemplate;
  cachedAt: string;
  versionRoot: string;
}

interface ManifestJson extends FrozenTemplate {
  cachedAt: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Writes one JSON file via same-directory temp + full close + atomic rename. */
async function writeJsonAtomic(directory: string, fileName: string, payload: unknown): Promise<void> {
  const tempFile = join(directory, `${TMP_PREFIX}${fileName}-${randomUUID()}`);
  try {
    const handle = await open(tempFile, 'wx');
    try {
      await handle.writeFile(JSON.stringify(payload), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempFile, join(directory, fileName));
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Copies the load-relevant files of a template directory (skips dotfiles).
 * Every top-level entry is copied: the loader reads whatever the agent YAML
 * declares (skills/, prompts/, gates/, …), so the cache copy must not assume a
 * fixed directory list — a template that declares a `gate.validator` under
 * `gates/` needs that directory in the cached copy too (plan 2026-08-07 Phase
 * 4 deviation: the previous hardcoded agents/skills/prompts list dropped it).
 */
async function copyTemplateFiles(sourceDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (entry.isDirectory()) {
      await copyTree(join(sourceDir, entry.name), join(destDir, entry.name));
    } else if (entry.isFile()) {
      await copyFile(join(sourceDir, entry.name), join(destDir, entry.name));
    }
  }
}

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (entry.isDirectory()) {
      await copyTree(join(from, entry.name), join(to, entry.name));
    } else if (entry.isFile()) {
      await copyFile(join(from, entry.name), join(to, entry.name));
    }
  }
}

function isManifestFrozen(value: unknown): value is ManifestJson {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const manifest = value as Record<string, unknown>;
  return (
    typeof manifest.id === 'string' &&
    typeof manifest.versionHash === 'string' &&
    typeof manifest.cachedAt === 'string' &&
    Array.isArray(manifest.agents)
  );
}

/**
 * Normalizes legacy cached manifests (plan 2026-08-06): pre-change manifests
 * store dispatch targets as scalar ids; coerce them to one-element candidate
 * sets so downstream consumers (the committer's includes check, the turn
 * checklist) always see arrays — a raw scalar would break
 * `String.prototype.includes` substring semantics.
 */
function normalizeManifestTargets(frozen: FrozenTemplate): FrozenTemplate {
  return {
    ...frozen,
    agents: frozen.agents.map((agent) => {
      const contract = agent.turnContract;
      if (contract === null) {
        return agent;
      }
      const targets: NonNullable<FrozenAgentConfig['turnContract']>['dispatch']['targets'] = {};
      for (const [intent, value] of Object.entries(contract.dispatch.targets)) {
        if (typeof value === 'string') {
          targets[intent as keyof typeof targets] = [value];
        } else if (Array.isArray(value)) {
          targets[intent as keyof typeof targets] = value as string[];
        }
      }
      return {
        ...agent,
        turnContract: { ...contract, dispatch: { ...contract.dispatch, targets } },
      };
    }),
  };
}

async function readManifest(versionRoot: string): Promise<CachedVersion | null> {
  try {
    const raw = await readFile(join(versionRoot, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(raw) as unknown;
    if (!isManifestFrozen(manifest)) {
      return null;
    }
    const { cachedAt, ...frozen } = manifest;
    return { frozen: normalizeManifestTargets(frozen), cachedAt, versionRoot };
  } catch {
    return null;
  }
}

/** Reads the atomic current-version pointer; corrupt pointers yield null. */
export async function readCurrentHash(paths: CorePaths, templateId: string): Promise<string | null> {
  try {
    const raw = await readFile(paths.templateCacheCurrentFile(templateId), 'utf8');
    const parsed = JSON.parse(raw) as { versionHash?: unknown };
    if (typeof parsed.versionHash === 'string' && HASH_DIRECTORY.test(parsed.versionHash)) {
      return parsed.versionHash;
    }
    return null;
  } catch {
    return null;
  }
}

/** Lists cached hash directories that still carry a readable manifest. */
export async function scanCachedVersions(
  paths: CorePaths,
  templateId: string,
): Promise<CachedVersion[]> {
  let entries: string[];
  try {
    entries = await readdir(join(paths.templateCacheRoot, templateId));
  } catch {
    return [];
  }
  const versions: CachedVersion[] = [];
  for (const entry of entries) {
    if (!HASH_DIRECTORY.test(entry)) {
      continue; // Skips current.json and any .tmp-* staging residue.
    }
    const version = await readManifest(paths.templateCacheVersionRoot(templateId, entry));
    if (version !== null && version.frozen.versionHash === entry) {
      versions.push(version);
    }
  }
  return versions;
}

/**
 * Resolves the last valid cached version: the current pointer first, then a
 * deterministic fallback over intact manifests (newest cachedAt, then hash).
 */
export async function loadLastValidCached(
  paths: CorePaths,
  templateId: string,
): Promise<CachedVersion | null> {
  const current = await readCurrentHash(paths, templateId);
  if (current !== null) {
    const version = await readManifest(paths.templateCacheVersionRoot(templateId, current));
    if (version !== null && version.frozen.versionHash === current) {
      return version;
    }
  }
  const versions = await scanCachedVersions(paths, templateId);
  if (versions.length === 0) {
    return null;
  }
  versions.sort((a, b) => {
    if (a.cachedAt !== b.cachedAt) {
      return a.cachedAt < b.cachedAt ? 1 : -1;
    }
    return a.frozen.versionHash < b.frozen.versionHash ? 1 : -1;
  });
  return versions[0] ?? null;
}

/**
 * Caches a validated frozen template and atomically repoints current.json.
 * Never overwrites an existing hash directory; failures leave current.json
 * untouched.
 */
export async function cacheTemplate(paths: CorePaths, frozen: FrozenTemplate): Promise<CachedVersion> {
  const versionRoot = paths.templateCacheVersionRoot(frozen.id, frozen.versionHash);
  const templateCacheDir = dirname(versionRoot);
  await mkdir(templateCacheDir, { recursive: true });

  if (!(await pathExists(versionRoot))) {
    const stageDir = join(templateCacheDir, `${TMP_PREFIX}stage-${randomUUID()}`);
    try {
      await copyTemplateFiles(frozen.sourcePath, stageDir);
      const reopened = await loadTemplateDirectory(stageDir);
      if (reopened.versionHash !== frozen.versionHash) {
        throw new TemplateError(
          TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
          '模板缓存副本未通过复核校验。',
          null,
          '重试重新加载模板。',
        );
      }
      const manifestFrozen: FrozenTemplate = {
        ...reopened,
        id: frozen.id,
        sourcePath: versionRoot,
      };
      const stagedAt = new Date().toISOString();
      await writeJsonAtomic(stageDir, 'manifest.json', { ...manifestFrozen, cachedAt: stagedAt });
      try {
        await rename(stageDir, versionRoot);
      } catch (renameError) {
        // A concurrent publish won the race: reuse the winner, never overwrite.
        if (!(await pathExists(versionRoot))) {
          throw renameError;
        }
        await rm(stageDir, { recursive: true, force: true });
      }
    } catch (error) {
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  const published = await readManifest(versionRoot);
  if (published === null || published.frozen.versionHash !== frozen.versionHash) {
    throw new TemplateError(
      TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
      '模板缓存版本清单缺失或与源内容不一致。',
      null,
      '重试重新加载模板。',
    );
  }
  await writeJsonAtomic(templateCacheDir, 'current.json', {
    versionHash: frozen.versionHash,
    updatedAt: published.cachedAt,
  });
  return published;
}
