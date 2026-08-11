# Patch B Report — Codex finding P1-3: a failed qualification can still promote

Branch: `codex/structured-slot-engine-v1`
Date: 2026-08-11
Scope: `scripts/verify-structured-slots.ts`, `scripts/structured-evidence-schema.ts`, new `scripts/verify-structured-slots.test.ts`

## Summary

Patch B hardens the Task 19 two-phase gate so a failed qualification can never
promote:

1. `runQualify` now writes the release evidence ONLY after every gate exits 0,
   and writes it atomically (temp sibling + `renameSync`). A failed gate set
   returns 1, writes a clearly-marked `.failed-<timestamp>` failure record at a
   DIFFERENT path, and leaves a stale release evidence from a prior successful
   run untouched.
2. `runPromoteCapability` now exact-validates the release evidence schema at the
   TOP of the function (before ANY checkpoint/digest cross-check) via a new
   `validateReleaseEvidence(release, expectedGateIds)` in
   `structured-evidence-schema.ts`, and additionally requires the profile
   evidence to be the SUCCESS `integrated-qualify` shape (`validateProfileEvidence`)
   — the `no_scale_passed` / `child_failed` failure shapes are rejected.
3. The script is now importable/testable (direct-execution guard) with exported
   `runQualify`, `runPromoteCapability`, `gitCommit`, `cleanSourceDigest`,
   `packageLockSha256`, and injectable paths/deps so tests run against isolated
   temp workspaces without touching the checked-in manifest.

## What changed per finding

### `scripts/verify-structured-slots.ts`

- Added a direct-execution guard
  (`import.meta.url === pathToFileURL(process.argv[1] ?? '').href`) so tests can
  import the functions without running the CLI. Direct `npm run verify:structured-slots ...`
  behavior is byte-for-byte preserved (verified: usage error exits 2, `--acceptance-only
  --capability injected` exits 0).
- Exported `runQualify`, `runPromoteCapability`, `gitCommit`, `cleanSourceDigest`,
  `packageLockSha256`, `RELEASE_EVIDENCE_GATE_IDS`, and the `VerifyPaths` /
  `QualifyDeps` / `PromoteDeps` types.
- Added injectable `VerifyPaths` (profile/evidence/manifest/release-evidence paths
  + workspace root) and injectable `QualifyDeps.gates` / `PromoteDeps.porcelain`
  so tests can drive both commands against a temp workspace.
- `runQualify`: runs all gates first; builds the qualification record; on any
  non-zero gate writes `{schemaVersion:1, record:'qualify-failed', ...}` to
  `<releaseEvidencePath>.failed-<timestamp>`, prints the path, and returns 1
  (release evidence path untouched). On all-green, exact-validates the record
  with `validateReleaseEvidence` and writes it atomically via
  `writeFileAtomic` (temp sibling + `renameSync`).
- `runPromoteCapability`: step 0 is now strict schema validation of the release
  evidence; step 3 validates the profile evidence with `validateProfileEvidence`
  (success shape only) BEFORE the digest cross-check. Manifest write is now
  atomic and goes to the injectable path.

### `scripts/structured-evidence-schema.ts`

- Added `validateReleaseEvidence(value, expectedGateIds)`, the exact
  release-evidence schema validator.
- Added shared contract constants `RELEASE_PROFILE_EVIDENCE_PATH`,
  `RELEASE_FINAL_PROFILE_PATH`, `RELEASE_PI_PREFLIGHT_CHARACTERIZATION` so
  qualify and promote share one source of truth.

## The exact release-evidence schema

Top-level fields (unknown fields rejected):

| field | validation |
| --- | --- |
| `schemaVersion` | must equal `1` |
| `gate` | must equal `'verify:structured-slots'` |
| `mode` | must equal `'qualify'` (rejects `'integrated-qualify'`, missing, anything else) |
| `checkpointCommit` | 40-hex or 64-hex git commit id (see Concerns) |
| `sourceTreeDigest` | 64-hex |
| `packageLockSha256` | 64-hex |
| `profileEvidencePath` | must equal `'docs/evidence/structured-slot-platform-profile-v1.json'` |
| `profileEvidenceDigest` | 64-hex |
| `finalProfilePath` | must equal `'src/server/structured-slots/platform-profile-v1.json'` |
| `finalProfileDigest` | 64-hex |
| `requiredAbis` | non-empty array of non-empty strings |
| `piPreflightCharacterization` | must equal `'forge-pi-slot-preflight/v1'` |
| `gates` | non-empty array, each `{id,label,command,exitCode}` with no unknown fields and `exitCode === 0` (number, integer); the set of ids is EXACTLY `{typecheck, unit-tests, build, e2e, structured-acceptance, forge-pi-slot-preflight}` — no missing, no duplicates, no extras (specific missing/extra id reported) |
| `observedAt` | parseable ISO timestamp (`Date.parse` not NaN) |

