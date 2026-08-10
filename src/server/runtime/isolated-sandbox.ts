/**
 * Shared isolated-vm sandbox primitive (Task 8 Step 4).
 *
 * The sandbox creation/call mechanics formerly private to GateRunner live
 * here so both the legacy template gates (GateRunner) and the structured
 * validator/Assembler ABI (evaluator-runner) share one execution core:
 *
 * - a CommonJS-style module wrapped in an IIFE (module/exports stubs) whose
 *   named export is bound to a global (e.g. `validate` → `__validate`);
 * - per-isolate memory ceiling and CPU timeout on every compile and call;
 * - typed, stable failure classification (timeout / compile / memory /
 *   runtime) that each caller maps to its own codes;
 * - `hardened` mode for the structured ABI: nondeterministic APIs are
 *   stripped or frozen (fixed Date, deterministic Math.random, Intl and
 *   locale-sensitive formatting removed, Math/Date frozen) and the global
 *   object is frozen so a validator can neither observe wall-clock/randomness
 *   nor mutate its environment.
 *
 * A timed-out or memory-killed isolate is disposed; `dispose()` is safe to
 * call more than once. This module carries zero business vocabulary.
 */
import ivm from 'isolated-vm';

/** Stable sandbox-level failure codes (callers map these to their own codes). */
export const SANDBOX_ERROR_CODES = {
  /** The script exceeded its CPU budget. */
  SANDBOX_TIMEOUT: 'SANDBOX_TIMEOUT',
  /** The module could not be compiled (syntax / wrapper error). */
  SANDBOX_COMPILE_FAILED: 'SANDBOX_COMPILE_FAILED',
  /** The isolate hit its memory ceiling and was disposed. */
  SANDBOX_MEMORY_LIMIT: 'SANDBOX_MEMORY_LIMIT',
  /** Any other runtime failure inside the isolate. */
  SANDBOX_RUNTIME_ERROR: 'SANDBOX_RUNTIME_ERROR',
} as const;

export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[keyof typeof SANDBOX_ERROR_CODES];

/** Typed, non-retryable sandbox failure with a stable machine code. */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, message: string) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
  }
}

/** One validator issue; only the three optional string keys are kept. */
export interface GateIssue {
  stage?: string;
  evidence?: string;
  scope?: string;
}

/** Keeps only stage/evidence/scope; drops other keys; coerces non-strings. */
export function normalizeGateIssue(value: unknown): GateIssue {
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

/** Normalizes an array of validator-supplied issues to the narrow shape. */
export function normalizeGateIssues(values: unknown): GateIssue[] {
  if (!Array.isArray(values)) {
    throw new SandboxError(SANDBOX_ERROR_CODES.SANDBOX_RUNTIME_ERROR, 'issues must be an array');
  }
  return values.map(normalizeGateIssue);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Script execution timed out');
}

function isMemoryLimit(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('memory limit') || error.message.includes('Array buffer allocation failed'))
  );
}

function classifyCompileError(error: unknown): SandboxError {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  if (isTimeout(error)) {
    return new SandboxError(SANDBOX_ERROR_CODES.SANDBOX_TIMEOUT, message);
  }
  if (isMemoryLimit(error)) {
    return new SandboxError(SANDBOX_ERROR_CODES.SANDBOX_MEMORY_LIMIT, message);
  }
  if (name === 'SyntaxError' || message.includes('SyntaxError')) {
    return new SandboxError(SANDBOX_ERROR_CODES.SANDBOX_COMPILE_FAILED, message);
  }
  return new SandboxError(SANDBOX_ERROR_CODES.SANDBOX_RUNTIME_ERROR, message);
}

function classifyCallError(error: unknown): SandboxError {
  const message = error instanceof Error ? error.message : String(error);
  if (isTimeout(error)) {
    return new SandboxError(SANDBOX_ERROR_CODES.SANDBOX_TIMEOUT, message);
  }
  if (isMemoryLimit(error)) {
    return new SandboxError(SANDBOX_ERROR_CODES.SANDBOX_MEMORY_LIMIT, message);
  }
  return new SandboxError(SANDBOX_ERROR_CODES.SANDBOX_RUNTIME_ERROR, message);
}

