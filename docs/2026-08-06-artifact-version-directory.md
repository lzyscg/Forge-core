# 产物版本目录制（Artifact Version Directory）设计规格 v7（定稿）

> 状态：**v7 定稿**。第六轮对抗审查确认**已收敛、无阻断、可进入实施**；本版折入第六轮 4 条低危加固（§11 兜底/崩溃自愈/accept 复校验、§4/§13/§15 协调回合表述统一）。
> v5/v6 已确认收敛（保留）：生产/操作分离、forward_input_version、输入版本传播、annotate staging、send_message 简短 body、§11 快乐路径（第四轮验证成立）、dispatchKind、legacy transform、staging 认领、annotate 自排除、supersede+synthesize 人工介入（第六轮验证成立）。
> v6 变更：人工介入升级为「supersede + synthesize」统一机制，解第五轮两阻断（accept 悬空输入 / continue 引导无通道）；补 humanAuthorized 字段与封闭性论证；accept 零版本边界；waiting_human 来源判别；dispatch-only Agent 推导；production.sources 恢复；多 pending 处置。

---

## 1. 设计原则（v6，同 v5）

1. 一个版本 = 一个目录。
2. 生产 vs 操作分离。
3. 版本目录创建后 immutable；标注一次性原子追加。
4. 事件流是版本唯一权威。
5. 输入版本沿路由传播。
6. 产物=内容载体；消息=协调信号。
7. 版本数 = 内容修订次数。
8. 新事件字段向后兼容。
9. 人工介入是结构化决策（继续/接受/停止），经「supersede + synthesize」机制落地。

---

## 2. 版本目录结构（v6，同 v5）

- `artifacts/vNNN/{content.md|content.txt, revision.md?, review.md?, meta.json}`；meta 含 id；正文扩展名按 format。
- review.md：frontmatter verdict；结构校验在工具层；verdict 语义只 controller 消费；产物链展示是展示层行为。

---

## 3. 模板声明：artifactSchema + route.inject

### 3.1 artifactSchema（同 v5）：files 带 name/required/producer/extract/phase；FrozenTemplate 持 schema；annotate file 双校验。

### 3.2 输入版本传播 + route.inject（同 v5）：version: input 锚定输入节点 inputVersion；执行期解析不物化。

### 3.3 inject 边界决策表（同 v5）。

---

## 4. 回合分类与动作（v7）

- **生产回合**（writer）：`finish_production(files)` → `publish_artifact`。
- **操作回合**（reviewer）：`[read_artifact_version / annotate_artifact]` → 一个 dispatch。
- **协调回合 = 退化操作回合**（controller，v7 低 D 统一表述）：仅 dispatch 段、无 production、无 annotate；不做生产/标注，直接 dispatch（send_message 分配 / submit_final_artifact 提交）。ActionBuffer 形态上它是不含 read/annotate 的退化操作回合。
- dispatch 动作全集五个：publish_artifact（仅生产回合）/ send_message / forward_input_version / submit_final_artifact / request_human_input。操作/协调回合从后四者选其一。
- request_human_input：生产/操作/协调回合均可中断（F7 翻转，列翻转清单）。
- 阶段机：production 阶段 load_skill/workspace/read/annotate；封存仅 finish；需上下文校验在工具层/committer。

---

## 5. 工具面（v6，同 v5）：注册表 6→9。

---

## 6. 版本权威、唯一性与原子性（v6，同 v5）

- 版本号=已提交 artifact_published 事件数+1；生产时序 staging→事件→rename；读窗口容忍。
- annotate staging→事件→rename；唯一性 + 重放自排除。
- staging 认领：artifactId 优先、contentHash 退回、多同哈希取一、冲突判 CORRUPTED、清理孤儿。
- 盘↔事件交叉校验：ArtifactStore 注入 EventStore。
- **committer 重放点触发认领（解低 3）**：`publishSealedPackage` 重放分支遇「事件在、目录无」时触发 §6 认领补 rename，不直接 read。

---

