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

## Cycle 2

用户随后明确授权：每个 5 轮周期满后自动开启新的独立审查周期，持续到 `APPROVED`，中途无需人工逐轮确认。

### Round 1 — Independent reviewer

`VERDICT: REVISE`

#### 发现的问题

1. **P0 — 审核中断恢复语义自相矛盾。** §12.4 要求未完成 assignment 的 journal 跨 lease 整批废弃，但失败表和验收场景又要求从该 assignment 未审核目标继续。
   - 证据：`src/server/storage/structured-slot-private-store.ts:285-325`。
2. **P0 — 人工 retry 会形成任务状态与 WorkItem 启动死锁。** retryable_failure 任务不允许 lease，而设计没有正式事件先把任务投影回 running。
   - 证据：`src/server/runtime/task-scheduler.ts:815-818`；`src/server/storage/task-projector.ts:229-260`。
3. **P0 — 10,000 槽位只分批审核，Structure 与初次生成仍是单回合巨型事务。** 当前 Structure 是整树替换，production profile 也有单 attempt 改动/工具次数上限。
   - 证据：`src/server/runtime/structured-slot/tool-factory.ts:64-71`；当前 profile 的 `maxChangedSlots=500`、`maxSlotToolCallsPerAttempt=128`。
4. **P0 — 独立审核没有 Agent 身份和历史隔离。** 同一 Agent ID 可绑定写角色和 reviewer，runner 又按 Agent ID 聚合历史。
   - 证据：`src/server/runtime/task-runner.ts:459-495`。
5. **P1 — 稳定分页 cursor 与进程重启语义冲突。** 当前 signer 使用内存随机密钥，重启后 snapshot 虽有效但 cursor 必然失效。
   - 证据：`src/server/runtime/structured-slot/projection-service.ts:21-26,84-104`；`src/server/core-service.ts:211-217,787-795`。
6. **P1 — waiting-human 回答后的继续身份未冻结。** “恢复或替换”旧 WorkItem 会分别导致复活 abandoned draft 或缺少新权威继续点。
   - 证据：`src/server/runtime/structured-slot/structured-committer.ts:794-843`；`src/server/runtime/task-scheduler.ts:1250-1301`。

#### 主设计者回应与修订

六项均接受：

1. 明确只有已完成 AssignmentLedgerBlob 可保留；当前未完成 assignment 的 partial draft 无论完成多少目标都整批废弃、整批重审，失败表和验收项同步修改。
2. 新增正式 `structured_task_retry_resumed_v2`；人工 retry 原子恢复唯一 budget-exhausted WorkItem、推进 epoch/预算并先把任务投影为 running，随后才能 lease。
3. 新增 MapBuild chunk + `system_map_finalize` 协议，以及串行 GenerationPlan batches。完整候选/完整内容产生前禁止进入相应审核；两条 10k 生产链进入 qualification。
4. loader 强制 reviewer Agent ID 与全部写角色不同；review runner 使用 work-item/attempt 隔离 namespace，不注入 Structure/Fill/Repair/Submitter 历史。
5. v2 cursor 使用可跨进程恢复的持久 signer key ring + keyId 或持久 opaque token，定义轮换/淘汰并加入分页中途重启测试。
6. 冻结 HumanAnswerDelivery：回答永久 supersede 原 question WorkItem，原子创建绑定 logical assignment、answer digest 与最新基线的 replacement WorkItem/GrantSpec；旧 attempt/draft/GrantInstance 永不复活。

### Round 2 — Independent reviewer

`VERDICT: REVISE`

#### 发现的问题

1. **P0 — MapBuild 没有可达的结束协议。** 无计划 chunk 数、`isLast` 或 finish 操作，系统无法判断创建下一块还是 finalizer。
2. **P0 — v2 structure 的旧整树 session/capability 合同与 chunk 工具互斥。** 严格 validator 无法同时接受两套终结语义。
   - 证据：`src/server/template/structured-pipeline-validator.ts:45-65`；`src/server/runtime/structured-slot/tool-factory.ts:64-71,290-297`。
3. **P0 — 跨 chunk 节点身份无法闭合。** attempt-local client key 不能被后续 WorkItem 引用，官方 ID 又尚未分配。
4. **P0 — system_map_finalize 的确定性拒绝没有领域返修路径。** Structure attempt 已结束，通用 system failure 不是修正结构错误的合法方式。
5. **P0 — 10k 分批仍会被写 Agent 的跨 WorkItem 历史聚合成巨型上下文。** 当前 runner/Pi 会按 Agent ID 重建全部历史。
   - 证据：`src/server/runtime/task-runner.ts:459-495,918`；`src/server/runtime/pi-agent-runtime.ts:369-397,751-756`。
