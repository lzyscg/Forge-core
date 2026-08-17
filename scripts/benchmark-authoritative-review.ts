/**
 * Authoritative review v2 benchmark harness (Task 27, design §25.4 / §25.13 O08).
 *
 * Modes:
 *   --mode primitive-smoke      Development smoke over the REAL v2 domain
 *                               primitives (canonical identifiers, schema
 *                               validators, profile digest, registry identity)
 *                               through the adapter. Produces NO release
 *                               evidence and cannot change candidate values.
 *   --mode integrated-scale     HIDDEN child-worker mode (Task 27). Runs ONE
 *                               scale's full measurement in a FRESH process and
 *                               prints a single machine-readable
 *                               `integrated-scale-result` JSON line, then exits
 *                               0. Each scale measures in its own process so
 *                               peak RSS of one scale can never leak into
 *                               another scale's verdict (no V8 retained heap
 *                               from a prior scale).
 *   --mode integrated-qualify   Task 27 orchestrator: the ONLY mode that may
 *                               run the integrated reference benchmark, write
 *                               platform evidence and rewrite the provisional
 *                               profile to final. The parent keeps the
 *                               reproducible-evidence discipline (runner
 *                               identity preflight, clean-source-tree guard,
 *                               evidence facts) and spawns one fresh child per
 *                               scale via `--mode integrated-scale`.
 *   --mode alloc-probe          HIDDEN helper for the isolation regression
 *                               test (spawns a fresh process, optionally
 *                               allocates a transient buffer, prints its own
 *                               peak RSS).
 *
 * Evidence discipline (design §25.4): a run on another environment may
 * compare results but can never produce a final profile; qualification
 * refuses a runner mismatch or a dirty source tree outside the
 * generated-output allowlist. Output is machine-readable JSONL: one `case`
 * record per measured case plus a `summary` record carrying peak RSS and
 * disk bytes.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { canonicalJsonSha256 } from '../src/server/structured-slots/canonical-json';
import {
  AUTHORITATIVE_REVIEW_FINAL_BOUND_CASE_IDS,
  AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS,
  AUTHORITATIVE_REVIEW_RUNNER_IDENTITY,
  AUTHORITATIVE_REVIEW_PI_PREFLIGHT_CHARACTERIZATION,
  isAuthoritativeReviewGeneratedOutput,
} from './authoritative-review-evidence-schema';
import type { AuthoritativeReviewCasesV1 } from './authoritative-review-integrated-benchmark-adapter';
import {
  buildAuthoritativeReviewTestProfileBody,
} from '../src/server/structured-slots/test-support/authoritative-review-test-registry';
import {
  loadAuthoritativeReviewProfileFile,
  profileCanonicalDigest,
} from '../src/server/structured-slots/authoritative-review-profile';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const REFERENCE_RUNNER_PATH = resolve(REPO_ROOT, 'docs/evidence/authoritative-review-reference-runner-v1.json');

/** Stable harness-level codes. */
const BENCHMARK_RUNNER_MISMATCH = 'AUTHORITATIVE_REVIEW_BENCHMARK_RUNNER_MISMATCH';
const BENCHMARK_DIRTY_TREE = 'AUTHORITATIVE_REVIEW_BENCHMARK_DIRTY_TREE';
const BENCHMARK_USAGE = 'AUTHORITATIVE_REVIEW_BENCHMARK_USAGE';
const BENCHMARK_INTEGRATED_PROFILE = 'AUTHORITATIVE_REVIEW_BENCHMARK_INTEGRATED_PROFILE';
const BENCHMARK_INTEGRATED_BOUNDS = 'AUTHORITATIVE_REVIEW_BENCHMARK_INTEGRATED_BOUNDS';
const BENCHMARK_INTEGRATED_FROZEN = 'AUTHORITATIVE_REVIEW_BENCHMARK_INTEGRATED_FROZEN';
const BENCHMARK_CHILD_FAILED = 'AUTHORITATIVE_REVIEW_BENCHMARK_CHILD_FAILED';
const BENCHMARK_EVIDENCE_INVALID = 'AUTHORITATIVE_REVIEW_BENCHMARK_EVIDENCE_INVALID';

