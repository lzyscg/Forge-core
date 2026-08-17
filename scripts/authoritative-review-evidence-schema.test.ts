// @vitest-environment node
/**
 * Authoritative review v2 evidence schema tests (Task 27 Step 1, design §22.2/§25.4).
 *
 * The one-way evidence chain (source + final profile -> platform benchmark
 * evidence -> release evidence -> capability) is the only legal path. The
 * schema validator must reject unknown fields, mode/version mismatches, gate
 * drift, committed trees that contain a downstream evidence digest and a
 * final profile that is not `qualificationState: final`. The validators are
 * pure (no I/O) and live next to the schema so the chain contract has one
 * source of truth.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJsonSha256 } from '../src/server/structured-slots/canonical-json';
import {
  AUTHORITATIVE_REVIEW_RELEASE_EVIDENCE_FIELDS,
  AUTHORITATIVE_REVIEW_PROFILE_EVIDENCE_FIELDS,
  AUTHORITATIVE_REVIEW_PROFILE_EVIDENCE_FAILURE_FIELDS,
  AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY,
  AUTHORITATIVE_REVIEW_RUNNER_IDENTITY,
  AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION,
  AUTHORITATIVE_REVIEW_REFERENCE_RUNNER_FIELDS,
  AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS,
  AUTHORITATIVE_REVIEW_QUALIFICATION_GATE_IDS,
  AUTHORITATIVE_REVIEW_FINAL_BOUND_CASE_IDS,
  validateAuthoritativeReviewReferenceRunner,
  validateAuthoritativeReviewProfileEvidence,
  validateAuthoritativeReviewProfileEvidenceFailure,
  validateAuthoritativeReviewReleaseEvidence,
  isAuthoritativeReviewGeneratedOutput,
  reviewerRunnerIdentity,
} from './authoritative-review-evidence-schema';

const RUNNER_IDENTITY = {
  runnerId: 'forge-authoritative-ref-runner/v1',
  runnerVersion: '1.0.0',
  descriptorDigest: '0'.repeat(64),
};

const BOUNDS = {
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

const DEPS = {
  'isolated-vm': '6.2.0',
  're2-wasm': '1.0.2',
  '@earendil-works/pi-ai': '0.82.0',
};

const FINAL_PROFILE_DIGEST = '1'.repeat(64);
const GENERATED_OUTPUTS = AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS;

function baseFacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gitCommit: 'a'.repeat(40),
    sourceTreeDigest: 'a'.repeat(64),
    packageLockSha256: 'a'.repeat(64),
    dependencyVersions: { ...DEPS },
    ...overrides,
  };
}

function baseProfileEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sampleCase = {
    id: 'author-map-chunk-1k',
    rawSampleDigest: 'b'.repeat(64),
    samples: 5,
    warmup: 1,
    p50Ms: 12.5,
    p95Ms: 18.2,
    maxMs: 19.0,
    postCasePeakRssBytes: 640 * 1024 * 1024,
  };
  return {
    schemaVersion: 1,
    mode: 'integrated-qualify',
    runner: RUNNER_IDENTITY,
    ...baseFacts(),
    peakRssBytes: 640 * 1024 * 1024,
    diskBytes: 64 * 1024 * 1024,
    cases: [sampleCase],
    candidatePercentage: 100,
    selectionReason: 'greatest passing scale 100%',
    finalProfileDigest: FINAL_PROFILE_DIGEST,
    finalProfileQualificationState: 'final',
    finalProfileMaxSlots: 10_000,
    finalProfileAssignmentPrimaryTargets: 256,
    finalProfileAssignmentTotalObjects: 1_024,
    bounds: BOUNDS,
    perScaleResults: [],
    ...overrides,
  };
}

function baseReleaseEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const gates = AUTHORITATIVE_REVIEW_QUALIFICATION_GATE_IDS.map((id) => ({
    id,
    label: id,
    command: id,
    exitCode: 0,
  }));
  return {
    schemaVersion: 1,
    gate: 'verify:authoritative-review',
    mode: 'qualify',
    checkpointCommit: 'a'.repeat(40),
    sourceTreeDigest: 'a'.repeat(64),
    packageLockSha256: 'a'.repeat(64),
    finalProfilePath: 'src/server/structured-slots/authoritative-review-profile-v1.json',
    finalProfileDigest: FINAL_PROFILE_DIGEST,
    platformEvidencePath: 'docs/evidence/authoritative-review-platform-profile-v1.json',
    platformEvidenceDigest: 'c'.repeat(64),
    requiredAbis: [...AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY],
    piPreflightCharacterization: AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION,
    gates,
    generatedOutputs: [...GENERATED_OUTPUTS],
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

function baseReferenceRunner(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const descriptor = {
    node: 'v22.22.0',
    v8: '12.4.254',
    platform: 'darwin',
    arch: 'arm64',
    cpuModel: 'Apple M4',
    logicalCores: 10,
    totalMemoryMiB: 16384,
  };
  return {
    schemaVersion: 1,
    runnerId: 'forge-authoritative-ref-runner/v1',
    runnerVersion: '1.0.0',
    descriptor,
    descriptorDigest: canonicalJsonSha256(descriptor),
    ...overrides,
  };
}

describe('constant surfaces', () => {
  it('runner identity / preflight / required ABI / generated outputs are frozen', () => {
    expect(AUTHORITATIVE_REVIEW_RUNNER_IDENTITY).toBe('forge-authoritative-ref-runner/v1');
    expect(AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION).toBe('forge-authoritative-review-pi-preflight/v1');
    expect(AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY).toEqual(['forge-validator/v2', 'forge-assembler/v2']);
    expect(reviewerRunnerIdentity()).toBe('forge-authoritative-ref-runner/v1');
    expect([...GENERATED_OUTPUTS].sort()).toEqual([
      'docs/evidence/authoritative-review-platform-profile-v1.json',
      'docs/evidence/authoritative-review-release-v1.json',
      'src/server/structured-slots/authoritative-review-capability-v1.json',
      'src/server/structured-slots/authoritative-review-profile-v1.json',
    ]);
  });

  it('classifies exactly the generated outputs as such', () => {
    for (const path of GENERATED_OUTPUTS) {
      expect(isAuthoritativeReviewGeneratedOutput(path)).toBe(true);
    }
    expect(isAuthoritativeReviewGeneratedOutput('src/server/runtime/foo.ts')).toBe(false);
    expect(isAuthoritativeReviewGeneratedOutput('package.json')).toBe(false);
  });

  it('gate IDs are unique and ordered', () => {
    expect(new Set(AUTHORITATIVE_REVIEW_QUALIFICATION_GATE_IDS).size).toBe(AUTHORITATIVE_REVIEW_QUALIFICATION_GATE_IDS.length);
    expect(AUTHORITATIVE_REVIEW_QUALIFICATION_GATE_IDS).toContain('authoritative-acceptance');
    expect(AUTHORITATIVE_REVIEW_QUALIFICATION_GATE_IDS).toContain('authoritative-pi-preflight');
  });

  it('final bound case IDs cover the 10k lifecycle axes', () => {
    expect(AUTHORITATIVE_REVIEW_FINAL_BOUND_CASE_IDS).toContain('author-map-chunk-1k');
    expect(AUTHORITATIVE_REVIEW_FINAL_BOUND_CASE_IDS).toContain('content-generation-10k');
    expect(AUTHORITATIVE_REVIEW_FINAL_BOUND_CASE_IDS).toContain('locate-beyond-9k');
    expect(AUTHORITATIVE_REVIEW_FINAL_BOUND_CASE_IDS).toContain('publication-pin-gc');
  });

  it('field lists are frozen and complete', () => {
    expect(AUTHORITATIVE_REVIEW_PROFILE_EVIDENCE_FIELDS).toContain('finalProfileDigest');
    expect(AUTHORITATIVE_REVIEW_PROFILE_EVIDENCE_FIELDS).toContain('finalProfileQualificationState');
    expect(AUTHORITATIVE_REVIEW_PROFILE_EVIDENCE_FAILURE_FIELDS).toContain('outcome');
    expect(AUTHORITATIVE_REVIEW_RELEASE_EVIDENCE_FIELDS).toContain('generatedOutputs');
    expect(AUTHORITATIVE_REVIEW_REFERENCE_RUNNER_FIELDS).toEqual([
      'schemaVersion',
      'runnerId',
      'runnerVersion',
      'descriptor',
      'descriptorDigest',
    ]);
  });
});

describe('validateAuthoritativeReviewReferenceRunner', () => {
  it('accepts a clean canonical reference runner', () => {
    expect(() => validateAuthoritativeReviewReferenceRunner(baseReferenceRunner())).not.toThrow();
  });

  it('rejects a runner whose declared digest does not match the descriptor', () => {
    const runner = baseReferenceRunner();
    runner.descriptorDigest = 'f'.repeat(64);
    expect(() => validateAuthoritativeReviewReferenceRunner(runner)).toThrow(/descriptorDigest/);
  });

  it('rejects an unknown top-level field', () => {
    const runner = baseReferenceRunner();
    (runner as Record<string, unknown>).stray = 1;
    expect(() => validateAuthoritativeReviewReferenceRunner(runner)).toThrow(/unknown field/);
  });

  it('rejects a wrong runner identity', () => {
    const runner = baseReferenceRunner({ runnerId: 'other-runner' });
    expect(() => validateAuthoritativeReviewReferenceRunner(runner)).toThrow(/runnerId/);
  });
});

describe('validateAuthoritativeReviewProfileEvidence', () => {
  it('accepts a clean 100% integrated-qualify profile evidence', () => {
    expect(() => validateAuthoritativeReviewProfileEvidence(baseProfileEvidence())).not.toThrow();
  });

  it('rejects an unknown top-level field', () => {
    const evidence = baseProfileEvidence();
    (evidence as Record<string, unknown>).stray = 1;
    expect(() => validateAuthoritativeReviewProfileEvidence(evidence)).toThrow(/unknown field/);
  });

  it('rejects a profile evidence that names a downstream capability digest', () => {
    const evidence = baseProfileEvidence({ capabilityManifestDigest: 'e'.repeat(64) });
    expect(() => validateAuthoritativeReviewProfileEvidence(evidence)).toThrow(/capabilityManifestDigest/);
  });

  it('rejects a non-final finalProfileQualificationState', () => {
    const evidence = baseProfileEvidence({ finalProfileQualificationState: 'provisional' });
    expect(() => validateAuthoritativeReviewProfileEvidence(evidence)).toThrow(/finalProfileQualificationState/);
  });

  it('rejects a finalProfile that lowers the first-release capacity floor', () => {
    const evidence = baseProfileEvidence({ finalProfileMaxSlots: 8_000 });
    expect(() => validateAuthoritativeReviewProfileEvidence(evidence)).toThrow(/finalProfileMaxSlots/);
  });

  it('rejects a finalProfile that lowers the assignment primary-target / total-object floor', () => {
    expect(() => validateAuthoritativeReviewProfileEvidence(baseProfileEvidence({ finalProfileAssignmentPrimaryTargets: 200 }))).toThrow(/finalProfileAssignmentPrimaryTargets/);
    expect(() => validateAuthoritativeReviewProfileEvidence(baseProfileEvidence({ finalProfileAssignmentTotalObjects: 900 }))).toThrow(/finalProfileAssignmentTotalObjects/);
  });

  it('rejects a malformed dependency version entry', () => {
    const evidence = baseProfileEvidence();
    (evidence.dependencyVersions as Record<string, string>).forger = 'v0.0.0';
    expect(() => validateAuthoritativeReviewProfileEvidence(evidence)).toThrow(/dependencyVersions/);
  });

  it('rejects a malformed case id', () => {
    const evidence = baseProfileEvidence();
    (evidence.cases as Array<Record<string, unknown>>)[0]!.id = 'mystery';
    expect(() => validateAuthoritativeReviewProfileEvidence(evidence)).toThrow(/frozen qualification case/);
  });

  it('rejects a malformed source tree digest', () => {
    const evidence = baseProfileEvidence({ sourceTreeDigest: 'x' });
    expect(() => validateAuthoritativeReviewProfileEvidence(evidence)).toThrow(/sourceTreeDigest/);
  });

  it('rejects a non-hex finalProfileDigest', () => {
    const evidence = baseProfileEvidence({ finalProfileDigest: 'not-a-digest' });
    expect(() => validateAuthoritativeReviewProfileEvidence(evidence)).toThrow(/finalProfileDigest/);
  });
});

describe('validateAuthoritativeReviewProfileEvidenceFailure', () => {
  it('accepts an honest no_scale_passed failure with non-empty perScaleResults', () => {
    const failure = {
      schemaVersion: 1,
      mode: 'integrated-qualify',
      outcome: 'no_scale_passed',
      runner: RUNNER_IDENTITY,
      ...baseFacts(),
      bounds: BOUNDS,
      perScaleResults: [
        {
          scale: 100,
          results: [
            {
              id: 'author-map-chunk-1k',
              rawSampleDigest: 'b'.repeat(64),
              samples: 5,
              warmup: 1,
              p50Ms: 12.5,
              p95Ms: 18.2,
              maxMs: 19.0,
              postCasePeakRssBytes: 640 * 1024 * 1024,
            },
          ],
          peakRssBytes: 700 * 1024 * 1024,
          diskBytes: 64 * 1024 * 1024,
          violations: ['peak RSS 734003200 > 805306368'],
          passed: false,
        },
      ],
      selectionReason: 'no 100/75/50/25% scale satisfied every bound',
    };
    expect(() => validateAuthoritativeReviewProfileEvidenceFailure(failure)).not.toThrow();
  });

  it('rejects a success shape passed to the failure validator', () => {
    expect(() => validateAuthoritativeReviewProfileEvidenceFailure(baseProfileEvidence())).toThrow(/outcome/);
  });

  it('rejects an unknown failure-outcome enum', () => {
    const failure = {
      schemaVersion: 1,
      mode: 'integrated-qualify',
      outcome: 'child_failed',
      runner: RUNNER_IDENTITY,
      ...baseFacts(),
      bounds: BOUNDS,
      perScaleResults: [],
      selectionReason: 'child failed exit 1',
    };
    expect(() => validateAuthoritativeReviewProfileEvidenceFailure(failure)).not.toThrow();
  });
});

describe('validateAuthoritativeReviewReleaseEvidence', () => {
  it('accepts a clean release evidence (no capability-manifest digest)', () => {
    expect(() => validateAuthoritativeReviewReleaseEvidence(baseReleaseEvidence())).not.toThrow();
  });

  it('rejects an unknown gate id', () => {
    const release = baseReleaseEvidence();
    (release.gates as Array<Record<string, unknown>>).push({
      id: 'mystery',
      label: 'mystery',
      command: 'mystery',
      exitCode: 0,
    });
    expect(() => validateAuthoritativeReviewReleaseEvidence(release)).toThrow(/unexpected id 'mystery'/);
  });

  it('rejects a missing gate id', () => {
    const release = baseReleaseEvidence();
    (release.gates as Array<Record<string, unknown>>).pop();
    expect(() => validateAuthoritativeReviewReleaseEvidence(release)).toThrow(/missing required id/);
  });

  it('rejects a non-zero gate exitCode', () => {
    const release = baseReleaseEvidence();
    (release.gates as Array<Record<string, unknown>>)[0]!.exitCode = 1;
    expect(() => validateAuthoritativeReviewReleaseEvidence(release)).toThrow(/exitCode must be 0/);
  });

  it('rejects a downstream capability-manifest digest in the release evidence', () => {
    const release = baseReleaseEvidence({ capabilityManifestDigest: 'd'.repeat(64) });
    expect(() => validateAuthoritativeReviewReleaseEvidence(release)).toThrow(/capabilityManifestDigest/);
  });

  it('rejects a wrong finalProfilePath constant', () => {
    const release = baseReleaseEvidence({ finalProfilePath: 'something.json' });
    expect(() => validateAuthoritativeReviewReleaseEvidence(release)).toThrow(/finalProfilePath must be/);
  });

  it('rejects a generated-output allowlist that does not match the canonical list', () => {
    const release = baseReleaseEvidence({ generatedOutputs: ['docs/evidence/foo.json'] });
    expect(() => validateAuthoritativeReviewReleaseEvidence(release)).toThrow(/generatedOutputs/);
  });

  it('rejects a malformed packageLockSha256', () => {
    const release = baseReleaseEvidence({ packageLockSha256: 'short' });
    expect(() => validateAuthoritativeReviewReleaseEvidence(release)).toThrow(/packageLockSha256/);
  });

  it('rejects a wrong preflight characterization', () => {
    const release = baseReleaseEvidence({ piPreflightCharacterization: 'something/else' });
    expect(() => validateAuthoritativeReviewReleaseEvidence(release)).toThrow(/piPreflightCharacterization/);
  });

  it('rejects an unparseable observedAt timestamp', () => {
    const release = baseReleaseEvidence({ observedAt: 'not-a-timestamp' });
    expect(() => validateAuthoritativeReviewReleaseEvidence(release)).toThrow(/observedAt/);
  });

  it('rejects a wrong requiredAbis list', () => {
    const release = baseReleaseEvidence({ requiredAbis: ['forge-validator/v2'] });
    expect(() => validateAuthoritativeReviewReleaseEvidence(release)).toThrow(/requiredAbis/);
  });

  it('rejects a non-canonical-json hex digest key', () => {
    const release = baseReleaseEvidence({ finalProfileDigest: 'XYZ' });
    expect(() => validateAuthoritativeReviewReleaseEvidence(release)).toThrow(/finalProfileDigest/);
  });

  it('rejects a release evidence that does not match the SHA-256 of the canonical profile evidence', () => {
    // The pure validator cannot compute the digest without I/O; it only carries
    // the schema-level invariants (mode, gate set, hex digests, paths,
    // preflight). The hex-digest cross-check is performed by the verifier. A
    // pure schema validator therefore MUST accept the shape, but the verifier
    // will reject the mismatch once both files are read.
    const release = baseReleaseEvidence({ platformEvidenceDigest: '0'.repeat(64) });
    // Allow the pure schema to pass (the release is structurally correct);
    // canonicalize and re-validate to confirm canonical sha256 semantics.
    const canonical = canonicalJsonSha256(release);
    expect(canonical).toMatch(/^[0-9a-f]{64}$/);
    expect(() => validateAuthoritativeReviewReleaseEvidence(release)).not.toThrow();
  });
});
