/**
 * Task 14 minimal platform-generic builtin validators (spec §12/§16.3, design
 * §9).
 *
 * The first-release v2 allowlist is installed platform code, never
 * template-supplied sources. These builtins are the MINIMAL deterministic
 * handlers the fixtures need:
 *
 * - `authoritative.review.completeness`  (map_candidate_commit)   — structural
 *   candidate completeness: unique slot ids, resolved parents, unique
 *   document order, relation endpoints resolve.
 * - `authoritative.review.slotSchema`    (content_commit/batch_commit) — a
 *   structural content-schema subset validator (string/number/boolean/object
 *   types, min/max length, pattern, enum, required, additionalProperties).
 * - `authoritative.review.coverage`      (content_commit/plan_finalize) —
 *   required-slot coverage over the resolved provisional manifest.
 * - `authoritative.review.artifactPath`  (seal_output) — assembler output
 *   artifact route/media-type validation.
 *
 * NO template-specific Zhihu validation lives here (that is Task 25's
 * installed source modules). Every builtin is a deterministic CommonJS module
 * exporting `validate`; the engine runs it in the hardened isolated-vm sandbox
 * (network/clock/random/task-I/O denied). The implementation digest is frozen
 * as `sha256(canonical UTF-8 source bytes)` — deterministic and recomputable.
 *
 * The handler output is the closed v2 ABI `ValidatorResultV2` shape; the
 * engine normalizes/verifies it and computes the real `executionDigest` (the
 * sandbox has no hashing primitive). Issues are built with `repairTargets`
 * empty except where the trigger requires them; the engine validates every
 * issue location/repair target against the selected snapshot.
 */
import { createHash } from 'node:crypto';
import type { InstalledValidatorHandlerIdentityV1 } from '../../structured-slots/authoritative-review-profile';
import type { InstalledValidatorEntry } from './validator-registry';

/** The installed module namespace of the platform builtins. */
export const AUTHORITATIVE_REVIEW_BUILTIN_MODULE_ID = '@forge/authoritative-review';

/** The installed builtin ABI identity (spec §6.5). */
export const AUTHORITATIVE_REVIEW_BUILTIN_ABI = 'forge-validator/v2' as const;

/** The platform-frozen budget profile id shared by every builtin. */
export const AUTHORITATIVE_REVIEW_BUILTIN_BUDGET_PROFILE_ID = 'authoritative-validator-default' as const;

/** The ABI contract versions spoken by every installed builtin. */
export const AUTHORITATIVE_REVIEW_BUILTIN_CONTRACT_VERSION = 2 as const;

