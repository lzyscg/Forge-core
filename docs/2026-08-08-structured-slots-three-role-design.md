# 结构化槽位 + 三角色生产机制 - 设计文档（Design）

> 状态：**设计草案（Draft）**，用于设计回看与交接给实施 agent。尚未进入 dev-plan。
> 背景：承接 outline-designer（远端已实现）之后的 4 个 skill（outline-drafter / chapter-packet / chapter-drafter / production-director）落地评估，识别出平台缺一个通用能力；本设计将其形式化。
> 实施谱系：**远端 standalone**（`/Users/lzy/Desktop/ForgeCore`），9 动作 + 产物版本目录 + live update，且已完成渐进式披露 / 门禁执行环境 / 回合内压缩 / outline-designer 模板（见远端 `HANDOFF.md`）。
> 本文是**设计文档**，非 dev-plan。实施前以**远端实际代码**为准；本文假设的符号若与远端不符，以远端为准并记录偏差。
> 关联文档：`docs/2026-08-07-platform-enhancements-spec.md`（gate-runner 先例）、`docs/2026-08-07-artifact-version-directory-spec.md`（v2 产物版本目录制）、远端 `README.md`（铁律与架构）。

---

## 0. 术语

| 术语 | 含义 |
|---|---|
| **槽位（slot）** | 产物内部一个可被编号、可被单独填/审/校验的结构单元 |
| **脚手架（scaffold）** | 一个产物的有序槽位集（可树状嵌套）；定义产物的形状 |
| **编排（orchestrate）** | 设计产物槽结构（哪些槽、顺序、角色、规则）的角色 |
| **填空（fill）** | 在编排好的槽里填内容的角色 |
| **审核（audit）** | 把填好的产物投影回槽位、逐槽校验的角色 |
| **投影-回收-复校** | 审核的三步把戏：平台投影成带 id 的槽视图 → 模型报 id+判断 → 平台按 id 回填冻结真文复校 |

---

## 1. 背景与动机

### 1.1 5 个 skill 构成的产线

这套 skill 是「仿写知乎短故事」的完整产线，外加一个监工：

```
production-director ── 监工（生产系统之外，追溯/路由返工/签发交付）
  │
  ├─ outline-designer      原文 ──7轮──> imitation-blueprint.md（结构门禁）   ← 远端已实现
  │
  └─ 逐章循环（N 章）:
       chapter-packet        大纲 ──编译──> 无剧透执行包 + 审核 + 状态账本（4 操作 A/B/C/D）
         ├─ chapter-drafter   执行包 ──7轮──> 单章正文（信息隔离，只看包）
         └─ packet 审核 drafter 输出 ──通过──> 更新账本 ──> 编译下一章
  │
  └─ 全文终审 + 交付证书

  outline-drafter           上面这条线的「直接写作」替代路径：单章/无反转隔离时单 Agent 直接写正文
```

- **outline-designer**（原文→大纲，7 轮自循环 + 结构门禁）：远端已实现。
- **outline-drafter**：自适应正文写作。单章单 Agent 直接写（5 过程产物）；多章路由到隔离流水线。
- **chapter-packet**：大纲与正文之间的隔离层。4 操作（初始化/编译/审核/更新账本），持完整大纲私有蓝图，只把无剧透执行包交正文模型。带 `controller_artifact.py` fail-closed 校验链 + 8 份 JSON schema。
- **chapter-drafter**：单章正文，7 轮自循环，只收执行包。带 `validate_chapter_output.py` / `validate_repair_scope.py`。
- **production-director**：总控监工。事件哈希链 + 产物依赖图 + attempt-vault，定位最早责任节点、打回、失效下游、签发交付证书。

### 1.2 评估结论（详见对话记录）

| skill | 工作流能否实现 | 阻碍 |
|---|---|---|
| outline-drafter | ✅ 直接可实现 | 无（复刻 outline-designer 模板形态） |
| chapter-drafter | ✅ 可实现 | 2 个 Python 校验器迁 JS（repair-scope 要多输入，小改） |
| chapter-packet | ⚠️ 拓扑能，完整 rigor 不能 | `controller_artifact.py` 是多步有状态控制器，远超单次 gate |
| production-director | ⚠️ 大部分与平台重复 | 下游失效级联 / 最早责任节点回退 / 事件哈希链 / 全文终审 |

