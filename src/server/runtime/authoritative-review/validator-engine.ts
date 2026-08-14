/**
 * Task 14 validator engine (spec §12, design §9/§16.3).
 *
 * Executes ONE trigger/phase of allowlisted deterministic validators:
 *
 * - builds the canonical `ValidatorInputEnvelopeV2` for the trigger/phase and
 *   durably materializes it (its own canonical Blob);
 * - resolves ONLY the envelope's referenced refs (the core + selected targets)
 *   and passes the RESOLVED canonical ABI v2 data to each handler — never a
 *   snapshot path, never raw v1 `{pass,issues}` evaluation;
 * - runs the allowlisted builtin in a fresh hardened isolated-vm sandbox
 *   (network/clock/random/task-I/O denied, deterministic Date/Math.random
 *   stripping) with a determinism double-run probe;
 * - normalizes the closed `ValidatorResultV2` output, validates every issue
 *   location/repair target against the selected-snapshot universe and the
 *   trigger matrix, and materializes `ValidationReceiptV2` (blocking/advisory)
 *   or `ValidatorFailureV2` (infrastructure) blobs;
 * - builds one `ValidatorAggregateV2` for the trigger/phase with the frozen
 *   outcome priority infrastructure_failure > blocking_invalid > clear;
 * - advisory invalid becomes warning custody (`ValidationWarningRootV2`),
 *   never a repair plan.
 *
 * AGGREGATE ↔ RECEIPT CYCLE RESOLUTION (documented judgment): the receipt
 * schema carries `validatorAggregateRef` while the aggregate carries the
 * receipt refs. Two content-addressed objects cannot reference each other, so
 * the engine materializes an INTERMEDIATE registration-snapshot aggregate A1
 * (empty outcome refs) first; the receipts bind to A1; then the final warning
 * root and the FINAL aggregate A2 (which references the receipts/failures/
 * warning root) are materialized. Finalizers/Gates consume A2; A1 is kept
 * alive transitively (A2 -> receipts -> A1) and never consumed. The DAG stays
 * acyclic (design §9 pre-validation-core rule).
 */
