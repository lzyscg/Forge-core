/**
 * Structured Slot contract v2 compiler + canonical identity (Task 4).
 *
 * Reads `slots/contract.yaml` under a template package root and compiles it
 * fail-closed against the exact v2 shape (spec §6.1), with no loader /
 * FrozenTemplate / pipeline involvement: the first successful v2 template
 * load happens in Task 5. The compiler is vocabulary-free; fixture words
 * (document/title/body, narrative relation criteria) live only in fixtures.
 *
 * Compared with Contract v1 this module: parses static capability-ceiling
 * access profiles (design §9 table / spec §11.1-11.3 — v1 profiles are
 * slot-target rules and are deliberately NOT reused), parses relation types
 * with the explicit optional/disabled relationship policy (design §9, zero
 * relations are always legal), normalizes ReviewPolicyV2 (spec §6.2), parses
 * strict ValidatorRegistrationV2 entries (spec §6.5: seven triggers,
 * content-only execution phases, no advisory seal_output, `deterministic:
 * true` literal), the single forge-assembler/v2 registration (design §16.3,
 * spec §13.5 — media types closed to the BlobRefV2 media set), and a closed
 * limit set of positive finite integers. Slot Schema and Layout Grammar
 * compilers are reused verbatim from v1 (Task 2/3): they compile the
 * slot-tree grammar and schema dialect only and never reference v1 protocol
 * fields, so their frozen input/output semantics are identical — this is the
 * one protocol-independent v1 reuse the plan allows. A v2 contract references
 * no template files (implementations are allowlisted builtin handler
 * identities), so there is no resource manifest; the implementation identity
 * closure (validators + assembler, sorted deterministically) is the v2
 * resource surface.
 *
 * The canonical contract identity is `canonicalJsonBytes` (JCS, RFC 8785) of
 * the NORMALIZED contract incl. `version: 2`; `semanticDigest` is the SHA-256
 * of those bytes. YAML cosmetics (key order, quoting, comments) never enter.
 * This digest is deliberately SEPARATE from v1's composite digest, whose
 * formula (`canonicalJsonSha256({version:1, contract, resources,
 * abiProfileIdentity})`) is frozen and untouched.
 *
 * Error codes are the v1-registered `SLOTS_CONTRACT_INVALID` (shape) and
 * `SLOTS_REFERENCE_UNKNOWN` (selector / relation endpoint referencing an
 * undeclared slot type); the reused v1 tree compilers throw their own stable
 * codes (`SPEC_SCHEMA_INVALID`, `LAYOUT_GRAMMAR_*`) and are not re-wrapped,
 * mirroring v1.
 *
 * Judgments recorded (Task 4 report): `direction: 'directed'` and
 * `invalidation.direction: 'downstream'` are the only literals accepted —
 * design §10.3 freezes first-release relations as directed binary edges and
 * the only invalidation example/direction documented is downstream;
 * `attributesSchema` is either an empty mapping (`presence: 'none'`, no
 * attributes) or a closed v1-dialect object schema rooted at
 * `{type: object, additionalProperties: false}`; `ValidatorSelectorV2` is
 * `{kind: 'all'} | {kind: 'types', typeIds}` with typeIds cross-referenced to
 * declared slot types (the docs name the selector but never define it, so the
 * shape mirrors the v1 selector minus the tree-only 'root' kind);
 * `inputContractVersion`/`outputContractVersion` are non-negative safe
 * integers (registry exact-matching is Task 5/14 business); v2 limits reuse
 * all 28 v1 field names (their concepts — slot schemas, slot trees, payload
 * bytes, drafts, attempts, per-gate validation, artifact output — exist in v2
 * too) plus the `relations` and `authoritative` groups derived from design
 * §22.2; every limit is mandatory-positive with no cross-field relations
 * (profile-cap enforcement is Task 5's job). See the module's exported types
 * for the exact closed sets.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parse } from 'yaml';
import { canonicalJsonBytes, canonicalJsonSha256 } from '../structured-slots/canonical-json';
import {
  compileLayoutGrammarV1,
  type CompiledLayoutGrammarV1,
  type LayoutGrammarV1,
} from '../structured-slots/layout-grammar';
import { compileSlotSchemaV1, type CompiledSlotSchemaV1 } from '../structured-slots/slot-schema';

/** Error codes (registered in src/server/structured-slots/issues.ts, shared with v1). */
const CONTRACT_INVALID = 'SLOTS_CONTRACT_INVALID';
const REFERENCE_UNKNOWN = 'SLOTS_REFERENCE_UNKNOWN';

/** Contract file is always `slots/contract.yaml` relative to the template root. */
const CONTRACT_FILE = 'slots/contract.yaml';

function contractInvalid(reason: string): never {
  throw new Error(`${CONTRACT_INVALID}: ${reason}`);
}
function referenceUnknown(reason: string): never {
  throw new Error(`${REFERENCE_UNKNOWN}: ${reason}`);
}

/**
 * The eight closed v2 session kinds (design §9). Exported for Task 5's
 * turn-contract v4 to reuse.
 */
export type StructuredSessionKindV2 =
  | 'structure_chunk'
  | 'review_map_batch'
  | 'review_map_whole'
  | 'generation_batch'
  | 'review_content_batch'
  | 'review_content_whole'
  | 'map_repair'
  | 'content_repair';

/**
 * The closed capability union (design §9 per-session table + spec §11.1-11.3).
 * Every member is traced to the docs (see the Task 4 report for the
 * member-by-member trace); `write_map_patch` is named by the design §9
 * `map_repair` row even though spec §11.1 only shows `submit_map_patch`, so it
 * is included. v1's ten-item `SlotCapabilityV1` union is not widened.
 */
export type SlotCapabilityV2 =
  | 'append_map_candidate_chunk'
  | 'complete_review_assignment'
  | 'finish_map_build'
  | 'read_active_map'
  | 'read_map_build_frontier'
  | 'read_map_candidate'
  | 'read_map_repair_staging'
  | 'read_related_context'
  | 'read_relation_context'
  | 'read_slot_content'
  | 'read_structure_contract'
  | 'request_scope_expansion'
  | 'submit_content_draft'
  | 'submit_finding_verification'
  | 'submit_map_node_review'
  | 'submit_map_patch'
  | 'submit_map_relation_review'
  | 'submit_map_whole_finding'
  | 'submit_relation_review'
  | 'submit_slot_review'
  | 'submit_whole_tree_finding'
  | 'write_map_patch'
  | 'write_slot_content';

