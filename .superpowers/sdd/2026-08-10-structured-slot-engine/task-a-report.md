# Task A — lock failure regressions (test-only, RED first)

Date: 2026-08-11 · Branch: `codex/structured-slot-engine-v1` · Implementer: opus-tier agent
Scope: TEST-ONLY — no production code changed. The three root causes are locked with tests BEFORE Tasks B/C/D touch production.

## Files created/changed (all test-only)

| File | Role |
|---|---|
| `scripts/canonical-json-probe.ts` | NEW hidden child helper (spawned by the regression test) — builds a content-root object, runs `canonicalJsonSha256` ONCE, prints `{event:'canonical-json-probe', bytes, payloadBytes, wallMs, peakRssBytes}` with the self-calibrating `osMaxRssBytes()` (ru_maxrss KB→bytes). |
| `scripts/canonical-json-perf-regression.test.ts` | NEW subprocess perf/RSS regression (spawn pattern from `benchmark-structured-slots.test.ts` alloc-probe). |
| `src/server/structured-slots/canonical-json.test.ts` | MODIFIED — added 8 semantic edge-case tests (lock, must stay green). 17 original + 8 new = 25. |
| `src/server/runtime/structured-slot/projection-service.bench.test.ts` | NEW projection cold/hot/pure separation measurement. |

No `src/` production file was modified. `npm run check` and `git diff --check` are clean.

## 1. Subprocess canonical-json perf/RSS regression — RED on current code

Child: `scripts/canonical-json-probe.ts` under `process.execPath node_modules/tsx/dist/cli.mjs` (same as the alloc-probe pattern). Payload: `{version:1, root:{slotId:'root', typeId:'document', contentPresence:'set', content:'x'.repeat(n)}}`, hashed once via `canonicalJsonSha256` (the exact `content-root-64mib` production path).

Observed against the CURRENT code (per-char `out +=` rope blowup):

| payload | peak RSS (`osMaxRssBytes`) | wall (`canonicalJsonSha256` once) |
|---|---|---|
| 8 MiB | 392 MB | 336 ms |
| 16 MiB | 693 MB | 654 ms |
| 32 MiB | **1,336,623,104 B = 1.25 GiB** | **1.69 s** |

Command + proof:

```
$ npx vitest run scripts/canonical-json-perf-regression.test.ts
{"event":"canonical-json-probe","bytes":33554527,"payloadBytes":33554432,"wallMs":1694.41,"peakRssBytes":1336623104,"digest":"3beb0c..."}
{"event":"canonical-json-probe","bytes":1119,"payloadBytes":1024,"wallMs":0.2,"peakRssBytes":63848448,"digest":"345a6f..."}
❯ scripts/canonical-json-perf-regression.test.ts (2 tests | 1 failed)
  × a 32 MiB content root stays under the 1 GiB peak-RSS guard (RED on the rope blowup)
    → expected 1336623104 to be less than 1073741824
```

- **RED bound: peak RSS.** 32 MiB child peaks at **1,336,623,104 bytes (1.25 GiB)** vs the **1 GiB (1,073,741,824) guard** → FAILS. (Two independent runs: 1,349,795,840 and 1,336,623,104, both > 1 GiB.)
- **Green bound: wall time.** 1.69 s < 10 s guard → PASSES. The 10 s wall guard is the durable protection against a re-introduced pathological serialization; it documents that the fix must beat it by ~10–100x.
- **Small-payload sanity PASSES** against current code: 1 KiB → peak RSS 63.8 MB (< 512 MiB), wall 0.2 ms (< 1 s). The fast path must not regress small values.

After Task B (native single-pass encode + Buffer + sha256), this host measures ~173 ms / ~380 MB RSS for a 64 MiB payload, so a 32 MiB payload will land far below both bounds — the test becomes green and stays a durable guard.

## 2. JCS semantic locks — all PASS on current code (25 tests)

Added to `src/server/structured-slots/canonical-json.test.ts` (no existing assertion weakened; 17 → 25):

