# Forge Core 结构槽引擎：对抗式设计审查记录

> 状态：**APPROVED / 已批准**
> 开始日期：2026-08-10
> 批准日期：2026-08-10
> 最大轮数：5
> 审查对象：[`STRUCTURED-SLOT-ENGINE-DESIGN.md`](./STRUCTURED-SLOT-ENGINE-DESIGN.md)
> 规则：独立 reviewer 只读仓库；存在 P0/P1 系统设计问题即 `REVISE`；只有没有 material finding 才能 `APPROVED`。在批准前不编写 spec、dev plan 或代码。

---

## Round 1 — Independent reviewer

本轮首次执行超过 10 分钟审查上限后被主 Agent 中断；随后同一个 reviewer 只基于已经完成的证据核对收敛 material findings，没有换 reviewer 或重新扫描以降低审查标准。

### P1-1｜首次 structure session 无法构造当前定义的 SlotGrant

- **证据**：首次结构流程发生在 active scaffold 创建前（主设计原 5 节），但原 `SlotGrant` 强制包含 `scaffoldId`、`baseRevision`，并声明为基于 active scaffold 生成；structure session 又固定 `accessProfile: null`。
- **失败场景**：首个 structure 工具无法授权，或实现者被迫伪造 scaffold/revision，产生两套权限语义。
- **缺口**：没有说明 structure 不使用 SlotGrant，也没有无 scaffold 的 grant 形态。
- **建议**：把 grant 改为按 session kind 判别的联合；structure 绑定 snapshot/turn/agent/proposal，fill/seal 才绑定 scaffold/revision/profile。

### P1-2｜capability 矩阵允许静态加载永远无法完成的 structure 节点

- **证据**：原 Loader 只要求 capability 是 kind allowlist 子集并包含 completion capability，因此 `{ submit_structure_proposal }` 可以加载；但首次 Proposal 必须先读取契约并写入整树。
- **失败场景**：模板加载成功，运行时却没有构造 generation 所需的写能力。
- **缺口**：只有最大 allowlist 和单个 completion capability，没有最小可完成集合。
- **建议**：冻结每个 kind 的 required capability set；至少 structure 需要 read-contract、write-proposal、submit-proposal。

### P1-3｜`turnId === ActionAttempt` 与 stop/crash/resume 身份语义冲突

- **证据**：原设计称 retry 产生新 turnId、旧 Proposal/Draft abandoned；当前 `task-runner.ts` 的 turnId 主要由同 input 的 `agent_attempt_failed` 数量派生，而 stop/abort 不追加 attempt failure，进程恢复只追加 `task_interrupted`。
- **失败场景**：Draft 已写或 candidate 已冻结后 stop/crash，resume 复用 turnId；实现无法唯一决定恢复旧私有状态还是按取消规则 abandoned。
- **缺口**：没有区分 provider session、逻辑 Attempt、stop、process crash、retry 和 human answer 的身份转换。
- **建议**：冻结显式 attempt epoch/state machine，说明何时新 turnId、何时 abandon，以及 receipt 是否能重注入。

### P1-4｜首次私有变更后的人工升级禁令会制造无合法出口的 turn

- **证据**：原设计在首次 replace/unset/submit/request-seal 后永久禁止 `request_human_input`；candidate 前无其他完成 dispatch，Gate 失败却保持 Draft open，隐藏错误还可能只能投影为 operation issue。
- **失败场景**：Agent 写入后才发现需要人工信息、隐藏错误或 evaluator unavailable；既不能形成 candidate，也不能进入 waiting-human。
- **缺口**：“不让私有草稿跨 turn”不等于必须关闭人工出口，缺少安全放弃后升级人工的协议。
- **建议**：允许 `abandon private state/candidate + request_human_input` 原子中断，并把 abandonment、Agent result、human request 放进同一 batch。

### P1-5｜`artifactSchema.required` 在 create/annotate 两阶段没有唯一语义

- **证据**：现有 schema 允许 `required: true, phase: annotate`；结构槽 Assembler 只生成 create 文件，Seal 又校验 manifest 与 artifactSchema，annotation 明确只能 Seal 后追加；当前 final-submit 没有 required-file 完整性检查。
- **失败场景**：一种实现会因 required annotation 尚不存在而永远无法 Seal，另一种会忽略它并允许最终提交缺少 required annotation。
- **缺口**：没有 phase-aware required 检查点，也没有禁止 required annotation。
- **建议**：structured mode 禁止 required annotation；或另行定义 final submission 对全部 required 文件的完整门禁。

### P1-6｜冻结的 Slot Schema v1 对 `multipleOf` 自相矛盾

- **证据**：精确 number/integer 白名单不包含 `multipleOf`，非白名单关键字必须拒绝；25.2 B01 却规定了 `multipleOf` 的合法值域。
- **失败场景**：不同 Loader 对同一模板给出接受/拒绝两种结果，snapshot 语义分裂。
- **缺口**：两段都自称冻结，无法推导优先级。
- **建议**：将其加入白名单与测试，或删除 B01 中的 v1 语义。

### P1-7｜validator 只有单项预算，没有一次 Gate 的聚合资源上限

