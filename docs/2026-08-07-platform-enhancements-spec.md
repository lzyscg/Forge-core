# 平台补强(skill 渐进式披露 / 门禁执行环境 / 回合内压缩)+ outline-designer 模板 - 规格文档（Spec）

> 状态：**草案（Draft）**，对齐设计 `docs/2026-08-07-outline-designer-template-plan.md`。
> 实施谱系：**远端 standalone**（`/Users/lzy/Desktop/ForgeCore`），当前为 9 动作 + 产物版本目录制 + live update。
> 本文是 3 个平台能力 + outline-designer 模板的**规格**（契约 / 数据模型 / 接口 / 落点 / 验收），供远端 Claude Code agent 实施。
> 实施时以**远端实际代码**为准；本文假设的符号（`SkillService.loadAuthorized` / `ActionCommitter.validateAndCommit` / `FrozenAgentConfig.skills` / `compaction` / `customTools` 等）已在远端核对存在。若远端某处与本文不符，以远端代码为准并适配，记录偏差。

---

## 1. 目标与范围

**目标**：为承接盐选 outline-designer 七轮工作流（单 Agent 单 Turn 自循环复刻对标故事），补 3 个平台能力，并落地 outline-designer 模板：

1. **skill 渐进式披露**：skill 从单文件扩展为「主入口 + 子文件目录」，`load_skill` 只返回主入口，`read_skill_section` 按需读子文件。
2. **门禁执行环境**：模板可声明一个 JS 校验器，平台在受控沙箱执行；模型可调 `validate_artifact` 自检，提交时节点门禁兜底。
3. **回合内上下文压缩**：开启 Pi 自带 compaction，让单 Turn 多轮工作流的上下文可被压。

**范围**：上述 3 能力 + `templates/outline-designer/` 模板。

**非范围**（明确不做）：
- 不改 9 动作注册表（`forge-actions.ts` 的动作联合不变）。
- 不改产物版本目录存储（`artifact-store.ts` 不变）。
- 不改 live update（LiveTurn / live-store 不变）。
- 不改事件联合（`task-events.ts` 不新增事件成员；新工具只读，不产事件）。
- 不做手动选择性压缩（功能 3 先用自带 compaction，不够再单独立项）。

---

## 2. 背景与双轴约束

- **双轴**：Forge turn = 返修轴（相同产物 v1→v2→v3）；skill round = 产物种类轴（每轮不同产物）。二者正交，不 1:1 映射。
- **七轮本质**（outline-designer）：①轮1 前置闸门（边界+准入）②轮2-5 维度分析（事实/变化/人物压力/声音）③轮6 组装（纯变换）④轮7-8 验证+返修。轮8 跳回最早责任轮重做+下游。
- **落法**：一个 Agent + 一个 skill（渐进式披露）+ workspace 放 7 个中间产物 + `finish_production(workspace_file)` 提交最终 blueprint，七轮压在**单 Turn 自循环**内。
- **三能力的必要性**：单 Turn 七轮上下文会爆 → 压缩；skill 全文一次注入太重 → 渐进式披露；Python 结构门禁无法在无 shell 平台跑 → JS 沙箱门禁。

详见上游设计 `docs/2026-08-07-outline-designer-template-plan.md`。

---

## 3. 功能 1：skill 渐进式披露

### 3.1 数据模型（`template-schema.ts`）

`FrozenAgentConfig.skills[]` 的 skill 元素扩展（`contentPath` 仍是主入口，不变）：

```ts
interface FrozenSkill {
  id: string;
  name: string;
  description: string;
  contentPath: string;          // 主入口文件（load_skill 返回它），不变
  /** 子文件目录相对路径（可选）；声明后该目录下所有 .md 文件成为可按需读的 section。 */
  sectionsPath: string | null;  // 新增
  /** 加载时从 sectionsPath 收集的子文件相对路径列表（正序）；模型只能读列表内的 section。 */
  sections: string[];           // 新增
}
```

- `sectionsPath` 为 null 时，skill 行为与今天完全一致（向后兼容）。
- `sections` 由 loader 在加载时收集，frozen 进快照；运行时只读不重算。

### 3.2 加载（`template-loader.ts`）

