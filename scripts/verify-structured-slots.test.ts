/**
 * Patch B regression tests for the Task 19 structured slot engine verify script
 * (Codex independent-acceptance finding P1-3: a failed qualification can still
 * promote).
 *
 * - runQualify writes the release evidence ONLY after every gate exits 0; a
 *   failed gate set writes a `.failed-<timestamp>` failure record at a DIFFERENT
 *   path, returns 1, and leaves a stale release evidence untouched.
 * - runPromoteCapability exact-validates the release evidence schema (mode,
 *   gate set, every exitCode 0, digests, paths, timestamps) BEFORE any digest
 *   cross-check, and requires the profile evidence to be the SUCCESS
 *   integrated-qualify shape (never `no_scale_passed` / `child_failed`).
 *
 * All file-backed tests run against an isolated temp workspace; the checked-in
 * production manifest is never touched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJsonSha256 } from '../src/server/structured-slots/canonical-json';
import {
  loadStructuredPlatformProfile,
  profileCanonicalDigest,
  STRUCTURED_SLOT_PROFILE_CANDIDATE,
} from '../src/server/structured-slots/platform-profile';
import type { StructuredSlotLimitsV1 } from '../src/shared/structured-slots';
import {
  RELEASE_FINAL_PROFILE_PATH,
  RELEASE_PI_PREFLIGHT_CHARACTERIZATION,
  RELEASE_PROFILE_EVIDENCE_PATH,
  validateProfileEvidence,
  validateProfileEvidenceFailure,
  validateReleaseEvidence,
} from './structured-evidence-schema';
import {
  cleanSourceDigest,
  gitCommit,
  packageLockSha256,
  RELEASE_EVIDENCE_GATE_IDS,
  runPromoteCapability,
  runQualify,
} from './verify-structured-slots';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

/** Real-repo facts captured once per test file (working tree is static). */
const REAL_GIT_COMMIT = gitCommit();
const REAL_SOURCE_DIGEST = cleanSourceDigest();
const REAL_LOCK_SHA = packageLockSha256();

const RUNNER = {
  runnerId: 'forge-ref-runner/v1-f2cc89b4',
  runnerVersion: '1.0.0',
  descriptorDigest: 'f2cc89b4e21446330cec1c715c2e6a7f20c9cb027d8854cc128529517e7fa9fc',
};

const DEPS = { 'isolated-vm': '6.2.0', 're2-wasm': '1.0.2', '@earendil-works/pi-ai': '0.82.0' };

const BOUNDS: Record<string, number> = {
  indexedSlotP95Ms: 25,
  treeMatch10kMaxMs: 2000,
  contentRootMaxMs: 2000,
  draftMaxMs: 2000,
  issueProjectionMaxMs: 250,
  sealMaxMs: 30000,
  peakRssBytes: 512 * 1024 * 1024,
};

/**
 * Every case the SUCCESS profile evidence `cases` array must contain (the six
 * frozen bound cases + the two owner-outline diagnostics the benchmark is
 * required to emit).
 */
const REQUIRED_SUCCESS_CASE_IDS: readonly string[] = [
  'indexed-slot-read',
  'tree-match-10k',
  'content-root-64mib',
  'draft-journal-2k',
  'seal-assembler-custody',
  'authorized-projection-500-issues',
  'owner-outline-cold',
  'owner-outline-hot',
];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** The exact Step 7/8 gate set, all green. */
function zeroGates(): Array<Record<string, unknown>> {
  return [
    { id: 'typecheck', label: 'TypeScript 类型检查', command: 'npm run check', exitCode: 0 },
    { id: 'unit-tests', label: '单元/集成测试', command: 'npm test -- --reporter=dot', exitCode: 0 },
    { id: 'build', label: '客户端与服务端构建', command: 'npm run build', exitCode: 0 },
    { id: 'e2e', label: 'Playwright 端到端', command: 'npm run e2e', exitCode: 0 },
    {
      id: 'structured-acceptance',
      label: '结构化槽端到端验收（注入环境）',
      command: 'npm run verify:structured-slots -- --acceptance-only --capability injected',
      exitCode: 0,
    },
    {
      id: 'forge-pi-slot-preflight',
      label: '锁定 Pi 0.82 预校验计费特征',
      command: 'npx vitest run src/server/runtime/pi-agent-runtime.test.ts -t Task 14 Step 1',
      exitCode: 0,
    },
  ];
}

