/**
 * Structured Slot Tool factory — the context-bound, platform-closed Slot Tool
 * set (Task 14; design §11.3/§12.2/§12.3, spec §9, O06).
 *
 * Proposal / Draft / Seal use this separate closed tool family, NOT the nine
 * ForgeActions (design §11.3): every tool is bound to the current turn's
 * Grant + session service + Attempt meter, the model supplies NO engineering
 * key (taskId/scaffoldId/draftId/grantId/revision/path/requestId — spec §15),
 * every definition is `executionMode: 'sequential'` (spec §5), and the tool
 * result serializes ONLY the authorized projection or the safe receipt.
 *
 * Precharge semantics (spec §5 / O06): the Pi raw `tool_execution_start` seam
 * (forge-pi-slot-preflight/v1, pi-agent-runtime) precharges EVERY closed Slot
 * Tool call BEFORE SDK argument validation — schema-invalid, unexposed-but-
 * closed-name and truncated calls never reach execute yet still count. The
 * execute callback therefore CONSUMES the existing precharge
 * (`consumeSlotToolPrecharge`) and never charges again; the fill Draft service
 * additionally receives the same consume-only seam so a schema-valid executed
 * call is charged exactly ONCE. The meter's `recordToolResult` is only ever
 * called for a precharged key (no meter bypass).
 *
 * Capability gating (design §10.2 / Task 12 note) lives here: `grant.capabilities`
 * decides which tools are exposed AND executable per session kind; ordinary
 * read-only status queries of the current session (get_structure_proposal,
 * list_slots outline, get_draft_status) are implicitly allowed by the current
 * legitimate slot session (design §10.2), not gated by a fabricated capability.
 *
 * This module carries zero business vocabulary (iron rule 1).
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type Static, type TSchema } from 'typebox';
import { canonicalJsonBytes, canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { STORAGE_ERROR_CODES, StorageError } from '../../storage/atomic-file';
import type {
  JsonValue,
  SealRecord,
  SlotCapabilityV1,
  SlotSessionGrantV1,
  StructuredSlotTreeCursorV1,
  StructuredVerdictV1,
} from '../../../shared/structured-slots';
import type { ForgeAction } from '../forge-actions';
import type { PreparedStructuredVersion } from '../../storage/artifact-store';
import type { StructuredSlotPrivateStore } from '../../storage/structured-slot-private-store';
import type { TaskEvent } from '../../storage/task-events';
import {
  AttemptMeter,
  type AttemptTerminalFailure,
  type SlotToolCallContext,
} from './attempt-meter';
import type { StructuredSlotDraftService } from './draft-service';
import type {
  GetContractResult,
  GetProposalResult,
  PutProposalResult,
  SubmitProposalResult,
  SubmitStructureContext,
  ValidateProposalResult,
  StructuredSlotProposalService,
} from './proposal-service';
import type { StructuredSlotProjectionService } from './projection-service';
import type { StructuredSessionState } from './session-service';

/** The five structure Proposal tools (design §9.1). */
export const STRUCTURE_TOOL_NAMES = [
  'get_structure_contract',
  'put_structure_proposal',
  'get_structure_proposal',
  'validate_structure_proposal',
  'submit_structure_proposal',
] as const;

/** The seven fill Draft tools (design §12.2). */
export const FILL_TOOL_NAMES = [
  'list_slots',
  'read_slot',
  'replace_draft_content',
  'unset_draft_content',
  'validate_draft',
  'submit_draft',
  'get_draft_status',
] as const;

/** The seal tools: request_seal plus the declared read capabilities. */
export const SEAL_TOOL_NAMES = ['request_seal'] as const;

/** The closed global Slot Tool registry (every kind). */
export const SLOT_TOOL_NAMES = [
  ...STRUCTURE_TOOL_NAMES,
  ...FILL_TOOL_NAMES,
  ...SEAL_TOOL_NAMES,
] as const;

export type SlotToolName = (typeof SLOT_TOOL_NAMES)[number];

/** Closed set used by the raw preflight seam (unknown names never count). */
export const SLOT_TOOL_NAME_SET: ReadonlySet<string> = new Set<string>(SLOT_TOOL_NAMES);

/**
 * Platform single-call safe tool-response cap for `read_slot` (design §10.6):
 * content above this limit REJECTS with a stable code instead of returning a
 * truncated body. The per-slot `maxContentBytesPerSlot` is the storage cap;
 * this is the model-facing single-response cap.
 */
export const MAX_SLOT_TOOL_RESPONSE_BYTES = 262_144;

/** Stable code for a read_slot whose content exceeds the single-call cap. */
export const SLOT_READ_RESPONSE_LIMIT = 'SLOT_READ_RESPONSE_LIMIT';

/** Stable code for an execute that reached the closed preflight seam. */
export const NOT_PRECHARGED = 'NOT_PRECHARGED';

/** Stable code for an execute on an externally-stopped/closed attempt. */
export const ATTEMPT_ABORTED = 'ATTEMPT_ABORTED';

/** Stable code when the attempt meter minted a resource terminal. */
export const RESOURCE_LIMIT_EXCEEDED = 'RESOURCE_LIMIT_EXCEEDED';

/**
 * The consume-only precharge gate (spec §5 / O06): verifies the raw
 * pre-validation seam already persisted a charge for the exact
 * `(toolCallId, canonicalArgsHash)` key and checks the composite signal. It
 * NEVER charges, and a missing precharge (meter bypass) fails closed.
 */
