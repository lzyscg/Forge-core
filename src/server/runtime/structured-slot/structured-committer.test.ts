// @vitest-environment node
/**
 * Atomic structured commit tests (Task 15 Steps 2-6; spec §11, design §11.3/
 * §18.3/§25.6 O03).
 *
 * The structured committer is the authority boundary for structure / fill /
 * seal-rework / human abandon. Every candidate becomes ONE atomic TaskEvent
 * batch with its dispatch; the completion signature gives response-loss replay
 * the exact original mapping even when the clock and the random/event-ID
 * source changed in between.
 *
 * Step 2 — structure: promoted generation + content root blobs, generation
 * event referencing proposalId, Agent result, Attempt terminal and the message
 * Route/input appear together; the projection makes the Proposal committed;
 * a failure before the batch writes no authority and the private submission
 * lock stays nonterminal; replay returns the original mapping.
 *
 * Step 3 — fill + no-op + stale: a nonempty merge increments the revision
 * exactly once; a no-op emits the merged Draft terminal + dispatch with NO
 * content blob and NO revision bump; a stale candidate writes one failure
 * terminal and no content authority; a crash after the authority batch before
 * any private cache update still reports merged/stale from the events alone
 * and the read repairs a stale cache marker.
 *
 * Step 4 — seal rework + human: a reliable `failed` receipt may only send to
 * the frozen v3 target and keeps scaffold revision/phase; a human abandon
 * atomically writes the Agent result + waiting_human terminal + request and
 * abandons the private Proposal/Draft/candidate/staging.
 *
 * Step 5 — response-loss replay: commit once, then advance the clock and
 * replace the random/event-ID source before replaying the same completion —
 * the second call pre-reads the existing batch and returns the EXACT original
 * mapping (never changed id/at bytes); concurrent same-signature callers
 * yield one winner; a changed candidate digest or dispatch target does NOT
 * reuse the prior result and loses against the already committed terminal.
 *
 * Step 6 (Task 16) — seal success: a `passed` seal candidate dispatches
 * `publish_artifact` (artifact_published + structured_scaffold_sealed + Agent
 * result + terminal + artifact Route/input in ONE batch) or
 * `submit_final_artifact` by the declared submitter (the SAME batch plus
 * final_submission_accepted — the ONLY task-completing event). Plain Seal/
 * publish never completes the task (design §17.3).
 *
 * No business vocabulary lives here (iron rule 1): task/turn/agent/slot ids
 * are stable platform identifiers.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EventStore, type CommittedEvent } from '../../storage/event-store';
import { StructuredSlotBlobStore, type SlotInstance } from '../../storage/structured-slot-blob-store';
import { StructuredSlotPrivateStore } from '../../storage/structured-slot-private-store';
import { ArtifactStore } from '../../storage/artifact-store';
import {
  disposeAllTestRoots,
  makeEventNode,
  makeTaskEvent,
  makeTempCorePaths,
} from '../../test-support';
import type { TaskEvent } from '../../storage/task-events';
import { compileLayoutGrammarV1 } from '../../structured-slots/layout-grammar';
import { compileSlotSchemaV1 } from '../../structured-slots/slot-schema';
import type {
  AccessProfileV1,
  FrozenStructuredSlotContractV1,
  FrozenSlotTypeV1,
} from '../../template/structured-slot-contract';
import type { FrozenAgentConfig, StructuredTurnContractV3 } from '../../template/template-schema';
import type {
  FillSessionGrantV1,
  JsonObject,
  JsonValue,
  SlotCapabilityV1,
  StructuredSlotLimitsV1,
} from '../../../shared/structured-slots';
import { startAttempt, deriveDraftId, deriveTurnId } from './attempt-coordinator';
import { StructuredSlotGrantService, type ActiveScaffoldV1 } from './grant-service';
import { StructuredSlotProposalService, type SubmitStructureContext } from './proposal-service';
import type { MergeCommitCandidate } from '../../storage/structured-slot-private-store';
import type { ProposalNode } from '../../storage/structured-slot-private-store';
import type { ForgeAction } from '../forge-actions';
import {
  deriveStructuredCommitId,
  prepareStructuredCommit,
  type StructuredCommitContext,
} from './structured-committer';
import type { SealCandidateV1 } from './tool-factory';
import type { SealRecord } from '../../../shared/structured-slots';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

afterEach(() => {
  disposeAllTestRoots();
});

const TASK = 'task-15';
const SNAPSHOT = 'snapshot-1';
const AGENT_ONE = 'agent-1';
const AGENT_TWO = 'agent-2';
const SC = 'scaffold-1';
const GEN = 'gen-1';
const INPUT = 'in-1';

const CAPABILITIES_STRUCTURE: readonly SlotCapabilityV1[] = [
  'read_structure_contract',
  'write_structure_proposal',
  'submit_structure_proposal',
];
const CAPABILITIES_FILL: readonly SlotCapabilityV1[] = [
  'read_slot_spec',
  'read_slot_content',
  'write_draft_content',
  'submit_draft',
];

const PROFILE: AccessProfileV1 = {
  id: 'fill-profile',
  read: [
    {
      targets: { kind: 'types', typeIds: ['title', 'body'] },
      targetLevel: 'content',
      context: { level: 'outline', ancestors: 0, descendants: 0, directSiblings: false },
    },
  ],
  writeContent: [{ targets: { kind: 'types', typeIds: ['title', 'body'] } }],
  continuity: { precedingFilled: false },
};

const MESSAGE_ROUTES = [
  { from: AGENT_ONE, to: AGENT_TWO, kind: 'message' as const, label: 'message reply' },
];

const AGENTS = [
  { id: AGENT_ONE, name: 'Agent One' },
  { id: AGENT_TWO, name: 'Agent Two' },
];

const V3_STRUCTURE_CONTRACT: StructuredTurnContractV3 = {
  version: 3,
  slotSession: {
    kind: 'structure',
    accessProfile: null,
    capabilities: [...CAPABILITIES_STRUCTURE],
    completion: 'structure_commit_candidate_created',
  },
  dispatch: { allowedActions: ['send_message'], targets: { send_message: [AGENT_TWO] } },
};

const V3_FILL_CONTRACT: StructuredTurnContractV3 = {
  version: 3,
  slotSession: {
    kind: 'fill',
    accessProfile: PROFILE.id,
    capabilities: [...CAPABILITIES_FILL],
    completion: 'merge_candidate_created',
  },
  dispatch: { allowedActions: ['send_message'], targets: { send_message: [AGENT_TWO] } },
};

const V3_SEAL_CONTRACT: StructuredTurnContractV3 = {
  version: 3,
  slotSession: {
    kind: 'seal',
    accessProfile: PROFILE.id,
    capabilities: ['request_seal'],
    completion: 'seal_candidate_created',
    failureDispatch: { when: 'seal_gate_failed', action: 'send_message' },
  },
  dispatch: { allowedActions: ['send_message', 'publish_artifact'], targets: { send_message: [AGENT_TWO] } },
};

function makeLimits(): StructuredSlotLimitsV1 {
  return {
    schema: { maxSchemaDepth: 4, maxSchemaNodes: 1024, maxEnumItems: 64, maxPatternLength: 128 },
    structure: { maxSlots: 64, maxTreeDepth: 8, maxChildrenPerSlot: 32 },
    payload: { maxSpecBytesPerSlot: 4096, maxContentBytesPerSlot: 65536, maxScaffoldPayloadBytes: 65536 },
    draft: { maxChangedSlots: 32, maxDraftBytes: 65536 },
    attempt: {
      maxSlotToolCallsPerAttempt: 64,
      maxValidationRunsPerAttempt: 8,
      maxValidatorInvocationsPerAttempt: 200,
      maxAggregateValidatorCpuMsPerAttempt: 2000,
      maxAggregateValidatorWallClockMsPerAttempt: 4000,
      maxValidatorOutputBytesPerAttempt: 4096,
      maxAttemptWallClockMs: 10000,
    },
    validation: {
      maxValidators: 4,
      maxValidatorInvocationsPerGate: 10,
      maxAggregateValidatorCpuMsPerGate: 500,
      maxAggregateValidatorWallClockMsPerGate: 1000,
      maxValidatorOutputBytesPerGate: 512,
      maxIssuesPerRun: 50,
    },
    output: { maxArtifactFiles: 4, maxArtifactBytesPerFile: 1024, maxTotalArtifactBytes: 4096 },
  };
}

function slotType(id: string, presence: 'forbidden' | 'required' = 'forbidden'): FrozenSlotTypeV1 {
  const limits = makeLimits();
  return {
    id,
    name: id,
    description: `slot type ${id}`,
    specSchema: compileSlotSchemaV1(
      { type: 'object', additionalProperties: false, properties: { purpose: { type: 'string' } }, required: ['purpose'] },
      limits,
    ),
    content:
      presence === 'forbidden'
        ? { presence }
        : { presence, schema: compileSlotSchemaV1({ type: 'string', minLength: 1, maxLength: 200 }, limits) },
  };
}

function makeContract(): FrozenStructuredSlotContractV1 {
  const limits = makeLimits();
  const document = slotType('document');
  const title = slotType('title', 'required');
  const body = slotType('body', 'required');
  const slotTypes = [document, title, body];
  const layoutGrammar = compileLayoutGrammarV1(
    {
      rootType: 'document',
      productions: {
        document: {
          children: { kind: 'sequence', items: [{ kind: 'slot', type: 'title' }, { kind: 'slot', type: 'body' }] },
        },
        title: { children: { kind: 'empty' } },
        body: { children: { kind: 'empty' } },
      },
    },
    new Set(slotTypes.map((t) => t.id)),
    limits,
  );
  return {
    version: 1,
    slotTypes,
    layoutGrammar,
    accessProfiles: [PROFILE],
    validators: [],
    assembler: {
      id: 'asm',
      implementation: { abi: 'forge-assembler/v1', path: 'slots/assembler/a.cjs' },
      budget: { cpuMs: 1, timeoutMs: 1, memoryMiB: 1 },
      routes: [],
    },
    limits,
    resourceManifest: [],
    abiProfileIdentity: {
      validatorAbi: 'forge-validator/v1',
      assemblerAbi: 'forge-assembler/v1',
      profileIdentity: 'forge-structured-runtime/v1',
    },
    semanticDigest: 'test',
  };
}

const SLOTS: SlotInstance[] = [
  { slotId: 'r', scaffoldId: SC, parentSlotId: null, order: 0, typeId: 'document', spec: {}, contentPresence: 'unset' },
  { slotId: 't1', scaffoldId: SC, parentSlotId: 'r', order: 1, typeId: 'title', spec: { purpose: 'head' }, contentPresence: 'set', content: 'base-title' },
  { slotId: 'b1', scaffoldId: SC, parentSlotId: 'r', order: 2, typeId: 'body', spec: { purpose: 'para' }, contentPresence: 'unset' },
];

const PROPOSAL_TREE: ProposalNode = {
  clientKey: 'root',
  typeId: 'document',
  spec: { purpose: 'root' },
  children: [
    { clientKey: 'title', typeId: 'title', spec: { purpose: 'head' }, children: [] },
    { clientKey: 'body', typeId: 'body', spec: { purpose: 'para' }, children: [] },
  ],
};

function makeAgent(id: string, name: string, contract: StructuredTurnContractV3): FrozenAgentConfig {
  return {
    id,
    name,
    description: '',
    systemPrompt: '',
    model: 'configured/test-model',
    skills: [],
    gate: null,
    slotCapabilities: [],
    turnContract: contract,
  };
}

/** The base structured harness: real store + blob/private/artifact stores + one input. */
async function structuredHarness(): Promise<{
  paths: ReturnType<typeof makeTempCorePaths>['paths'];
  taskId: string;
  store: EventStore;
  blobStore: StructuredSlotBlobStore;
  privateStore: StructuredSlotPrivateStore;
  artifactStore: ArtifactStore;
  contract: FrozenStructuredSlotContractV1;
  readEvents: () => Promise<readonly CommittedEvent[]>;
  seedInput: () => Promise<void>;
}> {
  const { paths } = makeTempCorePaths('forge-core-structured-committer-');
  const taskId = TASK;
  const store = new EventStore(paths);
  await store.append(taskId, makeTaskEvent({ type: 'task_started', at: '2026-01-01T00:00:00.000Z' }));
  return {
    paths,
    taskId,
    store,
    blobStore: new StructuredSlotBlobStore(paths, taskId),
    privateStore: new StructuredSlotPrivateStore(paths, taskId),
    artifactStore: new ArtifactStore(paths, store),
    contract: makeContract(),
    readEvents: () => store.read(taskId),
    async seedInput() {
      await store.append(
        taskId,
        makeTaskEvent({
          id: INPUT,
          at: '2026-01-01T00:00:00.000Z',
          type: 'agent_input',
          node: makeEventNode({ sequence: 1, agentId: AGENT_ONE, kind: 'input' }),
        }),
      );
    },
  };
}

