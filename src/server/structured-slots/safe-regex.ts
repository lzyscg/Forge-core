/**
 * forge-safe-regex/v1 — linear-time safe regular expression compiler
 * (design §25.2 B03, spec §4.2).
 *
 * Backed ONLY by re2-wasm@1.0.2, the plan-locked exact dependency. Every
 * pattern is compiled from the raw string with mandatory Unicode mode (`u`);
 * the wrapper never round-trips through a JavaScript `RegExp` object and never
 * falls back to a syntax blacklist. RE2 rejects backreferences, lookaround and
 * RE2-unsupported extensions at construction (it has no backtracking, so
 * every accepted pattern runs in linear time). The dialect additionally
 * rejects every `(?` construct that is not a non-capturing group `(?:...)` —
 * inline flags such as `(?i)` / `(?i:...)`, named groups and the lookarounds —
 * so all four forbidden features fail closed here.
 *
 * Matching is substring semantics; a full match requires explicit `^...$`
 * anchors.
 */
import { RE2 } from 're2-wasm';

const INVALID_CODE = 'SAFE_REGEX_INVALID';

/** Compile-time rejection of a pattern the dialect does not accept. */
export class SafeRegexError extends Error {
  readonly code = INVALID_CODE;
  constructor(reason: string) {
    super(`${INVALID_CODE}: ${reason}`);
    this.name = 'SafeRegexError';
  }
}

/** A compiled, immutable, linear-time substring matcher. */
export interface CompiledSafeRegexV1 {
  /** Raw pattern source, exactly as supplied. */
  readonly pattern: string;
  /** Pattern length in Unicode code points (feeds the maxPatternLength limit). */
  readonly sourceLength: number;
  /** Substring test; full match requires explicit anchors. */
  test(input: string): boolean;
}

/**
 * Reject every `(?` construct except non-capturing groups. A hand-rolled scan
 * (rather than a RegExp) keeps the wrapper free of JS RegExp anywhere in the
 * compile path; it tracks escaped characters and character classes so a
 * literal `(?` inside `[(?]` is not a false positive.
 */
function rejectInlineFlagLikeConstructs(pattern: string): void {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      i += 1; // skip the escaped character
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '(' && pattern[i + 1] === '?') {
      if (pattern[i + 2] !== ':') {
        throw new SafeRegexError(
          `unsupported '(?' construct near offset ${i}: inline flags, lookaround and named groups are not part of forge-safe-regex/v1`,
        );
      }
      i += 1; // skip the '?'; the group is allowed to continue
    }
  }
}

/**
 * Compile a pattern against the RE2-compatible subset. Throws
 * `SafeRegexError` (code `SAFE_REGEX_INVALID`) for anything RE2 rejects and
 * for inline-flag / lookaround / named-group constructs.
 */
export function compileSafeRegexV1(pattern: string): CompiledSafeRegexV1 {
  if (typeof pattern !== 'string') {
    throw new SafeRegexError('pattern must be a string');
  }
  rejectInlineFlagLikeConstructs(pattern);
  let re: RE2;
  try {
    re = new RE2(pattern, 'u'); // mandatory Unicode mode
  } catch (err) {
    throw new SafeRegexError(`RE2 rejected the pattern: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    pattern,
    sourceLength: Array.from(pattern).length,
    test: (input) => re.test(input),
  };
}
