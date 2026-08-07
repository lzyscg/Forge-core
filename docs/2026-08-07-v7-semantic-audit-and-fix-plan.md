# ForgeCore v7 语义审计与修复计划

> 日期：2026-08-07  
> 状态：待修复  
> 面向对象：本地开发 Agent / Codex / Claude Code  
> 基线：当前 `/Users/lzy/Desktop/ForgeCore` 磁盘代码，以 v7 TurnContract / Artifact Version Directory 实现为准，不以旧 v1 任务或过期 ONBOARDING 文档为准。

---

## 0. 目的

本文件记录一次针对 ForgeCore 当前 v7 实现的代码级审计结果，并把发现的问题转化为可执行的修复任务。

总体判断：**ForgeCore 的核心架构已经成立，不需要推倒重构。** 当前主要风险集中在 v7 改造后的“跨层语义闭合”问题：各模块单独看大多正确，但信息从 Event → Runner → AgentTurnInput、Runtime → Trace → UI、Template → Projector → UI 的最后一公里仍存在不一致。

修复目标不是“让现有测试继续绿”，而是让以下核心不变量真正闭合：

1. Template 声明是业务语义的唯一来源。
2. `inputVersion` 只表示版本引用，不隐式决定 Prompt 组装语义。
3. `send_message.summary` 不得因为携带 `inputVersion` 而丢失。
4. `route.inject` 必须按输入节点对应版本和模板声明执行。
5. Agent 不得通过自然语言、隐藏状态或非声明字段绕过系统 Gate。
6. 内部/隐藏 reasoning 不得被当作 durable product data 持久化或展示。
7. Artifact 的 `extract` 必须来自冻结模板 `artifactSchema`，不能靠文件名硬编码。
8. v2 是当前唯一可运行契约；不要为了兼容历史任务重新放宽当前运行时。

---

# 1. P0 — TaskRunner 输入组装语义错误：返修意见可能丢失

## 1.1 现象

当前 v7 `long-form-hub` 的返修链设计为：

```text
writer publish V1
  ↓ artifact
reviewer
  ├─ annotate_artifact(review.md, verdict: reject + 返修意见)
  └─ send_message(writer, summary: 具体返修指令)
       ↓
writer 下一回合应同时拿到：
  1. send_message.summary
  2. V1/content.md
  3. V1/review.md
```

模板已经明确声明：

`templates/long-form-hub/pipeline.yaml`

```yaml
- from: reviewer
  to: writer
  kind: message
  label: 退回修改意见
  inject:
    - { version: input, file: content.md, as: 上一版正文 }
    - { version: input, file: review.md, as: 返修意见 }
```

`ActionCommitter` 当前也会：

- 把 `send_message.summary` 写入新 `agent_input.node.body`；
- 把发送方当前 `inputVersion` 传播到接收方输入节点。

问题在 `src/server/runtime/task-runner.ts` 的 Turn 输入组装。

当前逻辑本质上是：

```ts
let inputText = input.node.body;

if (input.node.inputVersion !== null) {
  // artifact hand-off
  inputText = ...content.md 全文...
} else {
  // route.inject
}
```

因此 reviewer → writer 的输入一旦带 `inputVersion`：

- `node.body` 中的 `send_message.summary` 被覆盖；
- `route.inject` 不执行；
- `review.md` 不会被注入；
- writer 可能只收到上一版正文，看不到具体返修意见。

这是一个跨层语义 bug。现有测试分别验证了 body、inputVersion、artifact hand-off，但没有验证最终 `AgentTurnInput.inputText` 是否同时包含返修消息与声明注入文件。

## 1.2 根因

`inputVersion` 当前被同时承担了两个职责：

1. 指向输入关联的 artifact version；
2. 决定 Runner 用哪种 Prompt 组装模式。

这两个职责不应该耦合。

**`inputVersion` 是引用，不是输入类型。**

真正决定输入如何组装的，应是该 `agent_input` 的来源/入边语义：

- publish artifact hand-off；
- forward_input_version；
- send_message；
- scheduler synthesize；
- initial seeded input。

## 1.3 修复要求

优先修改：

- `src/server/runtime/task-runner.ts`

必要时增加一个纯函数/辅助层，例如：

```ts
assembleTurnInput(...)
resolveIncomingDelivery(...)
resolveRouteInjects(...)
```

具体命名不限，但要求把“输入来源判别”和“Prompt 内容组装”从 `inputVersion !== null` 中解耦。

目标语义：

### A. 初始输入 / 普通无版本消息

