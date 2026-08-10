# 结构槽引擎 v1 — 实施规格（Spec）

> 状态：**定稿（Final）**。
> 上游设计：[`STRUCTURED-SLOT-ENGINE-DESIGN.md`](./STRUCTURED-SLOT-ENGINE-DESIGN.md)。
> 对抗审查：[`STRUCTURED-SLOT-ENGINE-ADVERSARIAL-REVIEW.md`](./STRUCTURED-SLOT-ENGINE-ADVERSARIAL-REVIEW.md)，最终 `APPROVED`。
> 本文把已批准的系统设计收敛为实现契约；若本文与上游设计冲突，以上游设计第 25、26 节为准。

---

## 1. 目标与范围

结构槽引擎为 Forge Core 增加模板可选的第二种生产模式：

```yaml
productionMode: structured_slots
```

该模式以模板冻结的槽类型、布局语法、访问配置、校验器和 Assembler 为规则，以 scaffold 槽树为创作事实源。Agent 只在平台签发的 session 中提出结构或 content 候选；只有平台门禁和 ActionCommitter 可以改变权威状态。

首版范围：

- structured template 的加载、精确校验、hash 与 task snapshot；
- StructureProposal、Scaffold Generation、FillDraft、content revision 与 SealRecord；
- structure / fill / seal 三类 TurnContract v3 session；
- 上下文绑定的 Slot Tool、渐进式前文读取和 SlotSessionGrant；
- Structure / Merge / Seal Gate、validator 与 Assembler 沙箱；
- per-Gate 与 per-Attempt 资源包络；
- 原子 TaskEvent batch、task 内 blob、私有 journal/checkpoint 与恢复；
- Seal 后继续复用现有 v2 artifact 流程；
- TaskWorkspace 摘要、只读 API 与只读槽树 UI。

首版明确不做：

- Notion 类块编辑器、人工改槽、拖拽、人工 Merge 或文件反向同步；
- 单 case 内并行写入、自动 rebase、三方合并或 Slot Scheduler；
- “自动领取下一个未填槽”、运行时 slotId selector 或按实例动态循环；
- production story / 知乎故事模板；本期只提供平台中性的测试 fixture；
- required annotation、Seal 后回到槽阶段、解封 scaffold；
- binary、stream、多媒体或同一 artifact 内混用多种媒体类型；
- 旧 basic task 原地迁移或历史事件重写。

---

## 2. 架构位置与依赖方向

结构槽不是第十个 ForgeAction，也不是旁路运行器。九动作 registry 保持不变，Slot Tool 是当前 v3 turn 内的领域工具；现有 dispatch 仍负责 Route 和最终提交。

实现增加一个无存储依赖的纯领域层，并保持单向依赖：

```text
src/shared
  ← src/server/structured-slots        # canonical JSON、Schema、Grammar、issue 纯逻辑
  ← src/server/storage                 # batch、blob、Proposal/Draft/scaffold 持久化
  ← src/server/template                # contract 解析、交叉引用、pipeline typestate
  ← src/server/runtime                 # Attempt、Grant、Slot Tool、Gate、Assembler、Committer
  ← src/server/api
  ← src/client
```

唯一入口保持不变：

- 模板：`loadTemplateDirectory()`；
- task 生命周期：`TaskScheduler` / `TaskRunner`；
- 权威提交：`ActionCommitter`；
- 事件：`EventStore`；
- artifact：`ArtifactStore`；
- 对外聚合：`CoreService` / `TaskWorkspace`。

`basic` 与 `structured_slots` 在 Loader 和 Runner 处分流，但共用 task、事件、artifact、API 和 UI 外壳。basic v2 的现有行为、hash 和 replay 语义不得被 structured v1 反向改变。

---

## 3. 模板与冻结快照

### 3.1 Package 结构

```text
template.yaml
pipeline.yaml
agents/*.yaml
slots/
  contract.yaml
  validators/*
  assembler/*
```

整个目录仍是一个 Template Package，只有一个 `templateId`、`versionHash` 和 task snapshot。`slots/` 不是可独立版本化的子模板。

### 3.2 pipeline.yaml

`productionMode` 只允许 `basic | structured_slots`。字段缺失等价于 basic，但 basic canonical hash 不注入该默认值。

