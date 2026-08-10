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
 * Serialize one string with lone-surrogate rejection, minimal escaping and
 * raw (non-escaped) non-ASCII output per JCS.
 */
function serializeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      // High surrogate: must be followed by a low surrogate.
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid('lone surrogate');
      out += s[i];
      out += s[i + 1];
      i += 1;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) invalid('lone surrogate');
    switch (c) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += '\\\\';
        break;
      case 0x08:
        out += '\\b';
        break;
      case 0x09:
        out += '\\t';
        break;
      case 0x0a:
        out += '\\n';
        break;
      case 0x0c:
        out += '\\f';
        break;
      case 0x0d:
        out += '\\r';
        break;
      default:
        if (c < 0x20) {
          out += `\\u${c.toString(16).padStart(4, '0')}`;
        } else {
          out += s[i];
        }
    }
  }
  out += '"';
  return out;
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

/** Canonical JSON bytes (UTF-8) of the canonical string. */
export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

/** Lowercase hex SHA-256 of the canonical UTF-8 bytes. */
export function canonicalJsonSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJsonBytes(value)).digest('hex');
}