```text
input.node.body
+ checklist
```

### B. publish_artifact 产生的 artifact input

按模板 artifact route 的 `inject` 声明供料。

如果为了 legacy/fallback 仍支持全文 hand-off，也必须是显式 fallback，不得覆盖正常 v7 inject 语义。

### C. forward_input_version 产生的输入

使用目标输入节点自身的 `inputVersion`，按对应 artifact route 的 `inject` 读取声明文件。

不得创建新 artifact version。

### D. send_message + inputVersion

必须保留：

```text
消息正文 = input.node.body
```

并追加该 route 声明的 `inject`：

```text
[消息正文]
<summary>

[上一版正文]
<content.md>

[返修意见]
<review.md>
```

具体格式可以调整，但三类信息不能丢。

### E. human continue / accept 合成输入

必须保留 scheduler 写入的人工 guidance，同时可通过 `inputVersion` 提供对应版本上下文。

不要因为 inputVersion 存在而覆盖人工 guidance。

## 1.4 不要做

- 不要把 `summary` 复制进 artifact 文件。
- 不要让模型控制 `inputVersion`。
- 不要修改 append-only Event 语义来“绕过” Runner。
- 不要重新让 controller/reviewer 复制全文产生新版本。
- 不要把 v1 `current_input_artifact` 的旧生产语义带回来。

## 1.5 必须增加的测试

至少增加以下跨层测试，而不是只测单模块字段。

### Test 1：reject → writer 返修输入完整

使用真实 `long-form-hub` v2 模板：

```text
controller → writer
writer publish V1(content.md)
reviewer annotate review.md(reject)
reviewer send_message(writer, summary="请修改第二段")
writer 被 Runner 唤醒
```

断言 writer 的 `AgentTurnInput.inputText` 同时包含：

- `请修改第二段`
- V1 `content.md`
- V1 `review.md`
- 模板声明的 `as` 标签或等价结构

并断言不发生 V2，直到 writer 真正完成新的 production turn。

### Test 2：forward → controller

```text
writer publish V1
reviewer annotate pass
reviewer forward_input_version(controller)
controller 被 Runner 唤醒
```

断言：

- controller 收到的输入仍指向 V1；
- `content.md` 按 `reviewer -> controller` route.inject 注入；
- 没有新 artifact version；
- controller 可以直接 `submit_final_artifact`。

### Test 3：human continue guidance 不被覆盖

存在 `inputVersion` 的 pending input 被 supersede 后，由 scheduler synthesize replacement：

断言新 Agent Turn 同时看到：

- 人工 guidance；
- 对应版本上下文；
- 旧 superseded input 不再执行。

---

# 2. P0 — Durable Trace 持久化并展示 thinking，与项目铁律冲突

## 2.1 当前行为

当前链路包括：

- `AgentTurnResult.trace`
- `TraceEntry.kind === "thinking"`
- `TraceStore.appendTurnTrace`
- `tasks/<taskId>/traces/<turnId>.json`
- `/api/tasks/:taskId/trace/:turnId`
- `ProcessTraceDialog`
- `TurnCard` live thinking

当前测试也明确断言 thinking 可以：

- 写入 TraceStore；
- round-trip；
- 截断；
- 经 API 解码；
- 在 UI 中显示“思维/思考过程”。

历史真实 task 的 `traces/*.json` 中也已出现完整 thinking 文本。

这与 README / runtime contract 中“隐藏 thinking / raw causes 不应成为持久或公开工程数据”的设计原则冲突。

## 2.2 修复目标

先明确数据分类：

### Internal reasoning / provider thinking

如果 `thinking` 来自 provider 的内部 reasoning block：

**不得：**

- 写入 `TraceStore`；
- 写入 EventStore；
- 经 API 暴露；
- 在 ProcessTraceDialog 展示；
- 在 TurnCard 作为“思考过程”展示。

### Public reasoning summary

如果产品确实需要向用户解释执行过程，应设计显式的公共字段，例如：

```text
reasoning_summary
decision_rationale
progress_note
```

它必须是面向用户的公开摘要，而不是 raw provider thinking。

## 2.3 建议修改范围

重点检查：

- `src/server/runtime/pi-agent-runtime.ts`
- `src/server/runtime/agent-runtime.ts`
- `src/server/runtime/task-runner.ts`
- `src/server/storage/trace-store.ts`
- `src/shared/contracts.ts`
- `src/shared/api-schemas.ts`
- `src/client/components/process-trace-dialog.tsx`
- `src/client/components/turn-card.tsx`
- 对应 tests / e2e

