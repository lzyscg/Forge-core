/**
 * Authorized slot projection service (Task 10, design §10.4-§10.6 + D04/D05,
 * spec §14).
 *
 * One projection service, discriminated by the calling subject:
 *
 * - `{ kind: 'agent', grant }` — the Agent sees EXACTLY its Grant projection:
 *   the union of the grant's readable + writable scope, every slot at its
 *   granted level (writable ⇒ content), ancestor outline shells for tree
 *   position, and the Draft overlay as the effective read value. Anything
 *   hidden or missing returns the IDENTICAL `SLOT_NOT_VISIBLE` (operation
 *   location, no slotId echo — D05). A mixed visible/hidden batch fails whole
 *   (zero rows). The grant is re-validated at the projection boundary: a dead
 *   or inconsistent grant is `GRANT_STALE` / `GRANT_INVALID`.
 * - `{ kind: 'task_owner' }` — the built-in local audit subject sees every
 *   formal slot/spec/content of the active scaffold, INDEPENDENT of template
 *   AccessProfiles and NEVER derived by unioning Agent profiles. It still
 *   never sees private Proposal/Draft/Grant or implementation resources.
 * - any other subject kind is rejected (`UNKNOWN_SUBJECT`).
 *
 * Pagination (`listSlots`) walks the visible outline in depth-first pre-order.
 * The cursor binds generation, content revision, the authorized projection
 * identity and the last emitted document-order key, signed with a task-local
 * in-memory secret (`createTaskLocalCursorSigner`) — the secret is never
 * written to a snapshot, event or blob, so a process restart invalidates held
 * cursors (fail closed). Pagination never reveals hidden slots or totals.
 *
 * This module carries zero business vocabulary.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  FillSessionGrantV1,
  JsonObject,
  JsonValue,
  ProjectionSubjectV1,
  SealSessionGrantV1,
  SlotCapabilityV1,
  StructuredIssueV1,
  StructuredSlotTreeCursorV1,
} from '../../../shared/structured-slots';
import type { FrozenStructuredSlotContractV1 } from '../../template/structured-slot-contract';
import type { GenerationIndexV1, SlotInstance } from '../../storage/structured-slot-blob-store';
import { canonicalJson, canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import { makeStructuredIssue } from '../../structured-slots/issues';
import {
  minGrantReadLevel,
  resolveAccessScope,
  slotParentMap,
  type GrantReadLevel,
  type ResolvedAccessScopeV1,
} from './grant-service';

/** Content ordering version bound by cursors (v1 = 1). */
const CURSOR_ORDERING_VERSION = 1 as const;

/** Draft content overlay: base scaffold + overlay = effective read value. */
export interface DraftContentOverlayV1 {
  [slotId: string]: { presence: 'unset' | 'set'; content?: JsonValue };
}

/**
 * Formal scaffold data the projection reads. Provided by the runtime from the
 * Task 7 blob store + event-derived state; tests inject an in-memory fake.
 */
export interface StructuredSlotDataSource {
  getActiveGeneration(): Promise<{ scaffoldId: string; generationId: string; contentRevision: number } | null>;
  getGenerationIndex(generationId: string): Promise<GenerationIndexV1>;
  getSlot(generationId: string, slotId: string): Promise<SlotInstance | null>;
  getContentPresence(generationId: string, revision: number): Promise<Readonly<Record<string, 'unset' | 'set'>>>;
}

/** HMAC signer over the canonical cursor payload (brief Step 5). */
export interface TaskLocalCursorSigner {
  sign(payload: string): string;
  verify(payload: string, signature: string): boolean;
}

/**
 * Task-local cursor signer. `secret` is a random per-task key held ONLY in
 * memory for the life of the task instance — it is never written to a
 * snapshot, event, blob or any persisted store (brief Step 5). A process
 * restart loses it, so cursors held by a model fail verification → the
 * runtime re-resolves grants and issues fresh cursors (fail closed).
 * `taskId` is required for domain separation/documentation; it is not part of
 * the key material.
 */
