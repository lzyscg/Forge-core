// @vitest-environment node
/**
 * Task 13 private-store tests (design §12.4/§19.1, spec §7.4/§11.3): attempt-
 * bound review draft journals and plan/revision/ordinal-scoped repair staging.
 *
 * Covered: idempotent same-attempt resume; a reclaimed/NEW attempt cannot
 * commit an OLD journal; repair staging scoping; never-publicly-visible by
 * directory scan; paged committed reads; grant/attempt/base validation before
 * journal append; response-loss replay + same-ID/different-body conflict.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { disposeAllTestRoots, makeTempCorePaths } from '../test-support';
import type { CorePaths } from './core-paths';
import { AuthoritativeReviewPrivateStore, type ReviewDraftBindingV2 } from './authoritative-review-private-store';

afterEach(() => {
  disposeAllTestRoots();
});

function ref(kind: string, salt: number): BlobRefV2 {
  return {
    kind: kind as BlobRefV2['kind'],
    digest: salt.toString(16).padStart(64, '0'),
    byteLength: 8,
    mediaType: 'application/json',
    schemaVersion: 1,
  };
}

type BlobRefV2 = { kind: string; digest: string; byteLength: number; mediaType: string; schemaVersion: number };

function binding(overrides: Partial<ReviewDraftBindingV2> = {}): ReviewDraftBindingV2 {
  return {
    workItemId: 'wi-1',
    leaseEpoch: 1,
    attemptId: 'att-1',
    authorityBaseRef: ref('authority_base_set', 1) as ReviewDraftBindingV2['authorityBaseRef'],
    grantSpecRef: ref('write_grant_spec', 2) as ReviewDraftBindingV2['grantSpecRef'],
    ...overrides,
  };
}

function makeStore(): { paths: CorePaths; taskId: string; store: AuthoritativeReviewPrivateStore } {
  const { paths } = makeTempCorePaths('forge-core-private-v2-');
  const taskId = 'task-v2-private';
  mkdirSync(paths.taskRoot(taskId), { recursive: true });
  return { paths, taskId, store: new AuthoritativeReviewPrivateStore(paths, taskId) };
}

describe('AuthoritativeReviewPrivateStore review drafts', () => {
  it('opens idempotently and resumes the SAME attempt/same call', async () => {
    const { store } = makeStore();
    const first = await store.openReviewDraft(binding());
    expect(first.committed).toEqual([]);
    const appended = await store.appendReviewDraft(binding(), {
      clientOperationId: 'op-1',
      op: 'submit_slot_review',
      body: { targetId: 's-1', verdict: 'pass' },
      result: { accepted: true },
    });
    expect(appended.status).toBe('committed');
    const again = await store.openReviewDraft(binding());
    expect(again.committed).toHaveLength(1);
    expect(again.committed[0].clientOperationId).toBe('op-1');
    expect(again.committed[0].body).toEqual({ targetId: 's-1', verdict: 'pass' });
  });

  it('a reclaimed/NEW attempt cannot commit the OLD journal (path-scoped + lease-epoch header check)', async () => {
    const { store } = makeStore();
    await store.appendReviewDraft(binding(), {
      clientOperationId: 'op-1',
      op: 'submit_slot_review',
      body: { targetId: 's-1', verdict: 'pass' },
      result: { accepted: true },
    });
    // A NEW attempt has its OWN journal path (attemptId in the path) — the old
    // journal is abandoned and physically unreachable by the new attempt.
    const newAttempt = await store.openReviewDraft(binding({ leaseEpoch: 2, attemptId: 'att-2' }));
    expect(newAttempt.committed).toEqual([]);
    // The same path (same workItemId + attemptId) with a STALE lease epoch is
    // rejected by the header check — the journal is bound to epoch 1.
    await expect(store.appendReviewDraft(binding({ leaseEpoch: 2 }), {
      clientOperationId: 'op-2',
      op: 'submit_slot_review',
      body: { targetId: 's-2', verdict: 'pass' },
      result: { accepted: true },
    })).rejects.toMatchObject({ code: 'PRIVATE_DRAFT_ABANDONED' });
  });

  it('rejects a journal bound to a DIFFERENT authorityBaseRef (stale base)', async () => {
    const { store } = makeStore();
    await store.appendReviewDraft(binding(), {
      clientOperationId: 'op-1',
      op: 'submit_slot_review',
      body: { targetId: 's-1', verdict: 'pass' },
      result: { accepted: true },
    });
    await expect(store.appendReviewDraft(binding({ authorityBaseRef: ref('authority_base_set', 99) as ReviewDraftBindingV2['authorityBaseRef'] }), {
      clientOperationId: 'op-2',
      op: 'submit_slot_review',
      body: { targetId: 's-2', verdict: 'pass' },
      result: { accepted: true },
    })).rejects.toMatchObject({ code: 'PRIVATE_DRAFT_BOUND_TO_OTHER_ATTEMPT' });
  });

  it('response-loss replay returns the original result; same-ID/different-body conflicts', async () => {
    const { store } = makeStore();
    const b = binding();
    await store.appendReviewDraft(b, {
      clientOperationId: 'op-1',
      op: 'submit_slot_review',
      body: { targetId: 's-1', verdict: 'pass' },
      result: { accepted: true },
    });
    const replay = await store.appendReviewDraft(b, {
      clientOperationId: 'op-1',
      op: 'submit_slot_review',
      body: { targetId: 's-1', verdict: 'pass' },
      result: { accepted: true },
    });
    expect(replay.status).toBe('replayed');
    if (replay.status === 'replayed') {
      expect(replay.entry.result).toEqual({ accepted: true });
    }
    await expect(store.appendReviewDraft(b, {
      clientOperationId: 'op-1',
      op: 'submit_slot_review',
      body: { targetId: 's-1', verdict: 'reject' },
      result: { accepted: true },
    })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  });

  it('pages committed entries only (bounded read, never a full-tree read)', async () => {
    const { store } = makeStore();
    const b = binding();
    for (let i = 1; i <= 5; i += 1) {
      await store.appendReviewDraft(b, {
        clientOperationId: `op-${i}`,
        op: 'submit_slot_review',
        body: { targetId: `s-${i}`, verdict: 'pass' },
        result: { accepted: true },
      });
    }
    const page1 = await store.readReviewDraft(b, { limit: 2 });
    expect(page1.committed).toHaveLength(2);
    expect(page1.committed[0].seq).toBe(1);
    expect(page1.committed[1].seq).toBe(2);
    const page2 = await store.readReviewDraft(b, { afterSeq: 2, limit: 2 });
    expect(page2.committed).toHaveLength(2);
    expect(page2.committed[0].seq).toBe(3);
    const last = await store.readReviewDraft(b, { afterSeq: 4, limit: 2 });
    expect(last.committed).toHaveLength(1);
    expect(last.committed[0].seq).toBe(5);
  });

  it('marks complete and reports it on subsequent reads', async () => {
    const { store } = makeStore();
    const b = binding();
    await store.appendReviewDraft(b, {
      clientOperationId: 'op-1',
      op: 'submit_slot_review',
      body: { targetId: 's-1', verdict: 'pass' },
      result: { accepted: true },
    });
    expect((await store.readAllReviewDraft(b)).complete).toBe(false);
    await store.markReviewDraftComplete(b, true);
    expect((await store.readAllReviewDraft(b)).complete).toBe(true);
  });
});

describe('AuthoritativeReviewPrivateStore repair staging', () => {
  it('is plan/revision/ordinal scoped: different revision/ordinal are separate journals; different attempt on the SAME scope rejects', async () => {
    const { store } = makeStore();
    const base = {
      workItemId: 'wi-repair',
      leaseEpoch: 1,
      attemptId: 'att-repair',
      authorityBaseRef: ref('authority_base_set', 3) as ReviewDraftBindingV2['authorityBaseRef'],
      grantSpecRef: ref('write_grant_spec', 4) as ReviewDraftBindingV2['grantSpecRef'],
    };
    const rev1 = { ...base, planRevisionId: 'plan-r1', batchOrdinal: 1 };
    const rev2 = { ...base, planRevisionId: 'plan-r2', batchOrdinal: 1 };
    const ord2 = { ...base, planRevisionId: 'plan-r1', batchOrdinal: 2 };
    const rev1Attempt2 = { ...base, attemptId: 'att-2', leaseEpoch: 2, planRevisionId: 'plan-r1', batchOrdinal: 1 };
    // Different revision/ordinal → physically separate journals (isolated).
    await store.appendRepairStaging(rev1, {
      clientOperationId: 'patch-1',
      op: 'submit_map_patch',
      body: { expectedStagingDigest: 'a'.repeat(64), operations: [] },
      result: { stagingRoot: 'root-1' },
    });
    const rev2View = await store.openRepairStaging(rev2);
    expect(rev2View.committed).toEqual([]);
    const ord2View = await store.openRepairStaging(ord2);
    expect(ord2View.committed).toEqual([]);
    // Same plan/ordinal scope but a DIFFERENT attempt → the journal is bound
    // to the original attempt and the new attempt cannot commit to it.
    await expect(store.openRepairStaging(rev1Attempt2)).rejects.toMatchObject({ code: 'PRIVATE_DRAFT_ABANDONED' });
  });

  it('keeps staging idempotency per clientOperationId', async () => {
    const { store } = makeStore();
    const rev1 = {
      workItemId: 'wi-repair',
      leaseEpoch: 1,
      attemptId: 'att-repair',
      authorityBaseRef: ref('authority_base_set', 3) as ReviewDraftBindingV2['authorityBaseRef'],
      grantSpecRef: ref('write_grant_spec', 4) as ReviewDraftBindingV2['grantSpecRef'],
      planRevisionId: 'plan-r1',
      batchOrdinal: 1,
    };
    await store.appendRepairStaging(rev1, {
      clientOperationId: 'patch-1',
      op: 'submit_map_patch',
      body: { expectedStagingDigest: 'a'.repeat(64), operations: [] },
      result: { stagingRoot: 'root-1' },
    });
    const replay = await store.appendRepairStaging(rev1, {
      clientOperationId: 'patch-1',
      op: 'submit_map_patch',
      body: { expectedStagingDigest: 'a'.repeat(64), operations: [] },
      result: { stagingRoot: 'root-1' },
    });
    expect(replay.status).toBe('replayed');
  });
});

describe('AuthoritativeReviewPrivateStore privacy boundary', () => {
  it('private journals are never publicly visible by directory scan', async () => {
    const { paths, taskId, store } = makeStore();
    await store.appendReviewDraft(binding(), {
      clientOperationId: 'op-1',
      op: 'submit_slot_review',
      body: { targetId: 's-1', verdict: 'pass' },
      result: { accepted: true },
    });
    // The blob directory is the ONLY public v2 object surface; a directory
    // scan must never reveal the private journal or its parent 'private'.
    const blobsRoot = paths.taskStructuredV2BlobsRoot(taskId);
    const blobsEntries = existsSync(blobsRoot) ? readdirSync(blobsRoot) : [];
    expect(blobsEntries).not.toContain('private');
    expect(blobsEntries).not.toContain('review');
    // And the journal lives under structured-slots/v2/private/, which is not a
    // registered blob kind and not under blobs/ at all.
    const v2Root = paths.taskStructuredV2Root(taskId);
    const entries = readdirSync(v2Root);
    expect(entries).toContain('private');
    expect(entries).not.toContain('review');
    expect(entries).not.toContain('wi-1');
    const privateRoot = paths.taskStructuredV2PrivateRoot(taskId);
    const privateEntries = readdirSync(privateRoot);
    expect(privateEntries).toEqual(['review']);
    rmSync(privateRoot, { recursive: true, force: true });
  });
});
