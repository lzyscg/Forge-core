// @vitest-environment node
/**
 * ValidationEngine Gate accounting tests (Task 8 Step 2, spec §10 / design
 * §14.3-§14.5 + §25.4 E03/E05).
 *
 * Covers:
 * - enforcement: blocking reliable `pass:false` → VALIDATOR_REJECTED error →
 *   failed; advisory reliable `pass:false` → VALIDATOR_ADVISORY warning →
 *   passed;
 * - execution reliability beats enforcement: any compile/exception/timeout/
 *   memory/invalid-return → incomplete regardless of enforcement;
 * - preflight overflow (declared CPU / invocation totals) executes ZERO
 *   validators and returns RESOURCE_LIMIT_EXCEEDED + incomplete;
 * - runtime output/issues/wall overage stops remaining validators →
 *   incomplete + truncated;
 * - deterministic target expansion in stable (validatorId, target) order;
 * - Merge runs only affected validators; Seal runs ALL applicable validators;
 *   Structure Gate applies no template validators.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, StructuredSlotLimitsV1 } from '../../../shared/structured-slots';
import type { FrozenStructuredSlotContractV1, ValidatorRegistrationV1 } from '../../template/structured-slot-contract';
import { CorePaths } from '../../storage/core-paths';
import { ValidationEngine } from './validation-engine';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

/** Fixture-shaped limits (≤ 25% of the design candidate profile). */
function makeLimits(): StructuredSlotLimitsV1 {
  return {
    schema: { maxSchemaDepth: 4, maxSchemaNodes: 1024, maxEnumItems: 64, maxPatternLength: 128 },
    structure: { maxSlots: 2500, maxTreeDepth: 8, maxChildrenPerSlot: 250 },
    payload: { maxSpecBytesPerSlot: 16384, maxContentBytesPerSlot: 262144, maxScaffoldPayloadBytes: 16777216 },
    draft: { maxChangedSlots: 500, maxDraftBytes: 4194304 },
    attempt: {
      maxSlotToolCallsPerAttempt: 128,
      maxValidationRunsPerAttempt: 4,
      maxValidatorInvocationsPerAttempt: 10000,
      maxAggregateValidatorCpuMsPerAttempt: 60000,
      maxAggregateValidatorWallClockMsPerAttempt: 120000,
      maxValidatorOutputBytesPerAttempt: 4194304,
      maxAttemptWallClockMs: 150000,
    },
    validation: {
      maxValidators: 16,
      maxValidatorInvocationsPerGate: 2500,
      maxAggregateValidatorCpuMsPerGate: 15000,
      maxAggregateValidatorWallClockMsPerGate: 30000,
      maxValidatorOutputBytesPerGate: 1048576,
      maxIssuesPerRun: 125,
    },
    output: { maxArtifactFiles: 16, maxArtifactBytesPerFile: 4194304, maxTotalArtifactBytes: 16777216 },
  };
}

/** `path` is a shortcut for `implementation.path` (implementation overrides win). */
type ValidatorOverride = Partial<ValidatorRegistrationV1> & { path?: string };

function makeValidator(overrides: ValidatorOverride = {}): ValidatorRegistrationV1 {
  const { path, implementation, ...rest } = overrides;
  return {
    id: 'v1',
    scope: 'slot',
    trigger: 'merge-and-seal',
    enforcement: 'blocking',
    selector: { kind: 'all' },
    budget: { cpuMs: 100, timeoutMs: 500, memoryMiB: 64 },
    ...rest,
    implementation:
      implementation ?? (path !== undefined
        ? { abi: 'forge-validator/v1', path }
        : { abi: 'forge-validator/v1', path: 'slots/validators/v1.cjs' }),
  };
}

const SLOT_TYPES = [
  { id: 'doc', name: 'Document', description: 'Root container.' },
  { id: 'title', name: 'Title', description: 'Leaf.' },
  { id: 'body', name: 'Body', description: 'Leaf.' },
];