- **证据**：原 validation limits 只有 `maxIssuesPerRun`；每个 validator 各自有 CPU/timeout/memory 预算，而 Seal 必须运行全部适用 validator；没有 validator 数量、调用次数或整个 Gate 的聚合 CPU/wall/output 上限。
- **失败场景**：模板注册大量各自合法的 validator，最坏时间为调用数乘单项 timeout，长期占据全局执行槽；全部局部 limit 合法但系统仍被耗尽。
- **缺口**：单实现 hard ceiling 无法推出整个 Gate 的封闭上界。
- **建议**：冻结 validator 数量、每 Gate 调用数和聚合 CPU/wall/output 预算；明确串行执行下的 peak memory 口径和超限 verdict。

### Reviewer 认定不是问题的接缝

- advisory 的可靠拒绝允许 `passed + warning`，异常/超时仍 `incomplete`，语义闭合；
- “先 promote、后 batch 显形”已经明确取代旧提交顺序；
- Seal 后不得回 v3、annotation 不改 SealRecord 的边界已经闭合。

**Round 1 verdict：`REVISE`**

### 主 Agent 对 Round 1 的处理决定

七项全部接受为系统设计问题，不下放给 dev plan：

1. 使用 `StructureSessionGrantV1 | FillSessionGrantV1 | SealSessionGrantV1` 判别联合，禁止 structure 伪造 scaffold 身份；所有分支绑定 snapshot，fill/seal 另绑定 access profile/scaffold/revision。
2. 冻结 kind 级 required capability set；structure/fill 必须具备真正完成业务所需的读写提交能力，seal 明确允许只有 request-seal 的机械完成节点。
3. structured v3 引入按 inputNode 持久化、单调递增的 attempt epoch；stop/crash/retry 后同 input 使用更高 epoch，human answer 生成新的 confirmed input，所有路径一律使用新 turnId、旧私有对象 abandoned。basic v2 的既有 partial replay 不改。
4. 允许任何完成 dispatch 前执行“原子 abandon + human request”；私有 Proposal/Draft/candidate/staging 不跨 human turn。
5. v1 structured mode 选择更窄方案：`phase: annotate` 必须 `required: false`；Seal/final submission 只以 required create 为交付完整性，不把 sidecar 伪装成审核协议。
6. 删除 `multipleOf` 的 B01 语义；v1 继续不支持该关键字。
7. validation limits 扩为 validator 数量、每 Gate 调用数、aggregate CPU/wall/output 与总 issues；validator 严格串行，因此 peak memory 由单调用预算约束。

### Round 1 回写核对

七项已回写主设计，而不是下放给实施计划：

- M01：10.3、10.4、25.3、25.11；
- M02：11.4、25.7、25.10、25.11；
- M03：11.5、13、18、25.6、25.7、25.11；
- M04：11.3、11.4、13、25.7、25.10、25.11；
- M05：6、16、17、25.9、25.11；
- M06：7.3、25.2、25.11；
- M07：7.6、14.5、19、25.4、25.11、25.13。

全文旧结论和历史清单中的 superseded 关系也已同步。下一步只提交给**同一个 reviewer** 做 Round 2；在其 `APPROVED` 前不编写 spec、dev plan 或代码。

---

## Round 2 — Same independent reviewer

要求逐项验证 P1-1～P1-7 是否真正闭合，并继续搜索回写引入的新 P0/P1 问题；不得因已经投入回写成本而降低批准标准。

### P1-8｜人工回答仍可能产生“已回答但没有新 input”的半状态

- **证据**：Round 1 回写只原子化了 `abandon + human request`；主设计要求回答产生 fresh confirmed input，但未冻结回答提交边界。当前 `task-scheduler.ts` 仍用两次随机 ID 的单事件 append 写 `human_answered`、再写 `agent_input`，既有 half-state repair 只覆盖带 decision 的 progress-guard。
- **失败场景**：进程在两次 append 之间崩溃，pending question 已被 `human_answered` 清除，新 input 却不存在；普通 answer 重试因 task 不再 waiting-human 被拒绝，任务永久丢失继续执行入口。
- **建议**：structured answer 使用 pending request ID 派生的稳定 commitId，在一个 `appendBatch` 中提交 `human_answered + fresh agent_input`；相同回答幂等重放、不同回答冲突。

### P1-9｜Loader 没有证明首次 scaffold 一定先于 fill/seal

- **证据**：当前 scheduler 永远把初始输入交给 pipeline 第一个 Agent；Round 1 回写只验证单节点 capability/dispatch 与 Seal 后 no-backedge，没有定义 scaffold 状态的数据流。Fill/Seal Grant 又都要求 active scaffold。
- **失败场景**：结构合法的模板把 fill 或 seal 声明为首节点，或某条 Route 绕过 structure；Loader 接受，首次运行却永远无法签发 Grant。
- **建议**：冻结 pipeline scaffold typestate；当前首节点必须 structure，并对全部 Route 做 dominance/dataflow 校验，使 committed structure 支配 fill/seal、committed Seal 支配 Seal 后 v2。

### P1-10｜Seal Gate 可靠失败后没有机器返工 Route