6. **P0 — HumanAnswerDelivery 缺少正式事件/记录 schema。** 当前 `human_answered` 不足以绑定问题、原/替代 WorkItem 和基线。
   - 证据：`src/server/storage/task-events.ts:241-258,535`。

#### 主设计者回应与修订

六项均接受：

1. 新增显式 `finish_map_build(expectedChunkCount, expectedFrontierDigest, expectedRootCount)` 提议；系统验证连续 ordinal/frontier/root/profile 后才创建 finalizer，缺失时只创建下一 chunk。
2. v2 会话正式改为 `structure_chunk` / `generation_batch`，冻结对应 capabilities 和 terminal result，删除 v2 旧整树 structure/fill 语义；map/content repair 保持独立。
3. 新增 MapBuild 级 `buildNodeKey/buildRelationKey` 与不可变 key ledger；跨 chunk 只引用 build key，finalize 统一映射成永不复用的官方 ID。
4. finalizer 区分 domain_invalid 与 infrastructure failure：前者写 rejected build + validation receipt，正常完成并原子创建修订 StructureChunk WorkItem；后者才重试/terminal。
5. 全部 v2 Agent WorkItems 使用 workItem/attempt 隔离 conversation namespace，只注入当前 dispatch、answer delivery 与 bounded checkpoint；连续性通过已提交工具读取，不靠原始历史。
6. 新增正式 `structured_human_answer_delivered_v2`，完整绑定 questionId、original/replacement WorkItem、logical assignment、answer/base digests 和 operationId。

### Round 3 — Independent reviewer

`VERDICT: REVISE`

Round 2 六项被认定基本闭合，新增八项问题：

1. MapBuild domain_invalid 后缺少不可变 revision/supersedes/active manifest/key-lineage，无法安全替换 chunk。
2. HumanAnswerDelivery 缺少权威 question-open 事实，genesis replay 仍会猜“最近问题”。
3. GenerationPlan 最终全局校验指向早期 batch 时，没有可达修复路径。
4. `running + ready + no lease` 在进程重启后可能无人 claim；`running + no work` 也未 fail-closed。
5. System artifact 缺少正式 publish/delivery 事件与 storage/API/UI provenance 判别联合；当前系统强制 sourceNodeId。
6. 大规模 Map/Content Findings 仍合成单个超限 RepairGrant。
7. `assignmentId` 混合调度身份与领域 ReviewAssignment，非 review Agent 无合法来源。
8. 10k 树读取/API/UI 没有 stable tree cursor、按 ID 定位和虚拟化，当前 UI 1,000 条后不可达。

仓库证据包括：`task-events.ts:241-258`、`task-projector.ts:243-255`、`http-server.ts:191-195`、`task-scheduler.ts:472-474,729-758`、`contracts.ts:229-237`、`api-schemas.ts:181-195`、`artifact-store.ts:55-72,129-155`、`production-page.tsx:107-113`、`structured-slot-drawer.tsx:27-29,66-76,158-176`。

#### 主设计者回应与修订

八项均接受：

1. MapBuild 增加 rejected 终态和 successor revision：新 mapBuildId、supersedes、receipt、imported immutable refs、replacement manifest、active manifest digest 与 key lineage，旧 build 永不再写。
2. 新增 StructuredHumanQuestion 与 `structured_human_question_opened_v2`，和 attempt terminal/WorkItem parked 原子提交；delivery 消费精确 opened question，普通 v1 human 事件只展示。
3. 最后一 generation batch 后新增 system_generation_finalize；domain invalid 产生 receipt/successor correction plan，只重开被指向 batches/slots，纠正后重新 finalize。
4. 冻结启动恢复矩阵：running+leased reclaim；running+ready 注册持久 Coordinator并 claim；running+无非终态 WorkItem 写明确失败。
5. 新增正式 artifact published/delivery-created 事件、稳定 publishOperationId 和 Agent/System provenance 判别联合；同步 storage/API/UI，System 不伪造 sourceNodeId。
6. 新增不可变 MapRepairPlan/ContentRepairPlan，按上限确定性串行切片，全部批次完成后才进入复审。
7. 所有 Agent WorkItem 使用非空 logicalAssignmentId；仅 review 项另有 reviewAssignmentId，System 两者均空。
8. 新增 snapshot-stable tree child paging 与 slotId locate/ancestor seek；UI lazy-load + virtualize，禁止静默 1,000 cap，并加入 >1000 槽浏览器验收。

### Round 4 — Independent reviewer

`VERDICT: REVISE`

Round 3 八项被认定闭合，新增五项：

