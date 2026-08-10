/**
 * Structured slot private store — Proposal/Draft journals, immutable
 * checkpoints and persistent Attempt meter snapshots (Task 7, spec §9.1/§9.2,
 * design §18.2/§18.3).
 *
 * Three-layer boundary, honored exactly (design §18.1/§18.2):
 *
 * - The private journal (`proposals/<id>/journal.ndjson`,
 *   `drafts/<id>/journal.ndjson`) records every private mutation, tool
 *   signature/result and the submission lock, one canonical JSON object per
 *   line. It NEVER records a lifecycle terminal: a Proposal is only
 *   committed/abandoned, and a Draft only merged/stale/abandoned, through a
 *   committed TaskEvent batch. No journal alone can ever make a Draft merged.
 * - Immutable checkpoints (128 operations OR 1 MiB of journal bytes after the
 *   last checkpoint, whichever comes first) capture the full overlay so
 *   checkpoint + tail journal rebuild the same state; the checkpoint is
 *   written atomically and the tail journal starts fresh after it. Ops carry a
 *   global `seq` so a crash between checkpoint write and journal reset is
 *   safe (tail ops with `seq <= checkpoint.opCount` are never re-applied).
 * - Lifecycle is joined to Task 6 events on every read. An optional
 *   post-batch `lifecycle.json` cache marker may be written explicitly AFTER
 *   the authority batch, but it is never authority: reads always derive the
 *   terminal from the passed events and delete a stale/contradicting marker.
 *
 * Attempt meter snapshots (`attempts/<turnId>/meter.json`) are an opaque
 * durable snapshot (Task 11 owns the meter logic; this store only persists and
 * reads the bytes).
 *
 * No business vocabulary lives here (iron rule 1): slot/object/turn ids and
 * op names are stable platform identifiers; errors use the shared public
 * StorageError contract (iron rule 6).
 */
import { appendFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CorePaths } from './core-paths';
import { STORAGE_ERROR_CODES, StorageError, writeReplaceAtomic } from './atomic-file';
import { canonicalJson, canonicalJsonBytes } from '../structured-slots/canonical-json';
import type { JsonObject, JsonValue } from '../../shared/structured-slots';
import type { TaskEvent } from './task-events';

/** Proposal submission/lifecycle terminal (event-derived, never private). */
export type ProposalLifecycle = 'open' | 'committed' | 'abandoned';

/** Draft lifecycle terminal (event-derived, never private). */
export type DraftLifecycle = 'open' | 'merged' | 'stale' | 'abandoned';

/** Whole-tree Proposal candidate (spec §9.1): no content/slotId/ACL fields. */
export interface ProposalNode {
  clientKey: string;
  typeId: string;
  spec: JsonObject;
  children: ProposalNode[];
}

/**
 * Turn-bound structure commit candidate (design §9.3, spec §9.1). Formed by
 * the Structure Gate and stored in PRIVATE state only — it is never written to
 * a TaskEvent (Task 15's committer creates the generation). The `slotId`
 * mapping is derived from `scaffoldId + generationId + instancePath`, never
 * from `clientKey`, and is frozen here until the committer promotes it. The
 * candidate itself carries no scaffoldId/revision/grant internals.
 */
export interface StructureCommitCandidate {
  taskId: string;
  turnId: string;
  proposalId: string;
  snapshotHash: string;
  generationId: string;
  rootSlotId?: string;
  slotCount: number;
  slotIdByClientKey: Record<string, string>;
  normalizedTree: ProposalNode;
  contentRevision: 0;
}

/** Draft binding context supplied from the `draft_opened` event. */
export interface DraftContext {
  scaffoldId: string;
  generationId: string;
  baseRevision: number;
}

/** One journaled tool signature/result (Task 7 Step 5; meter logic in Task 11). */
export interface ToolRecord {
  toolCallId: string;
  argsHash: string;
  result: JsonValue;
}

/** One private draft overlay entry: explicit presence, never a silent default. */
export interface DraftOverlayEntry {
  presence: 'unset' | 'set';
  content: JsonValue | null;
}