import type { BlobRefV2, AuthoritativeBlobKindV2 } from '../../../shared/authoritative-review-v2';
import type { ValidatorRegistrationV2 } from '../../template/structured-slot-contract-v2';
import type {
  ValidatorAggregateOutcomeV2,
  ValidatorAggregateV2,
  ValidatorFailureV2,
  ValidatorInputEnvelopeV2,
  ValidatorIssueV2,
  ValidatorTriggerV2,
  ValidationReceiptV2,
  ValidationWarningRootV2,
} from '../../authoritative-review/authority-types';
import { canonicalJsonBytes, canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { AuthoritativeReviewProfileSnapshotV1Body } from '../../structured-slots/authoritative-review-profile';
import { runValidatorV2 } from '../structured-slot/evaluator-runner';
import { builtinSourceOf, isStructuralIssueCode } from './builtin-validators';
import type { ResolvedValidator, ValidatorRegistry } from './validator-registry';

export { VALIDATOR_REGISTRY_INVALID, ValidatorRegistryError } from './validator-registry';

/** Engine reject code shared by every fail-closed path. */
export const VALIDATOR_ENGINE_INVALID = 'VALIDATOR_ENGINE_INVALID';

export function validatorEngineError(reason: string): never {
  throw new Error(`${VALIDATOR_ENGINE_INVALID}: ${reason}`);
}

/** Content-addressable store seam (Task 21 binds the real v2 blob store). */
export interface ValidatorBlobStore {
  put(kind: AuthoritativeBlobKindV2, value: unknown): BlobRefV2;
  resolve(ref: BlobRefV2): unknown | null;
}

/** The legal target identities of the selected snapshot. */
export interface ValidatorTargetUniverse {
  slotIds: readonly string[];
  relationIds: readonly string[];
  mapNodeIds: readonly string[];
  /** seal_output: the artifact digest (location stableTargetId must equal it). */
  artifactDigest: string | null;
}

/** Deterministic execution identity (attempt XOR command, per §9). */
export interface ValidatorExecutionIdentity {
  taskId: string;
  templateSnapshotHash: string;
  workItemId: string;
  attemptId: string | null;
  commandId: string | null;
}

/** Template slot type the engine may enrich targets with (content schemas). */
export interface ValidatorSlotType {
  id: string;
  name: string;
  description: string;
  contentPresence: 'forbidden' | 'optional' | 'required';
  contentSchema: unknown;
}

export interface ValidatorRunRequest {
  trigger: ValidatorTriggerV2;
  executionPhase?: 'batch_commit' | 'plan_finalize';
  identity: ValidatorExecutionIdentity;
  /** The trigger's primary input core ref (envelope branch below). */
  coreRef: BlobRefV2;
  /** Extra refs the envelope branch needs (e.g. proposedMapCoreRef, artifactRef). */
  auxiliaryRefs?: Readonly<Record<string, BlobRefV2>>;
  selectedTargetRefs: readonly BlobRefV2[];
  /** The registrations for this trigger/phase (already phase-filtered). */
  registrations: readonly ValidatorRegistrationV2[];
  /** The selected snapshot's legal target universe. */
  universe: ValidatorTargetUniverse;
  /** Template slot types for schema enrichment. */
  slotTypes?: readonly ValidatorSlotType[];
  /** Caller-supplied trigger-specific data (e.g. assemblerRoutes for seal_output). */
  context?: Readonly<Record<string, unknown>>;
  profile: AuthoritativeReviewProfileSnapshotV1Body;
}

export interface TriggerExecutionResult {
  envelope: ValidatorInputEnvelopeV2;
  envelopeRef: BlobRefV2;
  /** The FINAL aggregate (consumed by finalizers/Gates). */
  aggregate: ValidatorAggregateV2;
  aggregateRef: BlobRefV2;
  warningRoot: ValidationWarningRootV2;
  warningRootRef: BlobRefV2;
  receipts: readonly ValidationReceiptV2[];
  failures: readonly ValidatorFailureV2[];
  validExecutionDigests: readonly string[];
  /** The receipts' validatorAggregateRef (the intermediate snapshot aggregate). */
  receiptAggregateRef: BlobRefV2;
}

/** Failure codes produced by the engine (infrastructure-failure evidence). */
export const VALIDATOR_FAILURE_CODES = {
  REGISTRY_REJECTED: 'REGISTRY_REJECTED',
  HANDLER_SOURCE_MISSING: 'HANDLER_SOURCE_MISSING',
  HANDLER_COMPILE: 'HANDLER_COMPILE',
  HANDLER_TIMEOUT: 'HANDLER_TIMEOUT',
  HANDLER_MEMORY: 'HANDLER_MEMORY',
  HANDLER_RUNTIME: 'HANDLER_RUNTIME',
  OUTPUT_MALFORMED: 'OUTPUT_MALFORMED',
  OUTPUT_BUDGET_EXCEEDED: 'OUTPUT_BUDGET_EXCEEDED',
  INPUT_BUDGET_EXCEEDED: 'INPUT_BUDGET_EXCEEDED',
  TARGET_BUDGET_EXCEEDED: 'TARGET_BUDGET_EXCEEDED',
  INPUT_UNRESOLVABLE: 'INPUT_UNRESOLVABLE',
  TARGET_UNRESOLVABLE: 'TARGET_UNRESOLVABLE',
  ISSUE_TARGET_INVALID: 'ISSUE_TARGET_INVALID',
  NONDETERMINISTIC_RESULT: 'NONDETERMINISTIC_RESULT',
  MISSING_EXECUTION: 'MISSING_EXECUTION',
  DUPLICATE_EXECUTION: 'DUPLICATE_EXECUTION',
} as const;

export type ValidatorFailureCode = (typeof VALIDATOR_FAILURE_CODES)[keyof typeof VALIDATOR_FAILURE_CODES];

/* ------------------------------------------------------------------ */
/* Envelope construction (spec §12 exact branches)                     */
/* ------------------------------------------------------------------ */

export function buildValidatorEnvelopeV2(input: {
  trigger: ValidatorTriggerV2;
  executionPhase?: 'batch_commit' | 'plan_finalize';
  taskId: string;
  templateSnapshotHash: string;
  coreRef: BlobRefV2;
  auxiliaryRefs?: Readonly<Record<string, BlobRefV2>>;
  selectedTargetRefs: readonly BlobRefV2[];
}): ValidatorInputEnvelopeV2 {
  const { trigger, executionPhase, taskId, templateSnapshotHash, coreRef, selectedTargetRefs } = input;
  switch (trigger) {
    case 'map_candidate_commit':
      return { trigger, taskId, templateSnapshotHash, mapCandidateValidationCoreRef: coreRef, selectedTargetRefs };
    case 'map_review_settlement':
      return { trigger, taskId, templateSnapshotHash, mapReviewCoverageCoreRef: coreRef, selectedTargetRefs };
    case 'map_activation': {
      const proposedMapCoreRef = input.auxiliaryRefs?.proposedMapCoreRef;
      if (proposedMapCoreRef === undefined) validatorEngineError('map_activation requires auxiliaryRefs.proposedMapCoreRef');
      return { trigger, taskId, templateSnapshotHash, mapReviewSettlementCoreRef: coreRef, proposedMapCoreRef, selectedTargetRefs };
    }
    case 'content_commit': {
      if (executionPhase !== 'batch_commit' && executionPhase !== 'plan_finalize') {
        validatorEngineError('content_commit requires an explicit executionPhase');
      }
      return { trigger, executionPhase, taskId, templateSnapshotHash, contentValidationCoreRef: coreRef, selectedTargetRefs };
    }
    case 'review_settlement':
      return { trigger, taskId, templateSnapshotHash, contentReviewCoverageCoreRef: coreRef, selectedTargetRefs };
    case 'seal_input':
      return { trigger, taskId, templateSnapshotHash, reviewBundleRef: coreRef, selectedTargetRefs };
    case 'seal_output': {
      const artifactRef = input.auxiliaryRefs?.artifactRef;
      if (artifactRef === undefined) validatorEngineError('seal_output requires auxiliaryRefs.artifactRef');
      return { trigger, taskId, templateSnapshotHash, reviewBundleRef: coreRef, artifactRef, selectedTargetRefs };
    }
  }
}

/** Receipt kind derived from the trigger (spec §9 receipt matrix). */
export function receiptKindOf(trigger: ValidatorTriggerV2): ValidationReceiptV2['receiptKind'] {
  switch (trigger) {
    case 'map_candidate_commit':
      return 'map_build';
    case 'map_review_settlement':
      return 'map_review_settlement';
    case 'map_activation':
      return 'map_activation';
    case 'content_commit':
      return 'generation';
    case 'review_settlement':
      return 'review_settlement';
    case 'seal_input':
      return 'seal_input';
    case 'seal_output':
      return 'seal_output';
  }
}

/** Deterministic registration-set digest (sorted by validatorId). */
export function registrationSetDigestOf(registrations: readonly ValidatorRegistrationV2[]): string {
  const canonical = [...registrations]
    .sort((a, b) => (a.validatorId < b.validatorId ? -1 : a.validatorId > b.validatorId ? 1 : 0))
    .map((r) => ({
      validatorId: r.validatorId,
      handlerKey: r.handlerKey,
      implementationDigest: r.implementationDigest,
      trigger: r.trigger,
      executionPhase: r.executionPhase,
    }));
  return canonicalJsonSha256(canonical);
}

function identityOf(registration: ValidatorRegistrationV2): string {
  return `${registration.handlerKey}:${registration.implementationDigest}:${registration.trigger}:${String(registration.executionPhase)}`;
}

function sortedByValidatorId<T extends { validatorId: string }>(values: readonly T[]): T[] {
  return [...values].sort((a, b) => (a.validatorId < b.validatorId ? -1 : a.validatorId > b.validatorId ? 1 : 0));
}

function sortedRefs(refs: readonly BlobRefV2[]): BlobRefV2[] {
  return [...refs].sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
}

/* ------------------------------------------------------------------ */
/* Core/target resolution + handler input                              */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Core resolution result. `{kind:'ok'}` carries the resolved core data the
 * handlers receive; `{kind:'unresolvable'}` means the trigger's input (or a
 * NESTED referenced input, e.g. the provisional manifest) cannot be resolved —
 * the whole run is an infrastructure failure, never a silent null that would
 * later produce blocking-invalid receipts (M-7).
 */
