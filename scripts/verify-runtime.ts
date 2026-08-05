/**
 * Forge Core runtime evidence gate (plan Phase C Task 6 Step 4).
 *
 * Runs the Phase C runtime proof suites in order — the runtime unit/integration
 * modules, both runtime Playwright gates (the Fake full loop and the
 * child-process SIGKILL recovery) and the sanitized real-Pi boundary report —
 * and ALWAYS writes two artifacts:
 *
 *   1. forge-core-overnight/evidence/sanitized-reports/phase-c.json —
 *      schemaVersion, per-command name + exit code + test counts, the Pi
 *      boundary verdict, commit, observedAt and the outcome. Deliberately
 *      sanitized: counts and static command names only, never raw output.
 *   2. public/development-evidence.json — read-modify-write: the persisted
 *      UI dimension survives untouched while backendOutcome /
 *      backendConnectedCapabilities are refreshed from this run. On a full
 *      pass all THIRTEEN capabilities become backend_connected (the six
 *      Phase B, lifecycle/retry/skills/final_output and the three Phase E
 *      capabilities).
 *
 * Award semantics (spec §15.3 ceiling): this gate can only ever award
 * backend_connected — never `verified`, and realAcceptance stays hard-coded
 * to not_started (Phase D owns it). Any failing command -> backendOutcome
 * "failed", an empty proven subset, exit code 1. A missing or failing Pi
 * boundary report fails the gate (the real-Pi probe is a Gate C hard metric).
 *
 * Executed by tsx (`npm run verify:runtime` / `npm run core:verify-runtime`)
 * and intentionally outside the tsconfig include set; it imports only the
 * capability registry and evidence helpers from src.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKEND_CONNECTED_PHASE_B,
  BACKEND_CONNECTED_PHASE_E,
} from '../src/client/mock/development-capabilities';
import {
  parseDevelopmentEvidence,
  type DevelopmentEvidenceFile,
} from '../src/client/mock/development-evidence';

interface GateDefinition {
  id: string;
  label: string;
  command: string;
  args: string[];
}

interface GateReport {
  id: string;
  label: string;
  command: string;
  exitCode: number | null;
  passed: number;
  failed: number;
  skipped: number;
}

const IS_WINDOWS = process.platform === 'win32';
const NPM = IS_WINDOWS ? 'npm.cmd' : 'npm';
const NPX = IS_WINDOWS ? 'npx.cmd' : 'npx';

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(WORKSPACE_ROOT, '..', '..');
const EVIDENCE_PATH = resolve(WORKSPACE_ROOT, 'public', 'development-evidence.json');
const REPORT_DIR = resolve(REPO_ROOT, 'forge-core-overnight', 'evidence', 'sanitized-reports');
const REPORT_PATH = resolve(REPORT_DIR, 'phase-c.json');
const PI_BOUNDARY_PATH = resolve(REPORT_DIR, 'pi-boundary.json');

/**
 * Gate C backend-connected set: the six Phase B capabilities, the four the
 * Phase C runtime proves (lifecycle, retry, skills, final_output) and the
 * three Phase E proof slice (process_trace, agent_workspace, task_clone) —
 * all thirteen.
 */
const BACKEND_CONNECTED_PHASE_C: readonly string[] = [
  ...BACKEND_CONNECTED_PHASE_B,
  'lifecycle',
  'retry',
  'skills',
  'final_output',
  ...BACKEND_CONNECTED_PHASE_E,
];

const GATES: GateDefinition[] = [
  {
    id: 'runtime-modules',
    label: '运行时模块单元与集成测试',
    command: NPX,
    args: ['vitest', 'run', 'src/server/runtime'],
  },
  {
    id: 'e2e-runtime-loop',
    label: 'Fake 全链路浏览器门禁',
    command: NPX,
    args: ['playwright', 'test', 'e2e/runtime-loop.spec.ts'],
  },
  {
    id: 'e2e-process-recovery',
    label: '进程杀死恢复浏览器门禁',
    command: NPX,
    args: ['playwright', 'test', 'e2e/process-recovery.spec.ts'],
  },
];

/** Sanitized Pi boundary verdict recorded into the phase-c report. */
interface PiBoundaryVerdict {
  present: boolean;
  passed: boolean;
  outcome: string | null;
  checks: Record<string, boolean>;
  secretFindings: number | null;
  thinkingFindings: number | null;
  boundaryViolations: number;
}

function firstCount(output: string, pattern: RegExp): number {
  const match = pattern.exec(output);
  if (match === null || match[1] === undefined) return 0;
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : 0;
}

/** Counts only — raw output never enters the report (sanitization). */
function parseCounts(gateId: string, output: string): {
  passed: number;
  failed: number;
  skipped: number;
} {
  if (gateId === 'e2e-runtime-loop' || gateId === 'e2e-process-recovery') {
    return {
      passed: firstCount(output, /(\d+) passed/),
      failed: firstCount(output, /(\d+) failed/),
      skipped: firstCount(output, /(\d+) skipped/),
    };
  }
  if (gateId === 'runtime-modules') {
    return {
      passed: firstCount(output, /Tests\s+(\d+) passed/),
      failed: firstCount(output, /Tests\s+(\d+) failed/),
      skipped: firstCount(output, /Tests\s+(\d+) skipped/),
    };
  }
  return { passed: 0, failed: 0, skipped: 0 };
}

