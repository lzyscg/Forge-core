/**
 * The closed Forge production action registry (plan Phase C Task 1 Steps
 * 1/4, spec §6.1; reshaped by plan 2026-08-04 Task 1 for the
 * production/dispatch turn contract, spec §4.3/§5.1/§5.2). Exactly six
 * actions exist platform-wide; templates never plug in local commands,
 * scripts, MCP or arbitrary external tools.
 *
 * Turn contract shape: one turn seals exactly one production package via
 * `finish_production` (inline content, a private workspace file, or a
 * platform-resolved reference to the turn's received input artifact) and
 * then performs exactly one dispatch action that references the sealed
 * package with `productionPackageRef: 'current'`. Dispatch actions carry
 * no content or artifact metadata — everything delivered comes from the
 * sealed package. Phase order, cardinality, route and contract checks are
 * enforced by the ActionBuffer (immediate, model-correctable) and the
 * ActionCommitter (atomic, non-bypassable); this module validates shapes
 * only.
 *
 * `validateForgeAction` enforces the runtime-action boundary (spec §6.2):
 * actions carry only non-empty, bounded content fields — question/title
 * ≤ 16 KiB, package content ≤ 2 MiB, identifiers ≤ 128 characters — and
 * never engineering metadata: any object presenting a task id, event id,
 * version, timestamp or filesystem-path key is rejected outright. Those
 * values are assigned by the platform at commit time, never by the model
 * (iron rule 1).
 */

import { isAbsolute } from 'node:path';

export type ForgeActionName =
  | 'load_skill'
  | 'finish_production'
  | 'send_message'
  | 'publish_artifact'
  | 'submit_final_artifact'
  | 'request_human_input';

/**
 * The closed six-name registry. Typed as a plain array so the verbatim
 * contract test may call `.sort()`; consumers must treat it as read-only —
 * `FORGE_ACTION_NAME_SET` is the frozen membership view used internally.
 */
export const FORGE_ACTION_NAMES: ForgeActionName[] = [
  'load_skill',
  'finish_production',
  'send_message',
  'publish_artifact',
  'submit_final_artifact',
  'request_human_input',
];

/** Frozen membership view of the closed registry. */
export const FORGE_ACTION_NAME_SET: ReadonlySet<ForgeActionName> = new Set(FORGE_ACTION_NAMES);

/** The one production-package reference a dispatch action may carry. */
export const PRODUCTION_PACKAGE_REF = 'current' as const;

/** Where a sealed production package's content comes from (spec §4.3). */
export type ProductionSource = 'inline' | 'workspace_file' | 'current_input_artifact';

/** Discriminated union of every action a model Turn may propose (verbatim). */
export type ForgeAction =
  | { type: 'load_skill'; skillId: string }
  | {
      type: 'finish_production';
      source: 'inline';
      /** Sealed package body; resolved from the model's own production. */
      content: string;
      format: 'markdown' | 'text';
      /** Publication metadata; null for packages only routed as messages. */
      artifactType: string | null;
      title: string | null;
    }
  | {
      type: 'finish_production';
      source: 'workspace_file';
      /** Relative private-workspace file; resolved to content before commit. */
      workspaceFile: string;
      format: 'markdown' | 'text';
      artifactType: string | null;
      title: string | null;
    }
  | {
      type: 'finish_production';
      /**
       * Seals the artifact received with the current input node. The
       * platform resolves the reference; the model never supplies versions.
       */
      source: 'current_input_artifact';
    }
  | { type: 'send_message'; targetAgentId: string; productionPackageRef: typeof PRODUCTION_PACKAGE_REF }
  | { type: 'publish_artifact'; productionPackageRef: typeof PRODUCTION_PACKAGE_REF }
  | { type: 'submit_final_artifact'; productionPackageRef: typeof PRODUCTION_PACKAGE_REF }
  | { type: 'request_human_input'; question: string };

/** The four actions that end the production phase and deliver the package. */
export type DispatchAction = Extract<
  ForgeAction,
  { type: 'send_message' } | { type: 'publish_artifact' } | { type: 'submit_final_artifact' } | { type: 'request_human_input' }
>;

export type DispatchActionName = DispatchAction['type'];

/** Bounded field sizes for runtime actions (character counts). */
export const FORGE_ACTION_LIMITS = {
  /** question / title */
  shortText: 16 * 1024,
  /** package content */
  content: 2 * 1024 * 1024,
  /** skillId / targetAgentId / artifactType */
  id: 128,
} as const;

