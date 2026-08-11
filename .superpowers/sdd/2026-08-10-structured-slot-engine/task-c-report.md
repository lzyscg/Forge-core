# Task C — projection/Seal N+1 I/O fix (Task 19 performance remediation round)

Date: 2026-08-11 · Branch: `codex/structured-slot-engine-v1` · Implementer: opus-tier agent
Scope: cache generation indexes, separate content presence from hydration, lazy single-slot content reads, Seal/full-scaffold batch read, bounded-concurrency hydration. Capability manifest stays `disabled`; frozen bounds unchanged; no push/merge.

## Files changed

| File | Change |
|---|---|
| `src/server/storage/structured-slot-blob-store.ts` | Immutable per-generation `GenerationIndexV1` cache (deep-frozen, `evictGenerationIndex`); `readContentPresence` (root-only); `readEffectiveContent` bounded-concurrency; `readEffectiveContentEntry`/`readContentValue` (lazy single-slot); `readGenerationSlots` (one NDJSON open); `mapLimit` exported helper; optional instrumentation seam (3rd constructor arg). |
| `src/server/runtime/structured-slot/session-service.ts` | `createStructuredSlotDataSource` caches the projected event state (re-projects only on generation/revision mismatch) + the per-digest presence map; `getSlot(generationId, slotId, { withContent })` overlays presence WITHOUT hydrating content, and hydrates EXACTLY ONE blob lazily on a content-level read. |
| `src/server/runtime/structured-slot/projection-service.ts` | Data-source seam `getSlot` gains optional `{ withContent?: boolean }`; `readSlot`/`readSlots` pass it only at content level outside the draft overlay (outline + ancestor shells never do). |
| `src/server/runtime/structured-slot/seal-service.ts` | `loadSlots` reads the index once + `readGenerationSlots` (one open) instead of per-slot `readSlot`. |
| `src/server/runtime/structured-slot/draft-service.ts` | `buildEffectiveSlots` (Merge Gate input) also uses `readGenerationSlots` (same N+1 pattern). |
| `src/server/runtime/structured-slot/projection-service.n1.test.ts` | NEW — 6 N+1 tests (list no-hydration / readSlot one blob / state-cache bounded / set-null content / mapLimit / bounded hydration). |
| `src/server/runtime/structured-slot/seal-service.n1.test.ts` | NEW — Seal batch read O(1) index + one NDJSON open. |
| `src/server/runtime/structured-slot/projection-service.bench.test.ts` | Comments updated to the Task C behavior (cold/hot no longer hydrate content); assertion unchanged. |

## RED evidence (measured against the PRE-FIX code via a probe)

A temporary probe wrapped the old blob-store methods on a real 100-slot committed generation (root + 99 children, each with a content blob) and counted calls. The old `readSlot` re-reads + re-parses `index.json` and opens `slots.ndjson` per call; the old data source re-projected the event list and hydrated ALL content blobs per `getSlot`/`getContentPresence`.

| Operation | blob reads | `readSlot` calls (index parse + NDJSON open each) | explicit `getGenerationIndex` | full `readEffectiveContent` |
|---|---|---|---|---|
| `task_owner` `listSlots(limit=64)` over 100 slots | **100** (hydrates every content blob) | **64** | 1 | 1 |
| `task_owner` `readSlot('n5')` (cold, one slot) | **100** (hydrates every content blob for ONE slot) | 2 | 1 | 1 |
| Seal full-scaffold path over 100 slots | **100** | **101** | 1 | 1 |

Probe output (verbatim):
```
{"event":"n1-red-probe","slots":100,"listCounts":{"readBlobCount":100,"readSlotCount":64,"getGenerationIndexCount":1,"readEffectiveContentCount":1},"readCounts":{"readBlobCount":100,"readSlotCount":2,"getGenerationIndexCount":1,"readEffectiveContentCount":1},"content":"content-n5"}
{"event":"n1-red-seal-probe","slots":100,"sealCounts":{"readBlobCount":100,"readSlotCount":101,"getGenerationIndexCount":1,"readEffectiveContentCount":1}}
```
So the outline read did 100 content-blob reads + 64 per-slot index parses/NDJSON opens; the Seal path did 101 index parses + 100 NDJSON opens + 100 blob reads. That is the N+1 the integrated benchmark measured (~316 ms cold / 245-60 ms hot for 500 issues).