type CoreResolution = { kind: 'ok'; core: unknown } | { kind: 'unresolvable'; reason: string };

/** Resolves the trigger's core data (deeply for content_commit/plan_finalize). */
function resolveCoreData(
  request: ValidatorRunRequest,
  resolve: (ref: BlobRefV2) => unknown | null,
): CoreResolution {
  const core = resolve(request.coreRef);
  if (core === null || typeof core !== 'object') {
    return { kind: 'unresolvable', reason: 'the trigger core ref is unresolvable' };
  }
  if (request.trigger === 'content_commit') {
    // Case 1: the coreRef points directly at the commit/finalize core.
    if (isPlainObject(core) && isPlainObject(core.provisionalManifestRef) && !isPlainObject(core.contentPlanFinalizeCoreRef)) {
      const manifest = resolve(core.provisionalManifestRef as unknown as BlobRefV2);
      if (manifest === null || typeof manifest !== 'object') {
        return { kind: 'unresolvable', reason: 'the provisional manifest ref is unresolvable' };
      }
      return { kind: 'ok', core: { phase: 'plan_finalize', contentPlanFinalizeCore: core, provisionalManifest: manifest } };
    }
    if (isPlainObject(core) && 'authorizedReplacementEntries' in core) {
      return { kind: 'ok', core: { phase: 'batch_commit', contentRevisionCommitCore: core } };
    }
    // Case 2: the coreRef points at the thin ContentValidationCoreV2 wrapper.
    if (isPlainObject(core) && isPlainObject(core.contentPlanFinalizeCoreRef)) {
      const finalizeCore = resolve(core.contentPlanFinalizeCoreRef as unknown as BlobRefV2);
      if (finalizeCore === null || typeof finalizeCore !== 'object') {
        return { kind: 'unresolvable', reason: 'the plan-finalize core ref is unresolvable' };
      }
      const manifest =
        isPlainObject(finalizeCore) && isPlainObject(finalizeCore.provisionalManifestRef)
          ? resolve(finalizeCore.provisionalManifestRef as unknown as BlobRefV2)
          : null;
      if (isPlainObject(finalizeCore) && isPlainObject(finalizeCore.provisionalManifestRef) && (manifest === null || typeof manifest !== 'object')) {
        return { kind: 'unresolvable', reason: 'the provisional manifest ref is unresolvable' };
      }
      return { kind: 'ok', core: { phase: 'plan_finalize', contentPlanFinalizeCore: finalizeCore, provisionalManifest: manifest } };
    }
    if (isPlainObject(core) && isPlainObject(core.contentRevisionCommitCoreRef)) {
      const commitCore = resolve(core.contentRevisionCommitCoreRef as unknown as BlobRefV2);
      if (commitCore === null || typeof commitCore !== 'object') {
        return { kind: 'unresolvable', reason: 'the content commit core ref is unresolvable' };
      }
      return { kind: 'ok', core: { phase: 'batch_commit', contentRevisionCommitCore: commitCore } };
    }
    return { kind: 'ok', core };
  }
  if (request.trigger === 'map_activation') {
    const proposed = request.auxiliaryRefs?.proposedMapCoreRef;
    const proposedCore = proposed === undefined ? null : resolve(proposed);
    if (proposed !== undefined && (proposedCore === null || typeof proposedCore !== 'object')) {
      return { kind: 'unresolvable', reason: 'the proposed map core ref is unresolvable' };
    }
    return { kind: 'ok', core: { settlementCore: core, proposedMapCore: proposedCore } };
  }
  return { kind: 'ok', core };
}

/** Resolves each selected target (ref + data kept paired) and enriches schemas. */
function resolveTargets(
  request: ValidatorRunRequest,
  resolve: (ref: BlobRefV2) => unknown | null,
): { resolved: Array<{ ref: BlobRefV2; data: unknown }>; missing: readonly BlobRefV2[] } {
  const typeById = new Map<string, ValidatorSlotType>();
  for (const slotType of request.slotTypes ?? []) {
    typeById.set(slotType.id, slotType);
  }
  const resolved: Array<{ ref: BlobRefV2; data: unknown }> = [];
  const missing: BlobRefV2[] = [];
  for (const ref of request.selectedTargetRefs) {
    const data = resolve(ref);
    if (data === null) {
      missing.push(ref);
      continue;
    }
    if (isPlainObject(data)) {
      const type = typeof data.typeId === 'string' ? typeById.get(data.typeId) : undefined;
      resolved.push({
        ref,
        data: {
          ...data,
          ...(type !== undefined
            ? { contentSchema: type.contentSchema, contentPresence: data.contentPresence ?? type.contentPresence }
            : {}),
        },
      });
    } else {
      resolved.push({ ref, data });
    }
  }
  return { resolved, missing };
}

/**
 * Applies a registration's frozen selector (design §9: selection is frozen by
 * trigger + executionPhase + selector): `{kind:'all'}` passes every resolved
 * target; `{kind:'types', typeIds}` narrows to the targets whose type identity
 * matches. The target DATA must carry the type identity (the engine enriches
 * content targets with the template slot type by `typeId`); a types-selector
 * over targets without a resolvable type identity yields no targets (fail
 * closed — never validates a wrong-type target). Task 21 wiring seam: the
 * per-target `typeId` is attached to the resolved target data here; a real
 * blob store resolver must keep `typeId` on the content version/value objects.
 */
function applySelector(
  selector: ValidatorRegistrationV2['selector'],
  resolved: ReadonlyArray<{ ref: BlobRefV2; data: unknown }>,
): { targets: readonly unknown[]; refs: readonly BlobRefV2[] } {
  if (selector.kind === 'all') {
    return { targets: resolved.map((entry) => entry.data), refs: resolved.map((entry) => entry.ref) };
  }
  const typeIds = new Set(selector.typeIds);
  const targets: unknown[] = [];
  const refs: BlobRefV2[] = [];
  for (const entry of resolved) {
    const typeId = isPlainObject(entry.data) ? (entry.data.typeId as unknown) : undefined;
    if (typeof typeId === 'string' && typeIds.has(typeId)) {
      targets.push(entry.data);
      refs.push(entry.ref);
    }
  }
  return { targets, refs };
}

