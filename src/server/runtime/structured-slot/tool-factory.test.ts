// @vitest-environment node
/**
 * Slot Tool factory tests (Task 14 Steps 1-3, design §11.3/§12.2/§12.3,
 * spec §9.1-§9.4, §10.6).
 *
 * Step 1 — exact tool registry: structure exposes exactly five Proposal tools,
 * fill exactly seven Draft tools, seal exactly request_seal plus the declared
 * read capabilities, and a basic turn exposes none. Every Slot Tool parameter
 * schema is snapshotted, every definition is `executionMode: 'sequential'`,
 * and NO engineering key (taskId/scaffoldId/draftId/grantId/revision/path/
 * requestId) appears in any parameter schema.
 *
 * Step 2 — progressive disclosure (design §10.6): the fill outline lists
 * authorized slots WITHOUT preceding content; read_slot returns ONE complete
 * authorized content; content above the single-call response limit REJECTS
 * without truncation.
 *
 * Step 3 — dispatch guard: structure/fill send rejects before a candidate and
 * succeeds after; seal passed permits only publish/final, a reliable failure
 * permits only rework send to the frozen target, incomplete permits neither;
 * the human exit stays available until the Attempt closes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SlotInstance } from '../../storage/structured-slot-blob-store';
import { StructuredSlotBlobStore } from '../../storage/structured-slot-blob-store';
import { StructuredSlotPrivateStore } from '../../storage/structured-slot-private-store';
import type { TaskEvent } from '../../storage/task-events';
import { compileLayoutGrammarV1 } from '../../structured-slots/layout-grammar';
import { compileSlotSchemaV1 } from '../../structured-slots/slot-schema';
import { canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { makeTaskEvent, makeTempCorePaths, disposeAllTestRoots } from '../../test-support';
import type {
  AccessProfileV1,
  FrozenStructuredSlotContractV1,
  FrozenSlotTypeV1,
} from '../../template/structured-slot-contract';
import type {
  FillSessionGrantV1,
  JsonValue,
  SlotCapabilityV1,
  SlotSessionGrantV1,
  StructuredSlotLimitsV1,
  StructureSessionGrantV1,
} from '../../../shared/structured-slots';
import { StructuredSlotGrantService, type ActiveScaffoldV1 } from './grant-service';import { createStructuredSlotDataSource, assertStructuredForgeAction, type StructuredSessionState } from './session-service';
import { createTaskLocalCursorSigner, StructuredSlotProjectionService } from './projection-service';
import { AttemptMeter } from './attempt-meter';
import { ValidationEngine } from './validation-engine';
import { deriveDraftId } from './attempt-coordinator';
import { StructuredSlotDraftService } from './draft-service';
import {
  STRUCTURE_TOOL_NAMES,
  FILL_TOOL_NAMES,
  SEAL_TOOL_NAMES,
  SLOT_TOOL_NAME_SET,
  createStructuredSlotToolDefinitions,
  consumeSlotToolPrecharge,
  assertSealDispatchAction,
  type StructuredSlotToolContext,
} from './tool-factory';
import { StructuredSlotProposalService } from './proposal-service';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
  disposeAllTestRoots();
});

const TASK = 'task-14';
const SNAPSHOT = 'snapshot-1';
const TURN = 'turn-1';
const AGENT = 'agent-1';
const SC = 'scaffold-1';
const GEN = 'gen-1';
const DRAFT = deriveDraftId(TURN);
const REV = 0;

const FILL_CAPABILITIES: readonly SlotCapabilityV1[] = [
  'read_slot_spec',
  'read_slot_content',
  'write_draft_content',
  'validate_draft',
  'submit_draft',
];

/** Fixture-shaped limits (≤ 25% of the design candidate profile). */
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

interface FillHarness {
  context: StructuredSlotToolContext;
  service: StructuredSlotDraftService;
  store: StructuredSlotPrivateStore;
  meter: AttemptMeter;
  grant: FillSessionGrantV1;
}

