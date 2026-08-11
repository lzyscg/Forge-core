/**
 * forge-canonical-json/v1 — RFC 8785 JCS core encoding and hashing
 * (design §25.2 C02).
 *
 * The full algorithm is implemented explicitly — key sorting by JCS UTF-16
 * code unit order, minimal escaping with lowercase hex, shortest number
 * serialization, -0 -> 0, UTF-8 output — and never delegates the whole job to
 * a plain JSON.stringify shortcut. Number serialization uses the language's
 * shortest round-trip form (ECMAScript Number::toString), which is identical
 * to JSON.stringify's number output for finite numbers.
 *
 * Before serialization, non-JSON values are rejected with the stable code
 * `CANONICAL_JSON_INVALID`: lone surrogates, NaN/±Infinity, undefined,
 * bigint, functions, symbols, cycles, and non-plain objects with prototypes.
 *
 * This module is a pure domain computation (no storage, no runtime).
 */
import { createHash } from 'node:crypto';

const INVALID_CODE = 'CANONICAL_JSON_INVALID';

class CanonicalJsonError extends Error {
  readonly code = INVALID_CODE;
  constructor(reason: string) {
    super(`${INVALID_CODE}: ${reason}`);
    this.name = 'CanonicalJsonError';
  }
}

function invalid(reason: string): never {
  throw new CanonicalJsonError(reason);
}

/** JCS object-key order: lexicographic by UTF-16 code unit (RFC 8785 §9.5). */
function compareJcsKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Plain object: Object.prototype or a null prototype only (design C02). */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Escape sequence for one char that needs escaping per JCS minimal escaping:
 * `\"` `\\` `\b` `\t` `\n` `\f` `\r`, and lowercase-hex `\u00xx` for the other
 * C0 controls. Only chars < 0x20, `"` (0x22) and `\` (0x5c) reach here.
 */
function escapeChar(c: number): string {
  switch (c) {
    case 0x22:
      return '\\"';
    case 0x5c:
      return '\\\\';
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
      return `\\u${c.toString(16).padStart(4, '0')}`;
  }
}

/** True when the code unit must be escaped (JCS minimal escaping). */
function needsEscape(c: number): boolean {
  return c < 0x20 || c === 0x22 || c === 0x5c;
}

/**
 * Serialize one string with lone-surrogate rejection, minimal escaping and
 * raw (non-escaped) non-ASCII output per JCS.
 *
 * This is O(n) with O(1)-ish peak on top of the input (no per-character
 * `out +=` that would build a giant V8 ConsString rope — the Task 19 memory
 * blowup). One linear pass validates every lone surrogate AND detects whether
 * any char needs escaping; when none does, a single concat flattens O(n) with
 * one allocation. When escaping is needed, the result is built by collecting
 * runs of unescaped chars (cheap SlicedString views) plus escape sequences and
 * joining once.
 */
function serializeString(s: string): string {
  let needsEscapePass = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      // High surrogate: must be followed by a low surrogate.
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid('lone surrogate');
      i += 1;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) invalid('lone surrogate');
    // No early break: the single pass must still validate every lone surrogate
    // in the remainder of the string.
    if (needsEscape(c)) needsEscapePass = true;
  }

  if (!needsEscapePass) {
    // Fast path: no escaping needed — the engine flattens this single concat
    // O(n) with one allocation. Never loop per-character here.
    return `"${s}"`;
  }

  // Escaping path: collect runs of raw chars plus escape sequences, then join.
  const chunks: string[] = [];
  let runStart = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      // Valid pair (already validated above); both code units are emitted raw
      // and simply extend the current run.
      i += 1;
      continue;
    }
    if (needsEscape(c)) {
      if (i > runStart) chunks.push(s.slice(runStart, i));
      chunks.push(escapeChar(c));
      runStart = i + 1;
    }
  }
  if (runStart < s.length) chunks.push(s.slice(runStart));
  return `"${chunks.join('')}"`;
}

function serialize(value: unknown, ancestors: Set<object>): string {
  switch (typeof value) {
    case 'undefined':
      invalid('undefined is not valid JSON');
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) invalid('non-finite number');
      // -0 normalizes to 0; String(-0) is already '0', stated explicitly.
      if (Object.is(value, -0)) return '0';
      return String(value);
    case 'string':
      return serializeString(value);
    case 'bigint':
      invalid('bigint is not valid JSON');
    case 'function':
      invalid('function is not valid JSON');
    case 'symbol':
      invalid('symbol is not valid JSON');
    case 'object':
      break;
  }

  if (value === null) return 'null';

  if (Array.isArray(value)) {
    if (ancestors.has(value)) invalid('circular reference');
    ancestors.add(value);
    const parts = new Array<string>(value.length);
    for (let i = 0; i < value.length; i++) {
      // Sparse holes read as undefined and are rejected by the serializer.
      parts[i] = serialize(value[i], ancestors);
    }
    ancestors.delete(value);
    return `[${parts.join(',')}]`;
  }

  if (!isPlainObject(value)) invalid('non-plain object with prototype');
  if (ancestors.has(value)) invalid('circular reference');
  ancestors.add(value);
  const keys = Object.keys(value).sort(compareJcsKeys);
  const parts = new Array<string>(keys.length);
  for (let i = 0; i < keys.length; i++) {
    parts[i] = `${serializeString(keys[i])}:${serialize((value as Record<string, unknown>)[keys[i]], ancestors)}`;
  }
  ancestors.delete(value);
  return `{${parts.join(',')}}`;
}

/** Canonical JSON string (JCS core, UTF-8 compatible). */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set<object>());
}

/**
 * One-pass canonical bytes + SHA-256: serializes the value ONCE, UTF-8 encodes
 * ONCE and hashes the bytes ONCE. Callers that need both (content-addressed
 * blob writes, the content-root benchmark case) MUST use this instead of
 * pairing `canonicalJsonBytes` with `canonicalJsonSha256`, which would
 * canonicalize the same payload twice.
 */
export function canonicalJsonBytesAndSha256(value: unknown): { bytes: Buffer; sha256: string } {
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, sha256 };
}

/** Canonical JSON bytes (UTF-8) of the canonical string. */
export function canonicalJsonBytes(value: unknown): Buffer {
  return canonicalJsonBytesAndSha256(value).bytes;
}

/** Lowercase hex SHA-256 of the canonical UTF-8 bytes. */
export function canonicalJsonSha256(value: unknown): string {
  return canonicalJsonBytesAndSha256(value).sha256;
}
