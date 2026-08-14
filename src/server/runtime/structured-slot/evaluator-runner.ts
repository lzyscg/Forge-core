/**
 * Structured validator + Assembler sandbox ABI (Task 8 Step 1/5/6).
 *
 * The structured ABI runs template-owned sources inside an isolated, frozen,
 * nondeterminism-stripped isolate (design §25.4 E02/E04/E05, spec §10). The
 * input is a fixed, read-only canonical JSON envelope built from the call
 * args (type/spec/content/tree projection scoped to the validator's scope,
 * template declarations, stable logical positions — never host paths, Grants,
 * Agent, events, secrets or service handles). The platform builds the
 * envelope; this module only serializes it deterministically and never trusts
 * the sandbox's return beyond the narrow `{pass, issues}` /
 * `{routeId, content}[]` contracts.
 *
 * Failure classification is a typed, stable discriminated union:
 *   - unavailable   → VALIDATOR_UNAVAILABLE / ASSEMBLER_UNAVAILABLE
 *                    (source unread, compile, exception, timeout, memory,
 *                    aborted, input unserializable);
 *   - resultInvalid → VALIDATOR_RESULT_INVALID / ASSEMBLER_RESULT_INVALID
 *                    (contract violations in the returned value).
 *
 * Every call runs in a fresh isolate (serial model): the timed-out/memory-
 * killed isolate is disposed and never reused, so peak memory stays bounded by
 * the largest single-call budget plus the bounded result accumulator.
 * Serialized result bytes are measured from the canonical serialization of
 * the raw return BEFORE normalization, so the Gate engine can enforce the
 * per-Gate output budget on the untrusted, unnormalized payload.
 *
 * The implementation source is read ONLY from the task snapshot with the same
 * static + realpath containment discipline as GateRunner, and is cached per
 * logical path (the snapshot is immutable). No business vocabulary.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { JsonObject, JsonValue, StructuredSlotLimitsV1 } from '../../../shared/structured-slots';
import type { AssemblerRegistrationV1, ValidatorRegistrationV1 } from '../../template/structured-slot-contract';
import { canonicalJson, canonicalJsonBytes } from '../../structured-slots/canonical-json';
import type { CorePaths } from '../../storage/core-paths';
import {
  compileModuleSandbox,
  normalizeGateIssues,
  SandboxError,
  SANDBOX_ERROR_CODES,
  type CompiledSandbox,
  type GateIssue,
} from '../isolated-sandbox';

/** One slot projection handed to the evaluator (stable, host-path-free). */
export interface EvaluatorSlotProjection {
  slotId: string;
  parentSlotId: string | null;
  order: number;
  typeId: string;
  spec: JsonObject;
  contentPresence: 'unset' | 'set';
  content: JsonValue;
  /** Stable logical position: ancestor slot ids from the root (excluding self). */
  path: string[];
}

/** Minimal template declaration the ABI may expose (design E02). */
export interface EvaluatorTypeDeclaration {
  id: string;
  name: string;
  description: string;
}

/** The stable logical target of one validator invocation. */
export type EvaluatorLogicalTarget = { kind: 'slot'; slotId: string } | { kind: 'scaffold' };

/** Successful validator run: narrow verdict + measured usage. */
export interface ValidatorOkResult {
  kind: 'ok';
  pass: boolean;
  issues: GateIssue[];
  /** UTF-8 bytes of the canonical serialization of the raw return (pre-normalization). */
  outputBytes: number;
  /** Actual isolate CPU time consumed by this call (ms). */
  cpuMs: number;
  /** Wall time of this call (ms). */
  wallMs: number;
}

/** One produced artifact file; the platform fills path/mediaType/producer. */
export interface AssemblerFileResult {
  routeId: string;
  content: string;
}

/** Successful assembler run: exact declared-route coverage. */
export interface AssemblerOkResult {
  kind: 'ok';
  files: AssemblerFileResult[];
  /** Total UTF-8 bytes of produced content. */
  outputBytes: number;
  cpuMs: number;
  wallMs: number;
}

