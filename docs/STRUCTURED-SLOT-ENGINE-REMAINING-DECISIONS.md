# Forge Core 结构槽引擎：剩余问题与推荐方案

> 状态：**Batch Review / 非权威评审队列**
> 整理日期：2026-08-10
> 权威设计：[`STRUCTURED-SLOT-ENGINE-DESIGN.md`](./STRUCTURED-SLOT-ENGINE-DESIGN.md)
> 用途：集中列出进入 dev plan 前尚未冻结的问题、推荐方案、备选方案与影响，供一次性评审。

本文不是第二份系统设计。已经接受的结论必须回写到权威设计文档；本文只记录尚待评审的选项和建议。若本文与权威设计冲突，以权威设计为准。

## 1. 如何评审这份清单

每个问题都有稳定编号和建议等级：

- **P0｜需要重点确认**：会改变模板表达力、运行契约或事实源边界，建议由产品/架构共同确认。
- **P1｜建议批量接受**：属于系统契约，但推荐方案已经比较明确；若无异议可整组接受。
- **D｜实施默认项**：纯工程细节，不建议逐项占用产品讨论；默认带入 dev plan，并由测试与基准结果校准。

评审时不必逐条回复长文，可以直接按编号批注，例如：

```text
整体接受推荐方案。
D03 改为允许“按父槽实例选择直接子树”；
H02 需要再讨论；
C01 数值等基准测试后冻结。
```

## 2. 推荐结论总览

| 分组 | 核心结论 | 等级 |
|---|---|---|
| A. Contract 与 Loader | v1 使用 exact schema、固定本包相对资源、确定性规范化与聚合诊断 | P1 |
| B. Slot Schema | 采用安全、可移植、纯验证的有限 JSON Schema 方言 | P1 |
| C. 限额与兼容性 | 显式 canonical JSON 协议；初始 hard ceiling 经基准测试后冻结 | P1 / D |
| D. Capability 与 selector | capability 封闭；selector v1 保持静态、可判定、无运行时查询语言 | **P0** |
| E. Validator 与 Assembler | 固定 ABI、隔离执行、显式预算；v1 输出以文本文件为主 | P1 |
| F. Issue 与 verdict | code registry 控制严重级别和详情形状；`incomplete` 必须 fail closed | P1 |
| G. 持久化与事件 | 权威小事件 + 不可变大对象 blob + 私有 journal/checkpoint | **P0** |
| H. Action 与 TurnContract | 保留九个 ForgeAction；新增独立 Slot Tool；structured turn 使用 v3 契约 | **P0** |
| I. API、Workspace 与 UI | 首版只读、按需、授权投影；不建设块编辑器 | P1 |
| J. Seal 与现有 artifact 链 | Seal 先形成 turn-bound 候选，再由现有 ActionCommitter 原子接管 | **P0** |
| K. 实施组织 | 模块边界、exact schema、测试矩阵和性能索引进入 dev plan | D |

推荐优先关注 **D03、G01、H01/H02、J01/J02** 四组问题。其他条目若没有明确反对意见，可以整组采用推荐方案。

与权威设计第 25 节的覆盖关系如下，确保原有开放项没有在整理过程中丢失：

| 权威设计开放项 | 本文对应章节 |
|---|---|
| 1. contract exact schema | A |
| 2. LayoutGrammar issue code/details | F02–F04 |
| 3. Slot Schema 数值与 safe pattern | B |
| 4. hard ceiling 与兼容协议 | C |
| 5. selector 与 access profile | D |
| 6. validator / Assembler 协议 | E |
| 7. StructuredIssue code/details/verdict | F |
| 8. 事件、Draft Store、checkpoint、目录 | G |
| 9. 九动作与 TurnContract 适配 | H |
| 10. TaskWorkspace、API、UI | I |
| 11. publish/final submission 与 Seal | J |

---

## 3. A — `contract.yaml` 与 Loader

### A01｜顶层 exact schema（P1）

**问题**：`slots/contract.yaml` 的顶层分区已经确定，但必填、空集合和额外字段语义尚未冻结。

**推荐方案**：v1 固定且仅允许 `version`、`slotTypes`、`layoutGrammar`、`accessProfiles`、`validators`、`assembler`、`limits` 七个顶层字段；全部必填，`additionalProperties: false`。`slotTypes`、`accessProfiles` 至少一项；`validators` 可以为空；`assembler` 必须存在且只能注册一个最终 Assembler。`version: 1` 同时确定 Slot Schema、Grammar、selector 和注册契约的整套方言，不再额外声明多个可自由组合的 dialect 版本。

**备选与影响**：允许可选分区或独立 dialect 版本会增加版本组合和 Loader 分支，首版收益有限。推荐拒绝隐式默认和部分配置。

### A02｜资源引用与符号链接（P1）

**问题**：实现文件如何被安全引用，尚缺少物理文件规则。

**推荐方案**：contract 只引用 `slots/validators/` 或 `slots/assembler/` 下的规范化 POSIX 相对路径；拒绝绝对路径、反斜杠、空段、`.`、`..`、NUL、符号链接、非普通文件和大小越限文件。两个实现目录下未被 contract 引用的文件也加载失败。Loader 按逻辑路径排序生成资源 manifest，并记录内容摘要。

**备选与影响**：允许未引用资源会产生“包内代码究竟是否属于快照”的歧义；允许符号链接会扩大越界和哈希不一致风险。

### A03｜规范化与 `versionHash`（P1）

**问题**：结构槽新增 YAML 和实现资源后，如何获得跨机器稳定 hash，同时不破坏历史 basic 模板 hash。

**推荐方案**：basic 模板继续走原有规范化路径，缺失 `productionMode` 时不注入新默认字段。structured 模板在原 hash 输入上追加：规范化后的 contract 语义、按逻辑路径排序的资源内容摘要、平台解析出的受信 ABI 身份。hash 中不放源目录绝对路径、mtime 或宿主机元数据。文本资源统一换行后取摘要；二进制按原字节取摘要。

