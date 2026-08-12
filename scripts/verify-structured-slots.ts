#!/usr/bin/env node
/**
 * Structured slot engine offline evidence command (Task 19, spec §15/§16,
 * design §25.13 O09).
 *
 * Modes:
 *
 *   --acceptance-only --capability injected|production
 *       The hermetic structured acceptance: runs the deterministic end-to-end
 *       acceptance test (`src/server/template/structured-slot-template
 *       .acceptance.test.ts`) and the Task 14 locked-Pi 0.82 pre-validation
 *       charging characterization. `injected` drives the same fixture through
 *       an EXPLICIT injected matching enabled environment (Steps 1-5/7);
 *       `production` asserts the production-default readiness (Step 9).
 *       This gate never writes product evidence (unlike verify:backend /
 *       verify:runtime) — it is an offline evidence command.
 *
 *   --qualify
 *       Step 7 qualification: validates the final profile evidence and the
 *       final profile, confirms the checked-in production manifest is STILL
 *       disabled, re-runs the full hermetic command list (check / test /
 *       build / e2e / structured acceptance), records the locked-Pi
 *       characterization result, and writes the release evidence
 *       (`docs/evidence/structured-slot-release-v1.json`). The release
 *       evidence carries NO capability-manifest digest (it is the next node in
 *       the one-way chain source/runner -> profile evidence -> final profile
 *       -> release evidence -> capability manifest).
 *
 *   --promote-capability <release-evidence.json>
 *       Step 8 promotion (the ONLY production enable path): validates the
 *       checkpoint HEAD, the normalized source-tree digest, the package-lock
 *       digest, the integrated profile evidence, the exact final profile
 *       digest and the required ABI list, then writes the ENABLED capability
 *       manifest whose profileDigest references the final profile and whose
 *       evidenceDigest references the release evidence. No environment
 *       variable or manual boolean is an alternate enable path. The complete
 *       dirty/untracked allowlist at this point must be exactly the four
 *       generated files (final profile JSON, profile evidence, release
 *       evidence, capability manifest).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalJsonSha256 } from '../src/server/structured-slots/canonical-json';
import { QUALIFICATION_GENERATED_OUTPUTS, isQualificationGeneratedOutput } from './structured-qualification-outputs';
import {
  loadStructuredPlatformProfile,
  profileCanonicalDigest,
} from '../src/server/structured-slots/platform-profile';
import { validateRuntimeCapability } from '../src/server/structured-slots/runtime-capability';
import type { StructuredRuntimeCapabilityV1 } from '../src/server/structured-slots/runtime-capability';
import {
  RELEASE_FINAL_PROFILE_PATH,
  RELEASE_PI_PREFLIGHT_CHARACTERIZATION,
  RELEASE_PROFILE_EVIDENCE_PATH,
  validateProfileEvidence,
  validateReleaseEvidence,
} from './structured-evidence-schema';

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPM = 'npm';
const NPX = 'npx';

const PROFILE_PATH = resolve(WORKSPACE_ROOT, 'src/server/structured-slots/platform-profile-v1.json');
const MANIFEST_PATH = resolve(WORKSPACE_ROOT, 'src/server/structured-slots/runtime-capability-v1.json');
const PROFILE_EVIDENCE_PATH = resolve(WORKSPACE_ROOT, 'docs/evidence/structured-slot-platform-profile-v1.json');
const RELEASE_EVIDENCE_PATH = resolve(WORKSPACE_ROOT, 'docs/evidence/structured-slot-release-v1.json');

/**
 * The exact Step 7/8 qualification gate set. `validateReleaseEvidence` demands
 * this set EXACTLY — no missing, no duplicates, no extras — and every gate's
 * `exitCode` must be 0.
 */
export const RELEASE_EVIDENCE_GATE_IDS = [
  'typecheck',
  'unit-tests',
  'build',
  'e2e',
  'structured-acceptance',
  'forge-pi-slot-preflight',
] as const;

/**
 * Injectable file paths so tests can drive qualify/promote against an isolated
 * temp workspace without touching the checked-in manifest/profile/evidence.
 */
export interface VerifyPaths {
  profilePath: string;
  profileEvidencePath: string;
  manifestPath: string;
  releaseEvidencePath: string;
  workspaceRoot: string;
}

