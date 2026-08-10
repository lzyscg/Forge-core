// @vitest-environment node
/**
 * Authorized slot projection tests (Task 10 Step 2, design §10.4-§10.6,
 * D04/D05, spec §14).
 *
 * Non-disclosure is asserted exactly:
 * - missing and hidden slots return an IDENTICAL SLOT_NOT_VISIBLE (operation
 *   location, no slotId echo);
 * - a mixed visible/hidden batch returns zero rows (all-or-nothing);
 * - an ancestor shell carries no spec/content/child count / hidden hints;
 * - pagination reveals no hidden slots and no hidden totals;
 * - an Agent subject sees exactly its Grant projection;
 * - the local task_owner sees every formal slot/spec/content independent of
 *   template AccessProfiles and is never derived by unioning Agent profiles;
 * - an unknown subject kind is rejected.
 *
 * The signed, bound cursor is also covered: tampered fields or a forged cursor
 * with a valid signature over an unknown document key fail closed.
 */
import { describe, expect, it } from 'vitest';
import type { AccessProfileV1, FrozenStructuredSlotContractV1 } from '../../template/structured-slot-contract';
import type { GenerationIndexV1, SlotInstance } from '../../storage/structured-slot-blob-store';
import type { FillSessionGrantV1, SlotCapabilityV1, StructuredSlotTreeCursorV1 } from '../../../shared/structured-slots';
import { canonicalJson, canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { StructuredSlotGrantService, type ActiveScaffoldV1 } from './grant-service';
import {
  createTaskLocalCursorSigner,
  StructuredSlotProjectionService,
  type DraftContentOverlayV1,
  type StructuredSlotDataSource,
} from './projection-service';

const TASK = 'task-10';
const SNAPSHOT = 'snapshot-hash';
const TURN = 'turn-1';
const AGENT = 'agent-alpha';
const SC = 'scaffold-1';
const GEN = 'gen-1';
const REV = 3;
const DRAFT = 'draft-1';

type SlotSeed = { slotId: string; parentSlotId: string | null; typeId: string; presence: 'unset' | 'set' };

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

/** Only body slots are visible; sections/root are ancestor shells; rest hidden. */
const NARROW: AccessProfileV1 = {
  id: 'narrow',
  read: [
    {
      targets: { kind: 'types', typeIds: ['body'] },
      targetLevel: 'content',
      context: { level: 'outline', ancestors: 0, descendants: 0, directSiblings: false },
    },
  ],
  writeContent: [{ targets: { kind: 'types', typeIds: ['body'] } }],
  continuity: { precedingFilled: false },
};

/** Everything is visible here; per-slot levels differ (outline/spec/content). */
const FILL: AccessProfileV1 = {
  id: 'fill',
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

function makeContract(profile: AccessProfileV1): FrozenStructuredSlotContractV1 {
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

class FakeSource implements StructuredSlotDataSource {
  active: { scaffoldId: string; generationId: string; contentRevision: number };
  private readonly slotStore: Map<string, SlotInstance> = new Map(TREE.slots.map((s) => [s.slotId, s]));

  constructor(active: { scaffoldId: string; generationId: string; contentRevision: number }) {
    this.active = active;
  }

  async getActiveGeneration(): Promise<{ scaffoldId: string; generationId: string; contentRevision: number } | null> {
    return this.active;
  }

  async getGenerationIndex(): Promise<GenerationIndexV1> {
    return TREE.index;
  }

  async getSlot(_generationId: string, slotId: string): Promise<SlotInstance | null> {
    return this.slotStore.get(slotId) ?? null;
  }

  async getContentPresence(): Promise<Readonly<Record<string, 'unset' | 'set'>>> {
    return { ...PRESENCE };
  }
}

interface Env {
  projection: StructuredSlotProjectionService;
  source: FakeSource;
  fillGrant: FillSessionGrantV1;
}

async function makeEnv(
  profile: AccessProfileV1,
  caps: readonly SlotCapabilityV1[] = FILL_CAPS,
  signer = createTaskLocalCursorSigner(TASK),
): Promise<Env> {
  const contract = makeContract(profile);
  const active: ActiveScaffoldV1 = { scaffoldId: SC, generationId: GEN, contentRevision: REV };
  const source = new FakeSource(active);
  const service = new StructuredSlotGrantService({ taskId: TASK, snapshotHash: SNAPSHOT, contract });
  const resolved = service.resolveFillGrant({
    taskId: TASK,
    turnId: TURN,
    agentId: AGENT,
    sessionKind: 'fill',
    snapshotHash: SNAPSHOT,
    capabilities: caps,
    accessProfileId: profile.id,
    activeScaffold: active,
    generationIndex: TREE.index,
    contentPresence: PRESENCE,
    baseRevision: REV,
    draftId: DRAFT,
  });
  if (!resolved.ok) throw new Error(`grant resolution failed: ${resolved.reason}`);
  const projection = new StructuredSlotProjectionService({ contract, source, signer });
  return { projection, source, fillGrant: resolved.grant };
}

/** The agent projection identity hash (mirrors the projection service formula). */
function agentProjectionHash(grant: FillSessionGrantV1): string {
  return canonicalJsonSha256({
    subject: 'agent',
    kind: grant.kind,
    accessProfileId: grant.accessProfileId,
    scaffoldId: grant.scaffoldId,
    baseRevision: grant.baseRevision,
    draftId: grant.draftId,
    capabilities: grant.capabilities,
    readableSlotIds: grant.readableSlotIds,
    writableSlotIds: grant.writableSlotIds,
  });
}

interface OutlineItem {
  slotId: string;
  shell: boolean;
  level: string;
}

/** Walks every page of the outline and concatenates it (proves stable pages). */
async function collectPages(
  projection: StructuredSlotProjectionService,
  subject: { kind: 'agent'; grant: FillSessionGrantV1 } | { kind: 'task_owner' },
  limit: number,
): Promise<OutlineItem[]> {
  const all: OutlineItem[] = [];
  let cursor: StructuredSlotTreeCursorV1 | null = null;
  for (;;) {
    const page = await projection.listSlots(subject, cursor, limit);
    if (!page.ok) throw new Error(`listSlots failed: ${page.reason}`);
    for (const entry of page.entries) all.push({ slotId: entry.slotId, shell: entry.shell, level: entry.level });
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return all;
}

describe('StructuredSlotProjectionService — D05 non-disclosure', () => {
  it('returns an IDENTICAL SLOT_NOT_VISIBLE for a hidden slot and a missing slot', async () => {
    const { projection, fillGrant } = await makeEnv(NARROW);
    const subject = { kind: 'agent', grant: fillGrant } as const;
    const hidden = await projection.readSlot(subject, 't1');
    const missing = await projection.readSlot(subject, 'no-such-slot');
    expect(hidden.ok).toBe(false);
    expect(missing.ok).toBe(false);
    const h = hidden as { code: string; issue?: unknown };
    const m = missing as { code: string; issue?: unknown };
    expect(h.code).toBe('SLOT_NOT_VISIBLE');
    expect(m.code).toBe('SLOT_NOT_VISIBLE');
    expect(h.issue).toEqual(m.issue);
    expect(h.issue).toMatchObject({
      code: 'SLOT_NOT_VISIBLE',
      phase: 'draft',
      primaryLocation: { kind: 'operation' },
    });
    expect(JSON.stringify(h.issue)).not.toContain('t1');
    expect(JSON.stringify(h.issue)).not.toContain('no-such-slot');
  });

  it('a mixed visible/hidden batch returns zero rows (all-or-nothing)', async () => {
    const { projection, fillGrant } = await makeEnv(NARROW);
    const subject = { kind: 'agent', grant: fillGrant } as const;
    const mixed = await projection.readSlots(subject, ['b1', 't1']);
    expect(mixed.ok).toBe(false);
    expect((mixed as { code: string }).code).toBe('SLOT_NOT_VISIBLE');

    const allVisible = await projection.readSlots(subject, ['b1', 'b2', 'b3']);
    expect(allVisible.ok).toBe(true);
    if (allVisible.ok) expect(allVisible.slots.map((s) => s.slotId)).toEqual(['b1', 'b2', 'b3']);
  });

  it('a visible deep node gets an ancestor outline shell without spec/content/child count', async () => {
    const { projection, fillGrant } = await makeEnv(NARROW);
    const subject = { kind: 'agent', grant: fillGrant } as const;
    const result = await projection.readSlot(subject, 'b3');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slot.level).toBe('content');
    expect(result.slot.spec).toBeDefined();
    expect(result.slot.content).toBe('b3-value');
    // Ancestor shells root-first; they carry no spec/content/child hints.
    expect(result.slot.ancestors.map((a) => a.slotId)).toEqual(['r', 's2']);
    for (const ancestor of result.slot.ancestors) {
      expect(ancestor).not.toHaveProperty('spec');
      expect(ancestor).not.toHaveProperty('content');
      expect(ancestor).not.toHaveProperty('childCount');
      expect(ancestor).not.toHaveProperty('children');
    }
    // A shell is not itself directly readable.
    const shellRead = await projection.readSlot(subject, 's2');
    expect(shellRead.ok).toBe(false);
    expect((shellRead as { code: string }).code).toBe('SLOT_NOT_VISIBLE');
  });
});

describe('StructuredSlotProjectionService — pagination and bound cursors', () => {
  it('pages over the visible outline only and reveals no hidden slots or totals', async () => {
    const { projection, fillGrant } = await makeEnv(NARROW);
    const subject = { kind: 'agent', grant: fillGrant } as const;
    const pages = await collectPages(projection, subject, 2);
    expect(pages.map((p) => p.slotId)).toEqual(['r', 's1', 'b1', 'b2', 's2', 'b3']);
    expect(pages.map((p) => p.slotId)).not.toContain('t1');
    expect(pages.map((p) => p.slotId)).not.toContain('q1');
    expect(pages.map((p) => p.slotId)).not.toContain('q2');
    // Shells are outline-only; visible bodies are content.
    expect(pages.filter((p) => p.shell).map((p) => p.slotId)).toEqual(['r', 's1', 's2']);
    expect(pages.filter((p) => !p.shell && p.level === 'content').map((p) => p.slotId)).toEqual(['b1', 'b2', 'b3']);
  });

  it('rejects a cursor tampered in any bound field or signature', async () => {
    const { projection, fillGrant } = await makeEnv(NARROW);
    const subject = { kind: 'agent', grant: fillGrant } as const;
    const page1 = await projection.listSlots(subject, null, 2);
    if (!page1.ok) throw new Error(page1.reason);
    const cursor = page1.nextCursor;
    expect(cursor).not.toBeNull();
    const next = await projection.listSlots(subject, cursor, 2);
    expect(next.ok).toBe(true);

    const variants: Array<[string, StructuredSlotTreeCursorV1]> = [
      ['bad signature', { ...(cursor as StructuredSlotTreeCursorV1), signature: 'deadbeef' }],
      ['wrong generation', { ...(cursor as StructuredSlotTreeCursorV1), generationId: 'gen-other' }],
      ['wrong revision', { ...(cursor as StructuredSlotTreeCursorV1), revision: REV + 1 }],
      ['wrong projection hash', { ...(cursor as StructuredSlotTreeCursorV1), projectionHash: 'other-hash' }],
      ['wrong ordering version', { ...(cursor as StructuredSlotTreeCursorV1), orderingVersion: 99 }],
    ];
    for (const [label, variant] of variants) {
      const result = await projection.listSlots(subject, variant, 2);
      expect(result.ok).toBe(false);
      expect((result as { code: string }).code).toBe('CURSOR_INVALID');
      void label;
    }
  });

  it('rejects a forged cursor with a valid signature but an unknown document key', async () => {
    const signer = createTaskLocalCursorSigner(TASK, Buffer.from('fixed-test-secret'));
    const { projection, fillGrant } = await makeEnv(NARROW, FILL_CAPS, signer);
    const subject = { kind: 'agent', grant: fillGrant } as const;
    const payload: Omit<StructuredSlotTreeCursorV1, 'signature'> = {
      version: 1,
      generationId: GEN,
      revision: REV,
      projectionHash: agentProjectionHash(fillGrant),
      lastDocumentKey: 'not-a-real-slot',
      orderingVersion: 1,
    };
    const forged: StructuredSlotTreeCursorV1 = { ...payload, signature: signer.sign(canonicalJson(payload)) };
    const result = await projection.listSlots(subject, forged, 5);
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('CURSOR_INVALID');
  });

  it('invalid limit is a stable pagination error', async () => {
    const { projection, fillGrant } = await makeEnv(NARROW);
    const result = await projection.listSlots({ kind: 'agent', grant: fillGrant }, null, 0);
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('CURSOR_INVALID');
  });
});

describe('StructuredSlotProjectionService — agent subject sees exactly its grant', () => {
  it('reads each slot at its granted level (outline/spec/content)', async () => {
    const { projection, fillGrant } = await makeEnv(FILL);
    const subject = { kind: 'agent', grant: fillGrant } as const;
    const r = await projection.readSlot(subject, 'r');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.slot.level).toBe('outline');
      expect(r.slot.spec).toBeUndefined();
      expect(r.slot.content).toBeUndefined();
    }
    const s1 = await projection.readSlot(subject, 's1');
    expect(s1.ok).toBe(true);
    if (s1.ok) {
      expect(s1.slot.level).toBe('spec');
      expect(s1.slot.spec).toBeDefined();
      expect(s1.slot.content).toBeUndefined();
    }
    const t1 = await projection.readSlot(subject, 't1');
    expect(t1.ok).toBe(true);
    if (t1.ok) {
      expect(t1.slot.level).toBe('content');
      expect(t1.slot.content).toBe('t1-value');
    }
  });

  it('a writable node sees its own type/spec/content even when not readable', async () => {
    const { projection, fillGrant } = await makeEnv(FILL);
    const subject = { kind: 'agent', grant: fillGrant } as const;
    // q2 is writable (quote) but not in the readable set; it still projects content.
    const q2 = await projection.readSlot(subject, 'q2');
    expect(q2.ok).toBe(true);
    if (q2.ok) {
      expect(q2.slot.level).toBe('content');
      expect(q2.slot.typeId).toBe('quote');
      expect(q2.slot.spec).toBeDefined();
      expect(q2.slot.content).toBe('q2-value');
    }
    const list = await projection.listSlots(subject, null, 100);
    if (list.ok) {
      expect(list.entries.map((e) => e.slotId)).toEqual(TREE.documentOrder);
      const q2Entry = list.entries.find((e) => e.slotId === 'q2');
      expect(q2Entry?.level).toBe('content');
      expect(q2Entry?.spec).toBeDefined();
    }
  });

  it('applies the draft overlay as the effective read value (base + overlay)', async () => {
    const { projection, fillGrant } = await makeEnv(FILL);
    const subject = { kind: 'agent', grant: fillGrant } as const;
    const overlay: DraftContentOverlayV1 = { b1: { presence: 'set', content: 'drafted-b1' } };
    const withOverlay = await projection.readSlot(subject, 'b1', overlay);
    expect(withOverlay.ok).toBe(true);
    if (withOverlay.ok) {
      expect(withOverlay.slot.contentPresence).toBe('set');
      expect(withOverlay.slot.content).toBe('drafted-b1');
    }
    const unset = await projection.readSlot(subject, 'b1', { b1: { presence: 'unset' } });
    if (unset.ok) {
      expect(unset.slot.contentPresence).toBe('unset');
      expect(unset.slot.content).toBeUndefined();
    }
    const base = await projection.readSlot(subject, 'b1');
    if (base.ok) expect(base.slot.content).toBe('b1-value');
  });

  it('an overlay cannot reveal a hidden slot', async () => {
    const { projection, fillGrant } = await makeEnv(NARROW);
    const result = await projection.readSlot({ kind: 'agent', grant: fillGrant }, 't1', {
      t1: { presence: 'set', content: 'secret' },
    });
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('SLOT_NOT_VISIBLE');
  });

  it('rejects a structure grant in the slot projection', async () => {
    const contract = makeContract(NARROW);
    const source = new FakeSource({ scaffoldId: SC, generationId: GEN, contentRevision: REV });
    const service = new StructuredSlotGrantService({ taskId: TASK, snapshotHash: SNAPSHOT, contract });
    const structure = service.resolveStructureGrant({
      taskId: TASK,
      turnId: TURN,
      agentId: AGENT,
      sessionKind: 'structure',
      snapshotHash: SNAPSHOT,
      capabilities: ['read_structure_contract', 'write_structure_proposal', 'submit_structure_proposal'],
      proposalId: 'proposal-1',
    });
    if (!structure.ok) throw new Error('structure grant resolution failed');
    const projection = new StructuredSlotProjectionService({ contract, source, signer: createTaskLocalCursorSigner(TASK) });
    const result = await projection.listSlots({ kind: 'agent', grant: structure.grant }, null, 5);
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('GRANT_INVALID');
  });
});

describe('StructuredSlotProjectionService — grant staleness at the projection boundary', () => {
  it('returns GRANT_STALE when the active generation moves after resolution', async () => {
    const { projection, source, fillGrant } = await makeEnv(NARROW);
    source.active = { scaffoldId: 'scaffold-2', generationId: 'gen-2', contentRevision: REV };
    const result = await projection.listSlots({ kind: 'agent', grant: fillGrant }, null, 5);
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('GRANT_STALE');
  });

  it('returns GRANT_STALE when the active content revision moves after resolution', async () => {
    const { projection, source, fillGrant } = await makeEnv(NARROW);
    source.active = { scaffoldId: SC, generationId: GEN, contentRevision: REV + 1 };
    const result = await projection.readSlot({ kind: 'agent', grant: fillGrant }, 'b1');
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('GRANT_STALE');
  });
});

describe('StructuredSlotProjectionService — task_owner audit subject', () => {
  it('sees every formal slot/spec/content independent of template AccessProfiles', async () => {
    const { projection } = await makeEnv(NARROW);
    const owner = { kind: 'task_owner' } as const;
    const list = await projection.listSlots(owner, null, 100);
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.entries.map((e) => e.slotId)).toEqual(TREE.documentOrder);
      expect(list.entries.every((e) => !e.shell)).toBe(true);
      for (const entry of list.entries) expect(entry.spec).toBeDefined();
    }
    const read = await projection.readSlot(owner, 't1');
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.slot.level).toBe('content');
      expect(read.slot.spec).toBeDefined();
      expect(read.slot.content).toBe('t1-value');
    }
    const missing = await projection.readSlot(owner, 'no-such-slot');
    expect(missing.ok).toBe(false);
    expect((missing as { code: string }).code).toBe('SLOT_NOT_VISIBLE');
  });

  it('is never derived by unioning Agent profiles (a no-grant profile still sees everything)', async () => {
    const nothing: AccessProfileV1 = { id: 'none', read: [], writeContent: [], continuity: { precedingFilled: false } };
    const { projection, fillGrant } = await makeEnv(nothing);
    // The agent sees nothing (default deny).
    const agentList = await projection.listSlots({ kind: 'agent', grant: fillGrant }, null, 100);
    expect(agentList.ok).toBe(true);
    if (agentList.ok) expect(agentList.entries).toEqual([]);
    // The owner still sees every formal slot.
    const ownerList = await projection.listSlots({ kind: 'task_owner' }, null, 100);
    expect(ownerList.ok).toBe(true);
    if (ownerList.ok) expect(ownerList.entries).toHaveLength(9);
  });
});

describe('StructuredSlotProjectionService — subject validation', () => {
  it('rejects an unknown subject kind', async () => {
    const { projection } = await makeEnv(NARROW);
    const bogus = { kind: 'nobody' } as never;
    const list = await projection.listSlots(bogus, null, 5);
    expect(list.ok).toBe(false);
    expect((list as { code: string }).code).toBe('UNKNOWN_SUBJECT');
    const read = await projection.readSlot(bogus, 'r');
    expect(read.ok).toBe(false);
    expect((read as { code: string }).code).toBe('UNKNOWN_SUBJECT');
  });
});
