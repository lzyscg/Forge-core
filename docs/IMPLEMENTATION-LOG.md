# Forge Core 产物版本目录制 — 实施日志

> 整晚自主开发日志。按 dev-plan 8 Phase 推进,每 Phase TDD + 全绿 + 本地 commit。
> 设计基准：v7 定稿（`docs/2026-08-06-artifact-version-directory.md`）。

## 总体策略与关键决策

- **起步状态**：`main` 上模板被脏改为真实模型名（违反 `configured/*` 占位符协议），已 `git checkout templates/` 恢复为提交的占位符状态。提交模板必须保持 `configured/*`，真实验收才在工作副本替换标量（参考 `scripts/real-acceptance.ts`）。
- **Phase 0 连锁处理**：v2 契约把 `artifactVersion→inputVersion`、`ArtifactVersion.content→files[]`。这些字段被 ~30 个文件、84 处引用消费。为满足「每 Phase 全绿才 commit」，Phase 0 做一次全局机械 rename + 过渡行为修正，所有 consumer 与其测试同步更新；行为保持过渡态（单 content 文件、inputVersion 传播尚未接通），真正多文件/事件权威版本号在 Phase 1，传播在 Phase 4。
- **legacy 兼容**：v1 在途任务 gate 为 `incompatible(SCHEMA_V2_REQUIRED)` 只读；event-store 读取期 transform 归一旧事件（artifactVersion→inputVersion、contentHash→files、缺省 humanAuthorized=false、缺省 source=agent_request）使其不 CORRUPTED。
- **真实验收**：`scripts/real-acceptance.ts` 硬编码 zhihu-single-chapter（Phase 3 删除）。Phase 7 将写 dedicated long-form-hub 验收脚本（3 agent：controller/writer/reviewer 占位符替换）。

## Phase 7 — 迁移 + 集成验证（v2-only 门禁、运行时 fixture 迁移、e2e 重写、全量门禁）

（已完成；tsc 0 错误，1136/1136 单测绿，44/44 e2e 绿（10 条桌面专属截图证据跳过），build/verify:backend/verify:runtime/verify:ui 全过；commit 于 Phase 7 尾）

### 做了什么
- **v2-only 不兼容门禁**（spec §9）：`isTurnContractSupported` 收紧为**仅接受 version 2** 契约；调度器 `markIncompatibleOnce` 按快照形态选 reason——**v1 契约快照 → `SCHEMA_V2_REQUIRED`**（`incompatibleReasonFor`：快照含任一契约即判 v1 迁移，无契约判 `TURN_CONTRACT_REQUIRED`）；projector 已有 SCHEMA_V2_REQUIRED 诊断文案。新增测试：手工构造 v1 契约快照（重写 snapshot agent yaml + 重新哈希 task.json.templateVersion），recovery 后 `task_incompatible.reason === 'SCHEMA_V2_REQUIRED'`、诊断含「旧版产物契约」。
- **运行时 fixture 全量迁移 v1→v2**（执行中任务必为 v2 契约）：
  - `src/server/test-support.ts`：`FIXTURE_WRITER/REVIEWER_CONTRACT_YAML`（valid fixture 的 executable 副本注入）改 v2——writer 生产（content.md/workspace_file→publish），reviewer 操作（annotate review.md→send_message/submit）；提交的 `__fixtures__/valid` 目录保持无契约（门禁的历史快照源）。
  - `src/server/runtime/test-support.ts`：`publisherContract`/`reviewerContract` 与注入 YAML 改 v2（生产/操作分离，去掉 completionAction/cardinality/productionPackageRef/current_input_artifact）。
  - `e2e/runtime-harness.ts`：两 Agent fixture 改 v2 契约 + artifactSchema（content.md/review.md）+ reviewer→alpha message 边 route.inject（上一版正文）；`finish_production` 改 `files[]` 形状（inline 带 content、workspace_file 带 workspaceFile）；脚本重写为 v2 语义——alpha 生产（publish），beta 操作（annotate+send_message / annotate+submit），submit 不再走封存包而是提交输入版本（零复制）；submitters 收敛为 [agent-beta]；`readTaskFileProjection` 改读事件 `files[].hash`（meta 无哈希）。
- **e2e 重写与断言更新**：
  - runtime-loop 全 10 条（desktop+mobile）随 v2 脚本转绿：全链路 V1/V2、瞬时重试、手动重试、人工输入、非法路由隔离。
  - process-recovery：v2 下恢复回合为「annotate + submit 输入版本」→ 版本链收敛为 [1]（不再发布 V2），事件/最终提交断言同步。
  - process-trace：`workspace.artifacts[].files[0].content` 取代已删的 `.content`；工作区草稿→publish→beta submit 流程。
  - http-persistence：`seedConfirmedWorkspaceWithTwoArtifacts` 的 `publishTestArtifact` 改 `files[]` 形状、节点 `artifactVersion`→`inputVersion`。