/** Maximum length of a sealed `workspaceFile` relative-path reference. */
export const PUBLISH_WORKSPACE_FILE_MAX_LENGTH = 512;

/**
 * Engineering keys that runtime actions must never carry. Versions, ids,
 * timestamps and paths are platform-assigned at commit time (iron rule 1).
 */
export const FORBIDDEN_ACTION_KEYS = [
  'taskId',
  'eventId',
  'version',
  'timestamp',
  'path',
  'filePath',
  'contentPath',
] as const;

export const ACTION_VALIDATION_CODES = {
  ACTION_NOT_OBJECT: 'ACTION_NOT_OBJECT',
  ACTION_TYPE_UNKNOWN: 'ACTION_TYPE_UNKNOWN',
  ACTION_FORBIDDEN_KEY: 'ACTION_FORBIDDEN_KEY',
  ACTION_UNKNOWN_KEY: 'ACTION_UNKNOWN_KEY',
  ACTION_FIELD_INVALID: 'ACTION_FIELD_INVALID',
} as const;

export type ActionValidationCode =
  (typeof ACTION_VALIDATION_CODES)[keyof typeof ACTION_VALIDATION_CODES];

/** Typed validation failure with a stable, presentable code. */
export class ForgeActionValidationError extends Error {
  readonly code: ActionValidationCode;

  constructor(code: ActionValidationCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ForgeActionValidationError';
    this.code = code;
  }
}

function invalidField(action: ForgeActionName, field: string, detail: string): never {
  throw new ForgeActionValidationError(
    ACTION_VALIDATION_CODES.ACTION_FIELD_INVALID,
    `${action}.${field} ${detail}`,
  );
}

function requireString(
  action: ForgeActionName,
  field: string,
  value: unknown,
  maxLength: number,
): string {
  if (typeof value !== 'string') {
    invalidField(action, field, 'must be a string');
  }
  if (value.length === 0) {
    invalidField(action, field, 'must not be empty');
  }
  if (value.length > maxLength) {
    invalidField(action, field, `exceeds the ${maxLength} character limit`);
  }
  return value;
}

/** A bounded string or null; absent fields default to null. */
function optionalString(
  action: ForgeActionName,
  field: string,
  value: unknown,
  maxLength: number,
): string | null {
  const resolved = value === undefined ? null : value;
  if (resolved === null) {
    return null;
  }
  return requireString(action, field, resolved, maxLength);
}

function assertOnlyKeys(action: ForgeActionName, obj: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new ForgeActionValidationError(
        ACTION_VALIDATION_CODES.ACTION_UNKNOWN_KEY,
        `${action} does not accept the key '${key}'`,
      );
    }
  }
}

/**
 * Validates a sealed `workspaceFile` reference at the action boundary: a
 * non-empty relative path of bounded length with no `..` segment. Deeper
 * containment/safety checks happen where the file is resolved (plan Task E3).
 */
function assertWorkspaceFileRef(value: unknown): string {
  if (typeof value !== 'string') {
    invalidField('finish_production', 'workspaceFile', 'must be a string');
  }
  if (value.length === 0) {
    invalidField('finish_production', 'workspaceFile', 'must not be empty');
  }
  if (value.length > PUBLISH_WORKSPACE_FILE_MAX_LENGTH) {
    invalidField(
      'finish_production',
      'workspaceFile',
      `exceeds the ${PUBLISH_WORKSPACE_FILE_MAX_LENGTH} character limit`,
    );
  }
  if (isAbsolute(value)) {
    invalidField('finish_production', 'workspaceFile', 'must be a relative workspace path');
  }
  if (value.split('/').some((segment) => segment === '..')) {
    invalidField('finish_production', 'workspaceFile', "must not contain '..' segments");
  }
  return value;
}

function assertFormat(action: ForgeActionName, value: unknown): 'markdown' | 'text' {
  const resolved = value === undefined ? 'markdown' : value;
  if (resolved !== 'markdown' && resolved !== 'text') {
    invalidField(action, 'format', "must be 'markdown' or 'text'");
  }
  return resolved;
}

/** Dispatch actions reference the sealed package with exactly `current`. */
function assertProductionPackageRef(action: ForgeActionName, value: unknown): typeof PRODUCTION_PACKAGE_REF {
  if (value !== PRODUCTION_PACKAGE_REF) {
    invalidField(action, 'productionPackageRef', "must be exactly 'current'");
  }
  return PRODUCTION_PACKAGE_REF;
}