class BenchmarkError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode = 1) {
    super(`${code}: ${message}`);
    this.name = 'BenchmarkError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

const GENERATED_OUTPUT_ALLOWLIST = new Set<string>(AUTHORITATIVE_REVIEW_GENERATED_OUTPUTS);

interface CliArgs {
  mode: 'primitive-smoke' | 'integrated-qualify' | 'integrated-scale' | 'alloc-probe';
  profile?: string;
  evidence?: string;
  adapter?: string;
  scale?: number;
  allocBytes?: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { mode: 'primitive-smoke' };
  let sawMode = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new BenchmarkError(BENCHMARK_USAGE, `flag ${flag} requires a value`, 2);
      }
      i += 1;
      return value;
    };
    if (flag === '--mode') {
      const mode = next();
      if (mode !== 'primitive-smoke' && mode !== 'integrated-qualify' && mode !== 'integrated-scale' && mode !== 'alloc-probe') {
        throw new BenchmarkError(BENCHMARK_USAGE, `unknown mode '${mode}'`, 2);
      }
      args.mode = mode;
      sawMode = true;
    } else if (flag === '--profile') {
      args.profile = next();
    } else if (flag === '--evidence') {
      args.evidence = next();
    } else if (flag === '--adapter') {
      args.adapter = next();
    } else if (flag === '--scale') {
      const raw = next();
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new BenchmarkError(BENCHMARK_USAGE, `--scale requires a positive integer, got '${raw}'`, 2);
      }
      args.scale = parsed;
    } else if (flag === '--alloc-bytes') {
      const raw = next();
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new BenchmarkError(BENCHMARK_USAGE, `--alloc-bytes requires a non-negative integer, got '${raw}'`, 2);
      }
      args.allocBytes = parsed;
    } else {
      throw new BenchmarkError(BENCHMARK_USAGE, `unknown flag '${flag}'`, 2);
    }
  }
  if (!sawMode) {
    throw new BenchmarkError(BENCHMARK_USAGE, 'missing required --mode flag', 2);
  }
  if (args.mode === 'integrated-qualify' && (args.profile === undefined || args.evidence === undefined)) {
    throw new BenchmarkError(
      BENCHMARK_USAGE,
      'integrated-qualify requires --profile <profile json> and --evidence <evidence json>',
      2,
    );
  }
  if (args.mode === 'integrated-scale' && (args.scale === undefined || args.adapter === undefined)) {
    throw new BenchmarkError(
      BENCHMARK_USAGE,
      'integrated-scale requires --scale <N> and --adapter <path>',
      2,
    );
  }
  return args;
}

function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

export interface CaseResult {
  id: string;
  description: string;
  warmup: number;
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  sampleDigest: string;
  postCasePeakRssBytes: number;
}

export interface CaseDefinition {
  id: string;
  description: string;
  warmup: number;
  samples: number;
  unit: () => Promise<number>;
}

async function measureCase(definition: CaseDefinition, state: { peakRssBytes: number }): Promise<CaseResult> {
  const raw: number[] = [];
  for (let i = 0; i < definition.warmup; i++) {
    await definition.unit();
    state.peakRssBytes = Math.max(state.peakRssBytes, process.memoryUsage().rss);
  }
  for (let i = 0; i < definition.samples; i++) {
    const started = performance.now();
    await definition.unit();
    raw.push(performance.now() - started);
    state.peakRssBytes = Math.max(state.peakRssBytes, process.memoryUsage().rss);
  }
  const sorted = [...raw].sort((a, b) => a - b);
  return {
    id: definition.id,
    description: definition.description,
    warmup: definition.warmup,
    samples: definition.samples,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1] ?? 0,
    sampleDigest: canonicalJsonSha256(raw),
    postCasePeakRssBytes: state.peakRssBytes,
  };
}

