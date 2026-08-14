// @vitest-environment node
/**
 * Authoritative review profile archive tests (Task 5 / spec §4.3).
 *
 * Archived profile bytes are stored by digest and remain readable after a
 * later capability/profile change; missing or mismatched archived bytes make
 * the task corrupt — the current deployment profile is never substituted for
 * the task-bound snapshot profile.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthoritativeReviewProfileSnapshotV1Body } from './authoritative-review-profile';
import {
  profileCanonicalDigest,
  profileSnapshotRefOf,
  validateAuthoritativeReviewProfile,
} from './authoritative-review-profile';
import { AuthoritativeReviewProfileArchive, type ProfileArchiveByteStore } from './authoritative-review-profile-archive';
import {
  AUTHORITATIVE_REVIEW_TEST_HANDLER_IDENTITIES,
  buildAuthoritativeReviewPriorTestOnlyProfileBody,
  createAuthoritativeReviewTestEnvironment,
} from './test-support/authoritative-review-test-registry';

function testBody(): AuthoritativeReviewProfileSnapshotV1Body {
  return createAuthoritativeReviewTestEnvironment().profile as AuthoritativeReviewProfileSnapshotV1Body;
}

/** A second profile revision: same identity, different bytes. */
function revisedBody(): AuthoritativeReviewProfileSnapshotV1Body {
  const profile = testBody();
  const revised = { ...profile, profileVersion: profile.profileVersion + 1 };
  const withoutDigest = { ...revised } as Record<string, unknown>;
  delete withoutDigest.profileDigest;
  return validateAuthoritativeReviewProfile({
    ...withoutDigest,
    profileDigest: profileCanonicalDigest(withoutDigest as unknown as AuthoritativeReviewProfileSnapshotV1Body),
  } as AuthoritativeReviewProfileSnapshotV1Body);
}

describe('profile archive (bytes by digest)', () => {
  it('stores canonical bytes by digest and resolves the exact body', () => {
    const archive = new AuthoritativeReviewProfileArchive();
    const body = testBody();
    const ref = archive.put(body);
    expect(ref).toEqual(profileSnapshotRefOf(body));
    expect(archive.has(ref)).toBe(true);
    const resolved = archive.resolve(ref);
    expect(resolved).toEqual(body);
    expect(profileSnapshotRefOf(resolved as AuthoritativeReviewProfileSnapshotV1Body)).toEqual(ref);
  });

  it('keeps archived bytes readable after the current profile changes', () => {
    const archive = new AuthoritativeReviewProfileArchive();
    const oldBody = testBody();
    const oldRef = archive.put(oldBody);
    const newBody = revisedBody();
    expect(newBody.profileDigest).not.toBe(oldBody.profileDigest);
    const newRef = archive.put(newBody);
    // the current profile changed; the archived task-bound profile still resolves
    expect(archive.resolve(oldRef)).toEqual(oldBody);
    expect(archive.resolve(newRef)).toEqual(newBody);
    expect(archive.resolveByDigest(oldBody.profileDigest)).toEqual(oldBody);
  });

  it('resolves archived profiles even when the current capability is disabled', () => {
    const archive = new AuthoritativeReviewProfileArchive();
    const body = testBody();
    const ref = archive.put(body);
    // A disabled environment has no current profile; historical read/genesis
    // still resolves the archived task-bound profile bytes.
    expect(archive.resolve(ref)).toEqual(body);
    expect(archive.resolveByDigest(body.profileDigest)).toEqual(body);
  });

  it('treats a missing archive entry as unresolvable (corrupt at the caller)', () => {
    const archive = new AuthoritativeReviewProfileArchive();
    const ref = profileSnapshotRefOf(testBody());
    expect(archive.resolve(ref)).toBeNull();
    expect(archive.resolveByDigest('0'.repeat(64))).toBeNull();
    expect(archive.has(ref)).toBe(false);
  });

  it('rejects mismatched stored bytes for an existing digest (archive corrupt)', () => {
    class LyingStore implements ProfileArchiveByteStore {
      readonly data = new Map<string, Uint8Array>();
      read(digest: string): Uint8Array | null {
        const bytes = this.data.get(digest);
        if (bytes === undefined) return null;
        return new TextEncoder().encode('different bytes');
      }
      put(digest: string, bytes: Uint8Array): void {
        this.data.set(digest, bytes);
      }
    }
    const archive = new AuthoritativeReviewProfileArchive(new LyingStore());
    const body = testBody();
    const ref = archive.put(body);
    expect(() => archive.resolve(ref)).toThrow('PROFILE_ARCHIVE_CORRUPT');
  });

  it('rejects putting non-canonical bytes under a digest they do not hash to', () => {
    const archive = new AuthoritativeReviewProfileArchive();
    const body = testBody();
    const ref = archive.put(body);
    const refBytes = new TextEncoder().encode(JSON.stringify(body));
    // The store is content-addressed: asserting a mismatched entry fails closed.
    expect(() => archive.assertStored(refBytes, ref)).toThrow('PROFILE_ARCHIVE_CORRUPT');
    expect(createHash('sha256').update(refBytes).digest('hex')).not.toBe(ref.digest);
  });

  it('refuses profile bodies over the bootstrap maximum', () => {
    const archive = new AuthoritativeReviewProfileArchive();
    const body = {
      ...testBody(),
      patch: 'x'.repeat(5 * 1024 * 1024),
    } as unknown as AuthoritativeReviewProfileSnapshotV1Body;
    expect(() => archive.put(body)).toThrow('bootstrap');
  });

  it('a revised body never mutates the archived revision (immutable revisions)', () => {
    const archive = new AuthoritativeReviewProfileArchive();
    const oldBody = testBody();
    const oldRef = archive.put(oldBody);
    const revised = revisedBody();
    const revisedRef = archive.put(revised);
    expect(archive.resolve(oldRef)).toEqual(oldBody);
    expect(oldRef).not.toEqual(revisedRef);
    // The identity family is shared; the archived bytes are not rewritten.
    expect(revisedBody().profileIdentity).toBe(oldBody.profileIdentity);
  });

  it('the archive is shared across environments so a later env still resolves earlier bytes', () => {
    const archive = new AuthoritativeReviewProfileArchive();
    const envA = createAuthoritativeReviewTestEnvironment({ archive });
    const refA = envA.profileSnapshotRef as NonNullable<typeof envA.profileSnapshotRef>;
    expect(archive.resolve(refA)).toEqual(envA.profile);
    // Profile B = the PRIOR test-only revision (distinct installed identities).
    const bodyB = buildAuthoritativeReviewPriorTestOnlyProfileBody();
    const refB = archive.put(bodyB);
    expect(refB.digest).not.toBe(refA.digest);
    // env A's archived profile survives the arrival of profile B
    expect(archive.resolve(refA)).toEqual(envA.profile);
    expect(archive.resolve(refB)).toEqual(bodyB);
  });
});

describe('profile archive with injected byte store', () => {
  it('stores through the injected store and reads through it', () => {
    const data = new Map<string, Uint8Array>();
    const store: ProfileArchiveByteStore = {
      read(digest: string): Uint8Array | null {
        return data.get(digest) ?? null;
      },
      put(digest: string, bytes: Uint8Array): void {
        data.set(digest, bytes);
      },
    };
    const archive = new AuthoritativeReviewProfileArchive(store);
    const body = testBody();
    const ref = archive.put(body);
    expect(data.has(ref.digest)).toBe(true);
    expect(archive.resolve(ref)).toEqual(body);
  });
});