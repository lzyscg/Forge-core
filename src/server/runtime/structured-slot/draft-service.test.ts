// @vitest-environment node
/**
 * FillDraft overlay + Merge Gate tests (Task 13 Steps 1-3, design §12-§14.3,
 * spec §9.2).
 *
 * Step 1 — overlay + authorization: reads see base + own overlay; batch replace
 * is all-or-nothing; unset differs from a set null; out-of-scope/hidden ids
 * reveal no existence (D05); type/spec/tree mutations reject; the Attempt meter
 * is charged BEFORE authorization so invalid calls still count.
 *
 * Step 2 — lifecycle + idempotency: get-or-create by active turn only after a
 * committed draft_opened; signature replay returns the original result and
 * signature conflict is IDEMPOTENCY_CONFLICT; a formed candidate locks the
 * draft; stale base is DRAFT_STALE; merged/abandoned come from the TaskEvents
 * (never the private journal); every attempt gets a fresh empty Draft (no
 * cross-attempt clone); a crash after opened/before journal recreates the SAME
 * empty Draft; a crash after terminal/before private cache still reports the
 * authoritative terminal.
 *
 * Step 3 — Merge Gate: content schema, changed-slot validators, affected
 * subtree/scaffold validators, zero authority change on failure, nonempty
 * expected revision base+1, no-op expected revision unchanged while still
 * running scaffold-level validators.
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
import { makeTaskEvent, makeTempCorePaths, disposeAllTestRoots } from '../../test-support';
import type {
  AccessProfileV1,
  FrozenStructuredSlotContractV1,
  FrozenSlotTypeV1,
  ValidatorRegistrationV1,
} from '../../template/structured-slot-contract';
import type {
  FillSessionGrantV1,
  JsonValue,
  SlotCapabilityV1,
  StructuredSlotLimitsV1,
} from '../../../shared/structured-slots';
import { StructuredSlotGrantService, type ActiveScaffoldV1 } from './grant-service';
import { createStructuredSlotDataSource } from './session-service';
import { createTaskLocalCursorSigner, StructuredSlotProjectionService } from './projection-service';
import { AttemptMeter } from './attempt-meter';
import { ValidationEngine } from './validation-engine';
import { deriveDraftId, deriveTurnId } from './attempt-coordinator';
import {
  StructuredSlotDraftService,
  type FillToolContext,
  type MergeCommitCandidate,
} from './draft-service';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
  disposeAllTestRoots();
});

const TASK = 'task-13';
const SNAPSHOT = 'snapshot-1';
const TURN = 'turn-1';
const AGENT = 'agent-1';
const SC = 'scaffold-1';
const GEN = 'gen-1';
const DRAFT = deriveDraftId(TURN);
const REV = 0;

const CAPABILITIES: readonly SlotCapabilityV1[] = [
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

function makeContract(validators: ValidatorRegistrationV1[] = []): FrozenStructuredSlotContractV1 {
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
    validators,
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

function makeValidator(overrides: Partial<ValidatorRegistrationV1> & { path?: string }): ValidatorRegistrationV1 {
  const { path, implementation, ...rest } = overrides;
  return {
    id: 'v1',
    scope: 'slot',
    trigger: 'merge-and-seal',
    enforcement: 'blocking',
    selector: { kind: 'all' },
    budget: { cpuMs: 100, timeoutMs: 500, memoryMiB: 64 },
    ...rest,
    implementation:
      implementation ??
      (path !== undefined ? { abi: 'forge-validator/v1', path } : { abi: 'forge-validator/v1', path: 'slots/validators/v1.cjs' }),
  };
}

function rejectingSource(rejected: string[]): string {
  return [
    'module.exports = { validate(input) {',
    `  const rejected = ${JSON.stringify(rejected)};`,
    '  if (input.target.kind === "slot" && rejected.includes(input.target.slotId)) {',
    '    return { pass: false, issues: [{ stage: "content", evidence: "rejected " + input.target.slotId, scope: "v" }] };',
    '  }',
    '  return { pass: true, issues: [] };',
    '} };',
  ].join('\n');
}

const REJECT_ALL_SOURCE =
  'module.exports = { validate() { return { pass: false, issues: [{ stage: "content", evidence: "always", scope: "x" }] }; } };';

/**
 * A subtree-scope validator that reads the UNCHANGED `t1` slot's content from
 * its envelope tree (present on the root target's subtree) and rejects when it
 * does not equal the POST-MERGE committed value `merged-title`. With the gate
 * fed revision-0-era generation records the base reads `base-title` and the
 * gate fails; with the authoritative active content root it reads
 * `merged-title` and passes.
 */
