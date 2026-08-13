# Forge Core

> 面向无上下文 Agent 的项目入口。本文描述当前 `main` 的产品边界、运行方式、核心不变量和后续迭代入口。

Forge Core 是一个本地、单进程的多 Agent 内容生产系统。模板声明 Agent、Skill、路由、产物格式和质量门禁；运行时负责调度、事件持久化、版本管理、权限边界、校验与交付；模型只负责在系统授权的范围内创作内容。

## 30 秒理解项目

Forge Core 不是一个让模型自由聊天的工作流脚本，也不是一个把编辑器交给 Agent 的块状文本编辑器。它是一个“模板驱动的生产运行框架”：

```text
模板快照
  -> Agent 按声明路由串行协作
  -> 系统记录事件、版本、回合 trace 和校验结果
  -> 独立门禁决定是否可以发布/提交
  -> 浏览器展示可审计的生产过程和最终产物
```

当前有两种运行模式：

- `basic`：传统的产物版本流水线，适合长篇总控、普通大纲和已有 v2 模板。
- `structured_slots`：结构槽模式。模板定义槽位类型、槽树布局、校验器和组装器；编排 Agent 负责建立结构，填空 Agent 在草稿副本上创作，Seal/Assembler 负责确定性校验和交付。

模式由模板的 `productionMode` 决定。它不是运行时猜测，也没有环境变量绕过：basic 模板不能偷偷携带结构槽契约，结构槽模板必须经过已启用的 runtime capability 检查。

## 当前已经交付的能力

### 基础生产引擎（basic）

- 模板快照：创建任务时冻结模板、输入和版本哈希，运行期间不读取可变模板。
- 多 Agent 串行协作：生产、审核、返修、复审、总控交付均由模板路由声明。
- 事件溯源：事件只追加，产物版本只递增；事件和版本目录相互校验，可恢复、可审计。
- v2-only 回合契约：历史 v1 快照只读并标记不兼容，新任务只能运行 v2 契约。
- 系统交付门禁：`submit_final_artifact` 只有在独立校验通过后才能产生完成态；模型说“完成”不具备权威性。
- 人工介入：无进展守卫可以停车，用户可继续、接受或停止；答案、作废和合成输入具有持久化恢复语义。
- 文件、HTTP 和浏览器 UI：同一套 Gateway 契约支持本地 Mock、HTTP 后端和 React 画布。

### 结构槽引擎 v1

结构槽引擎已经接入生产模式，核心能力是平台级基础设施，不绑定某一个故事模板：

- **Slot Schema**：严格定义槽 ID、类型、父子关系、内容形态和必填约束。
- **Layout Grammar**：定义槽的排布、顺序、重复范围和最终输出顺序。
- **结构化流水线 typestate**：`structure -> fill -> seal -> submit`；首个生产节点必须建立 scaffold，未 Seal 的内容不能进入最终产物。
- **草稿隔离**：填空 Agent 写入自己的 Draft 副本，校验通过后才由系统合并；私有 Proposal、Draft、Grant 不进入 task_owner 的公开投影。
- **渐进式上下文**：Agent 默认只看到当前工作槽和必要摘要，可通过授权 selector 读取前序槽位，不一次性灌入整棵树。
- **原子持久化与恢复**：EventStore batch、attempt journal、generation index、content-addressed blob 和 custody batch 保证崩溃后可重放，避免半提交状态被误认为完成。
- **确定性 Gate/Assembler**：validator 和 assembler 在隔离沙箱中运行，受 CPU、墙钟、内存、输出和调用次数限制；JCS canonical JSON、摘要链和内容寻址保证结果可复核。
- **封存边界**：Seal 失败只能进入明确的返工/人工恢复路径；Seal 成功后生成最终 artifact，不能从已封存状态回写槽树。
- **生产门禁**：集成 benchmark、全量 qualification、release evidence 和 capability promotion 是单向链条；任一证据缺失或摘要不一致都 fail closed。

