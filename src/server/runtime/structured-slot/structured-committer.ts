/**
 * Atomic structured commit (Task 15, spec §11, design §11.3/§18.3/§25.6 O03).
 *
 * This is the authority boundary for structured v3 candidates. Every
 * structure / fill / seal-rework / human-abandon candidate becomes ONE atomic
 * TaskEvent batch together with its dispatch; the basic v2 path and its
 * per-event partial replay in `ActionCommitter` stay byte-for-byte.
 *
 * Commit kinds and their single-batch composition (spec §11 dispatch matrix):
 *
 * - structure generation: promoted generation + content-root blobs,
 *   `structured_scaffold_generation_committed` referencing the proposalId,
 *   Agent result, `committed/completion_dispatch` terminal and the message
 *   Route/input — ONE batch. Event projection makes the Proposal committed.
 * - fill merge (nonempty): promoted content root + `merged` Draft terminal
 *   (resultRevision = baseRevision + 1) + Agent result + terminal + message
 *   Route/input — ONE batch; the revision increments exactly once.
 * - fill no-op: `merged` Draft terminal + dispatch, NO content blob and NO
 *   revision bump (`changeCount: 0`).
 * - fill stale: ONE `failed/runtime_failure` terminal + a `stale` Draft
 *   terminal, NO content authority and NO dispatch.
 * - seal rework: a `failed` receipt allows ONLY `send_message` to the frozen
 *   v3 target — Gate-failure Agent result + `committed/rework_dispatch`
 *   terminal + message Route/input — ONE batch; scaffold revision/phase stay
 *   `active_unsealed`.
 * - human: abandon Proposal/Draft/candidate/staging + Agent result +
 *   `waiting_human/human_request` terminal + `human_requested` — ONE batch.
 * - runtime failure / stop / crash: Draft/Attempt authoritative terminal + the
 *   existing failure/lifecycle event — ONE batch.
 *
 * Completion signature + preflight replay (design §25.6 O03 / spec §11):
 * the commitId derives from a canonical signature over
 * `task + turn + snapshot + terminal/result kind + candidate-or-receipt digest
 * + normalized dispatch`. `readBatchByCommitId` is called BEFORE any
 * phase/revision rejection or new event construction; on a hit the persisted
 * stable fields / blob refs / Route are matched to the signature and the
 * EXACT original mapping (original `id`/`at` bytes) is returned. Absent a
 * batch, the events are built from ONE tail snapshot, immutable objects are
 * promoted to their final content-addressed addresses (unreferenced until the
 * batch), and `appendBatch` with the observed tail is the only visibility
 * point. A CAS/idempotency race re-reads the winner and verifies it before
 * deciding replay vs stale/conflict.
 *
 * This module never writes private terminal state before the batch; the
 * private stores are only read for the candidate and for post-batch cache
 * repair by the caller. No business vocabulary lives here (iron rule 1).
 */
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { TurnTracePhase } from '../../../shared/contracts';
import type { StructuredBlobRefV1 } from '../../../shared/structured-slots';
import { STORAGE_ERROR_CODES, StorageError } from '../../storage/atomic-file';
import type { CommittedEvent, EventStore } from '../../storage/event-store';
import type {
  StructuredSlotBlobStore,
  SlotInstance,
} from '../../storage/structured-slot-blob-store';
import type {
  MergeCommitCandidate,
  ProposalNode,
  StructureCommitCandidate,
  StructuredSlotPrivateStore,
} from '../../storage/structured-slot-private-store';
import { projectStructuredSlotState } from '../../storage/structured-slot-state';
import type { ArtifactStore } from '../../storage/artifact-store';
import type {
  StructuredAttemptReason,
  StructuredAttemptStatus,
  TaskEvent,
} from '../../storage/task-events';
import type { FrozenStructuredSlotContractV1 } from '../../template/structured-slot-contract';
import type { FrozenAgentConfig } from '../../template/template-schema';
import { isStructuredTurnContractV3 } from '../../template/template-schema';
import type { ForgeAction } from '../forge-actions';
import { deriveDraftId } from './attempt-coordinator';
import { deriveSlotId, type SubmitStructureContext } from './proposal-service';
import type { SealDispatchStateV1 } from './tool-factory';

/** Stable structured-committer error codes (fail closed; never guessed). */
export const STRUCTURED_COMMIT_ERROR_CODES = {
  ATTEMPT_NOT_ACTIVE: 'ATTEMPT_NOT_ACTIVE',
  CANDIDATE_REQUIRED: 'CANDIDATE_REQUIRED',
  CONTRACT_INVALID: 'CONTRACT_INVALID',
  ROUTE_NOT_ALLOWED: 'ROUTE_NOT_ALLOWED',
  SEAL_RECEIPT_REQUIRED: 'SEAL_RECEIPT_REQUIRED',
  SEAL_CANDIDATE_REQUIRED: 'SEAL_CANDIDATE_REQUIRED',
  DISPATCH_NOT_ALLOWED: 'DISPATCH_NOT_ALLOWED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
} as const;

export type StructuredCommitErrorCode = (typeof STRUCTURED_COMMIT_ERROR_CODES)[keyof typeof STRUCTURED_COMMIT_ERROR_CODES];

/** Typed structured-commit failure; violations are never auto-retryable. */
export class StructuredCommitError extends Error {
  readonly code: StructuredCommitErrorCode;

  readonly retryable = false;

  constructor(code: StructuredCommitErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'StructuredCommitError';
    this.code = code;
  }
}

/** The one structured v3 session kind the committer understands. */
export type StructuredSessionKindV3 = 'structure' | 'fill' | 'seal';

/** The authoritative structured commit kind determined at the boundary. */
export type StructuredCommitKind =
  | 'structure_generation'
  | 'fill_merge'
  | 'fill_noop'
  | 'fill_stale'
  | 'seal_rework'
  | 'seal_publish'
  | 'seal_final'
  | 'human_abandon'
  | 'runtime_failure'
  | 'task_stop'
  | 'crash_recovery';

/** Forced terminal kinds with no dispatch action (scheduler/recovery paths). */
export type ForcedStructuredTerminal = 'runtime_failure' | 'task_stop' | 'crash_recovery';

/** A declared route shape (structurally identical to the committer's route). */
export interface StructuredRouteDeclaration {
  from: string;
  to: string;
  kind: 'message' | 'artifact';
  label: string;
}

/**
 * The full structured commit context the runner wires into the committer for a
 * structured v3 turn (turn/epoch/session/candidate/attempt + stores).
 */
