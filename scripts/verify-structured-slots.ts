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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJsonSha256 } from '../src/server/structured-slots/canonical-json';
import {
  loadStructuredPlatformProfile,
  profileCanonicalDigest,
} from '../src/server/structured-slots/platform-profile';
import { validateRuntimeCapability } from '../src/server/structured-slots/runtime-capability';
import type { StructuredRuntimeCapabilityV1 } from '../src/server/structured-slots/runtime-capability';

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPM = 'npm';
const NPX = 'npx';

const PROFILE_PATH = resolve(WORKSPACE_ROOT, 'src/server/structured-slots/platform-profile-v1.json');
const MANIFEST_PATH = resolve(WORKSPACE_ROOT, 'src/server/structured-slots/runtime-capability-v1.json');
const PROFILE_EVIDENCE_PATH = resolve(WORKSPACE_ROOT, 'docs/evidence/structured-slot-platform-profile-v1.json');
const RELEASE_EVIDENCE_PATH = resolve(WORKSPACE_ROOT, 'docs/evidence/structured-slot-release-v1.json');

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

function gitCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: WORKSPACE_ROOT, encoding: 'utf8' }).trim();
}

/** SHA-256 over the sorted (relative path, sha256) of every git-tracked file. */
function cleanSourceDigest(): string {
  const files = execFileSync('git', ['ls-files'], { cwd: WORKSPACE_ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
  const entries: Record<string, string> = {};
  for (const file of files) {
    entries[file] = sha256Hex(readFileSync(resolve(WORKSPACE_ROOT, file)));
  }
  return canonicalJsonSha256(entries);
}

function packageLockSha256(): string {
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

function loadProfileEvidence(): Record<string, unknown> {
  if (!existsSync(PROFILE_EVIDENCE_PATH)) {
    throw new VerifyError('profile evidence 不存在；必须先运行 integrated reference benchmark');
  }
  return JSON.parse(readFileSync(PROFILE_EVIDENCE_PATH, 'utf8')) as Record<string, unknown>;
}

function readCurrentManifest(): StructuredRuntimeCapabilityV1 {
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as unknown;
  return validateRuntimeCapability(raw);
}

function runQualify(): number {
  // 1. The final profile must be `final` and reference the integrated evidence.
  const profile = loadStructuredPlatformProfile(PROFILE_PATH);
  if (profile.status !== 'final') {
    throw new VerifyError('qualification requires a FINAL profile (integrated reference benchmark evidence)');
  }
  const evidence = loadProfileEvidence();
  const evidenceDigest = canonicalJsonSha256(evidence);
  if (profile.evidenceDigest !== evidenceDigest) {
    throw new VerifyError('profile evidenceDigest does not match the profile evidence file');
  }

  // 2. The production manifest must STILL be disabled (the promotion is a
  //    separate, later step; only it may flip the checked-in phase).
  const manifest = readCurrentManifest();
  if (manifest.status !== 'disabled') {
    throw new VerifyError('production manifest must still be disabled during qualification');
  }

  // 3. Re-run the full hermetic command list with the final profile in place,
  //    explicit capability injection in the structured acceptance only.
  const gates: GateReport[] = [
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

  // 4. Write the release evidence. It must NOT contain the capability-manifest
  //    digest (that is the next node in the one-way chain).
  const releaseEvidence = {
    schemaVersion: 1,
    gate: 'verify:structured-slots',
    mode: 'qualify',
    checkpointCommit: gitCommit(),
    sourceTreeDigest: cleanSourceDigest(),
    packageLockSha256: packageLockSha256(),
    profileEvidencePath: 'docs/evidence/structured-slot-platform-profile-v1.json',
    profileEvidenceDigest: evidenceDigest,
    finalProfilePath: 'src/server/structured-slots/platform-profile-v1.json',
    finalProfileDigest: profileCanonicalDigest(profile),
    requiredAbis: [...manifest.requiredAbis],
    piPreflightCharacterization: 'forge-pi-slot-preflight/v1',
    gates: gates.map(({ id, label, command, exitCode }) => ({ id, label, command, exitCode })),
    observedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(RELEASE_EVIDENCE_PATH), { recursive: true });
  writeFileSync(RELEASE_EVIDENCE_PATH, `${JSON.stringify(releaseEvidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`[verify-structured-slots] release evidence 已写入 ${RELEASE_EVIDENCE_PATH}\n`);

  if (!allPassed) {
    process.stderr.write('[verify-structured-slots] qualification 有失败门禁\n');
    return 1;
  }
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

function runPromoteCapability(releaseEvidenceArg: string): number {
  const releaseEvidencePath = resolve(WORKSPACE_ROOT, releaseEvidenceArg);
  if (!existsSync(releaseEvidencePath)) {
    throw new VerifyError(`release evidence 不存在：${releaseEvidencePath}`, 2);
  }
  const release = JSON.parse(readFileSync(releaseEvidencePath, 'utf8')) as Record<string, unknown>;

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

  // 3. Integrated profile evidence + exact final profile digest.
  const evidence = JSON.parse(readFileSync(PROFILE_EVIDENCE_PATH, 'utf8')) as Record<string, unknown>;
  if (canonicalJsonSha256(evidence) !== release.profileEvidenceDigest) {
    throw new VerifyError('profile evidence digest 与 release evidence 不一致');
  }
  const profile = loadStructuredPlatformProfile(PROFILE_PATH);
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
  const manifest = readCurrentManifest();
  const releaseAbis = Array.isArray(release.requiredAbis)
    ? (release.requiredAbis as unknown[])
    : [];
  if (
    releaseAbis.length !== manifest.requiredAbis.length ||
    !manifest.requiredAbis.every((abi) => releaseAbis.includes(abi))
  ) {
    throw new VerifyError('required ABI list 与当前 manifest 不一致');
  }

  // 5. Dirty/untracked allowlist: exactly the four generated files.
  const allowed = new Set<string>([
    'src/server/structured-slots/platform-profile-v1.json',
    'src/server/structured-slots/runtime-capability-v1.json',
    'docs/evidence/structured-slot-platform-profile-v1.json',
    'docs/evidence/structured-slot-release-v1.json',
  ]);
  const offenders = porcelain().filter((path) => !allowed.has(path));
  if (offenders.length > 0) {
    throw new VerifyError(`dirty/untracked tree outside the generated-output allowlist: ${offenders.join(', ')}`);
  }

  // 6. Write the ENABLED capability manifest. profileDigest references the
  //    final profile; evidenceDigest references the release evidence — the
  //    release evidence itself carries no capability-manifest digest.
  const capability = {
    version: 1,
    status: 'enabled',
    profileIdentity: profile.identity,
    profileDigest: profileCanonicalDigest(profile),
    evidenceDigest: canonicalJsonSha256(release),
    requiredAbis: [...manifest.requiredAbis],
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(capability, null, 2)}\n`, 'utf8');
  process.stdout.write(`[verify-structured-slots] capability manifest 已启用（${MANIFEST_PATH}）\n`);
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