/** Execution could not complete (source/compile/exception/timeout/memory/aborted). */
export interface EvaluatorUnavailable {
  kind: 'unavailable';
  reason: 'source' | 'compile' | 'runtime' | 'timeout' | 'memory' | 'aborted' | 'input';
}

/** The sandbox returned a value violating the narrow ABI contract. */
export interface EvaluatorResultInvalid {
  kind: 'resultInvalid';
  reason: string;
}

export type EvaluatorFailure = EvaluatorUnavailable | EvaluatorResultInvalid;
export type ValidatorResult = ValidatorOkResult | EvaluatorFailure;
export type AssemblerResult = AssemblerOkResult | EvaluatorFailure;

export interface EvaluatorRunnerOptions {
  paths: CorePaths;
  taskId: string;
  limits: StructuredSlotLimitsV1;
}

/**
 * Reads a snapshot-relative resource with the same static + realpath
 * containment discipline as GateRunner; returns null when unreadable.
 */
async function readSnapshotResource(
  paths: CorePaths,
  taskId: string,
  logicalPath: string,
): Promise<string | null> {
  const snapshotRoot = paths.taskSnapshotRoot(taskId);
  if (isAbsolute(logicalPath) || logicalPath.includes('\0')) {
    return null;
  }
  const resolved = resolve(snapshotRoot, logicalPath);
  if (resolved !== snapshotRoot && !resolved.startsWith(snapshotRoot + sep)) {
    return null;
  }
  let real: string;
  let realRoot: string;
  try {
    real = await realpath(resolved);
    realRoot = await realpath(snapshotRoot);
  } catch {
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    return null;
  }
  try {
    const fileStat = await stat(real);
    if (!fileStat.isFile()) {
      return null;
    }
    return await readFile(real, 'utf8');
  } catch {
    return null;
  }
}

function compileReason(error: unknown): EvaluatorUnavailable['reason'] {
  if (error instanceof SandboxError) {
    if (error.code === SANDBOX_ERROR_CODES.SANDBOX_TIMEOUT) return 'timeout';
    if (error.code === SANDBOX_ERROR_CODES.SANDBOX_MEMORY_LIMIT) return 'memory';
  }
  return 'compile';
}

function callReason(error: unknown): EvaluatorUnavailable['reason'] {
  if (error instanceof SandboxError) {
    if (error.code === SANDBOX_ERROR_CODES.SANDBOX_TIMEOUT) return 'timeout';
    if (error.code === SANDBOX_ERROR_CODES.SANDBOX_MEMORY_LIMIT) return 'memory';
  }
  return 'runtime';
}

/** Narrow validator verdict: boolean pass + normalized issues, or a reason. */
function normalizeValidatorVerdict(raw: unknown): { pass: boolean; issues: GateIssue[] } | string {
  if (typeof raw !== 'object' || raw === null) {
    return 'validator return must be a plain object';
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.pass !== 'boolean') {
    return 'validator return pass must be a boolean';
  }
  let issues: GateIssue[] = [];
  if (record.issues !== undefined) {
    if (!Array.isArray(record.issues)) {
      return 'validator return issues must be an array';
    }
    issues = normalizeGateIssues(record.issues);
  }
  return { pass: record.pass, issues };
}