export interface ProposalView {
  proposalId: string;
  turnId: string;
  lifecycle: ProposalLifecycle;
  locked: boolean;
  opCount: number;
  tree: ProposalNode | null;
  candidate: StructureCommitCandidate | null;
  toolRecords: ToolRecord[];
}

export interface DraftView {
  draftId: string;
  turnId: string;
  scaffoldId: string;
  generationId: string;
  baseRevision: number;
  lifecycle: DraftLifecycle;
  locked: boolean;
  opCount: number;
  overlay: Map<string, DraftOverlayEntry>;
  toolRecords: ToolRecord[];
}

/** Private-store tuning; defaults are the plan-frozen production values. */
export interface StructuredSlotPrivateStoreOptions {
  /** Checkpoint after this many tail-journal operations (default 128). */
  checkpointOpThreshold?: number;
  /** Checkpoint after this many tail-journal bytes (default 1 MiB). */
  checkpointByteThreshold?: number;
}

const DEFAULT_OP_THRESHOLD = 128;
const DEFAULT_BYTE_THRESHOLD = 1024 * 1024;

const CHECKPOINT_KIND = { proposal: 'proposal', draft: 'draft' } as const;

type ObjectKind = keyof typeof CHECKPOINT_KIND;

interface JournalOp {
  seq: number;
  op: 'materialize' | 'replace' | 'candidate' | 'replace_content' | 'unset_content' | 'lock' | 'tool';
  at: string;
  turnId?: string;
  tree?: ProposalNode | null;
  candidate?: StructureCommitCandidate | null;
  slotId?: string;
  value?: JsonValue;
  toolCallId?: string;
  argsHash?: string;
  result?: JsonValue;
  scaffoldId?: string;
  generationId?: string;
  baseRevision?: number;
}

interface ProposalPrivateState {
  kind: 'proposal';
  id: string;
  opCount: number;
  locked: boolean;
  turnId: string;
  tree: ProposalNode | null;
  candidate: StructureCommitCandidate | null;
  toolRecords: ToolRecord[];
}

interface DraftPrivateState {
  kind: 'draft';
  id: string;
  opCount: number;
  locked: boolean;
  turnId: string;
  scaffoldId: string;
  generationId: string;
  baseRevision: number;
  overlay: Map<string, DraftOverlayEntry>;
  toolRecords: ToolRecord[];
}

type PrivateState = ProposalPrivateState | DraftPrivateState;

interface PrivateCheckpointV1 {
  version: 1;
  kind: 'proposal' | 'draft';
  opCount: number;
  locked: boolean;
  turnId: string;
  tree?: ProposalNode | null;
  candidate?: StructureCommitCandidate | null;
  overlay?: Record<string, DraftOverlayEntry>;
  scaffoldId?: string;
  generationId?: string;
  baseRevision?: number;
  toolRecords: ToolRecord[];
}

interface LifecycleMarkerV1 {
  version: 1;
  status: string;
  eventId: string;
}

function invalidInput(message: string): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.INVALID_INPUT,
    message,
    null,
    '修正写入后重试。',
  );
}

function corrupt(message: string): StorageError {
  return new StorageError(
    STORAGE_ERROR_CODES.TASK_CORRUPTED,
    message,
    null,
    '检查该任务的结构化存储目录。',
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function now(): string {
  return new Date().toISOString();
}

function assertNonEmptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidInput(`${where} 必须是非空字符串。`);
  }
  return value;
}

function assertNonNegativeInteger(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidInput(`${where} 必须是不小于 0 的整数。`);
  }
  return value;
}

/**
 * Draft lifecycle from committed TaskEvents: the LAST matching terminal wins.
 * Never consults the private journal — no private state can manufacture a
 * terminal.
 */
export function resolveDraftLifecycle(draftId: string, events: readonly TaskEvent[]): DraftLifecycle {
  let lifecycle: DraftLifecycle = 'open';
  for (const event of events) {
    if (event.type === 'structured_fill_draft_terminal' && event.draftId === draftId) {
      lifecycle = event.status;
    }
  }
  return lifecycle;
}