function validateFinishProduction(obj: Record<string, unknown>): ForgeAction {
  const action: ForgeActionName = 'finish_production';
  const source = obj.source;
  if (source === 'inline') {
    assertOnlyKeys(action, obj, ['type', 'source', 'content', 'format', 'artifactType', 'title']);
    return {
      type: action,
      source,
      content: requireString(action, 'content', obj.content, FORGE_ACTION_LIMITS.content),
      format: assertFormat(action, obj.format),
      artifactType: optionalString(action, 'artifactType', obj.artifactType, FORGE_ACTION_LIMITS.id),
      title: optionalString(action, 'title', obj.title, FORGE_ACTION_LIMITS.shortText),
    };
  }
  if (source === 'workspace_file') {
    assertOnlyKeys(action, obj, ['type', 'source', 'workspaceFile', 'format', 'artifactType', 'title']);
    return {
      type: action,
      source,
      workspaceFile: assertWorkspaceFileRef(obj.workspaceFile),
      format: assertFormat(action, obj.format),
      artifactType: optionalString(action, 'artifactType', obj.artifactType, FORGE_ACTION_LIMITS.id),
      title: optionalString(action, 'title', obj.title, FORGE_ACTION_LIMITS.shortText),
    };
  }
  if (source === 'current_input_artifact') {
    assertOnlyKeys(action, obj, ['type', 'source']);
    return { type: action, source };
  }
  invalidField(action, 'source', "must be 'inline', 'workspace_file' or 'current_input_artifact'");
}

/**
 * Validates unknown model output into a `ForgeAction`, failing loud with a
 * typed, stable-coded error for anything outside the closed boundary.
 */
export function validateForgeAction(input: unknown): ForgeAction {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ForgeActionValidationError(
      ACTION_VALIDATION_CODES.ACTION_NOT_OBJECT,
      'a Forge action must be a plain object',
    );
  }
  const obj = input as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== 'string' || !FORGE_ACTION_NAME_SET.has(type as ForgeActionName)) {
    throw new ForgeActionValidationError(
      ACTION_VALIDATION_CODES.ACTION_TYPE_UNKNOWN,
      `unknown Forge action type '${String(type)}'; expected one of: ${FORGE_ACTION_NAMES.join(', ')}`,
    );
  }
  const action = type as ForgeActionName;
  for (const key of FORBIDDEN_ACTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new ForgeActionValidationError(
        ACTION_VALIDATION_CODES.ACTION_FORBIDDEN_KEY,
        `${action} must not carry the engineering key '${key}'`,
      );
    }
  }
  switch (action) {
    case 'load_skill': {
      assertOnlyKeys(action, obj, ['type', 'skillId']);
      return { type: action, skillId: requireString(action, 'skillId', obj.skillId, FORGE_ACTION_LIMITS.id) };
    }
    case 'finish_production': {
      return validateFinishProduction(obj);
    }
    case 'send_message': {
      assertOnlyKeys(action, obj, ['type', 'targetAgentId', 'productionPackageRef']);
      return {
        type: action,
        targetAgentId: requireString(action, 'targetAgentId', obj.targetAgentId, FORGE_ACTION_LIMITS.id),
        productionPackageRef: assertProductionPackageRef(action, obj.productionPackageRef),
      };
    }
    case 'publish_artifact': {
      assertOnlyKeys(action, obj, ['type', 'productionPackageRef']);
      return {
        type: action,
        productionPackageRef: assertProductionPackageRef(action, obj.productionPackageRef),
      };
    }
    case 'submit_final_artifact': {
      assertOnlyKeys(action, obj, ['type', 'productionPackageRef']);
      return {
        type: action,
        productionPackageRef: assertProductionPackageRef(action, obj.productionPackageRef),
      };
    }
    case 'request_human_input': {
      assertOnlyKeys(action, obj, ['type', 'question']);
      return { type: action, question: requireString(action, 'question', obj.question, FORGE_ACTION_LIMITS.shortText) };
    }
    default: {
      // Exhaustiveness guard: the registry and this switch must stay aligned.
      const unreachable: never = action;
      throw new ForgeActionValidationError(
        ACTION_VALIDATION_CODES.ACTION_TYPE_UNKNOWN,
        `unhandled Forge action '${String(unreachable)}'`,
      );
    }
  }
}