/** The closed capability set (single constant source of truth, sorted). */
export const SLOT_CAPABILITIES_V2: readonly SlotCapabilityV2[] = [
  'append_map_candidate_chunk',
  'complete_review_assignment',
  'finish_map_build',
  'read_active_map',
  'read_map_build_frontier',
  'read_map_candidate',
  'read_map_repair_staging',
  'read_related_context',
  'read_relation_context',
  'read_slot_content',
  'read_structure_contract',
  'request_scope_expansion',
  'submit_content_draft',
  'submit_finding_verification',
  'submit_map_node_review',
  'submit_map_patch',
  'submit_map_relation_review',
  'submit_map_whole_finding',
  'submit_relation_review',
  'submit_slot_review',
  'submit_whole_tree_finding',
  'write_map_patch',
  'write_slot_content',
] as const;

/** A v2 access profile: a static capability ceiling, never slot-target rules. */
export interface AccessProfileV2 {
  id: string;
  capabilities: SlotCapabilityV2[];
}

/**
 * A declared relation type. First-release relations are directed binary
 * edges (design §10.3), so `direction` accepts only 'directed'; the only
 * documented invalidation direction is 'downstream' (design §9 example).
 */
export interface RelationTypeV2 {
  id: string;
  direction: 'directed';
  fromSlotTypes: string[];
  toSlotTypes: string[];
  attributesSchema: RelationAttributesSchemaV2;
  semanticCriterion: string;
  enforcement: 'blocking' | 'advisory';
  invalidation: { direction: 'downstream'; maxHops: number };
}

/**
 * Relation attribute schema: an empty mapping (`presence: 'none'`) means no
 * attributes; otherwise a compiled closed object schema in the shared slot
 * schema dialect, rooted at `{type: 'object', additionalProperties: false}`.
 */
export type RelationAttributesSchemaV2 =
  | { presence: 'none' }
  | { presence: 'schema'; schema: CompiledSlotSchemaV1 };

/** Explicit relationship policy (design §9). Absent policy defaults to disabled. */
export interface RelationshipPolicyV2 {
  mode: 'disabled' | 'optional';
}

/** Normalized review policy (spec §6.2). */
export interface ReviewPolicyV2 {
  mapReview: 'required';
  contentSelector: 'content_bearing';
  mapBatchTargetSlots: number;
  contentBatchTargetSlots: number;
  assignmentSoftLimit: number;
  wholeMapObservation: 'required';
  wholeContentTreeObservation: 'required';
  reviewAdvisoryRelations: boolean;
  maxRounds: number;
}

/** The seven v2 validator triggers (spec §6.5 / design §9). */
export type ValidatorTriggerV2 =
  | 'map_candidate_commit'
  | 'map_review_settlement'
  | 'map_activation'
  | 'content_commit'
  | 'repair_finalize'
  | 'review_settlement'
  | 'seal_input'
  | 'seal_output';

/** Execution phases; only `content_commit` may use a non-null phase. */
export type ValidatorExecutionPhaseV2 = 'batch_commit' | 'plan_finalize' | null;

/**
 * Validator selector: the docs name `ValidatorSelectorV2` but never define it;
 * this compiler freezes the closed shape `all | types` with typeIds
 * cross-referenced to declared slot types (mirroring the v1 selector minus the
 * tree-only 'root' kind). See the Task 4 report judgment.
 */
export type ValidatorSelectorV2 = { kind: 'all' } | { kind: 'types'; typeIds: string[] };

/** Strict v2 validator registration (spec §6.5). */
export interface ValidatorRegistrationV2 {
  validatorId: string;
  handlerKey: string;
  implementationDigest: string;
  implementationRef: { kind: 'builtin'; moduleId: string; exportName: string };
  trigger: ValidatorTriggerV2;
  executionPhase: ValidatorExecutionPhaseV2;
  selector: ValidatorSelectorV2;
  enforcement: 'blocking' | 'advisory';
  deterministic: true;
  inputContractVersion: number;
  outputContractVersion: number;
  budgetProfileId: string;
}

/** One assembler output route (design §16.3 / spec §13.5). */
export interface AssemblerRouteV2 {
  id: string;
  artifactFile: string;
  /** Closed to the BlobRefV2 media set (spec §7.1). */
  mediaType: 'application/json' | 'text/markdown' | 'text/plain';
}

/** Assembler budget (spec §13.5 frozen identity fields). */
export interface AssemblerBudgetV2 {
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
}

/** The single forge-assembler/v2 registration (spec §13.5). */
export interface AssemblerRegistrationV2 {
  abi: 'forge-assembler/v2';
  handlerKey: string;
  implementationDigest: string;
  implementationRef: { kind: 'builtin'; moduleId: string; exportName: string };
  budget: AssemblerBudgetV2;
  routes: AssemblerRouteV2[];
}

/** Compiled slot type: reusable v1 slot-schema compiler output. */
export interface FrozenSlotTypeV2 {
  id: string;
  name: string;
  description: string;
  specSchema: CompiledSlotSchemaV1;
  content:
    | { presence: 'forbidden' }
    | { presence: 'optional'; schema: CompiledSlotSchemaV1 }
    | { presence: 'required'; schema: CompiledSlotSchemaV1 };
}

/** One implementation the contract depends on (the v2 resource surface). */
export type ImplementationIdentityClosureEntryV2 =
  | {
      kind: 'validator';
      validatorId: string;
      trigger: ValidatorTriggerV2;
      executionPhase: ValidatorExecutionPhaseV2;
      handlerKey: string;
      implementationDigest: string;
      moduleId: string;
      exportName: string;
    }
  | {
      kind: 'assembler';
      handlerKey: string;
      implementationDigest: string;
      moduleId: string;
      exportName: string;
    };

