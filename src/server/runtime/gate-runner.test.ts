// @vitest-environment node
/**
 * GateRunner tests (plan 2026-08-07 Phase 2, spec §4.3).
 *
 * The runner compiles a template-owned CommonJS validator inside an
 * isolated-vm sandbox and executes it against a content proposal. Coverage:
 * the pass/reject verdict paths, sandbox restrictions (no require / fetch /
 * process), the CPU timeout gate, the return-value contract check, compile
 * failures, the per-(task, agent, content-hash) isolate cache and disposal.
 *
 * Validator sources in this file are test data — the GateRunner module itself
 * carries zero business vocabulary (iron rule 1).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CorePaths } from '../storage/core-paths';
import { GateRunner, GATE_ERROR_CODES, type GateRunInput } from './gate-runner';

const tempRoots: string[] = [];

function makeEnv(
  validatorSource: string,
  options: { timeoutMs?: number; memoryLimitMb?: number } = {},
): { runner: GateRunner; taskId: string; input: GateRunInput } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'forge-core-gate-runner-'));
  tempRoots.push(dataRoot);
  const paths = CorePaths.create({ dataRoot, templateRoot: dataRoot });
  const taskId = 'task-gate';
  const snapshotRoot = paths.taskSnapshotRoot(taskId);
  mkdirSync(join(snapshotRoot, 'gates'), { recursive: true });
  writeFileSync(join(snapshotRoot, 'gates/validator.cjs'), validatorSource, 'utf8');
  const runner = new GateRunner({ paths, timeoutMs: options.timeoutMs ?? 5000, ...options });
  return {
    runner,
    taskId,
    input: {
      taskId,
      agentId: 'agent-a',
      validatorPath: 'gates/validator.cjs',
      content: 'neutral content',
      artifactType: 'draft',
    },
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

describe('GateRunner verdict paths', () => {
  const PASS_REJECT = [
    'module.exports = {',
    '  validate(input) {',
    "    if (typeof input.content === 'string' && input.content.includes('BAD')) {",
    '      return { pass: false, issues: [{ stage: "content", evidence: "bad content", scope: "draft" }] };',
    '    }',
    '    return { pass: true, issues: [] };',
    '  }',
    '};',
  ].join('\n');

  it('returns pass when the validator accepts the content', async () => {
    const { runner, input } = makeEnv(PASS_REJECT);
    await expect(runner.run({ ...input, content: 'clean content' })).resolves.toEqual({
      pass: true,
      issues: [],
    });
  });

  it('returns the structured issues when the validator rejects the content', async () => {
    const { runner, input } = makeEnv(PASS_REJECT);
    await expect(runner.run({ ...input, content: 'BAD content' })).resolves.toEqual({
      pass: false,
      issues: [{ stage: 'content', evidence: 'bad content', scope: 'draft' }],
    });
  });

  it('passes artifactType and context through to the validator input', async () => {
    const ECHO = [
      'module.exports = {',
      '  validate(input) {',
      '    return {',
      '      pass: input.artifactType === "chapter_markdown" && input.context && input.context.strict === true,',
      '      issues: [],',
      '    };',
      '  }',
      '};',
    ].join('\n');
    const { runner, input } = makeEnv(ECHO);
    await expect(
      runner.run({ ...input, content: 'x', artifactType: 'chapter_markdown', context: { strict: true } }),
    ).resolves.toEqual({ pass: true, issues: [] });
    await expect(
      runner.run({ ...input, content: 'x', artifactType: 'other' }),
    ).resolves.toEqual({ pass: false, issues: [] });
  });
});

describe('GateRunner sandbox restrictions', () => {
  it('blocks require: a validator calling require throws a typed runtime failure', async () => {
    const REQUIRE_FS = [
      'module.exports = {',
      '  validate(input) { require("fs"); return { pass: true, issues: [] }; }',
      '};',
    ].join('\n');
    const { runner, input } = makeEnv(REQUIRE_FS);
    await expect(runner.run(input)).rejects.toMatchObject({
      code: GATE_ERROR_CODES.GATE_RUNTIME_ERROR,
      retryable: false,
    });
  });

  it('keeps fetch and process undefined inside the sandbox', async () => {
    const FETCH_PROCESS = [
      'module.exports = {',
      '  validate(input) {',
      '    const leaked = typeof fetch !== "undefined" || typeof process !== "undefined";',
      '    return { pass: !leaked, issues: [] };',
      '  }',
      '};',
    ].join('\n');
    const { runner, input } = makeEnv(FETCH_PROCESS);
    await expect(runner.run(input)).resolves.toEqual({ pass: true, issues: [] });
  });

  it('fails closed when the validator throws inside the sandbox', async () => {
    const THROW = [
      'module.exports = {',
      '  validate(input) { throw new Error("validator exploded"); }',
      '};',
    ].join('\n');
    const { runner, input } = makeEnv(THROW);
    await expect(runner.run(input)).rejects.toMatchObject({
      code: GATE_ERROR_CODES.GATE_RUNTIME_ERROR,
    });
  });
});

describe('GateRunner timeout gate', () => {
  it('rejects an infinite-loop validator with GATE_TIMEOUT', async () => {
    const LOOP = [
      'module.exports = {',
      '  validate(input) { while (true) { /* never returns */ } }',
      '};',
    ].join('\n');
    const { runner, input } = makeEnv(LOOP, { timeoutMs: 200 });
    await expect(runner.run(input)).rejects.toMatchObject({
      code: GATE_ERROR_CODES.GATE_TIMEOUT,
    });
  });
});

