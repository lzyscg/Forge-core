/**
 * Structured Slot contract v1 compiler + resource manifest (Task 4).
 *
 * Reads `slots/contract.yaml` under a template package root, validates it
 * fail-closed against the exact v1 shape (spec §3.3 / design A01), compiles
 * the Slot schemas (Task 2), the LayoutGrammar (Task 3), access profiles
 * (spec §8.3), validator registrations (design E01), the single assembler
 * (design E06), and all 28 limits with their cross-field relations and the
 * platform hard-ceiling profile assertion (spec §5 / design §7.6). It then
 * builds a sorted `{logicalPath, sha256, byteLength}` resource manifest,
 * rejecting every containment violation (design A02), and computes a semantic
 * digest over the normalized contract + resource contents + ABI/profile
 * identity — never absolute paths or mtimes (design A03).
 *
 * Error codes are stable and registered in the Task 1 issue registry:
 * `SLOTS_CONTRACT_INVALID` (shape / limits / profile), `SLOTS_REFERENCE_UNKNOWN`
 * (selector typeIds referencing an undeclared type) and `SLOTS_RESOURCE_INVALID`
 * (path format, symlink, non-regular, missing, outside-root or unreferenced
 * files). The Task 2/3 compilers throw their own registered codes
 * (`SPEC_SCHEMA_INVALID`, `LAYOUT_GRAMMAR_*`) and are deliberately not
 * re-wrapped. This module contains no business vocabulary; fixture words like
 * document/title/body live only in the fixture subtree.
 *
 * The loader is Task 5's concern: this module neither touches `FrozenTemplate`
 * nor accepts a full structured template package.
 */
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import type { StructuredSlotLimitsV1 } from '../../shared/structured-slots';
import { canonicalJsonSha256 } from '../structured-slots/canonical-json';
import { compileLayoutGrammarV1, type CompiledLayoutGrammarV1, type LayoutGrammarV1 } from '../structured-slots/layout-grammar';
import { compileSlotSchemaV1, type CompiledSlotSchemaV1 } from '../structured-slots/slot-schema';

/** Error codes (registered in src/server/structured-slots/issues.ts). */
const CONTRACT_INVALID = 'SLOTS_CONTRACT_INVALID';
const REFERENCE_UNKNOWN = 'SLOTS_REFERENCE_UNKNOWN';
const RESOURCE_INVALID = 'SLOTS_RESOURCE_INVALID';

/** Contract file is always `slots/contract.yaml` relative to the template root. */
const CONTRACT_FILE = 'slots/contract.yaml';

/** The only directories a contract may reference resources from (design A02). */
const VALIDATOR_ROOT = 'slots/validators/';
const ASSEMBLER_ROOT = 'slots/assembler/';

function contractInvalid(reason: string): never {
  throw new Error(`${CONTRACT_INVALID}: ${reason}`);
}
function referenceUnknown(reason: string): never {
  throw new Error(`${REFERENCE_UNKNOWN}: ${reason}`);
}
function resourceInvalid(reason: string): never {
  throw new Error(`${RESOURCE_INVALID}: ${reason}`);
}

/** Static write target / read scope selector (spec §8.3 / design §10.5). */
export type SlotTargetSelectorV1 =
  | { kind: 'all' }
  | { kind: 'root' }
  | { kind: 'types'; typeIds: string[] };

/** Access profile v1 (spec §8.3). */
export interface AccessProfileV1 {
  id: string;
  read: Array<{
    targets: SlotTargetSelectorV1;
    targetLevel: 'outline' | 'spec' | 'content';
    context: {
      level: 'outline' | 'spec' | 'content';
      ancestors: number;
      descendants: number;
      directSiblings: boolean;
    };
  }>;
  writeContent: Array<{ targets: SlotTargetSelectorV1 }>;
  continuity: { precedingFilled: boolean };
}

/** Registered validator v1 (design E01). */
export interface ValidatorRegistrationV1 {
  id: string;
  scope: 'slot' | 'subtree' | 'scaffold';
  trigger: 'merge-and-seal' | 'seal';
  enforcement: 'blocking' | 'advisory';
  selector: SlotTargetSelectorV1;
  implementation: { abi: 'forge-validator/v1'; path: string };
  budget: { cpuMs: number; timeoutMs: number; memoryMiB: number };
}

/** One assembler output route (design E06). */
export interface AssemblerRouteV1 {
  id: string;
  artifactFile: string;
}

