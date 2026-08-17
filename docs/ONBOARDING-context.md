# Forge Core 无上下文 Agent 上手指南

> 本文是给第一次接触仓库的开发 Agent 的当前运行说明。权威顺序是：当前代码与测试 > `README.md` / 本文 > `docs/ARCHITECTURE.md` / `docs/PROJECT-MAP.md` / `docs/CLOSURE-AUTHORITATIVE-REVIEW-V2.md` > 历史 spec、实施日志和审查记录。
>
> **main 现状（v2 已交付）**：Plan 全部 29 个任务完成，结构槽权威审核 `authoritative_review_v1` capability `status: enabled`，profile digest 冻结。详见 [`docs/CLOSURE-AUTHORITATIVE-REVIEW-V2.md`](CLOSURE-AUTHORITATIVE-REVIEW-V2.md)。

## 1. 项目是什么

Forge Core 是本地单进程的多 Agent 内容生产系统。模板声明 Agent、Skill、合法路由、产物格式和门禁；平台运行时负责调度、持久化、版本、权限、校验、恢复和交付。模型只在授权的内容边界内工作。

本仓库同时承载**两套结构槽引擎**：

- **v1**（`forge-structured-runtime/v1` capability）：`structure -> fill -> seal -> submitter` 流水，模板定义槽位类型 + 布局 + 校验器 + 组装器，编排 Agent 建 scaffold，填空 Agent 写 Draft，Seal/Assembler 校验后发布。
- **v2**（`forge-authoritative-review/v1` capability，**已 enabled**）：在 v1 的契约/事件/存储基础上叠加**审核生命周期**。Agent 只能提交逐节点/逐槽/逐关系的事实与 Finding；Map 激活、aggregated pass、Finding 关闭、Seal、final commit 全部由系统背书。论文式 seal 闭环（设计 §16.2 十项硬条件 + §16.3 原子批）。

不要把它理解成：

- 一个由自然语言约定流程的聊天脚本；
- 一个允许 Agent 直接编辑主文档的块状编辑器；
- 一个把业务流程硬编码到 server 的故事生成器。

正确理解是：

```text
模板 = 可运行的生产产品
平台 = 确定性运行框架（v1 + v2 共存）
Agent = 在授权槽位/工作区/ReviewPlan 内创作的执行者
系统 = 唯一聚合者、审批者、Sealer、发布者
```

仓库当前在 `main`。开始工作前执行：

```bash
git status --short --branch
git log -1 --oneline
npm run check
# 看 v2 状态
npx tsx scripts/verify-authoritative-review.ts --validate-only
```

## 2. 当前产品形态

### 2.1 两种生产模式

模板的 `productionMode` 决定运行路径：

| 模式 | 用途 | 约束 |
|---|---|---|
| `basic` | 长篇总控、普通大纲、兼容模板 | v2 产物版本流水线；不允许 slots/v3 structured contract |
| `structured_slots` v1 | 结构化槽树生产（v1 引擎） | `forge-structured-runtime/v1` capability |
| `structured_slots` v2 | **结构化槽树 + 权威审核** | `forge-authoritative-review/v1` capability（**已 enabled**）；v2 pipeline 必填 `structuredReviewLifecycle` + `systemArtifactProducer: system:structured_seal`，contract v2 含 optional 关系 + reviewer 角色 + 4 builtin validators + assembler 绑定 `builtin.zhihu_chapter_markdown.v1` |

模式不由运行时猜测，也不靠环境变量切换。Template Loader、Catalog、cache reopen、task snapshot、Scheduler 的 start/resume/retry/answer 都要按 FROZEN 协议版本分发。v1 与 v2 走两条独立的事件 union、独立的事件类型、独立的事件 ID 前缀、独立 capability 门禁，但共享同一 EventStore / append 路径 / 产物版本目录。

### 2.2 当前模板

- `templates/long-form-hub`：basic 长篇总控。
- `templates/outline-designer`：basic 七轮大纲/蓝图，有 Skill 渐进披露和结构 Gate。
- `templates/zhihu-single-chapter`：basic/legacy 单章模板，保留作兼容。
- `templates/zhihu-salt-chapter-draft`：**v2 结构槽模板**（authoritative contract v2 + optional 关系 + maxSlots=10_000 + 4 v2 validators + assembler = `builtin.zhihu_chapter_markdown.v1`）；当前产出 `chapter.md`，未来扩展（大纲、章节包、审核帐本等）必须在同一个 artifact author 边界内逐个模板验证。