## The fix

1. **Immutable `GenerationIndexV1` cache (per `generationId`)** — `getGenerationIndex` and `readSlot` now serve from a `Map<generationId, GenerationIndexV1>`; a miss reads + validates + deep-freezes + caches. The cached index is frozen so callers cannot mutate it; `evictGenerationIndex(generationId?)` is provided. Committed generations never change, so the cache is safe (new generations get new ids).
2. **Content presence separated from hydration** — new `readContentPresence(revisionRef)` reads ONLY the revision root (hash-verified) and returns the `slotId -> 'unset' | 'set'` map with zero blob reads. `readEffectiveContent` (Seal/Assembler/draft gate) still hydrates full content but now through `mapLimit(…, 16, …)`; `readEffectiveContentEntry(revisionRef, slotId)` hydrates exactly ONE blob; `readContentValue(digest)` reads one value blob.
3. **Data source caching** — `createStructuredSlotDataSource` caches the projected event state (re-projects only when the requested generation/revision does not match the cached state — one refresh before fail-closed) and caches the presence map per content-root digest. `getSlot` overlays presence from the cached presence map and does NOT hydrate content; a content-level read (`{ withContent: true }`) resolves presence + content through `readEffectiveContentEntry` (one root read, one blob read). `listSlots` and ancestor shells never pass `withContent`.
4. **Seal/full-scaffold batch read** — new `readGenerationSlots(generationId, index?)` opens `slots.ndjson` ONCE and reads every slot's byte range sequentially, reusing the caller's index. Per-record integrity is unchanged (bounds check, canonical re-serialization, index-consistent slotId). Seal `loadSlots` and draft `buildEffectiveSlots` now use it.
5. **Bounded concurrency** — exported `mapLimit<T, R>(items, limit, fn)` worker-pool helper; `readEffectiveContent` uses limit 16.

## AFTER counts (asserted by the new N+1 tests)

| Operation | index parses (`onIndexRead`) | NDJSON opens (`onSlotsFileOpen`) | content-blob reads (`onBlobRead`) | content-root reads |
|---|---|---|---|---|
| `task_owner` `listSlots(limit=64)` over 100 slots | **1** | 64 (per-slot single-range reads — design invariant) | **0** | **1** |
| `task_owner` `readSlot('n5')` | **1** | 1 | **1** | ≤ 2 (target entry + ancestor-shell presence; both root-only) |
| Seal `requestSeal` over 100 slots | **1** | **1** | **0** (all unset fixture) | 1 |

Data source state caching: a full `listSlots` + several direct `getSlot` calls + `getContentPresence` over the same generation fetches/projects the event list **once** (`eventsCalls ≤ 2`), never per slot.

## New primitives (public API additions; nothing removed/renamed)

- `mapLimit<T, R>(items, limit, fn)` — bounded-concurrency map (exported from the blob store).
- `StructuredSlotBlobStoreInstrumentation` — optional 3rd constructor arg: `onBlobRead`, `onIndexRead`, `onSlotsFileOpen`, `onContentRootRead` (test seam only; existing 2-arg constructions unchanged).
- `StructuredSlotBlobStore.evictGenerationIndex(generationId?)`.
- `StructuredSlotBlobStore.readContentPresence(revisionRef)`.
- `StructuredSlotBlobStore.readEffectiveContentEntry(revisionRef, slotId)`.
- `StructuredSlotBlobStore.readContentValue(digest)`.
- `StructuredSlotBlobStore.readGenerationSlots(generationId, index?)`.
- `StructuredSlotDataSource.getSlot(..., options?: { withContent?: boolean })` — optional third parameter (existing implementations remain compatible).