两个**原生优势**让这套产线在 Forge Core 里反而更省力：

1. **信息隔离是平台自带的**：`route.inject` + 每 Agent 独立 workspace **物理强制**--正文模型只能收到 packet 经 `publish_artifact` 发出、并由 route.inject 逐文件注入的内容，私有蓝图永远进不了正文 Agent 上下文。skill 里那些「不得读取」硬规则，平台层兜住。
2. **7 轮单 Agent 自循环已验证**：outline-designer Phase 4-5 实测 22 次工具调用、渐进式披露生效、上下文不爆。chapter-drafter / outline-drafter 都是同构 7 轮单 Agent。

### 1.3 收敛到一个通用缺口

chapter-packet 的 `controller_artifact.py` 暴露的不是一个「审核专用」缺口，而是一个**通用能力缺口**：平台没有「结构化槽位」机制--没有把产物表达成一组可编号、可单独填/审/校验的结构单元的能力。

进一步认识到：**这个机制不是审核专用，生成与审核通用**；而且 Forge Core 现有概念里**已经存在三个角色的退化形态**，只是粒度粗、没显式化。本设计把这个通用机制形式化，并把它组织成「编排 / 填空 / 审核」三角色生产机制，作为整个生产系统的**生产过程底层**。

> 注：本设计聚焦结构化槽位 + 三角色（覆盖 chapter-packet 的 rigor 缺口）。production-director 的另外两个缺口--**下游失效级联（supersede 链）** 与 **事件哈希链**--是 custody 层的独立问题，不在本设计范围内，见 §9。

---

## 2. 核心抽象：结构化槽位

### 2.1 槽位与脚手架

**槽位（slot）** 是产物内部一个可被编号、可被单独填充/审核/校验的结构单元：

```ts
interface Slot {
  id: string;            // 稳定标识。平台拥有：静态槽由模板声明，动态槽由投影函数分配
  position: number | string;  // 在产物中的位置/顺序（支持嵌套树：章 -> 场景 -> 子槽）
  role: string;          // 这格放什么（语义角色，模板定义，业务词只在此处）
  format: SlotFormat;    // 格式约束（段落 / JSON / 字数区间 / 必带标签 等）
  validator: string;     // 这格的校验规则（模板给的 JS 文件路径，沙箱执行，同 gate 校验器）
  content: string | null;// 格子内容。填空方向=模型填；审核方向=投影从产物提取
}
```

**脚手架（scaffold）** = 一个产物的有序槽位集，可树状嵌套。脚手架定义产物的形状。两种来源：

- **静态脚手架**：模板声明（退化形态 = 现有 `artifactSchema.files[]`）。
- **动态脚手架**：编排器 Agent 生成（如 chapter-packet 编译场景卡），或投影函数从已有产物提取（审核方向）。

### 2.2 两个方向，一个抽象

两个方向只差一件事--**槽里的内容是谁放的**。共同内核不变：编号是平台的，规则是模板的，模型只碰「内容（填）」或「判断（报编号）」，平台复校。

**方向 A - 填空（生成）**：

```
模板/编排器 声明脚手架（N 个槽，各有 role/format/validator）
  -> 填空器读脚手架，逐槽填 content
  -> 平台拼装成产物，逐槽跑 validator + 跨槽校验（顺序/覆盖/互斥）
  -> finish_production 时：漏填 / 格式错 / 跨槽顺序错 -> 拦下
```

**方向 B - 投影-回收-复校（审核）**：

```
平台跑模板给的投影函数 P(产物) -> 带稳定 id 的槽位视图（id 平台拥有，真文冻结）
  -> 审核器只看到 id 视图，输出「id + 判断」的语义 JSON（不碰真文）
  -> 平台按 id 回填冻结真文，逐槽复校： cited id 真实存在？ cited 真文满足该槽规则？覆盖全（有无未认领槽=废段）？
  -> fail-closed：模型自报审核不经过这步不能进账本/返修
```

**为什么骗不了**：模型从头到尾没碰过真实产物正文--填空方向它只往格子里放内容、审核方向它只报编号。编号是平台的，真文也在平台手里。所以模型没法伪造证据（只能报真编号）、没法跳过（平台知道全部编号）、没法靠改写蒙混（平台用冻结原文）。