1. 多批 MapRepairPlan 缺少 staging Map root、跨批 key ledger 和 successor lineage。
2. Map/Content RepairPlan 最终全局校验失败缺少 repair finalizer/receipt/修订路径。
3. Generation correction plan 缺少 supersedes、receipt、import manifest、correction scope 和唯一 successor 身份。
4. v2 structured Agent attempt/System command 的 started/completed/failed/abandoned 封闭事件不完整，且不能复用 v1 session 事件。
5. 七个 v2 validator trigger 缺少独立模板 schema/ABI、稳定定位/repair targets 和 domain/infrastructure 分类。

证据包括：`structured-slot-contract.ts:69-75,160-162,541-579` 仅支持 v1 validator；`task-events.ts:89,262-275,538-545,760-785` 的现有 structured attempt 仍是 v1 schema。

#### 主设计者回应与修订

五项均接受：

1. 定义 MapRepairPlanRevision、逐批 stagingMapRootDigest CAS、plan key ledger、final official ID mapping，以及 scope expansion/failure successor revision 的 staging/key lineage。
2. 新增 `system_repair_finalize`；领域失败写 RepairValidationReceipt + rejected + 唯一 successor，仅重开定位批次；基础设施失败才 retry。
3. GenerationPlan 正式增加 revision/supersedes/receipt/base root/imported content manifest/correction scope；稳定 receipt+plan 幂等键阻止竞争 successor。
4. 新增版本隔离的 v2 structured Agent attempt 五态事件和 System command retryable/terminal failed 事件，完整绑定 WorkItem/logical assignment/epoch/base，不改 v1 union。
5. 冻结 ValidatorRegistrationV2 与输入/输出 ABI：七 trigger、selector/enforcement、implementation digest、稳定 location/repairTargets、deterministic identity、domain invalid 与 runtime infrastructure failure 分类；v1 注册不重解释。

### Round 5 — Independent reviewer

`VERDICT: REVISE`

1. Repair staging/finalizer 尚未贯穿 WriteGrantSpec、plan-aware 工具和原子提交，旧语义仍允许 Agent batch 直接冻结候选。
2. retry budget exhausted 后 stop/resume 可覆盖 park reason 并绕过专用人工 retry。
3. v2 公开 answer API 不携带 question identity，双标签页陈旧答案可能被绑定到后续问题。

#### 主设计者回应与修订

三项均接受：

1. WriteGrantSpec 改为判别联合；RepairBatchGrantSpec 强制绑定 plan revision、expected staging root、key ledger、batch ordinal。新增 plan-aware staging read/CAS submit；Agent batches 只推进私有 staging，最后只创建 finalizer，删除直接发布 candidate/content root 的旧语义。
2. task stop 改为 TaskSuspensionOverlay，保留底层 retry-budget/human disposition。resume 只恢复 stop 前可运行项；budget-exhausted 仍回 retryable_failure，只有 `structured_task_retry_resumed_v2` 可清预算。
3. v2 workspace 返回 questionId/digest/openedSequence；v2 answer body 强制 question identity、expected sequence/digest 和 operationId，不匹配返回 `HUMAN_QUESTION_STALE`。v1 body 按冻结 contract 分流。

### Cycle 2 终止状态

本周期达到 5 轮且最终仍为 `REVISE`。Round 5 三项已修订，但尚未由同一 reviewer 再次复验；按用户授权自动开启 Cycle 3，不进入实施计划。

## Cycle 3

Reviewer：独立 subagent `design_review_cycle3`（只读）

范围：当前设计文档、Cycle 1/2 修订日志和仓库实现约束。

规则：先复验 Cycle 2 Round 5，再攻击权威身份、task lifecycle、public API 与原子恢复边界；最多 5 轮。

### Round 1 — Independent reviewer

`VERDICT: REVISE`

Cycle 2 Round 5 的 repair staging 主线被认定基本闭合，新增四项问题：

1. **P0 — 公开 answer API 仍要求调用方提交不可知的账本尾 `expectedLastSequence`。** workspace 只给 openedSequence；问题打开后的无关事件或 stop/resume 会使合法回答失败，调用方也无法安全猜当前尾部。
2. **P0 — TaskSuspensionOverlay 只是叙述和临时布尔值，没有可回放的正式对象、事件与 projector 优先级。** stop/resume 后底层 ready/retry/human disposition 仍可能被不同执行路径解释不一致。
3. **P0 — MapCandidateSnapshot 强制 `submittedByAttemptId`，但候选现在只能由 System finalizer 产生。** 这会要求不存在的 Agent attempt，或让 finalizer 冒充 Agent 来源。
4. **P1 — System terminal failure 仍保留 waiting-human escalation 分支，但 SystemCommand 没有 logical/review assignment 和 Agent question identity。** 状态机无法形成合法 StructuredHumanQuestion。

