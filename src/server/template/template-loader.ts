/**
 * Template directory loading (plan Phase B Task 2).
 *
 * `loadTemplateDirectory` reads one self-contained template source directory
 * (or a cache/snapshot copy of one), validates it fail-closed, reads every
 * declared Skill file and derives a deterministic content hash. Identical
 * content always yields the same `versionHash` regardless of where the
 * directory lives: template id, source path and the hash itself are excluded
 * from the canonical form, and all strings are newline-normalized before
 * SHA-256. Errors surface as `TemplateError` with file-relative locations and
 * never echo absolute paths or raw causes (iron rule 6).
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import {
  TEMPLATE_ERROR_CODES,
  TemplateError,
  type FrozenAgentConfig,
  type FrozenTemplate,
} from './template-schema';
import {
  parseYamlFile,
  validateAgentFile,
  validatePipelineFile,
  validateReferences,
  validateSingleProviderNamespace,
  validateTemplateFile,
  validateTurnContractTargets,
  type ValidatedAgentFile,
  type ValidatedPipelineFile,
  type ValidatedTemplateFile,
  type ValidatedTurnContract,
} from './template-validator';

const RELOAD_ACTION = '修正模板文件后重新加载模板。';

function unreadable(fileName: string): never {
  throw new TemplateError(
    TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
    `模板文件 ${fileName} 缺失或不可读。`,
    fileName,
    RELOAD_ACTION,
  );
}

function skillMissing(contentPath: string, message: string): never {
  throw new TemplateError(
    TEMPLATE_ERROR_CODES.TEMPLATE_SKILL_MISSING,
    `技能文件 ${contentPath}：${message}`,
    contentPath,
    RELOAD_ACTION,
  );
}

async function readYamlFile(templateDir: string, fileName: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(join(templateDir, fileName), 'utf8');
  } catch {
    unreadable(fileName);
  }
  return parseYamlFile(fileName, source);
}

/**
 * Reads one declared file confined to the template directory. Shared by Skill
 * files and Agent `systemPromptFile` references; the caller supplies the typed
 * failure so each keeps its own error code and location.
 */
async function readContainedFile(
  templateDir: string,
  relativePath: string,
  fail: (message: string) => never,
): Promise<string> {
  if (isAbsolute(relativePath) || relativePath.includes('\0')) {
    fail('必须是模板目录内的相对路径。');
  }
  const resolved = resolve(templateDir, relativePath);
  if (resolved !== templateDir && !resolved.startsWith(templateDir + sep)) {
    fail('位于模板目录之外。');
  }
  let real: string;
  let realRoot: string;
  try {
    real = await realpath(resolved);
    realRoot = await realpath(templateDir);
  } catch {
    fail('缺失或不可读。');
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    fail('位于模板目录之外。');
  }
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(real);
  } catch {
    fail('缺失或不可读。');
  }
  if (!fileStat.isFile()) {
    fail('不是普通文件。');
  }
  try {
    return await readFile(real, 'utf8');
  } catch {
    fail('无法按 UTF-8 读取。');
  }
}

/** Reads one declared Skill file, confined to the template directory. */
async function readSkillContent(templateDir: string, contentPath: string): Promise<string> {
  return readContainedFile(templateDir, contentPath, (message) => skillMissing(contentPath, message));
}

/**
 * Reads one Agent's `systemPromptFile`, confined to the template directory
 * (plan Phase D Task 1 deviation). The resolved content becomes the frozen
 * `systemPrompt`; provenance never enters the version hash.
 */