function printCaseRecord(result: CaseResult, peakRssBytes: number): void {
  process.stdout.write(
    `${JSON.stringify({
      event: 'case',
      case: result.id,
      description: result.description,
      warmup: result.warmup,
      samples: result.samples,
      p50Ms: round(result.p50Ms),
      p95Ms: round(result.p95Ms),
      maxMs: round(result.maxMs),
      sampleDigest: result.sampleDigest,
      peakRssBytes,
      postCasePeakRssBytes: result.postCasePeakRssBytes,
    })}\n`,
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function sumDirectoryBytes(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries: string[] = [];
    try {
      entries = require('node:fs').readdirSync(dir, { withFileTypes: true }) as Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    } catch {
      return;
    }
    // Manually walk using the types-safe API below.
  };
  return total;
}

export function osMaxRssBytes(): number {
  const raw = process.resourceUsage().maxRSS;
  const currentRss = process.memoryUsage().rss;
  if (raw > 0 && raw < currentRss) {
    return raw * 1024;
  }
  return raw;
}

export interface ScaleBounds {
  authorMapChunkP95Ms: number;
  mapBuildCandidateP95Ms: number;
  mapReviewAssignmentP95Ms: number;
  contentGenerationP95Ms: number;
  contentReviewSettlementP95Ms: number;
  mapMigrationP95Ms: number;
  checkpointReplayP95Ms: number;
  locateBeyond9kP95Ms: number;
  publicationPinGcP95Ms: number;
  peakRssBytes: number;
  pageLatencyP95Ms: number;
  appendLatencyP95Ms: number;
  recoveryTimeP95Ms: number;
  eventCountHeadroom: number;
}

export interface IntegratedScaleReport {
  event: 'integrated-scale-result';
  scale: number;
  results: CaseResult[];
  peakRssBytes: number;
  diskBytes: number;
}

export const REQUIRED_BOUND_CASE_IDS: readonly string[] = AUTHORITATIVE_REVIEW_FINAL_BOUND_CASE_IDS;

export function evaluateScaleReport(report: IntegratedScaleReport, bounds: ScaleBounds): { violations: string[]; passed: boolean } {
  const byId = new Map(report.results.map((result) => [result.id, result]));
  const violations: string[] = [];
  for (const id of REQUIRED_BOUND_CASE_IDS) {
    if (!byId.has(id)) violations.push(`missing case ${id}`);
  }
  const p95 = (id: string): number => byId.get(id)?.p95Ms ?? 0;
  const max = (id: string): number => byId.get(id)?.maxMs ?? 0;
  if (byId.has('author-map-chunk-1k') && p95('author-map-chunk-1k') > bounds.authorMapChunkP95Ms) {
    violations.push('author-map-chunk-1k p95');
  }
  if (byId.has('map-review-24') && max('map-review-24') > bounds.mapReviewAssignmentP95Ms) {
    violations.push('map-review-24 max');
  }
  if (byId.has('content-generation-10k') && max('content-generation-10k') > bounds.contentGenerationP95Ms) {
    violations.push('content-generation-10k max');
  }
  if (byId.has('locate-beyond-9k') && p95('locate-beyond-9k') > bounds.locateBeyond9kP95Ms) {
    violations.push('locate-beyond-9k p95');
  }
  if (byId.has('publication-pin-gc') && max('publication-pin-gc') > bounds.publicationPinGcP95Ms) {
    violations.push('publication-pin-gc max');
  }
  if (report.peakRssBytes > bounds.peakRssBytes) {
    violations.push(`peak RSS ${report.peakRssBytes} > ${bounds.peakRssBytes}`);
  }
  return { violations, passed: violations.length === 0 };
}

export function integratedScaleCaseDefinitions(adapter: AuthoritativeReviewCasesV1): CaseDefinition[] {
  return [
    {
      id: 'author-map-chunk-1k',
      description: 'build 1k Map chunk / manifest / key ledger',
      warmup: 1,
      samples: 5,
      unit: async () => adapter.buildMapChunk1k(),
    },
    {
      id: 'optional-relation-fanout',
      description: '10k optional relations including zero & high-fan-out',
      warmup: 1,
      samples: 5,
      unit: async () => adapter.buildOptionalRelations(),
    },
    {
      id: 'map-review-24',
      description: 'default 24-paged Map review + layered observation',
      warmup: 1,
      samples: 5,
      unit: async () => adapter.runMapReviewBatch(),
    },
    {
      id: 'content-generation-10k',
      description: '10k content generation / manifest / finalizer',
      warmup: 1,
      samples: 5,
      unit: async () => adapter.buildContentGeneration10k(),
    },
    {
      id: 'review-ledger-10k',
      description: 'review assignment / adoption ledgers + Findings',
      warmup: 1,
      samples: 3,
      unit: async () => adapter.runReviewAssignment10k(),
    },
    {
      id: 'map-migration-10k',
      description: 'Map migration with equivalence / fresh / rewrite / carry',
      warmup: 1,
      samples: 3,
      unit: async () => adapter.runMapMigrationMix(),
    },
    {
      id: 'restart-replay-10k',
      description: 'checkpoint / genesis replay + restart',
      warmup: 0,
      samples: 1,
      unit: async () => adapter.runCheckpointReplay(),
    },
    {
      id: 'locate-beyond-9k',
      description: 'stable cursor traversal / locate after 9,000',
      warmup: 3,
      samples: 10,
      unit: async () => adapter.runLocateBeyond9k(),
    },
    {
      id: 'publication-pin-gc',
      description: 'publication pin / recursive GC closure',
      warmup: 1,
      samples: 3,
      unit: async () => adapter.runPublicationPinGc(),
    },
    {
      id: 'event-count-headroom',
      description: 'event-count headroom below 999,999',
      warmup: 0,
      samples: 1,
      unit: async () => adapter.measureEventCountHeadroom(),
    },
  ];
}

function currentHostDescriptor(): Record<string, string | number> {
  const cores = cpus();
  return {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cores[0]?.model ?? 'unknown',
    logicalCores: cores.length,
    totalMemoryMiB: Math.round(totalmem() / 1024 / 1024),
  };
}

export function assertRunnerMatchesReference(): { runnerId: string; runnerVersion: string; descriptorDigest: string } {
  if (!existsSync(REFERENCE_RUNNER_PATH)) {
    throw new BenchmarkError(
      BENCHMARK_RUNNER_MISMATCH,
      `cannot read reference runner at ${REFERENCE_RUNNER_PATH}`,
      4,
    );
  }
  const checked = JSON.parse(readFileSync(REFERENCE_RUNNER_PATH, 'utf8')) as Record<string, unknown>;
  const descriptor = checked['descriptor'] as Record<string, unknown>;
  const current = currentHostDescriptor();
  const currentDigest = canonicalJsonSha256(current);
  const checkedDigest = checked['descriptorDigest'];
  if (typeof checkedDigest !== 'string' || checkedDigest !== currentDigest || canonicalJsonSha256(descriptor) !== currentDigest) {
    throw new BenchmarkError(
      BENCHMARK_RUNNER_MISMATCH,
      `host descriptor digest ${currentDigest} does not match the checked-in reference runner ` +
        `(descriptorDigest ${String(checkedDigest)}); a run on another environment may compare ` +
        'results but cannot produce a final profile',
      4,
    );
  }
  return {
    runnerId: String(checked['runnerId'] ?? AUTHORITATIVE_REVIEW_RUNNER_IDENTITY),
    runnerVersion: String(checked['runnerVersion'] ?? '1.0.0'),
    descriptorDigest: currentDigest,
  };
}

export function cleanSourceDigest(): string {
  const files = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isAuthoritativeReviewGeneratedOutput(line))
    .sort();
  const entries: Record<string, string> = {};
  for (const file of files) {
    entries[file] = sha256Hex(readFileSync(resolve(REPO_ROOT, file)));
  }
  return canonicalJsonSha256(entries);
}