/* ------------------------------------------------------------------ */
/* Handler output normalization + issue validation                     */
/* ------------------------------------------------------------------ */

export interface NormalizedIssue extends ValidatorIssueV2 {}

type NormalizedOutput =
  | { status: 'valid' }
  | { status: 'domain_invalid'; issues: readonly NormalizedIssue[] };

type ParseOutput =
  | { kind: 'ok'; output: NormalizedOutput; substantiveDigest: string }
  | { kind: 'invalid'; reason: string };

function parseHandlerOutput(
  raw: unknown,
  registration: ValidatorRegistrationV2,
  inputDigest: string,
  budgetIssues: number,
): ParseOutput {
  if (!isPlainObject(raw)) return { kind: 'invalid', reason: 'handler output must be a plain object' };
  const keys = Object.keys(raw);
  const status = raw.status;
  if (status !== 'valid' && status !== 'domain_invalid') {
    return { kind: 'invalid', reason: 'handler output status must be valid|domain_invalid' };
  }
  if (status === 'valid') {
    if (keys.length !== 2 || !keys.includes('status') || !keys.includes('executionDigest')) {
      return { kind: 'invalid', reason: 'valid output must be exactly { status, executionDigest }' };
    }
    if (typeof raw.executionDigest !== 'string') {
      return { kind: 'invalid', reason: 'valid output executionDigest must be a string' };
    }
    return {
      kind: 'ok',
      output: { status: 'valid' },
      substantiveDigest: executionDigestOf(registration, inputDigest, { status: 'valid' }),
    };
  }
  if (keys.length !== 3 || !keys.includes('status') || !keys.includes('issues') || !keys.includes('executionDigest')) {
    return { kind: 'invalid', reason: 'domain_invalid output must be exactly { status, issues, executionDigest }' };
  }
  if (typeof raw.executionDigest !== 'string') {
    return { kind: 'invalid', reason: 'domain_invalid output executionDigest must be a string' };
  }
  if (!Array.isArray(raw.issues) || raw.issues.length === 0) {
    return { kind: 'invalid', reason: 'domain_invalid output must carry at least one issue' };
  }
  if (raw.issues.length > budgetIssues) {
    return { kind: 'invalid', reason: `output carries more issues than the budget maxIssues (${budgetIssues})` };
  }
  const issues: NormalizedIssue[] = [];
  for (const entry of raw.issues) {
    const parsed = parseHandlerIssue(entry, registration);
    if (typeof parsed === 'string') return { kind: 'invalid', reason: parsed };
    issues.push(parsed);
  }
  return {
    kind: 'ok',
    output: { status: 'domain_invalid', issues },
    substantiveDigest: executionDigestOf(registration, inputDigest, { status: 'domain_invalid', issues }),
  };
}

/**
 * Deterministic execution identity (spec §9): the canonical digest binds the
 * handler identity, the input digest and the normalized substantive result.
 * Including the handler identity keeps two different valid handlers on one
 * trigger/phase DISTINCT (the aggregate's `validExecutionDigests` must stay
 * strictly sorted — M-3).
 */
function executionDigestOf(
  registration: ValidatorRegistrationV2,
  inputDigest: string,
  output: { status: 'valid' } | { status: 'domain_invalid'; issues: readonly NormalizedIssue[] },
): string {
  return canonicalJsonSha256({
    validatorId: registration.validatorId,
    handlerKey: registration.handlerKey,
    implementationDigest: registration.implementationDigest,
    inputDigest,
    output,
  });
}

function parseHandlerIssue(entry: unknown, registration: ValidatorRegistrationV2): NormalizedIssue | string {
  if (!isPlainObject(entry)) return 'an issue must be a plain object';
  const expected = ['validatorId', 'implementationDigest', 'issueCode', 'location', 'repairTargets', 'evidenceDigest'];
  const keys = Object.keys(entry);
  if (keys.length !== expected.length || expected.some((k) => !keys.includes(k))) {
    return 'an issue must carry exactly validatorId/implementationDigest/issueCode/location/repairTargets/evidenceDigest';
  }
  if (entry.validatorId !== registration.validatorId) {
    return 'an issue validatorId must equal the executing validator (spoof rejected)';
  }
  if (entry.implementationDigest !== registration.implementationDigest) {
    return 'an issue implementationDigest must equal the executing validator (spoof rejected)';
  }
  if (typeof entry.issueCode !== 'string' || entry.issueCode.length === 0) {
    return 'an issue issueCode must be a non-empty string';
  }
  const location = entry.location;
  if (!isPlainObject(location)) return 'an issue location must be a plain object';
  const locationKeys = Object.keys(location);
  if (locationKeys.length !== 3 || !['targetKind', 'stableTargetId', 'jsonPointer'].every((k) => locationKeys.includes(k))) {
    return 'an issue location must carry exactly targetKind/stableTargetId/jsonPointer';
  }
  if (typeof location.targetKind !== 'string' || location.targetKind.length === 0) {
    return 'an issue location.targetKind must be a non-empty string';
  }
  if (typeof location.stableTargetId !== 'string' || location.stableTargetId.length === 0) {
    return 'an issue location.stableTargetId must be a non-empty string';
  }
  if (location.jsonPointer !== null && typeof location.jsonPointer !== 'string') {
    return 'an issue location.jsonPointer must be a string or null';
  }
  const rt = entry.repairTargets;
  if (!isPlainObject(rt)) return 'an issue repairTargets must be a plain object';
  const rtKeys = Object.keys(rt);
  if (rtKeys.length !== 3 || !['mapNodeIds', 'relationIds', 'slotIds'].every((k) => rtKeys.includes(k))) {
    return 'an issue repairTargets must carry exactly mapNodeIds/relationIds/slotIds';
  }
  if (!Array.isArray(rt.mapNodeIds) || rt.mapNodeIds.some((v) => typeof v !== 'string')) {
    return 'an issue repairTargets.mapNodeIds must be an array of strings';
  }
  if (!Array.isArray(rt.relationIds) || rt.relationIds.some((v) => typeof v !== 'string')) {
    return 'an issue repairTargets.relationIds must be an array of strings';
  }
  if (!Array.isArray(rt.slotIds) || rt.slotIds.some((v) => typeof v !== 'string')) {
    return 'an issue repairTargets.slotIds must be an array of strings';
  }
  const normalized: NormalizedIssue = {
    validatorId: registration.validatorId,
    implementationDigest: registration.implementationDigest,
    issueCode: entry.issueCode,
    location: {
      targetKind: location.targetKind,
      stableTargetId: location.stableTargetId,
      jsonPointer: location.jsonPointer,
    },
    repairTargets: {
      mapNodeIds: [...rt.mapNodeIds],
      relationIds: [...rt.relationIds],
      slotIds: [...rt.slotIds],
    },
    evidenceDigest: '',
  };
  // The sandbox has no hashing primitive; the engine computes the evidence
  // digest deterministically over the issue's substantive fields.
  normalized.evidenceDigest = canonicalJsonSha256({
    issueCode: normalized.issueCode,
    location: normalized.location,
    repairTargets: normalized.repairTargets,
  });
  return normalized;
}