/**
 * The consume-only precharge outcome (spec §5 / O06). On `ok` the adapter MUST
 * use the returned `prechargedArgsHash` as the effective metering key: the raw
 * pre-validation seam keyed the precharge by the RAW model args, which Pi 0.82
 * may COERCE during validation (e.g. `123` → `"123"` for a String schema), so
 * the validated hash can differ from the precharged hash. Threading the
 * precharged hash through the service context + result record keeps the meter
 * and the private journal keyed consistently (single charge, free exact
 * replay, no spurious NOT_PRECHARGED).
 */
export type SlotToolConsumeResult =
  | { status: 'ok'; replayed: boolean; prechargedArgsHash: string }
  | { status: 'closed'; failure: AttemptTerminalFailure }
  | { status: 'aborted' }
  | { status: 'not_precharged' };

/**
 * The consume-only precharge gate (spec §5 / O06): verifies the raw
 * pre-validation seam already persisted a charge for the toolCallId and checks
 * the composite signal. It NEVER charges.
 *
 * Pi 0.82 coerces raw args during TypeBox validation (e.g. `123` → `"123"`),
 * so the validated hash can differ from the RAW hash the raw seam precharged.
 * The gate therefore resolves the current call's charge by the raw seam's most
 * recent precharge (`meter.lastPrecharged`): that key is the exact precharge
 * whether it is still pending (fresh call), already recorded (exact replay —
 * the raw seam re-precharged a recorded key without creating a pending entry),
 * or shares the toolCallId with an ORPHANED pending precharge from an earlier
 * schema-invalid/truncated call (the orphan is never consumed). A missing
 * precharge (meter bypass) fails closed.
 */
export async function consumeSlotToolPrecharge(
  meter: AttemptMeter,
  ctx: SlotToolCallContext,
): Promise<SlotToolConsumeResult> {
  if (meter.signal.aborted) {
    // A scheduler stop aborts the composite without minting a terminal; a
    // resource/deadline closure mints one. Only the latter surfaces the
    // terminal failure.
    if (meter.closed && meter.terminalFailure !== null) {
      return { status: 'closed', failure: meter.terminalFailure };
    }
    return { status: 'aborted' };
  }
  const last = meter.lastPrecharged;
  if (last !== null && last.toolCallId === ctx.toolCallId) {
    const entry = meter.toolCalls.find(
      (candidate) =>
        candidate.toolCallId === last.toolCallId &&
        candidate.canonicalArgsHash === last.canonicalArgsHash,
    );
    if (entry !== undefined) {
      return entry.result !== null
        ? { status: 'ok', replayed: true, prechargedArgsHash: last.canonicalArgsHash }
        : { status: 'ok', replayed: false, prechargedArgsHash: last.canonicalArgsHash };
    }
  }
  // No recorded current precharge: fall back to an exact key match (e.g. a
  // direct service call whose precharge is the exact validated key).
  const exact = meter.toolCalls.find(
    (candidate) =>
      candidate.toolCallId === ctx.toolCallId &&
      candidate.canonicalArgsHash === ctx.canonicalArgsHash,
  );
  if (exact !== undefined) {
    return exact.result !== null
      ? { status: 'ok', replayed: true, prechargedArgsHash: exact.canonicalArgsHash }
      : { status: 'ok', replayed: false, prechargedArgsHash: exact.canonicalArgsHash };
  }
  return { status: 'not_precharged' };
}

/** The seal completion dispatch state (design §11.3 matrix). */
export type SealDispatchStateV1 =
  | { status: 'none' }
  | {
      status: 'passed';
      declaredDispatches: Array<'publish_artifact' | 'submit_final_artifact'>;
      /** Turn-bound frozen sealed candidate (Task 16); null = not yet formed. */
      candidate?: SealCandidateV1;
    }
  | {
      status: 'rework_required';
      reworkTarget: string;
      /** Revision-bound rework receipt; null = not yet frozen. */
      receipt?: SealReworkReceiptV1;
    }
  | { status: 'incomplete' };

/**
 * The frozen, turn-bound sealed candidate (design §17.1 step 7): custody is
 * staged, the SealRecord is immutable and NO event has been written. The
 * ActionCommitter promotes the prepared artifact and reveals it in one batch.
 */
export interface SealCandidateV1 {
  sealId: string;
  contentIdentity: string;
  turnId: string;
  scaffoldId: string;
  generationId: string;
  scaffoldRevision: number;
  /** The prepared custody handle (files/meta/SealRecord staged, unreferenced). */
  artifact: PreparedStructuredVersion;
  /** The immutable SealRecord candidate referencing the prepared version. */
  sealRecord: SealRecord;
  /** The result node id the artifact_published event will reference. */
  sourceNodeId: string;
  title: string;
  format: 'markdown' | 'text';
}

/** The revision-bound `seal_rework_required` receipt (not a candidate). */
export interface SealReworkReceiptV1 {
  sealId: string;
  contentIdentity: string;
  turnId: string;
  scaffoldId: string;
  generationId: string;
  scaffoldRevision: number;
  issueSummary: { errors: number; warnings: number };
}

/** Safe seal receipt the model may see after a Seal Gate (design §11.3). */
export interface SealSafeReceiptV1 {
  kind: 'seal';
  status: 'passed' | 'rework_required';
  issueSummary: { errors: number; warnings: number };
}

export type SealRequestResult =
  | { ok: true; receipt: SealSafeReceiptV1; verdict?: StructuredVerdictV1 }
  | { ok: false; code: string; reason: string };

