# Forge Core

> 面向无上下文 Agent 的项目入口。本文描述当前 `main` 的产品边界、运行方式、核心不变量和后续迭代入口。  
> **v2 状态**：结构槽权威审核（`authoritative_review_v1` capability，**已启用**）。Plan 全部 29 个任务完成。详见 [`docs/CLOSURE-AUTHORITATIVE-REVIEW-V2.md`](docs/CLOSURE-AUTHORITATIVE-REVIEW-V2.md)、[`docs/superpowers/specs/2026-08-13-authoritative-per-slot-review-lifecycle-design.md`](docs/superpowers/specs/2026-08-13-authoritative-per-slot-review-lifecycle-design.md)、[`docs/superpowers/specs/2026-08-14-authoritative-per-slot-review-lifecycle-spec.md`](docs/superpowers/specs/2026-08-14-authoritative-per-slot-review-lifecycle-spec.md)、[`docs/superpowers/plans/2026-08-14-authoritative-per-slot-review-lifecycle.md`](docs/superpowers/plans/2026-08-14-authoritative-per-slot-review-lifecycle.md)。

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

## 当前能力（main 已交付）

两种生产模式共存于同一进程：

- `basic`（v2 runnable）—— 模板声明 Agent / Skill / 合法路由 / 产物结构。模型产出受 9 个 ForgeAction 注册表约束，最终交付门禁只由系统 gate 决定。当前承载 `templates/long-form-hub` 等总控级业务模板。
- `structured_slots`（双轨 v1 / v2）：
  - **v1**：模板验证 + Seal/Assembler 路径，向后兼容。
  - **v2（authoritative review）**：在 v1 的契约/事件/存储基础上叠加**审核生命周期**（Map 预审、per-slot / per-relation 事实、Finding + repair、scope expansion、Map 激活内容迁移、系统 Seal、SystemArtifactDelivery）。Agent **只能**提交逐节点的局部 verdict；Map 激活、aggregated pass、Seal、final commit 全部由系统背书。

模式由模板的 `productionMode` 决定。结构槽模板必须经过对应 runtime capability gate（v1 -> `forge-structured-runtime/v1`，v2 -> `forge-authoritative-review/v1`）。两个 capability 可以各自 disabled/enabled；capability disabled 时该协议的 v2 任务不 lease、不产生运行事件，但历史快照仍可只读查看。

### v2 权威审核生命周期（`authoritative_review_v1`）

六个动作边界，全部由系统持有、Agent 不可越过：

1. **结构门**：orchestrator 产出 MapCandidateSnapshot，系统验证 + 冻结；reviewer 只提交逐节点 + 逐实际关系 + 整图观察的局部 verdict。Map 激活（`map_approved=true`）由系统从冻结事实推导，**不**由 Agent 写入字段。
2. **内容门**：generator 写入受 WriteGrantSpec + GrantInstance 双重签发的目标槽；reviewer 只提交事实/adoption。finding lifecycle（open → repair_planned → addressed → verified_closed）由系统投影，**不**由 Agent 关闭。
3. **修复门**：Map/content repair 由系统签发 RepairGrant；扩权必须通过 successor plan revision 流程。
4. **Seal 门**：十项硬条件（设计 §16.2）由纯 `evaluateSealGate` 推导，agent result 不参与；映射/manifest/ReviewBundle 闭包用精确 `ref` 等价。
5. **交付门**：System Sealed artifact 由唯一 `system:structured_seal` producer 发布；SystemArtifactDelivery 的 custody / SealRecord / artifact 用 BlobRefV2 闭包，跨进程 artifact_store crossCheck 校验。
6. **Capability 门**：`authoritative_review_v1` 由 `--promote-capability` 唯一合法路径从 release evidence 翻转；re-promotion fail-closed；execution eligibility 在 profile digest 失配时降为 blocked，事件历史不变。

### 基础生产引擎（basic + v1 结构槽共享不变量）