- **全量门禁**：`npm run check`（tsc 0 错误）+ `npm test`（1136/1136）+ `npm run e2e`（44/44）+ `npm run build` + `verify:runtime`（runtime-modules 398 + e2e-runtime-loop 10 + e2e-process-recovery 2 + pi-boundary，13/13 能力）+ `verify:backend`（gateway-contracts 170 + server-modules 659 + typecheck + build + e2e-http-persistence 4，9/9 能力）+ `verify:ui`（process-trace 8）。

### 关键决策
- **门禁 reason 按「是否有契约」判别**：v1 契约（有 version 字段但非 2）→ SCHEMA_V2_REQUIRED；完全无契约（预契约时代快照）→ TURN_CONTRACT_REQUIRED。`downgradeTaskSnapshotToLegacy` 测试（去契约）继续命中 TURN_CONTRACT_REQUIRED，语义不漂移。
- **e2e fixture 的 v2 形状对齐**：alpha=生产回合（publish 扇出 artifact 边），beta=操作回合（annotate + dispatch）；submit 经输入节点 inputVersion 直解（spec §15「submit 从 inputVersion 直解产物」），零复制交付。
- **process-recovery 收敛为单版本**：v2 下 beta 恢复回合只 annotate+submit 接收的 V1，不再二次发布——事件流断言从「2 次 artifact_published」改为 1 次，更贴近 v7「操作不 bump」语义。
- **zhihu-single-chapter 保留（Phase 3 日志既定偏差延续）**：dev-plan Phase 7 清单未列删 zhihu；client mock 演示与 real-acceptance 脚本硬编码 zhihu（升级为 v2 后仍可跑）。删除留作后续独立任务（连带 mock fixture 迁移与 real-acceptance 重写为 long-form-hub）。

### 问题与解决
- **v2-only 门禁连锁红**：valid fixture executable 副本的 v1 契约被门禁拒绝，api.integration（422 而非 202/409）与调度器测试全红——根源是 fixture 注入块未迁移，改 v2 后恢复。
- **e2e 全红根因**：v7 动作 schema 拒绝 `finish_production` 的 `content` 键（v1 形状）与 `productionPackageRef`；逐个脚本迁移为 `files[]` + 操作回合语义后转绿。
- **`frozen` 变量作用域**：recoverInterruptedTasks 内 try 块声明的 `frozen` 在门外引用——提升为 `frozenSnapshot` 变量。
- **v1 快照测试的哈希一致性**：手改 snapshot agent yaml 后须重算模板哈希写回 task.json，否则 TaskStore 判「快照版本与记录不一致」CORRUPTED（沿用 `downgradeTaskSnapshotToLegacy` 的 re-hash 模式）。

### 已知局限与后续跟进
- **崩溃半态自愈**（spec §11.6）未实现：resume 检测「human_answered+superseded 已提交、合成缺失」补合成留作后续（提交序已把半态压向安全方向）。
- **zhihu-single-chapter 删除**：未做（见关键决策），后续需连带 mock fixture 迁移 + real-acceptance 重写为 long-form-hub（3 Agent 占位符替换）。
- **route.inject 带版本输入触发**：Phase 4 日志记录的已知偏差（inject 只在 inputVersion===null 分支触发）仍在——forward/send 带版本走 hand-off 交付，正确 inject 供料列后续。

## Phase 6 — 投影与 UI（产物链 extract 槽位、verdict 展示、superseded 渲染、accept 决策 UI）

（已完成；tsc 0 错误，1135/1135 测试绿；commit 于 Phase 6 尾）