#### 主设计者回应与修订

四项均接受：

1. 用服务端稳定 opaque `questionVersion` 取代公开 `expectedLastSequence`。workspace 返回 questionId/version，answer 只回传 version + operationId；服务端内部读取当前尾并 CAS，无关并发事件可安全重试，已消费/替代 version 才返回 stale。
2. 正式定义 `TaskSuspensionOverlay`、`structured_task_suspension_applied_v2` / `cleared_v2`、活动 overlay 唯一性、投影优先级和 scheduler 可认领谓词。stop 后 ready 保持 ready、leased 正式 reclaim，retry/human parkDisposition 不变。
3. MapCandidate provenance 改为 system_map_finalize/system_repair_finalize 判别联合，绑定 producer WorkItem、SystemCommand、输入 plan/build revision 与 contribution manifest；各 Agent attempts 只作为 manifest contribution。
4. 删除 System 到 waiting_human 的模糊分支：可恢复 System 失败只能 retryable，永久失败只能 failed；人工问题只允许合法活动 Agent attempt 创建。

### Round 2 — Independent reviewer

`VERDICT: REVISE`

Round 1 四项被认定闭合，新增三项 P0：

1. `operator_interrupt` overlay 没有可达的创建事务；当前 shutdown/recovery 只写普通 interrupted，resume 又要求 active overlay，会形成不可恢复任务。
2. 删除 System/Coordinator 人工提问后，无进展预算、Assembler、无法分类、轮次上限等仍写“请求人工/人工升级”，没有合法状态迁移。
3. Map repair 新对象同时使用 attempt-local `clientNodeKey` 与 plan-level key ledger，多批次跨 WorkItem 引用无法自洽。

#### 主设计者回应与修订

三项均接受，并把 Cycle 2 storage audit 的两个相关边界一并闭合：

1. 优雅 shutdown/operator interrupt 同批关闭 attempt、reclaim lease并写 `task_interrupted + suspension_applied(operator_interrupt)`；非优雅 crash 首版冻结为自动继续，不写 interrupted。启动矩阵新增持久 `retryable_failed/retryNotBefore` timer 重建与到期 requeue。
2. 所有 Coordinator/System 升级均映射到现有权威处置：瞬时/预算耗尽进入 retryable_failure + manual retry，不可恢复/轮次上限进入 failed + reopen_failed；只有活动 Agent attempt 可打开 question。
3. repair staging 新对象只使用 `repairPlanNodeKey/repairPlanRelationKey`（plan revision scope）；attempt alias 只在请求内解析，不进入 staging/manifest。finalizer 根据 plan ledger 一次性分配官方 ID。
4. 补全 ValidatorRegistrationV2 的 builtin implementationRef、唯一 handlerKey、input/output ABI、budget profile 和 determinism sandbox；不存在/重复 handler fail-closed。
5. 补全所有 MapBuild/Generation/Repair staging、ledger、receipt、manifest 大对象的统一 BlobRefV2、durable-put-before-event、manifest visibility、corruption 与 GC 契约。

### Round 3 — Independent replacement reviewer

原 reviewer 连续两次执行超时且未返回结论，主线程终止该 turn，并在不增加轮次、不降低标准的前提下由轻上下文独立 reviewer 接替 Round 3。替换 reviewer 返回：

`VERDICT: REVISE`

1. stop/restart/resume 会丢失 `retryable_failed` 定时唤醒：suspended task 不 claim，但仍需保存 timer identity，resume 必须处理到期/未到期底态。
2. 未冻结同任务 active lease 数量，却依赖唯一 pending question 和唯一 budget-exhausted WorkItem；并行 review 会让 answer/retry 无目标。
3. durable-put-before-event 与 orphan GC 之间仍可删除正在 prepare 的 blob；笼统 ref lease 不足以跨进程恢复。
4. RepairPlan successor 缺少不可变 revision identity、完整 predecessor、稳定 operation key 和可验证 key-lineage blob，可能分叉。
5. Validator ABI 缺封闭 Result union，Issue 自带 severity 与 registration enforcement 冲突，seal_output invalid 也没有确定处置。

#### 主设计者回应与修订

五项均接受：

