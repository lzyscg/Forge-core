/**
 * The closed Forge production action registry (plan 2026-08-07 Phase 2; v7
 * artifact version directory schema). Exactly nine actions exist
 * platform-wide; templates never plug in local commands, scripts, MCP or
 * arbitrary external tools.
 *
 * v7 reshapes the v1 sealed-package model into the production/operate split
 * (spec §4):
 * - `finish_production(files)` seals a multi-file production package (the
 *   only seal action; production turns only). `current_input_artifact` is no
 *   longer a finish source — `submit_final_artifact` resolves the submitted
 *   version directly from the input node's `inputVersion`.
 * - `publish_artifact` publishes the sealed package along every declared
 *   artifact edge of the publisher (production turns only).
 * - `annotate_artifact(file, content)` annotates one file of the input
 *   version (operate turns; atomic, unique per (version, file)).
 * - `forward_input_version(targetAgentId)` forwards the input version along
 *   one artifact edge (operate turns; zero-copy).
 * - `send_message(targetAgentId, summary)` delivers a short coordination
 *   message (operate/coordinate turns; the body is the summary, not a sealed
 *   package).
 * - `submit_final_artifact` submits the input version as the final output
 *   (operate/coordinate turns; zero-copy from inputVersion).
 * - `request_human_input(question)` interrupts any turn.
 * - `read_artifact_version(file)` is a read-only tool (returns content, never
 *   buffered or committed).
 *
 * Dispatch actions carry no `productionPackageRef` and no content/metadata of
 * their own — everything published comes from the sealed `finish_production`
 * package; everything submitted/forwarded comes from the inputVersion.
 * `validateForgeAction` enforces the runtime-action boundary (spec §6.2):
 * actions carry only non-empty, bounded content fields and never engineering
 * metadata (task/event ids, versions, timestamps, paths) — those are
 * platform-assigned at commit time (iron rule 1).
 */
import { isAbsolute } from 'node:path';

export type ForgeActionName =
  | 'load_skill'
  | 'finish_production'
  | 'annotate_artifact'
  | 'read_artifact_version'
  | 'publish_artifact'
  | 'forward_input_version'
  | 'submit_final_artifact'
  | 'send_message'
  | 'request_human_input';

/**
 * The closed nine-name registry. Typed as a plain array so the verbatim
 * contract test may call `.sort()`; consumers must treat it as read-only.
 */
export const FORGE_ACTION_NAMES: ForgeActionName[] = [
  'load_skill',
  'finish_production',
  'annotate_artifact',
  'read_artifact_version',
  'publish_artifact',
  'forward_input_version',
  'submit_final_artifact',
  'send_message',
  'request_human_input',
];

/** Frozen membership view of the closed registry. */
export const FORGE_ACTION_NAME_SET: ReadonlySet<ForgeActionName> = new Set(FORGE_ACTION_NAMES);

/** Where a sealed production file's content comes from (spec §15). */
export type ProductionSource = 'inline' | 'workspace_file';

/** One file a `finish_production` package seals. */
export interface FinishFile {
  name: string;
  /** Present for `inline` sources; resolved by the runner for `workspace_file`. */
  content?: string;
  /** Present for `workspace_file` sources; resolved to content before commit. */
  workspaceFile?: string;
}

/** The dispatch kind a turn performed (spec §8.2). */
export type DispatchKind = 'publish' | 'forward' | 'send' | 'submit' | 'human';

/** Discriminated union of every action a model Turn may propose (verbatim). */
export type ForgeAction =
  | { type: 'load_skill'; skillId: string }
  | {
      type: 'finish_production';
      source: 'inline';
      files: FinishFile[];
      format: 'markdown' | 'text';
      artifactType: string | null;
      title: string | null;
    }
  | {
      type: 'finish_production';
      source: 'workspace_file';
      files: FinishFile[];
      format: 'markdown' | 'text';
      artifactType: string | null;
      title: string | null;
    }
  | { type: 'annotate_artifact'; file: string; content: string }
  | { type: 'read_artifact_version'; file: string }
  | { type: 'publish_artifact' }
  | { type: 'forward_input_version'; targetAgentId: string }
  | { type: 'submit_final_artifact' }
  | { type: 'send_message'; targetAgentId: string; summary: string }
  | { type: 'request_human_input'; question: string };

/** The five actions that end a turn as its one dispatch. */
export type DispatchAction = Extract<
  ForgeAction,
  | { type: 'publish_artifact' }
  | { type: 'forward_input_version' }
  | { type: 'submit_final_artifact' }
  | { type: 'send_message' }
  | { type: 'request_human_input' }
>;

export type DispatchActionName = DispatchAction['type'];

/** `request_human_input` may interrupt as the sole first action or after seal. */
export type InterruptAction = Extract<ForgeAction, { type: 'request_human_input' }>;

/** Bounded field sizes for runtime actions (character counts). */
export const FORGE_ACTION_LIMITS = {
  /** question / title / summary */
  shortText: 16 * 1024,
  /** package content (per file) */
  content: 2 * 1024 * 1024,
  /** skillId / targetAgentId / artifactType / file name */
  id: 128,
} as const;

/** Maximum length of a sealed `workspaceFile` relative-path reference. */
export const PUBLISH_WORKSPACE_FILE_MAX_LENGTH = 512;

