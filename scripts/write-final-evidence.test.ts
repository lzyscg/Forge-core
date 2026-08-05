/**
 * Forge Core final evidence aggregation tests (plan Phase D Task 5 Step 1).
 *
 * The first case is the plan's verbatim acceptance case: all passing
 * sanitized reports mark every capability `verified`, and a missing recovery
 * report throws `EVIDENCE_INCOMPLETE`. The fixture builders reproduce the
 * exact schemas emitted by verify-ui (public/development-evidence.json),
 * verify-backend (phase-b.json), verify-runtime (phase-c.json), the real
 * acceptance runner (phase-d-real.json) and the recovery acceptance runner
 * (phase-d-recovery.json).
 *
 * Commit ancestry is checked against the real Git history by default: the
 * fixture commits are actual ancestors of every HEAD on this branch, so the
 * verbatim case exercises the production ancestry path end to end.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../src/client/mock/development-capabilities';
import {
  aggregateEvidence,
  mergeFinalAcceptance,
  writeFinalEvidenceAtomic,
  type FinalEvidenceAggregate,
  type FinalEvidenceReports,
} from './write-final-evidence';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

const ALL_CAPABILITY_IDS: string[] = CAPABILITIES.map(([id]) => id);
/**
 * Phase E rows added to the registry after the frozen Phase D real reports
 * were produced: the real loop and recovery runs predate these capabilities,
 * so no Phase D report can ever prove them `verified` (integrity: coverage
 * sets stay historical facts, see REAL_LOOP_COVERED/RECOVERY_COVERED).
 */
const PHASE_E_IDS: ReadonlySet<string> = new Set([
  'process_trace',
  'agent_workspace',
  'task_clone',
]);
/** Gate B backend set (phase-b.json backendConnectedCapabilities). */
const PHASE_B_SIX = [
  'templates',
  'template_reload',
  'task_creation',
  'task_recovery',
  'workspace',
  'artifacts',
];
/** Commits recorded by the real sanitized reports (all ancestors of HEAD). */
const BACKEND_REPORT_COMMIT = headCommit();
const RUNTIME_REPORT_COMMIT = headCommit();
const REAL_LOOP_REPORT_COMMIT = headCommit();
const RECOVERY_REPORT_COMMIT = headCommit();
/** A SHA that exists in no history: must always fail the ancestry check. */
const STALE_COMMIT = 'ffffffffffffffffffffffffffffffffffffffff';

function headCommit(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error('git rev-parse HEAD failed');
  return result.stdout.trim();
}

/* -------------------------------------------------------------------------- */
/* Fixture builders: exact schemas of the five sanitized reports               */
/* -------------------------------------------------------------------------- */

interface UiReportOptions {
  outcome?: string;
  commit?: string | null;
  passedCapabilities?: string[];
}

function uiEvidenceReport(options: UiReportOptions = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    outcome: options.outcome ?? 'passed',
    observedAt: '2026-08-03T07:30:00.000Z',
    commit: options.commit === undefined ? headCommit() : options.commit,
    command: 'npm run verify:ui',
    passedCapabilities: options.passedCapabilities ?? [...ALL_CAPABILITY_IDS],
    backendOutcome: 'passed',
    backendConnectedCapabilities: [...ALL_CAPABILITY_IDS],
  };
}

interface BackendReportOptions {
  outcome?: string;
  commit?: string | null;
  backendConnectedCapabilities?: string[];
}

function backendReport(options: BackendReportOptions = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    gate: 'verify:backend',
    command: 'npm run verify:backend',
    observedAt: '2026-08-03T07:31:00.000Z',
    commit: options.commit === undefined ? BACKEND_REPORT_COMMIT : options.commit,
    outcome: options.outcome ?? 'passed',
    gates: [
      { id: 'gateway-contracts', exitCode: 0, passed: 122, failed: 0, skipped: 0 },
      { id: 'server-modules', exitCode: 0, passed: 105, failed: 0, skipped: 0 },
      { id: 'typecheck', exitCode: 0, passed: 0, failed: 0, skipped: 0 },
      { id: 'build', exitCode: 0, passed: 0, failed: 0, skipped: 0 },
      { id: 'e2e-http-persistence', exitCode: 0, passed: 4, failed: 0, skipped: 0 },
    ],
    backendConnectedCapabilities: options.backendConnectedCapabilities ?? [...PHASE_B_SIX],
  };
}