## Semantics preserved (verified by existing + new tests)

- Single-slot read still reads only the index + one byte range (existing 10k-slot single-range instrumentation test green).
- Content-addressed integrity: every blob/root read still re-verifies the path hash; `readSlot`/`readGenerationSlots` still require the NDJSON line to re-serialize canonically.
- Hidden-slot non-enumerability / D05 identical `SLOT_NOT_VISIBLE` / cursor + grant fail-closed in projection-service unchanged (projection-service.test.ts green).
- `listSlots` outline output (typeId/spec/presence/parent/shell/level) byte-identical — projection-service.test.ts green.
- A **set JSON-`null`** content value projects as `null` (not `undefined`) through a content-level read (new regression test; caught and fixed during the round).
- Seal tri-state, draft merge gate, tool-factory, committer, session-service all green.

## Proof

```
$ npx vitest run src/server/storage/structured-slot-blob-store.test.ts src/server/runtime/structured-slot/projection-service.test.ts src/server/runtime/structured-slot/seal-service.test.ts src/server/runtime/structured-slot/projection-service.bench.test.ts src/server/runtime/structured-slot/projection-service.n1.test.ts src/server/runtime/structured-slot/seal-service.n1.test.ts
  → 6 files / 47 tests passed

$ npm run check
  → clean (tsc --noEmit, exit 0)

$ git diff --check
  → clean (exit 0)

$ npm test
  → 106 files / 1974 passed | 1 skipped (production-default gate); full suite green

$ npx vitest run scripts/canonical-json-perf-regression.test.ts
  → 2 passed (no regression from the refactor)

Task A projection separation (still green):
  {"event":"projection-probe","phase":"pure","wallMs":0.24}
  {"event":"projection-probe","phase":"cold","wallMs":31.31}
  {"event":"projection-probe","phase":"hot","wallMs":14.55}
  (cold > hot holds; both are far cheaper than the pre-fix 106 ms / 55 ms — the one-time
   index/presence/state reads are now the only cold-vs-hot difference.)
```

## Concerns / notes

- The outline (`listSlots`) still opens `slots.ndjson` once per slot (the single-range-read design invariant, required by the existing 10k-slot instrumentation test). Task C removes the per-slot index re-parse, the per-slot event re-projection, and ALL content-blob hydration from the outline; Task D/E recalibrate the benchmark against the new costs.
- The data source caches the projected event state for its lifetime and re-projects only on a requested-generation/revision mismatch. All current production callers create the source per operation/request (core-service per read, task-runner per runNext), so the cached state is always current for the operation. A long-lived source that outlives a content-advancing merge would see the stale active revision only for `getActiveGeneration` (the merge also locks the draft, so no further reads occur); `getContentPresence`/`getSlot` still fail closed on a mismatched revision. Documented in the code.
- The instrumentation seam is a production-file addition purely for tests (optional 3rd constructor arg); it has zero effect when not supplied.
- `git diff --check` clean; the pre-existing `progress.md` modification (harness ledger) and the allowlisted untracked `docs/evidence/structured-slot-platform-profile-v1.json` are NOT committed.

## Commit

```
perf: cache generation indexes and separate content presence from hydration
```

Files: the 7 source files above + 2 new test files + bench-test comment updates (no push).

## Fix round (post-review) — Important stale-revision weakness + 4 minors

Committed on top of the original Task C commit. The quality review found ONE
Important weakness plus four cheap minors; all are fixed with a covering test.

### Important — data source served a stale pre-merge revision from a long-lived source

`createStructuredSlotDataSource` previously cached the projected event state
and re-projected only on a requested generation/revision mismatch. Because
`getSlot`/`getActiveGeneration` matched generation ONLY, a long-lived source
that outlived a content-advancing merge would serve the PRE-merge base
revision (the projection's `resolveView` would then fail `GRANT_STALE`, but
the direct source reads were wrong). Unreachable in production today (sources
are per-operation; a successful merge locks the draft), but it was a genuine
stale-cache read.

