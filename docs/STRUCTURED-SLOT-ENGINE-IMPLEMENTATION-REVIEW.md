# Forge Core 结构槽引擎：实施可落地性对抗审查记录

> 状态：**APPROVED / 已批准（Round 5）**
> 开始日期：2026-08-10
> 最大轮数：5
> 仓库基线：`c18ac28`
> 审查对象：[`2026-08-10-structured-slot-engine-spec.md`](./2026-08-10-structured-slot-engine-spec.md) 与 [`2026-08-10-structured-slot-engine.md`](./superpowers/plans/2026-08-10-structured-slot-engine.md)
> 设计上游：[`STRUCTURED-SLOT-ENGINE-DESIGN.md`](./STRUCTURED-SLOT-ENGINE-DESIGN.md)
> 规则：独立 reviewer 只读仓库；必须以当前代码结构和测试入口为证据，审查 Spec 与开发计划能否真实落地。存在 material 实施阻塞或错误拆分即 `REVISE`；只有没有 material finding 才能 `APPROVED`。本轮不编写功能代码。

---

## Round 1 — Independent reviewer

本轮 reviewer 使用不继承主 Agent 结论的独立上下文，只读检查基线 `c18ac28`。首次扫描达到 10 分钟上限后中断；同一 reviewer 随后只基于已经完成的证据收敛报告，没有重新扫描或换 reviewer。

结论：无 P0；确认 6 个 P1、3 个 P2。

### P1-1｜安全正则没有可执行实现方案

- **类型**：Spec/计划可执行性缺口；系统设计的安全要求正确。
- **证据**：设计与 Spec 冻结 `forge-safe-regex/v1` RE2 子集；原 Task 2 只有 `slot-schema.ts/test` 和一句“Compile safe regex”。`package.json` 没有线性时间 regex 引擎。
- **失败场景**：实现者使用 JS `RegExp` 加语法黑名单，`^(a+)+$`、`(a|aa)+$` 等模式仍可灾难性回溯。
- **最小修订**：冻结实际线性引擎、独立 wrapper、依赖文件和 ReDoS/方言/Unicode/substring 对抗测试。

### P1-2｜production runnable gate 没有关闭—开启协议或任务所有者

- **类型**：Spec/计划发布安全缺口。
- **证据**：Spec 要求基准、恢复、basic 回归前不可运行；原 Task 4/5 接生产 Loader，Task 17 接运行，Task 19 却没有门禁代码文件。当前代码只有 TurnContract version compatibility gate，Catalog 会直接 adopt Loader 成功模板。
- **失败场景**：若 Task 5 把 v3 视为 supported，未完成 runtime 也可启动；若继续 unsupported，则没有最终开启步骤；Task 17 直接开启又早于 Task 19 全量证据。
- **最小修订**：增加独立 runtime readiness manifest，默认关闭；Loader/Catalog/task creation/Scheduler 共同检查；测试显式注入；最终验收任务拥有唯一开启步骤。

### P1-3｜`structured_fill_draft_opened` 被定义和投影，但没有 emitter

- **类型**：系统协议顺序 + 计划遗漏。
- **证据**：Spec/设计把 draft_opened 定为权威事件，原 Task 7 从事件折叠 lifecycle，Task 13 只做私有 get-or-create，Task 17 只笼统说创建 Draft；EventStore 不会隐式生成事件。
- **失败场景**：Draft 私有文件已创建后崩溃，事件历史没有 opened，后续出现 terminal-without-opened，projector/recovery 无法闭合。
- **最小修订**：推荐 fill 的 attempt_started + draft_opened 同 start batch，随后才物化私有 Draft；覆盖两侧崩溃。

### P1-4｜私有 Proposal/Draft terminal 与 TaskEvent 被描述为跨目录“原子”

- **类型**：系统事实源 + 计划可执行性缺口。
- **证据**：journal/checkpoint 与 events 是不同目录；现有 atomic-file 一次只发布一个目标，EventStore 也只事务化事件目录；原计划同时要求 private terminal 与权威 batch “appear together”。
- **失败场景**：private terminal 先写会留下无权威提交的 merged/committed；batch 先写会在崩溃时留下仍显示 open 的私有对象。
- **最小修订**：私有 terminal 必须成为 TaskEvent 派生视图；batch 前不写不可逆 terminal，batch 后 cache 只可修复。若坚持双事实源则需真正跨存储 manifest protocol。

### P1-5｜响应丢失重放会因新事件 ID/时间戳产生幂等冲突