function validSuccessEvidence(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    mode: 'integrated-qualify',
    runner: RUNNER,
    gitCommit: REAL_GIT_COMMIT,
    sourceTreeDigest: REAL_SOURCE_DIGEST,
    packageLockSha256: REAL_LOCK_SHA,
    dependencyVersions: DEPS,
    warmupCount: 3,
    sampleCount: 10,
    peakRssBytes: 300 * 1024 * 1024,
    diskBytes: 17_000_000,
    cases: REQUIRED_SUCCESS_CASE_IDS.map((id, index) => ({
      id,
      rawSampleDigest: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64), 'f'.repeat(64), '9a'.repeat(32), '8b'.repeat(32)][index]!,
      samples: 10,
      warmup: 3,
      p50Ms: 4.2,
      p95Ms: 5.4,
      maxMs: 5.4,
      postCasePeakRssBytes: 300 * 1024 * 1024,
    })),
    candidatePercentage: 25,
    selectionReason: 'greatest passing scale 25%',
    frozenLimits: STRUCTURED_SLOT_PROFILE_CANDIDATE as StructuredSlotLimitsV1,
    bounds: BOUNDS,
    perScaleResults: [
      {
        scale: 25,
        results: [
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
        ],
        peakRssBytes: 300 * 1024 * 1024,
        diskBytes: 17_000_000,
        violations: [],
        passed: true,
      },
    ],
  };
}

function failureEvidence(outcome: 'no_scale_passed' | 'child_failed'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    mode: 'integrated-qualify',
    outcome,
    runner: RUNNER,
    gitCommit: REAL_GIT_COMMIT,
    sourceTreeDigest: REAL_SOURCE_DIGEST,
    packageLockSha256: REAL_LOCK_SHA,
    dependencyVersions: DEPS,
    bounds: BOUNDS,
    perScaleResults: [
      {
        scale: 100,
        results: [
          {
            id: 'indexed-slot-read',
            description: 'indexed slot read @ 100%',
            warmup: 3,
            samples: 10,
            p50Ms: 4.2,
            p95Ms: 5.4,
            maxMs: 5.4,
            sampleDigest: 'c'.repeat(64),
            postCasePeakRssBytes: 2_714_386_432,
          },
        ],
        peakRssBytes: 2_714_386_432,
        diskBytes: 0,
        violations: ['peak RSS 2714386432 > 536870912'],
        passed: false,
      },
    ],
    selectionReason: 'no 100/75/50/25% scale of the candidate axes satisfied every acceptance bound',
  };
}

interface Workspace {
  dir: string;
  evidencePath: string;
  profilePath: string;
  manifestPath: string;
  releaseEvidencePath: string;
  evidence: Record<string, unknown>;
  evidenceDigest: string;
  finalProfileDigest: string;
}

/**
 * Builds an isolated temp workspace: a SUCCESS (or injected) profile evidence
 * file, a `final` profile referencing it, and a disabled capability manifest.
 * Never touches the checked-in profile/manifest/evidence.
 */