/** Seal-domain operations wired by Task 15/16 (tests inject a stub). */
export interface SealToolOperations {
  requestSeal(grant: Extract<SlotSessionGrantV1, { kind: 'seal' }>, ctx: SlotToolCallContext): Promise<SealRequestResult>;
  dispatch: SealDispatchStateV1;
}

/** The dispatch-guard matrix for the seal completion (design §11.3). */
export type SealGuardResult = { ok: true } | { ok: false; code: string; reason: string };

export function assertSealDispatchAction(state: SealDispatchStateV1, action: ForgeAction): SealGuardResult {
  if (action.type === 'request_human_input') {
    return { ok: true };
  }
  if (state.status === 'passed') {
    if (action.type === 'publish_artifact' || action.type === 'submit_final_artifact') {
      if (state.declaredDispatches.includes(action.type)) {
        return { ok: true };
      }
      return { ok: false, code: 'STRUCTURE_ACTION_NOT_ALLOWED', reason: 'the template did not declare this seal dispatch' };
    }
    return { ok: false, code: 'STRUCTURE_ACTION_NOT_ALLOWED', reason: 'after a passed seal only publish/final submit may dispatch' };
  }
  if (state.status === 'rework_required') {
    if (action.type === 'send_message' && action.targetAgentId === state.reworkTarget) {
      return { ok: true };
    }
    return { ok: false, code: 'STRUCTURE_ACTION_NOT_ALLOWED', reason: 'a reliable seal failure may only send the issue summary to the frozen rework target' };
  }
  // none / incomplete: no completion dispatch at all.
  return { ok: false, code: 'STRUCTURE_ACTION_NOT_ALLOWED', reason: 'the seal session has no completion dispatch yet' };
}

/** Per-kind capability gate: null = implicit read of the current session. */
const STRUCTURE_TOOL_CAPABILITY: Partial<Record<SlotToolName, SlotCapabilityV1 | null>> = {
  get_structure_contract: 'read_structure_contract',
  put_structure_proposal: 'write_structure_proposal',
  get_structure_proposal: null,
  validate_structure_proposal: 'validate_structure_proposal',
  submit_structure_proposal: 'submit_structure_proposal',
};

const FILL_TOOL_CAPABILITY: Partial<Record<SlotToolName, SlotCapabilityV1 | null>> = {
  list_slots: null,
  read_slot: null,
  replace_draft_content: 'write_draft_content',
  unset_draft_content: 'write_draft_content',
  validate_draft: 'validate_draft',
  submit_draft: 'submit_draft',
  get_draft_status: null,
};

/**
 * Per-turn structured slot tool context (Task 14). The production assembler
 * (Task 17) binds the Grant, the session services (constructed with the
 * consume-only precharge seam) and the persistent Attempt meter; tests inject
 * equivalent fakes. The model never sees this object — only the tool results.
 */
export interface StructuredSlotToolContext {
  turnId: string;
  sessionKind: 'structure' | 'fill' | 'seal';
  /** Resolved grant for the session (always present for a formed session). */
  grant: SlotSessionGrantV1;
  /** Current session state (structure/fill); null for seal until Task 17. */
  state: StructuredSessionState | null;
  /** The persistent Attempt meter (raw seam + consume + record). */
  meter: AttemptMeter;
  /** Structure (proposal) domain service. */
  proposalService?: StructuredSlotProposalService;
  /** Fill (draft) domain service — constructed with the consume seam. */
  draftService?: StructuredSlotDraftService;
  /** Private store + events for structure tool-signature idempotency. */
  store?: StructuredSlotPrivateStore;
  events?: () => Promise<readonly TaskEvent[]>;
  /** Structure candidate submit identity (scaffoldId/generationId; Task 17). */
  submitStructureContext?: SubmitStructureContext;
  /** Seal domain operations + dispatch state (Task 15/16; tests inject). */
  seal?: SealToolOperations;
  /** Projection service for the seal read tools. */
  projectionService?: StructuredSlotProjectionService;
  /** Single-call read response limit in bytes (defaults to the platform cap). */
  readResponseLimitBytes?: number;
}

/** Tool result carrying only the authorized projection / safe receipt. */
export interface SlotToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: { accepted: boolean; code?: string };
}

function slotAccepted(payload: unknown, name: string): SlotToolResult {
  return {
    content: [{ type: 'text', text: `${name}: ${JSON.stringify(payload)}` }],
    details: { accepted: true },
  };
}

function slotRejected(code: string, name: string, reason: string): SlotToolResult {
  return {
    content: [{ type: 'text', text: `${name} rejected: ${code} ${reason}` }],
    details: { accepted: false, code },
  };
}

function rejectedResultForCharge(status: Extract<SlotToolConsumeResult, { status: 'closed' | 'aborted' | 'not_precharged' }>, name: string): SlotToolResult {
  if (status.status === 'closed') {
    return slotRejected(RESOURCE_LIMIT_EXCEEDED, name, status.failure.message);
  }
  if (status.status === 'aborted') {
    return slotRejected(ATTEMPT_ABORTED, name, 'the attempt was stopped or closed by the platform');
  }
  return slotRejected(NOT_PRECHARGED, name, 'the tool call was not precharged by the raw pre-validation seam');
}

/** Serializes an authorized slot projection, enforcing the single-call cap. */
function serializeSlotRead(slot: JsonValue, name: string, limitBytes: number): SlotToolResult {
  const content =
    slot !== null && typeof slot === 'object' && !Array.isArray(slot)
      ? (slot as { content?: unknown }).content
      : undefined;
  if (content !== undefined && content !== null) {
    let bytes = 0;
    try {
      bytes = canonicalJsonBytes(content).length;
    } catch {
      bytes = Number.POSITIVE_INFINITY;
    }
    if (bytes > limitBytes) {
      return slotRejected(SLOT_READ_RESPONSE_LIMIT, name, `the slot content exceeds the single-call response limit (${limitBytes} bytes)`);
    }
  }
  return slotAccepted(slot as JsonValue, name);
}

