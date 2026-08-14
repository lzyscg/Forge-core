/**
 * Task 13 authoritative-review-private-store (design §12.4/§19.1, spec §7.4/
 * §11.3): attempt-bound private draft/staging journals for the authoritative
 * review lifecycle v2.
 *
 * Boundary (per §18 precedent `structured-slot-private-store.ts`): everything
 * under `structured-slots/v2/private/` is PRIVATE. It is never a registered
 * blob kind, never publicly visible by directory scan, never a GC root, and
 * never a fact source. Only `complete_review_assignment` (through the tool
 * factory) FREEZES the journal's ReviewFacts / FindingVerificationRecords into
 * one AssignmentLedgerBlob and publishes it atomically — a draft journal never
 * participates in a Gate.
 *
 * Attempt binding (§12.4 fail-closed "整 attempt 废弃" semantics): a review
 * journal is bound EXACTLY to `workItemId + leaseEpoch + attemptId +
 * authorityBaseRef`. The journal path embeds workItemId + attemptId (a NEW
 * attempt physically cannot address the OLD journal), and every open/append
 * additionally re-validates the stored binding header. Reclaim/crash/timeout
 * terminalizes the old attempt → the old journal is abandoned and never
 * readable/writable by the new attempt; the new attempt must redo the whole
 * assignment. `clientOperationId` idempotency (§11): same operation + same
 * canonical body replays the prior result; same operation + different body
 * conflicts with zero writes.
 *
 * Repair staging is plan/revision/ordinal scoped:
 * `private/repair/<planRevisionId>/<batchOrdinal>/journal.ndjson`. It is bound
 * to the same attempt identity AND the immutable `planRevisionId + batchOrdinal`
 * (design §10.2/§13): a later revision or ordinal cannot append to an earlier
 * batch's journal.
 *
 * V1 byte-for-byte: this is a NEW module; v1 journals/tools are untouched.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CorePaths } from './core-paths';
import { STORAGE_ERROR_CODES, StorageError } from './atomic-file';
import { canonicalJson, canonicalJsonBytes, canonicalJsonSha256 } from '../structured-slots/canonical-json';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';

/** Stable private-store error codes. */
export type PrivateStoreErrorCodeV2 =
  | 'PRIVATE_DRAFT_BOUND_TO_OTHER_ATTEMPT'
  | 'PRIVATE_DRAFT_ABANDONED'
  | 'PRIVATE_DRAFT_REJECTED'
  | 'OPERATION_CONFLICT'
  | 'REPLAYED'
  | 'TASK_CORRUPTED'
  | 'INVALID_INPUT';

export class PrivateStoreError extends Error {
  readonly code: PrivateStoreErrorCodeV2;

  constructor(code: PrivateStoreErrorCodeV2, message: string) {
    super(message);
    this.name = 'PrivateStoreError';
    this.code = code;
  }
}

/** The exact attempt binding of one private review journal (design §12.4). */
export interface ReviewDraftBindingV2 {
  workItemId: string;
  leaseEpoch: number;
  attemptId: string;
  authorityBaseRef: BlobRefV2;
  grantSpecRef: BlobRefV2;
}

/** The exact scope of one repair-staging journal (design §10.2/§13). */
export interface RepairStagingBindingV2 extends ReviewDraftBindingV2 {
  planRevisionId: string;
  batchOrdinal: number;
}

/** A durable private journal entry (one tool submission, canonical body). */
export interface PrivateDraftEntryV2 {
  seq: number;
  at: string;
  clientOperationId: string;
  /** SHA-256 over canonicalJson(body) — the §11 idempotency body identity. */
  bodyDigest: string;
  op: string;
  body: Record<string, unknown>;
  result: unknown;
}

export interface ReviewDraftViewV2 {
  binding: ReviewDraftBindingV2;
  /** Durable committed entries, paged by the caller (never a full-tree read). */
  committed: readonly PrivateDraftEntryV2[];
  /** True once complete_review_assignment froze the ledger for this attempt. */
  complete: boolean;
  seq: number;
}

export interface RepairStagingViewV2 {
  binding: RepairStagingBindingV2;
  committed: readonly PrivateDraftEntryV2[];
  seq: number;
}

export type AppendOutcomeV2 =
  | { status: 'committed'; entry: PrivateDraftEntryV2 }
  | { status: 'replayed'; entry: PrivateDraftEntryV2 };

/** Paging request for the private read API (bounded — never unbounded reads). */
export interface PrivatePageV2 {
  /** 1-based sequence cursor; undefined starts at the first committed entry. */
  afterSeq?: number;
  limit: number;
}