1. suspended task 的 retryable_failed 仍进入持久 wakeup index；resume 在清 overlay 的同一 envelope 把已到期项 requeue，未到期项提交后重建可靠 timer。
2. 首版冻结 `maxActiveLeasesPerTask=1`，涵盖所有 Agent/reviewer/Submitter/System WorkItem；activeLease 设置/清除均在 task-tail CAS 内，第二 question/retry disposition 视为 corrupt。
3. 新增 durable PublicationPin、GC generation barrier、append 前 blob/tail 复验、跨进程 epoch lock、crash pin recovery/abandon 与至少一代延迟回收。
4. RepairPlan 增加 planRevisionId/planDigest、完整 supersedes、successorReason/operationKey、predecessor-active CAS 和内容寻址 keyLineageRef/digest；同前驱不能产生并行 active successors。
5. 新增 `ValidatorResultV2 = valid | domain_invalid(non-empty issues)`；Issue 删除 severity/classification，enforcement 只来自 registration；冻结七 trigger target/处置矩阵，seal_output invalid 明确进入 System terminal failure。

### Round 4 — Independent reviewer

`VERDICT: REVISE`

Round 3 的 overlay/retry timer、单 lease、PublicationPin/GC 主线被认定闭合，新增四项 P0：

1. initial RepairPlan 允许无 predecessor，却强制使用依赖 predecessor 的 successorOperationKey，首次结算无法构造确定记录。
2. scope expansion 在 capability 中声明但 Map 工具不可调用；批准/拒绝事务与 WorkItem-bound GrantSpec 冲突，旧 spec 被错误复用。
3. Validator registration 允许 advisory，但 trigger 处置表把所有 domain_invalid 当 blocking，导致是否阻断不确定。
4. GenericAgentAttempt 有 retryable/terminal 两种状态却只有一个 failed 事件，Submitter 重启回放无法选择 timer 或 failed。

#### 主设计者回应与修订

四项均接受：

1. RepairPlan origin 改为判别联合：initial 使用 settlement/Findings/base/scope 派生 creationOperationKey；successor 才要求完整 predecessor 与 successorOperationKey。
2. 增加 Map/Content 两个正式 scope-expansion 工具。批准时原子终结 attempt、失活 predecessor、创建 successor plan/new WorkItem/new GrantSpec；拒绝时保持 plan/staging，但也创建 replacement WorkItem 和全新同 scope GrantSpec，旧 spec 永不复用。
3. trigger 处置矩阵同时按 enforcement 冻结：advisory 只写 receipt/warning 并继续，blocking 才返修/failed；seal_output 首版 loader 禁止 advisory。
4. GenericAgentAttempt 拆分正式 retryable_failed/terminal_failed 事件，各自绑定完整身份并唯一驱动 WorkItem retry 或 task failed。

### Round 5 — Independent reviewer

`VERDICT: REVISE`

Round 4 四项被认定闭合；剩余两项均围绕 advisory validator：

1. advisory“不阻断”尚未贯穿 MapBuild/Generation/Repair finalizer、Map activation 与 Seal Gate；这些位置仍把任何 domain_invalid 当 rejected/successor 或要求 validators 全部“通过”。
2. advisory warning 缺不可变 custody/digest 链；MapReviewBundle/ReviewBundle/SealRecord 没有 warning root，尤其后置 seal_input/output 不可能合法回写已经冻结的 ReviewBundle。

#### 主设计者回应与修订

两项均接受：

1. 定义统一 `ValidatorAggregateV2`，聚合 `blockingInvalidReceiptRefs/advisoryReceiptRefs/infrastructureFailure` 与 ValidationWarningRoot。所有 finalizer、activation、settlement、seal input/output 和 Gate 只消费 aggregate：只有 blocking invalid 返修/failed，advisory clear 并继续，infrastructure 走 retry/terminal。
2. MapReviewBundle/ReviewBundle 在冻结前绑定各自 ValidatorAggregate 与 warning root；seal_input/output 使用独立不可变 `SealValidationBundle`，SealRecord 强制绑定其 digest，不修改既有 bundle。存储、事件、回放和 API/UI 以 BlobRefV2 保存三层 warning custody。

### Cycle 3 终止状态

本周期达到 5 轮且最终仍为 `REVISE`。Round 5 两项已修订但尚未复验；按用户授权自动开启 Cycle 4，不进入 Spec/实施计划。

## Cycle 4

Reviewer：独立 subagent `design_review_cycle4`（只读）。

范围：当前设计、Cycle 3 尾部修订与仓库现实；最多 5 轮。

### Round 1 — Independent reviewer

`VERDICT: REVISE`

Cycle 3 Round 5 的 advisory 方向被认定正确，但发现四项对象图阻断：

