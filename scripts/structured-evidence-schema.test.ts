/**
 * Task D exact-schema regression tests for the EXTENDED structured-slot profile
 * evidence.
 *
 * The evidence schema stayed at `schemaVersion: 1` with ADDITIVE fields: every
 * success evidence `cases` entry and every per-scale result case now carries a
 * required `postCasePeakRssBytes` (the cumulative child peak AFTER that case),
 * and the success `cases` array must contain ALL required integrated case ids —
 * the six frozen bound cases PLUS the two owner-outline diagnostics
 * (`owner-outline-cold` / `owner-outline-hot`) the benchmark is required to
 * emit. The outline diagnostics carry NO bound; only their emission is
 * required.
 *
 * Positive tests prove a valid extended evidence (success + failure) passes;
 * negative tests prove a diagnostic-dropped / missing-required-case /
 * unknown-field / wrong-type evidence fails.
 */
import { describe, expect, it } from 'vitest';
import type { StructuredSlotLimitsV1 } from '../src/shared/structured-slots';
import { scaledLimits } from './benchmark-structured-slots';
import {
  validateProfileEvidence,
  validateProfileEvidenceFailure,
} from './structured-evidence-schema';

const RUNNER = {
  runnerId: 'forge-ref-runner/v1-f2cc89b4',
  runnerVersion: '1.0.0',
  descriptorDigest: 'f2cc89b4e21446330cec1c715c2e6a7f20c9cb027d8854cc128529517e7fa9fc',
};

const FACTS = {
  gitCommit: '14596e9f02d0565ea879e2d2cbb27f016b7088ab',
  sourceTreeDigest: 'a'.repeat(64),
  packageLockSha256: 'b'.repeat(64),
  dependencyVersions: { 'isolated-vm': '6.2.0', 're2-wasm': '1.0.2', '@earendil-works/pi-ai': '0.82.0' },
};

const BOUNDS: Record<string, number> = {
  indexedSlotP95Ms: 25,
  treeMatch10kMaxMs: 2000,
  contentRootMaxMs: 2000,
  draftMaxMs: 2000,
  issueProjectionMaxMs: 250,
  sealMaxMs: 30000,
  peakRssBytes: 512 * 1024 * 1024,
};

const REQUIRED_CASE_IDS: readonly string[] = [
  'indexed-slot-read',
  'tree-match-10k',
  'content-root-64mib',
  'draft-journal-2k',
  'seal-assembler-custody',
  'authorized-projection-500-issues',
  'owner-outline-cold',
  'owner-outline-hot',
];

const HEX_DIGESTS: readonly string[] = [
  'a'.repeat(64),
  'b'.repeat(64),
  'c'.repeat(64),
  'd'.repeat(64),
  'e'.repeat(64),
  'f'.repeat(64),
  '9a'.repeat(32),
  '8b'.repeat(32),
];

function perScaleCase(id: string, index: number): Record<string, unknown> {
  return {
    id,
    description: `${id} @ 25%`,
    warmup: id === 'authorized-projection-500-issues' || id === 'indexed-slot-read' ? 3 : 1,
    samples: id === 'owner-outline-cold' ? 1 : 5,
    p50Ms: 4.2,
    p95Ms: 5.4,
    maxMs: 5.4,
    sampleDigest: HEX_DIGESTS[index]!,
    postCasePeakRssBytes: 300 * 1024 * 1024,
  };
}

function evidenceCase(id: string, index: number): Record<string, unknown> {
  return {
    id,
    rawSampleDigest: HEX_DIGESTS[index]!,
    samples: id === 'owner-outline-cold' ? 1 : 5,
    warmup: id === 'authorized-projection-500-issues' || id === 'indexed-slot-read' ? 3 : 1,
    p50Ms: 4.2,
    p95Ms: 5.4,
    maxMs: 5.4,
    postCasePeakRssBytes: 300 * 1024 * 1024,
  };
}

