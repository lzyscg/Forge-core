#!/usr/bin/env node
/**
 * Structured slot benchmark harness (Task 9, spec §5 / design §25.13 O08).
 *
 * Modes:
 *   --mode primitive-smoke      Development smoke over the REAL primitive
 *                               operations the structured runtime is built on
 *                               (schema/grammar compile, 10k tree match and
 *                               indexed read, 64 MiB content root, 2k-change
 *                               Draft journal, 10k validator fanout through
 *                               the Task 8 engine). Produces NO release
 *                               evidence and cannot change candidate values.
 *   --mode integrated-qualify   Reserved for Task 19: the ONLY mode that may
 *                               run the integrated reference benchmark, write
 *                               evidence and rewrite the provisional profile
 *                               to final. Task 9 implements only the
 *                               reproducible-evidence discipline (runner
 *                               identity preflight, clean-source-tree guard,
 *                               evidence facts) and then FAILS with
 *                               INTEGRATED_BENCHMARK_NOT_READY until an
 *                               `IntegratedBenchmarkCasesV1` adapter is wired
 *                               in (Task 19). No future Task 10/16 module is
 *                               statically imported here.
 *
 * Evidence discipline (brief Step 3): a run on another environment may
 * compare results but can never produce a final profile; qualification
 * refuses a runner mismatch or a dirty source tree outside its generated-
 * output allowlist. Output is machine-readable JSONL: one `case` record per
 * measured case plus a `summary` record carrying peak RSS and disk bytes.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { canonicalJson, canonicalJsonSha256 } from '../src/server/structured-slots/canonical-json';
import { compileSlotSchemaV1 } from '../src/server/structured-slots/slot-schema';
import {
  compileLayoutGrammarV1,
  matchProduction,
  type LayoutGrammarV1,
} from '../src/server/structured-slots/layout-grammar';
import {
  STRUCTURED_SLOT_PLATFORM_PROFILE_V1,
  loadStructuredPlatformProfile,
} from '../src/server/structured-slots/platform-profile';
import type { StructuredSlotLimitsV1 } from '../src/shared/structured-slots';
import { CorePaths } from '../src/server/storage/core-paths';
import { ValidationEngine, type GateSlotInput } from '../src/server/runtime/structured-slot/validation-engine';
import type {
  AssemblerRegistrationV1,
  FrozenStructuredSlotContractV1,
  FrozenSlotTypeV1,
  ValidatorRegistrationV1,
} from '../src/server/template/structured-slot-contract';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REFERENCE_RUNNER_PATH = resolve(
  SCRIPT_DIR,
  '..',
  'docs',
  'evidence',
  'structured-slot-reference-runner-v1.json',
);

/** Stable harness-level codes. */
const INTEGRATED_BENCHMARK_NOT_READY = 'INTEGRATED_BENCHMARK_NOT_READY';
const BENCHMARK_RUNNER_MISMATCH = 'BENCHMARK_RUNNER_MISMATCH';
const BENCHMARK_DIRTY_TREE = 'BENCHMARK_DIRTY_TREE';
const BENCHMARK_USAGE = 'BENCHMARK_USAGE';

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

/** Generated-output allowlist the integrated qualification may leave dirty. */
const GENERATED_OUTPUT_ALLOWLIST = new Set([
  'src/server/structured-slots/platform-profile-v1.json',
  'src/server/structured-slots/runtime-capability-v1.json',
  'docs/evidence/structured-slot-platform-profile-v1.json',
  'docs/evidence/structured-slot-release-v1.json',
]);

interface CliArgs {
  mode: 'primitive-smoke' | 'integrated-qualify';
  profile?: string;
  evidence?: string;
  adapter?: string;
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
      if (mode !== 'primitive-smoke' && mode !== 'integrated-qualify') {
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
  return args;
}

/** -------------------------------------------------------------------- */
/** Measurement primitives                                               */
/** -------------------------------------------------------------------- */

function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
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
  rawSamples: number[];
  diskBytes: number;
}

export interface CaseDefinition {
  id: string;
  description: string;
  warmup: number;
  samples: number;
  /** One unit of work; returns the wall-clock ms it took. */
  unit: () => Promise<number> | number;
}

/**
 * Runs warmup (discarded) then recorded samples of one case. Returns
 * p50/p95/max over the raw samples plus a canonical digest of those samples.
 */