/** Builds a valid contract object; the engine reads only validators/slotTypes/limits. */
function makeContract(
  validators: ValidatorRegistrationV1[],
  limits: StructuredSlotLimitsV1 = makeLimits(),
): FrozenStructuredSlotContractV1 {
  return {
    version: 1,
    slotTypes: SLOT_TYPES.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      specSchema: { type: 'object' } as never,
      content: { presence: 'forbidden' } as never,
    })),
    layoutGrammar: {} as never,
    accessProfiles: [],
    validators,
    assembler: {
      id: 'asm',
      implementation: { abi: 'forge-assembler/v1', path: 'slots/assembler/a.cjs' },
      budget: { cpuMs: 100, timeoutMs: 500, memoryMiB: 64 },
      routes: [],
    },
    limits,
    resourceManifest: [],
    abiProfileIdentity: {
      validatorAbi: 'forge-validator/v1',
      assemblerAbi: 'forge-assembler/v1',
      profileIdentity: 'forge-structured-runtime/v1',
    },
    semanticDigest: 'test',
  };
}

interface GateEnv {
  engine: ValidationEngine;
  contract: FrozenStructuredSlotContractV1;
  taskId: string;
}

/** Writes the validator sources under the task snapshot and returns an engine. */
function makeEnv(
  validators: ValidatorRegistrationV1[],
  sources: Record<string, string>,
  limits: StructuredSlotLimitsV1 = makeLimits(),
): GateEnv {
  const dataRoot = mkdtempSync(join(tmpdir(), 'forge-validation-engine-'));
  tempRoots.push(dataRoot);
  const paths = CorePaths.create({ dataRoot, templateRoot: dataRoot });
  const taskId = 'task-v';
  const snapshotRoot = paths.taskSnapshotRoot(taskId);
  for (const [logicalPath, source] of Object.entries(sources)) {
    const full = join(snapshotRoot, logicalPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source, 'utf8');
  }
  return { engine: new ValidationEngine({ paths }), contract: makeContract(validators, limits), taskId };
}

/** Slots for the fixture tree: doc(r) → title(s-a) + body(s-b). */
function baseSlots(): Array<{
  slotId: string;
  parentSlotId: string | null;
  order: number;
  typeId: string;
  spec: Record<string, JsonValue>;
  contentPresence: 'unset' | 'set';
  content: JsonValue;
}> {
  return [
    { slotId: 'r', parentSlotId: null, order: 0, typeId: 'doc', spec: {}, contentPresence: 'unset', content: null },
    { slotId: 's-a', parentSlotId: 'r', order: 0, typeId: 'title', spec: {}, contentPresence: 'set', content: 'A' },
    { slotId: 's-b', parentSlotId: 'r', order: 1, typeId: 'body', spec: {}, contentPresence: 'set', content: 'B' },
  ];
}

/** Validator that rejects exactly the given slot ids and passes the rest. */
function rejectingSource(rejected: string[]): string {
  return [
    'module.exports = { validate(input) {',
    `  const rejected = ${JSON.stringify(rejected)};`,
    '  if (input.target.kind === "slot" && rejected.includes(input.target.slotId)) {',
    '    return { pass: false, issues: [{ stage: "content", evidence: "rejected " + input.target.slotId, scope: "v" }] };',
    '  }',
    '  return { pass: true, issues: [] };',
    '} };',
  ].join('\n');
}

const PASS_SOURCE = 'module.exports = { validate() { return { pass: true, issues: [] }; } };';
const THROW_SOURCE = 'module.exports = { validate() { throw new Error("boom"); } };';
const INVALID_RETURN_SOURCE = 'module.exports = { validate() { return "not a verdict"; } };';

