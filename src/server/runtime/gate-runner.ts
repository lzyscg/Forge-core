/**
 * Gate execution environment (plan 2026-08-07 Phase 2, spec §4.3).
 *
 * A template may declare a JS validator file; this runner provides ONLY the
 * execution environment and the call contract. The validator code itself
 * belongs to the template (a copy is frozen into every task snapshot), so this
 * module carries zero business vocabulary (iron rule 1): it compiles whatever
 * source the snapshot supplies and never inspects its structure.
 *
 * Execution model (verified isolated-vm 6.2.0):
 * - The validator is a CommonJS-style module whose default export shape is
 *   `{ validate(input) }`. The source is wrapped in an IIFE that stubs
 *   `module`/`exports` and exposes `validate` as a global.
 * - Every call inlines the input as JSON into a tiny script and runs it with
 *   `copy: true`, so the returned verdict is a plain data object.
 * - The sandbox has no host access: `require` is undefined, `fetch` and
 *   `process` are undefined, and the CPU budget is bounded by `timeoutMs`.
 * - Compiled isolates are cached per `(taskId, agentId, contentHash)`; a
 *   validator is compiled once per task. A timed-out isolate is evicted so a
 *   poisoned isolate is never reused.
 *
 * Failures are typed, non-retryable `RuntimeFailure`s with the stable
 * GATE_* codes. Reading the validator follows the same static + realpath
 * containment discipline as skill reads, so a validator can never escape the
 * task snapshot.
 */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import ivm from 'isolated-vm';
import type { CorePaths } from '../storage/core-paths';
import { RuntimeFailure } from './agent-runtime';

/** Stable gate error codes owned by this module. */
export const GATE_ERROR_CODES = {
  /** The validator source could not be read or compiled. */
  GATE_COMPILE_FAILED: 'GATE_COMPILE_FAILED',
  /** The validator exceeded its CPU budget. */
  GATE_TIMEOUT: 'GATE_TIMEOUT',
  /** The validator threw at runtime. */
  GATE_RUNTIME_ERROR: 'GATE_RUNTIME_ERROR',
  /** The return value violated the `{ pass, issues }` contract. */
  GATE_CONTRACT_INVALID: 'GATE_CONTRACT_INVALID',
} as const;

/** One validator issue; only the three optional string keys are kept. */
export interface GateIssue {
  stage?: string;
  evidence?: string;
  scope?: string;
}

/** The normalized validator verdict the platform consumes. */
export interface GateVerdict {
  pass: boolean;
  issues: GateIssue[];
}

/** One gate execution request (content + type + optional validator context). */
export interface GateRunInput {
  taskId: string;
  agentId: string;
  /** Template-relative path, read from the task snapshot. */
  validatorPath: string;
  content: string;
  artifactType: string;
  context?: unknown;
}

export interface GateRunnerOptions {
  paths: CorePaths;
  /** CPU time budget per validate call (ms), default 5000. */
  timeoutMs?: number;
  /** Per-isolate memory ceiling (MB), default 64. */
  memoryLimitMb?: number;
}

/** A compiled, cached validator isolate pair. */
interface CachedValidator {
  isolate: ivm.Isolate;
  context: ivm.Context;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function gateFailure(code: string, message: string): RuntimeFailure {
  return new RuntimeFailure(code, message, false);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Script execution timed out');
}

/** Maps any isolate-side error to a typed gate failure. */
function classifyError(error: unknown): RuntimeFailure {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  if (message.startsWith('Script execution timed out')) {
    return gateFailure(GATE_ERROR_CODES.GATE_TIMEOUT, '门禁校验超时，提交被拒绝。');
  }
  if (name === 'SyntaxError' || message.includes('SyntaxError')) {
    return gateFailure(GATE_ERROR_CODES.GATE_COMPILE_FAILED, '门禁校验器无法编译。');
  }
  return gateFailure(GATE_ERROR_CODES.GATE_RUNTIME_ERROR, '门禁校验器执行失败。');
}

/** Contract check: non-null object, boolean `pass`, array `issues` → [] default. */
function normalizeVerdict(raw: unknown): GateVerdict {
  if (typeof raw !== 'object' || raw === null) {
    throw gateFailure(GATE_ERROR_CODES.GATE_CONTRACT_INVALID, '门禁校验器返回值不合规。');
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.pass !== 'boolean') {
    throw gateFailure(GATE_ERROR_CODES.GATE_CONTRACT_INVALID, '门禁校验器返回值不合规。');
  }
  let issues: GateIssue[] = [];
  if (record.issues !== undefined) {
    if (!Array.isArray(record.issues)) {
      throw gateFailure(GATE_ERROR_CODES.GATE_CONTRACT_INVALID, '门禁校验器返回值不合规。');
    }
    issues = record.issues.map(normalizeIssue);
  }
  return { pass: record.pass, issues };
}

/** Keeps only stage/evidence/scope; drops other keys; coerces non-strings. */
function normalizeIssue(value: unknown): GateIssue {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const issue: GateIssue = {};
  for (const key of ['stage', 'evidence', 'scope'] as const) {
    if (record[key] === undefined || record[key] === null) {
      continue;
    }
    issue[key] = String(record[key]);
  }
  return issue;
}

export class GateRunner {
  private readonly paths: CorePaths;

