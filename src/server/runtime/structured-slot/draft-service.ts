/**
 * FillDraft service — the fill-session layer of the structured slot engine
 * (Task 13, design §12-§14.3, spec §9.2).
 *
 * Seven context-bound operations plus the materialization boundary, all bound
 * to a `FillSessionGrantV1` + the active turn + the private Draft:
 *
 * - `getOrCreateDraft(turnId, draftId)` — get-or-create by the ACTIVE turn only
 *   after a committed `structured_fill_draft_opened`; a crash after
 *   opened/before the private journal recreates the SAME empty Draft; never
 *   clones an overlay across attempts.
 * - `listSlots(grant, ctx, cursor, limit)` / `readSlot(grant, ctx, slotId)` —
 *   delegate to the Task 10 projection service under the current Draft overlay
 *   (reads see base + own overlay; the list is the authorized outline).
 *   Out-of-scope/hidden ids reveal NO existence (D05).
 * - `replaceContent(grant, ctx, changes)` / `unsetContent(grant, ctx, slotIds)`
 *   — batch full JSON-value replacement / explicit restore-to-unset on the
 *   private overlay, all-or-nothing, writable scope enforced, size-bounded.
 *   Type/spec/tree mutations are structurally impossible (content-only API)
 *   and out-of-scope slots reject with SLOT_WRITE_FORBIDDEN.
 * - `validateDraft(grant, ctx)` — ADVISORY base+overlay check returning a
 *   `StructuredVerdictV1`; never locks, never changes authority.
 * - `submitDraft(grant, ctx)` — the Merge Gate (design §14.3): content schema
 *   of changed slots, changed-slot + affected subtree/scaffold merge-trigger
 *   validators, revision/Grant/writable-scope checks; on success it STAGES the
 *   new content-root blob (nonempty) WITHOUT promoting authority, freezes a
 *   turn-bound `MergeCommitCandidate` in private state and LOCKS the draft. A
 *   gate failure leaves the draft OPEN. A no-op overlay (changeCount 0) still
 *   runs the scaffold-level merge validators and freezes a candidate with
 *   `resultRevision === baseRevision`, `contentRevisionDigest: null` (design
 *   §12.4/L02).
 * - `getDraftStatus(grant, ctx)` — lifecycle (open/merged/stale/abandoned) by
 *   reconciling TaskEvents over the private journal (Task 7 authority); never
 *   reads a private terminal as authority.
 *
 * Metering (brief Step 4 / spec §5): EVERY operation charges the Attempt meter
 * (`AttemptMeter.prechargeRawTool`) BEFORE parameter authorization, so invalid
 * and unauthorized calls still count; the private journal then records ONE tool
 * signature (canonical args hash + result) and the checkpoint advances
 * atomically through the store. Idempotency follows design §9.4/H04: the same
 * `(toolCallId, canonicalArgsHash)` replays the original result; the same id
 * with changed args is IDEMPOTENCY_CONFLICT. A formed candidate is the
 * idempotency authority for submit (candidate lock).
 *
 * Lifecycle authority (design §13/§18.3): merged/stale/abandoned come ONLY from
 * committed TaskEvents (`structured_fill_draft_terminal`); this service never
 * writes a terminal into private state before the committer batch.
 *
 * This module carries zero business vocabulary (iron rule 1).
 */
import type {
  FillSessionGrantV1,
  IssueLocation,
  JsonObject,
  JsonValue,
  StructuredBlobRefV1,
  StructuredIssueV1,
  StructuredSlotLimitsV1,
  StructuredSlotTreeCursorV1,
  StructuredVerdictV1,
} from '../../../shared/structured-slots';
import type { FrozenStructuredSlotContractV1 } from '../../template/structured-slot-contract';
import { canonicalJsonBytes } from '../../structured-slots/canonical-json';
import { validateSlotValue } from '../../structured-slots/slot-schema';
import { makeStructuredIssue } from '../../structured-slots/issues';
import {
  StructuredSlotPrivateStore,
  type DraftContext,
  type DraftLifecycle,
  type DraftOverlayEntry,
  type DraftView,
  type MergeCommitCandidate,
} from '../../storage/structured-slot-private-store';
import {
  StructuredSlotBlobStore,
  type EffectiveContentEntry,
} from '../../storage/structured-slot-blob-store';
import { projectStructuredSlotState } from '../../storage/structured-slot-state';
import type { TaskEvent } from '../../storage/task-events';
import type { GrantResolutionErrorCode } from './grant-service';
import type {
  DraftContentOverlayV1,
  ProjectionFailure,
  SlotOutlineEntryV1,
  SlotReadProjectionV1,
  StructuredSlotProjectionService,
} from './projection-service';
import type { ValidationEngine, GateSlotInput } from './validation-engine';
import { AttemptMeter, type AttemptTerminalFailure } from './attempt-meter';