/** Valid UTF-8 string: rejects lone surrogates that cannot round-trip. */
function isValidUtf8(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Assembler result validation (design E06/E07): returns files or a reason. */
function validateAssemblerResult(
  raw: unknown,
  registration: AssemblerRegistrationV1,
  limits: StructuredSlotLimitsV1,
): { files: AssemblerFileResult[]; outputBytes: number } | string {
  if (!Array.isArray(raw)) {
    return 'assembler return must be an array of { routeId, content }';
  }
  if (raw.length > limits.output.maxArtifactFiles) {
    return 'assembler returned more files than limits.output.maxArtifactFiles';
  }
  const declared = new Set(registration.routes.map((r) => r.id));
  const seen = new Set<string>();
  const files: AssemblerFileResult[] = [];
  let totalBytes = 0;
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return 'assembler returned a non-object entry';
    }
    const keys = Object.keys(item);
    // The platform NEVER accepts path/mediaType/producer/required from the
    // sandbox: only the exact two control-free fields are legal.
    if (keys.length !== 2 || !keys.includes('routeId') || !keys.includes('content')) {
      return 'assembler entry must be exactly { routeId, content }';
    }
    const record = item as Record<string, unknown>;
    const routeId = record['routeId'];
    const content = record['content'];
    if (typeof routeId !== 'string' || routeId.length === 0) {
      return 'assembler routeId must be a non-empty string';
    }
    if (typeof content !== 'string') {
      return 'assembler content must be a UTF-8 string';
    }
    if (seen.has(routeId)) {
      return `assembler route id duplicated: ${routeId}`;
    }
    seen.add(routeId);
    if (!declared.has(routeId)) {
      return `assembler returned an undeclared route id: ${routeId}`;
    }
    if (!isValidUtf8(content)) {
      return `assembler content for route '${routeId}' is not valid UTF-8`;
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > limits.output.maxArtifactBytesPerFile) {
      return `assembler content for route '${routeId}' exceeds limits.output.maxArtifactBytesPerFile`;
    }
    totalBytes += bytes;
    files.push({ routeId, content });
  }
  if (totalBytes > limits.output.maxTotalArtifactBytes) {
    return 'assembler content exceeds limits.output.maxTotalArtifactBytes';
  }
  if (seen.size !== declared.size) {
    return 'assembler did not cover every declared route exactly once';
  }
  return { files, outputBytes: totalBytes };
}

function findType(
  typeDeclarations: readonly EvaluatorTypeDeclaration[],
  typeId: string,
): EvaluatorTypeDeclaration | null {
  for (const t of typeDeclarations) {
    if (t.id === typeId) return t;
  }
  return null;
}

/** Renders a template declaration as a plain JSON object for the envelope. */
function typeToJson(t: EvaluatorTypeDeclaration): { id: string; name: string; description: string } {
  return { id: t.id, name: t.name, description: t.description };
}

/** The target slot plus all of its descendants (subtree scope projection). */
function subtreeProjection(
  slots: readonly EvaluatorSlotProjection[],
  targetSlot: EvaluatorSlotProjection,
): EvaluatorSlotProjection[] {
  const children = new Map<string, EvaluatorSlotProjection[]>();
  for (const slot of slots) {
    if (slot.parentSlotId !== null) {
      const bucket = children.get(slot.parentSlotId) ?? [];
      bucket.push(slot);
      children.set(slot.parentSlotId, bucket);
    }
  }
  const out: EvaluatorSlotProjection[] = [];
  const queue: EvaluatorSlotProjection[] = [targetSlot];
  while (queue.length > 0) {
    const current = queue.shift() as EvaluatorSlotProjection;
    out.push(current);
    const kids = children.get(current.slotId);
    if (kids !== undefined) {
      for (const kid of kids) queue.push(kid);
    }
  }
  return out;
}

function projectNode(n: EvaluatorSlotProjection): Record<string, JsonValue> {
  return {
    slotId: n.slotId,
    parentSlotId: n.parentSlotId,
    order: n.order,
    typeId: n.typeId,
    spec: n.spec,
    contentPresence: n.contentPresence,
    content: n.contentPresence === 'unset' ? null : n.content,
    path: n.path,
  };
}

/**
 * Builds the fixed canonical JSON envelope for one validator invocation
 * (design E02): only the scope-scoped projection, necessary template
 * declarations and stable logical positions.
 */