/** Trigger/target matrix validation (spec §12 / design §9 table). */
export function validateIssueTargets(
  trigger: ValidatorTriggerV2,
  issue: NormalizedIssue,
  universe: ValidatorTargetUniverse,
): string | null {
  const { targetKind, stableTargetId } = issue.location;
  const rt = issue.repairTargets;
  const inUniverse =
    (targetKind === 'slot' && universe.slotIds.includes(stableTargetId)) ||
    (targetKind === 'relation' && universe.relationIds.includes(stableTargetId)) ||
    (targetKind === 'node' && universe.mapNodeIds.includes(stableTargetId));
  const repairTargetsInUniverse =
    rt.slotIds.every((id) => universe.slotIds.includes(id)) &&
    rt.relationIds.every((id) => universe.relationIds.includes(id)) &&
    rt.mapNodeIds.every((id) => universe.mapNodeIds.includes(id));

  if (trigger === 'seal_output') {
    if (targetKind !== 'artifact') return 'seal_output issues must target the artifact';
    if (stableTargetId !== (universe.artifactDigest ?? '')) return 'seal_output stableTargetId must equal the artifact digest';
    if (rt.mapNodeIds.length > 0 || rt.relationIds.length > 0 || rt.slotIds.length > 0) {
      return 'seal_output issues must carry empty repair targets';
    }
    return null;
  }
  if (trigger === 'seal_input') {
    if (!inUniverse) return 'target outside the selected snapshot';
    if (rt.mapNodeIds.length === 0 && rt.relationIds.length === 0 && rt.slotIds.length === 0) {
      return 'seal_input issues must carry a reachable repair target';
    }
    if (!repairTargetsInUniverse) return 'repair target outside the selected snapshot';
    return null;
  }
  const isMapTrigger = ['map_candidate_commit', 'map_review_settlement', 'map_activation'].includes(trigger);
  if (isMapTrigger && targetKind === 'slot' && !isStructuralIssueCode(issue.issueCode)) {
    return 'map triggers must target a node or relation';
  }
  // Candidate-level STRUCTURAL findings (missing identities use the ordinal
  // sentinel `#node-<i>` etc.) are legal locations about the candidate's own
  // structure — the universe check is skipped, the repair targets still must be
  // snapshot-valid.
  const structural = isStructuralIssueCode(issue.issueCode);
  if (!structural && !inUniverse) return 'target outside the selected snapshot';
  if (isMapTrigger && !structural && rt.slotIds.length > 0) return 'map triggers must not carry slot repair targets';
  if (!repairTargetsInUniverse) return 'repair target outside the selected snapshot';
  return null;
}

/* ------------------------------------------------------------------ */
/* The engine                                                          */
/* ------------------------------------------------------------------ */

export class ValidatorEngine {
  private readonly registry: ValidatorRegistry;
  private readonly blobs: ValidatorBlobStore;
  private readonly sourceResolver: (handlerKey: string) => string | null;

  constructor(deps: {
    registry: ValidatorRegistry;
    blobs: ValidatorBlobStore;
    /** Test seam: override the installed handler source (defaults to builtins). */
    sourceResolver?: (handlerKey: string) => string | null;
  }) {
    this.registry = deps.registry;
    this.blobs = deps.blobs;
    this.sourceResolver = deps.sourceResolver ?? builtinSourceOf;
  }

  private put(kind: AuthoritativeBlobKindV2, value: unknown): BlobRefV2 {
    return this.blobs.put(kind, value);
  }

  private resolve(ref: BlobRefV2): unknown | null {
    return this.blobs.resolve(ref);
  }