/** Closed v2 limit groups: the 28 v1 field names plus v2-specific groups. */
export interface StructuredSlotLimitsV2 {
  schema: {
    maxSchemaDepth: number;
    maxSchemaNodes: number;
    maxEnumItems: number;
    maxPatternLength: number;
  };
  structure: {
    maxSlots: number;
    maxTreeDepth: number;
    maxChildrenPerSlot: number;
  };
  payload: {
    maxSpecBytesPerSlot: number;
    maxContentBytesPerSlot: number;
    maxScaffoldPayloadBytes: number;
  };
  draft: {
    maxChangedSlots: number;
    maxDraftBytes: number;
  };
  attempt: {
    maxSlotToolCallsPerAttempt: number;
    maxValidationRunsPerAttempt: number;
    maxValidatorInvocationsPerAttempt: number;
    maxAggregateValidatorCpuMsPerAttempt: number;
    maxAggregateValidatorWallClockMsPerAttempt: number;
    maxValidatorOutputBytesPerAttempt: number;
    maxAttemptWallClockMs: number;
  };
  validation: {
    maxValidators: number;
    maxValidatorInvocationsPerGate: number;
    maxAggregateValidatorCpuMsPerGate: number;
    maxAggregateValidatorWallClockMsPerGate: number;
    maxValidatorOutputBytesPerGate: number;
    maxIssuesPerRun: number;
  };
  output: {
    maxArtifactFiles: number;
    maxArtifactBytesPerFile: number;
    maxTotalArtifactBytes: number;
  };
  /** Relation-layer ceilings (design §22.2; enforced only when the relation layer is enabled). */
  relations: {
    maxRelationsPerMap: number;
    maxRelationsPerSlot: number;
    maxRelationImpactHops: number;
    maxRelationClosureNodes: number;
  };
  /** Authoritative review/round/settlement ceilings (design §22.2, spec §16.1). */
  authoritative: {
    maxAssignmentsPerRound: number;
    maxPlannedWorkItemsPerRound: number;
    maxConsecutiveAttemptsWithoutProgress: number;
    maxFindingsPerSlot: number;
    maxFindingsPerRelation: number;
    maxFindingsPerRound: number;
    maxEvidenceBytesPerItem: number;
    maxEvidenceBytesTotal: number;
    maxWriteSlotsPerRepairGrant: number;
    maxScopeExpansionsPerRound: number;
  };
}

/** Immutable compiled structured-slot contract v2. */
export interface FrozenStructuredSlotContractV2 {
  version: 2;
  slotTypes: FrozenSlotTypeV2[];
  layoutGrammar: CompiledLayoutGrammarV1;
  accessProfiles: AccessProfileV2[];
  relationTypes: RelationTypeV2[];
  relationshipPolicy: RelationshipPolicyV2;
  reviewPolicy: ReviewPolicyV2;
  validators: ValidatorRegistrationV2[];
  assembler: AssemblerRegistrationV2;
  limits: StructuredSlotLimitsV2;
  /** JCS canonical bytes of the normalized contract including `version: 2`. */
  canonicalBytes: Uint8Array;
  /** SHA-256 of `canonicalBytes` (separate from v1's composite digest). */
  semanticDigest: string;
  /** Validator + assembler handler identities, sorted deterministically. */
  implementationIdentityClosure: ImplementationIdentityClosureEntryV2[];
}

const TOP_LEVEL_FIELDS = [
  'version',
  'slotTypes',
  'layoutGrammar',
  'accessProfiles',
  'relationTypes',
  'relationshipPolicy',
  'reviewPolicy',
  'validators',
  'assembler',
  'limits',
] as const;

/** Present (possibly empty) convention allows missing relationTypes (design §9). */
const REQUIRED_TOP_LEVEL_FIELDS = [
  'version',
  'slotTypes',
  'layoutGrammar',
  'accessProfiles',
  'reviewPolicy',
  'validators',
  'assembler',
  'limits',
] as const;

const SLOT_TYPE_FIELDS = ['id', 'name', 'description', 'specSchema', 'content'] as const;
const CONTENT_FIELDS = ['presence', 'schema'] as const;
const PROFILE_FIELDS = ['id', 'capabilities'] as const;
const RELATION_TYPE_FIELDS = [
  'id',
  'direction',
  'fromSlotTypes',
  'toSlotTypes',
  'attributesSchema',
  'semanticCriterion',
  'enforcement',
  'invalidation',
] as const;
const INVALIDATION_FIELDS = ['direction', 'maxHops'] as const;
const RELATIONSHIP_POLICY_FIELDS = ['mode'] as const;
const REVIEW_POLICY_FIELDS = [
  'mapReview',
  'contentSelector',
  'mapBatchTargetSlots',
  'contentBatchTargetSlots',
  'assignmentSoftLimit',
  'wholeMapObservation',
  'wholeContentTreeObservation',
  'reviewAdvisoryRelations',
  'maxRounds',
] as const;
const VALIDATOR_FIELDS = [
  'validatorId',
  'handlerKey',
  'implementationDigest',
  'implementationRef',
  'trigger',
  'executionPhase',
  'selector',
  'enforcement',
  'deterministic',
  'inputContractVersion',
  'outputContractVersion',
  'budgetProfileId',
] as const;
const IMPLEMENTATION_REF_FIELDS = ['kind', 'moduleId', 'exportName'] as const;
const ASSEMBLER_FIELDS = [
  'abi',
  'handlerKey',
  'implementationDigest',
  'implementationRef',
  'budget',
  'routes',
] as const;
const ASSEMBLER_BUDGET_FIELDS = ['timeoutMs', 'maxInputBytes', 'maxOutputBytes'] as const;
const ROUTE_FIELDS = ['id', 'artifactFile', 'mediaType'] as const;

const VALIDATOR_TRIGGERS = new Set<ValidatorTriggerV2>([
  'map_candidate_commit',
  'map_review_settlement',
  'map_activation',
  'content_commit',
  'review_settlement',
  'seal_input',
  'seal_output',
]);
const EXECUTION_PHASES = new Set<ValidatorExecutionPhaseV2>(['batch_commit', 'plan_finalize', null]);
const ENFORCEMENTS = new Set<ValidatorRegistrationV2['enforcement']>(['blocking', 'advisory']);
const ROUTE_MEDIA_TYPES = new Set<AssemblerRouteV2['mediaType']>([
  'application/json',
  'text/markdown',
  'text/plain',
]);
const CAPABILITY_SET = new Set<SlotCapabilityV2>(SLOT_CAPABILITIES_V2);