export interface StructuredCommitContext {
  taskId: string;
  turnId: string;
  inputNodeId: string;
  attemptEpoch: number;
  sessionKind: StructuredSessionKindV3;
  /** Frozen task snapshot hash (bound into the completion signature). */
  snapshotHash: string;
  /** The frozen structured slot contract of the task. */
  contract: FrozenStructuredSlotContractV1;
  events: EventStore;
  blobStore: StructuredSlotBlobStore;
  privateStore: StructuredSlotPrivateStore;
  /** Sealed artifact custody store (Task 16 seal success batches). */
  artifactStore: ArtifactStore;
  /** The template's declared final submitters (design §17.1). */
  finalSubmitters: readonly string[];
  /**
   * The submit-time structure identity (design §9.3 / Task 12 note): the
   * scaffoldId the candidate's slotIds were derived from at submit time MUST be
   * reproduced here, or the blob-store slotIds will not line up.
   */
  submitStructureContext: SubmitStructureContext;
  structureCandidate: StructureCommitCandidate | null;
  mergeCandidate: MergeCommitCandidate | null;
  /** Seal dispatch state (from the seal session); passed/rework/incomplete. */
  sealDispatch: SealDispatchStateV1;
  /** Forced terminal (no dispatch action) for failure/stop/crash paths. */
  forced?: ForcedStructuredTerminal;
  /** Public failure message for a forced `runtime_failure` terminal. */
  failureMessage?: string;
  /** The model's public turn text (the Agent result body). */
  publicText: string;
  currentAgent: FrozenAgentConfig;
  agents: ReadonlyArray<{ id: string; name: string }>;
  declaredRoutes: ReadonlyArray<StructuredRouteDeclaration>;
  /** Injectable clock for event timestamps; defaults to system time. */
  clock?: () => Date;
}

/** The result `prepareStructuredCommit` returns (replay or fresh commit). */
export interface PreparedStructuredCommit {
  kind: StructuredCommitKind;
  /** The committed batch events (original bytes on a replay). */
  committed: CommittedEvent[];
  /** True when the result was pre-read/replayed, never re-constructed. */
  replayed: boolean;
  phase: TurnTracePhase;
  waitingHuman: boolean;
  taskCompleted: boolean;
  nextAgentIds: string[];
  publishedVersions: number[];
}

/** The normalized dispatch folded into the completion signature. */
type NormalizedDispatch =
  | { type: 'send_message'; targetAgentId: string; summary: string }
  | { type: 'request_human_input'; question: string }
  | { type: 'none' };

function fail(
  code: StructuredCommitErrorCode,
  message: string,
): StructuredCommitError {
  return new StructuredCommitError(code, message);
}

/** Terminal status/reason per commit kind (the six legal pairs, spec §8.1). */
function terminalStatusFor(kind: StructuredCommitKind): StructuredAttemptStatus {
  switch (kind) {
    case 'structure_generation':
    case 'fill_merge':
    case 'fill_noop':
    case 'seal_rework':
    case 'seal_publish':
    case 'seal_final':
      return 'committed';
    case 'human_abandon':
      return 'waiting_human';
    case 'fill_stale':
    case 'runtime_failure':
      return 'failed';
    case 'task_stop':
    case 'crash_recovery':
      return 'abandoned';
  }
}

function terminalReasonFor(kind: StructuredCommitKind): StructuredAttemptReason {
  switch (kind) {
    case 'structure_generation':
    case 'fill_merge':
    case 'fill_noop':
    case 'seal_publish':
    case 'seal_final':
      return 'completion_dispatch';
    case 'seal_rework':
      return 'rework_dispatch';
    case 'human_abandon':
      return 'human_request';
    case 'fill_stale':
    case 'runtime_failure':
      return 'runtime_failure';
    case 'task_stop':
      return 'task_stop';
    case 'crash_recovery':
      return 'crash_recovery';
  }
}

/** The tail sequence of the committed log (the appendBatch CAS anchor). */
function tailSequence(committed: readonly CommittedEvent[]): number {
  return committed[committed.length - 1]?.sequence ?? 0;
}

/** Deterministic next node/route sequence over the ONE tail snapshot. */
function sequenceAssigner(snapshot: readonly TaskEvent[]): () => number {
  let counter = 0;
  for (const event of snapshot) {
    if ('node' in event) counter = Math.max(counter, event.node.sequence);
    if ('route' in event) counter = Math.max(counter, event.route.sequence);
  }
  return () => {
    counter += 1;
    return counter;
  };
}

function agentName(context: StructuredCommitContext, agentId: string): string {
  return context.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
}

/** RFC 6901 instance path of the `i`-th child of a node at `instancePath`. */
function childPath(instancePath: string, index: number): string {
  return instancePath === '' ? `/children/${index}` : `${instancePath}/children/${index}`;
}

/**
 * Reproduces the SAME slot identities the candidate froze at submit time
 * (design §9.3/§15, Task 12 note): derived from `scaffoldId + generationId +
 * instancePath`, NEVER from clientKey. The scaffoldId MUST equal the one
 * supplied to `submit_structure_proposal` or the blob-store slotIds drift.
 */
function buildSlotInstances(
  candidate: StructureCommitCandidate,
  scaffoldId: string,
): SlotInstance[] {
  const slots: SlotInstance[] = [];
  const walk = (
    node: ProposalNode,
    instancePath: string,
    parentSlotId: string | null,
    order: number,
  ): void => {
    slots.push({
      slotId: deriveSlotId(scaffoldId, candidate.generationId, instancePath),
      scaffoldId,
      parentSlotId,
      order,
      typeId: node.typeId,
      spec: node.spec,
      contentPresence: 'unset',
    });
    for (let i = 0; i < node.children.length; i += 1) {
      walk(node.children[i], childPath(instancePath, i), slots[slots.length - 1]!.slotId, i);
    }
  };
  walk(candidate.normalizedTree, '', null, 0);
  return slots;
}

function isIdempotencyRace(error: unknown): boolean {
  return (
    error instanceof StorageError &&
    (error.code === STORAGE_ERROR_CODES.IDEMPOTENCY_CONFLICT ||
      error.code === STORAGE_ERROR_CODES.EXPECTED_SEQUENCE_MISMATCH)
  );
}

/** True while the turn's attempt is started and not yet terminalized. */
function isAttemptActive(snapshot: readonly TaskEvent[], context: StructuredCommitContext): boolean {
  let started = false;
  for (const event of snapshot) {
    if (event.type === 'structured_slot_attempt_started' && event.turnId === context.turnId) {
      started = true;
    }
    if (event.type === 'structured_slot_attempt_terminal' && event.turnId === context.turnId) {
      return false;
    }
  }
  return started;
}

function assertAttemptActive(snapshot: readonly TaskEvent[], context: StructuredCommitContext): void {
  if (!isAttemptActive(snapshot, context)) {
    throw fail(
      STRUCTURED_COMMIT_ERROR_CODES.ATTEMPT_NOT_ACTIVE,
      '当前 Attempt 未处于 active 状态，提交被拒绝。',
    );
  }
}

/** The opened fill-draft event bound to the current turn, or null. */
function openedDraftFor(
  snapshot: readonly TaskEvent[],
  context: StructuredCommitContext,
): Extract<TaskEvent, { type: 'structured_fill_draft_opened' }> | null {
  for (const event of snapshot) {
    if (
      event.type === 'structured_fill_draft_opened' &&
      event.turnId === context.turnId
    ) {
      return event;
    }
  }
  return null;
}

