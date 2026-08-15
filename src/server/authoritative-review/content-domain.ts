/**
 * Pure Content domain (Task 3, design §7.3/§11.5/§11.6/§12.2; spec §7.3):
 * slot version leaves, content-root computation, manifest validation with
 * exact phase rules, presence-aware coverage (absent_not_applicable for
 * optional-unset; required-unset/rewrite_required reject planning), staleness
 * against the Map (identical issue: same-root/different-manifest must be
 * different revisions), and the deterministic migration routing outcomes.
 *
 * Pure module: no fs/EventStore/provider/HTTP/React, no wall clock, no random.
 */
import { canonicalJsonSha256 } from '../structured-slots/canonical-json';
import {
  SchemaError,
  type ContentRevisionManifestEntryV2,
  type ContentRevisionManifestPhaseV2,
  type ContentRevisionManifestV2,
  type ContentSlotCoverageFactV2,
  type MigrationIntentDecisionV2,
  type SlotContentVersionV2,
  type SlotPresenceV2,
} from './authority-types';
import type { BlobRefV2 } from '../../shared/authoritative-review-v2';

/* ------------------------------------------------------------------ */
/* Slot leaves and content root (design §11.5/§7.3)                    */
/* ------------------------------------------------------------------ */

/**
 * Frozen leaf values. `unset` uses UNSET(contentSchemaDigest); rewrite_required
 * uses REWRITE_REQUIRED(slotId, contentSchemaDigest, sourceContentDigest?);
 * set uses the slot content digest. The root digests the sorted
 * `{slotId, leaf}` pairs so equal normalized leaves => equal roots, while the
 * manifest ref (authority) still distinguishes revisions with different
 * provenance/custody.
 */
export function slotLeafDigest(
  state: 'unset' | 'rewrite_required' | 'set',
  input: { slotId?: string; contentSchemaDigest?: string; sourceContentDigest?: string | null; contentDigest?: string },
): string {
  if (state === 'unset') {
    return canonicalJsonSha256({ state: 'unset', contentSchemaDigest: input.contentSchemaDigest });
  }
  if (state === 'rewrite_required') {
    return canonicalJsonSha256({
      state: 'rewrite_required',
      slotId: input.slotId,
      contentSchemaDigest: input.contentSchemaDigest,
      sourceContentDigest: input.sourceContentDigest ?? null,
    });
  }
  return canonicalJsonSha256({ state: 'set', contentDigest: input.contentDigest });
}

/** Resolve a slot version to its frozen leaf value (assuming validated version shape). */
export function resolveSlotLeaf(version: SlotContentVersionV2): string {
  if (version.state === 'unset') {
    return slotLeafDigest('unset', { contentSchemaDigest: version.contentSchemaDigest });
  }
  if (version.state === 'rewrite_required') {
    return slotLeafDigest('rewrite_required', {
      slotId: version.slotId,
      contentSchemaDigest: version.contentSchemaDigest,
      sourceContentDigest: version.sourceContentDigest,
    });
  }
  return slotLeafDigest('set', { contentDigest: version.contentDigest });
}

/**
 * The ONLY content-root contract (Finding 2 fix): the root digests the
 * slotId-sorted NORMALIZED SLOT LEAVES of resolved versions. The versionRef
 * digest (whole content_version object incl. mapRef/provenance) is NEVER a
 * leaf — the same content across a different Map/provenance keeps the same
 * root while the manifest ref (the authority) still differs. Callers without
 * resolved versions must fail closed, never fall back to ref digests.
 */
export function computeContentLeaves(versions: readonly SlotContentVersionV2[]): unknown[] {
  return [...versions]
    .sort((a, b) => (a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0))
    .map((v) => ({ slotId: v.slotId, leaf: resolveSlotLeaf(v) }));
}

/** contentRootDigest: SHA-256 over the slotId-sorted normalized leaves (order-insensitive). */
export function computeContentRootDigest(versions: readonly SlotContentVersionV2[]): string {
  return canonicalJsonSha256(computeContentLeaves(versions));
}

/* ------------------------------------------------------------------ */
/* Manifest construction and validation (§7.3/§11.5)                   */
/* ------------------------------------------------------------------ */