const MERGED_BASE_CHECK_SOURCE = [
  'module.exports = { validate(input) {',
  '  var t1 = null;',
  '  for (var i = 0; i < input.tree.length; i++) {',
  '    if (input.tree[i].slotId === "t1") { t1 = input.tree[i]; break; }',
  '  }',
  '  if (t1 !== null && t1.content !== "merged-title") {',
  '    return { pass: false, issues: [{ stage: "content", evidence: "stale base: " + t1.content, scope: "v" }] };',
  '  }',
  '  return { pass: true, issues: [] };',
  '} };',
].join('\n');

const SLOTS: SlotInstance[] = [
  { slotId: 'r', scaffoldId: SC, parentSlotId: null, order: 0, typeId: 'document', spec: {}, contentPresence: 'unset' },
  { slotId: 't1', scaffoldId: SC, parentSlotId: 'r', order: 1, typeId: 'title', spec: { purpose: 'head' }, contentPresence: 'set', content: 'base-title' },
  { slotId: 'b1', scaffoldId: SC, parentSlotId: 'r', order: 2, typeId: 'body', spec: { purpose: 'para' }, contentPresence: 'unset' },
];

interface Harness {
  service: StructuredSlotDraftService;
  store: StructuredSlotPrivateStore;
  blobStore: StructuredSlotBlobStore;
  contract: FrozenStructuredSlotContractV1;
  events: TaskEvent[];
  grant: FillSessionGrantV1;
  meter: AttemptMeter;
}

async function makeHarness(options: {
  validators?: ValidatorRegistrationV1[];
  sources?: Record<string, string>;
  materializeDraft?: boolean;
  /** When set, a PRIOR merged fill on the same generation advances the active
   *  content revision to 1 and the new draft opens at baseRevision 1. */
  priorMergedTitle?: string;
} = {}): Promise<Harness> {
  const { paths, dataRoot } = makeTempCorePaths('forge-core-draft-');
  tempRoots.push(dataRoot);
  mkdirSync(paths.taskRoot(TASK), { recursive: true });
  const snapshotRoot = paths.taskSnapshotRoot(TASK);
  for (const [logicalPath, source] of Object.entries(options.sources ?? {})) {
    const full = join(snapshotRoot, logicalPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source, 'utf8');
  }

  const contract = makeContract(options.validators ?? []);
  const store = new StructuredSlotPrivateStore(paths, TASK);
  const blobStore = new StructuredSlotBlobStore(paths, TASK);
  const events: TaskEvent[] = [];
  const revision = options.priorMergedTitle !== undefined ? 1 : REV;

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
      contentRevision: 0,
      proposalId: 'proposal-1',
    }),
  );

  // A prior merged fill on the SAME generation: the generation slot records
  // stay at revision-0-era content, but the committed content root advances.
  if (options.priorMergedTitle !== undefined) {
    const mergedTitle = await blobStore.putContentValue(options.priorMergedTitle);
    const mergedRoot = await blobStore.putContentRevision({ r: 'unset', t1: mergedTitle.sha256, b1: 'unset' });
    events.push(
      makeTaskEvent({
        type: 'structured_slot_attempt_started',
        inputNodeId: 'in-0',
        agentId: AGENT,
        attemptEpoch: 1,
        turnId: 'turn-0',
        sessionKind: 'fill',
      }),
      makeTaskEvent({
        type: 'structured_fill_draft_opened',
        draftId: 'draft-0',
        turnId: 'turn-0',
        scaffoldId: SC,
        generationId: GEN,
        baseRevision: 0,
      }),
      makeTaskEvent({
        type: 'structured_fill_draft_terminal',
        draftId: 'draft-0',
        turnId: 'turn-0',
        status: 'merged',
        baseRevision: 0,
        resultRevision: 1,
        changeCount: 1,
        content: mergedRoot,
      }),
      makeTaskEvent({
        type: 'structured_slot_attempt_terminal',
        inputNodeId: 'in-0',
        attemptEpoch: 1,
        turnId: 'turn-0',
        status: 'committed',
        reason: 'completion_dispatch',
      }),
    );
  }

  events.push(
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
      baseRevision: revision,
    }),
  );

  const materializeDraft = options.materializeDraft ?? true;
  if (materializeDraft) {
    await store.materializeDraft(TURN, DRAFT, { scaffoldId: SC, generationId: GEN, baseRevision: revision });
  }

  const grantService = new StructuredSlotGrantService({ taskId: TASK, snapshotHash: SNAPSHOT, contract });
  const active: ActiveScaffoldV1 = { scaffoldId: SC, generationId: GEN, contentRevision: revision };
  const index = await blobStore.getGenerationIndex(GEN);
  const presence: Record<string, 'unset' | 'set'> = { r: 'unset', t1: 'set', b1: 'unset' };
  const resolved = grantService.resolveFillGrant({
    taskId: TASK,
    turnId: TURN,
    agentId: AGENT,
    sessionKind: 'fill',
    snapshotHash: SNAPSHOT,
    capabilities: CAPABILITIES,
    accessProfileId: PROFILE.id,
    activeScaffold: active,
    generationIndex: index,
    contentPresence: presence,
    baseRevision: revision,
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
  });
  return { service, store, blobStore, contract, events, grant: resolved.grant, meter };
}