describe('ValidationEngine — enforcement', () => {
  it('maps a blocking reliable reject to VALIDATOR_REJECTED error → failed', async () => {
    const v = makeValidator({ id: 'block', path: 'slots/validators/block.cjs', enforcement: 'blocking' });
    const { engine, contract, taskId } = makeEnv([v], { 'slots/validators/block.cjs': rejectingSource(['s-a']) });
    const result = await engine.runMergeGate({
      taskId,
      contract,
      slots: baseSlots(),
      changedSlotIds: ['s-a'],
    });
    expect(result.verdict.status).toBe('failed');
    expect(result.verdict.truncated).toBe(false);
    expect(result.verdict.issues).toHaveLength(1);
    const issue = result.verdict.issues[0]!;
    expect(issue.code).toBe('VALIDATOR_REJECTED');
    expect(issue.severity).toBe('error');
    expect(issue.phase).toBe('merge');
    expect(issue.source).toBe('validator');
    expect(issue.primaryLocation).toEqual({ kind: 'slot', slotId: 's-a', field: 'node', valuePointer: '' });
    expect(result.verdict.summary).toEqual({ errors: 1, warnings: 0 });
    expect(result.usage.invocations).toBe(1);
    expect(result.usage.issueCount).toBe(1);
  });

  it('maps an advisory reliable reject to VALIDATOR_ADVISORY warning → passed', async () => {
    const v = makeValidator({ id: 'adv', path: 'slots/validators/adv.cjs', enforcement: 'advisory' });
    const { engine, contract, taskId } = makeEnv([v], { 'slots/validators/adv.cjs': rejectingSource(['s-a']) });
    const result = await engine.runMergeGate({
      taskId,
      contract,
      slots: baseSlots(),
      changedSlotIds: ['s-a'],
    });
    expect(result.verdict.status).toBe('passed');
    expect(result.verdict.issues).toHaveLength(1);
    expect(result.verdict.issues[0]!.code).toBe('VALIDATOR_ADVISORY');
    expect(result.verdict.issues[0]!.severity).toBe('warning');
    expect(result.verdict.summary).toEqual({ errors: 0, warnings: 1 });
  });

  it('fails closed to incomplete when a blocking validator cannot execute', async () => {
    const v = makeValidator({ id: 'throw', path: 'slots/validators/throw.cjs', enforcement: 'blocking' });
    const { engine, contract, taskId } = makeEnv([v], { 'slots/validators/throw.cjs': THROW_SOURCE });
    const result = await engine.runMergeGate({
      taskId,
      contract,
      slots: baseSlots(),
      changedSlotIds: ['s-a'],
    });
    expect(result.verdict.status).toBe('incomplete');
    expect(result.verdict.issues[0]!.code).toBe('VALIDATOR_UNAVAILABLE');
    expect(result.verdict.issues[0]!.severity).toBe('error');
    expect(result.verdict.issues[0]!.phase).toBe('merge');
  });

  it('does not let advisory enforcement downgrade an execution failure', async () => {
    const v = makeValidator({ id: 'adv-throw', path: 'slots/validators/adv-throw.cjs', enforcement: 'advisory' });
    const { engine, contract, taskId } = makeEnv([v], { 'slots/validators/adv-throw.cjs': THROW_SOURCE });
    const result = await engine.runMergeGate({
      taskId,
      contract,
      slots: baseSlots(),
      changedSlotIds: ['s-a'],
    });
    expect(result.verdict.status).toBe('incomplete');
    expect(result.verdict.issues[0]!.code).toBe('VALIDATOR_UNAVAILABLE');
  });

  it('maps an invalid return to VALIDATOR_RESULT_INVALID → incomplete', async () => {
    const v = makeValidator({ id: 'bad', path: 'slots/validators/bad.cjs', enforcement: 'blocking' });
    const { engine, contract, taskId } = makeEnv([v], { 'slots/validators/bad.cjs': INVALID_RETURN_SOURCE });
    const result = await engine.runMergeGate({
      taskId,
      contract,
      slots: baseSlots(),
      changedSlotIds: ['s-a'],
    });
    expect(result.verdict.status).toBe('incomplete');
    expect(result.verdict.issues[0]!.code).toBe('VALIDATOR_RESULT_INVALID');
  });
});

