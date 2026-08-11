// @vitest-environment node
/**
 * Projection cost separation measurement (Task 19 remediation Task A).
 *
 * Locks the FAILURE REGRESSION shape before any production change: the
 * integrated `authorized-projection-500-issues` benchmark case mixes three
 * distinct costs — (1) cold-start projection-service build, (2) generation-index
 * re-reads, (3) full content-blob hydration — into the measurement of the PURE
 * `projectStructuredVerdict` operation (~0.22 ms). This harness separates them:
 *
 * - PURE: a 500-issue `StructuredVerdictV1` projected with full visibility,
 *   warmup + samples; asserts the p95 stays small (the pure operation is
 *   ~0.2 ms) — far below the integrated case's observed ~316 ms. Task D can
 *   rely on this separation.
 * - COLD vs HOT: a real generation (301 slots) committed through the blob
 *   store, then the FIRST `task_owner` outline read (cold: projection build +
 *   one-time index read + presence root read + per-slot NDJSON opens) vs the
 *   SECOND read (hot: cached state/index/presence reused). Asserts the warm
 *   call is strictly cheaper than the cold call — the caching/separation is
 *   the lever — WITHOUT gating on absolute values (they change with Task C).
 *   The outline never hydrates content blobs (Task C N+1 fix).
 *
 * All measurements are emitted as machine-readable
 * `{event:'projection-probe', phase:'pure'|'cold'|'hot', wallMs}` lines so the
 * values can be compared against the integrated case in reports.
 *
 * This is a test-only harness; it changes no production behavior.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { JsonObject, StructuredVerdictV1 } from '../../../shared/structured-slots';
import type { FrozenStructuredSlotContractV1 } from '../../template/structured-slot-contract';
import type { CommittedEvent } from '../../storage/event-store';
import { EventStore } from '../../storage/event-store';
import { CorePaths } from '../../storage/core-paths';
import { StructuredSlotBlobStore } from '../../storage/structured-slot-blob-store';
import { ALL_LOCATION_KINDS, makeStructuredIssue, projectStructuredVerdict } from '../../structured-slots/issues';
import {
  createTaskLocalCursorSigner,
  StructuredSlotProjectionService,
} from './projection-service';
import { createStructuredSlotDataSource } from './session-service';

const SLOT_COUNT = 300;
const CONTENT_BYTES_PER_SLOT = 16 * 1024;
/** Owner outline is root + SLOT_COUNT children; the page limit covers all. */
const OWNER_LIMIT = SLOT_COUNT + 1;

