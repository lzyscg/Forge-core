// @vitest-environment node
/**
 * Authoritative review v2 real-acceptance harness tests (Task 27 Step 3).
 *
 * Pins the deterministic compliance contract before any real provider is
 * wired:
 *
 * - parseRealAcceptanceArgs exits `null` for missing/malformed flags and
 *   defaults `--mode fake` when the flag is absent.
 * - The fake/disabled mode writes a sanitized report that satisfies the
 *   pinned REPORT_KEYS field set + capability + ABI facts. The
 *   --verify-existing path re-validates a previously written report and
 *   rejects field drift / schema mismatch.
 * - The production-preflight seam rejects a default real-mode invocation
 *   (Task 29 wires the real provider preflight; the placeholder never
 *   bypasses the gate).
 * - A hand-edited capability manifest cannot sneak through
 *   capabilityProfileDigest / capabilityEvidenceDigest: the report carries
 *   exactly what the manifest declares.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_REPORT_KEYS,
  AUTHORITATIVE_REVIEW_REAL_ACCEPTANCE_REPORT_SCHEMA,
  AUTHORITATIVE_REVIEW_REAL_ACCEPTANCE_TEMPLATE_ID,
  buildRealAcceptanceReport,
  parseRealAcceptanceArgs,
  runRealAcceptanceCli,
  type RealAcceptanceFacts,
} from './authoritative-review-real-acceptance';
import {
  AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION,
  AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY,
  AUTHORITATIVE_REVIEW_RUNNER_IDENTITY,
} from './authoritative-review-evidence-schema';

const tempDirs: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-ar-acceptance-'));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('parseRealAcceptanceArgs', () => {
  it('defaults to fake mode when no --mode flag is given', () => {
    expect(parseRealAcceptanceArgs([])).toEqual({
      mode: 'fake',
      provider: null,
      writerModel: null,
      reviewerModel: null,
      input: null,
      dataRoot: null,
      report: null,
      verifyExisting: null,
    });
  });

  it('parses fake mode cleanly', () => {
    expect(parseRealAcceptanceArgs(['--mode', 'fake'])).toEqual({
      mode: 'fake',
      provider: null,
      writerModel: null,
      reviewerModel: null,
      input: null,
      dataRoot: null,
      report: null,
      verifyExisting: null,
    });
  });

  it('rejects a real mode argument without the required flags', () => {
    expect(parseRealAcceptanceArgs(['--mode', 'real'])).toBeNull();
  });

  it('accepts a real mode argument with all required flags', () => {
    const args = parseRealAcceptanceArgs([
      '--mode', 'real',
      '--provider', 'p1',
      '--writer-model', 'm1',
      '--reviewer-model', 'm2',
      '--input', 'input.json',
      '--data-root', 'data',
      '--report', 'report.json',
    ]);
    expect(args?.mode).toBe('real');
    expect(args?.provider).toBe('p1');
    expect(args?.writerModel).toBe('m1');
    expect(args?.reviewerModel).toBe('m2');
  });

  it('rejects when any flag value is empty', () => {
    expect(parseRealAcceptanceArgs(['--mode', ''])).toBeNull();
  });
});

describe('buildRealAcceptanceReport', () => {
  const facts: RealAcceptanceFacts = {
    outcome: 'fake_completed',
    commit: 'a'.repeat(40),
    capabilityStatus: 'disabled',
    capabilityProfileDigest: null,
    capabilityEvidenceDigest: null,
    requiredAbis: [...AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY],
    piPreflightCharacterization: AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION,
    runnerIdentity: AUTHORITATIVE_REVIEW_RUNNER_IDENTITY,
    taskId: 'fake-task',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    eventOrderCriticalSequence: ['task_started', 'structured_map_activated'],
    browserApiFileReconciled: true,
    restartConfirmed: true,
    restartObservation: 'fake-mode',
    restartMismatchCount: 0,
    secretFindingCount: 0,
    publicErrorCodes: [],
  };

  it('emits exactly the pinned field set', () => {
    const report = buildRealAcceptanceReport(facts);
    expect(Object.keys(report).sort()).toEqual([...ACCEPTANCE_REPORT_KEYS].sort());
    expect(report['schemaVersion']).toBe(AUTHORITATIVE_REVIEW_REAL_ACCEPTANCE_REPORT_SCHEMA);
  });

  it('declares the v2 ABI list, runner identity, and preflight characterization', () => {
    const report = buildRealAcceptanceReport(facts);
    expect(report['requiredAbis']).toEqual([...AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY]);
    expect(report['runnerIdentity']).toBe(AUTHORITATIVE_REVIEW_RUNNER_IDENTITY);
    expect(report['piPreflightCharacterization']).toBe(AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION);
  });

  it('synthesizes the deterministic critical event-order sequence', () => {
    const report = buildRealAcceptanceReport(facts);
    expect(report['eventOrderCriticalSequence']).toEqual(facts.eventOrderCriticalSequence);
  });
});

describe('runRealAcceptanceCli (fake / disabled / verify-existing)', () => {
  it('writes a sanitized fake-mode report at the requested path', async () => {
    const root = freshRoot();
    const reportPath = join(root, 'report.json');
    const result = await runRealAcceptanceCli(
      ['--mode', 'fake', '--report', reportPath],
      { repoRoot: root },
    );
    expect(result.exitCode).toBe(0);
    expect(result.reportPath).toBe(reportPath);
  });

  it('rejects a real mode invocation that the default preflight blocks', async () => {
    const root = freshRoot();
    const result = await runRealAcceptanceCli(
      [
        '--mode', 'real',
        '--provider', 'p1',
        '--writer-model', 'm1',
        '--reviewer-model', 'm2',
        '--input', 'input.json',
        '--data-root', 'data',
        '--report', 'report.json',
      ],
      { repoRoot: root },
    );
    expect(result.exitCode).toBe(2);
    expect(result.startedServer).toBe(false);
    expect(result.reason).toBe('real-mode-not-implemented');
  });

  it('verifies an existing fake-mode report', async () => {
    const root = freshRoot();
    const reportPath = join(root, 'report.json');
    await runRealAcceptanceCli(['--mode', 'fake', '--report', reportPath], { repoRoot: root });
    const result = await runRealAcceptanceCli(['--verify-existing', reportPath], { repoRoot: root });
    expect(result.exitCode).toBe(0);
    expect(result.reportPath).toBe(reportPath);
  });

  it('rejects --verify-existing against a tampered report (field drift)', async () => {
    const root = freshRoot();
    const reportPath = join(root, 'report.json');
    await runRealAcceptanceCli(['--mode', 'fake', '--report', reportPath], { repoRoot: root });
    const raw = JSON.parse(require('node:fs').readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
    raw['rogue-field'] = 'cannot ship';
    writeFileSync(reportPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    const result = await runRealAcceptanceCli(['--verify-existing', reportPath], { repoRoot: root });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toBe('FIELD_DRIFT');
  });

  it('rejects --verify-existing against a wrong schema', async () => {
    const root = freshRoot();
    const reportPath = join(root, 'report.json');
    writeFileSync(reportPath, `${JSON.stringify({ schemaVersion: 'wrong', outcome: 'fake_completed' }, null, 2)}\n`, 'utf8');
    const result = await runRealAcceptanceCli(['--verify-existing', reportPath], { repoRoot: root });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toBe('SCHEMA_MISMATCH');
  });

  it('rejects --verify-existing against a missing report', async () => {
    const root = freshRoot();
    const result = await runRealAcceptanceCli(['--verify-existing', join(root, 'missing.json')], { repoRoot: root });
    expect(result.exitCode).toBe(2);
    expect(result.reason).toBe('REPORT_MISSING');
  });
});

describe('capability digest fidelity', () => {
  it('a disabled capability produces null profileDigest / evidenceDigest', async () => {
    const root = freshRoot();
    const result = await runRealAcceptanceCli(['--mode', 'fake', '--report', join(root, 'r.json')], {
      repoRoot: root,
      readCapability: () => ({ status: 'disabled', profileDigest: null, evidenceDigest: null }),
    });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(require('node:fs').readFileSync(result.reportPath!, 'utf8')) as Record<string, unknown>;
    expect(report['capabilityStatus']).toBe('disabled');
    expect(report['capabilityProfileDigest']).toBeNull();
    expect(report['capabilityEvidenceDigest']).toBeNull();
  });

  it('an enabled capability never sneaks through the fake path', async () => {
    const root = freshRoot();
    const result = await runRealAcceptanceCli(['--mode', 'fake', '--report', join(root, 'r.json')], {
      repoRoot: root,
      readCapability: () => ({
        status: 'enabled',
        profileDigest: 'f'.repeat(64),
        evidenceDigest: 'e'.repeat(64),
      }),
    });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(require('node:fs').readFileSync(result.reportPath!, 'utf8')) as Record<string, unknown>;
    expect(report['capabilityStatus']).toBe('enabled');
    expect(report['capabilityProfileDigest']).toBe('f'.repeat(64));
    expect(report['capabilityEvidenceDigest']).toBe('e'.repeat(64));
  });
});

describe('template identity is the v2 acceptance template', () => {
  it('uses the v2 acceptance template id', () => {
    expect(AUTHORITATIVE_REVIEW_REAL_ACCEPTANCE_TEMPLATE_ID).toBe('zhihu-salt-chapter-draft');
  });
});