## 7. 可达性闭包（v6，humanAuthorized 落字段）

- 正常 submit：从版本 producer 沿已提交 route_executed(**artifact**) 走到提交者，用 agent_result.inputNodeId 连接「输入→消费结果」跳；新任务 fail-closed。
- **forward 边类型对齐（解中 3）**：forward 沿 **artifact 边**路由（long-form-hub 重写时把 reviewer→controller 改为 artifact 边）；forward 复用 artifact 路由 kind，**不引入新 route kind**；forward 产生的输入是 operate 输入，runner 按 inject 供料、**不触发产物全文 hand-off 分支**。
- **人工 accept 放宽**：accept 下 controller 直交，校验：版本存在 + producer 合法 + controller 是声明 submitter + **humanAuthorized==true**。humanAuthorized 是**明示例外**，文档化。

### 7.1 humanAuthorized 字段定义 + 封闭性（v6 新增，解高 1）

- **字段**：合成 agent_input 节点的 EventNode 可选字段 `humanAuthorized: boolean`（进 §8.1 字段表）。
- **封闭性论证**：
  - **唯一写入主体**：仅 task-scheduler 的 accept 合成路径可置 `humanAuthorized: true`；
  - committer 的 node 构造器（现有 `node()`）**永不置位** humanAuthorized；
  - 模型动作参数面（send_message/forward/submit 的 TypeBox schema）**不含** humanAuthorized 键，且 FORBIDDEN_ACTION_KEYS 拦截模型携带；
  - legacy/旧事件无此字段 → 归一 false。
- 于是「模型伪造 humanAuthorized」在规格层被排除：它只能通过平台 accept 路径产生。

---

## 8. 事件与契约扩展（v6，补 humanAuthorized + superseded）

### 8.1 字段变更（v6）

| 变更 | 字段 | legacy 处理 |
|---|---|---|
| 新成员 | `artifact_annotated {version,file,contentHash,turnId,nodeId}` | 旧任务无 |
| artifact_published | contentHash → files[]+artifactType+artifactId | 旧单哈希归一 |
| agent_result 节点 | +inputNodeId + dispatchKind | 缺→null |
| 输入节点 | artifactVersion → inputVersion | 归一 |
| **输入节点** | **+ humanAuthorized(可选)** | 缺→false |
| **新成员** | **`pending_inputs_superseded { supersededNodeIds[] }`** | 旧任务无 |
| task_incompatible | reason + SCHEMA_V2_REQUIRED | 枚举扩展 |

### 8.2 dispatchKind 落地（同 v5）：agent_result 带 dispatchKind，turnPlanCompleted 据此选扇出；**forward 确定性节点 id：`${turnId}-forward-input-0`（解低 1）**。

### 8.3 legacy 归一 transform（同 v5）：读取期仅 artifactVersion→inputVersion；humanAuthorized 缺省 false；写入期强制在 committer/scheduler。

---

## 9. Comitter 规则 + 语义矩阵（v6，同 v5 + forward id）

- 提交序：agent_result(dispatchKind) → [finish/annotate 文件写] → routes → final。
- turnPlanCompleted 按 dispatchKind 判终态；forward 终态 = `-forward-input-0`。
- 语义矩阵五行（publish/forward/submit/send/human）。

---

## 10. 产物链展示（v6，补 superseded 表示）

- ArtifactVersion.files[]；inputText 策略；annotate.nodeId；verdict；旧任务降级。
- **superseded 输入表示（解中 1）**：被 `pending_inputs_superseded` 标记的输入节点，投影/画布渲染为「已作废/跳过」态，不作为 pending；completed 任务的画布不悬空。

---

## 11. 人工介入（v6 重写，supersede + synthesize，解阻断 1/2）

### 11.1 统一机制：supersede + synthesize

guard 超限停车（human_requested，挂**停车时陈旧 pending 输入的接收者**名下，见 11.4）→ waiting_human。人工三选一：

