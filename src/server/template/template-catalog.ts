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
import type { StructuredRuntimeEnvironmentV1 } from '../structured-slots/runtime-capability';
import { createProductionRuntimeEnvironment } from '../structured-slots/runtime-capability';
import type { AuthoritativeReviewRuntimeEnvironmentV1 } from '../structured-slots/authoritative-review-capability';
import { createProductionAuthoritativeReviewEnvironment } from '../structured-slots/authoritative-review-capability';
import { isAuthoritativeReviewRunnable } from '../structured-slots/authoritative-review-capability';
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

  /**
   * The ONE immutable structured runtime environment the Catalog owns (spec
   * §5 / design O05). Production defaults to the checked-in disabled manifest
   * with a null profile; tests inject a matching enabled capability + profile.
   * `cacheTemplate` receives it explicitly and TaskStore obtains it from here.
   */
  readonly runtimeEnvironment: StructuredRuntimeEnvironmentV1;

  /**
   * The ONE immutable authoritative review runtime environment (spec §17 /
   * design O05, Task 5): threaded from CoreService construction only. A
   * contract-v2 template is exposed only when BOTH capabilities pass.
   */
  readonly authoritativeReviewEnvironment: AuthoritativeReviewRuntimeEnvironmentV1;

  private readonly entries = new Map<string, CatalogEntry>();

  /** Source ids observed at startup; lets reload operate on known sources. */
  private readonly knownSourceIds = new Set<string>();

  /**
   * Internal availability diagnostics for known structured sources/caches that
   * the runtime cannot execute while the capability is disabled (design O05):
   * the Catalog never exposes a runnable frozen structured template, but
   * TaskStore uses this to map the case to `TEMPLATE_RUNTIME_UNAVAILABLE`
   * instead of `TEMPLATE_NOT_FOUND`.
   */
  private readonly unavailable = new Map<string, PublicCoreError>();

  constructor(
    paths: CorePaths,
    options: {
      runtimeEnvironment?: StructuredRuntimeEnvironmentV1;
      authoritativeReviewEnvironment?: AuthoritativeReviewRuntimeEnvironmentV1;
    } = {},
  ) {
    this.paths = paths;
    this.runtimeEnvironment = options.runtimeEnvironment ?? createProductionRuntimeEnvironment();
    this.authoritativeReviewEnvironment =
      options.authoritativeReviewEnvironment ?? createProductionAuthoritativeReviewEnvironment();
  }

  /** True when the structured runtime may execute structured templates. */
  private isStructuredRunnable(): boolean {
    return (
      this.runtimeEnvironment.capability.status === 'enabled' &&
      this.runtimeEnvironment.profile !== null
    );
  }

  /** True when the authoritative runtime may execute contract-v2 templates. */
  private isAuthoritativeRunnable(): boolean {
    return isAuthoritativeReviewRunnable(this.authoritativeReviewEnvironment);
  }

  /** A v2 template needs BOTH capability gates (spec §17). */
  private isReviewProtocolRunnable(frozen: FrozenTemplate | undefined): boolean {
    if (frozen === undefined || frozen.productionMode !== 'structured_slots' || frozen.structuredSlots === null) {
      return true;
    }
    if (frozen.structuredSlots.version === 2) {
      return this.isStructuredRunnable() && this.isAuthoritativeRunnable();
    }
    return this.isStructuredRunnable();
  }

  async initialize(): Promise<void> {
    this.entries.clear();
    this.knownSourceIds.clear();
    this.unavailable.clear();

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
    return (
      this.entries.get(templateId)?.diagnostic ??
      this.unavailable.get(templateId) ??
      null
    );
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
      const frozen = await loadTemplateDirectory(sourcePath, {
        runtimeEnvironment: this.runtimeEnvironment,
        authoritativeReviewEnvironment: this.authoritativeReviewEnvironment,
      });
      const cached = await cacheTemplate(
        this.paths,
        frozen,
        this.runtimeEnvironment,
        this.authoritativeReviewEnvironment,
      );
      const detail = toDetail(cached.frozen, 'valid', cached.cachedAt);
      this.entries.set(templateId, { detail, frozen: cached.frozen, diagnostic: null });
      this.unavailable.delete(templateId);
      this.knownSourceIds.add(templateId);
      return detail;
    } catch (error) {
      if (error instanceof TemplateError) {
        if (error.code === TEMPLATE_ERROR_CODES.TEMPLATE_RUNTIME_UNAVAILABLE) {
          this.unavailable.set(templateId, toPublicError(error));
        }
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
      const frozen = await loadTemplateDirectory(this.paths.templateSource(templateId), {
        runtimeEnvironment: this.runtimeEnvironment,
        authoritativeReviewEnvironment: this.authoritativeReviewEnvironment,
      });
      const cached = await cacheTemplate(
        this.paths,
        frozen,
        this.runtimeEnvironment,
        this.authoritativeReviewEnvironment,
      );
      this.adopt(templateId, cached, 'valid', null);
      return;
    } catch (error) {
      diagnostic = toPublicError(error);
      if (diagnostic.code === TEMPLATE_ERROR_CODES.TEMPLATE_RUNTIME_UNAVAILABLE) {
        // Known structured source gated by runtime readiness (design O05):
        // keep the internal diagnostic so TaskStore maps it correctly, and
        // never adopt a runnable frozen structured template.
        this.unavailable.set(templateId, diagnostic);
      }
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
      if (!this.isReviewProtocolRunnable(cached.frozen)) {
        // A structured cache exists but the runtime cannot execute it while a
        // required capability is disabled (design O05 / spec §17): retain the
        // availability diagnostic, never expose it.
        this.unavailable.set(templateId, {
          code: TEMPLATE_ERROR_CODES.TEMPLATE_RUNTIME_UNAVAILABLE,
          message: '结构化运行时能力未就绪，无法使用该模板。',
          location: null,
          action: '等待结构化运行时就绪后重新加载。',
        });
        return;
      }
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