- **证据**：端到端主流程声明 Seal 失败回到填充，但 seal session 原矩阵只有 candidate 后的 publish/final-submit，失败时没有 candidate；seal 又无写能力且不允许 send_message。人工回答只会把 fresh input 送回同一 seal Agent，人类/UI 也不能直接改槽。
- **失败场景**：required content、全局 blocking validator 等 Seal-only 检查可靠拒绝后，seal Agent 既不能修改 content，也不能通知 fill/structure，任务只能原地重试或停车。
- **建议**：可靠 `failed` 形成 seal rework receipt，只允许 `send_message` 到 v3 fill/structure 并保持 `active_unsealed`；`incomplete` 不得伪装成内容返工，只能重试/runtime retry/human。

**Round 2 verdict：`REVISE`**

### 主 Agent 对 Round 2 的处理决定

三项全部接受，不下放给实施计划：

1. N01：structured v3 的模型人工回答以 pending request ID 作为幂等身份，把 `human_answered` 与 fresh confirmed `agent_input` 放进同一 answer batch；同 answer 重放，不同 answer 冲突。basic v2/progress-guard 保持既有协议。
2. N02：增加 `no_scaffold | active_unsealed | sealed` 三态 pipeline 数据流；首节点必须 structure，Loader 校验所有可达边与 join，运行时在节点启动、Grant 签发和提交时复核。
3. N03：Seal Gate reliable failed 生成 turn/revision-bound rework receipt，ActionCommitter 只允许原子 send 到 v3 fill/structure，phase/revision 不变；incomplete 不生成返工 receipt。

回写位置：主设计 7.5、11.5、11.6、18.3、22、23、25.6、25.7、25.10、25.12、26。完成后继续由同一个 reviewer 执行 Round 3。

---

## Round 3 — Same independent reviewer

reviewer 复核确认 P1-1～P1-10 的原失败场景均已闭合，但发现新的累计资源缺口。

### P1-11｜单次 Gate 有界，但同一 Attempt 累计工作量无界

- **证据**：M07 的 validator 上限全部以“每 Gate”为口径；N03 又明确允许 incomplete 后用新 toolCallId 在同一 Attempt 重跑 `request_seal`。当前 Pi runtime 开启自动 compaction，Forge 侧没有 Turn deadline/step cap，平台还是全局单执行槽。
- **失败场景**：模型反复调用 request-seal 或建议性 validate；每次都合法消耗完整 Gate 预算，却永不结束 Attempt，长期占据全局执行槽。compaction 还允许该循环持续。
- **建议**：冻结 per-Attempt/Turn 硬包络，至少覆盖 Gate/Slot Tool 次数、累计 validator CPU/wall/output 与总 wall-clock；超限后原子终结 Attempt 并禁止继续工具。

**Round 3 verdict：`REVISE`**

### 主 Agent 对 Round 3 的处理决定

接受为 N04，不下放给实施计划：

- limits 新增 attempt 组，冻结 Slot Tool/validation 次数、validator invocation/CPU/wall/output 与 Attempt 总 wall-clock；只有同 key/同参数且直接返回缓存结果的幂等重放不重复计数，新 toolCallId、同 key 换参数、失败调用和 compaction 都不能绕过或重置 meter。
- 每次 validation run 先检查剩余 Attempt 包络，运行中扣减实际资源；任一 Attempt 上限超限时 abort provider/sandbox、废弃私有状态，并原子写 `RESOURCE_LIMIT_EXCEEDED + failed/runtime_failure`。该 Attempt 不能继续工具、dispatch 或 human。
- 最终模板 limits 从 M07 的六组二十一项扩为七组二十八项。

回写位置：主设计 7.6、11.5、20–23、25.4、25.6、25.7、25.12–25.13、26。

---

## Round 4 — Same independent reviewer

本轮从磁盘重新核对 N04 与此前全部 finding；达到 10 分钟审查上限时仍在运行，主 Agent 按既定上限中断。中断前没有报告新的 P0/P1，但也没有把“未报告”视为批准。

**Round 4 verdict：无 verdict（超时中断）**

---

## Round 5 — Same independent reviewer

同一个 reviewer 只基于 Round 4 已完成的阅读与证据做最终收敛，不重新降低标准或另换 reviewer。最终确认：

- N04 的七项 per-Attempt 包络、调用签名计数、跨 Gate validator 累计、主动 wall deadline、持久化 meter 和超限原子终止已经闭合“同一 Attempt 无限占用”的失败场景；
- P1-1～P1-7 的 Grant、capability、Attempt 身份、人工出口、annotation、Schema 与 Gate 聚合预算原失败场景均已闭合；
- P1-8～P1-10 的 answer batch、pipeline typestate 与 Seal rework 原失败场景均已闭合；
- 剩余计量原子预留、timer/abort 竞态实现和基准值冻结属于 spec/dev plan 中可验证的工程问题，不需要新增系统设计选择。

**Round 5 verdict：`APPROVED`**

本批准只表示当前系统设计没有尚未闭合的 material P0/P1；不替代后续 spec、dev plan、实现测试或基准验证。
