/**
 * Fail-closed structural validation for template YAML files
 * (plan Phase B Task 2).
 *
 * Pure structure work: no filesystem access, no business vocabulary. Every
 * violation throws a `TemplateError` whose `location` names the offending
 * file relative to the template directory. YAML duplicate keys are rejected
 * outright; merge keys are disabled so `<<` stays inert data.
 */
import { parse } from 'yaml';
import type { InputField } from '../../shared/contracts';
import { PROGRESS_POLICY_CEILING, type ProgressPolicy } from '../runtime/progress-guard';
import { TEMPLATE_ERROR_CODES, TemplateError } from './template-schema';

const RELOAD_ACTION = '修正模板文件后重新加载模板。';

/** Stable identifiers: start alphanumeric, then alphanumeric/dot/underscore/dash. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Model identifiers live in exactly one provider namespace: `<provider>/<model>`. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function invalid(fileName: string, message: string): never {
  throw new TemplateError(
    TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
    `模板 ${fileName}：${message}`,
    fileName,
    RELOAD_ACTION,
  );
}

/** Parses one YAML file, rejecting duplicate mapping keys with a stable code. */
export function parseYamlFile(fileName: string, source: string): unknown {
  try {
    return parse(source, { merge: false });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'DUPLICATE_KEY'
    ) {
      throw new TemplateError(
        TEMPLATE_ERROR_CODES.TEMPLATE_DUPLICATE_KEY,
        `模板 ${fileName} 存在重复的 YAML 键。`,
        fileName,
        RELOAD_ACTION,
      );
    }
    throw new TemplateError(
      TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
      `模板 ${fileName} 不是有效的 YAML。`,
      fileName,
      RELOAD_ACTION,
    );
  }
}

function asRecord(fileName: string, value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(fileName, `${what} 必须是键值映射。`);
  }
  return value as Record<string, unknown>;
}

function asArray(fileName: string, value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    invalid(fileName, `${what} 必须是列表。`);
  }
  return value;
}

function asString(
  fileName: string,
  value: unknown,
  what: string,
  options: { required: boolean },
): string {
  if (typeof value !== 'string') {
    if (options.required) {
      invalid(fileName, `${what} 必须提供且为字符串。`);
    }
    return '';
  }
  if (options.required && value.trim() === '') {
    invalid(fileName, `${what} 不能为空。`);
  }
  return value;
}

function asBoolean(fileName: string, value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') {
    invalid(fileName, `${what} 必须是布尔值。`);
  }
  return value;
}

function asSafeId(fileName: string, value: unknown, what: string): string {
  const id = asString(fileName, value, what, { required: true });
  if (!SAFE_ID.test(id)) {
    invalid(fileName, `${what} 只能包含字母、数字、点、下划线和短横线，且以字母或数字开头。`);
  }
  return id;
}

/**
 * One dispatch-target declaration: a single id OR a candidate list
 * (plan 2026-08-06 multi-target dispatch). Both normalize to a non-empty,
 * duplicate-free id array — the ONLY normalization point for targets, so
 * historical snapshots with scalar targets stay runnable through the same
 * path. Lists keep their declared order.
 */
function asSafeIdList(fileName: string, value: unknown, what: string): string[] {
  if (!Array.isArray(value)) {
    return [asSafeId(fileName, value, what)];
  }
  if (value.length === 0) {
    invalid(fileName, `${what} 至少需要一个候选 Agent。`);
  }
  const seen = new Set<string>();
  const ids = value.map((entry, index) => asSafeId(fileName, entry, `${what}[${index}]`));
  for (const id of ids) {
    if (seen.has(id)) {
      invalid(fileName, `${what} 中 ${id} 重复。`);
    }
    seen.add(id);
  }
  return ids;
}

function asEnum<T extends string>(fileName: string, value: unknown, what: string, allowed: readonly T[]): T {
  const text = asString(fileName, value, what, { required: true });
  if (!allowed.includes(text as T)) {
    invalid(fileName, `${what} 仅支持 ${allowed.join(' / ')}。`);
  }
  return text as T;
}