/** Deterministic implementation digest: sha256 over the canonical source bytes. */
function implementationDigestOf(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/**
 * Candidate-level STRUCTURAL issue codes: findings about the candidate's
 * STRUCTURE where no stable snapshot-member identity exists (a malformed node,
 * a relation missing its id, a content target missing its slotId). Their
 * location `stableTargetId` carries the STABLE ordinal sentinel
 * `#node-<i>` / `#relation-<j>` / `#slot-<k>` — the engine treats these as
 * candidate-level locations (never fake snapshot targets) and routes them as
 * domain_invalid (a deterministic repair receipt), never as an infrastructure
 * failure (spec §12).
 */
export const VALIDATOR_STRUCTURAL_ISSUE_CODES: readonly string[] = [
  'structure.invalid_node',
  'structure.node_missing_slot_id',
  'structure.invalid_relation',
  'structure.relation_missing_id',
  'content.target_missing_slot_id',
];

/** True when an issue code is a candidate-level structural finding. */
export function isStructuralIssueCode(issueCode: string): boolean {
  return VALIDATOR_STRUCTURAL_ISSUE_CODES.includes(issueCode);
}

const ISSUE_HELPER = `
function makeIssue(input, code, targetKind, stableTargetId, message) {
  return {
    validatorId: input.validatorId,
    implementationDigest: input.implementationDigest,
    issueCode: code,
    location: { targetKind: targetKind, stableTargetId: stableTargetId || '', jsonPointer: null },
    repairTargets: { mapNodeIds: [], relationIds: [], slotIds: [] },
    evidenceDigest: ''
  };
}
function resultOf(input, issues) {
  if (issues.length > 0) {
    return { status: 'domain_invalid', issues: issues, executionDigest: '' };
  }
  return { status: 'valid', executionDigest: '' };
}
`;

/** Structural candidate completeness (map_candidate_commit). */
const COMPLETENESS_SOURCE = `'use strict';
module.exports = {
  validate: function validate(input) {
    var issues = [];
    var core = input && typeof input.core === 'object' ? input.core : {};
    var nodes = Array.isArray(core.nodes) ? core.nodes : [];
    var relations = Array.isArray(core.relations) ? core.relations : [];
    var nodeIds = new Set();
    var orderSeen = new Set();
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || typeof node !== 'object') {
        // No identity exists for a malformed node: the STABLE SENTINEL is the
        // candidate-relative ordinal (#node-<i>), documented as a candidate-level
        // structural finding (never a fake snapshot target).
        issues.push(makeIssue(input, 'structure.invalid_node', 'node', '#node-' + i, 'candidate node must be an object'));
        continue;
      }
      if (typeof node.slotId !== 'string' || node.slotId.length === 0) {
        issues.push(makeIssue(input, 'structure.node_missing_slot_id', 'node', '#node-' + i, 'candidate node is missing slotId'));
        continue;
      }
      if (nodeIds.has(node.slotId)) {
        issues.push(makeIssue(input, 'structure.duplicate_slot_id', 'node', node.slotId, 'duplicate candidate slotId'));
      }
      nodeIds.add(node.slotId);
      if (typeof node.documentOrder !== 'number') {
        issues.push(makeIssue(input, 'structure.node_missing_order', 'node', node.slotId, 'candidate node is missing documentOrder'));
      } else if (orderSeen.has(node.documentOrder)) {
        issues.push(makeIssue(input, 'structure.duplicate_document_order', 'node', node.slotId, 'duplicate candidate documentOrder'));
      } else {
        orderSeen.add(node.documentOrder);
      }
      if (node.parentSlotId !== null && node.parentSlotId !== undefined && !nodeIds.has(node.parentSlotId)) {
        issues.push(makeIssue(input, 'structure.unresolved_parent', 'node', node.slotId, 'candidate parentSlotId does not resolve'));
      }
    }
    for (var j = 0; j < relations.length; j++) {
      var rel = relations[j];
      if (!rel || typeof rel !== 'object') {
        issues.push(makeIssue(input, 'structure.invalid_relation', 'relation', '#relation-' + j, 'candidate relation must be an object'));
        continue;
      }
      if (typeof rel.relationId !== 'string' || rel.relationId.length === 0) {
        issues.push(makeIssue(input, 'structure.relation_missing_id', 'relation', '#relation-' + j, 'candidate relation is missing relationId'));
        continue;
      }
      if (typeof rel.typeId !== 'string' || rel.typeId.length === 0) {
        issues.push(makeIssue(input, 'structure.relation_missing_type', 'relation', rel.relationId, 'candidate relation is missing typeId'));
      }
      if (typeof rel.fromSlotId !== 'string' || !nodeIds.has(rel.fromSlotId)) {
        issues.push(makeIssue(input, 'structure.relation_unresolved_from', 'relation', rel.relationId, 'candidate relation fromSlotId does not resolve to a node'));
      }
      if (typeof rel.toSlotId !== 'string' || !nodeIds.has(rel.toSlotId)) {
        issues.push(makeIssue(input, 'structure.relation_unresolved_to', 'relation', rel.relationId, 'candidate relation toSlotId does not resolve to a node'));
      }
    }
    return resultOf(input, issues);
  }
};
`;

const SCHEMA_SUBSET = `
function validateSchema(schema, value, problems) {
  if (!schema || typeof schema !== 'object') {
    return;
  }
  if (Array.isArray(schema.type)) {
    var unionOk = false;
    for (var u = 0; u < schema.type.length; u++) {
      var t = schema.type[u];
      if (t === 'string' && typeof value === 'string') unionOk = true;
      else if (t === 'number' && typeof value === 'number') unionOk = true;
      else if (t === 'integer' && typeof value === 'number' && value % 1 === 0) unionOk = true;
      else if (t === 'boolean' && typeof value === 'boolean') unionOk = true;
      else if (t === 'null' && value === null) unionOk = true;
    }
    if (!unionOk) problems.push({ code: 'type', message: 'does not match any allowed type' });
    return;
  }
  var type = schema.type;
  if (type === 'string') {
    if (typeof value !== 'string') { problems.push({ code: 'type', message: 'expected a string' }); return; }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) problems.push({ code: 'minLength', message: 'shorter than minLength' });
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) problems.push({ code: 'maxLength', message: 'longer than maxLength' });
    if (typeof schema.pattern === 'string' && schema.pattern.length > 0) {
      try {
        if (!new RegExp(schema.pattern).test(value)) problems.push({ code: 'pattern', message: 'does not match pattern' });
      } catch (e) { /* malformed pattern never blocks */ }
    }
    if (Array.isArray(schema.enum) && schema.enum.indexOf(value) === -1) problems.push({ code: 'enum', message: 'not in enum' });
    return;
  }
  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number') { problems.push({ code: 'type', message: 'expected a number' }); return; }
    if (type === 'integer' && value % 1 !== 0) problems.push({ code: 'integer', message: 'expected an integer' });
    if (typeof schema.minimum === 'number' && value < schema.minimum) problems.push({ code: 'minimum', message: 'below minimum' });
    if (typeof schema.maximum === 'number' && value > schema.maximum) problems.push({ code: 'maximum', message: 'above maximum' });
    return;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') problems.push({ code: 'type', message: 'expected a boolean' });
    return;
  }
  if (type === 'null') {
    if (value !== null) problems.push({ code: 'type', message: 'expected null' });
    return;
  }
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) { problems.push({ code: 'type', message: 'expected an object' }); return; }
    var props = schema.properties;
    if (schema.additionalProperties === false && props && typeof props === 'object') {
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key) && !Object.prototype.hasOwnProperty.call(props, key)) {
          problems.push({ code: 'additionalProperties', message: 'unexpected property ' + key });
        }
      }
    }
    if (Array.isArray(schema.required)) {
      for (var r = 0; r < schema.required.length; r++) {
        var req = schema.required[r];
        if (!Object.prototype.hasOwnProperty.call(value, req)) {
          problems.push({ code: 'required', message: 'missing required property ' + req });
        }
      }
    }
    if (props && typeof props === 'object') {
      for (var pk in props) {
        if (Object.prototype.hasOwnProperty.call(props, pk) && Object.prototype.hasOwnProperty.call(value, pk)) {
          validateSchema(props[pk], value[pk], problems);
        }
      }
    }
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) { problems.push({ code: 'type', message: 'expected an array' }); return; }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) problems.push({ code: 'minItems', message: 'fewer items than minItems' });
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) problems.push({ code: 'maxItems', message: 'more items than maxItems' });
    if (schema.items && typeof schema.items === 'object') {
      for (var ai = 0; ai < value.length; ai++) validateSchema(schema.items, value[ai], problems);
    }
    return;
  }
  /* unknown schema type: structurally valid (fail open is never possible here:
     the engine still owns enforcement and the closed result shape). */
}
`;

/** Structural content-schema subset validator (content_commit/batch_commit). */
const SLOT_SCHEMA_SOURCE = `'use strict';
module.exports = {
  validate: function validate(input) {
    var issues = [];
    var targets = Array.isArray(input.targets) ? input.targets : [];
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var slotId = t && typeof t.slotId === 'string' ? t.slotId : null;
      if (slotId === null) {
        // The target has no stable slot identity: emit a candidate-level
        // structural finding with the STABLE ordinal sentinel (#slot-<i>).
        issues.push(makeIssue(input, 'content.target_missing_slot_id', 'slot', '#slot-' + i, 'content target is missing slotId'));
        continue;
      }
      var schema = t && t.contentSchema ? t.contentSchema : null;
      var value = t && 'content' in t ? t.content : null;
      var presence = t ? t.contentPresence : null;
      if (presence === 'forbidden' && value !== null) {
        issues.push(makeIssue(input, 'content.forbidden_content', 'slot', slotId, 'content is present on a forbidden slot'));
        continue;
      }
      if (presence === 'required' && (value === null || value === undefined)) {
        issues.push(makeIssue(input, 'content.required_missing', 'slot', slotId, 'required slot has no content'));
        continue;
      }
      var problems = [];
      validateSchema(schema, value, problems);
      for (var k = 0; k < problems.length; k++) {
        issues.push(makeIssue(input, 'content.schema.' + problems[k].code, 'slot', slotId, problems[k].message));
      }
    }
    return resultOf(input, issues);
  }
};
`;

/** Required-slot coverage over the resolved provisional manifest (plan_finalize). */
const COVERAGE_SOURCE = `'use strict';
module.exports = {
  validate: function validate(input) {
    var issues = [];
    var core = input && typeof input.core === 'object' ? input.core : {};
    var manifest = core.provisionalManifest && typeof core.provisionalManifest === 'object' ? core.provisionalManifest : {};
    var entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    var entryBySlot = {};
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e && typeof e.slotId === 'string') entryBySlot[e.slotId] = e;
    }
    var context = input && typeof input.context === 'object' ? input.context : {};
    var required = Array.isArray(context.requiredSlotIds) ? context.requiredSlotIds : [];
    for (var j = 0; j < required.length; j++) {
      var slotId = required[j];
      var entry = entryBySlot[slotId];
      var state = entry ? entry.state : 'missing';
      if (state !== 'set') {
        issues.push(makeIssue(input, 'coverage.required_not_set', 'slot', slotId, 'required slot is not set'));
      }
    }
    return resultOf(input, issues);
  }
};
`;

/** Assembler artifact route/media-type validation (seal_output). */
const ARTIFACT_PATH_SOURCE = `'use strict';
module.exports = {
  validate: function validate(input) {
    var issues = [];
    var context = input && typeof input.context === 'object' ? input.context : {};
    var routeId = context.artifactRouteId;
    var mediaType = context.artifactMediaType;
    var routes = Array.isArray(context.assemblerRoutes) ? context.assemblerRoutes : [];
    var artifactDigest = typeof context.artifactDigest === 'string' ? context.artifactDigest : '';
    if (typeof routeId !== 'string' || routeId.length === 0) {
      issues.push(makeIssue(input, 'artifact.missing_route', 'artifact', artifactDigest, 'seal_output artifact is missing its assembler route id'));
      return resultOf(input, issues);
    }
    var matched = null;
    for (var i = 0; i < routes.length; i++) {
      if (routes[i] && routes[i].id === routeId) { matched = routes[i]; break; }
    }
    if (!matched) {
      issues.push(makeIssue(input, 'artifact.undeclared_route', 'artifact', artifactDigest, 'artifact route id ' + routeId + ' is not declared by the assembler'));
      return resultOf(input, issues);
    }
    if (mediaType && matched.mediaType && mediaType !== matched.mediaType) {
      issues.push(makeIssue(input, 'artifact.media_type_mismatch', 'artifact', artifactDigest, 'artifact media type does not match the declared route ' + routeId));
    }
    return resultOf(input, issues);
  }
};
`;

export interface BuiltinValidatorDefinition {
  /** The frozen installed identity (registry entry). */
  entry: InstalledValidatorEntry;
  /** The exact sandbox source (CommonJS module exporting `validate`). */
  source: string;
  /** Deterministic implementation digest over the source bytes. */
  implementationDigest: string;
}

function define(
  handlerKey: string,
  exportName: string,
  trigger: InstalledValidatorEntry['trigger'],
  executionPhase: InstalledValidatorEntry['executionPhase'],
  source: string,
): BuiltinValidatorDefinition {
  return {
    entry: {
      handlerKey,
      implementationDigest: '',
      moduleId: AUTHORITATIVE_REVIEW_BUILTIN_MODULE_ID,
      exportName,
      trigger,
      executionPhase,
      abi: AUTHORITATIVE_REVIEW_BUILTIN_ABI,
      budgetProfileId: AUTHORITATIVE_REVIEW_BUILTIN_BUDGET_PROFILE_ID,
      inputContractVersion: AUTHORITATIVE_REVIEW_BUILTIN_CONTRACT_VERSION,
      outputContractVersion: AUTHORITATIVE_REVIEW_BUILTIN_CONTRACT_VERSION,
    },
    source,
    implementationDigest: implementationDigestOf(source),
  };
}

function entryOf(definition: BuiltinValidatorDefinition): InstalledValidatorEntry {
  return { ...definition.entry, implementationDigest: definition.implementationDigest };
}

/** The installed production validator builtins (frozen identities + digests). */
export const AUTHORITATIVE_REVIEW_BUILTIN_VALIDATORS: readonly BuiltinValidatorDefinition[] = [
  define(
    'authoritative.review.completeness',
    'completeness',
    'map_candidate_commit',
    null,
    `${ISSUE_HELPER}\n${COMPLETENESS_SOURCE}`,
  ),
  define(
    'authoritative.review.slotSchema',
    'slotSchema',
    'content_commit',
    'batch_commit',
    `${ISSUE_HELPER}\n${SCHEMA_SUBSET}\n${SLOT_SCHEMA_SOURCE}`,
  ),
  define(
    'authoritative.review.coverage',
    'coverage',
    'content_commit',
    'plan_finalize',
    `${ISSUE_HELPER}\n${COVERAGE_SOURCE}`,
  ),
  define(
    'authoritative.review.artifactPath',
    'artifactPath',
    'seal_output',
    null,
    `${ISSUE_HELPER}\n${ARTIFACT_PATH_SOURCE}`,
  ),
];

/** The installed registry entries (frozen implementation digests). */
export const AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES: readonly InstalledValidatorEntry[] =
  AUTHORITATIVE_REVIEW_BUILTIN_VALIDATORS.map(entryOf);

/** The installed profile identities (`installedHandlers.validators`). */
export const AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_IDENTITIES: readonly InstalledValidatorHandlerIdentityV1[] =
  AUTHORITATIVE_REVIEW_BUILTIN_VALIDATORS.map((definition) => ({
    handlerKey: definition.entry.handlerKey,
    implementationDigest: definition.implementationDigest,
    moduleId: definition.entry.moduleId,
    exportName: definition.entry.exportName,
    trigger: definition.entry.trigger,
    executionPhase: definition.entry.executionPhase,
  }));

/** The exact profile installed-handlers shape (validators + assembler). */
export function builtinValidatorRegistryEntries(): readonly InstalledValidatorEntry[] {
  return [...AUTHORITATIVE_REVIEW_BUILTIN_VALIDATOR_ENTRIES];
}

/** Source lookup by handlerKey (for tests and the engine). */
export function builtinSourceOf(handlerKey: string): string | null {
  for (const definition of AUTHORITATIVE_REVIEW_BUILTIN_VALIDATORS) {
    if (definition.entry.handlerKey === handlerKey) {
      return definition.source;
    }
  }
  return null;
}