/** Structure tool-signature gate: consume precharge + private-journal replay/conflict. */
type StructureGateResult =
  | { kind: 'ok'; prechargedArgsHash: string }
  | { kind: 'replay'; result: JsonValue }
  | { kind: 'reject'; code: string; reason: string };

async function structureGate(
  ctx: StructuredSlotToolContext,
  proposalId: string,
  toolCallId: string,
  canonicalArgsHash: string,
  toolName: string,
): Promise<StructureGateResult> {
  const precharge = await consumeSlotToolPrecharge(ctx.meter, { toolCallId, canonicalArgsHash, toolName });
  if (precharge.status !== 'ok') {
    return { kind: 'reject', code: rejectedCode(precharge), reason: '' };
  }
  const prechargedArgsHash = precharge.prechargedArgsHash;
  if (ctx.store === undefined || ctx.events === undefined) {
    return { kind: 'reject', code: NOT_PRECHARGED, reason: 'the structure tool adapter is not wired' };
  }
  const view = await ctx.store.readProposal(proposalId, await ctx.events());
  const matching = view.toolRecords.find((record) => record.toolCallId === toolCallId);
  if (matching !== undefined) {
    if (matching.argsHash === prechargedArgsHash) {
      return { kind: 'replay', result: matching.result };
    }
    return { kind: 'reject', code: 'IDEMPOTENCY_CONFLICT', reason: 'the same toolCallId was already used with different arguments' };
  }
  return { kind: 'ok', prechargedArgsHash };
}

function rejectedCode(precharge: Extract<SlotToolConsumeResult, { status: 'closed' | 'aborted' | 'not_precharged' }>): string {
  if (precharge.status === 'closed') return RESOURCE_LIMIT_EXCEEDED;
  if (precharge.status === 'aborted') return ATTEMPT_ABORTED;
  return NOT_PRECHARGED;
}

async function structureRecord(
  ctx: StructuredSlotToolContext,
  proposalId: string,
  toolCallId: string,
  canonicalArgsHash: string,
  toolName: string,
  result: JsonValue,
): Promise<void> {
  if (ctx.store === undefined) return;
  // The meter record is the metering truth and MUST happen for every executed
  // structure tool (exact-replay keying). It comes first so a journal-record
  // failure can never drop it.
  await ctx.meter.recordToolResult({ toolCallId, canonicalArgsHash, result });
  try {
    await ctx.store.recordProposalTool(proposalId, toolCallId, canonicalArgsHash, result);
  } catch (error) {
    // A `submit_structure_proposal` tool result lands AFTER the candidate
    // freezes, which LOCKS the proposal (spec §9.1: candidate ⇒ no more writes).
    // The store rejects the post-lock journal write; the submit itself is
    // already idempotent via submitProposal's candidate replay (design §22.2),
    // so the journal tool record is best-effort. Any OTHER storage failure is
    // still surfaced (fail closed).
    if (!(error instanceof StorageError) || error.code !== STORAGE_ERROR_CODES.INVALID_INPUT) {
      throw error;
    }
  }
}

function toolCallContext(toolCallId: string, toolName: string, params: unknown): SlotToolCallContext {
  return { toolCallId, canonicalArgsHash: canonicalJsonSha256(params), toolName };
}

/** Serializes a structured op failure to the model-facing rejection. */
function serializeOpFailure(code: string, name: string, reason: string): SlotToolResult {
  return slotRejected(code, name, reason);
}

const EMPTY_OBJECT_SCHEMA = Type.Object({});

/**
 * Creates the closed Slot Tool set for one session kind, bound to the turn's
 * Grant + session services + meter. Every definition is sequential; no
 * engineering key appears in any parameter schema. Returns the empty set for a
 * kind whose services are not wired (fail-safe).
 */
export function createStructuredSlotToolDefinitions(
  ctx: StructuredSlotToolContext,
): ToolDefinition[] {
  const limitBytes = ctx.readResponseLimitBytes ?? MAX_SLOT_TOOL_RESPONSE_BYTES;
  switch (ctx.sessionKind) {
    case 'structure':
      return createStructureTools(ctx, limitBytes);
    case 'fill':
      return createFillTools(ctx, limitBytes);
    case 'seal':
      return createSealTools(ctx, limitBytes);
  }
}

function assertCapability(ctx: StructuredSlotToolContext, capability: SlotCapabilityV1 | null | undefined): boolean {
  if (capability === null || capability === undefined) return true; // implicit read of the current session
  return ctx.grant.capabilities.includes(capability);
}

function createStructureTools(ctx: StructuredSlotToolContext, limitBytes: number): ToolDefinition[] {
  const service = ctx.proposalService;
  const tools: ToolDefinition[] = [];
  if (service === undefined) return tools;
  const proposalId = ctx.grant.kind === 'structure' ? ctx.grant.proposalId : '';
  for (const name of STRUCTURE_TOOL_NAMES) {
    if (!assertCapability(ctx, STRUCTURE_TOOL_CAPABILITY[name])) continue;
    tools.push(structureToolDefinition(ctx, name, limitBytes, proposalId, service));
  }
  return tools;
}

