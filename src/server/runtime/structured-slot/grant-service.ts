/**
 * Slot session grant resolution + selector v1 (Task 10, design §10, spec
 * §8.2-§8.3).
 *
 * This is the authorization-control-plane of the structured-slot engine:
 *
 * - `resolveStructureGrant` binds only the frozen snapshot + private Proposal;
 *   it carries NO scaffold fields (structure precedes any active scaffold).
 * - `resolveFillGrant` / `resolveSealGrant` bind the active scaffold, content
 *   revision and the profile-resolved slot scope; the seal grant's writable
 *   scope is ALWAYS empty and its draft is null.
 * - `validateGrantForUse` enforces the design D06 lifecycle: a grant is dead
 *   when the task/turn/agent/kind/snapshot no longer match, or when the active
 *   generation/revision/draft moved on. Grants are never reused across kind,
 *   attempt or task.
 * - Selector resolution (design §10.5) is static + closed: all/root/types with
 *   rule union and default deny, plus bounded read context (ancestors,
 *   descendants, direct siblings) at the rule's context level, plus
 *   `precedingFilled` — set-content slots before every writable target in
 *   depth-first pre-order — granted at content level ONLY when the session
 *   holds `read_slot_content` AND the profile binds it. Every set is sorted in
 *   document order and de-duplicated.
 *
 * Grant ids are platform-generated (server-side); the Grant object is internal
 * and never projected to the model. This module carries zero business
 * vocabulary.
 */
import { randomUUID } from 'node:crypto';
import type {
  FillSessionGrantV1,
  SealSessionGrantV1,
  SlotCapabilityV1,
  SlotSessionGrantV1,
  StructureSessionGrantV1,
} from '../../../shared/structured-slots';
import type {
  AccessProfileV1,
  FrozenStructuredSlotContractV1,
  SlotTargetSelectorV1,
} from '../../template/structured-slot-contract';
import type { GenerationIndexV1 } from '../../storage/structured-slot-blob-store';

/** Closed session kinds (design §10.3). */
export type SlotGrantKind = 'structure' | 'fill' | 'seal';

/** Projection read level ordering (outline < spec < content). */
export type GrantReadLevel = 'outline' | 'spec' | 'content';

const READ_LEVELS: readonly GrantReadLevel[] = ['outline', 'spec', 'content'];

/** Stable grant failure codes (brief Step 3 / design D06). */
export type GrantResolutionErrorCode = 'GRANT_INVALID' | 'GRANT_STALE';

/** byParent key for root-level slots (parentSlotId === null), as in the store. */
const ROOT_PARENT_KEY = '';

/** The active scaffold generation a fill/seal grant binds (spec §8.2). */
export interface ActiveScaffoldV1 {
  scaffoldId: string;
  generationId: string;
  contentRevision: number;
}

/** Shared request identity every resolver validates against the service. */
export interface GrantRequestBaseV1 {
  taskId: string;
  turnId: string;
  agentId: string;
  sessionKind: SlotGrantKind;
  snapshotHash: string;
  capabilities: readonly SlotCapabilityV1[];
  /** Platform-generated; a random id is issued when omitted. */
  grantId?: string;
}

export interface StructureGrantRequestV1 extends GrantRequestBaseV1 {
  sessionKind: 'structure';
  proposalId: string;
}

export interface FillGrantRequestV1 extends GrantRequestBaseV1 {
  sessionKind: 'fill';
  accessProfileId: string;
  activeScaffold: ActiveScaffoldV1;
  /** Byte-indexed layout of the ACTIVE generation (design §10.5). */
  generationIndex: GenerationIndexV1;
  /** slotId -> presence of the active content revision. */
  contentPresence: Readonly<Record<string, 'unset' | 'set'>>;
  /** Draft base revision; must equal the active content revision. */
  baseRevision: number;
  draftId: string;
}

export interface SealGrantRequestV1 extends GrantRequestBaseV1 {
  sessionKind: 'seal';
  accessProfileId: string;
  activeScaffold: ActiveScaffoldV1;
  generationIndex: GenerationIndexV1;
  baseRevision: number;
}

