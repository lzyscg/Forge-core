/**
 * Slot Schema v1 compiler + pure value validator (design §8.3, §25.2 B01-B05,
 * spec §4.2, spec §5 limits).
 *
 * The dialect is frozen: every node is an explicit mapping with a single
 * `type` (no boolean schemas, no type unions, no references, no composition,
 * no conditionals); only the whitelisted keywords per type are accepted.
 * Objects must explicitly declare `additionalProperties: false | schema`
 * (never unconstrained true), arrays must declare a single `items` schema.
 * `enum`/`const` are mutually exclusive and type-sensitive (canonical-hash
 * dedup). Schema only validates — it never fills defaults, converts, trims or
 * mutates input.
 *
 * Length keywords count Unicode code points (B02); `compileSafeRegexV1` is the
 * only pattern engine (B03); numeric bounds and runtime integers are finite /
 * safe integers (B01). The injected `StructuredSlotLimitsV1.schema` group
 * bounds depth (root = 1), total nodes, enum items and pattern length.
 *
 * `compileSlotSchemaV1` throws `SPEC_SCHEMA_INVALID` on any meta-schema
 * failure; `validateSlotValue` is pure (never mutates its input) and returns
 * `SPEC_SCHEMA_INVALID` issues at the `structure` phase or `CONTENT_SCHEMA_INVALID`
 * issues at `draft` / `merge` / `seal_input`, sorted by schema pointer,
 * instance pointer, keyword, then code.
 */
import type {
  IssueLocation,
  IssuePhase,
  JsonObject,
  JsonValue,
  StructuredIssueV1,
  StructuredSlotLimitsV1,
} from '../../shared/structured-slots';
import { canonicalJsonSha256 } from './canonical-json';
import { makeStructuredIssue } from './issues';
import {
  compileSafeRegexV1,
  SafeRegexError,
  type CompiledSafeRegexV1,
} from './safe-regex';

/** The seven base JSON types of dialect v1 (design §8.3). */
export type SchemaType = 'string' | 'number' | 'integer' | 'object' | 'array' | 'boolean' | 'null';

const SCHEMA_TYPES: readonly string[] = [
  'string',
  'number',
  'integer',
  'object',
  'array',
  'boolean',
  'null',
];

function isSchemaType(value: unknown): value is SchemaType {
  return typeof value === 'string' && SCHEMA_TYPES.includes(value);
}

/**
 * Exact keyword whitelist per type (design §8.3 / plan Step 5). Any other key
 * on a schema node fails closed at compile time.
 */