**备选与影响**：直接 hash 源 YAML 字节最简单，但无意义的格式变化会改变模板身份；把默认字段写回历史对象则可能让现有 snapshot 被误判损坏。

### A04｜Loader 诊断策略（D）

**问题**：模板有多个错误时，是首错退出还是聚合返回。

**推荐方案**：单文件语法错误和重复键立即终止该文件解析；完成可解析文件后，聚合 schema、交叉引用、Grammar、资源和兼容性问题，按 `resourcePath + span + code` 稳定排序，并受平台诊断上限保护。Loader 绝不在语义错误上静默修复。

**影响**：模板作者一次能修复更多问题，同时输出仍然确定、有界。

### A05｜契约兼容协议（P1）

**问题**：如何区分“模板版本”和“运行环境能否执行该模板”。

**推荐方案**：`contract.version` 使用封闭整数版本；未知版本直接拒绝。快照另外冻结运行能力描述，包括 canonical JSON、validator ABI、assembler ABI 和必要 hard ceiling 身份。恢复时做“当前平台是否覆盖快照所需能力”的比较，不按应用 build 号或宽泛 semver 猜测兼容。历史快照永不被新 Loader 重新解释或原地升级。

---

## 4. B — Slot Schema v1

### B01｜数值关键字边界（P1）

**问题**：`minLength`、`maxItems` 等数值参数缺少统一合法域。

**推荐方案**：长度、数量和属性个数参数必须是 JavaScript safe integer 范围内的非负整数，并满足 `min <= max`。数值 schema 边界必须是有限 JSON number；`multipleOf` 必须为有限正数；`exclusiveMinimum` / `exclusiveMaximum` 采用数值形式，不接受旧版布尔形式。所有运行时 number 必须可表示为有限 IEEE-754 double；`integer` 还必须位于 safe integer 范围并满足数学整数语义。超出安全整数范围的精确整数应由模板建模为带 pattern 的字符串，平台不能在 JSON 解析时悄悄舍入。

### B02｜字符串长度与字节限制分离（P1）

**问题**：字符串长度可能按 UTF-16、Unicode code point 或 UTF-8 字节计算。

**推荐方案**：Schema 的 `minLength` / `maxLength` 按 Unicode code point 计数；所有 payload 大小限制单独按 canonical JSON 的 UTF-8 字节计数。v1 不做 Unicode normalization，避免平台替换用户内容。

### B03｜Safe pattern 方言（P1）

**问题**：直接执行模板提供的 ECMAScript 正则会带来 ReDoS、跨运行时差异和隐式 flags。

**推荐方案**：`pattern` 固定为 `forge-safe-regex/v1`，只接受 RE2 兼容子集；禁止回溯引用、lookaround、内联 flags 和宿主特有扩展。Loader 在模板加载期编译，运行期使用安全引擎，并继续受输入长度和执行预算约束。匹配语义与 JSON Schema 一致：搜索子串，模板若需要整串匹配必须显式写锚点。

**备选与影响**：使用原生 JavaScript RegExp 的实现成本较低，但安全性和可移植性不足，不推荐。

### B04｜`enum` / `const` 的 v1 范围（P1）

**问题**：对象与数组常量需要稳定深比较、规范化和较高的 schema 资源成本。

**推荐方案**：v1 的 `enum` 和 `const` 只允许标量 JSON 值：string、有限 number、boolean、null；枚举项按类型敏感的 canonical value 去重。对象/数组常量后置。

**影响**：减少实现和审计复杂度；模板仍可用对象 properties、required 和数组 items 表达绝大多数内容契约。

### B05｜`uniqueItems` 相等语义（P1）

**问题**：数组唯一性需要明确深相等规则。

**推荐方案**：使用类型敏感的 canonical JSON 值摘要判断；对象键顺序不影响相等，数组顺序影响相等，`1` 与数学上相同的 JSON number 视为相等，所有非有限数在进入验证前已拒绝。检查受 `maxItems` 和 payload hard ceiling 保护。

### B06｜Schema issue 顺序与内容安全（D）

**问题**：不同 validator 实现可能返回不同首错和顺序，也可能回显完整无效内容。

**推荐方案**：按 schema pointer、instance value pointer、keyword、code 稳定排序；details 只给 keyword、约束摘要和实际类型/长度，不回显完整 content。达到 `maxIssuesPerRun` 后返回截断 verdict，但内部通过/失败结论不能因截断改变。

---

## 5. C — 限额、canonical JSON 与兼容性

### C01｜首个平台 hard ceiling（D）

**问题**：十六个模板 limits 已冻结，但平台首批绝对上限尚无数值。

**推荐方案**：先以以下数值作为基准测试候选，而不是立即写成长期兼容承诺：

| 范围 | 候选 hard ceiling |
|---|---:|
| schema 深度 / 总节点 / 单 enum / pattern 长度 | 16 / 4096 / 256 / 512 code points |
| scaffold 槽数 / 树深 / 单节点 children | 10,000 / 32 / 1,000 |
| 单槽 spec / 单槽 content / scaffold payload | 64 KiB / 1 MiB / 64 MiB |
| 单 Draft 变更槽数 / payload | 2,000 / 16 MiB |
| 单次公开 issues | 500 |
| artifact 文件数 / 单文件 / 总量 | 64 / 16 MiB / 64 MiB |

实施前用最坏 Grammar、Schema、10k 槽遍历、全量 Seal 和恢复测试验证 CPU、内存与响应大小，再冻结首个部署 profile。模板可以声明更小值，不能放宽这些上限。

### C02｜Canonical JSON 协议（P1）

**问题**：hash、字节限额、`uniqueItems`、幂等和快照恢复都依赖同一种规范化语义。

