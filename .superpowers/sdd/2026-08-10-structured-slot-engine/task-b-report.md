# Task B — linear-time canonical JSON strings + single-pass bytes+sha256

Date: 2026-08-12 · Branch: `codex/structured-slot-engine-v1` · Implementer: claude agent (Task 19 remediation round)

## Root causes fixed

1. `src/server/structured-slots/canonical-json.ts` `serializeString` built the whole string with
   per-character `out +=` → V8 ConsString rope blowup (32 MiB child peaked ~1.25–1.36 GiB).
2. `src/server/storage/structured-slot-blob-store.ts` `putJsonBlob`/`putContentValue`/
   `putContentRevision` called `canonicalJsonBytes(value)` then `canonicalJsonSha256(value)` —
   the same payload was fully canonicalized (serialized + UTF-8 encoded) TWICE. `putGeneration`
   also serialized the index twice.
3. `scripts/benchmark-structured-slots.ts` `content-root-64mib` called `canonicalJsonSha256` +
   `canonicalJson` on the same content root — serialized twice.

## Changes

### `src/server/structured-slots/canonical-json.ts`
- `serializeString(s)` is now O(n): ONE linear pass validates every lone surrogate AND detects
  whether any char needs escaping. No escape needed → `return `"${s}"`` (single concat, the
  engine flattens O(n) with one allocation). Escape needed → chunk-collection pass (runs of raw
  chars via cheap SlicedString views + escape sequences) then one `join`. Escaped forms unchanged:
  `\"` `\\` `\b` `\t` `\n` `\f` `\r` and lowercase-hex `\u00xx` for other chars < 0x20. Valid
  surrogate pairs and all non-ASCII stay raw. The full custom JCS implementation (UTF-16 key
  sort, shortest-number `String(n)`, `-0 → 0`, lone-surrogate rejection, cycle detection,
  non-plain-object rejection) is untouched.
- NEW one-pass interface:
  `export function canonicalJsonBytesAndSha256(value): { bytes: Buffer; sha256: string }` —
  serializes once, UTF-8 encodes once, hashes the bytes once.
- `canonicalJsonSha256` and `canonicalJsonBytes` now delegate to `canonicalJsonBytesAndSha256`,
  so any caller that needs both pays once. Old signatures unchanged. Output is byte-identical
  (all 25 Task A JCS vectors + the new 29-test suite stay green).

### `src/server/storage/structured-slot-blob-store.ts`
- `putJsonBlob` / `putContentValue` / `putContentRevision`: one `canonicalJsonBytesAndSha256`
  call → `byteLength = bytes.length`, `sha256` from the same call.
- `putGeneration`: index now uses one `canonicalJsonBytesAndSha256(index)`; the `slots.map(canonicalJson)`
  NDJSON lines and the single `putJsonBlob(slots)` structure blob are inherently separate
  serializations and stay as-is (the blob write is now itself one-pass). The manifest write stays
  a single `canonicalJsonBytes`. The `readSlot` per-slot integrity check `canonicalJson(record) !== line`
  is unchanged.

### `scripts/benchmark-structured-slots.ts`
- `content-root-64mib` now calls the exported `measureContentRootOnePass(contentRoot, minByteLength)`,
  which uses `canonicalJsonBytesAndSha256` — the read-back byte length comes from the SAME bytes
  (no second `canonicalJson`). `digest.length === 64` and `byteLength >= contentRootBytes`
  assertions preserved.
- `canonicalJson` import removed (was only used by the old double-serialization pair).
- Stale `osMaxRssBytes` doc comment (the old "40x transient canonicalJson+sha256") updated.

### `scripts/canonical-json-probe.ts` (Task A helper)
- Now exercises the exact one-pass production path `canonicalJsonBytesAndSha256` and reports
  `bytes = bytes.length` from the result (no re-serialization, no precomputed constant).

## Tests (extended, none weakened)

| File | Change |
|---|---|
| `src/server/structured-slots/canonical-json.test.ts` | +4 tests for `canonicalJsonBytesAndSha256`: bytes/sha256 equal the individual functions across a diverse set (nested, control/escaped, surrogate pair, `-0`, `5e-324`, long plain string); determinism; 4 MiB plain-string byte-identical + fast; same invalid-value rejection. 25 → 29. |
| `src/server/storage/structured-slot-blob-store.test.ts` | +1 digest-pinning test: `putJsonBlob`/`putContentValue`/`putContentRevision` digests + byteLengths pinned to pre-change golden values (proves no digest drift through the one-pass rewrite). |
| `scripts/benchmark-content-root-one-pass.test.ts` | NEW. Mocks the canonical-json module with call-counting wrappers that delegate to the real implementation; asserts `measureContentRootOnePass` makes exactly ONE `canonicalJsonBytesAndSha256` call and NEVER calls `canonicalJson`/`canonicalJsonSha256`/`canonicalJsonBytes`, and that its digest/byteLength match the standalone functions. Also asserts `BENCHMARK_CONTENT_ROOT_FAILED` on a too-small payload. |

