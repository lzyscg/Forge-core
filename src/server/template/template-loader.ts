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
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { StructuredRuntimeEnvironmentV1 } from '../structured-slots/runtime-capability';
import {
  TEMPLATE_ERROR_CODES,
  TemplateError,
  type FrozenAgentConfig,
  type FrozenTemplate,
  type ScaffoldPhase,
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
import {
  loadStructuredSlotContract,
  type FrozenStructuredSlotContractV1,
} from './structured-slot-contract';
import { validateStructuredPipeline } from './structured-pipeline-validator';

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

/** One collected Skill section: template-relative path + normalized content. */
interface SkillSectionFile {
  path: string;
  content: string;
}

/** Depth ceiling for the recursive section walk (generous; templates are flat). */
const MAX_SECTION_DEPTH = 8;

/**
 * Collects every `.md` section file under one Skill's optional `sectionsPath`
 * (template-relative, forward slashes, deterministic sorted order). `null`
 * returns `[]` for backwards compatibility. Hidden files, symlinks and
 * non-`.md` files are skipped; each file is still read through
 * `readContainedFile` so its realpath stays confined to the template
 * directory. A declared but missing/unreadable directory fails the template
 * as a missing Skill.
 */
async function collectSkillSections(
  templateDir: string,
  sectionsPath: string | null,
): Promise<SkillSectionFile[]> {
  if (sectionsPath === null) {
    return [];
  }
  const sections: SkillSectionFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SECTION_DEPTH) {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      skillMissing(sectionsPath, '缺失或不可读。');
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const relPath = relative(templateDir, full).split(sep).join('/');
        const content = await readContainedFile(templateDir, relPath, (message) =>
          skillMissing(relPath, message),
        );
        sections.push({ path: relPath, content });
      }
    }
  };
  await walk(join(templateDir, sectionsPath), 1);
  return sections;
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

/**
 * Reads one Agent's declared gate validator file, confined to the template
 * directory (plan 2026-08-07 Phase 2). The validator code is template-owned;
 * the loader only verifies containment and folds the content into the version
 * hash so a validator change re-versions the template.
 */
async function readGateValidatorContent(
  templateDir: string,
  agentFileName: string,
  validatorPath: string,
): Promise<string> {
  return readContainedFile(templateDir, validatorPath, (message) => {
    throw new TemplateError(
      TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
      `模板 ${agentFileName} 引用的 gate.validator ${validatorPath}：${message}`,
      validatorPath,
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
  agents: Array<
    ValidatedAgentFile & {
      skillContents: string[];
      skillSections: Array<SkillSectionFile[]>;
      /** Gate validator file content; null when the agent declares no gate. */
      gateValidatorContent: string | null;
    }
  >;
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

/**
 * The deterministic canonical source of a template (basic mode). The basic
 * canonical form deliberately OMITS the `productionMode` default: a template
 * without (or with) `productionMode: basic` hashes identically to the
 * pre-change form, so old basic version hashes stay byte-for-byte identical
 * (spec §3.2 / design A03).
 */
function buildBasicCanonical(source: CanonicalSource): unknown {
  return canonicalize({
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
        // Skill sections are hashed only when present; an absent sections key
        // (not an empty array) keeps every pre-existing template's version
        // hash byte-stable (iron rule 2, mirroring the turnContract trick).
        ...(agent.skillSections[index].length > 0
          ? {
              sections: agent.skillSections[index].map((section) => ({
                path: section.path,
                content: section.content,
              })),
            }
          : {}),
      })),
      // Historical snapshots predate the contract; omitting the key (instead
      // of serializing null) keeps their original version hash reproducible
      // (spec §7.3: frozen snapshots are never rewritten or re-versioned).
      ...(agent.turnContract !== null
        ? { turnContract: hashCanonicalContract(agent.turnContract) }
        : {}),
      // A declared gate enters the hash (validator content included, so a
      // validator change re-versions the template); a gate-less agent omits
      // the key so pre-existing templates' version hashes stay byte-stable
      // (mirrors the turnContract omission trick above).
      ...(agent.gate !== null
        ? {
            gate: {
              validator: agent.gate.validator,
              artifactType: agent.gate.artifactType,
              mode: agent.gate.mode,
              validatorContent: agent.gateValidatorContent,
            },
          }
        : {}),
      // A slot-capability ceiling enters the hash only when declared (v3 slot
      // agents); basic agents carry an empty ceiling whose key is omitted so
      // every pre-existing basic version hash stays byte-for-byte identical.
      ...(agent.slotCapabilities.length > 0 ? { slotCapabilities: agent.slotCapabilities } : {}),
    })),
  });
}

function computeVersionHash(source: CanonicalSource): string {
  return createHash('sha256').update(JSON.stringify(buildBasicCanonical(source)), 'utf8').digest('hex');
}

/**
 * Structured mode hash (design A03): the basic canonical plus the production
 * mode and the slot contract's semantic digest — which itself covers the
 * normalized contract, the sorted resource digest and the ABI/profile identity
 * (computed by the Task 4 contract compiler).
 */