  /** Executes ONE trigger/phase and returns the aggregate + custody refs. */
  async execute(request: ValidatorRunRequest): Promise<TriggerExecutionResult> {
    const phase = request.executionPhase ?? null;
    const envelope = buildValidatorEnvelopeV2({
      trigger: request.trigger,
      executionPhase: request.executionPhase,
      taskId: request.identity.taskId,
      templateSnapshotHash: request.identity.templateSnapshotHash,
      coreRef: request.coreRef,
      auxiliaryRefs: request.auxiliaryRefs,
      selectedTargetRefs: request.selectedTargetRefs,
    });
    const envelopeRef = this.put('validator_input_envelope', envelope);

    const coreResolution = resolveCoreData(request, (ref) => this.resolve(ref));
    const { resolved: resolvedTargets, missing } = resolveTargets(request, (ref) => this.resolve(ref));

    const inputDigest = envelopeRef.digest;
    const failures: ValidatorFailureV2[] = [];
    const blockingReceipts: ValidationReceiptV2[] = [];
    const advisoryReceipts: ValidationReceiptV2[] = [];
    const validExecutionDigests: string[] = [];
    const handled = new Set<string>();
    const seenIdentity = new Set<string>();

    const sortedRegistrations = sortedByValidatorId(request.registrations);

    for (const registration of sortedRegistrations) {
      const identity = identityOf(registration);
      // Phase routing is frozen per trigger/phase (spec §6.5): a registration
      // whose trigger/phase does not match the request never runs.
      if (registration.trigger !== request.trigger) {
        failures.push(this.failure(request, envelopeRef, registration, VALIDATOR_FAILURE_CODES.REGISTRY_REJECTED, `registration trigger ${registration.trigger} does not match the request trigger ${request.trigger}`));
        handled.add(registration.validatorId);
        continue;
      }
      if ((registration.executionPhase ?? null) !== phase) {
        failures.push(this.failure(request, envelopeRef, registration, VALIDATOR_FAILURE_CODES.REGISTRY_REJECTED, `registration executionPhase does not match the request phase`));
        handled.add(registration.validatorId);
        continue;
      }
      let resolved: ResolvedValidator;
      try {
        resolved = this.registry.resolve(registration, request.profile);
      } catch (error) {
        failures.push(this.failure(request, envelopeRef, registration, VALIDATOR_FAILURE_CODES.REGISTRY_REJECTED, error instanceof Error ? error.message : String(error)));
        handled.add(registration.validatorId);
        continue;
      }
      if (seenIdentity.has(identity)) {
        failures.push(this.failure(request, envelopeRef, registration, VALIDATOR_FAILURE_CODES.DUPLICATE_EXECUTION, `duplicate execution identity ${identity}`));
        handled.add(registration.validatorId);
        continue;
      }
      seenIdentity.add(identity);
      handled.add(registration.validatorId);

      const budget = resolved.budget;
      // The registration's frozen selector (design §9) narrows the targets
      // BEFORE any budget check: {kind:'all'} passes every resolved target;
      // {kind:'types', typeIds} passes only the matching type identities.
      const { targets, refs: selectedRefs } = applySelector(registration.selector, resolvedTargets);
      if (selectedRefs.length > budget.maxSelectedTargets) {
        failures.push(this.failure(request, envelopeRef, registration, VALIDATOR_FAILURE_CODES.TARGET_BUDGET_EXCEEDED, `selected targets exceed the budget maxSelectedTargets ${budget.maxSelectedTargets}`));
        continue;
      }
      if (missing.length > 0) {
        failures.push(this.failure(request, envelopeRef, registration, VALIDATOR_FAILURE_CODES.TARGET_UNRESOLVABLE, `selected target refs are unresolvable: ${missing.map((r) => r.digest).join(',')}`));
        continue;
      }
      if (coreResolution.kind === 'unresolvable') {
        failures.push(this.failure(request, envelopeRef, registration, VALIDATOR_FAILURE_CODES.INPUT_UNRESOLVABLE, coreResolution.reason));
        continue;
      }

      const handlerInput = this.buildHandlerInput(request, resolved, envelope, envelopeRef, coreResolution.core, targets);
      let inputBytes: number;
      try {
        inputBytes = canonicalJsonBytes(handlerInput).length;
      } catch {
        failures.push(this.failure(request, envelopeRef, registration, VALIDATOR_FAILURE_CODES.INPUT_BUDGET_EXCEEDED, 'handler input is not canonical JSON'));
        continue;
      }
      if (inputBytes > budget.maxInputBytes) {
        failures.push(this.failure(request, envelopeRef, registration, VALIDATOR_FAILURE_CODES.INPUT_BUDGET_EXCEEDED, `handler input exceeds the budget maxInputBytes ${budget.maxInputBytes}`));
        continue;
      }

      const execution = await this.executeHandler(request, envelopeRef, registration, resolved, handlerInput, budget, inputDigest);
      if (execution.kind === 'failure') {
        failures.push(execution.failure);
        continue;
      }
      if (execution.kind === 'valid') {
        validExecutionDigests.push(execution.executionDigest);
        continue;
      }
      // domain_invalid: validate the trigger/target matrix before any receipt.
      let violation: string | null = null;
      for (const issue of execution.issues) {
        violation = validateIssueTargets(request.trigger, issue, request.universe);
        if (violation !== null) break;
      }
      if (violation !== null) {
        failures.push(this.failure(request, envelopeRef, registration, VALIDATOR_FAILURE_CODES.ISSUE_TARGET_INVALID, violation));
        continue;
      }
      const receipt = this.buildReceipt(request, registration, resolved, envelopeRef, execution.issues);
      if (registration.enforcement === 'blocking') blockingReceipts.push(receipt);
      else advisoryReceipts.push(receipt);
    }

    // Coverage check: every registration in the set must be handled.
    for (const registration of sortedRegistrations) {
      if (!handled.has(registration.validatorId)) {
        failures.push(this.failure(request, envelopeRef, registration, VALIDATOR_FAILURE_CODES.MISSING_EXECUTION, `registration ${registration.validatorId} had no execution`));
      }
    }

    // Materialize failures (they carry no aggregate backlink — free).
    const failureRefs = failures.map((failure) => this.put('validator_failure', failure));

    // Intermediate registration-snapshot aggregate A1 + empty warning root.
    const emptyWarningRoot = this.buildWarningRoot(request, envelopeRef, []);
    const emptyWarningRootRef = this.put('validation_warning_root', emptyWarningRoot);
    const intermediate = this.buildAggregate(
      request,
      envelopeRef,
      inputDigest,
      sortedRegistrations,
      [],
      [],
      [],
      [],
      emptyWarningRootRef,
    );
    const receiptAggregateRef = this.put('validator_aggregate', intermediate);

    // Fill the receipts' A1 backlink, compute their self-digests, materialize.
    const blockingRefs = blockingReceipts.map((receipt) => {
      receipt.validatorAggregateRef = receiptAggregateRef;
      receipt.receiptDigest = this.receiptDigestOf(receipt);
      return this.put('validation_receipt', receipt);
    });
    const advisoryRefs = advisoryReceipts.map((receipt) => {
      receipt.validatorAggregateRef = receiptAggregateRef;
      receipt.receiptDigest = this.receiptDigestOf(receipt);
      return this.put('validation_receipt', receipt);
    });

    // Warning custody (advisory only; never a repair plan).
    const warningRoot = this.buildWarningRoot(request, envelopeRef, sortedRefs(advisoryRefs));
    const warningRootRef = this.put('validation_warning_root', warningRoot);

    // FINAL aggregate (consumed by finalizers/Gates).
    const aggregate = this.buildAggregate(
      request,
      envelopeRef,
      inputDigest,
      sortedRegistrations,
      validExecutionDigests,
      sortedRefs(blockingRefs),
      sortedRefs(advisoryRefs),
      sortedRefs(failureRefs),
      warningRootRef,
    );
    const aggregateRef = this.put('validator_aggregate', aggregate);

    return {
      envelope,
      envelopeRef,
      aggregate,
      aggregateRef,
      warningRoot,
      warningRootRef,
      receipts: [...blockingReceipts, ...advisoryReceipts],
      failures,
      validExecutionDigests,
      receiptAggregateRef,
    };
  }

