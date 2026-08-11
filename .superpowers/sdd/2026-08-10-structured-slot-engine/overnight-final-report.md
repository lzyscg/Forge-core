# 结构槽引擎 v1 整夜自主开发 — 最终报告 (Overnight Final Report)

> 第 2 版（2026-08-11 REOPEN）——在 Codex 独立验收指出 Task 19 benchmark/evidence/promotion 阻断性缺陷后，已修复并经独立对抗审查与最终 whole-branch 复审（APPROVED）。

## 1. 总体状态

**PARTIAL**

- Task 1–18：全部 COMPLETE（每个 Task 均有独立 spec+quality 审查，修复循环闭合）。REOPEN 六个修复 commit 只触及 `scripts/`（0 处 `src/` 改动），Tasks 1–18 无回归。
- Task 19：PARTIAL —— Steps 1–5（离线 acceptance、崩溃/重放、安全扫描、文档、disabled checkpoint 提交）完成；**纠正后的**集成 reference benchmark 在本机仍无法满足冻结界限（任何档 peak RSS >512 MiB；25% 档另有 500-issue projection >250ms），因此 **没有冻结 final profile、没有 release evidence、production runtime capability 保持 DISABLED**。
- 诚实结果：不伪造 benchmark、不手写 final profile、不假造 release evidence、不启用 capability。纠正后的失败证据真实存在并 exact-validated。

## 2. 分支 / worktree / 提交

- Worktree: `/Users/lzy/Desktop/ForgeCore/.worktrees/codex-structured-slot-engine-v1`
- 分支: `codex/structured-slot-engine-v1`
- 起始 commit (approval baseline / MERGE_BASE): `16c9e5bb8ef8067aab5497600c101af10ee77c36`
- 最终 HEAD: `9ef95b4f5584ec45e5efec1b1369feb2178dde4f`（**33 commits**，含 REOPEN 6 个修复 commit）
- 未 push、未 merge 到 main、未创建 PR、未 release、未部署、未修改远程系统、未使用破坏性 git 操作。

## 3. Task 1–19 状态表

| Task | 状态 | 提交 | 独立审查 | 修复轮 |
|---|---|---|---|---|
| 1 contracts/canonical/issues | ✅ COMPLETE | f17a66c | ✅ Approved | 0 |
| 2 Safe Regex + Slot Schema | ✅ COMPLETE | 4a7977d | ✅ Approved | 0 |
| 3 Layout Grammar | ✅ COMPLETE | e3e95ec | ✅ Approved | 0 |
| 4 contract compiler | ✅ COMPLETE | 7987c70 | ✅ Approved | 0 |
| 5 v3/Loader/readiness | ✅ COMPLETE | 1f6a1b3 | ✅ Approved | 0 |
| 6 Event batch | ✅ COMPLETE | b0b3f34 | ✅ Approved | 0 |
| 7 structured storage | ✅ COMPLETE | 2ba7398 + 9ef053a | ✅ Approved | 1 |
| 8 evaluator/Gate | ✅ COMPLETE | e8e7086 + 8c67c4f | ✅ Approved | 1 |
| 9 provisional profile + benchmark | ✅ COMPLETE | ca0e182 | ✅ Approved | 0 |
| 10 Grant/projection | ✅ COMPLETE | 53ca989 | ✅ Approved | 0 |
| 11 Attempt coordinator | ✅ COMPLETE | f3c4a33 | ✅ Approved | 0 |
| 12 Structure flow | ✅ COMPLETE | 7e9cfbd | ✅ Approved | 0 |
| 13 Fill flow | ✅ COMPLETE | 65e05df + c17a1be | ✅ Approved | 1 |
| 14 Pi session integration | ✅ COMPLETE | f2f893d + d3fdd88 + 79a3c90 | ✅ Approved | 2 |
| 15 structured commit | ✅ COMPLETE | a2ace9b | ✅ Approved | 0 |
| 16 Seal custody | ✅ COMPLETE | 374512e + 6497835 | ✅ Approved | 1 |
| 17 scheduler/recovery/human | ✅ COMPLETE | 39a8be3 + e84d6e9 | ✅ Approved | 1 |
| 18 API/UI read-only | ✅ COMPLETE | 68c1da6 + e73e0f7 | ✅ Approved | 1 |
| 19 benchmark/qualification + capability | ⚠️ PARTIAL | 8c48b93 + REOPEN 6 commits | ✅ Approved (w/ 终审) | REOPEN 2 轮修复 |
| 终审 whole-branch | — | 14596e9 + 9ef95b4 | ✅ APPROVED (reopened) | 1 fix wave + REOPEN |