**推荐方案**：定义 `forge-canonical-json/v1`，以 RFC 8785 JSON Canonicalization Scheme 为规范化核心，并把输入限制在可无损表达的 JSON 数据：UTF-8、对象键按 JCS 的 UTF-16 code unit 规则排序、无多余空白、字符串不做 Unicode normalization、数字使用 JCS/ECMAScript 的稳定最短表示且 `-0` 规范为 `0`。在规范化前拒绝 NaN、Infinity、循环引用、undefined、bigint、孤立 surrogate 和非 JSON 对象。协议以跨实现测试向量冻结，不能直接把一次普通 `JSON.stringify` 调用当作完整协议。

### C03｜运行能力描述（P1）

**问题**：仅凭代码版本无法判断某个历史 case 是否仍可安全运行。

**推荐方案**：TemplateRuntimeSnapshot 冻结 contract version、canonical JSON version、Slot Schema version、Grammar version、validator ABI、Assembler ABI、实现摘要和模板 limits。恢复时逐项验证支持范围；任何必要能力缺失都返回 `TEMPLATE_RUNTIME_UNAVAILABLE`。平台不得用较小限额降级继续。

### C04｜集中预算执行器（D）

**问题**：限额若散落在 Loader、Draft、Gate 和 Seal 内，容易出现口径漂移。

**推荐方案**：提供一个版本化 budget evaluator，并在 Loader、Proposal 写入/提交、Draft 写入/提交、validator 输入输出、Assembler staging、artifact commit 各边界调用。所有接口共享同一计量函数和 code；拒绝 silent clamp。

---

## 6. D — Capability、access profile 与 selector

### D01｜Capability 封闭枚举（P1）

**问题**：当前正文只列举了候选 capability，未冻结名称和最小集合。

**推荐方案**：v1 固定为：

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
```

`audit_slots` 暂不加入，等语义审核 Agent、证据和裁决协议明确后再版本化扩展。工具的只读状态查询由已有会话权利隐含允许，不另造 capability。

### D02｜能力上限与运行期绑定（P1）

**问题**：Agent 声明的能力、Action 请求的能力和 profile 之间如何合并。

**推荐方案**：Agent YAML 声明静态 capability 上限；structured TurnContract 为当前 Action 声明所需 capability，并在 fill/seal 会话中声明 access profile；structure 会话显式使用 `accessProfile: null`。平台验证所需集合是 Agent 上限的子集，再根据 active scaffold 解析 SlotGrant。模型不能传 profileId、capability 或原始 slotId 集合。角色名不参与授权计算。

### D03｜Selector v1 的表达边界（P0｜需要重点确认）

**问题**：selector 太弱会限制模板流程，太强则会变成一门能读取内容、推断隐藏节点并产生不稳定授权的查询语言。

**推荐方案**：v1 只允许**静态、结构可判定的声明**：

- `all` 或 `root`；
- 按 `typeId` 选择所有匹配节点；
- 以匹配 type 为根选择有限深度的 `self / ancestors / descendants / siblings` 上下文；
- read selector 与 write selector 分离；
- 所有结果按树的确定性顺序去重；
- 禁止基于 spec/content/status 的任意布尔谓词、正则查询、路径脚本、“第一个未填槽”、运行时 slotId 白名单和自定义代码。

推荐的声明骨架是：

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
}
```

`typeIds` 必须非空、去重并全部引用已声明 type；上下文深度是非负整数且不超过模板 `maxTreeDepth`。多个规则做集合并集，deny-by-default；context 只扩大读取，绝不隐式扩大 `writeContent`。

一次 Action 可以因此覆盖一个槽、多个同类型槽或多个子树，但不能只挑选“某个具体章节实例”。若模板确实需要逐个处理同类型实例，首版应通过更细的业务 type、不同 Action，或一次覆盖全部匹配实例来表达。

**备选方案**：增加平台签发的实例 anchor，让 Route/Action 绑定一个具体 slotId，再在 anchor 相对范围内选择。它能支持逐章循环，但事实上会引入动态 Slot Scheduler/迭代状态，与已冻结的“首版不建设 Slot Scheduler”冲突。因此建议后置。

**需要确认的影响**：推荐方案刻意牺牲逐实例动态调度，换取模板加载期可审计、授权稳定和首版实现闭合。

### D04｜可见树投影闭包（P1）

**问题**：只暴露深层可见节点时，Agent 如何理解其树位置，同时不泄露隐藏内容。

**推荐方案**：定义三档可见性：`outline`、`spec`、`content`。任何可见节点都自动补齐到 root 的祖先 outline shell，保留真实父子关系，但不补齐未获授权的 siblings。可写节点至少可见自身 type、spec 和有效 content；祖先 shell 只含公开 type/name 和当前投影内的层级关系，不含 spec/content、真实 child 数、隐藏 sibling、`hasHiddenChildren` 或其他存在性提示。投影内的 children 重新形成连续展示顺序，但不能伪装成权威 `SlotInstance.order`。

### D05｜隐藏对象与不存在对象（P1）

**问题**：错误差异可能成为槽存在性 oracle。

**推荐方案**：对 Agent 暴露的按 slot 操作，将“slot 不存在”和“slot 存在但不可见”统一映射为 `SLOT_NOT_VISIBLE`，位置为 `operation`，不返回 slotId 或关系。批量操作中的隐藏项使整批失败，不能通过部分成功枚举权限边界。

### D06｜Grant 生命周期（P1）

**问题**：`expiresAt` 会引入墙钟、暂停恢复和长模型调用的不确定性。

**推荐方案**：v1 不使用时间过期；`expiresAt` 固定为 `null` 或从内部结构移除。Grant 在 ActionAttempt 终止、active generation 改变、baseRevision 失效或 Draft 终态时立即失效。时间型租约等未来并行/远程执行出现后再增加。

### D07｜Selector 结果上限（D）

**问题**：静态 selector 仍可能匹配整个 10k 槽树。

