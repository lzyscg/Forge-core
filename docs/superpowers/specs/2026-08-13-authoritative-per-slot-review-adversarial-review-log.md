# 结构槽权威审核生命周期：对抗审查日志

> 开始时间：2026-08-13（Asia/Shanghai）
>
> 审查对象：`2026-08-13-authoritative-per-slot-review-lifecycle-design.md`
>
> 审查基线：`8ecb0a8`
>
> 最大轮次：5
>
> 约束：独立 reviewer 只读检查当前 ForgeCore 项目与设计，不修改文件；未获得 `VERDICT: APPROVED` 前不进入实施计划。

## 审查标准

- 设计必须与当前仓库的真实模板、contract、session、事件、snapshot、artifact 和 capability 结构相容，或明确给出版本化迁移边界。
- 重点攻击权威状态、并发与原子性、Map 预审、逐槽审核、返修授权、可选关系网、容量与恢复语义。
- 每个实质问题必须给出仓库证据、失败场景和设计级修正建议。
- reviewer 只有在找不到会阻断实现或造成错误行为的实质问题时，才能返回 `VERDICT: APPROVED`。

## Round 1 — Independent reviewer

`VERDICT: REVISE`

### 发现的问题

1. **P0 — 系统调度权没有可执行落点。** 当前调度器只消费由 Agent Route 产生的 `agent_input`；设计禁止 Agent 决定下一步，却没有持久化系统工作项，Structure 提交候选后可能直接停机。
   - 证据：`src/server/runtime/task-scheduler.ts:385-402,930-960`；`src/server/runtime/structured-slot/structured-committer.ts:359-395,443-480`；`src/server/template/structured-pipeline-validator.ts:141-185,226-305`。
2. **P0 — 移除 Seal Agent 后 artifact producer/custody 合同断裂。** 当前 required artifact producer 必须是模板 Agent，知乎模板的 producer 是 `seal`，Seal service/tool 也绑定 Seal Agent。
   - 证据：`src/server/template/template-validator.ts:240-263`；`templates/zhihu-salt-chapter-draft/pipeline.yaml:24-30`；`src/server/runtime/structured-slot/seal-service.ts:195-232`；`src/server/runtime/structured-slot/tool-factory.ts:247-287`。
3. **P0 — v1 防空转预算会截断 10k 审核。** 当前默认 8 turn、模板最多 32；10k 即使用 256 批次也至少需要 40 turn，默认 24 则需要 417 turn。
   - 证据：`src/server/runtime/progress-guard.ts:24-43,69-99`；`src/server/template/template-validator.ts:324-333`。
4. **P1 — 跨候选继承与 candidate-bound record 矛盾。** 旧记录绑定 C1 candidate digest，却被设计要求直接计入 C2 覆盖；严格校验无法继承，放松校验又允许错误重放。
5. **P1 — 10k ledger 与当前全量事件扫描不相容，qualification 未覆盖。** 当前 append/read 每次扫描历史；已有证据只覆盖 500 issues，不覆盖 10k review ledger 写入、恢复、重放和分页查询。
   - 证据：`src/server/storage/event-store.ts:315-425,446-454`；`src/server/structured-slots/structured-evidence-schema.ts:130-214`；`docs/evidence/structured-slot-platform-profile-v1.json:103-110`。

### 主设计者回应与修订

五项均接受，未驳回 reviewer 问题：

1. 新增系统所有的持久化 `WorkItem`/`AssignmentDispatch` 状态机、lease epoch/CAS、WorkItem 到 Agent input 的 v2 适配层，以及创建/认领/完成/恢复的原子边界。模板角色图只定义许可，不能选择运行分支。
2. 新增封闭平台 producer `system:structured_seal`，明确它不是 Agent/Route 端点；Assembler、SealRecord、artifact custody 和 Submitter WorkItem 由系统命令处理。知乎 v2 模板必须显式迁移 producer 并改变 snapshot hash。
3. 新增 v2 冻结计划预算、单调 progress checkpoint 和“连续无语义进展”门禁；合法的数百个不同 review WorkItems 不计为空转，v1 8/32-turn 语义保持不变。
4. 把可复用 `ReviewFact` 与当前轮 `ReviewAdoptionRecord` 分离；Gate 只接受当前 round adoption，整体观察永不继承。
5. 改为 assignment 级 ledger blob 与轻量事件引用，新增 append manifest、可重建 projection checkpoint、稳定游标分页；将 10k 全流程写入/崩溃恢复/genesis 与增量重放/API 延迟/RSS 加入 capability 硬门。

