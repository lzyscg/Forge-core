// @vitest-environment node
/**
 * Task 6 blob store tests (brief Step 1): canonical put/read, same-ref
 * idempotency, same-digest/different-bytes corruption, wrong
 * kind/media/schema/size rejection, child-ref validation, missing-child
 * fail-closed, task/path containment, frozen profile snapshot archive/ref
 * identity, and objects with equal semantic/root digests but different
 * BlobRef digests.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CorePaths } from './core-paths';
import { AuthoritativeReviewBlobStore, refKey } from './authoritative-review-blob-store';
import { STORAGE_ERROR_CODES } from './atomic-file';
import {
  fullProfileForTests,
  refOfBlob,
} from '../authoritative-review/object-registry';
import {
  canonicalJsonBytes,
  canonicalJsonSha256,
} from '../structured-slots/canonical-json';
import { createAuthoritativeReviewTestEnvironment } from '../structured-slots/test-support/authoritative-review-test-registry';
import type { AuthoritativeBlobKindV2, BlobRefV2 } from '../../shared/authoritative-review-v2';
import type { AuthoritativeReviewProfile } from '../authoritative-review/authority-types';

const TASK_ID = 'task-v2-1';

const H1 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const H2 = '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const H3 = '2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/** Minimal schema-valid review_fact body (no child refs, no self digest). */
function reviewFact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    factId: 'f-1',
    targetKind: 'content_slot',
    targetStableId: 's-1',
    verdict: 'pass',
    factOrigin: { kind: 'batch', adoptionEligible: true },
    adoptionEligible: true,
    localSubjectDigest: H1,
    localContextDigest: H2,
    reviewPolicyDigest: H3,
    findingIds: [],
    evidence: [],
    reviewerAttemptId: 'a-1',
    recordedAt: '2026-08-14T10:00:00.000Z',
    ...overrides,
  };
}

/** Minimal schema-valid domain_publish publication payload (child refs via blobRefs). */
function publishPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    family: 'domain_publish',
    operationId: 'op-1',
    taskId: TASK_ID,
    publishKind: 'content_revision_commit',
    blobRefs: [],
    expectedResultIdentity: 'result-1',
    ...overrides,
  };
}

/** Profile with a single tiny per-kind cap (for size-rejection tests). */
function tinyProfileForKind(kind: AuthoritativeBlobKindV2, maxBytes: number): AuthoritativeReviewProfile {
  const base = fullProfileForTests();
  return { ...base, maxBytesByKind: { ...base.maxBytesByKind, [kind]: maxBytes } };
}

let tempRoot: string | undefined;

/** One isolated data root per store; the afterEach removes it. */
async function createStore(
  profile: AuthoritativeReviewProfile = fullProfileForTests(),
): Promise<{ store: AuthoritativeReviewBlobStore; paths: CorePaths }> {
  tempRoot = await mkdtemp(join(tmpdir(), 'forge-core-v2-blob-'));
  const paths = CorePaths.create({ dataRoot: tempRoot, templateRoot: join(tempRoot, 'templates') });
  return { store: new AuthoritativeReviewBlobStore(paths, profile), paths };
}