export function computeProvisionalOrFinalizedManifest(input: {
  taskId: string;
  mapRef: BlobRefV2;
  mapSemanticDigest: string;
  taskContentRevision: number;
  manifestPhase: ContentRevisionManifestPhaseV2;
  entries: readonly { slotId: string; versionRef: BlobRefV2 }[];
  producerPlanSpecRef: BlobRefV2 | null;
  priorManifestRef?: BlobRefV2 | null;
  finalizerValidatorAggregateRefs?: readonly BlobRefV2[];
  finalizerWarningRootRefs?: readonly BlobRefV2[];
  /** Resolved version per entry; required — the root digests normalized leaves, not refs. */
  resolvedVersions: ReadonlyMap<string, SlotContentVersionV2>;
}): ContentRevisionManifestV2 {
  const sortedEntries = [...input.entries].sort((a, b) => (a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0));
  const leaves = sortedEntries.map((e) => {
    const version = input.resolvedVersions.get(e.slotId);
    if (!version) throw new SchemaError(`manifest root requires a resolved version for slot '${e.slotId}'`);
    return { slotId: e.slotId, leaf: resolveSlotLeaf(version) };
  });
  const body = {
    taskId: input.taskId,
    mapRef: input.mapRef,
    mapSemanticDigest: input.mapSemanticDigest,
    taskContentRevision: input.taskContentRevision,
    manifestPhase: input.manifestPhase,
    entries: sortedEntries,
    producerPlanSpecRef: input.producerPlanSpecRef,
    priorManifestRef: input.priorManifestRef ?? null,
    finalizerValidatorAggregateRefs: input.finalizerValidatorAggregateRefs ?? [],
    finalizerWarningRootRefs: input.finalizerWarningRootRefs ?? [],
    contentRootDigest: canonicalJsonSha256(leaves),
  };
  return { ...body, manifestDigest: canonicalJsonSha256(body) };
}

/**
 * Structural + coverage validation of a manifest. `expectedSlotIds` are the
 * current Map's content-bearing slots; when given, the manifest must cover
 * them exactly (sorted by slot ID, complete). Phase rules:
 * - baseline_unset: all-unset created_empty entries, null plan, null prior, empty finalizer refs;
 * - provisional: empty finalizer refs;
 * - finalized: non-empty finalizer refs and every content slot resolved-set
 *   (when `resolvedVersions` is supplied); seal-ineligible otherwise.
 */
export function validateContentRevisionManifest(
  manifest: ContentRevisionManifestV2,
  expectedSlotIds?: ReadonlySet<string> | null,
  resolvedVersions?: ReadonlyMap<string, SlotContentVersionV2>,
): void {
  const entries = manifest.entries;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i - 1].slotId >= entries[i].slotId) {
      throw new SchemaError('content_revision_manifest.entries must be sorted by slotId');
    }
  }
  if (expectedSlotIds !== undefined && expectedSlotIds !== null) {
    const covered = new Set(entries.map((e) => e.slotId));
    for (const expected of expectedSlotIds) {
      if (!covered.has(expected)) {
        throw new SchemaError(`content_revision_manifest does not cover required Map content slot '${expected}'`);
      }
    }
    for (const entry of entries) {
      if (!expectedSlotIds.has(entry.slotId)) {
        throw new SchemaError(`content_revision_manifest covers unknown slot '${entry.slotId}'`);
      }
    }
  }
  const phase = manifest.manifestPhase;
  if (phase === 'baseline_unset') {
    if (manifest.producerPlanSpecRef !== null) throw new SchemaError('baseline_unset manifest must have producerPlanSpecRef null');
    if (manifest.priorManifestRef !== null) throw new SchemaError('baseline_unset manifest must have priorManifestRef null');
    if (manifest.finalizerValidatorAggregateRefs.length > 0 || manifest.finalizerWarningRootRefs.length > 0) {
      throw new SchemaError('baseline_unset manifest must have empty finalizer refs');
    }
  }
  if (phase === 'provisional' && (manifest.finalizerValidatorAggregateRefs.length > 0 || manifest.finalizerWarningRootRefs.length > 0)) {
    throw new SchemaError('provisional manifest must have empty finalizer refs');
  }
  if (phase === 'finalized' && manifest.finalizerValidatorAggregateRefs.length === 0) {
    throw new SchemaError('finalized manifest requires finalizerValidatorAggregateRefs');
  }
  if (resolvedVersions) {
    // rebuild ALL entries (not just manifest entries): the root covers the
    // manifest's entries exactly.
    for (const entry of entries) {
      const version = resolvedVersions.get(entry.slotId);
      if (!version) throw new SchemaError(`content_revision_manifest cannot resolve version of slot '${entry.slotId}'`);
      if (version.slotId !== entry.slotId) throw new SchemaError(`content_revision_manifest entry '${entry.slotId}' binds a mismatched version`);
      if (phase === 'baseline_unset' && version.state !== 'unset') {
        throw new SchemaError(`baseline_unset manifest entry '${entry.slotId}' must be an unset version`);
      }
      if (phase === 'finalized' && version.state !== 'set') {
        throw new SchemaError(`finalized manifest entry '${entry.slotId}' must be a set version (unset/rewrite_required never seal)`);
      }
    }
    // Minor #4: the declared root is a display-of-authority value — it must
    // equal the root recomputed from the resolved leaves.
    const recomputed = canonicalJsonSha256(
      entries
        .map((e) => ({ slotId: e.slotId, leaf: resolveSlotLeaf(resolvedVersions.get(e.slotId) as SlotContentVersionV2) }))
        .sort((a, b) => (a.slotId < b.slotId ? -1 : 1)),
    );
    if (recomputed !== manifest.contentRootDigest) {
      throw new SchemaError('content_revision_manifest.contentRootDigest does not match the root of the resolved slot leaves');
    }
  }
}