function structureToolDefinition(
  ctx: StructuredSlotToolContext,
  name: SlotToolName,
  limitBytes: number,
  proposalId: string,
  service: StructuredSlotProposalService,
): ToolDefinition {
  const params = structureParameters(name);
  return {
    name,
    label: name,
    description: structureDescription(name),
    promptSnippet: structurePromptSnippet(name),
    parameters: params,
    executionMode: 'sequential' as const,
    execute: async (toolCallId: string, rawParams: Static<TSchema>): Promise<SlotToolResult> => {
      const tc = toolCallContext(toolCallId, name, rawParams);
      const grant = ctx.grant as Extract<SlotSessionGrantV1, { kind: 'structure' }>;
      if (name === 'get_structure_contract') {
        // Pure declarative projection read; consume + record handled here. The
        // consume resolves the PRE-CHARGED hash (raw args) so the record lands
        // on the same key the raw seam charged.
        const precharge = await consumeSlotToolPrecharge(ctx.meter, tc);
        if (precharge.status !== 'ok') return rejectedResultForCharge(precharge, name);
        if (ctx.store === undefined || ctx.events === undefined) {
          return slotRejected(NOT_PRECHARGED, name, 'the structure tool adapter is not wired');
        }
        const effTc: SlotToolCallContext = { ...tc, canonicalArgsHash: precharge.prechargedArgsHash };
        const replay = await replayProposalRecord(ctx, proposalId, effTc);
        if (replay !== null) return replay;
        const result = service.getContract(grant);
        await structureRecord(ctx, proposalId, effTc.toolCallId, effTc.canonicalArgsHash, effTc.toolName, result as unknown as JsonValue);
        return result.ok
          ? slotAccepted(result.contract as unknown as JsonValue, name)
          : serializeOpFailure(result.code, name, result.reason);
      }
      const gate = await structureGate(ctx, proposalId, tc.toolCallId, tc.canonicalArgsHash, tc.toolName);
      if (gate.kind === 'reject') {
        return slotRejected(gate.code, name, gate.reason);
      }
      if (gate.kind === 'replay') return slotAccepted(gate.result, name);
      const result = await structureOperation(service, grant, name, rawParams, ctx);
      const prechargedArgsHash = gate.prechargedArgsHash;
      if (result.ok) {
        await structureRecord(ctx, proposalId, tc.toolCallId, prechargedArgsHash, tc.toolName, result.result as unknown as JsonValue);
        return slotAccepted(result.result, name);
      }
      await structureRecord(ctx, proposalId, tc.toolCallId, prechargedArgsHash, tc.toolName, result.failure as unknown as JsonValue);
      return serializeOpFailure(result.failure.code, name, result.failure.reason);
    },
  };
}

/** Replays a recorded proposal tool result, or null when none exists. */
async function replayProposalRecord(
  ctx: StructuredSlotToolContext,
  proposalId: string,
  tc: SlotToolCallContext,
): Promise<SlotToolResult | null> {
  if (ctx.store === undefined || ctx.events === undefined) return null;
  const view = await ctx.store.readProposal(proposalId, await ctx.events());
  const matching = view.toolRecords.find((record) => record.toolCallId === tc.toolCallId);
  if (matching !== undefined) {
    if (matching.argsHash === tc.canonicalArgsHash) {
      return slotAccepted(matching.result, tc.toolName);
    }
    return slotRejected('IDEMPOTENCY_CONFLICT', tc.toolName, 'the same toolCallId was already used with different arguments');
  }
  return null;
}

type StructureOperationResult =
  | { ok: true; result: unknown }
  | { ok: false; failure: { code: string; reason: string } };

async function structureOperation(
  service: StructuredSlotProposalService,
  grant: Extract<SlotSessionGrantV1, { kind: 'structure' }>,
  name: SlotToolName,
  rawParams: Static<TSchema>,
  ctx: StructuredSlotToolContext,
): Promise<StructureOperationResult> {
  switch (name) {
    case 'put_structure_proposal': {
      const params = rawParams as { tree?: unknown };
      const result = await service.putProposal(grant, params.tree as never);
      return result.ok ? { ok: true, result: { ok: true } } : { ok: false, failure: result };
    }
    case 'get_structure_proposal': {
      const result: GetProposalResult = await service.getProposal(grant);
      return result.ok
        ? { ok: true, result: { ok: true, tree: result.tree, lifecycle: result.lifecycle, locked: result.locked } }
        : { ok: false, failure: result };
    }
    case 'validate_structure_proposal': {
      const result: ValidateProposalResult = await service.validateProposal(grant);
      return result.ok
        ? { ok: true, result: { ok: true, verdict: result.verdict } }
        : { ok: false, failure: result };
    }
    case 'submit_structure_proposal': {
      if (ctx.submitStructureContext === undefined) {
        return { ok: false, failure: { code: NOT_PRECHARGED, reason: 'the structure submit context is not wired' } };
      }
      const result: SubmitProposalResult = await service.submitProposal(grant, ctx.submitStructureContext);
      return result.ok
        ? { ok: true, result: { ok: true, receipt: result.receipt, verdict: result.verdict } }
        : { ok: false, failure: result };
    }
    default:
      return { ok: false, failure: { code: 'UNKNOWN_OPERATION', reason: name } };
  }
}

function createFillTools(ctx: StructuredSlotToolContext, limitBytes: number): ToolDefinition[] {
  const service = ctx.draftService;
  const tools: ToolDefinition[] = [];
  if (service === undefined) return tools;
  const grant = ctx.grant as Extract<SlotSessionGrantV1, { kind: 'fill' }>;
  for (const name of FILL_TOOL_NAMES) {
    if (!assertCapability(ctx, FILL_TOOL_CAPABILITY[name])) continue;
    tools.push(fillToolDefinition(ctx, name, limitBytes, grant, service));
  }
  return tools;
}

