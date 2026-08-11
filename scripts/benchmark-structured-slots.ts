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
 *   --mode integrated-scale     HIDDEN child-worker mode (Task 19). Runs ONE
 *                               scale's full measurement in a FRESH process and
 *                               prints a single machine-readable
 *                               `integrated-scale-result` JSON line, then exits
 *                               0. Each scale measures in its own process so the
 *                               peak RSS of one scale can never leak into
 *                               another scale's verdict (no V8 retained heap
 *                               from a prior scale). Requires --scale <N> and
 *                               --adapter <path>.
 *   --mode integrated-qualify   Task 19 orchestrator: the ONLY mode that may
 *                               run the integrated reference benchmark, write
 *                               evidence and rewrite the provisional profile
 *                               to final. The parent keeps the
 *                               reproducible-evidence discipline (runner
 *                               identity preflight, clean-source-tree guard,
 *                               evidence facts) and spawns one fresh child per
 *                               scale via `--mode integrated-scale`. No future
 *                               Task 10/16 module is statically imported here.
 *   --mode alloc-probe          HIDDEN helper for the isolation regression test
 *                               (spawns a fresh process, optionally allocates a
 *                               transient buffer, prints its own peak RSS).
 *
 * Evidence discipline (brief Step 3): a run on another environment may
 * compare results but can never produce a final profile; qualification
 * refuses a runner mismatch or a dirty source tree outside its generated-
 * output allowlist. Output is machine-readable JSONL: one `case` record per
 * measured case plus a `summary` record carrying peak RSS and disk bytes.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join, resolve, dirname, isAbsolute } from 'node:path';
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
  STRUCTURED_SLOT_PROFILE_CANDIDATE,
  loadStructuredPlatformProfile,
} from '../src/server/structured-slots/platform-profile';
import type { StructuredPlatformProfileFileV1 } from '../src/server/structured-slots/platform-profile';
import type { StructuredSlotLimitsV1 } from '../src/shared/structured-slots';
import { CorePaths } from '../src/server/storage/core-paths';
import { ValidationEngine, type GateSlotInput } from '../src/server/runtime/structured-slot/validation-engine';
import type {
  AssemblerRegistrationV1,
  FrozenStructuredSlotContractV1,
  FrozenSlotTypeV1,
  ValidatorRegistrationV1,
} from '../src/server/template/structured-slot-contract';
import { validateProfileEvidence, validateProfileEvidenceFailure } from './structured-evidence-schema';

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
const BENCHMARK_INTEGRATED_PROFILE = 'BENCHMARK_INTEGRATED_PROFILE';
const BENCHMARK_INTEGRATED_BOUNDS = 'BENCHMARK_INTEGRATED_BOUNDS';
const BENCHMARK_INTEGRATED_FROZEN = 'BENCHMARK_INTEGRATED_FROZEN';
const BENCHMARK_CHILD_FAILED = 'BENCHMARK_CHILD_FAILED';
const BENCHMARK_EVIDENCE_INVALID = 'BENCHMARK_EVIDENCE_INVALID';

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
      if (
        mode !== 'primitive-smoke' &&
        mode !== 'integrated-qualify' &&
        mode !== 'integrated-scale' &&
        mode !== 'alloc-probe'
      ) {
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
/** Per-scale isolation measurement primitives (Task 19)                 */
/** -------------------------------------------------------------------- */

/**
 * Recursively sums the on-disk byte length of every regular file under a
 * directory. Missing roots sum to 0 (best-effort walk). This is the REAL disk
 * footprint of one scale's temp task root + snapshot + primitive fanout root.
 */
export function sumDirectoryBytes(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          // race with concurrent temp cleanup: ignore
        }
      }
    }
  };
  walk(root);
  return total;
}

/**
 * OS high-water mark of this process's resident set size, in BYTES. The raw
 * `process.resourceUsage().maxRSS` unit is platform-inconsistent: on Linux
 * `ru_maxrss` is kilobytes, and the Node/macOS build running this harness
 * (Node 22, macOS arm64) ALSO reports kilobytes. The OS high-water mark can
 * never be below the current RSS, so the raw value is self-calibrating:
 * `raw < currentRss` proves the value is kilobytes (it is ~currentRss/1024)
 * and it is multiplied by 1024; otherwise it is already bytes. This captures
 * DURING-operation peaks that per-unit `process.memoryUsage().rss` sampling
 * after each unit can miss (e.g. the 40x transient canonicalJson+sha256
 * allocation of the 64 MiB content-root case).
 */