describe('ValidationEngine — deterministic target expansion', () => {
  it('runs seal validators on every applicable target in stable (validatorId, target) order', async () => {
    const vMerge = makeValidator({ id: 'v-merge', path: 'slots/validators/v-merge.cjs', trigger: 'merge-and-seal' });
    const vSeal = makeValidator({ id: 'v-seal', path: 'slots/validators/v-seal.cjs', trigger: 'seal' });
    const { engine, contract, taskId } = makeEnv(
      [vSeal, vMerge],
      {
        'slots/validators/v-merge.cjs': rejectingSource(['s-a', 's-b']),
        'slots/validators/v-seal.cjs': rejectingSource(['s-a', 's-b']),
      },
    );
    const result = await engine.runSealGate({ taskId, contract, slots: baseSlots() });
    // Both triggers run at Seal over every slot (r + s-a + s-b); pairs are
    // sorted by (validatorId, target). Only the rejected targets emit issues:
    // v-merge/s-a, v-merge/s-b, v-seal/s-a, v-seal/s-b.
    expect(result.usage.invocations).toBe(6);
    expect(result.verdict.status).toBe('failed');
    expect(result.verdict.issues.map((i) => [i.code, i.primaryLocation.kind === 'slot' ? i.primaryLocation.slotId : 'scaffold'])).toEqual([
      ['VALIDATOR_REJECTED', 's-a'],
      ['VALIDATOR_REJECTED', 's-b'],
      ['VALIDATOR_REJECTED', 's-a'],
      ['VALIDATOR_REJECTED', 's-b'],
    ]);
  });

  it('runs a scaffold validator exactly once over the whole tree at Seal', async () => {
    const v = makeValidator({
      id: 'scaffold-check',
      path: 'slots/validators/scaffold.cjs',
      scope: 'subtree',
      selector: { kind: 'root' },
      trigger: 'seal',
    });
    const source = [
      'module.exports = { validate(input) {',
      '  const ok = input.target.kind === "slot" && input.tree.length >= 1 && Array.isArray(input.target.path);',
      '  return { pass: ok, issues: [] };',
      '} };',
    ].join('\n');
    const { engine, contract, taskId } = makeEnv([v], { 'slots/validators/scaffold.cjs': source });
    const result = await engine.runSealGate({ taskId, contract, slots: baseSlots() });
    expect(result.verdict.status).toBe('passed');
    // Selector root → exactly the root slot target (one invocation).
    expect(result.usage.invocations).toBe(1);
  });

  it('merge runs only affected slot/subtree validators and always the scaffold validator', async () => {
    const slotV = makeValidator({ id: 'slot-v', path: 'slots/validators/slot-v.cjs', trigger: 'merge-and-seal' });
    const scaffoldV = makeValidator({
      id: 'scaffold-v',
      path: 'slots/validators/scaffold-v.cjs',
      scope: 'scaffold',
      trigger: 'merge-and-seal',
    });
    const { engine, contract, taskId } = makeEnv(
      [slotV, scaffoldV],
      {
        'slots/validators/slot-v.cjs': PASS_SOURCE,
        'slots/validators/scaffold-v.cjs': PASS_SOURCE,
      },
    );
    // No-op merge: no slot/subtree targets, but the scaffold validator still runs.
    const noop = await engine.runMergeGate({ taskId, contract, slots: baseSlots(), changedSlotIds: [] });
    expect(noop.usage.invocations).toBe(1);

    // One changed slot (s-b, body): slot-v (selector all) runs on it.
    const changed = await engine.runMergeGate({ taskId, contract, slots: baseSlots(), changedSlotIds: ['s-b'] });
    expect(changed.usage.invocations).toBe(2);
  });

  it('merge ignores a changed slot that does not match the validator selector', async () => {
    const v = makeValidator({
      id: 'title-only',
      path: 'slots/validators/title-only.cjs',
      selector: { kind: 'types', typeIds: ['title'] },
    });
    const { engine, contract, taskId } = makeEnv([v], { 'slots/validators/title-only.cjs': rejectingSource(['s-a']) });
    const unrelated = await engine.runMergeGate({ taskId, contract, slots: baseSlots(), changedSlotIds: ['s-b'] });
    expect(unrelated.usage.invocations).toBe(0);
    expect(unrelated.verdict.status).toBe('passed');

    const affected = await engine.runMergeGate({ taskId, contract, slots: baseSlots(), changedSlotIds: ['s-a'] });
    expect(affected.usage.invocations).toBe(1);
    expect(affected.verdict.status).toBe('failed');
  });

  it('subtree merge re-runs ancestors of changed slots', async () => {
    const v = makeValidator({
      id: 'sub-v',
      path: 'slots/validators/sub-v.cjs',
      scope: 'subtree',
      selector: { kind: 'all' },
    });
    const { engine, contract, taskId } = makeEnv([v], { 'slots/validators/sub-v.cjs': PASS_SOURCE });
    const result = await engine.runMergeGate({ taskId, contract, slots: baseSlots(), changedSlotIds: ['s-a'] });
    // Affected = {s-a} ∪ ancestors {r} → two targets, stable order r then s-a.
    expect(result.usage.invocations).toBe(2);
  });

  it('structure gate applies no template validators and passes', async () => {
    const v = makeValidator({ id: 'block', path: 'slots/validators/block.cjs', enforcement: 'blocking' });
    const { engine, contract, taskId } = makeEnv([v], { 'slots/validators/block.cjs': rejectingSource(['s-a']) });
    const result = await engine.runStructureGate({ taskId, contract, slots: baseSlots() });
    expect(result.verdict.status).toBe('passed');
    expect(result.verdict.issues).toEqual([]);
    expect(result.usage.invocations).toBe(0);
  });
});