export function createTaskLocalCursorSigner(taskId: string, secret: Buffer = randomBytes(32)): TaskLocalCursorSigner {
  return {
    sign(payload: string): string {
      return createHmac('sha256', secret).update(payload).digest('hex');
    },
    verify(payload: string, signature: string): boolean {
      const expected = createHmac('sha256', secret).update(payload).digest();
      const provided = Buffer.from(signature, 'hex');
      if (provided.length !== expected.length) return false;
      return timingSafeEqual(expected, provided);
    },
  };
}

/** One row of the authorized slot outline (design D04 / §10.6). */
export interface SlotOutlineEntryV1 {
  slotId: string;
  typeId: string;
  contentPresence: 'unset' | 'set';
  /** Parent within the visible projection; ancestors are always present. */
  parentSlotId: string | null;
  /** True for an ancestor shell padded for tree position (outline only). */
  shell: boolean;
  /** Visibility level of this slot in the projection. */
  level: GrantReadLevel;
  /** Spec projection, present only when the entry's level allows spec. */
  spec?: JsonObject;
}

/** The authorized projection of one slot (design §10.6). */
export interface SlotReadProjectionV1 {
  slotId: string;
  typeId: string;
  contentPresence: 'unset' | 'set';
  level: GrantReadLevel;
  spec?: JsonObject;
  /** Effective value (base scaffold + Draft overlay) at content level. */
  content?: JsonValue;
  /** Ancestor outline shells preserving tree position (root first). */
  ancestors: Array<{ slotId: string; typeId: string; contentPresence: 'unset' | 'set' }>;
}

export type ProjectionErrorCode =
  | 'SLOT_NOT_VISIBLE'
  | 'CURSOR_INVALID'
  | 'GRANT_INVALID'
  | 'GRANT_STALE'
  | 'UNKNOWN_SUBJECT';

export interface ProjectionFailure {
  ok: false;
  code: ProjectionErrorCode;
  reason: string;
  /** Present for SLOT_NOT_VISIBLE: the exact, operation-located issue. */
  issue?: StructuredIssueV1;
}

export type SlotListResult =
  | { ok: true; entries: SlotOutlineEntryV1[]; nextCursor: StructuredSlotTreeCursorV1 | null }
  | ProjectionFailure;

export type SlotReadResult = { ok: true; slot: SlotReadProjectionV1 } | ProjectionFailure;

export type SlotBatchResult = { ok: true; slots: SlotReadProjectionV1[] } | ProjectionFailure;

interface CursorPayloadV1 {
  version: 1;
  generationId: string;
  revision: number;
  projectionHash: string;
  lastDocumentKey: string | null;
  orderingVersion: 1;
}

interface AgentProjectionView {
  subjectKind: 'agent';
  grant: FillSessionGrantV1 | SealSessionGrantV1;
  index: GenerationIndexV1;
  generationId: string;
  revision: number;
  scope: ResolvedAccessScopeV1;
  capabilities: readonly SlotCapabilityV1[];
  projectionHash: string;
}

interface OwnerProjectionView {
  subjectKind: 'owner';
  index: GenerationIndexV1 | null;
  generationId: string | null;
  revision: number | null;
  projectionHash: string;
}

type ProjectionView = AgentProjectionView | OwnerProjectionView;

function failure(code: ProjectionErrorCode, reason: string): ProjectionFailure {
  return { ok: false, code, reason };
}

/** D05: identical issue for exists-but-hidden and not-exists; no slotId echo. */
function notVisible(): ProjectionFailure {
  return {
    ok: false,
    code: 'SLOT_NOT_VISIBLE',
    reason: 'slot is not visible',
    issue: makeStructuredIssue('SLOT_NOT_VISIBLE', 'draft', { kind: 'operation' }, {}),
  };
}