/** The single assembler registration v1 (design E06). */
export interface AssemblerRegistrationV1 {
  id: string;
  implementation: { abi: 'forge-assembler/v1'; path: string };
  budget: { cpuMs: number; timeoutMs: number; memoryMiB: number };
  routes: AssemblerRouteV1[];
}

/** One manifest entry: content-addressed, logical (never absolute) path. */
export interface ResourceManifestEntryV1 {
  logicalPath: string;
  sha256: string;
  byteLength: number;
}

/** Compiled slot type with its compiled spec/content schemas (spec §4.2). */
export interface FrozenSlotTypeV1 {
  id: string;
  name: string;
  description: string;
  specSchema: CompiledSlotSchemaV1;
  content:
    | { presence: 'forbidden' }
    | { presence: 'optional'; schema: CompiledSlotSchemaV1 }
    | { presence: 'required'; schema: CompiledSlotSchemaV1 };
}

/** ABI + platform profile identities carried by the frozen contract (design A03/A05). */
export interface AbiProfileIdentityV1 {
  validatorAbi: 'forge-validator/v1';
  assemblerAbi: 'forge-assembler/v1';
  profileIdentity: 'forge-structured-runtime/v1';
}

/** Immutable compiled structured-slot contract. */
export interface FrozenStructuredSlotContractV1 {
  version: 1;
  slotTypes: FrozenSlotTypeV1[];
  layoutGrammar: CompiledLayoutGrammarV1;
  accessProfiles: AccessProfileV1[];
  validators: ValidatorRegistrationV1[];
  assembler: AssemblerRegistrationV1;
  limits: StructuredSlotLimitsV1;
  resourceManifest: ResourceManifestEntryV1[];
  abiProfileIdentity: AbiProfileIdentityV1;
  semanticDigest: string;
}

const TOP_LEVEL_FIELDS = [
  'version',
  'slotTypes',
  'layoutGrammar',
  'accessProfiles',
  'validators',
  'assembler',
  'limits',
] as const;

const SLOT_TYPE_FIELDS = ['id', 'name', 'description', 'specSchema', 'content'] as const;
const CONTENT_FIELDS = ['presence', 'schema'] as const;
const PROFILE_FIELDS = ['id', 'read', 'writeContent', 'continuity'] as const;
const READ_RULE_FIELDS = ['targets', 'targetLevel', 'context'] as const;
const READ_CONTEXT_FIELDS = ['level', 'ancestors', 'descendants', 'directSiblings'] as const;
const WRITE_RULE_FIELDS = ['targets'] as const;
const CONTINUITY_FIELDS = ['precedingFilled'] as const;
const VALIDATOR_FIELDS = ['id', 'scope', 'trigger', 'enforcement', 'selector', 'implementation', 'budget'] as const;
const IMPLEMENTATION_FIELDS = ['abi', 'path'] as const;
const BUDGET_FIELDS = ['cpuMs', 'timeoutMs', 'memoryMiB'] as const;
const ASSEMBLER_FIELDS = ['id', 'implementation', 'budget', 'routes'] as const;
const ROUTE_FIELDS = ['id', 'artifactFile'] as const;

const TARGET_LEVELS = new Set(['outline', 'spec', 'content']);
const VALIDATOR_SCOPES = new Set(['slot', 'subtree', 'scaffold']);
const VALIDATOR_TRIGGERS = new Set(['merge-and-seal', 'seal']);
const VALIDATOR_ENFORCEMENTS = new Set(['blocking', 'advisory']);

/** Safe single-segment artifact file name (design E06 / E07). */
const SAFE_SINGLE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const LIMIT_GROUPS: Readonly<Record<string, readonly string[]>> = {
  schema: ['maxSchemaDepth', 'maxSchemaNodes', 'maxEnumItems', 'maxPatternLength'],
  structure: ['maxSlots', 'maxTreeDepth', 'maxChildrenPerSlot'],
  payload: ['maxSpecBytesPerSlot', 'maxContentBytesPerSlot', 'maxScaffoldPayloadBytes'],
  draft: ['maxChangedSlots', 'maxDraftBytes'],
  attempt: [
    'maxSlotToolCallsPerAttempt',
    'maxValidationRunsPerAttempt',
    'maxValidatorInvocationsPerAttempt',
    'maxAggregateValidatorCpuMsPerAttempt',
    'maxAggregateValidatorWallClockMsPerAttempt',
    'maxValidatorOutputBytesPerAttempt',
    'maxAttemptWallClockMs',
  ],
  validation: [
    'maxValidators',
    'maxValidatorInvocationsPerGate',
    'maxAggregateValidatorCpuMsPerGate',
    'maxAggregateValidatorWallClockMsPerGate',
    'maxValidatorOutputBytesPerGate',
    'maxIssuesPerRun',
  ],
  output: ['maxArtifactFiles', 'maxArtifactBytesPerFile', 'maxTotalArtifactBytes'],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) contractInvalid(`unknown field '${key}' at ${where}`);
  }
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) contractInvalid(`${where} must be a non-empty string`);
  return value;
}

