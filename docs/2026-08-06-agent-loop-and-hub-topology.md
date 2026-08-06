# Forge Core 会话改动说明（2026-08-06）

> 给后续 Agent 的改动地图：本文件说明本次会话为走向**长篇生产混合拓扑**（总控中枢）做了什么、代码在哪、为什么。读完本文件应能定位每个改动的实现与测试，并知道尚未解决的限制。

## 总目标

让 Forge 从「单章双 Agent 直连循环」走向「长篇内容生产」。两个阶段：

1. **Agent 循环加固**（对抗真实模型的失败模式）：无进展守卫、回合任务清单、契约感知纠正提示。
2. **平台增量**：多目标分发 + 模板级进度预算，支撑总控中枢拓扑。
3. **首个长篇模板** `templates/long-form-hub/`：总控分配/验收/唯一交付，修订小循环直连。

真实案例验证：3 例中 2 例端到端交付，1 例按设计 fail-closed 停车（详见 §8）。

---

## 1. 无进展守卫（机械闸门）

**问题**：审核 Agent 曾陷入完美主义死循环退回——每回合结构合法（阶段机满足），整体无限打转。之前只有提示词软约束。

**实现**：
- `src/server/runtime/progress-guard.ts`（新增）：
  - `PROGRESS_POLICY`（默认 `maxTurnsSinceHumanAnswer: 8`）、`PROGRESS_POLICY_CEILING`（32，§5 用）。
  - `evaluateProgress(events, policy)` 纯函数：窗口 = **最后一个 `human_answered` 之后**的事件（人工回答重置预算），计数窗口内 `agent_result` 事件数；`exceeded = turnCount > limit`；同时报告 `hasUnansweredHumanRequest` 与最后分发者。
  - `PROGRESS_GUARD_QUESTION` 冻结平台文案（零业务词）。
- `src/server/runtime/task-scheduler.ts`：
  - `guardNoProgress(taskId)` 在 `execute()` 循环**每轮开头**检查：不变量「存在未回答的 human_requested 时绝不跑回合」；超限则以最后分发者名义合成一个 `human_requested` 事件，任务停车 `waiting_human`（复用现有回答流程，UI 零改动）。
  - `effectiveProgressPolicy(taskId)` = `frozen.budget ?? 注入策略`（读失败回退注入策略）。
- **D5 附带修复**：`recoverInterruptedTasks`/`shutdown` 跳过 `waiting_human` 任务——等待人工的任务没有在飞回合，重启不应标为 interrupted（顺带修掉一个潜在死锁：模型发起的人工请求跨重启后 answer 永远不可达）。
- `src/server/storage/task-projector.ts`：`task_resumed` 折叠改为「存在未回答问题 → `waiting_human`，否则 `running`」（与 D5 配套；mock 投影器同步）。

**测试**：`progress-guard.test.ts`（10 例）+ `task-scheduler.test.ts` 新增 describe「progress guard」（含预算覆盖、重启可答、恢复跳过）。

## 2. 回合任务清单

**问题**：模型产出内容后常忘记 `finish_production`/分发动作（「只输出不提交」）。

**实现**：`src/server/runtime/task-runner.ts` `buildTurnChecklist(agent, frozen)`：
- 从 `turnContract` **机械推导**三步清单（产出内容 → finish_production 点名允许来源 → 分发动作），注入 `inputText` **末尾**（近因效应）。
- 分发目标渲染为 **`id（显示名）`**——`send_message.targetAgentId` 参数需要的是 agent **id**，只写显示名会把模型带偏（真实案例踩过，见 §8）。
- 纯展示，**不泄漏**进已提交事件或重放历史（`buildPublicHistory` 只读 `node.body`）。

**测试**：`task-runner.test.ts` describe「per-turn checklist」。

## 3. 契约感知纠正提示

**实现**：`src/server/runtime/pi-agent-runtime.ts`：
- `MAX_CORRECTIVE_NUDGES = 2` 常量（替代硬编码循环上界）。
- `sealedPhaseReminder(turnContract)`：封存后提醒只点名契约允许的分发动作 ∪ `request_human_input`（契约为空回退通用文案）。
- **行为修正**：provider 报错 / 中止 / 无响应时**提前终止、不再 nudge**（原来会对已失败的 provider 反复重提示）。
- `pi-tool-factory.ts`：`send_message` 工具描述明确 targetAgentId 用 agent id（配合 §2 的 id 渲染）。

**测试**：`pi-agent-runtime.test.ts` describe「corrective nudge loop」（此前该循环无直接测试）。

## 4. 多目标分发（平台原语，Feature A）

**能力**：`send_message` 可在模板声明的**候选集合**内选目标（总控中枢「决定下一个 Agent」的基础）；回合仍恰好一个分发动作（`cardinality: 'single'` 不变）。