/**
 * Proposal lifecycle from committed TaskEvents: a committed generation wins
 * over a later abandoned/failed attempt on the proposal's turn; without either
 * the proposal stays open.
 */
export function resolveProposalLifecycle(
  proposalId: string,
  turnId: string,
  events: readonly TaskEvent[],
): ProposalLifecycle {
  let committed = false;
  let abandoned = false;
  for (const event of events) {
    if (event.type === 'structured_scaffold_generation_committed' && event.proposalId === proposalId) {
      committed = true;
    }
    if (
      event.type === 'structured_slot_attempt_terminal' &&
      event.turnId === turnId &&
      (event.status === 'abandoned' || event.status === 'failed')
    ) {
      abandoned = true;
    }
  }
  if (committed) {
    return 'committed';
  }
  if (abandoned) {
    return 'abandoned';
  }
  return 'open';
}

function emptyState(kind: ObjectKind, id: string): PrivateState {
  if (kind === 'proposal') {
    return { kind, id, opCount: 0, locked: false, turnId: '', tree: null, candidate: null, toolRecords: [] };
  }
  return {
    kind,
    id,
    opCount: 0,
    locked: false,
    turnId: '',
    scaffoldId: '',
    generationId: '',
    baseRevision: 0,
    overlay: new Map(),
    toolRecords: [],
  };
}

function applyOp(state: PrivateState, op: JournalOp): void {
  switch (state.kind) {
    case 'proposal':
      switch (op.op) {
        case 'materialize':
          state.turnId = op.turnId ?? state.turnId;
          break;
        case 'replace':
          state.tree = op.tree ?? null;
          break;
        case 'candidate':
          state.candidate = op.candidate ?? null;
          break;
        case 'lock':
          state.locked = true;
          break;
        case 'tool':
          state.toolRecords.push({
            toolCallId: assertNonEmptyString(op.toolCallId, 'toolCallId'),
            argsHash: assertNonEmptyString(op.argsHash, 'argsHash'),
            result: (op.result as JsonValue) ?? null,
          });
          break;
        default:
          break;
      }
      break;
    case 'draft':
      switch (op.op) {
        case 'materialize':
          state.turnId = op.turnId ?? state.turnId;
          state.scaffoldId = op.scaffoldId ?? state.scaffoldId;
          state.generationId = op.generationId ?? state.generationId;
          state.baseRevision = op.baseRevision ?? state.baseRevision;
          break;
        case 'replace_content':
          state.overlay.set(op.slotId as string, { presence: 'set', content: (op.value as JsonValue) ?? null });
          break;
        case 'unset_content':
          state.overlay.set(op.slotId as string, { presence: 'unset', content: null });
          break;
        case 'lock':
          state.locked = true;
          break;
        case 'tool':
          state.toolRecords.push({
            toolCallId: assertNonEmptyString(op.toolCallId, 'toolCallId'),
            argsHash: assertNonEmptyString(op.argsHash, 'argsHash'),
            result: (op.result as JsonValue) ?? null,
          });
          break;
        default:
          break;
      }
      break;
  }
}

function toCheckpoint(state: PrivateState): PrivateCheckpointV1 {
  if (state.kind === 'proposal') {
    return {
      version: 1,
      kind: 'proposal',
      opCount: state.opCount,
      locked: state.locked,
      turnId: state.turnId,
      tree: state.tree,
      candidate: state.candidate,
      toolRecords: state.toolRecords,
    };
  }
  return {
    version: 1,
    kind: 'draft',
    opCount: state.opCount,
    locked: state.locked,
    turnId: state.turnId,
    scaffoldId: state.scaffoldId,
    generationId: state.generationId,
    baseRevision: state.baseRevision,
    overlay: Object.fromEntries([...state.overlay.entries()]),
    toolRecords: state.toolRecords,
  };
}