export interface ValidatedTemplateFile {
  name: string;
  description: string;
  inputFields: InputField[];
  finalArtifact: { name: string; format: 'markdown' | 'text' };
}

/** Validates template.yaml: identity, user input fields and final artifact. */
export function validateTemplateFile(fileName: string, raw: unknown): ValidatedTemplateFile {
  const root = asRecord(fileName, raw, 'template.yaml');
  const name = asString(fileName, root.name, 'name', { required: true });
  const description = asString(fileName, root.description, 'description', { required: false });

  if (!('inputFields' in root)) {
    invalid(fileName, 'inputFields 必须声明（可为空列表）。');
  }
  const seenInputIds = new Set<string>();
  const inputFields = asArray(fileName, root.inputFields, 'inputFields').map((entry, index) => {
    const field = asRecord(fileName, entry, `inputFields[${index}]`);
    const id = asSafeId(fileName, field.id, `inputFields[${index}].id`);
    if (seenInputIds.has(id)) {
      invalid(fileName, `输入字段 id ${id} 重复。`);
    }
    seenInputIds.add(id);
    return {
      id,
      label: asString(fileName, field.label, `inputFields[${index}].label`, { required: true }),
      kind: asEnum(fileName, field.kind, `inputFields[${index}].kind`, ['text', 'textarea']),
      required: asBoolean(fileName, field.required, `inputFields[${index}].required`),
      description: asString(fileName, field.description, `inputFields[${index}].description`, {
        required: false,
      }),
    } satisfies InputField;
  });

  if (!('finalArtifact' in root)) {
    invalid(fileName, 'finalArtifact 必须声明。');
  }
  const artifact = asRecord(fileName, root.finalArtifact, 'finalArtifact');
  return {
    name,
    description,
    inputFields,
    finalArtifact: {
      name: asString(fileName, artifact.name, 'finalArtifact.name', { required: true }),
      format: asEnum(fileName, artifact.format, 'finalArtifact.format', ['markdown', 'text']),
    },
  };
}

export interface ValidatedInject {
  version: 'input';
  file: string;
  as: string;
}

export interface ValidatedRoute {
  from: string;
  to: string;
  kind: 'message' | 'artifact';
  label: string;
  inject: ValidatedInject[];
}

export interface ValidatedArtifactFile {
  name: string;
  required: boolean;
  producer: string;
  extract: string;
  phase: 'create' | 'annotate';
}

export interface ValidatedArtifactSchema {
  files: ValidatedArtifactFile[];
}

export interface ValidatedPipelineFile {
  agents: string[];
  routes: ValidatedRoute[];
  submitters: string[];
  artifactSchema: ValidatedArtifactSchema;
  /**
   * Optional per-template progress budget (plan 2026-08-06): overrides the
   * scheduler-injected progress policy for every task frozen from this
   * template. Null when the pipeline declares none.
   */
  budget: ProgressPolicy | null;
}

function validateArtifactSchema(
  fileName: string,
  raw: unknown,
  agents: ReadonlySet<string>,
): ValidatedArtifactSchema {
  const root = asRecord(fileName, raw, 'artifactSchema');
  const entries = asArray(fileName, root.files, 'artifactSchema.files');
  if (entries.length === 0) invalid(fileName, 'artifactSchema.files 至少需要一个文件。');
  const seen = new Set<string>();
  const files = entries.map((entry, index) => {
    const item = asRecord(fileName, entry, `artifactSchema.files[${index}]`);
    const name = asSafeId(fileName, item.name, `artifactSchema.files[${index}].name`);
    if (seen.has(name)) invalid(fileName, `artifactSchema.files 中 ${name} 重复。`);
    seen.add(name);
    const producer = asSafeId(fileName, item.producer, `artifactSchema.files[${index}].producer`);
    if (!agents.has(producer)) invalid(fileName, `artifactSchema.files[${index}].producer 未声明。`);
    const phase = asEnum(fileName, item.phase, `artifactSchema.files[${index}].phase`, ['create', 'annotate']);
    return {
      name,
      required: asBoolean(fileName, item.required, `artifactSchema.files[${index}].required`),
      producer,
      extract: asSafeId(fileName, item.extract, `artifactSchema.files[${index}].extract`),
      phase,
    } satisfies ValidatedArtifactFile;
  });
  if (!files.some((file) => file.required && file.phase === 'create')) {
    invalid(fileName, 'artifactSchema 至少需要一个 required create 文件。');
  }
  return { files };
}

