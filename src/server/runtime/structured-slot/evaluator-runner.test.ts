// @vitest-environment node
/**
 * EvaluatorRunner ABI conformance + escape tests (Task 8 Step 1 / Step 6).
 *
 * The structured validator/assembler ABI (design §25.4 E02/E04/E05/E06/E07,
 * spec §10) runs template-owned sources in an isolated, frozen, nondeterminism-
 * stripped isolate. These tests pin:
 *
 * - valid pass/reject and narrow issue normalization;
 * - syntax error, throw, infinite loop (timeout), memory overrun;
 * - invalid returns (contract violations) → VALIDATOR_RESULT_INVALID /
 *   ASSEMBLER_RESULT_INVALID;
 * - `require`/FS/network/process/Date/random access is impossible;
 * - nondeterministic double-run: two runs of a random/Date-using validator
 *   produce byte-identical results (randomness stripped/frozen);
 * - result bytes are measured from the canonical serialization of the raw
 *   return BEFORE normalization;
 * - a timed-out isolate is disposed and never reused.
 *
 * Assembler ABI (Step 6): unique declared route ids, UTF-8 string content,
 * exact required create coverage (every declared route, no extras, no control
 * fields), per-file and total artifact byte limits.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonObject, StructuredSlotLimitsV1 } from '../../../shared/structured-slots';
import type { AssemblerRegistrationV1, ValidatorRegistrationV1 } from '../../template/structured-slot-contract';
import { CorePaths } from '../../storage/core-paths';
import {
  buildAssemblerEnvelope,
  buildValidatorEnvelope,
  EvaluatorRunner,
  runValidatorV2,
} from './evaluator-runner';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

/** Generous limits; individual tests override the groups they exercise. */
function makeLimits(): StructuredSlotLimitsV1 {
  return {
    schema: { maxSchemaDepth: 16, maxSchemaNodes: 4096, maxEnumItems: 256, maxPatternLength: 512 },
    structure: { maxSlots: 10_000, maxTreeDepth: 32, maxChildrenPerSlot: 1_000 },
    payload: { maxSpecBytesPerSlot: 65_536, maxContentBytesPerSlot: 1_048_576, maxScaffoldPayloadBytes: 67_108_864 },
    draft: { maxChangedSlots: 2_000, maxDraftBytes: 16_777_216 },
    attempt: {
      maxSlotToolCallsPerAttempt: 512,
      maxValidationRunsPerAttempt: 16,
      maxValidatorInvocationsPerAttempt: 40_000,
      maxAggregateValidatorCpuMsPerAttempt: 240_000,
      maxAggregateValidatorWallClockMsPerAttempt: 480_000,
      maxValidatorOutputBytesPerAttempt: 16_777_216,
      maxAttemptWallClockMs: 600_000,
    },
    validation: {
      maxValidators: 64,
      maxValidatorInvocationsPerGate: 10_000,
      maxAggregateValidatorCpuMsPerGate: 60_000,
      maxAggregateValidatorWallClockMsPerGate: 120_000,
      maxValidatorOutputBytesPerGate: 4_194_304,
      maxIssuesPerRun: 500,
    },
    output: { maxArtifactFiles: 64, maxArtifactBytesPerFile: 16_777_216, maxTotalArtifactBytes: 67_108_864 },
  };
}

function makeValidator(overrides: Partial<ValidatorRegistrationV1> = {}): ValidatorRegistrationV1 {
  return {
    id: 'v1',
    scope: 'slot',
    trigger: 'merge-and-seal',
    enforcement: 'blocking',
    selector: { kind: 'all' },
    implementation: { abi: 'forge-validator/v1', path: 'slots/validators/v1.cjs' },
    budget: { cpuMs: 100, timeoutMs: 500, memoryMiB: 64 },
    ...overrides,
  };
}

function makeAssembler(overrides: Partial<AssemblerRegistrationV1> = {}): AssemblerRegistrationV1 {
  return {
    id: 'asm',
    implementation: { abi: 'forge-assembler/v1', path: 'slots/assembler/a.cjs' },
    budget: { cpuMs: 100, timeoutMs: 500, memoryMiB: 64 },
    routes: [
      { id: 'out-1', artifactFile: 'a.md' },
      { id: 'out-2', artifactFile: 'b.md' },
    ],
    ...overrides,
  };
}

interface Env {
  runner: EvaluatorRunner;
  taskId: string;
  registration: ValidatorRegistrationV1;
}