/**
 * The one allowed message dispatch for a v3 structure/fill/rework turn (spec
 * §3.2 / design §11.3): the frozen v3 turn contract names the send targets and
 * the frozen snapshot declares the message route. Any other target fails
 * closed before any write.
 */
function assertMessageDispatchAllowed(
  context: StructuredCommitContext,
  targetAgentId: string,
): StructuredRouteDeclaration {
  if (
    context.currentAgent.turnContract === null ||
    !isStructuredTurnContractV3(context.currentAgent.turnContract)
  ) {
    throw fail(STRUCTURED_COMMIT_ERROR_CODES.CONTRACT_INVALID, '结构化提交需要 v3 turn contract。');
  }
  const contract = context.currentAgent.turnContract;
  const contractTargets = contract.dispatch.targets.send_message;
  if (contractTargets === undefined || !contractTargets.includes(targetAgentId)) {
    throw fail(
      STRUCTURED_COMMIT_ERROR_CODES.ROUTE_NOT_ALLOWED,
      '消息目标不在模板冻结的 v3 send targets 之内。',
    );
  }
  const route = context.declaredRoutes.find(
    (candidate) =>
      candidate.from === context.currentAgent.id &&
      candidate.kind === 'message' &&
      candidate.to === targetAgentId,
  );
  if (route === undefined) {
    throw fail(
      STRUCTURED_COMMIT_ERROR_CODES.ROUTE_NOT_ALLOWED,
      '消息目标不在模板声明的合法连线之内。',
    );
  }
  return route;
}

/** The Agent result event (carries inputNodeId + dispatchKind, spec §8.2). */
function agentResultEvent(
  context: StructuredCommitContext,
  dispatchKind: 'send' | 'human',
  nextSequence: () => number,
  at: string,
): TaskEvent {
  return {
    id: `${context.turnId}-result`,
    at,
    type: 'agent_result',
    node: {
      sequence: nextSequence(),
      agentId: context.currentAgent.id,
      kind: 'result',
      title: context.currentAgent.name,
      body: context.publicText,
      status: 'confirmed',
      attemptCount: context.attemptEpoch,
      inputVersion: null,
    },
    inputNodeId: context.inputNodeId,
    dispatchKind,
  };
}

/** The attempt terminal event (the six legal status/reason pairs). */
function attemptTerminalEvent(
  context: StructuredCommitContext,
  status: StructuredAttemptStatus,
  reason: StructuredAttemptReason,
  at: string,
): TaskEvent {
  return {
    id: `${context.turnId}-attempt-terminal`,
    at,
    type: 'structured_slot_attempt_terminal',
    inputNodeId: context.inputNodeId,
    attemptEpoch: context.attemptEpoch,
    turnId: context.turnId,
    status,
    reason,
  };
}

/** The message Route/input pair delivered with a send_message dispatch. */
function pushMessageRoute(
  events: TaskEvent[],
  context: StructuredCommitContext,
  route: StructuredRouteDeclaration,
  summary: string,
  resultEventId: string,
  inputEventId: string,
  nextSequence: () => number,
  at: string,
): void {
  events.push({
    id: `${context.turnId}-message-route-0`,
    at,
    type: 'route_executed',
    route: {
      sequence: nextSequence(),
      fromNodeId: resultEventId,
      toNodeId: inputEventId,
      kind: route.kind,
      label: route.label,
    },
  });
  events.push({
    id: inputEventId,
    at,
    type: 'agent_input',
    node: {
      sequence: nextSequence(),
      agentId: route.to,
      kind: 'input',
      title: agentName(context, route.to),
      body: summary,
      status: 'confirmed',
      attemptCount: 1,
      inputVersion: null,
    },
  });
}

/** The artifact Route/input pair delivered with a publish_artifact dispatch. */
function pushArtifactRoute(
  events: TaskEvent[],
  context: StructuredCommitContext,
  route: StructuredRouteDeclaration,
  resultEventId: string,
  inputEventId: string,
  title: string,
  version: number,
  nextSequence: () => number,
  at: string,
): void {
  events.push({
    id: `${context.turnId}-artifact-route-0`,
    at,
    type: 'route_executed',
    route: {
      sequence: nextSequence(),
      fromNodeId: resultEventId,
      toNodeId: inputEventId,
      kind: 'artifact',
      label: route.label,
    },
  });
  events.push({
    id: inputEventId,
    at,
    type: 'agent_input',
    node: {
      sequence: nextSequence(),
      agentId: route.to,
      kind: 'input',
      title: agentName(context, route.to),
      body: title,
      status: 'confirmed',
      attemptCount: 1,
      inputVersion: version,
    },
  });
}

/** The Draft terminal event (merged/stale/abandoned; no content on stale/abandoned). */
function draftTerminalEvent(
  context: StructuredCommitContext,
  candidate: MergeCommitCandidate,
  status: 'merged' | 'stale' | 'abandoned',
  at: string,
  content: StructuredBlobRefV1 | null,
): TaskEvent {
  return {
    id: `${candidate.draftId}-terminal`,
    at,
    type: 'structured_fill_draft_terminal',
    draftId: candidate.draftId,
    turnId: context.turnId,
    status,
    baseRevision: candidate.baseRevision,
    resultRevision: status === 'merged' ? candidate.resultRevision : candidate.baseRevision,
    changeCount: candidate.changeCount,
    content,
  };
}

// --------------------------------------------------------------------------
// Batch builders (ONE tail snapshot; immutable objects promoted unreferenced).
// --------------------------------------------------------------------------

async function buildStructureBatch(
  context: StructuredCommitContext,
  snapshot: readonly TaskEvent[],
  action: ForgeAction,
  at: string,
  nextSequence: () => number,
  events: TaskEvent[],
): Promise<TaskEvent[]> {
  if (action.type !== 'send_message') {
    throw fail(STRUCTURED_COMMIT_ERROR_CODES.DISPATCH_NOT_ALLOWED, 'structure 提交只能 send_message。');
  }
  const candidate = context.structureCandidate;
  if (candidate === null) {
    throw fail(STRUCTURED_COMMIT_ERROR_CODES.CANDIDATE_REQUIRED, 'structure 提交需要已冻结的 StructureCommitCandidate。');
  }
  const route = assertMessageDispatchAllowed(context, action.targetAgentId);
  const scaffoldId = context.submitStructureContext.scaffoldId;

  // Promote the generation + content root to their final content-addressed
  // addresses (unreferenced until the batch references them — the batch is the
  // only visibility point, design §18.3/G05).
  const slots = buildSlotInstances(candidate, scaffoldId);
  const manifest = await context.blobStore.putGeneration({
    generationId: candidate.generationId,
    scaffoldId,
    slots,
  });
  const contentRootMappings: Record<string, 'unset' | string> = {};
  for (const slot of slots) {
    contentRootMappings[slot.slotId] = 'unset';
  }
  const contentRef = await context.blobStore.putContentRevision(contentRootMappings);

  const state = projectStructuredSlotState(snapshot);
  const resultEventId = `${context.turnId}-result`;
  const inputEventId = `${context.turnId}-message-input-0`;

  events.push({
    id: `${context.turnId}-generation-committed`,
    at,
    type: 'structured_scaffold_generation_committed',
    scaffoldId,
    generationId: candidate.generationId,
    supersedesGenerationId: state.generationId ?? null,
    rootSlotId: candidate.rootSlotId ?? manifest.rootSlotId,
    slotCount: candidate.slotCount,
    maxDepth: manifest.maxDepth,
    structure: manifest.structure,
    content: contentRef,
    contentRevision: 0,
    proposalId: candidate.proposalId,
  });
  events.push(agentResultEvent(context, 'send', nextSequence, at));
  events.push(attemptTerminalEvent(context, 'committed', 'completion_dispatch', at));
  pushMessageRoute(events, context, route, action.summary, resultEventId, inputEventId, nextSequence, at);
  return events;
}