export type { MergeCommitCandidate };

/** Draft lifecycle terminal (event-derived) — open/merged/stale/abandoned. */
export type FillDraftLifecycle = DraftLifecycle;

/** Session-level status including the private candidate-locked state. */
export type FillDraftSessionStatus = 'open' | 'candidate_created' | 'merged' | 'stale' | 'abandoned';

/** Idempotency context the runner supplies for every Slot Tool call. */
export interface FillToolContext {
  toolCallId: string;
  canonicalArgsHash: string;
  toolName: string;
}

/** Safe model-facing receipt (design §11.3): no blob/grant/internal ids. */
export interface FillSafeReceiptV1 {
  kind: 'fill';
  status: FillDraftSessionStatus;
  changeCount: number;
  issueSummary: { errors: number; warnings: number };
}

/** Detailed `get_draft_status` projection (design §12.2). */
export interface FillDraftStatusV1 {
  version: 1;
  lifecycle: FillDraftLifecycle;
  baseRevision: number;
  changedSlotCount: number;
  /** Last advisory validation summary (best-effort; empty until validated). */
  issueSummary: { errors: number; warnings: number };
  locked: boolean;
}

/** Stable operation codes for the fill Draft layer. */
export type DraftOperationCode =
  | GrantResolutionErrorCode
  | 'SLOT_NOT_VISIBLE'
  | 'CURSOR_INVALID'
  | 'DRAFT_NOT_OPENED'
  | 'DRAFT_NOT_OPEN'
  | 'DRAFT_STALE'
  | 'DRAFT_ALREADY_SUBMITTED'
  | 'DRAFT_GATE_REJECTED'
  | 'DRAFT_MALFORMED'
  | 'DRAFT_LIMIT_EXCEEDED'
  | 'SLOT_WRITE_FORBIDDEN'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'SCAFFOLD_NOT_ACTIVE';

/** Typed failure for the fill Draft operations. */
export interface DraftFailure {
  ok: false;
  code: DraftOperationCode;
  reason: string;
  issues?: StructuredIssueV1[];
  /** Present when a Merge Gate rejected a submission. */
  verdict?: StructuredVerdictV1;
}

export type GetOrCreateDraftResult =
  | { ok: true; view: DraftView }
  | { ok: false; code: GrantResolutionErrorCode | 'DRAFT_NOT_OPENED'; reason: string };

export type ListSlotsResult =
  | { ok: true; entries: SlotOutlineEntryV1[]; nextCursor: StructuredSlotTreeCursorV1 | null }
  | DraftFailure;

export type ReadSlotResult = { ok: true; slot: SlotReadProjectionV1 } | DraftFailure;

export type ReplaceContentResult = { ok: true; changedCount: number; changedSlotIds: string[] } | DraftFailure;

export type UnsetContentResult = { ok: true; unsetCount: number; slotIds: string[] } | DraftFailure;

export type ValidateDraftResult = { ok: true; verdict: StructuredVerdictV1 } | DraftFailure;

export type SubmitDraftResult =
  | { ok: true; candidate: MergeCommitCandidate; receipt: FillSafeReceiptV1; verdict: StructuredVerdictV1 }
  | DraftFailure;

export type GetDraftStatusResult = { ok: true; status: FillDraftStatusV1; receipt: FillSafeReceiptV1 } | DraftFailure;

export interface DraftServiceOptions {
  taskId: string;
  snapshotHash: string;
  contract: FrozenStructuredSlotContractV1;
  store: StructuredSlotPrivateStore;
  blobStore: StructuredSlotBlobStore;
  projection: StructuredSlotProjectionService;
  validation: ValidationEngine;
  meter: AttemptMeter;
  events: () => Promise<readonly TaskEvent[]>;
}

/** Active scaffold bound by a fill grant (from the state projection). */
interface ActiveScaffoldState {
  scaffoldId: string;
  generationId: string;
  contentRevision: number;
  content: StructuredBlobRefV1 | null;
}

type OpStart =
  | { status: 'ok'; view: DraftView }
  | { status: 'replay'; result: JsonValue }
  | { status: 'conflict' }
  | { status: 'closed'; failure: AttemptTerminalFailure }
  | { status: 'fail'; code: DraftOperationCode; reason: string; issues?: StructuredIssueV1[] };

function failGrant(code: GrantResolutionErrorCode, reason: string): { ok: false; code: GrantResolutionErrorCode; reason: string } {
  return { ok: false, code, reason };
}