async function measureCase(
  definition: CaseDefinition,
  state: { peakRssBytes: number; diskBytes: number },
): Promise<CaseResult> {
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
    rawSamples: raw,
    diskBytes: state.diskBytes,
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
      diskBytes: result.diskBytes,
    })}\n`,
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** -------------------------------------------------------------------- */
/** Primitive benchmark cases (real code, no stubs)                      */
/** -------------------------------------------------------------------- */

interface PrimitiveSetup {
  limits: StructuredSlotLimitsV1;
  compiledSchema: ReturnType<typeof compileSlotSchemaV1>;
  compiledGrammar: ReturnType<typeof compileLayoutGrammarV1>;
  treeSlots: Array<{ slotId: string; parentSlotId: string | null; order: number; typeId: string }>;
  treeIndex: Map<string, { parentSlotId: string | null; order: number; typeId: string }>;
  documentChildren: string[];
  sectionChildren: string[];
  contentRoot64MiB: Record<string, unknown>;
  draftOverlay: Record<string, unknown>;
  fanoutContract: FrozenStructuredSlotContractV1;
  fanoutSlots: GateSlotInput[];
  fanoutPaths: CorePaths;
  fanoutTaskId: string;
}

/** A representative object schema (valid under the candidate limits). */
const REPRESENTATIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    summary: { type: 'string', minLength: 0, maxLength: 1000 },
    status: { type: 'string', enum: ['draft', 'review', 'done'] },
    rank: { type: 'integer', minimum: 0, maximum: 100 },
    tags: { type: 'array', items: { type: 'string', maxLength: 50 }, maxItems: 64 },
    meta: {
      type: 'object',
      additionalProperties: false,
      properties: {
        createdBy: { type: 'string', maxLength: 100 },
        note: { type: 'string', maxLength: 5000 },
      },
    },
  },
};

const TREE_GRAMMAR: LayoutGrammarV1 = {
  rootType: 'document',
  productions: {
    document: {
      children: { kind: 'repeat', min: 0, max: 1000, item: { kind: 'slot', type: 'section' } },
    },
    section: {
      children: { kind: 'repeat', min: 0, max: 1000, item: { kind: 'slot', type: 'body' } },
    },
    body: { children: { kind: 'empty' } },
  },
};

const FANOUT_VALIDATOR_SOURCE =
  'module.exports = { validate(input) { return { pass: true, issues: [] }; } };';

const CONTENT_ROOT_64_MIB = 64 * 1024 * 1024;
const DRAFT_CHANGED_SLOTS = 2_000;
const FANOUT_TARGET_SLOTS = 10_000;
const SECTION_COUNT = 1_000;
const BODY_PER_SECTION = 10;

/** Builds every shared fixture once, then each case measures a real unit. */
function buildPrimitiveSetup(
  profile: { limits: StructuredSlotLimitsV1 },
  state: { diskBytes: number },
): PrimitiveSetup {
  const { limits } = profile;

  const compiledSchema = compileSlotSchemaV1(REPRESENTATIVE_SCHEMA, limits);
  const compiledGrammar = compileLayoutGrammarV1(
    TREE_GRAMMAR,
    new Set(['document', 'section', 'body']),
    limits,
  );

  // 10k+ node tree: root + 1000 sections x 10 bodies = 11,001 nodes.
  const treeSlots: PrimitiveSetup['treeSlots'] = [];
  const treeIndex: PrimitiveSetup['treeIndex'] = new Map();
  treeSlots.push({ slotId: 'root', parentSlotId: null, order: 0, typeId: 'document' });
  treeIndex.set('root', { parentSlotId: null, order: 0, typeId: 'document' });
  const documentChildren: string[] = [];
  // Every section has the same 10-body child shape; the matcher is invoked per
  // section, so the body child array stays per-section (never accumulated).
  const sectionChildren = new Array<string>(BODY_PER_SECTION).fill('body');
  for (let s = 0; s < SECTION_COUNT; s++) {
    const sectionId = `section-${s}`;
    treeSlots.push({ slotId: sectionId, parentSlotId: 'root', order: s, typeId: 'section' });
    treeIndex.set(sectionId, { parentSlotId: 'root', order: s, typeId: 'section' });
    documentChildren.push('section');
    for (let b = 0; b < BODY_PER_SECTION; b++) {
      const bodyId = `${sectionId}-body-${b}`;
      treeSlots.push({ slotId: bodyId, parentSlotId: sectionId, order: b, typeId: 'body' });
      treeIndex.set(bodyId, { parentSlotId: sectionId, order: b, typeId: 'body' });
    }
  }

  // 64 MiB content root: a single required content value near the scaffold cap.
  const contentRoot64MiB = {
    version: 1,
    root: {
      slotId: 'root',
      typeId: 'document',
      contentPresence: 'set',
      content: 'x'.repeat(CONTENT_ROOT_64_MIB),
    },
  };

  // 2k-change Draft overlay: exactly the candidate maxChangedSlots scale.
  const draftOverlay: Record<string, unknown> = {
    version: 1,
    baseRevision: 3,
    changedSlots: DRAFT_CHANGED_SLOTS,
    overlay: {},
  };
  for (let i = 0; i < DRAFT_CHANGED_SLOTS; i++) {
    (draftOverlay['overlay'] as Record<string, unknown>)[`slot-${i}`] = {
      contentPresence: 'set',
      content: { text: `change-${i}`, ts: i },
    };
  }

  // 10k validator fanout through the Task 8 engine: one snapshot-scoped
  // validator file, a hand-built frozen contract, 10k slots, one seal gate.
  const tempRoot = mkdtempSync(join(tmpdir(), 'forge-structured-bench-'));
  const paths = CorePaths.create({ dataRoot: tempRoot, templateRoot: join(tempRoot, 'templates') });
  const taskId = 'bench-fanout';
  const validatorPath = join(paths.taskSnapshotRoot(taskId), 'slots', 'validators', 'fanout.cjs');
  mkdirSync(dirname(validatorPath), { recursive: true });
  writeFileSync(validatorPath, FANOUT_VALIDATOR_SOURCE, 'utf8');
  state.diskBytes += Buffer.byteLength(FANOUT_VALIDATOR_SOURCE, 'utf8');

  const slotType: FrozenSlotTypeV1 = {
    id: 'node',
    name: 'Node',
    description: 'benchmark slot node',
    specSchema: compileSlotSchemaV1({ type: 'object', additionalProperties: false }, limits),
    content: { presence: 'forbidden' },
  };
  const validator: ValidatorRegistrationV1 = {
    id: 'fanout',
    scope: 'slot',
    trigger: 'seal',
    enforcement: 'blocking',
    selector: { kind: 'all' },
    implementation: { abi: 'forge-validator/v1', path: 'slots/validators/fanout.cjs' },
    // declared cpuMs keeps 10k x cpuMs within the per-Gate aggregate CPU budget
    // so the preflight allows the full 10k fanout to actually execute.
    budget: { cpuMs: 1, timeoutMs: 500, memoryMiB: 64 },
  };
  const assembler: AssemblerRegistrationV1 = {
    id: 'bench-assembler',
    implementation: { abi: 'forge-assembler/v1', path: 'slots/assembler/none.cjs' },
    budget: { cpuMs: 100, timeoutMs: 500, memoryMiB: 64 },
    routes: [],
  };
  const fanoutContract: FrozenStructuredSlotContractV1 = {
    version: 1,
    slotTypes: [slotType],
    layoutGrammar: compiledGrammar,
    accessProfiles: [],
    validators: [validator],
    assembler,
    limits,
    resourceManifest: [],
    abiProfileIdentity: {
      validatorAbi: 'forge-validator/v1',
      assemblerAbi: 'forge-assembler/v1',
      profileIdentity: 'forge-structured-runtime/v1',
    },
    semanticDigest: '0'.repeat(64),
  };
  const fanoutSlots: GateSlotInput[] = [];
  for (let i = 0; i < FANOUT_TARGET_SLOTS; i++) {
    fanoutSlots.push({
      slotId: `s${i}`,
      parentSlotId: null,
      order: i,
      typeId: 'node',
      spec: {},
      contentPresence: 'unset',
      content: null,
    });
  }

  return {
    limits,
    compiledSchema,
    compiledGrammar,
    treeSlots,
    treeIndex,
    documentChildren,
    sectionChildren,
    contentRoot64MiB,
    draftOverlay,
    fanoutContract,
    fanoutSlots,
    fanoutPaths: paths,
    fanoutTaskId: taskId,
  };
}

function primitiveCases(setup: PrimitiveSetup): CaseDefinition[] {
  const containerLocation = {
    kind: 'slot' as const,
    slotId: 'root',
    field: 'children' as const,
    valuePointer: '',
  };
  const schemaPerSample = 200;
  const grammarPerSample = 20;

  return [
    {
      id: 'schema-compile',
      description: `compile a representative object schema ${schemaPerSample}x`,
      warmup: 1,
      samples: 8,
      unit: () => {
        const started = performance.now();
        for (let i = 0; i < schemaPerSample; i++) {
          compileSlotSchemaV1(REPRESENTATIVE_SCHEMA, setup.limits);
        }
        return performance.now() - started;
      },
    },
    {
      id: 'grammar-compile',
      description: `compile the 10k-tree layout grammar ${grammarPerSample}x`,
      warmup: 1,
      samples: 8,
      unit: () => {
        const started = performance.now();
        for (let i = 0; i < grammarPerSample; i++) {
          compileLayoutGrammarV1(TREE_GRAMMAR, new Set(['document', 'section', 'body']), setup.limits);
        }
        return performance.now() - started;
      },
    },
    {
      id: 'tree-match-10k',
      description: 'match an 11k-node tree (1000 sections x 10 bodies) + 11k indexed slot reads',
      warmup: 1,
      samples: 5,
      unit: () => {
        const started = performance.now();
        const docIssues = matchProduction(setup.compiledGrammar, 'document', setup.documentChildren, [containerLocation]);
        if (docIssues.length > 0) throw new Error('BENCHMARK_TREE_MATCH_FAILED: document match rejected');
        for (let s = 0; s < SECTION_COUNT; s++) {
          const sectionId = `section-${s}`;
          const issues = matchProduction(setup.compiledGrammar, 'section', setup.sectionChildren, [
            { kind: 'slot', slotId: sectionId, field: 'children', valuePointer: '' },
          ]);
          if (issues.length > 0) throw new Error(`BENCHMARK_TREE_MATCH_FAILED: section ${s} match rejected`);
        }
        let acc = 0;
        for (const slot of setup.treeSlots) {
          const node = setup.treeIndex.get(slot.slotId);
          if (node === undefined) throw new Error('BENCHMARK_INDEX_MISS');
          acc += node.order;
        }
        if (acc === 0) throw new Error('BENCHMARK_INDEX_EMPTY');
        return performance.now() - started;
      },
    },
    {
      id: 'content-root-64mib',
      description: 'write (canonical + sha256) and read back a 64 MiB content root',
      warmup: 1,
      samples: 3,
      unit: () => {
        const started = performance.now();
        const digest = canonicalJsonSha256(setup.contentRoot64MiB); // write
        const byteLength = Buffer.byteLength(canonicalJson(setup.contentRoot64MiB), 'utf8'); // read
        if (digest.length !== 64 || byteLength < CONTENT_ROOT_64_MIB) {
          throw new Error('BENCHMARK_CONTENT_ROOT_FAILED');
        }
        return performance.now() - started;
      },
    },
    {
      id: 'draft-journal-2k',
      description: 'write + hash a 2k-change Draft overlay and index-read all 2k entries',
      warmup: 1,
      samples: 5,
      unit: () => {
        const started = performance.now();
        const digest = canonicalJsonSha256(setup.draftOverlay); // journal write
        const overlay = (setup.draftOverlay['overlay'] as Record<string, { text: string; ts: number }>);
        let acc = 0;
        for (let i = 0; i < DRAFT_CHANGED_SLOTS; i++) {
          const entry = overlay[`slot-${i}`];
          if (entry === undefined) throw new Error('BENCHMARK_DRAFT_JOURNAL_MISS');
          acc += entry.ts;
        }
        if (digest.length !== 64 || acc === 0) throw new Error('BENCHMARK_DRAFT_JOURNAL_FAILED');
        return performance.now() - started;
      },
    },
    {
      id: 'validator-fanout-10k',
      description: 'one seal Gate fanning out to 10k validator invocations (Task 8 engine)',
      warmup: 0,
      samples: 1,
      unit: async () => {
        const engine = new ValidationEngine({ paths: setup.fanoutPaths });
        const started = performance.now();
        const result = await engine.runSealGate({
          taskId: setup.fanoutTaskId,
          contract: setup.fanoutContract,
          slots: setup.fanoutSlots,
        });
        if (result.usage.invocations !== FANOUT_TARGET_SLOTS) {
          throw new Error(
            `BENCHMARK_FANOUT_FAILED: expected ${FANOUT_TARGET_SLOTS} invocations, got ${result.usage.invocations}`,
          );
        }
        if (result.verdict.status !== 'passed') {
          throw new Error(`BENCHMARK_FANOUT_FAILED: verdict ${result.verdict.status}`);
        }
        return performance.now() - started;
      },
    },
  ];
}

/** -------------------------------------------------------------------- */
/** Runner identity + reproducible evidence discipline (brief Step 3)    */
/** -------------------------------------------------------------------- */

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

function assertRunnerMatchesReference(): { runnerId: string; runnerVersion: string; descriptorDigest: string } {
  let checked: Record<string, unknown>;
  try {
    checked = JSON.parse(readFileSync(REFERENCE_RUNNER_PATH, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new BenchmarkError(BENCHMARK_RUNNER_MISMATCH, `cannot read reference runner at ${REFERENCE_RUNNER_PATH}`, 4);
  }
  const descriptor = checked['descriptor'] as Record<string, unknown>;
  if (!descriptor) {
    throw new BenchmarkError(BENCHMARK_RUNNER_MISMATCH, 'reference runner descriptor missing', 4);
  }
  const current = currentHostDescriptor();
  const currentDigest = canonicalJsonSha256(current);
  const checkedDigest = checked['descriptorDigest'];
  const matches =
    typeof checkedDigest === 'string' &&
    checkedDigest.length === 64 &&
    checkedDigest === currentDigest &&
    canonicalJsonSha256(descriptor) === currentDigest;
  if (!matches) {
    throw new BenchmarkError(
      BENCHMARK_RUNNER_MISMATCH,
      `host descriptor digest ${currentDigest} does not match the checked-in reference runner ` +
        `(descriptorDigest ${String(checkedDigest)}); a run on another environment may compare ` +
        'results but cannot produce a final profile',
      4,
    );
  }
  return {
    runnerId: String(checked['runnerId'] ?? 'forge-ref-runner/v1'),
    runnerVersion: String(checked['runnerVersion'] ?? '1.0.0'),
    descriptorDigest: currentDigest,
  };
}

/** SHA-256 over the sorted (relative path, sha256) of every git-tracked file. */
function cleanSourceDigest(): string {
  const files = execFileSync('git', ['ls-files'], { cwd: repoRoot(), encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
  const entries: Record<string, string> = {};
  for (const file of files) {
    entries[file] = sha256Hex(readFileSync(resolve(repoRoot(), file)));
  }
  return canonicalJsonSha256(entries);
}

function repoRoot(): string {
  return resolve(SCRIPT_DIR, '..');
}

function gitCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot(), encoding: 'utf8' }).trim();
}

function packageLockSha256(): string {
  return sha256Hex(readFileSync(resolve(repoRoot(), 'package-lock.json')));
}

function dependencyVersions(): Record<string, string> {
  const readVersion = (name: string): string => {
    const pkg = JSON.parse(
      readFileSync(resolve(repoRoot(), 'node_modules', name, 'package.json'), 'utf8'),
    ) as { version: string };
    return pkg.version;
  };
  return {
    'isolated-vm': readVersion('isolated-vm'),
    're2-wasm': readVersion('re2-wasm'),
    '@earendil-works/pi-ai': readVersion('@earendil-works/pi-ai'),
  };
}

/**
 * Refuses a dirty source tree outside the generated-output allowlist. The
 * qualification must start from the exact clean checkpoint (Task 19 Step 6);
 * only the final-profile / evidence / capability generated outputs may be
 * dirty or untracked.
 */
function assertCleanSourceTree(): void {
  const porcelain = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: repoRoot(),
    encoding: 'utf8',
  });
  const offenders: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.trim().length === 0) continue;
    // porcelain format: XY <path> (possibly quoted / with rename arrow)
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

/** -------------------------------------------------------------------- */
/** Integrated cases + qualification (reserved for Task 19)              */
/** -------------------------------------------------------------------- */

/**
 * Injected adapter seam for the integrated benchmark cases (brief Step 4).
 * Task 10/16 modules are NEVER statically imported here; Task 19 builds a
 * module exposing this interface (via --adapter) from the real authorized
 * projection, Seal/Assembler/custody and batch-recovery implementations.
 * Each method returns the wall-clock ms of one real run.
 */
export interface IntegratedBenchmarkCasesV1 {
  /** 500-issue authorized projection (Task 10). */
  runAuthorizedProjection500Issues(): Promise<number>;
  /** 64 MiB real Seal/Assembler/custody (Task 16). */
  runSealAssemblerCustody64MiB(): Promise<number>;
  /** Batch recovery (Task 16). */
  runBatchRecovery(): Promise<number>;
}

/** Evidence record shape (brief Step 3); Task 19 freezes values. */
export interface IntegratedBenchmarkEvidenceV1 {
  schemaVersion: 1;
  mode: 'integrated-qualify';
  runner: { runnerId: string; runnerVersion: string; descriptorDigest: string };
  gitCommit: string;
  cleanSourceDigest: string;
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
  }>;
  candidatePercentage: number | null;
  selectionReason: string | null;
}

async function runIntegratedQualify(args: CliArgs): Promise<never> {
  if (args.profile === undefined || args.evidence === undefined) {
    throw new BenchmarkError(BENCHMARK_USAGE, 'integrated-qualify requires --profile and --evidence', 2);
  }
  const state = { peakRssBytes: 0, diskBytes: 0 };

  // Reproducible-evidence discipline FIRST: refuse a runner mismatch or a
  // dirty source tree outside the generated-output allowlist before any run.
  const runner = assertRunnerMatchesReference();
  assertCleanSourceTree();
  const evidenceFacts = {
    gitCommit: gitCommit(),
    cleanSourceDigest: cleanSourceDigest(),
    packageLockSha256: packageLockSha256(),
    dependencyVersions: dependencyVersions(),
  };
  loadStructuredPlatformProfile(resolve(repoRoot(), args.profile));

  // Task 19 wires real Task 10/16 adapter implementations here. Until an
  // adapter is supplied, qualification is NOT ready and must fail.
  if (args.adapter === undefined) {
    throw new BenchmarkError(
      INTEGRATED_BENCHMARK_NOT_READY,
      'integrated qualification requires an IntegratedBenchmarkCasesV1 adapter (--adapter); ' +
        'Task 19 wires the real Task 10/16 implementations. Task 9 cannot qualify.',
      3,
    );
  }
  const adapterModule = (await import(args.adapter)) as { default?: IntegratedBenchmarkCasesV1 };
  const adapter = adapterModule.default;
  if (adapter === undefined) {
    throw new BenchmarkError(
      INTEGRATED_BENCHMARK_NOT_READY,
      'integrated qualification adapter has no default IntegratedBenchmarkCasesV1 export',
      3,
    );
  }
  // Task 19: run the three integrated cases through measureCase, freeze the
  // candidate percentage/selection reason, write the evidence file and
  // rewrite the provisional profile to final. Task 9 deliberately does not
  // implement this qualification or write a final profile.
  void adapter;
  void evidenceFacts;
  throw new BenchmarkError(
    INTEGRATED_BENCHMARK_NOT_READY,
    'integrated qualification is not implemented in Task 9; only Task 19 may run it ' +
      'and freeze a final profile from reference-runner evidence',
    3,
  );
}

/** -------------------------------------------------------------------- */
/** Modes                                                                */
/** -------------------------------------------------------------------- */

async function runPrimitiveSmoke(): Promise<void> {
  const state = { peakRssBytes: 0, diskBytes: 0 };
  const profile = STRUCTURED_SLOT_PLATFORM_PROFILE_V1;
  if (profile.status !== 'provisional') {
    throw new Error('BENCHMARK_SMOKE_PROFILE: the checked-in profile must be provisional until Task 19');
  }
  const setup = buildPrimitiveSetup(profile, state);
  const results: CaseResult[] = [];
  for (const definition of primitiveCases(setup)) {
    const result = await measureCase(definition, state);
    results.push(result);
    printCaseRecord(result, state.peakRssBytes);
    state.peakRssBytes = Math.max(state.peakRssBytes, process.memoryUsage().rss);
  }
  try {
    rmSync(setup.fanoutPaths.dataRoot, { recursive: true, force: true });
  } catch {
    // best-effort temp cleanup
  }
  const summary = {
    event: 'summary',
    mode: 'primitive-smoke',
    runnerId: 'forge-ref-runner/v1-f2cc89b4',
    runnerVersion: '1.0.0',
    descriptorDigest: 'f2cc89b4e21446330cec1c715c2e6a7f20c9cb027d8854cc128529517e7fa9fc',
    gitCommit: gitCommit(),
    peakRssBytes: state.peakRssBytes,
    diskBytes: state.diskBytes,
    candidatePercentage: null,
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
  await runIntegratedQualify(args);
  return 0;
}

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
    process.stderr.write(`BENCHMARK_FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
