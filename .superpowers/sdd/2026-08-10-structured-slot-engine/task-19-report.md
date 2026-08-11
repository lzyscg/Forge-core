# Task 19 Report — Integrated Profile Qualification, Acceptance, and Production Enable

**Status: PARTIAL** (Steps 1-5 completed + honest Step 6 failure; no final profile frozen, capability stays `disabled`; Steps 7-10 not run)

- Date: 2026-08-11
- Branch: `codex/structured-slot-engine-v1`
- Checkpoint commit: `8c48b93` (`test: qualify disabled structured slot runtime`)
- Reference runner: `forge-ref-runner/v1-f2cc89b4` (Node v22.22.3, V8 12.4.254.21-node.56, darwin arm64, Apple M4, 10 cores, 16384 MiB)

## 1. Steps completed

| Step | Outcome |
|---|---|
| 1 — deterministic end-to-end fixture + acceptance | DONE. `src/server/template/structured-slot-template.acceptance.test.ts` drives the real CoreService/TaskScheduler/structured v3 runNext path with a scripted Agent runtime over the real closed Slot Tools (precharge + execute). Flow: structure → fill → no-op fill → Seal reliable failure → rework fill → Seal publish → v2 final submit. Assertions: final content derives from the sealed scaffold (`# Acceptance Title\n\nAcceptance body paragraph.`), task completes ONLY at `final_submission_accepted`, no-op Draft legal (merged, revision unchanged, no content blob). Agent Grant + local `task_owner` projections exercised separately. Pinned-status unit tests converted to pure disabled/enabled fixtures (`createDisabledRuntimeEnvironment` in runtime-capability.ts; runtime-capability / platform-profile / template-catalog / core-service-live tests no longer assert the checked-in phase). |
| 2 — crash and replay acceptance | DONE. Acceptance cases cover: fill-start crash before private draft materialization → `recoverDanglingAttempts` closes with exactly one `abandoned/crash_recovery` terminal + no terminal-without-opened; re-running recovery is a no-op; `appendBatch` replays the same commitId with a changed clock/random source — never a duplicate (one authority result). |
| 3 — security/source scans | DONE. ForgeAction registry is the original nine names; Slot Tool schemas carry no forbidden engineering keys (code-only scan, quoted-string form); `send_message.targetAgentId` exception stays limited to ForgeAction; evaluator modules carry no business fixture words; public issues carry no absolute path / secret key names / raw thinking. Task 14 locked-Pi 0.82 characterization (`forge-pi-slot-preflight/v1`) runs in `verify:structured-slots --acceptance-only` and its result feeds the release evidence path. |
| 4 — docs | DONE. `docs/ARCHITECTURE.md`, `docs/PROJECT-MAP.md`, `docs/IMPLEMENTATION-LOG.md` document the pure domain layer, mode split, EventStore batch files, structured task directory, Attempt/raw Pi meter boundary, local `task_owner` projection, Seal custody, provisional/final profile protocol, read-only UI, both final evidence paths, and explicitly state NO production story template was added and qualification had not passed at writing. |
| 5 — disabled verification + clean checkpoint commit | DONE. All commands exit 0 with the manifest `disabled` and profile `provisional` (details below). Committed as `8c48b93`; tree was clean after commit. |
| 6 — integrated reference benchmark | HONEST FAILURE. No 100/75/50/25% scale of the candidate axes satisfies every acceptance bound (see measurements below). NO final profile written, NO release evidence, capability manifest stays `disabled`. Failure evidence recorded at `docs/evidence/structured-slot-platform-profile-v1.json` (untracked). |
| 7-10 — qualify / promote / production re-verify / enable commit | NOT RUN (require a final profile from Step 6). |

## 2. Step 6 integrated reference benchmark measurements

> **SUPERSEDED by §9 (REOPEN addendum, 2026-08-11).** The measurements below are from the PRE-FIX run (global-peak leak + double-scaling); the corrected per-scale-isolated re-run is documented in §9. The actual, current failure evidence file is `docs/evidence/structured-slot-platform-profile-v1.json` (gitCommit `9ef95b4`, distinct per-scale peaks 2,735/2,838/2,858/2,269 MB, outcome `no_scale_passed`).

Evidence file: `docs/evidence/structured-slot-platform-profile-v1.json` (schemaVersion 1, mode `integrated-qualify`, outcome `no_scale_passed`; gitCommit `8c48b93`, source-tree/package-lock digests and dependency versions recorded inside).

Acceptance bounds applied: indexed slot p95 ≤ 25 ms; 10k tree match ≤ 2 s; content-root ≤ 2 s; Draft ≤ 2 s; 500 issue projection ≤ 250 ms; 64 MiB Seal ≤ 30 s; peak RSS ≤ 512 MiB (536,870,912 bytes); no case exceeds its bound.