- **类型**：Spec/计划算法不完整。
- **证据**：appendBatch 对同 commitId 只接受完全相同 canonical payload；原 Task 15 每次重新从 tail 构造事件，只从 turn + completion kind 派生 commitId，没有先查 commitId 或稳定 prepared bytes。当前 EventStore canonical payload 包含完整事件 `id/at`。
- **失败场景**：第一次 batch 已成功但响应丢失；重试生成新的 ID/时间戳，同 commitId + 不同 payload 在返回原结果前就冲突。
- **最小修订**：用稳定 completion signature 派生 commitId，构造易变事件前先按 commitId 查询；winner/loser 比较已提交稳定字段，测试推进时钟并替换随机源。

### P1-6｜Task 18 扩展必需 Gateway 方法，却遗漏非 HTTP 完整实现

- **类型**：计划文件责任与中间编译缺口。
- **证据**：`ForgeCoreGateway` 方法全部必需；HTTP factory、MockGateway、`test-support` 都构造完整接口。原 Task 18 只列 interface 与 HTTP 文件。
- **失败场景**：增加五个必需方法后，MockGateway 和 test stub 立即 TS2739/TS2740，Task 自己的 `npm run check` 失败。
- **最小修订**：把 Mock、test-support、shared gateway contract/test 全部加入 Task 18，不得用 optional 方法掩盖。

### P2-1｜TurnContract v3 union 与现有消费者缺少收窄迁移

现有 TaskRunner/ActionCommitter 直接访问 `contract.production/annotate`；原 Task 5 只修改 template 文件，按新 union 会 TS2339。应加入显式 type guard 和现有消费者/测试，不能给 v3 伪造 optional basic 字段。

### P2-2｜目录级依赖图与真实 `TaskStore -> template` 相反

当前 `src/server/storage/task-store.ts` 直接依赖 Loader/Schema/Catalog；不能再把整个 storage 目录声明为 template 下游的纯低层。应区分 storage primitives 与 application adapter，避免新 direct cycle。

### P2-3｜profile benchmark 缺少可复现环境协议

原 Task 9 没有记录 Node/V8、OS/arch、CPU/RAM、lock digest、warmup/sample 或方差判定，可能在不同机器冻结不同 hard ceiling。证据必须带完整 reference runner 和统计元数据。

### Reviewer 已核实而不构成 finding 的接缝

- EventStore 已有 per-task queue 与全量扫描，Task 6 的 batch/CAS 扩展点真实存在；material 缺口只有调用方 replay payload。
- Loader/containment、Pi runtime toolCallId、ArtifactStore event-backed custody、structured human answer、basic v2 compatibility 和最终 Runner/Scheduler/CoreService 组装都有现有接缝或明确任务所有者。
- Task 18 的 API/CoreService/UI 总体有落点，唯一 material 漏口是完整 Gateway 实现集合。

**Round 1 verdict：`REVISE`**

### 主 Agent 对 Round 1 的处理

6 个 P1 全部接受；3 个 P2 也全部修订，不以“实现细节”为由后置：

1. Task 2 精确锁定 `re2-wasm@1.0.2`，新增独立 safe-regex wrapper、package/lock 与方言/ReDoS/Unicode/复杂度测试。
2. 新增 exact runtime capability manifest：Task 5 默认 disabled 并接 Loader/Catalog；Task 17 接 Scheduler；Task 19 在注入能力下先完成 qualification evidence，再执行唯一 production enable，随后用 production default 重跑全量验证。
3. 主设计与 Spec 冻结 fill start batch 为 `attempt_started + draft_opened`；draftId 由 turnId 派生，batch 后才物化私有 Draft，崩溃可重建。
4. Proposal/Draft journal 不再拥有 lifecycle terminal；权威事件决定 committed/merged/stale/abandoned，任何 post-batch cache 都可删除、可修复。Task 7/11/13/15/17 增加两侧 crash 测试。
5. EventStore 增加 `readBatchByCommitId`；Task 15 使用 candidate/receipt/dispatch 的 stable completion signature 派生 commitId，并在状态校验和事件构造前 pre-read，竞态 loser 复核 winner。
6. Task 18 纳入 MockGateway、test support 和共享 gateway contract/test，五个新方法保持必需。
7. Task 5 同时迁移 TaskRunner/ActionCommitter 到显式 v2/v3 type guard；Task 4/5 重新切边，避免在 v3 parser 形成前出现半合法完整 structured fixture。
8. Spec/计划把目录级依赖改为职责级依赖，明确 `TaskStore` 是 application adapter；Task 9 冻结可复现 benchmark evidence schema。