/** Maximum number of files one `finish_production` may seal. */
export const MAX_FINISH_FILES = 16;

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
 * Validates a sealed `workspaceFile` reference: a non-empty relative path of
 * bounded length with no `..` segment. Deeper containment checks happen where
 * the file is resolved.
 */
function assertWorkspaceFileRef(action: ForgeActionName, value: unknown): string {
  if (typeof value !== 'string') {
    invalidField(action, 'workspaceFile', 'must be a string');
  }
  if (value.length === 0) {
    invalidField(action, 'workspaceFile', 'must not be empty');
  }
  if (value.length > PUBLISH_WORKSPACE_FILE_MAX_LENGTH) {
    invalidField(
      action,
      'workspaceFile',
      `exceeds the ${PUBLISH_WORKSPACE_FILE_MAX_LENGTH} character limit`,
    );
  }
  if (isAbsolute(value)) {
    invalidField(action, 'workspaceFile', 'must be a relative workspace path');
  }
  if (value.split('/').some((segment) => segment === '..')) {
    invalidField(action, 'workspaceFile', "must not contain '..' segments");
  }
  return value;
}

/** A safe, single-segment file name (no traversal, no reserved names). */
function assertFileName(action: ForgeActionName, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalidField(action, field, 'must be a non-empty file name');
  }
  if (value.includes('/') || value.includes('\\') || value.includes('..') || value === 'meta.json') {
    invalidField(action, field, 'must be a plain file name');
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

/** Validates the files array of a `finish_production` package. */
function validateFinishFiles(
  action: ForgeActionName,
  source: 'inline' | 'workspace_file',
  raw: unknown,
): FinishFile[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    invalidField(action, 'files', 'must be a non-empty array');
  }
  if (raw.length > MAX_FINISH_FILES) {
    invalidField(action, 'files', `exceeds the ${MAX_FINISH_FILES} file limit`);
  }
  const seen = new Set<string>();
  const files: FinishFile[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      invalidField(action, 'files', 'entries must be objects');
    }
    const obj = entry as Record<string, unknown>;
    assertOnlyKeys(action, obj, ['name', 'content', 'workspaceFile']);
    const name = assertFileName(action, 'files.name', obj.name);
    if (seen.has(name)) {
      invalidField(action, 'files', 'names must be unique');
    }
    seen.add(name);
    if (source === 'inline') {
      const content = requireString(action, 'files.content', obj.content, FORGE_ACTION_LIMITS.content);
      files.push({ name, content });
    } else {
      const workspaceFile = assertWorkspaceFileRef(action, obj.workspaceFile);
      files.push({ name, workspaceFile });
    }
  }
  return files;
}

function validateFinishProduction(obj: Record<string, unknown>): ForgeAction {
  const action: ForgeActionName = 'finish_production';
  const source = obj.source === 'workspace_file' ? 'workspace_file' : 'inline';
  if (obj.source !== undefined && source !== obj.source && obj.source !== 'inline') {
    invalidField(action, 'source', "must be 'inline' or 'workspace_file'");
  }
  assertOnlyKeys(action, obj, ['type', 'source', 'files', 'format', 'artifactType', 'title']);
  const files = validateFinishFiles(action, source, obj.files);
  const format = assertFormat(action, obj.format);
  const artifactType = optionalString(action, 'artifactType', obj.artifactType, FORGE_ACTION_LIMITS.id);
  const title = optionalString(action, 'title', obj.title, FORGE_ACTION_LIMITS.shortText);
  return { type: action, source, files, format, artifactType, title };
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
    case 'annotate_artifact': {
      assertOnlyKeys(action, obj, ['type', 'file', 'content']);
      return {
        type: action,
        file: assertFileName(action, 'file', obj.file),
        content: requireString(action, 'content', obj.content, FORGE_ACTION_LIMITS.content),
      };
    }
    case 'read_artifact_version': {
      assertOnlyKeys(action, obj, ['type', 'file']);
      return { type: action, file: assertFileName(action, 'file', obj.file) };
    }
    case 'publish_artifact': {
      assertOnlyKeys(action, obj, ['type']);
      return { type: action };
    }
    case 'forward_input_version': {
      assertOnlyKeys(action, obj, ['type', 'targetAgentId']);
      return {
        type: action,
        targetAgentId: requireString(action, 'targetAgentId', obj.targetAgentId, FORGE_ACTION_LIMITS.id),
      };
    }
    case 'submit_final_artifact': {
      assertOnlyKeys(action, obj, ['type']);
      return { type: action };
    }
    case 'send_message': {
      assertOnlyKeys(action, obj, ['type', 'targetAgentId', 'summary']);
      return {
        type: action,
        targetAgentId: requireString(action, 'targetAgentId', obj.targetAgentId, FORGE_ACTION_LIMITS.id),
        summary: requireString(action, 'summary', obj.summary, FORGE_ACTION_LIMITS.shortText),
      };
    }
    case 'request_human_input': {
      assertOnlyKeys(action, obj, ['type', 'question']);
      return { type: action, question: requireString(action, 'question', obj.question, FORGE_ACTION_LIMITS.shortText) };
    }
    default: {
      const unreachable: never = action;
      throw new ForgeActionValidationError(
        ACTION_VALIDATION_CODES.ACTION_TYPE_UNKNOWN,
        `unhandled Forge action '${String(unreachable)}'`,
      );
    }
  }
}
