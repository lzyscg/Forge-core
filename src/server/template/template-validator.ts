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

export interface ValidatedRoute {
  from: string;
  to: string;
  kind: 'message' | 'artifact';
  label: string;
}

export interface ValidatedPipelineFile {
  agents: string[];
  routes: ValidatedRoute[];
  submitters: string[];
  /**
   * Optional per-template progress budget (plan 2026-08-06): overrides the
   * scheduler-injected progress policy for every task frozen from this
   * template. Null when the pipeline declares none.
   */
  budget: ProgressPolicy | null;
}

/** Validates pipeline.yaml: deterministic Agent order, routes and final submitters. */
export function validatePipelineFile(fileName: string, raw: unknown): ValidatedPipelineFile {
  const root = asRecord(fileName, raw, 'pipeline.yaml');

  const agents = asArray(fileName, root.agents, 'agents').map((entry, index) =>
    asSafeId(fileName, entry, `agents[${index}]`),
  );
  if (agents.length === 0) {
    invalid(fileName, 'agents 至少需要一个 Agent。');
  }
  const seenAgents = new Set<string>();
  for (const agentId of agents) {
    if (seenAgents.has(agentId)) {
      invalid(fileName, `Agent ${agentId} 在 agents 列表中重复，顺序必须确定。`);
    }
    seenAgents.add(agentId);
  }

  const routes = asArray(fileName, root.routes, 'routes').map((entry, index) => {
    const route = asRecord(fileName, entry, `routes[${index}]`);
    return {
      from: asSafeId(fileName, route.from, `routes[${index}].from`),
      to: asSafeId(fileName, route.to, `routes[${index}].to`),
      kind: asEnum(fileName, route.kind, `routes[${index}].kind`, ['message', 'artifact']),
      label: asString(fileName, route.label, `routes[${index}].label`, { required: false }),
    } satisfies ValidatedRoute;
  });

  const finalOutput = asRecord(fileName, root.finalOutput, 'finalOutput');
  const submitters = asArray(fileName, finalOutput.submitters, 'finalOutput.submitters').map(
    (entry, index) => asSafeId(fileName, entry, `finalOutput.submitters[${index}]`),
  );
  if (submitters.length === 0) {
    invalid(fileName, 'finalOutput.submitters 至少需要一个 Agent。');
  }
  const seenSubmitters = new Set<string>();
  for (const submitter of submitters) {
    if (seenSubmitters.has(submitter)) {
      invalid(fileName, `finalOutput.submitters 中 ${submitter} 重复。`);
    }
    seenSubmitters.add(submitter);
  }

  // Optional progress budget: an integer turn count within the platform
  // ceiling, with exactly the one declared key (plan 2026-08-06).
  let budget: ProgressPolicy | null = null;
  if ('budget' in root && root.budget !== undefined && root.budget !== null) {
    const budgetRecord = asRecord(fileName, root.budget, 'budget');
    for (const key of Object.keys(budgetRecord)) {
      if (key !== 'maxTurnsSinceHumanAnswer') {
        invalid(fileName, `budget 只能声明 maxTurnsSinceHumanAnswer，未知键 ${key}。`);
      }
    }
    const turns = budgetRecord.maxTurnsSinceHumanAnswer;
    if (typeof turns !== 'number' || !Number.isInteger(turns)) {
      invalid(fileName, 'budget.maxTurnsSinceHumanAnswer 必须是整数。');
    }
    if (turns < 1 || turns > PROGRESS_POLICY_CEILING) {
      invalid(
        fileName,
        `budget.maxTurnsSinceHumanAnswer 必须在 1 到 ${PROGRESS_POLICY_CEILING} 之间。`,
      );
    }
    budget = Object.freeze({ maxTurnsSinceHumanAnswer: turns });
  }

  return { agents, routes, submitters, budget };
}

export interface ValidatedAgentSkill {
  id: string;
  name: string;
  description: string;
  contentPath: string;
}

/** Structural shape of one validated turn contract (spec §6). */
export interface ValidatedTurnContract {
  version: 1;
  production: {
    completionAction: 'finish_production';
    output: {
      formats: Array<'markdown' | 'text'>;
      sources: Array<'inline' | 'workspace_file' | 'current_input_artifact'>;
    };
  };
  dispatch: {
    cardinality: 'single';
    allowedActions: Array<'send_message' | 'publish_artifact' | 'submit_final_artifact'>;
    /**
     * Candidate target sets per dispatch intent (plan 2026-08-06): one
     * dispatch action per turn still, but its target may be any agent in the
     * declared set. Scalar YAML declarations normalize to one-element sets.
     */
    targets: Partial<
      Record<'send_message' | 'publish_artifact' | 'submit_final_artifact', string[]>
    >;
    productionPackageRef: 'current';
  };
}

const PRODUCTION_SOURCES = ['inline', 'workspace_file', 'current_input_artifact'] as const;

