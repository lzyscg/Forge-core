/**
 * Forge Core backend evidence gate (plan Phase B Task 6).
 *
 * Runs the backend proof suites in order — Mock+HTTP shared Gateway contract
 * tests, the full server module suite, typecheck, build and the HTTP
 * persistence Playwright gate — and ALWAYS writes two artifacts:
 *
 *   1. forge-core-overnight/evidence/sanitized-reports/phase-b.json —
 *      schemaVersion, per-command name + exit code + test counts, commit,
 *      observedAt and the outcome. Deliberately sanitized: no environment
 *      values, no filesystem paths, no raw provider/test output (counts and
 *      static command names only).
 *   2. public/development-evidence.json — read-modify-write: the persisted
 *      UI dimension (outcome/passedCapabilities from scripts/verify-ui.ts)
 *      is preserved while backendOutcome/backendConnectedCapabilities are
 *      refreshed from this run (the same merge semantics verify-ui uses in
 *      the opposite direction, pinned by development-evidence.test.ts).
 *
 * Award semantics: all five commands green -> backendOutcome "passed" and
 * the six Phase B plus the three Phase E capabilities
 * (BACKEND_CONNECTED_PHASE_B + BACKEND_CONNECTED_PHASE_E) become
 * backend_connected; any failure -> backendOutcome "failed" and an empty
 * proven subset (the nine form one proof slice and the integrity gates are
 * non-negotiable), exit code 1. Gate B ceiling: this script can never mark
 * anything `verified` (spec §15.3).
 *
 * Executed by tsx (`npm run verify:backend` / `npm run core:verify-backend`)
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
const REPORT_PATH = resolve(REPORT_DIR, 'phase-b.json');

/**
 * Backend-connected set awarded on a full pass: the six Phase B capabilities
 * plus the three Phase E ones (plan Task E4). One proof slice — any failing
 * command empties the whole subset.
 */
const BACKEND_CONNECTED_ALL: readonly string[] = [
  ...BACKEND_CONNECTED_PHASE_B,
  ...BACKEND_CONNECTED_PHASE_E,
];

const GATES: GateDefinition[] = [
  {
    id: 'gateway-contracts',
    label: 'Mock 与 HTTP Gateway 共享契约测试',
    command: NPX,
    args: ['vitest', 'run', 'src/client/gateway', 'src/client/mock'],
  },
  {
    id: 'server-modules',
    label: '服务端模块全量测试',
    command: NPX,
    args: ['vitest', 'run', 'src/server'],
  },
  {
    id: 'typecheck',
    label: 'TypeScript 类型检查',
    command: NPM,
    args: ['run', 'check'],
  },
  {
    id: 'build',
    label: '客户端与服务端构建',
    command: NPM,
    args: ['run', 'build'],
  },
  {
    id: 'e2e-http-persistence',
    label: 'HTTP 持久化浏览器门禁',
    command: NPX,
    args: ['playwright', 'test', 'e2e/http-persistence.spec.ts'],
  },
];

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
  if (gateId === 'e2e-http-persistence') {
    return {
      passed: firstCount(output, /(\d+) passed/),
      failed: firstCount(output, /(\d+) failed/),
      skipped: firstCount(output, /(\d+) skipped/),
    };
  }
  if (gateId === 'gateway-contracts' || gateId === 'server-modules') {
    return {
      passed: firstCount(output, /Tests\s+(\d+) passed/),
      failed: firstCount(output, /Tests\s+(\d+) failed/),
      skipped: firstCount(output, /Tests\s+(\d+) skipped/),
    };
  }
  return { passed: 0, failed: 0, skipped: 0 };
}

function runGate(gate: GateDefinition): GateReport {
  console.log(`[verify-backend] 运行 ${gate.label}（${gate.command} ${gate.args.join(' ')}）`);
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
    `[verify-backend] ${gate.id} -> exit=${report.exitCode}` +
      ` passed=${report.passed} failed=${report.failed} skipped=${report.skipped}`,
  );
  return report;
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

  const allPassed = reports.every((report) => report.exitCode === 0);
  const backendOutcome: DevelopmentEvidenceFile['backendOutcome'] = allPassed
    ? 'passed'
    : 'failed';
  const backendConnectedCapabilities = allPassed ? [...BACKEND_CONNECTED_ALL] : [];

  // 1. Sanitized machine-readable report (never env values/paths/raw output).
  mkdirSync(REPORT_DIR, { recursive: true });
  const report = {
    schemaVersion: 1,
    gate: 'core:verify-backend',
    command: 'npm run core:verify-backend',
    observedAt: new Date().toISOString(),
    commit: readCommit(),
    outcome: backendOutcome,
    gates: reports,
    backendConnectedCapabilities,
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[verify-backend] 报告已写入 ${REPORT_PATH}`);

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
    `[verify-backend] 证据已更新 public/development-evidence.json：backendOutcome=${backendOutcome}` +
      `，backendConnectedCapabilities=${backendConnectedCapabilities.length}/${BACKEND_CONNECTED_ALL.length}`,
  );

  if (!allPassed) {
    console.log('[verify-backend] 失败摘要：');
    for (const failing of reports.filter((candidate) => candidate.exitCode !== 0)) {
      console.log(`  - ${failing.id}（${failing.label}）：退出码 ${failing.exitCode}`);
    }
    process.exit(1);
  }
}

main();
