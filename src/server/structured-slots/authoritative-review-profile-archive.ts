/**
 * Authoritative review profile archive (Task 5, spec §4.3/§7.1).
 *
 * Installed profile snapshot bytes are archived by digest. Historical
 * read/genesis resolves the archived task-bound profile even when the current
 * capability is disabled or points to profile B; the current deployment
 * profile is never substituted. Missing or mismatched archived bytes make the
 * task corrupt — the archive fails closed instead of guessing.
 *
 * The byte store is injectable (Task 11 binds the v2 blob store under the task
 * root); the default is an in-memory content-addressed map for Task 5. Every
 * stored body is validated through the EXACT registered `profile_snapshot`
 * parser, so archive resolution and the future blob store share one schema.
 */
import { createHash } from 'node:crypto';
import {
  AUTHORITATIVE_REVIEW_PROFILE_SNAPSHOT_MAX_BYTES,
} from '../authoritative-review/object-schema-parsers-3-constants';
import { canonicalJsonBytes, canonicalJsonSha256 } from './canonical-json';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';
import { isRegisteredKind, refOfBlob } from '../authoritative-review/object-registry';
import type { AuthoritativeReviewProfileSnapshotV1Body } from './authoritative-review-profile';
import { validateAuthoritativeReviewProfile } from './authoritative-review-profile';

/** Archive corruption diagnostic (missing/mismatched bytes are NEVER guessed). */
export const PROFILE_ARCHIVE_CORRUPT = 'PROFILE_ARCHIVE_CORRUPT';

function corrupt(reason: string): never {
  throw new Error(`${PROFILE_ARCHIVE_CORRUPT}: ${reason}`);
}

/** The injectable content-addressable byte store (digest -> canonical bytes). */
export interface ProfileArchiveByteStore {
  read(digest: string): Uint8Array | null;
  put(digest: string, bytes: Uint8Array): void;
}

/** Default store: in-memory map (Task 11 binds the real v2 blob store). */
export class InMemoryProfileArchiveStore implements ProfileArchiveByteStore {
  private readonly data = new Map<string, Uint8Array>();

  read(digest: string): Uint8Array | null {
    const bytes = this.data.get(digest);
    return bytes === undefined ? null : bytes;
  }

  put(digest: string, bytes: Uint8Array): void {
    this.data.set(digest, bytes);
  }
}

/**
 * Archives canonical profile snapshot bytes by their complete-object digest.
 * `put` is idempotent per digest: identical bytes are a no-op, different bytes
 * under one digest are archive corruption. `resolve` re-validates through the
 * registered parser and the profile semantic validator; a missing entry
 * resolves to null (the caller treats that task as corrupt), a mismatched
 * entry throws corruption.
 */
export class AuthoritativeReviewProfileArchive {
  private readonly store: ProfileArchiveByteStore;

  /**
   * Secondary index: the body-field `profileDigest` alias -> complete-object
   * digest. Historical read keys on the frozen `profileDigest` alias, while
   * every cross-object custody/authority link uses the complete-object ref;
   * the two identities never equal (spec §4.3/§7.1).
   */
  private readonly fieldDigestIndex = new Map<string, string>();

  constructor(store: ProfileArchiveByteStore = new InMemoryProfileArchiveStore()) {
    this.store = store;
  }

  /** Exact complete-object BlobRef of one profile body (byte-exact byteLength). */
  refOf(body: AuthoritativeReviewProfileSnapshotV1Body): BlobRefV2 {
    return refOfBlob('profile_snapshot', body);
  }

  /** Canonical bytes of one profile body. */
  canonicalBytesOf(body: AuthoritativeReviewProfileSnapshotV1Body): Uint8Array {
    return canonicalJsonBytes(body);
  }

  /** True when a ref is archived (byte-exact identity). */
  has(ref: BlobRefV2): boolean {
    return this.store.read(ref.digest) !== null;
  }