function stateFromCheckpoint(cp: PrivateCheckpointV1, id: string): PrivateState {
  if (cp.kind === 'proposal') {
    return {
      kind: 'proposal',
      id,
      opCount: cp.opCount,
      locked: cp.locked,
      turnId: cp.turnId,
      tree: cp.tree ?? null,
      candidate: cp.candidate ?? null,
      toolRecords: cp.toolRecords,
    };
  }
  return {
    kind: 'draft',
    id,
    opCount: cp.opCount,
    locked: cp.locked,
    turnId: cp.turnId,
    scaffoldId: cp.scaffoldId ?? '',
    generationId: cp.generationId ?? '',
    baseRevision: cp.baseRevision ?? 0,
    overlay: new Map(Object.entries(cp.overlay ?? {})),
    toolRecords: cp.toolRecords,
  };
}

export class StructuredSlotPrivateStore {
  private readonly paths: CorePaths;

  private readonly taskId: string;

  private readonly checkpointOpThreshold: number;

  private readonly checkpointByteThreshold: number;

  constructor(paths: CorePaths, taskId: string, options: StructuredSlotPrivateStoreOptions = {}) {
    this.paths = paths;
    this.taskId = taskId;
    this.checkpointOpThreshold = options.checkpointOpThreshold ?? DEFAULT_OP_THRESHOLD;
    this.checkpointByteThreshold = options.checkpointByteThreshold ?? DEFAULT_BYTE_THRESHOLD;
  }

  // ---------------------------------------------------------------- Proposal

  /** Get-or-create an open Proposal bound to the turn (idempotent). */
  async materializeProposal(turnId: string, proposalId: string): Promise<ProposalView> {
    assertNonEmptyString(turnId, 'turnId');
    assertNonEmptyString(proposalId, 'proposalId');
    if (await this.objectExists('proposal', proposalId)) {
      await this.assertBoundTurn('proposal', proposalId, turnId);
    } else {
      await this.append('proposal', proposalId, { op: 'materialize', at: now(), turnId });
    }
    return this.readProposal(proposalId, []);
  }

  /** Replaces the whole Proposal tree (open objects only). */
  async replaceProposal(proposalId: string, tree: ProposalNode): Promise<void> {
    assertNonEmptyString(proposalId, 'proposalId');
    assertProposalNode(tree);
    await this.append('proposal', proposalId, { op: 'replace', at: now(), tree });
  }

  /** Submission lock: post-lock writes reject (candidate freezes). */
  async lockProposal(proposalId: string): Promise<void> {
    await this.append('proposal', proposalId, { op: 'lock', at: now() });
  }

  /**
   * Freezes the turn-bound structure candidate into the private journal
   * (design §9.3 / spec §9.1). The candidate is PRIVATE state — never a
   * TaskEvent; Task 15's committer creates the generation from it. Written
   * before the lock so the lock op can still follow. Rejected once locked.
   */
  async storeProposalCandidate(proposalId: string, candidate: StructureCommitCandidate): Promise<void> {
    assertNonEmptyString(proposalId, 'proposalId');
    if (!isPlainObject(candidate)) {
      throw invalidInput('Proposal candidate 必须是对象。');
    }
    await this.append('proposal', proposalId, { op: 'candidate', at: now(), candidate });
  }

  /** Journals a tool signature/result against an open Proposal. */
  async recordProposalTool(
    proposalId: string,
    toolCallId: string,
    argsHash: string,
    result: JsonValue,
  ): Promise<void> {
    await this.append('proposal', proposalId, {
      op: 'tool',
      at: now(),
      toolCallId: assertNonEmptyString(toolCallId, 'toolCallId'),
      argsHash: assertNonEmptyString(argsHash, 'argsHash'),
      result,
    });
  }

  /** Reads a Proposal, deriving lifecycle from the committed events. */
  async readProposal(proposalId: string, events: readonly TaskEvent[]): Promise<ProposalView> {
    assertNonEmptyString(proposalId, 'proposalId');
    const { state } = await this.load('proposal', proposalId);
    const proposal = state as ProposalPrivateState;
    const lifecycle = resolveProposalLifecycle(proposal.id, proposal.turnId, events);
    await this.repairLifecycleMarker('proposal', proposalId, lifecycle);
    return {
      proposalId: proposal.id,
      turnId: proposal.turnId,
      lifecycle,
      locked: proposal.locked,
      opCount: proposal.opCount,
      tree: proposal.tree,
      candidate: proposal.candidate,
      toolRecords: proposal.toolRecords,
    };
  }

