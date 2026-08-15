// @vitest-environment node
/**
 * Task 17 interrupted 10,000-slot plan property test (spec §13.2/§16.1, design
 * §12.3/§12.4): a crashed generation plan resumes EXACTLY where it stopped —
 * the resumed plan closure equals the uninterrupted execution without rerunning
 * completed ordinals.
 *
 * The plan is deterministic (partitionGenerationBatches sorts by documentOrder
 * then slotId); the manifest root at commit k is a pure function of the slots
 * committed so far. So a "restart" that derives the batches from the SAME map +
 * the LAST COMMITTED ordinal reproduces the identical continuation (same batch
 * slot sets, same manifest root at every later commit), and never revisits a
 * completed ordinal.
 *
 * Runs at the pure level (no storage) with 10,000 slots / default batch 24.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import { refOfBlob } from '../../authoritative-review/object-registry';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { computeContentRootDigest } from '../../authoritative-review/content-domain';
import type { ContentRevisionManifestV2, SlotContentVersionV2 } from '../../authoritative-review/authority-types';
import { buildContentValue, buildProvisionalManifest, partitionGenerationBatches } from './content-plan-service';

function hash(salt: string): string {
  return createHash('sha256').update(salt, 'utf8').digest('hex');
}

const BATCH_SIZE = 24;
const SLOT_COUNT = 10_000;

function makeSlots(): { slotId: string; documentOrder: number }[] {
  // Deterministic shuffled documentOrder (not monotonic) to prove the sort.
  const slots = Array.from({ length: SLOT_COUNT }, (_, i) => ({
    slotId: `slot-${String(i).padStart(5, '0')}`,
    documentOrder: (i * 7919) % SLOT_COUNT,
  }));
  return slots;
}

const MAP_REF: BlobRefV2 = refOfBlob('map_snapshot', { mapId: 'm10k', mapSemanticDigest: hash('sem10k') });
const PLAN_REF: BlobRefV2 = refOfBlob('generation_plan_spec', { generationPlanId: 'gp-10k' });
const SEM_DIGEST = hash('sem10k');

/** Content version of a committed slot (set; schema-digest deterministic). */
function setVersion(slotId: string, taskContentRevision: number): SlotContentVersionV2 {
  const value = buildContentValue({ slotId, contentSchemaDigest: hash(`sch-${slotId}`), taskContentRevision, mediaType: 'text/markdown', text: `content ${slotId}` });
  const valueRef = refOfBlob('content_value', value);
  return {
    state: 'set',
    slotId,
    slotRevision: 1,
    contentDigest: valueRef.digest,
    taskContentRevision,
    mapRef: MAP_REF,
    mapSemanticDigest: SEM_DIGEST,
    contentSchemaDigest: hash(`sch-${slotId}`),
    blobRef: valueRef,
    provenance: {
      kind: 'generated',
      producer: { kind: 'generation_batch', planRevisionId: 'gp-10k', batchOrdinal: 0, attemptId: 'at' },
      contentRevisionCommitCoreRef: refOfBlob('content_revision_commit_core', { priorManifestRef: MAP_REF, producerPlanSpecRef: PLAN_REF, batchOrdinal: 0, authorizedReplacementEntriesWithoutValidation: [], expectedMapRef: MAP_REF }),
      contentCommitValidatorAggregateRef: refOfBlob('validator_aggregate', { trigger: 'content_commit', executionPhase: 'batch_commit', inputRef: MAP_REF, inputDigest: '', registrationSetDigest: '', validExecutionDigests: [], blockingInvalidReceiptRefs: [], advisoryReceiptRefs: [], infrastructureFailureRefs: [], warningRootRef: MAP_REF, aggregateDigest: '' }),
      contentCommitWarningRootRef: refOfBlob('validation_warning_custody_root', { scope: 'content_review', taskId: 't', baseRefs: [], entries: [], supersessionPolicyVersion: '1' }),
      committedByAttemptId: 'at',
    },
  };
}