### 2.3 两方向可串联：完整闭环

```
编排器声明脚手架 -> 填空器逐槽填 -> 审核器投影回槽位逐槽审
```

outline-designer 的 blueprint 就是这个完整闭环：13 节脚手架 → 填 → `validate-blueprint.js` 逐节查。**现状是用一个整块 gate 事后查**；做成槽位后，填和校验都是逐槽的、统一的，且模型对着空格填比对着一段要求自由写更不容易漏。

### 2.4 具体例子（以 outline-designer blueprint 为例）

blueprint 的结构天然是一个脚手架：

```
scaffold: blueprint
  slot[1..13]: 二级标题章节（role=章节, format=## 标题+7个三级段）
    slot[1.1..1.7]: 该章三级段（role=段落, format=### 标题+正文）
      slot[1.1.P0]: 该段 P0（role=重点, format=必带 [FACT|OBS @Lx-Ly], validator=冷开场P0不得写「无」）
```

- **填空方向**：模型按脚手架逐章逐段填，P0 槽的 validator 当场校验标签。
- **审核方向**：投影函数把已生成的 blueprint 切成上面的槽位树，审核器逐槽查「P0 是否带标签 / 章节顺序 / 段落数」，平台复校。

现有 `templates/outline-designer/gates/validate-blueprint.js` 就是这个脚手架的退化审核器（整块校验，非逐槽）。槽位机制把它升级成：脚手架声明在模板 + 逐槽填 + 逐槽审。

---

## 3. 三角色生产机制

### 3.1 三角色定义

| 角色 | 职责 | 输入 | 输出 |
|---|---|---|---|
| **编排（orchestrate）** | 设计产物槽结构：哪些槽、顺序、角色、格式、校验规则 | 全图（完整大纲/蓝图） | 脚手架（slot 结构 + 规则） |
| **填空（fill）** | 在编排好的槽里填内容 | 脚手架（只看要填的槽，不见全图） | 填好的产物 |
| **审核（audit）** | 把填好的产物投影回槽位、逐槽校验 | 填好的产物 + 脚手架规则 | 逐槽 verdict（通过/缺失/越界）+ 返修单 |

### 3.2 各角色的谱（退化 / 完整形态）

每个角色不是非黑即白，有退化形态和完整形态。**Forge Core 现在三个角色全有，都在退化形态**：

| 角色 | 退化形态（现状） | 完整形态（槽位机制） |
|---|---|---|
| 编排 | 模板写死的 `artifactSchema`（文件级、静态） | Agent 动态设计子槽脚手架 / 模板声明子槽 schema |
| 填空 | writer Agent 写整篇文件 | Agent 逐槽 fill，平台拼装 |
| 审核 | gate runner（自动、只查结构、无语义） | Agent 投影复校（语义 + 结构） |

**槽位机制做的事 = 把这三个退化角色升级成一等的、子文件粒度的、可组合的。** 不是推倒重来，是把已有的粗粒度雏形做细、做正式。这跟「三角色一直是底层、只是之前没显式说出来」是一致的。

### 3.3 标准生产形状

```
编排器 ──设计脚手架（槽位+规则）──> 填空器 ──逐槽填──> 审核器 ──投影复校──>
   ↑                                                       │
   │  脚手架本身错了（槽设计错）                             │
   └────────────── 审核打回，按槽归因 ──────────────────────┘
                       │ 槽内容错了
                       └──> 回填空器（只改命中槽，其余冻结）
```

审核按槽归因直接喂 production-director 的「最早责任节点」：某槽失败 → 是槽规则错（编排器锅）还是槽内容错（填空器锅），路由到对应角色。director 的回退路由有了结构化依据，不再是模糊判断。

---

## 4. 与 v2 的关系：正交分层，叠加不替换

**这条是本设计最重要的边界**：三角色不是要替换现有 v2 模型，它叠在 v2 之上，是「生产过程」底层，与 v2 的「custody」底层正交。

| 层 | 管什么 | 现有符号 |
|---|---|---|
| **custody（v2）** | 版本/路由/事件/单一执行槽/交付门禁 | 9 动作、artifact 版本目录、event-store、route.inject、action-committer |
| **production（三角色）** | 产物怎么被做出来：设计槽 → 填槽 → 审槽 | （新增）槽位 schema、fill_slot / read_scaffold、投影 + 逐槽校验 |

