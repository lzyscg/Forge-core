// @vitest-environment node
/**
 * Task D regression tests for the integrated benchmark adapter split.
 *
 * The pre-fix `authorized-projection-500-issues` case mixed the cold
 * projection-service build + owner outline + a single slot read into the SAME
 * sample as the PURE 500-issue `projectStructuredVerdict`, so its ~316 ms did
 * NOT measure what the 250 ms `issueProjectionMaxMs` bound targets. Task D
 * splits them:
 *
 * - `runAuthorizedProjection500Issues` is now PURE: build the 500-issue verdict
 *   and project it with full visibility. NO projection-service build and NO
 *   listSlots/readSlot I/O — asserted here by blob-store instrumentation
 *   counters (zero reads/opens) around the call.
 * - `runOwnerOutlineCold` / `runOwnerOutlineHot` are the DIAGNOSTIC owner
 *   outline cases over the real task; cold is the FIRST listSlots (projection
 *   build + index read + presence root + per-slot NDJSON), hot is a SUBSEQUENT
 *   cached one. The cache boundary is pinned by deterministic I/O counters;
 *   wall-clock values remain diagnostics and are not ordered under parallel
 *   test-runner / GC noise.
 *
 * This is a test-only file; it changes no production behavior.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StructuredSlotBlobStoreInstrumentation } from '../src/server/storage/structured-slot-blob-store';
import { CorePaths } from '../src/server/storage/core-paths';
import type { StructuredSlotLimitsV1 } from '../src/shared/structured-slots';
import { scaledLimits } from './benchmark-structured-slots';
import { createIntegratedBenchmarkAdapter } from './structured-integrated-benchmark-adapter';

/** A small but real scaled limits object (fast: 96 filled slots, 1 MiB root). */
function smallLimits(): StructuredSlotLimitsV1 {
  const base = scaledLimits(25);
  return {
    ...base,
    structure: { ...base.structure, maxSlots: 96 },
    payload: { ...base.payload, maxScaffoldPayloadBytes: 1024 * 1024 },
  };
}

interface Counters {
  blobReads: number;
  indexReads: number;
  slotsOpens: number;
  contentRootReads: number;
}

function makeCounters(): { counters: Counters; instrumentation: StructuredSlotBlobStoreInstrumentation } {
  const counters: Counters = { blobReads: 0, indexReads: 0, slotsOpens: 0, contentRootReads: 0 };
  const instrumentation: StructuredSlotBlobStoreInstrumentation = {
    onBlobRead: () => {
      counters.blobReads += 1;
    },
    onIndexRead: () => {
      counters.indexReads += 1;
    },
    onSlotsFileOpen: () => {
      counters.slotsOpens += 1;
    },
    onContentRootRead: () => {
      counters.contentRootReads += 1;
    },
  };
  return { counters, instrumentation };
}

describe('integrated benchmark adapter Task D split', () => {
  it('runAuthorizedProjection500Issues is PURE: zero blob/index/slot/content-root reads', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'forge-integrated-adapter-test-'));
    try {
      const paths = CorePaths.create({ dataRoot: tempRoot, templateRoot: join(tempRoot, 'templates') });
      const { counters, instrumentation } = makeCounters();
      const adapter = await createIntegratedBenchmarkAdapter({
        paths,
        taskId: 'adapter-pure-test',
        limits: smallLimits(),
        instrumentation,
      });
      // The bench-task build (setup) touches the store; reset so only the case
      // under test is measured.
      counters.blobReads = 0;
      counters.indexReads = 0;
      counters.slotsOpens = 0;
      counters.contentRootReads = 0;

      const wallMs = await adapter.runAuthorizedProjection500Issues();

      // The pure verdict projection performs NO projection-service build and NO
      // listSlots/readSlot I/O — it only canonicalizes the 500-issue verdict.
      expect(counters.blobReads).toBe(0);
      expect(counters.indexReads).toBe(0);
      expect(counters.slotsOpens).toBe(0);
      expect(counters.contentRootReads).toBe(0);
      // Sanity: the pure projection is fast (the pre-fix mixed case was ~316 ms
      // at 25%); generous bound so this never flakes.
      expect(wallMs).toBeLessThan(100);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('a warm owner outline reuses the cold projection index and presence caches (diagnostics)', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'forge-integrated-adapter-test-'));
    try {
      const paths = CorePaths.create({ dataRoot: tempRoot, templateRoot: join(tempRoot, 'templates') });
      const { counters, instrumentation } = makeCounters();
      const adapter = await createIntegratedBenchmarkAdapter({
        paths,
        taskId: 'adapter-outline-test',
        limits: smallLimits(),
        instrumentation,
      });
      counters.blobReads = 0;
      counters.indexReads = 0;
      counters.slotsOpens = 0;
      counters.contentRootReads = 0;

      const coldMs = await adapter.runOwnerOutlineCold();
      expect(coldMs).toBeGreaterThanOrEqual(0);

      // The cold FIRST outline does the real one-time projection work: one
      // generation-index read + parse and one content-root read, and per-slot
      // NDJSON opens — but ZERO content-blob hydrations (Task C N+1 fix).
      expect(counters.indexReads).toBeGreaterThan(0);
      expect(counters.contentRootReads).toBeGreaterThan(0);
      expect(counters.slotsOpens).toBeGreaterThan(0);
      expect(counters.blobReads).toBe(0);

      const coldIndexReads = counters.indexReads;
      const coldContentRootReads = counters.contentRootReads;

      // Hot samples reuse the cached projection service, data source,
      // generation index and presence root. Wall time is diagnostic only:
      // under full-suite parallel load a cached call may still be slower due
      // to scheduling or GC. The load-bearing regression lock is that no hot
      // call performs another index or content-root read.
      for (let i = 0; i < 3; i += 1) {
        expect(await adapter.runOwnerOutlineHot()).toBeGreaterThanOrEqual(0);
      }
      // The cached index/presence means the hot path performs no re-reads.
      expect(counters.indexReads).toBe(coldIndexReads);
      expect(counters.contentRootReads).toBe(coldContentRootReads);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