### 做了什么
- **投影（Phase 5 已铺垫，本 Phase 收口）**：`pending_inputs_superseded` 在真实/模拟投影中折叠为节点 `superseded: true`（spec §11.2 作废态，不悬空）；`pendingHumanSource` 契约 + wire schema + 双投影暴露（Phase 5）。
- **产物链 extract 槽位**（spec §5.1/§10）：`artifact-drawer.tsx` 重写为**每版本多槽渲染**——按 `files[].extract` 分槽（content→正文 / revision→修订说明 / review→审核意见），槽标题含文件名；旧任务单 content 文件自然降级为一个正文槽。
- **verdict 展示**（spec §3.2/§10，展示层行为）：抽屉内解析 review.md frontmatter（`---\nverdict: pass|reject`）渲染「审核结论：通过/打回」徽标；**平台不据此门禁**（verdict 语义只由 controller 模型消费，注释明示）。
- **accept 决策 UI**（spec §11.1/§11.5）：`TaskControls` 在 `waiting_human + pendingHumanSource=progress_guard` 时渲染**结构化三选一**（继续推进 / 人工接受 / 停止任务）+ 指引文本域；`agent_request` 保持普通回答表单。**accept 按 `task.latestVersion >= 1` 前置禁用**（零版本不呈交，spec §11.5；服务端复校验为兜底）。
- **Gateway 结构化决策通道**：`ForgeCoreGateway.submitHumanDecision(taskId, HumanDecision)` 新方法；http-gateway 归一为 `{decision, text?}` 调 answer 端点；mock-gateway 仅接受 continue（模拟只产生 agent_request 停车，accept/stop 拒绝——显式平台语义）；共享契约套件对 mock/http 双实现断言三形状拒绝 + 未知任务 TASK_NOT_FOUND。
- **superseded 画布渲染**：`workspace-canvas` NodeButton 加 `fc-node--superseded` 类（虚线、淡化、删除线）；turn-card 对分组输入显示「已作废」徽标。
- CSS：新增 `fc-artifact-slot`/`fc-verdict`/`fc-answer-form__decisions`/`fc-node--superseded`/`fc-turn__superseded` 样式。

### 关键决策
- **verdict 解析放展示层组件内**（artifact-drawer 局部纯函数 `parseReviewVerdict`）：不侵入服务端投影，不违反铁律 1（平台不解析业务语义；frontmatter 结构校验在工具层/committer，展示层只读渲染）。
- **`HumanDecision` 契约放 shared/contracts**：客户端四实现（http/mock/stub/contract 套件）共用同一形状，与 scheduler 的 `HumanAnswerRequest` 一一对应（answer/continue/accept/stop）。
- **mock 只接受 continue**：模拟器不产生 progress_guard 停车（source 恒 agent_request），accept/stop 在 mock 层以 INVALID_TRANSITION 显式拒绝，防 UI 演示中「点了没反应」；真实后端三形状全支持。
- **superseded 输入在画布上几乎总在 turn-card 内**（pending 输入无 result 成 trailing 组）——测试按 turn shell 徽标断言，standalone button 的 `fc-node--superseded` 类保留为防御路径。

### 问题与解决
- **artifact-drawer 测试同用例双 render 残留 DOM**：首个渲染的旧抽屉节点仍查询得到，导致 `queryByText` 断言误判；拆为两个独立用例。
- **指引文本域无 label**：结构化表单初版用 `<p>` 作标签，`getByLabelText` 找不到；改 `<label htmlFor>`。
- **superseded 输入在画布的落点**：初版测试期望 reviewer 输入作 standalone button，实际被分组成 turn；改为断言 turn shell 徽标 + 追加 trailing 输入用例。

## Phase 5 — 调度器人工介入（supersede + synthesize，结构化三选一）

（已完成；tsc 0 错误，1123/1123 测试绿；commit 于 Phase 5 尾）

### 做了什么
- `task-scheduler.ts`：
  - **progress-guard 停车对象改接收者**（spec §11.4）：`appendProgressGuardRequest` 挂**停车时刻最老 pending 输入的接收者**（`stalestPendingInput`，按序列序取第一个无 committed result 的未作废输入），不再挂最后 dispatch 者；无 pending 时退回最后 dispatch 者兜底。请求事件带 `source: 'progress_guard'`（spec §11.5）。
  - **结构化三选一**（spec §11.1）：`HumanAnswerRequest`（answer/continue/accept/stop）+ `answer(taskId, string | HumanAnswerRequest)` 入口；`applyHumanAnswer` 按 pending 请求来源分发——`progress_guard` 走 continue/accept/stop 三分支（普通字符串映射为 continue，文本即引导），`agent_request` 只接受文字回答（结构化决策拒绝）。
  - **continue**：提交序 `human_answered → pending_inputs_superseded（作废全部当前 pending）→ synthesize`（spec §11.6）；合成节点给**最老被作废 pending 的接收者**（spec §11.3），body=引导文本，inputVersion=该 pending 的 inputVersion；无 pending（理论不可达）退化为 guard 请求节点 agent + inputVersion=null（spec §11.6 兜底）。
  - **accept**：**服务端复校验**至少一个已发布版本（`latestPublishedVersion === null` 即拒绝 INVALID_TRANSITION，spec §11.5）；合成节点给 finalOutput.submitters[0]，inputVersion=最新已发布版本，**humanAuthorized=true**（spec §7.1 唯一写入主体）；不重标注 review.md。
  - **stop**：`human_answered + task_stopped` 后 **abort run controller**，`execute` 循环立即退出（与既有 stop 生命周期一致），不跑 stop 后残留的 pending 输入（此前会误跑并 completed——测试钉死）。
  - **合成节点确定性 id**：`synthesize-<suffix>-<round>`（round=已提交 supersede 事件数），多轮干预不撞 id、崩溃重放可幂等（spec §11.6）；序列号固定 `nextSequence(events)+1`（human_answered 已占前一位，含无 pending 兜底分支）。
  - guard 停车对象与 continue 合成目标一致（同取 stalestPendingInput），人工引导直达被卡接收者。
