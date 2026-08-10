// @vitest-environment node
/**
 * Grant resolution + selector v1 tests (Task 10 Steps 1 & 3, design §10,
 * spec §8.2-§8.3).
 *
 * Step 1 covers selector + document order: all/root/types rules, rule union,
 * bounded ancestors/descendants/direct siblings, depth-first pre-order and
 * precedingFilled over multiple writable targets.
 *
 * Step 3 covers the grant lifecycle: wrong task/turn/agent/kind/snapshot/
 * generation/revision/draft rejects with stable codes; the structure grant
 * carries no scaffold fields; the seal grant has empty writable ids.
 */
import { describe, expect, it } from 'vitest';
import type { AccessProfileV1, FrozenStructuredSlotContractV1 } from '../../template/structured-slot-contract';
import type { GenerationIndexV1, SlotInstance } from '../../storage/structured-slot-blob-store';
import type { FillSessionGrantV1, SlotCapabilityV1 } from '../../../shared/structured-slots';
import { resolveAccessScope, StructuredSlotGrantService, type GrantUseContextV1 } from './grant-service';

const TASK = 'task-10';
const SNAPSHOT = 'snapshot-hash';
const TURN = 'turn-1';
const AGENT = 'agent-alpha';
const SC = 'scaffold-1';
const GEN = 'gen-1';
const REV = 3;
const DRAFT = 'draft-1';
const PROFILE_ID = 'fill-a';

type SlotSeed = { slotId: string; parentSlotId: string | null; typeId: string; presence: 'unset' | 'set' };

/** One fixture tree + its derived generation index (depth-first pre-order). */
function buildTree(seeds: SlotSeed[]): { slots: SlotInstance[]; index: GenerationIndexV1; documentOrder: string[] } {
  const slots: SlotInstance[] = seeds.map((s, i) => ({
    slotId: s.slotId,
    scaffoldId: SC,
    parentSlotId: s.parentSlotId,
    order: i,
    typeId: s.typeId,
    spec: {},
    contentPresence: s.presence,
    ...(s.presence === 'set' ? { content: `${s.slotId}-value` } : {}),
  }));
  const byParent: Record<string, string[]> = {};
  const byType: Record<string, string[]> = {};
  const documentOrder: string[] = [];
  for (const slot of slots) {
    const parentKey = slot.parentSlotId ?? '';
    (byParent[parentKey] ??= []).push(slot.slotId);
    (byType[slot.typeId] ??= []).push(slot.slotId);
    documentOrder.push(slot.slotId);
  }
  const index: GenerationIndexV1 = {
    version: 1,
    generationId: GEN,
    slotCount: slots.length,
    slots: Object.fromEntries(slots.map((s) => [s.slotId, { offset: 0, length: 0, order: s.order }])),
    byParent,
    byType,
    documentOrder,
  };
  return { slots, index, documentOrder };
}

const TREE = buildTree([
  { slotId: 'r', parentSlotId: null, typeId: 'document', presence: 'unset' },
  { slotId: 't1', parentSlotId: 'r', typeId: 'title', presence: 'set' },
  { slotId: 's1', parentSlotId: 'r', typeId: 'section', presence: 'unset' },
  { slotId: 'b1', parentSlotId: 's1', typeId: 'body', presence: 'set' },
  { slotId: 'b2', parentSlotId: 's1', typeId: 'body', presence: 'unset' },
  { slotId: 's2', parentSlotId: 'r', typeId: 'section', presence: 'unset' },
  { slotId: 'b3', parentSlotId: 's2', typeId: 'body', presence: 'set' },
  { slotId: 'q1', parentSlotId: 's2', typeId: 'quote', presence: 'unset' },
  { slotId: 'q2', parentSlotId: 'r', typeId: 'quote', presence: 'set' },
]);

const PRESENCE: Record<string, 'unset' | 'set'> = Object.fromEntries(TREE.slots.map((s) => [s.slotId, s.contentPresence]));

const FILL_PROFILE: AccessProfileV1 = {
  id: PROFILE_ID,
  read: [
    {
      targets: { kind: 'types', typeIds: ['body'] },
      targetLevel: 'content',
      context: { level: 'spec', ancestors: 1, descendants: 0, directSiblings: true },
    },
    {
      targets: { kind: 'root' },
      targetLevel: 'outline',
      context: { level: 'outline', ancestors: 0, descendants: 0, directSiblings: false },
    },
  ],
  writeContent: [{ targets: { kind: 'types', typeIds: ['body', 'quote'] } }],
  continuity: { precedingFilled: true },
};