两层正交：一个 Agent 扮演「填空器」时，照样用 `finish_production` / `publish_artifact`（v2 动作）托管它填好的产物；扮演「审核器」时，照样用 `annotate_artifact` 记 verdict。**三角色是 v2 动作 + 槽位工具的组合模式，不替代 9 动作**。现有的 writer / reviewer / controller 就是粗粒度的 填空器 / 审核器 / （编排+协调）。

### 4.1 每个角色用哪些 9 动作 + 新槽位工具

| 角色 | 现有 9 动作 | 新增槽位工具 |
|---|---|---|
| 编排器 | `write_workspace`（设计脚手架）+ `publish_artifact`（发给填空器） | （声明脚手架的 schema 写入） |
| 填空器 | `read`（读注入的脚手架）+ `finish_production`（封存填好的产物）+ `publish_artifact` | `read_scaffold`（看空格）+ `fill_slot(id, content)`（逐槽填） |
| 审核器 | `read`（读注入的产物）+ `annotate_artifact`（记 verdict）+ `send_message`（返修）/ `forward_input_version`（接受） | `read_indexed`（读带 id 的投影视图）+ 逐槽复校（平台侧） |

新槽位工具与现有 `read_skill_section` / `validate_artifact` 同层：**只读注入，不进 ActionBuffer，不产事件**（除填空器 `fill_slot` 写 workspace 外）。

---

## 5. 信息隔离与按槽归因

三角色落到不同 Agent 时，信息隔离天然成立，且由平台物理强制：

- **编排器**看全图（完整大纲），设计脚手架；
- **填空器**只收脚手架（要填的槽），看不见全图；
- **审核器**收填好的产物 + 脚手架规则，逐槽查。

这正是 chapter-packet 的隔离模型（packet = 编排 + 审核，drafter = 填空），平台用 `route.inject` 物理强制（已核实 `task-runner.ts`：接收方只拿到 `delivery.inject` 声明的文件，发送方 workspace 不外泄）。

`route.inject` 还能从「注整个文件」细化到「注某个槽位」--给后章只喂前章某个槽，不是整篇。这对 chapter-packet 的信息隔离是加强（后章正文模型只收状态账本的特定槽，不见全文历史正文）。

**按槽归因** 给 production-director 的回退路由提供结构化依据：审核 verdict 是逐槽的，每个失败槽可归因到编排器（规则错）或填空器（内容错），director 据此路由返工到对应角色/节点，而非模糊地「回退正文」。

---

## 6. 铁律边界

| 铁律 | 本设计如何遵守 |
|---|---|
| 平台零业务词 | 平台只做「槽位引擎」（声明/填/投影/逐槽校验/拼装/按 id 回填）。槽位引擎模块（建议 `slot-engine.ts` / `slot-projection.ts` 等）不含 blueprint/章节/P0/触发 等业务词。三角色名（编排/填空/审核）是平台词，无业务含义。 |
| 校验器属模板 | 脚手架定义 + 投影函数 + 每槽 validator = 模板提供，冻结进 snapshot，沙箱执行。与 gate-runner 同一套隔离边界（isolated-vm，无 FS/网络/require，CPU/内存限额）。 |
| 事件只追加 | 槽位是产物内部结构，不改事件联合、不改版本目录存储（custody 层不变）。新工具只读不产事件（填空写 workspace 除外）。 |
| 模型不碰工程数据 | 模型只填内容 / 报 id+判断，不接触版本号/路径/时间戳。槽 id 由平台拥有。 |
| 单一执行槽 | 不变（三角色是组合模式，不引入并发）。 |
| 凭据/隐藏思维链不上屏 | 不变。 |
| v2-only runnable | 不改 turnContract 版本；槽位是模板内产物结构，v2 契约照旧。 |

**回归断言**：槽位引擎 / 投影 / 逐槽校验模块源码 grep 业务词（blueprint/大纲/章节/知乎/触发/回应）零命中；业务词只允许在模板（脚手架定义 / 投影函数 / validator）与测试 fixture 出现。与 Phase 2 gate-runner 的铁律断言同形。

---

## 7. 落到 5 个 skill 的映射