/** Authoritative context a resolved grant is used under (design D06). */
export interface GrantUseContextV1 {
  taskId: string;
  turnId: string;
  agentId: string;
  sessionKind: SlotGrantKind;
  snapshotHash: string;
  activeScaffold?: ActiveScaffoldV1 | null;
  draftId?: string | null;
}

export type GrantResolutionResult<G extends SlotSessionGrantV1> =
  | { ok: true; grant: G }
  | { ok: false; code: GrantResolutionErrorCode; reason: string };

export type GrantValidationResult =
  | { ok: true }
  | { ok: false; code: GrantResolutionErrorCode; reason: string };

export interface GrantServiceOptions {
  taskId: string;
  snapshotHash: string;
  contract: FrozenStructuredSlotContractV1;
  issueGrantId?: () => string;
}

function fail(code: GrantResolutionErrorCode, reason: string): { ok: false; code: GrantResolutionErrorCode; reason: string } {
  return { ok: false, code, reason };
}

function levelIndex(level: GrantReadLevel): number {
  return READ_LEVELS.indexOf(level);
}

/** Minimum of two read levels (used to cap a projection by capability). */
export function minGrantReadLevel(a: GrantReadLevel, b: GrantReadLevel): GrantReadLevel {
  return READ_LEVELS[Math.min(levelIndex(a), levelIndex(b))];
}

function maxLevel(a: GrantReadLevel, b: GrantReadLevel): GrantReadLevel {
  return READ_LEVELS[Math.max(levelIndex(a), levelIndex(b))];
}

/** slotId -> position in the depth-first pre-order document sequence. */
function orderMap(index: GenerationIndexV1): Readonly<Record<string, number>> {
  const map: Record<string, number> = {};
  index.documentOrder.forEach((id, i) => {
    map[id] = i;
  });
  return map;
}

/** slotId -> direct parent (null for the root). */
export function slotParentMap(index: GenerationIndexV1): Readonly<Record<string, string | null>> {
  const map: Record<string, string | null> = {};
  for (const [parentKey, children] of Object.entries(index.byParent)) {
    for (const child of children) map[child] = parentKey === ROOT_PARENT_KEY ? null : parentKey;
  }
  return map;
}

/** Static target matching (design §10.5): results come back in pre-order. */
function selectTargets(
  selector: SlotTargetSelectorV1,
  index: GenerationIndexV1,
  order: Readonly<Record<string, number>>,
): string[] {
  switch (selector.kind) {
    case 'all':
      return [...index.documentOrder];
    case 'root':
      // Single-root tree: the one root slot (children of the empty parent key).
      return (index.byParent[ROOT_PARENT_KEY] ?? []).slice(0, 1);
    case 'types': {
      const ids = new Set<string>();
      for (const typeId of selector.typeIds) {
        for (const id of index.byType[typeId] ?? []) ids.add(id);
      }
      return index.documentOrder.filter((id) => ids.has(id));
    }
  }
}

/** Ancestors of a slot up to `count` levels, nearest first. */
function ancestors(slotId: string, parents: Readonly<Record<string, string | null>>, count: number): string[] {
  const out: string[] = [];
  if (count <= 0) return out;
  let current = parents[slotId];
  while (current !== undefined && current !== null && out.length < count) {
    out.push(current);
    current = parents[current];
  }
  return out;
}

/** Descendants of a slot up to `count` levels deep, breadth-first in pre-order. */
function descendants(slotId: string, index: GenerationIndexV1, count: number): string[] {
  const out: string[] = [];
  if (count <= 0) return out;
  let level = index.byParent[slotId] ?? [];
  let depth = 0;
  while (level.length > 0 && depth < count) {
    out.push(...level);
    depth += 1;
    if (depth >= count) break;
    const next: string[] = [];
    for (const id of level) next.push(...(index.byParent[id] ?? []));
    level = next;
  }
  return out;
}