- 扩展 `readSkillContent` 所在流程：读主入口外，若 `sectionsPath` 非空，遍历 `templateDir/sectionsPath` 下所有 `.md` 文件，收集相对路径（相对模板目录，正斜杠）入 `sections`；非 `.md`、隐藏文件、符号链接跳过。
- containment 校验：主入口与所有 section 文件都必须在模板目录内（复用 `readContainedFile` 的 realpath 双重校验）。
- `versionHash`：把每个 section 的**内容**纳入 canonical 形式（`computeVersionHash` 的 `skills` 项增加 `sections: [{path, content}]`），否则改 reference 哈希不变。
- snapshot 复制：模板目录整体复制进 `taskSnapshotRoot`（已有机制），section 文件随之进入 snapshot，无需额外复制。

### 3.3 服务（`skill-service.ts`）

- `loadAuthorized(taskId, agentId, skillId)`：**不变**，仍只返回主入口 `{id, content, versionHash}`。
- **新增** `readSection(taskId, agentId, skillId, sectionPath)`：
  - 取 frozen skill；校验 `sectionPath ∈ skill.sections`（不在列表 → `SKILL_SECTION_NOT_AUTHORIZED`）。
  - 从 snapshot 读该文件（复用 `readSnapshotSkill` 的 containment + realpath 安全检查模式，但根是 `taskSnapshotRoot`，路径是 `sectionPath`）。
  - 返回 `{content, versionHash}`。
  - **只读，不追加事件**（与 `readSkillForDisplay` 类似，不写 `skill_loaded`）。
  - 失败为 typed 非重试 `RuntimeFailure`，新增错误码 `SKILL_SECTION_NOT_AUTHORIZED` / `SKILL_SECTION_MISSING` / `SKILL_SECTION_PATH_UNSAFE`。
- `loadedSkillsFor` / `attributeSkillLoads`：不变（section 读取不进事件联合，不需归因）。

### 3.4 工具（`pi-tool-factory.ts` + `pi-agent-runtime.ts`）

- **新增工具 `read_skill_section`**（与 `write_workspace`/`read_workspace` 同层，只读注入）：
  - 参数：`{ skillId: string, sectionPath: string }`（均 bounded）。
  - 回调：调 `skillService.readSection(taskId, agentId, skillId, sectionPath)`，成功返回 section content，失败返回短 `rejected: <code>` 回执（不抛，模型可恢复）。
  - **不进 ActionBuffer，不进 phase gate**（与 workspace 工具一致；只有 6 个 Forge 动作进 buffer）。
- `pi-agent-runtime.ts`：`customTools` 数组在 `createWorkspaceToolDefinitions` 旁加入 `createSkillSectionToolDefinitions({ skills: skillService, taskId, agentId })`（新工厂，结构仿 `createWorkspaceToolDefinitions`）。per-Turn 绑定 taskId/agentId，与 workspace 工具同样的闭包约束（只闭包 store 上下文，不注入 CoreService/EventStore）。

### 3.5 授权与安全

- **授权**：能读的 section 由 frozen `skill.sections` 决定（加载时收集），模型不能任意路径读 snapshot。
- **containment**：主入口与 section 都在 snapshot 内，realpath 双重校验防符号链接逃逸。
- **内容稳定性**：section 读取不记 `loadedHashes`（每次按需读）；若同一任务内 section 文件被外部改动，fail-closed（`SKILL_SECTION_MISSING`）。
- **铁律**：模块零业务词（与 `workspace-store` 一致）。

### 3.6 验收

- `npm run check` + 相关 vitest 绿。
- 单测：loader 收集 `sections`（含子目录/非 .md 跳过）；`versionHash` 随 section 内容变化；`readSection` 授权（非列表内 reject）、containment（逃逸 reject）、缺失（reject）；`read_skill_section` 工具只读不进 buffer（buffer.actions 为空）。
- 向后兼容：`sectionsPath` 为 null 的旧 skill 行为不变（现有模板测试不破）。

---

## 4. 功能 2：门禁执行环境（JS 校验器）

### 4.1 数据模型（`template-schema.ts`）

`FrozenAgentConfig` 增可选 `gate`：

```ts
interface FrozenGate {
  /** JS 校验器文件相对路径（模块默认导出 validate 函数）。 */
  validator: string;
  /** 校验针对的产物类型名（与 finish_production 的 artifactType 对应）。 */
  artifactType: string;
  /** self_check: 暴露 validate_artifact 工具供模型自检；commit: 提交时平台兜底门禁。 */
  mode: Array<'self_check' | 'commit'>;
}
interface FrozenAgentConfig {
  // ... 现有字段 ...
  gate: FrozenGate | null;  // 新增，可选
}
```