  private readonly timeoutMs: number;

  private readonly memoryLimitMb: number;

  private readonly cache = new Map<string, CachedValidator>();

  constructor(options: GateRunnerOptions) {
    this.paths = options.paths;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.memoryLimitMb = options.memoryLimitMb ?? 64;
  }

  /** Number of cached compiled isolates (test observability). */
  cachedCount(): number {
    return this.cache.size;
  }

  /** Releases every cached isolate (called on process shutdown). */
  disposeAll(): void {
    for (const entry of this.cache.values()) {
      try {
        entry.isolate.dispose();
      } catch {
        // Disposal is best-effort; the isolate is memory-only.
      }
    }
    this.cache.clear();
  }

  /**
   * Compiles (or reuses) the validator and runs it against the content.
   * Throws a typed RuntimeFailure on read/compile/timeout/runtime/contract
   * failures; otherwise resolves to the normalized verdict.
   */
  async run(input: GateRunInput): Promise<GateVerdict> {
    const source = await this.readValidator(input.taskId, input.validatorPath);
    const cacheKey = `${input.taskId}:${input.agentId}:${sha256(source)}`;
    let cached = this.cache.get(cacheKey);
    if (cached === undefined) {
      cached = this.compileValidator(source);
      this.cache.set(cacheKey, cached);
    }
    try {
      const callSource = `__validate(${JSON.stringify({
        content: input.content,
        artifactType: input.artifactType,
        context: input.context ?? null,
      })})`;
      const raw = cached.isolate.compileScriptSync(callSource).runSync(cached.context, {
        timeout: this.timeoutMs,
        copy: true,
      });
      return normalizeVerdict(raw);
    } catch (error) {
      // A typed RuntimeFailure already carries the right code (contract
      // failures thrown by normalizeVerdict); never re-classify it.
      if (error instanceof RuntimeFailure) {
        throw error;
      }
      if (isTimeout(error)) {
        this.cache.delete(cacheKey);
        try {
          cached.isolate.dispose();
        } catch {
          // Best-effort disposal of the evicted isolate.
        }
      }
      throw classifyError(error);
    }
  }

  /**
   * Reads the validator confined to the task snapshot (static + realpath
   * containment, mirroring skill reads). Any failure is a compile failure:
   * fail-closed, the validator being unreadable means the gate cannot run.
   */
  private async readValidator(taskId: string, validatorPath: string): Promise<string> {
    const snapshotRoot = this.paths.taskSnapshotRoot(taskId);
    if (isAbsolute(validatorPath) || validatorPath.includes('\0')) {
      throw gateFailure(GATE_ERROR_CODES.GATE_COMPILE_FAILED, '门禁校验器不可读。');
    }
    const resolved = resolve(snapshotRoot, validatorPath);
    if (resolved !== snapshotRoot && !resolved.startsWith(snapshotRoot + sep)) {
      throw gateFailure(GATE_ERROR_CODES.GATE_COMPILE_FAILED, '门禁校验器不可读。');
    }
    let real: string;
    let realRoot: string;
    try {
      real = await realpath(resolved);
      realRoot = await realpath(snapshotRoot);
    } catch {
      throw gateFailure(GATE_ERROR_CODES.GATE_COMPILE_FAILED, '门禁校验器不可读。');
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw gateFailure(GATE_ERROR_CODES.GATE_COMPILE_FAILED, '门禁校验器不可读。');
    }
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(real);
    } catch {
      throw gateFailure(GATE_ERROR_CODES.GATE_COMPILE_FAILED, '门禁校验器不可读。');
    }
    if (!fileStat.isFile()) {
      throw gateFailure(GATE_ERROR_CODES.GATE_COMPILE_FAILED, '门禁校验器不可读。');
    }
    try {
      return await readFile(real, 'utf8');
    } catch {
      throw gateFailure(GATE_ERROR_CODES.GATE_COMPILE_FAILED, '门禁校验器不可读。');
    }
  }

  /**
   * Compiles the validator source into a fresh isolate: the CommonJS source is
   * wrapped in an IIFE that stubs `module`/`exports` and exposes `.validate`
   * as a global. Any failure (syntax error, wrapper execution error, wrapper
   * timeout on a top-level loop) disposes the isolate and throws typed.
   */
  private compileValidator(source: string): CachedValidator {
    const isolate = new ivm.Isolate({ memoryLimit: this.memoryLimitMb });
    try {
      const context = isolate.createContextSync();
      const wrapper = [
        'const __module = { exports: {} };',
        '(function(module, exports) {',
        source,
        '})(__module, __module.exports);',
        'globalThis.__validate = __module.exports.validate;',
      ].join('\n');
      isolate.compileScriptSync(wrapper).runSync(context, { timeout: this.timeoutMs });
      return { isolate, context };
    } catch (error) {
      try {
        isolate.dispose();
      } catch {
        // Best-effort disposal on the failure path.
      }
      throw classifyError(error);
    }
  }
}