export interface SandboxCompileOptions {
  /** Per-isolate memory ceiling (MiB). */
  memoryLimitMb: number;
  /** CPU time budget for the module compile + top-level body (ms). */
  timeoutMs: number;
  /**
   * Structured ABI hardening: freeze the global object, strip/freeze
   * nondeterministic APIs (Date, Math.random, Intl, locale formatting).
   * GateRunner keeps `hardened: false` so its observable behavior is
   * unchanged.
   */
  hardened: boolean;
  /** The named function on `module.exports` to expose as a global. */
  exportName: string;
  /** The global name to bind the exposed function to. */
  globalName: string;
}

/** A compiled, callable isolate; dispose releases it (idempotent). */
export interface CompiledSandbox {
  /**
   * Run a call script with the given CPU budget. Returns the copied value
   * (a plain data object) or throws a typed SandboxError. A timed-out or
   * memory-killed isolate is disposed by the isolate itself; callers must
   * still call dispose() (safe to do so).
   */
  call(callSource: string, timeoutMs: number): unknown;
  /** Total CPU time consumed by the isolate (nanoseconds, isolated-vm). */
  cpuTimeNs(): bigint;
  dispose(): void;
}

/** Nondeterministic-API stripping preamble for the hardened ABI. */
const HARDEN_SCRIPT = `
const __RealDate = Date;
const __FixedNow = 1700000000000;
let __Seed = 42;
const __Random = () => {
  __Seed = (__Seed * 1664525 + 1013904223) % 4294967296;
  return __Seed / 4294967296;
};
Math.random = __Random;
globalThis.Date = class {
  constructor(...args) {
    if (args.length === 0) return new __RealDate(__FixedNow);
    return new __RealDate(...args);
  }
  static now() { return __FixedNow; }
  static parse(s) { return __RealDate.parse(s); }
  static UTC(...args) { return __RealDate.UTC(...args); }
};
delete globalThis.Intl;
Number.prototype.toLocaleString = function () { return String(this); };
BigInt.prototype.toLocaleString = function () { return String(this); };
String.prototype.toLocaleLowerCase = function () { return this.toLowerCase(); };
String.prototype.toLocaleUpperCase = function () { return this.toUpperCase(); };
Object.freeze(Math);
Object.freeze(globalThis.Date);
`;

/**
 * Compiles a CommonJS-style module into a fresh isolate.
 *
 * For the hardened ABI the nondeterminism strip runs before the module body,
 * so even top-level `Date`/`Math.random` use is deterministic, and the global
 * object is frozen after the module export is bound. Any compile failure
 * (syntax error, wrapper throw, top-level loop, memory overrun) disposes the
 * isolate and throws a typed SandboxError.
 */
export function compileModuleSandbox(source: string, options: SandboxCompileOptions): CompiledSandbox {
  const isolate = new ivm.Isolate({ memoryLimit: options.memoryLimitMb });
  const wrapper = [
    options.hardened ? HARDEN_SCRIPT : '',
    'const __module = { exports: {} };',
    '(function(module, exports) {',
    source,
    '})(__module, __module.exports);',
    `globalThis.${options.globalName} = __module.exports.${options.exportName};`,
    options.hardened ? 'Object.freeze(globalThis);' : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
  try {
    const context = isolate.createContextSync();
    isolate.compileScriptSync(wrapper).runSync(context, { timeout: options.timeoutMs });
    return {
      call(callSource: string, timeoutMs: number): unknown {
        try {
          return isolate.compileScriptSync(callSource).runSync(context, { timeout: timeoutMs, copy: true });
        } catch (error) {
          throw classifyCallError(error);
        }
      },
      cpuTimeNs(): bigint {
        return isolate.cpuTime;
      },
      dispose(): void {
        try {
          isolate.dispose();
        } catch {
          // Disposal is best-effort; the isolate is memory-only and may
          // already have been disposed by a memory-limit termination.
        }
      },
    };
  } catch (error) {
    try {
      isolate.dispose();
    } catch {
      // Best-effort disposal on the failure path.
    }
    throw classifyCompileError(error);
  }
}