function createWorkspace(evidenceObj: Record<string, unknown> = validSuccessEvidence()): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'forge-verify-structured-'));
  tempDirs.push(dir);
  const evidencePath = join(dir, 'structured-slot-platform-profile-v1.json');
  const profilePath = join(dir, 'platform-profile-v1.json');
  const manifestPath = join(dir, 'runtime-capability-v1.json');
  const releaseEvidencePath = join(dir, 'structured-slot-release-v1.json');

  writeFileSync(evidencePath, `${JSON.stringify(evidenceObj, null, 2)}\n`, 'utf8');
  const evidenceDigest = canonicalJsonSha256(evidenceObj);
  const finalProfile = {
    version: 1,
    status: 'final',
    identity: 'forge-structured-runtime/v1',
    limits: STRUCTURED_SLOT_PROFILE_CANDIDATE,
    evidenceDigest,
  };
  writeFileSync(profilePath, `${JSON.stringify(finalProfile, null, 2)}\n`, 'utf8');
  const finalProfileDigest = profileCanonicalDigest(loadStructuredPlatformProfile(profilePath));
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        version: 1,
        status: 'disabled',
        profileIdentity: null,
        profileDigest: null,
        evidenceDigest: null,
        requiredAbis: ['forge-validator/v1', 'forge-assembler/v1'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { dir, evidencePath, profilePath, manifestPath, releaseEvidencePath, evidence: evidenceObj, evidenceDigest, finalProfileDigest };
}