async function makeFillHarness(): Promise<FillHarness> {
  const { paths, dataRoot } = makeTempCorePaths('forge-core-tool-factory-');
  tempRoots.push(dataRoot);
  mkdirSync(paths.taskRoot(TASK), { recursive: true });
  const contract = makeContract();
  const store = new StructuredSlotPrivateStore(paths, TASK);
  const blobStore = new StructuredSlotBlobStore(paths, TASK);
  const events: TaskEvent[] = [];
  const manifest = await blobStore.putGeneration({ generationId: GEN, scaffoldId: SC, slots: [...SLOTS] });
  const baseTitle = await blobStore.putContentValue('base-title');
  const contentRoot = await blobStore.putContentRevision({ r: 'unset', t1: baseTitle.sha256, b1: 'unset' });
  events.push(
    makeTaskEvent({
      type: 'structured_scaffold_generation_committed',
      scaffoldId: SC,
      generationId: GEN,
      supersedesGenerationId: null,
      rootSlotId: 'r',
      slotCount: 3,
      maxDepth: 1,
      structure: manifest.structure,
      content: contentRoot,
      contentRevision: REV,
      proposalId: 'proposal-1',
    }),
    makeTaskEvent({
      type: 'structured_slot_attempt_started',
      inputNodeId: 'in-1',
      agentId: AGENT,
      attemptEpoch: 1,
      turnId: TURN,
      sessionKind: 'fill',
    }),
    makeTaskEvent({
      type: 'structured_fill_draft_opened',
      draftId: DRAFT,
      turnId: TURN,
      scaffoldId: SC,
      generationId: GEN,
      baseRevision: REV,
    }),
  );
  await store.materializeDraft(TURN, DRAFT, { scaffoldId: SC, generationId: GEN, baseRevision: REV });

  const grantService = new StructuredSlotGrantService({ taskId: TASK, snapshotHash: SNAPSHOT, contract });
  const index = await blobStore.getGenerationIndex(GEN);
  const presence: Record<string, 'unset' | 'set'> = { r: 'unset', t1: 'set', b1: 'unset' };
  const resolved = grantService.resolveFillGrant({
    taskId: TASK,
    turnId: TURN,
    agentId: AGENT,
    sessionKind: 'fill',
    snapshotHash: SNAPSHOT,
    capabilities: FILL_CAPABILITIES,
    accessProfileId: PROFILE.id,
    activeScaffold: { scaffoldId: SC, generationId: GEN, contentRevision: REV } as ActiveScaffoldV1,
    generationIndex: index,
    contentPresence: presence,
    baseRevision: REV,
    draftId: DRAFT,
    grantId: 'grant-fill',
  });
  if (!resolved.ok) throw new Error(`test grant failed: ${resolved.reason}`);

  const source = createStructuredSlotDataSource({ blobStore, events: async () => events });
  const projection = new StructuredSlotProjectionService({
    contract,
    source,
    signer: createTaskLocalCursorSigner(TASK),
  });
  const engine = new ValidationEngine({ paths });
  const meter = await AttemptMeter.create({ turnId: TURN, privateStore: store, limits: contract.limits });
  const service = new StructuredSlotDraftService({
    taskId: TASK,
    snapshotHash: SNAPSHOT,
    contract,
    store,
    blobStore,
    projection,
    validation: engine,
    meter,
    events: async () => events,
    // Task 14: consume-only precharge seam — the raw seam precharges first.
    precharge: (ctx) => consumeSlotToolPrecharge(meter, ctx),
  });
  const context: StructuredSlotToolContext = {
    turnId: TURN,
    sessionKind: 'fill',
    grant: resolved.grant,
    state: null,
    meter,
    draftService: service,
  };
  return { context, service, store, meter, grant: resolved.grant };
}

/** Simulates the raw pre-validation seam: persists ONE precharge for the key. */
async function rawPrecharge(
  harness: FillHarness,
  toolName: string,
  toolCallId: string,
  params: unknown,
): Promise<string> {
  const canonicalArgsHash = canonicalJsonSha256(params);
  const charge = await harness.meter.prechargeRawTool({ toolCallId, canonicalArgsHash, toolName });
  expect(charge.status).toBe('ok');
  return canonicalArgsHash;
}

async function executeTool(
  tools: ReturnType<typeof createStructuredSlotToolDefinitions>,
  name: string,
  toolCallId: string,
  params: Record<string, unknown>,
): Promise<{ text: string; accepted: boolean; code?: string }> {
  const tool = tools.find((candidate) => candidate.name === name);
  expect(tool, `tool ${name} must exist`).toBeDefined();
  const result = await tool?.execute(toolCallId, params, undefined, undefined, {} as never);
  const text = result?.content[0]?.type === 'text' ? result.content[0].text : '';
  const details = (result as { details?: { accepted: boolean; code?: string } })?.details;
  return { text, accepted: details?.accepted ?? false, code: details?.code };
}

function structureContext(grant: SlotSessionGrantV1): StructuredSlotToolContext {
  return {
    turnId: TURN,
    sessionKind: 'structure',
    grant,
    state: null,
    meter: { signal: new AbortController().signal } as AttemptMeter,
    proposalService: {} as unknown as StructuredSlotProposalService,
  };
}

/** A full fill grant carrying the closed fill capabilities. */
function fillGrant(): SlotSessionGrantV1 {
  return {
    grantId: 'grant-fill',
    kind: 'fill',
    caseId: TASK,
    turnId: TURN,
    agentId: AGENT,
    snapshotHash: SNAPSHOT,
    capabilities: [...FILL_CAPABILITIES],
    accessProfileId: PROFILE.id,
    scaffoldId: SC,
    baseRevision: REV,
    readableSlotIds: ['t1', 'b1'],
    writableSlotIds: ['t1', 'b1'],
    draftId: DRAFT,
  };
}

function fillRegistryContext(): StructuredSlotToolContext {
  return {
    turnId: TURN,
    sessionKind: 'fill',
    grant: fillGrant(),
    state: null,
    meter: { signal: new AbortController().signal } as AttemptMeter,
    draftService: {} as unknown as StructuredSlotDraftService,
  };
}