/** v1-reused limit group definitions (identical semantics to v1's parse). */
const V1_LIMIT_GROUPS: Readonly<Record<string, readonly string[]>> = {
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

/** v2-only limit groups (design §22.2 / spec §16.1). */
const V2_LIMIT_GROUPS: Readonly<Record<string, readonly string[]>> = {
  relations: [
    'maxRelationsPerMap',
    'maxRelationsPerSlot',
    'maxRelationImpactHops',
    'maxRelationClosureNodes',
  ],
  authoritative: [
    'maxAssignmentsPerRound',
    'maxPlannedWorkItemsPerRound',
    'maxConsecutiveAttemptsWithoutProgress',
    'maxFindingsPerSlot',
    'maxFindingsPerRelation',
    'maxFindingsPerRound',
    'maxEvidenceBytesPerItem',
    'maxEvidenceBytesTotal',
    'maxWriteSlotsPerRepairGrant',
    'maxScopeExpansionsPerRound',
  ],
};

const LIMIT_GROUPS: Readonly<Record<string, readonly string[]>> = {
  ...V1_LIMIT_GROUPS,
  ...V2_LIMIT_GROUPS,
};

/** ReviewPolicyV2 defaults (spec §6.2; all other fields required or frozen). */
const DEFAULT_BATCH_TARGET_SLOTS = 24;
const DEFAULT_ASSIGNMENT_SOFT_LIMIT = 64;

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

/**
 * Strict raw version peek (spec §4.1): reads ONLY the `version` field and
 * fails closed on anything that is not exactly the number 1 or 2. The loader
 * uses this to dispatch before any v1/v2-specific parsing.
 */
export function peekStructuredSlotContractVersion(raw: unknown): 1 | 2 {
  if (!isPlainObject(raw)) {
    contractInvalid('contract.yaml must be a mapping to peek the version');
  }
  if (raw['version'] === 1) return 1;
  if (raw['version'] === 2) return 2;
  contractInvalid(`unknown contract version ${JSON.stringify(raw['version'])}`);
}

/**
 * Top-level exact schema (spec §6.1): unknown and cross-version fields fail.
 * `relationTypes` and `relationshipPolicy` are the only optional keys — an
 * absent relationshipPolicy reads as `mode: disabled` (design §9) and an
 * absent relationTypes is an empty relation layer.
 */
function assertExactTopLevel(record: Record<string, unknown>): void {
  rejectUnknownFields(record, TOP_LEVEL_FIELDS, 'contract.yaml');
  for (const key of REQUIRED_TOP_LEVEL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      contractInvalid(`missing required top-level field '${key}'`);
    }
  }
  if (record['version'] !== 2) {
    contractInvalid(`unknown contract version ${JSON.stringify(record['version'])}`);
  }
}

/** Closed limit set: 42 mandatory positive safe integers, no unknown keys. */
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