根目录 `skills/` 保存真实知乎盐选 Skill：章节包、总控、大纲、章节正文等。Skill 是业务知识资源，不等于已经完成的模板。当前工程约定是“一个模板产出一个工件，再由多个模板组合”。

## 3. 结构槽模式要解决什么

结构槽模式的基础能力不指定“槽里一定是一段话还是一句话”。模板定义：

1. 槽位类型与内容形态；
2. 槽位树排布、顺序、重复范围和输出映射；
3. validator/assembler 与资源预算；
4. Agent 之间的合法路由和每个 Agent 的读写授权。

编排 Agent 根据这些定义建立 scaffold，填空 Agent 在草稿副本上写作，Seal Agent/系统 Gate 校验，Assembler 只从已 Seal 的内容生成最终 artifact。

### 3.1 v1 章节模板运行链

`templates/zhihu-salt-chapter-draft/` 的 v1 路径：

```text
structure -> fill -> seal -> submitter
```

槽树的根 `chapter` 按以下顺序排布：

```text
title -> opening -> scene_block* -> emotional_closure -> chapter_end
```

`scene_block` 由模板声明为可重复场景单元。模板只负责章节正文的结构和 Markdown 输出，不负责生成大纲、编译章节执行包、全文连续性、审核账本或交付证书。

### 3.1.1 v2 同模板运行链（authoritative review，**已上线**）

`templates/zhihu-salt-chapter-draft/` 已迁移到 v2 contract；pipeline 注入 `structuredReviewLifecycle`：

```text
orchestrator(structure_chunk) -> generator(generation_batch) -> reviewer(Map/Content review + verification)
       -> system_review_settlement -> map activation (content migration)
       -> generator again (re-batches) -> reviewer again
       -> system_review_settlement -> system_seal (artifact producer = system:structured_seal)
       -> submitter (generic_turn, final commit via SystemArtifactDelivery)
```

agent 不能产出 `mapPassed` / `treePassed` / `sealApproved` / 调用 `request_seal()`；这些字段在 v2 Agent 工具集里不存在。

### 3.2 结构槽运行时边界（v1 + v2 通用）

- **授权投影**：task_owner 看到只读审计投影；Agent 通过 Grant/AccessProfile 获得固定目标槽和渐进式 selector。
- **Draft 隔离**：Agent 先写自己的 Draft；主 generation 只能由系统在提交边界合并。
- **Seal custody**：stage/verify/promote 后由单一原子事件 batch 对外可见；内容身份由任务、scaffold、revision、snapshot、assembler digest 和 canonical input 共同决定。v2 进一步有 `artifact_custody` blob 闭包（delivery→SealRecord→bundle→custody→artifact）+ `sealWarningCustodyRoot`（P2#8）。
- **原子恢复**：attempt terminal、proposal/draft journal、EventStore appendBatch、generation index 和 blob 都有崩溃恢复语义。v2 加 `seedAttemptJournal` + `AuthoritativeAppendFacadeV2`（跨进程 store fence + 唯一 append 路径 + PublicationPin 复活）。
- **fail closed**：未知字段、越权 selector、顺序/类型错误、摘要不一致、资源超限、缺文件或 hash 不符都拒绝，不吸回槽内容猜测修复。v2 严于 v1：Agent 任何产出必须先经 allowlisted registry 校验才能进事件账本。
- **不变量**：Agent 不可 Seal、不可凭单方面 verdict 让 `map_approved=true`、不可伪造 sourceNode 链接、不可关闭 Finding、不可越过 Capability gate。v2 模型工具集不含 `request_seal` / `publish_artifact` / `submit_final_artifact` 任何与 artifact 落盘相关的 write 工具。
- **串行 v1 边界**：一个生产 case 内一次只运行一个 Agent Turn；并行槽生产是后续方向，不要在第一版引入。v2 加了 v1 单槽 + v2 task-level `maxActiveLeasesPerTask = 1`，并行 lease 升级必须改协议。
- **TypeScript 边界**：v2 模块严格禁止 import `EventStore`（依赖边界测试断言）；需用 v2 blob/store 时通过 installer 注入 resolver / reader / facade / publication-store 闭包。

## 4. 基础架构与依赖方向