**推荐方案**：Loader 可以估算的静态复杂度加载期拒绝；运行期解析结果受 `maxSlots` 和响应分页限制。授权集合内部可覆盖完整范围，但模型的列表响应必须分页，不因响应截断改变实际 Grant。

---

## 7. E — Validator 与 Assembler

### E01｜Validator 注册形状（P1）

**问题**：scope/trigger 已有概念，缺少完整注册契约。

**推荐方案**：每项显式声明 `id`、`scope`、`trigger`、适用 selector、实现 `{ abi, path }`、执行预算 `{ cpuMs, timeoutMs, memoryMiB }`。`scope` 固定为 `slot | subtree | scaffold`，`trigger` 固定为 `merge-and-seal | seal`，ABI 首版固定 `forge-validator/v1`。未知字段、重复 id、空 selector、越界预算和不兼容 ABI 均加载失败。

### E02｜Validator 输入信封（P1）

**问题**：直接把内部 Scaffold、Grant 或存储对象传入沙箱会锁死实现并泄露控制面。

**推荐方案**：固定、只读、canonical JSON 输入信封，只包含 validator 声明 scope 内的可验证 type/spec/content/tree 投影、必要的模板声明和稳定逻辑位置；不含绝对路径、Grant、Agent、事件、任务存储位置、secret 或任意平台服务句柄。

### E03｜Validator 重跑策略（P1）

**问题**：依赖分析与缓存能提高性能，但容易产生漏跑。

**推荐方案**：v1 采用保守策略：Merge 对候选 overlay 运行所有可能受本次变更影响且 trigger 包含 merge 的 validator；无法可靠证明不受影响时就重跑。Seal 无条件运行全部强制 validator。缓存只可作为等价优化，不能成为正确性前提。

### E04｜沙箱 ABI 与确定性（P1）

**问题**：现有 JS Gate 是 CommonJS `validate(input)`，结构槽是否复用以及如何消除非确定输入。

**推荐方案**：复用“单入口纯函数”的开发体验，但使用结构槽独立 ABI 和受限执行器；模板只能引用已声明本包文件，不能加载任意 npm 包、`require`、FS、网络或进程。禁用/固定 Date、随机数、locale、环境变量等非确定来源。快照冻结执行器 ABI 与实现摘要，不直接冻结宿主绝对路径。

### E05｜执行预算与失败语义（P1）

**问题**：validator/Assembler 的 CPU、内存和超时不在十六个通用 limits 中。

**推荐方案**：每个注册项显式声明预算，且不得超过平台 hard ceiling；缺失不设默认。编译失败、异常、超时、内存越限、无效返回和 issue 超限均 fail closed，并映射为平台 code。模板实现不能自行决定把执行失败降为 warning。

### E06｜Assembler 注册与输出路由（P1）

**问题**：Assembler 如何连接 artifactSchema，且不能自行发明路径。

**推荐方案**：contract 只注册一个 Assembler，声明 `id`、`implementation { abi: 'forge-assembler/v1', path }`、预算和 `routes`。每个 route 使用稳定 `routeId` 精确映射 pipeline 中由当前 structured producer 负责、`phase: create` 的 `artifactSchema.files[].name`；annotate 阶段文件仍由后续现有 Agent 产生，不属于 Seal 输出。沙箱返回 `{ routeId, content }[]`，不能返回任意 path、producer、mediaType、required 或 phase；平台从冻结 pipeline 补齐这些控制字段，并验证 route 唯一、必填 create 文件精确覆盖、无额外输出。

### E07｜首版输出类型（P1）

**问题**：二进制文件会引入编码、流式输出、内存与内容验证的新协议。

**推荐方案**：v1 Assembler 只输出 UTF-8 文本，媒体类型限制为现有 `markdown | text` 可表达的集合；JSON 交付可先作为 text 文件并由 artifact validator 验证。binary/base64/stream 后置到新 ABI。

### E08｜确定性验证（D）

**问题**：纯函数约束仍需被测试和审计。

**推荐方案**：提供 ABI conformance fixtures；CI 对同一输入双运行并比较 manifest 与 hash；生产每次记录输入 hash、实现摘要和输出 hash。双运行是开发期检测手段，不要求生产重复执行。

---

## 8. F — `StructuredIssueV1` 与 verdict

`phase` 八值枚举和 `source` 十值枚举已经接受，不在本轮重新讨论。

### F01｜Severity 的控制权（P1）

**问题**：若模板 validator 可以自行决定 error/warning，就可能绕过强制门禁。

**推荐方案**：平台 code registry 固定每个 code 的 severity；只有 `error` 阻塞，`warning` 仅提供建议。模板 validator 返回窄 `GateIssue`，由注册时的平台适配规则映射到固定 code/severity，不能在运行期自定义或降级。

### F02｜Code registry（P1）

**问题**：只约定大写字符串不足以保证不同模块不会重复或漂移。

**推荐方案**：建立封闭、版本化的注册表；每个 code 固定 `{ source, allowedPhases, severity, detailsSchema, allowedLocationKinds }`。code 使用 `UPPER_SNAKE_CASE`，一经公开不得换义；新增 code 可以向后兼容，删除或改变语义必须升级公开契约版本。

### F03｜首批 code registry（P1）

**问题**：实施前需要一套不重复的失败分类，尤其要区分 Grammar 本身非法与某棵 Proposal 不匹配 Grammar。

**推荐方案**：首批 registry 使用下面的最小集合；同一行列出的 code 仍是各自独立注册项，不是可以自由拼接的前缀：