当前已启用的结构槽业务模板是 `zhihu-salt-chapter-draft`：它将一章知乎盐选正文表达为 `title -> opening -> scene_block* -> emotional_closure -> chapter_end`，输出单个 `chapter.md`。它只负责章节正文这一件工件；章节执行包、大纲、审核账本和全文总控由其他模板/Skill 负责，后续可以组合成更大的产品链。

## 技术架构

```text
src/shared
  契约、API schema、错误码
      |
src/server/storage
  事件、产物版本、任务目录、结构槽 blob/private/state
      |
src/server/template
  模板加载、哈希、缓存、basic/structured_slots 编译与 typestate 校验
      |
src/server/runtime
  Pi 适配、TaskRunner、TaskScheduler、ActionBuffer、ActionCommitter、门禁
      |
src/server/api                 src/client
  REST / structured-slot 只读 API  <- ForgeCoreGateway <- React UI
```

结构槽内部再分成两层：

```text
纯领域：canonical-json / slot-schema / layout-grammar / issues / profile
    -> 存储：appendBatch / blob / private journal / generation index / custody
    -> 运行时：attempt / grant / proposal / draft / seal / projection / tool
    -> 适配：模板 contract、Pi session、TaskScheduler、只读 API
```

### 模型与系统的边界

模型可以：

- 读取模板授权的 Skill 入口或 section；
- 读取授权的前序槽位摘要/内容；
- 在固定目标槽的 Draft 上写内容；
- 按模板路由发送消息、提交已封存输入或请求人工介入。

模型不能：

- 自己决定 ID、版本、路由、时间戳、任务状态或完成态；
- 直接写主事件流、artifact 目录、Grant、私有 Proposal/Draft；
- 把未校验草稿伪装成已 Seal 产物；
- 调用模板未声明的工具或绕过运行时 capability。

### 当前公开动作面

九个生产动作：

`load_skill`、`finish_production`、`annotate_artifact`、`read_artifact_version`、`publish_artifact`、`forward_input_version`、`submit_final_artifact`、`send_message`、`request_human_input`。

另有三个工作区动作 `write_workspace`、`read_workspace`、`list_workspace`，以及只读工具 `read_skill_section`、`validate_artifact`。结构槽工具由 Grant/AccessProfile 再收窄到当前槽位和授权 selector。

## 模板目录

| 模板 | 模式 | 产物/用途 | 当前定位 |
|---|---|---|---|
| `templates/long-form-hub` | `basic` | 长篇总控生产链 | 已有 basic 主模板 |
| `templates/outline-designer` | `basic` | 七轮大纲/蓝图 | 已有门禁与 Skill 渐进披露 |
| `templates/zhihu-single-chapter` | `basic` | 兼容的普通单章 | legacy/basic 保留 |
| `templates/zhihu-salt-chapter-draft` | `structured_slots` | `chapter.md` | 当前第一个结构槽业务模板 |

项目根目录的 `skills/` 是真实知乎盐选生产 Skill 资源的来源，包括：
`zhihu-salt-chapter-packet`、`zhihu-salt-outline-designer`、`zhihu-salt-outline-drafter`、`zhihu-salt-chapter-drafter`、`zhihu-salt-production-director`。

这些 Skill 不会自动变成一个“大而全”的模板。当前约定是“一套模板产出一个工件，再由多个模板组合”，每新增一个结构槽模板都要单独验证输入、槽合同、Gate、Assembler、产物和运行证据。

## 本地运行

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

真实 HTTP 后端：

```bash
FORGE_CORE_DATA_ROOT=$PWD/data \
FORGE_CORE_PORT=3210 \
VITE_FORGE_CORE_MODE=http \
npm run dev
```

打开 <http://127.0.0.1:3210/tasks>。真实模型运行需要 `.env` 中配置对应 Provider 的 API key；离线结构槽 acceptance 使用脚本化 Agent，不需要模型 token。Mock UI：

```bash
npm run dev:client -- --port 3211
```

常用环境变量：