function validateInject(fileName: string, raw: unknown, index: number): ValidatedInject {
  const item = asRecord(fileName, raw, `routes.inject[${index}]`);
  return {
    version: asEnum(fileName, item.version, `routes.inject[${index}].version`, ['input']),
    file: asSafeId(fileName, item.file, `routes.inject[${index}].file`),
    as: asString(fileName, item.as, `routes.inject[${index}].as`, { required: true }),
  };
}

/** Validates pipeline.yaml: deterministic Agent order, routes and final submitters. */
export function validatePipelineFile(fileName: string, raw: unknown): ValidatedPipelineFile {
  const root = asRecord(fileName, raw, 'pipeline.yaml');

  const agents = asArray(fileName, root.agents, 'agents').map((entry, index) =>
    asSafeId(fileName, entry, `agents[${index}]`),
  );
  if (agents.length === 0) invalid(fileName, 'agents 至少需要一个 Agent。');
  const seenAgents = new Set<string>();
  for (const agentId of agents) {
    if (seenAgents.has(agentId)) invalid(fileName, `Agent ${agentId} 在 agents 列表中重复，顺序必须确定。`);
    seenAgents.add(agentId);
  }

  const artifactSchema = root.artifactSchema === undefined || root.artifactSchema === null
    ? { files: [{ name: 'content.md', required: true, producer: agents[0]!, extract: 'content', phase: 'create' as const }] }
    : validateArtifactSchema(fileName, root.artifactSchema, seenAgents);
  const routes = asArray(fileName, root.routes, 'routes').map((entry, index) => {
    const route = asRecord(fileName, entry, `routes[${index}]`);
    const inject = route.inject === undefined || route.inject === null
      ? []
      : asArray(fileName, route.inject, `routes[${index}].inject`).map((item, injectIndex) => validateInject(fileName, item, injectIndex));
    return {
      from: asSafeId(fileName, route.from, `routes[${index}].from`),
      to: asSafeId(fileName, route.to, `routes[${index}].to`),
      kind: asEnum(fileName, route.kind, `routes[${index}].kind`, ['message', 'artifact']),
      label: asString(fileName, route.label, `routes[${index}].label`, { required: false }),
      inject,
    } satisfies ValidatedRoute;
  });

  const finalOutput = asRecord(fileName, root.finalOutput, 'finalOutput');
  const submitters = asArray(fileName, finalOutput.submitters, 'finalOutput.submitters').map(
    (entry, index) => asSafeId(fileName, entry, `finalOutput.submitters[${index}]`),
  );
  if (submitters.length === 0) invalid(fileName, 'finalOutput.submitters 至少需要一个 Agent。');
  const seenSubmitters = new Set<string>();
  for (const submitter of submitters) {
    if (seenSubmitters.has(submitter)) invalid(fileName, `finalOutput.submitters 中 ${submitter} 重复。`);
    seenSubmitters.add(submitter);
  }

  let budget: ProgressPolicy | null = null;
  if ('budget' in root && root.budget !== undefined && root.budget !== null) {
    const budgetRecord = asRecord(fileName, root.budget, 'budget');
    for (const key of Object.keys(budgetRecord)) {
      if (key !== 'maxTurnsSinceHumanAnswer') invalid(fileName, `budget 只能声明 maxTurnsSinceHumanAnswer，未知键 ${key}。`);
    }
    const turns = budgetRecord.maxTurnsSinceHumanAnswer;
    if (typeof turns !== 'number' || !Number.isInteger(turns)) invalid(fileName, 'budget.maxTurnsSinceHumanAnswer 必须是整数。');
    if (turns < 1 || turns > PROGRESS_POLICY_CEILING) invalid(fileName, `budget.maxTurnsSinceHumanAnswer 必须在 1 到 ${PROGRESS_POLICY_CEILING} 之间。`);
    budget = Object.freeze({ maxTurnsSinceHumanAnswer: turns });
  }
  return { agents, routes, submitters, artifactSchema, budget };
}
export interface ValidatedAgentSkill {
  id: string;
  name: string;
  description: string;
  contentPath: string;
  /** Optional section-file directory (template-relative); null when absent. */
  sectionsPath: string | null;
}