function runGate(gate: GateDefinition): GateReport {
  console.log(`[verify-runtime] 运行 ${gate.label}（${gate.command} ${gate.args.join(' ')}）`);
  const result = spawnSync(gate.command, gate.args, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (output.length > 0) process.stdout.write(output);
  const counts = parseCounts(gate.id, output);
  const report: GateReport = {
    id: gate.id,
    label: gate.label,
    command: `${gate.command} ${gate.args.join(' ')}`,
    exitCode: result.status,
    ...counts,
  };
  console.log(
    `[verify-runtime] ${gate.id} -> exit=${report.exitCode}` +
      ` passed=${report.passed} failed=${report.failed} skipped=${report.skipped}`,
  );
  return report;
}

/** Reads and validates the sanitized real-Pi boundary report. */
function validatePiBoundary(): PiBoundaryVerdict {
  if (!existsSync(PI_BOUNDARY_PATH)) {
    console.log(`[verify-runtime] pi-boundary 报告不存在：${PI_BOUNDARY_PATH}`);
    return {
      present: false,
      passed: false,
      outcome: null,
      checks: {},
      secretFindings: null,
      thinkingFindings: null,
      boundaryViolations: 0,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(PI_BOUNDARY_PATH, 'utf8'));
  } catch {
    return {
      present: true,
      passed: false,
      outcome: null,
      checks: {},
      secretFindings: null,
      thinkingFindings: null,
      boundaryViolations: 0,
    };
  }
  const report = raw as {
    outcome?: unknown;
    checks?: Record<string, unknown>;
    counts?: { secretFindings?: unknown; thinkingFindings?: unknown };
    boundaryViolations?: unknown;
  };
  const checks: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(report.checks ?? {})) {
    checks[key] = value === true;
  }
  const allChecksTrue =
    Object.keys(checks).length > 0 && Object.values(checks).every((value) => value === true);
  const secretFindings =
    typeof report.counts?.secretFindings === 'number' ? report.counts.secretFindings : null;
  const thinkingFindings =
    typeof report.counts?.thinkingFindings === 'number' ? report.counts.thinkingFindings : null;
  const violations = Array.isArray(report.boundaryViolations)
    ? report.boundaryViolations.length
    : 0;
  const passed =
    report.outcome === 'succeeded' &&
    allChecksTrue &&
    secretFindings === 0 &&
    thinkingFindings === 0 &&
    violations === 0;
  return {
    present: true,
    passed,
    outcome: typeof report.outcome === 'string' ? report.outcome : null,
    checks,
    secretFindings,
    thinkingFindings,
    boundaryViolations: violations,
  };
}

function readCommit(): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status === 0) return result.stdout.trim();
  return null;
}

function readPersistedEvidence(): unknown {
  if (!existsSync(EVIDENCE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function main(): void {
  const reports: GateReport[] = [];
  for (const gate of GATES) {
    reports.push(runGate(gate));
  }
  const piBoundary = validatePiBoundary();
  console.log(
    `[verify-runtime] pi-boundary -> present=${piBoundary.present}` +
      ` passed=${piBoundary.passed} outcome=${piBoundary.outcome}` +
      ` secretFindings=${piBoundary.secretFindings} thinkingFindings=${piBoundary.thinkingFindings}`,
  );

  const commandsPassed = reports.every((report) => report.exitCode === 0);
  const allPassed = commandsPassed && piBoundary.passed;
  const backendOutcome: DevelopmentEvidenceFile['backendOutcome'] = allPassed
    ? 'passed'
    : 'failed';
  const backendConnectedCapabilities = allPassed ? [...BACKEND_CONNECTED_PHASE_C] : [];

  // 1. Sanitized machine-readable report (never env values/paths/raw output).
  mkdirSync(REPORT_DIR, { recursive: true });
  const report = {
    schemaVersion: 1,
    gate: 'core:verify-runtime',
    command: 'npm run core:verify-runtime',
    observedAt: new Date().toISOString(),
    commit: readCommit(),
    outcome: backendOutcome,
    gates: reports,
    piBoundary: {
      present: piBoundary.present,
      passed: piBoundary.passed,
      outcome: piBoundary.outcome,
      checks: piBoundary.checks,
      secretFindings: piBoundary.secretFindings,
      thinkingFindings: piBoundary.thinkingFindings,
      boundaryViolations: piBoundary.boundaryViolations,
    },
    backendConnectedCapabilities,
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[verify-runtime] 报告已写入 ${REPORT_PATH}`);

  // 2. Read-modify-write the development evidence: this gate owns only the
  // backend dimension; the persisted UI dimension survives untouched.
  const uiEvidence = parseDevelopmentEvidence(readPersistedEvidence());
  const merged: DevelopmentEvidenceFile = {
    ...uiEvidence,
    backendOutcome,
    backendConnectedCapabilities,
  };
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  console.log(
    `[verify-runtime] 证据已更新 public/development-evidence.json：backendOutcome=${backendOutcome}` +
      `，backendConnectedCapabilities=${backendConnectedCapabilities.length}/${BACKEND_CONNECTED_PHASE_C.length}`,
  );

  if (!allPassed) {
    console.log('[verify-runtime] 失败摘要：');
    for (const failing of reports.filter((candidate) => candidate.exitCode !== 0)) {
      console.log(`  - ${failing.id}（${failing.label}）：退出码 ${failing.exitCode}`);
    }
    if (!piBoundary.passed) {
      console.log(
        `  - pi-boundary（真实 Pi 边界报告）：${piBoundary.present ? '未通过' : '缺失'}`,
      );
    }
    process.exit(1);
  }
}

main();
