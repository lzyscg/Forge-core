/**
 * Task 23: owner read-only projection model of the authoritative per-slot
 * review v2 (spec §14.1/§14.2, design §19.2/§20).
 *
 * This service assembles the 11 read-only endpoints from the EVENT-DERIVED
 * projection (`AuthoritativeReviewProjectionV2` via the checkpoint store) plus
 * resolved canonical blobs. It never reads the EventStore directly and never
 * imports it: every read goes through `readSnapshot` (checkpoint store) and
 * `resolveBlob` (blob store).
 *
 * Snapshot semantics (§14.2):
 * - The FIRST collection request fixes `throughSequence`, the projection
 *   schema version, the authority baseline digest, the filters digest and the
 *   deterministic sort; the response carries an authenticated opaque cursor
 *   with a key id signed by the installation-persistent cursor keyring.
 * - LATER pages replay the projection AT the fixed throughSequence, so
 *   concurrent event appends never change an in-flight traversal. A fresh
 *   first page sees the new tail.
 * - `CURSOR_STALE` is raised ONLY for retention/key retirement, changed query
 *   identity (route/filters/sort/baseline/schema), or corruption (tamper /
 *   unverifiable token / missing last key). Never for a live snapshot.
 *
 * The tree is a NON-RECURSIVE parent page: each page lists the children of
 * one parent with child counts and `hasMoreChildren`; `tree/locate` returns
 * the ancestor path with a seek cursor per level so deep targets (beyond any
 * 1,000-entry cap) are reached without walking earlier pages.
 *
 * All responses are public DTOs: refs are `BlobRefV2`, digests are display
 * aliases, and private Grant/receipt/authority internals never leave.
 */
