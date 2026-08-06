# 产物版本目录制 — 规格文档（Spec）

> 状态：**定稿（Final）**，对齐设计 v7（六轮对抗审查收敛，无阻断）。
> 上游设计：`docs/2026-08-06-artifact-version-directory.md`（v7，含迭代轨迹）。
> 本文是提炼后的**规格**（契约/数据模型/接口），不含设计探索过程。

---

## 1. 目标与范围

**目标**：把产物从「单一 content 文件」升级为「模板定义结构的版本目录」，实现：
- 一个目录 = 一个版本，承载该版本全部生产信息（正文 + 审核意见 + 修订说明）；
- 产物链按文件提取正文/审核意见/修订说明分别展示；
- writer/reviewer/controller 围绕同一份产物协作；
- 版本零复制转发（forward）。

**范围**：产物存储模型、事件契约、工具契约、模板契约、运行时（runner/committer）、调度器人工介入、投影与 UI、迁移。

**非范围**（明确不做）：token 流式、页面实时推送、旧契约任务兼容执行、人工覆盖以外的 verdict 强制。

---

## 2. 核心概念

| 概念 | 定义 |
|---|---|
| **版本目录** | `artifacts/vNNN/`，一个目录 = 一个版本，内含该版本全部文件 |
| **生产（produce）** | writer 产出新内容 → 创建新版本（**唯一会 bump 版本的动作**） |
| **操作（operate）** | 在已有版本上 annotate / forward / submit / 携带版本的 send_message（**不 bump、不封存**） |
| **输入版本（inputVersion）** | 输入节点携带的版本号；沿路由传播（dispatch 时接收方继承发送方的输入版本） |
| **转发（forward）** | 把输入版本沿产物边路由到目标，不创新版本、不封存 |
| **封存（seal）** | 仅 `finish_production`；只发生在生产回合 |

**铁律继承**：平台零业务词；模型不碰工程数据；事件只追加不覆盖、产物版本只增不改；交付由系统门禁独立校验；单一执行槽；凭据/隐藏思维链不上屏不持久化。

---

## 3. 数据模型

### 3.1 版本目录结构

```
artifacts/vNNN/
  content.md | content.txt   # 正文（必填，writer，immutable；扩展名按 format）
  revision.md                # 修订说明（可选，writer）
  review.md                  # 审核意见（可选，reviewer，annotate 一次性原子追加）
  meta.json                  # {version, id, title, producer, createdAt}（创建期一次写成）
```

- meta.json 含 `id`（artifactId），不含文件哈希（哈希在事件）。
- 内容文件 immutable；标注文件（review.md）一次性原子追加。
- 文件完整性权威 = 事件；盘↔事件交叉校验由 ArtifactStore（注入 EventStore）承担。

### 3.2 review.md 格式

```markdown
---
verdict: pass     # pass | reject
---
## 意见
1. 【位置】xxx 【问题】xxx 【建议改法】xxx
```

- 结构校验（frontmatter 存在 + verdict ∈ {pass,reject}）在**工具层**（annotate_artifact 工具内），不合法当回合可纠正拒绝。
- verdict **语义只由 controller 模型消费**，平台不解析、不据此门禁提交。
- 产物链展示 verdict 是**展示层**解析 review.md 渲染（展示层行为，不违反铁律 1）。

### 3.3 事件契约

| 事件 | 变更 | legacy 处理 |
|---|---|---|
| `artifact_annotated` | 新增成员 `{version, file, contentHash, turnId, nodeId}` | 旧任务无此事件 |
| `artifact_published` | 载荷 `contentHash` → `files:[{name,hash}]` + `artifactType` + `artifactId` | 旧单 contentHash → `files:[{name:<按format>, hash:contentHash}]`，artifactType=null |
| `agent_result` 节点 | +`inputNodeId` + `dispatchKind(publish/forward/send/submit/human)` | 旧事件缺 → null |
| 输入节点 | `artifactVersion` → `inputVersion` | 旧 artifactVersion 读取归一为 inputVersion |
| `task_incompatible` | reason + `SCHEMA_V2_REQUIRED` | 枚举扩展 |

**向后兼容**：新字段可选/可空；读取期 validateTaskEvent 前跑键归一 transform（**仅处理 artifactVersion→inputVersion 这一个已知迁移**）；写入期强制点在 committer/scheduler。执行中任务必为 v2 契约（v1 已 gate incompatible）。

### 3.4 ArtifactVersion（客户端契约）

