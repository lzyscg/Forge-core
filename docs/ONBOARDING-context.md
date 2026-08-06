# Forge Core 上手上下文（Onboarding Context）

> 本文档由一次性「只读」上手会话产出，目的是给后续 Agent 建立上下文。
> 区分两类信息：**【现状】**= 已在 `main` 实现并测试通过；**【设计中】**= `docs/2026-08-06/07-*.md` 描述的 v6「产物版本目录制」，**尚未实施**。
> 上游权威：`README.md`（铁律/运行）、`docs/2026-08-06-artifact-version-directory.md`（v6 设计，迭代收敛中）。

---

## 1. 项目定位

Forge Core 是**本地、单进程**的多 Agent 内容生产平台。模板声明 Agent / Skill / 合法路由；运行时串行驱动 Agent 协作（写作 → 审核退回 → 返修 → 复审 → 系统独立交付），全程在浏览器画布可视化。

核心立场是「**中间层接管工程、模型只管内容**」：平台补全所有工程数据（ID/版本/时间戳/路由），模型只能调一小组生产动作；交付不由模型自我声称决定，而由系统门禁独立校验。

---

## 2. 分层与关键模块职责

### 2.1 `src/shared/` — 前后端共享契约（冻结）
- **`contracts.ts`**：产品契约。`TaskStatus`、`WorkspaceNode`、`ArtifactVersion`、`TaskWorkspace`、`LiveTurn`/`TraceEntry`（仅展示、不入事件、不门禁）、`TemplateDetail`、`ForgeCoreGateway` 接口形状。**改它要全链路同步**。
- `api-schemas.ts`：HTTP 请求/响应 schema（含 `answer` 端点形状）。
- `errors.ts`：`PublicCoreError` 形状 + 稳定错误码（`TASK_CONTRACT_INCOMPATIBLE` 等）。

### 2.2 `src/server/` — 文件后端 + 调度
- **`main.ts` / `http-server.ts`**：入口 + Express（按 README 注释，HTTP 模式）。
- **`core-service.ts`**：组装编排；`deleteTask`、生命周期、live 缓冲、`getWorkspace`（投影）的装配。
- **`api/`**：`router.ts` + `task-routes.ts` / `template-routes.ts` / `artifact-routes.ts`。
- **`runtime/`**（回合驱动核心，见 §3）：
  - `task-runner.ts`：单节点串行执行器（一次 `runNext` = 一个 Agent Turn）。
  - `task-scheduler.ts`：单执行槽 + 生命周期 + 重试 + progress-guard 反应。
  - `action-committer.ts`：**唯一事件生产者**，原子校验 + 确定性提交序。
  - `action-buffer.ts`：单回合动作缓冲 + 阶段机（即时可纠正拒绝）。
  - `forge-actions.ts`：**封闭动作注册表（现状 6 个）** + shape 校验 + `FORBIDDEN_ACTION_KEYS`。
  - `pi-agent-runtime.ts` / `fake-agent-runtime.ts`：真实(Pi) / 脚本化 运行时适配。
  - `pi-tool-factory.ts`：把 forge-actions 暴露成 Pi 工具 + 文案/checklist 注入。
  - `skill-service.ts`、`workspace-store.ts`、`workspace-tools.ts`、`live-store.ts`、`retry-policy.ts`、`progress-guard.ts`。
- **`storage/`**（事件溯源 + 版本化产物）：
  - `task-events.ts`：**事件联合 + fail-closed 校验**（见 §3.1）。
  - `event-store.ts`：append-only 事件文件读写。
  - `artifact-store.ts`：版本化产物目录（`artifacts/vNNN/`，staging→rename）。
  - `task-store.ts`：`task.json` + 冻结模板快照 + 内存缓存。
  - `task-projector.ts`：事件 → `TaskWorkspace` 的纯折叠。
  - `core-paths.ts`、`atomic-file.ts`、`trace-store.ts`。
- **`template/`**：`template-schema.ts`（`FrozenTemplate`/`TurnContract`）、`template-validator.ts`、`template-loader.ts`、`template-cache.ts`、`template-catalog.ts`。

