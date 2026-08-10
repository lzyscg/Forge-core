/**
 * Structure + fill session service — the session state and dispatch-guard
 * foundation (Tasks 12-13, design §11.3, spec §9.1/§9.2).
 *
 * - `StructureSessionState` / `FillSessionState` are the current turn's
 *   structure/fill session: the session kind, the bound grant, the
 *   proposal/draft + candidate reference and the `completion`. A formed
 *   candidate means the session is LOCKED (no more write/submit) and the
 *   completion is `structure_commit_candidate_created` / `merge_candidate_created`;
 *   the safe receipt is the only summary exposed to the model.
 * - `assertStructuredForgeAction(state, action)` is the dispatch-guard
 *   foundation: before a ForgeAction is proposed to the ActionBuffer it is
 *   validated against the session completion. After either candidate only
 *   `send_message` (the completion dispatch) is legal; `request_human_input`
 *   remains the exclusive abandon exit and is always legal before the
 *   completion dispatch. `forward_input_version` / `annotate_artifact` never
 *   end a v3 fill turn. Task 14 wires this into the tool/action pipeline.
 * - `getStructureStatus(grant)` / `getFillStatus(grant)` are the lifecycle
 *   summaries (open / candidate_created / committed / abandoned, and open /
 *   candidate_created / merged / stale / abandoned) reconciling TaskEvents
 *   over the private journal — Task 7 authority, never the private store
 *   alone.
 * - `createStructuredSlotDataSource` adapts the Task 7 blob store + state
 *   projection to the Task 10 `StructuredSlotDataSource` seam.
 *
 * This module carries zero business vocabulary (iron rule 1).
 */
import type { FillSessionGrantV1, StructureSessionGrantV1 } from '../../../shared/structured-slots';
import type { ForgeAction } from '../forge-actions';
import type {
  DraftLifecycle,
  DraftView,
  MergeCommitCandidate,
  ProposalLifecycle,
  ProposalView,
  StructureCommitCandidate,
} from '../../storage/structured-slot-private-store';
import { StructuredSlotPrivateStore } from '../../storage/structured-slot-private-store';
import { StructuredSlotBlobStore } from '../../storage/structured-slot-blob-store';
import { projectStructuredSlotState } from '../../storage/structured-slot-state';
import type { TaskEvent } from '../../storage/task-events';
import type { GrantResolutionErrorCode } from './grant-service';
import type { StructuredSlotDataSource } from './projection-service';
import type { StructureSafeReceiptV1, StructureSessionStatus } from './proposal-service';
import type { FillDraftSessionStatus, FillSafeReceiptV1 } from './draft-service';

export type { StructureSessionStatus, StructureSafeReceiptV1 } from './proposal-service';
export type { FillDraftSessionStatus, FillSafeReceiptV1 } from './draft-service';

/** The single structure completion (design §11.3 matrix). */
export type StructureCompletion = 'structure_commit_candidate_created';

/** The single fill completion (design §11.3 matrix). */
export type FillCompletion = 'merge_candidate_created';

/** The current turn's structure session state. */
export interface StructureSessionState {
  version: 1;
  sessionKind: 'structure';
  turnId: string;
  grant: StructureSessionGrantV1 | null;
  proposalId: string;
  proposalLifecycle: ProposalLifecycle;
  candidate: StructureCommitCandidate | null;
  /** Set once a candidate is formed; the session is then locked. */
  completion: StructureCompletion | null;
  /** The safe summary exposed to the model (candidate formed). */
  receipt: StructureSafeReceiptV1 | null;
  /** Candidate formed => locked: no more write/submit. */
  locked: boolean;
}

/** The current turn's fill session state. */
export interface FillSessionState {
  version: 1;
  sessionKind: 'fill';
  turnId: string;
  grant: FillSessionGrantV1 | null;
  draftId: string;
  draftLifecycle: DraftLifecycle;
  candidate: MergeCommitCandidate | null;
  /** Set once a merge candidate is formed; the session is then locked. */
  completion: FillCompletion | null;
  /** The safe summary exposed to the model (candidate formed). */
  receipt: FillSafeReceiptV1 | null;
  /** Candidate formed => locked: no more write/submit. */
  locked: boolean;
}

/** Either pre-seal session kind the dispatch guard understands. */
export type StructuredSessionState = StructureSessionState | FillSessionState;

/** Stable guard failures for the structure dispatch. */
export type StructureGuardFailureCode = 'STRUCTURE_ACTION_NOT_ALLOWED';

export type StructureGuardResult =
  | { ok: true }
  | { ok: false; code: StructureGuardFailureCode; reason: string };

export interface SessionServiceOptions {
  taskId: string;
  snapshotHash: string;
  store: StructuredSlotPrivateStore;
  events: () => Promise<readonly TaskEvent[]>;
}

export type OpenSessionResult = { ok: true; state: StructureSessionState } | { ok: false; code: GrantResolutionErrorCode; reason: string };

export type StructureStatusResult =
  | { ok: true; status: StructureSessionStatus; receipt: StructureSafeReceiptV1 }
  | { ok: false; code: GrantResolutionErrorCode; reason: string };