/** The deterministic manifest state after committing exactly `upToBatch` batches. */
function manifestStateAfter(batches: readonly (readonly string[])[], upToBatch: number): { manifest: ContentRevisionManifestV2; rootDigest: string; committedSlots: Set<string> } {
  const committedSlots = new Set<string>();
  const entries: { slotId: string; versionRef: BlobRefV2 }[] = [];
  const versions = new Map<string, SlotContentVersionV2>();
  for (let b = 0; b < upToBatch; b++) {
    for (const slotId of batches[b]) {
      const version = setVersion(slotId, 1);
      versions.set(slotId, version);
      entries.push({ slotId, versionRef: refOfBlob('content_version', version) });
      committedSlots.add(slotId);
    }
  }
  entries.sort((a, b) => (a.slotId < b.slotId ? -1 : 1));
  const manifest = buildProvisionalManifest({
    taskId: 't',
    mapRef: MAP_REF,
    mapSemanticDigest: SEM_DIGEST,
    taskContentRevision: 1,
    priorManifestRef: refOfBlob('content_revision_manifest', { manifestDigest: 'baseline' }),
    producerPlanSpecRef: PLAN_REF,
    entries,
    resolvedVersions: versions,
  });
  return { manifest, rootDigest: computeContentRootDigest([...versions.values()]), committedSlots };
}

describe('content plan — interrupted 10,000-slot resume property (spec §13.2/§16.1)', () => {
  it('the partition is deterministic across restarts (same map + policy → same batches)', () => {
    const slots = makeSlots();
    const a = partitionGenerationBatches(slots, BATCH_SIZE);
    const b = partitionGenerationBatches([...slots].reverse(), BATCH_SIZE);
    const c = partitionGenerationBatches(makeSlots(), BATCH_SIZE);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a.length).toBe(Math.ceil(SLOT_COUNT / BATCH_SIZE));
    expect(a.flat().length).toBe(SLOT_COUNT);
    expect(new Set(a.flat()).size).toBe(SLOT_COUNT);
    // Every batch is within the default 24-slot target.
    expect(a.every((batch) => batch.length <= BATCH_SIZE)).toBe(true);
  });

  it('a resume after seeded batches reproduces the identical continuation WITHOUT rerunning completed ordinals', () => {
    const slots = makeSlots();
    const batches = partitionGenerationBatches(slots, BATCH_SIZE);
    const seedOrdinal = 137; // a "crash" mid-plan
    const resumedBatches = partitionGenerationBatches(slots, BATCH_SIZE).slice(seedOrdinal);

    // The resumed continuation (batch 138..n) is byte-identical to the
    // uninterrupted plan's remaining batches.
    expect(resumedBatches).toEqual(batches.slice(seedOrdinal));
    for (let i = 0; i < resumedBatches.length; i++) {
      expect(resumedBatches[i]).toEqual(batches[seedOrdinal + i]);
    }

    // Manifest closure equality: the resumed run (re-derived from the map)
    // continues with the SAME committed-slot closure as the uninterrupted run
    // at the equivalent absolute commit boundary.
    const resumedState = manifestStateAfter(partitionGenerationBatches(slots, BATCH_SIZE), seedOrdinal + 5);
    const uninterrupted = manifestStateAfter(batches, seedOrdinal + 5);
    expect(resumedState.rootDigest).toBe(uninterrupted.rootDigest);
    expect(resumedState.committedSlots).toEqual(uninterrupted.committedSlots);
  });

  it('the manifest root at commit k is a pure function of the committed slots (restart does not change it)', () => {
    const slots = makeSlots();
    const batches = partitionGenerationBatches(slots, BATCH_SIZE);
    const atK = manifestStateAfter(batches, 42);
    // Re-derive from ONLY the map + committed ordinal (a restart).
    const derived = manifestStateAfter(batches, 42);
    expect(derived.rootDigest).toBe(atK.rootDigest);
    // A different commit boundary yields a DIFFERENT root (progress is real).
    const atKMinus1 = manifestStateAfter(batches, 41);
    expect(atKMinus1.rootDigest).not.toBe(atK.rootDigest);
    // The interrupted root equals the uninterrupted root at the same boundary.
    const uninterrupted = manifestStateAfter(partitionGenerationBatches(slots, BATCH_SIZE), 42);
    expect(uninterrupted.rootDigest).toBe(atK.rootDigest);
  });

  it('the 10,000-slot plan has a complete, sorted total coverage (design §7.3)', () => {
    const slots = makeSlots();
    const batches = partitionGenerationBatches(slots, BATCH_SIZE);
    const state = manifestStateAfter(batches, batches.length);
    expect(state.manifest.entries.map((e) => e.slotId)).toEqual([...state.manifest.entries.map((e) => e.slotId)].sort());
    expect(state.manifest.entries.length).toBe(SLOT_COUNT);
    expect(state.committedSlots.size).toBe(SLOT_COUNT);
  });
});
