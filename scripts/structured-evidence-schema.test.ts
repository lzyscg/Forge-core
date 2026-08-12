/**
 * Task D exact-schema regression tests for the EXTENDED structured-slot profile
 * evidence.
 *
 * The evidence schema stayed at `schemaVersion: 1` with ADDITIVE fields: every
 * success evidence `cases` entry and every per-scale result case now carries a
 * required `postCasePeakRssBytes` (the cumulative child peak AFTER that case),
 * and the success `cases` array must contain all twelve frozen integrated case
 * ids using the exact benchmark sampling protocol.
 *
 * Positive tests prove a valid extended evidence (success + failure) passes;
 * negative tests prove a diagnostic-dropped / missing-required-case /
 * unknown-field / wrong-type evidence fails.
 */
import { describe, expect, it } from 'vitest';
import type { StructuredSlotLimitsV1 } from '../src/shared/structured-slots';
import { scaledLimits } from './benchmark-structured-slots';
import {
  CASE_SAMPLE_PROTOCOL,
  REQUIRED_EVIDENCE_CASE_IDS,
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

const REQUIRED_CASE_IDS = REQUIRED_EVIDENCE_CASE_IDS;

const HEX_DIGESTS: readonly string[] = REQUIRED_CASE_IDS.map((_, index) =>
  (index + 1).toString(16).padStart(2, '0').repeat(32),
);

function perScaleCase(id: string, index: number): Record<string, unknown> {
  const protocol = CASE_SAMPLE_PROTOCOL[id]!;
  return {
    id,
    description: `${id} @ 25%`,
    warmup: protocol.warmup,
    samples: protocol.samples,
    p50Ms: 4.2,
    p95Ms: 5.4,
    maxMs: 5.4,
    sampleDigest: HEX_DIGESTS[index]!,
    postCasePeakRssBytes: 300 * 1024 * 1024,
  };
}

function evidenceCase(id: string, index: number): Record<string, unknown> {
  const protocol = CASE_SAMPLE_PROTOCOL[id]!;
  return {
    id,
    rawSampleDigest: HEX_DIGESTS[index]!,
    samples: protocol.samples,
    warmup: protocol.warmup,
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
    warmupCount: 12,
    sampleCount: 58,
    peakRssBytes: 300 * 1024 * 1024,
    diskBytes: 17_000_000,
    cases: REQUIRED_CASE_IDS.map((id, index) => evidenceCase(id, index)),
    candidatePercentage: 25,
    selectionReason: 'greatest passing scale 25%',
    frozenLimits: scaledLimits(25) as unknown as StructuredSlotLimitsV1,
    bounds: BOUNDS,
    perScaleResults: [
      ...[100, 75, 50].map((scale) => ({
        scale,
        results: REQUIRED_CASE_IDS.map((id, index) => perScaleCase(id, index)),
        peakRssBytes: 600 * 1024 * 1024,
        diskBytes: 17_000_000,
        violations: [`peak RSS ${600 * 1024 * 1024} > ${512 * 1024 * 1024}`],
        passed: false,
      })),
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

  it('rejects a SUCCESS evidence whose failed scale omits a frozen case', () => {
    const evidence = validSuccessEvidence();
    const failedScale = (evidence.perScaleResults as Array<{
      results: Array<Record<string, unknown>>;
      violations: string[];
    }>)[0]!;
    failedScale.results = failedScale.results.filter((entry) => entry.id !== 'validator-fanout-10k');
    failedScale.violations = [
      'missing diagnostic case validator-fanout-10k',
      `peak RSS ${600 * 1024 * 1024} > ${512 * 1024 * 1024}`,
    ];
    expect(() => validateProfileEvidence(evidence)).toThrow(
      /scale 100 must contain all frozen qualification cases/,
    );
  });
});