/** Direct siblings of a slot (never itself). */
function directSiblings(
  slotId: string,
  parents: Readonly<Record<string, string | null>>,
  index: GenerationIndexV1,
): string[] {
  const parent = parents[slotId];
  const key = parent ?? ROOT_PARENT_KEY;
  return (index.byParent[key] ?? []).filter((id) => id !== slotId);
}

/**
 * Static write scope: the union of every writeContent rule's targets, in
 * document order, de-duplicated (design §10.5).
 */
export function resolveWriteScope(profile: AccessProfileV1, index: GenerationIndexV1): string[] {
  const order = orderMap(index);
  const ids = new Set<string>();
  for (const rule of profile.writeContent) {
    for (const id of selectTargets(rule.targets, index, order)) ids.add(id);
  }
  return index.documentOrder.filter((id) => ids.has(id));
}

export interface ResolveReadScopeOptions {
  /** Write scope of the session; precedingFilled only looks before these. */
  writableSlotIds: readonly string[];
  contentPresence: Readonly<Record<string, 'unset' | 'set'>>;
  capabilities: readonly SlotCapabilityV1[];
}

export interface ResolvedReadScopeV1 {
  readableSlotIds: string[];
  readLevels: Readonly<Record<string, GrantReadLevel>>;
}

/**
 * Static read scope + bounded context + precedingFilled (design §10.5).
 *
 * Every read rule grants its targeted slots at `targetLevel` and, per its
 * `context`, the bounded ancestors/descendants/direct siblings of those
 * targets at `context.level`. Then, when the session holds `read_slot_content`
 * AND the profile binds `continuity.precedingFilled`, every content-presence
 * `set` slot before each writable target (in document order) joins the read
 * scope at content level. Results are de-duplicated in depth-first pre-order.
 */
export function resolveReadScope(
  profile: AccessProfileV1,
  index: GenerationIndexV1,
  options: ResolveReadScopeOptions,
): ResolvedReadScopeV1 {
  const order = orderMap(index);
  const parents = slotParentMap(index);
  const readable = new Set<string>();
  const levels: Record<string, GrantReadLevel> = {};
  const raise = (id: string, level: GrantReadLevel): void => {
    readable.add(id);
    levels[id] = levels[id] === undefined ? level : maxLevel(levels[id], level);
  };

  for (const rule of profile.read) {
    const targets = selectTargets(rule.targets, index, order);
    for (const target of targets) raise(target, rule.targetLevel);
    const { level, ancestors: ancestorCount, descendants: descendantCount, directSiblings: withSiblings } = rule.context;
    for (const target of targets) {
      for (const id of ancestors(target, parents, ancestorCount)) raise(id, level);
      for (const id of descendants(target, index, descendantCount)) raise(id, level);
      if (withSiblings) {
        for (const id of directSiblings(target, parents, index)) raise(id, level);
      }
    }
  }

  // precedingFilled: the only content-state dynamic relation in v1. It expands
  // READ scope only and never the writable scope (design §10.5).
  if (
    options.capabilities.includes('read_slot_content') &&
    profile.continuity.precedingFilled &&
    options.writableSlotIds.length > 0
  ) {
    for (const target of options.writableSlotIds) {
      const targetPosition = order[target];
      if (targetPosition === undefined) continue;
      for (let i = 0; i < targetPosition; i += 1) {
        const candidate = index.documentOrder[i];
        if (options.contentPresence[candidate] === 'set') raise(candidate, 'content');
      }
    }
  }

  const readableSlotIds = index.documentOrder.filter((id) => readable.has(id));
  return { readableSlotIds, readLevels: levels };
}

/** Fully resolved authorization scope for one access profile (spec §8.3). */
export interface ResolvedAccessScopeV1 {
  writableSlotIds: readonly string[];
  readableSlotIds: readonly string[];
  readLevels: Readonly<Record<string, GrantReadLevel>>;
}

/**
 * Resolve the complete scope of an access profile against one generation.
 *
 * `writeMode: 'profile'` derives the writable scope from the profile's
 * writeContent rules (fill sessions); `writeMode: 'none'` always yields an
 * empty writable scope (seal sessions, design §10.3).
 */