function validSuccessEvidence(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    mode: 'integrated-qualify',
    runner: RUNNER,
    ...FACTS,
    warmupCount: 20,
    sampleCount: 40,
    peakRssBytes: 300 * 1024 * 1024,
    diskBytes: 17_000_000,
    cases: REQUIRED_CASE_IDS.map((id, index) => evidenceCase(id, index)),
    candidatePercentage: 25,
    selectionReason: 'greatest passing scale 25%',
    frozenLimits: scaledLimits(25) as unknown as StructuredSlotLimitsV1,
    bounds: BOUNDS,
    perScaleResults: [
      {
        scale: 25,
        results: REQUIRED_CASE_IDS.map((id, index) => perScaleCase(id, index)),
        peakRssBytes: 300 * 1024 * 1024,
        diskBytes: 17_000_000,
        violations: [],
        passed: true,
      },
    ],
  };
}

function validFailureEvidence(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    mode: 'integrated-qualify',
    outcome: 'no_scale_passed',
    runner: RUNNER,
    ...FACTS,
    bounds: BOUNDS,
    perScaleResults: [
      {
        scale: 100,
        results: REQUIRED_CASE_IDS.map((id, index) => perScaleCase(id, index)),
        peakRssBytes: 2_714_386_432,
        diskBytes: 71_000_000,
        violations: ['peak RSS 2714386432 > 536870912'],
        passed: false,
      },
    ],
    selectionReason: 'no 100/75/50/25% scale of the candidate axes satisfied every acceptance bound',
  };
}

describe('extended profile evidence schema (Task D)', () => {
  it('accepts a valid extended SUCCESS evidence (additive fields under schemaVersion 1)', () => {
    expect(() => validateProfileEvidence(validSuccessEvidence())).not.toThrow();
  });

  it('accepts a valid extended FAILURE evidence with the new per-case diagnostics', () => {
    expect(() => validateProfileEvidenceFailure(validFailureEvidence())).not.toThrow();
  });

  it('rejects a SUCCESS evidence missing a required diagnostic case (diagnostic-dropped)', () => {
    const evidence = validSuccessEvidence();
    (evidence.cases as Array<Record<string, unknown>>) = (
      evidence.cases as Array<Record<string, unknown>>
    ).filter((entry) => entry.id !== 'owner-outline-cold');
    expect(() => validateProfileEvidence(evidence)).toThrow(
      /evidence.cases missing required case 'owner-outline-cold'/,
    );
  });

  it('rejects a SUCCESS evidence missing a required bound case', () => {
    const evidence = validSuccessEvidence();
    (evidence.cases as Array<Record<string, unknown>>) = (
      evidence.cases as Array<Record<string, unknown>>
    ).filter((entry) => entry.id !== 'seal-assembler-custody');
    expect(() => validateProfileEvidence(evidence)).toThrow(
      /evidence.cases missing required case 'seal-assembler-custody'/,
    );
  });

  it('rejects a per-scale case with a wrong-type postCasePeakRssBytes', () => {
    const evidence = validSuccessEvidence();
    const results = (evidence.perScaleResults as Array<{ results: Array<Record<string, unknown>> }>)[0]!.results;
    results[0]!.postCasePeakRssBytes = 'huge';
    expect(() => validateProfileEvidence(evidence)).toThrow(
      /postCasePeakRssBytes must be a non-negative safe integer/,
    );
  });

  it('rejects a per-scale case missing the required postCasePeakRssBytes field', () => {
    const evidence = validSuccessEvidence();
    const results = (evidence.perScaleResults as Array<{ results: Array<Record<string, unknown>> }>)[0]!.results;
    delete results[0]!.postCasePeakRssBytes;
    expect(() => validateProfileEvidence(evidence)).toThrow(/postCasePeakRssBytes/);
  });

  it('rejects an unknown field in the extended evidence', () => {
    expect(() => validateProfileEvidence({ ...validSuccessEvidence(), stray: 1 })).toThrow(
      /STRUCTURED_EVIDENCE_INVALID: unknown field 'stray'/,
    );
  });

  it('rejects an unknown field inside an extended per-scale result', () => {
    const evidence = validSuccessEvidence();
    (evidence.perScaleResults as Array<Record<string, unknown>>)[0]!.stray = 1;
    expect(() => validateProfileEvidence(evidence)).toThrow(/unknown field 'stray'/);
  });
});
