/**
 * Template catalog (plan Phase B Task 2 Step 5).
 *
 * Startup scans source directory ids and cache manifests independently, so a
 * broken or missing source can never hide a valid cached version. A valid
 * source loads through the validate-copy-validate cache and becomes current;
 * a broken source with an intact cache stays listed as `invalid_using_cache`
 * with an in-memory public diagnostic; a template with neither is not listed.
 * `reload` is the only way to switch the current version — there is no
 * filesystem watcher. Public results are mapped to the frozen Phase A
 * TemplateSummary/TemplateDetail contracts; the server never mutates them.
 */
import { existsSync, readdirSync } from 'node:fs';
import type {
  AgentSummary,
  TemplateDetail,
  TemplateSummary,
} from '../../shared/contracts';
import type { PublicCoreError } from '../../shared/errors';
import { CorePathError, CorePaths } from '../storage/core-paths';
import { cacheTemplate, loadLastValidCached, type CachedVersion } from './template-cache';
import { loadTemplateDirectory } from './template-loader';
import { TEMPLATE_ERROR_CODES, TemplateError, type FrozenTemplate } from './template-schema';

const SAFE_DIRECTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const VERSION_PREFIX_LENGTH = 12;

interface CatalogEntry {
  detail: TemplateDetail;
  frozen: FrozenTemplate;
  diagnostic: PublicCoreError | null;
}

function toPublicError(error: unknown): PublicCoreError {
  if (error instanceof TemplateError) {
    return {
      code: error.code,
      message: error.message,
      location: error.location,
      action: error.action,
    };
  }
  if (error instanceof CorePathError) {
    return { code: error.code, message: error.message, location: null, action: null };
  }
  // Never forward raw causes: unknown failures collapse to one stable code.
  return {
    code: TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
    message: '模板加载失败。',
    location: null,
    action: '重试重新加载模板。',
  };
}

function toAgents(frozen: FrozenTemplate): AgentSummary[] {
  return frozen.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    model: agent.model,
    // Skill content paths are server-internal; the public contract drops them.
    skills: agent.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
    })),
  }));
}

function toDetail(
  frozen: FrozenTemplate,
  status: TemplateSummary['status'],
  updatedAt: string,
): TemplateDetail {
  return {
    id: frozen.id,
    name: frozen.name,
    description: frozen.description,
    version: frozen.versionHash.slice(0, VERSION_PREFIX_LENGTH),
    agentCount: frozen.agents.length,
    status,
    updatedAt,
    inputFields: frozen.inputFields.map((field) => ({ ...field })),
    agents: toAgents(frozen),
    routes: frozen.routes.map((route) => ({ ...route })),
    finalOutput: { ...frozen.finalOutput, submitters: [...frozen.finalOutput.submitters] },
  };
}

function toSummary(detail: TemplateDetail): TemplateSummary {
  return {
    id: detail.id,
    name: detail.name,
    description: detail.description,
    version: detail.version,
    agentCount: detail.agentCount,
    status: detail.status,
    updatedAt: detail.updatedAt,
  };
}

export class TemplateCatalog {
  readonly paths: CorePaths;

  private readonly entries = new Map<string, CatalogEntry>();

  /** Source ids observed at startup; lets reload operate on known sources. */
  private readonly knownSourceIds = new Set<string>();

  constructor(paths: CorePaths) {
    this.paths = paths;
  }

  async initialize(): Promise<void> {
    this.entries.clear();
    this.knownSourceIds.clear();

    for (const templateId of this.scanSourceIds()) {
      this.knownSourceIds.add(templateId);
      await this.refreshFromSource(templateId);
    }
    for (const templateId of this.scanCacheIds()) {
      if (this.entries.has(templateId) || this.knownSourceIds.has(templateId)) {
        continue;
      }
      const diagnostic: PublicCoreError = {
        code: TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
        message: `模板 ${templateId} 的源目录缺失，正在使用最近一次有效缓存。`,
        location: null,
        action: '恢复模板源目录后重新加载。',
      };
      await this.serveFromCache(templateId, diagnostic);
    }
  }

