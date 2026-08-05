/**
 * The no-discovery Pi resource loader (plan Phase C Task 2 Step 3).
 *
 * Forge owns every resource an agent sees: extensions, skills, prompt
 * templates, themes and context-file discovery are all disabled, and the
 * frozen agent system prompt is supplied explicitly. After one `reload()`
 * the loader must expose zero discovered resources; any leak fails the Turn
 * loud with a stable, presentable code (global constraint: Pi built-in
 * resources are disabled).
 */
import {
  DefaultResourceLoader,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import { RuntimeFailure } from './agent-runtime';

export const RESOURCE_LOADER_ERROR_CODES = {
  /** A supposedly disabled discovery channel still produced resources. */
  RESOURCE_DISCOVERY_LEAK: 'RESOURCE_DISCOVERY_LEAK',
} as const;

export interface ForgeResourceLoaderOptions {
  /** Working directory Pi would otherwise discover project resources from. */
  cwd: string;
  /** Agent config directory Pi would otherwise discover global resources from. */
  agentDir: string;
  /** The frozen agent system prompt — the only system prompt in play. */
  systemPrompt: string;
}

/**
 * Asserts that a loader exposes no discovered resources at all. Shared by
 * the production loader path and tests that prove the fail-loud guard.
 */
export function assertNoDiscoveredResources(loader: ResourceLoader): void {
  const leaks: string[] = [];
  const extensions = loader.getExtensions();
  if (extensions.extensions.length > 0) {
    leaks.push(`extensions=${extensions.extensions.length}`);
  }
  const skills = loader.getSkills();
  if (skills.skills.length > 0) {
    leaks.push(`skills=${skills.skills.length}`);
  }
  if (skills.diagnostics.length > 0) {
    leaks.push(`skill-diagnostics=${skills.diagnostics.length}`);
  }
  const prompts = loader.getPrompts();
  if (prompts.prompts.length > 0) {
    leaks.push(`prompts=${prompts.prompts.length}`);
  }
  if (prompts.diagnostics.length > 0) {
    leaks.push(`prompt-diagnostics=${prompts.diagnostics.length}`);
  }
  const themes = loader.getThemes();
  if (themes.themes.length > 0) {
    leaks.push(`themes=${themes.themes.length}`);
  }
  if (themes.diagnostics.length > 0) {
    leaks.push(`theme-diagnostics=${themes.diagnostics.length}`);
  }
  const agentsFiles = loader.getAgentsFiles();
  if (agentsFiles.agentsFiles.length > 0) {
    leaks.push(`agents-files=${agentsFiles.agentsFiles.length}`);
  }
  if (leaks.length > 0) {
    throw new RuntimeFailure(
      RESOURCE_LOADER_ERROR_CODES.RESOURCE_DISCOVERY_LEAK,
      `the constrained Pi loader discovered resources it must not see (${leaks.join(', ')})`,
      false,
    );
  }
}

/**
 * Creates the constrained loader: every discovery channel off, the frozen
 * system prompt in, one `reload()`, then a loud no-discovery assertion.
 */
export async function createForgeResourceLoader(
  options: ForgeResourceLoaderOptions,
): Promise<ResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: options.systemPrompt,
  });
  await loader.reload();
  assertNoDiscoveredResources(loader);
  return loader;
}