### 4.2 加载（`template-loader.ts`）

- 读 `gate.validator` 文件入 snapshot（containment + realpath 校验，同 skill 文件），纳入 `versionHash`。
- validator 文件随模板目录复制进 snapshot（已有机制）。

### 4.3 执行环境（新模块 `src/server/runtime/gate-runner.ts`）

- **沙箱**：首选 **isolated-vm**（V8 isolate，隔离最强）；若远端 macOS arm64 编译失败，fallback **QuickJS**（`quickjs-emscripten`，WASM，无原生编译）。实现前先 `npm install isolated-vm` 验证。
- **校验器契约**：validator 文件为 CommonJS 形式 `module.exports = { validate }`，其中 `validate(input: { content: string; artifactType: string; context?: unknown }) => { pass: boolean; issues: Array<{ stage?: string; evidence?: string; scope?: string }> }`。`gate-runner` 在 isolate 内加载该文件（实现 CommonJS 子集 / `module.exports` mock）并取 `.validate`。
- **加载**：从 snapshot 读 validator 文件内容，在 isolate 内编译；**每任务编译一次**，复用 isolate（缓存 keyed by `taskId:agentId:validatorHash`）。
- **沙箱限制**：无文件系统访问、无网络、无 `require`/`import`、CPU 时间上限（如 5s）、内存上限（如 64MB）。校验器只能纯计算。
- **归属**：校验器代码来自 snapshot（**模板自带**），平台只提供执行环境 + 调用契约。`gate-runner.ts` 本身**零业务词**（不知道 blueprint 结构，只跑模板给的代码）——铁律 1 不破。
- 失败为 typed `RuntimeFailure`，错误码 `GATE_COMPILE_FAILED` / `GATE_TIMEOUT` / `GATE_RUNTIME_ERROR` / `GATE_CONTRACT_INVALID`（返回值不符合契约）。

### 4.4 模型工具（`pi-tool-factory.ts` + `pi-agent-runtime.ts`）

- **新增工具 `validate_artifact`**（仅当 agent 声明了 `gate` 且 `mode` 含 `self_check` 时注册）：
  - 参数：`{ source: 'workspace_file' | 'inline', workspaceFile?: string, content?: string, artifactType?: string }`。
  - 回调：取内容（workspace_file 走 `workspaces.readFile`，inline 直取），调 `gateRunner.run(taskId, agentId, content, artifactType)`，返回 `{pass, issues}` 给模型。
  - **只读，不进 ActionBuffer，不进 phase gate**。
- `pi-agent-runtime.ts`：`customTools` 在 workspace/skill-section 工具旁加入 `createValidateArtifactToolDefinitions(...)`，仅当 `agent.gate` 且含 `self_check` 时返回工具，否则返回空数组。

### 4.5 节点门禁（`action-committer.ts`）

- 新增错误码 `GATE_REJECTED`（加入 `COMMIT_ERROR_CODES`）。
- 在 `validateActionSet` 中，`sealPackage` 确定 `sealedPackage` 之后、任何写操作之前：若 `context.currentAgent.gate?.mode` 含 `'commit'`，且 dispatch 会落盘产物（`publish_artifact`，或 `submit_final_artifact` 且 `sealedPackage.source !== 'current_input_artifact'`），跑校验器（传入 `sealedPackage.content` + `sealedPackage.artifactType`）。
  - 校验器 `pass === false` → 抛 `CommitFailure(GATE_REJECTED, ...)`（写入 `issues` 摘要），**不写任何事件**。
  - 校验器运行时错误（编译/超时/runtime）→ `CommitFailure(GATE_RUNTIME_ERROR, ...)`，同样不写盘（fail-closed：门禁跑不动 = 拒绝提交，不放过）。
- 门禁注入点：`CommitContext` 已含 `currentAgent: FrozenAgentConfig`（含 `gate`），committer 持有 `gateRunner` 依赖（`ActionCommitterOptions` 增 `gateRunner`）。

### 4.6 校验器平迁（`gates/validate-blueprint.js`）

