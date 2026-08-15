import { describe, expect, it } from 'vitest';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { refOfBlob } from '../../authoritative-review/object-registry';
import {
  buildMigrationSettlement,
  migrationExecutionDigest,
  nextMissingMigrationBatchOrdinal,
  partitionMigrationValidationBatches,
  validateMigrationBatchClosure,
} from './migration-service';

describe('Task 20 10,000-slot deterministic migration', () => {
  it('restarts from first missing ordinal and equals uninterrupted execution', () => {
    const slots = Array.from({ length: 10_000 }, (_, i) => `slot-${String(i).padStart(5, '0')}`);
    const batches = partitionMigrationValidationBatches(slots, 64);
    expect(batches).toHaveLength(157);
    expect(batches.every((batch) => batch.length <= 64)).toBe(true);

    const resultOf = (ordinal: number) => ({
      batchOrdinal: ordinal,
      batchResultRootRef: refOfBlob('migration_validation_batch_result', {
        ordinal,
        slots: batches[ordinal],
        // A deterministic minority takes non-equivalence paths.
        classifications: batches[ordinal].map((slotId, offset) =>
          (ordinal * 64 + offset) % 97 === 0 ? 'fresh' : (ordinal * 64 + offset) % 211 === 0 ? 'rewrite' : 'equivalent',
        ),
      }),
    });
    const uninterrupted = batches.map((_, ordinal) => resultOf(ordinal));

    const checkpoint = uninterrupted.slice(0, 73);
    expect(nextMissingMigrationBatchOrdinal({ orderedBatchSlotIds: batches }, checkpoint)).toBe(73);
    const resumed = [...checkpoint, ...batches.slice(73).map((_, index) => resultOf(73 + index))];
    expect(validateMigrationBatchClosure({ orderedBatchSlotIds: batches }, resumed)).toEqual(
      validateMigrationBatchClosure({ orderedBatchSlotIds: batches }, uninterrupted),
    );

    const shared = {
      migrationIntentCoreRef: refOfBlob('migration_intent_core', { digest: canonicalJsonSha256({ slots }) }),
      migrationValidationPlanSpecRef: refOfBlob('migration_validation_plan_spec', { batches }),
      decisions: [], batchClassifiedFindingSetRef: null, batchRouteOutcome: 'clear' as const,
    };
    const directSettlement = buildMigrationSettlement({ ...shared, orderedBatches: uninterrupted });
    const resumedSettlement = buildMigrationSettlement({ ...shared, orderedBatches: resumed });
    expect(migrationExecutionDigest(directSettlement)).toBe(migrationExecutionDigest(resumedSettlement));
    expect(resumedSettlement).toEqual(directSettlement);
  });
});