import type { AuthoritativeBlobKindV2, BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type {
  AuthoritativeCandidateDetailV2,
  AuthoritativeContentReviewStateV2,
  AuthoritativeFindingSummaryV2,
  AuthoritativeLocateResultV2,
  AuthoritativeMapDetailV2,
  AuthoritativeMapPreReviewStateV2,
  AuthoritativeRelationReviewDetailV2,
  AuthoritativeRelationReviewStateV2,
  AuthoritativeReviewRoundSummaryV2,
  AuthoritativeReviewSummaryV2,
  AuthoritativeSealReadinessConditionV2,
  AuthoritativeSealReadinessDetailV2,
  AuthoritativeSlotReviewDetailV2,
  AuthoritativeTreeEntryV2,
  AuthoritativeTreePageV2,
  CollectionPageV2,
  SnapshotCursorV2,
} from '../../../shared/authoritative-review-v2';
import type { StructuredIssueV1 } from '../../../shared/structured-slots';
import { canonicalJson, canonicalJsonSha256 } from '../../structured-slots/canonical-json';
import type { ReviewCursorKeyring, CursorVerifyOutcome } from '../../storage/review-cursor-keyring';
import { CURSOR_STALE_EXPIRED, CURSOR_STALE_UNKNOWN_KEY } from '../../storage/review-cursor-keyring';
import type { AuthoritativeReviewProjectionV2 } from '../../storage/authoritative-review-state';
import { ProjectionCorruptionError } from '../../storage/authoritative-review-state';
import { parseBlob } from '../../authoritative-review/object-registry';
import { sealConditionCodes } from '../../authoritative-review/seal-gate';
import type { MapSnapshotV2 } from '../../authoritative-review/authority-types';

/** Stable diagnostics for the read API (spec §14.2) — never internals. */
export const CURSOR_STALE_REASON_SIGNING_KEY_RETIRED = 'signing_key_retired';
export const CURSOR_STALE_REASON_TAMPERED = 'tampered_or_corrupt';
export const CURSOR_STALE_REASON_QUERY_IDENTITY = 'query_identity_changed';
export const CURSOR_STALE_REASON_UNKNOWN_KEY = 'signing_key_retired';

/** Default page size and its hard profile cap (spec §14.2). */
export const V2_READ_DEFAULT_LIMIT = 50;
export const V2_READ_MAX_LIMIT = 500;

/** Frozen projection schema identity bound into every cursor (spec §14.2). */
export const V2_READ_SCHEMA_VERSION = 'authoritative-review-read/v2';

export type V2CollectionRoute = 'tree' | 'map-rounds' | 'rounds' | 'findings';

/** Stable read failure surfaced by the router through the public map. */
export class AuthoritativeReviewReadError extends Error {
  readonly code: 'AUTHORITATIVE_REVIEW_UNAVAILABLE' | 'CURSOR_STALE' | 'SLOT_NOT_VISIBLE' | 'TASK_CORRUPTED';

  readonly location: string | null;

  readonly action: string | null;

  constructor(
    code: AuthoritativeReviewReadError['code'],
    message: string,
    location: string | null = null,
    action: string | null = null,
  ) {
    super(message);
    this.name = 'AuthoritativeReviewReadError';
    this.code = code;
    this.location = location;
    this.action = action;
  }
}

/** A frozen projection snapshot (either the current tail or a replayed sequence). */
export interface AuthoritativeProjectionSnapshotV2 {
  throughSequence: number;
  projection: AuthoritativeReviewProjectionV2;
}

/** The dependency surface the projection service reads through. */
export interface AuthoritativeProjectionServiceDepsV2 {
  /** Reads the projection at the current tail, or replayed at a fixed sequence. */
  readSnapshot(taskId: string, throughSequence?: number): Promise<AuthoritativeProjectionSnapshotV2>;
  /** Resolves one canonical blob; missing/mismatched blobs fail closed. */
  resolveBlob<T>(taskId: string, ref: BlobRefV2, kind: AuthoritativeBlobKindV2): Promise<T>;
  /** The installation-persistent cursor keyring (spec §14.2). */
  keyring: ReviewCursorKeyring;
  defaultLimit?: number;
  maxLimit?: number;
}

/** The signed token content of a SnapshotCursorV2 (opaque to the client). */
interface SnapshotCursorTokenV2 {
  payload: SnapshotCursorPayloadV2;
  signature: string;
}

/** The full identity a collection page binds (spec §14.2). */
interface SnapshotCursorPayloadV2 {
  version: 2;
  taskId: string;
  route: V2CollectionRoute;
  throughSequence: number;
  schemaVersion: string;
  baselineDigest: string;
  filtersDigest: string;
  sort: string;
  lastKey: string | null;
  keyId: string;
}

interface OrderedPageItem<T> {
  key: string;
  item: T;
}

/** Sort key of a tree child (parent/siblingOrder/slotId; §14.2). */
function treeChildKey(siblingOrder: number, slotId: string): string {
  return `${String(siblingOrder).padStart(20, '0')}:${slotId}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The authority baseline the read surface binds (spec §14.2 "authority baseline refs"). */
function baselineDigestOf(projection: AuthoritativeReviewProjectionV2): string {
  return canonicalJsonSha256({
    mapSnapshotRef: projection.currentMap?.mapSnapshotRef ?? null,
    mapReviewBundleRef: projection.currentMap?.mapReviewBundleRef ?? null,
    contentRevisionManifestRef: projection.currentManifest?.contentRevisionManifestRef ?? null,
    sealRecordRef: projection.currentSeal?.sealRecordRef ?? null,
  });
}

function parseToken(token: string): SnapshotCursorTokenV2 | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!isPlainObject(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isPlainObject(record.payload) || typeof record.signature !== 'string') return null;
  const payload = record.payload as Record<string, unknown>;
  if (
    payload.version !== 2 ||
    typeof payload.taskId !== 'string' ||
    typeof payload.route !== 'string' ||
    typeof payload.throughSequence !== 'number' ||
    !Number.isInteger(payload.throughSequence) ||
    payload.throughSequence < 0 ||
    typeof payload.schemaVersion !== 'string' ||
    typeof payload.baselineDigest !== 'string' ||
    typeof payload.filtersDigest !== 'string' ||
    typeof payload.sort !== 'string' ||
    (payload.lastKey !== null && typeof payload.lastKey !== 'string') ||
    typeof payload.keyId !== 'string'
  ) {
    return null;
  }
  return { payload: payload as unknown as SnapshotCursorPayloadV2, signature: record.signature };
}

export class AuthoritativeReviewProjectionService {
  private readonly deps: AuthoritativeProjectionServiceDepsV2;

  readonly defaultLimit: number;

  readonly maxLimit: number;

  constructor(deps: AuthoritativeProjectionServiceDepsV2) {
    this.deps = deps;
    this.defaultLimit = deps.defaultLimit ?? V2_READ_DEFAULT_LIMIT;
    this.maxLimit = deps.maxLimit ?? V2_READ_MAX_LIMIT;
  }

  /* ----------------------------- §14.1 endpoints ----------------------------- */

  async map(taskId: string): Promise<AuthoritativeMapDetailV2> {
    const { projection } = await this.deps.readSnapshot(taskId);
    const map = projection.currentMap;
    if (map === null) {
      return {
        mapId: '',
        mapRevision: 0,
        mapSemanticDigest: '0'.repeat(64),
        supersedesMapId: null,
        mapSnapshotRef: null,
        mapReviewBundleRef: null,
        candidateRef: null,
        rootSlotId: null,
        nodeCount: 0,
        relationCount: 0,
        relation: { mode: 'disabled', relationCount: 0 },
      };
    }
    const snapshot = await this.resolveMapSnapshot(taskId, map.mapSnapshotRef);
    const relationCount = snapshot === null ? 0 : snapshot.relations.length;
    const rootSlotId = snapshot === null ? null : (snapshot.nodes.find((node) => node.parentSlotId === null)?.slotId ?? null);
    const relationMode = relationCount === 0 ? 'disabled' : 'optional';
    return {
      mapId: map.mapId,
      mapRevision: map.mapRevision,
      mapSemanticDigest: map.mapSemanticDigest,
      supersedesMapId: map.supersedesMapId,
      mapSnapshotRef: map.mapSnapshotRef,
      mapReviewBundleRef: map.mapReviewBundleRef,
      candidateRef: projection.currentCandidate?.candidateRef ?? null,
      rootSlotId,
      nodeCount: snapshot === null ? 0 : snapshot.nodes.length,
      relationCount,
      relation: { mode: relationMode, relationCount },
    };
  }

  async candidate(taskId: string): Promise<AuthoritativeCandidateDetailV2> {
    const { projection } = await this.deps.readSnapshot(taskId);
    const candidate = projection.currentCandidate;
    if (candidate === null) {
      return { candidateId: null, candidateRef: null, baseMapId: null, buildId: null, nodeCount: null, relationCount: null };
    }
    let nodeCount: number | null = null;
    let relationCount: number | null = null;
    try {
      const raw = await this.deps.resolveBlob(taskId, candidate.candidateRef, 'map_candidate');
      if (isPlainObject(raw)) {
        const coreRef = raw.validationCoreRef;
        if (isPlainObject(coreRef) && typeof coreRef.kind === 'string' && typeof coreRef.digest === 'string' && typeof coreRef.byteLength === 'number' && typeof coreRef.mediaType === 'string' && typeof coreRef.schemaVersion === 'number') {
          const core = await this.deps.resolveBlob(taskId, coreRef as unknown as BlobRefV2, 'map_candidate_validation_core');
          if (isPlainObject(core)) {
            const nodes = core.nodes;
            const relations = core.relations;
            if (Array.isArray(nodes)) nodeCount = nodes.length;
            if (Array.isArray(relations)) relationCount = relations.length;
          }
        }
      }
    } catch {
      // Bounded best-effort counts; identity/refs are the authority.
      nodeCount = null;
      relationCount = null;
    }
    return {
      candidateId: candidate.candidateId,
      candidateRef: candidate.candidateRef,
      baseMapId: candidate.baseMapId,
      buildId: candidate.buildId,
      nodeCount,
      relationCount,
    };
  }

  async tree(taskId: string, parentId: string | null, limit: number, after: SnapshotCursorV2 | null): Promise<AuthoritativeTreePageV2> {
    const filtersDigest = canonicalJsonSha256({ parentId });
    const sort = 'parent/siblingOrder/slotId';
    const resolved = await this.resolveCollectionSnapshot({
      taskId,
      route: 'tree',
      limit,
      after,
      filtersDigest,
      sort,
    });
    const { projection, throughSequence } = resolved.snapshot;
    const map = projection.currentMap;
    if (map === null) {
      return { parentId, hasMoreChildren: false, items: [], nextCursor: null };
    }
    const snapshot = await this.resolveMapSnapshot(taskId, map.mapSnapshotRef);
    if (snapshot === null) {
      return { parentId, hasMoreChildren: false, items: [], nextCursor: null };
    }
    const childrenByParent = new Map<string, { node: MapSnapshotV2['nodes'][number]; key: string }[]>();
    for (const node of snapshot.nodes) {
      const parent = node.parentSlotId ?? '';
      let bucket = childrenByParent.get(parent);
      if (bucket === undefined) {
        bucket = [];
        childrenByParent.set(parent, bucket);
      }
      bucket.push({ node, key: treeChildKey(node.siblingOrder, node.slotId) });
    }
    const bucketKey = parentId ?? '';
    const children = (childrenByParent.get(bucketKey) ?? []).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const startIndex = resolved.lastKey === null ? 0 : this.findStartIndex(children.map((c) => c.key), resolved.lastKey, 'tree');
    const page = children.slice(startIndex, startIndex + limit);
    const hasMoreChildren = startIndex + limit < children.length;
    const items: AuthoritativeTreeEntryV2[] = page.map(({ node }) => ({
      slotId: node.slotId,
      slotType: node.slotType,
      documentOrder: node.documentOrder,
      siblingOrder: node.siblingOrder,
      contentBearing: node.contentBearing,
      childCount: (childrenByParent.get(node.slotId) ?? []).length,
      review: this.slotReviewState(projection, node.slotId),
    }));
    const lastKey = page.length > 0 ? treeChildKey(page[page.length - 1].node.siblingOrder, page[page.length - 1].node.slotId) : null;
    const nextCursor = hasMoreChildren ? this.issueCursor(taskId, {
      route: 'tree',
      throughSequence,
      baselineDigest: resolved.snapshotBaseline,
      filtersDigest,
      sort,
      lastKey,
    }) : null;
    return { parentId, hasMoreChildren, items, nextCursor };
  }

  async locate(taskId: string, slotId: string, snapshotCursor: SnapshotCursorV2 | null): Promise<AuthoritativeLocateResultV2> {
    const snapshot = await this.detailSnapshot(taskId, snapshotCursor);
    const map = snapshot.projection.currentMap;
    if (map === null) {
      throw notVisible(slotId);
    }
    const mapSnapshot = await this.resolveMapSnapshot(taskId, map.mapSnapshotRef);
    if (mapSnapshot === null) {
      throw notVisible(slotId);
    }
    const byId = new Map<string, MapSnapshotV2['nodes'][number]>();
    for (const node of mapSnapshot.nodes) byId.set(node.slotId, node);
    const targetNode = byId.get(slotId);
    if (targetNode === undefined) {
      throw notVisible(slotId);
    }
    // Ancestor path root-first (exclusive of the target).
    const ancestors: { slotId: string; siblingKey: string }[] = [];
    let cursorNode: MapSnapshotV2['nodes'][number] | undefined = targetNode;
    const guard = new Set<string>();
    while (cursorNode?.parentSlotId !== null && cursorNode?.parentSlotId !== undefined) {
      const parent = byId.get(cursorNode.parentSlotId);
      if (parent === undefined || guard.has(cursorNode.parentSlotId)) break;
      guard.add(cursorNode.parentSlotId);
      ancestors.unshift({ slotId: cursorNode.parentSlotId, siblingKey: treeChildKey(cursorNode.siblingOrder, cursorNode.slotId) });
      cursorNode = parent;
    }
    // Per-level seek cursor: a tree cursor for the ancestor's parent page
    // positioned just BEFORE the child below it, so
    // `tree?parentId=<ancestor>&after=<cursor>` returns that child first. If
    // the child is the FIRST sibling the cursor starts at the page top.
    const sort = 'parent/siblingOrder/slotId';
    const childrenByParent = new Map<string, string[]>();
    for (const node of mapSnapshot.nodes) {
      const parent = node.parentSlotId ?? '';
      let bucket = childrenByParent.get(parent);
      if (bucket === undefined) {
        bucket = [];
        childrenByParent.set(parent, bucket);
      }
      bucket.push(treeChildKey(node.siblingOrder, node.slotId));
    }
    const ancestorsWithCursors = ancestors.map((ancestor) => {
      const siblingKeys = childrenByParent.get(ancestor.slotId) ?? [];
      const ownIndex = siblingKeys.indexOf(ancestor.siblingKey);
      const previousKey = ownIndex > 0 ? siblingKeys[ownIndex - 1] : null;
      return {
        slotId: ancestor.slotId,
        seekCursor: this.issueCursor(taskId, {
          route: 'tree',
          throughSequence: snapshot.throughSequence,
          baselineDigest: baselineDigestOf(snapshot.projection),
          filtersDigest: canonicalJsonSha256({ parentId: ancestor.slotId }),
          sort,
          lastKey: previousKey,
        }),
      };
    });
    return {
      target: {
        slotId: targetNode.slotId,
        slotType: targetNode.slotType,
        documentOrder: targetNode.documentOrder,
        siblingOrder: targetNode.siblingOrder,
        contentBearing: targetNode.contentBearing,
        childCount: (childrenByParent.get(targetNode.slotId) ?? []).length,
        review: this.slotReviewState(snapshot.projection, targetNode.slotId),
      },
      ancestors: ancestorsWithCursors,
    };
  }

  async mapRounds(taskId: string, limit: number, after: SnapshotCursorV2 | null): Promise<CollectionPageV2<AuthoritativeReviewRoundSummaryV2>> {
    return this.pageRounds(taskId, 'map-rounds', limit, after);
  }

  async rounds(taskId: string, limit: number, after: SnapshotCursorV2 | null): Promise<CollectionPageV2<AuthoritativeReviewRoundSummaryV2>> {
    return this.pageRounds(taskId, 'rounds', limit, after);
  }

  async summary(taskId: string): Promise<AuthoritativeReviewSummaryV2> {
    const { projection } = await this.deps.readSnapshot(taskId);
    const map = projection.currentMap;
    const snapshot = map === null ? null : await this.resolveMapSnapshot(taskId, map.mapSnapshotRef);
    const contentSlots = snapshot === null ? [] : snapshot.nodes.filter((node) => node.contentBearing).map((node) => node.slotId);
    const states = new Map<string, AuthoritativeContentReviewStateV2>();
    let reject = 0;
    let pass = 0;
    let pending = 0;
    let stale = 0;
    for (const slotId of contentSlots) {
      const state = this.contentState(projection, slotId);
      states.set(slotId, state);
      if (state === 'reject') reject += 1;
      else if (state === 'pass') pass += 1;
      else if (state === 'stale') stale += 1;
      else pending += 1;
    }
    const openBlocking = Object.values(projection.findings).filter(
      (finding) => finding.severity === 'blocking' && finding.state !== 'verified_closed',
    ).length;
    return {
      version: 2,
      mapCycleOrdinal: projection.mapCycleOrdinal,
      contentCycleOrdinal: projection.contentCycleOrdinal,
      pendingCount: pending,
      passCount: pass,
      rejectCount: reject,
      staleCount: stale,
      openBlockingFindingCount: openBlocking,
      relation: { mode: snapshot === null || snapshot.relations.length === 0 ? 'disabled' : 'optional', relationCount: snapshot?.relations.length ?? 0 },
    };
  }

  async slotReview(taskId: string, slotId: string, snapshotCursor: SnapshotCursorV2 | null): Promise<AuthoritativeSlotReviewDetailV2> {
    const snapshot = await this.detailSnapshot(taskId, snapshotCursor);
    const map = snapshot.projection.currentMap;
    if (map === null) throw notVisible(slotId);
    const mapSnapshot = await this.resolveMapSnapshot(taskId, map.mapSnapshotRef);
    if (mapSnapshot === null) throw notVisible(slotId);
    const node = mapSnapshot.nodes.find((candidate) => candidate.slotId === slotId);
    if (node === undefined) throw notVisible(slotId);
    return {
      slotId: node.slotId,
      slotType: node.slotType,
      parentSlotId: node.parentSlotId,
      documentOrder: node.documentOrder,
      siblingOrder: node.siblingOrder,
      contentBearing: node.contentBearing,
      review: this.slotReviewState(snapshot.projection, node.slotId),
      openBlockingFindingIds: this.openBlockingFindingIdsAt(snapshot.projection, ['slot'], node.slotId),
    };
  }

  async relationReview(taskId: string, relationId: string, snapshotCursor: SnapshotCursorV2 | null): Promise<AuthoritativeRelationReviewDetailV2> {
    const snapshot = await this.detailSnapshot(taskId, snapshotCursor);
    const map = snapshot.projection.currentMap;
    if (map === null) throw notVisible(relationId);
    const mapSnapshot = await this.resolveMapSnapshot(taskId, map.mapSnapshotRef);
    if (mapSnapshot === null) throw notVisible(relationId);
    const relation = mapSnapshot.relations.find((candidate) => candidate.relationId === relationId);
    if (relation === undefined) throw notVisible(relationId);
    return {
      relationId: relation.relationId,
      typeId: relation.typeId,
      fromSlotId: relation.fromSlotId,
      toSlotId: relation.toSlotId,
      review: this.relationState(snapshot.projection, relationId),
      openBlockingFindingIds: this.openBlockingFindingIdsAt(snapshot.projection, ['relation'], relationId),
    };
  }

  async findings(taskId: string, limit: number, after: SnapshotCursorV2 | null): Promise<CollectionPageV2<AuthoritativeFindingSummaryV2>> {
    const filtersDigest = canonicalJsonSha256({});
    const sort = 'targetStableId/id';
    const resolved = await this.resolveCollectionSnapshot({
      taskId,
      route: 'findings',
      limit,
      after,
      filtersDigest,
      sort,
    });
    const ordered: OrderedPageItem<AuthoritativeFindingSummaryV2>[] = Object.values(resolved.snapshot.projection.findings)
      .map((finding) => {
        const summary: AuthoritativeFindingSummaryV2 = {
          findingId: finding.findingId,
          reviewContext: { kind: finding.reviewContext.kind, roundId: finding.reviewContext.roundId },
          primaryLocation: { kind: finding.primaryLocation.kind as AuthoritativeFindingSummaryV2['primaryLocation']['kind'], id: finding.primaryLocation.id },
          defectClass: finding.defectClass,
          severity: finding.severity,
          source: finding.source,
          status: finding.state === 'open' ? 'open' : finding.state === 'addressed' ? 'addressed' : 'verified_closed',
        };
        return { key: `${finding.primaryLocation.id}:${finding.findingId}`, item: summary };
      })
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return this.slicePage(taskId, resolved, ordered, 'findings', limit);
  }

  /**
   * Legacy-compatible issues projection (spec §14.1 "existing issues route
   * projects current v2 Findings and deterministic validator issues"). Maps the
   * current open blocking/advisory Findings and the deterministic work-item
   * `retry_budget_exhausted` / task-failure states into the stable
   * `StructuredIssueV1` shape so the old UI keeps reading. It NEVER maps a Seal
   * boolean to a per-slot pass.
   */
  async issues(taskId: string): Promise<StructuredIssueV1[]> {
    const { projection } = await this.deps.readSnapshot(taskId);
    const issues: StructuredIssueV1[] = [];
    for (const finding of Object.values(projection.findings)) {
      if (finding.state !== 'open') continue;
      issues.push({
        version: 1,
        code: finding.severity === 'blocking' ? 'BLOCKING_FINDING_OPEN' : 'ADVISORY_FINDING_OPEN',
        severity: finding.severity === 'blocking' ? 'error' : 'warning',
        phase: 'merge',
        source: 'validator',
        message: '存在待处理的审核缺陷。',
        primaryLocation: { kind: 'slot', slotId: finding.primaryLocation.id, field: 'content', valuePointer: '' },
        relatedLocations: [],
        details: {},
      });
    }
    for (const workItem of Object.values(projection.workItems)) {
      if (workItem.state === 'parked' && workItem.parkDisposition?.kind === 'retry_budget_exhausted') {
        issues.push({
          version: 1,
          code: 'RETRY_BUDGET_EXHAUSTED',
          severity: 'error',
          phase: 'assemble',
          source: 'lifecycle',
          message: '一个生成/审核任务已耗尽自动重试预算。',
          primaryLocation: { kind: 'operation' },
          relatedLocations: [],
          details: {},
        });
      }
    }
    return issues;
  }

  async sealReadiness(taskId: string): Promise<AuthoritativeSealReadinessDetailV2> {
    const { projection } = await this.deps.readSnapshot(taskId);
    if (projection.currentSeal !== null) {
      return {
        readiness: 'ready',
        unmetConditionCount: 0,
        sealed: true,
        sealRecordRef: projection.currentSeal.sealRecordRef,
        conditions: [
          { code: sealConditionCodes.MAP_REF_MISMATCH, detail: 'the task is sealed', satisfied: true },
          { code: sealConditionCodes.MANIFEST_REF_MISMATCH, detail: 'the task is sealed', satisfied: true },
          { code: sealConditionCodes.MAP_REVIEW_BUNDLE_MISSING, detail: 'the task is sealed', satisfied: true },
          { code: sealConditionCodes.PRESENCE_COVERAGE_INCOMPLETE, detail: 'the task is sealed', satisfied: true },
          { code: sealConditionCodes.RELATION_COVERAGE_INCOMPLETE, detail: 'the task is sealed', satisfied: true },
          { code: sealConditionCodes.OBSERVATION_INCOMPLETE, detail: 'the task is sealed', satisfied: true },
          { code: sealConditionCodes.BLOCKING_FINDINGS_OPEN, detail: 'the task is sealed', satisfied: true },
          { code: sealConditionCodes.PENDING_OR_STALE_REVIEW, detail: 'the task is sealed', satisfied: true },
          { code: sealConditionCodes.VALIDATOR_NOT_CLEAR, detail: 'the task is sealed', satisfied: true },
          { code: sealConditionCodes.TEMPLATE_MISMATCH, detail: 'the task is sealed', satisfied: true },
        ],
      };
    }
    const conditions: AuthoritativeSealReadinessConditionV2[] = [];
    const map = projection.currentMap;
    const mapReviewBundleMissing = map === null || map.mapReviewBundleRef === null || map.mapReviewBundleRef.digest.length === 0;
    const manifestNotFinalized = projection.currentManifest === null || projection.currentManifest.manifestPhase !== 'finalized';
    const openBlocking = Object.values(projection.findings).filter(
      (finding) => finding.severity === 'blocking' && finding.state !== 'verified_closed',
    ).length;
    const roundsSettled = this.hasSettledContentRound(projection);
    conditions.push(
      { code: sealConditionCodes.MAP_REVIEW_BUNDLE_MISSING, detail: mapReviewBundleMissing ? 'no active Map with a system-approved MapReviewBundle' : 'the active Map carries a current MapReviewBundle', satisfied: !mapReviewBundleMissing },
      { code: sealConditionCodes.MANIFEST_REF_MISMATCH, detail: manifestNotFinalized ? 'the current content manifest is not finalized' : 'the current content manifest is finalized', satisfied: !manifestNotFinalized },
      { code: sealConditionCodes.BLOCKING_FINDINGS_OPEN, detail: openBlocking === 0 ? 'no open blocking Finding' : `${openBlocking} open blocking Finding(s)`, satisfied: openBlocking === 0 },
      { code: sealConditionCodes.PENDING_OR_STALE_REVIEW, detail: roundsSettled ? 'a content review round has settled' : 'no content review round has settled', satisfied: roundsSettled },
      { code: sealConditionCodes.PRESENCE_COVERAGE_INCOMPLETE, detail: 'presence-aware slot coverage is not proven from the projection (ledger-level facts are resolved at seal time)', satisfied: false },
      { code: sealConditionCodes.VALIDATOR_NOT_CLEAR, detail: 'pre-seal validator aggregates are resolved at seal time', satisfied: false },
    );
    const unmetConditionCount = conditions.filter((condition) => !condition.satisfied).length;
    return {
      readiness: unmetConditionCount === 0 ? 'ready' : 'not_ready',
      unmetConditionCount,
      sealed: false,
      sealRecordRef: null,
      conditions,
    };
  }

  /* ----------------------------- cursor plumbing ----------------------------- */

  private async resolveCollectionSnapshot(input: {
    taskId: string;
    route: V2CollectionRoute;
    limit: number;
    after: SnapshotCursorV2 | null;
    filtersDigest: string;
    sort: string;
  }): Promise<{
    snapshot: AuthoritativeProjectionSnapshotV2;
    snapshotBaseline: string;
    lastKey: string | null;
  }> {
    if (input.limit < 1 || input.limit > this.maxLimit) {
      throw new AuthoritativeReviewReadError('CURSOR_STALE', 'limit 超出 v2 只读 profile 上限。', null, '调整 limit 后重试。');
    }
    if (input.after === null) {
      const snapshot = await this.deps.readSnapshot(input.taskId);
      return { snapshot, snapshotBaseline: baselineDigestOf(snapshot.projection), lastKey: null };
    }
    const payload = this.verifyCursor(input.taskId, input.after);
    if (payload.route !== input.route) {
      throw stale(CURSOR_STALE_REASON_QUERY_IDENTITY, 'cursor 绑定到不同的只读端点。');
    }
    if (payload.filtersDigest !== input.filtersDigest || payload.sort !== input.sort) {
      throw stale(CURSOR_STALE_REASON_QUERY_IDENTITY, '查询参数（过滤器/排序）与 cursor 不一致。');
    }
    const snapshot = await this.deps.readSnapshot(input.taskId, payload.throughSequence);
    if (baselineDigestOf(snapshot.projection) !== payload.baselineDigest) {
      throw stale(CURSOR_STALE_REASON_QUERY_IDENTITY, '该快照的权威基线已变化。');
    }
    return { snapshot, snapshotBaseline: payload.baselineDigest, lastKey: payload.lastKey };
  }

  private async detailSnapshot(taskId: string, snapshotCursor: SnapshotCursorV2 | null): Promise<AuthoritativeProjectionSnapshotV2> {
    if (snapshotCursor === null) {
      return this.deps.readSnapshot(taskId);
    }
    const payload = this.verifyCursor(taskId, snapshotCursor);
    const snapshot = await this.deps.readSnapshot(taskId, payload.throughSequence);
    if (baselineDigestOf(snapshot.projection) !== payload.baselineDigest) {
      throw stale(CURSOR_STALE_REASON_QUERY_IDENTITY, '该快照的权威基线已变化。');
    }
    return snapshot;
  }

  private verifyCursor(taskId: string, cursor: SnapshotCursorV2): SnapshotCursorPayloadV2 {
    const token = parseToken(cursor.token);
    if (token === null || token.payload.keyId !== cursor.keyId) {
      throw stale(CURSOR_STALE_REASON_TAMPERED, 'cursor 无法解析。');
    }
    const outcome: CursorVerifyOutcome = this.deps.keyring.verify(canonicalJson(token.payload), token.signature, token.payload.keyId);
    if (outcome === CURSOR_STALE_EXPIRED || outcome === CURSOR_STALE_UNKNOWN_KEY) {
      throw stale(CURSOR_STALE_REASON_SIGNING_KEY_RETIRED, 'cursor 签名密钥已退役。');
    }
    if (outcome !== 'valid') {
      throw stale(CURSOR_STALE_REASON_TAMPERED, 'cursor 签名无效。');
    }
    if (token.payload.taskId !== taskId) {
      throw stale(CURSOR_STALE_REASON_TAMPERED, 'cursor 不属于该任务。');
    }
    if (token.payload.schemaVersion !== V2_READ_SCHEMA_VERSION) {
      throw stale(CURSOR_STALE_REASON_QUERY_IDENTITY, 'cursor 绑定的投影 schema 已变化。');
    }
    return token.payload;
  }

  private issueCursor(taskId: string, input: {
    route: V2CollectionRoute;
    throughSequence: number;
    baselineDigest: string;
    filtersDigest: string;
    sort: string;
    lastKey: string | null;
  }): SnapshotCursorV2 {
    const payload: SnapshotCursorPayloadV2 = {
      version: 2,
      taskId,
      route: input.route,
      throughSequence: input.throughSequence,
      schemaVersion: V2_READ_SCHEMA_VERSION,
      baselineDigest: input.baselineDigest,
      filtersDigest: input.filtersDigest,
      sort: input.sort,
      lastKey: input.lastKey,
      keyId: this.deps.keyring.activeKeyId(),
    };
    const { keyId, signature } = this.deps.keyring.sign(canonicalJson(payload));
    const token = Buffer.from(JSON.stringify({ payload, signature } satisfies SnapshotCursorTokenV2), 'utf8').toString('base64url');
    return { version: 2, keyId, token };
  }

  private slicePage<T>(
    taskId: string,
    resolved: {
      snapshot: AuthoritativeProjectionSnapshotV2;
      snapshotBaseline: string;
      lastKey: string | null;
    },
    ordered: OrderedPageItem<T>[],
    route: V2CollectionRoute,
    limit: number,
  ): CollectionPageV2<T> {
    const startIndex = resolved.lastKey === null ? 0 : this.findStartIndex(ordered.map((entry) => entry.key), resolved.lastKey, route);
    const page = ordered.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + page.length < ordered.length;
    const lastKey = page.length > 0 ? page[page.length - 1].key : null;
    const nextCursor = hasMore ? this.issueCursor(taskId, {
      route,
      throughSequence: resolved.snapshot.throughSequence,
      baselineDigest: resolved.snapshotBaseline,
      filtersDigest: canonicalJsonSha256({}),
      sort: route === 'findings' ? 'targetStableId/id' : 'kind/ordinal/id',
      lastKey,
    }) : null;
    return { items: page.map((entry) => entry.item), nextCursor };
  }

  private async pageRounds(taskId: string, route: 'map-rounds' | 'rounds', limit: number, after: SnapshotCursorV2 | null): Promise<CollectionPageV2<AuthoritativeReviewRoundSummaryV2>> {
    const filtersDigest = canonicalJsonSha256({});
    const sort = 'kind/ordinal/id';
    const resolved = await this.resolveCollectionSnapshot({ taskId, route, limit, after, filtersDigest, sort });
    const rows: OrderedPageItem<AuthoritativeReviewRoundSummaryV2>[] = [];
    const appendKind = (kind: 'map' | 'content', rounds: Record<string, { ordinal: number; state: 'planned' | 'reviewing' | 'completed' | 'settled'; roundId: string }>): void => {
      for (const round of Object.values(rounds)) {
        if (route === 'map-rounds' && kind !== 'map') continue;
        rows.push({
          key: `${kind}:${String(round.ordinal).padStart(20, '0')}:${round.roundId}`,
          item: {
            reviewRoundId: round.roundId,
            kind,
            state: round.state === 'reviewing' ? 'reviewing_batches' : round.state,
          },
        });
      }
    };
    appendKind('map', resolved.snapshot.projection.mapRounds);
    appendKind('content', resolved.snapshot.projection.contentRounds);
    rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const startIndex = resolved.lastKey === null ? 0 : this.findStartIndex(rows.map((entry) => entry.key), resolved.lastKey, route);
    const page = rows.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + page.length < rows.length;
    const lastKey = page.length > 0 ? page[page.length - 1].key : null;
    const nextCursor = hasMore ? this.issueCursor(taskId, {
      route,
      throughSequence: resolved.snapshot.throughSequence,
      baselineDigest: resolved.snapshotBaseline,
      filtersDigest,
      sort,
      lastKey,
    }) : null;
    return { items: page.map((entry) => entry.item), nextCursor };
  }

  private findStartIndex(keys: string[], lastKey: string, where: string): number {
    if (lastKey === null) return 0;
    let low = 0;
    let high = keys.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (keys[mid] <= lastKey) low = mid + 1;
      else high = mid;
    }
    // `low` is the first index with key > lastKey. If NO key equals lastKey,
    // the cursor belongs to a different projection => stale (never guess).
    const atOrBelow = low - 1;
    const exact = atOrBelow >= 0 && keys[atOrBelow] === lastKey ? atOrBelow : null;
    if (exact === null) {
      throw stale(CURSOR_STALE_REASON_QUERY_IDENTITY, `cursor 不属于该 ${where} 投影。`);
    }
    return low;
  }

  /* ----------------------------- derived review states ----------------------------- */

  private slotReviewState(projection: AuthoritativeReviewProjectionV2, slotId: string): { mapPreReview: AuthoritativeMapPreReviewStateV2; content: AuthoritativeContentReviewStateV2 } {
    const mapRejected = this.openBlockingFindingIdsAt(projection, ['map_node', 'slot'], slotId).some((findingId) => {
      const finding = projection.findings[findingId];
      return finding?.reviewContext.kind === 'map';
    });
    const mapPreReview: AuthoritativeMapPreReviewStateV2 = mapRejected ? 'reject' : projection.currentMap !== null ? 'pass' : 'pending';
    return { mapPreReview, content: this.contentState(projection, slotId) };
  }

  private contentState(projection: AuthoritativeReviewProjectionV2, slotId: string): AuthoritativeContentReviewStateV2 {
    if (this.openBlockingFindingIdsAt(projection, ['slot'], slotId).length > 0) return 'reject';
    const settled = this.hasSettledContentRound(projection);
    if (settled) {
      return projection.currentManifest?.manifestPhase === 'finalized' ? 'pass' : 'stale';
    }
    return 'pending';
  }

  private relationState(projection: AuthoritativeReviewProjectionV2, relationId: string): AuthoritativeRelationReviewStateV2 {
    if (this.openBlockingFindingIdsAt(projection, ['relation'], relationId).length > 0) return 'violated';
    const settled = this.hasSettledContentRound(projection);
    if (settled) {
      return projection.currentManifest?.manifestPhase === 'finalized' ? 'satisfied' : 'stale';
    }
    return 'pending';
  }

  private hasSettledContentRound(projection: AuthoritativeReviewProjectionV2): boolean {
    let latest: number | null = null;
    for (const round of Object.values(projection.contentRounds)) {
      if (latest === null || round.ordinal > latest) latest = round.ordinal;
    }
    if (latest === null) return false;
    return Object.values(projection.contentRounds).some((round) => round.ordinal === latest && round.state === 'settled');
  }

  private openBlockingFindingIdsAt(projection: AuthoritativeReviewProjectionV2, kinds: string[], id: string): string[] {
    const result: string[] = [];
    for (const finding of Object.values(projection.findings)) {
      if (
        finding.severity === 'blocking'
        && finding.state !== 'verified_closed'
        && kinds.includes(finding.primaryLocation.kind)
        && finding.primaryLocation.id === id
      ) {
        result.push(finding.findingId);
      }
    }
    return result.sort();
  }

  private async resolveMapSnapshot(taskId: string, ref: BlobRefV2): Promise<MapSnapshotV2 | null> {
    try {
      const raw = await this.deps.resolveBlob(taskId, ref, 'map_snapshot');
      return parseBlob('map_snapshot', raw, ref).object as MapSnapshotV2;
    } catch (error) {
      if (error instanceof ProjectionCorruptionError) throw error;
      return null;
    }
  }
}

function notVisible(id: string): AuthoritativeReviewReadError {
  return new AuthoritativeReviewReadError(
    'SLOT_NOT_VISIBLE',
    '该槽位在当前 Map 中不可见。',
    'authoritativeReview.read',
    '返回树视图刷新后重试。',
  );
}

function stale(reason: string, detail: string): AuthoritativeReviewReadError {
  return new AuthoritativeReviewReadError(
    'CURSOR_STALE',
    `分页游标失效（${reason}）。`,
    'authoritativeReview.read',
    `返回第一页重试。${detail}`,
  );
}