interface RuntimeReportOptions {
  outcome?: string;
  commit?: string | null;
  piBoundary?: Record<string, unknown>;
  backendConnectedCapabilities?: string[];
}

function runtimeReport(options: RuntimeReportOptions = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    gate: 'verify:runtime',
    command: 'npm run verify:runtime',
    observedAt: '2026-08-03T07:32:00.000Z',
    commit: options.commit === undefined ? RUNTIME_REPORT_COMMIT : options.commit,
    outcome: options.outcome ?? 'passed',
    gates: [
      { id: 'runtime-modules', exitCode: 0, passed: 197, failed: 0, skipped: 0 },
      { id: 'e2e-runtime-loop', exitCode: 0, passed: 10, failed: 0, skipped: 0 },
      { id: 'e2e-process-recovery', exitCode: 0, passed: 2, failed: 0, skipped: 0 },
    ],
    piBoundary: options.piBoundary ?? {
      present: true,
      passed: true,
      outcome: 'succeeded',
      checks: {
        fiveCustomToolsOnly: true,
        builtinToolsDisabled: true,
        noBuiltInToolCalls: true,
        inMemorySession: true,
        compactionDisabled: true,
        retryDisabled: true,
        noDiscoveredResources: true,
        promptTemplatesDisabled: true,
        legalCustomActionObserved: true,
      },
      secretFindings: 0,
      thinkingFindings: 0,
      boundaryViolations: 0,
    },
    backendConnectedCapabilities: options.backendConnectedCapabilities ?? [...ALL_CAPABILITY_IDS],
  };
}

interface ArtifactVersionFixture {
  version: number;
  contentHash: string;
  final: boolean;
}

const REAL_LOOP_VERSIONS: ArtifactVersionFixture[] = [
  {
    version: 1,
    contentHash: '31b5b70c61f2bf663cc1a7925031b1ca89a0b1d1ba0f7a174db3b982aaccf2dd',
    final: false,
  },
  {
    version: 2,
    contentHash: '393045df3954868e3c65455311b81bf3fc38af33679d78086b31b6df39ba5567',
    final: false,
  },
  {
    version: 3,
    contentHash: '9b84786acab004fb94f38d0f417f9c1f1e61e963c006869e2b0b161cecca0ab0',
    final: true,
  },
];

interface RealLoopReportOptions {
  outcome?: string;
  taskStatus?: string;
  commit?: string | null;
  artifactVersions?: ArtifactVersionFixture[];
  finalArtifactVersion?: number;
  secretFindingCount?: number;
}

function realLoopReport(options: RealLoopReportOptions = {}): Record<string, unknown> {
  return {
    schemaVersion: 'forge-core.real-acceptance/1',
    outcome: options.outcome ?? 'completed',
    commit: options.commit === undefined ? REAL_LOOP_REPORT_COMMIT : options.commit,
    versions: { node: 'v22.22.3', npm: '10.9.8', pi: '0.82.0' },
    providerId: 'deepseek',
    writerModelId: 'deepseek-v4-flash',
    reviewerModelId: 'deepseek-v4-flash',
    taskId: 'b8721e0d',
    startedAt: '2026-08-03T05:43:13.578Z',
    finishedAt: '2026-08-03T05:51:00.696Z',
    taskStatus: options.taskStatus ?? 'completed',
    agentCallCount: 6,
    attemptCount: 6,
    executedRouteKinds: { artifact: 3, message: 2 },
    artifactVersions: options.artifactVersions ?? REAL_LOOP_VERSIONS,
    finalArtifactVersion: options.finalArtifactVersion ?? 3,
    finalArtifactHash: '9b84786acab004fb94f38d0f417f9c1f1e61e963c006869e2b0b161cecca0ab0',
    restartCount: 0,
    publicErrorCodes: [],
    secretFindingCount: options.secretFindingCount ?? 0,
  };
}