完成回写后只交给同一个 reviewer 做 Round 2；在其批准前仍不实现代码。

---

## Round 2 — Same independent reviewer

同一 reviewer 重新读取修订后的设计、Spec、开发计划与基线代码；扫描达到时间上限后，只基于已确认的证据收敛报告，没有继续扩大范围。现有 `npm run check` 与 TaskStore/Loader 定向 73 项测试通过，只证明当前 basic 基线健康。

Round 1 closure：P1-1 safe-regex、P1-3 draft emitter、P1-4 private terminal、P1-5 replay、P1-6 Gateway、P2-1 narrowing、P2-2 dependency 均 `CLOSED`；P1-2 readiness 因 TaskStore 接缝仍 `OPEN`；P2-3 benchmark 因冻结时机与 dirty source 仍 `OPEN`。

本轮无 P0；确认 6 个 P1、2 个 P2：

### P1-1｜capability 未贯通 TaskStore 创建与快照复验

- **代码证据**：`TemplateCatalog` 和 `CoreService` 只接 `CorePaths`；`TaskStore.publishTaskDirectory()` 在 `src/server/storage/task-store.ts:398–425` 用默认 Loader 重开 snapshot。
- **失败场景**：Catalog 使用 injected-enabled environment 成功，但 TaskStore reopen 又读取 disabled default，structured task 仍创建失败；已知但 unavailable 的模板还会退化成 `TEMPLATE_NOT_FOUND`。
- **处理**：接受。Task 5 纳入 TaskStore/CoreService/test；冻结单一 `{ capability, profile }` environment，贯穿 Loader/Catalog/cache/TaskStore/Scheduler，并保留 exact availability diagnostic。

### P1-2｜Pi 在 execute 前校验，schema-invalid Slot 调用无法计费

- **代码证据**：锁定 Pi 0.82 的 `agent-loop.js:393–445` 在 Tool execute 前执行 TypeBox；现有 callback 只能在 execute 获得 toolCallId。
- **失败场景**：模型持续发送缺字段/错类型调用，session service 永远看不到，Attempt 工具额度可无限绕过。
- **处理**：接受。Task 14 增加 `forge-pi-slot-preflight/v1`：直接订阅底层 Agent 可等待的 raw `tool_execution_start`，在 SDK 校验前持久化 precharge；execute 只消费 precharge。真实锁定 SDK 测试覆盖 invalid、unauthorized known name、改参、截断、合法重放和超限，全部 Slot Tool sequential。

### P1-3｜profile 在真实 Seal/custody/projection 前冻结

- **证据**：原 Task 9 要测 64 MiB Seal/500 issue/batch recovery，但真实投影到 Task 10、Seal/custody 到 Task 16 才实现；Task 19 不重跑 benchmark。
- **失败场景**：stub/primitive profile 通过，最终路径因复制、序列化或 custody 超过 wall/RSS，仍可被 enable。
- **处理**：接受。Task 9 只提交 harness + provisional candidate；Task 19 从 clean checkpoint 运行真实 integrated benchmark，写 final profile/evidence 后才可 promotion。

### P1-4｜Task 19 clean-tree promotion 按原顺序必然失败

- **代码证据**：原 Step 5 要求 clean，但 Task 19 全部实现直到 Step 9 才提交；`verify-backend.ts` / `verify-runtime.ts` 还会改 tracked `public/development-evidence.json`。
- **处理**：接受。Task 19 改为两次提交：先在 disabled/provisional 状态提交全部实现、测试、脚本和文档；从 clean tree 只生成 final profile JSON、两份 evidence 与 manifest，production rerun 后只提交这四个生成物。

### P1-5｜`verify:runtime` 的 gitignored basic-only 报告不能证明 structured Pi

- **代码证据**：`.gitignore` 忽略整个 evidence 树；`verify-runtime.ts` 缺报告即失败但不核 commit/digest；现有 `pi-runtime-probe.ts` 只检查 basic v1 工具边界。
- **处理**：接受。stateful `verify:backend/runtime` 不再充当 structured 离线 release gate；完整 unit/e2e 与真实锁定 Pi deterministic pre-validation characterization 的 exit/package/lock/source digest 直接写入 release evidence。真实 provider probe 保留为独立产品证据，不复用旧 ignored 文件。

### P1-6｜UI/API 没有 AccessProfile 主体映射