/** Structural shape of one validated agent gate (plan 2026-08-07 Phase 2). */
export interface ValidatedAgentGate {
  validator: string;
  artifactType: string;
  mode: Array<'self_check' | 'commit'>;
}

/** Structural shape of one validated turn contract (spec §6). */
export interface ValidatedTurnContract {
  version: 1 | 2;
  production?: {
    files?: string[];
    completionAction: 'finish_production';
    output: {
      formats: Array<'markdown' | 'text'>;
      sources: Array<'inline' | 'workspace_file' | 'current_input_artifact'>;
    };
  };
  annotate?: { files: string[] };
  dispatch: {
    cardinality: 'single';
    allowedActions: Array<'send_message' | 'publish_artifact' | 'submit_final_artifact' | 'forward_input_version' | 'submit_final_artifact' | 'request_human_input'>;
    targets: Partial<Record<'send_message' | 'publish_artifact' | 'submit_final_artifact' | 'forward_input_version', string[]>>;
    productionPackageRef?: 'current';
  };
}

const PRODUCTION_SOURCES = ['inline', 'workspace_file', 'current_input_artifact'] as const;
const DISPATCH_INTENTS = ['send_message', 'publish_artifact', 'submit_final_artifact', 'forward_input_version', 'request_human_input'] as const;