export function resolveAccessScope(
  profile: AccessProfileV1,
  index: GenerationIndexV1,
  contentPresence: Readonly<Record<string, 'unset' | 'set'>>,
  capabilities: readonly SlotCapabilityV1[],
  writeMode: 'profile' | 'none' = 'profile',
): ResolvedAccessScopeV1 {
  const writableSlotIds = writeMode === 'profile' ? resolveWriteScope(profile, index) : [];
  const { readableSlotIds, readLevels } = resolveReadScope(profile, index, {
    writableSlotIds,
    contentPresence,
    capabilities,
  });
  return { writableSlotIds, readableSlotIds, readLevels };
}

/**
 * Grant service bound to one production case (task). Resolvers validate the
 * request identity against the bound task/snapshot and the session kind, then
 * return a typed result (never throw). `caseId` on the Grant is the Task id
 * (design §2.5 maps production case → Task).
 */
export class StructuredSlotGrantService {
  private readonly taskId: string;
  private readonly snapshotHash: string;
  private readonly contract: FrozenStructuredSlotContractV1;
  private readonly issueGrantId: () => string;

  constructor(options: GrantServiceOptions) {
    this.taskId = options.taskId;
    this.snapshotHash = options.snapshotHash;
    this.contract = options.contract;
    this.issueGrantId = options.issueGrantId ?? (() => randomUUID());
  }

  resolveStructureGrant(req: StructureGrantRequestV1): GrantResolutionResult<StructureSessionGrantV1> {
    const check = this.assertRequestBase(req, 'structure');
    if (!check.ok) return check;
    if (req.proposalId.length === 0) return fail('GRANT_INVALID', 'proposalId must be non-empty');
    const grant: StructureSessionGrantV1 = {
      grantId: req.grantId ?? this.issueGrantId(),
      kind: 'structure',
      caseId: this.taskId,
      turnId: req.turnId,
      agentId: req.agentId,
      snapshotHash: this.snapshotHash,
      capabilities: [...req.capabilities],
      proposalId: req.proposalId,
    };
    return { ok: true, grant };
  }

  resolveFillGrant(req: FillGrantRequestV1): GrantResolutionResult<FillSessionGrantV1> {
    const check = this.assertRequestBase(req, 'fill');
    if (!check.ok) return check;
    if (req.draftId.length === 0) return fail('GRANT_INVALID', 'draftId must be non-empty');
    const revisionCheck = this.assertActiveRevision(req.baseRevision, req.activeScaffold);
    if (!revisionCheck.ok) return revisionCheck;
    if (req.generationIndex.generationId !== req.activeScaffold.generationId) {
      return fail('GRANT_INVALID', 'generation index does not match the active scaffold generation');
    }
    const profile = this.findProfile(req.accessProfileId);
    if (profile === null) return fail('GRANT_INVALID', `unknown access profile '${req.accessProfileId}'`);
    const scope = resolveAccessScope(profile, req.generationIndex, req.contentPresence, req.capabilities, 'profile');
    const grant: FillSessionGrantV1 = {
      grantId: req.grantId ?? this.issueGrantId(),
      kind: 'fill',
      caseId: this.taskId,
      turnId: req.turnId,
      agentId: req.agentId,
      snapshotHash: this.snapshotHash,
      capabilities: [...req.capabilities],
      accessProfileId: req.accessProfileId,
      scaffoldId: req.activeScaffold.scaffoldId,
      baseRevision: req.baseRevision,
      readableSlotIds: [...scope.readableSlotIds],
      writableSlotIds: [...scope.writableSlotIds],
      draftId: req.draftId,
    };
    return { ok: true, grant };
  }