export function osMaxRssBytes(): number {
  const raw = process.resourceUsage().maxRSS;
  const currentRss = process.memoryUsage().rss;
  if (raw > 0 && raw < currentRss) {
    return raw * 1024;
  }
  return raw;
}

/** The Task 19 acceptance bounds (spec §16.3), frozen — never changed here. */
export interface ScaleBounds {
  indexedSlotP95Ms: number;
  treeMatch10kMaxMs: number;
  contentRootMaxMs: number;
  draftMaxMs: number;
  issueProjectionMaxMs: number;
  sealMaxMs: number;
  peakRssBytes: number;
}

/** One child process's full measurement of a single scale. */
export interface IntegratedScaleReport {
  event: 'integrated-scale-result';
  scale: number;
  results: CaseResult[];
  peakRssBytes: number;
  diskBytes: number;
}

/**
 * The required bound cases a scale report must contain. A report missing any of
 * these must FAIL — defaulting a missing case's timing to 0 would be a false
 * pass (a child that threw mid-case exits non-zero today, but the guard makes
 * the verdict robust against a truncated report).
 */
export const REQUIRED_BOUND_CASE_IDS: readonly string[] = [
  'indexed-slot-read',
  'tree-match-10k',
  'content-root-64mib',
  'draft-journal-2k',
  'seal-assembler-custody',
  'authorized-projection-500-issues',
];

/**
 * Pure per-scale verdict: judges ONE scale report against the frozen bounds
 * using ONLY that report's own peak RSS and case timings. A prior scale's
 * higher peak can never influence this verdict (P1-1 regression target). A
 * report missing any required bound case FAILS with a `missing case <id>`
 * violation instead of silently passing on a defaulted 0 timing.
 */
export function evaluateScaleReport(
  report: IntegratedScaleReport,
  bounds: ScaleBounds,
): { violations: string[]; passed: boolean } {
  const byId = new Map(report.results.map((result) => [result.id, result]));
  const violations: string[] = [];
  for (const id of REQUIRED_BOUND_CASE_IDS) {
    if (!byId.has(id)) violations.push(`missing case ${id}`);
  }
  const p95 = (id: string): number => byId.get(id)?.p95Ms ?? 0;
  const max = (id: string): number => byId.get(id)?.maxMs ?? 0;
  // Timing bounds are only meaningful for a case that is present; a missing
  // case is already flagged above and must not be silently accepted.
  if (byId.has('indexed-slot-read') && p95('indexed-slot-read') > bounds.indexedSlotP95Ms) {
    violations.push('indexed-slot-read p95');
  }
  if (byId.has('tree-match-10k') && max('tree-match-10k') > bounds.treeMatch10kMaxMs) {
    violations.push('tree-match-10k');
  }
  if (byId.has('content-root-64mib') && max('content-root-64mib') > bounds.contentRootMaxMs) {
    violations.push('content-root-64mib');
  }
  if (byId.has('draft-journal-2k') && max('draft-journal-2k') > bounds.draftMaxMs) {
    violations.push('draft-journal-2k');
  }
  if (byId.has('seal-assembler-custody') && max('seal-assembler-custody') > bounds.sealMaxMs) {
    violations.push('seal-assembler-custody');
  }
  if (
    byId.has('authorized-projection-500-issues') &&
    p95('authorized-projection-500-issues') > bounds.issueProjectionMaxMs
  ) {
    violations.push('authorized-projection-500-issues');
  }
  if (report.peakRssBytes > bounds.peakRssBytes) {
    violations.push(`peak RSS ${report.peakRssBytes} > ${bounds.peakRssBytes}`);
  }
  return { violations, passed: violations.length === 0 };
}