| 责任域 | 推荐 code | 主要语义 |
|---|---|---|
| contract | `SLOTS_CONTRACT_INVALID`、`SLOTS_REFERENCE_UNKNOWN`、`SLOTS_RESOURCE_INVALID` | exact schema、交叉引用或本包资源非法 |
| compatibility | `TEMPLATE_RUNTIME_UNAVAILABLE` | 当前环境无法满足已冻结 snapshot；保持现有已接受语义 |
| Slot Schema | `SPEC_SCHEMA_INVALID`、`CONTENT_SCHEMA_INVALID`、`CONTENT_REQUIRED`、`CONTENT_FORBIDDEN` | 实例值与类型契约不符；code 可跨 draft/merge/seal_input 复用 |
| Grammar 静态引用 | `LAYOUT_GRAMMAR_NODE_INVALID`、`LAYOUT_GRAMMAR_REFERENCE_UNKNOWN`、`LAYOUT_GRAMMAR_PRODUCTION_UNREACHABLE` | AST、type/production 引用或可达性非法 |
| Grammar 静态终止性 | `LAYOUT_GRAMMAR_NULLABLE_REPEAT`、`LAYOUT_GRAMMAR_NON_TERMINATING` | repeat 消费空表达式或可达 type 无有限完整 production |
| Grammar 静态歧义 | `LAYOUT_GRAMMAR_CHOICE_AMBIGUOUS`、`LAYOUT_GRAMMAR_OPTIONAL_FOLLOW_CONFLICT`、`LAYOUT_GRAMMAR_REPEAT_FOLLOW_CONFLICT` | FIRST/FOLLOW 不能唯一决定下一步 |
| Proposal/结构实例 | `PROPOSAL_CLIENT_KEY_DUPLICATE`、`STRUCTURE_ROOT_TYPE_INVALID`、`STRUCTURE_PRODUCTION_MISMATCH` | 候选树身份或 children 序列非法；Grammar 本身已经通过 Loader |
| access | `SLOT_CAPABILITY_REQUIRED`、`SLOT_NOT_VISIBLE`、`SLOT_WRITE_FORBIDDEN` | 会话能力或服务端 Grant 不允许操作 |
| lifecycle | `PROPOSAL_NOT_OPEN`、`DRAFT_NOT_OPEN`、`DRAFT_STALE`、`SCAFFOLD_NOT_ACTIVE`、`COMMIT_CANDIDATE_STALE` | 候选对象、generation、revision 或 turn 绑定已经失效 |
| limits/idempotency | `RESOURCE_LIMIT_EXCEEDED`、`IDEMPOTENCY_CONFLICT` | details 中用封闭 `limitName` 或 operation 标识具体边界 |
| validator | `VALIDATOR_REJECTED`、`VALIDATOR_UNAVAILABLE`、`VALIDATOR_RESULT_INVALID` | 业务规则拒绝、执行未完成或返回不符合 ABI |
| Assembler | `ASSEMBLER_FAILED`、`ASSEMBLER_UNAVAILABLE`、`ASSEMBLER_RESULT_INVALID` | 受信实现异常/超时/资源失败，或 route 结果非法 |
| artifact/publish | `ARTIFACT_SCHEMA_MISMATCH`、`ARTIFACT_INTEGRITY_FAILED`、`PUBLISH_FAILED` | Seal 输出不符、custody hash 不符或最终发布失败 |

Grammar 静态 issue 的 primary location 指向 contract AST 节点，冲突分支放 related locations；歧义 details 只给有界 `conflictingTypeIds`。`STRUCTURE_PRODUCTION_MISMATCH` 指向 Proposal/slot 的具体 children 位置，details 给 `childIndex`、`actualTypeId` 和有界 `expectedTypeIds`，不复制整棵树。

异常、超时和内存越限可以共享 `*_UNAVAILABLE`，由 details 中封闭 reason 区分，不为每个执行器和 phase 复制近义 code。已冻结的 `DRAFT_STALE` 和 `TEMPLATE_RUNTIME_UNAVAILABLE` 保持原义；阶段差异由 `phase` 表达。

### F04｜`details` 安全形状（P1）

**问题**：任意 JSON 日志袋难以授权过滤，也容易泄露 content 和工程信息。

**推荐方案**：每个 code 使用 exact 判别 schema；只允许有界标量和短数组，例如 keyword、expectedType、actualType、limit、actualCount、validatorId、routeId。默认不回显用户 content、spec、完整 schema、堆栈、绝对路径或内部 ID；需要证据时只接受长度受限、平台规范化的说明。

### F05｜Verdict 包装（P1）

**问题**：单一 `pass: boolean` 无法区分“确实失败”和“强制检查没有完成”。

**推荐方案**：统一使用：

```ts
interface StructuredVerdictV1 {
  version: 1;
  status: 'passed' | 'failed' | 'incomplete';
  issues: StructuredIssueV1[];
  truncated: boolean;
  summary: { errors: number; warnings: number };
}
```

`incomplete` 表示 required evaluator 未运行完、执行环境不可用或结果无法可信判定，并与 `failed` 一样阻止权威提交。`passed` 要求无 error 且全部强制检查完成；warning 可以共存。

### F06｜授权、排序与截断顺序（P1）

**问题**：先截断再过滤可能导致授权主体看到空列表但无法判断失败，也可能暴露隐藏问题数量。

**推荐方案**：平台先在内部完成 verdict，再按主体授权投影 issue，按固定顺序排序，最后应用公开返回上限。隐藏 primary location 对应的 issue 被抑制或映射为固定 `operation` code；不能只替换位置而保留敏感 details。公开 summary 只统计可见投影；若隐藏 error 仍阻塞当前操作，返回不泄露数量和对象的通用 operation issue。

---

## 9. G — 持久化、事件与恢复

### G01｜事实存储形态（P0｜需要重点确认）

**问题**：完整 scaffold 和 content 可能达到几十 MiB；全部写入现有 TaskEvent 会让事件流膨胀，而只维护可变 JSON 又会削弱追加事实和崩溃恢复。

**推荐方案**：采用三层混合模型：

1. **现有 TaskEvent** 只记录权威状态转换和不可变对象摘要；
2. **task 内不可变、内容寻址 blob** 保存规范化 scaffold generation、content revision snapshot、Seal 输入与大对象；
3. **私有 Proposal/Draft journal + checkpoint** 保存未提交候选状态，终态后只读。

