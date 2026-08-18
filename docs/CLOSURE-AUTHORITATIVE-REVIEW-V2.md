# ForgeCore v2 权威审核 收尾总结

> 状态：✅ 已关闭生产接线与无界 real-mode hang；migration 全生命周期仍显式 fail-closed，不能宣称全部生命周期完成
> 日期：2026-08-18（复核更新）
> 原始收尾检查点：`e2d89f1`；real-mode 修复链：`49c4f8e` → `43fcc39`（文档更新后会产生新的文档提交）
> 范围：Task 22–29（Plan §6 Phase 7-8：系统交付→读 API→UI→模板迁移→故障矩阵→10k qualification→capability promote→真实 Case）

## 1. 结果快照

| 维度 | 状态 |
|---|---|
| `npm run check` | exit 0 |
| `npm test` | 110 files / 2016 passed / 1 skipped / 0 failed |
| `npm run build` | exit 0（vite + tsc server） |
| `npm run verify:structured-slots --capability production` | exit 0 |
| `npx tsx scripts/verify-authoritative-review.ts --capability production` | exit 0（authoritative-pi-preflight 10/10） |
| Capability | `authoritative_review_v1` status=**enabled**，profile digest `f4685a55...` |
| Worktree | `/Users/lzy/Desktop/ForgeCore/.worktrees/authoritative-slot-review-v2`，`git status` 干净 |

## 2. 提交链（Task 22-29，12 个 commit，从 `0768a00` 起）

```
2bde1c7 test: prove authoritative review real case (hermetic-only anchor)
e2d89f1 feat: wire the real-mode seam for authoritative review
6f075e7 feat: enable authoritative review runtime v1
f8c49ce fix: use import.meta.url for ESM-compatible workspace resolution in real-provider spec
e7b9fc6 test: align pre-Task-28 test fixtures with the enabled production capability
723b4ef test: cover promote path with fail-closed re-promotion guards
4bd0225 test: qualify disabled authoritative review runtime
8369cdc test: cover atomic-envelope fault injection, recovery matrix, genesis replay
c74fbb6 feat: migrate zhihu-salt-chapter-draft to authoritative v2
a7f197b feat: render the v2 review workspace as six read-only views
2d93013 feat: expose snapshot-stable authoritative v2 review APIs
af890a4 feat: deliver sealed system artifacts to the generic submitter
```

加之前审查后修复 7 个 commit（Task 21 P1#1–#7 + P2#8，HEAD `0768a00` 起），整链路 19 个 commit。

## 3. 8 项审查发现全部关闭 + 2 项 P2 主动加固

| 来源 | 状态 |
|---|---|
| P1#1 生产装配 | ✅ `fc8ad3d` 真实 registry + pass+execute tick 接入 mutation driver，集成测试从已提交 seal WorkItem 走完整链路 |
| P1#2 Seal Gate 系统推导 | ✅ `9cf0942` resolver 从投影+blob 闭包推导十条件，**总控补**：条件 5 fail-open 漏洞（blocking 关系按 Map+模板 enforcement 枚举）、optional-unset/adopted coverage fail-closed |
| P1#3 recipe 闭包 | ✅ `73748e1` 解析 11 ref、17 项一致性校验 |
| P1#4 custody 闭包 | ✅ `d3a5d8b` 真实 custody 对象 + crossCheck 全链解析（**总控补**：N1 补解析 `sealWarningCustodyRootRef`） |
| P1#5 不可伪造 capability | ✅ `d3a5d8b` `#private` + 闭包，旧 caller-string 路径删除 |
| P1#6 合并版本分配 | ✅ `cc1eb09` v1→v2→v1 = 1/2/3，单 v2 不变量 |
| P1#7 暂存竞态 | ✅ `e2c5724` per-writer tmp + 原子 rename 认领 |
| P2#8 warning custody | ✅ `9cf0942` seal_input advisory 入 custody，output 冻结空 |
| 总控额外 #1：N3 未知关系 typeId | ✅ `0768a00` 拒未声明关系类型 |
| 总控额外 #2：profile `artifact_custody` 同步 | ✅ `98114ea` |

## 4. 关键不变量（最终验证）

- ✅ **Agent 不可 Seal**：reviewer 无 `request_seal/finish_map_build/publish_artifact`；UI 21 个 mutation 方法遍历 0 命中
- ✅ **Seal 必经 10 项 Gate + `system:structured_seal` producer**（不可伪造 capability 闭包）
- ✅ **合并 v1/v2 artifact 版本分配**：`0+1 / 1+1 / 2+1 = 1/2/3` 单调，单 v2 不变量
- ✅ **两进程暂存不再删赢家**：per-writer tmp + 原子 rename 认领，loser 验证 winner 字节
- ✅ **共享 custody 闭包**：delivery→SealRecord→bundle→custody→artifact 任一缺失/篡改即 `TASK_CORRUPTED`
- ✅ **Capability enable 唯一合法路径**：唯一 `--promote-capability` 命令，re-promotion fail-closed
- ✅ **Capability 失配→executionEligibility=blocked**：事件不变，可恢复
- ✅ **Spec 不变量**：v1 路径零改动，archived v1 fixture 字节稳定，hermetic-only 实锚已落

