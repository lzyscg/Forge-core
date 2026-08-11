// @vitest-environment node
/**
 * StructureProposal service tests (Task 12 Steps 1-2, design §9.3/§11.3,
 * spec §9.1, design I05).
 *
 * Step 1 — storage boundary: content/slotId/ACL/revision/path (and every
 * engineering field outside the exact ProposalNode shape) reject with a stable
 * PROPOSAL_FORBIDDEN_FIELD; non-object spec and duplicate clientKey reject;
 * depth/nodes/bytes over the frozen limits reject with RESOURCE_LIMIT_EXCEEDED
 * issues; a schema/grammar-invalid but storage-safe proposal PUTS successfully
 * and stays open (no type/schema/grammar validation at the storage boundary).
 *
 * Step 2 — gate + candidate: validate_structure_proposal is ADVISORY (does not
 * lock or change authority); submit runs the FULL schema + grammar gate,
 * allocates deterministic slotIds from `scaffoldId + generationId +
 * instancePath` (never clientKey), freezes the `clientKey -> slotId` mapping in
 * a turn-bound candidate and LOCKS the proposal; a failed gate leaves the
 * proposal open (no lock). The model-facing surface is ONLY the safe receipt
 * {kind, status, changeCount, issueSummary} — no blob/Grant/revision/internal
 * ids anywhere.
 */
import { mkdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { disposeAllTestRoots, makeTaskEvent, makeTempCorePaths } from '../../test-support';
import type { FrozenStructuredSlotContractV1, FrozenSlotTypeV1 } from '../../template/structured-slot-contract';
import type { StructureSessionGrantV1, StructuredSlotLimitsV1, JsonObject } from '../../../shared/structured-slots';
import { compileLayoutGrammarV1 } from '../../structured-slots/layout-grammar';
import { compileSlotSchemaV1 } from '../../structured-slots/slot-schema';
import { StructuredSlotPrivateStore, type ProposalNode } from '../../storage/structured-slot-private-store';
import type { TaskEvent } from '../../storage/task-events';
import { StructuredSlotProposalService, deriveSlotId } from './proposal-service';

afterEach(() => {
  disposeAllTestRoots();
});

const TASK = 'task-12';
const SNAPSHOT = 'snapshot-1';
const TURN = 'turn-1';
const AGENT = 'agent-1';
const PROPOSAL = 'proposal-1';

function makeLimits(overrides: Partial<StructuredSlotLimitsV1> = {}): StructuredSlotLimitsV1 {
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
    ...overrides,
  };
}

/** Platform-neutral slot type helper mirroring the accepted fixture shape. */
function slotType(
  id: string,
  presence: 'forbidden' | 'optional' | 'required' = 'forbidden',
  schema?: unknown,
): FrozenSlotTypeV1 {
  const limits = makeLimits();
  return {
    id,
    name: id,
    description: `slot type ${id}`,
    specSchema: compileSlotSchemaV1(
      {
        type: 'object',
        additionalProperties: false,
        properties: { purpose: { type: 'string' } },
        required: ['purpose'],
      },
      limits,
    ),
    content:
      presence === 'forbidden'
        ? { presence }
        : { presence, schema: compileSlotSchemaV1(schema ?? { type: 'string', minLength: 1, maxLength: 200 }, limits) },
  };
}

function makeContract(overrides: { maxSlots?: number; maxTreeDepth?: number } = {}): FrozenStructuredSlotContractV1 {
  const limits = makeLimits(
    overrides.maxSlots !== undefined || overrides.maxTreeDepth !== undefined
      ? {
          structure: {
            maxSlots: overrides.maxSlots ?? 64,
            maxTreeDepth: overrides.maxTreeDepth ?? 8,
            maxChildrenPerSlot: 32,
          },
        }
      : {},
  );
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
  service: StructuredSlotProposalService;
  store: StructuredSlotPrivateStore;
  grant: StructureSessionGrantV1;
  events: TaskEvent[];
}