```ts
ArtifactVersion { id, version, title, files: Array<{name, extract, content}>, sourceNodeId, createdAt, final }
```

旧任务降级：单 content.md → `files:[{name:content.md, extract:content, content}]`。

---

## 4. 工具契约（注册表 6 → 9）

| 动作 | 类型 | 语义 | 前置 |
|---|---|---|---|
| `write/read/list_workspace` | 工具 | 私有草稿 | — |
| `finish_production(files)` | 动作 | 创建新版本（封存） | 生产回合 |
| `annotate_artifact(file, content)` | 动作 | 标注输入版本（产 artifact_annotated） | 输入有 inputVersion；file 须 phase:annotate 且 producer==本 agent |
| `read_artifact_version(file)` | 读工具 | 读输入版本文件 | 仅读输入版本 |
| `publish_artifact` | 动作 | 发布新版本，扇出全部产物边 | 本回合 finish_production |
| `forward_input_version(targetAgentId)` | 动作 | 转发输入版本，走一条边 | 输入有 inputVersion；目标是声明产物边 |
| `submit_final_artifact` | 动作 | 提交终稿（零复制） | 输入有 inputVersion |
| `send_message(targetAgentId, summary)` | 动作 | 简短协调消息 | — |
| `request_human_input(question)` | 动作 | 人工中断 | 任意回合 |

**阶段机**：
- production 阶段：load_skill / write_workspace / read_workspace / read_artifact_version / annotate_artifact。
- 封存仅 `finish_production`（仅生产回合）。
- dispatch：恰好一个 publish/forward/send/submit/human。
- 需上下文的校验（输入版本、file 归属、frontmatter）在**工具层/committer**；ActionBuffer 只做结构顺序。
- request_human_input：生产回合 finish 前后均可；操作回合 annotate 前后均可（明确翻转现有 F7 约束，列为代码翻转项）。

---

## 5. 模板契约

### 5.1 artifactSchema

```yaml
artifactSchema:
  files:
    - { name: content.md,  required: true,  producer: writer,   extract: content,  phase: create }
    - { name: revision.md, required: false, producer: writer,   extract: revision, phase: create }
    - { name: review.md,   required: false, producer: reviewer, extract: review,   phase: annotate }
```

### 5.2 route.inject（执行期解析，不物化进事件）

```yaml
routes:
  - { from: reviewer, to: writer, kind: message, label: 退回修改意见,
      inject:
        - { version: input, file: content.md, as: 上一版正文 }
        - { version: input, file: review.md,  as: 返修意见 } }
```

- `version: input` = 本回合输入节点 inputVersion。
- 产物边必须声明至少一个 required 文件的 inject（validator 强制）。

### 5.3 TurnContract v2

```yaml
turnContract:
  version: 2
  production:                 # 存在 => 生产回合
    files: [content.md, revision.md]   # finish_production 写入（须 phase:create）
    formats: [markdown]                # 允许格式
  annotate:                   # 存在 => 可标注
    files: [review.md]                 # 须 phase:annotate 且 producer==本 agent
  dispatch:
    allowedActions: [publish_artifact, forward_input_version, send_message, submit_final_artifact, request_human_input]
    targets:
      publish_artifact: [reviewer]
      forward_input_version: [controller]
      send_message: [writer, controller]
```

- budget 归**模板级**（FrozenTemplate.budget），progress-guard 唯一来源。
- 回合类型推导：有 production+publish→生产；有 annotate 无 publish→操作；production+annotate 混合→validator 拒绝。
- 纯操作 Agent 交叉校验：annotate.files ⊆ schema(phase:annotate 且 producer==本 agent)；forward.targets ⊆ 产物边对端；submit 仅当 ∈ finalOutput.submitters。

---

## 6. 回合形态

| 回合 | 动作序列 | 版本效果 |
|---|---|---|
| writer 首稿/返修 | finish_production → publish_artifact | 创建 v(N+1) |
| reviewer 打回 | annotate(review.md,reject) → send_message(→writer) | 标注 v(N)，消息带 inputVersion=v(N) |
| reviewer 通过 | annotate(review.md,pass) → forward_input_version(→controller) | 标注 v(N)，转发 v(N) |
| controller 分配 | send_message(→writer/reviewer) | 无版本操作 |
| controller 提交 | read_artifact_version → submit_final_artifact | 提交，零复制 |
| 人工中断 | [可选 annotate] → request_human_input | 无版本变化 |

---

## 7. 关键流程

