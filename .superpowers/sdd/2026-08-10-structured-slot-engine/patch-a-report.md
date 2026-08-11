# Patch A — Task 19 benchmark/evidence fixes (P1-1, P1-2, P2)

Date: 2026-08-11
Branch: `codex/structured-slot-engine-v1`
Commit: `6b2c60b` — `fix: isolate per-scale benchmark RSS and single-scale integrated load`

Scope: three Codex independent-acceptance findings on the structured-slot
benchmark/evidence path. The capability manifest
(`src/server/structured-slots/runtime-capability-v1.json`) was NOT touched and
stays `disabled`. The frozen acceptance bounds (indexedSlot p95 ≤ 25 ms,
treeMatch ≤ 2 s, contentRoot ≤ 2 s, draft ≤ 2 s, issueProjection ≤ 250 ms,
seal ≤ 30 s, peak RSS ≤ 512 MiB) were NOT changed. No push/merge performed.

---

## P1-1 — Benchmark RSS isolation (fixed)

### Root cause
`benchmark-structured-slots.ts` folded every scale's peak into a single global
`state.peakRssBytes` and then used that global peak to judge/record the CURRENT
scale, so the Task 19 report's 75/50/25% rows all showed the 100% peak
(2,714,386,432) leaked forward. `measureCase` also only sampled
`process.memoryUsage().rss` AFTER each unit, which cannot capture the
during-operation peak (the 64 MiB canonicalJson+sha256 case allocates ~40x
transiently).

### What changed
- Added a hidden `--mode integrated-scale` subcommand that runs ONE scale's full
  measurement in a FRESH process and prints a single machine-readable
  `{event:'integrated-scale-result', scale, results:[CaseResult...],
  peakRssBytes, diskBytes}` JSON line, then exits 0. It takes `--scale <N>`
  `--adapter <path>`. It builds the scaled limits, the primitive setup AND the
  integrated adapter task, and runs ALL cases (primitive + integrated +
  indexed-slot-read).
- The child's `peakRssBytes` = `max(osMaxRssBytes(), perUnitRssSampling)`.
  `osMaxRssBytes()` uses `process.resourceUsage().maxRSS` with a
  **self-calibrating unit normalization**: the OS high-water mark can never be
  below the current RSS, so `raw < currentRss` proves the raw value is in
  kilobytes and multiplies by 1024; otherwise it is already bytes. This makes
  the normalization correct on Linux (KB) AND on this machine's Node
  v22.22.3 / macOS arm64 build, which ALSO reports `ru_maxrss` in kilobytes —
  the dispatch prompt's claim "darwin returns bytes" was empirically false here
  (verified: after a 578,535,424-byte allocation `maxRSS` was 564,976 = KB).
- `--mode integrated-qualify` is now the ORCHESTRATOR: it keeps the
  runner-identity + dirty-source-tree + provisional-profile preflight in the
  parent, then for each scale spawns a child via
  `spawnSync(process.execPath, [tsxCli, scriptPath, '--mode','integrated-scale',
  '--scale',N,'--adapter',adapterPath], {cwd:repoRoot, encoding:'utf8',
  timeout:600000})` where `tsxCli = resolve(repoRoot(),
  'node_modules/tsx/dist/cli.mjs')`. A child that exits non-zero or prints no
  parseable result is a stable `BENCHMARK_CHILD_FAILED` error. Each scale's
  verdict uses ONLY that child's own `peakRssBytes` (via a new pure
  `evaluateScaleReport(report, bounds)` function); per-scale `diskBytes` is the
  child's own reported value.
- Per-scale `diskBytes` is REAL on-disk bytes: the child walks its temp task
  root + snapshot + primitive fanout temp root (`sumDirectoryBytes`) after the
  whole scale run.
- `--mode alloc-probe` (hidden) reports a fresh process's own peak, used by the
  subprocess regression test.
- `--mode primitive-smoke` behavior unchanged.

### Child-spawn mechanism verification
- tsx CLI path verified present: `node_modules/tsx/dist/cli.mjs` (tsx 4.23.7).
- Direct child run: `--mode integrated-scale --scale 25 --adapter <abs path>`
  exits 0 and prints a single parseable `integrated-scale-result` line.
- Orchestrator-equivalent `spawnSync` simulation: status 0, one
  `integrated-scale-result` line parsed with `results.length === 10`,
  `peakRssBytes` and `diskBytes` populated.