事件通过 digest 引用 blob；blob 永不原地改写。投影器从最近可验证 checkpoint 加后续事件恢复。首版只做 task 内去重，不做跨 task 全局 blob 去重，避免生命周期、权限和删除耦合。

**备选与影响**：全事件 payload 实现概念简单但存储与重放成本过高；数据库式可变行更高效但需要另造事务事实源。推荐混合模型最贴合当前 append-only event 与 ArtifactStore 的 staged commit 思路。

### G02｜权威事件最小集合（P1）

**问题**：每次草稿写入和建议性校验是否都应进入主事件联合。

**推荐方案**：主 TaskEvent 只新增权威边界事件，例如 generation committed/activated/superseded、Draft opened/merged/terminal、scaffold sealed。Proposal 整树替换、Draft content 替换、建议性 validation 和 checkpoint 属于各自私有 store/journal，不进入全局业务事件流；提交事件携带它们的最终摘要和 blob 引用。

### G03｜身份与幂等键（P1）

**问题**：正文同时出现 ActionAttempt、turn、request ID 和提交身份，容易重复建模。

**推荐方案**：当前代码的 `turnId` 就是结构槽语义中的 `actionAttemptId`，不再创建平行 ID。Proposal/Draft 使用平台基于 turn 上下文的 get-or-create 身份；每次模型工具调用使用平台已有 `toolCallId` 作为 request idempotency key，模型不传 requestId。权威 commit 另生成稳定 receipt key，并保存原结果用于响应丢失后的重放。

### G04｜Blob 身份与删除（D）

**问题**：大对象摘要、去重和任务删除需要一致规则。

**推荐方案**：blob id 为 `forge-canonical-json/v1` 字节或原始 artifact 字节的 SHA-256；路径由平台安全派生，事件只保存 digest、byteLength、kind 和协议版本。blob store 归属于单个 task，任务删除时随 task 一并清理；不接受模型提供路径或 digest。

### G05｜崩溃安全提交（P1）

**问题**：事件已写但 blob 未就绪，或 blob 已写但事件未提交，都会产生不完整状态。

**推荐方案**：沿用 ArtifactStore 思路：写 staging、fsync/校验 digest、追加权威 event、原子 rename/claim 到 digest 目录；恢复器根据 event 和 hash 完成 claim 或清理无主 staging。事件是可见性的权威，未被事件引用的 staging 永不当作已提交。

### G06｜私有 checkpoint（D）

**问题**：整树 Proposal 和多次 Draft 替换若只重放 journal，恢复会逐渐变慢。

**推荐方案**：达到固定操作数或累计字节阈值后写不可变 checkpoint，journal 从该点继续；checkpoint 也要 hash 校验。只压缩私有候选日志，不压缩或改写主 TaskEvent。阈值属于部署调优，不进入模板契约。

### G07｜终态保留（P1）

**问题**：merged/stale/abandoned 草稿是否立即清理。

**推荐方案**：随 task 保留为只读审计记录直到 task 删除；运行投影只索引 open/active 对象，终态对象不进入 Assembler。以后如需独立保留期，应由平台数据治理策略处理，不由模板决定。

---

## 10. H — Slot Tool、ForgeAction 与 TurnContract

### H01｜保留九个 ForgeAction，并延迟权威提交（P0｜需要重点确认）

**问题**：结构槽操作是否应扩充平台现有封闭九动作 registry。

**推荐方案**：九个 ForgeAction 不变。结构槽增加一套**上下文绑定的封闭 Slot Tool registry**，性质类似现有 workspace/read-only tools：Proposal/Draft 的读写与自检立即作用于私有 store；`submit_structure_proposal`、`submit_draft`、`request_seal` 分别运行完整 Gate 并冻结 structure/merge/seal commit candidate，但暂不改变权威 scaffold 或 artifact。模型仍必须用现有 dispatch action 结束 turn；ActionCommitter 校验 candidate 后，才把权威状态转换与 dispatch 一起做可恢复提交。

**影响**：不破坏现有 ActionCommitter 和基础模式契约，也避免把每个领域内操作都升级为全平台 ForgeAction。相比“工具成功就立即 merge”，它不会在 dispatch 失败时留下已变更 scaffold；代价是工具返回的是已通过 Gate 的候选 receipt，权威 revision 只在 turn commit 后可见。

### H02｜Structured TurnContract v3（P0｜需要重点确认）

**问题**：现有 TurnContract v2 只表达 production/annotate/dispatch，无法冻结当前 turn 是否可以编排、填槽或 Seal，以及使用哪个 profile。

**推荐方案**：新增 `TurnContract.version: 3`，保留 v2 的 `dispatch` 语义，并为 structured mode 增加互斥的 `slotSession`：

```ts
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
    };
```

Loader 验证 kind、capabilities、profile 和 Agent 上限一致。basic 模板继续要求 v2；structured 模板使用 v3。历史 snapshot 保持原版本和原可运行性规则，不被就地改写。

一个 v3 turn 只能声明 `slotSession`，不能同时声明 v2 的 `production` 或 `annotate` 能力；它继续复用同一份 `dispatch` 契约。这样模型不会在同一个 turn 中同时调用 `finish_production`、`annotate_artifact` 和结构槽提交工具。

**备选方案**：把这些字段散落到 pipeline Action 或 Agent YAML。这样短期少一个 TurnContract 版本，但运行时需要跨文件猜测本 turn 的完成条件，也削弱现有“TurnContract 是模型工具与提交边界”的设计。推荐 v3。

### H03｜ActionAttempt 复用 `turnId`（P1）

**问题**：主设计使用概念名 ActionAttempt，而当前实现的稳定执行身份是 turnId。

**推荐方案**：实现和公共事件统一复用 `turnId`；设计文档可保留 ActionAttempt 作为语义名称，并明确二者一一对应。重试创建新 turnId，因此默认创建新 Proposal/Draft；旧私有对象进入 abandoned，符合现有设计。