- 模板快照：创建任务时冻结模板、输入和版本哈希，运行期间不读取可变模板。
- v2-only 回合契约：历史 v1 快照只读并标记不兼容；v2 走 TurnContract v2；结构槽 v2 用 TurnContract v4（独立于 basic v2）。
- 事件溯源 + AppendOnly：事件只追加，产物版本只递增；事件和版本目录相互校验，可恢复、可审计。v2 事件保持严格 `AuthoritativeReviewEventV2` 闭包 union。
- 系统交付门禁：`submit_final_artifact` 只有在独立校验通过后才能产生完成态；v2 端进一步经 SystemArtifactDelivery 绑定 Submitter attempt，禁止伪造 source-node 链接。
- 人工介入：无进展守卫可以停车，用户可继续、接受或停止；答案、作废和合成输入具有持久化恢复语义。
- 文件、HTTP 和浏览器 UI：同一套 Gateway 契约支持本地 Mock、HTTP 后端和 React 画布。v2 增 11 个只读端点 + 快照游标 + Locate-by-slotId。

## 技术架构

```text
src/shared
  契约、API schema、错误码、authoritative-review-v2 DTO
      |
src/server/storage
  事件 / 产物版本 / 任务目录 / v1 blob / v2 AuthoritativeBlobRefV2 存储
  profile archive / append facade / publication pins / GC
      |
src/server/template
  模板加载 / 哈希 / 缓存 / basic 与 structured_slots v1+v2 编译
      |
src/server/runtime
  Pi 适配 / TaskRunner / TaskScheduler / ActionBuffer / ActionCommitter / 门禁
  + authoritative-review/  runtime: state machine, attempt, grant, system command,
    seal, repair, migration, projection
      |
src/server/api                 src/client
  REST / v1 与 v2 只读 API  <-  ForgeCoreGateway  <-  React UI（v1 + v2 drawer）
```

v2 内部结构：

```text
纯领域：canonical-json / slot-schema / layout-grammar / issues
        + authoritative-review  (map/content/review/finding/work-item/seal-gate)
    -> 存储：appendBatch / blob / private journal / generation index / custody
        + AuthoritativeReviewBlobStore / AppendFacadeV2 / PublicationStore / GC
        + AuthoritativeTaskIndex / AuthoritativeTaskDeletion
    -> 运行时：attempt / grant / proposal / draft / seal / projection / tool
        + composition（installAuthoritativeReviewRuntime）
        + attempt-coordinator（runV2SchedulingTick）
    -> 适配：模板 contract、Pi session、TaskScheduler、Read API
```

### 模型与系统的边界

模型可以：

- 读取模板授权的 Skill 入口或 section；
- 在 v1 结构槽读取授权的前序槽位摘要/内容；
- 在 v2 结构槽提交 chunk/batch/finish_map_build（orchestrator）、write_slot_content（generator 受 Grant 限制）、submit_*_review / submit_finding_verification（reviewer 受 fact-verification 范围限制）、request_scope_expansion（受 ReviewPlan 限制）；
- 按模板路由发送消息、提交已封存输入或请求人工介入。

模型**不能**：

- 自己决定 ID、版本、路由、时间戳、任务状态或完成态；
- 直接写主事件流、artifact 目录、Grant、私有 Proposal/Draft；
- 把未校验草稿伪装成已 Seal 产物；
- 关闭 Finding、写入 `mapPassed` / `treePassed` / `sealApproved`、调用 `request_seal()`（v2 Agent 工具集中没有 seal 工具）；
- 选 `produces: chapter.md`（只有 `system:structured_seal` 能 produce v2 artifact）；
- 凭单方面 verdict 让 `map_approved=true` 或绕过 Seal 门；
- 假装 Sealed；productor/provenance 不能用 Agent source-node 伪装。

### 当前公开动作面

九个生产动作：`load_skill`、`finish_production`、`annotate_artifact`、`read_artifact_version`、`publish_artifact`、`forward_input_version`、`submit_final_artifact`、`send_message`、`request_human_input`。

结构槽 **v1** 工作区动作 + Grant/AccessProfile；结构槽 **v2** 在 orchestrator/generator/reviewer session 内只暴露封闭的 v2 工具集（Map Build/Generation/Content Review/Map Repair/Content Repair 各自工具），通用 Submitter 仅保留 base action + `submit_final_artifact`。

## 模板目录

| 模板 | 模式 | 产物 / 用途 | 当前定位 |
|---|---|---|---|
| `templates/long-form-hub` | `basic` | 长篇总控生产链 | 已有 basic 主模板 |
| `templates/outline-designer` | `basic` | 七轮大纲/蓝图 | 已有门禁与 Skill 渐进披露 |
| `templates/zhihu-single-chapter` | `basic` | 兼容的普通单章 | legacy/basic 保留 |
| `templates/zhihu-salt-chapter-draft` | `structured_slots` v2 | `chapter.md` | v2 权威审核已启用；maxSlots=10_000 |