async function buildFillBatch(
  context: StructuredCommitContext,
  kind: StructuredCommitKind,
  action: ForgeAction,
  at: string,
  nextSequence: () => number,
  events: TaskEvent[],
): Promise<TaskEvent[]> {
  if (action.type !== 'send_message') {
    throw fail(STRUCTURED_COMMIT_ERROR_CODES.DISPATCH_NOT_ALLOWED, 'fill 提交只能 send_message。');
  }
  const candidate = context.mergeCandidate;
  if (candidate === null) {
    throw fail(STRUCTURED_COMMIT_ERROR_CODES.CANDIDATE_REQUIRED, 'fill 提交需要已冻结的 MergeCommitCandidate。');
  }

  if (kind === 'fill_stale') {
    // ONE failure terminal + a stale Draft terminal, NO content authority and
    // NO dispatch (spec §11: old candidates never fabricate a dispatch).
    events.push(draftTerminalEvent(context, candidate, 'stale', at, null));
    events.push(attemptTerminalEvent(context, 'failed', 'runtime_failure', at));
    return events;
  }

  const route = assertMessageDispatchAllowed(context, action.targetAgentId);
  const resultEventId = `${context.turnId}-result`;
  const inputEventId = `${context.turnId}-message-input-0`;
  // Nonempty merges reference the STAGED content root (promoted by the batch);
  // no-op merges write no content blob and never bump the revision (L02).
  let contentRef: StructuredBlobRefV1 | null = null;
  if (candidate.contentRevisionDigest !== null) {
    contentRef = await context.blobStore.readContentRevisionRef(candidate.contentRevisionDigest);
  }
  events.push(draftTerminalEvent(context, candidate, 'merged', at, contentRef));
  events.push(agentResultEvent(context, 'send', nextSequence, at));
  events.push(attemptTerminalEvent(context, 'committed', 'completion_dispatch', at));
  pushMessageRoute(events, context, route, action.summary, resultEventId, inputEventId, nextSequence, at);
  return events;
}

async function buildSealReworkBatch(
  context: StructuredCommitContext,
  action: ForgeAction,
  at: string,
  nextSequence: () => number,
  events: TaskEvent[],
): Promise<TaskEvent[]> {
  if (action.type !== 'send_message') {
    throw fail(STRUCTURED_COMMIT_ERROR_CODES.DISPATCH_NOT_ALLOWED, 'seal rework 只能 send_message 到冻结的 v3 目标。');
  }
  if (context.sealDispatch.status !== 'rework_required') {
    throw fail(
      STRUCTURED_COMMIT_ERROR_CODES.SEAL_RECEIPT_REQUIRED,
      'seal rework 提交需要 rework receipt（可靠失败的 Seal Gate）。',
    );
  }
  if (action.targetAgentId !== context.sealDispatch.reworkTarget) {
    throw fail(
      STRUCTURED_COMMIT_ERROR_CODES.ROUTE_NOT_ALLOWED,
      'seal rework 只能发送到冻结的 v3 fill/structure 目标。',
    );
  }
  const route = assertMessageDispatchAllowed(context, action.targetAgentId);
  const resultEventId = `${context.turnId}-result`;
  const inputEventId = `${context.turnId}-message-input-0`;
  // Gate-failure result: the Agent result whose body carries the rework
  // summary; the scaffold revision/phase stay active_unsealed.
  events.push(agentResultEvent(context, 'send', nextSequence, at));
  events.push(attemptTerminalEvent(context, 'committed', 'rework_dispatch', at));
  pushMessageRoute(events, context, route, action.summary, resultEventId, inputEventId, nextSequence, at);
  return events;
}

/**
 * Seal success batch (spec §11 seal success / design §17.1 step 8): promote the
 * custody candidate to the unreferenced final address, then reveal
 * `artifact_published` + `structured_scaffold_sealed` + Agent result + terminal
 * + the chosen publish Route (seal_publish) OR `final_submission_accepted`
 * (seal_final, the ONLY task-completing event) in ONE appendBatch. Plain
 * Seal/publish never completes the task (design §17.3).
 */
async function buildSealSuccessBatch(
  context: StructuredCommitContext,
  kind: 'seal_publish' | 'seal_final',
  at: string,
  nextSequence: () => number,
  events: TaskEvent[],
): Promise<TaskEvent[]> {
  if (context.sealDispatch.status !== 'passed' || context.sealDispatch.candidate === undefined) {
    throw fail(
      STRUCTURED_COMMIT_ERROR_CODES.SEAL_CANDIDATE_REQUIRED,
      'seal 提交需要已冻结的 sealed candidate。',
    );
  }
  const candidate = context.sealDispatch.candidate;
  if (kind === 'seal_final' && !context.finalSubmitters.includes(context.currentAgent.id)) {
    throw fail(
      STRUCTURED_COMMIT_ERROR_CODES.ROUTE_NOT_ALLOWED,
      '只有模板声明的 final submitter 才能直接提交最终产物。',
    );
  }
  let publishRoute: StructuredRouteDeclaration | undefined;
  if (kind === 'seal_publish') {
    publishRoute = context.declaredRoutes.find(
      (candidateRoute) =>
        candidateRoute.from === context.currentAgent.id && candidateRoute.kind === 'artifact',
    );
    if (publishRoute === undefined) {
      throw fail(
        STRUCTURED_COMMIT_ERROR_CODES.ROUTE_NOT_ALLOWED,
        'publish_artifact 需要从当前 agent 出发的 artifact 连线。',
      );
    }
  }

  // Promote the custody candidate to its unreferenced final address first; the
  // batch file is the only visibility point (design §18.3 G05).
  await context.artifactStore.promotePreparedVersion(context.taskId, candidate.artifact);
  const sealRecordRef = await context.blobStore.putJsonBlob(candidate.sealRecord, 'seal_record');

  events.push({
    id: `${context.turnId}-artifact-1`,
    at,
    type: 'artifact_published',
    artifact: {
      version: candidate.artifact.version,
      title: candidate.artifact.title,
      sourceNodeId: candidate.sourceNodeId,
      format: candidate.artifact.format,
      files: candidate.artifact.files.map((file) => ({ name: file.name, hash: file.sha256 })),
      artifactType: null,
      artifactId: candidate.artifact.artifactId,
    },
  });
  events.push({
    id: `${context.turnId}-sealed`,
    at,
    type: 'structured_scaffold_sealed',
    sealId: candidate.sealId,
    scaffoldId: candidate.scaffoldId,
    generationId: candidate.generationId,
    scaffoldRevision: candidate.scaffoldRevision,
    sealRecord: sealRecordRef,
    artifactId: candidate.artifact.artifactId,
    artifactVersion: candidate.artifact.version,
  });

  const resultEventId = `${context.turnId}-result`;
  events.push(agentResultEvent(context, 'send', nextSequence, at));
  events.push(attemptTerminalEvent(context, 'committed', 'completion_dispatch', at));

  if (kind === 'seal_publish') {
    const inputEventId = `${context.turnId}-artifact-input-0`;
    pushArtifactRoute(
      events,
      context,
      publishRoute!,
      resultEventId,
      inputEventId,
      candidate.artifact.title,
      candidate.artifact.version,
      nextSequence,
      at,
    );
  } else {
    events.push({
      id: `${context.turnId}-final-accepted`,
      at,
      type: 'final_submission_accepted',
      artifactId: candidate.artifact.artifactId,
      version: candidate.artifact.version,
    });
  }
  return events;
}

