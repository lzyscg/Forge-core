# HANDOFF — 平台补强 + outline-designer 模板

> 分支：`feat/outline-designer-platform`（本仓库根）
> 最后提交：见下方「Git 状态」。
> 本文档按 dev-plan 记录每个 Phase 的改动、测试、偏差与卡点，以及 Phase 5 真实模型验证结果。

---

## 概览

按 `docs/2026-08-07-platform-enhancements-dev-plan.md` 完成 5 个 Phase：

1. **skill 渐进式披露**：skill 从单文件扩展为「主入口 + sections 子目录」，新增只读工具 `read_skill_section`。
2. **门禁执行环境**：模板可声明 JS 校验器，平台在 isolated-vm 沙箱执行；模型可 `validate_artifact` 自检，提交时 `action-committer` 兜底门禁。
3. **回合内上下文压缩**：开启 Pi 自带 compaction。
4. **outline-designer 模板**：落地七轮单回合工作流（v2-native 双 Agent 拓扑）。
5. **集成验证**：真实 DeepSeek 跑短对标故事，七轮闭环 + 结构门禁 + 最终提交 + 上下文不爆，全部通过。

全部验收门禁（每 Phase `npm run check && npx vitest run <相关> && npm run build`）全绿；最终全量 `npx vitest run` = 1231 tests / 72 files 全绿。

---

## Phase 1 — skill 渐进式披露

**改动文件**
- `src/server/template/template-schema.ts`：新增 `FrozenSkill`（`sectionsPath: string | null`、`sections: string[]`）；`FrozenAgentConfig.skills: FrozenSkill[]`。
- `src/server/template/template-validator.ts`：`ValidatedAgentSkill.sectionsPath` 解析。
- `src/server/template/template-loader.ts`：`collectSkillSections` 收集 `sectionsPath` 下 `.md`（跳过隐藏/符号链接/非 .md，深度 8，`readContainedFile` 双重 containment）；canonical 仅当 sections 非空才加 `sections` 键（空省略，既有 versionHash 字节不变）；frozen 映射落 `sectionsPath/sections`。
- `src/server/runtime/skill-service.ts`：`SKILL_SECTION_NOT_AUTHORIZED/MISSING/PATH_UNSAFE` 三码；抽 `readSnapshotPath` 复用 containment；新增只读 `readSection`（不写事件）。
- `src/server/runtime/pi-tool-factory.ts`：`createSkillSectionToolDefinitions` 新增只读 `read_skill_section`，不进 ActionBuffer/phase gate。
- `src/server/runtime/pi-agent-runtime.ts` + `core-service.ts`：`setSkillSectionReader` 结构型接线。

**测试**：template-loader / skill-service / pi-tool-factory / pi-agent-runtime（150 相关 + 全量）。

**偏差**：无。**向后兼容独立核实**：还原原始 loader 对 `withContracts('valid')` 计算基线哈希 `5dee5a79…`，当前 loader 产出相同哈希（字节不变）。

---

## Phase 2 — 门禁执行环境

**前置**：`npm install isolated-vm@6.2.0`（macOS arm64 编译通过，探针验证隔离/超时/契约）。

**改动文件**
- `src/server/runtime/gate-runner.ts`（新）：isolated-vm 沙箱编译执行模板 CommonJS 校验器（JSON 内联调用 + `copy:true` 取回对象；CPU 5s / 内存 64MB；无 FS/网络/require）；按 `taskId:agentId:contentHash` 缓存隔离区，超时驱逐；契约校验；错误码 `GATE_COMPILE_FAILED/TIMEOUT/RUNTIME_ERROR/CONTRACT_INVALID`。模块零业务词。
- `src/server/template/*`：`FrozenAgentConfig.gate: FrozenGate | null` 解析 + 加载 validator 入 canonical（gate 为 null 省略键，既有 versionHash 字节不变）。
- `src/server/runtime/action-committer.ts`：`GATE_REJECTED`/`GATE_RUNTIME_ERROR`；`assertGateAllowed` 在 validateActionSet 内（任何写之前）跑门禁，不过不写任何事件（fail-closed）。
- `src/server/runtime/pi-tool-factory.ts`：只读 `validate_artifact` 工具（仅 gate 含 self_check 且已接线 runner 时注册）。
- `src/server/runtime/pi-agent-runtime.ts` + `core-service.ts`：`setGateRunner` 接线；core-service 构造 GateRunner 注入 committer 与 runtime。