structured pipeline 的每个 Seal 前 Agent 使用 TurnContract v3：

```ts
type SlotCapabilityV1 =
  | 'read_structure_contract'
  | 'write_structure_proposal'
  | 'validate_structure_proposal'
  | 'submit_structure_proposal'
  | 'read_slot_spec'
  | 'read_slot_content'
  | 'write_draft_content'
  | 'validate_draft'
  | 'submit_draft'
  | 'request_seal';

type StructuredSlotSessionV3 =
  | {
      kind: 'structure';
      accessProfile: null;
      capabilities: SlotCapabilityV1[];
      completion: 'structure_commit_candidate_created';
    }
  | {
      kind: 'fill';
      accessProfile: string;
      capabilities: SlotCapabilityV1[];
      completion: 'merge_candidate_created';
    }
  | {
      kind: 'seal';
      accessProfile: string;
      capabilities: SlotCapabilityV1[];
      completion: 'seal_candidate_created';
      failureDispatch: {
        when: 'seal_gate_failed';
        action: 'send_message';
      };
    };

interface StructuredTurnContractV3 {
  version: 3;
  slotSession: StructuredSlotSessionV3;
  dispatch: {
    allowedActions: Array<
      | 'send_message'
      | 'publish_artifact'
      | 'submit_final_artifact'
      | 'request_human_input'
    >;
    targets: Partial<Record<'send_message' | 'publish_artifact', string[]>>;
  };
}
```

Agent YAML 使用 `slotCapabilities: SlotCapabilityV1[]` 声明静态能力上限。v3 `slotSession.capabilities` 必须是该上限子集，并包含 kind 的最小可完成集合：

| kind | 必需能力 | 可选能力 | completion dispatch |
|---|---|---|---|
| structure | read contract、write proposal、submit proposal | validate proposal | `send_message` |
| fill | read spec、read content、write draft、submit draft | validate draft | `send_message` |
| seal | request seal | read spec、read content | 成功 `publish_artifact` / `submit_final_artifact`；可靠失败 `send_message` |

结构与填充节点的非人工 allowedActions 必须且只能是 `send_message`。seal 必须声明 `send_message` 和至少一个成功动作；所有 send target 必须是 v3 fill/structure。Seal 后 v2 节点禁止 production，只允许 artifact read/annotate、forward、final-submit 或 human，且不得回边到 v3。

### 3.3 slots/contract.yaml

顶层 exact schema：

```yaml
version: 1
slotTypes: []
layoutGrammar: {}
accessProfiles: []
validators: []
assembler: {}
limits: {}
```

七个字段全部必填、禁止额外字段。`slotTypes`、`accessProfiles` 至少一项；`validators` 可为空；Assembler 恰好一个。

资源引用只允许规范化 POSIX 相对路径：validator 必须位于 `slots/validators/`，Assembler 必须位于 `slots/assembler/`。拒绝绝对路径、反斜杠、空段、`.`、`..`、NUL、symlink、非普通文件、未引用文件和目录外引用。

### 3.4 FrozenTemplate 扩展

```ts
interface FrozenTemplate {
  // 既有字段保持不变
  productionMode: 'basic' | 'structured_slots';
  structuredSlots: FrozenStructuredSlotContractV1 | null;
}
```

旧 manifest 缺失这两个字段时读取为 basic/null；计算旧 basic `versionHash` 时不把默认字段加入 canonical source。structured hash 追加：规范化 contract、排序资源摘要、ABI 身份、实现摘要、limits 和 runtime profile identity。

task 创建时复制完整 Package 到既有 `snapshot/`；运行期只读 snapshot。缺失、损坏、摘要不符或宿主不满足冻结能力时返回 `TEMPLATE_RUNTIME_UNAVAILABLE`，不得回退源模板或静默降低额度。

---

## 4. Slot Schema、Grammar 与 canonical JSON

### 4.1 JSON 数据模型

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