async function buildHumanBatch(
  context: StructuredCommitContext,
  snapshot: readonly TaskEvent[],
  action: ForgeAction,
  at: string,
  nextSequence: () => number,
  events: TaskEvent[],
): Promise<TaskEvent[]> {
  if (action.type !== 'request_human_input') {
    throw fail(STRUCTURED_COMMIT_ERROR_CODES.DISPATCH_NOT_ALLOWED, 'human 提交需要 request_human_input。');
  }
  const resultEventId = `${context.turnId}-result`;
  // Abandon the private Draft (fill) as part of the batch (spec §11 human).
  if (context.sessionKind === 'fill') {
    const candidate = context.mergeCandidate;
    const opened = openedDraftFor(snapshot, context);
    const draftId = candidate?.draftId ?? deriveDraftId(context.turnId);
    events.push({
      id: `${draftId}-terminal`,
      at,
      type: 'structured_fill_draft_terminal',
      draftId,
      turnId: context.turnId,
      status: 'abandoned',
      baseRevision: candidate?.baseRevision ?? opened?.baseRevision ?? 0,
      resultRevision: 0,
      changeCount: candidate?.changeCount ?? 0,
      content: null,
    });
  }
  events.push(agentResultEvent(context, 'human', nextSequence, at));
  events.push(attemptTerminalEvent(context, 'waiting_human', 'human_request', at));
  events.push({
    id: `${context.turnId}-human-requested`,
    at,
    type: 'human_requested',
    node: {
      sequence: nextSequence(),
      agentId: context.currentAgent.id,
      kind: 'human_request',
      title: context.currentAgent.name,
      body: action.question,
      status: 'confirmed',
      attemptCount: context.attemptEpoch,
      inputVersion: null,
    },
    question: action.question,
    source: 'agent_request',
  });
  return events;
}

async function buildTerminalBatch(
  context: StructuredCommitContext,
  kind: StructuredCommitKind,
  snapshot: readonly TaskEvent[],
  at: string,
  events: TaskEvent[],
): Promise<TaskEvent[]> {
  // A fill attempt's Draft is abandoned in the same authority batch.
  if (context.sessionKind === 'fill') {
    const opened = openedDraftFor(snapshot, context);
    const draftId = context.mergeCandidate?.draftId ?? deriveDraftId(context.turnId);
    events.push({
      id: `${draftId}-terminal`,
      at,
      type: 'structured_fill_draft_terminal',
      draftId,
      turnId: context.turnId,
      status: 'abandoned',
      baseRevision: opened?.baseRevision ?? 0,
      resultRevision: 0,
      changeCount: 0,
      content: null,
    });
  }
  switch (kind) {
    case 'runtime_failure':
      events.push({
        id: `${context.turnId}-failed`,
        at,
        type: 'agent_attempt_failed',
        nodeId: context.inputNodeId,
        message: context.failureMessage ?? '运行时失败，Attempt 已终止。',
        retryable: false,
      });
      events.push(attemptTerminalEvent(context, 'failed', 'runtime_failure', at));
      break;
    case 'task_stop':
      events.push({ id: `${context.turnId}-task-stopped`, at, type: 'task_stopped' });
      events.push(attemptTerminalEvent(context, 'abandoned', 'task_stop', at));
      break;
    case 'crash_recovery':
      events.push({ id: `${context.turnId}-task-interrupted`, at, type: 'task_interrupted' });
      events.push(attemptTerminalEvent(context, 'abandoned', 'crash_recovery', at));
      break;
    default:
      // Unreachable: this builder is only called for forced terminal kinds.
      break;
  }
  return events;
}

async function buildBatch(
  context: StructuredCommitContext,
  kind: StructuredCommitKind,
  snapshot: readonly TaskEvent[],
  action: ForgeAction | null,
  at: string,
): Promise<TaskEvent[]> {
  const nextSequence = sequenceAssigner(snapshot);
  const events: TaskEvent[] = [];
  switch (kind) {
    case 'structure_generation':
      return buildStructureBatch(context, snapshot, action!, at, nextSequence, events);
    case 'fill_merge':
    case 'fill_noop':
    case 'fill_stale':
      return buildFillBatch(context, kind, action!, at, nextSequence, events);
    case 'seal_rework':
      return buildSealReworkBatch(context, action!, at, nextSequence, events);
    case 'seal_publish':
    case 'seal_final':
      return buildSealSuccessBatch(context, kind, at, nextSequence, events);
    case 'human_abandon':
      return buildHumanBatch(context, snapshot, action!, at, nextSequence, events);
    case 'runtime_failure':
    case 'task_stop':
    case 'crash_recovery':
      return buildTerminalBatch(context, kind, snapshot, at, events);
  }
}

// --------------------------------------------------------------------------
// Completion signature + preflight replay (spec §11 / design §25.6 O03).
// --------------------------------------------------------------------------

function normalizeDispatch(action: ForgeAction | null, _kind: StructuredCommitKind): NormalizedDispatch {
  if (action === null) {
    return { type: 'none' };
  }
  if (action.type === 'send_message') {
    return { type: 'send_message', targetAgentId: action.targetAgentId, summary: action.summary };
  }
  if (action.type === 'request_human_input') {
    return { type: 'request_human_input', question: action.question };
  }
  return { type: 'none' };
}