describe('GateRunner return-value contract', () => {
  const CASES: Array<[string, string]> = [
    ['empty object', 'module.exports = { validate() { return {}; } };'],
    ['string result', 'module.exports = { validate() { return "nope"; } };'],
    ['null result', 'module.exports = { validate() { return null; } };'],
    ['non-boolean pass', 'module.exports = { validate() { return { pass: "yes" }; } };'],
    ['non-array issues', 'module.exports = { validate() { return { pass: true, issues: "oops" }; } };'],
  ];

  for (const [label, source] of CASES) {
    it(`rejects a nonconforming result (${label}) with GATE_CONTRACT_INVALID`, async () => {
      const { runner, input } = makeEnv(source);
      await expect(runner.run(input)).rejects.toMatchObject({
        code: GATE_ERROR_CODES.GATE_CONTRACT_INVALID,
        retryable: false,
      });
    });
  }

  it('normalizes issues: keeps only stage/evidence/scope and coerces non-strings', async () => {
    const EXTRA_KEYS = [
      'module.exports = {',
      '  validate() {',
      '    return {',
      '      pass: false,',
      '      issues: [',
      '        { stage: "content", evidence: 42, scope: "draft", junk: "discard", nested: { a: 1 } },',
      '        null,',
      '        { evidence: "only-evidence" },',
      '      ],',
      '    };',
      '  }',
      '};',
    ].join('\n');
    const { runner, input } = makeEnv(EXTRA_KEYS);
    await expect(runner.run(input)).resolves.toEqual({
      pass: false,
      issues: [
        { stage: 'content', evidence: '42', scope: 'draft' },
        {},
        { evidence: 'only-evidence' },
      ],
    });
  });
});

describe('GateRunner compile failures', () => {
  it('maps a validator syntax error to GATE_COMPILE_FAILED', async () => {
    const BAD_SYNTAX = 'module.exports = { validate(input) { return { pass: ';
    const { runner, input } = makeEnv(BAD_SYNTAX);
    await expect(runner.run(input)).rejects.toMatchObject({
      code: GATE_ERROR_CODES.GATE_COMPILE_FAILED,
    });
  });

  it('fails with GATE_COMPILE_FAILED when the validator file is unreadable', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'forge-core-gate-missing-'));
    tempRoots.push(dataRoot);
    const paths = CorePaths.create({ dataRoot, templateRoot: dataRoot });
    const runner = new GateRunner({ paths });
    await expect(
      runner.run({
        taskId: 'task-gate',
        agentId: 'agent-a',
        validatorPath: 'gates/does-not-exist.cjs',
        content: 'x',
        artifactType: 'draft',
      }),
    ).rejects.toMatchObject({
      code: GATE_ERROR_CODES.GATE_COMPILE_FAILED,
    });
  });

  it('fails with GATE_COMPILE_FAILED when the validator path escapes the snapshot', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'forge-core-gate-escape-'));
    tempRoots.push(dataRoot);
    writeFileSync(join(dataRoot, 'outside.cjs'), 'module.exports = { validate() { return { pass: true }; } };', 'utf8');
    const paths = CorePaths.create({ dataRoot, templateRoot: dataRoot });
    const runner = new GateRunner({ paths });
    await expect(
      runner.run({
        taskId: 'task-gate',
        agentId: 'agent-a',
        validatorPath: '../outside.cjs',
        content: 'x',
        artifactType: 'draft',
      }),
    ).rejects.toMatchObject({ code: GATE_ERROR_CODES.GATE_COMPILE_FAILED });
  });
});

describe('GateRunner isolate cache', () => {
  const PASS_REJECT = [
    'module.exports = {',
    '  validate(input) { return { pass: !input.content.includes("BAD"), issues: [] }; }',
    '};',
  ].join('\n');

  it('reuses one compiled isolate across runs of the same validator content', async () => {
    const { runner, input } = makeEnv(PASS_REJECT);
    await runner.run({ ...input, content: 'one' });
    expect(runner.cachedCount()).toBe(1);
    await runner.run({ ...input, content: 'two' });
    await runner.run({ ...input, content: 'three' });
    expect(runner.cachedCount()).toBe(1);
  });

  it('separates cache entries by agent id', async () => {
    const { runner, input } = makeEnv(PASS_REJECT);
    await runner.run(input);
    await runner.run({ ...input, agentId: 'agent-b' });
    expect(runner.cachedCount()).toBe(2);
  });

  it('drops the cache entry after a timeout so a poisoned isolate is never reused', async () => {
    const LOOP = 'module.exports = { validate(input) { while (true) {} } };';
    const { runner, input } = makeEnv(LOOP, { timeoutMs: 200 });
    await expect(runner.run(input)).rejects.toMatchObject({ code: GATE_ERROR_CODES.GATE_TIMEOUT });
    expect(runner.cachedCount()).toBe(0);
  });

  it('disposeAll releases every cached isolate', async () => {
    const { runner, input } = makeEnv(PASS_REJECT);
    await runner.run(input);
    await runner.run({ ...input, agentId: 'agent-b' });
    expect(runner.cachedCount()).toBe(2);
    runner.disposeAll();
    expect(runner.cachedCount()).toBe(0);
  });
});