function probe(phase: 'pure' | 'cold' | 'hot', wallMs: number): void {
  process.stdout.write(
    `${JSON.stringify({ event: 'projection-probe', phase, wallMs: Math.round(wallMs * 100) / 100 })}\n`,
  );
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/** Minimal frozen contract — the task_owner projection never reads the contract. */
function minimalContract(): FrozenStructuredSlotContractV1 {
  return {
    version: 1,
    slotTypes: [],
    layoutGrammar: {} as never,
    accessProfiles: [],
    validators: [],
    assembler: {
      id: 'asm',
      implementation: { abi: 'forge-assembler/v1', path: 'slots/assembler/a.cjs' },
      budget: { cpuMs: 100, timeoutMs: 500, memoryMiB: 64 },
      routes: [],
    },
    limits: {} as never,
    resourceManifest: [],
    abiProfileIdentity: {
      validatorAbi: 'forge-validator/v1',
      assemblerAbi: 'forge-assembler/v1',
      profileIdentity: 'forge-structured-runtime/v1',
    },
    semanticDigest: 'test',
  };
}

/** A 500-issue verdict over the two v1 projection-friendly codes. */
function buildFiveHundredIssueVerdict(): StructuredVerdictV1 {
  const issues = Array.from({ length: 500 }, (_, i) =>
    makeStructuredIssue(
      i % 2 === 0 ? 'CONTENT_REQUIRED' : 'SLOT_NOT_VISIBLE',
      i % 2 === 0 ? 'seal_input' : 'merge',
      i % 2 === 0
        ? { kind: 'slot', slotId: `bench-${i}`, field: 'content', valuePointer: '' }
        : { kind: 'operation' },
      {},
    ),
  );
  return {
    version: 1,
    status: 'failed',
    issues,
    truncated: false,
    summary: { errors: 250, warnings: 250 },
  };
}

describe('projection cost separation (Task 19 remediation Task A)', () => {
  it('PURE 500-issue verdict projection p95 is small and far below the integrated ~300 ms case', () => {
    const verdict = buildFiveHundredIssueVerdict();
    // Warmup (discarded) so lazy/JIT costs are not in the samples.
    for (let i = 0; i < 3; i += 1) {
      projectStructuredVerdict(verdict, { visibleLocationKinds: ALL_LOCATION_KINDS });
    }
    const samples: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const started = performance.now();
      const projected = projectStructuredVerdict(verdict, { visibleLocationKinds: ALL_LOCATION_KINDS });
      if (projected.issues.length !== 500) throw new Error('PROJECTION_PURE_FAILED: issue count changed');
      samples.push(performance.now() - started);
    }
    const p95Ms = percentile([...samples].sort((a, b) => a - b), 95);
    probe('pure', p95Ms);
    // Generous bound (pure op is ~0.2 ms) — locks the separation for Task D.
    expect(p95Ms).toBeLessThan(100);
    // Concretely "orders of magnitude below the integrated ~300 ms case"
    // (at least 10x): the pure op is ~0.2 ms so this cannot flake.
    expect(p95Ms).toBeLessThan(30);
  });

  it('a warm task_owner outline is strictly cheaper than the cold first projection', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'forge-projection-bench-'));
    try {
      const paths = CorePaths.create({ dataRoot: tempRoot, templateRoot: join(tempRoot, 'templates') });
      const taskId = 'projection-bench-task';
      const blobStore = new StructuredSlotBlobStore(paths, taskId);
      const events = new EventStore(paths);

      // Root + SLOT_COUNT filled children (mirrors the integrated bench scaffold:
      // the generation records stay `unset`, the content lives in content blobs).
      const slots: Array<{
        slotId: string;
        parentSlotId: string | null;
        order: number;
        typeId: string;
        spec: JsonObject;
        contentPresence: 'unset' | 'set';
        content?: string;
      }> = [{ slotId: 'root', parentSlotId: null, order: 0, typeId: 'document', spec: {}, contentPresence: 'unset' }];
      for (let i = 0; i < SLOT_COUNT; i += 1) {
        slots.push({
          slotId: `n${i}`,
          parentSlotId: 'root',
          order: i + 1,
          typeId: 'node',
          spec: {},
          contentPresence: 'set',
          content: `c${i}:` + 'x'.repeat(CONTENT_BYTES_PER_SLOT),
        });
      }
      const generationManifest = await blobStore.putGeneration({
        generationId: 'gen-1',
        scaffoldId: 'scaffold-1',
        slots: slots.map((slot) => ({
          slotId: slot.slotId,
          scaffoldId: 'scaffold-1',
          parentSlotId: slot.parentSlotId,
          order: slot.order,
          typeId: slot.typeId,
          spec: slot.spec,
          contentPresence: 'unset',
        })),
      });
      const mappings: Record<string, 'unset' | string> = {};
      for (const slot of slots) {
        if (slot.contentPresence === 'set') {
          const blob = await blobStore.putContentValue(slot.content);
          mappings[slot.slotId] = blob.sha256;
        } else {
          mappings[slot.slotId] = 'unset';
        }
      }
      const contentRef = await blobStore.putContentRevision(mappings);
      await events.append(taskId, {
        id: 'gen-committed',
        at: new Date().toISOString(),
        type: 'structured_scaffold_generation_committed',
        scaffoldId: 'scaffold-1',
        generationId: 'gen-1',
        supersedesGenerationId: null,
        rootSlotId: 'root',
        slotCount: slots.length,
        maxDepth: 1,
        structure: generationManifest.structure,
        content: contentRef,
        contentRevision: 0,
        proposalId: 'p-1',
      });

      const committed: readonly CommittedEvent[] = await events.read(taskId);

      // Warm the NDJSON file pages before any measurement so the cold-vs-hot
      // delta isolates the ONE-TIME projection costs (event-state projection,
      // presence-root read, projection-path JIT compile) instead of page-cache
      // eviction noise on the 301 NDJSON opens. This also populates the blob
      // store's generation-index cache, exactly as a prior read would.
      await blobStore.readGenerationSlots('gen-1');

      const source = createStructuredSlotDataSource({
        blobStore,
        events: async () => committed.map((entry) => entry.event),
      });
      const projection = new StructuredSlotProjectionService({
        contract: minimalContract(),
        source,
        signer: createTaskLocalCursorSigner(taskId),
      });
      const subject = { kind: 'task_owner' } as const;

      // COLD: the first outline read performs the one-time reads the data
      // source caches (event-state projection, content-revision presence root)
      // plus the projection-path JIT compile. The outline itself never hydrates
      // content blobs (Task C N+1 fix).
      const startedCold = performance.now();
      const cold = await projection.listSlots(subject, null, OWNER_LIMIT);
      const coldMs = performance.now() - startedCold;
      expect(cold.ok).toBe(true);
      if (cold.ok) {
        expect(cold.entries).toHaveLength(SLOT_COUNT + 1);
        expect(cold.entries.every((entry) => !entry.shell)).toBe(true);
      }

      // HOT: subsequent reads reuse the cached state/index/presence; take the
      // MIN over several samples so GC/monitor noise cannot hide the caching
      // lever (more samples also absorb page-cache eviction windows under load).
      const hotSamples: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const started = performance.now();
        const hot = await projection.listSlots(subject, null, OWNER_LIMIT);
        expect(hot.ok).toBe(true);
        if (hot.ok) expect(hot.entries).toHaveLength(SLOT_COUNT + 1);
        hotSamples.push(performance.now() - started);
      }
      const hotMs = Math.min(...hotSamples);
      probe('cold', coldMs);
      probe('hot', hotMs);
      // The warm call must be strictly cheaper than the cold call: the only
      // difference is the one-time cold costs the cache removes. This locks
      // the separation without gating on absolute values.
      expect(hotMs).toBeLessThan(coldMs);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