**A. 继续（continue）**：
1. append `human_answered`（归 guard 请求节点 agent，解除 hasUnansweredHumanRequest）；
2. append `pending_inputs_superseded`，标记**当前全部 pending 输入节点**作废（解多 pending，解高 4）；
3. **synthesize 一个新输入节点给「最老被作废 pending 输入的接收者」**，body = 人工引导文本，inputVersion = 该接收者按 §11.3 恢复的版本；
4. runner 恢复后 findNextUnprocessedInput 跳过 superseded，执行合成节点；**引导文本经合成节点 body 进入 inputText**（解阻断 2 的通道问题——合成节点是真实 agent_input 事件，body 即 inputText 来源，无需改既有事件、无序号/归属冲突）。

**B. 接受（accept）**：
1. append `human_answered`；
2. append `pending_inputs_superseded`，标记全部 pending 输入作废（**解阻断 1：陈旧输入不再先执行、不产孤儿版本**）；
3. **synthesize 一个输入节点给最终提交者（controller）**，body = 人工授权文本，inputVersion = 当前最新已发布版本，**humanAuthorized = true**；
4. runner 执行合成节点 → controller read_artifact_version（verdict 可 reject，人工授权优先）→ submit_final_artifact → §7 人工放宽闭包 → 提交；
5. **不再重标注 review.md**（唯一性保护），reject 记录保留，人工接受为明示例外。

**C. 停止（stop）**：复用现有 stop（waiting_human ∈ STOPPABLE）。

### 11.2 supersede 的语义

- `pending_inputs_superseded` 是不可变事件，列出被作废的 agent_input 节点 id；
- findNextUnprocessedInput / collectPendingAgents 跳过 superseded 节点；
- 投影把 superseded 输入渲染为「作废」态（不悬空）；
- 版本数不受 supersede 影响（被作废输入未产出新版本）。

### 11.3 continue 的 inputVersion 恢复规则（v6 明确，解中 4）

- 合成给接收者的 inputVersion = **该接收者最近一次关联版本**，取**最老被作废 pending 输入自身的 inputVersion**（确定性，不推导）；
- 若被作废 pending 输入 inputVersion 为 null（如 writer 首次），合成节点 inputVersion=null，接收者按「无版本」走（writer 靠 workspace + finish→publish 接回）。

### 11.4 guard 停车对象（v6 修正）

- guard 停车时 human_requested 挂**停车时刻陈旧 pending 输入的接收者**（不是最后 dispatch 者）——使 continue 的合成目标与停车对象一致；
- 若停车时无 pending 输入（不应发生，guard 在成功回合后触发必有 pending）→ 挂最后 dispatch 者兜底。

### 11.5 accept 前提（v6，解高 2）

- **零版本 accept**：accept 要求**至少一个已发布版本**；若无已发布版本，accept 选项**不可用**（平台在呈现决策前检查，禁用该项）。
- **waiting_human 来源判别**：human_requested 事件带 `source: progress_guard | agent_request` 字段。
  - `progress_guard` → 呈现结构化三选一（continue/accept/stop）；
  - `agent_request` → 呈现普通回答（现有 answer 流），**不提供 accept**（避免绕过 agent 的提问直交）。
  - 投影/API 暴露来源字段，UI 据此区分。
- **accept 服务端复校验（v7，低 C 防御纵深）**：UI 呈现前已禁用零版本 accept，但 scheduler 的 accept 处理器**仍需再校验一次**「至少一个已发布版本」，防止绕过 UI 直调 API。无版本则拒绝 accept。

### 11.6 兜底与崩溃自愈（v7，低 A/低 B）

- **兜底合成目标（低 A）**：continue 时若无任何被作废 pending 输入（理论不可达——guard 只在成功回合后触发，非终态回合必已提交路由+输入），合成目标**退化为 guard 请求节点 agent**，inputVersion=null（接收者按「无版本」处理）。
- **崩溃半态自愈（低 B）**：提交序固定为 `human_answered → pending_inputs_superseded → synthesize`（此顺序把崩溃半态压向安全方向；反向半态会退化成阻断 1 的孤儿版本）。合成节点用**确定性 id**（由 task + 决策类型推导，非随机）。resume 时检测到「human_answered + superseded 已提交、但合成节点缺失」→ **补合成**（自愈）；若无法自愈则任务 park 为 interrupted 可见，人工可 stop/clone（明示接受该兜底）。