- 原盐选 `validate_extracted_outline.py` → `gates/validate-blueprint.js`（CommonJS 默认导出 `validate`）。
- 校验内容（从原 Python 脚本平迁）：13 个二级标题齐全且顺序；每章 7 段三级标题；每章 P0 至少一个 `[FACT @Lx-Ly]` 或 `[OBS @Lx-Ly]`；冷开场 P0 不得写「无」；`## 分章执行卡` 字面标记保留；篇幅范围（8000-12000 汉字，可选）。
- 签名：`module.exports = { validate: function({ content, artifactType, context }) { ... return { pass, issues } } }`。

### 4.7 验收

- `npm install isolated-vm` 在远端 macOS arm64 编译通过（或 fallback QuickJS）。
- 单测：`gate-runner` 跑校验器（pass/reject 各路径）；沙箱限制（FS/网络/require 被挡）；超时（超时上限触发 `GATE_TIMEOUT`）；契约校验（返回值不合规 → `GATE_CONTRACT_INVALID`）；`committer` 门禁（校验不过 → `GATE_REJECTED`，不写盘，attempt 失败）；`validate_artifact` 工具只读。
- 铁律：`gate-runner.ts` 与 `action-committer.ts` 均不含 blueprint 业务词（业务词只在 `gates/validate-blueprint.js`，属模板）。

---

## 5. 功能 3：回合内上下文压缩

### 5.1 策略

开启 Pi 自带 compaction（**先试自带，够用就用，不够再单独立项做手动选择性移除**）。

- compaction 压的是上下文里**早期的工具结果消息**（早期 `read_skill_section` 的 reference 内容、已读过的 workspace 文件回执）。
- workspace 文件本身在磁盘不丢，模型后面需要可 `read_workspace` 重读 —— 七轮设计本就「前几轮冻结、不再回看」，压掉早期工具结果与预期一致。

### 5.2 落点（`pi-agent-runtime.ts`）

- `compaction: { enabled: false }` → `compaction: { enabled: true }`（约 547 行）。
- `session.setAutoCompactionEnabled(false)` → `session.setAutoCompactionEnabled(true)`（约 583 行）。
- **调研**（实施时）：`setAutoCompactionEnabled(true)` 后 Pi 的压缩阈值与保留策略；若 Pi 支持配置保留优先级（保留系统提示、当前 skill 主入口、当前轮 reference），按需配置；若不支持细粒度，用默认策略先跑验证。

### 5.3 验收

- 开 compaction 后现有模板（`long-form-hub`）e2e 仍绿（无副作用：compaction 不破坏正常多轮）。
- outline-designer 跑七轮不爆上下文（长故事也能完成）。

---

## 6. outline-designer 模板规格

### 6.1 目录结构

```
templates/outline-designer/
  template.yaml
  pipeline.yaml
  agents/outline-designer.yaml
  prompts/outline-designer-system.md
  skills/outline-designer/
    SKILL.md                       # 主入口：全局流程 + 七轮概要 + "做第N轮读 references/0N"
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
    validate-blueprint.js
```

### 6.2 `template.yaml`

```yaml
name: 大纲复刻生产
description: 单 Agent 依据对标故事，按七轮工作流复刻出 imitation-blueprint 执行大纲。
inputFields:
  - id: source_story
    label: 对标故事原文
    kind: textarea
    required: true
    description: 需要复刻的对标故事全文（含冷开场与所有编号章节）。
finalArtifact:
  name: imitation_blueprint
  format: markdown
```

### 6.3 `pipeline.yaml`

```yaml
agents:
  - outline-designer
routes: []
finalOutput:
  submitters:
    - outline-designer
```

单 Agent，无 routes，自己 produce 自己 submit。

### 6.4 `agents/outline-designer.yaml`

```yaml
id: outline-designer
name: 大纲复刻 Agent
description: 依据对标故事，按七轮工作流在私有工作区产出中间分析，组装并自检后提交 imitation-blueprint。
model: deepseek/deepseek-v4-pro
systemPromptFile: prompts/outline-designer-system.md
skills:
  - id: outline-designer
    name: 大纲复刻七轮工作流
    description: 来源边界->事实冲突->故事变化->人物压力->声音节拍->大纲组装->独立自检->定点返修。
    contentPath: skills/outline-designer/SKILL.md
    sectionsPath: skills/outline-designer/references
gate:
  validator: gates/validate-blueprint.js
  artifactType: imitation_blueprint
  mode: [self_check, commit]
turnContract:
  version: 1
  production:
    completionAction: finish_production
    output:
      formats: [markdown]
      sources: [workspace_file]
  dispatch:
    cardinality: single
    allowedActions: [submit_final_artifact]
    targets: {}
    productionPackageRef: current
```