/** The stable candidate-or-receipt digest folded into the signature. */
function candidateDigestFor(
  context: StructuredCommitContext,
  kind: StructuredCommitKind,
  snapshot: readonly TaskEvent[],
): string {
  switch (kind) {
    case 'structure_generation': {
      const candidate = context.structureCandidate;
      if (candidate === null) {
        throw fail(STRUCTURED_COMMIT_ERROR_CODES.CANDIDATE_REQUIRED, 'structure 提交需要已冻结的 StructureCommitCandidate。');
      }
      return canonicalJsonSha256({
        generationId: candidate.generationId,
        proposalId: candidate.proposalId,
        snapshotHash: candidate.snapshotHash,
        slotCount: candidate.slotCount,
        rootSlotId: candidate.rootSlotId ?? null,
        normalizedTree: candidate.normalizedTree,
      });
    }
    case 'fill_merge':
    case 'fill_noop':
    case 'fill_stale': {
      const candidate = context.mergeCandidate;
      if (candidate === null) {
        throw fail(STRUCTURED_COMMIT_ERROR_CODES.CANDIDATE_REQUIRED, 'fill 提交需要已冻结的 MergeCommitCandidate。');
      }
      return canonicalJsonSha256({
        draftId: candidate.draftId,
        scaffoldId: candidate.scaffoldId,
        baseRevision: candidate.baseRevision,
        resultRevision: candidate.resultRevision,
        changeCount: candidate.changeCount,
        contentRevisionDigest: candidate.contentRevisionDigest,
      });
    }
    case 'seal_rework': {
      if (context.sealDispatch.status !== 'rework_required') {
        throw fail(STRUCTURED_COMMIT_ERROR_CODES.SEAL_RECEIPT_REQUIRED, 'seal rework 提交需要 rework receipt。');
      }
      const state = projectStructuredSlotState(snapshot);
      return canonicalJsonSha256({
        scaffoldId: state.scaffoldId,
        generationId: state.generationId,
        contentRevision: state.contentRevision,
        reworkTarget: context.sealDispatch.reworkTarget,
      });
    }
    case 'seal_publish':
    case 'seal_final': {
      if (context.sealDispatch.status !== 'passed' || context.sealDispatch.candidate === undefined) {
        throw fail(
          STRUCTURED_COMMIT_ERROR_CODES.SEAL_CANDIDATE_REQUIRED,
          'seal 提交需要已冻结的 sealed candidate。',
        );
      }
      const candidate = context.sealDispatch.candidate;
      return canonicalJsonSha256({
        contentIdentity: candidate.contentIdentity,
        sealId: candidate.sealId,
        artifactId: candidate.artifact.artifactId,
        version: candidate.artifact.version,
        files: candidate.artifact.files,
        sealRecord: candidate.sealRecord,
      });
    }
    case 'human_abandon': {
      const candidate =
        context.mergeCandidate !== null
          ? canonicalJsonSha256(context.mergeCandidate)
          : context.structureCandidate !== null
            ? canonicalJsonSha256(context.structureCandidate)
            : null;
      return canonicalJsonSha256({ candidate });
    }
    case 'runtime_failure':
    case 'task_stop':
    case 'crash_recovery':
      return canonicalJsonSha256({});
  }
}

/** Canonical completion signature (spec §11; stable across ephemeral fields). */
function completionSignature(
  context: StructuredCommitContext,
  kind: StructuredCommitKind,
  candidateDigest: string,
  dispatch: NormalizedDispatch,
): string {
  return canonicalJsonSha256({
    v: 1,
    taskId: context.taskId,
    turnId: context.turnId,
    snapshotHash: context.snapshotHash,
    kind,
    candidateDigest,
    dispatch,
  });
}

function commitIdFor(signature: string): string {
  return `structured-${signature.slice(0, 40)}`;
}

/**
 * The stable commitId for a structured commit kind (test/verification
 * support): the same completion signature always maps to the same batch.
 */
export function deriveStructuredCommitId(
  context: StructuredCommitContext,
  kind: StructuredCommitKind,
  action: ForgeAction | null,
  snapshot: readonly TaskEvent[],
): string {
  return structuredCommitIdFor(context, kind, action, snapshot);
}

/** Canonical completion signature → commitId (spec §11 / design §25.6 O03). */
function structuredCommitIdFor(
  context: StructuredCommitContext,
  kind: StructuredCommitKind,
  action: ForgeAction | null,
  snapshot: readonly TaskEvent[],
): string {
  const digest = candidateDigestFor(context, kind, snapshot);
  const dispatch = normalizeDispatch(action, kind);
  return commitIdFor(completionSignature(context, kind, digest, dispatch));
}

/**
 * Determines the CANDIDATE commit kind from the dispatch matrix + the frozen
 * candidate alone (spec §11). Deliberately NEVER reads the current state for
 * the fill merge/no-op choice: a response-loss replay after the merge has
 * advanced the revision must compute the SAME signature as the original
 * commit. The fill stale refinement is a revision rejection and therefore
 * happens AFTER the preflight read (see `prepareStructuredCommit`).
 */
function determineCandidateKind(
  context: StructuredCommitContext,
  action: ForgeAction | null,
  _snapshot: readonly TaskEvent[],
): StructuredCommitKind {
  if (context.forced !== undefined) {
    switch (context.forced) {
      case 'runtime_failure':
        return 'runtime_failure';
      case 'task_stop':
        return 'task_stop';
      case 'crash_recovery':
        return 'crash_recovery';
    }
  }
  if (action === null) {
    throw fail(STRUCTURED_COMMIT_ERROR_CODES.DISPATCH_NOT_ALLOWED, '结构化提交需要一个 dispatch 动作。');
  }
  if (action.type === 'request_human_input') {
    return 'human_abandon';
  }
  if (action.type === 'send_message') {
    switch (context.sessionKind) {
      case 'structure':
        if (context.structureCandidate === null) {
          throw fail(STRUCTURED_COMMIT_ERROR_CODES.CANDIDATE_REQUIRED, 'structure 提交需要已冻结的 StructureCommitCandidate。');
        }
        return 'structure_generation';
      case 'fill': {
        if (context.mergeCandidate === null) {
          throw fail(STRUCTURED_COMMIT_ERROR_CODES.CANDIDATE_REQUIRED, 'fill 提交需要已冻结的 MergeCommitCandidate。');
        }
        return context.mergeCandidate.changeCount === 0 ? 'fill_noop' : 'fill_merge';
      }
      case 'seal':
        if (context.sealDispatch.status !== 'rework_required') {
          // A passed seal may only publish/final-submit; an incomplete or none
          // seal has no send dispatch at all (design L01).
          throw fail(
            context.sealDispatch.status === 'passed'
              ? STRUCTURED_COMMIT_ERROR_CODES.DISPATCH_NOT_ALLOWED
              : STRUCTURED_COMMIT_ERROR_CODES.SEAL_RECEIPT_REQUIRED,
            'seal 会话只有 rework receipt 才允许 send_message。',
          );
        }
        return 'seal_rework';
    }
  }
  if (action.type === 'publish_artifact' || action.type === 'submit_final_artifact') {
    if (context.sessionKind !== 'seal' || context.sealDispatch.status !== 'passed') {
      throw fail(
        STRUCTURED_COMMIT_ERROR_CODES.DISPATCH_NOT_ALLOWED,
        'publish/final 提交只允许在 passed Seal 之后。',
      );
    }
    return action.type === 'publish_artifact' ? 'seal_publish' : 'seal_final';
  }
  throw fail(
    STRUCTURED_COMMIT_ERROR_CODES.DISPATCH_NOT_ALLOWED,
    `结构化 v3 提交只允许 send_message / publish_artifact / submit_final_artifact / request_human_input，收到 ${action.type}。`,
  );
}