/** Validates the required `turnContract` block of one agent file (spec §6). */
function validateTurnContract(fileName: string, raw: unknown): ValidatedTurnContract {
  const contract = asRecord(fileName, raw, 'turnContract');
  const version = contract.version;
  if (version !== 1 && version !== 2) invalid(fileName, 'turnContract.version 仅支持 1 或 2。');

  let production: ValidatedTurnContract['production'];
  if (contract.production !== undefined && contract.production !== null) {
    const p = asRecord(fileName, contract.production, 'turnContract.production');
    // v2 carries files/sources/formats directly under production; v1 wrapped
    // them under `output`. Accept both: prefer v2 top-level fields, fall back
    // to v1 `output` for legacy snapshots.
    const outputSrc = (p.output !== undefined && p.output !== null) ? asRecord(fileName, p.output, 'turnContract.production.output') : p;
    const formats = asArray(fileName, outputSrc.formats, 'turnContract.production.formats').map((e,i) => asEnum(fileName,e,`turnContract.production.formats[${i}]`,['markdown','text']));
    if (formats.length === 0) invalid(fileName, 'turnContract.production.formats 至少需要一个格式。');
    const sources = asArray(fileName, outputSrc.sources, 'turnContract.production.sources').map((e,i) => asEnum(fileName,e,`turnContract.production.sources[${i}]`,PRODUCTION_SOURCES));
    if (sources.length === 0) invalid(fileName, 'turnContract.production.sources 至少需要一个来源。');
    const files = p.files === undefined ? undefined : asArray(fileName,p.files,'turnContract.production.files').map((e,i)=>asSafeId(fileName,e,`turnContract.production.files[${i}]`));
    production = { completionAction: 'finish_production', output: { formats: formats as Array<'markdown'|'text'>, sources: sources as Array<'inline'|'workspace_file'|'current_input_artifact'> }, ...(files ? { files } : {}) };
  }

  let annotate: ValidatedTurnContract['annotate'];
  if (contract.annotate !== undefined && contract.annotate !== null) {
    const a = asRecord(fileName, contract.annotate, 'turnContract.annotate');
    annotate = { files: asArray(fileName,a.files,'turnContract.annotate.files').map((e,i)=>asSafeId(fileName,e,`turnContract.annotate.files[${i}]`)) };
  }
  if (production !== undefined && annotate !== undefined) invalid(fileName, 'turnContract 不能同时声明 production 与 annotate。');
  const dispatch = asRecord(fileName, contract.dispatch, 'turnContract.dispatch');
  const cardinality = dispatch.cardinality === undefined ? 'single' : asEnum(fileName,dispatch.cardinality,'turnContract.dispatch.cardinality',['single']);
  const seen = new Set<string>();
  const allowedActions = asArray(fileName,dispatch.allowedActions,'turnContract.dispatch.allowedActions').map((e,i)=>{
    const intent=asEnum(fileName,e,`turnContract.dispatch.allowedActions[${i}]`,DISPATCH_INTENTS);
    if(seen.has(intent)) invalid(fileName,`turnContract.dispatch.allowedActions 中 ${intent} 重复。`); seen.add(intent); return intent;
  });
  if (allowedActions.length===0) invalid(fileName,'turnContract.dispatch.allowedActions 至少需要一个发送意图。');
  const targets: ValidatedTurnContract['dispatch']['targets'] = {};
  if (dispatch.targets !== undefined && dispatch.targets !== null) {
    const map=asRecord(fileName,dispatch.targets,'turnContract.dispatch.targets');
    for (const [intent,target] of Object.entries(map)) {
      if (!(DISPATCH_INTENTS as readonly string[]).includes(intent)) invalid(fileName,`turnContract.dispatch.targets 包含未知发送意图 ${intent}。`);
      if (!seen.has(intent)) invalid(fileName,`turnContract.dispatch.targets.${intent} 未在 allowedActions 中声明。`);
      if (intent !== 'request_human_input') targets[intent as keyof typeof targets]=asSafeIdList(fileName,target,`turnContract.dispatch.targets.${intent}`);
    }
  }
  const productionPackageRef = dispatch.productionPackageRef === undefined ? undefined : asEnum(fileName,dispatch.productionPackageRef,'turnContract.dispatch.productionPackageRef',['current']);
  if (version === 2 && productionPackageRef !== undefined) invalid(fileName,'v2 turnContract 不得声明 productionPackageRef。');
  if (version === 2 && production === undefined && annotate === undefined && !allowedActions.some((a)=>a !== 'request_human_input')) invalid(fileName,'协调回合必须声明至少一个 dispatch。');
  return { version: version as 1|2, ...(production ? {production} : {}), ...(annotate ? {annotate} : {}), dispatch: { cardinality, allowedActions, targets, ...(productionPackageRef ? {productionPackageRef} : {}) } };
}

export interface ValidatedAgentFile {
  id: string;
  name: string;
  description: string;
  /** Inline system prompt content; empty when `systemPromptFile` is used. */
  systemPrompt: string;
  /** Template-relative prompt file path, or null when the prompt is inline. */
  systemPromptFile: string | null;
  model: string;
  skills: ValidatedAgentSkill[];
  /** Optional JS validator gate; null when the agent declares none. */
  gate: ValidatedAgentGate | null;
  /**
   * Null only in the relaxed historical-snapshot mode: a missing or
   * unsupported contract marks the snapshot non-runnable, never invalid
   * (spec §7.3). Current templates always carry a version-1 contract.
   */
  turnContract: ValidatedTurnContract | null;
}