interface SlotInstance {
  slotId: string;
  scaffoldId: string;
  parentSlotId: string | null;
  order: number;
  typeId: string;
  spec: JsonObject;
  contentPresence: 'unset' | 'set';
  content?: JsonValue;
}
```

`spec` 始终是 object；content 可为任何 schema 允许的 JSON 值。unset 与 set 为 `null`、空串、空数组或空对象不同。

### 4.2 SlotTypeDefinition

```ts
interface SlotTypeDefinitionV1 {
  id: string;
  name: string;
  description: string;
  specSchema: SlotSchemaV1; // 根 type=object，additionalProperties 显式
  content:
    | { presence: 'forbidden' }
    | { presence: 'optional' | 'required'; schema: SlotSchemaV1 };
}
```

Slot Schema v1 只允许上游设计 8.3 的关键字白名单。每个节点必须有单一 `type`；拒绝 boolean schema、type union、引用、组合、条件、default、format、`multipleOf` 和未知关键字。object 必须显式 `additionalProperties: false | SlotSchemaV1`；array 必须有单一 items。Schema 只验证，不填默认、不转换、不删除、不 trim。

字符串长度按 Unicode code point；payload 按 canonical JSON UTF-8 字节。pattern 使用 `forge-safe-regex/v1` 的 RE2 兼容子集。canonical JSON 使用 `forge-canonical-json/v1`（RFC 8785 JCS 核心），并在规范化前拒绝非 JSON 值、循环、孤立 surrogate、NaN/Infinity 和 bigint。

### 4.3 LayoutGrammar

```ts
type GrammarNode =
  | { kind: 'slot'; type: string }
  | { kind: 'sequence'; items: GrammarNode[] }
  | { kind: 'choice'; items: GrammarNode[] }
  | { kind: 'optional'; item: GrammarNode }
  | { kind: 'repeat'; min: number; max: number; item: GrammarNode }
  | { kind: 'empty' };

interface LayoutGrammarV1 {
  rootType: string;
  productions: Record<string, { children: GrammarNode }>;
}
```

Loader 编译 nullable、最小/最大消费数、FIRST、FOLLOW、type 依赖图和可生成固定点。每个 type 恰好一个 production，叶子显式 empty；拒绝 nullable repeat、不可终止递归、不可达 production、choice FIRST 相交、optional/repeat 的 FIRST-FOLLOW 冲突和任何超过模板 limits 的规则。通过加载的 grammar 由 Structure Gate 单遍左到右匹配，不回溯、不使用书写顺序消歧。

---

## 5. Limits 与平台 profile

`StructuredSlotLimitsV1` 使用七组二十八个正整数字段，字段名与单位不得改变：

```ts
interface StructuredSlotLimitsV1 {
  schema: {
    maxSchemaDepth: number;
    maxSchemaNodes: number;
    maxEnumItems: number;
    maxPatternLength: number;
  };
  structure: {
    maxSlots: number;
    maxTreeDepth: number;
    maxChildrenPerSlot: number;
  };
  payload: {
    maxSpecBytesPerSlot: number;
    maxContentBytesPerSlot: number;
    maxScaffoldPayloadBytes: number;
  };
  draft: {
    maxChangedSlots: number;
    maxDraftBytes: number;
  };
  attempt: {
    maxSlotToolCallsPerAttempt: number;
    maxValidationRunsPerAttempt: number;
    maxValidatorInvocationsPerAttempt: number;
    maxAggregateValidatorCpuMsPerAttempt: number;
    maxAggregateValidatorWallClockMsPerAttempt: number;
    maxValidatorOutputBytesPerAttempt: number;
    maxAttemptWallClockMs: number;
  };
  validation: {
    maxValidators: number;
    maxValidatorInvocationsPerGate: number;
    maxAggregateValidatorCpuMsPerGate: number;
    maxAggregateValidatorWallClockMsPerGate: number;
    maxValidatorOutputBytesPerGate: number;
    maxIssuesPerRun: number;
  };
  output: {
    maxArtifactFiles: number;
    maxArtifactBytesPerFile: number;
    maxTotalArtifactBytes: number;
  };
}
```

Loader 同时验证局部语义、跨字段关系、模板 limits 和平台 hard ceiling。所有值必须是大于 0 的 JavaScript safe integer；Attempt 对应 validator 上限必须不小于每 Gate 上限，validation runs 不大于 Slot Tool calls，Attempt wall 不小于 Attempt validator wall，changed slots 不大于 max slots，单 artifact 文件不大于总 artifact 上限。

平台 profile 以独立版本身份 `forge-structured-runtime/v1` 暴露。实施期先使用设计 25.13 的候选值运行基准；结构槽 production runnable gate 只有在基准报告通过并把该 profile 固化后才打开。模板只能声明小于等于 profile 的值。

Attempt meter 的调用单位是 `(toolCallId, canonicalArgsHash)`。只有同 key、同参数并直接重放缓存结果时不重复计数；同 key 换参数、参数错误、越权和业务失败均占额度。恰好达到上限合法；下一次将超过、运行中实际消耗超过或总 wall deadline 到期时终止 Attempt。

总 wall deadline 从 `structured_slot_attempt_started` batch 可见开始，使用平台 monotonic timer，覆盖 provider、Slot Tool、validator、Assembler 和 dispatch。compaction、provider session 续接、纠正 prompt 或重放不得重置 meter。

---

## 6. Pipeline typestate

静态与运行时共同使用：

```ts
type ScaffoldPhase = 'no_scaffold' | 'active_unsealed' | 'sealed';
```

| 节点 | 输入 | 成功输出 |
|---|---|---|
| v3 structure | no_scaffold / active_unsealed | active_unsealed |
| v3 fill | active_unsealed | active_unsealed |
| v3 seal | active_unsealed | sealed |
| Seal 后 v2 | sealed | sealed |

当前 pipeline 唯一首节点必须是 v3 structure。Loader 对所有可达 Route 做固定点传播；join 任一入边不满足、fill/seal 作为首节点、structure 未支配 fill/seal、Seal 未支配 v2、sealed 回到 v3 均拒绝。Seal reliable-failed 的 rework edge 输入/输出均为 active_unsealed，只能到 v3 fill/structure。

运行时在节点启动、Grant 签发和 ActionCommitter 提交前再次验证 phase。

---

## 7. 持久化与原子事件

### 7.1 task 目录

```text
tasks/<taskId>/
  snapshot/
  events/
  artifacts/
  structured-slots/
    blobs/<first2>/<sha256>.json
    generations/<generationId>/manifest.json
    generations/<generationId>/slots.ndjson
    generations/<generationId>/index.json
    content-revisions/<revisionDigest>.json
    proposals/<proposalId>/journal.ndjson
    proposals/<proposalId>/checkpoint.json
    drafts/<draftId>/journal.ndjson
    drafts/<draftId>/checkpoint.json
    attempts/<turnId>/meter.json
    custody/<contentIdentity>/