| skill | 编排器 | 填空器 | 审核器 | 槽位例子 |
|---|---|---|---|---|
| outline-designer | 模板（静态脚手架） | outline-designer agent（7 轮） | `validate-blueprint.js`（gate，结构） | 13 二级标题 / 每章 7 三级 / P0 标签槽 |
| outline-drafter | 模板/agent | outline-drafter agent（5 过程产物） | 可选 gate + 语义自检 | focus-brief / scene-plan / plan-gate / draft / reconciliation 各自槽 |
| chapter-drafter | 模板（7 轮结构） | chapter-drafter agent（7 轮） | `validate_chapter_output`（gate）+ packet 独立审 | 场景单元 触发/回应/反馈/新状态 子槽 |
| chapter-packet | packet agent（编译场景卡） | packet 自身填场景卡 | packet agent（audit）+ gates | 场景卡 9 字段 + 容量载体；audit 投影正文成场景单元槽逐槽判 完成/缺失/越界 |
| production-director | —（监督，非生产角色） | — | director agent（全文终审）+ delivery gate | 交付证书字段槽 + 全文终审槽 |

**关键实例**：chapter-packet ↔ chapter-drafter 是三角色分到两 Agent 的典型--packet 同时是编排器（给 drafter 设计场景卡槽）和审核器（审 drafter 填的正文），drafter 是填空器。信息隔离由 route.inject 物理强制。

**现状对照**：outline-designer 现在是「编排=模板静态 + 填空=agent + 审核=整块 gate」的退化三角色。槽位机制把它升级成逐槽填 + 逐槽审，并把同一套机制推广到其余 4 个 skill。

---

## 8. 待定的设计决策（开放问题）

真要进入 dev-plan 前，需钉死以下几点：

1. **槽位 schema 语言**：模板怎么声明静态脚手架？YAML 描述槽位树 + JS 处理动态/投影，还是全交一个 JS 函数生成？倾向前者（静态槽 YAML 声明，动态投影 JS）。
2. **嵌套层级**：章 → 场景 → （触发/回应/反馈/新状态）是树，槽位要支持几层嵌套？schema 形状如何表达父子与顺序？
3. **模型工具面**：生成方向是 `read_scaffold` + `fill_slot(id, content)` 强约束防漏，还是仍写整文再让平台投影拆？可能两种都给（强约束 vs 兼容自由写作）。
4. **逐槽校验 vs 整体校验**：每槽一个 validator（平台按槽跑 N 次，粒度细，但平台要支持「按槽跑」），还是一个大 validator 内部 switch 槽 id（简单但校验器自己长）？倾向前者以匹配「按槽归因」。
5. **投影函数归属**：审核方向「什么算一个场景单元 / 一句」是领域知识，必须模板给 JS、沙箱里跑。这条没得选，但要明确投影函数的契约（输入产物 content，输出带 id 的槽位树）。
6. **多输入 gate / 投影复校的输入**：审核复校要同时读产物 + 模型那份只带 id 的语义 JSON（两份）。当前 gate runner 只吃单 content（已核实 `gate-runner.ts` 的 `GateRunInput`）。需扩展 gate 输入契约支持多文件，或为「复校」单设一个比 gate 更宽的执行入口（能读多文件 + 按 id 回填）。repair-scope 校验（before+after+memo 三输入）也走同一扩展。
7. **三角色是否强制分离**：否。三角色是能力/模式，不是强制拆分。简单产物一个 Agent 身兼编排+填空，gate 当退化审核器（outline-designer 即此）；复杂产物才拆三 Agent。粒度由模板决定。
8. **槽位与 `artifactSchema` 的下沉关系**：是扩 `artifactSchema`（文件级槽 → 子槽位），还是新设 `slotSchema` 独立于 `artifactSchema`？倾向扩 `artifactSchema`（每个 file 可声明子槽位），保持单一来源。
9. **route.inject 细化到槽位**：是否在本期做？做的话 inject 声明要支持「注某文件的某槽位」。可后置。

---

## 9. 非范围 / 边界

本设计**不**覆盖：

