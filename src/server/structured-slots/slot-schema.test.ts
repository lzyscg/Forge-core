// @vitest-environment node
/**
 * Slot Schema v1 compiler + pure validator tests (design §8.3, §25.2 B01-B05,
 * spec §4.2, spec §5 limits).
 *
 * The dialect is frozen: single explicit `type` per node, whitelisted keywords
 * only, object must explicitly declare `additionalProperties` (false or a
 * schema, never unconstrained true), array must declare a single `items`
 * schema. `enum`/`const` are mutually exclusive and type-sensitive. Schema
 * only validates — never fills defaults, converts, trims or mutates input.
 */
import { describe, expect, it } from 'vitest';
import type { IssueLocation, StructuredSlotLimitsV1 } from '../../shared/structured-slots';
import { compileSlotSchemaV1, validateSlotValue } from './slot-schema';

const limits: StructuredSlotLimitsV1 = {
  schema: { maxSchemaDepth: 10, maxSchemaNodes: 100, maxEnumItems: 20, maxPatternLength: 50 },
  structure: { maxSlots: 100, maxTreeDepth: 10, maxChildrenPerSlot: 10 },
  payload: { maxSpecBytesPerSlot: 10000, maxContentBytesPerSlot: 10000, maxScaffoldPayloadBytes: 10000 },
  draft: { maxChangedSlots: 100, maxDraftBytes: 10000 },
  attempt: {
    maxSlotToolCallsPerAttempt: 10,
    maxValidationRunsPerAttempt: 10,
    maxValidatorInvocationsPerAttempt: 10,
    maxAggregateValidatorCpuMsPerAttempt: 1000,
    maxAggregateValidatorWallClockMsPerAttempt: 1000,
    maxValidatorOutputBytesPerAttempt: 10000,
    maxAttemptWallClockMs: 10000,
  },
  validation: {
    maxValidators: 5,
    maxValidatorInvocationsPerGate: 5,
    maxAggregateValidatorCpuMsPerGate: 1000,
    maxAggregateValidatorWallClockMsPerGate: 1000,
    maxValidatorOutputBytesPerGate: 10000,
    maxIssuesPerRun: 100,
  },
  output: { maxArtifactFiles: 10, maxArtifactBytesPerFile: 10000, maxTotalArtifactBytes: 10000 },
};

const slotLoc = (slotId = 's1'): IssueLocation => ({
  kind: 'slot',
  slotId,
  field: 'content',
  valuePointer: '',
});

const compile = (raw: unknown): ReturnType<typeof compileSlotSchemaV1> =>
  compileSlotSchemaV1(raw, limits);

const validate = (raw: unknown, value: unknown, phase: 'structure' | 'draft' | 'merge' | 'seal_input' = 'merge') =>
  validateSlotValue(compile(raw), value, slotLoc(), phase);