## 5. 任务域交付

### Task 22 — 系统制品交付（`af890a4`）
- `system-artifact-delivery.ts`：`deriveV2Reachability` 纯函数 + `SystemArtifactDeliveryValidatorV2.validateFinalSubmission`
- final submission 原子批：`[final commit, generic attempt completed, work_item_completed]` 一次 `appendBatch`
- 9 条稳定 reason 闭包（delivery_missing/stale/consumed/submitter_mismatch/seal_work_item_not_completed/seal_record_missing/ref_mismatch/template_mismatch/custody_mismatch）
- artifact-drawer v2 系统 provenance 渲染（无伪造 source-node）

### Task 23 — 快照稳定 v2 只读 API（`2d93013`）
- 11 端点（map/candidate/tree/tree-locate/map-rounds/summary/rounds/slots/relations/findings/seal-readiness）+ legacy `issues` 兼容投影
- 快照游标：首页固定 `throughSequence + projection schema + authority baseline + filters digest + 确定性排序`，keyId 持久签名 + 轮换保留
- tree 非递归父页 + `hasMoreChildren` + locate seek cursor > 1000
- exactly-once 分页经 append/restart
- N+1/RSS 有界：单页 tree 恰好 1 次 blob 读，O(limit) RSS 与整树大小无关
- gateway/http/mock parity

### Task 24 — v2 只读审核工作区 UI（`a7f197b`）
- ProductionPage 按 workspace summary `structuredProtocol` v1/v2 选 drawer
- 六视图：overview / virtual-tree / relationship / review-rounds / findings / seal-readiness
- 纯 React 窗口化（无新依赖）+ lazy child load + locate 展开 + "新事件" 提示
- 关系 disabled/零 → "本 Map 未使用关系网"（非错误）
- **只读不变量**：21 个 mutation 方法遍历 0 命中 + `grep` 生产代码 0 命中

### Task 25 — 知乎 v2 迁移（`c74fbb6`）
- Contract v2：slotTypes/layoutGrammar + 3 关系类型（sequence/state_inheritance/information_dependency） + `relationshipPolicy: optional` + 4 v2 validators + assembler 严格等于 Task 21 `builtin.zhihu_chapter_markdown.v1` + `maxSlots: 10_000`
- Pipeline：`structuredReviewLifecycle.protocol=authoritative_review_v1` + `systemArtifactProducer: system:structured_seal`
- 删除 seal Agent/prompts/CJS render.cjs + validate.cjs
- hermetic 端到端 acceptance：Map chunks → 校验 → activation → batch → repair → plan_finalize → re-review → System Seal（精确 `chapter.md` 字节）→ SystemArtifactDelivery → Submitter final commit
- v1 archived fixture 字节稳定兼容

### Task 26 — 恢复/损坏/故障注入矩阵（`8369cdc`）
- `fault-injection.test.ts`（21）：11 §9.2 envelope × crash points + same-op replay + fresh-env restart 验证 stable recovery operation id
- `recovery.acceptance.test.ts`（17）：完整 §10.4 lifecycle 恢复矩阵 + Profile A/B blocked→A convergence
- `genesis-replay.test.ts`（64）：17 lifecycle digest 在 no-checkpoint replay 下稳定 + 7 corruption matrix 条目（missing formal blob / latest pointer JSON malformed / event ledger truncated / checkpoint byte-tampered / v1+v2 mixed）

### Task 27 — 10k qualification + 干净检查点（`4bd0225`）
- v2 acceptance 工具链：evidence-schema / integrated-benchmark-adapter / qualification-outputs / verify / benchmark / real-acceptance / e2e skeleton
- profile 从 `provisional` 提升到 `final`（digest `f4685a55...`）
- evidence 链 `source + final profile → platform → release → capability` 单向无环（profile 不嵌入 capability ref）
- 5 道 disabled-production 门：check/test/build/e2e + v1 structured 验收 + v2 injected 验收全 PASS
- 干净检查点 commit：所有实施 + final profile + archive + template/hash fixture + test/script/文档

### Task 28 — capability promote（`6f075e7`）
- 唯一 `--promote-capability` 命令，14 个 fail-closed 测试
- re-promotion fail-closed，off-allowlist dirty 拒绝，digest mismatch 拒绝
- enabled manifest 冻结 profileDigest + evidenceDigest + sourceTreeDigest + packageLockSha256 + checkpointCommit
- capability `authoritative_review_v1` **status: enabled**

### Task 29 — 真实 Pi+browser Case（`e2d89f1` + `2bde1c7`）
- 真实 mode 接缝：default preflight 返回 `REAL_PROVIDER_UNAVAILABLE`，`--allow-hermetic-only` 唯一豁免
- pure parser/validator/digest（35 tests）：17 成员 critical sequence 捕获、source-tree digest（exclude generated outputs）、ref-chain aliasing 拒绝、capability checkpoint digest
- hermetic-only evidence 已写：`docs/evidence/authoritative-review-real-case-v1.json`，`providerMode: hermetic-only`，所有 frozen digests 已对齐
- e2e spec env-gated `FORGE_AUTHORITATIVE_REVIEW_REAL_MODE=1`：默认 skip 10 + 通过 4 hermetic anchor
- API key 可用时只换 preflight，不重写一切

