# Forge Core 项目地图

> 当前 `main` 的模块地图、关键类、调用链、数据目录与测试门禁。基础版本契约为 v7，结构槽引擎为 v1 + v2（authoritative review）。配套 `docs/ARCHITECTURE.md`（不变量）与 `docs/CLOSURE-AUTHORITATIVE-REVIEW-V2.md`（v2 收尾总览）。

## 目录结构

```
src/shared/            跨端契约（contracts.ts 冻结）、api-schemas、errors
                       authoritative-review-v2 DTO（BlobRefV2 / AuthoritativeBlobKindV2 / 11 端点 + 3 mutation 的 TypeBox）
src/client/            五页 UI + gateway + mock（浏览器本地演示）
  pages/               生产任务/模板/新建/模板详情/开发进度
  components/          turn-card / workspace-canvas / artifact-drawer(v2 系统 provenance)
/ flow-overlay /
                       抽屉 / 浮窗 / process-trace-dialog
                       structured-review/{drawer,review-overview,virtual-review-tree,relationship-view,
                       review-rounds-view,findings-view,seal-readiness-view} (v2 六视图)
  gateway/             ForgeCoreGateway 接口 + http-gateway + mock-gateway + gateway-contracts
  mock/                浏览器本地 MockGateway + mock-simulator + mock-projector
src/server/            文件后端 + 调度
  main.ts              env 入口（FORGE_CORE_DATA_ROOT/TEMPLATE_ROOT/PORT/MODE/RUNTIME）
  core-service.ts      CoreService：组装编排（v1 + v2 stack：tasks/events/artifacts/workspaces/traces/
                       runner/scheduler/live + v2Facade/v2Wakeups/v2Index/v2Scheduling/v2Composition/
                       v2Coordinator/v2Lifecycle/v2PublicationStore/v2BlobStore/v2CheckpointStore/
                       v2CursorSigner + v2 review routes）
  runtime/             PiAgentRuntime(薄适配) / task-runner / task-scheduler / action-committer /
                       action-buffer / forge-actions / annotate-verdict / progress-guard /
                       pi-tool-factory / workspace-tools / skill-service / live-store / retry-policy /
                       fake-agent-runtime / workspace-store / test-support
  runtime/structured-slot/
                       structured_slots v1 运行时（attempt-coordinator / attempt-meter / proposal-service /
                       draft-service / grant-service / seal-service / projection-service /
                       session-service / structured-committer / tool-factory / validation-engine / evaluator-runner）
  runtime/authoritative-review/
                       结构槽 v2 运行时：
                         work-item-coordinator (CAS lease/claim/reclaim/retry/park/supersede)
                         attempt-coordinator (runNext / executeLeased / generic submit finalization)
                         assignment-runner (Pi turn wrapper + generic + system command dispatch)
                         system-command-registry / attempt-coordinator / tool-factory / grant-service /
                         map-build-service / map-review-service / content-plan-service /
                         content-review-service / repair-service / migration-service /
                         validator-registry / validator-engine / assembler-registry /
                         reviewer-tool-factory / production-composition.ts（installAuthoritativeReviewRuntime） /
                         seal-authority-resolver.ts / system-seal-service.ts /
                         system-artifact-delivery.ts / projection-service.ts / reviewer-coordinator.ts /
                         startup-recovery.ts / wakeup-index.ts / task-lifecycle.ts
  structured-slots/    结构槽 v1 纯领域层（canonical-json / slot-schema / layout-grammar / issues /
                       artifact-custody 等 v2 kind 也注册在这里）/ runtime capability (v1)
  authoritative-review/  结构槽 v2 纯领域层（map-domain / content-domain / review-domain /
                       finding-domain / work-item-domain / seal-gate / object-registry / authority-types）
                       platform-profile / runtime-capability）
  storage/             core-paths / event-store(追加+batch) / artifact-store(版本目录) / task-store /
                       task-projector / trace-store / task-events / atomic-file /
                       structured-slot-blob-store / structured-slot-private-store / structured-slot-state /
                       authoritative-review-blob-store / authoritative-publication-store /
                       authoritative-publication-intent-registry / authoritative-append-facade /
                       authoritative-review-gc / authoritative-review-state /
                       authoritative-review-checkpoint-store / review-cursor-keyring /
                       authoritative-task-index / authoritative-task-deletion
  template/            模板加载/校验/最后有效缓存（template-loader/validator/schema/catalog/cache）/
                       结构槽 contract/typestate 编译（structured-slot-contract-v2 / structured-pipeline-validator /
                       authoritative-review-pipeline-validator / authoritative-review-profile /
                       authoritative-review-capability）
  api/                 REST 路由（templates / tasks / trace / skill-content / structured-slots 只读 v1 + v2 /
                       DELETE / answer / reopen-failed）
templates/             long-form-hub（basic 总控）、outline-designer（basic 大纲）、
                       zhihu-single-chapter（basic 兼容）、zhihu-salt-chapter-draft（structured_slots v2 单章）
skills/                真实知乎盐选 Skill（章节包/大纲/章节正文/总控）
e2e/                   Playwright 门禁（runtime-loop / product-flow / process-trace / recovery…
                       + authoritative-review-real-provider.spec.ts env-gated）
scripts/               v1: verify-* / probe:pi / acceptance-* / write-final-evidence / benchmark-structured-slots
                       v2: verify-authoritative-review / benchmark-authoritative-review /
                            authoritative-review-real-acceptance / authoritative-review-evidence-schema /
                            authoritative-review-integrated-benchmark-adapter /
                            authoritative-review-qualification-outputs
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
  → HTTP /api/tasks/:id/workspace → HttpGateway → React UI（v1 drawer 或 v2 drawer）

v2 调度并行路径（与 v1 互不干扰，按协议分发）：
  → TaskStore.create / TaskLifecycleV2.startV2
  → AuthoritativeV2SchedulingEngine.runPass (reclaim/due requeue/lease ONE)
  → runV2SchedulingTick: runPass + 对每个 leased WorkItem 调 AttemptCoordinator.executeLeased
  → AttemptCoordinator：structured/generic/system-command 三种 attempt kind
  → SystemCommandRegistry 路由到 6 个真实 handler（map_finalize / generation_finalize /
    repair_finalize / migration_validation_batch / review_settlement / seal）
  → Seal handler: SealAuthorityResolver → evaluateSealGate → AssemblerRegistry → 
    SystemArtifactDelivery + AuthoritativeAppendFacadeV2 原子批（含 6 事件）
  → Submitter WorkItem (generic_turn) → final commit 原子批
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
| `EventStore` | 追加事件（validate + normalizeLegacyEvent）+ 结构化原子 batch | `append`, `read`, `appendBatch`, `readBatchByCommitId` |
| `ArtifactStore` | 版本目录 + 事件权威版本号 + cross-check + 结构化 custody | `publish`, `annotate`, `read`, `claimStagedVersion`, `stagePreparedVersion`, `promotePreparedVersion` |
| `TaskProjector` | 事件折叠 → TaskWorkspace | `projectTask`（nodes/routes/artifacts/status） |
| `TraceStore` | 展示用回合过程（无 raw thinking） | `appendTurnTrace`, `readTurnTrace` |
| `PiAgentRuntime` | 约束 Pi 适配（9 工具 + 阶段机） | `run`（会话/流式/trace） |
| `pi-tool-factory` | 9 工具定义 + annotate frontmatter 工具层校验 | `createForgeToolDefinitions` |
| `TemplateCatalog/Loader/Validator` | 模板加载/校验/缓存/哈希 + 模式分叉（basic 拒 slots/v3，structured 需 enabled 环境） | `loadTemplateDirectory`, `validatePipelineFile`, `resolveStructuredSlots` |
| `structured-slots/`（纯领域） | canonical JSON / Slot Schema / LayoutGrammar / issues / profile / capability（零存储、零运行时依赖） | `canonicalJsonSha256`, `compileSlotSchemaV1`, `compileLayoutGrammarV1`, `loadStructuredPlatformProfile` |
| `runtime/structured-slot/` | structured_slots v1 运行时：Attempt 协调与计量、Grant、Proposal/Draft 会话、Seal/Assembler、授权投影、原子提交、Slot Tool、validator/Assembler 沙箱 | `attempt-coordinator`, `attempt-meter`, `proposal-service`, `draft-service`, `grant-service`, `seal-service`, `projection-service`, `session-service`, `structured-committer`, `tool-factory`, `validation-engine`, `evaluator-runner` |
| `structured-slot-routes` | v1 只读 REST（contract/tree/slot/issues/seal，TypeBox exact schema + cursor） | `GET /api/tasks/:taskId/structured-slots/{contract,tree,slots/:slotId,issues,seal}` |
| `TaskWorkspace.structuredSlotsSummary` | 可选结构化摘要（mode/scaffold/generation/revision/status/计数），basic 不输出，不嵌 content/树/Grant/私有 Draft | `StructuredSlotsSummaryV1` |
| `authoritative-review/`（纯领域） | v2 纯域：`map-domain` / `content-domain` / `review-domain` / `finding-domain` / `work-item-domain` / `seal-gate`（十项硬条件）/ `object-registry` / `authority-types` / `object-schemas` / `object-schema-parsers-3` | `evaluateSealGate`, `deriveMapSnapshot`, `canFactBeAdopted`, `validateAuthoritativeReviewProfile` |
| `runtime/authoritative-review/production-composition.ts` | v2 装配根：六 handler 真实 registry + V2AttemptCoordinator + runV2SchedulingTick 接入 mutation driver | `installAuthoritativeReviewRuntime` |
| `runtime/authoritative-review/seal-authority-resolver.ts` | Gate 系统推导：lease/epoch/base/payload 精确绑定 + 10 条件从 projection+blob 闭包推导 + blocking 关系按 Map+模板 enforcement 枚举 | `createSystemSealAuthorityResolver` |
| `runtime/authoritative-review/system-seal-service.ts` | SystemSealServiceV2：seal_input/assembler/seal_output/custody/stage/publish | `execute`（绑定 resolver） |
| `runtime/authoritative-review/system-artifact-delivery.ts` | SystemArtifactDelivery + final submission 9 条闭包校验 | `validateFinalSubmission` / `finalizeGenericSubmission` |
| `runtime/authoritative-review/work-item-coordinator.ts` | WorkItem create/lease/claim/reclaim/retry/park/supersede + attempt-completion CAS | `createWorkItem / completeWorkItem` |
| `runtime/authoritative-review/attempt-coordinator.ts` | structured/generic/system-command 三 attempt + runV2SchedulingTick | `runNext / executeLeased` |
| `runtime/authoritative-review/system-command-registry.ts` | 六封闭 kind + `replace()` seam | `resolve('seal')` |
| `runtime/authoritative-review/{map-build,map-review,content-plan,content-review,repair,migration}-service.ts` | v2 域服务 | `MapBuildService / MapReviewService / ContentPlanService / ContentReviewService / RepairService / MigrationService` |
| `runtime/authoritative-review/{validator-registry,validator-engine,assembler-registry}.ts` | Validator v2 / Assembler v2 allowlist | `runValidatorV2` / `assemble` |
| `runtime/authoritative-review/task-lifecycle.ts` / `startup-recovery.ts` / `wakeup-index.ts` | v2 生命周期 + 持久恢复 + durable wakeups | `startV2 / resumeV2 / retryV2 / reopenFailed` |
| `storage/authoritative-review-state.ts` | v2 纯域投影（map/currentMap/currentManifest/rounds/findings/seal/delivery）+ 合并 v1/v2 artifact 版本 | `readState / projectAuthoritativeReviewState` |
| `storage/authoritative-append-facade.ts` | v2 唯一 append 路径（跨进程 store fence + fresh-tail CAS + pin） | `publishWithPin` |
| `storage/authoritative-publication-store.ts` | durable PublicationPin + generation barrier + recursive GC | `lock / acquire / snapshotPins` |
| `storage/authoritative-review-blob-store.ts` | BlobRefV2 put/read/recursive ref 校验 | `putJson / readJson / resolveClosure` |
| `storage/authoritative-publication-intent-registry.ts` | typed `PublicationIntentV2` + 11-ref closure 校验 | `register /resolve`（system_seal_publish） |
| `storage/authoritative-task-index.ts` + `authoritative-task-deletion.ts` | 安装级 v2 task index + 跨进程 fenced deletion (prepared→detached→purged) | `entryFor / addPrepared / markActive / isDeleted` |
| `storage/authoritative-review-checkpoint-store.ts` + `review-cursor-keyring.ts` | 持久 v2 投影 checkpoint + 安装级 cursor signing keyring | `readState / rebuild` / `verify / sign / rotateKey` |
| `api/authoritative-review-routes.ts` | v2 11 个 GET + answer/reopen/delete 分支 | `structuredReviewRoutes` |
| `TaskWorkspace.authoritativeReview` | v2 顶层摘要（executionEligibility / pendingQuestion / version），无 private blob | `AuthoritativeReviewWorkspaceV2` |

## 数据目录

```
data/tasks/<taskId>/
  task.json             冻结记录（templateId/templateVersion/frozenInput）
  snapshot/             冻结模板快照（template.yaml + agents/ + prompts/ + pipeline.yaml，versionHash 复核）
  events/               追加式事件 JSON（<6位序列>-<uuid>.json）
  artifacts/vNNN/       版本目录（content.md|txt / revision.md / review.md / meta.json）
  traces/<turnId>.json  展示用回合过程（phase + 公开文本 + tool 步骤）
  workspaces/<agentId>/ Agent 私有草稿
  structured-slots/     结构槽子树（blobs / generations / content-revisions / proposals / drafts / attempts / custody）