function fail(
  code: DraftOperationCode,
  reason: string,
  extra: Partial<DraftFailure> = {},
): DraftFailure {
  return { ok: false, code, reason, ...extra };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function statusFromView(view: DraftView): FillDraftSessionStatus {
  if (view.lifecycle === 'merged') return 'merged';
  if (view.lifecycle === 'stale') return 'stale';
  if (view.lifecycle === 'abandoned') return 'abandoned';
  if (view.candidate !== null) return 'candidate_created';
  return 'open';
}

function receiptFor(status: FillDraftSessionStatus, changeCount: number): FillSafeReceiptV1 {
  return { kind: 'fill', status, changeCount, issueSummary: { errors: 0, warnings: 0 } };
}

function candidateReceipt(candidate: MergeCommitCandidate): FillSafeReceiptV1 {
  return receiptFor('candidate_created', candidate.changeCount);
}

function passedVerdict(): StructuredVerdictV1 {
  return { version: 1, status: 'passed', issues: [], truncated: false, summary: { errors: 0, warnings: 0 } };
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

function notWritable(): StructuredIssueV1 {
  return makeStructuredIssue('SLOT_WRITE_FORBIDDEN', 'draft', { kind: 'operation' }, {});
}

function fromProjectionFailure(f: ProjectionFailure): DraftFailure {
  return {
    ok: false,
    code: f.code as DraftOperationCode,
    reason: f.reason,
    ...(f.issue !== undefined ? { issues: [f.issue] } : {}),
  };
}

/**
 * FillDraft service bound to one production case (task), its frozen contract
 * and the active turn's Attempt meter. Operations return typed results and
 * never throw; the grant is re-validated at every operation boundary and the
 * lifecycle is always reconciled from committed TaskEvents.
 */
export class StructuredSlotDraftService {
  private readonly taskId: string;

  private readonly snapshotHash: string;

  private readonly contract: FrozenStructuredSlotContractV1;

  private readonly store: StructuredSlotPrivateStore;

  private readonly blobStore: StructuredSlotBlobStore;

  private readonly projection: StructuredSlotProjectionService;

  private readonly validation: ValidationEngine;

  private readonly meter: AttemptMeter;

  private readonly events: () => Promise<readonly TaskEvent[]>;

  /** Best-effort last advisory validation summary per draft (in-memory). */
  private readonly lastValidationSummary = new Map<string, { errors: number; warnings: number }>();

  constructor(options: DraftServiceOptions) {
    this.taskId = options.taskId;
    this.snapshotHash = options.snapshotHash;
    this.contract = options.contract;
    this.store = options.store;
    this.blobStore = options.blobStore;
    this.projection = options.projection;
    this.validation = options.validation;
    this.meter = options.meter;
    this.events = options.events;
  }

  /**
   * Get-or-create the open Draft for the ACTIVE turn, only after the committed
   * `structured_fill_draft_opened` (design §11.5/O01). A crash after the start
   * batch but before the private journal recreates the SAME empty Draft; a
   * closed attempt or a never-opened draft is refused (no cross-attempt clone).
   */
  async getOrCreateDraft(turnId: string, draftId: string): Promise<GetOrCreateDraftResult> {
    const events = await this.events();
    const opened = events.find(
      (event): event is Extract<TaskEvent, { type: 'structured_fill_draft_opened' }> =>
        event.type === 'structured_fill_draft_opened' && event.draftId === draftId,
    );
    if (opened === undefined) {
      return { ok: false, code: 'DRAFT_NOT_OPENED', reason: 'no committed draft_opened event for this draft' };
    }
    if (opened.turnId !== turnId) {
      return { ok: false, code: 'GRANT_INVALID', reason: 'the draft_opened event is bound to a different turn' };
    }
    let started = false;
    let terminal = false;
    for (const event of events) {
      if (event.type === 'structured_slot_attempt_started' && event.turnId === turnId) started = true;
      if (event.type === 'structured_slot_attempt_terminal' && event.turnId === turnId) terminal = true;
    }
    if (!started || terminal) {
      return { ok: false, code: 'GRANT_INVALID', reason: 'the attempt is not active; a fresh attempt gets its own draft' };
    }
    const context: DraftContext = {
      scaffoldId: opened.scaffoldId,
      generationId: opened.generationId,
      baseRevision: opened.baseRevision,
    };
    const view = await this.store.materializeDraft(turnId, draftId, context);
    return { ok: true, view };
  }

  /** Paginated authorized outline (design §10.6): delegate to the projection. */
  async listSlots(
    grant: FillSessionGrantV1,
    ctx: FillToolContext,
    cursor: StructuredSlotTreeCursorV1 | null,
    limit: number,
  ): Promise<ListSlotsResult> {
    const start = await this.prepareOp(grant, ctx);
    if (start.status === 'replay') return start.result as unknown as ListSlotsResult;
    if (start.status === 'closed') return this.closedFailure(start.failure);
    if (start.status !== 'ok') return this.startFailure(start);
    const locked = this.assertSessionOpen(start.view);
    if (locked !== null) return locked;

    const listed = await this.projection.listSlots({ kind: 'agent', grant }, cursor, limit);
    if (!listed.ok) return fromProjectionFailure(listed);
    const result: ListSlotsResult = { ok: true, entries: listed.entries, nextCursor: listed.nextCursor };
    await this.recordOp(grant.draftId, ctx, result as unknown as JsonValue);
    return result;
  }

  /** Authorized projection of one slot under the Draft overlay (base + own). */
  async readSlot(grant: FillSessionGrantV1, ctx: FillToolContext, slotId: string): Promise<ReadSlotResult> {
    const start = await this.prepareOp(grant, ctx);
    if (start.status === 'replay') return start.result as unknown as ReadSlotResult;
    if (start.status === 'closed') return this.closedFailure(start.failure);
    if (start.status !== 'ok') return this.startFailure(start);
    const locked = this.assertSessionOpen(start.view);
    if (locked !== null) return locked;

    const read = await this.projection.readSlot({ kind: 'agent', grant }, slotId, this.overlayFor(start.view));
    if (!read.ok) return fromProjectionFailure(read);
    const result: ReadSlotResult = { ok: true, slot: read.slot };
    await this.recordOp(grant.draftId, ctx, result as unknown as JsonValue);
    return result;
  }

  /** Batch full JSON-value replacement, all-or-nothing (design §12.3). */
  async replaceContent(
    grant: FillSessionGrantV1,
    ctx: FillToolContext,
    changes: Array<{ slotId: string; content: JsonValue }>,
  ): Promise<ReplaceContentResult> {
    const start = await this.prepareOp(grant, ctx);
    if (start.status === 'replay') return start.result as unknown as ReplaceContentResult;
    if (start.status === 'closed') return this.closedFailure(start.failure);
    if (start.status !== 'ok') return this.startFailure(start);
    const view = start.view;
    const open = this.assertSessionOpen(view);
    if (open !== null) return open;

    // Validate the FULL batch before any write (all-or-nothing). A business
    // failure on an open draft is itself a recorded tool result, so an exact
    // replay of the same signature returns the same failure without re-running.
    const batchCheck = this.validateWriteBatch(grant, view, changes.map((c) => ({ slotId: c.slotId, content: c.content, set: true })));
    if (batchCheck !== null) {
      await this.recordOp(grant.draftId, ctx, batchCheck as unknown as JsonValue);
      return batchCheck;
    }

    for (const change of changes) {
      await this.store.replaceContent(grant.draftId, change.slotId, change.content);
    }
    const result: ReplaceContentResult = {
      ok: true,
      changedCount: changes.length,
      changedSlotIds: changes.map((c) => c.slotId),
    };
    await this.recordOp(grant.draftId, ctx, result as unknown as JsonValue);
    return result;
  }

  /** Explicit restore-to-unset (different from setting a null value). */
  async unsetContent(grant: FillSessionGrantV1, ctx: FillToolContext, slotIds: string[]): Promise<UnsetContentResult> {
    const start = await this.prepareOp(grant, ctx);
    if (start.status === 'replay') return start.result as unknown as UnsetContentResult;
    if (start.status === 'closed') return this.closedFailure(start.failure);
    if (start.status !== 'ok') return this.startFailure(start);
    const view = start.view;
    const open = this.assertSessionOpen(view);
    if (open !== null) return open;

    const batchCheck = this.validateWriteBatch(grant, view, slotIds.map((slotId) => ({ slotId, content: null, set: false })));
    if (batchCheck !== null) {
      await this.recordOp(grant.draftId, ctx, batchCheck as unknown as JsonValue);
      return batchCheck;
    }

    for (const slotId of slotIds) {
      await this.store.unsetContent(grant.draftId, slotId);
    }
    const result: UnsetContentResult = { ok: true, unsetCount: slotIds.length, slotIds: [...slotIds] };
    await this.recordOp(grant.draftId, ctx, result as unknown as JsonValue);
    return result;
  }

  /** ADVISORY base+overlay check (design §14.2): never locks, never commits. */
  async validateDraft(grant: FillSessionGrantV1, ctx: FillToolContext): Promise<ValidateDraftResult> {
    const start = await this.prepareOp(grant, ctx);
    if (start.status === 'replay') return start.result as unknown as ValidateDraftResult;
    if (start.status === 'closed') return this.closedFailure(start.failure);
    if (start.status !== 'ok') return this.startFailure(start);
    const open = this.assertSessionOpen(start.view);
    if (open !== null) return open;

    const active = await this.activeScaffold();
    const activeCheck = this.assertActiveForWrite(grant, active);
    if (activeCheck !== null) return activeCheck;

    const slots = await this.buildEffectiveSlots(active as ActiveScaffoldState, start.view.overlay);
    if (slots === null) return fail('SCAFFOLD_NOT_ACTIVE', 'the generation is inconsistent');
    const changedSlotIds = [...start.view.overlay.keys()];
    const schemaIssues = this.checkChangedContentSchemas(slots, changedSlotIds);
    const gate = await this.validation.runMergeGate({
      taskId: this.taskId,
      contract: this.contract,
      slots,
      changedSlotIds,
    });
    const verdict = buildVerdict(
      [...schemaIssues, ...gate.verdict.issues],
      gate.verdict.truncated,
      gate.verdict.status === 'incomplete',
    );
    this.lastValidationSummary.set(grant.draftId, verdict.summary);
    const result: ValidateDraftResult = { ok: true, verdict };
    await this.recordOp(grant.draftId, ctx, result as unknown as JsonValue);
    return result;
  }

  /**
   * The Merge Gate + candidate freeze (design §14.3, spec §9.2). On success it
   * stages the new content-root blob for a nonempty merge (no authority
   * promotion), freezes the turn-bound candidate and LOCKS the draft; a gate
   * failure leaves the draft open. A no-op overlay still runs scaffold-level
   * merge validators and freezes a changeCount-0 candidate (L02).
   */
  async submitDraft(grant: FillSessionGrantV1, ctx: FillToolContext): Promise<SubmitDraftResult> {
    const start = await this.prepareOp(grant, ctx);
    if (start.status === 'replay') return start.result as unknown as SubmitDraftResult;
    if (start.status === 'closed') return this.closedFailure(start.failure);
    if (start.status !== 'ok') return this.startFailure(start);
    const view = start.view;

    // Idempotent replay of a frozen candidate (the candidate is the authority).
    if (view.candidate !== null) {
      if (!view.locked) {
        await this.store.lockDraft(grant.draftId);
      }
      return { ok: true, candidate: view.candidate, receipt: candidateReceipt(view.candidate), verdict: passedVerdict() };
    }
    if (view.locked) return fail('DRAFT_ALREADY_SUBMITTED', 'a candidate has been formed; the gate cannot be re-run');
    if (view.lifecycle === 'stale') return fail('DRAFT_STALE', 'the draft base revision is stale');
    if (view.lifecycle !== 'open') return fail('DRAFT_NOT_OPEN', `the draft is ${view.lifecycle}, not open`);

    const active = await this.activeScaffold();
    const activeCheck = this.assertActiveForWrite(grant, active);
    if (activeCheck !== null) return activeCheck;

    // Merge Gate check 4: Grant + writable scope still valid (design §14.3).
    const changedSlotIds = [...view.overlay.keys()];
    for (const slotId of changedSlotIds) {
      if (!grant.writableSlotIds.includes(slotId)) {
        return fail('SLOT_WRITE_FORBIDDEN', 'the draft changes a slot outside the writable scope', { issues: [notWritable()] });
      }
    }

    const slots = await this.buildEffectiveSlots(active as ActiveScaffoldState, view.overlay);
    if (slots === null) return fail('SCAFFOLD_NOT_ACTIVE', 'the generation is inconsistent');
    const schemaIssues = this.checkChangedContentSchemas(slots, changedSlotIds);
    const gate = await this.validation.runMergeGate({
      taskId: this.taskId,
      contract: this.contract,
      slots,
      changedSlotIds,
    });
    const verdict = buildVerdict(
      [...schemaIssues, ...gate.verdict.issues],
      gate.verdict.truncated,
      gate.verdict.status === 'incomplete',
    );
    if (verdict.status !== 'passed') {
      const rejected: SubmitDraftResult = fail('DRAFT_GATE_REJECTED', 'the merge gate rejected the draft', { verdict });
      await this.recordOp(grant.draftId, ctx, rejected as unknown as JsonValue);
      return rejected;
    }

    const normalizedChanges = [...view.overlay.entries()]
      .map(([slotId, entry]) => ({ slotId, presence: entry.presence, content: entry.content }))
      .sort((a, b) => (a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0));
    let contentRevisionDigest: string | null = null;
    if (changedSlotIds.length > 0) {
      contentRevisionDigest = await this.stageContentRoot(active as ActiveScaffoldState, view.overlay);
    }

    const candidate: MergeCommitCandidate = {
      taskId: this.taskId,
      turnId: grant.turnId,
      draftId: grant.draftId,
      scaffoldId: grant.scaffoldId,
      baseRevision: grant.baseRevision,
      resultRevision: changedSlotIds.length > 0 ? grant.baseRevision + 1 : grant.baseRevision,
      changeCount: changedSlotIds.length,
      normalizedChanges,
      contentRevisionDigest,
    };
    const success: SubmitDraftResult = {
      ok: true,
      candidate,
      receipt: candidateReceipt(candidate),
      verdict,
    };
    // Freeze into private state: candidate, then the result record, then the
    // submission lock (post-lock writes reject; a crash between the steps is
    // repaired by the idempotent candidate/tool-record replay paths).
    await this.store.storeDraftCandidate(grant.draftId, candidate);
    await this.recordOp(grant.draftId, ctx, success as unknown as JsonValue);
    await this.store.lockDraft(grant.draftId);
    return success;
  }

  /** Lifecycle + baseline + changes + validation summary (design §12.2). */
  async getDraftStatus(grant: FillSessionGrantV1, ctx: FillToolContext): Promise<GetDraftStatusResult> {
    const start = await this.prepareOp(grant, ctx);
    if (start.status === 'replay') return start.result as unknown as GetDraftStatusResult;
    if (start.status === 'closed') return this.closedFailure(start.failure);
    if (start.status !== 'ok') return this.startFailure(start);
    const view = start.view;
    const status: FillDraftStatusV1 = {
      version: 1,
      lifecycle: view.lifecycle,
      baseRevision: view.baseRevision,
      changedSlotCount: view.overlay.size,
      issueSummary: this.lastValidationSummary.get(grant.draftId) ?? { errors: 0, warnings: 0 },
      locked: view.locked,
    };
    const changeCount = view.candidate !== null ? view.candidate.changeCount : view.overlay.size;
    const result: GetDraftStatusResult = { ok: true, status, receipt: receiptFor(statusFromView(view), changeCount) };
    await this.recordOp(grant.draftId, ctx, result as unknown as JsonValue);
    return result;
  }

  // ------------------------------------------------------------------ private

  /**
   * The shared operation ingress: the Attempt meter is charged BEFORE any
   * parameter authorization (invalid/unauthorized calls still count, spec §5),
   * the private Draft view is read with event reconciliation, the grant is
   * re-validated, and the tool-signature idempotency is resolved (replay /
   * conflict) from the private journal.
   */
  private async prepareOp(
    grant: FillSessionGrantV1,
    ctx: FillToolContext,
  ): Promise<OpStart> {
    const charge = await this.meter.prechargeRawTool(ctx);
    if (charge.status === 'closed') {
      return { status: 'closed', failure: charge.failure };
    }
    const view = await this.store.readDraft(grant.draftId, await this.events());
    const grantCheck = this.assertGrant(grant, view);
    if (!grantCheck.ok) return { status: 'fail', code: grantCheck.code, reason: grantCheck.reason };
    const matching = view.toolRecords.find((record) => record.toolCallId === ctx.toolCallId);
    if (matching !== undefined) {
      if (matching.argsHash === ctx.canonicalArgsHash) {
        return { status: 'replay', result: matching.result };
      }
      return { status: 'conflict' };
    }
    return { status: 'ok', view };
  }

  private startFailure(start: Extract<OpStart, { status: 'fail' | 'conflict' }>): DraftFailure {
    if (start.status === 'conflict') {
      return {
        ok: false,
        code: 'IDEMPOTENCY_CONFLICT',
        reason: 'the same toolCallId was already used with different arguments',
        issues: [makeStructuredIssue('IDEMPOTENCY_CONFLICT', 'draft', { kind: 'operation' }, {})],
      };
    }
    return { ok: false, code: start.code, reason: start.reason, ...(start.issues !== undefined ? { issues: start.issues } : {}) };
  }

  private closedFailure(failure: AttemptTerminalFailure): DraftFailure {
    return { ok: false, code: 'RESOURCE_LIMIT_EXCEEDED', reason: failure.message };
  }

  /** Reads are session-bound: a formed candidate locks the session (design §11.3). */
  private assertSessionOpen(view: DraftView): DraftFailure | null {
    if (view.locked) return fail('DRAFT_ALREADY_SUBMITTED', 'a candidate has been formed; the session is locked');
    if (view.lifecycle === 'stale') return fail('DRAFT_STALE', 'the draft base revision is stale');
    if (view.lifecycle !== 'open') return fail('DRAFT_NOT_OPEN', `the draft is ${view.lifecycle}, not open`);
    return null;
  }

  private assertGrant(
    grant: FillSessionGrantV1,
    view: DraftView,
  ): { ok: true } | { ok: false; code: GrantResolutionErrorCode; reason: string } {
    if (grant.kind !== 'fill') return failGrant('GRANT_INVALID', 'the grant is not a fill grant');
    if (grant.caseId !== this.taskId) return failGrant('GRANT_INVALID', 'the grant is bound to a different task');
    if (grant.snapshotHash !== this.snapshotHash) {
      return failGrant('GRANT_INVALID', 'the grant is bound to a different snapshot');
    }
    if (grant.draftId !== view.draftId) return failGrant('GRANT_INVALID', 'the grant is bound to a different draft');
    if (view.turnId === '' || view.turnId !== grant.turnId) {
      return failGrant('GRANT_INVALID', 'the grant is bound to a different attempt');
    }
    if (grant.scaffoldId !== view.scaffoldId) {
      return failGrant('GRANT_INVALID', 'the grant is bound to a different scaffold');
    }
    if (grant.baseRevision !== view.baseRevision) {
      return failGrant('GRANT_INVALID', 'the grant is bound to a different base revision');
    }
    return { ok: true };
  }

  /** Design D06: a fill grant dies when the active scaffold/revision moved on. */
  private assertActiveForWrite(
    grant: FillSessionGrantV1,
    active: ActiveScaffoldState | null,
  ): DraftFailure | null {
    if (active === null) return fail('SCAFFOLD_NOT_ACTIVE', 'no active scaffold');
    if (active.scaffoldId !== grant.scaffoldId) {
      return fail('GRANT_STALE', 'the active scaffold generation changed');
    }
    if (active.contentRevision !== grant.baseRevision) {
      return fail('DRAFT_STALE', 'the draft base revision no longer matches the active content revision');
    }
    return null;
  }

  /**
   * Validates a WHOLE write batch before any journal write (all-or-nothing):
   * shape, writable scope, duplicate slot ids, per-slot content bytes,
   * changed-slot count and total overlay bytes.
   */
  private validateWriteBatch(
    grant: FillSessionGrantV1,
    view: DraftView,
    batch: Array<{ slotId: string; content: JsonValue | null; set: boolean }>,
  ): DraftFailure | null {
    if (batch.length > this.contract.limits.draft.maxChangedSlots) {
      return fail('DRAFT_LIMIT_EXCEEDED', `the batch exceeds maxChangedSlots ${this.contract.limits.draft.maxChangedSlots}`, {
        issues: [makeStructuredIssue('RESOURCE_LIMIT_EXCEEDED', 'draft', { kind: 'operation' }, { limit: 'maxChangedSlots' })],
      });
    }
    const seen = new Set<string>();
    for (const change of batch) {
      if (typeof change.slotId !== 'string' || change.slotId.length === 0) {
        return fail('DRAFT_MALFORMED', 'every change needs a non-empty slotId');
      }
      if (!grant.writableSlotIds.includes(change.slotId)) {
        return fail('SLOT_WRITE_FORBIDDEN', 'the slot is not writable in this session', { issues: [notWritable()] });
      }
      if (seen.has(change.slotId)) {
        return fail('DRAFT_MALFORMED', `slot '${change.slotId}' appears more than once in the batch`);
      }
      seen.add(change.slotId);
      let bytes: number;
      try {
        bytes = canonicalJsonBytes(change.content).length;
      } catch {
        return fail('DRAFT_MALFORMED', `content of slot '${change.slotId}' is not JSON-serializable`);
      }
      if (bytes > this.contract.limits.payload.maxContentBytesPerSlot) {
        return fail('DRAFT_LIMIT_EXCEEDED', `content of slot '${change.slotId}' exceeds maxContentBytesPerSlot`, {
          issues: [
            makeStructuredIssue('RESOURCE_LIMIT_EXCEEDED', 'draft', { kind: 'operation' }, { limit: 'maxContentBytesPerSlot' }),
          ],
        });
      }
    }
    const projected = new Map(view.overlay);
    for (const change of batch) {
      projected.set(change.slotId, change.set ? { presence: 'set', content: change.content } : { presence: 'unset', content: null });
    }
    if (projected.size > this.contract.limits.draft.maxChangedSlots) {
      return fail('DRAFT_LIMIT_EXCEEDED', `the draft overlay exceeds maxChangedSlots ${this.contract.limits.draft.maxChangedSlots}`, {
        issues: [makeStructuredIssue('RESOURCE_LIMIT_EXCEEDED', 'draft', { kind: 'operation' }, { limit: 'maxChangedSlots' })],
      });
    }
    let overlayBytes = 0;
    for (const [slotId, entry] of projected) {
      overlayBytes += canonicalJsonBytes({ slotId, presence: entry.presence, content: entry.content }).length;
    }
    if (overlayBytes > this.contract.limits.draft.maxDraftBytes) {
      return fail('DRAFT_LIMIT_EXCEEDED', 'the draft overlay exceeds maxDraftBytes', {
        issues: [makeStructuredIssue('RESOURCE_LIMIT_EXCEEDED', 'draft', { kind: 'operation' }, { limit: 'maxDraftBytes' })],
      });
    }
    return null;
  }

  /** Records ONE tool signature (canonical args hash + result) + the meter. */
  private async recordOp(draftId: string, ctx: FillToolContext, result: JsonValue): Promise<void> {
    await this.store.recordDraftTool(draftId, ctx.toolCallId, ctx.canonicalArgsHash, result);
    await this.meter.recordToolResult({ toolCallId: ctx.toolCallId, canonicalArgsHash: ctx.canonicalArgsHash, result });
  }

  /** Converts the private overlay to the Task 10 projection overlay shape. */
  private overlayFor(view: DraftView): DraftContentOverlayV1 {
    const overlay: DraftContentOverlayV1 = {};
    for (const [slotId, entry] of view.overlay) {
      overlay[slotId] = entry.presence === 'set' ? { presence: 'set', content: entry.content } : { presence: 'unset' };
    }
    return overlay;
  }

  private async activeScaffold(): Promise<ActiveScaffoldState | null> {
    const state = projectStructuredSlotState(await this.events());
    if (state.generationId === null || state.scaffoldId === null || state.contentRevision === null) {
      return null;
    }
    return {
      scaffoldId: state.scaffoldId,
      generationId: state.generationId,
      contentRevision: state.contentRevision,
      content: state.content,
    };
  }

  /** Full scaffold with the overlay applied (Merge Gate input). */
  private async buildEffectiveSlots(
    active: ActiveScaffoldState,
    overlay: ReadonlyMap<string, DraftOverlayEntry>,
  ): Promise<GateSlotInput[] | null> {
    const index = await this.blobStore.getGenerationIndex(active.generationId);
    const slots: GateSlotInput[] = [];
    for (const slotId of index.documentOrder) {
      const slot = await this.blobStore.readSlot(active.generationId, slotId);
      if (slot === null) return null;
      const overlayEntry = overlay.get(slotId);
      const presence = overlayEntry?.presence ?? slot.contentPresence;
      const content = overlayEntry !== undefined
        ? overlayEntry.presence === 'set'
          ? overlayEntry.content
          : null
        : slot.contentPresence === 'set'
          ? (slot.content ?? null)
          : null;
      slots.push({
        slotId,
        parentSlotId: slot.parentSlotId,
        order: slot.order,
        typeId: slot.typeId,
        spec: slot.spec,
        contentPresence: presence,
        content,
      });
    }
    return slots;
  }

  /** Content schema of every changed slot (design §14.3 check 6). */
  private checkChangedContentSchemas(
    slots: readonly GateSlotInput[],
    changedSlotIds: readonly string[],
  ): StructuredIssueV1[] {
    const issues: StructuredIssueV1[] = [];
    const typeById = new Map(this.contract.slotTypes.map((t) => [t.id, t]));
    const bySlot = new Map(slots.map((s) => [s.slotId, s]));
    for (const slotId of changedSlotIds) {
      const slot = bySlot.get(slotId);
      if (slot === undefined) continue;
      const type = typeById.get(slot.typeId);
      if (type === undefined || type.content.presence === 'forbidden') continue;
      if (slot.contentPresence !== 'set') continue; // unset is not a value to validate
      const location: IssueLocation = { kind: 'slot', slotId, field: 'content', valuePointer: '' };
      issues.push(...validateSlotValue(type.content.schema, slot.content, location, 'merge'));
    }
    return issues;
  }

  /**
   * Stages the NEW content root (base mappings + overlay) as a content-addressed
   * blob WITHOUT promoting authority (design §18.3 G05 / Task 15 promotes).
   * Unreferenced until the committer references it; identical base values reuse
   * their existing digests.
   */
  private async stageContentRoot(
    active: ActiveScaffoldState,
    overlay: ReadonlyMap<string, DraftOverlayEntry>,
  ): Promise<string> {
    let base: Record<string, EffectiveContentEntry> = {};
    if (active.content !== null) {
      base = await this.blobStore.readEffectiveContent(active.content);
    }
    const mappings: Record<string, 'unset' | string> = {};
    for (const [slotId, entry] of Object.entries(base)) {
      mappings[slotId] = entry.presence === 'set' ? (await this.blobStore.putContentValue(entry.content)).sha256 : 'unset';
    }
    for (const [slotId, entry] of overlay) {
      mappings[slotId] = entry.presence === 'set' ? (await this.blobStore.putContentValue(entry.content)).sha256 : 'unset';
    }
    const ref = await this.blobStore.putContentRevision(mappings);
    return ref.sha256;
  }
}
