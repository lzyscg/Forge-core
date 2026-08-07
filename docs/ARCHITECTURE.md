# Forge Core 架构（当前稳定版，v7）

> 状态：对齐当前磁盘代码与定稿 v7 spec（`docs/2026-08-07-artifact-version-directory-spec.md`）。
> 历史设计文档保留在 `docs/2026-08-0*.md`，不代表当前行为。

## 产品定位

Forge Core 是一个本地、单进程的多 Agent 内容生产平台：模板声明 Agent / Skill / 合法路由 / 产物结构；运行时驱动 Agent 串行协作；全过程在浏览器画布上可视化。核心理念是「中间层接管工程、模型只管内容」——**模型声明不权威，平台持有确定性否决权**。

## 核心不变量

1. **单进程单槽**：全进程同时只跑一个 Agent Turn；stop/abort 有界等待、stale 结果不提交。
2. **v2-only runnable**：唯一可执行回合契约是 `TurnContract.version === 2`；历史 v1 快照只读、gate 为 `incompatible`（`SCHEMA_V2_REQUIRED` / `TURN_CONTRACT_REQUIRED`），可 clone 到当前模板。
3. **append-only events**：事件只追加不覆盖，ID 由平台派生（确定性重放/恢复）。
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
