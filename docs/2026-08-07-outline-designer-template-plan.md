# 大纲复刻(outline-designer)模板 + 平台补强计划

> 以**补强后形态**设计 outline-designer 模板,再从中倒推出 3 个平台功能,实现后用真实 DeepSeek 验证七轮闭环。不搞过渡方案。

## 背景与双轴约束

盐选 outline-designer skill 的「七轮」是**单 Agent 连续工作流**(前几轮冻结但不消失,同上下文可读;第 8 轮返修跳回最早责任轮重做+下游)。Forge 的 turn = 返修轴,skill round = 产物种类轴,二者正交,不 1:1 映射。

结论:outline-designer 落为**一个 Agent + 一个 skill(渐进式披露)+ workspace 放中间产物 + `finish_production(workspace_file)` 提交最终 blueprint**,七轮压在**单 Turn 自循环**内。七轮本质分四类:① 前置闸门(轮1)② 维度分析(轮2-5)③ 组装(轮6)④ 验证+返修(轮7-8)。

## 一、目标态模板设计

### 目录结构

```
templates/outline-designer/
  template.yaml
  pipeline.yaml
  agents/outline-designer.yaml
  prompts/outline-designer-system.md
  skills/outline-designer/
    SKILL.md                       # 主入口:全局流程 + 七轮概要 + "做第N轮读 references/0N"
    references/
      01-source-boundaries.md
      02-facts-and-conflicts.md
      03-story-change-map.md
      04-character-pressure-map.md
      05-narrative-fingerprint.md
      06-blueprint-assembly.md
      07-outline-audit.md
      08-outline-repair.md
  gates/
    validate-blueprint.js          # 门禁校验器(由原 validate_extracted_outline.py 平迁)
```

### 关键设计

- **单 Agent**(`outline-designer`),单 Turn 自循环跑七轮。
- **pipeline**:无 routes,`finalOutput.submitters=[outline-designer]`(自己 produce 自己 submit)。
- **skill 渐进式披露**:`load_skill(outline-designer)` 只返回 SKILL.md 主入口(全局流程+七轮概要);每轮开始前 `read_skill_section(references/0N-xxx.md)` 读该轮详细指示。主入口 + 子文件分离,按需注入。
- **workspace 中间产物**:七轮在 `tasks/<id>/workspaces/outline-designer/` 产出 7 个文件:`01-source-boundaries.md`、`02-facts-and-conflicts.md`、`03-story-change-map.md`、`04-character-pressure-map.md`、`05-narrative-fingerprint.md`、`imitation-blueprint.md`(轮6组装)、`07-outline-audit.json`(轮7自检)。**只有 `imitation-blueprint.md` 经 `finish_production(workspace_file)` 提交进版本目录**,其余留 scratch。
- **门禁**:`gates/validate-blueprint.js` 校验 blueprint 结构(13 个二级标题、每章 7 段三级标题、P0 带 `[FACT/OBS @Lx-Ly]`、冷开场 P0 不得写"无"等)。两个用法:模型 `validate_artifact` 提交前自检 + 提交时节点门禁兜底。
- **turnContract**:production `sources=[workspace_file]` `formats=[markdown]`;dispatch `allowedActions=[submit_final_artifact]`。

### 系统提示词编排(prompts/outline-designer-system.md)

1. `load_skill(outline-designer)` 拿主流程;
2. 轮1:`read_skill_section(references/01)` → `write_workspace(01-source-boundaries.md)`;若 `BLOCKED` → `request_human_input`(输入不完整);
3. 轮2-5:依次 `read references/02..05` → `write_workspace(0N-*.md)`;
4. 轮6:`read references/06` → `write_workspace(imitation-blueprint.md)`(组装,不新增分析);
5. 轮7:`read references/07` → `write_workspace(07-outline-audit.json)`(自检 JSON);
6. 读 audit.verdict;若 `reject`,按 `earliest_stage` `read references/08` 定点返修对应轮文件 + 重跑组装(06)+ 重跑自检(07),直到 `pass`;
7. 提交前 `validate_artifact(workspace_file=imitation-blueprint.md)` 跑结构门禁,不过按 issues 修;
8. `finish_production(workspace_file=imitation-blueprint.md, format=markdown, artifactType=imitation_blueprint, title=…)` → `submit_final_artifact`。

## 二、倒推出的 3 个平台功能

### 功能 1:skill 渐进式披露

落点:`template-schema.ts` / `template-loader.ts` / `skill-service.ts` / `pi-tool-factory.ts`

