/**
 * Task 3 object registry: public closed Blob kind/schema/media registry API
 * of the authoritative per-slot review lifecycle v2 (spec §7.1/§8; design
 * §10/§11/§13/§16/§17). Every member of `AuthoritativeBlobKindV2` is
 * registered with exactly one schema version, media type, strict parser,
 * child-ref extractor and max-bytes policy (the registration table itself
 * lives in `object-schemas.ts`, keyed by the same closed union).
 *
 * Unknown kinds, schema versions, unknown fields, mismatched display digests,
 * self refs and illegal phase/provenance combinations fail closed with
 * `SCHEMA_INVALID`. Pure module: no fs/EventStore/provider/HTTP/React, no
 * wall clock, no random.
 */
import { canonicalJsonBytesAndSha256 } from '../structured-slots/canonical-json';
import {
  AUTHORITATIVE_BLOB_KINDS_V2,
  type AuthoritativeBlobKindV2,
  type BlobRefV2,
} from '../../shared/authoritative-review-v2';
import {
  SchemaError,
  assertBlobRef,
} from './authority-types';
import type { AuthoritativeReviewProfile } from './authority-types';
import { registrations, type BlobSchemaRegistration } from './object-schemas';
import { PROFILE_SNAPSHOT_BOOTSTRAP_MAX_BYTES } from './object-schemas';

export { PROFILE_SNAPSHOT_BOOTSTRAP_MAX_BYTES };
export { parseProfileSnapshotObject, fullProfileForTests } from './object-schemas';


/* ------------------------------------------------------------------ */
/* Bootstrap profile-snapshot limit (§7.1: profile-independent)        */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* Registry access                                                     */
/* ------------------------------------------------------------------ */

const REGISTRY: Readonly<Record<AuthoritativeBlobKindV2, BlobSchemaRegistration<unknown>>> = registrations;

function registrationOf(kind: AuthoritativeBlobKindV2): BlobSchemaRegistration<unknown> {
  const reg = REGISTRY[kind];
  if (!reg) {
    throw new SchemaError(`unregistered blob kind '${kind}'`);
  }
  return reg;
}

export function isRegisteredKind(kind: string): kind is AuthoritativeBlobKindV2 {
  return (AUTHORITATIVE_BLOB_KINDS_V2 as readonly string[]).includes(kind);
}

export function registeredKinds(): AuthoritativeBlobKindV2[] {
  return [...AUTHORITATIVE_BLOB_KINDS_V2];
}

export function schemaVersionOf(kind: AuthoritativeBlobKindV2): number {
  return registrationOf(kind).schemaVersion;
}

export function mediaTypeOf(kind: AuthoritativeBlobKindV2): BlobRefV2['mediaType'] {
  return registrationOf(kind).mediaType;
}

/** Maximum canonical bytes for `kind` under `profile` (profile_snapshot uses the bootstrap cap). */
export function maxBytesForBlob(kind: AuthoritativeBlobKindV2, profile: AuthoritativeReviewProfile): number {
  return registrationOf(kind).maxBytes(profile);
}

/* ------------------------------------------------------------------ */
/* Blob identity                                                       */
/* ------------------------------------------------------------------ */

/**
 * Compute the reference of `value` under `kind`: SHA-256 over the exact
 * canonical bytes. Embedded BlobRef fields are validated structurally; the
 * full per-kind schema validation is `parseBlob`.
 */
export function refOfBlob(kind: AuthoritativeBlobKindV2, value: unknown): BlobRefV2 {
  const reg = registrationOf(kind);
  assertEmbeddedRefsWellFormed(value);
  const { bytes, sha256 } = canonicalJsonBytesAndSha256(value);
  return {
    kind,
    digest: sha256,
    byteLength: bytes.length,
    mediaType: reg.mediaType,
    schemaVersion: reg.schemaVersion,
  };
}