Per-scale case results (p50 / p95 / max ms, except where noted):

| Case | 100% | 75% | 50% | 25% |
|---|---|---|---|---|
| schema-compile | 2.18 / 6.03 / 6.03 | 1.68 / 5.34 / 5.34 | 1.91 / 7.22 / 7.22 | 1.58 / 7.33 / 7.33 |
| grammar-compile | 0.46 / 0.50 / 0.50 | 0.22 / 0.25 / 0.25 | 0.22 / 0.26 / 0.26 | 0.16 / 0.22 / 0.22 |
| tree-match-10k | 2.60 / 6.39 / 6.39 | 1.05 / 3.03 / 3.03 | 0.46 / 0.51 / 0.51 | 0.44 / 0.49 / 0.49 |
| content-root | 4949.86 / 4965.13 | 4655.45 / 4902.93 | 2655.48 / 2681.68 | 1374.67 / 1388.72 |
| draft-journal-2k | 2.97 / 5.53 / 5.53 | 3.15 / 5.83 / 5.83 | 3.63 / 6.25 / 6.25 | 2.37 / 4.42 / 4.42 |
| validator-fanout-10k | 13015.15 | 12741.25 | 10971.65 | 12492.21 |
| authorized-projection-500-issues | 358.53 | 254.66 | 127.77 | 64.19 |
| seal-assembler-custody (64 MiB) | 2000.59 | 1363.79 | 584.17 | 204.41 |
| batch-recovery | 967.46 | 594.25 | 403.78 | 133.66 |
| indexed-slot-read (p95) | 3.52 | 3.93 | 1.55 | 1.87 |
| **peak RSS (bytes)** | 2,620,227,584 | 2,714,386,432 | 2,714,386,432 | 2,714,386,432 |

Scale verdicts:
- 100%: FAIL — content-root (4.97 s > 2 s), projection (358 ms > 250 ms), peak RSS 2.62 GB > 512 MiB.
- 75%: FAIL — content-root (4.90 s > 2 s), projection (255 ms > 250 ms), peak RSS 2.71 GB > 512 MiB.
- 50%: FAIL — content-root (2.68 s > 2 s), peak RSS 2.71 GB > 512 MiB.
- 25%: FAIL — peak RSS 2.71 GB > 512 MiB only (content-root 1.39 s and projection 64 ms pass at 25%).

Conclusion: even at 25% of every candidate axis, peak RSS (≈2.71 GB) exceeds the 512 MiB bound — the content-root path (`canonicalJson` + SHA-256 over the payload) allocates roughly a 40x multiple of the payload size in this host/V8 build. The harness's expectation is confirmed: no scale can satisfy the 512 MiB bound on this runner.

## 3. Was a final profile frozen?

**NO.** The checked-in `src/server/structured-slots/platform-profile-v1.json` remains `status: provisional` with `evidenceDigest: null`. The integrated-qualify wrote only the failure evidence; it never rewrote the profile.

## 4. Was the capability manifest enabled?

**NO.** `src/server/structured-slots/runtime-capability-v1.json` remains `status: disabled` with `profileDigest: null` / `evidenceDigest: null`. No release evidence was produced and no promote step ran (the only production enable path is `verify:structured-slots --promote-capability`, which is gated on a final profile).

## 5. Verification commands + exit codes (Steps 5 and 7 lists)

| Command | Exit | Notes |
|---|---|---|
| `npm run check` | 0 | tsc --noEmit |
| `npm test -- --reporter=dot` | 0 | 99 files, 1898 passed, 1 skipped (the skipped one is the Step 9 production-default acceptance test, gated on `--capability production`) |
| `npm run build` | 0 | vite + tsc server |
| `npm run e2e` | 0 | 44 passed, 10 skipped |
| `npm run verify:structured-slots -- --acceptance-only --capability injected` | 0 | structured acceptance (10) + locked-Pi characterization (10) |
| `npm run benchmark:structured-slots -- --mode integrated-qualify --profile src/server/structured-slots/platform-profile-v1.json --evidence docs/evidence/structured-slot-platform-profile-v1.json` | 6 | `BENCHMARK_INTEGRATED_BOUNDS: no scale passed every bound` |
| `npm run verify:structured-slots -- --qualify` | 1 | Correctly refuses (profile still provisional — a FINAL profile is required) |
| `npm run verify:structured-slots -- --promote-capability docs/evidence/structured-slot-release-v1.json` | 1 | Correctly refuses (release evidence does not exist) |
| `npm run verify:structured-slots` (no args) | 2 | Usage error |

`verify:backend` and `verify:runtime` were deliberately NOT called (stateful product-evidence writers excluded by the plan; their deterministic test/e2e coverage is included above).

## 6. Real bugs found and fixed during Step 1/6 (all in the Step 5 commit)