```text
src/shared
  contracts / api-schemas / errors
      ↓
src/server/storage
  EventStore / ArtifactStore / TaskStore / structured-slot stores
      ↓
src/server/template
  Loader / Validator / Catalog / Cache / structured contract compiler
      ↓
src/server/runtime
  Pi adapter / Runner / Scheduler / ActionBuffer / Committer / Gate
      ↓
src/server/api  ←  ForgeCoreGateway  ←  src/client
```

结构槽纯领域层在 `src/server/structured-slots/`，运行时适配在 `src/server/runtime/structured-slot/`。纯领域层不能反向依赖存储、Pi 或 HTTP；模板业务词不能泄漏进平台层。

最值得先读的代码：

```text
src/shared/contracts.ts
src/shared/authoritative-review-v2.ts                            <- v2 DTO / BlobRefV2 / AuthoritativeBlobKindV2
src/server/template/template-loader.ts
src/server/template/structured-pipeline-validator.ts
src/server/template/authoritative-review-pipeline-validator.ts   <- v2 pipeline
src/server/runtime/task-scheduler.ts
src/server/runtime/task-runner.ts
src/server/runtime/action-committer.ts
src/server/runtime/structured-slot/                              <- v1
src/server/runtime/authoritative-review/                         <- v2（含 production-composition.ts）
src/server/storage/event-store.ts
src/server/storage/structured-slot-*.ts
src/server/storage/authoritative-review-*.ts                     <- v2 投影/facade/pin/GC/cursor/index
src/server/authoritative-review/                                  <- v2 纯域（seal-gate、map/content/review/finding）
```

## 5. 不变量清单

改代码前先确认不会破坏以下规则：

1. 全进程单槽执行；stale Turn 不能提交。
2. 事件只追加，产物版本只递增；目录和事件必须交叉校验。v2 artifact 版本按合并 v1/v2 流自动分配（v1→v2→v1 = 1/2/3）。
3. 只有系统独立 Gate 能决定 final；自然语言不能完成任务。v2 多一层：Map 激活、aggregated pass、Seal、final commit 全部由系统从冻结事实推导。
4. 九个 ForgeAction 是封闭注册表；模板只能做集合减法。v2 严格：orchestrator/generator/reviewer/session 各自的工具集由 `AuthoritativeStructuredTurnContractV4` + sessionKind 锁定，**不含** Seal 工具、submit_final_artifact（reviewer）或 send_message（structured）。
5. ID、版本、时间戳、路由、任务状态和生产身份由系统拥有。v2 进一步：artifact producer 只能是 `system:structured_seal`，Agent 不能冒名。
6. raw provider thinking 不持久化、不上屏。
7. basic 与 structured_slots 分叉清晰；basic 不加载结构槽契约。v2 在此基础上分叉：v1 与 v2 走独立事件 union(`LegacyTaskEvent | AuthoritativeReviewEventV2`)、独立 capability 门禁、互不替代。
8. 结构槽的 Grant、selector、Draft、Seal、Assembler 和 custody 必须按权限/状态机工作。v2 进一步：所有跨对象 authority 是 `BlobRefV2`，裸 digest 只是显示别名；孤儿 blob 出 corrupt 而非猜测。
9. 所有摘要使用 canonical JSON/JCS；内容使用 content addressing；摘要链断裂必须 fail closed。v2 加 `artifact_custody` 闭包 + `sealWarningCustodyRoot` P2#8。
10. 限制器必须拒绝超时、内存、输出、调用次数和单 Attempt/单 Gate 资源超限。v2 profile 容量档：maxSlots≥10_000，单 assignment≥256 目标 / 1024 总对象，default 24/batch soft 64。
11. v2 启动恢复 + 持久索引 + 跨进程 store fence + PublicationIntent 复活 + capability 由唯一合法 `--promote-capability` 路径翻转；re-promotion / dirty source / digest mismatch 全部 fail closed。
12. v2 capability `authoritative_review_v1` 当前 enabled（promoted HEAD `6f075e7`），profile digest `f4685a55...` 冻结；改动源码/模板/profile 后必须重新走 qualification + promote。

## 6. 本地运行与验证

```bash
npm install
npx playwright install chromium
cp .env.example .env

FORGE_CORE_DATA_ROOT=$PWD/data \
FORGE_CORE_PORT=3210 \
VITE_FORGE_CORE_MODE=http \
npm run dev
```

访问 <http://127.0.0.1:3210/tasks>。真实模型运行需要 Provider API key；离线结构槽 acceptance 使用脚本化 runtime，不依赖模型 token。

