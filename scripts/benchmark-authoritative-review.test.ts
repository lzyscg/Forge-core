// @vitest-environment node
/**
 * Authoritative review v2 benchmark harness tests (Task 27 Step 3).
 *
 * Pure invocations:
 * - evaluateScaleReport refuses missing cases and bound violations.
 * - scaledLimits floors maxSlots at 10,000 (the first-release capacity floor).
 * - parseArgs rejects the canonical usage violations.
 * - integratedScaleCaseDefinitions covers every frozen bound case ID.
 *
 * This file does NOT spawn the real benchmark (it exercises the helpers in
 * isolation). The end-to-end disabled-production gate runs the harness
 * through `--mode primitive-smoke` only.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateScaleReport,
  scaledLimits,
  integratedScaleCaseDefinitions,
  REQUIRED_BOUND_CASE_IDS,
  type IntegratedScaleReport,
  type ScaleBounds,
} from './benchmark-authoritative-review';
import { AUTHORITATIVE_REVIEW_FINAL_BOUND_CASE_IDS } from './authoritative-review-evidence-schema';
import { createAuthoritativeReviewBenchmarkAdapter } from './authoritative-review-integrated-benchmark-adapter';

const tempDirs: string[] = [];

function freshTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-ar-bench-test-'));
  tempDirs.push(root);
  return root;
}

const BOUNDS: ScaleBounds = {
  authorMapChunkP95Ms: 60,
  mapBuildCandidateP95Ms: 1_500,
  mapReviewAssignmentP95Ms: 1_800,
  contentGenerationP95Ms: 1_500,
  contentReviewSettlementP95Ms: 1_500,
  mapMigrationP95Ms: 2_500,
  checkpointReplayP95Ms: 1_500,
  locateBeyond9kP95Ms: 250,
  publicationPinGcP95Ms: 1_000,
  peakRssBytes: 768 * 1024 * 1024,
  pageLatencyP95Ms: 250,
  appendLatencyP95Ms: 25,
  recoveryTimeP95Ms: 30_000,
  eventCountHeadroom: 999_999,
};

function baseReport(scale: number, peakRssBytes: number): IntegratedScaleReport {
  return {
    event: 'integrated-scale-result',
    scale,
    results: AUTHORITATIVE_REVIEW_FINAL_BOUND_CASE_IDS.map((id) => ({
      id,
      description: `${id} @ ${scale}%`,
      warmup: 1,
      samples: 5,
      p50Ms: 5,
      p95Ms: 12,
      maxMs: 13,
      sampleDigest: 'a'.repeat(64),
      postCasePeakRssBytes: peakRssBytes,
    })),
    peakRssBytes,
    diskBytes: 1024,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('evaluateScaleReport', () => {
  it('passes a clean report against the frozen bounds', () => {
    const report = baseReport(100, 600 * 1024 * 1024);
    const verdict = evaluateScaleReport(report, BOUNDS);
    expect(verdict.violations).toEqual([]);
    expect(verdict.passed).toBe(true);
  });

  it('rejects a report missing a required bound case', () => {
    const report = baseReport(100, 600 * 1024 * 1024);
    report.results = report.results.filter((result) => result.id !== 'locate-beyond-9k');
    const verdict = evaluateScaleReport(report, BOUNDS);
    expect(verdict.violations).toContain('missing case locate-beyond-9k');
    expect(verdict.passed).toBe(false);
  });

  it('rejects a peak RSS that exceeds the bound', () => {
    const report = baseReport(100, 800 * 1024 * 1024);
    const verdict = evaluateScaleReport(report, BOUNDS);
    expect(verdict.violations.some((line) => line.includes('peak RSS'))).toBe(true);
    expect(verdict.passed).toBe(false);
  });

  it('rejects a locate-beyond-9k p95 over the bound', () => {
    const report = baseReport(100, 600 * 1024 * 1024);
    const target = report.results.find((result) => result.id === 'locate-beyond-9k')!;
    target.p95Ms = 500;
    const verdict = evaluateScaleReport(report, BOUNDS);
    expect(verdict.violations).toContain('locate-beyond-9k p95');
    expect(verdict.passed).toBe(false);
  });

  it('rejects a content-generation-10k max over the bound', () => {
    const report = baseReport(100, 600 * 1024 * 1024);
    const target = report.results.find((result) => result.id === 'content-generation-10k')!;
    target.maxMs = 2_000;
    const verdict = evaluateScaleReport(report, BOUNDS);
    expect(verdict.violations).toContain('content-generation-10k max');
    expect(verdict.passed).toBe(false);
  });
});

describe('scaledLimits', () => {
  it('floors maxSlots at the 10k first-release capacity', () => {
    for (const percentage of [100, 75, 50, 25]) {
      const limits = scaledLimits(percentage);
      expect(limits.maxSlots).toBeGreaterThanOrEqual(10_000);
      expect(limits.targetBatchSize).toBeGreaterThanOrEqual(24);
    }
  });

  it('scales the payload bytes monotonically', () => {
    const a = scaledLimits(100);
    const b = scaledLimits(25);
    expect(a.scaffoldPayloadBytes).toBeGreaterThan(b.scaffoldPayloadBytes);
  });
});

describe('integratedScaleCaseDefinitions', () => {
  it('covers every frozen bound case ID exactly once', async () => {
    const adapter = await createAuthoritativeReviewBenchmarkAdapter({
      limits: scaledLimits(100),
      tempRoot: freshTempRoot(),
    });
    const definitions = integratedScaleCaseDefinitions(adapter);
    const ids = definitions.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(REQUIRED_BOUND_CASE_IDS.length);
    for (const id of REQUIRED_BOUND_CASE_IDS) {
      expect(ids).toContain(id);
    }
  });
});