async function readPromptContent(
  templateDir: string,
  agentFileName: string,
  promptPath: string,
): Promise<string> {
  return readContainedFile(templateDir, promptPath, (message) => {
    throw new TemplateError(
      TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
      `模板 ${agentFileName} 引用的 systemPromptFile ${promptPath}：${message}`,
      promptPath,
      RELOAD_ACTION,
    );
  });
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/** Deterministic JSON: sorted object keys, newline-normalized strings. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === 'string') {
    return normalizeNewlines(value);
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      ordered[key] = canonicalize(source[key]);
    }
    return ordered;
  }
  return value;
}

interface CanonicalSource {
  template: ValidatedTemplateFile;
  pipeline: ValidatedPipelineFile;
  agents: Array<ValidatedAgentFile & { skillContents: string[] }>;
}

/**
 * Folds one-element candidate sets back to a scalar for hashing (plan
 * 2026-08-06): `publish_artifact: reviewer` and `publish_artifact: [reviewer]`
 * are semantically identical, and the fold keeps every existing frozen
 * snapshot's hash byte-stable — `readFrozenTemplate` re-verifies a snapshot
 * against its stored templateVersion, and a drifting canonical form would
 * turn every pre-change task corrupt.
 */
function hashCanonicalContract(contract: ValidatedTurnContract): unknown {
  const targets: Record<string, string | string[]> = {};
  for (const [intent, list] of Object.entries(contract.dispatch.targets)) {
    if (list !== undefined) {
      targets[intent] = list.length === 1 ? list[0] : list;
    }
  }
  return { ...contract, dispatch: { ...contract.dispatch, targets } };
}

function computeVersionHash(source: CanonicalSource): string {
  const canonical = canonicalize({
    template: source.template,
    pipeline: {
      agents: source.pipeline.agents,
      routes: source.pipeline.routes,
      artifactSchema: source.pipeline.artifactSchema,
      finalOutput: { submitters: source.pipeline.submitters },
      // A declared budget is part of the frozen contract; a budget-less
      // template omits the key so legacy hashes stay reproducible (mirrors
      // the turnContract omission trick below).
      ...(source.pipeline.budget !== null ? { budget: source.pipeline.budget } : {}),
    },
    agents: source.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      systemPrompt: agent.systemPrompt,
      model: agent.model,
      skills: agent.skills.map((skill, index) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        contentPath: skill.contentPath,
        content: source.agents.length > 0 ? (agent.skillContents[index] ?? '') : '',
      })),
      // Historical snapshots predate the contract; omitting the key (instead
      // of serializing null) keeps their original version hash reproducible
      // (spec §7.3: frozen snapshots are never rewritten or re-versioned).
      ...(agent.turnContract !== null
        ? { turnContract: hashCanonicalContract(agent.turnContract) }
        : {}),
    })),
  });
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

async function loadAgents(
  templateDir: string,
  pipeline: ValidatedPipelineFile,
  options: { turnContractOptional: boolean },
): Promise<ValidatedAgentFile[]> {
  const declaredFileNames = new Set(pipeline.agents.map((agentId) => `${agentId}.yaml`));
  let entries: string[];
  try {
    entries = await readdir(join(templateDir, 'agents'));
  } catch {
    throw new TemplateError(
      TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
      '模板 agents 目录缺失或不可读。',
      'agents',
      RELOAD_ACTION,
    );
  }
  // Undeclared files fail before any declared file is read, so an unknown
  // Agent file can never hide behind a missing declared one.
  for (const fileName of entries.filter((name) => name.endsWith('.yaml')).sort()) {
    if (!declaredFileNames.has(fileName)) {
      throw new TemplateError(
        TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
        `模板 agents/${fileName} 未在 pipeline.yaml 的 agents 列表中声明。`,
        `agents/${fileName}`,
        RELOAD_ACTION,
      );
    }
  }

  const agents: ValidatedAgentFile[] = [];
  for (const agentId of pipeline.agents) {
    const fileName = `agents/${agentId}.yaml`;
    const agent = validateAgentFile(fileName, await readYamlFile(templateDir, fileName), {
      turnContractOptional: options.turnContractOptional,
    });
    if (agent.id !== agentId) {
      throw new TemplateError(
        TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
        `模板 ${fileName}：id ${agent.id} 与文件名 ${agentId} 不一致。`,
        fileName,
        RELOAD_ACTION,
      );
    }
    if (agent.systemPromptFile !== null) {
      agent.systemPrompt = await readPromptContent(templateDir, fileName, agent.systemPromptFile);
    }
    agents.push(agent);
  }
  return agents;
}