/** Idempotency context helper: stable toolCallId + canonical args hash. */
function ctx(toolCallId: string, canonicalArgsHash: string, toolName = 'replace_draft_content'): FillToolContext {
  return { toolCallId, canonicalArgsHash, toolName };
}

describe('Step 1 — overlay + authorization', () => {
  it('reads see the base scaffold plus the own overlay', async () => {
    const h = await makeHarness();
    // t1 carries base content and no overlay — the read returns the base value.
    const base = await h.service.readSlot(h.grant, ctx('r1', 'h1', 'read_slot'), 't1');
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    expect(base.slot.contentPresence).toBe('set');
    expect(base.slot.content).toBe('base-title');

    // Write b1 (base unset) then read it back: the overlay is the effective value.
    const written = await h.service.replaceContent(h.grant, ctx('w1', 'h2'), [{ slotId: 'b1', content: 'draft-body' }]);
    expect(written.ok).toBe(true);
    const overlay = await h.service.readSlot(h.grant, ctx('r2', 'h3', 'read_slot'), 'b1');
    expect(overlay.ok).toBe(true);
    if (!overlay.ok) return;
    expect(overlay.slot.contentPresence).toBe('set');
    expect(overlay.slot.content).toBe('draft-body');
  });

  it('list_slots returns the authorized outline (ancestor shell, no hidden totals)', async () => {
    const h = await makeHarness();
    const listed = await h.service.listSlots(h.grant, ctx('l1', 'h1', 'list_slots'), null, 10);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const ids = listed.entries.map((e) => e.slotId);
    // t1 and b1 are directly visible; r is only present as an ancestor shell.
    expect(ids).toContain('t1');
    expect(ids).toContain('b1');
    expect(ids).toContain('r');
    const root = listed.entries.find((e) => e.slotId === 'r');
    expect(root?.shell).toBe(true);
    expect(root?.spec).toBeUndefined();
    expect(listed.entries.filter((e) => e.slotId !== 'r').every((e) => e.shell === false)).toBe(true);
  });

  it('applies a batch replace all-or-nothing', async () => {
    const h = await makeHarness();
    // The batch mixes a valid writable slot with an out-of-scope one → whole batch fails.
    const out = await h.service.replaceContent(h.grant, ctx('b1', 'h1'), [
      { slotId: 'b1', content: 'good' },
      { slotId: 'r', content: 'bad' },
    ]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('SLOT_WRITE_FORBIDDEN');
    // No part of the batch was applied.
    const read = await h.service.readSlot(h.grant, ctx('r1', 'h2', 'read_slot'), 'b1');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.slot.contentPresence).toBe('unset');
  });

  it('unset is distinct from a set null value', async () => {
    const h = await makeHarness();
    await h.service.replaceContent(h.grant, ctx('w1', 'h1'), [{ slotId: 'b1', content: null }]);
    let read = await h.service.readSlot(h.grant, ctx('r1', 'h2', 'read_slot'), 'b1');
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.slot.contentPresence).toBe('set');
      expect(read.slot.content).toBeNull();
    }
    await h.service.unsetContent(h.grant, ctx('u1', 'h3'), ['b1']);
    read = await h.service.readSlot(h.grant, ctx('r2', 'h4', 'read_slot'), 'b1');
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.slot.contentPresence).toBe('unset');
      expect(read.slot.content).toBeUndefined();
    }
  });

  it('hidden and missing slots reveal no existence (identical D05)', async () => {
    const h = await makeHarness();
    const hidden = await h.service.readSlot(h.grant, ctx('r1', 'h1', 'read_slot'), 'r');
    const missing = await h.service.readSlot(h.grant, ctx('r2', 'h2', 'read_slot'), 'ghost');
    expect(hidden.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (!hidden.ok && !missing.ok) {
      expect(hidden.code).toBe('SLOT_NOT_VISIBLE');
      expect(missing.code).toBe('SLOT_NOT_VISIBLE');
      expect(hidden.issues?.[0]).toBeDefined();
      expect(missing.issues?.[0]).toBeDefined();
      expect(hidden.issues?.[0]).toEqual(missing.issues?.[0]);
      const json = JSON.stringify(hidden.issues?.[0]);
      expect(json).not.toContain('"r"');
      expect(json).not.toContain('ghost');
    }
  });

  it('rejects writes outside the writable scope without existence hints', async () => {
    const h = await makeHarness();
    const root = await h.service.replaceContent(h.grant, ctx('w1', 'h1'), [{ slotId: 'r', content: 'x' }]);
    expect(root.ok).toBe(false);
    if (!root.ok) {
      expect(root.code).toBe('SLOT_WRITE_FORBIDDEN');
      expect(JSON.stringify(root.issues)).not.toContain('"r"');
    }
    const ghost = await h.service.replaceContent(h.grant, ctx('w2', 'h2'), [{ slotId: 'ghost', content: 'x' }]);
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.code).toBe('SLOT_WRITE_FORBIDDEN');
  });

  it('charges the Attempt meter BEFORE authorization so invalid calls still count', async () => {
    const h = await makeHarness();
    const before = h.meter.usage.slotToolCalls;
    const out = await h.service.replaceContent(h.grant, ctx('w1', 'h1'), [{ slotId: 'ghost', content: 'x' }]);
    expect(out.ok).toBe(false);
    expect(h.meter.usage.slotToolCalls).toBe(before + 1);
  });

  it('validate_draft is advisory: returns a verdict and never locks or changes authority', async () => {
    const h = await makeHarness();
    await h.service.replaceContent(h.grant, ctx('w1', 'h1'), [{ slotId: 'b1', content: 123 }]);
    const verdict = await h.service.validateDraft(h.grant, ctx('v1', 'h2', 'validate_draft'));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.verdict.status).toBe('failed');
    expect(verdict.verdict.issues.some((i) => i.code === 'CONTENT_SCHEMA_INVALID')).toBe(true);
    const status = await h.service.getDraftStatus(h.grant, ctx('g1', 'h3', 'get_draft_status'));
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.status.locked).toBe(false);
      expect(status.status.changedSlotCount).toBe(1);
    }
  });
});