afterEach(async () => {
  if (tempRoot !== undefined) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe('AuthoritativeReviewBlobStore put/read (§7.1/§8)', () => {
  it('canonical put writes blobs/<kind>/<first2>/<digest> and readJson returns the parsed object', async () => {
    const { store, paths } = await createStore();
    const value = reviewFact();
    const ref = await store.putJson(TASK_ID, 'review_fact', value);

    expect(ref.kind).toBe('review_fact');
    expect(ref.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.digest).toBe(canonicalJsonSha256(value));
    expect(ref.byteLength).toBe(canonicalJsonBytes(value).length);
    expect(ref.mediaType).toBe('application/json');
    expect(ref.schemaVersion).toBe(1);

    const file = join(paths.taskStructuredV2BlobsRoot(TASK_ID), 'review_fact', ref.digest.slice(0, 2), ref.digest);
    const bytes = await readFile(file);
    expect(bytes).toEqual(canonicalJsonBytes(value));

    const readBack = await store.readJson<typeof value>(TASK_ID, ref, 'review_fact');
    expect(readBack).toEqual(value);
  });

  it('identical bytes are idempotent: same value returns the same ref and never rewrites the file', async () => {
    const { store } = await createStore();
    const ref1 = await store.putJson(TASK_ID, 'review_fact', reviewFact());
    const ref2 = await store.putJson(TASK_ID, 'review_fact', reviewFact());
    expect(ref2).toEqual(ref1);
    const readBack = await store.readJson<Record<string, unknown>>(TASK_ID, ref2, 'review_fact');
    expect(readBack.factId).toBe('f-1');
  });

  it('same digest but DIFFERENT existing bytes at the address is corruption, never last-writer-wins', async () => {
    const { store, paths } = await createStore();
    const value = reviewFact();
    const ref = await store.putJson(TASK_ID, 'review_fact', value);

    const file = join(paths.taskStructuredV2BlobsRoot(TASK_ID), 'review_fact', ref.digest.slice(0, 2), ref.digest);
    // Overwrite the committed file with different bytes of the SAME length so
    // the address still identifies the digest but the content diverges.
    const original = canonicalJsonBytes(value);
    const corrupted = Buffer.from(original);
    corrupted[Math.floor(corrupted.length / 2)] = 0x21;
    expect(corrupted.equals(original)).toBe(false);
    await writeFile(file, corrupted);

    await expect(store.putJson(TASK_ID, 'review_fact', value)).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.TASK_CORRUPTED,
    });
    await expect(store.readJson(TASK_ID, ref, 'review_fact')).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.TASK_CORRUPTED,
    });
  });

  it('a truncated file (byte length mismatch) fails closed as corruption', async () => {
    const { store, paths } = await createStore();
    const ref = await store.putJson(TASK_ID, 'review_fact', reviewFact());
    const file = join(paths.taskStructuredV2BlobsRoot(TASK_ID), 'review_fact', ref.digest.slice(0, 2), ref.digest);
    await writeFile(file, Buffer.from('{}'));
    await expect(store.readJson(TASK_ID, ref, 'review_fact')).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.TASK_CORRUPTED,
    });
  });

  it('a missing blob fails closed as corruption', async () => {
    const { store } = await createStore();
    const ghost = refOfBlob('review_fact', reviewFact({ factId: 'never-put' }));
    await expect(store.readJson(TASK_ID, ghost, 'review_fact')).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.TASK_CORRUPTED,
    });
  });

  it('rejects an unregistered kind, schema-invalid bodies, non-canonical values and oversized bodies', async () => {
    const { store } = await createStore();
    await expect(
      store.putJson(TASK_ID, 'not_a_kind' as AuthoritativeBlobKindV2, {}),
    ).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.INVALID_INPUT });
    await expect(
      store.putJson(TASK_ID, 'review_fact', reviewFact({ surpriseField: true })),
    ).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.INVALID_INPUT });
    await expect(
      store.putJson(TASK_ID, 'review_fact', reviewFact({ factId: undefined })),
    ).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.INVALID_INPUT });
  });

  it('rejects a body larger than the profile maxBytes for that kind', async () => {
    const profile = tinyProfileForKind('review_fact', 64);
    const { store } = await createStore(profile);
    // The minimal valid review_fact body is far larger than 64 canonical bytes.
    await expect(store.putJson(TASK_ID, 'review_fact', reviewFact())).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.INVALID_INPUT,
    });
  });

  it('rejects embedded child refs that are not well-formed or not registered', async () => {
    const { store } = await createStore();
    const badDigest = publishPayload({
      blobRefs: [
        { kind: 'artifact', digest: 'zz', byteLength: 1, mediaType: 'application/json', schemaVersion: 1 },
      ],
    });
    await expect(store.putJson(TASK_ID, 'publication_operation_payload', badDigest)).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.INVALID_INPUT,
    });
    const unregistered = publishPayload({
      blobRefs: [
        { kind: 'wibble', digest: H1, byteLength: 1, mediaType: 'application/json', schemaVersion: 1 },
      ],
    });
    await expect(store.putJson(TASK_ID, 'publication_operation_payload', unregistered)).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.INVALID_INPUT,
    });
    // A well-formed child-ref payload passes (the self-ref guard never false-positives).
    const factRef = refOfBlob('review_fact', reviewFact());
    const good = publishPayload({ blobRefs: [factRef] });
    await expect(store.putJson(TASK_ID, 'publication_operation_payload', good)).resolves.toMatchObject({
      kind: 'publication_operation_payload',
    });
  });

  it('readJson rejects a ref of the wrong kind, media type or byte length as corruption', async () => {
    const { store } = await createStore();
    const ref = await store.putJson(TASK_ID, 'review_fact', reviewFact());
    await expect(store.readJson(TASK_ID, ref, 'finding_verification_record')).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.TASK_CORRUPTED,
    });
    await expect(
      store.readJson(TASK_ID, { ...ref, mediaType: 'text/plain' }, 'review_fact'),
    ).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.TASK_CORRUPTED });
    await expect(
      store.readJson(TASK_ID, { ...ref, byteLength: ref.byteLength + 1 }, 'review_fact'),
    ).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.TASK_CORRUPTED });
  });

  it('readJson rejects a malformed ref as invalid input', async () => {
    const { store } = await createStore();
    await expect(
      store.readJson(TASK_ID, { kind: 'x', digest: 'zz', byteLength: -1 } as unknown as BlobRefV2, 'review_fact'),
    ).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.INVALID_INPUT });
    await expect(
      store.readJson(
        TASK_ID,
        { kind: 'not_a_kind', digest: H1, byteLength: 1, mediaType: 'application/json', schemaVersion: 1 } as unknown as BlobRefV2,
        'review_fact',
      ),
    ).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.INVALID_INPUT });
  });

  it('enforces task/path containment: unsafe task ids never touch the filesystem', async () => {
    const { store } = await createStore();
    await expect(store.putJson('../escape', 'review_fact', reviewFact())).rejects.toMatchObject({
      code: 'CORE_PATH_INVALID',
    });
    await expect(store.putJson('a/b', 'review_fact', reviewFact())).rejects.toMatchObject({
      code: 'CORE_PATH_INVALID',
    });
  });

  it('each task set has exactly one file and blob files stay under the v2 blobs root', async () => {
    const { store, paths } = await createStore();
    const ref = await store.putJson(TASK_ID, 'review_fact', reviewFact());
    const blobsRoot = paths.taskStructuredV2BlobsRoot(TASK_ID);
    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else files.push(full);
      }
    }
    await walk(blobsRoot);
    expect(files).toEqual([join(blobsRoot, 'review_fact', ref.digest.slice(0, 2), ref.digest)]);
  });
});