/**
 * Refines a fill merge/no-op candidate into `fill_stale` when the active
 * generation or content revision moved on (design §14.3/D06). This is the
 * revision rejection the preflight read gates: it must never run before the
 * batch pre-read, and it must never fabricate a dispatch (spec §11).
 */
function refineFillStale(
  context: StructuredCommitContext,
  kind: StructuredCommitKind,
  snapshot: readonly TaskEvent[],
): StructuredCommitKind {
  if (context.sessionKind !== 'fill' || (kind !== 'fill_merge' && kind !== 'fill_noop')) {
    return kind;
  }
  const state = projectStructuredSlotState(snapshot);
  const opened = openedDraftFor(snapshot, context);
  if (opened === null) {
    throw fail(
      STRUCTURED_COMMIT_ERROR_CODES.CANDIDATE_REQUIRED,
      'fill 提交需要已提交的 draft_opened 事件。',
    );
  }
  if (
    state.generationId !== opened.generationId ||
    state.contentRevision !== context.mergeCandidate!.baseRevision
  ) {
    return 'fill_stale';
  }
  return kind;
}

/** A fill terminal must never exist without its committed `draft_opened`. */
function assertFillDraftOpened(snapshot: readonly TaskEvent[], context: StructuredCommitContext): void {
  if (context.sessionKind === 'fill' && openedDraftFor(snapshot, context) === null) {
    throw fail(
      STRUCTURED_COMMIT_ERROR_CODES.CANDIDATE_REQUIRED,
      'fill 提交需要已提交的 draft_opened 事件。',
    );
  }
}

/**
 * Verifies the persisted stable fields of a committed batch against the
 * completion signature (spec §11): terminal pair, candidate identity, blob
 * refs and the Route/body. A mismatch is an idempotency conflict — the same
 * commitId can never carry a different payload.
 */
function assertBatchMatchesSignature(
  context: StructuredCommitContext,
  kind: StructuredCommitKind,
  committed: readonly CommittedEvent[],
  dispatch: NormalizedDispatch,
): void {
  const events = committed.map((entry) => entry.event);
  const terminal = events.find((event) => event.type === 'structured_slot_attempt_terminal');
  if (
    terminal === undefined ||
    terminal.type !== 'structured_slot_attempt_terminal' ||
    terminal.status !== terminalStatusFor(kind) ||
    terminal.reason !== terminalReasonFor(kind)
  ) {
    throw fail(
      STRUCTURED_COMMIT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
      '已提交批次与 completion signature 的 terminal 不匹配。',
    );
  }
  switch (kind) {
    case 'structure_generation': {
      const candidate = context.structureCandidate;
      const generation = events.find((event) => event.type === 'structured_scaffold_generation_committed');
      if (
        candidate === null ||
        generation === undefined ||
        generation.type !== 'structured_scaffold_generation_committed' ||
        generation.generationId !== candidate.generationId ||
        generation.proposalId !== candidate.proposalId
      ) {
        throw fail(
          STRUCTURED_COMMIT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          '已提交 generation 与 completion signature 不匹配。',
        );
      }
      break;
    }
    case 'fill_merge':
    case 'fill_noop': {
      const candidate = context.mergeCandidate;
      const draftTerminal = events.find((event) => event.type === 'structured_fill_draft_terminal');
      if (
        candidate === null ||
        draftTerminal === undefined ||
        draftTerminal.type !== 'structured_fill_draft_terminal' ||
        draftTerminal.draftId !== candidate.draftId ||
        draftTerminal.resultRevision !== candidate.resultRevision ||
        draftTerminal.changeCount !== candidate.changeCount
      ) {
        throw fail(
          STRUCTURED_COMMIT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          '已提交 draft terminal 与 completion signature 不匹配。',
        );
      }
      break;
    }
    case 'fill_stale': {
      const candidate = context.mergeCandidate;
      const draftTerminal = events.find((event) => event.type === 'structured_fill_draft_terminal');
      if (
        candidate === null ||
        draftTerminal === undefined ||
        draftTerminal.type !== 'structured_fill_draft_terminal' ||
        draftTerminal.draftId !== candidate.draftId ||
        draftTerminal.resultRevision !== candidate.baseRevision ||
        draftTerminal.changeCount !== candidate.changeCount
      ) {
        throw fail(
          STRUCTURED_COMMIT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          '已提交 stale draft terminal 与 completion signature 不匹配。',
        );
      }
      break;
    }
    case 'seal_rework':
    case 'runtime_failure':
    case 'task_stop':
    case 'crash_recovery':
      break;
    case 'seal_publish':
    case 'seal_final': {
      const candidate = context.sealDispatch.status === 'passed' ? context.sealDispatch.candidate : undefined;
      const published = events.find((event) => event.type === 'artifact_published');
      const sealed = events.find((event) => event.type === 'structured_scaffold_sealed');
      if (
        candidate === undefined ||
        published === undefined ||
        published.type !== 'artifact_published' ||
        published.artifact.version !== candidate.artifact.version ||
        published.artifact.artifactId !== candidate.artifact.artifactId
      ) {
        throw fail(
          STRUCTURED_COMMIT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          '已提交 artifact_published 与 completion signature 不匹配。',
        );
      }
      if (
        sealed === undefined ||
        sealed.type !== 'structured_scaffold_sealed' ||
        sealed.sealId !== candidate.sealId
      ) {
        throw fail(
          STRUCTURED_COMMIT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          '已提交 structured_scaffold_sealed 与 completion signature 不匹配。',
        );
      }
      if (kind === 'seal_final' && !events.some((event) => event.type === 'final_submission_accepted')) {
        throw fail(
          STRUCTURED_COMMIT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          '已提交 seal_final batch 缺少 final_submission_accepted。',
        );
      }
      break;
    }
    case 'human_abandon':
      if (!events.some((event) => event.type === 'human_requested')) {
        throw fail(
          STRUCTURED_COMMIT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          '已提交 human batch 缺少 human_requested。',
        );
      }
      break;
  }
  if (dispatch.type === 'send_message') {
    const input = events.find(
      (event) => event.type === 'agent_input' && event.id === `${context.turnId}-message-input-0`,
    );
    if (
      input === undefined ||
      input.type !== 'agent_input' ||
      input.node.agentId !== dispatch.targetAgentId ||
      input.node.body !== dispatch.summary
    ) {
      throw fail(
        STRUCTURED_COMMIT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        '已提交 dispatch 与 completion signature 不匹配。',
      );
    }
  }
  if (dispatch.type === 'request_human_input') {
    const human = events.find((event) => event.type === 'human_requested');
    if (human === undefined || human.type !== 'human_requested' || human.question !== dispatch.question) {
      throw fail(
        STRUCTURED_COMMIT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        '已提交 human request 与 completion signature 不匹配。',
      );
    }
  }
}