## 4. 每 Task 的 commits（REOPEN 六个修复 commit 高亮）

- T1–T18：同第 1 版（f17a66c … e73e0f7），未变。
- T19 checkpoint: `8c48b93 test: qualify disabled structured slot runtime`
- **REOPEN 修复**（只触 scripts/，0 处 src/）：
  - `6b2c60b fix: isolate per-scale benchmark RSS and single-scale integrated load`（P1-1 child-process 逐档隔离 + P1-2 单一缩放 + P2 evidence 真实元数据；新增 scripts/structured-evidence-schema.ts + scripts/benchmark-structured-slots.test.ts）
  - `04422e5 fix: fail missing bound cases, write child-failed evidence, and tighten evidence`（missing-case 假 pass 防护 + child_failed 失败证据 + candidatePercentage 枚举 + spawnSync maxBuffer）
  - `bf1f5c1 fix: drop duplicate failure-evidence message on no-scale-passed path`
  - `4d94a96 fix: gate release evidence on all qualify gates and exact-validate promotion`（P1-3 qualify 仅全绿后原子写 release evidence；promote 先 exact-validate；新增 scripts/verify-structured-slots.test.ts）
  - `9ef95b4 fix: make alloc-probe isolation test deterministic and margin-based`（flaky 回归测试修复）
- 终审修复波: `14596e9 fix: apply final whole-branch review fixes to structured slot engine`

## 5. 每 Task 独立审查 verdict

同第 1 版。REOPEN 额外独立对抗审查：
- Patch A（benchmark/evidence）：opus 级 reviewer **APPROVED**（P1-1/P1-2/P2 真实修复，无可达 false pass/fail）+ 1 Important（missing-case 假 pass）+ 4 Minor → 修复轮闭合（04422e5/bf1f5c1）+ scoped re-review 全 ADDRESSED。
- Patch B（verify qualify/promote）：opus 级 reviewer **APPROVED**（P1-3 链条端到端闭合）+ 5 Minor（全部非阻塞）。
- 整体 Task 19 链条（evidence→qualify→promote→enable + digest 链）：opus 级 reviewer **APPROVED_FOR_QUALIFICATION_RE_RUN**（seam 全 CLEAN，无 false pass/fail）。
- 最终 whole-branch（reopened）：opus 级 reviewer **APPROVED**（reopen 闭合、无回归、诚实 PARTIAL、链 CLEAN）。

## 6. Fix rounds

T1–T18 同第 1 版。REOPEN 修复轮：Patch A 1 轮（missing-case 防护等）+ flaky 测试 1 轮；Patch B 无修复轮（review 直接 APPROVED）。

## 7. 全量测试结果（harness 亲自运行，REOPEN 后）

- `npm run check` (tsc --noEmit)：exit 0
- `npm test -- --reporter=dot`：**101 files / 1949 passed / 1 skipped**（skip 为 `--capability production` 门禁测试）
- `npm run build`：exit 0（vite + tsc server）
- `npm run e2e`：**44 passed / 10 skipped**（real-provider 需真实 API key）
- `npm run verify:structured-slots -- --acceptance-only --capability injected`：exit 0（structured acceptance + 锁定 Pi characterization）
- `git diff --check main...HEAD`：exit 0
- 新测试：scripts/benchmark-structured-slots.test.ts 21/21；scripts/verify-structured-slots.test.ts 25/25（均 3 次连跑稳定）

## 8. REOPEN 集成资格重跑（纠正后 benchmark）结果

从干净 checkpoint（HEAD 9ef95b4）运行 `npm run benchmark:structured-slots -- --mode integrated-qualify --profile ... --evidence ...`：