/** Writes validator sources under the task snapshot and returns a runner. */
function makeEnv(
  sourceOrSources: string | Record<string, string>,
  validator = makeValidator(),
): Env {
  const dataRoot = mkdtempSync(join(tmpdir(), 'forge-evaluator-'));
  tempRoots.push(dataRoot);
  const paths = CorePaths.create({ dataRoot, templateRoot: dataRoot });
  const taskId = 'task-v';
  const sources =
    typeof sourceOrSources === 'string'
      ? { [validator.implementation.path]: sourceOrSources }
      : sourceOrSources;
  for (const [logicalPath, source] of Object.entries(sources)) {
    const full = join(paths.taskSnapshotRoot(taskId), logicalPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source, 'utf8');
  }
  const runner = new EvaluatorRunner({ paths, taskId, limits: makeLimits() });
  return { runner, taskId, registration: validator };
}

/** A realistic slot-scope canonical envelope the platform would pass in. */
function baseEnvelope(validator: ValidatorRegistrationV1): JsonObject {
  return {
    version: 1,
    abi: 'forge-validator/v1',
    validatorId: validator.id,
    scope: validator.scope,
    target: { kind: 'slot', slotId: 's-1', path: ['r'] },
    type: { id: 'title', name: 'Title', description: 'Leaf slot.' },
    spec: { level: 1 },
    content: 'hello',
    contentPresence: 'set',
    tree: [
      { slotId: 'r', parentSlotId: null, order: 0, typeId: 'doc', spec: {}, contentPresence: 'unset', content: null, path: [] },
      { slotId: 's-1', parentSlotId: 'r', order: 0, typeId: 'title', spec: { level: 1 }, contentPresence: 'set', content: 'hello', path: ['r'] },
    ],
    template: { slotTypes: [{ id: 'title', name: 'Title', description: 'Leaf slot.' }] },
  };
}

describe('EvaluatorRunner — valid ABI results', () => {
  it('returns a passing verdict with measured usage', async () => {
    const { runner, registration } = makeEnv(
      'module.exports = { validate(input) { return { pass: true, issues: [] }; } };',
    );
    const result = await runner.runValidator(registration, baseEnvelope(registration));
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.pass).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.outputBytes).toBeGreaterThanOrEqual(0);
    expect(result.cpuMs).toBeGreaterThanOrEqual(0);
    expect(result.wallMs).toBeGreaterThanOrEqual(0);
  });

  it('returns narrow issues on a reliable reject', async () => {
    const source = [
      'module.exports = { validate(input) {',
      '  return { pass: false, issues: [{ stage: "content", evidence: "bad", scope: "s-1", code: "smuggled", severity: "warning" }] };',
      '} };',
    ].join('\n');
    const { runner, registration } = makeEnv(source);
    const result = await runner.runValidator(registration, baseEnvelope(registration));
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.pass).toBe(false);
    // Platform never trusts validator-specified code/severity: only the three
    // narrow keys survive normalization.
    expect(result.issues).toEqual([{ stage: 'content', evidence: 'bad', scope: 's-1' }]);
  });

  it('measures serialized result bytes of the raw return before normalization', async () => {
    const source = [
      'module.exports = { validate() {',
      '  return { pass: true, issues: [{ evidence: "x".repeat(2000), scope: "big" }] };',
      '} };',
    ].join('\n');
    const { runner, registration } = makeEnv(source);
    const result = await runner.runValidator(registration, baseEnvelope(registration));
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // The raw canonical return dwarfs the narrowed issues; the byte count must
    // reflect the raw object, not the normalized one.
    expect(result.outputBytes).toBeGreaterThanOrEqual(2000);
  });
});

