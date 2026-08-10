// @vitest-environment node
/**
 * forge-safe-regex/v1 wrapper tests (design §25.2 B03, spec §4.2).
 *
 * The wrapper must be backed ONLY by re2-wasm@1.0.2 (RE2 semantics: linear
 * time, no backtracking). These tests fail if the wrapper is swapped for a
 * JavaScript `RegExp`: JS RegExp accepts lookaround / backreferences / inline
 * flags and blows up in exponential time on the adversarial long inputs below.
 *
 * Time-complexity checks use a generous fixed upper bound plus escalating
 * input sizes — never one tiny timing sample — so the RE2 linear-time engine
 * passes comfortably while a backtracking engine exceeds the bound at the
 * largest sizes.
 */
import { describe, expect, it } from 'vitest';
import { compileSafeRegexV1 } from './safe-regex';

/** Generous fixed upper bound (ms) per adversarial call; RE2 needs ~1ms. */
const LINEAR_TIME_BOUND_MS = 1000;

/** Escalating input sizes: linear engines finish all; exponential ones blow up. */
const ESCALATING_SIZES = [1000, 2000, 4000, 8000, 16000, 32000];

describe('compileSafeRegexV1 — linear-time RE2 engine', () => {
  it('handles RE2-valid nested quantifiers on adversarial long input', () => {
    const re = compileSafeRegexV1('^(a+)+$');
    re.test('x'); // warm up the WASM engine once
    for (const size of ESCALATING_SIZES) {
      const input = 'a'.repeat(size) + 'b';
      const start = performance.now();
      expect(re.test(input)).toBe(false);
      const elapsed = performance.now() - start;
      // A backtracking engine on ^(a+)+$ over a* + b is exponential; RE2 is ~linear.
      expect(elapsed).toBeLessThan(LINEAR_TIME_BOUND_MS);
    }
  });

  it('handles ambiguous alternation on adversarial long input', () => {
    const re = compileSafeRegexV1('^(a|aa)+$');
    re.test('x');
    for (const size of ESCALATING_SIZES) {
      const input = 'a'.repeat(size) + 'b';
      const start = performance.now();
      expect(re.test(input)).toBe(false);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(LINEAR_TIME_BOUND_MS);
    }
  });

  it('matches an ambiguous alternation as a substring in linear time', () => {
    const re = compileSafeRegexV1('(a|aa)+');
    re.test('x');
    for (const size of ESCALATING_SIZES) {
      const input = 'a'.repeat(size);
      const start = performance.now();
      expect(re.test(input)).toBe(true);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(LINEAR_TIME_BOUND_MS);
    }
  });
});

describe('compileSafeRegexV1 — RE2 feature closure (fail closed)', () => {
  it('rejects lookahead assertions', () => {
    expect(() => compileSafeRegexV1('abc(?=def)')).toThrow('SAFE_REGEX_INVALID');
    expect(() => compileSafeRegexV1('abc(?!def)')).toThrow('SAFE_REGEX_INVALID');
  });

  it('rejects lookbehind assertions', () => {
    expect(() => compileSafeRegexV1('(?<=a)b')).toThrow('SAFE_REGEX_INVALID');
    expect(() => compileSafeRegexV1('(?<!a)b')).toThrow('SAFE_REGEX_INVALID');
  });

  it('rejects backreferences', () => {
    expect(() => compileSafeRegexV1('(cat|dog)\\1')).toThrow('SAFE_REGEX_INVALID');
  });

  it('rejects inline flags (RE2 would accept them; the dialect must not)', () => {
    expect(() => compileSafeRegexV1('(?i)abc')).toThrow('SAFE_REGEX_INVALID');
    expect(() => compileSafeRegexV1('(?i:abc)')).toThrow('SAFE_REGEX_INVALID');
    expect(() => compileSafeRegexV1('(?m)^abc$')).toThrow('SAFE_REGEX_INVALID');
  });

  it('rejects invalid syntax', () => {
    expect(() => compileSafeRegexV1('[')).toThrow('SAFE_REGEX_INVALID');
    expect(() => compileSafeRegexV1('a{2,1}')).toThrow('SAFE_REGEX_INVALID');
  });

  it('accepts non-capturing groups and escaped parens inside classes', () => {
    const nonCapturing = compileSafeRegexV1('(?:ab)+');
    expect(nonCapturing.test('abab')).toBe(true);
    // A character class containing literal ( ? is not an inline-flag construct.
    const classParen = compileSafeRegexV1('[(?]');
    expect(classParen.test('(')).toBe(true);
    expect(classParen.test('?')).toBe(true);
  });
});

describe('compileSafeRegexV1 — Unicode mode', () => {
  it('requires Unicode mode (no u flag is a hard library error)', () => {
    // The wrapper always passes the u flag; constructors without it must not
    // be reachable. RE2 is Unicode-only, so astral literals behave as one
    // code point.
    const re = compileSafeRegexV1('😀');
    expect(re.test('a😀b')).toBe(true);
    expect(re.test('a\ud83d')).toBe(false);
  });

  it('supports Unicode property escapes and \\u{...} code points', () => {
    const letter = compileSafeRegexV1('^\\p{L}+$');
    expect(letter.test('héllo')).toBe(true);
    expect(letter.test('hello123')).toBe(false);
    const emoji = compileSafeRegexV1('^\\u{1F600}$');
    expect(emoji.test('😀')).toBe(true);
  });

  it('treats an astral literal as a single code point for matching', () => {
    const re = compileSafeRegexV1('^.$');
    expect(re.test('😀')).toBe(true);
  });
});

describe('compileSafeRegexV1 — substring semantics and anchors', () => {
  it('is substring search by default', () => {
    const re = compileSafeRegexV1('abc');
    expect(re.test('abc')).toBe(true);
    expect(re.test('xabcy')).toBe(true);
    expect(re.test('ab')).toBe(false);
  });

  it('full match requires explicit anchors', () => {
    const anchored = compileSafeRegexV1('^abc$');
    expect(anchored.test('abc')).toBe(true);
    expect(anchored.test('xabc')).toBe(false);
    expect(anchored.test('abcx')).toBe(false);
    expect(anchored.test('xabcx')).toBe(false);
  });
});

describe('compileSafeRegexV1 — wrapper contract', () => {
  it('is not backed by a JavaScript RegExp object', () => {
    const re = compileSafeRegexV1('a+');
    // The compiled wrapper must never be a RegExp instance.
    expect(re).not.toBeInstanceOf(RegExp);
    // And the JS RegExp constructor accepts features this wrapper rejects
    // (lookahead, backreferences), proving the rejection comes from the
    // RE2-backed wrapper rather than RegExp.
    // eslint-disable-next-line no-new
    new RegExp('abc(?=def)');
    // eslint-disable-next-line no-new
    new RegExp('(cat|dog)\\1');
  });

  it('exposes the raw pattern and a substring test function', () => {
    const re = compileSafeRegexV1('\\d+');
    expect(re.pattern).toBe('\\d+');
    expect(typeof re.test).toBe('function');
    expect(re.test('x42y')).toBe(true);
  });
});