function contextBase(h: Awaited<ReturnType<typeof structuredHarness>>, turnId: string): {
  taskId: string;
  turnId: string;
  inputNodeId: string;
  attemptEpoch: number;
  snapshotHash: string;
  contract: FrozenStructuredSlotContractV1;
  events: EventStore;
  blobStore: StructuredSlotBlobStore;
  privateStore: StructuredSlotPrivateStore;
  artifactStore: ArtifactStore;
  finalSubmitters: readonly string[];
  submitStructureContext: SubmitStructureContext;
  agents: ReadonlyArray<{ id: string; name: string }>;
  declaredRoutes: ReadonlyArray<{ from: string; to: string; kind: 'message' | 'artifact'; label: string }>;
} {
  return {
    taskId: h.taskId,
    turnId,
    inputNodeId: INPUT,
    attemptEpoch: 1,
    snapshotHash: SNAPSHOT,
    contract: h.contract,
    events: h.store,
    blobStore: h.blobStore,
    privateStore: h.privateStore,
    artifactStore: h.artifactStore,
    finalSubmitters: [AGENT_ONE],
    submitStructureContext: { scaffoldId: SC, generationId: GEN },
    agents: AGENTS,
    declaredRoutes: MESSAGE_ROUTES,
  };
}

async function startStructureAttempt(
  h: Awaited<ReturnType<typeof structuredHarness>>,
): Promise<{ turnId: string; attemptEpoch: number }> {
  const events = await h.readEvents();
  const result = await startAttempt({
    taskId: h.taskId,
    inputNodeId: INPUT,
    agentId: AGENT_ONE,
    sessionKind: 'structure',
    events,
    readEvents: async () => h.readEvents(),
    appendBatch: (commitId, batch, expectedLastSequence) =>
      h.store.appendBatch(h.taskId, commitId, batch, { expectedLastSequence }),
  });
  return { turnId: result.turnId, attemptEpoch: result.attemptEpoch };
}

async function startFillAttempt(
  h: Awaited<ReturnType<typeof structuredHarness>>,
  baseRevision: number,
  inputNodeId = INPUT,
): Promise<{ turnId: string; attemptEpoch: number; draftId: string }> {
  const events = await h.readEvents();
  const result = await startAttempt({
    taskId: h.taskId,
    inputNodeId,
    agentId: AGENT_ONE,
    sessionKind: 'fill',
    events,
    readEvents: async () => h.readEvents(),
    appendBatch: (commitId, batch, expectedLastSequence) =>
      h.store.appendBatch(h.taskId, commitId, batch, { expectedLastSequence }),
    draftContext: { scaffoldId: SC, generationId: GEN, baseRevision },
  });
  return { turnId: result.turnId, attemptEpoch: result.attemptEpoch, draftId: deriveDraftId(result.turnId) };
}