  // ------------------------------------------------------------------- Draft

  /** Get-or-create an open Draft for the turn (idempotent by turnId). */
  async materializeDraft(turnId: string, draftId: string, context: DraftContext): Promise<DraftView> {
    assertNonEmptyString(turnId, 'turnId');
    assertNonEmptyString(draftId, 'draftId');
    assertDraftContext(context);
    if (await this.objectExists('draft', draftId)) {
      await this.assertBoundTurn('draft', draftId, turnId);
    } else {
      await this.append('draft', draftId, {
        op: 'materialize',
        at: now(),
        turnId,
        scaffoldId: context.scaffoldId,
        generationId: context.generationId,
        baseRevision: context.baseRevision,
      });
    }
    return this.readDraft(draftId, []);
  }

  /** Sets one slot's content in the private overlay (whole value replace). */
  async replaceContent(draftId: string, slotId: string, value: JsonValue): Promise<void> {
    assertNonEmptyString(draftId, 'draftId');
    assertNonEmptyString(slotId, 'slotId');
    await this.append('draft', draftId, { op: 'replace_content', at: now(), slotId, value });
  }

  /** Marks one slot explicitly unset in the private overlay. */
  async unsetContent(draftId: string, slotId: string): Promise<void> {
    assertNonEmptyString(draftId, 'draftId');
    assertNonEmptyString(slotId, 'slotId');
    await this.append('draft', draftId, { op: 'unset_content', at: now(), slotId });
  }

  /** Submission lock: post-lock overlay writes reject. */
  async lockDraft(draftId: string): Promise<void> {
    await this.append('draft', draftId, { op: 'lock', at: now() });
  }

  /** Journals a tool signature/result against an open Draft. */
  async recordDraftTool(
    draftId: string,
    toolCallId: string,
    argsHash: string,
    result: JsonValue,
  ): Promise<void> {
    await this.append('draft', draftId, {
      op: 'tool',
      at: now(),
      toolCallId: assertNonEmptyString(toolCallId, 'toolCallId'),
      argsHash: assertNonEmptyString(argsHash, 'argsHash'),
      result,
    });
  }

  /** Reads a Draft, deriving lifecycle from the committed events. */
  async readDraft(draftId: string, events: readonly TaskEvent[]): Promise<DraftView> {
    assertNonEmptyString(draftId, 'draftId');
    const { state } = await this.load('draft', draftId);
    const draft = state as DraftPrivateState;
    const lifecycle = resolveDraftLifecycle(draft.id, events);
    await this.repairLifecycleMarker('draft', draftId, lifecycle);
    return {
      draftId: draft.id,
      turnId: draft.turnId,
      scaffoldId: draft.scaffoldId,
      generationId: draft.generationId,
      baseRevision: draft.baseRevision,
      lifecycle,
      locked: draft.locked,
      opCount: draft.opCount,
      overlay: draft.overlay,
      toolRecords: draft.toolRecords,
    };
  }

  // --------------------------------------------------------- Attempt meters

  /** Durably persists an opaque meter snapshot (Task 11 owns the shape). */
  async writeAttemptMeter(turnId: string, snapshot: JsonObject): Promise<void> {
    assertNonEmptyString(turnId, 'turnId');
    if (!isPlainObject(snapshot)) {
      throw invalidInput('attempt meter 快照必须是对象。');
    }
    await writeReplaceAtomic(
      this.paths.taskStructuredAttemptMeterFile(this.taskId, turnId),
      canonicalJsonBytes(snapshot),
    );
  }