- **下游失效级联（supersede 链）**：production-director 打回时标记节点产物及全部下游 invalidated。v2 版本目录不可变、只增，无「标记失效」概念，无自动级联。需新增「supersede 链」平台概念或让 director agent 手动协调重发新版本。**独立缺口，另立设计**。
- **事件哈希链**：director 要求事件以前一事件哈希串联。Forge Core 事件是追加式 seq+uuid，无 prev-hash。小改 event-store 即可，但属 custody 层改动，**另立**。
- **全文跨章终审作为 submit 前置**：可由 director agent 当 submitter + delivery gate 表达，不需新平台能力；若要平台强制「submit 前必须 N 个前置审计通过」才变成缺口。**暂按 agent 表达**。
- **手动选择性压缩**：已有 Pi 自带 compaction（Phase 3 已开），不在本设计内。
- **改 9 动作注册表 / 事件联合 / 版本目录存储 / live update / turnContract 版本**：均不变。新槽位工具是只读注入工具（填空写 workspace 除外），非新动作。

本设计**不改** custody 层；槽位是产物内部结构，是 production 层的事。

---

## 10. 现状核实要点（给实施 agent）

实施前 SSH 核对远端以下符号是否存在/形态一致（本设计假设的落点）：

- `src/server/runtime/gate-runner.ts`：单次、单 content、`{pass, issues}` 契约（已核实）。`GateRunInput` 是否易扩展多文件输入。
- `src/server/runtime/pi-tool-factory.ts`：`validate_artifact` 工具（已核实，读单 workspaceFile）。`read_skill_section` 工厂（只读不进 buffer 的先例）。新槽位工具的同层接法。
- `src/server/runtime/task-runner.ts`：`route.inject` 逐文件注入（已核实，约 724-745 行）。inject 细化到槽位的可行性。
- `src/server/template/template-schema.ts`：`FrozenAgentConfig.gate` / `artifactSchema`（v2 schema）。扩 `artifactSchema` 加子槽位的落点。
- `src/server/runtime/action-committer.ts`：commit 门禁插入点（`assertGateAllowed`）。逐槽校验挂同处或新增挂点。
- `templates/outline-designer/gates/validate-blueprint.js`：现有整块审核器，作为「升级成逐槽」的基准。
- 5 个 skill 原文在 `C:\Users\13863\Desktop\zhihu\盐选快叙Skill迭代\skills\`（需 scp 到远端或实施 agent 重新生成），其中 `chapter-packet/scripts/controller_artifact.py` 是投影-回收-复校的参考实现。

---

## 11. 下一步

1. 本设计草案经回看/讨论冻结后，写 `docs/2026-08-0x-structured-slots-three-role-dev-plan.md`，分 Phase（建议：先升级 artifactSchema+gate 到槽位静态填+逐槽审 → 再做投影-回收-复校审核 → 再串三角色多 Agent 拓扑 → 再落 chapter-packet / chapter-drafter 模板 → 真实模型验证）。
2. `controller_artifact.py` 子命令逐个拆解：哪些是纯函数（可迁 JS gate / 逐槽 validator），哪些必须多步投影-回收-复校（必须新能力）。给 §8.4 / §8.6 的精确工作量边界。
3. supersede 链 + 事件哈希链另立设计文档（production-director 落地前）。

---

## 附：设计脉络（为什么是这个形状）

- 评估 4 个后续 skill 时发现 chapter-packet 的 `controller_artifact.py` 跑不了--当前 gate 是单次单内容纯校验，做不了「平台编号 → 模型报编号 → 平台捞真文复校」的三步舞。
- 进一步认识到这个三步舞不是审核专用：把产物表达成可编号的结构单元（槽位），生成方向「填空」、审核方向「投影-复校」，是同一套机制的两面，且可串联成「先填后审」完整闭环。
- 再认识到 Forge Core 现有 `artifactSchema`（静态文件级编排）/ writer（填空）/ gate-runner（自动结构审核）已是三角色的退化形态；槽位机制是把它们升一等、做细、做正式，不是推倒重来。
- 三角色叠在 v2 custody 层之上，正交不替换；9 动作是三角色的工具，writer/reviewer/controller 是粗粒度三角色。
- 编排器看全图、填空器只收脚手架、审核器收产物+规则，信息隔离由 route.inject 物理强制；按槽归因给 director 回退路由结构化依据。
- 铁律：平台=槽位引擎零业务词，脚手架/投影/validator=模板沙箱执行（同 gate-runner）。
