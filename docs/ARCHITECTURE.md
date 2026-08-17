# Forge Core 架构（当前 main，v7 + 结构槽 v1/v2）

> 状态：对齐当前磁盘代码、v7 产物版本目录制、结构槽 v1（`docs/2026-08-10-structured-slot-engine-spec.md`）与结构槽 v2 / 权威审核生命周期（`docs/superpowers/specs/2026-08-13-authoritative-per-slot-review-lifecycle-design.md` + `…-spec.md` + `…-plans/…-lifecycle.md`）。
> **v2 已交付并 enabled**：Plan 全部 29 个任务完成（Task 21 审查后修复 → Task 22-29 实施），`authoritative_review_v1` capability `status: enabled`，profile digest 冻结。详见 [`docs/CLOSURE-AUTHORITATIVE-REVIEW-V2.md`](CLOSURE-AUTHORITATIVE-REVIEW-V2.md)。
> 历史设计文档保留在 `docs/2026-08-0*.md`，不代表当前行为。

## 产品定位

Forge Core 是一个本地、单进程的多 Agent 内容生产平台：模板声明 Agent / Skill / 合法路由 / 产物结构；运行时驱动 Agent 串行协作；全过程在浏览器画布上可视化。核心理念是「中间层接管工程、模型只管内容」——**模型声明不权威，平台持有确定性否决权**。

## 核心不变量

1. **单进程单槽**：全进程同时只跑一个 Agent Turn；stop/abort 有界等待、stale 结果不提交。v2 由 attempt-coordinator + runV2SchedulingTick 调度 lease+execute。
2. **v2-only runnable**：唯一可执行回合契约是 `TurnContract.version === 2`；历史 v1 快照只读、gate 为 `incompatible`（`SCHEMA_V2_REQUIRED` / `TURN_CONTRACT_REQUIRED`），可 clone 到当前模板。结构槽 v2 用独立 `AuthoritativeStructuredTurnContractV4`（spec §6.4）。
3. **append-only events**：事件只追加不覆盖，ID 由平台派生（确定性重放/恢复）。v2 事件严格遵守 `AuthoritativeReviewEventV2` 闭包 union + `task-events.ts` 不变量（`task-events.ts:normalizeLegacyEvent` 隔离 v1）。
4. **版本单调递增**：`artifact_published` 是唯一 bump 版本的事件；annotate/forward/submit 零复制、不 bump。
5. **final 只由系统 gate**：`final_submission_accepted` 是任务完成的唯一来源；自然语言与普通 publish 不完成。
6. **9 动作封闭注册表**：`load_skill / finish_production(多文件) / annotate_artifact / read_artifact_version / publish_artifact / forward_input_version / submit_final_artifact / send_message / request_human_input`；模板只能做集合减法，不能注册新工具。
7. **模型不控制工程身份**：ID/版本/时间戳/路由/产物结构由系统拥有；动作参数面拒绝工程键。
8. **route / artifact / final 可达性由系统校验**：submit 需要沿已提交 artifact 边 + `agent_result.inputNodeId` 的闭包；人工 accept 走显式放宽（`humanAuthorized` 只由 scheduler accept 路径写）。
9. **raw provider thinking 永不落盘/上屏**：durable trace 只保留 phase / 公开文本 / tool_call（裁剪参数）/ tool_result；live 缓冲只有公开文本。
10. **模板是业务语义唯一来源**：`artifactSchema.extract` 决定展示槽位；`route.inject` 决定执行期供料；`finalOutput.submitters` 决定谁可提交。

## 数据流（一次执行）

```
TaskScheduler（全局单槽生命周期循环）
  → TaskRunner.runNext（一次一个输入节点 = 一个 Agent Turn）
      ├─ 输入组装：resolveIncomingDelivery（消息/产物/forward/合成）→ inject 供料 → checklist
      ├─ AgentRuntime（PiAgentRuntime 真实 / FakeAgentRuntime 测试）
      │    └─ ActionBuffer（回合阶段机：production / operate / coordinate）
      └─ ActionCommitter（不可绕过边界：阶段/契约/路由/可达性/交付门禁）
          → EventStore / ArtifactStore（追加 / 版本目录）
  → TaskProjector（事件折叠 → TaskWorkspace）→ API → Gateway → React UI
```

## 关键机制

### 回合形态（v7）
- **production 回合**：`finish_production`（多文件封存）→ `publish_artifact`（bump 版本，扇出 artifact 边）。
- **operate 回合**：可选 `annotate_artifact`（frontmatter verdict 双校验）→ `forward_input_version`（零复制转发）/ `send_message` / `submit_final_artifact`。
- **coordinate 回合**（总控）：`send_message` / `submit_final_artifact`，不封存不标注。
- 每回合恰好一个分发动作；`request_human_input` 可中断任意回合。

### 人工介入（supersede + synthesize）
- progress-guard 超限停车 → `human_requested.source = progress_guard`（结构化三选一）。
- continue/accept 提交序：`human_answered → pending_inputs_superseded → synthesize`（合成 agent_input 携带 guidance + 最新 inputVersion）。
- accept 给 controller 合成输入（`humanAuthorized=true`），走放宽闭包；模型 forward 永不传播 humanAuthorized。

### 无进展守卫
- `progress-guard.ts` 纯函数：窗口 = 最后一次 `human_answered` 之后，计数已提交回合数；超限（模板 `budget` 或注入策略）合成人工请求停车。