describe('AuthoritativeReviewBlobStore resolveClosure (§8 GC-root discipline)', () => {
  it('resolves roots plus child refs recursively and dedupes shared children', async () => {
    const { store } = await createStore();
    const factRef = await store.putJson(TASK_ID, 'review_fact', reviewFact({ factId: 'f-shared' }));
    const payloadRef = await store.putJson(
      TASK_ID,
      'publication_operation_payload',
      publishPayload({ blobRefs: [factRef] }),
    );

    const closure = await store.resolveClosure(TASK_ID, [payloadRef]);
    expect(closure.refs.size).toBe(2);
    expect(closure.objects.size).toBe(2);
    expect(closure.objects.get(refKey(payloadRef))).toMatchObject({ family: 'domain_publish' });
    expect(closure.objects.get(refKey(factRef))).toMatchObject({ factId: 'f-shared' });
  });

  it('fails closed when a child ref is missing — never returns partial data', async () => {
    const { store } = await createStore();
    const ghost = refOfBlob('review_fact', reviewFact({ factId: 'not-put' }));
    const payloadRef = await store.putJson(
      TASK_ID,
      'publication_operation_payload',
      publishPayload({ blobRefs: [ghost] }),
    );
    await expect(store.resolveClosure(TASK_ID, [payloadRef])).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.TASK_CORRUPTED,
    });
  });

  it('objects with equal semantic/root digests but different BlobRef digests are distinct closure entries', async () => {
    const { store } = await createStore();
    const factRef = await store.putJson(TASK_ID, 'review_fact', reviewFact());
    // Both payloads share expectedResultIdentity (the semantic identity) and the
    // same child set; only operationId differs, so their BlobRef digests differ.
    const refA = await store.putJson(TASK_ID, 'publication_operation_payload', publishPayload({ operationId: 'op-a', blobRefs: [factRef] }));
    const refB = await store.putJson(TASK_ID, 'publication_operation_payload', publishPayload({ operationId: 'op-b', blobRefs: [factRef] }));
    expect(refA.digest).not.toBe(refB.digest);

    const closure = await store.resolveClosure(TASK_ID, [refA, refB]);
    expect(closure.objects.size).toBe(3);
    expect(closure.refs.size).toBe(3);
    expect(closure.objects.get(refKey(refA))).toMatchObject({ operationId: 'op-a', expectedResultIdentity: 'result-1' });
    expect(closure.objects.get(refKey(refB))).toMatchObject({ operationId: 'op-b', expectedResultIdentity: 'result-1' });
    // The shared child resolves once.
    expect(closure.refs.has(refKey(factRef))).toBe(true);
  });

  it('equal content root digests with different manifest bytes are different refs (§7.3)', async () => {
    const { store } = await createStore();
    // mapRef children need not exist for put/read (put-before-append visibility);
    // only closure requires them, so a bare well-formed ref is a legal body.
    const mapRefA = refOfBlob('map_snapshot', { scaffoldId: 's-a' });
    const mapRefB = refOfBlob('map_snapshot', { scaffoldId: 's-b' });
    const base = (): Record<string, unknown> => ({
      taskId: TASK_ID,
      mapSemanticDigest: H1,
      taskContentRevision: 1,
      manifestPhase: 'provisional',
      entries: [],
      producerPlanSpecRef: null,
      priorManifestRef: null,
      finalizerValidatorAggregateRefs: [],
      finalizerWarningRootRefs: [],
      // equal root digest below — the manifests differ only in map identity.
      contentRootDigest: H2,
    });
    // Self-digest rule (hs): manifestDigest covers the canonical body WITHOUT
    // that field, so it is computed before the field is added.
    const bodyA: Record<string, unknown> = { ...base(), mapRef: mapRefA };
    const withoutDigestA = { ...bodyA };
    delete withoutDigestA.manifestDigest;
    bodyA.manifestDigest = canonicalJsonSha256(withoutDigestA);
    const bodyB: Record<string, unknown> = { ...base(), mapRef: mapRefB };
    const withoutDigestB = { ...bodyB };
    delete withoutDigestB.manifestDigest;
    bodyB.manifestDigest = canonicalJsonSha256(withoutDigestB);

    const refA = await store.putJson(TASK_ID, 'content_revision_manifest', bodyA);
    const refB = await store.putJson(TASK_ID, 'content_revision_manifest', bodyB);
    expect(refA.digest).not.toBe(refB.digest);
    const readA = await store.readJson<{ contentRootDigest: string }>(TASK_ID, refA, 'content_revision_manifest');
    const readB = await store.readJson<{ contentRootDigest: string }>(TASK_ID, refB, 'content_revision_manifest');
    expect(readA.contentRootDigest).toBe(H2);
    expect(readB.contentRootDigest).toBe(H2);
  });
});