### 2.3 `src/client/` — React 18 + react-router 6
- `pages/`：任务列表 / 生产画布 / 新建 / 模板列表·详情 / 开发进度（仅 URL）。
- `components/`：`turn-card`、`workspace-canvas`、`flow-overlay`、`artifact-drawer`、`task-controls`、`process-trace-dialog` 等。
- `gateway/`：`ForgeCoreGateway` 接口 + `http-gateway` + `development-gateway`。
- `mock/`：浏览器本地 `MockGateway` + 确定性 `mock-simulator`（零 token 演示，与 real 投影一致）。

### 2.4 `templates/` — 业务模板（业务语义唯一所在）
- `zhihu-single-chapter/`：双 Agent 直连循环（**v6 计划删除**）。
- `long-form-hub/`：总控中枢混合拓扑（controller/writer/reviewer + prompts）。

---

## 3. 核心机制理解

### 3.1 事件溯源（现状）

- 事件文件：`data/tasks/<taskId>/events/000NNN-<uuid>.json`，**append-only**，唯一权威。
- `task-events.ts` 定义封闭联合（`task_started/stopped/resumed/interrupted/completed`、`task_incompatible`、`agent_input/agent_result`、`agent_attempt_failed`、`retry_scheduled`、`route_executed`、`artifact_published`、`human_requested/human_answered`、`final_submission_accepted`、`skill_loaded`）。
- `validateTaskEvent` 是 fail-closed 闸门：未知字段/未知类型在写盘前和读盘时都拒绝；返回的事件只含声明键。**这是 v6 legacy transform 的挂载点**。
- 产物版本只增不改：`artifact_published.artifact = {version,title,sourceNodeId,format,contentHash}`，单 contentHash（**v6 要改成 `files[]`+artifactType+artifactId**）。

### 3.2 回合契约（现状 = TurnContract v1）

模板为每个 Agent 声明 `turnContract`（`template-schema.ts`）：
```
production.completionAction = finish_production
production.output.formats / sources（inline | workspace_file | current_input_artifact）
dispatch.cardinality = single
dispatch.allowedActions（send_message | publish_artifact | submit_final_artifact）  ← 注意现状不含 forward/annotate/human 列在 allowedActions
dispatch.targets[Intent] = string[]（候选集，标量归一为单元素集）
```

回合形态（**现状**）：一个回合 = `finish_production`（封存一个生产包）+ 恰好一个 dispatch（引用 `productionPackageRef:'current'`）；`request_human_input` 可作为「直接中断」独占首动作。阶段机由 `action-buffer.ts`（即时拒绝，可纠正）+ `action-committer.ts`（不可绕过终验）双层守护。

**v1 与 v6 的根本差异**：现状没有「生产回合 vs 操作回合」分离——每个回合都要 finish_production 封存。v6 把它拆成：
- **生产回合（writer）**：`finish_production(files) → publish_artifact`（唯一 bump 版本）。
- **操作回合（reviewer/controller）**：`[read/annotate] → 一个 dispatch`（annotate/forward/submit/send，**不 bump、不封存**）。
- 注册表 6→9（加 `annotate_artifact` / `forward_input_version` / `read_artifact_version`）。

### 3.3 产物版本存储（现状）

`artifact-store.ts`：`artifacts/vNNN/{meta.json, content.md|txt}`。
- 版本号 = 现有最大版本 + 1（store 自己分配，不接受 caller 传入）。
- 发布时序：写临时 staging 目录 → `rename` 落位（原子）。
- 每次 `list` 重新校验已提交版本（哈希不匹配 → `TASK_CORRUPTED`，阻塞发布而非跳过）。
- 每任务发布串行队列（`queues` Map）。
- **现状是单 content 文件**；v6 要升级为「一个目录=一个版本，含 content/revision/review 多文件 + annotate 原子追加」。

### 3.4 progress-guard 与人工介入（现状 vs v6）

**现状**（`progress-guard.ts` + `task-scheduler.ts#guardNoProgress`）：
- 纯函数 `evaluateProgress`：窗口 = 最后一个 `human_answered` 之后；计数窗口内 `agent_result`（=成功回合数，幂等不重计）；超限 `exceeded`；同时报告 `hasUnansweredHumanRequest`。
- 调度器每轮循环开头检查；存在未答 human_requested → 绝不跑回合（不变量）；超限 → 以「最后分发者」名义合成一个 `human_requested`，任务停车 `waiting_human`。
- 人工回答只有一个通道：`answer` → `appendHumanAnswer`（写 `human_answered` + 给请求 agent 追加新 `agent_input`）→ 重置预算窗口继续。
- budget = `frozen.budget ?? 注入策略`，上限 32（`PROGRESS_POLICY_CEILING`）。
- D5：`recoverInterruptedTasks`/`shutdown` 跳过 `waiting_human` 任务（保证跨重启可答）。