**测试**：gate-runner（20，含沙箱限制/超时/契约/编译错/缓存）、action-committer（+8 门禁）、pi-tool-factory（+13）、pi-agent-runtime（+4）、template-loader（+6）。

**偏差**：
- spec §4.5 假设 `submit_final_artifact` 可携带 sealedPackage（`source !== 'current_input_artifact'`）；本仓 v2-only 下 submit 只提交接收到的输入版本。故 publish 校验封存包内容、submit 校验接收版本内容（兜底）。偏差已写入 action-committer 模块头注释。

---

## Phase 3 — 回合内上下文压缩

**改动文件**
- `src/server/runtime/pi-agent-runtime.ts`：`compaction: { enabled: true }`；`setAutoCompactionEnabled(true)`。

**调研**：Pi 0.82 默认 `reserveTokens: 16384 / keepRecentTokens: 20000`；上下文超 `contextWindow - reserveTokens` 时对早期消息生成摘要、保留最近 ~20k tokens；系统提示经 resourceLoader 提供（不在 session 历史）天然保留；Forge 每 Turn 重建 fresh session，压缩为**回合内**行为，不跨 Turn、不改事件记录。

**测试**：pi-agent-runtime（61）。

**偏差/备注**：真实模型压缩回归留到 Phase 5（compaction 只在超长单 Turn 触发，正常多轮不受影响）——Phase 5 实测无 overflow。

---

## Phase 4 — outline-designer 模板

**改动文件**
- `templates/outline-designer/`（新）：`template.yaml`、`pipeline.yaml`、`agents/{outline-designer,submitter}.yaml`、`prompts/{outline-designer-system,submitter-system}.md`、`skills/outline-designer/{SKILL.md, references/01-08}`、`gates/validate-blueprint.js`。
- `src/server/template/template-cache.ts`：`copyTemplateFiles` 从硬编码 `agents/skills/prompts` 改为**通用复制全部顶层条目**（跳 dotfiles），否则 `gates/` 目录不进缓存/snapshot → gate.validator 运行时缺失（评审 H 级缺陷，已修）。
- `src/server/runtime/skill-service.ts`：`readSection` 支持**尾缀匹配**（`references/0N-…` 短路径 → 全路径；仍约束在 frozen sections 列表）（评审 H1 阻断缺陷，已修）。
- `src/server/runtime/action-committer.ts`：门禁 content 为 null 时 fail-closed `GATE_RUNTIME_ERROR`（评审 L4）。
- `gates/validate-blueprint.js`：评审 M1/M2/M3/L3 修复（冷开场「无：原因」前缀、P0 定位行兼容 `Bxxx-P0-n` 命名、章节卡放宽 1-3 位数字 + 全/半角竖线、非数字卡片报结构错、P0 行首锚定）。
- `src/server/template/outline-designer-template.acceptance.test.ts`（新）+ `gate-runner.test.ts` 追加真实 validator 对抗用例 + `skill-service.test.ts` 后缀匹配测试。

**v2 适配偏差（关键，已记录于 pipeline.yaml 注释）**：
spec §6 假设「单 Agent + routes:[] + turnContract version 1 + productionPackageRef: current + 自己 produce 自己 submit」。本平台 **v2-only**：`submit_final_artifact` 只能零拷贝提交「当前输入节点携带的版本」，`publish_artifact` 只能沿 artifact 边扇出到其他 Agent，生产版本永远不会变成自己下一轮的输入——「自己 produce 自己 submit」在 v2 下结构上不可能。因此拆为两个 Agent 的 v2-native 拓扑：
- `outline-designer`（production）：单回合内跑七轮，`finish_production(workspace_file)` → `publish_artifact` 到 submitter；gate `[self_check, commit]`（publish 点校验 blueprint 结构）。
- `submitter`（coordinate/dispatch-only）：收到 blueprint → `submit_final_artifact` 完成。