另补充初始候选无活动 Map 的返修基线、mixed Finding 分阶段验证与系统 Seal producer 的事件来源约束均继续保留。

## Round 2 — Independent reviewer

首轮 5 项被 reviewer 明确认定已在架构层闭合，但结论仍为 `VERDICT: REVISE`。

### 发现的问题

1. **P0 — WorkItem lease 无过期回收路径。** lease 与 agent input 非原子，且没有 expired/reclaimed 事件；lease 后、input 前崩溃会永久卡住。
   - 证据：`src/server/runtime/structured-slot/attempt-coordinator.ts:7,178,213`；`src/server/runtime/task-scheduler.ts:655,1473`。
2. **P0 — v2 初始 Structure WorkItem 无启动边界。** 当前 start 在 `task_started` 后直接向 `agents[0]` seed input；设计却要求 Structure 提交完成一个不存在的 WorkItem。
   - 证据：`src/server/runtime/task-scheduler.ts:790,1124`。
3. **P0 — system Seal artifact 无法进入现有 Submitter commit 权威链。** 当前 final commit 要求 current input artifact 且 producer 可沿 Agent route 回溯到 `agent_result`。
   - 证据：`src/server/runtime/action-committer.ts:494,809`；`src/server/runtime/task-runner.ts:1512`；`src/server/storage/task-events.ts:159`。
4. **P1 — inherited ReviewAdoption 无独立权威账本。** 系统继承项不属于 Agent assignment，无法合法塞进 AssignmentLedgerBlob；9,999 个继承项还会突破单 assignment 上限。
   - 证据：`src/server/storage/artifact-store.ts:15`；`src/server/storage/event-store.ts:315`。
5. **P1 — attempt-scoped journal 与跨 lease 免重复恢复承诺矛盾。** 当前私有对象严格绑定 turn，不能由新 attempt 无条件继承。
   - 证据：`src/server/storage/structured-slot-private-store.ts:482,557,716`。
6. **P1 — cursor 绑定不断变化的 checkpoint 会造成活跃任务分页饥饿。** 后台每次 assignment/lease 完成都会让下一页 stale。
   - 证据：`src/server/runtime/structured-slot/projection-service.ts:21,292,546`。

### 主设计者回应与修订

六项均接受：

1. lease、AssignmentDispatch、agent_input 和 attempt start 改为同一原子 envelope；新增服务端到期、CAS、`lease_reclaimed`、旧 attempt abandoned 和 epoch+1 规则。
2. v2 `task_started + initial structure WorkItem` 原子创建；禁止 v2 走 `agents[0]` 直接 seed，v1 保持旧行为。
3. 新增 SystemArtifactDelivery，显式绑定 SealRecord、artifact/custody digest、submitter WorkItem/Agent；v2 final validator 检查这条系统链，不走 v1 Agent route reachability，也不伪造 agent_result。
4. 新增系统生成、按 profile 分块的 ReviewAdoptionLedgerBlob 与 ReviewAdoptionRoot；0 继承使用 empty root，孤儿 blob 不可计入 Gate。
5. 明确选择 fail-closed：journal 只在同一 lease/attempt 内幂等恢复；lease reclaim 后整批 journal abandoned，新 attempt 全量重审，绝不跨 attempt 采纳旧 draft。
6. 分页 cursor 改绑可保留/重建的固定 `throughSequence` snapshot；后台新事件不使其 stale，只有 snapshot 淘汰或查询基线/过滤器变化才 stale。

## Round 3 — Independent reviewer

Round 2 六项被 reviewer 明确认定闭合，结论仍为 `VERDICT: REVISE`。

### 发现的问题

1. **P0 — ReviewAdoptionRoot 在当前事实产生前冻结，初始 Gate 不可达。** 设计要求所有新/旧事实都有 adoption，却在 round plan 时冻结 root；未来 assignment facts 无法进入 immutable root。
   - 证据：`src/server/storage/event-store.ts:315-325,372-383`。