function computeStructuredVersionHash(source: CanonicalSource, semanticDigest: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonicalize({
          productionMode: 'structured_slots',
          base: buildBasicCanonical(source),
          structuredContract: semanticDigest,
        }),
      ),
      'utf8',
    )
    .digest('hex');
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
  /**
   * The structured runtime environment (spec §5 / design O05): its profile
   * supplies the platform hard ceiling for the slots contract. Required for
   * `structured_slots` templates (fail closed with `TEMPLATE_RUNTIME_UNAVAILABLE`
   * when missing/disabled), ignored for basic templates.
   */
  runtimeEnvironment?: StructuredRuntimeEnvironmentV1;
}

/** True when `slots/contract.yaml` exists under the template root. */
async function slotsContractExists(sourcePath: string): Promise<boolean> {
  try {
    await stat(join(sourcePath, 'slots', 'contract.yaml'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the mode split (spec §3.2 / §15): basic rejects a slots contract or
 * any v3 binding; structured requires the runtime environment's profile and
 * compiles the slots contract. Returns `null` for basic.
 */
async function resolveStructuredSlots(
  sourcePath: string,
  mode: 'basic' | 'structured_slots',
  agents: CanonicalSource['agents'],
  options: { runtimeEnvironment?: StructuredRuntimeEnvironmentV1 },
): Promise<{ contract: FrozenStructuredSlotContractV1; semanticDigest: string } | null> {
  if (mode === 'basic') {
    if (await slotsContractExists(sourcePath)) {
      throw new TemplateError(
        TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
        'basic 模板不能包含 slots/contract.yaml。',
        'slots/contract.yaml',
        RELOAD_ACTION,
      );
    }
    if (agents.some((agent) => agent.turnContract !== null && agent.turnContract.version === 3)) {
      throw new TemplateError(
        TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
        'basic 模板不能声明 v3 回合契约。',
        'pipeline.yaml',
        RELOAD_ACTION,
      );
    }
    return null;
  }
  const env = options.runtimeEnvironment;
  if (env === undefined || env.capability.status !== 'enabled' || env.profile === null) {
    throw new TemplateError(
      TEMPLATE_ERROR_CODES.TEMPLATE_RUNTIME_UNAVAILABLE,
      '结构化运行时能力未就绪，无法加载该模板。',
      null,
      '等待结构化运行时就绪后重新加载。',
    );
  }
  const contract = await loadStructuredSlotContract(sourcePath, env.profile.limits);
  return { contract, semanticDigest: contract.semanticDigest };
}

/** Serializes the compiled phase contract into the frozen snapshot. */
function toPhasesRecord(phases: Map<string, ReadonlySet<ScaffoldPhase>>): Record<string, readonly ScaffoldPhase[]> {
  const record: Record<string, readonly ScaffoldPhase[]> = {};
  for (const [agentId, set] of phases) {
    record[agentId] = [...set];
  }
  return record;
}

async function loadValidated(
  sourcePath: string,
  options: { historicalSnapshot: boolean; runtimeEnvironment?: StructuredRuntimeEnvironmentV1 },
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
    const skillSections: Array<SkillSectionFile[]> = [];
    for (const skill of agent.skills) {
      skillContents.push(await readSkillContent(sourcePath, skill.contentPath));
      skillSections.push(await collectSkillSections(sourcePath, skill.sectionsPath));
    }
    const gateValidatorContent =
      agent.gate === null
        ? null
        : await readGateValidatorContent(sourcePath, `agents/${agent.id}.yaml`, agent.gate.validator);
    agentsWithContents.push({ ...agent, skillContents, skillSections, gateValidatorContent });
  }

  const structured = await resolveStructuredSlots(sourcePath, pipeline.productionMode, agentsWithContents, options);

  const versionHash =
    structured === null
      ? computeVersionHash({ template, pipeline, agents: agentsWithContents })
      : computeStructuredVersionHash({ template, pipeline, agents: agentsWithContents }, structured.semanticDigest);
  const frozenAgents: FrozenAgentConfig[] = agentsWithContents.map((agent) => ({
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
      sectionsPath: skill.sectionsPath,
      sections: agent.skillSections[index].map((section) => section.path),
    })),
    gate:
      agent.gate === null
        ? null
        : {
            validator: agent.gate.validator,
            artifactType: agent.gate.artifactType,
            mode: [...agent.gate.mode],
          },
    slotCapabilities: [...agent.slotCapabilities],
    turnContract: agent.turnContract,
  }));

  const mode = pipeline.productionMode;
  if (structured === null) {
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
      productionMode: 'basic',
      structuredSlots: null,
      structuredPhases: null,
      sourcePath,
    };
  }

  const baseFrozen: Omit<FrozenTemplate, 'productionMode' | 'structuredSlots' | 'structuredPhases'> = {
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
  // Typestate + capability + dispatch matrices run on the frozen pipeline; the
  // compiled phase contract is stored in the frozen template (and thus the
  // task snapshot).
  const phases = validateStructuredPipeline({
    ...baseFrozen,
    productionMode: 'structured_slots',
    structuredSlots: structured.contract,
    structuredPhases: null,
  });
  return {
    ...baseFrozen,
    productionMode: 'structured_slots',
    structuredSlots: structured.contract,
    structuredPhases: toPhasesRecord(phases),
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
      runtimeEnvironment: options.runtimeEnvironment,
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