  resolveSealGrant(req: SealGrantRequestV1): GrantResolutionResult<SealSessionGrantV1> {
    const check = this.assertRequestBase(req, 'seal');
    if (!check.ok) return check;
    const revisionCheck = this.assertActiveRevision(req.baseRevision, req.activeScaffold);
    if (!revisionCheck.ok) return revisionCheck;
    if (req.generationIndex.generationId !== req.activeScaffold.generationId) {
      return fail('GRANT_INVALID', 'generation index does not match the active scaffold generation');
    }
    const profile = this.findProfile(req.accessProfileId);
    if (profile === null) return fail('GRANT_INVALID', `unknown access profile '${req.accessProfileId}'`);
    // Seal sessions have NO writable scope and no Draft (design §10.3); with an
    // empty write scope precedingFilled contributes nothing.
    const scope = resolveAccessScope(profile, req.generationIndex, {}, req.capabilities, 'none');
    const grant: SealSessionGrantV1 = {
      grantId: req.grantId ?? this.issueGrantId(),
      kind: 'seal',
      caseId: this.taskId,
      turnId: req.turnId,
      agentId: req.agentId,
      snapshotHash: this.snapshotHash,
      capabilities: [...req.capabilities],
      accessProfileId: req.accessProfileId,
      scaffoldId: req.activeScaffold.scaffoldId,
      baseRevision: req.baseRevision,
      readableSlotIds: [...scope.readableSlotIds],
      writableSlotIds: [],
      draftId: null,
    };
    return { ok: true, grant };
  }

  /**
   * Design D06 lifecycle check: a grant dies when its case/turn/agent/kind/
   * snapshot no longer match the current attempt, when the active scaffold
   * generation or content revision has moved on, or (fill) when the Draft
   * changed. The runtime re-validates before every slot tool use.
   */
  validateGrantForUse(grant: SlotSessionGrantV1, context: GrantUseContextV1): GrantValidationResult {
    if (grant.caseId !== context.taskId) return fail('GRANT_INVALID', 'grant is bound to a different task');
    if (grant.turnId !== context.turnId) return fail('GRANT_INVALID', 'grant is bound to a different attempt');
    if (grant.agentId !== context.agentId) return fail('GRANT_INVALID', 'grant is bound to a different agent');
    if (grant.kind !== context.sessionKind) {
      return fail('GRANT_INVALID', `grant kind '${grant.kind}' does not match session kind '${context.sessionKind}'`);
    }
    if (grant.snapshotHash !== context.snapshotHash) return fail('GRANT_INVALID', 'grant is bound to a different snapshot');
    if (grant.kind === 'structure') return { ok: true };

    const active = context.activeScaffold ?? null;
    if (active === null) return fail('GRANT_STALE', 'no active scaffold');
    if (grant.scaffoldId !== active.scaffoldId) return fail('GRANT_STALE', 'active scaffold generation changed');
    if (grant.baseRevision !== active.contentRevision) return fail('GRANT_STALE', 'grant base revision is stale');

    if (grant.kind === 'fill' && grant.draftId !== context.draftId) {
      return fail('GRANT_STALE', 'grant is bound to a different draft');
    }
    return { ok: true };
  }

  private assertRequestBase(req: GrantRequestBaseV1, expectedKind: SlotGrantKind): GrantValidationResult {
    if (req.sessionKind !== expectedKind) {
      return fail('GRANT_INVALID', `session kind '${req.sessionKind}' does not match a ${expectedKind} grant`);
    }
    if (req.taskId !== this.taskId) return fail('GRANT_INVALID', `task '${req.taskId}' does not match the service task`);
    if (req.snapshotHash !== this.snapshotHash) {
      return fail('GRANT_INVALID', 'snapshot hash does not match the frozen task snapshot');
    }
    if (req.turnId.length === 0 || req.agentId.length === 0) {
      return fail('GRANT_INVALID', 'turnId and agentId must be non-empty');
    }
    return { ok: true };
  }

  private assertActiveRevision(baseRevision: number, activeScaffold: ActiveScaffoldV1): GrantValidationResult {
    if (baseRevision !== activeScaffold.contentRevision) {
      return fail(
        'GRANT_STALE',
        `base revision ${baseRevision} no longer matches active content revision ${activeScaffold.contentRevision}`,
      );
    }
    return { ok: true };
  }

  private findProfile(id: string): AccessProfileV1 | null {
    return this.contract.accessProfiles.find((profile) => profile.id === id) ?? null;
  }
}