const FILL_CAPS: readonly SlotCapabilityV1[] = ['read_slot_spec', 'read_slot_content', 'write_draft_content', 'submit_draft'];

function makeContract(profile: AccessProfileV1 = FILL_PROFILE): FrozenStructuredSlotContractV1 {
  return {
    version: 1,
    slotTypes: [],
    layoutGrammar: {} as never,
    accessProfiles: [profile],
    validators: [],
    assembler: {
      id: 'asm',
      implementation: { abi: 'forge-assembler/v1', path: 'slots/assembler/a.cjs' },
      budget: { cpuMs: 100, timeoutMs: 500, memoryMiB: 64 },
      routes: [],
    },
    limits: {} as never,
    resourceManifest: [],
    abiProfileIdentity: {
      validatorAbi: 'forge-validator/v1',
      assemblerAbi: 'forge-assembler/v1',
      profileIdentity: 'forge-structured-runtime/v1',
    },
    semanticDigest: 'test',
  };
}

function makeService(profile: AccessProfileV1 = FILL_PROFILE, taskId = TASK, snapshot = SNAPSHOT): StructuredSlotGrantService {
  return new StructuredSlotGrantService({ taskId, snapshotHash: snapshot, contract: makeContract(profile) });
}

function fillRequest(overrides: Partial<Parameters<StructuredSlotGrantService['resolveFillGrant']>[0]> = {}) {
  return {
    taskId: TASK,
    turnId: TURN,
    agentId: AGENT,
    sessionKind: 'fill' as const,
    snapshotHash: SNAPSHOT,
    capabilities: FILL_CAPS,
    accessProfileId: PROFILE_ID,
    activeScaffold: { scaffoldId: SC, generationId: GEN, contentRevision: REV },
    generationIndex: TREE.index,
    contentPresence: PRESENCE,
    baseRevision: REV,
    draftId: DRAFT,
    ...overrides,
  };
}

const fillContext = (overrides: Partial<GrantUseContextV1> = {}): GrantUseContextV1 => ({
  taskId: TASK,
  turnId: TURN,
  agentId: AGENT,
  sessionKind: 'fill',
  snapshotHash: SNAPSHOT,
  activeScaffold: { scaffoldId: SC, generationId: GEN, contentRevision: REV },
  draftId: DRAFT,
  ...overrides,
});

describe('resolveAccessScope — static write selectors (design §10.5)', () => {
  it('resolves an "all" selector to every slot in depth-first pre-order', () => {
    const scope = resolveAccessScope(
      { ...FILL_PROFILE, read: [], writeContent: [{ targets: { kind: 'all' } }], continuity: { precedingFilled: false } },
      TREE.index,
      PRESENCE,
      FILL_CAPS,
    );
    expect(scope.writableSlotIds).toEqual(TREE.documentOrder);
  });

  it('resolves a "root" selector to the single root slot', () => {
    const scope = resolveAccessScope(
      { ...FILL_PROFILE, read: [], writeContent: [{ targets: { kind: 'root' } }], continuity: { precedingFilled: false } },
      TREE.index,
      PRESENCE,
      FILL_CAPS,
    );
    expect(scope.writableSlotIds).toEqual(['r']);
  });

  it('resolves a "types" selector to matching slots in document order', () => {
    const scope = resolveAccessScope(
      { ...FILL_PROFILE, read: [], writeContent: [{ targets: { kind: 'types', typeIds: ['quote'] } }], continuity: { precedingFilled: false } },
      TREE.index,
      PRESENCE,
      FILL_CAPS,
    );
    expect(scope.writableSlotIds).toEqual(['q1', 'q2']);
  });

  it('unions multiple write rules and de-duplicates by pre-order', () => {
    const scope = resolveAccessScope(
      {
        ...FILL_PROFILE,
        read: [],
        writeContent: [
          { targets: { kind: 'types', typeIds: ['body'] } },
          { targets: { kind: 'types', typeIds: ['quote', 'body'] } },
        ],
        continuity: { precedingFilled: false },
      },
      TREE.index,
      PRESENCE,
      FILL_CAPS,
    );
    expect(scope.writableSlotIds).toEqual(['b1', 'b2', 'b3', 'q1', 'q2']);
  });

  it('denies by default when no selector matches', () => {
    const scope = resolveAccessScope(
      { ...FILL_PROFILE, read: [], writeContent: [{ targets: { kind: 'types', typeIds: ['missing-type'] } }], continuity: { precedingFilled: false } },
      TREE.index,
      PRESENCE,
      FILL_CAPS,
    );
    expect(scope.writableSlotIds).toEqual([]);
  });
});