describe('EvaluatorRunner — execution failures map to unavailable', () => {
  it('maps a syntax error to unavailable(compile)', async () => {
    const { runner, registration } = makeEnv('module.exports = { validate(input) { return { pass: ');
    const result = await runner.runValidator(registration, baseEnvelope(registration));
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.reason).toBe('compile');
  });

  it('maps a throw to unavailable(runtime)', async () => {
    const { runner, registration } = makeEnv(
      'module.exports = { validate(input) { throw new Error("exploded"); } };',
    );
    const result = await runner.runValidator(registration, baseEnvelope(registration));
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.reason).toBe('runtime');
  });

  it('maps an infinite loop to unavailable(timeout) and disposes the isolate', async () => {
    const loop = makeValidator({
      id: 'loop',
      implementation: { abi: 'forge-validator/v1', path: 'slots/validators/loop.cjs' },
      budget: { cpuMs: 100, timeoutMs: 100, memoryMiB: 64 },
    });
    const ok = makeValidator({
      id: 'ok',
      implementation: { abi: 'forge-validator/v1', path: 'slots/validators/ok.cjs' },
    });
    const { runner } = makeEnv(
      {
        'slots/validators/loop.cjs': 'module.exports = { validate(input) { while (true) { /* spin */ } } };',
        'slots/validators/ok.cjs': 'module.exports = { validate() { return { pass: true, issues: [] }; } };',
      },
      loop,
    );
    const result = await runner.runValidator(loop, baseEnvelope(loop));
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.reason).toBe('timeout');
    // The timed-out isolate is disposed and never reused: a healthy call on
    // the same runner still works.
    const second = await runner.runValidator(ok, baseEnvelope(ok));
    expect(second.kind).toBe('ok');
  });

  it('maps a memory overrun to unavailable(memory)', async () => {
    const source = [
      'module.exports = { validate() {',
      '  const a = [];',
      '  for (let i = 0; i < 100000000; i++) { a.push({ x: "y".repeat(100) }); }',
      '  return { pass: true, issues: [] };',
      '} };',
    ].join('\n');
    const { runner, registration } = makeEnv(source, makeValidator({ budget: { cpuMs: 1000, timeoutMs: 1000, memoryMiB: 8 } }));
    const result = await runner.runValidator(registration, baseEnvelope(registration));
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.reason).toBe('memory');
  });
});

describe('EvaluatorRunner — invalid returns map to resultInvalid', () => {
  const CASES: Array<[string, string]> = [
    ['non-object verdict', 'module.exports = { validate() { return "nope"; } };'],
    ['null verdict', 'module.exports = { validate() { return null; } };'],
    ['non-boolean pass', 'module.exports = { validate() { return { pass: "yes", issues: [] }; } };'],
    ['non-array issues', 'module.exports = { validate() { return { pass: true, issues: "oops" }; } };'],
  ];
  for (const [label, source] of CASES) {
    it(`rejects a ${label} with resultInvalid`, async () => {
      const { runner, registration } = makeEnv(source);
      const result = await runner.runValidator(registration, baseEnvelope(registration));
      expect(result.kind).toBe('resultInvalid');
    });
  }

  it('returns unavailable when the implementation source is unreadable', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'forge-evaluator-missing-'));
    tempRoots.push(dataRoot);
    const paths = CorePaths.create({ dataRoot, templateRoot: dataRoot });
    const runner = new EvaluatorRunner({ paths, taskId: 'task-v', limits: makeLimits() });
    const result = await runner.runValidator(
      makeValidator({ implementation: { abi: 'forge-validator/v1', path: 'slots/validators/missing.cjs' } }),
      { version: 1 },
    );
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.reason).toBe('source');
  });
});

describe('EvaluatorRunner — sandbox escape and nondeterminism stripping', () => {
  it('has no require/process/fetch/FS/network handles and freezes globals', async () => {
    const source = [
      'module.exports = { validate(input) {',
      '  const probe = { require: typeof require, process: typeof process, fetch: typeof fetch };',
      '  try { require("fs"); probe.requireUsed = "yes"; } catch { probe.requireUsed = "no"; }',
      '  let mutation = "no-op";',
      '  try { globalThis.sneaky = 1; } catch { mutation = "threw"; }',
      '  const added = typeof globalThis.sneaky;',
      '  return { pass: true, issues: [{ evidence: [probe.require, probe.process, probe.fetch, probe.requireUsed, mutation, added].join("|"), scope: "escape" }] };',
      '} };',
    ].join('\n');
    const { runner, registration } = makeEnv(source);
    const result = await runner.runValidator(registration, baseEnvelope(registration));
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.issues[0]?.evidence).toBe('undefined|undefined|undefined|no|no-op|undefined');
  });

  it('keeps Date.now and Math.random deterministic and Intl disabled', async () => {
    const source = [
      'module.exports = { validate(input) {',
      '  const r = Math.floor(Math.random() * 1000000);',
      '  return { pass: true, issues: [{ evidence: [Date.now(), r, typeof Intl].join(":"), scope: "d" }] };',
      '} };',
    ].join('\n');
    const { runner, registration } = makeEnv(source);
    const first = await runner.runValidator(registration, baseEnvelope(registration));
    const second = await runner.runValidator(registration, baseEnvelope(registration));
    expect(first.kind).toBe('ok');
    expect(second.kind).toBe('ok');
    if (first.kind !== 'ok' || second.kind !== 'ok') return;
    // Randomness stripped/frozen → two runs are byte-identical, Date is fixed,
    // Intl is gone.
    expect(second.issues).toEqual(first.issues);
    expect(first.issues[0]?.evidence).toContain(':undefined');
    expect(first.issues[0]?.evidence?.split(':')[0]).toBe('1700000000000');
  });

  it('prevents reassigning the frozen Math.random stub', async () => {
    const source = [
      'module.exports = { validate(input) {',
      '  try { Math.random = () => 999; } catch { /* strict-mode throw */ }',
      '  const value = Math.random();',
      '  return { pass: value !== 999, issues: [{ evidence: String(value), scope: "rand" }] };',
      '} };',
    ].join('\n');
    const { runner, registration } = makeEnv(source);
    const result = await runner.runValidator(registration, baseEnvelope(registration));
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.pass).toBe(true);
  });

  it('honors an already-aborted signal without running', async () => {
    const { runner, registration } = makeEnv(
      'module.exports = { validate() { return { pass: true, issues: [] }; } };',
    );
    const controller = new AbortController();
    controller.abort();
    const result = await runner.runValidator(registration, baseEnvelope(registration), controller.signal);
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.reason).toBe('aborted');
  });
});