/** Parse one slot type and compile both schemas (reusing the v1 slot-schema compiler). */
function parseSlotType(raw: unknown, where: string, limits: StructuredSlotLimitsV2): FrozenSlotTypeV2 {
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

function parseSlotTypes(
  raw: unknown,
  limits: StructuredSlotLimitsV2,
): { frozen: FrozenSlotTypeV2[]; typeIds: Set<string> } {
  if (!Array.isArray(raw)) contractInvalid('slotTypes must be an array');
  if (raw.length < 1) contractInvalid('slotTypes must contain at least one slot type');
  const typeIds = new Set<string>();
  const frozen: FrozenSlotTypeV2[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = parseSlotType(raw[i], `slotTypes/${i}`, limits);
    if (typeIds.has(entry.id)) contractInvalid(`duplicate slot type id '${entry.id}'`);
    typeIds.add(entry.id);
    frozen.push(entry);
  }
  return { frozen, typeIds };
}

function parseAccessProfile(
  raw: unknown,
  where: string,
  seenIds: Set<string>,
): AccessProfileV2 {
  if (!isPlainObject(raw)) contractInvalid(`access profile at ${where} must be a plain object`);
  rejectUnknownFields(raw, PROFILE_FIELDS, where);
  const id = nonEmptyString(raw['id'], `${where}/id`);
  if (seenIds.has(id)) contractInvalid(`duplicate access profile id '${id}'`);
  seenIds.add(id);

  const capabilitiesRaw = raw['capabilities'];
  if (!Array.isArray(capabilitiesRaw)) contractInvalid(`capabilities at ${where} must be an array`);
  if (capabilitiesRaw.length < 1) {
    contractInvalid(`access profile '${id}' must declare at least one capability`);
  }
  const seen = new Set<SlotCapabilityV2>();
  const capabilities: SlotCapabilityV2[] = [];
  for (let i = 0; i < capabilitiesRaw.length; i++) {
    const capability = capabilitiesRaw[i];
    if (typeof capability !== 'string' || !CAPABILITY_SET.has(capability as SlotCapabilityV2)) {
      contractInvalid(`capability at ${where}/capabilities/${i} is not in the closed SlotCapabilityV2 union`);
    }
    if (seen.has(capability as SlotCapabilityV2)) {
      contractInvalid(`duplicate capability '${capability}' at ${where}`);
    }
    seen.add(capability as SlotCapabilityV2);
    capabilities.push(capability as SlotCapabilityV2);
  }
  return { id, capabilities };
}

function parseAccessProfiles(raw: unknown): AccessProfileV2[] {
  if (!Array.isArray(raw)) contractInvalid('accessProfiles must be an array');
  if (raw.length < 1) contractInvalid('accessProfiles must contain at least one access profile');
  const seen = new Set<string>();
  return raw.map((profile, i) => parseAccessProfile(profile, `accessProfiles/${i}`, seen));
}

/** Parse a v2 selector; typeIds must be declared slot types (SLOTS_REFERENCE_UNKNOWN). */
function parseSelector(raw: unknown, where: string, typeIds: ReadonlySet<string>): ValidatorSelectorV2 {
  if (!isPlainObject(raw)) contractInvalid(`selector at ${where} must be a plain object`);
  const kind = raw['kind'];
  if (kind === 'all') {
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

/** Parse and compile one relation type (design §9). */
function parseRelationType(
  raw: unknown,
  where: string,
  typeIds: ReadonlySet<string>,
  seenIds: Set<string>,
  limits: StructuredSlotLimitsV2,
): RelationTypeV2 {
  if (!isPlainObject(raw)) contractInvalid(`relation type at ${where} must be a plain object`);
  rejectUnknownFields(raw, RELATION_TYPE_FIELDS, where);
  const id = nonEmptyString(raw['id'], `${where}/id`);
  if (seenIds.has(id)) contractInvalid(`duplicate relation type id '${id}'`);
  seenIds.add(id);

  if (raw['direction'] !== 'directed') {
    contractInvalid(`direction at ${where} must be 'directed' (first-release relations are directed binary edges)`);
  }

  const fromSlotTypes = parseSlotTypeRefs(raw['fromSlotTypes'], `${where}/fromSlotTypes`, typeIds);
  const toSlotTypes = parseSlotTypeRefs(raw['toSlotTypes'], `${where}/toSlotTypes`, typeIds);

  const attributesSchema = parseAttributesSchema(raw['attributesSchema'], `${where}/attributesSchema`, limits);

  const semanticCriterion = nonEmptyString(raw['semanticCriterion'], `${where}/semanticCriterion`);

  if (typeof raw['enforcement'] !== 'string' || !ENFORCEMENTS.has(raw['enforcement'] as RelationTypeV2['enforcement'])) {
    contractInvalid(`enforcement at ${where} must be blocking|advisory`);
  }

  const invalidationRaw = raw['invalidation'];
  if (!isPlainObject(invalidationRaw)) contractInvalid(`invalidation at ${where} must be a plain object`);
  rejectUnknownFields(invalidationRaw, INVALIDATION_FIELDS, `${where}/invalidation`);
  if (invalidationRaw['direction'] !== 'downstream') {
    contractInvalid(`invalidation.direction at ${where} must be 'downstream'`);
  }
  const invalidation: RelationTypeV2['invalidation'] = {
    direction: 'downstream',
    maxHops: positiveSafeInt(invalidationRaw['maxHops'], `${where}/invalidation/maxHops`),
  };

  return {
    id,
    direction: 'directed',
    fromSlotTypes,
    toSlotTypes,
    attributesSchema,
    semanticCriterion,
    enforcement: raw['enforcement'] as RelationTypeV2['enforcement'],
    invalidation,
  };
}

function parseSlotTypeRefs(raw: unknown, where: string, typeIds: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw) || raw.length < 1) {
    contractInvalid(`${where} must be a non-empty array of declared slot types`);
  }
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const typeId = nonEmptyString(raw[i], `${where}/${i}`);
    if (seen.has(typeId)) contractInvalid(`duplicate slot type '${typeId}' at ${where}`);
    seen.add(typeId);
    if (!typeIds.has(typeId)) referenceUnknown(`relation endpoint type '${typeId}' at ${where} is not a declared slot type`);
    resolved.push(typeId);
  }
  return resolved;
}

/** attributesSchema: empty mapping = no attributes; otherwise a closed object schema. */
function parseAttributesSchema(
  raw: unknown,
  where: string,
  limits: StructuredSlotLimitsV2,
): RelationAttributesSchemaV2 {
  if (!isPlainObject(raw)) contractInvalid(`attributesSchema at ${where} must be a plain object`);
  if (Object.keys(raw).length === 0) return { presence: 'none' };
  if (raw['type'] !== 'object') contractInvalid(`attributesSchema root type must be 'object' at ${where}`);
  if (raw['additionalProperties'] !== false) {
    contractInvalid(`attributesSchema root additionalProperties must be false at ${where}`);
  }
  return { presence: 'schema', schema: compileSlotSchemaV1(raw, limits) };
}

/**
 * Relationship policy: an absent policy (or mode) reads as disabled
 * (design §9: "新模板若没有声明 relationshipPolicy，validator 按 disabled 解释").
 * A disabled policy may not carry declared relation types — a migration from
 * a relation-bearing template must choose the mode explicitly and can never
 * silently drop relations — and `optional` requires at least one declared type.
 */
function parseRelationshipPolicy(
  raw: unknown,
  relationTypesRaw: unknown,
): { policy: RelationshipPolicyV2; relationTypes: unknown[] } {
  let mode: 'disabled' | 'optional' = 'disabled';
  if (raw !== undefined) {
    if (!isPlainObject(raw)) contractInvalid('relationshipPolicy must be a plain object');
    rejectUnknownFields(raw, RELATIONSHIP_POLICY_FIELDS, 'relationshipPolicy');
    if (raw['mode'] !== undefined) {
      if (raw['mode'] !== 'disabled' && raw['mode'] !== 'optional') {
        contractInvalid(`relationshipPolicy.mode must be disabled|optional, got ${JSON.stringify(raw['mode'])}`);
      }
      mode = raw['mode'] as 'disabled' | 'optional';
    }
  }

  const relationTypesArray = relationTypesRaw !== undefined ? relationTypesRaw : [];
  if (!Array.isArray(relationTypesArray)) contractInvalid('relationTypes must be an array');

  if (mode === 'disabled') {
    if (relationTypesArray.length > 0) {
      contractInvalid(
        "relationshipPolicy.mode 'disabled' requires relationTypes to be absent or empty (never silently drop declared relations)",
      );
    }
  } else if (relationTypesArray.length < 1) {
    contractInvalid("relationshipPolicy.mode 'optional' requires at least one declared relation type");
  }
  return { policy: { mode }, relationTypes: relationTypesArray };
}