export function buildValidatorEnvelope(
  registration: ValidatorRegistrationV1,
  options: {
    slots: readonly EvaluatorSlotProjection[];
    target: EvaluatorLogicalTarget;
    typeDeclarations: readonly EvaluatorTypeDeclaration[];
  },
): JsonObject {
  const { slots, target, typeDeclarations } = options;
  const byId = new Map(slots.map((s) => [s.slotId, s]));
  const targetSlot = target.kind === 'slot' ? (byId.get(target.slotId) ?? null) : null;

  let tree: readonly EvaluatorSlotProjection[];
  if (target.kind === 'slot' && targetSlot !== null) {
    tree = registration.scope === 'subtree' ? subtreeProjection(slots, targetSlot) : [targetSlot];
  } else {
    tree = slots;
  }

  const typeIdsPresent = [...new Set(tree.map((n) => n.typeId))].sort();
  const templateTypes = typeDeclarations
    .filter((t) => typeIdsPresent.includes(t.id))
    .map(typeToJson);
  const targetType =
    targetSlot !== null ? findType(typeDeclarations, targetSlot.typeId) ?? null : null;

  return {
    version: 1,
    abi: 'forge-validator/v1',
    validatorId: registration.id,
    scope: registration.scope,
    target:
      target.kind === 'slot'
        ? { kind: 'slot', slotId: target.slotId, path: targetSlot?.path ?? [] }
        : { kind: 'scaffold', path: [] },
    type: targetType !== null ? typeToJson(targetType) : null,
    spec: targetSlot?.spec ?? null,
    contentPresence: targetSlot?.contentPresence ?? null,
    content: targetSlot !== null && targetSlot.contentPresence === 'set' ? targetSlot.content : null,
    tree: tree.map(projectNode),
    template: { slotTypes: templateTypes },
  };
}

/** Builds the fixed canonical JSON envelope for the assembler (design E06). */
export function buildAssemblerEnvelope(
  assembler: AssemblerRegistrationV1,
  options: {
    slots: readonly EvaluatorSlotProjection[];
    typeDeclarations: readonly EvaluatorTypeDeclaration[];
  },
): JsonObject {
  const { slots, typeDeclarations } = options;
  const typeIdsPresent = [...new Set(slots.map((s) => s.typeId))].sort();
  return {
    version: 1,
    abi: 'forge-assembler/v1',
    assemblerId: assembler.id,
    routes: assembler.routes.map((r) => r.id),
    tree: slots.map(projectNode),
    template: {
      slotTypes: typeDeclarations.filter((t) => typeIdsPresent.includes(t.id)).map(typeToJson),
    },
  };
}

/**
 * Runs validator and assembler sources for one task snapshot in serial,
 * fresh-isolate execution (v1 strictly serial; peak memory bounded by the
 * largest single-call budget).
 */
export class EvaluatorRunner {
  private readonly paths: CorePaths;

  private readonly taskId: string;

  private readonly limits: StructuredSlotLimitsV1;

  private readonly sourceCache = new Map<string, Promise<string | null>>();

  constructor(options: EvaluatorRunnerOptions) {
    this.paths = options.paths;
    this.taskId = options.taskId;
    this.limits = options.limits;
  }

  /** Reads (and caches) one snapshot resource with full containment. */
  private readSource(logicalPath: string): Promise<string | null> {
    let entry = this.sourceCache.get(logicalPath);
    if (entry === undefined) {
      entry = readSnapshotResource(this.paths, this.taskId, logicalPath);
      this.sourceCache.set(logicalPath, entry);
    }
    return entry;
  }

  /**
   * Runs one validator against its canonical envelope. Returns a typed,
   * stable result — never throws. Execution failures (source/compile/
   * exception/timeout/memory/aborted) → unavailable; contract violations in
   * the return → resultInvalid.
   */
  async runValidator(
    registration: ValidatorRegistrationV1,
    canonicalInput: JsonObject,
    signal?: AbortSignal,
  ): Promise<ValidatorResult> {
    if (signal?.aborted) {
      return { kind: 'unavailable', reason: 'aborted' };
    }
    const source = await this.readSource(registration.implementation.path);
    if (source === null) {
      return { kind: 'unavailable', reason: 'source' };
    }
    let inputJson: string;
    try {
      inputJson = canonicalJson(canonicalInput);
    } catch {
      return { kind: 'unavailable', reason: 'input' };
    }

    let sandbox: CompiledSandbox;
    try {
      sandbox = compileModuleSandbox(source, {
        memoryLimitMb: registration.budget.memoryMiB,
        timeoutMs: registration.budget.timeoutMs,
        hardened: true,
        exportName: 'validate',
        globalName: '__validate',
      });
    } catch (error) {
      return { kind: 'unavailable', reason: compileReason(error) };
    }
    try {
      const cpuBefore = Number(sandbox.cpuTimeNs());
      const wallBefore = performance.now();
      let raw: unknown;
      try {
        raw = sandbox.call(`__validate(${inputJson})`, registration.budget.timeoutMs);
      } catch (error) {
        return { kind: 'unavailable', reason: callReason(error) };
      }
      const cpuMs = (Number(sandbox.cpuTimeNs()) - cpuBefore) / 1_000_000;
      const wallMs = performance.now() - wallBefore;

      // Measure serialized bytes of the RAW return BEFORE normalization.
      let outputBytes: number;
      try {
        outputBytes = canonicalJsonBytes(raw).length;
      } catch {
        return { kind: 'resultInvalid', reason: 'return value is not canonical JSON' };
      }
      const verdict = normalizeValidatorVerdict(raw);
      if (typeof verdict === 'string') {
        return { kind: 'resultInvalid', reason: verdict };
      }
      return {
        kind: 'ok',
        pass: verdict.pass,
        issues: verdict.issues,
        outputBytes,
        cpuMs,
        wallMs,
      };
    } finally {
      sandbox.dispose();
    }
  }