describe('EvaluatorRunner — assembler ABI (Step 6)', () => {
  function assemblerEnv(source: string, assembler = makeAssembler()) {
    const dataRoot = mkdtempSync(join(tmpdir(), 'forge-evaluator-asm-'));
    tempRoots.push(dataRoot);
    const paths = CorePaths.create({ dataRoot, templateRoot: dataRoot });
    const taskId = 'task-asm';
    const full = join(paths.taskSnapshotRoot(taskId), assembler.implementation.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source, 'utf8');
    const runner = new EvaluatorRunner({ paths, taskId, limits: makeLimits() });
    const envelope = buildAssemblerEnvelope(assembler, { slots: [], typeDeclarations: [] });
    return { runner, assembler, envelope };
  }

  it('accepts exact declared-route coverage with UTF-8 content', async () => {
    const source = [
      'module.exports = { assemble(input) {',
      '  return [ { routeId: "out-1", content: "# A" }, { routeId: "out-2", content: "内容 B" } ];',
      '} };',
    ].join('\n');
    const { runner, assembler, envelope } = assemblerEnv(source);
    const result = await runner.runAssembler(assembler, envelope);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.files).toEqual([
      { routeId: 'out-1', content: '# A' },
      { routeId: 'out-2', content: '内容 B' },
    ]);
    expect(result.outputBytes).toBe(Buffer.byteLength('# A', 'utf8') + Buffer.byteLength('内容 B', 'utf8'));
  });

  const INVALID_SOURCES: Array<[string, string]> = [
    ['non-array result', 'module.exports = { assemble() { return { routeId: "out-1", content: "x" }; } };'],
    ['missing declared route', 'module.exports = { assemble() { return [ { routeId: "out-1", content: "x" } ]; } };'],
    ['extra undeclared route', 'module.exports = { assemble() { return [ { routeId: "out-1", content: "x" }, { routeId: "out-2", content: "y" }, { routeId: "extra", content: "z" } ]; } };'],
    ['duplicate route id', 'module.exports = { assemble() { return [ { routeId: "out-1", content: "x" }, { routeId: "out-1", content: "y" } ]; } };'],
    ['non-string content', 'module.exports = { assemble() { return [ { routeId: "out-1", content: 42 }, { routeId: "out-2", content: "y" } ]; } };'],
    ['content with lone surrogate', 'module.exports = { assemble() { return [ { routeId: "out-1", content: "\\uD800" }, { routeId: "out-2", content: "y" } ]; } };'],
    ['smuggled control field (path)', 'module.exports = { assemble() { return [ { routeId: "out-1", content: "x", path: "/etc/passwd" }, { routeId: "out-2", content: "y" } ]; } };'],
    ['smuggled control field (mediaType)', 'module.exports = { assemble() { return [ { routeId: "out-1", content: "x" }, { routeId: "out-2", content: "y", mediaType: "text/markdown" } ]; } };'],
  ];
  for (const [label, source] of INVALID_SOURCES) {
    it(`rejects ${label} as resultInvalid`, async () => {
      const { runner, assembler, envelope } = assemblerEnv(source);
      const result = await runner.runAssembler(assembler, envelope);
      expect(result.kind).toBe('resultInvalid');
    });
  }

  it('rejects a per-file byte overrun as resultInvalid', async () => {
    const source = [
      'module.exports = { assemble() {',
      '  return [ { routeId: "out-1", content: "x".repeat(100) }, { routeId: "out-2", content: "y" } ];',
      '} };',
    ].join('\n');
    const { runner, assembler, envelope } = assemblerEnv(source);
    const limits = makeLimits();
    limits.output.maxArtifactBytesPerFile = 8;
    const dataRoot = mkdtempSync(join(tmpdir(), 'forge-evaluator-asm-bytes-'));
    tempRoots.push(dataRoot);
    const paths = CorePaths.create({ dataRoot, templateRoot: dataRoot });
    const taskId = 'task-asm';
    const full = join(paths.taskSnapshotRoot(taskId), assembler.implementation.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source, 'utf8');
    const strict = new EvaluatorRunner({ paths, taskId, limits });
    const result = await strict.runAssembler(assembler, envelope);
    expect(result.kind).toBe('resultInvalid');
  });

  it('rejects a total byte overrun as resultInvalid', async () => {
    const source = [
      'module.exports = { assemble() {',
      '  return [ { routeId: "out-1", content: "x".repeat(50) }, { routeId: "out-2", content: "y".repeat(50) } ];',
      '} };',
    ].join('\n');
    const { runner, assembler, envelope } = assemblerEnv(source);
    const limits = makeLimits();
    limits.output.maxTotalArtifactBytes = 20;
    const dataRoot = mkdtempSync(join(tmpdir(), 'forge-evaluator-asm-total-'));
    tempRoots.push(dataRoot);
    const paths = CorePaths.create({ dataRoot, templateRoot: dataRoot });
    const taskId = 'task-asm';
    const full = join(paths.taskSnapshotRoot(taskId), assembler.implementation.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source, 'utf8');
    const strict = new EvaluatorRunner({ paths, taskId, limits });
    const result = await strict.runAssembler(assembler, envelope);
    expect(result.kind).toBe('resultInvalid');
  });
});