function isView(value: ProjectionView | ProjectionFailure): value is ProjectionView {
  return (value as ProjectionFailure).ok !== false;
}

function capabilityReadLevel(capabilities: readonly SlotCapabilityV1[]): GrantReadLevel {
  if (capabilities.includes('read_slot_content')) return 'content';
  if (capabilities.includes('read_slot_spec')) return 'spec';
  return 'outline';
}

/** D04: writable slots see content; otherwise the profile's granted level. */
function effectiveLevel(slotId: string, scope: ResolvedAccessScopeV1, capabilities: readonly SlotCapabilityV1[]): GrantReadLevel {
  const base: GrantReadLevel = scope.writableSlotIds.includes(slotId) ? 'content' : (scope.readLevels[slotId] ?? 'outline');
  return minGrantReadLevel(base, capabilityReadLevel(capabilities));
}

function visibleSlotSet(scope: ResolvedAccessScopeV1 | null): Set<string> {
  const set = new Set<string>();
  if (scope !== null) {
    for (const id of scope.readableSlotIds) set.add(id);
    for (const id of scope.writableSlotIds) set.add(id);
  }
  return set;
}

/**
 * The outline set = the visible (authorized) slots plus their ancestor closure
 * up to root. Hidden siblings and hidden child counts never enter it (D04).
 */
function outlineSlotIds(index: GenerationIndexV1, visible: ReadonlySet<string>, allSlots: boolean): string[] {
  if (allSlots) return [...index.documentOrder];
  const parents = slotParentMap(index);
  const outline = new Set<string>(visible);
  for (const id of visible) {
    let current = parents[id];
    while (current !== undefined && current !== null) {
      outline.add(current);
      current = parents[current];
    }
  }
  return index.documentOrder.filter((id) => outline.has(id));
}