- `action-committer.ts`：
  - **可达性闭包 supersede 桥**（spec §7.3/§11.1）：`assertReachable` 走路由时把 `route_executed.toNodeId` 经 `buildSupersedeResolution`（superseded 输入 id → 同接收者合成输入 id，按提交序累积映射）解析后再比对/跳转——continue 合成的输入能沿「producer → 路由(指向被作废旧输入) → 合成输入 → 消费结果 → …」走到提交者，否则在作废节点死路（**修掉 Phase 5 WIP 的 FINAL_NOT_REACHABLE 回归**，测试 2/3 由红转绿）。
  - **humanAuthorized 封闭性收口**（spec §7.1）：`node()` 构造器**移除 humanAuthorized 参数**（永不置位），forward 路径不再传播 `received.humanAuthorized`；仅 scheduler accept 合成路径经 events.append 直接写该字段。
- `task-runner.ts`（WIP 继承）：`findNextUnprocessedInput` / `collectPendingAgents` 跳过 `pending_inputs_superseded` 作废的输入（spec §11.2）。
- 投影（spec §11.2 作废态）：`task-projector.ts` + `mock-projector.ts` 折叠 `pending_inputs_superseded`，节点渲染 `superseded: true`（显示层，不作废态悬空）；mock-schema 增事件类型与可选字段。
- API 面（spec §11.5）：`api-schemas.ts` 的 `answerBodySchema` 改为**联合**（`{answer}` 旧形状 | `{decision: continue|accept|stop, text?}`）；`task-routes.ts` 归一化到 `HumanAnswerRequest`；`core-service.answerHuman` 放宽入参；workspace 契约 + wire schema + 双投影暴露 **`pendingHumanSource`**（progress_guard | agent_request | null），UI 据此区分是否提供 accept。

### 关键决策
- **普通字符串 answer 对 progress_guard 映射为 continue**：旧 answer 流（`answer(taskId, text)`）对 guard 停车继续可用，文本即合成引导 body；结构化 continue/accept/stop 是新通道，两者同路。
- **stop 用 abort 而非事件驱动停环**：`execute` 循环只认 `signal.aborted` 与 runNext 结果，task_stopped 事件本身不拦环；answer-stop 在 `prepare` 内 append 事件后 abort controller，与既有 `stop` 生命周期（abort + task_stopped）一致，`accepted`/`completion` 均回 stopped。
- **可达性桥只解析 route.toNodeId**：producer/中间结果（result 节点）永不作废，只有输入节点会被 supersede；解析映射按「合成输入同接收者 + 提交序先 supersede 后 synthesize」构建，多轮干预下先映射的优先、不覆盖。
- **`pendingHumanSource` 为必填契约字段**（与 pendingHumanQuestion 对齐），3 处测试 fixture + 双投影同步补 `null`；mock 的 human_requested 无 source 字段，恒为 agent_request（mock 不模拟 guard 停车）。

### 问题与解决
- **Phase 5 WIP 三个红测试**（`npm test` 基线）：
  1. 停车对象测试期望 reviewer（最后 dispatch 者）实得 writer——**spec §11.4 明确改接收者**，更新测试期望为 writer 并补 `source: 'progress_guard'` 断言。
  2/3. `answer('复审并提交')` 后任务 `retryable_failure` 而非 completed——continue 作废 pending 输入后合成新输入，但 producer 的 `route_executed` 仍指向**被作废旧输入**，`assertReachable` 找不到消费结果死路。**根因在可达性闭包缺 supersede 桥**，committer 层修复（见上），测试无需改语义即转绿。