### H04｜工具幂等（P1）

**问题**：正文称模型每次写入携带 request ID，但工程键不应由模型生成。

**推荐方案**：由工具运行器提供稳定 `toolCallId`，Slot Tool 从执行上下文读取。相同 toolCallId + 相同规范化参数重放原结果；相同 key + 不同参数返回冲突 code。模型参数 schema 不出现 requestId、turnId、draftId、revision 或 Grant。

### H05｜提交完成与 dispatch（P1）

**问题**：Proposal/Merge/Seal 成功后，现有“一 turn 恰好一次 dispatch”如何继续。

**推荐方案**：Slot session 达到 TurnContract 的 completion 后禁止进一步写操作，平台向同一 turn 注入一个安全 receipt 摘要；模型随后只能执行允许的 dispatch 或请求人工输入。ActionCommitter 在 commit 时验证 completion receipt 与当前 revision/turn 一致，再原子落权威事件和 dispatch。turn 失败、取消或 receipt 失配时 candidate 转为 abandoned，staging 可恢复清理，权威状态不变。模型看不到 blob、Grant 或内部提交 ID。

### H06｜不引入隐式工作队列（P1）

**问题**：为了逐槽填充，运行时可能自然演化出“自动拿下一个未填槽”。

**推荐方案**：v1 明确禁止该行为。Action 的 profile 静态解析范围，Agent 在一个 Draft 中处理整个 writable set；后续 Route 由现有 pipeline 决定。任何逐实例领取、锁、游标和动态 anchor 都作为未来 Slot Scheduler 协议单独设计。

---

## 11. I — TaskWorkspace、API、Agent 投影与 UI

### I01｜TaskWorkspace 最小扩展（P1）

**问题**：现有客户端需要知道结构槽进度，但不能下载整棵槽树才能显示列表。

**推荐方案**：在现有 TaskWorkspace 响应中增加可选 `structuredSlots` 摘要；basic task 字段缺失且响应保持兼容。摘要只包含 mode、active generation 摘要、contentRevision、structure/seal status、可见槽计数、填充计数和 issue summary，不内嵌 content、完整树或私有 Draft。

### I02｜只读结构槽 API（P1）

**问题**：模型工具、UI 和审计读取是否共用内部 store 接口。

**推荐方案**：内部统一投影服务，外部提供独立只读 REST：contract projection、tree outline/subtree、slot detail、visible issues、SealRecord。人类 UI 首版没有写 API；模型写操作只通过绑定 turn 的 Slot Tool，防止绕过 Agent/Action 权限。

### I03｜分页与按需内容（D）

**问题**：10k 节点和大 content 不能随 workspace 一次返回。

**推荐方案**：outline 采用稳定 DFS 顺序和不透明 cursor；subtree 请求有 depth/page 限制；content 仅按单槽或小批量显式读取。cursor 绑定 scaffold generation、revision、授权投影和排序版本，变化后失效而不是返回混合快照。

### I04｜UI v1 范围（P1）

**问题**：是否同时建设类似 Notion 的块编辑器。

**推荐方案**：首版 UI 只做树形大纲、类型/spec/content 只读查看、状态、issue 定位、Draft/merge 审计和 sealed outputs 链接。没有拖拽、块编辑、人工 Merge 或文件反向同步。

### I05｜Agent 投影（P1）

**问题**：结构 Agent 和填充 Agent 需要的信息不同。

**推荐方案**：结构会话只获得可创作的 type、specSchema、Grammar、limits 和安全说明；填充会话只获得 Grant 授权的树投影、spec、有效 content 与 issue。两者都不获得实现路径、validator/Assembler 源码、ACL、宿主路径、事件 ID、Grant ID 或隐藏节点统计。

### I06｜更新机制（D）

**问题**：结构槽是否需要新增实时推送基础设施。

**推荐方案**：复用现有 task watch/polling 与事件投影机制；首版串行 case 不需要协同光标或实时 patch stream。UI 对 revision 变化刷新相关只读投影即可。

### I07｜Prompt 中的数据与指令边界（P1）

**问题**：slot spec/content 可能包含类似系统指令的文本；若直接拼接进 prompt，隐藏控制面和工具授权可能被内容注入影响。

**推荐方案**：Agent runtime 用带类型、来源和 slotId 的结构化数据区块投影槽内容，并明确其为待处理数据，不把 content 拼入 system prompt、工具说明或模板控制指令。授权始终由服务端 SlotGrant 执行，不能依赖模型遵守文本说明；content 中出现工具名、角色名或“忽略规则”等文本不改变 capability。trace 和 issue 继续按授权与长度规则脱敏。

---

## 12. J — Seal、artifact custody 与最终提交

### J01｜Seal 与 turn commit 的原子边界（P0｜需要重点确认）

**问题**：若 `request_seal` 工具调用立即把正式 artifact 发布，而 turn 随后的 dispatch/commit 失败，就会出现结构槽已封存但现有执行图未前进的半提交状态。

**推荐方案**：`request_seal` 完成全量 Gate、Assembler 和输出校验后，只产生一个与当前 `turnId + scaffoldRevision` 绑定的**sealed candidate**，文件留在 custody staging，尚不成为可路由 artifact。模型完成允许的现有 dispatch 后，由 ActionCommitter 再检查 revision，并把 artifact version、SealRecord、sealed 状态和 dispatch 事件作为同一个可恢复 commit 发布。

**影响**：Seal 的业务原子性与现有 turn/action 原子性对齐，不会出现正式文件先于流程状态。代价是 Slot Tool 与 ActionCommitter 之间需要一个候选 receipt 协议。

### J02｜`publish_artifact` / `submit_final_artifact` 映射（P0｜需要重点确认）

**问题**：现有 `publish_artifact` 只发布当前 turn 的 sealed production package，`submit_final_artifact` 只提交 inputVersion；结构槽 Seal 应落在哪条链上。

**推荐方案**：