```

generation `slots.ndjson` 每行一个 canonical slot record；`index.json` 保存 slotId byte offset/length、parent/order/type 和文档顺序/type 索引。读取单槽只能读取索引与对应行，不能反序列化完整最大 scaffold。

content revision 是 canonical 映射 `slotId -> unset | contentBlobDigest`；content 值单独 content-addressed，merge 复用未变化 blob。Proposal/Draft journal 达到实现计划冻结的操作数或字节阈值后写不可变 checkpoint；journal/checkpoint 是私有候选，不进入主 projector。

### 7.2 BlobRef

```ts
interface StructuredBlobRefV1 {
  version: 1;
  kind: 'generation' | 'content_revision' | 'seal_record' | 'validation';
  sha256: string;
  byteLength: number;
}
```

blob task-local、不可变、不跨 task 去重。task 删除时随 task 一并删除。

### 7.3 appendBatch

EventStore 新增：

```ts
interface AppendBatchOptions {
  expectedLastSequence: number;
}

interface TaskEventBatchEnvelopeV1 {
  version: 1;
  commitId: string;
  taskId: string;
  firstSequence: number;
  eventCount: number;
  events: TaskEvent[];
  canonicalPayloadSha256: string;
}

appendBatch(
  taskId: string,
  commitId: string,
  events: readonly TaskEvent[],
  options: AppendBatchOptions,
): Promise<CommittedEvent[]>;
```

物理文件名：`<first>-<last>-<commitId>.batch.json`。legacy `<sequence>-<eventId>.json` 继续可读，basic `append()` 行为保持不变。

在 task mutex 内，appendBatch 先查 commitId：同 canonical payload 返回原结果，不同 payload 返回 `IDEMPOTENCY_CONFLICT`；新提交再校验 expectedLastSequence、全部事件、事件 ID、batch size 和连续逻辑序号，最后只原子创建一个 envelope 文件。reader 同时扫描 legacy 与 batch，平铺为无空洞、无重复的 `CommittedEvent[]`。

### 7.4 structured 事件

TaskEvent 联合新增：

```ts
type StructuredAttemptStatus = 'committed' | 'failed' | 'abandoned' | 'waiting_human';
type StructuredAttemptReason =
  | 'completion_dispatch'
  | 'rework_dispatch'
  | 'runtime_failure'
  | 'task_stop'
  | 'crash_recovery'
  | 'human_request';