2. **P0 — Grant boundAttemptId 与 WorkItem lease 时序循环。** settlement 创建 Grant 时 attempt 尚不存在；reclaim 后新 attempt 又会让旧 Grant 失效。
   - 证据：`src/server/runtime/task-runner.ts:1191-1246`；`src/server/runtime/structured-slot/grant-service.ts:357-401,435-448`。
3. **P0 — System WorkItem 没有 command attempt/epoch，且发布有双入口。** Agent attempt schema 不能承载 system handler；`system_seal` 与 `system_artifact_publish` 都可能发布。
   - 证据：`src/server/storage/task-events.ts:261-276`；`src/server/runtime/structured-slot/attempt-coordinator.ts:213-276`；`src/server/runtime/structured-slot/structured-committer.ts:681-737`。
4. **P0 — WorkItem 未接入 task stop/interruption/resume。** stopped 任务可能仍有 ready/leased WorkItem，被恢复扫描再次执行。
   - 证据：`src/server/runtime/task-scheduler.ts:548-574,594-669,769-815`。
5. **P1 — whole-observation ReviewFact 缺少不可继承身份。** 观察追加的 reject 在局部 digest 未变时可能被后续 round adoption。
   - 证据：`src/server/storage/task-events.ts:1-13` 的封闭事件 union 要求显式建模。

### 主设计者回应与修订

五项均接受：

1. 当前 round 新 ReviewFacts 改由 committed AssignmentLedger 直接进入 Gate；ReviewAdoptionRoot 只覆盖规划时已知的历史 inherited facts。Gate 明确定义为当前 assignment facts 与 adoption root 的并集。
2. 授权拆为 settlement 创建、绑定 WorkItem/baseline/scope 的 GrantSpec，以及每次 lease envelope 在 attemptId/epoch 已知后签发的 GrantInstance；reclaim 废弃旧 instance 并从同一 spec 重签。
3. 为 system WorkItem 新增独立 SystemCommandAttempt 与 completion/reclaim CAS；所有外部准备只写 staging，旧 epoch 无法发布。删除 `system_artifact_publish`，`system_seal` 是唯一 publish/delivery 入口。
4. 新增 Task lifecycle 联动：非 running 任务禁止 lease；stop/interruption 原子 park WorkItem 并终结 attempt/dispatch/journal；resume 原子恢复唯一 WorkItem、推进 epoch，不重复创建。
5. ReviewFact identity/digest 增加 `factOrigin` 与 `adoptionEligible`；whole observation facts 固定不可 adoption，但仍可参与当前轮 Gate。

## Round 4 — Independent reviewer

Round 3 五项被 reviewer 明确认定闭合，结论仍为 `VERDICT: REVISE`。

### 发现的问题

1. **P0 — 初始 Structure WorkItem 没有可构造写授权。** 设计要求所有写会话经过 grant，但初始 structure 没有 GrantSpec 来源。
   - 证据：`src/shared/structured-slots.ts:285-301`；`src/server/runtime/structured-slot/grant-service.ts:357-371`；`src/server/runtime/structured-slot/proposal-service.ts:565-575,617-623`。
2. **P0 — waiting_human 被通用 interruption/resume 规则破坏。** 重启可能把等待回答改成 interrupted，answer 不再可达，或 resume 误激活 question-bound WorkItem。
   - 证据：`src/server/runtime/task-scheduler.ts:594-625,839-840`；`src/server/storage/task-projector.ts:209-215`。
3. **P0 — retryable/terminal failure 没有 WorkItem 与 task 生命周期闭环。** 缺少 retry ordinal/not-before/budget/requeue 和 terminal task projection。
   - 证据：`src/server/storage/task-projector.ts:257-260`；`src/server/runtime/task-scheduler.ts:939-957,504-532`。
4. **P1 — system command 图仍有重复/不可执行正式 kind。** review settlement 已激活 Map，却还保留 system_map_activation；seal 已创建 Submitter，却还保留 system_submitter_dispatch。

### 主设计者回应与修订

四项均接受并冻结唯一语义：