- Full `--mode integrated-qualify` smoke run (after commit, clean tree): all 4
  scales ran in fresh children with DISTINCT per-scale peaks
  (100%: 2,667,462,656; 75%: 2,791,784,448; 50%: 2,614,345,728; 25%:
  2,119,942,144) — no leakage. No scale passed (honest RSS failure), the
  failure evidence was written to `docs/evidence/structured-slot-platform-profile-v1.json`
  (untracked, expected artifact), and the process exited 6
  (`BENCHMARK_INTEGRATED_BOUNDS`).

---

## P1-2 — Integrated benchmark double-scaling (fixed)

### Root cause
`benchmark-structured-slots.ts` `scaledLimits(percentage)` already built scaled
limits, then ALSO passed `scale: percentage/100` to
`createIntegratedBenchmarkAdapter`; `buildBenchTask` multiplied
`limits.structure.maxSlots * scale` and
`limits.payload.maxScaffoldPayloadBytes * scale` AGAIN — at 25% the actual load
was 6.25% (verified empirically before the fix: 250 slots instead of 2500, 4 MiB
content instead of 16 MiB).

### What changed (`scripts/structured-integrated-benchmark-adapter.ts`)
- Removed the `* scale` from `buildBenchTask`. `slotCount` uses
  `limits.structure.maxSlots` directly and `contentBytes` uses
  `limits.payload.maxScaffoldPayloadBytes` directly — exactly ONE scaling
  boundary (the harness's `scaledLimits`).
- Removed the `scale` option from the adapter interface/options and from the
  benchmark call site.
- The bench scaffold is a deliberately shallow stress fixture where every filled
  slot is a direct child of the root, so the layout grammar's `document`
  children ceiling is raised to `max(maxSlots, maxChildrenPerSlot)` in the
  bench contract so the depth-1 tree with `maxSlots` children can actually seal.
  This internal fixture ceiling does NOT alter the evidence `frozenLimits`
  (which remains the harness's scaled candidate limits).
- Batch recovery count: `Math.max(8, Math.floor(100*scale))` replaced with a
  fixed, documented `100` batches independent of scale (no limits axis for it).
- `buildBenchTask` and a new pure `integratedTaskLoad(limits)` are exported for
  the regression test.

### Verification
- A 25% bench task now builds with `slots.length - 1 === scaledLimits(25).structure.maxSlots`
  (= 2500) and `contentRootBytes === scaledLimits(25).payload.maxScaffoldPayloadBytes`
  (= 16,777,216), and the seal/projection/batch/indexed-read cases all pass
  (seal ~2.7 s, projection ~204 ms, indexed read ~4 ms, batch ~837 ms).

---

## P2 — Evidence completeness (fixed)

### Root cause
`benchmark-structured-slots.ts` hardcoded `warmupCount:1, sampleCount:1` and
per-case `samples:1, warmup:0`, inconsistent with the real CaseDefinitions, and
`state.diskBytes` never reflected real disk usage.

### What changed
- Evidence `cases[]` now carry each case's REAL `warmup`, `samples`,
  `sampleDigest` (canonical of raw samples), and p50/p95/max from the child's
  `CaseResult`.
- Top-level `warmupCount`/`sampleCount` are the ACTUAL totals summed across the
  frozen scale's cases (documented choice: sum, not max).
- `peakRssBytes`/`diskBytes` are the qualifying child's own values (real disk
  bytes walked from the child's temp roots).
- Created `scripts/structured-evidence-schema.ts` exporting
  `validateProfileEvidence(evidence)` (success shape) and
  `validateProfileEvidenceFailure(evidence)` (honest-failure shape). Both reject
  unknown fields at every level and validate schemaVersion===1,
  mode==='integrated-qualify', runner{runnerId,runnerVersion,descriptorDigest},
  gitCommit (40- or 64-hex), sourceTreeDigest/packageLockSha256 (64-hex),
  dependencyVersions, per-case shape, candidatePercentage, frozenLimits,
  bounds, perScaleResults (scale, results, peakRssBytes, diskBytes, violations,
  passed).
- Both validators are called BEFORE writing; a validation failure is a stable
  `BENCHMARK_EVIDENCE_INVALID` error.
- The honest-failure path STILL writes the failure evidence to the plan's
  evidence path (`docs/evidence/structured-slot-platform-profile-v1.json`) — the
  smoke run produced exactly this file (exact-validated, `outcome:
  'no_scale_passed'`, per-scale peaks, bounds, selectionReason).

---

## Regression tests (`scripts/benchmark-structured-slots.test.ts`, 17 tests)

- **P1-1 (a)** `evaluateScaleReport` pure-function isolation: a fake huge child
  report for scale 100 (peak 2,714,386,432) fails RSS while a small report for
  scale 75 (peak 300 MiB) passes on its OWN peak; a small peak never fails
  regardless of any other scale; per-case bound violations are flagged.
- **P1-1 (b)** subprocess isolation: spawns two children sequentially via
  `--mode alloc-probe` — one allocating 512 MiB, one allocating 0 — and asserts
  each reports its OWN peak (the no-alloc child stays below 256 MiB and far
  below the allocator child).
- **P1-2** load lock: `integratedTaskLoad(scaledLimits(N))` for N in
  [100,75,50,25] yields slotCount === `maxSlots` and contentBytes ===
  `maxScaffoldPayloadBytes` (no double scaling); plus a REAL 25% `buildBenchTask`
  whose built slots and content bytes equal the scaled limits (60 s timeout;
  ~14 s runtime — the 25% task writes ~2500 blobs).
- **P2** evidence schema: `validateProfileEvidence` accepts the exact success
  shape and rejects unknown top-level fields, malformed sourceTreeDigest,
  unknown per-scale fields, and missing frozenLimits; `validateProfileEvidenceFailure`
  accepts the exact failure shape and rejects unknown fields / wrong outcome.

---

## TDD evidence

- Demonstrated the double-scaling bug empirically BEFORE the fix (25%: 250 slots
  / 4 MiB instead of 2500 / 16 MiB; 100% capped by maxChildrenPerSlot at 1000).
- Demonstrated the darwin `maxRSS` unit claim was false (Node 22.22.3 / macOS
  arm64 returns kilobytes), driving the self-calibrating normalization.
- The alloc-probe subprocess test and the load-lock test were written against
  the new API; the subprocess test initially failed (`unknown mode
  'alloc-probe'`) until the helper existed, and the load-lock assertions fail
  against the old double-scaling behavior.
- Discovered and fixed a vitest/jsdom transform issue: the new variable dynamic
  import `import(args.adapter)` makes vite's web-mode import-analysis inject
  `__vite__injectQuery(...)` + a `/@vite/client` import, which was prepended
  BEFORE the file's `#!/usr/bin/env node` shebang and broke the parse when tests
  import the module. Fixed by removing the now-unnecessary shebang (the script
  is always invoked via `tsx`); `@vite-ignore` suppresses vite's static-analysis
  warning but not the rewrite, so the comment documents that.

---

## Proof commands + outputs

- `npx vitest run scripts/benchmark-structured-slots.test.ts`
  → `Test Files 1 passed (1)`, `Tests 17 passed (17)`.
- `npm run benchmark:structured-slots -- --mode primitive-smoke`
  → exit 0, machine-readable JSONL (`summary` line with
  `"event":"summary","mode":"primitive-smoke"`).
- `npm run check` (`tsc --noEmit`) → clean (covers `src/`; `scripts/` is not in
  tsconfig include — validated by tsx execution of every mode and the test
  suite).
- `npm test -- --reporter=dot` → `Test Files 100 passed (100)`,
  `Tests 1920 passed | 1 skipped`.
- Smoke `--mode integrated-qualify` (after commit) → all 4 scales ran in fresh
  children; each scale judged on its OWN peak; no scale passed; honest failure
  evidence written to `docs/evidence/structured-slot-platform-profile-v1.json`
  (untracked, exact-validated); exit 6 `BENCHMARK_INTEGRATED_BOUNDS`.

---

## Concerns / notes

- The honest RSS failure is expected and correct: even a fresh 25% child peaks
  at ~2.1 GB during the content-root transient (the `canonicalJson` string
  builder's 16M single-char appends) — this is a REAL measurement, not a
  fabricated one. The isolation fix is about measurement correctness; it does
  not make the bound pass.
- The untracked `docs/evidence/structured-slot-platform-profile-v1.json` is the
  expected failure-evidence artifact from the smoke run; it is in the benchmark's
  generated-output allowlist so the clean-tree preflight accepts it. It was not
  committed.
- `scripts/` is outside `tsconfig` include, so `npm run check` does not type-check
  the scripts; they are validated by tsx execution and the vitest suite.
- The bench contract's `maxChildrenPerSlot` is raised to `max(maxSlots,
  maxChildrenPerSlot)` internally so the depth-1 scaffold with `maxSlots`
  children can seal; the evidence `frozenLimits` still records the scaled
  candidate limits unchanged.

---

# Patch A follow-up — adversarial-review fixes (2026-08-11)

Commits on top of `6b2c60b`: `04422e5` (missing-case guard + child-failed
evidence + evidence tightening) and `bf1f5c1` (drop duplicate failure-evidence
message). Capability manifest untouched (`disabled`); frozen bounds unchanged.

## Important — `evaluateScaleReport` false-PASS on a missing required case (closed)

`evaluateScaleReport` used `byId.get(id)?.p95Ms ?? 0`, so a report missing a
required bound case defaulted that case's timing to 0 and PASSED. Fixed by
asserting every required case id is present (new `REQUIRED_BOUND_CASE_IDS`:
indexed-slot-read, tree-match-10k, content-root-64mib, draft-journal-2k,
seal-assembler-custody, authorized-projection-500-issues) and emitting a
`missing case <id>` violation when absent; timing bound checks are now guarded
by presence. TDD: the two new regression tests FAILED against the old code
(2 failed) before the fix, and PASS after.

## Minors (all closed)

1. **Mid-loop child failure writes `child_failed` evidence** — `runIntegratedQualify`
   now writes a distinct `outcome:'child_failed'` failure evidence (per-scale
   results collected so far, bounds, selectionReason) BEFORE throwing
   `BENCHMARK_CHILD_FAILED`; `validateProfileEvidenceFailure` accepts both
   `no_scale_passed` and `child_failed`. A shared `writeFailureEvidence` helper
   exact-validates before writing. Verified by a smoke run with a bogus
   `--adapter` path: the 100% child failed, the evidence file was written with
   `outcome:'child_failed'`, then exit 7.
2. **Actual MiB in case descriptions** — `seal-assembler-custody` description now
   computes `Math.round(limits.payload.maxScaffoldPayloadBytes/1048576)` MiB
   instead of hardcoding "64 MiB". Verified at 25%: `"16 MiB real
   Seal/Assembler/custody (Task 16) @ 25%"`. `content-root-64mib` was already
   dynamic. The evidence per-scale results carry these descriptions.
3. **candidatePercentage enumerated** — schema now requires null or one of
   {100, 75, 50, 25}; a regression test rejects 33.
4. **spawnSync maxBuffer** — raised to 64 MiB so a future >1 MiB child stdout
   surfaces as `BENCHMARK_CHILD_FAILED` instead of a raw
   `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. Also made the child resolve relative
   adapter paths against the repo root (robustness; the orchestrator passes
   absolute paths).

## Proof (re-run after fixes)

- `npx vitest run scripts/benchmark-structured-slots.test.ts`
  → `Test Files 1 passed (1)`, `Tests 21 passed (21)`.
- `npm run check` (`tsc --noEmit`) → clean.
- `npm test -- --reporter=dot` → `Test Files 100 passed (100)`,
  `Tests 1924 passed | 1 skipped`.
- Full `--mode integrated-qualify` smoke (real adapter, clean tree) → all 4
  scales ran in fresh children with distinct per-scale peaks (100%: 2,692,071,424;
  75%: 2,773,008,384; 50%: 2,330,361,856; 25%: 2,070,315,008), no scale passed,
  `no_scale_passed` failure evidence written, exit 6.
- `child_failed` smoke (bogus adapter) → `child_failed` evidence written, exit 7.

## New regression tests (4 added, total 21)

- `evaluateScaleReport` FAILS a report missing one required case (missing-case
  violation, no false pass).
- `evaluateScaleReport` lists every missing required case in one verdict.
- `validateProfileEvidence` rejects a candidatePercentage outside {100,75,50,25}.
- `validateProfileEvidenceFailure` accepts the `child_failed` shape.

---

# Patch A follow-up 2 — flaky alloc-probe isolation test (2026-08-11)

Commit `9ef95b4` on top of `4d94a96` (which itself added the P1-3 release-
evidence gating, out of scope here).

**Problem:** the "no-alloc child after a 512 MiB allocator stays far below it"
test was absolute-fragile. `Buffer.alloc(512 MiB, 1)` did not reliably commit
physical pages on this host (overcommit), so the big child's peak could come in
at ≈498 MiB and `expect(big.maxRssBytes).toBeGreaterThan(512 MiB)` failed. The
isolation mechanism was fine; the test threshold was the bug.

**Fix:**
- `runAllocProbe` now force-touches every 4 KiB page of the buffer (a byte write
  per page) so the allocation RELIABLY commits physical memory regardless of OS
  overcommit heuristics.
- The test allocates 1 GiB and asserts ROBUST margins instead of an absolute
  peak: `small.maxRssBytes < 256 MiB` AND
  `big.maxRssBytes - small.maxRssBytes > 256 MiB`. This proves the RELATIVE
  isolation (a fresh child's peak is its own baseline, not the prior child's
  ~1.1 GiB peak) without depending on overcommit-friendly absolute thresholds.

**Verification:** `scripts/benchmark-structured-slots.test.ts` passed 3/3
consecutive runs (21 tests each); full `npm test` → 101 files, 1949 passed |
1 skipped; `npm run check` clean.