async function startSealAttempt(
  h: Awaited<ReturnType<typeof structuredHarness>>,
): Promise<{ turnId: string; attemptEpoch: number }> {
  const events = await h.readEvents();
  const result = await startAttempt({
    taskId: h.taskId,
    inputNodeId: INPUT,
    agentId: AGENT_ONE,
    sessionKind: 'seal',
    events,
    readEvents: async () => h.readEvents(),
    appendBatch: (commitId, batch, expectedLastSequence) =>
      h.store.appendBatch(h.taskId, commitId, batch, { expectedLastSequence }),
  });
  return { turnId: result.turnId, attemptEpoch: result.attemptEpoch };
}

/** Stages a custody candidate and freezes the seal dispatch state (Task 16). */
async function formSealCandidate(
  h: Awaited<ReturnType<typeof structuredHarness>>,
  turnId: string,
  content = 'sealed story body',
): Promise<SealCandidateV1> {
  const contentIdentity = 'e'.repeat(64);
  const sealRecord: SealRecord = {
    sealId: `seal-${contentIdentity.slice(0, 8)}`,
    caseId: h.taskId,
    scaffoldId: SC,
    scaffoldRevision: 0,
    scaffoldTreeHash: 'a'.repeat(64),
    templateId: 'tpl',
    templateVersion: 'v1',
    snapshotHash: SNAPSHOT,
    assemblerId: 'asm',
    assemblerVersion: 'asm-v1',
    artifactVersionRef: { artifactId: '', version: 0 },
    outputs: [
      {
        routeId: 'out-1',
        path: 'content.md',
        mediaType: 'text/markdown; charset=utf-8',
        byteLength: Buffer.byteLength(content, 'utf8'),
        sha256: sha256(content),
      },
    ],
    sealedAt: '2026-01-01T00:00:00.000Z',
  };
  const prepared = await h.artifactStore.prepareStructuredVersion(h.taskId, {
    contentIdentity,
    files: [{ name: 'content.md', content }],
    meta: { title: 'Sealed Story', sourceNodeId: `${turnId}-result`, format: 'markdown' },
    sealRecord,
  });
  return {
    sealId: prepared.sealRecord.sealId,
    contentIdentity,
    turnId,
    scaffoldId: SC,
    generationId: GEN,
    scaffoldRevision: 0,
    artifact: prepared,
    sealRecord: prepared.sealRecord,
    sourceNodeId: `${turnId}-result`,
    title: prepared.title,
    format: prepared.format,
  };
}

/** Forms the structure candidate through the REAL proposal service + gate. */
async function formStructureCandidate(
  h: Awaited<ReturnType<typeof structuredHarness>>,
  turnId: string,
): Promise<{ candidate: NonNullable<StructuredCommitContext['structureCandidate']>; proposalId: string }> {
  const contract = h.contract;
  const grantService = new StructuredSlotGrantService({ taskId: h.taskId, snapshotHash: SNAPSHOT, contract });
  const proposalId = `${turnId}-proposal`;
  const grantRes = grantService.resolveStructureGrant({
    taskId: h.taskId,
    turnId,
    agentId: AGENT_ONE,
    sessionKind: 'structure',
    snapshotHash: SNAPSHOT,
    capabilities: CAPABILITIES_STRUCTURE,
    proposalId,
  });
  expect(grantRes.ok).toBe(true);
  if (!grantRes.ok) throw new Error('grant failed');
  await h.privateStore.materializeProposal(turnId, proposalId);
  const service = new StructuredSlotProposalService({
    taskId: h.taskId,
    snapshotHash: SNAPSHOT,
    contract,
    store: h.privateStore,
    events: async () => (await h.readEvents()).map((entry) => entry.event),
  });
  const put = await service.putProposal(grantRes.grant, PROPOSAL_TREE);
  expect(put.ok).toBe(true);
  const submit = await service.submitProposal(grantRes.grant, { scaffoldId: SC, generationId: GEN });
  expect(submit.ok).toBe(true);
  if (!submit.ok) throw new Error('submit failed');
  return { candidate: submit.candidate, proposalId };
}

/** Forms a fill candidate directly from a staged content root. */
async function formFillCandidate(
  h: Awaited<ReturnType<typeof structuredHarness>>,
  turnId: string,
  baseRevision: number,
  change: { slotId: string; content: JsonValue } | null,
): Promise<MergeCommitCandidate> {
  const draftId = deriveDraftId(turnId);
  await h.privateStore.materializeDraft(turnId, draftId, { scaffoldId: SC, generationId: GEN, baseRevision });
  let contentRevisionDigest: string | null = null;
  if (change !== null) {
    const contentValue = await h.blobStore.putContentValue(change.content);
    const staged = await h.blobStore.putContentRevision({ r: 'unset', t1: contentValue.sha256, b1: 'unset' });
    contentRevisionDigest = staged.sha256;
    await h.privateStore.replaceContent(draftId, change.slotId, change.content);
  }
  const candidate: MergeCommitCandidate = {
    taskId: h.taskId,
    turnId,
    draftId,
    scaffoldId: SC,
    baseRevision,
    resultRevision: change !== null ? baseRevision + 1 : baseRevision,
    changeCount: change !== null ? 1 : 0,
    normalizedChanges:
      change !== null ? [{ slotId: change.slotId, presence: 'set' as const, content: change.content }] : [],
    contentRevisionDigest,
  };
  await h.privateStore.storeDraftCandidate(draftId, candidate);
  return candidate;
}

/** Seeds a committed generation (revision 0) plus an optional prior merged fill. */
async function seedGeneration(
  h: Awaited<ReturnType<typeof structuredHarness>>,
  options: { priorMergedTitle?: string } = {},
): Promise<void> {
  const manifest = await h.blobStore.putGeneration({ generationId: GEN, scaffoldId: SC, slots: [...SLOTS] });
  const baseTitle = await h.blobStore.putContentValue('base-title');
  const contentRoot = await h.blobStore.putContentRevision({ r: 'unset', t1: baseTitle.sha256, b1: 'unset' });
  await h.store.append(
    h.taskId,
    makeTaskEvent({
      id: 'gen-committed',
      at: '2026-01-01T00:00:00.000Z',
      type: 'structured_scaffold_generation_committed',
      scaffoldId: SC,
      generationId: GEN,
      supersedesGenerationId: null,
      rootSlotId: 'r',
      slotCount: 3,
      maxDepth: 1,
      structure: manifest.structure,
      content: contentRoot,
      contentRevision: 0,
      proposalId: 'proposal-1',
    }),
  );
  if (options.priorMergedTitle !== undefined) {
    const mergedTitle = await h.blobStore.putContentValue(options.priorMergedTitle);
    const mergedRoot = await h.blobStore.putContentRevision({ r: 'unset', t1: mergedTitle.sha256, b1: 'unset' });
    const prior = [
      makeTaskEvent({ id: 'prior-attempt-started', at: '2026-01-01T00:00:00.000Z', type: 'structured_slot_attempt_started', inputNodeId: 'in-0', agentId: AGENT_ONE, attemptEpoch: 1, turnId: 'in-0-t1', sessionKind: 'fill' }),
      makeTaskEvent({ id: 'prior-draft-opened', at: '2026-01-01T00:00:00.000Z', type: 'structured_fill_draft_opened', draftId: 'draft-0', turnId: 'in-0-t1', scaffoldId: SC, generationId: GEN, baseRevision: 0 }),
      makeTaskEvent({ id: 'prior-draft-terminal', at: '2026-01-01T00:00:00.000Z', type: 'structured_fill_draft_terminal', draftId: 'draft-0', turnId: 'in-0-t1', status: 'merged', baseRevision: 0, resultRevision: 1, changeCount: 1, content: mergedRoot }),
      makeTaskEvent({ id: 'prior-attempt-terminal', at: '2026-01-01T00:00:00.000Z', type: 'structured_slot_attempt_terminal', inputNodeId: 'in-0', attemptEpoch: 1, turnId: 'in-0-t1', status: 'committed', reason: 'completion_dispatch' }),
    ];
    for (const event of prior) {
      await h.store.append(h.taskId, event);
    }
  }
}