type StructuredTaskEvent =
  | (EventBase & {
      type: 'structured_slot_attempt_started';
      inputNodeId: string;
      agentId: string;
      attemptEpoch: number;
      turnId: string;
      sessionKind: 'structure' | 'fill' | 'seal';
    })
  | (EventBase & {
      type: 'structured_slot_attempt_terminal';
      inputNodeId: string;
      attemptEpoch: number;
      turnId: string;
      status: StructuredAttemptStatus;
      reason: StructuredAttemptReason;
    })
  | (EventBase & {
      type: 'structured_scaffold_generation_committed';
      scaffoldId: string;
      generationId: string;
      supersedesGenerationId: string | null;
      rootSlotId: string;
      slotCount: number;
      maxDepth: number;
      structure: StructuredBlobRefV1;
      content: StructuredBlobRefV1;
      contentRevision: 0;
      proposalId: string;
    })
  | (EventBase & {
      type: 'structured_fill_draft_opened';
      draftId: string;
      turnId: string;
      scaffoldId: string;
      generationId: string;
      baseRevision: number;
    })
  | (EventBase & {
      type: 'structured_fill_draft_terminal';
      draftId: string;
      turnId: string;
      status: 'merged' | 'stale' | 'abandoned';
      baseRevision: number;
      resultRevision: number;
      changeCount: number;
      content: StructuredBlobRefV1 | null;
    })
  | (EventBase & {
      type: 'structured_scaffold_sealed';
      sealId: string;
      scaffoldId: string;
      generationId: string;
      scaffoldRevision: number;
      sealRecord: StructuredBlobRefV1;
      artifactId: string;
      artifactVersion: number;
    });
```

`agent_result`、Route、agent_input、artifact_published、final_submission_accepted、human_requested/answered 和 lifecycle 事件继续复用既有成员，并与 structured terminal 放入同一 batch。

---

## 8. Attempt、Grant 与 session

### 8.1 Attempt 身份

`turnId` 就是 structured ActionAttempt ID。对同一 inputNodeId，`attemptEpoch` 从 1 严格递增，turnId 由平台确定性派生；不再从 `agent_attempt_failed` 数量推测。

start batch 在调用模型前提交；每个 started Attempt 最终恰好一个 terminal。合法 status/reason 组合只有：

```text
committed / completion_dispatch
committed / rework_dispatch
failed / runtime_failure
abandoned / task_stop
abandoned / crash_recovery
waiting_human / human_request
```

stop、crash recovery、runtime retry 和 manual retry 先关闭旧 Attempt，再对同 input 分配更高 epoch；human answer 创建 fresh inputNodeId，并从 epoch 1 开始。Proposal、Draft、candidate、rework receipt 和 Grant 均不跨 Attempt。

### 8.2 SlotSessionGrant

Grant 使用上游设计 10.3 的判别联合。structure 只绑定 snapshot/proposal；fill/seal 绑定 accessProfile、active scaffold、generation、baseRevision 和可见 slot；fill 另绑定 draft，seal writable 固定为空。

Grant 不用墙钟租约，但在 turn terminal、snapshot 变化、Proposal/Draft 终态、active generation 变化或 baseRevision 失效时立即失效。模型永远看不到 grantId、profileId、draftId、revision 或原始 ACL。

### 8.3 AccessProfile

```ts
type SlotTargetSelectorV1 =
  | { kind: 'all' }
  | { kind: 'root' }
  | { kind: 'types'; typeIds: string[] };