  /** Stores the profile; returns the exact complete-object ref. */
  put(body: AuthoritativeReviewProfileSnapshotV1Body): BlobRefV2 {
    const bytes = canonicalJsonBytes(body);
    if (bytes.length > AUTHORITATIVE_REVIEW_PROFILE_SNAPSHOT_MAX_BYTES) {
      corrupt(
        `profile body exceeds the bootstrap maximum of ${AUTHORITATIVE_REVIEW_PROFILE_SNAPSHOT_MAX_BYTES} bytes`,
      );
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    const existing = this.store.read(digest);
    if (existing !== null) {
      this.assertSameBytes(existing, bytes);
    } else {
      this.store.put(digest, bytes);
    }
    // Register the body-field profileDigest alias (distinct identity).
    if (body.profileDigest !== digest) {
      const aliasExisting = this.store.read(body.profileDigest);
      if (aliasExisting !== null) {
        corrupt('the profileDigest alias collides with an archived complete-object digest');
      }
      this.fieldDigestIndex.set(body.profileDigest, digest);
    }
    return refOfBlob('profile_snapshot', body);
  }

  /** Resolves one ref; null when the entry is missing, corruption on mismatch. */
  resolve(ref: BlobRefV2): AuthoritativeReviewProfileSnapshotV1Body | null {
    if (ref.kind !== 'profile_snapshot' || !isRegisteredKind(ref.kind)) {
      corrupt('a profile archive ref must be a registered profile_snapshot ref');
    }
    const bytes = this.store.read(ref.digest);
    if (bytes === null) {
      return null;
    }
    this.assertStored(bytes, ref);
    return this.parseArchived(bytes, ref);
  }

  /**
   * Resolves by a digest alone — the complete-object digest OR the body-field
   * `profileDigest` alias (historical read/genesis keys on either identity).
   */
  resolveByDigest(digest: string): AuthoritativeReviewProfileSnapshotV1Body | null {
    const mapped = this.fieldDigestIndex.get(digest);
    const target = mapped ?? digest;
    const bytes = this.store.read(target);
    if (bytes === null) {
      return null;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== target) {
      corrupt('archived bytes do not match their digest (corrupt archive entry)');
    }
    return this.parseArchived(bytes, {
      kind: 'profile_snapshot',
      digest: target,
      byteLength: bytes.length,
      mediaType: 'application/json',
      schemaVersion: 1,
    });
  }

  /**
   * Verifies that stored bytes hash to the ref digest and carry the exact
   * ref fields. Exposed for store-integrity checks; throws on mismatch.
   */
  assertStored(bytes: Uint8Array, ref: BlobRefV2): void {
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== ref.digest) {
      corrupt('archived bytes do not match the profile ref digest');
    }
    if (ref.kind !== 'profile_snapshot' || ref.mediaType !== 'application/json' || ref.schemaVersion !== 1) {
      corrupt('archived profile ref fields violate the registered profile_snapshot contract');
    }
    if (ref.byteLength !== bytes.length) {
      corrupt('archived profile byteLength does not match the stored bytes');
    }
  }

  private assertSameBytes(a: Uint8Array, b: Uint8Array): void {
    if (a.length !== b.length) {
      corrupt('archived bytes differ from the stored bytes under one digest');
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        corrupt('archived bytes differ from the stored bytes under one digest');
      }
    }
  }

  /**
   * Parses archived bytes exactly: canonical JSON parse, the registered
   * envelope parser (exact group shape + digest rule) and the profile semantic
   * validator. Any failure is archive corruption — never a guessed profile.
   */
  private parseArchived(bytes: Uint8Array, ref: BlobRefV2): AuthoritativeReviewProfileSnapshotV1Body {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      corrupt('archived profile bytes are not valid JSON');
    }
    let body: AuthoritativeReviewProfileSnapshotV1Body;
    try {
      body = validateAuthoritativeReviewProfile(parsed);
    } catch (error) {
      corrupt(`archived profile body fails the registered profile_snapshot parser: ${error instanceof Error ? error.message : String(error)}`);
    }
    const computed = refOfBlob('profile_snapshot', body);
    if (computed.digest !== ref.digest || computed.byteLength !== ref.byteLength) {
      corrupt('archived profile ref does not match the parsed canonical bytes');
    }
    if (canonicalJsonSha256(body) !== ref.digest) {
      corrupt('archived profile canonical bytes do not match the ref digest');
    }
    return body;
  }
}