- **stop 分支误跑残留 pending**：applyStop 只 append 事件，`execute` 循环无视 task_stopped 继续跑 reviewer 的 pending 输入至 completed（首版 stop 测试失败）。abort controller 修复。
- **合成节点序列号碰撞**：WIP 用 `offset = pending 数 >0 ? 1 : 0`，无 pending 兜底分支下合成节点与 human_answered 同序列号；改为固定 `+1`（human_answered 恒占前一位）。
- **humanAuthorized 封闭性缺口**：committer `node()` 支持置位且 forward 传播 received.humanAuthorized——违反「唯一写入主体」；收口后以「forward 收到 humanAuthorized 输入不落字段」测试钉死。
- **已知局限（后续跟进）**：崩溃半态自愈（resume 检测「human_answered+superseded 已提交、合成缺失」补合成，spec §11.6）未实现——提交序已把半态压向安全方向，极端窗口下任务 park 可见、人工可 stop/clone；多 pending 拓扑的 continue 合成目标为最老接收者（spec §16 明示边界）。

## Phase 4 — 运行时（runner + committer）

（已完成；tsc 0 错误，1113/1113 测试绿，含新增 14 条 committer/runner v7 测试）

### 做了什么
- `task-runner.ts`（继承前序会话 WIP 并补全）：
  - **route.inject 执行期解析**（spec §5.2）：输入节点无 inputVersion 时，沿交付路由 `route_executed` 找到发送方 result，经 `agent_result.inputNodeId` 回溯发送方输入节点的 inputVersion，读取声明 inject 文件追加到 inputText。抽出 `resolveSenderInputVersion` 纯函数。
  - **forward 终态 id**（spec §8.2）：`turnPlanCompleted` 补 `${turnId}-forward-input-0`，使 forward 回合的完成检测与 publish/send/submit/human 对齐；修复「forward 回合完成后若残留 stale `commit-failed` 标记会无限重入」的边界 bug。导出 `turnPlanCompleted` 供单测。
  - 清理 WIP 的重复注释与缩进。
- `action-committer.ts`：
  - **annotate 文件归属校验**（spec §5.3）：`assertAnnotateAllowed` 增 `contract.annotate.files` 包含校验，不合法即 `ANNOTATE_FILE_NOT_ALLOWED`（零写）。补齐工具层遗漏的 file 归属门禁。
  - **annotate 唯一性 + 自排除**（spec §8）：`assertAnnotateAllowed` 改 async，提交前扫已提交 `artifact_annotated`，`(version,file)` 已被**不同 turn** 标注即 `ANNOTATE_DUPLICATE`（零写）；本 turn 的标注（同 turnId）自排除，重放幂等。
  - 可达性闭包（spec §7.3）、inputVersion 传播（spec §2）、dispatchKind 驱动（spec §8.2）已在 Phase 2 / 前序 WIP 落地，Phase 4 补齐 forward 经 artifact 边到 controller 的可达性测试与五种 dispatchKind 的事件级断言。
- 测试：
  - `action-committer.test.ts` +10 例：forward 转发、forward 经 artifact 边可达性闭包、annotate 原子追加、annotate 跨 turn 重复拒绝、annotate 自排除重放、annotate 文件归属拒绝、send_message inputVersion 传播（v1/null）、dispatchKind 五形 `agent_result` 断言、publish 重放不重复。
  - `task-runner.test.ts` +5 例：long-form-hub 端到端 writer publish -> reviewer forward -> controller submit；forward 完成后 stale 标记不重入；`turnPlanCompleted` forward/publish/send/submit/human 终态 id 单测。
  - 新增 `hubRunnerHarness` 安装真实 long-form-hub 模板跑 runner 端到端。

### 关键决策
- **annotate 唯一性移到校验期**：原 store 层在 staging 期拒绝（不同 turn 重复会落到 `COMMIT_INTERRUPTED`，残留 agent_result）。Phase 4 把 `(version,file)` 跨 turn 重复提到 `validateActionSet`（零写，`ANNOTATE_DUPLICATE`）；store 层保留为兜底。
- **forward 终态 id 是真 bug**：`turnPlanCompleted` 漏 forward 导致「forward 回合完成后若 `afterCommitted` 读取等后置步骤抛错留下 stale `commit-failed` 标记」时无限重入。用 stale-marker 集成测试钉死。
- **route.inject WIP 保留**（见问题与解决）。