1. `src/server/runtime/structured-slot/tool-factory.ts` — `submit_structure_proposal` recorded its tool result AFTER the candidate freeze, which locks the proposal journal → `recordProposalTool` threw on a locked proposal, failing every real submit. `structureRecord` now records the meter first and tolerates the post-lock journal rejection (the submit is idempotent via `submitProposal`'s candidate replay).
2. `src/server/runtime/structured-slot/structured-committer.ts` — `buildSlotInstances` re-parented sibling slots under the previously-pushed sibling (`slots[slots.length - 1]` after recursion). Multi-child trees produced `document → title → body` instead of `document → [title, body]`. Fixed to capture the current node's slotId before the children loop; the existing committer test's `maxDepth: 2` pin (buggy shape) was corrected to `maxDepth: 1`.
3. `src/server/runtime/structured-slot/session-service.ts` — `createStructuredSlotDataSource.getSlot` returned the raw generation record (`contentPresence: unset` always), so the task_owner and seal read projections never saw committed content. It now overlays the committed content revision (cached per generation+revision).
4. `src/server/template/__fixtures__/structured-valid/slots/validators/validate.js` and `.../assembler/render.js` (and the new `structured-acceptance` fixture) — exported a bare `module.exports = function ...` instead of the sandbox's required `module.exports = { validate/assemble(...) }` shape; every real validator/Assembler execution failed with `unavailable/runtime`.

## 7. Recovery steps for a future qualifying host

A future run on a host that can meet the 512 MiB peak-RSS bound (or after a content-root memory-reduction in `canonical-json`/payload handling) should:

1. Re-run Step 6 from a clean checkpoint: `npm run benchmark:structured-slots -- --mode integrated-qualify --profile src/server/structured-slots/platform-profile-v1.json --evidence docs/evidence/structured-slot-platform-profile-v1.json`. The benchmark is honest: it tries 100/75/50/25% per candidate axis, freezes the GREATEST passing value, and refuses to freeze a higher one. It generates the profile evidence FIRST (no final-profile/release/manifest digest) then hashes that evidence into the final profile.
2. On a passing Step 6 (final profile written): run Step 7 `npm run verify:structured-slots -- --qualify` (validates the final profile + evidence, confirms the manifest is still disabled, re-runs the hermetic list, writes `docs/evidence/structured-slot-release-v1.json`).
3. Run Step 8 `npm run verify:structured-slots -- --promote-capability docs/evidence/structured-slot-release-v1.json` (validates checkpoint HEAD, source-tree/lock digests, profile evidence + final profile digest, required ABIs, and the exact 4-file dirty allowlist) — the only production enable path.
4. Run Step 9 (production default) `npm run verify:structured-slots -- --acceptance-only --capability production` plus the full hermetic list.
5. Commit only the four generated outputs with `feat: enable structured slot runtime v1`.

The current failure evidence (per-scale measurements, runner/source/lock digests) is preserved at `docs/evidence/structured-slot-platform-profile-v1.json` (untracked) so a future qualifying run can compare and never silently overwrite with casually measured numbers.

## 8. Addendum — final whole-branch review fixes (commit `14596e9`)

Applied ALL items from the final whole-branch review in one fix wave. The production capability manifest (`runtime-capability-v1.json`, `platform-profile-v1.json`) was NOT touched and stays `disabled` / `provisional`.

| # | Fix | Change |
|---|---|---|
| 1 | FIX_BEFORE_HANDOFF — proposal-service tree-walk depth short-circuit | `assertStorageSafeTree` and `runStructureGate` now short-circuit INSIDE the walk when `depth > maxTreeDepth` (and `nodes > maxSlots`) before recursing further, returning the stable `PROPOSAL_LIMIT_EXCEEDED` (with a `RESOURCE_LIMIT_EXCEEDED` issue) instead of a raw `RangeError`. Tests added: a 100k-deep chain fails with the stable code (never a `RangeError`); a deep-but-within-bound tree (exactly `maxTreeDepth`) still passes. |
| 2 | Minor — `git diff --check` clean | Removed the two trailing blank lines at EOF (`structured-slot-blob-store.test.ts`, `.../assembler/render.js`). `git diff --check main...HEAD` exits 0. |
| 3 | Minor — reserve custody bookkeeping names | `artifact-store.ts` `RESERVED_FILE_NAMES` now also reserves `manifest.json` and `seal-record.json` (in addition to `meta.json`). Test added: publishing/annotating an artifact file named `manifest.json` or `seal-record.json` is rejected with `INVALID_INPUT` and touches no disk. |
| 4 | Minor — fail closed on a differing-digest idempotent putGeneration | `structured-slot-blob-store.ts` `putGeneration` now throws `TASK_CORRUPTED` when an existing manifest for the same `generationId` carries a different `structure.sha256` (including the concurrent-writer `FILE_EXISTS` path) instead of silently falling through to the old manifest. Test added: same `generationId` with different canonical bytes → `TASK_CORRUPTED`; the committed manifest stays unchanged. |
| 5 | needs-documentation — meter read/write + committed retryable flag | (a) `attempt-meter.ts` aligns the snapshot parser to accept finite non-negative numbers for `validatorCpuMs` / `validatorWallClockMs` / `validatorOutputBytes` (fractional ms from ns/1e6) matching the writer, and documents the read/write contract plus the fact that a mid-attempt restart reload is unreachable today (attempts are abandoned on restart with a new turnId). Test added: fractional aggregates round-trip through a re-created meter. (b) `structured-committer.ts` adds a comment that the committed `agent_attempt_failed` `retryable: false` flag is display-only and scheduler auto-retry is driven by `RunNextResult.retryable`. NO behavior change. |

Proof (all exit 0):

| Command | Result |
|---|---|
| `npx vitest run proposal-service.test.ts structured-slot-blob-store.test.ts artifact-store.test.ts attempt-meter.test.ts` | 4 files, 68 passed |
| `npm run check` | 0 (tsc --noEmit) |
| `npm test` | 99 files, 1903 passed, 1 skipped (production-default acceptance, gated on `--capability production`) |
| `git diff --check main...HEAD` | 0 |

Committed as one fix commit `14596e9` (`fix: apply final whole-branch review fixes to structured slot engine`); working tree clean after commit.

## §9 REOPEN addendum — Codex independent acceptance fixes (2026-08-11)

Codex 独立验收发现 Task 19 benchmark/evidence/promotion 有阻断性缺陷。已修复（全部经独立对抗审查 + 修复轮闭合）：

- **P1-1 RSS 隔离**（commit 6b2c60b + 04422e5 + bf1f5c1 + 9ef95b4）：每档在 fresh child process 测量，`--mode integrated-scale` 子进程 + `osMaxRssBytes()`（ru_maxrss 自校准，darwin/linux 皆正确），每档用自己的峰值判定；`evaluateScaleReport` 对缺失必需 case 报 violation（不再默认 0 假 pass）；`child_failed` 中途失败也写失败证据；alloc-probe 隔离测试改为 margin-based 且强制提交页。
- **P1-2 双重缩放**（commit 6b2c60b）：adapter 只消费已缩放 limits，不再乘 scale；`integratedTaskLoad` 锁定真实负载；测试锁定 100/75/50/25% 负载。
- **P1-3 qualify/promote 门禁**（commit 4d94a96）：qualify 仅全部 gate exit 0 后原子写 release evidence（失败写 `.failed` 标记，不可被误认）；promote 先 exact-validate release evidence（schemaVersion/gate/mode/完整 gate 集/exitCode 0/digests/requiredAbis）+ 要求 success-shape profile evidence，任一异常 fail closed；负测覆盖失败/缺失/重复/非零 gate、错误 mode、任意 JSON+匹配 digest、no_scale_passed/child_failed evidence。
- **P2 evidence 完整性**（commit 6b2c60b + 04422e5）：evidence 从真实 CaseResult 生成（per-case warmup/samples/rawSampleDigest）+ 真实 disk bytes + exact schema 校验；失败证据必写 `docs/evidence/structured-slot-platform-profile-v1.json`。

### 纠正后 integrated qualification 重跑（从当前 HEAD 9ef95b4）

- 每档独立 child 峰值：100% = 2,735,226,880；75% = 2,838,052,864；50% = 2,857,517,056；25% = 2,269,495,296 bytes —— **各档独立、不再全局泄漏**。
- 各档 violations：100/75/50% 均含 content-root-64mib + authorized-projection-500-issues + peak RSS >512MiB；25% 含 authorized-projection-500-issues（>250ms）+ peak RSS 2.27GB >512MiB。
- **outcome = no_scale_passed**，exit 6。失败证据已写入（真实存在）`docs/evidence/structured-slot-platform-profile-v1.json`（untracked，允许清单内，未提交）。
- profile 保持 `provisional` + evidenceDigest null；capability manifest 保持 `disabled`。qualify（exit 1）、promote（exit 2）正确拒绝。
- **production structured runtime capability 最终状态：DISABLED。** 诚实结论：纠正后 benchmark 在本机仍无法满足 512 MiB peak-RSS 冻结界限（任何档）。

### 恢复步骤（合格 host）

见 §7。从干净 checkpoint 重跑 integrated-qualify（纠正后版本会自动做逐档隔离测量、诚实冻结最大通过档、写 evidence 再哈希进 final profile），然后 qualify → promote-capability → production re-verify → enable commit。若全部真实通过才能 enable。
