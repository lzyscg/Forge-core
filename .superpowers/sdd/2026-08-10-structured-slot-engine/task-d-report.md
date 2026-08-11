# Task D Report — Calibrate the benchmark's real boundaries

Status: DONE
Branch: `codex/structured-slot-engine-v1`
Commit: `a779ce0` `perf: measure the pure authorized projection and add outline diagnostics`

## 1. What changed and why

The pre-fix `authorized-projection-500-issues` integrated case mixed cold
projection-service build + owner outline + a single slot read INTO the same
sample as the pure 500-issue `projectStructuredVerdict`, so its ~316 ms at 25%
did NOT measure what the 250 ms `issueProjectionMaxMs` bound targets. Task D
calibrates the benchmark so the bound honestly measures the intended workload,
adds per-case diagnostics, and records the Task A cold/hot/pure separation as
diagnostic cases instead of silently dropping them. No frozen bound is
weakened or removed; no capability is enabled; the total child peak RSS remains
the authoritative 512 MiB gate.

## 2. Adapter split (`scripts/structured-integrated-benchmark-adapter.ts`)

`IntegratedBenchmarkCasesV1` now exposes six methods:

- `runAuthorizedProjection500Issues()` — **PURE** authorized verdict projection:
  builds the 500-issue `StructuredVerdictV1` (same construction as before) and
  calls `projectStructuredVerdict(verdict, { visibleLocationKinds:
  ALL_LOCATION_KINDS })`. NO projection-service build and NO listSlots/readSlot
  I/O. This is the case the 250 ms bound gates.
- `runOwnerOutlineCold()` — FIRST `task_owner` `listSlots({kind:'task_owner'},
  null, outlineLimit)` over the real task (outlineLimit = `maxSlots + 1` so the
  whole outline is read in one page): projection build + generation-index read
  + presence-root read + per-slot NDJSON reads.
- `runOwnerOutlineHot()` — SUBSEQUENT `listSlots` over the same task; the
  projection service, data source, generation index and presence root are
  cached, only the per-slot NDJSON reads remain.
- `runSealAssemblerCustody64MiB()`, `runBatchRecovery()`, `runIndexedSlotRead()`
  unchanged.