## Negative tests (`scripts/verify-structured-slots.test.ts`, 25 tests)

- `runQualify`:
  - one gate `exitCode 1` → returns 1, does NOT write release evidence, writes a
    `.failed-<timestamp>` marker whose `record === 'qualify-failed'`.
  - failed qualification leaves a pre-existing stale release evidence untouched.
  - all-zero gates → writes release evidence that passes `validateReleaseEvidence`,
    and no `.failed-` / `.tmp-` residue.
- `validateReleaseEvidence` schema unit tests: unknown top-level field, wrong
  mode (`'integrated-qualify'`), missing mode, non-zero gate, missing gate,
  duplicate gate, extra gate, malformed 64-hex digest, wrong paths /
  characterization string, unparseable `observedAt`, empty `requiredAbis`.
- `runPromoteCapability`:
  - (a) non-zero gate rejected; (b) missing gate rejected; (c) duplicate gate
    rejected; (d) wrong mode `'integrated-qualify'` rejected;
  - (e) arbitrary JSON whose `profileEvidenceDigest`/`finalProfileDigest` match
    the real files but whose `gates` are missing → rejected by the schema
    validator with a `/gates/` error and the manifest stays disabled (proves the
    schema gate fires before any digest cross-check);
  - extra gate id rejected;
  - (f) profile evidence with `outcome: 'no_scale_passed'` or `'child_failed'`
    → promotion rejected, manifest stays disabled (the failure shapes still pass
    `validateProfileEvidenceFailure`, only the success validator is required for
    promotion);
  - requiredAbis mismatch with the current manifest rejected.
  - Happy path: a clean all-zero-gate release + matching temp files → returns 0,
    writes the ENABLED manifest in the temp workspace (`profileDigest` and
    `evidenceDigest` exact), and the checked-in production manifest is verified
    to remain `disabled`.

## Proof

```
$ npx vitest run scripts/verify-structured-slots.test.ts scripts/benchmark-structured-slots.test.ts
 Test Files  2 passed (2)
      Tests  46 passed (46)

$ npm run verify:structured-slots -- --acceptance-only --capability injected
 exit=0
 [verify-structured-slots] acceptance-only 全绿

$ npm run check
 check exit=0   (tsc --noEmit clean)

$ npm test
 Test Files  101 passed (101)
      Tests  1949 passed | 1 skipped (1950)

$ git diff --check
 (clean, exit 0)
```

## Concerns / deliberate decisions

1. **`checkpointCommit` width.** The finding text said `checkpointCommit` is a
   64-hex string, but this repository's git object format is SHA-1 (40-hex, e.g.
   HEAD `bf1f5c1fb1cbe4a3986c844355a8c2e86fec496a`). Enforcing a hard 64-hex
   would make a real `--qualify` → `--promote-capability` flow impossible. I
   reuse the schema's existing `requireGitCommit` (accepts 40-hex or 64-hex —
   the same rule already applied to profile-evidence `gitCommit`), so the
   validator is correct for SHA-1 today and SHA-256 repos if the project
   migrates. All other digests are strictly 64-hex.
2. **Dirty-tree check bypassed in tests via `PromoteDeps.porcelain`.** The happy
   path promote test injects `porcelain: () => []` because during development the
   real repo legitimately contains the very files Patch B modifies. The dirty-tree
   allowlist logic itself is unchanged and runs in production. This is the one
   test-only injection; all other validation runs on real code paths.
3. **Stale release evidence.** `runQualify` no longer writes on failure, and a
   failure record is written at `.failed-<timestamp>`. A stale release evidence
   from a prior successful run is left untouched; promotion re-validates
   `checkpointCommit` against current HEAD, so a stale evidence from a different
   checkpoint cannot promote.
4. **Untracked `docs/evidence/structured-slot-platform-profile-v1.json`** was
   present before Patch B (a `no_scale_passed` failure record from a benchmark
   run). It is a generated artifact, not part of Patch B, and is intentionally
   not committed.
5. **Test-only path injection.** `runQualify`/`runPromoteCapability` accept
   optional `paths`/`deps`; the CLI always calls them with defaults, so the
   production behavior is unchanged.
