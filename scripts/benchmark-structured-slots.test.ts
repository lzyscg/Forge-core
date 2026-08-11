/**
 * Patch A regression tests for the Task 19 structured slot benchmark
 * (Codex independent-acceptance findings P1-1, P1-2, P2).
 *
 * - P1-1 (a): pure per-scale verdict isolation — one scale's huge peak can
 *   never leak into a later scale's verdict (`evaluateScaleReport`).
 * - P1-1 (b): subprocess isolation — two children spawned sequentially report
 *   their OWN peak RSS (the second is far below the first).
 * - P1-2: exactly ONE scaling boundary — the built bench task carries the
 *   scaled `maxSlots` / `maxScaffoldPayloadBytes` verbatim (no double scale).
 * - P2: the exact evidence schema validator accepts the real shapes and rejects
 *   unknown fields / malformed digests.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateScaleReport,
  integratedScaleCaseDefinitions,
  scaledLimits,
  REQUIRED_DIAGNOSTIC_CASE_IDS,
  type IntegratedBenchmarkCasesV1,
  type IntegratedScaleReport,
  type ScaleBounds,
} from './benchmark-structured-slots';
import {
  buildBenchTask,
  integratedTaskLoad,
} from './structured-integrated-benchmark-adapter';
import {
  validateProfileEvidence,
  validateProfileEvidenceFailure,
} from './structured-evidence-schema';
import { CorePaths } from '../src/server/storage/core-paths';
import type { StructuredSlotLimitsV1 } from '../src/shared/structured-slots';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

/* -------------------------------------------------------------------------- */
/* Shared fixtures                                                            */
/* -------------------------------------------------------------------------- */

/** The frozen Task 19 acceptance bounds (spec §16.3). */
const BOUNDS: ScaleBounds = {
  indexedSlotP95Ms: 25,
  treeMatch10kMaxMs: 2000,
  contentRootMaxMs: 2000,
  draftMaxMs: 2000,
  issueProjectionMaxMs: 250,
  sealMaxMs: 30000,
  peakRssBytes: 512 * 1024 * 1024,
};

/** A results array whose timings all satisfy the bounds (incl. diagnostics). */
function passingResults(scale: number): IntegratedScaleReport['results'] {
  return [
    { id: 'owner-outline-cold', description: '', warmup: 0, samples: 1, p50Ms: 20, p95Ms: 20, maxMs: 20, sampleDigest: 'a'.repeat(64), rawSamples: [], diskBytes: 0, postCasePeakRssBytes: 100 * 1024 * 1024 },
    { id: 'owner-outline-hot', description: '', warmup: 1, samples: 5, p50Ms: 8, p95Ms: 10, maxMs: 12, sampleDigest: 'b'.repeat(64), rawSamples: [], diskBytes: 0, postCasePeakRssBytes: 100 * 1024 * 1024 },
    { id: 'indexed-slot-read', description: '', warmup: 3, samples: 10, p50Ms: 1, p95Ms: 2, maxMs: 3, sampleDigest: 'c'.repeat(64), rawSamples: [], diskBytes: 0, postCasePeakRssBytes: 100 * 1024 * 1024 },
    { id: 'tree-match-10k', description: '', warmup: 1, samples: 5, p50Ms: 10, p95Ms: 15, maxMs: 20, sampleDigest: 'd'.repeat(64), rawSamples: [], diskBytes: 0, postCasePeakRssBytes: 100 * 1024 * 1024 },
    { id: 'content-root-64mib', description: '', warmup: 1, samples: 3, p50Ms: 100, p95Ms: 200, maxMs: 300, sampleDigest: 'e'.repeat(64), rawSamples: [], diskBytes: 0, postCasePeakRssBytes: 100 * 1024 * 1024 },
    { id: 'draft-journal-2k', description: '', warmup: 1, samples: 5, p50Ms: 1, p95Ms: 2, maxMs: 3, sampleDigest: 'f'.repeat(64), rawSamples: [], diskBytes: 0, postCasePeakRssBytes: 100 * 1024 * 1024 },
    { id: 'seal-assembler-custody', description: '', warmup: 0, samples: 1, p50Ms: 1000, p95Ms: 2000, maxMs: 3000, sampleDigest: 'g'.repeat(64), rawSamples: [], diskBytes: 0, postCasePeakRssBytes: 100 * 1024 * 1024 },
    { id: 'authorized-projection-500-issues', description: '', warmup: 3, samples: 10, p50Ms: 10, p95Ms: 20, maxMs: 30, sampleDigest: 'h'.repeat(64), rawSamples: [], diskBytes: 0, postCasePeakRssBytes: 100 * 1024 * 1024 },
  ];
}