- C0 control chars 0x00–0x1F → minimal form / lowercase hex: `\b \t \n \f \r` short forms, everything else `\u00xx` (exact full-32-char vector).
- U+2028, U+2029, DEL (U+007F) stay RAW (JCS never escapes them).
- Lone-surrogate rejection anywhere: `'\ud800x'`, `'x\udfff'`, `'\ud800\ud800'`, `'\udc00\udc00'`, lone high in object, lone low in array — all throw `CANONICAL_JSON_INVALID`.
- Valid surrogate pair `😀` (😀) emitted raw, alone and embedded.
- Number forms: `5e-324` (Number.MIN_VALUE), `-1e-7`, `1e-21`, `-0`→`0`.
- Key sorting by UTF-16 code-unit order for non-ASCII/astral keys: `{é:1,z:2}` → `{"z":2,"é":1}`, `{😀:1,z:2}` → `{"z":2,"😀":1}`, `{😀:1,😁:2}` → `{"😀":1,"😁":2}` (low surrogate DE00 < DE01).
- Long plain string (100k `x`, no escaping) round-trips byte-identically and hashes deterministically (the Task B fast-path precondition).
- `canonicalJsonBytes`/`canonicalJsonSha256` agree with `canonicalJson` for a nested value containing `5e-324` + non-ASCII + astral + `-0`, and for the long string.

Command + proof:

```
$ npx vitest run src/server/structured-slots/canonical-json.test.ts
✓ src/server/structured-slots/canonical-json.test.ts (25 tests)
```

## 3. Projection cold/hot/pure separation — PASS on current code

`src/server/runtime/structured-slot/projection-service.bench.test.ts` builds a real generation (root + 300 filled children, 16 KiB content blobs each) through `StructuredSlotBlobStore` + `EventStore` + committed `structured_scaffold_generation_committed` event, then wires `createStructuredSlotDataSource` + `StructuredSlotProjectionService`.

Observed (machine-readable probe lines):

```
{"event":"projection-probe","phase":"pure","wallMs":0.41}
{"event":"projection-probe","phase":"cold","wallMs":106.41}
{"event":"projection-probe","phase":"hot","wallMs":55.24}
```

- **PURE** 500-issue `projectStructuredVerdict` p95 = **0.41 ms**. Asserted < 100 ms (generous) and < 30 ms (concretely at least 10x below the integrated case's observed ~316 ms). This locks the separation so Task D can measure the verdict projection in isolation.
- **COLD** first `task_owner` outline (projection build + index read + full content hydration) = **106.41 ms**.
- **HOT** subsequent reads (content cache warm; MIN of 3 samples) = **55.24 ms**.
- Assertion `hotMs < coldMs` PASSES — cold > hot by ~1.9x on this run. The test deliberately does NOT gate on absolute values (they change with Task C); it locks the caching/separation as the lever.

Command + proof:

```
$ npx vitest run src/server/runtime/structured-slot/projection-service.bench.test.ts
✓ src/server/runtime/structured-slot/projection-service.bench.test.ts (2 tests)
```

## 4. Proof commands (summary)

```
$ npx vitest run scripts/canonical-json-perf-regression.test.ts
  → 1 failed (RED, peak RSS 1,336,623,104 > 1 GiB), 1 passed (1 KiB sanity)
$ npx vitest run src/server/structured-slots/canonical-json.test.ts
  → 25 passed
$ npx vitest run src/server/runtime/structured-slot/projection-service.bench.test.ts
  → 2 passed
$ npm run check
  → clean (tsc --noEmit, exit 0; src test files type-check)
$ git diff --check
  → clean (exit 0)
```

Full Task A set (`npx vitest run` over the three files): **1 failed | 28 passed (29 total)** — the single failure is the intended RED regression lock.

## Concerns / notes

- The 32 MiB subprocess child peaks at ~1.25–1.36 GiB transiently on the current code. It runs sequentially (one child at a time) and only in the regression test; a single run is ~1.9 s. Keep Task B/C/D runs on hosts with ≥ 4 GiB available.
- The wall-time guard (10 s) is intentionally generous; the RED evidence is the RSS guard. After Task B both guards must be green — if the fix's peak stays above 1 GiB at 32 MiB the test will keep failing, which is the point.
- The projection cold/hot margin (~1.9x) is dominated by the one-time full content hydration; the hot path still re-reads `index.json` + NDJSON ranges per slot (the N+1 I/O Task C targets). The test locks `hot < cold` (not absolute values) so Task C can cache the index without breaking it.
- `scripts/` files are not covered by `tsconfig.json` (by design); the src test file `projection-service.bench.test.ts` IS type-checked and passes.
- Only the four test files are committed. The pre-existing `progress.md` modification and the allowlisted untracked `docs/evidence/structured-slot-platform-profile-v1.json` are NOT committed.

## Commit

```
test: lock canonical-json perf/rss and projection separation regressions
```

Files: `scripts/canonical-json-perf-regression.test.ts`, `scripts/canonical-json-probe.ts`, `src/server/structured-slots/canonical-json.test.ts`, `src/server/runtime/structured-slot/projection-service.bench.test.ts` (no push).
