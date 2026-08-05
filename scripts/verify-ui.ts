/**
 * Forge Core UI evidence gate (plan Task 7 Step 4).
 *
 * Runs the required UI suites in order — focused Vitest (full workspace),
 * tsc --noEmit, vite build, then the two Playwright files — and writes
 * public/development-evidence.json on every run:
 *
 *   - every command exits 0      -> outcome "passed", all thirteen capability ids
 *   - any required suite fails   -> outcome "failed", only the capability ids
 *                                   whose owning suites passed, exit code 1
 *   - a Playwright spec missing  -> that gate is "skipped_missing" (Task 8
 *                                   creates the specs) and counts as failed
 *
 * Capability ownership: vitest (component + Gateway contract tests) owns the
 * six interaction capabilities; e2e/product-flow.spec.ts owns the browser
 * canvas/artifact/final-output flow; e2e/mock-recovery.spec.ts owns refresh
 * recovery. The typecheck and build gates are integrity gates: if either
 * fails, no product-shape claim is awarded at all.
 *
 * This script is executed by tsx (`npm run verify:ui`) and is intentionally
 * outside the tsconfig include set; it imports only the pure capability
 * registry and evidence helpers from src so capability ids and the evidence
 * merge semantics have a single source of truth. Since plan Phase B Task 6
 * the rewrite is a read-modify-write: backendOutcome/
 * backendConnectedCapabilities persisted by scripts/verify-backend.ts are
 * preserved (merge semantics pinned by development-evidence.test.ts).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, type CapabilityId } from '../src/client/mock/development-capabilities';
import {
  mergeWithPersistedBackendEvidence,
  type DevelopmentEvidenceFile,
} from '../src/client/mock/development-evidence';

interface GateDefinition {
  id: string;
  label: string;
  command: string;
  args: string[];
  /** Capability ids awarded when this gate passes (integrity gates: none). */
  awards: CapabilityId[];
  /** For Playwright gates: the spec file that must exist to run the gate. */
  requiredFile?: string;
}

type GateStatus = 'passed' | 'failed' | 'skipped_missing';

interface GateResult extends GateDefinition {
  status: GateStatus;
  note: string;
}

const IS_WINDOWS = process.platform === 'win32';
const NPM = IS_WINDOWS ? 'npm.cmd' : 'npm';
const NPX = IS_WINDOWS ? 'npx.cmd' : 'npx';

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_PATH = resolve(WORKSPACE_ROOT, 'public', 'development-evidence.json');

const GATES: GateDefinition[] = [
  {
    id: 'vitest',
    label: 'Vitest 单元与组件测试',
    command: NPM,
    args: ['run', 'test'],
    awards: [
      'templates',
      'template_reload',
      'task_creation',
      'lifecycle',
      'retry',
      'skills',
    ],
  },
  {
    id: 'typecheck',
    label: 'TypeScript 类型检查',
    command: NPM,
    args: ['run', 'check'],
    awards: [],
  },
  {
    id: 'build',
    label: 'Vite 生产构建',
    command: NPM,
    args: ['run', 'build'],
    awards: [],
  },
  {
    id: 'e2e-product-flow',
    label: 'Playwright 产品全流程',
    command: NPX,
    args: ['playwright', 'test', 'e2e/product-flow.spec.ts'],
    awards: ['workspace', 'artifacts', 'final_output'],
    requiredFile: 'e2e/product-flow.spec.ts',
  },
  {
    id: 'e2e-mock-recovery',
    label: 'Playwright 刷新恢复',
    command: NPX,
    args: ['playwright', 'test', 'e2e/mock-recovery.spec.ts'],
    awards: ['task_recovery'],
    requiredFile: 'e2e/mock-recovery.spec.ts',
  },
  {
    id: 'e2e-process-trace',
    label: 'Playwright 执行过程浮窗与工作区',
    command: NPX,
    args: ['playwright', 'test', 'e2e/process-trace.spec.ts'],
    awards: ['process_trace', 'agent_workspace', 'task_clone'],
    requiredFile: 'e2e/process-trace.spec.ts',
  },
];

function readCommit(): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });
  if (result.status === 0) return result.stdout.trim();
  return null;
}

/**
 * Reads the persisted evidence file (when present) so the backend fields
 * written by scripts/verify-backend.ts survive this gate's rewrite. This
 * script owns only the UI dimension; a full-file overwrite would silently
 * demote the backend column (plan Task 6 merge semantics).
 */
function readPersistedEvidence(): unknown {
  if (!existsSync(EVIDENCE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function runGate(gate: GateDefinition): GateResult {
  if (gate.requiredFile && !existsSync(resolve(WORKSPACE_ROOT, gate.requiredFile))) {
    return {
      ...gate,
      status: 'skipped_missing',
      note: `${gate.requiredFile} 尚不存在（Task 8 创建），该 e2e 门跳过并记为未通过`,
    };
  }
  const result = spawnSync(gate.command, gate.args, {
    cwd: WORKSPACE_ROOT,
    stdio: 'inherit',
  });
  const passed = result.status === 0;
  return {
    ...gate,
    status: passed ? 'passed' : 'failed',
    note: passed ? '退出 0' : `退出码 ${result.status ?? 'null'}`,
  };
}

function main(): void {
  const results: GateResult[] = [];
  for (const gate of GATES) {
    console.log(`[verify-ui] 运行 ${gate.label}（${gate.command} ${gate.args.join(' ')}）`);
    const result = runGate(gate);
    results.push(result);
    console.log(`[verify-ui] ${gate.id} -> ${result.status}（${result.note}）`);
  }

  const integrityOk = results
    .filter((result) => result.awards.length === 0)
    .every((result) => result.status === 'passed');
  const awarded = new Set<CapabilityId>();
  if (integrityOk) {
    for (const result of results) {
      if (result.status !== 'passed') continue;
      for (const id of result.awards) awarded.add(id);
    }
  }
  const passedCapabilities = CAPABILITIES.map(([id]) => id).filter((id) => awarded.has(id));
  const outcome = results.every((result) => result.status === 'passed') ? 'passed' : 'failed';

  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  const uiEvidence: DevelopmentEvidenceFile = {
    schemaVersion: 1,
    outcome,
    observedAt: new Date().toISOString(),
    commit: readCommit(),
    command: 'npm run verify:ui',
    passedCapabilities,
  };
  // Read-modify-write: keep the backend gate's persisted fields intact.
  const evidence = mergeWithPersistedBackendEvidence(readPersistedEvidence(), uiEvidence);
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  console.log(
    `[verify-ui] 证据已写入 public/development-evidence.json：outcome=${outcome}` +
      `，passedCapabilities=${passedCapabilities.length}/${CAPABILITIES.length}`,
  );
  if (outcome === 'failed') {
    const failing = results.filter((result) => result.status !== 'passed');
    console.log('[verify-ui] 失败摘要：');
    for (const result of failing) {
      console.log(`  - ${result.id}（${result.label}）：${result.status}，${result.note}`);
    }
    process.exit(1);
  }
}

main();