### 7.1 快乐路径（已逐步验证成立）

```
1. controller → send_message(writer) 分配 [inputVersion:null]
2. writer: finish_production → publish → 创建 v1 → reviewer 输入[inputVersion=v1]
3. reviewer: annotate(review.md,reject) → send_message(writer) → writer 输入[inputVersion=v1]
4. writer 修订 → publish → 创建 v2 → reviewer 输入[inputVersion=v2]
5. reviewer: annotate(review.md,pass) → forward_input_version(controller) → controller 输入[inputVersion=v2]
6. controller: read_artifact_version(verdict=pass) → submit_final_artifact → 闭包成立 → 提交 v2
产物链：v1(review:reject)、v2(review:pass,终稿)
```

### 7.2 人工介入（supersede + synthesize，结构化三选一）

前提：reviewer 反复打回 → progress-guard 超限停车（human_requested 挂**最老 pending 输入的接收者**）。平台呈现三选一，提交序固定 `human_answered → pending_inputs_superseded → synthesize`：
- **A. 继续**：作废全部 pending 输入（`pending_inputs_superseded`）→ synthesize 新输入给**最老被作废 pending 的接收者**，body=人工引导文本，inputVersion=该 pending 的 inputVersion → runner 跳过作废节点执行合成节点，引导经 body 进 inputText。
- **B. 接受**：作废全部 pending → synthesize 输入给 **controller**（最终提交者），inputVersion=最新版 + `humanAuthorized=true` → controller 直接 submit，走**人工放宽闭包**（校验版本存在/producer 合法/是 submitter/humanAuthorized，不要求完整路由链）；不重标注 review.md。accept 要求至少一个已发布版本（零版本禁用 + 服务端复校验）。
- **C. 停止**：复用现有 stop。
- **humanAuthorized**：合成 agent_input 节点可选字段，仅 scheduler accept 路径可写，committer 构造器永不置位，模型动作参数面不可携带。
- **waiting_human 来源判别**：human_requested.source=progress_guard（三选一）| agent_request（普通回答，不提供 accept）。
- **superseded 输入**：投影渲染为作废态，findNextUnprocessedInput 跳过，不悬空。

### 7.3 可达性闭包

- 正常 submit：从版本 producer 沿已提交 route_executed(artifact) 走到提交者，用 agent_result.inputNodeId 连接「输入→消费结果」跳；新任务 fail-closed。forward 沿 artifact 边、复用 artifact kind、operate 输入不触发全文 hand-off。
- 人工 accept：放宽为「版本存在 + producer 合法 + controller 是 submitter + humanAuthorized」（明示例外）。

---

## 8. 崩溃恢复与原子性

- **版本号** = 已提交 artifact_published 事件数 +1，staging 期选定、事件确认。
- **生产时序**：staging 写内容 → append artifact_published → rename。读窗口容忍「事件有、目录无」（触发认领，不判 CORRUPTED）。
- **annotate 提交序**：staging → artifact_annotated 事件 → rename。
- **annotate 唯一性**：提交期扫已提交 artifact_annotated，(version,file) 已存在即拒绝；**排除本 turn 计划 id**（重放自排除）。
- **staging 认领算法**：扫描该 version 候选 staging，优先 artifactId 匹配，退回 contentHash；多同哈希取一（可恢复）；哈希冲突/丢失判 CORRUPTED；认领/重新生产成功都清理孤儿。
- **盘↔事件交叉校验**：ArtifactStore 注入 EventStore（EventStore 不依赖 ArtifactStore，无循环）。

---

## 9. 迁移

- **在途任务**：version-1 契约 → incompatible(SCHEMA_V2_REQUIRED)，只读 + 可克隆。
- **legacy 事件读取**：§3.3 transform，任务列表/投影/克隆读旧事件不 CORRUPTED。
- **legacy 克隆**：克隆继承 incompatible gate；未来迁移克隆另议。
- **模板**：删 zhihu-single-chapter；重写 long-form-hub 为 v2 schema。

---

## 10. 已知取舍（明示）

- **verdict 不是系统门禁**：平台不阻止 controller 提交 reject 版本；靠 controller 模型读 verdict + 人工 accept 例外。
- **条件路由写 systemPrompt**：「通过→forward / 打回→send」由模型遵循提示词，平台不强制 verdict×路由绑定。
- **人工接受不重标注**：reject 记录保留，人工接受为明示例外。
- **混合 Agent 不支持**：单 Agent 既生产又标注被 validator 拒绝。