  private receiptDigestOf(receipt: ValidationReceiptV2): string {
    return canonicalJsonSha256({
      receiptKind: receipt.receiptKind,
      validatorAggregateRef: receipt.validatorAggregateRef,
      blockerIssues: receipt.blockerIssues,
      lineageRefs: receipt.lineageRefs,
    });
  }

  private buildHandlerInput(
    request: ValidatorRunRequest,
    resolved: ResolvedValidator,
    envelope: ValidatorInputEnvelopeV2,
    envelopeRef: BlobRefV2,
    core: unknown,
    targets: readonly unknown[],
  ): unknown {
    const context: Record<string, unknown> = { ...(request.context ?? {}) };
    if (request.trigger === 'seal_output') {
      const artifactRef = request.auxiliaryRefs?.artifactRef;
      if (artifactRef !== undefined) {
        // The engine passes the artifact REF metadata (media type/digest), never
        // the artifact content bytes; the assembler route identity comes from
        // the caller (context.artifactRouteId).
        context.artifactMediaType = artifactRef.mediaType;
      }
      if (request.universe.artifactDigest !== null) {
        context.artifactDigest = request.universe.artifactDigest;
      }
    }
    return {
      version: 2,
      abi: 'forge-validator/v2',
      validatorId: resolved.registration.validatorId,
      implementationDigest: resolved.registration.implementationDigest,
      handlerKey: resolved.entry.handlerKey,
      trigger: request.trigger,
      executionPhase: request.executionPhase ?? null,
      enforcement: resolved.registration.enforcement,
      inputDigest: envelopeRef.digest,
      envelope,
      core,
      targets,
      context,
      template: {
        slotTypes: (request.slotTypes ?? []).map((slotType) => ({
          id: slotType.id,
          name: slotType.name,
          description: slotType.description,
          contentPresence: slotType.contentPresence,
          contentSchema: slotType.contentSchema,
        })),
      },
    };
  }

  private failure(
    request: ValidatorRunRequest,
    envelopeRef: BlobRefV2,
    registration: ValidatorRegistrationV2,
    failureCode: string,
    reason: string,
  ): ValidatorFailureV2 {
    const attemptId = request.identity.attemptId;
    const commandId = request.identity.commandId;
    if ((attemptId === null) === (commandId === null)) {
      validatorEngineError('a validator execution must carry exactly one of attemptId | commandId');
    }
    const failure: ValidatorFailureV2 = {
      validatorId: registration.validatorId,
      handlerKey: registration.handlerKey,
      implementationDigest: registration.implementationDigest,
      executionId: `${registration.validatorId}:${failureCode}:${canonicalJsonSha256(reason)}`,
      inputRef: envelopeRef,
      inputDigest: envelopeRef.digest,
      failureCode,
      failureDigest: '',
      workItemId: request.identity.workItemId,
      attemptId,
      commandId,
    };
    failure.failureDigest = canonicalJsonSha256({
      validatorId: failure.validatorId,
      handlerKey: failure.handlerKey,
      implementationDigest: failure.implementationDigest,
      executionId: failure.executionId,
      inputDigest: failure.inputDigest,
      failureCode: failure.failureCode,
      reason,
      workItemId: failure.workItemId,
      attemptId: failure.attemptId,
      commandId: failure.commandId,
    });
    return failure;
  }

  private buildReceipt(
    request: ValidatorRunRequest,
    registration: ValidatorRegistrationV2,
    resolved: ResolvedValidator,
    envelopeRef: BlobRefV2,
    issues: readonly NormalizedIssue[],
  ): ValidationReceiptV2 {
    const lineage: Array<{ label: string; ref: BlobRefV2 }> = [
      { label: 'core', ref: request.coreRef },
      { label: 'envelope', ref: envelopeRef },
    ];
    for (const key of Object.keys(request.auxiliaryRefs ?? {}).sort()) {
      lineage.push({ label: `aux.${key}`, ref: (request.auxiliaryRefs as Record<string, BlobRefV2>)[key]! });
    }
    request.selectedTargetRefs.forEach((ref, index) => {
      lineage.push({ label: `target.${String(index).padStart(6, '0')}`, ref });
    });
    lineage.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    return {
      receiptKind: receiptKindOf(request.trigger),
      // Filled after the intermediate aggregate exists (cycle resolution).
      validatorAggregateRef: (undefined as unknown) as BlobRefV2,
      blockerIssues: [...issues],
      lineageRefs: lineage,
      receiptDigest: '',
    };
  }

  private buildWarningRoot(
    request: ValidatorRunRequest,
    envelopeRef: BlobRefV2,
    advisoryReceiptRefs: readonly BlobRefV2[],
  ): ValidationWarningRootV2 {
    const refs = sortedRefs(advisoryReceiptRefs);
    const root: ValidationWarningRootV2 = {
      trigger: request.trigger,
      executionPhase: request.executionPhase ?? null,
      inputRef: envelopeRef,
      inputDigest: envelopeRef.digest,
      orderedAdvisoryReceiptRefs: refs,
      warningCount: refs.length,
      rootDigest: '',
    };
    root.rootDigest = canonicalJsonSha256({
      trigger: root.trigger,
      executionPhase: root.executionPhase,
      inputRef: root.inputRef,
      inputDigest: root.inputDigest,
      orderedAdvisoryReceiptRefs: root.orderedAdvisoryReceiptRefs,
      warningCount: root.warningCount,
    });
    return root;
  }