基础门禁：

```bash
npm run check
npm test -- --reporter=dot
npm run build
npm run e2e
```

结构槽门禁：

```bash
npm run verify:structured-slots -- --acceptance-only --capability injected
npm run verify:structured-slots -- --acceptance-only --capability production
```

v2 权威审核门禁（capability 已 enabled）：

```bash
npx tsx scripts/verify-authoritative-review.ts --acceptance-only --capability injected
npx tsx scripts/verify-authoritative-review.ts --acceptance-only --capability production
npx tsx scripts/authoritative-review-real-acceptance.ts --verify-existing docs/evidence/authoritative-review-real-case-v1.json
```

生产 capability（v1 与 v2）都不能手工把 manifest 改成 enabled。合法顺序是 clean checkpoint → integrated benchmark → final profile/evidence → qualify → promote → production acceptance。源码、模板、Skill、文档和依赖变化都会影响 source digest；任何变化后都要重新生成证据链。

v2 变更影响范围比 v1 更大：模板 contract v2 切换会改变 template semantic hash，进而触发 profile digest 重算；任何 v2 任务因此 fail closed 直到重新走 promote。

## 7. 后续迭代流程

### 新增平台能力

1. 先写设计决策和失败态；先确定谁拥有状态、权限和原子边界。
2. 在 `src/shared` 固化契约，再按依赖方向实现 storage/template/runtime/API/UI。
3. 用 focused test 覆盖成功、越权、未知字段、重复调用、崩溃恢复和资源超限。
4. 保证 basic 模式、九个动作、既有模板、e2e 和 production acceptance 不回归。

### 新增结构槽模板

1. 先明确“一个模板只产出哪个工件”，不要把大纲、正文、审核、全文总控一次塞进一棵槽树。
2. 在 `template.yaml`/`pipeline.yaml` 里声明模式、路由、artifactSchema、输入和 submitter。
3. 在 `slots/contract.yaml` 定义槽类型/布局/限制；validator 只写机器可判定的规则。
4. 为 structure/fill/seal/submit 路由和 Seal 失败返工写 acceptance。
5. 真实 Skill 通过 `read_skill_section` 渐进披露；不要把整套 Skill 永久硬编码进平台 prompt。
6. 先用脚本化 Agent 验证结构/持久化/恢复，再做真实 Provider 运行；文学质量不能由结构 Gate 冒充。

### 提交与交接

- 使用独立 worktree/分支，避免把运行数据、`.env`、API key、`data/` 或临时报告带入提交。
- ledger/报告必须记录实际 HEAD、命令、测试计数、evidence digest 和未解决项。
- 用户要求“可生产”时，必须独立核对 qualification、promotion 和 production acceptance；不要只看 Task 标记或绿色单测。

## 8. 已知边界

- v1 不做同一 case 内并行生产。v2 也保持 `maxActiveLeasesPerTask = 1`，并行 lease 是后续协议升级。
- 当前结构槽 UI（v1 + v2）都是只读审计抽屉，不是 Notion/块编辑器；写入由 Agent + Draft/Seal/v2 Grant 完成。
- 当前只有 `templates/zhihu-salt-chapter-draft` 走 v2 结构槽模式；其它 basic 模板仍保持独立；新增 v2 模板须走 design / spec / plan 三份权威文档路径（Plan §1 + Task 23-25）。
- 当前是本地单进程文件存储，不提供分布式队列、多租户或云数据库一致性。
- 真实模型产物需要单独进行内容质量评审；结构槽 acceptance 只证明系统协议和安全边界，不等价于文学质量。
- 真实 Pi 0.82 集成仍处于 provider 协议层调试期：DeepSeek direct API 已验证联通，但 Agent turn 在真实 `@earendil-works/pi-coding-agent` 链路中可能卡死。dev 时如遇 turn 长时间未返回：① 排查 Pi turn abort / 异常 swallowed；② 临时用 hermetic-only 路径收齐 evidence；③ 开 SDK 兼容性 issue。**不允许**静默吞异常。

## 9. 历史文档怎么读

`docs/IMPLEMENTATION-LOG.md` 保留实现演进和当时的失败记录；`docs/2026-08-*.md` 保留设计讨论、规格和审查。它们可能出现旧的 `v6`、`Task 19 进行中`、`disabled/provisional` 文字。判断当前状态时以仓库当前代码、当前 manifest、最近一次验证输出和最新 evidence 为准。
