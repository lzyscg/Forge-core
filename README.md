# Forge Core

> 给「没有上下文的 agent」的项目说明书。读完本文件应能定位任何代码、理解不变量、独立运行与测试。

Forge Core 是一个**本地、单进程**的多 Agent 内容生产产品：模板声明若干 Agent、Skill 与合法路由；运行时驱动 Agent 串行协作（写作 → 审核退回 → 返修 → 复审 → 系统独立交付），全过程在浏览器画布上可视化（回合卡、思维/工具流式预览、产物版本链）。它是「中间层接管工程、模型只管内容」的最小可行实现。

## 一句话产品循环

```
创建任务(冻结模板+输入) → 写作Agent起草(可load_skill/写工作区) → publish_artifact(V1)
→ 审核Agent退回(send_message) → 写作返修(V2) → 复审通过 → submit_final_artifact
→ 系统独立校验后交付（模型说完成不算数）
```

## 技术栈

- TypeScript + React 18 + react-router 6（client，Vite 构建）
- Node 单进程文件后端（无数据库；追加式事件文件 + 版本化产物目录）
- Pi Agent Runtime：`@earendil-works/pi-coding-agent` / `pi-ai` 0.82（真实模型）；测试用 `FakeAgentRuntime`（脚本化，不碰 Provider）
- 测试：Vitest（单元/组件，jsdom）、Playwright（e2e，双视口）

## 目录结构

```
src/shared/            契约（contracts.ts 冻结）、api-schemas、errors
src/client/            五页 UI + gateway + mock（浏览器本地演示）
  pages/               生产任务/模板/新建/模板详情/开发进度 五页
  components/          turn-card / workspace-canvas / flow-overlay / 抽屉 / 浮窗
  gateway/             ForgeCoreGateway 接口 + http-gateway + mock-gateway
  mock/                浏览器本地 MockGateway + 确定性脚本(mock-simulator)
src/server/            文件后端 + 调度
  main.ts              入口（env 配置）
  core-service.ts      组装编排（deleteTask/生命周期/live 缓冲）
  runtime/             PiAgentRuntime(薄适配) / task-runner / task-scheduler
                       / action-committer / skill-service / live-store / retry-policy
  storage/             core-paths / event-store(追加) / artifact-store(版本)
                       / task-store / task-projector
  template/            模板加载/校验/最后有效缓存
  api/                 REST 路由（/api/templates、/api/tasks、DELETE 等）
templates/             业务模板（long-form-hub 长篇总控中枢；zhihu-single-chapter 保留为 v2 升级版）
e2e/                   Playwright 门禁
scripts/               verify-*/probe:pi/acceptance-* 门禁脚本
```

## 不变量 / 铁律（改代码前必读）

1. **平台零业务词**：业务语义只存在于 `templates/` 与 mock fixture；平台代码不出现「章节/写作/审核/知乎」等词。
2. **模型不碰工程数据**：ID/版本/时间戳/路由由系统补；模型只调九类生产动作 + 三个工作区动作。
3. **事件只追加不覆盖**：`events/<6位序列>-<uuid>.json`；产物版本只增不改；损坏隔离不猜测。
4. **交付由系统门禁决定**：`submit_final_artifact` 经独立校验才完成；自然语言不算数。
5. **单一执行槽**：全进程一次只跑一个 Agent Turn；stop/abort 有界等待、stale 结果不提交。
6. **凭据/隐藏思维链不上屏、不持久化**：live 缓冲纯内存；durable trace 只保留公开文本/工具步骤，raw provider thinking 永不落盘；`probe:pi` 报告脱敏。
7. **Pi 约束**：内置工具/自动 Skill/压缩/自动重试全关；只暴露九个生产动作工具 + 三个工作区工具。
8. **v2-only runnable**：当前唯一可执行回合契约是 version 2；历史 v1 快照只读、gate 为 `incompatible`，可 clone 到当前模板。

## 数据模型（每任务一个目录）

```
data/tasks/<taskId>/
  task.json            冻结记录（templateId/templateVersion/frozenInput）
  snapshot/            冻结模板快照（校验后拷贝，versionHash 复核）
  events/              追加式事件（agent_input/result/attempt_failed/route_executed/
                       artifact_published/artifact_annotated/skill_loaded/human_*/
                       pending_inputs_superseded/final_submission_accepted…）
  artifacts/vNNN/      版本目录：content.md|txt（正文）+ revision.md（修订）
                       + review.md（审核意见）+ meta.json（版本只增）
  traces/<turnId>.json 展示用回合过程（公开文本/工具步骤，无 raw thinking）
```

## 关键契约

- `contracts.ts`：`TaskWorkspace`/`WorkspaceNode`/`ArtifactVersion.files[].extract`/`LiveTurn`。冻结，改它要全链路同步。
- `ForgeCoreGateway`：listTemplates/getTemplate/reloadTemplate/createTask/listTasks/getWorkspace/start/stop/resume/retry/answerHuman/submitHumanDecision/**deleteTask**/watchTask/getTurnTrace/getSkillContent/cloneTask。
- 动作注册表九类：`load_skill/finish_production(多文件)/annotate_artifact/read_artifact_version/publish_artifact/forward_input_version/submit_final_artifact/send_message/request_human_input`；工作区三类：`write/read/list_workspace`。

## 运行

```bash
npm install && npx playwright install chromium
cp .env.example .env   # 填 DEEPSEEK_API_KEY（真实运行必需）

# 真实后端（HTTP 模式）
FORGE_CORE_DATA_ROOT=$PWD/data FORGE_CORE_TEMPLATE_ROOT=$PWD/templates \
FORGE_CORE_PORT=3210 VITE_FORGE_CORE_MODE=http npm run dev   # http://127.0.0.1:3210

# Mock 演示（零 token）
npm run dev:client -- --port 3211                            # http://127.0.0.1:3211
```

## 测试 / 门禁

```bash
npm run check && npm test && npm run build && npm run e2e
npm run verify:ui && npm run verify:backend && npm run verify:runtime
npm run probe:pi -- --provider deepseek --model deepseek-v4-flash --report /tmp/b.json
```

## 五个页面

`/tasks` 任务列表(删除/重跑) · `/tasks/:id` 生产画布(回合卡+流式+抽屉) · `/tasks/new` 新建 · `/templates[/:id]` 模板 · `/dev/progress` 开发进度(仅 URL 可达)。

## 已完成（A–E）

A 产品形态(Mock) · B 文件/HTTP 后端 · C Pi Runtime/调度/恢复 · D 真实 Provider 闭环 · E UI（整页布局/回合卡合并/实时流式/删除）。全部 TDD、门禁绿。后续方向：Skill 迭代对比视图（同输入跑两版 Skill 并排）。

## 先读这些

`src/shared/contracts.ts` → `src/server/core-service.ts` → `src/server/runtime/task-scheduler.ts` → `src/server/storage/task-projector.ts` → `src/client/components/turn-card.tsx`。

### docs 索引

- `docs/ARCHITECTURE.md` —— 当前稳定架构与核心不变量（v2-only、9 动作、事件溯源、人工介入）。
- `docs/PROJECT-MAP.md` —— 模块地图、关键类、调用链、数据目录、测试门禁。
- `docs/IMPLEMENTATION-LOG.md` —— 实施历史（v7 各 Phase 做了什么/关键决策/已知局限）。
- `docs/2026-08-07-*.md` —— v7 产物版本目录制 的 spec / dev-plan / 语义审计修复计划。
- 更早的 `docs/2026-08-0*.md` —— 历史设计与实现记录（保留作历史，不反映当前行为）。