**v6 升级**（设计中，Phase 5，依赖 v6 定稿）：人工介入从「单一 answer 流」升级为**结构化三选一**：
- **A. continue**：`pending_inputs_superseded` 标记当前 pending 作废 → synthesize 一个新输入节点（body=引导文本）给最老被作废 pending 的接收者。
- **B. accept**：synthesize 输入给 controller（最终提交者），带 `inputVersion=最新版` + **`humanAuthorized=true`**；controller 直 submit 走「人工放宽闭包」；不重标注 review.md。
- **C. stop**：复用现有 stop。
- 新事件 `pending_inputs_superseded`；新字段 `humanAuthorized`（输入节点可选）、`human_requested.source`（progress_guard | agent_request）；`inputVersion` 取代 `artifactVersion`。

### 3.5 铁律（README §不变量）

1. 平台零业务词（业务词只在 `templates/` 与 mock fixture）。
2. 模型不碰工程数据（`FORBIDDEN_ACTION_KEYS` 拦 taskId/eventId/version/timestamp/path…）。
3. 事件只追加不覆盖；产物版本只增不改；损坏隔离不猜。
4. 交付由系统门禁独立校验（`assertDeclaration` + `assertReachable` + declared submitter；自然语言不算数）。
5. 单一执行槽（全进程一次一个 Turn；stop/abort 有界等待；stale 结果不提交——`signal.aborted` 后丢弃）。
6. 凭据/隐藏思维链不上屏不持久化（`LiveTurn`/`TraceEntry` 纯内存/展示，trace 失败被吞，不门禁）。
7. Pi 约束（内置工具/自动 Skill/压缩/自动重试全关；只暴露 forge 生产工具 + 工作区工具）。

---

## 4. 关键文件地图（现状，按职责）

| 职责 | 文件 |
|---|---|
| 共享契约（冻结） | `src/shared/contracts.ts`、`api-schemas.ts`、`errors.ts` |
| 事件联合 + 校验 | `src/server/storage/task-events.ts` |
| 事件读写 | `src/server/storage/event-store.ts` |
| 产物版本目录 | `src/server/storage/artifact-store.ts` |
| 任务记录/快照 | `src/server/storage/task-store.ts` |
| 事件→工作区投影 | `src/server/storage/task-projector.ts` |
| 展示用 trace | `src/server/storage/trace-store.ts` |
| 封闭动作注册表 | `src/server/runtime/forge-actions.ts` |
| 单回合缓冲+阶段机 | `src/server/runtime/action-buffer.ts` |
| 唯一事件生产者 | `src/server/runtime/action-committer.ts` |
| 单节点执行器 | `src/server/runtime/task-runner.ts` |
| 单槽调度+生命周期 | `src/server/runtime/task-scheduler.ts` |
| progress-guard | `src/server/runtime/progress-guard.ts` |
| 重试策略 | `src/server/runtime/retry-policy.ts` |
| 真实运行时适配 | `src/server/runtime/pi-agent-runtime.ts`、`pi-tool-factory.ts`、`pi-resource-loader.ts` |
| 测试用运行时 | `src/server/runtime/fake-agent-runtime.ts`、`fake-script-file.ts` |
| Skill 服务 | `src/server/runtime/skill-service.ts` |
| 工作区 | `src/server/runtime/workspace-store.ts`、`workspace-tools.ts` |
| live 预览 | `src/server/runtime/live-store.ts` |
| 组装编排 | `src/server/core-service.ts` |
| 入口/HTTP | `src/server/main.ts`、`http-server.ts` |
| API 路由 | `src/server/api/{router,task-routes,template-routes,artifact-routes}.ts` |
| 模板契约 | `src/server/template/template-schema.ts` |
| 模板校验 | `src/server/template/template-validator.ts` |
| 模板加载/缓存 | `src/server/template/template-loader.ts`、`template-cache.ts`、`template-catalog.ts` |
| 客户端 Gateway | `src/client/gateway/forge-core-gateway.ts`、`http-gateway.ts`、`development-gateway.ts` |
| 客户端 Mock | `src/client/mock/{mock-gateway,mock-simulator,mock-projector,mock-store}.ts` |
| 画布/回合卡 | `src/client/components/{workspace-canvas,turn-card,flow-overlay,artifact-drawer}.tsx` |
| 业务模板（hub） | `templates/long-form-hub/{template,pipeline,agents/*,prompts/*}` |
| 业务模板（单章） | `templates/zhihu-single-chapter/*`（v6 删除） |
| 设计文档 | `docs/2026-08-06-artifact-version-directory.md`（v6 设计）、`2026-08-07-*-spec.md`（规格草案）、`2026-08-07-*-dev-plan.md`（开发规划草案）、`2026-08-06-agent-loop-and-hub-topology.md`（上一轮改动） |