### 产物版本目录
- `artifacts/vNNN/{content.md|txt, revision.md, review.md, meta.json}`。
- 版本号 = 已提交 `artifact_published` 事件数 + 1；盘↔事件交叉校验（`ArtifactStore` 注入 `EventStore`）。
- `review.md` frontmatter `verdict: pass|reject`：工具层 + committer 双校验（仅格式契约，不 gate 路由）。

## 依赖方向

`src/shared`（契约，零依赖）← `src/server/storage` ← `src/server/template` ← `src/server/runtime` ← `src/server/api`；`src/client` 通过 `ForgeCoreGateway` 单向依赖 HTTP API，不反向引用 server。

## 结构槽引擎（structured_slots 模式，v1）

模板可选的第二种生产模式（`productionMode: structured_slots`），与既有 `basic` 并存，设计基准 `docs/2026-08-10-structured-slot-engine-spec.md`。核心不变量 1/3/4/6/8/10 仍适用；结构化「结构/布局/计量/校验/封存」由平台确定性接管，模型只管内容。

### 纯领域层边界
- `src/shared`（契约，零依赖）← `src/server/structured-slots`（canonical JSON、Slot Schema、LayoutGrammar、issues——纯领域，无存储/运行时依赖）← 存储原语（CorePaths、atomic-file、EventStore batch 文件、structured-slot stores）← 模板编译器（contract/hash/pipeline typestate）← 应用适配 ← 运行时（Attempt/coordinator、Grant、Slot Tool、Gate、Assembler、Committer）。

### 模式分叉
- `productionMode: basic | structured_slots`：basic 出现 slots/contract.yaml 或 v3 回合契约立即 `TEMPLATE_INVALID` 拒绝；structured 需要匹配的 enabled 运行时环境，在 Loader/TemplateCatalog、cache reopen、task snapshot 创建与 Scheduler（start/resume/retry/answer）同源复核，就绪缺失一律 `TEMPLATE_RUNTIME_UNAVAILABLE`，无环境变量/fallback 绕过。

### EventStore batch 文件
- `appendBatch` 一次原子写单个 `<first>-<last>-<commitId>.batch.json` 信封；legacy 单事件文件（`<seq>-<eventId>.json`）保持可读、basic `append()` 不变；reader 平铺两者为无空洞、无重复的 `CommittedEvent[]`。

### structured task 目录
- `tasks/<taskId>/structured-slots/{blobs,generations,content-revisions,proposals,drafts,attempts,custody}`：Proposal/Draft 私有 journal + checkpoint（不进主投影、无 lifecycle 终态）；generation `slots.ndjson` + `index.json`（单槽只读索引 + 对应行）；content revision 内容寻址（值单独 blob，merge 复用未变化部分）。

### Attempt / raw Pi meter 边界
- 锁定 Pi 0.82；raw `tool_execution_start` pre-validation seam 在 SDK TypeBox 校验**之前**对封闭 Slot Tool 名按 `(toolCallId, canonicalArgsHash)` 持久化 precharge；execute 只消费既有 precharge、不重复计费；schema-invalid/未授权/截断/改参均先达入口；所有 Slot Tool sequential。

### 本地 task_owner 只读投影（spec §14/O07）
- v1 本地单用户；UI/API 主体固定为内建 `task_owner` 完整只读审计视图；Agent 主体只用 Grant/AccessProfile；`task_owner` 永不看到私有 Proposal/Draft、Grant、实现源码与宿主路径。

### Seal custody
- stage/verify → unreferenced promote → 单一原子 TaskEvent batch（promote 先于 batch，batch 是唯一可见点）；内容身份 = task + scaffoldId + revision + snapshotHash + assembler digest + canonical input；缺文件/hash 不符 → `ARTIFACT_INTEGRITY_FAILED`（永不吸回槽内容）。

### provisional/final profile 协议（spec §5）
- checked-in 精确 profile JSON，identity `forge-structured-runtime/v1`；`provisional`（evidenceDigest=null，仅供 disabled build/测试）→ `final`（引用 integrated reference benchmark 证据 digest）；新 checkout 默认应为 `disabled`，生产启用需两阶段 clean-tree 协议；单向摘要链：clean source/reference runner → profile evidence → final profile → release evidence → capability manifest。
- 当前 `main` 的 checked-in manifest 是一次合法 promotion 后的 `enabled` 状态。任何代码、模板、Skill、文档或 lockfile 变更都会改变 source digest；变更后必须重新走 integrated benchmark → qualify → promote，不能沿用旧 evidence。

### 只读 UI
- 「结构」抽屉：树形大纲、type/spec/content、issue 定位、merge/Seal 审计、sealed artifact 链接；无任何写 API。

### 当前结构槽上线状态
- `structured_slots` 模式已完成平台接入：模板加载、contract/typestate、Grant/selector、Draft/Proposal、Seal/Assembler、projection、原子持久化和恢复均在当前代码中。
- 当前业务模板为 `templates/zhihu-salt-chapter-draft/`，运行链是 `structure → fill → seal → submitter`，输出 `chapter.md`。平台中立 fixture 仍保留，用于不依赖业务词的 acceptance。
- 当前 production acceptance、完整测试和 qualification/promotion 的结果以最新命令输出与 `docs/evidence/` 为准。结构槽证据不是静态宣传材料，而是绑定 source/runner/lock/dependency/profile/release 的可验证产物。
- 未实现的边界：同一 case 内并行槽生产、Notion 式可写块编辑器、把章节包/大纲/正文/审核/全文总控合并为一个模板。新增模板必须独立验收。