describe('runValidatorV2 — Task 14 v2 evaluator adapter (spec §12)', () => {
  const V2_BUDGET = { timeoutMs: 5000, memoryMiB: 64 };

  it('runs an allowlisted builtin source against resolved ABI v2 data (never a snapshot path)', async () => {
    const source = [
      "'use strict';",
      'module.exports = { validate(input) {',
      "  return { status: 'valid', executionDigest: '' };",
      '} };',
    ].join('\n');
    const result = await runValidatorV2({
      source,
      input: { version: 2, abi: 'forge-validator/v2', core: { nodes: [] } },
      budget: V2_BUDGET,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.raw).toEqual({ status: 'valid', executionDigest: '' });
    expect(result.outputBytes).toBeGreaterThan(0);
    expect(result.deterministic).toBe(true);
  });

  it('a handler varying only its claimed executionDigest stays deterministic (engine overrides it)', async () => {
    const source = [
      "'use strict';",
      'module.exports = { validate(input) {',
      "  return { status: 'valid', executionDigest: String(Math.random()) + String(Date.now()) };",
      '} };',
    ].join('\n');
    const result = await runValidatorV2({
      source,
      input: { version: 2, abi: 'forge-validator/v2' },
      budget: V2_BUDGET,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // Date/Math.random are frozen by the hardened sandbox per isolate, but the
    // seeded PRNG advances BETWEEN calls — the substantive part (status) is
    // identical, so the probe strips the overridden executionDigest.
    expect(result.deterministic).toBe(true);
  });

  it('a stateful handler with different substantive output across the double-run is nondeterministic', async () => {
    const source = [
      "'use strict';",
      'let count = 0;',
      'module.exports = { validate(input) {',
      '  count = count + 1;',
      "  if (count === 1) return { status: 'valid', executionDigest: '' };",
      "  return { status: 'domain_invalid', issues: [], executionDigest: '' };",
      '} };',
    ].join('\n');
    const result = await runValidatorV2({
      source,
      input: { version: 2, abi: 'forge-validator/v2' },
      budget: V2_BUDGET,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.deterministic).toBe(false);
  });

  it('process/require/fetch access is impossible in the hardened isolate', async () => {
    for (const body of ['process.exit(1);', 'require("node:fs");', 'globalThis.fetch("http://x");']) {
      const source = ["'use strict';", 'module.exports = { validate(input) {', `  ${body}`, '} };'].join('\n');
      const result = await runValidatorV2({ source, input: { version: 2 }, budget: V2_BUDGET });
      expect(result.kind).toBe('unavailable');
    }
  });

  it('an aborted signal is rejected before any execution', async () => {
    const controller = new AbortController();
    controller.abort();
    const source = ["'use strict';", 'module.exports = { validate(input) { return { status: "valid", executionDigest: "" }; } };'].join('\n');
    const result = await runValidatorV2({ source, input: { version: 2 }, budget: V2_BUDGET, signal: controller.signal });
    expect(result).toEqual({ kind: 'unavailable', reason: 'aborted' });
  });
});
