# Forge Core 无上下文 Agent 上手指南

> 本文是给第一次接触仓库的开发 Agent 的当前运行说明。权威顺序是：当前代码与测试 > `README.md` / 本文 > `docs/ARCHITECTURE.md` / `docs/PROJECT-MAP.md` > 历史 spec、实施日志和审查记录。

## 1. 项目是什么

Forge Core 是本地单进程的多 Agent 内容生产系统。模板声明 Agent、Skill、合法路由、产物格式和门禁；平台运行时负责调度、持久化、版本、权限、校验、恢复和交付。模型只在授权的内容边界内工作。

不要把它理解成：

- 一个由自然语言约定流程的聊天脚本；
- 一个允许 Agent 直接编辑主文档的块状编辑器；
- 一个把业务流程硬编码到 server 的故事生成器。

正确理解是：

```text
模板 = 可运行的生产产品
平台 = 确定性运行框架
Agent = 在授权槽位/工作区内创作的执行者
```

仓库当前在 `main`。开始工作前执行：

```bash
git status --short --branch
git log -1 --oneline
npm run check
```

## 2. 当前产品形态

### 2.1 两种生产模式

模板的 `productionMode` 决定运行路径：

| 模式 | 用途 | 约束 |
|---|---|---|
| `basic` | 长篇总控、普通大纲、兼容模板 | v2 产物版本流水线；不允许 slots/v3 structured contract |
| `structured_slots` | 结构化槽树生产 | 需要启用的 runtime capability；必须通过结构合同、typestate、Seal 和独立 assembler |

模式不由运行时猜测，也不靠环境变量切换。Template Loader、Catalog、cache reopen、task snapshot、Scheduler 的 start/resume/retry/answer 都要使用同一模式检查。

### 2.2 当前模板

- `templates/long-form-hub`：basic 长篇总控。
- `templates/outline-designer`：basic 七轮大纲/蓝图，有 Skill 渐进披露和结构 Gate。
- `templates/zhihu-single-chapter`：basic/legacy 单章模板，保留作兼容。
- `templates/zhihu-salt-chapter-draft`：当前第一个结构槽业务模板，产出一个 `chapter.md`。

根目录 `skills/` 保存真实知乎盐选 Skill：章节包、总控、大纲、章节正文等。Skill 是业务知识资源，不等于已经完成的模板。当前工程约定是“一个模板产出一个工件，再由多个模板组合”。

## 3. 结构槽模式要解决什么

结构槽模式的基础能力不指定“槽里一定是一段话还是一句话”。模板定义：

1. 槽位类型与内容形态；
2. 槽位树排布、顺序、重复范围和输出映射；
3. validator/assembler 与资源预算；
4. Agent 之间的合法路由和每个 Agent 的读写授权。

编排 Agent 根据这些定义建立 scaffold，填空 Agent 在草稿副本上写作，Seal Agent/系统 Gate 校验，Assembler 只从已 Seal 的内容生成最终 artifact。

### 3.1 当前章节模板

`templates/zhihu-salt-chapter-draft/` 的运行链：

```text
structure -> fill -> seal -> submitter
```

槽树的根 `chapter` 按以下顺序排布：

```text
title -> opening -> scene_block* -> emotional_closure -> chapter_end
```

`scene_block` 由模板声明为可重复场景单元。模板只负责章节正文的结构和 Markdown 输出，不负责生成大纲、编译章节执行包、全文连续性、审核账本或交付证书。

### 3.2 结构槽运行时边界

- **授权投影**：task_owner 看到只读审计投影；Agent 通过 Grant/AccessProfile 获得固定目标槽和渐进式 selector。
- **Draft 隔离**：Agent 先写自己的 Draft；主 generation 只能由系统在提交边界合并。
- **Seal custody**：stage/verify/promote 后由单一原子事件 batch 对外可见；内容身份由任务、scaffold、revision、snapshot、assembler digest 和 canonical input 共同决定。
- **原子恢复**：attempt terminal、proposal/draft journal、EventStore appendBatch、generation index 和 blob 都有崩溃恢复语义。
- **fail closed**：未知字段、越权 selector、顺序/类型错误、摘要不一致、资源超限、缺文件或 hash 不符都拒绝，不吸回槽内容猜测修复。
- **串行 v1**：一个生产 case 内一次只运行一个 Agent Turn；并行槽生产是后续方向，不要在第一版引入。

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
src/server/template/template-loader.ts
src/server/template/structured-pipeline-validator.ts
src/server/runtime/task-scheduler.ts
src/server/runtime/task-runner.ts
src/server/runtime/action-committer.ts
src/server/runtime/structured-slot/
src/server/storage/event-store.ts
src/server/storage/structured-slot-*.ts
```

## 5. 不变量清单

改代码前先确认不会破坏以下规则：

1. 全进程单槽执行；stale Turn 不能提交。
2. 事件只追加，产物版本只递增；目录和事件必须交叉校验。
3. 只有系统独立 Gate 能决定 final；自然语言不能完成任务。
4. 九个 ForgeAction 是封闭注册表；模板只能做集合减法。
5. ID、版本、时间戳、路由、任务状态和生产身份由系统拥有。
6. raw provider thinking 不持久化、不上屏。
7. basic 与 structured_slots 分叉清晰；basic 不加载结构槽契约。
8. 结构槽的 Grant、selector、Draft、Seal、Assembler 和 custody 必须按权限/状态机工作。
9. 所有摘要使用 canonical JSON/JCS；内容使用 content addressing；摘要链断裂必须 fail closed。
10. 限制器必须拒绝超时、内存、输出、调用次数和单 Attempt/单 Gate 资源超限。

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

生产 capability 不能手工把 manifest 改成 enabled。合法顺序是 clean checkpoint → integrated benchmark → final profile/evidence → qualify → promote → production acceptance。源码、模板、Skill、文档和依赖变化都会影响 source digest；任何变化后都要重新生成证据链。

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

- v1 不做同一 case 内并行生产。
- 当前结构槽 UI 是只读审计抽屉，不是 Notion/块编辑器。
- 当前只有知乎盐选单章正文模板使用结构槽模式；其余 Skill 和 basic 模板仍保持独立。
- 当前是本地单进程文件存储，不提供分布式队列、多租户或云数据库一致性。
- 真实模型产物需要单独进行内容质量评审；结构槽 acceptance 只证明系统协议和安全边界。

## 9. 历史文档怎么读

`docs/IMPLEMENTATION-LOG.md` 保留实现演进和当时的失败记录；`docs/2026-08-*.md` 保留设计讨论、规格和审查。它们可能出现旧的 `v6`、`Task 19 进行中`、`disabled/provisional` 文字。判断当前状态时以仓库当前代码、当前 manifest、最近一次验证输出和最新 evidence 为准。