## 2.4 推荐终态

Durable trace 建议只保留：

```text
phase
public text
tool_call（必要参数需做安全裁剪）
tool_result（公开结果）
```

不要持久化 raw thinking。

如果 LiveStore 目前接收到的是 provider raw thinking，也应从 UI 去掉；如果未来需要 live reasoning，可改为显式 public summary，而不是沿用 `thinking` 语义。

## 2.5 测试要求

- runtime 返回 thinking 后，任务结束时 `traces/<turn>.json` 不包含 thinking。
- Trace API 不返回 thinking。
- ProcessTraceDialog 不渲染 thinking section。
- EventStore 永远不出现 thinking。
- 如果保留 public reasoning summary，必须用独立类型和独立测试证明它不是 raw provider reasoning。

---

# 3. P1 — `annotate_artifact` 只在描述里要求 verdict，代码没有真正校验 frontmatter

## 3.1 现象

当前工具描述要求：

```yaml
---
verdict: pass
---
```

或：

```yaml
---
verdict: reject
---
```

但实际参数 schema 只有：

```ts
{
  file: string,
  content: string
}
```

当前工具层与 committer 主要校验：

- action shape；
- inputVersion 是否存在；
- annotate file 是否在 contract 允许范围；
- `(version,file)` 唯一性；
- producer/phase 闭包。

没有看到对 `review.md` frontmatter 结构和 `verdict` 枚举的真正 parse + reject。

因此以下内容可能被接受：

```text
今天感觉还行，建议改一下。
```

或者：

```yaml
---
verdict: maybe
---
```

## 3.2 修复要求

做双层校验：

### Model-facing tool layer

在 `pi-tool-factory` 或共享 validation helper 中校验：

- frontmatter 存在；
- `verdict` 存在；
- 只允许 `pass | reject`；
- malformed 时返回稳定、可纠正的错误码。

这样模型可以在同一 Turn 内重新调用正确的 tool。

### ActionCommitter

必须再次校验。

原因：FakeRuntime、未来其他 Runtime、测试注入路径都可能绕开 Pi tool 层；Committer 仍然必须是不可绕过边界。

## 3.3 注意

**只校验结构，不要擅自扩大成 verdict 业务 Gate。**

除非现有 v7 spec 明确要求，否则不要新增：

```text
verdict=pass 强制 forward
verdict=reject 强制 send_message
```

当前修复重点是 annotation 格式契约，不是把 reviewer 的判断逻辑硬编码进平台。

## 3.4 测试

必须覆盖：

- 无 frontmatter → reject；
- `verdict: maybe` → reject；
- `pass` → accept；
- `reject` → accept；
- tool 层可纠正错误；
- 直接调用 committer 绕过 tool 仍会 reject；
- validation failure 零写入 Event/Artifact。

---

# 4. P1 — `artifactSchema.extract` 已声明，但 Projector / UI 仍存在硬编码

## 4.1 现象

模板已支持：

```yaml
artifactSchema:
  files:
    - { name: content.md, extract: content }
    - { name: revision.md, extract: revision }
    - { name: review.md, extract: review }
```

但当前投影逻辑仍存在按文件名推导 extract 的过渡代码，等价于：

```ts
review.md   -> review
revision.md -> revision
else        -> content
```

UI `ArtifactDrawer` 的 `extractLabel()` 也只识别：

- review
- revision
- 其他全部当正文

这意味着未来模板声明：

```yaml
- name: evaluation.md
  extract: evaluation
```

可能会在投影/UI 中退化成 `content/正文`。

这违背 Template-driven 的核心原则。

## 4.2 修复要求

### Projector

`ArtifactVersion.files[].extract` 应优先来自：

```text
frozenTemplate.artifactSchema.files[name].extract
```

只有 legacy artifact / legacy snapshot 无 schema 映射时才允许 fallback。

### UI

不要把未知 extract 一律标成“正文”。

建议：

```text
content  -> 正文
review   -> 审核意见
revision -> 修订说明
unknown  -> extract 原值（或通用“<extract>”标签）
```

更进一步，可以未来把展示 label 也模板化；本次修复不必扩大范围。

## 4.3 测试

增加一个非标准文件名/非标准 extract fixture：

```yaml
name: evaluation.md
extract: evaluation
```

断言：

- workspace API 中 extract 保持 `evaluation`；
- ArtifactDrawer 不把它错误显示成正文；
- legacy content.md 仍能降级读取。

---