- **代码证据**：TaskRecord/API context 没有 owner/principal；contract 只有 Agent accessProfiles，原计划却引用未定义的 “task-owner visibility profile”。
- **失败场景**：多 profile 时任意选一个会误隐藏，合并全部会破坏 Agent ACL，Task 18 无法写确定授权测试。
- **处理**：接受。v1 明确为本地单用户：投影服务使用判别 subject；Agent 只认 Grant/AccessProfile，UI/API 固定为内建 `task_owner` 完整只读审计视图，仍排除 private/Grant/源码/secret。远程多用户必须另行版本化 auth/principal。

### P2-1｜benchmark evidence 指向未提交 harness

- **处理**：随 P1-3/P1-4 闭合。Task 9 先提交 harness；Task 19 从 clean checkpoint 运行，证据记录 HEAD/source/lock/designated-runner digest，只允许生成物变脏。

### P2-2｜Task 11 会产生不可编译的中间提交

- **代码证据**：`AgentTurnInput.slotSession` 被要求为必填，但原 Task 11 未纳入 `task-runner.ts:766–779` 与 `runtime/test-support.ts:150–184`。
- **处理**：接受。Task 11 同时修改 Agent runtime/test、TaskRunner/test 和 shared runtime fixtures；所有 basic input 显式传 `slotSession: null`，不以 optional 字段绕过迁移。

### 主 Agent 补充接缝

主审另确认 Task 5 给 `FrozenTemplate` 增加 required `productionMode/structuredSlots` 会使 `runtime/test-support.ts` 的手工 fixture 失配；该文件已并入 Task 5，basic fixture 显式使用 `basic/null`，不把 normalized 类型改成 optional。Task 5 的测试注入也从单独 capability 改为匹配的 capability + profile，避免 Task 9 前出现隐式 hard-ceiling fallback。

**Round 2 verdict：`REVISE`**

全部 finding 已按推荐方向回写。下一轮仍由同一个 reviewer 验证 P1/P2 closure，并检查两阶段 qualification、raw Pi precharge、owner projection 与逐任务编译边界是否自洽；批准前不实现代码。

---

## Round 3 — Same independent reviewer

同一 reviewer 完整重读主设计、Spec、19-task 开发计划、前两轮记录、当前项目接缝和锁定的 Pi 0.82 实现。结论：无新增 P0、P1 或 P2；Round 2 的 6 个 P1、2 个 P2 以及主 Agent 补充接缝全部 `CLOSED`。

### Round 2 finding closure

1. **TaskStore runtime environment：CLOSED**。Spec 与 Task 5 已把同一不可变 `{ capability, profile }` 贯穿 Catalog、cache reopen、TaskStore snapshot reopen、CoreService 与 Scheduler，并保留 exact `TEMPLATE_RUNTIME_UNAVAILABLE`。这覆盖当前 `TaskStore.publishTaskDirectory()` 直接使用默认 Loader 重开的真实断点。
2. **Pi schema-invalid 预收费：CLOSED**。Pi 0.82 的 `AgentSession.agent` 是公开接缝；sequential/parallel 与 truncated 路径都会在 tool lookup 和 TypeBox 校验前 `await emit(tool_execution_start)`，Agent 又会按订阅顺序 await listener promise。Spec/Task 14 的 raw precharge 因此可实际实现。
3. **profile 冻结时机：CLOSED**。Task 9 只产生 provisional harness/profile；未来模块通过 `IntegratedBenchmarkCasesV1` 注入，不做前向静态导入。Task 19 才用真实 projection、Seal、Assembler、custody 与 recovery 冻结 final profile。
4. **clean-tree promotion：CLOSED**。Task 19 先提交 disabled/provisional 的完整实现，再从 clean checkpoint 生成 profile JSON、profile evidence、release evidence 和 capability manifest；最终 staged-name audit 只允许这四个文件。
5. **structured Pi 证据：CLOSED**。会修改产品 evidence 或消费 gitignored basic-only report 的现有 verifier 被排除；锁定 SDK characterization 与 hermetic 命令结果直接进入 release evidence。
6. **UI/API principal：CLOSED**。投影主体冻结为 Agent Grant 或本地内建 `task_owner`；REST 不接受客户端传 profile/principal，多用户认证明确不在 v1 范围。
7. **benchmark clean source：CLOSED**。Task 9 先提交 harness/reference runner；Task 19 从 clean checkpoint 运行并绑定 HEAD、source、lock 与 runner。
8. **required `slotSession` 中间编译：CLOSED**。Task 11 同时覆盖 Agent runtime、TaskRunner、shared test-support 与 Pi probe；basic 构造全部显式传 null。