- `FORGE_CORE_DATA_ROOT`：任务事件、产物和结构槽状态目录；
- `FORGE_CORE_TEMPLATE_ROOT`：模板根目录，默认 `$PWD/templates`；
- `FORGE_CORE_PORT`：HTTP 端口；
- `VITE_FORGE_CORE_MODE=http|mock`：前端 Gateway 模式。

从 UI 使用时先进入 `/tasks`，再打开任务详情；HTTP Gateway 会在任务列表读取后维护当前任务索引。

## 验证与生产门禁

普通改动至少运行：

```bash
npm run check
npm test -- --reporter=dot
npm run build
npm run e2e
```

结构槽改动还要运行：

```bash
# 不写生产证据，只检查离线 acceptance
npm run verify:structured-slots -- --acceptance-only --capability injected
npm run verify:structured-slots -- --acceptance-only --capability production

# 只有在 clean checkpoint、完整 integrated benchmark 和所有 gate 均通过时，
# 才按顺序执行 qualify -> promote；不要手工编辑 enabled manifest。
npm run benchmark:structured-slots -- --mode integrated-qualify \
  --profile src/server/structured-slots/platform-profile-v1.json \
  --evidence docs/evidence/structured-slot-platform-profile-v1.json \
  --adapter scripts/structured-integrated-benchmark-adapter.ts
npm run verify:structured-slots -- --qualify
npm run verify:structured-slots -- --promote-capability docs/evidence/structured-slot-release-v1.json
npm run verify:structured-slots -- --acceptance-only --capability production
```

qualification 会将源码摘要、lockfile、依赖版本、reference runner、每档 benchmark、profile、release evidence 和 capability manifest 串成单向摘要链。文档或代码变化后，必须重新走这条链；“测试绿色”不等于可以启用生产。

当前验收基线：全量 Vitest 110 个文件、2016 passed、1 skipped；结构槽 production acceptance 通过；Pi 0.82 的 characterization 只在锁定 seam 上运行。数字以最近一次实际命令输出和 evidence 为准，不要在代码外手工改报告。

## 未来迭代的工作方式

1. 先读本文、`docs/ONBOARDING-context.md`、`docs/ARCHITECTURE.md` 和 `docs/PROJECT-MAP.md`。
2. 明确改动属于平台、结构槽引擎、模板、Skill 还是 UI；不要为了某个业务模板把平台基础能力特化。
3. 先修改契约/设计和测试，再实现；新增模板优先采用独立工件边界。
4. 保持 basic 模式、九个 ForgeAction 和既有模板回归；结构槽问题必须 fail closed。
5. 使用独立 worktree 或明确分支；每个阶段记录命令、HEAD、证据和未解决项。
6. 完成后重新生成 qualification evidence，最后才提交并推送；不要把临时运行数据、API key、`.env` 或 `data/` 提交进仓库。

## 当前边界

- v1 只支持单任务串行生产；同一生产 case 内的并行槽生产暂不实现。
- 结构槽 UI 当前是只读审计抽屉，不是 Notion 式块编辑器；写入仍由 Agent + Draft/Seal 引擎完成。
- 当前业务模板只覆盖知乎盐选“单章正文”这一个结构槽工件；大纲、章节包、审核和全文总控尚未合并成一个大模板。
- 本项目是本地单进程产品，不提供远程多租户、分布式队列或云端数据库语义。
- 真实模型效果取决于模板输入包、Skill、Provider 配置和模型本身；离线 acceptance 证明的是系统边界，不等价于文学质量评审。

## 推荐阅读顺序

```text
README.md
  -> docs/ONBOARDING-context.md
  -> docs/ARCHITECTURE.md
  -> docs/PROJECT-MAP.md
  -> src/shared/contracts.ts
  -> src/server/template/template-loader.ts
  -> src/server/runtime/task-scheduler.ts
  -> src/server/runtime/structured-slot/
  -> templates/zhihu-salt-chapter-draft/
```

历史 spec、实现日志和审查记录仍保留在 `docs/`，但历史文档中的“进行中/disabled/provisional”表述只代表当时的快照，不应覆盖当前 `main` 的代码、manifest、测试和最新 evidence。