const DISPATCH_INTENTS = ['send_message', 'publish_artifact', 'submit_final_artifact'] as const;

/** Validates the required `turnContract` block of one agent file (spec §6). */
function validateTurnContract(fileName: string, raw: unknown): ValidatedTurnContract {
  const contract = asRecord(fileName, raw, 'turnContract');

  if (contract.version !== 1) {
    invalid(fileName, 'turnContract.version 目前仅支持 1。');
  }

  const production = asRecord(fileName, contract.production, 'turnContract.production');
  const completionAction = asString(
    fileName,
    production.completionAction,
    'turnContract.production.completionAction',
    { required: true },
  );
  if (completionAction !== 'finish_production') {
    invalid(fileName, 'turnContract.production.completionAction 仅支持 finish_production。');
  }
  const output = asRecord(fileName, production.output, 'turnContract.production.output');
  const formats = asArray(fileName, output.formats, 'turnContract.production.output.formats').map(
    (entry, index) =>
      asEnum(fileName, entry, `turnContract.production.output.formats[${index}]`, [
        'markdown',
        'text',
      ]),
  );
  if (formats.length === 0) {
    invalid(fileName, 'turnContract.production.output.formats 至少需要一个格式。');
  }
  const sources = asArray(fileName, output.sources, 'turnContract.production.output.sources').map(
    (entry, index) =>
      asEnum(fileName, entry, `turnContract.production.output.sources[${index}]`, PRODUCTION_SOURCES),
  );
  if (sources.length === 0) {
    invalid(fileName, 'turnContract.production.output.sources 至少需要一个来源。');
  }

  const dispatch = asRecord(fileName, contract.dispatch, 'turnContract.dispatch');
  const cardinality = asString(fileName, dispatch.cardinality, 'turnContract.dispatch.cardinality', {
    required: true,
  });
  if (cardinality !== 'single') {
    invalid(fileName, 'turnContract.dispatch.cardinality 仅支持 single。');
  }
  const seenActions = new Set<string>();
  const allowedActions = asArray(
    fileName,
    dispatch.allowedActions,
    'turnContract.dispatch.allowedActions',
  ).map((entry, index) => {
    const intent = asEnum(
      fileName,
      entry,
      `turnContract.dispatch.allowedActions[${index}]`,
      DISPATCH_INTENTS,
    );
    if (seenActions.has(intent)) {
      invalid(fileName, `turnContract.dispatch.allowedActions 中 ${intent} 重复。`);
    }
    seenActions.add(intent);
    return intent;
  });
  if (allowedActions.length === 0) {
    invalid(fileName, 'turnContract.dispatch.allowedActions 至少需要一个发送意图。');
  }

  const targets: ValidatedTurnContract['dispatch']['targets'] = {};
  if ('targets' in dispatch && dispatch.targets !== undefined && dispatch.targets !== null) {
    const targetMap = asRecord(fileName, dispatch.targets, 'turnContract.dispatch.targets');
    for (const [intent, target] of Object.entries(targetMap)) {
      if (!(DISPATCH_INTENTS as readonly string[]).includes(intent)) {
        invalid(fileName, `turnContract.dispatch.targets 包含未知发送意图 ${intent}。`);
      }
      if (!seenActions.has(intent)) {
        invalid(fileName, `turnContract.dispatch.targets.${intent} 未在 allowedActions 中声明。`);
      }
      targets[intent as keyof typeof targets] = asSafeIdList(
        fileName,
        target,
        `turnContract.dispatch.targets.${intent}`,
      );
    }
  }

  const productionPackageRef = asString(
    fileName,
    dispatch.productionPackageRef,
    'turnContract.dispatch.productionPackageRef',
    { required: true },
  );
  if (productionPackageRef !== 'current') {
    invalid(fileName, "turnContract.dispatch.productionPackageRef 仅支持 'current'。");
  }

  return {
    version: 1,
    production: {
      completionAction: 'finish_production',
      output: {
        formats: formats as Array<'markdown' | 'text'>,
        sources: sources as Array<'inline' | 'workspace_file' | 'current_input_artifact'>,
      },
    },
    dispatch: {
      cardinality: 'single',
      allowedActions,
      targets,
      productionPackageRef: 'current',
    },
  };
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
  /**
   * Null only in the relaxed historical-snapshot mode: a missing or
   * unsupported contract marks the snapshot non-runnable, never invalid
   * (spec §7.3). Current templates always carry a version-1 contract.
   */
  turnContract: ValidatedTurnContract | null;
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
    } satisfies ValidatedAgentSkill;
  });

  return {
    id: asSafeId(fileName, root.id, 'id'),
    name: asString(fileName, root.name, 'name', { required: true }),
    description: asString(fileName, root.description, 'description', { required: false }),
    systemPrompt: inline ?? '',
    systemPromptFile: fileRef,
    model,
    skills,
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
