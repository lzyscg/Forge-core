// @vitest-environment node
/**
 * Task 23 projection-service performance bench (spec §19.1/§19.2, plan Task
 * 23 Step 4).
 *
 * Proves the two invariants of a SINGLE page read (they must NOT scale with
 * the full tree):
 * - the number of blob reads is bounded (a tree page touches exactly the
 *   frozen map snapshot, never one blob per slot and never a recursive walk);
 * - the serialized working-set of one page is O(limit), independent of the
 *   whole-tree size.
 *
 * Plus an installation-persistence check for the cursor keyring (spec §14.2):
 * a reopened keyring loads the SAME signer key — the signer is never minted
 * per process. These run as assertions (no wall-clock timing) so CI stays
 * deterministic.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewCursorKeyring } from '../../storage/review-cursor-keyring';
import { makeTempCorePaths, disposeAllTestRoots } from '../../test-support';
import { makeBenchHarness } from './projection-service.test';

afterEach(() => {
  disposeAllTestRoots();
});

describe('projection single-page performance bounds', () => {
  it('keeps a tree page to one blob read independent of tree size', async () => {
    const blobsPerSize: number[] = [];
    for (const count of [100, 1_000, 10_000]) {
      const { service, blobs } = await makeBenchHarness(count);
      blobs.reads.length = 0;
      const page = await service.tree('task-bench', 'root', 50, null);
      blobsPerSize.push(blobs.reads.length);
      expect(blobs.reads.length).toBe(1); // exactly the frozen map snapshot
      const bytes = Buffer.byteLength(JSON.stringify(page.items));
      expect(bytes).toBeLessThan(50 * 1024); // O(limit), tree-independent RSS
      expect(page.items.length).toBe(50);
    }
    // Working-set (blob reads) is IDENTICAL regardless of the whole-tree size.
    expect(new Set(blobsPerSize).size).toBe(1);
  });

  it('is bounded for pages offset far into a 10,000-slot tree at the max limit', async () => {
    const { service, blobs } = await makeBenchHarness(10_000);
    let cursor: import('../../../shared/authoritative-review-v2').SnapshotCursorV2 | null = null;
    let hops = 0;
    for (;;) {
      blobs.reads.length = 0;
      const next = await service.tree('task-bench', 'root', 500, cursor);
      expect(blobs.reads.length).toBe(1);
      expect(next.items.length).toBe(500);
      hops += 1;
      cursor = next.nextCursor;
      if (cursor === null) break;
      // Guard against an infinite loop if hasMore were buggy.
      expect(hops).toBeLessThan(100);
    }
    // 10,000 / 500 = 20 pages, every one reading exactly one blob.
    expect(hops).toBe(20);
  });

  it('loads an installation-persistent cursor signer across reopens (never minted per process)', async () => {
    const { paths } = makeTempCorePaths();
    const keyring = new ReviewCursorKeyring(paths);
    await keyring.initialize();
    const keyId = keyring.activeKeyId();
    const reopened = new ReviewCursorKeyring(paths);
    await reopened.initialize();
    // A fresh keyring over the same durable files loads the SAME key id.
    expect(reopened.activeKeyId()).toBe(keyId);
    const payload = '{"x":1}';
    const { signature } = reopened.sign(payload);
    expect(keyring.verify(payload, signature, keyId)).toBe('valid');
  });
});