### 6.5 skill 内容

- **`SKILL.md`（主入口）**：全局流程 + 七轮概要（每轮一句话目标 + 产出文件名 + "详细指示读 `references/0N-xxx.md`"）+ 冻结规则 + 自检返修逻辑索引。不内联 references 全文。
- **`references/01-08`**：从盐选 `zhihu-salt-outline-designer/references/01-08` 原样搬（内容已定稿，见 `C:\Users\13863\Desktop\zhihu\盐选快叙Skill迭代\skills\zhihu-salt-outline-designer\references\`，需 scp 到远端或由实施 agent 重新生成）。8 份分别是：来源与边界 / 事实与冲突 / 故事变化 / 人物与压力 / 声音与节拍 / 执行大纲组装 / 独立自检 / 定点返修。

### 6.6 `gates/validate-blueprint.js`

见 §4.6，从原 `validate_extracted_outline.py` 平迁。

### 6.7 `prompts/outline-designer-system.md`（系统提示词编排）

模型在单 Turn 内按序执行：

1. `load_skill(outline-designer)` 拿主流程。
2. 轮1：`read_skill_section(outline-designer, references/01-source-boundaries.md)` → `write_workspace(01-source-boundaries.md, ...)`；若 `BLOCKED` → `request_human_input`（输入不完整）。
3. 轮2-5：依次 `read_skill_section` references/02..05 → `write_workspace(0N-*.md)`。
4. 轮6：`read_skill_section` references/06 → `write_workspace(imitation-blueprint.md, ...)`（组装，不新增分析）。
5. 轮7：`read_skill_section` references/07 → `write_workspace(07-outline-audit.json, ...)`（自检 JSON）。
6. 读 `07-outline-audit.json` 的 `verdict`；若 `reject`，按 `earliest_stage` `read_skill_section` references/08 → 定点返修对应轮 workspace 文件 + 重跑组装（06）+ 重跑自检（07），直到 `pass`。
7. 提交前 `validate_artifact(source=workspace_file, workspaceFile=imitation-blueprint.md, artifactType=imitation_blueprint)` 跑结构门禁，不过按 `issues` 修。
8. `finish_production(source=workspace_file, workspaceFile=imitation-blueprint.md, format=markdown, artifactType=imitation_blueprint, title=...)` → `submit_final_artifact`。

### 6.8 workspace 中间产物

`tasks/<id>/workspaces/outline-designer/` 下 7 个文件：`01-source-boundaries.md`、`02-facts-and-conflicts.md`、`03-story-change-map.md`、`04-character-pressure-map.md`、`05-narrative-fingerprint.md`、`imitation-blueprint.md`、`07-outline-audit.json`。**只 `imitation-blueprint.md` 经 `finish_production(workspace_file)` 提交进版本目录**，其余留 scratch。单文件 64KB / 单 Agent 32 文件限制满足（blueprint 8-12k 汉字 ≈ 24-36KB，7 文件 < 32）。

---

## 7. 铁律继承

- **平台零业务词**：门禁校验器属模板（`gate-runner.ts` 只执行，不含 blueprint 等业务词；业务词只在 `gates/validate-blueprint.js`）；skill references 属模板。`skill-service` / `gate-runner` / `action-committer` / `pi-tool-factory` 模块零业务词。
- **无 shell**：门禁是受控 JS isolate（无 FS / 网络 / require），不是开 shell。
- **事件只追加**：新工具（`read_skill_section` / `validate_artifact`）只读，不产事件；门禁不改事件联合；`GATE_REJECTED` 是 commit 失败（不写产物事件，只走既有 attempt 失败路径）。
- **模型不碰工程数据**：新工具只返回内容 / 判定 `{pass, issues}`，不返回路径 / 版本 / 时间戳。
- **单一执行槽**：不变。
- **凭据 / 隐藏思维链不上屏不持久化**：不变。

---

## 8. 非范围（重申）

- 不改 9 动作注册表（`forge-actions.ts` 动作联合不变；新工具是只读工具，非动作）。
- 不改产物版本目录存储 / live update / 事件联合。
- 不做手动选择性压缩（功能 3 先用自带 compaction；若验证不够，单独立项）。
- 不改 `turnContract` 版本（沿用 version 1）。