describe('resolveAccessScope — bounded read context (design §10.5)', () => {
  it('grants targets at targetLevel and bounded ancestors/siblings at context level', () => {
    const scope = resolveAccessScope(
      {
        ...FILL_PROFILE,
        read: [
          {
            targets: { kind: 'types', typeIds: ['body'] },
            targetLevel: 'content',
            context: { level: 'spec', ancestors: 1, descendants: 0, directSiblings: true },
          },
        ],
        writeContent: [],
        continuity: { precedingFilled: false },
      },
      TREE.index,
      PRESENCE,
      FILL_CAPS,
    );
    expect(scope.readableSlotIds).toEqual(['s1', 'b1', 'b2', 's2', 'b3', 'q1']);
    expect(scope.readLevels['b1']).toBe('content');
    expect(scope.readLevels['s1']).toBe('spec');
    expect(scope.readLevels['q1']).toBe('spec');
  });

  it('bounded descendants includes up to N levels', () => {
    const scope = resolveAccessScope(
      {
        ...FILL_PROFILE,
        read: [
          {
            targets: { kind: 'root' },
            targetLevel: 'outline',
            context: { level: 'spec', ancestors: 0, descendants: 1, directSiblings: false },
          },
        ],
        writeContent: [],
        continuity: { precedingFilled: false },
      },
      TREE.index,
      PRESENCE,
      FILL_CAPS,
    );
    expect(scope.readableSlotIds).toEqual(['r', 't1', 's1', 's2', 'q2']);
  });

  it('ancestors are bounded to N levels (0 adds none)', () => {
    const scope = resolveAccessScope(
      {
        ...FILL_PROFILE,
        read: [
          {
            targets: { kind: 'types', typeIds: ['body'] },
            targetLevel: 'content',
            context: { level: 'outline', ancestors: 0, descendants: 0, directSiblings: false },
          },
        ],
        writeContent: [],
        continuity: { precedingFilled: false },
      },
      TREE.index,
      PRESENCE,
      FILL_CAPS,
    );
    expect(scope.readableSlotIds).toEqual(['b1', 'b2', 'b3']);
  });

  it('unions target, ancestor and sibling context and de-duplicates in pre-order', () => {
    const scope = resolveAccessScope(
      {
        ...FILL_PROFILE,
        read: [
          {
            targets: { kind: 'types', typeIds: ['body'] },
            targetLevel: 'content',
            context: { level: 'outline', ancestors: 2, descendants: 0, directSiblings: true },
          },
          {
            targets: { kind: 'root' },
            targetLevel: 'outline',
            context: { level: 'outline', ancestors: 0, descendants: 0, directSiblings: false },
          },
        ],
        writeContent: [],
        continuity: { precedingFilled: false },
      },
      TREE.index,
      PRESENCE,
      FILL_CAPS,
    );
    // s2 (ancestor of b3) sits between b2 and b3 in document order.
    expect(scope.readableSlotIds).toEqual(['r', 's1', 'b1', 'b2', 's2', 'b3', 'q1']);
  });
});