const DEFAULT_PATHS: VerifyPaths = {
  profilePath: PROFILE_PATH,
  profileEvidencePath: PROFILE_EVIDENCE_PATH,
  manifestPath: MANIFEST_PATH,
  releaseEvidencePath: RELEASE_EVIDENCE_PATH,
  workspaceRoot: WORKSPACE_ROOT,
};

const VERIFY_USAGE =
  'usage: verify-structured-slots --acceptance-only --capability <injected|production> | ' +
  '--qualify | --promote-capability <release-evidence.json>';

class VerifyError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(`VERIFY_STRUCTURED_SLOTS: ${message}`);
    this.name = 'VerifyError';
    this.exitCode = exitCode;
  }
}

/** ------------------------------------------------------------------------ */
/** Primitives                                                               */
/** ------------------------------------------------------------------------ */

function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Atomically writes a product file: writes to a unique temp sibling in the SAME
 * directory, then renameSync renames over the destination. A crash/reader can
 * never observe a partially-written product file, and a `.tmp-*` sibling is
 * never mistaken for the product (unlike a plain writeFileSync which could
 * leave a truncated release evidence behind).
 */
function writeFileAtomic(path: string, contents: string): void {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, contents, 'utf8');
  renameSync(tmpPath, path);
}

export function gitCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: WORKSPACE_ROOT, encoding: 'utf8' }).trim();
}

/** SHA-256 over the sorted (relative path, sha256) of every git-tracked file
 * EXCEPT the generated qualification outputs (final profile, capability
 * manifest, profile/release evidence) — those are derived products certified
 * by their own digests in the one-way chain and do not change across the
 * qualification, so the source digest stays stable before/after promotion.
 */
export interface CleanSourceDigestDeps {
  trackedFiles?: readonly string[];
  readTrackedFile?: (relativePath: string) => Buffer | string;
}