function fillToolDefinition(
  ctx: StructuredSlotToolContext,
  name: SlotToolName,
  limitBytes: number,
  grant: Extract<SlotSessionGrantV1, { kind: 'fill' }>,
  service: StructuredSlotDraftService,
): ToolDefinition {
  return {
    name,
    label: name,
    description: fillDescription(name),
    promptSnippet: fillPromptSnippet(name),
    parameters: fillParameters(name),
    executionMode: 'sequential' as const,
    execute: async (toolCallId: string, rawParams: Static<TSchema>): Promise<SlotToolResult> => {
      const tc = toolCallContext(toolCallId, name, rawParams);
      // Consume resolves the PRE-CHARGED hash (raw args; Pi may coerce the
      // validated params) and threads it into the service context so the
      // draft-service consume + record land on the SAME key the raw seam
      // charged — single charge, free exact replay, no spurious rejection.
      const consume = await consumeSlotToolPrecharge(ctx.meter, tc);
      if (consume.status !== 'ok') return rejectedResultForCharge(consume, name);
      const effTc: SlotToolCallContext = { ...tc, canonicalArgsHash: consume.prechargedArgsHash };
      const result = await fillOperation(service, grant, name, rawParams, effTc, limitBytes);
      return result.ok ? slotAccepted(result.result, name) : serializeOpFailure(result.failure.code, name, result.failure.reason);
    },
  };
}

type FillOperationResult =
  | { ok: true; result: unknown }
  | { ok: false; failure: { code: string; reason: string } };

async function fillOperation(
  service: StructuredSlotDraftService,
  grant: Extract<SlotSessionGrantV1, { kind: 'fill' }>,
  name: SlotToolName,
  rawParams: Static<TSchema>,
  tc: SlotToolCallContext,
  limitBytes: number,
): Promise<FillOperationResult> {
  switch (name) {
    case 'list_slots': {
      const params = rawParams as { cursor?: string; limit?: number };
      const cursor = resolveListCursor(params.cursor);
      if (cursor.kind === 'invalid') {
        return { ok: false, failure: { code: 'CURSOR_INVALID', reason: 'the continuation cursor is not a valid opaque token' } };
      }
      const list = await service.listSlots(grant, tc, cursor.cursor, params.limit ?? 64);
      if (!list.ok) return { ok: false, failure: list };
      return {
        ok: true,
        result: { ok: true, entries: list.entries, nextCursor: list.nextCursor === null ? null : stringifyCursor(list.nextCursor) },
      };
    }
    case 'read_slot': {
      const params = rawParams as { slotId: string };
      const read = await service.readSlot(grant, tc, params.slotId);
      if (!read.ok) return { ok: false, failure: read };
      const serialized = serializeSlotRead(read.slot as unknown as JsonValue, name, limitBytes);
      if (!serialized.details.accepted) {
        const code = serialized.details.code ?? SLOT_READ_RESPONSE_LIMIT;
        const reason = serialized.content[0]?.type === 'text' ? serialized.content[0].text : '';
        return { ok: false, failure: { code, reason } };
      }
      return { ok: true, result: { ok: true, slot: read.slot as unknown as JsonValue } };
    }
    case 'replace_draft_content': {
      const params = rawParams as { changes: Array<{ slotId: string; content: JsonValue }> };
      const replaced = await service.replaceContent(grant, tc, params.changes);
      if (!replaced.ok) return { ok: false, failure: replaced };
      return { ok: true, result: { ok: true, changedCount: replaced.changedCount } };
    }
    case 'unset_draft_content': {
      const params = rawParams as { slotIds: string[] };
      const unset = await service.unsetContent(grant, tc, params.slotIds);
      if (!unset.ok) return { ok: false, failure: unset };
      return { ok: true, result: { ok: true, unsetCount: unset.unsetCount } };
    }
    case 'validate_draft': {
      const validated = await service.validateDraft(grant, tc);
      if (!validated.ok) return { ok: false, failure: validated };
      return { ok: true, result: { ok: true, verdict: validated.verdict } };
    }
    case 'submit_draft': {
      const submitted = await service.submitDraft(grant, tc);
      if (!submitted.ok) return { ok: false, failure: submitted };
      return { ok: true, result: { ok: true, receipt: submitted.receipt, verdict: submitted.verdict } };
    }
    case 'get_draft_status': {
      const status = await service.getDraftStatus(grant, tc);
      if (!status.ok) return { ok: false, failure: status };
      return { ok: true, result: { ok: true, status: status.status, receipt: status.receipt } };
    }
    default:
      return { ok: false, failure: { code: 'UNKNOWN_OPERATION', reason: name } };
  }
}

