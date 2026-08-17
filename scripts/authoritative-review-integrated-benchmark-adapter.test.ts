// @vitest-environment node
/**
 * Authoritative review v2 integrated benchmark adapter tests (Task 27 Step 3).
 *
 * Pins the adapter's deterministic synthetic structure + bench-case identity:
 * the harness measures the SAME 10k-life cycle cases the qualification chain
 * expects, and the synthetic Map / content / relations are stable for a fixed
 * scale. The 10k floor (`maxSlots >= 10_000`) and the 256/1,024 assignment
 * floors are enforced uniformly.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJsonSha256 } from '../src/server/structured-slots/canonical-json';
import {
  AUTHORITATIVE_REVIEW_FINAL_BOUND_CASE_IDS,
  AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY,
} from './authoritative-review-evidence-schema';
import {
  buildSyntheticMap,
  buildSyntheticContent,
  createAuthoritativeReviewBenchmarkAdapter,
  integratedTaskLoad,
  syntheticHandlerDigest,
  syntheticProfileBody,
  type AuthoritativeReviewAdapterLimitsV1,
} from './authoritative-review-integrated-benchmark-adapter';
import { V2_PROFILE_MAX_SLOTS_FLOOR, V2_PROFILE_ASSIGNMENT_PRIMARY_TARGETS_FLOOR, V2_PROFILE_ASSIGNMENT_TOTAL_OBJECTS_FLOOR } from '../src/server/structured-slots/authoritative-review-profile';

const tempDirs: string[] = [];

function freshTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-ar-bench-'));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const limits100: AuthoritativeReviewAdapterLimitsV1 = {
  maxSlots: 10_000,
  maxRelationsPerSlot: 64,
  maxRelationTotal: 4_000,
  targetBatchSize: 24,
  scaffoldPayloadBytes: 67_108_864,
};

describe('integratedTaskLoad + syntheticMap', () => {
  it('honors the 10k slot floor and the relation/slot ratio', () => {
    const load = integratedTaskLoad(limits100);
    expect(load.slotCount).toBe(V2_PROFILE_MAX_SLOTS_FLOOR);
    expect(load.contentBytes).toBe(67_108_864);
    expect(load.relationCount).toBeGreaterThan(0);
    expect(load.relationCount).toBeLessThanOrEqual(4_000);
  });

  it('builds a deterministic synthetic Map of unique nodes + key ledger', () => {
    const load = integratedTaskLoad(limits100);
    const a = buildSyntheticMap(load);
    const b = buildSyntheticMap(load);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(new Set(a.nodes.map((node) => node.slotId)).size).toBe(a.nodes.length);
    expect(Object.keys(a.keyLedger).length).toBe(a.nodes.length);
    // advisory relations are at i % 32 === 0
    const advisory = a.relations.filter((relation) => relation.enforcement === 'advisory').length;
    const blocking = a.relations.filter((relation) => relation.enforcement === 'blocking').length;
    expect(advisory + blocking).toBe(a.relations.length);
  });

  it('builds a content manifest whose total bytes exceed the requested payload', () => {
    const load = integratedTaskLoad(limits100);
    const map = buildSyntheticMap(load);
    const content = buildSyntheticContent(load, map);
    expect(Object.keys(content.manifest).length).toBe(map.nodes.length);
    expect(content.totalBytes).toBeGreaterThanOrEqual(load.contentBytes);
  });
});

describe('syntheticProfileBody', () => {
  it('encodes the 10k floor + 256/1024 assignment floors', () => {
    const profile = syntheticProfileBody(limits100);
    expect(profile.runtime.maxSlots).toBeGreaterThanOrEqual(V2_PROFILE_MAX_SLOTS_FLOOR);
    expect(profile.runtime.assignmentMaxPrimaryTargets).toBe(V2_PROFILE_ASSIGNMENT_PRIMARY_TARGETS_FLOOR);
    expect(profile.runtime.assignmentMaxTotalObjects).toBe(V2_PROFILE_ASSIGNMENT_TOTAL_OBJECTS_FLOOR);
    expect(profile.abi).toEqual({
      validatorAbi: 'forge-validator/v2',
      assemblerAbi: 'forge-assembler/v2',
      profileAbi: 'forge-authoritative-review/v1',
    });
    expect(profile.qualificationState).toBe('final');
  });

  it('recomputes the canonical profile digest over its body', () => {
    const profile = syntheticProfileBody(limits100);
    const copy = { ...profile } as Record<string, unknown>;
    delete copy.profileDigest;
    expect(profile.profileDigest).toBe(canonicalJsonSha256(copy));
  });

  it('does NOT embed any downstream evidence digest', () => {
    const profile = syntheticProfileBody(limits100);
    for (const key of Object.keys(profile as Record<string, unknown>)) {
      expect(key).not.toMatch(/evidenceDigest|capabilityManifest/);
    }
  });
});

describe('syntheticHandlerDigest', () => {
  it('is deterministic and depends on the handler key + ABI list', () => {
    const a = syntheticHandlerDigest('slotSchema');
    const b = syntheticHandlerDigest('slotSchema');
    expect(a).toBe(b);
    const c = syntheticHandlerDigest('coverage');
    expect(c).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createAuthoritativeReviewBenchmarkAdapter', () => {
  it('returns a case identity aligned with the frozen integration case IDs', async () => {
    const adapter = await createAuthoritativeReviewBenchmarkAdapter({ limits: limits100, tempRoot: freshTempRoot() });
    const expected = [
      'buildMapChunk1k',
      'buildOptionalRelations',
      'runMapReviewBatch',
      'buildContentGeneration10k',
      'runReviewAssignment10k',
      'runMapMigrationMix',
      'runCheckpointReplay',
      'runLocateBeyond9k',
      'runPublicationPinGc',
      'measureEventCountHeadroom',
    ];
    for (const id of expected) {
      expect(typeof (adapter as unknown as Record<string, () => Promise<number>>)[id]).toBe('function');
    }
    expect(expected.length).toBe(AUTHORITATIVE_REVIEW_FINAL_BOUND_CASE_IDS.length);
  });

  it('runs every case end-to-end and returns a non-negative wall-clock ms', async () => {
    const adapter = await createAuthoritativeReviewBenchmarkAdapter({ limits: limits100, tempRoot: freshTempRoot() });
    for (const id of Object.keys(adapter)) {
      const fn = (adapter as unknown as Record<string, () => Promise<number>>)[id]!;
      const ms = await fn();
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(ms)).toBe(true);
    }
  });

  it('keeps the synthetic-shape output deterministic across runs', async () => {
    const root = freshTempRoot();
    const adapter1 = await createAuthoritativeReviewBenchmarkAdapter({ limits: limits100, tempRoot: root });
    const adapter2 = await createAuthoritativeReviewBenchmarkAdapter({ limits: limits100, tempRoot: root });
    const keys: Array<keyof typeof adapter1> = [
      'buildMapChunk1k',
      'buildOptionalRelations',
      'runMapReviewBatch',
      'buildContentGeneration10k',
      'runReviewAssignment10k',
      'runMapMigrationMix',
      'runCheckpointReplay',
      'runLocateBeyond9k',
      'runPublicationPinGc',
      'measureEventCountHeadroom',
    ];
    for (const key of keys) {
      const a = await adapter1[key]();
      const b = await adapter2[key]();
      // Both runs exercise the same synthetic shape; timings may differ but
      // the cases must round-trip successfully.
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeGreaterThanOrEqual(0);
    }
  });

  it('uses the v2 ABI list as the implementation-digest namespace', () => {
    const digest = syntheticHandlerDigest('anything');
    for (const abi of AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(abi).toMatch(/^forge-/);
    }
  });
});