# 5. P1 — 增加真正的跨层 Semantic E2E

当前测试数量很多，模块级可靠性较高，但本次 P0-1 暴露出一个典型问题：

> 每个局部字段都测对了，最终 Agent 实际收到的信息仍可能错。

因此建议增加一组专门的 semantic e2e / integration tests，不只验证节点数量、版本数量、route kind。

## 5.1 至少覆盖

### Reject loop

```text
controller
→ writer V1
→ reviewer reject + review.md
→ writer 真正收到返修意见 + V1 正文
→ writer V2
→ reviewer pass
→ controller
→ final V2
```

必须断言第二次 writer 的 `AgentTurnInput.inputText`。

### Forward zero-copy

必须断言：

```text
V1 publish
review annotate
forward
submit
```

最终仍只有 V1，不因审核/总控复制产生 V2。

### Human continue / accept

断言：

- superseded 节点不执行；
- synthesized 节点拿到 guidance；
- humanAuthorized 只由 scheduler accept 路径产生；
- 模型 forward 不传播 humanAuthorized。

### Trace safety

断言 durable trace 无 raw thinking。

---

# 6. P1 — 文档和代码已经发生明显版本漂移

## 6.1 已发现的漂移

包括但不限于：

- README 仍有旧的动作数量/旧语义描述；
- `ONBOARDING-context.md` 仍保留 v6/v7 实施前状态；
- 部分注释还写“当前模板 version: 1”；
- 当前真实 runnable contract 已是 v2；
- 当前 Forge Action 注册表已是 9 个；
- 历史 task snapshot 中仍有 v1，这是历史数据，不代表当前实现。

## 6.2 修复目标

不要删除历史设计文档，但要建立明确 Source of Truth 层级。

建议：

```text
README.md
  产品定位、启动方式、最少架构说明

docs/ARCHITECTURE.md
  当前稳定架构与核心 invariants

docs/PROJECT-MAP.md
  当前模块地图、关键类、调用链、数据目录、重要 test gate

docs/IMPLEMENTATION-LOG.md
  实施历史

docs/YYYY-MM-DD-*.md
  设计/spec/plan 历史
```

## 6.3 PROJECT-MAP 至少写清楚

```text
main
→ CoreService
→ TaskScheduler
→ TaskRunner
→ AgentRuntime
→ ActionBuffer
→ ActionCommitter
→ EventStore / ArtifactStore
→ TaskProjector
→ API
→ Gateway
→ Production UI
```

并列出当前核心不变量：

- 单进程单槽；
- 一个 Agent Turn 一次执行；
- append-only events；
- version 单调递增；
- final 只由 system gate；
- v2-only runnable；
- 9-action closed registry；
- model 不控制 engineering identity；
- route / artifact / final reachability 由系统校验。

## 6.4 注意

不要为了让文档“看起来一致”修改代码行为。先以当前已通过的 v7 runtime contract 和定稿 spec 为事实来源，再同步文档。

---

# 7. P2 — long-form-hub Writer Prompt 硬编码“第一人称”

文件：

`templates/long-form-hub/prompts/writer-system.md`

当前描述包含：

```text
把主题、大纲、人物与素材写成一段完整的第一人称章节正文
```

但模板输入 `theme` 本身允许用户指定叙事视角，历史真实任务也出现第三人称限制视角。

这会让系统 prompt 与业务输入发生冲突。

## 修复

改为类似：

```text
严格遵循任务输入中声明的叙事视角、人物设定、结构与风格要求。
```

不要在通用 writer system prompt 中硬编码第一人称。

增加一个第三人称输入的 prompt/acceptance test 或至少 snapshot assertion。

---

# 8. P2 — progress-guard continue/accept 的崩溃半态自愈

实施日志已经把以下情况列为已知后续：

```text
pending_inputs_superseded 已提交
但 synthesized agent_input 尚未提交
进程崩溃
```

或 accept 路径中类似的部分提交状态。

当前 append-only 设计允许保留历史，但如果恢复逻辑不能识别这种 deterministic half-state，可能造成任务无法继续。

## 修复原则

这是 P2，不要和 P0 输入组装混在一个大改中。

要求：

- 先为 continue / accept 分别构造 crash boundary 测试；
- deterministic id；
- 重启后识别已提交步骤；
- 只补缺失步骤；
- 不重复 supersede；
- 不产生两个 synthesized inputs；
- 不传播 model-generated `humanAuthorized`；
- 不破坏 existing reachability bridge。

---

# 9. 不建议修改的核心架构