### 问题与解决
- **route.inject 语义与 spec §5.2 存在偏差（已知局限，保留 WIP）**：前序会话的 task-runner inject WIP 仅在 `inputVersion === null` 分支触发，并回溯**发送方** inputVersion 读取 inject 文件。但 spec §5.2「version: input = 本回合输入节点 inputVersion」与设计 §7「forward 产生的输入是 operate 输入，runner 按 inject 供料、不触发产物全文 hand-off 分支」要求 inject 锚定**输入节点自身**的 inputVersion，并对带版本的 forward/send_message 输入触发（而非全文 hand-off）。当前 committer 的 send_message/forward 会把 inputVersion 传播给接收方，故接收方 inputVersion != null 走 hand-off 分支，inject 实际不触发。按任务指示「PRESERVE this work; do not revert it; commit it as part of Phase 4」，保留 WIP 原样提交；正确的 inject（带版本输入按声明文件供料、publish 走 hand-off）列为后续跟进。当前 forward 快乐路径经 hand-off 交付正文，可达性闭包与提交均正常。
- **annotate 文件归属门禁补在 committer**：spec §4/§5.3 要求 annotate file 须 `phase:annotate 且 producer==本 agent`，dev-plan Phase 2 列在工具层（pi-tool-factory），但工具层只做 shape 校验未做 file 归属。Phase 4 在 committer `assertAnnotateAllowed` 补 `contract.annotate.files` 校验（spec 允许「工具层/committer」双口），关闭模型绕过工具层直提任意文件标注的缺口。

## Phase 3 — 模板契约

（已完成；tsc 0 错误，1099/1099 测试绿；commit dfc661c）

### 做了什么
- `template-validator.ts` 重写为 v2 校验器：artifactSchema（files 的 name/required/producer/extract/phase）、route.inject（产物边必声明至少一个 required 文件 inject）、v2 turnContract 形状（production/annotate/dispatch-only 回合推导；production+annotate 混合拒绝；v1 output 嵌套兼容）；纯操作/协调 Agent 交叉校验（annotate.files ⊆ schema(phase:annotate && producer==本 agent)；forward.targets ⊆ 产物边对端；submit ∈ finalOutput.submitters）。
- `template-schema.ts`：ArtifactSchema/ArtifactSchemaFile/route.inject 类型落 FrozenTemplate。
- `template-loader.ts`：缓存键/哈希含 artifactSchema，保证 v2 模板哈希稳定。
- `templates/long-form-hub` 重写为 v2：controller dispatch-only（send_message/submit）、writer production（content.md/revision.md + publish）、reviewer operate（annotate review.md + forward/send_message）；reviewer->controller 改 artifact 边（零复制 forward）；artifactSchema 含 content/revision/review；route.inject（writer->reviewer、reviewer->writer、reviewer->controller）；模板级 budget 16；prompts 更新为 v7 工具（annotate_artifact/forward_input_version/submit_final_artifact/send_message summary）。
- `templates/zhihu-single-chapter` 升级 v2 契约（production/annotate）+ v7 prompts（**保留未删**，见关键决策）。
- 模板验收测试更新为 v2 断言（long-form-hub 三 Agent 拓扑、controller dispatch-only、reviewer operate、reviewer->controller artifact 边、artifactSchema 三文件）。

### 关键决策
- **zhihu-single-chapter 升级而非删除**：spec §9 / dev-plan Phase 3 原列「删 zhihu」，但 `scripts/real-acceptance.ts` 硬编码 zhihu-single-chapter（Phase 0 日志记「Phase 3 删除」）。为不破坏真实验收脚本，Phase 3 选择把 zhihu 升级为 v2 契约（保留可跑），real-acceptance 的 long-form-hub 专用脚本留 Phase 7。zhihu 删除顺延至 Phase 7（与 real-acceptance 脚本重写一并）。
- **v1 output 嵌套兼容**：v2 把 production.output.formats/sources 扁平化，但 v1 fixture 与历史快照用嵌套 output。validator 兼容两种形态，避免历史快照校验失败。
- **production.sources 恢复**：finish 的 source ⊆ production.sources（workspace_file/inline）；current_input_artifact 不再是 finish 的 source（它是 submit 的输入解析机制）。

### 问题与解决
- 模板拓扑重写（reviewer->controller 改 artifact 边）改变了版本传播与 forward 语义，靠 long-form-hub 验收测试钉死三 Agent 拓扑与 artifact 边声明。

## Phase 2 — 动作与工具

（已完成；tsc 0 错误，35 server test files / 635 tests 绿）