/** Parses the optional `gate` block of one agent file (plan Phase 2). */
function validateAgentGate(fileName: string, raw: unknown): ValidatedAgentGate {
  const gate = asRecord(fileName, raw, 'gate');
  const validator = asString(fileName, gate.validator, 'gate.validator', { required: true });
  const artifactType = asString(fileName, gate.artifactType, 'gate.artifactType', {
    required: true,
  });
  const mode = asArray(fileName, gate.mode, 'gate.mode');
  if (mode.length === 0) {
    invalid(fileName, 'gate.mode 至少需要一个模式。');
  }
  const seen = new Set<string>();
  const modes = mode.map((entry, index) => {
    const item = asEnum(fileName, entry, `gate.mode[${index}]`, ['self_check', 'commit']);
    if (seen.has(item)) {
      invalid(fileName, `gate.mode 中 ${item} 重复。`);
    }
    seen.add(item);
    return item;
  });
  return {
    validator,
    artifactType,
    mode: modes as Array<'self_check' | 'commit'>,
  };
}

/**
 * Validates one agents/<agent-id>.yaml file, including model identifier
 * format. `turnContractOptional` switches to the historical-snapshot mode:
 * a missing or unsupported `turnContract` folds to null instead of failing,
 * so legacy frozen tasks stay readable (and gateable) instead of corrupt.
 */
export function validateAgentFile(
  fileName: string,
  raw: unknown,
  options: { turnContractOptional?: boolean } = {},
): ValidatedAgentFile {
  const root = asRecord(fileName, raw, fileName);
  const model = asString(fileName, root.model, 'model', { required: true });
  if (!MODEL_ID.test(model)) {
    invalid(fileName, 'model 必须形如 <provider>/<model>。');
  }

  let turnContract: ValidatedTurnContract | null;
  const hasContract =
    'turnContract' in root && root.turnContract !== undefined && root.turnContract !== null;
  if (!hasContract) {
    if (!options.turnContractOptional) {
      invalid(fileName, 'turnContract 必须声明（当前模板契约 version: 1）。');
    }
    turnContract = null;
  } else {
    try {
      turnContract = validateTurnContract(fileName, root.turnContract);
    } catch (error) {
      if (!options.turnContractOptional || !(error instanceof TemplateError)) {
        throw error;
      }
      // Historical snapshot with an unsupported contract: readable, not runnable.
      turnContract = null;
    }
  }

  // System prompt source: exactly one of an inline scalar or a template-relative
  // file reference (plan Phase D Task 1 deviation, backwards compatible). The
  // file content itself is resolved and containment-checked by the loader.
  const inline =
    typeof root.systemPrompt === 'string' && root.systemPrompt.trim() !== ''
      ? root.systemPrompt
      : null;
  const fileRef =
    typeof root.systemPromptFile === 'string' && root.systemPromptFile.trim() !== ''
      ? root.systemPromptFile
      : null;
  if (inline !== null && fileRef !== null) {
    invalid(fileName, 'systemPrompt 与 systemPromptFile 只能提供其一。');
  }
  if (inline === null && fileRef === null) {
    invalid(fileName, 'systemPrompt 或 systemPromptFile 必须提供其一。');
  }

  const seenSkillIds = new Set<string>();
  const skills = ('skills' in root && root.skills !== null
    ? asArray(fileName, root.skills, 'skills')
    : []
  ).map((entry, index) => {
    const skill = asRecord(fileName, entry, `skills[${index}]`);
    const id = asSafeId(fileName, skill.id, `skills[${index}].id`);
    if (seenSkillIds.has(id)) {
      invalid(fileName, `技能 id ${id} 重复。`);
    }
    seenSkillIds.add(id);
    return {
      id,
      name: asString(fileName, skill.name, `skills[${index}].name`, { required: true }),
      description: asString(fileName, skill.description, `skills[${index}].description`, {
        required: false,
      }),
      contentPath: asString(fileName, skill.contentPath, `skills[${index}].contentPath`, {
        required: true,
      }),
      sectionsPath:
        typeof skill.sectionsPath === 'string' && skill.sectionsPath.trim() !== ''
          ? skill.sectionsPath
          : null,
    } satisfies ValidatedAgentSkill;
  });

  // Optional JS validator gate (plan 2026-08-07 Phase 2, spec §4.1): absent
  // folds to null; a declared block is validated fail-closed. The validator
  // file content itself is resolved and containment-checked by the loader.
  const gate =
    'gate' in root && root.gate !== undefined && root.gate !== null
      ? validateAgentGate(fileName, root.gate)
      : null;

  return {
    id: asSafeId(fileName, root.id, 'id'),
    name: asString(fileName, root.name, 'name', { required: true }),
    description: asString(fileName, root.description, 'description', { required: false }),
    systemPrompt: inline ?? '',
    systemPromptFile: fileRef,
    model,
    skills,
    gate,
    turnContract,
  };
}

