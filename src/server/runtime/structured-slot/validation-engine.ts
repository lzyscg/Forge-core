/**
 * Validator Gate accounting engine (Task 8 Step 5).
 *
 * Implements the per-Gate validator execution model of spec §10 / design
 * §14.3-§14.5 + §25.4 E03/E05:
 *
 * - each Gate resolves the applicable `(validatorId, logicalTarget)` pairs in
 *   a STABLE order (sort by validatorId, then target);
 * - before any sandbox starts, the declared CPU / invocation / wall totals are
 *   preflighted against `limits.validation`; a plan overage executes ZERO
 *   validators and returns `RESOURCE_LIMIT_EXCEEDED` + an `incomplete` verdict;
 * - execution is strictly serial; after every call the actual CPU, validator-
 *   phase wall clock, serialized output bytes and internal issue count are
 *   stream-measured; any aggregate overage stops the remaining validators →
 *   `incomplete` + `truncated: true` (truncation is never interpreted as pass);
 * - enforcement only controls the severity of a RELIABLE rejection: blocking
 *   `pass:false` → VALIDATOR_REJECTED error (failed), advisory `pass:false` →
 *   VALIDATOR_ADVISORY warning (passes through); ANY execution incompleteness
 *   (compile/exception/timeout/memory/invalid return) → `incomplete`
 *   regardless of enforcement;
 * - Seal always evaluates ALL applicable registrations; Merge re-runs the
 *   affected scope conservatively (scaffold validators always run, even on a
 *   no-op merge); Structure Gate applies no template validators;
 * - narrow GateIssues are adapted to StructuredIssueV1 through the Task 1
 *   registry (makeStructuredIssue) with the correct codes and phases
 *   (merge / seal_input) and locations (slot / operation per registry).
 *
 * Every Gate returns `{ verdict, usage }`; `usage` carries the actual
 * invocations / CPU / wall / output / issue counts for the Attempt meter
 * (Task 11). This module carries zero business vocabulary.
 */
import { performance } from 'node:perf_hooks';
import type {
  IssueLocation,
  JsonObject,
  JsonValue,
  StructuredIssueV1,
  StructuredVerdictV1,
} from '../../../shared/structured-slots';
import { makeStructuredIssue } from '../../structured-slots/issues';
import type {
  FrozenStructuredSlotContractV1,
  SlotTargetSelectorV1,
  ValidatorRegistrationV1,
} from '../../template/structured-slot-contract';
import type { CorePaths } from '../../storage/core-paths';
import type { GateIssue } from '../isolated-sandbox';
import {
  buildValidatorEnvelope,
  EvaluatorRunner,
  type EvaluatorLogicalTarget,
  type EvaluatorSlotProjection,
  type EvaluatorTypeDeclaration,
} from './evaluator-runner';

/** The three Gate kinds this engine runs. */
export type ValidatorGateKind = 'structure' | 'merge' | 'seal_input';

/** One slot as the Gate caller presents it (the engine derives projections). */
export interface GateSlotInput {
  slotId: string;
  parentSlotId: string | null;
  order: number;
  typeId: string;
  spec: JsonObject;
  contentPresence: 'unset' | 'set';
  content: JsonValue;
}

export interface ValidatorGateInput {
  taskId: string;
  contract: FrozenStructuredSlotContractV1;
  /** The full scaffold in document (pre-order) order. */
  slots: readonly GateSlotInput[];
  /** Merge only: slot ids changed by the overlay; absent/empty = no-op merge. */
  changedSlotIds?: readonly string[];
  signal?: AbortSignal;
}

/** Actual meter of one Gate run (Task 11 Attempt meter input). */
export interface ValidatorGateUsage {
  /** Validator invocations actually executed. */
  invocations: number;
  /** Aggregate actual isolate CPU time (ms). */
  cpuMs: number;
  /** Validator-phase wall clock (ms). */
  wallMs: number;
  /** Aggregate serialized result bytes of the raw returns (pre-normalization). */
  outputBytes: number;
  /** Internal issue count (before any public cap / projection). */
  issueCount: number;
  /** True when the plan overage preflight rejected the Gate before any run. */
  preflightRejected: boolean;
}