function makeHarness(contract = makeContract()): Harness {
  const { paths } = makeTempCorePaths('forge-core-proposal-');
  mkdirSync(paths.taskRoot(TASK), { recursive: true });
  const store = new StructuredSlotPrivateStore(paths, TASK);
  const events: TaskEvent[] = [];
  const service = new StructuredSlotProposalService({
    taskId: TASK,
    snapshotHash: SNAPSHOT,
    contract,
    store,
    events: async () => events,
  });
  const grant: StructureSessionGrantV1 = {
    grantId: 'grant-1',
    kind: 'structure',
    caseId: TASK,
    turnId: TURN,
    agentId: AGENT,
    snapshotHash: SNAPSHOT,
    capabilities: ['read_structure_contract', 'write_structure_proposal', 'submit_structure_proposal'],
    proposalId: PROPOSAL,
  };
  return { service, store, grant, events };
}

function node(clientKey: string, typeId: string, spec: JsonObject = {}, children: ProposalNode[] = []): ProposalNode {
  return { clientKey, typeId, spec, children };
}

/** Grammar- and schema-valid tree (document spec requires purpose). */
function validTree(): ProposalNode {
  return node('root', 'document', { purpose: 'doc' }, [
    node('t1', 'title', { purpose: 'head' }),
    node('b1', 'body', { purpose: 'para' }),
    node('q1', 'quote', { purpose: 'pull' }),
  ]);
}

const SUBMIT_CONTEXT = { scaffoldId: 'scaffold-1', generationId: 'gen-1' };