### 补充接缝复核

- Task 5 已覆盖手工 `FrozenTemplate` fixture，并要求 required `productionMode: 'basic'` / `structuredSlots: null`，没有用 optional normalized 字段规避迁移。
- 测试注入是匹配的 capability + final-shaped profile，不是单独 capability。
- Task 19 将 phase-pinned 单测转换为显式 fixtures，disabled/provisional 与 enabled/final 两阶段复用同一测试源码。
- digest 依赖方向可以保持无环：profile evidence → final profile → release evidence → capability manifest。

### 只读验证

- `npm run check`：通过。
- Template/TaskStore 定向基线：114 项测试通过。
- 这些结果只证明当前 basic 基线健康，不替代未来 Task 19 qualification。

**Round 3 verdict：`APPROVED`**

### 主 Agent 的批准后明确化

reviewer 另给出两项不构成 finding、但可能让实现者产生分支选择的提示。主 Agent 选择把它们显式写入计划，减少开发期临场推断：

1. Task 14 直接纳入 `runtime/test-support.ts`，明确生产 raw-Agent subscription seam 与现有 session-level subscriber 不是同一边界；若扩展 `PiSessionHandle`，同一任务必须更新 `ScriptedPiSession` 并保持 basic 不变。
2. Task 19 直接纳入 `core-service-live.test.ts`，若 Task 17 在其中增加 checked-in-disabled 断言，promotion 前必须改为显式 phase fixture。
3. Spec、设计与 Task 19 明写单向摘要链 `source/runner -> profile evidence -> final profile -> release evidence -> capability manifest`，禁止下游 digest 回指和自引用。

这些变更不改变已批准协议；为保证最终文档就是 reviewer 看过的版本，仍交给同一个 reviewer 做一次窄范围 Round 4 复核。

---

## Round 4 — Narrow review of approval hardening

同一 reviewer 只读复核 Round 3 后的三处明确化，没有重新扩大全仓扫描。`core-service-live.test.ts` phase fixture 责任与单向 digest chain 均闭合；无 P0/P1，确认 1 个 P2。

### P2-1｜Task 14 漏掉 probe 中的另一份 `PiSessionHandle` 手工实现

- **代码证据**：除 `runtime/test-support.ts` 的 `ScriptedPiSession` 外，`scripts/pi-runtime-probe.ts:209–226` 也显式构造一个 `PiSessionHandle` wrapper，只转发原 session-level subscribe/abort/dispose/compaction。
- **失败场景**：Task 14 把 raw-Agent seam 设为 required 并更新默认 factory、ScriptedPiSession 后，probe wrapper 不再满足完整接口。主 `tsconfig.json` 又排除 `scripts/`，Task 14 的 `npm run check` 可能假绿。把 seam 改成 optional 只会把缺少安全预收费边界推迟到运行时。
- **处理**：接受。Task 14 文件表、实施步骤与提交命令加入 `scripts/pi-runtime-probe.ts`；raw seam 保持 required，默认 session、ScriptedPiSession 和 probe wrapper 三处均必须实现，probe 显式转发底层 awaited Agent subscription。

**Round 4 verdict：`REVISE`**

修订后只让同一 reviewer 核验该 P2 closure；不再改变协议或扩大范围。

---

## Round 5 — Final narrow closure

同一 reviewer 只读检查 Round 4 的单点修订，没有扩大范围。Task 14 现已在文件表、实施步骤和提交命令中完整覆盖 `scripts/pi-runtime-probe.ts`；raw-Agent seam 保持 required，并明确由生产 factory、`ScriptedPiSession` 与 probe wrapper 三处实现。当前两个手写 `PiSessionHandle` 实现均有任务所有者，主 tsconfig 排除 scripts 的现实也已在计划中显式处理。

审查确认：无新增 material P0、P1 或 P2；`git diff --check` 对计划无输出。全程只读，reviewer 未修改仓库。

**Round 5 verdict：`APPROVED`**

最终结论：基于当前 Forge Core 项目结构、锁定依赖和现有测试入口，Spec 与 19-task 开发计划具备真实落地路径。批准不代表功能已经实现；生产 capability 仍必须按 Task 19 的 integrated benchmark、恢复/安全验收、basic 全回归和两阶段 promotion 协议才能启用。

---