function sealContext(
  caps: readonly SlotCapabilityV1[],
  sealDispatch: NonNullable<StructuredSlotToolContext['seal']>,
): StructuredSlotToolContext {
  const grant: SlotSessionGrantV1 = {
    grantId: 'grant-seal',
    kind: 'seal',
    caseId: TASK,
    turnId: TURN,
    agentId: AGENT,
    snapshotHash: SNAPSHOT,
    capabilities: [...caps],
    accessProfileId: 'seal-profile',
    scaffoldId: SC,
    baseRevision: REV,
    readableSlotIds: ['t1'],
    writableSlotIds: [],
    draftId: null,
  };
  return {
    turnId: TURN,
    sessionKind: 'seal',
    grant,
    state: null,
    meter: { signal: new AbortController().signal } as AttemptMeter,
    seal: sealDispatch,
    projectionService: {} as unknown as StructuredSlotProjectionService,
  };
}

describe('Step 1 — exact tool registry (spec §9.1-§9.3)', () => {
  it('exposes exactly five structure Proposal tools, all sequential, capability-gated', () => {
    const grant: SlotSessionGrantV1 = {
      grantId: 'g',
      kind: 'structure',
      caseId: TASK,
      turnId: TURN,
      agentId: AGENT,
      snapshotHash: SNAPSHOT,
      capabilities: [
        'read_structure_contract',
        'write_structure_proposal',
        'validate_structure_proposal',
        'submit_structure_proposal',
      ],
      proposalId: 'proposal-1',
    };
    const tools = createStructuredSlotToolDefinitions(structureContext(grant));
    expect(tools.map((t) => t.name).sort()).toEqual([...STRUCTURE_TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.executionMode).toBe('sequential');
    }
  });

  it('hides structure tools whose capability the grant lacks (capability gating)', () => {
    const grant: SlotSessionGrantV1 = {
      grantId: 'g',
      kind: 'structure',
      caseId: TASK,
      turnId: TURN,
      agentId: AGENT,
      snapshotHash: SNAPSHOT,
      capabilities: ['read_structure_contract', 'get_structure_proposal' as never],
      proposalId: 'proposal-1',
    };
    const tools = createStructuredSlotToolDefinitions(structureContext(grant));
    const names = tools.map((t) => t.name);
    // get_structure_proposal is an implicit read (always exposed); the write/
    // validate/submit tools require their capability.
    expect(names).toContain('get_structure_contract');
    expect(names).toContain('get_structure_proposal');
    expect(names).not.toContain('put_structure_proposal');
    expect(names).not.toContain('submit_structure_proposal');
    expect(names).not.toContain('validate_structure_proposal');
  });

  it('exposes exactly seven fill Draft tools, all sequential, capability-gated', async () => {
    const harness = await makeFillHarness();
    const tools = createStructuredSlotToolDefinitions(harness.context);
    expect(tools.map((t) => t.name).sort()).toEqual([...FILL_TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.executionMode).toBe('sequential');
    }
  });

  it('hides fill write/validate/submit tools whose capability the grant lacks', async () => {
    const harness = await makeFillHarness();
    const context: StructuredSlotToolContext = {
      ...harness.context,
      grant: { ...harness.grant, capabilities: ['read_slot_spec'] },
    };
    const tools = createStructuredSlotToolDefinitions(context);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(['list_slots', 'read_slot', 'get_draft_status']);
  });

  it('exposes seal request_seal plus declared read capabilities only', () => {
    const withReads = sealContext(['request_seal', 'read_slot_content'], { requestSeal: async () => ({ ok: false, code: 'X', reason: 'y' }), dispatch: { status: 'none' } });
    const tools = createStructuredSlotToolDefinitions(withReads);
    expect(tools.map((t) => t.name).sort()).toEqual(['list_slots', 'read_slot', 'request_seal']);
    for (const tool of tools) {
      expect(tool.executionMode).toBe('sequential');
    }
    const withoutReads = sealContext(['request_seal'], { requestSeal: async () => ({ ok: false, code: 'X', reason: 'y' }), dispatch: { status: 'none' } });
    const noReads = createStructuredSlotToolDefinitions(withoutReads);
    expect(noReads.map((t) => t.name)).toEqual(['request_seal']);
  });

  it('has no engineering key in any parameter schema of the closed registry', () => {
    const forbidden = ['taskId', 'taskid', 'scaffoldId', 'scaffoldid', 'draftId', 'draftid', 'grantId', 'grantid', 'revision', 'path', 'requestId', 'requestid', 'agentId', 'agentid', 'caseId', 'caseid', 'accessProfileId'];
    const grant: SlotSessionGrantV1 = {
      grantId: 'g',
      kind: 'structure',
      caseId: TASK,
      turnId: TURN,
      agentId: AGENT,
      snapshotHash: SNAPSHOT,
      capabilities: [
        'read_structure_contract',
        'write_structure_proposal',
        'validate_structure_proposal',
        'submit_structure_proposal',
      ],
      proposalId: 'proposal-1',
    };
    const structure = createStructuredSlotToolDefinitions(structureContext(grant));
    const fill = createStructuredSlotToolDefinitions(fillRegistryContext());
    const all = [...structure, ...fill];
    const serialized = JSON.stringify(all.map((t) => t.parameters));
    for (const key of forbidden) {
      expect(serialized.toLowerCase(), `engineering key ${key}`).not.toContain(key);
    }
    for (const tool of all) {
      expect((tool.parameters as { type?: string }).type).toBe('object');
    }
  });

  it('snapshots every Slot Tool parameter schema exactly', () => {
    const grant: SlotSessionGrantV1 = {
      grantId: 'g',
      kind: 'structure',
      caseId: TASK,
      turnId: TURN,
      agentId: AGENT,
      snapshotHash: SNAPSHOT,
      capabilities: [
        'read_structure_contract',
        'write_structure_proposal',
        'validate_structure_proposal',
        'submit_structure_proposal',
      ],
      proposalId: 'proposal-1',
    };
    const structure = createStructuredSlotToolDefinitions(structureContext(grant));
    const fill = createStructuredSlotToolDefinitions(fillRegistryContext());
    const snapshot: Record<string, unknown> = {};
    for (const tool of [...structure, ...fill]) {
      snapshot[tool.name] = tool.parameters;
    }
    expect(snapshot['get_structure_contract']).toEqual({ type: 'object', properties: {} });
    expect(snapshot['list_slots']).toEqual({
      type: 'object',
      properties: {
        cursor: { type: 'string', minLength: 1, maxLength: 4096 },
        limit: { type: 'integer', minimum: 1, maximum: 512 },
      },
    });
    expect(snapshot['read_slot']).toEqual({
      type: 'object',
      properties: { slotId: { type: 'string', minLength: 1, maxLength: 256 } },
      required: ['slotId'],
    });
    expect(snapshot['replace_draft_content']).toEqual({
      type: 'object',
      required: ['changes'],
      properties: {
        changes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['slotId', 'content'],
            properties: { slotId: { type: 'string', minLength: 1, maxLength: 256 }, content: {} },
          },
          minItems: 1,
        },
      },
    });
    expect(snapshot['submit_draft']).toEqual({ type: 'object', properties: {} });
    expect(snapshot['request_seal']).toBeUndefined(); // seal tools need the seal context
    expect(JSON.stringify(snapshot['submit_structure_proposal'])).not.toContain('tree');
  });

  it('the closed registry covers every kind and is a real Set', () => {
    expect(SLOT_TOOL_NAME_SET.size).toBe(13);
    for (const name of [...STRUCTURE_TOOL_NAMES, ...FILL_TOOL_NAMES, ...SEAL_TOOL_NAMES]) {
      expect(SLOT_TOOL_NAME_SET.has(name)).toBe(true);
    }
  });
});