describe('resolveAccessScope — precedingFilled (design §10.5)', () => {
  it('adds set-content slots before every writable target at content level', () => {
    const scope = resolveAccessScope(FILL_PROFILE, TREE.index, PRESENCE, FILL_CAPS);
    expect(scope.readableSlotIds).toEqual(['r', 't1', 's1', 'b1', 'b2', 's2', 'b3', 'q1']);
    expect(scope.readLevels['t1']).toBe('content');
    expect(scope.readLevels['b1']).toBe('content');
    expect(scope.readLevels['b3']).toBe('content');
  });

  it('never adds preceding slots without the read_slot_content capability', () => {
    const caps = FILL_CAPS.filter((c) => c !== 'read_slot_content');
    const scope = resolveAccessScope(FILL_PROFILE, TREE.index, PRESENCE, caps);
    expect(scope.readableSlotIds).toEqual(['r', 's1', 'b1', 'b2', 's2', 'b3', 'q1']);
    expect(scope.readableSlotIds).not.toContain('t1');
  });

  it('never adds preceding slots when the profile disables precedingFilled', () => {
    const scope = resolveAccessScope({ ...FILL_PROFILE, continuity: { precedingFilled: false } }, TREE.index, PRESENCE, FILL_CAPS);
    expect(scope.readableSlotIds).toEqual(['r', 's1', 'b1', 'b2', 's2', 'b3', 'q1']);
  });

  it('adds ONLY set-content slots before a target (unset slots stay hidden)', () => {
    const profile: AccessProfileV1 = {
      id: 'p',
      read: [],
      writeContent: [{ targets: { kind: 'types', typeIds: ['body'] } }],
      continuity: { precedingFilled: true },
    };
    const scope = resolveAccessScope(profile, TREE.index, PRESENCE, FILL_CAPS);
    // t1 (set) and b1 (set) precede body targets; unset s1/b2 stay hidden.
    expect(scope.readableSlotIds).toEqual(['t1', 'b1']);
    expect(scope.writableSlotIds).toEqual(['b1', 'b2', 'b3']);
  });

  it('precedingFilled never extends the writable scope', () => {
    const scope = resolveAccessScope(FILL_PROFILE, TREE.index, PRESENCE, FILL_CAPS);
    expect(scope.writableSlotIds).toEqual(['b1', 'b2', 'b3', 'q1', 'q2']);
  });

  it('writeMode "none" (seal) yields an empty writable scope and no precedingFilled', () => {
    const scope = resolveAccessScope(FILL_PROFILE, TREE.index, PRESENCE, FILL_CAPS, 'none');
    expect(scope.writableSlotIds).toEqual([]);
    expect(scope.readableSlotIds).toEqual(['r', 's1', 'b1', 'b2', 's2', 'b3', 'q1']);
  });
});