**实现**（改动点，均有行内注释 `plan 2026-08-06`）：
- `src/server/template/template-validator.ts`：新 `asSafeIdList`——**唯一归一化点**，YAML 标量 `send_message: writer` 或列表 `[writer, reviewer]` 都归一为 `string[]`（非空、去重）。历史快照的字符串 targets 走同一路径，**不升契约版本**，旧任务继续可执行。
- `src/server/template/template-schema.ts`：`TurnContract.dispatch.targets: Partial<Record<Intent, string[]>>`；`FrozenTemplate` 增加 `budget`。
- `src/server/runtime/action-committer.ts`：`assertMessageRouteAllowed` 目标 ∈ 候选集；`assertPublishRouteAllowed` 至少一条 artifact 边 `to` ∈ 候选集（扇出仍路由驱动）。
- `src/server/template/template-loader.ts` `hashCanonicalContract`：**单元素候选集折回标量**再进版本哈希——`scalar ≡ [single]` 哈希相等，现存冻结快照哈希逐字节不变（`readFrozenTemplate` 会重算哈希与记录比对，漂移即全量 TASK_CORRUPTED）。
- `src/server/template/template-cache.ts` `readManifest`：遗留缓存 manifest 的字符串 targets 读取时归一化为数组（否则 `invalid_using_cache` 回退路径出现 `'peer-writer'.includes('writer')===true` 子串误判）。

**测试**：loader 归一化 5 例、哈希折叠 2 例、committer 候选集 4 例、清单多目标 1 例、manifest 归一化 1 例。

## 5. 模板级进度预算（Feature B）

**能力**：模板在 `pipeline.yaml` 声明 `budget.maxTurnsSinceHumanAnswer`（≤ 平台上限 32），覆盖调度器注入的默认策略——不同拓扑的回合密度不同，守卫限额应跟随模板。

**实现**：
- `progress-guard.ts`：`PROGRESS_POLICY_CEILING = 32`。
- `template-validator.ts` `validatePipelineFile`：解析可选 `budget`（整数、1..ceiling、拒绝未知键；`budget:` 空块视为缺省）。
- `FrozenTemplate.budget: ProgressPolicy | null`；版本哈希**仅声明时**计入（镜像 turnContract 省略技巧，旧哈希可复现）。
- `src/server/storage/task-store.ts`：`readFrozenTemplate` **内存缓存**（`Map<taskId, FrozenTemplate>`，删除驱逐）——守卫每轮迭代都要读快照，不加缓存每次重解析 YAML + 重算 SHA-256。
- 测试接缝：`runtime/test-support.ts` `createSchedulerEnvironment` 新增 `patchTemplate`（在 fixture 复制/契约升级后、服务初始化前注入，快照冻结前改模板源）。

**测试**：loader 预算 7 例、TaskStore 缓存 2 例、调度器预算覆盖 1 例。

## 6. 长篇总控模板 `templates/long-form-hub/`

**拓扑**（混合：修订小循环直连，总控管阶段流转与最终交付）：

```
总控(controller) ──send_message→ writer ──publish_artifact→ reviewer
                                                       ↕ send_message（退回 writer / 通过转 controller）
controller（唯一 submit_final_artifact 提交者）←── send_message（current_input_artifact 转发章节）
```

- `controller`：`send_message` 候选集 `[writer, reviewer]` + 唯一 `submit_final_artifact`；交付时 `finish inline`（复制收到的正文）+ submit。
- `writer`：`publish_artifact`（沿 writer→reviewer artifact 边）。
- `reviewer`：`send_message` 候选集 `[writer, controller]`；退回 → `writer`，通过 → `current_input_artifact` 封存收到的章节 + `send_message` 给 `controller`。
- `budget: 16`（演示模板预算）。
- 提交版模型为 `configured/*` 占位符；真实跑时复制模板并替换标量（见 `/tmp/hub-real-cases.mts`，一次性验收脚本，未入库）。

**测试**：`long-form-hub-template.acceptance.test.ts`（4 例，钉死拓扑/契约/预算）。

## 7. 顺带修复的 HEAD 遗留破损

排查中确认提交 `522942a` 时测试套件已有 **24 个红灯**（多轮 provider 调优 commit 的积压），为让门禁全绿一并修复：
- nudge 循环上线后 13 个 Pi 测试脚本未跟上（补脚本条目/更新断言）。
- parker「可见停车」策略与 3 处旧期望冲突（调度器 ×2、网关契约）——网关契约改为按休息形态（`running`/`interrupted`）分支断言。
- `templates/zhihu-single-chapter` 被提交了真实模型名，破坏验收占位符协议（`configured/*`），已恢复（连带修复 7 个验收脚本测试）。

## 8. 验证

- 门禁全绿：`npm run check`、`npm test`（1060）、`npm run build`、`npm run e2e`（44 过）、`verify:backend`/`verify:runtime`、活数据抽查（现存任务可打开、模板 valid）。
- 真实案例（DeepSeek v4-flash，3 例）：2 例端到端 `completed` 并交付 v2(final)（守夜人/钟表店）；1 例（渡口）审核调用 `current_input_artifact` 时多带参数被拒 → 平台正确 fail-closed 到 `waiting_human`，未错误交付。

## 9. 已知限制与下一步

1. **平台原语缺口：收到的产物无法被「转发」**。`current_input_artifact` 封存包不携带 `artifactType`（产物类型从未持久化到事件/产物元数据），committer 因此禁止 `current_input_artifact + publish_artifact`。模板只能退而用「审核 `current_input_artifact` + send_message 转发正文 → 总控 inline 复制 + submit」，交付时总控把正文重新注入一次（长文有 fidelity 与 token 成本风险）。**建议扩展**：把 `artifactType` 纳入产物元数据与 `CurrentInputArtifact`，允许收到产物直接转发布 → 总控可 `current_input_artifact + submit`，零复制。
2. **审核提示词**可加一句「`current_input_artifact` 时不得携带 format/content/artifactType 等额外参数」以降低 Case2 那类模型行为波动。
3. `templates/long-form-hub` 尚未启用任何 Skill；真实长篇可为其声明生成/审核 Skill。