describe('get_structure_contract — declarative projection (design I05)', () => {
  it('projects creatable types, specSchemas, grammar and limits; never implementation/grant internals', async () => {
    const { service, grant } = makeHarness();
    const result = service.getContract(grant);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const projection = result.contract;

    expect(projection.version).toBe(1);
    expect(projection.slotTypes.map((t) => t.id)).toEqual(['document', 'title', 'body', 'quote']);
    const title = projection.slotTypes.find((t) => t.id === 'title');
    expect(title?.name).toBe('title');
    expect(title?.description).toBe('slot type title');
    expect(title?.contentPresence).toBe('required');
    // specSchema is the declarative object schema (no internal compile state).
    expect(title?.specSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { purpose: { type: 'string' } },
      required: ['purpose'],
    });

    expect(projection.layoutGrammar.rootType).toBe('document');
    expect(projection.layoutGrammar.productions['document']).toEqual({
      children: {
        kind: 'sequence',
        items: [
          { kind: 'slot', type: 'title' },
          { kind: 'repeat', min: 0, max: 16, item: { kind: 'choice', items: [{ kind: 'slot', type: 'body' }, { kind: 'slot', type: 'quote' }] } },
        ],
      },
    });
    expect(projection.limits.structure.maxSlots).toBe(64);
    expect(projection.limits.structure.maxTreeDepth).toBe(8);
    expect(projection.limits.payload.maxSpecBytesPerSlot).toBe(4096);
    expect(projection.limits.payload.maxScaffoldPayloadBytes).toBe(65536);
    expect(projection.safetyNotes.length).toBeGreaterThan(0);

    // No implementation paths, validator/assembler sources, ACL, host paths,
    // event ids, grant ids, blob refs or internal schema compile state.
    const json = JSON.stringify(projection);
    for (const forbidden of ['grantId', 'proposalId', 'turnId', 'snapshotHash', 'path', 'implementation', 'validator', 'assembler', '_match', '_enumHashes', '_constHash', 'contentSchema', 'accessProfiles']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('rejects a grant bound to a different task or snapshot', async () => {
    const { service, grant } = makeHarness();
    const wrongTask = service.getContract({ ...grant, caseId: 'other-task' });
    expect(wrongTask.ok).toBe(false);
    if (!wrongTask.ok) expect(wrongTask.code).toBe('GRANT_INVALID');
    const wrongSnapshot = service.getContract({ ...grant, snapshotHash: 'other-snapshot' });
    expect(wrongSnapshot.ok).toBe(false);
    if (!wrongSnapshot.ok) expect(wrongSnapshot.code).toBe('GRANT_INVALID');
  });
});

describe('put_structure_proposal — storage boundary (design §9.3)', () => {
  it('rejects forbidden engineering fields on any node', async () => {
    const { service, grant, store } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    const cases: Array<[string, Record<string, unknown>]> = [
      ['content', { content: 'x' }],
      ['slotId', { slotId: 's1' }],
      ['acl', { acl: { read: [] } }],
      ['revision', { revision: 3 }],
      ['path', { path: '/etc/passwd' }],
      ['scaffoldId', { scaffoldId: 'scaffold-1' }],
      ['grantId', { grantId: 'g' }],
      ['taskId', { taskId: 'task' }],
      ['draftId', { draftId: 'd' }],
      ['turnId', { turnId: 'turn' }],
    ];
    for (const [field, extra] of cases) {
      const tree = node('root', 'document', {}, [node('t1', 'title', { purpose: 'x' }, [] as ProposalNode[])]);
      (tree.children[0] as unknown as Record<string, unknown>)[field] = (extra as Record<string, unknown>)[field];
      const result = await service.putProposal(grant, tree);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PROPOSAL_FORBIDDEN_FIELD');
    }
  });

  it('rejects a non-object spec', async () => {
    const { service, grant, store } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    const tree = node('root', 'document', {}, [node('t1', 'title', 'not-an-object' as unknown as JsonObject)]);
    const result = await service.putProposal(grant, tree);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PROPOSAL_SPEC_NOT_OBJECT');
  });

  it('rejects a duplicate clientKey with the registry PROPOSAL_CLIENT_KEY_DUPLICATE issue', async () => {
    const { service, grant, store } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    const tree = node('root', 'document', {}, [
      node('same', 'title', { purpose: 'a' }),
      node('same', 'body', { purpose: 'b' }),
    ]);
    const result = await service.putProposal(grant, tree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PROPOSAL_CLIENT_KEY_DUPLICATE');
      expect(result.issues?.some((i) => i.code === 'PROPOSAL_CLIENT_KEY_DUPLICATE')).toBe(true);
    }
  });

  it('rejects a tree deeper than maxTreeDepth', async () => {
    const { service, grant, store } = makeHarness(makeContract({ maxTreeDepth: 8 }));
    await store.materializeProposal(TURN, PROPOSAL);
    // A chain deeper than depth 8 (root = 1).
    let tree = node('n8', 'quote');
    for (let i = 7; i >= 0; i -= 1) tree = node(`n${i}`, 'quote', {}, [tree]);
    const result = await service.putProposal(grant, tree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PROPOSAL_LIMIT_EXCEEDED');
      expect(result.issues?.some((i) => i.code === 'RESOURCE_LIMIT_EXCEEDED')).toBe(true);
    }
  });

  it('fails with PROPOSAL_LIMIT_EXCEEDED (never a RangeError) on an extremely deep tree', async () => {
    const { service, grant, store } = makeHarness(makeContract({ maxTreeDepth: 8 }));
    await store.materializeProposal(TURN, PROPOSAL);
    // A chain far deeper than maxTreeDepth: without the in-walk short-circuit
    // the unbounded recursion would overflow the stack with a raw RangeError
    // before the post-walk bound could fire.
    let tree = node('n-deep', 'quote');
    for (let i = 0; i < 100_000; i += 1) tree = node(`n${i}`, 'quote', {}, [tree]);
    const result = await service.putProposal(grant, tree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PROPOSAL_LIMIT_EXCEEDED');
      expect(result.issues?.some((i) => i.code === 'RESOURCE_LIMIT_EXCEEDED')).toBe(true);
    }
  });

  it('accepts a deep-but-within-bound tree', async () => {
    const { service, grant, store } = makeHarness(makeContract({ maxTreeDepth: 8 }));
    await store.materializeProposal(TURN, PROPOSAL);
    // A chain of exactly maxTreeDepth (root = 1, deepest = 8) is legal.
    let tree = node('n8', 'quote');
    for (let i = 7; i >= 1; i -= 1) tree = node(`n${i}`, 'quote', {}, [tree]);
    const result = await service.putProposal(grant, tree);
    expect(result.ok).toBe(true);
  });

  it('rejects a tree with more nodes than maxSlots', async () => {
    const { service, grant, store } = makeHarness(makeContract({ maxSlots: 8 }));
    await store.materializeProposal(TURN, PROPOSAL);
    const children: ProposalNode[] = [];
    for (let i = 0; i < 10; i += 1) children.push(node(`b${i}`, 'body', { purpose: 'x' }));
    const tree = node('root', 'document', {}, [node('t0', 'title', { purpose: 'x' }), ...children]);
    const result = await service.putProposal(grant, tree);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PROPOSAL_LIMIT_EXCEEDED');
  });

  it('rejects a spec larger than maxSpecBytesPerSlot', async () => {
    const { service, grant, store } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    const tree = node('root', 'document', {}, [node('t1', 'title', { purpose: 'x'.repeat(5000) })]);
    const result = await service.putProposal(grant, tree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PROPOSAL_LIMIT_EXCEEDED');
      expect(result.issues?.some((i) => i.code === 'RESOURCE_LIMIT_EXCEEDED')).toBe(true);
    }
  });

  it('rejects a total spec payload larger than maxScaffoldPayloadBytes', async () => {
    const { service, grant, store } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    // 12 containers x (1 + 2 leaf) = 36 nodes <= maxSlots(64), depth 3 <= 8,
    // 12 children <= maxChildrenPerSlot(16). Every spec ~2000 bytes <
    // maxSpecBytesPerSlot(4096), but the total ~72 KB exceeds the 64 KiB
    // scaffold payload cap.
    const children: ProposalNode[] = [];
    for (let i = 0; i < 12; i += 1) {
      children.push(
        node(`s${i}`, 'body', { purpose: 'x'.repeat(2000) }, [
          node(`g${i}a`, 'body', { purpose: 'y'.repeat(2000) }),
          node(`g${i}b`, 'body', { purpose: 'z'.repeat(2000) }),
        ]),
      );
    }
    const tree = node('root', 'document', {}, [node('t0', 'title', { purpose: 'x' }), ...children]);
    const result = await service.putProposal(grant, tree);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PROPOSAL_LIMIT_EXCEEDED');
  });

  it('rejects a non-JSON tree (malformed) and a malformed node', async () => {
    const { service, grant, store } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    // A `undefined` spec is not a JSON object: the shape check rejects it as a
    // non-object spec (PROPOSAL_SPEC_NOT_OBJECT) before the JSON pass.
    const tree = node('root', 'document', {}, [
      { clientKey: 't1', typeId: 'title', spec: undefined, children: [] } as unknown as ProposalNode,
    ]);
    const result = await service.putProposal(grant, tree);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PROPOSAL_SPEC_NOT_OBJECT');

    const notObject = 42 as unknown as ProposalNode;
    const bad = await service.putProposal(grant, notObject);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('PROPOSAL_MALFORMED');
  });

  it('accepts a schema/grammar-invalid but storage-safe proposal and keeps it open', async () => {
    const { service, grant, store } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    // Unknown typeId + wrong child order + empty spec: all gate-invalid, but
    // the storage boundary (JSON, shape, limits, unique keys, no forbidden
    // fields) passes — the proposal is stored and stays open.
    const tree = node('root', 'unknown-type', {}, [
      node('x1', 'title', {}),
      node('x2', 'document', { purpose: 'x' }),
    ]);
    const result = await service.putProposal(grant, tree);
    expect(result.ok).toBe(true);
    const read = await service.getProposal(grant);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.tree).toEqual(tree);
      expect(read.lifecycle).toBe('open');
      expect(read.locked).toBe(false);
    }
    // A second put on the same open proposal also succeeds (whole-tree replace).
    const second = await service.putProposal(grant, validTree());
    expect(second.ok).toBe(true);
  });
});

