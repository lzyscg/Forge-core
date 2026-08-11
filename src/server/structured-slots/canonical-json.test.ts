/**
 * forge-canonical-json/v1 vectors (RFC 8785 JCS core; design §25.2 C02).
 * The protocol is pinned by cross-implementation test vectors, so these tests
 * are golden: they must never be "fixed" to match a lenient implementation.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  canonicalJson,
  canonicalJsonBytes,
  canonicalJsonSha256,
} from './canonical-json';

describe('canonicalJson — JCS core', () => {
  it('sorts object keys by JCS UTF-16 order and normalizes negative zero', () => {
    expect(canonicalJson({ z: -0, a: 'é' })).toBe('{"a":"é","z":0}');
  });

  it('rejects lone surrogates and non-finite numbers', () => {
    expect(() => canonicalJson('\ud800')).toThrow('CANONICAL_JSON_INVALID');
    expect(() => canonicalJson('\udfff')).toThrow('CANONICAL_JSON_INVALID');
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow('CANONICAL_JSON_INVALID');
    expect(() => canonicalJson(Number.NEGATIVE_INFINITY)).toThrow('CANONICAL_JSON_INVALID');
    expect(() => canonicalJson(Number.NaN)).toThrow('CANONICAL_JSON_INVALID');
  });

  it('sorts keys by UTF-16 code unit order, never locale or code point', () => {
    expect(canonicalJson({ 'ä': 1, z: 2 })).toBe('{"z":2,"ä":1}');
    expect(canonicalJson({ b: 1, A: 2, a: 3 })).toBe('{"A":2,"a":3,"b":1}');
  });

  it('escapes quotes, backslashes and control characters with lowercase hex', () => {
    expect(canonicalJson({ s: 'a"b\\c' })).toBe('{"s":"a\\"b\\\\c"}');
    expect(canonicalJson('line1\nline2')).toBe('"line1\\nline2"');
    expect(canonicalJson('\u0000')).toBe('"\\u0000"');
    expect(canonicalJson('\u0001\u001f')).toBe('"\\u0001\\u001f"');
  });

  it('keeps non-ASCII and surrogate pairs raw (no unnecessary \\u escaping)', () => {
    expect(canonicalJson('é')).toBe('"é"');
    expect(canonicalJson('😀')).toBe('"😀"');
  });

  it('serializes numbers in the shortest round-trip form', () => {
    expect(canonicalJson(1.0)).toBe('1');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(0.1)).toBe('0.1');
    expect(canonicalJson(1e21)).toBe('1e+21');
    expect(canonicalJson(1e-7)).toBe('1e-7');
    expect(canonicalJson(100000000000000000000)).toBe('100000000000000000000');
    // Large decimals serialize in the shortest round-trip form, not the literal.
    expect(canonicalJson(123456789012345678901234567890)).toBe('1.2345678901234568e+29');
  });

  it('matches JSON.stringify number output for finite numbers', () => {
    const samples = [
      0,
      1,
      -1,
      1.5,
      1e-7,
      1e21,
      123.456,
      0.30000000000000004,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_VALUE,
      42.42,
    ];
    for (const n of samples) {
      expect(canonicalJson(n)).toBe(JSON.stringify(n));
    }
  });

  it('rejects undefined at the root, in objects, and in arrays', () => {
    expect(() => canonicalJson(undefined)).toThrow('CANONICAL_JSON_INVALID');
    expect(() => canonicalJson({ a: undefined })).toThrow('CANONICAL_JSON_INVALID');
    expect(() => canonicalJson([1, undefined])).toThrow('CANONICAL_JSON_INVALID');
  });

  it('rejects bigint, functions and symbols', () => {
    expect(() => canonicalJson(1n)).toThrow('CANONICAL_JSON_INVALID');
    expect(() => canonicalJson({ a: () => 1 })).toThrow('CANONICAL_JSON_INVALID');
    expect(() => canonicalJson(Symbol('x'))).toThrow('CANONICAL_JSON_INVALID');
  });

  it('rejects cycles in objects and arrays', () => {
    const o: { a: number; self?: unknown } = { a: 1 };
    o.self = o;
    expect(() => canonicalJson(o)).toThrow('CANONICAL_JSON_INVALID');

    const arr: unknown[] = [1];
    arr.push(arr);
    expect(() => canonicalJson(arr)).toThrow('CANONICAL_JSON_INVALID');
  });

  it('allows shared (non-cyclic) references', () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it('rejects non-plain objects with prototypes', () => {
    expect(() => canonicalJson(new Date(0))).toThrow('CANONICAL_JSON_INVALID');
    expect(() => canonicalJson(new Map())).toThrow('CANONICAL_JSON_INVALID');
    expect(() => canonicalJson(new RegExp('a'))).toThrow('CANONICAL_JSON_INVALID');
    class Foo {
      x = 1;
    }
    expect(() => canonicalJson(new Foo())).toThrow('CANONICAL_JSON_INVALID');
  });

  it('accepts null-prototype objects', () => {
    expect(canonicalJson(Object.assign(Object.create(null), { a: 1 }))).toBe('{"a":1}');
  });

  it('serializes scalars and nested structures deterministically', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson('text')).toBe('"text"');
    expect(canonicalJson([1, 'a', null, false])).toBe('[1,"a",null,false]');
    expect(canonicalJson({ a: { b: [1, { c: 2 }] } })).toBe('{"a":{"b":[1,{"c":2}]}}');
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  it('escapes every C0 control char with its minimal form / lowercase hex (Task B fast-path lock)', () => {
    const control = Array.from({ length: 32 }, (_, i) => i);
    const expected = control
      .map((code) => {
        switch (code) {
          case 0x08:
            return '\\b';
          case 0x09:
            return '\\t';
          case 0x0a:
            return '\\n';
          case 0x0c:
            return '\\f';
          case 0x0d:
            return '\\r';
          default:
            return `\\u${code.toString(16).padStart(4, '0')}`;
        }
      })
      .join('');
    expect(canonicalJson(String.fromCharCode(...control))).toBe(`"${expected}"`);
  });

  it('leaves U+2028, U+2029 and DEL (U+007F) raw — JCS never escapes them', () => {
    expect(canonicalJson(' ')).toBe('" "');
    expect(canonicalJson(' ')).toBe('" "');
    expect(canonicalJson('')).toBe('""');
  });

  it('rejects a lone surrogate anywhere — high or low, start/middle/end, object/array', () => {
    expect(() => canonicalJson('\ud800x')).toThrow('CANONICAL_JSON_INVALID');
    expect(() => canonicalJson('x\udfff')).toThrow('CANONICAL_JSON_INVALID');
    expect(() => canonicalJson('\ud800\ud800')).toThrow('CANONICAL_JSON_INVALID');
    expect(() => canonicalJson('\udc00\udc00')).toThrow('CANONICAL_JSON_INVALID');
    expect(() => canonicalJson({ a: '\ud800' })).toThrow('CANONICAL_JSON_INVALID');
    expect(() => canonicalJson(['\udc00'])).toThrow('CANONICAL_JSON_INVALID');
  });

  it('accepts a valid surrogate pair and emits it raw', () => {
    expect(canonicalJson('😀')).toBe('"😀"');
    expect(canonicalJson('a😀b')).toBe('"a😀b"');
  });

  it('serializes extreme and negative-exponent numbers in shortest round-trip form', () => {
    expect(canonicalJson(5e-324)).toBe('5e-324');
    expect(canonicalJson(-1e-7)).toBe('-1e-7');
    expect(canonicalJson(1e-21)).toBe('1e-21');
    expect(canonicalJson(-0)).toBe('0');
  });

  it('sorts keys by UTF-16 code unit order for non-ASCII and astral keys', () => {
    expect(canonicalJson({ 'é': 1, z: 2 })).toBe('{"z":2,"é":1}');
    expect(canonicalJson({ '😀': 1, z: 2 })).toBe('{"z":2,"😀":1}');
    expect(canonicalJson({ '😀': 1, '😁': 2 })).toBe('{"😀":1,"😁":2}');
  });

  it('a long plain string (no escaping) round-trips byte-identically and hashes deterministically', () => {
    const long = 'x'.repeat(100_000);
    expect(canonicalJson(long)).toBe(`"${long}"`);
    expect(canonicalJsonBytes(long).toString('utf8')).toBe(canonicalJson(long));
    expect(canonicalJsonSha256(long)).toBe(canonicalJsonSha256(long));
    expect(canonicalJsonSha256(long)).toBe(createHash('sha256').update(canonicalJsonBytes(long)).digest('hex'));
  });
});

describe('canonicalJsonBytes / canonicalJsonSha256', () => {
  it('returns the UTF-8 bytes of the canonical string', () => {
    const bytes = canonicalJsonBytes({ a: 'é' });
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString('utf8')).toBe(canonicalJson({ a: 'é' }));
    // {"a":"é"} — é encodes as UTF-8 C3 A9.
    expect([...bytes]).toEqual([
      0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0xa9, 0x22, 0x7d,
    ]);
  });

  it('returns a lowercase hex sha256 digest of the bytes', () => {
    const hex = canonicalJsonSha256({ a: 1 });
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex).toBe(createHash('sha256').update(canonicalJsonBytes({ a: 1 })).digest('hex'));
  });

  it('produces a stable golden digest', () => {
    expect(canonicalJsonSha256('')).toBe('12ae32cb1ec02d01eda3581b127c1fee3b0dc53572ed6baf239721a03d82e126');
    expect(canonicalJsonSha256({ a: 1 })).toBe('015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
  });

  it('bytes and sha256 agree with the canonical string for nested/long values', () => {
    const value = { nested: { list: [1, 'a', 5e-324], 'é': '😀' }, z: -0 };
    const canonical = canonicalJson(value);
    const bytes = canonicalJsonBytes(value);
    expect(bytes.toString('utf8')).toBe(canonical);
    expect(canonicalJsonSha256(value)).toBe(createHash('sha256').update(bytes).digest('hex'));
    // A long plain string keeps the same agreement (Task B fast-path precondition).
    const long = 'x'.repeat(100_000);
    expect(canonicalJsonBytes(long).toString('utf8')).toBe(canonicalJson(long));
    expect(canonicalJsonSha256(long)).toBe(createHash('sha256').update(canonicalJsonBytes(long)).digest('hex'));
  });
});
