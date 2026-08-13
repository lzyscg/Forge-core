---
name: zhihu-salt-outline-designer
description: 从完整知乎盐选短篇原文中，在同一大纲 Agent 会话内分轮提取章节边界、事实冲突、故事变化、人物情绪、读者压力、声音节拍并组装成可供仿写正文复现原文效果的执行大纲。用于原文大纲提取、还原、审核和修订；不用于原创、改编、换题材或直接写正文。
---

# 原文复现型知乎短篇大纲

## 核心原则

大纲节点是一个持续会话中的 Agent，不是一次性输出蓝图。一次会话只处理一篇完整原文；每轮只提取或校正一个维度，上一轮已经确认的内容在后续轮次默认冻结。

不要把全部标准同时交给模型。进入哪一轮，只读取该轮 reference；不要预载后续轮次。最终组装轮只负责合并已经通过的产物，不重新分析原文。

## 输入与任务边界

输入必须是完整原文。只提取原文中的人物、事件、事实、因果、反转、结局和叙事方法；不新增事件、证据、动机、对白或世界观，不换人物、题材和故事目标。输入不完整时停止生成“完整大纲”。

源标题、章节数量、公开标签、事件归属和反转顺序必须保留为来源合同。公开仿写标题可以另拟，但不得改变故事承诺，也不得把新标题当成新故事入口。

## 同一会话的七轮工作流

自动化生产保存每轮产物。普通交互可以只交付最终大纲，但内部不得跳步或合并任务。

1. **来源与边界**：读取 [01-source-boundaries.md](references/01-source-boundaries.md)，输出 `source-boundaries.md`。只确认完整性、章节切分和源定位。
2. **事实与冲突**：读取 [02-facts-and-conflicts.md](references/02-facts-and-conflicts.md)，输出 `source-fact-ledger.md`。只登记硬事实、知识时点和原文矛盾。
3. **故事变化**：读取 [03-story-change-map.md](references/03-story-change-map.md)，输出 `story-change-map.md`。只提取主线、逐章变化、因果、反转和退出状态。
4. **人物与压力**：读取 [04-character-pressure-map.md](references/04-character-pressure-map.md)，输出 `character-pressure-map.md`。只提取人物目标、关系、情绪执行链和读者压力。
5. **声音与节拍**：读取 [05-narrative-fingerprint.md](references/05-narrative-fingerprint.md)，输出 `narrative-fingerprint.md`。只提取叙述判断、对白策略、详略、段落和语言呼吸。
6. **执行大纲组装**：读取 [06-blueprint-assembly.md](references/06-blueprint-assembly.md)，输出 `imitation-blueprint.md`。只把前五轮产物组装为稳定合同，不新增分析结论。
7. **独立自检**：读取 [07-outline-audit.md](references/07-outline-audit.md)，输出 `outline-audit.json`。只核验边界、覆盖、来源、时点和合同，不润色大纲。

自检失败时读取 [08-outline-repair.md](references/08-outline-repair.md)，只修被拒绝的最早责任轮，然后重新组装并复审。事实错误回第 2 轮，章节变化错误回第 3 轮，情绪/压力错误回第 4 轮，声音/节拍错误回第 5 轮，只有排版或缺字段才回第 6 轮。

## 复现标准

最终大纲同时保住四层：事件骨架、信息控制、人物情绪与读者压力、叙事效果。允许压缩同义信息，但不得删掉独立因果台阶、情绪收据、对白轮次、叙述判断、关系位移和后文回收所需的前置信号。

每项核心信息标注来源：`FACT` 为原文明写，`OBS` 为视角可见，`INFER` 为当章允许推断，`PRIVATE` 为后文真相，`REPAIR` 为消除原文内部矛盾的统一决定。P0 必须有 `FACT` 或 `OBS`，不能把 `INFER`、`PRIVATE` 或角色动作升格为前文确定事实。

## 门禁与交付

组装后运行 `scripts/validate_extracted_outline.py --source <原文> --outline <大纲>`。结构门禁与第 7 轮自检都通过，才允许进入正文计划节点。作者自评不能代替外部门禁。

最终只交付一份 `imitation-blueprint.md`，不输出正文、多个候选或分析过程；自动化生产保留全部中间产物供总控追溯。