describe('validate_structure_proposal — advisory (design §9.3)', () => {
  it('is advisory: reports the verdict but never locks or changes authority', async () => {
    const { service, grant, store } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    await service.putProposal(grant, validTree());
    const result = await service.validateProposal(grant);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict.status).toBe('passed');
    expect(result.verdict.summary).toEqual({ errors: 0, warnings: 0 });
    // Still open, still writable, no lock.
    const read = await store.readProposal(PROPOSAL, []);
    expect(read.lifecycle).toBe('open');
    expect(read.locked).toBe(false);
    const putAfter = await service.putProposal(grant, validTree());
    expect(putAfter.ok).toBe(true);
  });

  it('reports schema, root-type and grammar issues on a bad tree', async () => {
    const { service, grant, store } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    // Root type invalid + title missing its required spec field + wrong children.
    const tree = node('root', 'quote', {}, [
      node('t1', 'title', {}),
      node('b1', 'body', { purpose: 'x' }),
    ]);
    await service.putProposal(grant, tree);
    const result = await service.validateProposal(grant);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict.status).toBe('failed');
    const codes = result.verdict.issues.map((i) => i.code);
    expect(codes).toContain('STRUCTURE_ROOT_TYPE_INVALID');
    expect(codes).toContain('SPEC_SCHEMA_INVALID');
    expect(codes).toContain('STRUCTURE_PRODUCTION_MISMATCH');
  });

  it('returns a stable failure when no tree has been stored yet', async () => {
    const { service, grant, store } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    const result = await service.validateProposal(grant);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PROPOSAL_EMPTY');
  });
});