- structured `seal` turn 的 sealed candidate 被视为该 turn 唯一可提交 production package；`publish_artifact` 可以把它发布到声明的 artifact Route；
- 若该 Agent 是 pipeline 的 final submitter，TurnContract v3 可以允许 `submit_final_artifact` 直接提交当前 turn 的 sealed candidate，而不仅是 inputVersion；
- 无论哪条路径，现有 `final_submission_accepted` 继续是 task 完成的唯一权威事件；Seal 成功本身不自动把 task 标记完成；
- 非 seal turn 不能引用旧 candidate，响应丢失只通过同一 commit receipt 重放。

**备选方案**：Seal 一律先 publish 给下一个 final Agent，再由其 submit inputVersion。它完全复用现有 submit 语义，但会强迫所有结构槽 pipeline 多一个无业务价值的 Agent/turn。建议让 v3 显式支持当前 turn sealed candidate，同时保留转发/审核链。

### J03｜SealRecord 连接 artifact version（P1）

**问题**：当前概念 SealRecord 只有 outputs hash，无法直接定位 custody 中的正式版本。

**推荐方案**：提交后 SealRecord 增加 `artifactId`、`artifactVersion` 或一个现有不可变 ArtifactVersionRef；继续保留每个 route/path 的 byteLength 与 SHA-256。SealRecord 不保存 staging 路径。

### J04｜输出路径与现有 artifactSchema（P1）

**问题**：现有 `artifactSchema.files[].name` 是受控文件名，而概念 Assembler 支持 path。

**推荐方案**：v1 route 必须一一映射当前 structured producer 负责、`phase: create` 的现有 artifactSchema file name，且只允许安全单段文件名；Assembler 只返回 routeId。annotate 文件不参与该映射。嵌套目录、多 route 写同一路径和动态 content 派生文件名全部后置。这样可直接复用现有 ArtifactStore 和文件契约。

### J05｜格式与媒体类型（P1）

**问题**：SealRecord 的 `mediaType` 与 pipeline 当前 `markdown | text` 如何统一。

**推荐方案**：平台按 artifactSchema/finalOutput 冻结映射：markdown 为 `text/markdown; charset=utf-8`，text 为 `text/plain; charset=utf-8`。Assembler 无权自行声明 mediaType。以后增加 JSON/binary 时同时升级 pipeline schema 与 Assembler ABI。

### J06｜Seal 幂等身份（P1）

**问题**：同 revision 重复请求和提交响应丢失需要稳定识别。

**推荐方案**：区分两个身份：稳定的 Seal 内容身份由 task、scaffoldId、revision、snapshotHash、Assembler 实现摘要和规范化输入 hash 派生；attempt receipt 另外绑定 `turnId + toolCallId`。同一 Attempt 重放返回同一 candidate；已经权威提交的同一内容身份返回原 SealRecord。未提交 candidate 随 Attempt 终止而废弃，新 Attempt 可以复用已验证的内容寻址字节作为优化，但必须重新签发 receipt、复核 active revision，并重新进入 ActionCommitter。若 active revision 已变化则 fail closed，不自动把旧请求应用到新 revision。

### J07｜Custody 恢复（D）

**问题**：多文件候选在进程崩溃时不能产生半个 artifact version。

**推荐方案**：复用现有 ArtifactStore 的 stage → event/commit → atomic rename/claim 协议；所有 route 文件、manifest 和 SealRecord 作为一个 commit 单元。恢复器按事件和 hash 完成或清理，不从目录存在性猜测提交成功。

---

## 13. K — 不需要产品逐项决策的实施默认项

以下内容建议直接写入后续 dev plan，由代码审查、测试和基准验证，不再单独逐项讨论：

### K01｜模块边界（D）

保持现有 template loader、scheduler、ActionCommitter、ArtifactStore 和 task projection 为唯一入口；结构槽新增 contract/schema/grammar、projection/access、proposal/draft、gate、assembler adapter、persistence projection 等内聚模块，不复制一套 Task 或 Template 服务。

### K02｜运行时 exact schema（D）

所有磁盘、事件、API 和模型工具边界使用 TypeBox/现有 schema 体系的 exact object 校验；未知字段 fail closed。TypeScript interface 不是运行时校验替代品。

### K03｜测试矩阵（D）

至少覆盖：Loader/规范化 golden tests、Schema 和 Grammar 属性测试、FIRST/FOLLOW 歧义、selector 授权不泄露、Draft 生命周期与幂等、事件/Blob 崩溃恢复、validator/Assembler 沙箱逃逸与预算、Seal 多文件原子性、历史 basic snapshot/hash 回归、API/UI 授权投影。

### K04｜性能索引与基准（D）

实现应为 active scaffold、revision、slot parent/order/type、Draft changed slots、事件序号和 blob digest 建立直接索引；禁止每次读单槽都反序列化全 64 MiB scaffold。hard ceiling 冻结前执行 10k 槽、深度 32、最大 Draft、500 issues 和最大 Seal 输出基准。

### K05｜迁移策略（D）

structured mode 以纯新增 schema 和事件版本上线；未声明 `productionMode` 的模板、TurnContract v2 basic snapshot、现有 artifact version 和前端响应必须保持现状。首版不提供 basic task 转 structured task、历史 task 重写或自动模板升级。

---

## 14. 建议的批量决策方式

推荐按以下三组一次性处理：

1. **先确认四组 P0**：D03 selector 边界、G01 混合持久化、H01/H02 Slot Tool 与 TurnContract v3、J01/J02 Seal 与 artifact 链。
2. **其余 P1 整组接受或按编号提出例外**：它们共同形成可实施的封闭契约。
3. **D 类直接授权进入 dev plan**：具体数值和性能参数以测试结果校准，但不得改变已接受的语义边界。

评审完成后，应把接受结论合并回权威设计文档的对应章节，并把本清单标记为已处理；后续 dev plan 只引用权威设计，不把本文当作运行规范。
