// @vitest-environment node
/**
 * Structure session service tests (Task 12 Steps 2-3, design §11.3, spec §9.1).
 *
 * Step 2 — session + guard: the structure session state carries the grant, the
 * proposal/candidate reference, and the completion; a formed candidate LOCKS
 * the session. `assertStructuredForgeAction` is the dispatch-guard foundation:
 * before a candidate only the exclusive `request_human_input` abandon exit is
 * legal; after `structure_commit_candidate_created` only `send_message` (the
 * completion dispatch) plus `request_human_input` remain. `getStructureStatus`
 * reconciles the private journal against TaskEvents (Task 7 authority).
 *
 * Step 3 — first-session grant: starting with NO active scaffold, the Proposal
 * is created BEFORE the structure Grant is signed; the completed candidate
 * carries no fake scaffoldId/revision anywhere.
 *
 * The data-source seam (Task 10 StructuredSlotDataSource) is adapted to the
 * Task 7 blob store + state projection and verified end-to-end.
 */
import { mkdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { disposeAllTestRoots, makeTaskEvent, makeTempCorePaths } from '../../test-support';
import type { FrozenStructuredSlotContractV1, FrozenSlotTypeV1 } from '../../template/structured-slot-contract';
import type {
  FillSessionGrantV1,
  StructureSessionGrantV1,
  StructuredSlotLimitsV1,
  JsonObject,
} from '../../../shared/structured-slots';
import { compileLayoutGrammarV1 } from '../../structured-slots/layout-grammar';
import { compileSlotSchemaV1 } from '../../structured-slots/slot-schema';
import {
  StructuredSlotPrivateStore,
  type MergeCommitCandidate,
  type ProposalNode,
} from '../../storage/structured-slot-private-store';
import { StructuredSlotBlobStore } from '../../storage/structured-slot-blob-store';
import type { TaskEvent } from '../../storage/task-events';
import type { ForgeAction } from '../forge-actions';
import { StructuredSlotGrantService } from './grant-service';
import { StructuredSlotProposalService } from './proposal-service';
import {
  StructuredSlotSessionService,
  assertStructuredForgeAction,
  createStructuredSlotDataSource,
  type FillSessionState,
  type StructureSessionState,
} from './session-service';

afterEach(() => {
  disposeAllTestRoots();
});

const TASK = 'task-12';
const SNAPSHOT = 'snapshot-1';
const TURN = 'turn-1';
const AGENT = 'agent-1';
const PROPOSAL = 'proposal-1';
const CAPABILITIES: StructureSessionGrantV1['capabilities'] = [
  'read_structure_contract',
  'write_structure_proposal',
  'validate_structure_proposal',
  'submit_structure_proposal',
];

function makeLimits(): StructuredSlotLimitsV1 {
  return {
    schema: { maxSchemaDepth: 8, maxSchemaNodes: 1024, maxEnumItems: 64, maxPatternLength: 128 },
    structure: { maxSlots: 64, maxTreeDepth: 8, maxChildrenPerSlot: 32 },
    payload: { maxSpecBytesPerSlot: 4096, maxContentBytesPerSlot: 65536, maxScaffoldPayloadBytes: 65536 },
    draft: { maxChangedSlots: 64, maxDraftBytes: 65536 },
    attempt: {
      maxSlotToolCallsPerAttempt: 16,
      maxValidationRunsPerAttempt: 4,
      maxValidatorInvocationsPerAttempt: 100,
      maxAggregateValidatorCpuMsPerAttempt: 1000,
      maxAggregateValidatorWallClockMsPerAttempt: 2000,
      maxValidatorOutputBytesPerAttempt: 1024,
      maxAttemptWallClockMs: 5000,
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
  const quote = slotType('quote', 'required');
  const slotTypes = [document, title, body, quote];
  const layoutGrammar = compileLayoutGrammarV1(
    {
      rootType: 'document',
      productions: {
        document: {
          children: {
            kind: 'sequence',
            items: [
              { kind: 'slot', type: 'title' },
              {
                kind: 'repeat',
                min: 0,
                max: 16,
                item: { kind: 'choice', items: [{ kind: 'slot', type: 'body' }, { kind: 'slot', type: 'quote' }] },
              },
            ],
          },
        },
        title: { children: { kind: 'empty' } },
        body: { children: { kind: 'empty' } },
        quote: { children: { kind: 'empty' } },
      },
    },
    new Set(slotTypes.map((t) => t.id)),
    limits,
  );
  return {
    version: 1,
    slotTypes,
    layoutGrammar,
    accessProfiles: [],
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

interface Harness {
  contract: FrozenStructuredSlotContractV1;
  proposal: StructuredSlotProposalService;
  sessions: StructuredSlotSessionService;
  grantService: StructuredSlotGrantService;
  store: StructuredSlotPrivateStore;
  events: TaskEvent[];
  grant: StructureSessionGrantV1;
}

function makeHarness(): Harness {
  const { paths } = makeTempCorePaths('forge-core-session-');
  mkdirSync(paths.taskRoot(TASK), { recursive: true });
  const contract = makeContract();
  const store = new StructuredSlotPrivateStore(paths, TASK);
  const events: TaskEvent[] = [];
  const proposal = new StructuredSlotProposalService({ taskId: TASK, snapshotHash: SNAPSHOT, contract, store, events: async () => events });
  const sessions = new StructuredSlotSessionService({ taskId: TASK, snapshotHash: SNAPSHOT, store, events: async () => events });
  const grantService = new StructuredSlotGrantService({ taskId: TASK, snapshotHash: SNAPSHOT, contract });
  const resolved = grantService.resolveStructureGrant({
    taskId: TASK,
    turnId: TURN,
    agentId: AGENT,
    sessionKind: 'structure',
    snapshotHash: SNAPSHOT,
    capabilities: CAPABILITIES,
    proposalId: PROPOSAL,
    grantId: 'grant-1',
  });
  if (!resolved.ok) throw new Error(`test grant failed: ${resolved.reason}`);
  return { contract, proposal, sessions, grantService, store, events, grant: resolved.grant };
}

function node(clientKey: string, typeId: string, spec: JsonObject = {}, children: ProposalNode[] = []): ProposalNode {
  return { clientKey, typeId, spec, children };
}

function validTree(): ProposalNode {
  return node('root', 'document', { purpose: 'doc' }, [
    node('t1', 'title', { purpose: 'head' }),
    node('b1', 'body', { purpose: 'para' }),
  ]);
}

const SUBMIT_CONTEXT = { scaffoldId: 'scaffold-1', generationId: 'gen-1' };

describe('structure session state (design §11.3)', () => {
  it('builds an open session state bound to the structure grant', async () => {
    const { sessions, store, grant } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    const result = await sessions.openSession(grant);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.state;
    expect(state.version).toBe(1);
    expect(state.sessionKind).toBe('structure');
    expect(state.turnId).toBe(TURN);
    expect(state.grant).toEqual(grant);
    expect(state.proposalId).toBe(PROPOSAL);
    expect(state.proposalLifecycle).toBe('open');
    expect(state.candidate).toBeNull();
    expect(state.completion).toBeNull();
    expect(state.receipt).toBeNull();
    expect(state.locked).toBe(false);
  });

  it('a formed candidate is surfaced as completion + locked session + safe receipt', async () => {
    const { proposal, sessions, store, grant } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    await proposal.putProposal(grant, validTree());
    await proposal.submitProposal(grant, SUBMIT_CONTEXT);

    const result = await sessions.openSession(grant);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.state;
    expect(state.candidate).not.toBeNull();
    expect(state.completion).toBe('structure_commit_candidate_created');
    expect(state.locked).toBe(true);
    expect(state.receipt).toEqual({
      kind: 'structure',
      status: 'candidate_created',
      changeCount: 3,
      issueSummary: { errors: 0, warnings: 0 },
    });
  });
});

describe('assertStructuredForgeAction — structure dispatch guard (design §11.3)', () => {
  const send: ForgeAction = { type: 'send_message', targetAgentId: 'next', summary: 'done' };
  const human: ForgeAction = { type: 'request_human_input', question: 'please review' };
  const publish: ForgeAction = { type: 'publish_artifact' };
  const finish: ForgeAction = { type: 'finish_production', source: 'inline', files: [], format: 'markdown', artifactType: null, title: null };

  function openState(): StructureSessionState {
    return {
      version: 1,
      sessionKind: 'structure',
      turnId: TURN,
      grant: null,
      proposalId: PROPOSAL,
      proposalLifecycle: 'open',
      candidate: null,
      completion: null,
      receipt: null,
      locked: false,
    };
  }

  function candidateState(): StructureSessionState {
    return {
      version: 1,
      sessionKind: 'structure',
      turnId: TURN,
      grant: null,
      proposalId: PROPOSAL,
      proposalLifecycle: 'open',
      candidate: {
        taskId: TASK,
        turnId: TURN,
        proposalId: PROPOSAL,
        snapshotHash: SNAPSHOT,
        generationId: 'gen-1',
        rootSlotId: 'r',
        slotCount: 3,
        slotIdByClientKey: { root: 'r', t1: 's1', b1: 's2' },
        normalizedTree: validTree(),
        contentRevision: 0,
      },
      completion: 'structure_commit_candidate_created',
      receipt: { kind: 'structure', status: 'candidate_created', changeCount: 3, issueSummary: { errors: 0, warnings: 0 } },
      locked: true,
    };
  }

  it('before a candidate only the exclusive request_human_input exit is legal', () => {
    const state = openState();
    expect(assertStructuredForgeAction(state, human).ok).toBe(true);
    expect(assertStructuredForgeAction(state, send).ok).toBe(false);
    expect(assertStructuredForgeAction(state, publish).ok).toBe(false);
    expect(assertStructuredForgeAction(state, finish).ok).toBe(false);
  });

  it('after the candidate only send_message plus request_human_input are legal', () => {
    const state = candidateState();
    expect(assertStructuredForgeAction(state, send).ok).toBe(true);
    expect(assertStructuredForgeAction(state, human).ok).toBe(true);
    expect(assertStructuredForgeAction(state, publish).ok).toBe(false);
    expect(assertStructuredForgeAction(state, finish).ok).toBe(false);
    expect(assertStructuredForgeAction(state, { type: 'forward_input_version', targetAgentId: 'x' }).ok).toBe(false);
  });
});

describe('getStructureStatus — lifecycle by event reconciliation (Task 7 authority)', () => {
  it('reports open -> candidate_created -> committed -> abandoned over the journal + events', async () => {
    const { proposal, sessions, store, events, grant } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);

    let status = await sessions.getStructureStatus(grant);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.status).toBe('open');
    expect(status.receipt).toEqual({ kind: 'structure', status: 'open', changeCount: 0, issueSummary: { errors: 0, warnings: 0 } });

    await proposal.putProposal(grant, validTree());
    await proposal.submitProposal(grant, SUBMIT_CONTEXT);
    status = await sessions.getStructureStatus(grant);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.status).toBe('candidate_created');
    expect(status.receipt.changeCount).toBe(3);

    // A committed generation for this proposal is the authority for 'committed'.
    events.push(
      makeTaskEvent({
        type: 'structured_scaffold_generation_committed',
        scaffoldId: 'scaffold-1',
        generationId: 'gen-1',
        supersedesGenerationId: null,
        rootSlotId: 'r',
        slotCount: 3,
        maxDepth: 1,
        structure: { version: 1, kind: 'generation', sha256: 'a'.repeat(64), byteLength: 4 },
        content: { version: 1, kind: 'content_revision', sha256: 'b'.repeat(64), byteLength: 4 },
        contentRevision: 0,
        proposalId: PROPOSAL,
      }),
    );
    status = await sessions.getStructureStatus(grant);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.status).toBe('committed');

    // A grant referencing a proposal that was never materialized is invalid
    // (fail closed — no empty-state status is invented).
    const missing = await sessions.getStructureStatus({ ...grant, proposalId: 'proposal-missing' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('GRANT_INVALID');

    // An abandoned terminal for the turn makes a fresh proposal 'abandoned'
    // (committed stays the authority for proposal-1 above).
    await store.materializeProposal(TURN, 'proposal-abandoned');
    events.push(
      makeTaskEvent({
        type: 'structured_slot_attempt_terminal',
        inputNodeId: 'in-1',
        attemptEpoch: 1,
        turnId: TURN,
        status: 'abandoned',
        reason: 'task_stop',
      }),
    );
    const ab = await sessions.getStructureStatus({ ...grant, proposalId: 'proposal-abandoned' });
    expect(ab.ok).toBe(true);
    if (!ab.ok) return;
    expect(ab.status).toBe('abandoned');
  });

  it('rejects a grant bound to a different task or snapshot', async () => {
    const { sessions, store, grant } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    const wrongTask = await sessions.getStructureStatus({ ...grant, caseId: 'other' });
    expect(wrongTask.ok).toBe(false);
    if (!wrongTask.ok) expect(wrongTask.code).toBe('GRANT_INVALID');
    const wrongSnapshot = await sessions.getStructureStatus({ ...grant, snapshotHash: 'other' });
    expect(wrongSnapshot.ok).toBe(false);
    if (!wrongSnapshot.ok) expect(wrongSnapshot.code).toBe('GRANT_INVALID');
  });
});

describe('first-session grant flow (brief Step 3)', () => {
  it('starts with NO scaffold, creates the Proposal BEFORE the grant, and completes a candidate without fake scaffoldId/revision', async () => {
    const { proposal, sessions, grantService, store, grant } = makeHarness();
    // No active scaffold: the event log has no generation event.
    expect(store).toBeDefined();

    // 1. Create the open Proposal first (design §9.1: proposal before grant).
    await store.materializeProposal(TURN, PROPOSAL);

    // 2. Sign the structure Grant bound ONLY to snapshot + proposal.
    const signed = grantService.resolveStructureGrant({
      taskId: TASK,
      turnId: TURN,
      agentId: AGENT,
      sessionKind: 'structure',
      snapshotHash: SNAPSHOT,
      capabilities: CAPABILITIES,
      proposalId: PROPOSAL,
      grantId: 'grant-first',
    });
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const firstGrant = signed.grant;
    expect(firstGrant).not.toHaveProperty('scaffoldId');
    expect(firstGrant).not.toHaveProperty('baseRevision');
    expect(firstGrant).not.toHaveProperty('readableSlotIds');
    expect(firstGrant).not.toHaveProperty('writableSlotIds');
    expect(firstGrant).not.toHaveProperty('draftId');

    // 3. Complete a candidate through the full gate with NO fake scaffoldId.
    await proposal.putProposal(firstGrant, validTree());
    const submitted = await proposal.submitProposal(firstGrant, SUBMIT_CONTEXT);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    // The candidate and receipt carry no scaffoldId/revision/engineering fields.
    const candidateJson = JSON.stringify(submitted.candidate);
    for (const forbidden of ['scaffoldId', 'grantId', 'agentId', 'acl', 'blob', 'path']) {
      expect(candidateJson).not.toContain(forbidden);
    }
    // The normalized tree obeys the exact ProposalNode shape.
    for (const forbidden of ['"content"', '"slotId"', '"revision"', '"path"', '"acl"', '"grantId"']) {
      expect(JSON.stringify(submitted.candidate.normalizedTree)).not.toContain(forbidden);
    }
    expect(Object.keys(submitted.receipt).sort()).toEqual(['changeCount', 'issueSummary', 'kind', 'status'].sort());
    expect(submitted.receipt).toEqual({
      kind: 'structure',
      status: 'candidate_created',
      changeCount: 3,
      issueSummary: { errors: 0, warnings: 0 },
    });

    // The session reflects the completed candidate.
    const state = await sessions.openSession(firstGrant);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.state.completion).toBe('structure_commit_candidate_created');
    expect(state.state.locked).toBe(true);
  });
});

describe('StructuredSlotDataSource seam (Task 10) adapted to the Task 7 store', () => {
  it('exposes active generation, index, slot and content presence from blob store + events', async () => {
    const { paths } = makeTempCorePaths('forge-core-source-');
    mkdirSync(paths.taskRoot(TASK), { recursive: true });
    const blobStore = new StructuredSlotBlobStore(paths, TASK);
    const events: TaskEvent[] = [];

    const slots = [
      {
        slotId: 'r',
        scaffoldId: 'scaffold-1',
        parentSlotId: null,
        order: 0,
        typeId: 'document',
        spec: {},
        contentPresence: 'unset',
      },
      {
        slotId: 't1',
        scaffoldId: 'scaffold-1',
        parentSlotId: 'r',
        order: 1,
        typeId: 'title',
        spec: { purpose: 'head' },
        contentPresence: 'set',
        content: 'Hello',
      },
    ] as const;
    const manifest = await blobStore.putGeneration({ generationId: 'gen-1', scaffoldId: 'scaffold-1', slots: [...slots] });
    const content = await blobStore.putContentValue('Hello');
    const revision = await blobStore.putContentRevision({ r: 'unset', t1: content.sha256 });
    events.push(
      makeTaskEvent({
        type: 'structured_scaffold_generation_committed',
        scaffoldId: 'scaffold-1',
        generationId: 'gen-1',
        supersedesGenerationId: null,
        rootSlotId: 'r',
        slotCount: 2,
        maxDepth: 1,
        structure: manifest.structure,
        content: revision,
        contentRevision: 0,
        proposalId: PROPOSAL,
      }),
    );

    const source = createStructuredSlotDataSource({ blobStore, events: async () => events });
    expect(await source.getActiveGeneration()).toEqual({ scaffoldId: 'scaffold-1', generationId: 'gen-1', contentRevision: 0 });
    const index = await source.getGenerationIndex('gen-1');
    expect(index.documentOrder).toEqual(['r', 't1']);
    const slot = await source.getSlot('gen-1', 't1');
    expect(slot?.typeId).toBe('title');
    expect(slot?.content).toBe('Hello');
    expect(await source.getContentPresence('gen-1', 0)).toEqual({ r: 'unset', t1: 'set' });
    expect(await source.getContentPresence('gen-1', 1)).toEqual({});
  });
});

describe('fill session state + dispatch guard (Task 13, design §11.3/§12.2)', () => {
  const FILL_TURN = 'fill-turn-1';
  const FILL_DRAFT = 'fill-draft-1';
  const FILL_SC = 'scaffold-1';
  const FILL_GEN = 'gen-1';

  const fillGrant: FillSessionGrantV1 = {
    grantId: 'grant-fill',
    kind: 'fill',
    caseId: TASK,
    turnId: FILL_TURN,
    agentId: AGENT,
    snapshotHash: SNAPSHOT,
    capabilities: ['read_slot_spec', 'read_slot_content', 'write_draft_content', 'submit_draft'],
    accessProfileId: 'fill-profile',
    scaffoldId: FILL_SC,
    baseRevision: 0,
    readableSlotIds: ['t1', 'b1'],
    writableSlotIds: ['t1', 'b1'],
    draftId: FILL_DRAFT,
  };

  const fillCandidate: MergeCommitCandidate = {
    taskId: TASK,
    turnId: FILL_TURN,
    draftId: FILL_DRAFT,
    scaffoldId: FILL_SC,
    baseRevision: 0,
    resultRevision: 1,
    changeCount: 1,
    normalizedChanges: [{ slotId: 'b1', presence: 'set', content: 'x' }],
    contentRevisionDigest: null,
  };

  async function fillSetup(): Promise<{ sessions: StructuredSlotSessionService; store: StructuredSlotPrivateStore; events: TaskEvent[] }> {
    const { paths } = makeTempCorePaths('forge-core-session-fill-');
    mkdirSync(paths.taskRoot(TASK), { recursive: true });
    const store = new StructuredSlotPrivateStore(paths, TASK);
    const events: TaskEvent[] = [
      makeTaskEvent({
        type: 'structured_slot_attempt_started',
        inputNodeId: 'in-1',
        agentId: AGENT,
        attemptEpoch: 1,
        turnId: FILL_TURN,
        sessionKind: 'fill',
      }),
      makeTaskEvent({
        type: 'structured_fill_draft_opened',
        draftId: FILL_DRAFT,
        turnId: FILL_TURN,
        scaffoldId: FILL_SC,
        generationId: FILL_GEN,
        baseRevision: 0,
      }),
    ];
    await store.materializeDraft(FILL_TURN, FILL_DRAFT, { scaffoldId: FILL_SC, generationId: FILL_GEN, baseRevision: 0 });
    const sessions = new StructuredSlotSessionService({ taskId: TASK, snapshotHash: SNAPSHOT, store, events: async () => events });
    return { sessions, store, events };
  }

  it('openFillSession builds an open state and a stored candidate is surfaced as locked + completion', async () => {
    const { sessions, store } = await fillSetup();
    const open = await sessions.openFillSession(fillGrant);
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    expect(open.state.version).toBe(1);
    expect(open.state.sessionKind).toBe('fill');
    expect(open.state.draftId).toBe(FILL_DRAFT);
    expect(open.state.draftLifecycle).toBe('open');
    expect(open.state.candidate).toBeNull();
    expect(open.state.completion).toBeNull();
    expect(open.state.receipt).toBeNull();
    expect(open.state.locked).toBe(false);

    await store.storeDraftCandidate(FILL_DRAFT, fillCandidate);
    await store.lockDraft(FILL_DRAFT);
    const after = await sessions.openFillSession(fillGrant);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.state.candidate).toEqual(fillCandidate);
    expect(after.state.completion).toBe('merge_candidate_created');
    expect(after.state.locked).toBe(true);
    expect(after.state.receipt).toEqual({
      kind: 'fill',
      status: 'candidate_created',
      changeCount: 1,
      issueSummary: { errors: 0, warnings: 0 },
    });
  });

  it('getFillStatus reconciles open -> merged -> abandoned over the journal + events', async () => {
    const { sessions, events } = await fillSetup();
    let status = await sessions.getFillStatus(fillGrant);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.status).toBe('open');
    expect(status.receipt).toEqual({ kind: 'fill', status: 'open', changeCount: 0, issueSummary: { errors: 0, warnings: 0 } });

    events.push(
      makeTaskEvent({
        type: 'structured_fill_draft_terminal',
        draftId: FILL_DRAFT,
        turnId: FILL_TURN,
        status: 'merged',
        baseRevision: 0,
        resultRevision: 0,
        changeCount: 0,
        content: null,
      }),
    );
    status = await sessions.getFillStatus(fillGrant);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.status).toBe('merged');

    events.push(
      makeTaskEvent({
        type: 'structured_fill_draft_terminal',
        draftId: FILL_DRAFT,
        turnId: FILL_TURN,
        status: 'abandoned',
        baseRevision: 0,
        resultRevision: 0,
        changeCount: 0,
        content: null,
      }),
    );
    status = await sessions.getFillStatus(fillGrant);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.status).toBe('abandoned');
  });

  it('rejects a fill grant bound to a different task, snapshot or draft', async () => {
    const { sessions } = await fillSetup();
    const wrongTask = await sessions.getFillStatus({ ...fillGrant, caseId: 'other' });
    expect(wrongTask.ok).toBe(false);
    if (!wrongTask.ok) expect(wrongTask.code).toBe('GRANT_INVALID');
    const wrongSnapshot = await sessions.getFillStatus({ ...fillGrant, snapshotHash: 'other' });
    expect(wrongSnapshot.ok).toBe(false);
    if (!wrongSnapshot.ok) expect(wrongSnapshot.code).toBe('GRANT_INVALID');
    const wrongDraft = await sessions.getFillStatus({ ...fillGrant, draftId: 'draft-missing' });
    expect(wrongDraft.ok).toBe(false);
    if (!wrongDraft.ok) expect(wrongDraft.code).toBe('GRANT_INVALID');
  });

  it('fill dispatch guard: only send_message after merge_candidate_created; request_human_input exclusive; forward/annotate never end a fill turn', () => {
    const send: ForgeAction = { type: 'send_message', targetAgentId: 'next', summary: 'done' };
    const human: ForgeAction = { type: 'request_human_input', question: 'please review' };
    const forward: ForgeAction = { type: 'forward_input_version', targetAgentId: 'x' };
    const annotate: ForgeAction = { type: 'annotate_artifact', file: 'a.md', content: 'note' };
    const publish: ForgeAction = { type: 'publish_artifact' };

    const openFill: FillSessionState = {
      version: 1,
      sessionKind: 'fill',
      turnId: FILL_TURN,
      grant: null,
      draftId: FILL_DRAFT,
      draftLifecycle: 'open',
      candidate: null,
      completion: null,
      receipt: null,
      locked: false,
    };
    expect(assertStructuredForgeAction(openFill, send).ok).toBe(false);
    expect(assertStructuredForgeAction(openFill, human).ok).toBe(true);
    expect(assertStructuredForgeAction(openFill, forward).ok).toBe(false);

    const candidateFill: FillSessionState = {
      version: 1,
      sessionKind: 'fill',
      turnId: FILL_TURN,
      grant: null,
      draftId: FILL_DRAFT,
      draftLifecycle: 'open',
      candidate: fillCandidate,
      completion: 'merge_candidate_created',
      receipt: { kind: 'fill', status: 'candidate_created', changeCount: 1, issueSummary: { errors: 0, warnings: 0 } },
      locked: true,
    };
    expect(assertStructuredForgeAction(candidateFill, send).ok).toBe(true);
    expect(assertStructuredForgeAction(candidateFill, human).ok).toBe(true);
    expect(assertStructuredForgeAction(candidateFill, forward).ok).toBe(false);
    expect(assertStructuredForgeAction(candidateFill, annotate).ok).toBe(false);
    expect(assertStructuredForgeAction(candidateFill, publish).ok).toBe(false);
  });
});