const KEYWORDS_BY_TYPE = {
  string: new Set(['type', 'description', 'enum', 'const', 'minLength', 'maxLength', 'pattern']),
  number: new Set(['type', 'description', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']),
  integer: new Set(['type', 'description', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']),
  object: new Set(['type', 'description', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties']),
  array: new Set(['type', 'description', 'enum', 'const', 'items', 'minItems', 'maxItems', 'uniqueItems']),
  boolean: new Set(['type', 'description', 'enum', 'const']),
  null: new Set(['type', 'description', 'enum', 'const']),
} as const;

/**
 * Immutable compiled schema tree. Nested nodes are compiled recursively and
 * the whole tree is deeply frozen; it is safe to reuse across many
 * `validateSlotValue` calls. The `_enumHashes` / `_constHash` fields are
 * internal precomputed canonical hashes used by the validator.
 */
export interface CompiledSlotSchemaV1 {
  readonly type: SchemaType;
  readonly description?: string;
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: CompiledSafeRegexV1;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly properties?: Readonly<Record<string, CompiledSlotSchemaV1>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false | CompiledSlotSchemaV1;
  readonly minProperties?: number;
  readonly maxProperties?: number;
  readonly items?: CompiledSlotSchemaV1;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  /** @internal Type-sensitive canonical hashes of the deduped enum items. */
  readonly _enumHashes?: ReadonlySet<string>;
  /** @internal Canonical hash of the const value. */
  readonly _constHash?: string;
}

/** Compile-time budget carried through the whole schema tree. */
interface CompileContext {
  limits: StructuredSlotLimitsV1['schema'];
  nodeCount: number;
}

/** Writable builder shape used while assembling a node before freezing. */
type MutableNode = { -readonly [K in keyof CompiledSlotSchemaV1]?: CompiledSlotSchemaV1[K] };

function specInvalid(reason: string): never {
  throw new Error(`SPEC_SCHEMA_INVALID: ${reason}`);
}

function isSchemaNodeObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function mustBeString(value: unknown, keyword: string, where: string): string {
  if (typeof value !== 'string') specInvalid(`${keyword} must be a string at ${where}`);
  return value;
}

function mustBeNonNegativeSafeInt(value: unknown, keyword: string, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    specInvalid(`${keyword} must be a non-negative safe integer at ${where}`);
  }
  return value;
}

function mustBeFiniteNumber(value: unknown, keyword: string, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    specInvalid(`${keyword} must be a finite JSON number at ${where}`);
  }
  return value;
}

function mustBeBoolean(value: unknown, keyword: string, where: string): boolean {
  if (typeof value !== 'boolean') specInvalid(`${keyword} must be a boolean at ${where}`);
  return value;
}

/**
 * B04: enum/const values are only string, finite number, boolean or null and
 * must match the node type exactly. Object/array constants are deferred in v1.
 */
function assertEnumScalar(value: unknown, type: SchemaType, where: string): JsonValue {
  switch (type) {
    case 'string':
      if (typeof value === 'string') return value;
      break;
    case 'number':
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      break;
    case 'integer':
      if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
      break;
    case 'boolean':
      if (typeof value === 'boolean') return value;
      break;
    case 'null':
      if (value === null) return value;
      break;
    default:
      specInvalid(`enum/const is not supported for type '${type}' at ${where} (object/array constants are deferred in v1)`);
  }
  specInvalid(`enum/const value at ${where} must be a ${type} (only string, finite number, boolean or null)`);
}

/** Dedup enum items by type-sensitive canonical hash, preserving first order. */
function compileEnum(
  raw: unknown,
  type: SchemaType,
  where: string,
  limits: CompileContext['limits'],
): { values: readonly JsonValue[]; hashes: ReadonlySet<string> } {
  if (!Array.isArray(raw)) specInvalid(`enum must be an array at ${where}`);
  const hashes = new Set<string>();
  const values: JsonValue[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = assertEnumScalar(raw[i], type, `${where}/enum/${i}`);
    const hash = canonicalJsonSha256(item);
    if (!hashes.has(hash)) {
      hashes.add(hash);
      values.push(item);
    }
  }
  if (values.length > limits.maxEnumItems) {
    specInvalid(`enum has ${values.length} unique items, exceeding maxEnumItems ${limits.maxEnumItems} at ${where}`);
  }
  return { values, hashes };
}

function compilePattern(pattern: string, where: string): CompiledSafeRegexV1 {
  try {
    return compileSafeRegexV1(pattern);
  } catch (err) {
    if (err instanceof SafeRegexError) {
      specInvalid(`invalid pattern at ${where}: ${err.message}`);
    }
    throw err;
  }
}

function compileNode(raw: unknown, where: string, depth: number, ctx: CompileContext): CompiledSlotSchemaV1 {
  if (depth > ctx.limits.maxSchemaDepth) {
    specInvalid(`schema depth ${depth} exceeds maxSchemaDepth ${ctx.limits.maxSchemaDepth} at ${where}`);
  }
  if (!isSchemaNodeObject(raw)) {
    specInvalid(`schema node at ${where} must be a plain object with a single explicit type (boolean schemas are not part of dialect v1)`);
  }
  const obj = raw;

  ctx.nodeCount += 1;
  if (ctx.nodeCount > ctx.limits.maxSchemaNodes) {
    specInvalid(`schema node count ${ctx.nodeCount} exceeds maxSchemaNodes ${ctx.limits.maxSchemaNodes}`);
  }

  const type = obj['type'];
  if (!isSchemaType(type)) {
    specInvalid(`schema node at ${where} must declare a single valid type`);
  }

  const allowed = KEYWORDS_BY_TYPE[type];
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      specInvalid(`unknown keyword '${key}' for type '${type}' at ${where}`);
    }
  }

  const node: MutableNode = { type };

  if ('description' in obj) {
    node.description = mustBeString(obj['description'], 'description', where);
  }

  const hasEnum = 'enum' in obj;
  const hasConst = 'const' in obj;
  if (hasEnum && hasConst) specInvalid(`enum and const are mutually exclusive at ${where}`);
  if (hasEnum) {
    const enumCompiled = compileEnum(obj['enum'], type, where, ctx.limits);
    node.enum = enumCompiled.values;
    node._enumHashes = enumCompiled.hashes;
  }
  if (hasConst) {
    const constant = assertEnumScalar(obj['const'], type, where);
    node.const = constant;
    node._constHash = canonicalJsonSha256(constant);
  }

  switch (type) {
    case 'string': {
      if ('minLength' in obj) node.minLength = mustBeNonNegativeSafeInt(obj['minLength'], 'minLength', where);
      if ('maxLength' in obj) node.maxLength = mustBeNonNegativeSafeInt(obj['maxLength'], 'maxLength', where);
      if (node.minLength !== undefined && node.maxLength !== undefined && node.minLength > node.maxLength) {
        specInvalid(`minLength must not exceed maxLength at ${where}`);
      }
      if ('pattern' in obj) {
        const pattern = mustBeString(obj['pattern'], 'pattern', where);
        if (Array.from(pattern).length > ctx.limits.maxPatternLength) {
          specInvalid(`pattern length exceeds maxPatternLength ${ctx.limits.maxPatternLength} at ${where}`);
        }
        node.pattern = compilePattern(pattern, where);
      }
      break;
    }
    case 'number':
    case 'integer': {
      if ('minimum' in obj) node.minimum = mustBeFiniteNumber(obj['minimum'], 'minimum', where);
      if ('maximum' in obj) node.maximum = mustBeFiniteNumber(obj['maximum'], 'maximum', where);
      if ('exclusiveMinimum' in obj) node.exclusiveMinimum = mustBeFiniteNumber(obj['exclusiveMinimum'], 'exclusiveMinimum', where);
      if ('exclusiveMaximum' in obj) node.exclusiveMaximum = mustBeFiniteNumber(obj['exclusiveMaximum'], 'exclusiveMaximum', where);
      break;
    }
    case 'object': {
      if (!('additionalProperties' in obj)) {
        specInvalid(`object schema at ${where} must explicitly declare additionalProperties (false or a schema)`);
      }
      const ap = obj['additionalProperties'];
      if (ap === false) {
        node.additionalProperties = false;
      } else if (isSchemaNodeObject(ap)) {
        node.additionalProperties = compileNode(ap, `${where}/additionalProperties`, depth + 1, ctx);
      } else {
        specInvalid(`additionalProperties at ${where} must be false or a schema (unconstrained true is not part of dialect v1)`);
      }
      if ('properties' in obj) {
        const props = obj['properties'];
        if (!isSchemaNodeObject(props)) specInvalid(`properties must be an object at ${where}`);
        const compiledProps: Record<string, CompiledSlotSchemaV1> = {};
        for (const [name, child] of Object.entries(props)) {
          compiledProps[name] = compileNode(child, `${where}/properties/${name}`, depth + 1, ctx);
        }
        node.properties = Object.freeze(compiledProps);
      }
      if ('required' in obj) {
        const required = obj['required'];
        if (
          !Array.isArray(required) ||
          !required.every((name) => typeof name === 'string' && name.length > 0)
        ) {
          specInvalid(`required must be an array of non-empty strings at ${where}`);
        }
        node.required = Object.freeze([...required] as string[]);
      }
      if ('minProperties' in obj) node.minProperties = mustBeNonNegativeSafeInt(obj['minProperties'], 'minProperties', where);
      if ('maxProperties' in obj) node.maxProperties = mustBeNonNegativeSafeInt(obj['maxProperties'], 'maxProperties', where);
      if (node.minProperties !== undefined && node.maxProperties !== undefined && node.minProperties > node.maxProperties) {
        specInvalid(`minProperties must not exceed maxProperties at ${where}`);
      }
      break;
    }
    case 'array': {
      if (!('items' in obj)) {
        specInvalid(`array schema at ${where} must declare a single items schema`);
      }
      const items = obj['items'];
      if (!isSchemaNodeObject(items)) {
        specInvalid(`items at ${where} must be a single schema (tuple items are not part of dialect v1)`);
      }
      node.items = compileNode(items, `${where}/items`, depth + 1, ctx);
      if ('minItems' in obj) node.minItems = mustBeNonNegativeSafeInt(obj['minItems'], 'minItems', where);
      if ('maxItems' in obj) node.maxItems = mustBeNonNegativeSafeInt(obj['maxItems'], 'maxItems', where);
      if (node.minItems !== undefined && node.maxItems !== undefined && node.minItems > node.maxItems) {
        specInvalid(`minItems must not exceed maxItems at ${where}`);
      }
      if ('uniqueItems' in obj) node.uniqueItems = mustBeBoolean(obj['uniqueItems'], 'uniqueItems', where);
      break;
    }
    case 'boolean':
    case 'null':
      break;
  }

  return deepFreeze(node) as unknown as CompiledSlotSchemaV1;
}

/**
 * Compile a Slot Schema v1 tree. Counts schema depth (root = 1), total nodes,
 * per-enum items and pattern source length against `limits.schema`; any
 * violation or unknown keyword/field throws `SPEC_SCHEMA_INVALID`.
 */
export function compileSlotSchemaV1(raw: unknown, limits: StructuredSlotLimitsV1): CompiledSlotSchemaV1 {
  const ctx: CompileContext = { limits: limits.schema, nodeCount: 0 };
  return compileNode(raw, '', 1, ctx);
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

const VALID_VALIDATION_PHASES = new Set<IssuePhase>(['structure', 'draft', 'merge', 'seal_input']);

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function matchesType(type: SchemaType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
  }
}

/** RFC 6901 escaping for one JSON pointer segment. */
function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Canonical hash that never throws; unhashable values return undefined. */
function safeCanonicalHash(value: unknown): string | undefined {
  try {
    return canonicalJsonSha256(value);
  } catch {
    return undefined;
  }
}

type ValueIssueCode = 'SPEC_SCHEMA_INVALID' | 'CONTENT_SCHEMA_INVALID';

function pushIssue(
  code: ValueIssueCode,
  phase: IssuePhase,
  location: IssueLocation,
  details: JsonObject,
  issues: StructuredIssueV1[],
): void {
  issues.push(makeStructuredIssue(code, phase, location, details));
}

function validateNode(
  schema: CompiledSlotSchemaV1,
  value: unknown,
  schemaPointer: string,
  instancePointer: string,
  issues: StructuredIssueV1[],
  code: ValueIssueCode,
  phase: IssuePhase,
  location: IssueLocation,
): void {
  if (!matchesType(schema.type, value)) {
    pushIssue(code, phase, location, { schemaPointer, instancePointer, keyword: 'type', expected: schema.type }, issues);
    return;
  }

  if (schema._enumHashes) {
    const hash = safeCanonicalHash(value);
    if (hash === undefined || !schema._enumHashes.has(hash)) {
      pushIssue(code, phase, location, { schemaPointer, instancePointer, keyword: 'enum' }, issues);
    }
  }
  if (schema._constHash !== undefined) {
    const hash = safeCanonicalHash(value);
    if (hash === undefined || hash !== schema._constHash) {
      pushIssue(code, phase, location, { schemaPointer, instancePointer, keyword: 'const' }, issues);
    }
  }

  switch (schema.type) {
    case 'string': {
      const s = value as string;
      const length = Array.from(s).length; // Unicode code points (B02)
      if (schema.minLength !== undefined && length < schema.minLength) {
        pushIssue(code, phase, location, { schemaPointer, instancePointer, keyword: 'minLength' }, issues);
      }
      if (schema.maxLength !== undefined && length > schema.maxLength) {
        pushIssue(code, phase, location, { schemaPointer, instancePointer, keyword: 'maxLength' }, issues);
      }
      if (schema.pattern && !schema.pattern.test(s)) {
        pushIssue(code, phase, location, { schemaPointer, instancePointer, keyword: 'pattern' }, issues);
      }
      break;
    }
    case 'number':
    case 'integer': {
      const n = value as number;
      if (schema.minimum !== undefined && n < schema.minimum) {
        pushIssue(code, phase, location, { schemaPointer, instancePointer, keyword: 'minimum' }, issues);
      }
      if (schema.maximum !== undefined && n > schema.maximum) {
        pushIssue(code, phase, location, { schemaPointer, instancePointer, keyword: 'maximum' }, issues);
      }
      if (schema.exclusiveMinimum !== undefined && n <= schema.exclusiveMinimum) {
        pushIssue(code, phase, location, { schemaPointer, instancePointer, keyword: 'exclusiveMinimum' }, issues);
      }
      if (schema.exclusiveMaximum !== undefined && n >= schema.exclusiveMaximum) {
        pushIssue(code, phase, location, { schemaPointer, instancePointer, keyword: 'exclusiveMaximum' }, issues);
      }
      break;
    }
    case 'object': {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj);
      const declared = schema.properties ? new Set(Object.keys(schema.properties)) : new Set<string>();

      if (schema.properties) {
        for (const [name, childSchema] of Object.entries(schema.properties)) {
          if (Object.prototype.hasOwnProperty.call(obj, name)) {
            validateNode(
              childSchema,
              obj[name],
              `${schemaPointer}/properties/${name}`,
              `${instancePointer}/${escapePointer(name)}`,
              issues,
              code,
              phase,
              location,
            );
          }
        }
      }

      if (schema.required) {
        for (const name of schema.required) {
          if (!Object.prototype.hasOwnProperty.call(obj, name)) {
            pushIssue(
              code,
              phase,
              location,
              { schemaPointer, instancePointer: `${instancePointer}/${escapePointer(name)}`, keyword: 'required' },
              issues,
            );
          }
        }
      }

      if (schema.additionalProperties === false) {
        for (const key of keys) {
          if (!declared.has(key)) {
            pushIssue(
              code,
              phase,
              location,
              { schemaPointer, instancePointer: `${instancePointer}/${escapePointer(key)}`, keyword: 'additionalProperties' },
              issues,
            );
          }
        }
      } else if (schema.additionalProperties) {
        for (const key of keys) {
          if (!declared.has(key)) {
            validateNode(
              schema.additionalProperties,
              obj[key],
              `${schemaPointer}/additionalProperties`,
              `${instancePointer}/${escapePointer(key)}`,
              issues,
              code,
              phase,
              location,
            );
          }
        }
      }

      if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
        pushIssue(code, phase, location, { schemaPointer, instancePointer, keyword: 'minProperties' }, issues);
      }
      if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
        pushIssue(code, phase, location, { schemaPointer, instancePointer, keyword: 'maxProperties' }, issues);
      }
      break;
    }
    case 'array': {
      const arr = value as unknown[];
      // Compile guarantees `items` for array schemas; guard for TS narrowing.
      const items = schema.items;
      if (!items) throw new Error('INVALID_COMPILED_SCHEMA: array node without items');
      for (let i = 0; i < arr.length; i++) {
        validateNode(items, arr[i], `${schemaPointer}/items`, `${instancePointer}/${i}`, issues, code, phase, location);
      }
      if (schema.minItems !== undefined && arr.length < schema.minItems) {
        pushIssue(code, phase, location, { schemaPointer, instancePointer, keyword: 'minItems' }, issues);
      }
      if (schema.maxItems !== undefined && arr.length > schema.maxItems) {
        pushIssue(code, phase, location, { schemaPointer, instancePointer, keyword: 'maxItems' }, issues);
      }
      if (schema.uniqueItems) {
        // B05: type-sensitive canonical hashes — object key order does not
        // affect equality, array order does. Unhashable elements (non-finite
        // numbers and the like) are already rejected by the items schema.
        const seen = new Set<string>();
        for (let i = 0; i < arr.length; i++) {
          const hash = safeCanonicalHash(arr[i]);
          if (hash === undefined) continue;
          if (seen.has(hash)) {
            pushIssue(code, phase, location, { schemaPointer, instancePointer: `${instancePointer}/${i}`, keyword: 'uniqueItems' }, issues);
          } else {
            seen.add(hash);
          }
        }
      }
      break;
    }
    case 'boolean':
    case 'null':
      break;
  }
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareIssues(a: StructuredIssueV1, b: StructuredIssueV1): number {
  const read = (issue: StructuredIssueV1, key: string): string => {
    const value = (issue.details as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : '';
  };
  return (
    compareStrings(read(a, 'schemaPointer'), read(b, 'schemaPointer')) ||
    compareStrings(read(a, 'instancePointer'), read(b, 'instancePointer')) ||
    compareStrings(read(a, 'keyword'), read(b, 'keyword')) ||
    compareStrings(a.code, b.code)
  );
}

/**
 * Validate a JSON value against a compiled schema. Pure: reads the value and
 * never mutates it. Issues are constructed via `makeStructuredIssue` against
 * the closed registry and sorted by schema pointer, instance pointer, keyword,
 * then code.
 *
 * The phase selects the issue code per the registry's allowed phases:
 * `structure` → `SPEC_SCHEMA_INVALID`, `draft`/`merge`/`seal_input` →
 * `CONTENT_SCHEMA_INVALID`. Any other phase is rejected.
 */
export function validateSlotValue(
  compiled: CompiledSlotSchemaV1,
  value: unknown,
  location: IssueLocation,
  phase: IssuePhase,
): StructuredIssueV1[] {
  if (!VALID_VALIDATION_PHASES.has(phase)) {
    throw new Error(
      `INVALID_VALIDATION_PHASE: validateSlotValue supports structure|draft|merge|seal_input, got '${phase}'`,
    );
  }
  const code: ValueIssueCode = phase === 'structure' ? 'SPEC_SCHEMA_INVALID' : 'CONTENT_SCHEMA_INVALID';
  const issues: StructuredIssueV1[] = [];
  validateNode(compiled, value, '', '', issues, code, phase, location);
  issues.sort(compareIssues);
  return issues;
}