function buildPrepared(
  context: StructuredCommitContext,
  kind: StructuredCommitKind,
  committed: readonly CommittedEvent[],
  replayed: boolean,
  action: ForgeAction | null,
): PreparedStructuredCommit {
  let phase: TurnTracePhase;
  let waitingHuman = false;
  let taskCompleted = false;
  const nextAgentIds: string[] = [];
  let publishedVersions: number[] = [];
  switch (kind) {
    case 'structure_generation':
    case 'fill_merge':
    case 'fill_noop':
    case 'seal_rework': {
      const target = action !== null && action.type === 'send_message' ? action.targetAgentId : null;
      phase = { state: 'dispatched', dispatchAction: 'send_message', target, message: null };
      if (target !== null) {
        nextAgentIds.push(target);
      }
      break;
    }
    case 'seal_publish': {
      const candidate = context.sealDispatch.status === 'passed' ? context.sealDispatch.candidate : undefined;
      const route = context.declaredRoutes.find(
        (declared) => declared.from === context.currentAgent.id && declared.kind === 'artifact',
      );
      const target = route?.to ?? null;
      phase = {
        state: 'dispatched',
        dispatchAction: 'publish_artifact',
        target,
        message:
          candidate !== undefined ? `已发布产物「${candidate.artifact.title}」v${candidate.artifact.version}` : null,
      };
      if (target !== null) {
        nextAgentIds.push(target);
      }
      publishedVersions = candidate !== undefined ? [candidate.artifact.version] : [];
      break;
    }
    case 'seal_final': {
      const candidate = context.sealDispatch.status === 'passed' ? context.sealDispatch.candidate : undefined;
      phase = {
        state: 'dispatched',
        dispatchAction: 'submit_final_artifact',
        target: null,
        message: '已提交最终产物，任务完成。',
      };
      taskCompleted = true;
      publishedVersions = candidate !== undefined ? [candidate.artifact.version] : [];
      break;
    }
    case 'human_abandon':
      phase = { state: 'waiting_human', dispatchAction: 'request_human_input', target: null, message: null };
      waitingHuman = true;
      break;
    case 'fill_stale':
      phase = { state: 'failed', dispatchAction: null, target: null, message: '草稿基础版本已过期，未合并。' };
      break;
    case 'runtime_failure':
      phase = { state: 'failed', dispatchAction: null, target: null, message: context.failureMessage ?? '运行时失败。' };
      break;
    case 'task_stop':
    case 'crash_recovery':
      phase = { state: 'failed', dispatchAction: null, target: null, message: null };
      break;
  }
  return {
    kind,
    committed: [...committed],
    replayed,
    phase,
    waitingHuman,
    taskCompleted,
    nextAgentIds,
    publishedVersions,
  };
}

/**
 * The structured v3 authority boundary (spec §11): validates the candidate /
 * receipt + dispatch against the session, promotes immutable objects and
 * commits the whole terminal batch atomically — or replays the existing batch
 * on a response-loss retry. Never writes private terminal state.
 */
export async function prepareStructuredCommit(
  context: StructuredCommitContext,
  action: ForgeAction | null,
): Promise<PreparedStructuredCommit> {
  const { events } = context;
  const at = context.clock?.().toISOString() ?? new Date().toISOString();

  // ONE tail snapshot — a pure read, never a rejection or event construction.
  const committed = await events.read(context.taskId);
  const snapshot = committed.map((entry) => entry.event);

  // Candidate commit kind (stable — never derived from the post-commit state,
  // so a response-loss replay computes the SAME signature).
  let kind = determineCandidateKind(context, action, snapshot);
  let commitId = structuredCommitIdFor(context, kind, action, snapshot);

  // Preflight replay BEFORE any phase/revision rejection or new event
  // construction (design §25.6 O03): a committed batch is the exact original
  // result — never re-derived ids/timestamps.
  let existing = await events.readBatchByCommitId(context.taskId, commitId);

  // The fill stale refinement is the revision rejection the pre-read gates:
  // only when NO merge/no-op batch exists do we check the active
  // generation/revision against the candidate base. A stale candidate writes
  // its OWN failure-terminal batch under its own commitId (spec §11).
  if (existing === null) {
    const refined = refineFillStale(context, kind, snapshot);
    if (refined !== kind) {
      kind = refined;
      commitId = structuredCommitIdFor(context, kind, action, snapshot);
      existing = await events.readBatchByCommitId(context.taskId, commitId);
    }
  }

  if (existing !== null) {
    assertBatchMatchesSignature(context, kind, existing, normalizeDispatch(action, kind));
    return buildPrepared(context, kind, existing, true, action);
  }

  // Rejection: the attempt must be active — a committed terminal means this
  // candidate loses against the committed authority (spec §11); a fill
  // terminal must never exist without its committed draft_opened (O01).
  assertAttemptActive(snapshot, context);
  assertFillDraftOpened(snapshot, context);

  // Build the events from the ONE snapshot and append with the observed tail
  // (the batch file is the only visibility point; promoted objects stay
  // unreferenced until it lands).
  const batch = await buildBatch(context, kind, snapshot, action, at);
  const expectedTail = tailSequence(committed);
  try {
    const appended = await events.appendBatch(context.taskId, commitId, batch, {
      expectedLastSequence: expectedTail,
    });
    return buildPrepared(context, kind, appended, false, action);
  } catch (error) {
    if (isIdempotencyRace(error)) {
      // CAS/idempotency race: read the winner and verify it before deciding
      // replay vs stale/conflict (spec §11).
      const winner = await events.readBatchByCommitId(context.taskId, commitId);
      if (winner !== null) {
        assertBatchMatchesSignature(context, kind, winner, normalizeDispatch(action, kind));
        return buildPrepared(context, kind, winner, true, action);
      }
      const fresh = await events.read(context.taskId);
      if (!isAttemptActive(fresh.map((entry) => entry.event), context)) {
        throw fail(
          STRUCTURED_COMMIT_ERROR_CODES.ATTEMPT_NOT_ACTIVE,
          'Attempt 已被其他权威事实终结，本次提交放弃。',
        );
      }
    }
    throw error;
  }
}