export interface ValidatorGateResult {
  verdict: StructuredVerdictV1;
  usage: ValidatorGateUsage;
}

export interface ValidationEngineOptions {
  paths: CorePaths;
}

interface PlannedPair {
  registration: ValidatorRegistrationV1;
  target: EvaluatorLogicalTarget;
}

function appliesToGate(registration: ValidatorRegistrationV1, gate: ValidatorGateKind): boolean {
  if (gate === 'structure') return false;
  if (registration.trigger === 'seal') return gate === 'seal_input';
  // trigger 'merge-and-seal'
  return gate === 'merge' || gate === 'seal_input';
}

function matchesSelector(selector: SlotTargetSelectorV1, slot: GateSlotInput): boolean {
  switch (selector.kind) {
    case 'all':
      return true;
    case 'root':
      return slot.parentSlotId === null;
    case 'types':
      return selector.typeIds.includes(slot.typeId);
    default:
      return false;
  }
}

/**
 * Resolves the applicable `(validatorId, logicalTarget)` pairs in STABLE
 * order: sort by validatorId, then target (scaffold sorts before slot ids).
 * Structure Gate applies no template validators (structure checks are schema/
 * grammar — separate domains). Merge re-runs changed slots plus (for subtree
 * scope) their ancestors; scaffold-scope validators always run. Seal runs
 * every applicable slot/subtree target and the scaffold.
 */
function resolveApplicablePairs(
  contract: FrozenStructuredSlotContractV1,
  gate: ValidatorGateKind,
  slots: readonly GateSlotInput[],
  changedSlotIds: readonly string[] | undefined,
): PlannedPair[] {
  if (gate === 'structure') {
    return [];
  }
  const slotMap = new Map(slots.map((s) => [s.slotId, s]));
  const pairs: PlannedPair[] = [];
  for (const registration of contract.validators) {
    if (!appliesToGate(registration, gate)) {
      continue;
    }
    if (registration.scope === 'scaffold') {
      pairs.push({ registration, target: { kind: 'scaffold' } });
      continue;
    }
    if (gate === 'merge') {
      const affected = new Set<string>(changedSlotIds ?? []);
      if (registration.scope === 'subtree') {
        for (const id of changedSlotIds ?? []) {
          let parent = slotMap.get(id)?.parentSlotId ?? null;
          while (parent !== null) {
            affected.add(parent);
            parent = slotMap.get(parent)?.parentSlotId ?? null;
          }
        }
      }
      for (const id of affected) {
        const slot = slotMap.get(id);
        if (slot !== undefined && matchesSelector(registration.selector, slot)) {
          pairs.push({ registration, target: { kind: 'slot', slotId: id } });
        }
      }
    } else {
      for (const slot of slots) {
        if (matchesSelector(registration.selector, slot)) {
          pairs.push({ registration, target: { kind: 'slot', slotId: slot.slotId } });
        }
      }
    }
  }
  pairs.sort((a, b) => {
    if (a.registration.id < b.registration.id) return -1;
    if (a.registration.id > b.registration.id) return 1;
    const targetA = a.target.kind === 'scaffold' ? '\u0000' : a.target.slotId;
    const targetB = b.target.kind === 'scaffold' ? '\u0000' : b.target.slotId;
    return targetA < targetB ? -1 : targetA > targetB ? 1 : 0;
  });
  return pairs;
}

/** Derives stable ancestry paths (root → parent, excluding self). */
function buildProjections(slots: readonly GateSlotInput[]): EvaluatorSlotProjection[] {
  const pathMap = new Map<string, string[]>();
  for (const s of slots) {
    if (s.parentSlotId === null) {
      pathMap.set(s.slotId, []);
    } else {
      const parentPath = pathMap.get(s.parentSlotId);
      pathMap.set(s.slotId, parentPath !== undefined ? [...parentPath, s.parentSlotId] : []);
    }
  }
  return slots.map((s) => ({
    slotId: s.slotId,
    parentSlotId: s.parentSlotId,
    order: s.order,
    typeId: s.typeId,
    spec: s.spec,
    contentPresence: s.contentPresence,
    content: s.contentPresence === 'unset' ? null : (s.content ?? null),
    path: pathMap.get(s.slotId) ?? [],
  }));
}