```

## 测试门禁

| 门禁 | 命令 | 覆盖 |
|---|---|---|
| 类型检查 | `npm run check` | tsc --noEmit |
| 单元/集成 | `npm test` | Vitest（当前基线 110 文件，2016 passed，1 skipped） |
| e2e | `npm run e2e` | Playwright（桌面/移动双视口与恢复流程） |
| 构建 | `npm run build` | vite + tsc server |
| 后端验证 | `npm run verify:backend` | gateway-contracts + server-modules + http-persistence |
| 运行时验证 | `npm run verify:runtime` | runtime-modules + e2e-runtime-loop + recovery + pi-boundary（真实 probe） |
| 真实验收 | `npm run acceptance:real` | 真实 Provider 端到端（直接使用提交的 `templates/`） |
| 结构化离线验收 | `npm run verify:structured-slots` | 结构槽 acceptance/qualify/promote；支持 `--capability injected|production`，生产模式使用 checked-in capability 链 |
| 结构化集成基准 | `npm run benchmark:structured-slots` | `--mode primitive-smoke` 做快速探针；`--mode integrated-qualify --profile ... --evidence ... --adapter ...` 运行四档集成基准并冻结 final profile |

**测试纪律**：跨层语义测试（`task-runner.test.ts` 的 v7 input assembly / v7 forward path）直接断言下一个 Agent 实际收到的 `AgentTurnInput.inputText`，而不只验证事件字段。结构槽测试还必须覆盖越权 selector、Draft 隔离、Seal 返工、batch 崩溃恢复、content-addressed custody、资源上限和 evidence fail-closed。

## 结构槽关键目录

```text
src/server/structured-slots/
  canonical-json.ts       JCS canonical JSON 与摘要
  slot-schema.ts          槽类型/内容契约
  layout-grammar.ts       树布局与顺序语法
  platform-profile*.json  冻结资源 profile
  runtime-capability*.json production capability manifest