describe('AuthoritativeReviewBlobStore frozen profile snapshot (§4.3/§7.1)', () => {
  it('archives the task-bound profile snapshot with distinct profileDigest/ref identity and stable ref', async () => {
    const { store, paths } = await createStore();
    const { profile } = createAuthoritativeReviewTestEnvironment();
    const body = profile as unknown as Record<string, unknown>;
    const ref = await store.putJson(TASK_ID, 'profile_snapshot', body);

    expect(ref.kind).toBe('profile_snapshot');
    expect(ref.mediaType).toBe('application/json');
    expect(ref.digest).toBe(canonicalJsonSha256(body));
    expect(ref.byteLength).toBe(canonicalJsonBytes(body).length);

    const readBack = await store.readJson<Record<string, unknown>>(TASK_ID, ref, 'profile_snapshot');
    // readJson returns the registry-normalized envelope; the FULL archived
    // bytes (all five limit groups) stay immutable on disk.
    expect(readBack.profileIdentity).toBe(body.profileIdentity);
    expect(readBack.profileDigest).toBe(body.profileDigest);
    expect(readBack.qualificationState).toBe('test_only');
    expect(canonicalJsonBytes(body)).toEqual(
      await readFile(
        join(
          paths.taskStructuredV2BlobsRoot(TASK_ID),
          'profile_snapshot',
          ref.digest.slice(0, 2),
          ref.digest,
        ),
      ),
    );
    // The two identities are distinct: profileDigest covers bytes minus the
    // field, profileSnapshotRef.digest covers the complete object bytes.
    expect(readBack.profileDigest).not.toBe(ref.digest);
    // The immutable archive keeps one stable ref for identical bytes.
    const again = await store.putJson(TASK_ID, 'profile_snapshot', body);
    expect(again).toEqual(ref);
  });

  it('profile_snapshot sizes against the profile-independent bootstrap cap, never a profile limit', async () => {
    const profile = tinyProfileForKind('profile_snapshot', 8);
    const { store } = await createStore(profile);
    const { profile: frozen } = createAuthoritativeReviewTestEnvironment();
    const body = frozen as unknown as Record<string, unknown>;
    await expect(store.putJson(TASK_ID, 'profile_snapshot', body)).resolves.toMatchObject({
      kind: 'profile_snapshot',
    });
  });
});