1. 所有 Agent 写授权统一为 WriteGrantSpec + GrantInstance；`task_started + initial Structure WorkItem + initial_structure WriteGrantSpec` 同批创建，lease 原子签 attempt-bound Instance，reclaim 后旧 proposal/instance 失效。
2. waiting_human 明确排除在 crash interruption 之外；重启原样保持 question-bound parked 与可回答状态，普通 resume 禁止。stop 必须显式 cancel question，后续 resume 不复活旧问题。
3. WorkItem 增加 retryOrdinal/retryNotBefore/maxAutomaticRetries；retryable failure 持久化退避并显式 requeue，预算耗尽原子进入 task retryable_failure，permanent failure 原子进入 task_failed，SystemCommandAttempt 也有 terminal_failed。
4. system command 图缩为两个唯一入口：review_settlement（含 Map 激活/下一步）与 seal（含唯一 publish/delivery，并直接创建 submitter Agent WorkItem）；删除 map_activation、artifact_publish、submitter_dispatch system kinds。

## Round 5 — Independent reviewer

Round 4 的四项修订被 reviewer 认定基本闭合，但最终收敛检查仍返回 `VERDICT: REVISE`。

### 发现的问题

1. **P0 — Submitter WorkItem 无法构造合法 attempt。** Submitter 被定义为通用下游 turn、不属于 `StructuredSessionKindV2`，但设计又要求所有 Agent WorkItem lease 强制创建 `structured_slot_attempt_started`；Submitter 没有合法 session kind 可填。
   - 证据：`templates/zhihu-salt-chapter-draft/agents/submitter.yaml:1-10`；`src/server/runtime/task-runner.ts:815-838,912-929`；`src/server/storage/task-events.ts:79-89,261-276`。
2. **P0 — `task_failed` 没有正式任务状态、事件或投影。** 当前 `TaskStatus`、TaskEvent 封闭 union 和 projector 都不认识该值；写入会导致原子批次被拒绝，不写又会让任务保持假 running。
   - 证据：`src/shared/contracts.ts:17-33`；`src/server/storage/task-events.ts:187-201,866-867`；`src/server/storage/task-projector.ts:200-227`。
3. **P0 — waiting_human 被 stop 取消后没有替代 WorkItem。** 设计禁止恢复已取消问题，却没有在 stop 批次创建所谓的后续处置 WorkItem，resume 会得到 running-without-work。
   - 证据：`src/server/storage/task-projector.ts:243-255,209-215`。
4. **P0 — v2 的 start 与 resume 在 stopped 状态存在双重启动语义。** 当前 start 和 resume 都接受 stopped；若 v2 start 沿新协议重建初始 WorkItem，会把中途停止的任务重新开局。
   - 证据：`src/server/runtime/task-scheduler.ts:789-814`。

### 主设计者回应与修订

四项均接受：

1. `agent_assignment` 新增封闭的 `agentExecutionKind`。Structure/Review/Fill/Repair 走 structured-session attempt；Submitter 走绑定 `workItemId + attemptId + leaseEpoch + inputArtifactDeliveryId` 的 `GenericAgentAttempt`，沿用通用 turn runner，但不伪造结构槽 session 或 Grant。
2. 正式冻结 v2 `TaskStatus=failed`、`structured_task_failed_v2` 事件、projector/API/UI 行为和普通命令拒绝；唯一同任务恢复入口是受权 `reopen_failed`，它以原子批次保留旧 terminal WorkItem 并创建唯一替代项。v1 回放不变。
3. 选择保留问题而不是 stop-cancel：waiting_human 时 stop 只把任务置为 stopped，保留 pending question 和 question-bound parked WorkItem；resume 依现有 pending-question 投影回 waiting_human，answer/continue 同批恢复问题项及其他仍合法的 task-stop parked 项，或由显式原子创建替代 WorkItem 的人工处置继续。
4. v2 `start` 只允许从未启动的 ready 任务；stopped/interrupted 返回稳定 `USE_RESUME`，只能由 resume 恢复已有 WorkItem。v1 的 start-from-stopped 行为保持原义。

## 本次审查终止状态

- 本轮已经达到预先冻结的 `MAX_ROUNDS=5`，Round 5 最终 verdict 仍是 `REVISE`，没有获得 `APPROVED`。
- Round 5 报告的四项问题已经修订进设计正文，但没有经过同一 reviewer 的第六轮独立复验。
- 因此不得宣称设计已收敛，不得开始编写实施计划。下一步只能由人工决定是否开启一个新的、重新计数的独立对抗审查周期。