src/server/runtime/structured-slot/
  attempt-coordinator / attempt-meter
  grant-service / proposal-service / draft-service
  projection-service / seal-service / structured-committer
  validation-engine / evaluator-runner / tool-factory

src/server/storage/
  event-store.ts                 append/appendBatch 与重放
  structured-slot-blob-store.ts  content-addressed 内容
  structured-slot-private-store.ts Proposal/Draft/Grant 私有 journal
  structured-slot-state.ts       generation/attempt/custody 状态

templates/zhihu-salt-chapter-draft/
  template.yaml / pipeline.yaml / slots/contract.yaml
  agents/ / prompts/ / skills/chapter-drafting/
```

## 当前 production enable 链

```text
clean source checkpoint
  -> benchmark integrated-qualify（四档 scale）
  -> profile evidence + final platform profile
  -> verify:structured-slots --qualify
  -> verify:structured-slots --promote-capability
  -> acceptance-only --capability production
```

四个 qualification 生成物是派生证据，不是手工配置：

- `docs/evidence/structured-slot-platform-profile-v1.json`
- `docs/evidence/structured-slot-release-v1.json`
- `src/server/structured-slots/platform-profile-v1.json`
- `src/server/structured-slots/runtime-capability-v1.json`

任何 tracked source、template、Skill、文档或 lockfile 变化后，旧证据只能视为历史快照，必须重新生成才能再次声称 production-ready。