describe('Step 2 — lifecycle + idempotency', () => {
  it('getOrCreateDraft requires a committed draft_opened for the active turn', async () => {
    const h = await makeHarness({ materializeDraft: false });
    const created = await h.service.getOrCreateDraft(TURN, DRAFT);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.view.overlay.size).toBe(0);
    // A subsequent get-or-create returns the SAME draft (idempotent).
    const again = await h.service.getOrCreateDraft(TURN, DRAFT);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.view.draftId).toBe(DRAFT);

    // A never-opened draft id cannot be materialized.
    const neverOpened = await h.service.getOrCreateDraft(TURN, 'draft-never-opened');
    expect(neverOpened.ok).toBe(false);
  });

  it('replays an exact signature and conflicts on the same id with changed args', async () => {
    const h = await makeHarness();
    const first = await h.service.replaceContent(h.grant, ctx('tc-1', 'hash-a'), [{ slotId: 'b1', content: 'hello' }]);
    expect(first.ok).toBe(true);
    const afterFirst = h.meter.usage.slotToolCalls;

    const replay = await h.service.replaceContent(h.grant, ctx('tc-1', 'hash-a'), [{ slotId: 'b1', content: 'hello' }]);
    expect(replay.ok).toBe(true);
    expect(replay).toEqual(first);
    expect(h.meter.usage.slotToolCalls).toBe(afterFirst); // exact replay is free

    const conflict = await h.service.replaceContent(h.grant, ctx('tc-1', 'hash-b'), [{ slotId: 'b1', content: 'different' }]);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(h.meter.usage.slotToolCalls).toBe(afterFirst + 1); // the conflict still occupies quota
  });

  it('records a business failure so an exact replay returns the same failure without re-charging', async () => {
    const h = await makeHarness();
    const before = h.meter.usage.slotToolCalls;
    const first = await h.service.replaceContent(h.grant, ctx('tc-f', 'hash-f'), [{ slotId: 'r', content: 'x' }]);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    const afterFirst = h.meter.usage.slotToolCalls;
    expect(afterFirst).toBe(before + 1);
    const replay = await h.service.replaceContent(h.grant, ctx('tc-f', 'hash-f'), [{ slotId: 'r', content: 'x' }]);
    expect(replay).toEqual(first);
    expect(h.meter.usage.slotToolCalls).toBe(afterFirst); // a cached failure replay is free
  });

  it('a formed candidate locks the draft and submit replays return the same candidate', async () => {
    const h = await makeHarness();
    await h.service.replaceContent(h.grant, ctx('w1', 'h1'), [{ slotId: 'b1', content: 'done' }]);
    const submitted = await h.service.submitDraft(h.grant, ctx('s1', 'h2', 'submit_draft'));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.receipt.status).toBe('candidate_created');

    const write = await h.service.replaceContent(h.grant, ctx('w2', 'h3'), [{ slotId: 'b1', content: 'more' }]);
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.code).toBe('DRAFT_ALREADY_SUBMITTED');

    const replay = await h.service.submitDraft(h.grant, ctx('s1', 'h2', 'submit_draft'));
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.candidate).toEqual(submitted.candidate);
  });

  it('a stale base revision makes the draft not submittable (DRAFT_STALE)', async () => {
    const h = await makeHarness();
    // A prior merge advanced the active content revision to 1.
    h.events.push(
      makeTaskEvent({
        type: 'structured_fill_draft_terminal',
        draftId: 'draft-0',
        turnId: 'turn-0',
        status: 'merged',
        baseRevision: 0,
        resultRevision: 1,
        changeCount: 1,
        content: { version: 1, kind: 'content_revision', sha256: 'c'.repeat(64), byteLength: 4 },
      }),
    );
    const out = await h.service.submitDraft(h.grant, ctx('s1', 'h1', 'submit_draft'));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('DRAFT_STALE');
  });

  it('reports merged/abandoned from the terminal events, never from private state', async () => {
    const h = await makeHarness();
    h.events.push(
      makeTaskEvent({
        type: 'structured_fill_draft_terminal',
        draftId: DRAFT,
        turnId: TURN,
        status: 'merged',
        baseRevision: 0,
        resultRevision: 0,
        changeCount: 0,
        content: null,
      }),
    );
    let status = await h.service.getDraftStatus(h.grant, ctx('g1', 'h1', 'get_draft_status'));
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.status.lifecycle).toBe('merged');

    h.events.push(
      makeTaskEvent({
        type: 'structured_fill_draft_terminal',
        draftId: DRAFT,
        turnId: TURN,
        status: 'abandoned',
        baseRevision: 0,
        resultRevision: 0,
        changeCount: 0,
        content: null,
      }),
    );
    status = await h.service.getDraftStatus(h.grant, ctx('g2', 'h2', 'get_draft_status'));
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.status.lifecycle).toBe('abandoned');
  });

  it('reports the authoritative terminal even when the private cache is absent', async () => {
    const h = await makeHarness();
    // Crash after the authority batch, before any private terminal marker: only
    // the TaskEvent exists. The service must still report the terminal.
    h.events.push(
      makeTaskEvent({
        type: 'structured_fill_draft_terminal',
        draftId: DRAFT,
        turnId: TURN,
        status: 'abandoned',
        baseRevision: 0,
        resultRevision: 0,
        changeCount: 0,
        content: null,
      }),
    );
    const status = await h.service.getDraftStatus(h.grant, ctx('g1', 'h1', 'get_draft_status'));
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.status.lifecycle).toBe('abandoned');
  });

  it('gives every attempt a fresh empty Draft with no overlay clone', async () => {
    const h = await makeHarness();
    await h.service.replaceContent(h.grant, ctx('w1', 'h1'), [{ slotId: 'b1', content: 'old' }]);
    // Close the old attempt and open a new one (higher epoch → new turnId).
    h.events.push(
      makeTaskEvent({
        type: 'structured_slot_attempt_terminal',
        inputNodeId: 'in-1',
        attemptEpoch: 1,
        turnId: TURN,
        status: 'abandoned',
        reason: 'task_stop',
      }),
    );
    const newTurn = deriveTurnId('in-1', 2);
    const newDraft = deriveDraftId(newTurn);
    h.events.push(
      makeTaskEvent({
        type: 'structured_slot_attempt_started',
        inputNodeId: 'in-1',
        agentId: AGENT,
        attemptEpoch: 2,
        turnId: newTurn,
        sessionKind: 'fill',
      }),
      makeTaskEvent({
        type: 'structured_fill_draft_opened',
        draftId: newDraft,
        turnId: newTurn,
        scaffoldId: SC,
        generationId: GEN,
        baseRevision: 0,
      }),
    );
    const got = await h.service.getOrCreateDraft(newTurn, newDraft);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.view.draftId).toBe(newDraft);
    expect(got.view.overlay.size).toBe(0);
  });
});