1. ValidatorAggregate outcome 可为 infrastructure_failure，却没有不可变 failure refs，无法证明哪个 registration 为什么失败。
2. map_activation 校验最终 MapReviewBundle，而最终 bundle 又包含 activation aggregate digest，形成内容寻址循环。
3. 单-trigger ValidationWarningRoot 无法承担 Map/Content 多 trigger、多 batch 的“合并根”，排序、去重和 supersession 不确定。
4. candidate/bundles/SealValidationBundle 多处只存裸 digest，与 BlobRefV2/GC 递归 custody 规则冲突，warning blob 可能被回收。

#### 主设计者回应与修订

四项均接受：

1. ValidatorAggregate 增加有序 `infrastructureFailureRefs: BlobRefV2[]`；缺执行/重复/contract violation 也先写 failure blob。outcome 固定 infrastructure > blocking > clear，aggregate digest 包含 failure refs。
2. 引入 `MapReviewSettlementCore` 两阶段图：先冻结覆盖/Findings/pre-activation aggregates；map_activation 只校验 core + candidate + proposed Map；clear 后才形成含 activation aggregate 的最终 MapReviewBundle。
3. 新增 `ValidationWarningCustodyRoot`，冻结 scope/base/entry schema、trigger/revision/batch 排序、current manifest supersession 和 canonical empty root。
4. MapCandidate/Core/MapReviewBundle/ReviewBundle/SealValidationBundle 与正式发布事件全部改用精确 BlobRefV2；列举 event GC roots 和递归子 ref 规则，裸 digest 仅可作为 ref.digest 展示别名。

### Round 2 — Independent reviewer

`VERDICT: REVISE`

Round 1 四项被认定有实质闭合，新增四项同构阻断：

1. Content Review 仍让 review_settlement 输入最终 ReviewBundle，而 bundle 又包含 settlement aggregate，形成内容侧 digest 循环。
2. content_review custody 依赖未定义的“content-root manifest”，无法确定 correction/repair 后每个当前槽位版本应保留哪些 validator warning。
3. validator infrastructure/rejected 分支没有正式事件 BlobRef GC roots；无成功 candidate/bundle 时 failure/receipt 证据可被回收。
4. MapBuild、GenerationPlan、RepairPlan、candidate provenance 等核心 lineage 仍混用裸 receipt/manifest/ledger digests，与“裸 digest 不形成 custody”冲突。

#### 主设计者回应与修订

四项均接受，并统一迁移对象模型：

1. 新增 ContentReviewSettlementCore；review_settlement 只校验 core，aggregate clear 后才冻结 ReviewBundle，seal_input 才读取最终 bundle。
2. 新增 ContentRevisionManifestV2：每个 current SlotContentVersion 绑定 producer plan/batch、content ref、content-commit aggregate/warning refs；每次 content revision event 发布 manifestRef，custody 只遍历当前 manifest。
3. 所有 validator System retryable/terminal、build/generation/repair rejected、settlement blocking 事件强制持有 validatorAggregateRef，并按分支持有 receiptRef/failure refs；纳入 GC root 表。
4. MapBuild/GenerationPlan/RepairPlan/candidate provenance/Grant/WorkItem 跨对象字段改为 BlobRefV2；digest 只作为 ref.digest 展示值。GC 递归事件 roots，可机械校验裸 lineage digest。

### Round 3 — Independent reviewer

`VERDICT: REVISE`

Round 2 方向正确但发现五项仍会形成不可构造或不可回放对象图：

1. map_candidate_commit/content_commit 直接输入包含其自身 aggregate/warning refs 的最终 candidate/manifest，形成 self-ref digest 循环。
2. MapReviewSettlementCore 仍含 settlement aggregate，而 settlement validator 又输入 Core；activation 要求的 proposedMapRef 也只能用含最终 bundle 的 MapSnapshot。
3. ContentRevisionManifest 没有初始 `unset` entry，Map 刚激活但未生成正文时无法创建首个 plan 所需 manifest。
4. manifest producerPlanRef 与 Plan.currentManifestRef 可能互相引用；finalizer aggregate/warning refs也没有权威 current manifest lineage。
5. Seal blocking validator 不生成 SealValidationBundle，又没有专门事件持有 aggregate/receipt refs。

#### 主设计者回应与修订

五项均接受，并将所有 validator 发布统一成 `pre-validation core -> aggregate -> finalized object`：

1. 新增 MapCandidateValidationCore 与 ContentRevisionCommitCore；相应 validator 只读 core，clear 后才包装最终 candidate/manifest。
2. Map 结算改为 CoverageCore -> settlement aggregate/Core -> ProposedMapCore -> activation aggregate -> Bundle/MapSnapshot 的单向五段图。
3. SlotContentVersion/manifest entry 改为 `unset | set`；初始全 unset 合法，unset 用 schema-bound sentinel leaf，Gate 要求必需内容 set。
4. MapBuild/Generation/Repair 拆成不可变 PlanSpec 与事件派生 State；manifest 只引用 pre-commit spec。batch commit/finalize 各发布新 manifest revision，finalized manifest 显式绑定 finalizer aggregate/warning refs。
5. 新增 `structured_seal_validation_rejected_v2`，input blocking 路由返修、output blocking 进入 ARTIFACT_VALIDATION_FAILED；两者持有 aggregate/receipt refs 并纳入 GC roots。