---

## 12. 迁移策略（v6，同 v5）

- 在途 version-1 任务 → incompatible(SCHEMA_V2_REQUIRED)，只读 + 可克隆。
- legacy 事件读取兼容（§8.3 transform）。
- legacy 克隆继承 incompatible gate；未来迁移克隆另议。
- 模板：删 zhihu；重写 long-form-hub（**reviewer→controller 改 artifact 边**）。

---

## 13. 实现拆解（v6，补 api 层 + 工具文案）

| 组件 | 改动 |
|---|---|
| task-events.ts | artifact_annotated、artifact_published.files[]/artifactType/artifactId、agent_result.inputNodeId+dispatchKind、输入节点.inputVersion+humanAuthorized、pending_inputs_superseded、task_incompatible.SCHEMA_V2_REQUIRED、human_requested.source |
| event-store.ts | 读取期键归一 transform + 新字段可选校验 |
| artifact-store.ts | 注入 EventStore、版本事件计数、staging 认领、annotate 唯一性、复扫交叉校验、meta 保 id、读窗口容忍 |
| forge-actions.ts | 注册表 6→9、annotate/forward/多文件 finish、dispatchKind、send_message 简短 body |
| action-buffer.ts | 三类回合形态（生产/操作/协调=退化操作）、封存仅 finish、人工中断(F7 翻转)、结构顺序 |
| pi-tool-factory.ts | annotate、forward、read_artifact_version、send_message 简短 body、inputVersion/turnContract 注入、**F7 翻转后工具文案/promptSnippet 重写** |
| action-committer.ts | annotate staging 提交序+唯一性、可达性闭包(humanAuthorized)、输入版本传播、dispatchKind 完成检测、语义矩阵、重放触发认领、forward 节点 id |
| task-scheduler.ts | **progress-guard 结构化决策(continue/accept/stop)**、**supersede+synthesize**、humanAuthorized 合成(唯一写入主体)、continue inputVersion 恢复、guard 停车对象改接收者、waiting_human 来源 |
| **api-schemas.ts + http-server + core-service** | **结构化决策 API 形状(decision+可选text)**、answer 端点扩展、waiting_human 来源暴露（解中 2） |
| template-schema/validator.ts | turnContract v2(§15)、artifactSchema、route.inject、交叉校验 |
| template-loader/cache.ts | v2 哈希、cache 归一化、FrozenTemplate.artifactSchema+budget |
| task-runner.ts | inject 执行期解析、inputText inject 供料、合成节点 inputText、handOff→inputVersion、forward 节点 id |
| contracts.ts | ArtifactVersion.files[]、输入节点 inputVersion+humanAuthorized |
| task-projector.ts + mock | 新事件折叠、inputVersion/humanAuthorized/superseded 消费、投影一致 |
| 产物链 UI | extract 槽位、verdict、annotate 归属、旧任务降级、**accept/continue 决策 UI、superseded 表示、waiting_human 来源区分** |
| templates/ | 删 zhihu、重写 long-form-hub(artifact 边) |

---

## 14. 六轮审查解决轨迹

- 第 1 轮：v1 原始漏洞。
- 第 2 轮：v2 三阻断在旗舰路径 → v3 生产/操作拆分。
- 第 3 轮：v3 核心收敛，N1-N10 → v4 补。
- 第 4 轮：§11 快乐路径成立；人工介入接缝 2 阻断+4 高危 → v5 结构化决策。
- 第 5 轮：确认 dispatchKind/transform/认领/自排除修复；揪出 accept 悬空输入、continue 引导无通道、humanAuthorized 无字段、accept 前提、dispatch-only 推导、多 pending → **v6 supersede+synthesize + humanAuthorized 落字段 + accept 前提 + dispatch-only**。
- 第 6 轮：**确认已收敛、无阻断、可进入实施**。验证 supersede+synthesize 逐步可落地（合成输入有 scheduler 既有先例、humanAuthorized 封闭性落在类型闭合构造器+事件契约白名单+动作参数面三重既有机制、提交序 supersede 先于 synthesize 正确取舍崩溃半态方向）；剩余仅 4 条低危 → **v7 折入（§11.4 兜底、§11.6 崩溃自愈、§11.5 accept 复校验、§15 协调回合表述统一），定稿**。

