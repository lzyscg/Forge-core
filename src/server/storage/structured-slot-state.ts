/**
 * Structured slot state projection (Task 7 Step 6, design §18.3, spec §7.4).
 *
 * `projectStructuredSlotState` folds active scaffold/generation/content
 * revision, Draft lifecycle, per-attempt status and Seal status ONLY from
 * validated TaskEvents. It never reads a checkpoint and has no checkpoint
 * input: a checkpoint is at most an accelerator and can never override or
 * compress the committed event history — the projection is a pure, deterministic
 * function of the event list, so every replay yields the identical state.
 *
 * This is the internal authoritative projection (consumed by the runtime,
 * committer and later the public `StructuredSlotsSummaryV1`); it is not a
 * client type, so it lives here rather than in shared/structured-slots.ts.
 */
import type {
  StructuredAttemptReason,
  StructuredAttemptStatus,
  StructuredDraftTerminalStatus,
  StructuredSessionKind,
  TaskEvent,
} from './task-events';
import type { StructuredBlobRefV1 } from '../../shared/structured-slots';

/** One Draft's projected lifecycle (spec §9.2). */
export interface StructuredDraftStateV1 {
  status: StructuredDraftTerminalStatus | 'open';
  turnId: string;
  scaffoldId: string;
  generationId: string;
  baseRevision: number;
  resultRevision: number | null;
  changeCount: number | null;
}

/** One Attempt's projected status (spec §8.1). */
export interface StructuredAttemptStateV1 {
  status: StructuredAttemptStatus | 'running';
  sessionKind: StructuredSessionKind | null;
  inputNodeId: string;
  attemptEpoch: number;
  agentId: string | null;
  reason: StructuredAttemptReason | null;
}

/** Event-derived structured slot state (spec §7.4/§14). */
export interface StructuredSlotStateV1 {
  version: 1;
  mode: 'structured_slots';
  scaffoldId: string | null;
  generationId: string | null;
  /** Current content revision number (0 at generation commit). */
  contentRevision: number | null;
  structureStatus: 'none' | 'active';
  sealStatus: 'unsealed' | 'sealed';
  /** Content-addressed structure blob of the active generation. */
  structure: StructuredBlobRefV1 | null;
  /** Content-addressed content root of the active revision. */
  content: StructuredBlobRefV1 | null;
  /** draftId -> projected lifecycle. */
  drafts: Record<string, StructuredDraftStateV1>;
  /** turnId -> projected attempt status. */
  attempts: Record<string, StructuredAttemptStateV1>;
}

/**
 * Folds the committed event list into the structured slot state. Events must
 * be in committed sequence order (as the event store returns them); the fold
 * is idempotent and deterministic, so a checkpoint can never override it.
 */
export function projectStructuredSlotState(events: readonly TaskEvent[]): StructuredSlotStateV1 {
  const state: StructuredSlotStateV1 = {
    version: 1,
    mode: 'structured_slots',
    scaffoldId: null,
    generationId: null,
    contentRevision: null,
    structureStatus: 'none',
    sealStatus: 'unsealed',
    structure: null,
    content: null,
    drafts: {},
    attempts: {},
  };
  for (const event of events) {
    switch (event.type) {
      case 'structured_scaffold_generation_committed':
        // A new generation supersedes the previous active one; the commit
        // event is the only writer of active structure identity.
        state.scaffoldId = event.scaffoldId;
        state.generationId = event.generationId;
        state.contentRevision = event.contentRevision;
        state.structureStatus = 'active';
        state.structure = event.structure;
        state.content = event.content;
        break;
      case 'structured_fill_draft_opened':
        state.drafts[event.draftId] = {
          status: 'open',
          turnId: event.turnId,
          scaffoldId: event.scaffoldId,
          generationId: event.generationId,
          baseRevision: event.baseRevision,
          resultRevision: null,
          changeCount: null,
        };
        break;
      case 'structured_fill_draft_terminal': {
        const existing = state.drafts[event.draftId];
        state.drafts[event.draftId] = {
          status: event.status,
          turnId: existing?.turnId ?? event.turnId,
          scaffoldId: existing?.scaffoldId ?? '',
          generationId: existing?.generationId ?? '',
          baseRevision: event.baseRevision,
          resultRevision: event.resultRevision,
          changeCount: event.changeCount,
        };
        if (event.status === 'merged') {
          // Merging advances the active content revision; a no-op merge (no
          // content blob) keeps the revision's root unchanged.
          state.contentRevision = event.resultRevision;
          if (event.content !== null) {
            state.content = event.content;
          }
        }
        break;
      }
      case 'structured_scaffold_sealed':
        // v1 has no unseal path: once sealed the scaffold stays sealed.
        state.sealStatus = 'sealed';
        break;
      case 'structured_slot_attempt_started':
        state.attempts[event.turnId] = {
          status: 'running',
          sessionKind: event.sessionKind,
          inputNodeId: event.inputNodeId,
          attemptEpoch: event.attemptEpoch,
          agentId: event.agentId,
          reason: null,
        };
        break;
      case 'structured_slot_attempt_terminal': {
        const existing = state.attempts[event.turnId];
        state.attempts[event.turnId] = {
          status: event.status,
          sessionKind: existing?.sessionKind ?? null,
          inputNodeId: existing?.inputNodeId ?? event.inputNodeId,
          attemptEpoch: existing?.attemptEpoch ?? event.attemptEpoch,
          agentId: existing?.agentId ?? null,
          reason: event.reason,
        };
        break;
      }
      default:
        // Non-structured events never disturb the structured projection.
        break;
    }
  }
  return state;
}