describe('Step 2 — progressive disclosure (design §10.6)', () => {
  it('list_slots returns the authorized outline WITHOUT preceding content', async () => {
    const harness = await makeFillHarness();
    const tools = createStructuredSlotToolDefinitions(harness.context);
    const hash = await rawPrecharge(harness, 'list_slots', 'tc-list', {});
    void hash;
    const result = await executeTool(tools, 'list_slots', 'tc-list', {});
    expect(result.accepted).toBe(true);
    expect(result.text).toContain('t1');
    expect(result.text).toContain('b1');
    // No preceding content in the outline.
    expect(result.text).not.toContain('base-title');
    // Meter: exactly ONE precharge and NO extra charge for a valid executed call.
    expect(harness.meter.usage.slotToolCalls).toBe(1);
  });

  it('a coerced call (raw "5" precharged, validated 5 executed) is NOT spurious-rejected and charges exactly once', async () => {
    // Pi 0.82 coerces raw args during TypeBox validation, so the raw seam
    // precharges hash(raw) while the execute sees hash(validated) — the consume
    // must resolve the precharge by toolCallId (Finding 1 fix) so a legitimately
    // precharged, schema-valid-after-coercion call is neither spurious-rejected
    // (NOT_PRECHARGED) nor double-charged.
    const harness = await makeFillHarness();
    const tools = createStructuredSlotToolDefinitions(harness.context);
    const rawHash = canonicalJsonSha256({ limit: '5' });
    const charge = await harness.meter.prechargeRawTool({
      toolCallId: 'tc-coerce-list',
      canonicalArgsHash: rawHash,
      toolName: 'list_slots',
    });
    expect(charge.status).toBe('ok');
    const result = await executeTool(tools, 'list_slots', 'tc-coerce-list', { limit: 5 });
    expect(result.accepted).toBe(true);
    expect(result.code).toBeUndefined();
    expect(result.text).toContain('t1');
    expect(harness.meter.usage.slotToolCalls).toBe(1);
  });

  it('read_slot returns ONE complete authorized content under the draft overlay', async () => {
    const harness = await makeFillHarness();
    const tools = createStructuredSlotToolDefinitions(harness.context);
    const hash = await rawPrecharge(harness, 'read_slot', 'tc-read', { slotId: 't1' });
    void hash;
    const result = await executeTool(tools, 'read_slot', 'tc-read', { slotId: 't1' });
    expect(result.accepted).toBe(true);
    expect(result.text).toContain('base-title');
    expect(harness.meter.usage.slotToolCalls).toBe(1);
  });

  it('read_slot content above the single-call response limit REJECTS without truncation', async () => {
    const harness = await makeFillHarness();
    const tools = createStructuredSlotToolDefinitions({ ...harness.context, readResponseLimitBytes: 8 });
    const hash = await rawPrecharge(harness, 'read_slot', 'tc-big', { slotId: 't1' });
    void hash;
    const result = await executeTool(tools, 'read_slot', 'tc-big', { slotId: 't1' });
    expect(result.accepted).toBe(false);
    expect(result.code).toBe('SLOT_READ_RESPONSE_LIMIT');
    // No truncated content was returned.
    expect(result.text).not.toContain('base-title');
  });

  it('exact cached replay is free: same key replays the recorded result, no new charge', async () => {
    const harness = await makeFillHarness();
    const tools = createStructuredSlotToolDefinitions(harness.context);
    await rawPrecharge(harness, 'read_slot', 'tc-replay', { slotId: 't1' });
    const first = await executeTool(tools, 'read_slot', 'tc-replay', { slotId: 't1' });
    expect(first.accepted).toBe(true);
    expect(harness.meter.usage.slotToolCalls).toBe(1);
    // Exact replay: the raw seam sees the recorded result and does not charge;
    // the draft service replays the recorded result.
    await rawPrecharge(harness, 'read_slot', 'tc-replay', { slotId: 't1' });
    const second = await executeTool(tools, 'read_slot', 'tc-replay', { slotId: 't1' });
    expect(second.accepted).toBe(true);
    expect(harness.meter.usage.slotToolCalls).toBe(1);
  });

  it('a coerced call replayed EXACTLY is free: same raw call twice, usage stays 1, no spurious rejection', async () => {
    // Residual Finding 1: on replay the raw seam re-precharges the SAME raw key,
    // which prechargeRawTool returns as replayed WITHOUT adding a pending entry.
    // The consume must resolve by the raw seam's current precharge so the
    // coerced validated params still find their recorded result (no spurious
    // NOT_PRECHARGED, no double charge).
    const harness = await makeFillHarness();
    const tools = createStructuredSlotToolDefinitions(harness.context);
    const rawHash = canonicalJsonSha256({ limit: '5' });
    await harness.meter.prechargeRawTool({ toolCallId: 'tc-coerce-rep', canonicalArgsHash: rawHash, toolName: 'list_slots' });
    const first = await executeTool(tools, 'list_slots', 'tc-coerce-rep', { limit: 5 });
    expect(first.accepted).toBe(true);
    expect(harness.meter.usage.slotToolCalls).toBe(1);
    const replayCharge = await harness.meter.prechargeRawTool({ toolCallId: 'tc-coerce-rep', canonicalArgsHash: rawHash, toolName: 'list_slots' });
    expect(replayCharge.status).toBe('ok');
    if (replayCharge.status !== 'ok') throw new Error('expected ok');
    expect(replayCharge.replayed).toBe(true);
    const second = await executeTool(tools, 'list_slots', 'tc-coerce-rep', { limit: 5 });
    expect(second.accepted).toBe(true);
    expect(second.code).toBeUndefined();
    expect(harness.meter.usage.slotToolCalls).toBe(1);
  });

  it('a coerced replay does NOT consume an orphaned pending precharge from an earlier failed call', async () => {
    // Residual Finding 1 (orphan hazard): a pending precharge from an earlier
    // schema-invalid/truncated call on the SAME toolCallId must never be
    // consumed by a later coerced replay — the replay resolves by the raw
    // seam's current precharge (the recorded key), not by any pending entry.
    const harness = await makeFillHarness();
    const tools = createStructuredSlotToolDefinitions(harness.context);
    const rawHash = canonicalJsonSha256({ limit: '5' });
    // Failed call: precharges but never executes (orphaned pending record).
    await harness.meter.prechargeRawTool({ toolCallId: 'tc-orphan', canonicalArgsHash: canonicalJsonSha256({ limit: 'bad' }), toolName: 'list_slots' });
    // Successful coerced call on the SAME toolCallId.
    await harness.meter.prechargeRawTool({ toolCallId: 'tc-orphan', canonicalArgsHash: rawHash, toolName: 'list_slots' });
    const first = await executeTool(tools, 'list_slots', 'tc-orphan', { limit: 5 });
    expect(first.accepted).toBe(true);
    expect(harness.meter.usage.slotToolCalls).toBe(2); // orphan + successful
    // Coerced replay: must return the recorded result, NOT consume the orphan.
    const replayCharge = await harness.meter.prechargeRawTool({ toolCallId: 'tc-orphan', canonicalArgsHash: rawHash, toolName: 'list_slots' });
    expect(replayCharge.status).toBe('ok');
    if (replayCharge.status !== 'ok') throw new Error('expected ok');
    expect(replayCharge.replayed).toBe(true);
    const second = await executeTool(tools, 'list_slots', 'tc-orphan', { limit: 5 });
    expect(second.accepted).toBe(true);
    expect(second.code).toBeUndefined();
    expect(harness.meter.usage.slotToolCalls).toBe(2); // replay is free
  });

  it('same toolCallId with changed args is IDEMPOTENCY_CONFLICT and counts', async () => {
    const harness = await makeFillHarness();
    const tools = createStructuredSlotToolDefinitions(harness.context);
    await rawPrecharge(harness, 'read_slot', 'tc-conflict', { slotId: 't1' });
    const first = await executeTool(tools, 'read_slot', 'tc-conflict', { slotId: 't1' });
    expect(first.accepted).toBe(true);
    await rawPrecharge(harness, 'read_slot', 'tc-conflict', { slotId: 'b1' });
    const second = await executeTool(tools, 'read_slot', 'tc-conflict', { slotId: 'b1' });
    expect(second.accepted).toBe(false);
    expect(second.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(harness.meter.usage.slotToolCalls).toBe(2);
  });
});

describe('Step 2b — structure tool execute paths (consume + record + serialize)', () => {
  async function makeStructureHarness(): Promise<{
    context: StructuredSlotToolContext;
    service: StructuredSlotProposalService;
    store: StructuredSlotPrivateStore;
    meter: AttemptMeter;
    grant: StructureSessionGrantV1;
  }> {
    const { paths, dataRoot } = makeTempCorePaths('forge-core-tf-structure-');
    tempRoots.push(dataRoot);
    mkdirSync(paths.taskRoot(TASK), { recursive: true });
    const contract = makeContract();
    const store = new StructuredSlotPrivateStore(paths, TASK);
    const events: TaskEvent[] = [
      makeTaskEvent({
        type: 'structured_slot_attempt_started',
        inputNodeId: 'in-1',
        agentId: AGENT,
        attemptEpoch: 1,
        turnId: TURN,
        sessionKind: 'structure',
      }),
    ];
    await store.materializeProposal(TURN, 'proposal-structure');
    const meter = await AttemptMeter.create({ turnId: TURN, privateStore: store, limits: contract.limits });
    const service = new StructuredSlotProposalService({
      taskId: TASK,
      snapshotHash: SNAPSHOT,
      contract,
      store,
      events: async () => events,
    });
    const grant: StructureSessionGrantV1 = {
      grantId: 'g',
      kind: 'structure',
      caseId: TASK,
      turnId: TURN,
      agentId: AGENT,
      snapshotHash: SNAPSHOT,
      capabilities: [
        'read_structure_contract',
        'write_structure_proposal',
        'validate_structure_proposal',
        'submit_structure_proposal',
      ],
      proposalId: 'proposal-structure',
    };
    const context: StructuredSlotToolContext = {
      turnId: TURN,
      sessionKind: 'structure',
      grant,
      state: null,
      meter,
      proposalService: service,
      store,
      events: async () => events,
    };
    return { context, service, store, meter, grant };
  }

  it('get_structure_contract returns the declarative projection and charges exactly once', async () => {
    const harness = await makeStructureHarness();
    const tools = createStructuredSlotToolDefinitions(harness.context);
    await harness.meter.prechargeRawTool({
      toolCallId: 'tc-contract',
      canonicalArgsHash: canonicalJsonSha256({}),
      toolName: 'get_structure_contract',
    });
    const result = await executeTool(tools, 'get_structure_contract', 'tc-contract', {});
    expect(result.accepted).toBe(true);
    expect(result.text).toContain('document');
    expect(result.text).not.toContain('proposal-structure');
    expect(harness.meter.usage.slotToolCalls).toBe(1);
    // Exact replay of the same key is free.
    await harness.meter.prechargeRawTool({
      toolCallId: 'tc-contract',
      canonicalArgsHash: canonicalJsonSha256({}),
      toolName: 'get_structure_contract',
    });
    const replay = await executeTool(tools, 'get_structure_contract', 'tc-contract', {});
    expect(replay.accepted).toBe(true);
    expect(harness.meter.usage.slotToolCalls).toBe(1);
  });

  it('put_structure_proposal consumes the precharge, records the result, and never charges again', async () => {
    const harness = await makeStructureHarness();
    const tools = createStructuredSlotToolDefinitions(harness.context);
    const params = {
      tree: {
        clientKey: 'root',
        typeId: 'document',
        spec: { purpose: 'doc' },
        children: [
          { clientKey: 't1', typeId: 'title', spec: { purpose: 'head' }, children: [] },
          { clientKey: 'b1', typeId: 'body', spec: { purpose: 'para' }, children: [] },
        ],
      },
    };
    await harness.meter.prechargeRawTool({
      toolCallId: 'tc-put',
      canonicalArgsHash: canonicalJsonSha256(params),
      toolName: 'put_structure_proposal',
    });
    const result = await executeTool(tools, 'put_structure_proposal', 'tc-put', params);
    expect(result.accepted).toBe(true);
    expect(harness.meter.usage.slotToolCalls).toBe(1);
    // The proposal tree was stored through the real service.
    const read = await harness.service.getProposal(harness.grant);
    expect(read.ok && read.tree?.typeId).toBe('document');
  });

  it('a same toolCallId with changed structure args is IDEMPOTENCY_CONFLICT and counts', async () => {
    const harness = await makeStructureHarness();
    const tools = createStructuredSlotToolDefinitions(harness.context);
    const paramsA = { tree: { clientKey: 'root', typeId: 'document', spec: { purpose: 'doc' }, children: [] } };
    const paramsB = { tree: { clientKey: 'root', typeId: 'document', spec: { purpose: 'other' }, children: [] } };
    await harness.meter.prechargeRawTool({ toolCallId: 'tc-c', canonicalArgsHash: canonicalJsonSha256(paramsA), toolName: 'put_structure_proposal' });
    const first = await executeTool(tools, 'put_structure_proposal', 'tc-c', paramsA);
    expect(first.accepted).toBe(true);
    await harness.meter.prechargeRawTool({ toolCallId: 'tc-c', canonicalArgsHash: canonicalJsonSha256(paramsB), toolName: 'put_structure_proposal' });
    const second = await executeTool(tools, 'put_structure_proposal', 'tc-c', paramsB);
    expect(second.accepted).toBe(false);
    expect(second.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(harness.meter.usage.slotToolCalls).toBe(2);
  });
});

describe('Step 2c — seal execute: request_seal replay (Finding 2 fix)', () => {
  it('an exact replay of a passed request_seal returns the recorded result and NEVER re-runs the Seal Gate', async () => {
    const { paths, dataRoot } = makeTempCorePaths('forge-core-tf-seal-');
    tempRoots.push(dataRoot);
    mkdirSync(paths.taskRoot(TASK), { recursive: true });
    const store = new StructuredSlotPrivateStore(paths, TASK);
    const meter = await AttemptMeter.create({ turnId: TURN, privateStore: store, limits: makeLimits() });
    let gateRuns = 0;
    const grant: SlotSessionGrantV1 = {
      grantId: 'grant-seal',
      kind: 'seal',
      caseId: TASK,
      turnId: TURN,
      agentId: AGENT,
      snapshotHash: SNAPSHOT,
      capabilities: ['request_seal'],
      accessProfileId: 'seal-profile',
      scaffoldId: SC,
      baseRevision: REV,
      readableSlotIds: ['t1'],
      writableSlotIds: [],
      draftId: null,
    };
    const context: StructuredSlotToolContext = {
      turnId: TURN,
      sessionKind: 'seal',
      grant,
      state: null,
      meter,
      seal: {
        dispatch: { status: 'passed', declaredDispatches: ['publish_artifact'] },
        requestSeal: async () => {
          gateRuns += 1;
          return { ok: true, receipt: { kind: 'seal', status: 'passed', issueSummary: { errors: 0, warnings: 0 } } };
        },
      },
    };
    const tools = createStructuredSlotToolDefinitions(context);
    const params = {};
    // Fresh call: precharge + gate runs once + result recorded.
    await meter.prechargeRawTool({ toolCallId: 'tc-seal', canonicalArgsHash: canonicalJsonSha256(params), toolName: 'request_seal' });
    const first = await executeTool(tools, 'request_seal', 'tc-seal', params);
    expect(first.accepted).toBe(true);
    expect(first.text).toContain('passed');
    expect(gateRuns).toBe(1);
    expect(meter.usage.slotToolCalls).toBe(1);
    // Exact replay: the raw seam sees the recorded result (free), and the tool
    // returns it WITHOUT re-running the authoritative/expensive Seal Gate.
    const replayCharge = await meter.prechargeRawTool({ toolCallId: 'tc-seal', canonicalArgsHash: canonicalJsonSha256(params), toolName: 'request_seal' });
    expect(replayCharge.status).toBe('ok');
    if (replayCharge.status !== 'ok') throw new Error('expected ok');
    expect(replayCharge.replayed).toBe(true);
    const second = await executeTool(tools, 'request_seal', 'tc-seal', params);
    expect(second.accepted).toBe(true);
    expect(second.text).toContain('passed');
    expect(gateRuns).toBe(1);
    expect(meter.usage.slotToolCalls).toBe(1);
  });

  it('a FRESH request_seal call still runs the Seal Gate', async () => {
    const { paths, dataRoot } = makeTempCorePaths('forge-core-tf-seal2-');
    tempRoots.push(dataRoot);
    mkdirSync(paths.taskRoot(TASK), { recursive: true });
    const store = new StructuredSlotPrivateStore(paths, TASK);
    const meter = await AttemptMeter.create({ turnId: TURN, privateStore: store, limits: makeLimits() });
    let gateRuns = 0;
    const grant: SlotSessionGrantV1 = {
      grantId: 'grant-seal',
      kind: 'seal',
      caseId: TASK,
      turnId: TURN,
      agentId: AGENT,
      snapshotHash: SNAPSHOT,
      capabilities: ['request_seal'],
      accessProfileId: 'seal-profile',
      scaffoldId: SC,
      baseRevision: REV,
      readableSlotIds: ['t1'],
      writableSlotIds: [],
      draftId: null,
    };
    const context: StructuredSlotToolContext = {
      turnId: TURN,
      sessionKind: 'seal',
      grant,
      state: null,
      meter,
      seal: {
        dispatch: { status: 'passed', declaredDispatches: ['publish_artifact'] },
        requestSeal: async () => {
          gateRuns += 1;
          return { ok: true, receipt: { kind: 'seal', status: 'passed', issueSummary: { errors: 0, warnings: 0 } } };
        },
      },
    };
    const tools = createStructuredSlotToolDefinitions(context);
    await meter.prechargeRawTool({ toolCallId: 'tc-seal-fresh', canonicalArgsHash: canonicalJsonSha256({}), toolName: 'request_seal' });
    const result = await executeTool(tools, 'request_seal', 'tc-seal-fresh', {});
    expect(result.accepted).toBe(true);
    expect(gateRuns).toBe(1);
  });
});

describe('Step 3 — dispatch guard (design §11.3)', () => {
  function structureState(completion: 'structure_commit_candidate_created' | null): StructuredSessionState {
    return {
      version: 1,
      sessionKind: 'structure',
      turnId: TURN,
      grant: null,
      proposalId: 'proposal-1',
      proposalLifecycle: 'open',
      candidate: completion !== null ? ({} as never) : null,
      completion,
      receipt: null,
      locked: completion !== null,
    };
  }

  it('structure/fill: send rejects before a candidate, succeeds after; human stays available', () => {
    const before = assertStructuredForgeAction(structureState(null), { type: 'send_message', targetAgentId: 'x', summary: 's' });
    expect(before.ok).toBe(false);
    expect(assertStructuredForgeAction(structureState(null), { type: 'request_human_input', question: 'q' }).ok).toBe(true);
    const after = assertStructuredForgeAction(structureState('structure_commit_candidate_created'), { type: 'send_message', targetAgentId: 'x', summary: 's' });
    expect(after.ok).toBe(true);
    expect(assertStructuredForgeAction(structureState('structure_commit_candidate_created'), { type: 'request_human_input', question: 'q' }).ok).toBe(true);
    // forward_input_version never ends a v3 structure/fill session.
    expect(assertStructuredForgeAction(structureState('structure_commit_candidate_created'), { type: 'forward_input_version', targetAgentId: 'x' }).ok).toBe(false);
  });

  it('seal passed permits only the declared publish/final dispatch', () => {
    const passed = assertSealDispatchAction({ status: 'passed', declaredDispatches: ['publish_artifact', 'submit_final_artifact'] }, { type: 'publish_artifact' });
    expect(passed.ok).toBe(true);
    expect(assertSealDispatchAction({ status: 'passed', declaredDispatches: ['publish_artifact', 'submit_final_artifact'] }, { type: 'submit_final_artifact' }).ok).toBe(true);
    expect(assertSealDispatchAction({ status: 'passed', declaredDispatches: ['publish_artifact', 'submit_final_artifact'] }, { type: 'send_message', targetAgentId: 'x', summary: 's' }).ok).toBe(false);
    // A dispatch the template did not declare is rejected.
    expect(assertSealDispatchAction({ status: 'passed', declaredDispatches: ['publish_artifact'] }, { type: 'submit_final_artifact' }).ok).toBe(false);
    // request_human_input stays available until the Attempt closes.
    expect(assertSealDispatchAction({ status: 'passed', declaredDispatches: ['publish_artifact'] }, { type: 'request_human_input', question: 'q' }).ok).toBe(true);
  });

  it('seal reliable failure permits only rework send to the frozen target', () => {
    const rework = { status: 'rework_required', reworkTarget: 'fill-agent' } as const;
    expect(assertSealDispatchAction(rework, { type: 'send_message', targetAgentId: 'fill-agent', summary: 'issues' }).ok).toBe(true);
    expect(assertSealDispatchAction(rework, { type: 'send_message', targetAgentId: 'other', summary: 'issues' }).ok).toBe(false);
    expect(assertSealDispatchAction(rework, { type: 'publish_artifact' }).ok).toBe(false);
    expect(assertSealDispatchAction(rework, { type: 'request_human_input', question: 'q' }).ok).toBe(true);
  });

  it('seal incomplete permits neither dispatch; human stays available', () => {
    expect(assertSealDispatchAction({ status: 'incomplete' }, { type: 'send_message', targetAgentId: 'x', summary: 's' }).ok).toBe(false);
    expect(assertSealDispatchAction({ status: 'incomplete' }, { type: 'publish_artifact' }).ok).toBe(false);
    expect(assertSealDispatchAction({ status: 'incomplete' }, { type: 'request_human_input', question: 'q' }).ok).toBe(true);
    expect(assertSealDispatchAction({ status: 'none' }, { type: 'publish_artifact' }).ok).toBe(false);
  });
});