/** Loading options for one template directory (plan 2026-08-04 Task 3). */
export interface LoadTemplateDirectoryOptions {
  /**
   * Historical frozen-task snapshot mode (spec §7.3): a missing or
   * unsupported `turnContract` folds to null instead of failing, so legacy
   * tasks stay readable and gateable. Current-template loads never set this.
   */
  historicalSnapshot?: boolean;
}

async function loadValidated(
  sourcePath: string,
  options: { historicalSnapshot: boolean },
): Promise<FrozenTemplate> {
  const template = validateTemplateFile(
    'template.yaml',
    await readYamlFile(sourcePath, 'template.yaml'),
  );
  const pipeline = validatePipelineFile(
    'pipeline.yaml',
    await readYamlFile(sourcePath, 'pipeline.yaml'),
  );
  const agents = await loadAgents(sourcePath, pipeline, {
    turnContractOptional: options.historicalSnapshot,
  });

  validateSingleProviderNamespace(
    agents.map((agent, index) => ({ fileName: `agents/${pipeline.agents[index]}.yaml`, model: agent.model })),
  );
  validateReferences(pipeline, new Set(pipeline.agents));
  validateTurnContractTargets(
    agents.map((agent, index) => ({
      fileName: `agents/${pipeline.agents[index]}.yaml`,
      id: agent.id,
      turnContract: agent.turnContract,
    })),
    new Set(pipeline.agents),
  );

  const agentsWithContents = [] as CanonicalSource['agents'];
  for (const agent of agents) {
    const skillContents: string[] = [];
    for (const skill of agent.skills) {
      skillContents.push(await readSkillContent(sourcePath, skill.contentPath));
    }
    agentsWithContents.push({ ...agent, skillContents });
  }

  const versionHash = computeVersionHash({ template, pipeline, agents: agentsWithContents });
  const frozenAgents: FrozenAgentConfig[] = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    model: agent.model,
    skills: agent.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      contentPath: skill.contentPath,
    })),
    turnContract: agent.turnContract,
  }));

  return {
    id: basename(sourcePath),
    name: template.name,
    description: template.description,
    versionHash,
    inputFields: template.inputFields,
    agents: frozenAgents,
    routes: pipeline.routes.map((route) => ({
      from: route.from,
      to: route.to,
      kind: route.kind,
      label: route.label,
      ...(route.inject.length > 0 ? { inject: route.inject } : {}),
    })),
    artifactSchema: pipeline.artifactSchema,
    finalOutput: {
      name: template.finalArtifact.name,
      format: template.finalArtifact.format,
      submitters: [...pipeline.submitters],
    },
    budget: pipeline.budget,
    sourcePath,
  };
}

/** Loads and validates one template directory into a frozen template. */
export async function loadTemplateDirectory(
  templatePath: string,
  options: LoadTemplateDirectoryOptions = {},
): Promise<FrozenTemplate> {
  const sourcePath = resolve(templatePath);
  try {
    const dirStat = await stat(sourcePath);
    if (!dirStat.isDirectory()) {
      throw new TemplateError(
        TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
        '模板路径不是一个目录。',
        null,
        RELOAD_ACTION,
      );
    }
    return await loadValidated(sourcePath, {
      historicalSnapshot: options.historicalSnapshot ?? false,
    });
  } catch (error) {
    if (error instanceof TemplateError) {
      throw error;
    }
    throw new TemplateError(
      TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
      '模板目录不存在或不可读。',
      null,
      RELOAD_ACTION,
    );
  }
}