- **每档独立 child 峰值（P1-1 隔离实证）**：100% = 2,735,226,880；75% = 2,838,052,864；50% = 2,857,517,056；25% = 2,269,495,296 bytes。
- 各档 violations：100/75/50% 含 content-root-64mib(>2s) + authorized-projection-500-issues(>250ms) + peak RSS(>512MiB)；25% 含 authorized-projection-500-issues + peak RSS(2.27GB > 512MiB)。
- **outcome = no_scale_passed**，exit 6。失败证据已写入（真实存在）`docs/evidence/structured-slot-platform-profile-v1.json`（untracked，允许清单内，未提交）。
- profile 保持 `provisional` + evidenceDigest null；manifest 保持 `disabled`。qualify exit 1（拒绝）、promote exit 2（拒绝）——正确。

## 9. Deviations / parked / blockers

同第 1 版 + REOPEN：
- REOPEN 六个 commit 全部只在 `scripts/`（benchmark/adapter/evidence-schema/verify + 2 个测试文件），0 处 `src/` 改动——满足"不改实现、不降界限"。
- 冻结界限（indexedSlot 25ms / treeMatch 2s / contentRoot 2s / draft 2s / projection 250ms / seal 30s / peakRSS 512MiB）与 candidate 数值未改。
- `checkpointCommit` 校验 40-or-64-hex（本仓库 SHA-1）——不削弱 gate（promotion 仍以 live HEAD 比对）。
- Patch B happy-path promote 测试注入 `porcelain: ()=>[]`（仅测试；生产 CLI 用真实 porcelain，allowlist 逻辑未变）。
- deferred minors 完整清单见 ledger `progress.md`；REOPEN 未引入新的 load-bearing 项。

## 10. Production capability 最终状态

**DISABLED**。`runtime-capability-v1.json` = `{"status":"disabled", ...null digests}`；`platform-profile-v1.json` = `status: provisional` + `evidenceDigest: null`。无环境变量/后门/测试注入以外的启用路径。promotion 唯一入口 `verify:structured-slots --promote-capability` 在无 final profile + 无 release evidence 时拒绝（exit 2）。

## 11. 恢复步骤（下一位 Agent 在合格 host 上启用）

1. 从干净 checkpoint（当前 HEAD 9ef95b4 或后续，tree 干净）运行：
   `npm run benchmark:structured-slots -- --mode integrated-qualify --profile src/server/structured-slots/platform-profile-v1.json --evidence docs/evidence/structured-slot-platform-profile-v1.json`
   纠正后版本：逐档 fresh child 隔离测量、缺失 case 假 pass 防护、诚实冻结最大通过档、先写 evidence 再哈希进 final profile。
2. 若全部 bounds 在某档真实通过（final profile 冻结）：`npm run verify:structured-slots -- --qualify`（仅全部 gate exit 0 后原子写 release evidence）。
3. `npm run verify:structured-slots -- --promote-capability docs/evidence/structured-slot-release-v1.json`（先 exact-validate release evidence schema + 完整 gate 集 + success-shape profile evidence，再交叉校验 checkpoint/source/lock/profile digest、requiredAbis、dirty allowlist）——唯一生产启用路径。
4. `npm run verify:structured-slots -- --acceptance-only --capability production` + 完整 hermetic 列表。
5. 只提交 4 个生成物：`platform-profile-v1.json`、`runtime-capability-v1.json`、`docs/evidence/structured-slot-platform-profile-v1.json`、`docs/evidence/structured-slot-release-v1.json`（`feat: enable structured slot runtime v1`）。

若任何 bound 仍失败，诚实 `no_scale_passed` 路径自动保持 provisional+disabled。

## 12. git status --short

```
?? docs/evidence/structured-slot-platform-profile-v1.json   （纠正后失败证据，生成物，允许清单内，未提交）
```

## 13. 声明

未 push、未 merge 到 main、未创建 PR、未 release、未部署、未修改远程系统、未使用破坏性 git 命令。专用分支 `codex/structured-slot-engine-v1`、worktree、SDD ledger 与报告已保留供用户检查。