---

## 5. long-form-hub 拓扑（现状）

`pipeline.yaml` 混合拓扑：修订小循环直连，总控管阶段流转与唯一交付。

```
controller ──send_message→ writer ──publish_artifact(artifact边)→ reviewer
reviewer ──send_message→ writer（退回） / → controller（通过结论）
controller（唯一 submit_final_artifact 提交者）← reviewer 通过时用 current_input_artifact 封存收到的章节 + send_message
```

现状 agent 契约要点（`agents/*.yaml`）：
- `controller`：sources `[inline, current_input_artifact]`；dispatch `[send_message(→writer,reviewer), submit_final_artifact]`。交付时 inline 复制正文 + submit。
- `writer`：sources `[inline, workspace_file]`；formats `[markdown]`；dispatch `[publish_artifact]`。
- `reviewer`：sources `[inline, current_input_artifact]`；dispatch `[send_message(→writer,controller)]`。退回→writer，通过→封存收到章节 + send_message 给 controller。
- budget: 16。

**现状已知平台缺口**（`agent-loop-and-hub-topology.md` §9.1）：`current_input_artifact` 封存包不携带 `artifactType`（产物类型未持久化到事件/元数据），committer 因此禁止 `current_input_artifact + publish_artifact`。模板只能退而「审核 current_input_artifact + send_message 转发正文 → 总控 inline 复制 + submit」，交付时正文被重新注入（长文有 fidelity/token 成本）。**这正是 v6「产物版本目录制 + forward 零复制」要解决的**。

---

## 6. v6 设计（产物版本目录制）理解 + 关键点 + 疑问

### 6.1 一句话
把产物从「单 content 文件」升级为「模板定义结构的版本目录」：一个目录=一个版本，含 content/revision/review；writer/reviewer/controller 围绕同一份产物协作；版本零复制转发（forward）；生产 vs 操作回合分离；人工介入升级为结构化三选一（supersede + synthesize + humanAuthorized）。