Fix (per-slot cost stays at zero):
- `getActiveGeneration` and `getContentPresence` are operation boundaries (the
  projection service calls them once per `listSlots`/`readSlot`/`readSlots` via
  `resolveView`). They now recompute the projected state from `options.events()`
  on EVERY call — one event read per projection operation, correct and cheap.
- `getSlot` continues to serve the slot record + presence overlay from the
  cached presence (immutable per content-root digest) WITHOUT re-reading
  events — correct because every projection operation re-establishes the view
  (`getActiveGeneration`) first, pinning the current revision, and events do
  not change within a single-process read. A generation mismatch still returns
  null (fail closed).

Covering test (`projection-service.n1.test.ts`): build a source, run
`getActiveGeneration` + a content-level `getSlot`, commit a merge (advance
contentRevision 0 → 1 with a new content root), then assert a FRESH
`getActiveGeneration` sees revision 1, `getContentPresence(gen, 1)` returns the
new presence AND returns a defensive copy (mutating it does not corrupt the
cache), a `getSlot('t1', {withContent:true})` returns the NEW content ('new
title', never the wrong-revision 'title'), a `getSlot('b1', {withContent:true})`
returns the newly-filled 'body', and a fresh projection operation with a grant
pinned to the old baseRevision 0 fails `GRANT_STALE` (projection-level
fail-closed holds).

### Minors

1. **Seal `loadSlots` set-null fall-through** (`seal-service.ts`):
   `entry?.content ?? slot.content ?? null` treated a set JSON-`null` as missing
   and fell through to the base record. Now presence-based:
   `presence === 'set' ? (entry?.content ?? null) : null`.
2. **`readGenerationSlots` index identity** (`structured-slot-blob-store.ts`):
   when a caller supplies the index, re-verify `index.generationId ===
   generationId` and throw TASK_CORRUPTED on mismatch instead of surfacing a
   misleading per-record error.
3. **`getContentPresence` defensive copy**: the method now returns
   `{ ...presence }` so a runtime caller cannot mutate the cached presence map
   (the covering test proves a mutation does not stick).
4. **Report claim corrected**: the previous claim that "`getSlot`/`getContentPresence`
   still fail closed on a mismatched revision" was inaccurate for `getSlot`; the
   corrected semantics are documented above (operation boundaries recompute,
   `getSlot` serves the operation-pinned cached presence).

### Bench robustness (same commit)

The Task A `cold > hot` bench flaked once under full-suite parallel load: the
single cold sample vs min-of-3 hot samples is sensitive to page-cache eviction
on the 301 NDJSON opens. The bench now warms the NDJSON pages once before
measuring (isolating the genuine one-time projection costs: state projection,
presence-root read, projection-path JIT) and takes the MIN over 5 hot samples.
Verified across two full-suite runs: cold ~75-78 ms > hot ~49-52 ms under load
(and ~29 ms vs ~15 ms isolated) — reliable margin, no flake.

### Proof (fix round)

```
$ npx vitest run src/server/runtime/structured-slot/session-service.test.ts src/server/runtime/structured-slot/projection-service.n1.test.ts src/server/runtime/structured-slot/seal-service.test.ts src/server/storage/structured-slot-blob-store.test.ts
  → 40 passed (incl. the new stale-revision covering test; projection N+1 = 7 tests)
$ npx vitest run projection-service.test.ts draft-service.test.ts tool-factory.test.ts structured-committer.test.ts projection-service.bench.test.ts
  → 89 passed
$ npm run check → clean
$ git diff --check → clean
$ npm test (full) → 106 files / 1976 passed | 1 skipped (ran twice, both green)
```

### Fix-round commit

```
fix: recompute data source operation state and harden seal/n1 edges
```