`zhihu-salt-chapter-draft` 表达为 `title -> opening -> scene_block* -> emotional_closure -> chapter_end`，输出单个 `chapter.md`；模板绑定 `chapter_packet / previous_draft / repair_order` 输入。模板声明 narrative optional 关系（sequence / state_inheritance / information_dependency）+ 4 个 v2 builtin validators + Task 21 assembler 严格 binding。模板**不**再包含 seal Agent/prompts/render.cjs/validate.cjs——Seal 是系统阶段，artifact 是 system producer。

项目根目录的 `skills/` 是真实知乎盐选生产 Skill 资源的来源，包括：
`zhihu-salt-chapter-packet`、`zhihu-salt-outline-designer`、`zhihu-salt-outline-designer`、`zhihu-salt-outline-drafter`、`zhihu-salt-chapter-drafter`、`zhihu-salt-production-director`。

每个 Skill 只绑定到需要的模板，不把全部业务 Skill 编译进平台。新增结构槽模板遵循“一套模板产出一个工件，再由多个模板组合”。

## 本地运行

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

填 `.env` 内的 Provider API key（默认模板 4 个 agent 绑定 `deepseek/deepseek-v4-flash`；可改回 `opencode/claude-haiku-4-5` 等）。

真实 HTTP 后端：

```bash
FORGE_CORE_DATA_ROOT=$PWD/data \
FORGE_CORE_PORT=3210 \
VITE_FORGE_CORE_MODE=http \
npm run dev
```

打开 <http://127.0.0.1:3210/tasks>。v1 任务进任务详情用旧 drawer；v2 任务进任务详情自动切到六视图 drawer（overview / virtual-tree / relationship / review-rounds / findings / seal-readiness）。

Mock UI（前端独立演示，无真实后端）：

```bash
npm run dev:client -- --port 3211
```

常用环境变量：

- `FORGE_CORE_DATA_ROOT`：任务事件、产物和结构槽状态目录；
- `FORGE_CORE_TEMPLATE_ROOT`：模板根目录，默认 `$PWD/templates`；
- `FORGE_CORE_PORT`：HTTP 端口；
- `VITE_FORGE_CORE_MODE=http|mock`：前端 Gateway 模式；
- `DEEPSEEK_API_KEY`（或其它 Provider 等价）：真实模型调用所需；缺则 Pi turn 立刻 retries，v2 hermetic 验收不需。

HTTP Gateway 在任务列表读取后维护当前任务索引；v2 任务的 11 个只读端点路径前缀 `/api/tasks/:taskId/structured-slots/...`（如 `.../map`、`.../review/summary`、`.../review/findings`、`.../review/seal-readiness`、`.../tree/locate/:slotId`）。

## 验证与生产门禁

普通改动至少运行：

```bash
npm run check
npm test -- --reporter=dot
npm run build
npm run e2e
```

v1 / basic 结构槽验收：

```bash
npm run verify:structured-slots -- --acceptance-only --capability injected
npm run verify:structured-slots -- --acceptance-only --capability production
```

v2 权威审核验收（capability 已 enabled）：

```bash
npx tsx scripts/verify-authoritative-review.ts --acceptance-only --capability injected
npx tsx scripts/verify-authoritative-review.ts --acceptance-only --capability production
```

v1 + v2 干净 checkpoint + 10k qualification + capability promote（只在 v1 capability 变更或首次 enable v2 时跑全套）：

```bash
# v1
npm run benchmark:structured-slots -- --mode integrated-qualify \
  --profile src/server/structured-slots/platform-profile-v1.json \
  --evidence docs/evidence/structured-slot-platform-profile-v1.json \
  --adapter scripts/structured-integrated-benchmark-adapter.ts
npm run verify:structured-slots -- --qualify
npm run verify:structured-slots -- --promote-capability docs/evidence/structured-slot-release-v1.json

# v2
npx tsx scripts/benchmark-authoritative-review.ts --mode integrated-qualify \
  --profile src/server/structured-slots/authoritative-review-profile-v1.json \
  --evidence docs/evidence/authoritative-review-platform-profile-v1.json
npx tsx scripts/verify-authoritative-review.ts --qualify
npx tsx scripts/verify-authoritative-review.ts --promote-capability docs/evidence/authoritative-review-release-v1.json
```