本次修复不要顺手重构以下已经成立的设计：

## 9.1 不要取消 ActionCommitter

它是系统不可绕过的 correctness boundary。

## 9.2 不要让 Agent 直接写 EventStore / ArtifactStore

Runtime 只返回 public output + buffered actions。

## 9.3 不要改成模型决定 ID / version / timestamp / route

这些必须继续由系统拥有。

## 9.4 不要用 Agent 文本推断 task completed

只有：

```text
final_submission_accepted
```

等系统最终事件能完成任务。

## 9.5 不要把 message 和 artifact route 合并

两者语义不同：

- message：协调文本，可携带版本引用；
- artifact：版本化零复制交接。

## 9.6 不要恢复 v1 runnable

历史 v1 snapshot 应继续：

```text
可读
不可执行
可 clone 到当前模板
```

---

# 10. 推荐实施顺序

## Phase A — 修输入组装（P0）

1. 写 failing semantic tests。
2. 重构 TaskRunner input assembly。
3. 让 route.inject 锚定接收输入节点自身 `inputVersion`。
4. 让 send_message body 与 inject 同时存在。
5. 覆盖 forward / publish / human synthesized input。
6. 跑 server tests + long-form-hub integration。

## Phase B — 修 reasoning/trace 边界（P0）

1. 明确 raw thinking 数据分类。
2. durable trace 去掉 raw thinking。
3. API schema/UI 同步。
4. 若产品需要公开解释，建立独立 public summary 类型。
5. 更新 tests。

## Phase C — annotation + artifactSchema（P1）

1. frontmatter shared validator。
2. tool + committer 双校验。
3. Projector 使用 frozen artifactSchema.extract。
4. UI unknown extract fallback。
5. tests。

## Phase D — 文档同步（P1）

1. README。
2. ARCHITECTURE。
3. PROJECT-MAP。
4. ONBOARDING 更新或明确标记历史。
5. 清理旧 version/action 注释。

## Phase E — P2

1. long-form prompt 修正。
2. continue/accept half-state recovery。

---

# 11. 每个 Phase 的验收门槛

至少运行当前仓库已有完整 Gate：

```bash
npm run check
npm test
npm run build
npm run e2e
```

如果仓库 README / package.json 中还有 verify / acceptance scripts，也应全部执行。

除此之外，本次修复新增的 semantic tests 必须能够证明：

```text
测试绿 ≠ 只证明事件字段正确
测试绿 = 下一个 Agent 实际收到的信息正确
```

---

# 12. 完成定义（Definition of Done）

全部满足才算本轮修复完成：

- [x] reviewer reject 后 writer 能同时收到 summary、content.md、review.md。
- [x] forward_input_version 按 route.inject 供料且零复制。
- [x] human synthesized guidance 不被 inputVersion 覆盖。
- [x] raw provider thinking 不进入 durable trace / API / UI。
- [x] annotate frontmatter malformed 会在 tool 和 committer 两层被拒绝。
- [x] `artifactSchema.extract` 真正进入 TaskWorkspace，不再靠文件名决定。
- [x] 非标准 extract 不被 UI 错标为“正文”。
- [x] long-form writer 不再硬编码第一人称。
- [x] README / Architecture / Project Map 与 v7 当前代码一致。
- [x] 当前所有 unit/e2e/verify gate 继续通过。
- [x] 新增跨层 semantic tests，能稳定复现并防止本文件列出的 P0/P1 回归。

> 实施记录：2026-08-07 全部完成（Phase A-E）。详见 `docs/IMPLEMENTATION-LOG.md`「语义审计修复（plan 2026-08-07）」。门禁：check 0 错 / 单测 1149 / e2e 44 / build / verify:backend / verify:runtime 全绿。

---

# 13. 给执行 Agent 的工作原则

1. **先读当前源码和 v7 spec，再改。** 不要从本文件单独推断所有实现细节。
2. **先写 failing test，再修实现。**
3. 尽量做局部、可证明的修改，不要借机大规模重构。
4. Event / Artifact / Route / Finality 相关改动必须保持 append-only 和 deterministic replay。
5. 任何“为了兼容旧任务”的改动不得重新放开 v1 运行。
6. 如果发现本文件描述与当前磁盘代码已经不一致，优先以“当前代码 + 定稿 v7 spec + 新增复现测试”为准，并在修复提交中记录差异。
7. 每解决一个问题，更新本文件对应 checklist 或在 `IMPLEMENTATION-LOG.md` 记录实际处理结果。