export function isFinalizedSealEligible(manifest: ContentRevisionManifestV2): boolean {
  return (
    manifest.manifestPhase === 'finalized' &&
    manifest.finalizerValidatorAggregateRefs.length > 0
  );
}

/**
 * §7.3 same-root/different-manifest staleness: only the exact manifest ref is
 * the authority. A manifest whose map binding has moved (or that must be judged
 * against a different manifest ref) fails with AUTHORITY_BASE_STALE — equal
 * contentRootDigest never satisfies this.
 */
export function assertManifestAgainstMap(manifest: ContentRevisionManifestV2, expectedManifestRef: BlobRefV2): void {
  const bound = manifest.mapRef;
  if (bound.kind !== expectedManifestRef.kind || bound.digest !== expectedManifestRef.digest) {
    throw new SchemaError(`AUTHORITY_BASE_STALE: manifest binds mapRef ${bound.digest.slice(0, 8)} but the base carries ${expectedManifestRef.digest.slice(0, 8)}`);
  }
}

/** The manifest's mapSemanticDigest is a redundant display alias of the RESOLVED active Map. */
export function assertManifestSemanticDigest(manifest: ContentRevisionManifestV2, resolvedMapSemanticDigest: string): void {
  if (manifest.mapSemanticDigest !== resolvedMapSemanticDigest) {
    throw new SchemaError(`REVIEW_BASE_STALE: manifest.mapSemanticDigest does not match the resolved active Map`);
  }
}

export function assertManifestPhaseProgression(prior: ContentRevisionManifestPhaseV2 | null, next: ContentRevisionManifestPhaseV2): void {
  const legal: Readonly<Record<string, readonly string[]>> = {
    null: ['baseline_unset'],
    baseline_unset: ['provisional'],
    provisional: ['provisional', 'finalized'],
    finalized: [],
  };
  const from = prior ?? 'null';
  if (!legal[from].includes(next)) {
    throw new SchemaError(`illegal manifest phase progression '${from}' -> '${next}'`);
  }
}

/* ------------------------------------------------------------------ */
/* Presence-aware coverage (§11.6/§12.2)                               */
/* ------------------------------------------------------------------ */

export interface PresenceCoverageResultV2 {
  planable: boolean;
  unplanableReasons: string[];
  /** Only optional-unset absence facts and set/required placement of reviewed targets. */
  facts: ContentSlotCoverageFactV2[];
}

/**
 * Compute the round's coverage facts from the current manifest. Set slots
 * (required or optional) require reviewer facts; optional-unset slots get the
 * system `absent_not_applicable` fact; required-unset or any rewrite_required
 * slot makes the round UNPLANABLE (route to repair before review, fail-closed).
 */
export function computePresenceCoverage(
  manifest: ContentRevisionManifestV2,
  slotPresence: Readonly<Record<string, SlotPresenceV2>>,
  resolveVersion?: (slotId: string, versionRef: BlobRefV2) => SlotContentVersionV2 | null,
): PresenceCoverageResultV2 {
  const unplanableReasons: string[] = [];
  const facts: ContentSlotCoverageFactV2[] = [];
  const entries = [...manifest.entries].sort((a, b) => (a.slotId < b.slotId ? -1 : 1));
  for (const entry of entries) {
    const presence = slotPresence[entry.slotId] ?? 'required';
    const version = resolveVersion ? resolveVersion(entry.slotId, entry.versionRef) : null;
    if (version === null) {
      // Without a resolver the manifest cannot prove the version state; the
      // caller must resolve versions before planning (fail-closed).
      unplanableReasons.push(`cannot resolve version state of slot '${entry.slotId}'`);
      continue;
    }
    if (version.state === 'set') {
      facts.push({
        disposition: 'reviewed',
        slotId: entry.slotId,
        contentVersionRef: entry.versionRef,
        reviewFactRef: entry.versionRef,
      });
      continue;
    }
    if (version.state === 'rewrite_required') {
      unplanableReasons.push(`slot '${entry.slotId}' is rewrite_required and must be repaired before review`);
      continue;
    }
    // unset
    if (presence === 'optional') {
      const schemaOf = (v: SlotContentVersionV2): string => v.contentSchemaDigest;
      facts.push(
        absenceFact({
          slotId: entry.slotId,
          contentVersionRef: entry.versionRef,
          presencePolicyDigest: canonicalJsonSha256({
            slotId: entry.slotId,
            presence: 'optional',
            contentSchemaDigest: schemaOf(version),
          }),
        }),
      );
    } else {
      unplanableReasons.push(`required slot '${entry.slotId}' is unset and must be routed to generation/repair before review`);
    }
  }
  return { planable: unplanableReasons.length === 0, unplanableReasons, facts };
}