describe('submit_structure_proposal — full gate + candidate (design §9.3/§11.3)', () => {
  it('runs the full gate, allocates deterministic slotIds, freezes the mapping and locks', async () => {
    const { service, grant, store } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    await service.putProposal(grant, validTree());
    const result = await service.submitProposal(grant, SUBMIT_CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { candidate, receipt } = result;
    expect(candidate.taskId).toBe(TASK);
    expect(candidate.turnId).toBe(TURN);
    expect(candidate.proposalId).toBe(PROPOSAL);
    expect(candidate.snapshotHash).toBe(SNAPSHOT);
    expect(candidate.generationId).toBe('gen-1');
    expect(candidate.contentRevision).toBe(0);
    expect(candidate.slotCount).toBe(4);
    expect(candidate.normalizedTree).toEqual(validTree());

    // Deterministic slotIds from scaffoldId + generationId + instancePath.
    expect(candidate.slotIdByClientKey['root']).toBe(deriveSlotId('scaffold-1', 'gen-1', ''));
    expect(candidate.slotIdByClientKey['t1']).toBe(deriveSlotId('scaffold-1', 'gen-1', '/children/0'));
    expect(candidate.slotIdByClientKey['b1']).toBe(deriveSlotId('scaffold-1', 'gen-1', '/children/1'));
    expect(candidate.rootSlotId).toBe(candidate.slotIdByClientKey['root']);
    // slotIdByClientKey covers every node exactly.
    expect(Object.keys(candidate.slotIdByClientKey).sort()).toEqual(['b1', 'q1', 'root', 't1']);

    // The proposal is locked (candidate formed).
    const view = await store.readProposal(PROPOSAL, []);
    expect(view.locked).toBe(true);
    expect(view.candidate).not.toBeNull();

    // The safe receipt is the ONLY model-facing surface.
    expect(receipt).toEqual({
      kind: 'structure',
      status: 'candidate_created',
      changeCount: 4,
      issueSummary: { errors: 0, warnings: 0 },
    });
  });

  it('locks further write AND re-submit after the candidate', async () => {
    const { service, grant, store } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    await service.putProposal(grant, validTree());
    await service.submitProposal(grant, SUBMIT_CONTEXT);

    const putAfter = await service.putProposal(grant, validTree());
    expect(putAfter.ok).toBe(false);
    if (!putAfter.ok) expect(putAfter.code).toBe('PROPOSAL_ALREADY_SUBMITTED');

    const submitAfter = await service.submitProposal(grant, SUBMIT_CONTEXT);
    expect(submitAfter.ok).toBe(true); // idempotent replay, not a second gate
    if (submitAfter.ok) expect(submitAfter.candidate.generationId).toBe('gen-1');
  });

  it('a failed gate leaves the Proposal OPEN with no lock and no candidate', async () => {
    const { service, grant, store } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    // Root type invalid -> gate fails.
    const tree = node('root', 'quote', {}, [node('t1', 'title', { purpose: 'x' })]);
    await service.putProposal(grant, tree);
    const result = await service.submitProposal(grant, SUBMIT_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PROPOSAL_GATE_REJECTED');
      expect(result.verdict?.status).toBe('failed');
      expect(result.verdict?.issues.some((i) => i.code === 'STRUCTURE_ROOT_TYPE_INVALID')).toBe(true);
    }
    // No lock, no candidate; the proposal remains writable.
    const view = await store.readProposal(PROPOSAL, []);
    expect(view.locked).toBe(false);
    expect(view.candidate).toBeNull();
    expect(view.lifecycle).toBe('open');
    const putAfter = await service.putProposal(grant, validTree());
    expect(putAfter.ok).toBe(true);
  });

  it('rejects submit before any tree is stored', async () => {
    const { service, grant, store } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    const result = await service.submitProposal(grant, SUBMIT_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PROPOSAL_EMPTY');
  });

  it('derives slotIds from scaffoldId+generationId+instancePath, never from clientKey', async () => {
    // Same path + same generation identity => same slotId regardless of clientKey.
    const a = deriveSlotId('scaffold-1', 'gen-1', '/children/0');
    const b = deriveSlotId('scaffold-1', 'gen-1', '/children/0');
    expect(a).toBe(b);
    // A different clientKey at the same path must not change the slotId (the
    // derivation input is only scaffoldId + generationId + instancePath).
    const c = deriveSlotId('scaffold-1', 'gen-1', '/children/0');
    expect(c).toBe(a);
    // A new generation gets all-new slotIds (design §15).
    expect(deriveSlotId('scaffold-1', 'gen-2', '')).not.toBe(deriveSlotId('scaffold-1', 'gen-1', ''));
    // Different path => different slotId.
    expect(deriveSlotId('scaffold-1', 'gen-1', '')).not.toBe(deriveSlotId('scaffold-1', 'gen-1', '/children/0'));
  });

  it('exposes NO engineering fields in the candidate or receipt', async () => {
    const { service, grant, store } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    await service.putProposal(grant, validTree());
    const result = await service.submitProposal(grant, SUBMIT_CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { candidate, receipt } = result;
    // The candidate carries ONLY the frozen brief shape: taskId, turnId,
    // proposalId, snapshotHash, generationId, rootSlotId, slotCount,
    // slotIdByClientKey, normalizedTree, contentRevision. No scaffoldId, grant
    // id, agent id, ACL, blob, path or revision identity.
    expect(Object.keys(candidate).sort()).toEqual(
      ['contentRevision', 'generationId', 'normalizedTree', 'proposalId', 'rootSlotId', 'slotCount', 'slotIdByClientKey', 'snapshotHash', 'taskId', 'turnId'].sort(),
    );
    for (const forbidden of ['scaffoldId', 'grantId', 'agentId', 'acl', 'blob', 'path']) {
      expect(JSON.stringify(candidate)).not.toContain(forbidden);
    }
    // The normalized tree obeys the exact ProposalNode shape (no content /
    // slotId / revision / path / ACL fields anywhere).
    for (const forbidden of ['"content"', '"slotId"', '"revision"', '"path"', '"acl"', '"grantId"']) {
      expect(JSON.stringify(candidate.normalizedTree)).not.toContain(forbidden);
    }
    // The receipt is EXACTLY the safe summary — nothing else.
    expect(Object.keys(receipt).sort()).toEqual(['changeCount', 'issueSummary', 'kind', 'status'].sort());
    const receiptJson = JSON.stringify(receipt);
    for (const forbidden of ['grantId', 'blob', 'proposalId', 'turnId', 'slotId', 'generationId', 'snapshotHash', 'revision']) {
      expect(receiptJson).not.toContain(forbidden);
    }
  });

  it('rejects a committed or abandoned proposal (event reconciliation)', async () => {
    const { service, grant, store, events } = makeHarness();
    await store.materializeProposal(TURN, PROPOSAL);
    await service.putProposal(grant, validTree());
    events.push(
      makeTaskEvent({
        type: 'structured_scaffold_generation_committed',
        scaffoldId: 'scaffold-1',
        generationId: 'gen-1',
        supersedesGenerationId: null,
        rootSlotId: 'r',
        slotCount: 4,
        maxDepth: 1,
        structure: { version: 1, kind: 'generation', sha256: 'a'.repeat(64), byteLength: 4 },
        content: { version: 1, kind: 'content_revision', sha256: 'b'.repeat(64), byteLength: 4 },
        contentRevision: 0,
        proposalId: PROPOSAL,
      }),
    );
    const result = await service.submitProposal(grant, SUBMIT_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PROPOSAL_NOT_OPEN');
  });
});