### Round 4 — Independent reviewer

`VERDICT: REVISE`

Round 3 五项修订被认定闭合，新增四项阻断：

1. candidate/content/seal 的失败事件只保活 aggregate/receipt，aggregate 只有 inputDigest，GC 后被验证 core/artifact 不可复验。
2. `content_commit` 没有区分 batch 与完整计划 finalizer；partial batch 与全局完整性 validator 无法确定注册/输入语义。
3. Map 激活后沿用旧内容无法同时满足新 mapDigest 与 content-commit provenance；缺少权威迁移 core/proof/manifest transition。
4. Generation/Repair Plan 与 Grant 仍以裸 Map/content digest 绑定授权，same-root/different-manifest 时会误接受旧 capability。

#### 主设计者回应与修订

四项均接受：

1. 新增 canonical `ValidatorInputEnvelopeV2` Blob；ValidatorAggregate/WarningRoot 强制持有 `inputRef`，digest 仅冗余。所有成功、blocking、retry、terminal 分支由 aggregate 递归保活实际 core/manifest/artifact。
2. `content_commit` registration/输入增加 `batch_commit | plan_finalize` phase；新增 ContentValidationCore 判别联合和绑定完整 provisional manifest、coverage、batch closure 的 ContentPlanFinalizeCore。只有 finalizer clear 可发布 finalized manifest，Seal 只消费 finalized。
3. SlotContentVersion 改为独立 Blob；新增 `inherited_after_map_activation` provenance、ContentCompatibilityProof、ContentMigrationSpec/Core。Map 激活 envelope 原子持有新 Map 与 migrated manifest，旧 validator/review 只作审计并按影响规则 stale。
4. Generation/Repair Plan、Grant 改为 MapSnapshot/MapCandidate/ContentManifest BlobRef 判别基线；新增 AuthorityBaseSetV2，WorkItem/dispatch/attempt/command/工具统一引用同一个 authorityBaseRef。相同内容根但 manifestRef 不同仍使授权 stale。

### Round 5 — Independent reviewer

`VERDICT: REVISE`

Round 4 四项方向被认定闭合，但组合后仍有五个阻断：

1. `mapDigest` 同时被当作图语义摘要与 MapSnapshot BlobRef digest，无法满足内容寻址。
2. 迁移 set 内容只做身份/schema proof 与 plan finalize，可能绕过新 Map 基线上的 batch_commit blocking validators。
3. migration finalizer 发现 map/mixed target 时仍无条件激活 Map 并建 ContentRepairPlan，违反 Map-first 路由。
4. Seal/Submitter AuthorityBase 缺 ReviewBundle/SealRecord/artifact refs，Delivery/Provenance 仍混用裸 digests，Seal Gate 只比 content root。
5. 源 manifest 中兼容的 optional unset 槽没有合法迁移动作，目标 manifest 无法全覆盖。

#### 主设计者回应与修订

五项均接受：

1. 拆分 `mapSemanticDigest` 与 `MapSnapshotRef.digest`；前者只表示图语义，后者是含审核/provenance 的完整对象地址。内容 version/manifest 校验解析 mapRef 后的 semantic digest，不要求两者相等。
2. 增加 LocalValidatorEquivalenceProof：只有 registration set、selector、正文、局部子图/关系输入完全等价才可复用旧 batch 事实；否则迁移必须在 target Map 上真实执行 batch_commit，blocking 不能进入 finalized manifest。
3. activation 前统一分类 migration batch/finalizer receipts：纯 content 可激活后建 ContentRepairPlan；任一 map/mixed 不激活、保持旧基线并建 candidate-bound MapRepairPlan；infrastructure 整体不提交。
4. AuthorityBase 增加 MapReviewBundle/ReviewBundle/SealRecord/artifact refs；SealRecord、Delivery、ArtifactProvenance 全改 BlobRefs；Gate 强制当前 finalized manifestRef 精确等于 ReviewBundle coverage core 所绑定 ref。
5. 增加 `carry_unset` decision 与 `rebased_after_map_activation` unset provenance；兼容 optional unset 可迁移但仍不满足必需内容 Gate，旧 review stale。

### Cycle 4 终止状态