/* ------------------------------------------------------------------ */
/* Migration routing (§11.5)                                           */
/* ------------------------------------------------------------------ */

export type RouteClassification = 'clear' | 'content_repair' | 'map_repair' | 'infrastructure_failure';

export interface ClassifiedFindingV2 {
  severity: 'blocking' | 'advisory';
  defectClass: 'content' | 'map' | 'mixed';
}

/**
 * Deterministic combined route: infrastructure failure dominates; then any
 * map/mixed blocking forces Map repair first; content-only blocking routes to
 * content repair; advisory-only stays clear.
 */
export function deriveCombinedRouteOutcome(
  blockingFindings: readonly ClassifiedFindingV2[],
  finalizerAggregateOutcome: 'clear' | 'blocking_invalid' | 'infrastructure_failure',
): RouteClassification {
  if (finalizerAggregateOutcome === 'infrastructure_failure') return 'infrastructure_failure';
  const hasMapOrMixed = blockingFindings.some(
    (f) => f.severity === 'blocking' && (f.defectClass === 'map' || f.defectClass === 'mixed'),
  );
  if (hasMapOrMixed) return 'map_repair';
  const hasContent = blockingFindings.some((f) => f.severity === 'blocking' && f.defectClass === 'content');
  if (hasContent) return 'content_repair';
  return 'clear';
}

/** Exact decision/action legal combinations of the migration intent (§11.5). */
export function validateMigrationIntentDecisions(decisions: readonly MigrationIntentDecisionV2[]): void {
  const seen = new Set<string>();
  for (const d of decisions) {
    if (seen.has(d.slotId)) throw new SchemaError(`migration intent has duplicate decision for slot '${d.slotId}'`);
    seen.add(d.slotId);
    if (d.action === 'rewrite_required' && (('findingStageRootRef' in d && d.findingStageRootRef === null) || !('findingStageRootRef' in d))) {
      throw new SchemaError('rewrite_required decision requires a findingStageRootRef');
    }
    if (d.action === 'new_or_schema_reset' && d.unsetReason !== 'new_slot' && d.unsetReason !== 'schema_reset') {
      throw new SchemaError('new_or_schema_reset decision unsetReason must be new_slot|schema_reset');
    }
  }
}

/** Optional-unset absence fact (system-owned); binds the exact version ref + presence policy. */
export function absenceFact(input: {
  slotId: string;
  contentVersionRef: BlobRefV2;
  presencePolicyDigest: string;
}): ContentSlotCoverageFactV2 {
  return {
    disposition: 'absent_not_applicable',
    slotId: input.slotId,
    contentVersionRef: input.contentVersionRef,
    presencePolicyDigest: input.presencePolicyDigest,
    producedBy: 'system',
  };
}

/** §11.6 stale rule: absence facts bind version/presence — any change invalidates them. */
export function assertAbsenceFactCurrent(
  fact: { disposition: 'absent_not_applicable'; slotId: string; contentVersionRef: BlobRefV2; presencePolicyDigest: string },
  current: { slotId: string; contentVersionRef: BlobRefV2; presencePolicyDigest: string },
): void {
  if (
    fact.slotId !== current.slotId ||
    fact.contentVersionRef.digest !== current.contentVersionRef.digest ||
    fact.presencePolicyDigest !== current.presencePolicyDigest
  ) {
    throw new SchemaError('AUTHORITY_BASE_STALE: optional-unset absence fact no longer binds the current version/presence policy');
  }
}

/* ------------------------------------------------------------------ */
/* Digest-based plan identity (§11.5)                                  */
/* ------------------------------------------------------------------ */

/** planRevisionId-equivalent plan identities never touch event-derived state. */
export function migrationPlanIdentityDigest(input: { migrationValidationPlanId: string; revision?: number }): string {
  return canonicalJsonSha256(input);
}