- **schema**:`FrozenAgentConfig.skills[]` 增可选 `sectionsPath`(子文件目录);`FrozenSkill` 增 `sections: string[]`(收集到的子文件相对路径)。
- **loader**:`readSkillContent` 扩展为读主入口 + 收集 `sectionsPath` 下所有子文件入 snapshot;子文件内容参与 `versionHash`。
- **skill-service**:`loadAuthorized` 只返回主入口 content;新增 `readSection(taskId, agentId, skillId, sectionPath)` 读子文件(授权 + containment + 内容哈希校验,复用 `readSnapshotSkill` 的安全检查)。
- **新工具 `read_skill_section(skillId, sectionPath)`**:只读注入,**不进 ActionBuffer**(与 workspace 工具同层),返回 section content。
- **pi-tool-factory**:注册 `read_skill_section`,与 workspace 工具一起注入。

### 功能 2:门禁执行环境(JS 校验器)

落点:`template-schema.ts` / `template-loader.ts` / `action-committer.ts` / `pi-tool-factory.ts` + 新增 `gate-runner.ts`

- **schema**:`FrozenAgentConfig` 增可选 `gate: { validator, artifactType, mode: ['self_check','commit'] }`。
- **loader**:读 `gate.validator` 文件入 snapshot,参与 `versionHash`。
- **执行环境**(`gate-runner.ts`):预装 JS runtime + 沙箱(isolated-vm / QuickJS),固定签名 `validate({content, artifactType, context}) -> {pass: boolean, issues: [{stage, evidence, scope}]}`,沙箱内无 FS 外访问、无网络、CPU/内存/时间限制。校验器代码属模板(snapshot 内),平台只提供执行环境 + 调用契约(平台零业务词铁律不破)。
- **模型工具 `validate_artifact(source: workspace_file|inline, ...)`**:读 workspace 文件/inline 内容,跑校验器,返回 `{pass, issues}`;只读注入,不进 ActionBuffer。
- **节点门禁**:`action-committer` 提交时若 `gate.mode` 含 `commit`,在 `finish_production` 封存后、dispatch 前(或 submit 前)跑校验器,不过 → `CommitFailure(GATE_REJECTED)`。新增 committer 错误码 `GATE_REJECTED`。
- **平迁**:原 `validate_extracted_outline.py` 改写成 `gates/validate-blueprint.js`(结构校验,正则/字段检查,平迁成本低)。

### 功能 3:回合内上下文压缩

落点:`pi-agent-runtime.ts`(最不确定的一块)

- 现状:Pi `compaction: { enabled: false }`,单 Turn 内上下文只增不减。七轮 + 多个 reference + workspace 读写,长故事会爆。
- 方向:回合内压缩「已用完、不再需要」的工具结果(早期 reference 的 `read_skill_section` 结果、已读过且不再需要的 workspace 文件)。
- 调研:Pi 0.82 SDK `SessionManager` 是否支持手动消息移除/压缩 API。若支持,按标记选择性压缩;若不支持,fallback 到「选择性注入」(平台层在 Turn 内主动裁剪已用完的工具结果消息)。
- 风险:这是三功能里技术不确定性最高的,可能需要读 SDK 源码。

## 三、实现顺序

1. **功能 1**(渐进式披露)— 模板骨架依赖,先做。
2. **功能 2**(门禁执行环境)— 中等,校验器 + 沙箱 + 两个调用点。
3. **功能 3**(压缩)— 并行/后置,不阻塞短故事验证(见下)。
4. **模板落地**(outline-designer 全套文件:yaml + md + js + skill + references)。
5. **验证**(真实 DeepSeek 跑一个短对标故事,看七轮闭环 + blueprint 结构门禁通过 + 最终提交)。

## 四、验证策略(待你定)

- **严格(你原话)**:3 个功能全实现完,再用模板验证。
- **务实(推荐)**:功能 1+2 实现 + 模板落地 → 先用**短故事**(上下文不爆)验证七轮闭环 + 门禁;功能 3 压缩作为增强后置,与验证并行。这样不被最不确定的压缩阻塞,能尽早暴露模板设计问题。

## 五、待确认点

1. **谱系**:推荐**远端 standalone**(`/Users/lzy/Desktop/ForgeCore`,最新 + live update,主开发环境)。实现前先 SSH 核对远端核心文件与本地 GitHub 谱系一致(workspace-store / skill-service / forge-actions / action-committer / template-schema / template-loader / core-paths)。
2. **门禁语言**:推荐 **JS**(同语言、沙箱成熟 isolated-vm、平迁成本低)。你说过 Python 或 JS 都可。
3. **验证策略**:务实(推荐)还是严格。
4. **门禁触发点**:outline-designer 是 `submit_final_artifact`,门禁挂在 submit 前。通用设计支持 publish/submit 都可挂(由 `gate.mode` 决定)。