function isAttemptTerminal(
  event: TaskEvent,
): event is Extract<TaskEvent, { type: 'structured_slot_attempt_terminal' }> {
  return event.type === 'structured_slot_attempt_terminal';
}

function isDraftTerminal(
  event: TaskEvent,
): event is Extract<TaskEvent, { type: 'structured_fill_draft_terminal' }> {
  return event.type === 'structured_fill_draft_terminal';
}

// ---------------------------------------------------------------------------
// Step 2: structure batch
// ---------------------------------------------------------------------------

describe('prepareStructuredCommit — structure generation batch', () => {
  it('commits generation + agent result + terminal + message Route/input in ONE batch', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    const { turnId } = await startStructureAttempt(h);
    const { candidate, proposalId } = await formStructureCandidate(h, turnId);

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'structure',
      structureCandidate: candidate,
      mergeCandidate: null,
      sealDispatch: { status: 'none' },
      publicText: 'structure ready',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_STRUCTURE_CONTRACT),
    };
    const action: ForgeAction = { type: 'send_message', targetAgentId: AGENT_TWO, summary: 'structure ready' };

    const prepared = await prepareStructuredCommit(context, action);
    expect(prepared.kind).toBe('structure_generation');
    expect(prepared.replayed).toBe(false);
    expect(prepared.waitingHuman).toBe(false);
    expect(prepared.nextAgentIds).toEqual([AGENT_TWO]);
    expect(prepared.phase).toMatchObject({ state: 'dispatched', dispatchAction: 'send_message', target: AGENT_TWO });

    const snapshot = (await h.readEvents()).map((entry) => entry.event);
    const commitId = deriveStructuredCommitId(context, 'structure_generation', action, snapshot);
    const batch = await h.store.readBatchByCommitId(h.taskId, commitId);
    expect(batch).not.toBeNull();
    const batchEvents = batch!.map((entry) => entry.event);
    const types = batchEvents.map((event) => event.type).sort();
    expect(types).toEqual([
      'agent_input',
      'agent_result',
      'route_executed',
      'structured_scaffold_generation_committed',
      'structured_slot_attempt_terminal',
    ]);

    const generation = batchEvents.find(
      (event): event is Extract<TaskEvent, { type: 'structured_scaffold_generation_committed' }> =>
        event.type === 'structured_scaffold_generation_committed',
    )!;
    expect(generation).toMatchObject({
      scaffoldId: SC,
      generationId: GEN,
      supersedesGenerationId: null,
      slotCount: 3,
      // PROPOSAL_TREE is document → [title, body] (two siblings at depth 1):
      // the generation preserves the proposal's parent/child shape, so the
      // depth is 1 — never the buggy nested document → title → body.
      maxDepth: 1,
      contentRevision: 0,
      proposalId,
    });
    expect(generation.rootSlotId).toMatch(/^[a-f0-9]{64}$/);
    expect(generation.structure.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(generation.content.sha256).toMatch(/^[a-f0-9]{64}$/);

    const result = batchEvents.find((event): event is Extract<TaskEvent, { type: 'agent_result' }> => event.type === 'agent_result')!;
    expect(result).toMatchObject({
      inputNodeId: INPUT,
      dispatchKind: 'send',
    });
    expect(result.node).toMatchObject({ agentId: AGENT_ONE, kind: 'result', status: 'confirmed', body: 'structure ready' });

    const terminal = batchEvents.find(isAttemptTerminal)!;
    expect(terminal).toMatchObject({ turnId, status: 'committed', reason: 'completion_dispatch' });

    const route = batchEvents.find((event): event is Extract<TaskEvent, { type: 'route_executed' }> => event.type === 'route_executed')!;
    const input = batchEvents.find((event): event is Extract<TaskEvent, { type: 'agent_input' }> => event.type === 'agent_input')!;
    expect(route.route).toMatchObject({ kind: 'message', fromNodeId: `${turnId}-result`, toNodeId: `${turnId}-message-input-0`, label: 'message reply' });
    expect(input.node).toMatchObject({ agentId: AGENT_TWO, kind: 'input', status: 'confirmed', body: 'structure ready' });

    // Event projection makes the Proposal committed.
    const view = await h.privateStore.readProposal(proposalId, snapshot);
    expect(view.lifecycle).toBe('committed');
  });

  it('writes the promoted generation + content-root blobs before the batch (no authority without it)', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    const { turnId } = await startStructureAttempt(h);
    const { candidate } = await formStructureCandidate(h, turnId);

    // Failure BEFORE the batch: the attempt is already terminalized by a
    // competing stop — the committer writes NOTHING and the private submission
    // lock stays nonterminal.
    const events = await h.readEvents();
    const tail = events.at(-1)!.sequence;
    await h.store.appendBatch(
      h.taskId,
      `${turnId}-stop`,
      [
        makeTaskEvent({ id: `${turnId}-task-stopped`, at: '2026-01-01T00:00:00.000Z', type: 'task_stopped' }),
        makeTaskEvent({ id: `${turnId}-attempt-terminal`, at: '2026-01-01T00:00:00.000Z', type: 'structured_slot_attempt_terminal', inputNodeId: INPUT, attemptEpoch: 1, turnId, status: 'abandoned', reason: 'task_stop' }),
      ],
      { expectedLastSequence: tail },
    );

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'structure',
      structureCandidate: candidate,
      mergeCandidate: null,
      sealDispatch: { status: 'none' },
      publicText: 'structure ready',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_STRUCTURE_CONTRACT),
    };
    const action: ForgeAction = { type: 'send_message', targetAgentId: AGENT_TWO, summary: 'structure ready' };
    await expect(prepareStructuredCommit(context, action)).rejects.toThrow(/ATTEMPT_NOT_ACTIVE/);

    const after = await h.readEvents();
    expect(after.filter((entry) => entry.event.type === 'structured_scaffold_generation_committed')).toHaveLength(0);
    // The private submission lock (formed at submit time) is NOT terminalized.
    const view = await h.privateStore.readProposal(candidate.proposalId, after.map((entry) => entry.event));
    expect(view.locked).toBe(true);
    expect(view.lifecycle).not.toBe('committed');
  });
});

// ---------------------------------------------------------------------------
// Step 3: fill merge / no-op / stale
// ---------------------------------------------------------------------------