## Proof (exact outputs)

### 32 MiB regression — Task A RED now GREEN
`npx vitest run scripts/canonical-json-perf-regression.test.ts`
```
{"event":"canonical-json-probe","bytes":33554527,"payloadBytes":33554432,"wallMs":141.95,"peakRssBytes":214253568,"digest":"3beb0cb6..."}
{"event":"canonical-json-probe","bytes":1119,"payloadBytes":1024,"wallMs":0.17,"peakRssBytes":63930368,"digest":"345a6f..."}
✓ scripts/canonical-json-perf-regression.test.ts (2 tests)
```
- 32 MiB child: **peak RSS = 214,253,568 B (~204 MiB)**, wall = **141.95 ms**.
  Before: 1,349,632,000 B (~1.26 GiB), 1.73 s. Guard is 1 GiB — now 5x below.

### 64 MiB one-off probe (fresh child)
`node node_modules/tsx/dist/cli.mjs scripts/canonical-json-probe.ts --payload-bytes 67108864`
```
{"event":"canonical-json-probe","bytes":67108959,"payloadBytes":67108864,"wallMs":193.34,"peakRssBytes":401604608,"digest":"d1ad784c..."}
```
- 64 MiB fresh child: **peak RSS = 401,604,608 B (~383 MiB)**, wall = **193.34 ms** — comfortably
  below the 512 MiB qualification gate (383 / 512 MiB = 75%).

### JCS + digest stability
`npx vitest run src/server/structured-slots/canonical-json.test.ts src/server/storage/structured-slot-blob-store.test.ts`
```
✓ src/server/structured-slots/canonical-json.test.ts (29 tests)
✓ src/server/storage/structured-slot-blob-store.test.ts (13 tests)
```
- All 25 Task A JCS vectors byte-identical; pinned golden digests (e.g.
  `{title:'相同的规范载荷', nested:{a:[1,2,3]}}` → `48435ece...8c9` / 56 B) unchanged through the
  one-pass rewrite.

### Full suite + checks
```
$ npm run check            → tsc --noEmit, exit 0
$ git diff --check         → clean, exit 0
$ npm test                 → 104 files, 1968 passed | 1 skipped, exit 0
$ npm run benchmark:structured-slots -- --mode primitive-smoke → exit 0
  content-root-64mib p50 = 176.18 ms, p95 = 178.33 ms, max = 178.33 ms
```

## Digest-stability evidence
Golden digests computed with the PRE-change serializer and pinned in the blob-store test still
match after the rewrite: blob `48435ece...`, changed blob `130f91a2...`, content value
`b2583db8...`, revision root `98fa1b7a...` — byteLengths 56/18/41/119 identical. The one-pass
interface returns the same bytes as `canonicalJsonBytes` and the same sha256 as
`canonicalJsonSha256` for every value in the diverse test set.

## Concerns

- **100% scale RSS margin.** The fresh-child 64 MiB probe peaks at ~383 MiB, but the
  primitive-smoke (ONE process that RETAINS the 64 MiB setup string across 4 content-root units
  plus other cases) reached 519,110,656 B (~495 MiB), i.e. ~18–41 MiB under the 512 MiB gate.
  The integrated-scale child also retains the setup, so the 100% scale's content-root case will
  peak near ~495 MiB — passing but with a thin margin. Lower scales (75/50/25%) scale the content
  root down and are comfortable. If qualification at 100% needs headroom, a later task (D) may
  reduce the retained/transient copies (e.g. release the canonical string after Buffer
  conversion is not possible, but ordering/GC tuning or a scale-cap could be considered). This is
  NOT a Task B blocker: the fix removes the 1.25+ GiB rope blowup entirely.
- `canonicalJsonBytes` now computes a sha256 that callers needing only bytes discard (the task
  explicitly required implementing it in terms of the combined interface). All such callers
  (`tool-factory`, `evaluator-runner`, `draft-service`, `proposal-service`,
  `structured-slot-private-store`, the generation-manifest write) operate on small-to-medium
  values where the extra hash is negligible; no hot loop changed.
- The Task A subprocess regression now runs in ~0.36 s (was ~1.9 s) because the 32 MiB encode is
  ~12x faster; the wall guard (10 s) remains green as a durable backstop.

## Commit

```
perf: linear-time canonical JSON strings and single-pass bytes+sha256
```

Files: `src/server/structured-slots/canonical-json.ts`,
`src/server/storage/structured-slot-blob-store.ts`, `scripts/benchmark-structured-slots.ts`,
`scripts/canonical-json-probe.ts`, `scripts/benchmark-content-root-one-pass.test.ts`,
`src/server/structured-slots/canonical-json.test.ts`,
`src/server/storage/structured-slot-blob-store.test.ts` (no push).
The pre-existing `progress.md` modification and the allowlisted untracked
`docs/evidence/structured-slot-platform-profile-v1.json` are NOT committed.