function reportFor(scale: number, peakRssBytes: number): IntegratedScaleReport {
  return {
    event: 'integrated-scale-result',
    scale,
    results: passingResults(scale),
    peakRssBytes,
    diskBytes: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* P1-1 (a): per-scale verdict isolation (pure function)                      */
/* -------------------------------------------------------------------------- */

describe('evaluateScaleReport per-scale RSS isolation (P1-1)', () => {
  it('judges scale 75 on its OWN small peak even when scale 100 had a huge peak', () => {
    // The pre-fix bug folded the 100% peak (2,714,386,432) into the global
    // state and used it to judge EVERY scale, so 75/50/25% all failed RSS.
    const huge = evaluateScaleReport(reportFor(100, 2_714_386_432), BOUNDS);
    const small = evaluateScaleReport(reportFor(75, 300 * 1024 * 1024), BOUNDS);

    expect(huge.passed).toBe(false);
    expect(huge.violations.some((violation) => violation.includes('peak RSS'))).toBe(true);
    // scale 75 must pass on its own 300 MiB peak — no leakage from scale 100.
    expect(small.passed).toBe(true);
    expect(small.violations).toEqual([]);
  });

  it('judges a small peak against its own report regardless of any other scale', () => {
    const verdict = evaluateScaleReport(reportFor(25, 200 * 1024 * 1024), BOUNDS);
    expect(verdict.passed).toBe(true);
  });

  it('flags every bound violation a scale actually exceeds', () => {
    const report = reportFor(50, 100 * 1024 * 1024);
    report.results = report.results.map((result) =>
      result.id === 'tree-match-10k' ? { ...result, maxMs: 5000 } : result,
    );
    const verdict = evaluateScaleReport(report, BOUNDS);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations).toContain('tree-match-10k');
  });

  it('FAILS a report missing one required case with a missing-case violation (no false pass)', () => {
    const report = reportFor(50, 100 * 1024 * 1024);
    report.results = report.results.filter((result) => result.id !== 'seal-assembler-custody');
    const verdict = evaluateScaleReport(report, BOUNDS);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations).toContain('missing case seal-assembler-custody');
  });

  it('lists every missing required case in one verdict', () => {
    const report = reportFor(50, 100 * 1024 * 1024);
    report.results = report.results.filter((result) => result.id === 'indexed-slot-read');
    const verdict = evaluateScaleReport(report, BOUNDS);
    expect(verdict.passed).toBe(false);
    for (const id of [
      'tree-match-10k',
      'content-root-64mib',
      'draft-journal-2k',
      'seal-assembler-custody',
      'authorized-projection-500-issues',
    ]) {
      expect(verdict.violations).toContain(`missing case ${id}`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* P1-1 (b): subprocess peak independence                                     */
/* -------------------------------------------------------------------------- */

function runAllocProbe(allocBytes: number): { maxRssBytes: number } {
  const tsxCli = resolve(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const scriptPath = resolve(SCRIPT_DIR, 'benchmark-structured-slots.ts');
  const child = spawnSync(
    process.execPath,
    [tsxCli, scriptPath, '--mode', 'alloc-probe', '--alloc-bytes', String(allocBytes)],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  expect(child.status, `child stderr: ${child.stderr ?? ''}`).toBe(0);
  const lines = (child.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const parsed = JSON.parse(lines[lines.length - 1]!) as {
    event: string;
    bytes: number;
    maxRssBytes: number;
  };
  expect(parsed.event).toBe('alloc-probe');
  return { maxRssBytes: parsed.maxRssBytes };
}

describe('two sequentially spawned children report their OWN peak (P1-1)', () => {
  it('a no-alloc child after a 1 GiB allocator stays far below it (relative isolation)', () => {
    // The first child force-touches every page of a 1 GiB buffer, so it
    // genuinely commits far more than its baseline regardless of OS
    // overcommit heuristics. The second child (fresh process, no allocation)
    // peaks at its own ~100 MiB baseline — NOT the first child's ~1.1 GiB peak.
    const big = runAllocProbe(1024 * 1024 * 1024);
    const small = runAllocProbe(0);

    // Robust margin-based assertions (not an absolute-fragile threshold):
    // the no-alloc child stays under a conservative baseline AND is clear of
    // the allocator child by > 256 MiB, proving the RELATIVE isolation.
    expect(small.maxRssBytes).toBeLessThan(256 * 1024 * 1024);
    expect(small.maxRssBytes).toBeLessThan(big.maxRssBytes);
    expect(big.maxRssBytes - small.maxRssBytes).toBeGreaterThan(256 * 1024 * 1024);
  });
});

/* -------------------------------------------------------------------------- */
/* P1-2: exactly ONE scaling boundary                                          */
/* -------------------------------------------------------------------------- */

describe('single scaling boundary (P1-2)', () => {
  it.each([100, 75, 50, 25])(
    'integratedTaskLoad(scaledLimits(%i)) is exactly the scaled axis (no double scaling)',
    (percentage) => {
      const limits = scaledLimits(percentage);
      const load = integratedTaskLoad(limits);
      // Pre-fix double scaling produced maxSlots*scale slots (e.g. 625 at 25%
      // instead of 2500) and maxScaffoldPayloadBytes*scale bytes (4 MiB instead
      // of 16 MiB). The single boundary must yield the exact scaled values.
      expect(load.slotCount).toBe(limits.structure.maxSlots);
      expect(load.contentBytes).toBe(limits.payload.maxScaffoldPayloadBytes);
    },
  );

  it(
    'builds a REAL 25% bench task whose slots and content bytes are exactly the scaled limits',
    async () => {
      const limits = scaledLimits(25);
      const tempRoot = mkdtempSync(join(tmpdir(), 'forge-structured-test-'));
      const paths = CorePaths.create({ dataRoot: tempRoot, templateRoot: join(tempRoot, 'templates') });
      try {
        const task = await buildBenchTask(paths, 'test-load-25', limits);
        // Root + `maxSlots` filled children.
        expect(task.slots.length - 1).toBe(limits.structure.maxSlots);
        expect(task.contentRootBytes).toBe(limits.payload.maxScaffoldPayloadBytes);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

/* -------------------------------------------------------------------------- */
/* Task D: integrated case definitions (pure projection + outline diagnostics) */
/* -------------------------------------------------------------------------- */

/** A stub adapter so tests can inspect the case definitions without a real task. */
function stubAdapter(): IntegratedBenchmarkCasesV1 {
  return {
    runAuthorizedProjection500Issues: async () => 0.4,
    runSealAssemblerCustody64MiB: async () => 1000,
    runBatchRecovery: async () => 800,
    runIndexedSlotRead: async () => 4,
    runOwnerOutlineCold: async () => 42,
    runOwnerOutlineHot: async () => 18,
  };
}

describe('integratedScaleCaseDefinitions (Task D calibration)', () => {
  it('gates the authorized-projection-500-issues case with warmup >= 3 and samples >= 10', () => {
    const cases = integratedScaleCaseDefinitions(25, scaledLimits(25), stubAdapter());
    const projection = cases.find((entry) => entry.id === 'authorized-projection-500-issues');
    expect(projection).toBeDefined();
    // The p95 must be over REAL samples, not a single accidental sample.
    expect(projection?.warmup).toBeGreaterThanOrEqual(3);
    expect(projection?.samples).toBeGreaterThanOrEqual(10);
  });

  it('emits the owner-outline-cold and owner-outline-hot diagnostic cases', () => {
    const cases = integratedScaleCaseDefinitions(25, scaledLimits(25), stubAdapter());
    const ids = cases.map((entry) => entry.id);
    for (const id of REQUIRED_DIAGNOSTIC_CASE_IDS) {
      expect(ids).toContain(id);
    }
  });

  it('FAILS a report missing a required diagnostic case (a regression that drops them cannot silently pass)', () => {
    const report = reportFor(50, 100 * 1024 * 1024);
    report.results = report.results.filter((result) => result.id !== 'owner-outline-hot');
    const verdict = evaluateScaleReport(report, BOUNDS);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations).toContain('missing diagnostic case owner-outline-hot');
    // The bound cases stay the frozen six; the outline diagnostics carry no bound.
    expect(REQUIRED_DIAGNOSTIC_CASE_IDS).not.toContain('indexed-slot-read');
  });

  it('does NOT gate any outline diagnostic timing on a bound (only emission is required)', () => {
    const report = reportFor(50, 100 * 1024 * 1024);
    // A slow outline (even 10 s) must NOT fail the bound verdict.
    report.results = report.results.map((result) =>
      result.id === 'owner-outline-cold' || result.id === 'owner-outline-hot'
        ? { ...result, maxMs: 10_000, p95Ms: 9_000 }
        : result,
    );
    const verdict = evaluateScaleReport(report, BOUNDS);
    expect(verdict.passed).toBe(true);
    expect(verdict.violations).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* P2: exact evidence schema validation                                        */
/* -------------------------------------------------------------------------- */

function validRunner(): { runnerId: string; runnerVersion: string; descriptorDigest: string } {
  return {
    runnerId: 'forge-ref-runner/v1-f2cc89b4',
    runnerVersion: '1.0.0',
    descriptorDigest: 'f2cc89b4e21446330cec1c715c2e6a7f20c9cb027d8854cc128529517e7fa9fc',
  };
}

function validFacts(): { gitCommit: string; sourceTreeDigest: string; packageLockSha256: string; dependencyVersions: Record<string, string> } {
  return {
    gitCommit: '14596e9f02d0565ea879e2d2cbb27f016b7088ab',
    sourceTreeDigest: 'a'.repeat(64),
    packageLockSha256: 'b'.repeat(64),
    dependencyVersions: { 'isolated-vm': '6.2.0', 're2-wasm': '1.0.2', '@earendil-works/pi-ai': '0.82.0' },
  };
}

function validBounds(): Record<string, number> {
  return {
    indexedSlotP95Ms: 25,
    treeMatch10kMaxMs: 2000,
    contentRootMaxMs: 2000,
    draftMaxMs: 2000,
    issueProjectionMaxMs: 250,
    sealMaxMs: 30000,
    peakRssBytes: 512 * 1024 * 1024,
  };
}

function validPerScaleResults(): Array<Record<string, unknown>> {
  return [
    {
      scale: 25,
      results: [
        {
          id: 'owner-outline-cold',
          description: 'owner outline cold (first listSlots) @ 25%',
          warmup: 0,
          samples: 1,
          p50Ms: 42.0,
          p95Ms: 42.0,
          maxMs: 42.0,
          sampleDigest: 'a'.repeat(64),
          postCasePeakRssBytes: 300 * 1024 * 1024,
        },
        {
          id: 'owner-outline-hot',
          description: 'owner outline hot (warm listSlots) @ 25%',
          warmup: 1,
          samples: 5,
          p50Ms: 18.0,
          p95Ms: 22.0,
          maxMs: 24.0,
          sampleDigest: 'b'.repeat(64),
          postCasePeakRssBytes: 300 * 1024 * 1024,
        },
        {
          id: 'indexed-slot-read',
          description: 'indexed slot read (real projection) @ 25%',
          warmup: 3,
          samples: 10,
          p50Ms: 4.2,
          p95Ms: 5.4,
          maxMs: 5.4,
          sampleDigest: 'c'.repeat(64),
          postCasePeakRssBytes: 300 * 1024 * 1024,
        },
        {
          id: 'tree-match-10k',
          description: 'match an 11k-node tree',
          warmup: 1,
          samples: 5,
          p50Ms: 1.07,
          p95Ms: 1.26,
          maxMs: 1.26,
          sampleDigest: 'd'.repeat(64),
          postCasePeakRssBytes: 300 * 1024 * 1024,
        },
        {
          id: 'content-root-64mib',
          description: '16 MiB content root @ 25%',
          warmup: 1,
          samples: 3,
          p50Ms: 100,
          p95Ms: 120,
          maxMs: 130,
          sampleDigest: 'e'.repeat(64),
          postCasePeakRssBytes: 300 * 1024 * 1024,
        },
        {
          id: 'draft-journal-2k',
          description: '2k-change Draft overlay @ 25%',
          warmup: 1,
          samples: 5,
          p50Ms: 1,
          p95Ms: 2,
          maxMs: 3,
          sampleDigest: 'f'.repeat(64),
          postCasePeakRssBytes: 300 * 1024 * 1024,
        },
        {
          id: 'seal-assembler-custody',
          description: '16 MiB real Seal @ 25%',
          warmup: 0,
          samples: 1,
          p50Ms: 1000,
          p95Ms: 1000,
          maxMs: 1000,
          sampleDigest: '9a'.repeat(32),
          postCasePeakRssBytes: 300 * 1024 * 1024,
        },
        {
          id: 'authorized-projection-500-issues',
          description: '500-issue PURE verdict projection @ 25%',
          warmup: 3,
          samples: 10,
          p50Ms: 0.4,
          p95Ms: 0.5,
          maxMs: 0.6,
          sampleDigest: '8b'.repeat(32),
          postCasePeakRssBytes: 300 * 1024 * 1024,
        },
      ],
      peakRssBytes: 300 * 1024 * 1024,
      diskBytes: 17_000_000,
      violations: [],
      passed: true,
    },
  ];
}

function validSuccessEvidence(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    mode: 'integrated-qualify',
    runner: validRunner(),
    ...validFacts(),
    warmupCount: 13,
    sampleCount: 42,
    peakRssBytes: 300 * 1024 * 1024,
    diskBytes: 17_000_000,
    cases: [
      {
        id: 'owner-outline-cold',
        rawSampleDigest: 'a'.repeat(64),
        samples: 1,
        warmup: 0,
        p50Ms: 42.0,
        p95Ms: 42.0,
        maxMs: 42.0,
        postCasePeakRssBytes: 300 * 1024 * 1024,
      },
      {
        id: 'owner-outline-hot',
        rawSampleDigest: 'b'.repeat(64),
        samples: 5,
        warmup: 1,
        p50Ms: 18.0,
        p95Ms: 22.0,
        maxMs: 24.0,
        postCasePeakRssBytes: 300 * 1024 * 1024,
      },
      {
        id: 'indexed-slot-read',
        rawSampleDigest: 'c'.repeat(64),
        samples: 10,
        warmup: 3,
        p50Ms: 4.2,
        p95Ms: 5.4,
        maxMs: 5.4,
        postCasePeakRssBytes: 300 * 1024 * 1024,
      },
      {
        id: 'tree-match-10k',
        rawSampleDigest: 'd'.repeat(64),
        samples: 5,
        warmup: 1,
        p50Ms: 1.07,
        p95Ms: 1.26,
        maxMs: 1.26,
        postCasePeakRssBytes: 300 * 1024 * 1024,
      },
      {
        id: 'content-root-64mib',
        rawSampleDigest: 'e'.repeat(64),
        samples: 3,
        warmup: 1,
        p50Ms: 100,
        p95Ms: 120,
        maxMs: 130,
        postCasePeakRssBytes: 300 * 1024 * 1024,
      },
      {
        id: 'draft-journal-2k',
        rawSampleDigest: 'f'.repeat(64),
        samples: 5,
        warmup: 1,
        p50Ms: 1,
        p95Ms: 2,
        maxMs: 3,
        postCasePeakRssBytes: 300 * 1024 * 1024,
      },
      {
        id: 'seal-assembler-custody',
        rawSampleDigest: '9a'.repeat(32),
        samples: 1,
        warmup: 0,
        p50Ms: 1000,
        p95Ms: 1000,
        maxMs: 1000,
        postCasePeakRssBytes: 300 * 1024 * 1024,
      },
      {
        id: 'authorized-projection-500-issues',
        rawSampleDigest: '8b'.repeat(32),
        samples: 10,
        warmup: 3,
        p50Ms: 0.4,
        p95Ms: 0.5,
        maxMs: 0.6,
        postCasePeakRssBytes: 300 * 1024 * 1024,
      },
    ],
    candidatePercentage: 25,
    selectionReason: 'greatest passing scale 25%',
    frozenLimits: scaledLimits(25) as unknown as StructuredSlotLimitsV1,
    bounds: validBounds(),
    perScaleResults: validPerScaleResults(),
  };
}

describe('validateProfileEvidence (P2)', () => {
  it('accepts the exact success evidence shape', () => {
    expect(() => validateProfileEvidence(validSuccessEvidence())).not.toThrow();
  });

  it('rejects unknown fields at the top level', () => {
    expect(() => validateProfileEvidence({ ...validSuccessEvidence(), extra: 1 })).toThrow(
      /STRUCTURED_EVIDENCE_INVALID: unknown field 'extra'/,
    );
  });

  it('rejects a malformed sourceTreeDigest (not 64-hex)', () => {
    const evidence = validSuccessEvidence();
    evidence.sourceTreeDigest = 'not-a-digest';
    expect(() => validateProfileEvidence(evidence)).toThrow(/sourceTreeDigest must be a 64-hex digest/);
  });

  it('rejects an unknown field inside a per-scale result', () => {
    const evidence = validSuccessEvidence();
    (evidence.perScaleResults as Array<Record<string, unknown>>)[0]!.stray = 1;
    expect(() => validateProfileEvidence(evidence)).toThrow(/unknown field 'stray'/);
  });

  it('rejects missing frozenLimits (required for a passing scale)', () => {
    const evidence = validSuccessEvidence();
    delete evidence.frozenLimits;
    expect(() => validateProfileEvidence(evidence)).toThrow(/frozenLimits/);
  });

  it('rejects a candidatePercentage outside the enumerated {100, 75, 50, 25} scales', () => {
    const evidence = validSuccessEvidence();
    evidence.candidatePercentage = 33;
    expect(() => validateProfileEvidence(evidence)).toThrow(
      /candidatePercentage must be null or one of 100, 75, 50, 25/,
    );
  });

  it('rejects a success evidence whose cases dropped a required diagnostic (diagnostic-dropped)', () => {
    const evidence = validSuccessEvidence();
    (evidence.cases as Array<Record<string, unknown>>) = (evidence.cases as Array<Record<string, unknown>>).filter(
      (entry) => entry.id !== 'owner-outline-cold',
    );
    expect(() => validateProfileEvidence(evidence)).toThrow(/evidence.cases missing required case 'owner-outline-cold'/);
  });

  it('rejects a success evidence missing a required bound case', () => {
    const evidence = validSuccessEvidence();
    (evidence.cases as Array<Record<string, unknown>>) = (evidence.cases as Array<Record<string, unknown>>).filter(
      (entry) => entry.id !== 'authorized-projection-500-issues',
    );
    expect(() => validateProfileEvidence(evidence)).toThrow(
      /evidence.cases missing required case 'authorized-projection-500-issues'/,
    );
  });

  it('rejects a per-scale case with a wrong-type postCasePeakRssBytes', () => {
    const evidence = validSuccessEvidence();
    const results = (evidence.perScaleResults as Array<{ results: Array<Record<string, unknown>> }>)[0]!.results;
    results[0]!.postCasePeakRssBytes = 'huge';
    expect(() => validateProfileEvidence(evidence)).toThrow(/postCasePeakRssBytes must be a non-negative safe integer/);
  });

  it('rejects a success case missing the required postCasePeakRssBytes diagnostic field', () => {
    const evidence = validSuccessEvidence();
    delete (evidence.cases as Array<Record<string, unknown>>)[0]!.postCasePeakRssBytes;
    expect(() => validateProfileEvidence(evidence)).toThrow(/postCasePeakRssBytes/);
  });
});

describe('validateProfileEvidenceFailure (P2)', () => {
  function validFailureEvidence(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      mode: 'integrated-qualify',
      outcome: 'no_scale_passed',
      runner: validRunner(),
      ...validFacts(),
      bounds: validBounds(),
      perScaleResults: validPerScaleResults().map((entry) => ({
        ...entry,
        peakRssBytes: 2_714_386_432,
        violations: ['peak RSS 2714386432 > 536870912'],
        passed: false,
      })),
      selectionReason: 'no 100/75/50/25% scale of the candidate axes satisfied every acceptance bound',
    };
  }

  it('accepts the exact honest-failure shape', () => {
    expect(() => validateProfileEvidenceFailure(validFailureEvidence())).not.toThrow();
  });

  it('accepts the child_failed shape (mid-loop child failure evidence is never lost)', () => {
    expect(() =>
      validateProfileEvidenceFailure({
        ...validFailureEvidence(),
        outcome: 'child_failed',
        selectionReason: 'scale 100% child failed; per-scale results recorded so far: 0',
      }),
    ).not.toThrow();
  });

  it('rejects an unknown field', () => {
    expect(() => validateProfileEvidenceFailure({ ...validFailureEvidence(), outcome: 'no_scale_passed', stray: 1 })).toThrow(
      /unknown field 'stray'/,
    );
  });

  it('rejects a non-no_scale_passed outcome', () => {
    expect(() => validateProfileEvidenceFailure({ ...validFailureEvidence(), outcome: 'passed' })).toThrow(
      /outcome must be "no_scale_passed"/,
    );
  });
});