describe('grant resolution (design §10.3)', () => {
  it('resolves a structure grant bound only to snapshot + proposal (no scaffold fields)', () => {
    const service = makeService();
    const result = service.resolveStructureGrant({
      taskId: TASK,
      turnId: TURN,
      agentId: AGENT,
      sessionKind: 'structure',
      snapshotHash: SNAPSHOT,
      capabilities: ['read_structure_contract', 'write_structure_proposal', 'submit_structure_proposal'],
      proposalId: 'proposal-1',
      grantId: 'grant-structure-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const grant = result.grant;
    expect(grant.kind).toBe('structure');
    expect(grant.caseId).toBe(TASK);
    expect(grant.grantId).toBe('grant-structure-1');
    expect(grant.proposalId).toBe('proposal-1');
    expect(grant).not.toHaveProperty('accessProfileId');
    expect(grant).not.toHaveProperty('scaffoldId');
    expect(grant).not.toHaveProperty('baseRevision');
    expect(grant).not.toHaveProperty('readableSlotIds');
    expect(grant).not.toHaveProperty('writableSlotIds');
    expect(grant).not.toHaveProperty('draftId');
  });

  it('resolves a fill grant with the resolved readable/writable slot sets', () => {
    const service = makeService();
    const result = service.resolveFillGrant(fillRequest({ grantId: 'grant-fill-1' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const grant = result.grant;
    expect(grant.kind).toBe('fill');
    expect(grant.caseId).toBe(TASK);
    expect(grant.accessProfileId).toBe(PROFILE_ID);
    expect(grant.scaffoldId).toBe(SC);
    expect(grant.baseRevision).toBe(REV);
    expect(grant.draftId).toBe(DRAFT);
    expect(grant.readableSlotIds).toEqual(['r', 't1', 's1', 'b1', 'b2', 's2', 'b3', 'q1']);
    expect(grant.writableSlotIds).toEqual(['b1', 'b2', 'b3', 'q1', 'q2']);
  });

  it('resolves a seal grant with empty writable ids and a null draft', () => {
    const service = makeService();
    const result = service.resolveSealGrant({
      taskId: TASK,
      turnId: TURN,
      agentId: AGENT,
      sessionKind: 'seal',
      snapshotHash: SNAPSHOT,
      capabilities: ['read_slot_spec', 'read_slot_content', 'request_seal'],
      accessProfileId: PROFILE_ID,
      activeScaffold: { scaffoldId: SC, generationId: GEN, contentRevision: REV },
      generationIndex: TREE.index,
      baseRevision: REV,
      grantId: 'grant-seal-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const grant = result.grant;
    expect(grant.kind).toBe('seal');
    expect(grant.writableSlotIds).toEqual([]);
    expect(grant.draftId).toBeNull();
    expect(grant.readableSlotIds).toEqual(['r', 's1', 'b1', 'b2', 's2', 'b3', 'q1']);
  });

  it('rejects a fill grant for the wrong task, snapshot, kind, profile, revision or generation index', () => {
    const service = makeService();
    expect(service.resolveFillGrant(fillRequest({ taskId: 'other-task' }))).toEqual({ ok: false, code: 'GRANT_INVALID', reason: expect.any(String) });
    expect(service.resolveFillGrant(fillRequest({ snapshotHash: 'other-snapshot' }))).toEqual({ ok: false, code: 'GRANT_INVALID', reason: expect.any(String) });
    expect(service.resolveFillGrant(fillRequest({ sessionKind: 'seal' } as never))).toEqual({ ok: false, code: 'GRANT_INVALID', reason: expect.any(String) });
    expect(service.resolveFillGrant(fillRequest({ accessProfileId: 'unknown-profile' }))).toEqual({ ok: false, code: 'GRANT_INVALID', reason: expect.any(String) });
    expect(service.resolveFillGrant(fillRequest({ baseRevision: REV - 1 }))).toEqual({ ok: false, code: 'GRANT_STALE', reason: expect.any(String) });
    expect(
      service.resolveFillGrant(
        fillRequest({ generationIndex: { ...TREE.index, generationId: 'gen-other' } }),
      ),
    ).toEqual({ ok: false, code: 'GRANT_INVALID', reason: expect.any(String) });
  });
});

describe('grant lifecycle validation (design D06)', () => {
  function grant(): FillSessionGrantV1 {
    const result = makeService().resolveFillGrant(fillRequest());
    if (!result.ok) throw new Error('grant resolution failed');
    return result.grant;
  }

  it('accepts a grant that matches its authoritative session context', () => {
    const service = makeService();
    expect(service.validateGrantForUse(grant(), fillContext()).ok).toBe(true);
  });

  it('rejects on wrong task / turn / agent / kind / snapshot', () => {
    const service = makeService();
    const g = grant();
    expect(service.validateGrantForUse(g, fillContext({ taskId: 'other-task' }))).toEqual({ ok: false, code: 'GRANT_INVALID', reason: expect.any(String) });
    expect(service.validateGrantForUse(g, fillContext({ turnId: 'turn-other' }))).toEqual({ ok: false, code: 'GRANT_INVALID', reason: expect.any(String) });
    expect(service.validateGrantForUse(g, fillContext({ agentId: 'agent-other' }))).toEqual({ ok: false, code: 'GRANT_INVALID', reason: expect.any(String) });
    expect(service.validateGrantForUse(g, fillContext({ sessionKind: 'seal' }))).toEqual({ ok: false, code: 'GRANT_INVALID', reason: expect.any(String) });
    expect(service.validateGrantForUse(g, fillContext({ snapshotHash: 'other-snapshot' }))).toEqual({ ok: false, code: 'GRANT_INVALID', reason: expect.any(String) });
  });

  it('rejects when the active generation or revision has moved on', () => {
    const service = makeService();
    const g = grant();
    expect(service.validateGrantForUse(g, fillContext({ activeScaffold: null }))).toEqual({ ok: false, code: 'GRANT_STALE', reason: expect.any(String) });
    expect(
      service.validateGrantForUse(g, fillContext({ activeScaffold: { scaffoldId: 'scaffold-2', generationId: 'gen-2', contentRevision: REV } })),
    ).toEqual({ ok: false, code: 'GRANT_STALE', reason: expect.any(String) });
    expect(
      service.validateGrantForUse(g, fillContext({ activeScaffold: { scaffoldId: SC, generationId: GEN, contentRevision: REV + 1 } })),
    ).toEqual({ ok: false, code: 'GRANT_STALE', reason: expect.any(String) });
  });

  it('rejects a fill grant bound to a different draft', () => {
    const service = makeService();
    expect(service.validateGrantForUse(grant(), fillContext({ draftId: 'draft-other' }))).toEqual({ ok: false, code: 'GRANT_STALE', reason: expect.any(String) });
  });
});