describe('prepareStructuredCommit — fill merge batches', () => {
  it('nonempty merge increments the revision exactly once with the staged content root', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    await seedGeneration(h);
    const { turnId, draftId } = await startFillAttempt(h, 0);
    const candidate = await formFillCandidate(h, turnId, 0, { slotId: 't1', content: 'merged-title' });

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'fill',
      structureCandidate: null,
      mergeCandidate: candidate,
      sealDispatch: { status: 'none' },
      publicText: 'filled',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_FILL_CONTRACT),
    };
    const action: ForgeAction = { type: 'send_message', targetAgentId: AGENT_TWO, summary: 'filled' };

    const prepared = await prepareStructuredCommit(context, action);
    expect(prepared.kind).toBe('fill_merge');

    const snapshot = (await h.readEvents()).map((entry) => entry.event);
    const commitId = deriveStructuredCommitId(context, 'fill_merge', action, snapshot);
    const batch = await h.store.readBatchByCommitId(h.taskId, commitId);
    const batchEvents = batch!.map((entry) => entry.event);
    const types = batchEvents.map((event) => event.type).sort();
    expect(types).toEqual([
      'agent_input',
      'agent_result',
      'route_executed',
      'structured_fill_draft_terminal',
      'structured_slot_attempt_terminal',
    ]);

    const draftTerminal = batchEvents.find(isDraftTerminal)!;
    expect(draftTerminal).toMatchObject({
      draftId,
      turnId,
      status: 'merged',
      baseRevision: 0,
      resultRevision: 1,
      changeCount: 1,
    });
    expect(draftTerminal.content).not.toBeNull();
    expect(draftTerminal.content!.sha256).toBe(candidate.contentRevisionDigest);
    const terminal = batchEvents.find(isAttemptTerminal)!;
    expect(terminal).toMatchObject({ status: 'committed', reason: 'completion_dispatch' });

    // Revision increments exactly once.
    const state = await import('../../storage/structured-slot-state').then((m) => m.projectStructuredSlotState(snapshot));
    expect(state.contentRevision).toBe(1);
  });

  it('no-op emits Draft terminal(merged) + dispatch with NO content blob and NO revision bump', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    await seedGeneration(h);
    const { turnId, draftId } = await startFillAttempt(h, 0);
    const candidate = await formFillCandidate(h, turnId, 0, null);

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'fill',
      structureCandidate: null,
      mergeCandidate: candidate,
      sealDispatch: { status: 'none' },
      publicText: 'noop',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_FILL_CONTRACT),
    };
    const action: ForgeAction = { type: 'send_message', targetAgentId: AGENT_TWO, summary: 'noop' };

    const prepared = await prepareStructuredCommit(context, action);
    expect(prepared.kind).toBe('fill_noop');

    const snapshot = (await h.readEvents()).map((entry) => entry.event);
    const commitId = deriveStructuredCommitId(context, 'fill_noop', action, snapshot);
    const batch = await h.store.readBatchByCommitId(h.taskId, commitId);
    const batchEvents = batch!.map((entry) => entry.event);
    const draftTerminal = batchEvents.find(isDraftTerminal)!;
    expect(draftTerminal).toMatchObject({
      draftId,
      turnId,
      status: 'merged',
      baseRevision: 0,
      resultRevision: 0,
      changeCount: 0,
      content: null,
    });
    // No content blob was referenced; the revision never advanced.
    expect(batchEvents.some((event) => event.type === 'structured_scaffold_generation_committed')).toBe(false);
    const state = await import('../../storage/structured-slot-state').then((m) => m.projectStructuredSlotState(snapshot));
    expect(state.contentRevision).toBe(0);
    expect(prepared.nextAgentIds).toEqual([AGENT_TWO]);
  });

  it('stale candidate writes ONE failure terminal and NO content authority', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    await seedGeneration(h, { priorMergedTitle: 'merged-title' });
    // The active content revision is now 1; open a draft at baseRevision 0 —
    // its candidate is stale the moment it is committed.
    const { turnId, draftId } = await startFillAttempt(h, 0);
    const candidate = await formFillCandidate(h, turnId, 0, { slotId: 't1', content: 'stale-merge' });

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'fill',
      structureCandidate: null,
      mergeCandidate: candidate,
      sealDispatch: { status: 'none' },
      publicText: 'stale',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_FILL_CONTRACT),
    };
    const action: ForgeAction = { type: 'send_message', targetAgentId: AGENT_TWO, summary: 'stale' };

    const prepared = await prepareStructuredCommit(context, action);
    expect(prepared.kind).toBe('fill_stale');

    const snapshot = (await h.readEvents()).map((entry) => entry.event);
    const commitId = deriveStructuredCommitId(context, 'fill_stale', action, snapshot);
    const batch = await h.store.readBatchByCommitId(h.taskId, commitId);
    expect(batch).not.toBeNull();
    const batchEvents = batch!.map((entry) => entry.event);
    expect(batchEvents.filter(isAttemptTerminal)).toHaveLength(1);
    const attemptTerminal = batchEvents.find(isAttemptTerminal)!;
    expect(attemptTerminal).toMatchObject({ status: 'failed', reason: 'runtime_failure' });
    const draftTerminal = batchEvents.find(isDraftTerminal)!;
    expect(draftTerminal).toMatchObject({ draftId, status: 'stale', baseRevision: 0, resultRevision: 0, content: null });
    // NO content authority: no content blob referenced, no route, no agent result.
    expect(batchEvents.some((event) => event.type === 'route_executed')).toBe(false);
    expect(batchEvents.some((event) => event.type === 'agent_result')).toBe(false);
  });

  it('crash after the authority batch before any private cache still reports merged and repairs the cache', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    await seedGeneration(h);
    const { turnId, draftId } = await startFillAttempt(h, 0);
    const candidate = await formFillCandidate(h, turnId, 0, { slotId: 't1', content: 'merged-title' });

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'fill',
      structureCandidate: null,
      mergeCandidate: candidate,
      sealDispatch: { status: 'none' },
      publicText: 'filled',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_FILL_CONTRACT),
    };
    const action: ForgeAction = { type: 'send_message', targetAgentId: AGENT_TWO, summary: 'filled' };
    await prepareStructuredCommit(context, action);

    // Simulate a stale/contradicting cache marker that was never repaired
    // because the process crashed before the (optional) cache update.
    await h.privateStore.markDraftLifecycleCache(draftId, 'open', 'bogus-event-id');

    // Reload: the authority events alone report merged, and the read repairs
    // the contradicting marker.
    const snapshot = (await h.readEvents()).map((entry) => entry.event);
    const view = await h.privateStore.readDraft(draftId, snapshot);
    expect(view.lifecycle).toBe('merged');
    const state = await import('../../storage/structured-slot-state').then((m) => m.projectStructuredSlotState(snapshot));
    expect(state.drafts[draftId]?.status).toBe('merged');
  });
});

// ---------------------------------------------------------------------------
// Step 4: seal rework + human
// ---------------------------------------------------------------------------

describe('prepareStructuredCommit — seal rework', () => {
  it('sends the rework only to the frozen v3 target and keeps scaffold revision/phase', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    await seedGeneration(h);
    const { turnId } = await startFillAttempt(h, 0); // session kind is seal for the dispatch below

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'seal',
      structureCandidate: null,
      mergeCandidate: null,
      sealDispatch: { status: 'rework_required', reworkTarget: AGENT_TWO },
      publicText: 'seal failed summary',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_SEAL_CONTRACT),
    };
    const action: ForgeAction = { type: 'send_message', targetAgentId: AGENT_TWO, summary: 'seal failed summary' };

    const prepared = await prepareStructuredCommit(context, action);
    expect(prepared.kind).toBe('seal_rework');

    const snapshot = (await h.readEvents()).map((entry) => entry.event);
    const commitId = deriveStructuredCommitId(context, 'seal_rework', action, snapshot);
    const batch = await h.store.readBatchByCommitId(h.taskId, commitId);
    expect(batch).not.toBeNull();
    const batchEvents = batch!.map((entry) => entry.event);
    expect(batchEvents.filter(isAttemptTerminal)).toHaveLength(1);
    const terminal = batchEvents.find(isAttemptTerminal)!;
    expect(terminal).toMatchObject({ status: 'committed', reason: 'rework_dispatch' });
    const route = batchEvents.find((event): event is Extract<TaskEvent, { type: 'route_executed' }> => event.type === 'route_executed')!;
    expect(route.route).toMatchObject({ kind: 'message', toNodeId: `${turnId}-message-input-0` });
    // No scaffold event: revision/phase stay active_unsealed.
    expect(batchEvents.some((event) => event.type === 'structured_scaffold_generation_committed')).toBe(false);
    expect(batchEvents.some((event) => event.type === 'structured_scaffold_sealed')).toBe(false);
    const state = await import('../../storage/structured-slot-state').then((m) => m.projectStructuredSlotState(snapshot));
    expect(state.sealStatus).toBe('unsealed');
    expect(state.contentRevision).toBe(0);
  });

  it('rejects a rework send to any target other than the frozen rework target', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    await seedGeneration(h);
    const { turnId } = await startFillAttempt(h, 0);

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'seal',
      structureCandidate: null,
      mergeCandidate: null,
      sealDispatch: { status: 'rework_required', reworkTarget: AGENT_TWO },
      publicText: 'seal failed',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_SEAL_CONTRACT),
    };
    // The contract's send targets only name AGENT_TWO; sending to another agent
    // is not a declared route and must fail closed with NO write.
    const before = await h.readEvents();
    await expect(
      prepareStructuredCommit(context, {
        type: 'send_message',
        targetAgentId: 'agent-3',
        summary: 'wrong target',
      } as ForgeAction),
    ).rejects.toThrow(/ROUTE_NOT_ALLOWED/);
    expect(await h.readEvents()).toEqual(before);
  });
});