### 6.2 关键点（我理解的核心）
1. **生产/操作分离**：只有 writer 的 `finish_production→publish` bump 版本；reviewer/controller 的 annotate/forward/submit/send 不 bump、不封存。这是 v6 的地基，解了 v3 之前的三阻断。
2. **inputVersion 沿路由传播**：输入节点带 `inputVersion`，dispatch 时接收方继承发送方输入版本（执行期解析，不物化进事件）。`route.inject` 把输入版本的某文件注入成 inputText 命名槽位。
3. **可达性闭包**：正常 submit 从版本 producer 沿已提交 `route_executed(artifact)` 走到提交者，用 `agent_result.inputNodeId` 连「输入→消费结果」跳。新任务 fail-closed。
4. **forward 沿 artifact 边**：复用 artifact 路由 kind，不引入新 route kind；forward 产生 operate 输入，不触发产物全文 hand-off。long-form-hub 重写时 reviewer→controller 改 artifact 边。
5. **humanAuthorized 封闭性**：唯一写入主体是 task-scheduler 的 accept 合成路径；committer 的 `node()` 构造器永不置位；模型动作 schema 不含此键且 `FORBIDDEN_ACTION_KEYS` 拦截；legacy 缺省 false。→ 模型无法伪造人工授权。
6. **人工三选一的 supersede 协议**：`pending_inputs_superseded` 不可变事件标记作废输入；`findNextUnprocessedInput`/投影跳过 superseded 节点；continue 合成节点给「最老被作废 pending 的接收者」（确定性，人工不可指定）；accept 合成给 controller。解了第五轮两阻断（accept 悬空输入 / continue 引导无通道）。
7. **版本号=已提交 artifact_published 事件数+1**；staging→事件→rename；读窗口容忍「事件在、目录无」→ 触发认领补 rename，不判 CORRUPTED。committer 重放点触发认领。
8. **verdict 不是系统门禁**：平台不阻止 controller 提交 reject 版本；条件路由写 systemPrompt；人工 accept 不重标注 review.md（唯一性保护）。
9. **回合类型推导**：production+publish→生产；annotate 无 publish→操作；**仅 dispatch（无 production 无 annotate）→ dispatch-only/协调回合（controller）**；混合→validator 拒绝。`production.sources` 恢复（finish 的 source ⊆ production.sources；current_input_artifact 不是 finish 的 source，而是 submit 的输入解析机制）。
10. **迁移**：在途 v1 任务 → `incompatible(SCHEMA_V2_REQUIRED)`，只读+可克隆；legacy 事件读取归一 transform（仅 artifactVersion→inputVersion + humanAuthorized 缺省 false）；删 zhihu，重写 long-form-hub。

### 6.3 我的疑问 / 风险点（待设计定稿或实施时关注）
1. **Phase 5 阻塞**：dev-plan 明确 Phase 5（调度器人工介入）依赖 v6 定稿；第五轮揪出的 accept/continue 悬空输入、humanAuthorized 字段缺口尚未「定稿」（设计文档自述「v6 迭代收敛中，待第六轮审查」）。Phase 0–4/6 可先行，但它们都为 Phase 5 铺路，若 v6 人工介入模型再变，回填风险大。
2. **inputVersion 传播的执行期解析**：dispatch 时接收方继承发送方输入版本——「继承」的精确语义（取发送方该回合的 inputNodeId 关联版本？还是发送方产出的版本？）需在 runner/committer 实现时钉死，spec §3.3/§5.2 描述偏概念。尤其 forward（operate 输入，不 hand-off 全文）与 publish（扇出 artifact 边）的版本继承路径不同，容易写错。
3. **committer 重放触发认领**：`publishSealedPackage` 重放分支遇「事件在、目录无」触发 §6 认领补 rename——这是在提交热路径里做修复，需保证认领算法（artifactId 优先/contentHash 退回/多同哈希取一/冲突判 CORRUPTED）的幂等与并发安全（现状有 per-task 队列，但认领读 EventStore 的交叉校验注入是否引入循环依赖需确认：spec 称 EventStore 不依赖 ArtifactStore，无循环）。
4. **可达性闭包对现有 submit 的影响**：现状 `assertReachable`（action-committer）只校验「producer 是 submitter 自身 或 经声明+已提交 artifact 边抵达」。v6 要用 `agent_result.inputNodeId` 连「输入→消费结果」跳，并新增 humanAuthorized 放宽分支——这是对已绿快乐路径的核心改动，Phase 4 端到端测试是关键护栏。
5. **long-form-hub 重写为 artifact 边**：reviewer→controller 从 message 边改 artifact 边会改变版本传播与 forward 语义；现有 acceptance 测试（`long-form-hub-template.acceptance.test.ts`）需重写钉死。
6. **dispatch-only controller 推导**：现状 controller 契约有 `production` 段（inline/current_input_artifact）。v6 dispatch-only 要求 controller 无 production 无 annotate。这意味着 controller 的交付方式从「inline 复制 + submit」变为「submit 从 inputVersion 直解产物」——与 §9.1 现状缺口（current_input_artifact 不带 artifactType）正好对应，但需确认 controller 仍能在无 production 段时合法 submit（spec §15「submit 从 inputVersion 直解产物，不经封存包」）。
7. **review.md frontmatter 校验在工具层**：verdict 结构校验放 annotate 工具内（当回合可纠正拒绝）。这与现状「committer 是唯一事件生产者、工具层只 shape」的分层一致，但「工具层做 frontmatter 语义校验」是新增职责，需确保不被绕过（committer 仍要复验？spec §4 说「需上下文校验在工具层/committer」，措辞留了双口）。
8. **mock/real 投影一致**：`task-projector.ts` 与 `mock-projector.ts` 必须同步消费新事件（superseded/inputVersion/humanAuthorized）。dev-plan Phase 6 列了，但 mock 改动易遗漏。