/** Normalize ReviewPolicyV2: four frozen literals, three spec defaults, two required fields. */
function parseReviewPolicy(raw: unknown): ReviewPolicyV2 {
  if (!isPlainObject(raw)) contractInvalid('reviewPolicy must be a plain object');
  rejectUnknownFields(raw, REVIEW_POLICY_FIELDS, 'reviewPolicy');

  const frozenLiteral = (value: unknown, field: string, literal: string): string => {
    if (value === undefined) return literal;
    if (value !== literal) {
      contractInvalid(`reviewPolicy.${field} must be '${literal}', got ${JSON.stringify(value)}`);
    }
    return literal;
  };

  const mapReview = frozenLiteral(raw['mapReview'], 'mapReview', 'required') as 'required';
  const contentSelector = frozenLiteral(
    raw['contentSelector'],
    'contentSelector',
    'content_bearing',
  ) as 'content_bearing';
  const wholeMapObservation = frozenLiteral(
    raw['wholeMapObservation'],
    'wholeMapObservation',
    'required',
  ) as 'required';
  const wholeContentTreeObservation = frozenLiteral(
    raw['wholeContentTreeObservation'],
    'wholeContentTreeObservation',
    'required',
  ) as 'required';

  const mapBatchTargetSlots =
    raw['mapBatchTargetSlots'] === undefined
      ? DEFAULT_BATCH_TARGET_SLOTS
      : positiveSafeInt(raw['mapBatchTargetSlots'], 'reviewPolicy.mapBatchTargetSlots');
  const contentBatchTargetSlots =
    raw['contentBatchTargetSlots'] === undefined
      ? DEFAULT_BATCH_TARGET_SLOTS
      : positiveSafeInt(raw['contentBatchTargetSlots'], 'reviewPolicy.contentBatchTargetSlots');
  const assignmentSoftLimit =
    raw['assignmentSoftLimit'] === undefined
      ? DEFAULT_ASSIGNMENT_SOFT_LIMIT
      : positiveSafeInt(raw['assignmentSoftLimit'], 'reviewPolicy.assignmentSoftLimit');

  const reviewAdvisoryRelations = raw['reviewAdvisoryRelations'];
  if (typeof reviewAdvisoryRelations !== 'boolean') {
    contractInvalid('reviewPolicy.reviewAdvisoryRelations is required and must be a boolean');
  }
  const maxRounds = positiveSafeInt(raw['maxRounds'], 'reviewPolicy.maxRounds');

  return {
    mapReview,
    contentSelector,
    mapBatchTargetSlots,
    contentBatchTargetSlots,
    assignmentSoftLimit,
    wholeMapObservation,
    wholeContentTreeObservation,
    reviewAdvisoryRelations,
    maxRounds,
  };
}

function parseImplementationRef(raw: unknown, where: string): { kind: 'builtin'; moduleId: string; exportName: string } {
  if (!isPlainObject(raw)) contractInvalid(`implementationRef at ${where} must be a plain object`);
  rejectUnknownFields(raw, IMPLEMENTATION_REF_FIELDS, `${where}/implementationRef`);
  if (raw['kind'] !== 'builtin') {
    contractInvalid(`implementationRef.kind at ${where} must be 'builtin' (v2 implementations are allowlisted builtins)`);
  }
  return {
    kind: 'builtin',
    moduleId: nonEmptyString(raw['moduleId'], `${where}/implementationRef/moduleId`),
    exportName: nonEmptyString(raw['exportName'], `${where}/implementationRef/exportName`),
  };
}

function parseValidator(
  raw: unknown,
  where: string,
  typeIds: ReadonlySet<string>,
  seenIds: Set<string>,
): ValidatorRegistrationV2 {
  if (!isPlainObject(raw)) contractInvalid(`validator at ${where} must be a plain object`);
  rejectUnknownFields(raw, VALIDATOR_FIELDS, where);
  const validatorId = nonEmptyString(raw['validatorId'], `${where}/validatorId`);
  if (seenIds.has(validatorId)) contractInvalid(`duplicate validator id '${validatorId}'`);
  seenIds.add(validatorId);

  const handlerKey = nonEmptyString(raw['handlerKey'], `${where}/handlerKey`);
  const implementationDigest = nonEmptyString(raw['implementationDigest'], `${where}/implementationDigest`);
  const implementationRef = parseImplementationRef(raw['implementationRef'], where);

  const trigger = raw['trigger'];
  if (typeof trigger !== 'string' || !VALIDATOR_TRIGGERS.has(trigger as ValidatorTriggerV2)) {
    contractInvalid(`validator '${validatorId}' trigger must be one of the seven v2 triggers`);
  }

  let executionPhase: ValidatorExecutionPhaseV2 = null;
  const rawPhase = raw['executionPhase'];
  if (rawPhase !== undefined) {
    if (rawPhase !== null && rawPhase !== 'batch_commit' && rawPhase !== 'plan_finalize') {
      contractInvalid(`validator '${validatorId}' executionPhase must be batch_commit|plan_finalize|null`);
    }
    executionPhase = rawPhase;
  }
  if (trigger === 'content_commit') {
    if (executionPhase === null) {
      contractInvalid(
        `validator '${validatorId}' with trigger content_commit must declare executionPhase batch_commit|plan_finalize`,
      );
    }
  } else if (executionPhase !== null) {
    contractInvalid(
      `validator '${validatorId}' executionPhase must be null for trigger '${trigger}' (only content_commit may use a non-null phase)`,
    );
  }

  const selector = parseSelector(raw['selector'], `${where}/selector`, typeIds);

  const enforcement = raw['enforcement'];
  if (typeof enforcement !== 'string' || !ENFORCEMENTS.has(enforcement as ValidatorRegistrationV2['enforcement'])) {
    contractInvalid(`validator '${validatorId}' enforcement must be blocking|advisory`);
  }
  if (trigger === 'seal_output' && enforcement === 'advisory') {
    contractInvalid(`validator '${validatorId}' seal_output registrations must be blocking (advisory is rejected)`);
  }

  if (raw['deterministic'] !== true) {
    contractInvalid(`validator '${validatorId}' deterministic must be the literal true`);
  }

  return {
    validatorId,
    handlerKey,
    implementationDigest,
    implementationRef,
    trigger: trigger as ValidatorTriggerV2,
    executionPhase,
    selector,
    enforcement: enforcement as ValidatorRegistrationV2['enforcement'],
    deterministic: true,
    inputContractVersion: nonNegativeSafeInt(raw['inputContractVersion'], `validator '${validatorId}' inputContractVersion`),
    outputContractVersion: nonNegativeSafeInt(
      raw['outputContractVersion'],
      `validator '${validatorId}' outputContractVersion`,
    ),
    budgetProfileId: nonEmptyString(raw['budgetProfileId'], `validator '${validatorId}' budgetProfileId`),
  };
}

