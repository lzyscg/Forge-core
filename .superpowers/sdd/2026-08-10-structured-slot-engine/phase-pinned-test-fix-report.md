# Phase-Pinned Test Fix Report (Task 19 Step 1/9)

Date: 2026-08-12
Branch: `codex/structured-slot-engine-v1`

## Goal

Fix four unit tests that pinned the CHECKED-IN structured-slot phase
(`disabled` capability / `provisional` profile) so `npm test` is green BOTH
before and after the Task 19 production capability promotion. The checked-in
manifest is now `enabled` + profile `final` (qualification legitimately
succeeded); those files must STAY enabled/final. Converted the four tests to
EXPLICIT disabled/enabled fixture injection — phase-independent. No assertion
was weakened, no production code was changed, and the checked-in manifest and
profile were left untouched.

## Reproduced failures (before fix, `npm test -- --reporter=dot`)

```
FAIL src/server/api/structured-slot-routes.test.ts
  × structured-slot read-only routes > surfaces a stable TEMPLATE_RUNTIME_UNAVAILABLE for a disabled runtime
FAIL src/server/storage/task-store.test.ts
  × TaskStore structured mode > maps a gated structured template to TEMPLATE_RUNTIME_UNAVAILABLE, never TEMPLATE_NOT_FOUND
  × TaskStore structured mode > propagates TEMPLATE_RUNTIME_UNAVAILABLE when reopening a structured snapshot under a disabled runtime
FAIL scripts/verify-structured-slots.test.ts
  × runPromoteCapability > writes the ENABLED manifest for a clean all-zero-gate release (isolated temp workspace)
Test Files  3 failed | 105 passed (108)
     Tests  4 failed | 1990 passed | 1 skipped (1995)
```

Root cause: these tests exercised the DISABLED runtime path by omitting
`runtimeEnvironment` and relying on the production default reading the
CHECKED-IN manifest. With the manifest now enabled, the production default
LOADS a structured template (or returns a different outcome), so the four
assertions failed.

## Fixes (per test)

### 1. `src/server/api/structured-slot-routes.test.ts`
`surfaces a stable TEMPLATE_RUNTIME_UNAVAILABLE for a disabled runtime`
- The DISABLED reopen `CoreService` now injects
  `runtimeEnvironment: createDisabledRuntimeEnvironment()` (an explicit
  disabled fixture; never reads the checked-in manifest). Added a comment
  noting the explicit disabled fixture / phase-independence. The ENABLED
  freeze path still uses `createTestRuntimeEnvironment()`. The 503 +
  `TEMPLATE_RUNTIME_UNAVAILABLE` assertions are unchanged.

### 2. `src/server/storage/task-store.test.ts`
- `maps a gated structured template to TEMPLATE_RUNTIME_UNAVAILABLE, never
  TEMPLATE_NOT_FOUND`: the catalog is now created under
  `createDisabledRuntimeEnvironment()` so the structured template is gated.
- `propagates TEMPLATE_RUNTIME_UNAVAILABLE when reopening a structured
  snapshot under a disabled runtime`: the reopen `TemplateCatalog(paths, ...)`
  now injects `runtimeEnvironment: createDisabledRuntimeEnvironment()`.
- Test-support helper `catalogWithStructured` sanity check now only requires
  the fixture to initialize as `valid` when the injected environment is
  ENABLED (`isStructuredRuntimeEnabled`); a DISABLED environment is expected
  to gate it. Both TEMPLATE_RUNTIME_UNAVAILABLE assertions are unchanged.

### 3. `scripts/verify-structured-slots.test.ts`
`writes the ENABLED manifest for a clean all-zero-gate release (isolated temp
workspace)`
- The promote was already self-contained (manifest path + requiredAbis
  injected via `promotePaths(ws)` / the temp workspace manifest). The only
  phase-pinned statement was the trailing assertion that the checked-in
  production manifest `status` is `disabled`. Replaced it with a
  phase-independent "untouched" check: the real manifest is captured before
  the promote and asserted byte-identical after — proving `runPromoteCapability`
  never writes the production manifest, regardless of its phase. All
  happy-path assertions (status `enabled`, profile digest, evidence digest,
  requiredAbis) are unchanged and still validate a clean all-zero-gate release.

## Verification

- `npx vitest run src/server/api/structured-slot-routes.test.ts
  src/server/storage/task-store.test.ts scripts/verify-structured-slots.test.ts`
  → 3 files passed, 62 tests passed.
- `npm test -- --reporter=dot` full suite, 3 consecutive runs (determinism):
  108 files passed, 1994 passed, 1 skipped (1995 total) — identical each run.
  The 1 skip is the intentional release-command-only gate
  `it.skipIf(capabilityMode() !== 'production')` in
  `src/server/template/structured-slot-template.acceptance.test.ts` (only runs
  under `FORGE_STRUCTURED_CAPABILITY_MODE=production`); it is NOT a
  phase-pinned failure.
- `npm run check` (tsc --noEmit) → clean.
- `git diff --check` → clean.

## Commit

- `test: make structured runtime tests phase-independent explicit fixtures`
  (no push). Staged only the three test files + this report; the checked-in
  `runtime-capability-v1.json` (enabled) and `platform-profile-v1.json`
  (final) were NOT modified or committed.