function createSealTools(ctx: StructuredSlotToolContext, limitBytes: number): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (ctx.seal === undefined) return tools;
  const grant = ctx.grant as Extract<SlotSessionGrantV1, { kind: 'seal' }>;
  tools.push({
    name: 'request_seal',
    label: 'request_seal',
    description:
      'Run the full Seal Gate against the sealed scaffold: re-validate all required schema/grammar, run every applicable validator and the Assembler, and verify the artifact manifest. On pass it freezes the seal candidate; a reliable failure freezes a rework receipt. Returns only the safe receipt and verdict.',
    promptSnippet: 'request_seal() — run the Seal Gate exactly once after all fill work is committed',
    parameters: EMPTY_OBJECT_SCHEMA,
    executionMode: 'sequential' as const,
    execute: async (toolCallId: string, rawParams: Static<TSchema>): Promise<SlotToolResult> => {
      const tc = toolCallContext(toolCallId, 'request_seal', rawParams);
      const precharge = await consumeSlotToolPrecharge(ctx.meter, tc);
      if (precharge.status !== 'ok') return rejectedResultForCharge(precharge, 'request_seal');
      const effTc: SlotToolCallContext = { ...tc, canonicalArgsHash: precharge.prechargedArgsHash };
      // Exact replay returns the RECORDED result — the Seal Gate is NEVER re-run
      // (it is authoritative/expensive and must not re-consume validator budget
      // or re-derive a possibly different verdict).
      const replay = consumeReplay(ctx.meter, effTc);
      if (replay !== null) return replay;
      const result = await ctx.seal!.requestSeal(grant, effTc);
      if (result.ok) {
        await ctx.meter.recordToolResult({ toolCallId: effTc.toolCallId, canonicalArgsHash: effTc.canonicalArgsHash, result: result.receipt as unknown as JsonValue });
        return slotAccepted(result.receipt as unknown as JsonValue, 'request_seal');
      }
      await ctx.meter.recordToolResult({ toolCallId: effTc.toolCallId, canonicalArgsHash: effTc.canonicalArgsHash, result: { ok: false, code: result.code, reason: result.reason } as unknown as JsonValue });
      return serializeOpFailure(result.code, 'request_seal', result.reason);
    },
  });
  // Declared read capabilities: only when the seal grant holds a read cap.
  const hasRead = grant.capabilities.includes('read_slot_spec') || grant.capabilities.includes('read_slot_content');
  if (hasRead && ctx.projectionService !== undefined) {
    for (const name of ['list_slots', 'read_slot'] as const) {
      tools.push(sealReadTool(ctx, name, limitBytes, grant, ctx.projectionService));
    }
  }
  return tools;
}

function sealReadTool(
  ctx: StructuredSlotToolContext,
  name: 'list_slots' | 'read_slot',
  limitBytes: number,
  grant: Extract<SlotSessionGrantV1, { kind: 'seal' }>,
  projection: StructuredSlotProjectionService,
): ToolDefinition {
  return {
    name,
    label: name,
    description: name === 'list_slots'
      ? 'List the authorized slot outline of the sealed scaffold (read-only).'
      : 'Read one complete authorized slot projection of the sealed scaffold (read-only).',
    promptSnippet: name === 'list_slots' ? 'list_slots() — authorized outline (seal read)' : 'read_slot(slotId) — one authorized slot (seal read)',
    parameters: name === 'list_slots' ? fillParameters('list_slots') : fillParameters('read_slot'),
    executionMode: 'sequential' as const,
    execute: async (toolCallId: string, rawParams: Static<TSchema>): Promise<SlotToolResult> => {
      const tc = toolCallContext(toolCallId, name, rawParams);
      const precharge = await consumeSlotToolPrecharge(ctx.meter, tc);
      if (precharge.status !== 'ok') return rejectedResultForCharge(precharge, name);
      const effTc: SlotToolCallContext = { ...tc, canonicalArgsHash: precharge.prechargedArgsHash };
      const replay = consumeReplay(ctx.meter, effTc);
      if (replay !== null) return replay;
      const subject = { kind: 'agent' as const, grant };
      if (name === 'list_slots') {
        const params = rawParams as { cursor?: string; limit?: number };
        const cursor = resolveListCursor(params.cursor);
        if (cursor.kind === 'invalid') {
          return slotRejected('CURSOR_INVALID', name, 'the continuation cursor is not a valid opaque token');
        }
        const list = await projection.listSlots(subject, cursor.cursor, params.limit ?? 64);
        if (!list.ok) return serializeOpFailure(list.code, name, list.reason);
        const result = { ok: true, entries: list.entries, nextCursor: list.nextCursor === null ? null : stringifyCursor(list.nextCursor) } as unknown as JsonValue;
        await ctx.meter.recordToolResult({ toolCallId: effTc.toolCallId, canonicalArgsHash: effTc.canonicalArgsHash, result });
        return slotAccepted(result, name);
      }
      const params = rawParams as { slotId: string };
      const read = await projection.readSlot(subject, params.slotId);
      if (!read.ok) return serializeOpFailure(read.code, name, read.reason);
      const serialized = serializeSlotRead(read.slot as unknown as JsonValue, name, limitBytes);
      if (!serialized.details.accepted) return serialized;
      const result = { ok: true, slot: read.slot as unknown as JsonValue } as unknown as JsonValue;
      await ctx.meter.recordToolResult({ toolCallId: effTc.toolCallId, canonicalArgsHash: effTc.canonicalArgsHash, result });
      return slotAccepted(result, name);
    },
  };
}

/** Replays a recorded meter result for a precharged exact key, or null. */
function consumeReplay(meter: AttemptMeter, tc: SlotToolCallContext): SlotToolResult | null {
  const record = meter.toolCalls.find(
    (candidate) => candidate.toolCallId === tc.toolCallId && candidate.canonicalArgsHash === tc.canonicalArgsHash,
  );
  if (record !== undefined && record.result !== null) {
    return slotAccepted(record.result, tc.toolName);
  }
  return null;
}

// ------------------------------------------------------------------ schemas