function parseValidators(raw: unknown, typeIds: ReadonlySet<string>): ValidatorRegistrationV2[] {
  if (!Array.isArray(raw)) contractInvalid('validators must be an array');
  const seen = new Set<string>();
  return raw.map((validator, i) => parseValidator(validator, `validators/${i}`, typeIds, seen));
}

/** Contained relative artifact path: no traversal, no absolute path, no backslash/NUL. */
function assertContainedRelativePath(path: string, where: string): void {
  if (path.length === 0) contractInvalid(`artifactFile at ${where} must be a non-empty relative path`);
  if (path.includes('\\')) contractInvalid(`artifactFile at ${where} contains a backslash`);
  if (path.includes('\0')) contractInvalid(`artifactFile at ${where} contains NUL`);
  if (isAbsolute(path)) contractInvalid(`artifactFile at ${where} must be a relative path`);
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment.length === 0) contractInvalid(`artifactFile at ${where} contains an empty segment`);
    if (segment === '.' || segment === '..') {
      contractInvalid(`artifactFile at ${where} contains a '${segment}' segment`);
    }
  }
}

function parseRoute(raw: unknown, where: string, seenIds: Set<string>): AssemblerRouteV2 {
  if (!isPlainObject(raw)) contractInvalid(`route at ${where} must be a plain object`);
  rejectUnknownFields(raw, ROUTE_FIELDS, where);
  const id = nonEmptyString(raw['id'], `${where}/id`);
  if (seenIds.has(id)) contractInvalid(`duplicate route id '${id}' at ${where}`);
  seenIds.add(id);
  const artifactFile = nonEmptyString(raw['artifactFile'], `${where}/artifactFile`);
  assertContainedRelativePath(artifactFile, where);
  const mediaType = raw['mediaType'];
  if (typeof mediaType !== 'string' || !ROUTE_MEDIA_TYPES.has(mediaType as AssemblerRouteV2['mediaType'])) {
    contractInvalid(`mediaType at ${where} must be application/json|text/markdown|text/plain`);
  }
  return { id, artifactFile, mediaType: mediaType as AssemblerRouteV2['mediaType'] };
}

function parseAssembler(raw: unknown): AssemblerRegistrationV2 {
  if (!isPlainObject(raw)) contractInvalid('assembler must be a plain object (exactly one)');
  rejectUnknownFields(raw, ASSEMBLER_FIELDS, 'assembler');
  if (raw['abi'] !== 'forge-assembler/v2') {
    contractInvalid("assembler abi must be 'forge-assembler/v2'");
  }
  const handlerKey = nonEmptyString(raw['handlerKey'], 'assembler/handlerKey');
  const implementationDigest = nonEmptyString(raw['implementationDigest'], 'assembler/implementationDigest');
  const implementationRef = parseImplementationRef(raw['implementationRef'], 'assembler');

  const budgetRaw = raw['budget'];
  if (!isPlainObject(budgetRaw)) contractInvalid('assembler budget must be a plain object');
  rejectUnknownFields(budgetRaw, ASSEMBLER_BUDGET_FIELDS, 'assembler/budget');
  const budget: AssemblerBudgetV2 = {
    timeoutMs: positiveSafeInt(budgetRaw['timeoutMs'], 'assembler/budget/timeoutMs'),
    maxInputBytes: positiveSafeInt(budgetRaw['maxInputBytes'], 'assembler/budget/maxInputBytes'),
    maxOutputBytes: positiveSafeInt(budgetRaw['maxOutputBytes'], 'assembler/budget/maxOutputBytes'),
  };

  const routesRaw = raw['routes'];
  if (!Array.isArray(routesRaw)) contractInvalid('assembler routes must be an array');
  if (routesRaw.length < 1) contractInvalid('assembler routes must not be empty');
  const seen = new Set<string>();
  const routes = routesRaw.map((route, i) => parseRoute(route, `assembler/routes/${i}`, seen));

  return { abi: 'forge-assembler/v2', handlerKey, implementationDigest, implementationRef, budget, routes };
}

/** Canonical projection: the normalized contract rebuilt from parsed values. */
function buildCanonicalContract(
  rawTop: Record<string, unknown>,
  slotTypes: FrozenSlotTypeV2[],
  accessProfiles: AccessProfileV2[],
  relationTypes: RelationTypeV2[],
  relationshipPolicy: RelationshipPolicyV2,
  reviewPolicy: ReviewPolicyV2,
  validators: ValidatorRegistrationV2[],
  assembler: AssemblerRegistrationV2,
  limits: StructuredSlotLimitsV2,
): Record<string, unknown> {
  const rawRelationTypes = (rawTop['relationTypes'] ?? []) as Array<Record<string, unknown>>;

  return {
    version: 2,
    slotTypes: slotTypes.map((slotType, i) => {
      const raw = (rawTop['slotTypes'] as Array<Record<string, unknown>>)[i];
      const content = raw['content'] as Record<string, unknown>;
      return {
        id: slotType.id,
        name: slotType.name,
        description: slotType.description,
        specSchema: raw['specSchema'],
        content:
          slotType.content.presence === 'forbidden'
            ? { presence: 'forbidden' }
            : { presence: slotType.content.presence, schema: content['schema'] },
      };
    }),
    layoutGrammar: rawTop['layoutGrammar'],
    accessProfiles,
    relationTypes: relationTypes.map((relationType, i) => ({
      id: relationType.id,
      direction: relationType.direction,
      fromSlotTypes: relationType.fromSlotTypes,
      toSlotTypes: relationType.toSlotTypes,
      attributesSchema:
        relationType.attributesSchema.presence === 'none' ? {} : rawRelationTypes[i]['attributesSchema'],
      semanticCriterion: relationType.semanticCriterion,
      enforcement: relationType.enforcement,
      invalidation: relationType.invalidation,
    })),
    relationshipPolicy,
    reviewPolicy,
    validators: validators.map((validator) => ({
      validatorId: validator.validatorId,
      handlerKey: validator.handlerKey,
      implementationDigest: validator.implementationDigest,
      implementationRef: validator.implementationRef,
      trigger: validator.trigger,
      executionPhase: validator.executionPhase,
      selector: validator.selector,
      enforcement: validator.enforcement,
      deterministic: validator.deterministic,
      inputContractVersion: validator.inputContractVersion,
      outputContractVersion: validator.outputContractVersion,
      budgetProfileId: validator.budgetProfileId,
    })),
    assembler: {
      abi: assembler.abi,
      handlerKey: assembler.handlerKey,
      implementationDigest: assembler.implementationDigest,
      implementationRef: assembler.implementationRef,
      budget: assembler.budget,
      routes: assembler.routes,
    },
    limits,
  };
}