/** Cross-validates every route endpoint and final submitter against the Agent set. */
export function validateReferences(pipeline: ValidatedPipelineFile, agentIds: ReadonlySet<string>): void {
  const location = 'pipeline.yaml';
  for (const route of pipeline.routes) {
    if (!agentIds.has(route.from)) {
      throw new TemplateError(
        TEMPLATE_ERROR_CODES.TEMPLATE_ROUTE_SOURCE_UNKNOWN,
        `模板 ${location}：连线起点 ${route.from} 不是已声明的 Agent。`,
        location,
        RELOAD_ACTION,
      );
    }
    if (!agentIds.has(route.to)) {
      throw new TemplateError(
        TEMPLATE_ERROR_CODES.TEMPLATE_ROUTE_TARGET_UNKNOWN,
        `模板 ${location}：连线目标 ${route.to} 不是已声明的 Agent。`,
        location,
        RELOAD_ACTION,
      );
    }
  }
  for (const submitter of pipeline.submitters) {
    if (!agentIds.has(submitter)) {
      throw new TemplateError(
        TEMPLATE_ERROR_CODES.TEMPLATE_FINAL_SUBMITTER_UNKNOWN,
        `模板 ${location}：最终出口提交者 ${submitter} 不是已声明的 Agent。`,
        location,
        RELOAD_ACTION,
      );
    }
  }
}

/** Cross-validates every contract dispatch target against the Agent set. */
export function validateTurnContractTargets(
  agents: ReadonlyArray<{ fileName: string; id: string; turnContract: ValidatedTurnContract | null }>,
  agentIds: ReadonlySet<string>,
): void {
  for (const agent of agents) {
    if (agent.turnContract === null) {
      continue; // Historical snapshots carry no contract; nothing to target-check.
    }
    for (const [intent, targetList] of Object.entries(agent.turnContract.dispatch.targets)) {
      if (targetList === undefined) {
        continue;
      }
      for (const target of targetList) {
        if (!agentIds.has(target)) {
          throw new TemplateError(
            TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
            `模板 ${agent.fileName}：回合契约发送目标 ${target}（${intent}）不是已声明的 Agent。`,
            agent.fileName,
            RELOAD_ACTION,
          );
        }
      }
    }
  }
}

/** Enforces one provider namespace across all Agents (format already validated). */
export function validateSingleProviderNamespace(
  models: ReadonlyArray<{ fileName: string; model: string }>,
): void {
  const first = models[0];
  if (first === undefined) {
    return;
  }
  const namespace = first.model.split('/')[0];
  for (const entry of models) {
    if (entry.model.split('/')[0] !== namespace) {
      throw new TemplateError(
        TEMPLATE_ERROR_CODES.TEMPLATE_INVALID,
        `模板 ${entry.fileName}：模型标识属于多个 Provider 命名空间，第一版只支持单一 Provider。`,
        entry.fileName,
        RELOAD_ACTION,
      );
    }
  }
}