/**
 * Strict schema validation of `value` under `kind`. When `ref` is given the
 * ref fields must match the canonical bytes exactly; otherwise the ref is
 * computed. Returns the validated object AND its ref.
 */
export function parseBlob(
  kind: AuthoritativeBlobKindV2,
  value: unknown,
  ref?: BlobRefV2,
): { object: unknown; ref: BlobRefV2 } {
  const reg = registrationOf(kind);
  const parsed = reg.parse(value);
  const computed = refOfBlob(kind, value);
  if (ref !== undefined) {
    if (
      ref.kind !== computed.kind ||
      ref.digest !== computed.digest ||
      ref.byteLength !== computed.byteLength ||
      ref.mediaType !== computed.mediaType ||
      ref.schemaVersion !== computed.schemaVersion
    ) {
      throw new SchemaError(`blob ref does not match canonical bytes for kind '${kind}'`);
    }
  }
  return { object: parsed, ref: computed };
}

/** Child-ref extraction over a parsed or raw object. */
export function childRefsForBlob(kind: AuthoritativeBlobKindV2, value: unknown): readonly BlobRefV2[] {
  const reg = registrationOf(kind);
  return reg.childRefs(value as Parameters<typeof reg.childRefs>[0]);
}

/**
 * Self-reference guard: no object may reference its own aggregate (design
 * §9/§11.3/§16.1/acceptance 89/96/105). Rejects when a direct child ref
 * equals the object's own ref.
 */
export function assertNoSelfReference(kind: AuthoritativeBlobKindV2, value: unknown): BlobRefV2 {
  const own = refOfBlob(kind, value);
  const children = childRefsForBlob(kind, value);
  for (const child of children) {
    if (child.kind === own.kind && child.digest === own.digest && child.byteLength === own.byteLength) {
      throw new SchemaError(`object of kind '${kind}' references its own aggregate (self ref)`);
    }
  }
  return own;
}

/**
 * Transitive closure walk over `childRefs`. `resolve` maps a ref to its raw
 * object bytes (a store resolver); unresolvable refs end that branch. Used by
 * GC-like tests to prove a constructed DAG contains no cycle back to a root.
 */
export function closureOf(
  value: unknown,
  resolve: (ref: BlobRefV2) => unknown | null,
  kind: AuthoritativeBlobKindV2,
): BlobRefV2[] {
  const seen = new Set<string>();
  const out: BlobRefV2[] = [];
  const queue: BlobRefV2[] = [...childRefsForBlob(kind, value)];
  while (queue.length > 0) {
    const ref = queue.shift() as BlobRefV2;
    const key = `${ref.kind}:${ref.digest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
    const child = resolve(ref);
    if (child === null || child === undefined || typeof child !== 'object') continue;
    const childKind = ref.kind;
    if (!isRegisteredKind(childKind)) continue;
    let childRefs: readonly BlobRefV2[];
    try {
      childRefs = childRefsForBlob(childKind, child);
    } catch {
      continue;
    }
    queue.push(...childRefs);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Structural guard for values passed to refOfBlob                     */
/* ------------------------------------------------------------------ */

/**
 * Walk `value`; any plain object shaped like a BlobRefV2 must be a fully
 * well-formed, currently registered ref. This keeps refs carried inside
 * objects honest even before full schema parse.
 */
export function assertEmbeddedRefsWellFormed(value: unknown, where = 'value'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertEmbeddedRefsWellFormed(v, `${where}[${i}]`));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const rec = value as Record<string, unknown>;
  if (typeof rec.kind === 'string' && typeof rec.digest === 'string' && typeof rec.byteLength === 'number') {
    const ref = assertBlobRef(value, where);
    if (!isRegisteredKind(ref.kind)) {
      throw new SchemaError(`${where}.kind '${ref.kind}' is not a registered blob kind`);
    }
    return;
  }
  for (const key of Object.keys(rec)) assertEmbeddedRefsWellFormed(rec[key], `${where}.${key}`);
}