function structureParameters(name: SlotToolName): TSchema {
  switch (name) {
    case 'put_structure_proposal':
      return Type.Object({
        tree: Type.Object({
          clientKey: Type.String({ minLength: 1, maxLength: 256 }),
          typeId: Type.String({ minLength: 1, maxLength: 256 }),
          spec: Type.Object({}, { additionalProperties: true }),
          children: Type.Array(Type.Unknown()),
        }),
      });
    default:
      return EMPTY_OBJECT_SCHEMA;
  }
}

function fillParameters(name: SlotToolName): TSchema {
  switch (name) {
    case 'list_slots':
      return Type.Object({
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 512 })),
      });
    case 'read_slot':
      return Type.Object({ slotId: Type.String({ minLength: 1, maxLength: 256 }) });
    case 'replace_draft_content':
      return Type.Object({
        changes: Type.Array(
          Type.Object({
            slotId: Type.String({ minLength: 1, maxLength: 256 }),
            content: Type.Unknown(),
          }),
          { minItems: 1 },
        ),
      });
    case 'unset_draft_content':
      return Type.Object({
        slotIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1 }),
      });
    default:
      return EMPTY_OBJECT_SCHEMA;
  }
}

function structureDescription(name: SlotToolName): string {
  switch (name) {
    case 'get_structure_contract':
      return 'Read the declarative structure contract of this session: creatable slot types with their spec schemas, the layout grammar, the platform limits and the safety notes. Read-only; never proposes or commits.';
    case 'put_structure_proposal':
      return 'Replace the whole proposal tree with the supplied tree (a node is {clientKey, typeId, spec, children}). Storage-safe and advisory on schema/grammar; only submission runs the full structure gate.';
    case 'get_structure_proposal':
      return 'Read back the current proposal tree and its lifecycle/lock state. Read-only; never proposes or commits.';
    case 'validate_structure_proposal':
      return 'Run the advisory structure check (schema + grammar) against the current proposal tree. Never locks and never changes authority.';
    case 'submit_structure_proposal':
      return 'Run the full Structure Gate and freeze the turn-bound structure candidate exactly once. After a candidate the session is locked; return the safe receipt only.';
    default:
      return '';
  }
}

function structurePromptSnippet(name: SlotToolName): string {
  switch (name) {
    case 'get_structure_contract':
      return 'get_structure_contract() — read the declarative contract';
    case 'put_structure_proposal':
      return 'put_structure_proposal(tree) — replace the whole proposal tree';
    case 'get_structure_proposal':
      return 'get_structure_proposal() — read back the proposal tree';
    case 'validate_structure_proposal':
      return 'validate_structure_proposal() — advisory structure check';
    case 'submit_structure_proposal':
      return 'submit_structure_proposal() — run the gate and freeze the candidate';
    default:
      return '';
  }
}

function fillDescription(name: SlotToolName): string {
  switch (name) {
    case 'list_slots':
      return 'List the authorized slot outline of the current session in tree order (with an optional opaque continuation cursor). Content is not loaded; use read_slot for one complete slot.';
    case 'read_slot':
      return 'Read ONE complete authorized slot projection (the effective base + this draft overlay value when visible). Content above the platform single-call response limit rejects without truncation.';
    case 'replace_draft_content':
      return 'Batch full-value replace of one or more writable slots. All-or-nothing; supports only full JSON value replacement (no patches).';
    case 'unset_draft_content':
      return 'Explicitly restore one or more writable slots to their unfilled state (distinct from a null value).';
    case 'validate_draft':
      return 'Run the advisory draft check (content schema + merge-trigger validators) over the current overlay. Never locks and never changes authority.';
    case 'submit_draft':
      return 'Run the Merge Gate and freeze the turn-bound merge candidate exactly once. After a candidate the session is locked; a no-op draft is legal.';
    case 'get_draft_status':
      return 'Read the draft lifecycle, baseline, change count, validation summary and lock state. Read-only; never proposes or commits.';
    default:
      return '';
  }
}

function fillPromptSnippet(name: SlotToolName): string {
  switch (name) {
    case 'list_slots':
      return 'list_slots(cursor?, limit?) — authorized outline';
    case 'read_slot':
      return 'read_slot(slotId) — one complete authorized slot';
    case 'replace_draft_content':
      return 'replace_draft_content(changes: [{slotId, content}]) — batch replace';
    case 'unset_draft_content':
      return 'unset_draft_content(slotIds) — restore to unfilled';
    case 'validate_draft':
      return 'validate_draft() — advisory draft check';
    case 'submit_draft':
      return 'submit_draft() — run the merge gate and freeze the candidate';
    case 'get_draft_status':
      return 'get_draft_status() — lifecycle + baseline + changes';
    default:
      return '';
  }
}

/** The opaque cursor the model passes back verbatim (never internal ids). */
function stringifyCursor(cursor: StructuredSlotTreeCursorV1): string {
  return JSON.stringify(cursor);
}

type ResolvedListCursor =
  | { kind: 'ok'; cursor: StructuredSlotTreeCursorV1 | null }
  | { kind: 'invalid' };

/** Absent cursor = start; a present-but-unparseable cursor is CURSOR_INVALID. */
function resolveListCursor(cursor: string | undefined): ResolvedListCursor {
  if (cursor === undefined) {
    return { kind: 'ok', cursor: null };
  }
  try {
    const parsed = JSON.parse(cursor) as StructuredSlotTreeCursorV1;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof parsed.version !== 'number' ||
      typeof parsed.signature !== 'string'
    ) {
      return { kind: 'invalid' };
    }
    return { kind: 'ok', cursor: parsed };
  } catch {
    return { kind: 'invalid' };
  }
}