function positiveSafeInt(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    contractInvalid(`${where} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInt(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    contractInvalid(`${where} must be a non-negative safe integer`);
  }
  return value;
}

/** Read and parse `slots/contract.yaml`, rejecting duplicate keys (spec §25.13). */
async function readContractYaml(templateRoot: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(join(templateRoot, CONTRACT_FILE), 'utf8');
  } catch {
    contractInvalid(`${CONTRACT_FILE} is missing or unreadable`);
  }
  try {
    return parse(source, { merge: false });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'DUPLICATE_KEY'
    ) {
      contractInvalid(`${CONTRACT_FILE} contains duplicate YAML keys`);
    }
    contractInvalid(`${CONTRACT_FILE} is not valid YAML`);
  }
}

/** Top-level exact schema (spec §3.3 / design A01): seven required fields only. */
function assertExactTopLevel(record: Record<string, unknown>): void {
  rejectUnknownFields(record, TOP_LEVEL_FIELDS, 'contract.yaml');
  for (const key of TOP_LEVEL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      contractInvalid(`missing required top-level field '${key}'`);
    }
  }
  if (record['version'] !== 1) {
    contractInvalid(`unknown contract version ${JSON.stringify(record['version'])}`);
  }
}

/** All 28 limits present, positive safe integers, no unknown fields (spec §5). */
function assertPositiveLimitsShape(raw: unknown, where: string): void {
  if (!isPlainObject(raw)) contractInvalid(`limits at ${where} must be a plain object`);
  for (const group of Object.keys(raw)) {
    if (!(group in LIMIT_GROUPS)) contractInvalid(`unknown limits group '${group}' at ${where}`);
  }
  for (const [group, fields] of Object.entries(LIMIT_GROUPS)) {
    const groupValue = raw[group];
    if (!isPlainObject(groupValue)) contractInvalid(`limits.${group} at ${where} must be a plain object`);
    rejectUnknownFields(groupValue, fields, `limits.${group}`);
    for (const field of fields) {
      positiveSafeInt(groupValue[field], `limits.${group}.${field} at ${where}`);
    }
  }
}

/** Cross-field relations (spec §5 / design §7.6). */
function assertCrossFieldRelations(l: StructuredSlotLimitsV1): void {
  const gte = (label: string, a: number, b: number): void => {
    if (a < b) contractInvalid(`${label} (${a}) must be >= ${b}`);
  };
  gte(
    'attempt.maxValidatorInvocationsPerAttempt',
    l.attempt.maxValidatorInvocationsPerAttempt,
    l.validation.maxValidatorInvocationsPerGate,
  );
  gte(
    'attempt.maxAggregateValidatorCpuMsPerAttempt',
    l.attempt.maxAggregateValidatorCpuMsPerAttempt,
    l.validation.maxAggregateValidatorCpuMsPerGate,
  );
  gte(
    'attempt.maxAggregateValidatorWallClockMsPerAttempt',
    l.attempt.maxAggregateValidatorWallClockMsPerAttempt,
    l.validation.maxAggregateValidatorWallClockMsPerGate,
  );
  gte(
    'attempt.maxValidatorOutputBytesPerAttempt',
    l.attempt.maxValidatorOutputBytesPerAttempt,
    l.validation.maxValidatorOutputBytesPerGate,
  );
  if (l.attempt.maxValidationRunsPerAttempt > l.attempt.maxSlotToolCallsPerAttempt) {
    contractInvalid('attempt.maxValidationRunsPerAttempt must not exceed attempt.maxSlotToolCallsPerAttempt');
  }
  if (l.attempt.maxAttemptWallClockMs < l.attempt.maxAggregateValidatorWallClockMsPerAttempt) {
    contractInvalid('attempt.maxAttemptWallClockMs must be >= attempt.maxAggregateValidatorWallClockMsPerAttempt');
  }
  if (l.draft.maxChangedSlots > l.structure.maxSlots) {
    contractInvalid('draft.maxChangedSlots must not exceed structure.maxSlots');
  }
  if (l.output.maxArtifactBytesPerFile > l.output.maxTotalArtifactBytes) {
    contractInvalid('output.maxArtifactBytesPerFile must not exceed output.maxTotalArtifactBytes');
  }
}

/** Template limits must be <= the platform hard ceiling, field by field. */
function assertWithinProfile(template: StructuredSlotLimitsV1, profile: StructuredSlotLimitsV1): void {
  const templateFlat = template as unknown as Record<string, Record<string, number>>;
  const profileFlat = profile as unknown as Record<string, Record<string, number>>;
  for (const [group, fields] of Object.entries(LIMIT_GROUPS)) {
    for (const field of fields) {
      const t = templateFlat[group][field];
      const p = profileFlat[group][field];
      if (t > p) contractInvalid(`template limits.${group}.${field} (${t}) exceeds platform ceiling ${p}`);
    }
  }
}

/** Parse one slot type and compile both schemas (spec §4.2, design §8.2). */
function parseSlotType(raw: unknown, where: string, limits: StructuredSlotLimitsV1): FrozenSlotTypeV1 {
  if (!isPlainObject(raw)) contractInvalid(`slot type at ${where} must be a plain object`);
  rejectUnknownFields(raw, SLOT_TYPE_FIELDS, where);
  const id = nonEmptyString(raw['id'], `${where}/id`);
  const name = nonEmptyString(raw['name'], `${where}/name`);
  const description = nonEmptyString(raw['description'], `${where}/description`);

  const specSchemaRaw = raw['specSchema'];
  if (!isPlainObject(specSchemaRaw)) contractInvalid(`specSchema at ${where} must be a plain object`);
  if (specSchemaRaw['type'] !== 'object') {
    contractInvalid(`specSchema root type must be 'object' at ${where}`);
  }
  if (specSchemaRaw['additionalProperties'] !== false) {
    contractInvalid(`specSchema root additionalProperties must be false at ${where}`);
  }
  const specSchema = compileSlotSchemaV1(specSchemaRaw, limits);

  const contentRaw = raw['content'];
  if (!isPlainObject(contentRaw)) contractInvalid(`content wrapper at ${where} must be a plain object`);
  rejectUnknownFields(contentRaw, CONTENT_FIELDS, `${where}/content`);
  const presence = contentRaw['presence'];
  if (presence === 'optional' || presence === 'required') {
    const schemaRaw = contentRaw['schema'];
    if (schemaRaw === undefined) contractInvalid(`content presence '${presence}' requires a schema at ${where}`);
    const schema = compileSlotSchemaV1(schemaRaw, limits);
    return { id, name, description, specSchema, content: { presence, schema } };
  }
  if (presence === 'forbidden') {
    if ('schema' in contentRaw) contractInvalid(`presence forbidden must not declare a content schema at ${where}`);
    return { id, name, description, specSchema, content: { presence } };
  }
  contractInvalid(`content presence at ${where} must be forbidden|optional|required`);
}

function parseSlotTypes(raw: unknown, limits: StructuredSlotLimitsV1): { frozen: FrozenSlotTypeV1[]; typeIds: Set<string> } {
  if (!Array.isArray(raw)) contractInvalid('slotTypes must be an array');
  if (raw.length < 1) contractInvalid('slotTypes must contain at least one slot type');
  const typeIds = new Set<string>();
  const frozen: FrozenSlotTypeV1[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = parseSlotType(raw[i], `slotTypes/${i}`, limits);
    if (typeIds.has(entry.id)) contractInvalid(`duplicate slot type id '${entry.id}'`);
    typeIds.add(entry.id);
    frozen.push(entry);
  }
  return { frozen, typeIds };
}

/** Parse and validate a static selector (spec §8.3 / design §10.5). */
function parseSelector(raw: unknown, where: string, typeIds: ReadonlySet<string>): SlotTargetSelectorV1 {
  if (!isPlainObject(raw)) contractInvalid(`selector at ${where} must be a plain object`);
  const kind = raw['kind'];
  if (kind === 'all' || kind === 'root') {
    rejectUnknownFields(raw, ['kind'], where);
    return { kind };
  }
  if (kind === 'types') {
    rejectUnknownFields(raw, ['kind', 'typeIds'], where);
    const rawTypeIds = raw['typeIds'];
    if (!Array.isArray(rawTypeIds) || rawTypeIds.length < 1) {
      contractInvalid(`types selector at ${where} must declare non-empty typeIds`);
    }
    const seen = new Set<string>();
    const typeIdsResolved: string[] = [];
    for (let i = 0; i < rawTypeIds.length; i++) {
      const typeId = nonEmptyString(rawTypeIds[i], `${where}/typeIds/${i}`);
      if (seen.has(typeId)) contractInvalid(`duplicate typeId '${typeId}' in selector at ${where}`);
      seen.add(typeId);
      if (!typeIds.has(typeId)) referenceUnknown(`selector typeId '${typeId}' at ${where} is not a declared slot type`);
      typeIdsResolved.push(typeId);
    }
    return { kind: 'types', typeIds: typeIdsResolved };
  }
  contractInvalid(`unknown selector kind '${String(kind)}' at ${where}`);
}

function assertTargetLevel(value: unknown, where: string): 'outline' | 'spec' | 'content' {
  if (typeof value !== 'string' || !TARGET_LEVELS.has(value)) {
    contractInvalid(`${where} must be outline|spec|content`);
  }
  return value as 'outline' | 'spec' | 'content';
}

function parseReadRule(raw: unknown, where: string, typeIds: ReadonlySet<string>): AccessProfileV1['read'][number] {
  if (!isPlainObject(raw)) contractInvalid(`read rule at ${where} must be a plain object`);
  rejectUnknownFields(raw, READ_RULE_FIELDS, where);
  const targets = parseSelector(raw['targets'], `${where}/targets`, typeIds);
  const targetLevel = assertTargetLevel(raw['targetLevel'], `${where}/targetLevel`);
  const contextRaw = raw['context'];
  if (!isPlainObject(contextRaw)) contractInvalid(`context at ${where} must be a plain object`);
  rejectUnknownFields(contextRaw, READ_CONTEXT_FIELDS, `${where}/context`);
  const level = assertTargetLevel(contextRaw['level'], `${where}/context/level`);
  const directSiblings = contextRaw['directSiblings'];
  if (typeof directSiblings !== 'boolean') {
    contractInvalid(`context.directSiblings at ${where} must be a boolean`);
  }
  return {
    targets,
    targetLevel,
    context: {
      level,
      ancestors: nonNegativeSafeInt(contextRaw['ancestors'], `${where}/context/ancestors`),
      descendants: nonNegativeSafeInt(contextRaw['descendants'], `${where}/context/descendants`),
      directSiblings,
    },
  };
}

function parseWriteRule(raw: unknown, where: string, typeIds: ReadonlySet<string>): { targets: SlotTargetSelectorV1 } {
  if (!isPlainObject(raw)) contractInvalid(`write rule at ${where} must be a plain object`);
  rejectUnknownFields(raw, WRITE_RULE_FIELDS, where);
  return { targets: parseSelector(raw['targets'], `${where}/targets`, typeIds) };
}

function parseAccessProfile(
  raw: unknown,
  where: string,
  typeIds: ReadonlySet<string>,
  seenIds: Set<string>,
): AccessProfileV1 {
  if (!isPlainObject(raw)) contractInvalid(`access profile at ${where} must be a plain object`);
  rejectUnknownFields(raw, PROFILE_FIELDS, where);
  const id = nonEmptyString(raw['id'], `${where}/id`);
  if (seenIds.has(id)) contractInvalid(`duplicate access profile id '${id}'`);
  seenIds.add(id);

  const readRaw = raw['read'];
  if (!Array.isArray(readRaw)) contractInvalid(`read at ${where} must be an array`);
  const read = readRaw.map((rule, i) => parseReadRule(rule, `${where}/read/${i}`, typeIds));

  const writeRaw = raw['writeContent'];
  if (!Array.isArray(writeRaw)) contractInvalid(`writeContent at ${where} must be an array`);
  const writeContent = writeRaw.map((rule, i) => parseWriteRule(rule, `${where}/writeContent/${i}`, typeIds));

  const continuityRaw = raw['continuity'];
  if (!isPlainObject(continuityRaw)) contractInvalid(`continuity at ${where} must be a plain object`);
  rejectUnknownFields(continuityRaw, CONTINUITY_FIELDS, `${where}/continuity`);
  const precedingFilled = continuityRaw['precedingFilled'];
  if (typeof precedingFilled !== 'boolean') {
    contractInvalid(`continuity.precedingFilled at ${where} must be a boolean`);
  }
  return { id, read, writeContent, continuity: { precedingFilled } };
}

function parseAccessProfiles(raw: unknown, typeIds: ReadonlySet<string>): AccessProfileV1[] {
  if (!Array.isArray(raw)) contractInvalid('accessProfiles must be an array');
  if (raw.length < 1) contractInvalid('accessProfiles must contain at least one access profile');
  const seen = new Set<string>();
  return raw.map((profile, i) => parseAccessProfile(profile, `accessProfiles/${i}`, typeIds, seen));
}

/** Implementation + budget (design E01/E06). */
function parseBudget(raw: unknown, where: string): { cpuMs: number; timeoutMs: number; memoryMiB: number } {
  if (!isPlainObject(raw)) contractInvalid(`budget at ${where} must be a plain object`);
  rejectUnknownFields(raw, BUDGET_FIELDS, `${where}/budget`);
  return {
    cpuMs: positiveSafeInt(raw['cpuMs'], `${where}/budget/cpuMs`),
    timeoutMs: positiveSafeInt(raw['timeoutMs'], `${where}/budget/timeoutMs`),
    memoryMiB: positiveSafeInt(raw['memoryMiB'], `${where}/budget/memoryMiB`),
  };
}

function parseImplementation<Abi extends 'forge-validator/v1' | 'forge-assembler/v1'>(
  raw: unknown,
  expectedAbi: Abi,
  where: string,
  allowedRoot: string,
): { abi: Abi; path: string } {
  if (!isPlainObject(raw)) contractInvalid(`implementation at ${where} must be a plain object`);
  rejectUnknownFields(raw, IMPLEMENTATION_FIELDS, `${where}/implementation`);
  const abi = raw['abi'];
  if (abi !== expectedAbi) contractInvalid(`implementation ABI at ${where} must be '${expectedAbi}'`);
  const path = nonEmptyString(raw['path'], `${where}/implementation/path`);
  assertResourcePathFormat(path, allowedRoot, `${where}/implementation/path`);
  return { abi: expectedAbi, path };
}

/** Path format + allowed-directory containment (spec §3.3 / design A02). */
function assertResourcePathFormat(path: string, allowedRoot: string, where: string): void {
  if (path.includes('\\')) resourceInvalid(`resource path at ${where} contains a backslash`);
  if (path.includes('\0')) resourceInvalid(`resource path at ${where} contains NUL`);
  if (isAbsolute(path)) resourceInvalid(`resource path at ${where} must be a relative path`);
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment.length === 0) resourceInvalid(`resource path at ${where} contains an empty segment`);
    if (segment === '.' || segment === '..') {
      resourceInvalid(`resource path at ${where} contains a '${segment}' segment`);
    }
  }
  if (!path.startsWith(allowedRoot)) {
    resourceInvalid(`resource path at ${where} is outside '${allowedRoot.replace(/\/$/, '')}'`);
  }
  if (path.length === allowedRoot.length) {
    resourceInvalid(`resource path at ${where} must name a file under '${allowedRoot.replace(/\/$/, '')}'`);
  }
}

function parseValidator(
  raw: unknown,
  where: string,
  typeIds: ReadonlySet<string>,
  seenIds: Set<string>,
  limits: StructuredSlotLimitsV1,
): ValidatorRegistrationV1 {
  if (!isPlainObject(raw)) contractInvalid(`validator at ${where} must be a plain object`);
  rejectUnknownFields(raw, VALIDATOR_FIELDS, where);
  const id = nonEmptyString(raw['id'], `${where}/id`);
  if (seenIds.has(id)) contractInvalid(`duplicate validator id '${id}'`);
  seenIds.add(id);

  const scope = raw['scope'];
  if (typeof scope !== 'string' || !VALIDATOR_SCOPES.has(scope)) {
    contractInvalid(`validator '${id}' scope must be slot|subtree|scaffold`);
  }
  const trigger = raw['trigger'];
  if (typeof trigger !== 'string' || !VALIDATOR_TRIGGERS.has(trigger)) {
    contractInvalid(`validator '${id}' trigger must be merge-and-seal|seal`);
  }
  const enforcement = raw['enforcement'];
  if (typeof enforcement !== 'string' || !VALIDATOR_ENFORCEMENTS.has(enforcement)) {
    contractInvalid(`validator '${id}' enforcement must be blocking|advisory`);
  }
  const selector = parseSelector(raw['selector'], `${where}/selector`, typeIds);
  const implementation = parseImplementation(raw['implementation'], 'forge-validator/v1', where, VALIDATOR_ROOT);
  const budget = parseBudget(raw['budget'], `validator '${id}'`);
  if (seenIds.size > limits.validation.maxValidators) {
    contractInvalid(`validator count exceeds limits.validation.maxValidators (${limits.validation.maxValidators})`);
  }
  return {
    id,
    scope: scope as ValidatorRegistrationV1['scope'],
    trigger: trigger as ValidatorRegistrationV1['trigger'],
    enforcement: enforcement as ValidatorRegistrationV1['enforcement'],
    selector,
    implementation,
    budget,
  };
}

function parseValidators(
  raw: unknown,
  typeIds: ReadonlySet<string>,
  limits: StructuredSlotLimitsV1,
): ValidatorRegistrationV1[] {
  if (!Array.isArray(raw)) contractInvalid('validators must be an array');
  const seen = new Set<string>();
  return raw.map((validator, i) => parseValidator(validator, `validators/${i}`, typeIds, seen, limits));
}

function parseRoute(raw: unknown, where: string, seenIds: Set<string>): AssemblerRouteV1 {
  if (!isPlainObject(raw)) contractInvalid(`route at ${where} must be a plain object`);
  rejectUnknownFields(raw, ROUTE_FIELDS, where);
  const id = nonEmptyString(raw['id'], `${where}/id`);
  if (seenIds.has(id)) contractInvalid(`duplicate route id '${id}' at ${where}`);
  seenIds.add(id);
  const artifactFile = raw['artifactFile'];
  if (typeof artifactFile !== 'string' || !SAFE_SINGLE_SEGMENT.test(artifactFile)) {
    contractInvalid(`artifactFile at ${where} must be a safe single-segment name`);
  }
  return { id, artifactFile };
}

function parseAssembler(raw: unknown): AssemblerRegistrationV1 {
  if (!isPlainObject(raw)) contractInvalid('assembler must be a plain object (exactly one)');
  rejectUnknownFields(raw, ASSEMBLER_FIELDS, 'assembler');
  const id = nonEmptyString(raw['id'], 'assembler/id');
  const implementation = parseImplementation(raw['implementation'], 'forge-assembler/v1', 'assembler', ASSEMBLER_ROOT);
  const budget = parseBudget(raw['budget'], `assembler '${id}'`);
  const routesRaw = raw['routes'];
  if (!Array.isArray(routesRaw)) contractInvalid('assembler routes must be an array');
  const seen = new Set<string>();
  const routes = routesRaw.map((route, i) => parseRoute(route, `assembler/routes/${i}`, seen));
  return { id, implementation, budget, routes };
}

/** Read one referenced resource's bytes with full containment (design A02). */
async function readResourceBytes(templateRoot: string, logicalPath: string): Promise<Buffer> {
  let realRoot: string;
  try {
    realRoot = await realpath(templateRoot);
  } catch {
    resourceInvalid(`template root is unreadable`);
  }
  const resolved = resolve(realRoot, logicalPath);
  let linkStat: Awaited<ReturnType<typeof lstat>>;
  try {
    linkStat = await lstat(resolved);
  } catch {
    resourceInvalid(`resource '${logicalPath}' is missing or unreadable`);
  }
  if (linkStat.isSymbolicLink()) resourceInvalid(`resource '${logicalPath}' is a symbolic link`);
  if (!linkStat.isFile()) resourceInvalid(`resource '${logicalPath}' is not a regular file`);
  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    resourceInvalid(`resource '${logicalPath}' is missing or unreadable`);
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    resourceInvalid(`resource '${logicalPath}' escapes the template directory`);
  }
  try {
    return await readFile(real);
  } catch {
    resourceInvalid(`resource '${logicalPath}' is missing or unreadable`);
  }
}

/** Reject any file inside the allowed directories that the contract does not reference. */
async function assertNoUnreferencedResources(
  templateRoot: string,
  referenced: ReadonlySet<string>,
): Promise<void> {
  let realRoot: string;
  try {
    realRoot = await realpath(templateRoot);
  } catch {
    resourceInvalid('template root is unreadable');
  }
  for (const allowedRoot of [VALIDATOR_ROOT, ASSEMBLER_ROOT]) {
    await walkAllowedDir(realRoot, allowedRoot, referenced);
  }
}

async function walkAllowedDir(realRoot: string, logicalDir: string, referenced: ReadonlySet<string>): Promise<void> {
  let entries: Dirent[] | undefined;
  try {
    entries = await readdir(join(realRoot, logicalDir), { withFileTypes: true });
  } catch {
    return; // missing allowed directory: nothing to scan, references will fail on read
  }
  for (const entry of entries) {
    const logicalPath = `${logicalDir}${entry.name}`;
    if (entry.isDirectory()) {
      await walkAllowedDir(realRoot, `${logicalPath}/`, referenced);
    } else if (entry.isFile()) {
      if (!referenced.has(logicalPath)) {
        resourceInvalid(`unreferenced resource '${logicalPath}'`);
      }
    } else {
      resourceInvalid(`resource '${logicalPath}' is not a regular file`);
    }
  }
}

function compareByLogicalPath(a: ResourceManifestEntryV1, b: ResourceManifestEntryV1): number {
  if (a.logicalPath < b.logicalPath) return -1;
  if (a.logicalPath > b.logicalPath) return 1;
  return 0;
}

/** Semantic digest: normalized contract + sorted resource contents + ABI/profile identity. */
function computeSemanticDigest(
  rawContract: unknown,
  resourceManifest: ResourceManifestEntryV1[],
  abiProfileIdentity: AbiProfileIdentityV1,
): string {
  return canonicalJsonSha256({ version: 1, contract: rawContract, resources: resourceManifest, abiProfileIdentity });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Compile a structured-slot contract v1 from a template package root.
 *
 * `templateRoot` is the template package directory containing `slots/`.
 * `profile` is the platform hard ceiling (`StructuredSlotLimitsV1` for now;
 * a later task reconciles the full runtime profile object while keeping this
 * call shape). Throws a stable-coded `Error` on any violation and returns an
 * immutable, deep-frozen `FrozenStructuredSlotContractV1` on success.
 */
export async function loadStructuredSlotContract(
  templateRoot: string,
  profile: StructuredSlotLimitsV1,
): Promise<FrozenStructuredSlotContractV1> {
  const rawContract = await readContractYaml(templateRoot);
  if (!isPlainObject(rawContract)) contractInvalid('contract.yaml must be a mapping');
  assertExactTopLevel(rawContract);

  // Validate limits (and the platform profile) before compiling schemas/grammar.
  assertPositiveLimitsShape(rawContract['limits'], 'template');
  const limits = rawContract['limits'] as unknown as StructuredSlotLimitsV1;
  assertCrossFieldRelations(limits);
  assertPositiveLimitsShape(profile, 'profile');
  assertWithinProfile(limits, profile);

  const { frozen: slotTypes, typeIds } = parseSlotTypes(rawContract['slotTypes'], limits);

  const layoutGrammar = compileLayoutGrammarV1(
    rawContract['layoutGrammar'] as unknown as LayoutGrammarV1,
    typeIds,
    limits,
  );

  const accessProfiles = parseAccessProfiles(rawContract['accessProfiles'], typeIds);

  const validators = parseValidators(rawContract['validators'], typeIds, limits);

  const assembler = parseAssembler(rawContract['assembler']);

  // Resource containment + manifest.
  const referenced = new Set<string>();
  for (const validator of validators) referenced.add(validator.implementation.path);
  referenced.add(assembler.implementation.path);
  await assertNoUnreferencedResources(templateRoot, referenced);

  const resourceManifest: ResourceManifestEntryV1[] = [];
  for (const logicalPath of referenced) {
    const bytes = await readResourceBytes(templateRoot, logicalPath);
    resourceManifest.push({
      logicalPath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
    });
  }
  resourceManifest.sort(compareByLogicalPath);

  const abiProfileIdentity: AbiProfileIdentityV1 = {
    validatorAbi: 'forge-validator/v1',
    assemblerAbi: 'forge-assembler/v1',
    profileIdentity: 'forge-structured-runtime/v1',
  };

  const semanticDigest = computeSemanticDigest(rawContract, resourceManifest, abiProfileIdentity);

  return deepFreeze({
    version: 1,
    slotTypes,
    layoutGrammar,
    accessProfiles,
    validators,
    assembler,
    limits,
    resourceManifest,
    abiProfileIdentity,
    semanticDigest,
  });
}