本周期达到 5 轮且最终仍为 `REVISE`。Round 5 五项已修订但尚未复验；按用户授权自动开启 Cycle 5，不进入 Spec/实施计划。

## Cycle 5

Reviewer：新独立 subagent `design_review_cycle5`（只读）。

范围：Cycle 4 尾部修订与当前仓库现实；最多 5 轮。

### Round 1 — Independent reviewer

`VERDICT: REVISE`

Cycle 4 Round 5 五项方向被认定闭合，但 migration/presence 仍有四个阻断：

1. migration batch blocking 或 mixed 强制重写时没有合法 target version，provisional manifest 无法全覆盖。
2. optional unset 没有可提交 contentDigest，却被“所有内容槽审核/pass”规则要求审核，永远无法 Seal。
3. 10k 非等价槽迁移校验被塞入一次 review-settlement lease/原子事务，不满足预算与崩溃恢复。
4. MigrationCore 被要求先冻结，随后又补 aggregate refs，内容寻址不可变对象无法构造。

#### 主设计者回应与修订

四项均接受：

1. SlotContentVersion 增加仅 provisional 合法的 rewrite_required，绑定 source、blocking aggregate/receipt/Finding 或 mixed stage；ContentRepair 替换前不可 final/Seal。
2. 定义 presence-aware ContentSlotCoverageFact：required/optional set 由 reviewer 审核；optional unset 由系统 absent_not_applicable fact 覆盖；required unset/rewrite_required 先修复。
3. 新增 candidate-bound ContentMigrationValidationPlan，按 profile 切分为持久 system_migration_validation_batch WorkItems；每批 aggregate/receipt 落事件，崩溃从未完成 ordinal 恢复。review_settlement 使用 initial/post_migration 两阶段 WorkItems，只有 post_migration 短事务激活。
4. 拆为无输出的 ContentMigrationIntentCore 与批次完成后首次冻结的 ContentMigrationSettlementCore；versions/manifest 只引用 settlement core，不事后修改 intent。

### Round 2 — Independent reviewer

`VERDICT: REVISE`

Round 1 四项主线闭合，但还有三个贯穿缺口：

1. MigrationPlanState 没有正式 started/batch-completed/settled 事件和 GC roots，重启无法重建已完成 ordinals。
2. migration pre-activation plan finalizer 仍只有 activeMapRef，无法合法绑定尚未激活的 proposed Map。
3. §16.1 settlement 仍要求所有 coverage 槽有 verdict，没有接受 optional-unset 的 absent fact。

#### 主设计者回应与修订

三项均接受：

1. 新增并冻结 `structured_migration_validation_plan_started`、`...batch_completed`、`...settlement_completed` 三类事件，逐一规定 payload、原子边界与 GC root；initial -> durable batches -> post_migration 可从账本重建。
2. ContentPlanFinalizeCore.mapContext 改为 `active | migration_preactivation` 判别联合；后者绑定 candidate/proposed map/target Map/migration plan/settlement operation，且只有 post_migration System command 可消费。
3. settlement 公式改为每槽恰有一个 ContentSlotCoverageFact：set 使用 reviewed verdict，optional-unset 使用 system absent_not_applicable，required-unset/rewrite_required 不可进入 round。

### Round 3 — Independent reviewer

`VERDICT: REVISE`

Round 2 三项闭合，但 migration 最终时序仍有两个阻断：

1. SettlementCore 提前冻结 routeOutcome，而随后 plan-finalize 仍可能发现 map/mixed，最终路由不能改写不可变 core。
2. equivalence proof 没有进入 batch completion 的持久 result root；无 aggregate 的等价槽在重启/GC 后无法构造 settlement。

#### 主设计者回应与修订

两项均接受：

1. SettlementCore 只保存 batchRouteOutcome；plan-finalize 后新增不可变 MigrationActivationDecision，合并 batch/finalizer findings 得到 combinedRouteOutcome。post_migration 事件和激活事务消费 decisionRef。
2. 新增 MigrationValidationBatchResultV2，逐槽记录 equivalent(proofRef)、revalidated(aggregate/warning) 或 rejected(aggregate/receipt/Finding)。batch event、PlanState、SettlementCore 与 GC 使用有序 batchResultRootRefs。

### Round 4 — Independent reviewer

`VERDICT: APPROVED`

Reviewer 复验 Round 3 的 ActivationDecision 与 batch result roots 修订后，未发现新的实现阻断项。

### Cycle 5 终止状态

设计在 Cycle 5 Round 4 获得 `APPROVED`。至此共执行 5 个审查周期、24 轮独立对抗审查；当前 lifecycle design 冻结，可进入技术 Spec 与开发实施计划阶段。