function targetLocation(target: EvaluatorLogicalTarget): IssueLocation {
  if (target.kind === 'slot') {
    return { kind: 'slot', slotId: target.slotId, field: 'node', valuePointer: '' };
  }
  return { kind: 'operation' };
}

function buildVerdict(
  issues: readonly StructuredIssueV1[],
  truncated: boolean,
  incomplete: boolean,
): StructuredVerdictV1 {
  let status: StructuredVerdictV1['status'];
  if (incomplete) {
    status = 'incomplete';
  } else if (issues.some((issue) => issue.severity === 'error')) {
    status = 'failed';
  } else {
    status = 'passed';
  }
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  return {
    version: 1,
    status,
    issues: [...issues],
    truncated,
    summary: { errors, warnings: issues.length - errors },
  };
}

/**
 * Runs one Gate: preflight, serial execution with stream-measured aggregate
 * accounting, and verdict/usage construction.
 */
export class ValidationEngine {
  private readonly paths: CorePaths;

  constructor(options: ValidationEngineOptions) {
    this.paths = options.paths;
  }

  /** Structure Gate: applies no template validators (schema/grammar are elsewhere). */
  runStructureGate(input: ValidatorGateInput): Promise<ValidatorGateResult> {
    return this.runGate(input, 'structure');
  }

  /** Merge Gate: re-runs the affected merge-and-seal validators. */
  runMergeGate(input: ValidatorGateInput): Promise<ValidatorGateResult> {
    return this.runGate(input, 'merge');
  }

  /** Seal Gate: evaluates ALL applicable validators (both triggers). */
  runSealGate(input: ValidatorGateInput): Promise<ValidatorGateResult> {
    return this.runGate(input, 'seal_input');
  }

  private resourceLimitIssue(gate: ValidatorGateKind): StructuredIssueV1 {
    return makeStructuredIssue('RESOURCE_LIMIT_EXCEEDED', gate, { kind: 'operation' }, {});
  }

  private executionFailureIssue(
    gate: 'merge' | 'seal_input',
    registration: ValidatorRegistrationV1,
    target: EvaluatorLogicalTarget,
    code: 'VALIDATOR_UNAVAILABLE' | 'VALIDATOR_RESULT_INVALID',
    reason: string,
  ): StructuredIssueV1 {
    return makeStructuredIssue(code, gate, targetLocation(target), {
      validatorId: registration.id,
      reason,
    });
  }

  private adaptValidatorIssue(
    gate: 'merge' | 'seal_input',
    code: 'VALIDATOR_REJECTED' | 'VALIDATOR_ADVISORY',
    registration: ValidatorRegistrationV1,
    target: EvaluatorLogicalTarget,
    gateIssue: GateIssue,
  ): StructuredIssueV1 {
    const details: JsonObject = { validatorId: registration.id };
    if (typeof gateIssue.evidence === 'string' && gateIssue.evidence.length > 0) {
      details.evidence = gateIssue.evidence.slice(0, 512);
    }
    if (typeof gateIssue.stage === 'string' && gateIssue.stage.length > 0) {
      details.stage = gateIssue.stage.slice(0, 128);
    }
    return makeStructuredIssue(code, gate, targetLocation(target), details);
  }