describe('Step 3 — Merge Gate', () => {
  it('rejects content that violates the slot content schema and keeps the draft open', async () => {
    const h = await makeHarness();
    await h.service.replaceContent(h.grant, ctx('w1', 'h1'), [{ slotId: 'b1', content: 123 }]);
    const out = await h.service.submitDraft(h.grant, ctx('s1', 'h2', 'submit_draft'));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe('DRAFT_GATE_REJECTED');
      expect(out.verdict?.status).toBe('failed');
      const schema = out.verdict?.issues.find((i) => i.code === 'CONTENT_SCHEMA_INVALID');
      expect(schema).toBeDefined();
      expect(schema?.primaryLocation).toEqual({ kind: 'slot', slotId: 'b1', field: 'content', valuePointer: '' });
    }
    // The draft stays open: further writes are still accepted.
    const write = await h.service.replaceContent(h.grant, ctx('w2', 'h3'), [{ slotId: 'b1', content: 'fixed' }]);
    expect(write.ok).toBe(true);
  });

  it('runs changed-slot merge-trigger validators and rejects on a blocking reject', async () => {
    const rejectB1 = makeValidator({ id: 'reject-b1', path: 'slots/validators/reject-b1.cjs' });
    const h = await makeHarness({
      validators: [rejectB1],
      sources: { 'slots/validators/reject-b1.cjs': rejectingSource(['b1']) },
    });
    await h.service.replaceContent(h.grant, ctx('w1', 'h1'), [{ slotId: 'b1', content: 'x' }]);
    const out = await h.service.submitDraft(h.grant, ctx('s1', 'h2', 'submit_draft'));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.verdict?.status).toBe('failed');
      const rejected = out.verdict?.issues.find(
        (i) => i.code === 'VALIDATOR_REJECTED' && i.primaryLocation.kind === 'slot' && i.primaryLocation.slotId === 'b1',
      );
      expect(rejected).toBeDefined();
    }
  });

  it('runs affected subtree validators on the changed slot ancestors', async () => {
    const rejectRoot = makeValidator({
      id: 'reject-root',
      scope: 'subtree',
      path: 'slots/validators/reject-root.cjs',
    });
    const h = await makeHarness({
      validators: [rejectRoot],
      sources: { 'slots/validators/reject-root.cjs': rejectingSource(['r']) },
    });
    await h.service.replaceContent(h.grant, ctx('w1', 'h1'), [{ slotId: 'b1', content: 'x' }]);
    const out = await h.service.submitDraft(h.grant, ctx('s1', 'h2', 'submit_draft'));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      const onRoot = out.verdict?.issues.find(
        (i) => i.code === 'VALIDATOR_REJECTED' && i.primaryLocation.kind === 'slot' && i.primaryLocation.slotId === 'r',
      );
      expect(onRoot).toBeDefined();
    }
  });

  it('freezes a nonempty candidate with resultRevision base+1 and a staged content root', async () => {
    const h = await makeHarness();
    await h.service.replaceContent(h.grant, ctx('w1', 'h1'), [{ slotId: 'b1', content: 'final' }]);
    const out = await h.service.submitDraft(h.grant, ctx('s1', 'h2', 'submit_draft'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.candidate.taskId).toBe(TASK);
    expect(out.candidate.turnId).toBe(TURN);
    expect(out.candidate.draftId).toBe(DRAFT);
    expect(out.candidate.scaffoldId).toBe(SC);
    expect(out.candidate.baseRevision).toBe(0);
    expect(out.candidate.resultRevision).toBe(1);
    expect(out.candidate.changeCount).toBe(1);
    expect(out.candidate.contentRevisionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(out.candidate.normalizedChanges).toEqual([{ slotId: 'b1', presence: 'set', content: 'final' }]);
  });

  it('gates a baseRevision >= 1 draft against the committed content at the ACTIVE revision, not the revision-0 generation records', async () => {
    const subtree = makeValidator({ id: 'base-check', scope: 'subtree', path: 'slots/validators/base-check.cjs' });
    const h = await makeHarness({
      validators: [subtree],
      sources: { 'slots/validators/base-check.cjs': MERGED_BASE_CHECK_SOURCE },
      priorMergedTitle: 'merged-title',
    });
    // The draft is bound to baseRevision 1 after the prior merged fill.
    expect(h.grant.baseRevision).toBe(1);

    // Write a NEW body slot on top of the post-merge base.
    await h.service.replaceContent(h.grant, ctx('w1', 'h1'), [{ slotId: 'b1', content: 'new-body' }]);
    const out = await h.service.submitDraft(h.grant, ctx('s1', 'h2', 'submit_draft'));
    // The unchanged t1 must read as the merged committed value ('merged-title'),
    // not the revision-0 era generation record ('base-title') — otherwise the
    // subtree validator rejects and the gate fails.
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.candidate.baseRevision).toBe(1);
    expect(out.candidate.resultRevision).toBe(2);
    expect(out.candidate.changeCount).toBe(1);
    expect(out.candidate.normalizedChanges).toEqual([{ slotId: 'b1', presence: 'set', content: 'new-body' }]);

    // The staged content root preserves the merged base for unchanged t1 and
    // carries the new overlay value for b1 (mirrors readEffectiveContent).
    const staged = await h.blobStore.readEffectiveContent({
      version: 1,
      kind: 'content_revision',
      sha256: out.candidate.contentRevisionDigest as string,
      byteLength: 0,
    });
    expect(staged.t1).toEqual({ presence: 'set', content: 'merged-title' });
    expect(staged.b1).toEqual({ presence: 'set', content: 'new-body' });
  });

  it('no-op submit freezes a changeCount-0 candidate with no revision bump and no content root', async () => {
    const h = await makeHarness();
    const out = await h.service.submitDraft(h.grant, ctx('s1', 'h1', 'submit_draft'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.candidate.changeCount).toBe(0);
    expect(out.candidate.resultRevision).toBe(0);
    expect(out.candidate.baseRevision).toBe(0);
    expect(out.candidate.contentRevisionDigest).toBeNull();
    expect(out.candidate.normalizedChanges).toEqual([]);
    expect(out.receipt.changeCount).toBe(0);
    expect(out.receipt.status).toBe('candidate_created');
  });

  it('still runs scaffold-level merge validators on a no-op', async () => {
    const scaffold = makeValidator({ id: 'scaffold', scope: 'scaffold', path: 'slots/validators/scaffold.cjs' });
    const h = await makeHarness({
      validators: [scaffold],
      sources: { 'slots/validators/scaffold.cjs': REJECT_ALL_SOURCE },
    });
    const out = await h.service.submitDraft(h.grant, ctx('s1', 'h1', 'submit_draft'));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe('DRAFT_GATE_REJECTED');
      const onScaffold = out.verdict?.issues.find(
        (i) => i.code === 'VALIDATOR_REJECTED' && i.primaryLocation.kind === 'operation',
      );
      expect(onScaffold).toBeDefined();
    }
  });

  it('leaves authority zero-changed on a gate failure', async () => {
    const h = await makeHarness();
    await h.service.replaceContent(h.grant, ctx('w1', 'h1'), [{ slotId: 'b1', content: 123 }]);
    const terminalsBefore = h.events.filter((e) => e.type === 'structured_fill_draft_terminal').length;
    const out = await h.service.submitDraft(h.grant, ctx('s1', 'h2', 'submit_draft'));
    expect(out.ok).toBe(false);
    expect(h.events.filter((e) => e.type === 'structured_fill_draft_terminal').length).toBe(terminalsBefore);
    const status = await h.service.getDraftStatus(h.grant, ctx('g1', 'h3', 'get_draft_status'));
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.status.lifecycle).toBe('open');
      expect(status.status.locked).toBe(false);
    }
  });
});