### 做了什么
- `forge-actions.ts` 重写为 v7 **9 动作注册表**：`load_skill`、多文件 `finish_production`、`annotate_artifact`、`read_artifact_version`、`publish_artifact`、`forward_input_version`、`submit_final_artifact`、`send_message(summary)`、`request_human_input`。
- 删除 dispatch 的 `productionPackageRef` 与 finish 的 `current_input_artifact`；模型不再传版本/工程元数据。
- `action-buffer.ts` 支持 production / operate / coordinate 三种形态；operate/coordinate 可直接 dispatch；`request_human_input` 按 v7 F7 可在生产/标注后中断，但 dispatch 后拒绝；publish 必须先 finish。
- `pi-tool-factory.ts` 暴露 9 个工具；新增 artifact file reader；工具描述包含 v7 阶段/参数约束；读工具不进入 action buffer。
- `action-committer.ts` 重写 v7 提交序：agent_result(inputNodeId+dispatchKind) → skills → annotate → publish/files/routes → forward/send → submit/human；新增 route/forward/annotate/reachability 校验与 humanAuthorized 放宽。
- `task-runner.ts` 处理多文件 workspace_file、inputVersion handoff、v7 checklist；`TurnPhaseDispatchAction` 加 forward。
- `template-schema.ts` 扩展 TurnContract v2 类型（Phase 3 将实施严格 validator）。
- 全部 server 测试 fixtures 迁移到新动作形状；新增测试 helper `publishFixtureArtifact` / `seedAgentInputVersion`。

### 关键决策
- 当前保留 v1 fixture contract 的宽松 TypeScript 兼容，严格 v2 形状及 production/annotate/dispatch-only 推导留 Phase 3 validator。
- `send_message.summary` 作为消息正文；inputVersion 仅沿事件节点传播，不由模型携带。
- `read_artifact_version` 是纯读工具，不进入 ActionBuffer，不产生 committed action。

### 问题与解决
- v7 action shape 影响 server 35 个测试文件；通过集中迁移 fixture builders，再逐一修正 submit-from-inputVersion、workspace_file files[]、humanAuthorized 输入。


## Phase 1 - 存储层

（已完成；tsc 0 错误，1093/1093 测试绿，含新增 14 条 artifact-store v7 测试）

### 做了什么
- `src/server/storage/artifact-store.ts` 全面重写为 v7 事件权威版本目录存储：
  - **注入 EventStore**（构造 `new ArtifactStore(paths, events)`），无循环依赖。
  - **版本号=已提交 artifact_published 事件数+1**（不再 max-dir+1）。
  - **多文件**：`ArtifactProposal.files:[{name,content}]`；版本目录含 content.md/revision.md/review.md + meta.json。
  - **meta 无文件哈希**（spec §3.1）：`ArtifactMeta={id,version,title,sourceNodeId,format,createdAt}`；哈希在事件。
  - **annotate**：`annotate(taskId, {version,file,content,turnId,nodeId})` 原子 staging→rename 追加文件；唯一性扫 artifact_annotated 事件，**重放自排除**（同 nodeId 幂等），不同 turn 拒绝。
  - **盘↔事件交叉校验**：read/list 校验生产文件 hash 对 artifact_published.files[].hash、标注文件对 artifact_annotated.contentHash；不一致 TASK_CORRUPTED。
  - **读窗口容忍**「事件在、目录无」：claimStagedVersion 扫 `.tmp-vNNN-*`，artifactId 优先/contentHash 退回，rename 落位。
  - **孤儿 final 目录**（dir 在、事件无）：list 不列出，下次 publish 同版本按 hash 认领或冲突判 CORRUPTED。
  - `readFile(taskId,version,file)` 供 read_artifact_version 工具。
  - 新类型 `PublishedArtifact`/`AnnotatedFile`/`ArtifactEntry{meta,files}`/`AnnotateProposal`。
- 消费方更新：`core-service` 构造注入 events；`publishTestArtifact` 改 files + **先写事件再 read**（cross-check 要求事件在场）；`action-committer.publishSealedPackage` 传 files + 事件 files 用 store 结果；`task-runner` handOff 从 `files.find(content.md/txt)` 取正文；`task-projector` 映射多文件 + `extractForFile`（review/revision/content）；api-schemas 不变（已 v7）。
- `scripts/real-recovery-acceptance.ts`：reconcile 改为对比 disk 内容 hash 与**事件** hash（meta 不再带 contentHash）。
- 新增 `artifact-store.test.ts` 14 例（重写）：publish 版本计数/meta 无哈希/多文件/校验、annotate 唯一性+自排除+幂等、cross-check fail-loud、staging 认领、孤儿 final 认领、re-publish 冲突。