interface AccessProfileV1 {
  id: string;
  read: Array<{
    targets: SlotTargetSelectorV1;
    targetLevel: 'outline' | 'spec' | 'content';
    context: {
      level: 'outline' | 'spec' | 'content';
      ancestors: number;
      descendants: number;
      directSiblings: boolean;
    };
  }>;
  writeContent: Array<{ targets: SlotTargetSelectorV1 }>;
  continuity: { precedingFilled: boolean };
}
```

selector 默认拒绝、规则并集、按 depth-first pre-order 去重。precedingFilled 是唯一 content-state 动态关系，只扩大只读范围；初始上下文只给有序目录，不自动加载正文。Agent 逐槽调用 read_slot，读到 base + 本 Draft overlay 的有效值。

不可见与不存在统一返回 `SLOT_NOT_VISIBLE`；批量操作含任一隐藏槽时整批失败。可见深层节点只补 ancestor outline shell，不暴露隐藏 sibling、真实 child 数或存在性提示。

---

## 9. Proposal、Draft 与 Slot Tool

### 9.1 structure

started 后平台确定性创建 open Proposal，再签发 structure Grant。模型工具：

```text
get_structure_contract
put_structure_proposal
get_structure_proposal
validate_structure_proposal
submit_structure_proposal
```

Proposal 是 `ProposalNode { clientKey, typeId, spec, children[] }` 的整树替换；不能含 content、slotId、ACL、revision、代码或路径。put 只做存储安全/大小/基础形状，允许暂时不满足 schema/grammar。submit 运行完整 Structure Gate，预分配稳定 slotId，冻结 turn-bound candidate；ActionCommitter 成功后才创建 generation。candidate 后禁止继续写或重跑 Gate。

### 9.2 fill

started 后平台按 turnId 幂等创建 open FillDraft。模型工具：

```text
list_slots
read_slot
replace_draft_content
unset_draft_content
validate_draft
submit_draft
get_draft_status
```

写入只作用于私有 overlay，批量全有或全无，完整替换 JSON value，不支持 patch。submit 运行 Merge Gate并冻结 candidate。no-op Draft 合法：成功后 Draft merged、revision 不变、不创建 content revision blob。

Draft 生命周期为 open -> merged | stale | abandoned。校验失败保持 open；candidate 锁定后不可再写。终态只读保留到 task 删除，默认不进入公开投影或 Assembler。

### 9.3 seal

seal 工具只有 `request_seal` 加可选 read 工具。request_seal 全量重验、运行全部适用 validator、运行 Assembler 并校验 manifest：

- passed：冻结 sealed candidate；
- reliable failed：冻结 revision-bound `seal_rework_required` receipt；
- incomplete：不生成任何 receipt，可在 Attempt 剩余预算内重试/runtime retry/human。

passed 后只允许 publish/final-submit；failed receipt 后只允许 send 到冻结 fill/structure target；incomplete 禁止 send。可靠 failed 的 rework batch保持 active_unsealed 且 revision 不变。

### 9.4 工具幂等

所有 Slot Tool 从 runner 接收 toolCallId，模型参数面不含工程身份。同 `(toolCallId, canonicalArgsHash)` 重放原结果；同 key 换参数返回 `IDEMPOTENCY_CONFLICT` 并计入 Attempt meter。工具结果只返回授权后的数据、稳定 code、StructuredVerdict 或安全 receipt 摘要。

---

## 10. Validation、issue 与 sandbox

平台统一使用 `StructuredIssueV1` / `StructuredVerdictV1` 和上游设计 19.2 的六类 IssueLocation。公开 code registry 至少覆盖设计 25.5 F03；code 固定 source、phase、severity、details schema 和 location kinds。Agent/UI 不解析 message 决策。

Gate 层级：

- Proposal put / Draft write：只做权限、形状、存储和资源检查；
- validate_*：建议性，不改权威状态；
- Structure Gate：完整 schema + grammar；
- Merge Gate：revision/Grant/scope、changed content schema、受影响 validator；
- Seal Gate：全量 required/schema/grammar/validator + Assembler + artifact schema。

validator 注册必须声明 id、scope、trigger、enforcement、selector、`forge-validator/v1` implementation 和 cpu/timeout/memory budget。v1 严格串行；Gate 前解析全部 target 并 preflight，运行中流式计量 CPU、validator phase wall、输出字节和 issues。可靠 advisory 拒绝只产生 warning；任何执行不完整都返回 incomplete 并阻塞。

validator/Assembler 沙箱没有 require、FS、network、process、Date、random、locale、env 或任意依赖加载。输入是固定 canonical JSON 信封；返回值分别是窄 `{pass, issues}` 和 `{routeId, content}[]`。实现源码、宿主路径、secret、Grant、事件和服务句柄不进入输入或模型投影。

Attempt 包络超限时，coordinator 主动 abort provider/sandbox，清理 staging，把 Proposal/Draft/candidate abandoned，并以一个 CAS batch 写 `RESOURCE_LIMIT_EXCEEDED` agent failure + `failed/runtime_failure` terminal。该 Attempt 随后不能调用工具、dispatch 或 human。

---

## 11. ActionCommitter 与 dispatch

ActionCommitter 根据 `productionMode` 分流：basic v2 走现有路径；structured v3 查询当前 turn 的唯一 candidate/rework receipt，并验证 kind、turn、snapshot、active generation、revision、phase、target 和 CAS tail。

提交边界：

- structure：generation/content blob promote + proposal committed + Agent result + terminal + message Route/input，一个 batch；
- fill：非空 content root promote + Draft merged + Agent result + terminal + message Route/input，一个 batch；no-op 不写 content blob；
- seal success：artifact custody prepare/promote + SealRecord blob + artifact_published + scaffold sealed + Agent result + terminal + publish Route 或 final submission，一个 batch；
- seal rework：Gate failure result + Agent result + terminal(rework_dispatch) + message Route/input，一个 batch，不改 scaffold；
- human：私有对象/candidate/staging abandoned + Agent result + terminal(waiting_human) + human_requested，一个 batch；
- runtime failure/stop/crash：私有对象终态 + terminal + 对应现有 failure/lifecycle 事件，一个 batch。

所有大对象先 stage/verify，再 promote 到未被事件引用的最终地址，batch 是唯一可见性点。CAS loser 读取已存在 terminal，丢弃 stale result，不得写第二终态。响应丢失时存在相同 commitId 就返回原结果；不存在则新 Attempt 从最后权威状态重做。

---

## 12. Seal、Assembler 与 artifact custody

Assembler 注册：

```ts
interface AssemblerRegistrationV1 {
  id: string;
  implementation: { abi: 'forge-assembler/v1'; path: string };
  budget: { cpuMs: number; timeoutMs: number; memoryMiB: number };
  routes: Array<{ id: string; artifactFile: string }>;
}
```

每个 route 一一对应一个 phase:create 平面文件；所有 create producer 必须是当前 v3 seal Agent。Assembler 只返回 UTF-8 content，平台补 path/mediaType/producer/required；required create 精确覆盖、无额外输出。annotation 必须 optional，SealRecord 不包含 annotation。

SealRecord 使用上游设计 17.2 形状，必须引用正式 `{artifactId, version}` 和每个 create output 的 route/path/mediaType/byteLength/sha256。内容身份由 task、scaffoldId、revision、snapshotHash、Assembler 摘要和规范化输入 hash 派生；attempt receipt 另绑定 turnId/toolCallId。

ArtifactStore 增加结构槽 custody prepare/promote API。未提交 artifact 目录不进入 list/read；恢复按 batch、content identity 和 hash 复用或回收 orphan。batch 后缺文件或 hash 不符为 `ARTIFACT_INTEGRITY_FAILED`，不得反向吸收到 slot content。

Seal 不是 task completed；只有既有 `final_submission_accepted` 完成 task。

---

## 13. Scheduler、停止与人工回答

TaskRunner 在 structured input 上：

1. CAS 分配 Attempt epoch 并提交 started batch；
2. 创建 Proposal/Draft、meter 和 Grant；
3. 用 composite AbortSignal 启动 runtime 与 monotonic deadline；
4. Slot Tool 操作私有 store，ForgeAction 只负责最终 dispatch；
5. ActionCommitter 提交 terminal batch；
6. 所有失败路径先检查已有 terminal，避免重复关闭。

TaskScheduler stop 与 crash recovery 必须关闭 active structured Attempt 后再改变 task lifecycle。恢复启动时扫描 started-without-terminal，统一以 crash_recovery batch abandon，不恢复旧 provider session或私有 candidate。

structured agent_request 的 answer 使用 pending request event ID 派生稳定 commitId，并在一个 appendBatch 中同时提交：

```text
human_answered + fresh confirmed agent_input
```

API 重试前先查该 commit：相同 canonical answer 返回原成功，不同 answer 返回 `IDEMPOTENCY_CONFLICT`。basic/progress-guard 现有路径不被重解释。

---

## 14. Public projection、API 与 UI

`TaskWorkspace` 增加可选摘要：

```ts
interface StructuredSlotsSummaryV1 {
  version: 1;
  mode: 'structured_slots';
  scaffoldId: string | null;
  generationId: string | null;
  contentRevision: number | null;
  structureStatus: 'none' | 'active';
  sealStatus: 'unsealed' | 'sealed';
  visibleSlotCount: number;
  filledSlotCount: number;
  issueSummary: { errors: number; warnings: number };
}
```

basic workspace 不输出该字段。摘要不嵌入 content、完整树、Grant 或私有 Draft。

只读 REST：

```text
GET /api/tasks/:taskId/structured-slots/contract
GET /api/tasks/:taskId/structured-slots/tree?cursor=&limit=
GET /api/tasks/:taskId/structured-slots/slots/:slotId
GET /api/tasks/:taskId/structured-slots/issues?cursor=&limit=
GET /api/tasks/:taskId/structured-slots/seal
```

所有响应使用 TypeBox exact schema；cursor 绑定 task、generation、revision、projection identity 和排序版本，状态变化返回 cursor invalid。UI 新增只读“结构”抽屉：树形大纲、type/spec/content、状态、issue 定位、merge/Seal 审计和 sealed artifact 链接。UI 不提供任何写 API。

Agent 与 UI 复用同一个授权投影服务；内部审计可以更完整，但公开位置/details/message 不能泄露隐藏槽。

---

## 15. 兼容、安全与上线门禁

- `productionMode` 缺失的模板继续 basic；basic 出现 slots contract 或 v3 binding 立即拒绝。
- structured 必须 contract v1 + TurnContract v3；未知版本 fail closed。
- 历史 snapshot 原样可读，不升级；structured v1 未发布前没有数据迁移。
- ForgeAction 九项 registry、basic v2 template、ArtifactVersion、现有 API 字段保持兼容。
- 模型参数拒绝 task/case/scaffold/draft/grant/agent/revision/path 等工程键。
- raw provider thinking、secret、绝对路径和 sandbox cause 不进入事件、trace、issue 或 API。
- structured mode 在平台 profile 基准、全量恢复测试和 basic 回归通过前保持不可运行；Loader 可以在测试中使用注入 profile。

---

## 16. 验收矩阵

实现完成至少满足：

1. basic 模板 hash golden、现有 unit/integration/e2e 全部不变；
2. contract exact schema、资源 containment、Slot Schema、Grammar、selector、typestate property/golden 测试通过；
3. 10k slot / 64 MiB scaffold、最大 Draft、validator fanout、500 issues、Seal 和恢复基准满足 profile；
4. Proposal/Draft 工具幂等、同 key 冲突、批量原子、隐藏对象防探测通过；
5. Attempt stop/crash/retry/human、deadline、compaction 不重置、terminal CAS 竞态通过；
6. EventStore legacy + batch 混读、batch 崩溃点、commitId replay/conflict、逻辑序号无空洞通过；
7. structure、fill、no-op、seal success、seal rework、incomplete、human 的每个 terminal batch 全有或全无；
8. validator/Assembler sandbox 逃逸、timeout/memory/output/aggregate/Attempt limits fail closed；
9. custody 在 batch 前/后崩溃、orphan 复用/清理、hash 损坏检测通过；
10. 只读 API exact schema、cursor 失效、授权过滤和 UI basic/structured 双模式通过；
11. `npm run check`、`npm test`、`npm run build`、`npm run e2e` 与新增 structured acceptance 全绿。

---

## 17. 规格维护

- 产品定位、系统不变量或协议选择只在上游设计修改并重新审查；
- 本 spec 记录实现可依赖的稳定接口与物理边界；
- 开发计划可以调整任务顺序、文件拆分和测试夹具，但不得改变本文语义；
- 任何 public code、TaskEvent、contract、ABI、canonical JSON 或 platform profile 的不兼容变化必须升级版本，不能原地换义。