export function gitCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

export function packageLockSha256(): string {
  return sha256Hex(readFileSync(resolve(REPO_ROOT, 'package-lock.json')));
}

export function dependencyVersions(): Record<string, string> {
  const readVersion = (name: string): string => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'node_modules', name, 'package.json'), 'utf8')) as { version: string };
    return pkg.version;
  };
  return {
    'isolated-vm': readVersion('isolated-vm'),
    're2-wasm': readVersion('re2-wasm'),
    '@earendil-works/pi-ai': readVersion('@earendil-works/pi-ai'),
  };
}

export function assertCleanSourceTree(): void {
  const porcelain = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const offenders: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.trim().length === 0) continue;
    const path = line.slice(3).trim();
    if (path.includes(' -> ')) {
      offenders.push(path);
      continue;
    }
    if (!GENERATED_OUTPUT_ALLOWLIST.has(path)) {
      offenders.push(path);
    }
  }
  if (offenders.length > 0) {
    throw new BenchmarkError(
      BENCHMARK_DIRTY_TREE,
      `source tree is dirty outside the generated-output allowlist: ${offenders.join(', ')}`,
      5,
    );
  }
}

export function scaledLimits(percentage: number): {
  maxSlots: number;
  maxRelationsPerSlot: number;
  maxRelationTotal: number;
  targetBatchSize: number;
  scaffoldPayloadBytes: number;
} {
  const factor = percentage / 100;
  const scaledMaxSlots = Math.max(10_000, Math.floor(10_000 * factor));
  const scaledMaxRelationsPerSlot = Math.max(64, Math.floor(64 * factor));
  const scaledMaxRelationTotal = Math.max(4_000, Math.floor(4_000 * factor));
  const scaledTargetBatchSize = Math.max(24, Math.floor(24 * factor));
  const scaledPayload = Math.max(1_048_576, Math.floor(67_108_864 * factor));
  return {
    maxSlots: scaledMaxSlots,
    maxRelationsPerSlot: scaledMaxRelationsPerSlot,
    maxRelationTotal: scaledMaxRelationTotal,
    targetBatchSize: scaledTargetBatchSize,
    scaffoldPayloadBytes: scaledPayload,
  };
}