/**
 * Builds a scaled limits object (every candidate axis scaled uniformly by the
 * same factor). The adapter consumes these ALREADY-SCALED limits verbatim —
 * this is the ONLY scaling boundary (P1-2 regression target).
 */
export function scaledLimits(percentage: number): StructuredSlotLimitsV1 {
  const factor = percentage / 100;
  const scaleGroup = (group: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(group)) {
      out[key] = Math.max(1, Math.floor(value * factor));
    }
    return out;
  };
  return {
    schema: scaleGroup(STRUCTURED_SLOT_PROFILE_CANDIDATE.schema),
    structure: scaleGroup(STRUCTURED_SLOT_PROFILE_CANDIDATE.structure),
    payload: scaleGroup(STRUCTURED_SLOT_PROFILE_CANDIDATE.payload),
    draft: scaleGroup(STRUCTURED_SLOT_PROFILE_CANDIDATE.draft),
    attempt: scaleGroup(STRUCTURED_SLOT_PROFILE_CANDIDATE.attempt),
    validation: scaleGroup(STRUCTURED_SLOT_PROFILE_CANDIDATE.validation),
    output: scaleGroup(STRUCTURED_SLOT_PROFILE_CANDIDATE.output),
  } as StructuredSlotLimitsV1;
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
  contentRoot: Record<string, unknown>;
  /** The content-root byte size actually exercised at this profile scale. */
  contentRootBytes: number;
  /** Limits with a children ceiling floor so the fixed 10k tree stays legal. */
  treeLimits: StructuredSlotLimitsV1;
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
  // The 10k-tree match is a FIXED 11k-node tree (1000 sections x 10 bodies)
  // measured at every integrated scale; its grammar needs a children ceiling
  // of at least 1000 regardless of the scaled maxChildrenPerSlot axis.
  const treeLimits: StructuredSlotLimitsV1 = {
    ...limits,
    structure: {
      ...limits.structure,
      maxChildrenPerSlot: Math.max(limits.structure.maxChildrenPerSlot, SECTION_COUNT),
    },
  };
  const compiledGrammar = compileLayoutGrammarV1(
    TREE_GRAMMAR,
    new Set(['document', 'section', 'body']),
    treeLimits,
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

  // 64 MiB content root at the candidate profile's payload cap; scaled by the
  // profile at lower integrated scales (the payload axis is exactly what the
  // qualification scales down).
  const contentRootBytes = limits.payload.maxScaffoldPayloadBytes;
  const contentRoot = {
    version: 1,
    root: {
      slotId: 'root',
      typeId: 'document',
      contentPresence: 'set',
      content: 'x'.repeat(contentRootBytes),
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
  // The fanout case measures a FIXED 10k-invocation seal gate at every scale;
  // its contract limits must keep the per-Gate invocation/CPU budgets at the
  // full candidate ceiling so the preflight never rejects the 10k fanout.
  const fanoutLimits: StructuredSlotLimitsV1 = {
    ...limits,
    validation: {
      ...limits.validation,
      maxValidatorInvocationsPerGate: Math.max(limits.validation.maxValidatorInvocationsPerGate, FANOUT_TARGET_SLOTS),
      maxAggregateValidatorCpuMsPerGate: Math.max(limits.validation.maxAggregateValidatorCpuMsPerGate, FANOUT_TARGET_SLOTS),
    },
  };
  const fanoutContract: FrozenStructuredSlotContractV1 = {
    version: 1,
    slotTypes: [slotType],
    layoutGrammar: compiledGrammar,
    accessProfiles: [],
    validators: [validator],
    assembler,
    limits: fanoutLimits,
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
    contentRoot,
    contentRootBytes,
    treeLimits,
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
          compileLayoutGrammarV1(
            TREE_GRAMMAR,
            new Set(['document', 'section', 'body']),
            setup.treeLimits,
          );
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
      description: `write (canonical + sha256) and read back a ${Math.round(setup.contentRootBytes / (1024 * 1024))} MiB content root`,
      warmup: 1,
      samples: 3,
      unit: () => {
        const started = performance.now();
        const digest = canonicalJsonSha256(setup.contentRoot); // write
        const byteLength = Buffer.byteLength(canonicalJson(setup.contentRoot), 'utf8'); // read
        if (digest.length !== 64 || byteLength < setup.contentRootBytes) {
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
  /** ONE indexed slot read through the real projection (p95 bound). */
  runIndexedSlotRead(): Promise<number>;
}

/** Evidence record shape (brief Step 3); Task 19 freezes values. */
export interface IntegratedBenchmarkEvidenceV1 {
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
  }>;
  candidatePercentage: number | null;
  selectionReason: string | null;
  /** The frozen limits at the greatest passing scale (Task 19). */
  frozenLimits?: StructuredSlotLimitsV1;
  /** The acceptance bounds applied (Task 19). */
  bounds?: Record<string, number>;
  /** Per-scale results (Task 19), including failing scales. */
  perScaleResults?: Array<Record<string, unknown>>;
}

/**
 * Exact-validates and writes a failure evidence file to the plan's evidence
 * path. Used for the honest `no_scale_passed` outcome AND for the
 * `child_failed` outcome so the evidence file always reflects the latest
 * attempt and is never lost.
 */
function writeFailureEvidence(
  evidencePath: string,
  failureEvidence: Record<string, unknown>,
): void {
  try {
    validateProfileEvidenceFailure(failureEvidence);
  } catch (error) {
    throw new BenchmarkError(
      BENCHMARK_EVIDENCE_INVALID,
      error instanceof Error ? error.message : String(error),
      3,
    );
  }
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(failureEvidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`[benchmark] 失败证据已写入 ${evidencePath}\n`);
}

async function runIntegratedQualify(args: CliArgs): Promise<never> {
  if (args.profile === undefined || args.evidence === undefined) {
    throw new BenchmarkError(BENCHMARK_USAGE, 'integrated-qualify requires --profile and --evidence', 2);
  }

  // Reproducible-evidence discipline FIRST: refuse a runner mismatch or a
  // dirty source tree outside the generated-output allowlist before any run.
  const runner = assertRunnerMatchesReference();
  assertCleanSourceTree();
  const evidenceFacts = {
    gitCommit: gitCommit(),
    sourceTreeDigest: cleanSourceDigest(),
    packageLockSha256: packageLockSha256(),
    dependencyVersions: dependencyVersions(),
  };
  const profilePath = resolve(repoRoot(), args.profile);
  const evidencePath = resolve(repoRoot(), args.evidence);
  const loadedProfile = loadStructuredPlatformProfile(profilePath);
  if (loadedProfile.status !== 'provisional') {
    throw new BenchmarkError(
      BENCHMARK_INTEGRATED_PROFILE,
      `the checked-in profile must be provisional until the integrated benchmark freezes it (got ${loadedProfile.status})`,
      3,
    );
  }

  // The acceptance bounds (Task 19 Step 6, spec §16.3) — frozen, never changed.
  const BOUNDS: ScaleBounds = {
    indexedSlotP95Ms: 25,
    treeMatch10kMaxMs: 2000,
    contentRootMaxMs: 2000,
    draftMaxMs: 2000,
    issueProjectionMaxMs: 250,
    sealMaxMs: 30000,
    peakRssBytes: 512 * 1024 * 1024,
  };

  const scales = [100, 75, 50, 25];
  const perScaleResults: Array<Record<string, unknown>> = [];

  // The child invokes the benchmark script itself under the tsx CLI in a
  // FRESH process, so each scale measures against a clean V8 heap — a prior
  // scale's transient peak can never leak into a later scale's verdict.
  const tsxCli = resolve(repoRoot(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const scriptPath = resolve(SCRIPT_DIR, 'benchmark-structured-slots.ts');
  const adapterPath =
    args.adapter !== undefined
      ? resolve(repoRoot(), args.adapter)
      : resolve(SCRIPT_DIR, 'structured-integrated-benchmark-adapter.ts');

  for (const percentage of scales) {
    process.stdout.write(`[benchmark] integrated scale ${percentage}%\n`);
    const child = spawnSync(
      process.execPath,
      [tsxCli, scriptPath, '--mode', 'integrated-scale', '--scale', String(percentage), '--adapter', adapterPath],
      { cwd: repoRoot(), encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const report = parseIntegratedScaleResult(child.stdout ?? '', percentage);
    if (child.status !== 0 || report === null) {
      const stderrTail = (child.stderr ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(-5)
        .join(' | ');
      // Write a distinct `child_failed` failure evidence BEFORE aborting so the
      // evidence file always reflects the latest attempt and is never lost.
      writeFailureEvidence(evidencePath, {
        schemaVersion: 1,
        mode: 'integrated-qualify',
        outcome: 'child_failed',
        runner,
        ...evidenceFacts,
        bounds: BOUNDS,
        perScaleResults,
        selectionReason: `scale ${percentage}% child failed (exit ${child.status ?? 'err'}); per-scale results recorded so far: ${perScaleResults.length}`,
      });
      throw new BenchmarkError(
        BENCHMARK_CHILD_FAILED,
        `child for scale ${percentage}% exited ${child.status ?? 'err'} with ${
          report === null ? 'no parseable integrated-scale-result line' : 'a failed child'
        }${stderrTail.length > 0 ? `: ${stderrTail}` : ''}`,
        7,
      );
    }

    // Verdict uses ONLY this scale's own peak RSS and timings.
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
      })),
      peakRssBytes: report.peakRssBytes,
      diskBytes: report.diskBytes,
      violations,
      passed,
    });
    process.stdout.write(`[benchmark] scale ${percentage}% -> ${passed ? 'PASS' : `FAIL (${violations.join(', ')})`}\n`);
  }

  // Freeze the GREATEST passing scale — never a higher one.
  const passing = perScaleResults.filter((entry) => entry.passed === true);
  const greatest = passing.length > 0 ? Math.max(...passing.map((entry) => entry.scale as number)) : null;
  const frozenLimits = greatest === null ? null : (scaledLimits(greatest) as StructuredSlotLimitsV1);

  if (greatest === null || frozenLimits === null) {
    // HONEST failure: no scale satisfies every bound. No final profile is
    // written, no release evidence, no capability enable. The measurements are
    // recorded for a future qualifying host — the failure evidence is exact-
    // validated and written to the plan's evidence path so it is never lost.
    writeFailureEvidence(evidencePath, {
      schemaVersion: 1,
      mode: 'integrated-qualify',
      outcome: 'no_scale_passed',
      runner,
      ...evidenceFacts,
      bounds: BOUNDS,
      perScaleResults,
      selectionReason: 'no 100/75/50/25% scale of the candidate axes satisfied every acceptance bound',
    });
    process.stdout.write(`[benchmark] 无任何 scale 通过\n`);
    throw new BenchmarkError(
      BENCHMARK_INTEGRATED_BOUNDS,
      `no scale passed every bound; per-scale results recorded in ${args.evidence}`,
      6,
    );
  }

  // Generate the profile evidence FIRST (no final-profile / release-evidence /
  // capability-manifest digest — the one-way chain forbids a self-reference),
  // then hash that evidence into the final profile. Every case entry carries
  // the REAL warmup/samples/sampleDigest/p50/p95/max measured by the child;
  // peakRssBytes and diskBytes are the child's own values for the frozen scale.
  const scaleRecord = perScaleResults.find((entry) => entry.scale === greatest);
  const scaleResults = (scaleRecord?.results as Array<Record<string, unknown>>) ?? [];
  // warmupCount/sampleCount are the ACTUAL totals summed across the frozen
  // scale's cases (documented choice: sum, not max, so the evidence reflects
  // every measured warmup + sample unit).
  const warmupCount = scaleResults.reduce((sum, entry) => sum + (entry.warmup as number), 0);
  const sampleCount = scaleResults.reduce((sum, entry) => sum + (entry.samples as number), 0);
  const evidence: IntegratedBenchmarkEvidenceV1 = {
    schemaVersion: 1,
    mode: 'integrated-qualify',
    runner,
    ...evidenceFacts,
    warmupCount,
    sampleCount,
    peakRssBytes: Number(scaleRecord?.peakRssBytes),
    diskBytes: Number(scaleRecord?.diskBytes),
    cases: scaleResults.map((entry) => ({
      id: String(entry.id),
      rawSampleDigest: String(entry.sampleDigest),
      samples: Number(entry.samples),
      warmup: Number(entry.warmup),
      p50Ms: Number(entry.p50Ms),
      p95Ms: Number(entry.p95Ms),
      maxMs: Number(entry.maxMs),
    })),
    candidatePercentage: greatest,
    selectionReason: `greatest passing scale ${greatest}%`,
    frozenLimits: frozenLimits as StructuredSlotLimitsV1,
    bounds: BOUNDS,
    perScaleResults,
  };
  try {
    validateProfileEvidence(evidence);
  } catch (error) {
    throw new BenchmarkError(
      BENCHMARK_EVIDENCE_INVALID,
      error instanceof Error ? error.message : String(error),
      3,
    );
  }
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  const evidenceDigest = canonicalJsonSha256(evidence);

  // Rewrite the checked-in profile to `status: final` referencing the evidence.
  const finalProfile: StructuredPlatformProfileFileV1 = {
    version: 1,
    status: 'final',
    identity: loadedProfile.identity,
    limits: frozenLimits,
    evidenceDigest,
  };
  writeFileSync(profilePath, `${JSON.stringify(finalProfile, null, 2)}\n`, 'utf8');
  process.stdout.write(`[benchmark] 最终 profile 已冻结（scale=${greatest}%）\n`);
  process.stdout.write(`[benchmark] profile evidence 已写入 ${args.evidence}\n`);
  throw new BenchmarkError(
    BENCHMARK_INTEGRATED_FROZEN,
    `integrated qualification froze the final profile at ${greatest}%`,
    0,
  );
}

/** Parses the child's single `integrated-scale-result` JSON line. */
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

/**
 * HIDDEN child-worker mode: measures ONE scale in a FRESH process and prints a
 * single machine-readable `integrated-scale-result` JSON line, then exits 0.
 * The OS high-water mark (`osMaxRssBytes`) plus the per-unit RSS sampling in
 * `measureCase` capture the during-operation peak, including transient
 * allocations that post-unit sampling alone would miss.
 */
async function runIntegratedScale(args: CliArgs): Promise<void> {
  if (args.scale === undefined || args.adapter === undefined) {
    throw new BenchmarkError(BENCHMARK_USAGE, 'integrated-scale requires --scale and --adapter', 2);
  }
  const percentage = args.scale;
  const limits = scaledLimits(percentage);
  const tempRoot = mkdtempSync(join(tmpdir(), 'forge-structured-integrated-'));
  const paths = CorePaths.create({ dataRoot: tempRoot, templateRoot: join(tempRoot, 'templates') });
  const taskId = `bench-integrated-${percentage}`;

  // Import the real Task 10/16 integrated adapter (no stubs) from the path the
  // orchestrator passed (an absolute path resolved relative to the repo root in
  // the parent; a relative path is resolved here too so direct child invocations
  // are robust). Under jsdom/web transform mode vite rewrites a variable dynamic
  // import into `__vite__injectQuery(...)` and prepends a `/@vite/client`
  // import; the shebang-less top of this file keeps that output parseable when
  // tests import this module, and the `@vite-ignore` comment suppresses vite's
  // static-analysis warning. At runtime (tsx/node, ssr transform) this stays a
  // plain `import(adapterPath)`.
  const adapterPath = isAbsolute(args.adapter) ? args.adapter : resolve(repoRoot(), args.adapter);
  const { createIntegratedBenchmarkAdapter } = await import(/* @vite-ignore */ adapterPath);
  const adapter = await createIntegratedBenchmarkAdapter({ paths, taskId, limits });

  const scaleState = { peakRssBytes: 0, diskBytes: 0 };
  const results: CaseResult[] = [];
  // The primitive cases measure the platform primitives the structured runtime
  // is built on (tree match, content root, Draft journal) — their bounds
  // (10k tree ≤ 2 s, content-root ≤ 2 s, Draft ≤ 2 s) are part of the
  // integrated acceptance. The setup uses the SCALED limits so every axis is
  // evaluated at this scale.
  const primitiveSetup = buildPrimitiveSetup({ limits }, scaleState);
  for (const definition of primitiveCases(primitiveSetup)) {
    results.push(await measureCase(definition, scaleState));
  }
  const scaleCases: CaseDefinition[] = [
    {
      id: 'authorized-projection-500-issues',
      description: `500-issue authorized owner projection (Task 10) @ ${percentage}%`,
      warmup: 0,
      samples: 1,
      unit: async () => adapter.runAuthorizedProjection500Issues(),
    },
    {
      id: 'seal-assembler-custody',
      description: `${Math.round(limits.payload.maxScaffoldPayloadBytes / (1024 * 1024))} MiB real Seal/Assembler/custody (Task 16) @ ${percentage}%`,
      warmup: 0,
      samples: 1,
      unit: async () => adapter.runSealAssemblerCustody64MiB(),
    },
    {
      id: 'batch-recovery',
      description: `batch recovery (Task 16) @ ${percentage}%`,
      warmup: 0,
      samples: 1,
      unit: async () => adapter.runBatchRecovery(),
    },
  ];
  for (const definition of scaleCases) {
    results.push(await measureCase(definition, scaleState));
  }
  // Indexed slot read p95: a SINGLE real owner-projection read through the
  // same projection service (spec §16.3: indexed slot p95 <= 25 ms).
  const indexedRead = await measureCase(
    {
      id: 'indexed-slot-read',
      description: `indexed slot read (real projection) @ ${percentage}%`,
      warmup: 3,
      samples: 10,
      unit: async () => adapter.runIndexedSlotRead(),
    },
    scaleState,
  );
  results.push(indexedRead);

  // Peak = max of the OS high-water mark (captures DURING-operation peaks) and
  // the per-unit post-sample RSS sampling. Disk bytes = the REAL on-disk
  // footprint walked over this child's temp task root + snapshot + primitive
  // fanout temp root after the whole scale run.
  const peakRssBytes = Math.max(osMaxRssBytes(), scaleState.peakRssBytes);
  const diskBytes = sumDirectoryBytes(tempRoot) + sumDirectoryBytes(primitiveSetup.fanoutPaths.dataRoot);

  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // best-effort temp cleanup
  }
  try {
    rmSync(primitiveSetup.fanoutPaths.dataRoot, { recursive: true, force: true });
  } catch {
    // best-effort temp cleanup
  }

  process.stdout.write(
    `${JSON.stringify({ event: 'integrated-scale-result', scale: percentage, results, peakRssBytes, diskBytes })}\n`,
  );
}

/**
 * HIDDEN helper for the isolation regression test: spawns a fresh process,
 * optionally allocates a transient buffer, then reports its OWN peak RSS as a
 * single machine-readable JSON line. Used to prove two children spawned
 * sequentially never share a peak (P1-1 regression (b)).
 */
async function runAllocProbe(args: CliArgs): Promise<void> {
  const bytes = args.allocBytes ?? 0;
  if (bytes > 0) {
    const buffer = Buffer.allocUnsafe(bytes);
    // Force-touch every page so the allocation RELIABLY commits physical
    // memory. On overcommit-friendly hosts `Buffer.alloc(bytes, fill)` can
    // leave pages lazy/uncommitted, so the OS high-water mark would under-
    // report the peak; writing a byte into every 4 KiB page (the smallest
    // common page size, so any larger page is also touched) commits them all.
    const pageSize = 4 * 1024;
    for (let offset = 0; offset < bytes; offset += pageSize) {
      buffer[offset] = 0x5a;
    }
    if (buffer.length !== bytes) throw new Error('BENCHMARK_ALLOC_PROBE_FAILED');
    // Keep the allocation alive briefly so the OS high-water mark reflects it.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  process.stdout.write(
    `${JSON.stringify({ event: 'alloc-probe', bytes, maxRssBytes: osMaxRssBytes(), rssBytes: process.memoryUsage().rss })}\n`,
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

// Only run when invoked directly (node/tsx <this script>). When the module is
// imported by tests or other scripts, `main` must NOT run — process.argv[1]
// points at the runner (vitest worker / tsx) rather than this file.
const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(SCRIPT_DIR, 'benchmark-structured-slots.ts');

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
      process.stderr.write(`BENCHMARK_FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