### 2026-08-18 real-mode 修复复核

- ✅ `production-composition.runTick()` 现在执行每一个 freshly leased WorkItem，Agent assignment 不再停在 lease/attempt-start。
- ✅ `CoreService` → `PiAgentRuntime.v2Tools` → `ProductionV2ToolRuntime` → `V2ToolFactory` 已形成同一 task/attempt-scoped 闭包；真实 HTTP 日志确认结构回合收到 4 个工具并实际调用了前两个 read 工具。
- ✅ listener/attempt timeout/provider error 具备脱敏日志和 durable retry/abort 语义；真实 provider 失败落成 `structured_agent_attempt_retryable_failed_v2` + `structured_work_item_retryable_failed`，不再无限等待。
- ✅ timeout 不再依赖 provider 配合 abort：协调器自有 deadline 会独立落 `ATTEMPT_TIMEOUT` retryable 事件，late provider result 被 settlement guard 丢弃；`stopTaskV2`、stop decision 与 shutdown 会中断同 task 的活动执行。
- ✅ runner 对空 `resultRefs` 返回 `V2_RESULT_REFS_MISSING` retryable outcome，协调器不再收到裸完成并抛出 HTTP 500。
- ✅ `npm run check`、生产 build、authoritative acceptance、Playwright HTTP 页面验收和相关回归均已执行；首轮全量 184 files / 4357 passed / 1 skipped 只有一个旧 I-2 断言需要同步到新 retry 契约，后续 coordinator 29/29、生产相关集合 137/137 全绿。
- ⚠️ `MigrationServiceV2` 尚未在生产 composition 中构造。迁移 system command 在已取得 lease/attempt 后返回 `MIGRATION_RUNTIME_NOT_WIRED` terminal fail-closed，而不是 `NOT_IMPLEMENTED` retry loop；这仍不是 lease 前能力门，初始 structure/map/generation/repair/review/seal 路径的证据不覆盖 migration 全生命周期。

## 6. 后续债务（非阻塞）

1. **N2** — 发布 recipe 未交叉校验 reviewBundle 内部 refs（执行期 resolver 兜底，不可利用）
2. **N4** — 旧 checkpoint 的 mergedArtifactVersion 归一（v2 尚未进生产）
3. **N5/N6** — 生产 composition 的 structure/map/generation/repair/map+content review/validator/seal 已改为真实 task-scoped services；`MigrationServiceV2` 尚未完成生产构造。迁移 command 在已 lease 后返回 `MIGRATION_RUNTIME_NOT_WIRED` terminal fail-closed，不再用 `NOT_IMPLEMENTED` retryable park 掩盖能力缺口；lease 前能力门仍是后续工作。
4. **N7** — 原先真实 Pi 0.82 + DeepSeek v4-flash reasoning 模型会卡在 `agent_attempt_started_v2` 后无界等待；当前 v2 tool seam 已接通，真实日志已看到 4 个工具和 read 调用，provider 失败会写 retryable envelope。剩余是 provider 成功写入工具结果的真实证据及 SDK/reasoning 长期兼容性优化。详见 [`docs/INVESTIGATION-AUTHORITATIVE-REVIEW-REAL-MODE.md`](INVESTIGATION-AUTHORITATIVE-REVIEW-REAL-MODE.md)。
5. **Task 29 real-mode provider** — hermetic-only 证据仍不能替代真实成功案例；当前真实 provider 已证明“可进入、可调用工具、可有界失败”，尚未证明 DeepSeek 在此模板上完成完整 Map。下一次 provider 稳定可用时应复跑 HTTP + persisted events + browser evidence。

## 7. 关键文件位置

- v2 模板：`templates/zhihu-salt-chapter-draft/`（contract.yaml, pipeline.yaml, agents/, prompts/）
- v2 runtime：`src/server/runtime/authoritative-review/`（production-composition.ts 是装配根）
- v2 纯域：`src/server/authoritative-review/`（seal-gate.ts 是十项条件权威源）
- v2 storage：`src/server/storage/authoritative-review-*`、`authoritative-append-facade.ts`、`authoritative-publication-store.ts`
- 工具链：`scripts/{authoritative-review-*,verify-authoritative-review,benchmark-authoritative-review}.ts`
- 证据：`docs/evidence/authoritative-review-{platform-profile,reference-runner,release,real-case}-v1.json`
- UI：`src/client/components/structured-review/` + `src/client/pages/production-page.tsx`
- 协议：`docs/superpowers/specs/2026-08-13-authoritative-per-slot-review-lifecycle-design.md` + `2026-08-14-authoritative-per-slot-review-lifecycle-spec.md` + `plans/2026-08-14-authoritative-per-slot-review-lifecycle.md`
- 计划任务：`docs/superpowers/plans/2026-08-14-authoritative-per-slot-review-lifecycle.md` Task 1-29