export interface AuthoritativeReviewBenchmarkEvidenceV1 {
  schemaVersion: 1;
  mode: 'integrated-qualify';
  runner: { runnerId: string; runnerVersion: string; descriptorDigest: string };
  gitCommit: string;
  sourceTreeDigest: string;
  packageLockSha256: string;
  dependencyVersions: { 'isolated-vm': string; 're2-wasm': string; '@earendil-works/pi-ai': string };
  warmupCount: number;
  sampleCount: number;
  peakRssBytes: number;
  diskBytes: number;
  cases: Array<{
    id: string;
    rawSampleDigest: string;
    samples: number;
    warmup: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    postCasePeakRssBytes: number;
  }>;
  candidatePercentage: number | null;
  selectionReason: string | null;
  finalProfileDigest: string;
  finalProfileQualificationState: 'final';
  finalProfileMaxSlots: number;
  finalProfileAssignmentPrimaryTargets: number;
  finalProfileAssignmentTotalObjects: number;
  bounds: Record<string, number>;
  perScaleResults: Array<Record<string, unknown>>;
}

async function runIntegratedQualify(args: CliArgs): Promise<never> {
  if (args.profile === undefined || args.evidence === undefined) {
    throw new BenchmarkError(BENCHMARK_USAGE, 'integrated-qualify requires --profile and --evidence', 2);
  }
  const runner = assertRunnerMatchesReference();
  assertCleanSourceTree();
  const evidenceFacts = {
    gitCommit: gitCommit(),
    sourceTreeDigest: cleanSourceDigest(),
    packageLockSha256: packageLockSha256(),
    dependencyVersions: dependencyVersions(),
  };
  const profilePath = resolve(REPO_ROOT, args.profile);
  const evidencePath = resolve(REPO_ROOT, args.evidence);
  const loadedProfile = loadAuthoritativeReviewProfileFile(profilePath);
  if (loadedProfile.qualificationState !== 'provisional') {
    throw new BenchmarkError(
      BENCHMARK_INTEGRATED_PROFILE,
      `the checked-in profile must be provisional until the integrated benchmark freezes it (got ${loadedProfile.qualificationState})`,
      3,
    );
  }
  const BOUNDS: ScaleBounds = {
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
  const scales = [100, 75, 50, 25];
  const perScaleResults: Array<Record<string, unknown>> = [];
  const tsxCli = resolve(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const scriptPath = resolve(SCRIPT_DIR, 'benchmark-authoritative-review.ts');
  const adapterPath =
    args.adapter !== undefined
      ? resolve(REPO_ROOT, args.adapter)
      : resolve(SCRIPT_DIR, 'authoritative-review-integrated-benchmark-adapter.ts');

  for (const percentage of scales) {
    process.stdout.write(`[benchmark-authoritative-review] integrated scale ${percentage}%\n`);
    const child = spawnSync(
      process.execPath,
      [tsxCli, scriptPath, '--mode', 'integrated-scale', '--scale', String(percentage), '--adapter', adapterPath],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const report = parseIntegratedScaleResult(child.stdout ?? '', percentage);
    if (child.status !== 0 || report === null) {
      const stderrTail = (child.stderr ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(-5)
        .join(' | ');
      throw new BenchmarkError(
        BENCHMARK_CHILD_FAILED,
        `child for scale ${percentage}% exited ${child.status ?? 'err'} with ${
          report === null ? 'no parseable integrated-scale-result line' : 'a failed child'
        }${stderrTail.length > 0 ? `: ${stderrTail}` : ''}`,
        7,
      );
    }
    const { violations, passed } = evaluateScaleReport(report, BOUNDS);
    perScaleResults.push({
      scale: percentage,
      results: report.results.map((r) => ({
        id: r.id,
        description: r.description,
        warmup: r.warmup,
        samples: r.samples,
        p50Ms: round(r.p50Ms),
        p95Ms: round(r.p95Ms),
        maxMs: round(r.maxMs),
        sampleDigest: r.sampleDigest,
        postCasePeakRssBytes: r.postCasePeakRssBytes,
      })),
      peakRssBytes: report.peakRssBytes,
      diskBytes: report.diskBytes,
      violations,
      passed,
    });
    process.stdout.write(`[benchmark-authoritative-review] scale ${percentage}% -> ${passed ? 'PASS' : `FAIL (${violations.join(', ')})`}\n`);
  }

  const passing = perScaleResults.filter((entry) => entry.passed === true);
  const greatest = passing.length > 0 ? Math.max(...passing.map((entry) => entry.scale as number)) : null;
  if (greatest === null) {
    throw new BenchmarkError(
      BENCHMARK_INTEGRATED_BOUNDS,
      `no scale passed every bound; per-scale results recorded in ${args.evidence}`,
      6,
    );
  }

  const scaleRecord = perScaleResults.find((entry) => entry.scale === greatest)!;
  const scaleResults = (scaleRecord['results'] as Array<Record<string, unknown>>) ?? [];
  const warmupCount = scaleResults.reduce((sum, entry) => sum + (entry['warmup'] as number), 0);
  const sampleCount = scaleResults.reduce((sum, entry) => sum + (entry['samples'] as number), 0);
  const evidence: AuthoritativeReviewBenchmarkEvidenceV1 = {
    schemaVersion: 1,
    mode: 'integrated-qualify',
    runner,
    ...evidenceFacts,
    warmupCount,
    sampleCount,
    peakRssBytes: Number(scaleRecord['peakRssBytes']),
    diskBytes: Number(scaleRecord['diskBytes']),
    cases: scaleResults.map((entry) => ({
      id: String(entry['id']),
      rawSampleDigest: String(entry['sampleDigest']),
      samples: Number(entry['samples']),
      warmup: Number(entry['warmup']),
      p50Ms: Number(entry['p50Ms']),
      p95Ms: Number(entry['p95Ms']),
      maxMs: Number(entry['maxMs']),
      postCasePeakRssBytes: Number(entry['postCasePeakRssBytes']),
    })),
    candidatePercentage: greatest,
    selectionReason: `greatest passing scale ${greatest}%`,
    finalProfileDigest: profileCanonicalDigest(loadedProfile),
    finalProfileQualificationState: 'final',
    finalProfileMaxSlots: loadedProfile.runtime.maxSlots,
    finalProfileAssignmentPrimaryTargets: loadedProfile.runtime.assignmentMaxPrimaryTargets,
    finalProfileAssignmentTotalObjects: loadedProfile.runtime.assignmentMaxTotalObjects,
    bounds: BOUNDS,
    perScaleResults,
  };
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`[benchmark-authoritative-review] platform evidence 已写入 ${args.evidence}\n`);
  throw new BenchmarkError(
    BENCHMARK_INTEGRATED_FROZEN,
    `integrated qualification froze the final profile at ${greatest}%`,
    0,
  );
}

function parseIntegratedScaleResult(stdout: string, scale: number): IntegratedScaleReport | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<IntegratedScaleReport>;
      if (parsed.event === 'integrated-scale-result' && parsed.scale === scale) {
        return parsed as IntegratedScaleReport;
      }
    } catch {
      // ignore stray non-JSON output lines
    }
  }
  return null;
}