function sameSlotSets(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** The authorized projection identity bound into every agent cursor. */
function agentProjectionHash(grant: FillSessionGrantV1 | SealSessionGrantV1): string {
  return canonicalJsonSha256({
    subject: 'agent',
    kind: grant.kind,
    accessProfileId: grant.accessProfileId,
    scaffoldId: grant.scaffoldId,
    baseRevision: grant.baseRevision,
    draftId: grant.kind === 'fill' ? grant.draftId : null,
    capabilities: grant.capabilities,
    readableSlotIds: grant.readableSlotIds,
    writableSlotIds: grant.writableSlotIds,
  });
}

function ownerProjectionHash(): string {
  return canonicalJsonSha256({ subject: 'task_owner' });
}

/**
 * Authorized projection of the formal slot tree, keyed by the calling subject
 * (spec §14). Agent subjects use their Grant + the frozen AccessProfile;
 * `task_owner` uses the full formal audit view.
 */
export class StructuredSlotProjectionService {
  private readonly contract: FrozenStructuredSlotContractV1;
  private readonly source: StructuredSlotDataSource;
  private readonly signer: TaskLocalCursorSigner;

  constructor(options: {
    contract: FrozenStructuredSlotContractV1;
    source: StructuredSlotDataSource;
    signer: TaskLocalCursorSigner;
  }) {
    this.contract = options.contract;
    this.source = options.source;
    this.signer = options.signer;
  }

  /**
   * Paginated outline of the authorized slots in depth-first pre-order. The
   * cursor keeps the same generation, revision, projection and document order;
   * pagination never reveals hidden totals. An invalid cursor is a stable
   * CURSOR_INVALID.
   */
  async listSlots(
    subject: ProjectionSubjectV1,
    cursor: StructuredSlotTreeCursorV1 | null,
    limit: number,
  ): Promise<SlotListResult> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      return failure('CURSOR_INVALID', 'limit must be a positive safe integer');
    }
    const view = await this.resolveView(subject);
    if (!isView(view)) return view;
    if (view.subjectKind === 'owner' && view.index === null) {
      return { ok: true, entries: [], nextCursor: null };
    }
    const index: GenerationIndexV1 = view.index as GenerationIndexV1;
    if (cursor !== null) {
      const invalid = this.validateCursor(
        { generationId: view.generationId as string, revision: view.revision as number, projectionHash: view.projectionHash, index },
        cursor,
      );
      if (invalid !== null) return invalid;
    }

    const visible = view.subjectKind === 'agent' ? visibleSlotSet(view.scope) : null;
    const outline = outlineSlotIds(index, visible ?? new Set(), view.subjectKind === 'owner');

    let start = 0;
    if (cursor !== null && cursor.lastDocumentKey !== null) {
      const position = outline.indexOf(cursor.lastDocumentKey);
      if (position === -1) {
        return failure('CURSOR_INVALID', 'cursor does not belong to this projection');
      }
      start = position + 1;
    }

    const pageIds = outline.slice(start, start + limit);
    const entries: SlotOutlineEntryV1[] = [];
    for (const id of pageIds) {
      const slot = await this.source.getSlot(index.generationId, id);
      if (slot === null) {
        // The index references a slot the store cannot return: the scaffold is
        // inconsistent — fail closed instead of silently altering the page.
        throw new Error(`SLOT_MISSING_FROM_GENERATION: ${id}`);
      }
      const isVisible = view.subjectKind === 'owner' ? true : (visible as Set<string>).has(id);
      entries.push(this.buildOutlineEntry(slot, isVisible, view));
    }

    const hasMore = start + limit < outline.length;
    const nextCursor = hasMore
      ? this.signCursor(
          { generationId: view.generationId as string, revision: view.revision as number, projectionHash: view.projectionHash },
          pageIds[pageIds.length - 1] as string,
        )
      : null;
    return { ok: true, entries, nextCursor };
  }

  /**
   * The authorized projection of one slot at its granted level. Hidden and
   * missing slots return the IDENTICAL SLOT_NOT_VISIBLE (D05). A visible deep
   * node is padded with its ancestor outline shell (no spec/content/child
   * count, no hidden siblings — D04). `overlay` is the Draft overlay for the
   * effective read value (base + overlay).
   */
  async readSlot(
    subject: ProjectionSubjectV1,
    slotId: string,
    overlay?: DraftContentOverlayV1,
  ): Promise<SlotReadResult> {
    const view = await this.resolveView(subject);
    if (!isView(view)) return view;
    if (view.subjectKind === 'owner') {
      if (view.index === null) return notVisible();
      const slot = await this.source.getSlot(view.index.generationId, slotId);
      if (slot === null) return notVisible();
      const ancestors = await this.ancestorShells(view.index, slot);
      return { ok: true, slot: this.buildReadProjection(slot, 'content', ancestors, null) };
    }
    const visible = visibleSlotSet(view.scope);
    if (!visible.has(slotId)) return notVisible();
    const slot = await this.source.getSlot(view.index.generationId, slotId);
    if (slot === null) return notVisible();
    const level = effectiveLevel(slotId, view.scope, view.capabilities);
    const ancestors = await this.ancestorShells(view.index, slot);
    return { ok: true, slot: this.buildReadProjection(slot, level, ancestors, overlay ?? null) };
  }

  /**
   * Batch read with D05 all-or-nothing semantics: when ANY requested slot is
   * hidden or missing the whole batch fails with the single identical
   * SLOT_NOT_VISIBLE (zero rows — no partial enumeration of the boundary).
   */
  async readSlots(
    subject: ProjectionSubjectV1,
    slotIds: readonly string[],
    overlay?: DraftContentOverlayV1,
  ): Promise<SlotBatchResult> {
    const view = await this.resolveView(subject);
    if (!isView(view)) return view;
    if (view.subjectKind === 'owner') {
      if (view.index === null) return notVisible();
      const slots: SlotReadProjectionV1[] = [];
      for (const slotId of slotIds) {
        const slot = await this.source.getSlot(view.index.generationId, slotId);
        if (slot === null) return notVisible();
        slots.push(this.buildReadProjection(slot, 'content', await this.ancestorShells(view.index, slot), null));
      }
      return { ok: true, slots };
    }
    const visible = visibleSlotSet(view.scope);
    for (const slotId of slotIds) {
      if (!visible.has(slotId)) return notVisible();
    }
    const slots: SlotReadProjectionV1[] = [];
    for (const slotId of slotIds) {
      const slot = await this.source.getSlot(view.index.generationId, slotId);
      if (slot === null) return notVisible();
      const level = effectiveLevel(slotId, view.scope, view.capabilities);
      slots.push(this.buildReadProjection(slot, level, await this.ancestorShells(view.index, slot), overlay ?? null));
    }
    return { ok: true, slots };
  }

  private async resolveView(subject: ProjectionSubjectV1): Promise<ProjectionView | ProjectionFailure> {
    if (subject.kind === 'agent') {
      const grant = subject.grant;
      if (grant.kind === 'structure') {
        return failure('GRANT_INVALID', 'a structure grant has no slot projection');
      }
      const active = await this.source.getActiveGeneration();
      if (active === null) return failure('GRANT_STALE', 'no active scaffold');
      if (grant.scaffoldId !== active.scaffoldId) return failure('GRANT_STALE', 'active scaffold generation changed');
      if (grant.baseRevision !== active.contentRevision) return failure('GRANT_STALE', 'grant base revision is stale');
      const profile = this.contract.accessProfiles.find((p) => p.id === grant.accessProfileId) ?? null;
      if (profile === null) return failure('GRANT_INVALID', `unknown access profile '${grant.accessProfileId}'`);
      const index = await this.source.getGenerationIndex(active.generationId);
      const presence = await this.source.getContentPresence(active.generationId, grant.baseRevision);
      const writeMode = grant.kind === 'fill' ? 'profile' : 'none';
      const scope = resolveAccessScope(profile, index, presence, grant.capabilities, writeMode);
      if (
        !sameSlotSets(scope.readableSlotIds, grant.readableSlotIds) ||
        !sameSlotSets(scope.writableSlotIds, grant.writableSlotIds)
      ) {
        return failure('GRANT_INVALID', 'grant scope is inconsistent with the current scaffold');
      }
      return {
        subjectKind: 'agent',
        grant,
        index,
        generationId: active.generationId,
        revision: grant.baseRevision,
        scope,
        capabilities: grant.capabilities,
        projectionHash: agentProjectionHash(grant),
      };
    }
    if (subject.kind === 'task_owner') {
      const active = await this.source.getActiveGeneration();
      if (active === null) {
        return { subjectKind: 'owner', index: null, generationId: null, revision: null, projectionHash: ownerProjectionHash() };
      }
      const index = await this.source.getGenerationIndex(active.generationId);
      return {
        subjectKind: 'owner',
        index,
        generationId: active.generationId,
        revision: active.contentRevision,
        projectionHash: ownerProjectionHash(),
      };
    }
    // v1 principals are closed: agent | task_owner (spec §14 / O07). An unknown
    // kind is never granted owner visibility by inference.
    return failure('UNKNOWN_SUBJECT', `unknown subject kind '${String((subject as { kind?: unknown }).kind)}'`);
  }

  private buildOutlineEntry(slot: SlotInstance, isVisible: boolean, view: ProjectionView): SlotOutlineEntryV1 {
    const shell = !isVisible;
    const level: GrantReadLevel = shell
      ? 'outline'
      : view.subjectKind === 'owner'
        ? 'content'
        : effectiveLevel(slot.slotId, (view as AgentProjectionView).scope, (view as AgentProjectionView).capabilities);
    const entry: SlotOutlineEntryV1 = {
      slotId: slot.slotId,
      typeId: slot.typeId,
      contentPresence: slot.contentPresence,
      parentSlotId: slot.parentSlotId,
      shell,
      level,
    };
    if (!shell && level !== 'outline') entry.spec = slot.spec;
    return entry;
  }

  private buildReadProjection(
    slot: SlotInstance,
    level: GrantReadLevel,
    ancestors: Array<{ slotId: string; typeId: string; contentPresence: 'unset' | 'set' }>,
    overlay: DraftContentOverlayV1 | null,
  ): SlotReadProjectionV1 {
    const effectivePresence = overlay?.[slot.slotId]?.presence ?? slot.contentPresence;
    const projection: SlotReadProjectionV1 = {
      slotId: slot.slotId,
      typeId: slot.typeId,
      contentPresence: effectivePresence,
      level,
      ancestors,
    };
    if (level !== 'outline') projection.spec = slot.spec;
    if (level === 'content') {
      if (overlay?.[slot.slotId] !== undefined) {
        const entry = overlay[slot.slotId];
        if (entry.presence === 'set') projection.content = entry.content;
      } else if (slot.contentPresence === 'set') {
        projection.content = slot.content;
      }
    }
    return projection;
  }

  /** Root-first ancestor chain up to the slot's parent (design D04 shell). */
  private async ancestorShells(
    index: GenerationIndexV1,
    slot: SlotInstance,
  ): Promise<Array<{ slotId: string; typeId: string; contentPresence: 'unset' | 'set' }>> {
    const parents = slotParentMap(index);
    const chain: SlotInstance[] = [];
    let current = slot.parentSlotId;
    while (current !== null && current !== undefined) {
      const ancestor = await this.source.getSlot(index.generationId, current);
      if (ancestor === null) break;
      chain.push(ancestor);
      current = parents[current];
    }
    const shells: Array<{ slotId: string; typeId: string; contentPresence: 'unset' | 'set' }> = [];
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const ancestor = chain[i];
      shells.push({ slotId: ancestor.slotId, typeId: ancestor.typeId, contentPresence: ancestor.contentPresence });
    }
    return shells;
  }

  private validateCursor(
    view: { generationId: string; revision: number; projectionHash: string; index: GenerationIndexV1 },
    cursor: StructuredSlotTreeCursorV1,
  ): ProjectionFailure | null {
    if (cursor.version !== 1 || cursor.orderingVersion !== CURSOR_ORDERING_VERSION) {
      return failure('CURSOR_INVALID', 'unsupported cursor version');
    }
    if (cursor.generationId !== view.generationId) return failure('CURSOR_INVALID', 'cursor is bound to a different generation');
    if (cursor.revision !== view.revision) return failure('CURSOR_INVALID', 'cursor is bound to a different revision');
    if (cursor.projectionHash !== view.projectionHash) return failure('CURSOR_INVALID', 'cursor is bound to a different projection');
    if (cursor.lastDocumentKey !== null && !(cursor.lastDocumentKey in view.index.slots)) {
      return failure('CURSOR_INVALID', 'cursor references an unknown document position');
    }
    const payload = this.cursorPayload(view, cursor.lastDocumentKey);
    if (!this.signer.verify(canonicalJson(payload), cursor.signature)) {
      return failure('CURSOR_INVALID', 'cursor signature is invalid');
    }
    return null;
  }

  private signCursor(
    view: { generationId: string; revision: number; projectionHash: string },
    lastDocumentKey: string,
  ): StructuredSlotTreeCursorV1 {
    const payload = this.cursorPayload(view, lastDocumentKey);
    return { ...payload, signature: this.signer.sign(canonicalJson(payload)) };
  }

  private cursorPayload(
    view: { generationId: string; revision: number; projectionHash: string },
    lastDocumentKey: string | null,
  ): CursorPayloadV1 {
    return {
      version: 1,
      generationId: view.generationId,
      revision: view.revision,
      projectionHash: view.projectionHash,
      lastDocumentKey,
      orderingVersion: CURSOR_ORDERING_VERSION,
    };
  }
}