function validReleaseEvidence(
  ws: Workspace,
  overrides: Record<string, unknown> = {},
  gates: Array<Record<string, unknown>> = zeroGates(),
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    gate: 'verify:structured-slots',
    mode: 'qualify',
    checkpointCommit: REAL_GIT_COMMIT,
    sourceTreeDigest: REAL_SOURCE_DIGEST,
    packageLockSha256: REAL_LOCK_SHA,
    profileEvidencePath: RELEASE_PROFILE_EVIDENCE_PATH,
    profileEvidenceDigest: ws.evidenceDigest,
    finalProfilePath: RELEASE_FINAL_PROFILE_PATH,
    finalProfileDigest: ws.finalProfileDigest,
    requiredAbis: ['forge-validator/v1', 'forge-assembler/v1'],
    piPreflightCharacterization: RELEASE_PI_PREFLIGHT_CHARACTERIZATION,
    gates,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

function writeRelease(ws: Workspace, release: Record<string, unknown>): string {
  writeFileSync(ws.releaseEvidencePath, `${JSON.stringify(release, null, 2)}\n`, 'utf8');
  return ws.releaseEvidencePath;
}

function promotePaths(ws: Workspace) {
  return {
    profilePath: ws.profilePath,
    profileEvidencePath: ws.evidencePath,
    manifestPath: ws.manifestPath,
    workspaceRoot: ws.dir,
  };
}

function qualifyPaths(ws: Workspace) {
  return {
    profilePath: ws.profilePath,
    profileEvidencePath: ws.evidencePath,
    manifestPath: ws.manifestPath,
    releaseEvidencePath: ws.releaseEvidencePath,
  };
}

/* -------------------------------------------------------------------------- */
/* validateReleaseEvidence: exact schema                                       */
/* -------------------------------------------------------------------------- */

describe('validateReleaseEvidence (P1-3 schema)', () => {
  const ws = createWorkspace();

  it('accepts a clean all-zero-gate release evidence', () => {
    expect(() => validateReleaseEvidence(validReleaseEvidence(ws), RELEASE_EVIDENCE_GATE_IDS)).not.toThrow();
  });

  it('rejects an unknown top-level field', () => {
    const release = validReleaseEvidence(ws, { stray: 1 });
    expect(() => validateReleaseEvidence(release, RELEASE_EVIDENCE_GATE_IDS)).toThrow(
      /unknown field 'stray'/,
    );
  });

  it('rejects wrong mode (integrated-qualify is never a release mode)', () => {
    const release = validReleaseEvidence(ws, { mode: 'integrated-qualify' });
    expect(() => validateReleaseEvidence(release, RELEASE_EVIDENCE_GATE_IDS)).toThrow(
      /mode must be "qualify"/,
    );
  });

  it('rejects a missing mode', () => {
    const release = validReleaseEvidence(ws);
    delete release.mode;
    expect(() => validateReleaseEvidence(release, RELEASE_EVIDENCE_GATE_IDS)).toThrow(/mode must be "qualify"/);
  });

  it('rejects a non-zero gate exitCode', () => {
    const gates = zeroGates().map((gate, i) => (i === 0 ? { ...gate, exitCode: 1 } : gate));
    const release = validReleaseEvidence(ws, {}, gates);
    expect(() => validateReleaseEvidence(release, RELEASE_EVIDENCE_GATE_IDS)).toThrow(/exitCode must be 0/);
  });

  it('rejects a missing gate', () => {
    const release = validReleaseEvidence(ws, {}, zeroGates().slice(0, 5));
    expect(() => validateReleaseEvidence(release, RELEASE_EVIDENCE_GATE_IDS)).toThrow(
      /missing required id 'forge-pi-slot-preflight'/,
    );
  });

  it('rejects a duplicate gate', () => {
    const gates = [...zeroGates(), { ...zeroGates()[0], label: 'duplicate typecheck' }];
    const release = validReleaseEvidence(ws, {}, gates);
    expect(() => validateReleaseEvidence(release, RELEASE_EVIDENCE_GATE_IDS)).toThrow(
      /duplicate id 'typecheck'/,
    );
  });

  it('rejects an extra gate id', () => {
    const gates = [...zeroGates(), { id: 'mystery', label: 'x', command: 'x', exitCode: 0 }];
    const release = validReleaseEvidence(ws, {}, gates);
    expect(() => validateReleaseEvidence(release, RELEASE_EVIDENCE_GATE_IDS)).toThrow(
      /unexpected id 'mystery'/,
    );
  });

  it('rejects a malformed 64-hex digest', () => {
    const release = validReleaseEvidence(ws, { sourceTreeDigest: 'not-a-digest' });
    expect(() => validateReleaseEvidence(release, RELEASE_EVIDENCE_GATE_IDS)).toThrow(
      /sourceTreeDigest must be a 64-hex digest/,
    );
  });

  it('rejects the wrong profileEvidencePath / finalProfilePath / piPreflightCharacterization', () => {
    expect(() =>
      validateReleaseEvidence(validReleaseEvidence(ws, { profileEvidencePath: 'other.json' }), RELEASE_EVIDENCE_GATE_IDS),
    ).toThrow(/profileEvidencePath must be/);
    expect(() =>
      validateReleaseEvidence(validReleaseEvidence(ws, { finalProfilePath: 'other.json' }), RELEASE_EVIDENCE_GATE_IDS),
    ).toThrow(/finalProfilePath must be/);
    expect(() =>
      validateReleaseEvidence(
        validReleaseEvidence(ws, { piPreflightCharacterization: 'other/v1' }),
        RELEASE_EVIDENCE_GATE_IDS,
      ),
    ).toThrow(/piPreflightCharacterization must be/);
  });

  it('rejects an unparseable observedAt timestamp', () => {
    const release = validReleaseEvidence(ws, { observedAt: 'not-a-timestamp' });
    expect(() => validateReleaseEvidence(release, RELEASE_EVIDENCE_GATE_IDS)).toThrow(
      /observedAt must be a parseable ISO timestamp/,
    );
  });

  it('rejects an empty requiredAbis array', () => {
    const release = validReleaseEvidence(ws, { requiredAbis: [] });
    expect(() => validateReleaseEvidence(release, RELEASE_EVIDENCE_GATE_IDS)).toThrow(
      /requiredAbis must be a non-empty string array/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* runQualify: release evidence only after ALL gates pass                      */
/* -------------------------------------------------------------------------- */

describe('runQualify (P1-3 gate ordering)', () => {
  it('a failed gate returns 1, writes NO release evidence, and writes a .failed marker', () => {
    const ws = createWorkspace();
    const failingGates = zeroGates().map((gate, i) => (i === 1 ? { ...gate, exitCode: 1 } : gate));
    const result = runQualify(qualifyPaths(ws), { gates: () => failingGates });
    expect(result).toBe(1);
    expect(existsSync(ws.releaseEvidencePath)).toBe(false);
    const failedMarkers = readdirSync(ws.dir).filter((name) =>
      name.startsWith('structured-slot-release-v1.json.failed-'),
    );
    expect(failedMarkers).toHaveLength(1);
    const marker = JSON.parse(readFileSync(join(ws.dir, failedMarkers[0]!), 'utf8'));
    expect(marker.record).toBe('qualify-failed');
    expect(marker.gates.some((gate: { id: string; exitCode: number }) => gate.exitCode !== 0)).toBe(true);
  });

  it('a failed qualification leaves a stale release evidence untouched', () => {
    const ws = createWorkspace();
    writeFileSync(ws.releaseEvidencePath, 'STALE-SENTINEL\n', 'utf8');
    const failingGates = zeroGates().map((gate, i) => (i === 0 ? { ...gate, exitCode: 3 } : gate));
    const result = runQualify(qualifyPaths(ws), { gates: () => failingGates });
    expect(result).toBe(1);
    expect(readFileSync(ws.releaseEvidencePath, 'utf8')).toBe('STALE-SENTINEL\n');
    expect(readdirSync(ws.dir).some((name) => name.startsWith('structured-slot-release-v1.json.failed-'))).toBe(true);
  });

  it('an all-green gate set writes the release evidence and no failure marker', () => {
    const ws = createWorkspace();
    const result = runQualify(qualifyPaths(ws), { gates: () => zeroGates() });
    expect(result).toBe(0);
    expect(existsSync(ws.releaseEvidencePath)).toBe(true);
    const written = JSON.parse(readFileSync(ws.releaseEvidencePath, 'utf8')) as Record<string, unknown>;
    expect(() => validateReleaseEvidence(written, RELEASE_EVIDENCE_GATE_IDS)).not.toThrow();
    expect(written.mode).toBe('qualify');
    expect(written.gate).toBe('verify:structured-slots');
    expect(readdirSync(ws.dir).some((name) => name.includes('.failed-'))).toBe(false);
    expect(readdirSync(ws.dir).some((name) => name.includes('.tmp-'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* runPromoteCapability: exact-validate BEFORE digest cross-checks             */
/* -------------------------------------------------------------------------- */

describe('runPromoteCapability (P1-3 fail-closed promotion)', () => {
  it('rejects a release evidence with a non-zero gate', () => {
    const ws = createWorkspace();
    const gates = zeroGates().map((gate, i) => (i === 2 ? { ...gate, exitCode: 1 } : gate));
    const release = validReleaseEvidence(ws, {}, gates);
    const path = writeRelease(ws, release);
    expect(() => runPromoteCapability(path, promotePaths(ws), { porcelain: () => [] })).toThrow(/exitCode must be 0/);
  });

  it('rejects a release evidence with a missing gate', () => {
    const ws = createWorkspace();
    const release = validReleaseEvidence(ws, {}, zeroGates().slice(0, 5));
    const path = writeRelease(ws, release);
    expect(() => runPromoteCapability(path, promotePaths(ws), { porcelain: () => [] })).toThrow(
      /missing required id 'forge-pi-slot-preflight'/,
    );
  });

  it('rejects a release evidence with a duplicate gate', () => {
    const ws = createWorkspace();
    const gates = [...zeroGates(), { ...zeroGates()[0], label: 'duplicate typecheck' }];
    const release = validReleaseEvidence(ws, {}, gates);
    const path = writeRelease(ws, release);
    expect(() => runPromoteCapability(path, promotePaths(ws), { porcelain: () => [] })).toThrow(
      /duplicate id 'typecheck'/,
    );
  });

  it('rejects a release evidence with the wrong mode (integrated-qualify)', () => {
    const ws = createWorkspace();
    const release = validReleaseEvidence(ws, { mode: 'integrated-qualify' });
    const path = writeRelease(ws, release);
    expect(() => runPromoteCapability(path, promotePaths(ws), { porcelain: () => [] })).toThrow(
      /mode must be "qualify"/,
    );
  });

  it('rejects arbitrary JSON whose digests match but whose structure/gates are wrong (schema runs FIRST)', () => {
    const ws = createWorkspace();
    const release = validReleaseEvidence(ws);
    delete (release as Record<string, unknown>).gates;
    const path = writeRelease(ws, release);
    expect(() => runPromoteCapability(path, promotePaths(ws), { porcelain: () => [] })).toThrow(/gates/);
    // The manifest must still be disabled: the schema gate fired before any
    // digest/checkpoint cross-check could reach the manifest write.
    const manifest = JSON.parse(readFileSync(ws.manifestPath, 'utf8')) as { status: string };
    expect(manifest.status).toBe('disabled');
  });

  it('rejects a release evidence whose gate set has an extra id', () => {
    const ws = createWorkspace();
    const gates = [...zeroGates(), { id: 'mystery', label: 'x', command: 'x', exitCode: 0 }];
    const release = validReleaseEvidence(ws, {}, gates);
    const path = writeRelease(ws, release);
    expect(() => runPromoteCapability(path, promotePaths(ws), { porcelain: () => [] })).toThrow(
      /unexpected id 'mystery'/,
    );
  });

  it.each(['no_scale_passed', 'child_failed'] as const)(
    'rejects a profile evidence with outcome %s (a failed qualification must never promote)',
    (outcome) => {
      const failure = failureEvidence(outcome);
      // Sanity: the failure shape is a legit honest-failure record...
      expect(() => validateProfileEvidenceFailure(failure)).not.toThrow();
      // ...but the SUCCESS validator (which promotion requires) rejects it.
      expect(() => validateProfileEvidence(failure)).toThrow();
      const ws = createWorkspace(failure);
      const release = validReleaseEvidence(ws);
      const path = writeRelease(ws, release);
      expect(() => runPromoteCapability(path, promotePaths(ws), { porcelain: () => [] })).toThrow(/outcome/);
      const manifest = JSON.parse(readFileSync(ws.manifestPath, 'utf8')) as { status: string };
      expect(manifest.status).toBe('disabled');
    },
  );

  it('writes the ENABLED manifest for a clean all-zero-gate release (isolated temp workspace)', () => {
    const ws = createWorkspace();
    const release = validReleaseEvidence(ws);
    const path = writeRelease(ws, release);
    // Phase-independent (Task 19): the promote is fully self-contained in the
    // temp workspace (manifest path + requiredAbis are injected via
    // promotePaths(ws)); it must NEVER touch the checked-in production manifest,
    // whatever phase it is in. Capture the real manifest before the promote and
    // assert it is byte-identical afterwards.
    const realManifestPath = resolve(
      REPO_ROOT,
      'src/server/structured-slots/runtime-capability-v1.json',
    );
    const realManifestBefore = readFileSync(realManifestPath, 'utf8');
    const result = runPromoteCapability(path, promotePaths(ws), { porcelain: () => [] });
    expect(result).toBe(0);
    const manifest = JSON.parse(readFileSync(ws.manifestPath, 'utf8')) as {
      version: number;
      status: string;
      profileIdentity: string | null;
      profileDigest: string | null;
      evidenceDigest: string | null;
      requiredAbis: string[];
    };
    expect(manifest.status).toBe('enabled');
    expect(manifest.version).toBe(1);
    expect(manifest.profileIdentity).toBe('forge-structured-runtime/v1');
    expect(manifest.profileDigest).toBe(ws.finalProfileDigest);
    expect(manifest.evidenceDigest).toBe(canonicalJsonSha256(release));
    expect(manifest.requiredAbis).toEqual(['forge-validator/v1', 'forge-assembler/v1']);

    // The checked-in production manifest is untouched: promote wrote only the
    // temp workspace manifest.
    expect(readFileSync(realManifestPath, 'utf8')).toBe(realManifestBefore);
  });

  it('rejects a release evidence whose requiredAbis do not match the current manifest', () => {
    const ws = createWorkspace();
    const release = validReleaseEvidence(ws, { requiredAbis: ['forge-validator/v1'] });
    const path = writeRelease(ws, release);
    expect(() => runPromoteCapability(path, promotePaths(ws), { porcelain: () => [] })).toThrow(
      /required ABI list 与当前 manifest 不一致/,
    );
  });
});