---

## 7. 现状 vs 设计差距（哪些已实现 / 哪些是设计中）

### 7.1 已实现（main，门禁绿）
- 完整事件溯源 + fail-closed 校验（`task-events.ts`）。
- 单 content 文件版本目录 + staging→rename + 哈希校验（`artifact-store.ts`）。
- TurnContract **v1**（每回合 finish+单 dispatch；无生产/操作分离）。
- 封闭 6 动作注册表（无 annotate/forward/read_artifact_version）。
- 单槽调度 + 生命周期（start/resume/retry/answer/stop）+ 自动重试 + 崩溃恢复 + incompatibility gate。
- progress-guard（单一 answer 通道，超限停车）。
- 多目标分发（send_message 候选集）+ 模板级 budget。
- 回合任务清单 + 契约感知纠正提示 + sealedPhaseReminder。
- long-form-hub 混合拓扑（但 reviewer→controller 仍是 message 边，靠 inline 复制交付，有 §9.1 缺口）。
- 真实 Pi Runtime 闭环（DeepSeek 验证 2/3 交付，1/3 fail-closed）。
- 五页 UI + 流式预览 + trace + 抽屉。

### 7.2 设计中（v6，尚未实施）
- **产物版本目录制**（多文件 content/revision/review + annotate 原子追加 + meta 保 id）。
- **生产/操作回合分离** + 注册表 6→9（annotate_artifact / forward_input_version / read_artifact_version）。
- **inputVersion 取代 artifactVersion** + 沿路由传播 + route.inject。
- **artifactSchema**（模板声明 files 的 name/required/producer/extract/phase）。
- **TurnContract v2**（production.sources 恢复、dispatch-only 推导、forward/annotate targets）。
- **可达性闭包 + humanAuthorized 放宽**。
- **人工介入结构化三选一**（supersede + synthesize + pending_inputs_superseded 事件 + human_requested.source）。
- **staging 认领算法 + 盘↔事件交叉校验（ArtifactStore 注入 EventStore）+ committer 重放触发认领**。
- **迁移**：v1 任务 incompatible(SCHEMA_V2_REQUIRED)；删 zhihu；重写 long-form-hub（reviewer→controller artifact 边）。
- API：结构化决策形状（decision + 可选 text）+ waiting_human 来源暴露。

### 7.3 现状代码中已为 v6 预留的接缝（值得注意）
- `task-events.ts` 的 `validateTaskEvent` 是 legacy transform 的天然挂载点（读取期归一）。
- `EventNode.artifactVersion` 字段已存在（v6 重命名为 inputVersion，可读期归一）。
- `task_incompatible` 事件 + `incompatible` 状态 + `isTurnContractSupported` 已就位（v6 扩 reason 枚举为 SCHEMA_V2_REQUIRED）。
- `ActionCommitter.CurrentInputArtifact` 已携带 artifactId/version/title/format/content/sourceNodeId（v6 forward/submit 直解的基础，但缺 artifactType 持久化）。
- progress-guard 的 `evaluateProgress` 是纯函数 + 调度器 owns 反应——v6 结构化决策可在此扩展而不动事件联合核心（但需新事件成员）。

---

## 8. 后续上手建议

读代码顺序（README 推荐，已验证有效）：
`contracts.ts` → `task-events.ts` → `forge-actions.ts` → `action-buffer.ts` → `action-committer.ts` → `task-runner.ts` → `task-scheduler.ts` → `progress-guard.ts` → `task-projector.ts` → `artifact-store.ts` → `template-schema.ts` → `templates/long-form-hub/*`。

若要开始 v6 实施，按 dev-plan 的依赖图：**Phase 0（事件/契约）先行**，它解锁 Phase 1/2/3；Phase 4 依赖 1+2+3；**Phase 5 阻塞于 v6 人工介入定稿**；Phase 6 依赖 4（accept UI 依赖 5）；Phase 7 全量。优先做 Phase 0/2（事件联合 + 注册表）以避免连锁返工。