  private buildAggregate(
    request: ValidatorRunRequest,
    envelopeRef: BlobRefV2,
    inputDigest: string,
    registrations: readonly ValidatorRegistrationV2[],
    validExecutionDigests: readonly string[],
    blockingInvalidReceiptRefs: readonly BlobRefV2[],
    advisoryReceiptRefs: readonly BlobRefV2[],
    infrastructureFailureRefs: readonly BlobRefV2[],
    warningRootRef: BlobRefV2,
  ): ValidatorAggregateV2 {
    const valid = [...new Set(validExecutionDigests)].sort();
    const outcome: ValidatorAggregateOutcomeV2 =
      infrastructureFailureRefs.length > 0
        ? 'infrastructure_failure'
        : blockingInvalidReceiptRefs.length > 0
          ? 'blocking_invalid'
          : 'clear';
    const aggregate: ValidatorAggregateV2 = {
      trigger: request.trigger,
      executionPhase: request.executionPhase ?? null,
      inputRef: envelopeRef,
      inputDigest,
      registrationSetDigest: registrationSetDigestOf(registrations),
      validExecutionDigests: valid,
      blockingInvalidReceiptRefs: sortedRefs(blockingInvalidReceiptRefs),
      advisoryReceiptRefs: sortedRefs(advisoryReceiptRefs),
      infrastructureFailureRefs: sortedRefs(infrastructureFailureRefs),
      warningRootRef,
      aggregateDigest: '',
      outcome,
    };
    aggregate.aggregateDigest = canonicalJsonSha256({
      trigger: aggregate.trigger,
      executionPhase: aggregate.executionPhase,
      inputRef: aggregate.inputRef,
      inputDigest: aggregate.inputDigest,
      registrationSetDigest: aggregate.registrationSetDigest,
      validExecutionDigests: aggregate.validExecutionDigests,
      blockingInvalidReceiptRefs: aggregate.blockingInvalidReceiptRefs,
      advisoryReceiptRefs: aggregate.advisoryReceiptRefs,
      infrastructureFailureRefs: aggregate.infrastructureFailureRefs,
      warningRootRef: aggregate.warningRootRef,
      outcome: aggregate.outcome,
    });
    return aggregate;
  }

  private async executeHandler(
    request: ValidatorRunRequest,
    envelopeRef: BlobRefV2,
    registration: ValidatorRegistrationV2,
    resolved: ResolvedValidator,
    handlerInput: unknown,
    budget: { maxDurationMs: number; maxMemoryMiB: number; maxOutputBytes: number; maxIssues: number },
    inputDigest: string,
  ): Promise<
    | { kind: 'failure'; failure: ValidatorFailureV2 }
    | { kind: 'valid'; executionDigest: string }
    | { kind: 'domain_invalid'; issues: readonly NormalizedIssue[] }
  > {
    const source = this.sourceResolver(resolved.entry.handlerKey);
    if (source === null) {
      return { kind: 'failure', failure: this.failure(request, envelopeRef, registration, VALIDATOR_FAILURE_CODES.HANDLER_SOURCE_MISSING, 'no installed source for the handler') };
    }
    const outcome = await runValidatorV2({
      source,
      input: handlerInput as Parameters<typeof runValidatorV2>[0]['input'],
      budget: { timeoutMs: budget.maxDurationMs, memoryMiB: budget.maxMemoryMiB },
    });
    if (outcome.kind === 'unavailable') {
      return { kind: 'failure', failure: this.failure(request, envelopeRef, registration, unavailableFailureCode(outcome.reason), unavailableReason(outcome.reason)) };
    }
    if (outcome.kind === 'resultInvalid') {
      return { kind: 'failure', failure: this.failure(request, envelopeRef, registration, VALIDATOR_FAILURE_CODES.OUTPUT_MALFORMED, outcome.reason) };
    }
    if (!outcome.deterministic) {
      return { kind: 'failure', failure: this.failure(request, envelopeRef, registration, VALIDATOR_FAILURE_CODES.NONDETERMINISTIC_RESULT, 'two runs of the handler produced different canonical results') };
    }
    if (outcome.outputBytes > budget.maxOutputBytes) {
      return { kind: 'failure', failure: this.failure(request, envelopeRef, registration, VALIDATOR_FAILURE_CODES.OUTPUT_BUDGET_EXCEEDED, `handler output exceeds the budget maxOutputBytes ${budget.maxOutputBytes}`) };
    }
    const parsed = parseHandlerOutput(outcome.raw, registration, inputDigest, budget.maxIssues);
    if (parsed.kind === 'invalid') {
      return { kind: 'failure', failure: this.failure(request, envelopeRef, registration, VALIDATOR_FAILURE_CODES.OUTPUT_MALFORMED, parsed.reason) };
    }
    if (parsed.output.status === 'valid') {
      return { kind: 'valid', executionDigest: parsed.substantiveDigest };
    }
    return { kind: 'domain_invalid', issues: parsed.output.issues };
  }
}

function unavailableFailureCode(reason: string): string {
  switch (reason) {
    case 'compile':
      return VALIDATOR_FAILURE_CODES.HANDLER_COMPILE;
    case 'timeout':
      return VALIDATOR_FAILURE_CODES.HANDLER_TIMEOUT;
    case 'memory':
      return VALIDATOR_FAILURE_CODES.HANDLER_MEMORY;
    case 'input':
      return VALIDATOR_FAILURE_CODES.INPUT_BUDGET_EXCEEDED;
    case 'aborted':
    case 'runtime':
    case 'source':
    default:
      return VALIDATOR_FAILURE_CODES.HANDLER_RUNTIME;
  }
}

function unavailableReason(reason: string): string {
  return `handler execution unavailable (${reason})`;
}

/** Canonical ordering helper re-exported for DAG tests. */
export const canonicalSortRefs = sortedRefs;