  private async runGate(
    input: ValidatorGateInput,
    gate: ValidatorGateKind,
  ): Promise<ValidatorGateResult> {
    const { contract, taskId, slots, changedSlotIds, signal } = input;
    const limits = contract.limits.validation;
    const usage: ValidatorGateUsage = {
      invocations: 0,
      cpuMs: 0,
      wallMs: 0,
      outputBytes: 0,
      issueCount: 0,
      preflightRejected: false,
    };

    const pairs = resolveApplicablePairs(contract, gate, slots, changedSlotIds);

    if (signal?.aborted) {
      return { verdict: buildVerdict([], false, true), usage };
    }

    // Preflight declared totals: invocation count and declared aggregate CPU
    // (design §14.5 — count, invocations and aggregate CPU). Wall clock,
    // output bytes and issue counts are not knowable ahead of execution and
    // are enforced at runtime only.
    let plannedCpuMs = 0;
    for (const pair of pairs) {
      plannedCpuMs += pair.registration.budget.cpuMs;
    }
    if (
      pairs.length > limits.maxValidatorInvocationsPerGate ||
      plannedCpuMs > limits.maxAggregateValidatorCpuMsPerGate
    ) {
      usage.preflightRejected = true;
      return {
        verdict: {
          version: 1,
          status: 'incomplete',
          issues: [this.resourceLimitIssue(gate)],
          truncated: false,
          summary: { errors: 1, warnings: 0 },
        },
        usage,
      };
    }

    const runner = new EvaluatorRunner({ paths: this.paths, taskId, limits: contract.limits });
    const typeDeclarations: EvaluatorTypeDeclaration[] = contract.slotTypes.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
    }));
    const projections = buildProjections(slots);

    const issues: StructuredIssueV1[] = [];
    let internalIssueCount = 0;
    let truncated = false;
    let incomplete = false;
    const phaseStart = performance.now();

    for (const pair of pairs) {
      if (signal?.aborted) {
        incomplete = true;
        break;
      }
      const envelope = buildValidatorEnvelope(pair.registration, {
        slots: projections,
        target: pair.target,
        typeDeclarations,
      });
      const result = await runner.runValidator(pair.registration, envelope, signal);
      usage.invocations += 1;

      if (result.kind === 'unavailable' || result.kind === 'resultInvalid') {
        const code =
          result.kind === 'unavailable' ? 'VALIDATOR_UNAVAILABLE' : 'VALIDATOR_RESULT_INVALID';
        issues.push(
          this.executionFailureIssue(gate as 'merge' | 'seal_input', pair.registration, pair.target, code, result.reason),
        );
        internalIssueCount += 1;
        incomplete = true;
        break;
      }

      usage.cpuMs += result.cpuMs;
      usage.outputBytes += result.outputBytes;
      if (result.pass === false) {
        // A reliable rejection is a rejection even when the validator supplied
        // no issue text (issues is optional per the ABI): never fail open on a
        // missing issue list. Blocking → error (failed); advisory → warning.
        const code =
          pair.registration.enforcement === 'blocking' ? 'VALIDATOR_REJECTED' : 'VALIDATOR_ADVISORY';
        const gateIssues = result.issues.length > 0 ? result.issues : [{}];
        for (const gateIssue of gateIssues) {
          issues.push(
            this.adaptValidatorIssue(
              gate as 'merge' | 'seal_input',
              code,
              pair.registration,
              pair.target,
              gateIssue,
            ),
          );
          internalIssueCount += 1;
        }
      } else if (result.issues.length > 0) {
        // A passing validator may still surface informational notes; these are
        // non-blocking advisory warnings.
        for (const gateIssue of result.issues) {
          issues.push(
            this.adaptValidatorIssue(
              gate as 'merge' | 'seal_input',
              'VALIDATOR_ADVISORY',
              pair.registration,
              pair.target,
              gateIssue,
            ),
          );
          internalIssueCount += 1;
        }
      }

      // Stream-measured aggregate overages stop the remaining validators.
      usage.wallMs = performance.now() - phaseStart;
      if (
        usage.cpuMs > limits.maxAggregateValidatorCpuMsPerGate ||
        usage.wallMs > limits.maxAggregateValidatorWallClockMsPerGate ||
        usage.outputBytes > limits.maxValidatorOutputBytesPerGate ||
        usage.invocations > limits.maxValidatorInvocationsPerGate
      ) {
        truncated = true;
        incomplete = true;
        if (issues.length < limits.maxIssuesPerRun) {
          issues.push(this.resourceLimitIssue(gate));
          internalIssueCount += 1;
        }
        break;
      }
      if (issues.length > limits.maxIssuesPerRun) {
        truncated = true;
        incomplete = true;
        issues.length = limits.maxIssuesPerRun;
        break;
      }
    }

    usage.issueCount = internalIssueCount;
    return { verdict: buildVerdict(issues, truncated, incomplete), usage };
  }
}