export function cleanSourceDigest(deps: CleanSourceDigestDeps = {}): string {
  const trackedFiles =
    deps.trackedFiles ??
    execFileSync('git', ['ls-files'], { cwd: WORKSPACE_ROOT, encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  const readTrackedFile =
    deps.readTrackedFile ?? ((relativePath: string): Buffer => readFileSync(resolve(WORKSPACE_ROOT, relativePath)));
  const files = [...trackedFiles]
    .filter((line) => !isQualificationGeneratedOutput(line))
    .sort();
  const entries: Record<string, string> = {};
  for (const file of files) {
    entries[file] = sha256Hex(readTrackedFile(file));
  }
  return canonicalJsonSha256(entries);
}

export function packageLockSha256(): string {
  return sha256Hex(readFileSync(resolve(WORKSPACE_ROOT, 'package-lock.json')));
}

interface GateReport {
  id: string;
  label: string;
  command: string;
  exitCode: number | null;
}

function runGate(id: string, label: string, command: string, args: string[]): GateReport {
  process.stdout.write(`[verify-structured-slots] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (output.length > 0) process.stdout.write(output);
  process.stdout.write(`[verify-structured-slots] ${id} -> exit=${String(result.status)}\n`);
  return { id, label, command: `${command} ${args.join(' ')}`, exitCode: result.status };
}

/** ------------------------------------------------------------------------ */
/** Acceptance-only gate                                                     */
/** ------------------------------------------------------------------------ */

function runAcceptanceOnly(capability: string): number {
  if (capability !== 'injected' && capability !== 'production') {
    throw new VerifyError(`unknown --capability '${capability}' (expected injected|production)`, 2);
  }
  process.env.FORGE_STRUCTURED_CAPABILITY_MODE = capability;
  const gates: GateReport[] = [
    runGate(
      'structured-acceptance',
      `结构化槽端到端验收（capability=${capability}）`,
      NPX,
      ['vitest', 'run', 'src/server/template/structured-slot-template.acceptance.test.ts'],
    ),
    runGate(
      'locked-pi-characterization',
      '锁定 Pi 0.82 预校验计费特征（forge-pi-slot-preflight/v1）',
      NPX,
      ['vitest', 'run', 'src/server/runtime/pi-agent-runtime.test.ts', '-t', 'Task 14 Step 1'],
    ),
  ];
  const failed = gates.filter((gate) => gate.exitCode !== 0);
  if (failed.length > 0) {
    for (const gate of failed) {
      process.stderr.write(`[verify-structured-slots] 失败：${gate.id}（${gate.label}）退出码 ${String(gate.exitCode)}\n`);
    }
    return 1;
  }
  process.stdout.write('[verify-structured-slots] acceptance-only 全绿\n');
  return 0;
}

/** ------------------------------------------------------------------------ */
/** Qualify (Step 7)                                                         */
/** ------------------------------------------------------------------------ */

function loadProfileEvidence(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new VerifyError('profile evidence 不存在；必须先运行 integrated reference benchmark');
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function readCurrentManifest(path: string): StructuredRuntimeCapabilityV1 {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return validateRuntimeCapability(raw);
}

/** Injectable dependencies so tests can drive qualify without real gates. */
export interface QualifyDeps {
  gates?: () => GateReport[];
}

/**
 * Step 7 qualification (spec §16): re-runs the full hermetic command list and
 * writes the release evidence ONLY when EVERY gate exits 0. A failed gate set
 * writes a clearly-marked `.failed-<timestamp>` failure record at a DIFFERENT
 * path — never the release evidence path — so a failure product can never be
 * mistaken for release evidence by a later `--promote-capability`. A stale
 * release evidence from a prior successful run is left untouched (promotion
 * re-validates checkpoint freshness against HEAD).
 */
export function runQualify(paths: Partial<VerifyPaths> = {}, deps: QualifyDeps = {}): number {
  const p = { ...DEFAULT_PATHS, ...paths };
  // 1. The final profile must be `final` and reference the integrated evidence.
  const profile = loadStructuredPlatformProfile(p.profilePath);
  if (profile.status !== 'final') {
    throw new VerifyError('qualification requires a FINAL profile (integrated reference benchmark evidence)');
  }
  const evidence = loadProfileEvidence(p.profileEvidencePath);
  const evidenceDigest = canonicalJsonSha256(evidence);
  if (profile.evidenceDigest !== evidenceDigest) {
    throw new VerifyError('profile evidenceDigest does not match the profile evidence file');
  }

  // 2. The production manifest must STILL be disabled (the promotion is a
  //    separate, later step; only it may flip the checked-in phase).
  const manifest = readCurrentManifest(p.manifestPath);
  if (manifest.status !== 'disabled') {
    throw new VerifyError('production manifest must still be disabled during qualification');
  }

  // 3. Re-run the full hermetic command list with the final profile in place,
  //    explicit capability injection in the structured acceptance only.
  const gates: GateReport[] =
    deps.gates !== undefined
      ? deps.gates()
      : [
          runGate('typecheck', 'TypeScript 类型检查', NPM, ['run', 'check']),
          runGate('unit-tests', '单元/集成测试', NPM, ['test', '--', '--reporter=dot']),
          runGate('build', '客户端与服务端构建', NPM, ['run', 'build']),
          runGate('e2e', 'Playwright 端到端', NPM, ['run', 'e2e']),
          runGate(
            'structured-acceptance',
            '结构化槽端到端验收（注入环境）',
            NPM,
            ['run', 'verify:structured-slots', '--', '--acceptance-only', '--capability', 'injected'],
          ),
          runGate(
            'forge-pi-slot-preflight',
            '锁定 Pi 0.82 预校验计费特征',
            NPX,
            ['vitest', 'run', 'src/server/runtime/pi-agent-runtime.test.ts', '-t', 'Task 14 Step 1'],
          ),
        ];
  const allPassed = gates.every((gate) => gate.exitCode === 0);

  // 4. Build the qualification record. It must NOT contain the capability-
  //    manifest digest (that is the next node in the one-way chain).
  const releaseEvidence = {
    schemaVersion: 1,
    gate: 'verify:structured-slots',
    mode: 'qualify',
    checkpointCommit: gitCommit(),
    sourceTreeDigest: cleanSourceDigest(),
    packageLockSha256: packageLockSha256(),
    profileEvidencePath: RELEASE_PROFILE_EVIDENCE_PATH,
    profileEvidenceDigest: evidenceDigest,
    finalProfilePath: RELEASE_FINAL_PROFILE_PATH,
    finalProfileDigest: profileCanonicalDigest(profile),
    requiredAbis: [...manifest.requiredAbis],
    piPreflightCharacterization: RELEASE_PI_PREFLIGHT_CHARACTERIZATION,
    gates: gates.map(({ id, label, command, exitCode }) => ({ id, label, command, exitCode })),
    observedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(p.releaseEvidencePath), { recursive: true });

  // 5. A failed qualification NEVER writes the release evidence. It writes a
  //    clearly-marked failure record at `<releaseEvidencePath>.failed-<ts>`
  //    (a failure product can never be mistaken for release evidence) and
  //    leaves any stale release evidence from a prior successful run untouched.
  if (!allPassed) {
    const failedPath = `${p.releaseEvidencePath}.failed-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const failureRecord = {
      schemaVersion: 1,
      record: 'qualify-failed',
      gate: 'verify:structured-slots',
      mode: 'qualify',
      failedAt: new Date().toISOString(),
      releaseEvidencePath: p.releaseEvidencePath,
      gates: gates.map(({ id, label, command, exitCode }) => ({ id, label, command, exitCode })),
    };
    writeFileSync(failedPath, `${JSON.stringify(failureRecord, null, 2)}\n`, 'utf8');
    process.stderr.write(`[verify-structured-slots] qualification 有失败门禁；失败记录已写入 ${failedPath}\n`);
    return 1;
  }

  // 6. All gates passed: the record must satisfy the promotion schema, then it
  //    is written ATOMICALLY (temp sibling + rename). Stale release evidence
  //    from a prior run is replaced only by this honest all-green product.
  try {
    validateReleaseEvidence(releaseEvidence, RELEASE_EVIDENCE_GATE_IDS);
  } catch (error) {
    throw new VerifyError(
      `release evidence 未通过自身 schema 校验（不应发生）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  writeFileAtomic(p.releaseEvidencePath, `${JSON.stringify(releaseEvidence, null, 2)}\n`);
  process.stdout.write(`[verify-structured-slots] release evidence 已写入 ${p.releaseEvidencePath}\n`);
  process.stdout.write('[verify-structured-slots] qualification 全绿\n');
  return 0;
}

/** ------------------------------------------------------------------------ */
/** Promote capability (Step 8 — the ONLY production enable path)            */
/** ------------------------------------------------------------------------ */

function porcelain(): string[] {
  const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0);
}

/** Injectable dependencies so tests can drive promote against a temp workspace. */
export interface PromoteDeps {
  porcelain?: () => string[];
}

export function runPromoteCapability(
  releaseEvidenceArg: string,
  paths: Partial<VerifyPaths> = {},
  deps: PromoteDeps = {},
): number {
  const p = { ...DEFAULT_PATHS, ...paths };
  const releaseEvidencePath = resolve(p.workspaceRoot, releaseEvidenceArg);
  if (!existsSync(releaseEvidencePath)) {
    throw new VerifyError(`release evidence 不存在：${releaseEvidencePath}`, 2);
  }
  const release = JSON.parse(readFileSync(releaseEvidencePath, 'utf8')) as Record<string, unknown>;

  // 0. EXACT release-evidence schema validation FIRST, before ANY digest or
  //    checkpoint cross-check. Arbitrary JSON whose digests happen to match the
  //    real files but whose structure/mode/gate set is wrong (e.g. a failure
  //    record, a `mode: 'integrated-qualify'` record, a forged partial record)
  //    is rejected here and can never reach the manifest write. Fail closed.
  try {
    validateReleaseEvidence(release, RELEASE_EVIDENCE_GATE_IDS);
  } catch (error) {
    throw new VerifyError(
      `release evidence 校验失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 1. Checkpoint HEAD must match the release evidence.
  if (release.checkpointCommit !== gitCommit()) {
    throw new VerifyError('checkpoint HEAD 与 release evidence 不一致；promotion 必须从同一 commit 执行');
  }
  // 2. Normalized source-tree digest and lock digest must match.
  if (release.sourceTreeDigest !== cleanSourceDigest()) {
    throw new VerifyError('source-tree digest 与 release evidence 不一致');
  }
  if (release.packageLockSha256 !== packageLockSha256()) {
    throw new VerifyError('package-lock digest 与 release evidence 不一致');
  }

  // 3. Integrated profile evidence MUST be the SUCCESS shape (schemaVersion 1,
  //    mode 'integrated-qualify', no `outcome` field). The honest-failure
  //    shapes (`no_scale_passed` / `child_failed`) are rejected here — a failed
  //    qualification must never promote. Then the exact digest cross-check.
  const evidence = JSON.parse(readFileSync(p.profileEvidencePath, 'utf8')) as Record<string, unknown>;
  try {
    validateProfileEvidence(evidence);
  } catch (error) {
    throw new VerifyError(
      `profile evidence 不是成功的 integrated-qualify 证据：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (canonicalJsonSha256(evidence) !== release.profileEvidenceDigest) {
    throw new VerifyError('profile evidence digest 与 release evidence 不一致');
  }
  const profile = loadStructuredPlatformProfile(p.profilePath);
  if (profile.status !== 'final') {
    throw new VerifyError('promotion requires a FINAL profile');
  }
  if (profileCanonicalDigest(profile) !== release.finalProfileDigest) {
    throw new VerifyError('final profile digest 与 release evidence 不一致');
  }
  if (profile.evidenceDigest !== release.profileEvidenceDigest) {
    throw new VerifyError('final profile evidenceDigest 与 release evidence 不一致');
  }

  // 4. Required ABI list must match the current manifest.
  const manifest = readCurrentManifest(p.manifestPath);
  const releaseAbis = Array.isArray(release.requiredAbis) ? (release.requiredAbis as unknown[]) : [];
  if (
    releaseAbis.length !== manifest.requiredAbis.length ||
    !manifest.requiredAbis.every((abi) => releaseAbis.includes(abi))
  ) {
    throw new VerifyError('required ABI list 与当前 manifest 不一致');
  }

  // 5. Dirty/untracked allowlist: exactly the four generated files.
  const allowed = new Set<string>(QUALIFICATION_GENERATED_OUTPUTS);
  const offenders = (deps.porcelain ?? porcelain)().filter((path) => !allowed.has(path));
  if (offenders.length > 0) {
    throw new VerifyError(`dirty/untracked tree outside the generated-output allowlist: ${offenders.join(', ')}`);
  }

  // 6. Write the ENABLED capability manifest atomically. profileDigest
  //    references the final profile; evidenceDigest references the release
  //    evidence — the release evidence itself carries no capability-manifest
  //    digest.
  const capability = {
    version: 1,
    status: 'enabled',
    profileIdentity: profile.identity,
    profileDigest: profileCanonicalDigest(profile),
    evidenceDigest: canonicalJsonSha256(release),
    requiredAbis: [...manifest.requiredAbis],
  };
  writeFileAtomic(p.manifestPath, `${JSON.stringify(capability, null, 2)}\n`);
  process.stdout.write(`[verify-structured-slots] capability manifest 已启用（${p.manifestPath}）\n`);
  return 0;
}

/** ------------------------------------------------------------------------ */
/** CLI                                                                      */
/** ------------------------------------------------------------------------ */

function main(argv: readonly string[]): number {
  let mode: 'acceptance-only' | 'qualify' | 'promote' | null = null;
  let capability: string | null = null;
  let releaseEvidenceArg: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new VerifyError(`flag ${flag} requires a value`, 2);
      }
      i += 1;
      return value;
    };
    if (flag === '--acceptance-only') {
      mode = 'acceptance-only';
    } else if (flag === '--capability') {
      capability = next();
    } else if (flag === '--qualify') {
      mode = 'qualify';
    } else if (flag === '--promote-capability') {
      mode = 'promote';
      releaseEvidenceArg = next();
    } else {
      throw new VerifyError(`unknown flag '${flag}'\n${VERIFY_USAGE}`, 2);
    }
  }
  if (mode === 'acceptance-only') {
    if (capability === null) throw new VerifyError('--acceptance-only requires --capability <injected|production>', 2);
    return runAcceptanceOnly(capability);
  }
  if (mode === 'qualify') {
    if (capability !== null || releaseEvidenceArg !== null) throw new VerifyError(VERIFY_USAGE, 2);
    return runQualify();
  }
  if (mode === 'promote') {
    if (releaseEvidenceArg === null) throw new VerifyError('--promote-capability requires a release evidence path', 2);
    return runPromoteCapability(releaseEvidenceArg);
  }
  throw new VerifyError(VERIFY_USAGE, 2);
}

/**
 * Direct-execution guard: only run the CLI when this module is the entry point
 * (`npx tsx scripts/verify-structured-slots.ts ...`), so tests can import
 * `runQualify` / `runPromoteCapability` / the validators without triggering
 * the CLI. `process.argv[1]` may be undefined (e.g. vitest), in which case
 * `pathToFileURL('')` resolves the cwd and never equals this module URL.
 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const code = main(process.argv.slice(2));
    process.exitCode = code;
  } catch (error) {
    if (error instanceof VerifyError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.exitCode;
    } else {
      process.stderr.write(
        `VERIFY_STRUCTURED_SLOTS: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