  list(): TemplateSummary[] {
    return [...this.entries.values()]
      .map((entry) => toSummary(entry.detail))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  get(templateId: string): TemplateDetail | undefined {
    return this.entries.get(templateId)?.detail;
  }

  /** Server-internal frozen template for task snapshotting (plan Task 3). */
  getFrozen(templateId: string): FrozenTemplate | undefined {
    return this.entries.get(templateId)?.frozen;
  }

  /** In-memory public diagnostic for a source that failed to load, if any. */
  getDiagnostic(templateId: string): PublicCoreError | null {
    return this.entries.get(templateId)?.diagnostic ?? null;
  }

  /**
   * Explicitly reloads one template from its source directory and, on full
   * validation success, switches the current cached version. Failures retain
   * the previous entry and rethrow the public error.
   */
  async reload(templateId: string): Promise<TemplateDetail> {
    let sourcePath: string;
    try {
      sourcePath = this.paths.templateSource(templateId);
    } catch (error) {
      if (error instanceof CorePathError) {
        throw new TemplateError(
          TEMPLATE_ERROR_CODES.TEMPLATE_NOT_FOUND,
          `未找到模板 ${templateId}。`,
          null,
          '返回模板列表重新加载。',
        );
      }
      throw error;
    }
    const known =
      this.knownSourceIds.has(templateId) || this.entries.has(templateId) || existsSync(sourcePath);
    if (!known) {
      throw new TemplateError(
        TEMPLATE_ERROR_CODES.TEMPLATE_NOT_FOUND,
        `未找到模板 ${templateId}。`,
        null,
        '返回模板列表重新加载。',
      );
    }
    if (!existsSync(sourcePath)) {
      throw new TemplateError(
        TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
        `模板 ${templateId} 的源目录缺失。`,
        null,
        '恢复模板源目录后重试。',
      );
    }
    try {
      const frozen = await loadTemplateDirectory(sourcePath);
      const cached = await cacheTemplate(this.paths, frozen);
      const detail = toDetail(cached.frozen, 'valid', cached.cachedAt);
      this.entries.set(templateId, { detail, frozen: cached.frozen, diagnostic: null });
      this.knownSourceIds.add(templateId);
      return detail;
    } catch (error) {
      if (error instanceof TemplateError) {
        throw error;
      }
      throw new TemplateError(
        TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
        '模板加载失败。',
        null,
        '重试重新加载模板。',
      );
    }
  }

  private scanSourceIds(): string[] {
    return this.scanDirectoryIds(this.paths.templateRoot);
  }

  private scanCacheIds(): string[] {
    return this.scanDirectoryIds(this.paths.templateCacheRoot);
  }

  private scanDirectoryIds(root: string): string[] {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && SAFE_DIRECTORY_NAME.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** Loads one source through the cache; falls back to last-valid cache. Never throws. */
  private async refreshFromSource(templateId: string): Promise<void> {
    let diagnostic: PublicCoreError | null = null;
    try {
      const frozen = await loadTemplateDirectory(this.paths.templateSource(templateId));
      const cached = await cacheTemplate(this.paths, frozen);
      this.adopt(templateId, cached, 'valid', null);
      return;
    } catch (error) {
      diagnostic = toPublicError(error);
    }
    await this.serveFromCache(templateId, diagnostic);
  }

  private async serveFromCache(templateId: string, diagnostic: PublicCoreError): Promise<void> {
    let cached: CachedVersion | null = null;
    try {
      cached = await loadLastValidCached(this.paths, templateId);
    } catch {
      cached = null;
    }
    if (cached !== null) {
      this.adopt(templateId, cached, 'invalid_using_cache', diagnostic);
    }
  }

  private adopt(
    templateId: string,
    cached: CachedVersion,
    status: TemplateSummary['status'],
    diagnostic: PublicCoreError | null,
  ): void {
    this.entries.set(templateId, {
      detail: toDetail(cached.frozen, status, cached.cachedAt),
      frozen: cached.frozen,
      diagnostic,
    });
  }
}