const RECOVERY_VERSIONS: ArtifactVersionFixture[] = [
  {
    version: 1,
    contentHash: '84be78402322f0bbb946ae899b1bf03adafb01b674351b01079a205ae7ebc8d8',
    final: false,
  },
  {
    version: 2,
    contentHash: '3af14b0cec7c3d565466bdc5eeafe97e45934bccfed1fbb1dbc580ab1c6e6bfd',
    final: true,
  },
];

interface RecoveryReportOptions {
  outcome?: string;
  commit?: string | null;
  restartCount?: number;
  interruptedObserved?: boolean;
  reconciliation?: Record<string, unknown>;
  artifactVersions?: ArtifactVersionFixture[];
  finalArtifactVersion?: number;
  secretFindingCount?: number;
  hiddenThinkingFindingCount?: number;
}

function recoveryReport(options: RecoveryReportOptions = {}): Record<string, unknown> {
  return {
    schemaVersion: 'forge-core.real-recovery-acceptance/1',
    outcome: options.outcome ?? 'completed',
    commit: options.commit === undefined ? RECOVERY_REPORT_COMMIT : options.commit,
    versions: { node: 'v22.22.3', npm: '10.9.8', pi: '0.82.0' },
    providerId: 'deepseek',
    writerModelId: 'deepseek-v4-flash',
    reviewerModelId: 'deepseek-v4-flash',
    taskId: 'f717bfbb',
    startedAt: '2026-08-03T06:55:17.956Z',
    finishedAt: '2026-08-03T07:01:43.483Z',
    taskStatus: 'completed',
    agentCallCount: 4,
    attemptCount: 4,
    executedRouteKinds: { artifact: 2, message: 1 },
    artifactVersions: options.artifactVersions ?? RECOVERY_VERSIONS,
    finalArtifactVersion: options.finalArtifactVersion ?? 2,
    finalArtifactHash: '3af14b0cec7c3d565466bdc5eeafe97e45934bccfed1fbb1dbc580ab1c6e6bfd',
    restartCount: options.restartCount ?? 1,
    interruptedObserved: options.interruptedObserved ?? true,
    boundaryStops: 2,
    reconciliation: options.reconciliation ?? {
      mismatchCount: 0,
      eventCount: 19,
      nodeCount: 8,
      routeCount: 3,
      artifactCount: 2,
      domNodeCount: 8,
      domArtifactArrows: 2,
      domMessageArrows: 1,
      domVersionItems: 2,
    },
    screenshots: [
      { name: 'template-detail.png', width: 1440, height: 1000 },
      { name: 'task-list.png', width: 1440, height: 1000 },
      { name: 'production-after-v1.png', width: 1440, height: 1000 },
      { name: 'production-after-review-return.png', width: 1440, height: 1000 },
      { name: 'production-completed-final-preview.png', width: 1440, height: 1000 },
      { name: 'development-progress.png', width: 1440, height: 1000 },
      { name: 'production-completed-mobile.png', width: 390, height: 844 },
    ],
    publicErrorCodes: [],
    secretFindingCount: options.secretFindingCount ?? 0,
    hiddenThinkingFindingCount: options.hiddenThinkingFindingCount ?? 0,
  };
}

function allPassingSanitizedReports(): FinalEvidenceReports {
  return {
    ui: uiEvidenceReport(),
    backend: backendReport(),
    runtime: runtimeReport(),
    realLoop: realLoopReport(),
    recovery: recoveryReport(),
  };
}

function withMissingRecoveryReport(): FinalEvidenceReports {
  const reports = allPassingSanitizedReports();
  delete reports.recovery;
  return reports;
}

/* -------------------------------------------------------------------------- */
/* Plan Step 1 verbatim acceptance case                                        */
/* -------------------------------------------------------------------------- */