**测试**：outline-designer acceptance（拓扑/sections(8)/gate/v2 契约/hash 稳定/prompt sectionPath 一致性）、gate-runner 真实 validator（pass + structure 拒绝 + M1/M2/M3 对抗）、skill-service 后缀匹配。

**其他偏差/决策**：
- 8 份 references 从 `/tmp/outline-designer-references/` 原样复制，未重新生成。2 份 JSON schema（chapter-constraints / lifecycle）是盐选中间产物格式契约，本模板的中间产物是工作区 markdown，模型无需读 JSON schema，故未纳入；`validate-blueprint.js` 不依赖它们（沙箱无 FS，校验器自包含）。
- 提交的模板用 `configured/*` 模型占位（与 long-form-hub 一致），真实运行由 smoke 脚本替换为 `deepseek/deepseek-v4-pro`。
- 产物文件命名对齐为 `imitation-blueprint.md`（模型自然命名），route inject 与 artifactSchema 同步（Phase 5 实测发现 submitter 输入 inject 落空，已修）。

---

## Phase 5 — 集成验证（真实 DeepSeek）

**方法**：`scripts/smoke-outline-designer.ts`（仿 smoke-long-form-hub）：复制模板到临时 data-root、替换 `configured/*` → `deepseek/deepseek-v4-pro`（outline-designer）与 `deepseek/deepseek-v4-flash`（submitter）、spawn 真实 server、创建任务、驱动调度直至完成、读 turn trace / 产物 / server 日志。

**输入**：自写短对标故事《夜半的敲门声》（冷开场 + 2 个编号章节，约 337 汉字，含人物/因果/反转/对白）。

**结果（两次运行均 PASS）**：
- `task.status = completed`（`final_submission_accepted`）。
- **七轮闭环确认**：outline-designer 回合 22 次工具调用，序列 = `load_skill → 7×(read_skill_section + write_workspace)`（轮1-7）→ `validate_artifact`（自检门禁）→ 返修（再 `read_skill_section`+`write_workspace`+`validate_artifact`+`write_workspace`）→ `finish_production(workspace_file)` → `publish_artifact`。submitter 回合 = `submit_final_artifact`。渐进式披露生效（7 次 read_skill_section，非一次性注入）。
- **blueprint 结构门禁**：13 个固定 h2 齐全、每章（00/01/02）7 个 h3 齐全、P0 全部带 `[FACT/OBS @Lx-Ly]` 标签、`## 分章执行卡` 字面标记保留；publish 点 commit 门禁与 submit 点均未触发 `GATE_REJECTED`。
- **上下文不爆**：server 日志无 context overflow；compaction 生效（无溢出错误）。
- **自检闭环**：round 7 自检 `verdict: pass`（无需返修）；模型仍在提交前跑了 `validate_artifact` 并做了一次再校验（体现自检→门禁双保险）。

**卡点/备注**：无阻断卡点。一次真实运行约 9-10 分钟（outline-designer 回合为主）。产物对齐 `imitation-blueprint.md` 的 inject 修复后二次运行确认通过。

---

## Git 状态

- 分支：`feat/outline-designer-platform`。
- 提交（由新到旧）：`a2c88eb` Phase 4 · `8f3078b` Phase 3 · `932a580` Phase 2 · `8995e88` Phase 1。
- 未提交：Phase 4 收尾的命名对齐（pipeline.yaml / prompt / acceptance test）；一次性验证脚本 `scripts/smoke-outline-designer.ts`（与 `smoke-long-form-hub.ts` 同属非提交物，如需要可提交）。
- 未推送（推送时机由用户定）。
- 工作区既有环境文件（vite.config.ts 改动、.dev-data/、.dev-templates/、docs/、smoke-long-form-hub.ts、vite.config.ts.bak）非本任务产物，保持未动。

## 平台铁律回归

- 平台模块（gate-runner / action-committer / skill-service / pi-tool-factory / pi-agent-runtime / template-* / core-service）业务词 grep（blueprint/大纲/章节/知乎）零命中。
- 新工具（read_skill_section / validate_artifact）只读，不产事件，不进 ActionBuffer。
- 9 动作注册表、事件联合、产物版本目录存储、live update 未改。
- 既有模板（long-form-hub / zhihu-single-chapter）versionHash 字节不变（独立核实）。