/** Deep-freeze a test value so any mutation attempt throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

describe('compileSlotSchemaV1 — meta-schema rejection (SPEC_SCHEMA_INVALID)', () => {
  it.each(['multipleOf', 'oneOf', '$ref', 'default'])('rejects %s', (keyword) => {
    expect(() => compileSlotSchemaV1({ type: 'number', [keyword]: 1 }, limits))
      .toThrow('SPEC_SCHEMA_INVALID');
  });

  it('requires explicit object additionalProperties', () => {
    expect(() => compileSlotSchemaV1({ type: 'object', properties: {} }, limits))
      .toThrow('SPEC_SCHEMA_INVALID');
  });

  it('rejects boolean schemas and type unions', () => {
    expect(() => compile(true)).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile(false)).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({ type: ['string', 'number'] } as never)).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({})).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({ type: 'unknown' } as never)).toThrow('SPEC_SCHEMA_INVALID');
  });

  it.each(['$id', '$schema', '$defs', 'definitions', 'format', 'examples', 'not', 'allOf', 'anyOf', 'custom'])(
    'rejects unknown keyword %s',
    (keyword) => {
      expect(() => compile({ type: 'string', [keyword]: 1 })).toThrow('SPEC_SCHEMA_INVALID');
    },
  );

  it('rejects unconstrained additionalProperties: true', () => {
    expect(() => compile({ type: 'object', additionalProperties: true })).toThrow('SPEC_SCHEMA_INVALID');
  });

  it('rejects an array node without a single items schema', () => {
    expect(() => compile({ type: 'array' })).toThrow('SPEC_SCHEMA_INVALID');
    // Tuple items (array of schemas) are not part of dialect v1.
    expect(() => compile({ type: 'array', items: [{ type: 'string' }] } as never)).toThrow('SPEC_SCHEMA_INVALID');
  });

  it('rejects enum/const on object and array nodes (deferred in v1)', () => {
    expect(() => compile({ type: 'object', additionalProperties: false, enum: [{}] })).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({ type: 'array', items: { type: 'string' }, const: [] })).toThrow('SPEC_SCHEMA_INVALID');
  });

  it('rejects enum and const together', () => {
    expect(() => compile({ type: 'string', enum: ['a'], const: 'a' })).toThrow('SPEC_SCHEMA_INVALID');
  });

  it('rejects enum values that do not match the node type', () => {
    expect(() => compile({ type: 'number', enum: [1, '1'] })).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({ type: 'number', enum: [1, true] })).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({ type: 'string', enum: ['a', 1] })).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({ type: 'integer', enum: [1, 1.5] })).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({ type: 'null', const: 0 })).toThrow('SPEC_SCHEMA_INVALID');
  });

  it('rejects non-finite numeric bounds', () => {
    expect(() => compile({ type: 'number', minimum: Number.NaN })).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({ type: 'number', maximum: Number.POSITIVE_INFINITY })).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({ type: 'number', exclusiveMinimum: true } as never)).toThrow('SPEC_SCHEMA_INVALID');
  });

  it('rejects malformed count keywords (negative, fractional, min > max)', () => {
    expect(() => compile({ type: 'string', minLength: -1 })).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({ type: 'string', maxLength: 1.5 })).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({ type: 'string', minLength: 3, maxLength: 2 })).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({ type: 'array', items: { type: 'string' }, minItems: -2 })).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({ type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 1 })).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({ type: 'object', additionalProperties: false, minProperties: 2, maxProperties: 1 })).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({ type: 'array', items: { type: 'string' }, uniqueItems: 'yes' } as never)).toThrow('SPEC_SCHEMA_INVALID');
  });

  it('rejects an invalid pattern at load time', () => {
    expect(() => compile({ type: 'string', pattern: 'a(' })).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({ type: 'string', pattern: '(?i)abc' })).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compile({ type: 'string', pattern: 'abc(?=def)' })).toThrow('SPEC_SCHEMA_INVALID');
  });
});

describe('compileSlotSchemaV1 — limits (spec §5 schema group)', () => {
  it('rejects a schema deeper than maxSchemaDepth (root = depth 1)', () => {
    const deep = {
      type: 'object',
      additionalProperties: false,
      properties: {
        a: {
          type: 'object',
          additionalProperties: false,
          properties: { b: { type: 'string' } },
        },
      },
    };
    const tight: StructuredSlotLimitsV1 = { ...limits, schema: { ...limits.schema, maxSchemaDepth: 2 } };
    expect(() => compileSlotSchemaV1(deep, tight)).toThrow('SPEC_SCHEMA_INVALID');
    // Depth 2 is exactly at the limit and must compile.
    expect(() => compileSlotSchemaV1(deep, { ...limits, schema: { ...limits.schema, maxSchemaDepth: 3 } })).not.toThrow();
  });

  it('rejects a schema with more total nodes than maxSchemaNodes', () => {
    const many = {
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'object', additionalProperties: false, properties: { b: { type: 'string' } } } },
    };
    const tight: StructuredSlotLimitsV1 = { ...limits, schema: { ...limits.schema, maxSchemaNodes: 2 } };
    expect(() => compileSlotSchemaV1(many, tight)).toThrow('SPEC_SCHEMA_INVALID');
    expect(() => compileSlotSchemaV1(many, { ...limits, schema: { ...limits.schema, maxSchemaNodes: 4 } })).not.toThrow();
  });

  it('rejects an enum with more items than maxEnumItems after dedup', () => {
    const tight: StructuredSlotLimitsV1 = { ...limits, schema: { ...limits.schema, maxEnumItems: 2 } };
    expect(() => compileSlotSchemaV1({ type: 'string', enum: ['a', 'b', 'c'] }, tight)).toThrow('SPEC_SCHEMA_INVALID');
    // Duplicates collapse before the count, so 3 entries dedup to 2 and fit.
    expect(() => compileSlotSchemaV1({ type: 'string', enum: ['a', 'a', 'b'] }, tight)).not.toThrow();
  });

  it('rejects a pattern longer than maxPatternLength (Unicode code points)', () => {
    const tight: StructuredSlotLimitsV1 = { ...limits, schema: { ...limits.schema, maxPatternLength: 3 } };
    expect(() => compileSlotSchemaV1({ type: 'string', pattern: 'ab' }, tight)).not.toThrow();
    expect(() => compileSlotSchemaV1({ type: 'string', pattern: 'abcd' }, tight)).toThrow('SPEC_SCHEMA_INVALID');
    // '😀' is one code point (two UTF-16 units); counting code points fits.
    expect(() => compileSlotSchemaV1({ type: 'string', pattern: '😀b' }, tight)).not.toThrow();
  });
});

describe('validateSlotValue — string lengths count Unicode code points (B02)', () => {
  it('minLength/maxLength count code points, not UTF-16 units', () => {
    const schema = compile({ type: 'string', minLength: 2, maxLength: 2 });
    // '😀' is ONE code point but TWO UTF-16 code units — it must fail minLength.
    expect(validateSlotValue(schema, '😀', slotLoc(), 'merge')).toHaveLength(1);
    // '😀x' is two code points — passes a [2,2] window.
    expect(validateSlotValue(schema, '😀x', slotLoc(), 'merge')).toHaveLength(0);
    // 'ab' is two code points — passes.
    expect(validateSlotValue(schema, 'ab', slotLoc(), 'merge')).toHaveLength(0);
  });

  it('reports minLength and maxLength violations with pointers', () => {
    const issues = validate({ type: 'string', minLength: 3 }, 'ab');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('CONTENT_SCHEMA_INVALID');
    expect(issues[0].details).toEqual({ schemaPointer: '', instancePointer: '', keyword: 'minLength' });

    const tooLong = validate({ type: 'string', maxLength: 3 }, 'abcd');
    expect(tooLong.map((i) => i.details.keyword)).toEqual(['maxLength']);
  });
});

describe('validateSlotValue — numbers (B01)', () => {
  it('requires finite numbers for the number type', () => {
    expect(validate({ type: 'number' }, 1.5)).toHaveLength(0);
    expect(validate({ type: 'number' }, '1')).toHaveLength(1);
    expect(validate({ type: 'number' }, Number.NaN)).toHaveLength(1);
    expect(validate({ type: 'number' }, Number.POSITIVE_INFINITY)).toHaveLength(1);
  });

  it('requires safe integers for the integer type', () => {
    expect(validate({ type: 'integer' }, 42)).toHaveLength(0);
    expect(validate({ type: 'integer' }, Number.MAX_SAFE_INTEGER)).toHaveLength(0);
    expect(validate({ type: 'integer' }, 1.5)).toHaveLength(1);
    // 2^53 is not a safe integer; larger exact integers are modeled as strings.
    expect(validate({ type: 'integer' }, 2 ** 53)).toHaveLength(1);
  });

  it('enforces minimum/maximum/exclusive bounds', () => {
    const schema = compile({
      type: 'number',
      minimum: 1,
      maximum: 10,
      exclusiveMinimum: 1,
      exclusiveMaximum: 10,
    });
    expect(validateSlotValue(schema, 5, slotLoc(), 'merge')).toHaveLength(0);
    expect(validateSlotValue(schema, 1, slotLoc(), 'merge').map((i) => i.details.keyword)).toEqual(['exclusiveMinimum']);
    expect(validateSlotValue(schema, 10, slotLoc(), 'merge').map((i) => i.details.keyword)).toEqual(['exclusiveMaximum']);
    expect(validateSlotValue(schema, 0, slotLoc(), 'merge').map((i) => i.details.keyword)).toEqual(['exclusiveMinimum', 'minimum']);
    expect(validateSlotValue(schema, 11, slotLoc(), 'merge').map((i) => i.details.keyword)).toEqual(['exclusiveMaximum', 'maximum']);
  });

  it('reports a type mismatch with expected type in details', () => {
    const [issue] = validate({ type: 'string' }, 42);
    expect(issue.details).toEqual({
      schemaPointer: '',
      instancePointer: '',
      keyword: 'type',
      expected: 'string',
    });
  });
});

describe('validateSlotValue — object property closure (8.3)', () => {
  const closed = (extra = {} as Record<string, unknown>) => ({
    type: 'object',
    additionalProperties: false,
    properties: { a: { type: 'string' }, b: { type: 'integer' } },
    required: ['a'],
    ...extra,
  });

  it('accepts exactly the declared properties when additionalProperties is false', () => {
    expect(validate(closed(), { a: 'x', b: 1 })).toHaveLength(0);
  });

  it('rejects undeclared properties when additionalProperties is false', () => {
    const issues = validate(closed(), { a: 'x', c: 1 });
    expect(issues).toHaveLength(1);
    expect(issues[0].details.keyword).toBe('additionalProperties');
    expect(issues[0].details.instancePointer).toBe('/c');
  });

  it('validates nested property schemas and required closure', () => {
    const issues = validate(closed(), { b: 'not-an-integer' });
    const keywords = issues.map((i) => i.details.keyword).sort();
    // 'b' fails integer type; 'a' is missing (required).
    expect(keywords).toEqual(['required', 'type']);
    expect(issues.find((i) => i.details.keyword === 'required')!.details.instancePointer).toBe('/a');
  });

  it('validates undeclared properties against an additionalProperties schema', () => {
    const open = {
      type: 'object',
      additionalProperties: { type: 'number' },
      properties: { a: { type: 'string' } },
    };
    expect(validate(open, { a: 'x', b: 1, c: 2 })).toHaveLength(0);
    const issues = validate(open, { b: 'nope' });
    expect(issues).toHaveLength(1);
    expect(issues[0].details.keyword).toBe('type');
    expect(issues[0].details.schemaPointer).toBe('/additionalProperties');
    expect(issues[0].details.instancePointer).toBe('/b');
  });

  it('enforces minProperties/maxProperties', () => {
    const schema = compile({
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'number' }, b: { type: 'number' }, c: { type: 'number' } },
      minProperties: 2,
      maxProperties: 2,
    });
    expect(validateSlotValue(schema, { a: 1, b: 2 }, slotLoc(), 'merge')).toHaveLength(0);
    expect(validateSlotValue(schema, { a: 1 }, slotLoc(), 'merge').map((i) => i.details.keyword)).toEqual(['minProperties']);
    expect(validateSlotValue(schema, { a: 1, b: 2, c: 3 }, slotLoc(), 'merge').map((i) => i.details.keyword)).toEqual(['maxProperties']);
  });
});

describe('validateSlotValue — array uniqueItems by canonical hash (B05)', () => {
  it('detects duplicate primitives', () => {
    const schema = compile({ type: 'array', items: { type: 'number' }, uniqueItems: true });
    expect(validateSlotValue(schema, [1, 2], slotLoc(), 'merge')).toHaveLength(0);
    const dup = validateSlotValue(schema, [1, 2, 1], slotLoc(), 'merge');
    expect(dup).toHaveLength(1);
    expect(dup[0].details.keyword).toBe('uniqueItems');
    expect(dup[0].details.instancePointer).toBe('/2');
  });

  it('treats object key order as irrelevant for equality', () => {
    const schema = compile({
      type: 'array',
      items: { type: 'object', additionalProperties: false, properties: { a: { type: 'number' }, b: { type: 'number' } } },
      uniqueItems: true,
    });
    // Same canonical object with different key order is a duplicate.
    expect(validateSlotValue(schema, [{ a: 1, b: 2 }, { b: 2, a: 1 }], slotLoc(), 'merge')).toHaveLength(1);
    expect(validateSlotValue(schema, [{ a: 1, b: 2 }, { a: 1, b: 3 }], slotLoc(), 'merge')).toHaveLength(0);
  });

  it('treats array order as significant for equality', () => {
    const schema = compile({
      type: 'array',
      items: { type: 'array', items: { type: 'number' } },
      uniqueItems: true,
    });
    // [1,2] and [2,1] are different canonical values.
    expect(validateSlotValue(schema, [[1, 2], [2, 1]], slotLoc(), 'merge')).toHaveLength(0);
    expect(validateSlotValue(schema, [[1, 2], [1, 2]], slotLoc(), 'merge')).toHaveLength(1);
  });

  it('normalizes numbers via the canonical value for equality', () => {
    const schema = compile({ type: 'array', items: { type: 'number' }, uniqueItems: true });
    // 1 and 1.0 are the same canonical value -> duplicate at index 1.
    const dup = validateSlotValue(schema, [1, 1.0, 2], slotLoc(), 'merge');
    expect(dup).toHaveLength(1);
    expect(dup[0].details.keyword).toBe('uniqueItems');
    expect(dup[0].details.instancePointer).toBe('/1');
    // Distinct values stay unique.
    expect(validateSlotValue(schema, [1, 2, 3], slotLoc(), 'merge')).toHaveLength(0);
  });

  it('enforces minItems/maxItems and per-item validation', () => {
    const schema = compile({ type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 });
    expect(validateSlotValue(schema, ['a'], slotLoc(), 'merge')).toHaveLength(0);
    expect(validateSlotValue(schema, [], slotLoc(), 'merge').map((i) => i.details.keyword)).toEqual(['minItems']);
    expect(validateSlotValue(schema, ['a', 'b', 'c'], slotLoc(), 'merge').map((i) => i.details.keyword)).toEqual(['maxItems']);
    const [issue] = validateSlotValue(schema, ['a', 1], slotLoc(), 'merge');
    expect(issue.details).toEqual({ schemaPointer: '/items', instancePointer: '/1', keyword: 'type', expected: 'string' });
  });
});

describe('validateSlotValue — enum and const (B04)', () => {
  it('dedups enum items by type-sensitive canonical value at compile', () => {
    const schema = compile({ type: 'string', enum: ['a', 'b', 'a'] });
    expect(schema.enum).toEqual(['a', 'b']);
    const num = compile({ type: 'number', enum: [1, 1.0, 2] });
    expect(num.enum).toEqual([1, 2]);
  });

  it('validates enum membership', () => {
    const schema = compile({ type: 'string', enum: ['a', 'b'] });
    expect(validateSlotValue(schema, 'a', slotLoc(), 'merge')).toHaveLength(0);
    const issues = validateSlotValue(schema, 'c', slotLoc(), 'merge');
    expect(issues).toHaveLength(1);
    expect(issues[0].details.keyword).toBe('enum');
  });

  it('validates const by type-sensitive equality', () => {
    const schema = compile({ type: 'string', const: 'x' });
    expect(validateSlotValue(schema, 'x', slotLoc(), 'merge')).toHaveLength(0);
    expect(validateSlotValue(schema, 'y', slotLoc(), 'merge').map((i) => i.details.keyword)).toEqual(['const']);
    // Type-sensitive: the number 1 is not the string const '1' (already type-fails).
    expect(validateSlotValue(schema, 1, slotLoc(), 'merge').map((i) => i.details.keyword)).toEqual(['type']);
  });

  it('keeps enum membership type-bound', () => {
    const boolEnum = compile({ type: 'boolean', enum: [true] });
    expect(validateSlotValue(boolEnum, true, slotLoc(), 'merge')).toHaveLength(0);
    expect(validateSlotValue(boolEnum, 1, slotLoc(), 'merge').map((i) => i.details.keyword)).toEqual(['type']);

    const nullEnum = compile({ type: 'null', enum: [null] });
    expect(validateSlotValue(nullEnum, null, slotLoc(), 'merge')).toHaveLength(0);
    expect(validateSlotValue(nullEnum, 0, slotLoc(), 'merge').map((i) => i.details.keyword)).toEqual(['type']);
  });
});

describe('validateSlotValue — pattern at runtime', () => {
  it('applies substring pattern semantics', () => {
    const schema = compile({ type: 'string', pattern: '^ab\\d+$' });
    expect(validateSlotValue(schema, 'ab42', slotLoc(), 'merge')).toHaveLength(0);
    expect(validateSlotValue(schema, 'xab42', slotLoc(), 'merge').map((i) => i.details.keyword)).toEqual(['pattern']);
  });

  it('matches Unicode patterns', () => {
    const schema = compile({ type: 'string', pattern: '\\p{L}+' });
    expect(validateSlotValue(schema, 'héllo', slotLoc(), 'merge')).toHaveLength(0);
  });
});

describe('validateSlotValue — purity (never mutates input)', () => {
  it('does not mutate a deeply frozen value', () => {
    const schema = compile({
      type: 'object',
      additionalProperties: { type: 'object', additionalProperties: false, properties: { x: { type: 'number' } } },
    });
    const value = { a: { x: 1 }, b: { y: 'nope' } };
    const frozen = deepFreeze(value);
    const issues = validateSlotValue(schema, frozen, slotLoc(), 'merge');
    expect(issues.length).toBeGreaterThan(0);
    // Reading back the deeply frozen value must succeed (no mutation attempted).
    expect(frozen.a.x).toBe(1);
  });

  it('does not mutate the raw schema during compile', () => {
    const raw = {
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'string', enum: ['x'] } },
    };
    const frozen = deepFreeze(raw);
    const schema = compileSlotSchemaV1(frozen, limits);
    expect(schema.type).toBe('object');
    // Deeply frozen input is still intact.
    expect(frozen.properties.a.enum).toEqual(['x']);
  });
});

describe('validateSlotValue — phase mapping and issue ordering', () => {
  it('maps structure phase to SPEC_SCHEMA_INVALID and content phases to CONTENT_SCHEMA_INVALID', () => {
    const structureIssues = validateSlotValue(compile({ type: 'string' }), 1, slotLoc(), 'structure');
    expect(structureIssues[0].code).toBe('SPEC_SCHEMA_INVALID');
    expect(structureIssues[0].phase).toBe('structure');

    for (const phase of ['draft', 'merge', 'seal_input'] as const) {
      const issues = validateSlotValue(compile({ type: 'string' }), 1, slotLoc(), phase);
      expect(issues[0].code).toBe('CONTENT_SCHEMA_INVALID');
      expect(issues[0].phase).toBe(phase);
    }
  });

  it('throws on a phase the validator cannot express', () => {
    expect(() => validateSlotValue(compile({ type: 'string' }), 'x', slotLoc(), 'template_load')).toThrow();
  });

  it('sorts issues by schema pointer, instance pointer, keyword, then code', () => {
    const schema = compile({
      type: 'object',
      additionalProperties: false,
      properties: {
        a: { type: 'array', items: { type: 'integer' } },
        b: { type: 'string', pattern: '^x$', minLength: 2 },
        c: { type: 'string' },
      },
    });
    const issues = validateSlotValue(
      schema,
      { a: [1, 'x', 2, 'y'], b: 'q', c: 7 },
      slotLoc(),
      'merge',
    );
    const order = issues.map((i) => `${i.details.schemaPointer}|${i.details.instancePointer}|${i.details.keyword}`).join(',');
    // All issues share code CONTENT_SCHEMA_INVALID. Sort keys in play:
    //  schema pointer: /properties/a before /properties/b before /properties/c;
    //  instance pointer: /a/1 before /a/3 under the same schema pointer;
    //  keyword: minLength before pattern at the same schema+instance pointer.
    expect(order).toBe(
      '/properties/a/items|/a/1|type,' +
        '/properties/a/items|/a/3|type,' +
        '/properties/b|/b|minLength,' +
        '/properties/b|/b|pattern,' +
        '/properties/c|/c|type',
    );
  });

  it('reports additionalProperties failures for the root with a full pointer chain', () => {
    const schema = compile({
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'number' } },
    });
    const issues = validateSlotValue(schema, { a: 1, extra: { deep: 2 } }, slotLoc(), 'merge');
    expect(issues.map((i) => i.details.keyword)).toEqual(['additionalProperties']);
    expect(issues[0].details.instancePointer).toBe('/extra');
  });
});