`authoritative_review_v1` 当前已 enabled（promoted HEAD `6f075e7`）。再次走 promote 必须先关闭 capability（脏 source 不可 promote）；唯一合法 `--promote-capability` 路径禁止 re-promotion（fail-closed）。

real acceptance 证据：`docs/evidence/authoritative-review-real-case-v1.json`（hermetic-only anchor；real provider path `--allow-hermetic-only` + 真模型）。

## 未来迭代的工作方式

1. 先读本文 + `docs/CLOSURE-AUTHORITATIVE-REVIEW-V2.md` + `docs/ONBOARDING-context.md` + `docs/ARCHITECTURE.md` + `docs/PROJECT-MAP.md`。
2. 明确改动属于平台、basic 引擎、结构槽 v1、结构槽 v2、模板、Skill 还是 UI；不要为了某个业务模板把平台基础能力特化。
3. 先修改契约/设计和测试，再实现；v2 改动必须同时更新 design / spec / plan 三份权威文档，并在 `docs/superpowers/specs/` 与 `docs/superpowers/plans/` 留同步记录。
4. 保持 basic 模式、九个 ForgeAction 和 v1 结构槽回归；v2 改动不能破坏 v1 capability；任何结构槽问题必须 fail closed。
5. 使用独立 worktree 或明确分支；每个阶段记录命令、HEAD、profile digest、release evidence、capability 状态和未解决项。
6. v2 capability disable 期间不允许创建新 v2 任务；enable 必须经唯一合法 `--promote-capability` 路径；提交后立刻把脏 evidence（若未 commit）写进专用末尾 commit，不要污染 enable commit。
7. 不要把 `.env`、API key、`.pi-agent*`、`data/`、临时运行日志作提交源文件。`.pi-agent`、`auth.json` 已被 `.gitignore` 排除。

## 当前边界

- 真实 Pi 0.82 集成仍处于 provider 协议层调试期：DeepSeek direct API 已验证联通，但 Agent turn 在真实 `@earendil-works/pi-coding-agent` 链路中可能卡死——本地运行时如遇 turn 长时间未返回，请先用 `--allow-hermetic-only` 路径收齐 evidence，再开 SDK 兼容性 issue。**不要**静默吞异常；turn 超时应在 SDK listener 中显式 terminal。
- v1 只支持单任务串行生产；同一生产 case 内的并行槽生产暂不实现。
- 结构槽 UI 当前是只读审计抽屉（v1 + v2），不是 Notion 式块编辑器；写入仍由 Agent + Draft/Seal 引擎（v1）或 Grant 签发（v2）完成。
- 当前业务模板只覆盖知乎盐选“单章正文”这一个结构槽工件；大纲、章节包、审核和全文总控尚未合并成一个大模板。
- 本项目是本地单进程产品，不提供远程多租户、分布式队列或云端数据库语义。
- 真实模型效果取决于模板输入包、Skill、Provider 配置和模型本身；离线 acceptance 证明的是系统边界，不等价于文学质量评审。

## 推荐阅读顺序

```text
README.md                              <- 你在这里
  -> docs/CLOSURE-AUTHORITATIVE-REVIEW-V2.md   <- v2 收尾总览（Task 21 审查修复 + Task 22-29）
  -> docs/superpowers/specs/2026-08-13-authoritative-per-slot-review-lifecycle-design.md
  -> docs/superpowers/specs/2026-08-14-authoritative-per-slot-review-lifecycle-spec.md
  -> docs/superpowers/plans/2026-08-14-authoritative-per-slot-review-lifecycle.md
  -> docs/ONBOARDING-context.md
  -> docs/ARCHITECTURE.md
  -> docs/PROJECT-MAP.md
  -> src/shared/contracts.ts + src/shared/authoritative-review-v2.ts
  -> src/server/template/template-loader.ts
  -> src/server/runtime/task-scheduler.ts
  -> src/server/runtime/structured-slot/           <- v1
  -> src/server/runtime/authoritative-review/      <- v2（含 production-composition.ts）
  -> src/server/authoritative-review/               <- v2 纯域（map/content/review/finding/seal-gate）
  -> templates/zhihu-salt-chapter-draft/
```
