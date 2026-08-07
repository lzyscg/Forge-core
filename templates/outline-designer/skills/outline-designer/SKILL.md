# 大纲复刻七轮工作流（SKILL 主入口）

本技能把一个「对标故事」复刻成 imitation-blueprint 执行大纲。七轮在**一个回合内**依次完成：前置闸门 → 维度分析（事实 / 变化 / 人物压力 / 声音）→ 组装 → 自检返修。每轮开始前读对应 references 子文件拿详细指示，产出写入私有工作区。

**详细指示不内联在本文；做第 N 轮前先 `read_skill_section(outline-designer, references/0N-xxx.md)`。**

## 七轮概览

| 轮 | 读 references | 产出（工作区文件） | 一句话目标 |
| --- | --- | --- | --- |
| 1 | `references/01-source-boundaries.md` | `01-source-boundaries.md` | 确认输入完整、建立章节边界；不完整则 `BLOCKED` |
| 2 | `references/02-facts-and-conflicts.md` | `02-facts-and-conflicts.md` | 建立源文事实与知识账本（FACT/OBS/INFER/PRIVATE 标签） |
| 3 | `references/03-story-change-map.md` | `03-story-change-map.md` | 提取故事与章节变化链、每章 P0（全篇唯一 `Bxxx-P0-n`） |
| 4 | `references/04-character-pressure-map.md` | `04-character-pressure-map.md` | 提取人物行动逻辑、情绪链与读者压力链 |
| 5 | `references/05-narrative-fingerprint.md` | `05-narrative-fingerprint.md` | 提取叙述视角、声音、对白与节拍 |
| 6 | `references/06-blueprint-assembly.md` | `imitation-blueprint.md` | 只做组装：13 个固定二级标题 + 每章 7 段三级标题 |
| 7 | `references/07-outline-audit.md` | `07-outline-audit.json` | 独立自检，只输出严格 JSON（`verdict`） |
| 8 | `references/08-outline-repair.md` | 返修对应轮文件 | 按 `earliest_stage` 定点返修，重跑轮6+轮7 |

## 每轮执行规则

- 做第 N 轮前，先 `read_skill_section(outline-designer, references/0N-xxx.md)` 读该轮详细指示，再按指示产出。
- 前几轮产物冻结后不回看重写；后续轮基于已产出文件继续。

## 冻结规则（不改动铁律）

- **轮1**：边界一旦确认，不得合并、补号、重切章节；不把编号章节事件移入冷开场。
- **轮2**：事实账本只消除原文矛盾，不重新设计故事；复合结果（判决/录取等）拆原子事实。
- **轮3**：P0 使用全篇唯一 `Bxxx-P0-n`，不得把后文真相倒灌为前文已知。
- **轮4**：人物情绪与读者压力必须分立，不可合并；同方向情绪若对象/含义/不可逆度不同不得合并。
- **轮5**：只迁移叙事功能与强度，不复制原文独特句子，不把粗粝冲突润色成中性书面语。
- **轮6**：只组装，不重新分析、不补事实；标题 `# 《公开仿写标题》原文复现执行大纲`。
- **轮7**：只审核不改写；任何阻断项或结构门禁失败必须 `reject`。
- **轮8**：只重做被打回阶段及其下游；修排版合同时保留字面标记 `## 分章执行卡` 与同级 `## NN｜…`。

## 自检与返修索引

- 轮7 自检 JSON 的 `verdict` 为 `reject` 时，读 `issues[].earliest_stage` 定位最早责任轮，再读 08 按 stage 路由：
  - `boundaries` → 修边界；`facts` → 修事实账本；`story_change` → 修章节变化/因果/P0；
  - `character_pressure` → 修人物策略/情绪收据/读者压力；`narrative_fingerprint` → 修声音/对白/详略；
  - `assembly` → 只修缺字段/错标签/排版合同。
- 返修后重跑轮6（组装）与轮7（自检），直到 `verdict: pass`。
- 提交前用 `validate_artifact(source=workspace_file, workspaceFile=imitation-blueprint.md, artifactType=imitation_blueprint)` 跑结构门禁，不过按 `issues` 修正。

## 产物边界

- 只有 `imitation-blueprint.md` 经 `finish_production(source=workspace_file)` 提交为最终产物；其余中间文件留在工作区 scratch。