/** Deterministic total order over implementation identity entries. */
function compareIdentityClosureEntries(
  a: ImplementationIdentityClosureEntryV2,
  b: ImplementationIdentityClosureEntryV2,
): number {
  const fieldsA: unknown[] = [
    a.kind,
    a.kind === 'validator' ? a.validatorId : '',
    a.kind === 'validator' ? a.trigger : '',
    a.kind === 'validator' ? a.executionPhase ?? '' : '',
    a.handlerKey,
    a.implementationDigest,
    a.moduleId,
    a.exportName,
  ];
  const fieldsB: unknown[] = [
    b.kind,
    b.kind === 'validator' ? b.validatorId : '',
    b.kind === 'validator' ? b.trigger : '',
    b.kind === 'validator' ? b.executionPhase ?? '' : '',
    b.handlerKey,
    b.implementationDigest,
    b.moduleId,
    b.exportName,
  ];
  for (let i = 0; i < fieldsA.length; i++) {
    const aValue = fieldsA[i] as string;
    const bValue = fieldsB[i] as string;
    if (aValue < bValue) return -1;
    if (aValue > bValue) return 1;
  }
  return 0;
}

function buildImplementationIdentityClosure(
  validators: ValidatorRegistrationV2[],
  assembler: AssemblerRegistrationV2,
): ImplementationIdentityClosureEntryV2[] {
  const closure: ImplementationIdentityClosureEntryV2[] = validators.map((validator) => ({
    kind: 'validator',
    validatorId: validator.validatorId,
    trigger: validator.trigger,
    executionPhase: validator.executionPhase,
    handlerKey: validator.handlerKey,
    implementationDigest: validator.implementationDigest,
    moduleId: validator.implementationRef.moduleId,
    exportName: validator.implementationRef.exportName,
  }));
  closure.push({
    kind: 'assembler',
    handlerKey: assembler.handlerKey,
    implementationDigest: assembler.implementationDigest,
    moduleId: assembler.implementationRef.moduleId,
    exportName: assembler.implementationRef.exportName,
  });
  closure.sort(compareIdentityClosureEntries);
  return closure;
}

function deepFreeze<T>(value: T): T {
  // Buffer / typed-array views and raw ArrayBuffers cannot be frozen; their
  // contents are immutable by construction at this point (canonical bytes).
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Compile a structured-slot contract v2 from a template package root.
 *
 * `templateRoot` is the template package directory containing `slots/`. No
 * profile argument: template/limit-envelope comparisons are Task 5's job, this
 * compiler only enforces positivity/finiteness/integrality. Throws a
 * stable-coded `Error` on any violation and returns an immutable, deep-frozen
 * `FrozenStructuredSlotContractV2` on success.
 */
export async function compileStructuredSlotContractV2(
  templateRoot: string,
): Promise<FrozenStructuredSlotContractV2> {
  const rawContract = await readContractYaml(templateRoot);
  if (!isPlainObject(rawContract)) contractInvalid('contract.yaml must be a mapping');
  assertExactTopLevel(rawContract);
  // Version dispatch is Task 5's concern via peekStructuredSlotContractVersion;
  // the compiler additionally pins `version: 2` in the exact top-level check.

  const limits = rawContract['limits'] as unknown as StructuredSlotLimitsV2;
  assertPositiveLimitsShape(rawContract['limits'], 'template');

  const { frozen: slotTypes, typeIds } = parseSlotTypes(rawContract['slotTypes'], limits);

  const layoutGrammar = compileLayoutGrammarV1(
    rawContract['layoutGrammar'] as unknown as LayoutGrammarV1,
    typeIds,
    limits,
  );

  const accessProfiles = parseAccessProfiles(rawContract['accessProfiles']);

  const { policy: relationshipPolicy, relationTypes: relationTypesRaw } = parseRelationshipPolicy(
    rawContract['relationshipPolicy'],
    rawContract['relationTypes'],
  );
  const relationTypeIds = new Set<string>();
  const relationTypes =
    relationTypesRaw.length > 0
      ? (relationTypesRaw as unknown[]).map((relation, i) =>
          parseRelationType(relation, `relationTypes/${i}`, typeIds, relationTypeIds, limits),
        )
      : [];

  const reviewPolicy = parseReviewPolicy(rawContract['reviewPolicy']);

  const validators = parseValidators(rawContract['validators'], typeIds);

  const assembler = parseAssembler(rawContract['assembler']);

  const canonicalContract = buildCanonicalContract(
    rawContract,
    slotTypes,
    accessProfiles,
    relationTypes,
    relationshipPolicy,
    reviewPolicy,
    validators,
    assembler,
    limits,
  );
  const canonicalBytes = canonicalJsonBytes(canonicalContract);
  const semanticDigest = createHash('sha256').update(canonicalBytes).digest('hex');
  const implementationIdentityClosure = buildImplementationIdentityClosure(validators, assembler);

  return deepFreeze({
    version: 2,
    slotTypes,
    layoutGrammar,
    accessProfiles,
    relationTypes,
    relationshipPolicy,
    reviewPolicy,
    validators,
    assembler,
    limits,
    canonicalBytes,
    semanticDigest,
    implementationIdentityClosure,
  });
}