  /**
   * Runs the assembler against its canonical envelope and validates the
   * returned `{routeId, content}[]`: unique declared route ids, valid UTF-8
   * content, exact declared-route coverage with no extra routes and no
   * control fields, per-file and total artifact byte limits.
   */
  async runAssembler(
    registration: AssemblerRegistrationV1,
    canonicalInput: JsonObject,
    signal?: AbortSignal,
  ): Promise<AssemblerResult> {
    if (signal?.aborted) {
      return { kind: 'unavailable', reason: 'aborted' };
    }
    const source = await this.readSource(registration.implementation.path);
    if (source === null) {
      return { kind: 'unavailable', reason: 'source' };
    }
    let inputJson: string;
    try {
      inputJson = canonicalJson(canonicalInput);
    } catch {
      return { kind: 'unavailable', reason: 'input' };
    }

    let sandbox: CompiledSandbox;
    try {
      sandbox = compileModuleSandbox(source, {
        memoryLimitMb: registration.budget.memoryMiB,
        timeoutMs: registration.budget.timeoutMs,
        hardened: true,
        exportName: 'assemble',
        globalName: '__assemble',
      });
    } catch (error) {
      return { kind: 'unavailable', reason: compileReason(error) };
    }
    try {
      const cpuBefore = Number(sandbox.cpuTimeNs());
      const wallBefore = performance.now();
      let raw: unknown;
      try {
        raw = sandbox.call(`__assemble(${inputJson})`, registration.budget.timeoutMs);
      } catch (error) {
        return { kind: 'unavailable', reason: callReason(error) };
      }
      const cpuMs = (Number(sandbox.cpuTimeNs()) - cpuBefore) / 1_000_000;
      const wallMs = performance.now() - wallBefore;

      const validated = validateAssemblerResult(raw, registration, this.limits);
      if (typeof validated === 'string') {
        return { kind: 'resultInvalid', reason: validated };
      }
      return {
        kind: 'ok',
        files: validated.files,
        outputBytes: validated.outputBytes,
        cpuMs,
        wallMs,
      };
    } finally {
      sandbox.dispose();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Task 14 v2 evaluator adapter (spec §12/design §9)                   */
/* ------------------------------------------------------------------ */

/**
 * One installed builtin v2 validator execution. The source is INSTALLED
 * platform code (never a snapshot path); the input is the RESOLVED canonical
 * ABI v2 data (the engine already resolved every envelope ref). The closed v2
 * result shape is interpreted by the validator engine — this primitive only
 * runs the allowlisted source in the shared hardened isolate and returns the
 * raw output with a determinism verdict. The v1 `{pass, issues}` interpretation
 * is NEVER reused.
 */
export interface ValidatorV2ExecutionInput {
  source: string;
  input: JsonValue;
  budget: { timeoutMs: number; memoryMiB: number };
  signal?: AbortSignal;
}

/** A successful v2 run: raw output, measured bytes, and the double-run verdict. */
export interface ValidatorV2RawOutcome {
  kind: 'ok';
  /** The RAW return value of the FIRST call (before any v2 normalization). */
  raw: unknown;
  /** UTF-8 bytes of the canonical serialization of the raw return. */
  outputBytes: number;
  /** Two runs in the SAME isolate produced byte-identical raw outputs. */
  deterministic: boolean;
  cpuMs: number;
  wallMs: number;
}

export type ValidatorV2Result = ValidatorV2RawOutcome | EvaluatorUnavailable | EvaluatorResultInvalid;

/**
 * The closed v2 ABI result carries an `executionDigest` that the validator
 * engine OVERRIDES with the engine-computed canonical result digest (the
 * sandbox has no hashing primitive). Determinism therefore compares the
 * SUBSTANTIVE parts (status + issues) with the overridden field stripped —
 * a handler that varies only its claimed executionDigest stays deterministic.
 */
function stripExecutionDigest(raw: unknown): unknown {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = { ...(raw as Record<string, unknown>) };
    delete record.executionDigest;
    return record;
  }
  return raw;
}

/**
 * Runs one allowlisted builtin source twice (fresh isolate, serial double-run
 * inside ONE isolate so module-level state persists) against the resolved ABI
 * v2 input. Reuses the shared hardened isolate creation and per-call budget
 * enforcement; never reads a task snapshot path; never interprets `{pass,
 * issues}`. `deterministic` is false when the two SUBSTANTIVE raw outputs
 * differ — the engine records that as `NONDETERMINISTIC_RESULT`.
 */
export async function runValidatorV2(input: ValidatorV2ExecutionInput): Promise<ValidatorV2Result> {
  if (input.signal?.aborted) {
    return { kind: 'unavailable', reason: 'aborted' };
  }
  let inputJson: string;
  try {
    inputJson = canonicalJson(input.input);
  } catch {
    return { kind: 'unavailable', reason: 'input' };
  }
  let sandbox: CompiledSandbox;
  try {
    sandbox = compileModuleSandbox(input.source, {
      memoryLimitMb: input.budget.memoryMiB,
      timeoutMs: input.budget.timeoutMs,
      hardened: true,
      exportName: 'validate',
      globalName: '__validate',
    });
  } catch (error) {
    return { kind: 'unavailable', reason: compileReason(error) };
  }
  try {
    const cpuBefore = Number(sandbox.cpuTimeNs());
    const wallBefore = performance.now();
    let raw1: unknown;
    let raw2: unknown;
    try {
      raw1 = sandbox.call(`__validate(${inputJson})`, input.budget.timeoutMs);
      // Bound the DOUBLE-RUN to a single budget window: the second determinism
      // probe gets only the remaining CPU budget, so a near-budget handler can
      // never consume 2× maxDurationMs (M-8c).
      const cpuMsAfterFirst = (Number(sandbox.cpuTimeNs()) - cpuBefore) / 1_000_000;
      const secondBudget = Math.max(1, Math.floor(input.budget.timeoutMs - cpuMsAfterFirst));
      raw2 = sandbox.call(`__validate(${inputJson})`, secondBudget);
    } catch (error) {
      return { kind: 'unavailable', reason: callReason(error) };
    }
    const cpuMs = (Number(sandbox.cpuTimeNs()) - cpuBefore) / 1_000_000;
    const wallMs = performance.now() - wallBefore;

    let outputBytes: number;
    try {
      outputBytes = canonicalJsonBytes(raw1).length;
    } catch {
      return { kind: 'resultInvalid', reason: 'return value is not canonical JSON' };
    }
    let substantive1: Buffer;
    let substantive2: Buffer;
    try {
      substantive1 = canonicalJsonBytes(stripExecutionDigest(raw1));
      substantive2 = canonicalJsonBytes(stripExecutionDigest(raw2));
    } catch {
      return { kind: 'resultInvalid', reason: 'return value is not canonical JSON' };
    }
    const deterministic = substantive1.length === substantive2.length && substantive1.equals(substantive2);
    return { kind: 'ok', raw: raw1, outputBytes, deterministic, cpuMs, wallMs };
  } finally {
    sandbox.dispose();
  }
}
