# Forge Core 项目地图

> 当前稳定版（v7）模块地图、关键类、调用链、数据目录与测试门禁。配套 `docs/ARCHITECTURE.md`（不变量）。

## 目录结构

```
src/shared/            跨端契约（contracts.ts 冻结）、api-schemas、errors
src/client/            五页 UI + gateway + mock（浏览器本地演示）
  pages/               生产任务/模板/新建/模板详情/开发进度
  components/          turn-card / workspace-canvas / artifact-drawer / flow-overlay / 抽屉 / 浮窗 / process-trace-dialog
  gateway/             ForgeCoreGateway 接口 + http-gateway + mock-gateway + gateway-contracts
  mock/                浏览器本地 MockGateway + mock-simulator + mock-projector
src/server/            文件后端 + 调度
  main.ts              env 入口（FORGE_CORE_DATA_ROOT/TEMPLATE_ROOT/PORT/MODE/RUNTIME）
  core-service.ts      CoreService：组装编排（tasks/events/artifacts/workspaces/traces/runner/scheduler/live）
  runtime/             PiAgentRuntime(薄适配) / task-runner / task-scheduler / action-committer /
                       action-buffer / forge-actions / annotate-verdict / progress-guard /
                       pi-tool-factory / workspace-tools / skill-service / live-store / retry-policy /
                       fake-agent-runtime / workspace-store / test-support
  storage/             core-paths / event-store(追加) / artifact-store(版本目录) / task-store /
                       task-projector / trace-store / task-events / atomic-file
  template/            模板加载/校验/最后有效缓存（template-loader/validator/schema/catalog/cache）
  api/                 REST 路由（templates / tasks / trace / skill-content / DELETE）
templates/             long-form-hub（总控中枢，v7 主模板）、zhihu-single-chapter（v2 升级保留）
e2e/                   Playwright 门禁（runtime-loop / product-flow / process-trace / recovery…）
scripts/               verify-* / probe:pi / acceptance-* / write-final-evidence
docs/                  见 README「docs 索引」
```

## 主调用链

```
main.ts → createForgeCoreServer
  → CoreService.initialize → TemplateCatalog.initialize
  → API 路由：start → TaskScheduler.startDetached → execute()
      → TaskRunner.runNext(taskId, signal)
          → 事件读取 + frozen snapshot
          → 输入组装（resolveIncomingDelivery + route.inject + checklist）
          → AgentRuntime.run(input, signal) → AgentTurnResult{ publicText, actions, trace }
              → ActionBuffer（阶段机 propose/succeed/commit）
          → ActionCommitter.validateAndCommit(context, actions)
              → EventStore.append（agent_result/annotate/publish/routes/forward/submit/human）
              → ArtifactStore（版本目录写/标注）
      → 循环直到 rest 状态（completed/waiting_human/retryable_failure/interrupted）
  → TaskProjector.projectTask({record, frozen}, events, artifacts) → TaskWorkspace
  → HTTP /api/tasks/:id/workspace → HttpGateway → React UI
```

## 关键类速查

| 类 / 模块 | 职责 | 关键方法 |
|---|---|---|
| `TaskScheduler` | 全局单槽 + 生命周期 + 无进展守卫 + 人工介入 | `start/stop/resume/retry/answer/answerDetached`, `guardNoProgress`, `supersede+synthesize` |
| `TaskRunner` | 一次一 Turn，输入组装，调用 runtime，提交 | `runNext`, `assembleTurnInput`（inject）, `pendingAgents` |
| `ActionBuffer` | 回合阶段机（production/operate/coordinate） | `propose`（阶段校验）, `succeed/commit/fail` |
| `ActionCommitter` | 不可绕过提交边界 | `validateAndCommit`（阶段/契约/annotate/路由/可达性/final 门禁） |
| `forge-actions` | 9 动作注册表 + 形状/禁键校验 | `validateForgeAction`, `FORGE_ACTION_LIMITS` |
| `annotate-verdict` | annotate frontmatter verdict 共享校验 | `parseAnnotateVerdict` |
| `progress-guard` | 无进展纯函数 | `evaluateProgress`, `PROGRESS_POLICY` |
| `EventStore` | 追加事件（validate + normalizeLegacyEvent） | `append`, `read` |
| `ArtifactStore` | 版本目录 + 事件权威版本号 + cross-check | `publish`, `annotate`, `read`, `claimStagedVersion` |
| `TaskProjector` | 事件折叠 → TaskWorkspace | `projectTask`（nodes/routes/artifacts/status） |
| `TraceStore` | 展示用回合过程（无 raw thinking） | `appendTurnTrace`, `readTurnTrace` |
| `PiAgentRuntime` | 约束 Pi 适配（9 工具 + 阶段机） | `run`（会话/流式/trace） |
| `pi-tool-factory` | 9 工具定义 + annotate frontmatter 工具层校验 | `createForgeToolDefinitions` |
| `TemplateCatalog/Loader/Validator` | 模板加载/校验/缓存/哈希 | `loadTemplateDirectory`, `validatePipelineFile` |

## 数据目录

```
data/tasks/<taskId>/
  task.json             冻结记录（templateId/templateVersion/frozenInput）
  snapshot/             冻结模板快照（template.yaml + agents/ + prompts/ + pipeline.yaml，versionHash 复核）
  events/               追加式事件 JSON（<6位序列>-<uuid>.json）
  artifacts/vNNN/       版本目录（content.md|txt / revision.md / review.md / meta.json）
  traces/<turnId>.json  展示用回合过程（phase + 公开文本 + tool 步骤）
  workspaces/<agentId>/ Agent 私有草稿
```

## 测试门禁

| 门禁 | 命令 | 覆盖 |
|---|---|---|
| 类型检查 | `npm run check` | tsc --noEmit |
| 单元/集成 | `npm test` | Vitest（70 文件 ~1140 用例） |
| e2e | `npm run e2e` | Playwright（44 桌面 + 10 移动截图） |
| 构建 | `npm run build` | vite + tsc server |
| 后端验证 | `npm run verify:backend` | gateway-contracts + server-modules + http-persistence |
| 运行时验证 | `npm run verify:runtime` | runtime-modules + e2e-runtime-loop + recovery + pi-boundary（真实 probe） |
| 真实验收 | `npm run acceptance:real` | 真实 Provider 端到端（直接使用提交的 `templates/`） |

**测试纪律**：跨层语义测试（`task-runner.test.ts` 的 v7 input assembly / v7 forward path）直接断言下一个 Agent 实际收到的 `AgentTurnInput.inputText`，而不只验证事件字段。