describe('prepareStructuredCommit — human abandon', () => {
  it('atomically writes Agent result + waiting_human terminal + human_requested and abandons the Draft', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    await seedGeneration(h);
    const { turnId, draftId } = await startFillAttempt(h, 0);
    const candidate = await formFillCandidate(h, turnId, 0, { slotId: 't1', content: 'draft-content' });

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'fill',
      structureCandidate: null,
      mergeCandidate: candidate,
      sealDispatch: { status: 'none' },
      publicText: 'need human',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_FILL_CONTRACT),
    };
    const action: ForgeAction = { type: 'request_human_input', question: 'Please review the scaffold.' };

    const prepared = await prepareStructuredCommit(context, action);
    expect(prepared.kind).toBe('human_abandon');
    expect(prepared.waitingHuman).toBe(true);

    const snapshot = (await h.readEvents()).map((entry) => entry.event);
    const commitId = deriveStructuredCommitId(context, 'human_abandon', action, snapshot);
    const batch = await h.store.readBatchByCommitId(h.taskId, commitId);
    expect(batch).not.toBeNull();
    const batchEvents = batch!.map((entry) => entry.event);
    const types = batchEvents.map((event) => event.type).sort();
    expect(types).toEqual([
      'agent_result',
      'human_requested',
      'structured_fill_draft_terminal',
      'structured_slot_attempt_terminal',
    ]);
    const terminal = batchEvents.find(isAttemptTerminal)!;
    expect(terminal).toMatchObject({ status: 'waiting_human', reason: 'human_request' });
    const human = batchEvents.find((event): event is Extract<TaskEvent, { type: 'human_requested' }> => event.type === 'human_requested')!;
    expect(human).toMatchObject({ question: 'Please review the scaffold.', source: 'agent_request' });
    const draftTerminal = batchEvents.find(isDraftTerminal)!;
    expect(draftTerminal).toMatchObject({ draftId, status: 'abandoned', content: null });
    const result = batchEvents.find((event): event is Extract<TaskEvent, { type: 'agent_result' }> => event.type === 'agent_result')!;
    expect(result.dispatchKind).toBe('human');

    // The Draft lifecycle is abandoned through the authority events.
    const view = await h.privateStore.readDraft(draftId, snapshot);
    expect(view.lifecycle).toBe('abandoned');
  });

  it('abandons a structure Proposal too (waiting_human terminal closes the attempt)', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    const { turnId } = await startStructureAttempt(h);
    const { candidate, proposalId } = await formStructureCandidate(h, turnId);

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'structure',
      structureCandidate: candidate,
      mergeCandidate: null,
      sealDispatch: { status: 'none' },
      publicText: 'need human',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_STRUCTURE_CONTRACT),
    };
    const action: ForgeAction = { type: 'request_human_input', question: 'Help me.' };

    const prepared = await prepareStructuredCommit(context, action);
    expect(prepared.kind).toBe('human_abandon');

    const snapshot = (await h.readEvents()).map((entry) => entry.event);
    const commitId = deriveStructuredCommitId(context, 'human_abandon', action, snapshot);
    const batch = await h.store.readBatchByCommitId(h.taskId, commitId);
    const batchEvents = batch!.map((entry) => entry.event);
    expect(batchEvents.some((event) => event.type === 'structured_scaffold_generation_committed')).toBe(false);
    const view = await h.privateStore.readProposal(proposalId, snapshot);
    expect(view.lifecycle).toBe('abandoned');
  });
});

// ---------------------------------------------------------------------------
// Step 5: response-loss replay with changing ephemeral fields
// ---------------------------------------------------------------------------