describe('aggregateEvidence final capability verdicts', () => {
  it('marks covered capabilities verified while phase E rows stay backend_connected', () => {
    const evidence = aggregateEvidence(allPassingSanitizedReports());
    for (const item of evidence.capabilities) {
      // The frozen Phase D real reports predate the Phase E rows; every
      // covered capability is verified, Phase E rows stay backend_connected.
      expect(item.realAcceptance).toBe(
        PHASE_E_IDS.has(item.id) ? 'backend_connected' : 'verified',
      );
    }
    expect(
      evidence.capabilities.filter((item) => item.realAcceptance === 'verified'),
    ).toHaveLength(ALL_CAPABILITY_IDS.length - PHASE_E_IDS.size);
    expect(() => aggregateEvidence(withMissingRecoveryReport())).toThrowError('EVIDENCE_INCOMPLETE');
  });

  it('lists exactly the thirteen registry capabilities in matrix order with labels', () => {
    const evidence = aggregateEvidence(allPassingSanitizedReports());
    expect(evidence.capabilities.map((item) => [item.id, item.label])).toEqual(
      CAPABILITIES.map(([id, label]) => [id, label]),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Missing / stale / failed reports -> EVIDENCE_INCOMPLETE                     */
/* -------------------------------------------------------------------------- */

describe('aggregateEvidence rejects unusable reports', () => {
  function without(key: keyof FinalEvidenceReports): FinalEvidenceReports {
    const reports = allPassingSanitizedReports();
    delete reports[key];
    return reports;
  }

  it.each([
    ['ui', (): FinalEvidenceReports => without('ui')],
    ['backend', (): FinalEvidenceReports => without('backend')],
    ['runtime', (): FinalEvidenceReports => without('runtime')],
    ['realLoop', (): FinalEvidenceReports => without('realLoop')],
    ['recovery', (): FinalEvidenceReports => without('recovery')],
  ])('throws EVIDENCE_INCOMPLETE when the %s report is missing', (_name, build) => {
    expect(() => aggregateEvidence(build())).toThrowError('EVIDENCE_INCOMPLETE');
  });

  it.each([
    ['ui', () => ({ ...allPassingSanitizedReports(), ui: uiEvidenceReport({ outcome: 'failed' }) })],
    ['backend', () => ({ ...allPassingSanitizedReports(), backend: backendReport({ outcome: 'failed' }) })],
    ['runtime', () => ({ ...allPassingSanitizedReports(), runtime: runtimeReport({ outcome: 'failed' }) })],
    [
      'realLoop',
      () => ({
        ...allPassingSanitizedReports(),
        realLoop: realLoopReport({ outcome: 'task_failed', taskStatus: 'retryable_failure' }),
      }),
    ],
    ['recovery', () => ({ ...allPassingSanitizedReports(), recovery: recoveryReport({ outcome: 'deadline_exceeded' }) })],
  ])('throws EVIDENCE_INCOMPLETE when the %s outcome is not passing', (_name, build) => {
    expect(() => aggregateEvidence(build())).toThrowError('EVIDENCE_INCOMPLETE');
  });

  it.each([
    ['ui', { commit: null }],
    ['backend', { commit: null }],
    ['runtime', { commit: null }],
    ['realLoop', { commit: null }],
    ['recovery', { commit: null }],
  ])('throws EVIDENCE_INCOMPLETE when the %s report carries no commit', (name, patch) => {
    const reports = allPassingSanitizedReports();
    if (name === 'ui') reports.ui = uiEvidenceReport({ commit: patch.commit });
    if (name === 'backend') reports.backend = backendReport({ commit: patch.commit });
    if (name === 'runtime') reports.runtime = runtimeReport({ commit: patch.commit });
    if (name === 'realLoop') reports.realLoop = realLoopReport({ commit: patch.commit });
    if (name === 'recovery') reports.recovery = recoveryReport({ commit: patch.commit });
    expect(() => aggregateEvidence(reports)).toThrowError('EVIDENCE_INCOMPLETE');
  });

  it('throws EVIDENCE_INCOMPLETE when a report commit is not an ancestor of HEAD', () => {
    const reports = allPassingSanitizedReports();
    reports.realLoop = realLoopReport({ commit: STALE_COMMIT });
    expect(() => aggregateEvidence(reports)).toThrowError('EVIDENCE_INCOMPLETE');
  });

  it('throws EVIDENCE_INCOMPLETE when the real loop never produced V2', () => {
    const reports = allPassingSanitizedReports();
    reports.realLoop = realLoopReport({
      artifactVersions: [REAL_LOOP_VERSIONS[0], { version: 3, contentHash: '9'.repeat(64), final: true }],
      finalArtifactVersion: 3,
    });
    expect(() => aggregateEvidence(reports)).toThrowError('EVIDENCE_INCOMPLETE');
  });

  it('throws EVIDENCE_INCOMPLETE when the final artifact version is not at least V2', () => {
    const reports = allPassingSanitizedReports();
    reports.realLoop = realLoopReport({
      artifactVersions: [{ version: 1, contentHash: '3'.repeat(64), final: true }],
      finalArtifactVersion: 1,
    });
    expect(() => aggregateEvidence(reports)).toThrowError('EVIDENCE_INCOMPLETE');
  });

  it('throws EVIDENCE_INCOMPLETE when recovery never restarted the process', () => {
    const reports = allPassingSanitizedReports();
    reports.recovery = recoveryReport({ restartCount: 0, interruptedObserved: false });
    expect(() => aggregateEvidence(reports)).toThrowError('EVIDENCE_INCOMPLETE');
  });

  it('throws EVIDENCE_INCOMPLETE when file/HTTP/UI views disagree', () => {
    const reports = allPassingSanitizedReports();
    reports.recovery = recoveryReport({
      reconciliation: { mismatchCount: 2, eventCount: 19 },
    });
    expect(() => aggregateEvidence(reports)).toThrowError('EVIDENCE_INCOMPLETE');
  });

  it.each([
    ['real loop secret findings', () => {
      const reports = allPassingSanitizedReports();
      reports.realLoop = realLoopReport({ secretFindingCount: 1 });
      return reports;
    }],
    ['recovery secret findings', () => {
      const reports = allPassingSanitizedReports();
      reports.recovery = recoveryReport({ secretFindingCount: 3 });
      return reports;
    }],
    ['recovery hidden-thinking findings', () => {
      const reports = allPassingSanitizedReports();
      reports.recovery = recoveryReport({ hiddenThinkingFindingCount: 1 });
      return reports;
    }],
    ['Pi boundary violations inside the runtime report', () => {
      const reports = allPassingSanitizedReports();
      reports.runtime = runtimeReport({
        piBoundary: { present: true, passed: false, outcome: 'succeeded', secretFindings: 0, thinkingFindings: 0, boundaryViolations: 1 },
      });
      return reports;
    }],
  ])('throws EVIDENCE_INCOMPLETE on %s', (_label, build) => {
    expect(() => aggregateEvidence(build())).toThrowError('EVIDENCE_INCOMPLETE');
  });
});

/* -------------------------------------------------------------------------- */
/* Conservative capability mapping                                             */
/* -------------------------------------------------------------------------- */

describe('aggregateEvidence conservative mapping', () => {
  it('keeps a capability backend_connected when the UI evidence does not prove it', () => {
    const reports = allPassingSanitizedReports();
    reports.ui = uiEvidenceReport({
      passedCapabilities: ALL_CAPABILITY_IDS.filter((id) => id !== 'retry'),
    });
    const evidence = aggregateEvidence(reports);
    const retry = evidence.capabilities.find((item) => item.id === 'retry');
    expect(retry?.realAcceptance).toBe('backend_connected');
    expect(
      evidence.capabilities.filter((item) => item.realAcceptance === 'verified'),
    ).toHaveLength(9);
  });

  it('keeps a capability backend_connected when no HTTP report proves it', () => {
    const reports = allPassingSanitizedReports();
    reports.runtime = runtimeReport({
      backendConnectedCapabilities: ALL_CAPABILITY_IDS.filter((id) => id !== 'lifecycle'),
    });
    const evidence = aggregateEvidence(reports);
    const lifecycle = evidence.capabilities.find((item) => item.id === 'lifecycle');
    expect(lifecycle?.realAcceptance).toBe('backend_connected');
  });
});

/* -------------------------------------------------------------------------- */
/* Evidence file merge and atomic write                                        */
/* -------------------------------------------------------------------------- */

describe('mergeFinalAcceptance', () => {
  it('preserves persisted UI/backend fields; frozen phase D reports leave phase E rows unproven', () => {
    const persisted = {
      ...uiEvidenceReport({ commit: BACKEND_REPORT_COMMIT }),
      backendOutcome: 'passed',
      backendConnectedCapabilities: [...ALL_CAPABILITY_IDS],
    };
    const aggregate = aggregateEvidence(allPassingSanitizedReports());
    const merged = mergeFinalAcceptance(persisted, aggregate);
    expect(merged.outcome).toBe('passed');
    expect(merged.passedCapabilities).toEqual([...ALL_CAPABILITY_IDS]);
    expect(merged.backendOutcome).toBe('passed');
    expect(merged.backendConnectedCapabilities).toEqual([...ALL_CAPABILITY_IDS]);
    // All-or-nothing verdict: the Phase E rows are not covered by the frozen
    // Phase D reports, so the merged outcome stays failed with no proven subset.
    expect(merged.realAcceptanceOutcome).toBe('failed');
    expect(merged.realAcceptanceVerifiedCapabilities).toEqual([]);
  });

  it('records passed with the full list when every capability is verified', () => {
    const aggregate: FinalEvidenceAggregate = {
      capabilities: CAPABILITIES.map(([id, label]) => ({
        id,
        label,
        realAcceptance: 'verified' as const,
      })),
    };
    const merged = mergeFinalAcceptance(null, aggregate);
    expect(merged.realAcceptanceOutcome).toBe('passed');
    expect(merged.realAcceptanceVerifiedCapabilities).toEqual([...ALL_CAPABILITY_IDS]);
  });

  it('degrades unusable persisted evidence to seed semantics but keeps the verdict', () => {
    const aggregate = aggregateEvidence(allPassingSanitizedReports());
    const merged = mergeFinalAcceptance(null, aggregate);
    expect(merged.outcome).toBe('not_run');
    expect(merged.passedCapabilities).toEqual([]);
    // Same verdict as the persisted case: Phase E rows keep the aggregate
    // short of the all-capabilities bar.
    expect(merged.realAcceptanceOutcome).toBe('failed');
    expect(merged.realAcceptanceVerifiedCapabilities).toEqual([]);
  });

  it('writes a failed outcome with no verified subset when not every capability is proven', () => {
    const reports = allPassingSanitizedReports();
    reports.ui = uiEvidenceReport({
      passedCapabilities: ALL_CAPABILITY_IDS.filter((id) => id !== 'skills'),
    });
    const merged = mergeFinalAcceptance(uiEvidenceReport(), aggregateEvidence(reports));
    expect(merged.realAcceptanceOutcome).toBe('failed');
    expect(merged.realAcceptanceVerifiedCapabilities).toEqual([]);
  });
});

describe('writeFinalEvidenceAtomic', () => {
  it('writes the payload via rename without leaving temp files behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-core-final-evidence-'));
    const target = join(dir, 'development-evidence.json');
    writeFileSync(target, '{"stale":true}\n', 'utf8');
    const payload = { schemaVersion: 1, outcome: 'passed' };

    writeFinalEvidenceAtomic(target, payload);

    expect(readFileSync(target, 'utf8')).toBe(`${JSON.stringify(payload, null, 2)}\n`);
    expect(readdirSync(dir)).toEqual(['development-evidence.json']);
    expect(existsSync(target)).toBe(true);
  });
});