### 关键决策
- **publishTestArtifact 顺序**：必须 publish→append 事件→read（cross-check 需事件在场），原顺序 publish→read→append 会触发 "无发布事件" CORRUPTED。
- **committer publish 不受 cross-check 影响**：committer 的首次 publish 不调 read（只 replay 分支调，此时事件已存在），故无顺序问题。
- **孤儿目录策略**：list 只列事件背书的版本；孤儿 final 由下次 publish 同版本按 hash 认领（内容一致复用 id，不一致 CORRUPTED）。这是对「事件流是唯一权威」的忠实落地。

### 问题与解决
- recovery 集成测试在并行满载下偶发 timing race（empty-action 中性 turn 的 attempt failure vs fetch 竞态）；隔离运行稳定通过，非真实回归。
- real-recovery reconcile 误用 meta.contentHash（已不存在）→ 改读事件 files[0].hash 为权威。
- perl `s/...$//` 误截断测试文件 → 重写恢复。

## Phase 0 — 事件契约与数据模型

（已完成；tsc 0 错误，1086/1086 测试绿，含新增 26 条 task-events 测试）

### 做了什么
- `src/server/storage/task-events.ts` 重写为 v7 联合：
  - 新成员 `artifact_annotated {version,file,contentHash,turnId,nodeId}`、`pending_inputs_superseded {supersededNodeIds[]}`。
  - `artifact_published.artifact`：`contentHash` → `files:[{name,hash}]` + `artifactType` + `artifactId`（均 `string|null`，legacy transform 归一为 null）。
  - `agent_result` 增可选 `inputNodeId`/`dispatchKind`（publish/forward/send/submit/human），条件包含以保 round-trip 字节一致。
  - `EventNode.artifactVersion` → `inputVersion`；新增可选 `humanAuthorized`。
  - `task_incompatible.reason` 增 `SCHEMA_V2_REQUIRED`。
  - `human_requested` 增可选 `source`（progress_guard|agent_request）。
  - 导出 `normalizeLegacyEvent`：读取期归一 v1 事件（artifactVersion→inputVersion、contentHash→files[按 format 选 content.md/txt]、artifactType/artifactId→null），不动 v7 事件。
- `src/server/storage/event-store.ts`：`readCommittedFile` 在 `validateTaskEvent` 前跑 `normalizeLegacyEvent`。
- `src/shared/contracts.ts`：`WorkspaceNode.artifactVersion`→`inputVersion` + `humanAuthorized?`；`ArtifactVersion.content`→`files: ArtifactFile[]`（新 `ArtifactFile{name,extract,content}`）。
- `src/shared/api-schemas.ts`：wire schema `artifactVersionSchema` 改 `files[]`（sed 误改的名 `inputVersionSchema` 已正名为 `artifactVersionSchema`）；`workspaceNodeSchema.inputVersion`。
- 全局机械 rename `artifactVersion`→`inputVersion`（src/ + scripts/，排除 task-events.ts 的 legacy 引用）。
- 消费方过渡适配（单文件 `content` extract 槽）：`artifact-store.publish` 返回 `files`；`task-projector` 映射 `files` + `incompatibleDiagnosticFor(SCHEMA_V2_REQUIRED)`；`action-committer`/`core-service` 的 `artifact_published` 事件构造改 `files[]`；mock/projector/UI/acceptance 脚本同步（client 子代理批量修复）。
- 新增 `src/server/storage/task-events.test.ts`（26 例）：新成员 fail-closed、files[] 校验、agent_result 可选字段、inputVersion/humanAuthorized、incompatible reason、human source、legacy transform 各分支。

### 关键决策
- `agent_result.inputNodeId/dispatchKind` 设为**可选**（条件包含）而非必填：让 minimal 测试构建器与 legacy 事件 round-trip 字节不变（canonical 比较稳定），committer 在 Phase 4 始终写入。读取侧 `?? null`。
- `EventArtifact.artifactType/artifactId` 为 `string|null`：新事件 committer 必填，legacy transform 归一 null。
- 保留单文件过渡：每个 `ArtifactVersion` 一律一个 `{name:'content.md',extract:'content',content}` 槽；多文件渲染留 Phase 6，事件权威版本号/staging 认领留 Phase 1。

### 问题与解决
- client 子代理修复 `src/client/**` 的 content→files 与 http-gateway cast；剩余 shared schema 缺口（api-schemas 仍校验 content）由我补齐。
- sed 把 acceptance 报告键 `artifactVersions` 误改为 `inputVersions`（`artifactVersion` 子串匹配），已正名回 `artifactVersions`。
- `StorageError.message` 是中文、`.code` 在属性上——reject 断言用 `expectInvalid` 检 `.code` 而非正则。