describe('prepareStructuredCommit — completion-signature replay', () => {
  it('replays the EXACT original mapping when the clock and the random/id source changed', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    const { turnId } = await startStructureAttempt(h);
    const { candidate } = await formStructureCandidate(h, turnId);

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'structure',
      structureCandidate: candidate,
      mergeCandidate: null,
      sealDispatch: { status: 'none' },
      publicText: 'structure ready',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_STRUCTURE_CONTRACT),
    };
    const action: ForgeAction = { type: 'send_message', targetAgentId: AGENT_TWO, summary: 'structure ready' };

    // First commit with a frozen clock.
    const first = await prepareStructuredCommit(context, action);
    expect(first.replayed).toBe(false);

    // Advance the clock to a totally different time.
    let nowMs = Date.parse('2026-02-02T02:02:02.000Z');
    const laterContext: StructuredCommitContext = {
      ...context,
      clock: () => new Date(nowMs),
    };

    const second = await prepareStructuredCommit(laterContext, action);
    expect(second.replayed).toBe(true);
    // The mapping is EXACTLY the original: same ids AND same original at bytes.
    expect(second.committed.map((entry) => entry.event.id)).toEqual(
      first.committed.map((entry) => entry.event.id),
    );
    for (let i = 0; i < first.committed.length; i += 1) {
      expect(second.committed[i]?.event.at).toBe(first.committed[i]?.event.at);
      expect(second.committed[i]?.sequence).toBe(first.committed[i]?.sequence);
    }
  });

  it('concurrent same-signature callers commit one winner and both return the same batch', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    const { turnId } = await startStructureAttempt(h);
    const { candidate } = await formStructureCandidate(h, turnId);

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'structure',
      structureCandidate: candidate,
      mergeCandidate: null,
      sealDispatch: { status: 'none' },
      publicText: 'structure ready',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_STRUCTURE_CONTRACT),
    };
    const action: ForgeAction = { type: 'send_message', targetAgentId: AGENT_TWO, summary: 'structure ready' };

    const [first, second] = await Promise.all([
      prepareStructuredCommit(context, action),
      prepareStructuredCommit(context, action),
    ]);
    expect(first.committed.map((entry) => entry.event.id)).toEqual(
      second.committed.map((entry) => entry.event.id),
    );
    // Exactly one generation event in the whole history.
    const all = (await h.readEvents()).map((entry) => entry.event);
    expect(all.filter((event) => event.type === 'structured_scaffold_generation_committed')).toHaveLength(1);
    expect(all.filter(isAttemptTerminal)).toHaveLength(1);
  });

  it('a changed candidate digest does NOT reuse the prior result and loses against the committed terminal', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    const { turnId } = await startStructureAttempt(h);
    const { candidate } = await formStructureCandidate(h, turnId);

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'structure',
      structureCandidate: candidate,
      mergeCandidate: null,
      sealDispatch: { status: 'none' },
      publicText: 'structure ready',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_STRUCTURE_CONTRACT),
    };
    const action: ForgeAction = { type: 'send_message', targetAgentId: AGENT_TWO, summary: 'structure ready' };
    const first = await prepareStructuredCommit(context, action);

    // A DIFFERENT candidate digest on the same turn: the commitId differs, the
    // batch does not exist, and the attempt is already terminalized — the new
    // candidate loses against the committed terminal and writes nothing.
    const changedCandidate: NonNullable<StructuredCommitContext['structureCandidate']> = {
      ...candidate,
      slotCount: candidate.slotCount + 1,
    };
    const changedContext: StructuredCommitContext = {
      ...context,
      structureCandidate: changedCandidate,
    };
    await expect(prepareStructuredCommit(changedContext, action)).rejects.toThrow(/ATTEMPT_NOT_ACTIVE/);

    // The committed batch is untouched; exactly one generation exists.
    const all = (await h.readEvents()).map((entry) => entry.event);
    expect(all.filter((event) => event.type === 'structured_scaffold_generation_committed')).toHaveLength(1);
    expect(all.filter(isAttemptTerminal)).toHaveLength(1);
    expect(first.committed.length).toBeGreaterThan(0);
  });

  it('a changed dispatch target does NOT reuse the prior result and loses against the committed terminal', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    const { turnId } = await startStructureAttempt(h);
    const { candidate } = await formStructureCandidate(h, turnId);

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'structure',
      structureCandidate: candidate,
      mergeCandidate: null,
      sealDispatch: { status: 'none' },
      publicText: 'structure ready',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_STRUCTURE_CONTRACT),
    };
    const action: ForgeAction = { type: 'send_message', targetAgentId: AGENT_TWO, summary: 'structure ready' };
    await prepareStructuredCommit(context, action);

    // Same candidate but a changed dispatch target: different commitId, no
    // batch, attempt already terminalized — fails closed.
    const changedAction: ForgeAction = { type: 'send_message', targetAgentId: 'agent-3', summary: 'structure ready' };
    await expect(prepareStructuredCommit(context, changedAction)).rejects.toThrow(/ATTEMPT_NOT_ACTIVE|ROUTE_NOT_ALLOWED/);

    const all = (await h.readEvents()).map((entry) => entry.event);
    expect(all.filter((event) => event.type === 'structured_scaffold_generation_committed')).toHaveLength(1);
  });

  it('replays a fill merge even after the merge itself advanced the active revision', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    await seedGeneration(h);
    const { turnId, draftId } = await startFillAttempt(h, 0);
    const candidate = await formFillCandidate(h, turnId, 0, { slotId: 't1', content: 'merged-title' });

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'fill',
      structureCandidate: null,
      mergeCandidate: candidate,
      sealDispatch: { status: 'none' },
      publicText: 'filled',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_FILL_CONTRACT),
    };
    const action: ForgeAction = { type: 'send_message', targetAgentId: AGENT_TWO, summary: 'filled' };

    const first = await prepareStructuredCommit(context, action);
    expect(first.kind).toBe('fill_merge');

    // The committed merge advanced the active revision to 1. A response-loss
    // retry of the SAME completion must still pre-read the original batch and
    // return the original mapping — it must NOT be reclassified stale (the
    // candidate kind is derived from the candidate alone, never the state).
    const second = await prepareStructuredCommit(context, action);
    expect(second.replayed).toBe(true);
    expect(second.kind).toBe('fill_merge');
    expect(second.committed.map((entry) => entry.event.id)).toEqual(
      first.committed.map((entry) => entry.event.id),
    );
    const draftTerminal = second.committed.find(
      (entry): entry is typeof entry & { event: Extract<TaskEvent, { type: 'structured_fill_draft_terminal' }> } =>
        entry.event.type === 'structured_fill_draft_terminal',
    );
    expect(draftTerminal?.event).toMatchObject({ draftId, status: 'merged', resultRevision: 1 });
  });
});

// ---------------------------------------------------------------------------
// Step 6 (Task 16): seal success — publish + direct final
// ---------------------------------------------------------------------------

const SEAL_ROUTES = [
  { from: AGENT_ONE, to: AGENT_TWO, kind: 'message' as const, label: 'message reply' },
  { from: AGENT_ONE, to: AGENT_TWO, kind: 'artifact' as const, label: 'artifact handoff' },
];