  /** Reads a meter snapshot, or null when the attempt wrote none. */
  async readAttemptMeter(turnId: string): Promise<JsonObject | null> {
    assertNonEmptyString(turnId, 'turnId');
    let raw: string;
    try {
      raw = await readFile(this.paths.taskStructuredAttemptMeterFile(this.taskId, turnId), 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isPlainObject(parsed) ? (parsed as JsonObject) : null;
    } catch {
      throw corrupt('attempt meter 快照不是有效 JSON。');
    }
  }

  // ------------------------------------------- Optional lifecycle cache markers

  /**
   * Writes a post-batch lifecycle cache marker. Callers MUST invoke this only
   * AFTER the authority batch committed the terminal; the marker is a pure
   * accelerator, fully derivable from the events and auto-repaired on read.
   */
  async markDraftLifecycleCache(draftId: string, status: DraftLifecycle, eventId: string): Promise<void> {
    await this.writeLifecycleMarker('draft', draftId, status, eventId);
  }

  async clearDraftLifecycleCache(draftId: string): Promise<void> {
    await this.clearLifecycleMarker('draft', draftId);
  }

  async markProposalLifecycleCache(
    proposalId: string,
    status: ProposalLifecycle,
    eventId: string,
  ): Promise<void> {
    await this.writeLifecycleMarker('proposal', proposalId, status, eventId);
  }

  async clearProposalLifecycleCache(proposalId: string): Promise<void> {
    await this.clearLifecycleMarker('proposal', proposalId);
  }

  // ---------------------------------------------------------------- Internal

  private async objectExists(kind: ObjectKind, id: string): Promise<boolean> {
    return (
      (await pathExists(this.checkpointFile(kind, id))) ||
      (await pathExists(this.journalFile(kind, id)))
    );
  }

  private async assertBoundTurn(kind: ObjectKind, id: string, turnId: string): Promise<void> {
    const { state } = await this.load(kind, id);
    if (state.turnId !== '' && state.turnId !== turnId) {
      throw corrupt(`${kind === 'proposal' ? 'Proposal' : 'Draft'} 已绑定不同 turn。`);
    }
  }

  /**
   * Appends one op to the tail journal, checkpointing first when the tail
   * crosses the operation or byte threshold. Mutations are rejected on a
   * locked object (submission lock).
   */
  private async append(kind: ObjectKind, id: string, op: Omit<JournalOp, 'seq'>): Promise<void> {
    const journalFile = this.journalFile(kind, id);
    const { state, checkpointOpCount } = await this.load(kind, id);
    if (state.locked) {
      throw invalidInput(`${kind === 'proposal' ? 'Proposal' : 'Draft'} 已锁定，禁止继续写入。`);
    }
    const tailOps = state.opCount - checkpointOpCount;
    const journalBytes = await this.journalBytes(journalFile);
    if (tailOps >= this.checkpointOpThreshold || journalBytes >= this.checkpointByteThreshold) {
      await writeReplaceAtomic(this.checkpointFile(kind, id), canonicalJsonBytes(toCheckpoint(state)));
      await writeReplaceAtomic(journalFile, Buffer.alloc(0));
    }
    const full: JournalOp = { ...op, seq: state.opCount + 1 };
    applyOp(state, full);
    state.opCount = full.seq;
    await mkdir(dirname(journalFile), { recursive: true });
    await appendFile(journalFile, `${canonicalJson(full)}\n`, 'utf8');
  }

  /** Loads checkpoint + tail journal into a fully applied private state. */
  private async load(kind: ObjectKind, id: string): Promise<{ state: PrivateState; checkpointOpCount: number }> {
    const checkpointFile = this.checkpointFile(kind, id);
    const journalFile = this.journalFile(kind, id);
    let checkpointOpCount = 0;
    let state = emptyState(kind, id);
    if (await pathExists(checkpointFile)) {
      let cp: PrivateCheckpointV1;
      try {
        cp = JSON.parse(await readFile(checkpointFile, 'utf8')) as PrivateCheckpointV1;
      } catch {
        throw corrupt('private checkpoint 不是有效 JSON。');
      }
      if (!isPlainObject(cp) || cp.version !== 1 || cp.kind !== kind) {
        throw corrupt('private checkpoint 版本或类型无效。');
      }
      if (typeof cp.opCount !== 'number' || !Number.isInteger(cp.opCount) || cp.opCount < 0) {
        throw corrupt('private checkpoint opCount 无效。');
      }
      checkpointOpCount = cp.opCount;
      state = stateFromCheckpoint(cp, id);
      state.opCount = checkpointOpCount;
    }
    let raw: string;
    try {
      raw = await readFile(journalFile, 'utf8');
    } catch {
      raw = '';
    }
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') {
        continue;
      }
      let op: JournalOp;
      try {
        op = JSON.parse(line) as JournalOp;
      } catch {
        // A torn tail line is a crash residue and is skipped; an invalid line
        // anywhere else is corruption.
        if (i === lines.length - 1) {
          continue;
        }
        throw corrupt('private journal 含损坏记录。');
      }
      if (!isPlainObject(op) || typeof op.seq !== 'number' || !Number.isInteger(op.seq) || op.seq < 1) {
        throw corrupt('private journal 记录缺少有效 seq。');
      }
      if (op.seq > checkpointOpCount) {
        applyOp(state, op);
        state.opCount = op.seq;
      }
    }
    return { state, checkpointOpCount };
  }

  private async journalBytes(journalFile: string): Promise<number> {
    try {
      return (await stat(journalFile)).size;
    } catch {
      return 0;
    }
  }

  private async repairLifecycleMarker(kind: ObjectKind, id: string, derivedStatus: string): Promise<void> {
    const file = this.lifecycleFile(kind, id);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return;
    }
    try {
      const marker = JSON.parse(raw) as Partial<LifecycleMarkerV1>;
      if (marker.status === derivedStatus) {
        return; // consistent cache marker: kept, never trusted over events
      }
    } catch {
      // fall through to delete
    }
    await rm(file, { force: true }).catch(() => undefined);
  }

  private async writeLifecycleMarker(
    kind: ObjectKind,
    id: string,
    status: string,
    eventId: string,
  ): Promise<void> {
    const marker: LifecycleMarkerV1 = {
      version: 1,
      status: assertNonEmptyString(status, 'status'),
      eventId: assertNonEmptyString(eventId, 'eventId'),
    };
    await writeReplaceAtomic(this.lifecycleFile(kind, id), canonicalJsonBytes(marker));
  }

  private async clearLifecycleMarker(kind: ObjectKind, id: string): Promise<void> {
    await rm(this.lifecycleFile(kind, id), { force: true }).catch(() => undefined);
  }

  private journalFile(kind: ObjectKind, id: string): string {
    return kind === 'proposal'
      ? this.paths.taskStructuredProposalJournalFile(this.taskId, id)
      : this.paths.taskStructuredDraftJournalFile(this.taskId, id);
  }

  private checkpointFile(kind: ObjectKind, id: string): string {
    return kind === 'proposal'
      ? this.paths.taskStructuredProposalCheckpointFile(this.taskId, id)
      : this.paths.taskStructuredDraftCheckpointFile(this.taskId, id);
  }

  private lifecycleFile(kind: ObjectKind, id: string): string {
    return kind === 'proposal'
      ? this.paths.taskStructuredProposalLifecycleFile(this.taskId, id)
      : this.paths.taskStructuredDraftLifecycleFile(this.taskId, id);
  }
}

function assertProposalNode(node: ProposalNode): void {
  if (!isPlainObject(node)) {
    throw invalidInput('Proposal tree 必须是对象。');
  }
  if (typeof node.clientKey !== 'string' || node.clientKey.length === 0) {
    throw invalidInput('Proposal 节点缺少 clientKey。');
  }
  if (typeof node.typeId !== 'string' || node.typeId.length === 0) {
    throw invalidInput('Proposal 节点缺少 typeId。');
  }
  if (!isPlainObject(node.spec)) {
    throw invalidInput('Proposal 节点 spec 必须是对象。');
  }
  if (!Array.isArray(node.children)) {
    throw invalidInput('Proposal 节点 children 必须是数组。');
  }
  for (const child of node.children) {
    assertProposalNode(child);
  }
}

function assertDraftContext(context: DraftContext): void {
  if (!isPlainObject(context)) {
    throw invalidInput('Draft context 必须是对象。');
  }
  assertNonEmptyString(context.scaffoldId, 'context.scaffoldId');
  assertNonEmptyString(context.generationId, 'context.generationId');
  assertNonNegativeInteger(context.baseRevision, 'context.baseRevision');
}