describe('ValidationEngine — budgets and aggregate accounting', () => {
  it('preflight overflow (declared CPU) executes ZERO validators → RESOURCE_LIMIT_EXCEEDED + incomplete', async () => {
    const v = makeValidator({
      id: 'cpu-heavy',
      path: 'slots/validators/cpu-heavy.cjs',
      budget: { cpuMs: 100_000, timeoutMs: 500, memoryMiB: 64 },
    });
    const { engine, contract, taskId } = makeEnv([v], { 'slots/validators/cpu-heavy.cjs': PASS_SOURCE });
    const result = await engine.runSealGate({ taskId, contract, slots: baseSlots() });
    expect(result.usage.invocations).toBe(0);
    expect(result.usage.preflightRejected).toBe(true);
    expect(result.verdict.status).toBe('incomplete');
    expect(result.verdict.truncated).toBe(false);
    expect(result.verdict.issues.map((i) => i.code)).toEqual(['RESOURCE_LIMIT_EXCEEDED']);
  });

  it('preflight overflow (invocation count) executes ZERO validators', async () => {
    const v = makeValidator({ id: 'v1', path: 'slots/validators/v1.cjs' });
    const limits = makeLimits();
    limits.validation.maxValidatorInvocationsPerGate = 1;
    const { engine, contract, taskId } = makeEnv([v], { 'slots/validators/v1.cjs': PASS_SOURCE }, limits);
    // selector all + seal → 3 slot targets > 1 planned invocation.
    const result = await engine.runSealGate({ taskId, contract, slots: baseSlots() });
    expect(result.usage.invocations).toBe(0);
    expect(result.usage.preflightRejected).toBe(true);
    expect(result.verdict.status).toBe('incomplete');
  });

  it('runtime output overage stops remaining validators → incomplete + truncated', async () => {
    const big = makeValidator({ id: 'big', path: 'slots/validators/big.cjs' });
    const small = makeValidator({ id: 'small', path: 'slots/validators/small.cjs' });
    const bigSource = [
      'module.exports = { validate() { return { pass: true, issues: [{ evidence: "x".repeat(4000), scope: "v" }] }; } };',
    ].join('\n');
    const limits = makeLimits();
    limits.validation.maxValidatorOutputBytesPerGate = 1000;
    const { engine, contract, taskId } = makeEnv(
      [big, small],
      { 'slots/validators/big.cjs': bigSource, 'slots/validators/small.cjs': PASS_SOURCE },
      limits,
    );
    const result = await engine.runSealGate({ taskId, contract, slots: baseSlots() });
    // big's first target already produces ~4000 bytes > the 1000-byte gate
    // budget → the remaining targets and the small validator never run.
    expect(result.usage.invocations).toBe(1);
    expect(result.verdict.status).toBe('incomplete');
    expect(result.verdict.truncated).toBe(true);
    expect(result.verdict.issues.some((i) => i.code === 'RESOURCE_LIMIT_EXCEEDED')).toBe(true);
  });

  it('runtime issue-count overage stops remaining validators → incomplete + truncated', async () => {
    const many = makeValidator({ id: 'many', path: 'slots/validators/many.cjs' });
    const small = makeValidator({ id: 'small', path: 'slots/validators/small.cjs' });
    const manySource = [
      'module.exports = { validate(input) {',
      '  return { pass: false, issues: [{ stage: "s", evidence: "e", scope: "v" }] };',
      '} };',
    ].join('\n');
    const limits = makeLimits();
    limits.validation.maxIssuesPerRun = 2;
    const { engine, contract, taskId } = makeEnv(
      [many, small],
      { 'slots/validators/many.cjs': manySource, 'slots/validators/small.cjs': PASS_SOURCE },
      limits,
    );
    const result = await engine.runSealGate({ taskId, contract, slots: baseSlots() });
    // many runs one issue per target: after the 3rd target (3 issues > 2 cap)
    // the small validator never runs.
    expect(result.usage.invocations).toBe(3);
    expect(result.verdict.status).toBe('incomplete');
    expect(result.verdict.truncated).toBe(true);
    // Internal issues capped at maxIssuesPerRun.
    expect(result.verdict.issues.length).toBe(2);
    expect(result.usage.issueCount).toBe(3);
  });

  it('runtime CPU overage stops remaining validators', async () => {
    // Scaffold scope → a single invocation; the tiny declared CPU (1ms) passes
    // preflight while the actual burn (~5ms) trips the runtime CPU budget.
    const burn = makeValidator({
      id: 'burn',
      path: 'slots/validators/burn.cjs',
      scope: 'scaffold',
      budget: { cpuMs: 1, timeoutMs: 500, memoryMiB: 64 },
    });
    const burnSource = [
      'module.exports = { validate() {',
      '  let s = 0;',
      '  for (let i = 0; i < 15000000; i++) { s += Math.sqrt(i); }',
      '  return { pass: true, issues: [{ evidence: String(s), scope: "v" }] };',
      '} };',
    ].join('\n');
    const limits = makeLimits();
    limits.validation.maxAggregateValidatorCpuMsPerGate = 1;
    const { engine, contract, taskId } = makeEnv(
      [burn],
      { 'slots/validators/burn.cjs': burnSource },
      limits,
    );
    const result = await engine.runSealGate({ taskId, contract, slots: baseSlots() });
    expect(result.verdict.status).toBe('incomplete');
    expect(result.verdict.truncated).toBe(true);
    expect(result.usage.invocations).toBe(1);
  });

  it('runtime wall-clock overage stops remaining validators', async () => {
    const slow = makeValidator({
      id: 'slow',
      path: 'slots/validators/slow.cjs',
      budget: { cpuMs: 100, timeoutMs: 500, memoryMiB: 64 },
    });
    const slowSource = [
      'module.exports = { validate() {',
      '  let s = 0;',
      '  for (let i = 0; i < 30000000; i++) { s += Math.sqrt(i); }',
      '  return { pass: true, issues: [{ evidence: String(s), scope: "v" }] };',
      '} };',
    ].join('\n');
    const limits = makeLimits();
    limits.validation.maxAggregateValidatorWallClockMsPerGate = 5;
    const { engine, contract, taskId } = makeEnv(
      [slow],
      { 'slots/validators/slow.cjs': slowSource },
      limits,
    );
    const result = await engine.runSealGate({ taskId, contract, slots: baseSlots() });
    // The first 20ms call already exceeds the 5ms validator-phase wall budget.
    expect(result.verdict.status).toBe('incomplete');
    expect(result.verdict.truncated).toBe(true);
    expect(result.usage.invocations).toBe(1);
  });

  it('passes when all validators complete and no errors exist, and reports usage', async () => {
    const v = makeValidator({ id: 'v1', path: 'slots/validators/v1.cjs' });
    const { engine, contract, taskId } = makeEnv([v], { 'slots/validators/v1.cjs': PASS_SOURCE });
    const result = await engine.runSealGate({ taskId, contract, slots: baseSlots() });
    expect(result.verdict.status).toBe('passed');
    expect(result.verdict.truncated).toBe(false);
    expect(result.verdict.issues).toEqual([]);
    expect(result.usage.invocations).toBe(3);
    expect(result.usage.cpuMs).toBeGreaterThanOrEqual(0);
    expect(result.usage.wallMs).toBeGreaterThanOrEqual(0);
    expect(result.usage.outputBytes).toBeGreaterThan(0);
    expect(result.usage.issueCount).toBe(0);
  });

  it('returns incomplete with zero invocations when the signal is already aborted', async () => {
    // Sandbox calls are synchronous, so an abort is only observed at iteration
    // boundaries; a pre-aborted signal must run nothing and fail closed.
    const v = makeValidator({ id: 'v1', path: 'slots/validators/v1.cjs' });
    const { engine, contract, taskId } = makeEnv([v], { 'slots/validators/v1.cjs': PASS_SOURCE });
    const controller = new AbortController();
    controller.abort();
    const result = await engine.runSealGate({ taskId, contract, slots: baseSlots(), signal: controller.signal });
    expect(result.verdict.status).toBe('incomplete');
    expect(result.usage.invocations).toBe(0);
  });
});