export type OpenFillSessionResult = { ok: true; state: FillSessionState } | { ok: false; code: GrantResolutionErrorCode; reason: string };

export type FillStatusResult =
  | { ok: true; status: FillDraftSessionStatus; receipt: FillSafeReceiptV1 }
  | { ok: false; code: GrantResolutionErrorCode; reason: string };

function fail(code: GrantResolutionErrorCode, reason: string): { ok: false; code: GrantResolutionErrorCode; reason: string } {
  return { ok: false, code, reason };
}

function countNodes(tree: StructureCommitCandidate['normalizedTree'] | null): number {
  if (tree === null) return 0;
  let count = 0;
  const walk = (node: StructureCommitCandidate['normalizedTree']): void => {
    count += 1;
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return count;
}

function statusReceipt(status: StructureSessionStatus, changeCount: number): StructureSafeReceiptV1 {
  return {
    kind: 'structure',
    status,
    changeCount,
    issueSummary: { errors: 0, warnings: 0 },
  };
}

function statusFromView(view: ProposalView): StructureSessionStatus {
  if (view.lifecycle === 'committed') return 'committed';
  if (view.lifecycle === 'abandoned') return 'abandoned';
  if (view.candidate !== null) return 'candidate_created';
  return 'open';
}

function fillStatusFromView(view: DraftView): FillDraftSessionStatus {
  if (view.lifecycle === 'merged') return 'merged';
  if (view.lifecycle === 'stale') return 'stale';
  if (view.lifecycle === 'abandoned') return 'abandoned';
  if (view.candidate !== null) return 'candidate_created';
  return 'open';
}

function fillReceiptFor(status: FillDraftSessionStatus, changeCount: number): FillSafeReceiptV1 {
  return { kind: 'fill', status, changeCount, issueSummary: { errors: 0, warnings: 0 } };
}

/**
 * Structure session service bound to one production case (task): derives the
 * session state and the lifecycle status from the private journal + the
 * committed TaskEvents (Task 7 authority reconciliation).
 */
export class StructuredSlotSessionService {
  private readonly taskId: string;

  private readonly snapshotHash: string;

  private readonly store: StructuredSlotPrivateStore;

  private readonly events: () => Promise<readonly TaskEvent[]>;

  constructor(options: SessionServiceOptions) {
    this.taskId = options.taskId;
    this.snapshotHash = options.snapshotHash;
    this.store = options.store;
    this.events = options.events;
  }

  /** Builds the current structure-session state from the private store + events. */
  async openSession(grant: StructureSessionGrantV1): Promise<OpenSessionResult> {
    const view = await this.store.readProposal(grant.proposalId, await this.events());
    const grantCheck = this.assertGrant(grant, view);
    if (!grantCheck.ok) return grantCheck;
    const state: StructureSessionState = {
      version: 1,
      sessionKind: 'structure',
      turnId: grant.turnId,
      grant,
      proposalId: grant.proposalId,
      proposalLifecycle: view.lifecycle,
      candidate: view.candidate,
      completion: view.candidate !== null ? 'structure_commit_candidate_created' : null,
      receipt: view.candidate !== null ? statusReceipt('candidate_created', view.candidate.slotCount) : null,
      locked: view.locked,
    };
    return { ok: true, state };
  }

  /**
   * Lifecycle summary (open / candidate_created / committed / abandoned)
   * reconciling TaskEvents over the private journal (design §9.3 / Task 7
   * authority reconciliation). Never consults the private store alone for a
   * terminal.
   */
  async getStructureStatus(grant: StructureSessionGrantV1): Promise<StructureStatusResult> {
    const view = await this.store.readProposal(grant.proposalId, await this.events());
    const grantCheck = this.assertGrant(grant, view);
    if (!grantCheck.ok) return grantCheck;
    const status = statusFromView(view);
    const changeCount = view.candidate !== null ? view.candidate.slotCount : countNodes(view.tree);
    return { ok: true, status, receipt: statusReceipt(status, changeCount) };
  }

  /** Builds the current fill-session state from the private store + events. */
  async openFillSession(grant: FillSessionGrantV1): Promise<OpenFillSessionResult> {
    const view = await this.store.readDraft(grant.draftId, await this.events());
    const grantCheck = this.assertFillGrant(grant, view);
    if (!grantCheck.ok) return grantCheck;
    const state: FillSessionState = {
      version: 1,
      sessionKind: 'fill',
      turnId: grant.turnId,
      grant,
      draftId: grant.draftId,
      draftLifecycle: view.lifecycle,
      candidate: view.candidate,
      completion: view.candidate !== null ? 'merge_candidate_created' : null,
      receipt: view.candidate !== null ? fillReceiptFor('candidate_created', view.candidate.changeCount) : null,
      locked: view.locked,
    };
    return { ok: true, state };
  }

  /**
   * Fill lifecycle summary (open / candidate_created / merged / stale /
   * abandoned) reconciling TaskEvents over the private journal (design §13 /
   * Task 7 authority). Never consults the private store alone for a terminal.
   */
  async getFillStatus(grant: FillSessionGrantV1): Promise<FillStatusResult> {
    const view = await this.store.readDraft(grant.draftId, await this.events());
    const grantCheck = this.assertFillGrant(grant, view);
    if (!grantCheck.ok) return grantCheck;
    const status = fillStatusFromView(view);
    const changeCount = view.candidate !== null ? view.candidate.changeCount : view.overlay.size;
    return { ok: true, status, receipt: fillReceiptFor(status, changeCount) };
  }

  private assertFillGrant(
    grant: FillSessionGrantV1,
    view: DraftView,
  ): { ok: true } | { ok: false; code: GrantResolutionErrorCode; reason: string } {
    if (grant.kind !== 'fill') return fail('GRANT_INVALID', 'the grant is not a fill grant');
    if (grant.caseId !== this.taskId) return fail('GRANT_INVALID', 'the grant is bound to a different task');
    if (grant.snapshotHash !== this.snapshotHash) {
      return fail('GRANT_INVALID', 'the grant is bound to a different snapshot');
    }
    // A fill grant must reference a Draft actually opened for its attempt. A
    // never-materialized Draft (empty private state, turnId '') is GRANT_INVALID.
    if (grant.draftId !== view.draftId || view.turnId !== grant.turnId) {
      return fail('GRANT_INVALID', 'the grant is bound to a draft that does not exist for this attempt');
    }
    return { ok: true };
  }

  private assertGrant(
    grant: StructureSessionGrantV1,
    view: ProposalView,
  ): { ok: true } | { ok: false; code: GrantResolutionErrorCode; reason: string } {
    if (grant.kind !== 'structure') return fail('GRANT_INVALID', 'the grant is not a structure grant');
    if (grant.caseId !== this.taskId) return fail('GRANT_INVALID', 'the grant is bound to a different task');
    if (grant.snapshotHash !== this.snapshotHash) {
      return fail('GRANT_INVALID', 'the grant is bound to a different snapshot');
    }
    // A structure grant must reference a Proposal that was actually created for
    // its attempt (design §9.1: the Proposal precedes the Grant). A never-
    // materialized Proposal (empty private state, turnId '') is GRANT_INVALID.
    if (grant.proposalId !== view.proposalId || view.turnId !== grant.turnId) {
      return fail('GRANT_INVALID', 'the grant is bound to a proposal that does not exist for this attempt');
    }
    return { ok: true };
  }
}

/**
 * Dispatch-guard foundation for structure AND fill (design §11.3): before a
 * ForgeAction is proposed to the ActionBuffer, validate it against the session
 * completion.
 *
 * - After `structure_commit_candidate_created` / `merge_candidate_created`
 *   only `send_message` (the completion dispatch) is legal;
 *   `request_human_input` remains the exclusive abandon exit.
 * - Before a candidate there is NO completion dispatch — only the exclusive
 *   `request_human_input` abandon exit is legal.
 * - `forward_input_version` / `annotate_artifact` are Seal-after v2 actions and
 *   never end a v3 structure/fill turn.
 *
 * Task 14 wires this into the tool/action pipeline.
 */
export function assertStructuredForgeAction(state: StructuredSessionState, action: ForgeAction): StructureGuardResult {
  if (action.type === 'request_human_input') {
    return { ok: true };
  }
  if (state.completion !== null && action.type === 'send_message') {
    return { ok: true };
  }
  return {
    ok: false,
    code: 'STRUCTURE_ACTION_NOT_ALLOWED',
    reason:
      state.completion === null
        ? 'a structured session may only end in send_message after a candidate is formed, or abandon via request_human_input'
        : 'after a candidate is created only send_message is legal (request_human_input remains the abandon exit)',
  };
}

/**
 * Adapts the Task 7 store to the Task 10 `StructuredSlotDataSource` seam:
 * active generation from `projectStructuredSlotState`, generation index and
 * slot reads from the blob store, content presence through
 * `readEffectiveContent`. Structure sessions have no active scaffold, so the
 * adapter simply reports `null`/empty while `no_scaffold` holds.
 */
export function createStructuredSlotDataSource(options: {
  blobStore: StructuredSlotBlobStore;
  events: () => Promise<readonly TaskEvent[]>;
}): StructuredSlotDataSource {
  return {
    async getActiveGeneration() {
      const state = projectStructuredSlotState(await options.events());
      if (state.generationId === null) return null;
      return {
        scaffoldId: state.scaffoldId as string,
        generationId: state.generationId,
        contentRevision: state.contentRevision as number,
      };
    },
    async getGenerationIndex(generationId: string) {
      return options.blobStore.getGenerationIndex(generationId);
    },
    async getSlot(generationId: string, slotId: string) {
      return options.blobStore.readSlot(generationId, slotId);
    },
    async getContentPresence(generationId: string, revision: number) {
      const state = projectStructuredSlotState(await options.events());
      if (state.generationId !== generationId || state.contentRevision !== revision || state.content === null) {
        return {};
      }
      const effective = await options.blobStore.readEffectiveContent(state.content);
      const presence: Record<string, 'unset' | 'set'> = {};
      for (const [id, entry] of Object.entries(effective)) {
        presence[id] = entry.presence;
      }
      return presence;
    },
  };
}
