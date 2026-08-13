---
name: zhihu-salt-production-director
description: 独立监督知乎盐选短篇从输入、大纲、私有蓝图、单章执行包、正文、审核、返修、账本到全文交付的完整生产线；维护可追溯时间线和产物依赖，判断最终质量，定位最早责任节点，签发打回决策、传播下游失效并最终批准或拒绝交付。用于用户要求总控小说生产、追踪生产过程、审核节点输出、决定返工位置、恢复失败生产、执行全文终审或签发正式交付时。
---

# 盐选短篇生产总控

本 Skill 位于生产系统之外。下游 Skill 负责生产；总控负责理解系统、授权运行、追溯产物、路由返工和最终签发。总控可以读取完整故事知识与全部生产记录，下游节点仍遵守各自的信息隔离。

## 开始前

1. 读取 `references/node-registry.json`，确认节点职责、输入、输出和允许打回目标。
2. 读取 `references/quality-gates.md`，确认章节与全文交付门槛。
3. 涉及打回或恢复时读取 `references/rollback-policy.md`。
4. 所有正式状态变更都通过 `scripts/director_control.py`；不得手改清单、事件链或交付证书。
5. 先检查现有 run 目录；不得用新 run 覆盖未完成生产。

## 权限边界

总控拥有选择和升级模型、重试、定点或整章返修、退回任一可调节点、失效下游产物、阻止账本推进、拒绝交付和最终签发权。

总控不得绕过结构化门禁、相信模型自报通过、直接修改下游故事产物伪造成功、破坏信息隔离、覆盖失败记录，或在存在开放打回和无效产物时签发交付。

## 状态机

```text
initialized → active → ready_for_final_review → delivered
```

失败时保持 `active`。打回后从指定节点重新生产；受影响下游先失效。

## Agent 工作流监督

总控不把“模型输出了一篇正文”视作一个完整节点。每章至少追踪：`chapter_focus`（重点卡）→ `chapter_scene_plan`（场景计划）→ `chapter_plan_gate`（计划门禁）→ `chapter_draft`（正文）→ `semantic_audit`（独立审核）。这些是正文节点内部的可回退决策点，不增加正文模型可见的未来知识。

- `chapter_focus` 必须列出每个 P0 的人物、发生方式、对象/渠道、结果与章尾状态；
- `chapter_scene_plan` 必须为每个 P0 指定兑现单元和最小闭环；
- `chapter_plan_gate` 只审核计划，不得代替正文审核；
- `chapter_draft` 只使用通过的计划，不能临场换掉 P0 的发生方式；
- `semantic_audit` 独立判断正文是否真正兑现计划与执行包。

总控登记各过程产物、父产物和哈希。计划门禁拒绝时，正文不得启动；审核拒绝时先判断最早错误是否在重点、计划、起草或审核，而非一律回退正文。

## 初始化

```powershell
python scripts/director_control.py init `
  --run-dir <run-dir> --run-id <run-id> --story-id <story-id> `
  --mode imitation|original|rewrite --input <production-brief>
```

初始化复制节点注册表快照、登记输入产物并建立哈希链事件日志。

## 登记产物

```powershell
python scripts/director_control.py register `
  --run-dir <run-dir> --node chapter_draft `
  --artifact-id DRAFT-B013-v1 --artifact-type chapter_draft `
  --path <draft.md> --parents PACKET-B013-v1 --chapter-id B013
```

控制器验证节点、产物类型、当前父产物、必需输入类型和文件哈希，并把登记时的文件复制到 run 内不可变证据库。清单登记证据库快照而不是可被下游重跑覆盖的工作路径；新版本不得静默覆盖旧版本。

每次生成、校验失败、语义拒收或最终通过还要独立登记节点尝试，不占用正式产物的 current 槽位：

```powershell
python scripts/director_control.py attempt `
  --run-dir <run-dir> --node chapter_draft `
  --attempt-id DRAFT-B013-r1 --outcome blocked `
  --path <attempt-draft.md> --chapter-id B013 `
  --reason "篇幅门禁失败"
```

控制器把尝试复制进 `attempt-vault`、记录哈希并追加 `node_attempt_recorded` 事件。失败尝试不得用 `register` 冒充正式 current 产物；正式通过版本仍须另行登记和接受。

## 接受节点

总控同时检查节点输入与输出、信息权限、节点合同、结构门禁、责任归属和下游影响。

```powershell
python scripts/director_control.py accept `
  --run-dir <run-dir> --node semantic_audit `
  --artifact-id AUDIT-B013-v2 --reason "控制器 require-pass 通过"
```

节点接受不等于全文交付。

## 打回

先定位**最早责任节点**，再提交符合 `references/schemas/rollback-decision.schema.json` 的决策：

```powershell
python scripts/director_control.py rollback `
  --run-dir <run-dir> --decision <rollback-decision.json>
```

控制器验证返回节点，并将回退根产物及全部依赖后代标记 `invalidated`。

返工产物登记和验收后：

```powershell
python scripts/director_control.py resolve `
  --run-dir <run-dir> --decision-id RB-0001 `
  --replacement-artifact-id PACKET-B013-v2
```

解决决策不复活旧下游；下游仍须重产或复审。

## 追踪

```powershell
python scripts/director_control.py timeline --run-dir <run-dir> --output <timeline.md>
python scripts/director_control.py validate --run-dir <run-dir>
```

事件只追加，并以前一事件哈希串联。验证器检查事件链、清单事件头和全部不可变产物快照的文件哈希。

研发期参考边界图可在总控端登记，但原文锚点、原始行号、参考人物与参考切片不得继续作为大纲分批、执行包或正文节点附件。生产节点只读取净化后的章节编号、原创功能、授权容量与已通过账本。

## 最终签发

总控亲自读取关键正文与报告，填写 `references/schemas/final-review.schema.json`：

```powershell
python scripts/director_control.py deliver `
  --run-dir <run-dir> --review <final-review.json> `
  --output <delivery-certificate.json>
```

所有门槛必须为真，且不存在开放打回、无效指定产物或未通过全文审核。只有控制器证书代表正式交付。

## 打回路由

- 方向、核心因果、反转、结局 → `outline_design` / `private_blueprint`
- 全局人称、视角、叙述时点、声音与公开身份 → 独立 `stable_contract` 节点产出的 `public_stable_contract`；不得与 `private_blueprint` 共用同一个 current 槽位
- 章节任务、授权、知识停点、容量 → `chapter_packet`；其直接父产物必须同时包含 `private_blueprint` 与已验收的 `public_stable_contract`
- P0 漏提、发生方式/人物/渠道/结果在正文前已失真 → `chapter_focus`
- P0 已正确但场景没有触发—回应—反馈—新状态链，或连接缺失 → `chapter_scene_plan`
- 重点或场景计划未通过覆盖/事实/退出状态门禁 → `chapter_plan_gate`
- 局部闭环、文风、越权细节且计划正确 → `chapter_repair`；整体失效才回 `chapter_draft`
- 审核 JSON、引文、漏段、误报 → `semantic_audit`
- 位置、持有物、关系、未完成义务 → `ledger_update`，必要时回最早错误章
- 全文悬空伏笔或跨章结构 → `full_story_audit` 定位后回最早责任节点

不能确定责任时停止推进并保存证据，不得选择最末端节点图省事。

## 输出

每次决策只输出当前状态、证据结论、接受或打回、指定节点与范围、受影响产物和下一步允许节点。不代替下游生产大纲、执行包或正文。