function invalidInput(message: string): PrivateStoreError {
  return new PrivateStoreError(STORAGE_ERROR_CODES.INVALID_INPUT as PrivateStoreErrorCodeV2, message);
}

/** Exact five-key BlobRef equality (spec §7.1) — local, storage-agnostic. */
function sameRef(a: BlobRefV2, b: BlobRefV2): boolean {
  return (
    a.kind === b.kind &&
    a.digest === b.digest &&
    a.byteLength === b.byteLength &&
    a.mediaType === b.mediaType &&
    a.schemaVersion === b.schemaVersion
  );
}

function corrupt(message: string): PrivateStoreError {
  return new PrivateStoreError('TASK_CORRUPTED', message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function now(): string {
  return new Date().toISOString();
}

function assertBindingShape(binding: unknown, where: string): void {
  if (!isPlainObject(binding)) throw invalidInput(`${where} 必须是绑定对象。`);
  const b = binding as Record<string, unknown>;
  if (typeof b.workItemId !== 'string' || b.workItemId.length === 0) throw invalidInput(`${where}.workItemId 必须是非空字符串。`);
  if (typeof b.attemptId !== 'string' || b.attemptId.length === 0) throw invalidInput(`${where}.attemptId 必须是非空字符串。`);
  if (typeof b.leaseEpoch !== 'number' || !Number.isInteger(b.leaseEpoch) || b.leaseEpoch < 0) {
    throw invalidInput(`${where}.leaseEpoch 必须是非负整数。`);
  }
  if (!isPlainObject(b.authorityBaseRef)) throw invalidInput(`${where}.authorityBaseRef 必须是 BlobRef。`);
  if (!isPlainObject(b.grantSpecRef)) throw invalidInput(`${where}.grantSpecRef 必须是 BlobRef。`);
}

interface BindingHeaderV1 {
  version: 1;
  kind: 'review' | 'repair';
  binding: Record<string, unknown>;
}

export class AuthoritativeReviewPrivateStore {
  private readonly paths: CorePaths;

  private readonly taskId: string;

  constructor(paths: CorePaths, taskId: string) {
    this.paths = paths;
    this.taskId = taskId;
  }

  /* ------------------------------------------------------------ review */

  /**
   * Opens the attempt-bound review draft journal idempotently (get-or-create).
   * A journal bound to a DIFFERENT attempt is rejected — the new attempt must
   * redo the whole assignment (§12.4). Same attempt + same call resumes.
   */
  async openReviewDraft(binding: ReviewDraftBindingV2): Promise<ReviewDraftViewV2> {
    assertBindingShape(binding, 'binding');
    const file = this.reviewFile(binding.workItemId, binding.attemptId);
    const headerFile = this.reviewHeaderFile(binding.workItemId, binding.attemptId);
    await this.assertHeaderOrCreate(headerFile, 'review', binding);
    const committed = await this.readEntries(file);
    const completeMarker = await this.readCompleteMarker(binding.workItemId, binding.attemptId);
    return this.reviewView(binding, committed, completeMarker);
  }

  /**
   * Appends one private review-draft entry. Validates the exact binding against
   * the stored header, then the §11 idempotency rule (same clientOperationId +
   * same canonical body replays; same id + different body conflicts). The grant/
   * attempt/base CURRENT check is the tool factory's job (it reprojects before
   * calling); THIS layer proves the journal belongs to the attempt.
   */
  async appendReviewDraft(
    binding: ReviewDraftBindingV2,
    entry: {
      clientOperationId: string;
      op: string;
      body: Record<string, unknown>;
      result: unknown;
    },
  ): Promise<AppendOutcomeV2> {
    assertBindingShape(binding, 'binding');
    if (typeof entry.clientOperationId !== 'string' || entry.clientOperationId.length === 0) {
      throw invalidInput('clientOperationId 必须是非空字符串。');
    }
    const file = this.reviewFile(binding.workItemId, binding.attemptId);
    const headerFile = this.reviewHeaderFile(binding.workItemId, binding.attemptId);
    await this.assertHeaderOrCreate(headerFile, 'review', binding);
    const bodyDigest = canonicalJsonSha256(entry.body);
    const committed = await this.readEntries(file);
    const replay = classifyPrivateReplay(entry.clientOperationId, bodyDigest, committed);
    if (replay === 'conflict') {
      throw new PrivateStoreError('OPERATION_CONFLICT', `clientOperationId '${entry.clientOperationId}' committed a different body`);
    }
    if (replay === 'replay') {
      // M-1: return the entry matching clientOperationId (never the last one —
      // a concurrent same-op append between the tool's read and this append
      // must not surface the wrong result).
      const matched = committed.find((e) => e.clientOperationId === entry.clientOperationId) as PrivateDraftEntryV2;
      return { status: 'replayed', entry: matched };
    }
    const nextSeq = committed.length > 0 ? committed[committed.length - 1].seq + 1 : 1;
    const full: PrivateDraftEntryV2 = {
      seq: nextSeq,
      at: now(),
      clientOperationId: entry.clientOperationId,
      bodyDigest,
      op: entry.op,
      body: entry.body,
      result: entry.result,
    };
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${canonicalJson(full)}\n`, 'utf8');
    return { status: 'committed', entry: full };
  }

  /** Marks the attempt's review journal complete (post-freeze; idempotent). */
  async markReviewDraftComplete(binding: ReviewDraftBindingV2, complete: boolean): Promise<void> {
    assertBindingShape(binding, 'binding');
    const markerFile = this.reviewCompleteMarkerFile(binding.workItemId, binding.attemptId);
    if (complete) {
      await mkdir(dirname(markerFile), { recursive: true });
      await writeFile(markerFile, canonicalJson({ version: 1, complete: true }), 'utf8');
    } else {
      await writeFile(markerFile, canonicalJson({ version: 1, complete: false }), 'utf8');
    }
  }

  /**
   * Pages COMMITTED review-draft entries only (bounded — `limit` is required).
   * Never a full-tree read; the caller supplies the profile-bounded limit.
   */
  async readReviewDraft(
    binding: ReviewDraftBindingV2,
    page: PrivatePageV2,
  ): Promise<ReviewDraftViewV2> {
    assertBindingShape(binding, 'binding');
    if (!Number.isInteger(page.limit) || page.limit < 1) throw invalidInput('page.limit 必须 >= 1。');
    const file = this.reviewFile(binding.workItemId, binding.attemptId);
    const headerFile = this.reviewHeaderFile(binding.workItemId, binding.attemptId);
    const header = await this.readHeader(headerFile);
    if (header === null) return { binding, committed: [], complete: false, seq: 0 };
    this.assertHeaderMatches(header, 'review', binding);
    const committed = await this.readEntries(file);
    const after = page.afterSeq ?? 0;
    const paged = committed.filter((e) => e.seq > after).slice(0, page.limit);
    const completeMarker = await this.readCompleteMarker(binding.workItemId, binding.attemptId);
    return this.reviewView(binding, paged, completeMarker);
  }

  /** The FULL committed review journal (completion freeze reads everything). */
  async readAllReviewDraft(binding: ReviewDraftBindingV2): Promise<ReviewDraftViewV2> {
    assertBindingShape(binding, 'binding');
    const file = this.reviewFile(binding.workItemId, binding.attemptId);
    const headerFile = this.reviewHeaderFile(binding.workItemId, binding.attemptId);
    const header = await this.readHeader(headerFile);
    if (header === null) return { binding, committed: [], complete: false, seq: 0 };
    this.assertHeaderMatches(header, 'review', binding);
    const committed = await this.readEntries(file);
    const completeMarker = await this.readCompleteMarker(binding.workItemId, binding.attemptId);
    return this.reviewView(binding, committed, completeMarker);
  }

  /* ------------------------------------------------------------ repair */

  /** Opens the plan/revision/ordinal-scoped repair-staging journal (idempotent). */
  async openRepairStaging(binding: RepairStagingBindingV2): Promise<RepairStagingViewV2> {
    assertBindingShape(binding, 'binding');
    if (typeof binding.planRevisionId !== 'string' || binding.planRevisionId.length === 0) {
      throw invalidInput('binding.planRevisionId 必须是非空字符串。');
    }
    if (typeof binding.batchOrdinal !== 'number' || !Number.isInteger(binding.batchOrdinal) || binding.batchOrdinal < 0) {
      throw invalidInput('binding.batchOrdinal 必须是非负整数。');
    }
    const file = this.repairFile(binding.planRevisionId, binding.batchOrdinal);
    const headerFile = this.repairHeaderFile(binding.planRevisionId, binding.batchOrdinal);
    await this.assertHeaderOrCreate(headerFile, 'repair', binding);
    const committed = await this.readEntries(file);
    return { binding, committed, seq: committed.length > 0 ? committed[committed.length - 1].seq : 0 };
  }

  /** Appends one repair-staging entry (idempotency identical to review). */
  async appendRepairStaging(
    binding: RepairStagingBindingV2,
    entry: {
      clientOperationId: string;
      op: string;
      body: Record<string, unknown>;
      result: unknown;
    },
  ): Promise<AppendOutcomeV2> {
    assertBindingShape(binding, 'binding');
    if (typeof binding.planRevisionId !== 'string' || binding.planRevisionId.length === 0) {
      throw invalidInput('binding.planRevisionId 必须是非空字符串。');
    }
    if (typeof binding.batchOrdinal !== 'number' || !Number.isInteger(binding.batchOrdinal) || binding.batchOrdinal < 0) {
      throw invalidInput('binding.batchOrdinal 必须是非负整数。');
    }
    if (typeof entry.clientOperationId !== 'string' || entry.clientOperationId.length === 0) {
      throw invalidInput('clientOperationId 必须是非空字符串。');
    }
    const file = this.repairFile(binding.planRevisionId, binding.batchOrdinal);
    const headerFile = this.repairHeaderFile(binding.planRevisionId, binding.batchOrdinal);
    await this.assertHeaderOrCreate(headerFile, 'repair', binding);
    const bodyDigest = canonicalJsonSha256(entry.body);
    const committed = await this.readEntries(file);
    const replay = classifyPrivateReplay(entry.clientOperationId, bodyDigest, committed);
    if (replay === 'conflict') {
      throw new PrivateStoreError('OPERATION_CONFLICT', `clientOperationId '${entry.clientOperationId}' committed a different body`);
    }
    if (replay === 'replay') {
      // M-1: return the entry matching clientOperationId (never the last one —
      // a concurrent same-op append between the tool's read and this append
      // must not surface the wrong result).
      const matched = committed.find((e) => e.clientOperationId === entry.clientOperationId) as PrivateDraftEntryV2;
      return { status: 'replayed', entry: matched };
    }
    const nextSeq = committed.length > 0 ? committed[committed.length - 1].seq + 1 : 1;
    const full: PrivateDraftEntryV2 = {
      seq: nextSeq,
      at: now(),
      clientOperationId: entry.clientOperationId,
      bodyDigest,
      op: entry.op,
      body: entry.body,
      result: entry.result,
    };
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${canonicalJson(full)}\n`, 'utf8');
    return { status: 'committed', entry: full };
  }

  /* ------------------------------------------------------------ internal */

  private async assertHeaderOrCreate(
    headerFile: string,
    kind: 'review' | 'repair',
    binding: unknown,
  ): Promise<void> {
    const header = await this.readHeader(headerFile);
    if (header === null) {
      const h: BindingHeaderV1 = { version: 1, kind, binding: binding as Record<string, unknown> };
      await mkdir(dirname(headerFile), { recursive: true });
      await writeFile(headerFile, canonicalJson(h), 'utf8');
      return;
    }
    this.assertHeaderMatches(header, kind, binding);
  }

  private assertHeaderMatches(header: BindingHeaderV1, kind: 'review' | 'repair', binding: unknown): void {
    if (header.kind !== kind) {
      throw new PrivateStoreError('PRIVATE_DRAFT_REJECTED', `private journal kind is '${header.kind}', not '${kind}'`);
    }
    const bound = header.binding as Record<string, unknown>;
    const b = binding as Record<string, unknown>;
    if (bound.workItemId !== b.workItemId) {
      throw new PrivateStoreError('PRIVATE_DRAFT_BOUND_TO_OTHER_ATTEMPT', `journal bound to workitem '${bound.workItemId}', not '${b.workItemId}'`);
    }
    if (bound.attemptId !== b.attemptId) {
      throw new PrivateStoreError('PRIVATE_DRAFT_ABANDONED', `journal bound to abandoned attempt '${bound.attemptId}', not '${b.attemptId}'`);
    }
    if (bound.leaseEpoch !== b.leaseEpoch) {
      throw new PrivateStoreError('PRIVATE_DRAFT_ABANDONED', `journal bound to lease epoch ${bound.leaseEpoch}, not ${b.leaseEpoch}`);
    }
    const boundBase = bound.authorityBaseRef as BlobRefV2;
    const boundGrant = bound.grantSpecRef as BlobRefV2;
    const inBase = b.authorityBaseRef as BlobRefV2;
    const inGrant = b.grantSpecRef as BlobRefV2;
    if (!sameRef(boundBase, inBase)) {
      throw new PrivateStoreError('PRIVATE_DRAFT_BOUND_TO_OTHER_ATTEMPT', 'journal bound to a different authorityBaseRef');
    }
    if (!sameRef(boundGrant, inGrant)) {
      throw new PrivateStoreError('PRIVATE_DRAFT_BOUND_TO_OTHER_ATTEMPT', 'journal bound to a different grantSpecRef');
    }
    if (kind === 'repair') {
      if (bound.planRevisionId !== b.planRevisionId) {
        throw new PrivateStoreError('PRIVATE_DRAFT_BOUND_TO_OTHER_ATTEMPT', `journal bound to planRevision '${bound.planRevisionId}', not '${b.planRevisionId}'`);
      }
      if (bound.batchOrdinal !== b.batchOrdinal) {
        throw new PrivateStoreError('PRIVATE_DRAFT_BOUND_TO_OTHER_ATTEMPT', `journal bound to ordinal ${bound.batchOrdinal}, not ${b.batchOrdinal}`);
      }
    }
  }

  private async readHeader(headerFile: string): Promise<BindingHeaderV1 | null> {
    let raw: string;
    try {
      raw = await readFile(headerFile, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isPlainObject(parsed) || (parsed as { version?: unknown }).version !== 1) {
        throw corrupt('private binding header 版本无效。');
      }
      return parsed as unknown as BindingHeaderV1;
    } catch (error) {
      if (error instanceof PrivateStoreError) throw error;
      throw corrupt('private binding header 不是有效 JSON。');
    }
  }

  private async readEntries(file: string): Promise<PrivateDraftEntryV2[]> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return [];
    }
    const lines = raw.split('\n');
    const entries: PrivateDraftEntryV2[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line === '') continue;
      let entry: PrivateDraftEntryV2;
      try {
        entry = JSON.parse(line) as PrivateDraftEntryV2;
      } catch {
        if (i === lines.length - 1) continue; // torn tail = crash residue
        throw corrupt('private journal 含损坏记录。');
      }
      if (!isPlainObject(entry) || typeof entry.seq !== 'number' || !Number.isInteger(entry.seq) || entry.seq < 1) {
        throw corrupt('private journal 记录缺少有效 seq。');
      }
      entries.push(entry);
    }
    return entries;
  }

  private async readCompleteMarker(workItemId: string, attemptId: string): Promise<boolean> {
    try {
      const raw = await readFile(this.reviewCompleteMarkerFile(workItemId, attemptId), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return isPlainObject(parsed) && (parsed as { complete?: unknown }).complete === true;
    } catch {
      return false;
    }
  }

  private reviewView(
    binding: ReviewDraftBindingV2,
    committed: readonly PrivateDraftEntryV2[],
    complete: boolean,
  ): ReviewDraftViewV2 {
    return {
      binding,
      committed,
      complete,
      seq: committed.length > 0 ? committed[committed.length - 1].seq : 0,
    };
  }

  /* ------------------------------------------------------------ paths */

  private reviewRoot(workItemId: string, attemptId: string): string {
    return join(this.paths.taskStructuredV2PrivateRoot(this.taskId), 'review', workItemId, attemptId);
  }

  private reviewFile(workItemId: string, attemptId: string): string {
    return this.paths.taskV2ReviewDraftJournalFile(this.taskId, workItemId, attemptId);
  }

  private reviewHeaderFile(workItemId: string, attemptId: string): string {
    return join(this.reviewRoot(workItemId, attemptId), 'binding.json');
  }

  private reviewCompleteMarkerFile(workItemId: string, attemptId: string): string {
    return join(this.reviewRoot(workItemId, attemptId), 'complete.json');
  }

  private repairFile(planRevisionId: string, batchOrdinal: number): string {
    return this.paths.taskV2RepairStagingJournalFile(this.taskId, planRevisionId, batchOrdinal);
  }

  private repairHeaderFile(planRevisionId: string, batchOrdinal: number): string {
    return join(dirname(this.repairFile(planRevisionId, batchOrdinal)), 'binding.json');
  }
}

/** §11 idempotency classification over the durable committed entries. */
export function classifyPrivateReplay(
  clientOperationId: string,
  bodyDigest: string,
  committed: readonly PrivateDraftEntryV2[],
): 'new' | 'replay' | 'conflict' {
  let matched: PrivateDraftEntryV2 | null = null;
  for (const entry of committed) {
    if (entry.clientOperationId === clientOperationId) {
      matched = entry;
      break;
    }
  }
  if (matched === null) return 'new';
  if (matched.bodyDigest === bodyDigest) return 'replay';
  return 'conflict';
}