async function runIntegratedScale(args: CliArgs): Promise<void> {
  if (args.scale === undefined || args.adapter === undefined) {
    throw new BenchmarkError(BENCHMARK_USAGE, 'integrated-scale requires --scale and --adapter', 2);
  }
  const percentage = args.scale;
  const limits = scaledLimits(percentage);
  const tempRoot = mkdtempSync(join(tmpdir(), 'forge-authoritative-review-integrated-'));
  const adapterPath = isAbsolute(args.adapter) ? args.adapter : resolve(REPO_ROOT, args.adapter);
  const { createAuthoritativeReviewBenchmarkAdapter } = await import(/* @vite-ignore */ adapterPath) as {
    createAuthoritativeReviewBenchmarkAdapter: (options: {
      limits: typeof limits;
      tempRoot: string;
    }) => Promise<AuthoritativeReviewCasesV1>;
  };
  const adapter = await createAuthoritativeReviewBenchmarkAdapter({ limits, tempRoot });
  const scaleState = { peakRssBytes: 0 };
  const results: CaseResult[] = [];
  for (const definition of integratedScaleCaseDefinitions(adapter)) {
    results.push(await measureCase(definition, scaleState));
  }
  const peakRssBytes = Math.max(osMaxRssBytes(), scaleState.peakRssBytes);
  const diskBytes = sumDirectoryBytes(tempRoot);
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // best-effort temp cleanup
  }
  process.stdout.write(
    `${JSON.stringify({ event: 'integrated-scale-result', scale: percentage, results, peakRssBytes, diskBytes })}\n`,
  );
}