`createIntegratedBenchmarkAdapter` accepts an optional
`StructuredSlotBlobStoreInstrumentation` (threaded to `buildBenchTask` and the
adapter's blob store) so the adapter test can count reads/opens.

## 3. Benchmark cases (`scripts/benchmark-structured-slots.ts`)

- `authorized-projection-500-issues` now uses `adapter.runAuthorizedProjection500Issues()`
  (the PURE projection) with `warmup: 3` / `samples: 10`; the bound check keeps
  `p95('authorized-projection-500-issues') > bounds.issueProjectionMaxMs` → violation
  (250 ms). The outline diagnostics are NOT gated on this bound.
- Two NEW DIAGNOSTIC cases (measured, recorded, NOT bound-gated):
  - `owner-outline-cold` — `warmup: 0` / `samples: 1` so the ONE recorded sample
    is the genuinely cold first read.
  - `owner-outline-hot` — `warmup: 1` / `samples: 5`.
- `REQUIRED_BOUND_CASE_IDS` stays EXACTLY the six frozen bound cases. A new
  `REQUIRED_DIAGNOSTIC_CASE_IDS = ['owner-outline-cold', 'owner-outline-hot']`
  is checked in `evaluateScaleReport`: a report missing a diagnostic FAILS with
  a distinct `missing diagnostic case <id>` violation (a regression that drops
  the diagnostics cannot silently pass) — but their timings carry NO bound.
- Per-case diagnostic in evidence: `CaseResult` now carries
  `postCasePeakRssBytes` — the cumulative child peak RSS AFTER that case
  (honest cumulative-per-case peak, NOT per-case process isolation). The total
  child peak (`Math.max(osMaxRssBytes(), scaleState.peakRssBytes)`) remains the
  authoritative 512 MiB gate; no per-case subprocess is spawned to evade it.
- The case definitions are factored into an exported
  `integratedScaleCaseDefinitions(percentage, limits, adapter)` so tests can
  assert the exact warmup/samples.

## 4. Evidence schema (`scripts/structured-evidence-schema.ts`)

- **Version decision: `schemaVersion: 1` kept** — the additions are additive
  fields and the exact validator was updated to the new exact field set (the
  least disruptive option; the frozen profile `evidenceDigest` flow is
  unchanged).
- Every success evidence `cases` entry and every per-scale result case now
  carries a REQUIRED `postCasePeakRssBytes` (non-negative safe integer).
- The success evidence `cases` array must contain ALL required case ids: the six
  frozen bound cases PLUS the two outline diagnostics
  (`REQUIRED_EVIDENCE_CASE_IDS`). A diagnostic-dropped success evidence fails.
- Per-scale RESULTS are NOT required to be complete (an honest failing scale's
  truncated report is still recorded), so the honest-failure path stays valid.
- Positive tests (valid extended success + failure pass) and negative tests
  (missing required case / diagnostic-dropped / unknown field / wrong-type
  `postCasePeakRssBytes` / missing `postCasePeakRssBytes`) were added in
  `scripts/structured-evidence-schema.test.ts` and
  `scripts/benchmark-structured-slots.test.ts`.

## 5. Tests

- `scripts/benchmark-structured-slots.test.ts`: `passingResults`/fixtures
  updated for the new case set; `REQUIRED_DIAGNOSTIC_CASE_IDS` imported; new
  tests: authorized-projection-500-issues uses warmup ≥ 3 / samples ≥ 10; the
  outline diagnostics are emitted; a report missing a diagnostic FAILS; a slow
  outline does NOT fail the bound verdict (only emission is required).
- `scripts/structured-integrated-benchmark-adapter.test.ts` (new): asserts
  `runAuthorizedProjection500Issues` performs ZERO blob/index/slot/content-root
  reads (pure projection only, via instrumentation), and that the warm outline
  is strictly cheaper than the cold first projection (hot < cold; cold does 1
  index read + 1 content-root read + per-slot NDJSON opens and 0 content-blob
  reads).
- `scripts/structured-evidence-schema.test.ts` (new): positive + negative for
  the extended schema.
- Task A projection-separation bench, canonical-json perf/RSS regression and all
  existing benchmark/schema/adapter/verify tests stay green.

## 6. Proof

- `npx vitest run scripts/benchmark-structured-slots.test.ts scripts/structured-integrated-benchmark-adapter.test.ts scripts/structured-evidence-schema.test.ts scripts/canonical-json-perf-regression.test.ts` — all green (41 tests).
- `npm run check` — clean.
- `git diff --check` — clean.
- `npm test` full suite — 108 files / 1994 passed / 1 skipped.

## 7. Docs sync (no frozen-value change)

- `docs/STRUCTURED-SLOT-ENGINE-DESIGN.md` §25.13 area and
  `docs/2026-08-10-structured-slot-engine-spec.md` §16 now clarify: the
  `issueProjectionMaxMs` (250 ms) bound measures the PURE authorized 500-issue
  verdict projection; owner-outline cold/hot are diagnostic measurements for the
  projection N+1 cost (no bound, only emission required); per-case
  `postCasePeakRssBytes` records the cumulative child peak; the total child peak
  RSS remains the 512 MiB authority. No frozen numeric bound changed.

## 8. Smoke observation (25% integrated-scale child)

Run on this host after Tasks B+C:

- `authorized-projection-500-issues` (PURE): p95 = 0.44 ms — the 250 ms bound
  now measures the intended operation (was ~316 ms mixed).
- `owner-outline-cold` = 132.6 ms / `owner-outline-hot` p50 = 119.4 ms
  (diagnostics emitted).
- `seal-assembler-custody` @ 25% = 283 ms (was 2660 ms pre-Task C).
- `content-root-64mib` @ 25% (16 MiB) p50 = 44.8 ms (was 1268 ms pre-Task B).
- Child peak RSS @ 25% = 489,504,768 bytes (~467 MiB) — under the 512 MiB gate.

See section 9 for the per-scale peaks at 50/75/100.

## 9. Per-scale peaks after Tasks B+C (direct `integrated-scale` children)

I did NOT run the full `integrated-qualify` orchestrator: with 25% now passing
every bound, it would freeze a FINAL profile — that is Task E's authority, not
Task D's. Instead I ran each `--mode integrated-scale` child directly (same
code path the orchestrator spawns) to confirm the new cases emit at every scale
and to report the honest per-scale peaks:

| scale | peak RSS (bytes) | ~MiB | content-root max | seal max | outline-cold max | outline-hot p95 | PURE projection p95 |
|---|---|---:|---:|---:|---:|---:|---:|
| 100% | 1,011,974,144 | 965 | 205 ms | 1,318 ms | 492 ms | 483 ms | 0.45 ms |
| 75%  | 1,043,693,568 | 995 | 162 ms | 1,015 ms | 366 ms | 349 ms | 0.75 ms |
| 50%  | 706,232,320 | 673 | 97 ms | 547 ms | 254 ms | 241 ms | 0.50 ms |
| 25%  | 489,504,768 | 467 | 51 ms | 283 ms | 133 ms | 123 ms | 0.44 ms |

(Pre-B/C peaks were 2.74 / 2.84 / 2.86 / 2.27 GB — a ~2-3x drop.)

All timing bounds now pass at EVERY scale (pure projection ~0.4-0.75 ms vs the
250 ms bound; content-root ≤ 205 ms vs 2 s; seal ≤ 1.3 s vs 30 s; indexed-slot
p95 ≤ 1.2 ms vs 25 ms; tree/draft well under 2 s). The RSS gate is the only
remaining discriminator: **25% is the only scale under 512 MiB** (thin ~22-45
MiB margin), so the qualification can now honestly freeze a 25% final profile —
a genuine outcome change from the pre-B/C "no scale passed". Task E should run
the clean-tree `integrated-qualify` to decide.

## 10. Concerns

- The 25% child peak (~467 MiB) sits within ~22-45 MiB of the 512 MiB gate —
  thin but under, and Task E must re-verify on a clean tree before freezing.
- `owner-outline` diagnostics at 100% read 10,001 slots (one NDJSON open each)
  — the largest non-`content-root` per-slot reader, but bounded (~0.5 s) and
  diagnostic-only.
- The per-case `postCasePeakRssBytes` is the cumulative per-scale peak after
  each case; it is a diagnostic and never a per-case bound.
- The full `integrated-qualify` orchestrator was intentionally NOT run in Task D
  because 25% now passes and would freeze a final profile (a Task E action).
