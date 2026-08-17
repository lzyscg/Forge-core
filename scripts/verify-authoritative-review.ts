#!/usr/bin/env node
/**
 * Authoritative review v2 offline evidence command (Task 27, spec §17, design
 * §25.4). Mirrors the v1 `verify-structured-slots` flow with the v2
 * one-way evidence chain (source + final profile -> platform benchmark
 * evidence -> release evidence -> capability manifest).
 *
 * Modes:
 *
 *   --acceptance-only --capability injected|production
 *       The v2 hermetic acceptance: `npx vitest run
 *       src/server/template/zhihu-salt-chapter-draft-v2.runtime.acceptance.test.ts`
 *       PLUS the v2 pi-preflight characterization. `injected` runs through
 *       the explicit injected matching environment; `production` asserts the
 *       production-default readiness (the disabled capability keeps this
 *       path unavailable until Task 28 promotion).
 *
 *   --qualify
 *       Step 7 qualification: validates the platform benchmark evidence +
 *       the final profile, confirms the checked-in capability manifest is
 *       STILL disabled, re-runs the full hermetic command list, records the
 *       v2 pi-preflight characterization, and writes the release evidence
 *       to `docs/evidence/authoritative-review-release-v1.json`. The release
 *       evidence carries NO capability-manifest digest (it is the next node
 *       in the one-way chain).
 *
 *   --promote-capability <release-evidence.json>
 *       Step 8 promotion (the ONLY production enable path): validates the
 *       checkpoint HEAD, normalized source-tree digest, package-lock digest,
 *       platform evidence, the exact final profile digest and the required
 *       ABI list, then writes the ENABLED capability manifest. No
 *       environment variable or manual boolean is an alternate enable path.
 *
 *   --validate-only
 *       Validates the current state without writing anything: the platform
 *       evidence + final profile + the dirty/untracked allowlist + the
 *       release evidence (if present). Used by Task 27 Step 7 to prove
 *       the generated-output allowlist is the only dirty set.
 *
 * The dirty/untracked allowlist is exactly the four generated qualification
 * outputs (final profile JSON, capability manifest, platform evidence, release
 * evidence). Promotion fails closed if any other path is dirty.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalJsonSha256 } from '../src/server/structured-slots/canonical-json';
import { AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS, isAuthoritativeReviewGeneratedOutput } from './authoritative-review-qualification-outputs';
import {
  validateAuthoritativeReviewProfileEvidence,
  validateAuthoritativeReviewReleaseEvidence,
  AUTHORITATIVE_REVIEW_QUALIFICATION_GATE_IDS,
  AUTHORITATIVE_REVIEW_FINAL_PROFILE_PATH,
  AUTHORITATIVE_REVIEW_PLATFORM_EVIDENCE_PATH,
  AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION,
  AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY,
} from './authoritative-review-evidence-schema';
import { validateAuthoritativeReviewCapability } from '../src/server/structured-slots/authoritative-review-capability';
import type { AuthoritativeReviewCapabilityV1 } from '../src/server/structured-slots/authoritative-review-capability';
import {
  loadAuthoritativeReviewProfileFile,
  profileCanonicalDigest,
} from '../src/server/structured-slots/authoritative-review-profile';

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPM = 'npm';
const NPX = 'npx';

const PROFILE_PATH = resolve(WORKSPACE_ROOT, 'src/server/structured-slots/authoritative-review-profile-v1.json');
const MANIFEST_PATH = resolve(WORKSPACE_ROOT, 'src/server/structured-slots/authoritative-review-capability-v1.json');
const PLATFORM_EVIDENCE_PATH = resolve(WORKSPACE_ROOT, 'docs/evidence/authoritative-review-platform-profile-v1.json');
const RELEASE_EVIDENCE_PATH = resolve(WORKSPACE_ROOT, 'docs/evidence/authoritative-review-release-v1.json');

export interface VerifyPaths {
  profilePath: string;
  manifestPath: string;
  platformEvidencePath: string;
  releaseEvidencePath: string;
  workspaceRoot: string;
}

const DEFAULT_PATHS: VerifyPaths = {
  profilePath: PROFILE_PATH,
  manifestPath: MANIFEST_PATH,
  platformEvidencePath: PLATFORM_EVIDENCE_PATH,
  releaseEvidencePath: RELEASE_EVIDENCE_PATH,
  workspaceRoot: WORKSPACE_ROOT,
};

const VERIFY_USAGE =
  'usage: verify-authoritative-review ' +
  '--acceptance-only --capability <injected|production> | ' +
  '--qualify | --promote-capability <release-evidence.json> | ' +
  '--validate-only';

class VerifyError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(`VERIFY_AUTHORITATIVE_REVIEW: ${message}`);
    this.name = 'VerifyError';
    this.exitCode = exitCode;
  }
}

function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function writeFileAtomic(path: string, contents: string): void {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, contents, 'utf8');
  renameSync(tmpPath, path);
}

export function gitCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: WORKSPACE_ROOT, encoding: 'utf8' }).trim();
}

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
    .filter((line) => !isAuthoritativeReviewGeneratedOutput(line))
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
  process.stdout.write(`[verify-authoritative-review] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (output.length > 0) process.stdout.write(output);
  process.stdout.write(`[verify-authoritative-review] ${id} -> exit=${String(result.status)}\n`);
  return { id, label, command: `${command} ${args.join(' ')}`, exitCode: result.status };
}

function runAcceptanceOnly(capability: string): number {
  if (capability !== 'injected' && capability !== 'production') {
    throw new VerifyError(`unknown --capability '${capability}' (expected injected|production)`, 2);
  }
  process.env.FORGE_AUTHORITATIVE_REVIEW_CAPABILITY_MODE = capability;
  const gates: GateReport[] = [
    runGate(
      'authoritative-acceptance',
      `authoritative review v2 端到端验收（capability=${capability}）`,
      NPX,
      ['vitest', 'run', 'src/server/template/zhihu-salt-chapter-draft-v2.runtime.acceptance.test.ts'],
    ),
    runGate(
      'authoritative-pi-preflight',
      '锁定 Pi 0.82 + v2 预校验计费特征（forge-authoritative-review-pi-preflight/v1）',
      NPX,
      ['vitest', 'run', 'src/server/runtime/pi-agent-runtime.test.ts', '-t', 'Task 14 Step 1'],
    ),
  ];
  const failed = gates.filter((gate) => gate.exitCode !== 0);
  if (failed.length > 0) {
    for (const gate of failed) {
      process.stderr.write(`[verify-authoritative-review] 失败：${gate.id}（${gate.label}）退出码 ${String(gate.exitCode)}\n`);
    }
    return 1;
  }
  process.stdout.write('[verify-authoritative-review] acceptance-only 全绿\n');
  return 0;
}

function loadPlatformEvidence(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new VerifyError('platform evidence 不存在；必须先运行 integrated reference benchmark');
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function readCapability(path: string): AuthoritativeReviewCapabilityV1 {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return validateAuthoritativeReviewCapability(raw);
}

export interface QualifyDeps {
  gates?: () => GateReport[];
}

export function runQualify(paths: Partial<VerifyPaths> = {}, deps: QualifyDeps = {}): number {
  const p = { ...DEFAULT_PATHS, ...paths };
  const profile = loadAuthoritativeReviewProfileFile(p.profilePath);
  if (profile.qualificationState !== 'final') {
    throw new VerifyError('qualification requires a FINAL profile (integrated reference benchmark evidence)');
  }
  const evidence = loadPlatformEvidence(p.platformEvidencePath);
  try {
    validateAuthoritativeReviewProfileEvidence(evidence);
  } catch (error) {
    throw new VerifyError(`platform evidence 语义校验失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (evidence.gitCommit !== gitCommit()) {
    throw new VerifyError('platform evidence gitCommit 与当前 HEAD 不一致');
  }
  if (evidence.sourceTreeDigest !== cleanSourceDigest()) {
    throw new VerifyError('platform evidence sourceTreeDigest 与当前 source tree 不一致');
  }
  if (evidence.packageLockSha256 !== packageLockSha256()) {
    throw new VerifyError('platform evidence packageLockSha256 与当前 lockfile 不一致');
  }
  if (evidence.finalProfileDigest !== profileCanonicalDigest(profile)) {
    throw new VerifyError('platform evidence finalProfileDigest 与 final profile 不一致');
  }
  const capability = readCapability(p.manifestPath);
  if (capability.status !== 'disabled') {
    throw new VerifyError('capability manifest 必须仍为 disabled；promotion 才是合法开启路径');
  }

  const gates: GateReport[] =
    deps.gates !== undefined
      ? deps.gates()
      : [
          runGate('typecheck', 'TypeScript 类型检查', NPM, ['run', 'check']),
          runGate('unit-tests', '单元/集成测试', NPM, ['test', '--', '--reporter=dot']),
          runGate('build', '客户端与服务端构建', NPM, ['run', 'build']),
          runGate('e2e', 'Playwright 端到端', NPM, ['run', 'e2e']),
          runGate(
            'authoritative-acceptance',
            'authoritative review v2 端到端验收（注入环境）',
            NPM,
            ['run', 'verify:authoritative-review', '--', '--acceptance-only', '--capability', 'injected'],
          ),
          runGate(
            'authoritative-acceptance-injected',
            'v2 已注入环境验收（直接运行 vitest）',
            NPX,
            ['vitest', 'run', 'src/server/template/zhihu-salt-chapter-draft-v2.runtime.acceptance.test.ts'],
          ),
          runGate(
            'authoritative-pi-preflight',
            '锁定 Pi 0.82 + v2 预校验计费特征',
            NPX,
            ['vitest', 'run', 'src/server/runtime/pi-agent-runtime.test.ts', '-t', 'Task 14 Step 1'],
          ),
        ];
  const allPassed = gates.every((gate) => gate.exitCode === 0);

  const releaseEvidence = {
    schemaVersion: 1,
    gate: 'verify:authoritative-review',
    mode: 'qualify',
    checkpointCommit: gitCommit(),
    sourceTreeDigest: cleanSourceDigest(),
    packageLockSha256: packageLockSha256(),
    finalProfilePath: AUTHORITATIVE_REVIEW_FINAL_PROFILE_PATH,
    finalProfileDigest: profileCanonicalDigest(profile),
    platformEvidencePath: AUTHORITATIVE_REVIEW_PLATFORM_EVIDENCE_PATH,
    platformEvidenceDigest: canonicalJsonSha256(evidence),
    requiredAbis: [...AUTHORITATIVE_REVIEW_REQUIRED_ABI_IDENTITY],
    piPreflightCharacterization: AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION,
    gates: gates.map(({ id, label, command, exitCode }) => ({ id, label, command, exitCode })),
    generatedOutputs: [...AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS],
    observedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(p.releaseEvidencePath), { recursive: true });

  if (!allPassed) {
    const failedPath = `${p.releaseEvidencePath}.failed-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const failureRecord = {
      schemaVersion: 1,
      record: 'qualify-failed',
      gate: 'verify:authoritative-review',
      mode: 'qualify',
      failedAt: new Date().toISOString(),
      releaseEvidencePath: p.releaseEvidencePath,
      gates: gates.map(({ id, label, command, exitCode }) => ({ id, label, command, exitCode })),
    };
    writeFileSync(failedPath, `${JSON.stringify(failureRecord, null, 2)}\n`, 'utf8');
    process.stderr.write(`[verify-authoritative-review] qualification 有失败门禁；失败记录已写入 ${failedPath}\n`);
    return 1;
  }
  try {
    validateAuthoritativeReviewReleaseEvidence(releaseEvidence);
  } catch (error) {
    throw new VerifyError(
      `release evidence 未通过自身 schema 校验（不应发生）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  writeFileAtomic(p.releaseEvidencePath, `${JSON.stringify(releaseEvidence, null, 2)}\n`);
  process.stdout.write(`[verify-authoritative-review] release evidence 已写入 ${p.releaseEvidencePath}\n`);
  process.stdout.write('[verify-authoritative-review] qualification 全绿\n');
  return 0;
}

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
  try {
    validateAuthoritativeReviewReleaseEvidence(release);
  } catch (error) {
    throw new VerifyError(
      `release evidence 校验失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (release.checkpointCommit !== gitCommit()) {
    throw new VerifyError('checkpoint HEAD 与 release evidence 不一致；promotion 必须从同一 commit 执行');
  }
  if (release.sourceTreeDigest !== cleanSourceDigest()) {
    throw new VerifyError('source-tree digest 与 release evidence 不一致');
  }
  if (release.packageLockSha256 !== packageLockSha256()) {
    throw new VerifyError('package-lock digest 与 release evidence 不一致');
  }

  const evidence = JSON.parse(readFileSync(p.platformEvidencePath, 'utf8')) as Record<string, unknown>;
  try {
    validateAuthoritativeReviewProfileEvidence(evidence);
  } catch (error) {
    throw new VerifyError(
      `platform evidence 不是成功的 integrated-qualify 证据：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (canonicalJsonSha256(evidence) !== release.platformEvidenceDigest) {
    throw new VerifyError('platform evidence digest 与 release evidence 不一致');
  }
  const profile = loadAuthoritativeReviewProfileFile(p.profilePath);
  if (profile.qualificationState !== 'final') {
    throw new VerifyError('promotion requires a FINAL profile');
  }
  if (profileCanonicalDigest(profile) !== release.finalProfileDigest) {
    throw new VerifyError('final profile digest 与 release evidence 不一致');
  }
  const capability = readCapability(p.manifestPath);
  // Promotion is the ONE legal disabled → enabled transition (design §17).
  // An already-enabled manifest cannot be silently overwritten, even with a
  // matching release evidence: any re-promotion must go through a fresh
  // qualify cycle that produces a new release evidence and an updated
  // capability manifest through the same scripted path.
  if (capability.status !== 'disabled') {
    throw new VerifyError(
      'capability manifest must be disabled before promotion; re-promotion is rejected (one-way chain)',
    );
  }
  const releaseAbis = Array.isArray(release.requiredAbis) ? (release.requiredAbis as unknown[]) : [];
  if (
    releaseAbis.length !== capability.requiredAbis.length ||
    !capability.requiredAbis.every((abi) => releaseAbis.includes(abi))
  ) {
    throw new VerifyError('required ABI list 与当前 manifest 不一致');
  }

  const allowed = new Set<string>(AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS);
  const offenders = (deps.porcelain ?? porcelain)().filter((path) => !allowed.has(path));
  if (offenders.length > 0) {
    throw new VerifyError(`dirty/untracked tree outside the generated-output allowlist: ${offenders.join(', ')}`);
  }

  const enabled: AuthoritativeReviewCapabilityV1 = {
    version: 1,
    status: 'enabled',
    profileIdentity: 'forge-authoritative-review/v1',
    profileDigest: profileCanonicalDigest(profile),
    evidenceDigest: canonicalJsonSha256(release),
    requiredAbis: [...capability.requiredAbis],
  };
  writeFileAtomic(p.manifestPath, `${JSON.stringify(enabled, null, 2)}\n`);
  process.stdout.write(`[verify-authoritative-review] capability manifest 已启用（${p.manifestPath}）\n`);
  return 0;
}

export interface ValidateOnlyDeps {
  porcelain?: () => string[];
}

export function runValidateOnly(paths: Partial<VerifyPaths> = {}, deps: ValidateOnlyDeps = {}): number {
  const p = { ...DEFAULT_PATHS, ...paths };
  const profile = loadAuthoritativeReviewProfileFile(p.profilePath);
  if (profile.qualificationState !== 'final') {
    throw new VerifyError('validate-only requires a FINAL profile');
  }
  if (existsSync(p.platformEvidencePath)) {
    const evidence = JSON.parse(readFileSync(p.platformEvidencePath, 'utf8')) as Record<string, unknown>;
    validateAuthoritativeReviewProfileEvidence(evidence);
  }
  if (existsSync(p.releaseEvidencePath)) {
    const release = JSON.parse(readFileSync(p.releaseEvidencePath, 'utf8')) as Record<string, unknown>;
    validateAuthoritativeReviewReleaseEvidence(release);
  }
  const allowed = new Set<string>(AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS);
  const offenders = (deps.porcelain ?? porcelain)().filter((path) => !allowed.has(path));
  if (offenders.length > 0) {
    throw new VerifyError(`dirty/untracked tree outside the generated-output allowlist: ${offenders.join(', ')}`);
  }
  process.stdout.write('[verify-authoritative-review] validate-only 全绿\n');
  return 0;
}

function main(argv: readonly string[]): number {
  let mode: 'acceptance-only' | 'qualify' | 'promote' | 'validate-only' | null = null;
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
    } else if (flag === '--validate-only') {
      mode = 'validate-only';
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
  if (mode === 'validate-only') {
    return runValidateOnly();
  }
  throw new VerifyError(VERIFY_USAGE, 2);
}

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
        `VERIFY_AUTHORITATIVE_REVIEW: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