async function runAllocProbe(args: CliArgs): Promise<void> {
  const bytes = args.allocBytes ?? 0;
  if (bytes > 0) {
    const buffer = Buffer.allocUnsafe(bytes);
    const pageSize = 4 * 1024;
    for (let offset = 0; offset < bytes; offset += pageSize) {
      buffer[offset] = 0x5a;
    }
    if (buffer.length !== bytes) throw new Error('BENCHMARK_ALLOC_PROBE_FAILED');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  process.stdout.write(
    `${JSON.stringify({ event: 'alloc-probe', bytes, maxRssBytes: osMaxRssBytes(), rssBytes: process.memoryUsage().rss })}\n`,
  );
}

async function runPrimitiveSmoke(): Promise<void> {
  // Pure domain smoke: build the canonical provisional profile body, compute
  // its digest, and verify identity. No release evidence is written — the
  // primitive smoke is a developer-only reality check.
  const body = buildAuthoritativeReviewTestProfileBody();
  const digest = profileCanonicalDigest(body);
  if (digest.length !== 64) {
    throw new Error('BENCHMARK_SMOKE_PROFILE: profile digest must be a 64-hex string');
  }
  const summary = {
    event: 'summary',
    mode: 'primitive-smoke',
    runnerId: AUTHORITATIVE_REVIEW_RUNNER_IDENTITY,
    runnerVersion: '1.0.0',
    descriptorDigest: '0'.repeat(64),
    gitCommit: gitCommit(),
    profileDigest: digest,
    selectionReason: 'development smoke only — creates no release evidence and cannot change candidate values',
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.mode === 'primitive-smoke') {
    await runPrimitiveSmoke();
    return 0;
  }
  if (args.mode === 'integrated-scale') {
    await runIntegratedScale(args);
    return 0;
  }
  if (args.mode === 'alloc-probe') {
    await runAllocProbe(args);
    return 0;
  }
  await runIntegratedQualify(args);
  return 0;
}

const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(SCRIPT_DIR, 'benchmark-authoritative-review.ts');

if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      if (error instanceof BenchmarkError) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = error.exitCode;
        return;
      }
      process.stderr.write(`AUTHORITATIVE_REVIEW_BENCHMARK_FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