---

## 15. TurnContract v2 形状（v6，补 dispatch-only + sources 恢复）

```yaml
turnContract:
  version: 2
  production:                 # 存在 => 生产回合（writer）
    files: [content.md, revision.md]
    sources: [workspace_file]             # v6 恢复：finish_production 允许的 source（生产回合仅 workspace_file/inline）
    formats: [markdown]
  annotate:                   # 存在 => 可标注（reviewer）
    files: [review.md]
  dispatch:
    allowedActions: [publish_artifact, forward_input_version, send_message, submit_final_artifact, request_human_input]
    targets:
      publish_artifact: [reviewer]
      forward_input_version: [controller]
      send_message: [writer, controller]
```

- **budget 归模板级**（FrozenTemplate.budget）。
- **production.sources 恢复（解高 3）**：finish_production 的 source 必须 ⊆ production.sources；生产回合 sources 为 workspace_file/inline；**current_input_artifact 不是 finish 的 source**——它是 submit 的输入解析机制（operate 回合从 inputVersion 直解产物，不经封存包）。
- **回合类型推导规则（v6 补 dispatch-only，解高 3）**：
  - 有 production 段 + dispatch 含 publish → 生产回合；
  - 有 annotate 段 + dispatch 无 publish → 操作回合（审读类）；
  - **仅 dispatch 段（无 production 无 annotate）→ dispatch-only/协调回合（controller）**：无生产、无标注，只做 dispatch；
  - production+annotate 混合 → validator 拒绝。
- **submit 从 inputVersion 直解产物**：operate 回合 submit 不经封存包，从输入节点 inputVersion 直接解析版本提交（§9 语义矩阵 submit 行）。
- 纯操作/协调 Agent validator 交叉校验：annotate.files ⊆ schema(phase:annotate 且 producer==本 agent)；forward.targets ⊆ artifact 产物边对端；submit 仅当 ∈ finalOutput.submitters。

---

## 16. 已知取舍（v7，明示）

- verdict 不是系统门禁；条件路由写 systemPrompt；人工接受不重标注；混合 Agent 不支持。
- **continue 合成节点给「最老被作废 pending 输入的接收者」**（确定性规则，人工不可指定其他接收者；如需更细控制另议）。
- **accept 仅在有已发布版本时可用**；agent_request 来源的 waiting_human 不提供 accept。
- **continue 仅能续「最老被作废 pending 的接收者」**；被作废的其他接收者输入直接丢弃（人工想 continue 别的 pending 不可表达，明示边界）。
- **崩溃半态**：提交序 human_answered→superseded→synthesize 把半态压向安全方向；极端窗口无法自愈时任务 park 为 interrupted 可见，人工 stop/clone（§11.6）。

---

## 17. 定稿说明

- 本规格 v7 为**定稿**，经六轮对抗审查收敛（第六轮：已收敛、无阻断、可进入实施）。
- 实施按 `docs/2026-08-07-artifact-version-directory-dev-plan.md`（定稿）分 Phase 推进。
- 第六轮确认的「可接受实现细节」（不作阻断，留给实施期决策）：作废节点是否计入 buildTurnStatePrefix 回合计数、buildPublicHistory 是否保留作废节点入史（建议保留）、协调回合 buildTurnChecklist 渲染、EventNode 可选字段校验形态、controller systemPrompt 补人工授权引导、validator 可加 finalOutput.submitters⊆dispatch.allowedActions 交叉校验。