describe('prepareStructuredCommit — seal success (Task 16)', () => {
  it('publish_artifact creates artifact_published + sealed + Agent result + terminal + artifact Route/input in ONE batch', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    await seedGeneration(h);
    const { turnId } = await startSealAttempt(h);
    const candidate = await formSealCandidate(h, turnId);

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'seal',
      structureCandidate: null,
      mergeCandidate: null,
      sealDispatch: { status: 'passed', declaredDispatches: ['publish_artifact', 'submit_final_artifact'], candidate },
      publicText: 'sealed',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_SEAL_CONTRACT),
      declaredRoutes: SEAL_ROUTES,
    };
    const action: ForgeAction = { type: 'publish_artifact' };

    const prepared = await prepareStructuredCommit(context, action);
    expect(prepared.kind).toBe('seal_publish');
    expect(prepared.taskCompleted).toBe(false); // Seal/publish NEVER completes the task
    expect(prepared.publishedVersions).toEqual([1]);
    expect(prepared.nextAgentIds).toEqual([AGENT_TWO]);
    expect(prepared.phase).toMatchObject({ state: 'dispatched', dispatchAction: 'publish_artifact', target: AGENT_TWO });

    const snapshot = (await h.readEvents()).map((entry) => entry.event);
    const commitId = deriveStructuredCommitId(context, 'seal_publish', action, snapshot);
    const batch = await h.store.readBatchByCommitId(h.taskId, commitId);
    expect(batch).not.toBeNull();
    const batchEvents = batch!.map((entry) => entry.event);
    const types = batchEvents.map((event) => event.type).sort();
    expect(types).toEqual([
      'agent_input',
      'agent_result',
      'artifact_published',
      'route_executed',
      'structured_scaffold_sealed',
      'structured_slot_attempt_terminal',
    ]);

    const published = batchEvents.find((event): event is Extract<TaskEvent, { type: 'artifact_published' }> => event.type === 'artifact_published')!;
    expect(published.artifact).toMatchObject({
      version: 1,
      title: 'Sealed Story',
      format: 'markdown',
      artifactId: candidate.artifact.artifactId,
    });
    expect(published.artifact.files).toEqual([{ name: 'content.md', hash: sha256('sealed story body') }]);

    const sealed = batchEvents.find((event): event is Extract<TaskEvent, { type: 'structured_scaffold_sealed' }> => event.type === 'structured_scaffold_sealed')!;
    expect(sealed).toMatchObject({
      sealId: candidate.sealId,
      scaffoldId: SC,
      generationId: GEN,
      scaffoldRevision: 0,
      artifactId: candidate.artifact.artifactId,
      artifactVersion: 1,
    });
    expect(sealed.sealRecord.kind).toBe('seal_record');
    expect(sealed.sealRecord.sha256).toMatch(/^[a-f0-9]{64}$/);

    const terminal = batchEvents.find(isAttemptTerminal)!;
    expect(terminal).toMatchObject({ turnId, status: 'committed', reason: 'completion_dispatch' });

    const route = batchEvents.find((event): event is Extract<TaskEvent, { type: 'route_executed' }> => event.type === 'route_executed')!;
    expect(route.route).toMatchObject({ kind: 'artifact', fromNodeId: `${turnId}-result`, label: 'artifact handoff' });
    const input = batchEvents.find((event): event is Extract<TaskEvent, { type: 'agent_input' }> => event.type === 'agent_input')!;
    expect(input.node).toMatchObject({ agentId: AGENT_TWO, kind: 'input', inputVersion: 1 });

    // The promoted version is now event-backed and readable, with the SealRecord
    // blob readable through the blob store.
    const entry = await h.artifactStore.read(h.taskId, 1);
    expect(entry.files[0].content).toBe('sealed story body');
    const sealRecordBlob = await h.blobStore.readBlob(sealed.sealRecord.sha256);
    const parsed = JSON.parse(sealRecordBlob.toString('utf8')) as SealRecord;
    expect(parsed.artifactVersionRef).toEqual({ artifactId: candidate.artifact.artifactId, version: 1 });

    // The projection flips the scaffold to sealed.
    const state = await import('../../storage/structured-slot-state').then((m) => m.projectStructuredSlotState(snapshot));
    expect(state.sealStatus).toBe('sealed');
  });

  it('submit_final_artifact by the declared submitter creates artifact_published + sealed + final_submission_accepted and completes the task', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    await seedGeneration(h);
    const { turnId } = await startSealAttempt(h);
    const candidate = await formSealCandidate(h, turnId);

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'seal',
      structureCandidate: null,
      mergeCandidate: null,
      sealDispatch: { status: 'passed', declaredDispatches: ['publish_artifact', 'submit_final_artifact'], candidate },
      publicText: 'sealed final',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_SEAL_CONTRACT),
      declaredRoutes: SEAL_ROUTES,
    };
    const action: ForgeAction = { type: 'submit_final_artifact' };

    const prepared = await prepareStructuredCommit(context, action);
    expect(prepared.kind).toBe('seal_final');
    expect(prepared.taskCompleted).toBe(true); // ONLY final_submission_accepted completes the task
    expect(prepared.publishedVersions).toEqual([1]);
    expect(prepared.nextAgentIds).toEqual([]);
    expect(prepared.phase).toMatchObject({ state: 'dispatched', dispatchAction: 'submit_final_artifact', target: null });

    const snapshot = (await h.readEvents()).map((entry) => entry.event);
    const commitId = deriveStructuredCommitId(context, 'seal_final', action, snapshot);
    const batch = await h.store.readBatchByCommitId(h.taskId, commitId);
    expect(batch).not.toBeNull();
    const batchEvents = batch!.map((entry) => entry.event);
    const types = batchEvents.map((event) => event.type).sort();
    expect(types).toEqual([
      'agent_result',
      'artifact_published',
      'final_submission_accepted',
      'structured_scaffold_sealed',
      'structured_slot_attempt_terminal',
    ]);
    const final = batchEvents.find((event): event is Extract<TaskEvent, { type: 'final_submission_accepted' }> => event.type === 'final_submission_accepted')!;
    expect(final).toMatchObject({ artifactId: candidate.artifact.artifactId, version: 1 });
    // No Route/input for a direct final.
    expect(batchEvents.some((event) => event.type === 'route_executed')).toBe(false);
    expect(batchEvents.some((event) => event.type === 'agent_input')).toBe(false);
  });

  it('rejects submit_final_artifact when the current agent is not the declared submitter', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    await seedGeneration(h);
    const { turnId } = await startSealAttempt(h);
    const candidate = await formSealCandidate(h, turnId);

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'seal',
      structureCandidate: null,
      mergeCandidate: null,
      sealDispatch: { status: 'passed', declaredDispatches: ['submit_final_artifact'], candidate },
      publicText: 'sealed',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_SEAL_CONTRACT),
      finalSubmitters: [AGENT_TWO], // AGENT_ONE is NOT the declared submitter
      declaredRoutes: SEAL_ROUTES,
    };
    const before = await h.readEvents();
    await expect(
      prepareStructuredCommit(context, { type: 'submit_final_artifact' }),
    ).rejects.toThrow(/ROUTE_NOT_ALLOWED/);
    expect(await h.readEvents()).toEqual(before);
    expect(await h.artifactStore.list(h.taskId)).toEqual([]);
  });

  it('rejects submit_final_artifact the turn did NOT declare, even for a template final submitter; publish still commits', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    await seedGeneration(h);
    const { turnId } = await startSealAttempt(h);
    const candidate = await formSealCandidate(h, turnId);

    // The turn contract declared ONLY publish_artifact. The agent IS a template
    // final submitter (contextBase finalSubmitters = [AGENT_ONE]) — the frozen
    // declared dispatch set must still gate the commit at the authority boundary.
    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'seal',
      structureCandidate: null,
      mergeCandidate: null,
      sealDispatch: { status: 'passed', declaredDispatches: ['publish_artifact'], candidate },
      publicText: 'sealed',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_SEAL_CONTRACT),
      declaredRoutes: SEAL_ROUTES,
    };

    const before = await h.readEvents();
    await expect(
      prepareStructuredCommit(context, { type: 'submit_final_artifact' }),
    ).rejects.toThrow(/DISPATCH_NOT_ALLOWED/);
    // Nothing was written: no task completion, no artifact, no sealed event.
    expect(await h.readEvents()).toEqual(before);
    expect(await h.artifactStore.list(h.taskId)).toEqual([]);
    const beforeEvents = before.map((entry) => entry.event);
    expect(beforeEvents.some((event) => event.type === 'final_submission_accepted')).toBe(false);

    // The publish path on the SAME turn (still active) commits normally.
    const prepared = await prepareStructuredCommit(context, { type: 'publish_artifact' });
    expect(prepared.kind).toBe('seal_publish');
    expect(prepared.taskCompleted).toBe(false);
    expect(prepared.publishedVersions).toEqual([1]);
    const all = (await h.readEvents()).map((entry) => entry.event);
    expect(all.filter((event) => event.type === 'artifact_published')).toHaveLength(1);
    expect(all.filter((event) => event.type === 'structured_scaffold_sealed')).toHaveLength(1);
    expect(all.filter((event) => event.type === 'final_submission_accepted')).toHaveLength(0);
  });

  it('a publish without a passed seal candidate fails closed and writes nothing', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    await seedGeneration(h);
    const { turnId } = await startSealAttempt(h);

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'seal',
      structureCandidate: null,
      mergeCandidate: null,
      sealDispatch: { status: 'none' },
      publicText: 'sealed',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_SEAL_CONTRACT),
      declaredRoutes: SEAL_ROUTES,
    };
    const before = await h.readEvents();
    await expect(
      prepareStructuredCommit(context, { type: 'publish_artifact' }),
    ).rejects.toThrow(/DISPATCH_NOT_ALLOWED/);
    expect(await h.readEvents()).toEqual(before);
  });

  it('replays a seal publish exactly (original mapping) on a response-loss retry', async () => {
    const h = await structuredHarness();
    await h.seedInput();
    await seedGeneration(h);
    const { turnId } = await startSealAttempt(h);
    const candidate = await formSealCandidate(h, turnId);

    const context: StructuredCommitContext = {
      ...contextBase(h, turnId),
      sessionKind: 'seal',
      structureCandidate: null,
      mergeCandidate: null,
      sealDispatch: { status: 'passed', declaredDispatches: ['publish_artifact'], candidate },
      publicText: 'sealed',
      currentAgent: makeAgent(AGENT_ONE, 'Agent One', V3_SEAL_CONTRACT),
      declaredRoutes: SEAL_ROUTES,
    };
    const action: ForgeAction = { type: 'publish_artifact' };

    const first = await prepareStructuredCommit(context, action);
    expect(first.kind).toBe('seal_publish');
    expect(first.replayed).toBe(false);

    let nowMs = Date.parse('2026-02-02T02:02:02.000Z');
    const second = await prepareStructuredCommit({ ...context, clock: () => new Date(nowMs) }, action);
    expect(second.replayed).toBe(true);
    expect(second.committed.map((entry) => entry.event.id)).toEqual(
      first.committed.map((entry) => entry.event.id),
    );
    for (let i = 0; i < first.committed.length; i += 1) {
      expect(second.committed[i]?.event.at).toBe(first.committed[i]?.event.at);
    }
    const all = (await h.readEvents()).map((entry) => entry.event);
    expect(all.filter((event) => event.type === 'artifact_published')).toHaveLength(1);
    expect(all.filter((event) => event.type === 'structured_scaffold_sealed')).toHaveLength(1);
    expect(all.filter((event) => event.type === 'final_submission_accepted')).toHaveLength(0);
  });
});
